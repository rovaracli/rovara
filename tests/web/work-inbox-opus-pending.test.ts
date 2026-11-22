// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ApiError } from "../../packages/ui/src/api/errors.js";
import { AppHostProvider, type ApiRequest } from "../../packages/ui/src/host.js";
import { queueActionHost } from "../../packages/ui/src/screens/work/queue-action-host.js";
import { queueActionReads } from "../../packages/ui/src/screens/work/queue-action-reads.js";
import { checkQueuePending, queuePending, queuePendingKeys } from "../../packages/ui/src/screens/work/queue-action-pending.js";
import { fenceFor } from "../../packages/ui/src/safe-action.js";
import { QueueActions } from "../../packages/ui/src/screens/work/QueueActions.js";
import { StaleReads } from "../../packages/ui/src/screens/work/StaleReads.js";
import { fakeHost } from "./support/fake-host.js";
import { meFixture } from "./support/fixtures.js";
import { h } from "./support/h.js";
import { renderUi } from "./support/render.js";
const close: Array<() => void> = [];
afterEach(() => { close.splice(0).forEach(fn => fn());localStorage.clear();vi.restoreAllMocks();vi.useRealTimers(); });
const id = "ses_aaaaaaaaaaaaaaaaaaaa.needs_you.1763208000000";
function fixture() {
 const me = meFixture(), query = createQueryClient();close.push(() => query.clear());
 let page = { items: [{ id, kind: "needs_you", title: "Update", status: "Waiting.", at: "2026-11-15T11:00:00.000Z", read: false, open: "/s/ses_aaaaaaaaaaaaaaaaaaaa" }], unread: 1 };
 const f = fakeHost(async input => input.method === "GET" ? { status: 200, body: input.path === "/v1/app/me" ? me : page } : { status: 503, body: {} });
 const key = "rovara:queue-action:" + JSON.stringify([me.org.orgId, me.developer.id, "inbox"]);
 const input: ApiRequest = { method: "POST", path: "/v1/app/inbox/read", body: { ids: [id], requestId: "one" } };
 const seed = () => { query.setQueryData(["queue", "identity"], me);query.setQueryData(["inbox", "list"], { pages: [page], pageParams: [undefined] }); };
 seed();
 const api = queueActionHost(f.host, query, () => me, input => queueActionReads(f.host, query, input), () => undefined);
 const record = () => localStorage.setItem(key, JSON.stringify({ request: input, startedAt: new Date().toISOString() }));
 const check = (explicit = false) => checkQueuePending(f.host, query, me, key, explicit);
 return { ...f, query, me, key, input, api, seed, record, check, page: () => page, read: () => { page = { ...page, items: page.items.map(item => ({ ...item, read: true })), unread: 0 }; }, writes: () => f.request.mock.calls.filter(([input]) => input.method !== "GET") };
}
it("503 then observed read settles only that press, allowing another inbox subject action", async () => {
 const f = fixture();await expect(f.api.transport.request(f.input)).rejects.toBeTruthy();
 await f.check();expect(localStorage.getItem(f.key)).not.toBeNull();
 f.read();await new Promise(resolve => setTimeout(resolve, 0));await f.check();expect(localStorage.getItem(f.key)).toBeNull();
 // The next current unread read supplies authority for a distinct update.
 f.seed();f.query.setQueryData(["inbox", "list"], { pages: [{ ...f.page(), items: f.page().items.map(item => ({ ...item, read: false })) }], pageParams: [undefined] });
 f.request.mockImplementation(async input => input.method === "GET" ? { status: 200, body: input.path === "/v1/app/me" ? f.me : { ...f.page(), items: f.page().items.map(item => ({ ...item, read: false })) } } : { status: 200, body: { marked: 1 } });
 await new Promise(resolve => setTimeout(resolve, 0));await expect(f.api.transport.request(f.input)).resolves.toMatchObject({ status: 200 });expect(f.writes()).toHaveLength(2);
});
it.each(["unread", "missing", "refused", "identity", "active identity", "failure count", "storage changed", "no source", "malformed"])("Check keeps %s unknown and never writes", async state => {
 const f = fixture();f.record();f.read();
 if (state === "unread") f.request.mockImplementation(async input => ({ status: 200, body: input.path === "/v1/app/me" ? f.me : { ...f.page(), items: f.page().items.map(item => ({ ...item, read: false })) } }));
 if (state === "missing") f.request.mockImplementation(async input => ({ status: 200, body: input.path === "/v1/app/me" ? f.me : { items: [], unread: 0 } }));
 if (state === "refused") f.request.mockImplementation(async input => ({ status: input.path === "/v1/app/me" ? 200 : 403, body: input.path === "/v1/app/me" ? f.me : { error: { code: "FORBIDDEN", message: "Access ended" } } }));
 if (state === "identity") f.request.mockImplementation(async () => ({ status: 200, body: meFixture({ developer: { ...f.me.developer, id: "b".repeat(64) } }) }));
 if (state === "active identity") f.query.setQueryData(["queue", "identity"], meFixture({ org: { ...f.me.org, orgId: "other" } }));
 if (state === "failure count") f.query.getQueryCache().find({ queryKey: ["queue", "identity"] })!.setState({ fetchFailureCount: 1 });
 if (state === "storage changed") f.request.mockImplementation(async input => { if (input.path !== "/v1/app/me") localStorage.setItem(f.key, "another press");return { status: 200, body: input.path === "/v1/app/me" ? f.me : f.page() }; });
 if (state === "no source") localStorage.setItem(f.key, JSON.stringify({ request: { ...f.input, path: "/unknown" }, startedAt: new Date().toISOString() }));
 if (state === "malformed") localStorage.setItem(f.key, "broken");
 await f.check(true);expect(localStorage.getItem(f.key)).not.toBeNull();expect(f.writes()).toHaveLength(0);
 if (["identity", "active identity", "failure count"].includes(state)) expect(f.request.mock.calls.filter(([input]) => input.path !== "/v1/app/me")).toHaveLength(0);
});
it("a different person's lock is invisible and cannot be checked", async () => {
 const f = fixture();f.record();f.read();
 await checkQueuePending(f.host, f.query, meFixture({ developer: { ...f.me.developer, id: "b".repeat(64) } }), f.key);
 expect(f.request).not.toHaveBeenCalled();expect(localStorage.getItem(f.key)).not.toBeNull();
});
it("a source read changing identity during Check cannot settle a press", async () => {
 const f = fixture();f.record();f.read();
 f.request.mockImplementation(async input => { if (input.path !== "/v1/app/me") f.query.setQueryData(["queue", "identity"], meFixture({ developer: { ...f.me.developer, id: "b".repeat(64) } }));return { status: 200, body: input.path === "/v1/app/me" ? f.me : f.page() }; });
 await f.check();expect(localStorage.getItem(f.key)).not.toBeNull();
});
it("a Check cannot settle a send still in flight", async () => {
 const f = fixture();let release!: () => void;const hold = new Promise<void>(resolve => { release = resolve; });
 f.request.mockImplementation(async input => { if (input.method !== "GET") { await hold;return { status: 503, body: {} }; }return { status: 200, body: input.path === "/v1/app/me" ? f.me : f.page() }; });
 const sent = f.api.transport.request(f.input);await waitFor(() => expect(f.writes()).toHaveLength(1));f.read();await f.check();expect(localStorage.getItem(f.key)).not.toBeNull();release();await expect(sent).rejects.toBeTruthy();
});
it.each(["checks", "time"])("shared unknown exit after %s keeps the lock and Check available", async mode => {
 const f = fixture();f.record();
 if (mode === "time") { const entry = JSON.parse(localStorage.getItem(f.key)!) as { startedAt: string };entry.startedAt = new Date(Date.now() - 600001).toISOString();localStorage.setItem(f.key, JSON.stringify(entry)); }
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: f.query, children: h(MemoryRouter, { children: h(QueueActions, { children: null }) }) }) }));close.push(() => view.unmount());
 const check = await screen.findByRole("button", { name: "Check current state" });
 if (mode === "checks") for (let i = 0; i < 3; i++) { await act(async () => { fireEvent.click(check);await new Promise(resolve => setTimeout(resolve, 20)); });if (i < 2) expect(screen.queryByRole("link", { name: "Open the task to check" })).toBeNull(); }
 expect((await screen.findByRole("link", { name: "Open the task to check" })).getAttribute("href")).toBe("/app/inbox");
 expect(localStorage.getItem(f.key)).not.toBeNull();expect((check as HTMLButtonElement).disabled).toBe(false);expect(f.writes()).toHaveLength(0);
});
it("later reads settle pending without another press", async () => {
 const f = fixture();f.record();const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: f.query, children: h(MemoryRouter, { children: h(QueueActions, { children: null }) }) }) }));close.push(() => view.unmount());
 await screen.findByRole("button", { name: "Check current state" });await act(async () => { await new Promise(resolve => setTimeout(resolve, 30));f.read();f.seed(); });
 await waitFor(() => expect(localStorage.getItem(f.key)).toBeNull());expect(f.writes()).toHaveLength(0);
});
it.each(["error", "fetchFailureReason"])("StaleReads excludes access-ended %s even with retained observed data", field => {
 const query = createQueryClient(), key = ["supplementary"], observer = new QueryObserver(query, { queryKey: key, enabled: false });
 query.setQueryData(key, { private: true });const unsubscribe = observer.subscribe(() => undefined);
 const state = query.getQueryCache().find({ queryKey: key })!;
 state.setState({ status: "error", error: null, fetchFailureReason: null, [field]: new ApiError(404, "ACCESS_ENDED", "Access ended"), fetchFailureCount: 1 });
 const view = renderUi(h(QueryClientProvider, { client: query, children: h(StaleReads, { reads: [] }) }));close.push(() => { view.unmount();unsubscribe();query.clear(); });
 expect(screen.queryByText(/Reconnecting/u)).toBeNull();
 act(() => { state.setState({ error: new ApiError(503, "UNAVAILABLE", "Refresh failed"), fetchFailureReason: null, errorUpdatedAt: Date.now() + 1 }); });
 return waitFor(() => expect(screen.getByText(/Reconnecting/u)).toBeTruthy());
});
it.each([null, "broken", "null", "{}", '{"request":{},"startedAt":"now"}', '{"request":{"path":"/x","method":"GET"},"startedAt":"now"}'])("malformed saved press stays unreadable: %s", raw => { expect(queuePending(raw)).toBeUndefined(); });
it("unavailable storage has no visible records", () => { vi.spyOn(Storage.prototype, "key").mockImplementation(() => { throw new Error("storage unavailable"); });expect(queuePendingKeys(meFixture())).toEqual([]); });

it.each(["newer success", "newer failure"])("an older Check body cannot supersede %s", async state => {
 const f = fixture();f.record();f.read();const fence = fenceFor(f.query, f.key, "queue");
 f.request.mockImplementation(async input => { if (input.path !== "/v1/app/me") { if (state === "newer success") fence.latestRead = { data: {}, issued: Number.MAX_SAFE_INTEGER };else fence.taskFailed = { seq: Number.MAX_SAFE_INTEGER }; }return { status: 200, body: input.path === "/v1/app/me" ? f.me : f.page() }; });
 await f.check();expect(localStorage.getItem(f.key)).not.toBeNull();
});
it("an unsupported browser cannot inspect or settle a held press", async () => {
 const f = fixture();f.record();f.read();vi.stubGlobal("navigator", {});
 try { await f.check();expect(f.request).not.toHaveBeenCalled();expect(localStorage.getItem(f.key)).not.toBeNull(); } finally { vi.unstubAllGlobals(); }
});

it("an errored queue identity prevents background pending checks until recovery", async () => {
 const f = fixture();f.record();const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: f.query, children: h(MemoryRouter, { children: h(QueueActions, { children: null }) }) }) }));close.push(() => view.unmount());
 await screen.findByRole("button", { name: "Check current state" });await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });f.request.mockClear();
 await act(async () => { f.query.getQueryCache().find({ queryKey: ["queue", "identity"] })!.setState({ status: "error", fetchFailureCount: 1 });await new Promise(resolve => setTimeout(resolve, 50)); });
 expect(screen.queryByRole("button", { name: "Check current state" })).toBeNull();expect(f.request).not.toHaveBeenCalled();
});
it("the timed unknown exit for a task opens that task's real app route", async () => {
 const f = fixture(), taskId = "11111111-1111-4111-8111-111111111111", key = "rovara:queue-action:" + JSON.stringify([f.me.org.orgId, f.me.developer.id, "task:" + taskId]);
 localStorage.setItem(key, JSON.stringify({ request: f.input, startedAt: new Date(Date.now() - 600001).toISOString() }));
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: f.query, children: h(MemoryRouter, { children: h(QueueActions, { children: null }) }) }) }));close.push(() => view.unmount());
 expect((await screen.findByRole("link", { name: "Open the task to check" })).getAttribute("href")).toBe("/t/" + taskId);expect(localStorage.getItem(key)).not.toBeNull();
});
