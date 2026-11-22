// @vitest-environment jsdom
// The lessons screens (DEC 231): the Work inbox's batch row and card (Keep, Edit, Drop; one bulk send with a result each; the expiry warning; the person's own
// corrections first), "Learned" in How we work (mode, lists, retire, retire requests, Company locked, the calm off state) and "Lessons used" on the task page.
import { afterEach, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import type { LessonItem } from "../../packages/contracts/src/code-contract-v0.js";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { InboxReader, batchTitle, citationWords, relationWords, expiryWords, fromWords, resultWords, usageWords } from "../../packages/ui/src/api/learned.js";
import { WorkScreen } from "../../packages/ui/src/screens/work/WorkScreen.js";
import { LearnedSection } from "../../packages/ui/src/screens/project/LearnedSection.js";
import { LessonsUsedCard } from "../../packages/ui/src/screens/session/LessonsUsedCard.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { meFixture } from "./support/fixtures.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { navFixture } from "./support/fixtures.js";
import { ID, TASKS } from "./support/work-fixture.js";

const DAY = 864e5, NOW = Date.now();
afterEach(() => { vi.useRealTimers(); });
const OFF: ApiResponse = { status: 404, body: { error: { code: "LESSONS_SWITCHED_OFF", message: "Lessons are off." } } };
const ok = (body: unknown): ApiResponse => ({ status: 200, body });
function lesson(id: string, patch: Partial<LessonItem> = {}): LessonItem {
  return { id, version: 1, type: "convention", stages: ["IMPLEMENT"], title: `Lesson ${id}`, description: "Retries go through withRetry.", body: "Wrap network calls in withRetry.", scope: { repos: [], paths: [], languages: [] }, tier: 1, status: "pending",
    counters: { loaded: 0, helpful: 0, harmful: 0 }, createdAt: NOW - DAY, updatedAt: NOW - DAY, expiresAt: NOW + 5 * DAY, citations: [], from: [{ name: "Sam" }], measured: true, supportTasks: 1, canApprove: true, canReject: true, canRetire: true, ...patch };
}
const BATCH = { project: "web", fromYou: 1, lessons: [lesson("les_mine0001", { from: [{ name: "Priya", you: true }], title: "Wrap webhook calls in withRetry" }), lesson("les_soon0001", { expiresAt: NOW + 5 * 36e5, title: "Put tests next to the module" }), lesson("les_dates001", { title: "Use the shared date formatter" })] };

function mount(element: ReturnType<typeof h>, answer: (request: ApiRequest) => ApiResponse | undefined, path = "/app/live") {
  const f = fakeHost(async request => request.path === "/v1/app/me" ? { status: 200, body: meFixture() } : answer(request) ?? { status: 404, body: { error: { code: "NOT_FOUND", message: "no" } } });
  const query = createQueryClient();
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: [path], children: h(Announcer, { children: h(Routes, {}, h(Route, { path: path.split("?")[0]!, element })) }) }) }) }));
  return { ...f, ...ui, close() { ui.unmount();query.clear(); } };
}
const workAnswers = (inbox: ApiResponse, send?: (request: ApiRequest) => ApiResponse) => (request: ApiRequest): ApiResponse | undefined => {
  if (request.method !== "GET") return send?.(request);
  const path = request.path.split("?")[0]!;
  if (path === "/v1/app/sessions") return ok({ tasks: TASKS.slice(0, 2) });
  if (path === "/v1/app/decisions") return { status: 404, body: { error: { code: "NOT_FOUND", message: "Decision cards aren't on Rovara Code yet." } } };
  if (path === "/v1/app/nav") return ok(navFixture({ projects: [] }));
  if (path === "/v1/app/lessons/inbox") return inbox;
  return undefined;
};

// ---- Words ----
it("words the expiry, the counts, who it came from and the batch honestly", () => {
  expect(expiryWords(NOW + 5 * 36e5, NOW)).toEqual({ text: "Lapses in 5 hours if nobody decides", soon: true });
  expect(expiryWords(NOW + 1.5 * DAY, NOW)).toEqual({ text: "Lapses in 2 days if nobody decides", soon: true });
  expect(expiryWords(NOW + 6 * DAY, NOW).soon).toBe(false);
  expect(expiryWords(NOW - 1, NOW).text).toBe("Lapses now if nobody decides");
  // What Code counted: loads and marks, never "used in N tasks".
  expect(usageWords({ counters: { loaded: 14, helpful: 3, harmful: 1 }, supportTasks: 2 })).toBe("Loaded 14 times · 3 helpful · 1 not helpful · learned from 2 tasks");
  expect(usageWords({ counters: { loaded: 0, helpful: 0, harmful: 0 }, supportTasks: 0 })).toBe("Not loaded by a task yet");
  expect(usageWords({ counters: { loaded: 1, helpful: 0, harmful: 0 }, supportTasks: 1 })).not.toMatch(/used in/u);
  expect(fromWords({ from: [{ name: "Priya", you: true }] })).toBe("From your correction");
  expect(fromWords({ from: [{ name: "Sam" }, { name: "Ann" }] })).toBe("From Sam's correction and 1 other");
  expect(fromWords({ from: [] })).toBeUndefined();
  expect(batchTitle(BATCH, NOW)).toBe("3 lessons from this week's corrections");
  expect(batchTitle({ lessons: [lesson("a", { createdAt: NOW - 9 * DAY })] }, NOW)).toBe("1 lesson from recent corrections");
  expect(resultWords({ lessonId: "a", ok: true, status: "pending" }, "keep")).toMatch(/one more person/u);
  expect(resultWords({ lessonId: "a", ok: false, code: "FORBIDDEN", message: "No." }, "keep")).toBe("No.");
});
it("words a citation of a kind it does not know as another reference, never as the team record", () => {
  expect(citationWords({ kind: "record" })).toEqual({ text: "The team record" });
  expect(citationWords({ kind: "other" })).toEqual({ text: "Another kind of reference" });
  expect(citationWords({ kind: "wiki", page: "p" } as never)).toEqual({ text: "Another kind of reference" });
});
it("reads the inbox and leaves out a batch with nothing in it, or a lesson that is not a lesson", () => {
  const read = InboxReader.parse({ state: "on", batches: [BATCH, { project: "api", lessons: [{ id: "x" }] }], unavailable: ["ops"] });
  expect(read.batches.map(batch => batch.project)).toEqual(["web"]);
  expect(read.batches[0]!.fromYou).toBe(1);
  expect(read.unavailable).toEqual(["ops"]);
  expect(() => InboxReader.parse({ batches: [] })).toThrow();
});

// ---- The inbox batch ----
it("shows one row per batch under Needs you, opens its card, and sends Keep, Edit and Drop in one call with a result each", async () => {
  const sent: ApiRequest[] = [];
  const f = mount(h(WorkScreen, {}), workAnswers(ok({ state: "on", batches: [BATCH], unavailable: [] }), request => {
    sent.push(request);
    return ok({ project: "web", results: [{ lessonId: "les_mine0001", ok: true, status: "active" }, { lessonId: "les_soon0001", ok: true, status: "rejected" }, { lessonId: "les_dates001", ok: false, code: "IDEMPOTENCY_CONFLICT", message: "This lesson changed since you read it. Read it again and decide again." }] });
  }));
  const needsYou = await screen.findByRole("list", { name: "Needs you" });
  const row = await within(needsYou).findByRole("button", { name: /3 lessons from this week's corrections/u });
  expect(row.textContent).toContain("1 lapses soon");
  expect(row.textContent).toContain("1 from your corrections");
  fireEvent.click(row);
  const card = await screen.findByTestId("lesson-batch");
  // The person's own correction first, and the warning on the one that lapses soon.
  const titles = within(card).getAllByRole("heading", { level: 3 }).map(heading => heading.textContent);
  expect(titles).toEqual(["Wrap webhook calls in withRetry", "Put tests next to the module", "Use the shared date formatter"]);
  expect(within(card).getByTestId("lesson-expiry-soon").textContent).toBe("Lapses in 5 hours if nobody decides");
  expect(within(card).getByText("From your correction")).toBeTruthy();
  const articles = within(card).getAllByRole("article");
  const send = () => within(card).getByRole("button", { name: /^Send/u });
  expect(send().hasAttribute("disabled")).toBe(true);
  // Edit the first (key E), drop the second with a reason (key D), keep the third (key K).
  fireEvent.keyDown(articles[0]!, { key: "e" });
  const title = within(articles[0]!).getByRole("textbox", { name: "Title" });
  fireEvent.change(title, { target: { value: "Wrap every webhook call in withRetry" } });
  fireEvent.keyDown(articles[1]!, { key: "d" });
  expect(send().textContent).toBe("Send decision");
  expect(within(card).getByText(/1 still needs a reason or text/u)).toBeTruthy();
  fireEvent.change(within(articles[1]!).getByRole("combobox", { name: "Why drop it" }), { target: { value: "too_narrow" } });
  fireEvent.keyDown(articles[2]!, { key: "k" });
  // A key typed in a text field is text, not a decision.
  fireEvent.keyDown(title, { key: "d" });
  expect(within(articles[0]!).getByRole("radio", { name: /Edit/u })).toHaveProperty("checked", true);
  await act(async () => { fireEvent.click(send()); });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ method: "POST", path: "/v1/app/projects/web/lessons/decisions", retry: "never" });
  expect(sent[0]!.body).toEqual({ decisions: [
    { lessonId: "les_mine0001", version: 1, decision: "keep", edit: { title: "Wrap every webhook call in withRetry", description: "Retries go through withRetry.", body: "Wrap network calls in withRetry." } },
    { lessonId: "les_soon0001", version: 1, decision: "drop", reason: "too_narrow" },
    { lessonId: "les_dates001", version: 1, decision: "keep" },
  ] });
  const results = await screen.findByTestId("lesson-results");
  expect(results.textContent).toContain("Kept. Rovara uses it in tasks from now on.");
  expect(results.textContent).toContain("Dropped.");
  expect(results.textContent).toContain("This lesson changed since you read it.");
  // The refused one stays to decide again, with Code's words; the others leave the list.
  expect(within(screen.getByRole("list", { name: "Lessons to decide" })).getAllByRole("article")).toHaveLength(1);
  expect(within(screen.getByRole("list", { name: "Lessons to decide" })).getByRole("alert").textContent).toContain("Read it again");
  await expectNoAxeViolations(f.container);
  f.close();
});
it("Keep the rest keeps every undecided lesson, and a failed send changes nothing and says so", async () => {
  const f = mount(h(WorkScreen, {}), workAnswers(ok({ state: "on", batches: [BATCH], unavailable: [] }), () => ({ status: 503, body: { error: { code: "AUDIT_UNAVAILABLE", message: "That could not be recorded, so nothing was changed. Try again." } } })), "/app/live?task=lessons:web");
  const card = await screen.findByTestId("lesson-batch");
  fireEvent.click(within(card).getByRole("button", { name: "Keep the rest" }));
  expect(within(card).getByRole("button", { name: "Send 3 decisions" })).toBeTruthy();
  await act(async () => { fireEvent.click(within(card).getByRole("button", { name: "Send 3 decisions" })); });
  expect((await within(card).findByRole("alert")).textContent).toBe("That could not be recorded, so nothing was changed. Try again.");
  expect(within(card).getAllByRole("article")).toHaveLength(3);
  f.close();
});
it("adds no row while lessons are off or not on Code, and a quiet note when the inbox fails", async () => {
  for (const inbox of [ok({ state: "off", batches: [], unavailable: [] }), OFF, { status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "not yet" } } }]) {
    const f = mount(h(WorkScreen, {}), workAnswers(inbox));
    await screen.findByRole("list", { name: "Needs you" }).catch(() => screen.findByTestId("work-nothing-needs-you"));
    await waitFor(() => expect(f.request.mock.calls.some(([request]) => request.path === "/v1/app/lessons/inbox")).toBe(true));
    expect(document.querySelector(".rv-inbox-lessons")).toBeNull();
    expect(screen.queryByTestId("lessons-unavailable")).toBeNull();
    f.close();
  }
  const f = mount(h(WorkScreen, {}), workAnswers({ status: 403, body: { error: { code: "FORBIDDEN", message: "Your access ended." } } }));
  expect(await screen.findByTestId("lessons-unavailable")).toBeTruthy();
  f.close();
});

// ---- Learned ----
const learnedAnswers = (options: { off?: boolean; mode?: Record<string, unknown>; send?: (request: ApiRequest) => ApiResponse; canDecide?: boolean } = {}) => (request: ApiRequest): ApiResponse | undefined => {
  if (options.off === true) return OFF;
  if (request.method !== "GET") return options.send?.(request);
  const url = new URL(request.path, "https://x.example"), path = url.pathname;
  if (path.endsWith("/lessons/mode")) return ok({ project: "web", mode: "suggest", effective: "suggest", lockedByCompany: false, canChange: true, ...options.mode });
  if (path.endsWith("/lessons/retire-requests")) return ok({ project: "web", requests: [{ lessonId: "les_logs0001", title: "Log request ids", status: "active", by: "Sam", at: NOW - DAY }], more: false });
  if (path.endsWith("/lessons")) {
    const list = url.searchParams.get("list");
    if (list === "approved") return ok({ project: "web", list, canDecide: options.canDecide ?? true, lessons: [lesson("les_logs0001", { status: "active", title: "Log request ids", counters: { loaded: 14, helpful: 3, harmful: 1 }, supportTasks: 3, canRetire: options.canDecide ?? true })], ...(options.canDecide === false ? {} : { next: "cursor1" }) });
    if (list === "proposed") return ok({ project: "web", list, canDecide: true, lessons: [lesson("les_new00001", { expiresAt: NOW + 3 * 36e5 })] });
    return ok({ project: "web", list, canDecide: true, lessons: [lesson("les_old00001", { status: "rejected", rejectedReason: "too_narrow", title: "Old" }), lesson("les_free0001", { status: "retired", rejectedReason: "free text from a person", title: "Free" })] });
  }
  return undefined;
};
it("shows the mode, the approved lessons with Code's counts, retire with a reason, and the retire requests", async () => {
  const sent: ApiRequest[] = [];
  const f = mount(h(LearnedSection, { project: "web" }), learnedAnswers({ send: request => { sent.push(request);return request.method === "PUT" ? ok({ project: "web", mode: "auto", effective: "auto", lockedByCompany: false, canChange: true }) : ok({ project: "web", lessonId: "les_logs0001", status: "retired" }); } }), "/app/projects/web");
  const section = await screen.findByTestId("learned");
  expect(within(section).getByRole("heading", { name: "Learned" })).toBeTruthy();
  expect(await within(section).findByText("Loaded 14 times · 3 helpful · 1 not helpful · learned from 3 tasks")).toBeTruthy();
  expect(within(section).getByRole("button", { name: "Load more" })).toBeTruthy();
  const mode = within(section).getByRole("group", { name: "Learning" });
  await act(async () => { fireEvent.click(within(mode).getByRole("radio", { name: "Auto" })); });
  expect(sent[0]).toMatchObject({ method: "PUT", path: "/v1/app/projects/web/lessons/mode", body: { mode: "auto" }, retry: "never" });
  await waitFor(() => expect(within(mode).getByRole("radio", { name: "Auto" })).toHaveProperty("checked", true));
  // The requests, for the people who decide.
  const requests = await within(section).findByTestId("retire-requests");
  expect(requests.textContent).toContain("asked by Sam");
  // Retire with a reason.
  const approved = within(section).getByRole("list", { name: "Approved lessons" });
  fireEvent.click(within(approved).getByRole("button", { name: "Retire: Log request ids" }));
  const retire = within(approved).getByRole("button", { name: "Retire lesson" });
  expect(retire.hasAttribute("disabled")).toBe(true);
  fireEvent.change(within(approved).getByRole("combobox", { name: 'Why retire "Log request ids"' }), { target: { value: "outdated" } });
  await act(async () => { fireEvent.click(retire); });
  expect(sent[1]).toMatchObject({ method: "POST", path: "/v1/app/projects/web/lessons/les_logs0001/retire", body: { reason: "outdated" } });
  expect(await within(approved).findByText("Retired. Rovara no longer gives it to tasks.")).toBeTruthy();
  await expectNoAxeViolations(f.container);
  f.close();
});
it("shows proposed lessons with the expiry warning and a link to the inbox, and retired ones only in fixed words", async () => {
  const f = mount(h(LearnedSection, { project: "web" }), learnedAnswers(), "/app/projects/web");
  const section = await screen.findByTestId("learned");
  fireEvent.mouseDown(within(section).getByRole("tab", { name: "Proposed" }), { button: 0 });
  fireEvent.click(within(section).getByRole("tab", { name: "Proposed" }));
  expect(await within(section).findByText("Lapses in 3 hours if nobody decides")).toBeTruthy();
  expect(within(section).getByRole("link", { name: "your Work inbox" }).getAttribute("href")).toBe("/app/live?task=lessons%3Aweb");
  fireEvent.mouseDown(within(section).getByRole("tab", { name: "Retired" }), { button: 0 });
  fireEvent.click(within(section).getByRole("tab", { name: "Retired" }));
  expect(await within(section).findByText("Dropped: too narrow to be a rule")).toBeTruthy();
  expect(within(within(section).getByRole("list", { name: "Retired lessons" })).getByText("Retired")).toBeTruthy();
  expect(section.textContent).not.toContain("free text from a person");
  f.close();
});
it("says Company locked, and offers Ask to retire to someone who cannot change or retire", async () => {
  const sent: ApiRequest[] = [];
  const f = mount(h(LearnedSection, { project: "web" }), learnedAnswers({ canDecide: false, mode: { mode: "auto", effective: "suggest", lockedByCompany: true, canChange: false }, send: request => { sent.push(request);return ok({ project: "web", lessonId: "les_logs0001", requested: true }); } }), "/app/projects/web");
  const section = await screen.findByTestId("learned");
  expect((await within(section).findByTestId("company-locked")).textContent).toContain("The company's setting keeps this project at Suggest.");
  expect(within(section).getByTestId("learning-mode").textContent).toContain("Learning: Suggest.");
  expect(within(section).queryByRole("radio")).toBeNull();
  await act(async () => { fireEvent.click(await within(section).findByRole("button", { name: "Ask to retire: Log request ids" })); });
  expect(sent[0]).toMatchObject({ method: "POST", path: "/v1/app/projects/web/lessons/les_logs0001/retire-request", body: {} });
  expect(await within(section).findByText("Asked. The people who decide lessons will see your request.")).toBeTruthy();
  expect(within(section).queryByTestId("retire-requests")).toBeNull();
  f.close();
});
it("shows a calm off state when Code says lessons are off", async () => {
  const f = mount(h(LearnedSection, { project: "web" }), learnedAnswers({ off: true }), "/app/projects/web");
  const off = await screen.findByTestId("lessons-off");
  expect(off.textContent).toContain("Lessons are off.");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("tablist")).toBeNull();
  await expectNoAxeViolations(f.container);
  f.close();
});

// ---- Lessons used ----
const USED = { project: "web", taskId: ID.merge, lessons: [
  { stage: "IMPLEMENT", round: 1, lessonId: "les_logs0001", version: 1, why: "scope", citation: "valid", visible: true, title: "Log request ids", helpful: 3, harmful: 1, canMark: true },
  { stage: "PLAN", round: 2, lessonId: "les_trial001", version: 1, why: "path", citation: "stale_dropped", visible: true, title: "Keep the README current", canMark: true, trial: "trial" },
  { stage: "REVIEW", round: 1, lessonId: "les_hide0001", version: 1, why: "similar", citation: "unchecked", visible: false, canMark: false },
] };
it("lists each lesson the task was given with its why, citation and Code's marks, and records Not helpful once", async () => {
  const sent: ApiRequest[] = [];
  const f = mount(h(LessonsUsedCard, { project: "web", taskId: ID.merge }), request => {
    if (request.method === "GET") return ok(USED);
    sent.push(request);return ok({ project: "web", taskId: ID.merge, lessonId: "les_trial001", marked: "not_helpful" });
  }, "/app/sessions/x");
  const card = await screen.findByTestId("lessons-used");
  await within(card).findByText("Log request ids");
  expect(card.textContent).toContain("Build · Why: It covers this part of the project");
  expect(card.textContent).toContain("The code it cites is still there · 3 helpful · 1 not helpful, across all tasks");
  expect(card.textContent).toContain("Plan, round 2");
  expect(card.textContent).toContain("A lesson from a source you can't see");
  expect(card.textContent).not.toMatch(/used in \d+ tasks/u);
  expect(within(card).getAllByRole("button", { name: /^Not helpful/u })).toHaveLength(2);
  await waitFor(() => expect(within(card).getByRole<HTMLButtonElement>("button", { name: "Not helpful: Keep the README current" }).disabled).toBe(false));
  await act(async () => { fireEvent.click(within(card).getByRole("button", { name: "Not helpful: Keep the README current" })); });
  expect(sent[0]).toMatchObject({ method: "POST", path: `/v1/app/projects/web/tasks/${ID.merge}/lessons/les_trial001/not-helpful`, body: {}, retry: "never" });
  expect(await within(card).findByText("Marked not helpful. It was on trial, so Rovara stops using it.")).toBeTruthy();
  await expectNoAxeViolations(f.container);
  f.close();
});
it("says lessons are off, or not recorded yet, calmly", async () => {
  let f = mount(h(LessonsUsedCard, { project: "web", taskId: ID.merge }), () => OFF, "/app/sessions/x");
  expect((await screen.findByTestId("lessons-off")).textContent).toBe("Lessons are off, so this page can't show which ones this task used.");
  f.close();
  f = mount(h(LessonsUsedCard, { project: "web", taskId: ID.merge }), () => ({ status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "x" } } }), "/app/sessions/x");
  expect(await screen.findByTestId("lessons-not-recorded")).toBeTruthy();
  f.close();
});

it("sends an Edit that changes nothing as a plain Keep (an edit would drop earlier approvals in Code)", async () => {
  const sent: ApiRequest[] = [];
  const f = mount(h(WorkScreen, {}), workAnswers(ok({ state: "on", batches: [BATCH], unavailable: [] }), request => { sent.push(request);return ok({ project: "web", results: [{ lessonId: "les_mine0001", ok: true, status: "active" }] }); }), "/app/live?task=lessons:web");
  const card = await screen.findByTestId("lesson-batch");
  const first = within(card).getAllByRole("article")[0]!;
  fireEvent.keyDown(first, { key: "e" });
  fireEvent.change(within(first).getByRole("textbox", { name: "Title" }), { target: { value: "Wrap webhook calls in withRetry  " } });
  // E again keeps what was typed.
  fireEvent.keyDown(within(first).getByRole("radio", { name: /Edit/u }), { key: "e" });
  expect(within(first).getByRole<HTMLInputElement>("textbox", { name: "Title" }).value).toBe("Wrap webhook calls in withRetry  ");
  await act(async () => { fireEvent.click(within(card).getByRole("button", { name: "Send decision" })); });
  expect(sent[0]!.body).toEqual({ decisions: [{ lessonId: "les_mine0001", version: 1, decision: "keep" }] });
  f.close();
});
it("reads the inbox again after a lesson is not accepted, so the next send carries its current version", async () => {
  let version = 1, inboxReads = 0;
  const f = mount(h(WorkScreen, {}), request => {
    if (request.path === "/v1/app/lessons/inbox") { inboxReads++;return ok({ state: "on", batches: [{ ...BATCH, lessons: [lesson("les_dates001", { version, title: "Use the shared date formatter" })] }], unavailable: [] }); }
    if (request.method === "POST") { const stale = (request.body as { decisions: Array<{ version: number }> }).decisions[0]!.version !== 2;version = 2;return ok({ project: "web", results: [stale ? { lessonId: "les_dates001", ok: false, code: "IDEMPOTENCY_CONFLICT", message: "This lesson changed since you read it. Read it again and decide again." } : { lessonId: "les_dates001", ok: true, status: "active" }] }); }
    return workAnswers(ok({}))(request);
  }, "/app/live?task=lessons:web");
  const card = await screen.findByTestId("lesson-batch");
  fireEvent.keyDown(within(card).getByRole("article"), { key: "k" });
  await act(async () => { fireEvent.click(within(card).getByRole("button", { name: "Send decision" })); });
  expect((await within(card).findByTestId("lesson-results")).textContent).toContain("changed since you read it");
  await waitFor(() => expect(inboxReads).toBe(2));
  // The choice is cleared: the lesson is decided again on its current text.
  expect(within(card).getByRole("radio", { name: /Keep/u })).toHaveProperty("checked", false);
  fireEvent.keyDown(within(card).getByRole("article"), { key: "k" });
  await act(async () => { fireEvent.click(within(card).getByRole("button", { name: "Send decision" })); });
  await waitFor(() => expect(within(screen.getByTestId("lesson-batch")).getByTestId("lesson-results").textContent).toContain("Kept. Rovara uses it in tasks from now on."));
  f.close();
});
it("names the projects whose lessons could not be read, instead of implying nothing waits", async () => {
  const f = mount(h(WorkScreen, {}), workAnswers(ok({ state: "on", batches: [], unavailable: ["api"] })));
  expect((await screen.findByTestId("lessons-unavailable")).textContent).toBe("Lessons to review couldn't be loaded for api.");
  f.close();
});

it("says when a lesson may duplicate or contradicts another, so Keep is never silent, and shows a distinct-task count only when Code sends one", async () => {
  const titleOf = (id: string) => (id === "les_mine0001" ? "Wrap webhook calls in withRetry" : undefined);
  expect(relationWords({ possibleDuplicate: "les_mine0001" }, titleOf)).toEqual(['May duplicate "Wrap webhook calls in withRetry". Keep keeps both; Drop if it repeats it.']);
  expect(relationWords({ possibleDuplicate: "les_x", contradicts: "les_y" }, titleOf)).toEqual(["May duplicate another lesson. Keep keeps both; Drop if it repeats it.", "Contradicts another lesson. Keep only the one that is right."]);
  expect(relationWords({ possibleDuplicate: "les_x", mergeBlocked: true } as Parameters<typeof relationWords>[0], titleOf)).toEqual(["May duplicate another lesson. Keep keeps both; Drop if it repeats it."]);
  expect(relationWords({}, titleOf)).toEqual([]);
  expect(usageWords({ counters: { loaded: 3, helpful: 0, harmful: 0 }, supportTasks: 0, usedInTasks: 2 })).toBe("Loaded 3 times · used in 2 tasks");
  const batch = { ...BATCH, lessons: [BATCH.lessons[0]!, lesson("les_dup00001", { title: "Retry webhook calls", possibleDuplicate: "les_mine0001" })] };
  const f = mount(h(WorkScreen, {}), workAnswers(ok({ state: "on", batches: [batch], unavailable: [] })), "/app/live?task=lessons:web");
  const card = await screen.findByTestId("lesson-batch");
  expect(within(card).getByRole("article", { name: "Retry webhook calls" }).textContent).toContain('May duplicate "Wrap webhook calls in withRetry"');
  f.close();
});
