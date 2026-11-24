// @vitest-environment jsdom
// L4-U5: the "Setup needs repair" banner on a project's page (above the tabs, one link to the Setup tab; Fix setup and Check again without AI are in the Setup tab's status card, tests/web/setup-tab.test.ts) and the paused-upkeep notice. Silent when fine; one card when the setup is broken, in the same words the chat and the admins' notice
// carry; one action that fits (and the cost words on the button only); a person who may not act reads the card and presses nothing; a refusal shows only a fixed sentence; one request id per action until it succeeds.
// Mutants (each killed by the named test, run by hand): R1 card drawn while the setup works; R2 card drawn while Code has no such read; R3 a reader gets an action; R4 the cost words missing from the button (or drawn in the body);
// R5 "Fix setup" drawn while a fix waits (or "Approve new setup" while none does); R6 Re-check drawn for a reader; R7 Re-check body carries more than the id; R8 a new id on a retry after a failure; R9 a failure shows the
// server's text; R10 the step drawn as markup; R11 the pause drawn for a project that is not paused; R12 "Raise" link drawn for a person who cannot raise the cap; R13 Re-check drawn when Code says nothing about the setup.
import { describe, expect, it } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { SETUP_REPAIR_SENTENCES, UPKEEP_PAUSE_SENTENCES } from "@agentx/contracts/web";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { readTask } from "../../packages/ui/src/api/work.js";
import { SetupRepairCard } from "../../packages/ui/src/screens/setup/SetupRepairCard.js";
import { NightlyUpkeep } from "../../packages/ui/src/screens/setup/wiki/NightlyUpkeep.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

const STEP = "setup: npm ci - setup step 0 (npm ci) failed: exit 1";
const ROOT = "/v1/app/projects/web";
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

describe("the banner above the tabs is silent unless the setup is broken", () => {
  it("draws nothing while the setup works, while Code has no such read (501), and for a project that is gone (404)", async () => {
    for (const read of [() => ({ status: 200, body: { state: "ready", canManage: true } }), () => err(501, "NOT_ON_CODE_YET", "x"), () => err(404, "NOT_FOUND", "x")]) {
      const f = mount(h(SetupRepairCard, { project: "web" }), { read });
      await waitFor(() => expect(calls(f, "GET", "/v1/app/projects/web/setup-repair").length).toBeGreaterThan(0));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(screen.queryByTestId("setup-repair-card")).toBeNull();
      f.close(); cleanup();
    }
  });
  it("when broken it says Code's own words and points at the Setup tab with one link, Open Setup; the work is done there", async () => {
    const f = mount(h(SetupRepairCard, { project: "web" }), { read: () => ({ status: 200, body: { state: "failed", canManage: true, repair: { step: "npm test", at: "2026-11-17T09:05:00.000Z", fixReady: false, actions: [{ id: "fix_setup", label: "Fix setup" }] } } }) });
    const card = await screen.findByTestId("setup-repair-card");
    expect(within(card).getByRole("heading").textContent).toBe(SETUP_REPAIR_SENTENCES.title);
    expect(within(card).getByTestId("setup-repair-body").textContent).toBe(SETUP_REPAIR_SENTENCES.body("npm test"));
    expect(within(card).getByRole("link", { name: "Open Setup" }).getAttribute("href")).toBe("/app/projects/web?tab=setup");
    expect(within(card).queryAllByRole("button")).toHaveLength(0);
    f.close();
  });
  it("draws the step as text, never as markup", async () => {
    const f = mount(h(SetupRepairCard, { project: "web" }), { read: () => ({ status: 200, body: { state: "failed", canManage: false, repair: { step: "<img src=x onerror=alert(1)>", at: "2026-11-17T09:05:00.000Z", fixReady: false, actions: [] } } }) });
    const card = await screen.findByTestId("setup-repair-card");
    expect(card.querySelector("img")).toBeNull();
    expect(card.textContent).toContain("<img src=x onerror=alert(1)>");
    f.close();
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
