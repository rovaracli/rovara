// The triage of the contract drift Cloud accepted when the check was added (briefs/codex/contract-drift-triage). Each drift whose field Code sends TODAY on a path Cloud reads exactly was fixed by mirroring Code's
// schema; each fix has its proof here: a value shaped as Code 4ff67252e (and Code 0.5.48) sends it parses, and one shaped as before the field still parses.
import { describe, expect, it } from "vitest";
import { DESIGN_DROPPED_FINDINGS_MAX, DesignReviewRoundSchema } from "../../packages/contracts/src/design-review.js";
import { VerificationResultsSchema } from "../../packages/contracts/src/task-workflow.js";
import { readAccepted } from "../../scripts/contract-drift/run.js";

const DIGEST = "a".repeat(64);
const round = (extra: Record<string, unknown> = {}) => ({ round: 1, designDigest: DIGEST, reviewers: [], findings: [], resolutions: [], ...extra });

describe("design review round: what Code records on every round it ran priced (rounds[].estimateUsd, rounds[].unreadableFindings)", () => {
  it("reads a round Code recorded with its estimate and its count of findings it could not use", () => {
    expect(DesignReviewRoundSchema.safeParse(round({ estimateUsd: 1.25, unreadableFindings: 2 })).success).toBe(true);
    expect(DesignReviewRoundSchema.safeParse(round({ estimateUsd: 0 })).success).toBe(true);
    expect(DesignReviewRoundSchema.safeParse(round({ unreadableFindings: DESIGN_DROPPED_FINDINGS_MAX })).success).toBe(true);
  });
  it("still reads a round recorded before the two fields", () => {
    expect(DesignReviewRoundSchema.safeParse(round()).success).toBe(true);
  });
  it("keeps Code's bounds: the count is a whole number from 1 to the dropped-findings maximum, the estimate is 0 to 10,000 dollars, and nothing else is let in", () => {
    for (const bad of [{ unreadableFindings: 0 }, { unreadableFindings: 1.5 }, { unreadableFindings: DESIGN_DROPPED_FINDINGS_MAX + 1 }, { estimateUsd: -0.01 }, { estimateUsd: 10_001 }, { estimateUsd: "1" }, { surprise: true }]) {
      expect(DesignReviewRoundSchema.safeParse(round(bad)).success).toBe(false);
    }
  });
});

describe("verification results: a check a Rovara-made fake answered for (results[].madeByRovara)", () => {
  const verification = (result: Record<string, unknown>) => ({ candidateDigest: DIGEST, producer: "worker", environmentId: "env-1", recordedAt: "2026-11-23T12:00:00.000Z", results: [{ checkId: "unit", status: "PASS", ...result }] });
  it("reads the mark Code writes (always the literal true), and a result without it", () => {
    expect(VerificationResultsSchema.safeParse(verification({ madeByRovara: true })).success).toBe(true);
    expect(VerificationResultsSchema.safeParse(verification({})).success).toBe(true);
  });
  it("refuses anything but true, and any other field", () => {
    expect(VerificationResultsSchema.safeParse(verification({ madeByRovara: false })).success).toBe(false);
    expect(VerificationResultsSchema.safeParse(verification({ madeBySomeoneElse: true })).success).toBe(false);
  });
});

describe("the ratchet proves the fixes", () => {
  it("no accepted drift names a field this triage fixed", () => {
    const fixed = readAccepted().filter(({ key }) => /rounds\[\]\.(?:estimateUsd|unreadableFindings)|verification\.results\[\]\.madeByRovara|\bresults\[\]\.madeByRovara/u.test(key) && !/testing\.rows/u.test(key));
    expect(fixed.map(({ key }) => key)).toEqual([]);
  });
});
