import { TaskPane } from "../../packages/ui/src/screens/work/TaskPane.js";
// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { DecisionCardsViewReaderSchema, SessionResponseReaderSchema } from "@agentx/contracts/web";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ApiError } from "../../packages/ui/src/api/errors.js";
import { readDecisions } from "../../packages/ui/src/api/decisions.js";
import { readComments, readPlan, readTaskList, stageOf, stepOf, workRows, STOPPED_DROPPED_DAYS, STOPPED_TO_EARLIER_DAYS } from "../../packages/ui/src/api/work.js";
import { StepMini, StepRail } from "../../packages/ui/src/design/StepRail.js";
import { CriterionRow } from "../../packages/ui/src/screens/session/CriterionRow.js";
import { SpecStep } from "../../packages/ui/src/screens/session/SpecStep.js";
import { RequestStep } from "../../packages/ui/src/screens/session/RequestStep.js";
import { SteerBox } from "../../packages/ui/src/screens/session/SteerBox.js";
import { SessionScreen } from "../../packages/ui/src/screens/session/SessionScreen.js";
import { WorkScreen } from "../../packages/ui/src/screens/work/WorkScreen.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { meFixture, navFixture } from "./support/fixtures.js";
import { createNoticeInvalidator } from "../../packages/ui/src/realtime/invalidate.js";
import { understandSession } from "./support/understand-fixture.js";
import { workspaceFixture, workspaceWorkflow } from "./support/workspace-fixture.js";
import { CARDS, EVENTS, ID, NOW, PLAN, PROOF, QUESTION_SESSION, TASKS, decisionsView, task } from "./support/work-fixture.js";

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
  expect((await screen.findByTestId("comment-error")).textContent).toContain("/v1/app/tasks/x/comments isn't connected to Rovara Code yet.");
  expect(onComment).toHaveBeenCalledWith("R1.1", "Agreed", "c1");expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Reply about R1.1" }).value).toBe("Agreed");
  onComment.mockImplementationOnce(async () => undefined);fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: /Comment on R1.1/u }));expect(screen.getByRole("textbox", { name: "Comment on R1.1" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));expect(screen.queryByRole("textbox")).toBeNull();
  // Without a handler nothing offers to comment.
  f.unmount();wrap(h(CriterionRow, { criterion, comments }));expect(screen.queryByRole("button", { name: /Comment on/u })).toBeNull();
});
it("uses the F318 catalogue notice only for an explicit not-served comment answer", async () => {
  const criterion = readPlan(PLAN).requirements[0]!.criteria[0]!;
  const f = wrap(h(CriterionRow, { criterion, comments: [], onComment: async () => { throw new ApiError(501, "NOT_ON_CODE_YET", "Comments are not available."); } }));
  fireEvent.click(screen.getByRole("button", { name: /Comment on R1.1/u }));
  fireEvent.change(screen.getByRole("textbox", { name: "Comment on R1.1" }), { target: { value: "Please clarify" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect((await screen.findByTestId("criterion-comment-unavailable")).textContent).toContain("The plan was not changed.");
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Comment on R1.1" }).value).toBe("Please clarify");
  f.unmount();
});

// ---- The page ----
interface Setup { path: string; tasks?: unknown[]; session?: unknown; sessionStatus?: number; cards?: unknown; send?: (request: ApiRequest) => Promise<ApiResponse>; tasksResponse?: ApiResponse; decisionsRead?: (request: ApiRequest) => Promise<ApiResponse>; identityRead?: (read: number) => ApiResponse; wikiUse?: { given: string[]; read: string[] }; planRead?: () => unknown }
function pageSetup(options: Setup) {
  let decisionsFailure: ApiResponse | undefined, planFailure: ApiResponse | undefined, identityReads = 0;
  const f = fakeHost(async request => {
    const path = request.path.split("?")[0]!;
    if (request.method !== "GET") {
      if (path.endsWith("/presence")) return { status: 200, body: { viewingNow: [] } };
      return options.send ? options.send(request) : { status: 200, body: {} };
    }
    if (path === "/v1/app/sessions") return options.tasksResponse ?? { status: 200, body: { tasks: options.tasks ?? TASKS } };
    if (path === "/v1/app/decisions") return decisionsFailure ?? options.decisionsRead?.(request) ?? { status: 200, body: options.cards ?? decisionsView() };
    if (path === "/v1/app/me") return options.identityRead?.(++identityReads) ?? { status: 200, body: { developer: { id: "a".repeat(64), name: "Member", orgRole: "owner" }, org: { orgId: "o-aaaaaaaaaaaaaaaaaaaa", name: "Example", plan: "starter" }, identities: [] } };
    if (path === "/v1/app/nav") return { status: 200, body: navFixture({ projects: [] }) };
    if (path === `/v1/app/projects/web/tasks/${ID.plan}/lessons`) return { status: 200, body: { lessons: [], ...(options.wikiUse === undefined ? {} : { wikiUse: options.wikiUse }) } };
    if (path === "/v1/app/projects/web/wiki") return { status: 200, body: { project: "web", state: "ready", agentsEnabled: true, pages: [{ pageId: "wiki-overview", kind: "overview", title: "<img src=x onerror=alert(1)>\u0001", summary: "", order: 0, repos: [], writtenAt: "2026-01-01T00:00:00.000Z", claims: { found: 0, changed: 0 }, flagged: false }] } };
    if (path.startsWith("/v1/app/sessions/ses_")) return path.endsWith("/events") || path.endsWith("/messages") ? { status: 200, body: path.endsWith("/events") ? { events: [] } : { messages: [] } } : options.sessionStatus !== undefined && options.sessionStatus !== 200 ? { status: options.sessionStatus, body: { error: { code: "NOT_FOUND", message: "That session isn't here." } } } : { status: 200, body: { session: options.session } };
    if (path.endsWith("/documents/plan")) return planFailure ?? { status: 200, body: options.planRead?.() ?? PLAN };
    if (path.endsWith("/evidence")) return { status: 200, body: PROOF };
    if (path.endsWith("/events")) return { status: 200, body: EVENTS };
    if (path.endsWith("/comments")) return { status: 200, body: { comments: [] } };
    return { status: 404, body: { error: { code: "NOT_FOUND", message: "no" } } };
  });
  const query = createQueryClient(), where: { current: string } = { current: "" };
  const Where = () => { where.current = useLocation().pathname + useLocation().search;return null; };
  const mount = () => renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: [options.path], children: h(Announcer, { children: h("div", {}, h(Where, {}), h(Routes, {}, h(Route, { path: "/app/sessions/:id", element: h(SessionScreen, {}) }), h(Route, { path: "/app/live", element: h(WorkScreen, {}) }))) }) }) }) }));
  let ui = mount();
  return { ...f, ...ui, query, where, failDecisions(response: ApiResponse) { decisionsFailure = response; }, failPlan(response: ApiResponse) { planFailure = response; }, remount() { ui.unmount();query.clear();ui = mount(); }, close() { ui.unmount();query.clear(); } };
}
const taskWithSession = { ...TASKS[1]!, sessionId: SESSION };

it("names the plan version on the task-page approve action and follows the latest read", async () => {
  let planVersion: number | undefined = 1;
  const f = pageSetup({ path: `/app/sessions/${ID.plan}`, planRead: () => ({ ...PLAN, version: planVersion }) });
  const card = await screen.findByRole("region", { name: "Your decision" });
  const spec = await screen.findByRole("region", { name: "Spec" });
  expect(spec.textContent).toContain("v1 ·");
  expect(within(card).getByRole("button", { name: "Approve plan v1" })).toBeTruthy();

  planVersion = 2;
  await f.query.invalidateQueries({ queryKey: ["work", "plan", ID.plan], exact: true });
  await waitFor(() => expect(spec.textContent).toContain("v2 ·"));
  expect(within(card).getByRole("button", { name: "Approve plan v2" })).toBeTruthy();

  planVersion = undefined;
  await f.query.invalidateQueries({ queryKey: ["work", "plan", ID.plan], exact: true });
  await waitFor(() => expect(spec.textContent).toContain("requirement, 2 criteria"));
  expect(within(card).getByRole("button", { name: "Approve plan" })).toBeTruthy();
  expect(within(card).queryByRole("button", { name: /v\?/u })).toBeNull();
  f.close();
});

it("drops cached approval and plan content after their latest reads fail", async () => {
  const f = pageSetup({ path: `/app/sessions/${ID.plan}`, session: workspaceFixture({}, { title: "Add refunds endpoint" }) });
  const card = await screen.findByRole("region", { name: "Your decision" });
  expect(within(card).getByRole("button", { name: "Approve plan v1" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Add a retry to the billing webhook", level: 1 })).toBeTruthy();
  f.failDecisions({ status: 403, body: { error: { code: "FORBIDDEN", message: "This decision is unavailable." } } });
  f.failPlan({ status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "The plan is not connected yet." } } });
  await Promise.all([f.query.invalidateQueries({ queryKey: ["decisions"], exact: true }), f.query.invalidateQueries({ queryKey: ["work", "plan", ID.plan], exact: true })]);
  await waitFor(() => expect(screen.queryByRole("button", { name: "Approve plan v1" })).toBeNull());
  expect(screen.queryByText("One small change, one new test")).toBeNull();
  expect(screen.getByRole("alert").textContent).toMatch(/latest plan couldn't be read/i);
  f.close();
});

it("drops cached Work decisions after the latest decision read is refused", async () => {
  const f = pageSetup({ path: `/app/live?task=${ID.plan}` });
  await screen.findByRole("button", { name: "Approve plan v1" });
  f.failDecisions({ status: 403, body: { error: { code: "FORBIDDEN", message: "This decision is unavailable." } } });
  f.remount();
  expect((await screen.findByTestId("decisions-unavailable")).textContent).toContain("This decision is unavailable");
  await waitFor(() => expect(screen.queryByRole("button", { name: "Approve plan v1" })).toBeNull());
  f.close();
});

it("does not dispatch when an older approval read finishes after a newer refusal", async () => {
  let reads = 0, resolveOlder!: (response: ApiResponse) => void;
  const f = pageSetup({ path: `/app/live?task=${ID.plan}`, decisionsRead: async () => {
    reads++;
    if (reads === 2) return new Promise<ApiResponse>(resolve => { resolveOlder = resolve; });
    if (reads === 3) return { status: 403, body: { error: { code: "FORBIDDEN", message: "This decision is unavailable." } } };
    return { status: 200, body: decisionsView() };
  } });
  fireEvent.click(await screen.findByRole("button", { name: "Approve plan v1" }));
  await waitFor(() => expect(reads).toBe(2));
  await f.query.invalidateQueries({ queryKey: ["decisions"], exact: true });
  await screen.findByTestId("decisions-unavailable");
  resolveOlder({ status: 200, body: decisionsView() });
  await waitFor(() => expect(f.request.mock.calls.some(([request]) => request.method === "POST" && request.path.endsWith("/approve"))).toBe(false));
  expect(f.request.mock.calls.filter(([request]) => request.method === "POST")).toHaveLength(0);
  f.close();
});

it("does not dispatch an older approval read after a newer successful empty decision feed", async () => {
  let reads = 0, resolveOlder!: (response: ApiResponse) => void;
  const f = pageSetup({ path: `/app/live?task=${ID.plan}`, decisionsRead: async () => {
    reads++;
    if (reads === 2) return new Promise<ApiResponse>(resolve => { resolveOlder = resolve; });
    if (reads === 3) return { status: 200, body: decisionsView([]) };
    return { status: 200, body: decisionsView() };
  } });
  fireEvent.click(await screen.findByRole("button", { name: "Approve plan v1" }));
  await waitFor(() => expect(reads).toBe(2));
  await f.query.invalidateQueries({ queryKey: ["decisions"], exact: true });
  resolveOlder({ status: 200, body: decisionsView() });
  await waitFor(() => expect(f.request.mock.calls.some(([request]) => request.method === "POST" && request.path.endsWith("/approve"))).toBe(false));
  expect(f.request.mock.calls.filter(([request]) => request.method === "POST")).toHaveLength(0);
  f.close();
});

// A 202 needs_confirmation passes through the shared decision path to the card's confirmation handling (merge prompt / confirm link) and keeps the request; only a genuinely unknown 202 shows Check.
it.each([["the confirm link", undefined], ["the merge prompt", [{ repositoryId: "repo", number: 42, baseBranch: "main" }]]] as const)("a 202 needs_confirmation on the task page decision card shows %s and keeps the request", async (_name, merging) => {
  const confirmUrl = "https://cell.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa";
  const card = merging === undefined ? CARDS[0]! : { ...CARDS[1]!, risk: "low" as const, friction: { expandEvidenceFirst: false, freshSignIn: false, secondPerson: false } };
  const send = vi.fn(async (): Promise<ApiResponse> => ({ status: 202, body: { cardId: card.id, outcome: "needs_confirmation", confirmUrl, ...(merging === undefined ? {} : { merging }) } }));
  const f = pageSetup({ path: `/app/sessions/${card.taskId}`, cards: decisionsView([card]), send });
  fireEvent.click(await screen.findByRole("button", { name: merging === undefined ? "Approve plan v1" : "Merge" }));
  if (merging === undefined) await screen.findByRole("button", { name: "Confirm on the next page" });
  else await screen.findByText(/Merge #42 into main\?/u);
  expect(send).toHaveBeenCalledTimes(1);
  expect(f.container.textContent).not.toContain("Check this decision before trying again.");
  f.close();
});
it("a 202 that is not a confirmation request on the task page decision card is unknown: Check, no second send", async () => {
  const send = vi.fn(async (): Promise<ApiResponse> => ({ status: 202, body: { cardId: CARDS[0]!.id, outcome: "approved", remainingTabs: [] } }));
  const f = pageSetup({ path: `/app/sessions/${ID.plan}`, cards: decisionsView([CARDS[0]!]), send });
  fireEvent.click(await screen.findByRole("button", { name: "Approve plan v1" }));
  await screen.findByRole("button", { name: "Check" });
  expect(screen.queryByRole("button", { name: "Confirm on the next page" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Approve plan v1" })).toBeNull();
  expect(send).toHaveBeenCalledTimes(1);
  f.close();
});

for (const code of ["CSRF_INVALID", "CSRF_STALE"] as const) it(`removes displayed approval after a refused identity reread following ${code} and stays inert on reload`, async () => {
  const stale = { status: 403, body: { error: { code, message: "Reload your identity." } } } satisfies ApiResponse;
  const refused = { status: 403, body: { error: { code: "FORBIDDEN", message: "Your identity could not be read." } } } satisfies ApiResponse;
  let postAttempted = false;
  const f = pageSetup({ path: `/app/sessions/${ID.plan}`, send: async () => { postAttempted = true;return stale; }, identityRead: () => postAttempted ? refused : { status: 200, body: { developer: { id: "a".repeat(64), name: "Member", orgRole: "owner" }, org: { orgId: "o-aaaaaaaaaaaaaaaaaaaa", name: "Example", plan: "starter" }, identities: [] } } });
  fireEvent.click(await screen.findByRole("button", { name: "Approve plan v1" }));
  await screen.findByText("Couldn't confirm your identity. Decision controls are unavailable until it can be read.");
  expect(postAttempted).toBe(true);
  expect(screen.queryByRole("button", { name: "Approve plan v1" })).toBeNull();
  await f.query.invalidateQueries({ queryKey: ["decisions"], exact: true });
  await waitFor(() => expect(screen.queryByRole("button", { name: "Approve plan v1" })).toBeNull());
  expect(f.request.mock.calls.filter(([request]) => request.method === "POST")).toHaveLength(1);
  f.close();
});

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
  expect(within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole("link", { name: "Work" }).getAttribute("href")).toBe("/app/live?task=" + ID.plan);
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
it("reaches the running rail on the task page using only that task's served run", async () => {
  const run = { state: "RUNNING", currentStep: { id: "build", name: "Build" }, steps: [
    { id: "plan", name: "Plan", status: "done" },
    { id: "build", name: "Build", status: "running" },
    { id: "checks", name: "Checks", status: "pending" },
    { id: "review", name: "Review", status: "pending" },
    { id: "merge", name: "Merge", status: "pending" },
  ], pendingApprovals: [] };
  const f = pageSetup({ path: `/app/sessions/${ID.running}`, tasks: [{ ...TASKS[1]!, run }, ...TASKS.filter(entry => entry.taskId !== ID.running)] });
  const rail = await screen.findByRole("complementary", { name: "Where this task is" });
  expect(within(rail).getByText("Build").closest("li")?.getAttribute("aria-current")).toBe("step");
  expect(within(rail).getByText("Checks")).toBeTruthy();
  expect(within(rail).getByText("Last known step")).toBeTruthy();
  expect(screen.getByText("Plan and changes", { selector: "strong" }).closest("details")?.hasAttribute("open")).toBe(false);
  expect(screen.queryByRole("region", { name: "Run recovery" })).toBeNull();
  expect(rail.closest("[data-task-id]")?.getAttribute("data-task-id")).toBe(ID.running);
  fireEvent.click(screen.getByText("Plan and changes", { selector: "strong" }));
  fireEvent.click(within(screen.getByRole("list", { name: "Steps of this task" })).getByRole("button", { name: /^Spec/u }));
  expect(await screen.findByRole("region", { name: "Spec" })).toBeTruthy();
  f.close();
});
it("keeps the session route on its own served stages without inventing heartbeat or timing", async () => {
  const run = { state: "RUNNING", currentStep: { id: "build", name: "Build" }, steps: [
    { id: "plan", name: "Plan", status: "done" },
    { id: "build", name: "Build", status: "running" },
    { id: "checks", name: "Checks", status: "pending" },
  ], pendingApprovals: [] };
  const session = workspaceFixture({ status: "running" }, { status: "RUNNING", workflow: { ...workspaceWorkflow(), stage: "IMPLEMENT", state: "RUNNING" }, run });
  const f = pageSetup({ path: `/app/sessions/${SESSION}`, session, cards: decisionsView([]) });
  const rail = await screen.findByRole("complementary", { name: "Where this task is" });
  expect(within(rail).getByText("Last known step")).toBeTruthy();
  expect(within(rail).queryByText("Current step")).toBeNull();
  expect(within(rail).queryByText(/\d+m \d+s/u)).toBeNull();
  expect(screen.getByText("Plan and changes", { selector: "strong" }).closest("details")?.hasAttribute("open")).toBe(false);
  expect(screen.queryByText(/silent|checking it/u)).toBeNull();
  f.close();
});
it("drops cached run stages and task actions after the latest task-list read is refused", async () => {
  const options: Setup = { path: `/app/sessions/${ID.running}`, tasks: [{ ...TASKS[1]!, run: { state: "RUNNING", currentStep: { id: "build", name: "Build" }, steps: [{ id: "build", name: "Build", status: "running" }], pendingApprovals: [] } }], cards: decisionsView([]) };
  const f = pageSetup(options);
  await screen.findByRole("complementary", { name: "Where this task is" });
  options.tasksResponse = { status: 403, body: { error: { code: "FORBIDDEN", message: "Read refused" } } };
  await f.query.invalidateQueries({ queryKey: ["work", "tasks"] });
  expect(await screen.findByRole("heading", { name: "You no longer have access to this task" })).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("Your access changed or you were signed out.");
  expect(screen.queryByRole("complementary", { name: "Where this task is" })).toBeNull();
  expect(screen.queryByTestId("session-title")).toBeNull();
  expect(screen.queryByRole("button", { name: "Continue in my tool" })).toBeNull();
  expect(screen.queryByText("Current step")).toBeNull();
  f.close();
});
it("opens a session task with controls and earlier tabs, and refuses steering without the served action", async () => {
  const running = { ...workspaceWorkflow(), stage: "IMPLEMENT", state: "RUNNING" };
  const session = workspaceFixture({ title: "Add a retry to the billing webhook", status: "running", you: { level: "edit", owner: true, following: false, actions: ["watch", "comment", "stop", "close"] } }, { title: "Add a retry to the billing webhook", status: "RUNNING", workflow: running });
  const send = vi.fn(async (request: ApiRequest): Promise<ApiResponse> => (request.path.endsWith("/messages") ? { status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "Messages to the agent aren't available in Rovara Cloud yet." } } } : { status: 200, body: {} }));
  const f = pageSetup({ path: `/app/sessions/${SESSION}`, session, cards: decisionsView([]), send });
  await screen.findByTestId("session-title");
  expect(await screen.findByRole("button", { name: /^Stop/u })).toBeTruthy();expect(screen.getByRole("button", { name: "Talk to this session" })).toBeTruthy();expect(screen.getByRole("button", { name: "Continue in my tool" })).toBeTruthy();
  fireEvent.click(within(await screen.findByRole("list", { name: "Steps of this task" })).getByRole("button", { name: /^Build/u }));
  expect(screen.queryByRole("textbox", { name: "Steer this task" })).toBeNull();expect((await screen.findByTestId("steer-unavailable")).textContent).toContain("does not allow steering");
  expect(send.mock.calls.some(([request]) => request.path.endsWith("/messages"))).toBe(false);
  const more = document.querySelector<HTMLDetailsElement>("details.rv-task-more")!;expect(more.open).toBe(false);expect(within(more).getByText("More about this task")).toBeTruthy();
  f.close();
});
it("opens a task that has a Cloud session by its id, and reads the session for the controls", async () => {
  const session = workspaceFixture({}, { title: "Add a retry to the billing webhook" });
  const f = pageSetup({ path: `/app/sessions/${ID.plan}`, tasks: [{ ...TASKS[0]!, sessionId: SESSION }, ...TASKS.slice(1)], session });
  await screen.findByTestId("session-title");
  await waitFor(() => expect(f.request.mock.calls.some(([request]) => request.path === `/v1/app/sessions/${SESSION}`)).toBe(true));
  expect(await screen.findByRole("button", { name: "Talk to this session" })).toBeTruthy();expect(screen.queryByTestId("stop-unavailable")).toBeNull();
  f.close();
});
it("says a task is not found for an address nobody has, an unlisted task id, or a session Cloud does not know", async () => {
  const a = pageSetup({ path: "/app/sessions/not-a-task" });expect(await screen.findByTestId("not-found")).toBeTruthy();a.close();
  const b = pageSetup({ path: "/app/sessions/99999999-9999-4999-8999-999999999999" });expect(await screen.findByTestId("not-found")).toBeTruthy();b.close();
  const c = pageSetup({ path: `/app/sessions/${SESSION}`, sessionStatus: 404 });expect(await screen.findByTestId("not-found")).toBeTruthy();c.close();
});
it("says plainly when the task list is not connected, never a spinner, and offers another try", async () => {
  const f = pageSetup({ path: `/app/sessions/${ID.plan}`, tasksResponse: { status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "/v1/app/sessions isn't connected to Rovara Code yet." } } } });
  expect((await screen.findByRole("alert")).textContent).toContain("could not be loaded");expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();expect(screen.queryByRole("progressbar")).toBeNull();
  f.close();
});
it("restores continuation and keeps Cloud's words for a refused comment", async () => {
  const notYet = (path: string): ApiResponse => ({ status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: `/v1/app${path} isn't connected to Rovara Code yet.` } } });
  const send = vi.fn(async (request: ApiRequest): Promise<ApiResponse> => notYet(request.path.replace("/v1/app", "")));
  const f = pageSetup({ path: `/app/sessions/${ID.plan}`, send, tasks: TASKS.map(entry => entry.taskId === ID.plan ? { ...entry, workflow: { ...entry.workflow, stage: "IMPLEMENT", state: "RUNNING" } } : entry) });
  await screen.findByTestId("task-page");
  fireEvent.click(await screen.findByRole("button", { name: "Continue in my tool" }));
  expect((await screen.findByTestId("continue-message")).textContent).toContain("isn't connected to Rovara Code yet");
  expect(send.mock.calls.filter(([request]) => request.path.endsWith("/continue/publish-branch"))).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: /Spec/u }));
  const spec = await screen.findByRole("region", { name: "Spec" });fireEvent.click(within(spec).getAllByRole("button", { name: /Comment on R1.1/u })[0]!);
  fireEvent.change(screen.getByRole("textbox", { name: "Comment on R1.1" }), { target: { value: "Count the retries" } });fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect((await screen.findByTestId("criterion-comment-unavailable")).textContent).toContain("Comments on the spec are not available on this installation.");
  expect(send.mock.calls.find(([request]) => request.path.endsWith("/comments"))![0].body).toMatchObject({ document: "plan", anchor: "R1.1", text: "Count the retries" });
  f.close();
});
it("a plan waiting for approval refuses continuation before a send", async () => {
 const send = vi.fn<(request: ApiRequest) => Promise<ApiResponse>>(async () => ({ status: 202, body: { taskId: ID.plan } }));
 const f = pageSetup({ path: `/app/sessions/${ID.plan}`, send });
 await screen.findByTestId("task-page");expect(screen.queryByRole("button", { name: "Continue in my tool" })).toBeNull();expect(send).not.toHaveBeenCalled();f.close();
});
it("restores Design first and draws the decision card once (the earlier tabs hold no second copy)", async () => {
  const session = workspaceFixture({}, { title: "Add a retry to the billing webhook", designActions: { designFirst: true, hint: true } });
  const f = pageSetup({ path: `/app/sessions/${SESSION}`, session });
  await screen.findByRole("region", { name: "Your decision" });
  expect(within(screen.getByRole("region", { name: "Design review actions" })).getByRole("button", { name: "Design first" })).toBeTruthy();
  const more = document.querySelector<HTMLDetailsElement>("details.rv-task-more")!;expect(within(more).queryByRole("region", { name: "Your decision" })).toBeNull();expect(screen.getAllByRole("region", { name: "Your decision" })).toHaveLength(1);
  f.close();
});
// L4-DCS: the plan card on the task page (the "Your decision" variant) carries Code's plan choices, a run limit and Request changes, through TaskPane's wrappers.
it("holds unserved plan history quietly on the real task route without inventing a comparison or approval receipt", async () => {
  const f = pageSetup({ path: `/app/sessions/${ID.plan}` });
  await screen.findByRole("region", { name: "Spec" });
  const held = screen.getByTestId("held-plan");
  expect(within(held).getByRole("img", { name: "Unknown" })).toBeTruthy();
  expect(held.querySelector("ul")).toBeNull();
  expect(screen.queryByRole("heading", { name: /Plan v\d+ approved|Build starting|First command observed/u })).toBeNull();
  expect(screen.queryByRole("table", { name: "Supplied plan differences" })).toBeNull();
  f.close();
});
it("draws a plan card's choices on the task page, sends only what changed with Approve, and sends Request changes with the ticked comments", async () => {
  const planView = JSON.parse(readFileSync("tests/fixtures/code-decision-cards.json", "utf8").replaceAll("approve_plan:plan2", `approve_plan:${ID.plan}`).replaceAll("approve_plan/plan2", `approve_plan/${ID.plan}`).replaceAll("11111111-1111-4111-8111-111111111111", ID.plan)) as { views: Record<string, unknown> };
  const sent: ApiRequest[] = [];
  const f = pageSetup({ path: `/app/sessions/${ID.plan}`, cards: planView.views["approve_plan_with_choices"], send: async request => { sent.push(request);return { status: 200, body: { cardId: `approve_plan:${ID.plan}`, outcome: request.path.endsWith("/request-changes") ? "rejected" : "approved", remainingTabs: [] } }; } });
  const card = await screen.findByRole("region", { name: "Your decision" });
  expect(within(card).getByTestId("plan-choices")).toBeTruthy();
  const approve = within(card).getByRole<HTMLButtonElement>("button", { name: "Approve plan v1" });
  expect(approve.disabled).toBe(true);
  fireEvent.click(within(card).getByRole("radio", { name: /A new gateway/u }));
  fireEvent.click(within(card).getByRole("checkbox", { name: "What about timeouts?" }));
  fireEvent.click(within(card).getByRole("checkbox", { name: /I agree Rovara may spend up to \$5.00/u }));
  fireEvent.click(approve);
  await waitFor(() => expect(sent.filter(request => request.path.endsWith("/approve"))).toHaveLength(1));
  const approved = sent.find(request => request.path.endsWith("/approve"))!;
  expect(approved.path).toBe(`/v1/app/decisions/approve_plan/${ID.plan}/approve`);
  expect(approved.body).toMatchObject({ answers: [{ decisionId: "q1", optionId: "b", opened: true }], includedCommentIds: ["33333333-3333-4333-8333-333333333333"], acknowledgedRunLimitUsd: 5 });
  f.close();
  const g = pageSetup({ path: `/app/sessions/${ID.plan}`, cards: planView.views["approve_plan_with_choices"], send: async request => { sent.push(request);return { status: 200, body: { cardId: `approve_plan:${ID.plan}`, outcome: "rejected", remainingTabs: [] } }; } });
  const again = await screen.findByRole("region", { name: "Your decision" });
  fireEvent.click(within(again).getByRole("checkbox", { name: "Please cover the refund path" }));
  fireEvent.change(within(again).getByRole("textbox", { name: "What should change?" }), { target: { value: "Cover timeouts too." } });
  fireEvent.click(within(again).getByRole("button", { name: "Send back for changes" }));
  await waitFor(() => expect(sent.filter(request => request.path.endsWith("/request-changes"))).toHaveLength(1));
  expect(sent.find(request => request.path.endsWith("/request-changes"))!.body).toMatchObject({ reason: "Cover timeouts too.", includedCommentIds: ["44444444-4444-4444-8444-444444444444"] });
  await expectNoAxeViolations(g.container);
  g.close();
});
it("opens the earlier tabs by themselves when a task waits on a person and has no decision card", async () => {
  const f = pageSetup({ path: `/app/sessions/${SESSION}`, session: workspaceFixture({}, { title: "Add a retry to the billing webhook" }), cards: decisionsView([]) });
  await screen.findByTestId("session-title");
  await waitFor(() => expect(document.querySelector<HTMLDetailsElement>("details.rv-task-more")!.open).toBe(true));
  f.close();
});
it("says so when the session of a task opened by its id could not be read, and keeps the rest of the page", async () => {
  const f = pageSetup({ path: `/app/sessions/${ID.running}`, tasks: [{ ...TASKS[1]!, sessionId: SESSION }, ...TASKS.filter(entry => entry.taskId !== ID.running)], sessionStatus: 403 });
  expect((await screen.findByTestId("controls-error")).textContent).toContain("controls are not current");
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

for (const code of ["CSRF_INVALID", "CSRF_STALE", "UNRECOGNISED"]) it(`R3/R6a plan comment: 500/${code} keeps its frozen text and read-only Check`, async () => {
 const f = pageSetup({ path: `/app/sessions/${ID.plan}`, send: async () => ({ status: 500, body: { error: { code, message: "Unknown result" } } }) });
 const spec = await screen.findByRole("region", { name: "Spec" });
 fireEvent.click(within(spec).getByRole("button", { name: "Comment on R1.1" }));
 fireEvent.change(screen.getByRole("textbox", { name: "Comment on R1.1" }), { target: { value: "Retain this exact plan comment" } });
 const send = screen.getByRole<HTMLButtonElement>("button", { name: "Send" });fireEvent.click(send);
 const posts = () => f.request.mock.calls.filter(([r]) => r.method === "POST" && r.path.endsWith("/comments"));
 await waitFor(() => expect(posts()).toHaveLength(1));await screen.findByText(/Rovara didn't confirm this yet/);
 expect(send.matches(":disabled")).toBe(true);expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Comment on R1.1" }).value).toBe("Retain this exact plan comment");
 fireEvent.click(screen.getByRole("button", { name: "Check" }));await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
 expect(posts()).toHaveLength(1);expect(send.matches(":disabled")).toBe(true);f.close();
});
for (const code of ["CSRF_INVALID", "CSRF_STALE", "UNRECOGNISED"]) it(`R3/R6a legacy plan answer: 500/${code} removes senders and offers Check in the active section`, async () => {
 const row = rowsOf([TASKS.find(task => task.taskId === ID.question)!])[0]!;
 const session = understandSession({ revision: 2 });
 session.sessionId = QUESTION_SESSION;
 if (session.body.kind !== "task" || session.body.task.workflow?.intent === undefined) throw new Error("Expected a question round");
 session.body.task.taskId = ID.question;
 session.body.task.workflow.intent.rounds = 2;
 // The authority read uses Code's question schema; the plan below keeps its legacy IDs.
 // Only the displayed round and revision authorize this legacy adapter.
 const authority = SessionResponseReaderSchema.parse({ session });
 const f = fakeHost(async request => request.path === "/v1/app/me" ? { status: 200, body: meFixture() } : request.path === `/v1/app/sessions/${QUESTION_SESSION}` && request.method === "GET" ? { status: 200, body: authority } : request.method === "POST" ? { status: 500, body: { error: { code, message: "Unknown result" } } } : { status: 200, body: request.path.endsWith("/documents/plan") ? PLAN : request.path.endsWith("/evidence") ? PROOF : request.path.endsWith("/events") ? EVENTS : request.path.endsWith("/lessons") ? { lessons: [] } : { comments: [] } });
 const ui = wrap(h(TaskPane, { row, decisionsError: undefined, onDecided: () => undefined }), f);
 fireEvent.click(await screen.findByRole("button", { name: /^Spec,/u }));
 const spec = await screen.findByRole("region", { name: "Spec" });
 const answer = await within(spec).findByRole<HTMLButtonElement>("button", { name: "No, replace it" });await waitFor(() => expect(answer.disabled).toBe(false));fireEvent.click(answer);
 const posts = () => f.request.mock.calls.filter(([r]) => r.method === "POST" && r.path.endsWith("/answers"));
 await waitFor(() => expect(posts()).toHaveLength(1));
 await screen.findByText(/Rovara didn't confirm this yet/);
 expect(posts()[0]![0].body).toMatchObject({ round: 2, revision: 2, answers: [{ questionId: "Q1", optionId: "no" }] });
 const requests = f.request.mock.calls.map(([request]) => request);
 expect(requests.findIndex(r => r.method === "GET" && r.path === `/v1/app/sessions/${QUESTION_SESSION}`)).toBeLessThan(requests.findIndex(r => r.method === "POST" && r.path.endsWith("/answers")));
 expect(screen.queryByRole("button", { name: "No, replace it" })).toBeNull();
 fireEvent.click(screen.getByRole("button", { name: "Check" }));await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
 expect(posts()).toHaveLength(1);ui.unmount();
 const remount = wrap(h(TaskPane, { row, decisionsError: undefined, onDecided: () => undefined }), f);
 fireEvent.click(await screen.findByRole("button", { name: /^Spec,/u }));
 await screen.findByRole("region", { name: "Spec" });
 expect(screen.queryByRole("button", { name: "No, replace it" })).toBeNull();
 expect(screen.getByRole("button", { name: "Check" })).toBeTruthy();
 expect(posts()).toHaveLength(1);remount.unmount();
});
it("Spec removes inline answer senders when the caller withdraws its answer action", async () => {
 const send = vi.fn<(questionId: string, optionId: string) => Promise<void>>(async () => undefined);
 const plan = readPlan(PLAN), ui = wrap(h(SpecStep, { plan, comments: [], onAnswer: send }));
 expect(screen.getByRole("button", { name: "No, replace it" })).toBeTruthy();
 ui.rerender(h(SpecStep, { plan, comments: [] }));
 expect(screen.queryByRole("button", { name: "No, replace it" })).toBeNull();
 expect(screen.getByRole("region", { name: "Spec" })).toBeTruthy();
 expect(send).not.toHaveBeenCalled();ui.unmount();
});
