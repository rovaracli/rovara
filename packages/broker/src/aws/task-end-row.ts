// Plan 3 Task 22 hand-off, kept by Plan 5 Task 7b: the end of a task that has no operation of its own to come back to (a workflow task that merged or closed, a task
// whose creator was removed, a plain task that was closed after a budget stop) is told once, and when that telling is not finished a durable row brings the recovery
// sweep back to it. The row is the `operation_end` row with `endOf` naming which end; the sweep tells it from the task itself (`runOperationEndDispatch`).
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { END_LEASE_MS } from "../agents/task-end.js";
import type { DeveloperTaskRecord } from "../developer/task-records.js";
import { operationEndDispatchItem, type TaskEndRowKind } from "./broker-shared.js";

/**
 * Leaves the row for an end that is not finished: `in_progress` (another call holds it and may die with it) is due again when that call's lease could have run out;
 * `failed` (a handler threw, or the end could not be recorded) is due in a minute and then backs off. Never throws: a lost write leaves the next call that reaches the
 * task's end (and a replay of the ending) to tell it.
 */
export async function leaveTaskEndRow(
  deps: { tableName: string; documentClient: { send(command: unknown): Promise<unknown> } },
  task: Pick<DeveloperTaskRecord, "taskId" | "orgId" | "workspaceId">,
  endOf: TaskEndRowKind,
  told: "in_progress" | "failed",
): Promise<void> {
  if (task.orgId === undefined) return;
  try {
    const now = Date.now();
    const row = operationEndDispatchItem(deps.tableName, {
      taskId: task.taskId, orgId: task.orgId, workspaceId: task.workspaceId, operationId: endOf, now: new Date(now).toISOString(),
      dueAt: new Date(now + (told === "in_progress" ? END_LEASE_MS + 5_000 : 60_000)).toISOString(), endOf,
    }) as { Put: { Item: Record<string, unknown> } };
    await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: row.Put.Item }));
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "task_end.row_not_left", taskId: task.taskId, endOf, error: error instanceof Error ? error.name : "unknown" }));
  }
}
