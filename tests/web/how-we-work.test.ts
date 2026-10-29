// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { HOW_WE_WORK_REVIEWER_NOTE } from "@agentx/contracts/web";
import { ProjectScreen } from "../../packages/ui/src/screens/project/ProjectScreen.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { h } from "./support/h.js";
import { LAYER, diffBody, howWeWorkHost, howWeWorkView, publishedAgent, type Handler } from "./support/how-we-work-fixture.js";

const CONFIRM_URL = "https://cell.example/v1/app/approve/abc123";
function setup(options: { canEdit?: boolean; view?: unknown; overlay?: Record<string, unknown>; handle?: Handler; theme?: "light" | "dark" } = {}) {
 const cell = howWeWorkHost(options), query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: cell.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: ["/app/projects/payments?tab=how-we-work"], children: h(Announcer, { children: h(Routes, { children: h(Route, { path: "/app/projects/:name", element: h(ProjectScreen, {}) }) }) }) }) }) }), { theme: options.theme ?? "light" });
 return { ...cell, ...ui, query };
}
const card = (name: string) => screen.getByRole("region", { name });
const open = async (options: Parameters<typeof setup>[0] = {}) => { const world = setup(options);await screen.findByRole("heading", { name: "Build" });return world; };
const type = (label: string | RegExp, text: string, index = 0) => fireEvent.change(screen.getAllByRole("textbox", { name: label })[index]!, { target: { value: text } });

describe("the How we work tab", () => {
 it("is a tab of the project page that opens the stages", async () => {
  const f = setup();
  expect(await screen.findByRole("tab", { name: "How we work", selected: true })).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Overview" })).toBeTruthy();
  const stages = within(await screen.findByRole("list", { name: "Stages" })).getAllByRole("listitem").map(item => item.textContent);
  expect(stages[0]).toMatch(/^Plan/u);
  expect(stages.map(text => text?.replace(/ \(changed here\)/u, ""))).toEqual(["Plan", "Plan check", "Build", "Checks", "Review", "Pull request"]);
  expect(f.calls()).toContain("GET /v1/app/projects/payments/how-we-work");
 });

 it("marks every value: inherited, changed here, or locked by the company or by Rovara", async () => {
  await open();
  const plan = card("Plan"), markers = (name: string) => within(card(name)).getAllByText(/Inherited|Changed here|Locked by/u).map(item => `${item.getAttribute("data-marker")}:${item.textContent}`);
  expect(markers("Plan")).toEqual(expect.arrayContaining(["inherited:Inherited", "changed:Changed here", "locked:Locked by Rovara"]));
  expect(within(plan).getByText("Rovara plan guidance").parentElement?.querySelector("[data-marker]")?.textContent).toBe("Inherited");
  expect(within(plan).getByText("Keep changes small.").parentElement?.querySelector("[data-marker]")?.textContent).toBe("Changed here");
  expect(markers("Plan check")).toContain("locked:Locked by company");
  expect(within(card("Plan check")).getByText("Plan").parentElement?.querySelector("[data-marker]")?.getAttribute("data-marker")).toBe("locked");
  expect(card("Plan").querySelector("svg")).toBeTruthy();
 });

 it("shows only changed and locked rows by default, and the rest with Show unchanged settings", async () => {
  await open();
  const checks = card("Checks");
  expect(within(checks).queryByText("npm test")).toBeNull();
  expect(within(checks).getByText(/Nothing here is changed or locked/u)).toBeTruthy();
  expect(within(card("Build")).getByText("Run the linter.")).toBeTruthy();
  expect(within(card("Build")).queryByText("Who approves")).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: "Show unchanged settings" }));
  expect(within(checks).getByText("npm test")).toBeTruthy();
  expect(within(card("Build")).getByText("Who approves")).toBeTruthy();
 });

 it("filters: All, Changed here, Locked", async () => {
  await open();
  fireEvent.click(screen.getByRole("radio", { name: "Locked" }));
  expect(within(card("Plan")).getAllByText("Locked by Rovara").length).toBeGreaterThan(0);
  expect(within(card("Plan")).queryByText("Rovara plan guidance")).toBeNull();
  expect(within(card("Build")).queryByText("Run the linter.")).toBeNull();
  expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "Show unchanged settings" }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: "Changed here" }));
  expect(within(card("Build")).getAllByText("Run the linter.").length).toBeGreaterThan(0);
  expect(within(card("Plan")).getAllByText("Keep changes small.").length).toBeGreaterThan(0);
  expect(within(card("Plan")).queryByText("Rovara plan guidance")).not.toBeNull();
  expect(within(card("Plan check")).queryByText("Locked by company")).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: "All" }));
  expect(within(card("Plan check")).getByText("Locked by company")).toBeTruthy();
 });

 it("shows the reviewer note word for word on the stages that check work, from the view, and nowhere else", async () => {
  await open();
  expect(HOW_WE_WORK_REVIEWER_NOTE).toBe("Project rules apply to Understand, Plan and Build. Reviewers only follow rules written for them.");
  for (const name of ["Plan check", "Review"]) expect(within(card(name)).getByText(HOW_WE_WORK_REVIEWER_NOTE)).toBeTruthy();
  for (const name of ["Plan", "Build", "Checks"]) expect(within(card(name)).queryByText(HOW_WE_WORK_REVIEWER_NOTE)).toBeNull();
 });

 it("renders the note the server sent, not a copy of it", async () => {
  const view = howWeWorkView();
  (view.stages[1]!.knows as { note?: string }).note = "A different sentence from the server.";
  await open({ view });
  expect(within(card("Plan check")).getByText("A different sentence from the server.")).toBeTruthy();
  expect(screen.queryByText(HOW_WE_WORK_REVIEWER_NOTE, { exact: false })).not.toBeNull();
  expect(within(card("Plan check")).queryByText(HOW_WE_WORK_REVIEWER_NOTE)).toBeNull();
 });

 it("shows the model rows read only, with the note", async () => {
  await open();
  const build = card("Build");
  expect(within(build).getByText("anthropic/claude-sonnet-4-6")).toBeTruthy();
  expect(within(build).getByText("Model choice per stage is coming; today models come from the project's model settings.")).toBeTruthy();
  expect(within(build).queryByRole("combobox")).toBeNull();
 });

 it("shows text that came from people visibly, with hidden characters spelled out", async () => {
  const view = howWeWorkView();
  (view.stages[2]!.knows.instructions[0] as { value: string }).value = "Be kind‮ and careful";
  await open({ view });
  expect(within(card("Build")).getByText("Be kind[U+202E] and careful")).toBeTruthy();
 });

 it("gives a person who cannot edit settings no edit controls", async () => {
  await open({ canEdit: false });
  expect(screen.queryByRole("textbox")).toBeNull();
  for (const name of ["Save draft", "Review changes", /Roll back/u]) expect(screen.queryByRole("button", { name })).toBeNull();
  expect(screen.getByText("Keep changes small.", { selector: "li" })).toBeTruthy();
  await screen.findByRole("heading", { name: "Version 2 · Running now" });
  expect(screen.queryByRole("button", { name: /Roll back/u })).toBeNull();
 });

 it("gives a maintainer the project rules and a box for each stage that runs a model, prefilled from the draft", async () => {
  await open();
  await waitFor(() => expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Project rules" }).value).toBe("Keep changes small."));
  expect(screen.getAllByRole("textbox", { name: "Instructions for this stage" })).toHaveLength(4);
  await waitFor(() => expect(within(card("Build")).getByRole<HTMLTextAreaElement>("textbox", { name: "Instructions for this stage" }).value).toBe("Run the linter."));
  expect(within(card("Plan check")).getByText(/needs someone else who can approve changes in this project to confirm/u)).toBeTruthy();
  expect(within(card("Build")).queryByText(/needs someone else who can approve/u)).toBeNull();
  expect(within(card("Checks")).queryByRole("textbox")).toBeNull();
 });
});

describe("saving rules", () => {
 it("makes sure the process layer exists, reads its draft, then writes the draft", async () => {
  const f = await open();
  await waitFor(() => expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Project rules" }).value).toBe("Keep changes small."));
  const before = f.sent().length;
  type(/Project rules/u, "  Keep changes small. Add tests.  ");
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await screen.findByText("Draft saved. Review changes to publish it.");
  const writes = f.sent().slice(before);
  expect(writes.map(request => request.method + " " + request.path)).toEqual(["POST /v1/app/projects/payments/playbook/process", `PUT /v1/app/agents/${LAYER}/draft`]);
  expect(f.calls().slice(-2)).toEqual([`GET /v1/app/agents/${LAYER}/draft`, `PUT /v1/app/agents/${LAYER}/draft`]);
  expect(f.calls().lastIndexOf("POST /v1/app/projects/payments/playbook/process")).toBeLessThan(f.calls().lastIndexOf(`PUT /v1/app/agents/${LAYER}/draft`));
  expect(writes[1]!.body).toMatchObject({ overlay: { instructions: "Keep changes small. Add tests.", steps: { build: { instructions: "Run the linter." } } }, expectedRevision: 3 });
 });

 it("writes a stage's instructions to that stage and keeps the rest of the draft", async () => {
  const f = await open({ overlay: { instructions: "Keep changes small.", steps: { build: { instructions: "Run the linter.", timeoutMinutes: 30 } }, autonomy: "suggest" } });
  await waitFor(() => expect(within(card("Build")).getByRole<HTMLTextAreaElement>("textbox", { name: "Instructions for this stage" }).value).toBe("Run the linter."));
  fireEvent.change(within(card("Review")).getByRole("textbox", { name: "Instructions for this stage" }), { target: { value: "Check the tests too." } });
  fireEvent.change(within(card("Build")).getByRole("textbox", { name: "Instructions for this stage" }), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await screen.findByText("Draft saved. Review changes to publish it.");
  expect(f.sent().at(-1)!.body).toMatchObject({ overlay: { instructions: "Keep changes small.", autonomy: "suggest", steps: { build: { timeoutMinutes: 30 }, review: { instructions: "Check the tests too." } } } });
  expect((f.sent().at(-1)!.body as { overlay: { steps: { build: object } } }).overlay.steps.build).not.toHaveProperty("instructions");
 });

 it("removes hidden characters before sending, and refuses more than 4,000 characters", async () => {
  const f = await open({ overlay: {} });
  const save = screen.getByRole<HTMLButtonElement>("button", { name: "Save draft" });
  expect(save.disabled).toBe(true);
  type(/Project rules/u, "a".repeat(4001));
  expect(screen.getAllByText(/Use at most 4,000 characters/u).length).toBeGreaterThan(0);
  expect(save.disabled).toBe(true);
  type(/Project rules/u, "​ a".repeat(1) + "b".repeat(3998) + "‮ ");
  expect(save.disabled).toBe(false);
  fireEvent.click(save);
  await screen.findByText("Draft saved. Review changes to publish it.");
  expect((f.sent().at(-1)!.body as { overlay: { instructions: string } }).overlay.instructions).toBe("a" + "b".repeat(3998));
 });

 it("shows a save refusal and keeps what was typed", async () => {
  const f = await open({ handle: (request, url) => request.method === "PUT" && url.pathname.endsWith("/draft") ? { status: 400, body: { error: { code: "CONFIG_INVALID", message: "instructions: must be at most 4,000 characters" } } } : undefined });
  type(/Project rules/u, "New rule");
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  expect((await screen.findByRole("alert")).textContent).toContain("must be at most 4,000 characters");
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Project rules" }).value).toBe("New rule");
  expect(f.sent().some(request => request.path.endsWith("/publish"))).toBe(false);
 });
});

describe("review and publish", () => {
 const lessSafeDiff: Handler = (request, url) => url.pathname.endsWith("/diff") ? { status: 200, body: diffBody(2, ["Changes the review instructions"], ["Changes the instructions of the review step \"Review\""]) } : undefined;
 const publish = async () => { fireEvent.click(await screen.findByRole("button", { name: "Review changes" })); const dialog = await screen.findByRole("dialog", { name: "Review changes" });await within(dialog).findByText("What changes");return dialog; };

 it("opens a dialog with the plain-language change and the less-safe reasons", async () => {
  await open({ handle: lessSafeDiff });
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Review changes" }).disabled).toBe(false));
  const dialog = await publish();
  expect(within(within(dialog).getByRole("region", { name: "What changes" })).getByText("Changes the review instructions")).toBeTruthy();
  const reasons = within(dialog).getByRole("region", { name: "Needs someone else to confirm" });
  expect(within(reasons).getByText('Changes the instructions of the review step "Review"')).toBeTruthy();
 });

 it("disables Review changes while edits are unsaved", async () => {
  await open();
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Review changes" }).disabled).toBe(false));
  type(/Project rules/u, "Something new");
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Review changes" }).disabled).toBe(true);
  expect(screen.getByText(/aren't saved/u)).toBeTruthy();
 });

 it("says when a publish applied: the version, and that running tasks keep theirs", async () => {
  const f = await open({ handle: (request, url) => url.pathname.endsWith("/publish") ? { status: 200, body: { agent: publishedAgent(), version: { version: 3 } } } : undefined });
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Review changes" }).disabled).toBe(false));
  const dialog = await publish();
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Version note" }), { target: { value: "More rules" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Publish" }));
  expect((await within(dialog).findByRole("status")).textContent).toBe("Published as version 3. New tasks use it; running tasks keep their version.");
  const publishRequest = f.sent().find(request => request.path.endsWith("/publish"))!;
  expect(publishRequest.path).toBe(`/v1/app/agents/${LAYER}/publish`);
  expect(publishRequest.body).toMatchObject({ expectedRevision: 3, note: "More rules" });
  expect(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Publish" }).disabled).toBe(true);
 });

 it("says when a publish was sent for confirmation, with the confirm link, and does not claim it is live", async () => {
  const f = await open({ handle: (request, url) => url.pathname.endsWith("/publish") ? { status: 202, body: { status: "NEEDS_CONFIRMATION", code: "REAUTH_REQUIRED", confirmUrl: CONFIRM_URL, changes: ["Changes the instructions of the review step \"Review\""] } } : undefined });
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Review changes" }).disabled).toBe(false));
  const dialog = await publish();
  fireEvent.click(within(dialog).getByRole("button", { name: "Publish" }));
  const status = await within(dialog).findByText("Sent for confirmation: someone else who can approve changes in this project confirms it.");
  expect(status).toBeTruthy();
  expect(within(dialog).queryByText(/Published as version/u)).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Open confirmation" }));
  expect(f.host.openExternal).toHaveBeenCalledWith(CONFIRM_URL);
  expect(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Publish" }).disabled).toBe(true);
 });

 it("shows a refused publish and lets the person try again", async () => {
  let refuse = true;
  await open({ handle: (request, url) => url.pathname.endsWith("/publish") ? refuse ? { status: 400, body: { error: { code: "CONFIG_INVALID", message: "The draft has a problem." } } } : { status: 200, body: { agent: publishedAgent(), version: { version: 3 } } } : undefined });
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Review changes" }).disabled).toBe(false));
  const dialog = await publish();
  fireEvent.click(within(dialog).getByRole("button", { name: "Publish" }));
  expect((await within(dialog).findByRole("alert")).textContent).toContain("The draft has a problem.");
  refuse = false;
  fireEvent.click(within(dialog).getByRole("button", { name: "Publish" }));
  await within(dialog).findByText(/Published as version 3/u);
 });
});

describe("history and rollback", () => {
 it("lists the versions with who, when, note and the less-safe flag", async () => {
  await open();
  const history = await screen.findByRole("region", { name: "History" });
  await within(history).findByRole("heading", { name: "Version 2 · Running now" });
  const versions = within(history).getAllByRole("listitem");
  expect(versions[0]!.textContent).toContain("Added build rules");
  await waitFor(() => expect(versions[0]!.textContent).toContain("By Priya"));
  expect(versions[0]!.textContent).not.toContain("Less-safe change");
  expect(versions[1]!.textContent).toContain("First rules");
  expect(versions[1]!.textContent).toContain("Less-safe change");
  expect(within(versions[0]!).queryByRole("button", { name: /Roll back/u })).toBeNull();
 });

 it("rolls back through the existing route and says so", async () => {
  const f = await open({ handle: (request, url) => url.pathname.endsWith("/rollback") ? { status: 200, body: { agent: { ...publishedAgent(), currentVersion: 1 } } } : undefined });
  fireEvent.click(await screen.findByRole("button", { name: "Roll back to version 1" }));
  const dialog = await screen.findByRole("dialog", { name: "Roll back to version 1" });
  await within(dialog).findByText("What will change");
  fireEvent.click(within(dialog).getByRole("button", { name: "Roll back" }));
  expect((await within(dialog).findByRole("status")).textContent).toBe("Rolled back to version 1. New tasks use it; running tasks keep their version.");
  const request = f.sent().find(item => item.path.endsWith("/rollback"))!;
  expect(request.path).toBe(`/v1/app/agents/${LAYER}/rollback`);
  expect(request.body).toMatchObject({ version: 1 });
 });

 it("sends a less-safe rollback to confirmation the same way", async () => {
  await open({ handle: (request, url) => url.pathname.endsWith("/rollback") ? { status: 202, body: { status: "NEEDS_CONFIRMATION", code: "REAUTH_REQUIRED", confirmUrl: CONFIRM_URL, changes: ["Moves the review step \"Review\" to a weaker model"] } } : undefined });
  fireEvent.click(await screen.findByRole("button", { name: "Roll back to version 1" }));
  const dialog = await screen.findByRole("dialog", { name: "Roll back to version 1" });
  await within(dialog).findByText("What will change");
  fireEvent.click(within(dialog).getByRole("button", { name: "Roll back" }));
  await within(dialog).findByText("Sent for confirmation: someone else who can approve changes in this project confirms it.");
  expect(within(dialog).queryByText(/Rolled back to version/u)).toBeNull();
 });

 it("returns focus to the rollback button when its dialog closes", async () => {
  await open();
  const button = await screen.findByRole("button", { name: "Roll back to version 1" });
  button.focus();
  fireEvent.click(button);
  const dialog = await screen.findByRole("dialog", { name: "Roll back to version 1" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Close dialog" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Roll back to version 1" }));
 });
});

describe("publishing more than once", () => {
 const okPublish: Handler = (request, url) => url.pathname.endsWith("/publish") ? { status: 200, body: { agent: publishedAgent(), version: { version: 3 } } } : undefined;
 const edit = async (text: string) => { type(/Project rules/u, text);fireEvent.click(screen.getByRole("button", { name: "Save draft" }));await screen.findByText("Draft saved. Review changes to publish it."); };
 const reopen = async () => { await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Review changes" }).disabled).toBe(false));fireEvent.click(screen.getByRole("button", { name: "Review changes" }));return screen.findByRole("dialog", { name: "Review changes" }); };

 it("offers Publish again, with no old result, after a publish and a new saved edit", async () => {
  await open({ handle: okPublish });
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Review changes" }).disabled).toBe(false));
  let dialog = await reopen();
  await waitFor(() => expect(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Publish" }).disabled).toBe(false));
  fireEvent.click(within(dialog).getByRole("button", { name: "Publish" }));
  await within(dialog).findByText(/Published as version 3/u);
  fireEvent.click(within(dialog).getByRole("button", { name: "Close dialog" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await edit("A second rule");
  dialog = await reopen();
  expect(within(dialog).queryByText(/Published as version/u)).toBeNull();
  await waitFor(() => expect(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Publish" }).disabled).toBe(false));
  expect(within(dialog).getByRole<HTMLTextAreaElement>("textbox", { name: "Version note" }).disabled).toBe(false);
 });

 it("offers Publish again, with no old waiting message, after a publish that was sent for confirmation", async () => {
  await open({ handle: (request, url) => url.pathname.endsWith("/publish") ? { status: 202, body: { status: "NEEDS_CONFIRMATION", code: "REAUTH_REQUIRED", confirmUrl: CONFIRM_URL, changes: ["Changes the instructions of the review step \"Review\""] } } : undefined });
  let dialog = await reopen();
  await waitFor(() => expect(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Publish" }).disabled).toBe(false));
  fireEvent.click(within(dialog).getByRole("button", { name: "Publish" }));
  await within(dialog).findByText(/Sent for confirmation/u);
  fireEvent.click(within(dialog).getByRole("button", { name: "Close dialog" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await edit("Another rule");
  dialog = await reopen();
  expect(within(dialog).queryByText(/Sent for confirmation/u)).toBeNull();
  await waitFor(() => expect(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Publish" }).disabled).toBe(false));
 });
});

describe("a project that still runs the built-in process", () => {
 const withDraftLayer = () => howWeWorkView({ process: { kind: "builtin", agentId: "rovara-code", draftLayer: { agentId: LAYER, draftRevision: 3 } }, rules: [] });
 it("finds a saved first draft after a reload: the boxes show it and Review changes opens, without creating anything", async () => {
  const f = await open({ view: withDraftLayer(), overlay: { instructions: "Saved before the reload", steps: { build: { instructions: "Saved build rule" } } }, handle: (request, url) => url.pathname.endsWith("/diff") ? { status: 200, body: diffBody("base", ["Changes the project rules"], [], "draft") } : undefined });
  await waitFor(() => expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Project rules" }).value).toBe("Saved before the reload"));
  await waitFor(() => expect(within(card("Build")).getByRole<HTMLTextAreaElement>("textbox", { name: "Instructions for this stage" }).value).toBe("Saved build rule"));
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Review changes" }).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
  const dialog = await screen.findByRole("dialog", { name: "Review changes" });
  await within(dialog).findByText("What changes");
  expect(f.calls().some(call => call.endsWith("/diff"))).toBe(true);
  expect(f.sent()).toEqual([]);
 });

 const builtin = () => howWeWorkView({ process: { kind: "builtin", agentId: "rovara-code" }, rules: [] });
 it("shows an empty history and sends the first save through the ensure call", async () => {
  const f = await open({ view: builtin(), overlay: {} });
  expect(screen.getByText(/No versions yet/u)).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Review changes" }).disabled).toBe(true);
  type(/Project rules/u, "First rule");
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await screen.findByText("Draft saved. Review changes to publish it.");
  expect(f.sent().map(request => request.method + " " + request.path)).toEqual(["POST /v1/app/projects/payments/playbook/process", `PUT /v1/app/agents/${LAYER}/draft`]);
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Review changes" }).disabled).toBe(false));
  expect(f.calls().some(call => call.endsWith("/diff"))).toBe(false);
 });
});

describe("a project that runs the built-in while its How we work layer has saved versions (final review I3)", () => {
 const savedVersion = () => howWeWorkView({ process: { kind: "builtin", agentId: "rovara-code", draftLayer: { agentId: LAYER, draftRevision: 3, currentVersion: 2 } }, rules: [] });
 const playbookPut: Handler = (request, url) => url.pathname === "/v1/app/projects/payments/playbook" && request.method === "PUT" ? { status: 200, body: { playbook: { revision: 2, defaultProcess: { kind: "project_process", agentId: LAYER } } } } : undefined;
 it("says plainly that the project runs Rovara Code's defaults, and lists the saved versions as not in use", async () => {
  await open({ view: savedVersion(), handle: playbookPut });
  const notice = screen.getByRole("region", { name: "Saved version" });
  expect(notice.textContent).toContain("This project runs Rovara Code's defaults.");
  expect(notice.textContent).toContain("A saved How we work version exists (version 2).");
  expect(within(notice).getByRole("button", { name: "Use it" })).toBeTruthy();
  expect(await screen.findByRole("heading", { name: "Version 2 · Saved, not in use" })).toBeTruthy();
  expect(screen.queryByText(/No versions yet/u)).toBeNull();
  expect(screen.queryByText(/Running now/u)).toBeNull();
 });
 it("Use it makes the saved version the project's default through the playbook, under the revision it read", async () => {
  const f = await open({ view: savedVersion(), handle: playbookPut });
  const reads = f.calls().filter(call => call === "GET /v1/app/projects/payments/how-we-work").length;
  fireEvent.click(within(screen.getByRole("region", { name: "Saved version" })).getByRole("button", { name: "Use it" }));
  await waitFor(() => expect(f.sent().map(request => request.method + " " + request.path)).toEqual(["PUT /v1/app/projects/payments/playbook"]));
  expect(f.sent()[0]!.body).toEqual({ expectedRevision: 1, defaultProcess: { kind: "project_process", agentId: LAYER } });
  await waitFor(() => expect(f.calls().filter(call => call === "GET /v1/app/projects/payments/how-we-work").length).toBeGreaterThan(reads));
 });
 it("shows a refused Use it, and leaves the project as it was", async () => {
  await open({ view: savedVersion(), handle: (request, url) => url.pathname === "/v1/app/projects/payments/playbook" ? { status: 409, body: { error: { code: "PLAYBOOK_STALE", message: "Someone else changed how this project works. Reload and try again." } } } : undefined });
  fireEvent.click(screen.getByRole("button", { name: "Use it" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/Reload and try again|Couldn't/u);
 });
 it("Review changes compares the draft with the saved version and says publishing does not switch the project", async () => {
  const f = await open({ view: savedVersion(), handle: playbookPut });
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Review changes" }).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
  const dialog = await screen.findByRole("dialog", { name: "Review changes" });
  await within(dialog).findByText("What changes");
  expect(dialog.textContent).toContain("This project runs Rovara Code's defaults. Publishing saves a new version but does not switch the project to it.");
  expect(dialog.textContent).not.toContain("Publishing changes how new tasks work");
  const diffs = f.request.mock.calls.map(([request]) => request.path).filter(path => path.includes("/diff"));
  expect(diffs.length).toBeGreaterThan(0);
  for (const path of diffs) expect(new URL(path, "https://cell.example").searchParams.get("from")).toBe("2");
 });
 it("a viewer sees the same words without Use it", async () => {
  await open({ view: savedVersion(), canEdit: false });
  const notice = screen.getByRole("region", { name: "Saved version" });
  expect(notice.textContent).toContain("This project runs Rovara Code's defaults.");
  expect(within(notice).queryByRole("button", { name: "Use it" })).toBeNull();
 });
});

for (const theme of ["light", "dark"] as const) it("has no accessibility violations in " + theme, async () => {
 const f = await open({ theme });
 await waitFor(() => expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Project rules" }).value).toBe("Keep changes small."));
 await screen.findByRole("heading", { name: "Version 2 · Running now" });
 await expectNoAxeViolations(f.container);
});

describe("the pull request stage", () => {
 const UNUSED = "Rules for this stage aren't used yet.";
 it("shows rules written there read-only, with the line that they aren't used yet, and no box for them", async () => {
  const view = howWeWorkView();
  (view.stages[5]!.knows.instructions as unknown[]).push({ value: "Mention the ticket.", source: "project", locked: false });
  await open({ view });
  await waitFor(() => expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Project rules" }).value).toBe("Keep changes small."));
  const pull = card("Pull request");
  expect(within(pull).getByText("Mention the ticket.")).toBeTruthy();
  expect(within(pull).getByText(UNUSED)).toBeTruthy();
  expect(within(pull).queryByRole("textbox")).toBeNull();
  for (const name of ["Plan", "Plan check", "Build", "Review"]) {
   expect(within(card(name)).queryByText(UNUSED)).toBeNull();
   expect(within(card(name)).getByRole("textbox", { name: "Instructions for this stage" })).toBeTruthy();
  }
  expect(within(card("Checks")).queryByText(UNUSED)).toBeNull();
 });

 it("says so even when nothing is written there", async () => {
  await open();
  expect(within(card("Pull request")).getByText(UNUSED)).toBeTruthy();
  expect(within(card("Pull request")).queryByRole("textbox")).toBeNull();
 });
});
