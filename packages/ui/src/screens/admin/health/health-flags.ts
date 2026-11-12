import { uiFlagOn } from "../../../ui-flags.js";
/**
 * The Health and readiness switch (lane exp/health-readiness). Off by default: the Health page and the admin overview stay exactly as they were.
 * Today the switch is a per-device storage key (`rovara.health` = "v2"), the same kind of switch as the other `*-flags.ts` files: no contract change, no broker change.
 * Runtime per-company flag (lane U5): this function calls `uiFlagOn` (ui-flags.ts): the company's value from the navigation answer wins when it is on or off, and this device's key only decides when the company allows previews or the server sends no answer.
 */
export interface HealthStorageHost { storage: { get(key: string): string | undefined } }
export const HEALTH_STORAGE_KEY = "rovara.health";
export function isHealthV2On(host: HealthStorageHost): boolean {
 return uiFlagOn(host, "health", HEALTH_STORAGE_KEY);
}
