// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import * as design from "../../../packages/ui/src/design/index.js";
import { DesignSystemGallery } from "../../../packages/ui/src/design/DesignSystemGallery.js";
import { HeldState } from "../../../packages/ui/src/design/HeldState.js";
import { PageHeader } from "../../../packages/ui/src/design/PageHeader.js";
import { h } from "../support/h.js";
import { renderUi } from "../support/render.js";
afterEach(cleanup);

it("exposes the integrated parts through the shared design entry point", () => {
 for (const name of ["StatusChip", "DecisionFrame", "TaskTimeline", "ConfirmationDialog", "OutcomeNotConfirmed", "MessageDelivery", "HeldState"]) {
  expect(design).toHaveProperty(name, expect.any(Function));
 }
});
it("uses the canonical accessible Unknown chip for held observations", () => {
 renderUi(h(HeldState));
 expect(screen.getByRole("img", { name: "Unknown" }).getAttribute("data-state")).toBe("unknown");
});
it("uses canonical named-waiting chips in the header without losing visible escaping", () => {
 renderUi(h(PageHeader, { title: "Task", status: { state: "waiting_for", waitingFor: "Sam\u202e" } }));
 expect(screen.getByRole("img", { name: "Waiting for Sam[U+202E]" }).getAttribute("data-state")).toBe("waiting_for");
});
const ids = ["colours", "type", "space", "statuses", "buttons", "decisions", "timeline", "table", "toast", "confirmation", "outcome", "focus", "shell-running", "shell-plan", "shell-gaps", "delivery", "held", "states-loading", "states-empty", "states-slow", "states-error", "states-stale", "states-phone", "states-first-load-failed", "states-stale-or-heartbeat", "states-write-unconfirmed"];
it.each(ids)("mounts the actual %s scene without placeholders", id => {
  const ui = renderUi(h(MemoryRouter, { initialEntries: [`/app/design-system?scene=${id}`], children: h(DesignSystemGallery) }));
  expect(ui.container.querySelectorAll("[data-gallery-scene]")).toHaveLength(1);
  expect(ui.container.querySelector("[data-gallery-placeholder]")).toBeNull();
  if (id === "table") expect(screen.getByRole("img", { name: "Could not run" }).getAttribute("data-state")).toBe("could_not_run");
  if (id === "shell-running" || id === "shell-plan") expect(within(screen.getByRole("complementary", { name: "Task context" })).getByRole("list", { name: "Where this task is" })).toBeTruthy();
  if (id === "shell-plan" || id === "shell-gaps") expect(ui.container.querySelector(".rv-decision-frame")).toBeTruthy();
  if (id === "shell-gaps") {
   expect(screen.getByRole("img", { name: "Could not run" })).toBeTruthy();
   expect(screen.getByRole("img", { name: "Not run" })).toBeTruthy();
  }
  if (id === "states-phone") expect(screen.getByRole("img", { name: "Waiting for Sam" })).toBeTruthy();
  if (id === "states-write-unconfirmed") expect(screen.getByRole("heading", { name: "What is safe" })).toBeTruthy();
  ui.unmount();
});
