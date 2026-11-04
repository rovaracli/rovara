// @vitest-environment jsdom
// T5: the Sources tab for a person who may edit sources: add, change and remove (T9: every change applies at once; nothing waits for a second person). The server decides every rule; these tests hold what the screen shows and sends.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { SourceWriteBodySchema } from "@agentx/contracts/web";
import { adminRow, adminView, flat, wrapped } from "./support/sources-fixture.js";
import { openSources } from "./support/sources-render.js";
import { expectNoAxeViolations } from "./support/axe.js";

const chunk = vi.hoisted(() => ({ loads: 0 }));
vi.mock("../../packages/ui/src/screens/project/lessons/SourcesAdmin.js", async importOriginal => { chunk.loads += 1;return await importOriginal(); });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const row = (name: RegExp) => screen.getByRole("region", { name });
const pick = (label: string, value: string, scope: HTMLElement = document.body) => fireEvent.change(within(scope).getByLabelText(label), { target: { value } });
const optionsOf = (label: string, scope: HTMLElement = document.body) => within(scope).getByLabelText<HTMLSelectElement>(label).options;
const values = (options: HTMLOptionsCollection) => [...options].map(option => option.value).filter(value => value !== "");
const openEditor = async (options: Parameters<typeof openSources>[0] = {}) => { const f = openSources(options);await screen.findByRole("heading", { name: "Add a source" });return f; };

describe("an editor's Sources tab", () => {
 it("loads the editing screen as its own chunk and shows each source with its controls, the unlinked-author line, and the fixed words for a lowered retention", async () => {
  const f = await openEditor({ view: adminView({ skippedUnlinked: { github: 4 }, sources: [adminRow({ exclude: ["U1", "U2"], excluded: 2 })] }) });
  expect(chunk.loads).toBeGreaterThan(0);
  const github = row(/GitHub github:repo\/9/u);
  expect(within(github).getByText("4 items weren't kept because their author isn't linked to a Rovara person.")).toBeTruthy();
  expect(within(github).getByLabelText<HTMLSelectElement>("How long Rovara keeps it").value).toBe("C");
  expect(within(github).getByLabelText<HTMLSelectElement>("Who sees it").value).toBe("project");
  expect(within(github).getByLabelText<HTMLTextAreaElement>("Ids to leave out").value).toBe("U1\nU2");
  expect(within(github).getByRole("switch", { name: "On" }).getAttribute("aria-checked")).toBe("true");
  expect(f.recordReads().length).toBeGreaterThan(0);
 });
 it("offers retention only from what the server lists for that kind", async () => {
  await openEditor({ view: adminView({ offered: { github: ["A", "B"], rovara: ["B"], slack: ["A"], linear: ["A"], jira: ["A"] } }) });
  expect(values(optionsOf("How long Rovara keeps it", row(/GitHub/u)))).toEqual(["A", "B"]);
  pick("What to add", "slack");
  expect(values(optionsOf("How long Rovara keeps it", screen.getByRole("region", { name: "Add a source" })))).toEqual(["A"]);
  pick("What to add", "rovara");
  expect(values(optionsOf("How long Rovara keeps it", screen.getByRole("region", { name: "Add a source" })))).toEqual(["B"]);
 });
 it("offers a kind only when the server offers it a retention, a repository only from the project's own list, and the Rovara row only once", async () => {
  await openEditor({ view: adminView({ offered: { github: ["A", "B"], rovara: ["A"], slack: [], linear: ["A"], jira: [] }, sources: [adminRow({ kind: "rovara", scope: "rovara:project/payments" })], repositories: [{ name: "payments-api", scope: "github:repo/9" }, { name: "web-app", scope: "github:repo/12" }] }) });
  expect(values(optionsOf("What to add"))).toEqual(["repository", "linear"]);
  pick("What to add", "repository");
  expect(values(optionsOf("Repository", screen.getByRole("region", { name: "Add a source" })))).toEqual(["github:repo/9", "github:repo/12"]);
 });
 it("the add button stays off until a place and a retention are chosen", async () => {
  await openEditor();
  const add = screen.getByRole("button", { name: "Add source" });
  expect((add as HTMLButtonElement).disabled).toBe(true);
  pick("What to add", "repository");
  pick("Repository", "github:repo/12");
  expect((add as HTMLButtonElement).disabled).toBe(true);
  pick("How long Rovara keeps it", "B", screen.getByRole("region", { name: "Add a source" }));
  expect((add as HTMLButtonElement).disabled).toBe(false);
 });
});

describe("adding a source", () => {
 it("shows a repository name with its hidden control characters spelled out", async () => {
  await openEditor({ view: adminView({ sources: [], repositories: [{ name: "pay\u202Ements", scope: "github:repo/9" }] }) });
  pick("What to add", "repository");
  const labels = [...optionsOf("Repository", screen.getByRole("region", { name: "Add a source" }))].map(option => option.textContent);
  expect(labels).toContain("pay[U+202E]ments");
 });
 it("sends a repository add with the place the server listed, a fresh request id, and reads the sources again", async () => {
  const f = await openEditor();
  const reads = f.recordReads().length, form = screen.getByRole("region", { name: "Add a source" });
  pick("What to add", "repository");
  pick("Repository", "github:repo/12");
  pick("How long Rovara keeps it", "D", form);
  pick("Who sees it", "maintainers", form);
  fireEvent.click(within(form).getByRole("button", { name: "Add source" }));
  expect(await screen.findByText("Source added.")).toBeTruthy();
  expect(f.posts).toHaveLength(1);
  expect(f.posts[0]).toEqual({ action: "add", requestId: expect.stringMatching(UUID) as string, source: "github", scope: "github:repo/12", retention: "D", audienceDefault: "maintainers", enabled: true });
  expect(f.recordReads().length).toBeGreaterThan(reads);
  // A second add is a new request.
  pick("What to add", "repository");
  pick("Repository", "github:repo/12");
  pick("How long Rovara keeps it", "D", form);
  fireEvent.click(within(form).getByRole("button", { name: "Add source" }));
  await waitFor(() => { expect(f.posts).toHaveLength(2); });
  expect(f.posts[1]!.requestId).not.toBe(f.posts[0]!.requestId);
 });
 it("adds the Rovara row with its own place, and shows that its audience follows each task's visibility instead of offering it", async () => {
  const f = await openEditor({ view: adminView({ sources: [] }) });
  const form = screen.getByRole("region", { name: "Add a source" });
  pick("What to add", "rovara");
  expect(within(form).queryByLabelText("Who sees it")).toBeNull();
  expect(within(form).getByText("Who sees it: follows each task's visibility")).toBeTruthy();
  pick("How long Rovara keeps it", "C", form);
  fireEvent.click(within(form).getByRole("button", { name: "Add source" }));
  await waitFor(() => { expect(f.posts).toHaveLength(1); });
  expect(f.posts[0]).toMatchObject({ action: "add", source: "rovara", scope: "rovara:project/payments", retention: "C" });
 });
 it("adds a Slack channel by the place typed and says it was added at once (T9: no second person), without calling the channel public or private itself", async () => {
  const f = await openEditor();
  const form = screen.getByRole("region", { name: "Add a source" });
  pick("What to add", "slack");
  fireEvent.change(await within(form).findByLabelText("Slack channel"), { target: { value: "  slack:T1/C9  " } });
  expect(within(form).getByText(/To get a link: in Slack, right-click the channel and choose Copy link\./u)).toBeTruthy();
  pick("How long Rovara keeps it", "B", form);
  fireEvent.click(within(form).getByRole("button", { name: "Add source" }));
  expect(await screen.findByText("Source added.")).toBeTruthy();
  expect(f.posts[0]).toEqual({ action: "add", requestId: expect.stringMatching(UUID) as string, source: "slack", scope: "slack:T1/C9", retention: "B", audienceDefault: "maintainers", enabled: true });
  expect(document.body.textContent).not.toMatch(/\b(public|private)\b|second person|waiting/iu);
 });
 it("says what the server's refusal means in fixed words: a source that cannot be used, a kind not yet supported, unavailable", async () => {
  let answer = flat("SOURCE_NOT_ALLOWED", "Direct messages can't be a source in Public.", 422);
  const f = await openEditor({ write: () => answer });
  const form = screen.getByRole("region", { name: "Add a source" });
  pick("What to add", "slack");
  fireEvent.change(await within(form).findByLabelText("Slack channel"), { target: { value: "slack:T1/D3" } });
  pick("How long Rovara keeps it", "A", form);
  const send = () => fireEvent.click(within(form).getByRole("button", { name: "Add source" }));
  send();
  expect(await within(form).findByText("That source can't be used here.")).toBeTruthy();
  expect(document.body.textContent).not.toContain("Direct messages");
  answer = flat("SOURCE_KIND_NOT_YET", "That kind of source can't be added yet.", 422);
  send();
  expect(await within(form).findByText("That kind of source can't be added yet.")).toBeTruthy();
  answer = wrapped("RUNTIME_UNAVAILABLE", "slack said: token abc", 503);
  send();
  expect(await within(form).findByText("Rovara can't check that right now. Try again shortly.")).toBeTruthy();
  answer = wrapped("FORBIDDEN", "secret reason", 403);
  send();
  expect(await within(form).findByText("You can't change the sources of this project.")).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/secret reason|token abc/u);
  expect(f.posts.length).toBe(4);
 });
});

describe("changing a source", () => {
 it("sends only what changed, with the revision it read; a lowered retention says it applies to new items and the save says so too", async () => {
  const f = await openEditor();
  const github = row(/GitHub/u);
  pick("How long Rovara keeps it", "B", github);
  expect(within(github).getByText("Applies to new items; items already kept leave when they expire.")).toBeTruthy();
  fireEvent.click(within(github).getByRole("button", { name: "Save changes" }));
  expect(await screen.findByText("Saved. Applies to new items; items already kept leave when they expire.")).toBeTruthy();
  expect(f.posts[0]).toEqual({ action: "change", requestId: expect.stringMatching(UUID) as string, source: "github", scope: "github:repo/9", expectedRevision: 3, retention: "B" });
 });
 it("a raised retention carries no lowered-retention line", async () => {
  await openEditor({ view: adminView({ sources: [adminRow({ retention: "B" })] }) });
  pick("How long Rovara keeps it", "D", row(/GitHub/u));
  expect(screen.queryByText("Applies to new items; items already kept leave when they expire.")).toBeNull();
 });
 it("changes who sees it, on or off and the exclude list in one change", async () => {
  const f = await openEditor();
  const github = row(/GitHub/u);
  pick("Who sees it", "maintainers", github);
  fireEvent.click(within(github).getByRole("switch", { name: "On" }));
  fireEvent.change(within(github).getByLabelText("Ids to leave out"), { target: { value: " U7 \n\nU8\nU7\n" } });
  fireEvent.click(within(github).getByRole("button", { name: "Save changes" }));
  await waitFor(() => { expect(f.posts).toHaveLength(1); });
  expect(SourceWriteBodySchema.parse(f.posts[0])).toMatchObject({ action: "change", audienceDefault: "maintainers", enabled: false, exclude: ["U7", "U8"], expectedRevision: 3 });
  expect(f.posts[0]).not.toHaveProperty("retention");
 });
 it("keeps Save off until something changed and refuses a list that is too long without asking the server", async () => {
  const f = await openEditor();
  const github = row(/GitHub/u), save = within(github).getByRole("button", { name: "Save changes" });
  expect(save).toHaveProperty("disabled", true);
  fireEvent.change(within(github).getByLabelText("Ids to leave out"), { target: { value: "x".repeat(301) } });
  fireEvent.click(save);
  expect(await within(github).findByText("Leave out at most 200 ids, each at most 300 characters.")).toBeTruthy();
  expect(f.posts).toHaveLength(0);
 });
 it("the Rovara row shows that its audience follows each task's visibility and has no audience control; a change never names one", async () => {
  const f = await openEditor({ view: adminView({ sources: [adminRow({ kind: "rovara", scope: "rovara:project/payments", audience: "maintainers" })] }) });
  const rovara = row(/Rovara rovara:project\/payments/u);
  expect(within(rovara).getByText("Who sees it: follows each task's visibility")).toBeTruthy();
  expect(within(rovara).queryByLabelText("Who sees it")).toBeNull();
  fireEvent.click(within(rovara).getByRole("switch", { name: "On" }));
  fireEvent.click(within(rovara).getByRole("button", { name: "Save changes" }));
  await waitFor(() => { expect(f.posts).toHaveLength(1); });
  expect(f.posts[0]).not.toHaveProperty("audienceDefault");
 });
 it("says someone changed the source meanwhile, in fixed words, and reads the sources again", async () => {
  const f = await openEditor({ write: () => wrapped("CHANGE_STALE", "Row moved at 12:01 by someone", 409) });
  const reads = f.recordReads().length, github = row(/GitHub/u);
  fireEvent.click(within(github).getByRole("switch", { name: "On" }));
  fireEvent.click(within(github).getByRole("button", { name: "Save changes" }));
  expect(await within(github).findByText("Someone changed this source meanwhile. Reload and try again.")).toBeTruthy();
  expect(document.body.textContent).not.toContain("12:01");
  await waitFor(() => { expect(f.recordReads().length).toBeGreaterThan(reads); });
 });
 it("a raised retention is saved at once: the screen says Saved and offers no waiting card, no Approve and no Reject (T9)", async () => {
  const f = await openEditor();
  pick("How long Rovara keeps it", "D", row(/GitHub/u));
  fireEvent.click(within(row(/GitHub/u)).getByRole("button", { name: "Save changes" }));
  expect(await screen.findByText("Saved.")).toBeTruthy();
  expect(f.posts[0]).toMatchObject({ action: "change", retention: "D", expectedRevision: 3 });
  expect(document.body.textContent).not.toMatch(/second person|waiting|Approve|Reject/iu);
  expect(screen.queryByRole("button", { name: /Approve|Reject/u })).toBeNull();
 });
});

describe("removing a source", () => {
 it("asks in the page first (no browser dialog), sends nothing on Keep it, and sends the remove with the revision on Yes", async () => {
  const dialogs = [vi.spyOn(window, "confirm"), vi.spyOn(window, "alert"), vi.spyOn(window, "prompt")];
  const f = await openEditor();
  const github = row(/GitHub/u);
  fireEvent.click(within(github).getByRole("button", { name: "Remove" }));
  expect(within(github).getByText(/Remove this source\?/u)).toBeTruthy();
  fireEvent.click(within(github).getByRole("button", { name: "Keep it" }));
  expect(within(github).queryByText(/Remove this source\?/u)).toBeNull();
  expect(f.posts).toHaveLength(0);
  fireEvent.click(within(github).getByRole("button", { name: "Remove" }));
  f.state.view = adminView({ sources: [] });
  fireEvent.click(within(github).getByRole("button", { name: "Yes, remove it" }));
  expect(await screen.findByText("Source removed.")).toBeTruthy();
  expect(f.posts[0]).toEqual({ action: "remove", requestId: expect.stringMatching(UUID) as string, source: "github", scope: "github:repo/9", expectedRevision: 3 });
  for (const dialog of dialogs) expect(dialog).not.toHaveBeenCalled();
  await waitFor(() => { expect(screen.queryByRole("region", { name: /GitHub/u })).toBeNull(); });
 });
 it("says a place another project removed is still being cleared, in neutral words that do not say this project removed it (never the server's text)", async () => {
  await openEditor({ write: () => flat("SOURCE_CLEARING", "server words that must not show", 409) });
  const github = row(/GitHub/u);
  fireEvent.click(within(github).getByRole("button", { name: "Remove" }));
  fireEvent.click(within(github).getByRole("button", { name: "Yes, remove it" }));
  expect(await within(github).findByText("This source is still being cleared after a recent removal. You can add it again in about an hour.")).toBeTruthy();
  expect(document.body.textContent).not.toContain("server words that must not show");
  expect(document.body.textContent).not.toMatch(/just removed/u);
 });
 it("says the source was just removed and is still being deleted, in the UI's fixed sentence (never the server's text), when a flat refusal says so", async () => {
  await openEditor({ write: () => flat("SOURCE_REMOVAL_RUNNING", "server words that must not show", 409) });
  const github = row(/GitHub/u);
  fireEvent.click(within(github).getByRole("button", { name: "Remove" }));
  fireEvent.click(within(github).getByRole("button", { name: "Yes, remove it" }));
  expect(await within(github).findByText("This source was just removed and its stored data is still being deleted. You can add it again in about an hour.")).toBeTruthy();
  expect(document.body.textContent).not.toContain("server words that must not show");
  expect(document.body.textContent).not.toMatch(/\bcleared\b/u);
 });
});

describe("T9: no second person on the screen", () => {
 it("a view from an older server that still carries waiting changes shows none of them: no card, no Approve, no sign-in-again line", async () => {
  await openEditor({ view: { ...adminView(), pending: [{ changeId: "chg-one", source: "slack", scope: "slack:T1/C9", kind: "add", reasons: ["private_channel"], proposedByYou: false, expiresAt: new Date(Date.now() + 86_400_000).toISOString() }], soleApprover: false } });
  expect(screen.queryByRole("region", { name: /Waiting/u })).toBeNull();
  expect(screen.queryByRole("button", { name: /Approve|Reject|Sign in again/u })).toBeNull();
  expect(document.body.textContent).not.toMatch(/second person|waiting for approval/iu);
 });
 it("a refusal that asks for a fresh sign-in is no longer a source answer: it gets the generic sentence and no sign-in button", async () => {
  await openEditor({ write: () => wrapped("REAUTH_REQUIRED", "Sign in again (server text).", 403) });
  const github = row(/GitHub/u);
  fireEvent.click(within(github).getByRole("switch", { name: "On" }));
  fireEvent.click(within(github).getByRole("button", { name: "Save changes" }));
  expect(await within(github).findByText("Couldn't save that. Try again.")).toBeTruthy();
  expect(within(github).queryByRole("button", { name: "Sign in again" })).toBeNull();
  expect(document.body.textContent).not.toContain("server text");
 });
});

describe("T9: the Public edition's notes-with-links switch", () => {
 const NOTE = "Rovara keeps short notes with links to the messages, never the messages themselves. See Slack's API terms.";
 const noteIn = (scope: HTMLElement) => within(scope).queryByText((_, element) => element?.tagName === "P" && element.textContent === NOTE);
 const publicView = (over: Record<string, unknown> = {}) => adminView({ notesSwitch: true, offered: { github: ["A", "B", "C", "D"], rovara: ["A", "B", "C", "D"], slack: ["A", "B"], linear: ["A", "B", "C"], jira: ["A", "B", "C"], codehost: ["A", "B", "C", "D"], mcp: ["A"] }, ...over });
 const slackRow = (over: Record<string, unknown> = {}) => adminRow({ kind: "slack", scope: "slack:T1/C9", retention: "A", ...over });
 const slackRegion = () => row(/Slack slack:T1\/C9/u);

 it("adds a Slack channel with the switch off: retention A (read live only), and no notesOptIn in the body", async () => {
  const f = await openEditor({ view: publicView({ sources: [] }) });
  const form = screen.getByRole("region", { name: "Add a source" });
  pick("What to add", "slack");
  fireEvent.change(await within(form).findByLabelText("Slack channel"), { target: { value: "slack:T1/C9" } });
  expect(within(form).queryByLabelText("How long Rovara keeps it")).toBeNull();
  const notes = within(form).getByRole("switch", { name: "Keep notes with links" });
  expect(notes.getAttribute("aria-checked")).toBe("false");
  expect(noteIn(form)).toBeTruthy();
  fireEvent.click(within(form).getByRole("button", { name: "Add source" }));
  await waitFor(() => { expect(f.posts).toHaveLength(1); });
  expect(f.posts[0]).toEqual({ action: "add", requestId: expect.stringMatching(UUID) as string, source: "slack", scope: "slack:T1/C9", retention: "A", audienceDefault: "maintainers", enabled: true });
  expect(f.posts[0]).not.toHaveProperty("notesOptIn");
 });
 it("adds a Slack channel with the switch on: retention B and notesOptIn true", async () => {
  const f = await openEditor({ view: publicView({ sources: [] }) });
  const form = screen.getByRole("region", { name: "Add a source" });
  pick("What to add", "slack");
  fireEvent.change(await within(form).findByLabelText("Slack channel"), { target: { value: "slack:T1/C9" } });
  fireEvent.click(within(form).getByRole("switch", { name: "Keep notes with links" }));
  expect(within(form).getByRole("switch", { name: "Keep notes with links" }).getAttribute("aria-checked")).toBe("true");
  fireEvent.click(within(form).getByRole("button", { name: "Add source" }));
  await waitFor(() => { expect(f.posts).toHaveLength(1); });
  expect(f.posts[0]).toMatchObject({ action: "add", source: "slack", scope: "slack:T1/C9", retention: "B", notesOptIn: true });
 });
 it("\"Slack's API terms\" in the note is a real link to Slack's terms, opened in a new tab without the opener (design 4.3); the sentence reads the same (add form and row)", async () => {
  await openEditor({ view: publicView({ sources: [slackRow()] }) });
  const form = screen.getByRole("region", { name: "Add a source" });
  pick("What to add", "slack");
  for (const scope of [form, slackRegion()]) {
   const link = within(scope).getByRole<HTMLAnchorElement>("link", { name: "Slack's API terms" });
   expect(link.getAttribute("href")).toBe("https://slack.com/terms-of-service/api");
   expect(link.getAttribute("target")).toBe("_blank");
   expect(link.getAttribute("rel")?.split(" ").sort()).toEqual(["noopener", "noreferrer"]);
   expect(link.parentElement?.textContent).toBe(NOTE);
  }
 });
 it("the switch is for Slack only: a repository and a Linear team still choose a retention and show no note", async () => {
  await openEditor({ view: publicView({ sources: [] }) });
  const form = screen.getByRole("region", { name: "Add a source" });
  for (const kind of ["repository", "linear"]) {
   pick("What to add", kind);
   expect(within(form).getByLabelText("How long Rovara keeps it")).toBeTruthy();
   expect(within(form).queryByRole("switch", { name: "Keep notes with links" })).toBeNull();
  }
  expect(noteIn(document.body)).toBeNull();
 });
 it("Enterprise (no notesSwitch) never shows the switch or the note: a Slack channel still chooses a retention", async () => {
  await openEditor({ view: adminView({ sources: [slackRow({ retention: "C" })] }) });
  const form = screen.getByRole("region", { name: "Add a source" });
  pick("What to add", "slack");
  expect(within(form).getByLabelText("How long Rovara keeps it")).toBeTruthy();
  expect(screen.queryByRole("switch", { name: "Keep notes with links" })).toBeNull();
  expect(within(slackRegion()).getByLabelText("How long Rovara keeps it")).toBeTruthy();
  expect(noteIn(document.body)).toBeNull();
 });
 it("a Slack row shows the switch with the note instead of a retention choice; it reflects B with the opt-in, and turning it on sends retention B + notesOptIn true", async () => {
  const f = await openEditor({ view: publicView({ sources: [slackRow()] }) });
  const slack = slackRegion();
  expect(within(slack).queryByLabelText("How long Rovara keeps it")).toBeNull();
  const notes = within(slack).getByRole("switch", { name: "Keep notes with links" });
  expect(notes.getAttribute("aria-checked")).toBe("false");
  expect(noteIn(slack)).toBeTruthy();
  expect(within(slack).getByRole("button", { name: "Save changes" })).toHaveProperty("disabled", true);
  fireEvent.click(notes);
  fireEvent.click(within(slack).getByRole("button", { name: "Save changes" }));
  await waitFor(() => { expect(f.posts).toHaveLength(1); });
  expect(f.posts[0]).toEqual({ action: "change", requestId: expect.stringMatching(UUID) as string, source: "slack", scope: "slack:T1/C9", expectedRevision: 3, retention: "B", notesOptIn: true });
 });
 it("turning the switch off on a row kept at B with the opt-in sends retention A and notesOptIn null", async () => {
  const f = await openEditor({ view: publicView({ sources: [slackRow({ retention: "B", notesOptIn: true })] }) });
  const slack = slackRegion();
  expect(within(slack).getByRole("switch", { name: "Keep notes with links" }).getAttribute("aria-checked")).toBe("true");
  fireEvent.click(within(slack).getByRole("switch", { name: "Keep notes with links" }));
  fireEvent.click(within(slack).getByRole("button", { name: "Save changes" }));
  await waitFor(() => { expect(f.posts).toHaveLength(1); });
  expect(f.posts[0]).toMatchObject({ action: "change", retention: "A", notesOptIn: null, expectedRevision: 3 });
 });
 it("when the company only allows retention A for Slack, the switch is shown disabled with the fixed reason, in the add form and in a row; Add still sends A", async () => {
  const REASON = "Your company keeps Slack sources live only.";
  const liveOnly = publicView({ sources: [slackRow()], offered: { github: ["A", "B", "C", "D"], rovara: ["A", "B", "C", "D"], slack: ["A"], linear: ["A", "B", "C"], jira: ["A", "B", "C"], codehost: ["A"], mcp: ["A"] } });
  const f = await openEditor({ view: liveOnly });
  const form = screen.getByRole("region", { name: "Add a source" });
  pick("What to add", "slack");
  fireEvent.change(await within(form).findByLabelText("Slack channel"), { target: { value: "slack:T1/C8" } });
  for (const scope of [form, slackRegion()]) {
   const notes = within(scope).getByRole("switch", { name: "Keep notes with links" });
   expect(notes.hasAttribute("disabled")).toBe(true);
   expect(within(scope).getByText(REASON)).toBeTruthy();
   fireEvent.click(notes);
   expect(notes.getAttribute("aria-checked")).toBe("false");
  }
  fireEvent.click(within(form).getByRole("button", { name: "Add source" }));
  await waitFor(() => { expect(f.posts).toHaveLength(1); });
  expect(f.posts[0]).toMatchObject({ action: "add", scope: "slack:T1/C8", retention: "A" });
 });
 it("a Slack row already at B with the opt-in can still be switched off when the company only allows A: the switch is enabled and sends retention A, notesOptIn null", async () => {
  const lockedToA = publicView({ sources: [slackRow({ retention: "B", notesOptIn: true })], offered: { github: ["A", "B", "C", "D"], rovara: ["A", "B", "C", "D"], slack: ["A"], linear: ["A", "B", "C"], jira: ["A", "B", "C"], codehost: ["A"], mcp: ["A"] } });
  const f = await openEditor({ view: lockedToA });
  const slack = slackRegion();
  const notes = within(slack).getByRole("switch", { name: "Keep notes with links" });
  expect(notes.getAttribute("aria-checked")).toBe("true");
  expect(notes.hasAttribute("disabled")).toBe(false);
  fireEvent.click(notes);
  fireEvent.click(within(slack).getByRole("button", { name: "Save changes" }));
  await waitFor(() => { expect(f.posts).toHaveLength(1); });
  expect(f.posts[0]).toMatchObject({ action: "change", scope: "slack:T1/C9", retention: "A", notesOptIn: null });
 });
 it("the reason is not shown when retention B is offered", async () => {
  await openEditor({ view: publicView({ sources: [slackRow()] }) });
  pick("What to add", "slack");
  expect(screen.queryByText("Your company keeps Slack sources live only.")).toBeNull();
  expect(within(slackRegion()).getByRole("switch", { name: "Keep notes with links" }).hasAttribute("disabled")).toBe(false);
 });
 it("other changes to a Slack row in Public (on or off, who sees it) send no retention and no notesOptIn", async () => {
  const f = await openEditor({ view: publicView({ sources: [slackRow()] }) });
  const slack = slackRegion();
  fireEvent.click(within(slack).getByRole("switch", { name: "On" }));
  fireEvent.click(within(slack).getByRole("button", { name: "Save changes" }));
  await waitFor(() => { expect(f.posts).toHaveLength(1); });
  expect(f.posts[0]).not.toHaveProperty("retention");
  expect(f.posts[0]).not.toHaveProperty("notesOptIn");
 });
 it("has no axe violations with the switch and its note, in light and dark", async () => {
  for (const theme of ["light", "dark"] as const) {
   const f = openSources({ view: publicView({ sources: [slackRow({ retention: "B", notesOptIn: true })] }) }, theme);
   await screen.findByRole("heading", { name: "Add a source" });
   pick("What to add", "slack");
   await expectNoAxeViolations(f.container);
   f.unmount();
  }
 });
});

describe("accessibility", () => {
 it("has no axe violations with sources and the add form open, in light and dark", async () => {
  for (const theme of ["light", "dark"] as const) {
   const f = openSources({ view: adminView({ sources: [adminRow(), adminRow({ kind: "rovara", scope: "rovara:project/payments" })] }) }, theme);
   await screen.findByRole("heading", { name: "Add a source" });
   pick("What to add", "slack");
   fireEvent.click(within(row(/GitHub/u)).getByRole("button", { name: "Remove" }));
   await expectNoAxeViolations(f.container);
   f.unmount();
  }
 });
});


const REMOVING = "Removing: deleting its stored data. You can add it again when this finishes (about an hour).";
const clearing = (over: Record<string, unknown> = {}) => ({ source: "github", scope: "github:repo/9", since: "2026-10-30T10:00:00.000Z", ...over });

describe("T8: a source that was removed and is still being cleared", () => {
 it("shows a muted row with its kind, its place and the fixed sentence, and no controls", async () => {
  await openEditor({ view: adminView({ sources: [], clearing: [clearing(), clearing({ source: "slack", scope: "slack:T1/C9" })] }) });
  const list = screen.getByRole("list", { name: "Being removed" });
  const items = within(list).getAllByRole("listitem");
  expect(items).toHaveLength(2);
  expect(items[0]!.textContent).toContain("GitHub");
  expect(items[0]!.textContent).toContain("github:repo/9");
  expect(items[1]!.textContent).toContain("Slack");
  expect(items[1]!.textContent).toContain("slack:T1/C9");
  for (const item of items) { expect(within(item).getByText(REMOVING)).toBeTruthy();expect(within(item).queryByRole("button")).toBeNull();expect(within(item).queryByRole("switch")).toBeNull();expect(item.querySelector("input,select,textarea")).toBeNull(); }
  expect(screen.queryByRole("region", { name: /GitHub/u })).toBeNull(); // it is not an editable source row
 });
 it("shows nothing when the view has no clearing list", async () => {
  await openEditor();
  expect(screen.queryByRole("list", { name: "Being removed" })).toBeNull();
  expect(document.body.textContent).not.toContain("Removing");
 });
 it("keeps a repository that is still clearing in the picker as a disabled option labelled (being removed), so the cause stays next to the choice", async () => {
  await openEditor({ view: adminView({ sources: [], clearing: [clearing()] }) });
  pick("What to add", "repository");
  const options = [...optionsOf("Repository", screen.getByRole("region", { name: "Add a source" }))];
  const clearingOption = options.find(option => option.value === "github:repo/9")!;
  expect(clearingOption.textContent).toBe("payments-api (being removed)");
  expect(clearingOption.disabled).toBe(true);
  const other = options.find(option => option.value === "github:repo/12")!;
  expect(other.textContent).toBe("web-app");
  expect(other.disabled).toBe(false);
 });
 it("still offers the repository kind when every repository is clearing, all of them disabled", async () => {
  await openEditor({ view: adminView({ sources: [], clearing: [clearing(), clearing({ scope: "github:repo/12" })] }) });
  expect(values(optionsOf("What to add"))).toContain("repository");
  pick("What to add", "repository");
  const options = [...optionsOf("Repository", screen.getByRole("region", { name: "Add a source" }))].filter(option => option.value !== "");
  expect(options.map(option => option.disabled)).toEqual([true, true]);
 });
 it("refuses a typed place that is still clearing up front, with the same sentence, and sends nothing", async () => {
  const f = await openEditor({ view: adminView({ sources: [], clearing: [clearing({ source: "slack", scope: "slack:T1/C9" })] }) });
  const form = screen.getByRole("region", { name: "Add a source" });
  pick("What to add", "slack");
  fireEvent.change(await within(form).findByLabelText("Slack channel"), { target: { value: "  slack:T1/C9 " } });
  pick("How long Rovara keeps it", "B", form);
  expect(within(form).getByText("This source was just removed and its stored data is still being deleted. You can add it again in about an hour.")).toBeTruthy();
  const send = within(form).getByRole<HTMLButtonElement>("button", { name: "Add source" });
  expect(send.disabled).toBe(true);
  fireEvent.click(send);
  expect(f.posts).toHaveLength(0);
  // Another channel of the same kind is not refused; a clearing place of another kind does not block it either.
  fireEvent.change(await within(form).findByLabelText("Slack channel"), { target: { value: "slack:T1/C10" } });
  expect(within(form).queryByText(/was just removed/u)).toBeNull();
  expect(send.disabled).toBe(false);
 });
});

describe("T8: nothing in the source error sentences says place or scope", () => {
 it("every fixed sentence the screen shows for a refusal uses source or the kind's name", async () => {
  const { T } = await import("../../packages/ui/src/screens/project/lessons/lessons-text.js");
  const sentences = Object.entries(T).filter(([key]) => key.startsWith("SRC_ERR_")).map(([, text]) => text);
  expect(sentences.length).toBeGreaterThanOrEqual(10);
  for (const sentence of sentences) expect(sentence, sentence).not.toMatch(/\b(place|places|scope|scopes)\b/iu);
 });
});

describe("T8 round 1: refreshing, matching the server's rule, and the other refusals", () => {
 const refusalFor = (typed: string, clearingScope = "slack:T1/C9", source = "slack") => async () => {
  const f = await openEditor({ view: adminView({ sources: [], clearing: [clearing({ source, scope: clearingScope })] }) });
  const form = screen.getByRole("region", { name: "Add a source" });
  pick("What to add", "slack");
  fireEvent.change(await within(form).findByLabelText("Slack channel"), { target: { value: typed } });
  pick("How long Rovara keeps it", "B", form);
  return { f, form, send: within(form).getByRole<HTMLButtonElement>("button", { name: "Add source" }) };
 };
 it("refuses a place above or below a clearing place too, as the server does, and not an unrelated one", async () => {
  for (const typed of ["slack:T1", "slack:T1/C9/extra", "slack:T1/C9"]) {
   const { form, send, f } = await refusalFor(typed)();
   expect(within(form).getByText(/was just removed/u), typed).toBeTruthy();
   expect(send.disabled, typed).toBe(true);
   fireEvent.click(send);
   expect(f.posts, typed).toHaveLength(0);
   cleanup();
  }
  for (const typed of ["slack:T1/C90", "slack:T2/C9", "slack:T11"]) {
   const { form, send } = await refusalFor(typed)();
   expect(within(form).queryByText(/was just removed/u), typed).toBeNull();
   expect(send.disabled, typed).toBe(false);
   cleanup();
  }
 });
 it("a clearing place of another kind does not block the same text", async () => {
  const { form, send } = await refusalFor("slack:T1/C9", "slack:T1/C9", "linear")();
  expect(within(form).queryByText(/was just removed/u)).toBeNull();
  expect(send.disabled).toBe(false);
 });
 it("typing a place that matches a clearing row reads the editors' view once more per clearing row, not once per keystroke (T9, Minor A of the T8 re-review)", async () => {
  const f = await openEditor({ view: adminView({ sources: [], clearing: [clearing({ source: "slack", scope: "slack:T1/C9" }), clearing({ source: "slack", scope: "slack:T1/C7" })] }) });
  const before = f.recordReads().length;
  const form = screen.getByRole("region", { name: "Add a source" });
  const type = (value: string) => fireEvent.change(within(form).getByLabelText("Slack channel"), { target: { value } });
  const settle = async () => { await new Promise(resolve => setTimeout(resolve, 50)); };
  pick("What to add", "slack");
  await within(form).findByLabelText("Slack channel"); // the list cannot be read here, so the typed field comes up
  type("slack:T1/C8"); // no match: nothing is read
  expect(f.recordReads().length).toBe(before);
  type("slack:T1/C9");
  await waitFor(() => { expect(f.recordReads().length).toBe(before + 1); });
  // More characters after the match still match the same clearing row (a place below it): the same row, so no new read for each keystroke.
  for (const typed of ["slack:T1/C9/", "slack:T1/C9/e", "slack:T1/C9/ex", "slack:T1/C9 "]) { type(typed);await settle(); }
  expect(f.recordReads().length).toBe(before + 1);
  // Another clearing row is a new match and reads once more.
  type("slack:T1/C7");
  await waitFor(() => { expect(f.recordReads().length).toBe(before + 2); });
  // The worker finished meanwhile: the next read has no clearing row and the refusal goes.
  f.state.view = adminView({ sources: [] });
  type("slack:T1/C9");
  await waitFor(() => { expect(f.recordReads().length).toBe(before + 3); });
  await waitFor(() => { expect(within(form).queryByText(/was just removed/u)).toBeNull(); });
 });
 it("says the queue is busy in its own sentence for SOURCE_REMOVAL_BUSY, never 'just removed'", async () => {
  await openEditor({ write: () => flat("SOURCE_REMOVAL_BUSY", "server words that must not show", 409) });
  const form = screen.getByRole("region", { name: "Add a source" });
  pick("What to add", "repository");
  pick("Repository", "github:repo/12");
  pick("How long Rovara keeps it", "B", form);
  fireEvent.click(within(form).getByRole("button", { name: "Add source" }));
  expect(await within(form).findByText("Rovara is still deleting data from recently removed sources. Try again in an hour.")).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/just removed|server words/u);
 });
});

describe("T8 round 1: the editors' view is read again every minute while something is clearing", () => {
 const reads = (f: Awaited<ReturnType<typeof openEditor>>) => f.recordReads().length;
 const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
 const hidden = (value: boolean) => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value ? "hidden" : "visible" });document.dispatchEvent(new Event("visibilitychange")); };
 afterEach(() => { vi.useRealTimers();hidden(false); });

 it("polls every 60 s while clearing is non-empty, stops once it is empty, and does not poll a view that never had one", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
  const f = await openEditor({ view: adminView({ sources: [], clearing: [clearing()] }) });
  const start = reads(f);
  await tick(59_000);
  expect(reads(f)).toBe(start);
  await tick(2_000);
  expect(reads(f)).toBe(start + 1);
  await tick(60_000);
  expect(reads(f)).toBe(start + 2);
  // The worker finished: the next poll sees no clearing row and the polling stops.
  f.state.view = adminView({ sources: [] });
  await tick(60_000);
  expect(reads(f)).toBe(start + 3);
  expect(screen.queryByRole("list", { name: "Being removed" })).toBeNull();
  await tick(180_000);
  expect(reads(f)).toBe(start + 3);
 });
 it("never polls a view with nothing clearing", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
  const f = await openEditor();
  const start = reads(f);
  await tick(300_000);
  expect(reads(f)).toBe(start);
 });
 it("does not poll while the tab is hidden", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
  const f = await openEditor({ view: adminView({ sources: [], clearing: [clearing()] }) });
  hidden(true);
  const start = reads(f);
  await tick(300_000);
  expect(reads(f)).toBe(start);
 });
});
