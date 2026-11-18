// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { DecisionCardsViewReaderSchema } from "@agentx/contracts/web";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ApiError } from "../../packages/ui/src/api/errors.js";
import { readDecisions } from "../../packages/ui/src/api/decisions.js";
import { readComments, readPlan, readTaskList, stageOf, stepOf, workRows, STOPPED_DROPPED_DAYS, STOPPED_TO_EARLIER_DAYS } from "../../packages/ui/src/api/work.js";
import { StepMini, StepRail } from "../../packages/ui/src/design/StepRail.js";
import { CriterionRow } from "../../packages/ui/src/screens/session/CriterionRow.js";
import { RequestStep } from "../../packages/ui/src/screens/session/RequestStep.js";
import { SteerBox } from "../../packages/ui/src/screens/session/SteerBox.js";
import { SessionScreen } from "../../packages/ui/src/screens/session/SessionScreen.js";
import { WorkScreen } from "../../packages/ui/src/screens/work/WorkScreen.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { navFixture } from "./support/fixtures.js";
import { createNoticeInvalidator } from "../../packages/ui/src/realtime/invalidate.js";
import { workspaceFixture, workspaceWorkflow } from "./support/workspace-fixture.js";
import { CARDS, EVENTS, ID, NOW, PLAN, PROOF, TASKS, decisionsView, task } from "./support/work-fixture.js";

afterEach(() => { vi.useRealTimers(); });
const SESSION = "ses_aaaaaaaaaaaaaaaaaaaa";
const rowsOf = (tasks: unknown[], cards = CARDS) => workRows(readTaskList({ tasks }), readDecisions(DecisionCardsViewReaderSchema.parse(decisionsView(cards))), NOW);
const wrap = (element: ReturnType<typeof h>, host = fakeHost()) => renderUi(h(AppHostProvider, { host: host.host, children: h(QueryClientProvider, { client: createQueryClient(), children: h(MemoryRouter, { children: h(Announcer, { children: element }) }) }) }));
const minutesAgo = (days: number) => days * 24 * 60;

// ---- The read layer: closed tasks, stopped ageing, stages ----
it("marks no step for a task closed before a pull request, and keeps the pull request step for one that has one", () => {
  const closed = readTaskList({ tasks: [task(ID.checks, "Closed early", { status: "CLOSED", workflow: { stage: "CLOSED", state: "COMPLETE", revision: 4 } }, "CLOSED", "COMPLETE")] })[0]!;
  expect(stepOf(closed)).toBe("closed");expect(stageOf("closed")).toBe("request");
  const withPull = readTaskList({ tasks: [task(ID.merge, "Closed after a PR", { status: "CLOSED", workflow: { stage: "CLOSED", state: "COMPLETE", revision: 4 }, pullRequests: [{ repository: "example/web", number: 3, state: "open" }] }, "CLOSED", "COMPLETE")] })[0]!;
  expect(stepOf(withPull)).toBe("pull_request");
  expect([stageOf("request"), stageOf("spec"), stageOf("build"), stageOf("proof"), stageOf("pull_request"), stageOf("merged")]).toEqual(["request", "spec", "build", "proof", "pull_request", "pull_request"]);
  const f = wrap(h("div", {}, h(StepRail, { step: "closed", tone: "idle" }), h(StepMini, { step: "closed", tone: "idle" })));
  expect(within(screen.getByRole("list", { name: "Steps of this task" })).getAllByRole("listitem").map(item => item.getAttribute("data-state"))).toEqual(["todo", "todo", "todo", "todo", "todo"]);
  expect(f.container.querySelector("[aria-current=step]")).toBeNull();expect(screen.getByRole("img", { name: "Closed" })).toBeTruthy();
});
it("moves a task stopped for a week out of Needs you into Stopped earlier, and drops it after a month", () => {
  const stopped = (days: number, id: string) => task(id, "Stopped " + String(days), { status: "FAILED" }, "IMPLEMENT", "BLOCKED", minutesAgo(days));
  const rows = rowsOf([stopped(2, ID.checks), stopped(STOPPED_TO_EARLIER_DAYS + 1, ID.merge), stopped(STOPPED_DROPPED_DAYS + 1, ID.question)], []);
  const byId = new Map(rows.map(row => [row.id, row]));
  expect(byId.get(ID.checks)).toMatchObject({ group: "you", need: "Stopped" });
  expect(byId.get(ID.merge)).toMatchObject({ group: "stopped", need: undefined, tone: "bad", line: "Stopped 8d ago" });
  expect(byId.has(ID.question)).toBe(false);
  expect(rows.map(row => row.group)).toEqual(["you", "stopped"]);
});
it("ages a stopped task exactly at seven and thirty days", () => {
  const at = (days: number, id: string) => task(id, "S", { status: "FAILED" }, "IMPLEMENT", "BLOCKED", Math.round(days * 24 * 60));
  const group = (days: number) => rowsOf([at(days, ID.checks)], [])[0]?.group;
  expect([group(STOPPED_TO_EARLIER_DAYS - 0.01), group(STOPPED_TO_EARLIER_DAYS), group(STOPPED_DROPPED_DAYS - 0.01), group(STOPPED_DROPPED_DAYS)]).toEqual(["you", "stopped", "stopped", undefined]);
});
it("reads a task's Cloud session id and a comment's reply link", () => {
  expect(readTaskList({ tasks: [{ ...TASKS[1], sessionId: SESSION }] })[0]!.sessionId).toBe(SESSION);
  expect(readTaskList({ tasks: [TASKS[1]] })[0]!.sessionId).toBeUndefined();
  expect(readComments({ comments: [{ commentId: "c2", text: "Yes", at: "x", author: { name: "Sam" }, replyTo: "c1", anchor: "R1.1" }] })[0]).toMatchObject({ replyTo: "c1", anchor: "R1.1" });
});

// ---- Pieces ----
it("draws the request step with where it runs and the questions Rovara asked", () => {
  const row = rowsOf([TASKS[0]!])[0]!, f = wrap(h(RequestStep, { row, plan: readPlan(PLAN) }));
  const request = screen.getByRole("region", { name: "Request" });
  expect(request.textContent).toContain("Add a retry to the billing webhook");expect(request.textContent).toContain("Quick spec");expect(request.textContent).toContain('If nobody answers, Rovara uses "No, replace it"');
  expect(screen.queryByRole("region", { name: "Spec" })).toBeNull();f.unmount();
  wrap(h(RequestStep, { row, plan: undefined }));expect(screen.getByRole("region", { name: "Request" }).textContent).not.toContain("Questions Rovara asked");
});
it("sends a steering note, keeps the draft and says why when it is refused, and says when the task cannot be steered", async () => {
  const send = vi.fn<(text: string) => Promise<void>>(async () => { throw new ApiError(409, "CONFLICT", "Messages to the agent aren't available in Rovara Cloud yet."); });
  const f = wrap(h(SteerBox, { steer: { kind: "send", send }, label: "T2" }));
  const box = screen.getByRole<HTMLInputElement>("textbox", { name: "Steer this task" });
  fireEvent.change(box, { target: { value: "use the helper" } });fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect((await screen.findByTestId("steer-error")).textContent).toContain("aren't available in Rovara Cloud yet");expect(send).toHaveBeenCalledWith("use the helper");expect(box.value).toBe("use the helper");
  send.mockImplementationOnce(async () => undefined);fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(box.value).toBe(""));expect(screen.getByRole("status").textContent).toBe("Sent.");
  f.unmount();wrap(h(SteerBox, { steer: { kind: "unavailable", why: "Steering works for tasks started in Rovara Cloud." }, label: "T2" }));
  expect(screen.getByTestId("steer-unavailable").textContent).toContain("started in Rovara Cloud");expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
});
it("pins a comment to a criterion, threads replies under their comment, and keeps the draft when the route is not connected", async () => {
  const plan = readPlan(PLAN), criterion = plan.requirements[0]!.criteria[0]!;
  const comments = [
    { commentId: "c1", author: "Owen", text: "Count retries", at: "x", resolved: false, anchor: "R1.1", replyTo: undefined },
    { commentId: "c2", author: "Sam", text: "Three is enough", at: "y", resolved: false, anchor: "R1.1", replyTo: "c1" },
  ];
  const onComment = vi.fn<(anchor: string, text: string, replyTo?: string) => Promise<void>>(async () => { throw new Error("/v1/app/tasks/x/comments isn't connected to Rovara Code yet."); });
  const f = wrap(h(CriterionRow, { criterion, comments, onComment }));
  const thread = f.container.querySelector(".rv-criterion-thread")!;
  expect(thread.querySelectorAll("[data-comment]")).toHaveLength(2);expect(thread.querySelector(".reply")?.textContent).toContain("Sam");
  fireEvent.click(screen.getByRole("button", { name: /Reply to Owen/u }));
  fireEvent.change(screen.getByRole("textbox", { name: "Reply about R1.1" }), { target: { value: "Agreed" } });fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect((await screen.findByTestId("comment-error")).textContent).toContain("isn't connected to Rovara Code yet");
  expect(onComment).toHaveBeenCalledWith("R1.1", "Agreed", "c1");expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Reply about R1.1" }).value).toBe("Agreed");
  onComment.mockImplementationOnce(async () => undefined);fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: /Comment on R1.1/u }));expect(screen.getByRole("textbox", { name: "Comment on R1.1" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));expect(screen.queryByRole("textbox")).toBeNull();
  // Without a handler nothing offers to comment.
  f.unmount();wrap(h(CriterionRow, { criterion, comments }));expect(screen.queryByRole("button", { name: /Comment on/u })).toBeNull();
});

// ---- The page ----
interface Setup { path: string; tasks?: unknown[]; session?: unknown; sessionStatus?: number; cards?: unknown; send?: (request: ApiRequest) => Promise<ApiResponse>; tasksResponse?: ApiResponse; wikiUse?: { given: string[]; read: string[] } }
function pageSetup(options: Setup) {
  const f = fakeHost(async request => {
    const path = request.path.split("?")[0]!;
    if (request.method !== "GET") {
      if (path.endsWith("/presence")) return { status: 200, body: { viewingNow: [] } };
      return options.send ? options.send(request) : { status: 200, body: {} };
    }
    if (path === "/v1/app/sessions") return options.tasksResponse ?? { status: 200, body: { tasks: options.tasks ?? TASKS } };
    if (path === "/v1/app/decisions") return { status: 200, body: options.cards ?? decisionsView() };
    if (path === "/v1/app/nav") return { status: 200, body: navFixture({ projects: [] }) };
    if (path === `/v1/app/tasks/${ID.plan}/lessons`) return { status: 200, body: { lessons: [], ...(options.wikiUse === undefined ? {} : { wikiUse: options.wikiUse }) } };
    if (path === "/v1/app/projects/web/wiki") return { status: 200, body: { project: "web", state: "ready", pages: [{ pageId: "wiki-overview", kind: "overview", title: "<img src=x onerror=alert(1)>\u0001", summary: "", order: 0, repos: [], writtenAt: "2026-01-01T00:00:00.000Z", claims: { found: 0, changed: 0 }, flagged: false }] } };
    if (path.startsWith("/v1/app/sessions/ses_")) return path.endsWith("/events") || path.endsWith("/messages") ? { status: 200, body: path.endsWith("/events") ? { events: [] } : { messages: [] } } : options.sessionStatus !== undefined && options.sessionStatus !== 200 ? { status: options.sessionStatus, body: { error: { code: "NOT_FOUND", message: "That session isn't here." } } } : { status: 200, body: { session: options.session } };
    if (path.endsWith("/documents/plan")) return { status: 200, body: PLAN };
    if (path.endsWith("/evidence")) return { status: 200, body: PROOF };
    if (path.endsWith("/events")) return { status: 200, body: EVENTS };
    if (path.endsWith("/comments")) return { status: 200, body: { comments: [] } };
    return { status: 404, body: { error: { code: "NOT_FOUND", message: "no" } } };
  });
  const query = createQueryClient(), where: { current: string } = { current: "" };
  const Where = () => { where.current = useLocation().pathname + useLocation().search;return null; };
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: [options.path], children: h(Announcer, { children: h("div", {}, h(Where, {}), h(Routes, {}, h(Route, { path: "/app/sessions/:id", element: h(SessionScreen, {}) }), h(Route, { path: "/app/live", element: h(WorkScreen, {}) }))) }) }) }) }));
  return { ...f, ...ui, query, where, close() { ui.unmount();query.clear(); } };
}
const taskWithSession = { ...TASKS[1]!, sessionId: SESSION };

it("hides wiki use when empty and renders an unsafe title as visible text with a page-specific wiki link", async () => {
  const absent = pageSetup({ path: `/app/sessions/${ID.plan}` });
  await screen.findByTestId("session-title");
  await waitFor(() => expect(absent.request.mock.calls.some(([request]) => request.path.endsWith(`/tasks/${ID.plan}/lessons`))).toBe(true));
  expect(screen.queryByTestId("wiki-task-use")).toBeNull();
  absent.close();

  const empty = pageSetup({ path: `/app/sessions/${ID.plan}`, wikiUse: { given: ["wiki-overview"], read: [] } });
  await screen.findByTestId("session-title");
  await waitFor(() => expect(empty.request.mock.calls.some(([request]) => request.path.endsWith(`/tasks/${ID.plan}/lessons`))).toBe(true));
  expect(screen.queryByTestId("wiki-task-use")).toBeNull();
  empty.close();

  const f = pageSetup({ path: `/app/sessions/${ID.plan}`, wikiUse: { given: ["wiki-overview"], read: ["wiki-overview"] } });
  const card = await screen.findByTestId("wiki-task-use");
  const link = within(card).getByRole("link");
  await waitFor(() => expect(link.textContent).toContain("<img src=x onerror=alert(1)>"));
  expect(link.textContent).toContain("<img src=x onerror=alert(1)>");
  expect(link.textContent).toContain("[U+0001]");
  expect(card.querySelector("img")).toBeNull();
  expect(link.getAttribute("href")).toBe("/app/projects/web?tab=wiki&page=wiki-overview");
  f.close();
});

it("opens a task by its own id at full width: title, steps, the decision, the spec, cost, and no steer or stop for a task Cloud did not start", async () => {
  const f = pageSetup({ path: `/app/sessions/${ID.plan}` });
  expect((await screen.findByTestId("session-title")).textContent).toBe("Add a retry to the billing webhook");
  const pane = await screen.findByRole("article", { name: /^Task: / });expect(pane.className).toContain("wide");
  expect(within(pane).getByRole("list", { name: "Steps of this task" })).toBeTruthy();expect(await within(pane).findByRole("region", { name: "Your decision" })).toBeTruthy();
  expect((await within(pane).findByRole("region", { name: "Spec" })).textContent).toContain("R1.1");expect(within(pane).getByRole("region", { name: "Cost" })).toBeTruthy();
  expect(screen.getByTestId("stop-unavailable").textContent).toContain("started in Rovara Cloud");
  expect(screen.getByRole("link", { name: "Back to Work" }).getAttribute("href")).toBe("/app/live?task=" + ID.plan);
  expect(document.querySelector("details.rv-task-more")).toBeNull();
  f.close();
});
it("steps show their own stage: Request is the request, Pull request says when there is none, Build puts the steer box under the running task", async () => {
  const f = pageSetup({ path: `/app/sessions/${ID.plan}` });
  const rail = await screen.findByRole("list", { name: "Steps of this task" });
  fireEvent.click(within(rail).getByRole("button", { name: /^Request/u }));
  const request = await screen.findByRole("region", { name: "Request" });expect(request.textContent).toContain("Questions Rovara asked");expect(screen.queryByRole("region", { name: "Spec" })).toBeNull();
  fireEvent.click(within(rail).getByRole("button", { name: /^Pull request/u }));
  expect((await screen.findByTestId("no-pull-request")).textContent).toContain("No pull request yet");expect(screen.getByRole("region", { name: "Proof" })).toBeTruthy();
  fireEvent.click(within(rail).getByRole("button", { name: /^Build/u }));
  const build = await screen.findByRole("region", { name: "Build" });expect(within(build).getByRole("log").textContent).toContain("Writing the dead-letter writer");
  expect(within(build).queryByRole("form", { name: /^Steer/u })).toBeNull(); // this task is waiting on its plan, not running
  f.close();
});
it("a running task opened by its id says steering works only for tasks Cloud started", async () => {
  const f = pageSetup({ path: `/app/sessions/${ID.running}` });
  await screen.findByTestId("session-title");fireEvent.click(within(await screen.findByRole("list", { name: "Steps of this task" })).getByRole("button", { name: /^Build/u }));
  expect((await screen.findByTestId("steer-unavailable")).textContent).toContain("started in Rovara Cloud");
  f.close();
});
it("opens a session's task by the session address: controls, the steer box that posts a steering note, and the earlier tabs behind a disclosure", async () => {
  const running = { ...workspaceWorkflow(), stage: "IMPLEMENT", state: "RUNNING" };
  const session = workspaceFixture({ title: "Add a retry to the billing webhook", status: "running", you: { level: "edit", owner: true, following: false, actions: ["watch", "comment", "stop", "close"] } }, { title: "Add a retry to the billing webhook", status: "RUNNING", workflow: running });
  const send = vi.fn(async (request: ApiRequest): Promise<ApiResponse> => (request.path.endsWith("/messages") ? { status: 409, body: { error: { code: "CONFLICT", message: "Messages to the agent aren't available in Rovara Cloud yet." } } } : { status: 200, body: {} }));
  const f = pageSetup({ path: `/app/sessions/${SESSION}`, session, cards: decisionsView([]), send });
  await screen.findByTestId("session-title");
  expect(await screen.findByRole("button", { name: "Stop" })).toBeTruthy();expect(screen.getByRole("button", { name: "Conversation" })).toBeTruthy();expect(screen.getByRole("button", { name: "Continue in my tool" })).toBeTruthy();
  fireEvent.click(within(await screen.findByRole("list", { name: "Steps of this task" })).getByRole("button", { name: /^Build/u }));
  const box = await screen.findByRole<HTMLInputElement>("textbox", { name: "Steer this task" });
  fireEvent.change(box, { target: { value: "use the existing helper" } });fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect((await screen.findByTestId("steer-error")).textContent).toContain("aren't available in Rovara Cloud yet");
  const call = send.mock.calls.find(([request]) => request.path.endsWith("/messages"))![0];expect(call.path).toBe(`/v1/app/sessions/${SESSION}/messages`);expect(call.body).toMatchObject({ kind: "steer", text: "use the existing helper" });
  const more = document.querySelector<HTMLDetailsElement>("details.rv-task-more")!;expect(more.open).toBe(false);expect(within(more).getByText("More about this task")).toBeTruthy();
  f.close();
});
it("opens a task that has a Cloud session by its id, and reads the session for the controls", async () => {
  const session = workspaceFixture({}, { title: "Add a retry to the billing webhook" });
  const f = pageSetup({ path: `/app/sessions/${ID.plan}`, tasks: [{ ...TASKS[0]!, sessionId: SESSION }, ...TASKS.slice(1)], session });
  await screen.findByTestId("session-title");
  await waitFor(() => expect(f.request.mock.calls.some(([request]) => request.path === `/v1/app/sessions/${SESSION}`)).toBe(true));
  expect(await screen.findByRole("button", { name: "Conversation" })).toBeTruthy();expect(screen.queryByTestId("stop-unavailable")).toBeNull();
  f.close();
});
it("says a task is not found for an address nobody has, an unlisted task id, or a session Cloud does not know", async () => {
  const a = pageSetup({ path: "/app/sessions/not-a-task" });expect(await screen.findByTestId("not-found")).toBeTruthy();a.close();
  const b = pageSetup({ path: "/app/sessions/99999999-9999-4999-8999-999999999999" });expect(await screen.findByTestId("not-found")).toBeTruthy();b.close();
  const c = pageSetup({ path: `/app/sessions/${SESSION}`, sessionStatus: 404 });expect(await screen.findByTestId("not-found")).toBeTruthy();c.close();
});
it("says plainly when the task list is not connected, never a spinner, and offers another try", async () => {
  const f = pageSetup({ path: `/app/sessions/${ID.plan}`, tasksResponse: { status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "/v1/app/sessions isn't connected to Rovara Code yet." } } } });
  expect((await screen.findByTestId("load-error")).textContent).toContain("isn't connected to Rovara Code yet");expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();expect(screen.queryByRole("progressbar")).toBeNull();
  f.close();
});
it("says Continue in my tool is not connected yet when Code does not serve it, and Cloud's words for a refused comment", async () => {
  const notYet = (path: string): ApiResponse => ({ status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: `/v1/app${path} isn't connected to Rovara Code yet.` } } });
  const send = vi.fn(async (request: ApiRequest): Promise<ApiResponse> => notYet(request.path.replace("/v1/app", "")));
  const f = pageSetup({ path: `/app/sessions/${ID.plan}`, send });
  fireEvent.click(await screen.findByRole("button", { name: "Continue in my tool" }));
  expect((await screen.findByTestId("continue-message")).textContent).toContain("isn't connected to Rovara Code yet");expect(send.mock.calls[0]![0].path).toBe(`/v1/app/tasks/${ID.plan}/continue/publish-branch`);
  const spec = await screen.findByRole("region", { name: "Spec" });fireEvent.click(within(spec).getAllByRole("button", { name: /Comment on R1.1/u })[0]!);
  fireEvent.change(screen.getByRole("textbox", { name: "Comment on R1.1" }), { target: { value: "Count the retries" } });fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect((await screen.findByTestId("comment-error")).textContent).toContain("isn't connected to Rovara Code yet");
  expect(send.mock.calls.find(([request]) => request.path.endsWith("/comments"))![0].body).toMatchObject({ document: "plan", anchor: "R1.1", text: "Count the retries" });
  f.close();
});
it("keeps Design first on the plan card of the page, and the decision card is drawn once (the earlier tabs hold no second copy)", async () => {
  const session = workspaceFixture({}, { title: "Add a retry to the billing webhook", designActions: { designFirst: true, hint: true } });
  const f = pageSetup({ path: `/app/sessions/${SESSION}`, session });
  const card = await screen.findByRole("region", { name: "Your decision" });
  expect(within(card).getByRole("button", { name: "Design first" })).toBeTruthy();expect(screen.getByRole("region", { name: "Design review actions" })).toBeTruthy();
  const more = document.querySelector<HTMLDetailsElement>("details.rv-task-more")!;expect(within(more).queryByRole("region", { name: "Your decision" })).toBeNull();expect(screen.getAllByRole("region", { name: "Your decision" })).toHaveLength(1);
  f.close();
});
it("opens the earlier tabs by themselves when a task waits on a person and has no decision card", async () => {
  const f = pageSetup({ path: `/app/sessions/${SESSION}`, session: workspaceFixture({}, { title: "Add a retry to the billing webhook" }), cards: decisionsView([]) });
  await screen.findByTestId("session-title");
  await waitFor(() => expect(document.querySelector<HTMLDetailsElement>("details.rv-task-more")!.open).toBe(true));
  f.close();
});
it("says so when the session of a task opened by its id could not be read, and keeps the rest of the page", async () => {
  const f = pageSetup({ path: `/app/sessions/${ID.running}`, tasks: [{ ...TASKS[1]!, sessionId: SESSION }, ...TASKS.filter(entry => entry.taskId !== ID.running)], sessionStatus: 403 });
  expect((await screen.findByTestId("controls-error")).textContent).toContain("Couldn't load this task's controls");
  expect(screen.getByTestId("session-title").textContent).toBe("Speed up the search index");
  fireEvent.click(within(await screen.findByRole("list", { name: "Steps of this task" })).getByRole("button", { name: /^Build/u }));
  expect((await screen.findByTestId("steer-unavailable")).textContent).toContain("controls could not be loaded");expect(screen.queryByText(/Only the person who started/u)).toBeNull();
  f.close();
});
it("a closed task page marks no step, offers no Continue and no steering note", async () => {
  const closed = task("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "Try the new queue library", { status: "CLOSED" }, "CLOSED", "COMPLETE", 60);
  const f = pageSetup({ path: "/app/sessions/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", tasks: [...TASKS, closed] });
  await screen.findByTestId("session-title");
  const rail = await screen.findByRole("list", { name: "Steps of this task" });
  expect(within(rail).getAllByRole("listitem").every(item => item.getAttribute("data-state") === "todo")).toBe(true);
  expect(await screen.findByRole("region", { name: "Request" })).toBeTruthy();expect(screen.queryByRole("button", { name: "Continue in my tool" })).toBeNull();expect(screen.queryByTestId("stop-unavailable")).toBeNull();
  f.close();
});
it("a stopped task's page says what can be done from the page itself", async () => {
  const stopped = task("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Migrate the queue worker", { status: "FAILED" }, "IMPLEMENT", "BLOCKED", minutesAgo(10));
  const f = pageSetup({ path: "/app/sessions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", tasks: [...TASKS, stopped] });
  const quiet = await screen.findByTestId("decision-quiet");
  expect(quiet.textContent).toContain("Continue it in your tool from the button above");expect(quiet.textContent).not.toContain("Open the full page");
  f.close();
});
it("moves focus into the comment form, and back to its button when it closes", async () => {
  const plan = readPlan(PLAN), criterion = plan.requirements[0]!.criteria[0]!;
  wrap(h(CriterionRow, { criterion, onComment: async () => undefined }));
  fireEvent.click(screen.getByRole("button", { name: "Comment on R1.1" }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Comment on R1.1" })));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Comment on R1.1" })));
});
it("has no accessibility violations on the task page", async () => {
  const f = pageSetup({ path: `/app/sessions/${ID.plan}` });await screen.findByRole("region", { name: "Spec" });await expectNoAxeViolations(document.body);f.close();
});

// ---- Work: the way in, and Stopped earlier ----
it("Work links each task to its page (a Cloud task by its session) and o opens the selected task from the list", async () => {
  const f = pageSetup({ path: `/app/live?task=${ID.running}`, tasks: [taskWithSession, ...TASKS.filter(entry => entry.taskId !== ID.running)] });
  const link = await screen.findByRole("link", { name: /Open the full page/u });expect(link.getAttribute("href")).toBe(`/app/sessions/${SESSION}`);
  const row = document.querySelector<HTMLElement>(`[data-task-id="${ID.running}"].rv-inbox-row`)!;row.focus();fireEvent.keyDown(row, { key: "o" });
  await waitFor(() => expect(f.where.current).toBe(`/app/sessions/${SESSION}`));
  f.close();
});
it("lists a task stopped for over a week under Stopped earlier, with how long, and not under Needs you", async () => {
  // The page ages tasks against the real clock; the fixture's tasks are dated from NOW, so pin the clock there (only Date:
  // timers stay real for the page's async reads). Unpinned, this failed once the wall clock passed NOW by half a day.
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  const old = task("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Upgrade the date library", { status: "FAILED" }, "IMPLEMENT", "BLOCKED", minutesAgo(10));
  const f = pageSetup({ path: "/app/live", tasks: [...TASKS, old] });
  const group = await screen.findByRole("region", { name: "Stopped earlier" });
  expect(group.textContent).toContain("Upgrade the date library");expect(group.textContent).toContain("Stopped 10d ago");
  expect(within(screen.getByRole("list", { name: "Needs you" })).queryByText("Upgrade the date library")).toBeNull();
  fireEvent.click(within(group).getByRole("button", { name: /Upgrade the date library/u }));
  await waitFor(() => expect(screen.getByTestId("decision-quiet").textContent).toContain("Stopped 10d ago"));expect(screen.getByTestId("decision-quiet").textContent).toContain("close it, or continue it in your tool");
  f.close();
});

it("reads the work again once, after a pause, when a session updates (the build activity, proof and comments change with it)", async () => {
  vi.useFakeTimers();
  const query = createQueryClient(), invalidate = vi.spyOn(query, "invalidateQueries").mockResolvedValue(undefined), apply = createNoticeInvalidator(query);
  for (let revision = 1; revision <= 5; revision++) apply.notice({ type: "session.updated", sessionId: SESSION, revision });
  const calls = (key: string) => invalidate.mock.calls.filter(([input]) => JSON.stringify(input?.queryKey) === JSON.stringify([key])).length;
  expect(calls("work")).toBe(0);
  await vi.advanceTimersByTimeAsync(1000);
  expect(calls("work")).toBe(1);expect(calls("live")).toBe(1);
  apply.stop();query.clear();
});

// L4-U5: the one quiet evidence line about the project's setup, from Code's task, under the banners; absent when there was no drift.
it("shows the setup's evidence line once, as plain text, when Rovara re-checked the setup for the task, and nothing otherwise", async () => {
  const line = "Setup re-checked after dependency files changed: still works.";
  const f = pageSetup({ path: `/app/sessions/${SESSION}`, session: workspaceFixture({}, { title: "Add a retry to the billing webhook", setupRecheck: line }), cards: decisionsView([]) });
  expect((await screen.findByTestId("task-setup-evidence")).textContent).toBe(line);
  expect(screen.getAllByTestId("task-setup-evidence")).toHaveLength(1);
  f.close();
  const none = pageSetup({ path: `/app/sessions/${SESSION}`, session: workspaceFixture({}, { title: "Add a retry to the billing webhook" }), cards: decisionsView([]) });
  await screen.findByTestId("session-title");
  expect(screen.queryByTestId("task-setup-evidence")).toBeNull();
  none.close();
  const markup = pageSetup({ path: `/app/sessions/${SESSION}`, session: workspaceFixture({}, { title: "Add a retry to the billing webhook", setupRecheck: "Couldn't re-check setup <img src=x onerror=alert(1)>" }), cards: decisionsView([]) });
  const shown = await screen.findByTestId("task-setup-evidence");
  expect(shown.querySelector("img")).toBeNull();
  expect(shown.textContent).toContain("<img src=x onerror=alert(1)>");
  markup.close();
});
