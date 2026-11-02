// Stop & redirect, phase 2: the task module's side of the restart (agent-sessions/redirect-continue.ts decides WHETHER to restart; these start the run). Each acts as the person who redirected, as the
// session actor of the task functions (their project role is checked again, their payer pays, and the restart keeps their cap window: a redirect never resets it, and never goes on over a pause that
// waits for an approval). Each starts a step only from the workflow at exactly the revision the redirect recorded, in the one transaction that moves the workflow, and throws, having started
// nothing, otherwise. The instruction reaches the model framed and as untrusted data, in one place only: the worker's frame for a coding run, the nonce tag below for planning.
import { secondReviewSendBackProblems } from "../../rovara-code/second-review-store.js";
import { randomUUID } from "node:crypto";
import {
  REDIRECT_REFUSAL_MESSAGES,
  workflowSendBackOffered,
  REDIRECT_RETRY_INSTRUCTIONS,
  WORKFLOW_BLOCK_REASONS,
  WORKFLOW_REDIRECT_SEND_BACK_REASON,
  WorkflowTransitionError,
  agentXError,
  returnWorkflowToImplementation,
  sendBackProblems,
  type OwnerRedirectInvocation,
  type RedirectRecord,
  type WorkflowSnapshot,
} from "@agentx/contracts";
import { startRevisedPlan, type RevisedPlanStart } from "../../agent-sessions/live-steer-revise.js";
import { aiToolTurn, developerTaskIdentity, taskKey } from "../../developer/task-records.js";
import { requireNewWorkAllowed } from "../../developer/project-roles.js";
import { E2E_OWNER_SENTENCES } from "../../e2e/owner-sentences.js";
import { isConditional } from "../broker-shared.js";
import type { DeveloperCaller } from "../developer-routes.js";
import { accessFence, authorizeTaskAction } from "./access.js";
import { partyOfTaskActor, putNew, turnTable, iso } from "./common.js";
import type { DeveloperTaskRouteDependencies } from "./types.js";
import { AUTOMATIC_KEEPS_WINDOW, actionableWorkspace, busyOrClosing, refuseAutomaticWhilePaused } from "./task-window.js";
import { fedThroughUpdate, promptTagId, sendBackProblemsPromptSection, withCurrentThreadNotes } from "./thread-notes.js";
import { NO_PUBLISH_NOTE, approvedCodingPlan, approvedWorkflowDependencies, ownerConstraintsSection, retiredClaimIdList } from "./workflow-inputs.js";
import { queueWorkflowCoding, retryWorkflowImplementation, sharedAccessCheck } from "./workflow-coding.js";
import { requireProjectSendBackRole } from "../../developer/task-access.js";
import { framedPlanningInstruction, redirectRestartRequestId } from "./redirect-frame.js";

export { framedPlanningInstruction, redirectRestartRequestId };
import { queueWorkflowUnderstand } from "./workflow-starts.js";
import { revisePlanHost } from "./workflow-revise.js";
import { workflowDependenciesAllowed } from "../../rovara-code/parallel-parts.js";

/** The words a Plan or Understand turn record carries for a redirect (never the instruction). */
const TURN_REQUEST = REDIRECT_RETRY_INSTRUCTIONS;

/** The task as the redirect found it: open, a workflow, and at exactly the revision the redirect recorded. A task that moved is `IDEMPOTENCY_CONFLICT`, and nothing is started. */
async function currentTask(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, record: RedirectRecord, action: "retry" | "work") {
  const access = await authorizeTaskAction(deps, caller, record.taskId, action);
  const workflow = access.task.workflow;
  if (workflow === undefined || workflow.revision !== record.blockedRevision || workflow.stage !== record.step || workflow.state !== "BLOCKED") {
    throw agentXError("IDEMPOTENCY_CONFLICT", "the task moved on while the redirect was being carried out");
  }
  // A restart is new agent work: an archived project takes none, whoever asks.
  await requireNewWorkAllowed(deps, deps.orgId, access.task.project, "contributor", "task");
  return { access, task: access.task, workflow };
}

/** Understand or Plan stopped (either mode): the step runs again. Both read the owner's words framed as data in their prompt, and neither shows the thread note a second time. */
export async function restartPlanningForRedirect(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, record: RedirectRecord, text: string): Promise<void> {
  const { access, task, workflow } = await currentTask(deps, caller, record, "retry");
  refuseAutomaticWhilePaused(task);
  await actionableWorkspace(deps, task);
  if (record.step === "UNDERSTAND") {
    try {
      // The owner's words go in the prompt framed as data, as Plan's do, and their thread note is left out of the notes (it counts as given): not as an unframed thread note (LR-2).
      await queueWorkflowUnderstand(deps, task, {
        requestId: redirectRestartRequestId(record), access, actor: caller, cap: AUTOMATIC_KEEPS_WINDOW, request: TURN_REQUEST, response: "Restarting the understanding step",
        redirect: { instruction: framedPlanningInstruction(task, record.requestId, text), skipNoteIds: [record.messageId] },
      });
    } catch (error) {
      if (isConditional(error)) await authorizeTaskAction(deps, caller, task.taskId, "retry");
      await busyOrClosing(deps, task, error);
    }
    return;
  }
  const receivedAt = iso(deps);
  const { blockReason: _blockReason, ...unblocked } = workflow;
  void _blockReason;
  const next: WorkflowSnapshot = { ...unblocked, revision: workflow.revision + 1, state: "RUNNING", updatedAt: receivedAt };
  const retired = await retiredClaimIdList(deps, workflow);
  const instruction = framedPlanningInstruction(task, record.requestId, text);
  try {
    await withCurrentThreadNotes(deps, task, redirectRestartRequestId(record), (current, notes) => {
      const fed = fedThroughUpdate(notes);
      return deps.actions.acceptTask(developerTaskIdentity(current, deps.orgId), current.workspaceId, { requestId: redirectRestartRequestId(record), conversationId: current.conversationId, prompt: instruction + notes.suffix }, (operation) => [
        { Update: {
          TableName: deps.tableName, Key: taskKey(task.taskId),
          UpdateExpression: `SET workflow = :workflow, updatedAt = :now${fed.clause}`,
          ConditionExpression: `workflow.revision = :revision AND workflow.#state = :blocked AND workflow.#stage = :plan${fed.condition}`,
          ExpressionAttributeNames: { "#state": "state", "#stage": "stage" },
          ExpressionAttributeValues: { ":workflow": next, ":now": receivedAt, ":revision": workflow.revision, ":blocked": "BLOCKED", ":plan": "PLAN", ...fed.values },
        } },
        putNew(turnTable(deps), aiToolTurn({
          party: partyOfTaskActor(task, caller), turnId: randomUUID(), action: "continue", phase: "accepted", outcome: "accepted", receivedAt, finishedAt: iso(deps),
          request: TURN_REQUEST, response: `Restarting the planning stage as operation ${operation.id}.`, operationId: operation.id,
        })),
        accessFence(deps, access),
      ], { sharedTask: task.shared === true, workflowMode: "PLAN", ...(retired.length === 0 ? {} : { retiredClaimIds: retired }), ...(next.reviewPhase === undefined ? {} : { workflowPhase: next.reviewPhase }) });
    }, [record.messageId]);
  } catch (error) {
    if (isConditional(error)) await authorizeTaskAction(deps, caller, task.taskId, "retry");
    await busyOrClosing(deps, task, error);
  }
}

/** Coding stopped and the plan stays: the same step again from the current code, carrying the instruction to a worker that binds it. */
export async function restartCodingForRedirect(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, record: RedirectRecord, ownerRedirect: OwnerRedirectInvocation): Promise<void> {
  const { access } = await currentTask(deps, caller, record, "retry");
  await retryWorkflowImplementation(deps, caller, access, { requestId: redirectRestartRequestId(record), instructions: REDIRECT_RETRY_INSTRUCTIONS, expectedRevision: record.blockedRevision }, { ownerRedirect, skipNoteIds: [record.messageId] });
}

/**
 * The checks or the review stopped: coding runs again, as a send-back to coding does (the owner's decision 2026-10-31: a redirect during Review or Checks restarts coding). The decision recorded is a
 * send-back with fixed words; no learning event is raised for it (it is not a reason a person wrote). The approved plan, any ordered work plan and the owner's constraints go to the coder as in a send-back.
 */
export async function sendBackForRedirect(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, record: RedirectRecord, ownerRedirect: OwnerRedirectInvocation): Promise<void> {
  const checked = sharedAccessCheck(deps);
  const { access, task, workflow } = await currentTask(checked, caller, record, "work");
  // This restarts coding as a send-back, so it needs the project access a send-back needs (0.4.27) for the person who redirected: owner or co-owner of the task is not enough on its own. Refused before anything is written.
  await requireProjectSendBackRole(checked, task, caller);
  // A step that was blocked already restarts coding only where the owner's own send-back would be offered (S3); a step this redirect stopped has no finding to send back and is exempt.
  if (record.kind === "blocked" && !workflowSendBackOffered(workflow)) throw agentXError("CONFIG_INVALID", REDIRECT_REFUSAL_MESSAGES.nothing_to_send_back);
  const receivedAt = iso(deps);
  let returned: WorkflowSnapshot;
  try {
    // The person is the task's owner or a co-owner (checked by the caller just now), so the authority names them.
    returned = returnWorkflowToImplementation(workflow, { requestId: redirectRestartRequestId(record), actorId: access.actorId, reason: WORKFLOW_REDIRECT_SEND_BACK_REASON, now: receivedAt }, { actorId: access.actorId, ownerIds: [access.actorId] });
  } catch (error) {
    if (error instanceof WorkflowTransitionError) throw agentXError("CONFIG_INVALID", error.message);
    throw error;
  }
  if (workflow.blockReason === WORKFLOW_BLOCK_REASONS.budgetPaused) throw agentXError("CONFIG_INVALID", "the task is paused for budget");
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
  const problems = sendBackProblemsPromptSection([...sendBackProblems(workflow, E2E_OWNER_SENTENCES.groupSentence), ...secondReviewSendBackProblems(task, workflow)], promptTagId(task, redirectRestartRequestId(record)));
  const prompt = (notes: string) => `Address the problems below in the code, keeping to the approved plan. ${NO_PUBLISH_NOTE}\n\n${problems}\n\nOwner note (the owner's own instructions for this step): ${REDIRECT_RETRY_INSTRUCTIONS}${ownerConstraintsSection(workflow, plan)}\n\nApproved plan (sha256 ${plan.sha256}):\n${plan.text}${notes}`;
  const next: WorkflowSnapshot = { ...returned, revision: returned.revision + 1, state: "RUNNING", updatedAt: receivedAt };
  await queueWorkflowCoding(deps, caller, { ...access, task: { ...task, workflow } }, {
    requestId: redirectRestartRequestId(record), prompt, next, request: REDIRECT_RETRY_INSTRUCTIONS,
    response: workflowDependencies === undefined ? "AgentX sent the change back to coding" : "AgentX restarted the approved ordered work plan",
    ...(restartApprovedGraph === undefined ? {} : { workflowDependencies: restartApprovedGraph }),
    keepWindow: true, ownerRedirect, skipNoteIds: [record.messageId],
  });
}

/** Coding stopped and the plan changes: the workflow goes to planning with the owner's request for changes recorded, and the revised plan waits for the owner's approval before any coding. */
export async function revisePlanForRedirect(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, record: RedirectRecord, text: string): Promise<void> {
  const { access, workflow } = await currentTask(deps, caller, record, "work");
  if (workflow.blockReason === undefined) throw agentXError("IDEMPOTENCY_CONFLICT", "the task moved on while the redirect was being carried out");
  const change = text.replace(/\s+/gu, " ").trim();
  const start: RevisedPlanStart = {
    requestId: redirectRestartRequestId(record), change,
    source: "The task owner stopped coding and gave this as a new instruction that changes the plan. Write the change into the revised document. The owner approves the revised plan before any coding.",
    turnRequest: "Revise the plan after the owner stopped and redirected coding", stoppedReason: workflow.blockReason,
    redirect: { skipNoteIds: [record.messageId] }, authority: { actorId: access.actorId, ownerIds: [access.actorId] },
  };
  const started = await startRevisedPlan(deps, caller, record.taskId, revisePlanHost, access, start);
  void started;
}
