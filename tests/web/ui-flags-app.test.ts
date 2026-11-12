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
import { UI_FLAG_NAMES, uiFlagEnabled, uiFlagState, type UiFlagName } from "@agentx/cloud-contracts/web";
import { isNewLookOn } from "../../packages/ui/src/look.js";
import { isNewNavOn } from "../../packages/ui/src/nav-flags.js";
import { isNewHomeOn } from "../../packages/ui/src/screens/home/home-flags.js";
import { isWorkListOn } from "../../packages/ui/src/screens/live/work-list-flags.js";
import { isSpendingV2On } from "../../packages/ui/src/screens/admin/spending-flags.js";
import { taskPageFlags } from "../../packages/ui/src/screens/session/task-page-flags.js";
import { isInsightsOn } from "../../packages/ui/src/screens/insights/insights-flags.js";
import { isContinueInToolOn } from "../../packages/ui/src/screens/session/continue-flags.js";
import { isHealthV2On } from "../../packages/ui/src/screens/admin/health/health-flags.js";
import { isProjectSetupV2On } from "../../packages/ui/src/screens/onboarding/project-setup-flags.js";
import { isAgentPublishOn } from "../../packages/ui/src/screens/agents/publish-flags.js";
import { isBillingV2On } from "../../packages/ui/src/billing-flags.js";
import { isWorkingAgreementOn } from "../../packages/ui/src/screens/agreement/agreement-flags.js";
import { isCompanySwitcherOn } from "../../packages/ui/src/company-flags.js";
import { uiFlagServerState } from "../../packages/ui/src/ui-flags.js";
configure({ asyncUtilTimeout: 10_000 });vi.setConfig({ testTimeout: 30_000 });
afterEach(() => { document.documentElement.removeAttribute("data-look");document.documentElement.removeAttribute("data-density"); });
const flags = (states: Record<string, string>) => ({ uiFlags: { look: "off", nav: "off", home: "off", work: "off", spending: "off", leadingHeader: "off", health: "off", setup: "off", insights: "off", publish: "off", billing: "off", agreement: "off", companies: "off", continue: "off", ...states } });
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

// Decision 116: a newer broker's answer for a company that never chose (its store's rule: the stored value, else the catalog default; the operator's override over both).
const brokerAnswer = (options: { stored?: Partial<Record<UiFlagName, boolean>>; previews?: boolean; forced?: readonly string[] } = {}) => ({ uiFlags: Object.fromEntries(UI_FLAG_NAMES.map(name => [name, uiFlagState({ enabled: uiFlagEnabled(name, options.stored?.[name]), previews: options.previews ?? false, forcedOff: (options.forced ?? []).includes(name) })])) });
const DEVICE_KEYS = Object.fromEntries(["look", "nav", "home", "work", "spending", "insights", "continue", "health", "setup", "publish", "billing", "agreement", "companies"].map(name => [`rovara.${name}`, "v2"]));
const readers = (host: Parameters<typeof isNewLookOn>[0]) => ({
 look: isNewLookOn(host), nav: isNewNavOn(host), home: isNewHomeOn(host), work: isWorkListOn(host), spending: isSpendingV2On(host), leadingHeader: taskPageFlags("", uiFlagServerState(host, "leadingHeader")).leadingHeader, insights: isInsightsOn(host), continue: isContinueInToolOn(host),
 health: isHealthV2On(host), setup: isProjectSetupV2On(host), publish: isAgentPublishOn(host), billing: isBillingV2On(host), agreement: isWorkingAgreementOn(host), companies: isCompanySwitcherOn(host),
});
const FINISHED = { look: true, nav: true, home: true, work: true, spending: true, leadingHeader: true, insights: true, continue: true, health: false, setup: false, publish: false, billing: false, agreement: false, companies: false };

it("decision 116, every screen's own switch: the default answer turns on each finished screen with no device key, and no unfinished one even with every device key on", () => {
 const bare = fakeHost();applyNavUiFlags(bare.host, brokerAnswer());
 expect(readers(bare.host)).toEqual(FINISHED);
 const keyed = fakeHost();for (const [key, value] of Object.entries(DEVICE_KEYS)) keyed.host.storage.set(key, value);applyNavUiFlags(keyed.host, brokerAnswer());
 expect(readers(keyed.host)).toEqual(FINISHED);
});
it("decision 116: a company's pressed off (and the operator's override) give the old screen, even with every device key on; with previews, the device key decides again", () => {
 const keys = (f: ReturnType<typeof fakeHost>) => { for (const [key, value] of Object.entries(DEVICE_KEYS)) f.host.storage.set(key, value);return f; };
 const chose = keys(fakeHost());applyNavUiFlags(chose.host, brokerAnswer({ stored: { home: false, leadingHeader: false } }));
 expect(readers(chose.host)).toEqual({ ...FINISHED, home: false, leadingHeader: false });
 const forced = keys(fakeHost());applyNavUiFlags(forced.host, brokerAnswer({ forced: UI_FLAG_NAMES }));
 expect(Object.values(readers(forced.host)).every(on => !on)).toBe(true);
 const forcedOne = keys(fakeHost());applyNavUiFlags(forcedOne.host, brokerAnswer({ forced: ["work"] }));
 expect(readers(forcedOne.host)).toEqual({ ...FINISHED, work: false });
 const preview = keys(fakeHost());applyNavUiFlags(preview.host, brokerAnswer({ stored: { home: false }, previews: true }));
 expect(readers(preview.host)).toMatchObject({ home: true, health: true });
 const previewNoKey = fakeHost();applyNavUiFlags(previewNoKey.host, brokerAnswer({ stored: { home: false }, previews: true }));
 expect(readers(previewNoKey.host)).toMatchObject({ home: false, health: false, look: true });
});
it("decision 116 in the app: the default answer gives the new navigation and look with no device key; the operator's `all` gives the old ones with every key on", async () => {
 const on = mount(brokerAnswer());
 await screen.findByRole("navigation", { name: "Main destinations" });expect(document.documentElement.getAttribute("data-look")).toBe("v2");on.unmount();
 const off = mount(brokerAnswer({ forced: UI_FLAG_NAMES }), DEVICE_KEYS);
 await screen.findByRole("link", { name: "Agent directory" });expect(sidebar()).toBeNull();expect(document.documentElement.getAttribute("data-look")).toBeNull();off.unmount();
});
