/**
 * The new-navigation switch. This file is the ONLY place that decides whether the v2 app shell navigation is on.
 * Today the switch is a per-device storage key (`rovara.nav` = "v2"), the same cheap switch the v2 look uses (look.ts): no contract change, no broker change.
 * Runtime per-company flags (lane U5): `uiFlagOn` reads the server flag `nav` first (ui-flags.ts); this device's key is then only a preview where the company allows previews.
 * The shell and the route table only call this function.
 */
import { uiFlagOn } from "./ui-flags.js";
export interface NavStorageHost { storage: { get(key: string): string | undefined; set(key: string, value: string): void } }
export const NAV_STORAGE_KEY = "rovara.nav";
export function isNewNavOn(host: NavStorageHost): boolean {
 return uiFlagOn(host, "nav", NAV_STORAGE_KEY);
}
