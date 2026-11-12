// Staging finding (decision 134): an auto-started clear small change ran Full. The task's path was Quick and pathFrom
// "request", but the design review stage, with the project's mode "always", switched the review on after Understand and
// forced the Full path (design-review/understand-mode.ts, mode.ts: `always` turns it on for every ready task, an explicit
// Quick included). Fix: only a change that will run Quick starts on its own; under "always" (or `design first:`) the card
// is posted and the person chooses. The run through Understand itself is tests/contract/quick-start-path-understand.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { WORKFLOW_PATH_QUICK_ACTION } from "@rovara-code/contracts";
import { createWorkflowE2E } from "../support/workflow-e2e.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";
import { seedDesignReviewCompany } from "../support/design-review-company.js";
import { TEST_ORG } from "../support/orgs.js";

const PLAN = planAnswer(planDocument({ title: "Fix the README typo", why: [{ text: "The README has a typo.", author: "Maya" }], claims: [{ id: "1", text: "Fix the typo in README.md." }], decisions: [] }));

describe("an auto-started clear small change runs Quick (staging finding, decision 134)", () => {
  let log: MockInstance<typeof console.log>;
  beforeEach(() => { log = vi.spyOn(console, "log").mockImplementation(() => undefined); vi.stubEnv("DESIGN_REVIEW_ENABLED", "1"); });
  afterEach(() => { log.mockRestore(); vi.unstubAllEnvs(); });

  const tasks = (e2e: Awaited<ReturnType<typeof createWorkflowE2E>>) => e2e.db.find((item) => String(item.pk).startsWith("DEVTASK#") && item.sk === "META");

  it("does not start on its own where the project reviews every design (mode always): the card is posted, nothing runs Full unasked", async () => {
    const e2e = await createWorkflowE2E({ route: () => ({ kind: "small_change", outcome: "ok" }), autoStartQuick: true, model: { plan: PLAN, edits: [] } });
    seedDesignReviewCompany(e2e.db, TEST_ORG, { project: { name: "payments", mode: "always" } });
    expect(await e2e.mention("fix the typo in README", { ts: "1698000000.000002", threadTs: "1698000000.000002" })).toBe(200);
    expect(tasks(e2e)).toEqual([]);
    expect(e2e.slack.lastPostWithAction(WORKFLOW_PATH_QUICK_ACTION).threadTs).toBe("1698000000.000002");
    expect(e2e.routeLogs.find((entry) => entry.event === "route.auto_start_skipped")?.fields).toMatchObject({ reason: "design_review" });
  }, 120_000);
});
