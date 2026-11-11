/**
 * The Health and readiness switch (lane exp/health-readiness). Off by default: the Health page and the admin overview stay exactly as they were.
 * Today the switch is a per-device storage key (`rovara.health` = "v2"), the same kind of switch as `isNewLookOn` in `look.ts`: no contract change, no broker change.
 * When per-company runtime flags exist, change this one function and nothing else moves.
 */
export interface HealthStorageHost { storage: { get(key: string): string | undefined } }
export const HEALTH_STORAGE_KEY = "rovara.health";
export function isHealthV2On(host: HealthStorageHost): boolean {
 try { return host.storage.get(HEALTH_STORAGE_KEY) === "v2"; } catch { return false; }
}
