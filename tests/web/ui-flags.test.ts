// @vitest-environment jsdom
// Lane U5: runtime per-company UI flags. `uiFlagOn` and the switch functions that call it. Decision 125: the eight finished screens have no switch any more; the six left are the screens still being finished.
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { applyNavUiFlags, syncUiFlags, uiFlagOn, uiFlagResolve, uiFlagServerState, uiFlagsStoreOf, UI_FLAG_DEVICE_VALUE } from "../../packages/ui/src/ui-flags.js";
import { UI_FLAG_NAMES, type UiFlagName } from "../../packages/ui/src/api/ui-flags.js";
import { isHealthV2On, HEALTH_STORAGE_KEY } from "../../packages/ui/src/screens/admin/health/health-flags.js";
import { isProjectSetupV2On, PROJECT_SETUP_STORAGE_KEY } from "../../packages/ui/src/screens/onboarding/project-setup-flags.js";
import { isAgentPublishOn, AGENT_PUBLISH_STORAGE_KEY } from "../../packages/ui/src/screens/agents/publish-flags.js";
import { isBillingV2On, BILLING_STORAGE_KEY } from "../../packages/ui/src/billing-flags.js";
import { isWorkingAgreementOn, AGREEMENT_STORAGE_KEY } from "../../packages/ui/src/screens/agreement/agreement-flags.js";
import { isCompanySwitcherOn, COMPANIES_STORAGE_KEY } from "../../packages/ui/src/company-flags.js";

// A fresh host per test: the server's answer is kept per host object.
const hostWith = (value: string | undefined) => ({ storage: { get: (key: string) => { if (value === "throws") throw new Error("blocked " + key);return value; }, set: () => undefined } });
const answer = (host: object, states: Partial<Record<UiFlagName, string>>) => { applyNavUiFlags(host, { uiFlags: states }); };
afterEach(() => { vi.restoreAllMocks(); });

describe("uiFlagOn", () => {
 it("with no server value (an older server) is today's per-device key: on only for exactly v2", () => {
  expect(UI_FLAG_DEVICE_VALUE).toBe("v2");
  expect(uiFlagOn(hostWith("v2"), "health", "rovara.health")).toBe(true);
  for (const value of [undefined, "", "v1", "V2", "true", "1", "v2 "]) expect(uiFlagOn(hostWith(value), "health", "rovara.health"), String(value)).toBe(false);
  expect(uiFlagOn(hostWith("throws"), "health", "rovara.health")).toBe(false);
 });
 it("reads the key it is given, not another", () => {
  const seen: string[] = [], host = { storage: { get: (key: string) => { seen.push(key);return "v2"; } } };
  expect(uiFlagOn(host, "setup", "rovara.setup")).toBe(true);expect(seen).toEqual(["rovara.setup"]);
 });
 it("is on for the company when the server says on, whatever the device key says", () => {
  for (const value of [undefined, "v2", "v1", "throws"]) { const host = hostWith(value);answer(host, { health: "on" });expect(uiFlagOn(host, "health", "rovara.health"), String(value)).toBe(true); }
 });
 it("is off when the server says off, even where the device key says v2 (no preview allowed, or the operator forced it off)", () => {
  const host = hostWith("v2");answer(host, { health: "off" });expect(uiFlagOn(host, "health", "rovara.health")).toBe(false);
 });
 it("with preview lets this device decide: on with the key set, off without it or when storage throws", () => {
  const set = hostWith("v2"), unset = hostWith(undefined), blocked = hostWith("throws");
  for (const host of [set, unset, blocked]) answer(host, { billing: "preview" });
  expect(uiFlagOn(set, "billing", "rovara.billing")).toBe(true);expect(uiFlagOn(unset, "billing", "rovara.billing")).toBe(false);expect(uiFlagOn(blocked, "billing", "rovara.billing")).toBe(false);
 });
 it("reads each flag by its own name: one flag's state never leaks into another", () => {
  const host = hostWith("v2");answer(host, { health: "on", billing: "off", setup: "preview" });
  expect(uiFlagOn(host, "health", "k")).toBe(true);expect(uiFlagOn(host, "billing", "k")).toBe(false);expect(uiFlagOn(host, "setup", "k")).toBe(true);
  // a name the answer does not carry is off, no preview
  expect(uiFlagServerState(host, "publish")).toBe("off");expect(uiFlagOn(host, "publish", "k")).toBe(false);
 });
 it("reads a state a newer server invented as off", () => {
  const host = hostWith("v2");answer(host, { health: "someday" });expect(uiFlagServerState(host, "health")).toBe("off");expect(uiFlagOn(host, "health", "k")).toBe(false);
 });
 it("makes no store for a host that never had an answer (cheap on the common path)", () => {
  const host = hostWith("v2");expect(uiFlagServerState(host, "health")).toBeUndefined();expect(uiFlagOn(host, "health", "k")).toBe(true);
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
  answer(host, { health: "on" });expect(listener).toHaveBeenCalledTimes(1);
  answer(host, { health: "on" });expect(listener).toHaveBeenCalledTimes(1);
  answer(host, { health: "off" });expect(listener).toHaveBeenCalledTimes(2);
  applyNavUiFlags(host, { features: {} });expect(listener).toHaveBeenCalledTimes(3);expect(store.get()).toBeUndefined();
  applyNavUiFlags(host, undefined);applyNavUiFlags(host, "nope");expect(listener).toHaveBeenCalledTimes(3);
 });
 it("follows the newest successful nav answer in the query cache, and ignores other queries", () => {
  const host = hostWith(undefined), query = new QueryClient(), stop = syncUiFlags(query.getQueryCache(), host);
  query.setQueryData(["other"], { uiFlags: { health: "on" } });expect(uiFlagServerState(host, "health")).toBeUndefined();
  query.setQueryData(["nav"], { uiFlags: { health: "on" } });expect(uiFlagServerState(host, "health")).toBe("on");
  query.setQueryData(["nav"], { uiFlags: { health: "preview" } });expect(uiFlagServerState(host, "health")).toBe("preview");
  stop();query.setQueryData(["nav"], { uiFlags: { health: "off" } });expect(uiFlagServerState(host, "health")).toBe("preview");
  query.clear();
 });
});

const SWITCHES: Array<[string, (host: { storage: { get(key: string): string | undefined; set(key: string, value: string): void } }) => boolean, UiFlagName | undefined, string]> = [
 ["isHealthV2On", isHealthV2On, "health", HEALTH_STORAGE_KEY], ["isProjectSetupV2On", isProjectSetupV2On, "setup", PROJECT_SETUP_STORAGE_KEY],
 ["isAgentPublishOn", isAgentPublishOn, "publish", AGENT_PUBLISH_STORAGE_KEY], ["isBillingV2On", isBillingV2On, "billing", BILLING_STORAGE_KEY], ["isWorkingAgreementOn", isWorkingAgreementOn, "agreement", AGREEMENT_STORAGE_KEY],
 ["isCompanySwitcherOn", isCompanySwitcherOn, "companies", COMPANIES_STORAGE_KEY],
];
describe("each switch function", () => {
 it("keeps its device key", () => {
  expect(SWITCHES.map(([, , , key]) => key)).toEqual(["rovara.health", "rovara.setup", "rovara.publish", "rovara.billing", "rovara.agreement", "rovara.companies"]);
  expect(SWITCHES.map(([, , name]) => name)).toEqual([...UI_FLAG_NAMES]);
 });
 for (const [fn, isOn, name, key] of SWITCHES) {
  describe(fn, () => {
   const host = (value: string | undefined) => { const seen: string[] = [], base = hostWith(value);return { seen, storage: { get: (k: string) => { seen.push(k);return base.storage.get(k); }, set: base.storage.set } }; };
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

describe("the finished screens (decision 125)", () => {
 it("are no flags: the store keeps only the names that are left, so an older broker's answer that still names them changes nothing", () => {
  const host = hostWith(undefined);answer(host, { look: "off", nav: "off", home: "off", work: "off", spending: "off", leadingHeader: "off", insights: "off", continue: "off", health: "on" } as never);
  expect(Object.keys(uiFlagsStoreOf(host).get() ?? {})).toEqual([...UI_FLAG_NAMES]);
  expect(uiFlagServerState(host, "health")).toBe("on");
 });
});
