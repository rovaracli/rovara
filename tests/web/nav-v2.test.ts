// @vitest-environment jsdom
import { expect, it, describe } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, type AppNav } from "@agentx/cloud-contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { NAV_STORAGE_KEY, isNewNavOn } from "../../packages/ui/src/nav-flags.js";
import { currentDestination, destinationsFor } from "../../packages/ui/src/shell/destinations.js";
import { SIDEBAR_PROJECT_LIMIT } from "../../packages/ui/src/shell/NavV2.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
const features = { localAgents: true, usage: false, admin: false, chains: false, notices: false, describe: false };
const agent = (n: number, name: string, running = 0, needsYou = 0) => ({ agentId: "agt_" + String(n).repeat(20), name, running, needsYou });
const base = { me: { developerId: "a".repeat(64), name: "Priya", orgRole: "member" }, org: { name: "Acme" }, homeCount: 3, projects: [{ name: "payments", agents: [agent(1, "Payments expert", 1, 1), agent(2, "Refund helper", 2, 0)] }, { name: "search", agents: [agent(1, "Payments expert")] }], shared: { agents: [], sessions: [] }, features };
const nav = (overrides: Record<string, unknown> = {}): AppNav => AppNavSchema.parse({ ...base, ...overrides });
const withRole = (orgRole: string, extra: Partial<AppNav["features"]> = {}) => nav({ me: { ...base.me, orgRole }, features: { ...features, ...extra } });
function shell(path: string, options: { on?: boolean; value?: AppNav; theme?: "light" | "dark" } = {}) {
 const value = options.value ?? nav(), f = fakeHost(async () => ({ status: 200, body: value })), query = createQueryClient();query.setQueryData(["nav"], value);
 f.host.storage.set("rovara.theme", options.theme ?? "light");if (options.on === true) f.host.storage.set(NAV_STORAGE_KEY, "v2");
 const router = createMemoryRouter(appRoutes(value.features, { newNav: isNewNavOn(f.host) }), { initialEntries: [path] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 return { ...ui, ...f, query, router, close: () => { ui.unmount();router.dispose();query.clear(); } };
}
const sidebar = () => within(screen.getByRole("navigation", { name: "Workspace" }));
const tabBar = () => within(screen.getByRole("navigation", { name: "Main destinations" }));
const names = (scope: { getAllByRole(role: string): HTMLElement[] }) => scope.getAllByRole("link").map(link => link.textContent);
describe("the switch", () => {
 const host = (value?: string) => ({ storage: { get: () => value, set: () => undefined } });
 it("is off unless the device key is exactly v2", () => {
  expect(NAV_STORAGE_KEY).toBe("rovara.nav");
  expect(isNewNavOn(host())).toBe(false);for (const value of ["", "v1", "V2", "true", "1", "v2 "]) expect(isNewNavOn(host(value))).toBe(false);
  expect(isNewNavOn(host("v2"))).toBe(true);
 });
 it("is off when the store throws", () => { expect(isNewNavOn({ storage: { get: () => { throw new Error("blocked"); }, set: () => undefined } })).toBe(false); });
});
describe("destinations", () => {
 const ids = (value: AppNav) => destinationsFor(value).map(destination => destination.id);
 it("are Home, Work, Projects, Agents, Settings for every role, and never Insights", () => {
  for (const role of ["owner", "admin", "member", "auditor"]) for (const admin of [false, true]) expect(ids(withRole(role, { admin }))).toEqual(["home", "work", "projects", "agents", "settings"]);
 });
 it("sends Settings to company settings for owners and admins when the install has them, and to the person's own account page otherwise", () => {
  const settings = (value: AppNav) => destinationsFor(value).find(destination => destination.id === "settings")?.to;
  expect(settings(withRole("owner", { admin: true }))).toBe("/app/admin");expect(settings(withRole("admin", { admin: true }))).toBe("/app/admin");
  expect(settings(withRole("admin", { admin: false }))).toBe("/app/account");expect(settings(withRole("member", { admin: true }))).toBe("/app/account");expect(settings(withRole("auditor", { admin: true }))).toBe("/app/account");
 });
 it("carry the needs-you count on Home only", () => { expect(destinationsFor(nav()).map(destination => destination.count)).toEqual([3, undefined, undefined, undefined, undefined]); });
 it("map each page to its destination", () => {
  const cases: Array<[string, string | undefined]> = [["/app", "home"], ["/app/", "home"], ["/app/work", "work"], ["/app/live", "work"], ["/app/sessions/ses_x", "work"], ["/app/projects", "projects"], ["/app/projects/payments", "projects"], ["/app/agents", "agents"], ["/app/agents/agt_x", "agents"], ["/app/admin", "settings"], ["/app/admin/people", "settings"], ["/app/account", "settings"], ["/app/settings/script-tokens", "settings"], ["/app/usage", undefined], ["/app/onboard", undefined], ["/app/projectsfoo", undefined]];
  for (const [path, id] of cases) expect(currentDestination(path), path).toBe(id);
 });
});
describe("switch off", () => {
 it("renders today's shell: Live, repeated agents, Agent directory, no tab bar, no new classes", async () => {
  const f = shell("/app");await screen.findByRole("heading", { name: "Home", level: 1 });
  const links = names(sidebar());expect(links).toContain("Live");expect(links).toContain("Agent directory");expect(links).not.toContain("Work");
  expect(screen.getAllByRole("link", { name: /Payments expert/u }).length).toBeGreaterThan(0);
  expect(screen.queryByRole("navigation", { name: "Main destinations" })).toBeNull();expect(document.querySelector(".rv-tabbar, .rv-nav-v2, .rv-sidebar-nav-v2")).toBeNull();
  expect(document.querySelector(".rv-app-shell")?.className).toBe("rv-app-shell");f.close();
 });
 it("keeps /app/live as Live, with no Work or Projects list route", async () => {
  const f = shell("/app/live?filter=needs_me");await screen.findByRole("heading", { name: "Live", level: 1 });expect(f.router.state.location.pathname).toBe("/app/live");expect(f.router.state.location.search).toBe("?filter=needs_me");f.close();
  for (const path of ["/app/work", "/app/projects"]) { const g = shell(path);expect(await screen.findByText("We couldn't find that. It may not exist, or it hasn't been shared with you.")).toBeTruthy();expect(g.router.state.location.pathname).toBe(path);g.close(); }
 });
 it("has the same top-level route paths as before, plus nothing", () => {
  const paths = (routes: ReturnType<typeof appRoutes>) => routes.flatMap(route => route.children ?? []).map(route => route.path ?? "(index)");
  const off = paths(appRoutes(features)), explicitOff = paths(appRoutes(features, { newNav: false }));
  expect(explicitOff).toEqual(off);expect(off).toContain("live");expect(off).not.toContain("work");expect(off).not.toContain("projects");
 });
 it("still sends an old /s/<id> link to the task page, and opens /app/sessions/<id>", async () => {
  const f = shell("/s/ses_aaaaaaaaaaaaaaaaaaaa?x=1#plan");await waitFor(() => expect(f.router.state.location.pathname).toBe("/app/sessions/ses_aaaaaaaaaaaaaaaaaaaa"));expect(f.router.state.location.search).toBe("?x=1");expect(f.router.state.location.hash).toBe("#plan");f.close();
 });
});
describe("switch on", () => {
 it("lists Home, Work, Projects, Agents, Settings once each, in that order, in the sidebar", async () => {
  const f = shell("/app", { on: true });await screen.findByRole("heading", { name: "Home", level: 1 });
  const links = sidebar().getAllByRole("link");
  expect(links.slice(0, 5).map(link => link.textContent)).toEqual(["Home3", "Work", "Projects", "Agents", "Settings"]);
  expect(links.slice(0, 5).map(link => link.getAttribute("href"))).toEqual(["/app", "/app/work", "/app/projects", "/app/agents", "/app/account"]);
  for (const label of ["Work", "Projects", "Agents", "Settings"]) expect(sidebar().getAllByRole("link", { name: label })).toHaveLength(1);
  expect(sidebar().queryByRole("link", { name: "Live" })).toBeNull();expect(sidebar().queryByRole("link", { name: "Agent directory" })).toBeNull();expect(sidebar().queryByRole("link", { name: /Insights/u })).toBeNull();
  expect(document.querySelector(".rv-app-shell")?.className).toBe("rv-app-shell rv-nav-v2");f.close();
 });
 it("names Home with the needs-you count, and says nothing when nothing needs the person", async () => {
  const f = shell("/app", { on: true });await screen.findByRole("heading", { name: "Home", level: 1 });
  expect(sidebar().getByRole("link", { name: "Home, 3 need you" })).toBeTruthy();expect(tabBar().getByRole("link", { name: "Home, 3 need you" })).toBeTruthy();f.close();
  const one = shell("/app", { on: true, value: nav({ homeCount: 1 }) });await screen.findByRole("heading", { name: "Home", level: 1 });expect(sidebar().getByRole("link", { name: "Home, 1 needs you" })).toBeTruthy();one.close();
  const none = shell("/app", { on: true, value: nav({ homeCount: 0 }) });await screen.findByRole("heading", { name: "Home", level: 1 });expect(sidebar().getByRole("link", { name: "Home" })).toBeTruthy();expect(document.querySelectorAll(".rv-nav-count")).toHaveLength(0);none.close();
 });
 it("shows each project once as a plain link with no agents under it", async () => {
  const f = shell("/app", { on: true });await screen.findByRole("heading", { name: "Home", level: 1 });
  expect(sidebar().getByRole("link", { name: "payments" }).getAttribute("href")).toBe("/app/projects/payments");expect(sidebar().getByRole("link", { name: "search" })).toBeTruthy();
  // Positive control: the answer does carry agents, and the old sidebar would have linked them.
  expect(nav().projects.flatMap(project => project.agents)).toHaveLength(3);
  expect(screen.queryByRole("link", { name: /Payments expert|Refund helper/u })).toBeNull();expect(document.querySelectorAll('a[href^="/app/agents/"]')).toHaveLength(0);
  expect(document.querySelector(".rv-nav-agent, .rv-nav-agent-status")).toBeNull();
  expect(sidebar().getAllByRole("link").filter(link => link.getAttribute("href") === "/app/agents")).toHaveLength(1);f.close();
 });
 it("caps the project links and points to the Projects page for the rest", async () => {
  const projects = Array.from({ length: 12 }, (_, index) => ({ name: "project-" + String(index + 1), agents: [] }));
  const f = shell("/app", { on: true, value: nav({ projects }) });await screen.findByRole("heading", { name: "Home", level: 1 });
  expect(sidebar().getAllByRole("link", { name: /^project-/u })).toHaveLength(SIDEBAR_PROJECT_LIMIT);expect(sidebar().getByRole("link", { name: "See all 12 projects" }).getAttribute("href")).toBe("/app/projects");f.close();
 });
 it("keeps shared work and the tools that have no destination yet", async () => {
  const f = shell("/app", { on: true, value: nav({ shared: { agents: [{ agentId: "agt_" + "7".repeat(20), name: "Shared helper" }], sessions: [] }, features: { ...features, usage: true, scriptTokens: true } }) });await screen.findByRole("heading", { name: "Home", level: 1 });
  for (const label of ["Shared helper", "Onboard a project", "Script tokens", "Usage"]) expect(sidebar().getByRole("link", { name: label })).toBeTruthy();f.close();
 });
 it("shows Waiting for people only to owners and admins of an install with company settings, not to members or auditors", async () => {
  for (const [role, admin, shown] of [["owner", true, true], ["admin", true, true], ["admin", false, false], ["member", true, false], ["member", false, false], ["auditor", true, false]] as const) {
   const f = shell("/app", { on: true, value: withRole(role, { admin }) });await screen.findByRole("heading", { name: "Home", level: 1 });
   // The test host says admin is on for everyone (as the browser host does), so only the person's role and the install's switch can hide the link.
   expect(f.host.features.admin).toBe(true);
   const link = sidebar().queryByRole("link", { name: "Waiting for people" });expect(link !== null, `${role} admin=${String(admin)}`).toBe(shown);if (link !== null) expect(link.getAttribute("href")).toBe("/app/admin/waiting");
   f.close();
  }
 });
 it("leaves the old sidebar's Waiting for people link as it was (switch off)", async () => {
  const f = shell("/app", { value: withRole("member", { admin: true }) });await screen.findByRole("heading", { name: "Home", level: 1 });expect(sidebar().getByRole("link", { name: "Waiting for people" })).toBeTruthy();f.close();
 });
 it("lists the same five destinations in the phone tab bar, in order, with the current one marked", async () => {
  const f = shell("/app/projects", { on: true });await screen.findByRole("heading", { name: "Projects", level: 1 });
  expect(names(tabBar())).toEqual(["Home3", "Work", "Projects", "Agents", "Settings"]);
  expect(tabBar().getAllByRole("link").filter(link => link.getAttribute("aria-current") === "page").map(link => link.textContent)).toEqual(["Projects"]);
  expect(sidebar().getAllByRole("link").filter(link => link.getAttribute("aria-current") === "page").map(link => link.textContent)).toEqual(["Projects", "payments", "search"].slice(0, 1));
  f.close();
 });
 it("marks Work current on a work item, and the project link current on its own page", async () => {
  const w = shell("/app/sessions/ses_aaaaaaaaaaaaaaaaaaaa", { on: true });await waitFor(() => expect(tabBar().getByRole("link", { name: "Work" }).getAttribute("aria-current")).toBe("page"));w.close();
  const p = shell("/app/projects/payments", { on: true });await waitFor(() => expect(sidebar().getByRole("link", { name: "payments" }).getAttribute("aria-current")).toBe("page"));expect(tabBar().getByRole("link", { name: "Projects" }).getAttribute("aria-current")).toBe("page");p.close();
 });
 it("has a first-in-order skip link to the main landmark, and focuses the new page's heading on a move", async () => {
  const f = shell("/app", { on: true });await screen.findByRole("heading", { name: "Home", level: 1 });
  const skip = screen.getByRole("link", { name: "Skip to main content" });expect(skip.getAttribute("href")).toBe("#main");expect(document.querySelector("main")?.id).toBe("main");
  const order = [...document.querySelectorAll<HTMLElement>("a, button")];expect(order[0]).toBe(skip);
  const landmarks = [...document.querySelectorAll(".rv-app-shell > header, .rv-app-shell > aside, .rv-app-shell > main, .rv-app-shell nav")].filter(node => node.tagName === "MAIN" || !node.closest("main")).map(node => node.tagName + (node.getAttribute("aria-label") ?? ""));expect(landmarks).toEqual(["HEADER", "ASIDE", "NAVWorkspace", "MAIN", "NAVMain destinations"]);
  fireEvent.click(sidebar().getByRole("link", { name: "Projects" }));await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Projects", level: 1 })));f.close();
 });
 it("opens Work from the sidebar and keeps the Menu working", async () => {
  const f = shell("/app", { on: true });await screen.findByRole("heading", { name: "Home", level: 1 });
  fireEvent.click(sidebar().getByRole("link", { name: "Work" }));await waitFor(() => expect(f.router.state.location.pathname).toBe("/app/work"));await screen.findByRole("heading", { name: "Live", level: 1 });
  const menu = screen.getByRole("button", { name: "Open workspace menu" });fireEvent.click(menu);const dialog = await screen.findByRole("dialog", { name: "Workspace" });
  expect(within(dialog).getAllByRole("link").slice(0, 5).map(link => link.textContent)).toEqual(["Home3", "Work", "Projects", "Agents", "Settings"]);
  fireEvent.click(within(dialog).getByRole("link", { name: "Projects" }));await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());await waitFor(() => expect(f.router.state.location.pathname).toBe("/app/projects"));f.close();
 });
 it("sends /app/live to /app/work, keeping the filters and the hash", async () => {
  for (const [from, to, search, hash] of [["/app/live", "/app/work", "", ""], ["/app/live?filter=needs_me&project=payments", "/app/work", "?filter=needs_me&project=payments", ""], ["/app/live?filter=team#top", "/app/work", "?filter=team", "#top"]] as const) {
   const f = shell(from, { on: true });await waitFor(() => expect(f.router.state.location.pathname).toBe(to));expect(f.router.state.location.search).toBe(search);expect(f.router.state.location.hash).toBe(hash);await screen.findByRole("heading", { name: "Live", level: 1 });f.close();
  }
 });
 it("renders the existing Live screen at /app/work", async () => {
  const f = shell("/app/work?filter=needs_me", { on: true });expect(await screen.findByRole("heading", { name: "Live", level: 1 })).toBeTruthy();expect(f.router.state.location.pathname).toBe("/app/work");expect(f.request.mock.calls.some(([request]) => request.path === "/v1/app/live?filter=needs_me")).toBe(true);f.close();
 });
 it("keeps every old address working: /s/<id>, /app/sessions/<id>, /app/agents, project pages, chains and unknown pages", async () => {
  const s = shell("/s/ses_aaaaaaaaaaaaaaaaaaaa?x=1#plan", { on: true });await waitFor(() => expect(s.router.state.location.pathname).toBe("/app/sessions/ses_aaaaaaaaaaaaaaaaaaaa"));expect(s.router.state.location.search).toBe("?x=1");expect(s.router.state.location.hash).toBe("#plan");s.close();
  const t = shell("/app/sessions/ses_aaaaaaaaaaaaaaaaaaaa", { on: true });await waitFor(() => expect(t.router.state.location.pathname).toBe("/app/sessions/ses_aaaaaaaaaaaaaaaaaaaa"));// The session page is a lazy route: the shell appears once its chunk has loaded, which is slow on a cold run, so wait for it.
  expect(await screen.findByRole("link", { name: "Skip to main content" })).toBeTruthy();t.close();
  const c = shell("/app/chains", { on: true });await screen.findByRole("heading", { name: "This isn't available", level: 1 });expect(c.router.state.location.pathname).toBe("/app/chains");c.close();
  const p = shell("/app/projects/payments", { on: true });await waitFor(() => expect(sidebar().getByRole("link", { name: "payments" }).getAttribute("aria-current")).toBe("page"));expect(p.router.state.location.pathname).toBe("/app/projects/payments");p.close();
  const u = shell("/app/usage", { on: true });expect(await screen.findByText("We couldn't find that. It may not exist, or it hasn't been shared with you.")).toBeTruthy();u.close();
 });
 it("lists the projects once on the Projects page, with what needs the person, and no agents", async () => {
  const f = shell("/app/projects", { on: true });await screen.findByRole("heading", { name: "Projects", level: 1 });
  const main = within(screen.getByRole("main"));expect(main.getAllByRole("link").map(link => link.getAttribute("href"))).toEqual(["/app/projects/payments", "/app/projects/search"]);
  expect(main.getByRole("link", { name: /payments/u }).textContent).toContain("1 needs you");expect(main.getByRole("link", { name: /payments/u }).textContent).toContain("3 running");
  expect(main.getByRole("link", { name: /search/u }).textContent).toBe("search");expect(main.queryByText(/Payments expert|Refund helper/u)).toBeNull();f.close();
  const empty = shell("/app/projects", { on: true, value: nav({ projects: [] }) });expect(await screen.findByRole("heading", { name: "No projects yet" })).toBeTruthy();expect(within(screen.getByRole("main")).getByRole("link", { name: "Onboard a project" }).getAttribute("href")).toBe("/app/onboard");empty.close();
 });
 for (const theme of ["light", "dark"] as const) it("has no automated accessibility violations in " + theme, async () => { const f = shell("/app", { on: true, theme });await screen.findByRole("heading", { name: "Home" });await expectNoAxeViolations(f.container);f.close(); });
 it("adds the new routes only with the switch on", () => {
  const paths = (routes: ReturnType<typeof appRoutes>) => routes.flatMap(route => route.children ?? []).map(route => route.path ?? "(index)");
  const on = paths(appRoutes(features, { newNav: true }));expect(on).toEqual(expect.arrayContaining(["live", "work", "projects", "projects/:name"]));
 });
});
