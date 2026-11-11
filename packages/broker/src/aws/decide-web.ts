// Plan 3, Task 21a-presence (R66, R67): the confirmation page's two routes, `GET /v1/app/approve/{id}` and `POST /v1/app/approve/{id}`.
// They have no bearer token to rely on (a token is exactly what a local assistant holds): the browser's decide session cookie, its CSRF
// field and the cell's own Origin authorize them, all checked by `requireDecideSession`. A bearer token reaching either route gets
// REAUTH_REQUIRED with a ticketed confirmUrl, as JSON, from the broker's usual error answer.
import { AGENT_PUBLISH_NOTE_MAX, AgentXError, agentXError, type OrgId } from "@agentx/contracts";
import { confirmPage, decidedPage, forbiddenPage, notFoundPage, reauthPage, refusedPage, resultPage, type PageResponse } from "../developer/confirm-page.js";
import { kindPrefixOf, mayDecide, type DecideKind } from "../developer/decide-kinds.js";
import {
  APPROVAL_ID_PATTERN, DECIDE_COOKIE, DecideReauthRequired, TICKET_PATTERN, cookieOf, csrfTokenFor, endOfFailure, endedWords, requireDecideNavigation, requireDecideSession, settleSession,
  type DecideRequestContext, type DecisionEnd,
} from "../developer/decide-session.js";
import type { AdaptedHttpRequest } from "./lambda.js";
import { decisionCardsEnabled } from "../proof/switch.js";

const APPROVE_PATH = /^\/v1\/app\/approve\/([^/]+)$/;
// Room for the decline reason (300 characters, up to 12 bytes each once percent-encoded) beside the decision and the CSRF field.
const MAX_FORM_BYTES = 8_192;
const NO_STORE = { "cache-control": "no-store", "referrer-policy": "same-origin", "cross-origin-opener-policy": "same-origin" };

/** Whether the path belongs to the confirmation page (`/v1/app/approve/...`); the caller answers anything else. */
export const isDecidePagePath = (pathname: string) => pathname.startsWith("/v1/app/approve/");

const found = (location: string): PageResponse => ({ statusCode: 302, headers: { location, ...NO_STORE }, body: "" });
const wordsOf = (error: AgentXError) => error.message.replace(`${error.code}: `, "");

/**
 * `context` is undefined where this install has no approvals to decide (no developer sign-in): both routes are then NOT_FOUND.
 * The page redirects a browser without a fresh session to the start of the sign-in (with the ticket it was opened with, which the redirect
 * then removes from the address bar) or, with no ticket, to the identify step.
 */
export async function routeDecidePage(context: DecideRequestContext | undefined, request: AdaptedHttpRequest, url: URL): Promise<PageResponse> {
  try { requireDecideNavigation(request); }
  catch (error) {
    if (error instanceof AgentXError && error.code === "FORBIDDEN") return refusedPage(403, "Open this approval", wordsOf(error));
    throw error;
  }
  if (context === undefined) throw agentXError("NOT_FOUND", "route not found");
  const approvalId = APPROVE_PATH.exec(url.pathname)?.[1];
  if (approvalId === undefined || !APPROVAL_ID_PATTERN.test(approvalId) || (request.method !== "GET" && request.method !== "POST")) return notFoundPage();
  // Decision journey slice 3b: while the decision cards are on, the approval is decided on its card (the same checks, in the app); an old link (Slack, email) is sent there. Kept one release as this
  // redirect; then the page goes. A POST from a page that was already open still decides here, as before.
  // A high card's decide sign-in (`card_decision`) always goes back to its card on the task page, whether the cards are on or not (final review): it is never decided here.
  if (request.method === "GET") {
    const back = await cardReturnOf(context, request.headers, approvalId);
    if (back !== undefined) return found(back);
  }
  if (request.method === "GET" && decisionCardsEnabled()) return found(`/app/decisions/approve_request/${approvalId}`);
  const decideRequest = { method: request.method, path: url.pathname, headers: request.headers, ...(request.body === undefined ? {} : { body: request.body }) };
  return request.method === "GET" ? showPage(context, decideRequest, approvalId, url) : decide(context, decideRequest, approvalId);
}

type DecideRequest = Parameters<typeof requireDecideSession>[1];

/**
 * Security review (2026-11-06): the decide sign-in for a HIGH card on a task page (`card_decision`) comes back to that card, not to a card-only page. Only for the browser that holds the decide session
 * just written for this very approval, and only to the task page the record names (checked by the kind).
 */
/** The task-page card of a `card_decision` this person made, or undefined for any other approval. */
async function cardDecisionReturn(context: DecideRequestContext, target: { orgId: OrgId; developerId: string; approvalId: string }): Promise<string | undefined> {
  const prefix = kindPrefixOf(target.approvalId);
  return (prefix === undefined ? undefined : context.kinds[prefix])?.returnPath?.(target);
}

async function cardReturnOf(context: DecideRequestContext, headers: Record<string, string | undefined>, approvalId: string): Promise<string | undefined> {
  const cookie = cookieOf(headers, DECIDE_COOKIE);
  if (cookie === undefined || cookie.length < 32 || cookie.length > 128) return undefined;
  try {
    const session = await context.store.getSession(cookie);
    if (session === undefined || session.approvalId !== approvalId) return undefined;
    const prefix = kindPrefixOf(approvalId);
    return await (prefix === undefined ? undefined : context.kinds[prefix])?.returnPath?.({ orgId: session.orgId, developerId: session.developerId, approvalId });
  } catch { return undefined; }
}

async function showPage(context: DecideRequestContext, request: DecideRequest, approvalId: string, url: URL): Promise<PageResponse> {
  let authority: Awaited<ReturnType<typeof requireDecideSession>>;
  try {
    authority = await requireDecideSession(context, request);
  } catch (error) {
    if (!(error instanceof DecideReauthRequired) || error.details.signInUrl === undefined) throw error;
    const ticket = url.searchParams.get("ticket") ?? "";
    return found(TICKET_PATTERN.test(ticket) ? `/v1/auth/decide/start?ticket=${ticket}` : error.details.signInUrl);
  }
  const target = { orgId: authority.orgId, developerId: authority.developerId, approvalId };
  const inspection = await mayDecide(context.kinds, target);
  if (inspection.status === "not_found") return notFoundPage();
  if (inspection.status === "forbidden") return forbiddenPage(`Only ${inspection.who} can decide this.`);
  if (inspection.status === "decided" || inspection.status === "expired") return decidedPage(endedWords(inspection), inspection.status);
  // A high card's `card_decision` is decided on its card on the task page, never on this page (its Approve would spend the session and decide nothing).
  const back = await cardDecisionReturn(context, target);
  if (back !== undefined) return found(back);
  const cookie = cookieOf(request.headers, DECIDE_COOKIE)!;
  // The page is about to be shown to this member: that, and only that, is what "opened" means for a kind that needs the member to have read it.
  const prefix = kindPrefixOf(approvalId);
  await (prefix === undefined ? undefined : context.kinds[prefix])?.opened?.(target);
  return confirmPage(inspection.view, { approvalId, csrf: csrfTokenFor(cookie) });
}

/**
 * The decline reason from the form: no reason when empty, not valid when longer than 300 characters (code points) or holding a control or format character other than a line
 * break or a tab (line breaks and tabs become spaces).
 */
function reasonOf(raw: string | null): { valid: true; reason?: string } | { valid: false } {
  if (raw === null) return { valid: true };
  const folded = raw.replace(/\r\n|[\r\n\t]/gu, " ").trim();
  if (folded === "") return { valid: true };
  if ([...folded].length > AGENT_PUBLISH_NOTE_MAX || /[\p{Cc}\p{Cf}]/u.test(folded)) return { valid: false };
  return { valid: true, reason: folded };
}

async function decide(context: DecideRequestContext, request: DecideRequest, approvalId: string): Promise<PageResponse> {
  if (request.body === undefined || Buffer.byteLength(request.body, "utf8") > MAX_FORM_BYTES) return refusedPage(400, "Nothing was decided", "The form is missing or too large. Open the approval again.");
  const form = new URLSearchParams(request.body);
  const decision = form.get("decision");
  const given = reasonOf(form.get("reason"));
  const reason = given.valid ? given.reason : undefined;
  let authority: Awaited<ReturnType<typeof requireDecideSession>>;
  try {
    authority = await requireDecideSession(context, request);
  } catch (error) {
    if (error instanceof DecideReauthRequired && error.details.signInUrl !== undefined) return reauthPage(error.details.signInUrl);
    if (error instanceof AgentXError && error.code === "FORBIDDEN") return refusedPage(403, "Nothing was decided", wordsOf(error));
    throw error;
  }
  // The session is claimed from here (one decision at a time). What happens to it next depends on what came of the decision (M-d): a decision
  // that was made spends it; one that was refused decided nothing, so it is given back and the person can try again within its ten minutes;
  // a failure on our side after the decision began may have partly happened, so it stays spent (the catch below classifies what the decision threw).
  let end: DecisionEnd = "refused";
  try {
    if (decision !== "approve" && decision !== "decline") return refusedPage(400, "Nothing was decided", "Choose Approve or Decline. Open the approval again.");
    // The reason is read only for a decline: whatever the text area holds never blocks an approval.
    if (decision === "decline" && !given.valid) return refusedPage(400, "Nothing was decided", `The reason can be at most ${String(AGENT_PUBLISH_NOTE_MAX)} characters of plain text. Go back, shorten it and decide again.`);
    const target = { orgId: authority.orgId, developerId: authority.developerId, approvalId };
    const prefix = kindPrefixOf(approvalId);
    const kind: DecideKind | undefined = prefix === undefined ? undefined : context.kinds[prefix];
    // R68: eligibility is evaluated again now, not trusted from when the page was shown.
    const inspection = await mayDecide(context.kinds, target);
    if (kind === undefined || inspection.status === "not_found") return notFoundPage();
    if (inspection.status === "forbidden") return forbiddenPage(`Only ${inspection.who} can decide this.`);
    if (inspection.status === "decided" || inspection.status === "expired") return decidedPage(endedWords(inspection), inspection.status);
    if (await cardDecisionReturn(context, target) !== undefined) return refusedPage(409, "Nothing was decided", "Decide this on its card in the task.");
    try {
      // Only a decline carries the reason; on an approval it is ignored.
      const outcome = await kind.decide(target, decision, authority.proof, decision === "decline" && reason !== undefined ? { reason } : undefined);
      end = "decided";
      return resultPage(outcome.title ?? (decision === "approve" ? "Approved" : "Declined"), outcome.message,outcome.refusal?.fixHref);
    } catch (error) {
      end = endOfFailure(error);
      if (error instanceof AgentXError) return refusedPage(error.statusCode >= 500 ? 503 : error.statusCode === 403 || error.statusCode === 404 ? error.statusCode : 409, "Nothing was changed", wordsOf(error));
      throw error;
    }
  } finally {
    await settleSession(authority, end);
  }
}
