// Work events (U3): a block's text becomes a closed cause code, so a failure rate counts failures and not owner stops, cancels and budget pauses.
import { describe, expect, it } from "vitest";
import { WORKFLOW_BLOCK_REASONS, WORK_EVENT_BLOCK_CAUSES, workEventCauseIsFailure } from "@agentx/cloud-contracts";
import { BUDGET_EXHAUSTED_FAILURE_MESSAGE, RUN_LIMIT_BLOCK_PREFIX, WORKFLOW_NOT_RUN_PREFIX, WORKFLOW_APPLICATION_RUNTIME_RENEWED_PREFIX, ciFixUnrelatedMessage, BRANCH_WORKFLOW_FILES_MESSAGE } from "@rovara-code/contracts";
import { BLOCK_CAUSE_BY_KEY, blockCauseOf } from "../../packages/broker/src/work-events/block-cause.js";
import { stoppedStepReason } from "../../packages/broker/src/aws/workflow-cancel-reconcile.js";
import { workflowRunEndedReason } from "../../packages/broker/src/aws/outbox-failure.js";

describe("blockCauseOf", () => {
  it("knows every fixed block reason the broker writes: none falls to `other`", () => {
    const other = Object.entries(WORKFLOW_BLOCK_REASONS).filter(([, text]) => typeof text === "string" && blockCauseOf(text) === "other").map(([key]) => key);
    expect(other).toEqual([]);
  });

  it("maps the stops on purpose to stop causes", () => {
    expect(blockCauseOf(stoppedStepReason("IMPLEMENT", "CANCELLED"))).toBe("cancelled");
    expect(blockCauseOf(workflowRunEndedReason("PLAN", "CANCELLED"))).toBe("cancelled");
    expect(blockCauseOf(BUDGET_EXHAUSTED_FAILURE_MESSAGE)).toBe("budget_exhausted");
    expect(blockCauseOf(WORKFLOW_BLOCK_REASONS.budgetPaused)).toBe("budget_paused");
    expect(blockCauseOf(`${RUN_LIMIT_BLOCK_PREFIX}12.00 and needs your approval.`)).toBe("budget_paused");
    expect(blockCauseOf(`${WORKFLOW_NOT_RUN_PREFIX} this step: its owner may no longer start work.`)).toBe("not_started");
    expect(blockCauseOf(`${WORKFLOW_APPLICATION_RUNTIME_RENEWED_PREFIX}Retry the checks.`)).toBe("waiting_setup");
    expect(blockCauseOf(WORKFLOW_BLOCK_REASONS.pullRequestClosed)).toBe("pr_closed");
    expect(blockCauseOf(WORKFLOW_BLOCK_REASONS.liveSteerReapproval)).toBe("needs_owner");
    for (const cause of ["cancelled", "budget_exhausted", "budget_paused", "not_started", "waiting_setup", "pr_closed", "needs_owner"] as const) expect(workEventCauseIsFailure(cause), cause).toBe(false);
  });

  it("treats an interrupted run, a stop that never confirmed, as a stop: the stuck-cancel release and Close of a held workspace write it", () => {
    for (const mode of ["UNDERSTAND", "PLAN", "PLAN_CRITIQUE", "IMPLEMENT", "CHECKS", "REVIEW"] as const) {
      expect(blockCauseOf(workflowRunEndedReason(mode, "INTERRUPTED")), mode).toBe("cancelled");
      expect(blockCauseOf(stoppedStepReason(mode, "INTERRUPTED")), mode).toBe("cancelled");
      expect(blockCauseOf(stoppedStepReason(mode, "CANCELLED")), mode).toBe("cancelled");
      expect(blockCauseOf(stoppedStepReason(mode, "FAILED")), mode).toBe("run_failed");
    }
  });

  it("tells a stopped feedback review from a failed one", () => {
    expect(blockCauseOf(stoppedStepReason("FEEDBACK_REVIEW", "CANCELLED"))).toBe("cancelled");
    expect(blockCauseOf(stoppedStepReason("FEEDBACK_REVIEW", "INTERRUPTED"))).toBe("cancelled");
    expect(blockCauseOf(stoppedStepReason("FEEDBACK_REVIEW", "FAILED"))).toBe("review_failed");
    // The reason a failed review records everywhere else is unchanged.
    expect(stoppedStepReason("FEEDBACK_REVIEW", "FAILED")).toBe(WORKFLOW_BLOCK_REASONS.feedbackReviewFailed);
    expect(blockCauseOf(WORKFLOW_BLOCK_REASONS.feedbackReviewFailed)).toBe("review_failed");
  });

  it("places every block reason key: a new reason constant cannot silently become `other` (review L1)", () => {
    expect(Object.keys(BLOCK_CAUSE_BY_KEY).sort()).toEqual(Object.keys(WORKFLOW_BLOCK_REASONS).sort());
    for (const key of Object.keys(WORKFLOW_BLOCK_REASONS) as Array<keyof typeof WORKFLOW_BLOCK_REASONS>) {
      expect(blockCauseOf(WORKFLOW_BLOCK_REASONS[key]), key).toBe(BLOCK_CAUSE_BY_KEY[key]);
    }
  });

  it("maps failures to failure causes", () => {
    expect(blockCauseOf(WORKFLOW_BLOCK_REASONS.regressionFound)).toBe("checks_failed");
    expect(blockCauseOf(workflowRunEndedReason("IMPLEMENT", "FAILED"))).toBe("run_failed");
    expect(blockCauseOf(stoppedStepReason("FEEDBACK_REVIEW", "FAILED"))).toBe("review_failed");
    expect(blockCauseOf(workflowRunEndedReason("CHECKS", "FAILED"))).toBe("run_failed");
    expect(blockCauseOf(WORKFLOW_BLOCK_REASONS.noCodeChanged)).toBe("no_code_change");
    expect(blockCauseOf(WORKFLOW_BLOCK_REASONS.planUnreadable)).toBe("plan_failed");
    expect(blockCauseOf(WORKFLOW_BLOCK_REASONS.pullRequestUpdateFailed)).toBe("pr_update_failed");
    expect(blockCauseOf(ciFixUnrelatedMessage("unit tests"))).toBe("ci_fix_gave_up");
    expect(blockCauseOf(BRANCH_WORKFLOW_FILES_MESSAGE)).toBe("branch_sync_failed");
    for (const cause of ["checks_failed", "run_failed", "no_code_change", "plan_failed", "review_failed", "pr_update_failed", "ci_fix_gave_up", "branch_sync_failed", "other"] as const) expect(workEventCauseIsFailure(cause), cause).toBe(true);
  });

  it("gives `other` for text it does not know and for no text, and only ever a cause of the closed list", () => {
    for (const reason of [undefined, "", "Rovara said something new", "operation ended exploded"]) {
      const cause = blockCauseOf(reason);
      expect(cause, String(reason)).toBe("other");
      expect(WORK_EVENT_BLOCK_CAUSES).toContain(cause);
    }
  });
});
