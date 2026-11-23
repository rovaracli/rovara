// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppHostProvider, type ApiResponse } from "../../packages/ui/src/host.js";
import { SessionControls } from "../../packages/ui/src/screens/session/SessionControls.js";
import { TaskPageBoundary } from "../../packages/ui/src/screens/session/task-page-policy.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { sessionScope, type FrozenSessionRequest } from "../../packages/ui/src/api/session-safety.js";
import { fakeHost } from "./support/fake-host.js";
import { meFixture } from "./support/fixtures.js";
import { sessionFixture, SESSION_FIXTURE_ID } from "./support/session-fixture.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
const confirmUrl = "https://cell.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa";
const people = { people: { revision: 3, orphaned: true, canManage: false, canTakeOwnership: true, people: [{ personId: "22222222-2222-4222-8222-222222222222", name: "Ada", role: "owner", you: false, effectiveRole: "owner" }] } };
function setup(reply: () => Promise<ApiResponse>, legacy = false) {
 const base = sessionFixture();let session = sessionFixture({ you: { ...base.you, owner: false, actions: ["take_over", "stop"] } });
 let readStatus = 200;
 const f = fakeHost(async r => r.path === "/v1/app/me" ? { status: 200, body: meFixture() } : r.path.endsWith("/people") ? { status: 200, body: people } : r.method === "GET" ? readStatus === 200 ? { status: 200, body: { session } } : { status: readStatus, body: { error: { code: "TEMPORARY", message: "Read unavailable" } } } : r.path.endsWith("/take-over") ? reply() : { status: 200, body: { session } });
 let query = createQueryClient(), host = f.host;
 const me = meFixture(), scope = sessionScope({ companyId: me.org.orgId, personId: me.developer.id }, "take_over:" + SESSION_FIXTURE_ID);
 if (legacy) f.host.storage.set(sessionScope({ companyId: me.org.orgId, personId: me.developer.id }, SESSION_FIXTURE_ID) + ":request", JSON.stringify({ requestId: "original-take-over", action: "take_over", body: { requestId: "original-take-over", expectedPeopleRevision: 3 }, startedAt: Date.now(), fence: 0 }));
 const controls = () => h(SessionControls, { id: SESSION_FIXTURE_ID, agent: "Agent", actions: session.you.actions, following: false, onChanged: async () => undefined });
 const tree = (page: boolean) => h(AppHostProvider, { host, children: h(QueryClientProvider, { client: query, children: page ? h(TaskPageBoundary, { children: controls() }) : controls() }) });
 let ui = renderUi(tree(false));
 return { ...f, get host() { return host; }, scope, failReads() { readStatus = 503; }, recoverReads() { readStatus = 200; }, setOwner() { session = { ...session, you: { ...session.you, owner: true } }; }, async propose() {
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Take over" }).disabled).toBe(false));fireEvent.click(screen.getByRole("button", { name: "Take over" }));
  const dialog = await screen.findByRole("dialog");await within(dialog).findByText("Ada · Owner");fireEvent.click(within(dialog).getByRole("button", { name: "Take over" }));
 }, remount(page: boolean) { ui.unmount();ui = renderUi(tree(page)); }, reload(page: boolean) { ui.unmount();query.clear();query = createQueryClient();host = { ...host };ui = renderUi(tree(page)); }, close() { ui.unmount();query.clear(); } };
}
it("keeps Stop enabled during the take-over send and after pending confirmation, including task-page remount", async () => {
 let finish!: (response: ApiResponse) => void;
 const f = setup(() => new Promise(resolve => { finish = resolve; }));await f.propose();
 await waitFor(() => expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(1));
 const stopDisabledWhileSending = screen.getByRole<HTMLButtonElement>("button", { name: "Stop", hidden: true }).disabled;
 await act(async () => { finish({ status: 202, body: { status: "NEEDS_CONFIRMATION", confirmUrl, changes: [] } }); });
 await screen.findByText(/Ownership could not be checked/);
 expect(stopDisabledWhileSending).toBe(false);
 expect(screen.getByRole("button", { name: "Open confirmation" })).toBeTruthy();
 expect(screen.getByRole<HTMLButtonElement>("button", { name: "Stop" }).disabled).toBe(false);
 expect(JSON.parse(f.host.storage.get(f.scope + ":request")!)).toMatchObject({ action: "take_over", body: { expectedPeopleRevision: 3 } });
 f.remount(true);
 await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Stop" }).disabled).toBe(false));
 fireEvent.click(screen.getByRole("button", { name: "Check" }));await screen.findByText("Rovara still hasn't confirmed this. Check again before trying another action.");
 expect(screen.getByRole<HTMLButtonElement>("button", { name: "Stop" }).disabled).toBe(false);
 fireEvent.click(screen.getByRole("button", { name: "Stop" }));fireEvent.click(await screen.findByRole("button", { name: "Stop this task" }));
 await waitFor(() => expect(f.request.mock.calls.filter(([r]) => r.path.endsWith("/stop"))).toHaveLength(1));
 expect(f.request.mock.calls.filter(([r]) => r.path.endsWith("/take-over"))).toHaveLength(1);
 expect(JSON.parse(f.host.storage.get(f.scope + ":request")!)).toMatchObject({ action: "take_over" });f.close();
});
for (const url of ["https://other.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa", "javascript:alert(1)"]) it("retains unknown take-over without opening an unsafe confirmation: " + url, async () => {
 const f = setup(async () => ({ status: 202, body: { status: "NEEDS_CONFIRMATION", confirmUrl: url, changes: [] } }));await f.propose();
 await screen.findByText(/Ownership could not be checked/);expect(screen.queryByRole("button", { name: "Open confirmation" })).toBeNull();expect(f.host.openExternal).not.toHaveBeenCalled();
 expect(screen.getByRole<HTMLButtonElement>("button", { name: "Take over" }).disabled).toBe(true);expect(screen.getByRole<HTMLButtonElement>("button", { name: "Stop" }).disabled).toBe(false);f.close();
});
it("announces a committed take-over from the returned session", async () => {
 const base = sessionFixture(), f = setup(async () => ({ status: 200, body: { session: sessionFixture({ you: { ...base.you, owner: true } }) } }));await f.propose();
 await screen.findByText("You now own this session.");expect(screen.queryByRole("dialog")).toBeNull();expect(screen.queryByRole("button", { name: "Open confirmation" })).toBeNull();f.close();
});

it("keeps an outcome-shaped 202 take-over unknown and isolated from Stop", async () => {
 const f = setup(async () => ({ status: 202, body: { session: sessionFixture() } }));await f.propose();await screen.findByText(/Ownership could not be checked/);
 expect(screen.queryByText("You now own this session.")).toBeNull();expect(screen.getByRole<HTMLButtonElement>("button", { name: "Take over" }).disabled).toBe(true);
 expect(screen.getByRole<HTMLButtonElement>("button", { name: "Stop" }).disabled).toBe(false);expect(JSON.parse(f.host.storage.get(f.scope + ":request")!)).toMatchObject({ action: "take_over" });f.close();
});

it("isolates a take-over saved by the previous version without losing or replaying it", async () => {
 const f = setup(async () => { throw new Error("Take-over must not be replayed"); }, true);
 await screen.findByText(/Ownership could not be checked/);
 await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Stop" }).disabled).toBe(false));
 expect(screen.getByRole<HTMLButtonElement>("button", { name: "Take over" }).disabled).toBe(true);
 f.remount(true);await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Stop" }).disabled).toBe(false));
 fireEvent.click(screen.getByRole("button", { name: "Check" }));await screen.findByText("Rovara still hasn't confirmed this. Check again before trying another action.");
 expect(screen.getByRole<HTMLButtonElement>("button", { name: "Stop" }).disabled).toBe(false);expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(0);
 expect([...f.storage.values()].filter(value => value.includes('"original-take-over"') && value.includes('"take_over"'))).toHaveLength(1);f.close();
});

it("does not claim ownership when a final receipt still reads the caller as a non-owner", async () => {
 const base = sessionFixture(), f = setup(async () => ({ status: 200, body: { session: sessionFixture({ you: { ...base.you, owner: false } }) } }));await f.propose();
 await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());expect(screen.queryByText("You now own this session.")).toBeNull();f.close();
});

// R9-1: dropping the persisted destination must fail both arrivals; a new host
// and query client on reload discard all component/query/WeakMap state.
for (const arrival of ["remount", "reload"] as const) {
 it("retains the exact take-over confirmation after " + arrival + " and read-only Check", async () => {
  const f = setup(async () => ({ status: 202, body: { status: "NEEDS_CONFIRMATION", confirmUrl, changes: [] } }));
  try {
   await f.propose();await screen.findByRole("button", { name: "Open confirmation" });
   const original = JSON.parse(f.host.storage.get(f.scope + ":request")!) as FrozenSessionRequest;
   f[arrival](false);
   await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Stop" }).disabled).toBe(false));
   fireEvent.click(screen.getByRole("button", { name: "Check" }));await screen.findByText("Rovara still hasn't confirmed this. Check again before trying another action.");
   expect(screen.getByRole<HTMLButtonElement>("button", { name: "Take over" }).disabled).toBe(true);
   fireEvent.click(screen.getByRole("button", { name: "Open confirmation" }));
   expect(f.host.openExternal).toHaveBeenCalledExactlyOnceWith(confirmUrl);
   expect(JSON.parse(f.host.storage.get(f.scope + ":request")!)).toMatchObject({ requestId: original.requestId, body: original.body, startedAt: original.startedAt });
   expect(f.request.mock.calls.filter(([r]) => r.path.endsWith("/take-over"))).toHaveLength(1);
   // A served owner read, unlike unchanged ownership, resolves the proposal.
   f.setOwner();fireEvent.click(screen.getByRole("button", { name: "Check" }));
   await screen.findByText("Rovara now reads you as the owner.");
   expect(f.host.storage.get(f.scope + ":request")).toBe("null");
   expect(screen.queryByRole("button", { name: "Open confirmation" })).toBeNull();
   expect(f.request.mock.calls.filter(([r]) => r.path.endsWith("/take-over"))).toHaveLength(1);
  } finally { f.close(); }
 });
 it("offers the held task exit after three unknown checks across " + arrival, async () => {
  const f = setup(async () => ({ status: 202, body: { status: "NEEDS_CONFIRMATION", confirmUrl, changes: [] } }));
  try {
   await f.propose();await screen.findByRole("button", { name: "Open confirmation" });
   for (let count = 0; count < 2; count++) {
    fireEvent.click(screen.getByRole("button", { name: "Check" }));await screen.findByText("Rovara still hasn't confirmed this. Check again before trying another action.");
    expect(screen.queryByRole("link", { name: "Open the task to check" })).toBeNull();
   }
   f[arrival](true);await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Stop" }).disabled).toBe(false));
   fireEvent.click(screen.getByRole("button", { name: "Check" }));
   const link = await screen.findByRole("link", { name: "Open the task to check" });
   expect(link.getAttribute("href")).toBe("/s/" + SESSION_FIXTURE_ID);
   expect(screen.getByText(/We couldn't confirm this/)).toBeTruthy();
   expect(screen.getByRole<HTMLButtonElement>("button", { name: "Take over" }).disabled).toBe(true);
   expect(screen.getByRole<HTMLButtonElement>("button", { name: "Stop" }).disabled).toBe(false);
   expect(JSON.parse(f.host.storage.get(f.scope + ":request")!)).toMatchObject({ action: "take_over" });
   expect(f.request.mock.calls.filter(([r]) => r.path.endsWith("/take-over"))).toHaveLength(1);
   // The exit must remain visible on another arrival, without clearing storage.
   f[arrival](true);await screen.findByRole("link", { name: "Open the task to check" });
  } finally { f.close(); }
 });
 it("offers the ten-minute held exit after " + arrival + " without another check", async () => {
  const f = setup(async () => ({ status: 202, body: { status: "NEEDS_CONFIRMATION", confirmUrl, changes: [] } }));
  try {
   await f.propose();await screen.findByRole("button", { name: "Open confirmation" });
   vi.useFakeTimers();vi.setSystemTime((JSON.parse(f.host.storage.get(f.scope + ":request")!) as FrozenSessionRequest).startedAt);
   await act(async () => { f[arrival](true); });
   await act(async () => { await vi.advanceTimersByTimeAsync(599_999); });
   expect(screen.queryByRole("link", { name: "Open the task to check" })).toBeNull();
   await act(async () => { await vi.advanceTimersByTimeAsync(1); });
   expect(screen.getByRole("link", { name: "Open the task to check" }).getAttribute("href")).toBe("/s/" + SESSION_FIXTURE_ID);
   expect(screen.getByRole<HTMLButtonElement>("button", { name: "Take over" }).disabled).toBe(true);
   expect(screen.getByRole<HTMLButtonElement>("button", { name: "Stop" }).disabled).toBe(false);
   expect(JSON.parse(f.host.storage.get(f.scope + ":request")!)).toMatchObject({ action: "take_over" });
   expect(f.request.mock.calls.filter(([r]) => r.path.endsWith("/take-over"))).toHaveLength(1);
  } finally { vi.useRealTimers();f.close(); }
 });
}

it("counts failed checks toward the held exit and resolves only after a successful owner read", async () => {
 const f = setup(async () => ({ status: 202, body: { status: "NEEDS_CONFIRMATION", confirmUrl, changes: [] } }));
 try {
  await f.propose();await screen.findByRole("button", { name: "Open confirmation" });f.reload(false);
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Stop" }).disabled).toBe(false));
  f.failReads();
  for (let count = 0; count < 3; count++) {
   fireEvent.click(screen.getByRole("button", { name: "Check" }));await screen.findByText("Couldn't check this session. The previous request is still unconfirmed.");
  }
  await screen.findByRole("link", { name: "Open the task to check" });
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Take over" }).disabled).toBe(true);
  expect(JSON.parse(f.host.storage.get(f.scope + ":request")!)).toMatchObject({ action: "take_over" });
  f.recoverReads();f.setOwner();fireEvent.click(screen.getByRole("button", { name: "Check" }));
  await screen.findByText("Rovara now reads you as the owner.");expect(screen.queryByRole("link", { name: "Open the task to check" })).toBeNull();
  expect(f.request.mock.calls.filter(([r]) => r.path.endsWith("/take-over"))).toHaveLength(1);
 } finally { f.close(); }
});
it("offers the held exit for an older proposal with no retained destination after reload", async () => {
 const f = setup(async () => ({ status: 503, body: { error: { code: "TEMPORARY", message: "Outcome unknown" } } }));
 try {
  await f.propose();await screen.findByText(/Ownership could not be checked/);
  const pending = JSON.parse(f.host.storage.get(f.scope + ":request")!) as FrozenSessionRequest;
  vi.useFakeTimers();vi.setSystemTime(pending.startedAt + 600_001);
  await act(async () => { f.reload(true); });
  expect(screen.getByRole("link", { name: "Open the task to check" }).getAttribute("href")).toBe("/s/" + SESSION_FIXTURE_ID);
  expect(screen.queryByRole("button", { name: "Open confirmation" })).toBeNull();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Stop" }).disabled).toBe(false);
  expect(JSON.parse(f.host.storage.get(f.scope + ":request")!)).toMatchObject({ requestId: pending.requestId, body: pending.body });
  expect(f.request.mock.calls.filter(([r]) => r.path.endsWith("/take-over"))).toHaveLength(1);
 } finally { vi.useRealTimers();f.close(); }
});
