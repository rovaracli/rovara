// @vitest-environment jsdom
import { expect, it } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { SessionControls } from "../../packages/ui/src/screens/session/SessionControls.js";
import { sessionScope } from "../../packages/ui/src/api/session-safety.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { fakeHost } from "./support/fake-host.js";
import { meFixture } from "./support/fixtures.js";
import { workspaceFixture } from "./support/workspace-fixture.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

const base = workspaceFixture(), me = meFixture(), identity = { companyId: me.org.orgId, personId: me.developer.id };
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); }); };
function setup() {
 let moved = false, refused = false;
 const session = () => ({ ...base, revision: moved ? 2 : 1, status: moved ? "failed" : "running", you: { ...base.you, actions: moved ? ["stop", "close"] : ["retry", "stop", "close"] } });
 const f = fakeHost(async r => r.path === "/v1/app/me" ? { status: 200, body: me } : r.method === "GET" ? refused ? { status: 403, body: { error: { code: "TASK_ACCESS_DENIED", message: "Task unavailable" } } } : { status: 200, body: { session: session() } } : { status: 503, body: { error: { code: "UPSTREAM", message: "Result unknown" } } });
 const original = { requestId: "11111111-1111-4111-8111-111111111111", action: "retry", body: { requestId: "11111111-1111-4111-8111-111111111111" }, startedAt: Date.now() - 1000, fence: 0 };
 const source = sessionScope(identity, base.sessionId) + ":request";
 f.storage.set(source, JSON.stringify(original));
 const query = createQueryClient(), mount = () => renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(SessionControls, { id: base.sessionId, agent: "Agent", actions: ["retry", "stop", "close"], following: false, onChanged: async () => undefined }) }) }));
 return { ...f, query, mount, original, source, move: () => { moved = true; }, refuse: () => { refused = true; }, writes: () => f.request.mock.calls.filter(([r]) => r.method !== "GET") };
}
const controls = () => ({ stop: screen.getByRole<HTMLButtonElement>("button", { name: "Stop" }).disabled, close: screen.getByRole<HTMLButtonElement>("button", { name: "Close task" }).disabled });
function expectRetained(f: ReturnType<typeof setup>) {
 expect([...f.storage.entries()].filter(([key, raw]) => key.endsWith(":request") && JSON.stringify(JSON.parse(raw)) === JSON.stringify(f.original))).toHaveLength(1);
 expect(screen.getByRole<HTMLButtonElement>("button", { name: "Retry", hidden: true }).disabled).toBe(true);
}
for (const checked of [false, true]) it(`R4-2: previous-version Retry does not hold Stop/Close ${checked ? "after a changed read-only Check" : "on arrival"} or after remount`, async () => {
 const f = setup();let ui = f.mount();
 try {
  await screen.findByRole("button", { name: "Check" });await settle();
  if (checked) { f.move();fireEvent.click(screen.getByRole("button", { name: "Check" }));await settle(); }
  expect(controls()).toEqual({ stop: false, close: false });expectRetained(f);expect(f.writes()).toHaveLength(0);
  ui.unmount();f.query.clear();ui = f.mount();await screen.findByRole("button", { name: "Check" });await settle();
  expect(controls()).toEqual({ stop: false, close: false });expectRetained(f);
  for (let i = 0; i < 2; i++) { fireEvent.click(screen.getByRole("button", { name: "Check" }));await settle(); }
  expect(controls()).toEqual({ stop: false, close: false });expectRetained(f);expect(f.writes()).toHaveLength(0);
  expect(screen.queryByText(/Rovara now reads this session as/)).toBeNull();
 } finally { ui.unmount();f.query.clear(); }
});
for (const action of ["stop", "close"] as const) it(`R4-2: a retained legacy Retry allows an independently claimed ${action} without resending Retry`, async () => {
 const f = setup(), ui = f.mount();
 try {
  await screen.findByRole("button", { name: "Check" });await settle();expect(controls()).toEqual({ stop: false, close: false });
  fireEvent.click(screen.getByRole("button", { name: action === "stop" ? "Stop" : "Close task" }));
  const dialog = await screen.findByRole("dialog");fireEvent.click(within(dialog).getByRole("button", { name: action === "stop" ? "Stop session" : "Close task" }));
  await waitFor(() => expect(f.writes()).toHaveLength(1));expect(f.writes()[0]![0].path).toMatch(new RegExp("/" + action + "$"));expectRetained(f);
 } finally { ui.unmount();f.query.clear(); }
});
it("R4-2/R1: a refused Check retains the old Retry and removes authority without sending", async () => {
 const f = setup(), ui = f.mount();
 try {
  await screen.findByRole("button", { name: "Check" });await settle();expect(controls()).toEqual({ stop: false, close: false });f.refuse();
  fireEvent.click(screen.getByRole("button", { name: "Check" }));await settle();expect(controls()).toEqual({ stop: true, close: true });expectRetained(f);expect(f.writes()).toHaveLength(0);
 } finally { ui.unmount();f.query.clear(); }
});

it("R4-2/R6d: failed migration storage retains the original lock; Check retries only the local move after storage recovers", async () => {
 const f = setup(), write = f.host.storage.set.bind(f.host.storage), target = sessionScope(identity, "retry-legacy:" + base.sessionId) + ":request";
 let broken = true;
 f.host.storage.set = (key, raw) => { if (broken && key === target) throw new Error("storage unavailable");write(key, raw); };
 const ui = f.mount();
 try {
  await screen.findByText("The previous Retry could not be retained safely. Check this task before acting again.");
  expect(controls()).toEqual({ stop: true, close: true });expect(f.storage.get(f.source)).toBe(JSON.stringify(f.original));expect(f.storage.has(target)).toBe(false);expect(f.writes()).toHaveLength(0);
  broken = false;fireEvent.click(screen.getByRole("button", { name: "Check" }));
  await waitFor(() => expect(controls()).toEqual({ stop: false, close: false }));expectRetained(f);expect(f.writes()).toHaveLength(0);
  expect(screen.queryByText("The previous Retry could not be retained safely. Check this task before acting again.")).toBeNull();
 } finally { ui.unmount();f.query.clear(); }
});
it("R4-2: migration preserves a separate modern Retry too, and resolving it cannot unlock the unresolved legacy Retry", async () => {
 const f = setup(), target = sessionScope(identity, "retry:" + base.sessionId) + ":request";
 const modern = { ...f.original, requestId: "22222222-2222-4222-8222-222222222222", body: { requestId: "22222222-2222-4222-8222-222222222222", priorRevision: 1, priorStatus: "running" } };
 f.storage.set(target, JSON.stringify(modern));const ui = f.mount();
 try {
  await screen.findByRole("button", { name: "Check" });await settle();expect(controls()).toEqual({ stop: false, close: false });expectRetained(f);expect(f.storage.get(target)).toBe(JSON.stringify(modern));
  f.move();fireEvent.click(screen.getByRole("button", { name: "Check" }));await settle();
  expect(JSON.parse(f.storage.get(target)!)).toBeNull();expectRetained(f);expect(controls()).toEqual({ stop: false, close: false });expect(f.writes()).toHaveLength(0);
 } finally { ui.unmount();f.query.clear(); }
});
