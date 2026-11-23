// @vitest-environment jsdom
// L4-JA (journey audit B11): the project's Skills tab. The list with versions and approvals, the draft's text, Edit within the 32 KB limit (and the 8 KB "consider splitting" note), Approve by two DIFFERENT people (the same person
// cannot approve twice), Retire, fixed words, role checks as Code says them (`canDecide`), the tab hidden when Code does not serve the routes, and no step-up anywhere. Every write is sent once.
import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ApiError } from "../../packages/ui/src/api/errors.js";
import { NEEDS_TWO, SKILLS_EMPTY_TITLE, SKILLS_READ_ONLY, SKILL_LIMITS, SKILL_LONG_NOTE, SKILL_RETIRE_CONFIRM, SkillReader, SkillsReader, approvalWords, approveHint, approvedWords, estimateSkillBytes, savedWords, skillStatus, skillsOffered, waitingForApproval } from "../../packages/ui/src/api/skills.js";
import { SkillsTab } from "./support/legacy-wiki-skills/SkillsTab.js";
import { ProjectScreen } from "../../packages/ui/src/screens/project/ProjectScreen.js";
import { meFixture } from "./support/fixtures.js";
import { projectFixture } from "./support/project-fixture.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";

const textArea = (element: HTMLElement): HTMLTextAreaElement => element as HTMLTextAreaElement;
const button = (element: HTMLElement): HTMLButtonElement => element as HTMLButtonElement;

afterEach(() => { vi.useRealTimers(); });
const ok = (body: unknown): ApiResponse => ({ status: 200, body });
const row = (name: string, patch: Record<string, unknown> = {}) => ({ name, description: `About ${name}`, currentVersion: 1, approvals: 0, approvedByYou: false, retired: false, bytes: 400, ...patch });
const TEXT = "---\nname: add-queue\ndescription: Add a queue\n---\n\n## When to use\nadding a queue\n\n## Steps\n1. Create the queue.\n2. Register the handler.\n";
const FORM = { description: "Add a queue", when: "adding a queue", steps: ["Create the queue.", "Register the handler."] };
interface World { canDecide: boolean; skills: Array<Record<string, unknown>>; texts: Record<string, { content: string; form?: unknown }>; sends: ApiRequest[]; send?: (request: ApiRequest) => ApiResponse | undefined }
function world(patch: Partial<World> = {}): World {
  return { canDecide: true, skills: [row("add-queue", { currentVersion: 2, activeVersion: 1, approvals: 1 }), row("log-ids", { activeVersion: 1, approvals: 2 }), row("old-one", { retired: true, activeVersion: 1, approvals: 2 })], texts: { "add-queue": { content: TEXT, form: FORM }, "log-ids": { content: TEXT, form: FORM }, "old-one": { content: TEXT } }, sends: [], ...patch };
}
const answers = (w: World) => (request: ApiRequest): ApiResponse => {
  const url = new URL(request.path, "https://x.example"), path = url.pathname;
  if (request.method !== "GET") { w.sends.push(request);const own = w.send?.(request);return own ?? { status: 404, body: { error: { code: "NOT_FOUND", message: "no" } } }; }
  const one = /\/skills\/([^/]+)$/u.exec(path);
  if (one !== null) {
    const name = decodeURIComponent(one[1]!), skill = w.skills.find(entry => entry["name"] === name), text = w.texts[name];
    return skill === undefined || text === undefined ? { status: 404, body: { error: { code: "NOT_FOUND", message: "That skill is no longer there." } } } : ok({ project: "web", canDecide: w.canDecide, skill: { ...skill, ...text } });
  }
  if (path.endsWith("/skills")) return ok({ project: "web", canDecide: w.canDecide, skills: w.skills });
  return { status: 404, body: { error: { code: "NOT_FOUND", message: "no" } } };
};
function mount(w: World) {
  const f = fakeHost(async request => answers(w)(request));
  const query = createQueryClient(), path = "/app/projects/web";
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: [path], children: h(Announcer, { children: h(Routes, {}, h(Route, { path, element: h(SkillsTab, { project: "web" }) })) }) }) }) }));
  return { ...f, ...ui, close() { ui.unmount();query.clear(); } };
}
const open = async (name: string) => { fireEvent.click(await screen.findByRole("button", { name: `Open ${name}` }));return screen.findByTestId(`skill-detail-${name}`); };

// ---- Words ----
it("words where a skill stands, its approvals and the person's own part in fixed sentences", () => {
  expect(skillStatus({ currentVersion: 1, retired: false })).toBe("Draft (version 1), not in use yet");
  expect(skillStatus({ currentVersion: 2, activeVersion: 2, retired: false })).toBe("In use (version 2)");
  expect(skillStatus({ currentVersion: 3, activeVersion: 2, retired: false })).toBe("Version 2 is in use; version 3 is a draft");
  expect(skillStatus({ currentVersion: 3, activeVersion: 2, retired: true })).toBe("Retired");
  expect(waitingForApproval({ currentVersion: 3, activeVersion: 2, retired: false })).toBe(true);
  expect(waitingForApproval({ currentVersion: 2, activeVersion: 2, retired: false })).toBe(false);
  expect(waitingForApproval({ currentVersion: 2, retired: true })).toBe(false);
  expect(approvalWords({ approvals: 1 })).toBe("1 of 2 approvals");
  expect(approvalWords({ approvals: 5 })).toBe("2 of 2 approvals");
  expect(approveHint({ approvedByYou: false, approvals: 0 })).toBe(NEEDS_TWO);
  expect(approveHint({ approvedByYou: false, approvals: 1 })).toBe("It needs one more person to approve it.");
  expect(approveHint({ approvedByYou: true, approvals: 1 })).toBe("You approved this version. It needs one more person, not you again.");
  expect(approvedWords({ approvals: 1, live: false })).toBe("Approved. 1 of 2 approvals. It needs one more person before it is used.");
  expect(approvedWords({ approvals: 2, live: true })).toBe("Approved. This version is now in use.");
  expect(savedWords(4)).toContain("Saved as version 4.");
  expect(SKILL_LIMITS).toEqual({ description: 200, when: 2_000, step: 4_000, steps: 12, note: 2_000, textBytes: 32_768, longBytes: 8_192, approversRequired: 2 });
  expect(SKILL_LONG_NOTE).toBe("This skill is long. Consider splitting it into smaller skills.");
});

it("estimates the size of the text the way Code lays it out", () => {
  const small = estimateSkillBytes("add-queue", { ...FORM });
  expect(small).toBe(new TextEncoder().encode(TEXT).length);
  expect(estimateSkillBytes("a", { description: "d", when: "w", steps: ["x".repeat(9_000)] })).toBeGreaterThan(8_192);
  expect(estimateSkillBytes("a", { description: "d", when: "w", steps: Array.from({ length: 12 }, () => "é".repeat(2_000)) })).toBeGreaterThan(32_768);
  expect(estimateSkillBytes("a", { description: "d", when: "w", steps: ["s", "  "], doneWhen: "", why: " " })).toBe(estimateSkillBytes("a", { description: "d", when: "w", steps: ["s"] }));
});

it("reads only what is the shape: rows that do not read are left out, an invented note is dropped, a missing canDecide is no", () => {
  const view = SkillsReader.parse({ project: "web", skills: [row("a-b", { note: "Run this", extra: 1 }), row("Bad Name"), row("c-d", { activeVersion: 5 }), row("a-b"), "x", row("e-f", { approvals: "1" })] });
  expect(view).toEqual({ project: "web", canDecide: false, skills: [{ name: "a-b", description: "About a-b", currentVersion: 1, approvals: 0, approvedByYou: false, retired: false, bytes: 400 }] });
  expect(() => SkillsReader.parse({ project: "web" })).toThrow();
  expect(() => SkillReader.parse({ project: "web", canDecide: true, skill: row("a-b") })).toThrow();
  expect(SkillReader.parse({ project: "web", canDecide: true, skill: { ...row("a-b"), content: "text", form: { description: "d", when: "w", steps: [] } } }).skill).not.toHaveProperty("form");
});

it("offers the tab once the list is read, and not when Code does not serve it, lessons are off, the answer cannot be read or the person may not see skills", () => {
  expect(skillsOffered({ isSuccess: true, isError: false, error: null })).toBe(true);
  expect(skillsOffered({ isSuccess: false, isError: true, error: new ApiError(500, "RUNTIME_UNAVAILABLE", "x") })).toBe(true);
  expect(skillsOffered({ isSuccess: false, isError: true, error: new ApiError(0, "NETWORK_ERROR", "x") })).toBe(true);
  for (const error of [new ApiError(501, "NOT_ON_CODE_YET", "x"), new ApiError(404, "LESSONS_SWITCHED_OFF", "x"), new ApiError(403, "FORBIDDEN", "x"), new ApiError(502, "INVALID_RESPONSE", "x")]) expect(skillsOffered({ isSuccess: false, isError: true, error }), error.code).toBe(false);
  expect(skillsOffered({ isSuccess: false, isError: false, error: null })).toBe(false);
});

// ---- The list ----
it("lists each skill with where it stands, the approvals the newest version has and the long-skill note, and no text until one is opened", async () => {
  const w = world({ skills: [row("add-queue", { currentVersion: 2, activeVersion: 1, approvals: 1 }), row("big-one", { bytes: 9_000, note: SKILL_LONG_NOTE, approvals: 1 }), row("log-ids", { activeVersion: 1, currentVersion: 1, approvals: 2 }), row("old-one", { retired: true, activeVersion: 1, approvals: 2 })] });
  const f = mount(w);
  await screen.findByTestId("skills-tab");
  expect(screen.getByTestId("skill-status-add-queue").textContent).toBe("Version 1 is in use; version 2 is a draft");
  expect(screen.getByTestId("skill-approvals-add-queue").textContent).toBe("1 of 2 approvals");
  expect(screen.getByTestId("skill-status-big-one").textContent).toBe("Draft (version 1), not in use yet");
  expect(screen.getByTestId("skill-note-big-one").textContent).toBe(SKILL_LONG_NOTE);
  expect(screen.getByTestId("skill-status-log-ids").textContent).toBe("In use (version 1)");
  expect(screen.queryByTestId("skill-approvals-log-ids")).toBeNull();
  expect(screen.getByTestId("skill-status-old-one").textContent).toBe("Retired");
  expect(screen.queryByTestId("skill-text")).toBeNull();
  // The list asked once, with no step-up and nothing else.
  expect(f.request.mock.calls.map(([request]) => `${request.method} ${request.path}`)).toEqual(["GET /v1/app/projects/web/skills"]);
  await expectNoAxeViolations(f.container);
  f.close();
});

it("an empty project says there are no skills yet and where they come from; a person who may not decide is told so", async () => {
  const f = mount(world({ skills: [], canDecide: false }));
  expect((await screen.findByTestId("skills-empty")).textContent).toContain(SKILLS_EMPTY_TITLE);
  expect(screen.getByTestId("skills-read-only").textContent).toBe(SKILLS_READ_ONLY);
  f.close();
});

it("a list that cannot be read says so and offers Try again; nothing is half drawn", async () => {
  const f = fakeHost(async () => ({ status: 200, body: { project: "web" } }));
  const query = createQueryClient();
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, {}, h(SkillsTab, { project: "web" })) }) }));
  expect((await screen.findByRole("alert")).textContent).toBe("Couldn't load the skills. Try again.");
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  ui.unmount();query.clear();
});

// ---- Open: the text, and who may do what ----
it("opening a skill shows the text of its newest version and, for a person who decides, Approve, Edit and Retire", async () => {
  const f = mount(world());
  const detail = await open("add-queue");
  expect(within(detail).getByTestId("skill-text").textContent).toBe(TEXT);
  expect(within(detail).getByTestId("skill-approve-hint").textContent).toBe("It needs one more person to approve it.");
  expect(within(detail).getByRole("button", { name: "Approve version 2 of add-queue" })).toBeTruthy();
  expect(within(detail).getByRole("button", { name: "Edit add-queue" })).toBeTruthy();
  expect(within(detail).getByRole("button", { name: "Retire add-queue" })).toBeTruthy();
  f.close();
});

it("a person Code does not name as one who decides reads the text and sees no Approve, Edit or Retire", async () => {
  const f = mount(world({ canDecide: false }));
  const detail = await open("add-queue");
  expect(within(detail).getByTestId("skill-text")).toBeTruthy();
  expect(within(detail).queryByRole("button")).toBeNull();
  f.close();
});

it("a version the person already approved has no Approve button and says one more person is needed; a version in use and a retired skill have none either", async () => {
  const f = mount(world({ skills: [row("add-queue", { currentVersion: 2, activeVersion: 1, approvals: 1, approvedByYou: true }), row("log-ids", { activeVersion: 1, approvals: 2 }), row("old-one", { retired: true, activeVersion: 1 })], texts: { "add-queue": { content: TEXT, form: FORM }, "log-ids": { content: TEXT }, "old-one": { content: TEXT } } }));
  const detail = await open("add-queue");
  expect(within(detail).queryByRole("button", { name: /Approve/u })).toBeNull();
  expect(within(detail).getByTestId("skill-approve-hint").textContent).toBe("You approved this version. It needs one more person, not you again.");
  fireEvent.click(screen.getByRole("button", { name: "Close add-queue" }));
  const live = await open("log-ids");
  expect(within(live).queryByRole("button", { name: /Approve/u })).toBeNull();
  expect(within(live).getByRole("button", { name: "Edit log-ids" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close log-ids" }));
  const gone = await open("old-one");
  expect(within(gone).queryByRole("button")).toBeNull();
  f.close();
});

// ---- Approve ----
it("Approve names the version the person read, is sent once, and says what it came to; the second person's approval puts it in use", async () => {
  const w = world({ send: request => (request.path.endsWith("/approve") ? ok({ project: "web", name: "add-queue", version: 2, approvals: 2, live: true }) : undefined) });
  const f = mount(w);
  const detail = await open("add-queue");
  fireEvent.click(within(detail).getByRole("button", { name: "Approve version 2 of add-queue" }));
  expect((await within(detail).findByTestId("skill-done")).textContent).toBe("Approved. This version is now in use.");
  expect(w.sends).toHaveLength(1);
  expect(w.sends[0]).toMatchObject({ method: "POST", path: "/v1/app/projects/web/skills/add-queue/approve", body: { version: 2 }, retry: "never" });
  f.close();
});

it("an approval that waits for a second person says so", async () => {
  const w = world({ send: () => ok({ project: "web", name: "add-queue", version: 2, approvals: 1, live: false }) });
  const f = mount(w);
  const detail = await open("add-queue");
  fireEvent.click(within(detail).getByRole("button", { name: "Approve version 2 of add-queue" }));
  expect((await within(detail).findByTestId("skill-done")).textContent).toBe("Approved. 1 of 2 approvals. It needs one more person before it is used.");
  f.close();
});

it("Code's refusal (the same person again, a changed skill, someone who may not decide) is shown in Code's own words and the skill is read again after a stale one", async () => {
  const w = world({ send: () => ({ status: 409, body: { error: { code: "IDEMPOTENCY_CONFLICT", message: "This skill changed since you read it. Read it again and decide again." } } }) });
  const f = mount(w);
  const detail = await open("add-queue");
  const before = f.request.mock.calls.length;
  fireEvent.click(within(detail).getByRole("button", { name: "Approve version 2 of add-queue" }));
  expect((await within(detail).findByTestId("skill-error")).textContent).toBe("This skill changed since you read it. Read it again and decide again.");
  await waitFor(() => expect(f.request.mock.calls.length).toBeGreaterThan(before + 1));
  expect(w.sends).toHaveLength(1);
  f.close();
});

it("a refusal with no words of Code's own gets the fixed 'nothing was changed' sentence, never the cause", async () => {
  const w = world({ send: () => ({ status: 500, body: { oops: "SENSITIVE-DETAIL" } }) });
  const f = mount(w);
  const detail = await open("add-queue");
  fireEvent.click(within(detail).getByRole("button", { name: "Approve version 2 of add-queue" }));
  const text = (await within(detail).findByTestId("skill-error")).textContent ?? "";
  expect(text).not.toContain("SENSITIVE-DETAIL");
  expect(text.length).toBeGreaterThan(5);
  f.close();
});

// ---- Retire ----
it("Retire asks once with the fixed warning, then sends one request with no body; Cancel sends nothing", async () => {
  const w = world({ send: () => ok({ project: "web", name: "log-ids", retired: true }) });
  const f = mount(w);
  const detail = await open("log-ids");
  fireEvent.click(within(detail).getByRole("button", { name: "Retire log-ids" }));
  expect(within(detail).getByText(SKILL_RETIRE_CONFIRM)).toBeTruthy();
  fireEvent.click(within(detail).getByRole("button", { name: "Cancel" }));
  expect(w.sends).toEqual([]);
  fireEvent.click(within(detail).getByRole("button", { name: "Retire log-ids" }));
  fireEvent.click(within(detail).getByRole("button", { name: "Retire skill" }));
  expect((await within(detail).findByTestId("skill-done")).textContent).toBe("Retired. Rovara no longer gives it to tasks.");
  expect(w.sends).toHaveLength(1);
  expect(w.sends[0]).toMatchObject({ method: "POST", path: "/v1/app/projects/web/skills/log-ids/retire", body: {}, retry: "never" });
  f.close();
});

// ---- Edit ----
it("Edit starts from the fields Code read back, shows the size, and Save sends the new version once with the version read; the answer says it needs two approvals", async () => {
  const w = world({ send: () => ok({ project: "web", name: "add-queue", version: 3 }) });
  const f = mount(w);
  const detail = await open("add-queue");
  fireEvent.click(within(detail).getByRole("button", { name: "Edit add-queue" }));
  const form = await within(detail).findByTestId("skill-edit-form");
  expect(textArea(within(form).getByLabelText("When to use it")).value).toBe("adding a queue");
  expect(textArea(within(form).getByLabelText("Step 2")).value).toBe("Register the handler.");
  expect(within(form).getByTestId("skill-size").textContent).toContain("KB of 32 KB");
  fireEvent.change(within(form).getByLabelText("Step 2"), { target: { value: "Register the handler and add an alarm." } });
  fireEvent.click(within(form).getByRole("button", { name: "Add a step" }));
  fireEvent.change(within(form).getByLabelText("Step 3"), { target: { value: "Check the alarm fires." } });
  fireEvent.change(within(form).getByLabelText("Why this order (optional)"), { target: { value: "The alarm needs the queue." } });
  fireEvent.click(within(form).getByRole("button", { name: "Save as a new version" }));
  expect((await within(detail).findByTestId("skill-done")).textContent).toBe(savedWords(3));
  expect(w.sends).toHaveLength(1);
  expect(w.sends[0]).toMatchObject({ method: "PUT", path: "/v1/app/projects/web/skills/add-queue", retry: "never", body: { expectedVersion: 2, description: "Add a queue", when: "adding a queue", steps: ["Create the queue.", "Register the handler and add an alarm.", "Check the alarm fires."], why: "The alarm needs the queue." } });
  expect(Object.keys(w.sends[0]!.body as object).sort()).toEqual(["description", "expectedVersion", "steps", "when", "why"]);
  f.close();
});

it("a skill whose fields Code could not read back opens an empty form with a plain note, and Save stays off until it is complete", async () => {
  const w = world({ texts: { "add-queue": { content: TEXT } } });
  const f = mount(w);
  const detail = await open("add-queue");
  fireEvent.click(within(detail).getByRole("button", { name: "Edit add-queue" }));
  const form = await within(detail).findByTestId("skill-edit-form");
  expect(within(form).getByTestId("skill-edit-blank")).toBeTruthy();
  const save = button(within(form).getByRole("button", { name: "Save as a new version" }));
  expect(save.disabled).toBe(true);
  fireEvent.change(within(form).getByLabelText("When to use it"), { target: { value: "adding a queue" } });
  fireEvent.change(within(form).getByLabelText("Step 1"), { target: { value: "Create it." } });
  expect(save.disabled).toBe(false);
  f.close();
});

it("over 8 KB the person sees the 'consider splitting' note; over 32 KB Save is off and the size says too long; nothing is sent", async () => {
  const w = world();
  const f = mount(w);
  const detail = await open("add-queue");
  fireEvent.click(within(detail).getByRole("button", { name: "Edit add-queue" }));
  const form = await within(detail).findByTestId("skill-edit-form");
  const save = button(within(form).getByRole("button", { name: "Save as a new version" }));
  expect(within(form).queryByTestId("skill-edit-long")).toBeNull();
  fireEvent.change(within(form).getByLabelText("Step 1"), { target: { value: "x".repeat(4_000) } });
  fireEvent.click(within(form).getByRole("button", { name: "Add a step" }));
  fireEvent.change(within(form).getByLabelText("Step 3"), { target: { value: "y".repeat(4_000) } });
  fireEvent.click(within(form).getByRole("button", { name: "Add a step" }));
  fireEvent.change(within(form).getByLabelText("Step 4"), { target: { value: "z".repeat(1_000) } });
  expect((await within(form).findByTestId("skill-edit-long")).textContent).toBe(SKILL_LONG_NOTE);
  expect(save.disabled).toBe(false);
  for (let index = 5; index <= 12; index += 1) { fireEvent.click(within(form).getByRole("button", { name: "Add a step" }));fireEvent.change(within(form).getByLabelText(`Step ${String(index)}`), { target: { value: "w".repeat(4_000) } }); }
  expect(within(form).getByTestId("skill-size").textContent).toContain("Too long: a skill is at most 32 KB.");
  expect(save.disabled).toBe(true);
  expect(button(within(form).getByRole("button", { name: "Add a step" })).disabled).toBe(true);
  fireEvent.submit(form);
  expect(w.sends).toEqual([]);
  f.close();
});

it("an empty step keeps Save off, a step can be removed, and Cancel closes the form without sending", async () => {
  const w = world();
  const f = mount(w);
  const detail = await open("add-queue");
  fireEvent.click(within(detail).getByRole("button", { name: "Edit add-queue" }));
  const form = await within(detail).findByTestId("skill-edit-form");
  const save = button(within(form).getByRole("button", { name: "Save as a new version" }));
  fireEvent.click(within(form).getByRole("button", { name: "Add a step" }));
  expect(save.disabled).toBe(true);
  fireEvent.click(within(form).getByRole("button", { name: "Remove step 3" }));
  expect(save.disabled).toBe(false);
  fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
  expect(within(detail).queryByTestId("skill-edit-form")).toBeNull();
  expect(w.sends).toEqual([]);
  f.close();
});

it("Code's 32 KB refusal is shown in Code's words and the form stays open with what was typed", async () => {
  const w = world({ send: () => ({ status: 400, body: { error: { code: "CONFIG_INVALID", message: "That skill is too long. A skill is at most 32 KB." } } }) });
  const f = mount(w);
  const detail = await open("add-queue");
  fireEvent.click(within(detail).getByRole("button", { name: "Edit add-queue" }));
  const form = await within(detail).findByTestId("skill-edit-form");
  fireEvent.change(within(form).getByLabelText("Step 1"), { target: { value: "Create it twice." } });
  fireEvent.click(within(form).getByRole("button", { name: "Save as a new version" }));
  expect((await within(form).findByTestId("skill-edit-error")).textContent).toBe("That skill is too long. A skill is at most 32 KB.");
  expect(textArea(within(form).getByLabelText("Step 1")).value).toBe("Create it twice.");
  expect(w.sends).toHaveLength(1);
  f.close();
});

it("hidden control characters in a skill's words are shown as visible marks, never drawn", async () => {
  const w = world({ skills: [row("add-queue", { description: "Add‮ a queue", currentVersion: 1 })], texts: { "add-queue": { content: "a‮b\nc" } } });
  const f = mount(w);
  await screen.findByTestId("skills-tab");
  expect(screen.getByText(/Add\[U\+202E\] a queue/u)).toBeTruthy();
  const detail = await open("add-queue");
  expect(within(detail).getByTestId("skill-text").textContent).toBe("a[U+202E]b\nc");
  f.close();
});

// ---- The tab on the project page ----
function project(skillsAnswer: (request: ApiRequest) => ApiResponse, initial = "/app/projects/payments?tab=skills") {
  const f = fakeHost(async request => request.path === "/v1/app/changes" ? ok({ notices: [], next: "settled" }) : request.path === "/v1/app/me" ? ok(meFixture()) : request.path.endsWith("/skills") ? skillsAnswer(request) : request.method === "GET" ? ok(projectFixture()) : { status: 404, body: { error: { code: "NOT_FOUND", message: "no" } } });
  const query = createQueryClient();
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: [initial], children: h(Announcer, { children: h(Routes, {}, h(Route, { path: "/app/projects/:name", element: h(ProjectScreen, {}) })) }) }) }) }));
  return { ...f, ...ui, close() { ui.unmount();query.clear(); } };
}
it("the project page offers a Skills tab when Code serves skills, and opens it from ?tab=skills", async () => {
  const f = project(() => ok({ project: "payments", canDecide: true, skills: [row("add-queue")] }));
  // The rebuilt Skills page (G3) opens from the address and draws its own project frame (the Skills pill).
  expect(await screen.findByRole("heading", { name: "Skills in payments" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Skills" }).getAttribute("aria-current")).toBe("page");
  f.close();
});
it("the project page shows no Skills tab, and ?tab=skills opens the overview, when Code does not serve skills (501) or lessons are off (404)", async () => {
  for (const answer of [{ status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "Skills aren't available on this Rovara yet." } } }, { status: 404, body: { error: { code: "LESSONS_SWITCHED_OFF", message: "Lessons are off." } } }]) {
    const f = project(() => answer);
    await screen.findByRole("heading", { name: "payments" });
    await waitFor(() => expect(f.request.mock.calls.some(([request]) => request.path.endsWith("/skills"))).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(screen.queryByRole("tab", { name: "Skills" })).toBeNull();
    expect(screen.queryByTestId("skills-tab")).toBeNull();
    f.close();
  }
});
