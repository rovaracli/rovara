import { installOrgIdFromEnvironment } from "../org/resolve.js";
// Issue #213: a workspace whose preparation failed stops counting toward the workspace limits at
// once. Every writer that moves a workspace to PREPARATION_FAILED calls releaseFailedPreparation
// after its own transaction commits. The release gives back the charge the workspace's owner took:
// a Slack thread's starter charge (its member and organization counters, marked by the thread
// record's starterUserId), or a developer task's charge (the counters stored on the task, marked by
// the task in the member counter's `tasks` set). Each marker is removed in the same transaction
// that decrements, so a repeated release, or a later close, never gives the slot back twice.
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { type OrgId, OrgIdSchema, parseSlackThreadSubject, slackMemberLimitKey, slackOrganizationLimitKey } from "@agentx/contracts";
import { releaseConflict, releaseItems } from "../developer/limits.js";
import { taskKey, taskPointerKey, type DeveloperTaskRecord, type DeveloperTaskPointerRecord } from "../developer/task-records.js";

type Client = { send(command: unknown): Promise<unknown> };
type Log = (entry: Record<string, unknown>) => void;

/** "failed": the release could not land, and the slot stays held (logged). */
export type FailedPreparationRelease = "released" | "not_charged" | "not_failed" | "failed";

/** Fresh reads and one transaction per attempt; a counter another request moved meanwhile is read again. */
const RELEASE_ATTEMPTS = 4;

const defaultLog: Log = (entry) => console.log(JSON.stringify({ component: "broker", ...entry }));

import { resolveSlackThreadKey } from "./slack-thread-key.js";
export { slackThreadKey } from "./slack-thread-key.js";

interface FailedWorkspace { orgId?: unknown; ownerKey?: unknown; status?: unknown; activeOperationId?: unknown; fence?: unknown }
/** `orgId` is the org whose Slack team counters the thread was charged to, stamped when it was charged. */
interface ThreadRecord { thread?: unknown; starterUserId?: unknown; closedAt?: unknown; orgId?: unknown }

/**
 * Releases the charge a PREPARATION_FAILED workspace still holds, idempotently. Never throws: the
 * caller's own transaction already committed, so a release that cannot land is logged (IDs and the
 * error's name only) and the slot stays held, as it did before #213; the thread's next message then
 * retries under that charge.
 */
export async function releaseFailedPreparation(client: Client, tableName: string, workspaceId: string, log: Log = defaultLog, installOrg: OrgId = installOrgIdFromEnvironment()): Promise<FailedPreparationRelease> {
  try {
    for (let attempt = 0; attempt < RELEASE_ATTEMPTS; attempt += 1) {
      const outcome = await attemptRelease(client, tableName, workspaceId, installOrg);
      if (outcome === "retry") continue;
      if (outcome === "slack_thread" || outcome === "developer_task") {
        log({ event: "workspace.preparation_failed_released", workspaceId, owner: outcome });
        return "released";
      }
      return outcome;
    }
    log({ event: "workspace.preparation_failed_release_failed", workspaceId, error: "ReleaseConflict" });
  } catch (error) {
    log({ event: "workspace.preparation_failed_release_failed", workspaceId, error: error instanceof Error ? error.name : "unknown" });
  }
  return "failed";
}

async function attemptRelease(client: Client, tableName: string, workspaceId: string, installOrg: OrgId): Promise<"slack_thread" | "developer_task" | "not_charged" | "not_failed" | "retry"> {
  const get = async <T>(key: { pk: string; sk: string }) =>
    ((await client.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }))) as { Item?: T }).Item;
  const workspace = await get<FailedWorkspace>({ pk: `WORKSPACE#${workspaceId}`, sk: "META" });
  if (workspace?.status !== "PREPARATION_FAILED" || workspace.activeOperationId !== undefined || typeof workspace.fence !== "number" || typeof workspace.ownerKey !== "string") {
    return "not_failed";
  }
  // Holds only while the workspace is still the failed one read here: a retry that started meanwhile
  // (a new fence, an active operation) owns the charge from then on.
  const stillFailed = { ConditionCheck: {
    TableName: tableName,
    Key: { pk: `WORKSPACE#${workspaceId}`, sk: "META" },
    ConditionExpression: "#status = :failed AND attribute_not_exists(activeOperationId) AND fence = :fence",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: { ":failed": "PREPARATION_FAILED", ":fence": workspace.fence },
  } };

  const org = OrgIdSchema.safeParse(workspace.orgId ?? installOrg);
  const threadKey = org.success ? await resolveSlackThreadKey({ documentClient: client, tableName }, org.data, workspace.ownerKey, installOrg) : undefined;
  const thread = threadKey === undefined ? undefined : await get<ThreadRecord>(threadKey);
  if (threadKey !== undefined && thread !== undefined && typeof thread.starterUserId === "string" && thread.closedAt === undefined && typeof thread.thread === "string") {
    return releaseThreadCharge(client, tableName, get, { subject: thread.thread, starterUserId: thread.starterUserId, ownerKey: workspace.ownerKey, orgId: thread.orgId ?? org.data, key: threadKey }, stillFailed);
  }
  // A Slack thread with no charge left falls through: it has no task pointer, so it ends "not_charged".

  const pointer = await get<DeveloperTaskPointerRecord>(taskPointerKey(workspaceId));
  if (pointer === undefined) return "not_charged";
  const task = await get<DeveloperTaskRecord>(taskKey(pointer.taskId));
  if (task === undefined || task.closedAt !== undefined || task.charge === undefined) return "not_charged";
  try {
    // releaseItems first, at positions 0 and 1: releaseConflict reads the cancellation reasons by position.
    await client.send(new TransactWriteCommand({ TransactItems: [...releaseItems(tableName, task.charge, task.taskId), stillFailed] }));
    return "developer_task";
  } catch (error) {
    if (!isCancelled(error)) throw error;
    // The task is no longer in its member counter: an earlier release or a close gave it back.
    try {
      await releaseConflict(client, tableName, task.charge, task.taskId, error);
      return "not_charged";
    } catch {
      return "retry";
    }
  }
}

async function releaseThreadCharge(
  client: Client,
  tableName: string,
  get: <T>(key: { pk: string; sk: string }) => Promise<T | undefined>,
  thread: { subject: string; starterUserId: string; ownerKey: string; orgId: unknown; key: { pk: string; sk: string } },
  stillFailed: Record<string, unknown>,
): Promise<"slack_thread" | "retry"> {
  const { teamId } = parseSlackThreadSubject(thread.subject);
  // The counters sit in the org that charged them; a thread record that names none cannot be released (logged, the slot stays held).
  const orgId = OrgIdSchema.parse(thread.orgId);
  const memberKey = slackMemberLimitKey(orgId, teamId, thread.starterUserId);
  const member = await get<{ count?: unknown; threads?: unknown }>(memberKey);
  const memberCount = typeof member?.count === "number" ? member.count : 0;
  const threads = Array.isArray(member?.threads) ? member.threads as unknown[] : [];
  try {
    await client.send(new TransactWriteCommand({ TransactItems: [
      stillFailed,
      { Update: {
        TableName: tableName,
        Key: thread.key,
        // The charge's marker: the thread's next preparation charges again and records its starter.
        UpdateExpression: "REMOVE starterUserId",
        ConditionExpression: "starterUserId = :user AND attribute_not_exists(closedAt)",
        ExpressionAttributeValues: { ":user": thread.starterUserId },
      } },
      { Update: {
        TableName: tableName,
        Key: slackOrganizationLimitKey(orgId, teamId),
        UpdateExpression: "SET #count = #count - :one",
        ConditionExpression: "#count >= :one",
        ExpressionAttributeNames: { "#count": "count" },
        ExpressionAttributeValues: { ":one": 1 },
      } },
      { Update: {
        TableName: tableName,
        Key: memberKey,
        // As the thread close does: the count read here, so the threads list written with it is current.
        UpdateExpression: "SET #count = :next, #threads = :threads",
        ConditionExpression: "#count = :current AND #count >= :one",
        ExpressionAttributeNames: { "#count": "count", "#threads": "threads" },
        ExpressionAttributeValues: { ":next": memberCount - 1, ":current": memberCount, ":one": 1, ":threads": threads.filter((entry) => entry !== thread.subject) },
      } },
    ] }));
    return "slack_thread";
  } catch (error) {
    if (!isCancelled(error)) throw error;
    return "retry";
  }
}

const isCancelled = (error: unknown): error is Error => error instanceof Error && error.name === "TransactionCanceledException";
