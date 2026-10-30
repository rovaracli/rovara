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
  RECORD_DELETE_QUEUE_SK_PREFIX,
  RECORD_EVENT_SK_PREFIX,
  RECORD_FACT_SK_PREFIX,
  RECORD_SOURCE_SK_PREFIX,
  recordActorIndexValue,
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
import type { TeamRecordTable } from "./types.js";

const KEY_ATTRIBUTES = ["pk", "sk", "entityType", TEAM_RECORD_GSI1.partition, TEAM_RECORD_GSI2.partition, TEAM_RECORD_GSI3.partition, "rowScope", "sourceHash"] as const;
const dropKeys = (item: Item): Item => Object.fromEntries(Object.entries(item).filter(([name]) => !(KEY_ATTRIBUTES as readonly string[]).includes(name)));

/** A record row with the scope it was stored under (a row of a project-wide audience may carry one the audience does not). */
export type StoredEvent = RecordEvent & { scope?: string | undefined };

/**
 * The same item always has the same id: a UUID built from the hash of the source item and its version, so a retried delivery writes the same row.
 * Version bits are set to 5 and the variant to RFC 4122, which is what a UUID parser expects.
 */
export function deterministicEventId(orgId: OrgId, source: string, system: string, sourceId: string, version: string): string {
  const hex = createHash("sha256").update(`${orgId}\n${source}\n${system}\n${sourceId}\n${version}`).digest("hex");
  const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The scope a row is indexed under: the snapshot's, else the explicit one, else none. */
export function scopeOfEvent(event: RecordEvent, explicit?: string): string | undefined {
  return event.audience.kind === "restricted" ? event.audience.acl.scope : explicit;
}

export function eventItem(event: RecordEvent, explicitScope?: string): Item {
  const key = recordEventKey(event.workspaceId, event.project, event.occurredAt, event.id);
  const scope = scopeOfEvent(event, explicitScope);
  return withoutUndefined({
    ...key,
    entityType: "TEAM_RECORD_EVENT",
    ...event,
    rowScope: scope,
    sourceHash: teamRecordSourceHash(event.sourceRef.system, event.sourceRef.id),
    [TEAM_RECORD_GSI1.partition]: recordSourceIndexValue(event.workspaceId, event.sourceRef.system, event.sourceRef.id),
    [TEAM_RECORD_GSI2.partition]: event.actor?.developerId === undefined ? undefined : recordActorIndexValue(event.workspaceId, event.actor.developerId),
    [TEAM_RECORD_GSI3.partition]: scope === undefined ? undefined : recordScopeIndexValue(event.workspaceId, scope),
    [INDEX_EXPIRY_ATTRIBUTE]: event.indexExpiresAt,
  });
}

/** A stored event, or undefined when it is not one or does not parse (it is then never shown). */
export function eventFromItem(item: Item | undefined): StoredEvent | undefined {
  if (item?.entityType !== "TEAM_RECORD_EVENT") return undefined;
  const parsed = RecordEventSchema.safeParse(dropKeys(item));
  if (!parsed.success) return undefined;
  const scope = typeof item.rowScope === "string" ? item.rowScope : undefined;
  return scope === undefined ? parsed.data : { ...parsed.data, scope };
}

export type PutResult = "stored" | "duplicate";

/** Writes a row once. A second write of the same item version is a no-op. */
export async function putRecordEvent(table: TeamRecordTable, event: RecordEvent, explicitScope?: string): Promise<PutResult> {
  const parsed = RecordEventSchema.parse(event);
  try {
    await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: eventItem(parsed, explicitScope), ConditionExpression: NOT_EXISTS }));
    return "stored";
  } catch (error) {
    if (errorName(error) === "ConditionalCheckFailedException") return "duplicate";
    throw error;
  }
}

export async function getRecordEvent(table: TeamRecordTable, orgId: OrgId, project: string | undefined, occurredAt: string, id: string): Promise<StoredEvent | undefined> {
  const response = await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: recordEventKey(orgId, project, occurredAt, id), ConsistentRead: true })) as { Item?: Item };
  return eventFromItem(response.Item);
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
export async function queryRecordEvents(table: TeamRecordTable, orgId: OrgId, project: string | undefined, options: { since?: string; until?: string; limit: number }): Promise<StoredEvent[]> {
  const lower = `${RECORD_EVENT_SK_PREFIX}${options.since === undefined ? "" : new Date(options.since).toISOString()}`;
  const upper = `${RECORD_EVENT_SK_PREFIX}${options.until === undefined ? "" : new Date(options.until).toISOString()}\uffff`;
  const response = await table.documentClient.send(new QueryCommand({
    TableName: table.tableName,
    KeyConditionExpression: "pk = :pk AND sk BETWEEN :low AND :high",
    ExpressionAttributeValues: { ":pk": teamRecordPk(orgId, project), ":low": lower, ":high": upper },
    ScanIndexForward: false,
    Limit: Math.min(options.limit, 500),
  })) as { Items?: Item[] };
  return (response.Items ?? []).map(eventFromItem).filter((event): event is StoredEvent => event !== undefined);
}

/** Every item (rows, derivation links) on one index value, including tombstoned ones: the delete worker needs them. Bounded by `maxItems`. */
export async function queryIndex(table: TeamRecordTable, index: typeof TEAM_RECORD_GSI1 | typeof TEAM_RECORD_GSI2 | typeof TEAM_RECORD_GSI3, value: string, maxItems: number): Promise<{ items: Item[]; truncated: boolean }> {
  return queryAll(table, { IndexName: index.index, KeyConditionExpression: `${index.partition} = :v`, ExpressionAttributeValues: { ":v": value } }, maxItems);
}

export const bySource = (table: TeamRecordTable, orgId: OrgId, system: string, sourceId: string, maxItems: number) => queryIndex(table, TEAM_RECORD_GSI1, recordSourceIndexValue(orgId, system, sourceId), maxItems);
export const byActor = (table: TeamRecordTable, orgId: OrgId, developerId: string, maxItems: number) => queryIndex(table, TEAM_RECORD_GSI2, recordActorIndexValue(orgId, developerId), maxItems);
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
      UpdateExpression: `SET ${aliases.name("tombstone")} = ${aliases.value(tombstone)} REMOVE ${aliases.name("text")}`,
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

export async function putRecordFact(table: TeamRecordTable, fact: RecordFact, scope?: string): Promise<void> {
  const parsed = RecordFactSchema.parse(fact);
  await table.documentClient.send(new PutCommand({
    TableName: table.tableName,
    Item: withoutUndefined({ ...recordFactKey(parsed.workspaceId, parsed.project, parsed.id), entityType: "TEAM_RECORD_FACT", ...parsed, rowScope: scope }),
  }));
}

export function factFromItem(item: Item | undefined): RecordFact | undefined {
  if (item?.entityType !== "TEAM_RECORD_FACT") return undefined;
  const parsed = RecordFactSchema.safeParse(dropKeys(item));
  return parsed.success ? parsed.data : undefined;
}

export async function getRecordFact(table: TeamRecordTable, orgId: OrgId, project: string | undefined, factId: string): Promise<RecordFact | undefined> {
  const response = await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: recordFactKey(orgId, project, factId), ConsistentRead: true })) as { Item?: Item };
  return factFromItem(response.Item);
}

export async function queryRecordFacts(table: TeamRecordTable, orgId: OrgId, project: string | undefined, maxItems: number): Promise<RecordFact[]> {
  const { items } = await queryPrefix(table, orgId, project, RECORD_FACT_SK_PREFIX, maxItems);
  return items.map(factFromItem).filter((fact): fact is RecordFact => fact !== undefined);
}

/**
 * Links a fact to every source item it was distilled from, so a delete at a source that stored no row (retention B) still finds the fact. The distiller calls
 * this when it writes a fact. `scope` is the source's scope, when it has one, so a deleted channel or repository reaches the fact too.
 */
export async function putDerivationLinks(table: TeamRecordTable, input: { orgId: OrgId; project: string | undefined; factId: string; sources: ReadonlyArray<{ system: string; sourceId: string; scope?: string }>; at: string }): Promise<void> {
  for (const source of input.sources) {
    await table.documentClient.send(new PutCommand({
      TableName: table.tableName,
      Item: withoutUndefined({
        ...recordDerivationKey(input.orgId, input.project, source.system, source.sourceId, input.factId),
        entityType: "TEAM_RECORD_DERIVATION",
        factId: input.factId,
        system: source.system,
        scope: source.scope,
        createdAt: input.at,
        [TEAM_RECORD_GSI1.partition]: recordSourceIndexValue(input.orgId, source.system, source.sourceId),
        [TEAM_RECORD_GSI3.partition]: source.scope === undefined ? undefined : recordScopeIndexValue(input.orgId, source.scope),
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

export type PutSourceResult = { status: "saved" } | { status: "refused"; reason: "scope_in_other_project" | "invalid" };

export async function putSourceConfig(table: TeamRecordTable, config: SourceConfig): Promise<PutSourceResult> {
  const parsed = SourceConfigSchema.safeParse(config);
  if (!parsed.success) return { status: "refused", reason: "invalid" };
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

/** The scopes whose rows are hidden at once while work on them is unfinished. */
export async function hiddenScopesOf(table: TeamRecordTable, orgId: OrgId, maxItems = 200): Promise<ReadonlySet<string>> {
  const work = await listScopeWork(table, orgId, maxItems);
  return new Set(work.filter((entry) => entry.hidePending && entry.scope !== undefined).map((entry) => entry.scope as string));
}
