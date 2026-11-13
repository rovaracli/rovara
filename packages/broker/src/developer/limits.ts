// Spec 025 FR-020 and FR-053: one set of workspace limits for Slack threads and developer tasks.
// The numbers are the admin's setting when there is one, else the stack parameters (R7).
import { GetCommand, QueryCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { isSlackLimitPk, orgLimitKey, slackMemberLimitKey, slackOrganizationLimitKey, type OrgId } from "@rovara-code/contracts";
import { orgSettingsKey } from "@agentx/cloud-contracts";
import type { CounterKey, WorkspaceCharge } from "./task-records.js";

type Client = { send(command: unknown): Promise<unknown> };
type TransactItems = NonNullable<TransactWriteCommandInput["TransactItems"]>;

/** One org's workspace limits setting. */
export const workspaceLimitsKey = (orgId: OrgId) => orgSettingsKey(orgId, "WORKSPACE_LIMITS");
export interface WorkspaceLimits { member: number; organization: number; source: "setting" | "parameters" }

const defaultLog = (entry: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", ...entry }));
/** FR-053: the bounds a setting must meet to be read; the admin writer refuses anything outside them. */
export const MAX_PER_PERSON = 50;
export const MAX_PER_ORGANIZATION = 1_000;
export const isWholeLimit = (value: unknown, max: number): value is number => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= max;

export async function readWorkspaceLimits(
  client: Client,
  tableName: string,
  orgId: OrgId,
  fallback: { member: number; organization: number },
  log: (entry: Record<string, unknown>) => void = defaultLog,
): Promise<WorkspaceLimits> {
  const response = await client.send(new GetCommand({ TableName: tableName, Key: workspaceLimitsKey(orgId), ConsistentRead: true })) as { Item?: Record<string, unknown> };
  const item = response.Item;
  if (item === undefined) return { ...fallback, source: "parameters" };
  const member = item.perPerson;
  const organization = item.perOrganization;
  // FR-053: the per-person limit never exceeds the per-organization one.
  if (!isWholeLimit(member, MAX_PER_PERSON) || !isWholeLimit(organization, MAX_PER_ORGANIZATION) || member > organization) {
    log({ event: "workspace_limits.invalid_setting" });
    return { ...fallback, source: "parameters" };
  }
  return { member, organization, source: "setting" };
}

/** R6: a linked developer shares their Slack member's counter; everyone shares the organization's. */
export function developerCharge(input: { orgId: OrgId; teamId?: string | undefined; slackUserId?: string | undefined; developerId: string }): WorkspaceCharge {
  return {
    member: input.teamId !== undefined && input.slackUserId !== undefined
      ? slackMemberLimitKey(input.orgId, input.teamId, input.slackUserId)
      : { pk: `DEVELOPER_LIMIT#${input.developerId}`, sk: "MEMBER" },
    organization: input.teamId !== undefined
      ? slackOrganizationLimitKey(input.orgId, input.teamId)
      : orgLimitKey(input.orgId),
  };
}

const entityOf = (key: CounterKey) => (isSlackLimitPk(key.pk) ? "SLACK_LIMIT" : "DEVELOPER_LIMIT");

// ---- The charge marker (convergence lane A5, owner decision 60 item S2) ----
//
// A charged task used to be recorded in a string set `tasks` on the member counter and tested with `contains`. Code's document store has no sets, so a
// charged task is now one marker item beside the member counter, written with `attribute_not_exists(pk)` and deleted on release: the same key as Code's
// core (`core/task-flow/keys.ts` `chargeMarkerKey`), so a slot Cloud charged is one Code's core can release after the switch. The marker also names the
// member counter's sort key (`memberSk`): a Slack team's member counters share one partition, so the key alone does not say whose slot it is.
//
// Until the one-time migration (the `s2-limits-session-markers` data move, scripts/cloud-data-move.ts) has run, counters may still hold old `tasks` sets. Every reader here reads both
// forms; a charge is refused for a task in either form; a release frees the form the task was charged in (`chargeFormOf`). The count itself is unchanged.

/** The marker's entity type: Code's core writes the same one. */
export const LIMIT_TASK_ENTITY = "DEVELOPER_LIMIT_TASK";
/** The sort-key prefix of the markers in a counter's partition. */
export const LIMIT_TASK_SK_PREFIX = "TASK#";

/** The marker that says a task holds a slot of this member's counter (Code's core `chargeMarkerKey`). */
export const chargeMarkerKey = (charge: Pick<WorkspaceCharge, "member">, taskId: string): CounterKey => ({ pk: charge.member.pk, sk: `${LIMIT_TASK_SK_PREFIX}${taskId}` });

/** Which stored form a task's charge is in: a marker item (written by this code), or an entry of the member counter's old `tasks` set. */
export type ChargeForm = "marker" | "set";

/**
 * The same conditions as a Slack thread's charge, at positions 0 (organization), 1 (member) and 2 (the task's marker): chargeConflict reads them by
 * position. The marker is new only if absent, so a repeated charge of one task cancels the whole transaction instead of counting twice. The member's
 * condition also refuses a task still in the counter's old `tasks` set (charged before the switch to markers), for the same reason. The Slack limit
 * refusal reads every `threads` entry as a thread subject, so tasks never go there.
 */
export function chargeItems(tableName: string, charge: WorkspaceCharge, limits: { member: number; organization: number }, taskId: string, chargedAt: string = new Date().toISOString()): TransactItems {
  return [
    { Update: {
      TableName: tableName,
      Key: charge.organization,
      UpdateExpression: "SET #count = if_not_exists(#count, :zero) + :one, entityType = :entity",
      ConditionExpression: "attribute_not_exists(#count) OR #count < :limit",
      ExpressionAttributeNames: { "#count": "count" },
      ExpressionAttributeValues: { ":zero": 0, ":one": 1, ":limit": limits.organization, ":entity": entityOf(charge.organization) },
    } },
    { Update: {
      TableName: tableName,
      Key: charge.member,
      UpdateExpression: "SET #count = if_not_exists(#count, :zero) + :one, entityType = :entity",
      ConditionExpression: "(attribute_not_exists(#count) OR #count < :limit) AND NOT contains(#tasks, :taskId)",
      ExpressionAttributeNames: { "#count": "count", "#tasks": "tasks" },
      ExpressionAttributeValues: { ":zero": 0, ":one": 1, ":limit": limits.member, ":entity": entityOf(charge.member), ":taskId": taskId },
    } },
    { Put: {
      TableName: tableName,
      Item: { ...chargeMarkerKey(charge, taskId), entityType: LIMIT_TASK_ENTITY, taskId, memberSk: charge.member.sk, chargedAt },
      ConditionExpression: "attribute_not_exists(pk)",
    } },
  ];
}

/**
 * Releases what chargeItems (or the old set form) took. The caller's transaction also marks the task closed, once. `form` is what `chargeFormOf` read:
 *  - `marker`: positions 0 (organization), 1 (member) and 2 (the marker, which must still exist): a repeated release fails at the marker instead of
 *    decrementing twice.
 *  - `set` (a task charged before markers, or one already released): positions 0 and 1, the member's condition requiring the task in the old `tasks` set,
 *    which the update deletes it from, exactly as before.
 * Callers classify a `TransactionCanceledException` with releaseConflict, passing the same form.
 */
export function releaseItems(tableName: string, charge: WorkspaceCharge, taskId: string, form: ChargeForm): TransactItems {
  const organization = { Update: {
    TableName: tableName,
    Key: charge.organization,
    UpdateExpression: "SET #count = #count - :one",
    ConditionExpression: "#count >= :one",
    ExpressionAttributeNames: { "#count": "count" },
    ExpressionAttributeValues: { ":one": 1 },
  } };
  if (form === "marker") {
    return [
      organization,
      { Update: {
        TableName: tableName,
        Key: charge.member,
        UpdateExpression: "SET #count = #count - :one",
        ConditionExpression: "#count >= :one",
        ExpressionAttributeNames: { "#count": "count" },
        ExpressionAttributeValues: { ":one": 1 },
      } },
      { Delete: { TableName: tableName, Key: chargeMarkerKey(charge, taskId), ConditionExpression: "attribute_exists(pk)" } },
    ];
  }
  return [
    organization,
    { Update: {
      TableName: tableName,
      Key: charge.member,
      UpdateExpression: "SET #count = #count - :one DELETE #tasks :task",
      ConditionExpression: "#count >= :one AND contains(#tasks, :taskId)",
      ExpressionAttributeNames: { "#count": "count", "#tasks": "tasks" },
      ExpressionAttributeValues: { ":one": 1, ":task": new Set([taskId]), ":taskId": taskId },
    } },
  ];
}

const readItem = async (client: Client, tableName: string, key: CounterKey): Promise<Record<string, unknown> | undefined> =>
  ((await client.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;

const hasMarker = async (client: Client, tableName: string, charge: Pick<WorkspaceCharge, "member">, taskId: string): Promise<boolean> =>
  (await readItem(client, tableName, chargeMarkerKey(charge, taskId)))?.["entityType"] === LIMIT_TASK_ENTITY;

/** Whether the member counter's old `tasks` set holds the task. */
const inOldSet = async (client: Client, tableName: string, member: CounterKey, taskId: string): Promise<boolean> => {
  const tasks = (await readItem(client, tableName, member))?.["tasks"];
  return tasks instanceof Set && tasks.has(taskId);
};

/**
 * Which form to release a task's charge in: `marker` when its marker exists, else `set` (the old form; a task in neither form was already released,
 * and the set form's condition then fails as a repeated release always did). A consistent read, made just before the release's transaction.
 */
export async function chargeFormOf(client: Client, tableName: string, charge: Pick<WorkspaceCharge, "member">, taskId: string): Promise<ChargeForm> {
  return (await hasMarker(client, tableName, charge, taskId)) ? "marker" : "set";
}

/** Whether the task still holds a slot of this member counter, in either form. */
export async function isTaskCharged(client: Client, tableName: string, charge: Pick<WorkspaceCharge, "member">, taskId: string): Promise<boolean> {
  return (await hasMarker(client, tableName, charge, taskId)) || (await inOldSet(client, tableName, charge.member, taskId));
}

/**
 * The tasks that hold a slot of this member counter, in either form: the old `tasks` set and the markers that name this counter. A marker with no
 * `memberSk` (written by Code's core before it named one) counts only on a per-member partition (`DEVELOPER_LIMIT#`), where the key alone is the member's.
 * At most `limit` ids, in no particular order.
 */
export async function chargedTaskIds(client: Client, tableName: string, member: CounterKey, limit = 1_000): Promise<string[]> {
  const ids = new Set<string>();
  const tasks = (await readItem(client, tableName, member))?.["tasks"];
  if (tasks instanceof Set) for (const id of tasks) if (typeof id === "string") ids.add(id);
  let start: Record<string, unknown> | undefined;
  do {
    const page = (await client.send(new QueryCommand({
      TableName: tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ConsistentRead: true,
      ExpressionAttributeValues: { ":pk": member.pk, ":prefix": LIMIT_TASK_SK_PREFIX }, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    }))) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      if (item["entityType"] !== LIMIT_TASK_ENTITY || typeof item["taskId"] !== "string") continue;
      const memberSk = item["memberSk"];
      if (memberSk === member.sk || (memberSk === undefined && !isSlackLimitPk(member.pk))) ids.add(item["taskId"]);
    }
    start = page.LastEvaluatedKey;
  } while (start !== undefined && ids.size < limit);
  return [...ids].slice(0, limit);
}

/**
 * Which counter is full, read before the start's transaction so the refusal can say so. `alsoCounted.member` is the person's counter on the core's family (D3,
 * cloud/rows/core-rows.ts CORE_LIMIT_FAMILY): the core marks each task it charges with a `TASK#<id>` row beside that counter. Since S2 Cloud's own tasks write such rows too, but only beside the counter they
 * charge: where that is this same counter nothing is added (below), and where it is a Slack counter its rows are in another partition, so the rows read here are exactly the person's core tasks. A start on Cloud's path counts them too, whichever family it charges itself. Where the person's counter on Cloud's
 * path IS that row (a developer with no Slack link), the core's tasks are already in its count and nothing is added. The company's counter is not read across families:
 * Cloud's non-Slack tasks and the core's share it already.
 */
export async function limitReached(
  client: Client, tableName: string, charge: WorkspaceCharge, limits: { member: number; organization: number },
  alsoCounted?: { member?: CounterKey },
): Promise<"member" | "organization" | undefined> {
  const count = async (key: CounterKey) => {
    const response = await client.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true })) as { Item?: { count?: unknown } };
    return typeof response.Item?.count === "number" ? response.Item.count : 0;
  };
  const coreMarkers = async (member: CounterKey): Promise<number> => {
    if (member.pk === charge.member.pk && member.sk === charge.member.sk) return 0;
    const response = await client.send(new QueryCommand({
      TableName: tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": member.pk, ":prefix": "TASK#" }, ConsistentRead: true,
    })) as { Items?: unknown[] };
    return response.Items?.length ?? 0;
  };
  const held = await count(charge.member) + (alsoCounted?.member === undefined ? 0 : await coreMarkers(alsoCounted.member));
  if (held >= limits.member) return "member";
  if (await count(charge.organization) >= limits.organization) return "organization";
  return undefined;
}

const cancellationReasons = (error: unknown): Array<{ Code?: string }> | undefined => {
  if (!(error instanceof Error) || error.name !== "TransactionCanceledException") return undefined;
  const reasons = (error as { CancellationReasons?: unknown }).CancellationReasons;
  return Array.isArray(reasons) ? reasons as Array<{ Code?: string }> : undefined;
};

const conditionFailed = (reasons: Array<{ Code?: string }>, position: number): boolean => reasons[position]?.Code === "ConditionalCheckFailed";

export type ChargeConflict = "already_charged" | "member" | "organization";

/**
 * Classifies a `chargeItems` transaction's `TransactionCanceledException`, so a caller can tell a repeat charge of the same task (already applied; treat
 * as success) apart from a genuine limit refusal. Reads `error.CancellationReasons` by position ([organization, member, marker]).
 *
 * The repeat check comes first and wins outright: when a task was already charged, its marker (or, for a task charged before markers, the member's
 * `tasks` condition) fails regardless of the counters' state, and by the time a caller retries some other member may have pushed the organization to its
 * limit too. So: a failed marker whose marker a re-read finds, or a failed member item whose task a re-read finds in the old set, is "already_charged",
 * whatever the organization item says. Only then does the organization item's failure mean "organization" full, and the member item's own failure
 * "member" full. Anything else (no CancellationReasons, or no charge item failed) is rethrown as the caller's exact error object, never a wrapper:
 * developer-tasks.ts's chargeFailure tells "not a charge failure" apart from a failed re-read by identity.
 */
export async function chargeConflict(client: Client, tableName: string, charge: WorkspaceCharge, taskId: string, error: unknown): Promise<ChargeConflict> {
  const reasons = cancellationReasons(error);
  if (reasons === undefined) throw error;
  const memberFailed = conditionFailed(reasons, 1);
  if (conditionFailed(reasons, 2) && (await hasMarker(client, tableName, charge, taskId))) return "already_charged";
  if (memberFailed && (await inOldSet(client, tableName, charge.member, taskId))) return "already_charged";
  if (conditionFailed(reasons, 0)) return "organization";
  if (memberFailed) return "member";
  throw error;
}

export type ReleaseConflict = "already_released";

/**
 * Classifies a `releaseItems` transaction's `TransactionCanceledException` for the form it was built in. A repeat release fails at the marker (marker
 * form) or at the member's `contains` (set form). A consistent re-read must then find the task in neither form before this says "already_released":
 * a task still charged (or one the migration moved from the set to a marker between the form read and the release) is the caller's error to retry,
 * rethrown as the same object. Anything else is rethrown too.
 */
export async function releaseConflict(client: Client, tableName: string, charge: WorkspaceCharge, taskId: string, error: unknown, form: ChargeForm): Promise<ReleaseConflict> {
  const reasons = cancellationReasons(error);
  if (reasons === undefined || !conditionFailed(reasons, form === "marker" ? 2 : 1)) throw error;
  if (await isTaskCharged(client, tableName, charge, taskId)) throw error;
  return "already_released";
}
