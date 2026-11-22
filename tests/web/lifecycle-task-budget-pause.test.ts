// @vitest-environment jsdom
import { expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { TaskBudgetPauseView } from "../../packages/ui/src/screens/session/TaskBudgetPauseView.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

it("explains an explicitly observed monthly-limit refusal with only its supplied facts", () => {
 const view = renderUi(h(TaskBudgetPauseView, { read: "current", evidence: {
  kind: "monthly_limit_refusal", scope: "Acme", step: "Build", stepDetail: "plan item 3", observedAt: "15:58",
  cost: "$159.40 spent this month", allowance: "$160 monthly limit", reset: "1 Dec", persistedWork: "Items 1 and 2 are done and pushed; item 3 is saved with the task, not pushed.",
 }, moneyHref: "/app/admin/money/limits" }));

 expect(screen.getByRole("heading", { name: "Paused in the middle of Build: Acme's monthly limit was reached" })).toBeTruthy();
 expect(screen.getByText("At 15:58 the next AI call for plan item 3 was refused because Acme's monthly limit was reached.")).toBeTruthy();
 expect(screen.getByText("$159.40 spent this month")).toBeTruthy();
 expect(screen.getByText("$160 monthly limit")).toBeTruthy();
 expect(screen.getByText("1 Dec")).toBeTruthy();
 expect(screen.getByText("Items 1 and 2 are done and pushed; item 3 is saved with the task, not pushed.")).toBeTruthy();
 expect(screen.getByRole("link", { name: "Raise the limit in Money" }).getAttribute("href")).toBe("/app/admin/money/limits");
 view.unmount();
});

it("keeps missing facts and an unavailable latest read out of the explanation", () => {
 const partial = renderUi(h(TaskBudgetPauseView, { read: "current", evidence: { kind: "monthly_limit_refusal", scope: "Acme", step: "Build", stepDetail: "plan item 3" } }));
 expect(screen.getByText((_, element) => element?.tagName === "DD" && element.textContent === "the next AI call for plan item 3 was refused because Acme's monthly limit was reached.")).toBeTruthy();
 expect(screen.queryByText(/spent this month|monthly limit is \$|reset/i)).toBeNull();
 expect(screen.queryByRole("link", { name: "Raise the limit in Money" })).toBeNull();
 expect(screen.queryByText("Raise the limit in Money")).toBeNull();
 partial.unmount();

 const stale = renderUi(h(TaskBudgetPauseView, { read: "unavailable", evidence: {
  kind: "monthly_limit_refusal", scope: "Acme", step: "Build · plan item 3", cost: "$159.40 spent this month", allowance: "$160 monthly limit", reset: "1 Dec", persistedWork: "Saved work",
 } }));
 expect(screen.getByRole("heading", { name: "Task budget details are unavailable" })).toBeTruthy();
 expect(screen.getByText("Rovara couldn't confirm the task's budget details on its latest read. Older details are hidden.")).toBeTruthy();
 expect(screen.queryByText("$159.40 spent this month")).toBeNull();
 expect(screen.queryByText("Saved work")).toBeNull();
 stale.unmount();
});

it("does not relabel a generic pause, task test cap, or unavailable budget as a monthly refusal", () => {
 const cases = [
  { kind: "generic_pause", heading: "Task paused", message: "The task is paused. Its reason is not available." },
  { kind: "test_cap", heading: "This test run reached its own limit", message: "This task's test limit is separate from the company's monthly limit." },
  { kind: "budget_unavailable", heading: "Task budget details are unavailable", message: "Rovara couldn't read the budget details. This does not show whether a limit was reached." },
 ] as const;
 for (const evidence of cases) {
  const view = renderUi(h(TaskBudgetPauseView, { read: "current", evidence }));
  expect(screen.getByRole("heading", { name: evidence.heading })).toBeTruthy();
  expect(screen.getByText(evidence.message)).toBeTruthy();
  expect(screen.queryByText(/monthly limit was reached|monthly limit is \$/i)).toBeNull();
  view.unmount();
 }
});
