// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- the tests read Cloud's JSON answers and break a plain JSON body at a path */
// The Cost and time pages (Feature A, slice A3): the readers, the words for the numbers, the CSV, and the two screens (by feature and by project, a feature's page) with their
// empty, not-connected, refused and failed states. Money is whole cents; nothing about a person is drawn; a missing number is never drawn as zero.
import { describe, expect, it } from "vitest";
import { cleanup, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import {
  costWords, csvCell, csvOf, dollars, durationWords, featureCsv, filterQuery, monthStart, pullRequestWords, rangeBounds, readCostReport, readFeatureDetail, reportCsv, soFarWords, unpricedWords,
  type CostReport, type FeatureDetail, type ReportGroup, type ReportNumbers,
} from "../../packages/ui/src/api/admin-report.js";
import { sortGroups } from "../../packages/ui/src/screens/admin/report/CostReportScreen.js";
import { visibleAdminGroups } from "../../packages/ui/src/screens/admin/admin-nav.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";

const me = "a".repeat(64);
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
const DAY = 86_400_000;
const ok = (body: unknown): ApiResponse => ({ status: 200, body });
const fail = (status: number, code: string, message = "fixed words"): ApiResponse => ({ status, body: { error: { code, message } } });

const nums = (over: Partial<ReportNumbers> = {}): ReportNumbers => ({ tasks: 3, prsOpened: 3, prsMerged: 2, costCents: 21_234, unpricedCalls: 0, costIsFloor: false, costPerMergedCents: 10_617, endToEndMs: 5 * DAY, endToEndSoFar: false, medianRequestToPrMs: 2 * DAY, ...over });
const group = (key: string, name: string, over: Partial<ReportGroup> = {}): ReportGroup => ({ key, name, ...nums(), state: "open", ...over });
const report = (over: Partial<CostReport> = {}): CostReport => ({
  range: { from: "2026-11-01T00:00:00.000Z" }, asOf: "2026-11-17T12:00:00.000Z", totals: nums({ tasks: 7, prsOpened: 7, prsMerged: 6, costCents: 24_000, costPerMergedCents: 4_000 }), projects: ["api", "web"],
  byFeature: [group("f1", "Checkout v2", { costCents: 21_234, unpricedCalls: 3, costIsFloor: true }), group("f2", "Search", { costCents: 2_000, state: "done", endToEndSoFar: true }), group("none", "No feature", { costCents: 766, tasks: 1, prsOpened: 0, prsMerged: 0, costPerMergedCents: undefined as unknown as number })],
  byProject: [group("web", "web", { costCents: 20_000 }), group("api", "api", { costCents: 4_000 })], canChange: false, features: [], ...over,
});
// Strip the undefined the helper put in for "no value" so the body is what Cloud sends.
const clean = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const detail = (over: Partial<FeatureDetail> = {}): FeatureDetail => ({
  feature: { id: "f1", name: "Checkout v2", state: "open", trackerLink: { tracker: "linear", id: "CHK", url: "https://linear.app/acme/project/chk" }, none: false },
  range: {}, asOf: "2026-11-17T12:00:00.000Z", totals: nums(), sources: [{ source: "tracker", count: 2 }, { source: "confirmed_at_plan", count: 1 }], tasksTotal: 2,
  tasks: [
    { taskId: "t1", title: "Pay with card", project: "web", origin: "linear", path: "full", state: "merged", startedAt: "2026-11-10T00:00:00.000Z", costCents: 12_000, unpricedCalls: 0, prsOpened: 1, prsMerged: 1, prLinks: ["https://github.com/acme/web/pull/7"], wallMs: 2 * DAY },
    { taskId: "t2", title: "Pay with wallet", project: "web", origin: "slack", path: "quick", state: "open", startedAt: "2026-11-15T00:00:00.000Z", costCents: 500, unpricedCalls: 2, prsOpened: 0, prsMerged: 0, prLinks: [], wallMs: DAY, wallSoFar: true },
  ], canChange: false, features: [], ...over,
});

function mount(path: string, respond: (r: ApiRequest) => ApiResponse | Promise<ApiResponse>, options: { role?: "owner" | "admin" | "member" } = {}) {
  const role = options.role ?? "owner";
  const nav = AppNavSchema.parse({ me: { developerId: me, name: "Priya", orgRole: role }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
  const identity = AppMeResponseSchema.parse({ developer: { id: me, name: "Priya", orgRole: role }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
  const f = fakeHost(async r => (r.path === "/v1/app/nav" ? { status: 200, body: nav } : r.path === "/v1/app/me" ? { status: 200, body: identity } : respond(r)));
  const query = createQueryClient(); query.setQueryData(["nav"], nav); f.storage.set("rovara.theme", "light");
  const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: [path] });
  const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
  return { ...f, ...view, router, query, close: () => { view.unmount(); router.dispose(); query.clear(); cleanup(); } };
}
const reads = (f: ReturnType<typeof mount>) => f.request.mock.calls.map(([r]) => r).filter(r => r.path.startsWith("/v1/app/org/report"));
const server = (body: unknown) => (r: ApiRequest): ApiResponse => (r.path.startsWith("/v1/app/org/report") ? ok(body) : ok({}));

describe("the readers", () => {
  it("read what Cloud sends, whole cents and all", () => {
    const read = readCostReport.parse(clean(report()));
    expect(read.totals.costCents).toBe(24_000);
    expect(read.byFeature.at(-1)).toMatchObject({ key: "none", name: "No feature" });
    expect(read.byFeature[0]).toMatchObject({ unpricedCalls: 3, costIsFloor: true });
    expect(readFeatureDetail.parse(clean(detail())).tasks[0]!.prLinks).toEqual(["https://github.com/acme/web/pull/7"]);
  });
  it("refuse the whole answer for a field that is not the shape (money as a float, a negative, an unknown word)", () => {
    for (const bad of [
      (r: any) => { r.totals.costCents = 12.5; }, (r: any) => { r.totals.costCents = -1; }, (r: any) => { r.totals.costCents = "12"; }, (r: any) => { r.byFeature[0].tasks = 1.5; }, (r: any) => { delete r.totals.costIsFloor; },
      (r: any) => { r.byProject = "none"; }, (r: any) => { r.asOf = "soon"; }, (r: any) => { delete r.byFeature[1].key; },
    ]) {
      const r = clean(report()); bad(r);
      expect(() => readCostReport.parse(r)).toThrow();
    }
    for (const bad of [(d: any) => { d.tasks[0].origin = "pigeon"; }, (d: any) => { d.tasks[0].costCents = 1.5; }, (d: any) => { d.sources[0].source = "magic"; }, (d: any) => { delete d.feature.none; }]) {
      const d = clean(detail()); bad(d);
      expect(() => readFeatureDetail.parse(d)).toThrow();
    }
    expect(() => readCostReport.parse("nope")).toThrow();
    // Code's rows may have no path, and a task may start from "other".
    const d = clean(detail()) as any;
    delete d.tasks[0].path; d.tasks[1].origin = "other";
    expect(readFeatureDetail.parse(d).tasks.map(t => [t.origin, t.path])).toEqual([["linear", undefined], ["other", "quick"]]);
  });
  it("drops a link that is not plain https, and draws no person field even when one is sent", () => {
    const d = clean(detail()) as any;
    d.tasks[0].prLinks = ["http://x.example/a", "javascript:alert(1)", "https://u:p" + String.fromCharCode(64) + "x.example/a", "https://github.com/a/b/pull/1"];
    d.tasks[0].requesterId = "c".repeat(64);
    const read = readFeatureDetail.parse(d);
    expect(read.tasks[0]!.prLinks).toEqual(["https://github.com/a/b/pull/1"]);
    expect(JSON.stringify(read)).not.toContain("requester");
  });
});

describe("the words for the numbers", () => {
  it("shows dollars from whole cents, a floor with 'or more', and unpriced calls", () => {
    expect(dollars(0)).toBe("$0.00"); expect(dollars(5)).toBe("$0.05"); expect(dollars(21_234)).toBe("$212.34"); expect(dollars(123_456_789)).toBe("$1,234,567.89");
    expect(costWords(1_200, true)).toBe("$12.00 or more"); expect(costWords(1_200, false)).toBe("$12.00");
    expect(unpricedWords(1)).toBe("1 call not priced"); expect(unpricedWords(3)).toBe("3 calls not priced");
  });
  it("words a length of time, and 'so far' for open work", () => {
    expect(durationWords(5 * DAY)).toBe("5 days"); expect(durationWords(DAY)).toBe("1 day"); expect(durationWords(1.5 * DAY)).toBe("1.5 days"); expect(durationWords(3 * 3_600_000)).toBe("3 hours");
    expect(durationWords(40 * 60_000)).toBe("40 minutes"); expect(durationWords(5_000)).toBe("under a minute"); expect(durationWords(12.4 * DAY)).toBe("12 days");
    expect(soFarWords(2 * DAY, true)).toBe("2 days so far"); expect(soFarWords(2 * DAY, false)).toBe("2 days");
    expect(pullRequestWords(6, 7)).toBe("6 merged of 7"); expect(pullRequestWords(0, 0)).toBe("None");
  });
  it("works the default range and the filter query", () => {
    const now = new Date(Date.UTC(2026, 10, 17, 12));
    expect(monthStart(now)).toBe("2026-11-01T00:00:00.000Z");
    expect(rangeBounds("this-month", now)).toEqual({ from: "2026-11-01T00:00:00.000Z" });
    expect(rangeBounds("last-month", now)).toEqual({ from: "2026-10-01T00:00:00.000Z", to: "2026-10-31T23:59:59.999Z" });
    expect(rangeBounds("all", now)).toEqual({});
    expect(filterQuery({})).toBe("");
    expect(filterQuery({ project: "web", from: "2026-11-01T00:00:00.000Z", state: "open" })).toBe("?from=2026-11-01T00%3A00%3A00.000Z&project=web&state=open");
  });
});

describe("the CSV export", () => {
  it("puts an apostrophe before a cell a spreadsheet would run, and quotes what needs it", () => {
    for (const cell of ["=1+1", "+SUM(A1)", "-2+3", "@HYPERLINK(\"x\")", "\tcmd", "\rx"]) expect(csvCell(cell).replace(/^"/u, "").startsWith("'"), cell).toBe(true);
    expect(csvCell("plain")).toBe("plain"); expect(csvCell('a,"b"')).toBe('"a,""b"""'); expect(csvCell(12)).toBe("12"); expect(csvCell(undefined)).toBe("");
    // A negative-looking number written by us as a cell is escaped too: nothing we export starts with a sign.
    expect(csvOf(["a"], [["=cmd|' /C calc'!A0"]])).toBe("a\r\n'=cmd|' /C calc'!A0\r\n");
  });
  it("exports what the table shows, in plain numbers, with a hostile feature name made safe", () => {
    const csv = reportCsv([group("f1", "=HYPERLINK(\"http://evil\")", { costCents: 21_234, unpricedCalls: 3, costIsFloor: true }), group("none", "No feature", { state: undefined as unknown as "open" })], "feature");
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe("Feature,Tasks,Pull requests opened,Pull requests merged,Cost (USD),Cost is a floor,Calls not priced,End to end (days),Still open,State");
    expect(lines[1]!.startsWith("\"'=HYPERLINK(")).toBe(true);
    expect(lines[1]).toContain(",212.34,yes,3,5.0,no,Open");
    expect(csv).not.toMatch(/person|requester|waiting|send/iu);
    expect(reportCsv([group("web", "web")], "project").split("\r\n")[0]).toBe("Project,Tasks,Pull requests opened,Pull requests merged,Cost (USD),Cost is a floor,Calls not priced,End to end (days),Still open");
    const tasks = featureCsv(clean(detail()).tasks);
    expect(tasks.split("\r\n")[1]).toBe("Pay with card,web,Linear,Merged,https://github.com/acme/web/pull/7,120.00,no,0,2.0,no");
  });
});

describe("the order of the table", () => {
  const rows = [group("a", "Alpha", { costCents: 100, tasks: 9, endToEndMs: 1 }), group("b", "Beta", { costCents: 900, tasks: 1, endToEndMs: 9 }), group("none", "No feature", { costCents: 99_999, tasks: 50, endToEndMs: 99 }), group("c", "Gamma", { costCents: 900, tasks: 2, endToEndMs: undefined as unknown as number })];
  it("sorts by cost, tasks, end to end or name, and keeps No feature last", () => {
    expect(sortGroups(rows, "cost").map(g => g.name)).toEqual(["Beta", "Gamma", "Alpha", "No feature"]);
    expect(sortGroups(rows, "tasks").map(g => g.name)).toEqual(["Alpha", "Gamma", "Beta", "No feature"]);
    expect(sortGroups(rows, "end").map(g => g.name)).toEqual(["Beta", "Alpha", "Gamma", "No feature"]);
    expect(sortGroups(rows, "name").map(g => g.name)).toEqual(["Alpha", "Beta", "Gamma", "No feature"]);
  });
});

describe("the navigation", () => {
  it("shows Cost and time under Money to an owner and an admin, and not to a member", () => {
    for (const role of ["owner", "admin"] as const) {
      const money = visibleAdminGroups(role, false).find(g => g.id === "money")!;
      expect(money.links.map(l => l.label)).toEqual(["Spending", "Spending limits", "Cost and time"]);
      expect(money.links[2]!.to).toBe("/app/admin/money/report");
    }
    expect(visibleAdminGroups("member", false).flatMap(g => g.links.map(l => l.label))).not.toContain("Cost and time");
  });
});

describe("Cost and time", () => {
  it("draws four numbers, the table by feature with No feature last, and no wait or send-back column", async () => {
    const f = mount("/app/admin/money/report", server(clean(report())));
    try {
      expect(await screen.findByRole("heading", { level: 1, name: "Cost and time" })).toBeTruthy();
      const stats = await screen.findByRole("group", { name: "Cost and time in this range" });
      expect(within(stats).getByText("Spent").nextElementSibling!.textContent).toBe("$240.00");
      expect(within(stats).getByText("6")).toBeTruthy();
      expect(within(stats).getByText("$40.00")).toBeTruthy();
      expect(within(stats).getByText("2 days")).toBeTruthy();
      const table = await screen.findByRole("table", { name: "Cost and time by feature" });
      const names = within(table).getAllByRole("row").slice(1).map(row => within(row).getAllByRole("cell")[0]!.textContent);
      expect(names).toEqual(["Checkout v2", "Search", "No feature"]);
      expect(within(table).getAllByRole("columnheader").map(c => c.textContent)).toEqual(["Feature", "Tasks", "Pull requests", "Cost", "End to end", "State"]);
      // A floor is marked and the calls are counted; open work is "so far"; a feature with no state says so; a number that does not exist is not zero.
      expect(within(table).getByText("$212.34 or more")).toBeTruthy();
      expect(within(table).getByText("3 calls not priced")).toBeTruthy();
      expect(within(table).getAllByText("so far")).toHaveLength(1);
      expect(within(table).getByText("Done")).toBeTruthy();
      expect(within(table).getByText("None")).toBeTruthy();
      expect(within(table).queryByText(/^0 merged/u)).toBeNull();
      expect(document.body.textContent).not.toMatch(/Waiting on people|Send-backs|coming soon|ranking/iu);
      expect(within(table).getByRole("link", { name: "Checkout v2" }).getAttribute("href")).toBe("/app/admin/money/report/features/f1");
      expect(within(table).getByRole("link", { name: "No feature" }).getAttribute("href")).toBe("/app/admin/money/report/features/none");
      expect(reads(f)[0]!.path).toBe("/v1/app/org/report?from=" + encodeURIComponent(monthStart(new Date())));
    } finally { f.close(); }
  });
  it("switches to By project (no State column) and sorts", async () => {
    const f = mount("/app/admin/money/report", server(clean(report())));
    try {
      fireEvent.click(await screen.findByRole("tab", { name: "By project" }));
      const table = await screen.findByRole("table", { name: "Cost and time by project" });
      expect(within(table).getAllByRole("columnheader").map(c => c.textContent)).toEqual(["Project", "Tasks", "Pull requests", "Cost", "End to end"]);
      expect(within(table).getAllByRole("row").slice(1).map(row => within(row).getAllByRole("cell")[0]!.textContent)).toEqual(["web", "api"]);
      fireEvent.change(screen.getByLabelText("Sort by"), { target: { value: "name" } });
      expect(within(await screen.findByRole("table", { name: "Cost and time by project" })).getAllByRole("row").slice(1).map(row => within(row).getAllByRole("cell")[0]!.textContent)).toEqual(["api", "web"]);
    } finally { f.close(); }
  });
  it("shows 25 rows a page and pages through many features", async () => {
    const many = Array.from({ length: 60 }, (_, n) => group(`f${n}`, `Feature ${String(n).padStart(2, "0")}`, { costCents: 100_000 - n }));
    const f = mount("/app/admin/money/report", server(clean(report({ byFeature: many }))));
    try {
      const table = await screen.findByRole("table", { name: "Cost and time by feature" });
      expect(within(table).getAllByRole("row")).toHaveLength(26);
      expect(screen.getByRole("status", { name: "" }).textContent).toContain("Showing 1 to 25 of 60");
      fireEvent.click(screen.getByRole("button", { name: "Next page" }));
      expect((await screen.findByText(/Showing 26 to 50 of 60/u))).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Next page" }));
      expect((await screen.findByText(/Showing 51 to 60 of 60/u))).toBeTruthy();
      expect(screen.getByRole("button", { name: "Next page" })).toHaveProperty("disabled", true);
    } finally { f.close(); }
  });
  it("sends the filters it was given in the address, and a changed filter asks again", async () => {
    const f = mount("/app/admin/money/report?range=all&project=web&origin=slack&state=closed&path=quick", server(clean(report())));
    try {
      await screen.findByRole("table", { name: "Cost and time by feature" });
      expect(reads(f)[0]!.path).toBe("/v1/app/org/report?project=web&origin=slack&state=closed&path=quick");
      fireEvent.change(screen.getByLabelText("Where it started"), { target: { value: "linear" } });
      await waitFor(() => expect(reads(f).at(-1)!.path).toContain("origin=linear"));
      fireEvent.change(screen.getByLabelText("Date range"), { target: { value: "last-month" } });
      await waitFor(() => expect(reads(f).at(-1)!.path).toContain("to="));
      // A word the page does not offer in the address is ignored, not sent.
    } finally { f.close(); }
    const g = mount("/app/admin/money/report?origin=carrier&company=org_other&person=x", server(clean(report())));
    try {
      await screen.findByRole("table", { name: "Cost and time by feature" });
      expect(reads(g)[0]!.path).not.toMatch(/carrier|company|person|org_other/u);
    } finally { g.close(); }
  });
  it("keeps every project it has seen in the project menu after one is chosen, and the feature page has no project menu", async () => {
    const f = mount("/app/admin/money/report", r => (r.path.startsWith("/v1/app/org/report") ? ok(clean(r.path.includes("project=web") ? report({ projects: ["web"] }) : report())) : ok({})));
    try {
      await screen.findByRole("table", { name: "Cost and time by feature" });
      fireEvent.change(screen.getByLabelText("Project"), { target: { value: "web" } });
      await waitFor(() => expect(reads(f).at(-1)!.path).toContain("project=web"));
      await screen.findByRole("table", { name: "Cost and time by feature" });
      expect(within(screen.getByLabelText("Project")).getAllByRole("option").map(o => o.textContent)).toEqual(["Choose", "All projects", "api", "web"]);
    } finally { f.close(); }
    const g = mount("/app/admin/money/report/features/f1", server(clean(detail())));
    try {
      await screen.findByRole("table", { name: "Tasks in this feature" });
      expect(screen.queryByLabelText("Project")).toBeNull();
    } finally { g.close(); }
  });
  it("says so when nothing started in the range, and does not draw an empty table", async () => {
    const empty = report({ totals: nums({ tasks: 0, prsOpened: 0, prsMerged: 0, costCents: 0, costPerMergedCents: undefined as unknown as number, endToEndMs: undefined as unknown as number, medianRequestToPrMs: undefined as unknown as number }), byFeature: [], byProject: [], projects: [] });
    const f = mount("/app/admin/money/report", server(clean(empty)));
    try {
      expect(await screen.findByTestId("report-empty")).toBeTruthy();
      expect(screen.queryByRole("table")).toBeNull();
      expect(screen.getByText("No merges yet")).toBeTruthy();
      expect(screen.getByText("None yet")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Download CSV" })).toHaveProperty("disabled", true);
    } finally { f.close(); }
  });
  it("downloads the table on screen as a CSV", async () => {
    const f = mount("/app/admin/money/report", server(clean(report())));
    try {
      await screen.findByRole("table", { name: "Cost and time by feature" });
      fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
      // eslint-disable-next-line @typescript-eslint/unbound-method -- a vi.fn on the fake host
      const saved = f.host.saveFile as unknown as { mock: { calls: unknown[] } };
      expect(saved.mock.calls).toHaveLength(1);
      const [name, blob] = (f.host.saveFile as unknown as { mock: { calls: Array<[string, Blob]> } }).mock.calls[0]!;
      expect(name).toBe("cost-and-time-by-feature.csv");
      expect(await blob.text()).toBe(reportCsv(sortGroups(clean(report()).byFeature, "cost"), "feature"));
    } finally { f.close(); }
  });
  it("says 'not connected yet' when Cloud has no report, and draws no number", async () => {
    const f = mount("/app/admin/money/report", r => (r.path.startsWith("/v1/app/org/report") ? fail(501, "NOT_ON_CODE_YET") : ok({})));
    try {
      expect(await screen.findByTestId("not-connected")).toBeTruthy();
      expect(screen.queryByRole("group", { name: "Cost and time in this range" })).toBeNull();
    } finally { f.close(); }
  });
  it("says when the range is too large and keeps the filters so it can be shortened", async () => {
    const f = mount("/app/admin/money/report?range=all", r => (r.path.startsWith("/v1/app/org/report") ? fail(422, "RANGE_TOO_LARGE") : ok({})));
    try {
      expect((await screen.findByTestId("report-error")).textContent).toContain("too many tasks");
      expect(screen.getByLabelText("Date range")).toBeTruthy();
    } finally { f.close(); }
  });
  it("shows a refusal and a failure without any amount, and the failure can be tried again", async () => {
    let calls = 0;
    const f = mount("/app/admin/money/report", r => { if (!r.path.startsWith("/v1/app/org/report")) return ok({}); calls += 1; return calls === 1 ? fail(400, "CONFIG_INVALID") : ok(clean(report())); });
    try {
      expect((await screen.findByTestId("report-error")).textContent).toContain("Couldn't load the cost report");
      expect(document.body.textContent).not.toContain("$");
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(await screen.findByRole("table", { name: "Cost and time by feature" })).toBeTruthy();
    } finally { f.close(); }
    const g = mount("/app/admin/money/report", r => (r.path.startsWith("/v1/app/org/report") ? fail(403, "FORBIDDEN") : ok({})));
    try {
      expect((await screen.findByTestId("report-error")).textContent).toContain("You don't have permission");
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    } finally { g.close(); }
  });
  it("shows a body it cannot read as an error, never as a half drawn table", async () => {
    const bad = clean(report()) as any; bad.totals.costCents = 1.5;
    const f = mount("/app/admin/money/report", server(bad));
    try {
      expect((await screen.findByTestId("report-error")).textContent).toContain("Couldn't load the cost report");
      expect(screen.queryByRole("table")).toBeNull();
    } finally { f.close(); }
  });
  it("says how many tasks could not be read, and says nothing when none", async () => {
    const f = mount("/app/admin/money/report", server(clean({ ...report(), unreadableTasks: 3 })));
    try {
      expect((await screen.findByTestId("report-unreadable")).textContent).toBe("3 tasks couldn't be read and are left out of these numbers.");
    } finally { f.close(); }
    const g = mount("/app/admin/money/report", server(clean(report())));
    try {
      await screen.findByRole("table", { name: "Cost and time by feature" });
      expect(screen.queryByTestId("report-unreadable")).toBeNull();
    } finally { g.close(); }
    const h2 = mount("/app/admin/money/report/features/f1", server(clean({ ...detail(), unreadableTasks: 1 })));
    try {
      expect((await screen.findByTestId("report-unreadable")).textContent).toBe("1 task couldn't be read and is left out of these numbers.");
    } finally { h2.close(); }
  });
  it("is not drawn for a member, and asks nothing", async () => {
    const f = mount("/app/admin/money/report", server(clean(report())), { role: "member" });
    try {
      await waitFor(() => expect(document.body.textContent).toMatch(/Only company owners and admins|Waiting for people|permission/iu));
      expect(reads(f)).toHaveLength(0);
    } finally { f.close(); }
  });
  it("has no accessibility violations", async () => {
    const f = mount("/app/admin/money/report", server(clean(report())));
    try {
      await screen.findByRole("table", { name: "Cost and time by feature" });
      await expectNoAxeViolations(f.container);
    } finally { f.close(); }
  });
});

describe("a feature's page", () => {
  it("shows the name, how tasks got here, a tracker link, the four numbers and the tasks", async () => {
    const f = mount("/app/admin/money/report/features/f1?range=all&origin=linear", server(clean(detail())));
    try {
      expect(await screen.findByRole("heading", { level: 1, name: "Checkout v2" })).toBeTruthy();
      expect(screen.getByText("How tasks got here: 2 from the tracker, 1 confirmed at plan.")).toBeTruthy();
      const tracker = screen.getByRole("link", { name: /Open in linear \(CHK\)/u });
      expect(tracker.getAttribute("href")).toBe("https://linear.app/acme/project/chk");
      expect(tracker.getAttribute("rel")).toContain("noopener");
      expect(screen.getByRole("group", { name: "This feature's numbers" })).toBeTruthy();
      const table = screen.getByRole("table", { name: "Tasks in this feature" });
      expect(within(table).getAllByRole("columnheader").map(c => c.textContent)).toEqual(["Task", "Started from", "State", "Pull request", "Cost", "End to end"]);
      expect(within(table).getByRole("link", { name: "1 merged of 1" }).getAttribute("href")).toBe("https://github.com/acme/web/pull/7");
      expect(within(table).getByText("$5.00 or more")).toBeTruthy();
      expect(within(table).getByText("so far")).toBeTruthy();
      expect(document.body.textContent).not.toMatch(/Requested by|requester|Rename|Merge into|Mark done|Move/u);
      expect(reads(f)[0]!.path).toBe("/v1/app/org/report/features/f1?origin=linear");
      expect(screen.getByRole("link", { name: "Back to Cost and time" }).getAttribute("href")).toBe("/app/admin/money/report?range=all&origin=linear");
    } finally { f.close(); }
  });
  it("shows the tasks with no feature under the id none, and says when the list is cut", async () => {
    const none = detail({ feature: { id: "none", name: "No feature", none: true }, tasksTotal: 900 });
    const f = mount("/app/admin/money/report/features/none", server(clean(none)));
    try {
      expect(await screen.findByRole("heading", { level: 1, name: "No feature" })).toBeTruthy();
      expect(screen.getByText("Tasks that no feature was set for.")).toBeTruthy();
      expect(screen.getByText(/Showing the newest 2 of 900 tasks/u)).toBeTruthy();
      expect(reads(f)[0]!.path.startsWith("/v1/app/org/report/features/none")).toBe(true);
    } finally { f.close(); }
  });
  it("says a feature is not found with the one fixed sentence", async () => {
    const f = mount("/app/admin/money/report/features/zzz", r => (r.path.startsWith("/v1/app/org/report") ? fail(404, "NOT_FOUND") : ok({})));
    try {
      expect(await screen.findByRole("heading", { level: 1, name: "Feature not found" })).toBeTruthy();
      expect(screen.getByText("That feature doesn't exist, or you can't see it.")).toBeTruthy();
    } finally { f.close(); }
  });
  it("downloads the tasks as a CSV", async () => {
    const f = mount("/app/admin/money/report/features/f1", server(clean(detail())));
    try {
      await screen.findByRole("table", { name: "Tasks in this feature" });
      fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
      const [name, blob] = (f.host.saveFile as unknown as { mock: { calls: Array<[string, Blob]> } }).mock.calls[0]!;
      expect(name).toBe("feature-tasks.csv");
      expect(await blob.text()).toBe(featureCsv(clean(detail()).tasks));
    } finally { f.close(); }
  });
  it("has no accessibility violations", async () => {
    const f = mount("/app/admin/money/report/features/f1", server(clean(detail())));
    try {
      await screen.findByRole("table", { name: "Tasks in this feature" });
      await expectNoAxeViolations(f.container);
    } finally { f.close(); }
  });
});
