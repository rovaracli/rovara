// @vitest-environment jsdom
// The session tile (the project page and an agent's profile list running work with it). Decision 125 deleted the Live page it was first built for: /app/live redirects to Work (tests/web/work-list.test.ts, tests/web/nav-v2.test.ts).
import { afterEach, expect, it, vi } from "vitest";
import { screen, fireEvent, waitFor, act } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { SessionTile } from "../../packages/ui/src/screens/live/SessionTile.js";
import { acceptLivePage } from "../../packages/ui/src/api/live.js";
import { createSessionActions } from "../../packages/ui/src/api/session-actions.js";
import { createNoticeInvalidator } from "../../packages/ui/src/realtime/invalidate.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { liveFixture } from "./support/live-fixture.js";
import { sessionFixture, SESSION_FIXTURE_ID } from "./support/session-fixture.js";
import { navFixture } from "./support/fixtures.js";
afterEach(() => { vi.useRealTimers(); });
function setup(options: { tile?: ReturnType<typeof liveFixture>; path?: string; theme?: "light" | "dark"; send?: (request: ApiRequest) => Promise<ApiResponse>; screen?: boolean; liveRead?: (request: ApiRequest) => Promise<ApiResponse> } = {}) {
 let tiles = [options.tile ?? liveFixture()], status = 200, owner = false;
 const f = fakeHost(async request => {
 if (request.path.startsWith("/v1/app/live") && options.liveRead) return options.liveRead(request);
 if (request.path.startsWith("/v1/app/live")) return { status, body: status === 200 ? { tiles } : { error: { code: "FORBIDDEN", message: "Your access ended." } } };
 if (request.path === "/v1/app/nav") return { status: 200, body: navFixture() };
 if (request.path === "/v1/app/changes") return { status: 200, body: { notices: [], next: "settled" } };
 if (request.method === "GET" && request.path === "/v1/app/sessions/" + SESSION_FIXTURE_ID) return { status: 200, body: { session: sessionFixture({ revision: owner ? 2 : 1, you: { level: "edit", owner, following: false, actions: ["watch", "take_over", "stop", "retry"] } }) } };
 return options.send ? options.send(request) : { status: 200, body: { following: true } };
 });
 const query = createQueryClient(), changed = vi.fn(async () => undefined);
 const router = createMemoryRouter([{ path: "/app/live", element: h(SessionTile, { tile: options.tile ?? liveFixture(), onChanged: changed }) }], { initialEntries: [options.path ?? "/app/live"] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Announcer, { children: h(RouterProvider, { router }) }) }) }), { theme: options.theme ?? "light" });
 return { ...f, ...ui, query, router, changed, answer(next: typeof tiles, nextStatus = 200) { tiles = next;status = nextStatus; }, owned() { owner = true; }, close() { ui.unmount();router.dispose();query.clear(); } };
}
it("shows only Arjun's permitted Follow, with status words and a stable session link", async () => {
 const f = setup();expect(screen.getByRole("button", { name: "Follow" })).toBeTruthy();expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();expect(screen.getByText("Running")).toBeTruthy();expect(screen.getByRole("link", { name: "Fix duplicate refunds" }).getAttribute("href")).toBe("/app/sessions/" + SESSION_FIXTURE_ID);fireEvent.click(screen.getByRole("button", { name: "Follow" }));await waitFor(() => expect(f.changed).toHaveBeenCalledTimes(1));expect(f.request.mock.calls[0]?.[0]).toMatchObject({ method: "POST", path: "/v1/app/sessions/" + SESSION_FIXTURE_ID + "/follow" });f.close();
});
it("shows Max's permitted actions and confirms Stop before posting it", async () => {
 const f = setup({ tile: liveFixture({ actions: ["watch", "take_over", "stop", "retry"] }), send: async () => ({ status: 200, body: { session: sessionFixture() } }) });
 expect(screen.getByRole("button", { name: "Take over" })).toBeTruthy();expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();fireEvent.click(screen.getByRole("button", { name: "Stop" }));expect(f.request).not.toHaveBeenCalled();expect(await screen.findByRole("dialog", { name: "Stop this session?" })).toBeTruthy();expect(screen.getByText("Payments expert stops after its current step. If the task is blocked instead of running, Stop ends it and frees its workspace only while no code has been written; after that, use Close task.")).toBeTruthy();fireEvent.click(screen.getByRole("button", { name: "Stop session" }));await waitFor(() => expect(f.changed).toHaveBeenCalledTimes(1));expect(f.request.mock.calls[0]?.[0]).toMatchObject({ method: "POST", path: "/v1/app/sessions/" + SESSION_FIXTURE_ID + "/stop" });f.close();
});
it("opens only a valid caller confirmation destination externally", () => {
 const url = "https://cell.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa", f = setup({ tile: liveFixture({ approvalUrl: url }) });fireEvent.click(screen.getByRole("button", { name: "Approve" }));expect(f.host.openExternal).toHaveBeenCalledWith(url);f.close();
 const unsafe = setup({ tile: liveFixture({ approvalUrl: "https://other.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa" }) });expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();unsafe.close();
});
it("keeps takeover pending until a real read says the caller owns it", async () => {
 const f = setup({ tile: liveFixture({ actions: ["take_over"] }), send: async () => ({ status: 202, body: { status: "NEEDS_CONFIRMATION", code: "REAUTH_REQUIRED", confirmUrl: "https://cell.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa", changes: ["You will own this session."] } }) });
 fireEvent.click(screen.getByRole("button", { name: "Take over" }));await screen.findByText("Waiting for you to confirm in your browser");fireEvent.click(screen.getByRole("button", { name: "Open confirmation" }));expect(f.host.openExternal).toHaveBeenCalledTimes(1);expect(screen.queryByText("You now own this session.")).toBeNull();await act(() => f.query.setQueryData(["session", SESSION_FIXTURE_ID], sessionFixture({ revision: 2, you: { level: "edit", owner: true, following: false, actions: ["watch"] } })));expect(screen.queryByText("You now own this session.")).toBeNull();f.owned();await f.query.invalidateQueries({ queryKey: ["session", SESSION_FIXTURE_ID] });await screen.findByText("You now own this session.");f.close();
});
it("renders a plain-text peek, actual cost, people and offline location", () => {
 const f = setup({ tile: { ...liveFixture({ where: { kind: "mac", label: "Priya's MacBook", offline: true }, viewingNowCount: 7 }), peek: "\u001b[31mBuilding safely\u001b[0m" } });expect(screen.getByText("Building safely")).toBeTruthy();expect(f.container.textContent).not.toContain("[31m");expect(screen.getByText("$1.20")).toBeTruthy();expect(screen.getByText("on Priya's MacBook")).toBeTruthy();expect(screen.getByText("offline")).toBeTruthy();expect(screen.getByText("+6")).toBeTruthy();f.close();
});
it("coalesces twenty session notices into one Live refetch after 500ms", async () => {
 vi.useFakeTimers();const query = createQueryClient(), invalidate = vi.spyOn(query, "invalidateQueries").mockResolvedValue(undefined), apply = createNoticeInvalidator(query);
 for (let revision = 1; revision <= 20; revision++) apply.notice({ type: "session.updated", sessionId: SESSION_FIXTURE_ID, revision });
 const liveCalls = () => invalidate.mock.calls.filter(([input]) => JSON.stringify(input?.queryKey) === '["live"]').length;
 expect(liveCalls()).toBe(0);await vi.advanceTimersByTimeAsync(499);expect(liveCalls()).toBe(0);await vi.advanceTimersByTimeAsync(1);expect(liveCalls()).toBe(1);apply.stop();query.clear();
});
it("keeps a newer tile when an older answer arrives and honors actual removals", () => {
 const newer = liveFixture({ step: "Building", updatedAt: "2026-10-23T12:02:00.000Z" }), older = liveFixture({ step: "Planning", updatedAt: "2026-10-23T12:01:00.000Z" });expect(acceptLivePage({ tiles: [newer] }, { tiles: [older] }).tiles[0]?.step).toBe("Building");expect(acceptLivePage({ tiles: [newer] }, { tiles: [] }).tiles).toEqual([]);
});
it("sends canonical control routes with fresh request IDs and refuses an invalid session id", async () => {
 const f = fakeHost(async request => ({ status: 200, body: request.path.endsWith("/follow") ? { following: request.method === "POST" } : { session: sessionFixture() } })), api = createSessionActions(f.host);
 await api.follow(SESSION_FIXTURE_ID);await api.unfollow(SESSION_FIXTURE_ID);await api.stop(SESSION_FIXTURE_ID);await api.retry(SESSION_FIXTURE_ID);await api.takeOver(SESSION_FIXTURE_ID);
 expect(f.request.mock.calls.map(([request]) => [request.method, request.path.split("/").at(-1)])).toEqual([["POST", "follow"], ["DELETE", "follow"], ["POST", "stop"], ["POST", "retry"], ["POST", "take-over"]]);
 const writes = f.request.mock.calls.slice(2).map(([request]) => request.body as { requestId: string });expect(new Set(writes.map(body => body.requestId)).size).toBe(3);expect(writes.every(body => /^[0-9a-f-]{36}$/u.test(body.requestId))).toBe(true);await expect(async () => api.stop("../outside")).rejects.toThrow();expect(f.request).toHaveBeenCalledTimes(5);
});
for (const theme of ["light", "dark"] as const) it("has accessible permitted session controls in " + theme, async () => { const f = setup({ tile: liveFixture({ actions: ["watch", "take_over", "stop", "retry"] }), theme });await expectNoAxeViolations(f.container);f.close(); });

it("does not run a queued Live invalidation after its screen closes", async () => {
 vi.useFakeTimers();const query = createQueryClient(), invalidate = vi.spyOn(query, "invalidateQueries").mockResolvedValue(undefined), apply = createNoticeInvalidator(query);apply.notice({ type: "session.updated", sessionId: SESSION_FIXTURE_ID, revision: 1 });apply.stop();invalidate.mockClear();await vi.advanceTimersByTimeAsync(1000);apply.notice({ type: "home.changed", revision: 1 });expect(invalidate).not.toHaveBeenCalled();query.clear();
});
it("shows a refused Stop without claiming it stopped or closing the confirmation", async () => {
 const f = setup({ tile: liveFixture({ actions: ["stop"] }), send: async () => ({ status: 403, body: { error: { code: "FORBIDDEN", message: "You can no longer stop this session." } } }) });fireEvent.click(screen.getByRole("button", { name: "Stop" }));fireEvent.click(await screen.findByRole("button", { name: "Stop session" }));await screen.findByText("You can no longer stop this session.");expect(screen.getByRole("dialog", { name: "Stop this session?" })).toBeTruthy();expect(screen.queryByText("Stop requested.")).toBeNull();expect(f.changed).not.toHaveBeenCalled();f.close();
});
it("clears a refused Stop's message when the confirmation closes or opens again, so no stale \"This session has ended.\" lingers", async () => {
 const f = setup({ tile: liveFixture({ actions: ["stop"] }), send: async () => ({ status: 409, body: { error: { code: "SESSION_ENDED", message: "This session has ended." } } }) });
 fireEvent.click(screen.getByRole("button", { name: "Stop" }));fireEvent.click(await screen.findByRole("button", { name: "Stop session" }));
 expect((await screen.findByRole("alert")).textContent).toBe("This session has ended.");
 // Closing the confirmation drops the message; it is not left under the controls.
 fireEvent.click(screen.getByRole("button", { name: "Keep running" }));await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());expect(screen.queryByText("This session has ended.")).toBeNull();
 // Opening it again starts clean (the failed attempt does not come back with the dialog).
 fireEvent.click(screen.getByRole("button", { name: "Stop" }));expect(await screen.findByRole("dialog", { name: "Stop this session?" })).toBeTruthy();expect(screen.queryByText("This session has ended.")).toBeNull();expect(screen.queryByRole("alert")).toBeNull();f.close();
});
it("retries once and opens the actual returned session rather than assuming the old id", async () => {
 const returned = "ses_bbbbbbbbbbbbbbbbbbbb", send = vi.fn(async () => ({ status: 200, body: { session: sessionFixture({ sessionId: returned }) } }));
 const f = setup({ tile: liveFixture({ actions: ["retry"] }), send }), navigate = vi.spyOn(f.host, "navigate"), button = screen.getByRole("button", { name: "Retry" });fireEvent.click(button);fireEvent.click(button);await waitFor(() => expect(navigate).toHaveBeenCalledWith("/app/sessions/" + returned));expect(send).toHaveBeenCalledTimes(1);expect(f.changed).toHaveBeenCalledTimes(1);f.close();
});
it("offers no action without a capability and uses DELETE for Following", async () => {
 const none = setup({ tile: liveFixture({ actions: [] }) });for (const name of ["Follow", "Take over", "Stop", "Retry"]) expect(screen.queryByRole("button", { name })).toBeNull();none.close();
 const f = setup({ tile: liveFixture({ following: true }) });fireEvent.click(screen.getByRole("button", { name: "Following" }));await waitFor(() => expect(f.changed).toHaveBeenCalledTimes(1));expect(f.request.mock.calls[0]?.[0]).toMatchObject({ method: "DELETE", path: "/v1/app/sessions/" + SESSION_FIXTURE_ID + "/follow" });f.close();
});