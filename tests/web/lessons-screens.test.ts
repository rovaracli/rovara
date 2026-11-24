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
import { InboxReader, batchTitle, citationWords, expiryWords, fromWords, resultWords, usageWords } from "../../packages/ui/src/api/learned.js";
import { LearnedSection } from "../../packages/ui/src/screens/project/LearnedSection.js";
import { LessonsUsedCard } from "../../packages/ui/src/screens/session/LessonsUsedCard.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { meFixture } from "./support/fixtures.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { ID } from "./support/work-fixture.js";

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
  return { ...f, ...ui, query, close() { ui.unmount();query.clear(); } };
}

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
it("F4: the Asked-to-retire list hides Retire on its own failed re-read, shows the Reconnecting line, and sends nothing [mutant: RetireRequests ignores its stale state]", async () => {
  const sent: ApiRequest[] = [];
  let down = false;
  const answers = learnedAnswers({ send: request => { sent.push(request);return ok({ project: "web", lessonId: "les_logs0001" }); } });
  const f = mount(h(LearnedSection, { project: "web" }), request => down && request.path.endsWith("/lessons/retire-requests") ? { status: 503, body: { error: { code: "UNAVAILABLE", message: "Try later." } } } : answers(request));
  const section = await screen.findByTestId("learned");
  const requests = await within(section).findByTestId("retire-requests");
  expect(within(requests).getByRole("button", { name: "Retire lesson" })).toBeTruthy();
  down = true;
  await act(async () => { await f.query.refetchQueries({ predicate: q => q.queryKey.includes("retire-requests") }); });
  await waitFor(() => expect(within(screen.getByTestId("retire-requests")).queryByText(/Reconnecting/u)).not.toBeNull());
  const stale = screen.getByTestId("retire-requests");
  expect(within(stale).queryByRole("button", { name: "Retire lesson" })).toBeNull();
  expect(within(stale).queryByRole("combobox")).toBeNull();
  expect(stale.textContent).toContain("Log request ids");
  expect(sent.filter(request => request.path.endsWith("/retire"))).toHaveLength(0);
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
