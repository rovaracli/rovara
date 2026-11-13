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

/**
 * The same conditions as a Slack thread's charge. The task goes in a string set `tasks`; the
 * Slack limit refusal reads every `threads` entry as a thread subject, so tasks never go there.
 *
 * Self-guarding (fix round 1): the member item's condition also requires `NOT contains(#tasks,
 * :taskId)`, so a repeated charge of the same task cancels the whole transaction instead of
 * incrementing the count a second time. Callers classify a `TransactionCanceledException` with
 * chargeConflict.
 */
export function chargeItems(tableName: string, charge: WorkspaceCharge, limits: { member: number; organization: number }, taskId: string): TransactItems {
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
      UpdateExpression: "SET #count = if_not_exists(#count, :zero) + :one, entityType = :entity ADD #tasks :task",
      ConditionExpression: "(attribute_not_exists(#count) OR #count < :limit) AND NOT contains(#tasks, :taskId)",
      ExpressionAttributeNames: { "#count": "count", "#tasks": "tasks" },
      ExpressionAttributeValues: { ":zero": 0, ":one": 1, ":limit": limits.member, ":entity": entityOf(charge.member), ":task": new Set([taskId]), ":taskId": taskId },
    } },
  ];
}

/**
 * Releases what chargeItems took. The caller's transaction also marks the task closed, once.
 *
 * Self-guarding (fix round 1): the member item's condition also requires `contains(#tasks,
 * :taskId)`, so a repeated release of the same task (the task is no longer in the set) cancels
 * the whole transaction instead of decrementing the count a second time. Callers classify a
 * `TransactionCanceledException` with releaseConflict.
 */
export function releaseItems(tableName: string, charge: WorkspaceCharge, taskId: string): TransactItems {
  return [
    { Update: {
      TableName: tableName,
      Key: charge.organization,
      UpdateExpression: "SET #count = #count - :one",
      ConditionExpression: "#count >= :one",
      ExpressionAttributeNames: { "#count": "count" },
      ExpressionAttributeValues: { ":one": 1 },
    } },
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

/**
 * Which counter is full, read before the start's transaction so the refusal can say so. `alsoCounted.member` is the person's counter on the core's family (D3,
 * cloud/rows/core-rows.ts CORE_LIMIT_FAMILY): the core marks each task it charges with a `TASK#<id>` row beside that counter, and Cloud's own tasks never write one, so
 * those markers are exactly the person's core tasks. A start on Cloud's path counts them too, whichever family it charges itself. Where the person's counter on Cloud's
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

const hasTask = async (client: Client, tableName: string, member: CounterKey, taskId: string): Promise<boolean> => {
  const response = await client.send(new GetCommand({ TableName: tableName, Key: member, ConsistentRead: true })) as { Item?: { tasks?: Set<string> } };
  return response.Item?.tasks?.has(taskId) === true;
};

export type ChargeConflict = "already_charged" | "member" | "organization";

/**
 * Classifies a `chargeItems` transaction's `TransactionCanceledException`, so a caller (Tasks 8 and
 * 12) can tell a repeat charge of the same task (already applied; treat as success) apart from a
 * genuine limit refusal. Reads `error.CancellationReasons` positionally, the way
 * packages/broker/src/developer/store.ts's classifyRotationFailure does (chargeItems' TransactItems
 * are [organization, member], in that order).
 *
 * The repeat check comes first and wins outright (fix round 2): when a task was already charged,
 * the member item's condition fails regardless of the organization's state, and by the time a
 * caller retries, some other member may well have since pushed the organization item to its own
 * limit too -- both items can report ConditionalCheckFailed at once. Checking the organization
 * first (as fix round 1 did) would then wrongly refuse a task that already holds its slot. So: if
 * the member item failed and a re-read shows the task is already in `tasks`, that is
 * "already_charged", whatever the organization item says. Only once that is ruled out does the
 * organization item's failure mean "organization" full, and the member item's own failure (not a
 * repeat) mean "member" full. Anything else -- a missing CancellationReasons array, or neither item
 * reporting ConditionalCheckFailed -- is an unmodeled failure and is rethrown, not folded into any
 * outcome, so the caller can retry.
 */
export async function chargeConflict(client: Client, tableName: string, charge: WorkspaceCharge, taskId: string, error: unknown): Promise<ChargeConflict> {
  const reasons = cancellationReasons(error);
  // Rethrow the caller's exact error object, never a wrapper: developer-tasks.ts's chargeFailure
  // tells "not a charge failure" apart from a failed re-read by comparing identity.
  if (reasons === undefined) throw error;
  const memberFailed = reasons[1]?.Code === "ConditionalCheckFailed";
  if (memberFailed && (await hasTask(client, tableName, charge.member, taskId))) return "already_charged";
  if (reasons[0]?.Code === "ConditionalCheckFailed") return "organization";
  if (memberFailed) return "member";
  // The same exact error object, for chargeFailure's identity check (see above).
  throw error;
}

export type ReleaseConflict = "already_released";

/**
 * Classifies a `releaseItems` transaction's `TransactionCanceledException`. The member item's
 * `contains(#tasks, :taskId)` clause no longer holds once a first release has already removed the
 * task, so a repeat release fails there; a consistent re-read confirms the task is genuinely gone
 * before reporting "already_released", rather than folding some other, unmodeled member-condition
 * failure into it. Anything else is rethrown so the caller can retry.
 */
export async function releaseConflict(client: Client, tableName: string, charge: WorkspaceCharge, taskId: string, error: unknown): Promise<ReleaseConflict> {
  const reasons = cancellationReasons(error);
  if (reasons === undefined || reasons[1]?.Code !== "ConditionalCheckFailed") throw error;
  if (await hasTask(client, tableName, charge.member, taskId)) throw error;
  return "already_released";
}
