// @vitest-environment jsdom
// The Hybrid 1 admin pages (DEC 223): grouped navigation, Spending with real amounts and its over-budget states, company settings, the sign-in factor pages and the account
// page, each with its "not connected yet" state and the fresh sign-in step in front of every sensitive action.
import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { lineState, readCompanySettings, readMyFactors, readOrgSpend, spendSummary, windowWords } from "../../packages/ui/src/api/admin-company.js";
import { visibleAdminGroups } from "../../packages/ui/src/screens/admin/admin-nav.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";

const me = "a".repeat(64), maya = { developerId: "b".repeat(64), name: "Maya", role: "member", identities: ["github"], joinedAt: "2026-10-01T00:00:00Z" };
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
const NOT_ON_CODE = { status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "not connected" } } };
const spendBody = {
 spentThisMonthUsd: 412.6, remainingUsd: 549.2, heldUsd: 38.2, limitUsd: 1000, runsOutOn: "2026-11-29", costPerMergedChangeUsd: 3.84, mergedCount: 96, month: "2026-11",
 byProject: [{ name: "evals-api", spentUsd: 201.4, heldUsd: 21, limitUsd: 400, taskStopUsd: 8, mergedCount: 52, paidFrom: "Company Gemini account" }, { name: "prompt-router", spentUsd: 171.6, heldUsd: 17.2, limitUsd: 172, taskStopUsd: 8, mergedCount: 37, paidFrom: "Company Gemini account" }],
 byPerson: [{ name: "Priya Raman", role: "Admin", spentUsd: 148.2, allowanceUsd: 300, allowanceSource: "own", tasks: 41, mergedCount: 38 }, { name: "Sam Okoye", role: "Member", spentUsd: 139.9, allowanceUsd: 150, allowanceSource: "company_default", tasks: 36, mergedCount: 31 }],
};
const CAP_UNSET = { ready: false, reason: "company_monthly_cap_unset", message: "Set a monthly cap to use the model gateway." };
const settingsBody = (extra: Record<string, unknown> = {}) => ({
 companyId: "org_aaaaaaaaaaaaaaaaaaaa", version: 4,
 settings: { featureGates: {}, websiteCeiling: { mode: "any" }, instructions: [{ text: "Never touch the billing tables.", priority: "required" }], evalBudgetUsdMicros: null, freshSignInSeconds: 300, start: { allow: true, maxEstimateUsdMicros: 5_000_000 }, decisions: [], locks: {}, budgets: { companyMonthlyUsdMicros: null, memberMonthlyUsdMicros: null, projectMonthlyUsdMicros: null, taskUsdMicros: null } },
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
/** What the fresh sign-in step does on the way out and back: the tab stores a one-time nonce, and the return address carries it. */
const NONCE_KEY = "rovara.stepup.nonce";
function confirmedPath(path: string, nonce = "n-1"): string { seeded.set(NONCE_KEY, JSON.stringify({ nonce, at: Date.now() })); return path + (path.includes("?") ? "&" : "?") + "confirmed=" + nonce; }
const writes = (f: ReturnType<typeof mount>) => f.request.mock.calls.map(([r]) => r).filter(r => r.method !== "GET");

describe("spending numbers", () => {
 it("reads only numbers that are the right shape", () => {
  const read = readOrgSpend({ spentThisMonthUsd: -1, remainingUsd: 10, heldUsd: "x", byProject: [{ name: "a", spentUsd: 5 }, { name: "bad" }, 7], byPerson: "no" });
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
 it("words the approval window", () => {
  expect(windowWords(60)).toBe("1 minute"); expect(windowWords(300)).toBe("5 minutes"); expect(windowWords(90)).toBe("90 seconds"); expect(windowWords(undefined)).toBe("Not set");
 });
 it("reads settings and factors, ignoring rows that are not the shape", () => {
  const read = readCompanySettings(settingsBody({ pending: { changeId: "chg_" + "a".repeat(20), proposedBy: "c", proposedAt: "2026-11-14T00:00:00Z", expiresAt: "2026-11-21T00:00:00Z", settings: { instructions: [{ text: "x", priority: "preferred" }], freshSignInSeconds: 60 } } }));
  expect(read).toMatchObject({ version: 4, freshSignInSeconds: 300, start: { allow: true, maxEstimateUsd: 5 }, pending: { instructions: [{ text: "x" }], freshSignInSeconds: 60 } });
  expect(() => readCompanySettings({ settings: {} })).toThrow();
  expect(readMyFactors({ factorEmail: "p***@acme.test", passkeys: [{ credentialId: "k1", createdAt: "2026-10-01T00:00:00Z" }, { credentialId: "k2", createdAt: "nope" }] }).passkeys).toHaveLength(1);
 });
});

describe("admin navigation", () => {
 it("groups the pages into five groups, not 14 flat tabs", () => {
  const groups = visibleAdminGroups("owner", false);
  expect(groups.map(group => group.title)).toEqual(["People and access", "Money", "Work and rules", "AI and connections", "Oversight"]);
  const all = groups.flatMap(group => group.links.map(link => link.label));
  expect(all).toEqual(expect.arrayContaining(["People", "Invites", "Sign-in clients", "Sign-in factors", "Spending", "Company settings", "How we work", "Audit", "Health"]));
 });
 it("hides owner-only and switched-off pages, and shows a member only the waiting queue", () => {
  expect(visibleAdminGroups("admin", false).flatMap(group => group.links.map(link => link.label))).not.toContain("Company domains");
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
   expect(within(nav).getByRole("link", { name: "Company domains" })).toBeTruthy();
  } finally { f.close(); }
 });
});

describe("Spending", () => {
 it("shows spent, held and left with the projects and people behind them", async () => {
  const f = mount("/app/admin/money/budgets", r => (r.path === "/v1/app/org/spend" ? ok(spendBody) : ok({})));
  try {
   const stats = await screen.findByRole("group", { name: "Spending in November" });
   expect(within(stats).getByText("$412.60")).toBeTruthy(); expect(within(stats).getByText("$38.20")).toBeTruthy(); expect(within(stats).getByText("$549.20")).toBeTruthy(); expect(within(stats).getByText("$3.84")).toBeTruthy();
   const projects = screen.getByRole("table", { name: "Spending by project" });
   expect(within(projects).getByText("evals-api")).toBeTruthy(); expect(within(projects).getByText("$201.40")).toBeTruthy();
   expect(projects.textContent).toContain("$0.40 left");
   const people = screen.getByRole("table", { name: "Spending by person" });
   expect(within(people).getByText("Priya Raman")).toBeTruthy(); expect(within(people).getByText("company default")).toBeTruthy();
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
   expect(screen.getByRole("link", { name: "See limits" }).getAttribute("href")).toBe("#limits");
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
 it("says per-project and per-person amounts are not connected when only the totals are served", async () => {
  const f = mount("/app/admin/money/budgets", r => (r.path === "/v1/app/org/spend" ? ok({ spentThisMonthUsd: 12, remainingUsd: 88 }) : ok({})));
  try { await screen.findByRole("group", { name: /Spending in/ }); expect(screen.getAllByTestId("not-connected")).toHaveLength(2); } finally { f.close(); }
 });
 it("has no accessibility violations with amounts shown", async () => {
  const f = mount("/app/admin/money/budgets", r => (r.path === "/v1/app/org/spend" ? ok(spendBody) : ok({})));
  try { await screen.findByRole("table", { name: "Spending by person" }); await expectNoAxeViolations(f.container); } finally { f.close(); }
 });
});

describe("Monthly limits", () => {
 it("say they are not connected yet when Cloud does not serve the budget settings", async () => {
  const f = mount("/app/admin/money/budgets", r => (r.path === "/v1/app/org/spend" ? ok(spendBody) : NOT_ON_CODE));
  try { expect(await screen.findByText("Monthly base budgets aren't connected to Rovara Code yet. No current amounts are shown.")).toBeTruthy(); } finally { f.close(); }
 });
});

describe("model gateway readiness", () => {
 const withReadiness = (modelGateway: unknown) => (r: ApiRequest): ApiResponse => (r.path === "/v1/app/org/settings" ? ok(settingsBody({ modelGateway })) : r.path === "/v1/app/org/spend" ? ok(spendBody) : ok({ members: [maya] }));
 it("says what to do on Spending when the company has no monthly cap, and links to where the cap is set", async () => {
  const f = mount("/app/admin/money/budgets", withReadiness(CAP_UNSET));
  try {
   const banner = await screen.findByRole("region", { name: "Set a monthly cap to use the model gateway." });
   expect(within(banner).getByRole("link", { name: "Set the cap" }).getAttribute("href")).toBe("/app/admin/settings#monthly-cap");
   expect(banner.textContent).toContain("Rovara picks no amount for you");
  } finally { f.close(); }
 });
 it("says it on the Overview too, and says nothing when the gateway is ready, when Cloud does not say, or when settings are not connected", async () => {
  const f = mount("/app/admin", withReadiness(CAP_UNSET));
  try { expect(await screen.findByText("Set a monthly cap to use the model gateway.")).toBeTruthy(); } finally { f.close(); }
  for (const answer of [withReadiness({ ready: true }), withReadiness(undefined), (r: ApiRequest) => (r.path === "/v1/app/org/settings" ? NOT_ON_CODE : ok({ members: [maya] }))]) {
   const g = mount("/app/admin", answer);
   try { await screen.findByRole("group", { name: "At a glance" }); await within(await screen.findByRole("group", { name: "At a glance" })).findByText("1"); expect(screen.queryByText("Set a monthly cap to use the model gateway.")).toBeNull(); } finally { g.close(); }
  }
 });
 it("shows an unknown reason with Cloud's own words, as plain text", async () => {
  const f = mount("/app/admin/money/budgets", withReadiness({ ready: false, reason: "something_new", message: "<b>Call us</b>" }));
  try { expect(await screen.findByText("The model gateway isn't ready for this company")).toBeTruthy(); expect(screen.getByText("<b>Call us</b>")).toBeTruthy(); } finally { f.close(); }
 });
 it("is shown on Company settings, with the cap on its own section", async () => {
  const f = mount("/app/admin/settings", r => (r.path === "/v1/app/org/settings" ? ok(settingsBody({ modelGateway: CAP_UNSET })) : ok({})));
  try {
   expect(await screen.findByText("Set a monthly cap to use the model gateway.")).toBeTruthy();
   expect(screen.getByText(/No monthly cap is set/)).toBeTruthy();
  } finally { f.close(); }
 });
 it("sets the cap from the editor after the fresh sign-in, sending it in micro-dollars with the rest of the budgets", async () => {
  const f = mount(confirmedPath("/app/admin/settings"), r => (r.method === "PUT" ? ok({ settings: {}, version: 5 }) : r.path === "/v1/app/org/settings" ? ok(settingsBody({ modelGateway: CAP_UNSET })) : ok({})));
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Change rules" }));
   const field = await screen.findByLabelText("Company monthly cap (USD)");
   fireEvent.change(field, { target: { value: "1500.50" } });
   fireEvent.click(screen.getByRole("button", { name: "Save rules" }));
   await screen.findByText(/Saved\. The new rules apply/);
   expect(writes(f).find(r => r.method === "PUT")?.body).toMatchObject({ expectedVersion: 4, settings: { budgets: { companyMonthlyUsdMicros: 1_500_500_000, memberMonthlyUsdMicros: null, projectMonthlyUsdMicros: null, taskUsdMicros: null } } });
  } finally { f.close(); }
 });
 it("keeps the learning cap under the company cap when saving, and leaves it alone otherwise", async () => {
  const withLearning = () => { const body = settingsBody(); return { ...body, settings: { ...body.settings, budgets: { ...body.settings.budgets, companyMonthlyUsdMicros: 500_000_000, learningMonthlyUsdMicros: 20_000_000 } } }; };
  for (const [typed, learning] of [["5", 5_000_000], ["100", 20_000_000]] as const) {
   const f = mount(confirmedPath("/app/admin/settings"), r => (r.method === "PUT" ? ok({ settings: {}, version: 5 }) : r.path === "/v1/app/org/settings" ? ok(withLearning()) : ok({})));
   try {
    fireEvent.click(await screen.findByRole("button", { name: "Change rules" }));
    fireEvent.change(await screen.findByLabelText("Company monthly cap (USD)"), { target: { value: typed } });
    fireEvent.click(screen.getByRole("button", { name: "Save rules" }));
    await screen.findByText(/Saved\. The new rules apply/);
    expect(writes(f).find(r => r.method === "PUT")?.body).toMatchObject({ settings: { budgets: { companyMonthlyUsdMicros: Number(typed) * 1_000_000, learningMonthlyUsdMicros: learning } } });
   } finally { f.close(); }
   cleanup();
  }
 });
 it("accepts a $0 cap (Cloud's validator does) and says it blocks all model gateway use", async () => {
  const f = mount(confirmedPath("/app/admin/settings"), r => (r.method === "PUT" ? ok({ settings: {}, version: 5 }) : r.path === "/v1/app/org/settings" ? ok(settingsBody()) : ok({})));
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Change rules" }));
   fireEvent.change(await screen.findByLabelText("Company monthly cap (USD)"), { target: { value: "0" } });
   expect(screen.getByText("A $0 cap blocks all model gateway use.")).toBeTruthy();
   fireEvent.click(screen.getByRole("button", { name: "Save rules" }));
   await screen.findByText(/Saved\. The new rules apply/);
   expect(writes(f).find(r => r.method === "PUT")?.body).toMatchObject({ settings: { budgets: { companyMonthlyUsdMicros: 0 } } });
  } finally { f.close(); }
 });
 it("says a stored $0 cap blocks all model gateway use", async () => {
  const body = settingsBody(); body.settings.budgets.companyMonthlyUsdMicros = 0 as unknown as null;
  const f = mount("/app/admin/settings", r => (r.path === "/v1/app/org/settings" ? ok(body) : ok({})));
  try { expect(await screen.findByText(/A \$0 cap blocks all model gateway use\./)).toBeTruthy(); } finally { f.close(); }
 });
 it("refuses a cap that is not a dollar amount before sending anything", async () => {
  const f = mount(confirmedPath("/app/admin/settings"), r => (r.path === "/v1/app/org/settings" ? ok(settingsBody()) : ok({})));
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Change rules" }));
   fireEvent.change(await screen.findByLabelText("Company monthly cap (USD)"), { target: { value: "lots" } });
   expect(screen.getByRole("button", { name: "Save rules" }).hasAttribute("disabled")).toBe(true);
   expect(screen.getByText("Enter an amount in dollars, like 1500 or 1500.50.")).toBeTruthy();
   expect(writes(f)).toHaveLength(0);
  } finally { f.close(); }
 });
});

describe("Overview", () => {
 it("shows this month's money and the people count, then the groups", async () => {
  const f = mount("/app/admin", r => (r.path === "/v1/app/org/spend" ? ok(spendBody) : ok({ members: [maya] })));
  try {
   const glance = await screen.findByRole("group", { name: "At a glance" });
   await within(glance).findByText("$412.60"); expect(within(glance).getByText("$549.20")).toBeTruthy(); expect(await within(glance).findByText("1")).toBeTruthy();
   expect(screen.getByRole("link", { name: "Open Spending" }).getAttribute("href")).toBe("/app/admin/money/budgets");
   expect(screen.getByRole("link", { name: "Open Health" })).toBeTruthy();
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
 it("shows the rules, the approval window and who may start work", async () => {
  const f = mount("/app/admin/settings", r => (r.path === "/v1/app/org/settings" ? ok(settingsBody()) : ok({})));
  try {
   expect(await screen.findByText("Never touch the billing tables.")).toBeTruthy();
   expect(screen.getByText("5 minutes")).toBeTruthy();
   expect(screen.getByText("Anyone with project access may start one")).toBeTruthy();
   expect(screen.getByText("$5.00")).toBeTruthy();
  } finally { f.close(); }
 });
 it("asks for the fresh sign-in first, and sends the person to Code's step-up page without changing anything", async () => {
  const f = mount("/app/admin/settings", r => (r.path === "/v1/app/org/settings" ? ok(settingsBody()) : ok({})));
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Change rules" }));
   const panel = await screen.findByTestId("fresh-sign-in");
   expect(panel.getAttribute("data-state")).toBe("ask");
   expect(screen.queryByRole("group", { name: "Edit company rules" })).toBeNull();
   fireEvent.click(screen.getByTestId("fresh-sign-in-start"));
   const call = (f.host.signIn as unknown as { mock: { calls: Array<[string, { stepUp?: boolean }]> } }).mock.calls.at(-1);
   expect(call?.[1]).toEqual({ stepUp: true });
   expect(call?.[0]).toMatch(/confirmed=[0-9a-f-]{36}/u);
   expect((JSON.parse(f.storage.get(NONCE_KEY) ?? "null") as { nonce?: string } | null)?.nonce).toMatch(/^[0-9a-f-]{36}$/u);
   expect(writes(f)).toHaveLength(0);
  } finally { f.close(); }
 });
 it("opens the editor after the person comes back confirmed, and saves the whole document with its version", async () => {
  const f = mount(confirmedPath("/app/admin/settings"), r => (r.method === "PUT" ? ok({ companyId: "x", version: 5, settings: {} }) : r.path === "/v1/app/org/settings" ? ok(settingsBody()) : ok({})));
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Change rules" }));
   fireEvent.change(await screen.findByLabelText("Rule 1"), { target: { value: "Never touch the billing or ledger tables." } });
   fireEvent.click(screen.getByRole("button", { name: "Save rules" }));
   await screen.findByText(/Saved\. The new rules apply/);
   const put = writes(f).find(r => r.method === "PUT");
   expect(put?.body).toMatchObject({  expectedVersion: 4, settings: { instructions: [{ text: "Never touch the billing or ledger tables.", priority: "required" }], freshSignInSeconds: 300, start: { allow: true }, websiteCeiling: { mode: "any" } } });
  } finally { f.close(); }
 });
 it("goes back to the fresh sign-in step when Code says the confirmation is too old", async () => {
  const f = mount(confirmedPath("/app/admin/settings"), r => (r.method === "PUT" ? { status: 403, body: { error: { code: "STEP_UP_REQUIRED", message: "Confirm it's you again, then try once more." } } } : r.path === "/v1/app/org/settings" ? ok(settingsBody()) : ok({})));
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Change rules" }));
   fireEvent.click(await screen.findByRole("button", { name: "Save rules" }));
   await waitFor(() => expect(screen.getByTestId("fresh-sign-in").getAttribute("data-state")).toBe("needed"));
   expect(screen.queryByRole("group", { name: "Edit company rules" })).toBeNull();
  } finally { f.close(); }
 });
 it("tells the person a loosening change is waiting for a second admin", async () => {
  const f = mount(confirmedPath("/app/admin/settings"), r => (r.method === "PUT" ? { status: 202, body: { companyId: "x", version: 4, pending: { changeId: "chg_" + "a".repeat(20) } } } : r.path === "/v1/app/org/settings" ? ok(settingsBody()) : ok({})));
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Change rules" }));
   fireEvent.click(await screen.findByRole("button", { name: "Save rules" }));
   expect(await screen.findByText(/Another company admin must approve/)).toBeTruthy();
  } finally { f.close(); }
 });
 it("asks a second admin for the fresh sign-in before approving a change someone else proposed", async () => {
  const pending = { changeId: "chg_" + "a".repeat(20), proposedBy: "c".repeat(64), proposedAt: "2026-11-14T00:00:00Z", expiresAt: "2026-11-21T00:00:00Z", settings: { instructions: [{ text: "Allow every website.", priority: "preferred" }], freshSignInSeconds: 600 } };
  const f = mount("/app/admin/settings", r => (r.path === "/v1/app/org/settings" ? ok(settingsBody({ pending })) : ok({})));
  try {
   expect(await screen.findByText("Allow every website.")).toBeTruthy();
   expect(screen.queryByRole("button", { name: "Approve this change" })).toBeNull();
   expect(screen.getByTestId("fresh-sign-in")).toBeTruthy();
   expect(screen.queryByRole("button", { name: "Change rules" })).toBeNull();
  } finally { f.close(); }
 });
});

describe("the fresh sign-in state", () => {
 const factors = { factorEmail: "p***@acme.test", passkeys: [{ credentialId: "key-one", createdAt: "2026-10-01T00:00:00Z" }] };
 it("is not a flag anyone can type: a made-up confirmed value shows the step, not the action", async () => {
  const f = mount("/app/account?remove=key-one&confirmed=1", r => (r.path === "/v1/app/me/sign-in-factors" ? ok(factors) : ok({})));
  try {
   const dialog = await screen.findByRole("dialog", { name: "Remove this passkey?" });
   expect(within(dialog).getByTestId("fresh-sign-in").getAttribute("data-state")).toBe("ask");
   expect(within(dialog).queryByRole("button", { name: "Remove passkey" })).toBeNull();
   await waitFor(() => expect(f.router.state.location.search).not.toContain("confirmed"));
  } finally { f.close(); }
 });
 it("does not accept an old nonce", async () => {
  seeded.set(NONCE_KEY, JSON.stringify({ nonce: "n-old", at: Date.now() - 11 * 60_000 }));
  const f = mount("/app/account?remove=key-one&confirmed=n-old", r => (r.path === "/v1/app/me/sign-in-factors" ? ok(factors) : ok({})));
  try { expect((await screen.findByTestId("fresh-sign-in")).getAttribute("data-state")).toBe("ask"); } finally { f.close(); }
 });
 it("cleans the address after the person comes back, and a reload no longer says confirmed once the window has passed", async () => {
  const f = mount(confirmedPath("/app/account?remove=key-one"), r => (r.path === "/v1/app/me/sign-in-factors" ? ok(factors) : ok({})));
  try {
   expect((await screen.findByTestId("fresh-sign-in")).getAttribute("data-state")).toBe("done");
   await waitFor(() => expect(f.router.state.location.search).toBe("?remove=key-one"));
   expect(f.storage.get(NONCE_KEY)).toBe("");
  } finally { f.close(); }
  seeded.set(`rovara.stepup.confirmedAt.${me}`, String(Date.now() - 11 * 60_000));
  const again = mount("/app/account?remove=key-one", r => (r.path === "/v1/app/me/sign-in-factors" ? ok(factors) : ok({})));
  try { expect((await screen.findByTestId("fresh-sign-in")).getAttribute("data-state")).toBe("ask"); } finally { again.close(); }
 });
 it("belongs to the person who confirmed: another person on the same browser sees the step", async () => {
  seeded.set(`rovara.stepup.confirmedAt.${"e".repeat(64)}`, String(Date.now()));
  const f = mount("/app/account?remove=key-one", r => (r.path === "/v1/app/me/sign-in-factors" ? ok(factors) : ok({})));
  try { expect((await screen.findByTestId("fresh-sign-in")).getAttribute("data-state")).toBe("ask"); } finally { f.close(); }
  seeded.set(`rovara.stepup.confirmedAt.${me}`, String(Date.now()));
  const mine = mount("/app/account?remove=key-one", r => (r.path === "/v1/app/me/sign-in-factors" ? ok(factors) : ok({})));
  try { expect((await screen.findByTestId("fresh-sign-in")).getAttribute("data-state")).toBe("done"); } finally { mine.close(); }
 });
 it("forgets the confirmation when the server says it is too old, and keeps asking for the next row and after a reload", async () => {
  const f = mount(confirmedPath("/app/admin/sign-in-factors"), r => (r.method === "PUT" ? { status: 403, body: { error: { code: "STEP_UP_REQUIRED", message: "again" } } } : ok(r.path.endsWith("/members") ? { members: [maya, { ...maya, developerId: "c".repeat(64), name: "Noor" }] } : {})));
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Set confirmation email for Maya" }));
   const dialog = await screen.findByRole("dialog");
   fireEvent.change(within(dialog).getByLabelText("New confirmation email"), { target: { value: "maya@acme.test" } });
   fireEvent.click(within(dialog).getByRole("button", { name: "Change confirmation email" }));
   await waitFor(() => expect(within(dialog).getByTestId("fresh-sign-in").getAttribute("data-state")).toBe("needed"));
   expect(f.storage.get(`rovara.stepup.confirmedAt.${me}`)).toBe("");
   fireEvent.click(within(dialog).getByRole("button", { name: /close/i }));
   fireEvent.click(await screen.findByRole("button", { name: "Set confirmation email for Noor" }));
   expect((await screen.findByTestId("fresh-sign-in")).getAttribute("data-state")).toBe("needed");
  } finally { f.close(); }
 });
 it("re-reads the company rules when it opens the editor, so an old copy is never saved over a newer version", async () => {
  let body = settingsBody();
  const f = mount(confirmedPath("/app/admin/settings"), r => (r.path === "/v1/app/org/settings" && r.method === "GET" ? ok(body) : r.method === "PUT" ? ok({ settings: {}, version: 6 }) : ok({})));
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

describe("Sign-in clients", () => {
 it("says not connected yet", async () => {
  const f = mount("/app/admin/sign-in-clients", r => (r.path.endsWith("/sign-in-clients") ? NOT_ON_CODE : ok({})));
  try { expect(await screen.findByTestId("not-connected")).toBeTruthy(); expect(screen.getByText(/Sign-in clients isn't connected to Rovara Code yet/)).toBeTruthy(); } finally { f.close(); }
 });
 it("lists the company's clients", async () => {
  const f = mount("/app/admin/sign-in-clients", r => (r.path.endsWith("/sign-in-clients") ? ok({ clients: [{ clientId: "c1", name: "Acme Okta", kind: "oidc", createdAt: "2026-10-01T00:00:00Z" }, { nope: 1 }] }) : ok({})));
  try { const table = await screen.findByRole("table", { name: "Sign-in clients" }); expect(within(table).getByText("Acme Okta")).toBeTruthy(); expect(within(table).getByText("Company login")).toBeTruthy(); } finally { f.close(); }
 });
});

describe("Sign-in factors for admins", () => {
 const people = (r: ApiRequest) => ok(r.path.endsWith("/members") ? { members: [maya] } : {});
 it("shows the fresh sign-in step before the form, and makes no change", async () => {
  const f = mount("/app/admin/sign-in-factors", people);
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Set confirmation email for Maya" }));
   const dialog = await screen.findByRole("dialog", { name: /Set confirmation email for Maya/ });
   expect(within(dialog).getByTestId("fresh-sign-in").getAttribute("data-state")).toBe("ask");
   expect(within(dialog).queryByLabelText("New confirmation email")).toBeNull();
   expect(writes(f)).toHaveLength(0);
  } finally { f.close(); }
 });
 it("sets the email after coming back confirmed, with a request id, and says the old address was told", async () => {
  const f = mount(confirmedPath(`/app/admin/sign-in-factors?person=${maya.developerId}&do=email`), r => (r.method === "PUT" ? ok({}) : people(r)));
  try {
   const dialog = await screen.findByRole("dialog");
   const send = within(dialog).getByRole("button", { name: "Change confirmation email" });
   expect((send as HTMLButtonElement).disabled).toBe(true);
   fireEvent.change(within(dialog).getByLabelText("New confirmation email"), { target: { value: "maya@acme.test" } });
   fireEvent.click(send);
   await within(dialog).findByText(/The old address was told first/);
   const put = writes(f)[0];
   expect(put?.path).toBe(`/v1/app/org/members/${maya.developerId}/factor-email`);
   expect(put?.body).toMatchObject({ email: "maya@acme.test" }); expect(typeof (put?.body as { requestId: string }).requestId).toBe("string");
  } finally { f.close(); }
 });
 it("removes passkeys only after the confirmation, and says not connected on a 501", async () => {
  const f = mount(confirmedPath(`/app/admin/sign-in-factors?person=${maya.developerId}&do=passkeys`), r => (r.method === "DELETE" ? NOT_ON_CODE : people(r)));
  try {
   const dialog = await screen.findByRole("dialog");
   fireEvent.click(within(dialog).getByRole("button", { name: "Remove all passkeys" }));
   expect(await within(dialog).findByTestId("not-connected")).toBeTruthy();
  } finally { f.close(); }
 });
});

describe("Sign-in factors rows", () => {
 it("sends a person to their own account page, and keeps an admin away from an owner's factors", async () => {
  const rows = [{ ...maya, developerId: me, name: "Priya", role: "admin" }, { ...maya, developerId: "d".repeat(64), name: "Olivia", role: "owner" }, maya];
  const f = mount("/app/admin/sign-in-factors", r => ok(r.path.endsWith("/members") ? { members: rows } : {}), { role: "admin" });
  try {
   await screen.findByRole("button", { name: "Set confirmation email for Maya" });
   expect(screen.getByRole("link", { name: "Your account" }).getAttribute("href")).toBe("/app/account");
   expect(screen.getByText("Owners only")).toBeTruthy();
   expect(screen.queryByRole("button", { name: "Set confirmation email for Olivia" })).toBeNull();
   expect(screen.queryByRole("button", { name: "Set confirmation email for Priya" })).toBeNull();
  } finally { f.close(); }
 });
});

describe("Your account", () => {
 const factors = { factorEmail: "p***@acme.test", passkeys: [{ credentialId: "key-one", createdAt: "2026-10-01T00:00:00Z", lastUsedAt: "2026-11-01T00:00:00Z" }] };
 it("says not connected yet for the email and passkeys", async () => {
  const f = mount("/app/account", r => (r.path === "/v1/app/me/sign-in-factors" ? NOT_ON_CODE : ok({})));
  try { await screen.findByRole("heading", { name: "Your account" }); await waitFor(() => expect(screen.getAllByTestId("not-connected")).toHaveLength(2)); } finally { f.close(); }
 });
 it("lists the email and the passkeys, and asks for the fresh sign-in before removing one", async () => {
  const f = mount("/app/account", r => (r.path === "/v1/app/me/sign-in-factors" ? ok(factors) : ok({})));
  try {
   expect((await screen.findByTestId("factor-email")).textContent).toBe("p***@acme.test");
   const list = screen.getByRole("list", { name: "Your passkeys" });
   fireEvent.click(within(list).getByRole("button", { name: /Remove the passkey added/ }));
   const dialog = await screen.findByRole("dialog", { name: "Remove this passkey?" });
   expect(within(dialog).getByTestId("fresh-sign-in").getAttribute("data-state")).toBe("ask");
   expect(within(dialog).queryByRole("button", { name: "Remove passkey" })).toBeNull();
   expect(writes(f)).toHaveLength(0);
  } finally { f.close(); }
 });
 it("removes the passkey after the confirmation", async () => {
  const f = mount(confirmedPath("/app/account?remove=key-one"), r => (r.method === "DELETE" ? ok({}) : r.path === "/v1/app/me/sign-in-factors" ? ok(factors) : ok({})));
  try {
   const dialog = await screen.findByRole("dialog", { name: "Remove this passkey?" });
   fireEvent.click(within(dialog).getByRole("button", { name: "Remove passkey" }));
   await screen.findByText(/Passkey removed/);
   expect(writes(f)[0]?.path).toBe("/v1/app/me/passkeys/key-one");
  } finally { f.close(); }
 });
 it("has no accessibility violations", async () => {
  const f = mount("/app/account", r => (r.path === "/v1/app/me/sign-in-factors" ? ok(factors) : ok({})));
  try { await screen.findByTestId("factor-email"); await expectNoAxeViolations(f.container); } finally { f.close(); }
 });
});
