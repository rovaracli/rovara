// @vitest-environment jsdom
// The shell's own lazy parts (the company switcher's header, phone list and gate, the trial billing banner) are separate chunks. After a release their old names are gone: a part that cannot load must
// never replace the whole shell (no navigation, no way out). The header falls back to the plain organization name, the phone list and the banner to nothing, and the gate to the page error in the content
// area, with the navigation still there. The company switcher's module fails as Vite reports a chunk whose CSS did not preload (a plain Error); the billing banner's part crashes as it renders (the same boundary catches either).
import { afterEach, expect, it, vi } from "vitest";
import { screen, fireEvent, within, configure } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
// The switcher's three entry points (company-lazy.ts) are replaced by lazy components whose chunk fails, as a missing file does after a release. vitest wraps an error thrown by a mock factory in its own words, so the
// failure is made by the lazy loader itself.
vi.mock("../../packages/ui/src/shell/company-lazy.js", async () => {
 const { lazy } = await import("react"), failing = () => lazy(() => Promise.reject(new Error("Unable to preload CSS for /app/assets/CompanySwitcher-x.css")));
 return { CompanyHeader: failing(), CompanyPhoneList: failing(), CompanyGate: failing() };
});
vi.mock("../../packages/ui/src/screens/billing/BillingBanner.js", () => ({ default: () => { throw new TypeError("Failed to fetch dynamically imported module: /app/assets/BillingBanner-x.js"); } }));
import { AppShell } from "../../packages/ui/src/shell/AppShell.js";
import { TrialBanner } from "../../packages/ui/src/shell/TrialBanner.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { applyNavUiFlags } from "../../packages/ui/src/ui-flags.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { navFixture } from "./support/fixtures.js";
configure({ asyncUtilTimeout: 10_000 });vi.setConfig({ testTimeout: 30_000 });
afterEach(() => { vi.restoreAllMocks(); });

function mount(flag: "companies" | "billing", children: { element: ReturnType<typeof h> }) {
 vi.spyOn(console, "error").mockImplementation(() => undefined);
 const nav = navFixture(), f = fakeHost(async () => ({ status: 200, body: nav })), query = createQueryClient();query.setQueryData(["nav"], nav);
 f.host.storage.set("rovara.theme", "light");applyNavUiFlags(f.host, { uiFlags: { [flag]: "on" } });
 const router = createMemoryRouter([{ path: "/app", element: h(AppShell), children: [{ index: true, ...children }] }], { initialEntries: ["/app"] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 return { ...f, ...ui, close() { ui.unmount();router.dispose();query.clear(); } };
}

it("the company switcher's code cannot load: the navigation stays, the header shows the plain organization name, the phone list shows nothing, and the content area says the app was updated, with Reload", async () => {
 const f = mount("companies", { element: h("h1", { tabIndex: -1 }, "Home") });
 try {
  const heading = await screen.findByRole("heading", { level: 1, name: "Rovara was updated. Reload to continue." });
  expect(heading.closest("main")).not.toBeNull();
  expect(within(heading.closest("main")!).getByRole("button", { name: "Reload" })).toBeTruthy();
  // The shell is whole: the navigation, the account menu, and the header's organization name.
  expect(f.container.querySelector(".rv-app-shell")).not.toBeNull();
  expect(screen.getAllByRole("navigation", { name: "Workspace" }).length).toBeGreaterThan(0);
  expect(screen.getByRole("navigation", { name: "Main destinations" })).toBeTruthy();
  expect(f.container.querySelector(".rv-shell-header .rv-shell-org")?.textContent).toBe("Acme");
  expect(screen.queryByText("Something went wrong on this page.")).toBeNull();
  const main = heading.closest("main")!;
  // Reload is the page's own reload, to the current address.
  const navigate = vi.spyOn(f.host, "navigate");
  fireEvent.click(within(main).getByRole("button", { name: "Reload" }));
  expect(navigate).toHaveBeenCalled();
  // The phone menu opens without the company list, and still holds the navigation.
  fireEvent.click(screen.getByRole("button", { name: "Open workspace menu" }));
  const menu = await screen.findByRole("dialog");
  expect(within(menu).getAllByRole("link", { name: /Work/u }).length).toBeGreaterThan(0);
  expect(within(menu).queryByRole("alert")).toBeNull();
 } finally { f.close(); }
});

it("the trial billing banner's code cannot load: the banner shows nothing and the page around it stays", async () => {
 const f = mount("billing", { element: h("h1", { tabIndex: -1 }, "Home") });
 try {
  expect((await screen.findByRole("heading", { level: 1, name: "Home" })).closest("main")).not.toBeNull();
  // Let the banner's import settle (it fails at once); the shell must not have been replaced.
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(f.container.querySelector(".rv-app-shell")).not.toBeNull();
  expect(screen.getAllByRole("navigation", { name: "Workspace" }).length).toBeGreaterThan(0);
  expect(screen.queryByText("Rovara was updated. Reload to continue.")).toBeNull();expect(screen.queryByText("Something went wrong on this page.")).toBeNull();
  expect(f.container.querySelector(".rv-trial-banner")).toBeNull();
 } finally { f.close(); }
});

it("the banner on its own: a failed chunk is a part that renders nothing, not a thrown error", async () => {
 vi.spyOn(console, "error").mockImplementation(() => undefined);
 const f = fakeHost();applyNavUiFlags(f.host, { uiFlags: { billing: "on" } });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h("div", { "data-testid": "around" }, h(TrialBanner, {}), "still here") }));
 await new Promise(resolve => setTimeout(resolve, 100));
 expect(screen.getByTestId("around").textContent).toBe("still here");
 ui.unmount();
});
