// Work events (U3): the one place a Cloud write of a task's workflow adds its events to its own transaction.
//
// `withWorkEvents(deps, items)` takes the items of a transaction about to be sent and returns them with the events of every change of a task's workflow they make, appended at the END (so the positions the
// callers read cancellation reasons by do not move). The events then commit with the change or not at all, and a change that does not commit leaves none.
//
// Rules this keeps:
//  - Off unless the install turned it on (`deps.workEvents`, named environments only, where the State table has its TTL): everything else is returned as it came, with no read.
//  - An event never makes a change fail: no condition on its row, and any trouble (a read that failed, an item that is not valid, a transaction already too big) returns the items as they came, with a log line.
//  - An event is true: the before-snapshot is read now and counts only when its revision is the one the change's own condition names, so a change that is going to be refused for a lost race does not
//    describe a transition that did not happen.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { WorkflowSnapshotSchema, type OrgId, type WorkEventInput, type WorkflowSnapshot } from "@agentx/contracts";
import { workEventsOfTransition } from "./transition.js";
import { workEventPutItem, type TransactItems } from "./store.js";

/** DynamoDB's most items in one transaction. */
export const WORK_EVENT_TRANSACTION_ITEMS_MAX = 100;

export interface WorkEventsRuntime {
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}
export interface WorkEventDeps {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  /** Present only where the install writes work events. */
  workEvents?: WorkEventsRuntime | undefined;
}

const TASK_PK = /^DEVTASK#[0-9a-f-]{36}$/u;
const CODE = /^[a-z][a-z0-9_.-]{0,59}$/u;
const logOf = (deps: WorkEventDeps) => (entry: Record<string, unknown>): void => (deps.workEvents?.log ?? ((line) => console.log(JSON.stringify({ component: "broker", ...line }))))(entry);

interface TaskFacts { orgId: OrgId | undefined; project: string | undefined; before: WorkflowSnapshot | undefined; origin?: string | undefined }

/** The workflow a task's Update sets, with the revision it expects, or undefined for any other item. */
function workflowUpdate(item: TransactItems[number]): { taskId: string; after: WorkflowSnapshot; expectedRevision: unknown } | undefined {
  const update = item.Update;
  if (update === undefined || update.Key === undefined) return undefined;
  const { pk, sk } = update.Key as { pk?: unknown; sk?: unknown };
  const values = update.ExpressionAttributeValues as Record<string, unknown> | undefined;
  if (typeof pk !== "string" || sk !== "META" || !TASK_PK.test(pk) || values === undefined || typeof values[":workflow"] !== "object" || values[":workflow"] === null) return undefined;
  if (typeof update.UpdateExpression !== "string" || !/^SET workflow = :workflow\b/u.test(update.UpdateExpression)) return undefined;
  const parsed = WorkflowSnapshotSchema.safeParse(values[":workflow"]);
  return parsed.success ? { taskId: pk.slice("DEVTASK#".length), after: parsed.data, expectedRevision: values[":revision"] } : undefined;
}

/** A task Put (the start of a task): its workflow, with no snapshot before. */
function taskStart(item: TransactItems[number]): { after: WorkflowSnapshot; facts: TaskFacts } | undefined {
  const row = item.Put?.Item as Record<string, unknown> | undefined;
  if (row === undefined || row["entityType"] !== "DEVELOPER_TASK" || typeof row["workflow"] !== "object" || row["workflow"] === null) return undefined;
  const parsed = WorkflowSnapshotSchema.safeParse(row["workflow"]);
  if (!parsed.success) return undefined;
  const client = row["client"];
  return { after: parsed.data, facts: { orgId: row["orgId"] as OrgId | undefined, project: typeof row["project"] === "string" ? row["project"] : undefined, before: undefined, ...(typeof client === "string" && CODE.test(client) ? { origin: client } : {}) } };
}

async function readTask(deps: WorkEventDeps, taskId: string): Promise<TaskFacts | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: { pk: `DEVTASK#${taskId}`, sk: "META" }, ConsistentRead: true })) as { Item?: Record<string, unknown> };
  const row = response.Item;
  if (row === undefined) return undefined;
  const workflow = WorkflowSnapshotSchema.safeParse(row["workflow"]);
  return { orgId: row["orgId"] as OrgId | undefined, project: typeof row["project"] === "string" ? row["project"] : undefined, before: workflow.success ? workflow.data : undefined };
}

/** The events the transaction's own changes make (empty when there are none, the install has them off, or anything is unclear). */
export async function workEventsOfItems(deps: WorkEventDeps, items: TransactItems): Promise<WorkEventInput[]> {
  if (deps.workEvents === undefined) return [];
  const log = logOf(deps);
  const events: WorkEventInput[] = [];
  for (const item of items) {
    try {
      const start = taskStart(item);
      if (start !== undefined) {
        if (start.facts.orgId !== undefined && start.facts.project !== undefined) events.push(...workEventsOfTransition({ orgId: start.facts.orgId, project: start.facts.project, before: undefined, after: start.after, origin: start.facts.origin }));
        continue;
      }
      const update = workflowUpdate(item);
      if (update === undefined) continue;
      const task = await readTask(deps, update.taskId);
      // Only a change that follows from the snapshot we read: its own condition names that revision. A task with no readable workflow before is not described (its events would be a guess).
      if (task === undefined || task.orgId === undefined || task.project === undefined || task.before === undefined) continue;
      if (update.expectedRevision !== undefined && update.expectedRevision !== task.before.revision) continue;
      events.push(...workEventsOfTransition({ orgId: task.orgId, project: task.project, before: task.before, after: update.after }));
    } catch (error) {
      log({ event: "work_event.skipped", reason: "derive_failed", error: error instanceof Error ? error.name : "unknown" });
    }
  }
  return events;
}

/** The transaction's items with the events of its changes added at the end. Never throws; returns the items as given when there is nothing to add or no room. */
export async function withWorkEvents(deps: WorkEventDeps, items: TransactItems): Promise<TransactItems> {
  if (deps.workEvents === undefined) return items;
  try {
    const events = await workEventsOfItems(deps, items);
    if (events.length === 0) return items;
    // One row per distinct event: two events of one change with the same id would be one item twice, which a transaction refuses.
    const distinct = [...new Map(events.map((event) => [event.id, event])).values()];
    if (items.length + distinct.length > WORK_EVENT_TRANSACTION_ITEMS_MAX) {
      logOf(deps)({ event: "work_event.skipped", reason: "transaction_full", items: items.length, events: distinct.length });
      return items;
    }
    return [...items, ...distinct.map((event) => workEventPutItem(deps.tableName, event))];
  } catch (error) {
    logOf(deps)({ event: "work_event.skipped", reason: "emit_failed", error: error instanceof Error ? error.name : "unknown" });
    return items;
  }
}
