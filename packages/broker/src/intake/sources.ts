// Meta repo lane F (F2): the places a project's work is asked for that are READ ON A TIMER (a tracker with no webhook, such as a team's own). One record per source, in a global
// partition (`intakeSourceKey`) so the poll finds every due source with one query. A maintainer sets the sources of a project; the poll keeps its own state on the record (when it
// is next due, how many reads in a row failed, when it last told the maintainers). The record names a connection by name only: never an address, never a secret.
import { createHash } from "node:crypto";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { agentXError, IntakeChannelRefSchema, intakeSourceCountKey, intakeSourceKey, intakeSystemOf, type IntakeChannelRef, type OrgId } from "@agentx/contracts";
import type { IntakeTable } from "./store.js";

export interface IntakeSourceRecord {
  orgId: OrgId;
  project: string;
  sourceId: string;
  ref: IntakeChannelRef;
  /** The member who set it (the maintainer's act). */
  setBy: string;
  createdAt: string;
  updatedAt: string;
  /** Epoch ms the source is next due. */
  nextPollAt: number;
  /** Reads in a row that failed (0 when the last one worked). */
  failures: number;
  /** Epoch ms the current run of failures began. */
  failingSince?: number;
  /** The code of the last failure (a code, never the error's words). */
  lastError?: string;
  lastPolledAt?: number;
  /** Epoch ms the maintainers were last told this source is failing. */
  noticedAt?: number;
}

/** The most sources one project has. */
export const INTAKE_MAX_SOURCES_PER_PROJECT = 8;

/** A source's id: the same channel, system and connection is the same source. */
export function intakeSourceIdOf(ref: IntakeChannelRef): string {
  return createHash("sha256").update(`${ref.channel}\0${intakeSystemOf(ref)}\0${ref.connection ?? ""}`).digest("hex").slice(0, 24);
}

const isConditional = (error: unknown): boolean => error instanceof Error && error.name === "ConditionalCheckFailedException";

/** A stored source read back; undefined for an item that is not one (wrong org or project, or a ref that no longer parses: fail closed). */
function sourceOf(raw: Record<string, unknown> | undefined): IntakeSourceRecord | undefined {
  if (raw === undefined || raw["entityType"] !== "INTAKE_SOURCE" || typeof raw["orgId"] !== "string" || typeof raw["project"] !== "string" || typeof raw["sourceId"] !== "string") return undefined;
  const ref = IntakeChannelRefSchema.safeParse(raw["ref"]);
  if (!ref.success || typeof raw["nextPollAt"] !== "number") return undefined;
  const key = intakeSourceKey(raw["orgId"], raw["project"], raw["sourceId"]);
  if (raw["pk"] !== key.pk || raw["sk"] !== key.sk) return undefined;
  const rest: Record<string, unknown> = { ...raw };
  for (const attribute of ["pk", "sk", "entityType"]) delete rest[attribute];
  return { ...(rest as unknown as IntakeSourceRecord), ref: ref.data };
}

export async function readIntakeSource(table: IntakeTable, orgId: OrgId, project: string, sourceId: string): Promise<IntakeSourceRecord | undefined> {
  const found = await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: intakeSourceKey(orgId, project, sourceId), ConsistentRead: true })) as { Item?: Record<string, unknown> };
  return sourceOf(found.Item);
}

async function queryAll(table: IntakeTable, prefix: string, pages: number): Promise<IntakeSourceRecord[]> {
  const found: IntakeSourceRecord[] = [];
  let start: Record<string, unknown> | undefined;
  let read = 0;
  do {
    const page = await table.documentClient.send(new QueryCommand({
      TableName: table.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": "INTAKE_SOURCES", ":prefix": prefix }, ConsistentRead: true, Limit: 100,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    for (const raw of page.Items ?? []) {
      const record = sourceOf(raw);
      if (record !== undefined) found.push(record);
    }
    start = page.LastEvaluatedKey;
    read += 1;
  } while (start !== undefined && read < pages);
  return found;
}

/** A project's sources. */
export async function listIntakeSources(table: IntakeTable, orgId: OrgId, project: string): Promise<IntakeSourceRecord[]> {
  return (await queryAll(table, `${orgId}#${project}#`, 2)).filter((record) => record.orgId === orgId && record.project === project);
}

/** Every source of every org, at most `pages` pages of 100, for the poll. A source beyond that is read by the next tick (the order is the key's, and a due source is polled first). */
export async function listAllIntakeSources(table: IntakeTable, pages = 10): Promise<IntakeSourceRecord[]> {
  return queryAll(table, "", pages);
}

/**
 * Replaces a project's sources with `refs`: a source already there keeps its poll state (a change of settings does not make it due at once or forget its failures), a new one is due
 * now, and one that is not named any more is deleted. At most `INTAKE_MAX_SOURCES_PER_PROJECT`, each a different channel, system and connection.
 */
export async function replaceIntakeSources(table: IntakeTable, input: { orgId: OrgId; project: string; refs: readonly IntakeChannelRef[]; setBy: string }): Promise<IntakeSourceRecord[]> {
  const refs = input.refs.map((ref) => IntakeChannelRefSchema.parse(ref));
  if (refs.length > INTAKE_MAX_SOURCES_PER_PROJECT) throw new Error("too many intake sources");
  const wanted = new Map(refs.map((ref) => [intakeSourceIdOf(ref), ref] as const));
  if (wanted.size !== refs.length) throw new Error("an intake source is named twice");
  const now = table.now();
  const at = new Date(now).toISOString();
  const have = new Map((await listIntakeSources(table, input.orgId, input.project)).map((record) => [record.sourceId, record] as const));
  const result: IntakeSourceRecord[] = [];
  for (const [sourceId, ref] of wanted) {
    const key = intakeSourceKey(input.orgId, input.project, sourceId);
    const current = have.get(sourceId);
    if (current === undefined) {
      const record: IntakeSourceRecord = { orgId: input.orgId, project: input.project, sourceId, ref, setBy: input.setBy, createdAt: at, updatedAt: at, nextPollAt: now, failures: 0 };
      await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: { ...key, entityType: "INTAKE_SOURCE", ...record }, ConditionExpression: "attribute_not_exists(pk)" })).catch((error: unknown) => {
        if (!isConditional(error)) throw error;
      });
      result.push(record);
    } else {
      await table.documentClient.send(new UpdateCommand({
        TableName: table.tableName, Key: key, UpdateExpression: "SET #ref = :ref, #by = :by, #updated = :at", ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeNames: { "#ref": "ref", "#by": "setBy", "#updated": "updatedAt" }, ExpressionAttributeValues: { ":ref": ref, ":by": input.setBy, ":at": at },
      }));
      result.push({ ...current, ref, setBy: input.setBy, updatedAt: at });
    }
  }
  for (const [sourceId] of have) {
    if (wanted.has(sourceId)) continue;
    await table.documentClient.send(new DeleteCommand({ TableName: table.tableName, Key: intakeSourceKey(input.orgId, input.project, sourceId) }));
  }
  // The count kept beside the sources follows what was set.
  await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: { ...intakeSourceCountKey(input.orgId, input.project), entityType: "INTAKE_SOURCE_COUNT", orgId: input.orgId, project: input.project, count: result.length } }));
  return result;
}

/**
 * Adds ONE source to a project's sources without touching the others (a setup card, once approved, adds the one source it names). Idempotent: a source that is already there is left as it is
 * (`already_set`), and one with other settings is `differs`, never overwritten. At most `INTAKE_MAX_SOURCES_PER_PROJECT` (a ninth is refused in fixed words). A new source is due at once, like one set from the sources editor.
 */
export async function addIntakeSource(table: IntakeTable, input: { orgId: OrgId; project: string; ref: IntakeChannelRef; setBy: string }): Promise<"added" | "already_set" | "differs"> {
  const ref = IntakeChannelRefSchema.parse(input.ref);
  const sourceId = intakeSourceIdOf(ref);
  const have = await listIntakeSources(table, input.orgId, input.project);
  // A source is a channel, a system and a connection; the same place with other settings (another label) is the maintainer's to change, never overwritten by a card.
  const same = have.find((record) => record.sourceId === sourceId);
  if (same !== undefined) return JSON.stringify(same.ref) === JSON.stringify(ref) ? "already_set" : "differs";
  if (have.length >= INTAKE_MAX_SOURCES_PER_PROJECT) throw agentXError("CONFIG_INVALID", "This project already has the most intake sources it can have. Remove one before adding another.");
  const now = table.now();
  const at = new Date(now).toISOString();
  const record: IntakeSourceRecord = { orgId: input.orgId, project: input.project, sourceId, ref, setBy: input.setBy, createdAt: at, updatedAt: at, nextPollAt: now, failures: 0 };
  const countKey = intakeSourceCountKey(input.orgId, input.project);
  // The count of the project's sources is kept beside them. It starts from what is there, and a place is taken in ONE transaction that raises it only while it is under the most, so two
  // applies at once cannot both take the last place.
  await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: { ...countKey, entityType: "INTAKE_SOURCE_COUNT", orgId: input.orgId, project: input.project, count: have.length }, ConditionExpression: "attribute_not_exists(pk)" }))
    .catch((error: unknown) => { if (!isConditional(error)) throw error; });
  try {
    await table.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Update: { TableName: table.tableName, Key: countKey, UpdateExpression: "ADD #count :one", ConditionExpression: "#count < :max", ExpressionAttributeNames: { "#count": "count" }, ExpressionAttributeValues: { ":one": 1, ":max": INTAKE_MAX_SOURCES_PER_PROJECT } } },
      { Put: { TableName: table.tableName, Item: { ...intakeSourceKey(input.orgId, input.project, sourceId), entityType: "INTAKE_SOURCE", ...record }, ConditionExpression: "attribute_not_exists(pk)" } },
    ] }));
  } catch (error) {
    if (!(error instanceof Error) || (error.name !== "TransactionCanceledException" && !isConditional(error))) throw error;
    // Lost a race: look again. The same place is there now, or the project is full.
    const now2 = await listIntakeSources(table, input.orgId, input.project);
    const there = now2.find((source) => source.sourceId === sourceId);
    if (there !== undefined) return JSON.stringify(there.ref) === JSON.stringify(ref) ? "already_set" : "differs";
    throw agentXError("CONFIG_INVALID", "This project already has the most intake sources it can have. Remove one before adding another.");
  }
  return "added";
}
