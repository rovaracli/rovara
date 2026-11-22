// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DeveloperTaskViewReaderSchema } from "@agentx/contracts/web";
import { TaskRunningProgressView, type ProgressStage } from "../../packages/ui/src/screens/session/TaskRunningProgressView.js";

afterEach(cleanup);

const fixture = DeveloperTaskViewReaderSchema.parse({
 taskId: "77db9be0-4d20-4c54-a282-2baead1e3670",
 title: "Build task",
 project: "payments",
 status: "RUNNING",
 startingRevision: 1,
 client: "web",
 shared: false,
 createdAt: "2026-11-20T10:00:00.000Z",
 updatedAt: "2026-11-20T10:06:40.000Z",
 events: [],
 run: {
  state: "RUNNING",
  currentStep: { id: "build", name: "Build" },
  steps: [
   { id: "plan", name: "Plan", status: "done" },
   { id: "build", name: "Build", status: "running" },
   { id: "checks", name: "Checks", status: "pending" },
   { id: "review", name: "Review", status: "pending" },
   { id: "merge", name: "Merge", status: "pending" },
  ],
  pendingApprovals: [],
 },
});

const stages = (withTiming = true): ProgressStage[] => fixture.run!.steps.map((step, index) => ({
 id: step.id,
 label: step.name,
 state: index === 0 ? "done" : index === 1 ? "current" : "upcoming",
 ...(withTiming && index < 2 ? { durationMs: index === 0 ? 261_000 : 400_000 } : {}),
}));

describe("task running progress rail", () => {
 it("shows ordered observed progress and leaves future results unstated", () => {
  render(createElement(TaskRunningProgressView, { stages: stages(), currentStepId: fixture.run?.currentStep?.id, activity: "observed", pageProjection: "current" }));

  const rail = screen.getByRole("complementary", { name: "Where this task is" });
  expect(rail.textContent?.indexOf("Plan")).toBeLessThan(rail.textContent?.indexOf("Build") ?? Infinity);
  expect(rail.textContent).toContain("4m 21s");
  expect(rail.textContent).toContain("6m 40s");
  expect(screen.getByText("Build").closest("li")?.getAttribute("aria-current")).toBe("step");
  expect(screen.getByText("Checks").textContent).toBe("Checks");
  expect(screen.getByText("Review").textContent).toBe("Review");
 });

 it("keeps unknown heartbeat distinct from a stale page projection", () => {
  const { rerender } = render(createElement(TaskRunningProgressView, { stages: stages(), lastKnownStepId: "build", activity: "unknown", pageProjection: "current" }));
  expect(screen.getByText("Rovara hasn't confirmed the build's latest activity.")).toBeTruthy();
  expect(screen.queryByText(/silent|checking it/u)).toBeNull();
  expect(screen.getByText("Last known step")).toBeTruthy();
  expect(screen.queryByText("Failed")).toBeNull();

  rerender(createElement(TaskRunningProgressView, { stages: stages(), currentStepId: "build", activity: "observed", pageProjection: "stale" }));
  expect(screen.getByText("This page is old; the build may be fine.")).toBeTruthy();
  expect(screen.queryByText(/silent|checking it/u)).toBeNull();
 });

 it("omits timing facts the parent did not receive", () => {
  render(createElement(TaskRunningProgressView, { stages: stages(false), currentStepId: "build", activity: "observed", pageProjection: "current" }));
  expect(screen.queryByText(/\d+m \d+s/u)).toBeNull();
  expect(screen.getByText("Build")).toBeTruthy();
 });
});
