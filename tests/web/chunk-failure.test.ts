// @vitest-environment jsdom
// A screen whose code cannot load (decision 125 follow-up): the route table's own guard (routes.tsx withScreenError -> guardLazy) shows the page error in the screen's place, inside the shell, never a blank or
// bare page. The Work screen's module fails to load here exactly as a missing chunk does after a release.
import { expect, it, vi } from "vitest";
import { screen, configure as configureDom } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
vi.mock("../../packages/ui/src/screens/live/WorkListScreen.js", () => { throw new TypeError("Failed to fetch dynamically imported module: /app/assets/WorkListScreen-x.js"); });
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { navFixture } from "./support/fixtures.js";
configureDom({ asyncUtilTimeout: 10_000 });

it("Work's chunk cannot load: 'Rovara was updated' with Reload, and the navigation stays", async () => {
 vi.spyOn(console, "error").mockImplementation(() => undefined);
 const nav = navFixture(), f = fakeHost(async () => ({ status: 200, body: nav })), query = createQueryClient();query.setQueryData(["nav"], nav);
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: ["/app/work"] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 // vitest reports the failed module in its own words, so the heading is either of the page error's two; what matters is where it is: in the main column, inside the shell.
 const heading = await screen.findByRole("heading", { level: 1, name: /^(Rovara was updated\. Reload to continue\.|Something went wrong on this page\.)$/u });
 expect(heading.closest("main")).not.toBeNull();
 expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
 expect(ui.container.querySelector(".rv-app-shell")).not.toBeNull();
 expect(screen.getAllByRole("navigation", { name: "Workspace" }).length).toBeGreaterThan(0);
 ui.unmount();router.dispose();query.clear();
});
