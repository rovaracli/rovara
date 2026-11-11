import type { LookStorageHost } from "../../look.js";
/**
 * The Working agreement switch (experience lane exp/working-agreement). This file is the ONLY place that decides whether the panel is on.
 * Today it is a per-device storage key (`rovara.agreement` = "v2"), the same cheap switch the new look uses (`isNewLookOn` in look.ts): no contract change, no broker change.
 * Off by default: the project page and the task page are exactly as they were. When per-company runtime flags exist, change this one function and nothing else moves.
 */
export const AGREEMENT_STORAGE_KEY = "rovara.agreement";
export function isWorkingAgreementOn(host: LookStorageHost): boolean {
 try { return host.storage.get(AGREEMENT_STORAGE_KEY) === "v2"; } catch { return false; }
}
