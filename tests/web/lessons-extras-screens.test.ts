// @vitest-environment jsdom
// Lessons extras on the screens (L4-B12 U1-U5, review additions): the Keep it? card and the read-only "Needs a look" lines, the trial offer, the weekly summary row,
// "Check how lessons are doing" (replay + suggested settings), and the repeated-corrections lines. Code decides who sees what: a 403 or a missing route draws nothing.
import { afterEach, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { LearnedSection } from "../../packages/ui/src/screens/project/LearnedSection.js";
import { CompanyRepeatsLine, companyRepeatWords, repeatWords } from "../../packages/ui/src/screens/project/lessons/RepeatsLine.js";
import { WeeklySummaryReaderSchema, CompanyLessonRepeatsReaderSchema, LessonTuningReaderSchema } from "@agentx/contracts/web";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";

const ok = (body: unknown): ApiResponse => ({ status: 200, body });
const refuse = (status: number, code = "FORBIDDEN", message = "Code says no."): ApiResponse => ({ status, body: { error: { code, message } } });
const MEASURE = { project: "web", windowDays: 30, floor: 0.35, loads: 7, lessonsInUse: 12, loadedLessons: 21, loadedBelowFloor: 3, loadsWithBelowFloor: 2, loadedNoMatch: 1, meanWordsLoaded: 0.42, meanWordsLeftOut: 0.3, loadsCapBound: 1, leftOutAtOrAboveFloor: 4, meanFitLoaded: 0.61, meanFitLeftOut: 0.39, cleanMerge: { merged: 5, reverted: 0, clean: 5, rate: 1 }, revertDetection: "wired", truncated: false, unreadable: 0 };
const KEEP = { id: "les_keep0001", title: "Wrap network calls in withRetry", cause: "asked_to_keep", area: "src/billing/", repeat: { matched: 9, back: 0 } };
const REVERT = { id: "les_rev00001", title: "Use the shared logger", cause: "revert_overlap", area: "src/logging/" };

interface Options {
  canDecide?: boolean; mode?: Record<string, unknown>; weekly?: ApiResponse; summary?: ApiResponse; measure?: ApiResponse; replay?: ApiResponse; tuning?: ApiResponse; repeats?: ApiResponse;
  send?: (request: ApiRequest) => ApiResponse;
}
const answers = (options: Options) => (request: ApiRequest): ApiResponse => {
  const path = new URL(request.path, "https://x.example").pathname;
  if (request.method !== "GET") return options.send?.(request) ?? ok({});
  const miss = refuse(404, "NOT_FOUND", "route not found");
  if (path.endsWith("/lessons/mode")) return ok({ project: "web", mode: "suggest", effective: "suggest", lockedByCompany: false, canChange: true, ...options.mode });
  if (path.endsWith("/lessons/retire-requests")) return ok({ project: "web", requests: [], more: false });
  if (path.endsWith("/lessons/graduation")) return ok({ project: "web", canDecide: true, drafts: [], rules: [] });
  if (path.endsWith("/lessons/weekly")) return options.weekly ?? ok({ project: "web", weekly: { needLook: [], picks: [] } });
  if (path.endsWith("/lessons/weekly-summary")) return options.summary ?? ok({ project: "web", on: true, source: "chosen", canChange: true });
  if (path.endsWith("/lessons/measure")) return options.measure ?? ok(MEASURE);
  if (path.endsWith("/lessons/replay")) return options.replay ?? miss;
  if (path.endsWith("/lessons/tuning")) return options.tuning ?? miss;
  if (path.endsWith("/lessons/repeats")) return options.repeats ?? miss;
  if (path.endsWith("/lessons")) return ok({ project: "web", list: new URL(request.path, "https://x.example").searchParams.get("list"), canDecide: options.canDecide ?? true, lessons: [] });
  return miss;
};
function mount(options: Options = {}) {
  const f = fakeHost(async request => answers(options)(request));
  const query = createQueryClient(), path = "/app/projects/web";
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: [path], children: h(Announcer, { children: h(Routes, {}, h(Route, { path, element: h(LearnedSection, { project: "web" }) })) }) }) }) }));
  return { ...f, ...ui, close() { ui.unmount();query.clear(); }, calls: (method: string, suffix: string) => f.request.mock.calls.map(([request]) => request).filter(request => request.method === method && new URL(request.path, "https://x.example").pathname.endsWith(suffix)) };
}
const announced = () => document.querySelector(".rv-visually-hidden[aria-live]")?.textContent ?? "";
afterEach(() => undefined);

it("draws a Keep it? card from an asked_to_keep row, sends one empty keep, and announces", async () => {
  const f = mount({ weekly: ok({ project: "web", weekly: { needLook: [KEEP], picks: [] } }) });
  const card = await screen.findByTestId("keep-card");
  expect(within(card).getByRole("heading", { name: "Keep it?" })).toBeTruthy();
  expect(within(card).getByText("Wrap network calls in withRetry")).toBeTruthy();
  expect(within(card).getByText("No task has needed this lesson for a long time.")).toBeTruthy();
  expect(within(card).getByText(/Applies to: src\/billing\//u)).toBeTruthy();
  expect(within(card).getByText("Since this lesson: the correction came back 0 times in 9 matching tasks.")).toBeTruthy();
  expect(within(card).getByText("If nobody answers, Rovara stops giving it to tasks.")).toBeTruthy();
  await expectNoAxeViolations(f.container);
  fireEvent.click(within(card).getByRole("button", { name: "Keep" }));
  await waitFor(() => expect(f.calls("POST", "/les_keep0001/keep")).toHaveLength(1));
  expect(f.calls("POST", "/les_keep0001/keep")[0]!.body).toEqual({});
  await waitFor(() => expect(announced()).toBe("Kept. Rovara will keep giving it to tasks where it fits."), { timeout: 4000 });
  f.close();
});

it("says someone already answered on a 409 and says nothing was changed on another failure", async () => {
  const conflict = mount({ weekly: ok({ project: "web", weekly: { needLook: [KEEP], picks: [] } }), send: () => refuse(409, "IDEMPOTENCY_CONFLICT", "no") });
  fireEvent.click(within(await conflict.findByTestId("keep-card")).getByRole("button", { name: "Keep" }));
  await waitFor(() => expect(announced()).toBe("Someone already answered this."), { timeout: 4000 });
  conflict.close();
  const failed = mount({ weekly: ok({ project: "web", weekly: { needLook: [KEEP], picks: [] } }), send: () => refuse(500, "RUNTIME_UNAVAILABLE", "x") });
  const card = await failed.findByTestId("keep-card");
  fireEvent.click(within(card).getByRole("button", { name: "Keep" }));
  expect(await within(card).findByText("That didn't go through. Reload to check where it stands.")).toBeTruthy();
  expect(failed.calls("POST", "/les_keep0001/keep")).toHaveLength(1);
  failed.close();
});

it("Retire on a Keep it? card opens the reason picker and retires once", async () => {
  const f = mount({ weekly: ok({ project: "web", weekly: { needLook: [KEEP], picks: [] } }) });
  const card = await f.findByTestId("keep-card");
  fireEvent.click(within(card).getByRole("button", { name: "Retire" }));
  expect(within(card).getByText("Why retire this lesson?")).toBeTruthy();
  expect(f.calls("POST", "/retire")).toHaveLength(0);
  fireEvent.click(within(card).getByRole("button", { name: "Retire" }));
  await waitFor(() => expect(f.calls("POST", "/les_keep0001/retire")).toHaveLength(1));
  f.close();
});

it("draws the other causes as read-only Needs a look lines, with no buttons", async () => {
  const f = mount({ weekly: ok({ project: "web", weekly: { needLook: [REVERT, { id: "les_new00001", title: "Newer idea", cause: "something_new" }], picks: [] } }) });
  const lines = await f.findAllByTestId("needs-a-look");
  expect(lines).toHaveLength(2);
  expect(lines[0]!.textContent).toBe("Needs a look: Use the shared logger. A revert touched its area.");
  expect(lines[1]!.textContent).toBe("Needs a look: Newer idea. Check that it still holds.");
  expect(within(lines[0]!).getByRole("link", { name: "Use the shared logger" })).toBeTruthy();
  expect(f.queryByTestId("keep-card")).toBeNull();
  expect(f.queryByRole("button", { name: "Keep" })).toBeNull();
  f.close();
});

it("draws nothing for a person who cannot decide, an empty list, a 403 or a Code that has no weekly route", async () => {
  const member = mount({ canDecide: false, weekly: ok({ project: "web", weekly: { needLook: [KEEP], picks: [] } }) });
  await waitFor(() => expect(member.queryByTestId("learned")).not.toBeNull());
  await member.findByTestId("learned");
  expect(member.queryByTestId("keep-card")).toBeNull();
  expect(member.calls("GET", "/lessons/weekly")).toHaveLength(0);
  member.close();
  for (const weekly of [ok({ project: "web", weekly: { needLook: [], picks: [{ id: "les_p", title: "p" }] } }), refuse(403), refuse(404, "NOT_FOUND", "route not found"), { status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "x" } } } as ApiResponse]) {
    const f = mount({ weekly });
    await f.findByTestId("learned");
    await waitFor(() => expect(f.calls("GET", "/lessons/weekly")).toHaveLength(1));
    expect(f.queryByTestId("keep-card")).toBeNull();
    expect(f.queryByTestId("needs-a-look")).toBeNull();
    expect(f.queryByTestId("this-week")).toBeNull();
    f.close();
  }
});

it("shows the trial offer only when the mode read carries it, and says what happened after each answer", async () => {
  const none = mount();
  await none.findByTestId("weekly-summary");
  expect(none.queryByTestId("trial-offer")).toBeNull();
  none.close();
  const f = mount({ mode: { trialOffer: { approvals: 12, drops: 1, since: 5 } } });
  const card = await f.findByTestId("trial-offer");
  expect(within(card).getByRole("heading", { name: "Let low-risk lessons go live on trial?" })).toBeTruthy();
  expect(within(card).getByText(/Your team kept 12 of the last 13 suggestions/u)).toBeTruthy();
  await expectNoAxeViolations(f.container);
  fireEvent.click(within(card).getByRole("button", { name: "Not now" }));
  await waitFor(() => expect(f.calls("POST", "/lessons/mode/trial-offer")).toHaveLength(1));
  expect(f.calls("POST", "/lessons/mode/trial-offer")[0]!.body).toEqual({ decision: "not_now" });
  await waitFor(() => expect(announced()).toBe("Okay. Rovara won't ask again for 30 days."), { timeout: 4000 });
  f.close();
  const accept = mount({ mode: { trialOffer: { approvals: 12, drops: 0, since: 5 } }, send: request => (request.path.endsWith("/trial-offer") ? ok({ project: "web", decided: "accept" }) : ok({})) });
  const again = await accept.findByTestId("trial-offer");
  expect(within(again).getByText("Your team kept all 12 of the last suggestions.")).toBeTruthy();
  fireEvent.click(within(again).getByRole("button", { name: "Turn on trial" }));
  await waitFor(() => expect(announced()).toBe("Learning is now On. Low-risk lessons go live on trial."), { timeout: 4000 });
  expect(accept.calls("POST", "/lessons/mode/trial-offer")[0]!.body).toEqual({ decision: "accept" });
  accept.close();
});

it("words the weekly summary by source, is read-only for a person who cannot change it, and puts the switch back when the save fails", async () => {
  const pilot = mount({ summary: ok({ project: "web", on: true, source: "pilot_default", canChange: false }) });
  const row = await pilot.findByTestId("weekly-summary");
  expect(within(row).getByRole("heading", { name: "Weekly summary in chat" })).toBeTruthy();
  expect(within(row).getByText("On by default for your company. Turn it off here for this project.")).toBeTruthy();
  expect(within(row).getByText("Each person gets it in the chat they chose in their own notice settings.")).toBeTruthy();
  expect(within(row).queryByRole("checkbox")).toBeNull();
  expect(within(row).getByText(/Only a project maintainer, or a company owner or admin, can change this/u)).toBeTruthy();
  pilot.close();
  const off = mount({ summary: ok({ project: "web", on: false, source: "default", canChange: true }), mode: { mode: "off", effective: "off" }, send: () => refuse(503, "AUDIT_UNAVAILABLE", "x") });
  const offRow = await off.findByTestId("weekly-summary");
  expect(within(offRow).getByText("Off. Nobody gets a weekly message. Suggestions still wait here.")).toBeTruthy();
  expect(within(offRow).getByText("Off by default.")).toBeTruthy();
  const box = within(offRow).getByRole<HTMLInputElement>("checkbox");
  expect(box.checked).toBe(false);
  fireEvent.click(box);
  expect(await within(offRow).findByText("Couldn't save that. Reload to check where it stands.")).toBeTruthy();
  expect(off.calls("PUT", "/lessons/weekly-summary")[0]!.body).toEqual({ on: true });
  await waitFor(() => expect((within(offRow).getByRole<HTMLInputElement>("checkbox")).checked).toBe(false));
  off.close();
});

it("leaves the weekly summary row out when lessons are off, the route is not served or Code says no", async () => {
  for (const summary of [refuse(403), refuse(404, "NOT_FOUND", "route not found"), refuse(409, "LESSONS_SWITCHED_OFF", "off")]) {
    const f = mount({ summary });
    await f.findByTestId("learned");
    await waitFor(() => expect(f.calls("GET", "/lessons/weekly-summary")).toHaveLength(1));
    expect(f.queryByTestId("weekly-summary")).toBeNull();
    expect(f.queryByText("Couldn't load the weekly summary setting. Try again.")).toBeNull();
    f.close();
  }
});

const TUNING = {
  project: "web", windowDays: 30, ready: true, message: "64 loads in the last 30 days.",
  evidence: { loads: 64, loadedLessons: 90, lessonsLoaded: 20, mergedTasks: 30, revertedTasks: 3, cleanMergeRate: 0.9, meanWordsCleanTasks: 0.5, meanWordsRevertedTasks: 0.4, truncated: false, unreadable: 0 },
  suggestions: [
    { setting: "fitFloorWords", status: "suggested", current: 0.35, suggested: 0.4, evidence: { have: 64, needed: 20, unit: "loads" }, message: "suggest 0.4 (now 0.35): most loaded lessons sit above it" },
    { setting: "stepLessonCap", status: "keep", current: 5, suggested: 5, evidence: { have: 64, needed: 20, unit: "loads" }, message: "keep 5: steps rarely reach the cap" },
    { setting: "fitFloorCosine", status: "not_enough_data", current: 0.5, evidence: { have: 7, needed: 30, unit: "loads" }, message: "not enough data yet (7 of 30 loads)" },
    { setting: "weeklyPicks", status: "no_data_source", current: 5, evidence: { have: 0, needed: 0, unit: "decided" }, message: "no value suggested" },
    { setting: "brandNewSetting", status: "suggested", current: 1, suggested: 2, evidence: { have: 1, needed: 1, unit: "x" }, message: "suggest 2 (now 1): a newer reason" },
  ],
  note: "These are suggestions only. Nothing changes until an operator or admin applies a value in the lessons ranking settings.",
};

it("keeps the check block closed and absent unless Code answers the measure; replay runs only on the button", async () => {
  const denied = mount({ measure: refuse(403) });
  await denied.findByTestId("learned");
  await waitFor(() => expect(denied.calls("GET", "/lessons/measure").length).toBeGreaterThan(0));
  expect(denied.queryByTestId("lesson-checks")).toBeNull();
  expect(denied.calls("GET", "/lessons/replay")).toHaveLength(0);
  denied.close();
  const f = mount({ replay: ok({ project: "web", tasks: [{ taskId: "t1", stage: "IMPLEMENT", round: 1, actual: ["a"], replayed: ["a", "b", "c"], gained: ["b", "c"], lost: [], changed: true }, { taskId: "t2", stage: "PLAN", round: 1, actual: [], replayed: [], gained: [], lost: [], changed: false }], totals: { changedTasks: 1, lessonsGained: 2, lessonsLost: 0 } }), tuning: ok(TUNING) });
  const checks = await f.findByTestId("lesson-checks");
  expect(within(checks).getByText("For project admins. Read-only.")).toBeTruthy();
  expect(f.queryByRole("heading", { name: "Replay check" })).toBeNull();
  fireEvent.click(within(checks).getByRole("button", { name: "Check how lessons are doing" }));
  expect(await f.findByRole("heading", { name: "Replay check" })).toBeTruthy();
  expect(f.calls("GET", "/lessons/replay")).toHaveLength(0);
  fireEvent.click(f.getByRole("button", { name: "Run check" }));
  expect(await f.findByText("1 of 2 tasks would get different lessons today: 2 added, 0 left out.")).toBeTruthy();
  expect(f.calls("GET", "/lessons/replay")).toHaveLength(1);
  expect(new URL(f.calls("GET", "/lessons/replay")[0]!.path, "https://x.example").searchParams.get("tasks")).toBe("30");
  await expectNoAxeViolations(f.container);
  f.close();
});

it("says same lessons for all tasks, and says the check could not run when Code fails", { timeout: 20000 }, async () => {
  const same = mount({ replay: ok({ project: "web", tasks: [{ taskId: "t1", stage: "PLAN", round: 1, actual: [], replayed: [], gained: [], lost: [], changed: false }], totals: { changedTasks: 0, lessonsGained: 0, lessonsLost: 0 } }), tuning: ok(TUNING) });
  fireEvent.click(await same.findByRole("button", { name: "Check how lessons are doing" }));
  fireEvent.click(await same.findByRole("button", { name: "Run check" }));
  expect(await same.findByText("Same lessons for all 1 tasks checked.")).toBeTruthy();
  same.close();
  const down = mount({ replay: refuse(503, "RUNTIME_UNAVAILABLE", "x"), tuning: ok(TUNING) });
  fireEvent.click(await down.findByRole("button", { name: "Check how lessons are doing" }));
  fireEvent.click(await down.findByRole("button", { name: "Run check" }));
  expect(await down.findByText("Rovara couldn't run the check right now. Try again, or check fewer tasks.", {}, { timeout: 8000 })).toBeTruthy();
  down.close();
});

it("draws suggested settings as a table of all four statuses, never an apply button, and survives a setting it does not know", async () => {
  const f = mount({ tuning: ok(TUNING) });
  fireEvent.click(await f.findByRole("button", { name: "Check how lessons are doing" }));
  const table = await f.findByRole("table");
  const rows = within(table).getAllByRole("row").slice(1).map(row => [...row.querySelectorAll("th,td")].map(cell => cell.textContent));
  expect(rows).toEqual([
    ["How closely a lesson must match a task (words)", "0.35", "0.4", "most loaded lessons sit above it"],
    ["Lessons given to one step", "5", "Keep", "steps rarely reach the cap"],
    ["How closely a lesson must match a task (meaning)", "0.5", "Not yet", "7 of 30 needed"],
    ["New suggestions per week", "5", "No suggestion", "Nothing measured can inform this yet."],
    ["brandNewSetting", "1", "2", "a newer reason"],
  ]);
  expect(f.getByText("Based on 64 lesson loads in the last 30 days.")).toBeTruthy();
  expect(f.getByText("These are suggestions only. Nothing changes here. Ask Rovara support to apply a value.")).toBeTruthy();
  expect(f.queryByText(/operator or admin applies/u)).toBeNull();
  expect(f.queryByRole("button", { name: /apply/iu })).toBeNull();
  fireEvent.click(f.getByText("Show the numbers"));
  expect(f.getByText("Clean merge rate: 90%")).toBeTruthy();
  expect(f.getByText("Lessons in clean tasks matched slightly better than in reverted tasks.")).toBeTruthy();
  await expectNoAxeViolations(f.container);
  f.close();
});

it("hides the suggestions table when there is not enough data and when the read fails", { timeout: 20000 }, async () => {
  const early = mount({ tuning: ok({ ...TUNING, ready: false, message: "x", evidence: { ...TUNING.evidence, loads: 7 }, suggestions: [] }) });
  fireEvent.click(await early.findByRole("button", { name: "Check how lessons are doing" }));
  expect(await early.findByText("Not enough data yet: 7 lesson loads so far. Come back after more tasks have run.")).toBeTruthy();
  expect(early.queryByRole("table")).toBeNull();
  early.close();
  const down = mount({ tuning: refuse(503, "RUNTIME_UNAVAILABLE", "x") });
  fireEvent.click(await down.findByRole("button", { name: "Check how lessons are doing" }));
  expect(await down.findByText("Suggested settings are unavailable right now. Try again.", {}, { timeout: 8000 })).toBeTruthy();
  down.close();
});

it("draws the repeated-corrections line in Learned only when Code answers it", async () => {
  const f = mount({ repeats: ok({ project: "web", month: "2026-11", repeated: 3, corrections: 21, enoughData: true, split: { lessonLoaded: 2, lessonNotLoaded: 0, noLesson: 1 }, unjudged: 0, truncated: false }) });
  expect((await f.findByTestId("lesson-repeats")).textContent).toBe("Corrections you had to repeat: 3 of 21 this month.");
  f.close();
  const none = mount();
  await none.findByTestId("learned");
  await waitFor(() => expect(none.calls("GET", "/lessons/repeats")).toHaveLength(1));
  expect(none.queryByTestId("lesson-repeats")).toBeNull();
  none.close();
});

it("words the repeat counts for a project and for the company, including a stopped-early sum", () => {
  expect(repeatWords({ repeated: 3, corrections: 2000, enoughData: true, truncated: true })).toBe("Corrections you had to repeat: 3 of 2000 this month (first 2,000 corrections counted).");
  expect(companyRepeatWords({ repeated: 9, corrections: 80, enoughData: true, projects: 6 })).toBe("Corrections people had to repeat: 9 of 80 this month, across 6 projects.");
  expect(companyRepeatWords({ repeated: 1, corrections: 12, enoughData: true, projects: 1, truncated: true })).toBe("Corrections people had to repeat: 1 of 12 this month, across 1 project. Some projects are not counted yet.");
  expect(companyRepeatWords({ repeated: 0, corrections: 4, enoughData: false, projects: 2 })).toBe("Not enough corrections yet this month (4 so far; 10 needed).");
  expect(companyRepeatWords({ repeated: 0, corrections: 0, enoughData: false, projects: 0 })).toBe("No corrections yet this month.");
});

it("loads the company line only for an owner or admin and leaves it out on a Code refusal", async () => {
  const mountLine = (enabled: boolean, answer: ApiResponse) => {
    const f = fakeHost(async () => answer), query = createQueryClient();
    const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, {}, h(CompanyRepeatsLine, { enabled })) }) }));
    return { ...f, ...ui };
  };
  const member = mountLine(false, ok({}));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(member.request).not.toHaveBeenCalled();
  member.unmount();
  const admin = mountLine(true, ok({ scope: "company", month: "2026-11", projects: [{ project: "a", repeated: 1, corrections: 10, enoughData: true }], repeated: 9, corrections: 80, enoughData: true, unjudged: 0, truncated: false }));
  expect((await admin.findByTestId("company-repeats")).textContent).toBe("Corrections people had to repeat: 9 of 80 this month, across 1 project.");
  admin.unmount();
  const refused = mountLine(true, refuse(403));
  await waitFor(() => expect(refused.request).toHaveBeenCalled());
  expect(refused.queryByTestId("company-repeats")).toBeNull();
});

it("reads the real shapes Code sends: the strict readers accept unjudged and truncated, and the tuning evidence keeps its numbers", () => {
  expect(CompanyLessonRepeatsReaderSchema.parse({ scope: "company", month: "2026-11", projects: [], repeated: 0, corrections: 0, enoughData: false, unjudged: 0, truncated: true }).truncated).toBe(true);
  expect(WeeklySummaryReaderSchema.parse({ project: "p", on: true, source: "pilot_default", canChange: true }).source).toBe("pilot_default");
  expect(LessonTuningReaderSchema.parse(TUNING).evidence["loads"]).toBe(64);
});
