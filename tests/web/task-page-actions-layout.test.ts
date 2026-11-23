// @vitest-environment jsdom
// BRIEF-ACTIONS-LAYOUT: the layout round moved Continue in my tool into "Task actions" (mock 4d), set Stop / Close apart in that menu,
// gave the task dialogs one close icon, and made the task page's times viewer-local. The handlers did not move: every send below goes through the
// same guarded handler as before, and a refused / stale / withdrawn authority still makes ZERO sends.
import { expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppHostProvider, type ApiResponse } from "../../packages/ui/src/host.js";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { decisionRows, localWhenWords, whenWords } from "../../packages/ui/src/screens/session/DecisionsCard.js";
import { fakeHost, CLOSE_PREVIEW_NOT_SERVED } from "./support/fake-host.js";
import { meFixture, navFixture } from "./support/fixtures.js";
import { workspaceFixture, workspaceWorkflow } from "./support/workspace-fixture.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { inViewerZones, VIEWER_INSTANT } from "./support/viewer-zones.js";
import { pressWhenEnabled } from "./support/close-dialog.js";

const operationId: unknown = expect.any(String);
const TASK = "11111111-1111-4111-8111-111111111111", SESSION = "ses_aaaaaaaaaaaaaaaaaaaa", SESSION_PATH = "/v1/app/sessions/" + SESSION;
const CONTINUE_PATH = "/v1/app/tasks/" + TASK + "/continue/publish-branch";
const failure = (status = 403): ApiResponse => ({ status, body: { error: { code: "FORBIDDEN", message: "Current read refused" } } });
type SessionAction = "watch" | "stop" | "close" | "share" | "take_over" | "make_agent" | "comment" | "steer";
function mount(actions: readonly SessionAction[] = ["watch", "stop", "close", "share", "take_over", "make_agent", "comment", "steer"], stage: "IMPLEMENT" | "PLAN_REVIEW" = "IMPLEMENT", live = false, retainedWork = false) {
 const base = workspaceFixture();
 const session = workspaceFixture({ status: "running", you: { ...base.you, actions: [...actions] } }, { workflow: { ...workspaceWorkflow(), stage, state: stage === "IMPLEMENT" ? "RUNNING" : "WAITING", revision: 16 } });
 let changed: "none" | "refused" | "permission" = "none";
 const current = () => changed === "permission" ? { ...session, you: { ...session.you, actions: [] }, body: session.body.kind === "task" ? { kind: "task", task: { ...session.body.task, status: "CLOSED" } } : session.body } : session;
 const f = fakeHost(async r => {
  const path = r.path.split("?")[0]!;
  if (path === "/v1/app/me") return { status: 200, body: meFixture() };
  if (path === "/v1/app/nav") return { status: 200, body: navFixture() };
  if (path.endsWith("/presence")) return { status: 200, body: { viewingNow: [] } };
  // The legacy Close and Discard layouts are proved here, so Code serves no Close preview route.
  if (r.method === "GET" && path === SESSION_PATH + "/close") return CLOSE_PREVIEW_NOT_SERVED;
  if (retainedWork && r.method === "POST" && path === SESSION_PATH + "/close") {
   return { status: 200, body: { session, closed: false, unpublished: [{ repository: "acme/payments", reasons: ["worktree_changes"] }] } };
  }
  if (r.method !== "GET") return { status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "Unconfirmed" } } };
  if (path === SESSION_PATH) return changed === "refused" ? failure() : { status: 200, body: { session: current() } };
  if (path === "/v1/app/sessions") return changed === "refused" ? failure() : { status: 200, body: { tasks: [{ ...(session.body.kind === "task" ? session.body.task : {}), ...(changed === "permission" ? { status: "CLOSED" } : {}), sessionId: SESSION }] } };
  if (path === "/v1/app/decisions") return { status: 200, body: { cards: [] } };
  if (path.endsWith("/people")) return failure(404);
  if (path.endsWith("/messages")) return { status: 200, body: { messages: [], hasMore: false } };
  if (path.endsWith("/events")) return { status: 200, body: { events: [] } };
  if (path.endsWith("/log")) return { status: 200, body: { entries: [{ key: "approval:a", kind: "approval", what: "plan", outcome: "approved", by: "Ana", surface: "slack", at: "2026-11-20T10:03:00.000Z" }] } };
  return failure(404);
 });
 const routes = appRoutes(navFixture().features), app = routes.find(route => route.path === "/app")!, leaf = live ? routes.find(route => route.path === "/s/:id")!.children![0]! : app.children!.find(route => route.path === "sessions/:id")!;
 const query = createQueryClient(), router = createMemoryRouter([{ path: live ? "/s/:id" : "/app/sessions/:id", lazy: leaf.lazy! }], { initialEntries: [(live ? "/s/" : "/app/sessions/") + SESSION] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(RouterProvider, { router }) }) }));
 const writes = () => f.request.mock.calls.map(([r]) => r).filter(r => r.method !== "GET" && !r.path.endsWith("/presence"));
 return { writes, change(value: typeof changed) { changed = value; }, close() { ui.unmount();router.dispose();query.clear(); } };
}
async function openMenu() {
 const trigger = await screen.findByRole<HTMLButtonElement>("button", { name: "Task actions" }, { timeout: 15_000 }); // the first lazy leaf load can pass 1 s on a busy machine
 await waitFor(() => expect(trigger.disabled).toBe(false));
 fireEvent.keyDown(trigger, { key: "ArrowDown" });
 return screen.findByRole("menu");
}
function expectSafeFirst(dialog: HTMLElement, safeName: string, dangerName: string, dangerous = true) {
 const safe = within(dialog).getByRole("button", { name: safeName });
 const danger = within(dialog).getByRole("button", { name: dangerName });
 expect(within(dialog).getAllByRole("button")).toEqual([
  within(dialog).getByRole("button", { name: "Close dialog" }), safe, danger,
 ]);
 expect(safe.classList.contains("rv-button-primary")).toBe(true);
 expect(danger.classList.contains("rv-button-danger")).toBe(dangerous);
}
const itemNames = (menu: HTMLElement) => within(menu).getAllByRole("menuitem").map(item => item.textContent);

it("Continue in my tool is a Task actions item; selecting it sends the one guarded request and a repeat cannot send again", async () => {
 const s = mount();try {
  const menu = await openMenu();
  const item = await within(menu).findByRole("menuitem", { name: "Continue in my tool" });
  expect(item.getAttribute("data-disabled")).toBeNull();
  fireEvent.click(item);
  await waitFor(() => expect(s.writes()).toHaveLength(1));
  expect(s.writes()[0]!.method).toBe("POST");expect(s.writes()[0]!.path).toBe(CONTINUE_PATH);expect(s.writes()[0]!.body).toMatchObject({ requestId: operationId });
  // The unknown outcome keeps the one-shot lock: a second press from the menu sends nothing.
  fireEvent.keyDown(await screen.findByRole("button", { name: "Task actions" }), { key: "ArrowDown" });
  const again = await screen.findAllByRole("menuitem", { name: "Continue in my tool" });
  // While the first request is unconfirmed the entry is locked, not merely ignored.
  expect(again[0]!.getAttribute("data-disabled")).not.toBeNull();
  fireEvent.click(again[0]!);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
  expect(s.writes()).toHaveLength(1);
 } finally { s.close(); }
});

it("Continue in my tool in the menu makes ZERO sends when the current read is refused", async () => {
 const s = mount();try {
  const menu = await openMenu();
  const item = await within(menu).findByRole("menuitem", { name: "Continue in my tool" });
  s.change("refused");fireEvent.click(item);
  await screen.findAllByRole("alert");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
  expect(s.writes()).toHaveLength(0);
 } finally { s.close(); }
});

it("Continue in my tool is not in the menu while a plan waits for approval, and leaves again when the task closes", async () => {
 const waiting = mount(undefined, "PLAN_REVIEW");
 try {
  const menu = await openMenu();
  expect(itemNames(menu)).not.toContain("Continue in my tool");
  // DEC 254zzz374: blocked, with the short visible reason, and nothing to send with.
  const blocked = within(menu).getByRole("menuitem", { name: "Continue in my tool (approve the plan first)" });
  expect(blocked.getAttribute("aria-disabled") === "true" || blocked.hasAttribute("data-disabled")).toBe(true);
  fireEvent.click(blocked);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
  expect(waiting.writes()).toHaveLength(0);
 } finally { waiting.close(); }
 const s = mount();
 try {
  expect(itemNames(await openMenu())).toContain("Continue in my tool");
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  s.change("permission");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(s.writes()).toHaveLength(0);
 } finally { s.close(); }
});

it("Task actions sets Stop and Close task apart from the everyday items, Close task in the destructive tone, with one rule", async () => {
 const s = mount();try {
  const menu = await openMenu();
  const names = itemNames(menu);
  expect(names.slice(-2)).toEqual(["Stop", "Close task"]);
  expect(names.indexOf("Continue in my tool")).toBeGreaterThan(-1);expect(names.indexOf("Continue in my tool")).toBeLessThan(names.indexOf("Stop"));
  expect(within(menu).getAllByRole("separator")).toHaveLength(1);
  const items = within(menu).getAllByRole("menuitem");
  expect(items.at(-1)!.className).toContain("rv-menu-item-danger");
  expect(items.at(-2)!.className).not.toContain("rv-menu-item-danger");
  expect(menu.querySelector("[role=separator]")!.nextElementSibling).toBe(items.at(-2));
 } finally { s.close(); }
});

it("Task actions sets Stop and Close task apart only when something everyday sits above them", async () => {
 const s = mount(["stop", "close"], "PLAN_REVIEW");try {
  const menu = await openMenu();
  expect(itemNames(menu)).toEqual(["Continue in my tool (approve the plan first)", "Stop", "Close task"]);
  expect(within(menu).queryAllByRole("separator")).toHaveLength(0);
 } finally { s.close(); }
});

it("the task dialogs carry the one close icon class and the safe choice is the primary button", async () => {
 const s = mount();try {
  const menu = await openMenu();
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Close task" }));
  const dialog = await screen.findByRole("dialog", { name: "Close this task?" });
  expect(dialog.className).toContain("rv-action-dialog");
  await within(dialog).findByRole("button", { name: "Close and delete the machine" });
  expectSafeFirst(dialog, "Cancel", "Close and delete the machine");
  expect(within(dialog).getByRole("button", { name: "Cancel" }).className).toContain("rv-button-primary");
  expect(within(dialog).getByRole("button", { name: "Close and delete the machine" }).className).toContain("rv-button-danger");
  expect(s.writes()).toHaveLength(0);
 } finally { s.close(); }
});

it("Opus P2-1 Discard keeps the safe filled button first and the risky red-outlined button second", async () => {
 const s = mount(undefined, "IMPLEMENT", false, true);try {
  fireEvent.click(within(await openMenu()).getByRole("menuitem", { name: "Close task" }));
  const close = await screen.findByRole("dialog", { name: "Close this task?" });
  await pressWhenEnabled(async () => within(close).getByRole("button", { name: "Close and delete the machine" }));
  const discard = await screen.findByRole("dialog", { name: "Discard unpublished work?" });
  expectSafeFirst(discard, "Keep it open", "Discard it and close");
  expect(s.writes()).toHaveLength(1);
  expect(s.writes()[0]!.body).not.toHaveProperty("discardUnpublished");
 } finally { s.close(); }
});

it("Opus P3 live /s/:id narrow Task actions menu uses the rebuilt destructive Close task tone", async () => {
 vi.stubGlobal("innerWidth", 390);
 const s = mount(undefined, "IMPLEMENT", true);try {
  expect(window.innerWidth).toBe(390);
  const trigger = await screen.findByRole("button", { name: "Task actions" });
  expect(trigger.closest(".rv-controls-overflow")).not.toBeNull();
  const menu = await openMenu();
  const close = within(menu).getByRole("menuitem", { name: "Close task" });
  expect(close.classList.contains("rv-menu-item")).toBe(true);
  expect(close.classList.contains("rv-menu-item-danger")).toBe(true);
  expect(s.writes()).toHaveLength(0);
 } finally { s.close();vi.unstubAllGlobals(); }
});

it("the real share route keeps the rebuilt Close dialog safe-first", async () => {
 const s = mount(undefined, "IMPLEMENT", true);try {
  await pressWhenEnabled(async () => await screen.findByRole("button", { name: "Close task" }));
  const dialog = await screen.findByRole("dialog", { name: "Close this task?" });
  await within(dialog).findByRole("button", { name: "Close and delete the machine" });
  expectSafeFirst(dialog, "Cancel", "Close and delete the machine");
  expect(s.writes()).toHaveLength(0);
 } finally { s.close(); }
});

it("the real share route keeps the rebuilt Stop dialog words and safe-first order", async () => {
 const s = mount(undefined, "IMPLEMENT", true);try {
  fireEvent.click(within(await openMenu()).getByRole("menuitem", { name: "Stop" }));
  const dialog = await screen.findByRole("dialog", { name: "Stop this session?" });
  expectSafeFirst(dialog, "Cancel", "Stop this task", false);
  expect(dialog.textContent).toContain("Stop pauses this task. Its files are kept; Retry continues from them.");
  expect(dialog.textContent).not.toMatch(/ends this task's machine|are lost/u);
 } finally { s.close(); }
});

it("the Stop dialog says what happens and makes the safe choice the primary button and Stop neutral", async () => {
 const s = mount();try {
  const menu = await openMenu();
  fireEvent.click(within(menu).getByRole("menuitem", { name: /^Stop$/u }));
  const dialog = await screen.findByRole("dialog", { name: "Stop this session?" });
  expect(dialog.className).toContain("rv-action-dialog");
  expect(dialog.textContent).toContain("Stop pauses this task. Its files are kept; Retry continues from them.");
  expect(dialog.textContent).not.toMatch(/ends this task's machine|are lost/u);
  expectSafeFirst(dialog, "Cancel", "Stop this task", false);
  expect(within(dialog).getByRole("button", { name: "Cancel" }).className).toContain("rv-button-primary");
  expect(within(dialog).getByRole("button", { name: "Stop this task" }).className).not.toContain("rv-button-danger");
  expect(s.writes()).toHaveLength(0);
 } finally { s.close(); }
});

for (const live of [false, true]) it(`the skip-design-review confirmation (${live ? "/s/:id" : "/app/sessions/:id"}) makes Keep it the primary button and says what happens in plain words`, async () => {
 const base = workspaceFixture();
 const session = workspaceFixture({ status: "running", you: { ...base.you, actions: ["watch", "stop", "close"] } }, { workflow: { ...workspaceWorkflow(), stage: "IMPLEMENT", state: "RUNNING", revision: 16 }, designActions: { designFirst: true, skip: { allowed: true } } });
 const f = fakeHost(async r => {
  const path = r.path.split("?")[0]!;
  if (path === "/v1/app/me") return { status: 200, body: meFixture() };
  if (path === "/v1/app/nav") return { status: 200, body: navFixture() };
  if (r.method !== "GET") return { status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "Unconfirmed" } } };
  if (path === SESSION_PATH) return { status: 200, body: { session } };
  if (path === "/v1/app/sessions") return { status: 200, body: { tasks: [{ ...(session.body.kind === "task" ? session.body.task : {}), sessionId: SESSION }] } };
  if (path === "/v1/app/decisions") return { status: 200, body: { cards: [] } };
  return failure(404);
 });
 const routes = appRoutes(navFixture().features), app = routes.find(route => route.path === "/app")!, leaf = live ? routes.find(route => route.path === "/s/:id")!.children![0]! : app.children!.find(route => route.path === "sessions/:id")!;
 const query = createQueryClient(), router = createMemoryRouter([{ path: live ? "/s/:id" : "/app/sessions/:id", lazy: leaf.lazy! }], { initialEntries: [(live ? "/s/" : "/app/sessions/") + SESSION] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(RouterProvider, { router }) }) }));
 try {
  const region = await screen.findByRole("region", { name: "Design review actions" });
  fireEvent.click(within(region).getByRole("button", { name: "Skip design review" }));
  const group = await within(region).findByRole("group", { name: "Confirm skipping design review" });
  expect(group.textContent?.includes("fresh-context")).toBe(false);
  // Both real routes use the approved safe-first confirmation (mock 4e).
  expect(within(group).getAllByRole("button").map(button => button.textContent)).toEqual(["Keep it", "Skip design review"]);
  expect(within(group).getByRole("button", { name: "Keep it" }).className).toContain("rv-button-primary");
  expect(within(group).getByRole("button", { name: "Skip design review" }).className).toContain("rv-button-danger");
  expect(f.request.mock.calls.filter(([r]) => r.method !== "GET" && !r.path.endsWith("/presence"))).toHaveLength(0);
 } finally { ui.unmount();router.dispose();query.clear(); }
});

it("the task page and older decision rows read times in the viewer's own clock with no zone name", async () => {
 const entries = [{ key: "approval:a", kind: "approval", what: "plan", outcome: "approved", by: "Ana", surface: "slack", at: VIEWER_INSTANT }] as never;
 await inViewerZones(async expected => {
  expect(localWhenWords(VIEWER_INSTANT)).toBe(expected.clock);
  expect(whenWords(VIEWER_INSTANT)).toBe(expected.clock);
  expect(decisionRows(entries, true)[0]!.who).toBe("Ana, in Slack, " + expected.clock);
  expect(decisionRows(entries)[0]!.who).toBe("Ana, in Slack, " + expected.clock);
  expect(decisionRows(entries, true)[0]!.who).not.toMatch(/UTC/u);
  expect(decisionRows(entries)[0]!.who).not.toMatch(/UTC/u);
 });
 expect(localWhenWords("not a time")).toBe("not a time");
});

it("there is no Task actions menu when nothing is offered in it", async () => {
 const s = mount(["comment"], "PLAN_REVIEW");try {
  await screen.findByTestId("task-page");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
  expect(screen.queryByRole("button", { name: "Task actions" })).toBeNull();
 } finally { s.close(); }
});

it("the menu is still there when Continue in my tool is the only task-level action", async () => {
 const s = mount(["comment"]);try {
  const menu = await openMenu();
  expect(itemNames(menu)).toEqual(["Continue in my tool"]);
  expect(within(menu).queryAllByRole("separator")).toHaveLength(0);
 } finally { s.close(); }
});

it("the task page's Decisions and answers shows the recorded time in the viewer's clock, never UTC", async () => {
 const s = mount();try {
  const card = await screen.findByTestId("decisions");
  const local = new Date("2026-11-20T10:03:00.000Z");
  expect(card.textContent).toContain("Ana, in Slack, ");
  expect(card.textContent).not.toMatch(/UTC/u);
  expect(card.textContent).toContain(String(local.getHours()).padStart(2, "0") + ":" + String(local.getMinutes()).padStart(2, "0"));
 } finally { s.close(); }
});
