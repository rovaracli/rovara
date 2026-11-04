// @vitest-environment jsdom
// T5: the Sources tab for a person who may edit sources: add, change, remove, and approve or reject a waiting change. The server decides every rule; these tests hold what the screen shows and sends.
import { describe, expect, it, vi } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { SourceWriteBodySchema } from "@agentx/contracts/web";
import { ok } from "./support/lessons-fixture.js";
import { adminRow, adminView, flat, pendingChange, wrapped } from "./support/sources-fixture.js";
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
 it("adds a Slack channel by the place typed, and when the server says it waits for a second person says that, without calling the channel public or private itself", async () => {
  const f = await openEditor({ write: () => ({ status: 202, body: { status: "needs_approval", changeId: "chg-new", expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() } }) });
  const form = screen.getByRole("region", { name: "Add a source" });
  pick("What to add", "slack");
  fireEvent.change(within(form).getByLabelText("Slack channel"), { target: { value: "  slack:T1/C9  " } });
  expect(within(form).getByText(/Rovara checks the channel itself/u)).toBeTruthy();
  pick("How long Rovara keeps it", "B", form);
  fireEvent.click(within(form).getByRole("button", { name: "Add source" }));
  expect(await screen.findByText(/needs a second person to approve it/u)).toBeTruthy();
  expect(f.posts[0]).toMatchObject({ action: "add", source: "slack", scope: "slack:T1/C9", retention: "B", audienceDefault: "maintainers" });
  expect(document.body.textContent).not.toMatch(/\b(public|private)\b/iu);
 });
 it("says what the server's refusal means in fixed words: a place that cannot be used, a kind not yet supported, unavailable", async () => {
  let answer = flat("SOURCE_NOT_ALLOWED", "Direct messages can't be a source in Public.", 422);
  const f = await openEditor({ write: () => answer });
  const form = screen.getByRole("region", { name: "Add a source" });
  pick("What to add", "slack");
  fireEvent.change(within(form).getByLabelText("Slack channel"), { target: { value: "slack:T1/D3" } });
  pick("How long Rovara keeps it", "A", form);
  const send = () => fireEvent.click(within(form).getByRole("button", { name: "Add source" }));
  send();
  expect(await within(form).findByText("That place can't be used as a source here.")).toBeTruthy();
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
 it("a change that waits for a second person says so and the waiting card appears after the list is read again", async () => {
  const f = await openEditor({ write: () => ({ status: 202, body: { status: "needs_approval", changeId: "chg-r", expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() } }) });
  f.state.view = adminView({ pending: [pendingChange({ changeId: "chg-r", source: "github", scope: "github:repo/9", kind: "change", reasons: ["retention_raise"], proposedByYou: true })] });
  pick("How long Rovara keeps it", "D", row(/GitHub/u));
  fireEvent.click(within(row(/GitHub/u)).getByRole("button", { name: "Save changes" }));
  expect(await screen.findByText(/needs a second person to approve it/u)).toBeTruthy();
  expect(await screen.findByText("Keeping items longer")).toBeTruthy();
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
 it("says the place is still being cleared, in the server's fixed sentence, when a flat refusal says so", async () => {
  await openEditor({ write: () => flat("SOURCE_REMOVAL_RUNNING", "This place is still being cleared. Try again in an hour.", 409) });
  const github = row(/GitHub/u);
  fireEvent.click(within(github).getByRole("button", { name: "Remove" }));
  fireEvent.click(within(github).getByRole("button", { name: "Yes, remove it" }));
  expect(await within(github).findByText("This place is still being cleared. Try again in an hour.")).toBeTruthy();
 });
});

describe("changes waiting for a second person", () => {
 const view = (pending: unknown[], over: Record<string, unknown> = {}) => adminView({ pending, ...over });
 it("the person who made it sees Waiting and no Approve or Reject", async () => {
  await openEditor({ view: view([pendingChange({ proposedByYou: true })]) });
  const card = screen.getByRole("region", { name: /^Waiting for a second person/u });
  expect(within(card).getByText("Waiting")).toBeTruthy();
  expect(within(card).queryByRole("button", { name: "Approve" })).toBeNull();
  expect(within(card).queryByRole("button", { name: "Reject" })).toBeNull();
  expect(within(card).getByText("A private channel")).toBeTruthy();
  expect(within(card).getByText("slack:T1/C9")).toBeTruthy();
 });
 it("another person sees Approve and Reject; Approve sends the change id alone and says it is in effect", async () => {
  const f = await openEditor({ view: view([pendingChange()]) });
  const card = screen.getByRole("region", { name: /^Waiting for a second person/u });
  expect(within(card).queryByText("Waiting")).toBeNull();
  f.state.view = view([]);
  fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
  expect(await screen.findByText("Approved. The change is in effect.")).toBeTruthy();
  expect(f.posts[0]).toEqual({ action: "approve", changeId: "chg-one" });
 });
 it("Reject sends the change id alone", async () => {
  const f = await openEditor({ view: view([pendingChange()]), write: body => ok({ status: body.action === "reject" ? "rejected" : "saved", ...(body.action === "reject" ? {} : { revision: 1 }) }) });
  fireEvent.click(within(screen.getByRole("region", { name: /^Waiting for a second person/u })).getByRole("button", { name: "Reject" }));
  expect(await screen.findByText("Change rejected.")).toBeTruthy();
  expect(f.posts[0]).toEqual({ action: "reject", changeId: "chg-one" });
 });
 it("the only person who can approve (soleApprover) sees Approve on their own change with the fixed line, and no Reject", async () => {
  const f = await openEditor({ view: view([pendingChange({ proposedByYou: true })], { soleApprover: true }) });
  const card = screen.getByRole("region", { name: /^Waiting for a second person/u });
  expect(within(card).getByText("You're the only person who can approve this.")).toBeTruthy();
  expect(within(card).queryByText("Waiting")).toBeNull();
  expect(within(card).queryByText(/for another person to approve this/u)).toBeNull();
  fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
  await waitFor(() => { expect(f.posts).toHaveLength(1); });
  expect(f.posts[0]).toEqual({ action: "approve", changeId: "chg-one" });
  expect(within(card).queryByRole("button", { name: "Reject" })).toBeNull();
 });
 it("each card is named by its source kind and place, so two waiting changes can be told apart", async () => {
  await openEditor({ view: view([pendingChange(), pendingChange({ changeId: "chg-two", source: "linear", scope: "linear:team/ENG", reasons: ["retention_raise"] })]) });
  expect(screen.getByRole("region", { name: "Waiting for a second person: Slack slack:T1/C9" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Waiting for a second person: Linear linear:team/ENG" })).toBeTruthy();
 });
 it("without soleApprover the proposer never sees the sole-approver line", async () => {
  await openEditor({ view: view([pendingChange({ proposedByYou: true })]) });
  expect(screen.queryByText("You're the only person who can approve this.")).toBeNull();
 });
 it("asks for a fresh sign-in in fixed words and offers to sign in again", async () => {
  const f = await openEditor({ view: view([pendingChange()]), write: () => wrapped("REAUTH_REQUIRED", "Sign in again to approve (server text).", 403) });
  const card = screen.getByRole("region", { name: /^Waiting for a second person/u });
  fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
  expect(await within(card).findByText("Sign in again to approve.")).toBeTruthy();
  fireEvent.click(within(card).getByRole("button", { name: "Sign in again" }));
  expect(f.host.signIn).toHaveBeenCalledWith("/app/live");
  expect(document.body.textContent).not.toContain("server text");
 });
});

describe("accessibility", () => {
 it("has no axe violations with sources, a waiting change and the add form open, in light and dark", async () => {
  for (const theme of ["light", "dark"] as const) {
   const f = openSources({ view: adminView({ pending: [pendingChange()], sources: [adminRow(), adminRow({ kind: "rovara", scope: "rovara:project/payments" })] }) }, theme);
   await screen.findByRole("heading", { name: "Add a source" });
   pick("What to add", "slack");
   fireEvent.click(within(row(/GitHub/u)).getByRole("button", { name: "Remove" }));
   await expectNoAxeViolations(f.container);
   f.unmount();
  }
 });
});

