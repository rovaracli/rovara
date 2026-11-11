/**
 * The new-navigation switch. This file is the ONLY place that decides whether the v2 app shell navigation is on.
 * Today the switch is a per-device storage key (`rovara.nav` = "v2"), the same cheap switch the v2 look uses (look.ts): no contract change, no broker change.
 * When a per-company runtime flag exists, change `isNewNavOn` to read it (from the nav answer or a host field) and nothing else moves:
 * the shell and the route table only call this function.
 */
export interface NavStorageHost { storage: { get(key: string): string | undefined; set(key: string, value: string): void } }
export const NAV_STORAGE_KEY = "rovara.nav";
export function isNewNavOn(host: NavStorageHost): boolean {
 try { return host.storage.get(NAV_STORAGE_KEY) === "v2"; } catch { return false; }
}

/**
 * What this app calls the page that lists tasks, in its own sentences and links: "Work" with the new navigation on (`rovara.nav`; `/app/live` already redirects there), "Live" with it off (as today).
 * Only in-screen copy and links use this; the route table and the sidebar already decide for themselves.
 */
export function workPlace(host: NavStorageHost): { name: "Work" | "Live"; path: string } {
 return isNewNavOn(host) ? { name: "Work", path: "/app/work" } : { name: "Live", path: "/app/live" };
}
