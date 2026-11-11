/**
 * The trial and billing switch (lane exp/trial-billing). Off by default: with it off there is no trial page, no Billing settings page, no Billing link and no trial banner, and the app is exactly today's.
 * Today the switch is a per-device storage key (`rovara.billing` = "v2"), the same kind of switch as `isNewLookOn` in `look.ts`: no contract change, no broker change.
 * When per-company runtime flags exist, change this one function and nothing else moves: the route table, the settings navigation and the shell only call it.
 * (This is the device switch. The server has its own: with `BillingEnabled` off the billing reads answer 404 and the Billing page says so.)
 */
export interface BillingStorageHost { storage: { get(key: string): string | undefined } }
export const BILLING_STORAGE_KEY = "rovara.billing";
export function isBillingV2On(host: BillingStorageHost): boolean {
 try { return host.storage.get(BILLING_STORAGE_KEY) === "v2"; } catch { return false; }
}
