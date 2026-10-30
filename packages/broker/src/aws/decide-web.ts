// Plan 3, Task 21a-presence (R66, R67): the confirmation page's two routes, `GET /v1/app/approve/{id}` and `POST /v1/app/approve/{id}`.
// They have no bearer token to rely on (a token is exactly what a local assistant holds): the browser's decide session cookie, its CSRF
// field and the cell's own Origin authorize them, all checked by `requireDecideSession`. A bearer token reaching either route gets
// REAUTH_REQUIRED with a ticketed confirmUrl, as JSON, from the broker's usual error answer.
import { AgentXError, agentXError } from "@agentx/contracts";
import { confirmPage, decidedPage, forbiddenPage, notFoundPage, reauthPage, refusedPage, resultPage, type PageResponse } from "../developer/confirm-page.js";
import { kindPrefixOf, mayDecide, type DecideKind } from "../developer/decide-kinds.js";
import {
  APPROVAL_ID_PATTERN, DECIDE_COOKIE, DecideReauthRequired, TICKET_PATTERN, cookieOf, csrfTokenFor, endOfFailure, endedWords, requireDecideNavigation, requireDecideSession, settleSession,
  type DecideRequestContext, type DecisionEnd,
} from "../developer/decide-session.js";
import type { AdaptedHttpRequest } from "./lambda.js";

const APPROVE_PATH = /^\/v1\/app\/approve\/([^/]+)$/;
const MAX_FORM_BYTES = 2_048;
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
  const decideRequest = { method: request.method, path: url.pathname, headers: request.headers, ...(request.body === undefined ? {} : { body: request.body }) };
  return request.method === "GET" ? showPage(context, decideRequest, approvalId, url) : decide(context, decideRequest, approvalId);
}

type DecideRequest = Parameters<typeof requireDecideSession>[1];

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
  const cookie = cookieOf(request.headers, DECIDE_COOKIE)!;
  return confirmPage(inspection.view, { approvalId, csrf: csrfTokenFor(cookie) });
}

async function decide(context: DecideRequestContext, request: DecideRequest, approvalId: string): Promise<PageResponse> {
  if (request.body === undefined || Buffer.byteLength(request.body, "utf8") > MAX_FORM_BYTES) return refusedPage(400, "Nothing was decided", "The form is missing or too large. Open the approval again.");
  const decision = new URLSearchParams(request.body).get("decision");
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
    const target = { orgId: authority.orgId, developerId: authority.developerId, approvalId };
    const prefix = kindPrefixOf(approvalId);
    const kind: DecideKind | undefined = prefix === undefined ? undefined : context.kinds[prefix];
    // R68: eligibility is evaluated again now, not trusted from when the page was shown.
    const inspection = await mayDecide(context.kinds, target);
    if (kind === undefined || inspection.status === "not_found") return notFoundPage();
    if (inspection.status === "forbidden") return forbiddenPage(`Only ${inspection.who} can decide this.`);
    if (inspection.status === "decided" || inspection.status === "expired") return decidedPage(endedWords(inspection), inspection.status);
    try {
      const outcome = await kind.decide(target, decision, authority.proof);
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
