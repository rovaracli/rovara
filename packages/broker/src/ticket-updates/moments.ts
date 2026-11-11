// Slice 5 "Outside tools": the three moments the milestone hook did not have yet, written as milestones so the ticket updates handler hears them with the hook's own claims and retries:
//   - `started`: intake started a task from a ticket (called after the start, by the intake wiring);
//   - `plan_ready`: the task's plan waits for review (PLAN_REVIEW / WAITING), read from the task after a worker's result committed; one per workflow revision;
//   - `closed`: the task ended without a merge (a task end handler; a merge has its own `merged` milestone).
// Each is written only for a task whose session follows a ticket (a `tracker_item` binding), so no other task gains an item. The milestone names no session, so nothing is added to the session's
// timeline. Every function here is best effort and never throws: the work it follows stands without it.
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { OrgId } from "@rovara-code/contracts";
import type { TaskEndHandler } from "../agents/task-end.js";
import { codeMilestoneItems, deliverCodeMilestones } from "../rovara-code/milestones.js";
import { sessionBindingsOf } from "../rovara-code/session-bindings.js";

export interface MomentTable {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
  log?: ((event: string, fields: Record<string, unknown>) => void) | undefined;
}

const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");
const log = (table: MomentTable, event: string, fields: Record<string, unknown>) => (table.log ?? ((name, detail) => console.log(JSON.stringify({ component: "broker", event: name, ...detail }))))(event, fields);

async function followsTicket(table: MomentTable, orgId: OrgId, sessionId: string | undefined): Promise<boolean> {
  return (await sessionBindingsOf(table, orgId, sessionId)).some((binding) => binding.kind === "tracker_item");
}

async function writeMoment(table: MomentTable, input: { kind: "started" | "plan_ready" | "closed"; orgId: OrgId; taskId: string; n: number; text: string; definitionVersion?: string }): Promise<void> {
  const items = codeMilestoneItems(table, { kind: input.kind, orgId: input.orgId, taskId: input.taskId, at: new Date(table.now()).toISOString(), text: input.text }, input.n,
    input.definitionVersion === undefined ? {} : { definitionVersion: input.definitionVersion });
  if (items.length === 0) return;
  try {
    await table.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (error) {
    // Already written (the same moment again): nothing more to write, and the delivery below tells whoever has not heard it.
    if (errorName(error) !== "TransactionCanceledException") throw error;
  }
  await deliverCodeMilestones(table, input.taskId);
}

/** Intake started a task from a ticket. */
export async function noteTicketTaskStarted(table: MomentTable, input: { orgId: OrgId; taskId: string; sessionId?: string | undefined }): Promise<void> {
  try {
    if (!await followsTicket(table, input.orgId, input.sessionId)) return;
    await writeMoment(table, { kind: "started", orgId: input.orgId, taskId: input.taskId, n: 1, text: "Rovara started work from the ticket." });
  } catch (error) {
    log(table, "ticket_update.started_not_noted", { taskId: input.taskId, error: errorName(error) });
  }
}

/** After a worker's result committed: a task whose plan now waits for review gets its `plan_ready` moment (one per workflow revision). */
export async function noteTicketPlanReady(table: MomentTable, taskId: string): Promise<void> {
  try {
    const task = ((await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: { pk: `DEVTASK#${taskId}`, sk: "META" }, ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
    const workflow = task?.["workflow"] as { stage?: unknown; state?: unknown; revision?: unknown; definitionVersion?: unknown } | undefined;
    const orgId = task?.["orgId"];
    if (typeof orgId !== "string" || workflow?.stage !== "PLAN_REVIEW" || workflow.state !== "WAITING" || typeof workflow.revision !== "number" || typeof workflow.definitionVersion !== "string") return;
    if (!await followsTicket(table, orgId, typeof task?.["sessionId"] === "string" ? task["sessionId"] : undefined)) return;
    await writeMoment(table, { kind: "plan_ready", orgId: orgId, taskId, n: workflow.revision, text: "The plan is ready for review.", definitionVersion: workflow.definitionVersion });
  } catch (error) {
    log(table, "ticket_update.plan_not_noted", { taskId, error: errorName(error) });
  }
}

/** The task end handler: an end that is not a merge is the `closed` moment. Never throws (an end handler that throws holds up the task's end). */
export function ticketTaskEndHandler(current: () => MomentTable | undefined): TaskEndHandler {
  return async (_deps, event) => {
    const table = current();
    if (table === undefined || event.outcome === "merged" || !(event.bindings ?? []).some((binding) => binding.kind === "tracker_item")) return;
    try {
      await writeMoment(table, { kind: "closed", orgId: event.orgId, taskId: event.taskId, n: 1, text: "The task was closed." });
    } catch (error) {
      log(table, "ticket_update.closed_not_noted", { taskId: event.taskId, error: errorName(error) });
    }
  };
}
