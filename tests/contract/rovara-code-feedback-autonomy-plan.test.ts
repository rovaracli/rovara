// Rovara Code (Plan 6 Task 16): what Rovara reads before it decides a round on its own. The stored report and the comments are read as the owner's card reads them (every digest and key checked), and
// the round must be nothing but fixes to make: a finding that is a question, a skip or less than actionable, comments over the size an automatic round takes, ordered parts the owner approved, a
// change to the checks Rovara would not make, or a record that fails its integrity check all leave the round to the owner.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { planAutomaticFeedbackRound } from "../../packages/broker/src/aws/developer-tasks.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { plannedReview } from "../support/rovara-code-feedback.js";

describe("the round Rovara reads before it decides", () => {
  it("is every finding of a sound, actionable review, in the report's order, with the comments they answer", async () => {
    const { deps, stored } = await plannedReview();
    const plan = await planAutomaticFeedbackRound(deps, stored());
    expect(plan?.selected.map((finding) => finding.id)).toEqual(["finding-1"]);
    expect(plan?.selected[0]?.comments).toEqual([expect.objectContaining({ id: "review_comment:1", author: "maya", body: "Handle empty input" })]);
    expect(plan?.checkChanges.problems).toEqual([]);
  });

  it("a finding that is a question, a skip, not actionable, not recommended or without a fix is the owner's", async () => {
    for (const finding of [
      { proposedDisposition: "OWNER_DECISION", assessment: "NEEDS_OWNER_DECISION", recommended: false, confidence: { level: "LOW", reason: "Two readings." } },
      { proposedDisposition: "SKIP", assessment: "OUT_OF_SCOPE", recommended: false },
      { assessment: "TECHNICALLY_INCORRECT", recommended: false, proposedDisposition: "SKIP" },
      { fixProposal: undefined },
      // Actionable and recommended on the stored reference, but the report does not propose to implement it.
      { proposedDisposition: "SKIP" },
      { proposedDisposition: "OWNER_DECISION", confidence: { level: "LOW", reason: "Two readings." } },
    ]) {
      const { deps, stored } = await plannedReview({ finding, findingRef: { assessment: finding.assessment ?? "ACTIONABLE", recommended: finding.recommended ?? true } });
      expect(await planAutomaticFeedbackRound(deps, stored()), JSON.stringify(finding)).toBeUndefined();
    }
  });

  it("a finding the report does not recommend is the owner's, whatever its assessment", async () => {
    const { deps, stored } = await plannedReview({ finding: { recommended: false }, findingRef: { recommended: false } });
    expect(await planAutomaticFeedbackRound(deps, stored())).toBeUndefined();
  });

  it("a fix that changes the checks in a way Rovara would not make (a check outside the task's repositories, or dropping a project check) is the owner's; a sound change is Rovara's", async () => {
    const grep = (text: string) => ({ cwd: "repo/demo", executable: "grep", args: ["-q", text, "README.md"], timeoutSeconds: 30 });
    const unit = { id: "required-1", label: "Unit tests", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 600 } };
    const sentence = { id: "proposed-1", label: "Sentence present", command: grep("Old sentence.") };
    const policy = { required: [unit], optional: [], selectedOptionalIds: [], proposed: [sentence] };
    const proposal = (checks: Record<string, unknown>) => ({ fixProposal: { summary: "Shorten the sentence.", fileChanges: [{ repositoryId: "demo", path: "README.md", operation: "MODIFY", change: "Use the shorter one." }], tests: [], ...checks } });
    for (const checks of [
      { obsoleteChecks: ["proposed-1"], replacementChecks: [{ label: "Shorter", cwd: "other", executable: "grep", args: ["-q", "New.", "README.md"] }] },
      { obsoleteChecks: ["required-1"] },
    ]) {
      const { deps, stored } = await plannedReview({ finding: proposal(checks), extra: { checkPolicy: policy } });
      expect(await planAutomaticFeedbackRound(deps, stored()), JSON.stringify(checks)).toBeUndefined();
    }
    const sound = await plannedReview({ finding: proposal({ obsoleteChecks: ["proposed-1"], replacementChecks: [{ label: "Shorter", cwd: "repo/demo", executable: "grep", args: ["-q", "New.", "README.md"] }] }), extra: { checkPolicy: policy } });
    const plan = await planAutomaticFeedbackRound(sound.deps, sound.stored());
    expect(plan?.checkChanges.problems).toEqual([]);
    expect(plan?.checkChanges.added.map((check) => check.label)).toEqual(["Shorter"]);
  });

  it("comments over the size an automatic round takes are the owner's to read first", async () => {
    const { deps, stored } = await plannedReview({ body: "x".repeat(70_000) });
    expect(await planAutomaticFeedbackRound(deps, stored())).toBeUndefined();
    const small = await plannedReview({ body: "x".repeat(60_000) });
    expect(await planAutomaticFeedbackRound(small.deps, small.stored())).toBeDefined();
  });

  it("a review that is not complete, or is not waiting or approved, is not a round to decide", async () => {
    const { deps, stored } = await plannedReview();
    const record = stored();
    const failed = { ...record, workflow: { ...record.workflow!, feedbackReview: { ...record.workflow!.feedbackReview!, reviewRef: { ...record.workflow!.feedbackReview!.reviewRef!, status: "FAILED" as const, blockReason: "review timed out" } } } };
    expect(await planAutomaticFeedbackRound(deps, failed as DeveloperTaskRecord)).toBeUndefined();
    const dismissed = { ...record, workflow: { ...record.workflow!, feedbackReview: { ...record.workflow!.feedbackReview!, status: "DISMISSED" as const } } };
    expect(await planAutomaticFeedbackRound(deps, dismissed as DeveloperTaskRecord)).toBeUndefined();
  });

  it("a record that fails its integrity check throws, and Rovara leaves the round to the owner", async () => {
    for (const tamper of ["report", "bundle"] as const) {
      const { deps, stored } = await plannedReview({ tamper });
      await expect(planAutomaticFeedbackRound(deps, stored()), tamper).rejects.toThrow();
    }
  });

  it("a task with an approved work plan of ordered parts is the owner's", async () => {
    const { deps, stored } = await plannedReview();
    const record = stored();
    const withPlan = { ...record, workflow: { ...record.workflow!, workflowDependenciesApproval: { artifactDigest: "a".repeat(64), graphDigest: "b".repeat(64), workflowRevision: 5, actorId: "c".repeat(64), runId: randomUUID() } } };
    expect(await planAutomaticFeedbackRound(deps, withPlan as unknown as DeveloperTaskRecord)).toBeUndefined();
  });
});
