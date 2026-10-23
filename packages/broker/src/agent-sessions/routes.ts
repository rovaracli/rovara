// The session routes (Plan 5 Task 5): `/v1/app/sessions*` for the app, CLI and MCP, and `/s/<sessionId>` for a person's browser. Each maps to a function
// that checks the caller's level first; the reads are in read.ts and the shares in shares.ts. A session the caller can't view is `NOT_FOUND` everywhere.
import { SessionIdSchema, STATUS_WORDS, agentXError, type SessionId } from "@agentx/contracts";
import type { ApprovalCaller, ApprovalDependencies } from "../agents/approvals.js";
import { listApprovalsFor, mayDecideApproval, shownText } from "../agents/approvals.js";
import { mayDecideSpendRequest } from "../spend/requests.js";
import type { AgentRouteDependencies } from "../agents/routes.js";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import type { AdaptedHttpRequest } from "../aws/lambda.js";
import { StatusReply } from "../aws/status-reply.js";
import { SESSION_COOKIE, escapeHtml, parseCookie, safeResponse, signInLocation, type WebResponse } from "../aws/web-session.js";
import { randomBytes } from "node:crypto";
import { listSessions, sessionLinkTarget, sessionStepTask, sessionView, type SessionDeciding, type SessionListQuery, type SessionReadDependencies } from "./read.js";
import { deleteSessionShare, listSessionShares, putSessionShare, registerSessionShareApprovals } from "./shares.js";

/** What the session routes need: the read dependencies, and (for a company-wide share and the decisions a caller may make) Plan 3's approvals core. */
export interface SessionRouteDependencies extends SessionReadDependencies {
  approvals?: ApprovalDependencies & Partial<AgentRouteDependencies>;
}

/** The caller of a route. */
export type SessionRouteCaller = DeveloperCaller;

const PATH = /^\/v1\/app\/sessions(?:\/([^/]+)(?:\/(shares)(?:\/([^/]+))?|\/sections\/([0-9]{1,6})\/task)?)?$/;
const LINK_PATH = /^\/s\/((?:ses|crn)_[0-9a-z]{20})$/;

/** The paths this module owns under `/v1/app/`. */
export function isAgentSessionRoute(pathname: string): boolean {
  return /^\/v1\/app\/sessions(\/|$)/.test(pathname);
}

/** `/s/<anything>`: a session's link, served to a browser. */
export function isSessionLinkPath(pathname: string): boolean {
  return /^\/s\/[^/]*$/.test(pathname);
}

const notFound = () => agentXError("NOT_FOUND", "route not found");

function jsonBody(request: AdaptedHttpRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try {
    return JSON.parse(request.body) as unknown;
  } catch {
    throw agentXError("CONFIG_INVALID", "the request body is not JSON");
  }
}

/** What the caller may decide on a session now: their own listed approvals that they still may decide, and the budget request's link. Everything is read live. */
export function decidingOf(approvals: ApprovalDependencies & Partial<AgentRouteDependencies>): SessionDeciding {
  return {
    approvals: async (caller, session) => {
      const asker: ApprovalCaller = { orgId: caller.orgId, developerId: caller.developerId, orgRole: caller.orgRole };
      const mine = [];
      for (const record of await listApprovalsFor(approvals, asker, "PENDING")) {
        let text: string | undefined;
        if (record.kind === "change") {
          if (record.subject.kind === "session_share_org" && record.subject.sessionId === session.sessionId) text = record.changes[0] ?? "Share this session with everyone in your company";
        } else if (session.subject.kind === "task" && record.subject.kind === "agent_run" && record.subject.taskId === session.subject.taskId) {
          text = record.kind === "write" ? record.summary : record.prompt;
        } else if (session.subject.kind === "chain" && record.kind === "step" && record.subject.kind === "chain_gate" && record.subject.chainRunId === session.subject.chainRunId) {
          text = record.prompt;
        }
        if (text === undefined || !await mayDecideApproval(approvals, asker, record)) continue;
        mine.push({ approvalId: record.approvalId, title: shownText(text, 300) || "A decision is waiting" });
      }
      return mine;
    },
    spend: (caller, spendRequestId) => mayDecideSpendRequest(approvals, { orgId: caller.orgId, developerId: caller.developerId }, spendRequestId),
  };
}

function queryOf(url: URL): SessionListQuery {
  const get = (name: string) => url.searchParams.get(name) ?? undefined;
  const limit = get("limit");
  if (limit !== undefined && !/^[0-9]{1,3}$/.test(limit)) throw agentXError("CONFIG_INVALID", "limit: must be a whole number from 1 to 100");
  return {
    owner: get("owner") as SessionListQuery["owner"], project: get("project"), shared: get("shared") as SessionListQuery["shared"],
    status: get("status") as SessionListQuery["status"], cursor: get("cursor"), ...(limit === undefined ? {} : { limit: Number(limit) }),
  };
}

/**
 * `routeAgentSessionRequest(deps, caller, request, url)`: `GET /v1/app/sessions` (the lists), `GET /v1/app/sessions/{id}`, `GET`, `PUT` and `DELETE`
 * `…/shares[/{principalKey}]` and `GET …/sections/{seq}/task`. Any other path or method is `NOT_FOUND`.
 */
export async function routeAgentSessionRequest(deps: SessionRouteDependencies, caller: SessionRouteCaller, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  const matched = PATH.exec(url.pathname);
  if (matched === null) throw notFound();
  const [, rawId, shares, rawKey, rawSeq] = matched;
  const read: SessionReadDependencies = deps.deciding !== undefined || deps.approvals === undefined ? deps : { ...deps, deciding: decidingOf(deps.approvals) };
  const method = request.method;
  if (rawId === undefined) {
    if (method !== "GET") throw notFound();
    return listSessions(read, caller, queryOf(url));
  }
  const id = SessionIdSchema.safeParse(rawId);
  // An id that can't be a session is no session: the same answer as one that isn't there.
  if (!id.success) throw agentXError("NOT_FOUND", "session not found");
  const sessionId: SessionId = id.data;
  if (shares === undefined && rawSeq === undefined) {
    if (method !== "GET") throw notFound();
    return { session: await sessionView(read, caller, sessionId) };
  }
  if (rawSeq !== undefined) {
    if (method !== "GET") throw notFound();
    return sessionStepTask(read, caller, sessionId, Number(rawSeq));
  }
  if (rawKey === undefined) {
    if (method === "GET") return listSessionShares(read, caller, sessionId);
    if (method === "PUT") {
      const reply = await putSessionShare(read, caller, sessionId, jsonBody(request), deps.approvals);
      return reply.status === 200 ? reply.body : new StatusReply(reply.status, reply.body);
    }
    throw notFound();
  }
  if (method !== "DELETE") throw notFound();
  let key: string;
  try {
    key = decodeURIComponent(rawKey);
  } catch {
    throw agentXError("CONFIG_INVALID", "principal: is not a person, a project or the company");
  }
  return deleteSessionShare(read, caller, sessionId, key);
}

// ---- the link in a browser

export interface SessionLinkDependencies {
  /** The signed-in browser's person, re-read with their membership on every request; undefined when the cookie is missing or no longer good. */
  authenticateSession(sessionId: string): Promise<SessionRouteCaller | undefined>;
  /** The read dependencies for one person. */
  read(caller: SessionRouteCaller): SessionReadDependencies;
  /** Builds the address of a task's page. */
  taskPageUrl(origin: string, taskId: string): string;
  origin: string;
}

function page(statusCode: number, heading: string, lines: string[]): WebResponse {
  const nonce = randomBytes(18).toString("base64url");
  return safeResponse(statusCode, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rovara</title>`
    + `<style nonce="${nonce}">:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{max-width:40rem;margin:0 auto;padding:2rem 1rem}</style></head>`
    + `<body><main><h1>${escapeHtml(heading)}</h1>${lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}</main></body></html>`, nonce);
}

/**
 * `GET /s/{sessionId}` for a signed-in browser. A task session the person can view goes (302) to the task's page, which admits them to read it; a
 * chain or local session answers a small page with its title, status and owner (the web app replaces it); no access reads exactly like no session
 * (404); no sign-in goes to sign in and comes back here.
 */
export async function sessionRedirect(deps: SessionLinkDependencies, request: AdaptedHttpRequest, url: URL): Promise<WebResponse> {
  const matched = LINK_PATH.exec(url.pathname);
  if (matched === null) return page(404, "Not found", ["This page doesn't exist."]);
  if (request.method !== "GET") {
    const refused = page(405, "Not allowed", ["This page is read only."]);
    refused.headers["allow"] = "GET";
    return refused;
  }
  const sessionId = matched[1]!;
  const cookie = parseCookie(request.headers, SESSION_COOKIE);
  const caller = cookie === undefined ? undefined : await deps.authenticateSession(cookie);
  if (caller === undefined) {
    const redirect = safeResponse(302, "");
    return { ...redirect, headers: { ...redirect.headers, location: signInLocation(`/s/${sessionId}`) } };
  }
  try {
    const target = await sessionLinkTarget(deps.read(caller), caller, sessionId);
    if (target.kind === "task") {
      const redirect = safeResponse(302, "");
      return { ...redirect, headers: { ...redirect.headers, location: deps.taskPageUrl(deps.origin, target.taskId) } };
    }
    return page(200, target.title, [`Status: ${STATUS_WORDS[target.status as keyof typeof STATUS_WORDS] ?? target.status}`, `Owner: ${target.owner}`]);
  } catch (error) {
    if (error instanceof Error && error.name === "AgentXError" && (error as { code?: string }).code === "NOT_FOUND") return page(404, "Not found", ["This page doesn't exist."]);
    return page(503, "Try again shortly", ["Rovara couldn't open this session right now."]);
  }
}

// Loading this module registers the company-wide share's approver rule and handler, as the agent routes register theirs.
registerSessionShareApprovals();
