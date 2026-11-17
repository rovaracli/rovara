// @vitest-environment jsdom
// Lead 3 B1: the Spending limits admin page. Defaults read-only (changed in Company settings), a project table and a person table (add, edit, remove), the
// "Confirm it's you" step shown only when the server asks (a raise), the per-task default shown with a link to the project pages, a member never sees it.
import { beforeEach, describe, expect, it } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { parseUsd, readPeopleNames, readSpendLimits } from "../../packages/ui/src/api/admin-spend-limits.js";
import { visibleAdminGroups } from "../../packages/ui/src/screens/admin/admin-nav.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

const me = "a".repeat(64);
const PERSON = "1".repeat(64);
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
const seeded = new Map<string, string>();
beforeEach(() => { seeded.clear(); });
function mount(path: string, respond: (r: ApiRequest) => ApiResponse | Promise<ApiResponse>) {
 const nav = AppNavSchema.parse({ me: { developerId: me, name: "Priya", orgRole: "owner" }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
 const identity = AppMeResponseSchema.parse({ developer: { id: me, name: "Priya", orgRole: "owner" }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
 const f = fakeHost(async r => (r.path === "/v1/app/nav" ? { status: 200, body: nav } : r.path === "/v1/app/me" ? { status: 200, body: identity } : respond(r)));
 const query = createQueryClient(); query.setQueryData(["nav"], nav); f.storage.set("rovara.theme", "light");
 for (const [key, value] of seeded) f.storage.set(key, value);
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: [path] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 return { ...f, ...view, close: () => { view.unmount(); router.dispose(); query.clear(); } };
}
const body = (over: Record<string, unknown> = {}) => ({
 companyId: "org_aaaaaaaaaaaaaaaaaaaa", canChange: true, settingsVersion: 3,
 defaults: { companyMonthlyUsd: 500, memberMonthlyUsd: 50, projectMonthlyUsd: 100, taskUsd: 2 },
 projects: [{ id: "web", monthlyUsd: 40, version: 2, updatedAt: "2026-11-17T12:00:00.000Z", updatedBy: me }], people: [{ id: PERSON, monthlyUsd: 10, version: 1, updatedAt: "2026-11-17T12:00:00.000Z", updatedBy: me }],
 partial: false, max: { projects: 200, people: 200 }, ...over,
});

describe("Spending limits page", () => {
 it("is a link in Money for owners and admins, and never for a member", () => {
  for (const role of ["owner", "admin"] as const) expect(visibleAdminGroups(role, false).find(group => group.id === "money")!.links.map(link => link.label)).toContain("Spending limits");
  expect(visibleAdminGroups("member", false).flatMap(group => group.links.map(link => link.label))).not.toContain("Spending limits");
 });

 it("reads only the shape it expects, and parses a typed amount strictly", () => {
  expect(readSpendLimits(body()).projects).toEqual([{ id: "web", monthlyUsd: 40, version: 2 }]);
  for (const bad of [null, [], { ...body(), defaults: null }, body({ projects: [{ id: "Web", monthlyUsd: 1, version: 1 }] }), body({ people: [{ id: "abc", monthlyUsd: 1, version: 1 }] }), body({ projects: [{ id: "web", monthlyUsd: -1, version: 1 }] }),
   body({ projects: [{ id: "web", monthlyUsd: 1, version: 0 }] }), body({ partial: "no" }), body({ defaults: { companyMonthlyUsd: "5", memberMonthlyUsd: null, projectMonthlyUsd: null, taskUsd: null } }), body({ max: { projects: -1, people: 1 } })]) {
   expect(() => readSpendLimits(bad), JSON.stringify(bad)).toThrow();
  }
  expect(readSpendLimits(body({ defaults: { companyMonthlyUsd: 5, memberMonthlyUsd: null, projectMonthlyUsd: null, taskUsd: null } })).defaults.memberMonthlyUsd).toBeNull();
  expect(["5", "12.50", "$1,200", " 0 ", "1000000"].map(parseUsd)).toEqual([5, 12.5, 1200, 0, 1_000_000]);
  expect(["", "-1", "1.234", "1e3", "abc", "1000001", "5 dollars", "NaN", "0x10", "1,2,3.456"].map(parseUsd)).toEqual(Array(10).fill(undefined));
 });

 it("shows the defaults read-only with the per-task default and a link to the project pages, and the two tables", async () => {
  const f = mount("/app/admin/money/limits", () => ({ status: 200, body: body() }));
  try {
   const defaults = await screen.findByTestId("spend-defaults");
   expect(defaults.textContent).toMatch(/Company, each month: \$500/u);
   expect(defaults.textContent).toMatch(/Each person, each month: \$50/u);
   expect(defaults.textContent).toMatch(/Each project, each month: \$100/u);
   expect(screen.getByTestId("spend-task-default").textContent).toMatch(/Each task: \$2/u);
   expect(within(screen.getByTestId("spend-task-default")).getByRole("link", { name: "that project's page" }).getAttribute("href")).toBe("/app/admin/projects");
   expect(within(screen.getByTestId("spend-project-table")).getByText("web")).toBeTruthy();
   expect(within(screen.getByTestId("spend-person-table")).getByTitle(PERSON).textContent).toBe(`${"1".repeat(12)}…`);
   // Nothing here changes a default.
   expect(screen.queryByLabelText(/company monthly/iu)).toBeNull();
   // No fresh sign-in step until the server asks.
   expect(screen.queryByTestId("fresh-sign-in")).toBeNull();
  } finally { f.close(); }
 });

 it("adds a project limit with expectedVersion 0 and the amount in dollars; an invalid name or amount cannot be sent", async () => {
  const sent: ApiRequest[] = [];
  const f = mount("/app/admin/money/limits", r => { if (r.method === "PUT") { sent.push(r); return { status: 200, body: body() }; } return { status: 200, body: body({ projects: [] }) }; });
  try {
   await screen.findByTestId("spend-project-table");
   const form = within(screen.getByRole("form", { name: "Add a project limit" }));
   const add = form.getByRole<HTMLButtonElement>("button", { name: "Add limit" });
   expect(add.disabled).toBe(true);
   fireEvent.change(form.getByLabelText("Project name"), { target: { value: "Web App" } });
   fireEvent.change(form.getByLabelText(/Monthly limit for this project/u), { target: { value: "12.50" } });
   expect(add.disabled).toBe(true);
   expect(form.getByText("That isn't a valid project name.")).toBeTruthy();
   fireEvent.change(form.getByLabelText("Project name"), { target: { value: "api" } });
   fireEvent.change(form.getByLabelText(/Monthly limit for this project/u), { target: { value: "12.505" } });
   expect(add.disabled).toBe(true);
   fireEvent.change(form.getByLabelText(/Monthly limit for this project/u), { target: { value: "12.50" } });
   expect(add.disabled).toBe(false);
   fireEvent.click(add);
   await waitFor(() => { expect(sent).toHaveLength(1); });
   expect(sent[0]!.path).toBe("/v1/app/org/spend-limits/projects/api");
   expect(sent[0]!.body).toEqual({ expectedVersion: 0, monthlyUsd: 12.5 });
  } finally { f.close(); }
 });

 it("edits a person's limit with the version read, and removes one with null", async () => {
  const sent: ApiRequest[] = [];
  const f = mount("/app/admin/money/limits", r => { if (r.method === "PUT") { sent.push(r); } return { status: 200, body: body() }; });
  try {
   const table = within(await screen.findByTestId("spend-person-table"));
   fireEvent.click(table.getByRole("button", { name: "Edit" }));
   fireEvent.change(table.getByLabelText(/New monthly limit/u), { target: { value: "25" } });
   fireEvent.click(table.getByRole("button", { name: "Save" }));
   await waitFor(() => { expect(sent).toHaveLength(1); });
   expect(sent[0]!.path).toBe(`/v1/app/org/spend-limits/people/${PERSON}`);
   expect(sent[0]!.body).toEqual({ expectedVersion: 1, monthlyUsd: 25 });
   fireEvent.click(within(screen.getByTestId("spend-project-table")).getByRole("button", { name: "Remove" }));
   await waitFor(() => { expect(sent).toHaveLength(2); });
   expect(sent[1]!.path).toBe("/v1/app/org/spend-limits/projects/web");
   expect(sent[1]!.body).toEqual({ expectedVersion: 2, monthlyUsd: null });
  } finally { f.close(); }
 });

 it("shows the Confirm it's you step only when the server asks for it (a raise), and not for a change it accepts", async () => {
  const f = mount("/app/admin/money/limits", r => (r.method === "PUT" && (r.body as { monthlyUsd: number | null }).monthlyUsd !== null && (r.body as { monthlyUsd: number }).monthlyUsd > 40
   ? { status: 403, body: { error: { code: "STEP_UP_REQUIRED", message: "Confirm it's you again, then try once more." } } } : { status: 200, body: body() }));
  try {
   const table = within(await screen.findByTestId("spend-project-table"));
   fireEvent.click(table.getByRole("button", { name: "Edit" }));
   fireEvent.change(table.getByLabelText(/New monthly limit/u), { target: { value: "30" } });
   fireEvent.click(table.getByRole("button", { name: "Save" }));
   expect(await screen.findByText(/Saved the limit for web/u)).toBeTruthy();
   expect(screen.queryByTestId("fresh-sign-in")).toBeNull();
   fireEvent.click(table.getByRole("button", { name: "Edit" }));
   fireEvent.change(table.getByLabelText(/New monthly limit/u), { target: { value: "90" } });
   fireEvent.click(table.getByRole("button", { name: "Save" }));
   const step = await screen.findByTestId("fresh-sign-in");
   expect(step.getAttribute("data-state")).toBe("needed");
   expect(step.textContent).toMatch(/raise a spending limit/u);
   fireEvent.click(screen.getByTestId("fresh-sign-in-start"));
   expect(f.host.signIn).toHaveBeenCalled();
  } finally { f.close(); }
 });

 it("says too many when the list is full, shows a server refusal in its fixed words, and says not connected when Cloud has no company data", async () => {
  const full = mount("/app/admin/money/limits", () => ({ status: 200, body: body({ partial: true }) }));
  try { expect((await screen.findByTestId("spend-project-full")).textContent).toMatch(/too many limits/u); expect(screen.queryByRole("form", { name: "Add a project limit" })).toBeNull(); } finally { full.close(); }
  const refused = mount("/app/admin/money/limits", r => (r.method === "PUT" ? { status: 409, body: { error: { code: "CONFLICT", message: "This limit changed since you opened it. Refresh and try again." } } } : { status: 200, body: body() }));
  try {
   fireEvent.click(within(await screen.findByTestId("spend-project-table")).getByRole("button", { name: "Remove" }));
   expect((await screen.findByRole("alert")).textContent).toBe("This limit changed since you opened it. Refresh and try again.");
  } finally { refused.close(); }
  const off = mount("/app/admin/money/limits", () => ({ status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "not connected" } } }));
  try { expect(await screen.findByTestId("not-connected")).toBeTruthy(); } finally { off.close(); }
 });
 it("names people from the Members list when it reads, picks a person by name, and falls back to the ID when it does not", async () => {
  const OTHER = "2".repeat(64);
  const sent: ApiRequest[] = [];
  const members = { members: [{ developerId: PERSON, name: "Maya Chen" }, { developerId: OTHER, name: "Ravi Patel" }, { developerId: "x", name: "Bad row" }, { developerId: "3".repeat(64), name: "  " }] };
  const f = mount("/app/admin/money/limits", r => (r.path === "/v1/app/org/members" ? { status: 200, body: members } : r.method === "PUT" ? (sent.push(r), { status: 200, body: body() }) : { status: 200, body: body() }));
  try {
   const table = within(await screen.findByTestId("spend-person-table"));
   await waitFor(() => { expect(table.getByTitle(PERSON).textContent).toBe("Maya Chen"); });
   const form = within(screen.getByRole("form", { name: "Add a person limit" }));
   // Only people without a limit of their own can be picked.
   const options = [...form.getByLabelText<HTMLSelectElement>("Person").options].map(option => option.textContent);
   expect(options).toEqual(["Choose a person", "Ravi Patel"]);
   fireEvent.change(form.getByLabelText("Person"), { target: { value: OTHER } });
   fireEvent.change(form.getByLabelText(/Monthly limit for this person/u), { target: { value: "5" } });
   fireEvent.click(form.getByRole("button", { name: "Add limit" }));
   await waitFor(() => { expect(sent).toHaveLength(1); });
   expect(sent[0]!.path).toBe(`/v1/app/org/spend-limits/people/${OTHER}`);
   expect(sent[0]!.body).toEqual({ expectedVersion: 0, monthlyUsd: 5 });
  } finally { f.close(); }
  const plain = mount("/app/admin/money/limits", r => (r.path === "/v1/app/org/members" ? { status: 500, body: {} } : { status: 200, body: body() }));
  try {
   const table = within(await screen.findByTestId("spend-person-table"));
   expect(table.getByTitle(PERSON).textContent).toBe(`${"1".repeat(12)}…`);
   expect(within(screen.getByRole("form", { name: "Add a person limit" })).getByLabelText("Person ID")).toBeTruthy();
  } finally { plain.close(); }
  expect(readPeopleNames(members)).toEqual([{ developerId: PERSON, name: "Maya Chen" }, { developerId: OTHER, name: "Ravi Patel" }]);
  expect(() => readPeopleNames({ members: "x" })).toThrow();
 });
});
