// @vitest-environment jsdom
// Lane U5: runtime per-company UI flags. `uiFlagOn` and the ten switch functions that call it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { applyNavUiFlags, syncUiFlags, uiFlagOn, uiFlagResolve, uiFlagServerState, uiFlagsStoreOf, UI_FLAG_DEVICE_VALUE } from "../../packages/ui/src/ui-flags.js";
import { UI_FLAG_NAMES, type UiFlagName } from "../../packages/ui/src/api/ui-flags.js";
import { isNewLookOn, LOOK_STORAGE_KEY } from "../../packages/ui/src/look.js";
import { isNewNavOn, NAV_STORAGE_KEY } from "../../packages/ui/src/nav-flags.js";
import { isNewHomeOn, HOME_STORAGE_KEY } from "../../packages/ui/src/screens/home/home-flags.js";
import { isWorkListOn, WORK_STORAGE_KEY } from "../../packages/ui/src/screens/live/work-list-flags.js";
import { isSpendingV2On, SPENDING_STORAGE_KEY } from "../../packages/ui/src/screens/admin/spending-flags.js";
import { isHealthV2On, HEALTH_STORAGE_KEY } from "../../packages/ui/src/screens/admin/health/health-flags.js";
import { isProjectSetupV2On, PROJECT_SETUP_STORAGE_KEY } from "../../packages/ui/src/screens/onboarding/project-setup-flags.js";
import { isInsightsOn, INSIGHTS_STORAGE_KEY } from "../../packages/ui/src/screens/insights/insights-flags.js";
import { isAgentPublishOn, AGENT_PUBLISH_STORAGE_KEY } from "../../packages/ui/src/screens/agents/publish-flags.js";
import { isBillingV2On, BILLING_STORAGE_KEY } from "../../packages/ui/src/billing-flags.js";
import { isCompanySwitcherOn, COMPANIES_STORAGE_KEY } from "../../packages/ui/src/company-flags.js";
import { taskPageFlags } from "../../packages/ui/src/screens/session/task-page-flags.js";

// A fresh host per test: the server's answer is kept per host object.
const hostWith = (value: string | undefined | "throws") => ({ storage: { get: (_key: string) => { if (value === "throws") throw new Error("blocked");return value; }, set: () => undefined } });
const answer = (host: object, states: Partial<Record<UiFlagName, string>>) => { applyNavUiFlags(host, { uiFlags: states }); };
afterEach(() => { vi.restoreAllMocks(); });

describe("uiFlagOn", () => {
 it("with no server value (an older server) is today's per-device key: on only for exactly v2", () => {
  expect(UI_FLAG_DEVICE_VALUE).toBe("v2");
  expect(uiFlagOn(hostWith("v2"), "look", "rovara.look")).toBe(true);
  for (const value of [undefined, "", "v1", "V2", "true", "1", "v2 "]) expect(uiFlagOn(hostWith(value), "look", "rovara.look"), String(value)).toBe(false);
  expect(uiFlagOn(hostWith("throws"), "look", "rovara.look")).toBe(false);
 });
 it("reads the key it is given, not another", () => {
  const seen: string[] = [], host = { storage: { get: (key: string) => { seen.push(key);return "v2"; } } };
  expect(uiFlagOn(host, "home", "rovara.home")).toBe(true);expect(seen).toEqual(["rovara.home"]);
 });
 it("is on for the company when the server says on, whatever the device key says", () => {
  for (const value of [undefined, "v2", "v1", "throws"] as const) { const host = hostWith(value);answer(host, { look: "on" });expect(uiFlagOn(host, "look", "rovara.look"), String(value)).toBe(true); }
 });
 it("is off when the server says off, even where the device key says v2 (no preview allowed, or the operator forced it off)", () => {
  const host = hostWith("v2");answer(host, { look: "off" });expect(uiFlagOn(host, "look", "rovara.look")).toBe(false);
 });
 it("with preview lets this device decide: on with the key set, off without it or when storage throws", () => {
  const set = hostWith("v2"), unset = hostWith(undefined), blocked = hostWith("throws");
  for (const host of [set, unset, blocked]) answer(host, { nav: "preview" });
  expect(uiFlagOn(set, "nav", "rovara.nav")).toBe(true);expect(uiFlagOn(unset, "nav", "rovara.nav")).toBe(false);expect(uiFlagOn(blocked, "nav", "rovara.nav")).toBe(false);
 });
 it("reads each flag by its own name: one flag's state never leaks into another", () => {
  const host = hostWith("v2");answer(host, { look: "on", nav: "off", home: "preview" });
  expect(uiFlagOn(host, "look", "k")).toBe(true);expect(uiFlagOn(host, "nav", "k")).toBe(false);expect(uiFlagOn(host, "home", "k")).toBe(true);
  // a name the answer does not carry is off, no preview
  expect(uiFlagServerState(host, "work")).toBe("off");expect(uiFlagOn(host, "work", "k")).toBe(false);
 });
 it("reads a state a newer server invented as off", () => {
  const host = hostWith("v2");answer(host, { look: "someday" });expect(uiFlagServerState(host, "look")).toBe("off");expect(uiFlagOn(host, "look", "k")).toBe(false);
 });
 it("makes no store for a host that never had an answer (cheap on the common path)", () => {
  const host = hostWith("v2");expect(uiFlagServerState(host, "look")).toBeUndefined();expect(uiFlagOn(host, "look", "k")).toBe(true);
 });
 it("resolves the rule as a function of the server state and the device switch", () => {
  const table: Array<[Parameters<typeof uiFlagResolve>[0], boolean, boolean]> = [["on", true, true], ["on", false, true], ["preview", true, true], ["preview", false, false], ["off", true, false], ["off", false, false], [undefined, true, true], [undefined, false, false]];
  for (const [server, device, expected] of table) expect(uiFlagResolve(server, device), `${String(server)} ${String(device)}`).toBe(expected);
 });
});

describe("the store", () => {
 it("takes the nav answer's uiFlags, tells listeners only when something changed, and forgets them when a later answer has none", () => {
  const host = hostWith(undefined), store = uiFlagsStoreOf(host), listener = vi.fn();store.subscribe(listener);
  applyNavUiFlags(host, { features: {} });expect(listener).not.toHaveBeenCalled();expect(store.get()).toBeUndefined();
  answer(host, { look: "on" });expect(listener).toHaveBeenCalledTimes(1);
  answer(host, { look: "on" });expect(listener).toHaveBeenCalledTimes(1);
  answer(host, { look: "off" });expect(listener).toHaveBeenCalledTimes(2);
  applyNavUiFlags(host, { features: {} });expect(listener).toHaveBeenCalledTimes(3);expect(store.get()).toBeUndefined();
  applyNavUiFlags(host, undefined);applyNavUiFlags(host, "nope");expect(listener).toHaveBeenCalledTimes(3);
 });
 it("follows the newest successful nav answer in the query cache, and ignores other queries", () => {
  const host = hostWith(undefined), query = new QueryClient(), stop = syncUiFlags(query.getQueryCache(), host);
  query.setQueryData(["other"], { uiFlags: { look: "on" } });expect(uiFlagServerState(host, "look")).toBeUndefined();
  query.setQueryData(["nav"], { uiFlags: { look: "on" } });expect(uiFlagServerState(host, "look")).toBe("on");
  query.setQueryData(["nav"], { uiFlags: { look: "preview" } });expect(uiFlagServerState(host, "look")).toBe("preview");
  stop();query.setQueryData(["nav"], { uiFlags: { look: "off" } });expect(uiFlagServerState(host, "look")).toBe("preview");
  query.clear();
 });
});

const SWITCHES: Array<[string, (host: { storage: { get(key: string): string | undefined; set(key: string, value: string): void } }) => boolean, UiFlagName | undefined, string]> = [
 ["isNewLookOn", isNewLookOn, "look", LOOK_STORAGE_KEY], ["isNewNavOn", isNewNavOn, "nav", NAV_STORAGE_KEY], ["isNewHomeOn", isNewHomeOn, "home", HOME_STORAGE_KEY], ["isWorkListOn", isWorkListOn, "work", WORK_STORAGE_KEY],
 ["isSpendingV2On", isSpendingV2On, "spending", SPENDING_STORAGE_KEY], ["isHealthV2On", isHealthV2On, "health", HEALTH_STORAGE_KEY], ["isProjectSetupV2On", isProjectSetupV2On, "setup", PROJECT_SETUP_STORAGE_KEY],
 ["isInsightsOn", isInsightsOn, "insights", INSIGHTS_STORAGE_KEY], ["isAgentPublishOn", isAgentPublishOn, "publish", AGENT_PUBLISH_STORAGE_KEY], ["isBillingV2On", isBillingV2On, "billing", BILLING_STORAGE_KEY],
 // The company switcher has no name among the closed list of flags: it stays on its device key, whatever the answer says.
 ["isCompanySwitcherOn", isCompanySwitcherOn, undefined, COMPANIES_STORAGE_KEY],
];
describe("each switch function", () => {
 it("keeps its device key", () => {
  expect(SWITCHES.map(([, , , key]) => key)).toEqual(["rovara.look", "rovara.nav", "rovara.home", "rovara.work", "rovara.spending", "rovara.health", "rovara.setup", "rovara.insights", "rovara.publish", "rovara.billing", "rovara.companies"]);
 });
 for (const [fn, isOn, name, key] of SWITCHES) {
  describe(fn, () => {
   const host = (value: string | undefined | "throws") => { const seen: string[] = [], base = hostWith(value);return { seen, storage: { get: (k: string) => { seen.push(k);return base.storage.get(k); }, set: base.storage.set } }; };
   it("with no server value is exactly today's device switch: on only for v2, off for anything else and when storage is blocked", () => {
    const on = host("v2");expect(isOn(on)).toBe(true);expect(on.seen).toEqual([key]);
    for (const value of [undefined, "", "v1", "true", "V2"]) expect(isOn(host(value)), String(value)).toBe(false);
    expect(isOn(host("throws"))).toBe(false);
   });
   if (name !== undefined) {
    it(`is the company's "${name}" flag: on wins, off wins, preview leaves it to the device`, () => {
     const on = host(undefined);answer(on, { [name]: "on" });expect(isOn(on)).toBe(true);
     const off = host("v2");answer(off, { [name]: "off" });expect(isOn(off)).toBe(false);
     const previewSet = host("v2"), previewUnset = host(undefined);answer(previewSet, { [name]: "preview" });answer(previewUnset, { [name]: "preview" });
     expect(isOn(previewSet)).toBe(true);expect(isOn(previewUnset)).toBe(false);
     // another flag's answer does not move this one
     const other = host("v2");answer(other, Object.fromEntries(UI_FLAG_NAMES.filter(n => n !== name).map(n => [n, "off"])));expect(isOn(other)).toBe(false);
    });
   } else {
    it("is unmoved by the company's answer", () => {
     const all = host("v2");answer(all, Object.fromEntries(UI_FLAG_NAMES.map(n => [n, "off"])));expect(isOn(all)).toBe(true);
     const none = host(undefined);answer(none, Object.fromEntries(UI_FLAG_NAMES.map(n => [n, "on"])));expect(isOn(none)).toBe(false);
    });
   }
  });
 }
});

describe("taskPageFlags (the task page's leading header)", () => {
 it("with no server value is exactly today's: off by default, ?lead=1 on, ?lead=0 off, plain notices on", () => {
  expect(taskPageFlags()).toEqual({ plainNotices: true, leadingHeader: false });
  expect(taskPageFlags("?lead=1").leadingHeader).toBe(true);expect(taskPageFlags("?lead=0").leadingHeader).toBe(false);expect(taskPageFlags("?x=1").leadingHeader).toBe(false);
 });
 it("is on for the company when the server says on, even with ?lead=0", () => {
  expect(taskPageFlags("", "on").leadingHeader).toBe(true);expect(taskPageFlags("?lead=0", "on").leadingHeader).toBe(true);
 });
 it("with preview, only ?lead=1 turns it on; with off, nothing does", () => {
  expect(taskPageFlags("", "preview").leadingHeader).toBe(false);expect(taskPageFlags("?lead=1", "preview").leadingHeader).toBe(true);expect(taskPageFlags("?lead=0", "preview").leadingHeader).toBe(false);
  expect(taskPageFlags("?lead=1", "off").leadingHeader).toBe(false);expect(taskPageFlags("", "off").leadingHeader).toBe(false);
 });
 it("never moves the plain notices", () => { for (const state of ["on", "preview", "off", undefined] as const) expect(taskPageFlags("", state).plainNotices).toBe(true); });
});
