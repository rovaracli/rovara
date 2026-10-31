import { createHash, randomUUID } from "node:crypto";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  startWorkflowPlanAfterUnderstand,
  startWorkflowUnderstand,
  AgentXError,
  agentXError,
  redactText,
  type Operation,
  type WorkflowSnapshot,
  WorkflowSnapshotSchema,
  workflowSelectedChecks,
  WorkflowTransitionError,
  workflowRequestId,
  returnWorkflowToImplementationAutomatically,
  workflowAutomaticRetryDecision,
  workflowAutoActionRequestId,
  type WorkflowAutoSpend,
  type WorkflowDecision,
  sendBackProblems,
  type E2EWorkflowAdmissionRef,
} from "@agentx/contracts";
import { PLAN_REVISION_REQUEST, planCriticBlock, planCritiquePrompt } from "../../rovara-code/critic.js";
import { aiToolTurn, developerTaskIdentity, effectiveTaskOwner, partyOfTask, taskKey, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { WORKFLOW_NO_CANDIDATE_DIGEST, isConditional, workflowDispatchItem } from "../broker-shared.js";
import { loadWorkflowDocument } from "../../developer/plan-artifacts.js";
import type { TransactItems } from "../developer-task-actions.js";
import type { DeveloperCaller } from "../developer-routes.js";
import type { TaskAccess } from "../../developer/task-access.js";
import { E2E_OWNER_SENTENCES } from "../../e2e/owner-sentences.js";
import { requalifyHoldFence } from "../../e2e/requalify-hold.js";
import { understandPrompt } from "../../rovara-code/understand.js";
import type { DeveloperTaskRouteDependencies } from "./types.js";
import { creatorGuard, get, iso, partyOfTaskActor, putNew, taskBaseOption, turnTable } from "./common.js";
import { accessFence, authorizeTaskAction, systemTaskAccess } from "./access.js";
import { actionableWorkspace } from "./task-window.js";
import { retryTaskWorkflow } from "./workflow-retry.js";
import {
  NO_PUBLISH_NOTE,
  approvedCodingPlan,
  approvedWorkflowDependencies,
  ownerConstraintsSection,
  previousMarkdownBlock,
  retiredClaimIdList,
  structuredWorkflowPrompt,
} from "./workflow-inputs.js";
import { queueWorkflowCoding } from "./workflow-coding.js";
import { queueWorkflowReview, understandWatchdogDueAt } from "./workflow-review.js";
import { fedThroughUpdate, promptTagId, sendBackProblemsPromptSection, withCurrentThreadNotes } from "./thread-notes.js";
import type { ShareAdmin } from "./share.js";

/**
 * Plan 6 Task 4: starts (or starts again) the Understand step of a version 2 task: READY (the task's start, or a person's answers) or BLOCKED (the owner's retry) becomes RUNNING, the
 * model run is accepted, and the step's watchdog row is written, all in the one acceptance transaction. Understand is read-only and is not a recipe step: it runs on the plan step's model.
 * Thread replies not yet given to a step go with it (inside their own block).
 */
export async function queueWorkflowUnderstand(
  deps: DeveloperTaskRouteDependencies,
  task: DeveloperTaskRecord,
  input: { requestId: string; access?: TaskAccess | undefined; actor?: DeveloperCaller | undefined; cap?: { clause: string; values: Record<string, number> } | undefined; request: string; response: string },
): Promise<{ operation: Operation; duplicate: boolean }> {
  return withCurrentThreadNotes(deps, task, input.requestId, (current, notes) => {
    const workflow = current.workflow;
    if (workflow === undefined) throw agentXError("CONFIG_INVALID", "this task has no workflow to understand");
    const fed = fedThroughUpdate(notes);
    const receivedAt = iso(deps);
    const next = startWorkflowUnderstand(workflow, receivedAt);
    const prompt = understandPrompt({ requestText: current.requestText ?? "", intent: workflow.intent, notes: notes.suffix, ...(current.retryOfTaskId === undefined ? {} : { changeAnyway: true }), ...(workflow.intent?.pathFrom === "request" ? { explicitPath: true } : {}) });
    return deps.actions.acceptTask(developerTaskIdentity(current, deps.orgId), current.workspaceId, { requestId: input.requestId, conversationId: current.conversationId, prompt }, (operation) => [
      { Update: {
        TableName: deps.tableName, Key: taskKey(current.taskId),
        UpdateExpression: `SET workflow = :workflow, updatedAt = :now${fed.clause}${input.cap?.clause ?? ""}`,
        ConditionExpression: `workflow.revision = :revision AND workflow.#stage = :understand AND workflow.#state = :state AND attribute_not_exists(closedAt)${fed.condition}`,
        ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
        ExpressionAttributeValues: { ":workflow": next, ":now": receivedAt, ":revision": workflow.revision, ":understand": "UNDERSTAND", ":state": workflow.state, ...fed.values, ...(input.cap?.values ?? {}) },
      } },
      // The watchdog: if no result comes back by the step's time limit, the dispatch ends the task and gives its workspace slot back.
      workflowDispatchItem(deps.tableName, current.taskId, next.revision, "UNDERSTAND", WORKFLOW_NO_CANDIDATE_DIGEST, receivedAt, understandWatchdogDueAt(receivedAt)),
      putNew(turnTable(deps), aiToolTurn({
        party: input.actor === undefined ? partyOfTask(current) : partyOfTaskActor(current, input.actor), turnId: randomUUID(), action: "continue", phase: "accepted", outcome: "accepted",
        receivedAt, finishedAt: iso(deps), request: input.request, response: `${input.response} as operation ${operation.id}.`, operationId: operation.id,
      })),
      ...(input.access === undefined ? [] : [accessFence(deps, input.access)]),
    ], { sharedTask: current.shared === true, workflowMode: "UNDERSTAND", ...taskBaseOption(current, next) });
  });
}

/**
 * Plan 6 Task 4: Understand's dispatch, with no one asking. Answers STALE unless the task is open and its version 2 workflow is still at UNDERSTAND/READY at the expected revision, and
 * WAITING while the workspace is still being prepared (the row stays; the prepare's result runs it at once). The request ID comes from the task and revision, so a recovered or repeated
 * dispatch is the broker's duplicate of the first. Any other refusal (a busy workspace, a model the company forbids) propagates to the dispatch, which counts it.
 */
export async function startTaskWorkflowUnderstandFromSystem(
  deps: DeveloperTaskRouteDependencies,
  taskId: string,
  expected: { workflowRevision: number },
  actor?: DeveloperCaller,
): Promise<"STARTED" | "DUPLICATE" | "STALE" | "WAITING"> {
  const task = await get<DeveloperTaskRecord>(deps, taskKey(taskId));
  const workflow = task?.workflow;
  if (task === undefined || task.closedAt !== undefined || workflow === undefined || workflow.definitionVersion !== "1.1.0"
    || workflow.revision !== expected.workflowRevision || workflow.stage !== "UNDERSTAND" || workflow.state !== "READY") return "STALE";
  await creatorGuard(deps, task);
  const dispatchAccess = await systemTaskAccess(deps, task);
  const workspace = await deps.actions.workspace(task.workspaceId);
  if (workspace.status === "CLOSED" || workspace.status === "PREPARATION_FAILED") return "STALE";
  // The machine is still being set up (or a held start has not begun): Understand runs when it is ready, not before.
  if (workspace.status === "PREPARING") return "WAITING";
  const accepted = await queueWorkflowUnderstand(deps, task, {
    requestId: workflowRequestId("agentx-understand", taskId, workflow.revision), access: dispatchAccess, actor,
    request: "Understand the request", response: "Reading the request and the code started",
  });
  return accepted.duplicate ? "DUPLICATE" : "STARTED";
}

/**
 * Plan 6 Task 4: the plan step after Understand, with no one asking (a PLAN dispatch row). PLAN/READY becomes RUNNING and the planning run is accepted in one transaction; its prompt is the
 * request and what Understand found (the restatement and the assumptions) and the people's answers, each in its own labelled block. The path is the one Understand recorded: a Full task asks
 * for requirements first.
 */
export async function startTaskWorkflowPlanFromSystem(
  deps: DeveloperTaskRouteDependencies,
  taskId: string,
  expected: { workflowRevision: number },
  actor?: DeveloperCaller,
): Promise<"STARTED" | "DUPLICATE" | "STALE"> {
  const task = await get<DeveloperTaskRecord>(deps, taskKey(taskId));
  const workflow = task?.workflow;
  if (task === undefined || task.closedAt !== undefined || workflow === undefined || workflow.definitionVersion !== "1.1.0"
    || workflow.revision !== expected.workflowRevision || workflow.stage !== "PLAN" || workflow.state !== "READY" || workflow.intent?.assessment?.kind !== "ready") return "STALE";
  await creatorGuard(deps, task);
  const dispatchAccess = await systemTaskAccess(deps, task);
  const workspace = await deps.actions.workspace(task.workspaceId);
  if (workspace.status === "CLOSED" || workspace.status === "PREPARATION_FAILED") return "STALE";
  const requestId = workflowRequestId("agentx-plan-after-understand", taskId, workflow.revision);
  const accepted = await withCurrentThreadNotes(deps, task, requestId, (current, notes) => {
    const fed = fedThroughUpdate(notes);
    const receivedAt = iso(deps);
    const next = startWorkflowPlanAfterUnderstand(current.workflow!, receivedAt);
    const prompt = understandPrompt({ requestText: current.requestText ?? "", intent: current.workflow!.intent, notes: notes.suffix, forPlan: true });
    return deps.actions.acceptTask(developerTaskIdentity(current, deps.orgId), current.workspaceId, { requestId, conversationId: current.conversationId, prompt }, (operation) => [
      { Update: {
        TableName: deps.tableName, Key: taskKey(taskId),
        UpdateExpression: `SET workflow = :workflow, updatedAt = :now${fed.clause}`,
        ConditionExpression: `workflow.revision = :revision AND workflow.#stage = :plan AND workflow.#state = :ready AND attribute_not_exists(closedAt)${fed.condition}`,
        ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
        ExpressionAttributeValues: { ":workflow": next, ":now": receivedAt, ":revision": current.workflow!.revision, ":plan": "PLAN", ":ready": "READY", ...fed.values },
      } },
      putNew(turnTable(deps), aiToolTurn({
        party: actor === undefined ? partyOfTask(current) : partyOfTaskActor(current, actor), turnId: randomUUID(), action: "continue", phase: "accepted", outcome: "accepted",
        receivedAt, finishedAt: iso(deps), request: "Write the plan", response: `Planning started as operation ${operation.id}.`, operationId: operation.id,
      })),
      ...(dispatchAccess === undefined ? [] : [accessFence(deps, dispatchAccess)]),
    ], { sharedTask: current.shared === true, workflowMode: "PLAN", ...(next.reviewPhase === undefined ? {} : { workflowPhase: next.reviewPhase }) });
  });
  return accepted.duplicate ? "DUPLICATE" : "STARTED";
}

/** A conversation id for one plan check, the same whenever the same check is started again (a repeat of its dispatch finds the conversation, not a second one). */
function planCheckConversationId(taskId: string, revision: number): string {
  const hex = createHash("sha256").update(`agentx-plan-check-conversation:${taskId}:${String(revision)}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The most of the person's words (the request) a plan check is given beside the plan. */
const PLAN_CHECK_REQUEST_MAX_CHARS = 4_000;

/**
 * Plan 6 Task 8: the plan check of a version 2 coding plan, started with no one asking. Answers STALE (nothing to do) unless the task is open and still waiting for exactly this check at the expected
 * revision. PLAN_CRITIQUE/READY becomes RUNNING and the check's operation is accepted in one transaction; the request ID comes from the task and the revision, so a recovered or repeated dispatch is the
 * broker's duplicate of the first. The critic is given the plan the planner wrote as data, and the person's request, redacted and cut: Rovara's own words come first, and nothing in either can approve the plan.
 */
export async function startTaskWorkflowPlanCritiqueFromSystem(
  deps: DeveloperTaskRouteDependencies,
  taskId: string,
  expected: { workflowRevision: number },
  actor?: DeveloperCaller,
): Promise<"STARTED" | "DUPLICATE" | "STALE"> {
  const task = await get<DeveloperTaskRecord>(deps, taskKey(taskId));
  const workflow = task?.workflow;
  const step = workflow?.program?.steps.find((candidate) => candidate.kind === "plan_critic");
  if (task === undefined || task.closedAt !== undefined || workflow === undefined || step === undefined
    || workflow.revision !== expected.workflowRevision || workflow.stage !== "PLAN_CRITIQUE" || workflow.state !== "READY") return "STALE";
  await creatorGuard(deps, task);
  const dispatchAccess = await systemTaskAccess(deps, task);
  const workspace = await deps.actions.workspace(task.workspaceId);
  if (workspace.status === "CLOSED" || workspace.status === "PREPARATION_FAILED") return "STALE";
  const artifact = workflow.artifacts.filter((entry) => entry.type === "plan").at(-1);
  if (artifact === undefined) throw agentXError("WORKSPACE_NOT_READY", "the coding plan to check is missing");
  const loaded = await loadWorkflowDocument((objectKey, maxBytes) => deps.actions.readArtifact(objectKey, maxBytes), artifact, {});
  if (loaded === undefined) throw agentXError("WORKSPACE_NOT_READY", "the coding plan to check failed its digest check");
  const receivedAt = iso(deps);
  const requestId = workflowRequestId("agentx-plan-critique", taskId, workflow.revision);
  // The critic works in a conversation of its own, one for each check: it never sees the planner's session, and the planner and the builder never hold its turn. They are told what it found
  // only through the bounded, redacted, labelled points (planCriticBlock).
  const conversationId = planCheckConversationId(taskId, workflow.revision);
  await deps.documentClient.send(new PutCommand({
    TableName: deps.tableName, ConditionExpression: "attribute_not_exists(pk)",
    Item: { pk: `WORKSPACE#${task.workspaceId}`, sk: `CONVERSATION#${conversationId}`, entityType: "CONVERSATION", id: conversationId, workspaceId: task.workspaceId, createdAt: receivedAt, updatedAt: receivedAt },
  })).catch((error: unknown) => { if (!isConditional(error)) throw error; });
  const next: WorkflowSnapshot = { ...workflow, revision: workflow.revision + 1, state: "RUNNING", updatedAt: receivedAt };
  const request = task.requestText === undefined ? undefined : Array.from(redactText(task.requestText)).slice(0, PLAN_CHECK_REQUEST_MAX_CHARS).join("");
  const accepted = await deps.actions.acceptTask(developerTaskIdentity(task, deps.orgId), task.workspaceId, {
    requestId, conversationId, prompt: planCritiquePrompt({ plan: loaded.markdown, request }),
  }, (operation) => [
    { Update: {
      TableName: deps.tableName, Key: taskKey(task.taskId),
      UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
      ConditionExpression: "workflow.revision = :revision AND workflow.#stage = :critique AND workflow.#state = :ready AND attribute_not_exists(closedAt)",
      ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
      ExpressionAttributeValues: { ":workflow": next, ":now": receivedAt, ":revision": workflow.revision, ":critique": "PLAN_CRITIQUE", ":ready": "READY" },
    } },
    putNew(turnTable(deps), aiToolTurn({
      party: actor === undefined ? partyOfTask(task) : partyOfTaskActor(task, actor), turnId: randomUUID(), action: "continue", phase: "accepted", outcome: "accepted", receivedAt, finishedAt: iso(deps),
      request: "Check the plan with a second model", response: `The plan check started as operation ${operation.id}.`, operationId: operation.id,
    })),
    ...(dispatchAccess === undefined ? [] : [accessFence(deps, dispatchAccess)]),
  ], { sharedTask: task.shared === true, workflowMode: "PLAN_CRITIQUE", programStepId: step.id, ...taskBaseOption(task, next) });
  return accepted.duplicate ? "DUPLICATE" : "STARTED";
}

/**
 * Plan 6 Task 8: the one revision a blocking point of the plan check asks for, started with no one asking. PLAN/READY (the check sent the plan back) becomes RUNNING and a planning operation is accepted in
 * one transaction. The planner is given the plan it wrote as data, to write back whole, and the critic's points in the labelled block after Rovara's own words; it decides what to change. Answers STALE
 * unless the task is open, at that revision, and the check did send the plan back.
 */
export async function startTaskWorkflowCriticRevisionFromSystem(
  deps: DeveloperTaskRouteDependencies,
  taskId: string,
  expected: { workflowRevision: number },
  actor?: DeveloperCaller,
): Promise<"STARTED" | "DUPLICATE" | "STALE"> {
  const task = await get<DeveloperTaskRecord>(deps, taskKey(taskId));
  const workflow = task?.workflow;
  const points = workflow?.critique?.critiques.at(-1)?.points;
  if (task === undefined || task.closedAt !== undefined || workflow === undefined || points === undefined || !points.some((point) => point.severity === "blocking")
    || workflow.revision !== expected.workflowRevision || workflow.stage !== "PLAN" || workflow.state !== "READY") return "STALE";
  await creatorGuard(deps, task);
  const dispatchAccess = await systemTaskAccess(deps, task);
  const workspace = await deps.actions.workspace(task.workspaceId);
  if (workspace.status === "CLOSED" || workspace.status === "PREPARATION_FAILED") return "STALE";
  const artifact = workflow.artifacts.filter((entry) => entry.type === "plan").at(-1);
  if (artifact === undefined) throw agentXError("WORKSPACE_NOT_READY", "the coding plan to revise is missing");
  const loaded = await loadWorkflowDocument((objectKey, maxBytes) => deps.actions.readArtifact(objectKey, maxBytes), artifact, {});
  if (loaded === undefined) throw agentXError("WORKSPACE_NOT_READY", "the coding plan to revise failed its digest check");
  const receivedAt = iso(deps);
  const requestId = workflowRequestId("agentx-plan-revision", taskId, workflow.revision);
  const next: WorkflowSnapshot = { ...workflow, revision: workflow.revision + 1, state: "RUNNING", updatedAt: receivedAt };
  const retired = await retiredClaimIdList(deps, workflow);
  const critic = `\n\n${planCriticBlock(points)}`;
  const prompt = loaded.format === "structured"
    ? structuredWorkflowPrompt(loaded, { decision: "REQUEST_CHANGES", reason: PLAN_REVISION_REQUEST }, "PLAN", workflow.reviewPhase, "plan", { chosen: [], changed: false, comments: critic })
    : `Revise the current coding plan. Requested changes: ${PLAN_REVISION_REQUEST}\n\nReturn the complete revised document. Do not edit files.\n\n${previousMarkdownBlock(loaded.markdown)}${critic}`;
  const accepted = await deps.actions.acceptTask(developerTaskIdentity(task, deps.orgId), task.workspaceId, { requestId, conversationId: task.conversationId, prompt }, (operation) => [
    { Update: {
      TableName: deps.tableName, Key: taskKey(task.taskId),
      UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
      ConditionExpression: "workflow.revision = :revision AND workflow.#stage = :plan AND workflow.#state = :ready AND attribute_not_exists(closedAt)",
      ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
      ExpressionAttributeValues: { ":workflow": next, ":now": receivedAt, ":revision": workflow.revision, ":plan": "PLAN", ":ready": "READY" },
    } },
    putNew(turnTable(deps), aiToolTurn({
      party: actor === undefined ? partyOfTask(task) : partyOfTaskActor(task, actor), turnId: randomUUID(), action: "continue", phase: "accepted", outcome: "accepted", receivedAt, finishedAt: iso(deps),
      request: "Revise the plan after its check", response: `The plan revision started as operation ${operation.id}.`, operationId: operation.id,
    })),
    ...(dispatchAccess === undefined ? [] : [accessFence(deps, dispatchAccess)]),
  ], { sharedTask: task.shared === true, workflowMode: "PLAN", planRevision: true, ...(retired.length === 0 ? {} : { retiredClaimIds: retired }), ...(workflow.reviewPhase === undefined ? {} : { workflowPhase: workflow.reviewPhase }) });
  return accepted.duplicate ? "DUPLICATE" : "STARTED";
}

/** What Rovara's own retry (AUTOFIX) carries: the revision it was decided on, the money inputs the guard holds again, and the fixed reason the decision records. */
export interface AutomaticRetry { expectedRevision: number; spend: WorkflowAutoSpend; reason: string }

/** The AUTO_RETRY decision for the blocked `stage`, from the contracts' guard; its refusals (stale, limits, cap) are conflicts here. */
export function automaticRetryDecision(workflow: WorkflowSnapshot, stage: "VERIFY" | "REVIEW", automatic: AutomaticRetry, now: string): WorkflowDecision {
  try {
    return workflowAutomaticRetryDecision(workflow, { expectedRevision: automatic.expectedRevision, stage, reason: automatic.reason, spend: automatic.spend, now });
  } catch (error) {
    if (error instanceof WorkflowTransitionError) throw agentXError("IDEMPOTENCY_CONFLICT", error.message);
    throw error;
  }
}

/**
 * The caller Rovara's own actions use to reach the task's routes: the task's effective owner, in the task's own org, with the plain member role (nothing elevated), never a person's session.
 * Decisions it records are AGENTX's, not the owner's (mainline #408 sync: the caller gains the org and role the org-scoped routes need; owner ruling pending).
 */
export function automaticCaller(deps: Pick<DeveloperTaskRouteDependencies, "orgId">, task: DeveloperTaskRecord): DeveloperCaller {
  const owner = effectiveTaskOwner(task);
  return {
    developerId: owner.developerId, sessionId: "workflow-autofix", amr: owner.provider, name: owner.name, orgId: deps.orgId, orgRole: "member",
    ...(owner.slackUserId === undefined ? {} : { slackUserId: owner.slackUserId }),
  };
}

/**
 * AUTOFIX: Rovara sends blocked checks or reviews back to coding by itself. It records an AGENTX decision (`returnWorkflowToImplementationAutomatically`: the policy's limits and the money
 * cap held again) and starts the coding run in one write conditional on the blocked revision, exactly as the owner's Send back does, so when the owner presses Send back at the same
 * moment only one of the two commits and there is one coding run. The request ID is derived from the task and the revision, so a repeated trigger finds the decision it already made.
 * "STALE": the task moved on (the owner was first, or it closed). It only ever makes this one move: never an approval, a skip, a rejection or a publication.
 */
export async function autoSendBackToCodingFromSystem(
  deps: DeveloperTaskRouteDependencies, taskId: string, input: { expectedRevision: number; reason: string; spend: WorkflowAutoSpend },
): Promise<"STARTED" | "DUPLICATE" | "STALE"> {
  const task = await get<DeveloperTaskRecord>(deps, taskKey(taskId));
  const workflow = task?.workflow;
  if (task === undefined || task.closedAt !== undefined || workflow === undefined) return "STALE";
  // MONEY (mainline #408 sync): a task paused for an approval of more spend is not gone on with by Rovara itself; the caller then asks the owner ("needs-a-person").
  if (task.budgetPause !== undefined) return "STALE";
  const requestId = workflowAutoActionRequestId(taskId, input.expectedRevision, "AUTO_FIX");
  if (workflow.decisions.some((decision) => decision.requestId === requestId)) return "DUPLICATE";
  if (workflow.revision !== input.expectedRevision) return "STALE";
  const receivedAt = iso(deps);
  let returned: WorkflowSnapshot;
  try {
    returned = returnWorkflowToImplementationAutomatically(workflow, { expectedRevision: input.expectedRevision, reason: input.reason, spend: input.spend, now: receivedAt });
  } catch (error) {
    if (error instanceof WorkflowTransitionError) return "STALE";
    throw error;
  }
  const caller = automaticCaller(deps, task);
  const access = await authorizeTaskAction(deps, caller, taskId, "control");
  await actionableWorkspace(deps, task);
  const plan = await approvedCodingPlan(deps, workflow);
  const workflowDependencies = await approvedWorkflowDependencies(deps, task, access.peopleRevision);
  if (workflowDependencies !== undefined && deps.workflowDependenciesEnabled !== true) {
    throw agentXError("CONFIG_INVALID", "the approved ordered work plan is retained, but this broker is not enabled to continue it");
  }
  const restartApprovedGraph = workflowDependencies === undefined ? undefined : {
    ...workflowDependencies,
    resumeTreeSha: workflowDependencies.resumeTreeSha,
    sequenceStart: workflow.workflowDependenciesProgress?.at(-1)?.sequence ?? workflowDependencies.sequenceStart ?? 0,
    resumeProgress: [],
  };
  // The problems are check and reviewer output, marked untrusted, as in the owner's Send back; there is no owner note, only Rovara's fixed one.
  const problems = sendBackProblemsPromptSection(sendBackProblems(workflow, E2E_OWNER_SENTENCES.groupSentence), promptTagId(task, requestId));
  const prompt = (notes: string) => `Address the problems below in the code, keeping to the approved plan. ${NO_PUBLISH_NOTE}\n\n${problems}\n\nNote (written by AgentX, which sent this back by itself): ${input.reason}${ownerConstraintsSection(workflow, plan)}\n\nApproved plan (sha256 ${plan.sha256}):\n${plan.text}${notes}`;
  const next: WorkflowSnapshot = { ...returned, revision: returned.revision + 1, state: "RUNNING", updatedAt: receivedAt };
  await queueWorkflowCoding(deps, caller, { ...access, task: { ...task, workflow } }, { requestId, prompt, next, automatic: true,
    request: input.reason, response: workflowDependencies === undefined ? "AgentX sent the change back to coding by itself" : "AgentX restarted the approved ordered work plan by itself",
    ...(restartApprovedGraph === undefined ? {} : { workflowDependencies: restartApprovedGraph }) });
  return "STARTED";
}

/**
 * AUTOFIX: Rovara retries blocked checks by itself, once per candidate (the contracts' guard). The same route as the owner's Retry checks with the same checks selected, with its AGENTX
 * decision in the same write; the plan's re-approval stays with the owner. "STALE": the task moved on or the retry is out of date.
 */
export async function autoRetryChecksFromSystem(deps: DeveloperTaskRouteDependencies, taskId: string, input: AutomaticRetry): Promise<"STARTED" | "DUPLICATE" | "STALE"> {
  const task = await get<DeveloperTaskRecord>(deps, taskKey(taskId));
  const workflow = task?.workflow;
  if (task === undefined || task.closedAt !== undefined || workflow === undefined) return "STALE";
  // MONEY (mainline #408 sync): a task paused for an approval of more spend is not gone on with by Rovara itself; the caller then asks the owner ("needs-a-person").
  if (task.budgetPause !== undefined) return "STALE";
  const requestId = workflowAutoActionRequestId(taskId, input.expectedRevision, "AUTO_RETRY");
  if (workflow.decisions.some((decision) => decision.requestId === requestId)) return "DUPLICATE";
  if (workflow.revision !== input.expectedRevision || workflow.stage !== "VERIFY" || workflow.state !== "BLOCKED") return "STALE";
  try {
    await retryTaskWorkflow(deps, automaticCaller(deps, task), taskId, { requestId, expectedRevision: input.expectedRevision, instructions: input.reason }, false, input);
  } catch (error) {
    if (error instanceof AgentXError && error.code === "IDEMPOTENCY_CONFLICT") return "STALE";
    throw error;
  }
  return "STARTED";
}

/** AUTOFIX: Rovara retries blocked reviews by itself, once per candidate, on the code whose checks passed. Same start as the owner's Retry reviews, with its AGENTX decision in the same write. */
export async function autoRetryReviewsFromSystem(deps: DeveloperTaskRouteDependencies, taskId: string, input: AutomaticRetry): Promise<"STARTED" | "DUPLICATE" | "STALE"> {
  const task = await get<DeveloperTaskRecord>(deps, taskKey(taskId));
  const workflow = task?.workflow;
  if (task === undefined || task.closedAt !== undefined || workflow === undefined) return "STALE";
  // MONEY (mainline #408 sync): a task paused for an approval of more spend is not gone on with by Rovara itself; the caller then asks the owner ("needs-a-person").
  if (task.budgetPause !== undefined) return "STALE";
  const requestId = workflowAutoActionRequestId(taskId, input.expectedRevision, "AUTO_RETRY");
  if (workflow.decisions.some((decision) => decision.requestId === requestId)) return "DUPLICATE";
  if (workflow.revision !== input.expectedRevision || workflow.stage !== "REVIEW" || workflow.state !== "BLOCKED" || workflow.candidate === undefined
    || workflow.verification?.candidateDigest !== workflow.candidate.digest || workflow.verification.results.some((result) => result.status !== "PASS")) return "STALE";
  const receivedAt = iso(deps);
  let decision: WorkflowDecision;
  try {
    decision = automaticRetryDecision(workflow, "REVIEW", input, receivedAt);
  } catch (error) {
    if (error instanceof AgentXError && error.code === "IDEMPOTENCY_CONFLICT") return "STALE";
    throw error;
  }
  const caller = automaticCaller(deps, task);
  const access = await authorizeTaskAction(deps, caller, taskId, "retry");
  await actionableWorkspace(deps, task);
  const accepted = await queueWorkflowReview(deps, task, { ...workflow, candidate: workflow.candidate }, requestId, input.reason, access, caller, decision);
  return accepted.duplicate ? "DUPLICATE" : "STARTED";
}

/** Starts a separate server-admitted native CHECKS operation from VERIFY/WAITING. */
export async function startTaskWorkflowE2EChecksFromSystem(
  deps: DeveloperTaskRouteDependencies,
  taskId: string,
  expected: { workflowRevision: number; candidateDigest: string },
  admission: E2EWorkflowAdmissionRef,
  operationId: string,
  actor?: DeveloperCaller,
): Promise<"STARTED" | "DUPLICATE" | "STALE"> {
  const task = await get<DeveloperTaskRecord>(deps, taskKey(taskId));
  const workflow = task?.workflow;
  if (task === undefined || task.closedAt !== undefined || workflow === undefined
    || workflow.revision !== expected.workflowRevision || workflow.stage !== "VERIFY" || workflow.state !== "WAITING"
    || workflow.e2e?.required !== true || workflow.candidate?.digest !== expected.candidateDigest
    || admission.taskId !== taskId || admission.candidateDigest !== expected.candidateDigest
    || admission.workflowRevision !== workflow.revision + 1 || admission.roundId.length === 0
    || admission.groupRunIds.length === 0 || new Set(admission.groupRunIds).size !== admission.groupRunIds.length) return "STALE";
  await creatorGuard(deps, task);
  const dispatchAccess = await systemTaskAccess(deps, task);
  const workspace = await deps.actions.workspace(task.workspaceId);
  if (workspace.status === "CLOSED" || workspace.status === "PREPARATION_FAILED") return "STALE";
  const receivedAt = iso(deps);
  const { qualifiedRound: _previousQualification, failedRound: _previousFailure, ...unqualifiedE2E } = workflow.e2e;
  void _previousQualification;
  void _previousFailure;
  const next: WorkflowSnapshot = WorkflowSnapshotSchema.parse({
    ...workflow,
    revision: workflow.revision + 1,
    state: "RUNNING",
    stage: "VERIFY",
    e2e: { ...unqualifiedE2E, currentRoundId: admission.roundId, currentGroupRunIds: admission.groupRunIds },
    updatedAt: receivedAt,
  });
  const requestId = workflowRequestId("agentx-auto-e2e-checks", taskId, expected.workflowRevision, expected.candidateDigest);
  const accepted = await deps.actions.acceptTask(developerTaskIdentity(task, deps.orgId), task.workspaceId, {
    requestId, conversationId: task.conversationId,
    prompt: "Run the broker-admitted E2E verification groups for this exact candidate. Do not edit files or expand the admitted scenarios.",
  }, (operation) => [
    { Update: {
      TableName: deps.tableName, Key: taskKey(taskId),
      UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
      ConditionExpression: "workflow.revision = :revision AND workflow.#stage = :verify AND workflow.#state = :waiting AND workflow.candidate.digest = :candidate AND workflow.e2e.required = :required AND attribute_not_exists(closedAt)",
      ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
      ExpressionAttributeValues: { ":workflow": next, ":now": receivedAt, ":revision": workflow.revision, ":verify": "VERIFY", ":waiting": "WAITING", ":candidate": expected.candidateDigest, ":required": true },
    } },
    putNew(turnTable(deps), aiToolTurn({
      party: actor === undefined ? partyOfTask(task) : partyOfTaskActor(task, actor), turnId: randomUUID(), action: "continue", phase: "accepted", outcome: "accepted",
      receivedAt, finishedAt: iso(deps), request: "Run admitted E2E verification", response: `Broker-admitted E2E CHECKS started as operation ${operation.id}.`, operationId: operation.id,
    })),
    ...(dispatchAccess === undefined ? [] : [accessFence(deps, dispatchAccess)]),
    requalifyHoldFence(deps.tableName, deps.now()), // AUTOREQUALIFY: no round starts once the test machine is being switched
  ], { sharedTask: task.shared === true, operationId, workflowMode: "CHECKS", workflowE2EAdmission: admission,
    readiness: workflowSelectedChecks(workflow.checkPolicy).map((check) => check.command), ...taskBaseOption(task, next) });
  return accepted.duplicate ? "DUPLICATE" : "STARTED";
}

/**
 * M1.3 Task 3.7b: starts the baseline round (the approved scenarios on the unchanged code, for information only) as a separate server-admitted CHECKS operation from
 * VERIFY/WAITING. Unlike the candidate's CHECKS it changes nothing about the workflow: no revision, no state, no round. The workflow is only held to be where the dispatch saw it
 * (a condition check), so a round never starts for a task that has moved on. `extra` is the baseline record's own start (REQUESTED to STARTED), written in the same transaction
 * as the operation, so there is at most one baseline round per plan and never an operation without its record.
 */
export async function startTaskWorkflowE2EBaselineFromSystem(
  deps: DeveloperTaskRouteDependencies,
  taskId: string,
  expected: { workflowRevision: number; candidateDigest: string },
  admission: E2EWorkflowAdmissionRef,
  operationId: string,
  extra: TransactItems,
  actor?: DeveloperCaller,
): Promise<"STARTED" | "DUPLICATE" | "STALE"> {
  const task = await get<DeveloperTaskRecord>(deps, taskKey(taskId));
  const workflow = task?.workflow;
  if (task === undefined || task.closedAt !== undefined || workflow === undefined
    || workflow.revision !== expected.workflowRevision || workflow.stage !== "VERIFY" || workflow.state !== "WAITING"
    || workflow.e2e?.required !== true || workflow.candidate?.digest !== expected.candidateDigest
    || admission.purpose !== "baseline" || admission.baseCommitSha === undefined || admission.attempt === undefined || admission.taskId !== taskId
    || admission.workflowRevision !== workflow.revision || admission.roundId.length === 0
    || admission.groupRunIds.length === 0 || new Set(admission.groupRunIds).size !== admission.groupRunIds.length) return "STALE";
  // Ruling R60 (round 4 merge): a task whose creator was removed starts nothing, the baseline and replay rounds included.
  await creatorGuard(deps, task);
  const dispatchAccess = await systemTaskAccess(deps, task);
  const workspace = await deps.actions.workspace(task.workspaceId);
  if (workspace.status === "CLOSED" || workspace.status === "PREPARATION_FAILED") return "STALE";
  const receivedAt = iso(deps);
  const requestId = workflowRequestId("agentx-baseline-e2e-checks", taskId, workflow.revision, admission.baseCommitSha, admission.attempt);
  const accepted = await deps.actions.acceptTask(developerTaskIdentity(task, deps.orgId), task.workspaceId, {
    requestId, conversationId: task.conversationId,
    prompt: "Run the broker-admitted baseline E2E verification groups on the unchanged code. Do not edit files or expand the admitted scenarios.",
  }, (operation) => [
    { ConditionCheck: {
      TableName: deps.tableName, Key: taskKey(taskId),
      ConditionExpression: "workflow.revision = :revision AND workflow.#stage = :verify AND workflow.#state = :waiting AND workflow.candidate.digest = :candidate AND workflow.e2e.required = :required AND attribute_not_exists(closedAt)",
      ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
      ExpressionAttributeValues: { ":revision": workflow.revision, ":verify": "VERIFY", ":waiting": "WAITING", ":candidate": expected.candidateDigest, ":required": true },
    } },
    putNew(turnTable(deps), aiToolTurn({
      party: actor === undefined ? partyOfTask(task) : partyOfTaskActor(task, actor), turnId: randomUUID(), action: "continue", phase: "accepted", outcome: "accepted",
      receivedAt, finishedAt: iso(deps), request: "Run baseline E2E verification", response: `Broker-admitted baseline E2E CHECKS on the unchanged code started as operation ${operation.id}.`, operationId: operation.id,
    })),
    ...extra,
    ...(dispatchAccess === undefined ? [] : [accessFence(deps, dispatchAccess)]),
    requalifyHoldFence(deps.tableName, deps.now()), // AUTOREQUALIFY: no round starts once the test machine is being switched
  ], { sharedTask: task.shared === true, operationId, workflowMode: "CHECKS", workflowE2EAdmission: admission, readiness: [] });
  return accepted.duplicate ? "DUPLICATE" : "STARTED";
}

/**
 * T7b: starts the grounding round (the proposed plan's must-not-change scenarios on the unchanged code, before the owner is asked) as a separate server-admitted CHECKS operation
 * while the task holds its plan card back: PLAN/RUNNING, with `planGrounding.artifactSha256` naming the plan that is being checked. Like the baseline's start it changes nothing about the
 * workflow (no revision, no state, no round): the task is only held to be where the dispatch saw it (a condition check), so a round never starts for a task that has moved on, been
 * closed, or whose held plan is another one. `extra` is the grounding record's own start (REQUESTED to STARTED), written in the same transaction as the operation, so there is at most one
 * round per plan and attempt and never an operation without its record.
 */
export async function startTaskWorkflowE2EGroundingFromSystem(
  deps: DeveloperTaskRouteDependencies,
  taskId: string,
  expected: { workflowRevision: number; planArtifactSha256: string },
  admission: E2EWorkflowAdmissionRef,
  operationId: string,
  extra: TransactItems,
  actor?: DeveloperCaller,
): Promise<"STARTED" | "DUPLICATE" | "STALE"> {
  const task = await get<DeveloperTaskRecord>(deps, taskKey(taskId));
  const workflow = task?.workflow;
  const held = (task as { planGrounding?: { artifactSha256?: unknown } } | undefined)?.planGrounding;
  if (task === undefined || task.closedAt !== undefined || workflow === undefined
    || workflow.revision !== expected.workflowRevision || workflow.stage !== "PLAN" || workflow.state !== "RUNNING" || held?.artifactSha256 !== expected.planArtifactSha256
    || admission.purpose !== "grounding" || admission.baseCommitSha === undefined || admission.attempt === undefined || admission.planArtifactSha256 !== expected.planArtifactSha256
    || admission.taskId !== taskId || admission.workflowRevision !== workflow.revision || admission.roundId.length === 0
    || admission.groupRunIds.length === 0 || new Set(admission.groupRunIds).size !== admission.groupRunIds.length) return "STALE";
  await creatorGuard(deps, task);
  const dispatchAccess = await systemTaskAccess(deps, task);
  const workspace = await deps.actions.workspace(task.workspaceId);
  if (workspace.status === "CLOSED" || workspace.status === "PREPARATION_FAILED") return "STALE";
  const receivedAt = iso(deps);
  const requestId = workflowRequestId("agentx-grounding-e2e-checks", taskId, workflow.revision, admission.baseCommitSha, admission.attempt, expected.planArtifactSha256);
  const accepted = await deps.actions.acceptTask(developerTaskIdentity(task, deps.orgId), task.workspaceId, {    requestId, conversationId: task.conversationId,
    prompt: "Run the broker-admitted grounding E2E verification groups on the unchanged code. Do not edit files or expand the admitted scenarios.",
  }, (operation) => [
    { ConditionCheck: {
      TableName: deps.tableName, Key: taskKey(taskId),
      ConditionExpression: "workflow.revision = :revision AND workflow.#stage = :plan AND workflow.#state = :running AND planGrounding.artifactSha256 = :artifact AND attribute_not_exists(closedAt)",
      ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
      ExpressionAttributeValues: { ":revision": workflow.revision, ":plan": "PLAN", ":running": "RUNNING", ":artifact": expected.planArtifactSha256 },
    } },
    putNew(turnTable(deps), aiToolTurn({
      party: actor === undefined ? partyOfTask(task) : partyOfTaskActor(task, actor), turnId: randomUUID(), action: "continue", phase: "accepted", outcome: "accepted",
      receivedAt, finishedAt: iso(deps), request: "Run plan grounding E2E verification", response: `Broker-admitted grounding E2E CHECKS on the unchanged code started as operation ${operation.id}.`, operationId: operation.id,
    })),
    ...extra,
    ...(dispatchAccess === undefined ? [] : [accessFence(deps, dispatchAccess)]),
    requalifyHoldFence(deps.tableName, deps.now()), // AUTOREQUALIFY: no round starts once the test machine is being switched
  ], { sharedTask: task.shared === true, operationId, workflowMode: "CHECKS", workflowE2EAdmission: admission, readiness: [] });
  return accepted.duplicate ? "DUPLICATE" : "STARTED";
}

/**
 * M1.4 Task 4.6b: starts an audit replay of the task's qualified round as a separate server-admitted CHECKS operation. Like the baseline's start it changes nothing about the workflow (no
 * revision, no state, no round, no qualification): the task is only held to be where the operator saw it, open and still carrying the qualified round of that candidate (a condition
 * check), so a replay never starts for a task that has moved on or closed. `extra` is the replay record's own start (REQUESTED to STARTED), written in the same transaction as the
 * operation, so there is at most one replay per round and attempt and never an operation without its record. The request id is derived from the round and the attempt, so a repeated
 * request is the broker's duplicate of the first.
 */
export async function startTaskWorkflowE2EReplayFromSystem(
  deps: DeveloperTaskRouteDependencies,
  taskId: string,
  expected: { sourceRoundId: string; candidateDigest: string },
  admission: E2EWorkflowAdmissionRef,
  operationId: string,
  extra: TransactItems,
  requestedBy: ShareAdmin,
): Promise<"STARTED" | "DUPLICATE" | "STALE"> {
  const task = await get<DeveloperTaskRecord>(deps, taskKey(taskId));
  const workflow = task?.workflow;
  if (task === undefined || task.closedAt !== undefined || workflow === undefined || workflow.e2e?.required !== true
    || workflow.e2e.qualifiedRound?.roundId !== expected.sourceRoundId || workflow.e2e.qualifiedRound.candidateDigest !== expected.candidateDigest
    || workflow.candidate?.digest !== expected.candidateDigest
    || admission.purpose !== "replay" || admission.sourceRoundId !== expected.sourceRoundId || admission.attempt === undefined || admission.taskId !== taskId
    || admission.candidateDigest !== expected.candidateDigest || admission.workflowRevision !== workflow.revision || admission.roundId.length === 0
    || admission.groupRunIds.length === 0 || new Set(admission.groupRunIds).size !== admission.groupRunIds.length) return "STALE";
  // Ruling R60 (round 4 merge): a task whose creator was removed starts nothing, the baseline and replay rounds included.
  await creatorGuard(deps, task);
  const dispatchAccess = await systemTaskAccess(deps, task);
  const workspace = await deps.actions.workspace(task.workspaceId);
  if (workspace.status === "CLOSED" || workspace.status === "PREPARATION_FAILED") return "STALE";
  const receivedAt = iso(deps);
  const requestId = workflowRequestId("agentx-replay-e2e-checks", taskId, workflow.revision, expected.sourceRoundId, admission.attempt);
  const accepted = await deps.actions.acceptTask(developerTaskIdentity(task, deps.orgId), task.workspaceId, {
    requestId, conversationId: task.conversationId,
    prompt: "Run the broker-admitted audit replay of the verified AI-navigated round, with no model. Do not edit files or expand the admitted scenarios.",
  }, (operation) => [
    { ConditionCheck: {
      TableName: deps.tableName, Key: taskKey(taskId),
      ConditionExpression: "workflow.revision = :revision AND workflow.candidate.digest = :candidate AND workflow.e2e.required = :required AND workflow.e2e.qualifiedRound.roundId = :round AND attribute_not_exists(closedAt)",
      ExpressionAttributeValues: { ":revision": workflow.revision, ":candidate": expected.candidateDigest, ":required": true, ":round": expected.sourceRoundId },
    } },
    putNew(turnTable(deps), aiToolTurn({
      // The task's developer stays the task's owner field of the turn; the administrator who asked for the replay is the turn's `admin`, as for any administrator's action on the task.
      party: partyOfTask(task), turnId: randomUUID(), action: "continue", phase: "accepted", outcome: "accepted", admin: requestedBy,
      receivedAt, finishedAt: iso(deps), request: "Run audit replay of a verified round", response: `Broker-admitted audit replay (no model) started as operation ${operation.id}.`, operationId: operation.id,
    })),
    ...extra,
    ...(dispatchAccess === undefined ? [] : [accessFence(deps, dispatchAccess)]),
    requalifyHoldFence(deps.tableName, deps.now()), // AUTOREQUALIFY: no round starts once the test machine is being switched
  ], { sharedTask: task.shared === true, operationId, workflowMode: "CHECKS", workflowE2EAdmission: admission, readiness: [] });
  return accepted.duplicate ? "DUPLICATE" : "STARTED";
}
