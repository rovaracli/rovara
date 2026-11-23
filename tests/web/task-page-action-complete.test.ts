// @vitest-environment jsdom
import { expect, it } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppHostProvider, type ApiResponse } from "../../packages/ui/src/host.js";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { fakeHost, CLOSE_PREVIEW_NOT_SERVED } from "./support/fake-host.js";
import { meFixture, navFixture } from "./support/fixtures.js";
import { workspaceFixture, workspaceWorkflow } from "./support/workspace-fixture.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

const operationId: unknown = expect.any(String);
const TASK = "11111111-1111-4111-8111-111111111111", SESSION = "ses_aaaaaaaaaaaaaaaaaaaa", READER = "d".repeat(64);
const SESSION_PATH = "/v1/app/sessions/" + SESSION, PEOPLE = SESSION_PATH + "/people";
const unpublished = [{ repository: "acme/payments", reasons: ["worktree_changes"] }];
const people = { revision: 3, orphaned: false, canManage: true, canTakeOwnership: true, people: [] };
const failure = (status = 403): ApiResponse => ({ status, body: { error: { code: status === 503 ? "RUNTIME_UNAVAILABLE" : "FORBIDDEN", message: "Current read refused" } } });
type Action = "Close task" | "Discard it and close" | "Share" | "Take over" | "Remove Dan" | "Continue in my tool" | "Design first" | "Skip design review";
function mount(live = false, peopleServed = true) {
 const base = workspaceFixture();
 let session = workspaceFixture({ status: "running", you: { ...base.you, actions: ["watch", "stop", "close", "share", "take_over", "retry", "make_agent", "comment", "steer"] } }, { workflow: { ...workspaceWorkflow(), stage: "IMPLEMENT", state: "RUNNING", revision: 16 }, unpublished, designActions: { designFirst: true, skip: { allowed: true } } });
 let changed: "none" | "refused" | "stale" | "permission" | "revision-only" | "closed-only" | "offer-only" = "none", closeCount = 0;
 const current = () => changed === "permission" ? { ...session, you: { ...session.you, actions: [] }, body: session.body.kind === "task" ? { kind: "task", task: { ...session.body.task, status: "CLOSED", designActions: { designFirst: false, skip: { allowed: false, because: "skip_off" } } } } : session.body } : changed !== "none" && session.body.kind === "task" ? { ...session, body: { kind: "task", task: { ...session.body.task,
  ...(changed === "revision-only" ? { workflow: { ...session.body.task.workflow!, revision: 17 } } : {}),
  ...(changed === "closed-only" ? { status: "CLOSED" } : {}),
  ...(changed === "offer-only" ? { designActions: { designFirst: false, skip: { allowed: false, because: "skip_off" } } } : {}),
 } } } : session;
 const f = fakeHost(async r => {
  const path = r.path.split("?")[0]!;
  if (path === "/v1/app/me") return { status: 200, body: meFixture() };
  if (path === "/v1/app/nav") return { status: 200, body: navFixture() };
  if (path.endsWith("/presence")) return { status: 200, body: { viewingNow: [] } };
  // Legacy Close and Discard are proved here, so Code serves no Close preview route (the dialog uses the legacy close only on this answer).
  if (r.method === "GET" && path.endsWith("/close")) return CLOSE_PREVIEW_NOT_SERVED;
  if (r.method !== "GET") {
   if (path.endsWith("/close")) {
    closeCount++;
    if (closeCount === 1) return { status: 200, body: { session, closed: false, unpublished } };
   }
   // Unknown outcomes keep every tested one-shot locked. Close's first readable
   // response is the legacy retained-work refusal, not a discard authorization.
   return { status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "Unconfirmed" } } };
  }
  if (path === SESSION_PATH) return changed === "refused" ? failure() : changed === "stale" ? failure(503) : { status: 200, body: { session: current() } };
  if (path === "/v1/app/sessions") return changed === "refused" ? failure() : changed === "stale" ? failure(503) : { status: 200, body: { tasks: [{ ...(session.body.kind === "task" ? session.body.task : {}), ...(changed === "permission" ? { status: "CLOSED" } : {}), sessionId: SESSION }] } };
  if (path === "/v1/app/decisions") return { status: 200, body: { cards: [] } };
  if (path === PEOPLE) return !peopleServed ? failure(404) : changed === "refused" ? failure() : changed === "stale" ? failure(503) : { status: 200, body: { people: { ...people, ...(changed === "permission" ? { canManage: false, canTakeOwnership: false, revision: 4 } : {}) }, sharedWith: [{ developerId: READER, name: "Dan", role: "viewer" }] } };
  if (path.endsWith("/candidates")) return { status: 200, body: { candidates: [{ developerId: READER, name: "Eve" }], complete: true } };
  if (path.endsWith("/shares")) return { status: 200, body: { shares: [] } };
  if (path.endsWith("/members")) return { status: 200, body: { members: [{ developerId: READER, name: "Dan", role: "member" }] } };
  if (path.endsWith("/messages")) return { status: 200, body: { messages: [], hasMore: false } };
  if (path.endsWith("/events")) return { status: 200, body: { events: [] } };
  return failure(404);
 });
 // Use the real lazy leaves: changing a production route must break parity.
 const routes = appRoutes(navFixture().features), app = routes.find(route => route.path === "/app")!;
 const leaf = live ? routes.find(route => route.path === "/s/:id")!.children![0]! : app.children!.find(route => route.path === "sessions/:id")!;
 const query = createQueryClient(), router = createMemoryRouter([{ path: live ? "/s/:id" : "/app/sessions/:id", lazy: leaf.lazy! }], { initialEntries: [(live ? "/s/" : "/app/sessions/") + SESSION] });
 const tree = () => h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(RouterProvider, { router }) }) });
 const ui = renderUi(tree());
 const writes = () => f.request.mock.calls.map(([r]) => r).filter(r => r.method !== "GET" && !r.path.endsWith("/presence"));
 return { f, query, ui, tree, writes, change(value: typeof changed) { changed = value; }, growWork() { if (session.body.kind !== "task") throw new Error("Task fixture required");session = { ...session, body: { kind: "task", task: { ...session.body.task, unpublished: [...unpublished, { repository: "acme/ledger", reasons: ["unpushed_commits"] }] } } }; }, close() { ui.unmount();router.dispose();query.clear(); } };
}
async function enabled(name: string, root: Pick<typeof screen, "findByRole"> = screen) {
 const button = await root.findByRole<HTMLButtonElement>("button", { name });
 await waitFor(() => expect(button.disabled).toBe(false));return button;
}
async function prepare(action: Action) {
 await screen.findByTestId("task-page", {}, { timeout: 6000 });
 if (action === "Remove Dan") {
  await act(async () => { const panel = screen.getByTestId<HTMLDetailsElement>("people-panel");panel.closest<HTMLDetailsElement>(".rv-task-section")?.setAttribute("open", "");panel.open = true;panel.dispatchEvent(new Event("toggle")); });
  return enabled(action);
 }
 if (action === "Close task" || action === "Discard it and close") {
  fireEvent.click(await enabled("Close task"));
  if (action === "Discard it and close") {
   fireEvent.click(await enabled("Close and delete the machine", within(await screen.findByRole("dialog"))));
   return enabled(action, within(await screen.findByRole("dialog")));
  }
  return enabled("Close and delete the machine", within(await screen.findByRole("dialog")));
 }
 if (action === "Take over") {
  fireEvent.click(await enabled(action));return enabled(action, within(await screen.findByRole("dialog")));
 }
 if (action === "Share") {
  fireEvent.click(await enabled("Share"));fireEvent.click(await enabled("Dan"));return enabled("Add share");
 }
 if (action === "Skip design review") {
  fireEvent.click(await enabled(action));return enabled(action, within(await screen.findByRole("group", { name: "Confirm skipping design review" })));
 }
 return enabled(action);
}
const ACTIONS: readonly Action[] = ["Close task", "Discard it and close", "Share", "Take over", "Remove Dan", "Continue in my tool", "Design first", "Skip design review"];
const paths: Record<Action, string> = {
 "Close task": SESSION_PATH + "/close", "Discard it and close": SESSION_PATH + "/close", Share: SESSION_PATH + "/shares", "Take over": SESSION_PATH + "/take-over", "Remove Dan": SESSION_PATH + "/shares/MEMBER%23" + READER,
 "Continue in my tool": "/v1/app/tasks/" + TASK + "/continue/publish-branch", "Design first": "/v1/app/tasks/" + TASK + "/design-review/first", "Skip design review": "/v1/app/tasks/" + TASK + "/design-review/skip",
};
// PARITY.md: every listed action is offered by cloud/next; Discard requires
// the retained-work answer. These catch wrong target/operation, a second send, or a bypass
// of the same production handler's current-read refusal.
it.each(ACTIONS)("DEC367 %s: one exact send; repeated clicks cannot duplicate an unknown outcome", async action => {
 const s = mount(false, action !== "Share");try {
  const button = await prepare(action), prior = s.writes().length;
  fireEvent.click(button);fireEvent.click(button);
  await waitFor(() => expect(s.writes()).toHaveLength(prior + 1));
  const sent = s.writes()[prior]!;
  expect(sent.path).toBe(paths[action]);expect(sent.method).toBe(action === "Share" ? "PUT" : action === "Remove Dan" ? "DELETE" : "POST");
  if (action !== "Remove Dan") expect(sent.body).toMatchObject({ requestId: operationId });
  if (action === "Discard it and close") expect(sent.body).toEqual({ requestId: operationId, discardUnpublished: true });
  if (action === "Close task") expect(sent.body).toEqual({ requestId: operationId });
  if (action === "Share") expect(sent.body).toMatchObject({ principal: { kind: "member", developerId: READER }, level: "view" });
  if (action === "Take over") expect(sent.body).toEqual({ requestId: operationId, expectedPeopleRevision: 3 });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  if (action !== "Close task") { fireEvent.click(button);expect(s.writes()).toHaveLength(prior + 1); }
 } finally { s.close(); }
});
for (const action of ACTIONS) it.each(["refused", "stale", "permission"] as const)(`DEC367 ${action}: %s at send time makes ZERO sends`, async change => {
 const s = mount(false, action !== "Share");try {
  const button = await prepare(action), prior = s.writes().length;s.change(change);fireEvent.click(button);
  await screen.findAllByRole("alert");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(s.writes()).toHaveLength(prior);
 } finally { s.close(); }
});
// Each fixture changes exactly one conjunct of DesignActions' send-time fence.
// Do not use the broad permission fixture here: the other guards must stay satisfied.
for (const action of ["Design first", "Skip design review"] as const) {
 it.each(["revision-only", "closed-only", "offer-only"] as const)(`Opus P2-2 ${action}: %s alone makes ZERO sends`, async change => {
  const s = mount();try {
   const button = await prepare(action);
   s.change(change);fireEvent.click(button);
   const refusal = await screen.findByText("Design actions changed. Check the current task before trying again.");
   expect(refusal.getAttribute("role")).toBe("alert");
   expect(s.writes()).toHaveLength(0);
  } finally { s.close(); }
 });
 it(`Opus P2-2 ${action}: matching revision, open task and offered action send exactly once`, async () => {
  const s = mount();try {
   fireEvent.click(await prepare(action));
   await waitFor(() => expect(s.writes()).toHaveLength(1));
   expect(s.writes()[0]).toMatchObject({ method: "POST", path: paths[action], body: { requestId: operationId } });
   await screen.findAllByRole("alert");
   expect(s.writes()).toHaveLength(1);
  } finally { s.close(); }
 });
}
it("DEC367 retained workspace: changed unpublished list refuses discard with ZERO further sends", async () => {
 const s = mount();try {
  const button = await prepare("Discard it and close");expect(s.writes()).toHaveLength(1);s.growWork();fireEvent.click(button);
  expect((await screen.findByRole("alert")).textContent).toContain("unpublished work changed");expect(s.writes()).toHaveLength(1);
 } finally { s.close(); }
});
it("DEC367 Share uses the same People add-viewer path when the list is served", async () => {
 const s = mount();try {
  fireEvent.click(await enabled("Share"));
  expect((await screen.findByTestId<HTMLDetailsElement>("people-panel")).open).toBe(true);
  expect((await screen.findByRole<HTMLSelectElement>("combobox", { name: "Add as" })).value).toBe("viewer");expect(s.writes()).toHaveLength(0);
 } finally { s.close(); }
});
// Real-route action inventory: its SessionControls, task continuation,
// DesignActions and PeoplePanel must remain executable through the same APIs.
// The response is deliberately unknown so these checks also catch auto-retries.
it.each(ACTIONS)("LIVE-ROUTE PARITY %s: both real routes invoke the same guarded route and payload", async action => {
 const sent: unknown[] = [];
 for (const live of [true, false]) {
  const s = mount(live, action !== "Share");try {
   const button = await prepare(action), prior = s.writes().length;fireEvent.click(button);
   await waitFor(() => expect(s.writes()).toHaveLength(prior + 1));
   const request = s.writes()[prior]!, body = request.body as Record<string, unknown> | undefined;
   sent.push({ method: request.method, path: request.path, body: body === undefined ? undefined : { ...body, requestId: "operation-id" } });
  } finally { s.close(); }
 }
 expect(sent[1]).toEqual(sent[0]);
});
it("LIVE-ROUTE PARITY enumerates all offered controls from the live components", async () => {
 const inventories: string[][] = [];
 for (const live of [true, false]) {
  const s = mount(live);try {
   await screen.findByTestId("task-page");await enabled("Follow");
   await prepare("Remove Dan");
   const roots = [".rv-session-controls", ".rv-task-actions", ".rv-design-actions", "[data-testid=people-panel]"];
   inventories.push(roots.flatMap(selector => Array.from(document.querySelectorAll(selector + " button, " + selector + " select")).map(element => element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "")).filter(name => name !== "Check").concat(["Stop"]).sort());
   // Conversation is the existing Composer / Conversation pair on both pages;
   // the rebuilt 4e trigger uses the approved name.
   expect(await screen.findByRole("button", { name: "Talk to this session" })).toBeTruthy();
   expect(screen.getByRole("button", { name: "Stop work" })).toBeTruthy();
   // STOP-WARNING-HOTFIX: the page that offers Stop on a running step never claims the files are kept.
   expect(screen.getByText("Stopping a running step ends this task's machine. Changes that aren't pushed to GitHub or in a pull request are lost.")).toBeTruthy();expect(document.body.textContent).not.toContain("Files are kept");
  } finally { s.close(); }
 }
 expect(inventories[0]).toEqual(expect.arrayContaining(["Follow", "Take over", "Retry", "Share", "Stop", "Close task", "Make this an agent", "Continue in my tool", "Design first", "Skip design review", "Remove Dan", "Take ownership"]));
 expect(inventories[1]).toEqual(inventories[0]);
});

for (const action of ["Design first", "Skip design review"] as const) it(`R6c ${action}: a newer read during the queued claim prevents dispatch after remount`, async () => {
 const s = mount(), descriptor = Object.getOwnPropertyDescriptor(navigator, "locks")!;
 let claim: (() => Promise<unknown>) | undefined;
 try {
  const button = await prepare(action);
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request: (_name: string, _options: unknown, callback: (lock: unknown) => Promise<unknown>) => new Promise((resolve, reject) => { claim = async () => { try { const result = await callback({ name: "design-claim", mode: "exclusive" });resolve(result);return result; } catch (error) { reject(error instanceof Error ? error : new Error(String(error)));throw error; } }; }) } });
  fireEvent.click(button);await waitFor(() => expect(claim).toBeTypeOf("function"));
  s.change("permission");
  await act(async () => { await s.query.refetchQueries({ queryKey: ["session", SESSION], exact: true }); });
  s.ui.unmount();const remounted = renderUi(s.tree());
  try { await act(async () => { await claim!(); });expect(s.writes()).toHaveLength(0); }
  finally { remounted.unmount(); }
 } finally { Object.defineProperty(navigator, "locks", descriptor);s.close(); }
});

it.each(["Close task", "Share", "Take over"] as const)("DEC367 Task actions menu opens the live %s control", async label => {
 const s = mount(false, label !== "Share");try {
  const trigger = await enabled("Task actions");fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const item = await screen.findByRole("menuitem", { name: label });
  expect(item.getAttribute("data-disabled")).toBeNull();fireEvent.click(item);
  expect(await screen.findByRole("dialog", { name: label === "Close task" ? "Close this task?" : label === "Share" ? "Share this session" : "Take over this task?" })).toBeTruthy();
  expect(s.writes()).toHaveLength(0);
 } finally { s.close(); }
});

it("DEC367 no permission: absent grants expose no action controls", async () => {
 const s = mount();try {
  await prepare("Remove Dan");s.change("permission");
  await act(async () => { await s.query.refetchQueries({ queryKey: ["session", SESSION] }); });
  await waitFor(() => { for (const name of ["Close task", "Share", "Take over", "Remove Dan", "Take ownership", "Continue in my tool", "Design first", "Skip design review"]) expect(screen.queryByRole("button", { name })).toBeNull(); });
  expect(s.writes()).toHaveLength(0);
 } finally { s.close(); }
});
