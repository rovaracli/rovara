import { WORKFLOW_ACTIONABLE_REFUSALS } from "../../developer/workflow-actions.js";
import { randomUUID } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  ContinueDeveloperTaskRequestSchema,
  createCandidateManifest,
  WorkflowDependencyResultSchema,
  agentXError,
  type DeveloperTaskView,
  type Operation,
  type WorkflowSnapshot,
  WorkflowSnapshotSchema,
  workflowSelectedChecks,
  WORKFLOW_BLOCK_REASONS,
  workflowApplicationRetryOffered,
  e2eApplicationSelectionFingerprint,
  e2eApplicationAccountChanges,
  type E2EApplicationReapproval,
  WORKFLOW_MISSING_COMMITTED_SOURCE_EXPORT_REASON,
  canonicalJson,
  taskGraphDigest,
  workflowRequestId,
  workflowPublicationRetryable,
  WORKFLOW_AGENTX_ACTOR_ID,
  workflowReadmitsApplicationRound,
  type WorkflowDependencyInvocation,
  type E2EApplicationSelectionRecord,
  workflowVerificationPosition,
  isCiFixBlockReason,
  isStepNotRunReason,
  isBranchConflictAskReason,
  isBranchSyncGiveUpReason,
} from "@agentx/contracts";
import { workflowDependenciesAllowed } from "../../rovara-code/parallel-parts.js";
import { aiToolTurn, developerTaskIdentity, partyOfTask, taskKey, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { recoverStrandedPlanning, strandedPlanningRun } from "../workflow-cancel-reconcile.js";
import { hashJson, isConditional, workflowDispatchItem } from "../broker-shared.js";
import type { TransactItems } from "../developer-task-actions.js";
import type { DeveloperCaller } from "../developer-routes.js";
import { isRuntimeRenewedBlock, requireRenewalOnlyReapproval } from "../../e2e/requalify-hold.js";
import { understandPrompt } from "../../rovara-code/understand.js";
import type { DeveloperTaskRouteDependencies } from "./types.js";
import { creatorGuard, get, iso, parse, partyOfTaskActor, putNew, taskBaseOption, turnTable } from "./common.js";
import { type AuthorizedTask, accessFence, authorizeTaskAction, systemTaskAccess } from "./access.js";
import { resumeParkedTaskDispatch } from "./access-resume.js";
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
  keptProposedIds,
  planUnreadablePrompt,
  retiredClaimIdList,
} from "./workflow-inputs.js";
import { ciFixRetryKey, planCheckRetryKey, queueWorkflowCoding, retryCiFix, retryPlanCritique, retryWorkflowImplementation } from "./workflow-coding.js";
import { designResolveBlocked, retryDesignResolve } from "./design-resolve-retry.js";
import { REDIRECT_DROPPED_RETRY_NOTE, carriedRedirect } from "./redirect-carry.js";
import { framedPlanningInstruction } from "./redirect-frame.js";
import { type AutomaticRetry, automaticRetryDecision, queueWorkflowUnderstand } from "./workflow-starts.js";
import { fedThroughUpdate, withCurrentThreadNotes } from "./thread-notes.js";
import { requireNewWorkAllowed } from "../../developer/project-roles.js";
import { requireProjectSendBackRole } from "../../developer/task-access.js";

/**
 * Plan self-check: the planner's automatic second run. A plan that parsed but failed AgentX's own checks (or an answer that could
 * not be read) was not shown to the owner; the workflow stayed in planning, one revision on, and this starts the planner again with
 * `prompt` (the findings, or what was unreadable). Answers STALE unless the task is open and still planning at exactly the expected
 * revision. The request ID is derived from the task, that revision and the prompt, so a recovered or repeated dispatch is the
 * broker's duplicate of the first. WORKSPACE_BUSY and WORKSPACE_NOT_READY propagate so the dispatcher tries again later.
 */
export async function startTaskWorkflowPlanRevisionFromSystem(
  deps: DeveloperTaskRouteDependencies,
  taskId: string,
  expected: { workflowRevision: number; promptDigest: string },
  prompt: string,
): Promise<"STARTED" | "DUPLICATE" | "STALE"> {
  const task = await get<DeveloperTaskRecord>(deps, taskKey(taskId));
  const workflow = task?.workflow;
  if (task === undefined || task.closedAt !== undefined || workflow === undefined
    || workflow.revision !== expected.workflowRevision || workflow.stage !== "PLAN" || workflow.state !== "RUNNING") return "STALE";
  await creatorGuard(deps, task);
  const dispatchAccess = await systemTaskAccess(deps, task);
  const workspace = await deps.actions.workspace(task.workspaceId);
  if (workspace.status === "CLOSED" || workspace.status === "PREPARATION_FAILED" || workspace.status === "CLOSING") return "STALE";
  const receivedAt = iso(deps);
  const next: WorkflowSnapshot = { ...workflow, revision: workflow.revision + 1, updatedAt: receivedAt };
  const retired = await retiredClaimIdList(deps, workflow);
  const requestId = workflowRequestId("agentx-auto-plan-revision", taskId, expected.workflowRevision, expected.promptDigest);
  const accepted = await deps.actions.acceptTask(developerTaskIdentity(task, deps.orgId), task.workspaceId, { requestId, conversationId: task.conversationId, prompt }, (operation) => [
    { Update: {
      TableName: deps.tableName, Key: taskKey(taskId),
      UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
      ConditionExpression: "workflow.revision = :revision AND workflow.#stage = :plan AND workflow.#state = :running AND attribute_not_exists(closedAt)",
      ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
      ExpressionAttributeValues: { ":workflow": next, ":now": receivedAt, ":revision": workflow.revision, ":plan": "PLAN", ":running": "RUNNING" },
    } },
    putNew(turnTable(deps), aiToolTurn({
      party: partyOfTask(task), turnId: randomUUID(), action: "continue", phase: "accepted", outcome: "accepted", receivedAt, finishedAt: iso(deps),
      request: "Check and correct the coding plan", response: `Planning started again automatically as operation ${operation.id}.`, operationId: operation.id,
    })),
    ...(dispatchAccess === undefined ? [] : [accessFence(deps, dispatchAccess)]),
  ], { sharedTask: task.shared === true, workflowMode: "PLAN", ...(retired.length === 0 ? {} : { retiredClaimIds: retired }), ...(next.reviewPhase === undefined ? {} : { workflowPhase: next.reviewPhase }) });
  return accepted.duplicate ? "DUPLICATE" : "STARTED";
}

/** `afterRecovery`: this call is the one retryTaskWorkflow makes itself once it has blocked a stranded planning step; it never recovers twice. */
export async function retryTaskWorkflow(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, value: unknown, afterRecovery = false, automatic?: AutomaticRetry): Promise<{ task: DeveloperTaskView }> {
  const request = parse(ContinueDeveloperTaskRequestSchema, value, deps, "workflow-retry");
  const access = await authorizeTaskAction(deps, caller, taskId, "retry");
  const { task } = access;
  // Ruling R60, first: before the E2E branch writes its dispatch row, so the removal's reason wins.
  await creatorGuard(deps, task);
  // S2 (any path): a person's Retry of any step restarts agent work for them, so it meets the send-back's project access rule and the archive check at this one entry. Rovara's own retry (AUTOFIX)
  // runs as the owner but is judged by the autofix policy and the creator check, not as a person's press.
  if (automatic === undefined) await requireProjectSendBackRole(deps, task, caller);
  const recoveryHash = hashJson({ action: "committed-source-recovery", taskId, actorId: access.actorId, request });
  const recoveryKey = { pk: `DEVTASK#${taskId}`, sk: `WORKFLOW_SOURCE_RECOVERY#${request.requestId}` };
  const priorRecovery = await get<{ payloadHash: string; actorId: string; operationId: string }>(deps, recoveryKey);
  if (priorRecovery !== undefined) {
    if (priorRecovery.actorId !== access.actorId || priorRecovery.payloadHash !== recoveryHash) {
      throw agentXError("IDEMPOTENCY_CONFLICT", "this retry request ID was already used for a different recovery request");
    }
  }
  // Plan 6 Task 8: a repeat of a plan check retry that already took finds the check under way and starts nothing more (another person's request ID is not it).
  const priorCheckRetry = await get<{ actorId: string }>(deps, planCheckRetryKey(taskId, request.requestId));
  if (priorCheckRetry !== undefined) {
    if (priorCheckRetry.actorId !== access.actorId) throw agentXError("IDEMPOTENCY_CONFLICT", "this retry request ID was already used by someone else");
    return { task: await taskView(deps, task, { events: 0, details: false }) };
  }
  // Plan 6 Task 15: a repeat of a CI fix retry that already took finds the fix on its way and changes nothing (another person's request ID is not it).
  const priorCiFixRetry = await get<{ actorId: string }>(deps, ciFixRetryKey(taskId, request.requestId));
  if (priorCiFixRetry !== undefined) {
    if (priorCiFixRetry.actorId !== access.actorId) throw agentXError("IDEMPOTENCY_CONFLICT", "this retry request ID was already used by someone else");
    return { task: await taskView(deps, task, { events: 0, details: false }) };
  }
  const resumed = await resumeParkedTaskDispatch(deps, caller, access, request, automatic === undefined);
  if (resumed !== undefined) return resumed;
  if (priorRecovery !== undefined) {
    return { task: await taskView(deps, task, { events: 0, details: false }) };
  }
  const priorVerificationRetry = task.workflow?.verificationRetries?.find((retry) => retry.requestId === request.requestId);
  if (priorVerificationRetry !== undefined) {
    const submittedIds = request.selectedOptionalCheckIds ?? task.workflow?.checkPolicy?.selectedOptionalIds ?? [];
    const submittedProposedIds = request.selectedProposedCheckIds ?? keptProposedIds(task.workflow?.checkPolicy);
    if (priorVerificationRetry.actorId !== access.actorId
      || JSON.stringify(priorVerificationRetry.selectedOptionalCheckIds) !== JSON.stringify(submittedIds)
      || JSON.stringify(priorVerificationRetry.selectedProposedCheckIds ?? keptProposedIds(task.workflow?.checkPolicy)) !== JSON.stringify(submittedProposedIds)) {
      throw agentXError("IDEMPOTENCY_CONFLICT", "this retry request ID was already used for a different check selection");
    }
    return { task: await taskView(deps, task, { events: 0, details: false }) };
  }
  if (task.workflow !== undefined && isMissingCommittedSourceRecovery(task.workflow)) {
    const policy = task.workflow.checkPolicy;
    if (request.candidateDigest !== undefined
      || (request.selectedOptionalCheckIds !== undefined
        && canonicalJson(request.selectedOptionalCheckIds) !== canonicalJson(policy?.selectedOptionalIds ?? []))
      || (request.selectedProposedCheckIds !== undefined
        && canonicalJson(request.selectedProposedCheckIds) !== canonicalJson(keptProposedIds(policy)))) {
      throw agentXError("IDEMPOTENCY_CONFLICT", "this recovery cannot change the candidate or approved check selection");
    }
    // An archived project takes no new work (f1beb9980: lifecycle restarts are refused; 48707cdb8: Rovara's own retry ends that dispatch on it): before the recovery reads or queues anything.
    await requireNewWorkAllowed(deps, deps.orgId, task.project, "contributor", "task");
    const recovery = await loadCommittedSourceRecovery(deps, access, request.expectedRevision);
    await queueWorkflowCoding(deps, caller, { ...access, task: { ...task, workflow: task.workflow } }, {
      requestId: request.requestId,
      prompt: (notes) => `Finalize the approved implementation from the retained completed work only. Do not edit or repair the code, do not rerun any implementation step, and do not change the retained repository tree. Create the required committed-source export for the exact retained tree, then run the approved final checks and report the result. ${NO_PUBLISH_NOTE}\n\nOwner note: ${request.instructions}${notes}`,
      next: { ...withoutWorkflowBlockReason(task.workflow), revision: task.workflow.revision + 1, stage: "IMPLEMENT", state: "RUNNING", updatedAt: iso(deps) },
      request: request.instructions,
      response: "Finalizing the exact retained implementation",
      workflowDependencies: recovery.invocation,
      recovery: { sourceOperation: recovery.operation, sourceBinding: recovery.binding, graphApproval: recovery.invocation.approval, graphProgress: recovery.invocation.resumeProgress!,
        payloadHash: recoveryHash, actorId: access.actorId, requestId: request.requestId },
    });
    const fresh = (await authorizeTaskAction(deps, caller, taskId, "retry")).task;
    const view = await taskView(deps, fresh, { events: 0, details: false });
    await syncIndex(deps, fresh, view.status, view.updatedAt);
    return { task: view };
  }
  // Task 16: the checks run again from blocked verification, or on a change ready to publish whose code changed.
  if (task.workflow !== undefined && ((task.workflow.stage === "VERIFY" && task.workflow.state === "BLOCKED")
    || (workflowPublicationRetryable(task.workflow) && (task.workflow.pullRequests?.length ?? 0) === 0))) {
    const workflow = task.workflow;
    // The checks run again as a new CHECKS run (or a native E2E round): an archived project takes no new work, whoever retries (Rovara's own retry ends that dispatch, 48707cdb8).
    await requireNewWorkAllowed(deps, deps.orgId, task.project, "contributor", "task");
    if (request.expectedRevision === undefined) {
      throw agentXError("CONFIG_INVALID", "refresh the task and include its current revision before retrying verification");
    }
    if (request.expectedRevision !== workflow.revision) {
      throw agentXError("IDEMPOTENCY_CONFLICT", "the verification retry is stale; refresh the task and choose checks again");
    }
    const policy = workflow.checkPolicy;
    const selectedOptionalIds = request.selectedOptionalCheckIds ?? policy?.selectedOptionalIds ?? [];
    if (policy === undefined || selectedOptionalIds.some((id) => !policy.optional.some((check) => check.id === id))) {
      throw agentXError("CONFIG_INVALID", "choose checks that are approved for this project");
    }
    // The owner may remove a proposed check (say, one whose program the worker lacks), never add one: only ids the
    // approved plan proposed.
    const selectedProposedIds = request.selectedProposedCheckIds ?? keptProposedIds(policy);
    if (selectedProposedIds.some((id) => !policy.proposed.some((check) => check.id === id))) {
      throw agentXError("CONFIG_INVALID", WORKFLOW_ACTIONABLE_REFUSALS.retryOnlyProposedChecks);
    }
    const selected = workflowSelectedChecks({ ...policy, selectedOptionalIds, selectedProposedIds });
    // An application round's retry re-admits the approved browser and API checks; it runs no project check, so a task that has none can still retry it.
    const readmitsApplicationRound = workflowReadmitsApplicationRound(workflow);
    if (selected.length === 0 && !readmitsApplicationRound) throw agentXError("CONFIG_INVALID", WORKFLOW_ACTIONABLE_REFUSALS.retryNeedsOneCheck);
    await actionableWorkspace(deps, task);
    // MONEY (mainline #408 sync; owner ruling pending): a person's retry starts a new cap window (R38), Rovara's own retry (AUTOFIX) does not, and does not go on over a pause that waits for an approval.
    if (automatic === undefined) await requireMayGoOn(deps, caller, task); else refuseAutomaticWhilePaused(task);
    const cap = automatic === undefined ? capWindowUpdate(await capWindowBaseline(deps, task), task) : AUTOMATIC_KEEPS_WINDOW;
    const receivedAt = iso(deps);
    // AUTOFIX: Rovara's own retry (never the plan's re-approval, which only the owner gives) records its decision in the same write as the retry.
    const autoDecision = automatic === undefined ? undefined : automaticRetryDecision(workflow, "VERIFY", automatic, receivedAt);
    const retryActorId = automatic === undefined ? access.actorId : WORKFLOW_AGENTX_ACTOR_ID;
    const { blockReason: _previousBlockReason, ...unblocked } = workflow;
    void _previousBlockReason;
    const next: WorkflowSnapshot = {
      ...unblocked,
      revision: workflow.revision + 1,
      stage: "VERIFY",
      state: "RUNNING",
      ...workflowVerificationPosition(workflow),
      checkPolicy: { ...policy, selectedOptionalIds, selectedProposedIds },
      verificationRetries: [...(workflow.verificationRetries ?? []), {
        requestId: request.requestId, actorId: retryActorId, selectedOptionalCheckIds: selectedOptionalIds, selectedProposedCheckIds: selectedProposedIds, at: receivedAt,
      }],
      ...(autoDecision === undefined ? {} : { decisions: [...workflow.decisions, autoDecision] }),
      updatedAt: receivedAt,
    };
    const selectedReadiness = selected.map((check) => check.command);
    // Required managed E2E retries must pass through the same server-owned admission
    // dispatcher as the first VERIFY round. An ordinary CHECKS operation here would
    // rerun project commands while leaving the canceled/failed native round stale.
    if (workflow.e2e?.required === true) {
      if (workflow.candidate === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the required E2E retry has no current candidate");
      const { blockReason: _previousBlockReason, verification: _previousVerification, reviews: _previousReviews, ...retryBase } = workflow;
      const { qualifiedRound: _qualifiedRound, failedRound: _failedRound, currentRoundId: _currentRoundId,
        currentGroupRunIds: _currentGroupRunIds, displayRef: _displayRef, ...unqualifiedE2E } = workflow.e2e;
      void _previousBlockReason;
      void _previousVerification;
      void _previousReviews;
      void _qualifiedRound;
      void _failedRound;
      void _currentRoundId;
      void _currentGroupRunIds;
      void _displayRef;
      // The owner's retry after a block of an application round re-approves the plan: whether the approved selection changed (a runtime row was requalified), the
      // runtime was unusable until an administrator qualified it again, or the round was refused, one retry once the cause is fixed derives the plan's own canonical
      // v2 intent again exactly as plan approval does and records the new selection. The dispatch comparison stays byte-exact; nothing is loosened, and a plan that
      // cannot be approved now is refused here with the reason, changing nothing. Every re-approval is appended to `applicationReapprovals` (actor, reason, old and new
      // selection digests), never overwritten.
      let reapproved: { selection: E2EApplicationSelectionRecord; conditions: TransactItems } | undefined;
      let reapproval: E2EApplicationReapproval | undefined;
      if (workflow.e2e.applicationSelection !== undefined && workflowApplicationRetryOffered(workflow)) {
        // Approving the plan again against the runtime that is ready now is the owner's authority: Rovara's own retry never does it, except after a mere renewal of the test machine (AUTOREQUALIFY).
        if (automatic !== undefined && !isRuntimeRenewedBlock(workflow.blockReason)) throw agentXError("CONFIG_INVALID", "this block needs the owner to approve the plan again; it is not retried automatically");
        const planArtifact = workflow.artifacts.filter((entry) => entry.type === "plan").at(-1);
        const intent = (await approvedCodingPlan(deps, workflow)).e2eIntent;
        if (planArtifact === undefined || workflow.e2e.contractDigest !== planArtifact.sha256 || intent?.schemaVersion !== 2) {
          throw agentXError("CONFIG_INVALID", "the approved plan no longer carries the application intent this round was approved for; send the task back to coding or close it");
        }
        if (deps.validateWorkflowE2EApplicationPlan === undefined) {
          throw agentXError("RUNTIME_UNAVAILABLE", "the plan cannot be approved again here: the check against the approved setup and the ready runtimes is not installed");
        }
        reapproved = await deps.validateWorkflowE2EApplicationPlan({ task, intent, artifact: { id: planArtifact.id, sha256: planArtifact.sha256 }, reapproval: true });
        if (automatic !== undefined) requireRenewalOnlyReapproval(workflow.e2e.applicationSelection, reapproved.selection);
        const accountChanges = e2eApplicationAccountChanges(workflow.e2e.applicationSelection, reapproved.selection);
        reapproval = { requestId: request.requestId, actorId: retryActorId, reason: request.instructions.slice(0, 500), at: receivedAt,
          previous: e2eApplicationSelectionFingerprint(workflow.e2e.applicationSelection), current: e2eApplicationSelectionFingerprint(reapproved.selection),
          ...(accountChanges.length === 0 ? {} : { accounts: accountChanges }) };
      }
      const next = WorkflowSnapshotSchema.parse({
        ...retryBase,
        revision: workflow.revision + 1,
        stage: "VERIFY",
        state: "WAITING",
        checkPolicy: { ...policy, selectedOptionalIds, selectedProposedIds },
        e2e: { ...unqualifiedE2E, currentGroupRunIds: [],
          ...(reapproved === undefined || reapproval === undefined ? {} : { applicationSelection: reapproved.selection,
            applicationReapprovals: [...(workflow.e2e.applicationReapprovals ?? []), reapproval].slice(-20) }) },
        verificationRetries: [...(workflow.verificationRetries ?? []), {
          requestId: request.requestId, actorId: retryActorId, selectedOptionalCheckIds: selectedOptionalIds,
          selectedProposedCheckIds: selectedProposedIds, at: receivedAt,
        }],
        ...(autoDecision === undefined ? {} : { decisions: [...workflow.decisions, autoDecision] }),
        updatedAt: receivedAt,
      });
      try {
        await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
          { Update: {
            TableName: deps.tableName, Key: taskKey(taskId),
            UpdateExpression: `SET workflow = :workflow, updatedAt = :now${cap.clause}`,
            ConditionExpression: "workflow.revision = :revision AND workflow.#state = :state AND workflow.#stage = :stage AND workflow.e2e.required = :required AND attribute_not_exists(closedAt)",
            ExpressionAttributeNames: { "#state": "state", "#stage": "stage" },
            ExpressionAttributeValues: { ":workflow": next, ":now": receivedAt, ":revision": workflow.revision,
              ":state": workflow.state, ":stage": workflow.stage, ":required": true, ...cap.values },
          } },
          putNew(turnTable(deps), aiToolTurn({
            party: partyOfTaskActor(task, caller), turnId: randomUUID(), action: "continue", phase: "accepted", outcome: "accepted",
            receivedAt, finishedAt: iso(deps), request: request.instructions,
            response: reapproval === undefined
              ? "The owner authorized a fresh verification round. AgentX is rechecking the current approved source and runtime before dispatch."
              : `The owner approved the plan again against the runtime that is ready now (selection ${reapproval.previous.selectionDigest} replaced by ${reapproval.current.selectionDigest}). AgentX is rechecking the current approved source and runtime before dispatch.`,
          })),
          workflowDispatchItem(deps.tableName, taskId, next.revision, "CHECKS", workflow.candidate.digest, receivedAt),
          // The rows the new approval was derived from must still be exactly those when it commits.
          ...(reapproved?.conditions ?? []),
          accessFence(deps, access),
        ] }));
      } catch (error) {
        if (isConditional(error)) await authorizeTaskAction(deps, caller, taskId, "retry");
        return busyOrClosing(deps, task, error);
      }
      const fresh = (await authorizeTaskAction(deps, caller, taskId, "retry")).task;
      const view = await taskView(deps, fresh, { events: 0, details: false });
      await syncIndex(deps, fresh, view.status, view.updatedAt);
      return { task: view };
    }
    try {
      await deps.actions.acceptTask(developerTaskIdentity(task, deps.orgId), task.workspaceId, {
        requestId: request.requestId, conversationId: task.conversationId,
        prompt: `Owner-authorized verification retry. Run only the selected project checks against the current code, without editing files. Owner note: ${request.instructions}`,
      }, (operation) => [
        { Update: {
          TableName: deps.tableName, Key: taskKey(taskId),
          UpdateExpression: `SET workflow = :workflow, updatedAt = :now${cap.clause}`,
          ConditionExpression: "workflow.revision = :revision AND workflow.#state = :state AND workflow.#stage = :stage AND attribute_not_exists(closedAt)",
          ExpressionAttributeNames: { "#state": "state", "#stage": "stage" },
          ExpressionAttributeValues: { ":workflow": next, ":now": receivedAt, ":revision": workflow.revision, ":state": workflow.state, ":stage": workflow.stage, ...cap.values },
        } },
        putNew(turnTable(deps), aiToolTurn({
          party: partyOfTaskActor(task, caller), turnId: randomUUID(), action: "continue", phase: "accepted", outcome: "accepted",
          receivedAt, finishedAt: iso(deps), request: request.instructions,
          response: `AgentX is rerunning the selected checks without code-editing tools as operation ${operation.id}.`, operationId: operation.id,
        })),
        accessFence(deps, access),
      ], { sharedTask: task.shared === true, workflowMode: "CHECKS", readiness: selectedReadiness, ...taskBaseOption(task, next), ...(next.programStepId === undefined ? {} : { programStepId: next.programStepId }) });
    } catch (error) {
      if (isConditional(error)) await authorizeTaskAction(deps, caller, taskId, "retry");
      return busyOrClosing(deps, task, error);
    }
    const fresh = (await authorizeTaskAction(deps, caller, taskId, "retry")).task;
    const view = await taskView(deps, fresh, { events: 0, details: false });
    await syncIndex(deps, fresh, view.status, view.updatedAt);
    return { task: view };
  }
  // A repeated planning or coding retry finds the run it started and starts nothing new, wherever the task is now: even
  // blocked again at a later step, which the same request must not retry a second time.
  const replayed = task.workflow === undefined ? undefined
    : (await deps.actions.operations(task.workspaceId)).find((operation) => operation.requestId === request.requestId
      && (operation.workflowMode === "IMPLEMENT" || operation.workflowMode === "PLAN" || operation.workflowMode === "UNDERSTAND"));
  if (replayed !== undefined) return { task: await taskView(deps, task, { events: 0, details: false }) };
  // PLANINC-2: planning still RUNNING although its run ended and nothing holds the workspace (a stop recorded before the cancel
  // fix, or a release that never reached the workflow) is blocked first, in one transaction conditional on the same row,
  // workspace and run, so the ordinary Retry planning below applies to it. Nothing else changes: no approval, no dispatch.
  if (!afterRecovery && task.workflow !== undefined && task.workflow.stage === "PLAN" && task.workflow.state === "RUNNING") {
    const [workspace, runs] = await Promise.all([deps.actions.workspace(task.workspaceId), deps.actions.operations(task.workspaceId)]);
    const stopped = strandedPlanningRun(task, workspace, runs);
    if (stopped !== undefined) {
      if (request.expectedRevision !== undefined && request.expectedRevision !== task.workflow.revision) {
        throw agentXError("IDEMPOTENCY_CONFLICT", "this retry is out of date; refresh the task and try again");
      }
      // False means something moved first (another retry won, the workspace was taken, the run changed): the re-read below decides.
      await recoverStrandedPlanning(deps.documentClient, deps.tableName, { taskId, workflow: task.workflow }, workspace, stopped, iso(deps));
      const fresh = (await authorizeTaskAction(deps, caller, taskId, "retry")).task;
      if (fresh.workflow?.stage !== "PLAN" || fresh.workflow.state !== "BLOCKED") {
        throw agentXError("IDEMPOTENCY_CONFLICT", "this task changed while the retry was starting; refresh the task and try again");
      }
      // The owner saw the revision the stranded step had; the block moved it on by one.
      return retryTaskWorkflow(deps, caller, taskId, request.expectedRevision === undefined ? value : { ...(value as Record<string, unknown>), expectedRevision: fresh.workflow.revision }, true);
    }
  }
  // An archived project takes no new work: a CI fix or branch sync Retry starts agent work, so it is refused before that branch is taken (not only after it).
  if (task.workflow?.stage === "WAIT_FOR_MERGE" && task.workflow.state === "BLOCKED") await requireNewWorkAllowed(deps, deps.orgId, task.project, "contributor", "task");
  // Plan 6 Task 15: a CI fix that waited for a person (suggest), ran out of rounds or changed nothing goes on at the owner's Retry.
  if (task.workflow?.stage === "WAIT_FOR_MERGE" && task.workflow.state === "BLOCKED" && (isCiFixBlockReason(task.workflow.blockReason) || isBranchConflictAskReason(task.workflow.blockReason) || isBranchSyncGiveUpReason(task.workflow.blockReason) || isStepNotRunReason(task.workflow.blockReason))) return retryCiFix(deps, caller, access, request);
  // A lifecycle restart is new agent work, unlike Continue or an existing workflow decision.
  // Contributor intentionally checks only archive here; authorizeTaskAction owns the live role check.
  await requireNewWorkAllowed(deps, deps.orgId, task.project, "contributor", "task");
  if (task.workflow?.stage === "IMPLEMENT" && task.workflow.state === "BLOCKED") {
    // A run a redirect restarted that failed: a plain Retry gives the owner's instruction again (LR-2); it starts a new cap window as any Retry does.
    const carried = await carriedRedirect(deps, task);
    // An instruction whose author may no longer redirect is dropped, and the run note says so (S1).
    return retryWorkflowImplementation(deps, caller, access, carried?.kind === "dropped" ? { ...request, instructions: `${request.instructions} ${REDIRECT_DROPPED_RETRY_NOTE}` } : request,
      carried?.kind === "carry" ? { ownerRedirect: carried.ownerRedirect, skipNoteIds: [carried.record.messageId], keepWindow: false } : undefined);
  }
  if (task.workflow?.stage === "UNDERSTAND" && task.workflow.state === "BLOCKED") return retryWorkflowUnderstand(deps, caller, access, request);
  if (task.workflow?.stage === "PLAN_CRITIQUE" && task.workflow.state === "BLOCKED") return retryPlanCritique(deps, caller, access, request);
  // Design review: a blocked planner run that was answering the reviewers' findings resumes the review (`resumeBlockedDesignReview`) and runs again; it is never restarted as a plain planning run.
  if (designResolveBlocked(task.workflow)) return retryDesignResolve(deps, caller, access, request);
  if (task.workflow === undefined || task.workflow.state !== "BLOCKED" || task.workflow.stage !== "PLAN") {
    throw agentXError("CONFIG_INVALID", "this action can retry blocked planning or coding, or run selected checks for blocked verification or a change ready to publish");
  }
  if (request.expectedRevision !== undefined && request.expectedRevision !== task.workflow.revision) {
    throw agentXError("IDEMPOTENCY_CONFLICT", "this retry is out of date; refresh the task and try again");
  }
  await requireMayGoOn(deps, caller, task);
  await actionableWorkspace(deps, task);
  const cap = capWindowUpdate(await capWindowBaseline(deps, task), task);
  const receivedAt = iso(deps);
  const unblocked = { ...task.workflow };
  delete unblocked.blockReason;
  const next: WorkflowSnapshot = { ...unblocked, revision: task.workflow.revision + 1, state: "RUNNING", updatedAt: receivedAt };
  const retired = await retiredClaimIdList(deps, task.workflow);
  // A planning run a redirect restarted that failed: a plain Retry gives the owner's instruction again, framed as data as the restart framed it (LR-2).
  const carried = await carriedRedirect(deps, task);
  const carriedInstruction = carried === undefined ? "" : carried.kind === "dropped" ? `\n\n${REDIRECT_DROPPED_RETRY_NOTE}` : `\n\n${framedPlanningInstruction(task, carried.record.requestId, carried.text)}`;
  // An unreadable answer is retried with what was wrong in it (the planning prompt adds the format instructions).
  const unreadable = task.planUnreadable;
  const retryInstructions = unreadable !== undefined && task.workflow.blockReason === WORKFLOW_BLOCK_REASONS.planUnreadable && unreadable.workflowRevision === task.workflow.revision
    ? planUnreadablePrompt(unreadable.errors) : request.instructions;
  try {
    await withCurrentThreadNotes(deps, task, request.requestId, (current, notes) => {
      const fed = fedThroughUpdate(notes);
      // A version 2 plan that has Understand's findings is asked with what the first plan run is asked (the request, the assumptions, the people's answers), then the retry's text: a plan
      // that never ran (cancelled, or its start failed) would otherwise start without them.
      const understood = current.workflow?.definitionVersion === "1.1.0" && current.workflow.intent?.assessment?.kind === "ready"
        ? `${understandPrompt({ requestText: current.requestText ?? "", intent: current.workflow.intent, notes: "", forPlan: true })}\n\n` : "";
      return deps.actions.acceptTask(developerTaskIdentity(current, deps.orgId), current.workspaceId, { requestId: request.requestId, conversationId: current.conversationId, prompt: understood + retryInstructions + carriedInstruction + notes.suffix }, (operation) => [
        { Update: {
          TableName: deps.tableName, Key: taskKey(taskId),
          UpdateExpression: `SET workflow = :workflow, updatedAt = :now${fed.clause}${cap.clause}`,
          ConditionExpression: `workflow.revision = :revision AND workflow.#state = :blocked AND workflow.#stage = :plan${fed.condition}`,
          ExpressionAttributeNames: { "#state": "state", "#stage": "stage" },
          ExpressionAttributeValues: { ":workflow": next, ":now": receivedAt, ":revision": task.workflow!.revision, ":blocked": "BLOCKED", ":plan": "PLAN", ...fed.values, ...cap.values },
        } },
        putNew(turnTable(deps), aiToolTurn({
          party: partyOfTaskActor(task, caller), turnId: randomUUID(), action: "continue", phase: "accepted", outcome: "accepted", receivedAt, finishedAt: iso(deps),
          request: request.instructions, response: `Restarting the planning stage as operation ${operation.id}.`, operationId: operation.id,
        })),
        accessFence(deps, access),
      ], { sharedTask: task.shared === true, workflowMode: "PLAN", ...(retired.length === 0 ? {} : { retiredClaimIds: retired }), ...(next.reviewPhase === undefined ? {} : { workflowPhase: next.reviewPhase }) });
    });
  } catch (error) {
    if (isConditional(error)) await authorizeTaskAction(deps, caller, taskId, "retry");
    return busyOrClosing(deps, task, error);
  }
  const fresh = (await authorizeTaskAction(deps, caller, taskId, "retry")).task;
  const view = await taskView(deps, fresh, { events: 0, details: false });
  await syncIndex(deps, fresh, view.status, view.updatedAt);
  return { task: view };
}

/**
 * Plan 6 Task 4: the owner's retry of a blocked Understand (and a spend approval's resume of one that ran out of its planning limit): it runs again with the same labelled prompt. The cap
 * window is renewed as a planning retry's is.
 */
async function retryWorkflowUnderstand(
  deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, access: AuthorizedTask, request: { requestId: string; instructions: string; expectedRevision?: number | undefined },
): Promise<{ task: DeveloperTaskView }> {
  const { task } = access;
  const workflow = task.workflow!;
  if (request.expectedRevision !== undefined && request.expectedRevision !== workflow.revision) {
    throw agentXError("IDEMPOTENCY_CONFLICT", "this retry is out of date; refresh the task and try again");
  }
  await requireMayGoOn(deps, caller, task);
  await actionableWorkspace(deps, task);
  const cap = capWindowUpdate(await capWindowBaseline(deps, task), task);
  try {
    // An Understand run a redirect restarted that failed: a plain Retry gives the owner's instruction again, framed (LR-2).
    const carried = await carriedRedirect(deps, task);
    await queueWorkflowUnderstand(deps, task, {
      requestId: request.requestId, access, actor: caller, cap, request: request.instructions, response: "Restarting the understanding step",
      ...(carried === undefined ? {} : { redirect: carried.kind === "dropped" ? { instruction: REDIRECT_DROPPED_RETRY_NOTE, skipNoteIds: [] } : { instruction: framedPlanningInstruction(task, carried.record.requestId, carried.text), skipNoteIds: [carried.record.messageId] } }),
    });
  } catch (error) {
    if (isConditional(error)) await authorizeTaskAction(deps, caller, task.taskId, "retry");
    return busyOrClosing(deps, task, error);
  }
  const fresh = (await authorizeTaskAction(deps, caller, task.taskId, "retry")).task;
  const view = await taskView(deps, fresh, { events: 0, details: false });
  await syncIndex(deps, fresh, view.status, view.updatedAt);
  return { task: view };
}

function withoutWorkflowBlockReason(workflow: WorkflowSnapshot): WorkflowSnapshot {
  const { blockReason: _blockReason, ...unblocked } = workflow;
  void _blockReason;
  return unblocked;
}

function isMissingCommittedSourceRecovery(workflow: WorkflowSnapshot): boolean {
  const e2e = workflow.e2e;
  return workflow.stage === "VERIFY" && workflow.state === "BLOCKED"
    && workflow.blockReason === WORKFLOW_MISSING_COMMITTED_SOURCE_EXPORT_REASON
    && workflow.candidate === undefined && e2e?.required === true
    && e2e.currentRoundId === undefined && e2e.currentGroupRunIds.length === 0
    && e2e.qualifiedRound === undefined && e2e.failedRound === undefined && e2e.resultRefs.length === 0;
}

async function loadCommittedSourceRecovery(
  deps: DeveloperTaskRouteDependencies,
  access: AuthorizedTask,
  expectedRevision: number | undefined,
): Promise<{ operation: Operation; binding: WorkflowDependencyInvocation; invocation: WorkflowDependencyInvocation }> {
  const { task } = access;
  const workflow = task.workflow;
  if (workflow === undefined || !isMissingCommittedSourceRecovery(workflow)) throw agentXError("CONFIG_INVALID", "this task is not eligible for retained-source recovery");
  if (expectedRevision === undefined || expectedRevision !== workflow.revision) {
    throw agentXError("IDEMPOTENCY_CONFLICT", "the recovery request is stale; refresh the task and retry at its current revision");
  }
  await actionableWorkspace(deps, task);
  const invocation = await approvedWorkflowDependencies(deps, task, access.peopleRevision);
  if (invocation === undefined || !workflowDependenciesAllowed(deps, workflow)) {
    throw agentXError("CONFIG_INVALID", "the approved ordered plan is not available for retained-source recovery");
  }
  const operationId = workflow.workflowDependenciesOperationId;
  const operation = operationId === undefined ? undefined : (await deps.actions.operations(task.workspaceId)).find((candidate) => candidate.id === operationId);
  const sourceBinding = operation === undefined ? undefined : await deps.actions.workflowBinding(task.workspaceId, operation.id);
  const sourceExportDigest = operation === undefined ? undefined : await deps.actions.workflowCandidateSourceExportDigest(task.workspaceId, operation.id);
  if (operation === undefined || operation.status !== "SUCCEEDED" || operation.kind !== "task" || operation.workflowMode !== "IMPLEMENT"
    || operation.workspaceId !== task.workspaceId || operation.conversationId !== task.conversationId
    || invocation.graph.taskId !== task.taskId
    || sourceExportDigest !== undefined) {
    throw agentXError("CONFIG_INVALID", "the retained implementation is not an eligible source-export recovery attempt");
  }
  const rawResult = operation.result !== null && typeof operation.result === "object" && !Array.isArray(operation.result)
    ? operation.result as Record<string, unknown> : undefined;
  const sourceRepositories = rawResult?.workflowCandidateRepositories;
  const checkedRepositories = rawResult?.workflowCheckCandidateRepositories;
  const dependencyResult = WorkflowDependencyResultSchema.safeParse(rawResult?.workflowDependenciesResult);
  if (!Array.isArray(sourceRepositories) || !Array.isArray(checkedRepositories) || !dependencyResult.success) {
    throw agentXError("CONFIG_INVALID", "the retained implementation result is missing its source-tree binding");
  }
  const candidate = createCandidateManifest(sourceRepositories as Parameters<typeof createCandidateManifest>[0]);
  const checkedCandidate = createCandidateManifest(checkedRepositories as Parameters<typeof createCandidateManifest>[0]);
  const result = dependencyResult.data;
  const progress = invocation.resumeProgress ?? [];
  const last = progress.at(-1);
  const repository = candidate.repositories.length === 1 ? candidate.repositories[0] : undefined;
  const checkedRepository = checkedCandidate.repositories.length === 1 ? checkedCandidate.repositories[0] : undefined;
  const preparedBase = workflow.reviewBase ?? task.preparedBase;
  const matchingBase = repository === undefined ? undefined : preparedBase?.find((entry) => entry.repositoryId === repository.repositoryId);
  if (operation.fence < 1 || sourceBinding === undefined
    || sourceBinding.graph.taskId !== task.taskId || taskGraphDigest(sourceBinding.graph) !== invocation.approval.graphDigest
    || sourceBinding.approval.graphDigest !== invocation.approval.graphDigest
    || sourceBinding.approval.runId !== invocation.approval.runId
    || sourceBinding.approval.artifactDigest !== invocation.approval.artifactDigest
    || sourceBinding.approval.workflowRevision !== invocation.approval.workflowRevision
    || sourceBinding.approval.actorId !== invocation.approval.actorId
    || result.taskId !== task.taskId || result.operationId !== operation.id || result.status !== "SUCCEEDED"
    || result.graphDigest !== invocation.approval.graphDigest || result.runId !== invocation.approval.runId
    || result.workflowRevision !== invocation.approval.workflowRevision || result.candidateDigest !== candidate.digest
    || canonicalJson(result.items) !== canonicalJson(progress) || progress.length !== invocation.graph.items.length
    || progress.some((entry) => entry.state !== "IMPLEMENTED") || last?.state !== "IMPLEMENTED"
    || repository === undefined || checkedRepository === undefined || candidate.digest !== checkedCandidate.digest
    || repository.treeSha !== invocation.resumeTreeSha || repository.treeSha !== last.candidateTreeSha
    || repository.repositoryId !== invocation.graph.items[0]?.repository || repository.baseCommitSha === undefined
    || matchingBase?.baseCommitSha !== repository.baseCommitSha) {
    throw agentXError("CONFIG_INVALID", "the retained graph result or repository tree changed; approve a refreshed whole coding plan before continuing");
  }
  return { operation, binding: sourceBinding, invocation };
}
