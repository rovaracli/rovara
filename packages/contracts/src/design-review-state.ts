// Design review stage, DR6 (designs-2026-10-30/design-review-stage.md 3.2): the pure reads of a stored design review. Browser-safe: the task page, the cards and the workflow's transitions
// (task-workflow-design-review.ts) all read the review through these, so "is it on", "what stays settled" and "what is still in dispute" have one answer.
// Nothing here approves anything. Every list below is derived from the stored rounds, so there is nothing to keep in step.
import { DESIGN_REVIEW_ROUNDS_MAX, type DesignFinding, type DesignReviewRound, type FindingResolution, type WorkflowDesignReview } from "./design-review.js";

/** The review is switched on and waits for its first design: the only state in which a submitted design document is admitted to the review. */
export function designReviewAwaitsDesign(review: WorkflowDesignReview | undefined): boolean {
  return review !== undefined && review.status === "estimating" && review.rounds.length === 0;
}

/** The review has begun and has not ended: any status but the three that ended it. */
export function designReviewActive(review: WorkflowDesignReview | undefined): boolean {
  return review !== undefined && review.status !== "done" && review.status !== "not_run" && review.status !== "stopped_at_cap";
}

/** Whether a workflow's plan-check stage is the design review's, not the plan check's. A design is only reviewed in the DESIGN phase of a Full task. */
export function workflowIsDesignReviewing(workflow: { designReview?: WorkflowDesignReview | undefined; reviewPhase?: string | undefined }): boolean {
  return workflow.designReview !== undefined && workflow.reviewPhase === "DESIGN";
}

/**
 * A person asked for changes to the design: it is reviewed afresh (two new rounds), and what it cost stays counted toward the task's cap. The earlier rounds belong to the design that was
 * sent back; the decision that sent it back stays on the workflow's own record.
 */
export function rearmedDesignReview(review: WorkflowDesignReview): WorkflowDesignReview {
  const { estimateUsd: _estimate, notRunReason: _reason, ...kept } = review;
  void _estimate;
  void _reason;
  return { ...kept, status: "estimating", rounds: [] };
}

/** A finding and what the planner did with it, for one round. */
export function resolutionOf(round: DesignReviewRound, findingId: string): FindingResolution | undefined {
  return round.resolutions.find((resolution) => resolution.findingId === findingId);
}

/** Every finding of the round has a resolution. */
export function designRoundResolved(round: DesignReviewRound): boolean {
  return round.findings.every((finding) => resolutionOf(round, finding.id) !== undefined);
}

/** Whether a round has a reviewer whose result counts (the broker verified it was fresh and read-only). */
export function designRoundHasResult(round: DesignReviewRound): boolean {
  return round.reviewers.some((run) => run.verified);
}

/** The finding of an earlier round with the same fingerprint (section plus normalised text), if the round raised it before: the card shows "raised again". */
export function designFindingRaisedBefore(review: Pick<WorkflowDesignReview, "rounds">, roundNumber: number, finding: Pick<DesignFinding, "fingerprint">): DesignFinding | undefined {
  for (const round of review.rounds) {
    if (round.round >= roundNumber) break;
    const earlier = round.findings.find((candidate) => candidate.fingerprint === finding.fingerprint);
    if (earlier !== undefined) return earlier;
  }
  return undefined;
}

export const DESIGN_DISAGREEMENT_KINDS = ["contested", "unresolved", "unchecked_fix", "oscillation"] as const;
export type DesignDisagreementKind = (typeof DESIGN_DISAGREEMENT_KINDS)[number];

export interface DesignDisagreement {
  round: 1 | 2;
  findingId: string;
  severity: "blocker" | "major";
  /**
   * contested: the planner contested a blocker with evidence (both sides are shown);
   * unresolved: nobody resolved it (the review stopped at the cost cap, the planner's revision failed, or the loop ended);
   * unchecked_fix: the planner says it fixed it in the last round, and no reviewer read the fix;
   * oscillation: fixing it would undo an earlier fix, so the loop ended and a person decides.
   */
  kind: DesignDisagreementKind;
  raisedAgain: boolean;
}

/**
 * What the approver sees under "Disagreements" once the review is over: every blocker or major of the last round that has a result, unless it was fixed and read again, or answered by a
 * person, plus every contested blocker. A contested major is settled (3.2 lists contested blockers only). A nit is never listed. An empty list is also the answer while the review is still
 * running: the list belongs to a review that has ended. The card is at least medium risk while this list has anything in it.
 */
export function designReviewDisagreements(review: WorkflowDesignReview | undefined): DesignDisagreement[] {
  if (review === undefined || (review.status !== "done" && review.status !== "stopped_at_cap")) return [];
  const round = [...review.rounds].reverse().find(designRoundHasResult);
  if (round === undefined) return [];
  const found: DesignDisagreement[] = [];
  for (const finding of round.findings) {
    if (finding.severity === "nit") continue;
    const resolution = resolutionOf(round, finding.id);
    let kind: DesignDisagreementKind | undefined;
    if (round.oscillation?.includes(finding.id) === true && resolution === undefined) kind = "oscillation";
    else if (resolution === undefined) kind = "unresolved";
    else if (resolution.action === "fixed") kind = "unchecked_fix";
    else if (resolution.action === "contested" && finding.severity === "blocker") kind = "contested";
    if (kind !== undefined) found.push({ round: round.round, findingId: finding.id, severity: finding.severity, kind, raisedAgain: designFindingRaisedBefore(review, round.round, finding) !== undefined });
  }
  return found;
}

/** How many planner revisions the review has used: one for each round whose findings the planner resolved. Never more than DESIGN_REVIEW_ROUNDS_MAX. */
export function designReviewRevisionsUsed(review: Pick<WorkflowDesignReview, "rounds">): number {
  return Math.min(DESIGN_REVIEW_ROUNDS_MAX, review.rounds.filter((round) => round.findings.length > 0 && designRoundResolved(round)).length);
}
