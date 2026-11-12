// @vitest-environment jsdom
// An error page's Reload is the page's own reload (decision 125 follow-up): the browser host's `navigate` refuses an address it would not link to (a query with "+", ":" or ","), so a Reload built on it
// did nothing on such a page.
import { describe, expect, it, vi } from "vitest";
// The built @agentx/ui package imports its stylesheets, which vitest cannot resolve from dist; the host only needs these names, so they come from the source.
vi.mock("@agentx/ui", async () => ({ ApiError: (await import("../../packages/ui/src/api/errors.js")).ApiError, createApiClient: (await import("../../packages/ui/src/api/client.js")).createApiClient, SIGN_IN_REPEAT_GUARD_MS: (await import("../../packages/ui/src/constants.js")).SIGN_IN_REPEAT_GUARD_MS, COMPANY_HEADER: (await import("../../packages/ui/src/api/company-context.js")).COMPANY_HEADER, pageCompany: (await import("../../packages/ui/src/api/company-context.js")).pageCompany, withCompanyHeader: (await import("../../packages/ui/src/api/company-context.js")).withCompanyHeader, reloadIntoActiveCompany: (await import("../../packages/ui/src/api/company-context.js")).reloadIntoActiveCompany, isCompanySwitcherOn: (await import("../../packages/ui/src/company-flags.js")).isCompanySwitcherOn, isCompanyHeaderOn: (await import("../../packages/ui/src/company-flags.js")).isCompanyHeaderOn }));
import { fireEvent, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { createBrowserHost, type BrowserWindow } from "../../packages/web/src/browser-host.js";
import { AppHostProvider, reloadPage } from "../../packages/ui/src/host.js";
import { RouteError } from "../../packages/ui/src/shell/ErrorBoundary.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";

const SEARCHES = ["?filter=a+b", "?project=pay:ments", "?filter=mine,team", "?q=%E2%9C%93&x=a+b"];
function browser(search: string, withReload = true) {
 const reload = vi.fn(), assign = vi.fn();
 const win = { location: { origin: "https://cell.example", pathname: "/app/work", search, assign, ...(withReload ? { reload } : {}) }, fetch: vi.fn(), localStorage: { getItem: () => null, setItem: () => undefined }, sessionStorage: { getItem: () => null, setItem: () => undefined }, document: { createElement: () => ({}), body: {}, title: "" }, URL: { createObjectURL: () => "", revokeObjectURL: () => undefined }, WebSocket: class {}, open: () => undefined } as unknown as BrowserWindow;
 return { host: createBrowserHost(win), reload, assign };
}

describe("reloadPage", () => {
 for (const search of SEARCHES) it(`reloads the browser page at /app/work${search}, where navigating to the same address is refused`, () => {
  const { host, reload, assign } = browser(search);
  expect(() => { host.navigate(host.currentPath()); }, "the trap: navigate refuses this address").toThrow();
  reloadPage(host);
  expect(reload).toHaveBeenCalledTimes(1);expect(assign).not.toHaveBeenCalled();
 });
 it("a browser without location.reload assigns the same address instead", () => {
  const { host, assign } = browser("?filter=a+b", false);
  reloadPage(host);
  expect(assign).toHaveBeenCalledWith("/app/work?filter=a+b");
 });
 it("a host with no reload of its own navigates to the address, and to its path when the address is refused", () => {
  const navigate = vi.fn((url: string) => { if (url.includes("+")) throw new Error("Invalid app destination."); });
  reloadPage({ currentPath: () => "/app/work?filter=a+b", navigate });
  expect(navigate.mock.calls.map(([url]) => url)).toEqual(["/app/work?filter=a+b", "/app/work"]);
 });
 it("the page error's Reload uses the host's reload, not navigate", () => {
  const f = fakeHost(), reload = vi.fn(), navigate = vi.spyOn(f.host, "navigate");f.host.reload = reload;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const router = createMemoryRouter([{ path: "*", element: h("p", null, "x"), loader: () => { throw new Error("boom"); }, errorElement: h(RouteError) }], { initialEntries: ["/app/work?filter=a+b"] });
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(RouterProvider, { router }) }));
  return screen.findByRole("button", { name: "Reload" }).then(button => { fireEvent.click(button);expect(reload).toHaveBeenCalledTimes(1);expect(navigate).not.toHaveBeenCalled();ui.unmount();router.dispose();vi.restoreAllMocks(); });
 });
});
