// Live steer: what happens at the broker when a step stopped because the owner's live message asked for a change outside the approved plan. The worker ended the step with the fixed words
// `WORKFLOW_LIVE_STEER_REAPPROVAL_MESSAGE` followed by the ids of the owner's messages it had been given (server-made ids, never text). The step's own result blocks the workflow with a fixed
// reason (the owner decides: Understand and Plan retry with the message and the new plan is approved; Coding retries the approved plan without the change, or a new task asks for it); this marks each of those messages `needs re-approval` on its row and says so on the session's timeline. It never
// throws (the block is already committed) and no log line, event or row holds a message's text.
import { WORKFLOW_BLOCK_REASONS, WORKFLOW_LIVE_STEER_REAPPROVAL_MESSAGE } from "@agentx/contracts";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { taskKey, type DeveloperTaskRecord } from "../developer/task-records.js";
import { markSteerNeedsReapproval, type SteerDependencies } from "./steer.js";

/** The most messages one stop marks (the worker names at most five). */
const MARK_MAX = 5;

/** The ids of the owner's messages a stopped step's error names, oldest first, without repeats. Empty when the error is not a re-approval stop. */
export function reapprovalMessageIds(error: string | undefined): string[] {
  if (error === undefined || !error.includes(WORKFLOW_LIVE_STEER_REAPPROVAL_MESSAGE)) return [];
  return [...new Set(error.match(/msg_[0-9a-z]{20}/gu) ?? [])].slice(0, MARK_MAX);
}

/** Marks the messages a stopped step's error names. Answers how many it marked. */
export async function settleLiveSteerReapproval(deps: SteerDependencies, taskId: string, error: string | undefined): Promise<number> {
  const ids = reapprovalMessageIds(error);
  if (ids.length === 0) return 0;
  try {
    const task = ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: taskKey(taskId), ConsistentRead: true }))) as { Item?: DeveloperTaskRecord }).Item;
    if (task?.orgId === undefined || task.sessionId === undefined) return 0;
    let marked = 0;
    for (const messageId of ids) if (await markSteerNeedsReapproval(deps, task.orgId, task.sessionId, messageId)) marked += 1;
    await recordLiveSteerChange(deps, task, ids);
    return marked;
  } catch (failure) {
    deps.log?.({ event: "agent_session.steer_reapproval_failed", taskId, error: failure instanceof Error ? failure.name : "unknown" });
    return 0;
  }
}

/**
 * Coding blocked with the revise reason keeps the owner's message ids on the task, bound to the blocked revision, so the owner's "Revise the plan" press plans again with exactly those messages and
 * only for this block (the update is conditional on the workflow still being that block). Ids only, never text. Any other block records nothing. Never throws: without the record the press is refused
 * and Retry coding and Close still work.
 */
async function recordLiveSteerChange(deps: SteerDependencies, task: DeveloperTaskRecord, messageIds: readonly string[]): Promise<void> {
  const workflow = task.workflow;
  if (workflow === undefined || workflow.stage !== "IMPLEMENT" || workflow.state !== "BLOCKED" || workflow.blockReason !== WORKFLOW_BLOCK_REASONS.liveSteerReapprovalRevise) return;
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: taskKey(task.taskId), UpdateExpression: "SET liveSteerChange = :change",
      ConditionExpression: "workflow.revision = :revision AND workflow.#stage = :stage AND workflow.#state = :blocked AND attribute_not_exists(closedAt)",
      ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
      ExpressionAttributeValues: { ":change": { workflowRevision: workflow.revision, messageIds: [...messageIds], at: new Date(deps.now()).toISOString() }, ":revision": workflow.revision, ":stage": "IMPLEMENT", ":blocked": "BLOCKED" },
    }));
  } catch (failure) {
    // The workflow moved on meanwhile (nothing to record), or the write failed: only the error's name is logged.
    if (!(failure instanceof Error && failure.name === "ConditionalCheckFailedException")) deps.log?.({ event: "agent_session.steer_change_record_failed", taskId: task.taskId, error: failure instanceof Error ? failure.name : "unknown" });
  }
}
