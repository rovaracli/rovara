// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { userEvent } from "@testing-library/user-event";
import { LearningAcceptBodySchema, LearningDismissBodySchema, LearningReopenBodySchema, LearningRuleRemoveBodySchema, LEARNING_TEXT_MAX } from "@agentx/contracts/web";
import { ProjectScreen } from "../../packages/ui/src/screens/project/ProjectScreen.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { h } from "./support/h.js";
import { diffBody, publishedAgent, LAYER } from "./support/how-we-work-fixture.js";
import { CONFIRM_URL, LEARNING_PATH, dismissed, learningHost, learningView, rule, source, suggestion } from "./support/learning-fixture.js";

type Options = Parameters<typeof learningHost>[0] & { theme?: "light" | "dark"; path?: string };
function setup(options: Options = {}) {
 const cell = learningHost(options), query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: cell.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: [options.path ?? "/app/projects/payments?tab=how-we-work"], children: h(Announcer, { children: h(Routes, { children: h(Route, { path: "/app/projects/:name", element: h(ProjectScreen, {}) }) }) }) }) }) }), { theme: options.theme ?? "light" });
 return { ...cell, ...ui, query };
}
const open = async (options: Options = {}) => { const world = setup(options);await screen.findByRole("heading", { name: /^Suggested rules/u });return world; };
const ok = (body: unknown, status = 200) => ({ status, body });
const refuse = (code: string, message: string, status = 409) => ({ status, body: { error: { code, message } } });
const cards = () => screen.getAllByRole("region", { name: /^Suggested rule for/u });
const accept = () => fireEvent.click(screen.getByRole("button", { name: /^(Accept as new version|Request approval)$/u }));

describe("the Suggested rules section", () => {
 it("sits above the stage cards on the How we work tab and counts the open suggestions", async () => {
  const f = await open({ view: learningView({ suggestions: [suggestion(), suggestion({ id: "sug_2", stage: "*", proposedText: "Keep answers short." })] }) });
  expect(screen.getByRole("heading", { name: "Suggested rules (2)" })).toBeTruthy();
  const section = screen.getByRole("region", { name: "Suggested rules" }), stages = screen.getByRole("list", { name: "Stages" });
  expect(section.compareDocumentPosition(stages) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(f.calls()).toContain("GET " + LEARNING_PATH);
  expect(cards()).toHaveLength(2);
 });

 it("shows a card: stage, prefilled wording with its note, why, and each source as plain text", async () => {
  await open();
  const card = within(cards()[0]!);
  expect(card.getByRole("heading", { name: "Suggested rule for Build" })).toBeTruthy();
  expect(card.getByText("Applies to:").textContent).toBe("Applies to: Build");
  expect(card.getByText("Accepted for the Build step. To use it elsewhere, edit How we work.")).toBeTruthy();
  const box = card.getByRole<HTMLTextAreaElement>("textbox", { name: "Proposed wording" });
  expect(box.value).toBe("Add a test for every bug fix.");
  expect(box.maxLength).toBe(LEARNING_TEXT_MAX);
  expect(card.getByText("Proposed wording (from the latest correction). Edit before accepting.")).toBeTruthy();
  expect(card.getByText("Why: said 2 times")).toBeTruthy();
  const items = card.getAllByRole("listitem").map(item => item.textContent ?? "");
  expect(items[0]).toContain("Please add a test.");
  expect(items[0]).toContain("Comment");
  expect(items[0]).toContain("Team member");
  expect(items[1]).toContain("Plan send-back");
  expect(items[1]).toContain("Tests are missing again.");
  expect(card.getByRole("link", { name: /Please add a test\./u }).getAttribute("href")).toBe("/review/tsk_1/task");
 });

 it("names the project-wide stage in words", async () => {
  await open({ view: learningView({ suggestions: [suggestion({ stage: "*" })] }) });
  expect(within(cards()[0]!).getByText("Applies to:").textContent).toBe("Applies to: Everyone except reviewers (project-wide)");
  expect(within(cards()[0]!).getByText("Accepted for every step except reviewers. To use it elsewhere, edit How we work.")).toBeTruthy();
  expect(within(cards()[0]!).queryByText(/the Everyone except reviewers/u)).toBeNull();
 });

 it("renders a source that holds a link or markdown literally, and links only the server's task path", async () => {
  const label = '<a href="https://evil.example/x">click</a> **bold** [md](https://evil.example/y)';
  const { container } = await open({ view: learningView({ suggestions: [suggestion({ sources: [source({ label, href: "https://evil.example/task" }), source({ taskId: "tsk_2", label: "Second", href: "javascript:alert(1)" })] })] }) });
  expect(within(cards()[0]!).getByText(label, { exact: false })).toBeTruthy();
  expect(container.querySelector('a[href*="evil"]')).toBeNull();
  expect(cards()[0]!.querySelector(".rv-learning-sources strong, .rv-learning-sources a, .rv-learning-sources em")).toBeNull();
  expect(container.querySelector('a[href^="javascript"]')).toBeNull();
  expect(cards()[0]!.querySelectorAll("a")).toHaveLength(0);
 });

 it("labels a suggestion from one person, a less-safe one with its words, and an overlap", async () => {
  await open({ view: learningView({ suggestions: [suggestion({ allFromOnePerson: true, lessSafe: true, lessSafeWords: ["review", "security"], overlaps: ["Run the linter first.", "Keep changes small."] })] }) });
  const card = within(cards()[0]!);
  expect(card.getByText("All from one person")).toBeTruthy();
  expect(card.getByText("Needs a second person")).toBeTruthy();
  expect(card.getByText(/review, security/u)).toBeTruthy();
  expect(card.getByText("May overlap with: Run the linter first.; Keep changes small.")).toBeTruthy();
  expect(card.getByRole("button", { name: "Request approval" })).toBeTruthy();
  expect(card.queryByRole("button", { name: "Accept as new version" })).toBeNull();
 });

 it("keeps the plain Accept label for a review-stage suggestion the server did not mark less safe", async () => {
  await open({ view: learningView({ suggestions: [suggestion({ stage: "review" })] }) });
  expect(within(cards()[0]!).getByRole("button", { name: "Accept as new version" })).toBeTruthy();
 });

 it("is read-only where the server says this person cannot decide", async () => {
  await open({ view: learningView({ canDecide: false, suggestions: [suggestion({ canDecide: false })] }) });
  const card = within(cards()[0]!);
  expect(card.getByText("Only a project maintainer can decide.")).toBeTruthy();
  expect(card.queryByRole("button", { name: /Accept|Request approval/u })).toBeNull();
  expect(card.queryByRole("button", { name: "Dismiss…" })).toBeNull();
  expect(card.queryByRole("textbox")).toBeNull();
  expect(card.getByText("Add a test for every bug fix.")).toBeTruthy();
 });

 it("lets an author accept (their own rule) but not dismiss, as the server computes it", async () => {
  await open({ view: learningView({ canDecide: false, suggestions: [suggestion({ canDecide: true })] }) });
  const card = within(cards()[0]!);
  expect(card.getByRole("button", { name: "Accept as new version" })).toBeTruthy();
  expect(card.queryByRole("button", { name: "Dismiss…" })).toBeNull();
 });

 it("shows a suggestion that is being saved or waiting for a second person as read-only", async () => {
  await open({ view: learningView({ suggestions: [suggestion({ status: "accepting" }), suggestion({ id: "sug_2", status: "awaiting_approval" })] }) });
  const [saving, waiting] = cards().map(card => within(card));
  expect(saving!.getByText("Saving")).toBeTruthy();
  expect(waiting!.getByText("Waiting for a second person")).toBeTruthy();
  for (const card of [saving!, waiting!]) { expect(card.queryByRole("button")).toBeNull();expect(card.queryByRole("textbox")).toBeNull(); }
 });

 it("says so when there are no suggestions", async () => {
  await open({ view: learningView({ suggestions: [] }) });
  expect(screen.getByRole("heading", { name: "Suggested rules (0)" })).toBeTruthy();
  expect(screen.getByText("No suggested rules yet. Rovara suggests one when the same correction comes up twice.")).toBeTruthy();
 });

 it("shows nothing at all, and no alert, where the company has not opened the learning loop", async () => {
  const f = setup({ learn: (request, url) => request.method === "GET" && url.pathname === LEARNING_PATH ? refuse("NOT_FOUND", "Rovara isn't learning from this project right now.", 404) : undefined });
  await screen.findByRole("heading", { name: "Build" });
  await waitFor(() => expect(f.learningReads()).toBe(1));
  expect(screen.queryByRole("region", { name: "Suggested rules" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText(/Suggested rules/u)).toBeNull();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
 });

 it("says when the read failed, and tries again", async () => {
  let fail = true;
  const f = setup({ learn: (request, url) => fail && request.method === "GET" && url.pathname === LEARNING_PATH ? refuse("RUNTIME_UNAVAILABLE", "Rovara could not load suggested rules.", 400) : undefined });
  expect((await screen.findByText("Rovara could not load suggested rules.")).closest("[role=alert]")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Build" })).toBeTruthy();
  fail = false;fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByRole("heading", { name: "Suggested rules (1)" });
  expect(f.learningReads()).toBeGreaterThan(1);
 });
});

describe("accepting", () => {
 it("sends the strict body with the edited wording, the suggestion's own stage and its revision", async () => {
  const f = await open({ learn: request => request.method === "POST" ? ok({ outcome: "published", version: 7 }) : undefined });
  fireEvent.change(screen.getByRole("textbox", { name: "Proposed wording" }), { target: { value: "  Always add a regression test.  " } });
  accept();
  expect((await screen.findByRole("status")).textContent).toContain("Added in version 7");
  const [write] = f.learningWrites();
  expect(write!.method + " " + write!.path).toBe("POST " + LEARNING_PATH + "/suggestions/sug_1/accept");
  expect(() => LearningAcceptBodySchema.parse(write!.body)).not.toThrow();
  const sent = LearningAcceptBodySchema.parse(write!.body);
  expect(sent.requestId).toMatch(/^[0-9a-f-]{36}$/u);
  expect({ ...sent, requestId: "" }).toEqual({ requestId: "", expectedRevision: 4, stage: "build", text: "Always add a regression test." });
 });

 it("shows the stage as a label, with no stage picker, and sends the suggestion's own stage (project-wide too)", async () => {
  const f = await open({ view: learningView({ suggestions: [suggestion({ stage: "*" })] }), learn: request => request.method === "POST" ? ok({ outcome: "published", version: 7 }) : undefined });
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.queryByText(/needs a second person\)/u)).toBeNull();
  accept();
  await screen.findByText(/Added in version 7/u);
  expect(f.learningWrites()[0]!.body).toMatchObject({ stage: "*" });
 });

 it("invalidates the learning read and the How we work reads after a decision", async () => {
  const f = await open({ learn: request => request.method === "POST" ? ok({ outcome: "published", version: 7 }) : undefined });
  const before = { learning: f.learningReads(), view: f.calls().filter(call => call === "GET /v1/app/projects/payments/how-we-work").length };
  accept();
  await waitFor(() => expect(f.learningReads()).toBe(before.learning + 1));
  await waitFor(() => expect(f.calls().filter(call => call === "GET /v1/app/projects/payments/how-we-work").length).toBe(before.view + 1));
 });

 it("does not send an empty wording", async () => {
  const f = await open();
  fireEvent.change(screen.getByRole("textbox", { name: "Proposed wording" }), { target: { value: "   " } });
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Accept as new version" }).disabled).toBe(true);
  accept();
  expect(f.learningWrites()).toHaveLength(0);
 });

 it("a 202 that waits for a second person shows the waiting state and opens the confirmation", async () => {
  const f = await open({ learn: request => request.method === "POST" ? ok({ status: "NEEDS_CONFIRMATION", outcome: "awaiting_approval", confirmUrl: CONFIRM_URL, changes: [] }, 202) : undefined });
  accept();
  const note = await screen.findByText("Sent for confirmation: someone else who can approve changes in this project confirms it.");
  expect(note.closest("[role=status]")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open confirmation" }));
  expect(f.host.openExternal).toHaveBeenCalledWith(CONFIRM_URL);
  expect(f.learningWrites()).toHaveLength(1);
 });

 it("reads the 202 that lists its changes the same way", async () => {
  const f = await open({ learn: request => request.method === "POST" ? ok({ status: "NEEDS_CONFIRMATION", outcome: "awaiting_approval", confirmUrl: CONFIRM_URL, changes: ["Adds a rule to Build"] }, 202) : undefined });
  accept();
  await screen.findByText("Adds a rule to Build");
  fireEvent.click(screen.getByRole("button", { name: "Open confirmation" }));
  expect(f.host.openExternal).toHaveBeenCalledWith(CONFIRM_URL);
 });

 it("never opens a confirmation link that is not this site's approval page", async () => {
  const f = await open({ learn: request => request.method === "POST" ? ok({ status: "NEEDS_CONFIRMATION", outcome: "awaiting_approval", confirmUrl: "https://evil.example/v1/app/approve/abc", changes: [] }, 202) : undefined });
  accept();
  await screen.findByText("Sent for confirmation: someone else who can approve changes in this project confirms it.");
  expect(screen.queryByRole("button", { name: "Open confirmation" })).toBeNull();
  expect(f.host.openExternal).not.toHaveBeenCalled();
 });

 it.each([
  ["AGENT_REVISION_CONFLICT", "This suggestion changed. Reload and try again."],
  ["LEARNING_LAYER_BUSY", "Finish or discard the How we work draft or pending change first."],
  ["LEARNING_RULES_FULL", "This stage's rules are full. Make room in How we work first."],
  ["LEARNING_SOURCES_GONE", "This suggestion no longer has enough sources."],
  ["RATE_LIMITED", "Too many requests. Wait a moment and try again."],
  ["PROJECT_ACCESS_DENIED", "You don't have access to decide this suggestion."],
 ])("shows fixed copy for %s and does not retry", async (code, copy) => {
  const f = await open({ learn: request => request.method === "POST" ? refuse(code, "untrusted server wording from " + code, code === "RATE_LIMITED" ? 429 : 409) : undefined });
  accept();
  expect((await screen.findByText(copy)).closest("[role=alert]")).toBeTruthy();
  expect(screen.queryByText(/untrusted server wording/u)).toBeNull();
  expect(f.learningWrites()).toHaveLength(1);
 });

 it("a revision conflict offers a reload that reads the suggestions again", async () => {
  const f = await open({ learn: request => request.method === "POST" ? refuse("AGENT_REVISION_CONFLICT", "x") : undefined });
  accept();
  await screen.findByText("This suggestion changed. Reload and try again.");
  const reads = f.learningReads();
  fireEvent.click(screen.getByRole("button", { name: "Reload" }));
  await waitFor(() => expect(f.learningReads()).toBe(reads + 1));
 });

 it("reads the list again when a write finds the suggestion gone, and shows the server's words", async () => {
  const f = await open({ learn: request => request.method === "POST" ? refuse("NOT_FOUND", "That suggestion is gone.", 404) : undefined });
  const reads = f.learningReads();
  accept();
  expect((await screen.findByText("That suggestion is gone.")).closest("[role=alert]")).toBeTruthy();
  await waitFor(() => expect(f.learningReads()).toBe(reads + 1));
 });

 it("keeps a section-level notice after the list is read again, when the suggestion it acted on is gone", async () => {
  const f = await open({ learn: request => { if (request.method !== "POST") return undefined;f.learning.view = learningView({ suggestions: [suggestion({ id: "sug_2", stage: "*", proposedText: "Keep answers short." })] });return refuse("NOT_FOUND", "That suggestion is gone.", 404); } });
  expect(cards()).toHaveLength(1);
  accept();
  const notice = await screen.findByText("That suggestion is gone. The list was refreshed.");
  expect(notice.closest("[role=status]")).toBeTruthy();
  await waitFor(() => expect(screen.getByRole("heading", { name: "Suggested rules (1)" })).toBeTruthy());
  await waitFor(() => expect(within(cards()[0]!).getByText("Applies to:").textContent).toBe("Applies to: Everyone except reviewers (project-wide)"));
  expect(screen.getByText("That suggestion is gone. The list was refreshed.")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
 });

 it("shows the same notice when dismissing or reopening finds the suggestion gone", async () => {
  const f = await open({ view: learningView({ suggestions: [suggestion()], dismissed: [dismissed()] }), learn: request => request.method === "POST" ? refuse("NOT_FOUND", "That suggestion is gone.", 404) : undefined });
  fireEvent.click(screen.getByRole("button", { name: "Dismissed (1)" }));
  fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
  await screen.findByText("That suggestion is gone. The list was refreshed.");
  expect(f.learningReads()).toBeGreaterThan(1);
 });

 it("shows the resolver's refusal in its fixed sentence, with a link only to this app", async () => {
  // Lane C's 409 `{code, stage, fixHref}`.
  await open({ learn: request => request.method === "POST" ? { status: 409, body: { error: { code: "STAGE_LOCKED", message: "build: STAGE_LOCKED", stage: "build", fixHref: "/app/admin/how-we-work" } } } : undefined });
  accept();
  await screen.findByText("Build: Your company locked this stage's model choice.");
  expect(screen.getByRole("link", { name: "How to fix this" }).getAttribute("href")).toBe("/app/admin/how-we-work");
 });

 it("shows a refusal's fixed sentence without a link when its fixHref is not this app's", async () => {
  await open({ learn: request => request.method === "POST" ? { status: 409, body: { error: { code: "STAGE_LOCKED", message: "build: STAGE_LOCKED", stage: "build", fixHref: "https://evil.example/fix" } } } : undefined });
  accept();
  await screen.findByText("Build: Your company locked this stage's model choice.");
  expect(screen.queryByRole("link", { name: "How to fix this" })).toBeNull();
 });

 it("shows another refusal as the server wrote it, linking only a same-site app path", async () => {
  await open({ learn: request => request.method === "POST" ? refuse("FORBIDDEN", "Ask a maintainer. See /app/projects/payments?tab=how-we-work for the draft.", 403) : undefined });
  accept();
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Ask a maintainer.");
  expect(within(alert).getByRole("link").getAttribute("href")).toBe("/app/projects/payments?tab=how-we-work");
 });

 it("shows a refusal that names another site as plain text", async () => {
  await open({ learn: request => request.method === "POST" ? refuse("FORBIDDEN", "Ask a maintainer at https://evil.example/app/x or //evil.example/app/y", 403) : undefined });
  accept();
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("https://evil.example/app/x");
  expect(within(alert).queryByRole("link")).toBeNull();
 });
});

describe("dismissing", () => {
 const startDismiss = () => fireEvent.click(screen.getByRole("button", { name: "Dismiss…" }));
 it("needs a reason before anything is sent", async () => {
  const f = await open({ learn: request => request.method === "POST" ? ok({ suggestion: { id: "sug_1", status: "dismissed" } }) : undefined });
  startDismiss();
  const form = screen.getByRole("group", { name: "Why dismiss this?" });
  expect(within(form).getAllByRole("radio").map(radio => radio.parentElement?.textContent)).toEqual(["Wrong or not helpful", "Already covered by a rule", "One-off, not a pattern", "Other"]);
  const send = screen.getByRole<HTMLButtonElement>("button", { name: "Dismiss suggestion" });
  expect(send.disabled).toBe(true);
  fireEvent.click(send);
  expect(f.learningWrites()).toHaveLength(0);
  fireEvent.click(within(form).getByRole("radio", { name: "One-off, not a pattern" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Note (optional)" }), { target: { value: "Only for the migration." } });
  expect(send.disabled).toBe(false);
  fireEvent.click(send);
  await waitFor(() => expect(f.learningWrites()).toHaveLength(1));
  const [write] = f.learningWrites();
  expect(write!.path).toBe(LEARNING_PATH + "/suggestions/sug_1/dismiss");
  expect(LearningDismissBodySchema.parse(write!.body)).toEqual({ expectedRevision: 4, dismissKind: "one_off", note: "Only for the migration." });
 });

 it("leaves the note out when it is empty, and limits it to 500 characters", async () => {
  const f = await open({ learn: request => request.method === "POST" ? ok({ suggestion: { id: "sug_1", status: "dismissed" } }) : undefined });
  startDismiss();
  expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Note (optional)" }).maxLength).toBe(500);
  fireEvent.click(screen.getByRole("radio", { name: "Other" }));
  fireEvent.click(screen.getByRole("button", { name: "Dismiss suggestion" }));
  await waitFor(() => expect(f.learningWrites()).toHaveLength(1));
  expect(f.learningWrites()[0]!.body).toEqual({ expectedRevision: 4, dismissKind: "other" });
 });

 it("reads the learning list again after a dismiss", async () => {
  const f = await open({ learn: request => request.method === "POST" ? ok({ suggestion: { id: "sug_1", status: "dismissed" } }) : undefined });
  const reads = f.learningReads();
  startDismiss();fireEvent.click(screen.getByRole("radio", { name: "Other" }));fireEvent.click(screen.getByRole("button", { name: "Dismiss suggestion" }));
  await waitFor(() => expect(f.learningReads()).toBe(reads + 1));
 });

 it("cancel closes the form without sending", async () => {
  const f = await open();
  startDismiss();fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("group", { name: "Why dismiss this?" })).toBeNull();
  expect(f.learningWrites()).toHaveLength(0);
 });

 it("shows a refusal and keeps the form", async () => {
  await open({ learn: request => request.method === "POST" ? refuse("LEARNING_LAYER_BUSY", "x") : undefined });
  startDismiss();fireEvent.click(screen.getByRole("radio", { name: "Wrong or not helpful" }));fireEvent.click(screen.getByRole("button", { name: "Dismiss suggestion" }));
  await screen.findByText("This suggestion is being accepted. Try again once it is decided.");
  expect(screen.getByRole("group", { name: "Why dismiss this?" })).toBeTruthy();
 });
});

describe("the Dismissed list", () => {
 it("shows stage, date and reason, and Reopen sends an empty body", async () => {
  const f = await open({ view: learningView({ suggestions: [], dismissed: [dismissed(), dismissed({ id: "sug_10", stage: "*", dismissKind: undefined })] }), learn: request => request.method === "POST" ? ok({ reopened: true }) : undefined });
  const toggle = screen.getByRole("button", { name: "Dismissed (2)" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("list", { name: "Dismissed suggestions" })).toBeNull();
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  const rows = within(screen.getByRole("list", { name: "Dismissed suggestions" })).getAllByRole("listitem");
  expect(rows[0]!.textContent).toContain("Plan");
  expect(rows[0]!.textContent).toContain("One-off, not a pattern");
  expect(rows[0]!.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-27T10:00:00.000Z");
  expect(rows[1]!.textContent).toContain("Everyone except reviewers (project-wide)");
  fireEvent.click(within(rows[0]!).getByRole("button", { name: "Reopen" }));
  await waitFor(() => expect(f.learningWrites()).toHaveLength(1));
  const [write] = f.learningWrites();
  expect(write!.path).toBe(LEARNING_PATH + "/dismissed/sug_9/reopen");
  expect(LearningReopenBodySchema.parse(write!.body)).toEqual({});
  await waitFor(() => expect(f.learningReads()).toBeGreaterThan(1));
 });

 it("shows no Reopen to someone who cannot decide", async () => {
  await open({ view: learningView({ canDecide: false, suggestions: [], dismissed: [dismissed()] }) });
  fireEvent.click(screen.getByRole("button", { name: "Dismissed (1)" }));
  expect(screen.queryByRole("button", { name: "Reopen" })).toBeNull();
 });
});

describe("the Added by suggestions list", () => {
 const rules = [rule(), rule({ id: "rul_2", stage: "*", text: "Keep answers short.", status: "awaiting_approval", processVersion: undefined }), rule({ id: "rul_3", text: "Old one.", status: "removed" }), rule({ id: "rul_4", text: "Not used.", status: "not_applied", processVersion: undefined }), rule({ id: "rul_5", text: "Saving one.", status: "pending", processVersion: undefined })];
 const list = () => within(screen.getByRole("list", { name: "Rules added by suggestions" })).getAllByRole("listitem");
 it("shows text, stage, version and status, with Remove only for an active rule", async () => {
  await open({ view: learningView({ suggestions: [], rules }) });
  fireEvent.click(screen.getByRole("button", { name: "Added by suggestions (5)" }));
  const rows = list();
  expect(rows[0]!.textContent).toContain("Run the linter first.");
  expect(rows[0]!.textContent).toContain("Build");
  expect(rows[0]!.textContent).toContain("Version 5");
  expect(rows[0]!.textContent).toContain("Active");
  expect(rows[1]!.textContent).toContain("Waiting for a second person");
  expect(rows[2]!.textContent).toContain("Removed");
  expect(rows[3]!.textContent).toContain("Not applied");
  expect(rows[4]!.textContent).toContain("Saving");
  expect(screen.getAllByRole("button", { name: "Remove rule" })).toHaveLength(1);
  expect(within(rows[0]!).getByRole("button", { name: "Remove rule" })).toBeTruthy();
 });

 it("Remove sends the request id, then says which version removed it", async () => {
  const f = await open({ view: learningView({ suggestions: [], rules: [rule()] }), learn: request => request.method === "POST" ? ok({ outcome: "published", version: 6 }) : undefined });
  fireEvent.click(screen.getByRole("button", { name: "Added by suggestions (1)" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove rule" }));
  expect((await screen.findByRole("status")).textContent).toContain("Removed in version 6");
  const [write] = f.learningWrites();
  expect(write!.path).toBe(LEARNING_PATH + "/rules/rul_1/remove");
  expect(LearningRuleRemoveBodySchema.parse(write!.body).requestId).toMatch(/^[0-9a-f-]{36}$/u);
 });

 it("a rule edited by hand says so and takes the person to that stage's card", async () => {
  await open({ view: learningView({ suggestions: [], rules: [rule()] }), learn: request => request.method === "POST" ? ok({ outcome: "needs_editor", stage: "build" }) : undefined });
  fireEvent.click(screen.getByRole("button", { name: "Added by suggestions (1)" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove rule" }));
  expect(await screen.findByText("This rule was edited by hand. Remove it in the editor.")).toBeTruthy();
  await waitFor(() => expect(document.activeElement?.id).toBe("hww-stage-build-title"));
 });

 it("a removal that waits for a second person opens its confirmation", async () => {
  const f = await open({ view: learningView({ suggestions: [], rules: [rule({ stage: "review" })] }), learn: request => request.method === "POST" ? ok({ status: "NEEDS_CONFIRMATION", outcome: "awaiting_approval", confirmUrl: CONFIRM_URL, changes: [] }, 202) : undefined });
  fireEvent.click(screen.getByRole("button", { name: "Added by suggestions (1)" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove rule" }));
  await screen.findByText("Sent for confirmation: someone else who can approve changes in this project confirms it.");
  fireEvent.click(screen.getByRole("button", { name: "Open confirmation" }));
  expect(f.host.openExternal).toHaveBeenCalledWith(CONFIRM_URL);
 });

 it("a conflict on Remove talks about the rule, not a suggestion", async () => {
  await open({ view: learningView({ suggestions: [], rules: [rule()] }), learn: request => request.method === "POST" ? refuse("AGENT_REVISION_CONFLICT", "x") : undefined });
  fireEvent.click(screen.getByRole("button", { name: "Added by suggestions (1)" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove rule" }));
  await screen.findByText("This rule isn't in How we work any more. Reload and try again.");
  expect(screen.queryByText("This suggestion changed. Reload and try again.")).toBeNull();
 });

 it("shows a refusal of Remove", async () => {
  await open({ view: learningView({ suggestions: [], rules: [rule()] }), learn: request => request.method === "POST" ? refuse("LEARNING_LAYER_BUSY", "x") : undefined });
  fireEvent.click(screen.getByRole("button", { name: "Added by suggestions (1)" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove rule" }));
  await screen.findByText("Finish or discard the How we work draft or pending change first.");
 });

 it("shows no Remove to someone who cannot decide", async () => {
  await open({ view: learningView({ canDecide: false, suggestions: [], rules: [rule()] }) });
  fireEvent.click(screen.getByRole("button", { name: "Added by suggestions (1)" }));
  expect(screen.queryByRole("button", { name: "Remove rule" })).toBeNull();
 });
});

describe("with the How we work tab", () => {
 it("reads the suggestions again after a How we work publish", async () => {
  const f = await open({ handle: (request, url) => url.pathname.endsWith("/publish") ? ok({ agent: publishedAgent(), version: { version: 3 } }) : url.pathname === `/v1/app/agents/${LAYER}/diff` ? ok(diffBody(2, ["Changes the build instructions"], [], "draft")) : undefined });
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Review changes" }).disabled).toBe(false));
  const reads = f.learningReads();
  fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
  const dialog = await screen.findByRole("dialog", { name: "Review changes" });
  await within(dialog).findByText("Changes the build instructions");
  fireEvent.click(within(dialog).getByRole("button", { name: "Publish" }));
  await within(dialog).findByText(/Published as version 3/u);
  await waitFor(() => expect(f.learningReads()).toBe(reads + 1));
 });
});

describe("accessibility", () => {
 it("has no axe violations with every list open", async () => {
  const f = await open({ view: learningView({ suggestions: [suggestion({ allFromOnePerson: true, lessSafe: true, lessSafeWords: ["review"], overlaps: ["Keep changes small."] })], dismissed: [dismissed()], rules: [rule()] }) });
  fireEvent.click(screen.getByRole("button", { name: "Dismissed (1)" }));fireEvent.click(screen.getByRole("button", { name: "Added by suggestions (1)" }));fireEvent.click(screen.getByRole("button", { name: "Dismiss…" }));
  await expectNoAxeViolations(f.container);
 });
});

describe("opening How we work from the Home card's link", () => {
 const scrolled = vi.fn(), original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView")!;
 afterEach(() => { Object.defineProperty(HTMLElement.prototype, "scrollIntoView", original);scrolled.mockReset(); });
 const spy = () => { HTMLElement.prototype.scrollIntoView = function scroll(this: Element) { scrolled(this); }; };
 it("scrolls the Suggested rules heading into view and focuses it once, when there are open suggestions", async () => {
  spy();
  const f = await open();
  const heading = screen.getByRole("heading", { name: "Suggested rules (1)" });
  expect(heading.id).toBe("suggested-rules");
  await waitFor(() => expect(document.activeElement).toBe(heading));
  expect(scrolled).toHaveBeenCalledWith(heading);
  expect(scrolled).toHaveBeenCalledTimes(1);
  // A later read does not take the focus back.
  const other = screen.getByRole("button", { name: "Dismissed (0)" });other.focus();
  await f.query.invalidateQueries({ queryKey: ["learning"] });
  await waitFor(() => expect(f.learningReads()).toBeGreaterThan(1));
  expect(document.activeElement).toBe(other);
  expect(scrolled).toHaveBeenCalledTimes(1);
 });
 it("does nothing when there are no open suggestions", async () => {
  spy();
  await open({ view: learningView({ suggestions: [] }) });
  expect(document.activeElement?.id).not.toBe("suggested-rules");
  expect(scrolled).not.toHaveBeenCalled();
 });
 it("does not take the focus later when the person arrived with no open suggestions and one appears on a refetch", async () => {
  spy();
  const f = await open({ view: learningView({ suggestions: [] }) });
  expect(scrolled).not.toHaveBeenCalled();
  f.learning.view = learningView({ suggestions: [suggestion()] });
  const reads = f.learningReads();
  await f.query.invalidateQueries({ queryKey: ["learning"] });
  await screen.findByRole("heading", { name: "Suggested rules (1)" });
  await waitFor(() => expect(f.learningReads()).toBeGreaterThan(reads));
  expect(scrolled).not.toHaveBeenCalled();
  expect(document.activeElement?.id).not.toBe("suggested-rules");
 });
 it("does nothing when the person clicks the How we work tab from the overview", async () => {
  spy();
  setup({ path: "/app/projects/payments" });
  await userEvent.setup().click(await screen.findByRole("tab", { name: "How we work" }));
  const heading = await screen.findByRole("heading", { name: "Suggested rules (1)" });
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(document.activeElement).not.toBe(heading);
  expect(scrolled).not.toHaveBeenCalled();
 });
});
