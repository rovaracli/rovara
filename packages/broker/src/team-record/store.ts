// The hot store of the Team record: reads and writes of the `TeamRecord` table (design 4.2). Every key comes from the builders in contracts (workspace and project in
// the partition); every row read back is parsed with its strict schema and one that does not parse is dropped, never shown. Writes are idempotent.
import { createHash } from "node:crypto";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, teamRecordPk, type OrgId } from "@rovara-code/contracts";
import { RecordEventSchema, RecordFactSchema, SourceConfigSchema, TEAM_RECORD_GSI1, TEAM_RECORD_GSI2, TEAM_RECORD_GSI3, TEAM_RECORD_GSI4, TEAM_RECORD_GSI5, RECORD_DELETE_QUEUE_SK_PREFIX, RECORD_EVENT_SK_PREFIX, RECORD_FACT_SK_PREFIX, RECORD_SOURCE_SK_PREFIX, recordActorIndexValue, recordActorSourceIndexValue, recordTextDueIndexValue, recordDeleteQueueKey, recordDerivationKey, recordEventKey, recordFactKey, recordPlaceIndexValue, recordScopeIndexValue, recordSourceConfigIndexValue, recordSourceIndexValue, recordSourceKey, teamRecordOrgDirectoryKey, teamRecordSourceHash, type RecordEvent, type RecordFact, type RecordSystem, type SourceConfig } from "@agentx/cloud-contracts";
import { Aliases, NOT_EXISTS, errorName, withoutUndefined, type Item } from "../agents/table-writes.js";
import { recordHeadIndexValue, reopenScope } from "./item-head.js";
import { isLateRow, lateMarkerItem, putLateRecordEvent } from "./keyword-late.js";
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

/**
 * Writes a row once. A second write of the same item version is a no-op. With `nowMs` (the writer's clock), a row whose `occurredAt` is older than the keyword index's late margin is written together with a late marker in ONE
 * transaction (keyword-late.ts), so a row can never be stored without the marker that makes the index read it live until a rebuild folds it in.
 */
export async function putRecordEvent(table: TeamRecordTable, event: RecordEvent, options: { nowMs?: number } = {}): Promise<PutResult> {
  const parsed = RecordEventSchema.parse(event);
  try {
    if (options.nowMs !== undefined && isLateRow(parsed.occurredAt, options.nowMs)) {
      return await putLateRecordEvent(table, eventItem(parsed), lateMarkerItem(parsed.workspaceId, parsed.project, parsed.occurredAt, parsed.id, options.nowMs));
    }
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

/** The most rows one window read gets, however large a `limit` is asked (the same cap the single query always had). */
export const RECORD_WINDOW_ROWS_MAX = 500;

/** What a window read did: the rows (parsed, newest first), how many items it read from the table, how many pages that took, and why it stopped. */
export interface RecordEventWindow {
  events: StoredEvent[];
  rowsRead: number;
  pages: number;
  /** `limit`: the rows asked for were read; `end`: no older row is left; `deadline`: the time budget ran out first (the window is then the newest rows read so far). */
  stopped: "limit" | "end" | "deadline";
}

/** `work` against a deadline: the answer, or `undefined` when `ms` run out first (the abandoned call is left to finish and its failure is ignored). */
async function withinMs<T>(ms: number, work: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), Math.max(1, ms)); });
  work.catch(() => undefined);
  try { return await Promise.race([work, late]); } finally { if (timer !== undefined) clearTimeout(timer); }
}

/**
 * A project's rows between two instants, newest first: PAGED until `limit` items (at most `RECORD_WINDOW_ROWS_MAX`) are read, or no older row is left, or the time budget is spent. One DynamoDB Query stops
 * at 1 MB of items whatever its `Limit` (lane K1: before, "400 rows" really meant "400 rows or 1 MB, whichever came first", so a run of long rows shrank the window); this follows `LastEvaluatedKey` until the rows are
 * read. The budget is `deadlineAt` (an absolute time on `clock`, default `Date.now`): no page starts once it has passed (the FIRST page always starts), and a page still running at the deadline is given up on, so the
 * caller answers from the newest rows read so far instead of waiting past its own deadline. Rows that do not parse are left out of `events` but count as read. Without `deadlineAt` there is no time limit (the row cap bounds the pages).
 */
export async function queryRecordEventWindow(table: TeamRecordTable, orgId: OrgId, project: string | undefined, options: { since?: string; until?: string; limit: number; nowSeconds?: number; deadlineAt?: number; clock?: () => number }): Promise<RecordEventWindow> {
  const lower = `${RECORD_EVENT_SK_PREFIX}${options.since === undefined ? "" : new Date(options.since).toISOString()}`;
  const upper = `${RECORD_EVENT_SK_PREFIX}${options.until === undefined ? "" : new Date(options.until).toISOString()}\uffff`;
  const wanted = Math.min(options.limit, RECORD_WINDOW_ROWS_MAX);
  const clock = options.clock ?? Date.now;
  const items: Item[] = [];
  let pages = 0;
  let startKey: Record<string, unknown> | undefined;
  const done = (stopped: RecordEventWindow["stopped"]): RecordEventWindow => ({
    events: items.map((item) => eventFromItem(item, options.nowSeconds)).filter((event): event is StoredEvent => event !== undefined), rowsRead: items.length, pages, stopped,
  });
  for (;;) {
    const remaining = wanted - items.length;
    if (remaining <= 0) return done("limit");
    if (pages > 0 && options.deadlineAt !== undefined && clock() >= options.deadlineAt) return done("deadline");
    const request = table.documentClient.send(new QueryCommand({
      TableName: table.tableName,
      KeyConditionExpression: "pk = :pk AND sk BETWEEN :low AND :high",
      ExpressionAttributeValues: { ":pk": teamRecordPk(orgId, project), ":low": lower, ":high": upper },
      ScanIndexForward: false,
      Limit: remaining,
      ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
    })) as Promise<{ Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> }>;
    const response = options.deadlineAt === undefined ? await request : await withinMs(options.deadlineAt - clock(), request);
    if (response === undefined) return done("deadline");
    pages += 1;
    items.push(...(response.Items ?? []));
    startKey = response.LastEvaluatedKey;
    if (startKey === undefined) return done("end");
  }
}

/** A project's rows between two instants, newest first, up to `limit`, read in pages (`queryRecordEventWindow`). Rows that do not parse are left out. */
export async function queryRecordEvents(table: TeamRecordTable, orgId: OrgId, project: string | undefined, options: { since?: string; until?: string; limit: number; nowSeconds?: number; deadlineAt?: number; clock?: () => number }): Promise<StoredEvent[]> {
  return (await queryRecordEventWindow(table, orgId, project, options)).events;
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
export async function scopePage(table: TeamRecordTable, orgId: OrgId, scope: string, maxItems: number, options: { exact?: boolean; cursor?: ScopeCursor; heads?: boolean } = {}): Promise<{ items: Item[]; cursor?: ScopeCursor }> {
  // `heads`: the item heads of the place (and of the places under it) instead of its rows; they are indexed apart so a walk over rows never reads them.
  const value = options.heads === true ? recordHeadIndexValue(orgId, scope) : recordScopeIndexValue(orgId, scope);
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
  // The place is open again, so the row must not keep reading `failing` (set when a repository deleted or transferred, or the hourly repository check, closed it) and so stay out of the next check.
  await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: sourceRowItem(parsed.data.health === "failing" ? { ...parsed.data, health: "unknown" } : parsed.data) }));
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
  /** A tombstone queued by removing a source row: the project that removed it, so that project's editors see the place as "being removed" until the worker is done. Work queued any other way has none. */
  project?: string;
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
  /** A tombstone of a place that hides and deletes only the rows that hold free text (and the facts made from them); the place stays open and its other rows stay (a removed Rovara source row). */
  textOnly?: boolean;
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

/**
 * The queue item itself, as it is stored. A producer that writes this alone (in a transaction of its own, `source-write.ts`) MUST list the workspace first (`listWorkspace`): queued work is only ever finished by the
 * hourly job, and the job reaches a workspace only through the directory (`TEAM_RECORD_ORGS`, `eachOrg` in runtime.ts). That was the 0.5.15 staging find: a source removed in a workspace with no earlier record write
 * queued its item and the delete sat unprocessed. `putScopeWork` does both and is what every other producer uses.
 */
export function scopeWorkItem(orgId: OrgId, work: ScopeWork): Item {
  return withoutUndefined({ ...recordDeleteQueueKey(orgId, work.at, work.requestId), entityType: "TEAM_RECORD_SCOPE_WORK", ...work });
}

/**
 * Lists the workspace in the directory the hourly jobs walk: an UPDATE that only fills what is missing, so it is idempotent, never fails on an existing row and never rewrites its time. A plain write on purpose, never part
 * of a transaction: the directory is ONE partition every workspace shares, and a transaction touching it would be cancelled by any concurrent write to it. The same row `listOrg` (runtime.ts) writes on a record write.
 */
export async function listWorkspace(table: TeamRecordTable, orgId: OrgId, at: string): Promise<void> {
  const aliases = new Aliases();
  await table.documentClient.send(new UpdateCommand({
    TableName: table.tableName,
    Key: teamRecordOrgDirectoryKey(orgId),
    UpdateExpression: `SET ${aliases.name("entityType")} = if_not_exists(${aliases.name("entityType")}, ${aliases.value("TEAM_RECORD_ORG")}), ${aliases.name("orgId")} = if_not_exists(${aliases.name("orgId")}, ${aliases.value(orgId)}), ${aliases.name("at")} = if_not_exists(${aliases.name("at")}, ${aliases.value(at)})`,
    ExpressionAttributeNames: aliases.names,
    ExpressionAttributeValues: aliases.values,
  }));
}

/** Queues work: the workspace is listed FIRST (a plain idempotent write), then the item is written, so a queued item always has a directory row. A listing left behind by a failed item write is harmless. */
export async function putScopeWork(table: TeamRecordTable, orgId: OrgId, work: ScopeWork): Promise<void> {
  await listWorkspace(table, orgId, work.at);
  await rewriteScopeWork(table, orgId, work);
}

/** Rewrites an item that is already queued (progress of the delete worker or of the sink's own pass): it was listed when it was first queued, so nothing is listed again. A NEW item goes through `putScopeWork`. */
export async function rewriteScopeWork(table: TeamRecordTable, orgId: OrgId, work: ScopeWork): Promise<void> {
  await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: scopeWorkItem(orgId, work) }));
}

/**
 * The oldest key under `DELQ#`, whether or not its item parses (`listScopeWork` drops what does not). For a check that must not mistake a malformed item for an empty queue. `at` is read from the key itself.
 */
export async function oldestQueuedKey(table: TeamRecordTable, orgId: OrgId): Promise<{ sk: string; at: string } | undefined> {
  const { items } = await queryPrefix(table, orgId, undefined, RECORD_DELETE_QUEUE_SK_PREFIX, 1);
  const sk = items[0]?.sk;
  return typeof sk === "string" ? { sk, at: sk.slice(RECORD_DELETE_QUEUE_SK_PREFIX.length).split("#")[0] ?? "" } : undefined;
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

/** How many times a scrub of a source row looks again when another writer changed the row under it. */
const SCRUB_ATTEMPTS = 3;

/**
 * One scrub of a source row: `plan` says, from the row as read, what to set and what the row must still hold for that to be right. The write is conditional on those values and moves the
 * row's `revision` (and `updatedAt`), so an editor who loaded the row before the scrub can no longer write the scrubbed value back through the source route's revision fence. A row that changed
 * meanwhile is read again and planned again, within a small bound; past it the scrub throws and the erase step is resumed by the next run. Returns whether the row was written.
 */
async function scrubRow(table: TeamRecordTable, config: SourceConfig, plan: (row: SourceConfig) => { set: Array<{ path: string[]; value: unknown }>; expect: Array<{ path: string[]; value: unknown }> } | undefined): Promise<boolean> {
  const key = recordSourceKey(config.workspaceId, config.project, config.source, config.scope);
  let row: SourceConfig | undefined = config;
  for (let attempt = 0; attempt < SCRUB_ATTEMPTS; attempt += 1) {
    const change = row === undefined ? undefined : plan(row);
    if (change === undefined) return false;
    const aliases = new Aliases();
    const at = (path: string[]): string => path.map((part) => aliases.name(part)).join(".");
    const sets = [...change.set.map((entry) => `${at(entry.path)} = ${aliases.value(entry.value)}`), `${aliases.name("revision")} = if_not_exists(${aliases.name("revision")}, ${aliases.value(0)}) + ${aliases.value(1)}`, `${aliases.name("updatedAt")} = ${aliases.value(new Date().toISOString())}`];
    try {
      await table.documentClient.send(new UpdateCommand({
        TableName: table.tableName, Key: key, UpdateExpression: `SET ${sets.join(", ")}`,
        ConditionExpression: [`attribute_exists(${aliases.name("pk")})`, ...change.expect.map((entry) => `${at(entry.path)} = ${aliases.value(entry.value)}`)].join(" AND "),
        ExpressionAttributeNames: aliases.names, ExpressionAttributeValues: aliases.values,
      }));
      return true;
    } catch (error) {
      if (errorName(error) !== "ConditionalCheckFailedException") throw error;
      const again = await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: key, ConsistentRead: true })) as { Item?: Item };
      row = sourceConfigFromItem(again.Item);
    }
  }
  throw new Error("the source row kept changing");
}

/**
 * A place that is gone at its source (a repository deleted or transferred): the source row's `health` becomes `failing`. The write touches ONLY `health`. It never moves `revision` or `updatedAt`, so
 * an editor who loaded the row at revision N can still write at N (the source route's fence), and the route's own writes set only the five editable fields, so a change never undoes the health.
 * It is conditional on the revision it read (a missing revision reads as 0, like everywhere), so a row removed and added again, or changed, between the read and the write is read again (three
 * attempts, then `busy`: the caller logs a fixed code; the place is already closed either way). `no_row`: nothing to mark. `already`: nothing to write.
 */
export async function markSourceFailing(table: TeamRecordTable, orgId: OrgId, source: RecordSystem, scope: string): Promise<"marked" | "already" | "no_row" | "busy"> {
  for (let attempt = 0; attempt < SCRUB_ATTEMPTS; attempt += 1) {
    const row = await getSourceConfigByScope(table, orgId, source, scope);
    if (row === undefined) return "no_row";
    if (row.health === "failing") return "already";
    const aliases = new Aliases();
    const revision = aliases.name("revision");
    try {
      await table.documentClient.send(new UpdateCommand({
        TableName: table.tableName, Key: recordSourceKey(orgId, row.project, source, scope), UpdateExpression: `SET ${aliases.name("health")} = ${aliases.value("failing")}`,
        ConditionExpression: row.revision === undefined ? `attribute_exists(${aliases.name("pk")}) AND attribute_not_exists(${revision})` : `attribute_exists(${aliases.name("pk")}) AND ${revision} = ${aliases.value(row.revision)}`,
        ExpressionAttributeNames: aliases.names, ExpressionAttributeValues: aliases.values,
      }));
      return "marked";
    } catch (error) {
      if (errorName(error) !== "ConditionalCheckFailedException") throw error;
    }
  }
  return "busy";
}

export async function scrubConfigDeveloper(table: TeamRecordTable, config: SourceConfig, developerId: string): Promise<boolean> {
  return scrubRow(table, config, (row) => {
    const addedBy = row.addedBy === developerId;
    const approved = row.approval?.by === developerId;
    if (!addedBy && !approved) return undefined;
    return {
      set: [...(addedBy ? [{ path: ["addedBy"], value: ERASED_DEVELOPER_ID }] : []), ...(approved ? [{ path: ["approval", "by"], value: ERASED_DEVELOPER_ID }] : [])],
      expect: [...(addedBy ? [{ path: ["addedBy"], value: developerId }] : []), ...(approved ? [{ path: ["approval", "by"], value: developerId }] : [])],
    };
  });
}

export async function removeFromExclude(table: TeamRecordTable, config: SourceConfig, sourceIds: ReadonlySet<string>): Promise<boolean> {
  return scrubRow(table, config, (row) => {
    if (!row.exclude.some((id) => sourceIds.has(id))) return undefined;
    // Conditional on the list it was worked out from: an editor's change meanwhile is read again, not overwritten.
    return { set: [{ path: ["exclude"], value: row.exclude.filter((id) => !sourceIds.has(id)) }], expect: [{ path: ["exclude"], value: row.exclude }] };
  });
}
