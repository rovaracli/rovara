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
import { guardLazy, isChunkLoadError } from "../../packages/ui/src/shell/ErrorBoundary.js";
import { ApiError } from "../../packages/ui/src/api/errors.js";
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

// BudgetsScreen's code cannot load, as a missing chunk does after a release: the one lazy route the guard test below runs for real.
vi.mock("../../packages/ui/src/screens/admin/BudgetsScreen.js", () => { throw new TypeError("Failed to fetch dynamically imported module: /app/assets/BudgetsScreen-x.js"); });
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

for (const [label, path, at] of [["Work", "work", "/app/work"], ["Home", undefined, "/app"], ["Insights", "insights", "/app/insights"], ["the task page", "sessions/:id", "/app/sessions/ses_aaaaaaaaaaaaaaaaaaaa"]] as const) {
 it(`${label}'s code cannot load (a release changed under the page): 'Rovara was updated' with Reload inside the shell`, async () => {
  quiet();
  const routes = appRoutes(navFixture().features), app = routes.find(route => route.path === "/app")!;
  // The chunk fails as a browser reports it; the route table's guard turns it into the page error in the screen's place.
  app.children = app.children!.map(child => (path === undefined ? child.index === true : child.path === path) ? guardLazy({ ...child, element: undefined, lazy: () => Promise.reject(new TypeError("Failed to fetch dynamically imported module: /app/assets/x.js")) }) : child);
  const f = mount(routes, at);
  try {
   expect((await screen.findByRole("heading", { level: 1, name: "Rovara was updated. Reload to continue." })).textContent).toBe("Rovara was updated. Reload to continue.");
   expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
   expect(f.container.querySelector(".rv-app-shell")).not.toBeNull();
   expect(screen.getAllByRole("navigation", { name: "Workspace" }).length).toBeGreaterThan(0);
  } finally { f.close(); }
 });
}

it("the route table guards every lazy screen under /app, the admin pages under the admin layout included", async () => {
 const app = appRoutes({ ...navFixture().features, admin: true }).find(route => route.path === "/app")!;
 const admin = app.children!.find(route => route.path === "admin/*")!;
 const spending = admin.children!.find(route => route.path === "money/budgets")!;
 expect(spending.errorElement).toBeTruthy();
 // The route table's own lazy for Spending imports a module that cannot load here. A guarded lazy never rejects: the failed import resolves to a component that shows the page error. Without `guardLazy` in
 // `withScreenError` this rejects, so the test fails if the guard is dropped from the route table.
 const resolved = await (spending.lazy as () => Promise<{ Component?: unknown }>)();
 expect(typeof resolved.Component).toBe("function");
 // And the guard itself, on a route of its own.
 const failing = guardLazy({ path: "x", lazy: () => Promise.reject(new TypeError("Importing a module script failed.")) });
 expect(typeof (await (failing.lazy as () => Promise<{ Component?: unknown }>)()).Component).toBe("function");
});

it("a chunk that cannot load is told from any other failure by its words, whichever Error the browser or Vite throws", () => {
 // Browsers throw a TypeError ...
 for (const message of ["Failed to fetch dynamically imported module: /app/assets/x.js", "Importing a module script failed.", "error loading dynamically imported module"]) expect(isChunkLoadError(new TypeError(message)), message).toBe(true);
 // ... but Vite 8 preloads a chunk's CSS first and throws a plain Error when that fails; a stale deploy of a screen with CSS must read as "updated", too.
 for (const message of ["Unable to preload CSS for /app/assets/InsightsScreen-x.css", "Loading chunk 12 failed."]) expect(isChunkLoadError(new Error(message)), message).toBe(true);
 // Not a chunk: a crash in a screen, a broker answer (even with the words in it), and things that are not errors.
 expect(isChunkLoadError(new Error("a screen read a field an older broker did not send"))).toBe(false);
 expect(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'x')"))).toBe(false);
 expect(isChunkLoadError(new ApiError(500, "INTERNAL", "Unable to preload the chunk"))).toBe(false);
 expect(isChunkLoadError("Failed to fetch dynamically imported module")).toBe(false);expect(isChunkLoadError(undefined)).toBe(false);
});

it("a plain Error from a CSS preload shows 'Rovara was updated' in the shell, not 'Something went wrong'", async () => {
 quiet();
 const routes = appRoutes(navFixture().features), app = routes.find(route => route.path === "/app")!;
 app.children = app.children!.map(child => child.path === "work" ? guardLazy({ ...child, element: undefined, lazy: () => Promise.reject(new Error("Unable to preload CSS for /app/assets/WorkListScreen-x.css")) }) : child);
 const f = mount(routes, "/app/work");
 try {
  expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe("Rovara was updated. Reload to continue.");
  expect(f.container.querySelector(".rv-app-shell")).not.toBeNull();
 } finally { f.close(); }
});

it("every screen route under /app has an error element of its own", () => {
 const app = appRoutes({ ...navFixture().features, admin: true, chains: true, usage: true, describe: true }, { billing: true, publish: true }).find(route => route.path === "/app")!;
 const check = (routes: RouteObject[]) => { for (const child of routes) { expect(child.errorElement, child.path ?? "(index)").toBeTruthy();if (child.children) check(child.children); } };check(app.children!);
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
