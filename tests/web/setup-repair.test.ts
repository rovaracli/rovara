// @vitest-environment jsdom
// L4-U5: the "Setup needs repair" card on a project's page, the "Re-check setup" button and the paused-upkeep notice. Silent when fine; one card when the setup is broken, in the same words the chat and the admins' notice
// carry; one action that fits (and the cost words on the button only); a person who may not act reads the card and presses nothing; a refusal shows only a fixed sentence; one request id per action until it succeeds.
// Mutants (each killed by the named test, run by hand): R1 card drawn while the setup works; R2 card drawn while Code has no such read; R3 a reader gets an action; R4 the cost words missing from the button (or drawn in the body);
// R5 "Fix setup" drawn while a fix waits (or "Approve new setup" while none does); R6 Re-check drawn for a reader; R7 Re-check body carries more than the id; R8 a new id on a retry after a failure; R9 a failure shows the
// server's text; R10 the step drawn as markup; R11 the pause drawn for a project that is not paused; R12 "Raise" link drawn for a person who cannot raise the cap; R13 Re-check drawn when Code says nothing about the setup.
import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { SETUP_REPAIR_REFUSALS, SETUP_REPAIR_SENTENCES, UPKEEP_PAUSE_SENTENCES } from "@agentx/contracts/web";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { readTask } from "../../packages/ui/src/api/work.js";
import { RecheckSetupRow, SetupRepairCard } from "../../packages/ui/src/screens/setup/SetupRepairCard.js";
import { NightlyUpkeep } from "../../packages/ui/src/screens/setup/wiki/NightlyUpkeep.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";

const LEAK = "SENSITIVE-SERVER-DETAIL";
const STEP = "setup: npm ci - setup step 0 (npm ci) failed: exit 1";
const ROOT = "/v1/app/projects/web";
const RID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const err = (status: number, code: string, message: string): ApiResponse => ({ status, body: { error: { code, message } } });
const card = (over: Record<string, unknown> = {}) => ({ step: STEP, changed: "dependency files", at: "2026-11-17T09:05:00.000Z", fixReady: false, actions: [{ id: "fix_setup", label: "Fix setup" }], ...over });
const view = (extra: Record<string, unknown> = {}) => ({ status: 200, body: { state: "failed", canManage: true, repair: card(), ...extra } });

interface Options { read?: () => ApiResponse; recheck?: (request: ApiRequest) => ApiResponse; start?: (request: ApiRequest) => ApiResponse; upkeep?: () => ApiResponse; theme?: "light" | "dark" }
function mount(element: ReturnType<typeof h>, options: Options = {}) {
  const f = fakeHost(async (request) => {
    if (request.path === `${ROOT}/setup-repair` && request.method === "GET") return options.read?.() ?? view();
    if (request.path === `${ROOT}/setup-repair/recheck`) return options.recheck?.(request) ?? { status: 200, body: { started: true } };
    if (request.path === `${ROOT}/setup-agent` && request.method === "GET") return { status: 200, body: { status: "ready", basedOnRevision: 3, limits: { commands: 40, sameStepTries: 3, wallClockMin: 45, budgetCents: 400, hostAsks: 5 }, canManage: true } };
    if (request.path === `${ROOT}/setup-agent` && request.method === "POST") return options.start?.(request) ?? { status: 202, body: { status: "running", basedOnRevision: 3, limits: { commands: 40, sameStepTries: 3, wallClockMin: 45, budgetCents: 400, hostAsks: 5 }, canManage: true } };
    if (request.path === `${ROOT}/upkeep`) return options.upkeep?.() ?? { status: 200, body: { enabled: true, canManage: true, available: true, systemRunsOn: true, canEnableSystemRuns: true, cap: { monthlyUsd: 25, canRaise: true } } };
    if (request.path === "/v1/app/org/spend-limits") return { status: 200, body: { companyId: "org_aaaaaaaaaaaaaaaaaaaa", defaults: { upkeepMonthlyUsd: 25 }, upkeep: [] } };
    return err(404, "NOT_FOUND", "route not found");
  });
  const query = createQueryClient();
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: ["/app/projects/web"], children: element }) }) }), { theme: options.theme ?? "light" });
  return { ...f, queryClient: query, close() { ui.unmount(); query.clear(); } };
}
const calls = (f: ReturnType<typeof mount>, method: string, path: string) => f.request.mock.calls.map(([request]) => request).filter((request) => request.method === method && request.path === path);
const read = (f: ReturnType<typeof mount>) => calls(f, "GET", `${ROOT}/setup-repair`);

describe("the card is silent unless the setup is broken", () => {
  // MUTANT R1 and R2.
  it("draws nothing while the setup works, while Code has no such read (501), and for a project that is gone (404)", async () => {
    for (const answer of [{ status: 200, body: { state: "ready", canManage: true } }, err(501, "NOT_ON_CODE_YET", "Setup repair isn't available on this Rovara yet."), err(404, "NOT_FOUND", "project not found"), err(503, "RUNTIME_UNAVAILABLE", LEAK)]) {
      const f = mount(h(SetupRepairCard, { project: "web" }), { read: () => answer });
      await waitFor(() => expect(read(f)).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(screen.queryByTestId("setup-repair-card")).toBeNull();
      expect(screen.queryByTestId("setup-recheck")).toBeNull();
      expect(document.body.textContent).not.toContain(LEAK);
      f.close();
    }
  });
});

describe("the card's words and its one action", () => {
  // MUTANT R4, R5, R10.
  it("a manager reads the title, the sentence Code and the chat say (with the check's own step as plain text), and ONE action with its cost on the button only", async () => {
    const f = mount(h(SetupRepairCard, { project: "web" }));
    const box = await screen.findByTestId("setup-repair-card");
    expect(within(box).getByRole("heading", { name: "Setup needs repair" })).toBeTruthy();
    expect(within(box).getByTestId("setup-repair-body").textContent).toBe(`The project's setup stopped working after recent code changes (${STEP}). Rovara cannot build on this project until it is fixed.`);
    const fix = await within(box).findByRole("button", { name: "Fix setup (uses your AI, up to $4)" });
    expect(fix).toBeTruthy();
    expect(within(box).queryByRole("link", { name: "Approve new setup" })).toBeNull();
    // The cost words are on the button and nowhere else in the card.
    expect((box.textContent ?? "").replace(SETUP_REPAIR_SENTENCES.fixLabel, "")).not.toMatch(/\$|\bAI\b/u);
    expect(within(box).getByRole("button", { name: "Re-check setup" })).toBeTruthy();
    await expectNoAxeViolations(document.body);
    f.close();
  });

  it("what changed is one click away, not shown by default", async () => {
    const f = mount(h(SetupRepairCard, { project: "web" }));
    const box = await screen.findByTestId("setup-repair-card");
    const details = box.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(within(box).getByTestId("setup-repair-changed").textContent).toBe("dependency files");
    expect(details.querySelector("summary")!.textContent).toBe("What changed");
    f.close();
  });

  it("draws the step as text, never as markup", async () => {
    const f = mount(h(SetupRepairCard, { project: "web" }), { read: () => view({ repair: card({ step: "setup: <img src=x onerror=alert(1)> **bold**" }) }) });
    const box = await screen.findByTestId("setup-repair-card");
    expect(box.querySelector("img")).toBeNull();
    expect(within(box).getByTestId("setup-repair-body").textContent).toContain("<img src=x onerror=alert(1)> **bold**");
    f.close();
  });

  // MUTANT R5.
  it("offers 'Approve new setup' (a link to the setup page's approval) while a checked fix waits, and no 'Fix setup'", async () => {
    const f = mount(h(SetupRepairCard, { project: "web" }), { read: () => view({ repair: card({ fixReady: true, actions: [{ id: "approve_new_setup", label: "Approve new setup" }] }) }) });
    const box = await screen.findByTestId("setup-repair-card");
    const link = await within(box).findByRole("link", { name: "Approve new setup" });
    expect(link.getAttribute("href")).toBe("/app/projects/web#setup-checklist");
    expect(box.getAttribute("data-fix-ready")).toBe("true");
    expect(within(box).queryByRole("button", { name: /Fix setup/u })).toBeNull();
    f.close();
  });

  // MUTANT R3 and R6.
  it("a person who may not act reads the same words, is told the admins were asked, and has no action and no Re-check", async () => {
    const f = mount(h(SetupRepairCard, { project: "web" }), { read: () => view({ canManage: false, repair: card({ actions: [] }) }) });
    const box = await screen.findByTestId("setup-repair-card");
    expect(within(box).getByTestId("setup-repair-body").textContent).toContain("Rovara cannot build on this project until it is fixed.");
    expect(within(box).getByTestId("setup-repair-reader").textContent).toBe("The project's admins have been asked to fix it.");
    expect(within(box).queryAllByRole("button")).toHaveLength(0);
    expect(within(box).queryAllByRole("link")).toHaveLength(0);
    f.close();
  });

  it("is readable in the dark theme too", async () => {
    const f = mount(h(SetupRepairCard, { project: "web" }), { theme: "dark" });
    await screen.findByTestId("setup-repair-card");
    await expectNoAxeViolations(document.body);
    f.close();
  });
});

describe("Fix setup starts the setup run, and only that", () => {
  it("pressing it sends one request to the setup run with exactly the request id; no cost is asked of Code and nothing else is started", async () => {
    const f = mount(h(SetupRepairCard, { project: "web" }));
    fireEvent.click(await screen.findByRole("button", { name: "Fix setup (uses your AI, up to $4)" }));
    await waitFor(() => expect(calls(f, "POST", `${ROOT}/setup-agent`)).toHaveLength(1));
    const body = calls(f, "POST", `${ROOT}/setup-agent`)[0]!.body as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["requestId"]);
    expect(String(body["requestId"])).toMatch(RID);
    expect(calls(f, "POST", `${ROOT}/setup-repair/recheck`)).toHaveLength(0);
    f.close();
  });
});

describe("Re-check setup", () => {
  // MUTANT R7.
  it("sends exactly a request id, says the check started, and reads the card again", async () => {
    const f = mount(h(SetupRepairCard, { project: "web" }));
    fireEvent.click(await screen.findByRole("button", { name: "Re-check setup" }));
    expect((await screen.findByTestId("setup-recheck-started")).textContent).toContain("Checking setup again.");
    const sent = calls(f, "POST", `${ROOT}/setup-repair/recheck`);
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0]!.body as object)).toEqual(["requestId"]);
    expect(String((sent[0]!.body as { requestId: string }).requestId)).toMatch(RID);
    await waitFor(() => expect(read(f).length).toBeGreaterThan(1));
    f.close();
  });

  // MUTANT R8 and R9.
  it("a refusal shows only a fixed sentence (never Code's text), and the same request id is sent again on a retry", async () => {
    let n = 0;
    const f = mount(h(SetupRepairCard, { project: "web" }), { recheck: () => (n++ === 0 ? err(409, "WORKSPACE_BUSY", `${LEAK} A setup check is already running for this project. Wait for it to finish.`) : { status: 200, body: { started: true } }) });
    fireEvent.click(await screen.findByRole("button", { name: "Re-check setup" }));
    expect((await screen.findByTestId("setup-recheck-error")).textContent).toContain("Couldn't start the check just now. Try again.");
    expect(document.body.textContent).not.toContain(LEAK);
    fireEvent.click(screen.getByRole("button", { name: "Re-check setup" }));
    await screen.findByTestId("setup-recheck-started");
    const sent = calls(f, "POST", `${ROOT}/setup-repair/recheck`).map((request) => (request.body as { requestId: string }).requestId);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe(sent[1]);
    expect(SETUP_REPAIR_REFUSALS.has("A setup check is already running for this project. Wait for it to finish.")).toBe(true);
    f.close();
  });

  it("a fixed refusal of Cloud's own is shown in its words", async () => {
    const f = mount(h(SetupRepairCard, { project: "web" }), { recheck: () => err(409, "WORKSPACE_BUSY", "A setup check is already running for this project. Wait for it to finish.") });
    fireEvent.click(await screen.findByRole("button", { name: "Re-check setup" }));
    expect((await screen.findByTestId("setup-recheck-error")).textContent).toContain("A setup check is already running for this project. Wait for it to finish.");
    f.close();
  });

  // MUTANT R6 and R13: on Project settings the button is only for a person Code says may manage, and only where Code answers.
  it("on its own (Project settings) it is drawn for a manager only, and not at all where Code says nothing about the setup", async () => {
    const manager = mount(h(RecheckSetupRow, { project: "web" }), { read: () => ({ status: 200, body: { state: "ready", canManage: true } }) });
    expect(await screen.findByRole("button", { name: "Re-check setup" })).toBeTruthy();
    manager.close();
    const reader = mount(h(RecheckSetupRow, { project: "web" }), { read: () => ({ status: 200, body: { state: "ready", canManage: false } }) });
    await waitFor(() => expect(read(reader)).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("button", { name: "Re-check setup" })).toBeNull();
    reader.close();
    const absent = mount(h(RecheckSetupRow, { project: "web" }), { read: () => err(501, "NOT_ON_CODE_YET", "x") });
    await waitFor(() => expect(read(absent)).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId("setup-recheck")).toBeNull();
    absent.close();
  });
});

describe("nightly upkeep says when it is paused", () => {
  const upkeep = (extra: Record<string, unknown>, cap = { monthlyUsd: 25, canRaise: true }) => ({ status: 200, body: { enabled: true, canManage: true, available: true, systemRunsOn: true, canEnableSystemRuns: true, cap, ...extra } });
  // MUTANT R11 and R12.
  it("draws Code's own sentence for the reason, with a way to raise the limit for a person who can; nothing while it is not paused", async () => {
    for (const reason of ["no_budget", "monthly_limit", "cost_too_high"] as const) {
      const f = mount(h(NightlyUpkeep, { project: "web", companyAdmin: true }), { upkeep: () => upkeep({ paused: { reason, month: "2026-11" } }) });
      const notice = await screen.findByTestId("wiki-setup-upkeep-paused");
      expect(notice.textContent).toContain(UPKEEP_PAUSE_SENTENCES[reason]);
      expect(within(notice).getByRole("link", { name: /Raise/u }).getAttribute("href")).toBe("/app/admin/money/limits");
      expect(notice.getAttribute("role")).toBe("status");
      f.close();
    }
    const quiet = mount(h(NightlyUpkeep, { project: "web", companyAdmin: true }), { upkeep: () => upkeep({}) });
    await screen.findByTestId("wiki-setup-upkeep");
    expect(screen.queryByTestId("wiki-setup-upkeep-paused")).toBeNull();
    quiet.close();
    const noRaise = mount(h(NightlyUpkeep, { project: "web", companyAdmin: false }), { upkeep: () => upkeep({ paused: { reason: "monthly_limit", month: "2026-11" } }, { monthlyUsd: 25, canRaise: false }) });
    const text = await screen.findByTestId("wiki-setup-upkeep-paused");
    expect(within(text).queryByRole("link")).toBeNull();
    noRaise.close();
  });
});

describe("the task's evidence line is read from Code's task, in fixed words", () => {
  const base = { taskId: "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6", title: "Add a retry", project: "web", updatedAt: "2026-11-17T09:00:00.000Z" };
  it("keeps a plain line, and drops one with a control character, an empty one and one that is too long", () => {
    expect(readTask({ ...base, setupRecheck: "Setup re-checked after dependency files changed: still works." })?.setupRecheck).toBe("Setup re-checked after dependency files changed: still works.");
    expect(readTask(base)?.setupRecheck).toBeUndefined();
    for (const bad of ["", "x".repeat(601), "line\u0007bell", "bidi‮", 7]) expect(readTask({ ...base, setupRecheck: bad })?.setupRecheck, String(bad)).toBeUndefined();
  });
});
