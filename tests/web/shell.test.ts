// @vitest-environment jsdom
import { expect, it } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, type AppNav } from "@agentx/contracts/web";
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
function shell(path = "/app", theme: "light" | "dark" = "light", value: AppNav = nav) {
 const f = fakeHost(async () => ({ status: 200, body: value })), query = createQueryClient();query.setQueryData(["nav"], value);
 f.host.storage.set("rovara.theme", theme);
 const router = createMemoryRouter(appRoutes(value.features), { initialEntries: [path] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 return { ...ui, ...f, query, router, close: () => { ui.unmount();router.dispose();query.clear(); } };
}
it("renders an ordered readable sidebar with waiting counts and status words", async () => {
 const f = shell();await screen.findByRole("heading", { name: "Home", level: 1 });
 expect(screen.getByRole("link", { name: "Home, 3 waiting" })).toBeTruthy();expect(screen.getByText("1 running")).toBeTruthy();expect(screen.getByText("1 needs you")).toBeTruthy();
 const links = [...screen.getByRole("navigation", { name: "Workspace" }).querySelectorAll("a")].map(link => link.textContent);
 expect(links.indexOf("Live")).toBeGreaterThan(links.findIndex(text => text?.startsWith("Home")));expect(screen.queryByRole("link", { name: "Usage" })).toBeNull();expect(screen.queryByRole("link", { name: "Admin" })).toBeNull();f.close();
});
it("omits disabled routes and shows the exact not-found copy", async () => {
 const f = shell("/app/usage");expect(await screen.findByText("We couldn't find that. It may not exist, or it hasn't been shared with you.")).toBeTruthy();f.close();
});
it("does not call an API for signup or signed out routes", async () => {
 for (const path of ["/app/signup", "/app/signed-out"]) { const f = shell(path);await screen.findByRole("heading", { level: 1 });expect(f.request).not.toHaveBeenCalled();expect(screen.queryByRole("navigation", { name: "Workspace" })).toBeNull();f.close(); }
});
it("focuses the new heading on a route change", async () => {
 const f = shell();await screen.findByRole("heading", { name: "Home" });fireEvent.click(screen.getByRole("link", { name: "Live" }));await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Live" })));f.close();
});
it("opens the workspace menu and returns focus when it closes", async () => {
 const f = shell();await screen.findByRole("heading", { name: "Home" });const menu = screen.getByRole("button", { name: "Open workspace menu" });fireEvent.click(menu);
 expect(await screen.findByRole("dialog", { name: "Workspace" })).toBeTruthy();fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());f.close();
});
it("signs out through the host and begins a deliberate sign in", async () => {
 const f = shell();await screen.findByRole("heading", { name: "Home" });fireEvent.click(screen.getByRole("button", { name: "Open account menu" }));fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
 await waitFor(() => expect(f.host.signIn).toHaveBeenCalledWith("/app"));expect(f.host.signOut).toHaveBeenCalledTimes(1);f.close();
});
it("uses exact trial guidance", () => {
 const f = fakeHost();const { unmount } = renderUi(h(AppHostProvider, { host: f.host, children: h(TrialBanner, { state: "locked" }) }));expect(screen.getByText("Connect GitHub to start your free trial.")).toBeTruthy();unmount();
 const other = renderUi(h(AppHostProvider, { host: f.host, children: h(TrialBanner, { state: "github_used" }) }));expect(screen.getByText("This GitHub account already started a free trial for another organization. Connect a different GitHub account, or ask us about a plan.")).toBeTruthy();other.unmount();
});
it("distinguishes a failed chunk import from another page error", () => {
 const first = renderUi(h(PageError, { error: new TypeError("Failed to fetch dynamically imported module") }));expect(screen.getByText("Rovara was updated. Reload to continue.")).toBeTruthy();expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();first.unmount();
 const second = renderUi(h(PageError, { error: new Error("private upstream text") }));expect(screen.getByText("Something went wrong on this page.")).toBeTruthy();expect(screen.queryByText("private upstream text")).toBeNull();second.unmount();
});
for (const theme of ["light", "dark"] as const) it("has no automated accessibility violations in " + theme, async () => { const f = shell("/app", theme);await screen.findByRole("heading", { name: "Home" });await expectNoAxeViolations(f.container);f.close(); });
it("marks admin routes web-only and does not add them when the server disables admin", () => {
 const routes = appRoutes({ ...features, admin: true, usage: true });const children = routes.flatMap(route => route.children ?? []);expect(children.find(route => route.path === "admin/*")?.handle).toEqual({ webOnly: true });expect(appRoutes(features).flatMap(route => route.children ?? []).some(route => route.path === "admin/*")).toBe(false);
});
