/**
 * The company-switcher switch. This file is the ONLY place that decides whether several companies per sign-in are on in the app.
 * Today the switch is a per-device storage key (`rovara.companies` = "v2"), the same cheap switch the v2 look and navigation use (look.ts, nav-flags.ts): no contract change, no broker change.
 * Off, the header is exactly as it was and the companies route is never called. When the server answers `activeCompanyId` and `companyCount` on the nav answer, change `isCompanySwitcherOn` to read them and nothing else moves.
 */
export interface CompanyStorageHost { storage: { get(key: string): string | undefined; set(key: string, value: string): void } }
export const COMPANIES_STORAGE_KEY = "rovara.companies";
export function isCompanySwitcherOn(host: CompanyStorageHost): boolean {
 try { return host.storage.get(COMPANIES_STORAGE_KEY) === "v2"; } catch { return false; }
}
