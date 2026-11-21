// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { PROOF_FAILURES_SHOWN, ageLabel, involvedRows, nextNeedsYou, proofRows, provenCount, readEvents, readPlan, readProof, readProofIndex, readTaskList, sortRows, stepOf, workRows, type ReadProofItem } from "../../packages/ui/src/api/work.js";
import { readDecisions } from "../../packages/ui/src/api/decisions.js";
import { DecisionCardsViewReaderSchema } from "@agentx/contracts/web";
import { BudgetBanner } from "../../packages/ui/src/design/BudgetBanner.js";
import { EvalResult } from "../../packages/ui/src/design/EvalResult.js";
import { StepMini, StepRail } from "../../packages/ui/src/design/StepRail.js";
import { BuildStep } from "../../packages/ui/src/screens/session/BuildStep.js";
import { CriterionRow } from "../../packages/ui/src/screens/session/CriterionRow.js";
import { FailingTests, ProofStep } from "../../packages/ui/src/screens/session/ProofStep.js";
import { PullRequestCard } from "../../packages/ui/src/screens/session/PullRequestCard.js";
import { SpecStep } from "../../packages/ui/src/screens/session/SpecStep.js";
import { HomeScreen } from "../../packages/ui/src/screens/home/HomeScreen.js";
import { WorkScreen } from "../../packages/ui/src/screens/work/WorkScreen.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { navFixture } from "./support/fixtures.js";
import { CARDS, EVENTS, ID, NOW, PLAN, PROOF, QUESTION_SESSION, TASKS, decisionsView, task } from "./support/work-fixture.js";

// The screen reads the clock when grouping tasks; keep it aligned with the fixed fixture.
// Fake only Date so React Query, waitFor and accessibility checks keep real timers.
beforeEach(() => { vi.useFakeTimers({ now: NOW, toFake: ["Date"] }); });
afterEach(() => { vi.useRealTimers(); });
const decisions = (cards = CARDS) => readDecisions(DecisionCardsViewReaderSchema.parse(decisionsView(cards)));
const rowsOf = (tasks = TASKS, cards = CARDS) => workRows(readTaskList({ tasks }), decisions(cards), NOW);
const NOT_YET = { status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "/v1/app/sessions isn't connected to Rovara Code yet." } } };

// ---- The read layer ----
it("groups tasks by who owns the next move, in fixed words", () => {
  const byId = new Map(rowsOf().map(row => [row.id, row]));
  expect(byId.get(ID.plan)).toMatchObject({ group: "you", tone: "wait", need: "Approve quick spec", step: "spec", path: "Quick spec" });
  expect(byId.get(ID.merge)).toMatchObject({ group: "you", tone: "ok", need: "Merge", step: "pull_request" });
  expect(byId.get(ID.question)).toMatchObject({ group: "you", need: "Question" });
  expect(byId.get(ID.checks)).toMatchObject({ group: "you", tone: "bad", need: "Check failed twice" });
  expect(byId.get(ID.running)).toMatchObject({ group: "run", tone: "run", line: "Building", step: "build" });
  expect(byId.get(ID.waiting)).toMatchObject({ group: "others", tone: "idle" });
  expect(byId.get(ID.merged)).toMatchObject({ group: "done", tone: "ok", line: "Merged", step: "merged" });
});
it("puts a task with no card but a stopped workflow under Needs you, and a queued one in the queue", () => {
  const rows = rowsOf([task(ID.checks, "Stopped one", { status: "FAILED" }, "IMPLEMENT", "BLOCKED"), task(ID.running, "Queued one", { status: "STARTING", workflow: undefined })], []);
  expect(rows[0]).toMatchObject({ group: "you", need: "Stopped", tone: "bad" });
  expect(rows[1]).toMatchObject({ group: "run", line: "In the queue", tone: "idle" });
  expect(stepOf(readTaskList({ tasks: [task(ID.running, "x", { workflow: undefined, status: "SUCCEEDED" })] })[0]!)).toBe("proof");
});
it("puts a finished task with no pull request under Finished, not under Rovara is working", () => {
  const rows = rowsOf([task(ID.stale, "Done quietly", { status: "SUCCEEDED", workflow: { stage: "VERIFY", state: "COMPLETE", revision: 3 } }, "VERIFY", "COMPLETE", 30), task(ID.running, "Between steps", { status: "SUCCEEDED" }, "IMPLEMENT", "RUNNING", 30)], []);
  expect(rows.find(row => row.id === ID.stale)).toMatchObject({ group: "done", line: "Finished" });
  expect(rows.find(row => row.id === ID.running)).toMatchObject({ group: "run" });
});
it("orders Needs you with anything waiting over a day first, then the quickest decision", () => {
  const old = { ...CARDS[3]!, createdAt: new Date(NOW.getTime() - 30 * 36e5).toISOString() };
  const order = rowsOf(TASKS, [CARDS[0]!, CARDS[1]!, CARDS[2]!, old]).filter(row => row.group === "you").map(row => row.id);
  // the stale one first; then 1 minute (merge), 5 minutes (plan), and the one with no estimate last
  expect(order).toEqual([ID.checks, ID.merge, ID.plan, ID.question]);
  expect(sortRows(rowsOf()).map(row => row.group)).toEqual(["you", "you", "you", "you", "run", "others", "done"]);
});
it("shows finished work only from the last week", () => {
  const rows = rowsOf([...TASKS, task(ID.stale, "Old merge", { status: "SUCCEEDED", workflow: { stage: "MERGED", state: "COMPLETE", revision: 1 } }, "MERGED", "COMPLETE", 60 * 24 * 9)]);
  expect(rows.some(row => row.id === ID.stale)).toBe(false);
});
it("picks the next task that needs you after a decision, else the first, else nothing", () => {
  const rows = rowsOf(), need = rows.filter(row => row.group === "you").map(row => row.id);
  expect(nextNeedsYou(rows, need[0]!)).toBe(need[1]);
  expect(nextNeedsYou(rows, need[need.length - 1]!)).toBe(need[0]);
  expect(nextNeedsYou(rowsOf([TASKS[1]!], []), ID.running)).toBeUndefined();
});
it("labels ages in minutes, hours and days", () => { expect([ageLabel("2026-11-15T11:55:00.000Z", NOW), ageLabel("2026-11-15T09:00:00.000Z", NOW), ageLabel("2026-11-13T12:00:00.000Z", NOW)]).toEqual(["5m", "3h", "2d"]); });
it("reads each answer defensively: an answer that is not the shape is refused, a bad item is dropped", () => {
  expect(() => readTaskList({ nope: 1 })).toThrow();
  expect(readTaskList({ tasks: [{ taskId: "a" }, task(ID.plan, "ok"), "x", { taskId: "t", title: "t", project: "p", updatedAt: "not a date" }] })).toHaveLength(1);
  expect(() => readPlan("x")).toThrow();
  expect(readPlan({ summary: { headline: 4 }, requirements: [{ id: "R1" }, { id: "R2", title: "T", criteria: [{ id: "R2.1", when: "w" }] }], tasks: [{ id: "T1", title: "t", status: "weird" }] })).toMatchObject({ headline: undefined, requirements: [{ id: "R2", criteria: [] }], tasks: [] });
  expect(readProof({ items: [{ sha256: "a", title: "t", kind: "log", verdict: "maybe" }, PROOF.items[0]] })).toHaveLength(1);
  expect(() => readProof({})).toThrow();
  expect(readEvents({ events: [{ at: "x" }, { at: "2026", kind: "status" }] })).toHaveLength(1);
});
it("proves a criterion only when every check that speaks to it passed on current code", () => {
  const plan = readPlan(PLAN), item = (patch: Partial<ReadProofItem>): ReadProofItem => ({ id: "a", sha256: "a", title: "t", kind: "test_report", verdict: "pass", criterionIds: ["R1.1"], commit: undefined, stale: false, passed: undefined, total: undefined, bar: undefined, ...patch });
  const state = (items: ReadProofItem[]) => proofRows(plan.requirements, items, plan.tasks).map(row => row.state);
  expect(state([])).toEqual(["not_run", "running"]);
  expect(state([item({})])).toEqual(["pass", "running"]);
  expect(state([item({}), item({ verdict: "unknown" })])).toEqual(["partly", "running"]);
  expect(state([item({ stale: true })])[0]).toBe("stale");
  expect(state([item({}), item({ verdict: "fail" })])[0]).toBe("fail");
  expect(provenCount(proofRows(plan.requirements, [item({})], plan.tasks))).toEqual([1, 2]);
});

// ---- Components ----
const wrap = (element: ReturnType<typeof h>, host = fakeHost()) => renderUi(h(AppHostProvider, { host: host.host, children: h(QueryClientProvider, { client: createQueryClient(), children: h(MemoryRouter, { children: h(Announcer, { children: element }) }) }) }));

it("draws the step rail with done, current and not-started steps, in words as well as colour", () => {
  const f = wrap(h(StepRail, { step: "build", tone: "run" }));
  const items = within(screen.getByRole("list", { name: "Steps of this task" })).getAllByRole("listitem");
  expect(items.map(item => item.getAttribute("data-state"))).toEqual(["done", "done", "current", "todo", "todo"]);
  expect(items[2]!.textContent).toContain("running");expect(items[0]!.textContent).toContain("done");expect(items[3]!.textContent).toContain("not started");
  expect(f.container.querySelector("[aria-current=step]")?.textContent).toContain("Build");
  f.unmount();
  wrap(h(StepRail, { step: "merged", tone: "ok" }));expect(screen.getAllByRole("listitem").every(item => item.getAttribute("data-state") === "done")).toBe(true);
});
it("makes each step a button when it can be selected, and tells the mini bars apart for a screen reader", () => {
  const onSelect = vi.fn();wrap(h("div", {}, h(StepRail, { step: "spec", tone: "wait", onSelect, selected: "spec" }), h(StepMini, { step: "proof", tone: "ok" })));
  fireEvent.click(screen.getByRole("button", { name: /Build/u }));expect(onSelect).toHaveBeenCalledWith("build");
  expect(screen.getByRole("button", { name: /Spec/u }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("img", { name: "Proof, done" })).toBeTruthy();
});
it("draws an eval box only from what Code sent, red when it failed, and refuses nonsense", () => {
  const f = wrap(h(EvalResult, { passed: 405, total: 420, bar: 0.97, failed: true }));
  expect(f.container.textContent).toContain("405 of 420 cases pass · 96.4%");expect(f.container.textContent).toContain("bar 97.0%");expect(f.container.textContent).not.toContain("judged by");expect(f.container.querySelector(".rv-eval-bar i.bad")).toBeTruthy();
  f.unmount();
  const g = wrap(h(EvalResult, { passed: 5, total: 0 }));expect(g.container.textContent).toContain("unavailable");g.unmount();
  const k = wrap(h(EvalResult, { passed: 98, total: 100, baseline: 0.95, judge: "judge-1", slices: [{ name: "long prompts", passed: 40, total: 41 }] }));expect(k.container.textContent).toContain("before this change 95.0%");expect(k.container.textContent).toContain("judged by judge-1");expect(k.container.textContent).toContain("long prompts 40/41");
});
it("asks a question in place on its criterion, says what is used if nobody answers, and says what was answered", async () => {
  const plan = readPlan(PLAN), onAnswer = vi.fn(async () => undefined), criterion = plan.requirements[0]!.criteria[1]!;
  const f = wrap(h(CriterionRow, { criterion, question: plan.questions[0]!, onAnswer }));
  expect(f.container.querySelector(".rv-criterion.q")).toBeTruthy();expect(f.container.textContent).toContain('Leave it, and Rovara uses "No, replace it"');
  fireEvent.click(screen.getByRole("button", { name: /Yes, behind a flag/u }));await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("Q1", "yes"));
  f.unmount();
  const g = wrap(h(CriterionRow, { criterion, question: plan.questions[0]!, answeredLabel: "No, replace it", onAnswer }));expect(g.container.textContent).toContain("You answered: No, replace it");expect(screen.queryByRole("button", { name: /Yes/u })).toBeNull();
  g.unmount();
  const failing = vi.fn(async () => { throw new Error("/v1/app/sessions/x/answers isn't connected to Rovara Code yet."); });
  wrap(h(CriterionRow, { criterion, question: plan.questions[0]!, onAnswer: failing }));fireEvent.click(screen.getByRole("button", { name: /Yes/u }));expect((await screen.findByTestId("answer-error")).textContent).toContain("isn't connected to Rovara Code yet");
});
it("draws the spec with ids, a comment on its criterion, and falls back to the summary when the plan has no structure", async () => {
  const plan = readPlan(PLAN), f = wrap(h(SpecStep, { plan, comments: [{ commentId: "c", author: "Owen", text: "Count retries", at: "x", resolved: true, anchor: "R1.1", replyTo: undefined }] }));
  expect(f.container.textContent).toContain("v1 · 1 requirement, 2 criteria");expect(f.container.textContent).toContain('Owen: "Count retries" · resolved');expect(f.container.querySelectorAll(".rv-criterion")).toHaveLength(2);
  f.unmount();
  const g = wrap(h(SpecStep, { plan: readPlan({ summary: { headline: "Do it", checks: ["Unit tests"] } }), comments: [] }));expect(g.container.textContent).toContain("0 requirements, 0 criteria");expect(g.container.textContent).toContain("Unit tests");
});
it("draws plan tasks as planned, running with the last lines, done or stopped, safely", () => {
  const events = readEvents({ events: [1, 2, 3, 4].map(n => ({ seq: n, at: `2026-11-15T11:0${n}:00.000Z`, kind: "progress", text: n === 4 ? "\u001b[31mdone <b>x</b>\u001b[0m" : "line " + String(n), taskItemId: "T2" })) });
  const tasks = readPlan({ tasks: [{ id: "T1", title: "One", status: "done" }, { id: "T2", title: "Two", status: "running", criterionIds: ["R1.2"] }, { id: "T3", title: "Three", status: "todo" }, { id: "T4", title: "Four", status: "blocked" }] }).tasks;
  const f = wrap(h(BuildStep, { tasks, events }));
  expect(f.container.textContent).toContain("Task 2 of 4");
  const log = screen.getByRole("log", { name: "What T2 is doing" });expect(log.textContent).toContain("line 2");expect(log.textContent).toContain("done <b>x</b>");expect(log.textContent).not.toContain("line 1");expect(log.querySelector("b b")).toBeNull();expect(f.container.querySelectorAll(".rv-task-row.running")).toHaveLength(1);
  expect(f.container.querySelector(".rv-task-row.blocked")?.textContent).toContain("Stopped");
});
it("draws one proof row per criterion with its result, the eval box and the also-checked line", () => {
  const plan = readPlan(PLAN), items = readProof(PROOF), rows = proofRows(plan.requirements, items, plan.tasks), f = wrap(h(ProofStep, { rows, items }));
  const tableRows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
  expect(tableRows).toHaveLength(2);expect(tableRows[0]!.textContent).toContain("Pass");expect(tableRows[1]!.textContent).toContain("Fail");expect(tableRows[1]!.textContent).toContain("405 of 420 cases pass");
  expect(f.container.textContent).toContain("1 of 2 criteria proven");expect(f.container.textContent).toContain("Checked on commit ccccccc");expect(f.container.textContent).toContain("Also checked.");expect(f.container.textContent).toContain("Type check");
});
it("says a proof ran on older code when a check is stale", () => {
  const plan = readPlan(PLAN), items = readProof({ items: [{ ...PROOF.items[0], stale: true }] }), f = wrap(h(ProofStep, { rows: proofRows(plan.requirements, items, plan.tasks), items }));
  expect(f.container.textContent).toContain("out of date");expect(f.container.textContent).toContain("Out of date");
});
it("draws the pull request open or merged and links only to https", () => {
  const f = wrap(h(PullRequestCard, { pullRequest: { repository: "example/web", number: 42, url: "https://github.com/example/web/pull/42", state: "open" } }));
  expect(f.container.textContent).toContain("example/web #42");expect(screen.getByRole("link", { name: /View on GitHub/u }).getAttribute("href")).toBe("https://github.com/example/web/pull/42");f.unmount();
  const g = wrap(h(PullRequestCard, { pullRequest: { repository: "r", number: 1, url: "javascript:alert(1)", state: "merged" } }));expect(g.container.textContent).toContain("Merged");expect(screen.queryByRole("link")).toBeNull();
});
it("shows the budget banner only when the month's budget is used up, with the raise action for an administrator", () => {
  const none = wrap(h(BudgetBanner, { remainingUsd: 3, canRaise: true }));expect(none.container.textContent).toBe("");none.unmount();
  const a = wrap(h(BudgetBanner, { remainingUsd: 0, canRaise: true }));expect(a.container.textContent).toContain("budget is used up");expect(screen.getByRole("link", { name: "Raise the limit" }).getAttribute("href")).toBe("/app/admin/ai-spending");a.unmount();
  const b = wrap(h(BudgetBanner, { remainingUsd: -1.5, canRaise: false }));expect(b.container.textContent).toContain("$1.50 over");expect(screen.queryByRole("link")).toBeNull();expect(b.container.textContent).toContain("Ask a company administrator");
});

// ---- The screen ----
interface Setup { involved?: ApiResponse; tasks?: unknown; decisions?: unknown; plan?: unknown; proof?: unknown; send?: (request: ApiRequest) => Promise<ApiResponse>; nav?: unknown; spend?: ApiResponse; path?: string }
function screenSetup(options: Setup = {}) {
  let tasks: ApiResponse = options.tasks === undefined ? { status: 200, body: { tasks: TASKS } } : options.tasks as ApiResponse, cards: ApiResponse = options.decisions === undefined ? { status: 200, body: decisionsView() } : options.decisions as ApiResponse;
  const f = fakeHost(async request => {
    if (request.method !== "GET") return options.send ? options.send(request) : { status: 200, body: {} };
    const path = request.path.split("?")[0]!;
    if (path === "/v1/app/sessions") return tasks;
    if (path === "/v1/app/involved") return options.involved ?? { status: 200, body: { tasks: [] } };
    if (path === "/v1/app/decisions") return cards;
    if (path === "/v1/app/nav") return { status: 200, body: options.nav ?? navFixture({ projects: [] }) };
    if (path === "/v1/app/org/spend") return options.spend ?? NOT_YET;
    if (path.endsWith("/documents/plan")) return (options.plan as ApiResponse | undefined) ?? { status: 200, body: PLAN };
    if (path.endsWith("/evidence")) return (options.proof as ApiResponse | undefined) ?? { status: 200, body: PROOF };
    if (path.endsWith("/events")) return { status: 200, body: EVENTS };
    if (path.endsWith("/comments")) return { status: 200, body: { comments: [] } };
    return { status: 404, body: { error: { code: "NOT_FOUND", message: "no" } } };
  });
  const query = createQueryClient(), where: { current: string } = { current: "" };
  const Where = () => { where.current = useLocation().pathname + useLocation().search;return null; };
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: [options.path ?? "/app/live"], children: h(Announcer, { children: h(Routes, {}, h(Route, { path: "/app/live", element: h("div", {}, h(Where, {}), h(WorkScreen, {})) })) }) }) }) }));
  return { ...f, ...ui, query, where, answerTasks(next: ApiResponse) { tasks = next; }, answerCards(next: ApiResponse) { cards = next; }, close() { ui.unmount();query.clear(); } };
}
const rowOf = (id: string) => document.querySelector<HTMLElement>(`[data-task-id="${id}"].rv-inbox-row`)!;
const paneTitle = () => screen.getByTestId("pane-title").textContent;

it("lists every task grouped by who owns the next move, with the first needing-you task open in the pane", async () => {
  const f = screenSetup();await screen.findByRole("heading", { name: /Needs you/u });
  const groups = screen.getAllByRole("heading", { level: 2 }).map(heading => heading.textContent);
  expect(groups.slice(0, 4)).toEqual(["Needs you 4", "Rovara is working 1", "Waiting on others 1", "Finished this week 1"]);
  expect(within(screen.getByRole("list", { name: "Needs you" })).getAllByRole("button").map(button => button.getAttribute("data-task-id"))).toEqual([ID.merge, ID.plan, ID.checks, ID.question].map(id => id)); // quickest first
  await waitFor(() => expect(paneTitle()).toBe("Fix the README typo"));
  expect(screen.getByRole("region", { name: "Work list" })).toBeTruthy();expect(screen.getByRole("region", { name: "Selected task" })).toBeTruthy();
  expect(rowOf(ID.merge).getAttribute("aria-current")).toBe("true");
  f.close();
});
it("moves the selection with j and k while the list has focus, and not from elsewhere", async () => {
  const f = screenSetup({ path: `/app/live?task=${ID.merge}` });await screen.findByRole("heading", { name: /Needs you/u });await waitFor(() => expect(paneTitle()).toBe("Fix the README typo"));
  fireEvent.keyDown(document.body, { key: "j" });expect(paneTitle()).toBe("Fix the README typo");
  fireEvent.keyDown(rowOf(ID.merge), { key: "j" });await waitFor(() => expect(paneTitle()).toBe("Add a retry to the billing webhook"));
  expect(document.activeElement).toBe(rowOf(ID.plan));expect(f.where.current).toContain("task=" + ID.plan);
  fireEvent.keyDown(rowOf(ID.plan), { key: "k" });await waitFor(() => expect(paneTitle()).toBe("Fix the README typo"));
  fireEvent.keyDown(rowOf(ID.merge), { key: "k" });expect(paneTitle()).toBe("Fix the README typo");
  for (let n = 0; n < 8; n++) fireEvent.keyDown(document.activeElement ?? document.body, { key: "ArrowDown" });await waitFor(() => expect(paneTitle()).toBe("Add request IDs to eval logs"));
  f.close();
});
it("selects by click and shows that task's step rail, decision card, spec and side cards", async () => {
  const f = screenSetup();await screen.findByRole("heading", { name: /Needs you/u });
  fireEvent.click(rowOf(ID.plan));await waitFor(() => expect(paneTitle()).toBe("Add a retry to the billing webhook"));
  const decision = await screen.findByRole("region", { name: "Your decision" });
  expect(decision.textContent).toContain("Approve this quick spec");expect(within(decision).getByRole("button", { name: "Approve and build" })).toBeTruthy();
  const merge = within(decision).getByRole<HTMLInputElement>("checkbox", { name: /Merge by itself/u });expect(merge.disabled).toBe(true);expect(decision.textContent).toContain("not connected yet");
  const spec = await screen.findByRole("region", { name: "Spec" });expect(spec.textContent).toContain("R1.1");expect(spec.textContent).toContain("Question for you.");
  expect(screen.getByRole("list", { name: "Steps of this task" })).toBeTruthy();expect(screen.getByRole("region", { name: "Cost" }).textContent).toContain("Cost unavailable");
  f.close();
});
it("clicking a step shows that stage of the task", async () => {
  const f = screenSetup({ path: `/app/live?task=${ID.plan}` });await screen.findByRole("region", { name: "Spec" });
  fireEvent.click(within(screen.getByRole("list", { name: "Steps of this task" })).getByRole("button", { name: /^Proof/u }));
  const proof = await screen.findByRole("region", { name: "Proof" });expect(proof.textContent).toContain("1 of 2 criteria proven");
  fireEvent.click(within(screen.getByRole("list", { name: "Steps of this task" })).getByRole("button", { name: /^Build/u }));expect((await screen.findByRole("region", { name: "Build" })).textContent).toContain("T2");expect(screen.getByRole("region", { name: "Proof so far" })).toBeTruthy();
  f.close();
});
it("after approving, the list moves to the next task that needs you and says so", async () => {
  const send = vi.fn(async (request: ApiRequest): Promise<ApiResponse> => ({ status: 200, body: request.path.includes("/approve") ? { cardId: "approve_plan:" + ID.plan, outcome: "approved", remainingTabs: [] } : {} }));
  const f = screenSetup({ send, path: `/app/live?task=${ID.plan}` });
  const approve = await screen.findByRole("button", { name: "Approve and build" });
  f.answerCards({ status: 200, body: decisionsView(CARDS.filter(entry => entry.kind !== "approve_plan")) });
  f.answerTasks({ status: 200, body: { tasks: TASKS.map(entry => (entry.taskId === ID.plan ? { ...entry, workflow: { ...entry.workflow, stage: "IMPLEMENT", state: "RUNNING" } } : entry)) } });
  fireEvent.click(approve);
  await waitFor(() => expect(paneTitle()).toBe("Rate-limit the public API"));
  expect(send.mock.calls.some(([request]) => request.path === `/v1/app/decisions/approve_plan/${ID.plan}/approve`)).toBe(true);
  expect(rowOf(ID.plan).closest("section")?.getAttribute("data-group")).toBe("run");
  f.close();
});
it("draws the failed-twice card red with its eval box and the card's own choices", async () => {
  const proof = { status: 200, body: { taskId: ID.checks, items: [{ sha256: "e".repeat(64), title: "Release eval", kind: "eval", verdict: "fail", criterionIds: ["R1.2"], passed: 405, total: 420, bar: 0.97 }] } };
  const f = screenSetup({ path: `/app/live?task=${ID.checks}`, proof });
  const card = await screen.findByRole("region", { name: "A check failed twice" });
  expect(card.getAttribute("data-tone")).toBe("bad");await waitFor(() => expect(card.textContent).toContain("405 of 420 cases pass"));expect(within(card).getByRole("button", { name: "Try another approach" })).toBeTruthy();expect(within(card).getAllByText("Not now").length).toBeGreaterThan(0);
  f.close();
});
it("answers a question from the card; a route Code does not serve says so, never a spinner", async () => {
  const send = vi.fn<(request: ApiRequest) => Promise<ApiResponse>>(async () => ({ status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "/v1/app/sessions/x/answers isn't connected to Rovara Code yet." } } }));
  const f = screenSetup({ send, path: `/app/live?task=${ID.question}`, plan: { status: 200, body: { ...PLAN, questions: [{ ...PLAN.questions[0], criterionId: undefined }] } } });
  const card = await screen.findByRole("region", { name: "Question for you" });
  fireEvent.click(await within(card).findByRole("button", { name: /Yes, behind a flag/u }));
  expect((await screen.findByTestId("decision-error")).textContent).toContain("Not available yet.");
  const call = send.mock.calls[0]![0];expect(call.path).toBe(`/v1/app/sessions/${QUESTION_SESSION}/answers`);expect(call.body).toMatchObject({ round: 2, revision: 2, answers: [{ questionId: "Q1", optionId: "yes" }] });
  expect(call.path).not.toContain(ID.question);
  expect(screen.queryByRole("progressbar")).toBeNull();
  f.close();
});
it.each(["no Cloud session", "no round from Code"])("a question on a task with %s sends nothing and says to answer on the session page", async (missing) => {
  const send = vi.fn<(request: ApiRequest) => Promise<ApiResponse>>(async () => ({ status: 200, body: {} }));
  const tasks = TASKS.map(item => (item.taskId !== ID.question ? item : missing === "no Cloud session" ? { ...item, sessionId: undefined } : { ...item, workflow: { stage: "UNDERSTAND", state: "WAITING", revision: 2, path: "STANDARD" } }));
  const f = screenSetup({ send, tasks: { status: 200, body: { tasks } }, path: `/app/live?task=${ID.question}`, plan: { status: 200, body: { ...PLAN, questions: [{ ...PLAN.questions[0], criterionId: undefined }] } } });
  const card = await screen.findByRole("region", { name: "Question for you" });
  fireEvent.click(await within(card).findByRole("button", { name: /Yes, behind a flag/u }));
  expect((await screen.findByTestId("decision-error")).textContent).toContain("Answer this question on the task's session page.");
  expect(send.mock.calls.filter(([request]) => request.path.endsWith("/answers"))).toEqual([]);
  f.close();
});
it("says Work isn't connected yet, plainly, when Code does not serve the list", async () => {
  const f = screenSetup({ tasks: NOT_YET });
  const error = await screen.findByTestId("load-error");expect(error.textContent).toContain("Work isn't available yet.");expect(error.textContent).not.toContain("Not available yet.");expect(error.textContent).not.toContain("/v1/");expect(screen.queryByRole("progressbar")).toBeNull();
  f.answerTasks({ status: 200, body: { tasks: TASKS } });fireEvent.click(within(error).getByRole("button", { name: "Try again" }));await screen.findByRole("heading", { name: /Needs you/u });
  f.close();
});
it("shows a skeleton while loading, an empty state with no work, and could-not-load for a refused read", async () => {
  let release: ((value: ApiResponse) => void) | undefined;
  const pending = screenSetup({ tasks: new Promise<ApiResponse>(resolve => { release = resolve; }) as unknown as ApiResponse });
  // a pending list: the skeleton and a pane that says to wait, and the command area still there
  expect(screen.getByRole("progressbar", { name: "Loading your work" })).toBeTruthy();expect(screen.getByRole("heading", { name: "Work" })).toBeTruthy();pending.close();void release;
  const empty = screenSetup({ tasks: { status: 200, body: { tasks: [] } } });expect(await screen.findByTestId("work-empty")).toBeTruthy();empty.close();
  const refused = screenSetup({ tasks: { status: 403, body: { error: { code: "FORBIDDEN", message: "Your access ended." } } } });expect((await screen.findByTestId("load-error")).textContent).toContain("Your access ended.");refused.close();
});
it("says nothing needs you inside the Needs you group when it is empty but work is running", async () => {
  const f = screenSetup({ tasks: { status: 200, body: { tasks: [TASKS[1]] } }, decisions: { status: 404, body: { error: { code: "NOT_FOUND", message: "no" } } } });
  expect((await screen.findByTestId("work-nothing-needs-you")).textContent).toContain("Nothing needs you");expect(screen.getByRole("list", { name: "Rovara is working" })).toBeTruthy();
  await screen.findByTestId("decision-quiet");expect(screen.getByTestId("decision-quiet").textContent).toContain("Nothing needed from you");
  f.close();
});
it("says decisions aren't connected yet in the pane of a task that needs a person but has no card", async () => {
  const f = screenSetup({ tasks: { status: 200, body: { tasks: [task(ID.checks, "Stopped one", { status: "FAILED", workflow: { stage: "IMPLEMENT", state: "BLOCKED", revision: 1, blockReason: "The coding step could not finish." } }, "IMPLEMENT", "BLOCKED")] }, }, decisions: { status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "/v1/app/decisions isn't connected to Rovara Code yet." } } } });
  expect((await screen.findByTestId("decisions-unavailable")).textContent).toContain("Not available yet.");
  expect((await screen.findByTestId("decision-quiet")).textContent).toContain("Not available yet.");
  f.close();
});
it("shows the budget banner and hides the empty agents row", async () => {
  const f = screenSetup({ spend: { status: 200, body: { remainingUsd: 0 } } });
  expect(await screen.findByText("This month's budget is used up")).toBeTruthy();expect(screen.queryByTestId("agents-not-connected")).toBeNull();expect(screen.queryByRole("region", { name: "Agents" })).toBeNull();
  f.close();
  const g = screenSetup({ nav: navFixture() });
  const row = await screen.findByRole("region", { name: "Agents" });await waitFor(() => expect(within(row).getByRole("link", { name: /Payments expert/u }).textContent).toContain("needs you"));
  g.close();
});
it("does not claim nothing needs you when the decisions could not be read", async () => {
  const f = screenSetup({ tasks: { status: 200, body: { tasks: [TASKS[1]] } }, decisions: { status: 403, body: { error: { code: "FORBIDDEN", message: "Your access ended." } } } });
  expect((await screen.findByTestId("work-decisions-failed")).textContent).toContain("Decisions couldn't be loaded");expect(screen.queryByTestId("work-nothing-needs-you")).toBeNull();
  f.close();
});
it("keeps the proof when only the plan could not be read", async () => {
  const f = screenSetup({ path: `/app/live?task=${ID.merge}`, plan: { status: 403, body: { error: { code: "FORBIDDEN", message: "You can no longer read this task." } } } });
  await screen.findByTestId("section-error");fireEvent.click(within(screen.getByRole("list", { name: "Steps of this task" })).getByRole("button", { name: /^Pull request/u }));
  expect(await screen.findByRole("region", { name: "Pull request" })).toBeTruthy();expect(screen.getByRole("region", { name: "Proof" })).toBeTruthy();expect(screen.getByTestId("section-error").textContent).toContain("You can no longer read this task.");
  f.close();
});
it("does not send an answer for a task with no Cloud session or round, and says to answer on the session page", async () => {
  const send = vi.fn<(request: ApiRequest) => Promise<ApiResponse>>(async () => ({ status: 200, body: {} }));
  const f = screenSetup({ send, path: `/app/live?task=${ID.plan}`, tasks: { status: 200, body: { tasks: [task(ID.plan, "No revision", { workflow: { stage: "PLAN_REVIEW", state: "WAITING", path: "QUICK" } }, "PLAN_REVIEW", "WAITING", 2)] } } });
  fireEvent.click(await screen.findByRole("button", { name: /Yes, behind a flag/u }));
  expect((await screen.findByTestId("answer-error")).textContent).toContain("Answer this question on the task's session page.");expect(send).not.toHaveBeenCalled();
  f.close();
});
it("keeps the plan's own error in the pane without breaking the list", async () => {
  const f = screenSetup({ path: `/app/live?task=${ID.plan}`, plan: { status: 403, body: { error: { code: "FORBIDDEN", message: "You can no longer read this task." } } } });
  await screen.findByRole("heading", { name: /Needs you/u });expect((await screen.findByTestId("section-error")).textContent).toContain("You can no longer read this task.");expect(rowOf(ID.plan)).toBeTruthy();
  f.close();
});
function homeSetup(cards: ApiResponse) {
  const f = fakeHost(async request => request.path === "/v1/app/home" ? { status: 200, body: { cards: [], total: 0 } } : request.path === "/v1/app/decisions" ? cards : { status: 200, body: { notices: [], next: "settled" } });
  const query = createQueryClient();
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h(Announcer, { children: h(HomeScreen, {}) }) }) }) }));
  return { ...ui, close() { ui.unmount();query.clear(); } };
}
it("Home does not say nothing needs you while decision cards are waiting", async () => {
  const f = homeSetup({ status: 200, body: decisionsView() });
  await screen.findByRole("list", { name: "Decisions waiting for you" });expect(screen.queryByTestId("home-empty")).toBeNull();expect(screen.queryByText(/Nothing needs you/u)).toBeNull();
  f.close();
  const g = homeSetup({ status: 404, body: { error: { code: "NOT_FOUND", message: "no" } } });
  expect(await screen.findByTestId("home-empty")).toBeTruthy();g.close();
});
// ---- Involved tasks (web task channel K4) ----
const INVOLVED_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", INVOLVED_STOPPED = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", INVOLVED_OLD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", INVOLVED_DONE_OLD = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const INVOLVED = [
  task(INVOLVED_ID, "Migrate the invoices table", { project: "api" }, "IMPLEMENT", "RUNNING", 10),
  task(INVOLVED_STOPPED, "Rename the settings page", { status: "FAILED" }, "IMPLEMENT", "BLOCKED", 60),
  task(INVOLVED_OLD, "Upgrade the date library", {}, "IMPLEMENT", "RUNNING", 60 * 24 * 40),
  task(INVOLVED_DONE_OLD, "Fix a typo", { status: "SUCCEEDED" }, "MERGED", "COMPLETE", 60 * 24 * 10),
];
it("makes involved rows a group of their own: newest first, nothing asked of the person, no decision card, old finished or idle work left out", () => {
  const rows = involvedRows(readTaskList({ tasks: INVOLVED }), NOW);
  expect(rows.map(row => row.id)).toEqual([INVOLVED_ID, INVOLVED_STOPPED]);
  for (const row of rows) expect(row).toMatchObject({ group: "involved", need: undefined, decision: undefined, stale: false });
  // A stopped task reads as what it is, in its line, never as a request for the person.
  expect(rows[1]).toMatchObject({ line: "Stopped", tone: "bad" });
  // A task at spec review is not a request the person can act on: its line says where it is.
  expect(involvedRows(readTaskList({ tasks: [task(INVOLVED_ID, "At review", {}, "PLAN_REVIEW", "WAITING", 10)] }), NOW)[0]).toMatchObject({ group: "involved", need: undefined, line: "Spec ready for review" });
  expect(rows[0]).toMatchObject({ line: "Building", tone: "run" });
});
it("lists involved tasks under their own Involved group at the end, and opens one beside the list in fixed words", async () => {
  const f = screenSetup({ involved: { status: 200, body: { tasks: INVOLVED } } });await screen.findByRole("heading", { name: /Needs you/u });
  await screen.findByRole("heading", { name: /^Involved/u });
  const groups = screen.getAllByRole("heading", { level: 2 }).map(heading => heading.textContent).filter(text => /^(Needs you|Rovara is working|Waiting on others|Finished this week|Involved)/u.test(text ?? ""));
  expect(groups).toEqual(["Needs you 4", "Rovara is working 1", "Waiting on others 1", "Finished this week 1", "Involved 2"]);
  expect(within(screen.getByRole("list", { name: "Involved" })).getAllByRole("button").map(button => button.getAttribute("data-task-id"))).toEqual([INVOLVED_ID, INVOLVED_STOPPED]);
  // The person's own groups are unchanged, and the first own task is still the one open.
  await waitFor(() => expect(paneTitle()).toBe("Fix the README typo"));
  fireEvent.click(rowOf(INVOLVED_ID));
  await waitFor(() => expect(paneTitle()).toBe("Migrate the invoices table"));
  // No link to a full page: it cannot open a task the person did not start yet.
  expect(screen.queryByRole("link", { name: /Open the full page/u })).toBeNull();
  expect(screen.getByTestId("decision-quiet").textContent).toContain("You're involved in this task");
  expect(screen.getByTestId("decision-quiet").textContent).toContain("Its owner answers the agent's questions and decides");
  expect(f.where.current).toContain("task=" + INVOLVED_ID);
  f.close();
});
it("opening an involved task by its address does not flash the first own task while the involved list loads", async () => {
  const f = screenSetup({ path: `/app/live?task=${INVOLVED_ID}`, involved: { status: 200, body: { tasks: INVOLVED } } });
  await screen.findByRole("heading", { name: /^Involved/u });
  await waitFor(() => expect(paneTitle()).toBe("Migrate the invoices table"));
  f.close();
});
it("shows a task that is in both lists once, in the person's own groups", async () => {
  const f = screenSetup({ involved: { status: 200, body: { tasks: [TASKS[0], INVOLVED[0]] } } });await screen.findByRole("heading", { name: /^Involved/u });
  expect(document.querySelectorAll(`[data-task-id="${String((TASKS[0] as { taskId: string }).taskId)}"].rv-inbox-row`)).toHaveLength(1);
  expect(within(screen.getByRole("list", { name: "Involved" })).getAllByRole("button")).toHaveLength(1);
  f.close();
});
it("shows nothing extra and no error when Code does not serve the involved list yet (404, 501) or answers it empty", async () => {
  for (const involved of [{ status: 404, body: { error: { code: "NOT_FOUND", message: "no" } } }, { status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "no" } } }, { status: 200, body: { tasks: [] } }]) {
    const f = screenSetup({ involved });await screen.findByRole("heading", { name: /Needs you/u });
    await waitFor(() => expect(paneTitle()).toBe("Fix the README typo"));
    expect(screen.queryByRole("heading", { name: /^Involved/u })).toBeNull();expect(screen.queryByTestId("involved-unavailable")).toBeNull();expect(screen.queryByTestId("load-error")).toBeNull();
    f.close();
  }
});
it("says quietly that involved tasks could not be loaded for any other failure, and keeps the person's own list", async () => {
  const f = screenSetup({ involved: { status: 403, body: { error: { code: "FORBIDDEN", message: "Your access ended." } } } });await screen.findByRole("heading", { name: /Needs you/u });
  expect((await screen.findByTestId("involved-unavailable")).textContent).toContain("couldn't be loaded");
  expect(screen.queryByTestId("load-error")).toBeNull();expect(rowOf(ID.merge)).toBeTruthy();
  f.close();
});
it("lists involved tasks even when the person has no work of their own", async () => {
  const f = screenSetup({ tasks: { status: 200, body: { tasks: [] } }, involved: { status: 200, body: { tasks: INVOLVED } } });
  await screen.findByRole("heading", { name: /^Involved/u });
  expect(screen.queryByTestId("work-empty")).toBeNull();
  await waitFor(() => expect(paneTitle()).toBe("Migrate the invoices table"));
  f.close();
});
it("Home lists the tasks the person was added to, each opening in Work, and draws nothing when there are none or Code does not serve them", async () => {
  const home = (involved: ApiResponse) => {
    const f = fakeHost(async request => {
      const path = request.path.split("?")[0]!;
      if (path === "/v1/app/home") return { status: 200, body: { cards: [], total: 0 } };
      if (path === "/v1/app/involved") return involved;
      return { status: 404, body: { error: { code: "NOT_FOUND", message: "no" } } };
    });
    const query = createQueryClient();
    const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h(Announcer, { children: h(HomeScreen, {}) }) }) }) }));
    return { ...ui, close() { ui.unmount();query.clear(); } };
  };
  const f = home({ status: 200, body: { tasks: INVOLVED } });
  const section = await screen.findByTestId("home-involved");
  expect(within(section).getAllByRole("link").map(link => link.getAttribute("href"))).toEqual([`/app/live?task=${INVOLVED_ID}`, `/app/live?task=${INVOLVED_STOPPED}`]);
  expect(section.textContent).toContain("Migrate the invoices table");
  f.close();
  for (const involved of [{ status: 200, body: { tasks: [] } }, { status: 404, body: { error: { code: "NOT_FOUND", message: "no" } } }, { status: 403, body: { error: { code: "FORBIDDEN", message: "Your access ended." } } }]) {
    const g = home(involved);await screen.findByTestId("home-empty");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(screen.queryByTestId("home-involved")).toBeNull();g.close();
  }
});
for (const theme of ["light", "dark"] as const) it("has no accessibility violations with involved tasks in " + theme, async () => {
  const f = screenSetup({ involved: { status: 200, body: { tasks: INVOLVED } } });await screen.findByRole("heading", { name: /^Involved/u });
  document.documentElement.setAttribute("data-theme", theme);await expectNoAxeViolations(f.container);f.close();
});
for (const theme of ["light", "dark"] as const) it("has no accessibility violations in " + theme, async () => {
  const f = screenSetup();await screen.findByRole("heading", { name: /Needs you/u });await screen.findByRole("region", { name: "Spec" }).catch(() => undefined);await screen.findByRole("region", { name: "Your decision" });
  document.documentElement.setAttribute("data-theme", theme);await expectNoAxeViolations(f.container);f.close();
});
void act;

// Staging walkthrough 2026-11-17 item 3: Code has no proof index route yet, so the proof read answers Code's unknown-route 404 ("route not found") or Cloud's 501.
// The pane says "Proof will appear here." in plain words, never the route text; any other failure still offers Try again.
it.each([
 ["Code's unknown-route 404", { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } }],
 ["Cloud's 501", { status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "/v1/app/tasks/x/evidence isn't connected to Rovara Code yet." } } }],
])("says proof will appear here, plainly, when the proof read is not served (%s)", async (_label, proof) => {
  const f = screenSetup({ proof, path: `/app/live?task=${ID.merge}` });
  expect((await screen.findByTestId("proof-not-yet")).textContent).toBe("Proof will appear here.");
  const pane = screen.getByRole("region", { name: "Selected task" });
  expect(pane.textContent).not.toContain("route not found");expect(pane.textContent).not.toContain("/v1/");
  expect(within(pane).queryByRole("button", { name: "Try again" })).toBeNull();
  f.close();
});
it("still offers Try again when the proof read fails for another reason", async () => {
  const f = screenSetup({ proof: { status: 500, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "Rovara Code didn't answer." } } }, path: `/app/live?task=${ID.merge}` });
  // The client tries a 500 again before it gives up, so the error shows after its back-off.
  expect(await screen.findByTestId("section-error", {}, { timeout: 5000 })).toBeTruthy();expect(screen.queryByTestId("proof-not-yet")).toBeNull();
  f.close();
});
it("keeps Code's own words for any other 404 of the proof read (a task the person can no longer read)", async () => {
  const f = screenSetup({ proof: { status: 404, body: { error: { code: "NOT_FOUND", message: "task not found" } } }, path: `/app/live?task=${ID.merge}` });
  expect((await screen.findByTestId("not-connected")).textContent).toBe("task not found");expect(screen.queryByTestId("proof-not-yet")).toBeNull();
  f.close();
});

// Proof list (Code's GET /v1/dev/tasks/{id}/evidence): Code's items carry an id and a digest only when it kept the check's output, and (TE-A6) up to ten failing tests with their likely causes.
const failureRow = (index: number) => ({ check: "pytest -q", test: `tests/cart.test.ts::case ${String(index)}`, cause: index % 2 === 0 ? "likely broken by a change (commit aaaaaaa) to src/cart.ts" : "unknown (only weak evidence)" });
it("reads Code's proof index: an item keyed by its id when it has no digest, every item kept (a repeated key suffixed), and at most ten failing tests with the rest counted", () => {
  const index = readProofIndex({ items: [{ id: "evidence:0", title: "pytest -q", kind: "test_report", verdict: "fail", criterionIds: [] }, { id: "evidence:0", title: "again", kind: "test_report", verdict: "pass" }, { title: "no key", kind: "log", verdict: "pass" }], failures: Array.from({ length: 13 }, (_, index) => failureRow(index)), failuresNotListed: 2 });
  // Every valid item is kept: a repeated key gets its own suffix (an older Code may send two checks with the same digest).
  expect(index.items.map(item => [item.id, item.sha256, item.title])).toEqual([["evidence:0", undefined, "pytest -q"], ["evidence:0#1", undefined, "again"]]);
  expect(index.failures).toHaveLength(PROOF_FAILURES_SHOWN);expect(index.failures[0]).toEqual(failureRow(0));
  expect(index.failuresNotListed).toBe(5);
  // An older Code (no failures) and odd values: no failing tests, nothing counted.
  expect(readProofIndex(PROOF)).toMatchObject({ failures: [], failuresNotListed: 0 });
  expect(readProofIndex({ items: [], failures: [{ check: 1, test: "t", cause: "c" }, "x"], failuresNotListed: -4 })).toMatchObject({ failures: [], failuresNotListed: 0 });
  // The fake Code's items have no id: the digest is the key.
  expect(readProof(PROOF).map(item => item.id)).toEqual(PROOF.items.map(item => item.sha256));
});
it("draws the failing tests under the proof as plain text, at most ten, and counts the rest", () => {
  const hostile = { check: "<b>suite</b>", test: "tests/<img src=x onerror=alert(1)>.test.ts::a", cause: "likely broken by a change to [x](https://evil.example) <script>alert(1)</script>\u202e" };
  const f = wrap(h(FailingTests, { failures: [hostile, ...Array.from({ length: 11 }, (_, index) => failureRow(index))], notListed: 3 }));
  const list = screen.getByRole("list", { name: "Failing tests" });
  expect(within(list).getAllByRole("listitem")).toHaveLength(PROOF_FAILURES_SHOWN);
  expect(f.container.querySelector("img, script, b, a")).toBeNull();
  expect(list.textContent).toContain("tests/<img src=x onerror=alert(1)>.test.ts::a");expect(list.textContent).toContain("(<b>suite</b>)");expect(list.textContent).toContain("[U+202E]");
  expect(f.container.textContent).toContain("and 5 more failing tests not listed");
  f.unmount();
  // Nothing to show: no section at all.
  const none = wrap(h(FailingTests, { failures: [] }));expect(none.container.textContent).toBe("");none.unmount();
  const onlyMore = wrap(h(FailingTests, { failures: [], notListed: 1 }));expect(onlyMore.container.textContent).toContain("and 1 more failing test not listed");onlyMore.unmount();
});
it("the Proof tab shows Code's items and failing tests from the proof read", async () => {
  const proof = { status: 200, body: { taskId: ID.merge, items: [{ id: "evidence:0", title: "pytest -q", kind: "test_report", verdict: "fail", criterionIds: [] }, { id: "review:code", title: "Code review", kind: "review", verdict: "pass", criterionIds: [] }], failures: [failureRow(0), failureRow(1)] } };
  const f = screenSetup({ proof, path: `/app/live?task=${ID.merge}` });
  const failing = await screen.findByTestId("failing-tests");
  expect(failing.textContent).toContain("tests/cart.test.ts::case 0");expect(failing.textContent).toContain("likely broken by a change (commit aaaaaaa) to src/cart.ts");expect(failing.textContent).toContain("unknown (only weak evidence)");
  const pane = screen.getByRole("region", { name: "Selected task" });expect(pane.textContent).toContain("Also checked.");expect(pane.textContent).toContain("pytest -q (failed)");expect(pane.textContent).toContain("Code review");
  expect(screen.queryByTestId("proof-not-yet")).toBeNull();
  f.close();
});
