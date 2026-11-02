// @vitest-environment jsdom
// Setup recipes (SH29 wiring, switch `sp`): the link on the company How we work page and the small screen behind it: what waits for approval (with the commands an admin approves), who each approved recipe is offered to,
// approve / reject / stop / change who it is offered to, and sharing a project's setup. The server decides all of it; the screen shows its answer, in its words.
import { afterEach, describe, expect, it } from "vitest";
import { act, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { Outlet, createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { ShareRecipePanel } from "../../packages/ui/src/screens/admin/how-we-work/ShareRecipePanel.js";
import { SetupRecipesScreen } from "../../packages/ui/src/screens/admin/how-we-work/SetupRecipesScreen.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { h } from "./support/h.js";
import { companyPolicyRaw } from "./support/company-policy-raw.js";

// jsdom has no ResizeObserver, which the checkbox inside a form measures with.
globalThis.ResizeObserver ??= class { observe(): void { /* none */ } unobserve(): void { /* none */ } disconnect(): void { /* none */ } };
const PATH = "/v1/app/org/setup-recipes";
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
const recipe = (changes: Record<string, unknown> = {}) => ({
 recipeId: "rcp_" + "1".repeat(20), revision: 1, status: "proposed", digest: "d".repeat(64), label: "Python services", buildSystems: ["python"], toolchains: [{ tool: "python", version: "3.12" }],
 setup: [{ line: "{repo}: uv sync --frozen", timeoutSeconds: 600 }], update: [], checks: [{ id: "unit", label: "Unit tests", kind: "test", command: { line: "{repo}: pytest -q", timeoutSeconds: 600 } }], approvedHosts: ["pypi.internal.example.com"],
 match: { markerFiles: ["pyproject.toml"], registryHosts: ["pypi.internal.example.com"] }, scope: { kind: "company" }, fromProject: true, proposedBy: "Maya Chen", replaces: [], createdByYou: false, updatedAt: "2026-11-02T09:00:00.000Z", ...changes,
});
type State = { recipes: Array<Record<string, unknown>>; unreadable: string[]; projects: string[]; markerFiles: string[] };
const initial = (recipes: Array<Record<string, unknown>> = [], unreadable: string[] = []): State => ({ recipes, unreadable, projects: ["orders", "billing"], markerFiles: ["package.json", "pyproject.toml"] });
type Handler = (request: ApiRequest) => ApiResponse | undefined | Promise<ApiResponse | undefined>;
const refuse = (status: number, code: string, message: string) => ({ status, body: { error: { code, message } } });

function mount(options: { state?: State; missing?: boolean; role?: "owner" | "admin" | "member"; post?: Handler; at?: string; theme?: "light" | "dark" } = {}) {
 const role = options.role ?? "owner";
 const nav = AppNavSchema.parse({ me: { developerId: "a".repeat(64), name: "Priya", orgRole: role }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
 const me = AppMeResponseSchema.parse({ developer: { id: "a".repeat(64), name: "Priya", orgRole: role }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
 let state = options.state ?? initial();
 const f = fakeHost(async request => {
  const path = request.path.split("?")[0];
  if (path === "/v1/app/nav") return { status: 200, body: nav };
  if (path === "/v1/app/me") return { status: 200, body: me };
  if (path === "/v1/app/org/model-selection-policy") return { status: 200, body: companyPolicyRaw() };
  if (path === "/v1/app/org/model-sources") return { status: 200, body: { sources: [], order: ["rovara"] } };
  if (path === PATH && options.missing === true) return refuse(404, "NOT_FOUND", "Not found.");
  if (path === PATH && request.method === "GET") return { status: 200, body: state };
  if (path === PATH && request.method === "POST") {
   const custom = await options.post?.(request);
   if (custom !== undefined) return custom;
   const body = request.body as { action: string; recipeId: string; scope?: { kind: string; projects?: string[] } };
   state = { ...state, recipes: state.recipes.map(entry => entry.recipeId !== body.recipeId ? entry : body.action === "approve" ? { ...entry, status: "approved", revision: 2 } : body.action === "revoke" ? { ...entry, status: "revoked", revision: 2 } : { ...entry, scope: body.scope, revision: 2 }) };
   return { status: 200, body: { status: "done" } };
  }
  if (path?.endsWith("/setup-recipe") && request.method === "POST") {
   const custom = await options.post?.(request);
   if (custom !== undefined) return custom;
   return { status: 200, body: { status: "proposed", recipeId: "rcp_" + "2".repeat(20), revision: 1, digest: "e".repeat(64) } };
  }
  return refuse(404, "NOT_FOUND", "Not found.");
 });
 f.host.kind = "web";f.host.origin = "https://cell.example";
 const query = createQueryClient();query.setQueryData(["nav"], nav);f.storage.set("rovara.theme", options.theme ?? "light");
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: [options.at ?? "/app/admin/how-we-work/recipes"] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 const calls = () => f.request.mock.calls.map(([request]) => request);
 return { ...f, ...view, posts: () => calls().filter(request => request.method === "POST"), reads: () => calls().filter(request => request.method === "GET" && request.path === PATH) };
}
afterEach(() => { document.body.innerHTML = ""; });

describe("the link on How we work", () => {
 it("shows how many recipes wait, and goes to the screen", async () => {
  mount({ state: initial([recipe(), recipe({ recipeId: "rcp_" + "3".repeat(20) })]), at: "/app/admin/how-we-work" });
  const section = within(await screen.findByRole("region", { name: "Setup recipes" }));
  expect(section.getByText("2 recipes are waiting for approval.")).toBeTruthy();
  expect(section.getByRole("link", { name: "Open setup recipes" }).getAttribute("href")).toBe("/app/admin/how-we-work/recipes");
 });
 it("is absent while the switch is off (the server says not found), with no notice", async () => {
  const f = mount({ missing: true, at: "/app/admin/how-we-work" });
  await screen.findByRole("heading", { name: "How we work (company)" });
  await waitFor(() => expect(f.reads().length).toBeGreaterThan(0));
  expect(screen.queryByRole("region", { name: "Setup recipes" })).toBeNull();
 });
});

describe("the screen", () => {
 it("tells a member in words and reads nothing", async () => {
  // The administration layout keeps members out; the screen holds its own line too, so it is rendered here with a member's context.
  const f = fakeHost(async () => refuse(404, "NOT_FOUND", "Not found."));
  f.host.kind = "web";
  const router = createMemoryRouter([{ path: "/", element: h(Outlet, { context: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", company: "Acme", developerId: "a".repeat(64), role: "member", checking: false } }), children: [{ index: true, element: h(SetupRecipesScreen) }] }]);
  renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: createQueryClient(), children: h(RouterProvider, { router }) }) }));
  await screen.findByText("Only a company owner or admin can see or change setup recipes.");
  expect(f.request).not.toHaveBeenCalled();
 });
 it("says the recipes are not on when the server does not know them", async () => {
  mount({ missing: true });
  await screen.findByText("Setup recipes are not turned on for this company.");
 });
 it("shows a waiting recipe with what it runs, and approves exactly the revision and digest it showed", async () => {
  const f = mount({ state: initial([recipe()]) });
  const card = within(await screen.findByRole("region", { name: "Python services" }));
  expect(card.getByText("{repo}: uv sync --frozen")).toBeTruthy();
  expect(card.getByText("{repo}: pytest -q")).toBeTruthy();
  expect(card.getByText(/Websites it asks for: pypi\.internal\.example\.com/)).toBeTruthy();
  fireEvent.click(card.getByRole("button", { name: "Approve this recipe" }));
  await screen.findByText("Approved.");
  expect(f.posts()).toHaveLength(1);
  expect(f.posts()[0]!.body).toEqual({ action: "approve", recipeId: "rcp_" + "1".repeat(20), expectedRevision: 1, expectedDigest: "d".repeat(64) });
  expect(f.posts()[0]!.retry).toBe("never");
  await screen.findByText("Every project of the company");
 });
 it("asks for a new sign-in in the server's words when the sign-in is old", async () => {
  const f = mount({ state: initial([recipe()]), post: () => refuse(403, "REAUTH_REQUIRED", "Sign in again to confirm this company change.") });
  fireEvent.click(await screen.findByRole("button", { name: "Approve this recipe" }));
  await screen.findByText("Sign in again to confirm this company change.");
  fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
  expect(f.host.signIn).toHaveBeenCalled();
 });
 it("reads the list again and says so when the recipe changed meanwhile", async () => {
  const f = mount({ state: initial([recipe()]), post: () => refuse(409, "CHANGE_STALE", "That recipe changed. Refresh before continuing.") });
  const button = await screen.findByRole("button", { name: "Approve this recipe" });
  const before = f.reads().length;
  fireEvent.click(button);
  await screen.findByText("That recipe changed. The list was read again; check it and try again.");
  await waitFor(() => expect(f.reads().length).toBeGreaterThan(before));
 });
 it("changes who an approved recipe is offered to, and stops offering it", async () => {
  const f = mount({ state: initial([recipe({ status: "approved", revision: 2, scope: { kind: "company" } })]) });
  const card = within(await screen.findByRole("region", { name: "Python services" }));
  fireEvent.click(card.getByRole("button", { name: "Change who it is offered to" }));
  fireEvent.click(card.getByRole("checkbox", { name: "orders" }));
  fireEvent.click(card.getByRole("button", { name: "Save" }));
  await screen.findByText("Saved.");
  expect(f.posts()[0]!.body).toEqual({ action: "scope", recipeId: "rcp_" + "1".repeat(20), expectedRevision: 2, scope: { kind: "projects", projects: ["orders"] } });
  await screen.findByText("Only these projects: orders");
  fireEvent.click(within(await screen.findByRole("region", { name: "Python services" })).getByRole("button", { name: "Stop offering" }));
  await waitFor(() => expect(f.posts()).toHaveLength(2));
  expect(f.posts()[1]!.body).toEqual({ action: "revoke", recipeId: "rcp_" + "1".repeat(20), expectedRevision: 2 });
 });
 it("shows hidden characters of a recipe's text as visible marks", async () => {
  mount({ state: initial([recipe({ label: "Services\u202Ereversed", setup: [{ line: "{repo}: make\u202E", timeoutSeconds: 60 }] })]) });
  expect(await screen.findByText("Services[U+202E]reversed")).toBeTruthy();
  expect(screen.getByText("{repo}: make[U+202E]")).toBeTruthy();
 });
 it("shares a project's setup: one request to the project's route, nothing sent until the form is filled", async () => {
  const f = mount({ state: initial() });
  const form = within(await screen.findByRole("form", { name: "Share a project's setup" }));
  const button = form.getByRole("button", { name: "Share as company recipe" });
  expect(button).toHaveProperty("disabled", true);
  fireEvent.change(form.getByLabelText("Project"), { target: { value: "orders" } });
  fireEvent.change(form.getByLabelText("Repository"), { target: { value: "orders-api" } });
  fireEvent.change(form.getByLabelText("Recipe name"), { target: { value: "Python services" } });
  fireEvent.change(form.getByLabelText("Build systems"), { target: { value: "python" } });
  fireEvent.change(form.getByLabelText("Tool versions"), { target: { value: "python 3.12" } });
  fireEvent.click(form.getByRole("checkbox", { name: "pyproject.toml" }));
  fireEvent.change(form.getByLabelText("Package registries"), { target: { value: "pypi.internal.example.com" } });
  fireEvent.change(form.getByLabelText("Websites to share"), { target: { value: "pypi.internal.example.com, files.example.com" } });
  await waitFor(() => expect(button).toHaveProperty("disabled", false));
  fireEvent.click(button);
  await screen.findByText("Shared. It is waiting for approval above.");
  expect(f.posts()).toHaveLength(1);
  expect(f.posts()[0]!.path).toBe("/v1/app/projects/orders/setup-recipe");
  expect(f.posts()[0]!.body).toEqual({ repositoryId: "orders-api", label: "Python services", buildSystems: ["python"], toolchains: [{ tool: "python", version: "3.12" }], markerFiles: ["pyproject.toml"], registryHosts: ["pypi.internal.example.com"], approvedHosts: ["pypi.internal.example.com", "files.example.com"] });
 });
 it("has no accessibility violations in light and dark", async () => {
  for (const theme of ["light", "dark"] as const) {
   const view = mount({ state: initial([recipe(), recipe({ recipeId: "rcp_" + "4".repeat(20), status: "approved", label: "Go services", scope: { kind: "projects", projects: ["orders"] } })]), theme });
   await screen.findByRole("region", { name: "Go services" });
   await expectNoAxeViolations(view.container);
   view.unmount();
   document.body.innerHTML = "";
  }
 });
});

describe("what the admin reads before approving (F2, F4)", () => {
 it("shows the update commands, every check's select arguments and report, coverage and SARIF paths, and the time limits", async () => {
  mount({ state: initial([recipe({
   update: [{ line: "{repo}: uv lock --check", timeoutSeconds: 300 }],
   checks: [{ id: "unit", label: "Unit tests", kind: "test", command: { line: "{repo}: pytest -q", timeoutSeconds: 1800 }, selectArgs: ["-k", "{tests}"], reportPath: "{repo}/reports/junit.xml", coveragePath: "{repo}/reports/coverage.xml" },
    { id: "scan", label: "Scan", kind: "security", command: { line: "{repo}: semgrep --sarif", timeoutSeconds: 600 }, sarifPath: "{repo}/reports/scan.sarif" }],
  })]) });
  const card = within(await screen.findByRole("region", { name: "Python services" }));
  expect(card.getByText("Update commands")).toBeTruthy();
  expect(card.getByText("{repo}: uv lock --check")).toBeTruthy();
  expect(card.getByText("-k {tests}")).toBeTruthy();
  expect(card.getByText("{repo}/reports/junit.xml")).toBeTruthy();
  expect(card.getByText("{repo}/reports/coverage.xml")).toBeTruthy();
  expect(card.getByText("{repo}/reports/scan.sarif")).toBeTruthy();
  expect(card.getByText("(up to 30 min)")).toBeTruthy();
 });
 it("says who proposed it and from which project, and warns which approved recipe it replaces", async () => {
  mount({ state: initial([recipe({ sourceProject: "orders", replaces: [{ recipeId: "rcp_" + "5".repeat(20), label: "Older Python" }] })]) });
  const card = within(await screen.findByRole("region", { name: "Python services" }));
  expect(card.getByText(/Proposed by Maya Chen from the project orders/)).toBeTruthy();
  expect(card.getByText(/Approving replaces/)).toBeTruthy();
  expect(card.getByText("Older Python")).toBeTruthy();
 });
});

describe("a damaged recipe (F9)", () => {
 it("is listed by id and removed with one press", async () => {
  const f = mount({ state: initial([], ["rcp_" + "6".repeat(20)]) });
  const box = within(await screen.findByRole("region", { name: "Recipes that cannot be read" }));
  fireEvent.click(box.getByRole("button", { name: "Remove" }));
  await screen.findByText("Removed.");
  expect(f.posts()[0]!.body).toEqual({ action: "revoke", recipeId: "rcp_" + "6".repeat(20), expectedRevision: 1 });
 });
});

describe("names from the server in labels (F8)", () => {
 it("a project name with a hidden character shows as a visible mark in the scope boxes and the project list", async () => {
  mount({ state: { ...initial([recipe({ status: "approved", revision: 2 })]), projects: ["or\u202Eders"] } });
  const card = within(await screen.findByRole("region", { name: "Python services" }));
  fireEvent.click(card.getByRole("button", { name: "Change who it is offered to" }));
  expect(card.getByRole("checkbox", { name: "or[U+202E]ders" })).toBeTruthy();
  const share = within(await screen.findByRole("form", { name: "Share a project's setup" }));
  expect(share.getByRole("option", { name: "or[U+202E]ders" })).toBeTruthy();
 });
 it("a recipe name with a hidden character names its region visibly", async () => {
  mount({ state: initial([recipe({ label: "Py\u202Ethon" })]) });
  expect(await screen.findByRole("region", { name: "Py[U+202E]thon" })).toBeTruthy();
 });
});

describe("the share entry point on a project's test environment page (F8)", () => {
 function panel(info: { status: number; body: unknown }, options: { post?: Handler } = {}) {
  const f = fakeHost(async request => {
   if (request.path === "/v1/app/projects/orders/setup-recipe" && request.method === "GET") return info;
   if (request.path === "/v1/app/projects/orders/setup-recipe" && request.method === "POST") return (await options.post?.(request)) ?? { status: 200, body: { status: "proposed", recipeId: "rcp_" + "2".repeat(20), revision: 1, digest: "e".repeat(64) } };
   return refuse(404, "NOT_FOUND", "Not found.");
  });
  f.host.kind = "web";f.host.origin = "https://cell.example";
  const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: createQueryClient(), children: h(ShareRecipePanel, { project: "orders" }) }) }));
  return { ...f, ...view, posts: () => f.request.mock.calls.map(([request]) => request).filter(request => request.method === "POST") };
 }
 it("is absent while recipes are off, for a person who cannot maintain the project, and while there is no approved environment", async () => {
  for (const reply of [refuse(404, "NOT_FOUND", "Not found."), refuse(403, "FORBIDDEN", "Only a project maintainer can share a project's setup."), { status: 200, body: { repositories: ["orders-api"], markerFiles: ["pyproject.toml"], hasApprovedEnvironment: false } }]) {
   const f = panel(reply);
   await waitFor(() => expect(f.request).toHaveBeenCalled());
   await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
   expect(screen.queryByRole("region", { name: "Company recipe" })).toBeNull();
   f.unmount();
  }
 });
 it("offers the form with the project's repositories, and shares with one request to the project's route", async () => {
  const f = panel({ status: 200, body: { repositories: ["orders-api", "orders-web"], markerFiles: ["package.json", "pyproject.toml"], hasApprovedEnvironment: true } });
  fireEvent.click(await screen.findByRole("button", { name: "Share as company recipe" }));
  const form = within(await screen.findByRole("form", { name: "Share a project's setup" }));
  expect(form.queryByLabelText("Project")).toBeNull();
  fireEvent.change(form.getByLabelText("Repository"), { target: { value: "orders-api" } });
  fireEvent.change(form.getByLabelText("Recipe name"), { target: { value: "Python services" } });
  fireEvent.change(form.getByLabelText("Build systems"), { target: { value: "python" } });
  fireEvent.click(form.getByRole("checkbox", { name: "pyproject.toml" }));
  const submit = form.getByRole("button", { name: "Share as company recipe" });
  await waitFor(() => expect(submit).toHaveProperty("disabled", false));
  fireEvent.click(submit);
  await screen.findByText("Shared. A company admin approves it before any project is offered it.");
  expect(f.posts()).toHaveLength(1);
  expect(f.posts()[0]!.path).toBe("/v1/app/projects/orders/setup-recipe");
  expect(f.posts()[0]!.body).toMatchObject({ repositoryId: "orders-api", label: "Python services", markerFiles: ["pyproject.toml"] });
 });
});
