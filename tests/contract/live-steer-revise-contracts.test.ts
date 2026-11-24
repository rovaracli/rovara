// Revise the plan with a live change: the pure workflow move. Coding stopped for the owner's live message (a change outside the approved plan); the owner (and only the owner) sends the work back to
// PLANNING with that change, which the existing plan approval then decides. Nothing here can approve anything, and no message text is in the workflow.
import { describe, expect, it } from "vitest";
import { WORKFLOW_BLOCK_REASONS } from "../../packages/contracts/src/task-workflow.js";
const REASON = WORKFLOW_BLOCK_REASONS.liveSteerReapprovalRevise;

describe("which block reason coding stops with", () => {

  it("each reason names only what its card offers", () => {
    expect(REASON).toMatch(/Revise the plan/u);
    expect(REASON).toMatch(/approve the revised plan/u);
    expect(REASON).toMatch(/Retry coding/u);
    expect(WORKFLOW_BLOCK_REASONS.liveSteerReapprovalCoding).not.toMatch(/Revise the plan/u);
  });
});
