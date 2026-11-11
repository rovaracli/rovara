// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, type AppNav } from "@agentx/cloud-contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { isInsightsOn, INSIGHTS_STORAGE_KEY } from "../../packages/ui/src/screens/insights/insights-flags.js";
import { ageWords, barPercent, durationWords, nextActorWords, notCoveredWords, notReadyWords, rateWords, recentMonths } from "../../packages/ui/src/screens/insights/insights-format.js";
import { InsightsOverviewReaderSchema, InsightsSpendReaderSchema, InsightsStuckReaderSchema } from "../../packages/ui/src/api/insights.js";
import { currentDestination, destinationsFor } from "../../packages/ui/src/shell/destinations.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";

const features = { localAgents: false, usage: false, admin: true, chains: false, notices: false, describe: false };
const ME = "a".repeat(64), MAYA = "b".repeat(64), SAM = "c".repeat(64), DANA = "d".repeat(64);
const ASOF = "2026-11-11T12:00:00.000Z";
const nav = (orgRole = "owner"): AppNav => AppNavSchema.parse({ me: { developerId: ME, name: "Priya", orgRole }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
const coverage = { sources: ["sessions"], notCovered: ["plan_reviews", "merge_readiness"], partial: false, truncated: false };
type Via = "owner" | "admin" | "viewer_grant" | "maintainer";
function overview(options: { role?: string; via?: Via[]; projects?: string[]; shipped?: string; flow?: string; outcomes?: string; perPerson?: boolean; since?: string | null; contentLevel?: string; enabled?: boolean } = {}) {
 const company = options.projects === undefined;
 return { enabled: options.enabled ?? true, viewer: { role: options.role ?? "owner", via: options.via ?? ["owner"], scope: company ? { kind: "company" } : { kind: "projects", projects: options.projects }, contentLevel: options.contentLevel ?? "full_where_readable", canSeePerPerson: options.perPerson ?? true },
  panels: { stuck: { status: "ready", coverage }, shipped: { status: options.shipped ?? "collecting", collectingSince: options.since === undefined ? "2026-11-16T00:00:00.000Z" : options.since }, spend: { status: "ready", outcomesStatus: options.outcomes ?? "collecting" }, flow: { status: options.flow ?? "unavailable", collectingSince: null } },
  capture: { workEvents: "off", since: null, retentionMonths: 13 }, asOf: ASOF };
}
const stuck = (extra: Record<string, unknown> = {}) => ({ status: "ready", asOf: ASOF, coverage, summary: { total: 2, over24h: 2, over72h: 1, byNextActorKind: { person: 2, unknown: 0 }, byBlocker: { review: 1, decision: 1 } }, items: [
 { itemId: "ses_" + "a".repeat(20), project: "payments", blocker: "decision", state: "needs_you", stateWords: "Needs you", nextActor: { kind: "person", name: "Maya Chen", role: "reviewer" }, since: "2026-11-10T10:00:00.000Z", sinceKind: "last_update", ageHours: 26, visibility: "full", title: "Retry the payment webhook", reason: "the checks didn't pass", link: "https://app.example/s/ses_" + "a".repeat(20), owner: { id: ME, name: "Priya Shah" } },
 { itemId: "ses_" + "b".repeat(20), project: "web", blocker: "review", state: "needs_you", stateWords: "Needs you", nextActor: { kind: "person", name: "Dana Wu" }, since: "2026-11-07T10:00:00.000Z", sinceKind: "last_update", ageHours: 98, visibility: "metadata", owner: { id: SAM, name: "Sam Lee" } },
 ], ...extra });
const shippedAnswer = { status: "collecting", collectingSince: "2026-11-16T00:00:00.000Z", weeks: [{ weekStart: "2026-11-09", shipped: 12, byProject: [{ project: "payments", shipped: 7, items: [{ itemId: "ses_" + "a".repeat(20), mergedAt: "2026-11-10T09:00:00.000Z", visibility: "full", title: "Fix refunds", prs: [{ repository: "acme/api", number: 412, url: "https://github.com/acme/api/pull/412" }], tickets: [{ key: "PAY-9", url: "https://linear.app/acme/issue/PAY-9" }] }, { itemId: "ses_" + "b".repeat(20), mergedAt: "2026-11-10T10:00:00.000Z", visibility: "metadata" }] }] }] };
const spendAnswer = (extra: Record<string, unknown> = {}) => ({ month: "2026-11", status: "ready", scope: "company", totals: { spentUsd: 412.5, committedUsd: 431, limitUsd: 500 }, byProject: [{ project: "payments", spentUsd: 210.2, committedUsd: 218, limitUsd: 300, people: 1, shipped: null, costPerShippedUsd: null }, { project: "web", spentUsd: 100, committedUsd: 100, people: null, shipped: null, costPerShippedUsd: null }], outcomes: { status: "collecting" }, ...extra });
const person = [{ developerId: MAYA, name: "Maya Chen", spentUsd: 88.1, limitUsd: 29 }];
const flowAnswer = { days: 30, status: "collecting", collectingSince: "2026-11-01T00:00:00.000Z", minSamples: 5, company: { items: 3, enough: false }, byProject: [] };
const members = { members: [{ developerId: ME, name: "Priya", role: "owner" }, { developerId: MAYA, name: "Maya Chen", role: "member" }, { developerId: SAM, name: "Sam Lee", role: "member" }, { developerId: DANA, name: "Dana Wu", role: "auditor" }] };
const accessList = (viewers: Array<{ id: string; name: string }>) => ({ viewers: viewers.map(v => ({ person: v, grantedBy: { id: ME, name: "Priya" }, grantedAt: "2026-11-10T09:00:00.000Z" })), eligibleCount: 2 });
type Answer = ApiResponse | ((request: ApiRequest) => ApiResponse);
type Answers = Record<string, Answer>;
const forbidden: ApiResponse = { status: 403, body: { error: { code: "FORBIDDEN", message: "You can't see Insights." } } };
function defaults(role: string, o: Parameters<typeof overview>[0]): Answers {
 return { "/v1/app/insights": { status: 200, body: overview({ role, ...o }) }, "/v1/app/insights/stuck": { status: 200, body: stuck() }, "/v1/app/insights/shipped": { status: 200, body: shippedAnswer }, "/v1/app/insights/spend": { status: 200, body: spendAnswer() }, "/v1/app/insights/flow": { status: 200, body: flowAnswer },
  "/v1/app/org/insights-access": { status: 200, body: accessList([{ id: MAYA, name: "Maya Chen" }]) }, "/v1/app/org/members": { status: 200, body: members } };
}
function mount(options: { on?: boolean; role?: string; path?: string; newNav?: boolean; answers?: Answers; overview?: Parameters<typeof overview>[0]; theme?: "light" | "dark" } = {}) {
 const role = options.role ?? "owner", value = nav(role), answers = { ...defaults(role, options.overview ?? {}), ...options.answers };
 const f = fakeHost(async (r: ApiRequest) => {
  const path = r.path.split("?")[0]!;
  if (path === "/v1/app/nav") return { status: 200, body: value };
  const answer = answers[path];
  if (answer === undefined) return { status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } };
  return typeof answer === "function" ? answer(r) : answer;
 });
 f.storage.set("rovara.theme", options.theme ?? "light");if (options.on !== false) f.storage.set(INSIGHTS_STORAGE_KEY, "v2");if (options.newNav === true) f.storage.set("rovara.nav", "v2");
 const query = createQueryClient();query.setQueryData(["nav"], value);
 const router = createMemoryRouter(appRoutes(value.features, { newNav: options.newNav === true, insights: isInsightsOn(f.host) }), { initialEntries: [options.path ?? "/app/insights"] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 return { ...f, ...view, query, router, close() { view.unmount();router.dispose();query.clear(); } };
}
const calls = (f: ReturnType<typeof mount>, path: string, method = "GET") => f.request.mock.calls.map(([r]) => r).filter(r => r.path.split("?")[0] === path && r.method === method);
const insightsCalls = (f: ReturnType<typeof mount>) => f.request.mock.calls.map(([r]) => r.path).filter(path => path.startsWith("/v1/app/insights") || path.startsWith("/v1/app/org/insights-access"));
const panel = async (name: string) => within(await screen.findByRole("region", { name }));

describe("the switch", () => {
 it("is off unless the device key is exactly v2, and never throws", () => {
  expect(INSIGHTS_STORAGE_KEY).toBe("rovara.insights");
  expect(isInsightsOn({ storage: { get: () => undefined } })).toBe(false);
  for (const value of ["", "v1", "V2", "true", "1", "v2 "]) expect(isInsightsOn({ storage: { get: () => value } })).toBe(false);
  expect(isInsightsOn({ storage: { get: () => "v2" } })).toBe(true);
  expect(isInsightsOn({ storage: { get: () => { throw new Error("blocked"); } } })).toBe(false);
 });
 it("off: no route (a direct address is 'not found'), no Insights request at all", async () => {
  const children = (opts: { insights?: boolean }) => appRoutes(features, opts).flatMap(route => route.children ?? []);
  expect(children({}).some(route => route.path === "insights")).toBe(false);
  expect(children({ insights: true }).some(route => route.path === "insights")).toBe(true);
  const f = mount({ on: false });
  try {
   await screen.findByText(/We couldn't find that\./);
   expect(screen.queryByRole("heading", { name: "Insights" })).toBeNull();
   expect(insightsCalls(f)).toEqual([]);
  } finally { f.close(); }
 });
});

describe("the navigation entry", () => {
 it("destinations: Insights only when asked, before Settings, and the page counts as Insights", () => {
  expect(destinationsFor(nav()).map(d => d.id)).toEqual(["home", "work", "projects", "agents", "settings"]);
  expect(destinationsFor(nav(), { insights: true }).map(d => d.id)).toEqual(["home", "work", "projects", "agents", "insights", "settings"]);
  expect(currentDestination("/app/insights")).toBe("insights");
 });
 it("switch on and the server says yes: the link is in the new navigation's sidebar, not in the phone tab bar", async () => {
  const f = mount({ on: true, newNav: true, path: "/app/work" });
  try {
   await waitFor(() => { expect(within(screen.getByRole("navigation", { name: "Workspace" })).getByRole("link", { name: "Insights" })).toBeTruthy(); });
   expect(within(screen.getByRole("navigation", { name: "Main destinations" })).queryByRole("link", { name: "Insights" })).toBeNull();
  } finally { f.close(); }
 });
 it("switch on but the server refuses (403): no entry", async () => {
  const f = mount({ on: true, newNav: true, path: "/app/work", answers: { "/v1/app/insights": forbidden } });
  try {
   await waitFor(() => { expect(calls(f, "/v1/app/insights").length).toBe(1); });
   await waitFor(() => { expect(f.request.mock.calls.length).toBeGreaterThan(0); });
   expect(within(screen.getByRole("navigation", { name: "Workspace" })).queryByRole("link", { name: "Insights" })).toBeNull();
  } finally { f.close(); }
 });
 it("switch on but the server says it is not enabled: no entry", async () => {
  const f = mount({ on: true, newNav: true, path: "/app/work", overview: { enabled: false } });
  try {
   await waitFor(() => { expect(calls(f, "/v1/app/insights").length).toBe(1); });
   expect(within(screen.getByRole("navigation", { name: "Workspace" })).queryByRole("link", { name: "Insights" })).toBeNull();
  } finally { f.close(); }
 });
 it("switch off: no entry and no request, in the new navigation", async () => {
  const f = mount({ on: false, newNav: true, path: "/app/work" });
  try {
   await waitFor(() => { expect(screen.getByRole("navigation", { name: "Workspace" })).toBeTruthy(); });
   expect(within(screen.getByRole("navigation", { name: "Workspace" })).queryByRole("link", { name: "Insights" })).toBeNull();
   expect(insightsCalls(f)).toEqual([]);
  } finally { f.close(); }
 });
});

describe("who sees what (role scopes)", () => {
 for (const [name, role, via] of [["owner", "owner", ["owner"]], ["admin", "admin", ["admin"]], ["Insights viewer", "member", ["viewer_grant"]]] as const) {
  it(`${name}: the whole company, all four panels, no project filter`, async () => {
   const f = mount({ role, overview: { role, via: [...via], contentLevel: name === "Insights viewer" ? "metadata_only_elsewhere" : "full_where_readable", perPerson: name !== "Insights viewer" } });
   try {
    await screen.findByRole("heading", { name: "Stuck work" });
    for (const title of ["Stuck work", "Shipped outcomes", "Spend vs outcomes", "Flow health"]) expect(screen.getByRole("region", { name: title })).toBeTruthy();
    expect(screen.getByText(/^Showing the whole company\./)).toBeTruthy();
    expect(screen.queryByLabelText("Project")).toBeNull();
    expect(screen.queryAllByText(/only see what a task says/).length).toBe(name === "Insights viewer" ? 1 : 0);
   } finally { f.close(); }
  });
 }
 it("only an owner or admin sees the grant control; a viewer and a maintainer do not, and make no access call", async () => {
  const owner = mount({ role: "owner" });
  try { await screen.findByRole("heading", { name: "Who can see Insights" }); } finally { owner.close(); }
  for (const [role, via, projects] of [["member", ["viewer_grant"], undefined], ["member", ["maintainer"], ["payments", "web"]]] as const) {
   const f = mount({ role, overview: { role, via: [...via], ...(projects === undefined ? {} : { projects: [...projects] }), perPerson: false } });
   try {
    await screen.findByRole("heading", { name: "Stuck work" });
    expect(screen.queryByRole("heading", { name: "Who can see Insights" })).toBeNull();
    expect(calls(f, "/v1/app/org/insights-access")).toEqual([]);
   } finally { f.close(); }
  }
 });
 it("maintainer: their projects, with a project filter that narrows every read", async () => {
  const f = mount({ role: "member", overview: { role: "member", via: ["maintainer"], projects: ["payments", "web"], perPerson: false }, answers: { "/v1/app/insights/spend": { status: 200, body: spendAnswer({ scope: "projects", totals: undefined }) } } });
  try {
   await screen.findByRole("heading", { name: "Stuck work" });
   expect(screen.getByText(/Showing the projects you maintain: payments, web\./)).toBeTruthy();
   fireEvent.change(screen.getByLabelText("Project"), { target: { value: "payments" } });
   await waitFor(() => { expect(f.request.mock.calls.some(([r]) => r.path.startsWith("/v1/app/insights/stuck") && r.path.includes("project=payments"))).toBe(true); });
   await waitFor(() => { expect(f.request.mock.calls.some(([r]) => r.path.startsWith("/v1/app/insights/spend") && r.path.includes("project=payments"))).toBe(true); });
   expect(screen.getByText("Showing one of the projects you maintain.")).toBeTruthy();
   // A maintainer has no company totals line (the answer has none): nothing is invented.
   expect(within(screen.getByRole("region", { name: "Spend vs outcomes" })).queryByText("Left of the allowance", { selector: "dt" })).toBeNull();
  } finally { f.close(); }
 });
 it("a maintainer of no project sees a plain sentence and no panels", async () => {
  const f = mount({ role: "member", overview: { role: "member", via: ["maintainer"], projects: [], perPerson: false } });
  try { await screen.findByText(/You don't maintain any projects yet/); expect(screen.queryByRole("region", { name: "Stuck work" })).toBeNull(); expect(insightsCalls(f)).toEqual(["/v1/app/insights"]); } finally { f.close(); }
 });
 it("a member with no access (403): a plain refusal, no panels, no other read", async () => {
  const f = mount({ role: "member", answers: { "/v1/app/insights": forbidden } });
  try {
   await screen.findByText(/Insights isn't open to you/);
   expect(screen.queryByRole("region", { name: "Stuck work" })).toBeNull();
   expect(insightsCalls(f)).toEqual(["/v1/app/insights"]);
  } finally { f.close(); }
 });
 it("the server's own switch off (404) says it isn't turned on", async () => {
  const f = mount({ answers: { "/v1/app/insights": { status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } } } });
  try { await screen.findByText(/Insights isn't turned on for your company yet/); } finally { f.close(); }
 });
});

describe("stuck work", () => {
 it("shows who owns it and who it waits on BY NAME on full and metadata rows, longest wait first", async () => {
  const f = mount();
  try {
   const stuckPanel = await panel("Stuck work");
   const rows = await stuckPanel.findAllByRole("listitem");
   const items = rows.filter(row => row.classList.contains("rv-ins-row"));
   expect(items).toHaveLength(2);
   // The 98-hour metadata row comes first.
   expect(items[0]!.textContent).toContain("Work you can't open");
   expect(items[0]!.textContent).toContain("Sam Lee");
   expect(items[0]!.textContent).toContain("Dana Wu");
   expect(items[0]!.textContent).toContain("4 days");
   expect(items[1]!.textContent).toContain("Retry the payment webhook");
   expect(items[1]!.textContent).toContain("Priya Shah");
   expect(items[1]!.textContent).toContain("Maya Chen (reviewer)");
   expect(items[1]!.textContent).toContain("26 hours");
   expect(items[1]!.textContent).toContain("since the last update");
   expect(items[1]!.textContent).toContain("Needs you");
   expect(items[1]!.textContent).toContain("payments");
  } finally { f.close(); }
 });
 it("a metadata row has the sentence and no link and no content; a full row links to the task", async () => {
  const f = mount();
  try {
   const stuckPanel = await panel("Stuck work");
   await stuckPanel.findByText("You can see that it exists and its state, not its content.");
   const links = stuckPanel.getAllByRole("link");
   expect(links).toHaveLength(1);
   expect(links[0]!.getAttribute("href")).toBe("/app/sessions/ses_" + "a".repeat(20));
   expect(screen.getAllByText("You can see that it exists and its state, not its content.")).toHaveLength(1);
  } finally { f.close(); }
 });
 it("a row whose visibility the screen does not know is treated as metadata (no content shown)", async () => {
  const item = { ...stuck().items[0]!, visibility: "something_new" };
  const f = mount({ answers: { "/v1/app/insights/stuck": { status: 200, body: stuck({ items: [item] }) } } });
  try {
   const stuckPanel = await panel("Stuck work");
   await stuckPanel.findByText("You can see that it exists and its state, not its content.");
   expect(stuckPanel.queryByText("Retry the payment webhook")).toBeNull();
   expect(stuckPanel.queryByRole("link")).toBeNull();
  } finally { f.close(); }
 });
 it("an unknown next actor is a normal answer; a missing owner says so; coverage is written out", async () => {
  const item = { ...stuck().items[0]!, nextActor: { kind: "unknown" }, owner: undefined };
  const f = mount({ answers: { "/v1/app/insights/stuck": { status: 200, body: stuck({ items: [item], coverage: { ...coverage, partial: true, truncated: true } }) } } });
  try {
   const stuckPanel = await panel("Stuck work");
   await stuckPanel.findByText("Not known yet", { selector: "dd" });
   expect(stuckPanel.getByText("Not shown yet")).toBeTruthy();
   expect(stuckPanel.getByText("Does not include: plan reviews, merge readiness.")).toBeTruthy();
   expect(stuckPanel.getByText(/Some sources did not answer/)).toBeTruthy();
   expect(stuckPanel.getByText(/more open work than Rovara can list/)).toBeTruthy();
  } finally { f.close(); }
 });
 it("a next actor kind the screen does not know reads as unknown, not as a failure", () => {
  const parsed = InsightsStuckReaderSchema.parse(stuck({ items: [{ ...stuck().items[0]!, nextActor: { kind: "robot" }, blocker: "newthing" }] }));
  expect(parsed.items[0]!.nextActor.kind).toBe("unknown");
  expect(parsed.items[0]!.blocker).toBe("unknown");
 });
 it("shows more with the server's cursor", async () => {
  const second = { ...stuck(), items: [{ ...stuck().items[0]!, itemId: "ses_" + "c".repeat(20), title: "Older page task", ageHours: 5 }], next: undefined };
  const f = mount({ answers: { "/v1/app/insights/stuck": r => ({ status: 200, body: r.path.includes("cursor=NEXT") ? second : stuck({ next: "NEXT" }) }) } });
  try {
   const stuckPanel = await panel("Stuck work");
   fireEvent.click(await stuckPanel.findByRole("button", { name: "Show more" }));
   await stuckPanel.findByText("Older page task");
   expect(stuckPanel.queryByRole("button", { name: "Show more" })).toBeNull();
  } finally { f.close(); }
 });
 it("a failed read shows no list and offers a retry", async () => {
  const f = mount({ answers: { "/v1/app/insights/stuck": { status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "Try later." } } } } });
  try {
   const stuckPanel = await panel("Stuck work");
   await stuckPanel.findByText(/Couldn't load stuck work/, undefined, { timeout: 5000 });
   expect(stuckPanel.queryByRole("listitem")).toBeNull();
  } finally { f.close(); }
 }, 15000);
});

describe("spend vs outcomes", () => {
 it("no person column and no person section while the answer has no byPerson (owner-only field), and nothing is inferred from a one-person project", async () => {
  const f = mount({ role: "member", overview: { role: "member", via: ["viewer_grant"], perPerson: true } });
  try {
   const spend = await panel("Spend vs outcomes");
   await spend.findByRole("table", { name: "Spending and outcomes by project" });
   expect(spend.queryByRole("table", { name: "Spending by person" })).toBeNull();
   expect(spend.queryByRole("heading", { name: "By person" })).toBeNull();
   expect(spend.queryByText("Person", { selector: "th" })).toBeNull();
   expect(spend.queryByText("Maya Chen")).toBeNull();
   // The one-person project gets its "1 person" note, not a name.
   expect(spend.getAllByText("1 person").length).toBeGreaterThan(0);
   expect(spend.getByText(/total is that one person's spend/)).toBeTruthy();
  } finally { f.close(); }
 });
 it("draws the person table when byPerson is present", async () => {
  const f = mount({ answers: { "/v1/app/insights/spend": { status: 200, body: spendAnswer({ byPerson: person }) } } });
  try {
   const spend = await panel("Spend vs outcomes");
   const table = await spend.findByRole("table", { name: "Spending by person" });
   expect(within(table).getByText("Maya Chen")).toBeTruthy();
   expect(within(table).getByText("$88.10")).toBeTruthy();
   expect(spend.queryByText(/total is that one person's spend/)).toBeNull();
  } finally { f.close(); }
 });
 it("an empty byPerson that IS present is still a table (present is the rule), and the schema keeps absent absent", () => {
  expect("byPerson" in InsightsSpendReaderSchema.parse(spendAnswer())).toBe(false);
  expect(InsightsSpendReaderSchema.parse(spendAnswer({ byPerson: [] })).byPerson).toEqual([]);
 });
 it("uses the Spending page's formula: held = committed - spent, left = limit - committed", async () => {
  const f = mount();
  try {
   const spend = await panel("Spend vs outcomes");
   const table = await spend.findByRole("table", { name: "Spending and outcomes by project" });
   const payments = within(table).getByText("payments").closest("tr")!;
   expect(payments.textContent).toContain("$7.80");   // held 218 - 210.2
   expect(payments.textContent).toContain("$82.00");  // left 300 - 218
   const totals = spend.getAllByText("Held for work in progress", { selector: "dt" })[0]!.parentElement!;
   expect(totals.textContent).toContain("$18.50");    // 431 - 412.5
  } finally { f.close(); }
 });
 it("outcomes still being collected: honest words, never a zero, not 'NaN' or 'undefined'", async () => {
  const f = mount();
  try {
   const spend = await panel("Spend vs outcomes");
   await spend.findByRole("table", { name: "Spending and outcomes by project" });
   expect(spend.getByText(/Collecting data starts Nov 16, 2026/)).toBeTruthy();
   expect(spend.getAllByText("Not recorded yet").length).toBe(2);
   expect(spend.getAllByText("Not available yet").length).toBeGreaterThan(1);
   expect(spend.getByText("Not counted yet")).toBeTruthy();
   expect(spend.queryByText(/NaN|undefined/)).toBeNull();
  } finally { f.close(); }
 });
});

describe("shipped outcomes and flow health: collecting and unavailable", () => {
 it("shipped while collecting with no weeks says 'Collecting data since' and draws nothing", async () => {
  const f = mount({ answers: { "/v1/app/insights/shipped": { status: 200, body: { status: "collecting", collectingSince: "2026-11-01T00:00:00.000Z", weeks: [] } } }, overview: { shipped: "collecting", since: "2026-11-01T00:00:00.000Z" } });
  try {
   const shipped = await panel("Shipped outcomes");
   await shipped.findByText(/Collecting data since Nov 1, 2026: 10 days so far\./);
   expect(shipped.queryByRole("list", { name: "Work shipped per week" })).toBeNull();
   expect(shipped.queryByText(/0 shipped/)).toBeNull();
  } finally { f.close(); }
 });
 it("shipped 'unavailable' in the overview: 'Not available yet' and the read is not made", async () => {
  const f = mount({ overview: { shipped: "unavailable", flow: "unavailable" } });
  try {
   const shipped = await panel("Shipped outcomes");
   expect(shipped.getByText("Not available yet.")).toBeTruthy();
   const flow = await panel("Flow health");
   expect(flow.getByText("Not available yet.")).toBeTruthy();
   await screen.findByRole("table", { name: "Spending and outcomes by project" });
   expect(calls(f, "/v1/app/insights/shipped")).toEqual([]);
   expect(calls(f, "/v1/app/insights/flow")).toEqual([]);
  } finally { f.close(); }
 });
 it("shipped weeks with linked pull requests and tickets; metadata items show no title and no links", async () => {
  const f = mount();
  try {
   const shipped = await panel("Shipped outcomes");
   await shipped.findByText("Fix refunds");
   const pr = shipped.getByRole("link", { name: /acme\/api#412/ });
   expect(pr.getAttribute("href")).toBe("https://github.com/acme/api/pull/412");
   expect(pr.getAttribute("rel")).toContain("noopener");
   expect(shipped.getByRole("link", { name: /PAY-9/ }).getAttribute("href")).toBe("https://linear.app/acme/issue/PAY-9");
   expect(shipped.getByText("Work you can't open")).toBeTruthy();
   expect(shipped.getByText(/Weeks before Nov 16, 2026 are not counted/)).toBeTruthy();
   expect(shipped.getAllByRole("link")).toHaveLength(2);
  } finally { f.close(); }
 });
 it("an unsafe PR address is shown as text, not a link", async () => {
  const body = JSON.parse(JSON.stringify(shippedAnswer)) as typeof shippedAnswer;
  body.weeks[0]!.byProject[0]!.items[0]!.prs![0]!.url = "javascript:alert(1)";
  const f = mount({ answers: { "/v1/app/insights/shipped": { status: 200, body } } });
  try {
   const shipped = await panel("Shipped outcomes");
   await shipped.findByText("acme/api#412");
   expect(shipped.queryByRole("link", { name: /acme\/api#412/ })).toBeNull();
  } finally { f.close(); }
 });
 it("flow health with too few items says 'Not enough work yet' and draws no figures", async () => {
  const f = mount({ overview: { flow: "collecting" } });
  try {
   const flow = await panel("Flow health");
   await flow.findByText(/Collecting data since Nov 1, 2026/);
   expect(flow.getAllByText("Not enough work yet").length).toBe(5);
   expect(flow.queryByText(/0 of 0|NaN/)).toBeNull();
   expect(flow.queryByRole("list", { name: /Typical wait/ })).toBeNull();
  } finally { f.close(); }
 });
 it("flow health with enough work shows cycle time, review wait, wait by next actor and rates", async () => {
  const company = { items: 38, enough: true, cycleTimeHours: { median: 31.5, p90: 80 }, reviewWaitHours: { median: 6.2, p90: 22 }, waitByNextActor: [{ kind: "person", medianHours: 5.1 }, { kind: "rovara", medianHours: 0.2 }], failureRate: { failed: 4, of: 38 }, retryRate: { retried: 6, of: 38 }, sendBackRate: { sentBack: 9, of: 38 } };
  const f = mount({ overview: { flow: "ready" }, answers: { "/v1/app/insights/flow": { status: 200, body: { ...flowAnswer, status: "ready", company, byProject: [{ project: "payments", ...company }] } } } });
  try {
   const flow = await panel("Flow health");
   expect((await flow.findAllByText("4 of 38 (11%)")).length).toBe(2);
   expect(flow.getByText("31.5 hours (slowest tenth 3.3 days)")).toBeTruthy();
   expect(flow.getByText("6.2 hours (slowest tenth 22 hours)")).toBeTruthy();
   const waits = flow.getByRole("list", { name: "Typical wait by who the work waited on" });
   expect(waits.textContent).toContain("A person");
   expect(waits.textContent).toContain("5.1 hours");
   expect(waits.textContent).toContain("12 minutes");
   expect(flow.getByRole("table", { name: "Flow health by project" })).toBeTruthy();
   fireEvent.change(flow.getByLabelText("Period"), { target: { value: "90" } });
   await waitFor(() => { expect(f.request.mock.calls.some(([r]) => r.path.startsWith("/v1/app/insights/flow") && r.path.includes("days=90"))).toBe(true); });
  } finally { f.close(); }
 });
 it("capture off is said once, in words", async () => {
  const f = mount();
  try { await screen.findByText(/not recording work history yet/); } finally { f.close(); }
 });
});

describe("the Insights viewer grant", () => {
 it("lists viewers with who gave access and when, and offers only plain members who are not viewers", async () => {
  const f = mount();
  try {
   const access = await panel("Who can see Insights");
   const list = await access.findByRole("list", { name: "Insights viewers" });
   expect(list.textContent).toContain("Maya Chen");
   expect(list.textContent).toContain("given access by Priya on Nov 10, 2026");
   const select = await access.findByLabelText<HTMLSelectElement>("Give Insights access to");
   const options = [...select.options].map(option => option.textContent);
   expect(options).toContain("Sam Lee");
   expect(options).not.toContain("Maya Chen");   // already a viewer
   expect(options).not.toContain("Priya");        // owner
   expect(options).not.toContain("Dana Wu");      // auditor
   expect(access.getByText("2 people could be given access.")).toBeTruthy();
  } finally { f.close(); }
 });
 it("grant: posts action, requestId and developerId once, then shows the answer's list", async () => {
  const f = mount({ answers: { "/v1/app/org/insights-access": r => r.method === "POST" ? { status: 200, body: { ...accessList([{ id: MAYA, name: "Maya Chen" }, { id: SAM, name: "Sam Lee" }]), requestId: "gw" } } : { status: 200, body: accessList([{ id: MAYA, name: "Maya Chen" }]) } } });
  try {
   const access = await panel("Who can see Insights");
   const select = await access.findByLabelText("Give Insights access to");
   fireEvent.change(select, { target: { value: SAM } });
   fireEvent.click(access.getByRole("button", { name: "Give access" }));
   await access.findByText("Sam Lee can now see Insights.");
   const posts = calls(f, "/v1/app/org/insights-access", "POST");
   expect(posts).toHaveLength(1);
   const body = posts[0]!.body as { action: string; requestId: string; developerId: string };
   expect(body).toEqual({ action: "grant", developerId: SAM, requestId: body.requestId });
   expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/u);
   expect(posts[0]!.retry).toBe("never");
   expect(within(access.getByRole("list", { name: "Insights viewers" })).getByText("Sam Lee")).toBeTruthy();
  } finally { f.close(); }
 });
 it("revoke asks first, then posts revoke; keeping access posts nothing", async () => {
  const f = mount({ answers: { "/v1/app/org/insights-access": r => r.method === "POST" ? { status: 200, body: accessList([]) } : { status: 200, body: accessList([{ id: MAYA, name: "Maya Chen" }]) } } });
  try {
   const access = await panel("Who can see Insights");
   fireEvent.click(await access.findByRole("button", { name: "Remove access for Maya Chen" }));
   fireEvent.click(access.getByRole("button", { name: "Keep access" }));
   expect(calls(f, "/v1/app/org/insights-access", "POST")).toEqual([]);
   fireEvent.click(access.getByRole("button", { name: "Remove access for Maya Chen" }));
   fireEvent.click(access.getByRole("button", { name: /Yes, remove access/ }));
   await access.findByText("Maya Chen can no longer see Insights.");
   const posts = calls(f, "/v1/app/org/insights-access", "POST");
   expect(posts).toHaveLength(1);
   expect(posts[0]!.body).toMatchObject({ action: "revoke", developerId: MAYA });
   expect(access.getByText("No one has been given Insights access yet.")).toBeTruthy();
  } finally { f.close(); }
 });
 it("a server refusal is shown word for word and the list is unchanged", async () => {
  const f = mount({ answers: { "/v1/app/org/insights-access": r => r.method === "POST" ? { status: 400, body: { error: { code: "CONFIG_INVALID", message: "An Auditor reads the audit log only." } } } : { status: 200, body: accessList([{ id: MAYA, name: "Maya Chen" }]) } } });
  try {
   const access = await panel("Who can see Insights");
   fireEvent.change(await access.findByLabelText("Give Insights access to"), { target: { value: SAM } });
   fireEvent.click(access.getByRole("button", { name: "Give access" }));
   const alert = await access.findByRole("alert");
   expect(alert.textContent).toBe("An Auditor reads the audit log only.");
   expect(within(access.getByRole("list", { name: "Insights viewers" })).queryByText("Sam Lee")).toBeNull();
   expect(access.queryByRole("button", { name: "Sign in again" })).toBeNull();
  } finally { f.close(); }
 });
 it("REAUTH_REQUIRED offers 'Sign in again', which starts a sign-in back to this page", async () => {
  const f = mount({ answers: { "/v1/app/org/insights-access": r => r.method === "POST" ? { status: 403, body: { error: { code: "REAUTH_REQUIRED", message: "Sign in again to change who can see Insights." } } } : { status: 200, body: accessList([]) } } });
  try {
   const access = await panel("Who can see Insights");
   fireEvent.change(await access.findByLabelText("Give Insights access to"), { target: { value: MAYA } });
   fireEvent.click(access.getByRole("button", { name: "Give access" }));
   await access.findByText("Sign in again to change who can see Insights.");
   fireEvent.click(access.getByRole("button", { name: "Sign in again" }));
   expect(f.host.signIn).toHaveBeenCalledWith("/app/live");
  } finally { f.close(); }
 });
 it("an unreadable list shows no viewers and no way to add", async () => {
  const f = mount({ answers: { "/v1/app/org/insights-access": { status: 403, body: { error: { code: "FORBIDDEN", message: "No." } } } } });
  try {
   const access = await panel("Who can see Insights");
   await access.findByText(/Couldn't load who can see Insights/);
   expect(access.queryByLabelText("Give Insights access to")).toBeNull();
  } finally { f.close(); }
 });
});

describe("words and numbers", () => {
 it("ages: hours up to two days, then days, never a bare number", () => {
  expect(ageWords(0.4)).toBe("Under an hour");expect(ageWords(1)).toBe("1 hour");expect(ageWords(26)).toBe("26 hours");expect(ageWords(48)).toBe("2 days");expect(ageWords(100)).toBe("4 days");
  expect(durationWords(0.2)).toBe("12 minutes");expect(durationWords(31.5)).toBe("31.5 hours");expect(durationWords(80)).toBe("3.3 days");
 });
 it("next actor words show names, role words, and 'Not known yet' for unknown", () => {
  expect(nextActorWords({ kind: "person", name: "Priya Shah", role: "approver" })).toBe("Priya Shah (approver)");
  expect(nextActorWords({ kind: "person" })).toBe("A person");
  expect(nextActorWords({ kind: "group", name: "Payments team" })).toBe("Payments team (a group)");
  expect(nextActorWords({ kind: "role", role: "approver" })).toBe("An approver");
  expect(nextActorWords({ kind: "role", role: "maintainer" })).toBe("A maintainer");
  expect(nextActorWords({ kind: "rovara" })).toBe("Rovara");
  expect(nextActorWords({ kind: "unknown" })).toBe("Not known yet");
 });
 it("coverage, rates, collecting lines and months", () => {
  expect(notCoveredWords({ ...coverage, notCovered: [] })).toBeUndefined();
  expect(notCoveredWords({ ...coverage, notCovered: ["change_approvals", "zzz"] })).toBe("Does not include: change approvals, other sources.");
  expect(rateWords(4, 38)).toBe("4 of 38 (11%)");expect(rateWords(0, 0)).toBe("Not enough work yet");
  const now = Date.parse(ASOF);
  expect(notReadyWords("unavailable", null, now)).toBe("Not available yet.");
  expect(notReadyWords("collecting", "2026-11-09T00:00:00.000Z", now)).toBe("Collecting data since Nov 9, 2026: 2 days so far.");
  expect(notReadyWords("collecting", "2026-11-09T00:00:00.000Z", Date.parse("2026-11-10T00:00:00.000Z"))).toBe("Collecting data since Nov 9, 2026: 1 day so far.");
  expect(notReadyWords("collecting", "2026-11-16T00:00:00.000Z", now)).toBe("Collecting data starts Nov 16, 2026. Numbers appear after that.");
  expect(notReadyWords("collecting", null, now)).toContain("Collecting data.");
  expect(recentMonths(now, 3)).toEqual(["2026-11", "2026-10", "2026-09"]);
  expect(recentMonths(Date.parse("2026-01-15T00:00:00Z"), 2)).toEqual(["2026-01", "2025-12"]);
  expect(barPercent(0, 10)).toBe(0);expect(barPercent(1, 1000)).toBe(2);expect(barPercent(5, 10)).toBe(50);
 });
 it("the overview reader accepts a value a newer server adds as 'unknown'", () => {
  const parsed = InsightsOverviewReaderSchema.parse({ ...overview(), viewer: { ...overview().viewer, scope: { kind: "galaxy" }, via: ["owner", "wizard"] } });
  expect(parsed.viewer.scope.kind).toBe("unknown");
  expect(parsed.viewer.via).toEqual(["owner", "unknown"]);
 });
 it("an unknown scope shows nothing", async () => {
  const f = mount({ answers: { "/v1/app/insights": { status: 200, body: { ...overview(), viewer: { ...overview().viewer, scope: { kind: "galaxy" } } } } } });
  try { await screen.findByText(/couldn't tell which work you can see/); expect(insightsCalls(f)).toEqual(["/v1/app/insights"]); } finally { f.close(); }
 });
});

describe("accessibility", () => {
  for (const theme of ["light", "dark"] as const) {
   it(`the whole page has no axe violations (${theme})`, async () => {
    const f = mount({ theme, answers: { "/v1/app/insights/spend": { status: 200, body: spendAnswer({ byPerson: person }) } } });
    try {
     await screen.findByRole("table", { name: "Spending by person" });
     await screen.findByText("Fix refunds");
     await expectNoAxeViolations(document.body);
    } finally { f.close(); }
   }, 20000);
  }
});
void vi;
