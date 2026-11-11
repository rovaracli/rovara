import type { LookStorageHost } from "../../look.js";
/**
 * The Work list switch (experience lane exp/work-list). This file is the ONLY place that decides whether today's Live list or the Work list is shown.
 * Today the switch is a per-device storage key (`rovara.work` = "v2"), the same kind of switch as `isNewLookOn` in look.ts: no contract change, no broker change.
 * When per-company runtime flags exist, change `isWorkListOn` to read the flag (from the nav answer or a host field) and nothing else moves: `LiveScreen` only calls this function.
 * Off (the default) means today's Live list, unchanged.
 */
export const WORK_STORAGE_KEY = "rovara.work";
export function isWorkListOn(host: LookStorageHost): boolean {
 try { return host.storage.get(WORK_STORAGE_KEY) === "v2"; } catch { return false; }
}
