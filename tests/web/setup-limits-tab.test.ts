// @vitest-environment jsdom
// "Limits for a setup run" (FABLE-REVIEW section 2) at the bottom of the Setup tab: five read-only lines with the value in force and a helper line; Change limits turns them into compact fields filled with the value in
// force, a unit beside each; a field holding Rovara's standard is sent as "not set"; the save is sent once against the revision the person saw, and a lost reply is checked through a read, never sent again blind.
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expectNoAxeViolations } from "./support/axe.js";
import { DEFAULTS, err, limitsView, mountSetupTab, type WorldWrite } from "./support/setup-tab-world.js";
import { settingOfFields, startFields, fieldProblem, restHelper, fieldHelper } from "../../packages/ui/src/screens/setup-tab/limits-model.js";

afterEach(cleanup);
const section = async () => within(await screen.findByTestId("setup-limits"));
const openForm = async () => { const s = await section(); fireEvent.click(await s.findByRole("button", { name: "Change limits" })); await s.findByTestId("limits-form"); return s; };
const field = (name: string) => screen.getByLabelText<HTMLInputElement>(name);
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const saved = () => screen.findByText("Saved. Setup runs that start from now use these limits.");
const putsOf = (f: ReturnType<typeof mountSetupTab>) => f.sent("PUT", "/setup-agent/limits");
/** A world whose limits PUT answers like Code: the revision moves on, the effective values follow. */
const writing = (over: (request: Parameters<WorldWrite>[0]) => ReturnType<WorldWrite> = () => undefined): WorldWrite => (request, world) => {
  if (request.method !== "PUT" || !request.path.endsWith("/setup-agent/limits")) return undefined;
  const custom = over(request);
  if (custom !== undefined) return custom;
  const current = world.limits as ReturnType<typeof limitsView>, sent = request.body as { limits: Record<string, number> };
  world.limits = { ...current, revision: current.revision + 1, limits: sent.limits, effective: { ...DEFAULTS, ...sent.limits } };
  return { status: 200, body: world.limits };
};

describe("the model", () => {
  const view = limitsView({ revision: 2, limits: { commands: 30 }, companyLock: { wallClockMin: 60, budgetCents: 250 }, effective: { ...DEFAULTS, commands: 30, wallClockMin: 45, budgetCents: 250 } });
  it("the helper line is the first case that applies, and never says No company cap", () => {
    expect(restHelper(view, "sameStepTries", "Acme")).toBe("Rovara's standard. Can be set up to 5.");
    expect(restHelper(view, "commands", "Acme")).toBe("Set for this project. Rovara's standard is 40.");
    expect(restHelper(view, "wallClockMin", "Acme")).toBe("Acme allows up to 60 minutes.");
    expect(restHelper(view, "budgetCents", "Acme")).toBe("Set by Acme for every project.");
    expect(restHelper(limitsView(), "budgetCents", "Acme")).toBe("Rovara's standard. Can be set up to $20.00.");
    expect(Object.values({ a: restHelper(view, "hostAsks", "Acme") }).join(" ")).not.toMatch(/No company cap|Default|Most/u);
  });
  it("a field starts from the value in force and says the standard and the most; a cap lower than the most is named", () => {
    expect(startFields(view)).toEqual({ commands: "30", sameStepTries: "3", wallClockMin: "45", budgetCents: "2.50", hostAsks: "5" });
    expect(fieldHelper(view, "commands", "Acme")).toBe("Rovara's standard is 40. Up to 120.");
    expect(fieldHelper(view, "wallClockMin", "Acme")).toBe("Rovara's standard is 45 minutes. Acme allows up to 60 minutes.");
    expect(fieldHelper(view, "budgetCents", "Acme")).toContain("Rovara's standard is $4.00. Acme allows up to $2.50.");
  });
  it("the errors are the ones in the design, in the person's units", () => {
    const e = (name: Parameters<typeof fieldProblem>[1], text: string) => fieldProblem(view, name, text, "Acme");
    expect(e("commands", "abc")).toBe("Enter a whole number."); expect(e("budgetCents", "abc")).toBe("Enter an amount in dollars, like 4 or 4.50.");
    expect(e("commands", "0")).toBe("Enter 1 or more."); expect(e("commands", "500")).toBe("Rovara allows up to 120.");
    expect(e("wallClockMin", "90")).toBe("Acme allows up to 60 minutes. A company owner or admin can raise it.");
    expect(e("commands", "25")).toBeUndefined(); expect(e("budgetCents", "2.50")).toBeUndefined();
  });
  it("an untouched field keeps what the project held, a field changed to the standard is sent as not set, anything else is the project's own value", () => {
    const fields = startFields(view);
    expect(settingOfFields(view, fields, "Acme")).toMatchObject({ dirty: false, setting: { commands: 30 } });
    expect(settingOfFields(view, { ...fields, commands: "40" }, "Acme").setting).toEqual({});
    expect(settingOfFields(view, { ...fields, hostAsks: "7" }, "Acme").setting).toEqual({ commands: 30, hostAsks: 7 });
    expect(settingOfFields(view, { ...fields, budgetCents: "3.5" }, "Acme").problems).toEqual({ budgetCents: "Acme allows up to $2.50. A company owner or admin can raise it." });
  });
});

describe("on the tab", () => {
  it("Change limits fills each field with the value in force (never empty), a unit beside it, about 120 px wide; Save is held until a value changes", async () => {
    mountSetupTab({ limits: limitsView({ revision: 2, limits: { commands: 30 }, effective: { ...DEFAULTS, commands: 30 } }) });
    const s = await openForm();
    expect(field("Commands").value).toBe("30"); expect(field("AI spend").value).toBe("4.00"); expect(field("Time").value).toBe("45");
    expect(within(screen.getByTestId("limit-field-budgetCents")).getByText("$")).toBeTruthy();
    expect(within(screen.getByTestId("limit-field-wallClockMin")).getByText("minutes")).toBeTruthy();
    expect(s.getByTestId("limit-field-commands").textContent).toContain("Rovara's standard is 40. Up to 120.");
    expect(s.getByTestId("limits-applies").textContent).toBe("Applies to setup runs that start after you save. A run that is going now keeps its limits.");
    expect(s.getByRole<HTMLButtonElement>("button", { name: "Save limits" }).disabled).toBe(true);
    expect(s.getByRole("button", { name: "Save limits" }).className).not.toContain("primary");
  });
  it("Use Rovara's standard shows only on a field that differs from the standard, and puts the standard back", async () => {
    mountSetupTab({ limits: limitsView({ revision: 2, limits: { commands: 30 }, effective: { ...DEFAULTS, commands: 30 } }) });
    await openForm();
    expect(screen.getByTestId("limit-standard-commands")).toBeTruthy();
    expect(screen.queryByTestId("limit-standard-wallClockMin")).toBeNull();
    fireEvent.click(screen.getByTestId("limit-standard-commands"));
    expect(field("Commands").value).toBe("40");
  });
  it("saves what was typed once: the spend in cents, the revision the person saw; the form closes and the lines show the answer", async () => {
    const f = mountSetupTab({ limits: limitsView({ revision: 2, limits: { commands: 30 }, effective: { ...DEFAULTS, commands: 30 } }), write: writing() });
    const s = await openForm();
    type("Commands", "25"); type("AI spend", "3.5");
    fireEvent.click(s.getByRole("button", { name: "Save limits" }));
    await saved();
    expect(putsOf(f)).toHaveLength(1);
    expect(putsOf(f)[0]!.body).toMatchObject({ expectedRevision: 2, limits: { commands: 25, budgetCents: 350 } });
    expect(Object.keys(putsOf(f)[0]!.body as object).sort()).toEqual(["expectedRevision", "limits", "requestId"]);
    expect(screen.queryByTestId("limits-form")).toBeNull();
    expect((await section()).getByTestId("limit-commands-value").textContent).toBe("Up to 25 commands a run");
    expect((await section()).getByTestId("limit-budgetCents-value").textContent).toBe("Up to $3.50 a run");
  });
  it("a field changed to the standard removes the project's own value", async () => {
    const f = mountSetupTab({ limits: limitsView({ revision: 1, limits: { commands: 30, hostAsks: 2 }, effective: { ...DEFAULTS, commands: 30, hostAsks: 2 } }), write: writing() });
    const s = await openForm();
    type("Commands", "40");
    fireEvent.click(s.getByRole("button", { name: "Save limits" }));
    await saved();
    expect((putsOf(f)[0]!.body as { limits: object }).limits).toEqual({ hostAsks: 2 });
  });
  it("keeps a number above the company's cap, a non-number and zero out of the request, each with its message under the field", async () => {
    const f = mountSetupTab({ limits: limitsView({ companyLock: { commands: 20 }, effective: { ...DEFAULTS, commands: 20 } }), write: writing() });
    const s = await openForm();
    type("Commands", "30");
    expect(s.getByText("Acme allows up to 20. A company owner or admin can raise it.")).toBeTruthy();
    expect(s.getByRole<HTMLButtonElement>("button", { name: "Save limits" }).disabled).toBe(true);
    type("Commands", "abc"); expect(s.getByText("Enter a whole number.")).toBeTruthy();
    type("Commands", "0"); expect(s.getByText("Enter 1 or more.")).toBeTruthy();
    type("Commands", "15");
    expect(s.getByRole<HTMLButtonElement>("button", { name: "Save limits" }).disabled).toBe(false);
    expect(putsOf(f)).toHaveLength(0);
  });
  it("Cancel returns to the read-only lines and drops what was typed", async () => {
    mountSetupTab();
    const s = await openForm();
    type("Commands", "25");
    fireEvent.click(s.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("limits-form")).toBeNull();
    expect((await section()).getByTestId("limit-commands-value").textContent).toBe("Up to 40 commands a run");
  });
  it("a limit changed meanwhile says so, reads the limits again and shows the current values", async () => {
    const f = mountSetupTab({ limits: limitsView({ revision: 1 }), write: writing(() => err(409, "CHANGE_STALE", "The limits changed since you looked. Refresh and try again.")) });
    const s = await openForm();
    f.world.limits = limitsView({ revision: 2, limits: { commands: 10 }, effective: { ...DEFAULTS, commands: 10 } });
    type("Commands", "25");
    fireEvent.click(s.getByRole("button", { name: "Save limits" }));
    expect((await screen.findByTestId("limits-alert")).textContent).toContain("These limits were changed by someone else while you were editing. The current values are shown.");
    await waitFor(() => expect(field("Commands").value).toBe("10"));
  });
  it("Code's refusal of a person who may not change the limits is shown and what they typed is kept", async () => {
    mountSetupTab({ write: writing(() => err(403, "FORBIDDEN", "Only company owners and admins, or this project's admins, can change the project's setup limits.")) });
    const s = await openForm();
    type("Commands", "25");
    fireEvent.click(s.getByRole("button", { name: "Save limits" }));
    expect((await screen.findByTestId("limits-alert")).textContent).toContain("Only company owners and admins, or this project's admins, can change the project's setup limits.");
    expect(field("Commands").value).toBe("25");
  });
  it("a save with no reply is checked through a read, says so, and saving the same change again sends the same request id", async () => {
    let first = true;
    const f = mountSetupTab({ limits: limitsView({ revision: 1 }), write: writing(() => { if (!first) return undefined; first = false; return err(503, "RUNTIME_UNAVAILABLE", "The request's outcome is unknown. Check its status before trying again."); }) });
    const s = await openForm();
    type("Commands", "25");
    fireEvent.click(s.getByRole("button", { name: "Save limits" }));
    expect((await screen.findByTestId("limits-alert")).textContent).toContain("Rovara didn't hear back, so your change may or may not be saved.");
    await waitFor(() => expect(f.sent("GET", "/setup-agent/limits").length).toBeGreaterThanOrEqual(2));
    expect(field("Commands").value).toBe("25");
    fireEvent.click(screen.getByRole("button", { name: "Save limits" }));
    await saved();
    const ids = putsOf(f).map(request => (request.body as { requestId: string }).requestId);
    expect(ids).toHaveLength(2); expect(ids[0]).toBe(ids[1]);
  });
  it("no reply and the read fails: Don't save again yet, Save is held until a read works", async () => {
    let reads = "ok", sent = false;
    const f = mountSetupTab({ limits: limitsView({ revision: 1 }),
      route: request => request.method === "GET" && request.path.endsWith("/setup-agent/limits") && reads !== "ok" ? err(503, "RUNTIME_UNAVAILABLE", "No.") : undefined,
      write: writing(() => { if (!sent) { sent = true; reads = "down"; return err(503, "RUNTIME_UNAVAILABLE", "The request's outcome is unknown. Check its status before trying again."); } return undefined; }) });
    const s = await openForm();
    type("Commands", "25");
    fireEvent.click(s.getByRole("button", { name: "Save limits" }));
    await waitFor(() => expect(screen.getByTestId("limits-alert").textContent).toContain("Don't save again yet."));
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save limits" }).disabled).toBe(true);
    reads = "ok";
    fireEvent.click(await screen.findByRole("button", { name: "Check the limits" }));
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save limits" }).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Save limits" }));
    await saved();
    expect(new Set(putsOf(f).map(request => (request.body as { requestId: string }).requestId)).size).toBe(1);
  });
  it("a refusal is shown through VisibleText: a hidden control character is shown, never obeyed", async () => {
    mountSetupTab({ write: writing(() => err(400, "CONFIG_INVALID", "commands: too‮many")) });
    const s = await openForm();
    type("Commands", "25");
    fireEvent.click(s.getByRole("button", { name: "Save limits" }));
    expect((await screen.findByTestId("limits-alert")).textContent).toContain("commands: too[U+202E]many");
  });
  it("limits that can't be read say so and that this doesn't mean there are none, with Read again", async () => {
    mountSetupTab({ route: request => request.method === "GET" && request.path.endsWith("/setup-agent/limits") ? err(503, "RUNTIME_UNAVAILABLE", "No.") : undefined });
    expect((await screen.findByTestId("limits-load-failed")).textContent).toBe("Rovara couldn't read this project's limits. That doesn't mean there are none.");
    expect(screen.getByRole("button", { name: "Read again" })).toBeTruthy();
  });
  it("a stop's Change the spend limit opens the form with the spend field in focus", async () => {
    mountSetupTab({ run: { status: "failed", basedOnRevision: 3, canManage: true, stop: "budget_used", failure: "x" } });
    fireEvent.click(within(await screen.findByTestId("setup-status-card")).getByRole("button", { name: "Change the spend limit" }));
    await screen.findByTestId("limits-form");
    await waitFor(() => expect(document.activeElement).toBe(field("AI spend")));
  });
  it("has no accessibility violations, at rest and in the form", async () => {
    const f = mountSetupTab({ limits: limitsView({ companyLock: { commands: 20 }, effective: { ...DEFAULTS, commands: 20 } }) });
    await section();
    await expectNoAxeViolations(f.container);
    await openForm();
    await act(async () => { await Promise.resolve(); });
    await expectNoAxeViolations(f.container);
  });
});
