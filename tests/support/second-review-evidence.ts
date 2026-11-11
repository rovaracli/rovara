// Test support for the second review's evidence: a replay run that passes the bar, and a verdict that holds, written straight into the State table (the real writers are the admin-pool routes).
import { secondReviewModelKey, type SecondReviewModelRef, type SecondReviewReplayCase, type SecondReviewReplayRun, type SecondReviewVerdict } from "@rovara-code/contracts";
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
  shadow: { startedAt: "2026-10-02T00:00:00.000Z", endedAt: "2026-10-20T00:00:00.000Z", findings: 10, agreed: 5, reviews: 10 }, createdAt: "2026-10-21T00:00:00.000Z", createdBy: "staff:test", ...over,
});
/** Evidence that holds for `model`. */
export function seedHoldingEvidence(db: FakeDynamoDb, model: SecondReviewModelRef, org: string = TEST_ORG): void {
  db.set({ ...secondReviewReplayKey(org, "run-1"), entityType: "SECOND_REVIEW_REPLAY", run: replayRun(model) });
  db.set({ ...secondReviewVerdictKey(org, secondReviewModelKey(model)), entityType: "SECOND_REVIEW_VERDICT", verdict: verdictFor(model) });
}

import { createHash } from "node:crypto";
import { trackRowKey } from "../../packages/broker/src/rovara-code/second-review-track.js";
import type { SecondReviewTrackRow } from "@rovara-code/contracts";

export const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
/** One track row (an answered second opinion) with `fixed` findings agreed, `wrong` wrong and `open` open, written straight into the State table. */
export function seedTrackRow(db: FakeDynamoDb, model: SecondReviewModelRef, input: { at: string; task: string; fixed?: number; wrong?: number; open?: number; firstCleared?: boolean; mode?: "shadow" | "on" }, org: string = TEST_ORG): SecondReviewTrackRow {
  const outcomes: Array<"fixed" | "wrong" | "open"> = [...Array<"fixed">(input.fixed ?? 0).fill("fixed"), ...Array<"wrong">(input.wrong ?? 0).fill("wrong"), ...Array<"open">(input.open ?? 0).fill("open")];
  const row: SecondReviewTrackRow = {
    model: secondReviewModelKey(model), mode: input.mode ?? "shadow", taskId: input.task, project: "web", candidateDigest: sha(`${input.task}${input.at}`), recordedAt: input.at,
    firstCleared: input.firstCleared ?? false, findings: outcomes.map((outcome, index) => ({ fp: sha(`${input.task}-${String(index)}`), outcome })), rev: 0,
  };
  db.set({ ...trackRowKey(org, row), entityType: "SECOND_REVIEW_TRACK", orgId: org, ...row });
  return row;
}
/** A shadow window the bar accepts: 16 days, 10 reviews, 10 findings, 5 agreed. */
export function seedPassingShadow(db: FakeDynamoDb, model: SecondReviewModelRef, org: string = TEST_ORG): void {
  seedTrackRow(db, model, { at: "2026-10-02T12:00:00.000Z", task: "t1", fixed: 3, open: 1, firstCleared: true }, org);
  seedTrackRow(db, model, { at: "2026-10-09T12:00:00.000Z", task: "t2", fixed: 2, wrong: 4 }, org);
  seedTrackRow(db, model, { at: "2026-10-18T12:00:00.000Z", task: "t3" }, org);
  // Seven more answered opinions that raised nothing: ten reviews in all.
  for (let n = 4; n <= 10; n += 1) seedTrackRow(db, model, { at: `2026-10-${String(n + 3).padStart(2, "0")}T12:00:00.000Z`, task: `t${String(n)}` }, org);
}
