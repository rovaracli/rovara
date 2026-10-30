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
  actionableWorkspace,
  AGENT_RUN_TURN_REFUSAL,
  busyOrClosing,
  noteResumedWithOriginal,
  requireMayGoOn,
  staleBudgetPause,
  windowAndPauseUpdate,
} from "./task-window.js";
import { retryTaskWorkflow } from "./workflow-retry.js";
import { resumeAfterRunLimitApproval } from "./workflow-coding.js";

export async function continueTask(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, value: unknown): Promise<{ task: DeveloperTaskView }> {
  const request = parse(ContinueDeveloperTaskRequestSchema, value, deps, "continue");
  const access = await authorizeLegacyTaskAction(deps, caller, taskId, "work");
  const { task } = access;
  // Ruling R60, first: before the busy, workspace and model-proxy refusals, so the removal's reason wins.
  await creatorGuard(deps, task);
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
      ...windowAndPauseUpdate(deps, task, baseline),
      ...(withdrawal?.items ?? []),
      // R12: the accepted record commits with the operation or not at all.
      putNew(turns, aiToolTurn({
        party: partyOfTaskActor(task, caller), turnId: randomUUID(), action: "continue", phase: "accepted", outcome: "accepted", receivedAt, finishedAt: iso(deps),
        request: request.instructions, response: `Continuing task ${taskId} as operation ${operation.id}.`, operationId: operation.id,
      })),
      accessFence(deps, access),
    ], { sharedTask: task.shared === true });
  } catch (error) {
    if (isConditional(error)) await authorizeTaskAction(deps, caller, taskId, "work");
    return busyOrClosing(deps, task, error);
  }
  await withdrawal?.flush();
  const view = await taskView(deps, task, { events: 0, details: false });
  await syncIndex(deps, task, view.status, view.updatedAt);
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
 * A run held at its start (run limit 0) is dispatched now that its limit was raised (Task 15's paused start): in one transaction, conditional on the pause
 * still naming that preparation, the workspace slot is taken, the preparation's outbox item is written (with a new capability and repository grant), its
 * setup watch starts and the pause is removed. The preparation's success then starts the task, or wakes the agent-step engine.
 */
async function dispatchHeldStart(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord): Promise<void> {
  const held = task.budgetPause?.firstDispatch;
  if (held === undefined) return;
  const project = await deps.actions.projectRevision(deps.orgId, task.project, task.startingRevision);
  if (project === undefined) throw agentXError("PROJECT_NOT_FOUND", `project \`${task.project}\` revision ${task.startingRevision} is no longer registered`);
  const { workspace, items: outbox } = await deps.actions.preparationDispatch(project, task.workspaceId, held.operationId, task.ownerKey, { ...(held.checkout === undefined ? {} : { checkout: held.checkout }), ...(held.readOnly === true ? { readOnly: true } : {}) });
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
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (error) {
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
export async function resumeTaskAfterSpendApproval(deps: DeveloperTaskRouteDependencies, owner: DeveloperCaller, input: SpendResumeInput): Promise<void | "STALE"> {
  const task = await get<DeveloperTaskRecord>(deps, taskKey(input.taskId));
  if (task === undefined || task.orgId !== deps.orgId || task.orgId !== input.orgId || task.closedAt !== undefined) return;
  // Ruling R60, first: a task whose creator was removed is not resumed, nor a held start dispatched.
  await creatorGuard(deps, task);
  if (input.firstDispatch) {
    await dispatchHeldStart(deps, task);
    return;
  }
  // A plan blocked on its run limit starts coding by this approval and nothing else (`resumeAfterRunLimitApproval`); a repeat of it is the same request.
  if (input.resume === "implement") {
    if (input.runLimitUsd === undefined) throw agentXError("CONFIG_INVALID", "a run limit approval names the limit it approved");
    // STALE (the plan was not blocked on its run limit any more) is answered, so a caller that counts starts does not count it.
    return await resumeAfterRunLimitApproval(deps, task.taskId, { requestId: resumeRequestId(input.spendRequestId, "implement"), runLimitUsd: input.runLimitUsd }) === "STALE" ? "STALE" : undefined;
  }
  if (task.budgetPause !== undefined) return;
  // A chain's step hears that its task went on, so the step and the run show running again before the task ends and a second stop can be told as a pause.
  if (task.chain !== undefined) await onTaskResumed({ documentClient: deps.documentClient, tableName: deps.tableName, now: Date.now }, task);
  const resumed: DeveloperTaskRouteDependencies = { ...deps, spendResume: { keepWindow: !input.resetRunWindow } };
  if (task.agent !== undefined && task.workflow === undefined && await get(deps, taskAgentRunKey(task.taskId)) !== undefined) {
    if (deps.agentEngine === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "agents are not set up in this deployment");
    await advanceAgentRun(deps.agentEngine, task.taskId);
    return;
  }
  const requestId = resumeRequestId(input.spendRequestId, "resume");
  if (task.workflow !== undefined) {
    if (task.workflow.state !== "BLOCKED" || task.workflow.blockReason !== WORKFLOW_BLOCK_REASONS.budgetPaused) return;
    await retryTaskWorkflow(resumed, owner, task.taskId, { requestId, instructions: SPEND_RESUME_INSTRUCTIONS, expectedRevision: task.workflow.revision });
    return;
  }
  // A task with no workflow: the system's Continue (its window is the approval's).
  await deps.actions.acceptTask(developerTaskIdentity(task, deps.orgId), task.workspaceId, { requestId, conversationId: task.conversationId, prompt: SPEND_RESUME_INSTRUCTIONS }, () => [], { sharedTask: task.shared === true });
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
export async function continueAsTask(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, value: unknown): Promise<{ task: DeveloperTaskView }> {
  const request = parse(ContinueAsTaskSchema, value, deps, "continue-as-task");
  const task = await get<DeveloperTaskRecord>(deps, taskKey(taskId));
  if (task === undefined || task.orgId !== deps.orgId || tryEffectiveTaskOwner(task)?.developerId !== caller.developerId) throw agentXError("TASK_NOT_FOUND", `task ${taskId} doesn't exist`);
  await creatorGuard(deps, task);
  if (task.origin === "app" && task.budgetPause === undefined && task.startedBy !== undefined) return { task: await taskView(deps, task, { events: 0, details: false }) };
  if (task.origin !== "test_run" || task.budgetPause?.scope.kind !== "test" || task.agent === undefined) {
    throw agentXError("CONFIG_INVALID", "only a test run that reached its cap can continue as a normal task");
  }
  if (deps.agentRuns === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "agents are not set up in this deployment");
  const { payer, place } = await resolveRunPayer(deps.agentRuns, { orgId: deps.orgId, project: task.project, agentId: task.agent.agentId, origin: "app", startedBy: { developerId: caller.developerId } });
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: taskKey(taskId),
      UpdateExpression: "SET origin = :app, payer = :payer, place = :place, startedBy = :startedBy, updatedAt = :now REMOVE budgetPause",
      ConditionExpression: "origin = :test AND budgetPause.#scope.#kind = :testScope AND attribute_not_exists(closedAt)",
      ExpressionAttributeNames: { "#scope": "scope", "#kind": "kind" },
      ExpressionAttributeValues: { ":app": "app", ":payer": payer, ":place": place, ":startedBy": { developerId: caller.developerId }, ":now": iso(deps), ":test": "test_run", ":testScope": "test" },
    }));
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
