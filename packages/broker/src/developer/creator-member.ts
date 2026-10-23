// Plan 2, Task 4 (ruling R60): a person removed from their org stops their running work. A step already running on a worker finishes;
// the next dispatch or publication for any of their tasks re-reads their live member record and refuses here, before any other access
// check, so the refusal names the removal instead of failing later in the project-grant check with "project not found". The task
// then ends with outcome `creator_removed` and that message as its reason. "Removed" is the member record gone with the removal's
// tombstone present (OrgStore writes it in the same transaction): a person with no member record and no tombstone never joined. Their workspaces are left to the idle reaper.
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { OrgIdSchema, agentXError, orgMemberKey, orgMetaKey, orgRemovedKey, type OrgId } from "@agentx/contracts";
import { hasTaskEndHandlers, onTaskEnded } from "../agents/task-end.js";
import { leaveTaskEndRow } from "../aws/task-end-row.js";
import { taskAgentRunKey, taskKey, taskPointerKey, type DeveloperTaskPointerRecord, type DeveloperTaskRecord } from "./task-records.js";

export interface CreatorCheckDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  /** The org to read the membership in when the task record names none (the caller's org on a route). */
  orgId?: OrgId | undefined;
  /** The org a task without a stored `orgId` belongs to (the broker's resolver); undefined for a legacy task that has none. */
  orgOf?: (task: DeveloperTaskRecord) => Promise<OrgId | undefined>;
  now?: () => number;
}

/** The text a removed creator's task ends with. */
export const creatorRemovedMessage = (name: string, orgName: string) => `${name} is no longer a member of ${orgName}, so Rovara stopped this task.`;

async function readConsistent<T>(deps: CreatorCheckDependencies, key: { pk: string; sk: string }): Promise<T | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: T };
  return response.Item;
}

/**
 * Refuses (TASK_ACCESS_DENIED) when the task's creator is no longer a member of the task's org, and records `creator_removed` on the
 * task. Does nothing for a legacy task with no org. Call it first: before `acceptTask`, before minting a token, before any access check.
 */
export async function requireCreatorStillMember(deps: CreatorCheckDependencies, task: DeveloperTaskRecord): Promise<void> {
  const stored = OrgIdSchema.safeParse(task.orgId);
  const orgId = stored.success ? stored.data : deps.orgOf === undefined ? deps.orgId : await deps.orgOf(task);
  if (orgId === undefined) return;
  if (await readConsistent(deps, orgMemberKey(orgId, task.developerId)) !== undefined) return;
  // No member record is not enough: a Slack user who has not signed in yet has none and is not removed. Removal leaves a tombstone.
  if (await readConsistent(deps, orgRemovedKey(orgId, task.developerId)) === undefined) return;
  const org = await readConsistent<{ name?: unknown }>(deps, orgMetaKey(orgId));
  const message = creatorRemovedMessage(task.developerName, typeof org?.name === "string" ? org.name : "the organization");
  try {
    // First removal wins: a repeat leaves the reason and time of the first.
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: taskKey(task.taskId),
      UpdateExpression: "SET #outcome = :outcome, outcomeReason = :reason, outcomeAt = :at",
      ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(#outcome)",
      ExpressionAttributeNames: { "#outcome": "outcome" },
      ExpressionAttributeValues: { ":outcome": "creator_removed", ":reason": message, ":at": new Date((deps.now ?? Date.now)()).toISOString() },
    }));
    await tellRemoved(deps, task);
  } catch (error) {
    if ((error instanceof Error ? error.name : undefined) !== "ConditionalCheckFailedException") throw error;
    // Already recorded by an earlier call: its telling may not have finished, so this call takes it up (told once: Plan 3's TASK_END record, and no row if it was told).
    await tellRemoved(deps, task);
  }
  throw agentXError("TASK_ACCESS_DENIED", message);
}

/**
 * The task ended because its creator was removed (G7): the end handlers hear it, once. An agent-step run's end is told by its engine, which ends the run
 * right after this check refuses. Never throws: the end is recorded already. An end that is not finished (a handler threw, or another call is telling it) leaves
 * a recovery row (Plan 5 Task 7b, the Task 22 hand-off) that the sweep tells it from, and the next call that reaches the task's end takes it up too.
 */
async function tellRemoved(deps: CreatorCheckDependencies, task: DeveloperTaskRecord): Promise<void> {
  if (!hasTaskEndHandlers()) return;
  let told: "in_progress" | "failed" | undefined;
  try {
    if (task.agent !== undefined && await readConsistent(deps, taskAgentRunKey(task.taskId)) !== undefined) return;
    if (await onTaskEnded({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now ?? Date.now }, task, "creator_removed") === "in_progress") told = "in_progress";
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "task_end.not_told", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" }));
    told = "failed";
  }
  if (told !== undefined) await leaveTaskEndRow(deps, task, "creator_removed", told);
}

/**
 * The same check for a path that holds a workspace rather than a task: the task is found through the workspace's task pointer. A
 * workspace with no task (a plain workspace, not a developer task's) skips the check.
 */
export async function requireWorkspaceCreatorStillMember(deps: CreatorCheckDependencies, workspaceId: string): Promise<void> {
  const pointer = await readConsistent<Pick<DeveloperTaskPointerRecord, "taskId">>(deps, taskPointerKey(workspaceId));
  if (pointer === undefined) return;
  const task = await readConsistent<DeveloperTaskRecord>(deps, taskKey(pointer.taskId));
  if (task === undefined) return;
  await requireCreatorStillMember(deps, task);
}
