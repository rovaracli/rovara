// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, type AppNav } from "@agentx/cloud-contracts/web";
import { ApiError } from "../../packages/ui/src/api/errors.js";
import { App } from "../../packages/ui/src/App.js";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { TrialBanner } from "../../packages/ui/src/shell/TrialBanner.js";
import { PageError } from "../../packages/ui/src/shell/ErrorBoundary.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
const features = { localAgents: true, usage: false, admin: false, chains: false, notices: false, describe: false };
const nav: AppNav = AppNavSchema.parse({ me: { developerId: "a".repeat(64), name: "Priya", orgRole: "member" }, org: { name: "Acme" }, homeCount: 3, projects: [{ name: "payments", agents: [{ agentId: "agt_aaaaaaaaaaaaaaaaaaaa", name: "Payments expert", running: 1, needsYou: 1 }] }], shared: { agents: [], sessions: [] }, features });
function shell(path = "/app", theme: "light" | "dark" = "light", value: AppNav = nav, state?: unknown) {
 const f = fakeHost(async () => ({ status: 200, body: value })), query = createQueryClient();query.setQueryData(["nav"], value);
 f.host.storage.set("rovara.theme", theme);
 const router = createMemoryRouter(appRoutes(value.features), { initialEntries: [state === undefined ? path : { pathname: path, state }] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 return { ...ui, ...f, query, router, close: () => { ui.unmount();router.dispose();query.clear(); } };
}
it("renders the one navigation (decision 125): the destinations in order with the needs-you count, and the person's projects", async () => {
 const f = shell();await screen.findByRole("heading", { name: "Home", level: 1 });
 const sidebar = screen.getAllByRole("navigation", { name: "Workspace" })[0]!;
 expect(sidebar.closest(".rv-app-shell")?.classList.contains("rv-nav-v2")).toBe(true);
 expect(screen.getAllByRole("link", { name: "Home, 3 need you" }).length).toBeGreaterThan(0);
 const links = [...sidebar.querySelectorAll(".rv-sidebar-primary a")].map(link => link.textContent?.replace(/\d+$/u, ""));
 expect(links).toEqual(["Home", "Work", "Projects", "Agents", "Settings"]);
 expect(screen.getAllByRole("link", { name: "payments" }).length).toBeGreaterThan(0);
 expect(screen.queryByRole("link", { name: "Live" })).toBeNull();expect(screen.queryByRole("link", { name: "Usage" })).toBeNull();expect(screen.queryByRole("link", { name: "Admin" })).toBeNull();
 expect(screen.getByRole("navigation", { name: "Main destinations" })).toBeTruthy();f.close();
});
it("omits disabled routes and shows the exact not-found copy", async () => {
 const f = shell("/app/usage");expect(await screen.findByText("We couldn't find that. It may not exist, or it hasn't been shared with you.")).toBeTruthy();f.close();
});
// exp/automations: this was "even when the chains switch is on". The switch now opens the chain page (tests/web/automations-gate.test.ts); while it is off the links still say this.
it("shows \"This isn't available\" with a link home for old chain and trigger links while the chains switch is off", async () => {
 for (const path of ["/app/chains", "/app/chains/chn_aaaaaaaaaaaaaaaaaaaa", "/app/triggers/trg_aaaaaaaaaaaaaaaaaaaa"]) {
  const f = shell(path, "light", { ...nav, features: { ...features, chains: false } });
  expect((await screen.findByRole("heading", { name: "This isn't available", level: 1 })).textContent).toBe("This isn't available");
  expect(screen.getByRole("link", { name: "Go to Home" }).getAttribute("href")).toBe("/app");expect(screen.queryByText("We couldn't find that. It may not exist, or it hasn't been shared with you.")).toBeNull();
  expect(screen.queryByRole("link", { name: /chain|trigger/i })).toBeNull();f.close();
 }
});
it("does not call an API for signup or signed out routes", async () => {
 for (const path of ["/app/signup", "/app/signed-out"]) { const f = shell(path);await screen.findByRole("heading", { level: 1 });expect(f.request).not.toHaveBeenCalled();expect(screen.queryByRole("navigation", { name: "Workspace" })).toBeNull();f.close(); }
});
it("focuses the new heading on a route change", async () => {
 const f = shell();await screen.findByRole("heading", { name: "Home" });fireEvent.click(within(screen.getAllByRole("navigation", { name: "Workspace" })[0]!).getByRole("link", { name: "Work" }));await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Work", level: 1 })));f.close();
});
it("follows a project link in the sidebar from an agent page whose profile tray is open", async () => {
 // Opened from the directory, an agent's profile is a tray over the page. It must not take the click meant for the sidebar (it used to close itself and go back instead).
 const f = shell("/app/agents/rovara-code", "light", nav, { fromDirectory: true });
 expect(await screen.findByRole("dialog")).toBeTruthy();
 await userEvent.setup().click(screen.getByRole("link", { name: "payments" }));
 await waitFor(() => expect(f.router.state.location.pathname).toBe("/app/projects/payments"));
 f.close();
});
it("opens the workspace menu and returns focus when it closes", async () => {
 const f = shell();await screen.findByRole("heading", { name: "Home" });const menu = screen.getByRole("button", { name: "Open workspace menu" });menu.focus();fireEvent.click(menu);
 expect(await screen.findByRole("dialog", { name: "Workspace" })).toBeTruthy();const ids = [...document.querySelectorAll("[id]")].map(element => element.id);expect(new Set(ids).size).toBe(ids.length);fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());await waitFor(() => expect(document.activeElement).toBe(menu));f.close();
});
it("signs out through the host and begins a deliberate sign in", async () => {
 const f = shell();await screen.findByRole("heading", { name: "Home" });fireEvent.click(screen.getByRole("button", { name: "Open account menu" }));fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
 await waitFor(() => expect(f.host.signIn).toHaveBeenCalledWith("/app"));expect(f.host.signOut).toHaveBeenCalledTimes(1);f.close();
});
it("uses exact trial guidance", () => {
 const f = fakeHost();const { unmount } = renderUi(h(AppHostProvider, { host: f.host, children: h(MemoryRouter, { children: h(TrialBanner, { state: "locked" }) }) }));expect(screen.getByText("Connect GitHub to start your free trial.")).toBeTruthy();expect(screen.getByRole("link", { name: "Connect GitHub" }).getAttribute("href")).toBe("/app/onboard");unmount();
 const other = renderUi(h(AppHostProvider, { host: f.host, children: h(MemoryRouter, { children: h(TrialBanner, { state: "github_used" }) }) }));expect(screen.getByText("This GitHub account already started a free trial for another organization. Connect a different GitHub account, or ask us about a plan.")).toBeTruthy();other.unmount();
});
it("distinguishes a failed chunk import from another page error", () => {
 const first = renderUi(h(PageError, { error: new TypeError("Failed to fetch dynamically imported module") }));expect(screen.getByText("Rovara was updated. Reload to continue.")).toBeTruthy();expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();first.unmount();
 const second = renderUi(h(PageError, { error: new Error("private upstream text") }));expect(screen.getByText("Something went wrong on this page.")).toBeTruthy();expect(screen.queryByText("private upstream text")).toBeNull();second.unmount();
});
for (const theme of ["light", "dark"] as const) it("has no automated accessibility violations in " + theme, async () => { const f = shell("/app", theme);await screen.findByRole("heading", { name: "Home" });await expectNoAxeViolations(f.container);f.close(); });
it("marks admin routes web-only and does not add them when the server disables admin", () => {
 const routes = appRoutes({ ...features, admin: true, usage: true });const children = routes.flatMap(route => route.children ?? []);expect(children.find(route => route.path === "admin/*")?.handle).toEqual({ webOnly: true });expect(appRoutes(features).flatMap(route => route.children ?? []).some(route => route.path === "admin/*")).toBe(false);
});

it("starts signup without navigation reads and welcome with only a me read", async () => {
 for (const path of ["/app/signup", "/app/signup/", "/app/welcome", "/app/welcome/"]) {
 const f = fakeHost(async () => ({ status: 200, body: { developer: { id: "a".repeat(64), name: "Priya", orgRole: "member" }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] } }));
 const navigation=vi.fn<(url:string)=>void>();f.host.navigate=navigation;
 f.host.currentPath = () => path;
 const mounted = renderUi(h(App, { host: f.host, createRouter: routes => createMemoryRouter(routes, { initialEntries: [path] }) }));
 if(path.startsWith("/app/signup")) await screen.findByRole("heading", { name: "Start with Rovara" });else await waitFor(()=>expect(navigation).toHaveBeenCalledWith("/app"));
 expect(f.request.mock.calls.map(([request]) => request.path)).toEqual(path.startsWith("/app/signup") ? [] : ["/v1/app/me"]);mounted.unmount();
 }
});

it("preserves the server refusal message on a failed page", () => { const f = renderUi(h(PageError, { error: new ApiError(403, "FORBIDDEN", "Ask the project owner to restore your access.") }));expect(screen.getByText("Ask the project owner to restore your access.")).toBeTruthy();f.unmount(); });
it("sends an older /s/<id> link to the task's one address, keeping its query and tab (UX2 slice 2)", async () => {
 const f = shell("/s/ses_aaaaaaaaaaaaaaaaaaaa?decision=approve_plan:x#plan");
 await waitFor(() => expect(f.router.state.location.pathname).toBe("/app/sessions/ses_aaaaaaaaaaaaaaaaaaaa"));
 expect(f.router.state.location.search).toBe("?decision=approve_plan:x");expect(f.router.state.location.hash).toBe("#plan");
 f.close();
});
it("keeps a hostile /s/ id under /app/sessions/ (review: no open redirect)", async () => {
 for (const id of ["..%2F..%2Fapp%2Fadmin", "%2F%2Fevil.example", "ses_x%3Fq%3D1"]) {
  const f = shell("/s/" + id);
  await waitFor(() => expect(f.router.state.location.pathname.startsWith("/app/sessions/")).toBe(true));
  expect(f.router.state.location.pathname.split("/").filter(part => part !== "")).toHaveLength(3);
  expect(f.router.state.location.pathname).not.toMatch(/\/\/|evil\.example\/|\/app\/admin/u);
  f.close();
 }
});
