// Plan 3, Task 22: an operation of an agent-step run ended without the worker's result reaching the broker (the dispatcher gave up delivering it, the compute
// was lost, a cancel was stuck). The run is not told by a callback, so the end writes the run's dispatch row, due at once: the engine reads the operation and
// goes on. Best effort, as `blockFailedWorkflowRun` is for a workflow task: a lost write is the row's own watchdog's to make up.
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { agentRunDispatchItem } from "./broker-shared.js";
import { taskAgentRunKey, taskKey, taskPointerKey } from "../developer/task-records.js";

type Client = { send(command: unknown): Promise<unknown> };

export async function wakeAgentRun(client: Client, tableName: string, workspaceId: string, operationId: string): Promise<void> {
  try {
    const read = async <T>(key: { pk: string; sk: string }): Promise<T | undefined> => ((await client.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }))) as { Item?: T }).Item;
    const operation = await read<{ kind?: unknown; workflowMode?: unknown; programStepId?: unknown }>({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}` });
    if (operation === undefined) return;
    const isStep = operation.kind === "task" && operation.workflowMode === undefined && typeof operation.programStepId === "string";
    if (!isStep && operation.kind !== "prepare") return;
    const pointer = await read<{ taskId?: unknown }>(taskPointerKey(workspaceId));
    if (typeof pointer?.taskId !== "string") return;
    const [task, run] = await Promise.all([read<{ orgId?: unknown }>(taskKey(pointer.taskId)), read<{ orgId?: unknown; revision?: unknown }>(taskAgentRunKey(pointer.taskId))]);
    if (task === undefined || run === undefined || typeof run.orgId !== "string" || run.orgId !== task.orgId || typeof run.revision !== "number") return;
    const now = new Date().toISOString();
    const row = agentRunDispatchItem(tableName, { taskId: pointer.taskId, orgId: run.orgId, revision: run.revision, dueAt: now, now, operationId }) as { Put: { Item: Record<string, unknown> } };
    await client.send(new PutCommand({ TableName: tableName, Item: row.Put.Item }));
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "agent_run.wake_failed", operationId, error: error instanceof Error ? error.name : "unknown" }));
  }
}

/**
 * The in-transaction form, for the broker's own terminal-result path: the dispatch row for an agent-step run's operation that is ending (a step, the
 * preparation, or the step a successful cancel stopped), for the same transaction as the result. Empty for any other operation.
 */
export async function agentRunWakeItems(
  client: Client, tableName: string, operation: { kind: string; workflowMode?: unknown; programStepId?: unknown; id: string; workspaceId: string; targetOperationId?: string },
  taskId: string, now: string,
): Promise<Array<{ Put: { TableName: string; Item: Record<string, unknown> } }>> {
  const read = async <T>(key: { pk: string; sk: string }): Promise<T | undefined> => ((await client.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }))) as { Item?: T }).Item;
  let ending = operation;
  if (operation.kind === "cancel" && operation.targetOperationId !== undefined) {
    const target = await read<typeof operation>({ pk: `WORKSPACE#${operation.workspaceId}`, sk: `OPERATION#${operation.targetOperationId}` });
    if (target === undefined) return [];
    ending = { ...target, id: operation.targetOperationId };
  }
  const isStep = ending.kind === "task" && ending.workflowMode === undefined && typeof ending.programStepId === "string";
  if (!isStep && ending.kind !== "prepare") return [];
  const [task, run] = await Promise.all([read<{ orgId?: unknown }>(taskKey(taskId)), read<{ orgId?: unknown; revision?: unknown }>(taskAgentRunKey(taskId))]);
  if (task === undefined || run === undefined || typeof run.orgId !== "string" || run.orgId !== task.orgId || typeof run.revision !== "number") return [];
  return [agentRunDispatchItem(tableName, { taskId, orgId: run.orgId, revision: run.revision, dueAt: now, now, operationId: ending.id }) as { Put: { TableName: string; Item: Record<string, unknown> } }];
}
