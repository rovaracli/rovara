// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { DecisionCardsViewReaderSchema } from "@agentx/contracts/web";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { DecisionCard } from "../../packages/ui/src/design/DecisionCard.js";
import { readDecisions } from "../../packages/ui/src/api/decisions.js";
import { TaskPageBoundary } from "../../packages/ui/src/screens/session/task-page-policy.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { renderUi } from "./support/render.js";
const views = (JSON.parse(readFileSync("tests/fixtures/code-decision-cards.json", "utf8")) as { views: Record<string, unknown> }).views;
function mount(kind: string, state: "ready" | "no-action" | "high" | "refused" | "pending" | "reasons" = "ready", page = true) {
 const decision = readDecisions(DecisionCardsViewReaderSchema.parse(views[kind]))[0]!;
 if (state === "no-action") decision.card.actions = decision.card.actions.filter(a => a.kind !== "reject");
 if (state === "high") decision.card.risk = "high";
 if (state === "reasons") decision.card.rejectReasons = ["not_now"];
 const reject = vi.fn(async () => ({ kind: "decided" as const, outcome: "rejected" as const }));
 const card = h(DecisionCard, { decision, actions: { onOpenEvidence: async () => undefined, onApprove: async () => ({ kind: "decided" as const, outcome: "approved" as const }), onReject: reject, onAuthorityRefused: () => state === "refused", onHasUnknownApproval: async () => state === "pending", onStale: () => undefined } });
 const router = createMemoryRouter([{ path: "/", element: page ? h(TaskPageBoundary, { children: card }) : card }]);
 const ui = renderUi(h(AppHostProvider, { host: fakeHost().host, children: h(RouterProvider, { router }) }));
 return { reject, close() { ui.unmount();router.dispose(); } };
}
for (const state of ["no-action", "high", "refused"] as const) it(`restored rejection respects ${state}`, async () => {
 const s = mount("fix_setup", state);try { await act(async () => undefined);expect(screen.queryByText("Not now", { selector: "summary" })).toBeNull();expect(s.reject).not.toHaveBeenCalled(); } finally { s.close(); }
});
it("unknown rejection disables every reason", async () => {
 const s = mount("fix_setup", "pending");try {
  await screen.findByRole("button", { name: "Check" });fireEvent.click(screen.getByText("Not now", { selector: "summary" }));
  for (const button of screen.getAllByRole<HTMLButtonElement>("button").filter(b => b.closest(".rv-decision-reject"))) { expect(button.disabled).toBe(true);fireEvent.click(button); }
  expect(s.reject).not.toHaveBeenCalled();
 } finally { s.close(); }
});
it("rejection offers only the server's allowed reasons", async () => {
 const s = mount("fix_setup", "reasons");try {
  fireEvent.click(screen.getByText("Not now", { selector: "summary" }));expect(screen.getByRole<HTMLButtonElement>("button", { name: "Not now" }).disabled).toBe(false);expect(screen.queryByRole("button", { name: "Wrong problem" })).toBeNull();
 } finally { s.close(); }
});
it("the task-page policy hides unsupported rejection while preserving legacy presentation", () => {
 let s = mount("approve_dependency");try { expect(screen.queryByText("Not now", { selector: "summary" })).toBeNull(); } finally { s.close(); }
 s = mount("approve_dependency", "ready", false);try { expect(screen.getByText("Not now", { selector: "summary" })).toBeTruthy(); } finally { s.close(); }
});
