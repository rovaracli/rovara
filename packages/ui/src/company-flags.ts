import { uiFlagOn, uiFlagResolve, uiFlagServerState } from "./ui-flags.js";
/**
 * The company-switcher switch. This file is the ONLY place that decides whether several companies per sign-in are on in the app.
 * Runtime per-company flag (lane U5, decision 98): `isCompanySwitcherOn` calls `uiFlagOn` (ui-flags.ts) with the flag `companies`: the company's value from the navigation answer wins when it is on or off, and this
 * device's key (`rovara.companies` = "v2") only decides when the company allows previews or the server sends no answer (an older broker, or a page with no navigation read). The shell reads it once, after the answer.
 * Off, the header is exactly as it was and the companies route is never called.
 */
export interface CompanyStorageHost { storage: { get(key: string): string | undefined; set(key: string, value: string): void } }
export const COMPANIES_STORAGE_KEY = "rovara.companies";
export function isCompanySwitcherOn(host: CompanyStorageHost): boolean {
 return uiFlagOn(host, "companies", COMPANIES_STORAGE_KEY);
}
/**
 * Whether the browser host's transport names the page's company on a request (packages/web/src/browser-host.ts). Once the navigation answer is in, exactly `isCompanySwitcherOn`. Before it, while the app waits for that
 * answer, this device's key decides, as it did before runtime flags: the navigation read itself is company-specific, so a device that has the switch on still names its company on that first read (the header only
 * narrows what the server answers; it never shows anything). A company whose answer then says off stops the header from the next request on.
 */
export function isCompanyHeaderOn(host: CompanyStorageHost): boolean {
 const server = uiFlagServerState(host, "companies");
 let device: boolean;
 try { device = host.storage.get(COMPANIES_STORAGE_KEY) === "v2"; } catch { device = false; }
 return uiFlagResolve(server, device);
}
