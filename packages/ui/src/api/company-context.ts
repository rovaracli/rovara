// The page's idea of "which company am I in", for the company switcher (switch: company-flags.ts). Kept tiny and free of zod and React: it is in the first download, and everything else the switcher needs is lazy.
// Contract (briefs/company-memberships-api.md section 5): every browser request carries `x-rovara-company: <companyId>`, the company the page believes it is in. The server answers 403 CSRF_STALE ("Your company changed in another tab. Reloading.")
// when that is not the session's active company, and echoes the company it answered for in the same header. A page never silently shows one company's answer under another's name.
// The header is added HERE, on the one transport every request goes through (the API client, the realtime poll and the screens that call the transport directly), not in each caller.
// Off, `withCompanyHeader` passes every request through untouched: no header, no companies read.
import type { ApiRequest, ApiResponse, ApiTransport, AppHost } from "../host.js";
import { ApiError } from "./errors.js";
export const COMPANY_HEADER = "x-rovara-company";
export const COMPANIES_PATH = "/v1/app/companies";
const ID = /^org_[0-9a-z]{20}$/u;
interface PageCompany { id?: string; loading?: Promise<void>; mismatch?: string; listeners: Set<() => void> }
const pages = new WeakMap<ApiTransport, PageCompany>();
function pageOf(transport: ApiTransport): PageCompany { let page = pages.get(transport);if (page === undefined) { page = { listeners: new Set() };pages.set(transport, page); }return page; }
/** The company this page believes it is in: the session's active company when the page first loaded. Undefined until known (or when the server did not say). */
export function pageCompany(transport: ApiTransport): string | undefined { return pages.get(transport)?.id; }
/** A company a response or a link named that is not the one this page is in, or undefined. */
export function companyMismatch(transport: ApiTransport): string | undefined { return pages.get(transport)?.mismatch; }
function notify(page: PageCompany) { for (const listener of [...page.listeners]) listener(); }
export function clearCompanyMismatch(transport: ApiTransport): void { const page = pages.get(transport);if (page?.mismatch === undefined) return;delete page.mismatch;notify(page); }
export function subscribeCompanyMismatch(transport: ApiTransport, listener: () => void): () => void { const page = pageOf(transport);page.listeners.add(listener);return () => { page.listeners.delete(listener); }; }
const isCompaniesRead = (input: ApiRequest) => input.method === "GET" && input.path.split("?", 1)[0] === COMPANIES_PATH;
const isStale = (response: ApiResponse) => response.status === 403 && typeof response.body === "object" && response.body !== null && "error" in response.body && typeof response.body.error === "object" && response.body.error !== null && "code" in response.body.error && response.body.error.code === "CSRF_STALE";
/**
 * Wraps a transport so that, while the switch is on, each request names the page's company. The page learns it once, before its first other request, by reading the companies list straight from the inner transport.
 * A failed read leaves the page without a company and sends no header (with the server's own switch off it needs none).
 * An answer that echoes a different company is never returned: it is reported (the gate in the shell asks the person) and refused as COMPANY_MISMATCH.
 * `onStale` is called when the server says the page's company is not the session's (the stale-tab rule).
 */
export function withCompanyHeader(inner: ApiTransport, options: { isOn(): boolean; onStale(): void }): ApiTransport {
 const transport: ApiTransport = { async request(input: ApiRequest): Promise<ApiResponse> {
  if (!options.isOn()) return inner.request(input);
  const page = pageOf(transport);
  if (page.id === undefined && !isCompaniesRead(input)) {
   page.loading ??= (async () => {
    try {
     const read = await inner.request({ method: "GET", path: COMPANIES_PATH, retry: "never" });
     const body = read.body, id = typeof body === "object" && body !== null && "activeCompanyId" in body ? body.activeCompanyId : undefined;
     if (read.status === 200 && typeof id === "string" && ID.test(id)) page.id = id;
    } catch { /* No company known: no header. */ }
   })();
   await page.loading;
  }
  const company = isCompaniesRead(input) ? undefined : page.id;
  const response = await inner.request(company === undefined ? input : { ...input, headers: { ...input.headers, [COMPANY_HEADER]: company } });
  if (company !== undefined && isStale(response)) options.onStale();
  const echoed = response.company;
  if (company !== undefined && echoed !== undefined && ID.test(echoed) && echoed !== company) {
   if (page.mismatch !== echoed) { page.mismatch = echoed;notify(page); }
   throw new ApiError(409, "COMPANY_MISMATCH", "This answer is for a different company, so it is not shown. Switch company or reload.");
  }
  return response;
 } };
 return transport;
}
const RELOAD_GUARD_KEY = "rovara.company-reload", RELOAD_GUARD_MS = 15_000;
/** The page's company is not the session's: reload into the active company, once in a while, never in a loop. */
export function reloadIntoActiveCompany(host: AppHost): void {
 try {
  const last = Number(host.storage.get(RELOAD_GUARD_KEY) ?? "0");
  if (Number.isFinite(last) && Date.now() - last < RELOAD_GUARD_MS) return;
  host.storage.set(RELOAD_GUARD_KEY, String(Date.now()));
 } catch { /* An unreadable guard still allows one reload. */ }
 // A link can carry `?company=org_...`, which the host's address check refuses; the page itself is enough to land in the active company.
 try { host.navigate(host.currentPath()); } catch { host.navigate(host.currentPath().split(/[?#]/u, 1)[0]!); }
}
