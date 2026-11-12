// @vitest-environment jsdom
// Experience lane, task page: the leading header (flag `leadingHeader`) on the real session screen, its phone order, and the plain worker word in the conversation.
import { afterEach, expect, it, vi } from "vitest";
import { screen, within, waitFor, fireEvent, act } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { SessionScreen } from "../../packages/ui/src/screens/session/SessionScreen.js";
import { Conversation } from "../../packages/ui/src/screens/session/Conversation.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { fakeHost } from "./support/fake-host.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { workspaceFixture } from "./support/workspace-fixture.js";
import { SESSION_FIXTURE_ID } from "./support/session-fixture.js";

afterEach(() => { vi.unstubAllGlobals(); });
const TASK = "11111111-1111-4111-8111-111111111111";
const planCard = (risk: "low" | "medium" | "high" = "medium") => ({ id: "approve_plan:" + TASK, kind: "approve_plan", taskId: TASK, project: "payments", title: "Approve the plan", question: "Approve this plan?", recommended: { action: risk === "high" ? "open" : "approve", why: "the plan matches the request" }, next: { text: "Builds it" }, evidence: [], risk, riskReasons: [], friction: { expandEvidenceFirst: risk !== "low", freshSignIn: risk === "high", secondPerson: false }, actions: risk === "high" ? [{ kind: "open", label: "Open", href: "/app/sessions/" + SESSION_FIXTURE_ID, method: "GET" }] : [{ kind: "approve", label: "Approve", href: "/v1/app/decisions/approve_plan/" + TASK + "/approve", method: "POST" }, { kind: "open", label: "Open", href: "/app/sessions/" + SESSION_FIXTURE_ID, method: "GET" }], rejectReasons: [], status: "pending", createdAt: "2026-10-23T12:00:00.000Z" });
const digest = "a".repeat(64);
function setup(session = workspaceFixture({ display: { state: "needs_you", reason: "the plan is waiting for approval", next: "Approve the plan in Rovara." } } as never, {}), cards: unknown[] = [planCard()]) {
 const f = fakeHost(async request => {
  const path = request.path.split("?", 1)[0]!;
  if (path === "/v1/app/decisions") return cards.length === 0 ? { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } } : { status: 200, body: { cards, total: cards.length, digests: Object.fromEntries(cards.map(card => [(card as { id: string }).id, digest])) } };
  if (path.endsWith("/messages")) return { status: 200, body: { messages: [] } };
  if (path.endsWith("/events")) return { status: 200, body: { events: [] } };
  if (path.endsWith("/presence")) return { status: 200, body: { viewingNow: session.viewingNow } };
  return { status: 200, body: { session } };
 });
 const query = createQueryClient(), router = createMemoryRouter([{ path: "/app/sessions/:id", element: h(SessionScreen, {}) }], { initialEntries: ["/app/sessions/" + SESSION_FIXTURE_ID] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Announcer, { children: h(RouterProvider, { router }) }) }) }));
 return { ...f, ...ui, router, close() { ui.unmount();router.dispose();query.clear(); } };
}
const phone = (matches: boolean) => vi.stubGlobal("matchMedia", (query: string) => ({ matches, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));

it("is always there (decision 125), whatever a leftover ?lead=0 address says: the lead block, and no old Next line", async () => {
 const f = setup();
 await screen.findByRole("heading", { name: "Fix duplicate refunds" });
 expect(await screen.findByRole("region", { name: "Where this task stands" })).toBeTruthy();
 expect(screen.queryByLabelText("Next step")).toBeNull();
 f.close();
});
it("leads with the plain state, next step, who and why, and replaces the old Next line and status dot", async () => {

 const f = setup();
 const lead = await screen.findByRole("region", { name: "Where this task stands" });
 await waitFor(() => expect(lead.textContent).toContain("Decide: Approve the plan"));
 expect(within(lead).getByText("Needs a decision")).toBeTruthy();
 expect(within(lead).getByText("Who").nextElementSibling!.textContent).toBe("You");
 expect(within(lead).getByText("Why").nextElementSibling!.textContent).toBe("The plan is waiting for approval");
 expect(lead.textContent).toContain("✓ You can approve · medium risk");
 expect(f.container.querySelector(".rv-session-next")).toBeNull();
 expect(f.container.querySelector(".rv-session-facts .rv-status")).toBeNull();
 expect(f.container.textContent).not.toMatch(/needs_person|needs_you|BLOCKED|SUCCEEDED|MODEL_/u);
 await expectNoAxeViolations(f.container);
 f.close();
});
it("its one action goes to the decision card that is already on the page and focuses it", async () => {

 const f = setup();
 const go = await screen.findByRole("button", { name: "Go to the decision" });
 const card = await waitFor(() => { const el = document.getElementById("decision-approve_plan-" + TASK);if (el === null) throw new Error("no card");return el; });
 fireEvent.click(go);
 expect(document.activeElement).toBe(card);
 f.close();
});
it("with no decision of mine and a state that waits on someone, says so plainly and names nobody", async () => {

 const base = workspaceFixture({ display: { state: "needs_you", reason: "the plan is waiting for approval", next: "Approve the plan in Rovara.", nextOthers: "The task owner approves the plan." }, you: { level: "view", owner: false, following: false, actions: ["watch"] } } as never, {});
 const f = setup(base, []);
 const lead = await screen.findByRole("region", { name: "Where this task stands" });
 expect(lead.textContent).toContain("The task owner approves the plan");
 expect(within(lead).getByText("Who").nextElementSibling!.textContent).toBe("Someone with permission");
 expect(within(lead).queryByRole("button")).toBeNull();
 expect(lead.textContent).not.toContain("You can approve");
 f.close();
});
it("on a phone the DOM order is the lead, the decision card, the facts and controls, then the work behind a collapsed disclosure", async () => {
phone(true);
 const f = setup();
 const lead = await screen.findByRole("region", { name: "Where this task stands" });
 const card = await waitFor(() => { const el = document.getElementById("decision-approve_plan-" + TASK);if (el === null) throw new Error("no card");return el; });
 const facts = f.container.querySelector(".rv-session-details")!, evidence = f.container.querySelector<HTMLDetailsElement>("details.rv-session-evidence")!;
 const before = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
 expect(before(lead, card)).toBe(true);expect(before(card, facts)).toBe(true);expect(before(facts, evidence)).toBe(true);
 expect(lead.firstElementChild!.className).toBe("rv-lead-approve");
 expect(evidence.open).toBe(false);
 expect(within(evidence).getByRole("tab", { name: "Pipeline" })).toBeTruthy();
 expect(f.container.querySelector("header .rv-session-facts")).toBeNull();
 await expectNoAxeViolations(f.container);
 f.close();
});
it("on a wide screen the facts stay in the header and nothing is collapsed", async () => {
phone(false);
 const f = setup();
 await screen.findByRole("region", { name: "Where this task stands" });
 expect(f.container.querySelector("header .rv-session-facts")).not.toBeNull();
 expect(f.container.querySelector("details.rv-session-evidence")).toBeNull();
 f.close();
});
it("reads the raw worker word in the conversation as a plain state (always, since decision 125)", () => {
 const event = { eventId: "evt_aaaaaaaaaaaaaaaaaaaa", sessionId: SESSION_FIXTURE_ID, type: "status", source: "worker", text: "Worker status: SUCCEEDED", at: "2026-10-23T12:00:00.000Z" } as never;
 const on = renderUi(h(Conversation, { agent: "Payments expert", messages: [], events: [event] }));
 expect(screen.getByText("Run finished")).toBeTruthy();expect(on.container.textContent).not.toContain("SUCCEEDED");on.unmount();
});

const mergeSession = () => workspaceFixture({ display: { state: "ready_to_merge", next: "Press Merge." }, you: { level: "edit", owner: true, following: false, actions: ["watch", "comment"] } } as never, { merge: { ready: true } });
it("on a phone, Go to Merge opens the closed work disclosure and focuses the Merge section inside it", async () => {
phone(true);
 const f = setup(mergeSession(), []);
 const go = await screen.findByRole("button", { name: "Go to Merge" });
 const details = f.container.querySelector<HTMLDetailsElement>("details.rv-session-evidence")!;
 expect(details.open).toBe(false);
 fireEvent.click(go);
 const merge = document.getElementById("task-merge")!;
 expect(details.contains(merge)).toBe(true);
 expect(details.open).toBe(true);
 expect(document.activeElement).toBe(merge);
 f.close();
});
it("on a phone, a later change of the address hash (an in-page link to a tab) opens the closed disclosure", async () => {
phone(true);
 const f = setup();
 await screen.findByRole("region", { name: "Where this task stands" });
 const details = f.container.querySelector<HTMLDetailsElement>("details.rv-session-evidence")!;
 expect(details.open).toBe(false);
 await act(async () => { await f.router.navigate("#plan"); });
 await waitFor(() => expect(details.open).toBe(true));
 details.open = false;details.dispatchEvent(new Event("toggle"));
 await waitFor(() => expect(details.open).toBe(false));
 f.close();
});
