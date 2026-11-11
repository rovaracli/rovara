import { uiFlagOn } from "../../ui-flags.js";
/**
 * The Spending page switch (lane exp/spending). Off by default: the budgets page and the usage page stay exactly as they were.
 * Today the switch is a per-device storage key (`rovara.spending` = "v2"), the same kind of switch as `isNewLookOn` in `look.ts`: no contract change, no broker change.
 * Runtime per-company flags (lane U5): `uiFlagOn` reads the server flag `spending` first; this device's key is then only a preview where the company allows previews.
 */
export interface SpendingStorageHost { storage: { get(key: string): string | undefined } }
export const SPENDING_STORAGE_KEY = "rovara.spending";
export function isSpendingV2On(host: SpendingStorageHost): boolean {
 return uiFlagOn(host, "spending", SPENDING_STORAGE_KEY);
}
