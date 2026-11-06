// The session routes (Plan 5 Task 5): `/v1/app/sessions*` for the app, CLI and MCP, only. Shared `/s/` links belong to the web shell. Each maps to a function
// that checks the caller's level first; the reads are in read.ts and the shares in shares.ts. A session the caller can't view is `NOT_FOUND` everywhere.
import { sessionResponseForClient, taskResponseForClient } from "../rovara-code/task-view-compat.js";
import { LIVE_PAGE_MAX, SessionIdSchema, agentXError, type AgentSessionRecord, type OrgId, type OrgRole, type SessionId } from "@agentx/contracts";
import type { ApprovalCaller, ApprovalDependencies } from "../agents/approvals.js";
import { listApprovalsFor, mayDecideApproval, shownText } from "../agents/approvals.js";
import { mayDecideSpendRequest } from "../spend/requests.js";
import type { AgentRouteDependencies } from "../agents/routes.js";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import type { AdaptedHttpRequest } from "../aws/lambda.js";
import { StatusReply } from "../aws/status-reply.js";
import { recordLocalUpdate, registerLocalSession } from "../devices/local-sessions.js";
import { sessionDiff, type SessionDiffDependencies } from "./diff.js";
import { readSessionEvents } from "./events.js";
import { mayCreateAgentIn, makeAgentFromSession } from "./make-agent.js";
import { followSession, recordPresence, unfollowSession } from "./followers.js";
import { DeleteBodySchema, EditBodySchema, SendBodySchema, deleteSessionMessage, editSessionMessage, listSessionMessages, parseMessageBody, sendSessionMessage, type SessionMessageDependencies } from "./messages.js";
import { dismissHomeCard, homeCards, type HomeDependencies } from "./home.js";
import { liveSessions, type LiveQuery } from "./live.js";
import { projectOverview, type ProjectPageReader } from "./project-overview.js";
import { listSessions, sessionStepTask, sessionView, type SessionDeciding, type SessionListQuery, type SessionReadCaller, type SessionReadDependencies } from "./read.js";
import type { ChainSteerReads } from "./steer.js";
import { deleteSessionShare, listSessionShares, putSessionShare, registerSessionShareApprovals } from "./shares.js";
import { handoffSession, type HandoffRuntime } from "./handoff.js";
import { retrySession } from "./retry.js";
import { answerIntentOnSession } from "../rovara-code/questions.js";
// v1.2 learning loop: registers the suggested-rules card source with Home (the module registers itself when it loads).
import "../learning/home-source.js";
import { changeAnywayOnSession } from "../rovara-code/change-anyway.js";
import { pressMerge, registerMergeApprovals } from "../rovara-code/merge.js";
import { registerCodeSettingsApprovals } from "../rovara-code/code-settings.js";
import { closeSession, stopSession } from "./stop.js";
import { redirectSession } from "./redirect.js";
import { askStatusFor, submitAsk, type AskDependencies } from "./ask.js";
import { askTakeOver, registerSessionTakeOverApprovals } from "./take-over.js";
import { linkLinearOnSession, unlinkLinearOnSession } from "../rovara-code/link-linear.js";
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
  /** What a chain run is doing now, for a message to a chain (Task 11a): Plan 4's `chainSteerReadsFor`, built for each request. Without it a message to a chain session is refused before it is written. */
  chainSteer?: ChainSteerReads | undefined;
  /** Live steer (`live-steer.ts`): the broker's signing key, so a message to a running step also reaches its session. Without it every message is a note only. */
  liveSteer?: SessionMessageDependencies["liveSteer"];
  /** How long one of Home's sources may take (Task 15; default two seconds). */
  homeSourceTimeoutMs?: number | undefined;
  /** The Home card kinds that decision cards carry now (see `HomeDependencies.retiredKinds`); set by the wiring that mounts the decision routes. */
  retiredHomeKinds?: HomeDependencies["retiredKinds"];
  /** Task 19 (Plan 6's `HandoffRuntime`, H1): moving a session between a Mac and the cloud. Without it the move route answers `RUNTIME_UNAVAILABLE`. */
  handoff?: HandoffRuntime | undefined;
  /** Task 16: the project's card (repositories, setup, channels) for a person who already has a role in it. Without it the project page answers `NOT_FOUND`. */
  projectPage?: ProjectPageReader | undefined;
  /** Live interaction A3 (`ask.ts`): Ask about this task. Absent while the `ak` switch is off, and then `…/ask` and `…/asks/{id}` answer `NOT_FOUND` as if they did not exist. */
  ask?: AskDependencies | undefined;
}

/** The caller of a route. */
export type SessionRouteCaller = DeveloperCaller;

const PATH = /^\/v1\/app\/sessions(?:\/([^/]+)(?:\/(shares)(?:\/([^/]+))?|\/sections\/([0-9]{1,6})\/task|\/(events)|\/(follow|presence)|\/(messages)(?:\/([^/]+))?|\/(agent)|\/(take-over)|\/(stop|retry|close|redirect|handoff|answers|change-anyway|merge))?)?$/;
const LOCAL_REGISTER_PATH = "/v1/app/sessions/local";
const LOCAL_UPDATE_PATH = /^\/v1\/app\/sessions\/([^/]+)\/local\/updates$/;
/** Plan 6 Task 20: `POST …/bindings` links a session to a Linear issue and `DELETE …/bindings/linear` lets it go (a path of its own, beside the local-session ones). */
const BINDINGS_PATH = /^\/v1\/app\/sessions\/([^/]+)\/bindings(?:\/(linear))?$/;
const CHANGES_PATH = "/v1/app/changes";
const LIVE_PATH = "/v1/app/live";
const PROJECT_OVERVIEW_PATH = /^\/v1\/app\/projects\/([^/]+)\/overview$/;
const ASK_PATH = /^\/v1\/app\/sessions\/([^/]+)\/(?:ask|asks\/([^/]+))$/;
const HOME_PATH = "/v1/app/home";
const HOME_DISMISS_PATH = /^\/v1\/app\/home\/cards\/([^/]*)\/dismiss$/;
const REALTIME_TOKEN_PATH = "/v1/app/realtime/token";

/** The paths this module owns under `/v1/app/`: the sessions, the Live wall (Task 14), the changes feed and the realtime token (Task 8). */
export function isAgentSessionRoute(pathname: string): boolean {
  return /^\/v1\/app\/sessions(\/|$)/.test(pathname) || pathname === CHANGES_PATH || pathname === REALTIME_TOKEN_PATH || pathname === LIVE_PATH || /^\/v1\/app\/home(\/|$)/.test(pathname) || PROJECT_OVERVIEW_PATH.test(pathname);
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

/** The words that name a pending approval on a session, or undefined when the approval is not about it. */
function approvalTextOn(record: Awaited<ReturnType<typeof listApprovalsFor>>[number], session: Pick<AgentSessionRecord, "sessionId" | "subject">): string | undefined {
  if (record.kind === "change") {
    if (record.subject.kind === "session_share_org" && record.subject.sessionId === session.sessionId) return record.changes[0] ?? "Share this session with everyone in your company";
    if (record.subject.kind === "session_owner" && record.subject.sessionId === session.sessionId) return record.changes[0] ?? "Take this session over";
  } else if (session.subject.kind === "task" && record.subject.kind === "agent_run" && record.subject.taskId === session.subject.taskId) {
    return record.kind === "write" ? record.summary : record.prompt;
  } else if (session.subject.kind === "chain" && record.kind === "step" && record.subject.kind === "chain_gate" && record.subject.chainRunId === session.subject.chainRunId) {
    return record.prompt;
  }
  return undefined;
}

/**
 * What the caller may decide on sessions now: their own listed approvals that they still may decide, and the budget request's link. Everything is read live. The caller's approvals
 * are listed once however many sessions are asked about (`approvalsFor`); `approvals` is the same for one.
 */
export function decidingOf(approvals: ApprovalDependencies & Partial<AgentRouteDependencies>): SessionDeciding {
  const among = async (caller: SessionReadCaller, sessions: readonly AgentSessionRecord[]): Promise<Map<string, Array<{ approvalId: string; title: string }>>> => {
    const asker: ApprovalCaller = { orgId: caller.orgId, developerId: caller.developerId, orgRole: caller.orgRole };
    const found = new Map<string, Array<{ approvalId: string; title: string }>>();
    if (sessions.length === 0) return found;
    const records = await listApprovalsFor(approvals, asker, "PENDING");
    for (const session of sessions) {
      const mine: Array<{ approvalId: string; title: string }> = [];
      for (const record of records) {
        const text = approvalTextOn(record, session);
        if (text === undefined || !await mayDecideApproval(approvals, asker, record)) continue;
        mine.push({ approvalId: record.approvalId, title: shownText(text, 300) || "A decision is waiting" });
      }
      if (mine.length > 0) found.set(session.sessionId, mine);
    }
    return found;
  };
  return {
    approvals: async (caller, session) => (await among(caller, [session])).get(session.sessionId) ?? [],
    approvalsFor: among,
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

function liveQueryOf(url: URL): LiveQuery {
  const get = (name: string) => url.searchParams.get(name) ?? undefined;
  const limit = get("limit");
  if (limit !== undefined && !/^[0-9]{1,3}$/.test(limit)) throw agentXError("CONFIG_INVALID", `limit: must be a whole number from 1 to ${String(LIVE_PAGE_MAX)}`);
  return { filter: get("filter"), project: get("project"), cursor: get("cursor"), ...(limit === undefined ? {} : { limit: Number(limit) }) };
}

/**
 * `routeAgentSessionRequest(deps, caller, request, url)`: `GET /v1/app/sessions` (the lists), `GET /v1/app/sessions/{id}`, `GET`, `PUT` and `DELETE`
 * `…/shares[/{principalKey}]` and `GET …/sections/{seq}/task` and `GET …/events?after=`; `POST` and `DELETE …/follow` and `POST …/presence` (Task 9); `GET` and `POST …/messages` and `PATCH` and
 * `DELETE …/messages/{messageId}` (Task 10); `POST …/agent` (Task 10c: make an agent from the session); `POST …/take-over` (Task 12b: ask to take the session over, answered `202` with the link to confirm it); `POST …/stop` and `POST …/retry` (Task 13); `POST …/handoff` (Task 19: move the session between a Mac and the cloud); `POST …/answers` (Rovara Code: people answer Understand's questions, needs "can use"); `POST …/change-anyway` (Rovara Code: make the change after an Answered task); `GET /v1/app/changes?since=` (the caller's own change notices) and
 * `POST /v1/app/realtime/token`; `GET /v1/app/home` and `POST /v1/app/home/cards/{cardId}/dismiss` (Task 15: Home's ranked cards); `GET /v1/app/live?filter=&project=&cursor=&limit=` (Task 14: the Live wall's tiles). Any other path or method is `NOT_FOUND`.
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
  const askMatch = ASK_PATH.exec(url.pathname);
  if (askMatch !== null) {
    // Live interaction A3: `POST …/ask` queues a question (needs "can use"); `GET …/asks/{askId}` reads it back, for the person who asked alone.
    if (deps.ask === undefined || !SessionIdSchema.safeParse(askMatch[1]).success) throw notFound();
    if (askMatch[2] === undefined) {
      if (request.method !== "POST") throw notFound();
      return submitAsk(deps.ask, caller, askMatch[1]!, jsonBody(request));
    }
    if (request.method !== "GET") throw notFound();
    return askStatusFor(deps.ask, caller, askMatch[1]!, askMatch[2]);
  }
  const approvals = deps.approvals;
  const read: SessionReadDependencies = {
    ...(deps.deciding !== undefined || approvals === undefined ? deps : { ...deps, deciding: decidingOf(approvals) }),
    // Task 10c: whether the person may create agents in the session's project, asked of Plan 3's own check, for the `make_agent` action.
    ...(approvals === undefined ? {} : { mayMakeAgent: (who: { orgId: OrgId; developerId: string; orgRole: OrgRole }, project: string) => mayCreateAgentIn(approvals, who, project) }),
  };
  if (url.pathname === LIVE_PATH) {
    if (request.method !== "GET") throw notFound();
    return liveSessions(read, caller, liveQueryOf(url));
  }
  const overviewOf = PROJECT_OVERVIEW_PATH.exec(url.pathname);
  if (overviewOf !== null) {
    // Task 16: a project's page. A name that cannot be decoded is a project that is not there.
    if (request.method !== "GET") throw notFound();
    let project: string;
    try {
      project = decodeURIComponent(overviewOf[1]!);
    } catch {
      throw agentXError("PROJECT_NOT_FOUND", "project not found");
    }
    return projectOverview({ ...read, ...(approvals === undefined ? {} : { approvals }), ...(deps.projectPage === undefined ? {} : { projectPage: deps.projectPage }) }, caller, project);
  }
  if (url.pathname === HOME_PATH || url.pathname.startsWith(`${HOME_PATH}/`)) {
    // Task 15: Home's cards, and a dismissal of one of them.
    const home: HomeDependencies = { ...read, ...(approvals === undefined ? {} : { approvals }), ...(deps.retiredHomeKinds === undefined ? {} : { retiredKinds: deps.retiredHomeKinds }), ...(deps.homeSourceTimeoutMs === undefined ? {} : { homeSourceTimeoutMs: deps.homeSourceTimeoutMs }) };
    if (url.pathname === HOME_PATH) {
      if (request.method !== "GET") throw notFound();
      return homeCards(home, caller);
    }
    const dismissing = HOME_DISMISS_PATH.exec(url.pathname);
    if (dismissing === null || request.method !== "POST") throw notFound();
    let cardId: string;
    try {
      cardId = decodeURIComponent(dismissing[1]!);
    } catch {
      throw agentXError("CONFIG_INVALID", "cardId: is not a card on Home");
    }
    const seen = url.searchParams.get("occurrence");
    return dismissHomeCard(home, caller, cardId, seen === null ? undefined : seen);
  }
  // Task 18: a Mac registers a local session and posts its updates. Both are the signed-in person's own device acting for them.
  if (url.pathname === LOCAL_REGISTER_PATH) {
    if (request.method !== "POST") throw notFound();
    const registered = await registerLocalSession({ ...read, realtimePublish: deps.realtimePublish }, caller, jsonBody(request));
    return new StatusReply(201, { session: await sessionView(read, caller, registered.sessionId) });
  }
  const localUpdate = LOCAL_UPDATE_PATH.exec(url.pathname);
  if (localUpdate !== null) {
    if (request.method !== "POST") throw notFound();
    return recordLocalUpdate({ ...read, realtimePublish: deps.realtimePublish }, caller, localUpdate[1]!, jsonBody(request));
  }
  const bindingsOf = BINDINGS_PATH.exec(url.pathname);
  if (bindingsOf !== null) {
    // Both need "can edit" on the session; an id that can't be a session is no session.
    const bound = SessionIdSchema.safeParse(bindingsOf[1]);
    if (!bound.success) throw agentXError("NOT_FOUND", "session not found");
    if (request.method === "POST" && bindingsOf[2] === undefined) return linkLinearOnSession(read, caller, bound.data, jsonBody(request));
    if (request.method === "DELETE" && bindingsOf[2] === "linear") return unlinkLinearOnSession(read, caller, bound.data);
    throw notFound();
  }
  const matched = PATH.exec(url.pathname);
  if (matched === null) throw notFound();
  const [, rawId, shares, rawKey, rawSeq, events, person, messages, rawMessageId, makeAgent, takeOver, control] = matched;
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
  if (takeOver !== undefined) {
    // Task 12b: ask to take the session over; the answer is `202` with the link where the asker confirms it.
    if (method !== "POST") throw notFound();
    const reply = await askTakeOver(read, caller, sessionId, jsonBody(request), deps.approvals);
    return new StatusReply(reply.status, reply.body);
  }
  if (control !== undefined) {
    // Task 13: stop (Plan 3's cancel, or Plan 4's for a chain) and retry (the same workflow, or a new run); each answers the session that carries on. Task 19: handoff.
    if (method !== "POST") throw notFound();
    if (control === "handoff") {
      // Task 19: move the session between a Mac and the cloud (its owner only); the runtime is Plan 6's, the repositories are Plan 3's own reader.
      return handoffSession({ ...read, handoff: deps.handoff, projectRepositories: approvals?.projectRepositories }, caller, sessionId, jsonBody(request));
    }
    if (control === "answers") return answerIntentOnSession(read, caller, sessionId, jsonBody(request));
    // Stop & redirect: the owner stops the step and gives a new instruction. The route exists only while the `rd` switch is on.
    if (control === "redirect") return redirectSession({ ...read, redirect: deps.redirect }, caller, sessionId, jsonBody(request));
    // Rovara Code: a person presses Merge. In a signed-in browser a low or medium risk change merges in place; a high one, or a token's press, gets 202 and the presser's approval card (decision journey slice 3).
    if (control === "merge") {
      const reply = await pressMerge(read, caller, sessionId, jsonBody(request), deps.approvals);
      return new StatusReply(reply.status, reply.body);
    }
    // Rovara Code: a task that ended Answered, followed by a new task that makes the change anyway (202, like the app's start).
    if (control === "change-anyway") return new StatusReply(202, await changeAnywayOnSession(read, caller, sessionId, jsonBody(request)));
    if (control === "close") return closeSession(read, caller, sessionId, jsonBody(request));
    return control === "stop" ? stopSession(read, caller, sessionId, jsonBody(request)) : retrySession(read, caller, sessionId, jsonBody(request));
  }
  if (messages !== undefined) {
    // Comments (Task 10) and messages to the agent (Task 11a: `kind: "steer"`, which needs "can use").
    const messageDeps = { ...read, realtimePublish: deps.realtimePublish, chainSteer: deps.chainSteer, liveSteer: deps.liveSteer };
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
    return sessionResponseForClient({ session: await sessionView(read, caller, sessionId) }, request.headers);
  }
  if (rawSeq !== undefined) {
    if (method !== "GET") throw notFound();
    return taskResponseForClient(await sessionStepTask(read, caller, sessionId, Number(rawSeq)), request.headers);
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
registerSessionTakeOverApprovals();
// Rovara Code (Plan 6 Task 19): the merge change (decided only by the person who pressed Merge) and the code-settings change (decided by an organization owner or admin).
registerMergeApprovals();
registerCodeSettingsApprovals();
