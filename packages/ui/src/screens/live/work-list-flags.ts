import type { LookStorageHost } from "../../look.js";
import { uiFlagOn } from "../../ui-flags.js";
/**
 * The Work list switch (experience lane exp/work-list). This file is the ONLY place that decides whether today's Live list or the Work list is shown.
 * Today the switch is a per-device storage key (`rovara.work` = "v2"), the same kind of switch as `isNewLookOn` in look.ts: no contract change, no broker change.
 * Runtime per-company flag (lane U5): this function calls `uiFlagOn` (ui-flags.ts): the company's value from the navigation answer wins when it is on or off, and this device's key only decides when the company allows previews or the server sends no answer: `LiveScreen` only calls this function.
 * Off means today's Live list, unchanged. A company's server answer is `on` by default (decision 116); off is a company that sent it back, or the operator's override.
 */
export const WORK_STORAGE_KEY = "rovara.work";
export function isWorkListOn(host: LookStorageHost): boolean {
 return uiFlagOn(host, "work", WORK_STORAGE_KEY);
}
