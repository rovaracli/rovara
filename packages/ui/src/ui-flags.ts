import { useSyncExternalStore } from "react";
import type { QueryCache } from "@tanstack/react-query";
import { UI_FLAG_NAMES, type UiFlagName, type UiFlagState } from "./api/ui-flags.js";
import { useOptionalAppHost } from "./host.js";
/**
 * Runtime per-company UI flags (lane U5): the ONE place that decides whether a new screen is on. Every `isXOn(host)` (look.ts, nav-flags.ts, home-flags.ts, ...) calls `uiFlagOn` and nothing else.
 *
 * The server's answer (`uiFlags` in the navigation answer: `on`, `preview` or `off` per flag) is kept in a small store per host, filled whenever the app's `["nav"]` query succeeds (`syncUiFlags`, called once by `App`)
 * and once more, synchronously, before the route table is built (`applyNavUiFlags`, called by `Startup`).
 * The rule, kept simple on purpose:
 *   server `on`        on, for everyone in the company. A person's device cannot turn it off.
 *   server `preview`   off for the company, but the company allows previews: this device's own switch (the per-device storage key, value "v2") turns it on for THIS DEVICE ONLY.
 *   server `off`       off. The device switch does nothing (no previews allowed, or the operator forced it off). A flag the answer does not name is off too.
 *   no answer          (an older broker, a page with no navigation, a test with a bare host) the device switch decides, as it did before runtime flags existed.
 *   waiting            the app has asked for the navigation answer and it has not come yet, or the read failed (`holdUiFlagsUntilNav`, called by `App`): everything is off, the same as the server's rule for a failed read (fail closed).
 *                      The device switch does not decide until an answer arrives. A person whose device key is on may therefore see the default look for a moment on a cold load, then the new look.
 * Layout flags are read when a screen mounts (or once when the route table is built), so a change reaches a person on their next page load; the look follows the answer at once.
 */
export interface UiFlagsStorageHost { storage: { get(key: string): string | undefined } }
/** The value every per-device switch holds when it is on. */
export const UI_FLAG_DEVICE_VALUE = "v2";

type Answer = Readonly<Partial<Record<UiFlagName, UiFlagState>>>;
export interface UiFlagsStore {
  /** The server's answer, or undefined while there is none. */
  get: () => Answer | undefined;
  set: (next: unknown) => void;
  /** True from `holdUiFlagsUntilNav` until the first navigation answer is applied (even one with no `uiFlags`). */
  waiting: () => boolean;
  hold: () => void;
  /** True once `App` has told the store how this page starts (`startUiFlags`); nothing renders before that. */
  started: () => boolean;
  start: (wait: boolean) => void;
  subscribe: (listener: () => void) => () => void;
}

/** What the answer says, as states this version knows: anything else (a value a newer server added) reads as off. No object means no answer. */
function answerOf(raw: unknown): Answer | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const out: Partial<Record<UiFlagName, UiFlagState>> = {};
  for (const name of UI_FLAG_NAMES) {
    const value = (raw as Record<string, unknown>)[name];
    out[name] = value === "on" || value === "preview" ? value : "off";
  }
  return out;
}

function createStore(): UiFlagsStore {
  let answer: Answer | undefined, waiting = false, started = false;
  const listeners = new Set<() => void>();
  const tell = () => { for (const listener of [...listeners]) listener(); };
  return {
    get: () => answer,
    waiting: () => waiting,
    hold() { if (waiting || answer !== undefined) return;waiting = true;tell(); },
    started: () => started,
    start(wait) { if (started) return;started = true;if (wait && answer === undefined) waiting = true;tell(); },
    set(next) {
      const parsed = answerOf(next), wasWaiting = waiting;
      waiting = false;
      if (parsed === undefined && answer === undefined) { if (wasWaiting) tell();return; }
      if (parsed !== undefined && answer !== undefined && UI_FLAG_NAMES.every(name => parsed[name] === answer![name])) { if (wasWaiting) tell();return; }
      answer = parsed;
      tell();
    },
    subscribe(listener) { listeners.add(listener);return () => { listeners.delete(listener); }; },
  };
}

const stores = new WeakMap<object, UiFlagsStore>();
/** The host's store, made on first use (so the same host always has the same one). */
export function uiFlagsStoreOf(host: object): UiFlagsStore {
  let store = stores.get(host);
  if (store === undefined) { store = createStore();stores.set(host, store); }
  return store;
}

/** The server's state for one flag, or undefined when there is no answer (the device switch then decides). Cheap: one map read, no store is made for a host that never had an answer. */
export function uiFlagServerState(host: object, name: UiFlagName): UiFlagState | undefined {
  const answer = stores.get(host)?.get();
  return answer === undefined ? undefined : answer[name] ?? "off";
}

/** Whether the app is still waiting for its first navigation answer (or that read failed): every flag is off meanwhile. False for a host that never called `holdUiFlagsUntilNav`. */
export function uiFlagsWaiting(host: object): boolean {
  return stores.get(host)?.waiting() ?? false;
}

/** The rule above, given the server's state and whether this device's switch is on. */
export function uiFlagResolve(server: UiFlagState | undefined, deviceOn: boolean): boolean {
  if (server === "on") return true;
  if (server === undefined || server === "preview") return deviceOn;
  return false;
}

/** Whether the flag is on for this person, now. `localKey` is the per-device storage key the flag used before runtime flags (for example `rovara.nav`). Unreadable storage means the device switch is off. */
export function uiFlagOn(host: UiFlagsStorageHost, name: UiFlagName, localKey: string): boolean {
  const server = uiFlagServerState(host, name);
  if (server === "on") return true;
  if (server === "off") return false;
  if (server === undefined && uiFlagsWaiting(host)) return false;
  try { return host.storage.get(localKey) === UI_FLAG_DEVICE_VALUE; } catch { return false; }
}

/** The server's state for a flag, kept current in a component. Without a host (or an answer) it is undefined. */
export function useUiFlagServerState(name: UiFlagName): UiFlagState | undefined {
  const host = useOptionalAppHost();
  return useSyncExternalStore(
    host === undefined ? noSubscribe : uiFlagsStoreOf(host).subscribe,
    () => host === undefined ? undefined : uiFlagServerState(host, name),
    () => undefined,
  );
}
const noSubscribe = (): (() => void) => () => undefined;

/** `App` calls it from an effect, before it renders anything below it: `wait` is true on a page that reads the navigation answer, and then every flag is off (as `holdUiFlagsUntilNav`) until the answer comes; false on a page with no navigation read, which keeps the device keys. */
export function startUiFlags(host: object, wait: boolean): void {
  uiFlagsStoreOf(host).start(wait);
}

/** Whether `startUiFlags` has run for this host. `App` renders nothing until it has, so no screen reads a flag before the hold is in place. */
export function useUiFlagsStarted(host: object): boolean {
  const store = uiFlagsStoreOf(host);
  return useSyncExternalStore(store.subscribe, store.started, () => false);
}

/** The hold on its own: until `applyNavUiFlags` runs (or for good, if the navigation read fails) every flag is off, the look included. `App` uses `startUiFlags`, which also decides whether to hold. */
export function holdUiFlagsUntilNav(host: object): void {
  uiFlagsStoreOf(host).hold();
}

/** Puts a navigation answer's `uiFlags` into the host's store at once. `Startup` calls it before it reads the layout flags that build the route table. */
export function applyNavUiFlags(host: object, nav: unknown): void {
  uiFlagsStoreOf(host).set(typeof nav === "object" && nav !== null ? (nav as { uiFlags?: unknown }).uiFlags : undefined);
}

/**
 * Keeps the host's store equal to the newest successful `["nav"]` answer. `App` calls it once. The cache tells its listeners before the components that read the query are told, so a screen that mounts
 * with the nav data already sees the flags. Returns the unsubscribe.
 */
export function syncUiFlags(cache: QueryCache, host: object): () => void {
  return cache.subscribe((event) => {
    const queryKey = event.query.queryKey as readonly unknown[];
    if (event.type !== "updated" || event.action.type !== "success" || queryKey[0] !== "nav") return;
    applyNavUiFlags(host, event.query.state.data);
  });
}
