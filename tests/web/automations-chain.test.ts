// @vitest-environment jsdom
// exp/automations: a chain's page: facts and budget, the design and its draft, versions and rollback, publish (including the 202 wait), archive, and adding a trigger.
import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AutomationChainBudgetPutBodySchema, AutomationChainDraftPutBodySchema, AutomationChainPublishBodySchema, AutomationChainRollbackBodySchema, AutomationRequestOnlyBodySchema, AutomationTriggerPutBodySchema } from "@agentx/cloud-contracts";
import { ChainScreen } from "../../packages/ui/src/screens/automations/ChainScreen.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { navFixture } from "./support/fixtures.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { CHAIN_ID, CONFIRM_URL, DESIGN, DEVELOPER, SECOND_DEVELOPER, chainOf, draft, error, people, runList, shares, triggerOf, versions } from "./support/automations-fixture.js";

// jsdom has no ResizeObserver, which the switch in the trigger form measures with.
globalThis.ResizeObserver ??= class { observe(): void { /* none */ } unobserve(): void { /* none */ } disconnect(): void { /* none */ } };
type Write = (request: ApiRequest) => ApiResponse | undefined;
const NO_SHARES = { shares: [] };
function setup(options: { chain?: ReturnType<typeof chainOf>; theme?: "light" | "dark"; write?: Write; id?: string; orgRole?: "owner" | "admin" | "member"; triggers?: ReturnType<typeof triggerOf>[]; shared?: boolean } = {}) {
  const chain = options.chain ?? chainOf(), base = "/v1/app/chains/" + CHAIN_ID;
  const f = fakeHost(async request => {
    if (request.method === "GET") {
      if (request.path === base) return { status: 200, body: { chain, current: { version: 2, definition: DESIGN } } };
      if (request.path === base + "/versions") return { status: 200, body: versions() };
      if (request.path === base + "/draft") return chain.access === "view" || chain.access === "use" ? { status: 403, body: error("FORBIDDEN", "You can't edit this chain.") } : { status: 200, body: draft() };
      if (request.path === base + "/shares") return { status: 200, body: options.shared === false ? NO_SHARES : shares() };
      if (request.path === base + "/triggers") return { status: 200, body: { triggers: options.triggers ?? [triggerOf()] } };
      if (request.path === "/v1/app/projects/payments/people") return { status: 200, body: people() };
      if (request.path.startsWith("/v1/app/chain-runs")) return { status: 200, body: runList() };
      return { status: 404, body: error("NOT_FOUND", "Not found.") };
    }
    return options.write?.(request) ?? { status: 200, body: { chain } };
  });
  const query = createQueryClient(), role = options.orgRole ?? "owner";
  query.setQueryData(["nav"], navFixture({ me: { developerId: DEVELOPER, name: "Priya", orgRole: role } }));
  const router = createMemoryRouter([{ path: "/app/chains/:id", element: h(ChainScreen, {}) }], { initialEntries: ["/app/chains/" + (options.id ?? CHAIN_ID)] });
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Announcer, { children: h(RouterProvider, { router }) }) }) }), { theme: options.theme ?? "light" });
  const writes = () => f.request.mock.calls.map(call => call[0]).filter(request => request.method !== "GET");
  return { ...f, ...ui, writes, close() { ui.unmount();router.dispose();query.clear(); } };
}
afterEach(() => { vi.restoreAllMocks(); });

it("shows the facts, the design that runs, versions, triggers and runs, with every change control for someone who manages the chain", async () => {
  const f = setup();
  await screen.findByRole("heading", { name: "Refund triage", level: 1 });
  expect(await screen.findByText("Sam", { selector: "option" })).toBeTruthy();
  const facts = screen.getByRole("region", { name: "About this chain" });
  expect(within(facts).getByText("Accountable").nextElementSibling?.textContent).toBe("Priya");
  expect(within(facts).getByText("Everyone in the company can look at it")).toBeTruthy();
  expect(within(facts).getByText(/a month/)).toBeTruthy();
  expect(await screen.findByLabelText("Draft design (JSON)")).toBeTruthy();
  expect(screen.getByText("Running now")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Roll back to this" })).toBeTruthy();
  expect(await screen.findByText("GitHub: pull request opened")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Add a trigger" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Archive" })).toBeTruthy();
  expect(await screen.findByRole("list", { name: "Runs" })).toBeTruthy();
  f.close();
});

it("shows someone who can only look the design and history and none of the change controls, in plain words", async () => {
  const f = setup({ chain: chainOf({ access: "view" }) });
  await screen.findByRole("heading", { name: "Refund triage", level: 1 });
  expect(await screen.findByText(/You can look at this chain\./)).toBeTruthy();
  expect(screen.getByText(/Only people who can edit this chain can change it/)).toBeTruthy();
  await screen.findByText("Version 1");
  for (const name of ["Roll back to this", "Add a trigger", "Archive", "Publish", "Save draft", "Save cap", "Pause", "Delete"]) expect(screen.queryByRole("button", { name })).toBeNull();
  expect(screen.queryByLabelText("Draft design (JSON)")).toBeNull();
  expect(f.request.mock.calls.some(call => call[0].path.endsWith("/draft") || call[0].path.endsWith("/shares"))).toBe(false);
  f.close();
});

it("an editor who doesn't manage the chain gets the draft, publish and rollback (while no trigger is on) but not budget, archive or triggers", async () => {
  const f = setup({ chain: chainOf({ access: "edit" }), triggers: [triggerOf({ enabled: false })] });
  expect(await screen.findByLabelText("Draft design (JSON)")).toBeTruthy();
  expect(await screen.findByRole("button", { name: "Roll back to this" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Publish" })).toBeTruthy();
  for (const name of ["Add a trigger", "Archive", "Save cap"]) expect(screen.queryByRole("button", { name })).toBeNull();
  f.close();
});

it("saves the draft under the revision it read, and refuses to publish until it is saved", async () => {
  const f = setup({ write: request => request.path.endsWith("/draft") ? { status: 200, body: { draft: { revision: 4, definition: DESIGN } } } : undefined });
  const editor = await screen.findByLabelText("Draft design (JSON)");
  expect(screen.getByRole("button", { name: "Publish" }).hasAttribute("disabled")).toBe(false);
  fireEvent.change(editor, { target: { value: JSON.stringify({ ...DESIGN, start: "look_into_it" }, null, 1) } });
  expect(screen.getByRole("button", { name: "Publish" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByText("Save the draft before publishing it.")).toBeTruthy();
  fireEvent.change(editor, { target: { value: "{ not json" } });
  expect(await screen.findByText("This isn't valid JSON yet.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Save draft" }).hasAttribute("disabled")).toBe(true);
  fireEvent.change(editor, { target: { value: JSON.stringify(DESIGN) + " " } });
  fireEvent.change(editor, { target: { value: JSON.stringify({ ...DESIGN, steps: DESIGN.steps }) } });
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  expect(await screen.findByText("The draft is saved. Nothing runs from it until it is published.")).toBeTruthy();
  const [put] = f.writes();
  expect(put).toMatchObject({ method: "PUT", path: `/v1/app/chains/${CHAIN_ID}/draft` });
  expect(AutomationChainDraftPutBodySchema.parse(put!.body)).toMatchObject({ expectedRevision: 3, definition: DESIGN });
  f.close();
});

it("publish answers 202: it says Waiting for an admin to confirm with the link, and does not say published", async () => {
  const f = setup({ write: request => request.path.endsWith("/publish") ? { status: 202, body: { status: "NEEDS_CONFIRMATION", confirmUrl: CONFIRM_URL, changes: ["Lets Refund triage use a new tool"] } } : undefined });
  await screen.findByLabelText("Draft design (JSON)");
  fireEvent.change(screen.getByLabelText("Note for this version"), { target: { value: "  Wider tools  " } });
  fireEvent.click(screen.getByRole("button", { name: "Publish" }));
  expect(await screen.findByText("Waiting for an admin to confirm")).toBeTruthy();
  expect(screen.getByText("Lets Refund triage use a new tool")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open the confirmation page" }));
  expect(f.host.openExternal).toHaveBeenCalledWith(CONFIRM_URL);
  expect(AutomationChainPublishBodySchema.parse(f.writes()[0]!.body)).toMatchObject({ expectedDraftRevision: 3, note: "Wider tools" });
  expect(screen.queryByText(/Published as version/)).toBeNull();
  f.close();
});

it("a publish that goes through says which version and lists the triggers it turned off", async () => {
  const f = setup({ write: request => request.path.endsWith("/publish") ? { status: 200, body: { version: { version: 3 }, chain: chainOf(), disabledTriggers: [{ triggerId: "ctr_" + "b".repeat(20), problems: [{ path: "x", message: "Refund triage needs a monthly budget." }] }] } } : undefined });
  await screen.findByLabelText("Draft design (JSON)");
  fireEvent.click(screen.getByRole("button", { name: "Publish" }));
  expect(await screen.findByText("Published as version 3. New runs use it.")).toBeTruthy();
  expect(screen.getByText("A trigger was turned off: Refund triage needs a monthly budget.")).toBeTruthy();
  f.close();
});

it("a stale draft is refused in the server's words and the latest can be reloaded", async () => {
  const f = setup({ write: request => request.path.endsWith("/draft") ? { status: 409, body: error("CHAIN_REVISION_CONFLICT", "Someone else changed this draft. Reload it and try again.") } : undefined });
  const editor = await screen.findByLabelText("Draft design (JSON)");
  fireEvent.change(editor, { target: { value: JSON.stringify(DESIGN, null, 4) } });
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Someone else changed this draft. Reload it and try again.");
  fireEvent.click(screen.getByRole("button", { name: "Reload the latest draft" }));
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Reload the latest draft?" })).getByRole("button", { name: "Replace my text" }));
  await waitFor(() => expect((screen.getByLabelText<HTMLTextAreaElement>("Draft design (JSON)")).value).toBe(JSON.stringify(DESIGN, null, 2)));
  f.close();
});

it("rolls back through an in-page question, and a held rollback shows the waiting words", async () => {
  const f = setup({ write: request => request.path.endsWith("/rollback") ? { status: 202, body: { status: "NEEDS_CONFIRMATION", confirmUrl: CONFIRM_URL, changes: ["Version 1 allows more than version 2"] } } : undefined });
  fireEvent.click(await screen.findByRole("button", { name: "Roll back to this" }));
  const dialog = await screen.findByRole("dialog", { name: "Run version 1 again?" });
  expect(f.writes()).toEqual([]);
  fireEvent.click(within(dialog).getByRole("button", { name: "Roll back" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(await screen.findByText("Waiting for an admin to confirm")).toBeTruthy();
  expect(AutomationChainRollbackBodySchema.parse(f.writes()[0]!.body)).toMatchObject({ version: 1 });
  f.close();
});

it("archives only after the question and unarchives at once", async () => {
  const f = setup({ write: () => ({ status: 200, body: { chain: chainOf({ status: "archived" }) } }) });
  fireEvent.click(await screen.findByRole("button", { name: "Archive" }));
  const dialog = await screen.findByRole("dialog", { name: "Archive this chain?" });
  expect(f.writes()).toEqual([]);
  fireEvent.click(within(dialog).getByRole("button", { name: "Archive chain" }));
  await waitFor(() => expect(f.writes()).toHaveLength(1));
  expect(f.writes()[0]).toMatchObject({ method: "POST", path: `/v1/app/chains/${CHAIN_ID}/archive` });
  AutomationRequestOnlyBodySchema.parse(f.writes()[0]!.body);
  f.close();
  const g = setup({ chain: chainOf({ status: "archived" }), write: () => ({ status: 200, body: { chain: chainOf() } }) });
  fireEvent.click(await screen.findByRole("button", { name: "Unarchive" }));
  await waitFor(() => expect(g.writes()).toHaveLength(1));
  expect(g.writes()[0]!.path).toBe(`/v1/app/chains/${CHAIN_ID}/unarchive`);
  expect(screen.getByRole("button", { name: "Publish" }).hasAttribute("disabled")).toBe(true);
  g.close();
});

it("sets and clears the spending cap, and a cap held for an admin says so with the server's message", async () => {
  const f = setup({ write: () => ({ status: 200, body: { chain: chainOf({ monthlyBudgetUsd: 75 }), disabledTriggers: [] } }) });
  const field = await screen.findByLabelText("Monthly spending cap, in US dollars");
  fireEvent.change(field, { target: { value: "75" } });
  fireEvent.click(screen.getByRole("button", { name: "Save cap" }));
  expect(await screen.findByText("The spending cap is saved.")).toBeTruthy();
  expect(AutomationChainBudgetPutBodySchema.parse(f.writes()[0]!.body)).toMatchObject({ monthlyUsd: 75 });
  fireEvent.click(screen.getByRole("button", { name: "Remove cap" }));
  await waitFor(() => expect(f.writes()).toHaveLength(2));
  expect(AutomationChainBudgetPutBodySchema.parse(f.writes()[1]!.body).monthlyUsd).toBeNull();
  f.close();
  const g = setup({ write: () => ({ status: 202, body: { status: "NEEDS_ADMIN_APPROVAL", spendRequestId: "spr_" + "a".repeat(20), message: "This is over your total. An admin has been asked." } }) });
  fireEvent.change(await g.findByLabelText("Monthly spending cap, in US dollars"), { target: { value: "5000" } });
  fireEvent.click(screen.getByRole("button", { name: "Save cap" }));
  expect(await screen.findByText("Waiting for an admin to approve")).toBeTruthy();
  expect(screen.getByText("This is over your total. An admin has been asked.")).toBeTruthy();
  g.close();
});

it("changes who is accountable to another maintainer, and shows a company-shared refusal as the server wrote it", async () => {
  const sentence = "Only an owner or admin can change who is accountable for a company-shared chain.";
  const f = setup({ write: () => ({ status: 403, body: error("FORBIDDEN", sentence) }) });
  const select = await screen.findByLabelText("Who is accountable");
  await screen.findByText("Sam", { selector: "option" });
  expect(within(select).queryByText("Viewer Vi")).toBeNull();
  fireEvent.change(select, { target: { value: SECOND_DEVELOPER } });
  fireEvent.click(screen.getByRole("button", { name: "Change who is accountable" }));
  const alert = await screen.findByRole("alert");
  expect(within(alert).getByText("You can't change this.")).toBeTruthy();
  expect(within(alert).getByText(sentence)).toBeTruthy();
  expect(f.writes()[0]).toMatchObject({ method: "PUT", path: `/v1/app/chains/${CHAIN_ID}/accountable`, body: { accountable: { developerId: SECOND_DEVELOPER } } });
  void DEVELOPER;
  f.close();
});

it("adds a trigger paused, with a new id, a body the contract accepts, and no confirmation needed", async () => {
  const f = setup({ write: request => request.method === "PUT" && request.path.includes("/triggers/") ? { status: 201, body: { trigger: triggerOf({ enabled: false }) } } : undefined });
  fireEvent.click(await screen.findByRole("button", { name: "Add a trigger" }));
  const dialog = await screen.findByRole("dialog", { name: "Add a trigger" });
  fireEvent.change(within(dialog).getByLabelText("What starts it"), { target: { value: "schedule" } });
  fireEvent.change(within(dialog).getByLabelText("Time"), { target: { value: "09:30" } });
  fireEvent.change(within(dialog).getByLabelText("Time zone"), { target: { value: "Europe/Berlin" } });
  fireEvent.click(within(dialog).getByRole("switch", { name: "Turn it on now" }));
  expect(within(dialog).getByText(/Every day at 09:30 \(Europe\/Berlin\)/)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Add trigger" }));
  expect(await screen.findByText("The trigger is saved and paused.")).toBeTruthy();
  const [put] = f.writes();
  expect(put!.path).toMatch(new RegExp(`^/v1/app/chains/${CHAIN_ID}/triggers/ctr_[0-9a-z]{20}$`));
  expect(AutomationTriggerPutBodySchema.parse(put!.body)).toMatchObject({ project: "payments", enabled: false, spec: { kind: "schedule", schedule: { kind: "daily", at: "09:30" }, timezone: "Europe/Berlin", missed: "run_once" } });
  f.close();
});

it("adds an event trigger turned on: the 202 wait shows with the link", async () => {
  const f = setup({ write: request => request.method === "PUT" && request.path.includes("/triggers/") ? { status: 202, body: { status: "NEEDS_CONFIRMATION", confirmUrl: CONFIRM_URL, changes: ["turn on a GitHub trigger for payments"] } } : undefined });
  fireEvent.click(await screen.findByRole("button", { name: "Add a trigger" }));
  const dialog = await screen.findByRole("dialog", { name: "Add a trigger" });
  fireEvent.change(within(dialog).getByLabelText("Tool"), { target: { value: "sentry" } });
  fireEvent.change(within(dialog).getByLabelText("What happens"), { target: { value: "alert.triggered" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Add trigger" }));
  expect(await screen.findByText("Waiting for an admin to confirm")).toBeTruthy();
  expect(AutomationTriggerPutBodySchema.parse(f.writes()[0]!.body)).toMatchObject({ enabled: true, spec: { kind: "event", source: "sentry", type: "alert.triggered" } });
  f.close();
});

it("an unknown chain address is not found, with no request", async () => {
  const f = setup({ id: "not-a-chain" });
  expect(await screen.findByRole("heading", { name: /not found/i })).toBeTruthy();
  expect(f.request).not.toHaveBeenCalled();
  f.close();
});

for (const theme of ["light", "dark"] as const) it("has an accessible chain page in " + theme, async () => {
  const f = setup({ theme });
  await screen.findByLabelText("Draft design (JSON)");
  await screen.findByText("GitHub: pull request opened");
  await expectNoAxeViolations(f.container);
  f.close();
});

// ---- review fixes (M1 to M3, L1 to L7)

const base = "/v1/app/chains/" + CHAIN_ID;
it("a draft with unsaved text asks before \"Reload the latest draft\" replaces it, and a clean draft reloads at once", async () => {
  const f = setup();
  const editor = await screen.findByLabelText<HTMLTextAreaElement>("Draft design (JSON)");
  fireEvent.click(screen.getByRole("button", { name: "Reload the latest draft" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(f.request.mock.calls.filter(call => call[0].path === base + "/draft").length).toBeGreaterThan(1));
  const mine = JSON.stringify({ ...DESIGN, start: "mine" }, null, 2);
  fireEvent.change(screen.getByLabelText("Draft design (JSON)"), { target: { value: mine } });
  const reload = screen.getByRole("button", { name: "Reload the latest draft" });
  fireEvent.click(reload);
  const dialog = await screen.findByRole("dialog", { name: "Reload the latest draft?" });
  expect(within(dialog).getByText("This replaces your unsaved text.")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByLabelText<HTMLTextAreaElement>("Draft design (JSON)").value).toBe(mine);
  await waitFor(() => expect(document.activeElement).toBe(reload));
  fireEvent.click(reload);
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Reload the latest draft?" })).getByRole("button", { name: "Replace my text" }));
  await waitFor(() => expect(screen.getByLabelText<HTMLTextAreaElement>("Draft design (JSON)").value).toBe(JSON.stringify(DESIGN, null, 2)));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Draft design (JSON)")));
  void editor;
  f.close();
});

it("returns focus to the opening button when the Archive, rollback and Add a trigger dialogs close", async () => {
  const f = setup();
  const archive = await screen.findByRole("button", { name: "Archive" });
  fireEvent.click(archive);
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Archive this chain?" })).getByRole("button", { name: "Keep it" }));
  await waitFor(() => expect(document.activeElement).toBe(archive));
  const rollback = await screen.findByRole("button", { name: "Roll back to this" });
  fireEvent.click(rollback);
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Run version 1 again?" })).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(document.activeElement).toBe(rollback));
  const add = screen.getByRole("button", { name: "Add a trigger" });
  fireEvent.click(add);
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Add a trigger" })).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(document.activeElement).toBe(add));
  f.close();
});

it("after Archive goes through, its button is gone, so focus lands on the chain's facts rather than the page body", async () => {
  const f = setup({ write: () => ({ status: 200, body: { chain: chainOf({ status: "archived" }) } }) });
  fireEvent.click(await screen.findByRole("button", { name: "Archive" }));
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Archive this chain?" })).getByRole("button", { name: "Archive chain" }));
  await waitFor(() => expect(f.writes()).toHaveLength(1));
  await waitFor(() => expect(document.activeElement).not.toBe(document.body));
  f.close();
});

it("hides the accountable picker on a company-shared chain unless the person is an org owner or admin", async () => {
  const member = setup({ orgRole: "member" });
  await screen.findByText("Everyone in the company can look at it");
  expect(screen.queryByLabelText("Who is accountable")).toBeNull();
  expect(screen.getByText("Only an owner or admin can change who is accountable for a company-shared chain.")).toBeTruthy();
  member.close();
  const admin = setup({ orgRole: "admin" });
  expect(await screen.findByLabelText("Who is accountable")).toBeTruthy();
  admin.close();
  const unshared = setup({ orgRole: "member", shared: false });
  expect(await screen.findByLabelText("Who is accountable")).toBeTruthy();
  unshared.close();
});

it("says \"an admin\" only for a company-shared chain; a chain that is not shared waits for \"confirmation\"", async () => {
  const held = (request: ApiRequest): ApiResponse | undefined => request.path.endsWith("/publish") ? { status: 202, body: { status: "NEEDS_CONFIRMATION", confirmUrl: CONFIRM_URL, changes: [] } } : undefined;
  const shared = setup({ write: held });
  await screen.findByLabelText("Draft design (JSON)");
  await screen.findByText("Everyone in the company can look at it");
  fireEvent.click(screen.getByRole("button", { name: "Publish" }));
  expect(await screen.findByText("Waiting for an admin to confirm")).toBeTruthy();
  shared.close();
  const alone = setup({ write: held, shared: false });
  await screen.findByLabelText("Draft design (JSON)");
  await screen.findByText("Nobody else");
  fireEvent.click(screen.getByRole("button", { name: "Publish" }));
  expect(await screen.findByText("Waiting for confirmation")).toBeTruthy();
  expect(screen.queryByText(/admin to/)).toBeNull();
  alone.close();
});

it("publishing a draft that is what already runs says nothing changed and which version keeps running", async () => {
  const f = setup({ write: request => request.path.endsWith("/publish") ? { status: 200, body: { version: { version: 2 }, chain: chainOf(), disabledTriggers: [] } } : undefined });
  await screen.findByLabelText("Draft design (JSON)");
  fireEvent.click(screen.getByRole("button", { name: "Publish" }));
  expect(await screen.findByText("No change; version 2 keeps running.")).toBeTruthy();
  expect(screen.queryByText(/Published as version/)).toBeNull();
  f.close();
});

it("while the chain has a trigger on, someone who only edits it can save the draft but not publish or roll back", async () => {
  const f = setup({ chain: chainOf({ access: "edit" }) });
  expect(await screen.findByLabelText("Draft design (JSON)")).toBeTruthy();
  await screen.findByText("GitHub: pull request opened");
  expect(screen.getByText("This chain has triggers turned on, so only people who manage it can publish or roll back.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Roll back to this" })).toBeNull();
  expect(screen.getByRole("button", { name: "Save draft" })).toBeTruthy();
  f.close();
  // A manager is not held by it (positive control).
  const manager = setup({ chain: chainOf({ access: "manage" }) });
  expect(await screen.findByRole("button", { name: "Publish" })).toBeTruthy();
  expect(await screen.findByRole("button", { name: "Roll back to this" })).toBeTruthy();
  manager.close();
});

it("editing a trigger that waits on an intake event (issues.labeled) shows its type, not a blank choice", async () => {
  const labeled = triggerOf({ spec: { kind: "event", source: "github", type: "issues.labeled", filter: { label: ["bug"] } } });
  const f = setup({ triggers: [labeled] });
  fireEvent.click(await screen.findByRole("button", { name: "Change" }));
  const dialog = await screen.findByRole("dialog", { name: "Change this trigger" });
  expect(within(dialog).getByLabelText<HTMLSelectElement>("What happens").value).toBe("issues.labeled");
  f.close();
});
