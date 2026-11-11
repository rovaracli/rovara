// @vitest-environment jsdom
// Lane U5: the app reads the company's flags from the navigation answer, before it builds the route table; the look follows live.
import { afterEach, expect, it, vi } from "vitest";
import { screen, act, configure, waitFor } from "@testing-library/react";
import { createMemoryRouter } from "react-router";
import { App } from "../../packages/ui/src/App.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { applyNavUiFlags, holdUiFlagsUntilNav, uiFlagOn, uiFlagsWaiting } from "../../packages/ui/src/ui-flags.js";
import { NAV_STORAGE_KEY } from "../../packages/ui/src/nav-flags.js";
import { LOOK_STORAGE_KEY } from "../../packages/ui/src/look.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { navFixture } from "./support/fixtures.js";
configure({ asyncUtilTimeout: 10_000 });vi.setConfig({ testTimeout: 30_000 });
afterEach(() => { document.documentElement.removeAttribute("data-look");document.documentElement.removeAttribute("data-density"); });
const flags = (states: Record<string, string>) => ({ uiFlags: { look: "off", nav: "off", home: "off", work: "off", spending: "off", leadingHeader: "off", health: "off", setup: "off", insights: "off", publish: "off", billing: "off", agreement: "off", ...states } });
function mount(extra: Record<string, unknown>, storage: Record<string, string> = {}) {
 const f = fakeHost(async () => ({ status: 200, body: { ...navFixture(), ...extra } }));
 f.host.currentPath = () => "/app";
 for (const [key, value] of Object.entries(storage)) f.host.storage.set(key, value);
 const ui = renderUi(h(App, { host: f.host, createRouter: routes => createMemoryRouter(routes, { initialEntries: ["/app"] }) }));
 return { ...f, ...ui };
}
const sidebar = () => screen.queryByRole("navigation", { name: "Main destinations" });

it("an older server (no uiFlags): the per-device switches decide, exactly as before", async () => {
 const off = mount({});
 await screen.findByRole("link", { name: "Agent directory" });
 expect(sidebar()).toBeNull();expect(document.documentElement.getAttribute("data-look")).toBeNull();off.unmount();
 const on = mount({}, { [NAV_STORAGE_KEY]: "v2", [LOOK_STORAGE_KEY]: "v2" });
 await screen.findByRole("navigation", { name: "Main destinations" });expect(document.documentElement.getAttribute("data-look")).toBe("v2");on.unmount();
});
it("the company's nav and look flags turn the new navigation and look on with no device key", async () => {
 mount(flags({ nav: "on", look: "on" }));
 await screen.findByRole("navigation", { name: "Main destinations" });
 expect(document.documentElement.getAttribute("data-look")).toBe("v2");
});
it("an off flag beats this device's key; preview leaves it to the device key", async () => {
 const off = mount(flags({ nav: "off", look: "off" }), { [NAV_STORAGE_KEY]: "v2", [LOOK_STORAGE_KEY]: "v2" });
 await screen.findByRole("link", { name: "Agent directory" });expect(sidebar()).toBeNull();expect(document.documentElement.getAttribute("data-look")).toBeNull();off.unmount();
 const previewOn = mount(flags({ nav: "preview", look: "preview" }), { [NAV_STORAGE_KEY]: "v2", [LOOK_STORAGE_KEY]: "v2" });
 await screen.findByRole("navigation", { name: "Main destinations" });expect(document.documentElement.getAttribute("data-look")).toBe("v2");previewOn.unmount();
 const previewUnset = mount(flags({ nav: "preview", look: "preview" }));
 await screen.findByRole("link", { name: "Agent directory" });expect(sidebar()).toBeNull();expect(document.documentElement.getAttribute("data-look")).toBeNull();previewUnset.unmount();
});
it("the look follows a later answer at once", async () => {
 const f = fakeHost();
 renderUi(h(ThemeProvider, { host: f.host, children: h("p", null, "page") }));
 expect(document.documentElement.getAttribute("data-look")).toBeNull();
 act(() => { applyNavUiFlags(f.host, { uiFlags: { look: "on" } }); });
 expect(document.documentElement.getAttribute("data-look")).toBe("v2");
 act(() => { applyNavUiFlags(f.host, { uiFlags: { look: "off" } }); });
 expect(document.documentElement.getAttribute("data-look")).toBeNull();
});

it("while the navigation answer is loading the look is the default, even with this device's key on; the answer then decides", async () => {
 let answerNav: (value: { status: number; body: unknown }) => void = () => undefined;
 const f = fakeHost(() => new Promise(resolve => { answerNav = resolve; }));
 f.host.currentPath = () => "/app";f.host.storage.set(LOOK_STORAGE_KEY, "v2");
 renderUi(h(App, { host: f.host, createRouter: routes => createMemoryRouter(routes, { initialEntries: ["/app"] }) }));
 await screen.findByText("Loading workspace");
 expect(document.documentElement.getAttribute("data-look")).toBeNull();
 await act(async () => { answerNav({ status: 200, body: { ...navFixture(), ...flags({ look: "preview" }) } }); });
 await screen.findByRole("link", { name: "Agent directory" });
 expect(document.documentElement.getAttribute("data-look")).toBe("v2");
});
it("when the navigation read has failed the look and the screens stay at the default, even with this device's keys on", async () => {
 const f = fakeHost(async () => ({ status: 500, body: { error: { code: "INTERNAL", message: "No." } } }));
 f.host.currentPath = () => "/app";f.host.storage.set(LOOK_STORAGE_KEY, "v2");f.host.storage.set(NAV_STORAGE_KEY, "v2");
 renderUi(h(App, { host: f.host, createRouter: routes => createMemoryRouter(routes, { initialEntries: ["/app"] }) }));
 await screen.findByRole("button", { name: /reload|try again/iu });
 expect(document.documentElement.getAttribute("data-look")).toBeNull();
 expect(uiFlagOn(f.host, "look", LOOK_STORAGE_KEY)).toBe(false);expect(uiFlagOn(f.host, "nav", NAV_STORAGE_KEY)).toBe(false);
});
it("the wait ends with the first answer, one with no uiFlags included (an older server: the device key decides again)", () => {
 const f = fakeHost();
 renderUi(h(ThemeProvider, { host: f.host, children: h("p", null, "page") }));
 f.host.storage.set(LOOK_STORAGE_KEY, "v2");
 act(() => { holdUiFlagsUntilNav(f.host); });
 expect(uiFlagsWaiting(f.host)).toBe(true);expect(document.documentElement.getAttribute("data-look")).toBeNull();
 act(() => { applyNavUiFlags(f.host, { features: {} }); });
 expect(uiFlagsWaiting(f.host)).toBe(false);expect(document.documentElement.getAttribute("data-look")).toBe("v2");
});
it("a page that makes no navigation read (signup) is not held: the device key decides", async () => {
 const f = fakeHost(async () => ({ status: 200, body: {} }));
 f.host.currentPath = () => "/app/signup";f.host.storage.set(LOOK_STORAGE_KEY, "v2");
 renderUi(h(App, { host: f.host, createRouter: routes => createMemoryRouter(routes, { initialEntries: ["/app/signup"] }) }));
 await waitFor(() => { expect(document.documentElement.getAttribute("data-look")).toBe("v2"); });
});
