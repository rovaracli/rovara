// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { MemoryRouter } from "react-router";
import { useState } from "react";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { DecisionCardsViewReaderSchema } from "@agentx/contracts/web";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { runDecisionAction, readDecisions, recordDecisionRead, recordDecisionReadFailure, issueDecisionRead } from "../../packages/ui/src/api/decisions.js";
import { NeedsYou, useDecisionActions } from "../../packages/ui/src/screens/home/NeedsYou.js";
import { PeoplePanel } from "../../packages/ui/src/screens/session/PeoplePanel.js";
import { CloseTaskDialog } from "../../packages/ui/src/screens/session/CloseTaskDialog.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { fakeHost } from "./support/fake-host.js";
import { meFixture } from "./support/fixtures.js";
import { workspaceFixture } from "./support/workspace-fixture.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
const fixture = JSON.parse(readFileSync("tests/fixtures/code-decision-cards.json", "utf8")) as { views: Record<string, unknown> };
const view = fixture.views["approve_dependency"], decision = readDecisions(DecisionCardsViewReaderSchema.parse(view))[0]!, me = meFixture();
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); }); };

it.each(["another tab", "storage", "refused"])("Low-2: mounted decision reports %s pre-send failure and sends nothing", async problem => {
 const f = fakeHost(async () => ({ status: 200, body: me })), query = createQueryClient();
 const identity = { orgId: me.org.orgId, developerId: me.developer.id };recordDecisionRead(identity, issueDecisionRead(), [decision]);
 const descriptor = Object.getOwnPropertyDescriptor(navigator, "locks")!;
 Object.defineProperty(navigator, "locks", { configurable: true, value: { request: async (_name: string, _options: unknown, callback: (lock: unknown) => Promise<unknown>) => {
  if (problem === "refused") recordDecisionReadFailure(identity, issueDecisionRead(), true);
  return callback(problem === "another tab" ? null : { name: "decision-claim", mode: "exclusive" });
 } } });
 if (problem === "storage") f.host.storage.set = () => undefined;
 function Host() { const [words, setWords] = useState("");return h("div", {}, h("button", { onClick: () => { void runDecisionAction(f.host, decision, { requestId: crypto.randomUUID() }, async () => { await f.host.transport.request({ method: "POST", path: "/decision" }); }).catch(error => { setWords((error as Error).message); }); } }, "Decide"), h("p", { role: "alert" }, words)); }
 try {
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Host) }) }));fireEvent.click(screen.getByRole("button", { name: "Decide" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(problem === "another tab" ? "Another tab" : problem === "storage" ? "safely" : "no longer available"));
  expect(screen.getByRole("alert").textContent).not.toContain("didn't confirm");expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(0);ui.unmount();query.clear();
 } finally { Object.defineProperty(navigator, "locks", descriptor); }
});
it("Low-1: a confirmed decision returns before stalled Home/decision refreshes", async () => {
 const f = fakeHost(async r => r.path === "/v1/app/me" ? { status: 200, body: me } : r.method === "GET" ? { status: 200, body: view } : { status: 200, body: { cardId: decision.card.id, outcome: "rejected", remainingTabs: [] } }), query = createQueryClient();
 function Host() {
  useQuery({ queryKey: ["decisions"], initialData: [decision], staleTime: Infinity, queryFn: () => new Promise(() => undefined) });
  useQuery({ queryKey: ["home"], initialData: {}, staleTime: Infinity, queryFn: () => new Promise(() => undefined) });
  const actions = useDecisionActions()(decision), [done, setDone] = useState(false);
  return h("button", { onClick: () => { void actions.onReject("not_now").then(() => { setDone(true); }); } }, done ? "Confirmed" : "Reject");
 }
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Host) }) }));fireEvent.click(screen.getByRole("button", { name: "Reject" }));
 await screen.findByRole("button", { name: "Confirmed" });ui.unmount();query.clear();
});
it("Low-1: a confirmed close clears busy before a stalled onClosed refresh", async () => {
 const session = workspaceFixture({ you: { ...workspaceFixture().you, actions: ["close"] } });
 const f = fakeHost(async r => r.path === "/v1/app/me" ? { status: 200, body: me } : r.method === "GET" ? { status: 200, body: { session } } : { status: 200, body: { session, closed: true } }), query = createQueryClient();
 let refreshing = false;
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(CloseTaskDialog, { id: session.sessionId, open: true, onOpenChange: () => undefined, onClosed: () => { refreshing = true;return new Promise(() => undefined); } }) }) }));
 const button = await screen.findByRole<HTMLButtonElement>("button", { name: "Close task" });await waitFor(() => expect(button.disabled).toBe(false));fireEvent.click(button);await waitFor(() => expect(refreshing).toBe(true));await settle();expect(button.getAttribute("aria-busy")).toBeNull();ui.unmount();query.clear();
});
it.each(["cancel", "expired"])("Low-4: People %s explains the unresolved lock rather than inviting another send", async kind => {
 const people = { revision: 3, orphaned: false, canManage: true, canTakeOwnership: false, people: [{ personId: "11111111-1111-4111-8111-111111111111", name: "Cal", role: "commenter", effectiveRole: "commenter", you: false }] };
 const f = fakeHost(async r => r.path === "/v1/app/me" ? { status: 200, body: me } : r.method === "POST" ? { status: 202, body: { status: "PENDING", requestId: "33333333-3333-4333-8333-333333333333", confirmUrl: "https://example.com/confirm", expiresAt: new Date(Date.now() + (kind === "expired" ? -1000 : 600000)).toISOString() } } : { status: 200, body: r.path.endsWith("/candidates") ? { candidates: [], complete: true } : { people } });
 const query = createQueryClient(), ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(PeoplePanel, { id: workspaceFixture().sessionId }) }) }));
 await act(async () => { const panel = screen.getByTestId<HTMLDetailsElement>("people-panel");panel.open = true;panel.dispatchEvent(new Event("toggle")); });
 const button = await screen.findByRole<HTMLButtonElement>("button", { name: "Remove Cal" });await waitFor(() => expect(button.disabled).toBe(false));fireEvent.click(button);
 if (kind === "cancel") fireEvent.click(within(await screen.findByTestId("people-waiting")).getByRole("button", { name: "Cancel" }));
 await waitFor(() => expect(screen.queryByTestId("people-waiting")).toBeNull());
 expect((await screen.findByTestId("people-message")).textContent).toContain("Check");expect(screen.getByTestId("people-message").textContent).not.toContain("Try again");expect(button.disabled).toBe(true);
 fireEvent.click(button);expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(1);ui.unmount();query.clear();
});

it("P3-1: a server-refused Approve shows Code's words, reads again and keeps Approve available", async () => {
 const approvalView = fixture.views["approve_plan"];let reads = 0;
 const f = fakeHost(async r => r.path === "/v1/app/me" ? { status: 200, body: me } : r.method === "GET" ? (reads++, { status: 200, body: approvalView }) : { status: 409, body: { error: { code: "CHANGE_STALE", message: "This decision changed just before approval." } } }), query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h(NeedsYou, {}) }) }) }));
 try {
  const approve = await screen.findByRole<HTMLButtonElement>("button", { name: "Approve" });await waitFor(() => expect(approve.disabled).toBe(false));fireEvent.click(approve);
  expect((await screen.findByRole("alert")).textContent).toBe("This decision changed just before approval.");
  await waitFor(() => expect(reads).toBeGreaterThanOrEqual(3));
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Approve" }).disabled).toBe(false));
  expect(screen.queryByRole("button", { name: "Check" })).toBeNull();
  expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(1);
 } finally { ui.unmount();query.clear(); }
});
