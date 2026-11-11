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
