// Meta repo lane F (F1): the intake records. One item per ticket per project (the key is the ticket's `externalRef`, hashed), so the same ticket is the same item however often a
// poll or a webhook hands it over. Every change is a conditional write, so two pollers, two deliveries or two members acting at once cannot both start the ticket:
//
//   (new) --claim--> waiting --claimStart--> starting --markStarted--> started
//     \--claim as starting-----^                |
//                                               +--giveBack--> waiting   (a start that was refused or could not be made)
//
// `starting` carries a lease: a start that died half way is taken over once its lease ran out, and the start itself is idempotent (its request id is fixed per ticket and member).
// The title is a person's words; it is kept only inert and cut, and read back as text.
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, intakeItemKey, type IntakeStanding, type IntakeTrackerChannel, type IntakeWaitReason, type OrgId } from "@agentx/contracts";

export interface IntakeTable {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
}

export type StoredIntakeState = "waiting" | "starting" | "started";

export interface IntakeItemRecord {
  orgId: OrgId;
  project: string;
  itemId: string;
  channel: IntakeTrackerChannel;
  system: string;
  id: string;
  url: string;
  title: string;
  /** The ticket's body while it waits (redacted, inert, cut): so the member who says "Start" starts it with the text that was handed over. Gone once it starts. */
  body?: string;
  /** Who wrote the ticket, as the tracker names them (inert, cut): said to the session beside the text, never checked. */
  writer?: string;
  requester: { display: string; standing: IntakeStanding; developerId?: string };
  state: StoredIntakeState;
  reason?: IntakeWaitReason;
  lastRefusal?: string;
  since: string;
  updatedAt: string;
  /** Epoch milliseconds the `starting` lease runs to. */
  leaseUntil?: number;
  startedBy?: string;
  taskId?: string;
  sessionId?: string;
}

/** How long a start may take before another may take it over. A start takes seconds. */
export const INTAKE_START_LEASE_MS = 120_000;
/** A waiting item is forgotten after this long; a ticket that is still asking is handed over again and waits again. */
export const INTAKE_WAITING_KEPT_DAYS = 30;
/** A started item is kept this long, far past any poll's memory, so a ticket that still carries its label is not started a second time. */
export const INTAKE_STARTED_KEPT_DAYS = 400;
/** The most waiting items a project holds; more are not stored (a maintainer is told once). It bounds what a flood of outsiders' tickets can cost. */
export const INTAKE_MAX_WAITING_PER_PROJECT = 200;

const DAY_SECONDS = 86_400;
const isConditional = (error: unknown): boolean => error instanceof Error && error.name === "ConditionalCheckFailedException";
const iso = (table: IntakeTable): string => new Date(table.now()).toISOString();
const expiryAfter = (table: IntakeTable, days: number): number => Math.floor(table.now() / 1000) + days * DAY_SECONDS;

async function readRaw(table: IntakeTable, key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined> {
  return ((await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: key, ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
}

/** A stored item read back: it must belong to the org and project it is read under, and be shaped as written; anything else is not an item. */
function recordOf(raw: Record<string, unknown> | undefined, orgId: OrgId, project: string): IntakeItemRecord | undefined {
  if (raw === undefined || raw["orgId"] !== orgId || raw["project"] !== project || raw["entityType"] !== "INTAKE_ITEM") return undefined;
  const state = raw["state"];
  if (state !== "waiting" && state !== "starting" && state !== "started") return undefined;
  const requester = raw["requester"] as IntakeItemRecord["requester"] | undefined;
  if (typeof raw["itemId"] !== "string" || typeof raw["system"] !== "string" || typeof raw["id"] !== "string" || typeof raw["url"] !== "string" || requester === undefined) return undefined;
  const record: Record<string, unknown> = { ...raw };
  for (const attribute of ["pk", "sk", "entityType", INDEX_EXPIRY_ATTRIBUTE]) delete record[attribute];
  return record as unknown as IntakeItemRecord;
}

export async function readIntakeItem(table: IntakeTable, orgId: OrgId, project: string, itemId: string): Promise<IntakeItemRecord | undefined> {
  return recordOf(await readRaw(table, intakeItemKey(orgId, project, itemId)), orgId, project);
}

export type NewIntakeItem = Pick<IntakeItemRecord, "orgId" | "project" | "itemId" | "channel" | "system" | "id" | "url" | "title" | "requester"> & { body?: string | undefined; writer?: string | undefined } & { state: "waiting" | "starting"; reason?: IntakeWaitReason | undefined; startedBy?: string | undefined };

/**
 * Writes a ticket's item if there is none. "created" when it wrote it; otherwise the item that is there (read again), so a caller learns whether the ticket is new and what became
 * of it. An item that is there but unreadable counts as "unreadable": the caller leaves it alone (fail closed).
 */
export async function claimIntakeItem(table: IntakeTable, input: NewIntakeItem): Promise<{ result: "created" } | { result: "exists"; record: IntakeItemRecord } | { result: "unreadable" }> {
  const at = iso(table);
  const key = intakeItemKey(input.orgId, input.project, input.itemId);
  const record: IntakeItemRecord = {
    orgId: input.orgId, project: input.project, itemId: input.itemId, channel: input.channel, system: input.system, id: input.id, url: input.url, title: input.title, requester: input.requester,
    ...(input.writer === undefined ? {} : { writer: input.writer }),
    state: input.state, since: at, updatedAt: at,
    ...(input.state === "waiting" && input.body !== undefined && input.body !== "" ? { body: input.body } : {}),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.state === "starting" ? { leaseUntil: table.now() + INTAKE_START_LEASE_MS, ...(input.startedBy === undefined ? {} : { startedBy: input.startedBy }) } : {}),
  };
  try {
    await table.documentClient.send(new PutCommand({
      TableName: table.tableName,
      Item: { ...key, entityType: "INTAKE_ITEM", ...record, [INDEX_EXPIRY_ATTRIBUTE]: expiryAfter(table, input.state === "waiting" ? INTAKE_WAITING_KEPT_DAYS : INTAKE_STARTED_KEPT_DAYS) },
      ConditionExpression: "attribute_not_exists(pk)",
    }));
    return { result: "created" };
  } catch (error) {
    if (!isConditional(error)) throw error;
  }
  const existing = await readIntakeItem(table, input.orgId, input.project, input.itemId);
  return existing === undefined ? { result: "unreadable" } : { result: "exists", record: existing };
}

/**
 * Moves a waiting item to `starting`, or takes over a start whose lease ran out: one conditional update, so of two callers only one wins. false when the item is not waiting (and not an
 * abandoned start): somebody else has it, or it is started.
 */
export async function claimIntakeStart(table: IntakeTable, orgId: OrgId, project: string, itemId: string, startedBy: string): Promise<boolean> {
  try {
    await table.documentClient.send(new UpdateCommand({
      TableName: table.tableName,
      Key: intakeItemKey(orgId, project, itemId),
      UpdateExpression: "SET #state = :starting, #lease = :lease, #by = :by, #updated = :at, #expires = :expires REMOVE #reason",
      ConditionExpression: "attribute_exists(pk) AND orgId = :org AND #project = :project AND (#state = :waiting OR (#state = :starting AND #lease < :now))",
      ExpressionAttributeNames: { "#project": "project", "#state": "state", "#lease": "leaseUntil", "#by": "startedBy", "#updated": "updatedAt", "#expires": INDEX_EXPIRY_ATTRIBUTE, "#reason": "reason" },
      ExpressionAttributeValues: {
        ":starting": "starting", ":waiting": "waiting", ":lease": table.now() + INTAKE_START_LEASE_MS, ":by": startedBy, ":at": iso(table), ":now": table.now(), ":org": orgId, ":project": project,
        ":expires": expiryAfter(table, INTAKE_STARTED_KEPT_DAYS),
      },
    }));
    return true;
  } catch (error) {
    if (isConditional(error)) return false;
    throw error;
  }
}

/** The start made a session: `started`, with where it went. Only the start that holds the item can say so. */
export async function markIntakeStarted(table: IntakeTable, orgId: OrgId, project: string, itemId: string, started: { taskId?: string | undefined; sessionId?: string | undefined }): Promise<void> {
  await table.documentClient.send(new UpdateCommand({
    TableName: table.tableName,
    Key: intakeItemKey(orgId, project, itemId),
    UpdateExpression: `SET #state = :started, #updated = :at${started.taskId === undefined ? "" : ", taskId = :task"}${started.sessionId === undefined ? "" : ", sessionId = :session"} REMOVE #lease, #reason, #refusal, #body`,
    ConditionExpression: "attribute_exists(pk) AND orgId = :org AND #project = :project AND #state = :starting",
    ExpressionAttributeNames: { "#project": "project", "#state": "state", "#updated": "updatedAt", "#lease": "leaseUntil", "#reason": "reason", "#refusal": "lastRefusal", "#body": "body" },
    ExpressionAttributeValues: {
      ":started": "started", ":starting": "starting", ":at": iso(table), ":org": orgId, ":project": project,
      ...(started.taskId === undefined ? {} : { ":task": started.taskId }), ...(started.sessionId === undefined ? {} : { ":session": started.sessionId }),
    },
  }));
}

/** A start that was refused or could not be made: the item waits again (with the reason, and the refusal's code if there was one), so a member can try again. */
export async function giveBackIntakeItem(table: IntakeTable, orgId: OrgId, project: string, itemId: string, reason: IntakeWaitReason, refusal?: string): Promise<void> {
  try {
    await table.documentClient.send(new UpdateCommand({
      TableName: table.tableName,
      Key: intakeItemKey(orgId, project, itemId),
      UpdateExpression: `SET #state = :waiting, #reason = :reason, #updated = :at, #expires = :expires${refusal === undefined ? "" : ", #refusal = :refusal"} REMOVE #lease, #by`,
      ConditionExpression: "attribute_exists(pk) AND orgId = :org AND #project = :project AND #state = :starting",
      ExpressionAttributeNames: { "#project": "project", "#state": "state", "#reason": "reason", "#updated": "updatedAt", "#lease": "leaseUntil", "#by": "startedBy", "#expires": INDEX_EXPIRY_ATTRIBUTE, ...(refusal === undefined ? {} : { "#refusal": "lastRefusal" }) },
      ExpressionAttributeValues: {
        ":waiting": "waiting", ":starting": "starting", ":reason": reason, ":at": iso(table), ":org": orgId, ":project": project, ":expires": expiryAfter(table, INTAKE_WAITING_KEPT_DAYS),
        ...(refusal === undefined ? {} : { ":refusal": refusal }),
      },
    }));
  } catch (error) {
    // The lease ran out and another start took the item over: it is theirs now.
    if (!isConditional(error)) throw error;
  }
}

/** Forgets an item that was created only to be started and never was (the start could not be made at all), so the next hand-over begins afresh. */
export async function releaseIntakeItem(table: IntakeTable, orgId: OrgId, project: string, itemId: string): Promise<void> {
  try {
    await table.documentClient.send(new DeleteCommand({
      TableName: table.tableName,
      Key: intakeItemKey(orgId, project, itemId),
      ConditionExpression: "orgId = :org AND #project = :project AND #state = :starting",
      ExpressionAttributeNames: { "#project": "project", "#state": "state" },
      ExpressionAttributeValues: { ":org": orgId, ":project": project, ":starting": "starting" },
    }));
  } catch (error) {
    if (!isConditional(error)) throw error;
  }
}

/** The project's waiting items, oldest first, at most `limit` (the partition is bounded by `INTAKE_MAX_WAITING_PER_PROJECT` and the expiry of old items). */
export async function listWaitingIntakeItems(table: IntakeTable, orgId: OrgId, project: string, limit = INTAKE_MAX_WAITING_PER_PROJECT): Promise<IntakeItemRecord[]> {
  const key = intakeItemKey(orgId, project, "0".repeat(32));
  const found: IntakeItemRecord[] = [];
  let start: Record<string, unknown> | undefined;
  let pages = 0;
  do {
    const page = await table.documentClient.send(new QueryCommand({
      TableName: table.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": key.pk }, ConsistentRead: true, Limit: 100,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    for (const raw of page.Items ?? []) {
      const record = recordOf(raw, orgId, project);
      if (record !== undefined && record.state === "waiting") found.push(record);
    }
    start = page.LastEvaluatedKey;
    pages += 1;
  } while (start !== undefined && pages < 10);
  return found.sort((a, b) => a.since.localeCompare(b.since)).slice(0, limit);
}
