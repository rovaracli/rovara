import { randomUUID } from "node:crypto";
import { AgentXError, DeveloperTaskActionRequestSchema, agentXError, WORKFLOW_REDIRECT_PLAN_DECISION_REASON, WORKFLOW_REVISE_PLAN_DECISION_REASON, WORKFLOW_SPEC_REPLAN_DECISION_REASON } from "@rovara-code/contracts";
import { type DeveloperTaskView, type WorkflowSnapshot, WorkflowSnapshotSchema, blockWorkflow } from "@agentx/cloud-contracts";
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
import { CORE_CANCEL_NOT_AVAILABLE_WORDS, coreTaskRoutes } from "../../rovara-code/task-routes.js";

/** Who acts on a task: its owner under the task's own rules, or (Plan 5) the person whose session level the session route checked. */
export type TaskActor = { kind: "owner"; caller: DeveloperCaller } | { kind: "session"; caller: DeveloperCaller };

const actingDeps = (deps: DeveloperTaskRouteDependencies, actor: TaskActor): DeveloperTaskRouteDependencies =>
  actor.kind === "session" ? { ...deps, sessionActor: { developerId: actor.caller.developerId } } : deps;

/**
 * Stops a task's running work exactly as `POST /v1/dev/tasks/{id}/cancel` does (same path, same fences, same idempotency item), for the owner or for the session actor. Idempotent by
 * `requestId`: a repeat writes nothing and answers the task as it is.
 */
export function cancelTaskFor(deps: DeveloperTaskRouteDependencies, task: Pick<DeveloperTaskRecord, "taskId">, input: { requestId: string; actor: TaskActor }): Promise<{ task: DeveloperTaskView; nothingRunning: boolean; message?: string }> {
  return cancelTaskWithOutcome(actingDeps(deps, input.actor), input.actor.caller, task.taskId, { requestId: input.requestId });
}

/** The stages before any code exists: only a workflow blocked at one of these may be ended by a Stop. */
const PLAN_STAGES: ReadonlySet<string> = new Set(["UNDERSTAND", "PLAN", "PLAN_CRITIQUE", "PLAN_REVIEW"]);
/** What a Stop answers for a task blocked after the plan stages: it neither closes nor releases anything. */
export const BLOCKED_NOT_RUNNING = "This task is blocked, not running. To end it, use Close task (it checks for unpublished work first).";

/** What a Stop answers when an earlier stop did not reach the task (it ended INTERRUPTED and still holds its workspace until Rovara confirms the worker stopped): it is not "nothing was running". */
export const STOP_NOT_CONFIRMED = "The earlier stop did not reach this task, and Rovara cannot yet tell that it has stopped. If the task is idle, Rovara frees its workspace after about 10 minutes (about 30 if the stop was retried). Pressing Close task asks for a faster release at the next check. If the task is still busy, the workspace stays reserved until it finishes. Nothing is deleted.";

/** What a Stop answers for a plan that waits for approval after code was written (a re-plan): it neither closes nor releases anything. */
export const WAITING_NOT_RUNNING = "This task is waiting for a decision, not running, and it may hold unpublished code. To end it, use Close task (it checks for unpublished work first).";

/** The modes of a task step that are planning only: every other mode (implement, review, checks, ...) ran, or may have run, on code. */
// A task operation with no workflowMode is a legacy coding turn, and a publish pushed code: both count as code (review 2026-11-03).
const PLANNING_MODES: ReadonlySet<string> = new Set(["UNDERSTAND", "PLAN", "PLAN_CRITIQUE"]);
const SENT_BACK_FROM_CODE_REASONS: readonly string[] = [WORKFLOW_REVISE_PLAN_DECISION_REASON, WORKFLOW_REDIRECT_PLAN_DECISION_REASON, WORKFLOW_SPEC_REPLAN_DECISION_REASON];

/**
 * Whether the task's workspace may hold code that was never published, which only Close (its check for unpublished work runs on the workspace by a worker, so a Stop cannot wait for it) may
 * discard. Any one of these says yes: the workflow carries a candidate, checks, reviews or a pull request of earlier code (they stay when a plan is sent back); it was sent back to planning from
 * code by a redirect, a live message or a changed spec; or a coding, review or checks step ever ran in the workspace (a stage of IMPLEMENT or later in its history). Only a task that never got
 * past planning answers no.
 */
async function mayHoldCode(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord, workflow: WorkflowSnapshot): Promise<boolean> {
  if (workflow.candidate !== undefined || workflow.reviewBase !== undefined || workflow.verification !== undefined || (workflow.reviews?.length ?? 0) > 0
    || (workflow.verificationRetries?.length ?? 0) > 0 || (workflow.pullRequests?.length ?? 0) > 0 || workflow.feedbackReview !== undefined || workflow.program !== undefined) return true;
  if (workflow.decisions.some((decision) => SENT_BACK_FROM_CODE_REASONS.includes(decision.reason ?? ""))) return true;
  return (await deps.actions.operations(task.workspaceId)).some((operation) => operation.kind === "publish" || (operation.kind === "task" && (operation.workflowMode === undefined || !PLANNING_MODES.has(operation.workflowMode))));
}

/** Whether the workspace is still held by an operation that ended INTERRUPTED (its stop failed): the hold only an owner's Close, or the reconciler's evidence, frees. */
async function holdsInterruptedOperation(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord, workspace: { activeOperationId?: string | null | undefined }): Promise<boolean> {
  if (workspace.activeOperationId === undefined || workspace.activeOperationId === null) return false;
  return (await deps.actions.operations(task.workspaceId)).some((operation) => operation.id === workspace.activeOperationId && operation.kind === "task" && operation.status === "INTERRUPTED");
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
  return { task: (await cancelTaskWithOutcome(deps, caller, taskId, value)).task };
}

/** The cancel and whether it found nothing to stop (the answer a session's Stop button needs: "Stop requested" is only true when something was running or was ended). */
async function cancelTaskWithOutcome(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, value: unknown): Promise<{ task: DeveloperTaskView; nothingRunning: boolean; message?: string }> {
  // S3 item 7: the core has no stop of a single run; a core-stamped task is never cancelled by code that reads rows the core does not write.
  const core = coreTaskRoutes();
  if (core !== undefined && await core.owns(caller, taskId)) throw agentXError("CONFIG_INVALID", CORE_CANCEL_NOT_AVAILABLE_WORDS);
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
  const current = async () => ({ task: await taskView(deps, task, { events: 0, details: false }), nothingRunning: false });
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
  // Set when the cancel found nothing running AND ended nothing either: a stop that did not stop anything.
  let nothingRunning = false;
  // Said to the person when the stop found a blocked task that only Close may end.
  let message: string | undefined;
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
    // The same for a workflow that is BLOCKED at a plan stage (Understand, Plan, its critique, its review): when no code was ever written, ending it frees nothing but the slot and the empty
    // workspace. A workflow blocked at any later stage (implement, verify, review, wait for merge) may hold commits that were never pushed, and so may one sent BACK to a plan stage after
    // coding (Stop & redirect, a live message that revises the plan, a spec re-plan: the earlier code stays). Ending either would delete that code with no check and no owner test: that is
    // the task's Close (which asks about unpublished work), never a Stop. Such a Stop closes nothing, releases nothing, and says so.
    let planReview = deps.sessionActor !== undefined && task.closedAt === undefined && task.workflow !== undefined
      && ((task.workflow.stage === "PLAN_REVIEW" && task.workflow.state === "WAITING") || (task.workflow.state === "BLOCKED" && PLAN_STAGES.has(task.workflow.stage))) ? task.workflow : undefined;
    let blockedLater = deps.sessionActor !== undefined && task.closedAt === undefined && planReview === undefined && task.workflow?.state === "BLOCKED" ? BLOCKED_NOT_RUNNING : undefined;
    if (outcome === "NOTHING_RUNNING" && planReview !== undefined && await mayHoldCode(deps, task, planReview)) {
      blockedLater = planReview.state === "BLOCKED" ? BLOCKED_NOT_RUNNING : WAITING_NOT_RUNNING;
      planReview = undefined;
    }
    if (outcome === "NOTHING_RUNNING") {
      // R12's one exception (ruling F15): nothing ran, so there is no action transaction for the
      // record to join. It is written with the cancel's idempotency item in its own transaction.
      // A failed write is counted and logged, and never hides the answer.
      try {
        await deps.actions.transact([
          marker, record(stoppedRevision ? "Stopped the automatic second planning run before it started." : planReview === undefined ? (blockedLater === undefined ? "Nothing was running." : "Nothing was running: the task is blocked or waiting, and may hold code, so a Stop left it as it was.") : planReview.state === "BLOCKED" ? "Stopped while the work was blocked." : "Stopped while the plan waited for approval."), accessFence(deps, access),
          ...(planReview === undefined ? [] : [stopPlanReviewItem(deps.tableName, task.taskId, planReview, receivedAt)]),
        ]);
        planReviewEnded = planReview !== undefined;
        nothingRunning = planReview === undefined && !stoppedRevision;
        if (nothingRunning && blockedLater !== undefined) message = blockedLater;
      } catch (error) {
        if (isConditional(error)) await authorizeTaskAction(deps, caller, taskId, "control");
        if (!isConditional(error)) turnRecordFailed(deps, error);
        nothingRunning = !stoppedRevision;
        if (nothingRunning && blockedLater !== undefined) message = blockedLater;
      }
    }
    // An agent-step run that waits (for a person, or between two steps) has nothing running for the cancel to stop: the run itself ends (Plan 3, Task 22).
    // One whose step is running ends when that step's cancel result comes. Ended runs are left as they are.
    if (outcome === "NOTHING_RUNNING" && task.agent !== undefined && task.workflow === undefined && deps.agentEngine !== undefined) {
      try {
        await cancelAgentRun(deps.agentEngine, task.taskId, "Cancelled by the person who started it.");
        nothingRunning = false;
        message = undefined;
      } catch (error) {
        log(deps, { event: "agent_run.cancel_failed", taskId: task.taskId, errorName: error instanceof Error ? error.name : "unknown" });
      }
    }
    // 058-stop-close: an earlier stop that did not reach the task left it INTERRUPTED and holding its workspace; this stop found nothing to stop, but "nothing was running" would be untrue.
    if (nothingRunning && message === undefined && await holdsInterruptedOperation(deps, task, workspace)) message = STOP_NOT_CONFIRMED;
  }
  // A plan stopped at review is a finished task like a rejected one: its slot and workspace go back now.
  if (planReviewEnded) await releaseFinishedTaskQuietly(deps, task.taskId);
  const view = await taskView(deps, task, { events: 0, details: false });
  await syncIndex(deps, task, view.status, view.updatedAt);
  return { task: view, nothingRunning, ...(message === undefined ? {} : { message }) };
}

/**
 * The task update that ends a plan waiting for approval, or a blocked workflow, because its session was stopped: the workflow closes complete (the stage a rejected plan reaches) and no
 * decision or retry is offered. The write is conditional on the revision, stage and state that were read.
 */
function stopPlanReviewItem(tableName: string, taskId: string, workflow: WorkflowSnapshot, now: string): TransactItems[number] {
  const { blockReason: _blockReason, ...rest } = workflow;
  void _blockReason;
  const closed = WorkflowSnapshotSchema.parse({ ...rest, revision: workflow.revision + 1, stage: "CLOSED", state: "COMPLETE", outcome: "CLOSED", updatedAt: now });
  return { Update: {
    TableName: tableName, Key: taskKey(taskId),
    UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
    ConditionExpression: "attribute_not_exists(closedAt) AND workflow.revision = :revision AND workflow.#stage = :review AND workflow.#state = :waiting",
    ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
    ExpressionAttributeValues: { ":workflow": closed, ":now": now, ":revision": workflow.revision, ":review": workflow.stage, ":waiting": workflow.state },
  } };
}
