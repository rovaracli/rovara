// @vitest-environment jsdom
// exp/automations: the project's Automations tab and the trigger row: who sees which buttons, the states in words, pause, resume (202), delete (an in-page question), activity and refusals.
import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AutomationTriggerPutBodySchema, AutomationRequestOnlyBodySchema } from "@agentx/cloud-contracts";
import { AutomationsTab } from "../../packages/ui/src/screens/automations/AutomationsTab.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { outcomeWords, specWords, triggerState, WAITING_REASON } from "../../packages/ui/src/screens/automations/automation-text.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { CHAIN_ID, OTHER_CHAIN_ID, CONFIRM_URL, RUN_ID, TRIGGER_ID, error, projectAutomations, runList, triggerOf } from "./support/automations-fixture.js";

// jsdom has no ResizeObserver, which the switch in the trigger form measures with.
globalThis.ResizeObserver ??= class { observe(): void { /* none */ } unobserve(): void { /* none */ } disconnect(): void { /* none */ } };
type Answer = (request: ApiRequest) => ApiResponse | undefined;
function setup(options: { automations?: unknown; theme?: "light" | "dark"; write?: Answer; activity?: unknown; activityStatus?: number } = {}) {
  let automations: unknown = options.automations ?? projectAutomations();
  const f = fakeHost(async request => {
    if (request.method === "GET" && request.path === "/v1/app/projects/payments/automations") return { status: 200, body: automations };
    if (request.method === "GET" && request.path.startsWith("/v1/app/chain-runs")) return { status: 200, body: runList() };
    if (request.method === "GET" && request.path.endsWith("/activity")) return { status: options.activityStatus ?? 200, body: options.activity ?? { activity: [] } };
    return options.write?.(request) ?? { status: 200, body: { trigger: triggerOf() } };
  });
  const query = createQueryClient(), ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h(Announcer, { children: h(AutomationsTab, { project: "payments" }) }) }) }) }), { theme: options.theme ?? "light" });
  const writes = () => f.request.mock.calls.map(call => call[0]).filter(request => request.method !== "GET");
  return { ...f, ...ui, writes, answer(next: unknown) { automations = next; }, close() { ui.unmount();query.clear(); } };
}
afterEach(() => { vi.restoreAllMocks(); });

it("says each trigger's state in words: on, paused, waiting for an admin, and turned off with the server's reason", () => {
  expect(triggerState(triggerOf())).toEqual({ kind: "on", words: "On" });
  expect(triggerState(triggerOf({ enabled: false }))).toEqual({ kind: "paused", words: "Paused" });
  expect(triggerState(triggerOf({ enabled: false, disabledReason: WAITING_REASON }))).toEqual({ kind: "waiting", words: "Waiting for confirmation" });
  expect(triggerState(triggerOf({ enabled: false, disabledReason: WAITING_REASON }), true)).toEqual({ kind: "waiting", words: "Waiting for an admin to confirm" });
  expect(triggerState(triggerOf({ enabled: false, disabledReason: "Refund triage needs a monthly budget." }))).toEqual({ kind: "refused", words: "Turned off", reason: "Refund triage needs a monthly budget." });
  expect(specWords(triggerOf().spec)).toBe("GitHub: pull request opened");
  expect(specWords(triggerOf({ spec: { kind: "schedule", schedule: { kind: "daily", at: "09:30" }, timezone: "Europe/Berlin", missed: "run_once" } }).spec)).toBe("Every day at 09:30 (Europe/Berlin)");
  expect(specWords(triggerOf({ spec: { kind: "schedule", schedule: { kind: "interval", minutes: 30 }, timezone: "UTC", missed: "skip" } }).spec)).toBe("Every 30 minutes");
});

it("words an activity outcome plainly, and shows a reason it has no words for as the server sent it", () => {
  expect(outcomeWords("skipped", "trigger_turned_off")).toBe("Skipped: turned off");
  expect(outcomeWords("failed", "CHAIN_BUDGET_REQUIRED")).toBe("Failed: needs a spending cap");
  expect(outcomeWords("started")).toBe("Started a run");
  expect(outcomeWords("skipped", "Something new the server says")).toBe("Skipped: Something new the server says");
});

it("lists chains, triggers with state and last result, and recent runs, with every change button for someone who can edit", async () => {
  const f = setup();
  expect((await screen.findAllByRole("link", { name: "Refund triage" })).map(link => link.getAttribute("href"))).toEqual(["/app/chains/" + CHAIN_ID, "/app/chains/" + CHAIN_ID]);
  const trigger = (await screen.findByText("GitHub: pull request opened")).closest("li")!;
  expect(within(trigger).getByText("On")).toBeTruthy();
  expect(within(trigger).getByText(/Last started/)).toBeTruthy();
  expect(within(trigger).getByRole("link", { name: "Open the run" }).getAttribute("href")).toBe("/app/sessions/" + RUN_ID);
  for (const name of ["Pause", "Change", "Delete", "Activity"]) expect(within(trigger).getByRole("button", { name })).toBeTruthy();
  expect(screen.getByRole("button", { name: "New chain" })).toBeTruthy();
  expect(screen.queryByText("Only maintainers can change automations.")).toBeNull();
  expect((await screen.findByRole("list", { name: "Runs" })).textContent).toContain("Finished");
  f.close();
});

it("shows read-only people the list with plain words and none of the change buttons", async () => {
  const f = setup({ automations: projectAutomations({ canEdit: false, triggers: [{ ...triggerOf({ enabled: false }), targetName: "Refund triage" }] }) });
  expect((await screen.findByText("Only maintainers can change automations.")).getAttribute("role")).toBe("note");
  const trigger = (await screen.findByText("GitHub: pull request opened")).closest("li")!;
  expect(within(trigger).getByText("Paused")).toBeTruthy();
  for (const name of ["Pause", "Resume", "Change", "Delete"]) expect(within(trigger).queryByRole("button", { name })).toBeNull();
  expect(screen.queryByRole("button", { name: "New chain" })).toBeNull();
  expect(within(trigger).getByRole("button", { name: "Activity" })).toBeTruthy();
  f.close();
});

it("pauses at once: one PUT with enabled false and the same spec, hook and rate, with a request id the contract accepts", async () => {
  const f = setup({ write: () => ({ status: 200, body: { trigger: triggerOf({ enabled: false }) } }) });
  fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
  expect(await screen.findByText("Paused. It won't start anything until it is resumed.")).toBeTruthy();
  const [put, ...rest] = f.writes();
  expect(rest).toEqual([]);
  expect(put).toMatchObject({ method: "PUT", path: `/v1/app/chains/${CHAIN_ID}/triggers/${TRIGGER_ID}` });
  const body = AutomationTriggerPutBodySchema.parse(put!.body);
  expect(body).toMatchObject({ enabled: false, project: "payments", maxRunsPerHour: 30, spec: { kind: "event", source: "github", type: "pull_request.opened" } });
  f.close();
});

it("resume answers 202: it says Waiting for confirmation (the chain is not known to be company-shared here) and offers the link, and nothing is shown as on", async () => {
  const paused = projectAutomations({ triggers: [{ ...triggerOf({ enabled: false }), targetName: "Refund triage" }] });
  const f = setup({ automations: paused, write: () => ({ status: 202, body: { status: "NEEDS_CONFIRMATION", confirmUrl: CONFIRM_URL, changes: ["turn on a GitHub trigger for payments"] } }) });
  fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
  expect(await screen.findByText("Waiting for confirmation")).toBeTruthy();
  expect(screen.queryByText(/an admin/)).toBeNull();
  expect(screen.getByText("turn on a GitHub trigger for payments")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open the confirmation page" }));
  expect(f.host.openExternal).toHaveBeenCalledWith(CONFIRM_URL);
  expect(f.writes()[0]!.body).toMatchObject({ enabled: true });
  expect(screen.queryByText("It is on.")).toBeNull();
  f.close();
});

it("never offers a confirmation link that is not this app's own", async () => {
  const paused = projectAutomations({ triggers: [{ ...triggerOf({ enabled: false }), targetName: "Refund triage" }] });
  const f = setup({ automations: paused, write: () => ({ status: 202, body: { status: "NEEDS_CONFIRMATION", confirmUrl: "https://evil.example/v1/app/approve/apr_x", changes: [] } }) });
  fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
  expect(await screen.findByText("Waiting for confirmation")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Open the confirmation page" })).toBeNull();
  f.close();
});

it("shows a trigger that waits for confirmation, or was turned off, with its reason, and the right button", async () => {
  const f = setup({ automations: projectAutomations({ triggers: [
    { ...triggerOf({ enabled: false, disabledReason: WAITING_REASON }), targetName: "Refund triage" },
    { ...triggerOf({ triggerId: "ctr_" + "9".repeat(20), enabled: false, disabledReason: "Refund triage needs a monthly budget." }), targetName: "Refund triage" },
  ] }) });
  expect(await screen.findByText("Waiting for confirmation")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Ask again" })).toBeTruthy();
  expect(screen.getByText("Turned off")).toBeTruthy();
  expect(screen.getByText(/Why: Refund triage needs a monthly budget\./)).toBeTruthy();
  f.close();
});

it("deletes only after an in-page question, never with window.confirm", async () => {
  const confirm = vi.spyOn(window, "confirm");
  const f = setup({ write: () => ({ status: 200, body: { deleted: true } }) });
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  const dialog = await screen.findByRole("dialog", { name: "Delete this trigger?" });
  expect(f.writes()).toEqual([]);
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete trigger" }));
  await waitFor(() => expect(f.writes()).toHaveLength(1));
  expect(f.writes()[0]).toMatchObject({ method: "DELETE", path: `/v1/app/chains/${CHAIN_ID}/triggers/${TRIGGER_ID}` });
  AutomationRequestOnlyBodySchema.parse(f.writes()[0]!.body);
  expect(confirm).not.toHaveBeenCalled();
  f.close();
});

it("Keep it closes the question and sends nothing", async () => {
  const f = setup();
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Delete this trigger?" })).getByRole("button", { name: "Keep it" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(f.writes()).toEqual([]);
  f.close();
});

it("lists a trigger's activity with outcomes in plain words and links to the run or task", async () => {
  const task = "ses_" + "7".repeat(20);
  const f = setup({ activity: { activity: [
    { at: "2026-11-11T08:00:00.000Z", eventKey: "pull_request#12", outcome: "started", runId: RUN_ID },
    { at: "2026-11-11T07:00:00.000Z", eventKey: "pull_request#11", outcome: "skipped", reason: "trigger_turned_off" },
    { at: "2026-11-11T06:00:00.000Z", eventKey: "pull_request#10", outcome: "failed", reason: "CHAIN_BUDGET_REQUIRED" },
    { at: "2026-11-11T05:00:00.000Z", eventKey: "pull_request#9", outcome: "started", taskId: task },
  ] } });
  fireEvent.click(await screen.findByRole("button", { name: "Activity" }));
  const list = await screen.findByRole("list", { name: "Activity" });
  expect(within(list).getByText("Skipped: turned off")).toBeTruthy();
  expect(within(list).getByText("Failed: needs a spending cap")).toBeTruthy();
  expect(within(list).getByRole("link", { name: "Open the run" }).getAttribute("href")).toBe("/app/sessions/" + RUN_ID);
  expect(within(list).getByRole("link", { name: "Open the task" }).getAttribute("href")).toBe("/app/sessions/" + task);
  f.close();
});

it("a 403 says plainly that this can't be changed, then shows the server's sentence word for word", async () => {
  const sentence = "Refund triage has triggers turned on, so changing the version it runs needs an owner or admin.";
  const f = setup({ write: () => ({ status: 403, body: error("FORBIDDEN", sentence) }) });
  fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
  const alert = await screen.findByRole("alert");
  expect(within(alert).getByText("You can't change this.")).toBeTruthy();
  expect(within(alert).getByText(sentence)).toBeTruthy();
  f.close();
});

it("another refusal is the server's sentence alone, and REAUTH_REQUIRED offers Sign in again", async () => {
  const paused = projectAutomations({ triggers: [{ ...triggerOf({ enabled: false }), targetName: "Refund triage" }] });
  const f = setup({ automations: paused, write: () => ({ status: 409, body: error("CHAIN_BUDGET_REQUIRED", "Refund triage can't start runs on its own without a monthly budget.") }) });
  fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe("Refund triage can't start runs on its own without a monthly budget.");
  f.close();
  const g = setup({ write: () => ({ status: 403, body: error("REAUTH_REQUIRED", "Sign in again to change this.") }) });
  fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
  fireEvent.click(await screen.findByRole("button", { name: "Sign in again" }));
  expect(g.host.signIn).toHaveBeenCalled();
  g.close();
});

for (const theme of ["light", "dark"] as const) it("has an accessible Automations tab in " + theme, async () => {
  const f = setup({ theme });
  await screen.findByText("GitHub: pull request opened");
  await expectNoAxeViolations(f.container);
  f.close();
});

it("keeps a trigger on an agent readable, with no change buttons (those are the chain's)", async () => {
  const agent = { ...triggerOf({ target: { kind: "agent", agentId: "agt_" + "a".repeat(20) } as never }), targetName: "Payments expert" };
  const f = setup({ automations: projectAutomations({ triggers: [agent] }) });
  const row = (await screen.findByText("GitHub: pull request opened")).closest("li")!;
  expect(within(row).getByText(/Payments expert/)).toBeTruthy();
  for (const name of ["Pause", "Change", "Delete", "Activity"]) expect(within(row).queryByRole("button", { name })).toBeNull();
  f.close();
});

const chainRow = (chainId: string, name: string, access: "view" | "use" | "edit" | "manage") => ({ chainId, name, description: "", owner: { kind: "project", project: "payments" }, currentVersion: 1, status: "active", access });
const spec = (source: string, type: string) => ({ kind: "event", source, type }) as never;

it("offers Pause, Change and Delete only on triggers of chains the person manages, never on the project's canEdit alone, and never on a chain they can't see", async () => {
  const editable = "ctr_" + "1".repeat(20), managed = "ctr_" + "2".repeat(20), hidden = "ctr_" + "3".repeat(20);
  const f = setup({ automations: projectAutomations({
    canEdit: true,
    chains: [chainRow(CHAIN_ID, "Edit-only chain", "edit"), chainRow(OTHER_CHAIN_ID, "Managed chain", "manage")] as never,
    triggers: [
      { ...triggerOf({ triggerId: editable, spec: spec("github", "pull_request.opened") }), targetName: "Edit-only chain" },
      { ...triggerOf({ triggerId: managed, spec: spec("linear", "issue.created"), target: { kind: "chain", chainId: OTHER_CHAIN_ID } }), targetName: "Managed chain" },
      { ...triggerOf({ triggerId: hidden, spec: spec("sentry", "alert.triggered"), target: { kind: "chain", chainId: "chn_" + "e".repeat(20) } }) },
    ],
  }) });
  const rowOf = async (text: string) => (await screen.findByText(text)).closest("li")!;
  const edit = await rowOf("GitHub: pull request opened"), manage = await rowOf("Linear: issue created"), unseen = await rowOf("Sentry: alert triggered");
  for (const name of ["Pause", "Change", "Delete"]) {
    expect(within(edit).queryByRole("button", { name }), "edit-level chain: " + name).toBeNull();
    expect(within(manage).queryByRole("button", { name }), "managed chain: " + name).toBeTruthy();
    expect(within(unseen).queryByRole("button", { name }), "chain not visible: " + name).toBeNull();
  }
  expect(within(unseen).getByText(/a chain you can't see/)).toBeTruthy();
  expect(within(unseen).queryByRole("button", { name: "Activity" })).toBeNull();
  expect(within(unseen).queryByRole("link", { name: /chain/ })).toBeNull();
  expect(within(edit).getByRole("button", { name: "Activity" })).toBeTruthy();
  f.close();
});

it("returns focus to the button that opened a dialog when it closes: New chain, Change, Delete (kept)", async () => {
  const f = setup();
  const newChain = await screen.findByRole("button", { name: "New chain" });
  fireEvent.click(newChain);
  fireEvent.click(within(await screen.findByRole("dialog", { name: "New chain" })).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(document.activeElement).toBe(newChain));
  const change = await screen.findByRole("button", { name: "Change" });
  fireEvent.click(change);
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Change this trigger" })).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(document.activeElement).toBe(change));
  const remove = screen.getByRole("button", { name: "Delete" });
  fireEvent.click(remove);
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Delete this trigger?" })).getByRole("button", { name: "Keep it" }));
  await waitFor(() => expect(document.activeElement).toBe(remove));
  f.close();
});

it("after a delete the row is gone, so focus goes to the Triggers heading, not the page body", async () => {
  const f = setup({ write: () => ({ status: 200, body: { deleted: true } }) });
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Delete this trigger?" })).getByRole("button", { name: "Delete trigger" }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Triggers", level: 2 })));
  f.close();
});

it("a refused READ says \"You can't see this.\", not \"change\", and still shows the server's sentence", async () => {
  const sentence = "Only people who can view this chain can read its activity.";
  const f = setup({ activityStatus: 403, activity: error("FORBIDDEN", sentence) });
  fireEvent.click(await screen.findByRole("button", { name: "Activity" }));
  const alert = await screen.findByRole("alert");
  expect(within(alert).getByText("You can't see this.")).toBeTruthy();
  expect(within(alert).getByText(sentence)).toBeTruthy();
  expect(alert.textContent).not.toContain("change");
  f.close();
});
