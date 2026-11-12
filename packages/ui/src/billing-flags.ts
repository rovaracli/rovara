import { uiFlagOn } from "./ui-flags.js";
/**
 * The trial and billing switch (lane exp/trial-billing). Off by default: with it off there is no trial page, no Billing settings page, no Billing link and no trial banner, and the app is exactly today's.
 * Today the switch is a per-device storage key (`rovara.billing` = "v2"), the same kind of switch as the other `*-flags.ts` files: no contract change, no broker change.
 * Runtime per-company flag (lane U5): this function calls `uiFlagOn` (ui-flags.ts): the company's value from the navigation answer wins when it is on or off, and this device's key only decides when the company allows previews or the server sends no answer: the route table, the settings navigation and the shell only call it.
 * (This is the device switch. The server has its own: with `BillingEnabled` off the billing reads answer 404 and the Billing page says so.)
 */
export interface BillingStorageHost { storage: { get(key: string): string | undefined } }
export const BILLING_STORAGE_KEY = "rovara.billing";
export function isBillingV2On(host: BillingStorageHost): boolean {
 return uiFlagOn(host, "billing", BILLING_STORAGE_KEY);
}
