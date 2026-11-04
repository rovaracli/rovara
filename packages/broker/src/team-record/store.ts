// The hot store of the Team record: reads and writes of the `TeamRecord` table (design 4.2). Every key comes from the builders in contracts (workspace and project in
// the partition); every row read back is parsed with its strict schema and one that does not parse is dropped, never shown. Writes are idempotent.
import { createHash } from "node:crypto";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  INDEX_EXPIRY_ATTRIBUTE,
  RecordEventSchema,
  RecordFactSchema,
  SourceConfigSchema,
  TEAM_RECORD_GSI1,
  TEAM_RECORD_GSI2,
  TEAM_RECORD_GSI3,
  TEAM_RECORD_GSI4,
  TEAM_RECORD_GSI5,
  RECORD_DELETE_QUEUE_SK_PREFIX,
  RECORD_EVENT_SK_PREFIX,
  RECORD_FACT_SK_PREFIX,
  RECORD_SOURCE_SK_PREFIX,
  recordActorIndexValue,
  recordActorSourceIndexValue,
  recordTextDueIndexValue,
  recordDeleteQueueKey,
  recordDerivationKey,
  recordEventKey,
  recordFactKey,
  recordPlaceIndexValue,
  recordScopeIndexValue,
  recordSourceConfigIndexValue,
  recordSourceIndexValue,
  recordSourceKey,
  teamRecordPk,
  teamRecordSourceHash,
  type OrgId,
  type RecordEvent,
  type RecordFact,
  type RecordSystem,
  type SourceConfig,
} from "@agentx/contracts";
import { Aliases, NOT_EXISTS, errorName, withoutUndefined, type Item } from "../agents/table-writes.js";
import { reopenScope } from "./item-head.js";
import { retentionRefusal } from "./retention.js";
import type { Edition, PendingHides, TeamRecordTable } from "./types.js";

const KEY_ATTRIBUTES = ["pk", "sk", "entityType", TEAM_RECORD_GSI1.partition, TEAM_RECORD_GSI2.partition, TEAM_RECORD_GSI3.partition, TEAM_RECORD_GSI3.sort, TEAM_RECORD_GSI4.partition, TEAM_RECORD_GSI5.partition, TEAM_RECORD_GSI5.sort, "rowScope", "rowScopes", "sourceHash", "archivedAt"] as const;
const dropKeys = (item: Item): Item => Object.fromEntries(Object.entries(item).filter(([name]) => !(KEY_ATTRIBUTES as readonly string[]).includes(name)));

/** A record row as stored. */
export type StoredEvent = RecordEvent;

/**
 * The same item always has the same id: a UUID built from the hash of the source item and its version, so a retried delivery writes the same row.
 * Version bits are set to 5 and the variant to RFC 4122, which is what a UUID parser expects.
 */
export function deterministicEventId(orgId: OrgId, source: string, system: string, sourceId: string, version: string): string {
  const hex = createHash("sha256").update(`${orgId}\n${source}\n${system}\n${sourceId}\n${version}`).digest("hex");
  const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function eventItem(event: RecordEvent): Item {
  const key = recordEventKey(event.workspaceId, event.project, event.occurredAt, event.id);
  return withoutUndefined({
    ...key,
    entityType: "TEAM_RECORD_EVENT",
    ...event,
    sourceHash: teamRecordSourceHash(event.sourceRef.system, event.sourceRef.id),
    [TEAM_RECORD_GSI1.partition]: recordSourceIndexValue(event.workspaceId, event.sourceRef.system, event.sourceRef.id),
    [TEAM_RECORD_GSI2.partition]: event.actor?.developerId === undefined ? undefined : recordActorIndexValue(event.workspaceId, event.actor.developerId),
    [TEAM_RECORD_GSI3.partition]: recordScopeIndexValue(event.workspaceId, event.scope),
    [TEAM_RECORD_GSI3.sort]: event.scope,
    // The source identity is ALWAYS indexed, beside the developer id: an erase that names only "Slack user U7" must reach what that person wrote while mapped to a developer.
    [TEAM_RECORD_GSI4.partition]: event.actor === undefined ? undefined : recordActorSourceIndexValue(event.workspaceId, event.sourceRef.system, event.actor.sourceId),
    // Sparse: only a row that still holds raw text with an expiry is in the text-due index.
    [TEAM_RECORD_GSI5.partition]: event.text !== undefined && event.textExpiresAt !== undefined ? recordTextDueIndexValue(event.workspaceId) : undefined,
    [TEAM_RECORD_GSI5.sort]: event.text !== undefined && event.textExpiresAt !== undefined ? new Date(event.textExpiresAt * 1000).toISOString() : undefined,
    [INDEX_EXPIRY_ATTRIBUTE]: event.indexExpiresAt,
  });
}

/**
 * A stored event, or undefined when it is not one or does not parse (it is then never shown). Text whose expiry has passed is dropped here, so a night the
 * text-expiry job missed (or a vector it could not delete) never shows raw text past its time. `nowSeconds` is the caller's clock.
 */
export function eventFromItem(item: Item | undefined, nowSeconds: number = Math.floor(Date.now() / 1000)): StoredEvent | undefined {
  if (item?.entityType !== "TEAM_RECORD_EVENT") return undefined;
  const parsed = RecordEventSchema.safeParse(dropKeys(item));
  if (!parsed.success) return undefined;
  const { text, textExpiresAt, ...rest } = parsed.data;
  if (text === undefined || textExpiresAt === undefined || textExpiresAt > nowSeconds) return parsed.data;
  void text; void textExpiresAt;
  return rest;
}

export type PutResult = "stored" | "duplicate";

/** Writes a row once. A second write of the same item version is a no-op. */
export async function putRecordEvent(table: TeamRecordTable, event: RecordEvent): Promise<PutResult> {
  const parsed = RecordEventSchema.parse(event);
  try {
    await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: eventItem(parsed), ConditionExpression: NOT_EXISTS }));
    return "stored";
  } catch (error) {
    if (errorName(error) === "ConditionalCheckFailedException") return "duplicate";
    throw error;
  }
}

export async function getRecordEvent(table: TeamRecordTable, orgId: OrgId, project: string | undefined, occurredAt: string, id: string, nowSeconds?: number): Promise<StoredEvent | undefined> {
  const response = await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: recordEventKey(orgId, project, occurredAt, id), ConsistentRead: true })) as { Item?: Item };
  return eventFromItem(response.Item, nowSeconds);
}

export interface PageBudget {
  /** The most items one call reads. */
  maxItems: number;
}

async function queryAll(table: TeamRecordTable, input: Record<string, unknown>, maxItems: number, from?: Record<string, unknown>): Promise<{ items: Item[]; truncated: boolean; lastKey?: Record<string, unknown> }> {
  const items: Item[] = [];
  let startKey: Record<string, unknown> | undefined = from;
  for (;;) {
    const remaining = maxItems - items.length;
    if (remaining <= 0) return { items, truncated: true, ...(startKey === undefined ? {} : { lastKey: startKey }) };
    const response = await table.documentClient.send(new QueryCommand({ TableName: table.tableName, ...input, Limit: Math.min(remaining, 500), ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }) })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    items.push(...(response.Items ?? []));
    startKey = response.LastEvaluatedKey;
    if (startKey === undefined) return { items, truncated: false };
  }
}

/** A project's rows between two instants, newest first, up to `limit`. Rows that do not parse are left out. */
export async function queryRecordEvents(table: TeamRecordTable, orgId: OrgId, project: string | undefined, options: { since?: string; until?: string; limit: number; nowSeconds?: number }): Promise<StoredEvent[]> {
  const lower = `${RECORD_EVENT_SK_PREFIX}${options.since === undefined ? "" : new Date(options.since).toISOString()}`;
  const upper = `${RECORD_EVENT_SK_PREFIX}${options.until === undefined ? "" : new Date(options.until).toISOString()}\uffff`;
  const response = await table.documentClient.send(new QueryCommand({
    TableName: table.tableName,
    KeyConditionExpression: "pk = :pk AND sk BETWEEN :low AND :high",
    ExpressionAttributeValues: { ":pk": teamRecordPk(orgId, project), ":low": lower, ":high": upper },
    ScanIndexForward: false,
    Limit: Math.min(options.limit, 500),
  })) as { Items?: Item[] };
  return (response.Items ?? []).map((item) => eventFromItem(item, options.nowSeconds)).filter((event): event is StoredEvent => event !== undefined);
}

/** Every item (rows, derivation links) on one index value, including tombstoned ones: the delete worker needs them. Bounded by `maxItems`. */
export async function queryIndex(table: TeamRecordTable, index: typeof TEAM_RECORD_GSI1 | typeof TEAM_RECORD_GSI2 | typeof TEAM_RECORD_GSI3 | typeof TEAM_RECORD_GSI4, value: string, maxItems: number): Promise<{ items: Item[]; truncated: boolean }> {
  return queryAll(table, { IndexName: index.index, KeyConditionExpression: `${index.partition} = :v`, ExpressionAttributeValues: { ":v": value } }, maxItems);
}

export const bySource = (table: TeamRecordTable, orgId: OrgId, system: string, sourceId: string, maxItems: number) => queryIndex(table, TEAM_RECORD_GSI1, recordSourceIndexValue(orgId, system, sourceId), maxItems);
export const byActor = (table: TeamRecordTable, orgId: OrgId, developerId: string, maxItems: number) => queryIndex(table, TEAM_RECORD_GSI2, recordActorIndexValue(orgId, developerId), maxItems);
export const byActorSource = (table: TeamRecordTable, orgId: OrgId, system: string, actorSourceId: string, maxItems: number) => queryIndex(table, TEAM_RECORD_GSI4, recordActorSourceIndexValue(orgId, system, actorSourceId), maxItems);
/** Where a paged read of a place stopped: which range it was in (the place itself, then the places below it) and the index's own key. */
export interface ScopeCursor { phase: "own" | "below"; key?: Record<string, unknown> }

/**
 * One page-run over a place and, unless `exact`, every place under it (`slack:T1` -> `slack:T1/C9`): rows and derivation links. Reads up to `maxItems` and, if there is more,
 * returns a cursor to resume from, so a busy place is walked over several calls and never given up on. The sort value is the place itself, so a sibling that only starts the
 * same (`slack:T1/C90` for `slack:T1/C9`) is never matched.
 */
export async function scopePage(table: TeamRecordTable, orgId: OrgId, scope: string, maxItems: number, options: { exact?: boolean; cursor?: ScopeCursor } = {}): Promise<{ items: Item[]; cursor?: ScopeCursor }> {
  const value = recordScopeIndexValue(orgId, scope);
  const items: Item[] = [];
  let phase: ScopeCursor["phase"] = options.cursor?.phase ?? "own";
  let key = options.cursor?.key;
  for (;;) {
    const remaining = maxItems - items.length;
    if (remaining <= 0) return { items, cursor: { phase, ...(key === undefined ? {} : { key }) } };
    const found = phase === "own"
      ? await queryAll(table, { IndexName: TEAM_RECORD_GSI3.index, KeyConditionExpression: `${TEAM_RECORD_GSI3.partition} = :v AND ${TEAM_RECORD_GSI3.sort} BETWEEN :low AND :high`, ExpressionAttributeValues: { ":v": value, ":low": scope, ":high": scope } }, remaining, key)
      : await queryAll(table, { IndexName: TEAM_RECORD_GSI3.index, KeyConditionExpression: `${TEAM_RECORD_GSI3.partition} = :v AND begins_with(${TEAM_RECORD_GSI3.sort}, :prefix)`, ExpressionAttributeValues: { ":v": value, ":prefix": `${scope}/` } }, remaining, key);
    items.push(...found.items);
    if (found.truncated) return { items, cursor: { phase, ...(found.lastKey === undefined ? {} : { key: found.lastKey }) } };
    if (phase === "own" && options.exact !== true) { phase = "below"; key = undefined; continue; }
    return { items };
  }
}

/** A place's items, up to `maxItems`; `truncated` says there is more (use `scopePage` to walk all of it). */
export async function byScope(table: TeamRecordTable, orgId: OrgId, scope: string, maxItems: number, options: { exact?: boolean } = {}): Promise<{ items: Item[]; truncated: boolean }> {
  const page = await scopePage(table, orgId, scope, maxItems, options);
  return { items: page.items, truncated: page.cursor !== undefined };
}

/** Where a paged read of the places under a place stopped. */
export type PlaceCursor = Record<string, unknown>;

/**
 * The places below a place (not itself), from the SOURCE rows only: every stored row's place has one (a row without a source row is refused), so this reads one small row per
 * place and never an item row, and is bounded by the number of places. It returns up to `limit` places and a cursor when there are more: the caller keeps the cursor and
 * continues, it never gives up.
 */
export async function childScopes(table: TeamRecordTable, orgId: OrgId, scope: string, options: { limit: number; cursor?: PlaceCursor }): Promise<{ scopes: string[]; cursor?: PlaceCursor }> {
  const value = recordPlaceIndexValue(orgId, scope);
  const found = await queryAll(table, {
    IndexName: TEAM_RECORD_GSI3.index, KeyConditionExpression: `${TEAM_RECORD_GSI3.partition} = :v AND begins_with(${TEAM_RECORD_GSI3.sort}, :prefix)`, ExpressionAttributeValues: { ":v": value, ":prefix": `${scope}/` },
  }, options.limit, options.cursor);
  const scopes = new Set<string>();
  for (const item of found.items) {
    const place = item[TEAM_RECORD_GSI3.sort];
    if (typeof place === "string") scopes.add(place);
  }
  return { scopes: [...scopes], ...(found.truncated && found.lastKey !== undefined ? { cursor: found.lastKey } : {}) };
}

/** Every item of one sort-key kind in one project partition (`FACT#`, `SOURCE#`, `LESSON#`...). Bounded. */
export async function queryPrefix(table: TeamRecordTable, orgId: OrgId, project: string | undefined, prefix: string, maxItems: number, options: { newestFirst?: boolean } = {}): Promise<{ items: Item[]; truncated: boolean }> {
  return queryAll(table, {
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": teamRecordPk(orgId, project), ":prefix": prefix },
    ScanIndexForward: options.newestFirst !== true,
  }, maxItems);
}

export async function deleteItem(table: TeamRecordTable, key: { pk: string; sk: string }): Promise<void> {
  await table.documentClient.send(new DeleteCommand({ TableName: table.tableName, Key: key }));
}

/** Hides an item at once: sets its tombstone and removes its text. A row already tombstoned keeps its first tombstone. */
export async function tombstoneItem(table: TeamRecordTable, key: { pk: string; sk: string }, tombstone: { at: string; cause: string }): Promise<boolean> {
  const aliases = new Aliases();
  try {
    await table.documentClient.send(new UpdateCommand({
      TableName: table.tableName,
      Key: key,
      UpdateExpression: `SET ${aliases.name("tombstone")} = ${aliases.value(tombstone)} REMOVE ${["text", "textExpiresAt", TEAM_RECORD_GSI5.partition, TEAM_RECORD_GSI5.sort].map((name) => aliases.name(name)).join(", ")}`,
      ConditionExpression: `attribute_exists(${aliases.name("pk")}) AND attribute_not_exists(${aliases.name("tombstone")})`,
      ExpressionAttributeNames: aliases.names,
      ExpressionAttributeValues: aliases.values,
    }));
    return true;
  } catch (error) {
    if (errorName(error) === "ConditionalCheckFailedException") return false;
    throw error;
  }
}

// ---- facts

/** A fact with the places it was distilled from, so a hidden place hides it too. */
export type StoredFact = RecordFact & { scopes?: string[] };

/** `scopes`: the places of the sources the fact was distilled from (the distiller passes them). A fact with none cannot be hidden by place, only by its own tombstone. */
export async function putRecordFact(table: TeamRecordTable, fact: RecordFact, scopes?: readonly string[]): Promise<void> {
  const parsed = RecordFactSchema.parse(fact);
  await table.documentClient.send(new PutCommand({
    TableName: table.tableName,
    Item: withoutUndefined({ ...recordFactKey(parsed.workspaceId, parsed.project, parsed.id), entityType: "TEAM_RECORD_FACT", ...parsed, rowScopes: scopes === undefined ? undefined : [...new Set(scopes)].slice(0, 50) }),
  }));
}

export function factFromItem(item: Item | undefined): StoredFact | undefined {
  if (item?.entityType !== "TEAM_RECORD_FACT") return undefined;
  const parsed = RecordFactSchema.safeParse(dropKeys(item));
  if (!parsed.success) return undefined;
  const scopes = Array.isArray(item.rowScopes) ? item.rowScopes.filter((scope): scope is string => typeof scope === "string") : undefined;
  return scopes === undefined || scopes.length === 0 ? parsed.data : { ...parsed.data, scopes };
}

export async function getRecordFact(table: TeamRecordTable, orgId: OrgId, project: string | undefined, factId: string): Promise<StoredFact | undefined> {
  const response = await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: recordFactKey(orgId, project, factId), ConsistentRead: true })) as { Item?: Item };
  return factFromItem(response.Item);
}

export async function queryRecordFacts(table: TeamRecordTable, orgId: OrgId, project: string | undefined, maxItems: number): Promise<StoredFact[]> {
  const { items } = await queryPrefix(table, orgId, project, RECORD_FACT_SK_PREFIX, maxItems);
  return items.map(factFromItem).filter((fact): fact is StoredFact => fact !== undefined);
}

/**
 * Links a fact to every source item it was distilled from, so a delete at a source that stored no row (retention B) still finds the fact. The distiller calls
 * this when it writes a fact. `scope` is the source's scope, when it has one, so a deleted channel or repository reaches the fact too.
 */
export async function putDerivationLinks(table: TeamRecordTable, input: { orgId: OrgId; project: string | undefined; factId: string; sources: ReadonlyArray<{ system: string; sourceId: string; scope?: string; actor?: { developerId?: string; sourceId?: string } }>; at: string }): Promise<void> {
  for (const source of input.sources) {
    await table.documentClient.send(new PutCommand({
      TableName: table.tableName,
      Item: withoutUndefined({
        ...recordDerivationKey(input.orgId, input.project, source.system, source.sourceId, input.factId),
        entityType: "TEAM_RECORD_DERIVATION",
        factId: input.factId,
        system: source.system,
        scope: source.scope,
        // Who wrote the source item: a person's erase reaches the fact through this, whether or not the item's own row is still in the table (retention B keeps none).
        actorDeveloperId: source.actor?.developerId,
        actorSourceId: source.actor?.sourceId,
        createdAt: input.at,
        [TEAM_RECORD_GSI1.partition]: recordSourceIndexValue(input.orgId, source.system, source.sourceId),
        [TEAM_RECORD_GSI2.partition]: source.actor?.developerId === undefined ? undefined : recordActorIndexValue(input.orgId, source.actor.developerId),
        [TEAM_RECORD_GSI3.partition]: source.scope === undefined ? undefined : recordScopeIndexValue(input.orgId, source.scope),
        [TEAM_RECORD_GSI3.sort]: source.scope,
        [TEAM_RECORD_GSI4.partition]: source.actor?.sourceId === undefined ? undefined : recordActorSourceIndexValue(input.orgId, source.system, source.actor.sourceId),
      }),
    }));
  }
}

// ---- source settings

export function sourceConfigFromItem(item: Item | undefined): SourceConfig | undefined {
  if (item?.entityType !== "TEAM_RECORD_SOURCE") return undefined;
  const parsed = SourceConfigSchema.safeParse(dropKeys(item));
  return parsed.success ? parsed.data : undefined;
}

/** The source row of one scope. One scope belongs to one project: a scope found in two is read as no row (fail closed). */
export async function getSourceConfigByScope(table: TeamRecordTable, orgId: OrgId, source: RecordSystem, scope: string): Promise<SourceConfig | undefined> {
  const { items } = await queryIndex(table, TEAM_RECORD_GSI1, recordSourceConfigIndexValue(orgId, source, scope), 3);
  const configs = items.map(sourceConfigFromItem).filter((config): config is SourceConfig => config !== undefined);
  return configs.length === 1 ? configs[0] : undefined;
}

export type PutSourceResult = { status: "saved" } | { status: "refused"; reason: "scope_in_other_project" | "invalid" | "slack_public_fixed_a_b" | "slack_notes_need_opt_in" };

export async function putSourceConfig(table: TeamRecordTable, config: SourceConfig, options: { edition: Edition }): Promise<PutSourceResult> {
  const parsed = SourceConfigSchema.safeParse(config);
  if (!parsed.success) return { status: "refused", reason: "invalid" };
  // The edition's rules are enforced where the setting is saved, so the Sources tab never shows a retention the ingest would refuse.
  const edition = retentionRefusal(options.edition, parsed.data.source, parsed.data.retention, parsed.data.notesOptIn === true);
  if (edition !== undefined) return { status: "refused", reason: edition };
  const existing = await queryIndex(table, TEAM_RECORD_GSI1, recordSourceConfigIndexValue(parsed.data.workspaceId, parsed.data.source, parsed.data.scope), 3);
  const elsewhere = existing.items.some((item) => sourceConfigFromItem(item)?.project !== parsed.data.project);
  if (elsewhere) return { status: "refused", reason: "scope_in_other_project" };
  // An admin saving a source row for a place opens it again (a repository transferred back, a channel brought back): the closed-place marker goes.
  await reopenScope(table, parsed.data.workspaceId, parsed.data.scope);
  await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: sourceRowItem(parsed.data) }));
  return { status: "saved" };
}

/** A source row as it is stored: its key, its type and its two index values. `putSourceConfig` and the source write route (`source-write.ts`) store exactly this. */
export function sourceRowItem(config: SourceConfig): Item {
  return withoutUndefined({
    ...recordSourceKey(config.workspaceId, config.project, config.source, config.scope),
    entityType: "TEAM_RECORD_SOURCE",
    ...config,
    [TEAM_RECORD_GSI1.partition]: recordSourceConfigIndexValue(config.workspaceId, config.source, config.scope),
    // The place is indexed under its own partition value (the sparse "places" list), so a tombstone of a place above it finds every place with a source row, even one with nothing stored yet, without reading any item row.
    [TEAM_RECORD_GSI3.partition]: recordPlaceIndexValue(config.workspaceId, config.scope),
    [TEAM_RECORD_GSI3.sort]: config.scope,
  });
}

export async function listSourceConfigs(table: TeamRecordTable, orgId: OrgId, project: string, maxItems = 200): Promise<SourceConfig[]> {
  const { items } = await queryPrefix(table, orgId, project, RECORD_SOURCE_SK_PREFIX, maxItems);
  return items.map(sourceConfigFromItem).filter((config): config is SourceConfig => config !== undefined);
}

// ---- the delete queue (scope work)

/** A piece of work on a scope or on source items that must finish: hide, change an ACL, then delete. The delete worker (D1) finishes it. */
export interface ScopeWork {
  requestId: string;
  type: "tombstone" | "principals" | "audience" | "replaced";
  system: string;
  scope?: string;
  sourceIds?: string[];
  /** `replaced`: the rows of the versions a newer version replaced (hidden already); the worker removes them, their vectors and the notes made from them. */
  rowKeys?: Array<{ pk: string; sk: string }>;
  /** A tombstone of a place walks it page by page: where the hiding stopped, and whether it finished (a finished hide is not repeated on every run). */
  hideCursor?: ScopeCursor;
  hideDone?: boolean;
  /** The lake targets of the places below the place are queued page by page: where that stopped (absent: all queued). */
  childCursor?: PlaceCursor;
  /** True from the very first write of a request with a place, until every child place has its lake target queued: a worker purges no row while it is true. */
  childPending?: boolean;
  /** Audience and member changes walk a big place a budget at a time: where the last run stopped (the changes are idempotent, so a repeated page is harmless). */
  walkCursor?: ScopeCursor;
  cause?: "source_deleted" | "person_erased" | "project_archived" | "excluded";
  add?: string[];
  remove?: string[];
  audience?: unknown;
  /** `principals` and `audience`: the time of the change itself (the tap's `at`). A replay never rewrites a row captured after it. */
  changeAt?: string;
  at: string;
  /** While true, every restricted row of the scope is hidden from everyone: the work that makes them safe to show has not finished. */
  hidePending: boolean;
  /** Rows hidden so far (a tombstone), for the log. */
  hidden: number;
  /** When the work was queued as epoch seconds, for the backlog alarm. */
  queuedAtSeconds: number;
}

export async function putScopeWork(table: TeamRecordTable, orgId: OrgId, work: ScopeWork): Promise<void> {
  await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: withoutUndefined({ ...recordDeleteQueueKey(orgId, work.at, work.requestId), entityType: "TEAM_RECORD_SCOPE_WORK", ...work }) }));
}

export function scopeWorkFromItem(item: Item): (ScopeWork & { pk: string; sk: string }) | undefined {
  if (item.entityType !== "TEAM_RECORD_SCOPE_WORK" || typeof item.pk !== "string" || typeof item.sk !== "string" || typeof item.requestId !== "string") return undefined;
  const { pk, sk, entityType: _type, ...rest } = item; // eslint-disable-line @typescript-eslint/no-unused-vars -- dropped on purpose
  return { pk, sk, ...(rest as unknown as ScopeWork) };
}

export async function listScopeWork(table: TeamRecordTable, orgId: OrgId, maxItems: number): Promise<Array<ScopeWork & { pk: string; sk: string }>> {
  const { items } = await queryPrefix(table, orgId, undefined, RECORD_DELETE_QUEUE_SK_PREFIX, maxItems);
  return items.map(scopeWorkFromItem).filter((work): work is ScopeWork & { pk: string; sk: string } => work !== undefined);
}

/** The hard cap on queue items one read pages through; past it the read fails closed (the caller refuses rather than show what might be hidden). */
export const PENDING_HIDES_MAX_ITEMS = 50_000;

export class PendingHidesUnreadable extends Error {
  constructor() {
    super("team-record: the hiding queue is too long to read");
    this.name = "PendingHidesUnreadable";
  }
}

/** Pages through the whole queue. If it is longer than the cap it throws, so nothing is shown on a guess. */
export async function pendingHidesOf(table: TeamRecordTable, orgId: OrgId): Promise<PendingHides> {
  const { items, truncated } = await queryPrefix(table, orgId, undefined, RECORD_DELETE_QUEUE_SK_PREFIX, PENDING_HIDES_MAX_ITEMS);
  if (truncated) throw new PendingHidesUnreadable();
  const scopes = new Set<string>();
  const sourceHashes = new Set<string>();
  for (const work of items.map(scopeWorkFromItem)) {
    if (work === undefined || !work.hidePending) continue;
    if (work.scope !== undefined) scopes.add(work.scope);
    for (const id of work.sourceIds ?? []) sourceHashes.add(teamRecordSourceHash(work.system, id));
  }
  return { scopes, sourceHashes };
}

/** Removes source ids from a source row's exclusion list (a person who was erased: their id is personal data too). Returns whether the row changed. */
/** What replaces an erased developer id in a source setting (`addedBy`, `approval.by`): a developer id is 64 hex characters, so the stand-in is 64 zeros. */
export const ERASED_DEVELOPER_ID = "0".repeat(64);

/** A source setting without the erased developer: `addedBy` and the approver of a less-safe change become the stand-in. True when something changed. */
/**
 * The learning lane's tier-0 setting rows (`LESSONSET#SETTINGS`, `LESSONSET#COMPANY` and the `LESSONSET#TIER0CHG#` proposals of one partition) name the people who wrote or proposed them
 * (`updatedBy`, `proposedBy`). On a person's erasure those become the stand-in id; the values themselves stay. Returns how many rows changed.
 */
export async function scrubTier0Developer(table: TeamRecordTable, orgId: OrgId, project: string | undefined, developerId: string): Promise<number> {
  // Each kind of row by its own key or prefix, read to the end: the project's set snapshots sort ahead of the proposals and can be any number.
  const settings = await Promise.all(["LESSONSET#SETTINGS", "LESSONSET#COMPANY"].map(async (sk) => (await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: { pk: teamRecordPk(orgId, project), sk }, ConsistentRead: true })) as { Item?: Item }).Item));
  const proposals = await queryPrefix(table, orgId, project, "LESSONSET#TIER0CHG#", 100_000);
  if (proposals.truncated) throw new Error("more tier-0 proposals than one erase pass reads");
  let changed = 0;
  for (const item of [...settings, ...proposals.items]) {
    if (item === undefined || typeof item.sk !== "string") continue;
    for (const field of ["updatedBy", "proposedBy"] as const) {
      if (typeof item[field] !== "string" || item[field].trim().toLowerCase() !== developerId.trim().toLowerCase()) continue;
      const aliases = new Aliases();
      await table.documentClient.send(new UpdateCommand({
        TableName: table.tableName, Key: { pk: teamRecordPk(orgId, project), sk: item.sk },
        UpdateExpression: `SET ${aliases.name(field)} = ${aliases.value(ERASED_DEVELOPER_ID)}`, ConditionExpression: `attribute_exists(${aliases.name("pk")})`,
        ExpressionAttributeNames: aliases.names, ExpressionAttributeValues: aliases.values,
      }));
      changed += 1;
    }
  }
  return changed;
}

export async function scrubConfigDeveloper(table: TeamRecordTable, config: SourceConfig, developerId: string): Promise<boolean> {
  const addedBy = config.addedBy === developerId;
  const approved = config.approval?.by === developerId;
  if (!addedBy && !approved) return false;
  const aliases = new Aliases();
  const sets = [...(addedBy ? [`${aliases.name("addedBy")} = ${aliases.value(ERASED_DEVELOPER_ID)}`] : []), ...(approved ? [`${aliases.name("approval")}.${aliases.name("by")} = ${aliases.value(ERASED_DEVELOPER_ID)}`] : [])];
  await table.documentClient.send(new UpdateCommand({
    TableName: table.tableName,
    Key: recordSourceKey(config.workspaceId, config.project, config.source, config.scope),
    UpdateExpression: `SET ${sets.join(", ")}`,
    ConditionExpression: `attribute_exists(${aliases.name("pk")})`,
    ExpressionAttributeNames: aliases.names,
    ExpressionAttributeValues: aliases.values,
  }));
  return true;
}

export async function removeFromExclude(table: TeamRecordTable, config: SourceConfig, sourceIds: ReadonlySet<string>): Promise<boolean> {
  if (!config.exclude.some((id) => sourceIds.has(id))) return false;
  const aliases = new Aliases();
  const key = recordSourceKey(config.workspaceId, config.project, config.source, config.scope);
  await table.documentClient.send(new UpdateCommand({
    TableName: table.tableName,
    Key: key,
    UpdateExpression: `SET ${aliases.name("exclude")} = ${aliases.value(config.exclude.filter((id) => !sourceIds.has(id)))}`,
    ConditionExpression: `attribute_exists(${aliases.name("pk")})`,
    ExpressionAttributeNames: aliases.names,
    ExpressionAttributeValues: aliases.values,
  }));
  return true;
}
