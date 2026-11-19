// @vitest-environment jsdom
// Lessons phase 4 on the screens (L4-LP4G): "This week" in Learned (the one "Make this permanent?" card, the tidy card, draft tasks), "Both, in different places" on a
// proposed lesson that contradicts another, and what a retired lesson became. Every write is sent once; nothing here starts a task.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import type { LessonItem } from "../../packages/contracts/src/code-contract-v0.js";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { GraduationReader, SAME_CHOICE_WORDS, TARGET_BUTTON_WORDS, TARGET_WORDS, WAITING_WORDS, becameWords, bothPlacesWords, graduatedWords, needsWords, parsePaths, plainPath, provenWords, taskIdFrom, tidyUseWords, whereWords } from "../../packages/ui/src/api/graduation.js";
import { LearnedSection } from "../../packages/ui/src/screens/project/LearnedSection.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";

const DAY = 864e5, NOW = Date.now();
afterEach(() => { vi.useRealTimers(); });
const ok = (body: unknown): ApiResponse => ({ status: 200, body });
function lesson(id: string, patch: Partial<LessonItem> = {}): LessonItem {
  return { id, version: 1, type: "convention", stages: ["IMPLEMENT"], title: `Lesson ${id}`, description: "Retries go through withRetry.", body: "Wrap network calls in withRetry.", scope: { repos: [], paths: [], languages: [] }, tier: 1, status: "pending",
    counters: { loaded: 0, helpful: 0, harmful: 0 }, createdAt: NOW - DAY, updatedAt: NOW - DAY, expiresAt: NOW + 5 * DAY, citations: [], from: [{ name: "Sam" }], measured: true, supportTasks: 1, canApprove: true, canReject: true, canRetire: true, ...patch };
}
const CARD = { lessonId: "les_logs0001", version: 1, title: "Log request ids with every error", description: "Error logs carry the request id.", type: "convention", tier: 1, target: "rule", targets: ["rule", "check", "skill"], paths: ["src/logging/**"], tasks: 12, days: 41, needs: { required: 1, have: 0, you: false } };
const TIDY = { period: 30, lessons: [{ lessonId: "les_old00001", version: 1, title: "Old A", type: "fact", tasks: 3, days: 20 }, { lessonId: "les_old00002", version: 2, title: "Old B", type: "fact", tasks: 0, days: 25 }, { lessonId: "les_old00003", version: 1, title: "Old C", type: "pitfall", tasks: 1, days: 30 }] };
const DRAFT = { id: "chk_0123456789abcdef", lessonId: "les_old00001", title: "Check that scripts have no semicolons", request: "Add a check that fails when a file in scripts/legacy has a semicolon.\nKeep it fast.", paths: ["scripts/legacy/**"], createdAt: NOW - DAY };
const RULE = { id: "rule_0123456789abcdef", text: "Every error log carries the request id.", paths: ["src/logging/**"], repos: ["acme/web"], fromLesson: "les_logs0001", createdAt: NOW - DAY };
const TASK = "123e4567-e89b-42d3-a456-426614174000";

interface Options { canDecide?: boolean; graduation?: Record<string, unknown> | ApiResponse; proposed?: LessonItem[]; approved?: LessonItem[]; retired?: LessonItem[]; send?: (request: ApiRequest) => ApiResponse }
const answers = (options: Options = {}) => (request: ApiRequest): ApiResponse | undefined => {
  if (request.method !== "GET") return options.send?.(request);
  const url = new URL(request.path, "https://x.example"), path = url.pathname;
  if (path.endsWith("/lessons/mode")) return ok({ project: "web", mode: "suggest", effective: "suggest", lockedByCompany: false, canChange: true });
  if (path.endsWith("/lessons/retire-requests")) return ok({ project: "web", requests: [], more: false });
  if (path.endsWith("/lessons/graduation")) { const g = options.graduation; return g !== undefined && "status" in g && "body" in g ? g as ApiResponse : ok({ project: "web", canDecide: true, card: CARD, tidy: TIDY, drafts: [DRAFT], rules: [], ...g }); }
  if (path.endsWith("/lessons")) {
    const list = url.searchParams.get("list"), canDecide = options.canDecide ?? true;
    if (list === "approved") return ok({ project: "web", list, canDecide, lessons: options.approved ?? [lesson("les_logs0001", { status: "active", title: "Log request ids" })] });
    if (list === "proposed") return ok({ project: "web", list, canDecide: true, lessons: options.proposed ?? [] });
    return ok({ project: "web", list, canDecide: true, lessons: options.retired ?? [] });
  }
  return undefined;
};
function mount(options: Options = {}) {
  const f = fakeHost(async request => answers(options)(request) ?? { status: 404, body: { error: { code: "NOT_FOUND", message: "no" } } });
  const query = createQueryClient();
  const path = "/app/projects/web";
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: [path], children: h(Announcer, { children: h(Routes, {}, h(Route, { path, element: h(LearnedSection, { project: "web" }) })) }) }) }) }));
  return { ...f, ...ui, close() { ui.unmount();query.clear(); }, sends: () => f.request.mock.calls.map(([request]) => request).filter(request => request.method !== "GET") };
}
const week = () => screen.findByTestId("this-week");

// ---- Words ----
it("words the targets, the buttons, what a lesson became, the proof and the people it needs in fixed words", () => {
  expect(TARGET_WORDS).toEqual({ rule: "A team rule for this code area", check: "A draft task to add a check (you start it)", skill: "A skill" });
  expect(TARGET_BUTTON_WORDS).toEqual({ rule: "Make it a rule", check: "Make a draft task", skill: "Make a skill" });
  expect([becameWords("rule"), becameWords("check"), becameWords("skill")]).toEqual(["Became a team rule", "Became a draft task to add a check", "Became a skill"]);
  // A kind this build does not know is never worded as one it does.
  expect(becameWords("playbook")).toBe("Made permanent");
  expect(becameWords("other")).toBe("Made permanent");
  expect(WAITING_WORDS).toBe("Waiting for a second person");
  expect(provenWords({ tasks: 12, days: 41 })).toBe("Used in 12 tasks over 41 days");
  expect(provenWords({ tasks: 1, days: 1 })).toBe("Used in 1 task over 1 day");
  expect(whereWords([])).toBe("The whole project");
  expect(whereWords(["src/a/**", "src/b/**"])).toBe("Code paths: src/a/**, src/b/**");
  expect(needsWords({ required: 1, have: 0, you: false })).toBeUndefined();
  expect(needsWords({ required: 2, have: 0, you: false })).toBe("Needs two people");
  expect(needsWords({ required: 2, have: 1, you: false })).toBe("One person asked; needs one more");
  expect(tidyUseWords({ tasks: 0, days: 5 })).toBe("Not used by a task yet");
  expect(graduatedWords({ project: "web", lessonId: "a", target: "rule", state: "waiting", needs: "second_person" })).toContain(WAITING_WORDS);
  expect(graduatedWords({ project: "web", lessonId: "a", target: "rule", state: "unknown" })).toContain("Reload the page");
  expect(bothPlacesWords({ project: "web", lessonId: "a", otherId: "b", cardPaths: [], otherPaths: [], version: 1, status: "pending", needs: "second_person" })).toContain("one more person");
  expect(bothPlacesWords({ project: "web", lessonId: "a", otherId: "b", cardPaths: [], otherPaths: [], version: 1, status: "active", needs: "nothing" })).not.toContain("needs");
});
it("takes the one task id in a pasted link or id, and plain relative paths only", () => {
  expect(taskIdFrom(TASK)).toBe(TASK);
  expect(taskIdFrom(`  https://app.example/app/sessions/x?task=${TASK.toUpperCase()}#plan `)).toBe(TASK);
  expect(taskIdFrom("not a task")).toBeUndefined();
  expect(taskIdFrom("123e4567-e89b-42d3-a456")).toBeUndefined();
  expect(taskIdFrom(`${TASK} 223e4567-e89b-42d3-a456-426614174000`)).toBeUndefined();
  expect(taskIdFrom(`${TASK} ${TASK}`)).toBe(TASK);
  expect(parsePaths(" src/a/** ,\nsrc/b/**\n\n src/a/** ")).toEqual(["src/a/**", "src/b/**"]);
  expect(["src/**", "a/b.ts"].every(plainPath)).toBe(true);
  expect(["", "/abs", "a/../b", "a\\b", "x".repeat(201), "a b", "a{b,c}", "a,b"].some(plainPath)).toBe(false);
  expect(["~/x", "a/b~", "@scope/pkg/**", "a+b?.ts"].every(plainPath)).toBe(true);
});
it("reads the graduation answer only for a person who decides, one card with the suggestion first, up to 10 tidy lessons, and drafts with the fields it draws", () => {
  const full = { project: "web", card: { ...CARD, target: "skill", targets: ["rule", "wiki", "skill"], extra: 1 }, tidy: { period: 30, lessons: Array.from({ length: 14 }, (_, index) => ({ lessonId: `les_t${String(index).padStart(5, "0")}`, version: 1, title: "T" })) }, drafts: [DRAFT, { id: 5 }], rules: [RULE, { id: "r" }, "x", { ...RULE, id: "rule_fedcba9876543210", text: "" }] };
  expect(GraduationReader.parse({ ...full, canDecide: false })).toEqual({ project: "web", canDecide: false, drafts: [], rules: [] });
  const read = GraduationReader.parse({ ...full, canDecide: true });
  expect(read.card?.targets).toEqual(["skill", "rule"]);
  expect(read.tidy?.lessons).toHaveLength(10);
  expect(read.drafts).toEqual([DRAFT]);
  expect(GraduationReader.parse({ project: "web", canDecide: true, card: { ...CARD, paths: ["a/**", "a/**", "b/**"] } }).card?.paths).toEqual(["a/**", "b/**"]);
  expect(read.rules).toEqual([RULE]);
  expect(GraduationReader.parse({ project: "web", canDecide: true, card: { ...CARD, target: "wiki", targets: ["wiki"] } }).card).toBeUndefined();
  expect(() => GraduationReader.parse({ canDecide: true })).toThrow();
});

// ---- This week ----
it("draws the one Make this permanent card for a person who decides: the proof in words, where it applies, the suggestion first and the paths filled in", async () => {
  const f = mount();
  const thisWeek = await week();
  const card = within(thisWeek).getByTestId("permanent-card");
  expect(within(thisWeek).getAllByTestId("permanent-card")).toHaveLength(1);
  expect(within(card).getByRole("heading", { name: "Make this permanent?" })).toBeTruthy();
  expect(card.textContent).toContain("Log request ids with every error");
  expect(within(card).getByTestId("permanent-proven").textContent).toBe("Used in 12 tasks over 41 days");
  expect(within(card).getByTestId("permanent-where").textContent).toBe("Code paths: src/logging/**");
  const radios = within(card).getAllByRole("radio");
  expect(radios.map(radio => radio.parentElement!.textContent)).toEqual(["A team rule for this code area (suggested)", "A draft task to add a check (you start it)", "A skill"]);
  expect(radios[0]).toHaveProperty("checked", true);
  // A rule can only narrow the lesson's own paths: they are chips, all chosen, and there is no field to type a wider one.
  expect(within(card).getByRole("checkbox", { name: "src/logging/**" }).getAttribute("aria-checked")).toBe("true");
  expect(within(card).queryByRole("textbox", { name: "Code paths it applies to" })).toBeNull();
  expect(within(card).getByRole("button", { name: "Make it a rule" })).toBeTruthy();
  expect(within(card).getByRole("button", { name: "Not now" })).toBeTruthy();
  expect(within(card).queryByTestId("permanent-needs")).toBeNull();
  await expectNoAxeViolations(f.container);
  f.close();
});
it("shows a dynamic-path card with only a check task and a skill", async () => {
  const f = mount({ graduation: { card: { ...CARD, target: "rule", targets: ["rule", "check", "skill"], paths: ["src/{area}/[id].ts"] } } });
  const card = await screen.findByTestId("permanent-card");
  expect(within(card).getAllByRole("radio").map(radio => radio.parentElement!.textContent)).toEqual(["A draft task to add a check (you start it)", "A skill"]);
  expect(card.textContent).toContain("Team rules need plain file paths, so this one can't become a rule.");
  expect(within(card).getByRole("button", { name: "Make a draft task" })).toBeTruthy();
  expect(within(card).queryByRole("button", { name: "Make it a rule" })).toBeNull();
  f.close();
});
it("says the whole project when the lesson has no paths, and sends no paths for it", async () => {
  const sent: ApiRequest[] = [];
  const f = mount({ graduation: { card: { ...CARD, paths: [] } }, send: request => { sent.push(request);return ok({ project: "web", lessonId: "les_logs0001", target: "rule", state: "done", ref: "rule_1", already: false }); } });
  const card = await screen.findByTestId("permanent-card");
  expect(within(card).getByTestId("permanent-where").textContent).toBe("The whole project");
  await act(async () => { fireEvent.click(within(card).getByRole("button", { name: "Make it a rule" })); });
  expect(sent[0]).toMatchObject({ method: "POST", path: "/v1/app/projects/web/lessons/les_logs0001/graduate", body: { target: "rule" }, retry: "never" });
  expect(sent[0]!.body).toEqual({ target: "rule" });
  f.close();
});
it("sends the chosen target once: a rule with the paths still chosen, a draft task, or a skill with its name, and says what came of it", async () => {
  const sent: ApiRequest[] = [];
  const f = mount({ graduation: { card: { ...CARD, paths: ["src/logging/**", "src/http/*.ts"] } }, send: request => { sent.push(request);return ok({ project: "web", lessonId: "les_logs0001", target: (request.body as { target: string }).target, state: "done", ref: "r_1", already: false }); } });
  const card = await screen.findByTestId("permanent-card");
  fireEvent.click(within(card).getByRole("checkbox", { name: "src/http/*.ts" }));
  await act(async () => { fireEvent.click(within(card).getByRole("button", { name: "Make it a rule" })); });
  expect(sent).toHaveLength(1);
  expect(sent[0]!.body).toEqual({ target: "rule", paths: ["src/logging/**"] });
  expect((await screen.findByTestId("permanent-result")).textContent).toBe("Done. It is now a team rule for this code area.");
  expect(screen.queryByRole("button", { name: "Make it a rule" })).toBeNull();
  f.close();
  sent.length = 0;
  const g = mount({ send: request => { sent.push(request);return ok({ project: "web", lessonId: "les_logs0001", target: "skill", state: "drafted", name: "log-request-ids", version: 1 }); } });
  const second = await screen.findByTestId("permanent-card");
  fireEvent.click(within(second).getByRole("radio", { name: /A skill/u }));
  expect(within(second).queryByRole("textbox", { name: "Code paths it applies to" })).toBeNull();
  fireEvent.change(within(second).getByRole("textbox", { name: /Skill name/u }), { target: { value: "Bad Name" } });
  expect(within(second).getByRole("button", { name: "Make a skill" }).hasAttribute("disabled")).toBe(true);
  fireEvent.change(within(second).getByRole("textbox", { name: /Skill name/u }), { target: { value: "log-request-ids" } });
  await act(async () => { fireEvent.click(within(second).getByRole("button", { name: "Make a skill" })); });
  expect(sent[0]!.body).toEqual({ target: "skill", name: "log-request-ids" });
  expect((await screen.findByTestId("permanent-result")).textContent).toContain('The skill "log-request-ids" was drafted.');
  g.close();
  sent.length = 0;
  const k = mount({ send: request => { sent.push(request);return ok({ project: "web", lessonId: "les_logs0001", target: "check", state: "done", ref: "chk_fedcba9876543210", already: false }); } });
  const third = await screen.findByTestId("permanent-card");
  fireEvent.click(within(third).getByRole("radio", { name: /A draft task/u }));
  await act(async () => { fireEvent.click(within(third).getByRole("button", { name: "Make a draft task" })); });
  expect(sent[0]!.body).toEqual({ target: "check" });
  expect((await screen.findByTestId("permanent-result")).textContent).toContain("Start it yourself");
  k.close();
});
it("does not send a rule with no path left, and a lesson with no paths of its own gets a field that takes only plain paths, never more than 20", async () => {
  let f = mount();
  let card = await screen.findByTestId("permanent-card");
  fireEvent.click(within(card).getByRole("checkbox", { name: "src/logging/**" }));
  expect(within(card).getByRole("button", { name: "Make it a rule" }).hasAttribute("disabled")).toBe(true);
  expect(within(card).getByRole("alert").textContent).toContain("Keep at least one path");
  expect(f.sends()).toEqual([]);
  f.close();
  f = mount({ graduation: { card: { ...CARD, paths: [] } } });
  card = await screen.findByTestId("permanent-card");
  const box = within(card).getByRole("textbox", { name: "Code paths it applies to" });
  for (const bad of ["../secret/**", "/etc/**", "a b", "a{b,c}", Array.from({ length: 21 }, (_, index) => `p${String(index)}/**`).join("\n")]) {
    fireEvent.change(box, { target: { value: bad } });
    expect(within(card).getByRole("button", { name: "Make it a rule" }).hasAttribute("disabled"), bad).toBe(true);
  }
  fireEvent.change(box, { target: { value: "src/**\n~/x" } });
  expect(within(card).getByRole("button", { name: "Make it a rule" }).hasAttribute("disabled")).toBe(false);
  expect(f.sends()).toEqual([]);
  f.close();
});
it("sends the typed paths of a lesson that has none of its own, once", async () => {
  const sent: ApiRequest[] = [];
  const f = mount({ graduation: { card: { ...CARD, paths: [] } }, send: request => { sent.push(request);return ok({ project: "web", lessonId: "les_logs0001", target: "rule", state: "done", ref: "r", already: false }); } });
  const card = await screen.findByTestId("permanent-card");
  fireEvent.change(within(card).getByRole("textbox", { name: "Code paths it applies to" }), { target: { value: "src/a/**\nsrc/b/*.ts, src/a/**" } });
  await act(async () => { fireEvent.click(within(card).getByRole("button", { name: "Make it a rule" })); });
  expect(sent[0]!.body).toEqual({ target: "rule", paths: ["src/a/**", "src/b/*.ts"] });
  f.close();
});
it("says how many people it needs, who has asked, and disables the button for a person who already asked", async () => {
  let f = mount({ graduation: { card: { ...CARD, tier: 2, needs: { required: 2, have: 0, you: false } } } });
  expect((await screen.findByTestId("permanent-needs")).textContent).toBe("Needs two people");
  expect(screen.queryByTestId("permanent-same-choice")).toBeNull();
  expect(screen.getByRole("button", { name: "Make it a rule" }).hasAttribute("disabled")).toBe(false);
  f.close();
  f = mount({ graduation: { card: { ...CARD, tier: 2, needs: { required: 2, have: 1, you: false } } } });
  expect((await screen.findByTestId("permanent-needs")).textContent).toBe("One person asked; needs one more");
  expect(screen.getByTestId("permanent-same-choice").textContent).toBe(SAME_CHOICE_WORDS);
  f.close();
  f = mount({ graduation: { card: { ...CARD, tier: 2, target: "check", needs: { required: 2, have: 1, you: false, first: { target: "rule", paths: ["src/logging/**"] } } } } });
  expect((await screen.findByTestId("permanent-same-choice")).textContent).toBe(`${SAME_CHOICE_WORDS} The first person chose: A team rule for this code area. Code paths: src/logging/**`);
  f.close();
  f = mount({ graduation: { card: { ...CARD, tier: 2, needs: { required: 2, have: 1, you: false, first: { target: "skill", paths: [] } } } } });
  expect((await screen.findByTestId("permanent-same-choice")).textContent).toBe(`${SAME_CHOICE_WORDS} The first person chose: A skill`);
  f.close();
  f = mount({ graduation: { card: { ...CARD, tier: 2, needs: { required: 2, have: 1, you: true } } } });
  const card = await screen.findByTestId("permanent-card");
  const button = within(card).getByRole("button", { name: "You already asked" });
  expect(button.hasAttribute("disabled")).toBe(true);
  fireEvent.click(button);
  expect(within(card).getByTestId("permanent-you-asked").textContent).toBe("Waiting for a second person.");
  expect(f.sends()).toEqual([]);
  f.close();
});
it("shows Waiting for a second person when Code says so, and Not now puts the lesson on hold once", async () => {
  let f = mount({ send: () => ok({ project: "web", lessonId: "les_logs0001", target: "rule", state: "waiting", needs: "second_person" }) });
  await act(async () => { fireEvent.click(await screen.findByRole("button", { name: "Make it a rule" })); });
  expect((await screen.findByTestId("permanent-result")).textContent).toContain("Waiting for a second person");
  expect(screen.getByTestId("permanent-result").textContent).toContain("choose the same target and the same paths");
  f.close();
  const sent: ApiRequest[] = [];
  f = mount({ send: request => { sent.push(request);return ok({ project: "web", lessonId: "les_logs0001", later: true }); } });
  const card = await screen.findByTestId("permanent-card");
  await act(async () => { fireEvent.click(within(card).getByRole("button", { name: "Not now" })); });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ method: "POST", path: "/v1/app/projects/web/lessons/les_logs0001/graduate-later", body: {}, retry: "never" });
  expect((await screen.findByTestId("permanent-result")).textContent).toContain("60 days");
  f.close();
});
it("shows Code's own words when it refuses, and leaves the card to try again", async () => {
  const f = mount({ send: () => ({ status: 403, body: { error: { code: "FORBIDDEN", message: "Only a maintainer of this project, or an admin, can decide what becomes permanent." } } }) });
  await act(async () => { fireEvent.click(await screen.findByRole("button", { name: "Make it a rule" })); });
  expect((await screen.findByRole("alert")).textContent).toBe("Only a maintainer of this project, or an admin, can decide what becomes permanent.");
  expect(screen.getByRole("button", { name: "Make it a rule" })).toBeTruthy();
  f.close();
});
it("draws no This week for a person who may not decide, and asks Code nothing about it, whatever the graduation answer would carry", async () => {
  const f = mount({ canDecide: false });
  await screen.findByTestId("learned");
  await waitFor(() => expect(f.request.mock.calls.some(([request]) => request.path.includes("list=approved"))).toBe(true));
  expect(screen.queryByTestId("this-week")).toBeNull();
  expect(screen.queryByTestId("permanent-card")).toBeNull();
  expect(f.request.mock.calls.some(([request]) => request.path.endsWith("/lessons/graduation"))).toBe(false);
  f.close();
  const g = mount({ graduation: { canDecide: false } });
  await waitFor(() => expect(g.request.mock.calls.some(([request]) => request.path.endsWith("/lessons/graduation"))).toBe(true));
  expect(screen.queryByTestId("this-week")).toBeNull();
  expect(screen.queryByTestId("permanent-card")).toBeNull();
  expect(screen.queryByTestId("tidy-card")).toBeNull();
  expect(screen.queryByTestId("draft-tasks")).toBeNull();
  g.close();
});
it("draws nothing for an empty week, for Lessons are off and for an older Code, and says a real failure", async () => {
  let f = mount({ graduation: { card: undefined, tidy: undefined, drafts: [] } });
  await waitFor(() => expect(f.request.mock.calls.some(([request]) => request.path.endsWith("/lessons/graduation"))).toBe(true));
  await screen.findByTestId("learned");
  expect(screen.queryByTestId("this-week")).toBeNull();
  f.close();
  for (const status of [{ status: 404, body: { error: { code: "NOT_FOUND", message: "no" } } }, { status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "not yet" } } }, { status: 403, body: { error: { code: "FORBIDDEN", message: "No." } } }]) {
    f = mount({ graduation: status });
    await waitFor(() => expect(f.request.mock.calls.some(([request]) => request.path.endsWith("/lessons/graduation"))).toBe(true));
    expect(screen.queryByRole("alert")).toBeNull();
    f.close();
  }
  f = mount({ graduation: { status: 400, body: { error: { code: "CONFIG_INVALID", message: "Rovara is busy." } } } });
  expect((await screen.findByRole("alert")).textContent).toBe("Rovara is busy.");
  f.close();
});

// ---- Tidy ----
it("lists the least used lessons with their use counts, retires only the chosen ones after one confirm, and Cancel sends nothing", async () => {
  const sent: ApiRequest[] = [];
  const f = mount({ send: request => { sent.push(request);return ok({ project: "web", retired: ["les_old00003", "les_old00001"], skipped: 0 }); } });
  const card = await screen.findByTestId("tidy-card");
  expect(within(card).getByRole("heading", { name: "3 least used: retire?" })).toBeTruthy();
  const boxes = within(card).getAllByRole("checkbox");
  expect(boxes).toHaveLength(3);
  expect(card.textContent).toContain("Used in 3 tasks over 20 days");
  expect(card.textContent).toContain("Not used by a task yet");
  const retire = () => within(card).getByRole("button", { name: "Retire chosen" });
  expect(retire().hasAttribute("disabled")).toBe(true);
  fireEvent.click(within(card).getByRole("checkbox", { name: /Old C/u }));
  fireEvent.click(within(card).getByRole("checkbox", { name: /Old A/u }));
  fireEvent.click(retire());
  expect(within(card).getByTestId("tidy-confirm").textContent).toContain("Retire 2 lessons?");
  expect(sent).toEqual([]);
  fireEvent.click(within(card).getByRole("button", { name: "Cancel" }));
  expect(sent).toEqual([]);
  fireEvent.click(retire());
  await act(async () => { fireEvent.click(within(card).getByRole("button", { name: "Retire 2 lessons" })); });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ method: "POST", path: "/v1/app/projects/web/lessons/tidy/retire", retry: "never" });
  // Only the chosen, in the list's order, and not the one left alone.
  expect(sent[0]!.body).toEqual({ ids: ["les_old00001", "les_old00003"] });
  expect((await screen.findByTestId("tidy-result")).textContent).toBe("Retired 2 lessons. Rovara no longer gives them to tasks.");
  f.close();
});
it("shows at most 10 lessons on the tidy card, whatever Code sent, and Not now closes it once", async () => {
  const sent: ApiRequest[] = [];
  const many = { period: 30, lessons: Array.from({ length: 14 }, (_, index) => ({ lessonId: `les_t${String(index).padStart(5, "0")}`, version: 1, title: `Tidy ${String(index)}`, type: "fact", tasks: index, days: 9 })) };
  const f = mount({ graduation: { tidy: many }, send: request => { sent.push(request);return ok({ project: "web", closed: true }); } });
  const card = await screen.findByTestId("tidy-card");
  expect(within(card).getByRole("heading", { name: "10 least used: retire?" })).toBeTruthy();
  expect(within(card).getAllByRole("checkbox")).toHaveLength(10);
  await act(async () => { fireEvent.click(within(card).getByRole("button", { name: "Not now" })); });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ method: "POST", path: "/v1/app/projects/web/lessons/tidy/later", body: {}, retry: "never" });
  expect((await screen.findByTestId("tidy-result")).textContent).toContain("Okay");
  f.close();
});
it("says Code's own words when a tidy retire is refused and keeps the choices", async () => {
  const f = mount({ send: () => ({ status: 403, body: { error: { code: "FORBIDDEN", message: "Only a maintainer of this project, or an admin, can decide what becomes permanent." } } }) });
  const card = await screen.findByTestId("tidy-card");
  fireEvent.click(within(card).getByRole("checkbox", { name: /Old A/u }));
  fireEvent.click(within(card).getByRole("button", { name: "Retire chosen" }));
  await act(async () => { fireEvent.click(within(card).getByRole("button", { name: "Retire 1 lesson" })); });
  expect((await within(card).findByRole("alert")).textContent).toContain("Only a maintainer");
  expect(within(card).getByRole("checkbox", { name: /Old A/u }).getAttribute("aria-checked")).toBe("true");
  f.close();
});

// ---- Draft tasks ----
it("shows each draft with its request, a Copy button and I started it and Drop it, and never starts a task itself", async () => {
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  const sent: ApiRequest[] = [];
  const f = mount({ send: request => { sent.push(request);return ok(request.path.endsWith("/started") ? { project: "web", draftId: DRAFT.id, status: "started" } : { project: "web", draftId: DRAFT.id, status: "dismissed" }); } });
  const list = await screen.findByTestId("draft-tasks");
  const draft = within(list).getByRole("article", { name: DRAFT.title });
  expect(within(draft).getByTestId("draft-request").textContent).toBe(DRAFT.request);
  await act(async () => { fireEvent.click(within(draft).getByRole("button", { name: `Copy the request: ${DRAFT.title}` })); });
  expect(writeText).toHaveBeenCalledWith(DRAFT.request);
  expect((await within(draft).findByText(/^Copied\./u)).textContent).toContain("start box");
  // The link is recorded only for a pasted task link or id.
  fireEvent.click(within(draft).getByRole("button", { name: `I started it: ${DRAFT.title}` }));
  const field = within(draft).getByRole("textbox", { name: /Link to the task you started/u });
  const save = () => within(draft).getByRole("button", { name: "Save" });
  expect(save().hasAttribute("disabled")).toBe(true);
  fireEvent.change(field, { target: { value: "my task" } });
  expect(save().hasAttribute("disabled")).toBe(true);
  expect(within(draft).getByText(/isn't a task link or id/u)).toBeTruthy();
  fireEvent.change(field, { target: { value: `https://app.example/app/sessions/abc?task=${TASK}` } });
  await act(async () => { fireEvent.click(save()); });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ method: "POST", path: `/v1/app/projects/web/lessons/check-drafts/${DRAFT.id}/started`, body: { taskId: TASK }, retry: "never" });
  expect(await within(list).findByText("Saved. Thanks for starting it.")).toBeTruthy();
  f.close();
  sent.length = 0;
  const g = mount({ send: request => { sent.push(request);return ok({ project: "web", draftId: DRAFT.id, status: "dismissed" }); } });
  await act(async () => { fireEvent.click(await screen.findByRole("button", { name: `Drop it: ${DRAFT.title}` })); });
  expect(sent[0]).toMatchObject({ method: "POST", path: `/v1/app/projects/web/lessons/check-drafts/${DRAFT.id}/dismiss`, body: {}, retry: "never" });
  g.close();
});
it("copes with a clipboard that refuses: it says to copy the request by hand", async () => {
  Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn(async () => { throw new Error("blocked"); }) }, configurable: true });
  const f = mount();
  await act(async () => { fireEvent.click(await screen.findByRole("button", { name: `Copy the request: ${DRAFT.title}` })); });
  expect(await screen.findByText(/Couldn't copy/u)).toBeTruthy();
  f.close();
});
it("never starts a task: every card, draft and answer is clicked and no request reaches the start routes, and no source of this lane names them", async () => {
  Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn(async () => undefined) }, configurable: true });
  const f = mount({ send: () => ok({ project: "web", draftId: DRAFT.id, status: "started", later: true, closed: true, retired: [], skipped: 0, lessonId: "les_logs0001", target: "rule", state: "done", ref: "r", already: false }) });
  const thisWeek = await week();
  for (const name of [`Copy the request: ${DRAFT.title}`, `I started it: ${DRAFT.title}`, `Drop it: ${DRAFT.title}`, "Not now"]) {
    const button = within(thisWeek).queryAllByRole("button", { name })[0];
    if (button !== undefined) await act(async () => { fireEvent.click(button); });
  }
  const START = /\/(code|sessions|tasks)(\/|\?|$)(?!.*lessons)/u;
  expect(f.request.mock.calls.map(([request]) => `${request.method} ${request.path}`).filter(call => START.test(call) && !call.startsWith("GET"))).toEqual([]);
  f.close();
  const root = join(process.cwd(), "packages/ui/src");
  const files = [join(root, "api/graduation.ts"), join(root, "api/learned.ts"), ...readdirSync(join(root, "screens/project/lessons")).filter(name => /^(ThisWeek|GraduationCardView|TidyCardView|DraftTasks|BothPlaces|TeamRules|graduation-shared)\./u.test(name)).map(name => join(root, "screens/project/lessons", name))];
  expect(files).toHaveLength(9);
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    expect(source, file).not.toMatch(/startCode|continueTask|continue-as-task|StartTaskRequest|useStartWork|startFromAnswer|"\/v1\/app\/projects\/"[^;\n]*\/code"|\/sessions"/u);
  }
});

// ---- Both, in different places ----
const CONFLICT = lesson("les_new00001", { title: "Put tests in a tests folder", contradicts: "les_logs0001", scope: { repos: [], paths: ["src/**"], languages: [] } });
const OLDER = lesson("les_logs0001", { status: "active", title: "Put tests next to the module" });
it("offers Both, in different places only on a proposed lesson that contradicts another and that the person may keep, and validates both fields", async () => {
  const sent: ApiRequest[] = [];
  const f = mount({ proposed: [CONFLICT, lesson("les_plain0001", { title: "No conflict here" }), lesson("les_nokeep001", { title: "Cannot keep", contradicts: "les_logs0001", canApprove: false })], approved: [OLDER],
    send: request => { sent.push(request);return ok({ project: "web", lessonId: "les_new00001", otherId: "les_logs0001", cardPaths: ["tests/**"], otherPaths: ["src/**"], version: 1, status: "pending", needs: "second_person" }); } });
  fireEvent.mouseDown(await screen.findByRole("tab", { name: "Proposed" }), { button: 0, ctrlKey: false });
  expect(await screen.findAllByRole("button", { name: /^Both, in different places:/u })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Both, in different places: Put tests in a tests folder" }));
  const form = await screen.findByRole("form", { name: "Both, in different places: Put tests in a tests folder" });
  // The older lesson is named by its title once it is in view.
  expect(await within(form).findByRole("textbox", { name: 'Where "Put tests next to the module" will apply from now on' })).toBeTruthy();
  expect(form.textContent).toContain('"Put tests next to the module" will apply only to its new place.');
  const mine = within(form).getByRole<HTMLTextAreaElement>("textbox", { name: 'Where "Put tests in a tests folder" applies' });
  const other = within(form).getByRole<HTMLTextAreaElement>("textbox", { name: /will apply from now on/u });
  const save = () => within(form).getByRole("button", { name: "Save both" });
  expect(mine.value).toBe("src/**");
  expect(save().hasAttribute("disabled")).toBe(true);
  fireEvent.change(other, { target: { value: "src/**" } });
  expect(within(form).getByRole("alert").textContent).toContain("different places");
  expect(save().hasAttribute("disabled")).toBe(true);
  fireEvent.change(other, { target: { value: "../x" } });
  expect(save().hasAttribute("disabled")).toBe(true);
  fireEvent.change(mine, { target: { value: "" } });
  fireEvent.change(other, { target: { value: "src/**" } });
  expect(save().hasAttribute("disabled")).toBe(true);
  fireEvent.change(mine, { target: { value: "tests/**" } });
  expect(save().hasAttribute("disabled")).toBe(false);
  expect(sent).toEqual([]);
  await act(async () => { fireEvent.click(save()); });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ method: "POST", path: "/v1/app/projects/web/lessons/les_new00001/both-places", body: { version: 1, cardPaths: ["tests/**"], otherPaths: ["src/**"] }, retry: "never" });
  const result = await screen.findByTestId("both-places-result");
  expect(result.textContent).toContain("The older one applies only to its new place.");
  expect(result.textContent).toContain("needs one more person");
  f.close();
});
it("names the older lesson plainly when it is not in view and shows Code's words when it refuses", async () => {
  const f = mount({ proposed: [CONFLICT], approved: [], send: () => ({ status: 409, body: { error: { code: "IDEMPOTENCY_CONFLICT", message: "This lesson changed since you read it. Read it again and decide again." } } }) });
  fireEvent.mouseDown(await screen.findByRole("tab", { name: "Proposed" }), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("button", { name: /^Both, in different places:/u }));
  const form = await screen.findByRole("form", { name: /^Both, in different places:/u });
  expect(within(form).getByRole("textbox", { name: "Where the older lesson will apply from now on" })).toBeTruthy();
  fireEvent.change(within(form).getByRole("textbox", { name: "Where the older lesson will apply from now on" }), { target: { value: "app/**" } });
  fireEvent.change(within(form).getByRole("textbox", { name: /applies$/u }), { target: { value: "tests/**" } });
  await act(async () => { fireEvent.click(within(form).getByRole("button", { name: "Save both" })); });
  expect((await screen.findByRole("alert")).textContent).toContain("This lesson changed since you read it.");
  f.close();
});

// ---- Retired ----
it("shows what a lesson became in the retired list instead of a plain Retired, and the plain words when it became nothing", async () => {
  const f = mount({ retired: [
    lesson("les_rule00001", { status: "retired", title: "R", became: { kind: "rule", ref: "rule_1", at: NOW - DAY } }), lesson("les_chk000001", { status: "retired", title: "C", became: { kind: "check", ref: "chk_0123456789abcdef", at: NOW } }),
    lesson("les_skill0001", { status: "retired", title: "S", became: { kind: "skill", ref: "s", at: 0 } }), lesson("les_other0001", { status: "retired", title: "O", became: { kind: "playbook" as never, ref: "p", at: NOW } }),
    lesson("les_plain0001", { status: "retired", title: "P", rejectedReason: "outdated" }) ] });
  fireEvent.mouseDown(await screen.findByRole("tab", { name: "Retired" }), { button: 0, ctrlKey: false });
  const items = await screen.findAllByTestId("lesson-became");
  expect(items.map(item => item.firstChild!.textContent)).toEqual(["Became a team rule", "Became a draft task to add a check", "Became a skill", "Made permanent"]);
  const plain = screen.getByRole("article", { name: "P" });
  expect(plain.textContent).toContain("Retired: out of date");
  expect(plain.textContent).not.toContain("Became");
  expect(screen.getByRole("article", { name: "R" }).textContent).not.toContain("Retired");
  f.close();
});

// ---- Team rules in use ----
it("lists the live team rules for a person who decides with their words and where they apply, and retires one after one confirm", async () => {
  const sent: ApiRequest[] = [];
  const f = mount({ graduation: { rules: [RULE, { ...RULE, id: "rule_fedcba9876543210", text: "Tests live next to the module.", paths: [], repos: [] }] }, send: request => { sent.push(request);return ok({ project: "web", ruleId: "rule_0123456789abcdef", status: "retired" }); } });
  const list = await screen.findByTestId("team-rules");
  expect(within(list).getByRole("heading", { name: "Team rules in use" })).toBeTruthy();
  const articles = within(list).getAllByRole("article");
  expect(articles.map(one => within(one).getByTestId("rule-text").textContent)).toEqual(["Every error log carries the request id.", "Tests live next to the module."]);
  expect(articles[0]!.textContent).toContain("Code paths: src/logging/**");
  expect(articles[0]!.textContent).toContain("Repositories: acme/web");
  expect(articles[1]!.textContent).toContain("The whole project");
  fireEvent.click(within(articles[0]!).getByRole("button", { name: /^Retire rule: Every error log/u }));
  expect(sent).toEqual([]);
  expect(articles[0]!.textContent).toContain("Retire this rule?");
  fireEvent.click(within(articles[0]!).getByRole("button", { name: "Cancel" }));
  expect(sent).toEqual([]);
  fireEvent.click(within(articles[0]!).getByRole("button", { name: /^Retire rule: Every error log/u }));
  await act(async () => { fireEvent.click(within(articles[0]!).getByRole("button", { name: "Retire rule" })); });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ method: "POST", path: "/v1/app/projects/web/lessons/rules/rule_0123456789abcdef/retire", body: {}, retry: "never" });
  expect(await within(list).findByText("Retired. Rovara no longer adds it to tasks.")).toBeTruthy();
  f.close();
});
it("draws no team rules for a person who may not decide, nor when there are none, and shows Code's words when a retire is refused", async () => {
  let f = mount({ canDecide: false, graduation: { rules: [RULE] } });
  await screen.findByTestId("learned");
  expect(screen.queryByTestId("team-rules")).toBeNull();
  f.close();
  f = mount({ graduation: { canDecide: false, rules: [RULE] } });
  await waitFor(() => expect(f.request.mock.calls.some(([request]) => request.path.endsWith("/lessons/graduation"))).toBe(true));
  expect(screen.queryByTestId("team-rules")).toBeNull();
  f.close();
  f = mount({ graduation: { rules: [] } });
  await screen.findByTestId("this-week");
  expect(screen.queryByTestId("team-rules")).toBeNull();
  f.close();
  f = mount({ graduation: { rules: [RULE] }, send: () => ({ status: 403, body: { error: { code: "FORBIDDEN", message: "Only a maintainer of this project, or an admin, can decide what becomes permanent." } } }) });
  fireEvent.click(await screen.findByRole("button", { name: /^Retire rule:/u }));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retire rule" })); });
  expect((await screen.findByRole("alert")).textContent).toContain("Only a maintainer");
  f.close();
});

// ---- What review found ----
it("draws a retired lesson whose time no date can hold without a time, and never throws", async () => {
  const f = mount({ retired: [lesson("les_huge00001", { status: "retired", title: "H", became: { kind: "rule", ref: "r", at: 1e18 } })] });
  fireEvent.mouseDown(await screen.findByRole("tab", { name: "Retired" }), { button: 0, ctrlKey: false });
  expect((await screen.findByTestId("lesson-became")).textContent).toBe("Became a team rule");
  f.close();
});
it("does not open the link form after a failed Drop it, and reads the cards again when Code says a draft is gone or changed", async () => {
  const f = mount({ send: () => ({ status: 404, body: { error: { code: "NOT_FOUND", message: "That draft is no longer there." } } }) });
  const draft = await screen.findByRole("article", { name: DRAFT.title });
  const reads = () => f.request.mock.calls.filter(([request]) => request.method === "GET" && request.path.endsWith("/lessons/graduation")).length;
  const before = reads();
  await act(async () => { fireEvent.click(within(draft).getByRole("button", { name: `Drop it: ${DRAFT.title}` })); });
  expect((await within(draft).findByRole("alert")).textContent).toBe("That draft is no longer there.");
  expect(within(draft).queryByRole("textbox", { name: /Link to the task you started/u })).toBeNull();
  await waitFor(() => expect(reads()).toBeGreaterThan(before));
  f.close();
});
it("reads the cards again after Code says a Make permanent is out of date (409), keeping Code's sentence", async () => {
  const f = mount({ send: () => ({ status: 409, body: { error: { code: "IDEMPOTENCY_CONFLICT", message: "The first person asked for something else (another target or other paths)." } } }) });
  const reads = () => f.request.mock.calls.filter(([request]) => request.method === "GET" && request.path.endsWith("/lessons/graduation")).length;
  await act(async () => { fireEvent.click(await screen.findByRole("button", { name: "Make it a rule" })); });
  const before = reads();
  expect((await screen.findByRole("alert")).textContent).toContain("The first person asked for something else");
  await waitFor(() => expect(reads()).toBeGreaterThanOrEqual(before));
  expect(reads()).toBeGreaterThanOrEqual(2);
  f.close();
});
it("lists a tidy lesson once when Code repeats it, so the one retire it sends is not refused for a repeated id", async () => {
  const sent: ApiRequest[] = [];
  const dup = { period: 30, lessons: [TIDY.lessons[0], TIDY.lessons[0], TIDY.lessons[1]] };
  const f = mount({ graduation: { tidy: dup }, send: request => { sent.push(request);return ok({ project: "web", retired: ["les_old00001"], skipped: 0 }); } });
  const card = await screen.findByTestId("tidy-card");
  expect(within(card).getAllByRole("checkbox")).toHaveLength(2);
  fireEvent.click(within(card).getByRole("checkbox", { name: /Old A/u }));
  fireEvent.click(within(card).getByRole("button", { name: "Retire chosen" }));
  await act(async () => { fireEvent.click(within(card).getByRole("button", { name: "Retire 1 lesson" })); });
  expect(sent[0]!.body).toEqual({ ids: ["les_old00001"] });
  f.close();
});
it("copies a draft request without hidden control or format characters, the same as the screen shows it", async () => {
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  const hidden = { ...DRAFT, request: "Add a check\u202E for semicolons\u200B.\nKeep it fast." };
  const f = mount({ graduation: { drafts: [hidden] } });
  await act(async () => { fireEvent.click(await screen.findByRole("button", { name: `Copy the request: ${DRAFT.title}` })); });
  expect(writeText).toHaveBeenCalledWith("Add a check for semicolons.\nKeep it fast.");
  expect(screen.getByTestId("draft-request").textContent).toContain("[U+202E]");
  f.close();
});
it("announces Code's sentence when a stale write makes the draft leave the screen", async () => {
  const f = mount({ send: () => ({ status: 404, body: { error: { code: "NOT_FOUND", message: "That draft is no longer there." } } }) });
  await act(async () => { fireEvent.click(await screen.findByRole("button", { name: `Drop it: ${DRAFT.title}` })); });
  // The live region (not the card, which may be gone by then) says it.
  await waitFor(() => expect(document.querySelector('.rv-visually-hidden[aria-live="polite"]')?.textContent).toContain("That draft is no longer there."), { timeout: 4000 });
  f.close();
});
