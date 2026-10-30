// Live steer: what happens at the broker when a step stopped because the owner's live message asked for a change outside the approved plan. The worker ended the step with the fixed words
// `WORKFLOW_LIVE_STEER_REAPPROVAL_MESSAGE` followed by the ids of the owner's messages it had been given (server-made ids, never text). The step's own result blocks the workflow with a fixed
// reason (the owner decides: retry, or send back with the change in a note); this marks each of those messages `needs re-approval` on its row and says so on the session's timeline. It never
// throws (the block is already committed) and no log line, event or row holds a message's text.
import { WORKFLOW_LIVE_STEER_REAPPROVAL_MESSAGE } from "@agentx/contracts";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
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
    return marked;
  } catch (failure) {
    deps.log?.({ event: "agent_session.steer_reapproval_failed", taskId, error: failure instanceof Error ? failure.name : "unknown" });
    return 0;
  }
}
