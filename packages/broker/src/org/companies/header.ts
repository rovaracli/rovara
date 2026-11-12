// Company memberships (srv/company-memberships; briefs/company-memberships-api.md section 5, THE STALE-TAB RULE; DEFERRED COMPANIES-HEADER-REQUIREMENT-FOLLOWS-FLAG): the `x-rovara-company` request header.
//
// The header ONLY NARROWS. It is compared with the company the request is already in (the session's active company, which `sessionCompany` re-checked as a live membership on this request); it never picks a
// company, never widens anything and is never looked up on its own. A header that names any other company (one the session is not in, one the person never belonged to or was removed or banned from, a malformed
// value) is refused with 403 CSRF_STALE and fixed words, the code the web app reloads on (ui/src/api/company-context.ts). The words never say whether the named company exists or whether the person belongs to it.
//
// WHEN THE HEADER IS REQUIRED. Exactly when the company's `companies` UI flag is `on` as the navigation answer reports it: the same function (`navUiFlags`, ui-flags/store.ts), the same company (the request's), the
// operator's force-off (`uo`) included, and a failed flag read counts as off there and here alike. `preview` and `off` never require it (a person on `preview` without the device key sends none). It is never a second
// switch: with the server switch on and the UI flag not `on`, a request without the header goes through exactly as before. Three reads that tell a page which company it is in are exempt, because the web app makes
// them before it knows (the navigation answer, `/me` for the CSRF token, and the companies list).
//
// Browser requests only (`/v1/web/*`). A machine credential is bound to one company and needs no header. With the server switch `cw` off this module is not called.
import { agentXError, type OrgId } from "@rovara-code/contracts";
import { COMPANY_REQUEST_HEADER, COMPANY_STALE_MESSAGE } from "@agentx/cloud-contracts";
import { navUiFlags, type UiFlagsDeps } from "../ui-flags/store.js";

const COMPANY_ID = /^org_[0-9a-z]{20}$/u;
/** The reads a page makes before it knows its company: never refused for a missing header (a header they carry is still checked). Exact paths, GET only. */
const EXEMPT_READS: ReadonlySet<string> = new Set(["/v1/web/nav", "/v1/web/me", "/v1/web/companies"]);

/** Whether a request without the header is refused for this company now: its `companies` flag is `on`, read exactly as the navigation answer reads it. */
export async function companyHeaderRequired(deps: UiFlagsDeps, orgId: OrgId, environment: Record<string, string | undefined> = process.env): Promise<boolean> {
  return (await navUiFlags(deps, orgId, environment)).companies === "on";
}

/**
 * Checks one browser request. `orgId` is the company the request is in (the caller's, after the session's active company was resolved). Throws CSRF_STALE, or returns.
 */
export async function checkCompanyHeader(deps: UiFlagsDeps, request: { method: string; path: string; headers: Record<string, string | undefined> }, orgId: OrgId, environment: Record<string, string | undefined> = process.env): Promise<void> {
  const named = request.headers[COMPANY_REQUEST_HEADER];
  if (named !== undefined) {
    if (!COMPANY_ID.test(named) || named !== orgId) throw agentXError("CSRF_STALE", COMPANY_STALE_MESSAGE);
    return;
  }
  const pathname = request.path.split("?", 1)[0]!;
  if ((request.method === "GET" || request.method === "HEAD") && EXEMPT_READS.has(pathname)) return;
  if (await companyHeaderRequired(deps, orgId, environment)) throw agentXError("CSRF_STALE", COMPANY_STALE_MESSAGE);
}
