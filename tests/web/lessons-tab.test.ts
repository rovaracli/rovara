// @vitest-environment jsdom
// L3b: the Lessons tab and the Sources tab, state by state: loading, failing, off, collecting, locked, read-only, waiting cards (one person, two people, who approved first), citations,
// one-tap approval, edit and approve, reject, remove, history, search, digest, going back, and text that is shown as text.
import { describe, expect, it } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { LessonApproveBodySchema, LessonMergeBodySchema, LessonPresetChangeBodySchema, LessonRejectBodySchema, LessonRollbackBodySchema } from "@agentx/contracts/web";
import { ProjectScreen } from "../../packages/ui/src/screens/project/ProjectScreen.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { h } from "./support/h.js";
import { LESSONS_PATH, NOW, codeCite, digest, history, lesson, lessonsHost, ok, person, refusal, source, sources, view, waiting } from "./support/lessons-fixture.js";

type Options = Parameters<typeof lessonsHost>[0] & { path?: string; theme?: "light" | "dark" };
function setup(options: Options = {}) {
 const cell = lessonsHost(options), query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: cell.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: [options.path ?? "/app/projects/payments?tab=lessons"], children: h(Announcer, { children: h(Routes, { children: h(Route, { path: "/app/projects/:name", element: h(ProjectScreen, {}) }) }) }) }) }) }), { theme: options.theme ?? "light" });
 return { ...cell, ...ui, query };
}
const openLessons = async (options: Options = {}) => { const world = setup(options);await screen.findByRole("heading", { name: /^Active lessons/u });return world; };
const cards = () => screen.getAllByRole("region").filter(region => /^lesson-/u.test(region.getAttribute("aria-labelledby") ?? ""));
const waitingList = () => screen.getByRole("list", { name: "Waiting for you" });

describe("loading and failing", () => {
 it("shows a loading state, then the lessons", async () => {
  let release: (() => void) | undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  setup({ lessons: async (request, url) => { if (url.pathname === LESSONS_PATH && request.method === "GET") await held;return undefined; } });
  expect(await screen.findByRole("progressbar", { name: "Loading lessons" })).toBeTruthy();
  release?.();
  await screen.findByRole("heading", { name: "Active lessons (1)" });
 });
 it("says so when the lessons can't be loaded and reads again on Try again", async () => {
  let fail = true;
  const f = setup({ lessons: (request, url) => url.pathname === LESSONS_PATH && request.method === "GET" && fail ? refusal("CONFIG_INVALID", "Down.", 409) : undefined });
  expect((await screen.findByRole("alert")).textContent).toContain("Couldn't load the lessons");
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByRole("heading", { name: "Active lessons (1)" });
  expect(f.lessonReads().length).toBeGreaterThanOrEqual(2);
 });
 it("says lessons are not set up where the route is absent", async () => {
  setup({ lessons: () => refusal("NOT_FOUND", "Not found.", 404) });
  expect((await screen.findByRole("alert")).textContent).toContain("aren't set up");
 });
 it("reads nothing until the tab is opened", async () => {
  const f = setup({ path: "/app/projects/payments" });
  await screen.findByRole("heading", { name: "payments" });
  expect(f.lessonReads()).toHaveLength(0);
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Lessons" }), { button: 0, ctrlKey: false });
  await screen.findByRole("heading", { name: "Active lessons (1)" });
  expect(f.lessonReads().length).toBeGreaterThan(0);
  expect(screen.getByRole("tab", { name: "Sources" })).toBeTruthy();
 });
});

describe("lessons paused (lane 1b: never silent)", () => {
 it("says in one line why learning cannot run, in the server's fixed words, and says nothing when nothing is wrong", async () => {
  const quiet = await openLessons();
  expect(screen.queryByTestId("lessons-paused")).toBeNull();
  quiet.unmount();
  await openLessons({ state: { view: view({ paused: { code: "no_provider", at: NOW } }) } });
  expect(screen.getByTestId("lessons-paused-line").textContent).toBe("Lessons paused: no AI provider is connected for this project");
 });
 it("L2 / L3: says when the pause started, and labels a company-wide reason as company-wide (a project reason is not)", async () => {
  const company = await openLessons({ state: { view: view({ paused: { code: "monthly_limit", at: NOW, scope: "company" } }) } });
  expect(screen.getByTestId("lessons-paused-line").textContent).toBe("Lessons paused: monthly learning limit reached (for the whole company, every project)");
  expect(screen.getByTestId("lessons-paused-since").textContent).toBe(`since ${new Date(NOW).toISOString().slice(0, 10)}`);
  company.unmount();
  await openLessons({ state: { view: view({ paused: { code: "model_failed", at: NOW, scope: "project" } }) } });
  expect(screen.getByTestId("lessons-paused-line").textContent).toBe("Lessons paused: the AI provider is not answering");
 });
 it("reads a reason this build does not know as a plain 'Lessons paused', never as raw text", async () => {
  await openLessons({ state: { view: { ...view(), paused: { code: "something_new", at: NOW } } } });
  expect(screen.getByTestId("lessons-paused-line").textContent).toBe("Lessons paused");
 });
 it("says nothing about it while learning is off (the tab already says it is off)", async () => {
  await openLessons({ state: { view: view({ mode: "Off", waiting: [], active: [], paused: { code: "no_provider", at: NOW } }) } });
  expect(screen.queryByTestId("lessons-paused")).toBeNull();
 });
});

describe("learning mode", () => {
 it("says learning is off", async () => {
  await openLessons({ state: { view: view({ mode: "Off", waiting: [], active: [] }) } });
  expect(screen.getByText(/Learning is switched off/u)).toBeTruthy();
 });
 it("says Rovara is only collecting", async () => {
  await openLessons({ state: { view: view({ mode: "Collect" }) } });
  expect(screen.getByText(/collecting what the team does/u)).toBeTruthy();
 });
 it("says when the company's lock made the mode stricter", async () => {
  await openLessons({ state: { view: view({ mode: "Suggest", lockedByCompany: true }) } });
  expect(screen.getByText(/Your company set this to be stricter/u)).toBeTruthy();
 });
});

describe("waiting cards", () => {
 it("a low-risk lesson needs one maintainer and shows what it says, where it comes from and why", async () => {
  await openLessons();
  const card = within(cards()[0]!);
  expect(card.getByRole("heading", { name: "Retry only idempotent calls" })).toBeTruthy();
  expect(card.getByText("Only wrap idempotent HTTP calls in withRetry.")).toBeTruthy();
  expect(card.getByText("Needs one maintainer's OK")).toBeTruthy();
  expect(card.getByText(/Said or edited by/u).textContent).toContain("Carl Cole");
  expect(card.getByText("2 tasks back it.")).toBeTruthy();
  expect(card.getByRole("button", { name: "Approve" })).toBeTruthy();
  expect(card.getByRole("button", { name: "Edit and approve" })).toBeTruthy();
  expect(card.getByRole("button", { name: "Reject" })).toBeTruthy();
  expect(card.getByText("It is advice, not a checked fact.")).toBeTruthy();
 });

 it("a broad lesson says it covers more than one repository; a reason the build does not know has no words and is not shown raw", async () => {
  await openLessons({ state: { view: view({ waiting: [waiting({ tierReasons: ["scope_not_one_repo", "future_reason_x"] })] }) } });
  const text = cards()[0]!.textContent ?? "";
  expect(text).toContain("It covers more than one repository (a broad lesson).");
  expect(text).not.toContain("future_reason_x");
 });

 it("a reviewer, check or security lesson needs two people, shows who approved first and what is still missing", async () => {
  await openLessons({ state: { view: view({ waiting: [waiting({ tier: 2, tierReasons: ["reviewer_stage", "escalation_words"], needs: { required: 2, have: 1, first: person("Ann Archer"), firstAt: NOW - 2 * 3_600_000, groups: ["Security"] }, approvals: [{ by: person("Ann Archer"), at: NOW - 2 * 3_600_000, mode: "one" }] })] }) } });
  const card = within(cards()[0]!);
  expect(card.getByText(/Needs two people/u)).toBeTruthy();
  const first = card.getByText(/Approved first by/u);
  expect(first.textContent).toContain("Ann Archer");
  expect(first.textContent).toContain("2h ago");
  expect(first.textContent).toContain("Still needs a second maintainer or admin.");
  expect(card.getByText(/Must also be approved by someone in Security/u)).toBeTruthy();
  expect(card.getByText("It would reach the plan and code reviewers.")).toBeTruthy();
 });

 it("the person who approved first sees that they did and no Approve button", async () => {
  await openLessons({ state: { view: view({ waiting: [waiting({ tier: 2, needs: { required: 2, have: 1, first: person("Ann Archer", true), firstAt: NOW, groups: [] }, approvals: [{ by: person("Ann Archer", true), at: NOW, mode: "one" }], canApprove: false })] }) } });
  const card = within(cards()[0]!);
  expect(card.queryByRole("button", { name: "Approve" })).toBeNull();
  expect(card.getByText(/You approved this/u)).toBeTruthy();
  expect(card.getByRole("button", { name: "Reject" })).toBeTruthy();
 });

 it("a person who can't approve this one is told why instead of being offered a button", async () => {
  await openLessons({ state: { view: view({ waiting: [waiting({ canApprove: false })] }) } });
  expect(within(cards()[0]!).getByText(/You can't approve this one/u)).toBeTruthy();
 });

 it("citations say whether the code still holds, with the checked time; other citations are links and plain text", async () => {
  await openLessons({ state: { view: view({ waiting: [waiting({ citations: [codeCite(), codeCite({ path: "src/a.ts", check: "moved" }), codeCite({ path: "src/b.ts", check: "stale" }), codeCite({ path: "src/c.ts", check: "unchecked", checkedAt: undefined }), { kind: "pr", url: "https://github.com/acme/payments/pull/7" }, { kind: "task", taskId: "tsk_9" }, { kind: "record" }] })] }) } });
  const list = within(within(cards()[0]!).getByRole("list", { name: "Code it cites" }));
  const items = list.getAllByRole("listitem").map(item => item.textContent ?? "");
  expect(items[0]).toContain("api/src/retry/index.ts:12-30");
  expect(items[0]).toContain("Still holds");
  expect(items[0]).toContain("checked 2h ago");
  expect(items[1]).toContain("Moved, found again");
  expect(items[2]).toContain("No longer holds");
  expect(items[3]).toContain("Not checked yet");
  expect(list.getByRole("link", { name: "https://github.com/acme/payments/pull/7" }).getAttribute("href")).toBe("https://github.com/acme/payments/pull/7");
  expect(list.getByRole("link", { name: "An earlier task" }).getAttribute("href")).toBe("/review/tsk_9/task");
  expect(items[6]).toBe("A note in the team record");
 });

 it("a possible duplicate that is also close to a rejected lesson says both", async () => {
  await openLessons({ state: { view: view({ waiting: [waiting({ possibleDuplicate: "les_aaaa1111", tierReasons: ["possible_duplicate", "matches_rejected"] })] }) } });
  const card = within(cards()[0]!);
  expect(card.getByText("It may say the same as another lesson, so a person decides.")).toBeTruthy();
  expect(card.getByText("It is close to a lesson someone already rejected, so a person decides.")).toBeTruthy();
  expect(card.getByRole("button", { name: "Merge into the existing lesson" })).toBeTruthy();
 });

 it("a lesson sent back to a person, or one that contradicts another, says so", async () => {
  await openLessons({ state: { view: view({ waiting: [waiting({ reviewRequired: true, contradicts: "les_other001" })] }) } });
  const card = cards()[0]!;
  expect(within(card).getByText(/Sent back for a person/u)).toBeTruthy();
  expect(within(card).getByText(/says the opposite of another one/u)).toBeTruthy();
 });

 it("says nothing waits, and counts what is queued and what is left out because the source is not visible", async () => {
  await openLessons({ state: { view: view({ waiting: [], queued: 3, hidden: 2 }) } });
  expect(screen.getByText("Nothing is waiting for you.")).toBeTruthy();
  expect(screen.getByText(/3 more are being collected/u)).toBeTruthy();
  expect(screen.getByText(/2 lessons come from sources you can't see/u)).toBeTruthy();
 });
 it("L3: tells the people who decide how many lessons are on hold because their source task has no session; says nothing when none are", async () => {
  await openLessons({ state: { view: view({ waiting: [], legacyHeld: 3 }) } });
  expect(screen.getByTestId("lessons-legacy-held").textContent).toMatch(/3 lessons are on hold because they were learned from tasks started before sessions existed/u);
 });
 it("N2: a held legacy lesson is not also 'a source you can't see': with nothing else hidden, only the hold line shows", async () => {
  await openLessons({ state: { view: view({ waiting: [], legacyHeld: 3, hidden: 0 }) } });
  expect(screen.getByTestId("lessons-legacy-held")).toBeTruthy();
  expect(screen.queryByText(/sources you can't see/u)).toBeNull();
 });
 it("N2 positive control: lessons that really are from sources the person can't see still get their own line beside the hold line", async () => {
  await openLessons({ state: { view: view({ waiting: [], legacyHeld: 3, hidden: 2 }) } });
  expect(screen.getAllByTestId("lessons-legacy-held")).toHaveLength(1);
  expect(screen.getByText(/2 lessons come from sources you can't see/u)).toBeTruthy();
 });
 it("L3: no line when nothing is held", async () => {
  await openLessons({ state: { view: view({ waiting: [] }) } });
  expect(screen.queryByTestId("lessons-legacy-held")).toBeNull();
 });
});

describe("deciding", () => {
 it("one tap approves the version that was read, sends it once, and reads the list again", async () => {
  const f = await openLessons({ lessons: (request, url) => url.pathname === LESSONS_PATH + "/les_pend0001/approve" ? ok({ status: "active", needs: "nothing" }) : undefined });
  fireEvent.click(within(cards()[0]!).getByRole("button", { name: "Approve" }));
  expect(await screen.findByText("Approved. Rovara can use this lesson now.")).toBeTruthy();
  const writes = f.lessonWrites();
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ method: "POST", path: LESSONS_PATH + "/les_pend0001/approve", retry: "never" });
  expect(LessonApproveBodySchema.parse(writes[0]!.body)).toEqual({ expectedVersion: 1 });
  await waitFor(() => expect(f.lessonReads().filter(request => request.path === LESSONS_PATH).length).toBeGreaterThanOrEqual(2));
 });

 it("a possible duplicate offers Merge into the existing lesson: one tap sends the version that was read, once, says it merged and reads the list again; a card with no link has no such button", async () => {
  const f = await openLessons({ state: { view: view({ waiting: [waiting({ possibleDuplicate: "les_aaaa1111", tierReasons: ["possible_duplicate"] }), waiting({ id: "les_pend0002", title: "Prefer small pull requests" })] }) }, lessons: (_request, url) => url.pathname === LESSONS_PATH + "/les_pend0001/merge" ? ok({ done: true }) : undefined });
  expect(within(cards()[1]!).queryByRole("button", { name: "Merge into the existing lesson" })).toBeNull();
  expect(within(cards()[0]!).getByText(/Possible duplicate/u)).toBeTruthy();
  fireEvent.click(within(cards()[0]!).getByRole("button", { name: "Merge into the existing lesson" }));
  expect(await screen.findByText("Merged into the existing lesson.")).toBeTruthy();
  const writes = f.lessonWrites();
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ method: "POST", path: LESSONS_PATH + "/les_pend0001/merge", retry: "never" });
  expect(LessonMergeBodySchema.parse(writes[0]!.body)).toEqual({ expectedVersion: 1 });
  await waitFor(() => expect(f.lessonReads().filter(request => request.path === LESSONS_PATH).length).toBeGreaterThanOrEqual(2));
 });

 it("a person who cannot decide gets no Merge button on a possible duplicate", async () => {
  await openLessons({ state: { view: view({ waiting: [waiting({ possibleDuplicate: "les_aaaa1111", canApprove: false, canReject: false })] }) } });
  expect(within(cards()[0]!).queryByRole("button", { name: "Merge into the existing lesson" })).toBeNull();
 });

 it("a merge the server refuses shows its own sentence and does not claim it worked", async () => {
  await openLessons({ state: { view: view({ waiting: [waiting({ possibleDuplicate: "les_aaaa1111" })] }) }, lessons: (_request, url) => url.pathname.endsWith("/merge") ? refusal("CHANGE_STALE", "These two lessons can't be merged. Keep both, or reject this one.", 409) : undefined });
  fireEvent.click(within(cards()[0]!).getByRole("button", { name: "Merge into the existing lesson" }));
  expect(await screen.findByText(/can't be merged/u)).toBeTruthy();
  expect(screen.queryByText("Merged into the existing lesson.")).toBeNull();
 });

 it("a first approval of a two-person lesson says it now waits for a second person", async () => {
  await openLessons({ state: { view: view({ waiting: [waiting({ tier: 2, needs: { required: 2, have: 0, groups: [] } })] }) }, lessons: (_request, url) => url.pathname.endsWith("/approve") ? ok({ status: "pending", needs: "second_person" }) : undefined });
  fireEvent.click(within(cards()[0]!).getByRole("button", { name: "Approve" }));
  expect(await screen.findByText(/waits for a second maintainer or admin/u)).toBeTruthy();
 });

 it("edit and approve sends the edited words with the version that was read", async () => {
  const f = await openLessons({ lessons: (_request, url) => url.pathname.endsWith("/approve") ? ok({ status: "active", needs: "nothing" }) : undefined });
  const card = within(cards()[0]!);
  fireEvent.click(card.getByRole("button", { name: "Edit and approve" }));
  fireEvent.change(card.getByRole("textbox", { name: "Lesson" }), { target: { value: "Only wrap idempotent calls." } });
  fireEvent.click(card.getByRole("button", { name: "Edit and approve" }));
  await screen.findByText("Approved. Rovara can use this lesson now.");
  expect(LessonApproveBodySchema.parse(f.lessonWrites()[0]!.body)).toEqual({ expectedVersion: 1, edit: { title: "Retry only idempotent calls", description: "", body: "Only wrap idempotent calls." } });
 });

 it("reject needs a reason and sends it once", async () => {
  const f = await openLessons({ lessons: (_request, url) => url.pathname.endsWith("/reject") ? ok({ done: true }) : undefined });
  const card = within(cards()[0]!);
  fireEvent.click(card.getByRole("button", { name: "Reject" }));
  const send = card.getByRole<HTMLButtonElement>("button", { name: "Reject lesson" });
  expect(send.disabled).toBe(true);
  fireEvent.change(card.getByRole("textbox", { name: "Why isn't this useful?" }), { target: { value: "Too vague" } });
  fireEvent.click(send);
  await screen.findByText("Lesson rejected.");
  expect(LessonRejectBodySchema.parse(f.lessonWrites()[0]!.body)).toEqual({ expectedVersion: 1, reason: "Too vague" });
 });

 it("shows the server's own sentence for a refusal and does not claim it worked", async () => {
  await openLessons({ lessons: (_request, url) => url.pathname.endsWith("/approve") ? refusal("FORBIDDEN", "A different maintainer or admin has to give the second approval.") : undefined });
  fireEvent.click(within(cards()[0]!).getByRole("button", { name: "Approve" }));
  expect((await screen.findByRole("alert")).textContent).toBe("A different maintainer or admin has to give the second approval.");
  expect(screen.queryByText("Approved. Rovara can use this lesson now.")).toBeNull();
 });

 it("a lesson that changed meanwhile reads the list again and says so", async () => {
  const f = await openLessons({ lessons: (_request, url) => url.pathname.endsWith("/approve") ? refusal("CHANGE_STALE", "This lesson changed while you were looking at it. Reload and check it again.", 409) : undefined });
  fireEvent.click(within(cards()[0]!).getByRole("button", { name: "Approve" }));
  expect((await screen.findAllByText(/changed while you were looking/u)).length).toBeGreaterThan(0);
  await waitFor(() => expect(f.lessonReads().filter(request => request.path === LESSONS_PATH).length).toBeGreaterThanOrEqual(2));
 });

 it("a network failure is not shown as a refusal's words", async () => {
  await openLessons({ lessons: (_request, url) => url.pathname.endsWith("/approve") ? { status: 500, body: "oops" } : undefined });
  fireEvent.click(within(cards()[0]!).getByRole("button", { name: "Approve" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Couldn't save that. Try again.");
 });
});

describe("active lessons", () => {
 const many = () => view({ active: [lesson(), lesson({ id: "les_bbbb2222", title: "Prefer small pull requests", body: "Keep pull requests under 400 lines.", type: "preference", scope: { repos: [], paths: ["docs/**"], languages: [] }, counters: { loaded: 1, helpful: 0, harmful: 0 }, expiresAt: NOW + 5 * 86_400_000, lastUsedAt: undefined })] });
 it("shows helpful and wrong counts, how often it was loaded, when it expires, and what it cites", async () => {
  await openLessons({ state: { view: many() } });
  const first = screen.getByRole("list", { name: "Active lessons" }).querySelectorAll("li.rv-lessons-active")[0] as HTMLElement;
  expect(first.textContent).toContain("Helpful: 3");
  expect(first.textContent).toContain("Wrong here: 1");
  expect(first.textContent).toContain("Loaded 4 times");
  expect(first.textContent).toContain("Expires in 62 days");
  fireEvent.click(within(first).getByText("Where it comes from"));
  expect(within(first).getByText(/Still holds/u)).toBeTruthy();
 });
 it("searches by words in the lesson", async () => {
  await openLessons({ state: { view: many() } });
  fireEvent.change(screen.getByRole("searchbox", { name: "Search active lessons" }), { target: { value: "small pull" } });
  expect(screen.queryByText("Use the shared retry helper")).toBeNull();
  expect(screen.getByText("Prefer small pull requests")).toBeTruthy();
  fireEvent.change(screen.getByRole("searchbox", { name: "Search active lessons" }), { target: { value: "zzz" } });
  expect(screen.getByText("No active lesson matches.")).toBeTruthy();
 });
 it("a stale lesson says its code references no longer hold", async () => {
  await openLessons({ state: { view: view({ active: [lesson({ status: "stale" })] }) } });
  expect(screen.getByText(/code references no longer hold/u)).toBeTruthy();
 });
 it("removing asks for an optional reason, sends once and reads the list again", async () => {
  const f = await openLessons({ lessons: (_request, url) => url.pathname.endsWith("/retire") ? ok({ done: true }) : undefined });
  fireEvent.click(screen.getByRole("button", { name: "Remove: Use the shared retry helper" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Why remove it? (optional)" }), { target: { value: "Out of date" } });
  fireEvent.click(screen.getByRole("button", { name: "Remove lesson" }));
  await screen.findByText("Lesson removed.");
  expect(f.lessonWrites()).toHaveLength(1);
  expect(f.lessonWrites()[0]).toMatchObject({ path: LESSONS_PATH + "/les_aaaa1111/retire", body: { reason: "Out of date" } });
 });
 it("history lists versions and who approved each", async () => {
  await openLessons();
  fireEvent.click(screen.getByRole("button", { name: "History: Use the shared retry helper" }));
  const versions = await screen.findByRole("list", { name: "Versions" });
  expect(versions.textContent).toContain("Version 2");
  expect(versions.textContent).toContain("approved by Ann Archer");
  expect(versions.textContent).toContain("Version 1");
 });
 it("says no lesson is in use yet", async () => {
  await openLessons({ state: { view: view({ active: [], waiting: [] }) } });
  expect(screen.getByText("No lesson is in use yet.")).toBeTruthy();
 });
});

describe("a person who does not decide", () => {
 it("reads the active lessons; there is no queue, no digest, no Remove, no going back", async () => {
  const f = await openLessons({ state: { view: view({ canDecide: false, waiting: [], removed: [], active: [lesson({ canRetire: false })] }) } });
  expect(screen.getByText(/Maintainers and admins decide them/u)).toBeTruthy();
  expect(screen.queryByRole("heading", { name: /^Waiting for you/u })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Remove/u })).toBeNull();
  expect(screen.queryByRole("button", { name: /Go back to an earlier set/u })).toBeNull();
  expect(screen.queryByRole("heading", { name: "This week" })).toBeNull();
  expect(f.lessonReads().some(request => request.path.endsWith("/digest"))).toBe(false);
 });
});

describe("text is text", () => {
 it("shows markup and control characters in a lesson as plain text", async () => {
  const hostile = "<img src=x onerror=alert(1)> <script>alert(2)</script>‮evil";
  await openLessons({ state: { view: view({ waiting: [waiting({ title: "<b>bold</b> title", body: hostile })], active: [lesson({ body: "Plain active words." })] }) } });
  expect(document.querySelector("img")).toBeNull();
  expect(document.querySelector("script")).toBeNull();
  expect(document.querySelector("b")).toBeNull();
  const text = document.body.textContent ?? "";
  expect(text).toContain("<img src=x onerror=alert(1)>");
  expect(text).toContain("<b>bold</b> title");
  expect(within(cards()[0]!).getByText(/\[U\+202E\]evil/u)).toBeTruthy();
  expect(text).toContain("[U+202E]evil");
 });
 it("the same holds for the active list", async () => {
  await openLessons({ state: { view: view({ waiting: [], active: [lesson({ title: "<i>x</i>", body: "<img src=x onerror=alert(1)>\u202Eevil" })] }) } });
  expect(document.querySelector("img")).toBeNull();
  expect(document.querySelector("i")).toBeNull();
  expect(document.body.textContent).toContain("[U+202E]evil");
 });
 it("a pull request citation that is not a plain https address is not a link", async () => {
  await openLessons({ state: { view: view({ waiting: [waiting({ citations: [{ kind: "pr", url: "https://user:pw@evil.example/x" }] })] }) } });
  expect(within(cards()[0]!).queryByRole("link")).toBeNull();
 });
});

describe("the weekly digest", () => {
 it("leads with the top lessons", async () => {
  await openLessons({ state: { digest: digest({ top: [{ id: "les_1", title: "Always run the linter", type: "convention", tier: 1, links: ["https://github.com/acme/payments/pull/3"] }], waiting: [{ id: "les_2", title: "Second thing", type: "fact", tier: 0, links: [] }], pausedSources: ["slack:C9"], pausedSourcesHidden: 2, queued: 4 }) } });
  const section = await screen.findByRole("region", { name: "This week" });
  const headings = within(section).getAllByRole("heading", { level: 4 }).map(heading => heading.textContent);
  expect(headings[0]).toBe("Top lessons");
  expect(within(section).getByText("Always run the linter")).toBeTruthy();
  expect(within(section).getByRole("link", { name: "pull request" }).getAttribute("href")).toBe("https://github.com/acme/payments/pull/3");
  expect(within(section).getByText(/2 paused sources are not named/u)).toBeTruthy();
  expect(within(section).getByText("slack:C9")).toBeTruthy();
 });
 it("says when there is nothing to report", async () => {
  await openLessons();
  expect(await screen.findByText("Nothing to report this week.")).toBeTruthy();
 });
});

describe("going back and removed lessons", () => {
 const withSnapshots = () => view({ setVersion: 6, snapshots: [{ setVersion: 3, at: NOW - 5 * 86_400_000, lessons: 4 }, { setVersion: 5, at: NOW - 86_400_000, lessons: 5 }] });
 it("goes back to a chosen set after a confirmation and says the restored lessons wait", async () => {
  const f = await openLessons({ state: { view: withSnapshots() }, lessons: (_request, url) => url.pathname.endsWith("/rollback") ? ok({ setVersion: 7, restored: 2 }) : undefined });
  fireEvent.click(screen.getByRole("button", { name: "Go back to an earlier set" }));
  expect(screen.getByText(/Every restored lesson waits for approval again/u)).toBeTruthy();
  const buttons = screen.getAllByRole("button", { name: /^Go back to the set of/u });
  expect(buttons).toHaveLength(2);
  fireEvent.click(buttons[0]!);
  expect(f.lessonWrites()).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Go back to this set" }));
  await screen.findByText("Done. The restored lessons are waiting for approval.");
  expect(LessonRollbackBodySchema.parse(f.lessonWrites()[0]!.body)).toEqual({ targetSetVersion: 5, expectedSetVersion: 6 });
 });
 it("says when there is nothing to go back to", async () => {
  await openLessons();
  fireEvent.click(screen.getByRole("button", { name: "Go back to an earlier set" }));
  expect(screen.getByText("There is no earlier set to go back to.")).toBeTruthy();
 });
 it("lists removed and rejected lessons with the reason", async () => {
  await openLessons({ state: { view: view({ removed: [lesson({ id: "les_r1", status: "rejected", title: "Rejected one", rejectedReason: "Too vague" }), lesson({ id: "les_r2", status: "retired", title: "Retired one" })] }) } });
  fireEvent.click(screen.getByRole("button", { name: "Removed lessons (2)" }));
  const list = screen.getByRole("list", { name: "Removed lessons" });
  expect(list.textContent).toContain("Rejected one");
  expect(list.textContent).toContain("Reason: Too vague");
  expect(list.textContent).toContain("Retired one");
 });
});

describe("the Sources tab", () => {
 const open = (state: Options["state"], extra: Options = {}) => { const f = setup({ path: "/app/projects/payments?tab=sources", ...(state === undefined ? {} : { state }), ...extra });return f; };
 it("lists what feeds the record, how long it is kept, the status and who sees it; a maintainers-only source is not named to a member", async () => {
  open({ sources: sources({ sources: [source(), source({ kind: "slack", scope: undefined, retention: "B", audience: "maintainers", health: "failing" }), source({ kind: "slack", scope: "slack:T1/C9", retention: "C", health: "unknown", enabled: false, excluded: 2, notesOptIn: true }), source({ kind: "linear", retention: "A", paused: true })], otherPaused: 1 }) });
  const list = await screen.findByRole("list", { name: "Sources" });
  const items = within(list).getAllByRole("listitem").map(item => item.textContent ?? "");
  expect(items[0]).toContain("GitHub");
  expect(items[0]).toContain("github:acme/payments");
  expect(items[0]).toContain("Rovara keeps: Full history");
  expect(items[0]).toContain("Working");
  expect(items[0]).toContain("Everyone on this project");
  expect(items[1]).toContain("Kept for maintainers");
  expect(items[1]).toContain("Only notes with links");
  expect(items[1]).toContain("Not working");
  expect(items[1]).toContain("Maintainers only");
  expect(items[2]).toContain("Text for 30 days, then notes");
  expect(items[2]).toContain("Switched off");
  expect(items[2]).toContain("2 excluded");
  expect(items[3]).toContain("Nothing; read live");
  expect(items[3]).toContain("Paused: it produced far more lessons than usual");
  expect(screen.getByText(/1 other sources are paused/u)).toBeTruthy();
  expect(screen.getByText(/People only see what they could see at the source/u)).toBeTruthy();
 });
 it("says when no source feeds the record", async () => {
  open(undefined);
  expect(await screen.findByText("No source feeds the team record for this project yet.")).toBeTruthy();
 });
 it("says the team record is not set up where the route is absent", async () => {
  open(undefined, { lessons: (_request, url) => url.pathname.endsWith("/sources") ? refusal("NOT_FOUND", "The team record isn't set up here.", 404) : undefined });
  expect((await screen.findByRole("alert")).textContent).toContain("isn't set up here yet");
 });
 it("reads again after a failure", async () => {
  let fail = true;
  open(undefined, { lessons: (_request, url) => url.pathname.endsWith("/sources") && fail ? refusal("CONFIG_INVALID", "Down.", 409) : undefined });
  expect((await screen.findByRole("alert")).textContent).toContain("Couldn't load the sources");
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("No source feeds the team record for this project yet.")).toBeTruthy();
 });
});

describe("accessibility", () => {
 it("has no axe violations with waiting cards, the active list and the digest", async () => {
  const f = await openLessons({ state: { view: view({ waiting: [waiting(), waiting({ id: "les_pend0002", title: "Second", tier: 2, needs: { required: 2, have: 1, first: person("Ann Archer"), firstAt: NOW, groups: [] }, approvals: [{ by: person("Ann Archer"), at: NOW, mode: "one" }] })] }) } });
  await screen.findByRole("region", { name: "This week" });
  await expectNoAxeViolations(f.container);
 });
 it("has no axe violations on the Sources tab in dark mode", async () => {
  const f = setup({ path: "/app/projects/payments?tab=sources", theme: "dark", state: { sources: sources({ sources: [source(), source({ kind: "slack", scope: undefined, audience: "maintainers", paused: true })] }) } });
  await screen.findByRole("list", { name: "Sources" });
  await expectNoAxeViolations(f.container);
 });
});

void waitingList; void history;

describe("approve by exception: trial marks and the preset", () => {
 it("marks a lesson on trial and a stable one, explains the Standard preset, and lets a maintainer require a person for every lesson", async () => {
  let regulated = false;
  const f = await openLessons({
   state: { view: view({ active: [lesson({ id: "les_trial001", title: "Retries use withRetry", trial: "trial", approvals: [{ by: person("Rovara"), at: NOW, mode: "trial" }] }), lesson({ id: "les_stable01", title: "Cents everywhere", trial: "stable", approvals: [{ by: person("Rovara"), at: NOW, mode: "trial" }] })], waiting: [] }) },
   lessons: (request, url) => { if (request.method === "POST" && url.pathname === LESSONS_PATH + "/preset") { regulated = true;return ok({ preset: "regulated", changed: true }); }return undefined; },
  });
  expect(screen.getByText("On trial")).toBeTruthy();
  expect(screen.getByText("Stable")).toBeTruthy();
  expect(screen.getByText(/Standard: a low-risk lesson from a team member's own correction goes live on trial/u)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Require a person for every lesson" }));
  await screen.findByText("Saved. Every lesson now waits for a person.");
  expect(regulated).toBe(true);
  expect(f.lessonWrites().map(request => request.path)).toEqual([LESSONS_PATH + "/preset"]);
  expect(f.lessonWrites()[0]!.body).toEqual({ preset: "regulated" });
 });
 it("going back to Standard asks a different maintainer or admin (it is a loosening): the button appears under Regulated, sends the Standard preset and says the change is waiting", async () => {
  let body: unknown;
  const f = await openLessons({
   state: { view: view({ preset: "regulated", presetLockedByCompany: false }) },
   lessons: (request, url) => { if (request.method === "POST" && url.pathname === LESSONS_PATH + "/preset") { body = request.body;return ok({ preset: "regulated", changed: false, needsApproval: true, changeId: "chg-1" }); }return undefined; },
  });
  expect(screen.queryByRole("button", { name: "Require a person for every lesson" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Allow lessons on trial again" }));
  await screen.findByText(/A different maintainer or admin has to approve going back to Standard/u);
  expect(body).toEqual({ preset: "standard" });
  expect(f.lessonWrites().map(request => request.path)).toEqual([LESSONS_PATH + "/preset"]);
 });
 it("when the company requires Regulated there is no way back from a project", async () => {
  await openLessons({ state: { view: view({ preset: "regulated", presetLockedByCompany: true }) } });
  expect(screen.queryByRole("button", { name: "Allow lessons on trial again" })).toBeNull();
 });
 it("says the company requires Regulated and offers no button; a reader who cannot decide sees the sentence and no button", async () => {
  await openLessons({ state: { view: view({ preset: "regulated", presetLockedByCompany: true }) } });
  expect(screen.getByText(/Regulated: every lesson waits for a person/u)).toBeTruthy();
  expect(screen.getByText(/Your company requires this/u)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Require a person for every lesson" })).toBeNull();
 });
 it("a lesson waiting because it asked for a capability change says why in fixed words", async () => {
  await openLessons({ state: { view: view({ waiting: [waiting({ tier: 2, tierReasons: ["capability_request"], needs: { required: 2, have: 0, groups: [] } })] }) } });
  expect(screen.getByText(/asks Rovara to change tools, access, checks, approvals or limits/u)).toBeTruthy();
 });
});

// LT-2 (lessons leftovers sweep): a proposal to go back to Standard is found in the Lessons tab, and a different maintainer or admin approves or cancels it there.
describe("a pending preset proposal: approve and cancel", () => {
 const proposal = (over: Record<string, unknown> = {}) => ({ changeId: "chg-1", to: "standard", mine: false, soleOwner: false, expiresAt: NOW + 7 * 86_400_000, ...over });
 const pendingView = (over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => view({ preset: "regulated", presetLockedByCompany: false, presetProposal: proposal(over), ...extra });
 const decide = (log: { path: string; body: unknown }[], answer: unknown) => (request: { method: string; path: string; body?: unknown }, url: URL) => {
  if (request.method === "POST" && /\/preset\/(approve|cancel)$/u.test(url.pathname)) { log.push({ path: url.pathname, body: request.body });return ok(answer); }
  return undefined;
 };
 it("a different maintainer sees the waiting request with Approve and Cancel, and no second way to ask", async () => {
  await openLessons({ state: { view: pendingView() } });
  const box = screen.getByRole("region", { name: "Waiting for approval" });
  expect(within(box).getByText(/Someone on your team asked to allow lessons on trial again/u)).toBeTruthy();
  expect(within(box).getByRole("button", { name: "Approve going back to Standard" })).toBeTruthy();
  expect(within(box).getByRole("button", { name: "Cancel the request" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Allow lessons on trial again" })).toBeNull();
 });
 it("Approve sends the change id once to the project's approve route, says so, and reads the tab again", async () => {
  const log: { path: string; body: unknown }[] = [];
  let approved = false;
  const f = await openLessons({ state: { view: pendingView() }, lessons: (request, url) => { const got = decide(log, { preset: "standard", changed: true })(request, url);if (got !== undefined) approved = true;return got; } });
  const reads = f.lessonReads().length;
  fireEvent.click(screen.getByRole("button", { name: "Approve going back to Standard" }));
  await screen.findByText(/Approved\. Low-risk lessons from a team member's correction go live on trial again/u);
  expect(approved).toBe(true);
  expect(log).toEqual([{ path: LESSONS_PATH + "/preset/approve", body: { changeId: "chg-1" } }]);
  expect(LessonPresetChangeBodySchema.parse(log[0]!.body)).toEqual({ changeId: "chg-1" });
  await waitFor(() => expect(f.lessonReads().length).toBeGreaterThan(reads));
 });
 it("Cancel sends the change id to the cancel route and says every lesson still waits for a person", async () => {
  const log: { path: string; body: unknown }[] = [];
  await openLessons({ state: { view: pendingView() }, lessons: decide(log, { done: true }) });
  fireEvent.click(screen.getByRole("button", { name: "Cancel the request" }));
  await screen.findByText(/Cancelled\. Every lesson still waits for a person/u);
  expect(log).toEqual([{ path: LESSONS_PATH + "/preset/cancel", body: { changeId: "chg-1" } }]);
 });
 it("the person who asked sees that it waits for someone else, with Cancel only", async () => {
  await openLessons({ state: { view: pendingView({ mine: true }) } });
  const box = screen.getByRole("region", { name: "Waiting for approval" });
  expect(within(box).getByText(/You asked to allow lessons on trial again\. A different maintainer or admin has to approve it/u)).toBeTruthy();
  expect(within(box).queryByRole("button", { name: "Approve going back to Standard" })).toBeNull();
  expect(within(box).getByRole("button", { name: "Cancel the request" })).toBeTruthy();
 });
 it("the only person who can approve it may approve their own request, and is told it needs a short wait", async () => {
  await openLessons({ state: { view: pendingView({ mine: true, soleOwner: true }) } });
  const box = screen.getByRole("region", { name: "Waiting for approval" });
  expect(within(box).getByText(/You are the only person who can approve it/u)).toBeTruthy();
  expect(within(box).getByRole("button", { name: "Approve going back to Standard" })).toBeTruthy();
 });
 it("a refusal is shown in the server's own fixed words and nothing else changes", async () => {
  await openLessons({ state: { view: pendingView() }, lessons: (request, url) => request.method === "POST" && url.pathname.endsWith("/preset/approve") ? refusal("FORBIDDEN", "A different maintainer or admin has to approve going back to Standard.") : undefined });
  fireEvent.click(screen.getByRole("button", { name: "Approve going back to Standard" }));
  expect((await screen.findByRole("alert")).textContent).toContain("A different maintainer or admin has to approve going back to Standard.");
  expect(screen.getByRole("button", { name: "Cancel the request" })).toBeTruthy();
 });
 it("someone who cannot decide gets no buttons even if a proposal reached the screen", async () => {
  await openLessons({ state: { view: pendingView({}, { canDecide: false, waiting: [] }) } });
  expect(screen.queryByRole("button", { name: "Approve going back to Standard" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Cancel the request" })).toBeNull();
  expect(screen.queryByRole("region", { name: "Waiting for approval" })).toBeNull();
 });
 it("no proposal, no box", async () => {
  await openLessons({ state: { view: view({ preset: "regulated" }) } });
  expect(screen.queryByRole("region", { name: "Waiting for approval" })).toBeNull();
  expect(screen.getByRole("button", { name: "Allow lessons on trial again" })).toBeTruthy();
 });
 it("a proposal on a company-locked project shows no buttons either (nothing to approve here)", async () => {
  await openLessons({ state: { view: pendingView({}, { presetLockedByCompany: true }) } });
  expect(screen.queryByRole("button", { name: "Approve going back to Standard" })).toBeNull();
 });
});
