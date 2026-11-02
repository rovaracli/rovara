// Test support for the second review's evidence: a replay run that passes the bar, and a verdict that holds, written straight into the State table (the real writers are the admin-pool routes).
import { secondReviewModelKey, type SecondReviewModelRef, type SecondReviewReplayCase, type SecondReviewReplayRun, type SecondReviewVerdict } from "../../packages/contracts/src/index.js";
import { secondReviewReplayKey, secondReviewVerdictKey } from "../../packages/broker/src/org/second-review-settings.js";
import type { FakeDynamoDb } from "./fake-dynamodb.js";
import { TEST_ORG } from "./orgs.js";

export const BASELINE = { provider: "amazon-bedrock", modelId: "anthropic.claude-opus-4-1" };

/** 30 known defects and 20 planted bugs; the baseline catches 20 and the candidate all of those and 6 more; nothing dismissed. This passes the bar. */
export function passingCases(): SecondReviewReplayCase[] {
  return Array.from({ length: 50 }, (_, index) => ({
    caseId: `case-${String(index)}`, kind: index < 30 ? "known_defect" as const : "planted_bug" as const,
    baselineCaught: index < 20, candidateCaught: index < 26, candidateBlockingFindings: 0, candidateDismissedBlocking: 0,
  }));
}
export const replayRun = (model: SecondReviewModelRef, over: Partial<SecondReviewReplayRun> = {}): SecondReviewReplayRun =>
  ({ runId: "run-1", ranAt: "2026-10-01T00:00:00.000Z", candidate: model, baseline: BASELINE, cases: passingCases(), ...over });
export const verdictFor = (model: SecondReviewModelRef, over: Partial<SecondReviewVerdict> = {}): SecondReviewVerdict => ({
  model: secondReviewModelKey(model), replayRunId: "run-1", baseline: BASELINE,
  shadow: { startedAt: "2026-10-02T00:00:00.000Z", endedAt: "2026-10-20T00:00:00.000Z", findings: 10, agreed: 5 }, createdAt: "2026-10-21T00:00:00.000Z", createdBy: "staff:test", ...over,
});
/** Evidence that holds for `model`. */
export function seedHoldingEvidence(db: FakeDynamoDb, model: SecondReviewModelRef, org: string = TEST_ORG): void {
  db.set({ ...secondReviewReplayKey(org, "run-1"), entityType: "SECOND_REVIEW_REPLAY", run: replayRun(model) });
  db.set({ ...secondReviewVerdictKey(org, secondReviewModelKey(model)), entityType: "SECOND_REVIEW_VERDICT", verdict: verdictFor(model) });
}
