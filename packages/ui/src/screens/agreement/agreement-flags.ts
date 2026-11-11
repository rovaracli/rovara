import type { LookStorageHost } from "../../look.js";
import { uiFlagOn } from "../../ui-flags.js";
/**
 * The Working agreement switch (experience lane exp/working-agreement). This file is the ONLY place that decides whether the panel is on.
 * Today it is a per-device storage key (`rovara.agreement` = "v2"), the same cheap switch the new look uses (`isNewLookOn` in look.ts): no contract change, no broker change.
 * Off by default: the project page and the task page are exactly as they were. Runtime per-company flag (lane U5): this function calls `uiFlagOn` (ui-flags.ts): the company's value from the navigation answer wins when it is on or off, and this device's key only decides when the company allows previews or the server sends no answer.
 */
export const AGREEMENT_STORAGE_KEY = "rovara.agreement";
export function isWorkingAgreementOn(host: LookStorageHost): boolean {
 return uiFlagOn(host, "agreement", AGREEMENT_STORAGE_KEY);
}
