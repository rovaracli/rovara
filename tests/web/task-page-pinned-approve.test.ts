// @vitest-environment jsdom
// Round F (owner DEC 254zzz353): on the task page the choices come BEFORE the Approve row, and a bar pinned to the bottom of the page carries the same Approve.
// The pinned Approve and the in-flow Approve are drawn from one guard and one handler: they say the same words, are locked together and send the same single approval.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within, act } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { DecisionCardsViewReaderSchema } from "@agentx/contracts/web";
import { ApiError } from "../../packages/ui/src/api/errors.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { readDecisions, type ReadDecision } from "../../packages/ui/src/api/decisions.js";
import { DecisionCard, type DecisionCardActions } from "../../packages/ui/src/design/DecisionCard.js";
import { TaskPageBoundary } from "../../packages/ui/src/screens/session/task-page-policy.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { fakeHost } from "./support/fake-host.js";

const FIXTURE = JSON.parse(readFileSync("tests/fixtures/code-decision-cards.json", "utf8")) as { views: Record<string, Record<string, unknown> & { cards: Array<Record<string, unknown>> }> };
const decision = (name = "approve_plan_with_choices"): ReadDecision => readDecisions(DecisionCardsViewReaderSchema.parse(structuredClone(FIXTURE.views[name]!)))[0]!;

type Observed = { callback: IntersectionObserverCallback; target: Element | undefined };
const observers: Observed[] = [];
/** The browser tells the page whether the Approve row is on screen; jsdom has no layout, so the test says it. */
function reportRow(on: "below" | "visible" | "above") {
 act(() => {
  for (const observer of observers) {
   const rect = { top: on === "below" ? 2000 : on === "above" ? -300 : 400, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) };
   observer.callback([{ intersectionRatio: on === "visible" ? 1 : 0, isIntersecting: on === "visible", boundingClientRect: rect, target: observer.target, time: 0, rootBounds: null, intersectionRect: rect } as IntersectionObserverEntry], {} as IntersectionObserver);
  }
 });
}
beforeEach(() => {
 observers.length = 0;
 class FakeObserver { constructor(private callback: IntersectionObserverCallback) {} observe(target: Element) { observers.push({ callback: this.callback, target }); } disconnect() { /* nothing to release */ } unobserve() { /* none */ } takeRecords() { return []; } }
 vi.stubGlobal("IntersectionObserver", FakeObserver);
 vi.stubGlobal("matchMedia", (query: string) => ({ matches: true, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
});
afterEach(() => { cleanup();vi.unstubAllGlobals(); });

function mount(onApprove = vi.fn<DecisionCardActions["onApprove"]>(async () => ({ kind: "decided", outcome: "approved" })), extra: Partial<DecisionCardActions> = {}, change?: (item: ReadDecision) => ReadDecision) {
 const item = change === undefined ? decision() : change(decision());
 const f = fakeHost(async () => ({ status: 200, body: {} }));
 const actions: DecisionCardActions = { onOpenEvidence: async () => undefined, onApprove, onReject: async () => ({ outcome: "rejected", remainingTabs: [] }) as never, onStale: () => undefined, ...extra };
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: createQueryClient(), children: h(MemoryRouter, { children: h(TaskPageBoundary, { children: h(DecisionCard, { decision: item, actions, pane: { outcome: "Retry failed payments safely" } }) }) }) }) }));
 return { ...ui, onApprove };
}
const inFlow = (name = "Approve") => within(document.querySelector<HTMLElement>(".rv-decision-actions-above")!).getByRole<HTMLButtonElement>("button", { name });
const pinned = (name = "Approve") => within(screen.getByTestId("approve-pinned")).getByRole<HTMLButtonElement>("button", { name });

describe("the pinned Approve bar on the task page", () => {
 it("puts the choices before the Approve row", () => {
  mount();
  const choices = document.querySelector(".rv-decision-plan")!;
  const row = document.querySelector(".rv-decision-actions-above")!;
  expect(choices.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 });
 it("draws nothing extra while the Approve row is on screen, and no pinned bar where the browser cannot observe", () => {
  mount();
  expect(screen.queryByTestId("approve-pinned")).toBeNull();
  reportRow("visible");
  expect(screen.queryByTestId("approve-pinned")).toBeNull();
  reportRow("above");
  expect(screen.queryByTestId("approve-pinned")).toBeNull();
 });
 it("shows the pinned Approve while the row is below the screen: the same words, locked the same way, with the same reason", () => {
  mount();
  reportRow("below");
  const bar = screen.getByTestId("approve-pinned");
  expect(pinned().disabled).toBe(true);
  expect(inFlow().disabled).toBe(true);
  expect(pinned().textContent).toBe(inFlow().textContent);
  expect(bar.textContent).toContain("Agree to the shown run limit before approving.");
  expect(within(document.querySelector<HTMLElement>(".rv-decision-actions-above")!).getByText(/Agree to the shown run limit before approving\./u)).toBeTruthy();
 });
 it("unlocks both together when the required choice is made, and a click on either sends ONE approval with the same content", async () => {
  const first = mount();
  reportRow("below");
  fireEvent.click(screen.getByRole("checkbox", { name: /I agree Rovara may spend up to \$5.00/u }));
  expect(pinned().disabled).toBe(false);expect(inFlow().disabled).toBe(false);
  expect(pinned().getAttribute("aria-describedby")).toBe(inFlow().getAttribute("aria-describedby"));
  fireEvent.click(pinned());
  await waitFor(() => expect(first.onApprove).toHaveBeenCalledTimes(1));
  const viaBar = first.onApprove.mock.calls[0] as unknown as unknown[];
  first.unmount();
  const second = mount();
  reportRow("below");
  fireEvent.click(screen.getByRole("checkbox", { name: /I agree Rovara may spend up to \$5.00/u }));
  fireEvent.click(inFlow());
  await waitFor(() => expect(second.onApprove).toHaveBeenCalledTimes(1));
  expect(second.onApprove.mock.calls[0]).toEqual(viaBar);
 });
 it("does not send anything from a locked pinned Approve", () => {
  const view = mount();
  reportRow("below");
  fireEvent.click(pinned());
  expect(view.onApprove).not.toHaveBeenCalled();
 });
 it("locks both again when the choice is taken back", () => {
  mount();
  reportRow("below");
  const box = screen.getByRole("checkbox", { name: /I agree Rovara may spend up to \$5.00/u });
  fireEvent.click(box);fireEvent.click(box);
  expect(pinned().disabled).toBe(true);expect(inFlow().disabled).toBe(true);
 });
 it("is not drawn on a phone, where the Approve row itself is the pinned bar", () => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
  mount();
  reportRow("below");
  expect(screen.queryByTestId("approve-pinned")).toBeNull();
 });
 it("is not drawn where this person may not approve: authority refused, a pending unknown approval, or a card that offers no Approve", async () => {
  const refused = mount(undefined, { onAuthorityRefused: () => true });
  reportRow("below");
  expect(screen.queryByTestId("approve-pinned")).toBeNull();expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  refused.unmount();
  const unknown = mount(undefined, { onHasUnknownApproval: async () => true });
  await waitFor(() => expect(screen.queryByRole("button", { name: "Approve" })).toBeNull());
  reportRow("below");
  expect(screen.queryByTestId("approve-pinned")).toBeNull();
  unknown.unmount();
  mount(undefined, {}, item => ({ ...item, card: { ...item.card, actions: item.card.actions.filter(action => action.kind !== "approve") } }));
  reportRow("below");
  expect(screen.queryByTestId("approve-pinned")).toBeNull();expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
 });
 it("keeps the pinned Approve away while an unconfirmed approval is being checked, even on a card with tabs (where the receipt frame is not drawn)", async () => {
  mount(undefined, { onHasUnknownApproval: async () => true }, item => ({ ...item, tabs: [{ id: "requirements", title: "Requirements", summary: "What it must do", approved: false, evidence: [] }, { id: "design", title: "Design", summary: "How it looks", approved: false, evidence: [] }] }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Check" })).toBeTruthy());
  reportRow("below");
  expect(screen.queryByTestId("approve-pinned")).toBeNull();
 });
});

// Opus P2-1: each non-limit lock must also bind the pinned control, independently of the run-limit lock.
function expectSameLock(name: string, reason?: string) {
 const flow = inFlow(name), bar = pinned(name);
 expect(bar.textContent).toBe(flow.textContent);
 for (const button of [flow, bar]) {
  expect(button.disabled).toBe(reason !== undefined);
  expect(button.getAttribute("data-locked")).toBe(reason === undefined ? null : "true");
  expect(button.closest(".rv-button-with-reason")?.querySelector(".rv-button-locked-reason")?.textContent).toBe(reason === undefined ? undefined : "Locked: " + reason);
 }
}
function tabbed(requirementsApproved = false, blocker = false): ReadDecision {
 return { ...decision("approve_plan"), tabs: [
  { id: "requirements", title: "Requirements", summary: "What it must do", approved: requirementsApproved, evidence: [] },
  { id: "design", title: "Design", summary: "How it looks", approved: false, evidence: blocker ? [{ kind: "other", label: "Open blockers", value: "1", state: "bad" }] : [] },
 ] };
}
it("pinned evidence-opened lock matches in-flow before and after opening this digest's evidence", async () => {
 const onOpenEvidence = vi.fn(async () => undefined);
 const view = mount(undefined, { onOpenEvidence }, () => { const item = decision("approve_plan");return { ...item, card: { ...item.card, risk: "medium", friction: { ...item.card.friction, expandEvidenceFirst: true } } }; });
 reportRow("below");
 expectSameLock("Approve", "Open the evidence for this version before approving.");
 fireEvent.click(pinned());expect(view.onApprove).not.toHaveBeenCalled();
 const panel = screen.getByText("Open the evidence to approve", { selector: "summary" }).closest("details")!;
 panel.open = true;fireEvent(panel, new Event("toggle"));
 await waitFor(() => expectSameLock("Approve"));
 expect(onOpenEvidence).toHaveBeenCalledWith(undefined);
 fireEvent.click(pinned());await waitFor(() => expect(view.onApprove).toHaveBeenCalledExactlyOnceWith(undefined, undefined));
});
it("pinned blocker-reason lock matches in-flow until a reason is given for the active design tab", async () => {
 const view = mount(undefined, {}, () => tabbed(true, true));
 fireEvent.mouseDown(screen.getByRole("tab", { name: "Design" }));reportRow("below");
 expectSameLock("Approve design", "Give a reason before approving with an open blocker.");
 fireEvent.click(pinned("Approve design"));expect(view.onApprove).not.toHaveBeenCalled();
 fireEvent.change(screen.getByRole("textbox", { name: "Why approve with an open blocker?" }), { target: { value: "  The fallback is covered.  " } });
 expectSameLock("Approve design");
 fireEvent.click(pinned("Approve design"));await waitFor(() => expect(view.onApprove).toHaveBeenCalledExactlyOnceWith("design", "The fallback is covered."));
});
it("pinned requirements-before-design lock matches in-flow and follows the selected tab", () => {
 const view = mount(undefined, {}, () => tabbed());
 fireEvent.mouseDown(screen.getByRole("tab", { name: "Design" }));reportRow("below");
 expectSameLock("Approve design", "Approve the requirements before approving the design.");
 fireEvent.click(pinned("Approve design"));expect(view.onApprove).not.toHaveBeenCalled();
 fireEvent.mouseDown(screen.getByRole("tab", { name: "Requirements" }));
 expectSameLock("Approve requirements");
});
it.each(["requirements", "design"] as const)("pinned approves ONLY the active %s tab with exactly the in-flow arguments", async which => {
 const change = () => tabbed(which === "design");
 const first = mount(undefined, {}, change);
 fireEvent.mouseDown(screen.getByRole("tab", { name: which === "design" ? "Design" : "Requirements" }));reportRow("below");
 expectSameLock("Approve " + which);
 fireEvent.click(pinned("Approve " + which));
 await waitFor(() => expect(first.onApprove).toHaveBeenCalledExactlyOnceWith(which, undefined));
 const args = first.onApprove.mock.calls[0];first.unmount();
 const second = mount(undefined, {}, change);
 fireEvent.mouseDown(screen.getByRole("tab", { name: which === "design" ? "Design" : "Requirements" }));
 fireEvent.click(inFlow("Approve " + which));
 await waitFor(() => expect(second.onApprove).toHaveBeenCalledExactlyOnceWith(...args!));
});
it.each(["pinned", "in-flow"] as const)("an unconfirmed %s approval switches to the receipt with unserved steps Unknown and no second approval", async via => {
 const onApprove = vi.fn<DecisionCardActions["onApprove"]>(async () => { throw new ApiError(409, "APPROVAL_UNKNOWN", "Rovara didn't confirm this yet."); });
 mount(onApprove, {}, () => decision("approve_plan"));reportRow("below");
 fireEvent.click(via === "pinned" ? pinned() : inFlow());
 const receipt = await screen.findByRole("region", { name: "Your decision" });
 await waitFor(() => expect(receipt.classList.contains("rv-approval-receipt")).toBe(true));
 for (const label of ["Recorded by Rovara", "Build starting"]) {
  const step = within(receipt).getByText(label).closest("li")!;
  expect(step.getAttribute("data-tone")).toBe("pending");
  expect(within(step).getAllByRole("img", { name: "Unknown" })).toHaveLength(1);
 }
 expect(screen.queryByTestId("approve-pinned")).toBeNull();expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
 expect(within(receipt).getByRole("button", { name: "Check" })).toBeTruthy();expect(onApprove).toHaveBeenCalledExactlyOnceWith(undefined, undefined);
});
it("a pinned click while in-flow approval is in flight hits the busy lock and sends once", async () => {
 let finish!: (value: Awaited<ReturnType<DecisionCardActions["onApprove"]>>) => void;
 const pending = new Promise<Awaited<ReturnType<DecisionCardActions["onApprove"]>>>(resolve => { finish = resolve; });
 const onApprove = vi.fn<DecisionCardActions["onApprove"]>(() => pending);
 mount(onApprove, {}, () => decision("approve_plan"));reportRow("below");
 fireEvent.click(inFlow());
 for (const button of [inFlow(), pinned()]) { expect(button.disabled).toBe(true);expect(button.getAttribute("aria-busy")).toBe("true"); }
 fireEvent.click(pinned());expect(onApprove).toHaveBeenCalledExactlyOnceWith(undefined, undefined);
 await act(async () => { finish({ kind: "decided", outcome: "approved" }); });
 expectSameLock("Approve");
});
