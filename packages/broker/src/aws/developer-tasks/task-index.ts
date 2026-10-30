import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { PER_TASK_BUDGET_USD, type DeveloperTaskStatus } from "@agentx/contracts";
import { taskIndexKey, tryEffectiveTaskOwner, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { isConditional } from "../broker-shared.js";
import type { AgentRunResult } from "../../agents/runs.js";
import type { DeveloperTaskRouteDependencies } from "./types.js";
import { iso, log } from "./common.js";

/** The limits of a run as its task record keeps them, for a repeat of the start that finds the task already made. */
export function runResultOf(task: DeveloperTaskRecord): AgentRunResult {
  const runLimitUsd = task.budgetUsd ?? PER_TASK_BUDGET_USD;
  return { taskId: task.taskId, runLimitUsd, stopAtUsd: task.maxPerRunUsd === undefined ? runLimitUsd : Math.min(runLimitUsd, task.maxPerRunUsd), paused: task.budgetPause !== undefined };
}

/**
 * R4: the index row keeps the last status the API saw, so the task list and WORKSPACE_LIMIT's
 * open-task list stay current. Best effort: a failed write only costs a stale index row. A CLOSED
 * row never changes again: a read that derived its status before a close must not undo it.
 * `updatedAt` is the task view's, so the list and the view agree.
 */
/**
 * The task-list row of the person who took the task over, when someone did: the key the creator's row would have with the taker's id (Plan 5 Task 12a; Task 12b writes the row
 * when the take-over is made). Undefined for a task nobody took over, or whose owner can't be read.
 */
export function ownerIndexRowOf(task: DeveloperTaskRecord): { pk: string; sk: string } | undefined {
  const owner = tryEffectiveTaskOwner(task);
  return owner === undefined || owner.developerId === task.developerId ? undefined : taskIndexKey(owner.developerId, task.createdAt, task.taskId);
}

export async function syncIndex(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord, status: DeveloperTaskStatus, updatedAt: string = iso(deps)): Promise<void> {
  // The creator's row and, once someone took the task over, the taker's row too (Plan 5 Task 12a).
  const taker = ownerIndexRowOf(task);
  for (const key of [taskIndexKey(task.developerId, task.createdAt, task.taskId), ...(taker === undefined ? [] : [taker])]) {
    try {
      await deps.documentClient.send(new UpdateCommand({
        TableName: deps.tableName,
        Key: key,
        UpdateExpression: "SET #status = :status, updatedAt = :now",
        ConditionExpression: "attribute_exists(pk) AND #status <> :status AND #status <> :closed",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":status": status, ":closed": "CLOSED", ":now": updatedAt },
      }));
    } catch (error) {
      if (!isConditional(error)) log(deps, { event: "developer.task_index_sync_failed", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" });
    }
  }
}
