// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppHostProvider, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { InboxPreviewScreen as InboxScreen } from "../../packages/ui/src/screens/inbox/InboxPreviewScreen.js";
import { WorkPreviewScreen as WorkScreen } from "../../packages/ui/src/screens/work/WorkPreviewScreen.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { navFixture, meFixture } from "./support/fixtures.js";
import { CARDS, EVENTS, ID, PLAN, PROOF, QUESTION_SESSION, NOW, TASKS, decisionsView, task } from "./support/work-fixture.js";
import { expectNoAxeViolations } from "./support/axe.js";

beforeEach(() => { vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers();localStorage.clear(); });
const fail = (status = 403): ApiResponse => ({ status, body: { error: { code: "FORBIDDEN", message: "Read refused." } } });
function mount(path = "/app/inbox", initial: Record<string, ApiResponse> = {}) {
 const replies: Record<string, ApiResponse> = {
  "/v1/app/me": { status: 200, body: meFixture() },
  "/v1/app/sessions": { status: 200, body: { tasks: TASKS } },
  "/v1/app/decisions": { status: 200, body: decisionsView() },
  "/v1/app/involved": { status: 200, body: { tasks: [] } },
  "/v1/app/lessons/inbox": { status: 200, body: { state: "on", batches: [], unavailable: [] } },
  "/v1/app/inbox": { status: 200, body: { items: [], unread: 0 } },
  "/v1/app/inbox/project-notices": { status: 200, body: { items: [] } },
  "/v1/app/nav": { status: 200, body: navFixture({ projects: [] }) },
  ...initial,
 };
 const f = fakeHost(async request => replies[request.path.split("?")[0]!] ?? (request.path.endsWith("/documents/plan") ? { status: 200, body: PLAN } : request.path.endsWith("/evidence") ? { status: 200, body: PROOF } : request.path.endsWith("/events") ? { status: 200, body: EVENTS } : request.path.endsWith("/comments") ? { status: 200, body: { comments: [] } } : { status: 404, body: { error: { code: "NOT_FOUND", message: "not served" } } }));
 const query = createQueryClient(), where = { current: "" };
 function Where() { const location = useLocation();where.current = location.pathname + location.search;return null; }
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: [path], children: h(Announcer, { children: h("div", {}, h(Where), h(Routes, {}, h(Route, { path: "/app/inbox", element: h(InboxScreen) }), h(Route, { path: "/app/live", element: h(WorkScreen) }))) }) }) }) }));
 return { ...f, ...view, query, replies, where, close() { view.unmount();query.clear(); } };
}

it("Inbox shows served needs-you tasks separately from waiting, and preview navigation sends no writes", async () => {
 const f = mount();
 const attention = await screen.findByRole("region", { name: "Inbox attention" });
 await within(attention).findByRole("button", { name: /Add a retry to the billing webhook/u });
 expect(within(attention).queryByRole("button", { name: /Document the router fallbacks/u })).toBeNull();
 fireEvent.click(within(attention).getByRole("button", { name: /Add a retry to the billing webhook/u }));
 const detail = await screen.findByRole("region", { name: "Inbox preview" });
 expect(detail.textContent).toContain(CARDS[0]!.question);
 expect(within(detail).getByRole("link", { name: "Open task" }).getAttribute("href")).toBe("/app/sessions/" + ID.plan);
 expect(within(detail).queryByRole("button", { name: "Approve plan v1" })).toBeNull();
 expect(f.request.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
 fireEvent.click(screen.getByRole("button", { name: "Back to Inbox" }));
 expect(document.activeElement?.textContent).toContain("Add a retry");f.close();
});
it("Inbox waiting is based on workflow WAITING, without inventing a named reviewer", async () => {
 const f = mount("/app/inbox?tab=waiting");const attention = await screen.findByRole("region", { name: "Inbox attention" });
 expect(await within(attention).findByRole("button", { name: /Document the router fallbacks/u })).toBeTruthy();
 expect(within(attention).queryByRole("button", { name: /Add a retry/u })).toBeNull();
 expect(attention.textContent).not.toContain("Waiting for Sam");f.close();
});
it.each(["decisions", "tasks"])("Inbox drops cached %s after a failed read and keeps independently current updates", async source => {
 const f = mount();await screen.findByRole("button", { name: /Add a retry to the billing webhook/u });
 f.replies[source === "tasks" ? "/v1/app/sessions" : "/v1/app/decisions"] = fail();
 await act(async () => { await f.query.invalidateQueries({ queryKey: source === "tasks" ? ["work", "tasks"] : ["decisions"] }); });
 await waitFor(() => expect(screen.queryByRole("button", { name: /Add a retry to the billing webhook/u })).toBeNull());
 expect(screen.getByTestId("inbox-attention").textContent).toContain("can't tell yet");
 expect(screen.queryByText("You're all caught up.")).toBeNull();f.close();
});
it("Inbox empty and partial reads never become a global all-clear", async () => {
 const f = mount("/app/inbox", { "/v1/app/sessions": { status: 200, body: { tasks: [] } }, "/v1/app/decisions": { status: 200, body: decisionsView([]) }, "/v1/app/inbox/project-notices": fail() });
 expect(await screen.findByTestId("project-notices-error")).toBeTruthy();
 expect(screen.getByTestId("inbox-attention").textContent).toContain("can't tell yet");
 expect(screen.queryByText("Nothing needs you")).toBeNull();f.close();
});
it("Inbox setup uses a successful scoped zero-project read and offers no invented invite send", async () => {
 const f = mount("/app/inbox?tab=setup");expect(await screen.findByText("You're not in a project yet")).toBeTruthy();
 expect(screen.getByTestId("inbox-attention").textContent).toContain("Ask your company's admins");
 expect(screen.queryByRole("button", { name: /Ask Ana/u })).toBeNull();expect(f.request.mock.calls.every(([r]) => r.method === "GET")).toBe(true);f.close();
});
it("Inbox setup refusal never retains the cached project or its link", async () => {
 const f = mount("/app/inbox?tab=setup");await screen.findByText("You're not in a project yet");
 f.replies["/v1/app/nav"] = fail();await act(async () => { await f.query.invalidateQueries({ queryKey: ["nav"] }); });
 await waitFor(() => expect(screen.queryByText("You're not in a project yet")).toBeNull());expect(screen.getByTestId("inbox-attention").textContent).toContain("can't tell yet");f.close();
});
it("Work filters loaded tasks, searches without changing unrelated parameters, and clears no-matches", async () => {
 const f = mount("/app/live?keep=yes");await screen.findByRole("button", { name: /^Running/u });
 fireEvent.click(screen.getByRole("button", { name: /^Running/u }));
 expect(document.querySelectorAll("button[data-task-id]")).toHaveLength(1);
 expect(document.querySelector("button[data-task-id]")?.textContent).toContain("Speed up");
 fireEvent.change(screen.getByRole("searchbox", { name: "Search work" }), { target: { value: "absent" } });
 expect(screen.getByText("No tasks match this filter")).toBeTruthy();expect(f.where.current).toContain("keep=yes");
 fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));expect(document.querySelectorAll("button[data-task-id]").length).toBeGreaterThan(1);f.close();
});
it("Work Needs someone includes waiting tasks and Finished includes served completion only", async () => {
 const f = mount();f.close();const w = mount("/app/live");await screen.findByRole("button", { name: /^Needs someone/u });
 fireEvent.click(screen.getByRole("button", { name: /^Needs someone/u }));
 expect(document.querySelector(`button[data-task-id="${ID.waiting}"]`)).toBeTruthy();
 expect(document.querySelector(`button[data-task-id="${ID.running}"]`)).toBeNull();
 fireEvent.click(screen.getByRole("button", { name: /^Finished/u }));expect(document.querySelectorAll("button[data-task-id]")).toHaveLength(1);w.close();
});
it("Work unknown selection never substitutes an unrelated task", async () => {
 const f = mount("/app/live?task=missing");expect(await screen.findByTestId("work-selection-unavailable")).toBeTruthy();
 expect(screen.queryByTestId("pane-title")).toBeNull();expect(f.where.current).toContain("task=missing");f.close();
});
it("Work cached task refusal hides the pane and every task control until recovery", async () => {
 const f = mount("/app/live?task=" + ID.plan);await screen.findByTestId("pane-title");f.replies["/v1/app/sessions"] = fail();
 await act(async () => { await f.query.invalidateQueries({ queryKey: ["work", "tasks"] }); });
 await waitFor(() => expect(screen.queryByTestId("pane-title")).toBeNull());expect(document.querySelector("button[data-task-id]")).toBeNull();expect(screen.getByTestId("work").getAttribute("data-detail-open")).toBe("false");
 f.replies["/v1/app/sessions"] = { status: 200, body: { tasks: TASKS } };
 fireEvent.click(screen.getByRole("button", { name: "Try again" }));await screen.findByTestId("pane-title");f.close();
});
it("Work decision refusal removes stale actions, labels incomplete reads and offers a scoped retry", async () => {
 const f = mount("/app/live?task=" + ID.plan);await screen.findByRole("region", { name: "Your decision" });
 f.replies["/v1/app/decisions"] = fail();await act(async () => { await f.query.invalidateQueries({ queryKey: ["decisions"] }); });
 await waitFor(() => expect(screen.queryByRole("button", { name: "Approve plan v1" })).toBeNull());expect(screen.getByRole("button", { name: "Reload decisions" })).toBeTruthy();expect(screen.getByRole("button", { name: "All" })).toBeTruthy();f.close();
});
it("Work empty loaded rows never claim that the complete queue is empty", async () => {
 const f = mount("/app/live", { "/v1/app/sessions": { status: 200, body: { tasks: [] } }, "/v1/app/decisions": { status: 200, body: decisionsView([]) } });
 expect(await screen.findByTestId("work-empty")).toBeTruthy();expect(screen.getByTestId("work").textContent).toContain("can't tell yet");f.close();
});
for (const theme of ["light", "dark"] as const) it("has accessible attention and Work filters in " + theme, async () => {
 const f = mount();document.documentElement.dataset.theme = theme;await screen.findByRole("button", { name: /Add a retry/u });await expectNoAxeViolations(f.container);f.close();
 const w = mount("/app/live");await screen.findByRole("button", { name: /^Running/u });await expectNoAxeViolations(w.container);w.close();
});

const answerableDecisions = { status: 200, body: decisionsView([{ ...CARDS[2]!, id: `answer_question:${ID.plan}_Q1`, taskId: ID.plan }]) };
const answerableTasks = { status: 200, body: { tasks: [task(ID.plan, "Answerable spec", { sessionId: QUESTION_SESSION, workflow: { stage: "PLAN_REVIEW", state: "WAITING", revision: 4, round: 2, path: "QUICK" } })] } };
it("Work decision refusal withdraws spec answers, sends nothing and preserves independently current spec facts", async () => {
 const f = mount("/app/live?task=" + ID.plan, { "/v1/app/sessions": answerableTasks, "/v1/app/decisions": answerableDecisions });
 try {
  await screen.findByRole("region", { name: "Question for you" });
  expect((await screen.findAllByRole("button", { name: "Yes, behind a flag" })).length).toBeGreaterThan(0);
  await waitFor(() => expect(f.query.isFetching()).toBe(0));
  f.replies["/v1/app/decisions"] = fail();
  await act(async () => { await f.query.invalidateQueries({ queryKey: ["decisions"] }); });
  await screen.findByTestId("decisions-unavailable");
  // Exercise any surviving answer control after the refusal is visible.
  const answer = screen.queryByRole("button", { name: "Yes, behind a flag" });
  if (answer !== null) fireEvent.click(answer);
  expect(f.request.mock.calls.filter(([request]) => request.method === "POST")).toHaveLength(0);
  expect(answer).toBeNull();
  expect(screen.getByTestId("decisions-unavailable").textContent).toContain("not a confirmed empty queue");
  f.replies["/v1/app/decisions"] = answerableDecisions;
  fireEvent.click(screen.getByRole("button", { name: "Reload decisions" }));
  await screen.findByRole("region", { name: "Question for you" });expect((await screen.findAllByRole("button", { name: "Yes, behind a flag" })).length).toBeGreaterThan(0);
 } finally { f.close(); }
});
it("Work restores live answer controls only after a current read, including remount", async () => {
 const f = mount('/app/live?task=' + ID.plan, { '/v1/app/sessions': answerableTasks, '/v1/app/decisions': answerableDecisions });
 try {
  await screen.findByRole('region', { name: 'Question for you' });expect((await screen.findAllByRole('button', { name: 'Yes, behind a flag' })).length).toBeGreaterThan(0);
  f.replies['/v1/app/decisions'] = fail();await act(async () => { await f.query.invalidateQueries({ queryKey: ['decisions'] }); });
  await screen.findByTestId('decisions-unavailable');expect(f.request.mock.calls.every(([request]) => request.method === 'GET')).toBe(true);
 } finally { f.close(); }
 const g = mount('/app/live?task=' + ID.plan, { '/v1/app/sessions': answerableTasks, '/v1/app/decisions': answerableDecisions });
 try { await screen.findByRole('region', { name: 'Question for you' });expect((await screen.findAllByRole('button', { name: 'Yes, behind a flag' })).length).toBeGreaterThan(0); } finally { g.close(); }
});
it("Work Running includes only served running work; All keeps queued and unread work distinguishable", async () => {
 const queuedId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", unreadId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
 const f = mount("/app/live?filter=running", { "/v1/app/sessions": { status: 200, body: { tasks: [TASKS[1], task(queuedId, "Queued work", { status: "STARTING", workflow: undefined }), task(unreadId, "Unread work", { status: "SUCCEEDED", workflow: undefined, detail: "unread" })] } } });
 try {
  await waitFor(() => expect(document.querySelector(`button[data-task-id="${ID.running}"]`)).toBeTruthy());
  expect(document.querySelector(`button[data-task-id="${queuedId}"]`)).toBeNull();
  expect(document.querySelector(`button[data-task-id="${unreadId}"]`)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /^All/u }));
  const queued = document.querySelector<HTMLButtonElement>(`button[data-task-id="${queuedId}"]`)!;
  const unread = document.querySelector<HTMLButtonElement>(`button[data-task-id="${unreadId}"]`)!;
  expect(queued.textContent).toContain("In the queue");
  expect(unread.textContent).toContain("Open it to see its step");
  fireEvent.click(unread);
  expect((await screen.findByTestId("decision-quiet")).textContent).toContain("can't tell yet which step");
 } finally { f.close(); }
});

for (const screenName of ["Work", "Inbox"] as const) for (const [name, taskId, sessionId] of [["session", ID.question, QUESTION_SESSION], ["task", ID.plan, ID.plan]] as const) it(screenName + " Open task uses the served " + name + " destination", async () => {
 const f = mount(screenName === "Work" ? "/app/live?task=" + taskId : "/app/inbox?item=" + taskId);
 try {
  const preview = await screen.findByRole("region", { name: screenName === "Work" ? "Selected task" : "Inbox preview" });
  await waitFor(() => expect(within(preview).getByRole("link", { name: /Open task/u }).getAttribute("href")).toBe("/app/sessions/" + sessionId));
  expect(f.request.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
 } finally { f.close(); }
});

// Composition proof: removing the shared table/chips or wiring to the wrong URL breaks these assertions.
it("Work composes a shared selectable table and current status without claiming readiness", async () => {
 const f = mount("/app/live?filter=running&task=" + ID.running);
 try {
  const table = await screen.findByRole("table", { name: "Work tasks" });
  expect(within(screen.getByRole("region", { name: "Work list" })).queryByRole("button", { name: /^(Approve|Request changes|Reject|Choose|Merge|Stop|Send|Keep|Edit|Drop)/u })).toBeNull();
  const row = within(table).getByRole("row", { name: /Speed up the search index/u });
  expect(within(row).getByRole("img", { name: "Running" })).toBeTruthy();
  expect(row.getAttribute("aria-current")).toBe("true");
  fireEvent.keyDown(row, { key: "Enter" });
  await waitFor(() => expect(f.where.current).toBe("/app/sessions/" + ID.running));
  expect(f.request.mock.calls.every(([r]) => r.method === "GET")).toBe(true);
 } finally { f.close(); }
});
it("Inbox table J/K selects the matching preview and never exposes a send", async () => {
 const f = mount();
 try {
  const table = await screen.findByRole("table", { name: "Attention items" });
  await within(table).findByRole("button", { name: /Add a retry/u });
  const rows = within(table).getAllByRole("row").filter(row => row.querySelector("td") !== null);
  expect(rows.length).toBeGreaterThan(1);
  fireEvent.click(within(rows[0]!).getByRole("button"));
  expect(document.activeElement).toBe(rows[0]);
  fireEvent.keyDown(document.activeElement!, { key: "j" });
  expect(rows[1]!.getAttribute("aria-current")).toBe("true");
  expect(document.activeElement).toBe(rows[1]);
  fireEvent.keyDown(rows[1]!, { key: "k" });
  expect(rows[0]!.getAttribute("aria-current")).toBe("true");
  const preview = screen.getByRole("region", { name: "Inbox preview" });
  expect(within(preview).getByRole("img", { name: "Needs you" })).toBeTruthy();
  expect(within(preview).getAllByRole("button")).toHaveLength(1);
  expect(f.request.mock.calls.every(([r]) => r.method === "GET")).toBe(true);
 } finally { f.close(); }
});
it("R4 waiting without a served person has one Unknown chip and no invented reviewer", async () => {
 const f = mount("/app/inbox?tab=waiting");
 try {
  const table = await screen.findByRole("table", { name: "Attention items" });
  await within(table).findByRole("button", { name: /Document the router fallbacks/u });
  expect(within(table).getAllByRole("img", { name: "Unknown" })).toHaveLength(1);
  expect(within(table).queryByRole("img", { name: /Waiting for/u })).toBeNull();
  expect(table.textContent).not.toContain("Sam");
 } finally { f.close(); }
});
it("R1 latest task refusal withdraws the table and its selected status", async () => {
 const f = mount("/app/live?task=" + ID.running);
 try {
  await screen.findByRole("table", { name: "Work tasks" });
  f.replies["/v1/app/sessions"] = fail();
  await act(async () => { await f.query.invalidateQueries({ queryKey: ["work", "tasks"] }); });
  await waitFor(() => expect(screen.queryByRole("table", { name: "Work tasks" })).toBeNull());
  expect(screen.queryByTestId("pane-title")).toBeNull();
  expect(screen.queryByRole("img", { name: "Running" })).toBeNull();
 } finally { f.close(); }
});

it("R4 a decision sentence saying Merged never becomes merge evidence", async () => {
 const f = mount("/app/live", { "/v1/app/sessions": { status: 200, body: { tasks: [TASKS[0]] } }, "/v1/app/decisions": { status: 200, body: decisionsView([{ ...CARDS[0]!, next: { ...CARDS[0]!.next, text: "Merged" } }]) } });
 try {
  const table = await screen.findByRole("table", { name: "Work tasks" });
  expect(within(table).getByRole("img", { name: "Needs you" })).toBeTruthy();
  expect(within(table).queryByRole("img", { name: "Merged" })).toBeNull();
 } finally { f.close(); }
});
it("R4 a bare success without a current step stays Unknown rather than Checking", async () => {
 const f = mount("/app/live", { "/v1/app/sessions": { status: 200, body: { tasks: [task(ID.running, "Step not served", { status: "SUCCEEDED", workflow: undefined })] } }, "/v1/app/decisions": { status: 200, body: decisionsView([]) } });
 try {
  const table = await screen.findByRole("table", { name: "Work tasks" });
  expect(within(table).getAllByRole("img", { name: "Unknown" })).toHaveLength(1);
  expect(within(table).queryByRole("img", { name: "Checking" })).toBeNull();
 } finally { f.close(); }
});

// Reworked screens (boards 2a-2f, 10b): counts, the short peek, the 4e error block and Work wording.
it("Work tabs count only the served rows, and a failed list has no counts", async () => {
 const f = mount("/app/live");
 try {
  await screen.findByRole("table", { name: "Work tasks" });
  expect(screen.getByRole("button", { name: "All · 7" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Running · 1" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Finished · 1" })).toBeTruthy();
  f.replies["/v1/app/sessions"] = fail();
  await act(async () => { await f.query.invalidateQueries({ queryKey: ["work", "tasks"] }); });
  await screen.findByTestId("load-error");
  await waitFor(() => expect(screen.getByRole("button", { name: "All" })).toBeTruthy());
  expect(screen.getByRole("button", { name: "Running" })).toBeTruthy();
 } finally { f.close(); }
});
it("Work peek is the short peek: project, title, status, one step and Open task, with no evidence tables or step rail", async () => {
 const f = mount("/app/live?task=" + ID.checks);
 try {
  const peek = await screen.findByRole("region", { name: "Selected task" });
  await waitFor(() => expect(within(peek).getByTestId("pane-title").textContent).toBe("Rate-limit the public API"));
  expect(within(peek).getByRole("img", { name: "Blocked" })).toBeTruthy();
  expect(within(peek).getByRole("region", { name: "A check failed twice" }).textContent).toContain("Answer quality is 96.4%");
  expect(within(peek).getByRole("link", { name: "Open task" }).getAttribute("href")).toBe("/app/sessions/" + ID.checks);
  expect(within(peek).queryByRole("table")).toBeNull();
  expect(within(peek).queryByRole("list", { name: "Steps of this task" })).toBeNull();
  expect(within(peek).getByRole("button", { name: "Try another approach" })).toBeTruthy();
  expect(peek.textContent).not.toMatch(/Checked on commit|aaaaaaa|ccccccc/u);
  expect(f.request.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
  expect(f.request.mock.calls.some(([request]) => /\/(documents\/plan|evidence|events|comments)$/u.test(request.path))).toBe(true);
 } finally { f.close(); }
});
it("Work uses Work wording, with no Inbox sentence under a row", async () => {
 const f = mount("/app/live?filter=running&task=" + ID.running);
 try {
  await screen.findByRole("table", { name: "Work tasks" });
  expect(screen.getByTestId("work").textContent).not.toMatch(/No attention items shown|Nothing shown needs you/u);
  expect(screen.getByTestId("work").textContent).not.toContain("Checked on commit");
 } finally { f.close(); }
});
it("Inbox tabs show served counts, and a failed project-notices read says it was not fully checked with one 4e error block and no empty state under it", async () => {
 const f = mount("/app/inbox", { "/v1/app/sessions": { status: 200, body: { tasks: [] } }, "/v1/app/decisions": { status: 200, body: decisionsView([]) }, "/v1/app/inbox/project-notices": fail() });
 try {
  const block = await screen.findByTestId("project-notices-error");
  expect(within(block).getByRole("heading", { name: /Couldn't check project notices/u })).toBeTruthy();
  expect(within(block).getByRole("button", { name: "Check project notices again" })).toBeTruthy();
  expect(block.textContent).toContain("Ref INBOX-NOTICES-UNREAD");
  expect(within(block).getByRole("button", { name: "Copy reference" })).toBeTruthy();
  expect(screen.getByRole("button", { name: /^Needs you · not fully checked$/u })).toBeTruthy();
  expect(screen.getByTestId("inbox").textContent).not.toContain("No updates shown");
  expect(document.querySelectorAll("[data-testid=project-notices-error]")).toHaveLength(1);
 } finally { f.close(); }
});
it("Inbox with served rows has counts and no empty-updates footnote", async () => {
 const f = mount("/app/inbox");
 try {
  await screen.findByRole("table", { name: "Attention items" });
  expect(screen.getByRole("button", { name: "Needs you · 4" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Waiting on others · 1" })).toBeTruthy();
  expect(screen.queryByTestId("inbox-empty")).toBeNull();expect(screen.getByTestId("inbox").textContent).not.toContain("No updates shown");
 } finally { f.close(); }
});
it("Inbox first day (no project) says so once, with no all-clear", async () => {
 const f = mount("/app/inbox", { "/v1/app/sessions": { status: 200, body: { tasks: [] } }, "/v1/app/decisions": { status: 200, body: decisionsView([]) } });
 try {
  expect(await screen.findByRole("heading", { name: "You're not in a project yet" })).toBeTruthy();
  expect(screen.getByTestId("inbox").textContent).not.toMatch(/all caught up|Nothing needs you/u);
  expect(screen.getByTestId("inbox").textContent).toContain("can't tell yet");
 } finally { f.close(); }
});
it.each(["/app/live", "/app/inbox"])("%s access lost wipes every earlier row and shows the shared error block in full", async path => {
 const f = mount(path === "/app/live" ? "/app/live?task=" + ID.plan : "/app/inbox?item=" + ID.plan);
 try {
  await waitFor(() => expect(document.querySelector("button[data-task-id], button[data-attention-id]")).toBeTruthy());
  f.replies["/v1/app/sessions"] = fail();
  await act(async () => { await f.query.invalidateQueries({ queryKey: ["work", "tasks"] }); });
  const block = await waitFor(() => { const found = document.querySelector<HTMLElement>(".rv-qp-error"); if (found === null) throw new Error("no block"); return found; });
  for (const word of ["What happened", "What is safe", "What to do"]) expect(block.textContent).toContain(word);
  expect(block.textContent).toContain("Nothing from before is shown");
  expect(block.querySelector("svg")).toBeTruthy();
  expect(block.querySelector(".rv-button-primary")).toBeTruthy();
  expect(block.textContent).toMatch(/Ref [A-Z-]+/u);
  expect(within(block).getByRole("button", { name: "Copy reference" })).toBeTruthy();
  await waitFor(() => expect(document.querySelector("button[data-task-id], button[data-attention-id]")).toBeNull());
  expect(screen.queryByTestId("pane-title")).toBeNull();expect(screen.queryByRole("region", { name: "Inbox preview" })).toBeNull();
  expect(document.querySelector("[data-state=unknown]")).toBeNull(); // no Unknown chip stands in for the error, in the header or the block
 } finally { f.close(); }
});
