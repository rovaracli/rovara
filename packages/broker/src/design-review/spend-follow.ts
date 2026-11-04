// Design review stage, DR7 slice B2 (design-review-stage.md 3.6): what a choice on the spend card does after the person made it. The commit port of the spend route calls `designSpendCommitItems` inside ONE transaction, so the
// choice, the workflow move and the dispatch row that makes the next step due can never differ:
//   raise_cap / lower_tier   the review is "estimating" again; a CRITIQUE row is due at the NEW revision, so the round starts (the gate runs again when it starts, task room included);
//   run_unpriced             the workflow is NOT moved here: it stays at the hold. A CRITIQUE row at the same revision carries who approved (`costApprovedBy`), and the round's start moves WAITING to RUNNING with
//                            `costApproved` (`startDesignReview`), in the same write that creates the round's operation. The approval is bound to that revision: a changed hold has another revision and the row is stale;
//   skip                     the review closes to the next phase (`skipDesignReview`); a skip before any design exists puts the task on to its design, so a PLAN row is due.
// Nothing here checks who may choose: that is `designSpendChoiceHandler`, which calls the commit port only after every permission check.
import { WorkflowTransitionError, type WorkflowSnapshot } from "@agentx/contracts";
import { taskKey } from "../developer/task-records.js";
import { WORKFLOW_NO_CANDIDATE_DIGEST, workflowDispatchItem } from "../aws/broker-shared.js";
import { applyDesignSpendChoice, type DesignSpendWrite } from "./spend-choice.js";

type Item = { Update?: unknown; ConditionCheck?: unknown; Put?: { Item: Record<string, unknown>; TableName: string; ConditionExpression?: string } };

export interface DesignSpendCommit {
  /** The workflow after the choice (the same snapshot for run_unpriced). */
  workflow: WorkflowSnapshot;
  /** The task's write and the dispatch row that follows, for the commit port's transaction. */
  items: Item[];
}

export function designSpendCommitItems(
  input: { tableName: string; taskId: string; workflow: WorkflowSnapshot; write: Pick<DesignSpendWrite, "actorId" | "applied">; estimateUsd?: number | undefined; now: string },
): DesignSpendCommit {
  const { workflow, write, now } = input;
  const review = workflow.designReview;
  const expectedRevision = workflow.revision;
  const guard = "workflow.revision = :revision AND attribute_not_exists(closedAt)";
  const dispatchRow = (kind: "CRITIQUE" | "PLAN", revision: number, approvedBy?: string): Item => {
    const row = workflowDispatchItem(input.tableName, input.taskId, revision, kind, WORKFLOW_NO_CANDIDATE_DIGEST, now) as { Put: { Item: Record<string, unknown>; TableName: string; ConditionExpression?: string } };
    return approvedBy === undefined ? row : { Put: { ...row.Put, Item: { ...row.Put.Item, costApprovedBy: approvedBy } } };
  };
  if (write.applied.choice === "run_unpriced") {
    // Only at the cost hold. The hold stays as it is (so the card does not change under the person), and a ConditionCheck keeps the commit conditional on the revision they saw.
    if (review === undefined || workflow.stage !== "PLAN_CRITIQUE" || workflow.state !== "WAITING" || review.status !== "waiting_cost") throw new WorkflowTransitionError("the design review is not at the cost hold");
    return {
      workflow,
      items: [
        { ConditionCheck: { TableName: input.tableName, Key: taskKey(input.taskId), ConditionExpression: guard, ExpressionAttributeValues: { ":revision": expectedRevision } } },
        dispatchRow("CRITIQUE", expectedRevision, write.actorId),
      ],
    };
  }
  const next = applyDesignSpendChoice(workflow, write, { expectedRevision, now, estimateUsd: input.estimateUsd });
  const update: Item = { Update: {
    TableName: input.tableName, Key: taskKey(input.taskId), UpdateExpression: "SET workflow = :workflow, updatedAt = :now", ConditionExpression: guard,
    ExpressionAttributeValues: { ":workflow": next, ":now": now, ":revision": expectedRevision },
  } };
  // The round starts from PLAN_CRITIQUE/READY (raise, lower, or a retry from the person's card); a skip before any design goes on to the design.
  const due = next.stage === "PLAN_CRITIQUE" && next.state === "READY" ? dispatchRow("CRITIQUE", next.revision)
    : write.applied.choice === "skip" && next.stage === "PLAN" && next.state === "READY" ? dispatchRow("PLAN", next.revision) : undefined;
  return { workflow: next, items: due === undefined ? [update] : [update, due] };
}
