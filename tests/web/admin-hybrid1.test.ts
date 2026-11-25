// @vitest-environment jsdom
import { inViewerZones, VIEWER_INSTANT } from "./support/viewer-zones.js";
// The Hybrid 1 admin pages (DEC 223): grouped navigation, Spending with real amounts and its over-budget states, company settings and the account
// page, each with its "not connected yet" state (no step-up in front of any action since owner DEC 254zzz73).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, fireEvent, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { lineState, readCompanySettings, readOrgSpend, spendSummary } from "../../packages/ui/src/api/admin-company.js";
import { ADMIN_GROUPS, visibleAdminGroups } from "../../packages/ui/src/screens/admin/admin-nav.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";

const me = "a".repeat(64), maya = { developerId: "b".repeat(64), name: "Maya", role: "member", identities: ["github"], joinedAt: "2026-10-01T00:00:00Z" };
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
const NOT_ON_CODE = { status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "not connected" } } };
const spendBody = {
 spentThisMonthUsd: 412.6, remainingUsd: 549.2, provisionalMicros: 1_230_000, heldUsd: 38.2, limitUsd: 1000, runsOutOn: "2026-11-29", costPerMergedChangeUsd: 3.84, mergedCount: 96, month: "2026-11",
 byProject: [{ name: "evals-api", spentUsd: 201.4, heldUsd: 21, limitUsd: 400, taskStopUsd: 8, mergedCount: 52, paidFrom: "Company Gemini account" }, { name: "prompt-router", spentUsd: 171.6, heldUsd: 17.2, limitUsd: 172, taskStopUsd: 8, mergedCount: 37, paidFrom: "Company Gemini account" }],
 byPerson: [{ name: "Priya Raman", role: "Admin", spentUsd: 148.2, allowanceUsd: 300, allowanceSource: "own", tasks: 41, mergedCount: 38 }, { name: "Sam Okoye", role: "Member", spentUsd: 139.9, allowanceUsd: 150, allowanceSource: "company_default", tasks: 36, mergedCount: 31 }],
};
const CAP_UNSET = { ready: false, reason: "company_monthly_cap_unset", message: "Set a monthly limit to use the model gateway." };
const settingsBody = (extra: Record<string, unknown> = {}) => ({
 companyId: "org_aaaaaaaaaaaaaaaaaaaa", version: 4,
 settings: { featureGates: {}, websiteCeiling: { mode: "any" }, instructions: [{ text: "Never touch the billing tables.", priority: "required" }], evalBudgetUsdMicros: null, start: { allow: true, maxEstimateUsdMicros: 5_000_000 }, decisions: [], locks: {}, budgets: { companyMonthlyUsdMicros: null, memberMonthlyUsdMicros: null, projectMonthlyUsdMicros: null, taskUsdMicros: null } },
 ...extra,
});

function mount(path: string, respond: (r: ApiRequest) => ApiResponse | Promise<ApiResponse>, options: { role?: "owner" | "admin" } = {}) {
 const role = options.role ?? "owner";
 const nav = AppNavSchema.parse({ me: { developerId: me, name: "Priya", orgRole: role }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
 const identity = AppMeResponseSchema.parse({ developer: { id: me, name: "Priya", orgRole: role }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
 const f = fakeHost(async r => (r.path === "/v1/app/nav" ? { status: 200, body: nav } : r.path === "/v1/app/me" ? { status: 200, body: identity } : respond(r)));
 const query = createQueryClient(); query.setQueryData(["nav"], nav); f.storage.set("rovara.theme", "light");
 for (const [key, value] of seeded) f.storage.set(key, value);
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: [path] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 return { ...f, ...view, router, query, close: () => { view.unmount(); router.dispose(); query.clear(); } };
}
const ok = (body: unknown): ApiResponse => ({ status: 200, body });
const seeded = new Map<string, string>();
beforeEach(() => { seeded.clear(); });
const writes = (f: ReturnType<typeof mount>) => f.request.mock.calls.map(([r]) => r).filter(r => r.method !== "GET");

describe("spending numbers", () => {
 it("reads only numbers that are the right shape", () => {
  const read = readOrgSpend({ spentThisMonthUsd: -1, remainingUsd: 10, heldUsd: "x", byProject: [{ name: "a", spentUsd: 5 }, { name: "bad" }, 7], byPerson: [{ name: "Priya", spentUsd: 5, mergedCount: 3 }] });
  expect(read).toEqual({ remainingUsd: 10, projects: [{ name: "a", spentUsd: 5 }] });
  expect(() => readOrgSpend("nope")).toThrow();
 });
 it("says ok, near, over, no limit or unknown, and what is over", () => {
  expect(spendSummary({ spentUsd: 100, remainingUsd: 900 }).state).toBe("ok");
  expect(spendSummary({ spentUsd: 920, remainingUsd: 80 })).toMatchObject({ state: "near", limitUsd: 1000 });
  expect(spendSummary({ spentUsd: 1004, remainingUsd: -4 })).toMatchObject({ state: "over", overUsd: 4, usedFraction: 1 });
  expect(spendSummary({ spentUsd: 50 })).toMatchObject({ state: "no_limit", limitUsd: undefined });
  expect(spendSummary({ spentUsd: 50 }, 500)).toMatchObject({ state: "ok", limitUsd: 500, remainingUsd: 450 });
  expect(spendSummary({})).toMatchObject({ state: "unknown" });
  // Held money counts toward "near" but not toward "spent".
  expect(spendSummary({ spentUsd: 800, heldUsd: 120, limitUsd: 1000 }).state).toBe("near");
 });
 it("works a line against its own limit", () => {
  expect(lineState(171.6, 172, 0)).toMatchObject({ state: "near" });
  expect(lineState(172.4, 172)).toMatchObject({ state: "over" });
  expect(lineState(10, undefined)).toEqual({ state: "none", leftUsd: undefined, fraction: undefined });
 });
 it("reads settings, ignoring rows that are not the shape (an older document's step-up window is not read: owner DEC 254zzz73)", () => {
  const read = readCompanySettings(settingsBody({ pending: { changeId: "chg_" + "a".repeat(20), proposedBy: "c", proposedAt: "2026-11-14T00:00:00Z", expiresAt: "2026-11-21T00:00:00Z", settings: { instructions: [{ text: "x", priority: "preferred" }], freshSignInSeconds: 60 } } }));
  expect(read).toMatchObject({ version: 4, start: { allow: true, maxEstimateUsd: 5 }, pending: { instructions: [{ text: "x" }] } });
  expect(read).not.toHaveProperty("freshSignInSeconds");
  expect(read.pending).not.toHaveProperty("freshSignInSeconds");
  expect(() => readCompanySettings({ settings: {} })).toThrow();
 });
});

describe("admin navigation", () => {
 it("groups the pages into five groups, not 14 flat tabs", () => {
  const groups = visibleAdminGroups("owner", false);
  expect(groups.map(group => group.title)).toEqual(["People and access", "Money", "Work and rules", "AI and connections", "Oversight"]);
  const all = groups.flatMap(group => group.links.map(link => link.label));
  expect(all).toEqual(expect.arrayContaining(["People", "Invites", "Spending", "Company settings", "How we work", "Audit"]));
  expect(all).not.toContain("Sign-in clients");expect(all).not.toContain("Health");
  expect(all).not.toContain("Sign-in factors");
  expect(ADMIN_GROUPS.flatMap(g => g.links).find(l => l.label === "Spending")?.blurb).toBe("Spent this month and what is left.");
 });
 it("hides owner-only and switched-off pages, and shows a member only the waiting queue", () => {
  expect(visibleAdminGroups("owner", false).flatMap(group => group.links.map(link => link.label))).not.toContain("Company domains");
  expect(visibleAdminGroups("owner", true).flatMap(group => group.links.map(link => link.label))).not.toContain("Second opinion");
  expect(visibleAdminGroups("member", false).flatMap(group => group.links.map(link => link.label))).toEqual(["Waiting for people"]);
 });
 it("draws the groups as headings in the sidebar and marks the current page", async () => {
  const f = mount("/app/admin/people", r => ok(r.path.endsWith("/members") ? { members: [maya] } : {}));
  try {
   const nav = await screen.findByRole("navigation", { name: "Administration" });
   expect(within(nav).getAllByRole("heading").map(heading => heading.textContent)).toEqual(["People and access", "Money", "Work and rules", "AI and connections", "Oversight"]);
   expect(within(nav).getByRole("link", { name: "People" }).getAttribute("aria-current")).toBe("page");
   expect(within(nav).getByRole("link", { name: "Spending" }).getAttribute("href")).toBe("/app/admin/money/budgets");
   expect(within(nav).queryByRole("link", { name: "Company domains" })).toBeNull();expect(within(nav).queryByRole("link", { name: "Tracker people" })).toBeNull();
  } finally { f.close(); }
 });
});

describe("Spending", () => {
 it("shows spent, held and left with the projects and people behind them", async () => {
  const f = mount("/app/admin/money/budgets", r => (r.path === "/v1/app/org/spend" ? ok(spendBody) : ok({})));
  try {
   const stats = await screen.findByRole("group", { name: "Spending in November" });
   expect(screen.getByText(/Not yet confirmed:/).textContent).toBe("Not yet confirmed: $1.23");
   expect(within(stats).getByText("$412.60")).toBeTruthy(); expect(within(stats).getByText("$38.20")).toBeTruthy(); expect(within(stats).getByText("$549.20")).toBeTruthy(); expect(within(stats).getByText("$3.84")).toBeTruthy();
   const projects = screen.getByRole("table", { name: "Spending by project" });
   expect(within(projects).getByText("evals-api")).toBeTruthy(); expect(within(projects).getByText("$201.40")).toBeTruthy();
   expect(projects.textContent).toContain("$0.40 left");
   // Per-person spending is not on this page at all (owner rule D2): not the table, not the names, not a merged count; only a link to People and limits.
   expect(screen.queryByRole("table", { name: "Spending by person" })).toBeNull();
   expect(document.body.textContent).not.toMatch(/Priya Raman|Sam Okoye|company default/u);
   expect(screen.getAllByRole("link", { name: "People and limits" }).map(link => link.getAttribute("href"))).toEqual(["/app/admin/money/people", "/app/admin/money/people"]);
   expect(screen.queryByText("Not connected yet")).toBeNull();
   expect(screen.queryByText("This month's budget is used up")).toBeNull();
  } finally { f.close(); }
 });
 it("says the budget is used up, and by how much, when nothing is left", async () => {
  const f = mount("/app/admin/money/budgets", r => (r.path === "/v1/app/org/spend" ? ok({ ...spendBody, spentThisMonthUsd: 1004.5, remainingUsd: -4.5, byProject: [{ name: "evals-api", spentUsd: 410, limitUsd: 400 }] }) : ok({})));
  try {
   expect(await screen.findByText("This month's budget is used up")).toBeTruthy();
   const banner = screen.getByRole("region", { name: "This month's budget is used up" });
   expect(banner.textContent).toContain("$4.50 over");
   expect(screen.getByText(/Over by/).textContent).toBe("Over by $10.00");
   expect(screen.getByRole("link", { name: "Raise the limit" }).getAttribute("href")).toBe("/app/admin/ai-spending");
  } finally { f.close(); }
 });
 it("warns when the month is nearly used", async () => {
  const f = mount("/app/admin/money/budgets", r => (r.path === "/v1/app/org/spend" ? ok({ spentThisMonthUsd: 930, remainingUsd: 70, limitUsd: 1000, runsOutOn: "2026-11-20" }) : ok({})));
  try { expect(await screen.findByText("Close to this month's limit")).toBeTruthy(); expect(screen.getByText(/runs out on Nov 20/)).toBeTruthy(); } finally { f.close(); }
 });
 it("says what is not connected yet instead of drawing empty tables", async () => {
  const f = mount("/app/admin/money/budgets", r => (r.path === "/v1/app/org/spend" ? NOT_ON_CODE : ok({})));
  try {
   expect(await screen.findByTestId("not-connected")).toBeTruthy();
   expect(screen.getByText(/Company spending isn't connected to Rovara Code yet/)).toBeTruthy();
   expect(screen.queryByRole("table", { name: "Spending by project" })).toBeNull();
  } finally { f.close(); }
 });
 it("omits the by-project placeholder when only the company totals are served", async () => {
  const f = mount("/app/admin/money/budgets", r => (r.path === "/v1/app/org/spend" ? ok({ spentThisMonthUsd: 12, remainingUsd: 88 }) : ok({})));
  try { await screen.findByRole("group", { name: /Spending in/ }); expect(screen.queryByText(/Spending by project/)).toBeNull(); expect(screen.queryByRole("region", { name: "By project" })).toBeNull(); } finally { f.close(); }
 });
 it("has no accessibility violations with amounts shown", async () => {
  const f = mount("/app/admin/money/budgets", r => (r.path === "/v1/app/org/spend" ? ok(spendBody) : ok({})));
  try { await screen.findByRole("table", { name: "Spending by project" }); await expectNoAxeViolations(f.container); } finally { f.close(); }
 });
});

describe("model gateway readiness", () => {
 const withReadiness = (modelGateway: unknown) => (r: ApiRequest): ApiResponse => (r.path === "/v1/app/org/settings" ? ok(settingsBody({ modelGateway })) : r.path === "/v1/app/org/spend" ? ok(spendBody) : ok({ members: [maya] }));
 it("says what to do on Spending when the company has no monthly cap, and links to where the cap is set", async () => {
  const f = mount("/app/admin/money/budgets", withReadiness(CAP_UNSET));
  try {
   const banner = await screen.findByRole("region", { name: "Set a monthly limit to use the model gateway." });
   expect(within(banner).getByRole("link", { name: "Set the monthly limit" }).getAttribute("href")).toBe("/app/admin/ai-spending");
   expect(banner.textContent).toContain("Rovara picks no amount for you");
  } finally { f.close(); }
 });
 it("says it on the Overview too, and says nothing when the gateway is ready, when Cloud does not say, or when settings are not connected", async () => {
  const f = mount("/app/admin", withReadiness(CAP_UNSET));
  try { expect(await screen.findByText("Set a monthly limit to use the model gateway.")).toBeTruthy(); } finally { f.close(); }
  for (const answer of [withReadiness({ ready: true }), withReadiness(undefined), (r: ApiRequest) => (r.path === "/v1/app/org/settings" ? NOT_ON_CODE : ok({ members: [maya] }))]) {
   const g = mount("/app/admin", answer);
   try { await screen.findByTestId("overview-people"); expect(screen.queryByText("Set a monthly limit to use the model gateway.")).toBeNull(); } finally { g.close(); }
  }
 });
 it("shows an unknown reason with Cloud's own words, as plain text", async () => {
  const f = mount("/app/admin/money/budgets", withReadiness({ ready: false, reason: "something_new", message: "<b>Call us</b>" }));
  try { expect(await screen.findByText("The model gateway isn't ready for this company")).toBeTruthy(); expect(screen.getByText("<b>Call us</b>")).toBeTruthy(); } finally { f.close(); }
 });
 it("is shown on Company settings, with the cap on its own section", async () => {
  const f = mount("/app/admin/settings", r => (r.path === "/v1/app/org/settings" ? ok(settingsBody({ modelGateway: CAP_UNSET })) : ok({})));
  try {
   expect(await screen.findByText("Set a monthly limit to use the model gateway.")).toBeTruthy();
   expect(screen.getByText(/No monthly limit is set/)).toBeTruthy();
  } finally { f.close(); }
 });
 it("shows a read-only monthly limit linking to the sole editor and preserves all budgets when saving rules", async () => {
  const body = settingsBody(); const budgets = { ...body.settings.budgets, companyMonthlyUsdMicros: 500_000_000, learningMonthlyUsdMicros: 20_000_000 };
  const f = mount("/app/admin/settings", r => r.method === "PUT" ? ok({ settings: {}, version: 5 }) : r.path === "/v1/app/org/settings" ? ok({ ...body, settings: { ...body.settings, budgets } }) : ok({}));
  try {
   const section = await screen.findByRole("region", { name: "Monthly limit" }); const link = within(section).getByRole("link", { name: "AI and spending" }); expect(link.getAttribute("href")).toBe("/app/admin/ai-spending");
   expect(screen.getByText(/monthly limit is/)).toBeTruthy();
   fireEvent.click(screen.getByRole("button", { name: "Change rules" }));
   expect(screen.queryByLabelText(/Company monthly/)).toBeNull();
   fireEvent.click(screen.getByRole("button", { name: "Save rules" })); await screen.findByText(/Saved\. The new rules apply/);
   expect(writes(f).find(r => r.method === "PUT")?.body).toMatchObject({ settings: { budgets } });
  } finally { f.close(); }
 });
});

describe("Overview", () => {
 it("shows this month's money and the people count, then the groups", async () => {
  const f = mount("/app/admin", r => (r.path === "/v1/app/org/spend" ? ok(spendBody) : ok({ members: [maya] })));
  try {
   // G1 SHIP selector edit: the "At a glance" stat group became the Money and People rows of the company pages list.
   const glance = await screen.findByTestId("overview-spend");
   await within(glance).findByText("$412.60"); expect(within(glance).getByText("$549.20")).toBeTruthy(); expect((await screen.findByTestId("overview-people")).textContent).toBe("1 person");
   expect(screen.getByRole("link", { name: "Open Spending" }).getAttribute("href")).toBe("/app/admin/money/budgets");
   expect(screen.queryByRole("link", { name: "Open Health" })).toBeNull();
  } finally { f.close(); }
 });
 it("says spending is not connected yet", async () => {
  const f = mount("/app/admin", r => (r.path === "/v1/app/org/spend" ? NOT_ON_CODE : ok({ members: [maya] })));
  try { expect(await screen.findByTestId("not-connected")).toBeTruthy(); } finally { f.close(); }
 });
});

describe("Company settings", () => {
 it("says not connected yet when Cloud has no company settings, and still links the other pages", async () => {
  const f = mount("/app/admin/settings", r => (r.path === "/v1/app/org/settings" ? NOT_ON_CODE : ok({})));
  try { expect(await screen.findByTestId("not-connected")).toBeTruthy(); expect(screen.getAllByRole("link", { name: "Projects" })).toHaveLength(2); } finally { f.close(); }
 });
 it("shows the rules and who may start work, and no approval window (owner DEC 254zzz73)", async () => {
  const f = mount("/app/admin/settings", r => (r.path === "/v1/app/org/settings" ? ok(settingsBody()) : ok({})));
  try {
   expect(await screen.findByText("Never touch the billing tables.")).toBeTruthy();
   expect(screen.queryByRole("region", { name: "Approval window" })).toBeNull();
   expect(screen.queryByText(/confirm it's them|Confirm it's you/u)).toBeNull();
   // G1 SHIP copy: "Anyone with project access may start one" became the rebuilt policy sentence.
   expect(screen.getByText(/Starting tasks is on for the company/)).toBeTruthy();
   expect(screen.getByText("$5.00")).toBeTruthy();
  } finally { f.close(); }
 });
 it("says on the Company policy card that these company rules are not enforced on tasks yet (owner DEC 254zzz518)", async () => {
  const f = mount("/app/admin/settings", r => (r.path === "/v1/app/org/settings" ? ok(settingsBody()) : ok({})));
  try {
   const note = await screen.findByTestId("company-policy-not-enforced");
   expect(note.textContent).toBe("These company rules are not enforced on tasks yet. Each project's own settings, the per-task and daily spend caps, and owner approval still apply.");
   expect(screen.getByRole("region", { name: "Company policy" }).contains(note)).toBe(true);
  } finally { f.close(); }
 });
 it("opens the editor straight away with no step-up, and never sends the person to a sign-in page", async () => {
  const f = mount("/app/admin/settings", r => (r.path === "/v1/app/org/settings" ? ok(settingsBody()) : ok({})));
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Change rules" }));
   expect(await screen.findByRole("group", { name: "Edit company rules" })).toBeTruthy();
   expect(screen.queryByTestId("fresh-sign-in")).toBeNull();
   expect(screen.queryByLabelText("Approval window")).toBeNull();
   expect(f.host.signIn).not.toHaveBeenCalled();
   expect(writes(f)).toHaveLength(0);
  } finally { f.close(); }
 });
 it("saves the whole document with its version", async () => {
  const f = mount("/app/admin/settings", r => (r.method === "PUT" ? ok({ companyId: "x", version: 5, settings: {} }) : r.path === "/v1/app/org/settings" ? ok(settingsBody()) : ok({})));
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Change rules" }));
   fireEvent.change(await screen.findByLabelText("Rule 1"), { target: { value: "Never touch the billing or ledger tables." } });
   fireEvent.click(screen.getByRole("button", { name: "Save rules" }));
   await screen.findByText(/Saved\. The new rules apply/);
   const put = writes(f).find(r => r.method === "PUT");
   expect(put?.body).toMatchObject({  expectedVersion: 4, settings: { instructions: [{ text: "Never touch the billing or ledger tables.", priority: "required" }], start: { allow: true }, websiteCeiling: { mode: "any" } } });
  } finally { f.close(); }
 });
 it("shows the server's refusal in its own words and keeps the editor open (no step-up to go back to)", async () => {
  const f = mount("/app/admin/settings", r => (r.method === "PUT" ? { status: 403, body: { error: { code: "FORBIDDEN", message: "Only a company admin can do this." } } } : r.path === "/v1/app/org/settings" ? ok(settingsBody()) : ok({})));
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Change rules" }));
   fireEvent.click(await screen.findByRole("button", { name: "Save rules" }));
   expect((await screen.findByTestId("settings-error")).textContent).toContain("Only a company admin can do this.");
   expect(screen.queryByTestId("fresh-sign-in")).toBeNull();
   expect(f.host.signIn).not.toHaveBeenCalled();
  } finally { f.close(); }
 });
 it("tells the person a loosening change is waiting for a second admin", async () => {
  const f = mount("/app/admin/settings", r => (r.method === "PUT" ? { status: 202, body: { companyId: "x", version: 4, pending: { changeId: "chg_" + "a".repeat(20) } } } : r.path === "/v1/app/org/settings" ? ok(settingsBody()) : ok({})));
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Change rules" }));
   fireEvent.click(await screen.findByRole("button", { name: "Save rules" }));
   expect(await screen.findByText(/Another company admin must approve/)).toBeTruthy();
  } finally { f.close(); }
 });
 it("lets a second admin approve a change someone else proposed with one press (no step-up)", async () => {
  const pending = { changeId: "chg_" + "a".repeat(20), proposedBy: "c".repeat(64), proposedAt: "2026-11-14T00:00:00Z", expiresAt: "2026-11-21T00:00:00Z", settings: { instructions: [{ text: "Allow every website.", priority: "preferred" }] } };
  const f = mount("/app/admin/settings", r => (r.method === "POST" ? ok({ companyId: "x", version: 5, settings: {} }) : r.path === "/v1/app/org/settings" ? ok(settingsBody({ pending })) : ok({})));
  try {
   expect(await screen.findByText("Allow every website.")).toBeTruthy();
   expect(screen.queryByTestId("fresh-sign-in")).toBeNull();
   expect(screen.queryByRole("button", { name: "Change rules" })).toBeNull();
   fireEvent.click(screen.getByRole("button", { name: "Approve this change" }));
   await screen.findByText(/Approved\. The new rules apply/);
   expect(writes(f).map(w => w.path)).toEqual([`/v1/app/org/settings/pending/${pending.changeId}/approve`]);
  } finally { f.close(); }
 });
});

describe("the company rules editor", () => {
 it("re-reads the company rules when it opens the editor, so an old copy is never saved over a newer version", async () => {
  let body = settingsBody();
  const f = mount("/app/admin/settings", r => (r.path === "/v1/app/org/settings" && r.method === "GET" ? ok(body) : r.method === "PUT" ? ok({ settings: {}, version: 6 }) : ok({})));
  try {
   await screen.findByText("Never touch the billing tables.");
   const next = settingsBody(); next.version = 5; next.settings.instructions = [{ text: "Approved elsewhere.", priority: "required" }];
   body = next;
   await f.query.invalidateQueries({ queryKey: ["admin", "lane-c", "company-settings"] });
   await screen.findByText("Approved elsewhere.");
   fireEvent.click(screen.getByRole("button", { name: "Change rules" }));
   const rule = await screen.findByLabelText<HTMLInputElement>("Rule 1");
   expect(rule.value).toBe("Approved elsewhere.");
   fireEvent.click(screen.getByRole("button", { name: "Save rules" }));
   await screen.findByText(/Saved\. The new rules apply/);
   expect(writes(f).find(r => r.method === "PUT")?.body).toMatchObject({ expectedVersion: 5, settings: { instructions: [{ text: "Approved elsewhere." }] } });
  } finally { f.close(); }
 });
});

describe("Sign-in clients and Health (hidden: the hosted Code does not serve them, DEC 254zzz113/115/116)", () => {
 for (const page of ["sign-in-clients", "health"]) it(`has no ${page} page: the address finds nothing and no request is made for it`, async () => {
  const f = mount("/app/admin/" + page, () => ok({ members: [maya] }));
  try {
   await screen.findByRole("navigation", { name: "Administration" });
   expect(screen.queryByTestId("not-connected")).toBeNull();
   expect(screen.queryByRole("table", { name: "Sign-in clients" })).toBeNull();
   expect(screen.queryByRole("heading", { name: "Rovara service status" })).toBeNull();
   expect(f.request.mock.calls.some(([r]) => /sign-in-clients|service-status/.test(r.path))).toBe(false);
  } finally { f.close(); }
 });
});

describe("Your account", () => {
 it("never asks for the sign-in factors and shows no confirmation email or passkeys (owner DEC 254zzz73)", async () => {
  const f = mount("/app/account", () => ok({}));
  try {
   await screen.findByRole("heading", { name: "Account" });
   expect(f.request.mock.calls.some(([r]) => r.path === "/v1/app/me/sign-in-factors")).toBe(false);
   expect(screen.queryByRole("heading", { name: "Confirmation email" })).toBeNull();expect(screen.queryByRole("heading", { name: "Passkeys" })).toBeNull();
   expect(screen.queryByTestId("factor-email")).toBeNull();expect(screen.queryByTestId("fresh-sign-in")).toBeNull();
  } finally { f.close(); }
 });
 it("has no accessibility violations", async () => {
  const f = mount("/app/account", () => ok({}));
  try { await screen.findByRole("heading", { name: "Account" }); await expectNoAxeViolations(f.container); } finally { f.close(); }
 });
});

it("Overview distinguishes an empty month from a fault without showing invented amounts", async () => {
 const f = mount("/app/admin", r => r.path === "/v1/app/org/spend" ? ok({ month: "2026-11", empty: true }) : ok({ members: [maya] }));
 try { await screen.findByText("No AI spending recorded yet this month"); expect(screen.queryByText(/\$0/)).toBeNull(); } finally { f.close(); }
 const g = mount("/app/admin", r => r.path === "/v1/app/org/spend" ? { status: 503, body: {} } : ok({ members: [maya] }));
 try { await screen.findByText(/Couldn't load spending/); expect(screen.queryByText("No AI spending recorded yet this month")).toBeNull(); } finally { g.close(); }
});
it("only accepts the explicit empty answer without contradictory amounts", () => {
 expect(readOrgSpend({ month: "2026-11", empty: true })).toEqual({ month: "2026-11", empty: true });
 for (const extra of [{ spentThisMonthUsd: 0 }, { provisionalMicros: 1 }, { month: "bad" }]) expect(() => readOrgSpend({ month: "2026-11", empty: true, ...extra })).toThrow();
});

// G1: the company settings page (CompanySettingsReadScreen) shows "Proposed <time> · open until <time>" in the viewer's own day and 24-hour clock ("21 Nov 17:30"), literal here. Only Date is faked (a fixed "now" on another day), so "Today" never replaces the day.
it("renders the pending company-rule expiry in both viewer zones", async () => {
 const stamps: Record<string, string> = { "America/Los_Angeles": "21 Nov 17:30", "Pacific/Auckland": "22 Nov 14:30" };
 vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-12-25T12:00:00.000Z") });
 try {
  await inViewerZones(async expected => {
   const f = mount("/app/admin/settings", r => r.path === "/v1/app/org/settings" ? ok(settingsBody({ pending: { changeId: "chg_" + "a".repeat(20), proposedBy: "c", proposedAt: VIEWER_INSTANT, expiresAt: VIEWER_INSTANT, settings: { instructions: [{ text: "x", priority: "preferred" }] } } })) : ok({}));
   try { expect(await screen.findAllByText(stamps[expected.zone]!)).toHaveLength(2); } finally { f.close(); }
  });
 } finally { vi.useRealTimers(); }
});
