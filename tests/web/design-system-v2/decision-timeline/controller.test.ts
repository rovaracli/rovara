// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { DecisionCardsViewReaderSchema } from "@agentx/contracts/web";
import { AppHostProvider } from "../../../../packages/ui/src/host.js";
import { readDecisions, type ReadDecision } from "../../../../packages/ui/src/api/decisions.js";
import { DecisionCard, type DecisionCardActions } from "../../../../packages/ui/src/design/DecisionCard.js";
import { renderUi } from "../../support/render.js";
import { fakeHost } from "../../support/fake-host.js";
import { h } from "../../support/h.js";
const fixture = JSON.parse(readFileSync("tests/fixtures/code-decision-cards.json", "utf8")) as { views: Record<string, unknown> };
const decision = (name = "approve_dependency") => readDecisions(DecisionCardsViewReaderSchema.parse(fixture.views[name]))[0]!;
const actions = () => ({ onOpenEvidence: vi.fn(async () => undefined), onApprove: vi.fn(async () => ({ kind: "decided" as const, outcome: "approved" as const })), onReject: vi.fn(async () => ({ kind: "decided" as const, outcome: "rejected" as const })), onStale: vi.fn() } satisfies DecisionCardActions);
function show(value: ReadDecision, handlers = actions(), pane = false) {
 const { host } = fakeHost();
 const tree = (d: ReadDecision) => h(MemoryRouter, null, h(AppHostProvider, { host, children: h(DecisionCard, { decision: d, actions: handlers, ...(pane ? { pane: {} } : {}) }) }));
 const rendered = renderUi(tree(value));
 return { ...rendered, handlers, update: (d: ReadDecision) => rendered.rerender(h("div", { "data-theme": "light" }, tree(d))) };
}

for (const pane of [false, true]) it(`${pane ? "pane" : "home"}: uses the shared decision frame without offering step-up or high-risk inline approval`, () => {
 const value = decision("approve_setting");
 const f = show(value, actions(), pane);
 expect(f.container.querySelector(".rv-decision-frame")).toBeTruthy();
 expect(f.container.textContent).not.toMatch(/sign in again|confirm it.s you/iu);
 expect(screen.queryByRole("button", { name: /^Approve/u })).toBeNull();
 expect(screen.getByText("Open to decide")).toBeTruthy();
});

it("opening evidence never approves and only unlocks the digest the server recorded", async () => {
 const value = decision();
 const f = show(value);
 const approve = screen.getByRole<HTMLButtonElement>("button", { name: "Approve" });
 expect(approve.disabled).toBe(true);
 const details = screen.getByText("Open the evidence to approve").closest("details")!;
 details.open = true;
 fireEvent(details, new Event("toggle"));
 await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Approve" }).disabled).toBe(false));
 expect(f.handlers.onApprove).not.toHaveBeenCalled();
 f.update({ ...value, digest: "b".repeat(64) });
 expect(screen.getByRole<HTMLButtonElement>("button", { name: "Approve" }).disabled).toBe(true);
});

it("keeps refused evidence locked and does not create an approval for an action the server omitted", async () => {
 const handlers = actions();
 handlers.onOpenEvidence = vi.fn(async () => { throw new Error("Evidence read refused"); });
 const value = decision();
 const f = show(value, handlers);
 const details = screen.getByText("Open the evidence to approve").closest("details")!;
 details.open = true;
 fireEvent(details, new Event("toggle"));
 await screen.findByRole("alert");
 expect(screen.getByRole<HTMLButtonElement>("button", { name: "Approve" }).disabled).toBe(true);
 f.update({ ...value, card: { ...value.card, actions: value.card.actions.filter(action => action.kind !== "approve") } });
 expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
 expect(handlers.onApprove).not.toHaveBeenCalled();
});

it("does not dispatch twice while approval is busy, or approve an adjacent card", async () => {
 let resolve!: () => void;
 const pending = new Promise<void>(done => { resolve = done; });
 const first = actions(), second = actions();
 first.onApprove = vi.fn(async () => { await pending; return { kind: "decided" as const, outcome: "approved" as const }; });
 const value = decision("approve_plan");
 const { host } = fakeHost();
 renderUi(h(MemoryRouter, null, h(AppHostProvider, { host, children: h("div", null,
  h(DecisionCard, { decision: value, actions: first }),
  h(DecisionCard, { decision: { ...value, card: { ...value.card, id: "approve_plan:other", title: "Other plan" } }, actions: second }),
 ) })));
 const card = screen.getByRole("article", { name: value.card.title });
 const button = within(card).getByRole<HTMLButtonElement>("button", { name: "Approve" });
 fireEvent.click(button);fireEvent.click(button);
 expect(button.disabled).toBe(true);
 expect(first.onApprove).toHaveBeenCalledTimes(1);
 expect(second.onApprove).not.toHaveBeenCalled();
 await act(async () => { resolve();await pending; });
});

it("explains an evidence lock beside the approval and links its visible reason", () => {
 show(decision());
 const approve = screen.getByRole<HTMLButtonElement>("button", { name: "Approve" });
 expect(approve.disabled).toBe(true);
 expect(approve.querySelector("svg[aria-hidden=true]")).toBeTruthy();
 const described = approve.getAttribute("aria-describedby")!.split(" ").map(id => document.getElementById(id)?.textContent).join(" ");
 expect(described).toContain("Open the evidence for this version before approving.");
 expect(screen.getByText("Locked: Open the evidence for this version before approving.")).toBeTruthy();
});
