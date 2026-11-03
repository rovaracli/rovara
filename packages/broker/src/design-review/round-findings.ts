// Design review stage, DR5: what the broker makes of a worker's design-review result, as a pure function (the wiring that calls it is DR7).
// The worker's own findings are early feedback and are never believed. The broker works from the uploaded ANSWERS:
//   1. only reviewers that verify.ts VERIFIED count; a voided reviewer's findings are dropped before anything else, and one voided reviewer never turns the round into an error;
//   2. each counted answer is read again (`readDesignReview`); one that cannot be read counts as "gave no result", with the others still counting;
//   3. every citation is checked against THAT reviewer's own packet items and the round's pins (`filterReviewerCitations`);
//   4. what is left is merged: the merge model's grouping is used only if it passes every merge check over exactly this set of findings, otherwise the code-only merge (`mergeDesignFindings`).
// Rovara's own findings (own-findings.ts) are added by the caller with `withOwnFindings`.
import {
  filterReviewerCitations, mergeDesignFindings,
  readDesignReview, type CitablePacketItem, type DesignFinding, type DesignReviewWorkerResult, type DroppedCitation, type DroppedFinding, type PinnedCommits, type RawDesignFinding, type ReviewerRole,
} from "@agentx/contracts";
import type { ReviewerVerifyFailure, VerifyResult } from "./verify.js";

export interface RoundReviewerState {
  role: ReviewerRole;
  /** The reviewer was verified AND its answer could be read. */
  counted: boolean;
  verified: boolean;
  /** Why the reviewer was not counted: a verify failure code, or "unreadable_output" / "no_answer" for an answer the broker could not use. */
  notUsed?: ReviewerVerifyFailure | "no_answer";
  /** Carried from verify.ts untouched, so the card can say "verified by packet digest" when the proxy did not confirm the first call. */
  inputProof?: Extract<VerifyResult, { verified: true }>["inputProof"];
  paraphrase?: string;
}

export interface AssembledRound {
  findings: DesignFinding[];
  omitted: number;
  mergeSource: "model" | "code";
  mergeFallback?: string;
  reviewers: RoundReviewerState[];
  droppedCitations: DroppedCitation[];
  droppedFindings: DroppedFinding[];
}

export function assembleRoundFindings(input: {
  result: Pick<DesignReviewWorkerResult, "reviewers" | "merge">;
  /** What verify.ts decided, by role. A reviewer with no entry is not verified. */
  verification: ReadonlyMap<ReviewerRole, VerifyResult>;
  /** The items of the packet the broker built for each reviewer. */
  packets: ReadonlyMap<ReviewerRole, readonly CitablePacketItem[]>;
  pins: PinnedCommits;
}): AssembledRound {
  const reviewers: RoundReviewerState[] = [];
  const raw: RawDesignFinding[] = [];
  for (const outcome of input.result.reviewers) {
    const verdict = input.verification.get(outcome.role);
    if (verdict === undefined || !verdict.verified) {
      reviewers.push({ role: outcome.role, counted: false, verified: false, notUsed: verdict === undefined ? "unreadable_output" : verdict.failure });
      continue;
    }
    const base = { role: outcome.role, verified: true, inputProof: verdict.inputProof } as const;
    if (outcome.answer === undefined) { reviewers.push({ ...base, counted: false, notUsed: "no_answer" }); continue; }
    const read = readDesignReview(outcome.answer, outcome.role);
    if (!read.ok) { reviewers.push({ ...base, counted: false, notUsed: "unreadable_output" }); continue; }
    raw.push(...read.findings);
    reviewers.push({ ...base, counted: true, ...(read.paraphrase === undefined ? {} : { paraphrase: read.paraphrase }) });
  }
  const cited = filterReviewerCitations(raw, input.packets, input.pins);
  // A merge answer that was made over a different set of findings (for example one that included a voided reviewer's) fails the merge checks and falls back to the code-only merge.
  const merged = mergeDesignFindings(cited.findings, input.result.merge.answer);
  return {
    findings: merged.findings, omitted: merged.omitted, mergeSource: merged.source, ...(merged.fallback === undefined ? {} : { mergeFallback: merged.fallback }),
    reviewers, droppedCitations: cited.droppedCitations, droppedFindings: cited.droppedFindings,
  };
}
