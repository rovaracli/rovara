import { createHash, randomUUID } from "node:crypto";
import { TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  SPEND_RESUME_INSTRUCTIONS,
  ContinueDeveloperTaskRequestSchema,
  DEVELOPER_EVENTS_DEFAULT,
  type OrgId,
  agentXError,
  type DeveloperTaskView,
  WORKFLOW_BLOCK_REASONS,
} from "@agentx/contracts";
import { z } from "zod";
import { taskSpendBaseline } from "../../org/budget.js";
import { chargeItems, developerCharge, readWorkspaceLimits } from "../../developer/limits.js";
import { aiToolTurn, developerTaskIdentity, taskAgentRunKey, taskKey, tryEffectiveTaskOwner, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { GATED_TASK_TURN_REFUSAL, hashJson, isConditional, waitingForAnswersTurnRefusal } from "../broker-shared.js";
import type { TransactItems } from "../developer-task-actions.js";
import type { DeveloperCaller } from "../developer-routes.js";
import { setupWatchKey } from "../stuck-setup.js";
import { resumeTaskDispatch } from "../task-dispatch-access.js";
import { resolveRunPayer } from "../../agents/runs.js";
import { advanceAgentRun } from "../../agents/run-engine.js";
import { onTaskResumed } from "../../agents/task-end.js";
import { openQuestions } from "../../rovara-code/question-answers.js";
import type { DeveloperTaskRouteDependencies } from "./types.js";
import { creatorGuard, get, iso, parse, partyOfTaskActor, putNew, turnTable } from "./common.js";
import { accessFence, authorizeLegacyTaskAction, authorizeTaskAction } from "./access.js";
import { taskView } from "./task-view.js";
import { chargeFailure, limitError } from "./start.js";
import { syncIndex } from "./task-index.js";
import {
  AGENT_RUN_TURN_REFUSAL,
  actionableWorkspace,
  busyOrClosing,
  noteResumedWithOriginal,
  requireMayGoOn,
  staleBudgetPause,
  windowAndPauseUpdate,
} from "./task-window.js";
import { retryTaskWorkflow } from "./workflow-retry.js";
import { resumeAfterRunLimitApproval } from "./workflow-coding.js";
import { AgentRunStateSchema, AgentXError, PER_TASK_BUDGET_USD, ROVARA_CODE_AGENT_ID, type SpendingAdmissionReference, canonicalJson, projectAiKey, recipeRunner } from "@agentx/contracts";
import { Aliases, type TransactItem, failedIndexes } from "../../agents/table-writes.js";
import { type CapturedTaskStop, captureTaskStopAdmission } from "../../org/task-stop-admission.js";
import { type PreparedTaskApprovalAdmission, type TaskStopTransition, checkedTaskMaxPerRun, checkedTaskStopSnapshot, readTaskStopTransition, readTaskStopWindow, taskMaxPerRunForAdmission, taskStopTransitionItems, taskStopTransitionRecoveryChecks, taskStopWindowItems, withAdmittedTaskSource } from "../../org/task-stop-window.js";
import { TaskFundingProofSchema, captureTaskFundingProof, fundingAuditItems, fundingRevisionCheck, taskFundingModelPool } from "../../org/task-stop-funding.js";
import { budgetActorChecks, budgetActorRefused } from "../../agents/budget-authority.js";
import { isDeepStrictEqual } from "node:util";
import { loadOwnedTask } from "./access.js";
import { operationKey } from "../cancellation.js";
import { readTaskRecipe } from "../../agents/runs.js";
import { requireAgentAccess } from "../../agents/access.js";
import { taskRecipeKey } from "../../developer/task-records.js";
import { taskStartAgentAuthorityChecks } from "../../org/task-start-agent-authority.js";
import { taskStartProjectAuthorityChecks } from "../../org/task-start-project-authority.js";
import { usdToWholeMicrodollars } from "../../org/budget-amount.js";

export async function continueTask(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, value: unknown): Promise<{ task: DeveloperTaskView }> {
  const request = parse(ContinueDeveloperTaskRequestSchema, value, deps, "continue");
  const access = await authorizeLegacyTaskAction(deps, caller, taskId, "work");
  const { task } = access;
  // Ruling R60, first: before the busy, workspace and model-proxy refusals, so the removal's reason wins.
  await creatorGuard(deps, task);
  const windowIdentity = { orgId: deps.orgId, taskId: task.taskId, requestId: request.requestId, actorId: caller.developerId,
    intentHash: hashJson({ taskId: task.taskId, actorId: caller.developerId, request }), project: task.project, agentId: task.agent?.agentId ?? ROVARA_CODE_AGENT_ID };
  if (await readTaskStopWindow(deps, windowIdentity) !== undefined) return { task: await taskView(deps, task, { events: 0, details: false }) };
  // Rovara Code asked questions and waits for answers: more instructions cannot answer them, and "approval steps" is not what it waits on.
  if (task.workflow !== undefined && openQuestions(task.workflow).length > 0) throw agentXError("WORKSPACE_BUSY", waitingForAnswersTurnRefusal(task.sessionId));
  if (task.workflow !== undefined) throw agentXError("WORKSPACE_BUSY", GATED_TASK_TURN_REFUSAL);
  if (task.agent !== undefined && await get(deps, taskAgentRunKey(task.taskId)) !== undefined) throw agentXError("WORKSPACE_BUSY", AGENT_RUN_TURN_REFUSAL);
  await requireMayGoOn(deps, caller, task);
  // A plain task whose dispatch was parked (its creator was a project viewer) comes back by continuing it now that they may work again.
  const resumed = await resumeTaskDispatch(deps, {
    task, peopleRevision: access.peopleRevision ?? 0, actorId: access.actorId, requestId: request.requestId, payloadHash: hashJson(request),
    reauthorize: async () => { await authorizeTaskAction(deps, caller, taskId, "work"); },
  });
  if (resumed) {
    await noteResumedWithOriginal(deps, task, request.requestId);
    return { task: await taskView(deps, task, { events: DEVELOPER_EVENTS_DEFAULT, details: false }) };
  }
  const turns = turnTable(deps);
  await actionableWorkspace(deps, task);
  let windowStop: CapturedTaskStop | undefined;
  let windowChecks: TransactItem[] = [];
  if (deps.spendResume === undefined && task.fundingProof === undefined) {
    const previous = task.spendingStop === undefined ? undefined : checkedTaskStopSnapshot(task.spendingStop);
    const pathLimitMicrousd = previous?.calculationInput.approvedRunLimitMicrousd ?? previous?.calculationInput.pathLimitMicrousd ?? usdToWholeMicrodollars(task.budgetUsd ?? PER_TASK_BUDGET_USD);
    const oldBounds = previous?.calculationInput;
    const requestedMicrousd = oldBounds?.requestedMicrousd ?? (task.requestedRunLimitUsd === undefined ? undefined : usdToWholeMicrodollars(task.requestedRunLimitUsd));
    const authorize = async () => { await authorizeTaskAction(deps, caller, taskId, "work"); };
    const captured = await captureTaskStopAdmission({ documentClient: deps.documentClient, tableName: deps.tableName, now: () => deps.now(), requireScopeAccess: authorize }, {
      orgId: deps.orgId, developerId: caller.developerId, role: caller.orgRole, project: task.project, agentId: task.agent?.agentId ?? ROVARA_CODE_AGENT_ID,
      pathLimitMicrousd: pathLimitMicrousd ?? null,
      ...(task.maxPerRunUsd === undefined ? {} : { committedMaxPerRunMicrousd: usdToWholeMicrodollars(task.maxPerRunUsd) ?? null }),
      ...(requestedMicrousd !== undefined ? { requestedMicrousd } : task.requestedRunLimitUsd === undefined ? {} : { requestedMicrousd: null }),
      ...(oldBounds?.chainMicrousd === undefined ? {} : { chainMicrousd: oldBounds.chainMicrousd }), ...(oldBounds?.testingMicrousd === undefined ? {} : { testingMicrousd: oldBounds.testingMicrousd }),
    });
    if (captured.kind === "captured") {
      checkedTaskMaxPerRun(task);
      if (captured.effectiveStopMicrousd === 0) throw agentXError("TASK_STOP_ZERO", "Work can't start: the effective spending stop is $0.");
      if (usdToWholeMicrodollars(captured.effectiveStopMicrousd / 1_000_000) !== captured.effectiveStopMicrousd) throw agentXError("TASK_STOP_CONFIG_INVALID", "The task stop can't be represented exactly. Ask an admin to review Spending.");
      windowStop = captured;
      windowChecks = [...budgetActorChecks(deps.tableName, deps.orgId, { developerId: caller.developerId, role: caller.orgRole }),
        ...await taskStartProjectAuthorityChecks(deps, { orgId: deps.orgId, developerId: caller.developerId, role: caller.orgRole, project: task.project }, authorize)];
      if (deps.agentRuns !== undefined && task.agent !== undefined) {
        const agentId = task.agent.agentId, draft = task.agent.version === "draft";
        windowChecks.push(...await taskStartAgentAuthorityChecks(deps, { orgId: deps.orgId, project: task.project, agentId, draft, process: task.agent.process === true,
          developerId: caller.developerId, role: caller.orgRole, ...(task.agent.draftRevision === undefined ? {} : { expectedDraftRevision: task.agent.draftRevision }) }, async () => {
          await authorize(); if (deps.agentRuns === undefined) throw budgetActorRefused(); await requireAgentAccess(deps.agentRuns, caller, agentId, draft ? "edit" : "use");
        }, async () => { if (deps.agentRuns === undefined) throw budgetActorRefused(); return deps.agentRuns.store.listShares(deps.orgId, agentId); }));
      }
    }
  }
  // Ruling R38: a Continue starts a new window of the task's own cap, at what its keys have spent so far. A proxy that cannot
  // say refuses the Continue before anything is written.
  const baseline = deps.modelAccess === undefined ? undefined
    : await taskSpendBaseline({ documentClient: deps.documentClient, tableName: deps.tableName, access: deps.modelAccess }, task.modelKeyIds ?? []);
  const receivedAt = iso(deps);
  // Task 32: the request the stale pause asked for is withdrawn with it, so a later approval starts no second turn.
  const withdrawal = staleBudgetPause(task) && deps.withdrawSpendRequests !== undefined ? await deps.withdrawSpendRequests(task) : undefined;
  try {
    // acceptTask answers a repeated requestId with its first operation and writes nothing, and
    // refuses a second running turn (TASK_BUSY) before anything is written.
    await deps.actions.acceptTask(developerTaskIdentity(task, deps.orgId), task.workspaceId, { requestId: request.requestId, conversationId: task.conversationId, prompt: request.instructions }, (operation) => [
      ...windowAndPauseUpdate(deps, task, baseline, windowStop, { requestId: windowIdentity.requestId, actorId: windowIdentity.actorId, intentHash: windowIdentity.intentHash }),
      ...windowChecks,
      ...(windowStop === undefined ? [] : taskStopWindowItems(deps.tableName, windowIdentity, windowStop, operation.id, receivedAt, baseline === undefined ? task.budgetBaselineUsd === undefined ? 0 : task.budgetBaselineUsd : baseline)),
      ...(withdrawal?.items ?? []),
      // R12: the accepted record commits with the operation or not at all.
      putNew(turns, aiToolTurn({
        party: partyOfTaskActor(task, caller), turnId: randomUUID(), action: "continue", phase: "accepted", outcome: "accepted", receivedAt, finishedAt: iso(deps),
        request: request.instructions, response: `Continuing task ${taskId} as operation ${operation.id}.`, operationId: operation.id,
      })),
      accessFence(deps, access),
    ], { sharedTask: task.shared === true });
  } catch (error) {
    if (await readTaskStopWindow(deps, windowIdentity) !== undefined) return { task: await taskView(deps, await loadOwnedTask(deps, caller, taskId), { events: 0, details: false }) };
    const windowFailures = error instanceof AgentXError ? (error as { extraCancellation?: string[] }).extraCancellation : undefined;
    if (windowStop !== undefined && windowFailures !== undefined) {
      // acceptTask reports reasons relative to this callback's items. The one
      // task update precedes authority checks; TaskAccess is the final item.
      if (windowFailures.slice(1, 1 + windowChecks.length).includes("ConditionalCheckFailed") || windowFailures.at(-1) === "ConditionalCheckFailed") throw budgetActorRefused();
      if (windowFailures[0] === "ConditionalCheckFailed") throw agentXError("CHANGE_STALE", "The task's spending window changed. Review it and continue again.");
    }
    if (isConditional(error)) await authorizeTaskAction(deps, caller, taskId, "work");
    return busyOrClosing(deps, task, error);
  }
  await withdrawal?.flush();
  const current = windowStop === undefined ? task : await loadOwnedTask(deps, caller, taskId);
  const view = await taskView(deps, current, { events: 0, details: false });
  await syncIndex(deps, current, view.status, view.updatedAt);
  return { task: view };
}

// ---- Plan 3, Task 32: going on after a spend request was approved

/** A request id derived from the spend request (one resume per request, so a repeat of the resume is the same request and starts nothing new, R18). */
function resumeRequestId(spendRequestId: string, what: string): string {
  const hex = createHash("sha256").update(`rovara-spend-resume|${what}|${spendRequestId}`).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = "89ab"[Number.parseInt(hex[16]!, 16) % 4]!;
  const joined = hex.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

/**
 * What a held start's preparation is asked for, the same as its first start asked for (`start.ts`): a checkout list and read-only where it had them, and the setup draft's preparation (the meta
 * repository read, no devcontainer, no setup command) for BOTH a setup draft and a deep diagnosis (DG-1 S4: a held deep diagnosis used to be prepared as an ordinary read-only run).
 */
export function heldPreparationOptions(task: Pick<DeveloperTaskRecord, "purpose">, held: NonNullable<NonNullable<DeveloperTaskRecord["budgetPause"]>["firstDispatch"]>) {
  return {
    ...(held.checkout === undefined ? {} : { checkout: held.checkout }), ...(held.readOnly === true ? { readOnly: true as const } : {}),
    ...(task.purpose === "setup_draft" || task.purpose === "setup_agent" || task.purpose === "nightly_run" || task.purpose === "diagnosis" ? { setupDraft: true as const } : {}),
  };
}

/**
 * A run held at its start (run limit 0) is dispatched now that its limit was raised (Task 15's paused start): in one transaction, conditional on the pause
 * still naming that preparation, the workspace slot is taken, the preparation's outbox item is written (with a new capability and repository grant), its
 * setup watch starts and the pause is removed. The preparation's success then starts the task, or wakes the agent-step engine.
 */
async function dispatchHeldStart(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord, nativeChecks: readonly TransactItem[] = []): Promise<void> {
  const held = task.budgetPause?.firstDispatch;
  if (held === undefined) return;
  const project = await deps.actions.projectRevision(deps.orgId, task.project, task.startingRevision);
  if (project === undefined) throw agentXError("PROJECT_NOT_FOUND", `project \`${task.project}\` revision ${task.startingRevision} is no longer registered`);
  const { workspace, items: outbox } = await deps.actions.preparationDispatch(project, task.workspaceId, held.operationId, task.ownerKey, heldPreparationOptions(task, held));
  const limits = await readWorkspaceLimits(deps.documentClient, deps.tableName, deps.orgId, deps.actions.limitDefaults);
  const charge = task.charge ?? developerCharge({ orgId: deps.orgId, teamId: deps.slackTeamId, slackUserId: task.slackUserId, developerId: task.developerId });
  const items: TransactItems = [
    // First, at positions 0 and 1: chargeConflict reads the cancellation reasons by position.
    ...chargeItems(deps.tableName, charge, limits, task.taskId),
    ...outbox,
    putNew(deps.tableName, { ...setupWatchKey(workspace.createdAt, workspace.id), entityType: "SETUP_WATCH", workspaceId: workspace.id, operationId: held.operationId, taskId: task.taskId, createdAt: workspace.createdAt }),
    { Update: {
      TableName: deps.tableName, Key: taskKey(task.taskId), UpdateExpression: "SET updatedAt = :now REMOVE budgetPause",
      ConditionExpression: "budgetPause.firstDispatch.operationId = :operation AND attribute_not_exists(closedAt)",
      ExpressionAttributeValues: { ":now": iso(deps), ":operation": held.operationId },
    } },
  ];
  let operationBindingIndex: number | undefined;
  if (task.spendingStop !== undefined) {
    if (task.spendingAdmission === undefined) throw agentXError("TASK_STOP_CONFIG_INVALID", "The held spending admission is unavailable.");
    const Key = operationKey(task.workspaceId, held.operationId), operation = await get<Record<string, unknown>>(deps, Key);
    if (operation?.entityType !== "OPERATION" || operation.orgId !== deps.orgId || operation.workspaceId !== task.workspaceId || operation.id !== held.operationId
      || operation.kind !== "prepare" || operation.status !== "ACCEPTED") throw agentXError("CHANGE_STALE", "The held preparation changed.");
    const a = new Aliases();
    const conditions = ["entityType", "orgId", "workspaceId", "id", "kind", "status", "fence", "spendingTaskId", "spendingAdmission"].map(field =>
      operation[field] === undefined ? `attribute_not_exists(${a.name(field)})` : `${a.name(field)} = ${a.value(operation[field])}`);
    operationBindingIndex = items.length;
    items.push({ Update: { TableName: deps.tableName, Key, UpdateExpression: "SET spendingTaskId = :bindingTask, spendingAdmission = :bindingAdmission",
      ConditionExpression: conditions.join(" AND "), ExpressionAttributeNames: a.names,
      ExpressionAttributeValues: { ...a.values, ":bindingTask": task.taskId, ":bindingAdmission": task.spendingAdmission } } });
  }
  const admitted = nativeChecks.length === 0 ? undefined : withAdmittedTaskSource(deps.tableName, task, items);
  const nativeStart = items.length;
  const dispatchItems = [...(admitted?.items ?? items), ...nativeChecks];
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: dispatchItems }));
  } catch (error) {
    const failed = failedIndexes(error);
    if (nativeChecks.length > 0 && [...(failed ?? [])].some(index => index >= nativeStart)) throw budgetActorRefused();
    if (admitted !== undefined && failed?.has(admitted.sourceIndex)) throw agentXError("CHANGE_STALE", "The held preparation's accepted spending source changed. Review it before starting work.");
    if (operationBindingIndex !== undefined && failed?.has(operationBindingIndex)) throw agentXError("CHANGE_STALE", "The held preparation operation changed before dispatch.");
    const conflict = await chargeFailure(deps, charge, task.taskId, error);
    if (conflict === "member" || conflict === "organization") throw await limitError(deps, { developerId: task.developerId } as DeveloperCaller, conflict, limits);
    // Another resume dispatched it first, or the task closed meanwhile: either way there is nothing to dispatch.
    if (isConditional(error)) return;
    throw error;
  }
}

/** The task's owner, as whom the system goes on with it (a retry or a Continue is theirs). */
export interface SpendResumeInput {
  orgId: OrgId;
  taskId: string;
  spendRequestId: string;
  resetRunWindow: boolean;
  firstDispatch: boolean;
  expectedPausedAgentRevision?: number;
  nativeRecoveryChecks?: TransactItems;
  spendingAdmission?: SpendingAdmissionReference;
  /** `"implement"`: the approved request was for a plan blocked on its run limit (Task 34), and `runLimitUsd` is the limit approved. */
  resume?: "implement";
  runLimitUsd?: number;
}

/**
 * `resumeTaskAfterSpendApproval`: the task goes on where it stopped once a spend request raised its limit. A run held at its start is dispatched
 * (`firstDispatch`); an agent-step run runs the same step again (`advanceAgentRun`); a workflow task that the budget stopped runs its stage again (the owner's
 * retry, made by the system); a task with no workflow gets the system's Continue, "Your AI budget was raised. Continue where you stopped." The cap window is
 * reset only where the approval reset it (`resetRunWindow`). A task still paused on another limit, closed, or not the org's is left as it is.
 */
/** Carries an existing approved admission into a workflow's actual paid write.
 * The source condition merges with the workflow's task update, never a second
 * action for that key. Identical native checks are held exactly once. */
function taskStopGuardedPaidDispatch(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord, checks: readonly TransactItem[]): DeveloperTaskRouteDependencies {
  return { ...deps, actions: { ...deps.actions,
    acceptTask: (identity, workspaceId, request, extra, options) => deps.actions.acceptTask(identity, workspaceId, request, (operation) => {
      const items = [...extra(operation)];
      for (const guard of checks) {
        const key = guard.ConditionCheck?.Key;
        const existing = items.find(item => { const other = item.ConditionCheck?.Key ?? item.Update?.Key ?? item.Put?.Item ?? item.Delete?.Key; return key !== undefined && other !== undefined && key.pk === other.pk && key.sk === other.sk; });
        if (existing !== undefined) { if (canonicalJson(existing) !== canonicalJson(guard)) throw budgetActorRefused(); } else items.push(guard);
      }
      return withAdmittedTaskSource(deps.tableName, task, items).items;
    }, options),
  } };
}

export async function resumeTaskAfterSpendApproval(deps: DeveloperTaskRouteDependencies, owner: DeveloperCaller, input: SpendResumeInput): Promise<void | "STALE"> {
  const task = await get<DeveloperTaskRecord>(deps, taskKey(input.taskId));
  if (task === undefined || task.orgId !== deps.orgId || task.orgId !== input.orgId || task.closedAt !== undefined) return;
  // Ruling R60, first: a task whose creator was removed is not resumed, nor a held start dispatched.
  await creatorGuard(deps, task);
  if (input.spendingAdmission !== undefined) {
    if (deps.agentRuns === undefined) throw budgetActorRefused();
    const reference = input.spendingAdmission;
    input = { ...input, nativeRecoveryChecks: await taskStopTransitionRecoveryChecks(deps.agentRuns, task, reference) };
    const receipt = await readTaskStopTransition(deps, { orgId: deps.orgId, taskId: task.taskId, requestId: reference.requestId, actorId: reference.actorId,
      intentHash: reference.intentHash, project: task.project, agentId: task.agent?.agentId ?? ROVARA_CODE_AGENT_ID });
    if (receipt === undefined) throw agentXError("TASK_STOP_CONFIG_INVALID", "The approved spending admission is missing.");
    if (receipt.transitionKind === "spend-approval" && receipt.spendRequestId !== input.spendRequestId) throw agentXError("TASK_STOP_CONFIG_INVALID", "The recovery does not name the approved spending request.");
    if (input.resume === "implement" && (receipt.transitionKind !== "spend-approval" || receipt.workflowRevision === null || usdToWholeMicrodollars(input.runLimitUsd) !== receipt.spendingStop.calculationInput.approvedRunLimitMicrousd)) throw agentXError("TASK_STOP_CONFIG_INVALID", "The implementation limit does not match the approved spending admission.");
    if (receipt.transitionKind === "spend-approval" && receipt.firstDispatch != null) {
      if (task.budgetPause?.firstDispatch === undefined) {
        const workspace = await deps.actions.workspace(task.workspaceId);
        const mark = await get<{ operationId?: string; taskId?: string; workspaceId?: string }>(deps, setupWatchKey(workspace.createdAt, workspace.id));
        if (mark?.operationId === receipt.firstDispatch.operationId && mark.taskId === task.taskId && mark.workspaceId === task.workspaceId) return;
        const completedKey = operationKey(task.workspaceId, receipt.firstDispatch.operationId);
        const completed = await get<Record<string, unknown>>(deps, completedKey);
        if (completed?.pk === completedKey.pk && completed.sk === completedKey.sk && completed.entityType === "OPERATION" && completed.id === receipt.firstDispatch.operationId
          && completed.kind === "prepare" && completed.status === "SUCCEEDED" && completed.workspaceId === task.workspaceId && completed.orgId === deps.orgId) return;
        throw agentXError("TASK_STOP_CONFIG_INVALID", "The approved preparation dispatch could not be verified.");
      }
      input = { ...input, firstDispatch: true };
    }
    if (receipt.agentRunRevision !== null) input = { ...input, expectedPausedAgentRevision: receipt.agentRunRevision };
  }
  if (input.firstDispatch) {
    await dispatchHeldStart(deps, task, input.nativeRecoveryChecks);
    return;
  }
  // A plan blocked on its run limit starts coding by this approval and nothing else (`resumeAfterRunLimitApproval`); a repeat of it is the same request.
  if (input.resume === "implement") {
    if (input.runLimitUsd === undefined) throw agentXError("CONFIG_INVALID", "a run limit approval names the limit it approved");
    // STALE (the plan was not blocked on its run limit any more) is answered, so a caller that counts starts does not count it.
    const guarded = input.spendingAdmission === undefined ? deps : taskStopGuardedPaidDispatch(deps, task, input.nativeRecoveryChecks ?? []);
    return await resumeAfterRunLimitApproval(guarded, task.taskId, { requestId: resumeRequestId(input.spendRequestId, "implement"), runLimitUsd: input.runLimitUsd }) === "STALE" ? "STALE" : undefined;
  }
  if (task.budgetPause !== undefined) return;
  // A chain's step hears that its task went on, so the step and the run show running again before the task ends and a second stop can be told as a pause.
  if (task.chain !== undefined) await onTaskResumed({ documentClient: deps.documentClient, tableName: deps.tableName, now: Date.now }, task);
  const resumed: DeveloperTaskRouteDependencies = { ...deps, spendResume: { keepWindow: !input.resetRunWindow } };
  if (task.agent !== undefined && task.workflow === undefined && await get(deps, taskAgentRunKey(task.taskId)) !== undefined) {
    if (deps.agentEngine === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "agents are not set up in this deployment");
    await advanceAgentRun(deps.agentEngine, task.taskId, input.expectedPausedAgentRevision, input.nativeRecoveryChecks, input.spendingAdmission);
    return;
  }
  const requestId = resumeRequestId(input.spendRequestId, "resume");
  if (task.workflow !== undefined) {
    if (task.workflow.state !== "BLOCKED" || task.workflow.blockReason !== WORKFLOW_BLOCK_REASONS.budgetPaused) return;
    const guarded = input.spendingAdmission === undefined ? resumed : taskStopGuardedPaidDispatch(resumed, task, input.nativeRecoveryChecks ?? []);
    await retryTaskWorkflow(guarded, owner, task.taskId, { requestId, instructions: SPEND_RESUME_INSTRUCTIONS, expectedRevision: task.workflow.revision });
    return;
  }
  // A task with no workflow: the system's Continue (its window is the approval's).
  let paidChecks = input.nativeRecoveryChecks ?? [];
  if (task.spendingStop !== undefined && input.spendingAdmission === undefined) {
    checkedTaskStopSnapshot(task.spendingStop);
    const access = await authorizeTaskAction(deps, owner, task.taskId, "work"), agentId = task.agent?.agentId ?? ROVARA_CODE_AGENT_ID;
    const authorize = async () => {
      await authorizeTaskAction(deps, owner, task.taskId, "work");
      if (deps.agentRuns === undefined) throw budgetActorRefused();
      await requireAgentAccess(deps.agentRuns, owner, agentId, task.agent?.version === "draft" ? "edit" : "use");
    };
    const agentRuns = deps.agentRuns;
    if (agentRuns === undefined) throw budgetActorRefused();
    paidChecks = [...budgetActorChecks(deps.tableName, deps.orgId, { developerId: owner.developerId, role: owner.orgRole }), accessFence(deps, access),
      ...await taskStartProjectAuthorityChecks(deps, { orgId: deps.orgId, developerId: owner.developerId, role: owner.orgRole, project: task.project }, authorize),
      ...await taskStartAgentAuthorityChecks(deps, { orgId: deps.orgId, project: task.project, agentId, draft: task.agent?.version === "draft", frozenRecipe: true,
        process: task.agent?.process === true, developerId: owner.developerId, role: owner.orgRole }, authorize,
        () => agentRuns.store.listShares(deps.orgId, agentId))];
  }
  if (task.spendingStop !== undefined) paidChecks = withAdmittedTaskSource(deps.tableName, task, paidChecks).items;
  await deps.actions.acceptTask(developerTaskIdentity(task, deps.orgId), task.workspaceId, { requestId, conversationId: task.conversationId, prompt: SPEND_RESUME_INSTRUCTIONS }, () => paidChecks, { sharedTask: task.shared === true });
  const fresh = await get<DeveloperTaskRecord>(deps, taskKey(task.taskId));
  if (fresh !== undefined) {
    const view = await taskView(deps, fresh, { events: 0, details: false });
    await syncIndex(deps, fresh, view.status, view.updatedAt);
  }
}

const ContinueAsTaskSchema = z.object({ requestId: z.string().uuid() }).strict();

/**
 * `POST /v1/app/tasks/{id}/continue-as-task` [the task's owner]: a test run that reached its cap goes on as a normal task. It is paid as the owner's own start
 * would be (`resolveRunPayer`, origin `app`), keeps its run limit, and resumes where it stopped; what it spent before stays on the testing allowance (the
 * ledger lines already written name it). Conditional on the test's pause still being there, so a repeat changes nothing; anyone else gets the 404 a task
 * they can't see gets.
 */
/** Server-only preparation: a new approval's money is captured by the spend
 * calculator; this contributes current execution authority and its receipt. */
export async function prepareTaskApprovalAdmission(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller,
  input: { taskId: string; decisionRequestId: string; spendRequestId: string; snapshot: CapturedTaskStop; budgetBaselineUsd: number }): Promise<PreparedTaskApprovalAdmission | undefined> {
  const access = await authorizeTaskAction(deps, caller, input.taskId, "work"), task = access.task;
  // The accepted recipe distinguishes agent-step state from coding/workflow
  // state; every new approved window keeps the same immutable receipt.
  if (task.agent === undefined) return undefined;
  const frozen = await readTaskRecipe(deps, task.taskId, deps.orgId);
  if (frozen === undefined || frozen.digest !== task.agent.digest) throw agentXError("TASK_STOP_CONFIG_INVALID", "The task's accepted recipe could not be checked.");
  const agentSteps = task.workflow === undefined && recipeRunner(frozen.recipe) === "agent_steps";
  const runKey = taskAgentRunKey(task.taskId);
  let run: { revision: number } | undefined;
  if (agentSteps) {
    const raw = await get<Record<string, unknown>>(deps, runKey);
    if (raw === undefined) throw agentXError("TASK_STOP_CONFIG_INVALID", "The paused run's admission state is missing.");
    const parsedRun = AgentRunStateSchema.safeParse(Object.fromEntries(Object.entries(raw).filter(([key]) => !["pk", "sk", "entityType"].includes(key))));
    if (!parsedRun.success || raw.pk !== runKey.pk || raw.sk !== runKey.sk || raw.entityType !== "AGENT_RUN" || parsedRun.data.orgId !== deps.orgId) throw agentXError("TASK_STOP_CONFIG_INVALID", "The paused run's admission state could not be checked.");
    if (parsedRun.data.state !== "PAUSED_BUDGET" || parsedRun.data.revision >= Number.MAX_SAFE_INTEGER) throw agentXError("CHANGE_STALE", "The run's paused step changed. Review it before approving a new window.");
    run = parsedRun.data;
  }
  if (deps.agentRuns === undefined || task.payer === undefined || task.origin === undefined) throw budgetActorRefused();
  await creatorGuard(deps, task);
  const snapshot = checkedTaskStopSnapshot(input.snapshot);
  if (snapshot.effectiveStopMicrousd === 0) throw agentXError("TASK_STOP_ZERO", "Work can't start: the effective spending stop is $0.");
  if (snapshot.orgId !== deps.orgId || snapshot.project !== task.project || snapshot.agentId !== task.agent.agentId) throw budgetActorRefused();
  const authorize = async () => {
    await authorizeTaskAction(deps, caller, task.taskId, "work");
    if (deps.agentRuns === undefined || task.agent === undefined) throw budgetActorRefused();
    await requireAgentAccess(deps.agentRuns, caller, task.agent.agentId, task.agent.version === "draft" ? "edit" : "use");
  };
  const authority = [...budgetActorChecks(deps.tableName, deps.orgId, { developerId: caller.developerId, role: caller.orgRole }), accessFence(deps, access),
    ...await taskStartProjectAuthorityChecks(deps, { orgId: deps.orgId, developerId: caller.developerId, role: caller.orgRole, project: task.project }, authorize),
    ...await taskStartAgentAuthorityChecks(deps, { orgId: deps.orgId, project: task.project, agentId: task.agent.agentId, draft: task.agent.version === "draft", frozenRecipe: true,
      process: task.agent.process === true, developerId: caller.developerId, role: caller.orgRole }, authorize,
      async () => { if (deps.agentRuns === undefined || task.agent === undefined) throw budgetActorRefused(); return deps.agentRuns.store.listShares(deps.orgId, task.agent.agentId); })];
  const identity = { orgId: deps.orgId, taskId: task.taskId, requestId: input.decisionRequestId, actorId: caller.developerId, project: task.project, agentId: task.agent.agentId,
    intentHash: hashJson({ action: "spend-approval", taskId: task.taskId, spendRequestId: input.spendRequestId, requestId: input.decisionRequestId, policyDigest: snapshot.policyDigest }) };
  const reference = { requestId: identity.requestId, actorId: identity.actorId, intentHash: identity.intentHash }, pausedRevision = run === undefined ? null : run.revision + 1;
  return { authority, reference, receiptIndex: run === undefined ? 0 : 1,
    ...(task.workflow === undefined ? {} : { workflowRevision: task.workflow.revision }),
    taskReference: true,
    ...(run === undefined ? {} : { expectedPausedAgentRevision: run.revision + 1, runSourceIndex: 0 }),
    items: [...(run === undefined ? [] : [{ Update: { TableName: deps.tableName, Key: runKey, UpdateExpression: "SET spendingAdmission = :admission, #revision = :nextRevision",
      ConditionExpression: "#revision = :revision AND #state = :state AND orgId = :org AND entityType = :type",
      ExpressionAttributeNames: { "#revision": "revision", "#state": "state" },
      ExpressionAttributeValues: { ":admission": reference, ":nextRevision": pausedRevision, ":revision": run.revision, ":state": "PAUSED_BUDGET", ":org": deps.orgId, ":type": "AGENT_RUN" } } }]),
      ...taskStopTransitionItems(deps.tableName, identity, { transitionKind: "spend-approval", budgetBaselineUsd: input.budgetBaselineUsd, firstDispatch: task.budgetPause?.firstDispatch ?? null, origin: task.origin, spendRequestId: input.spendRequestId, spendingStop: snapshot, payer: task.payer, place: { project: task.project },
        actorRole: caller.orgRole, peopleRevision: access.peopleRevision ?? null, agentRunRevision: pausedRevision, workflowRevision: task.workflow?.revision ?? null, admittedAt: iso(deps) })] };
}

export async function continueAsTask(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, value: unknown): Promise<{ task: DeveloperTaskView }> {
  const request = parse(ContinueAsTaskSchema, value, deps, "continue-as-task");
  const task = await get<DeveloperTaskRecord>(deps, taskKey(taskId));
  if (task === undefined || task.orgId !== deps.orgId || tryEffectiveTaskOwner(task)?.developerId !== caller.developerId) throw agentXError("TASK_NOT_FOUND", `task ${taskId} doesn't exist`);
  await creatorGuard(deps, task);
  const identity = { orgId: deps.orgId, taskId, requestId: request.requestId, actorId: caller.developerId,
    intentHash: hashJson({ taskId, actorId: caller.developerId, action: "continue-as-task", request }), project: task.project, agentId: task.agent?.agentId ?? ROVARA_CODE_AGENT_ID };
  const recover = async (receipt: TaskStopTransition): Promise<{ task: DeveloperTaskView }> => {
    const access = await authorizeTaskAction(deps, caller, taskId, "work"), current = access.task;
    if (deps.agentRuns === undefined || current.agent === undefined) throw budgetActorRefused();
    await requireAgentAccess(deps.agentRuns, caller, current.agent.agentId, current.agent.version === "draft" ? "edit" : "use");
    if (current.origin !== "app" || !isDeepStrictEqual(current.payer, receipt.payer) || current.project !== receipt.place.project) throw agentXError("CHANGE_STALE", "The task's payer changed. Review the task before continuing.");
    const nativeRecoveryChecks = [...budgetActorChecks(deps.tableName, deps.orgId, { developerId: caller.developerId, role: caller.orgRole }), accessFence(deps, access)];
    try {
      await deps.actions.transact(nativeRecoveryChecks);
    } catch (error) {
      if (failedIndexes(error) !== undefined) throw budgetActorRefused();
      throw error;
    }
    if (current.closedAt === undefined && (receipt.workflowRevision === null || current.workflow?.revision === receipt.workflowRevision)) {
      await resumeTaskAfterSpendApproval(deps, caller, { orgId: deps.orgId, taskId, spendRequestId: receipt.requestId, resetRunWindow: false, firstDispatch: false, nativeRecoveryChecks, spendingAdmission: { requestId: receipt.requestId, actorId: receipt.actorId, intentHash: receipt.intentHash },
        ...(receipt.agentRunRevision === null ? {} : { expectedPausedAgentRevision: receipt.agentRunRevision }) });
    }
    const fresh = await get<DeveloperTaskRecord>(deps, taskKey(taskId));
    return { task: await taskView(deps, fresh ?? current, { events: 0, details: false }) };
  };
  const committed = await readTaskStopTransition(deps, identity);
  if (committed !== undefined) return recover(committed);
  if (task.origin === "app" && task.budgetPause === undefined && task.startedBy !== undefined) return { task: await taskView(deps, task, { events: 0, details: false }) };
  if (task.origin !== "test_run" || task.budgetPause?.scope.kind !== "test" || task.agent === undefined) {
    throw agentXError("CONFIG_INVALID", "only a test run that reached its cap can continue as a normal task");
  }
  if (deps.agentRuns === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "agents are not set up in this deployment");
  const authorize = async () => {
    await authorizeTaskAction(deps, caller, taskId, "work");
    if (deps.agentRuns === undefined || task.agent === undefined) throw budgetActorRefused();
    await requireAgentAccess(deps.agentRuns, caller, task.agent.agentId, task.agent.version === "draft" ? "edit" : "use");
  };
  const { payer, place, projectPays } = await resolveRunPayer(deps.agentRuns, { orgId: deps.orgId, project: task.project, agentId: task.agent.agentId, origin: "app", startedBy: { developerId: caller.developerId } });
  let fundingTransition: ReturnType<typeof TaskFundingProofSchema.parse> | undefined;
  if (task.fundingProof !== undefined) {
    await authorize();
    const pinned = await readTaskRecipe(deps, taskId, deps.orgId), prior = TaskFundingProofSchema.parse(task.fundingProof);
    if (pinned?.modelPolicyPin === undefined || !isDeepStrictEqual(pinned.fundingProof, prior) || deps.agentRuns.modelRouting === undefined) throw agentXError("TASK_STOP_CONFIG_INVALID", "The admitted funding proof is unavailable.");
    fundingTransition = await captureTaskFundingProof({ documentClient: deps.documentClient, tableName: deps.tableName, routing: deps.agentRuns.modelRouting, chatgpt: deps.agentRuns.stageChatgpt, now: () => deps.now() }, { orgId: deps.orgId, project: task.project, models: taskFundingModelPool(pinned.modelPolicyPin, deps.agentRuns.modelRouting.rovaraGeography), admittedProof: prior, ...(payer.kind === "member" ? { payerDeveloperId: payer.developerId } : {}) });
    if (fundingTransition === undefined) throw agentXError("TASK_STOP_CONFIG_MISSING", "The task's own-source funding changed. Start again with current spending rules.");
  }
  const previous = task.spendingStop === undefined ? undefined : checkedTaskStopSnapshot(task.spendingStop);
  const captured = fundingTransition === undefined ? await captureTaskStopAdmission({ documentClient: deps.documentClient, tableName: deps.tableName, now: () => deps.now(), requireScopeAccess: authorize }, {
    orgId: deps.orgId, developerId: caller.developerId, role: caller.orgRole, project: task.project, agentId: task.agent.agentId,
    pathLimitMicrousd: previous?.calculationInput.approvedRunLimitMicrousd ?? previous?.calculationInput.pathLimitMicrousd ?? usdToWholeMicrodollars(task.budgetUsd ?? PER_TASK_BUDGET_USD) ?? null,
    ...(task.maxPerRunUsd === undefined ? {} : { committedMaxPerRunMicrousd: usdToWholeMicrodollars(task.maxPerRunUsd) ?? null }),
    ...(previous?.calculationInput.chainMicrousd === undefined ? {} : { chainMicrousd: previous.calculationInput.chainMicrousd }),
    // The testing allowance belongs to historical spend; this is a new payer.
    ...(previous?.calculationInput.requestedMicrousd !== undefined ? { requestedMicrousd: previous.calculationInput.requestedMicrousd }
      : task.requestedRunLimitUsd === undefined ? {} : { requestedMicrousd: usdToWholeMicrodollars(task.requestedRunLimitUsd) ?? null }),
  }) : { kind: "disabled" as const };
  if (captured.kind === "captured") {
    checkedTaskMaxPerRun(task);
    if (captured.effectiveStopMicrousd === 0) throw agentXError("TASK_STOP_ZERO", "Work can't start: the effective spending stop is $0.");
    if (usdToWholeMicrodollars(captured.effectiveStopMicrousd / 1_000_000) !== captured.effectiveStopMicrousd) throw agentXError("TASK_STOP_CONFIG_INVALID", "The task stop can't be represented exactly. Ask an admin to review Spending.");
    const checks = [...budgetActorChecks(deps.tableName, deps.orgId, { developerId: caller.developerId, role: caller.orgRole }),
      ...await taskStartProjectAuthorityChecks(deps, { orgId: deps.orgId, developerId: caller.developerId, role: caller.orgRole, project: task.project }, authorize),
      ...await taskStartAgentAuthorityChecks(deps, { orgId: deps.orgId, project: task.project, agentId: task.agent.agentId, draft: task.agent.version === "draft", process: task.agent.process === true,
        developerId: caller.developerId, role: caller.orgRole, ...(task.agent.draftRevision === undefined ? {} : { expectedDraftRevision: task.agent.draftRevision }) }, authorize,
      async () => { if (deps.agentRuns === undefined || task.agent === undefined) throw budgetActorRefused(); return deps.agentRuns.store.listShares(deps.orgId, task.agent.agentId); })];
    const runSource = await get<{ revision: number; state: string }>(deps, taskAgentRunKey(taskId));
    if (runSource !== undefined && (!Number.isSafeInteger(runSource.revision) || runSource.revision < 1 || runSource.state !== "PAUSED_BUDGET")) throw agentXError("CHANGE_STALE", "The test run's paused step changed. Review it and continue again.");
    const baseline = deps.modelAccess === undefined ? undefined
      : await taskSpendBaseline({ documentClient: deps.documentClient, tableName: deps.tableName, access: deps.modelAccess }, task.modelKeyIds ?? []);
    const transitionAccess = await authorizeTaskAction(deps, caller, taskId, "work");
    const [receipt, admissionAudit] = taskStopTransitionItems(deps.tableName, identity, { spendingStop: captured, budgetBaselineUsd: baseline === undefined ? task.budgetBaselineUsd === undefined ? 0 : task.budgetBaselineUsd : baseline, payer, place, actorRole: caller.orgRole, peopleRevision: transitionAccess.peopleRevision ?? null,
      agentRunRevision: runSource?.revision ?? null, workflowRevision: task.workflow?.revision ?? null, admittedAt: iso(deps) });
    const item = windowAndPauseUpdate(deps, task, baseline, captured, { requestId: identity.requestId, actorId: identity.actorId, intentHash: identity.intentHash })[0]?.Update;
    if (item === undefined) throw agentXError("TASK_STOP_CONFIG_INVALID", "The task spending transition could not be prepared.");
    const source = ["origin", "budgetPause", "startedBy", "place", "workflow", "modelKeyIds"] as const;
    // Transition aliases must not collide with the window source aliases.
    const seen = new Aliases();
    const sourceConditions = source.map(field => {
      const name = `#transition_${field}`; seen.names[name] = field;
      if (task[field] === undefined) return `attribute_not_exists(${name})`;
      const value = `:transition_${field}`; seen.values[value] = task[field]; return `${name} = ${value}`;
    });
    try {
      await deps.actions.transact([{ Update: { ...item,
        UpdateExpression: `${item.UpdateExpression?.split(" REMOVE ")[0]}, #transition_origin = :app, payer = :payer, #transition_place = :place, #transition_startedBy = :startedBy REMOVE budgetPause${task.maxPerRunUsd !== undefined && taskMaxPerRunForAdmission(captured) === undefined ? ", maxPerRunUsd" : ""}`,
        ConditionExpression: `${item.ConditionExpression} AND ${sourceConditions.join(" AND ")}`,
        ExpressionAttributeNames: { ...item.ExpressionAttributeNames, ...seen.names },
        ExpressionAttributeValues: { ...item.ExpressionAttributeValues, ...seen.values, ":app": "app", ":payer": payer, ":place": place, ":startedBy": { developerId: caller.developerId } },
      } }, ...checks, { ConditionCheck: { TableName: deps.tableName, Key: projectAiKey(deps.orgId, task.project),
        ConditionExpression: "#type = :type AND #org = :org AND #project = :project AND #pays = :pays",
        ExpressionAttributeNames: { "#type": "entityType", "#org": "orgId", "#project": "project", "#pays": "projectPays" },
        ExpressionAttributeValues: { ":type": "PROJECT_AI", ":org": deps.orgId, ":project": task.project, ":pays": projectPays } } },
        { ConditionCheck: { TableName: deps.tableName, Key: taskAgentRunKey(taskId),
          ...(runSource === undefined ? { ConditionExpression: "attribute_not_exists(pk)" } : { ConditionExpression: "#revision = :revision AND #state = :state",
            ExpressionAttributeNames: { "#revision": "revision", "#state": "state" }, ExpressionAttributeValues: { ":revision": runSource.revision, ":state": "PAUSED_BUDGET" } }) } }, accessFence(deps, transitionAccess), receipt, admissionAudit]);
    } catch (error) {
      const accepted = await readTaskStopTransition(deps, identity);
      if (accepted !== undefined) return recover(accepted);
      const failures = failedIndexes(error);
      if (failures !== undefined && [...failures].some(index => index > 0)) throw budgetActorRefused();
      if (failures?.has(0)) throw agentXError("CHANGE_STALE", "The task's payer or spending window changed. Review it and continue again.");
      throw error;
    }
    const accepted = await readTaskStopTransition(deps, identity);
    if (accepted === undefined) throw agentXError("TASK_STOP_CONFIG_INVALID", "The spending transition receipt is missing.");
    return recover(accepted);
  } else try {
    const update = {
      TableName: deps.tableName, Key: taskKey(taskId),
      UpdateExpression: "SET origin = :app, payer = :payer, place = :place, startedBy = :startedBy, updatedAt = :now" + (fundingTransition === undefined ? "" : ", fundingProof = :nextFunding") + " REMOVE budgetPause",
      ConditionExpression: "origin = :test AND budgetPause.#scope.#kind = :testScope AND attribute_not_exists(closedAt)" + (fundingTransition === undefined ? "" : " AND fundingProof = :priorFunding"),
      ExpressionAttributeNames: { "#scope": "scope", "#kind": "kind" },
      ExpressionAttributeValues: { ":app": "app", ":payer": payer, ":place": place, ":startedBy": { developerId: caller.developerId }, ":now": iso(deps), ":test": "test_run", ":testScope": "test", ...(fundingTransition === undefined ? {} : { ":priorFunding": task.fundingProof, ":nextFunding": fundingTransition }) },
    };
    if (fundingTransition === undefined) await deps.documentClient.send(new UpdateCommand(update));
    else {
      const agent = task.agent;
      const agentChecks = await taskStartAgentAuthorityChecks(deps, { orgId: deps.orgId, project: task.project, agentId: agent.agentId, draft: agent.version === "draft", frozenRecipe: true, process: agent.process === true, developerId: caller.developerId, role: caller.orgRole }, authorize,
        async () => { if (deps.agentRuns === undefined) throw budgetActorRefused();return deps.agentRuns.store.listShares(deps.orgId, agent.agentId); });
      const fundingItems: TransactItem[] = [
        { Update: update },
        { Update: { TableName: deps.tableName, Key: taskRecipeKey(taskId), UpdateExpression: "SET fundingProof = :nextFunding", ConditionExpression: "orgId = :fundingOrg AND fundingProof = :priorFunding", ExpressionAttributeValues: { ":fundingOrg": deps.orgId, ":priorFunding": task.fundingProof, ":nextFunding": fundingTransition } } },
        fundingRevisionCheck(deps.tableName, fundingTransition),
        ...fundingAuditItems(deps.tableName, fundingTransition, { taskId, occurrence: request.requestId, actor: { kind: "member", id: caller.developerId }, at: deps.now() }),
        ...budgetActorChecks(deps.tableName, deps.orgId, { developerId: caller.developerId, role: caller.orgRole }),
        ...await taskStartProjectAuthorityChecks(deps, { orgId: deps.orgId, developerId: caller.developerId, role: caller.orgRole, project: task.project }, authorize), ...agentChecks,
      ];
      if (fundingItems.length > 100) throw agentXError("TASK_STOP_CONFIG_INVALID", "The funding transition exceeds the transaction limit.");
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: fundingItems }));
    }
  } catch (error) {
    if (!isConditional(error)) throw error;
    const now = await get<DeveloperTaskRecord>(deps, taskKey(taskId));
    if (now?.origin === "app") return { task: await taskView(deps, now, { events: 0, details: false }) };
    throw agentXError("TASK_BUSY", `task ${taskId} changed meanwhile; refresh it and try again`);
  }
  await resumeTaskAfterSpendApproval(deps, caller, { orgId: deps.orgId, taskId, spendRequestId: request.requestId, resetRunWindow: false, firstDispatch: false });
  const fresh = await get<DeveloperTaskRecord>(deps, taskKey(taskId));
  return { task: await taskView(deps, fresh ?? task, { events: 0, details: false }) };
}
