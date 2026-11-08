import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { mayReadEvidence } from "./evidence-port.js";
import { loadTestingView } from "./testing-view.js";
import {
  ModelFallbacksSchema,
  scopeKey,
  spendRequestKey,
  spendRequestSlotKey,
  CHANNEL_TURNS_MAX,
  DEVELOPER_TASK_SUMMARY_MAX,
  DEVELOPER_FAILURE_MESSAGE_MAX,
  WorkspaceClosePreflightResultSchema,
  agentXError,
  diffStat,
  lastAssistantResponse,
  redactAndCap,
  hideEmailAddresses,
  redactText,
  type DeveloperCloseResponse,
  type DeveloperTaskFailure,
  type DeveloperTaskStatus,
  type DeveloperTaskView,
  type Operation,
  type WorkspaceInstance,
  type WorkflowSnapshot,
  WORKFLOW_PLAN_MAX_BYTES,
  WORKFLOW_BLOCK_REASONS,
  isNoCodeChangedReason,
  noChangeFindingsFrom,
  taskGraphDigest,
  workflowRequestId,
  capText,
  sessionLink,
  RUN_LIMIT_ASK_COOLDOWN_MS,
  heldPlanStartKey,
  planRunLimitSubject,
  runLimitAskedKey,
  type SessionStatus,
  openReviewFindings,
  workflowResolveFindingsOffered,
  workflowSendBackOffered,
} from "@agentx/contracts";
import { taskStatusOf } from "../../agent-sessions/task-status.js";
import { planRunLimit } from "../../spend/estimate.js";
import { planRunLimitChange, waitsOnCodingPlan } from "../../spend/run-limit-change.js";
import { readSpendPolicy } from "../../spend/settings.js";
import {
  byCreated,
  deriveTaskStatus,
  recentTaskEvents,
  sharedSubject,
  shareView,
  taskPointerKey,
  tryEffectiveTaskOwner,
  type DeveloperTaskIndexRecord,
  type DeveloperTaskPointerRecord,
  type DeveloperTaskRecord,
  type OperationFacts,
} from "../../developer/task-records.js";
import { stoppedStepReason, strandedPlanningRun } from "../workflow-cancel-reconcile.js";
import { loadWorkflowDocument, shortenMarkdown } from "../../developer/plan-artifacts.js";
import { ensureTaskSession } from "../../agent-sessions/create.js";
import { agentRunView, taskLevelEvents } from "../../agents/run-engine.js";
import { verificationReport, workflowReviewRound } from "../../rovara-code/verification-report.js";
import { publicTrackingItem, readMergeTracking } from "../../rovara-code/merge-tracking.js";
import { parseChangedFiles } from "../../rovara-code/changed-files.js";
import { reviewModelLines, reviewNoOtherCompanyLine, reviewNoOtherCompanyOf, reviewSameModelOf } from "../../rovara-code/review-model-lines.js";
import { secondReviewTaskView } from "../../rovara-code/second-review-store.js";
import type { ChangedFilesRead } from "../../rovara-code/pull-request-body.js";
import { proofTableView } from "../../rovara-code/proof-view.js";
import type { DeveloperTaskRouteDependencies } from "./types.js";
import { blockedOnRunLimit, estimateDependencies, get, inertTaskTitle, iso, log, removedReasonOf } from "./common.js";
import { publicWorkflowDecision } from "./workflow-inputs.js";
import { approvedPlanForPullRequest, proofContextOfTask } from "./pull-request-body.js";
import { taskViewErrorRef } from "./error-ref.js";
import { readEarlyRiskSignal } from "../../rovara-code/early-risk-signal.js";

const DIFF_READ_BYTES = 1_000_000;
const ARTIFACT_NAME_MAX = 200;
const DIFF_ARTIFACT = "workspace.diff";

type TaskDetails = Pick<DeveloperTaskView, "summary" | "changedFiles" | "artifacts" | "pullRequests">;

/**
 * Whether an artifact's stored object key lies under this task's own workspace and operation.
 * The key comes from the artifact record, never from the client, but the record's name came from
 * the worker, so a key is read only when it has exactly the prefix the broker writes
 * (`private/<ownerKey>/<workspaceId>/<operationId>/<artifactId>`) and no path segments after it.
 */
function ownArtifactKey(task: DeveloperTaskRecord, operationId: string, objectKey: string): boolean {
  const prefix = `private/${task.ownerKey}/${task.workspaceId}/${operationId}/`;
  return objectKey.startsWith(prefix) && /^[A-Za-z0-9-]+$/.test(objectKey.slice(prefix.length));
}

/**
 * The files the diff names, redacted. An empty diff has none (a ranged read of a zero-byte object
 * is a 416 on S3, so callers skip size 0). Storage trouble must not break the read of an ended
 * task, so a failed read logs the error name and leaves the changed files out.
 */
async function changedFiles(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord, objectKey: string): Promise<TaskDetails["changedFiles"]> {
  let diff: string;
  try {
    diff = await deps.actions.readArtifact(objectKey, DIFF_READ_BYTES);
  } catch (error) {
    log(deps, { event: "developer.task_diff_read_failed", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" });
    return undefined;
  }
  if (diff === "") return undefined;
  return diffStat(diff).map((file) => ({ ...file, repository: redactText(file.repository), path: redactText(file.path) }));
}

/** How many of the task's newest coding operations are searched for the diff of its code. */
const CANDIDATE_DIFF_OPERATIONS = 8;
/**
 * The files the task's code changes, from the newest coding operation that published a workspace diff (a review does not publish one). Redacted by `changedFiles`. `complete` is false when the diff
 * was cut (by the worker or by the read), when its base commit was gone, or when it lists as many files as are kept, so the pull request's risk is never judged low on part of a change.
 * Undefined when no diff can be read: storage trouble logs the error name only.
 */
export async function candidateChangedFiles(
  deps: Pick<DeveloperTaskRouteDependencies, "actions" | "log">, task: Pick<DeveloperTaskRecord, "taskId" | "workspaceId" | "ownerKey">,
): Promise<ChangedFilesRead | undefined> {
  try {
    const operations = (await deps.actions.operations(task.workspaceId)).filter((operation) => operation.kind === "task").sort(byCreated).reverse().slice(0, CANDIDATE_DIFF_OPERATIONS);
    for (const operation of operations) {
      const diff = (await deps.actions.artifacts(task.workspaceId, operation.id)).find((artifact) => artifact.name === DIFF_ARTIFACT);
      if (diff === undefined) continue;
      if (diff.size === 0) return { files: [], complete: true };
      if (!ownArtifactKey({ ownerKey: task.ownerKey, workspaceId: task.workspaceId } as DeveloperTaskRecord, operation.id, diff.objectKey)) continue;
      const text = await deps.actions.readArtifact(diff.objectKey, DIFF_READ_BYTES);
      // Read by Rovara Code's own reader: Git's quoted names and both names of a rename are kept, and a file with no line count has none (not 0).
      const read = parseChangedFiles(text);
      return { files: read.files, complete: read.complete && (diff.size === undefined || diff.size <= DIFF_READ_BYTES) };
    }
  } catch (error) {
    log(deps, { event: "developer.task_changed_files_unavailable", taskId: task.taskId, errorName: error instanceof Error ? error.name : "unknown" });
  }
  return undefined;
}

/** R18: what the latest task operation left, and the task's pull requests. Callers load the owned task first. */
async function taskDetails(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord, operations: readonly Operation[]): Promise<TaskDetails> {
  const pullRequests = await deps.actions.pullRequests(task.workspaceId);
  const details: TaskDetails = {};
  const lastTask = operations.filter((operation) => operation.kind === "task").sort(byCreated).at(-1);
  if (lastTask !== undefined) {
    const said = lastAssistantResponse((await deps.actions.eventsNewestFirst(lastTask.id, 500)).reverse());
    if (said !== undefined) details.summary = redactText(said).slice(0, DEVELOPER_TASK_SUMMARY_MAX);
    const artifacts = await deps.actions.artifacts(task.workspaceId, lastTask.id);
    details.artifacts = artifacts.map((artifact) => ({ name: redactText(artifact.name).slice(0, ARTIFACT_NAME_MAX), ...(artifact.size === undefined ? {} : { size: artifact.size }) }));
    const diff = artifacts.find((artifact) => artifact.name === DIFF_ARTIFACT);
    if (diff !== undefined && diff.size !== 0) {
      if (ownArtifactKey(task, lastTask.id, diff.objectKey)) {
        const changed = await changedFiles(deps, task, diff.objectKey);
        if (changed !== undefined) details.changedFiles = changed;
      } else {
        // The key is not logged: it names another workspace.
        log(deps, { event: "developer.task_artifact_key_refused", taskId: task.taskId, artifactId: diff.id });
      }
    }
  }
  if (pullRequests.length > 0) details.pullRequests = pullRequests;
  return details;
}

/**
 * What a close preflight's result says is unpublished, per repository, or undefined when it was
 * safe or is not a preflight result (ruling F11: the close route and the task view share it).
 */
export function unpublishedOf(result: unknown): DeveloperCloseResponse["unpublished"] {
  const preflight = WorkspaceClosePreflightResultSchema.safeParse(result);
  if (!preflight.success || preflight.data.safeToClose) return undefined;
  return preflight.data.repositories.map((repository) => ({ repository: repository.name, reasons: [...repository.reasons] }));
}

/** The workspace and its operations, read once and shared by a route's steps. */
export interface WorkspaceReads { workspace: WorkspaceInstance; operations: Operation[] }
export async function workspaceReads(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord): Promise<WorkspaceReads> {
  const [workspace, operations] = await Promise.all([deps.actions.workspace(task.workspaceId), deps.actions.operations(task.workspaceId)]);
  return { workspace, operations };
}

/** A task's derived status once its agent-step run is known: the run's state decides, except that a paused run keeps the budget failure its last operation shows. */
function statusOfRun<T extends { status: DeveloperTaskStatus; failure?: DeveloperTaskFailure | undefined }>(derived: T, run: NonNullable<DeveloperTaskView["run"]>, task: DeveloperTaskRecord): T {
  if (task.closedAt !== undefined) return derived;
  if (run.state === "COMPLETE") return { ...derived, status: "SUCCEEDED", failure: undefined };
  if (run.state === "CANCELLED") return { ...derived, status: "CANCELLED", failure: undefined };
  if (run.state === "FAILED") return { ...derived, status: "FAILED", failure: { category: "task_failed", message: redactAndCap(run.endReason ?? "The run failed.", DEVELOPER_FAILURE_MESSAGE_MAX).text } };
  if ((run.state === "RUNNING" || run.state === "WAITING_FOR_APPROVAL") && derived.status === "SUCCEEDED") return { ...derived, status: "RUNNING" };
  return derived;
}

async function taskProofTable(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord, workflow: WorkflowSnapshot, actor: "owner" | "viewer", operations: readonly OperationFacts[]): Promise<DeveloperTaskView["proofTable"]> {
  try {
    return proofTableView(workflow, await proofContextOfTask(deps, task, workflow, await approvedPlanForPullRequest(deps, workflow), actor, operations));
  } catch (error) {
    log(deps, { event: "developer.task_proof_table_unavailable", taskId: task.taskId, errorName: error instanceof Error ? error.name : "unknown" });
    return undefined;
  }
}

/** The live view of a task (R4), with the result details once it has ended. Callers load the owned task first. */
export async function taskView(
  deps: DeveloperTaskRouteDependencies,
  task: DeveloperTaskRecord,
  options: { events: number; details: boolean; loaded?: WorkspaceReads; actor?: "owner" | "viewer" },
): Promise<DeveloperTaskView> {
  const modelFallbacks=ModelFallbacksSchema.safeParse(task.modelFallbacks??[]);
  if(!modelFallbacks.success) throw agentXError("RUNTIME_UNAVAILABLE","The task's model fallback history could not be read.");
  const [{ workspace, operations }, pointer] = await Promise.all([
    options.loaded ?? workspaceReads(deps, task),
    get<DeveloperTaskPointerRecord>(deps, taskPointerKey(task.workspaceId)),
  ]);
  const derivedBase = deriveTaskStatus({
    closedAt: task.closedAt,
    outcome: task.outcome,
    workspaceStatus: workspace.status,
    pointer,
    operations: operations.map((operation) => ({ id: operation.id, kind: operation.kind, status: operation.status, error: operation.error, createdAt: operation.createdAt, updatedAt: operation.updatedAt, fence: operation.fence, workflowMode: operation.workflowMode })),
  });
  const workflowWaitingForE2ECompute = task.workflow?.stage === "VERIFY" && task.workflow.state === "WAITING"
    && task.workflow.e2e?.required === true && task.workflow.e2e.currentRoundId === undefined;
  const readinessOperationId = workflowWaitingForE2ECompute && task.workflow?.candidate !== undefined
    ? workflowRequestId("agentx-workflow-e2e-readiness", task.taskId, task.workflow.revision, task.workflow.candidate.digest) : undefined;
  const readinessOperation = readinessOperationId === undefined ? undefined : operations.find((operation) => operation.id === readinessOperationId && operation.kind === "resume");
  const readinessFailed = readinessOperation !== undefined && ["FAILED", "CANCELLED", "INTERRUPTED"].includes(readinessOperation.status);
  // A readiness resume is an internal compute warmup, not task work or a verification result. Keep
  // the task visibly starting and use its startup events until the broker admits the immutable round.
  const derivedWithE2E = workflowWaitingForE2ECompute && readinessOperation !== undefined
    ? readinessFailed
      ? { ...derivedBase, status: "FAILED" as const, current: readinessOperation,
        failure: { category: "task_failed" as const, message: "E2E compute readiness failed; no feature round was admitted." } }
      : { ...derivedBase, status: "STARTING" as const, current: readinessOperation, failure: undefined }
    : derivedBase;
  // Plan 3, Task 22: an agent-step run's status is the run's, not the last operation's (a step that finished is not a run that finished).
  const run = task.agent === undefined || task.workflow !== undefined ? undefined : await agentRunView({ documentClient: deps.documentClient, tableName: deps.tableName, now: () => deps.now() }, task, deps.issuer === undefined ? undefined : new URL(deps.issuer).origin);
  const derived = run === undefined ? derivedWithE2E : statusOfRun(derivedWithE2E, run, task);
  // Plan 3, Task 32: a task waiting for money says so, with its request, what planning found and a test's offer.
  const pausedView = await pauseViewOf(deps, task, operations);
  const runLimit = await runLimitViewOf(deps, task);
  // #225: a task whose setup failed shows its prepare's events (the failure the broker recorded).
  // Plan 2, Task 22: a task still starting (nothing but its prepare so far) shows its prepare's events, which is where a resumed task's note lands.
  const startingPrepare = derived.status === "STARTING" && derived.current === undefined
    ? operations.filter((operation) => operation.kind === "prepare").sort((left, right) => left.createdAt.localeCompare(right.createdAt)).at(-1)
    : undefined;
  const eventsOf = derived.current ?? derived.failedPrepare ?? startingPrepare;
  const operationEvents = eventsOf === undefined || options.events === 0
    ? []
    : recentTaskEvents(await deps.actions.eventsNewestFirst(eventsOf.id, 200), options.events);
  // The run's own events and the approval events of its steps (Task 21 writes them in the task's partition) are the task's too.
  // The run's events, and the spend requests' events of any agent task (Task 32), are the task's too.
  const events = (run === undefined && (task.agent === undefined || task.workflow !== undefined)) || options.events === 0
    ? operationEvents
    : [...operationEvents, ...await taskLevelEvents({ documentClient: deps.documentClient, tableName: deps.tableName }, task)].sort((left, right) => left.at.localeCompare(right.at)).slice(-options.events);
  const details = options.details && derived.status !== "STARTING" && derived.status !== "RUNNING" ? await taskDetails(deps, task, operations) : {};
  // C15: only the full read shows channel turns, and a storage problem never breaks it.
  let channelTurns: DeveloperTaskView["channelTurns"];
  if (options.details && task.share?.threadTs !== undefined) {
    try {
      const turns = await deps.actions.channelTurns(sharedSubject({ ...task.share, threadTs: task.share.threadTs }), task.taskId, CHANNEL_TURNS_MAX);
      if (turns.length > 0) channelTurns = turns;
    } catch (error) {
      log(deps, { event: "developer.channel_turns_failed", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" });
    }
  }
  // R22: why the latest close did not happen, while no later close runs, the task is open and
  // the developer has not asked for more work since (a continue or a pull request may publish it).
  const lastClose = operations.filter((operation) => operation.kind === "close").sort(byCreated).at(-1);
  const workedSince = lastClose !== undefined && derived.current !== undefined && byCreated(derived.current, lastClose) > 0;
  const unpublished = lastClose?.status === "SUCCEEDED" && !derived.closing && derived.status !== "CLOSED" && !workedSince ? unpublishedOf(lastClose.result) : undefined;
  // Older MCP and CLI clients parse decisions strictly: the slice 2 fields stay out of the public view until the oldest
  // supported client knows them (the task page and Slack read them from the stored task).
  let workflow: DeveloperTaskView["workflow"] = undefined;
  if (task.workflow !== undefined) {
    const { workflowDependenciesOperationId: _internalOperationId, noChangeFindings: storedFindings, ...publicWorkflow } = task.workflow;
    void _internalOperationId;
    // What a run found when it changed nothing belongs to that stop only: it is rebuilt (redacted and bounded again) and shown while the step is blocked with it, never after a retry or another block.
    const findings = task.workflow.state === "BLOCKED" && isNoCodeChangedReason(task.workflow.blockReason) ? noChangeFindingsFrom(storedFindings) : undefined;
    workflow = { ...publicWorkflow, ...(findings === undefined ? {} : { noChangeFindings: findings }), decisions: task.workflow.decisions.map((stored) => publicWorkflowDecision(stored)) };
  }
  // PLANINC-2: planning that shows RUNNING although its run ended and the workspace is free (a stop recorded before the cancel fix)
  // reads as blocked, so the owner is offered Retry; the stored row is blocked by that retry, never by a read.
  if (workflow !== undefined && task.workflow !== undefined) {
    const stopped = strandedPlanningRun(task, workspace, operations);
    if (stopped !== undefined) workflow = { ...workflow, state: "BLOCKED", blockReason: stoppedStepReason("PLAN", stopped.status) };
  }
  // Ruling R60: a task whose creator was removed has ended. The view says so, with the reason, instead of the step it was waiting on.
  const removedReason = removedReasonOf(task);
  if (removedReason !== undefined && workflow !== undefined && workflow.stage !== "MERGED" && workflow.stage !== "CLOSED") {
    // The view's blockReason holds 500 characters; a long name must not make the whole view unreadable.
    workflow = { ...workflow, state: "BLOCKED", blockReason: capText(removedReason, 500).text };
  }
  if (removedReason === undefined && options.details && workflow?.stage === "PLAN_REVIEW" && workflow.state === "WAITING") {
    const activeArtifactType = workflow.path === "FULL" && workflow.reviewPhase === "REQUIREMENTS" ? "requirements"
      : workflow.path === "FULL" && workflow.reviewPhase === "DESIGN" ? "design" : "plan";
    const planArtifact = workflow.artifacts.filter((artifact) => artifact.type === activeArtifactType).at(-1);
    if (planArtifact !== undefined) {
      // A structured plan is shown as its Markdown copy, cut to the same limit as a legacy document.
      const loaded = await loadWorkflowDocument((objectKey, maxBytes) => deps.actions.readArtifact(objectKey, maxBytes), planArtifact, {});
      if (loaded?.format === "structured") workflow = {
        ...workflow,
        planContent: shortenMarkdown(loaded.markdown, WORKFLOW_PLAN_MAX_BYTES),
        ...(loaded.artifact.type === "plan" && loaded.plan.workBreakdown !== undefined
          ? { workBreakdownDigest: taskGraphDigest(loaded.plan.workBreakdown) } : {}),
      };
      else if (loaded !== undefined && Buffer.byteLength(loaded.markdown, "utf8") <= WORKFLOW_PLAN_MAX_BYTES) workflow = { ...workflow, planContent: loaded.markdown };
      else workflow = { ...workflow, state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.documentUnverified };
    }
  }
  // Plan 5, Task 5: a task started before sessions is given its session the first time it is read in full (once, even when two reads race; never an error).
  const sessionId = task.sessionId ?? (options.details && deps.agentRuns !== undefined
    ? await ensureTaskSession({ documentClient: deps.documentClient, tableName: deps.tableName, now: () => deps.now() }, task, { ownerName: task.developerName, title: inertTaskTitle(task.title) })
    : undefined);
  let e2ePresentation: DeveloperTaskView["e2ePresentation"];
  if (options.details && task.workflow?.e2e?.required === true && deps.workflowE2EPresentation !== undefined) {
    try { e2ePresentation = await deps.workflowE2EPresentation({ task, operations, actor: options.actor ?? "owner" }); }
    catch (error) { log(deps, { event: "developer.task_e2e_view_unavailable", taskId: task.taskId, errorName: error instanceof Error ? error.name : "unknown" }); }
  }
  // Plan 6, Task 12: a Rovara Code version 2 task shows its verification report (once checks have run on its current code; the changed files come with the full
  // read) and the review round being fixed. A version 1 task shows neither (m20), and a client that does not ask for the version 2 view never receives them.
  const rovaraCodeV2 = task.workflow?.definitionVersion === "1.1.0" && removedReason === undefined;
  // Plan 6, Task 14: what merge tracking read from GitHub for each pull request (without the merge claim), and the checks basis it found, which the report says.
  const tracked = rovaraCodeV2 && options.details && task.orgId !== undefined && (task.workflow?.pullRequests ?? []).length > 0 ? await readMergeTracking(deps, task.taskId, task.orgId) : [];
  const ciBasis = tracked.some((item) => item.ciBasis === "all_checks") ? "all_checks" as const : tracked.length > 0 ? "required" as const : undefined;
  // Plan 6, Task 19: whether the viewer pressing Merge now would be allowed to. Advisory (the press re-reads GitHub), so a failure to say leaves it out.
  const merge = tracked.length > 0 && deps.mergeView !== undefined ? await deps.mergeView(task, tracked).catch(() => undefined) : undefined;
  // MERGE-DECISION (Task 12 review and Task 14, the stricter guard): not while the code is being rewritten (the old candidate and its results stay until the next candidate replaces them), and not when the changed files were not
  // loaded (the full read skips them while the task runs), where "no tests added" would be a guess.
  const detailsLoaded = options.details && derived.status !== "STARTING" && derived.status !== "RUNNING";
  const verification = rovaraCodeV2 && detailsLoaded && task.workflow?.verification !== undefined && task.workflow.stage !== "IMPLEMENT"
    ? verificationReport(task.workflow, details.changedFiles ?? [], { ...(ciBasis === undefined ? {} : { ciBasis }) }) : undefined;
  const reviewRound = rovaraCodeV2 && task.workflow !== undefined && workflow?.state !== "BLOCKED" ? workflowReviewRound(task.workflow) : undefined;
  // Playbook P3: the proof table of the approved plan's requirements, as the pull request's Proof section has it (full reads only). Informational: a fault in any input leaves it out. A blocked task keeps it:
  // a failed requirement matters most there. (A plan whose document could not be verified is blocked only while it waits for approval, when no plan is approved and the table is absent anyway.)
  // Design review (DR11): the Design first and Skip buttons for this caller; absent while design review is not offered for the task.
  const designActions = rovaraCodeV2 && options.details && task.workflow !== undefined && deps.designActions !== undefined ? await deps.designActions(task).catch(() => undefined) : undefined;
  // OWNER DECISION 7: the checks retry, Revise the plan and a held spec's choices for this caller (what the old review page offered); a fault leaves them out.
  const pageActions = rovaraCodeV2 && options.details && task.workflow !== undefined && deps.pageActions !== undefined ? await deps.pageActions(task).catch(() => undefined) : undefined;
  const proofTable = rovaraCodeV2 && options.details && task.workflow !== undefined ? await taskProofTable(deps, task, task.workflow, options.actor ?? "owner", operations) : undefined;
  // Proof and evidence (wire-proof): the evidence kept for the task's current code (full reads only, like the proof table), with each stored artifact as a link. Present only while the proof switch is on (`deps.evidence`); a fault leaves it out.
  const evidence = rovaraCodeV2 && options.details && task.workflow !== undefined && deps.evidence !== undefined && await mayReadEvidence(deps, task) ? await deps.evidence.view(task, task.workflow.candidate?.digest).catch(() => undefined) : undefined;
  // Setup and test health SH19: the four test results (only while `vx` is on; full reads only, like the proof table). The evidence pack feeds it only for a person who may read the task's evidence.
  const testing = rovaraCodeV2 && options.details && task.workflow !== undefined
    ? await loadTestingView({ documentClient: deps.documentClient, tableName: deps.tableName, now: () => deps.now(), nightlyHead: deps.nightlyHead, evidence: deps.evidence !== undefined && await mayReadEvidence(deps, task) ? deps.evidence : undefined }, task, task.workflow) : undefined;
  // Playbook P2: the reviewer model lines of the pull request's Reviews section (A2's function and flag, the only source), for the Tests tab.
  const reviewLines = rovaraCodeV2 && task.workflow !== undefined ? reviewModelLines(task.workflow, reviewSameModelOf(task, task.workflow)) : [];
  // Owner decision 2026-11-02: the reviews ran on the build's company because no other company's model was usable (the default is another company's). Said with the review lines, so only once the current code has a review.
  const noOtherCompanyModel = task.workflow === undefined ? undefined : reviewNoOtherCompanyOf(task, task.workflow);
  const modelLines = reviewLines.length > 0 && noOtherCompanyModel !== undefined ? [...reviewLines, reviewNoOtherCompanyLine(noOtherCompanyModel)] : reviewLines;
  // SH34: the second review by another AI company (switch `cr`), from the task record beside the workflow; full reads only. Silent for shadow that did not run.
  const secondReviewBase = options.details && task.workflow !== undefined ? secondReviewTaskView(task, task.workflow.candidate?.digest) : undefined;
  // The owner (and only the owner) is offered "I've seen it" while an acknowledgement is asked for; the route behind it checks the same thing again.
  const secondReview = secondReviewBase === undefined ? undefined : { ...secondReviewBase, ...(secondReviewBase.needsAcknowledgement && !secondReviewBase.acknowledged && options.actor === "owner" ? { canAcknowledge: true } : {}) };
  // v1.2 track record: the early "PR risk low" score is the task owner's alone. It is read only for a view built for the owner (an explicit `actor: "owner"`; no named actor and a viewer never get it), on a
  // full read, and only when this task's pull request was published with risk low.
  const earlyRiskSignal = rovaraCodeV2 && options.details && options.actor === "owner" ? await readEarlyRiskSignal(deps, task) : undefined;
  const updatedAt = derived.failedPrepare?.updatedAt !== undefined && derived.failedPrepare.updatedAt > task.updatedAt ? derived.failedPrepare.updatedAt : derived.current?.createdAt ?? task.updatedAt;
  // Live interaction F1: what "Fix with agent" is about when this view shows an error (fixed codes and ids only).
  const errorRef = taskViewErrorRef({ taskId: task.taskId, status: derived.status, workflow, failure: derived.failure, operationId: derived.failedPrepare?.id ?? derived.current?.id, creatorRemoved: removedReason !== undefined, at: updatedAt });
  // UX2 slice 2 item 1: where the task stands in the one status model, for the task page, the MCP tools and the CLI (the next step is for the owner, `nextOthers` for anyone else).
  const statusView = taskStatusOf({
    workflow, closed: task.closedAt !== undefined || derived.status === "CLOSED", budgetPaused: task.budgetPause !== undefined, removedReason,
    failedPrepare: workflow !== undefined && derived.failedPrepare !== undefined, ...(merge === undefined || task.closedAt !== undefined ? {} : { merge }),
    sessionStatus: plainSessionStatus(derived.status, run?.state), ...(derived.status === "FAILED" || derived.status === "INTERRUPTED" ? { lastRunFailed: true as const } : {}),
    failureCategory: derived.failure?.category,
  });
  const reviewFindings = findingActionsOf(task, options.actor === "viewer");
  // QA6-12b: what approving the waiting coding plan does to the run limit (the Slack message and the tools show it before the approval, which must carry the amount when it raises the limit).
  const planLimitChange = task.closedAt === undefined && waitsOnCodingPlan(task.workflow) ? planRunLimitChange(task) : undefined;
  return {
    modelFallbacks:modelFallbacks.data,
    statusView,
    ...(reviewFindings === undefined ? {} : { reviewFindings }),
    taskId: task.taskId,
    // S3: a reader who is not the owner reads the title (a person's request) without an email address.
    title: options.actor === "viewer" ? hideEmailAddresses(task.title) : task.title,
    project: task.project,
    status: derived.status,
    ...(workflow === undefined ? {} : { workflow }),
    ...(verification === undefined ? {} : { verificationReport: verification }),
    ...(proofTable === undefined ? {} : { proofTable }),
    ...(designActions === undefined ? {} : { designActions }),
    ...(pageActions === undefined ? {} : { pageActions }),
    ...(evidence === undefined ? {} : { evidence }),
    ...(testing === undefined ? {} : { testing }),
    ...(modelLines.length === 0 ? {} : { reviewModelLines: modelLines }),
    ...(secondReview === undefined ? {} : { secondReview }),
    ...(reviewRound === undefined ? {} : { reviewRound }),
    ...(tracked.length === 0 ? {} : { mergeTracking: tracked.map(publicTrackingItem) }),
    // A closed task offers no Merge: its pull requests are listed as they stand, but "Ready to merge" would contradict the task being closed (QA6-07).
    ...(merge === undefined || task.closedAt !== undefined ? {} : { merge }),
    ...(earlyRiskSignal === undefined ? {} : { earlyRiskSignal }),
    ...(e2ePresentation === undefined ? {} : { e2ePresentation }),
    ...(derived.failure === undefined ? {} : { failure: derived.failure }),
    ...(errorRef === undefined ? {} : { errorRef }),
    ...(removedReason === undefined ? {} : { outcome: "creator_removed" as const, outcomeReason: capText(removedReason, 1000).text }),
    startingRevision: task.startingRevision,
    client: task.client,
    shared: task.shared,
    ...(task.share === undefined ? {} : { share: shareView(task.share) }),
    ...(derived.closing ? { closing: true } : {}),
    ...(task.agent === undefined ? {} : { agent: { agentId: task.agent.agentId, name: task.agent.name, version: task.agent.version, builtin: task.agent.builtin } }),
    ...(run === undefined ? {} : { run }),
    ...pausedView,
    ...(runLimit === undefined ? {} : { runLimit }),
    // QA6-12: the run limit shown is the one approving the plan sets (`planRunLimit`: the estimate, held to a lower limit the start asked for), the same as the confirmation and the broker use.
    ...(task.runEstimate === undefined ? {} : { runEstimate: task.requestedRunLimitUsd === undefined ? task.runEstimate : { ...task.runEstimate, runLimitUsd: Math.min(task.runEstimate.runLimitUsd, task.requestedRunLimitUsd) } }),
    ...(planLimitChange === undefined ? {} : { planRunLimit: planLimitChange }),
    ...(sessionId === undefined ? {} : { sessionId, ...(deps.issuer === undefined ? {} : { sessionUrl: sessionLink(new URL(deps.issuer).origin, sessionId) }) }),
    createdAt: task.createdAt,
    // #225: a failed setup's task changed when its prepare ended, not when it was made.
    updatedAt,
    // S3: a reader who is not the owner reads the events (a model's and a worker's words) without an email address.
    events: options.actor === "viewer" ? events.map((event) => ({ ...event, text: hideEmailAddresses(event.text) })) : events,
    ...details,
    ...(channelTurns === undefined ? {} : { channelTurns }),
    ...(unpublished === undefined ? {} : { unpublished }),
  };
}

/** UX2 slice 2 item 3: a blocked task's open review findings and whether Resolve findings and Send back to coding are offered (the same tests as Slack's buttons). Reviewer words are redacted and capped. */
function findingActionsOf(task: DeveloperTaskRecord, viewer: boolean): DeveloperTaskView["reviewFindings"] {
  const workflow = task.workflow;
  if (workflow === undefined || workflow.state !== "BLOCKED" || task.closedAt !== undefined || blockedOnRunLimit(workflow)) return undefined;
  const resolve = workflowResolveFindingsOffered(workflow);
  const sendBack = workflowSendBackOffered(workflow);
  if (!resolve && !sendBack) return undefined;
  const shown = (text: string, max: number): string => { const cleaned = capText(redactText(viewer ? hideEmailAddresses(text) : text).replace(/[\p{Cc}\p{Cf}]+/gu, " ").trim(), max).text;return cleaned === "" ? "(no text)" : cleaned; };
  const findings = (workflow.stage === "REVIEW" ? openReviewFindings(workflow) : []).slice(0, 50).map((finding) => ({
    findingId: finding.findingId, role: finding.role, text: shown(finding.text, 1000),
    ...(finding.file === undefined ? {} : { file: shown(finding.file, 500) }), ...(finding.line === undefined || finding.line < 1 ? {} : { line: finding.line }),
  }));
  return { findings, resolve, sendBack };
}

/** The session status a task with no workflow reads as (the summary's rule, from what the view already derived). */
function plainSessionStatus(status: DeveloperTaskView["status"], runState: string | undefined): SessionStatus {
  if (runState === "WAITING_FOR_APPROVAL") return "needs_person";
  if (runState === "PAUSED_BUDGET") return "paused";
  switch (status) {
    case "STARTING": return "starting";
    case "RUNNING": return "running";
    case "CANCELLED": return "stopped";
    case "FAILED": case "INTERRUPTED": return "waiting";
    case "CLOSED": return "cancelled";
    default: return "waiting";
  }
}

export async function openTasksText(deps: DeveloperTaskRouteDependencies, developerId: string): Promise<string> {
  const response = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": `DEVELOPER#${developerId}`, ":prefix": "TASK#" },
    ScanIndexForward: false,
    Limit: 50,
    ConsistentRead: true,
  })) as { Items?: DeveloperTaskIndexRecord[] };
  const open = (response.Items ?? []).filter((row) => row.status !== "CLOSED").slice(0, 10);
  return open.length === 0 ? "" : ` Your open AI-tool tasks: ${open.map((row) => `${row.taskId} (${row.title})`).join("; ")}.`;
}

/** The slots a month's request for `scope` may be in: each month, each asker. */
export const monthSlots = (months: readonly string[], scope: string, askers: readonly string[]): Array<{ subject: string; kind: string }> =>
  months.flatMap((month) => askers.map((asker) => ({ subject: `MONTH#${month}#${scope}#${asker}`, kind: "month" })));

/** Plan 3, Task 32: what the view says of a task waiting for money: the pause and its request, what planning found, a test's offer to continue. */
async function pauseViewOf(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord, operations: readonly Operation[]): Promise<Pick<DeveloperTaskView, "paused" | "planningSoFar" | "testOffer">> {
  const pause = task.budgetPause;
  if (pause === undefined || task.orgId === undefined) return {};
  const scope = Object.fromEntries(Object.entries(pause.scope).filter(([, value]) => typeof value === "string")) as Record<string, string>;
  // A run's own limit has its task's request. A month's budget has the month's request: the one the pause asked for, else one the task's starter or owner
  // asked for themselves (Task 33 fix round 1, M-4), looked for by the pause's month first and then this month's (M-3).
  const months = [...new Set([pause.at.slice(0, 7), iso(deps).slice(0, 7)])];
  // A request made before a take-over was asked of the creator, one made after of the taker (Plan 5 Task 12a): both slots are looked in.
  const taker = tryEffectiveTaskOwner(task)?.developerId;
  const askers = [...new Set(["system", task.startedBy?.developerId ?? taker ?? task.developerId, taker ?? task.developerId, task.developerId])];
  const slots: Array<{ subject: string; kind: string }> = pause.scope.kind === "task" ? [{ subject: `TASK#${task.taskId}`, kind: "run_limit" }]
    : pause.scope.kind === "max_per_run" || pause.scope.kind === "planning" ? [{ subject: `TASK#${task.taskId}`, kind: pause.scope.kind }]
      : pause.scope.kind === "test" ? []
        : monthSlots(months, scopeKey(pause.scope), askers);
  let spendRequestId: string | undefined;
  let message: string | undefined;
  for (const slotOf of slots) {
    const slot: { spendRequestId?: string } | undefined = await get<{ spendRequestId?: string }>(deps, spendRequestSlotKey(task.orgId, slotOf.subject, slotOf.kind));
    const id: string | undefined = slot?.spendRequestId;
    const record: { orgId?: string; status?: string; reason?: string } | undefined = id === undefined ? undefined : await get<{ orgId?: string; status?: string; reason?: string }>(deps, spendRequestKey(task.orgId, id));
    if (record?.orgId === task.orgId && record.status === "PENDING") {
      spendRequestId = id;
      message = record.reason;
      break;
    }
  }
  const out: Pick<DeveloperTaskView, "paused" | "planningSoFar" | "testOffer"> = {
    paused: { reason: "budget", scope, ...(spendRequestId === undefined ? {} : { spendRequestId }), ...(message === undefined ? {} : { message: capText(message, 300).text }) },
  };
  if (pause.scope.kind === "test") {
    const capUsd = (await readSpendPolicy(deps, task.orgId)).perTestCapUsd;
    out.testOffer = { capUsd };
    out.paused = { ...out.paused!, message: `This test reached its $${String(Number(capUsd.toFixed(2)))} cap. Continue it as a normal task? It will then count against your monthly limit and ${task.project}'s budget.` };
  }
  if (pause.scope.kind === "planning") {
    const plan = [...operations].filter((operation) => operation.kind === "task" && operation.workflowMode === "PLAN").sort(byCreated).at(-1);
    const said = plan === undefined ? undefined : lastAssistantResponse((await deps.actions.eventsNewestFirst(plan.id, 500)).reverse());
    if (said !== undefined) out.planningSoFar = Array.from(said).slice(0, 4096).join("");
  }
  return out;
}

/**
 * Plan 3, Task 35b: what the view says of a plan blocked on its run limit (and of nothing else): the limit it waits for, the request that asks for it while one is
 * open and still has time, and whether the owner may ask again (`POST /v1/app/tasks/{id}/run-limit-request`). A request whose time has run out reads as ended,
 * as it does everywhere, so the owner is not told to wait for one nobody can decide.
 */
async function runLimitViewOf(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord): Promise<DeveloperTaskView["runLimit"]> {
  if (task.orgId === undefined || task.closedAt !== undefined || task.workflow === undefined || !blockedOnRunLimit(task.workflow)) return undefined;
  let limitUsd: number;
  try {
    limitUsd = await planRunLimit(estimateDependencies(deps), task);
  } catch (error) {
    // The estimate's history could not be read: the rest of the view still stands.
    log(deps, { event: "developer.run_limit_view_unavailable", taskId: task.taskId, errorName: error instanceof Error ? error.name : "unknown" });
    return undefined;
  }
  const slot = await get<{ spendRequestId?: string }>(deps, spendRequestSlotKey(task.orgId, planRunLimitSubject(task.taskId), "run_limit"));
  const record = slot?.spendRequestId === undefined ? undefined : await get<{ orgId?: string; status?: string; expiresAt?: string }>(deps, spendRequestKey(task.orgId, slot.spendRequestId));
  const open = record?.orgId === task.orgId && record.status === "PENDING" && Date.parse(record.expiresAt ?? "") > deps.now() ? slot?.spendRequestId : undefined;
  if (open !== undefined) return { limitUsd, spendRequestId: open, canAskAgain: false };
  // Approved, and the start after the approval is still to be made: nothing to ask for.
  if (await get<Record<string, unknown>>(deps, heldPlanStartKey(task.orgId, task.taskId)) !== undefined) return { limitUsd, canAskAgain: false };
  // Asked a few minutes ago: the next ask is allowed from then.
  const last = await get<{ at?: string }>(deps, runLimitAskedKey(task.orgId, task.taskId));
  const lastAt = typeof last?.at === "string" ? Date.parse(last.at) : Number.NaN;
  if (Number.isFinite(lastAt) && lastAt + RUN_LIMIT_ASK_COOLDOWN_MS > deps.now()) return { limitUsd, canAskAgain: false, askAgainAfter: new Date(lastAt + RUN_LIMIT_ASK_COOLDOWN_MS).toISOString() };
  return { limitUsd, canAskAgain: true };
}
