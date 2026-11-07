// Part of the broker (split out of ../broker.ts): recording a task's terminal result and the stop, end and close notices.

import { settleLiveSteerReapproval } from "../../agent-sessions/live-steer-reapproval.js";
import { continueRedirectAfterStop } from "../../agent-sessions/redirect-hook.js";
import { clearLiveDeliveredSince } from "../../agent-sessions/steer.js";
import { posix as posixPath } from "node:path";
import { PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { TEST_ENV_DRAFT_NONE_KEY, TEST_ENV_DRAFT_RESULT_KEY, TEST_SERVICES_USAGE_RESULT_KEY, checksForSection, StandingFailuresSchema, nextStandingFailures, type StandingFailure, WORKFLOW_REGRESSED_CHECK_MAX, WORKFLOW_REGRESSED_CHECKS_MAX, WORKFLOW_NO_CODE_CHANGE_MESSAGE, noChangeFindingsFrom, BUDGET_EXHAUSTED_FAILURE_MESSAGE, taskResultChecks, type CheckEntry, type LatestChecks, PullRequestResultSchema, WorkspaceClosePreflightResultSchema, agentXError, type OperationStatus, type WorkspaceInstance, redactAndCap, redactText } from "@agentx/contracts";
import { keepCandidateUsage } from "../../org/test-env-candidate.js";
import { recordPrepareFailureEvent } from "../operation-events.js";
import { releaseFailedPreparation } from "../failed-preparation.js";
import { closeSetupCheck } from "../setup-check-close.js";
import { keepSetupPreparedBase } from "../../rovara-code/setup-agent.js";
import { isStoppedSetupOperation, keepStoppedSetupRun } from "./setup-stopped-result.js";
import { settleAfterCheckReported } from "../developer-routes/settings-proof-hook.js";
import { releaseFailedCancelWorkspace } from "../failed-cancel-release.js";
import { deliverCodeMilestones } from "../../rovara-code/milestones.js";
import { noteTicketPlanAfterResult } from "./ticket-updates-wiring.js";
import { noteDurationAtPullRequest } from "../../rovara-code/duration.js";
import { PLAN_EVIDENCE_PK, planEvidenceEvent, type PlanEvidenceEvent, type PlanEvidenceJob } from "../../developer/plan-evidence-jobs.js";
import { TERMINAL, getItem, operationKey, requireOperation, type OperationRecord } from "../cancellation.js";
import { END_LEASE_MS, hasTaskEndHandlers, hasTaskPauseHandlers } from "../../agents/task-end.js";
import { agentRunWakeItems } from "../agent-run-wakeup.js";
import { taskKey, taskAgentRunKey, taskPointerKey, type DeveloperTaskPointerRecord, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { operationEndDispatchItem, isConditional } from "../broker-shared.js";
import { blockOperationKeys } from "../../spend/ledger.js";
import { requestForPausedTask } from "../../spend/requests.js";
import type { TransactItems } from "../developer-task-actions.js";
import type { EndTold } from "../developer-tasks.js";
import { finishTaskClose, noteTaskEnded, noteTaskPaused, workflowEndOutcome } from "../developer-tasks.js";
import { WORKFLOW_STEP_STAGE, blockStoppedWorkflowRun, stopBlocksWorkflowStep } from "../workflow-cancel-reconcile.js";
import { object, workspaceKey } from "./admin-and-helpers.js";
import type { AwsBrokerDependencies } from "./definitions.js";
import { agentRouteDependencies, developerTaskActions } from "./dependency-wiring.js";
import { dispatchWorkflowContinuation, finishGroundingForOperation, isNonCandidateRound } from "./e2e-rounds.js";
import { writeAllPlannerReplies, type PlannerReplies } from "./plan-answers.js";
import { settleRecordedPullRequest } from "./pull-request-reconcile.js";
import { requireWorkspace } from "./records.js";
import { installOrgId } from "./scope-helpers.js";
import { ledgerOf } from "./sweeps-and-readiness.js";
import { workspaceTask } from "./task-operations.js";
import { FIRST_TASK_QUEUE_FAILED, QueuingConflict, TASK_POINTER_KINDS, cancelledTargetStatus, completedTurnItems, isQueueFailedPrepare, isSweptPrepare, releaseIfFinished, sendTerminalResult } from "./terminal-and-github-events.js";
import { deleteWorkspaceCompute } from "./thread-workspaces.js";
import { settleBaselineRound, settleGroundingRound, settleReplayRound } from "./workflow-e2e-verification.js";
import { attachInlineEvidence, completedWorkflowItems, startPlanEvidenceJobs, type InlineEvidence } from "./workflow-items.js";
import { specReviewRecordItems } from "../../spec/review-record.js";
import { dynamoSpecStore } from "../../spec/store.js";

/**
 * Whether a failed check's command could not run, so the code is not what failed: the shell could not find it or run it
 * (exit 126 or 127), or the Python code the check itself is made of (its `-c` text, or its script) does not parse. A
 * syntax error in any other file, such as a module the check imports, is the change's own failure. A worker that sends
 * no exit code is judged by its output alone. A program the worker could not start is told apart by the caller.
 */
export function checkCommandCouldNotRun(command: { executable: string; args: readonly string[]; cwd: string }, exitCode: number | null | undefined, output: string): boolean {
  if (exitCode === 126 || exitCode === 127) return true;
  const program = command.executable.split("/").at(-1) ?? command.executable;
  if (!/^python(3(\..*)?)?$/u.test(program)) return false;
  const error = /^(SyntaxError|IndentationError):/mu.exec(output);
  if (error === null) return false;
  // The file the traceback names last before the error is the one that does not parse.
  const files = [...output.slice(0, error.index).matchAll(/^\s*File "([^"\n]*)", line \d+/gmu)];
  const file = files.at(-1)?.[1];
  const own = pythonCheckOwnCode(command.args);
  return file !== undefined && own !== undefined && (own === "<string>" ? file === "<string>" : pythonFileIsScript(file, own, command.cwd));
}

/** What a python check runs: `<string>` for `-c`, the script's path, or nothing the check owns (`-m module`, no script). */
function pythonCheckOwnCode(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "-c") return "<string>";
    if (arg === "-m") return undefined;
    if (arg === "-W" || arg === "-X") index += 1;
    else if (!arg.startsWith("-")) return arg;
  }
  return undefined;
}

/**
 * Whether a traceback's file is the check's own script: the same file once both are resolved against the check's
 * directory. A relative path is taken from the check's directory (or, in full, from the worker's root); an absolute one
 * must end with the script's path under the check's directory. A file elsewhere that only shares the script's name is
 * not the script: it is the change's own code.
 */
function pythonFileIsScript(file: string, script: string, cwd: string): boolean {
  const own = script.startsWith("/") ? posixPath.normalize(script) : posixPath.join(cwd, script);
  if (file.startsWith("/")) return script.startsWith("/") ? posixPath.normalize(file) === own : posixPath.normalize(file).endsWith(`/${own}`);
  return posixPath.join(cwd, file) === own || posixPath.normalize(file) === own;
}

/**
 * The tests a rerun found passed before this change and fail now: each label (a command, untrusted worker output) on one
 * line, redacted and cut short, without repeats, at most WORKFLOW_REGRESSED_CHECKS_MAX.
 */

export function regressedCheckLabels(entries: readonly CheckEntry[]): string[] {
  const labels = entries.filter((entry) => entry.class === "regression").map((entry) => {
    const line = redactText(entry.label).replace(/\s+/gu, " ").trim();
    return line.length > WORKFLOW_REGRESSED_CHECK_MAX ? `${line.slice(0, WORKFLOW_REGRESSED_CHECK_MAX - 3).trimEnd()}...` : line;
  }).filter((label) => label !== "");
  return [...new Set(labels)].slice(0, WORKFLOW_REGRESSED_CHECKS_MAX);
}

const TERMINAL_ERROR_MAX = 16_384;

/** Return a graph IMPLEMENT operation only when it is still the exact running workflow this cancel targets. */
async function currentGraphCancelTarget(
  dependencies: AwsBrokerDependencies,
  cancel: OperationRecord,
  target?: OperationRecord,
): Promise<{ target: OperationRecord; pointer: DeveloperTaskPointerRecord } | undefined> {
  if (cancel.kind !== "cancel" || cancel.targetOperationId === undefined) return undefined;
  const [currentTarget, pointer] = await Promise.all([
    target === undefined ? requireOperation(dependencies, cancel.workspaceId, cancel.targetOperationId) : Promise.resolve(target),
    getItem<DeveloperTaskPointerRecord>(dependencies, taskPointerKey(cancel.workspaceId)),
  ]);
  const binding = currentTarget.workflowDependencies;
  const approval = binding?.approval;
  if (currentTarget.kind !== "task" || currentTarget.workflowMode !== "IMPLEMENT" || currentTarget.status !== "CANCEL_REQUESTED"
    || currentTarget.workspaceId !== cancel.workspaceId || currentTarget.fence !== cancel.fence || binding === undefined || approval === undefined
    || pointer === undefined || pointer.taskId !== binding.graph.taskId) return undefined;
  const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(pointer.taskId));
  const current = task?.workflow;
  const currentApproval = current?.workflowDependenciesApproval;
  if (task?.taskId !== binding.graph.taskId || task.workspaceId !== currentTarget.workspaceId || current === undefined
    || current.stage !== "IMPLEMENT" || current.state !== "RUNNING"
    || current.workflowDependenciesOperationId !== currentTarget.id || currentApproval === undefined
    || currentApproval.graphDigest !== approval.graphDigest || currentApproval.runId !== approval.runId
    || currentApproval.artifactDigest !== approval.artifactDigest || currentApproval.workflowRevision !== approval.workflowRevision
    || currentApproval.actorId !== approval.actorId) return undefined;
  return { target: currentTarget, pointer };
}

/** Apply the ordinary IMPLEMENT terminal transition inside the cancel transaction for the current graph target. */
async function cancelledGraphWorkflowItems(
  dependencies: AwsBrokerDependencies,
  pointer: DeveloperTaskPointerRecord | undefined,
  target: OperationRecord | undefined,
  now: string,
): Promise<TransactItems> {
  if (target === undefined || pointer === undefined || pointer.taskId !== target.workflowDependencies?.graph.taskId) return [];
  return completedWorkflowItems(dependencies, target, pointer, "CANCELLED", now, undefined, undefined, undefined, undefined, target);
}

/** Apply a native CHECKS cancellation only to the task's currently admitted round. */
async function cancelledE2EWorkflowItems(
  dependencies: AwsBrokerDependencies,
  pointer: DeveloperTaskPointerRecord | undefined,
  target: OperationRecord | undefined,
  now: string,
): Promise<TransactItems> {
  const admission = target?.workflowE2EAdmission;
  if (target === undefined || pointer === undefined || target.kind !== "task" || target.workflowMode !== "CHECKS"
    || admission === undefined || admission.taskId !== pointer.taskId) return [];
  const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(pointer.taskId));
  const workflow = task?.workflow;
  if (task === undefined || task.closedAt !== undefined || task.workspaceId !== target.workspaceId || workflow === undefined
    || workflow.stage !== "VERIFY" || workflow.state !== "RUNNING" || workflow.e2e?.required !== true
    || workflow.candidate?.digest !== admission.candidateDigest || workflow.e2e.currentRoundId !== admission.roundId
    || admission.workflowRevision !== workflow.revision) return [];
  return completedWorkflowItems(dependencies, target, pointer, "CANCELLED", now, undefined, undefined, undefined, undefined, undefined, target);
}

/**
 * Final review I3, follow-up N5: closes a project setup check's workspace and gives its slot back once its prepare has reported. A workspace that
 * is not a check's is left alone, and a check already closed changes nothing, so a repeat of the result may call it again. A close that cannot
 * land only logs: the next check or the sweep finishes it, and the result is never failed for it.
 */
async function closeCheckAfterPrepare(dependencies: AwsBrokerDependencies, workspaceId: string): Promise<void> {
  try {
    await closeSetupCheck(dependencies.documentClient, dependencies.tableName, workspaceId, {
      now: new Date(), stalled: false, deleteCompute: (target) => deleteWorkspaceCompute(dependencies, target as WorkspaceInstance),
    });
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "developer.setup_check_close_failed", workspaceId, error: error instanceof Error ? error.name : "unknown" }));
  }
  // TE-4: a project's saved or held commands wait on this result: act on it now.
  await settleAfterCheckReported(workspaceId);
}

/**
 * PLANINC-2: a stopped run's own workflow step (planning, plain coding, checks without a native E2E round, review,
 * feedback review) is blocked in the cancel's transaction, the way the same step is when its run ends FAILED, so the task
 * offers Retry instead of showing the step running with nothing running. The graph IMPLEMENT and native E2E CHECKS runs
 * have their own items above and are not repeated here. The item is the ordinary terminal transition, conditional on the
 * workflow row's revision, stage and RUNNING state; the transaction's workspace condition (this target holds the
 * workspace at this fence) means a target that finished first commits nothing here. It only blocks: no approval is
 * added or skipped and no dispatch row is queued, so anything else the transition would write is refused.
 */
async function cancelledWorkflowStepItems(
  dependencies: AwsBrokerDependencies,
  pointer: DeveloperTaskPointerRecord | undefined,
  target: OperationRecord | undefined,
  now: string,
): Promise<TransactItems> {
  if (target === undefined || pointer === undefined || target.kind !== "task" || target.workflowMode === undefined) return [];
  const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(pointer.taskId));
  // A cancelled setup draft ends as cancelled, in the cancel's own transaction (it has no workflow step to block).
  if (task?.purpose === "setup_draft" || task?.purpose === "diagnosis" || task?.purpose === "setup_agent" || task?.purpose === "nightly_run") return completedWorkflowItems(dependencies, target, pointer, "CANCELLED", now, undefined, "operation was cancelled");
  if (task === undefined || target.workflowMode === "SETUP_DRAFT" || target.workflowMode === "SETUP_AGENT" || target.workflowMode === "SPEC_WRITE" || !stopBlocksWorkflowStep(task, target)) return [];
  const items = await completedWorkflowItems(dependencies, target, pointer, "CANCELLED", now, undefined, "operation was cancelled");
  // Only the one conditional update of the step the target ran, exactly, and the AUTOFIX row that rides with a block of VERIFY or REVIEW when automatic fixing is on (DISPATCHEXHAUST: refusing
  // it left the stopped step RUNNING); anything else is left to the owner's Retry.
  const rows = items.filter((item) => item.Put?.Item?.kind === "AUTOFIX").length;
  const update = rows <= 1 && items.length === 1 + rows ? items.find((item) => item.Update !== undefined)?.Update : undefined;
  const values = update?.ExpressionAttributeValues;
  const key = taskKey(task.taskId);
  if (update === undefined || update.Key?.pk !== key.pk || update.Key?.sk !== key.sk
    || values?.[":stage"] !== WORKFLOW_STEP_STAGE[target.workflowMode] || values?.[":running"] !== "RUNNING") return [];
  return items;
}

/**
 * Whether a worker's failed result is a plain task's no-change end: the first coding turn of a task started without the workflow (it runs in IMPLEMENT mode, the worker's candidate check
 * refuses a build that changed nothing) and the error is exactly that refusal. A workflow task's build is never this: its no-change stop is `noCodeChanged`, a block a person answers.
 */
async function plainTaskLeftCodeAsItWas(dependencies: AwsBrokerDependencies, operation: OperationRecord, status: unknown, error: unknown): Promise<boolean> {
  if (status !== "FAILED" || operation.kind !== "task" || operation.workflowMode !== "IMPLEMENT" || typeof error !== "string" || !error.includes(WORKFLOW_NO_CODE_CHANGE_MESSAGE)) return false;
  const task = await workspaceTask(dependencies, operation.workspaceId);
  return task !== undefined && task.workflow === undefined;
}

/**
 * A result's findings block (a coding run that left the code as it was) is rebuilt before the result is stored: redacted and bounded here as well as in the worker, so what a worker sent (an older, a
 * newer or a hostile one) never reaches the table as it came. A block that cannot be read is dropped; every other field of the result is left as it is.
 */
function withSafeNoChangeFindings(result: unknown): unknown {
  if (result === null || typeof result !== "object" || Array.isArray(result) || !("noChangeFindings" in result)) return result;
  const { noChangeFindings, ...rest } = result as Record<string, unknown>;
  const safe = noChangeFindingsFrom(noChangeFindings);
  return safe === undefined ? rest : { ...rest, noChangeFindings: safe };
}

/**
 * Test environment (wire-testenv, TE-1 S3): a setup draft run's environment draft rides in its result, but it is kept in its own item (`testEnvDraftEndItems`, read back by the sanitizer, capped at 200 KB and
 * refused with a small marker when larger). The operation's stored result must not carry it too: a worker that ignored the cap would make the operation item too big for DynamoDB and fail the terminal
 * transaction, the setup draft's own result with it. The full result still goes to the end items that read the draft.
 */
function withoutTestEnvDraft(result: unknown): unknown {
  if (result === null || typeof result !== "object" || Array.isArray(result) || !(TEST_ENV_DRAFT_RESULT_KEY in result || TEST_SERVICES_USAGE_RESULT_KEY in result || TEST_ENV_DRAFT_NONE_KEY in result)) return result;
  // Test services: a candidate check's usage record has its own home (`keepCandidateUsage`), so the operation's stored result never carries it.
  const { [TEST_ENV_DRAFT_RESULT_KEY]: _draft, [TEST_SERVICES_USAGE_RESULT_KEY]: _usage, [TEST_ENV_DRAFT_NONE_KEY]: _none, ...rest } = result as Record<string, unknown>;
  void _draft;
  void _none;
  void _usage;
  return rest;
}

export async function recordTerminalResult(
  dependencies: AwsBrokerDependencies,
  operation: OperationRecord,
  value: unknown,
): Promise<OperationRecord> {
  const input = object(value, "terminal result");
  // Staging 0.4.10: a plain task (no workflow) whose run left the code as it was has nothing to approve, check or publish: it answered, and it ended. The worker reports that as a failure
  // because a workflow's approved build must not pass with no change; here it is the run's end, so it is recorded as one (a workflow task's stays a failure and blocks the build).
  const plainNoChange = await plainTaskLeftCodeAsItWas(dependencies, operation, input.status, input.error);
  const status = plainNoChange ? "SUCCEEDED" : input.status;
  if (!TERMINAL.has(status as OperationStatus)) throw agentXError("CONFIG_INVALID", "terminal status is invalid");
  if (TERMINAL.has(operation.status)) {
    // Issue 202: a task whose cancel failed ended INTERRUPTED but kept its workspace, as it might
    // still run. Its own result proves the run ended, so it frees the workspace; the result itself
    // is not stored (results stay immutable), and the worker gets the stored operation.
    if (operation.kind === "task" && operation.status === "INTERRUPTED") {
      const released = await releaseOnOwnResult(dependencies, operation);
      if (released !== undefined) return released;
    }
    // F5 (su): a stopped setup run's late report adds its partial proposal to the run and changes nothing else (setup-stopped-result.ts); it is never a conflict.
    if (isStoppedSetupOperation(operation)) { await keepStoppedSetupRun(dependencies, operation, input.result); if (operation.status !== status) return operation; }
    if (operation.status !== status && !isQueueFailedPrepare(operation, status) && !isSweptPrepare(operation)) throw agentXError("IDEMPOTENCY_CONFLICT", "terminal result is immutable");
    // #213: a repeated result releases a failed prepare's slot too, in case the first one's release
    // did not land (the release is idempotent, and does nothing to a workspace that moved on).
    if (operation.kind === "prepare" && operation.status !== "SUCCEEDED") {
      await releaseFailedPreparation(dependencies.documentClient, dependencies.tableName, operation.workspaceId, undefined, installOrgId(dependencies));
      // #225 review: and records its failure event, in case the first one's did not land (once per prepare).
      await repeatPrepareFailureEvent(dependencies, operation);
    }
    // A repeat of a task's result tries its keys again, in case the first end could not block them.
    await blockEndedOperationKeys(dependencies, operation);
    // Follow-up N5: the same for a project setup check, whose first close may not have landed (the compute was busy).
    if (operation.kind === "prepare") await closeCheckAfterPrepare(dependencies, operation.workspaceId);
    return operation;
  }
  const workspace = await requireWorkspace(dependencies, operation.workspaceId);
  const now = new Date().toISOString();
  const terminalStatus = status as OperationStatus;
  let recordedStatus: OperationStatus = terminalStatus;
  const startRefusal: { text?: string } = {};
  // #154: the worker's error can quote a command's output, so it is redacted before it is stored,
  // and redactAndCap redacts before it caps.
  const error = typeof input.error === "string" && !plainNoChange ? redactAndCap(input.error, TERMINAL_ERROR_MAX).text : undefined;
  const result = operation.kind === "publish" && status === "SUCCEEDED"
    ? PullRequestResultSchema.parse(input.result)
    : operation.kind === "close" && status === "SUCCEEDED"
      ? WorkspaceClosePreflightResultSchema.parse(input.result)
      : withSafeNoChangeFindings(input.result);
  // What the operation item stores: the result without the environment draft (that has its own item).
  const storedResult = withoutTestEnvDraft(result);
  const closePreflight = operation.kind === "close" && terminalStatus === "SUCCEEDED"
    ? WorkspaceClosePreflightResultSchema.parse(result)
    : undefined;
  // Explicit discard only bypasses the unpublished-work refusal after the worker has
  // successfully produced a valid preflight. A failed or cancelled check must never delete
  // compute or storage merely because the owner authorized discarding the checked-out changes.
  const closeCanFinish = operation.kind === "close" && closePreflight !== undefined
    && (closePreflight.safeToClose || operation.discardUnpublished === true);
  const cancelTargetOperation = operation.kind === "cancel" && terminalStatus === "SUCCEEDED" && operation.targetOperationId !== undefined
    ? await requireOperation(dependencies, operation.workspaceId, operation.targetOperationId)
    : undefined;
  const graphCancellation = cancelTargetOperation === undefined ? undefined
    : await currentGraphCancelTarget(dependencies, operation, cancelTargetOperation);
  const graphCancelBoundTarget = cancelTargetOperation?.kind === "task" && cancelTargetOperation.workflowMode === "IMPLEMENT"
    && cancelTargetOperation.workflowDependencies !== undefined ? cancelTargetOperation : undefined;
  // A baseline round is not the workflow's: cancelling it never touches the workflow (M1.3 Task 3.7b).
  const e2eCancelBoundTarget = cancelTargetOperation?.kind === "task" && cancelTargetOperation.workflowMode === "CHECKS"
    && cancelTargetOperation.workflowE2EAdmission !== undefined && !isNonCandidateRound(cancelTargetOperation.workflowE2EAdmission) ? cancelTargetOperation : undefined;
  if (graphCancelBoundTarget !== undefined && graphCancelBoundTarget.fence !== operation.fence) {
    throw agentXError("STALE_FENCE", "cancel and graph target no longer share the current workspace fence");
  }
  if (e2eCancelBoundTarget !== undefined && (e2eCancelBoundTarget.fence !== operation.fence || e2eCancelBoundTarget.status !== "CANCEL_REQUESTED")) {
    throw agentXError("STALE_FENCE", "cancel and E2E CHECKS target no longer share the current workspace fence");
  }
  const workspaceStatus =
    operation.kind === "prepare"
      ? terminalStatus === "SUCCEEDED"
        ? "READY"
        : "PREPARATION_FAILED"
      : operation.kind === "close"
        ? closeCanFinish
          ? "CLOSING"
          : operation.closePreviousStatus ?? "READY"
        : "READY";
  const terminalTarget = operation.kind === "cancel" && operation.targetOperationId
    ? operationKey(operation.workspaceId, operation.targetOperationId)
    : undefined;
  const transactItems: TransactItems = [
    { Update: {
      TableName: dependencies.tableName,
      Key: operationKey(operation.workspaceId, operation.id),
      UpdateExpression: "SET #status = :status, updatedAt = :now, #result = :result, #error = :error",
      ConditionExpression: "fence = :fence",
      ExpressionAttributeNames: { "#status": "status", "#result": "result", "#error": "error" },
      ExpressionAttributeValues: { ":status": terminalStatus, ":now": now, ":result": storedResult ?? null, ":error": error ?? null, ":fence": operation.fence },
    } },
  ];
  if (operation.kind === "cancel" && terminalTarget) {
    transactItems.push({ Update: {
      TableName: dependencies.tableName,
      Key: terminalTarget,
      UpdateExpression: "SET #status = :status, updatedAt = :now",
      // Issue 195: a cancel that did not succeed (a duplicate the worker no longer knows, say)
      // never turns a target that already ended into INTERRUPTED. A failed condition falls back
      // below to recording the cancel's own result only.
      ...(graphCancelBoundTarget !== undefined
        ? { ConditionExpression: "#status = :cancelRequested AND fence = :targetFence" }
        : terminalStatus === "SUCCEEDED" ? {} : { ConditionExpression: "#status = :cancelRequested" }),
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": cancelledTargetStatus(terminalStatus), ":now": now,
        ...(graphCancelBoundTarget !== undefined
          ? { ":cancelRequested": "CANCEL_REQUESTED", ":targetFence": graphCancelBoundTarget.fence }
          : terminalStatus === "SUCCEEDED" ? {} : { ":cancelRequested": "CANCEL_REQUESTED" }),
      },
    } });
  }
  // Spec 051 Ruling T: a task's end, or its cancel's, sets the workspace's latest checks in the same transaction. That
  // update holds only while this operation owns the workspace at its fence, so a late or repeated result never
  // replaces a newer task's, and no write can be lost after the result commits.
  const latestChecks = await terminalLatestChecks(dependencies, operation, terminalStatus, result, now);
  const standingFailures = latestChecks === undefined ? undefined : await nextWorkspaceStanding(dependencies, operation.workspaceId, latestChecks.report);
  const workspaceExpression = operation.kind === "prepare" && terminalStatus === "SUCCEEDED"
    ? "SET #status = :status, updatedAt = :now, preparationManifest = :manifest REMOVE activeOperationId"
    : operation.kind === "close" && !closeCanFinish
      ? "SET #status = :status, updatedAt = :now, closeError = :closeError REMOVE activeOperationId"
      : "SET #status = :status, updatedAt = :now REMOVE activeOperationId, closeError";
  const workspaceUpdate: TransactItems[number] = { Update: {
    TableName: dependencies.tableName,
    Key: workspaceKey(workspace.id),
    UpdateExpression: latestChecks === undefined ? workspaceExpression : workspaceExpression.replace(" REMOVE ", ", latestChecks = :latestChecks, standingFailures = :standingFailures REMOVE "),
    ConditionExpression: operation.kind === "cancel"
      ? "activeOperationId = :target AND fence = :fence"
      : "activeOperationId = :operation AND fence = :fence",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: {
      ":status": workspaceStatus,
      ":now": now,
      ":fence": operation.fence,
      ...(operation.kind === "cancel" ? { ":target": operation.targetOperationId } : { ":operation": operation.id }),
      ...(operation.kind === "prepare" && terminalStatus === "SUCCEEDED" ? { ":manifest": ".agentx/preparation-manifest.json" } : {}),
      ...(latestChecks === undefined ? {} : { ":latestChecks": latestChecks, ":standingFailures": standingFailures }),
      ...(operation.kind === "close" && !closeCanFinish
        ? { ":closeError": error ?? (closePreflight ? "workspace contains unpublished work" : "workspace close preflight failed") }
        : {}),
    },
  } };
  if (operation.kind !== "cancel" || terminalStatus === "SUCCEEDED") transactItems.push(workspaceUpdate);
  const send = (items: TransactItems) => dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
  let taskPointer: DeveloperTaskPointerRecord | undefined;
  // Spec 061: the evidence jobs this result queued (a stored plan that cites code), started after it commits.
  let evidenceJobs: PlanEvidenceEvent[] = [];
  const inlineEvidence: InlineEvidence[] = [];
  const plannerReplies: PlannerReplies[] = [];
  let cancelStepDropped = false;
  try {
    // A queuing transaction that met another one in flight (TransactionConflict, not a failed
    // condition) is decided again once from fresh reads before it counts as a stale callback.
    // Each decision reads the task pointer once (P39); a Slack workspace has none.
    // PLANINC-2: the stopped step's workflow item rides in the cancel's transaction, but it must never fail the cancel.
    // `cancelStepAllowed` goes false when the transaction was refused with that item attached (the task row moved between
    // the read and the commit, or the step finished first); the cancel is then decided again without it.
    let cancelStepAllowed = true;
    let cancelStepAttached = false;
    let cancelStepRedecided = false;
    const decideAndSend = async () => {
      cancelStepAttached = false;
      const pointer = TASK_POINTER_KINDS.has(operation.kind)
        ? await getItem<DeveloperTaskPointerRecord>(dependencies, taskPointerKey(workspace.id))
        : undefined;
      taskPointer = pointer;
      // P1 (su): a setup run's preparation report of where each repository stands is kept before the run's first operation is built from it (rovara-code/setup-agent.ts).
      if (operation.kind === "prepare" && terminalStatus === "SUCCEEDED" && pointer?.pendingWorkflowMode === "SETUP_AGENT") await keepSetupPreparedBase(dependencies, pointer.taskId, result, now, operation.preparePins);
      const completed = await completedTurnItems(dependencies, operation, pointer, terminalStatus, { result, error }, now);
      inlineEvidence.length = 0;
      plannerReplies.length = 0;
      const workflow = await completedWorkflowItems(dependencies, operation, pointer, terminalStatus, now, result, error, inlineEvidence, plannerReplies);
      const cancelledE2E = e2eCancelBoundTarget === undefined ? []
        : await cancelledE2EWorkflowItems(dependencies, pointer, e2eCancelBoundTarget, now);
      const cancelledGraph = graphCancellation === undefined ? []
        : await cancelledGraphWorkflowItems(dependencies, pointer, graphCancellation.target, now);
      // An agent-step run goes on from this result (or ends because of it): the engine's dispatch row is due in this same transaction (Plan 3, Task 22).
      const agentRun = pointer === undefined ? [] : await agentRunWakeItems(dependencies.documentClient, dependencies.tableName, operation, pointer.taskId, now);
      // Meta repo lane D (D3): a code review's walk of the spec is recorded with the review's result (the requirement rows W4 reads).
      const specReview = pointer === undefined || operation.workflowMode !== "REVIEW" ? [] : await specReviewRecordItems({ tableName: dependencies.tableName, store: dynamoSpecStore(dependencies), now: () => now }, pointer.taskId, operation, { status: terminalStatus, result });
      const cancelledStep = !cancelStepAllowed || graphCancelBoundTarget !== undefined || e2eCancelBoundTarget !== undefined ? []
        : await cancelledWorkflowStepItems(dependencies, pointer, cancelTargetOperation, now);
      cancelStepAttached = cancelledStep.length > 0;
      recordedStatus = await sendTerminalResult(dependencies, workspace, operation, pointer, terminalStatus, now,
        [...transactItems, ...completed, ...workflow, ...cancelledGraph, ...cancelledE2E, ...cancelledStep, ...agentRun, ...specReview], workspaceUpdate, send, startRefusal);
      evidenceJobs = [...workflow, ...cancelledGraph, ...cancelledE2E].flatMap((item) => {
        const row = item.Put?.Item as Partial<PlanEvidenceJob> | undefined;
        return row?.pk === PLAN_EVIDENCE_PK && row.taskId !== undefined && row.artifactId !== undefined ? [planEvidenceEvent(row.taskId, row.artifactId)] : [];
      });
    };
    const decideAndSendOnce = async () => {
      try {
        await decideAndSend();
      } catch (firstError) {
        if (!(firstError instanceof QueuingConflict)) throw firstError;
        await decideAndSend().catch((secondError: unknown) => {
          throw secondError instanceof QueuingConflict ? secondError.cause : secondError;
        });
      }
    };
    for (;;) {
      try {
        await decideAndSendOnce();
        break;
      } catch (refused) {
        if (!cancelStepAttached || !isConditional(refused)) throw refused;
        // A refusal (another transaction in flight, or the task row moved) is decided again once from fresh reads, step included:
        // the step is recomputed against the row as it is now. Only a second refusal drops it.
        if (!cancelStepRedecided) { cancelStepRedecided = true; continue; }
        cancelStepAllowed = false;
        cancelStepDropped = true;
        console.log(JSON.stringify({ component: "broker", event: "workflow.cancel_step_dropped", operationId: operation.id, targetOperationId: operation.targetOperationId }));
      }
    }
    // Test services: a candidate check's usage record (a result carrying `testServicesUsage`; nothing otherwise), kept on the check that holds this workspace, scoped by the org. It is written only AFTER the terminal
    // transaction committed (its fence and status checks held), so a stale or repeated callback, which is refused above or returns before this point, can never pre-empt the real report.
    if (operation.kind === "prepare") await keepCandidateUsage({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now }, { orgId: workspace.orgId, workspaceId: operation.workspaceId, result });
  } catch (transactionError) {
    if (!isConditional(transactionError)) throw transactionError;
    const existing = await requireOperation(dependencies, operation.workspaceId, operation.id);
    if (existing.status === terminalStatus || isQueueFailedPrepare(existing, terminalStatus) || isSweptPrepare(existing)) {
      if (existing.kind === "prepare" && existing.status !== "SUCCEEDED") {
        await releaseFailedPreparation(dependencies.documentClient, dependencies.tableName, existing.workspaceId, undefined, installOrgId(dependencies));
        await repeatPrepareFailureEvent(dependencies, existing);
      }
      return existing;
    }
    // A cancel whose target finished first (its own result, and for a developer task its
    // completed record, committed meanwhile): decided again once, from a fresh read, the cancel
    // records only its own result. The target, the workspace and the audit record stay as the
    // target's result left them, so there is exactly one completed record and no worker retry.
    if (operation.kind === "cancel" && operation.targetOperationId) {
      const target = await requireOperation(dependencies, operation.workspaceId, operation.targetOperationId);
      if (TERMINAL.has(target.status)) {
        try {
          await send([transactItems[0]!]);
        } catch (ownError) {
          if (!isConditional(ownError)) throw ownError;
          const again = await requireOperation(dependencies, operation.workspaceId, operation.id);
          if (again.status === terminalStatus) return again;
          throw agentXError("STALE_FENCE", "terminal callback no longer owns the workspace");
        }
        return { ...operation, status: terminalStatus, updatedAt: now, ...(storedResult === undefined ? {} : { result: storedResult }), ...(error === undefined ? {} : { error }) };
      }
    }
    throw agentXError("STALE_FENCE", "terminal callback no longer owns the workspace");
  }
  // PLANINC-2: a cancel that had to drop its workflow item committed without it; the step is blocked now, best effort and
  // conditional (a step that already moved, or a workspace a newer run holds, is left alone), so Retry is offered.
  if (cancelStepDropped && recordedStatus === terminalStatus && cancelTargetOperation !== undefined) {
    await blockStoppedWorkflowRun(dependencies.documentClient, dependencies.tableName, cancelTargetOperation, "CANCELLED");
  }
  if (closeCanFinish && taskPointer !== undefined) await finishDeveloperClose(dependencies, taskPointer, operation.id, operation.createdAt, operation.discardUnpublished === true && closePreflight?.safeToClose !== true);
  // M1.3 Task 3.7b: a baseline round settles its own record now that its result is committed, before the step it was holding back is started.
  if (recordedStatus === terminalStatus) await settleBaselineRound(dependencies, operation, terminalStatus);
  // M1.4 Task 4.6b: so does an audit replay, into a record of its own.
  if (recordedStatus === terminalStatus) await settleReplayRound(dependencies, operation, terminalStatus);
  // T7b: so does a grounding round (the proposed plan's must-not-change checks on the unchanged code), into a record of its own.
  if (recordedStatus === terminalStatus) await settleGroundingRound(dependencies, operation, terminalStatus);
  // T7c: and the plan it was holding back is finished now (its card posts, or the planner is sent back once).
  if (recordedStatus === terminalStatus) await finishGroundingForOperation(dependencies, operation);
  // Live steer: a step that stopped because the owner's live message asked for a change outside the approved plan marks that message "needs re-approval" (never throws).
  if (recordedStatus === terminalStatus && operation.kind === "task" && taskPointer !== undefined) await settleLiveSteerReapproval({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now }, taskPointer.taskId, error);
  // Stop & redirect, phase 2: a run that ended may be the stop a redirect waits for (a no-op unless the rd switch is on and a redirect is in flight for this task).
  if (recordedStatus === terminalStatus && taskPointer !== undefined) await continueRedirectAfterStop(dependencies.documentClient, taskPointer.taskId);
  // Live steer: a step that took a live message and did not succeed runs again without it, so that message's note must not read "already given" to the re-run (scoped to this attempt; never throws).
  if (recordedStatus === terminalStatus && terminalStatus !== "SUCCEEDED" && operation.kind === "task" && taskPointer !== undefined) await clearLiveDeliveredSince({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now }, taskPointer.taskId, operation.createdAt);
  // A replay that was stopped ends through the cancel operation that stopped it (the target's own terminal state is written with the cancel's): its record says so.
  if (recordedStatus === terminalStatus && operation.kind === "cancel" && terminalStatus === "SUCCEEDED" && cancelTargetOperation?.workflowE2EAdmission?.purpose === "replay") {
    await settleReplayRound(dependencies, cancelTargetOperation, "CANCELLED");
  }
  if (recordedStatus === terminalStatus && operation.kind === "cancel" && terminalStatus === "SUCCEEDED" && cancelTargetOperation?.workflowE2EAdmission?.purpose === "grounding") {
    await settleGroundingRound(dependencies, cancelTargetOperation, "CANCELLED");
    await finishGroundingForOperation(dependencies, cancelTargetOperation);
  }
  // Plan 3 final fix wave (runs I-1): an agent-step run's budget stop with no pause yet (the proxy's mid-step "budget exceeded") is asked for BEFORE the engine is
  // driven, so the engine tells the pause's real scope, once, instead of a made-up one that it then resumes at once. A stop an approval already answered is not asked again.
  const budgetStoppedRun = taskPointer !== undefined && operation.kind === "task" && operation.planRevision !== true && recordedStatus === "FAILED" && error === BUDGET_EXHAUSTED_FAILURE_MESSAGE;
  const stop = { asked: false };
  const runStop = budgetStoppedRun && taskPointer !== undefined ? await agentRunStopAsk(dependencies, taskPointer.taskId, operation.id) : "not_run";
  if (runStop !== "not_run") stop.asked = true;
  if (runStop === "ask" && taskPointer !== undefined) await askForPausedTask(dependencies, taskPointer.taskId, operation);
  // Gap 6: start any step this result made due (its dispatch row committed above); a lost start is the sweep's.
  if (taskPointer !== undefined) await dispatchWorkflowContinuation(dependencies, taskPointer.taskId);
  // Plan 6 Task 5: the milestones this result wrote (Understand's questions) are told to the registered handlers now; a handler that was not told is told again by the sweep.
  if (taskPointer !== undefined && recordedStatus === terminalStatus) {
    const milestoneTaskId = taskPointer.taskId;
    await deliverCodeMilestones({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now }, milestoneTaskId).catch((error: unknown) => {
      console.log(JSON.stringify({ component: "broker", event: "code_milestone.delivery_failed", taskId: milestoneTaskId, error: error instanceof Error ? error.name : "unknown" }));
    });
    // Slice 5: a task from a ticket whose plan now waits for review tells the ticket (never throws).
    await noteTicketPlanAfterResult(dependencies, milestoneTaskId);
  }
  // Plan 6 Task 20: the pull request this publication opened is recorded; a Linear link, replace or unlink made since the description was written is honoured now.
  if (taskPointer !== undefined && recordedStatus === terminalStatus && operation.kind === "publish" && terminalStatus === "SUCCEEDED") await settleRecordedPullRequest(dependencies, taskPointer.taskId);
  // A task that finished while this ran (merged during a feedback review, say) gives back its slot and workspace now.
  if (taskPointer !== undefined && !closeCanFinish) await releaseIfFinished(dependencies, taskPointer.taskId);
  // Plan 3, Task 32: a task operation that ran out of budget is paused, and asks for the limit its pause names (an agent-step run's engine paused it above).
  // Plan 6 Task 8: a plan check that ran out of budget is advice that stopped short (its plan goes to the person), not a pause: it asks for no money.
  const budgetStopped = taskPointer !== undefined && operation.kind === "task" && operation.workflowMode !== "PLAN_CRITIQUE" && operation.planRevision !== true && recordedStatus === "FAILED" && error === BUDGET_EXHAUSTED_FAILURE_MESSAGE;
  // Plan 3, Task 22 (G7): a workflow task that passed its sequence, and a plain task whose operation ended, tell the end handlers (an agent-step run's engine tells its own).
  // Plan 3, M-6: a plain task that stopped on a budget is paused, not ended (Task 32 may resume it): the pause handlers hear that instead, before the ask below.
  if (taskPointer !== undefined && !closeCanFinish && (hasTaskEndHandlers() || (budgetStopped && hasTaskPauseHandlers()))) {
    const told = await tellTaskStop(dependencies, operation, taskPointer.taskId, terminalStatus, budgetStopped, stop);
    // An end that is not finished (a handler threw, or another call is telling it) is left to the recovery sweep through an `operation_end` row (Task 22 re-check, N1).
    if (told !== "told") await leaveOperationEndRow(dependencies, operation, taskPointer.taskId, told === "in_progress" ? END_LEASE_MS + 5_000 : 60_000);
  }
  if (budgetStopped && !stop.asked && taskPointer !== undefined) await askForPausedTask(dependencies, taskPointer.taskId, operation);
  // Spec 061: read the code a new plan cites, in the background; a lost start is the sweep's.
  if (recordedStatus === terminalStatus) {
    await startPlanEvidenceJobs(dependencies, evidenceJobs);
    await attachInlineEvidence(dependencies, inlineEvidence);
    await writeAllPlannerReplies(dependencies, plannerReplies);
  }
  // Plan 6 Task 7: the pull request just opened (the task now waits for the merge): a version 2 task's duration is written for the next time estimate. Best effort, never fails the result.
  if (recordedStatus === terminalStatus && terminalStatus === "SUCCEEDED" && operation.kind === "publish" && taskPointer !== undefined) {
    await noteDurationAtPullRequest({ documentClient: dependencies.documentClient, tableName: dependencies.tableName }, taskPointer.taskId, now);
  }
  // #213: a prepare that did not succeed leaves the workspace PREPARATION_FAILED, which stops
  // counting toward the workspace limits now; the release logs, and never fails the callback.
  // Final review I3: a project setup check has nothing more to do on its machine once its prepare reports, success or not: its workspace is
  // closed and its limit slot given back now. A close that cannot land here is the next check's, or the sweep's. Never fails the callback.
  if (operation.kind === "prepare") await closeCheckAfterPrepare(dependencies, workspace.id);
  if (operation.kind === "prepare" && recordedStatus !== "SUCCEEDED") {
    await releaseFailedPreparation(dependencies.documentClient, dependencies.tableName, workspace.id, undefined, installOrgId(dependencies));
    // #225: a developer task's failed setup is an event of its own, so the task shows when it failed.
    if (taskPointer !== undefined) {
      await recordPrepareFailureEvent(dependencies.documentClient, dependencies.tableName, {
        workspaceId: operation.workspaceId, operationId: operation.id, fence: operation.fence, status: recordedStatus,
        error: recordedStatus !== terminalStatus ? startRefusal.text ?? FIRST_TASK_QUEUE_FAILED : error, at: now,
        // The setup itself finished; it was the task's start that failed.
        ...(recordedStatus !== terminalStatus ? { lead: "The task could not start" } : {}),
      });
    }
  }
  await blockEndedOperationKeys(dependencies, operation);
  // A cancel's success ends the task operation it stopped: that operation's keys are blocked here, since the task's own result will not come (Task 30's hand-off).
  if (operation.kind === "cancel" && operation.targetOperationId !== undefined && terminalStatus === "SUCCEEDED") {
    const target = await getItem<OperationRecord>(dependencies, operationKey(operation.workspaceId, operation.targetOperationId));
    if (target !== undefined) await blockEndedOperationKeys(dependencies, target);
  }
  if (recordedStatus !== terminalStatus) return { ...operation, status: recordedStatus, updatedAt: now, error: startRefusal.text ?? FIRST_TASK_QUEUE_FAILED };
  return { ...operation, status: terminalStatus, updatedAt: now, ...(storedResult === undefined ? {} : { result: storedResult }), ...(error === undefined ? {} : { error }) };
}

/**
 * How the budget stop of `operationId` is asked for before the engine is driven: "not_run" (the task is not an agent-step run: the ordinary ask follows), "skip" (a
 * run whose stop an approval already answered: nothing is asked, or a second pause would be written for it) or "ask".
 */
async function agentRunStopAsk(dependencies: AwsBrokerDependencies, taskId: string, operationId: string): Promise<"not_run" | "skip" | "ask"> {
  try {
    const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(taskId));
    if (task === undefined || task.agent === undefined || task.workflow !== undefined || await getItem(dependencies, taskAgentRunKey(taskId)) === undefined) return "not_run";
    return task.budgetPause === undefined && task.budgetStopOf === operationId ? "skip" : "ask";
  } catch {
    return "not_run";
  }
}

/**
 * Plan 3, Task 32: the spend request of a task whose operation ended out of budget. Never fails the worker's result: a request that can't be made now is logged,
 * and the task stays paused (the owner's Continue, or the next refusal, asks again).
 */
export async function askForPausedTask(dependencies: AwsBrokerDependencies, taskId: string, operation: Pick<OperationRecord, "id" | "workflowMode">): Promise<"asked" | "failed"> {
  const agents = agentRouteDependencies(dependencies, developerTaskActions(dependencies));
  if (agents === undefined) return "asked";
  try {
    await requestForPausedTask(agents, taskId, { ...(operation.workflowMode === undefined ? {} : { workflowMode: operation.workflowMode }), operationId: operation.id });
    return "asked";
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "spend_request.not_asked", taskId, errorName: error instanceof Error ? error.name : "unknown" }));
    return "failed";
  }
}

/**
 * Plan 3, M-6: how a task's operation that ended is told. An operation that ran out of budget (`budgetStopped`) of a plain task that is paused (its `budgetPause`)
 * is told to the pause handlers, once, and is not an end: Task 32 may resume the task, and an end would block its keys and release its workspace. Its end is told
 * when it really ends (it finishes after the resume, is cancelled, fails for another reason, or is closed). A stop with no pause that was not resumed is a failure.
 */
export async function tellTaskStop(dependencies: AwsBrokerDependencies, operation: OperationRecord, taskId: string, status: OperationStatus, budgetStopped: boolean, stop: { asked: boolean } = { asked: false }): Promise<EndTold> {
  if (!budgetStopped) return tellTaskEnd(dependencies, operation, taskId, status);
  try {
    let task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(taskId));
    if (task === undefined || task.orgId === undefined) return "told";
    // A workflow task and an agent-step run keep their own ends (a budget stop is none of them).
    if (task.workflow !== undefined || (task.agent !== undefined && await getItem(dependencies, taskAgentRunKey(taskId)) !== undefined)) return tellTaskEnd(dependencies, operation, taskId, status);
    // A closed task has ended, whatever stopped its last operation (the first end it has is the one told).
    if (task.closedAt !== undefined) return await noteTaskEnded(dependencies, task, "closed");
    // Already told for this operation (a replay, the recovery sweep): nothing more, and not an end.
    if (task.budgetPauseToldFor === operation.id) return "told";
    // A later operation started (Task 32's approval resumed the task): this stop is stale, and is never the pause of that operation. Nothing ended.
    const workspace = await getItem<{ fence?: number }>(dependencies, workspaceKey(operation.workspaceId));
    if (workspace?.fence !== undefined && workspace.fence > operation.fence) return "told";
    if (task.budgetPause !== undefined) return await noteTaskPaused(dependencies, task, operation.id);
    // The refusal stopped this operation and an approval has since removed the pause (before the result came, or before the pause tell succeeded): a pause answered, not a failure.
    if (task.budgetStopOf === operation.id) return "told";
    // No pause was written: the ask works it out from the task's spend (Task 31's Minor 2), and comes first because the stop would otherwise read as a failure. If the ask could
    // not run, the answer is not known: nothing is told and the sweep looks again (never a `failed` end on a transient error).
    stop.asked = true;
    if (await askForPausedTask(dependencies, taskId, operation) === "failed") return "failed";
    task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(taskId));
    if (task === undefined) return "told";
    if (task.budgetPause !== undefined) return await noteTaskPaused(dependencies, task, operation.id);
    return await tellTaskEnd(dependencies, operation, taskId, status);
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "task_pause.not_told", taskId, error: error instanceof Error ? error.name : "unknown" }));
    return "failed";
  }
}

/**
 * G7 for the tasks the agent-step engine does not run: how a task ended, from the operation whose result this is. A workflow task has ended when its workflow
 * says so (merged, passed its own sequence, closed); a task with no workflow when its operation ended, or its preparation failed, or a cancel stopped it. The first
 * end a task has is the one told, so a plain task that is continued later does not tell again. Never throws.
 */
async function tellTaskEnd(dependencies: AwsBrokerDependencies, operation: OperationRecord, taskId: string, status: OperationStatus): Promise<EndTold> {
  try {
    const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(taskId));
    if (task === undefined || task.orgId === undefined) return "told";
    if (task.agent !== undefined && await getItem(dependencies, taskAgentRunKey(taskId)) !== undefined) return "told";
    let outcome = workflowEndOutcome(task);
    if (outcome === undefined && task.workflow === undefined) {
      if (operation.kind === "task") outcome = status === "SUCCEEDED" ? "succeeded" : status === "CANCELLED" ? "cancelled" : "failed";
      else if (operation.kind === "prepare" && status !== "SUCCEEDED") outcome = "failed";
      else if (operation.kind === "cancel" && status === "SUCCEEDED") outcome = "cancelled";
    }
    return outcome === undefined ? "told" : await noteTaskEnded(dependencies, task, outcome);
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "task_end.not_told", taskId, error: error instanceof Error ? error.name : "unknown" }));
    return "failed";
  }
}

/** Leaves the recovery sweep an `operation_end` row for an operation whose end was not finished here, due in `inMs`. Never throws: a lost write leaves the key expiry and the next end as the backstop. */
async function leaveOperationEndRow(dependencies: AwsBrokerDependencies, operation: OperationRecord, taskId: string, inMs: number): Promise<void> {
  try {
    if (operation.orgId === undefined) return;
    const now = Date.now();
    const row = operationEndDispatchItem(dependencies.tableName, {
      taskId, orgId: operation.orgId, workspaceId: operation.workspaceId, operationId: operation.id, now: new Date(now).toISOString(), dueAt: new Date(now + inMs).toISOString(),
    }) as { Put: { Item: Record<string, unknown> } };
    await dependencies.documentClient.send(new PutCommand({ TableName: dependencies.tableName, Item: row.Put.Item }));
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "operation_end.row_not_left", taskId, error: error instanceof Error ? error.name : "unknown" }));
  }
}

/**
 * Task 30, the first phase of finalizing: a task operation that ended has no more use for its model keys, so they are blocked at the proxy and given a clock
 * (`blockOperationKeys`); the scheduled sweep settles what they spent, including a request admitted before the block, and finalizes them. The keys are those
 * the operation or its task recorded. A failure is logged and never fails the worker's result: the key's own expiry finalizes it ten minutes after it ends.
 */
export async function blockEndedOperationKeys(dependencies: AwsBrokerDependencies, operation: OperationRecord): Promise<void> {
  const ledger = ledgerOf(dependencies);
  if (ledger === undefined || operation.orgId === undefined || operation.kind !== "task") return;
  try {
    const pointer = await getItem<DeveloperTaskPointerRecord>(dependencies, taskPointerKey(operation.workspaceId));
    const task = pointer === undefined ? undefined : await getItem<DeveloperTaskRecord>(dependencies, taskKey(pointer.taskId));
    const taskKeys = task !== undefined && task.orgId === operation.orgId ? task.modelKeyIds ?? [] : [];
    await blockOperationKeys(ledger, { orgId: operation.orgId, operationId: operation.id, keyIds: [...(operation.modelKeyIds ?? []), ...taskKeys] });
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "spend.block_keys_failed", operationId: operation.id, errorName: error instanceof Error ? error.name : "unknown" }));
  }
}

/** Spec 051 Ruling T: the workspace's latest checks, as stored: what is known, which task, and when. */
export function latestChecksItem(latest: LatestChecks, operationId: string, fence: number, recordedAt: string) {
  return { report: checksForSection(latest), operationId, fence, recordedAt };
}

/**
 * Spec 051 Ruling Y: the workspace's standing failures once `latest` is recorded: the earlier ones not shown passing in
 * it, and every check failing in it. A task that ends without a report keeps the earlier ones. Written with the latest
 * checks in the terminal transaction, so the fence guards both.
 */
async function nextWorkspaceStanding(dependencies: AwsBrokerDependencies, workspaceId: string, latest: LatestChecks): Promise<StandingFailure[]> {
  return nextStandingFailures(await workspaceStandingFailures(dependencies, workspaceId), latest);
}

export async function workspaceStandingFailures(dependencies: AwsBrokerDependencies, workspaceId: string): Promise<StandingFailure[]> {
  const workspace = await getItem<{ standingFailures?: unknown }>(dependencies, workspaceKey(workspaceId));
  const parsed = StandingFailuresSchema.safeParse(workspace?.standingFailures ?? []);
  if (parsed.success) return parsed.data;
  console.log(JSON.stringify({ component: "broker", event: "workspace.standing_failures_unreadable", workspaceId }));
  return [];
}

/**
 * Spec 051 Ruling T: the latest checks a task's terminal result records: its report, or why it has none. A successful
 * cancel records its task as cancelled. Undefined for every other operation, which leaves them as they are.
 */
async function terminalLatestChecks(
  dependencies: AwsBrokerDependencies,
  operation: OperationRecord,
  status: OperationStatus,
  result: unknown,
  now: string,
) {
  if (operation.kind === "task") {
    const report = taskResultChecks(result);
    const reason = status === "SUCCEEDED" ? "no_report" : status === "FAILED" ? "failed" : status === "CANCELLED" ? "cancelled" : "interrupted";
    return latestChecksItem(report ?? { status: "not_verified", reason }, operation.id, operation.fence, now);
  }
  if (operation.kind === "cancel" && status === "SUCCEEDED" && operation.targetOperationId) {
    const target = await getItem<OperationRecord>(dependencies, operationKey(operation.workspaceId, operation.targetOperationId));
    if (target?.kind === "task") return latestChecksItem({ status: "not_verified", reason: "cancelled" }, target.id, operation.fence, now);
  }
  return undefined;
}

/**
 * #225 review: a repeated result of a developer task's failed prepare records the failure event the
 * first result's best-effort write may have missed; the event's once-key keeps it to one.
 */
async function repeatPrepareFailureEvent(dependencies: AwsBrokerDependencies, operation: OperationRecord): Promise<void> {
  try {
    if ((await getItem<DeveloperTaskPointerRecord>(dependencies, taskPointerKey(operation.workspaceId))) === undefined) return;
  } catch (error) {
    // Best effort, as the event itself: a failed read never fails the result callback.
    console.log(JSON.stringify({ component: "broker", event: "developer.prepare_failure_event_failed", operationId: operation.id, error: error instanceof Error ? error.name : "unknown" }));
    return;
  }
  await recordPrepareFailureEvent(dependencies.documentClient, dependencies.tableName, {
    workspaceId: operation.workspaceId, operationId: operation.id, fence: operation.fence, status: operation.status, error: operation.error, at: operation.updatedAt,
    ...(operation.error === FIRST_TASK_QUEUE_FAILED || operation.startRefused === true ? { lead: "The task could not start" } : {}),
  });
}

/**
 * Issue 202: frees the workspace an INTERRUPTED task still holds after its cancel failed, when the
 * task's own late result arrives, under the fence the callback holds. Returns the stored operation
 * when the workspace is freed now, or was already freed after the failed cancel (by an earlier copy
 * of this result or by the reconciler); undefined when the task no longer holds the workspace for
 * another reason (a newer operation, a moved fence), so the result is refused as before. Only a
 * task: the Slack and AI-tool stop only ever cancels a task, and any other kind is left to the
 * reconciler's sweep.
 */
async function releaseOnOwnResult(dependencies: AwsBrokerDependencies, operation: OperationRecord): Promise<OperationRecord | undefined> {
  const stored = operation as OperationRecord & { workspaceReleasedAt?: unknown; workspaceReleaseReason?: unknown };
  if (typeof stored.workspaceReleasedAt === "string") {
    // Already freed (by an earlier copy of this result, or by the reconciler): answered, never stored.
    if (stored.workspaceReleaseReason !== "own-result") {
      console.log(JSON.stringify({ component: "broker", event: "stuck_cancel.late_result_after_release", workspaceId: operation.workspaceId, operationId: operation.id, reason: stored.workspaceReleaseReason }));
    }
    // PLANINC-2: a release by the reconciler never reached the workflow; the run's own result proves it ended, so its step stops (idempotent).
    await blockStoppedWorkflowRun(dependencies.documentClient, dependencies.tableName, operation);
    return operation;
  }
  const workspace = await getItem<{ activeOperationId?: unknown; fence?: unknown }>(dependencies, workspaceKey(operation.workspaceId));
  if (workspace?.activeOperationId !== operation.id || workspace.fence !== operation.fence) return undefined;
  const at = new Date();
  if (!(await releaseFailedCancelWorkspace(dependencies.documentClient, dependencies.tableName, { workspaceId: operation.workspaceId, operationId: operation.id }, operation, "own-result", at))) {
    // Something moved first: read again, so a copy of this result that won the race is answered too.
    const again = await requireOperation(dependencies, operation.workspaceId, operation.id) as OperationRecord & { workspaceReleasedAt?: unknown };
    return typeof again.workspaceReleasedAt === "string" ? again : undefined;
  }
  console.log(JSON.stringify({ component: "broker", event: "stuck_cancel.released", workspaceId: operation.workspaceId, operationId: operation.id, reason: "own-result" }));
  // PLANINC-2: the freed workspace and the workflow step it held agree again: the step is blocked, so Retry is offered.
  await blockStoppedWorkflowRun(dependencies.documentClient, dependencies.tableName, operation);
  return await requireOperation(dependencies, operation.workspaceId, operation.id);
}

/**
 * Spec 025 R15: a developer task's safe close preflight finishes the close itself, after its result
 * committed. A failure is logged by its name and left to resumeClose (the task's next read or
 * close); the worker's callback never fails because of it. A Slack workspace has no pointer and
 * keeps its own completion flow.
 */
async function finishDeveloperClose(dependencies: AwsBrokerDependencies, pointer: DeveloperTaskPointerRecord, operationId: string, requestedAt: string, discardedUnpublished = false): Promise<void> {
  try {
    const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(pointer.taskId));
    if (task === undefined) {
      console.log(JSON.stringify({ component: "broker", event: "developer.task_record_missing", taskId: pointer.taskId, operationId }));
      return;
    }
    const tasks = developerTaskActions(dependencies);
    const agentEngine = agentRouteDependencies(dependencies, tasks);
    await finishTaskClose({ tableName: dependencies.tableName, actions: tasks, documentClient: dependencies.documentClient, ...(agentEngine === undefined ? {} : { agentEngine }) }, task, operationId, [], requestedAt, discardedUnpublished);
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "developer.task_close_failed", taskId: pointer.taskId, operationId, error: error instanceof Error ? error.name : "unknown" }));
  }
}
