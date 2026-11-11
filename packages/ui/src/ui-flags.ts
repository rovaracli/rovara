import { useSyncExternalStore } from "react";
import type { QueryCache } from "@tanstack/react-query";
import { UI_FLAG_NAMES, type UiFlagName, type UiFlagState } from "@agentx/contracts/web";
import { useOptionalAppHost } from "./host.js";
/**
 * Runtime per-company UI flags (lane U5): the ONE place that decides whether a new screen is on. Every `isXOn(host)` (look.ts, nav-flags.ts, home-flags.ts, ...) calls `uiFlagOn` and nothing else.
 *
 * The server's answer (`uiFlags` in the navigation answer: `on`, `preview` or `off` per flag) is kept in a small store per host, filled whenever the app's `["nav"]` query succeeds (`syncUiFlags`, called once by `App`).
 * The rule, kept simple on purpose:
 *   server `on`        on, for everyone in the company. A person's device cannot turn it off.
 *   server `preview`   off for the company, but the company allows previews: this device's own switch (the older per-device storage key, value "v2") turns it on for THIS DEVICE ONLY.
 *   server `off`       off. The device switch does nothing (no previews allowed, or the operator forced it off). A flag the answer does not name is off too.
 *   no answer          (an older broker, a page with no navigation, a test with a bare host) the device switch decides, as it did before runtime flags existed.
 * Layout flags are read when a screen mounts, so a change reaches a person on their next page load (the app does not move its layout under them); the look follows the answer at once.
 */
export interface UiFlagsStorageHost { storage: { get(key: string): string | undefined } }
/** The value every per-device switch holds when it is on. */
export const UI_FLAG_DEVICE_VALUE = "v2";

type Answer = Readonly<Partial<Record<UiFlagName, UiFlagState>>>;
export interface UiFlagsStore {
  /** The server's answer, or undefined while there is none. */
  get: () => Answer | undefined;
  set: (next: unknown) => void;
  subscribe: (listener: () => void) => () => void;
}

/** What the answer says, as states this version knows: anything else (a value a newer server added) reads as off. */
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
  let answer: Answer | undefined;
  const listeners = new Set<() => void>();
  return {
    get: () => answer,
    set(next) {
      const parsed = answerOf(next);
      if (parsed === undefined && answer === undefined) return;
      if (parsed !== undefined && answer !== undefined && UI_FLAG_NAMES.every(name => parsed[name] === answer![name])) return;
      answer = parsed;
      for (const listener of [...listeners]) listener();
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

/** The server's state for one flag, or undefined when there is no answer (the device switch then decides). */
export function uiFlagServerState(host: object, name: UiFlagName): UiFlagState | undefined {
  const answer = stores.get(host)?.get();
  return answer === undefined ? undefined : answer[name] ?? "off";
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
  // The device's key matters only where the server leaves the choice to the device (a preview) or has no answer: a server on or off never reads it.
  if (server === "on") return true;
  if (server === "off") return false;
  try { return uiFlagResolve(server, host.storage.get(localKey) === UI_FLAG_DEVICE_VALUE); } catch { return false; }
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

/**
 * Keeps the host's store equal to the newest successful `["nav"]` answer. `App` calls it once. The cache tells its listeners before the components that read the query are told, so a screen that mounts
 * with the nav data already sees the flags. Returns the unsubscribe.
 */
export function syncUiFlags(cache: QueryCache, host: object): () => void {
  const store = uiFlagsStoreOf(host);
  return cache.subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "success" || (event.query.queryKey as readonly unknown[])[0] !== "nav") return;
    const data = event.query.state.data as { uiFlags?: unknown } | undefined;
    store.set(data?.uiFlags);
  });
}
