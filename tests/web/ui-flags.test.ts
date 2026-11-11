// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavReaderSchema, AppNavSchema, UI_FLAG_NAMES, type UiFlagName, type UiFlagState } from "@agentx/contracts/web";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { LOOK_STORAGE_KEY, isNewLookOn } from "../../packages/ui/src/look.js";
import { NAV_STORAGE_KEY, isNewNavOn } from "../../packages/ui/src/nav-flags.js";
import { HOME_STORAGE_KEY, isNewHomeOn } from "../../packages/ui/src/screens/home/home-flags.js";
import { SPENDING_STORAGE_KEY, isSpendingV2On } from "../../packages/ui/src/screens/admin/spending-flags.js";
import { WORK_STORAGE_KEY, isWorkListOn } from "../../packages/ui/src/screens/live/work-list-flags.js";
import { taskPageFlags } from "../../packages/ui/src/screens/session/task-page-flags.js";
import { syncUiFlags, uiFlagOn, uiFlagsStoreOf } from "../../packages/ui/src/ui-flags.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";

// Runtime per-company UI flags (lane U5): every isXOn(host) reads the server flag first; this device's key is only a preview where the company allows previews.

type Check = { name: UiFlagName; key: string; on: (host: { storage: { get: (key: string) => string | undefined; set: (key: string, value: string) => void } }) => boolean };
const CHECKS: Check[] = [
  { name: "look", key: LOOK_STORAGE_KEY, on: isNewLookOn }, { name: "nav", key: NAV_STORAGE_KEY, on: isNewNavOn }, { name: "home", key: HOME_STORAGE_KEY, on: isNewHomeOn },
  { name: "work", key: WORK_STORAGE_KEY, on: isWorkListOn }, { name: "spending", key: SPENDING_STORAGE_KEY, on: isSpendingV2On },
];
const hostWith = (device: string | undefined) => ({ storage: { get: () => device, set: () => undefined } });
const answer = (state: UiFlagState, only?: UiFlagName) => Object.fromEntries(UI_FLAG_NAMES.map((name) => [name, only === undefined || only === name ? state : "off"]));

describe("each isXOn honours the server flag", () => {
  for (const check of CHECKS) {
    describe(check.name, () => {
      it("uses the device key alone while there is no server answer (an older broker)", () => {
        expect(check.on(hostWith(undefined))).toBe(false);
        expect(check.on(hostWith("v2"))).toBe(true);
        expect(check.on(hostWith("v1"))).toBe(false);
      });
      it("is on for everyone when the server says on, whatever the device key says", () => {
        for (const device of [undefined, "v2", "v1", "off"]) { const host = hostWith(device);uiFlagsStoreOf(host).set(answer("on"));expect(check.on(host), String(device)).toBe(true); }
      });
      it("is off by default: a server that says off ignores the device key (no previews allowed, or held back by the operator)", () => {
        for (const device of [undefined, "v2"]) { const host = hostWith(device);uiFlagsStoreOf(host).set(answer("off"));expect(check.on(host), String(device)).toBe(false); }
      });
      it("is a preview on this device only when the server says preview and the device key is v2", () => {
        const withKey = hostWith("v2"), without = hostWith(undefined), wrong = hostWith("v1");
        for (const host of [withKey, without, wrong]) uiFlagsStoreOf(host).set(answer("preview"));
        expect(check.on(withKey)).toBe(true);expect(check.on(without)).toBe(false);expect(check.on(wrong)).toBe(false);
      });
      it("reads only its own flag", () => {
        const host = hostWith("v2");uiFlagsStoreOf(host).set(answer("on", check.name === "look" ? "nav" : "look"));
        expect(check.on(host)).toBe(false);
      });
      it("is off when the answer does not name it, off when a state is one this version does not know, and on again from the device key after the answer is cleared", () => {
        const host = hostWith("v2");const store = uiFlagsStoreOf(host);
        store.set({});expect(check.on(host)).toBe(false);
        store.set({ [check.name]: "someday" });expect(check.on(host)).toBe(false);
        store.set(answer("off"));expect(check.on(host)).toBe(false);
        store.set(undefined);expect(check.on(host)).toBe(true);
      });
      it("is off when the device store is blocked, unless the server says on", () => {
        const blocked = { storage: { get: () => { throw new Error("blocked"); }, set: () => undefined } };
        expect(check.on(blocked)).toBe(false);
        uiFlagsStoreOf(blocked).set(answer("preview"));expect(check.on(blocked)).toBe(false);
        uiFlagsStoreOf(blocked).set(answer("on"));expect(check.on(blocked)).toBe(true);
      });
    });
  }
});

describe("the task page header flag", () => {
  it("follows the server: on shows it, off hides it, preview lets ?lead=1 show it, and no answer leaves ?lead= as it was", () => {
    expect(taskPageFlags("").leadingHeader).toBe(false);
    expect(taskPageFlags("?lead=1").leadingHeader).toBe(true);
    expect(taskPageFlags("?lead=0").leadingHeader).toBe(false);
    expect(taskPageFlags("", "on").leadingHeader).toBe(true);
    expect(taskPageFlags("?lead=0", "on").leadingHeader).toBe(true);
    expect(taskPageFlags("", "off").leadingHeader).toBe(false);
    expect(taskPageFlags("?lead=1", "off").leadingHeader).toBe(false);
    expect(taskPageFlags("?lead=1", "preview").leadingHeader).toBe(true);
    expect(taskPageFlags("", "preview").leadingHeader).toBe(false);
    expect(taskPageFlags("", "on")).toEqual({ plainNotices: true, leadingHeader: true });
  });
});

describe("uiFlagOn", () => {
  it("never reads storage when the server says on or off", () => {
    let reads = 0;
    const host = { storage: { get: () => { reads += 1;return "v2"; } } };
    uiFlagsStoreOf(host).set(answer("on"));expect(uiFlagOn(host, "look", "k")).toBe(true);
    uiFlagsStoreOf(host).set(answer("off"));expect(uiFlagOn(host, "look", "k")).toBe(false);
    expect(reads).toBe(0);
    uiFlagsStoreOf(host).set(answer("preview"));expect(uiFlagOn(host, "look", "k")).toBe(true);
    expect(reads).toBe(1);
  });
});

describe("the navigation answer", () => {
  const base = { me: { developerId: "a".repeat(64), name: "Priya", orgRole: "member" }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features: { localAgents: false, usage: false, admin: false, chains: false, notices: false, describe: false } };
  it("carries uiFlags, optional as a whole and key by key", () => {
    expect(AppNavSchema.parse(base).uiFlags).toBeUndefined();
    expect(AppNavSchema.parse({ ...base, uiFlags: answer("on") }).uiFlags?.look).toBe("on");
    expect(AppNavSchema.parse({ ...base, uiFlags: { look: "preview" } }).uiFlags).toEqual({ look: "preview" });
    expect(AppNavSchema.safeParse({ ...base, uiFlags: { notAFlag: "on" } }).success).toBe(false);
    expect(AppNavSchema.safeParse({ ...base, uiFlags: { look: "yes" } }).success).toBe(false);
  });
  it("is read forward-compatibly: a flag or state a newer server adds does not break the answer", () => {
    const read = AppNavReaderSchema.parse({ ...base, uiFlags: { look: "on", brandNewScreen: "on", nav: "sometimes" } });
    expect(read.uiFlags?.look).toBe("on");
  });
});

describe("the host's flag store follows the navigation query", () => {
  const navData = (uiFlags?: unknown) => ({ me: { developerId: "a".repeat(64), name: "Priya", orgRole: "member" }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features: { localAgents: false, usage: false, admin: false, chains: false, notices: false, describe: false }, ...(uiFlags === undefined ? {} : { uiFlags }) });
  it("sets the store from a successful nav answer, replaces it on a refetch, and clears it when the answer has none; other queries do nothing", () => {
    const f = fakeHost(), query = createQueryClient(), stop = syncUiFlags(query.getQueryCache(), f.host);
    expect(isNewHomeOn(f.host)).toBe(false);
    query.setQueryData(["nav"], navData(answer("on", "home")));
    expect(isNewHomeOn(f.host)).toBe(true);expect(isNewNavOn(f.host)).toBe(false);
    query.setQueryData(["other"], navData(answer("off")));
    expect(isNewHomeOn(f.host)).toBe(true);
    query.setQueryData(["nav"], navData(answer("off", "home")));
    expect(isNewHomeOn(f.host)).toBe(false);
    f.storage.set(HOME_STORAGE_KEY, "v2");
    expect(isNewHomeOn(f.host)).toBe(false);
    query.setQueryData(["nav"], navData(answer("preview", "home")));
    expect(isNewHomeOn(f.host)).toBe(true);
    query.setQueryData(["nav"], navData());
    expect(isNewHomeOn(f.host)).toBe(true);
    f.storage.set(HOME_STORAGE_KEY, "v1");
    expect(isNewHomeOn(f.host)).toBe(false);
    stop();query.setQueryData(["nav"], navData(answer("on")));
    expect(isNewHomeOn(f.host)).toBe(false);
    query.clear();
  });

  it("turns the new look on in the theme as soon as the answer says on, and off again when it says off", async () => {
    const f = fakeHost(), query = createQueryClient(), stop = syncUiFlags(query.getQueryCache(), f.host);
    const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h("div", null, "x") }) }) }));
    expect(document.documentElement.getAttribute("data-look")).toBeNull();
    act(() => { query.setQueryData(["nav"], navData(answer("on", "look"))); });
    await waitFor(() => expect(document.documentElement.getAttribute("data-look")).toBe("v2"));
    act(() => { query.setQueryData(["nav"], navData(answer("off"))); });
    await waitFor(() => expect(document.documentElement.getAttribute("data-look")).toBeNull());
    ui.unmount();stop();query.clear();
  });
});
