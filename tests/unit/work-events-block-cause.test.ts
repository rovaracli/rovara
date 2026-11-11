// Work events (U3): a block's text becomes a closed cause code, so a failure rate counts failures and not owner stops, cancels and budget pauses.
import { describe, expect, it } from "vitest";
import {
  BUDGET_EXHAUSTED_FAILURE_MESSAGE, RUN_LIMIT_BLOCK_PREFIX, WORKFLOW_BLOCK_REASONS, WORKFLOW_NOT_RUN_PREFIX, WORK_EVENT_BLOCK_CAUSES, WORKFLOW_APPLICATION_RUNTIME_RENEWED_PREFIX,
  ciFixUnrelatedMessage, workEventCauseIsFailure, BRANCH_WORKFLOW_FILES_MESSAGE,
} from "@agentx/contracts";
import { blockCauseOf } from "../../packages/broker/src/work-events/block-cause.js";
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

  it("maps failures to failure causes", () => {
    expect(blockCauseOf(WORKFLOW_BLOCK_REASONS.regressionFound)).toBe("checks_failed");
    expect(blockCauseOf(workflowRunEndedReason("IMPLEMENT", "FAILED"))).toBe("run_failed");
    expect(blockCauseOf(workflowRunEndedReason("CHECKS", "INTERRUPTED"))).toBe("run_failed");
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
