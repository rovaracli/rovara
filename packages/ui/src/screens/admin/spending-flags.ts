/**
 * The Spending page switch (lane exp/spending). Off by default: the budgets page and the usage page stay exactly as they were.
 * Today the switch is a per-device storage key (`rovara.spending` = "v2"), the same kind of switch as `isNewLookOn` in `look.ts`: no contract change, no broker change.
 * When per-company runtime flags exist, change this one function and nothing else moves.
 */
export interface SpendingStorageHost { storage: { get(key: string): string | undefined } }
export const SPENDING_STORAGE_KEY = "rovara.spending";
export function isSpendingV2On(host: SpendingStorageHost): boolean {
 try { return host.storage.get(SPENDING_STORAGE_KEY) === "v2"; } catch { return false; }
}
