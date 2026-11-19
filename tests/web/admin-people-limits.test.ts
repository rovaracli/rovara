// @vitest-environment jsdom
// Cost report slice A6 (decision D2): the People and limits admin page. One table of five columns in the server's name order, whole cents, spend against the limit that
// applies, a link to B1's Spending limits page, a project filter; owners and admins only; no sorting, no merged or quality number, no total, no chart.
import { beforeEach, describe, expect, it } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { changeLimitPath, peopleLimitsPath, readPeopleLimits, standing } from "../../packages/ui/src/api/admin-people-limits.js";
import { visibleAdminGroups } from "../../packages/ui/src/screens/admin/admin-nav.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { h } from "./support/h.js";

const me = "a".repeat(64);
const AL = "1".repeat(64), BO = "2".repeat(64), CY = "3".repeat(64), DI = "4".repeat(64);
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
const seeded = new Map<string, string>();
beforeEach(() => { seeded.clear(); });
function mount(path: string, respond: (r: ApiRequest) => ApiResponse | Promise<ApiResponse>, role: "owner" | "admin" | "member" = "owner") {
 const nav = AppNavSchema.parse({ me: { developerId: me, name: "Priya", orgRole: role }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
 const identity = AppMeResponseSchema.parse({ developer: { id: me, name: "Priya", orgRole: role }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
 const f = fakeHost(async r => (r.path === "/v1/app/nav" ? { status: 200, body: nav } : r.path === "/v1/app/me" ? { status: 200, body: identity } : respond(r)));
 const query = createQueryClient(); query.setQueryData(["nav"], nav); f.storage.set("rovara.theme", "light");
 for (const [key, value] of seeded) f.storage.set(key, value);
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: [path] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 return { ...f, ...view, router, close: () => { view.unmount(); router.dispose(); query.clear(); } };
}
const rows = [
 { developerId: AL, name: "Al", spentCents: 1234, limitCents: 5000, limitSource: "own" },
 { developerId: BO, name: "Bo", spentCents: 4600, limitCents: 5000, limitSource: "company_default" },
 { developerId: CY, name: "Cy", spentCents: 5100, limitCents: 5000, limitSource: "company_default" },
 { developerId: DI, name: "Di", spentCents: 999, limitCents: null, limitSource: "none" },
];
const body = (over: Record<string, unknown> = {}) => ({ month: "2026-11", projects: ["api", "web"], people: rows, ...over });
const ok = (b: unknown): ApiResponse => ({ status: 200, body: b });
const PATH = "/app/admin/money/people";

describe("People and limits: the reader and the words", () => {
 it("reads only the shape it expects", () => {
  expect(readPeopleLimits(body()).people.map(row => row.name)).toEqual(["Al", "Bo", "Cy", "Di"]);
  expect(readPeopleLimits(body({ project: "web" })).project).toBe("web");
  const bad = [null, [], body({ month: "2026-13" }), body({ month: "Nov" }), body({ projects: "no" }), body({ projects: ["Web"] }), body({ project: "Web" }), body({ people: "no" }),
   body({ people: [{ ...rows[0]!, developerId: "abc" }] }), body({ people: [{ ...rows[0]!, name: "" }] }), body({ people: [{ ...rows[0]!, spentCents: -1 }] }), body({ people: [{ ...rows[0]!, spentCents: 1.5 }] }),
   body({ people: [{ ...rows[0]!, limitCents: "5" }] }), body({ people: [{ ...rows[0]!, limitSource: "team" }] }), body({ people: [{ ...rows[0]!, limitCents: null }] }), body({ people: [{ ...rows[3]!, limitCents: 100 }] })];
  for (const one of bad) expect(() => readPeopleLimits(one), JSON.stringify(one)).toThrow();
 });
 it("keeps nothing but the five fields, even when the server sends more (no merged count, rank or score reaches the page)", () => {
  const read = readPeopleLimits(body({ people: [{ ...rows[0]!, mergedCount: 9, tasks: 4, rank: 1, score: 99, email: ["a", "b.test"].join("@") }] }));
  expect(Object.keys(read.people[0]!).sort()).toEqual(["developerId", "limitCents", "limitSource", "name", "spentCents"]);
 });
 it("says where a person stands in words, from whole cents", () => {
  expect([[0, null], [100, 5000], [4499, 5000], [4500, 5000], [5000, 5000], [5001, 5000], [0, 0], [1, 0]].map(([spent, limit]) => standing({ spentCents: spent!, limitCents: limit! }))).toEqual(["none", "within", "within", "close", "close", "over", "close", "over"]);
 });
 it("builds the filter path only from a project name, and the change link from a person id", () => {
  expect(peopleLimitsPath(undefined)).toBe("/v1/app/org/people-limits");
  expect(peopleLimitsPath("web")).toBe("/v1/app/org/people-limits?project=web");
  expect(peopleLimitsPath("../x")).toBe("/v1/app/org/people-limits");
  expect(changeLimitPath(AL)).toBe(`/app/admin/money/limits?person=${AL}`);
 });
 it("is a link in Money for owners and admins, and never for a member", () => {
  for (const role of ["owner", "admin"] as const) expect(visibleAdminGroups(role, false).find(group => group.id === "money")!.links.map(link => link.label)).toContain("People and limits");
  expect(visibleAdminGroups("member", false).flatMap(group => group.links.map(link => link.label))).not.toContain("People and limits");
 });
});

describe("People and limits: the page", () => {
 it("draws one five-column table in the order sent, with spend, limit and where each limit came from, and no total or sort control", async () => {
  const f = mount(PATH, () => ok(body()));
  try {
   const table = await screen.findByRole("table", { name: "People and limits" });
   expect(within(table).getAllByRole("columnheader").map(cell => cell.textContent)).toEqual(["Person", "Spent this month (all projects)", "Monthly limit", "Standing", "Change"]);
   const lines = within(table).getAllByRole("row").slice(1);
   expect(lines.map(line => within(line).getAllByRole("cell")[0]!.textContent)).toEqual(["Al", "Bo", "Cy", "Di"]);
   expect(lines[0]!.textContent).toContain("$12.34"); expect(lines[0]!.textContent).toContain("$50.00"); expect(lines[0]!.textContent).toContain("set for this person"); expect(lines[0]!.textContent).toContain("Within the limit");
   expect(lines[1]!.textContent).toContain("company default"); expect(lines[1]!.textContent).toContain("Close to the limit");
   expect(lines[2]!.textContent).toContain("Over the limit");
   expect(lines[3]!.textContent).toContain("No limit set"); expect(lines[3]!.textContent).toContain("No limit");
   // No sorting, no total, no chart, no per-person output number.
   expect(within(table).queryAllByRole("button")).toEqual([]);
   expect(within(table).queryByText(/total/iu)).toBeNull();
   expect(document.body.textContent).not.toMatch(/merged|rank|quality|score|speed|tasks done|per day/iu);
   expect(screen.queryByRole("img")).toBeNull();
   expect(screen.queryByRole("progressbar")).toBeNull();
   expect(document.body.textContent).toContain("Names are in alphabetical order.");
   expect(document.body.textContent).toContain("across every project");
   expect(screen.getByRole("heading", { level: 2, name: /Spending in November 2026/u })).toBeTruthy();
  } finally { f.close(); }
 });
 it("links each person to their limit on the Spending limits page", async () => {
  const f = mount(PATH, () => ok(body()));
  try {
   const link = await screen.findByRole("link", { name: "Change the limit for Bo" });
   expect(link.getAttribute("href")).toBe(`/app/admin/money/limits?person=${BO}`);
   expect(screen.getByRole("link", { name: "Set or change a limit on the Spending limits page." }).getAttribute("href")).toBe("/app/admin/money/limits");
  } finally { f.close(); }
 });
 it("filters by project: asks for that project, narrows the list, and says the amounts are still the whole month", async () => {
  const f = mount(PATH, r => ok(r.path.endsWith("?project=web") ? body({ project: "web", people: [rows[0]!] }) : body()));
  try {
   await screen.findByRole("table", { name: "People and limits" });
   fireEvent.change(screen.getByLabelText("Show people on"), { target: { value: "web" } });
   await waitFor(() => { expect(f.request.mock.calls.map(([r]) => r.path)).toContain("/v1/app/org/people-limits?project=web"); });
   await waitFor(() => { expect(within(screen.getByRole("table", { name: "People and limits" })).getAllByRole("row")).toHaveLength(2); });
   expect(document.body.textContent).toContain("not only web");
   expect(document.body.textContent).toContain("Company-wide spend");
   // The filter stays offered with the narrower list, and back to everyone asks for the whole list.
   fireEvent.change(screen.getByLabelText("Show people on"), { target: { value: "" } });
   await waitFor(() => { expect(within(screen.getByRole("table", { name: "People and limits" })).getAllByRole("row")).toHaveLength(5); });
   expect(f.request.mock.calls.every(([r]) => r.method === "GET")).toBe(true);
  } finally { f.close(); }
 });
 it("says so when no one is on the project or in the company", async () => {
  const f = mount(PATH, () => ok(body({ project: "web", people: [] })));
  try { expect(await screen.findByTestId("people-limits-empty")).toBeTruthy(); expect(screen.queryByRole("table", { name: "People and limits" })).toBeNull(); } finally { f.close(); }
 });
 it("a member sees a refusal and nothing is asked of Cloud", async () => {
  const f = mount(PATH, () => ok(body()), "member");
  try {
   // The admin area itself turns a member away (no page, no link); the page's own refusal is the second lock.
   expect(await screen.findByRole("heading", { name: "Administration unavailable" })).toBeTruthy();
   expect(f.request.mock.calls.map(([r]) => r.path)).not.toContain("/v1/app/org/people-limits");
   expect(screen.queryByText("Al")).toBeNull();
  } finally { f.close(); }
 });
 it("says it is not connected yet when Cloud has no gateway meter, and draws no amount", async () => {
  const f = mount(PATH, () => ({ status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "x" } } }));
  try { expect(await screen.findByTestId("not-connected")).toBeTruthy(); expect(document.body.textContent).toMatch(/People and limits isn't connected to Rovara Code yet/u); expect(screen.queryByRole("table", { name: "People and limits" })).toBeNull(); } finally { f.close(); }
 });
 it("a refusal (403), an outage and an unreadable answer draw no amount, in words that echo nothing", async () => {
  for (const [status, text] of [[403, "You don't have permission to see people's spending."], [503, "Couldn't load people's spending."], [200, "Couldn't load people's spending."]] as const) {
   const f = mount(PATH, () => (status === 200 ? ok({ people: "nope" }) : { status, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "secret outage text" } } }));
   try {
    expect(await screen.findByTestId("people-limits-error", {}, { timeout: 15_000 })).toBeTruthy();
    expect(document.body.textContent).toContain(text);
    expect(document.body.textContent).not.toContain("secret outage text");
    expect(screen.queryByRole("table", { name: "People and limits" })).toBeNull();
   } finally { f.close(); }
  }
 }, 60_000);
 it("has no accessibility violations", async () => {
  const f = mount(PATH, () => ok(body()));
  try { await screen.findByRole("table", { name: "People and limits" }); await expectNoAxeViolations(f.container); } finally { f.close(); }
 });
});

describe("Spending limits opened from People and limits", () => {
 const limits = (people: unknown[]) => ({ companyId: "org_aaaaaaaaaaaaaaaaaaaa", canChange: true, settingsVersion: 3, defaults: { companyMonthlyUsd: 500, memberMonthlyUsd: 50, projectMonthlyUsd: 100, taskUsd: 2, upkeepMonthlyUsd: 25, answersMonthlyUsd: 20 }, upkeep: [], answers: [], projects: [], people, partial: false, max: { projects: 200, people: 200, upkeep: 200, answers: 1 } });
 const answer = (people: unknown[]) => (r: ApiRequest): ApiResponse => (r.path === "/v1/app/org/spend-limits" ? ok(limits(people)) : r.path === "/v1/app/org/members" ? ok({ members: [{ developerId: AL, name: "Al" }, { developerId: BO, name: "Bo" }] }) : ok({}));
 it("opens the add form on the person when they have no limit of their own", async () => {
  const f = mount(`/app/admin/money/limits?person=${BO}`, answer([{ id: AL, monthlyUsd: 10, version: 1, updatedAt: "2026-11-17T00:00:00.000Z", updatedBy: me }]));
  try {
   const form = within(await screen.findByRole("form", { name: "Add a person limit" }));
   await waitFor(() => { expect(form.getByLabelText<HTMLSelectElement>("Person").value).toBe(BO); });
  } finally { f.close(); }
 });
 it("opens the person's own limit for editing when they already have one", async () => {
  const f = mount(`/app/admin/money/limits?person=${AL}`, answer([{ id: AL, monthlyUsd: 10, version: 1, updatedAt: "2026-11-17T00:00:00.000Z", updatedBy: me }]));
  try {
   const table = within(await screen.findByTestId("spend-people-table"));
   expect(table.getByLabelText<HTMLInputElement>(/New monthly limit/u).value).toBe("10");
  } finally { f.close(); }
 });
 it("ignores anything in the address that is not a person id", async () => {
  const f = mount("/app/admin/money/limits?person=%3Cscript%3E", answer([]));
  try { const form = within(await screen.findByRole("form", { name: "Add a person limit" })); await waitFor(() => { expect(form.getByLabelText<HTMLSelectElement>("Person").value).toBe(""); }); } finally { f.close(); }
 });
});
