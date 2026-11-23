// @vitest-environment jsdom
import { expect, it } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppHostProvider, type ApiResponse } from "../../packages/ui/src/host.js";
import { beginSessionRead, sessionScope } from "../../packages/ui/src/api/session-safety.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { viewerTime } from "../../packages/ui/src/design/viewer-time.js";
import { AnswerView } from "../../packages/ui/src/screens/answers/AnswerView.js";
import { TaskAnswers } from "../../packages/ui/src/screens/answers/TaskAnswers.js";
import { fakeHost } from "./support/fake-host.js";
import { meFixture, navFixture } from "./support/fixtures.js";
import { projectFixture } from "./support/project-fixture.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
const TASK = "11111111-1111-4111-8111-111111111111", OTHER = "22222222-2222-4222-8222-222222222222";
const source = { n: 1, kind: "task_state", taskId: TASK, quote: "The latest plan is waiting for your approval." };
const entry = (id: string, at: string, question = "Why is this waiting?") => ({ answerId: id, threadId: "thread-1", question, answer: "The plan is waiting. [1]", createdAt: at, sources: [source] });
const ok = (body: unknown): ApiResponse => ({ status: 200, body });
function mount(options: { pending?: boolean; old?: boolean; empty?: boolean; failure?: number; unreadable?: boolean; more?: boolean; historyDelay?: Promise<void>; supersedeHistory?: boolean; postStatus?: number; canStart?: boolean; sameSecond?: boolean } = {}) {
 let gate = options.historyDelay, overviewGate: Promise<void> | undefined, overviewStatus = 200;
 let canStart = options.canStart ?? false;
 let who = meFixture(), taskId = TASK, status = options.old ? 501 : options.failure ?? 200;
 let entries = options.empty ? [] : [entry("answer-new", options.sameSecond ? "2026-11-22T13:00:00.500Z" : "2026-11-22T13:00:00.000Z", "New question"), entry("answer-old", options.sameSecond ? "2026-11-22T13:00:00Z" : "2026-11-22T12:00:00.000Z", "Old question")];
 const nav = navFixture({ features: { localAgents: false, usage: false, admin: false, chains: false, notices: false, describe: false, answers: true } });
 const f = fakeHost(async request => {
  if (request.path === "/v1/app/me") return ok(who);
  if (request.path === "/v1/app/nav") return ok(nav);
  if (request.path.endsWith("/overview")) { await overviewGate;if (overviewStatus !== 200) return { status: overviewStatus, body: { error: { code: "FORBIDDEN", message: "Unavailable" } } };return ok(projectFixture({ you: { role: canStart ? "contributor" : "viewer", canStartWork: canStart, canEditSettings: false, canViewSpend: false } })); }
  if (request.method === "GET" && request.path.includes("/tasks/")) {
   await gate;
   if (options.supersedeHistory) beginSessionRead(f.host, sessionScope({ companyId: who.org.orgId, personId: who.developer.id }, "task-answers:payments:" + taskId));
   return status === 200 ? ok(options.unreadable ? { entries: "invalid", more: false } : { entries, more: options.more ?? false }) : { status, body: { error: { code: status === 501 ? "NOT_ON_CODE_YET" : status === 403 ? "FORBIDDEN" : "RUNTIME_UNAVAILABLE", message: "Unavailable" } } };
  }
  if (request.method === "POST" && request.path.endsWith("/answers")) {
   if (options.postStatus !== undefined) return { status: options.postStatus, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "Unknown" } } };
   const next = entry("answer-sent", "2026-11-22T14:00:00.000Z", "What should happen next?");entries = [...entries, next];
   return ok({ answerId: next.answerId, threadId: "thread-1", outcome: "answered", text: "I can answer a reader.", unconfirmed: [], sources: [], wikiPages: [], action: { kind: "quick_task", label: "Start a Quick task", title: "Do something" } });
  }
  return { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } };
 });
 const query = createQueryClient();
 const tree = () => h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h(TaskAnswers, { project: "payments", title: "Fix refunds", taskId, pending: options.pending }) }) }) });
 let ui = renderUi(tree());
 return { ...f, query, async remount(nextTask = taskId) { ui.unmount();taskId = nextTask;ui = renderUi(tree());await act(async () => { await Promise.resolve(); }); },
  switchPerson() { canStart = false;who = meFixture({ developer: { ...who.developer, id: "c".repeat(64) } });entries = []; },
  switchCompany() { who = meFixture({ org: { ...who.org, orgId: "org_bbbbbbbbbbbbbbbbbbbb" } });entries = []; },
  failOverview(status: number) { overviewStatus = status; },
  holdOverview() { let release!: () => void;overviewGate = new Promise<void>(resolve => { release = resolve; });return release; },
  holdHistory() { let release!: () => void;gate = new Promise<void>(resolve => { release = resolve; });return release; },
  fail(value: number) { status = value; }, clear() { entries = []; }, close() { ui.unmount();query.clear(); } };
}
async function open() { const fold = await screen.findByTestId("task-answers");fireEvent.click(within(fold).getByText("Ask about this task", { selector: "summary" }));return fold; }
async function ask() {
 fireEvent.change(await screen.findByRole("textbox", { name: "Ask about this task" }), { target: { value: "What should happen next?" } });
 const button = screen.getByRole<HTMLButtonElement>("button", { name: "Ask" });await waitFor(() => expect(button.disabled).toBe(false));fireEvent.click(button);
}
it("a viewer asks with the served taskId; history survives remount, newest last, with local times and task citations", async () => {
 const f = mount();try {
  await open();await screen.findByText("Old question");
  const history = screen.getByRole("region", { name: "Your past questions" });
  expect(within(history).getAllByTestId("past-question").map(el => el.textContent)).toEqual(["Old question", "New question"]);
  expect(history.textContent).toContain(source.quote);
  expect(screen.queryByText("Showing up to 1,000 recent questions.")).toBeNull();
  expect(screen.getAllByText("Task state: " + source.quote).every(el => el.closest("a") === null)).toBe(true);
  const time = history.querySelector("time")!;expect(time.dateTime).toBe("2026-11-22T12:00:00.000Z");
  expect(time.textContent).toBe(viewerTime(time.dateTime, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }));
  await ask();await waitFor(() => expect(f.request.mock.calls.some(([r]) => r.method === "POST")).toBe(true));
  const sent = f.request.mock.calls.find(([r]) => r.method === "POST")![0];expect(sent.body).toMatchObject({ taskId: TASK });
  expect(screen.queryByRole("button", { name: "Start a Quick task" })).toBeNull();
  await waitFor(() => expect(within(screen.getByRole("region", { name: "Your past questions" })).getAllByTestId("past-question")).toHaveLength(3));
  expect(screen.getByTestId("task-answers").hasAttribute("open")).toBe(true);
  expect(screen.getAllByTestId("answer")).toHaveLength(3);
  await f.remount();await open();await screen.findByText("What should happen next?");
  const ids = [...document.querySelectorAll('[id*="answer-source-"]')].map(el => el.id);expect(new Set(ids).size).toBe(ids.length);
 } finally { f.close(); }
});
for (const change of ["person", "company", "task"] as const) it(`another ${change}'s cached history and in-memory answer never shows after remount`, async () => {
 const f = mount();try {
  await open();await screen.findByText("Old question");
  if (change === "person") f.switchPerson();else if (change === "company") f.switchCompany();else f.clear();
  await f.remount(change === "task" ? OTHER : TASK);await open();
  await waitFor(() => expect(screen.queryByText("Old question")).toBeNull());
  expect(screen.queryByText("New question")).toBeNull();
 } finally { f.close(); }
});
it("old Code keeps title-only Ask and shows no history", async () => {
 const f = mount({ old: true });try {
  await open();expect(screen.queryByRole("region", { name: "Your past questions" })).toBeNull();await ask();
  await waitFor(() => expect(f.request.mock.calls.some(([r]) => r.method === "POST")).toBe(true));
  const body = f.request.mock.calls.find(([r]) => r.method === "POST")![0].body as Record<string, unknown>;
  expect(body["taskId"]).toBeUndefined();expect(body["context"]).toBe("Task: Fix refunds");
  await screen.findByText("I can answer a reader.");
  expect(f.request.mock.calls.filter(([r]) => r.method === "GET" && r.path.includes("/tasks/"))).toHaveLength(1);
 } finally { f.close(); }
});
for (const status of [403, 503]) it(`R1/R6e: latest ${status} history failure removes cached history and Ask through remount`, async () => {
 const f = mount();try {
  await open();await screen.findByText("Old question");f.fail(status);
  await act(async () => { await f.query.invalidateQueries({ queryKey: ["task-answer-history"] }); });
  await waitFor(() => expect(screen.queryByText("Old question")).toBeNull());expect(screen.queryByRole("button", { name: "Ask" })).toBeNull();
  await f.remount();await screen.findByRole("alert");expect(screen.queryByText("Old question")).toBeNull();
  const fold = screen.getByTestId("task-answers");expect(within(fold).getByText("Ask about this task", { selector: "summary" })).toBeTruthy();
  expect(within(fold).getByRole("alert")).toBeTruthy();
  expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(0);
 } finally { f.close(); }
});
it("R4: an unreadable history response never supplies task context or a stale empty history", async () => {
 const f = mount({ unreadable: true });try { await screen.findByRole("alert");expect(screen.queryByTestId("ask-box")).toBeNull(); } finally { f.close(); }
});

it("shows Code's retained-history bound only when Code says there is more", async () => {
 const f = mount({ more: true });try { await open();await screen.findByText("Showing up to 1,000 recent questions."); } finally { f.close(); }
});

it("R1/R6e: a history response issued before a newer read cannot supply history or Ask", async () => {
 const f = mount({ supersedeHistory: true });try { await screen.findByRole("alert");expect(screen.queryByText("Old question")).toBeNull();expect(screen.queryByTestId("ask-box")).toBeNull(); } finally { f.close(); }
});
it("keeps Ask unavailable while the initial history capability read is pending", async () => {
 let release!: () => void;
 const historyDelay = new Promise<void>(resolve => { release = resolve; });
 const f = mount({ historyDelay });try {
  await waitFor(() => expect(f.request.mock.calls.some(([r]) => r.path.includes("/tasks/"))).toBe(true));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(screen.queryByTestId("ask-box")).toBeNull();
  const fold = screen.getByTestId("task-answers");expect(fold.hasAttribute("open")).toBe(false);fireEvent.click(within(fold).getByText("Ask about this task", { selector: "summary" }));
  expect(fold.hasAttribute("open")).toBe(true);
  await act(async () => { release(); });await waitFor(() => expect(screen.getByTestId("ask-box")).toBeTruthy());
  expect(screen.getByTestId("task-answers")).toBe(fold);expect(fold.hasAttribute("open")).toBe(true);await screen.findByText("Old question");
 } finally { release();f.close(); }
});
it("R3: an unknown Ask stays locked on its task through remount, without locking another task", async () => {
 const f = mount({ empty: true, postStatus: 503 });try {
  await open();await ask();await screen.findByRole("alert");
  await f.remount(OTHER);await open();
  fireEvent.change(await screen.findByRole("textbox", { name: "Ask about this task" }), { target: { value: "A different task question" } });
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Ask" }).disabled).toBe(false));
  await f.remount(TASK);await open();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Ask" }).disabled).toBe(true);
  expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(1);
 } finally { f.close(); }
});

it("R1: an in-flight refresh hides old history and fences Ask while keeping the question draft", async () => {
 const f = mount();let release = () => undefined as void;try {
  await open();await screen.findByText("Old question");
  fireEvent.change(screen.getByRole("textbox", { name: "Ask about this task" }), { target: { value: "My unsent question" } });
  release = f.holdHistory();
  await act(async () => { void f.query.invalidateQueries({ queryKey: ["task-answer-history"] });await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(screen.queryByText("Old question")).toBeNull();
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Ask about this task" }).value).toBe("My unsent question");
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Ask" }).disabled).toBe(true);
  await act(async () => { release(); });await screen.findByText("Old question");
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Ask about this task" }).value).toBe("My unsent question");
 } finally { release();f.close(); }
});

it("every citation marker reaches its own source when several past answers are mounted", async () => {
 const f = fakeHost(async () => ok(meFixture()));
 const query = createQueryClient();
 const sources = [1, 2, 3, 4, 5].map(n => ({ n, repo: "web", path: `src/file${n}.ts`, commit: "a".repeat(40), line: n }));
 const answer = { threadId: "thread-1", outcome: "answered" as const, text: "First [1] and fifth [5].", sources, unconfirmed: [], wikiPages: [] };
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h("div", {}, h(AnswerView, { project: "payments", answer, repositories: [] }), h(AnswerView, { project: "payments", answer, repositories: [] }), h(AnswerView, { project: "payments", answer: { ...answer, text: "Only [1].", sources: sources.slice(0, 1) }, repositories: [] })) }) }) }));
 try {
  for (const marker of screen.getAllByRole<HTMLAnchorElement>("link", { name: /^Source /u })) {
   const target = document.getElementById(marker.hash.slice(1));
   expect(target).not.toBeNull();expect(target!.closest('[data-testid="answer"]')).toBe(marker.closest('[data-testid="answer"]'));
  }
  const ids = [...document.querySelectorAll('[id*="answer-source-"]')].map(el => el.id);expect(new Set(ids).size).toBe(ids.length);
 } finally { ui.unmount();query.clear(); }
});

it("keeps an unsent question when the project overview is refreshed", async () => {
 const f = mount();let release = () => undefined as void;try {
  await open();await screen.findByText("Old question");
  fireEvent.change(screen.getByRole("textbox", { name: "Ask about this task" }), { target: { value: "Keep this draft" } });
  release = f.holdOverview();
  await act(async () => { void f.query.invalidateQueries({ queryKey: ["project", "payments", "overview"] });await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Ask about this task" }).value).toBe("Keep this draft");
  await act(async () => { release(); });
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Ask about this task" }).value).toBe("Keep this draft");
 } finally { release();f.close(); }
});
it("another person's cached project overview cannot offer a reader the start-work action", async () => {
 const f = mount({ old: true, canStart: true });try {
  await open();await ask();await screen.findByRole("button", { name: "Start a Quick task" });
  f.switchPerson();await f.remount();await open();await ask();await screen.findByText("I can answer a reader.");
  expect(screen.queryByRole("button", { name: "Start a Quick task" })).toBeNull();
 } finally { f.close(); }
});

it("an old in-flight task history cannot satisfy the next task's history read", async () => {
 const f = mount();let release = () => undefined as void;try {
  await open();await screen.findByText("Old question");release = f.holdHistory();
  await act(async () => { void f.query.invalidateQueries({ queryKey: ["task-answer-history"] });await Promise.resolve(); });
  f.clear();await f.remount(OTHER);
  await act(async () => { release(); });await open();
  expect(f.request.mock.calls.some(([r]) => r.path.includes(`/tasks/${OTHER}/answers`))).toBe(true);
  expect(screen.queryByText("Old question")).toBeNull();
 } finally { release();f.close(); }
});

it("orders retained answers by their instants when valid timestamp precision differs", async () => {
 const f = mount({ sameSecond: true });try {
  await open();await screen.findByText("Old question");
  expect(within(screen.getByRole("region", { name: "Your past questions" })).getAllByTestId("past-question").map(el => el.textContent)).toEqual(["Old question", "New question"]);
 } finally { f.close(); }
});

it("keeps the pending question disclosure open through a fresh history read and remount", async () => {
 const f = mount({ pending: true, empty: true });try {
  const fold = await screen.findByTestId<HTMLDetailsElement>("task-answers");expect(fold.open).toBe(true);
  expect((await screen.findByRole<HTMLButtonElement>("button", { name: "Ask" })).disabled).toBe(true);
  await f.remount();expect((await screen.findByTestId<HTMLDetailsElement>("task-answers")).open).toBe(true);
  expect((await screen.findByRole<HTMLButtonElement>("button", { name: "Ask" })).disabled).toBe(true);
  expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(0);
 } finally { f.close(); }
});

for (const status of [403, 503]) it(`R1: a ${status} overview refresh retains the disclosure and removes Ask`, async () => {
 const f = mount();try {
  await open();await screen.findByText("Old question");f.failOverview(status);
  await act(async () => { await f.query.invalidateQueries({ queryKey: ["project", "payments", "overview"] }); });
  expect(within(screen.getByTestId("task-answers")).getByText("Ask about this task", { selector: "summary" })).toBeTruthy();
  expect(await screen.findByRole("alert")).toBeTruthy();expect(screen.queryByTestId("ask-box")).toBeNull();
  expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(0);
 } finally { f.close(); }
});
for (const status of [401, 403]) it(`C6: a ${status} on the history read shows the shared lost-access wording, not the generic check`, async () => {
 const f = mount({ failure: status });try {
  await open();
  const fold = screen.getByTestId("task-answers");
  expect(await within(fold).findByText("This question is no longer available in this session.")).toBeTruthy();
  expect(within(fold).queryByText("Couldn't check whether Rovara answered this.")).toBeNull();
  expect(within(fold).queryByRole("button", { name: "Ask" })).toBeNull();
 } finally { f.close(); }
});
it("C6b: a 503 on the history read keeps the generic check wording", async () => {
 const f = mount({ failure: 503 });try {
  await open();
  const fold = screen.getByTestId("task-answers");
  expect(await within(fold).findByText("Couldn't check whether Rovara answered this.")).toBeTruthy();
  expect(within(fold).queryByText("This question is no longer available in this session.")).toBeNull();
 } finally { f.close(); }
});
