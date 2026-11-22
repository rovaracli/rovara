// @vitest-environment jsdom
import { expect, it } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppHostProvider, type ApiResponse } from "../../packages/ui/src/host.js";
import { PeoplePanel } from "../../packages/ui/src/screens/session/PeoplePanel.js";
import { SessionControls } from "../../packages/ui/src/screens/session/SessionControls.js";
import { ShareDialog } from "../../packages/ui/src/screens/session/ShareDialog.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { fakeHost } from "./support/fake-host.js";
import { meFixture } from "./support/fixtures.js";
import { workspaceFixture } from "./support/workspace-fixture.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); }); };

it("Low-1: People removal releases busy while its post-answer read is stalled", async () => {
 let sent = false, finish: ((value: ApiResponse) => void) | undefined;
 const people = { revision: 3, orphaned: false, canManage: true, canTakeOwnership: false, people: [] }, sharedWith = [{ developerId: "d".repeat(64), name: "Dan", role: "viewer" }];
 const answer = { status: 200, body: { people, sharedWith } };
 const f = fakeHost(async r => r.path === "/v1/app/me" ? { status: 200, body: meFixture() } : r.method === "DELETE" ? (sent = true, { status: 200, body: { removed: true } }) : sent ? new Promise(resolve => { finish = resolve; }) : r.path.endsWith("/candidates") ? { status: 200, body: { candidates: [], complete: true } } : answer);
 const query = createQueryClient(), ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(PeoplePanel, { id: workspaceFixture().sessionId }) }) }));
 await act(async () => { const panel = screen.getByTestId<HTMLDetailsElement>("people-panel");panel.open = true;panel.dispatchEvent(new Event("toggle")); });
 const remove = await screen.findByRole<HTMLButtonElement>("button", { name: "Remove Dan" });await waitFor(() => expect(remove.disabled).toBe(false));fireEvent.click(remove);await waitFor(() => expect(finish).toBeTypeOf("function"));await settle();
 expect(remove.disabled).toBe(false);expect(f.request.mock.calls.filter(([r]) => r.method === "DELETE")).toHaveLength(1);finish!(answer);ui.unmount();query.clear();
});
it("Low-1: stale-CSRF Follow releases busy before identity recovery finishes", async () => {
 let sent = false, finish: ((value: ApiResponse) => void) | undefined;
 const base = workspaceFixture(), session = { ...base, you: { ...base.you, actions: ["watch"] } };
 const f = fakeHost(async r => r.path === "/v1/app/me" ? sent ? new Promise(resolve => { finish = resolve; }) : { status: 200, body: meFixture() } : r.method === "GET" ? { status: 200, body: { session } } : (sent = true, { status: 403, body: { error: { code: "CSRF_INVALID", message: "Check identity" } } }));
 const query = createQueryClient(), ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(SessionControls, { id: base.sessionId, agent: "Agent", actions: ["watch"], following: false, onChanged: async () => undefined }) }) }));
 const follow = await screen.findByRole<HTMLButtonElement>("button", { name: "Follow" });await waitFor(() => expect(follow.disabled).toBe(false));fireEvent.click(follow);await waitFor(() => expect(finish).toBeTypeOf("function"));await settle();
 expect(follow.disabled).toBe(false);expect(screen.getByRole("alert").textContent).toContain("Nothing was sent");finish!({ status: 200, body: meFixture() });ui.unmount();query.clear();
});
it("Low-1: Add share releases busy before its post-answer read finishes", async () => {
 let sent = false, finish: ((value: ApiResponse) => void) | undefined;
 const base = workspaceFixture(), session = { ...base, you: { ...base.you, actions: ["share"] } }, me = meFixture();
 const share = { principal: { kind: "member", developerId: me.developer.id }, level: "view", sharedBy: { developerId: me.developer.id, name: me.developer.name }, sharedAt: "2026-11-20T12:00:00.000Z" };
 const f = fakeHost(async r => r.path === "/v1/app/me" ? { status: 200, body: me } : r.method === "PUT" ? (sent = true, { status: 200, body: { share } }) : r.path.endsWith("/shares") ? sent ? new Promise(resolve => { finish = resolve; }) : { status: 200, body: { shares: [] } } : r.path.endsWith("/members") ? { status: 200, body: { members: [{ developerId: me.developer.id, name: "Ada", role: "member" }] } } : { status: 200, body: { session } });
 const query = createQueryClient(), ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ShareDialog, { id: base.sessionId, orgName: "Example", open: true }) }) }));
 const person = await screen.findByRole<HTMLButtonElement>("button", { name: "Ada" });await waitFor(() => expect(person.disabled).toBe(false));fireEvent.click(person);
 const add = screen.getByRole<HTMLButtonElement>("button", { name: "Add share" });fireEvent.click(add);await waitFor(() => expect(finish).toBeTypeOf("function"));await settle();
 expect(add.disabled).toBe(false);expect(screen.getByText("Shared")).toBeTruthy();finish!({ status: 200, body: { shares: [share] } });ui.unmount();query.clear();
});
