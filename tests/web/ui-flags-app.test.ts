// @vitest-environment jsdom
// Lane U5 and decision 125: the app reads the company's flags from the navigation answer before it builds the route table. The finished screens (the look, the navigation, Home, Work,
// Spending, the task header, Insights, Continue in your own tool) are no flags any more: whatever a broker sends (an older one with no uiFlags, an older one that still names them off or
// forced off, this one), the app shows them. The flags left (the screens still being finished) still follow the answer.
import { afterEach, expect, it, vi } from "vitest";
import { screen, act, configure, waitFor } from "@testing-library/react";
import { createMemoryRouter } from "react-router";
import { App } from "../../packages/ui/src/App.js";
import { applyNavUiFlags, holdUiFlagsUntilNav, uiFlagsWaiting } from "../../packages/ui/src/ui-flags.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { navFixture } from "./support/fixtures.js";
import { UI_FLAG_NAMES, uiFlagEnabled, uiFlagState, type UiFlagName } from "@agentx/cloud-contracts/web";
import { isHealthV2On } from "../../packages/ui/src/screens/admin/health/health-flags.js";
import { isProjectSetupV2On } from "../../packages/ui/src/screens/onboarding/project-setup-flags.js";
import { isAgentPublishOn } from "../../packages/ui/src/screens/agents/publish-flags.js";
import { isBillingV2On } from "../../packages/ui/src/billing-flags.js";
import { isWorkingAgreementOn } from "../../packages/ui/src/screens/agreement/agreement-flags.js";
import { isCompanySwitcherOn } from "../../packages/ui/src/company-flags.js";
configure({ asyncUtilTimeout: 10_000 });vi.setConfig({ testTimeout: 30_000 });
afterEach(() => { document.documentElement.removeAttribute("data-look");document.documentElement.removeAttribute("data-density"); });
const FINISHED = ["look", "nav", "home", "work", "spending", "leadingHeader", "insights", "continue"] as const;
/** What a 0.5.14 or 0.5.15-default-on broker sent: the finished screens named too. */
const olderAnswer = (state: string) => ({ uiFlags: Object.fromEntries([...FINISHED, ...UI_FLAG_NAMES].map(name => [name, state])) });
/** Every device key an older app read, on. */
const DEVICE_KEYS = Object.fromEntries([...FINISHED, ...UI_FLAG_NAMES].map(name => [`rovara.${name}`, "v2"]));
function mount(extra: Record<string, unknown>, storage: Record<string, string> = {}) {
 const f = fakeHost(async () => ({ status: 200, body: { ...navFixture(), ...extra } }));
 f.host.currentPath = () => "/app";
 for (const [key, value] of Object.entries(storage)) f.host.storage.set(key, value);
 const ui = renderUi(h(App, { host: f.host, createRouter: routes => createMemoryRouter(routes, { initialEntries: ["/app"] }) }));
 return { ...f, ...ui };
}
const newNavigation = () => screen.findByRole("navigation", { name: "Main destinations" });

it("the new navigation and look, whatever the broker sends: no uiFlags (an older broker), the finished screens named off or on, this broker's answer, with or without device keys", async () => {
 for (const [label, extra, storage] of [["no uiFlags", {}, {}], ["older broker, all off", olderAnswer("off"), {}], ["older broker, all off, every key on", olderAnswer("off"), DEVICE_KEYS], ["older broker, all on", olderAnswer("on"), {}], ["this broker", { uiFlags: Object.fromEntries(UI_FLAG_NAMES.map(name => [name, "off"])), insights: false }, {}]] as const) {
  const f = mount(extra, storage);
  await newNavigation();
  expect(document.documentElement.getAttribute("data-look"), label).toBe("v2");
  expect(screen.queryByRole("link", { name: "Agent directory" }), label).toBeNull();
  expect(screen.queryByRole("link", { name: "Live" }), label).toBeNull();
  f.unmount();document.documentElement.removeAttribute("data-look");
 }
});
it("while the navigation answer is loading only the loading placeholder shows; the answer then gives the new screens", async () => {
 let answerNav: (value: { status: number; body: unknown }) => void = () => undefined;
 const f = fakeHost(() => new Promise(resolve => { answerNav = resolve; }));
 f.host.currentPath = () => "/app";
 renderUi(h(App, { host: f.host, createRouter: routes => createMemoryRouter(routes, { initialEntries: ["/app"] }) }));
 await screen.findByText("Loading workspace");
 await act(async () => { answerNav({ status: 200, body: navFixture() }); });
 await newNavigation();
 expect(document.documentElement.getAttribute("data-look")).toBe("v2");
});
it("when the navigation read has failed the page says so with a way to reload, in the new look: never a blank page", async () => {
 const f = fakeHost(async () => ({ status: 500, body: { error: { code: "INTERNAL", message: "No." } } }));
 f.host.currentPath = () => "/app";
 const ui = renderUi(h(App, { host: f.host, createRouter: routes => createMemoryRouter(routes, { initialEntries: ["/app"] }) }));
 await screen.findByRole("button", { name: /reload|try again/iu });
 expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/Something went wrong/u);
 expect(ui.container.textContent?.trim().length).toBeGreaterThan(0);
 expect(document.documentElement.getAttribute("data-look")).toBe("v2");
});
it("the wait for the answer still ends with the first answer, one with no uiFlags included", () => {
 const f = fakeHost();
 act(() => { holdUiFlagsUntilNav(f.host); });
 expect(uiFlagsWaiting(f.host)).toBe(true);
 act(() => { applyNavUiFlags(f.host, { features: {} }); });
 expect(uiFlagsWaiting(f.host)).toBe(false);
});
it("a page that makes no navigation read (signup) has the look too", async () => {
 const f = fakeHost(async () => ({ status: 200, body: {} }));
 f.host.currentPath = () => "/app/signup";
 renderUi(h(App, { host: f.host, createRouter: routes => createMemoryRouter(routes, { initialEntries: ["/app/signup"] }) }));
 await waitFor(() => { expect(document.documentElement.getAttribute("data-look")).toBe("v2"); });
});

// The flags that are left: this broker's answer (its store's rule: the stored value, else the catalog default; the operator's override over both) still decides each one.
const brokerAnswer = (options: { stored?: Partial<Record<UiFlagName, boolean>>; previews?: boolean; forced?: readonly string[] } = {}) => ({ uiFlags: Object.fromEntries(UI_FLAG_NAMES.map(name => [name, uiFlagState({ enabled: uiFlagEnabled(name, options.stored?.[name]), previews: options.previews ?? false, forcedOff: (options.forced ?? []).includes(name) })])) });
const readers = (host: Parameters<typeof isHealthV2On>[0] & { storage: { set(key: string, value: string): void } }) => ({
 health: isHealthV2On(host), setup: isProjectSetupV2On(host), publish: isAgentPublishOn(host), billing: isBillingV2On(host), agreement: isWorkingAgreementOn(host), companies: isCompanySwitcherOn(host),
});
const ALL_OFF = { health: false, setup: false, publish: false, billing: false, agreement: false, companies: false };

it("the screens still being finished: off by default even with every device key on; a company's on turns one on; the operator's override wins; previews leave it to the device key", () => {
 const keys = (f: ReturnType<typeof fakeHost>) => { for (const [key, value] of Object.entries(DEVICE_KEYS)) f.host.storage.set(key, value);return f; };
 const bare = fakeHost();applyNavUiFlags(bare.host, brokerAnswer());expect(readers(bare.host)).toEqual(ALL_OFF);
 const keyed = keys(fakeHost());applyNavUiFlags(keyed.host, brokerAnswer());expect(readers(keyed.host)).toEqual(ALL_OFF);
 const chose = fakeHost();applyNavUiFlags(chose.host, brokerAnswer({ stored: { health: true, billing: true } }));expect(readers(chose.host)).toEqual({ ...ALL_OFF, health: true, billing: true });
 const forced = keys(fakeHost());applyNavUiFlags(forced.host, brokerAnswer({ stored: { health: true }, previews: true, forced: UI_FLAG_NAMES }));expect(readers(forced.host)).toEqual(ALL_OFF);
 const preview = keys(fakeHost());applyNavUiFlags(preview.host, brokerAnswer({ previews: true }));expect(Object.values(readers(preview.host)).every(Boolean)).toBe(true);
 const previewNoKey = fakeHost();applyNavUiFlags(previewNoKey.host, brokerAnswer({ previews: true }));expect(readers(previewNoKey.host)).toEqual(ALL_OFF);
});
