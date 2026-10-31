import { randomUUID } from "node:crypto";
import { DeleteCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  CanvasCloseoutRetryRequestSchema,
  AgentXError,
  workflowPullRequestUpdateDue,
  ContinueDeveloperTaskRequestSchema,
  agentXError,
  type DeveloperTaskView,
  type Operation,
  type WorkflowSnapshot,
  WorkflowTransitionError,
  WORKFLOW_MISSING_COMMITTED_SOURCE_EXPORT_REASON,
  returnWorkflowToImplementation,
  sendBackProblems,
  workflowSendBackOffered,
  type WorkflowDependencyInvocation,
  WorkflowResolveFindingsInputSchema,
  openReviewFindings,
  resolveWorkflowReviewFindings,
  workflowFindingProblem,
  isBranchConflictAskReason,
  isBranchSyncGiveUpReason,
  retryWorkflowBranchSync,
  retryWorkflowCiFix,
} from "@agentx/contracts";
import type { z } from "zod";
import { workflowDependenciesAllowed } from "../../rovara-code/parallel-parts.js";
import { aiToolTurn, developerTaskIdentity, partyOfTask, taskKey, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { WORKFLOW_DISPATCH_PK, WORKFLOW_NO_CANDIDATE_DIGEST, isConditional, workflowDispatchItem, type WorkflowDispatchRecord } from "../broker-shared.js";
import type { DeveloperCaller } from "../developer-routes.js";
import { operationKey } from "../cancellation.js";
import { E2E_OWNER_SENTENCES } from "../../e2e/owner-sentences.js";
import { withTestRule } from "../../rovara-code/verification-report.js";
import { ciFixPrompt, readLatestCiEvidence } from "../../rovara-code/ci-fix.js";
import { conflictFixPrompt } from "../../rovara-code/branch-sync.js";
import { wakeTrackingRow } from "../workflow-merge-recovery.js";
import type { DeveloperTaskRouteDependencies } from "./types.js";
import {
  RUN_LIMIT_NOT_APPROVED_REFUSAL,
  blockedOnRunLimit,
  creatorGuard,
  get,
  iso,
  log,
  parse,
  partyOfTaskActor,
  putNew,
  taskBaseOption,
  taskPageUrl,
  turnTable,
} from "./common.js";
import { type AuthorizedTask, accessFence, authorizeTaskAction, authorizeTaskActor, systemTaskAccess } from "./access.js";
import { taskView } from "./task-view.js";
import { syncIndex } from "./task-index.js";
import {
  AUTOMATIC_KEEPS_WINDOW,
  actionableWorkspace,
  busyOrClosing,
  capWindowBaseline,
  capWindowUpdate,
  refuseAutomaticWhilePaused,
  requireMayGoOn,
} from "./task-window.js";
import {
  NO_PUBLISH_NOTE,
  approvedCodingPlan,
  approvedWorkflowDependencies,
  ownerConstraintsSection,
  selectedCheckCommands,
  workflowWithCurrentGraphOperation,
} from "./workflow-inputs.js";
import { startTaskWorkflowImplementationFromSystem, startTaskWorkflowReviewFromSystem } from "./workflow-review.js";
import { startTaskWorkflowPlanCritiqueFromSystem } from "./workflow-starts.js";
import { startTaskWorkflowPublicationFromSystem } from "./publication.js";
import { fedThroughUpdate, promptTagId, sendBackProblemsPromptSection, withCurrentThreadNotes } from "./thread-notes.js";

/**
 * Accept a coding run for the task: the workflow moves from its exact current revision, stage and state to `next`
 * (IMPLEMENT/RUNNING) in the transaction that queues the run, with the replies the prompt took marked as given.
 * `prompt` gets the replies' prompt section ("" when there are none).
 */
export async function queueWorkflowCoding(
  deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, access: AuthorizedTask & { task: DeveloperTaskRecord & { workflow: WorkflowSnapshot } },
  input: { requestId: string; prompt: (notes: string) => string; next: WorkflowSnapshot; request: string; response: string; workflowDependencies?: WorkflowDependencyInvocation;
    /** AUTOFIX (mainline #408): Rovara's own send-back; the cap window is kept and a pause that waits for an approval stops it (see above). */
    automatic?: true;
    recovery?: { sourceOperation: Operation; sourceBinding: WorkflowDependencyInvocation; graphApproval: WorkflowDependencyInvocation["approval"]; graphProgress: NonNullable<WorkflowDependencyInvocation["resumeProgress"]>;
      payloadHash: string; actorId: string; requestId: string } },
): Promise<{ task: DeveloperTaskView }> {
  const { task } = access;
  const { workflow } = task;
  // The same authority this restart asks for once it has committed (below), asked before anything commits: a person who is refused it must not have started a run first.
  await authorizeTaskAction(deps, caller, task.taskId, "work");
  // A human's retry or send-back (rulings R38 and R39) starts a new window of the task's cap, unless that skips an approval they may not decide.
  // MONEY (mainline #408 sync; owner ruling pending): Rovara's own send-back to coding (`input.automatic`, AUTOFIX) is not a person's choice: it keeps the window (no new baseline), and it
  // does not go on over a pause that waits for an approval, so the run limit the owner accepted binds every automatic round.
  if (input.automatic === true) refuseAutomaticWhilePaused(task); else await requireMayGoOn(deps, caller, task);
  const cap = input.automatic === true ? AUTOMATIC_KEEPS_WINDOW : capWindowUpdate(await capWindowBaseline(deps, task), task);
  const receivedAt = iso(deps);
  try {
    await withCurrentThreadNotes(deps, task, input.requestId, (current, notes) => {
      const fed = fedThroughUpdate(notes);
      return deps.actions.acceptTask(developerTaskIdentity(current, deps.orgId), current.workspaceId, { requestId: input.requestId, conversationId: current.conversationId, prompt: input.recovery === undefined ? withTestRule(input.prompt(notes.suffix), input.next) : input.prompt(notes.suffix) }, (operation) => [
        { Update: {
          TableName: deps.tableName, Key: taskKey(task.taskId),
          UpdateExpression: `SET workflow = :workflow, updatedAt = :now${fed.clause}${cap.clause}`,
          ConditionExpression: `workflow.revision = :revision AND workflow.#stage = :stage AND workflow.#state = :state AND attribute_not_exists(closedAt)${fed.condition}${input.recovery === undefined ? "" : " AND workflow.blockReason = :recoveryReason AND attribute_not_exists(workflow.candidate) AND workflow.e2e.required = :requiredE2E AND attribute_not_exists(workflow.e2e.currentRoundId) AND workflow.e2e.currentGroupRunIds = :emptyIds AND attribute_not_exists(workflow.e2e.qualifiedRound) AND attribute_not_exists(workflow.e2e.failedRound) AND workflow.e2e.resultRefs = :emptyIds AND workflow.workflowDependenciesOperationId = :graphOperationId AND workflow.workflowDependenciesApproval.graphDigest = :graphDigest AND workflow.workflowDependenciesApproval.runId = :graphRunId AND workflow.workflowDependenciesApproval.artifactDigest = :graphArtifactDigest AND workflow.workflowDependenciesApproval.workflowRevision = :graphApprovalRevision AND workflow.workflowDependenciesApproval.actorId = :graphActorId AND workflow.workflowDependenciesProgress = :graphProgress"}`,
          ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
          ExpressionAttributeValues: { ":workflow": workflowWithCurrentGraphOperation(input.next, input.workflowDependencies === undefined ? undefined : operation.id, input.workflowDependencies), ":now": receivedAt, ":revision": workflow.revision, ":stage": workflow.stage, ":state": workflow.state, ...fed.values, ...cap.values,
            ...(input.recovery === undefined ? {} : { ":recoveryReason": WORKFLOW_MISSING_COMMITTED_SOURCE_EXPORT_REASON, ":requiredE2E": true, ":emptyIds": [],
              ":graphOperationId": input.recovery.sourceOperation.id, ":graphDigest": input.recovery.graphApproval.graphDigest, ":graphRunId": input.recovery.graphApproval.runId,
              ":graphArtifactDigest": input.recovery.graphApproval.artifactDigest, ":graphApprovalRevision": input.recovery.graphApproval.workflowRevision,
              ":graphActorId": input.recovery.graphApproval.actorId, ":graphProgress": workflow.workflowDependenciesProgress ?? [] }) },
        } },
        ...(input.recovery === undefined ? [] : [
          { ConditionCheck: {
            TableName: deps.tableName, Key: operationKey(task.workspaceId, input.recovery.sourceOperation.id),
            ConditionExpression: "#status = :sourceSucceeded AND fence = :sourceFence AND kind = :taskKind AND workflowMode = :implementMode AND workspaceId = :workspaceId AND conversationId = :conversationId AND attribute_not_exists(candidateSourceRef) AND #binding = :sourceBinding AND #result = :sourceResult",
            ExpressionAttributeNames: { "#status": "status", "#binding": "workflowDependencies", "#result": "result" },
            ExpressionAttributeValues: { ":sourceSucceeded": "SUCCEEDED", ":sourceFence": input.recovery.sourceOperation.fence, ":taskKind": "task", ":implementMode": "IMPLEMENT",
              ":workspaceId": task.workspaceId, ":conversationId": task.conversationId, ":sourceBinding": input.recovery.sourceBinding,
              ":sourceResult": input.recovery.sourceOperation.result },
          } },
          putNew(deps.tableName, { pk: `DEVTASK#${task.taskId}`, sk: `WORKFLOW_SOURCE_RECOVERY#${input.recovery.requestId}`, entityType: "WORKFLOW_SOURCE_RECOVERY",
            actorId: input.recovery.actorId, payloadHash: input.recovery.payloadHash, operationId: operation.id, createdAt: receivedAt }),
        ]),
        putNew(turnTable(deps), aiToolTurn({
          party: partyOfTaskActor(task, caller), turnId: randomUUID(), action: "continue", phase: "accepted", outcome: "accepted", receivedAt, finishedAt: iso(deps),
          request: input.request, response: `${input.response} as operation ${operation.id}.`, operationId: operation.id,
        })),
        accessFence(deps, access),
      ], { sharedTask: task.shared === true, workflowMode: "IMPLEMENT", ...selectedCheckCommands(input.next), ...taskBaseOption(task, input.next), ...(input.next.programStepId === undefined ? {} : { programStepId: input.next.programStepId }), ...(input.workflowDependencies === undefined ? {} : { workflowDependencies: input.workflowDependencies }),
        // A retry or a send-back inside a fix to an open pull request is still that fix (Plan 6 Task 15).
        ...(input.next.fixSource === undefined ? {} : { workflowFix: { source: input.next.fixSource } }) });
    });
  } catch (error) {
    if (isConditional(error)) await authorizeTaskAction(deps, caller, task.taskId, "work");
    return busyOrClosing(deps, task, error);
  }
  const fresh = (await authorizeTaskAction(deps, caller, task.taskId, "work")).task;
  const view = await taskView(deps, fresh, { events: 0, details: false });
  await syncIndex(deps, fresh, view.status, view.updatedAt);
  return { task: view };
}

/**
 * Plan 3, Task 34: the run limit of a plan blocked on it was approved (Task 32's `resume: "implement"`). Sets `budgetUsd` to the approved limit and the window
 * at what the task's keys have spent, and starts coding on the approved plan, in the one transaction that moves the workflow. `requestId` (the spend request's)
 * makes the coding operation, so a repeat finds the workflow already moved. "STALE": the task is not blocked on a run limit (closed, moved on, or blocked for
 * another reason), and nothing is written. A proxy that can't say what planning spent refuses (503) before anything is written.
 */
export async function resumeAfterRunLimitApproval(
  deps: DeveloperTaskRouteDependencies, taskId: string, input: { requestId: string; runLimitUsd: number },
): Promise<"STARTED" | "DUPLICATE" | "STALE"> {
  if (!Number.isFinite(input.runLimitUsd) || input.runLimitUsd <= 0) throw agentXError("CONFIG_INVALID", "the approved run limit must be more than zero");
  const task = await get<DeveloperTaskRecord>(deps, taskKey(taskId));
  const workflow = task?.workflow;
  if (task === undefined || task.orgId !== deps.orgId || task.closedAt !== undefined || workflow === undefined || !blockedOnRunLimit(workflow)) return "STALE";
  await creatorGuard(deps, task);
  const dispatchAccess = await systemTaskAccess(deps, task);
  const workspace = await deps.actions.workspace(task.workspaceId);
  if (workspace.status === "CLOSED" || workspace.status === "PREPARATION_FAILED") return "STALE";
  const plan = await approvedCodingPlan(deps, workflow);
  const workflowDependencies = await approvedWorkflowDependencies(deps, task, dispatchAccess?.peopleRevision);
  if (workflowDependencies !== undefined && !workflowDependenciesAllowed(deps, workflow)) {
    throw agentXError("CONFIG_INVALID", "the approved ordered work plan is retained, but this broker is not enabled to start it");
  }
  const baselineUsd = await capWindowBaseline(deps, task) ?? 0;
  const receivedAt = iso(deps);
  const { blockReason: _blockReason, ...unblocked } = workflow;
  void _blockReason;
  const next: WorkflowSnapshot = { ...unblocked, revision: workflow.revision + 1, state: "RUNNING", updatedAt: receivedAt };
  // Rovara Code version 2 ends every build prompt with the test rule (Task 12).
  const prompt = withTestRule(`Implement the human-approved plan below. Follow its ordered steps, run the listed checks, and report results and limitations. ${NO_PUBLISH_NOTE}\n\nApproved plan (sha256 ${plan.sha256}):\n${plan.text}`, next);
  const accepted = await deps.actions.acceptTask(developerTaskIdentity(task, deps.orgId), task.workspaceId, { requestId: input.requestId, conversationId: task.conversationId, prompt }, (operation) => [
    { Update: {
      TableName: deps.tableName, Key: taskKey(task.taskId),
      UpdateExpression: "SET workflow = :workflow, updatedAt = :now, budgetUsd = :runLimit, budgetBaselineUsd = :baseline",
      ConditionExpression: `workflow.revision = :revision AND workflow.#stage = :implement AND workflow.#state = :blocked AND attribute_not_exists(closedAt)${task.budgetUsd === undefined ? " AND attribute_not_exists(budgetUsd)" : " AND budgetUsd = :seenBudget"}`,
      ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
      ExpressionAttributeValues: { ":workflow": workflowWithCurrentGraphOperation(next, workflowDependencies === undefined ? undefined : operation.id, workflowDependencies), ":now": receivedAt,
        ":revision": workflow.revision, ":implement": "IMPLEMENT", ":blocked": "BLOCKED", ":runLimit": input.runLimitUsd, ":baseline": baselineUsd,
        ...(task.budgetUsd === undefined ? {} : { ":seenBudget": task.budgetUsd }) },
    } },
    putNew(turnTable(deps), aiToolTurn({
      party: partyOfTask(task), turnId: randomUUID(), action: "continue", phase: "accepted", outcome: "accepted", receivedAt, finishedAt: iso(deps),
      request: "The run limit was approved", response: `Coding started as operation ${operation.id} once the run limit of $${String(input.runLimitUsd)} was approved.`, operationId: operation.id,
    })),
    ...(dispatchAccess === undefined ? [] : [accessFence(deps, dispatchAccess)]),
  ], { sharedTask: task.shared === true, workflowMode: "IMPLEMENT", ...selectedCheckCommands(next), ...taskBaseOption(task, next), ...(next.programStepId === undefined ? {} : { programStepId: next.programStepId }),
    ...(workflowDependencies === undefined ? {} : { workflowDependencies }) });
  return accepted.duplicate ? "DUPLICATE" : "STARTED";
}

/** Task 16: the owner retries coding that stopped (IMPLEMENT/BLOCKED) on the same approved plan. */
/** The record that a plan check retry took, under its request ID, so a repeat of it is the same retry. */
export const planCheckRetryKey = (taskId: string, requestId: string) => ({ pk: `DEVTASK#${taskId}`, sk: `WORKFLOW_PLAN_CHECK_RETRY#${requestId}` });

/**
 * Plan 6 Task 8: the owner's retry of a plan check that stopped (its model was refused, its answer couldn't be read, its run failed): the same plan is checked again. PLAN_CRITIQUE/BLOCKED becomes
 * READY with its dispatch row in one transaction, conditional on the revision the owner saw, and the check then starts as the dispatch would start it. A repeat of the request finds the check
 * under way (its request ID is derived from the revision) and starts nothing more.
 */
export async function retryPlanCritique(
  deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, access: AuthorizedTask, request: z.infer<typeof ContinueDeveloperTaskRequestSchema>,
): Promise<{ task: DeveloperTaskView }> {
  const { task } = access;
  const workflow = task.workflow!;
  if (request.expectedRevision !== undefined && request.expectedRevision !== workflow.revision) {
    throw agentXError("IDEMPOTENCY_CONFLICT", "this retry is out of date; refresh the task and try again");
  }
  await requireMayGoOn(deps, caller, task);
  await actionableWorkspace(deps, task);
  const { blockReason: _blockReason, ...unblocked } = workflow;
  void _blockReason;
  const receivedAt = iso(deps);
  const next: WorkflowSnapshot = { ...unblocked, revision: workflow.revision + 1, state: "READY", updatedAt: receivedAt };
  try {
    await deps.actions.transact([{ Update: {
      TableName: deps.tableName, Key: taskKey(task.taskId),
      UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
      ConditionExpression: "workflow.revision = :revision AND workflow.#stage = :critique AND workflow.#state = :blocked AND attribute_not_exists(closedAt)",
      ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
      ExpressionAttributeValues: { ":workflow": next, ":now": receivedAt, ":revision": workflow.revision, ":critique": "PLAN_CRITIQUE", ":blocked": "BLOCKED" },
    } }, workflowDispatchItem(deps.tableName, task.taskId, next.revision, "CRITIQUE", WORKFLOW_NO_CANDIDATE_DIGEST, receivedAt),
    putNew(deps.tableName, { ...planCheckRetryKey(task.taskId, request.requestId), entityType: "WORKFLOW_PLAN_CHECK_RETRY", actorId: access.actorId, at: receivedAt }), accessFence(deps, access)]);
  } catch (error) {
    if (isConditional(error)) {
      const fresh = (await authorizeTaskAction(deps, caller, task.taskId, "retry")).task;
      // A repeat of the same retry: the check is already under way (or done).
      if (fresh.workflow !== undefined && fresh.workflow.revision > workflow.revision) return { task: await taskView(deps, fresh, { events: 0, details: false }) };
      throw agentXError("IDEMPOTENCY_CONFLICT", "this retry is out of date; refresh the task and try again");
    }
    return busyOrClosing(deps, task, error);
  }
  await startAcceptedStep(deps, task.taskId, next, "CRITIQUE");
  const fresh = (await authorizeTaskAction(deps, caller, task.taskId, "retry")).task;
  const view = await taskView(deps, fresh, { events: 0, details: false });
  await syncIndex(deps, fresh, view.status, view.updatedAt);
  return { task: view };
}

/** The record that a CI fix retry took, under its request ID, so a repeat of it is the same retry. */
export const ciFixRetryKey = (taskId: string, requestId: string) => ({ pk: `DEVTASK#${taskId}`, sk: `WORKFLOW_CI_FIX_RETRY#${requestId}` });

/**
 * Plan 6 Task 15: the owner's Retry of a CI fix that waited for a person (Rovara is set to suggest, three fixes did not make CI pass, or a fix changed nothing). The task waits for the merge
 * again with the go-ahead recorded, and the tracking row is woken so the next pass starts the fix (a start is a tracking pass's own decision: it reads what CI says now). One transaction,
 * conditional on the revision the owner saw, with the request's record.
 */
export async function retryCiFix(
  deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, access: AuthorizedTask, request: z.infer<typeof ContinueDeveloperTaskRequestSchema>,
): Promise<{ task: DeveloperTaskView }> {
  const { task } = access;
  const workflow = task.workflow!;
  if (request.expectedRevision !== undefined && request.expectedRevision !== workflow.revision) {
    throw agentXError("IDEMPOTENCY_CONFLICT", "this retry is out of date; refresh the task and try again");
  }
  await requireMayGoOn(deps, caller, task);
  const receivedAt = iso(deps);
  let next: WorkflowSnapshot;
  try {
    // Plan 6 Task 17: the same Retry answers the ask about a conflict (Rovara is set to suggest).
    next = isBranchConflictAskReason(workflow.blockReason) || isBranchSyncGiveUpReason(workflow.blockReason) ? retryWorkflowBranchSync(workflow, receivedAt) : retryWorkflowCiFix(workflow, receivedAt);
  } catch (error) {
    if (error instanceof WorkflowTransitionError) throw agentXError("CONFIG_INVALID", error.message);
    throw error;
  }
  try {
    await deps.actions.transact([{ Update: {
      TableName: deps.tableName, Key: taskKey(task.taskId),
      UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
      ConditionExpression: "workflow.revision = :revision AND workflow.#stage = :wait AND workflow.#state = :blocked AND attribute_not_exists(closedAt)",
      ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
      ExpressionAttributeValues: { ":workflow": next, ":now": receivedAt, ":revision": workflow.revision, ":wait": "WAIT_FOR_MERGE", ":blocked": "BLOCKED" },
    } }, putNew(deps.tableName, { ...ciFixRetryKey(task.taskId, request.requestId), entityType: "WORKFLOW_CI_FIX_RETRY", actorId: access.actorId, at: receivedAt }), accessFence(deps, access)]);
  } catch (error) {
    if (isConditional(error)) {
      const fresh = (await authorizeTaskAction(deps, caller, task.taskId, "retry")).task;
      if (fresh.workflow !== undefined && fresh.workflow.revision > workflow.revision) return { task: await taskView(deps, fresh, { events: 0, details: false }) };
      throw agentXError("IDEMPOTENCY_CONFLICT", "this retry is out of date; refresh the task and try again");
    }
    return busyOrClosing(deps, task, error);
  }
  // The fix starts at the next tracking pass; the row is woken so that is soon (a failure here only means the pass comes at its own time).
  await wakeTrackingRow({ documentClient: deps.documentClient, tableName: deps.tableName, now: () => deps.now() }, task.taskId).catch(() => undefined);
  const fresh = (await authorizeTaskAction(deps, caller, task.taskId, "retry")).task;
  const view = await taskView(deps, fresh, { events: 0, details: false });
  await syncIndex(deps, fresh, view.status, view.updatedAt);
  return { task: view };
}

export async function retryWorkflowImplementation(
  deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, access: AuthorizedTask, request: z.infer<typeof ContinueDeveloperTaskRequestSchema>,
): Promise<{ task: DeveloperTaskView }> {
  const { task } = access;
  const workflow = task.workflow!;
  if (blockedOnRunLimit(workflow)) throw agentXError("CONFIG_INVALID", RUN_LIMIT_NOT_APPROVED_REFUSAL);
  if (request.expectedRevision !== undefined && request.expectedRevision !== workflow.revision) {
    throw agentXError("IDEMPOTENCY_CONFLICT", "this retry is out of date; refresh the task and try again");
  }
  await requireMayGoOn(deps, caller, task);
  await actionableWorkspace(deps, task);
  // Plan 6 Task 15: a CI fix that stopped before it finished is told again what CI said, so the run that goes on has it in its own prompt, not only in the conversation (and needs no plan text).
  const ciBlock = workflow.fixSource === "ci" && sendBackProblems(workflow).length === 0 ? await readLatestCiEvidence(deps, task.taskId, task.orgId) : undefined;
  // Plan 6 Task 17: and a conflict round that stopped is told which files conflicted (the workspace still holds the merge's files).
  // Plan 6 Task 16: a round of fixes to review comments that stopped goes on from the current code, keeping to the findings it was given; its scope is those findings, not the plan again.
  const feedbackRound = workflow.fixSource === "feedback" && sendBackProblems(workflow).length === 0;
  const conflictFix = workflow.fixSource === "conflict" && sendBackProblems(workflow).length === 0;
  const plan = ciBlock === undefined && !conflictFix && !feedbackRound ? await approvedCodingPlan(deps, workflow) : undefined;
  const workflowDependencies = await approvedWorkflowDependencies(deps, task, access.peopleRevision);
  if (workflowDependencies !== undefined && !workflowDependenciesAllowed(deps, workflow)) {
    throw agentXError("CONFIG_INVALID", "the approved ordered work plan is retained, but this broker is not enabled to retry it");
  }
  const { blockReason: _blockReason, ...unblocked } = workflow;
  void _blockReason;
  const next: WorkflowSnapshot = { ...unblocked, revision: workflow.revision + 1, state: "RUNNING", updatedAt: iso(deps) };
  const prompt = (notes: string): string => {
    if (conflictFix) {
      return `${conflictFixPrompt({ paths: workflow.fixProblems ?? [], notes: NO_PUBLISH_NOTE })}\n\nThe previous coding run stopped before it finished; continue from the current code.\n\nOwner note: ${request.instructions}${notes}`;
    }
    if (plan === undefined && feedbackRound) {
      return `The previous coding run stopped before it finished; continue fixing the PR feedback findings you were given, from the current code, and change nothing else. ${NO_PUBLISH_NOTE}\n\nOwner note: ${request.instructions}${notes}`;
    }
    if (plan === undefined) {
      return `${ciFixPrompt({ block: ciBlock ?? "", notes: NO_PUBLISH_NOTE })}\n\nThe previous coding run stopped before it finished; continue from the current code.\n\nOwner note: ${request.instructions}${notes}`;
    }
    return `Implement the human-approved plan below. The previous coding run stopped before it finished; continue from the current code. Follow its ordered steps, run the listed checks, and report results and limitations. ${NO_PUBLISH_NOTE}\n\nOwner note: ${request.instructions}${ownerConstraintsSection(workflow, plan)}\n\nApproved plan (sha256 ${plan.sha256}):\n${plan.text}${notes}`;
  };
  return queueWorkflowCoding(deps, caller, { ...access, task: { ...task, workflow } }, { requestId: request.requestId, prompt, next,
    request: request.instructions, response: workflowDependencies === undefined ? "Restarting the coding step" : "Restarting the approved ordered work plan", ...(workflowDependencies === undefined ? {} : { workflowDependencies }) });
}

/**
 * Task 16: the owner sends blocked work (failed checks, introduced review findings, coding that stopped) or a change
 * ready to publish back to coding. The coder gets the problems to fix, the owner's note, the approved plan and any
 * thread replies not yet given to a step; the checks and reviews then run again on its new code. Owner only, at the
 * exact current revision; a repeated request answers with the run it started.
 */
export async function sendTaskWorkflowBackToCoding(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, value: unknown): Promise<{ task: DeveloperTaskView }> {
  const request = parse(ContinueDeveloperTaskRequestSchema, value, deps, "workflow-send-back");
  const access = await authorizeTaskAction(deps, caller, taskId, "work");
  const { task } = access;
  const workflow = task.workflow;
  if (workflow === undefined) throw agentXError("NOT_FOUND", "this task does not have a workflow record");
  if (blockedOnRunLimit(workflow)) throw agentXError("CONFIG_INVALID", RUN_LIMIT_NOT_APPROVED_REFUSAL);
  const prior = workflow.decisions.find((decision) => decision.requestId === request.requestId);
  if (prior !== undefined) {
    if (prior.source !== "SEND_BACK") throw agentXError("IDEMPOTENCY_CONFLICT", "this request ID was already used for another decision on this task; use a new one");
    return { task: await taskView(deps, task, { events: 0, details: false }) };
  }
  if (request.expectedRevision === undefined) throw agentXError("CONFIG_INVALID", "refresh the task and include its current revision before sending it back to coding");
  if (request.expectedRevision !== workflow.revision) throw agentXError("IDEMPOTENCY_CONFLICT", "this send-back is out of date; refresh the task and try again");
  await requireMayGoOn(deps, caller, task);
  if (!workflowSendBackOffered(workflow)) {
    throw agentXError("CONFIG_INVALID", "there is no current failed check or review finding to send back to coding");
  }
  const receivedAt = iso(deps);
  let returned: WorkflowSnapshot;
  try {
    returned = returnWorkflowToImplementation(workflow, { requestId: request.requestId, actorId: access.actorId, reason: request.instructions, now: receivedAt }, access.authority);
  } catch (error) {
    if (error instanceof WorkflowTransitionError) throw agentXError("CONFIG_INVALID", error.message);
    throw error;
  }
  await actionableWorkspace(deps, task);
  const plan = await approvedCodingPlan(deps, workflow);
  const workflowDependencies = await approvedWorkflowDependencies(deps, task, access.peopleRevision);
  if (workflowDependencies !== undefined && !workflowDependenciesAllowed(deps, workflow)) {
    throw agentXError("CONFIG_INVALID", "the approved ordered work plan is retained, but this broker is not enabled to continue it");
  }
  const restartApprovedGraph = workflowDependencies === undefined ? undefined : {
    ...workflowDependencies,
    resumeTreeSha: workflowDependencies.resumeTreeSha,
    sequenceStart: workflow.workflowDependenciesProgress?.at(-1)?.sequence ?? workflowDependencies.sequenceStart ?? 0,
    resumeProgress: [],
  };
  // The problems are reviewer and check output, marked untrusted; the owner's note stays outside, as the instruction.
  const problems = sendBackProblemsPromptSection(sendBackProblems(workflow, E2E_OWNER_SENTENCES.groupSentence), promptTagId(task, request.requestId));
  const prompt = (notes: string) => `Address the problems below in the code, keeping to the approved plan. ${NO_PUBLISH_NOTE}\n\n${problems}\n\nOwner note (the owner's own instructions for this step): ${request.instructions}${ownerConstraintsSection(workflow, plan)}\n\nApproved plan (sha256 ${plan.sha256}):\n${plan.text}${notes}`;
  const next: WorkflowSnapshot = { ...returned, revision: returned.revision + 1, state: "RUNNING", updatedAt: receivedAt };
  return queueWorkflowCoding(deps, caller, { ...access, task: { ...task, workflow } }, { requestId: request.requestId, prompt, next,
    request: request.instructions, response: workflowDependencies === undefined ? "AgentX sent the change back to coding" : "AgentX restarted the approved ordered work plan",
    ...(restartApprovedGraph === undefined ? {} : { workflowDependencies: restartApprovedGraph }) });
}

/**
 * The owner answers each blocking review finding: accept it with a reason, or have it fixed (with optional
 * instructions). A fix returns the task to coding as a send-back does, but the coder is given only the findings to fix
 * and their instructions. With every finding accepted and no other review problem, the draft pull request is due as it
 * is after a passing review. Owner only, at the exact revision and candidate; a repeated request answers as the first.
 */
export async function resolveTaskWorkflowFindings(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, value: unknown): Promise<{ task: DeveloperTaskView }> {
  const request = parse(WorkflowResolveFindingsInputSchema, value, deps, "workflow-review-findings");
  const access = await authorizeTaskAction(deps, caller, taskId, "decide");
  const { task } = access;
  const workflow = task.workflow;
  if (workflow === undefined) throw agentXError("NOT_FOUND", "this task does not have a workflow record");
  const prior = workflow.decisions.find((decision) => decision.requestId === request.requestId);
  if (prior !== undefined) {
    if (prior.source !== "FINDINGS") throw agentXError("IDEMPOTENCY_CONFLICT", "this request ID was already used for another decision on this task; use a new one");
    return { task: await taskView(deps, task, { events: 0, details: false }) };
  }
  if (request.expectedRevision !== workflow.revision || workflow.candidate?.digest !== request.candidateDigest) {
    throw agentXError("IDEMPOTENCY_CONFLICT", "these findings are out of date; refresh the task and try again");
  }
  const receivedAt = iso(deps);
  let next: WorkflowSnapshot;
  try {
    next = resolveWorkflowReviewFindings(workflow, request, { actorId: access.actorId }, { now: receivedAt }, access.authority);
  } catch (error) {
    if (error instanceof WorkflowTransitionError) throw agentXError("CONFIG_INVALID", error.message);
    throw error;
  }
  // Only a finding the owner asked to have fixed returns the task to coding with the findings as the problems. With every
  // finding accepted, a program may still land at a coding step: that one is the program step's own work, started below.
  if (next.stage === "IMPLEMENT" && request.resolutions.some((resolution) => resolution.action === "FIX")) {
    await actionableWorkspace(deps, task);
    const plan = await approvedCodingPlan(deps, workflow);
    const workflowDependencies = await approvedWorkflowDependencies(deps, task, access.peopleRevision);
    if (workflowDependencies !== undefined && !workflowDependenciesAllowed(deps, workflow)) {
      throw agentXError("CONFIG_INVALID", "the approved ordered work plan is retained, but this broker is not enabled to continue it");
    }
    const restartApprovedGraph = workflowDependencies === undefined ? undefined : {
      ...workflowDependencies,
      resumeTreeSha: next.candidate?.repositories.length === 1 ? next.candidate.repositories[0]!.treeSha : workflowDependencies.resumeTreeSha,
      sequenceStart: workflow.workflowDependenciesProgress?.at(-1)?.sequence ?? workflowDependencies.sequenceStart ?? 0,
      resumeProgress: [],
    };
    const answers = new Map(request.resolutions.map((resolution) => [resolution.findingId, resolution]));
    const toFix = openReviewFindings(workflow).filter((finding) => answers.get(finding.findingId)?.action === "FIX");
    // The findings are reviewer output, marked untrusted; the owner's instructions are theirs, so they stand outside, numbered as the findings are.
    const problems = sendBackProblemsPromptSection(toFix.map((finding) => workflowFindingProblem(finding.role, finding)), promptTagId(task, request.requestId));
    const instructions = toFix.flatMap((finding, index) => {
      const note = answers.get(finding.findingId)?.note ?? "";
      return note === "" ? [] : [`${index + 1}. ${note}`];
    });
    const ownerNotes = instructions.length === 0 ? "none beyond fixing the problems." : `\n${instructions.join("\n")}`;
    const prompt = (notes: string) => `Address only the problems below in the code, keeping to the approved plan. ${NO_PUBLISH_NOTE}\n\n${problems}\n\nOwner instructions for these problems (the owner's own instructions for this step; the numbers follow the order the problems are listed in): ${ownerNotes}${ownerConstraintsSection(workflow, plan)}\n\nApproved plan (sha256 ${plan.sha256}):\n${plan.text}${notes}`;
    const running: WorkflowSnapshot = { ...next, revision: next.revision + 1, state: "RUNNING", updatedAt: receivedAt };
    return queueWorkflowCoding(deps, caller, { ...access, task: { ...task, workflow } }, { requestId: request.requestId, prompt, next: running,
      request: `Fix ${toFix.length} review finding${toFix.length === 1 ? "" : "s"}`, response: workflowDependencies === undefined ? "AgentX sent the findings to fix back to coding" : "AgentX restarted the approved ordered work plan for the review findings",
      ...(restartApprovedGraph === undefined ? {} : { workflowDependencies: restartApprovedGraph }) });
  }
  // Every finding accepted. When the reviews now stand, the next step is due: the draft pull request, committed with the
  // decision as a passing review's result commits it (so a lost start is the recovery sweep's); or, in a custom sequence,
  // the next review or coding step, or the end of the sequence.
  const ready = next.stage === "PULL_REQUEST" && next.state === "READY" && next.candidate !== undefined;
  const due: WorkflowDispatchRecord["kind"] | undefined = ready ? (workflowPullRequestUpdateDue(next) ? "UPDATE" : "PUBLISH")
    : next.program === undefined ? undefined
    : next.stage === "REVIEW" && next.state === "WAITING" && next.candidate !== undefined ? "REVIEW"
    : next.stage === "IMPLEMENT" && next.state === "READY" ? "IMPLEMENT"
    : undefined;
  const dueDigest = next.candidate?.digest ?? WORKFLOW_NO_CANDIDATE_DIGEST;
  try {
    await deps.actions.transact([{ Update: {
      TableName: deps.tableName, Key: taskKey(taskId),
      UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
      ConditionExpression: "workflow.revision = :revision AND workflow.#stage = :stage AND workflow.#state = :state AND workflow.candidate.digest = :candidate AND attribute_not_exists(closedAt)",
      ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
      ExpressionAttributeValues: { ":workflow": next, ":now": receivedAt, ":revision": workflow.revision, ":stage": "REVIEW", ":state": "BLOCKED", ":candidate": request.candidateDigest },
    } }, ...(due === undefined ? [] : [workflowDispatchItem(deps.tableName, taskId, next.revision, due, dueDigest, receivedAt)]), accessFence(deps, access)]);
  } catch (error) {
    if (isConditional(error)) {
      await authorizeTaskAction(deps, caller, taskId, "decide");
      throw agentXError("IDEMPOTENCY_CONFLICT", "these findings are out of date; refresh the task and try again");
    }
    throw error;
  }
  if (due !== undefined) await startAcceptedStep(deps, taskId, next, due);
  // A sequence that has no step left is finished, so the task no longer takes owner actions: read it back as a terminal answer is.
  const fresh = (await (next.stage === "CLOSED" ? authorizeTaskActor(deps, caller, taskId, "decide") : authorizeTaskAction(deps, caller, taskId, "decide"))).task;
  const view = await taskView(deps, fresh, { events: 0, details: false });
  await syncIndex(deps, fresh, view.status, view.updatedAt);
  return { task: view };
}

/**
 * Start the step the owner's answer made due now, as the dispatcher would, and drop the dispatch row once the start was
 * answered: the draft pull request, or a custom sequence's next review or coding step. A start that fails (the workspace
 * is busy, say) leaves the row for the recovery sweep, and the owner's retry also works from here.
 */
async function startAcceptedStep(deps: DeveloperTaskRouteDependencies, taskId: string, ready: WorkflowSnapshot, kind: WorkflowDispatchRecord["kind"]): Promise<void> {
  const candidateDigest = ready.candidate?.digest;
  try {
    if (kind === "IMPLEMENT") await startTaskWorkflowImplementationFromSystem(deps, taskId, { workflowRevision: ready.revision });
    else if (kind === "CRITIQUE") await startTaskWorkflowPlanCritiqueFromSystem(deps, taskId, { workflowRevision: ready.revision });
    else if (candidateDigest === undefined) return;
    else if (kind === "REVIEW") await startTaskWorkflowReviewFromSystem(deps, taskId, { workflowRevision: ready.revision, candidateDigest });
    else {
      await startTaskWorkflowPublicationFromSystem(deps, taskId, { workflowRevision: ready.revision, candidateDigest },
        { ...(deps.issuer === undefined ? {} : { taskPageUrl: taskPageUrl(deps.issuer, taskId) }) });
    }
    await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: { pk: WORKFLOW_DISPATCH_PK, sk: `${taskId}#${ready.revision}` } }));
  } catch (error) {
    log(deps, { event: kind === "PUBLISH" || kind === "UPDATE" ? "developer.task_publication_start_deferred" : "developer.task_step_start_deferred", taskId, error: error instanceof Error ? error.name : "unknown",
      ...(error instanceof AgentXError ? { code: error.code } : {}) });
  }
}

/** Re-drive only the task's current terminal revision and, when present, its exact manifest candidate. */
export async function retryTaskCanvasCloseout(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, value: unknown): Promise<{ status: "retry_requested"; workflowRevision: number; manifestDigest?: string }> {
  const request = parse(CanvasCloseoutRetryRequestSchema, value, deps, "canvas-closeout-retry");
  const access = await authorizeTaskActor(deps, caller, taskId, "close");
  const { task } = access;
  const closeout = task.workflow?.canvasCloseout;
  const attempt = task.workflow?.canvasCloseoutAttempt;
  const workflowRevision = task.workflow?.revision;
  if (task.workflow === undefined || workflowRevision !== request.workflowRevision) {
    throw agentXError("IDEMPOTENCY_CONFLICT", "the requested closeout workflow revision is no longer current");
  }
  const terminal = (task.workflow.stage === "MERGED" && task.workflow.state === "COMPLETE" && task.workflow.outcome === "MERGED")
    // The CLOSED stage ends complete whatever its outcome (in practice REJECTED: the owner rejected the plan).
    || (task.workflow.stage === "CLOSED" && task.workflow.state === "COMPLETE")
    || (task.closedAt !== undefined && task.workflow.stage !== "MERGED");
  if (!terminal) throw agentXError("CONFIG_INVALID", "Canvas closeout can only be retried for a terminal task");
  if (closeout !== undefined) {
    if (closeout.status !== "ARCHIVE_PENDING" || request.manifestDigest !== closeout.manifestDigest) {
      throw agentXError("IDEMPOTENCY_CONFLICT", "the requested closeout manifest is not the task's current pending snapshot");
    }
  } else if (attempt === undefined || attempt.workflowRevision !== request.workflowRevision
    || (attempt.candidateManifestDigest === undefined ? request.manifestDigest !== undefined : request.manifestDigest !== attempt.candidateManifestDigest)) {
    throw agentXError("IDEMPOTENCY_CONFLICT", "the requested closeout preparation attempt is no longer current");
  }
  const existing = task.canvasCloseoutRetry;
  if (existing?.requestId === request.requestId && (existing.manifestDigest !== request.manifestDigest || existing.workflowRevision !== workflowRevision)) {
    throw agentXError("IDEMPOTENCY_CONFLICT", "this request_id was already used for a different closeout snapshot");
  }
  const retry = { requestId: request.requestId, workflowRevision, ...(request.manifestDigest === undefined ? {} : { manifestDigest: request.manifestDigest }),
    actorId: access.actorId, requestedAt: iso(deps), dispatchAttempt: (existing?.dispatchAttempt ?? 0) + 1 };
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [{ Update: {
      TableName: deps.tableName, Key: taskKey(taskId), UpdateExpression: "SET canvasCloseoutRetry = :retry",
      ConditionExpression: `workflow.revision = :revision AND ${task.canvasCloseoutVersion === undefined ? "attribute_not_exists(canvasCloseoutVersion)" : "canvasCloseoutVersion = :version"}`,
      ExpressionAttributeValues: { ":retry": retry, ":revision": workflowRevision,
        ...(task.canvasCloseoutVersion === undefined ? {} : { ":version": task.canvasCloseoutVersion }) },
    } }, accessFence(deps, access)] }));
    return { status: "retry_requested", workflowRevision, ...(request.manifestDigest === undefined ? {} : { manifestDigest: request.manifestDigest }) };
  } catch (error) {
    if (!isConditional(error)) throw error;
    const fresh = (await authorizeTaskActor(deps, caller, taskId, "close")).task;
    if (fresh.canvasCloseoutRetry?.requestId === request.requestId && fresh.canvasCloseoutRetry.workflowRevision === workflowRevision
      && fresh.canvasCloseoutRetry.manifestDigest === request.manifestDigest
      && fresh.canvasCloseoutRetry.dispatchAttempt >= retry.dispatchAttempt) {
      return { status: "retry_requested", workflowRevision, ...(request.manifestDigest === undefined ? {} : { manifestDigest: request.manifestDigest }) };
    }
    throw agentXError("WORKSPACE_BUSY", "the task closeout changed while requesting its retry; refresh the task and try again");
  }
}
