// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { readPlan } from "../../packages/ui/src/api/work.js";
import { PlanDecisionView } from "../../packages/ui/src/screens/session/PlanDecisionView.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";

const plan = (version: number) => readPlan({ version, approved: false, summary: { headline: "Add a retry-safe refunds endpoint", checks: ["Refund retries return the first result"] }, requirements: [] });

function renderView(state: "read-required" | "ready" | "outdated" | "failed" | "submitting", version = 3, returnToSlack?: string) {
 return renderUi(h(PlanDecisionView, {
  taskTitle: "Add refunds endpoint",
  plan: plan(version),
  state,
  slackReturnTo: returnToSlack,
  decisionSlot: h("button", { type: "button" }, "Read required evidence"),
 }), { theme: "light" });
}

it("drops cached plan facts and decision controls when the latest plan read fails", () => {
 const onRetry = vi.fn();
 const ui = renderUi(h(PlanDecisionView, { taskTitle: "Add refunds endpoint", plan: plan(3), state: "failed", onRetry, decisionSlot: h("button", { type: "button" }, "Read required evidence") }));
 expect(screen.getByRole("alert").textContent).toContain("couldn't be read");
 expect(screen.queryByText("Add a retry-safe refunds endpoint")).toBeNull();
 expect(screen.queryByRole("heading", { name: "Plan v3" })).toBeNull();
 expect(screen.queryByRole("button", { name: "Read required evidence" })).toBeNull();
 screen.getByRole("button", { name: "Read the plan again" }).click();
 expect(onRetry).toHaveBeenCalledOnce();
 ui.unmount();
});

it("shows the latest plan revision while required evidence remains unread", () => {
 const ui = renderView("read-required");
 expect(screen.getByRole("heading", { name: "Plan v3" })).toBeTruthy();
 expect(screen.getByText("Add a retry-safe refunds endpoint")).toBeTruthy();
 expect(screen.getByRole("button", { name: "Read required evidence" })).toBeTruthy();
 expect(screen.queryByText(/unlocked|approved/i)).toBeNull();
 ui.unmount();
});

it("shows the ready current revision and its existing decision action slot", () => {
 const ui = renderView("ready");
 expect(screen.getByRole("heading", { name: "Plan v3" })).toBeTruthy();
 expect(screen.getByRole("button", { name: "Read required evidence" })).toBeTruthy();
 ui.unmount();
});

it("shows a replaced revision without retaining actions for the older decision", () => {
 const ui = renderView("outdated", 4);
 expect(screen.getByRole("heading", { name: "Plan v4" })).toBeTruthy();
 expect(screen.getByRole("status").textContent).toMatch(/replaced|newer plan/i);
 expect(screen.queryByRole("button", { name: "Read required evidence" })).toBeNull();
 ui.unmount();
});

it("does not offer a second action while the decision is submitting", () => {
 const ui = renderView("submitting");
 expect(screen.getByRole("status").textContent).toMatch(/submitting/i);
 expect(screen.queryByRole("button", { name: "Read required evidence" })).toBeNull();
 ui.unmount();
});

it("preserves the Slack return destination exactly and places it before the decision controls", () => {
 const destination = "https://slack.com/client/T123/C456/thread?team=T123&message=789#reply";
 const ui = renderView("ready", 3, destination);
 const back = screen.getByRole("link", { name: "Back to Slack" });
 const action = screen.getByRole("button", { name: "Read required evidence" });
 expect(back.getAttribute("href")).toBe(destination);
 expect(back.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 ui.unmount();
});

for (const theme of ["light", "dark"] as const) it(`keeps the ready decision view accessible in ${theme} theme`, async () => {
 const ui = renderUi(h(PlanDecisionView, { taskTitle: "Add refunds endpoint", plan: plan(3), state: "ready", decisionSlot: h("button", { type: "button" }, "Approve plan v3") }), { theme });
 await expectNoAxeViolations(ui.container);
 expect(document.documentElement.getAttribute("data-theme")).toBe(theme);
 ui.unmount();
});
