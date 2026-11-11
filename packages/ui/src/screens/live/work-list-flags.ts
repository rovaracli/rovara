import type { LookStorageHost } from "../../look.js";
import { uiFlagOn } from "../../ui-flags.js";
/**
 * The Work list switch (experience lane exp/work-list). This file is the ONLY place that decides whether today's Live list or the Work list is shown.
 * Today the switch is a per-device storage key (`rovara.work` = "v2"), the same kind of switch as `isNewLookOn` in look.ts: no contract change, no broker change.
 * Runtime per-company flags (lane U5): `uiFlagOn` reads the server flag `work` first; this device's key is then only a preview where the company allows previews. `LiveScreen` only calls this function.
 * Off (the default) means today's Live list, unchanged.
 */
export const WORK_STORAGE_KEY = "rovara.work";
export function isWorkListOn(host: LookStorageHost): boolean {
 return uiFlagOn(host, "work", WORK_STORAGE_KEY);
}
