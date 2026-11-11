import { uiFlagOn } from "./ui-flags.js";
/**
 * The new-navigation switch. This file is the ONLY place that decides whether the v2 app shell navigation is on.
 * Today the switch is a per-device storage key (`rovara.nav` = "v2"), the same cheap switch the v2 look uses (look.ts): no contract change, no broker change.
 * Runtime per-company flag (lane U5): this function calls `uiFlagOn` (ui-flags.ts): the company's value from the navigation answer wins when it is on or off, and this device's key only decides when the company allows previews or the server sends no answer.
 * The shell and the route table only call this function.
 */
export interface NavStorageHost { storage: { get(key: string): string | undefined; set(key: string, value: string): void } }
export const NAV_STORAGE_KEY = "rovara.nav";
export function isNewNavOn(host: NavStorageHost): boolean {
 return uiFlagOn(host, "nav", NAV_STORAGE_KEY);
}
