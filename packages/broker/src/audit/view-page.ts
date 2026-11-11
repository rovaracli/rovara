// The read-only audit page (Task 13): where an org's owners and admins read their audit log in a browser.
//
//   GET  /v1/app/audit/view          the limits copy, the ledger's status, a page of records with names, paging, an export form
//                                    (and, with `?export=<id>`, that export's status and download link)
//   POST /v1/app/audit/view/export   the form's target: starts an export, then 303 to `?export=<id>`
//
// Sign-in is the existing browser one (web-session.ts): the review session cookie, whose server-side record `authenticateSession`
// re-reads on EVERY request together with the person's membership, so a demotion applies at once. The org is the member's own
// and nothing in the request can name another. There are no tickets and no staff path here: staff read through the admin routes.
//
// The page has no script. Every value from the ledger is text: HTML-escaped, with control and format characters (a bidi override,
// a zero-width character) shown as their code points so a stored value cannot disguise itself. The export POST needs the CSRF
// cookie and the form field to match and `Origin` to be this cell's, and the page says `Referrer-Policy: same-origin` (under
// `no-referrer` a browser sends `Origin: null` on the form POST and the check would refuse the person's own export).
// Reads are recorded like the API's (`recordAuditRead`, best effort, after the read), with `via: "page"`.
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { SERVER_PAGE_ICON } from "@agentx/design-tokens";
import { AUDIT_ERROR_MESSAGES, AUDIT_LIMITS_COPY, type OrgRole } from "@agentx/cloud-contracts";
import { type OrgId } from "@rovara-code/contracts";
import type { AdaptedHttpRequest } from "../aws/lambda.js";
import { CSRF_COOKIE, SESSION_COOKIE, csrfCookie, escapeHtml, isCsrfToken, parseCookie, safeResponse, safeText, signInLocation, type WebResponse } from "../aws/web-session.js";
import { canReadAuditLog } from "../org/auditor.js";
import { auditOccurrence, auditRead } from "./events.js";
import { type AuditExportClientDeps, type AuditExportView, isAuditExportId, startAuditExport } from "./export.js";
import { recordAuditRead } from "./flush.js";
import { readAuditRecords, type AuditReadQuery, type AuditReadRecord, type AuditReadResult } from "./reader.js";
import { AUDIT_ORG_FORBIDDEN, exportAnswer, exportRequestOf, pageFacts, readQueryOf, type AuditExportLink } from "./routes.js";

export const AUDIT_VIEW_PATH = "/v1/app/audit/view";
export const AUDIT_VIEW_EXPORT_PATH = "/v1/app/audit/view/export";

/** Whether the browser-page router should hand this path to `createAuditViewPage`. */
export const isAuditViewPath = (pathname: string): boolean => pathname === AUDIT_VIEW_PATH || pathname === AUDIT_VIEW_EXPORT_PATH;

/** The signed-in person, as the session lookup reads them now. */
export interface AuditViewCaller {
  developerId: string;
  orgId: OrgId;
  orgRole: OrgRole;
}

export interface AuditViewPageDependencies {
  /** The cell's own origin (scheme, host, port): the only `Origin` the export POST accepts. */
  origin: string;
  /** Resolves the opaque session ID against the sign-in store and the person's membership, on every request; undefined when it is no longer valid. */
  authenticateSession(sessionId: string): Promise<AuditViewCaller | undefined>;
  /** Undefined on an install with no audit ledger. */
  ledger: AuditExportClientDeps | undefined;
}

// ---- the page's words -----------------------------------------------------------------------------------------------------

const NOT_SET_UP = "The audit log is not set up in this deployment.";
const NOT_FOUND = "This page doesn't exist.";
const UNAVAILABLE = "Rovara couldn't load the audit log just now. Try again shortly.";
const EXPORT_UNAVAILABLE = "Rovara couldn't start the export just now. Try again shortly.";
const BAD_REQUEST = "Rovara couldn't read that request. Check the address or the form and try again.";
const REFUSED = "This request was refused. Reload the page and try again.";
const SIGN_IN_AGAIN = "Sign in again to see the audit log.";
const EXPORT_NOT_FOUND = "That export was not found.";
const EXPORT_RUNNING = "Your export is being prepared. This can take a few minutes. Check again shortly.";
const EXPORT_FAILED = "The export couldn't be built. Start a new one.";
const EXPORT_EXPIRED = "This export has expired. Start a new one.";
const LINK_UNAVAILABLE = "Rovara can't prepare the download link just now; try again shortly.";
const GOVERNANCE_SENTENCE = "In governance mode, a privileged administrator could remove the sealed copies.";

/** A value shown as text: one line, HTML-escaped, with control and format characters (and line separators) made visible as code points. */
function plain(value: unknown): string {
  const text = safeText(value)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu, (character) => `[U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}]`);
  return escapeHtml(text);
}

const two = (value: number): string => String(value).padStart(2, "0");
/** `2026-10-20 12:07:09 UTC`; a value that is not a time is shown as text. */
function timeText(value: unknown): string {
  const date = new Date(safeText(value));
  if (Number.isNaN(date.getTime())) return plain(value);
  return `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())} UTC`;
}

const STYLE = ":root{color-scheme:light dark;font-family:system-ui,sans-serif}body{max-width:72rem;margin:0 auto;padding:clamp(1rem,4vw,2.5rem);line-height:1.5}"
  + "h1,h2{line-height:1.2}.muted{opacity:.8}.limits p{max-width:60rem}.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:.92rem}"
  + "th,td{border-top:1px solid #888;padding:.45rem .6rem;text-align:left;vertical-align:top}th[scope=col]{border-top:0}td ul{margin:0;padding-left:1.1rem}"
  + "label{display:block;margin:.6rem 0}input[type=text],input[type=number]{font:inherit;padding:.4rem;width:10rem}button{font:inherit;padding:.6rem 1rem;border-radius:.35rem;cursor:pointer}"
  + "a:focus,button:focus,input:focus{outline:3px solid #478cff;outline-offset:2px}.panel{border:1px solid #888;border-radius:.5rem;padding:.75rem 1rem;margin:1rem 0}"
  + "@media(max-width:35rem){body{padding:1rem}}";

/** A page response: the private headers, this page's nonce, and `Referrer-Policy: same-origin` (see the file's comment). */
function htmlResponse(statusCode: number, body: string, nonce: string): WebResponse {
  const response = safeResponse(statusCode, body, nonce);
  response.headers["referrer-policy"] = "same-origin";
  return response;
}

function document(title: string, content: string, nonce: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>${SERVER_PAGE_ICON}`
    + `<style nonce="${nonce}">${STYLE}</style></head><body><main>${content}</main></body></html>`;
}

function messagePage(statusCode: number, heading: string, text: string, extra = ""): WebResponse {
  const nonce = randomBytes(18).toString("base64url");
  return htmlResponse(statusCode, document("Audit log", `<h1>${escapeHtml(heading)}</h1><p>${escapeHtml(text)}</p>${extra}`, nonce), nonce);
}

/** What a failure from the ledger says to the person: a fixed text, never an error's own words. */
function failurePage(error: unknown, unavailable: string): WebResponse {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "AUDIT_RANGE_INVALID") return messagePage(400, "Check the range", AUDIT_ERROR_MESSAGES.AUDIT_RANGE_INVALID);
  if (code === "AUDIT_FILTER_TOO_WIDE") return messagePage(400, "Narrow the filter", AUDIT_ERROR_MESSAGES.AUDIT_FILTER_TOO_WIDE);
  if (code === "CONFIG_INVALID") return messagePage(400, "Check the request", BAD_REQUEST);
  return messagePage(503, "Audit log unavailable", unavailable);
}

// ---- the page -------------------------------------------------------------------------------------------------------------

function actorCell(entry: AuditReadRecord): string {
  const actor = entry.record.actor;
  const own = entry.details.find((part) => part.subject === actor.id);
  const name = own !== undefined && "fields" in own ? own.fields.name : undefined;
  return `${name === undefined ? "" : `${plain(name)} `}<span class="muted">${plain(actor.kind)} ${plain(actor.id)}</span>`;
}

function proofCell(entry: AuditReadRecord): string {
  const proof = entry.record.proof;
  if (proof === undefined) return "";
  const how = proof.method ?? proof.via;
  return `${plain(proof.kind)}${how === undefined ? "" : ` (${plain(how)})`}${proof.authTime === undefined ? "" : `, signed in ${timeText(proof.authTime)}`}`;
}

function detailsCell(entry: AuditReadRecord): string {
  const facts = Object.entries(entry.record.facts).map(([key, value]) => `<li>${plain(key)}: ${plain(value)}</li>`);
  const parts = entry.details.map((part) => ("erased" in part
    ? `<li>${plain(part.subject)}: <em>erased</em></li>`
    : `<li>${plain(part.subject)}: ${Object.entries(part.fields).map(([key, value]) => `${plain(key)}: ${plain(value)}`).join("; ")}</li>`));
  const items = [...facts, ...parts];
  return items.length === 0 ? "" : `<ul>${items.join("")}</ul>`;
}

function recordRow(entry: AuditReadRecord): string {
  const { record } = entry;
  return `<tr><th scope="row">${plain(record.seq)}</th><td><time datetime="${plain(record.recordedAt)}">${timeText(record.recordedAt)}</time></td><td>${actorCell(entry)}</td>`
    + `<td>${plain(record.action)}</td><td><span class="muted">${plain(record.target.kind)}</span> ${plain(record.target.id)}</td>`
    + `<td>${record.related.map((id) => plain(id)).join(", ")}</td><td>${proofCell(entry)}</td><td>${detailsCell(entry)}</td></tr>`;
}

function statusSection(result: AuditReadResult): string {
  const unsealed = result.headSeq - result.sealedThroughSeq;
  const lines = [
    `Sealed through record ${plain(result.sealedThroughSeq)} of ${plain(result.headSeq)}.${unsealed > 0 ? ` ${plain(unsealed)} newer ${unsealed === 1 ? "record is" : "records are"} not sealed yet.` : ""}`,
    result.latestTimestamp === undefined ? "No independent time yet: no timestamp service has signed a sealed batch." : `Latest independent time: ${timeText(result.latestTimestamp)}.`,
    ...(result.latestTimestamp !== undefined && result.epochsWithoutTimestamp.length > 0
      ? [`${plain(result.epochsWithoutTimestamp.length)} sealed ${result.epochsWithoutTimestamp.length === 1 ? "batch has" : "batches have"} no independent time yet, so that date does not cover them.`]
      : []),
    ...(result.lockMode === undefined ? [] : [`Sealed copies are locked in ${plain(result.lockMode)} mode.${result.lockMode === "GOVERNANCE" ? ` ${escapeHtml(GOVERNANCE_SENTENCE)}` : ""}`]),
  ];
  return `<section id="status" aria-label="Status"><h2>Status</h2><ul>${lines.map((line) => `<li>${line}</li>`).join("")}</ul></section>`;
}

/** The page's own address with `query`'s filters (never the cursor) and, when given, a cursor. */
function pageHref(query: AuditReadQuery, cursor?: string): string {
  const params = new URLSearchParams();
  for (const name of ["fromSeq", "toSeq", "from", "to", "action", "actorId", "limit"] as const) {
    const value = query[name];
    if (value !== undefined) params.set(name, String(value));
  }
  if (cursor !== undefined) params.set("cursor", cursor);
  const text = params.toString();
  return `${AUDIT_VIEW_PATH}${text === "" ? "" : `?${text}`}`;
}

function recordsSection(result: AuditReadResult, query: AuditReadQuery): string {
  const count = result.records.length;
  const table = count === 0
    ? "<p>No records match.</p>"
    : `<div class="scroll"><table><thead><tr><th scope="col">No.</th><th scope="col">Recorded</th><th scope="col">Who</th><th scope="col">Action</th><th scope="col">Target</th>`
      + `<th scope="col">Related</th><th scope="col">Proof</th><th scope="col">Details</th></tr></thead><tbody>${result.records.map(recordRow).join("")}</tbody></table></div>`;
  const next = result.nextCursor === undefined ? "" : `<p><a rel="next" href="${escapeHtml(pageHref(query, result.nextCursor))}">Next records</a></p>`;
  return `<section id="records" aria-label="Records"><h2>Records</h2><p>Showing ${plain(count)} ${count === 1 ? "record" : "records"}.</p>${table}${next}</section>`;
}

function exportForm(result: AuditReadResult, csrf: string): string {
  if (result.headSeq === 0) return `<section id="export-form" aria-label="Export"><h2>Export</h2><p>There is nothing to export yet.</p></section>`;
  const fromSeq = Math.max(1, result.headSeq - 199_999);
  return `<section id="export-form" aria-label="Export"><h2>Export</h2>`
    + `<p>An export is a file you can keep and check with the verifier, without trusting Rovara.</p>`
    + `<form method="post" action="${AUDIT_VIEW_EXPORT_PATH}" id="export">`
    + `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="requestId" value="${escapeHtml(randomUUID())}">`
    + `<label>From record <input type="number" name="fromSeq" min="1" required value="${plain(fromSeq)}"></label>`
    + `<label>To record <input type="number" name="toSeq" min="1" required value="${plain(result.headSeq)}"></label>`
    + `<label><input type="checkbox" name="withDetails"> Include the names and other details</label>`
    + `<p><button type="submit">Start export</button></p></form></section>`;
}

function exportPanel(content: string): string {
  return `<section id="export" class="panel" aria-label="Export status"><h2>Export status</h2>${content}</section>`;
}

/** The export panel for a view of the export, with its link when it is ready. */
function exportStatus(view: AuditExportView, link: AuditExportLink | undefined, exportId: string): string {
  const range = `Records ${plain(view.range.fromSeq)} to ${plain(view.range.toSeq)}${view.withDetails ? ", with details" : ""}.`;
  // Defence in depth: exportAnswer only signs a link for a ready export, so the status check is redundant today.
  if (view.status === "ready" && link !== undefined) {
    const minutes = Math.max(1, Math.round(link.expiresInSeconds / 60));
    return exportPanel(`<p>Your export is ready. ${range}${view.summary === undefined ? "" : ` ${plain(view.summary.records)} records.`}</p>`
      + `<p><a href="${escapeHtml(link.url)}" rel="noopener noreferrer nofollow">Download the export</a> <span class="muted">(this link works for ${plain(minutes)} minutes)</span></p>`);
  }
  if (view.status === "running") return exportPanel(`<p>${escapeHtml(EXPORT_RUNNING)} ${range}</p><p><a href="${AUDIT_VIEW_PATH}?export=${escapeHtml(exportId)}">Check again</a></p>`);
  if (view.status === "expired") return exportPanel(`<p>${escapeHtml(EXPORT_EXPIRED)}</p>`);
  return exportPanel(`<p>${escapeHtml(EXPORT_FAILED)}</p>`);
}

const exportNotFound = (): string => exportPanel(`<p>${escapeHtml(EXPORT_NOT_FOUND)}</p>`);
const linkUnavailable = (): string => exportPanel(`<p>${escapeHtml(LINK_UNAVAILABLE)}</p>`);

// ---- the handler ----------------------------------------------------------------------------------------------------------

/** The request's form fields as text; `undefined` when a field is repeated or is not one of `allowed`. */
function formFields(body: string | undefined, allowed: readonly string[]): Map<string, string> | undefined {
  const params = new URLSearchParams(body ?? "");
  const fields = new Map<string, string>();
  for (const [name, value] of params) {
    if (!allowed.includes(name) || fields.has(name)) return undefined;
    fields.set(name, value);
  }
  return fields;
}

const FORM_FIELDS = ["csrf", "requestId", "fromSeq", "toSeq", "withDetails"] as const;

/** Both sides are checked as CSRF tokens first, so the byte lengths match whenever the character counts do. */
const sameToken = (left: string, right: string): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** A whole number from a form field; anything else is NaN, which the export request's check refuses as a bad range. */
const wholeNumberField = (value: string | undefined): number => (value !== undefined && /^\d{1,15}$/.test(value) ? Number(value) : Number.NaN);

export function createAuditViewPage(deps: AuditViewPageDependencies): (request: AdaptedHttpRequest, url: URL) => Promise<WebResponse> {
  const cellOrigin = new URL(deps.origin).origin;

  const signedIn = async (request: AdaptedHttpRequest): Promise<AuditViewCaller | undefined> => {
    const sessionId = parseCookie(request.headers, SESSION_COOKIE);
    return sessionId === undefined ? undefined : deps.authenticateSession(sessionId);
  };

  /** The refusal that comes before anything is read: not an owner or admin, or no ledger here. The role is checked first. */
  const notAllowed = (caller: AuditViewCaller): WebResponse | undefined => {
    if (!canReadAuditLog(caller.orgRole)) return messagePage(403, "Not allowed", AUDIT_ORG_FORBIDDEN);
    if (deps.ledger === undefined) return messagePage(404, "Not set up", NOT_SET_UP);
    return undefined;
  };

  async function view(request: AdaptedHttpRequest, url: URL): Promise<WebResponse> {
    const caller = await signedIn(request);
    if (caller === undefined) {
      const redirect = htmlResponse(302, "", "");
      redirect.headers.location = signInLocation(AUDIT_VIEW_PATH);
      return redirect;
    }
    const refused = notAllowed(caller);
    if (refused !== undefined) return refused;
    const ledger = deps.ledger!;
    const reading = (facts: { fromSeq: number; toSeq: number; count: number }, via: string, occurrence: string) =>
      recordAuditRead(ledger, auditRead({ orgId: caller.orgId, actor: { kind: "member", id: caller.developerId }, occurredAt: new Date(ledger.now()).toISOString(), occurrence, ...facts, via }));
    try {
      const query = readQueryOf(url.searchParams, ["export"]);
      const exportId = url.searchParams.get("export");
      const result = await readAuditRecords(ledger, caller.orgId, query);
      await reading(pageFacts(result), "page", request.requestId);
      let panel = "";
      if (exportId !== null) {
        panel = exportNotFound();
        if (isAuditExportId(exportId)) {
          try {
            const answer = await exportAnswer(ledger, caller.orgId, exportId);
            const link = answer.link !== undefined && answer.link.url.startsWith("https://") ? answer.link : undefined;
            // A link is the way to the whole log, so handing one out is a read of its own.
            if (link !== undefined) await reading({ fromSeq: answer.view.range.fromSeq, toSeq: answer.view.range.toSeq, count: answer.view.summary?.records ?? 0 }, "export-download", auditOccurrence(request.requestId, "export-download"));
            panel = answer.download && link === undefined ? linkUnavailable() : exportStatus(answer.view, link, exportId);
          } catch (error) {
            const code = (error as { code?: unknown } | null)?.code;
            panel = code === "NOT_FOUND" ? exportNotFound() : linkUnavailable();
          }
        }
      }
      const current = parseCookie(request.headers, CSRF_COOKIE);
      const csrf = isCsrfToken(current) ? current : randomBytes(32).toString("base64url");
      const nonce = randomBytes(18).toString("base64url");
      const limits = `<section id="limits" class="limits" aria-label="What the log proves"><h2>What this log proves, and what it does not</h2>${AUDIT_LIMITS_COPY.split("\n\n").map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("")}</section>`;
      const content = `<h1>Audit log</h1>${limits}${statusSection(result)}${panel}${recordsSection(result, query)}${exportForm(result, csrf)}`;
      const response = htmlResponse(200, document("Audit log", content, nonce), nonce);
      response.headers["set-cookie"] = csrfCookie(csrf);
      return response;
    } catch (error) {
      return failurePage(error, UNAVAILABLE);
    }
  }

  async function startExport(request: AdaptedHttpRequest): Promise<WebResponse> {
    // The guards come first and say the same thing whichever one fails: nothing about the session, the token or the origin.
    const cookie = parseCookie(request.headers, CSRF_COOKIE);
    const field = new URLSearchParams(request.body ?? "").get("csrf");
    if (request.headers.origin !== cellOrigin || !isCsrfToken(cookie) || field === null || !isCsrfToken(field) || !sameToken(field, cookie)) return messagePage(403, "Request refused", REFUSED);
    const caller = await signedIn(request);
    if (caller === undefined) return messagePage(401, "Sign in again", SIGN_IN_AGAIN, `<p><a href="${escapeHtml(signInLocation(AUDIT_VIEW_PATH))}">Sign in</a></p>`);
    const refused = notAllowed(caller);
    if (refused !== undefined) return refused;
    const fields = formFields(request.body, FORM_FIELDS);
    if (fields === undefined) return messagePage(400, "Check the request", BAD_REQUEST);
    const withDetails = fields.get("withDetails");
    if (withDetails !== undefined && withDetails !== "on") return messagePage(400, "Check the request", BAD_REQUEST);
    try {
      // The same parsing and range checks as the API's export route.
      const exportRequest = exportRequestOf({
        ...(fields.has("requestId") ? { requestId: fields.get("requestId") } : {}),
        fromSeq: wholeNumberField(fields.get("fromSeq")),
        toSeq: wholeNumberField(fields.get("toSeq")),
        ...(withDetails === undefined ? {} : { withDetails: true }),
      });
      const started = await startAuditExport(deps.ledger!, { orgId: caller.orgId, actor: { kind: "member", id: caller.developerId } }, exportRequest);
      const redirect = htmlResponse(303, "", "");
      redirect.headers.location = `${AUDIT_VIEW_PATH}?export=${started.exportId}`;
      return redirect;
    } catch (error) {
      return failurePage(error, EXPORT_UNAVAILABLE);
    }
  }

  return async (request, url) => {
    if (url.pathname === AUDIT_VIEW_PATH) {
      if (request.method !== "GET") {
        const refused = messagePage(405, "Not allowed", "This page answers GET only.");
        refused.headers.allow = "GET";
        return refused;
      }
      return view(request, url);
    }
    if (url.pathname === AUDIT_VIEW_EXPORT_PATH) {
      if (request.method !== "POST") {
        const refused = messagePage(405, "Not allowed", "This address answers POST only.");
        refused.headers.allow = "POST";
        return refused;
      }
      return startExport(request);
    }
    return messagePage(404, "Not found", NOT_FOUND);
  };
}
