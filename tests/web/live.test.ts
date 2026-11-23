// @vitest-environment jsdom
import { createCandidateManifest } from "@agentx/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { SessionControls } from "../../packages/ui/src/screens/session/SessionControls.js";
import { workspaceFixture, workspaceWorkflow } from "./support/workspace-fixture.js";
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
import { navFixture, meFixture } from "./support/fixtures.js";
afterEach(() => { vi.useRealTimers(); });
const retryCandidate = createCandidateManifest([{ repositoryId: "payments", commitSha: "c".repeat(40), treeSha: "d".repeat(40), baseCommitSha: "e".repeat(40) }]);
function setup(options: { tile?: ReturnType<typeof liveFixture>; path?: string; theme?: "light" | "dark"; pinReview?: boolean; send?: (request: ApiRequest) => Promise<ApiResponse>; screen?: boolean; liveRead?: (request: ApiRequest) => Promise<ApiResponse> } = {}) {
 let tiles = [options.tile ?? liveFixture()], status = 200, owner = false;
 const f = fakeHost(async request => {
 if (request.path === "/v1/app/me") return { status: 200, body: meFixture() };
 if (request.path.startsWith("/v1/app/live") && options.liveRead) return options.liveRead(request);
 if (request.path.startsWith("/v1/app/live")) return { status, body: status === 200 ? { tiles } : { error: { code: "FORBIDDEN", message: "Your access ended." } } };
 if (request.path.endsWith("/people")) return { status: 200, body: { people: { revision: 3, orphaned: true, canManage: false, canTakeOwnership: true, people: [{ personId: "22222222-2222-4222-8222-222222222222", name: "Ada", role: "owner", you: false, effectiveRole: "owner" }] } } };
 if (request.path === "/v1/app/nav") return { status: 200, body: navFixture() };
 if (request.path === "/v1/app/changes") return { status: 200, body: { notices: [], next: "settled" } };
 if (request.method === "GET" && request.path === "/v1/app/sessions/" + SESSION_FIXTURE_ID) return { status: 200, body: { session: sessionFixture({ revision: owner ? 2 : 1, you: { level: "edit", owner, following: options.tile?.following ?? false, actions: ["watch", "take_over", "stop", "retry"] } }) } };
 return options.send ? options.send(request) : { status: 200, body: { following: request.method === "POST" } };
 });
 const query = createQueryClient(), changed = vi.fn(async () => undefined);
 if (options.pinReview) query.setQueryData(["session", SESSION_FIXTURE_ID], workspaceFixture({}, { workflow: { ...workspaceWorkflow(), revision: 16, candidate: retryCandidate } }));
 const router = createMemoryRouter([{ path: "/app/live", element: options.pinReview ? h(SessionControls, { id: SESSION_FIXTURE_ID, agent: "Agent", actions: ["retry"], following: false, onChanged: changed }) : h(SessionTile, { tile: options.tile ?? liveFixture(), onChanged: changed }) }], { initialEntries: [options.path ?? "/app/live"] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Announcer, { children: h(RouterProvider, { router }) }) }) }), { theme: options.theme ?? "light" });
 return { ...f, ...ui, query, router, changed, answer(next: typeof tiles, nextStatus = 200) { tiles = next;status = nextStatus; }, owned() { owner = true; }, close() { ui.unmount();router.dispose();query.clear(); } };
}
it("shows only Arjun's permitted Follow, with status words and a stable session link", async () => {
 const f = setup();expect(screen.getByRole("button", { name: "Follow" })).toBeTruthy();expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();expect(screen.getByText("Running")).toBeTruthy();expect(screen.getByRole("link", { name: "Fix duplicate refunds" }).getAttribute("href")).toBe("/s/" + SESSION_FIXTURE_ID);await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Follow" }).disabled).toBe(false));fireEvent.click(screen.getByRole("button", { name: "Follow" }));await waitFor(() => expect(f.changed).toHaveBeenCalledTimes(1));expect(f.request.mock.calls.find(([r]) => r.method === "POST")?.[0]).toMatchObject({ method: "POST", path: "/v1/app/sessions/" + SESSION_FIXTURE_ID + "/follow" });f.close();
});
it("shows Max's permitted actions and confirms Stop before posting it", async () => {
 const f = setup({ tile: liveFixture({ actions: ["watch", "take_over", "stop", "retry"] }), send: async () => ({ status: 200, body: { session: sessionFixture() } }) });
 expect(screen.getByRole("button", { name: "Take over" })).toBeTruthy();expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Stop" }).disabled).toBe(false));fireEvent.click(screen.getByRole("button", { name: "Stop" }));expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(0);expect(await screen.findByRole("dialog", { name: "Stop this session?" })).toBeTruthy();expect(screen.getByText("Stopping now ends this task's machine. Changes that aren't pushed to GitHub or in a pull request are lost and can't be recovered.")).toBeTruthy();fireEvent.click(screen.getByRole("button", { name: "Stop and end the machine" }));await waitFor(() => expect(f.changed).toHaveBeenCalledTimes(1));expect(f.request.mock.calls.find(([r]) => r.method === "POST")?.[0]).toMatchObject({ method: "POST", path: "/v1/app/sessions/" + SESSION_FIXTURE_ID + "/stop" });f.close();
});
it("opens only a valid caller confirmation destination externally", () => {
 const url = "https://cell.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa", f = setup({ tile: liveFixture({ approvalUrl: url }) });fireEvent.click(screen.getByRole("button", { name: "Approve" }));expect(f.host.openExternal).toHaveBeenCalledWith(url);f.close();
 const unsafe = setup({ tile: liveFixture({ approvalUrl: "https://other.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa" }) });expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();unsafe.close();
});
it("keeps takeover pending until Check reads current ownership", async () => {
 const f = setup({ tile: liveFixture({ actions: ["take_over"] }), send: async () => ({ status: 202, body: { status: "NEEDS_CONFIRMATION", changes: [] } }) });
 const button = screen.getByRole<HTMLButtonElement>("button", { name: "Take over" });await waitFor(() => expect(button.disabled).toBe(false));fireEvent.click(button);
 const takeover = await screen.findByRole("dialog", { name: "Take over this task?" });await within(takeover).findByText("Ada · Owner");fireEvent.click(within(takeover).getByRole("button", { name: "Take over" }));
 await screen.findByText(/Ownership could not be checked/);expect(button.disabled).toBe(true);expect(f.host.openExternal).not.toHaveBeenCalled();
 f.owned();fireEvent.click(screen.getByRole("button", { name: "Check" }));await screen.findByText("Rovara now reads you as the owner.");f.close();
});

it("renders a plain-text peek, actual cost, people and offline location", () => {
 const f = setup({ tile: { ...liveFixture({ where: { kind: "mac", label: "Priya's MacBook", offline: true }, viewingNowCount: 7 }), peek: "\u001b[31mBuilding safely\u001b[0m" } });expect(screen.getByText("Building safely")).toBeTruthy();expect(f.container.textContent).not.toContain("[31m");expect(screen.getByText("Cost unavailable")).toBeTruthy();expect(f.container.textContent).not.toContain("$1.20");expect(screen.getByText("on Priya's MacBook")).toBeTruthy();expect(screen.getByText("offline")).toBeTruthy();expect(screen.getByText("+6")).toBeTruthy();f.close();
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
 await api.follow(SESSION_FIXTURE_ID);await api.unfollow(SESSION_FIXTURE_ID);await api.stop(SESSION_FIXTURE_ID);await api.retry(SESSION_FIXTURE_ID);await api.takeOver(SESSION_FIXTURE_ID, 3);
 expect(f.request.mock.calls.map(([request]) => [request.method, request.path.split("/").at(-1)])).toEqual([["POST", "follow"], ["DELETE", "follow"], ["POST", "stop"], ["POST", "retry"], ["POST", "take-over"]]);
 expect(f.request.mock.calls.at(-1)?.[0].body).toMatchObject({ expectedPeopleRevision: 3 });
 const writes = f.request.mock.calls.slice(2).map(([request]) => request.body as { requestId: string });expect(new Set(writes.map(body => body.requestId)).size).toBe(3);expect(writes.every(body => /^[0-9a-f-]{36}$/u.test(body.requestId))).toBe(true);await expect(async () => api.stop("../outside")).rejects.toThrow();expect(f.request).toHaveBeenCalledTimes(5);
});
for (const theme of ["light", "dark"] as const) it("has accessible permitted session controls in " + theme, async () => { const f = setup({ tile: liveFixture({ actions: ["watch", "take_over", "stop", "retry"] }), theme });await expectNoAxeViolations(f.container);f.close(); });

it("does not run a queued Live invalidation after its screen closes", async () => {
 vi.useFakeTimers();const query = createQueryClient(), invalidate = vi.spyOn(query, "invalidateQueries").mockResolvedValue(undefined), apply = createNoticeInvalidator(query);apply.notice({ type: "session.updated", sessionId: SESSION_FIXTURE_ID, revision: 1 });apply.stop();invalidate.mockClear();await vi.advanceTimersByTimeAsync(1000);apply.notice({ type: "home.changed", revision: 1 });expect(invalidate).not.toHaveBeenCalled();query.clear();
});
it("shows a refused Stop without claiming it stopped or closing the confirmation", async () => {
 const f = setup({ tile: liveFixture({ actions: ["stop"] }), send: async () => ({ status: 403, body: { error: { code: "FORBIDDEN", message: "You can no longer stop this session." } } }) });await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Stop" }).disabled).toBe(false));fireEvent.click(screen.getByRole("button", { name: "Stop" }));fireEvent.click(await screen.findByRole("button", { name: "Stop and end the machine" }));await screen.findByText("You can no longer stop this session.");expect(screen.getByRole("dialog", { name: "Stop this session?" })).toBeTruthy();expect(screen.queryByText("Stop requested.")).toBeNull();expect(f.changed).not.toHaveBeenCalled();f.close();
});
it("opens the current task review before Retry without posting from a Live tile", async () => {
 const returned = "ses_bbbbbbbbbbbbbbbbbbbb", send = vi.fn(async () => ({ status: 200, body: { session: sessionFixture({ sessionId: returned }) } }));
 const f = setup({ tile: liveFixture({ actions: ["retry"] }), send }), navigate = vi.spyOn(f.host, "navigate"), button = screen.getByRole("button", { name: "Retry" });await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));fireEvent.click(button);fireEvent.click(button);await waitFor(() => expect(navigate).toHaveBeenCalledWith("/s/" + SESSION_FIXTURE_ID));expect(send).not.toHaveBeenCalled();expect(f.changed).not.toHaveBeenCalled();f.close();
});
it("offers no action without a capability and uses DELETE for Following", async () => {
 const none = setup({ tile: liveFixture({ actions: [] }) });for (const name of ["Follow", "Take over", "Stop", "Retry"]) expect(screen.queryByRole("button", { name })).toBeNull();none.close();
 const f = setup({ tile: liveFixture({ following: true }) });await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Following" }).disabled).toBe(false));fireEvent.click(screen.getByRole("button", { name: "Following" }));await waitFor(() => expect(f.changed).toHaveBeenCalledTimes(1));expect(f.request.mock.calls.find(([r]) => r.method === "DELETE")?.[0]).toMatchObject({ method: "DELETE", path: "/v1/app/sessions/" + SESSION_FIXTURE_ID + "/follow" });f.close();
});

it("keeps takeover pending until a real read says the caller owns it", async () => {
 const f = setup({ tile: liveFixture({ actions: ["take_over"] }), send: async () => ({ status: 202, body: { status: "NEEDS_CONFIRMATION", code: "REAUTH_REQUIRED", confirmUrl: "https://cell.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa", changes: ["You will own this session."] } }) });
 await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Take over" }).disabled).toBe(false));fireEvent.click(screen.getByRole("button", { name: "Take over" }));const takeover = await screen.findByRole("dialog", { name: "Take over this task?" });await within(takeover).findByText("Ada · Owner");fireEvent.click(within(takeover).getByRole("button", { name: "Take over" }));await screen.findByText("Waiting for you to confirm in your browser");fireEvent.click(screen.getByRole("button", { name: "Open confirmation" }));expect(f.host.openExternal).toHaveBeenCalledTimes(1);expect(screen.queryByText("You now own this session.")).toBeNull();await act(() => f.query.setQueryData(["session", SESSION_FIXTURE_ID], sessionFixture({ revision: 2, you: { level: "edit", owner: true, following: false, actions: ["watch"] } })));expect(screen.queryByText("You now own this session.")).toBeNull();f.owned();await f.query.invalidateQueries({ queryKey: ["session", SESSION_FIXTURE_ID] });await screen.findByText("You now own this session.");f.close();
});

// Retry sends from its shown task review; the cold Live tile still only navigates.
it("retries once and opens the actual returned session rather than assuming the old id", async () => {
 const returned = "ses_bbbbbbbbbbbbbbbbbbbb", send = vi.fn(async () => ({ status: 200, body: { session: sessionFixture({ sessionId: returned }) } }));
 const f = setup({ tile: liveFixture({ actions: ["retry"] }), send, pinReview: true }), navigate = vi.spyOn(f.host, "navigate"), button = screen.getByRole("button", { name: "Retry" });await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));fireEvent.click(button);fireEvent.click(button);await waitFor(() => expect(navigate).toHaveBeenCalledWith("/s/" + returned));expect(send).toHaveBeenCalledTimes(1);expect(f.request.mock.calls.find(([r]) => r.method === "POST")?.[0].body).toMatchObject({ expectedRevision: 16, candidateDigest: retryCandidate.digest });expect(f.changed).toHaveBeenCalledTimes(1);f.close();
});
