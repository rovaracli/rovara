// @vitest-environment jsdom
// End to end for the 2 live contract breaks (design review round fields; verification madeByRovara).
import { expect, it } from "vitest";
import { render } from "@testing-library/react";
import { createElement as h } from "react";
import { DeveloperTaskViewSchema } from "../../packages/contracts/src/developer-tasks.js";
import { WorkflowSnapshotShapeSchema } from "../../packages/contracts/src/task-workflow.js";
import { DesignTabView } from "../../packages/ui/src/screens/session/DesignTab.js";
import { designTabModel, readDesignReview } from "../../packages/ui/src/screens/session/design-review-view.js";
import { designReviewFixture, designTaskSession } from "./support/design-review-fixture.js";

type Review = { rounds: Array<Record<string, unknown>> } & Record<string, unknown>;
const withRound = (extra: Record<string, unknown>): Review => { const r = JSON.parse(JSON.stringify(designReviewFixture())) as Review; r.rounds[0] = { ...r.rounds[0], ...extra }; return r; };

it("Code-shaped review (round estimateUsd + unreadableFindings) reads and renders", () => {
  const code = withRound({ estimateUsd: 1.1, unreadableFindings: 2 });
  const read = readDesignReview(code);
  expect(read).not.toBe("unreadable");
  const model = designTabModel(read as never);
  render(h(DesignTabView, { model } as never));
  expect(document.body.textContent).not.toContain("can't be shown");
  // estimate $0 round, and omitted (pre-field, 0.5.48-with-no-fields shape)
  expect(readDesignReview(withRound({ estimateUsd: 0 }))).not.toBe("unreadable");
  expect(readDesignReview(designReviewFixture())).not.toBe("unreadable");
  expect(readDesignReview(withRound({ unreadableFindings: 0 }))).toBe("unreadable");
  expect(readDesignReview(withRound({ nope: 1 }))).toBe("unreadable");
});
it("task view with workflow.designReview round fields + verification madeByRovara parses (MoneyBanners schema)", () => {
  const verification = { candidateDigest: "a".repeat(64), producer: "worker", environmentId: "env-1", recordedAt: "2026-11-23T12:00:00.000Z", results: [{ checkId: "unit", status: "PASS", madeByRovara: true }] };
  const build = (review: unknown, v: unknown) => { const s = designTaskSession(review as never, {}, { verification: v }); return (s.body as { task: unknown }).task; };
  const ok = DeveloperTaskViewSchema.safeParse(build(withRound({ estimateUsd: 1.1, unreadableFindings: 1 }), verification));
  expect(ok.success, JSON.stringify(ok.success ? "" : ok.error.issues.slice(0, 3))).toBe(true);
  const old = DeveloperTaskViewSchema.safeParse(build(designReviewFixture(), { ...verification, results: [{ checkId: "unit", status: "PASS" }] }));
  expect(old.success, JSON.stringify(old.success ? "" : old.error.issues.slice(0, 3))).toBe(true);
  expect(() => build(undefined, { ...verification, results: [{ checkId: "unit", status: "PASS", madeByRovara: false }] })).toThrow();
  void WorkflowSnapshotShapeSchema;
});
