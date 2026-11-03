// Design review stage, DR10: the rows that make a design review's waits findable and their reminders sendable once. Three kinds, all under the task's own partition (`DEVTASK#<taskId>`), so the notifier (which may
// write that partition and no other) can arm them without any new permission:
//   - the WAIT row (`DESIGN_WAIT`): one per task. It carries the due-time index keys (`dispatchDuePk` / `dispatchDueSk`, the sparse index the dispatch rows use under a partition value of its own) so the sweep reads
//     exactly the waits that are due. It is ARMED from the table's stream when a task's workflow is waiting on people, and re-armed on every change of the workflow (a conditional write on the revision: an older
//     change never overwrites a newer one). It holds no text and grants nothing: the sweep re-reads the task before it does anything.
//   - the NOTIFY row (`DESIGN_WAIT_NOTIFY#<revision>#<step>`): one per reminder, park and close of one wait. Created with `attribute_not_exists(pk)`, so a step is sent once however often the sweep runs. It holds codes
//     and the people to tell (Slack ids and display names the broker read), never model words; the notifier words it from fixed text.
import { designWaitOf, type DesignWait, type WorkflowSnapshot } from "@agentx/contracts";
import { nextDesignWaitDueAt, type DesignWaitNoticeStep } from "./wait-clock.js";
import type { WaitAudienceCode } from "./wait-audience.js";

export const DESIGN_WAIT_DUE_PK = "DESIGN_WAIT_DUE";
export const DESIGN_WAIT_ROW_SK = "DESIGN_WAIT";
export const DESIGN_WAIT_NOTIFY_PREFIX = "DESIGN_WAIT_NOTIFY#";

export const designWaitRowKey = (taskId: string): { pk: string; sk: string } => ({ pk: `DEVTASK#${taskId}`, sk: DESIGN_WAIT_ROW_SK });
export const designWaitNotifyKey = (taskId: string, revision: number, step: DesignWaitNoticeStep): { pk: string; sk: string } => ({ pk: `DEVTASK#${taskId}`, sk: `${DESIGN_WAIT_NOTIFY_PREFIX}${String(revision)}#${step}` });
/** The notice id of one step of one wait: the same on every sweep, so a repeated delivery posts once. */
export const designWaitNoticeId = (taskId: string, revision: number, step: DesignWaitNoticeStep): string => `${taskId}:design_wait:${String(revision)}:${step}`;

const dueKey = (atMs: number, taskId: string): string => `${new Date(atMs).toISOString()}#${taskId}`;

/** A WAIT row's write for a workflow, or undefined when the workflow is not waiting on people (or nothing will ever be due). Conditional on the revision, so a late event never overwrites a newer one. */
export function designWaitArmOf(input: { tableName: string; taskId: string; orgId?: string | undefined; workflow: WorkflowSnapshot; nowMs: number }): Record<string, unknown> | undefined {
  const wait = designWaitOf(input.workflow);
  if (wait === undefined) return undefined;
  const due = nextDesignWaitDueAt(wait, input.nowMs);
  if (due === undefined) return undefined;
  return {
    TableName: input.tableName, Key: designWaitRowKey(input.taskId),
    UpdateExpression: "SET entityType = :entity, taskId = :task, workflowRevision = :revision, waitKind = :kind, dispatchDuePk = :duePk, dispatchDueSk = :dueSk, armedAt = :now"
      + (input.orgId === undefined ? "" : ", orgId = :org"),
    ConditionExpression: "attribute_not_exists(workflowRevision) OR workflowRevision <= :revision",
    ExpressionAttributeValues: {
      ":entity": "DESIGN_WAIT", ":task": input.taskId, ":revision": input.workflow.revision, ":kind": wait.kind, ":duePk": DESIGN_WAIT_DUE_PK, ":dueSk": dueKey(due, input.taskId), ":now": new Date(input.nowMs).toISOString(),
      ...(input.orgId === undefined ? {} : { ":org": input.orgId }),
    },
  };
}

/** The sweep looked at the wait at this revision: due again at `dueAtMs`, or (undefined) no longer in the index. Conditional on the revision it looked at; a newer arm wins. */
export function designWaitReschedule(tableName: string, taskId: string, revision: number, dueAtMs: number | undefined): Record<string, unknown> {
  return {
    TableName: tableName, Key: designWaitRowKey(taskId),
    UpdateExpression: dueAtMs === undefined ? "REMOVE dispatchDuePk, dispatchDueSk" : "SET dispatchDuePk = :duePk, dispatchDueSk = :dueSk",
    ConditionExpression: "attribute_exists(pk) AND workflowRevision <= :revision",
    ExpressionAttributeValues: { ":revision": revision, ...(dueAtMs === undefined ? {} : { ":duePk": DESIGN_WAIT_DUE_PK, ":dueSk": dueKey(dueAtMs, taskId) }) },
  };
}

/** The people a notice names or tells: a display name (inert text for the notifier to escape) and, when the person has linked Slack, the Slack user id the notice goes to. */
export interface WaitPerson { name: string; slackUserId?: string | undefined }

export interface DesignWaitNotify {
  taskId: string;
  workflowRevision: number;
  step: DesignWaitNoticeStep;
  waitKind: DesignWait["kind"];
  audience: WaitAudienceCode;
  /** Who the wait is on (named in the text). */
  asked: WaitPerson[];
  /** Everyone told, by Slack id. */
  dm: string[];
  at: string;
}

/** The NOTIFY row, as a Put that refuses to replace one: a step already sent is not sent again. */
export function designWaitNotifyPut(tableName: string, notify: DesignWaitNotify): { Put: { TableName: string; Item: Record<string, unknown>; ConditionExpression: string } } {
  return {
    Put: {
      TableName: tableName, ConditionExpression: "attribute_not_exists(pk)",
      Item: {
        ...designWaitNotifyKey(notify.taskId, notify.workflowRevision, notify.step), entityType: "DESIGN_WAIT_NOTIFY", schemaVersion: 1, taskId: notify.taskId, workflowRevision: notify.workflowRevision, step: notify.step,
        waitKind: notify.waitKind, audience: notify.audience, asked: notify.asked.slice(0, 8).map((person) => ({ name: person.name.slice(0, 80) })), dm: notify.dm.slice(0, 8), at: notify.at, status: "PENDING",
      },
    },
  };
}
