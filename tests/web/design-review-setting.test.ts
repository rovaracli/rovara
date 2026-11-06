// @vitest-environment jsdom
// Design review (DR11): the stage card and settings editor in How we work: its six rows, a locked state with the reason, the group approver only in Enterprise, and the save through the playbook PUT.
import { expect, it } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { DESIGN_REVIEW_DEFAULT_SETTING, type DesignReviewSetting } from "@agentx/contracts/web";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { DesignReviewCard } from "../../packages/ui/src/screens/project/DesignReviewCard.js";
import { approverKinds, draftOf, designRows, lockedSet, settingLines, settingOf } from "../../packages/ui/src/screens/project/design-review-setting.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";

const PERSON = "b".repeat(64);
interface World { unreadable?: boolean; off?: boolean; allowed?: boolean | undefined; setting?: DesignReviewSetting | undefined; locked?: string[] | undefined; groups?: boolean | undefined; revision?: number; process?: unknown }
function setup(world: World = {}, canEdit = true, filter: "all" | "changed" | "locked" = "all") {
 const state = { ...world }, puts: Array<{ path: string; body: Record<string, unknown> }> = [];
 const answer = () => ({ ...(state.allowed === undefined ? {} : { designReviewAllowed: state.allowed }), playbook: { revision: state.revision ?? 4, defaultProcess: state.process ?? { kind: "builtin" }, ...(state.off === true || state.allowed === false ? {} : { designReview: state.setting ?? DESIGN_REVIEW_DEFAULT_SETTING }) }, ...(state.locked === undefined ? {} : { designReviewLocked: state.locked }), ...(state.groups === undefined ? {} : { designReviewGroups: state.groups }), ...(state.unreadable === true ? { designReviewUnreadable: true } : {}) });
 const f = fakeHost(async request => {
  if (request.path.endsWith("/playbook") && request.method === "GET") return { status: 200, body: answer() };
  if (request.path.endsWith("/playbook") && request.method === "PUT") { const body = request.body as Record<string, unknown>;puts.push({ path: request.path, body });state.setting = body.designReview as DesignReviewSetting;state.revision = (state.revision ?? 4) + 1;return { status: 200, body: answer() }; }
  if (request.path === "/v1/app/org/members") return { status: 200, body: { members: [{ developerId: "a".repeat(64), name: "Priya", role: "owner" }, { developerId: PERSON, name: "Sam", role: "member" }] } };
  return { status: 404, body: { error: { code: "NOT_FOUND", message: "No." } } };
 });
 const query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(DesignReviewCard, { project: "payments", canEdit, filter }) }) }));
 return { ...f, ...ui, puts, close() { ui.unmount();query.clear(); } };
}

it("shows the stage card with its six rows and the settings, from the owner's defaults when the project has none", async () => {
 const f = setup();
 await screen.findByText("Who does it");
 const card = screen.getByRole("region", { name: "Design review" });
 for (const title of ["Who does it", "What it knows", "What it may do", "How it's checked", "Evidence", "Who approves"]) expect(within(card).getByText(title)).toBeTruthy();
 expect(within(card).getByText(/Three reviewers plus a merge step/u)).toBeTruthy();
 expect(within(within(card).getByLabelText("Design review settings")).getByText("Auto: Rovara decides from the request")).toBeTruthy();
 expect(within(card).getByText("$15.00. Above it, a person decides.")).toBeTruthy();
 expect(within(card).getByText(/project maintainers/u)).toBeTruthy();
 f.close();
});

it("reads a locked field as read-only with the reason, and the page can still change the others", async () => {
 const f = setup({ setting: { ...DESIGN_REVIEW_DEFAULT_SETTING, mode: "always", allowSkip: false }, locked: ["designReview.tier", "designReview.allowSkip"] });
 const editor = await screen.findByRole("region", { name: "Design review settings editor" });
 // The mode is never locked: the company cannot stop a project turning itself on or off.
 expect(within(editor).getByLabelText("When it runs").hasAttribute("disabled")).toBe(false);
 expect(within(editor).getByLabelText("Allow skipping design review").hasAttribute("disabled")).toBe(true);
 expect(within(editor).getByLabelText("Tier").hasAttribute("disabled")).toBe(true);
 expect(within(editor).getAllByText("Your company has locked this setting. A company admin can change it.")).toHaveLength(2);
 expect(screen.getAllByText("Locked by company").length).toBeGreaterThan(0);
 expect(screen.getByText("Your company locks some of these settings. Locked settings are read-only.")).toBeTruthy();
 // The save sends the locked values as shown (the held ones), with only the mode changed.
 fireEvent.change(within(editor).getByLabelText("When it runs"), { target: { value: "never" } });
 fireEvent.click(within(editor).getByRole("button", { name: "Save design review settings" }));
 await waitFor(() => expect(f.puts).toHaveLength(1));
 expect(f.puts[0]!.body).toMatchObject({ expectedRevision: 4, defaultProcess: { kind: "builtin" }, designReview: { mode: "never", tier: "standard", allowSkip: false, capUsdPerTask: 15, highRiskApprover: { kind: "maintainers" } } });
 expect(await screen.findByText("Saved. New design reviews use these settings; running ones keep theirs.")).toBeTruthy();
 f.close();
});

it("locks every field the company can lock, but never the mode, and offers nothing to save", async () => {
 const all = ["designReview.tier", "designReview.allowSkip", "designReview.capUsdPerTask", "designReview.highRiskApprover"];
 const f = setup({ setting: { ...DESIGN_REVIEW_DEFAULT_SETTING, mode: "always", allowSkip: false }, locked: all });
 const editor = await screen.findByRole("region", { name: "Design review settings editor" });
 expect(within(editor).getByLabelText("When it runs").hasAttribute("disabled")).toBe(false);
 for (const label of ["Tier", "Allow skipping design review", "Cost limit per task (USD)", "Who approves a high-risk design"]) expect(within(editor).getByLabelText(label).hasAttribute("disabled")).toBe(true);
 expect(screen.getByText("Your company controls every design review setting here.")).toBeTruthy();
 f.close();
});

it("offers a group as the high-risk approver only where the broker says there are groups", async () => {
 const publicEdition = setup({});
 const editor = await screen.findByRole("region", { name: "Design review settings editor" });
 const choices = Array.from(within(editor).getByLabelText<HTMLSelectElement>("Who approves a high-risk design").options).map(option => option.textContent);
 expect(choices).toContain("Named people");
 expect(choices.some(text => text?.includes("A group"))).toBe(false);
 expect(approverKinds(false)).toEqual(["maintainers", "people"]);
 publicEdition.close();
 const enterprise = setup({ groups: true });
 const grouped = await screen.findByRole("region", { name: "Design review settings editor" });
 const kinds = Array.from(within(grouped).getByLabelText<HTMLSelectElement>("Who approves a high-risk design").options).map(option => option.textContent);
 expect(kinds).toContain("A group");
 fireEvent.change(within(grouped).getByLabelText("Who approves a high-risk design"), { target: { value: "group" } });
 fireEvent.change(within(grouped).getByLabelText("Group"), { target: { value: "platform-leads" } });
 fireEvent.click(within(grouped).getByRole("button", { name: "Save design review settings" }));
 await waitFor(() => expect(enterprise.puts).toHaveLength(1));
 expect(enterprise.puts[0]!.body.designReview).toMatchObject({ highRiskApprover: { kind: "group", groupId: "platform-leads" } });
 enterprise.close();
});

it("saves named people and the cost limit, and refuses a limit outside the range or no one named", async () => {
 const f = setup({});
 const editor = await screen.findByRole("region", { name: "Design review settings editor" });
 fireEvent.change(within(editor).getByLabelText("Who approves a high-risk design"), { target: { value: "people" } });
 expect(within(editor).getByRole("button", { name: "Save design review settings" }).hasAttribute("disabled")).toBe(true);
 fireEvent.click(await within(editor).findByRole("checkbox", { name: "Sam" }));
 fireEvent.change(within(editor).getByLabelText("Cost limit per task (USD)"), { target: { value: "250" } });
 expect(await within(editor).findByText("Use an amount between $0.50 and $100.00.")).toBeTruthy();
 expect(within(editor).getByRole("button", { name: "Save design review settings" }).hasAttribute("disabled")).toBe(true);
 expect(f.puts).toHaveLength(0);
 fireEvent.change(within(editor).getByLabelText("Cost limit per task (USD)"), { target: { value: "20" } });
 fireEvent.click(within(editor).getByRole("button", { name: "Save design review settings" }));
 await waitFor(() => expect(f.puts).toHaveLength(1));
 expect(f.puts[0]!.body.designReview).toMatchObject({ capUsdPerTask: 20, highRiskApprover: { kind: "people", memberIds: [PERSON] } });
 f.close();
});

it("says plainly, without an alert, when the setting cannot be read, and shows no card where the project has no playbook route", async () => {
 const failing = renderUi(h(AppHostProvider, { host: fakeHost(async () => ({ status: 403, body: { error: { code: "FORBIDDEN", message: "You can't see this." } } })).host, children: h(QueryClientProvider, { client: createQueryClient(), children: h(DesignReviewCard, { project: "payments", canEdit: true, filter: "all" }) }) }));
 expect(await screen.findByRole("button", { name: "Reload design review settings" })).toBeTruthy();
 expect(screen.getByText("You can't see this.")).toBeTruthy();
 expect(screen.queryByRole("alert")).toBeNull();
 failing.unmount();
 const missing = renderUi(h(AppHostProvider, { host: fakeHost(async () => ({ status: 404, body: { error: { code: "NOT_FOUND", message: "No." } } })).host, children: h(QueryClientProvider, { client: createQueryClient(), children: h(DesignReviewCard, { project: "payments", canEdit: true, filter: "all" }) }) }));
 await waitFor(() => expect(missing.container.querySelector("section")).toBeNull());
 missing.unmount();
});

it("shows no card where design review is off for the project: the playbook answer has no designReview field (QA-04)", async () => {
 const f = setup({ off: true });
 await waitFor(() => expect(f.request.mock.calls.some(([request]) => request.method === "GET" && request.path.endsWith("/playbook"))).toBe(true));
 await waitFor(() => expect(f.container.querySelector("section, [id=hww-stage-design-review]")).toBeNull());
 expect(screen.queryByText("Design review")).toBeNull();
 expect(screen.queryByLabelText("When it runs")).toBeNull();
 f.close();
});

it("gives a person who cannot edit the card and no editor", async () => {
 const f = setup({}, false);
 await screen.findByRole("region", { name: "Design review" });
 expect(screen.queryByRole("region", { name: "Design review settings editor" })).toBeNull();
 f.close();
});

it("keeps the pure rules: the default marks, the locked set and the setting a draft means", () => {
 const rows = designRows(DESIGN_REVIEW_DEFAULT_SETTING, lockedSet(["designReview.tier"]));
 expect(rows.map(row => row.id)).toEqual(["who", "knows", "may", "checked", "evidence", "approves"]);
 expect(rows[0]!.values[0]!.mark).toMatchObject({ locked: true, lockedBy: "company" });
 expect(rows[5]!.values[0]!.mark).toMatchObject({ locked: false, source: "rovara" });
 expect(settingLines({ ...DESIGN_REVIEW_DEFAULT_SETTING, mode: "never" }, new Set())[0]!.mark).toMatchObject({ source: "project" });
 expect(lockedSet(["designReview.mode", "designReview.tier", "nonsense"])).toEqual(new Set(["tier"]));
 const draft = draftOf(DESIGN_REVIEW_DEFAULT_SETTING);
 expect(settingOf(draft, false)).toEqual({ ok: true, setting: DESIGN_REVIEW_DEFAULT_SETTING });
 expect(settingOf({ ...draft, approverKind: "group", groupId: "g" }, false)).toMatchObject({ ok: false, problems: { group: "Groups are not available in this edition." } });
 expect(settingOf({ ...draft, capText: "0.1" }, true)).toMatchObject({ ok: false });
});

it("DR-FU4: where the company has not allowed design review the card says so in plain words and offers no setting and no editor, whoever looks", async () => {
 for (const canEdit of [true, false]) {
  const f = setup({ allowed: false }, canEdit);
  const card = await screen.findByRole("region", { name: "Design review" });
  expect(await within(card).findByText(/Design review is not turned on for your company/u)).toBeTruthy();
  expect(within(card).getByText(/A company owner or admin can allow it in How we work for the company/u)).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Design review settings editor" })).toBeNull();
  expect(screen.queryByLabelText("Design review settings")).toBeNull();
  expect(f.puts).toHaveLength(0);
  f.close();
 }
});

it("DR-FU4: where the company allows it the project chooses Off, Auto or Always, in that order, and a change is saved", async () => {
 const f = setup({ allowed: true, setting: { ...DESIGN_REVIEW_DEFAULT_SETTING, mode: "never" } });
 const editor = await screen.findByRole("region", { name: "Design review settings editor" });
 const select = within(editor).getByRole<HTMLSelectElement>("combobox", { name: "When it runs" });
 const options = [...select.options].filter(option => option.value !== "");
 expect(options.map(option => option.value)).toEqual(["never", "auto", "always"]);
 expect(options[0]!.textContent).toMatch(/^Off:/u);
 expect(select.value).toBe("never");
 fireEvent.change(select, { target: { value: "auto" } });
 fireEvent.click(within(editor).getByRole("button", { name: "Save design review settings" }));
 await waitFor(() => expect(f.puts).toHaveLength(1));
 expect(f.puts[0]!.body.designReview).toMatchObject({ mode: "auto" });
 f.close();
});

it("DR-FU4: a project with no setting shows Off, and there is no text about a company default", async () => {
 const f = setup({ allowed: true, setting: { ...DESIGN_REVIEW_DEFAULT_SETTING, mode: "never" } });
 const editor = await screen.findByRole("region", { name: "Design review settings editor" });
 expect(within(editor).getByRole<HTMLSelectElement>("combobox", { name: "When it runs" }).value).toBe("never");
 expect(screen.queryByText(/company default/u)).toBeNull();
 f.close();
});

it("DR-FU4 L4: a saved setting that couldn't be read shows Off with the words that say so, and a maintainer can choose again", async () => {
 const f = setup({ allowed: true, unreadable: true, setting: { ...DESIGN_REVIEW_DEFAULT_SETTING, mode: "never" } });
 const settings = await screen.findByLabelText("Design review settings");
 expect(within(settings).getByText("Off (the saved setting couldn't be read; choose again)")).toBeTruthy();
 expect(within(settings).queryByText("Off: no design review unless someone asks for design first")).toBeNull();
 const editor = screen.getByRole("region", { name: "Design review settings editor" });
 const select = within(editor).getByRole<HTMLSelectElement>("combobox", { name: "When it runs" });
 expect(select.value).toBe("never");
 fireEvent.change(select, { target: { value: "auto" } });
 fireEvent.click(within(editor).getByRole("button", { name: "Save design review settings" }));
 await waitFor(() => expect(f.puts).toHaveLength(1));
 expect(f.puts[0]!.body.designReview).toMatchObject({ mode: "auto" });
 f.close();
});

it("DR-FU4 L4: someone who can't edit is told who can; a readable Off keeps its plain words", async () => {
 const viewer = setup({ allowed: true, unreadable: true, setting: { ...DESIGN_REVIEW_DEFAULT_SETTING, mode: "never" } }, false);
 expect(await screen.findByText("Off (the saved setting couldn't be read; a project maintainer can choose again)")).toBeTruthy();
 expect(screen.queryByRole("region", { name: "Design review settings editor" })).toBeNull();
 viewer.close();
 const plain = setup({ allowed: true, setting: { ...DESIGN_REVIEW_DEFAULT_SETTING, mode: "never" } });
 expect(within(await screen.findByLabelText("Design review settings")).getByText("Off: no design review unless someone asks for design first")).toBeTruthy();
 expect(screen.queryByText(/couldn't be read/u)).toBeNull();
 plain.close();
});

it("DR-FU4 L4: a maintainer told to choose again can save Off as it stands, without changing the choice first", async () => {
 const f = setup({ allowed: true, unreadable: true, setting: { ...DESIGN_REVIEW_DEFAULT_SETTING, mode: "never" } });
 const editor = await screen.findByRole("region", { name: "Design review settings editor" });
 const save = within(editor).getByRole<HTMLButtonElement>("button", { name: "Save design review settings" });
 expect(save.hasAttribute("disabled")).toBe(false);
 fireEvent.click(save);
 await waitFor(() => expect(f.puts).toHaveLength(1));
 expect(f.puts[0]!.body.designReview).toMatchObject({ mode: "never" });
 f.close();
});

it("DR-FU4 L4: with a readable setting Save stays disabled until something changes (control)", async () => {
 const f = setup({ allowed: true, setting: { ...DESIGN_REVIEW_DEFAULT_SETTING, mode: "never" } });
 const editor = await screen.findByRole("region", { name: "Design review settings editor" });
 expect(within(editor).getByRole<HTMLButtonElement>("button", { name: "Save design review settings" }).hasAttribute("disabled")).toBe(true);
 f.close();
});
