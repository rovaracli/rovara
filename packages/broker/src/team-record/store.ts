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
  recordScopeIndexValue,
  recordSourceConfigIndexValue,
  recordSourceIndexValue,
  recordSourceKey,
  teamRecordPk,
  teamRecordSourceHash,
  type OrgId,
  type RecordEvent,
  type RecordFact,
  type RecordSourceKind,
  type SourceConfig,
} from "@agentx/contracts";
import { Aliases, NOT_EXISTS, errorName, withoutUndefined, type Item } from "../agents/table-writes.js";
import { retentionRefusal } from "./retention.js";
import type { Edition, PendingHides, TeamRecordTable } from "./types.js";

const KEY_ATTRIBUTES = ["pk", "sk", "entityType", TEAM_RECORD_GSI1.partition, TEAM_RECORD_GSI2.partition, TEAM_RECORD_GSI3.partition, TEAM_RECORD_GSI4.partition, TEAM_RECORD_GSI5.partition, TEAM_RECORD_GSI5.sort, "rowScope", "rowScopes", "sourceHash", "archivedAt"] as const;
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

async function queryAll(table: TeamRecordTable, input: Record<string, unknown>, maxItems: number): Promise<{ items: Item[]; truncated: boolean }> {
  const items: Item[] = [];
  let startKey: Record<string, unknown> | undefined;
  for (;;) {
    const remaining = maxItems - items.length;
    if (remaining <= 0) return { items, truncated: true };
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
export const byScope = (table: TeamRecordTable, orgId: OrgId, scope: string, maxItems: number) => queryIndex(table, TEAM_RECORD_GSI3, recordScopeIndexValue(orgId, scope), maxItems);

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
export async function getSourceConfigByScope(table: TeamRecordTable, orgId: OrgId, source: RecordSourceKind, scope: string): Promise<SourceConfig | undefined> {
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
  await table.documentClient.send(new PutCommand({
    TableName: table.tableName,
    Item: withoutUndefined({
      ...recordSourceKey(parsed.data.workspaceId, parsed.data.project, parsed.data.source, parsed.data.scope),
      entityType: "TEAM_RECORD_SOURCE",
      ...parsed.data,
      [TEAM_RECORD_GSI1.partition]: recordSourceConfigIndexValue(parsed.data.workspaceId, parsed.data.source, parsed.data.scope),
    }),
  }));
  return { status: "saved" };
}

export async function listSourceConfigs(table: TeamRecordTable, orgId: OrgId, project: string, maxItems = 200): Promise<SourceConfig[]> {
  const { items } = await queryPrefix(table, orgId, project, RECORD_SOURCE_SK_PREFIX, maxItems);
  return items.map(sourceConfigFromItem).filter((config): config is SourceConfig => config !== undefined);
}

// ---- the delete queue (scope work)

/** A piece of work on a scope or on source items that must finish: hide, change an ACL, then delete. The delete worker (D1) finishes it. */
export interface ScopeWork {
  requestId: string;
  type: "tombstone" | "principals" | "audience";
  system: string;
  scope?: string;
  sourceIds?: string[];
  cause?: "source_deleted" | "person_erased" | "project_archived" | "excluded";
  add?: string[];
  remove?: string[];
  audience?: unknown;
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
