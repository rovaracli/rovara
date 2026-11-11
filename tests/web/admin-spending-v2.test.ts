// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { isSpendingV2On, SPENDING_STORAGE_KEY } from "../../packages/ui/src/screens/admin/spending-flags.js";
import { approverWords, availableUsd, barShares, isOverAllowance, monthLabel, percentOf, requestKindWords, sourceWords } from "../../packages/ui/src/screens/admin/spending-format.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";
const orgId = "org_aaaaaaaaaaaaaaaaaaaa", me = "a".repeat(64), maya = "b".repeat(64), gone = "c".repeat(64);
const settings = { orgId, checkedAt: "2026-11-11T12:00:00Z", coverage: "monthly_base_settings_only", orgMonthly: { kind: "limited", microdollars: 500_000_000, source: "configured" }, memberDefaultMonthly: { kind: "limited", microdollars: 29_000_000, source: "configured" }, memberOverrideCount: 2, memberOverrideCoverage: "configured_only_membership_not_checked", usage: "not_checked", topUps: "not_checked", enforcement: "not_checked" };
const budget = { month: "2026-11", member: { spentUsd: 12.5, committedUsd: 1, limitUsd: 29 }, org: { spentUsd: 200, committedUsd: 50, limitUsd: 500 }, testing: { spentUsd: 0, committedUsd: 0 }, personalPlan: { tokens: 0 }, alerts: [] };
const orgSpend = { month: "2026-11", totalUsd: 200, committedUsd: 50, limitUsd: 500, byProject: [{ project: "payments", spentUsd: 150, committedUsd: 30 }, { project: "web", spentUsd: 50, committedUsd: 20 }], byMember: [{ developerId: maya, spentUsd: 187.5 }, { developerId: me, spentUsd: 12.5 }, { developerId: gone, spentUsd: 0.25 }], byAgent: [], byModel: [], bySource: [{ source: "rovara", spentUsd: 150 }, { source: "anthropic", spentUsd: 50 }, { source: "mystery_enum", spentUsd: 0 }] };
const confirmUrl = "https://cell.example/v1/app/approve/spr_aaaaaaaaaaaaaaaaaaaa";
const requests = { spendRequests: [{ spendRequestId: "spr_aaaaaaaaaaaaaaaaaaaa", status: "PENDING", createdAt: "2026-11-10T10:00:00.000Z", kind: "month", amountUsd: 25, reason: "Release week", approverRole: "org_admin", confirmUrl }, { spendRequestId: "spr_bbbbbbbbbbbbbbbbbbbb", status: "PENDING", createdAt: "2026-11-10T11:00:00.000Z", kind: "run_limit", amountUsd: 5, approverRole: "project_maintainer", confirmUrl: "https://evil.example/x" }] };
const members = { members: [{ developerId: me, name: "Priya", role: "owner" }, { developerId: maya, name: "Maya", role: "member" }] };
const forbiddenBody = { status: 403, body: { error: { code: "FORBIDDEN", message: "Only an org owner or admin can see the company's spend." } } };
type Answers = Record<string, ApiResponse | (() => ApiResponse)>;
const base: Answers = { "/v1/app/budget": { status: 200, body: budget }, "/v1/app/org/spend": { status: 200, body: orgSpend }, "/v1/app/spend-requests": { status: 200, body: requests }, "/v1/app/org/budget-settings": { status: 200, body: settings }, "/v1/app/org/members": { status: 200, body: members } };
function mount(options: { on?: boolean; role?: string; answers?: Answers; width?: number; theme?: "light" | "dark" } = {}) {
 const nav = AppNavSchema.parse({ me: { developerId: me, name: "Priya", orgRole: options.role ?? "owner" }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features: { admin: true, localAgents: false, usage: false, chains: false, describe: false, notices: false } });
 const identity = { developer: { id: me, name: "Priya", orgRole: options.role ?? "owner" }, org: { orgId, name: "Acme", plan: "team" }, identities: [] };
 const answers = { ...base, ...options.answers };
 const f = fakeHost(async (r: ApiRequest) => { const path = r.path.split("?")[0]!;if (path === "/v1/app/me") return { status: 200, body: identity };if (path === "/v1/app/nav") return { status: 200, body: nav };const answer = answers[path];if (answer === undefined) return { status: 404, body: { error: { code: "NOT_FOUND" } } };return typeof answer === "function" ? answer() : answer; });
 if (options.width !== undefined) f.host.viewport = { width: () => options.width ?? 1280, subscribe: () => () => undefined };
 f.storage.set("rovara.theme", options.theme ?? "light");if (options.on !== false) f.storage.set(SPENDING_STORAGE_KEY, "v2");
 const query = createQueryClient();query.setQueryData(["nav"], nav);
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: ["/app/admin/money/budgets"] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 return { ...f, ...view, query, router, close() { view.unmount();router.dispose();query.clear(); } };
}
const calls = (f: ReturnType<typeof mount>, path: string) => f.request.mock.calls.filter(([r]) => r.path.split("?")[0] === path).length;

describe("the switch", () => {
 it("is off unless the device key is exactly v2, and never throws", () => {
  expect(isSpendingV2On({ storage: { get: () => undefined } })).toBe(false);
  expect(isSpendingV2On({ storage: { get: key => key === "rovara.spending" ? "v2" : undefined } })).toBe(true);
  expect(isSpendingV2On({ storage: { get: () => "v3" } })).toBe(false);
  expect(isSpendingV2On({ storage: { get: () => { throw new Error("blocked"); } } })).toBe(false);
 });
 it("off: today's budgets page, and none of the spending reads are made", async () => {
  const f = mount({ on: false });
  try {
   await screen.findByRole("table", { name: "Monthly base budgets" });
   expect(screen.getByText(/Monthly base budgets are read only/)).toBeTruthy();
   expect(screen.queryByRole("heading", { name: /This month/ })).toBeNull();
   for (const path of ["/v1/app/budget", "/v1/app/org/spend", "/v1/app/spend-requests"]) expect(calls(f, path)).toBe(0);
  } finally { f.close(); }
 });
});

describe("number and word formatting", () => {
 it("works out available, the bar and the share without going past 100 or below 0", () => {
  expect(availableUsd({ spentUsd: 200, committedUsd: 50, limitUsd: 500 })).toBe(250);
  expect(availableUsd({ spentUsd: 0.1, committedUsd: 0.2, limitUsd: 0.3 })).toBe(0);
  expect(availableUsd({ spentUsd: 600, committedUsd: 0, limitUsd: 500 })).toBe(0);
  expect(availableUsd({ spentUsd: 5, committedUsd: 0 })).toBeUndefined();
  expect(isOverAllowance({ spentUsd: 480, committedUsd: 30, limitUsd: 500 })).toBe(true);
  expect(isOverAllowance({ spentUsd: 480, committedUsd: 20, limitUsd: 500 })).toBe(false);
  expect(barShares({ spentUsd: 200, committedUsd: 50, limitUsd: 500 })).toEqual({ spent: 40, held: 10 });
  expect(barShares({ spentUsd: 480, committedUsd: 100, limitUsd: 500 })).toEqual({ spent: 96, held: 4 });
  expect(barShares({ spentUsd: 5, committedUsd: 1, limitUsd: 0 })).toEqual({ spent: 0, held: 0 });
  expect(barShares({ spentUsd: 5, committedUsd: 1 })).toEqual({ spent: 0, held: 0 });
  expect(percentOf(150, 200)).toBe(75);
  expect(percentOf(1, 0)).toBe(0);
 });
 it("names months, sources, requests and approvers in words and never shows a raw value", () => {
  expect(monthLabel("2026-11")).toBe("November 2026");
  expect(monthLabel("nonsense")).toBe("This month");
  expect(sourceWords("rovara")).toBe("Rovara-provided");
  expect(sourceWords("mystery_enum")).toBe("Another source");
  expect(sourceWords("__proto__")).toBe("Another source");
  expect(requestKindWords("month")).toBe("More monthly budget");
  expect(requestKindWords("owner_cap_x")).toBe("Other request");
  expect(requestKindWords(undefined)).toBe("Other request");
  expect(approverWords("org_admin")).toBe("Company owners and admins");
  expect(approverWords("constructor")).toBe("Whoever the company allows");
 });
});

describe("the Spending page, switch on", () => {
 it("owner: this month in numbers, the split by source, people, projects, requests and limits, from existing reads only", async () => {
  const f = mount();
  try {
   await screen.findByRole("heading", { name: "This month: November 2026" });
   const figures = screen.getByRole("heading", { name: /This month/ }).nextElementSibling as HTMLElement;
   expect(within(figures).getByText("Spent").nextElementSibling?.textContent).toBe("$200.00");
   expect(within(figures).getByText("Held for work in progress").nextElementSibling?.textContent).toBe("$50.00");
   expect(within(figures).getByText("Available").nextElementSibling?.textContent).toBe("$250.00");
   expect(figures.textContent).toContain("$500.00");
   const sources = await screen.findByRole("list", { name: "Spending by source" });
   expect(within(sources).getByText("Rovara-provided")).toBeTruthy();expect(within(sources).getByText("Company Anthropic key")).toBeTruthy();expect(within(sources).getByText("Another source")).toBeTruthy();
   expect(screen.queryByText("mystery_enum")).toBeNull();expect(screen.queryByText("rovara")).toBeNull();
   const peopleTable = await screen.findByRole("table", { name: "Spending by person this month" });
   expect(within(peopleTable).getByText("Maya")).toBeTruthy();expect(within(peopleTable).getByText("Former member")).toBeTruthy();expect(within(peopleTable).getByText("(you)")).toBeTruthy();
   expect(within(peopleTable).getByText("$187.50")).toBeTruthy();
   expect(screen.getByText(/2 people have their own allowance/)).toBeTruthy();
   const projects = await screen.findByRole("table", { name: "Spending by project this month" });
   expect(within(projects).getByText("payments")).toBeTruthy();expect(within(projects).queryByText(/allocat/i)).toBeNull();
   expect(screen.getByText(/Projects do not get an allowance of their own/)).toBeTruthy();
   const limits = screen.getByRole("heading", { name: "Limits" }).parentElement!;
   await within(limits).findByText("Company, each month");
   expect(within(limits).getByText("$29.00")).toBeTruthy();
   expect(within(limits).getByText(/can't be changed in the web yet/)).toBeTruthy();
   expect(screen.queryByRole("button", { name: /change limits/i })).toBeNull();
   expect(f.request.mock.calls.every(([r]) => r.method === "GET" || r.path.includes("task-stop"))).toBe(true);
  } finally { f.close(); }
 });
 it("requests: plain words, who can approve, an own-origin confirmation link opens, any other falls back to the waiting page", async () => {
  const f = mount();
  try {
   const table = await screen.findByRole("table", { name: "Spending requests waiting" });
   expect(within(table).getByText("More monthly budget")).toBeTruthy();expect(within(table).getByText("More budget for one task")).toBeTruthy();
   expect(within(table).getByText("Company owners and admins")).toBeTruthy();expect(within(table).getByText("The project's maintainers")).toBeTruthy();
   expect(within(table).getByText("Release week")).toBeTruthy();expect(within(table).getByText("No reason given")).toBeTruthy();
   expect(screen.queryByText("org_admin")).toBeNull();expect(screen.queryByText("run_limit")).toBeNull();
   const open = within(table).getAllByRole("button", { name: "Open to review" });
   expect(open).toHaveLength(1);
   fireEvent.click(open[0]!);expect(f.host.openExternal).toHaveBeenCalledWith(confirmUrl);
   expect(within(table).getByRole("link", { name: "Approve in Waiting for people" }).getAttribute("href")).toBe("/app/admin/waiting");
   expect(within(table).queryByRole("button", { name: /^(approve|deny)$/i })).toBeNull();
  } finally { f.close(); }
 });
 it("per-person spend is shown only when the broker returns it: a viewer the broker refuses sees own figures and totals, and no one else's rows", async () => {
  const f = mount({ role: "admin", answers: { "/v1/app/org/spend": forbiddenBody, "/v1/app/org/budget-settings": forbiddenBody } });
  try {
   await screen.findByRole("heading", { name: "This month: November 2026" });
   await screen.findByText(/Spending by person is shown to company owners and admins/);
   expect(screen.getByText(/Spending by project is shown to company owners and admins/)).toBeTruthy();
   expect(screen.getByText(/The split by source is shown to company owners and admins/)).toBeTruthy();
   expect(screen.getByText(/Monthly limits are shown to company owners and admins/)).toBeTruthy();
   expect(screen.queryByRole("table", { name: /by person/ })).toBeNull();expect(screen.queryByText("Maya")).toBeNull();expect(screen.queryByText("$187.50")).toBeNull();
   const own = screen.getByText(/You see your own spending/);expect(own.textContent).toContain("$12.50");expect(own.textContent).toContain("$29.00");
   // totals still show
   expect(screen.getAllByText("$200.00").length).toBeGreaterThan(0);
   expect(screen.queryByRole("alert")).toBeNull();
  } finally { f.close(); }
 });
 it("shows what the broker returns and does not hide it: person rows returned for any role are displayed (a broker finding, not a UI fix)", async () => {
  const f = mount({ role: "admin" });
  try {
   const table = await screen.findByRole("table", { name: "Spending by person this month" });
   expect(within(table).getByText("Maya")).toBeTruthy();
  } finally { f.close(); }
 });
 it("honest empty states", async () => {
  const f = mount({ answers: { "/v1/app/budget": { status: 200, body: { ...budget, org: { spentUsd: 0, committedUsd: 0 } } }, "/v1/app/org/spend": { status: 200, body: { ...orgSpend, byProject: [], byMember: [], bySource: [] } }, "/v1/app/spend-requests": { status: 200, body: { spendRequests: [] } }, "/v1/app/org/budget-settings": { status: 200, body: { ...settings, orgMonthly: { kind: "unlimited", source: "unset" }, memberDefaultMonthly: { kind: "unlimited", source: "unset" }, memberOverrideCount: 0 } } } });
  try {
   await screen.findByText(/No monthly allowance is set/);
   expect(screen.getAllByText("No limit set", { selector: "dd" }).length).toBeGreaterThan(0);
   expect(await screen.findByText("No AI spending is recorded for this month yet.")).toBeTruthy();
   expect(screen.getByText("No one has spent anything this month yet.")).toBeTruthy();
   expect(screen.getByText("No project has spent anything this month yet.")).toBeTruthy();
   expect(screen.getByText("No spending requests are waiting for you.")).toBeTruthy();
   expect(document.querySelector(".rv-spend-bar")).toBeNull();
  } finally { f.close(); }
 });
 it("past the allowance: says so and never shows a negative available amount", async () => {
  const f = mount({ answers: { "/v1/app/budget": { status: 200, body: { ...budget, org: { spentUsd: 520, committedUsd: 10, limitUsd: 500 } } } } });
  try {
   await screen.findByText(/past the company's allowance/);
   const figures = screen.getByRole("heading", { name: /This month/ }).nextElementSibling as HTMLElement;
   expect(within(figures).getByText("Available").nextElementSibling?.textContent).toBe("$0.00");
   expect(document.querySelector<HTMLElement>(".rv-spend-bar-spent")?.style.width).toBe("100%");
   expect(document.querySelector<HTMLElement>(".rv-spend-bar-held")?.style.width).toBe("0%");
  } finally { f.close(); }
 });
 it("each failed read says so for its own part only, with no stale or invented amounts, and Refresh asks again", async () => {
  let fail = true;
  const f = mount({ answers: { "/v1/app/budget": () => fail ? { status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "private upstream detail" } } } : { status: 200, body: budget }, "/v1/app/spend-requests": { status: 500, body: {} }, "/v1/app/org/spend": { status: 200, body: { ...orgSpend, byMember: "bad" } } } });
  try {
   await screen.findByText(/Couldn't load spending requests/, undefined, { timeout: 9000 });await screen.findByText(/Couldn't load this month's spending/, undefined, { timeout: 9000 });
   expect(screen.getByText(/Couldn't load this month's spending/)).toBeTruthy();expect(screen.getByText(/Couldn't load spending requests/)).toBeTruthy();expect(screen.getByText(/Couldn't load spending by person/)).toBeTruthy();
   expect(screen.queryByText("private upstream detail")).toBeNull();expect(screen.queryByText("$200.00")).toBeNull();expect(screen.queryByText("$187.50")).toBeNull();
   expect(screen.getByRole("heading", { name: "Limits" })).toBeTruthy();
   fail = false;
   fireEvent.click(screen.getByRole("button", { name: "Refresh spending" }));
   await screen.findByRole("heading", { name: "This month: November 2026" });
   expect(calls(f, "/v1/app/budget")).toBeGreaterThan(1);
  } finally { f.close(); }
 }, 20_000);
 it("refuses a malformed or negative figure instead of showing it", async () => {
  const f = mount({ answers: { "/v1/app/budget": { status: 200, body: { ...budget, org: { spentUsd: -5, committedUsd: 0, limitUsd: 500 } } } } });
  try { await screen.findByText(/Couldn't load this month's spending/);expect(screen.queryByText("$500.00", { selector: "dd" })).toBeNull(); } finally { f.close(); }
 });
 it("neutralises control characters in names, projects and reasons", async () => {
  const f = mount({ answers: { "/v1/app/org/spend": { status: 200, body: { ...orgSpend, byProject: [{ project: "pay‮ments", spentUsd: 1, committedUsd: 0 }] } } } });
  try { await screen.findByText("pay[U+202E]ments"); } finally { f.close(); }
 });
 for (const theme of ["light", "dark"] as const) it(`has no accessibility violations in ${theme}`, async () => {
  const f = mount({ theme });
  try { await screen.findByRole("table", { name: "Spending by project this month" });await screen.findByRole("table", { name: "Spending requests waiting" });await expectNoAxeViolations(f.container); } finally { f.close(); }
 });
 it("phone width still renders the whole page", async () => {
  const f = mount({ width: 390 });
  try { await screen.findByRole("heading", { name: "This month: November 2026" });expect(screen.getByRole("button", { name: "Settings menu" })).toBeTruthy(); } finally { f.close(); }
 });
});
