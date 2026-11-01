import { randomUUID } from "node:crypto";
import {
  AgentXError,
  DeveloperTaskActionRequestSchema,
  agentXError,
  type DeveloperTaskView,
  type WorkflowSnapshot,
  WorkflowSnapshotSchema,
  blockWorkflow,
} from "@agentx/contracts";
import {
  aiToolTurn,
  developerTaskIdentity,
  taskActionRequestKey,
  taskKey,
  taskPointerKey,
  type DeveloperTaskPointerRecord,
  type DeveloperTaskRecord,
} from "../../developer/task-records.js";
import { stoppedStepReason } from "../workflow-cancel-reconcile.js";
import { endRedirectForStop } from "../../agent-sessions/redirect-state.js";
import { WORKFLOW_DISPATCH_PK, hashJson, isConditional } from "../broker-shared.js";
import type { TransactItems } from "../developer-task-actions.js";
import type { DeveloperCaller } from "../developer-routes.js";
import { cancelAgentRun } from "../../agents/run-engine.js";
import type { DeveloperTaskRouteDependencies } from "./types.js";
import { CLOSED_TASK, get, iso, log, parse, partyOfTaskActor, putNew, turnRecordFailed, turnTable } from "./common.js";
import { accessFence, authorizeLegacyTaskAction, authorizeTaskAction } from "./access.js";
import { taskView } from "./task-view.js";
import { syncIndex } from "./task-index.js";
import { retryTaskWorkflow } from "./workflow-retry.js";
import { releaseFinishedTaskQuietly } from "./release.js";

/** Who acts on a task: its owner under the task's own rules, or (Plan 5) the person whose session level the session route checked. */
export type TaskActor = { kind: "owner"; caller: DeveloperCaller } | { kind: "session"; caller: DeveloperCaller };

const actingDeps = (deps: DeveloperTaskRouteDependencies, actor: TaskActor): DeveloperTaskRouteDependencies =>
  actor.kind === "session" ? { ...deps, sessionActor: { developerId: actor.caller.developerId } } : deps;

/**
 * Stops a task's running work exactly as `POST /v1/dev/tasks/{id}/cancel` does (same path, same fences, same idempotency item), for the owner or for the session actor. Idempotent by
 * `requestId`: a repeat writes nothing and answers the task as it is.
 */
export function cancelTaskFor(deps: DeveloperTaskRouteDependencies, task: Pick<DeveloperTaskRecord, "taskId">, input: { requestId: string; actor: TaskActor }): Promise<{ task: DeveloperTaskView }> {
  return cancelTask(actingDeps(deps, input.actor), input.actor.caller, task.taskId, { requestId: input.requestId });
}

/** What a retry from a session tells the coder: the person's own words are not asked for. */
const SESSION_RETRY_INSTRUCTIONS = "Try this step again.";

/**
 * Retries a blocked workflow exactly as `POST /v1/dev/tasks/{id}/workflow/retry` does, at the revision the task has now, for the owner or the session actor. A repeat of the request
 * finds the run it started and starts nothing.
 */
export function retryTaskWorkflowFor(deps: DeveloperTaskRouteDependencies, task: Pick<DeveloperTaskRecord, "taskId" | "workflow">, input: { requestId: string; actor: TaskActor }): Promise<{ task: DeveloperTaskView }> {
  return retryTaskWorkflow(actingDeps(deps, input.actor), input.actor.caller, task.taskId, {
    requestId: input.requestId, instructions: SESSION_RETRY_INSTRUCTIONS, ...(task.workflow === undefined ? {} : { expectedRevision: task.workflow.revision }),
  });
}

/** The payload a cancel's idempotency item holds: a continue or PR with the same requestId conflicts. */
const CANCEL_PAYLOAD_HASH = hashJson({ action: "cancel" });

export async function cancelTask(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, value: unknown): Promise<{ task: DeveloperTaskView }> {
  const request = parse(DeveloperTaskActionRequestSchema, value, deps, "cancel");
  const access = await authorizeLegacyTaskAction(deps, caller, taskId, "control");
  const { task } = access;
  // Final review M2: a closed task is refused as continue refuses it, before anything is written,
  // so a repeat after the close answers "this task is closed" like any new call.
  if (task.closedAt !== undefined) throw agentXError("CONFIG_INVALID", CLOSED_TASK);
  const turns = turnTable(deps);
  const receivedAt = iso(deps);
  // Ruling F14: the same key the task's other actions use, so one requestId names one action.
  const idempotencyKey = taskActionRequestKey(task, request.requestId);
  const repeated = async (): Promise<boolean> => {
    const previous = await get<{ payloadHash: string }>(deps, idempotencyKey);
    if (previous === undefined) return false;
    if (previous.payloadHash !== CANCEL_PAYLOAD_HASH) throw agentXError("IDEMPOTENCY_CONFLICT", "this request_id was already used for another action on this task; use a new request_id");
    return true;
  };
  const current = async () => ({ task: await taskView(deps, task, { events: 0, details: false }) });
  // A repeated cancel answers with the task as it is now and writes nothing.
  if (await repeated()) return current();
  // Stop & redirect: a Stop pressed after a redirect wins; the redirect that is still stopping is ended so its restart never starts the step again (the redirect's own cancel is not a Stop).
  // After the repeat check (LR-3 N3): a late replay of an old Stop is no new Stop, so it must not end a newer redirect.
  await endRedirectForStop(deps, task.taskId, request.requestId);
  const marker = putNew(deps.tableName, { ...idempotencyKey, entityType: "IDEMPOTENCY", action: "cancel", payloadHash: CANCEL_PAYLOAD_HASH });
  const record = (response: string, operationId?: string) => putNew(turns, aiToolTurn({
    party: partyOfTaskActor(task, caller), turnId: randomUUID(), action: "cancel", phase: "accepted", outcome: "accepted", receivedAt, finishedAt: iso(deps),
    request: "cancel", response, ...(operationId === undefined ? {} : { operationId }),
  }));
  let handled = false;
  let planReviewEnded = false;
  const pointer = await get<DeveloperTaskPointerRecord>(deps, taskPointerKey(task.workspaceId));
  if (pointer?.pendingPrompt !== undefined) {
    // R16, P45: before the instructions run, removing them is the whole cancel. Only the pointer
    // changes; the workspace and the prepare are left to finish, and then queue nothing.
    try {
      await deps.actions.transact([
        { Update: {
          TableName: deps.tableName, Key: taskPointerKey(task.workspaceId),
          UpdateExpression: "SET cancelledAt = :now REMOVE pendingPrompt, pendingWorkflowMode", ConditionExpression: "attribute_exists(pendingPrompt)",
          ExpressionAttributeValues: { ":now": receivedAt },
        } },
        marker,
        record("Cancelled before the instructions ran."),
        accessFence(deps, access),
      ]);
      handled = true;
    } catch (error) {
      if (!isConditional(error)) throw error;
      await authorizeTaskAction(deps, caller, taskId, "control");
      // The same cancel, sent again, committed first.
      if (await repeated()) return current();
      // The prepare's result queued the instructions meanwhile: cancel the running task instead.
    }
  }
  // Plan 6 Task 4: a version 2 task whose Understand (or the plan after it) is queued as a dispatch row has nothing running to cancel, yet the row would start the step later. Cancelling
  // blocks the step, in the cancel's own transaction, and takes its row away; the owner's Retry starts it again.
  const queuedStage = !handled && task.workflow?.definitionVersion === "1.1.0" && task.workflow.state === "READY" && (task.workflow.stage === "UNDERSTAND" || task.workflow.stage === "PLAN")
    ? task.workflow.stage : undefined;
  if (queuedStage !== undefined && task.workflow !== undefined) {
    const queued = task.workflow;
    try {
      await deps.actions.transact([
        { Update: {
          TableName: deps.tableName, Key: taskKey(taskId),
          UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
          ConditionExpression: "workflow.revision = :revision AND workflow.#stage = :stage AND workflow.#state = :ready AND attribute_not_exists(closedAt)",
          ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
          ExpressionAttributeValues: { ":workflow": blockWorkflow(queued, stoppedStepReason(queuedStage, "CANCELLED"), receivedAt), ":now": receivedAt, ":revision": queued.revision, ":stage": queuedStage, ":ready": "READY" },
        } },
        { Delete: { TableName: deps.tableName, Key: { pk: WORKFLOW_DISPATCH_PK, sk: `${taskId}#${queued.revision}` } } },
        marker,
        record("Cancelled before the step ran."),
        accessFence(deps, access),
      ]);
      handled = true;
    } catch (error) {
      if (!isConditional(error)) throw error;
      await authorizeTaskAction(deps, caller, taskId, "control");
      // The same cancel, sent again, committed first.
      if (await repeated()) return current();
      // The step started meanwhile: cancel what is running instead.
    }
  }
  if (!handled) {
    const workspace = await deps.actions.workspace(task.workspaceId);
    if (workspace.status === "CLOSED") throw agentXError("CONFIG_INVALID", CLOSED_TASK);
    let outcome: "CANCEL_REQUESTED" | "NOTHING_RUNNING";
    let stoppedRevision: boolean;
    try {
      const cancelled = (await deps.actions.cancelRunning(developerTaskIdentity(task, deps.orgId), workspace, (operation) => [
        record("Asked the worker to stop.", operation.id),
        marker,
        accessFence(deps, access),
      ]));
      outcome = cancelled.outcome;
      stoppedRevision = cancelled.outcome === "NOTHING_RUNNING" && cancelled.stopped === "PLAN_REVISION";
    } catch (error) {
      if (isConditional(error)) await authorizeTaskAction(deps, caller, taskId, "control");
      // The same cancel, sent again, committed first (its marker failed this transaction).
      if (error instanceof AgentXError && error.code === "WORKSPACE_BUSY" && await repeated()) return current();
      // The task moved on while the cancel was written: the code stays, the words name the tool.
      if (error instanceof AgentXError && (error.code === "WORKSPACE_BUSY" || error.code === "STALE_FENCE")) {
        throw agentXError(error.code, "the task changed while cancelling; try agentx_cancel_task again");
      }
      throw error;
    }
    // Fix for v0.4.6 staging: a session stopped while its plan waits for approval has nothing running to cancel, so the stop would answer 200 and leave the plan on offer. The
    // session actor's stop ends that step as a rejected plan does (the workflow closes complete and the task gives back its slot and workspace), in the same transaction as the
    // idempotency item so a repeat cannot find the cancel recorded and the plan still open. The task's own cancel route is unchanged.
    const planReview = deps.sessionActor !== undefined && task.closedAt === undefined && task.workflow?.stage === "PLAN_REVIEW" && task.workflow.state === "WAITING" ? task.workflow : undefined;
    if (outcome === "NOTHING_RUNNING") {
      // R12's one exception (ruling F15): nothing ran, so there is no action transaction for the
      // record to join. It is written with the cancel's idempotency item in its own transaction.
      // A failed write is counted and logged, and never hides the answer.
      try {
        await deps.actions.transact([
          marker, record(stoppedRevision ? "Stopped the automatic second planning run before it started." : planReview === undefined ? "Nothing was running." : "Stopped while the plan waited for approval."), accessFence(deps, access),
          ...(planReview === undefined ? [] : [stopPlanReviewItem(deps.tableName, task.taskId, planReview, receivedAt)]),
        ]);
        planReviewEnded = planReview !== undefined;
      } catch (error) {
        if (isConditional(error)) await authorizeTaskAction(deps, caller, taskId, "control");
        if (!isConditional(error)) turnRecordFailed(deps, error);
      }
    }
    // An agent-step run that waits (for a person, or between two steps) has nothing running for the cancel to stop: the run itself ends (Plan 3, Task 22).
    // One whose step is running ends when that step's cancel result comes. Ended runs are left as they are.
    if (outcome === "NOTHING_RUNNING" && task.agent !== undefined && task.workflow === undefined && deps.agentEngine !== undefined) {
      try {
        await cancelAgentRun(deps.agentEngine, task.taskId, "Cancelled by the person who started it.");
      } catch (error) {
        log(deps, { event: "agent_run.cancel_failed", taskId: task.taskId, errorName: error instanceof Error ? error.name : "unknown" });
      }
    }
  }
  // A plan stopped at review is a finished task like a rejected one: its slot and workspace go back now.
  if (planReviewEnded) await releaseFinishedTaskQuietly(deps, task.taskId);
  const view = await taskView(deps, task, { events: 0, details: false });
  await syncIndex(deps, task, view.status, view.updatedAt);
  return { task: view };
}

/** The task update that ends a plan waiting for approval because its session was stopped: the workflow closes complete (the stage a rejected plan reaches) and no decision is offered. */
function stopPlanReviewItem(tableName: string, taskId: string, workflow: WorkflowSnapshot, now: string): TransactItems[number] {
  const closed = WorkflowSnapshotSchema.parse({ ...workflow, revision: workflow.revision + 1, stage: "CLOSED", state: "COMPLETE", outcome: "CLOSED", updatedAt: now });
  return { Update: {
    TableName: tableName, Key: taskKey(taskId),
    UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
    ConditionExpression: "attribute_not_exists(closedAt) AND workflow.revision = :revision AND workflow.#stage = :review AND workflow.#state = :waiting",
    ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
    ExpressionAttributeValues: { ":workflow": closed, ":now": now, ":revision": workflow.revision, ":review": "PLAN_REVIEW", ":waiting": "WAITING" },
  } };
}
