// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { meFixture, navFixture } from "./support/fixtures.js";
import { ID, TASKS, PLAN, PROOF, EVENTS, decisionsView } from "./support/work-fixture.js";
import { sessionFixture, SESSION_FIXTURE_ID, taskFixture } from "./support/session-fixture.js";

// Resolve production lazy leaves so the journeys run through the mounted page.
function mount(path = "/app/sessions/" + ID.plan, lessonsOff = false, continuing = false, heldReject = false) {
 const nav = navFixture();
 const shared = { developerId: "d".repeat(64), name: "Sam", role: "viewer" };
 let sharedWith = [shared], readStatus = 200;
 const tasks = continuing ? TASKS.map(task => task.taskId === ID.plan ? { ...task, workflow: { ...task.workflow, stage: "IMPLEMENT", state: "RUNNING" } } : task) : TASKS;
 const session = sessionFixture({ body: { kind: "task", task: taskFixture() } });
 const f = fakeHost(async request => {
  const url = request.path.split("?")[0]!;
  if (heldReject && request.method === "POST" && url.endsWith("/reject")) return { status: 200, body: { cardId: "fix_setup:fix1", outcome: "rejected", remainingTabs: [] } };
  if (request.method === "DELETE" && url.includes("/shares/")) { sharedWith = [];return { status: 200, body: { removed: true } }; }
  if (request.method !== "GET") return url.endsWith("/presence") ? { status: 200, body: { viewingNow: [] } } : { status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "Not connected yet" } } };
  if (readStatus !== 200 && url === "/v1/app/sessions/" + SESSION_FIXTURE_ID) return { status: readStatus, body: { error: { code: readStatus === 403 ? "TASK_ACCESS_DENIED" : "UPSTREAM", message: "Current task read failed" } } };
  if (url === "/v1/app/me") return { status: 200, body: meFixture() };
  if (url === "/v1/app/nav") return { status: 200, body: nav };
  if (url === "/v1/app/sessions") return { status: 200, body: { tasks } };
  if (url === "/v1/app/decisions") return { status: 200, body: heldReject ? (JSON.parse(readFileSync("tests/fixtures/code-decision-cards.json", "utf8")) as { views: Record<string, unknown> }).views["fix_setup"] : decisionsView() };
  if (url === "/v1/app/sessions/" + SESSION_FIXTURE_ID) return { status: 200, body: { session } };
  if (url.endsWith("/people")) return { status: 200, body: { people: { revision: 1, orphaned: false, canManage: true, canTakeOwnership: false, people: [{ personId: "22222222-2222-4222-8222-222222222222", name: "Priya", role: "owner", you: true, effectiveRole: "owner" }] }, sharedWith } };
  if (url.endsWith("/candidates")) return { status: 200, body: { candidates: [], complete: true } };
  if (url.endsWith("/documents/plan")) return { status: 200, body: PLAN };
  if (url.endsWith("/evidence")) return { status: 200, body: PROOF };
  if (url.endsWith("/events")) return { status: 200, body: EVENTS };
  if (url.endsWith("/comments")) return { status: 200, body: { comments: [] } };
  if (url.endsWith("/lessons")) return lessonsOff ? { status: 403, body: { error: { code: "LESSONS_SWITCHED_OFF", message: "Lessons are off." } } } : { status: 200, body: { lessons: [] } };
  return { status: 404, body: { error: { code: "NOT_FOUND", message: "Not served" } } };
 });
 const routes = appRoutes(nav.features), app = routes.find(route => route.path === "/app")!;
 const share = path.startsWith("/s/");
 const leaf = share ? routes.find(route => route.path === "/s/:id")!.children![0]! : app.children!.find(route => route.path === "sessions/:id")!;
 const router = createMemoryRouter([{ path: share ? "/s/:id" : "/app/sessions/:id", lazy: leaf.lazy! }], { initialEntries: [path] });
 const query = createQueryClient();query.setQueryData(["nav"], nav);
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Announcer, { children: h(RouterProvider, { router }) }) }) }));
 return { ...f, ...ui, query, fail(status: number) { readStatus = status; }, close() { ui.unmount();router.dispose();query.clear(); } };
}

it("keeps live task sections navigable and cost and lessons visible in their disclosures", async () => {
 const ui = mount();try {
  await screen.findByTestId("session-title", {}, { timeout: 15_000 });
  expect(ui.container.querySelector(".rv-task-rebuild")).not.toBeNull();
  for (const name of ["Activity", "About this task"]) fireEvent.click(screen.getByText(name, { selector: "strong" }).closest("summary")!);
  const rail = await screen.findByRole("list", { name: "Steps of this task" });
  expect(rail.closest("details:not([open])")).toBeNull();
  for (const name of ["Cost", "Lessons used"]) expect(screen.getByRole("region", { name }).closest("details:not([open])")).toBeNull();
  fireEvent.click(within(rail).getByRole("button", { name: /^Request/u }));
  expect(await screen.findByRole("region", { name: "Request" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Spec", hidden: true })).toBeNull();
  fireEvent.click(within(rail).getByRole("button", { name: /^Pull request/u }));
  expect(await screen.findByTestId("no-pull-request")).toBeTruthy();
 } finally { ui.close(); }
});

it.each(["/app/sessions/", "/s/"])("mounts the action-complete rebuild on %s:id", async prefix => {
 const ui = mount(prefix + SESSION_FIXTURE_ID);try {
  await screen.findByTestId("session-title");
  expect(ui.container.querySelector(".rv-task-rebuild")).not.toBeNull();
  expect(screen.queryByRole("link", { name: /preview/iu })).toBeNull();
 } finally { ui.close(); }
});

it("keeps live Continue and criterion comments connected to their existing unavailable replies and preserves the draft", async () => {
 const ui = mount(undefined, false, true);try {
  const trigger = await screen.findByRole("button", { name: "Task actions" });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Continue in my tool" }));
  expect((await screen.findByTestId("continue-message")).textContent).toContain("isn't connected to Rovara Code yet");
  fireEvent.click(screen.getByText("Plan and changes", { selector: "strong" }).closest("summary")!);
  const spec = await screen.findByRole("region", { name: "Spec" });
  fireEvent.click(within(spec).getByRole("button", { name: "Comment on R1.1" }));
  const draft = within(spec).getByRole<HTMLTextAreaElement>("textbox", { name: "Comment on R1.1" });
  fireEvent.change(draft, { target: { value: "Count the retries" } });
  fireEvent.click(within(spec).getByRole("button", { name: "Send" }));
  expect((await screen.findByTestId("criterion-comment-unavailable")).textContent).toContain("Comments on the spec are not available on this installation.");
  expect(draft.value).toBe("Count the retries");
 } finally { ui.close(); }
});

it("keeps lessons-off visible on the live task page", async () => {
 const ui = mount(undefined, true);try {
  await screen.findByTestId("session-title");
  fireEvent.click(screen.getByText("About this task", { selector: "strong" }).closest("summary")!);
  const off = await screen.findByTestId("lessons-off");
  expect(off.closest("details:not([open])")).toBeNull();
 } finally { ui.close(); }
});

it("keeps removal of a previously shared person available on the live share address", async () => {
 const ui = mount("/s/" + SESSION_FIXTURE_ID);try {
  const panel = await screen.findByTestId("people-panel");
  panel.closest(".rv-task-section")!.setAttribute("open", "");
  fireEvent.click(panel.querySelector("summary")!);
  const remove = await within(panel).findByRole<HTMLButtonElement>("button", { name: "Remove Sam" });
  await waitFor(() => expect(remove.disabled).toBe(false));
  fireEvent.click(remove);
  await waitFor(() => expect(within(panel).queryByText("Sam")).toBeNull());
 } finally { ui.close(); }
});

for (const prefix of ["/app/sessions/", "/s/"]) {
 it(`R1 ${prefix}: a later access refusal wipes cached task and People with zero destructive sends`, async () => {
  const ui = mount(prefix + SESSION_FIXTURE_ID);try {
   const panel = await screen.findByTestId("people-panel");
   panel.closest(".rv-task-section")!.setAttribute("open", "");
   fireEvent.click(panel.querySelector("summary")!);
   await within(panel).findByRole("button", { name: "Remove Sam" });
   ui.fail(403);
   await act(async () => { await ui.query.refetchQueries({ queryKey: ["session", SESSION_FIXTURE_ID], exact: true }); });
   expect(await screen.findByRole("heading", { name: "You no longer have access to this task" })).toBeTruthy();
   expect(screen.queryByTestId("session-title")).toBeNull();
   expect(screen.queryByTestId("people-panel")).toBeNull();
   expect(screen.queryByText("Sam")).toBeNull();
   expect(ui.request.mock.calls.filter(([r]) => r.method !== "GET" && !r.path.endsWith("/presence"))).toHaveLength(0);
  } finally { ui.close(); }
 });
 it(`R1 ${prefix}: a later 503 drops the current projection and write authority`, async () => {
  const ui = mount(prefix + SESSION_FIXTURE_ID);try {
   await screen.findByTestId("session-title");ui.fail(503);
   await act(async () => { await ui.query.refetchQueries({ queryKey: ["session", SESSION_FIXTURE_ID], exact: true }); });
   expect(await screen.findByRole("heading", { name: "Rovara couldn't load this task" })).toBeTruthy();
   expect(screen.queryByTestId("session-title")).toBeNull();
   expect(screen.getByText(/TASK-READ-FAILED/u)).toBeTruthy();
   expect(screen.queryByRole("button", { name: "Task actions" })).toBeNull();
   expect(ui.request.mock.calls.filter(([r]) => r.method !== "GET" && !r.path.endsWith("/presence"))).toHaveLength(0);
  } finally { ui.close(); }
 });
}

for (const prefix of ["/app/sessions/", "/s/"]) {
 it(`DEC374 ${prefix}: Continue is blocked with "Approve the plan first" while the plan waits, and nothing is sent`, async () => {
  const ui = mount(prefix + ID.plan);try {
   await screen.findByTestId("session-title", {}, { timeout: 15_000 });
   expect((await screen.findByText(/Approve the plan first/u)).textContent).toContain("No new round was started.");
   fireEvent.keyDown(await screen.findByRole("button", { name: "Task actions" }), { key: "ArrowDown" });
   await screen.findByRole("menu");
   expect(screen.queryByRole("menuitem", { name: "Continue in my tool" })).toBeNull();
   const blocked = screen.getByRole("menuitem", { name: "Continue in my tool (approve the plan first)" });
   expect(blocked.getAttribute("aria-disabled") === "true" || blocked.hasAttribute("data-disabled")).toBe(true);
   fireEvent.click(blocked);
   expect(screen.queryByRole("button", { name: "Continue in my tool", hidden: true })).toBeNull();
   expect(ui.request.mock.calls.filter(([r]) => r.method !== "GET" && !r.path.endsWith("/presence"))).toHaveLength(0);
  } finally { ui.close(); }
 });
}


it.each(["/app/sessions/", "/s/"])("shows the Request start in the viewer's local time on %s:id", async prefix => {
 const previousZone = process.env.TZ;
 const readings: string[] = [];
 try {
  // The task fixture starts at 2026-11-15T02:00:00.000Z in both zones.
  for (const [zone, expected] of [["America/Los_Angeles", "Started Nov 14, 2026, 6:00 PM"], ["Pacific/Auckland", "Started Nov 15, 2026, 3:00 PM"]] as const) {
   process.env.TZ = zone;
   const ui = mount(prefix + ID.plan);
   try {
    await screen.findByTestId("session-title", {}, { timeout: 15_000 });
    fireEvent.click(screen.getByText("Plan and changes", { selector: "strong" }).closest("summary")!);
    const rail = await screen.findByRole("list", { name: "Steps of this task" });
    fireEvent.click(within(rail).getByRole("button", { name: /^Request/u }));
    const request = await screen.findByRole("region", { name: "Request" });
    const started = within(request).getByText(/^Started /u);
    readings.push(started.textContent);
    expect(started.textContent).toBe(expected);
    expect(request.textContent).not.toContain("UTC");
    const time = started.querySelector("time");
    if (time !== null) expect(time.getAttribute("datetime")).toBe("2026-11-15T02:00:00.000Z");
   } finally { ui.close(); }
  }
  expect(readings[0]).not.toBe(readings[1]);
 } finally {
  if (previousZone === undefined) delete process.env.TZ;
  else process.env.TZ = previousZone;
 }
});

it.each(["/app/sessions/", "/s/"])("restores the served Not now and reasons through the production leaf %s:id", async prefix => {
 const ui = mount(prefix + SESSION_FIXTURE_ID, false, false, true);try {
  const card = await screen.findByRole("region", { name: "Your decision" }, { timeout: 15_000 });
  fireEvent.click(within(card).getByText("Not now", { selector: "summary" }));fireEvent.click(within(card).getByRole("button", { name: "Wrong approach" }));
  await waitFor(() => expect(ui.request.mock.calls.filter(([r]) => r.path.endsWith("/reject"))).toHaveLength(1));
  expect(ui.request.mock.calls.find(([r]) => r.path.endsWith("/reject"))![0]).toMatchObject({ path: "/v1/app/decisions/fix_setup/fix1/reject", body: { reason: "wrong_approach" }, retry: "never" });
 } finally { ui.close(); }
});
