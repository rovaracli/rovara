// @vitest-environment jsdom
import { expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { TaskEvidenceRequirementGapsView } from "../../packages/ui/src/screens/session/TaskEvidenceRequirementGapsView.js";

const evidenceHead = "1".repeat(64);
const returnedGaps = [
  { kind: "claim" as const, id: "R-1", text: "Payments that time out are retried.", reason: "no check or scenario names it" },
  { kind: "claim" as const, id: "R-2", text: "A payment is never charged twice.", reason: "no check or scenario names it" },
  { kind: "check" as const, id: "unit", text: "Unit tests", reason: "the check could not run" },
];

it("renders only the returned uncovered requirements and does not turn other evidence into titles", () => {
  const f = renderUi(h(TaskEvidenceRequirementGapsView, { taskId: "task-123", evidenceHead, uncoveredRequirements: returnedGaps }));
  const region = screen.getByRole("region", { name: "What wasn't tested" });
  expect(region.textContent).toContain("2 requirements were not tested: R-1: Payments that time out are retried.; R-2: A payment is never charged twice.");
  expect(region.textContent).toContain("No passing result is claimed for them. Review the missing evidence.");
  expect(region.textContent).not.toContain("Unit tests");
  expect(region.textContent).not.toContain("passed");
  expect(region.getAttribute("data-task-id")).toBe("task-123");
  expect(region.getAttribute("data-evidence-head")).toBe(evidenceHead);
  f.unmount();
});

it("keeps an explicitly empty list uncertain and supplies no requirement title", () => {
  const f = renderUi(h(TaskEvidenceRequirementGapsView, { taskId: "task-123", evidenceHead, uncoveredRequirements: [] }));
  const region = screen.getByRole("region", { name: "What wasn't tested" });
  expect(region.textContent).toContain("No uncovered requirements were returned for this evidence.");
  expect(region.textContent).not.toContain("No requirements were missed");
  expect(region.textContent).not.toContain("passed");
  expect(region.querySelector("li")).toBeNull();
  f.unmount();
});

it("does not use requirement titles when the list or its evidence head is unavailable", () => {
  for (const props of [
    { taskId: "task-123", evidenceHead, uncoveredRequirements: undefined },
    { taskId: "task-123", evidenceHead: undefined, uncoveredRequirements: returnedGaps },
  ]) {
    const f = renderUi(h(TaskEvidenceRequirementGapsView, props));
    const region = screen.getByRole("region", { name: "What wasn't tested" });
    expect(region.textContent).toContain("Uncovered requirements are unavailable for this evidence.");
    expect(region.textContent).not.toContain("Payments that time out");
    expect(region.querySelector("li")).toBeNull();
    f.unmount();
  }
});

it("wraps long requirement text without introducing horizontal content", () => {
  const longRequirement = "Requirement " + "x".repeat(300);
  const f = renderUi(h(TaskEvidenceRequirementGapsView, { taskId: "task-123", evidenceHead, uncoveredRequirements: [{ kind: "claim", id: "R-long", text: longRequirement, reason: "not tested" }] }));
  expect(screen.getByText(new RegExp(longRequirement))).toBeTruthy();
  expect(f.container.querySelector(".rv-task-evidence-requirement-gap")).toBeTruthy();
  f.unmount();
});
