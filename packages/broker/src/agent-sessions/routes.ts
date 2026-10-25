// The session routes (Plan 5 Task 5): `/v1/app/sessions*` for the app, CLI and MCP, only. Shared `/s/` links belong to the web shell. Each maps to a function
// that checks the caller's level first; the reads are in read.ts and the shares in shares.ts. A session the caller can't view is `NOT_FOUND` everywhere.
import { SessionIdSchema, agentXError, type OrgId, type OrgRole, type SessionId } from "@agentx/contracts";
import type { ApprovalCaller, ApprovalDependencies } from "../agents/approvals.js";
import { listApprovalsFor, mayDecideApproval, shownText } from "../agents/approvals.js";
import { mayDecideSpendRequest } from "../spend/requests.js";
import type { AgentRouteDependencies } from "../agents/routes.js";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import type { AdaptedHttpRequest } from "../aws/lambda.js";
import { StatusReply } from "../aws/status-reply.js";
import { sessionDiff, type SessionDiffDependencies } from "./diff.js";
import { readSessionEvents } from "./events.js";
import { mayCreateAgentIn, makeAgentFromSession } from "./make-agent.js";
import { followSession, recordPresence, unfollowSession } from "./followers.js";
import { DeleteBodySchema, EditBodySchema, SendBodySchema, deleteSessionMessage, editSessionMessage, listSessionMessages, parseMessageBody, sendSessionMessage } from "./messages.js";
import { listSessions, sessionStepTask, sessionView, type SessionDeciding, type SessionListQuery, type SessionReadDependencies } from "./read.js";
import type { ChainSteerReads } from "./steer.js";
import { deleteSessionShare, listSessionShares, putSessionShare, registerSessionShareApprovals } from "./shares.js";
import { readChanges } from "../realtime/changes.js";
import type { RealtimeConfig } from "../realtime/publish.js";
import { realtimeTokenFor, type RealtimeTokenDependencies } from "../realtime/token.js";

/** What the session routes need: the read dependencies, and (for a company-wide share and the decisions a caller may make) Plan 3's approvals core. */
export interface SessionRouteDependencies extends SessionReadDependencies, Pick<SessionDiffDependencies, "diff"> {
  approvals?: ApprovalDependencies & Partial<AgentRouteDependencies>;
  /** What the realtime token route needs (Task 8). Without it the route answers `RUNTIME_UNAVAILABLE`. */
  realtime?: RealtimeTokenDependencies;
  /** The events API a presence notice is posted to (Task 9); without it a heartbeat is kept and nothing is posted. */
  realtimePublish?: RealtimeConfig | undefined;
  /** PLAN4: what a chain run is doing now, for a message to a chain (Task 11a). Without it a message to a chain session is refused before it is written. */
  chainSteer?: ChainSteerReads | undefined;
}

/** The caller of a route. */
export type SessionRouteCaller = DeveloperCaller;

const PATH = /^\/v1\/app\/sessions(?:\/([^/]+)(?:\/(shares)(?:\/([^/]+))?|\/sections\/([0-9]{1,6})\/task|\/(events)|\/(follow|presence)|\/(messages)(?:\/([^/]+))?|\/(agent))?)?$/;
const CHANGES_PATH = "/v1/app/changes";
const REALTIME_TOKEN_PATH = "/v1/app/realtime/token";

/** The paths this module owns under `/v1/app/`: the sessions, the changes feed and the realtime token (Task 8). */
export function isAgentSessionRoute(pathname: string): boolean {
  return /^\/v1\/app\/sessions(\/|$)/.test(pathname) || pathname === CHANGES_PATH || pathname === REALTIME_TOKEN_PATH;
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
 * `…/shares[/{principalKey}]` and `GET …/sections/{seq}/task` and `GET …/events?after=`; `POST` and `DELETE …/follow` and `POST …/presence` (Task 9); `GET` and `POST …/messages` and `PATCH` and
 * `DELETE …/messages/{messageId}` (Task 10); `POST …/agent` (Task 10c: make an agent from the session); `GET /v1/app/changes?since=` (the caller's own change notices) and
 * `POST /v1/app/realtime/token`. Any other path or method is `NOT_FOUND`.
 */
export async function routeAgentSessionRequest(deps: SessionRouteDependencies, caller: SessionRouteCaller, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  if (url.pathname === CHANGES_PATH) {
    if (request.method !== "GET") throw notFound();
    return readChanges(deps, caller, url.searchParams.get("since") ?? undefined);
  }
  if (url.pathname === REALTIME_TOKEN_PATH) {
    if (request.method !== "POST") throw notFound();
    if (deps.realtime === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "Live updates aren't available right now.");
    return realtimeTokenFor(deps.realtime, caller);
  }
  const diffMatch = /^\/v1\/app\/sessions\/([^/]+)\/diff$/.exec(url.pathname);
  if (diffMatch !== null) {
    if (request.method !== "GET" || !SessionIdSchema.safeParse(diffMatch[1]).success) throw notFound();
    const number = url.searchParams.get("number") ?? "", page = url.searchParams.get("page") ?? "1";
    if (!/^[1-9][0-9]{0,9}$/.test(number) || !/^[1-9][0-9]{0,4}$/.test(page)) throw notFound();
    return sessionDiff(deps, caller, diffMatch[1]!, { repository: url.searchParams.get("repository") ?? "", number: Number(number), page: Number(page) });
  }
  const matched = PATH.exec(url.pathname);
  if (matched === null) throw notFound();
  const [, rawId, shares, rawKey, rawSeq, events, person, messages, rawMessageId, makeAgent] = matched;
  const approvals = deps.approvals;
  const read: SessionReadDependencies = {
    ...(deps.deciding !== undefined || approvals === undefined ? deps : { ...deps, deciding: decidingOf(approvals) }),
    // Task 10c: whether the person may create agents in the session's project, asked of Plan 3's own check, for the `make_agent` action.
    ...(approvals === undefined ? {} : { mayMakeAgent: (who: { orgId: OrgId; developerId: string; orgRole: OrgRole }, project: string) => mayCreateAgentIn(approvals, who, project) }),
  };
  const method = request.method;
  if (rawId === undefined) {
    if (method !== "GET") throw notFound();
    return listSessions(read, caller, queryOf(url));
  }
  const id = SessionIdSchema.safeParse(rawId);
  // An id that can't be a session is no session: the same answer as one that isn't there.
  if (!id.success) throw agentXError("NOT_FOUND", "session not found");
  const sessionId: SessionId = id.data;
  if (events !== undefined) {
    if (method !== "GET") throw notFound();
    return readSessionEvents(read, caller, sessionId, { after: url.searchParams.get("after") ?? undefined });
  }
  if (makeAgent !== undefined) {
    // Task 10c: make an agent, with its draft, from this session.
    if (method !== "POST") throw notFound();
    return makeAgentFromSession({ ...read, approvals }, caller, sessionId, jsonBody(request));
  }
  if (messages !== undefined) {
    // Comments (Task 10) and messages to the agent (Task 11a: `kind: "steer"`, which needs "can use").
    const messageDeps = { ...read, realtimePublish: deps.realtimePublish, chainSteer: deps.chainSteer };
    if (rawMessageId === undefined) {
      if (method === "GET") return listSessionMessages(messageDeps, caller, sessionId, { after: url.searchParams.get("after") ?? undefined, anchor: url.searchParams.get("anchor") ?? undefined });
      if (method === "POST") return sendSessionMessage(messageDeps, caller, sessionId, parseMessageBody(SendBodySchema, jsonBody(request)));
      throw notFound();
    }
    if (method === "PATCH") {
      const body = parseMessageBody(EditBodySchema, jsonBody(request));
      return editSessionMessage(messageDeps, caller, sessionId, rawMessageId, body);
    }
    if (method === "DELETE") {
      const body = parseMessageBody(DeleteBodySchema, jsonBody(request));
      return deleteSessionMessage(messageDeps, caller, sessionId, rawMessageId, body);
    }
    throw notFound();
  }
  if (person !== undefined) {
    const peopleDeps = { ...read, realtimePublish: deps.realtimePublish };
    if (person === "presence") {
      if (method !== "POST") throw notFound();
      return recordPresence(peopleDeps, caller, sessionId);
    }
    if (method === "POST") return followSession(peopleDeps, caller, sessionId);
    if (method === "DELETE") return unfollowSession(peopleDeps, caller, sessionId);
    throw notFound();
  }
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

// Loading this module registers the company-wide share's approver rule and handler, as the agent routes register theirs.
registerSessionShareApprovals();
