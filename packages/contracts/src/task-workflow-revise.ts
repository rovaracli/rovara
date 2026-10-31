// Live steer: "Revise the plan with this change". A coding step stopped because the owner's live message asked for a change outside the approved plan (the step's blocked reason is
// `liveSteerReapprovalRevise`). The owner, and only the owner, can send the work back to PLANNING with that change: the move below is IMPLEMENT/BLOCKED to PLAN/READY, recorded as the owner's request
// for changes to the approved coding plan (the ordinary gate decision, so no client meets a new decision kind). The planner then writes the revised plan, the plan check and self-check run as they do
// for any plan, and the owner approves it through the existing plan approval (`decideWorkflow`); only that approval starts coding again. Nothing here approves anything, and the message's text is never in
// the workflow: the decision's reason is a fixed sentence.
import { WORKFLOW_BLOCK_REASONS } from "./task-workflow.js";
import { WorkflowDecisionSchema } from "./task-workflow.js";
import { WorkflowSnapshotSchema, WorkflowTransitionError, workflowOwnerAuthorized, type WorkflowOwnerAuthority, type WorkflowSnapshot } from "./task-workflow-node.js";

/** The reason the owner's request for changes carries in the workflow's decision history (fixed words, never the message). Later coding rounds read it as one of the owner's plan instructions, so it says what holds. */
export const WORKFLOW_REVISE_PLAN_DECISION_REASON = "The plan was revised to include a change the owner sent as a live message while coding ran.";

/** What the plan can take in: a workflow with no custom sequence, no pull request opened, no fix round in flight and an approved coding plan to revise. Anything else keeps the round-2 words (Retry coding, or a new task). */
export function workflowReviseShapeOk(workflow: Pick<WorkflowSnapshot, "path" | "reviewPhase" | "artifacts"> & { program?: unknown; pullRequests?: readonly unknown[] | undefined; fixSource?: unknown }): boolean {
  return workflow.program === undefined && (workflow.pullRequests?.length ?? 0) === 0 && workflow.fixSource === undefined
    && (workflow.path !== "FULL" || workflow.reviewPhase === "IMPLEMENTATION_PLAN") && workflow.artifacts.some((artifact) => artifact.type === "plan");
}

/** The block reason coding stops with when the owner's live message asked for a change outside the approved plan: the one that offers Revise the plan when the plan can take the change in. */
export function liveSteerCodingBlockReason(workflow: Parameters<typeof workflowReviseShapeOk>[0]): string {
  return workflowReviseShapeOk(workflow) ? WORKFLOW_BLOCK_REASONS.liveSteerReapprovalRevise : WORKFLOW_BLOCK_REASONS.liveSteerReapprovalCoding;
}

/** Whether Slack, the task page and the route offer Revise the plan: coding is blocked with the revise reason and the plan can still take the change in. */
export function workflowReviseOffered(workflow: Pick<WorkflowSnapshot, "stage" | "state" | "blockReason"> & Parameters<typeof workflowReviseShapeOk>[0]): boolean {
  return workflow.stage === "IMPLEMENT" && workflow.state === "BLOCKED" && workflow.blockReason === WORKFLOW_BLOCK_REASONS.liveSteerReapprovalRevise && workflowReviseShapeOk(workflow);
}

/**
 * The owner sends coding that stopped for their live message back to planning: PLAN/READY at the next revision, with their request for changes to the approved plan recorded. Only the task owner may;
 * the request id may not have been used before (the broker answers a repeat of its own request before it gets here). What belonged to the plan being replaced is dropped (its plan check, its browser and
 * API state, its ordered-work approval): the revised plan is checked and approved afresh. The candidate, checks and reviews of the earlier code stay, as they do when a plan is sent back from review.
 */
export function revisePlanWithLiveChange(
  currentInput: unknown, input: { requestId: string; actorId: string; now: string }, authority?: WorkflowOwnerAuthority,
): WorkflowSnapshot {
  const parsed = WorkflowSnapshotSchema.safeParse(currentInput);
  if (!parsed.success) throw new WorkflowTransitionError("workflow snapshot is invalid");
  const current = parsed.data;
  if (!workflowOwnerAuthorized(current.ownerId, input.actorId, authority)) throw new WorkflowTransitionError("only the task owner can revise the plan with this change");
  if (!workflowReviseOffered(current)) throw new WorkflowTransitionError("this work did not stop for a change the plan can take in, so the plan cannot be revised with it");
  if (current.decisions.some((decision) => decision.requestId === input.requestId)) throw new WorkflowTransitionError("request ID was already used for a different workflow decision");
  if (current.decisions.length >= 100) throw new WorkflowTransitionError("workflow decision history is full");
  const plan = current.artifacts.filter((artifact) => artifact.type === "plan").at(-1)!;
  const decision = WorkflowDecisionSchema.parse({
    requestId: input.requestId, workflowRevision: current.revision, decision: "REQUEST_CHANGES", actorId: input.actorId, actorRole: "TASK_OWNER",
    reason: WORKFLOW_REVISE_PLAN_DECISION_REASON, artifactDigest: plan.sha256, at: input.now,
  });
  const { blockReason: _blockReason, critique: _critique, e2e: _e2e, workflowDependenciesApproval: _approval, workflowDependenciesOperationId: _operation, workflowDependenciesProgress: _progress, ...kept } = current;
  void _blockReason;
  void _critique;
  void _e2e;
  void _approval;
  void _operation;
  void _progress;
  return WorkflowSnapshotSchema.parse({
    ...kept, revision: current.revision + 1, stage: "PLAN", state: "READY", outcome: "CHANGES_REQUESTED", decisions: [...current.decisions, decision], updatedAt: input.now,
  });
}
