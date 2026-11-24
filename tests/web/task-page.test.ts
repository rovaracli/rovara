// @vitest-environment jsdom
import { TaskPane, planAbsentLine, planNotExpectedYet, planNotWritten, taskEndedWithoutPlan } from "../../packages/ui/src/screens/work/TaskPane.js";
import { afterEach, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { DecisionCardsViewReaderSchema, SessionResponseReaderSchema } from "@agentx/contracts/web";
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
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { meFixture } from "./support/fixtures.js";
import { createNoticeInvalidator } from "../../packages/ui/src/realtime/invalidate.js";
import { understandSession } from "./support/understand-fixture.js";
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
it("planNotWritten is true only for 404 + NOT_FOUND + the exact served message", () => {
  const e = (status: number, code: string, message: string) => new ApiError(status, code, message);
  expect(planNotWritten(e(404, "NOT_FOUND", "this task has no plan document yet"))).toBe(true);
  expect(planNotWritten(e(404, "NOT_FOUND", "this task has no plan document v3"))).toBe(false);
  expect(planNotWritten(e(404, "NOT_FOUND", "the plan document v2 was written before structured plans and has no canonical form"))).toBe(false);
  expect(planNotWritten(e(404, "NOT_FOUND", "Not found."))).toBe(false);
  expect(planNotWritten(e(404, "TASK_NOT_FOUND", "this task has no plan document yet"))).toBe(false);
  expect(planNotWritten(e(500, "NOT_FOUND", "this task has no plan document yet"))).toBe(false);
  expect(planNotWritten(e(503, "RUNTIME_UNAVAILABLE", "The plan could not be verified."))).toBe(false);
  expect(planNotWritten(e(403, "FORBIDDEN", "You can no longer read this task."))).toBe(false);
  expect(planNotWritten(new ApiError(502, "INVALID_RESPONSE", "Rovara returned an unreadable response. Reload this page."))).toBe(false);
  expect(planNotWritten(new Error("this task has no plan document yet"))).toBe(false);
  expect(planNotWritten(undefined)).toBe(false);
});
it("planNotExpectedYet: true only before a plan can exist, never with a spec decision or a pull request", () => {
  const read = (patch: Record<string, unknown>) => readTaskList({ tasks: [task(ID.plan, "T", patch, "PLAN", "RUNNING")] })[0]!;
  const specCard = readDecisions(DecisionCardsViewReaderSchema.parse(decisionsView([CARDS.find(card => card.kind === "approve_plan")!]))).find(d => d.card.kind === "approve_plan")!;
  expect(planNotExpectedYet(read({ status: "STARTING", workflow: undefined }), undefined)).toBe(true);
  expect(planNotExpectedYet(read({ workflow: { stage: "UNDERSTAND", state: "RUNNING" } }), undefined)).toBe(true);
  // PLAN is never certain-absent: changes requested, a plan-check send-back and the full path's re-entry all come back to PLAN with a plan written.
  expect(planNotExpectedYet(read({ workflow: { stage: "PLAN", state: "RUNNING" } }), undefined)).toBe(false);
  expect(planNotExpectedYet(read({ status: "STARTING", workflow: { stage: "PLAN", state: "RUNNING" } }), undefined)).toBe(false);
  expect(planNotExpectedYet(read({ workflow: { stage: "UNDERSTAND", state: "RUNNING", outcome: "CHANGES_REQUESTED" } }), undefined)).toBe(false);
  expect(planNotExpectedYet(read({ workflow: { stage: "PLAN_REVIEW", state: "WAITING" } }), undefined)).toBe(false);
  expect(planNotExpectedYet(read({ workflow: { stage: "IMPLEMENT", state: "RUNNING" } }), undefined)).toBe(false);
  expect(planNotExpectedYet(read({ status: "STARTING", workflow: undefined }), specCard)).toBe(false);
  expect(planNotExpectedYet(read({ workflow: { stage: "PLAN", state: "RUNNING" }, pullRequests: [{ repository: "example/web", number: 3, state: "open" }] }), undefined)).toBe(false);
});
// ---- EXACT: Code's served workflow artifacts say whether a plan exists; the stage is only a fallback for an answer that carries none ----
const ART = { id: "plan-1", type: "plan", version: 1, sha256: "a".repeat(64), producer: "agentx-worker-untrusted", objectKey: "tasks/x/plan-1.md", createdAt: "2026-11-23T10:00:00.000Z" };
const withArtifacts = (artifacts: unknown[] | undefined, workflow: Record<string, unknown>, status = "RUNNING") => [task(ID.plan, "Add a retry to the billing webhook", { status, workflow: { revision: 3, path: "STANDARD", ...workflow, ...(artifacts === undefined ? {} : { artifacts }) } }, String(workflow["stage"]), String(workflow["state"]), 1)];
it("readTask reads whether a plan exists from the served workflow artifacts (or Cloud's planWritten), and nothing when neither is served", () => {
  const read = (workflow: Record<string, unknown>) => readTaskList({ tasks: [task(ID.plan, "T", { workflow })] })[0]!.workflow?.planWritten;
  expect(read({ stage: "PLAN", state: "RUNNING", artifacts: [] })).toBe(false);
  expect(read({ stage: "PLAN", state: "RUNNING", artifacts: [{ ...ART, type: "requirements" }] })).toBe(false);
  expect(read({ stage: "PLAN", state: "RUNNING", artifacts: [ART] })).toBe(true);
  expect(read({ stage: "PLAN", state: "RUNNING", planWritten: true })).toBe(true);
  expect(read({ stage: "PLAN", state: "RUNNING" })).toBeUndefined();
});
it("planNotExpectedYet by artifacts: no plan artifact is absent at any stage, a plan artifact never is; the stage guess is used only without an artifact list", () => {
  const read = (artifacts: unknown[] | undefined, workflow: Record<string, unknown>, status = "RUNNING") => readTaskList({ tasks: withArtifacts(artifacts, workflow, status) })[0]!;
  expect(planNotExpectedYet(read([], { stage: "PLAN", state: "RUNNING" }), undefined)).toBe(true);
  expect(planNotExpectedYet(read([], { stage: "PLAN", state: "RUNNING", outcome: "CHANGES_REQUESTED" }), undefined)).toBe(true);
  expect(planNotExpectedYet(read([ART], { stage: "PLAN", state: "RUNNING", outcome: "CHANGES_REQUESTED" }), undefined)).toBe(false);
  expect(planNotExpectedYet(read([ART], { stage: "IMPLEMENT", state: "READY" }, "STARTING"), undefined)).toBe(false);
  expect(planNotExpectedYet(read([], { stage: "PLAN", state: "RUNNING" }), readDecisions(DecisionCardsViewReaderSchema.parse(decisionsView([CARDS.find(card => card.kind === "approve_plan")!])))[0])).toBe(false);
  expect(planNotExpectedYet(read(undefined, { stage: "PLAN", state: "RUNNING" }), undefined)).toBe(false);
  expect(planNotExpectedYet(read(undefined, { stage: "UNDERSTAND", state: "RUNNING" }), undefined)).toBe(true);
});
it("planAbsentLine says 'Rovara is writing the plan' only at a running planning step on a machine that is up; otherwise the quiet line", () => {
  const read = (artifacts: unknown[] | undefined, workflow: Record<string, unknown>, status = "RUNNING") => readTaskList({ tasks: withArtifacts(artifacts, workflow, status) })[0]!;
  expect(planAbsentLine(read([], { stage: "PLAN", state: "RUNNING" }))).toBe("Rovara is writing the plan.");
  expect(planAbsentLine(read([], { stage: "PLAN", state: "RUNNING" }, "STARTING"))).toBe("Rovara will show the plan here when it's ready.");
  expect(planAbsentLine(read([], { stage: "UNDERSTAND", state: "RUNNING" }))).toBe("Rovara will show the plan here when it's ready.");
  expect(planAbsentLine(read([], { stage: "PLAN", state: "WAITING" }))).toBe("Rovara will show the plan here when it's ready.");
});

it("moves focus into the comment form, and back to its button when it closes", async () => {
  const plan = readPlan(PLAN), criterion = plan.requirements[0]!.criteria[0]!;
  wrap(h(CriterionRow, { criterion, onComment: async () => undefined }));
  fireEvent.click(screen.getByRole("button", { name: "Comment on R1.1" }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Comment on R1.1" })));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Comment on R1.1" })));
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
it("REVIEW: planNotExpectedYet is false for a task whose plan already exists (changes requested, or a later stage while its machine restarts)", () => {
  const read = (patch: Record<string, unknown>) => readTaskList({ tasks: [task(ID.plan, "T", patch, "PLAN", "RUNNING")] })[0]!;
  expect(planNotExpectedYet(read({ workflow: { stage: "PLAN", state: "RUNNING", outcome: "CHANGES_REQUESTED" } }), undefined)).toBe(false);
  expect(planNotExpectedYet(read({ status: "STARTING", workflow: { stage: "IMPLEMENT", state: "READY" } }), undefined)).toBe(false);
});

// ---- REVIEW (Opus, uncommitted): the plan artifact type is matched exactly; "test_plan" (and other types) are not a plan ----
it("REVIEW: a test_plan, answer or review_report artifact is not a plan document (exact type match, not a substring)", () => {
  const read = (workflow: Record<string, unknown>) => readTaskList({ tasks: [task(ID.plan, "T", { workflow })] })[0]!.workflow?.planWritten;
  for (const type of ["test_plan", "answer", "review_report", "Plan", "plan "]) expect(read({ stage: "PLAN", state: "RUNNING", artifacts: [{ ...ART, type }] })).toBe(false);
  expect(read({ stage: "PLAN", state: "RUNNING", artifacts: [{ ...ART, type: "test_plan" }, ART] })).toBe(true);
});

// ---- an ENDED task with no plan: past tense, never a promise of a plan that will not come ----
const NONE_WRITTEN = "No plan was written for this task.";
it("an ended task with no plan document says so in the past tense; a task still going keeps its words", () => {
  const read = (artifacts: unknown[] | undefined, workflow: Record<string, unknown>, status: string) => readTaskList({ tasks: withArtifacts(artifacts, workflow, status) })[0]!;
  for (const status of ["CANCELLED", "CLOSED", "FAILED", "INTERRUPTED"]) expect(planAbsentLine(read([], { stage: "UNDERSTAND", state: "BLOCKED" }, status)), status).toBe(NONE_WRITTEN);
  expect(planAbsentLine(read([], { stage: "UNDERSTAND", state: "COMPLETE", outcome: "ANSWERED" }, "SUCCEEDED"))).toBe(NONE_WRITTEN);
  expect(planAbsentLine(read([], { stage: "PLAN_REVIEW", state: "COMPLETE", outcome: "REJECTED" }, "SUCCEEDED"))).toBe(NONE_WRITTEN);
  expect(planAbsentLine(read([], { stage: "PLAN", state: "RUNNING" }, "FAILED"))).toBe(NONE_WRITTEN);
  // Unchanged while the task is going.
  expect(planAbsentLine(read([], { stage: "PLAN", state: "RUNNING" }, "RUNNING"))).toBe("Rovara is writing the plan.");
  expect(planAbsentLine(read([], { stage: "UNDERSTAND", state: "RUNNING" }, "RUNNING"))).toBe("Rovara will show the plan here when it's ready.");
  expect(planAbsentLine(read([], { stage: "PLAN", state: "RUNNING" }, "STARTING"))).toBe("Rovara will show the plan here when it's ready.");
  expect(planAbsentLine(read([], { stage: "PLAN", state: "WAITING" }, "SUCCEEDED"))).toBe("Rovara will show the plan here when it's ready.");
  // A plan that exists is never "no plan was written", whatever the status; an advisory plan-check failure on a task still going is not an end.
  expect(taskEndedWithoutPlan(read([ART], { stage: "IMPLEMENT", state: "BLOCKED" }, "FAILED"))).toBe(false);
  expect(taskEndedWithoutPlan({ ...read([], { stage: "PLAN", state: "RUNNING" }, "FAILED"), advisoryPlanFailure: "The plan review didn't run" })).toBe(false);
});
