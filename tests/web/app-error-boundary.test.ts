// @vitest-environment jsdom
// App's outermost boundary wraps the theme and the announcer (decision 125 follow-up): a failure in ThemeProvider itself still ends in a styled page with the Rovara mark and Reload. Its fallback brings
// its own sheet from the same tokens, so the page is styled even though ThemeProvider never wrote one.
import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { createMemoryRouter } from "react-router";
vi.mock("../../packages/ui/src/theme.js", async original => ({ ...(await original<ThemeModule>()), ThemeProvider: () => { throw new Error("the theme could not start"); } }));
import { App } from "../../packages/ui/src/App.js";
import type * as Theme from "../../packages/ui/src/theme.js";
type ThemeModule = typeof Theme;
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { navFixture } from "./support/fixtures.js";
afterEach(() => { vi.restoreAllMocks();document.documentElement.removeAttribute("data-look"); });

it("a crash in ThemeProvider shows the styled app error page: the Rovara mark, the page error, Reload, the tokens and the one look", async () => {
 vi.spyOn(console, "error").mockImplementation(() => undefined);
 const f = fakeHost(async () => ({ status: 200, body: navFixture() })), reload = vi.fn();f.host.reload = reload;f.host.currentPath = () => "/app";
 const ui = renderUi(h(App, { host: f.host, createRouter: routes => createMemoryRouter(routes, { initialEntries: ["/app"] }) }));
 expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe("Something went wrong on this page.");
 const page = ui.container.querySelector(".rv-app-error");
 expect(page).not.toBeNull();
 expect(page?.querySelector(".rv-wordmark")?.textContent).toBe("Rovara");
 const sheet = page?.querySelector("style")?.textContent ?? "";
 expect(sheet).toContain("--rv-bg:");expect(sheet).toContain(':root[data-look="v2"]');expect(sheet).toContain(".rv-app-error{");
 expect(document.documentElement.getAttribute("data-look")).toBe("v2");
 fireEvent.click(screen.getByRole("button", { name: "Reload" }));expect(reload).toHaveBeenCalledTimes(1);
 ui.unmount();
});
