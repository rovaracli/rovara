import { uiFlagOn } from "../../ui-flags.js";
/**
 * The Spending page switch (lane exp/spending). On by default in the server's answer (decision 116). Off, the budgets page and the usage page stay exactly as they were.
 * Today the switch is a per-device storage key (`rovara.spending` = "v2"), the same kind of switch as `isNewLookOn` in `look.ts`: no contract change, no broker change.
 * Runtime per-company flag (lane U5): this function calls `uiFlagOn` (ui-flags.ts): the company's value from the navigation answer wins when it is on or off, and this device's key only decides when the company allows previews or the server sends no answer.
 */
export interface SpendingStorageHost { storage: { get(key: string): string | undefined } }
export const SPENDING_STORAGE_KEY = "rovara.spending";
export function isSpendingV2On(host: SpendingStorageHost): boolean {
 return uiFlagOn(host, "spending", SPENDING_STORAGE_KEY);
}
