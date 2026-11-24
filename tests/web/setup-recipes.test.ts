// @vitest-environment jsdom
// Setup recipes (SH29 wiring, switch `sp`): the link on the company How we work page and the small screen behind it: what waits for approval (with the commands an admin approves), who each approved recipe is offered to,
// approve / reject / stop / change who it is offered to, and sharing a project's setup. The server decides all of it; the screen shows its answer, in its words.
import { afterEach, describe, expect, it } from "vitest";
import { act, screen, fireEvent, renderHook, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { useRecipeActions } from "../../packages/ui/src/screens/admin/how-we-work/recipe-actions.js";
import { ShareRecipePanel } from "../../packages/ui/src/screens/admin/how-we-work/ShareRecipePanel.js";
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
 match: { markerFiles: ["pyproject.toml"], registryHosts: ["registry.internal.example.net"] }, scope: { kind: "company" }, fromProject: true, proposedBy: "Maya Chen", replaces: [], createdByYou: false, updatedAt: "2026-11-02T09:00:00.000Z", ...changes,
});
type State = { recipes: Array<Record<string, unknown>>; unreadable: string[]; projects: string[]; markerFiles: string[] };
const initial = (recipes: Array<Record<string, unknown>> = [], unreadable: string[] = []): State => ({ recipes, unreadable, projects: ["orders", "billing"], markerFiles: ["package.json", "pyproject.toml"] });
type Handler = (request: ApiRequest) => ApiResponse | undefined | Promise<ApiResponse | undefined>;
const refuse = (status: number, code: string, message: string) => ({ status, body: { error: { code, message } } });

function mount(options: { state?: State; missing?: boolean; role?: "owner" | "admin" | "member"; post?: Handler; get?: Handler; at?: string; theme?: "light" | "dark"; me?: () => ApiResponse | undefined } = {}) {
 const role = options.role ?? "owner";
 const nav = AppNavSchema.parse({ me: { developerId: "a".repeat(64), name: "Priya", orgRole: role }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
 const me = AppMeResponseSchema.parse({ developer: { id: "a".repeat(64), name: "Priya", orgRole: role }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
 let state = options.state ?? initial();
 const f = fakeHost(async request => {
  const path = request.path.split("?")[0];
  if (path === "/v1/app/nav") return { status: 200, body: nav };
  if (path === "/v1/app/me") return options.me?.() ?? { status: 200, body: me };
  if (path === "/v1/app/org/model-selection-policy") return { status: 200, body: companyPolicyRaw() };
  if (path === "/v1/app/org/model-sources") return { status: 200, body: { sources: [], order: ["rovara"] } };
  if (path === PATH && options.missing === true) return refuse(404, "NOT_FOUND", "Not found.");
  if (path === PATH && request.method === "GET") return (await options.get?.(request)) ?? { status: 200, body: state };
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
 return { ...f, ...view, query, posts: () => calls().filter(request => request.method === "POST"), reads: () => calls().filter(request => request.method === "GET" && request.path === PATH) };
}
afterEach(() => { document.body.innerHTML = ""; });
// Re-read one of the page's own G4 reads (the identity read or the recipes read) now.
const refetch = async (f: { query: QueryClient }, part: string) => { await act(async () => { await f.query.refetchQueries({ predicate: q => q.queryKey[0] === "g4" && q.queryKey.includes(part) }); }); };
const RECONNECT_REASON = /Reconnecting; try again when the page is up to date/u;

describe("the link on How we work", () => {
 it("is hidden: the company How we work page shows no Setup recipes card, even when recipes wait (DEC 254zzz113/115/116)", async () => {
  const f = mount({ state: initial([recipe(), recipe({ recipeId: "rcp_" + "3".repeat(20) })]), at: "/app/admin/how-we-work" });
  await screen.findByRole("heading", { name: "Known failing tests" });
  expect(screen.queryByRole("region", { name: "Setup recipes" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Open setup recipes" })).toBeNull();
  expect(f.reads()).toEqual([]);
 });
});

describe("the screen", () => {
 it("tells a member in words and reads nothing", async () => {
  // The administration layout keeps a member out (the rebuilt page holds its own owner/admin check as well, proved in the G4 read-only tests): no recipe is read.
  const f = mount({ role: "member", state: initial([recipe()]) });
  await screen.findByRole("heading", { name: "Administration unavailable" });
  expect(f.reads()).toEqual([]);
  expect(screen.queryByRole("button", { name: "Approve this recipe" })).toBeNull();
 });
 it("says the recipes are not on when the server does not know them", async () => {
  // The shared served-read policy: a 404 means access ended, so the page draws the 4e block (this replaces the old "not turned on" line, DEC 254zzz324).
  mount({ missing: true });
  expect((await screen.findByRole("alert")).textContent).toContain("SETUP-RECIPES-ACCESS-LOST");
 });
 it("shows a waiting recipe with what it runs, and approves exactly the revision and digest it showed", async () => {
  const f = mount({ state: initial([recipe()]) });
  const card = within(await screen.findByRole("region", { name: "Python services" }));
  expect(card.getByText("{repo}: uv sync --frozen")).toBeTruthy();
  expect(card.getByText("{repo}: pytest -q")).toBeTruthy();
  expect(card.getByText("Requested addresses")).toBeTruthy();
  expect(card.getByText("pypi.internal.example.com")).toBeTruthy();
  fireEvent.click(card.getByRole("button", { name: "Approve this recipe" }));
  await screen.findByText("Approved.");
  expect(f.posts()).toHaveLength(1);
  expect(f.posts()[0]!.body).toEqual({ action: "approve", recipeId: "rcp_" + "1".repeat(20), expectedRevision: 1, expectedDigest: "d".repeat(64) });
  expect(f.posts()[0]!.retry).toBe("never");
  await screen.findByText("Any project in the company.");
 });
 it("shows a refusal in the server's words with no sign-in step (owner DEC 254zzz73)", async () => {
  const f = mount({ state: initial([recipe()]), post: () => refuse(403, "REAUTH_REQUIRED", "Sign in again to confirm this company change.") });
  fireEvent.click(await screen.findByRole("button", { name: "Approve this recipe" }));
  await screen.findByText("Sign in again to confirm this company change.");
  expect(screen.queryByRole("button", { name: "Sign in again" })).toBeNull();
  expect(f.host.signIn).not.toHaveBeenCalled();
 });
 it("reads the list again and says so when the recipe changed meanwhile", async () => {
  const f = mount({ state: initial([recipe()]), post: () => refuse(409, "CHANGE_STALE", "That recipe changed. Refresh before continuing.") });
  const button = await screen.findByRole("button", { name: "Approve this recipe" });
  const before = f.reads().length;
  fireEvent.click(button);
  await screen.findByText("That recipe changed. The list was read again; check it and try again.");
  await waitFor(() => expect(f.reads().length).toBeGreaterThan(before));
 });
 it("a write that succeeds and is then followed by a failed re-read says so, keeps the facts, and offers nothing more to send (DEC 324)", async () => {
  let down = false;
  const f = mount({ state: initial([recipe()]), post: () => { down = true;return undefined; }, get: () => down ? refuse(503, "UNAVAILABLE", "Try later.") : undefined });
  const card = within(await screen.findByRole("region", { name: "Python services" }));
  fireEvent.click(card.getByRole("button", { name: "Approve this recipe" }));
  expect((await screen.findByText(/Approved\./u, {}, { timeout: 8000 })).textContent).toContain("Couldn't refresh; reconnecting.");
  expect(f.posts()).toHaveLength(1);
  expect(screen.queryByText(/Nothing was changed/u)).toBeNull();
  expect((await screen.findAllByText(/Updated .* · Reconnecting/u))).toHaveLength(1);
  expect(screen.getByRole("region", { name: "Python services" })).toBeTruthy();
  const again = screen.getByRole("button", { name: "Approve this recipe" });
  expect(again).toHaveProperty("disabled", true);
  fireEvent.click(again);
  expect(f.posts()).toHaveLength(1);
 });
 it("shows the registries the recipe matches on, because they decide who is offered it and the approval pins them", async () => {
  mount({ state: initial([recipe()]) });
  const card = within(await screen.findByRole("region", { name: "Python services" }));
  expect(card.getByText("Package registries that say when it fits")).toBeTruthy();
  expect(card.getByText("registry.internal.example.net")).toBeTruthy();
 });
 it("while the page shows kept facts, Reject, Stop offering, Change who and Remove are disabled too", async () => {
  let down = false;
  const approvedOther = recipe({ recipeId: "rcp_" + "4".repeat(20), label: "Go services", status: "approved", revision: 2, scope: { kind: "company" } });
  const f = mount({ state: initial([recipe(), approvedOther], ["rcp_" + "9".repeat(20)]), post: () => { down = true;return undefined; }, get: () => down ? refuse(503, "UNAVAILABLE", "Try later.") : undefined });
  fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
  await screen.findAllByText(/Updated .* · Reconnecting/u, {}, { timeout: 8000 });
  expect(f.posts()).toHaveLength(1);
  for (const name of ["Reject", "Remove"]) { const button = screen.getByRole("button", { name }); expect(button).toHaveProperty("disabled", true);fireEvent.click(button); }
  fireEvent.click(screen.getByRole("button", { name: "Open Go services" }));
  const card = within(await screen.findByRole("region", { name: "Go services" }));
  for (const name of ["Change who it is offered to", "Stop offering"]) { const button = card.getByRole("button", { name }); expect(button).toHaveProperty("disabled", true);fireEvent.click(button); }
  expect(f.posts()).toHaveLength(1);
 });
 it("the action hook sends one write for two presses in the same moment, and none while the page is frozen", async () => {
  const f = fakeHost(async () => ({ status: 200, body: { status: "done" } })), query = createQueryClient();
  const wrapper = ({ children }: { children: unknown }) => h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: children as never }) });
  const reread = async () => ({ isError: false });
  const live = renderHook(() => useRecipeActions(reread, false), { wrapper });
  await act(async () => { const first = live.result.current.run("one", () => live.result.current.api.removeUnreadable("rcp_" + "9".repeat(20)));const second = live.result.current.run("two", () => live.result.current.api.removeUnreadable("rcp_" + "8".repeat(20)));expect(await second).toBe(false);expect(await first).toBe(true); });
  expect(f.request.mock.calls.filter(([request]) => request.method === "POST")).toHaveLength(1);
  const frozen = renderHook(() => useRecipeActions(reread, true), { wrapper });
  await act(async () => { expect(await frozen.result.current.run("three", () => frozen.result.current.api.removeUnreadable("rcp_" + "7".repeat(20)))).toBe(false); });
  expect(f.request.mock.calls.filter(([request]) => request.method === "POST")).toHaveLength(1);
 });
 it("a 503 on the first read draws the failure block, not the access-ended block", async () => {
  mount({ get: () => refuse(503, "UNAVAILABLE", "Try later.") });
  const alert = await screen.findByRole("alert", {}, { timeout: 8000 });
  expect(alert.textContent).toContain("SETUP-RECIPES-READ-FAILED");
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
  fireEvent.change(form.getByLabelText("Addresses to share"), { target: { value: "pypi.internal.example.com, files.example.com" } });
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
   fireEvent.click(await screen.findByRole("button", { name: "Open Go services" }));
   await screen.findByRole("region", { name: "Go services" });
   await expectNoAxeViolations(view.container);
   view.unmount();
   document.body.innerHTML = "";
  }
 });
});

describe("G4: approving is tied to the recipe whose contents are open", () => {
 it("offers Approve and Reject only on the opened recipe, and Open moves them to the recipe whose commands are then shown", async () => {
  const second = recipe({ recipeId: "rcp_" + "7".repeat(20), label: "Go services", setup: [{ line: "{repo}: go build ./...", timeoutSeconds: 300 }] });
  const f = mount({ state: initial([recipe(), second]) });
  const first = within(await screen.findByRole("region", { name: "Python services" }));
  expect(first.getByText("{repo}: uv sync --frozen")).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "Approve this recipe" })).toHaveLength(1);
  expect(screen.queryByText("{repo}: go build ./...")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open Go services" }));
  const next = within(await screen.findByRole("region", { name: "Go services" }));
  expect(next.getByText("{repo}: go build ./...")).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "Approve this recipe" })).toHaveLength(1);
  fireEvent.click(next.getByRole("button", { name: "Approve this recipe" }));
  await screen.findByText("Approved.");
  expect(f.posts()).toHaveLength(1);
  expect((f.posts()[0]!.body as { recipeId: string }).recipeId).toBe("rcp_" + "7".repeat(20));
 });
 it("a second press while the first is in flight sends nothing more (one write at a time)", async () => {
  let release: (() => void) | undefined;
  const f = mount({ state: initial([recipe()]), post: () => new Promise(resolve => { release = () => resolve({ status: 200, body: { status: "done" } }); }) });
  const button = await screen.findByRole("button", { name: "Approve this recipe" });
  fireEvent.click(button);fireEvent.click(button);
  await waitFor(() => expect(f.posts()).toHaveLength(1));
  fireEvent.click(screen.getByRole("button", { name: "Reject" }));
  expect(f.posts()).toHaveLength(1);
  release?.();
  await screen.findByText("Approved.");
  expect(f.posts()).toHaveLength(1);
 });
 it("a refusal and a stale refusal each send exactly one write and keep the page usable", async () => {
  const f = mount({ state: initial([recipe()]), post: () => refuse(409, "CHANGE_STALE", "That recipe changed. Refresh before continuing.") });
  fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
  await screen.findByText("That recipe changed. The list was read again; check it and try again.");
  expect(f.posts()).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Approve this recipe" })).toHaveProperty("disabled", false);
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
  expect(card.getAllByText(/up to 1800 seconds/u).length).toBeGreaterThan(0);
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
 it("shows a hidden character in a marker file name or repository as a visible mark", async () => {
  panel({ status: 200, body: { repositories: ["or\u202Eders"], markerFiles: ["py\u202Eproject.toml"], hasApprovedEnvironment: true } });
  fireEvent.click(await screen.findByRole("button", { name: "Share as company recipe" }));
  const form = within(await screen.findByRole("form", { name: "Share a project's setup" }));
  expect(form.getByRole("checkbox", { name: "py[U+202E]project.toml" })).toBeTruthy();
  expect(form.getByRole("option", { name: "or[U+202E]ders" })).toBeTruthy();
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

// DEC 324 (retained facts never grant write authority): the fix round for REVIEW-OPUS-804e48de3 F1-F3. Each test names the mutant it kills (MUTANTS.md).
describe("G4 fix round: kept facts and a lost session never leave a write on", () => {
 it("F1: a failed IDENTITY re-read freezes every recipe write (Approve disabled, nothing sent) [mutant: frozen ignores identityStale]", async () => {
  let meDown = false;
  const f = mount({ state: initial([recipe()]), me: () => meDown ? refuse(503, "UNAVAILABLE", "Try later.") : undefined });
  const card = within(await screen.findByRole("region", { name: "Python services" }));
  meDown = true;await refetch(f, "identity");
  await screen.findAllByText(/Updated .* · Reconnecting/u);
  const approve = card.getByRole("button", { name: "Approve this recipe" });
  fireEvent.click(approve);
  await new Promise(resolve => setTimeout(resolve, 50));
  expect({ disabled: (approve as HTMLButtonElement).disabled, posts: f.posts().length }).toEqual({ disabled: true, posts: 0 });
 });
 it("F1: the action hook refuses at send time and says why, whichever control is still clickable [mutant: run does not set the reason]", async () => {
  const f = fakeHost(async () => ({ status: 200, body: { status: "done" } })), query = createQueryClient();
  const wrapper = ({ children }: { children: unknown }) => h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: children as never }) });
  const frozen = renderHook(() => useRecipeActions(async () => ({ isError: false }), true), { wrapper });
  await act(async () => { expect(await frozen.result.current.run("x", () => frozen.result.current.api.removeUnreadable("rcp_" + "7".repeat(20)))).toBe(false); });
  expect(frozen.result.current.error).toMatch(RECONNECT_REASON);
  expect(f.request.mock.calls.filter(([request]) => request.method === "POST")).toHaveLength(0);
 });
 it("F2: Save in the scope editor is disabled while Reconnecting, sends nothing, and says why [mutant: ScopeEditor gets no frozen]", async () => {
  let down = false;
  const f = mount({ state: initial([recipe({ status: "approved", revision: 2 })]), get: () => down ? refuse(503, "UNAVAILABLE", "Try later.") : undefined });
  const card = within(await screen.findByRole("region", { name: "Python services" }));
  fireEvent.click(card.getByRole("button", { name: "Change who it is offered to" }));
  fireEvent.click(card.getByRole("checkbox", { name: "orders" }));
  down = true;await refetch(f, "recipes");
  await screen.findAllByText(/Updated .* · Reconnecting/u);
  const save = card.getByRole("button", { name: "Save" });
  fireEvent.click(save);
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(f.posts()).toHaveLength(0);
  expect((save as HTMLButtonElement).disabled).toBe(true);
  expect(card.queryByText(RECONNECT_REASON)).not.toBeNull();
  expect(card.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(false);
 });
 it("F2: the Share button is disabled while Reconnecting, keeps what was typed, sends nothing and says why [mutant: Share gets no frozen]", async () => {
  let down = false;
  const f = mount({ state: initial(), get: () => down ? refuse(503, "UNAVAILABLE", "Try later.") : undefined });
  const form = within(await screen.findByRole("form", { name: "Share a project's setup" }));
  fireEvent.change(form.getByLabelText("Project"), { target: { value: "orders" } });
  fireEvent.change(form.getByLabelText("Repository"), { target: { value: "orders-api" } });
  fireEvent.change(form.getByLabelText("Recipe name"), { target: { value: "Python services" } });
  fireEvent.change(form.getByLabelText("Build systems"), { target: { value: "python" } });
  fireEvent.click(form.getByRole("checkbox", { name: "pyproject.toml" }));
  down = true;await refetch(f, "recipes");
  await screen.findAllByText(/Updated .* · Reconnecting/u);
  const button = form.getByRole("button", { name: "Share as company recipe" });
  const wasDisabled = button.hasAttribute("disabled");
  fireEvent.click(button);
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(f.posts()).toHaveLength(0);
  expect({ wasDisabled, reason: form.queryByText(RECONNECT_REASON) !== null, typed: form.getByLabelText<HTMLInputElement>("Recipe name").value }).toEqual({ wasDisabled: true, reason: true, typed: "Python services" });
 });
 it.each([[403, "ACCESS_DENIED"], [404, "NOT_FOUND"]] as const)("F3: a write goes through, then the re-read answers %i: the access-lost block says the change went through, never 'reconnecting', 'Nothing was changed' or 'only reads' [mutants: reconnect note kept on access loss; default safe line restored]", async (status, code) => {
  let gone = false;
  const f = mount({ state: initial([recipe()]), post: () => { gone = true;return undefined; }, get: () => gone ? refuse(status, code, "No access.") : undefined });
  fireEvent.click(await screen.findByRole("button", { name: "Approve this recipe" }));
  await screen.findByText(/SETUP-RECIPES-ACCESS-LOST/u, {}, { timeout: 8000 });
  expect(f.posts()).toHaveLength(1);
  expect(screen.getByText(/Approved\./u).textContent).toBe("Approved.");
  const block = screen.getByRole("alert", { name: /couldn.t read this page/u });
  expect(within(block).getByText("Your change went through.")).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/Nothing was changed|only reads|reconnecting/iu);
 });
 it("F3: a read that fails with no write behind it never claims a change went through, nor that the page only reads", async () => {
  mount({ get: () => refuse(403, "ACCESS_DENIED", "No access.") });
  const block = await screen.findByRole("alert", { name: /couldn.t read this page/u }, { timeout: 8000 });
  expect(block.textContent).toContain("Rovara couldn’t read this page.");
  expect(block.textContent).not.toMatch(/went through|only reads/u);
 });
 it("F3: a stale refusal only says the list was read again when that re-read worked [mutant: STALE said unconditionally]", async () => {
  let stale = false;
  const f = mount({ state: initial([recipe()]), post: () => { stale = true;return refuse(409, "CHANGE_STALE", "Changed."); }, get: () => stale ? refuse(503, "UNAVAILABLE", "Try later.") : undefined });
  fireEvent.click(await screen.findByRole("button", { name: "Approve this recipe" }));
  await screen.findByText("That recipe changed. Couldn't read the list again; reconnecting.", {}, { timeout: 8000 });
  expect(f.posts()).toHaveLength(1);
  expect(screen.queryByText(/The list was read again/u)).toBeNull();
 });
});
