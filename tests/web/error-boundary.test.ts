// @vitest-environment jsdom
// Decision 125: with no old screen to fall back to, a screen that crashes must never leave a white page. Three layers catch it:
//   1. each screen under /app has its own error element (routes.tsx `withScreenError`): the page says "Something went wrong on this page." with Reload, and the navigation stays, so the person can go elsewhere;
//   2. the shell's own error element, for a crash in the shell itself;
//   3. App's ErrorBoundary, for anything above the router (building the router included).
import { afterEach, expect, it, vi } from "vitest";
import { screen, fireEvent, within, configure } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, type RouteObject } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { App } from "../../packages/ui/src/App.js";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { navFixture } from "./support/fixtures.js";
configure({ asyncUtilTimeout: 10_000 });vi.setConfig({ testTimeout: 30_000 });
// React reports a caught render error on the console; the test expects the error, so keep the output quiet.
const quiet = () => vi.spyOn(console, "error").mockImplementation(() => undefined);
afterEach(() => { vi.restoreAllMocks(); });

function Crash(): never { throw new Error("a screen read a field an older broker did not send"); }
/** The app's own routes, with one screen replaced by one that crashes while it renders (its route keeps whatever error element the route table gave it). */
function withCrashingScreen(path: string | undefined): RouteObject[] {
 const routes = appRoutes(navFixture().features), app = routes.find(route => route.path === "/app")!;
 app.children = app.children!.map(child => { if (!(path === undefined ? child.index === true : child.path === path)) return child;const crashing: RouteObject = { ...child, element: h(Crash) };delete crashing.lazy;return crashing; });
 return routes;
}
function mount(routes: RouteObject[], at: string) {
 const nav = navFixture(), f = fakeHost(async request => request.path === "/v1/app/nav" ? { status: 200, body: nav } : { status: 200, body: { notices: [], next: "settled" } }), query = createQueryClient();
 query.setQueryData(["nav"], nav);
 const router = createMemoryRouter(routes, { initialEntries: [at] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 return { ...f, ...ui, router, close() { ui.unmount();router.dispose();query.clear(); } };
}

for (const [label, path, at] of [["Home", undefined, "/app"], ["Work", "work", "/app/work"], ["Insights", "insights", "/app/insights"], ["the task page", "sessions/:id", "/app/sessions/ses_aaaaaaaaaaaaaaaaaaaa"]] as const) {
 it(`a crash in ${label} shows a recoverable error inside the shell: the navigation stays, Reload reloads, and another page still opens`, async () => {
  quiet();
  const f = mount(withCrashingScreen(path), at);
  try {
   expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe("Something went wrong on this page.");
   // The shell is still there: the person is not stranded on a blank or bare page.
   const sidebar = screen.getAllByRole("navigation", { name: "Workspace" })[0]!;
   expect(screen.getByRole("navigation", { name: "Main destinations" })).toBeTruthy();
   expect(f.container.querySelector(".rv-app-shell")).not.toBeNull();
   const navigate = vi.spyOn(f.host, "navigate");
   fireEvent.click(screen.getByRole("button", { name: "Reload" }));
   expect(navigate).toHaveBeenCalledWith("/app/live");
   // Moving to another destination leaves the error behind.
   fireEvent.click(within(sidebar).getByRole("link", { name: "Agents" }));
   expect(await screen.findByRole("heading", { level: 1, name: /Agent|Home/u })).toBeTruthy();
   expect(screen.queryByText("Something went wrong on this page.")).toBeNull();
  } finally { f.close(); }
 });
}

it("every screen route under /app has an error element of its own", () => {
 const app = appRoutes({ ...navFixture().features, admin: true, chains: true, usage: true, describe: true }, { billing: true, publish: true }).find(route => route.path === "/app")!;
 for (const child of app.children!) expect(child.errorElement, child.path ?? "(index)").toBeTruthy();
});

it("a crash above the router (building the route table) is caught by App's ErrorBoundary: a page error with Reload, never a white page", async () => {
 quiet();
 const f = fakeHost(async () => ({ status: 200, body: navFixture() }));
 f.host.currentPath = () => "/app";
 const ui = renderUi(h(App, { host: f.host, createRouter: () => { throw new Error("router could not be built"); } }));
 expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe("Something went wrong on this page.");
 expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
 expect(ui.container.textContent?.trim().length).toBeGreaterThan(0);
 ui.unmount();
});
