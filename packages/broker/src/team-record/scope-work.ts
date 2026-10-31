// Work on rows that must follow a change at their source (design 4.4.3 and 4.4.2): hide rows at once when the source deletes them, and keep the permission
// snapshot of a private scope current when people join or leave it or the scope turns private or public. Each piece of work is idempotent and bounded
// (items and milliseconds). When it cannot finish in one call it leaves a queue item with `hidePending`, and every read hides that scope's restricted rows from
// everyone until the delete worker (D1) finishes it: a removed member never keeps access because a job ran out of time.
import { randomUUID } from "node:crypto";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  ACL_PRINCIPALS_MAX,
  AudienceSchema,
  OrgIdSchema,
  recordDeletedMarkerKey,
  recordFactKey,
  type Audience,
  type OrgId,
} from "@agentx/contracts";
import { Aliases, errorName, type Item } from "../agents/table-writes.js";
import { bySource, putScopeWork, scopePage, tombstoneItem, type ScopeCursor, type ScopeWork } from "./store.js";
import { clearSupersedes } from "./item-head.js";
import type { TeamRecordTable, TombstoneCause } from "./types.js";

export interface WorkBudget {
  /** The most index items one call reads. */
  maxItems: number;
  /** The most milliseconds one call spends before it stops and leaves the rest pending. */
  maxMs: number;
}
export const DEFAULT_WORK_BUDGET: WorkBudget = { maxItems: 5_000, maxMs: 8_000 };
/** The most source items one tombstone request names (a tap slices to this). */
export const SOURCE_IDS_MAX = 500;
/** How long a "deleted at the source" marker stops a late retry of the item's create. */
export const DELETED_MARKER_DAYS = 14;
const ITEMS_PER_SOURCE_MAX = 2_000;
const AUDIENCE_RETRIES = 3;

export interface WorkDependencies {
  table: TeamRecordTable;
  now?: () => number;
}

export interface WorkResult {
  /** Rows (and facts) changed by this call. */
  changed: number;
  complete: boolean;
  /** A place that was walked only in part: where to resume (the hiding of an already hidden row is not repeated). */
  cursor?: ScopeCursor;
}

/** The project of a record partition key: `WS#<org>#P#<project>`; the project-less partition has none. */
export function projectOfPk(pk: string): string | undefined {
  const project = /^WS#org_[0-9a-z]{20}#P#(.+)$/.exec(pk)?.[1];
  return project === undefined || project === "_workspace" ? undefined : project;
}

function clock(dependencies: WorkDependencies): { now: () => number; at: () => string; deadline: (budget: WorkBudget) => () => boolean } {
  const now = dependencies.now ?? Date.now;
  return { now, at: () => new Date(now()).toISOString(), deadline: (budget) => { const stop = now() + budget.maxMs; return () => now() >= stop; } };
}

// ---- tombstones

/**
 * Hides the rows of source items (by `sourceIds`) or of a whole scope at once, and the facts distilled from them. Hidden means `tombstone` set and the text removed;
 * the delete worker then removes the rows, vectors, lake rows and facts. A source item's marker stops a late retry of its create from bringing it back.
 */
export async function tombstoneRows(dependencies: WorkDependencies, orgId: OrgId, request: { system: string; scope?: string; sourceIds?: readonly string[]; cause: TombstoneCause }, budget: WorkBudget = DEFAULT_WORK_BUDGET, resume?: ScopeCursor): Promise<WorkResult> {
  const { at, deadline, now } = clock(dependencies);
  const expired = deadline(budget);
  const when = at();
  const tombstone = { at: when, cause: request.cause };
  let changed = 0;
  let complete = true;

  const hideItems = async (items: readonly Item[]): Promise<void> => {
    for (const item of items) {
      if (typeof item.pk !== "string" || typeof item.sk !== "string") continue;
      const key = { pk: item.pk, sk: item.sk };
      if (item.entityType === "TEAM_RECORD_EVENT") {
        if (await tombstoneItem(dependencies.table, key, tombstone)) changed += 1;
      } else if (item.entityType === "TEAM_RECORD_DERIVATION") {
        await tombstoneItem(dependencies.table, key, tombstone);
        if (typeof item.factId === "string") {
          if (await tombstoneItem(dependencies.table, recordFactKey(orgId, projectOfPk(item.pk), item.factId), tombstone)) changed += 1;
        }
      }
    }
  };

  // The deleted-at-source markers first: they are cheap and bounded, and they stop a late retry of a create. Whatever the budget does next, the items are named in
  // the queue (the caller writes it), and reads hide every item it names until the work is done.
  const named = (request.sourceIds ?? []).slice(0, SOURCE_IDS_MAX);
  for (const sourceId of named) {
    await dependencies.table.documentClient.send(new PutCommand({
      TableName: dependencies.table.tableName,
      Item: { ...recordDeletedMarkerKey(orgId, request.system, sourceId), entityType: "TEAM_RECORD_DELETED", at: when, indexExpiresAt: Math.floor(now() / 1000) + DELETED_MARKER_DAYS * 86_400 },
    }));
  }
  for (const sourceId of named) {
    if (expired()) { complete = false; break; }
    const found = await bySource(dependencies.table, orgId, request.system, sourceId, ITEMS_PER_SOURCE_MAX);
    await hideItems(found.items);
    if (found.truncated) complete = false;
  }
  if ((request.sourceIds?.length ?? 0) > SOURCE_IDS_MAX) complete = false;

  let cursor: ScopeCursor | undefined = resume;
  if (request.scope !== undefined && !expired()) {
    // The place and every place under it, a budget's worth at a time. The cursor says where to go on, so a busy place is walked to its end over several runs.
    const page = await scopePage(dependencies.table, orgId, request.scope, budget.maxItems, { ...(resume === undefined ? {} : { cursor: resume }) });
    await hideItems(page.items);
    cursor = page.cursor;
    if (page.cursor !== undefined) complete = false;
  } else if (request.scope !== undefined) complete = false;
  return { changed, complete, ...(complete || cursor === undefined ? {} : { cursor }) };
}

/** Whether a source item was deleted at its source recently (the create of a late retry is refused). */
export async function wasDeletedAtSource(table: TeamRecordTable, orgId: OrgId, system: string, sourceId: string): Promise<boolean> {
  const response = await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: recordDeletedMarkerKey(orgId, system, sourceId), ConsistentRead: true })) as { Item?: Item };
  return response.Item !== undefined;
}

// ---- permission snapshot changes

/** True when the row's snapshot was captured AFTER `at` (compared as times; an unreadable time is never "after"). */
function capturedAfter(audience: Audience, at: string): boolean {
  if (audience.kind !== "restricted") return false;
  const captured = Date.parse(audience.acl.capturedAt);
  const limit = Date.parse(at);
  return Number.isFinite(captured) && Number.isFinite(limit) && captured > limit;
}

/** Whether `next` lets in someone `current` does not (a principal, a group, or everyone). */
function widens(current: Audience, next: Audience): boolean {
  if (current.kind !== "restricted") return false;
  if (next.kind !== "restricted") return true;
  const known = new Set(current.acl.principals ?? []);
  const groups = new Set(current.acl.groups ?? []);
  return (next.acl.principals ?? []).some((id) => !known.has(id)) || (next.acl.groups ?? []).some((group) => !groups.has(group));
}

const principalsOf = (audience: Audience): string[] => (audience.kind === "restricted" ? [...(audience.acl.principals ?? [])] : []);

/** Rewrites one item's `audience`, only if it still holds the value read (a concurrent change makes it read again, up to three times). */
async function rewriteAudience(table: TeamRecordTable, key: { pk: string; sk: string }, read: Audience, mutate: (current: Audience) => Audience | undefined): Promise<boolean> {
  let current = read;
  for (let attempt = 0; attempt < AUDIENCE_RETRIES; attempt += 1) {
    const next = mutate(current);
    if (next === undefined) return false;
    const aliases = new Aliases();
    try {
      await table.documentClient.send(new UpdateCommand({
        TableName: table.tableName,
        Key: key,
        UpdateExpression: `SET ${aliases.name("audience")} = ${aliases.value(next)}`,
        ConditionExpression: `${aliases.name("audience")} = ${aliases.value(current)}`,
        ExpressionAttributeNames: aliases.names,
        ExpressionAttributeValues: aliases.values,
      }));
      return true;
    } catch (error) {
      if (errorName(error) !== "ConditionalCheckFailedException") throw error;
      const response = await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: key, ConsistentRead: true })) as { Item?: Item };
      const parsed = AudienceSchema.safeParse(response.Item?.audience);
      if (!parsed.success) return false;
      current = parsed.data;
    }
  }
  return false;
}

async function eachInScope(dependencies: WorkDependencies, orgId: OrgId, scope: string, budget: WorkBudget, visit: (item: Item, key: { pk: string; sk: string }) => Promise<boolean>, resume?: ScopeCursor): Promise<WorkResult> {
  const expired = clock(dependencies).deadline(budget);
  // An audience or a member list belongs to ONE place: not the places under it. A place bigger than the budget is walked a page-run at a time from a cursor; the changes
  // are idempotent, so a page that is repeated (the clock ran out in the middle of it) does no harm.
  const page = await scopePage(dependencies.table, orgId, scope, budget.maxItems, { exact: true, ...(resume === undefined ? {} : { cursor: resume }) });
  let changed = 0;
  let complete = page.cursor === undefined;
  let cursor = page.cursor;
  for (const item of page.items) {
    if (expired()) { complete = false; cursor = resume; break; }
    if (typeof item.pk !== "string" || typeof item.sk !== "string" || item.tombstone !== undefined) continue;
    if (await visit(item, { pk: item.pk, sk: item.sk })) changed += 1;
  }
  return { changed, complete, ...(complete || cursor === undefined ? {} : { cursor }) };
}

/** The audience of the fact a derivation link names, when it is the same scope's own snapshot (so a fact built from several scopes is never rewritten by one of them). */
async function factOf(table: TeamRecordTable, orgId: OrgId, link: Item): Promise<{ key: { pk: string; sk: string }; audience: Audience } | undefined> {
  if (typeof link.factId !== "string" || typeof link.pk !== "string") return undefined;
  const key = recordFactKey(orgId, projectOfPk(link.pk), link.factId);
  const response = await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: key, ConsistentRead: true })) as { Item?: Item };
  if (response.Item === undefined || response.Item.tombstone !== undefined) return undefined;
  const audience = AudienceSchema.safeParse(response.Item.audience);
  return audience.success ? { key, audience: audience.data } : undefined;
}

/**
 * People joined or left a private scope: the principals of every restricted row of the scope (and of the facts distilled from it) change. Idempotent: adding
 * a present principal or removing an absent one changes nothing. More than 500 principals after the change keeps the first 500 (fewer people see the rows).
 */
export async function changeScopePrincipals(dependencies: WorkDependencies, orgId: OrgId, input: { scope: string; add?: readonly string[]; remove?: readonly string[]; at: string }, budget: WorkBudget = DEFAULT_WORK_BUDGET, resume?: ScopeCursor): Promise<WorkResult> {
  const add = input.add ?? [];
  const remove = new Set(input.remove ?? []);
  const mutate = (current: Audience): Audience | undefined => {
    if (current.kind !== "restricted" || current.acl.scope !== input.scope) return undefined;
    const before = principalsOf(current);
    // A row captured after this change keeps what it was granted (a replay of an older change adds nobody), but a person who left is taken out of it either way: the
    // access record decides who may read, and this rewrite only keeps the pre-filter in line.
    const grants = capturedAfter(current, input.at) ? [] : add;
    const after = [...new Set([...before, ...grants])].filter((id) => !remove.has(id)).slice(0, ACL_PRINCIPALS_MAX);
    if (after.length === before.length && after.every((id, index) => id === before[index])) return undefined;
    return { kind: "restricted", acl: { ...current.acl, principals: after, capturedAt: input.at } };
  };
  return eachInScope(dependencies, orgId, input.scope, budget, async (item, key) => {
    if (item.entityType === "TEAM_RECORD_EVENT") {
      const audience = AudienceSchema.safeParse(item.audience);
      return audience.success ? rewriteAudience(dependencies.table, key, audience.data, mutate) : false;
    }
    if (item.entityType === "TEAM_RECORD_DERIVATION") {
      const fact = await factOf(dependencies.table, orgId, item);
      return fact === undefined ? false : rewriteAudience(dependencies.table, fact.key, fact.audience, mutate);
    }
    return false;
  }, resume);
}

/**
 * A scope turned private or public: every row of it takes the new audience. A fact is only ever narrowed (to the new restricted snapshot, when it was this scope's own
 * or project-wide); it is never widened here, because it may rest on other sources.
 */
export async function replaceScopeAudience(dependencies: WorkDependencies, orgId: OrgId, input: { scope: string; audience: Audience; at: string }, budget: WorkBudget = DEFAULT_WORK_BUDGET, resume?: ScopeCursor): Promise<WorkResult> {
  const next = AudienceSchema.parse(input.audience);
  const sameScope = (current: Audience): boolean => current.kind === "restricted" && current.acl.scope === input.scope;
  // A row captured after the event is rewritten only when that takes access away (a replay of an older, wider list must not grant again).
  const stale = (current: Audience): boolean => capturedAfter(current, input.at) && widens(current, next);
  return eachInScope(dependencies, orgId, input.scope, budget, async (item, key) => {
    if (item.entityType === "TEAM_RECORD_EVENT") {
      const audience = AudienceSchema.safeParse(item.audience);
      if (!audience.success) return false;
      return rewriteAudience(dependencies.table, key, audience.data, (current) => (JSON.stringify(current) === JSON.stringify(next) || stale(current) ? undefined : next));
    }
    if (item.entityType === "TEAM_RECORD_DERIVATION" && next.kind === "restricted") {
      const fact = await factOf(dependencies.table, orgId, item);
      if (fact === undefined) return false;
      return rewriteAudience(dependencies.table, fact.key, fact.audience, (current) => ((current.kind === "project" || sameScope(current)) && !stale(current) ? next : undefined));
    }
    return false;
  }, resume);
}

// ---- queueing

/** Writes the queue item for work that did not finish, so reads hide the scope and the delete worker finishes it. */
export async function queueScopeWork(dependencies: WorkDependencies, orgId: OrgId, work: Omit<ScopeWork, "requestId" | "at" | "queuedAtSeconds" | "hidden"> & { hidden?: number }, notBefore?: string): Promise<ScopeWork> {
  const { now } = clock(dependencies);
  // `notBefore`: the item sorts after the one named (the worker takes items oldest first), even in the same millisecond.
  const floor = notBefore === undefined ? Number.NEGATIVE_INFINITY : Date.parse(notBefore) + 1;
  const at = new Date(Math.max(now(), Number.isFinite(floor) ? floor : Number.NEGATIVE_INFINITY)).toISOString();
  const entry: ScopeWork = { ...work, requestId: randomUUID(), at, queuedAtSeconds: Math.floor(now() / 1000), hidden: work.hidden ?? 0 };
  await putScopeWork(dependencies.table, OrgIdSchema.parse(orgId), entry);
  return entry;
}


/**
 * A newer version of a source item replaced an older one (the ingest contract: text a person edited away is not kept). At once: the older rows are hidden and their text
 * removed, and the notes made from the item before `at` are hidden too (their links and facts are tombstoned). Then a `replaced` queue item makes the delete worker remove the
 * rows, their vectors and those notes for good. Notes made from the NEW version are newer than `at` and are left alone.
 */
export async function supersedeItem(dependencies: WorkDependencies, orgId: OrgId, input: { system: string; sourceId: string; version: string; rows: ReadonlyArray<{ pk: string; sk: string }> }): Promise<void> {
  const { at: nowIso } = clock(dependencies);
  const at = nowIso();
  const tombstone = { at, cause: "source_deleted" };
  for (const row of input.rows) await tombstoneItem(dependencies.table, row, tombstone);
  const found = await bySource(dependencies.table, orgId, input.system, input.sourceId, ITEMS_PER_SOURCE_MAX);
  for (const item of found.items) {
    if (item.entityType !== "TEAM_RECORD_DERIVATION" || typeof item.pk !== "string" || typeof item.sk !== "string" || typeof item.factId !== "string") continue;
    if (typeof item.createdAt === "string" && item.createdAt > at) continue;
    await tombstoneItem(dependencies.table, { pk: item.pk, sk: item.sk }, tombstone);
    await tombstoneItem(dependencies.table, recordFactKey(orgId, projectOfPk(item.pk), item.factId), tombstone);
  }
  await queueScopeWork(dependencies, orgId, { type: "replaced", system: input.system, sourceIds: [input.sourceId], rowKeys: [...input.rows], cause: "source_deleted", hidePending: false });
  await clearSupersedes(dependencies.table, orgId, input.system, input.sourceId, input.version);
}
