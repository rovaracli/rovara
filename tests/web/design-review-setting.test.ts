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
interface World { allowed?: boolean | undefined; inherited?: boolean | undefined; setting?: DesignReviewSetting | undefined; locked?: string[] | undefined; groups?: boolean | undefined; revision?: number; process?: unknown }
function setup(world: World = {}, canEdit = true, filter: "all" | "changed" | "locked" = "all") {
 const state = { ...world }, puts: Array<{ path: string; body: Record<string, unknown> }> = [];
 const answer = () => ({ ...(state.allowed === undefined ? {} : { designReviewAllowed: state.allowed }), ...(state.inherited === undefined ? {} : { designReviewInherited: state.inherited }), playbook: { revision: state.revision ?? 4, defaultProcess: state.process ?? { kind: "builtin" }, ...(state.setting === undefined || state.allowed === false ? {} : { designReview: state.setting }) }, ...(state.locked === undefined ? {} : { designReviewLocked: state.locked }), ...(state.groups === undefined ? {} : { designReviewGroups: state.groups }) });
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
 expect(within(card).getByText("$10.00. Above it, a person decides.")).toBeTruthy();
 expect(within(card).getByText(/project maintainers/u)).toBeTruthy();
 f.close();
});

it("reads a locked field as read-only with the reason, and the page can still change the others", async () => {
 const f = setup({ setting: { ...DESIGN_REVIEW_DEFAULT_SETTING, mode: "always", allowSkip: false }, locked: ["designReview.mode", "designReview.allowSkip"] });
 const editor = await screen.findByRole("region", { name: "Design review settings editor" });
 expect(within(editor).getByLabelText("When it runs").hasAttribute("disabled")).toBe(true);
 expect(within(editor).getByLabelText("Allow skipping design review").hasAttribute("disabled")).toBe(true);
 expect(within(editor).getByLabelText("Tier").hasAttribute("disabled")).toBe(false);
 expect(within(editor).getAllByText("Your company has locked this setting. A company admin can change it.")).toHaveLength(2);
 expect(screen.getAllByText("Locked by company").length).toBeGreaterThan(0);
 expect(screen.getByText("Your company locks some of these settings. Locked settings are read-only.")).toBeTruthy();
 // The save sends the locked values as shown (the held ones), with only the tier changed.
 fireEvent.change(within(editor).getByLabelText("Tier"), { target: { value: "thorough" } });
 fireEvent.click(within(editor).getByRole("button", { name: "Save design review settings" }));
 await waitFor(() => expect(f.puts).toHaveLength(1));
 expect(f.puts[0]!.body).toMatchObject({ expectedRevision: 4, defaultProcess: { kind: "builtin" }, designReview: { mode: "always", tier: "thorough", allowSkip: false, capUsdPerTask: 10, highRiskApprover: { kind: "maintainers" } } });
 expect(await screen.findByText("Saved. New design reviews use these settings; running ones keep theirs.")).toBeTruthy();
 f.close();
});

it("locks every field when the company lock cannot be read, and offers nothing to save", async () => {
 const all = ["designReview.mode", "designReview.tier", "designReview.allowSkip", "designReview.capUsdPerTask", "designReview.highRiskApprover"];
 const f = setup({ setting: { ...DESIGN_REVIEW_DEFAULT_SETTING, mode: "always", allowSkip: false }, locked: all });
 const editor = await screen.findByRole("region", { name: "Design review settings editor" });
 for (const label of ["When it runs", "Tier", "Allow skipping design review", "Cost limit per task (USD)", "Who approves a high-risk design"]) expect(within(editor).getByLabelText(label).hasAttribute("disabled")).toBe(true);
 expect(screen.getByText("Your company controls every design review setting here.")).toBeTruthy();
 expect(within(editor).getByRole("button", { name: "Save design review settings" }).hasAttribute("disabled")).toBe(true);
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
 expect(lockedSet(["designReview.mode", "nonsense"])).toEqual(new Set(["mode"]));
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

it("DR-FU4: a project that follows the company default says so, and the note goes once it has its own setting", async () => {
 const f = setup({ allowed: true, inherited: true, setting: { ...DESIGN_REVIEW_DEFAULT_SETTING, mode: "never" } });
 const card = await screen.findByRole("region", { name: "Design review" });
 expect(await within(card).findByText("This project follows the company default. Saving any design review setting here makes it the project's own.")).toBeTruthy();
 f.close();
 const own = setup({ allowed: true, setting: { ...DESIGN_REVIEW_DEFAULT_SETTING, mode: "never" } });
 await screen.findByText("Who does it");
 expect(screen.queryByText(/follows the company default/u)).toBeNull();
 own.close();
});
