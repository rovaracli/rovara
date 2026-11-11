// Agent publish requests (experience decision 24, owner decision 91), the routes: `POST /v1/app/agents/{id}/publish-requests` (ask), `GET` the same path (the agent's
// requests, `manage` on it), `GET /v1/app/agent-publish-requests` (the caller's own, and the ones they may decide or that target a project they maintain; admins see all)
// and `POST /v1/app/agent-publish-requests/{requestId}/withdraw` (only the person who asked). Deciding is the existing `POST /v1/app/approvals/{id}/decide`. Every key is
// built from the caller's org; roles are read live. The rules, the handler and the views are in publication.ts.
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  AGENT_PUBLISH_LIST_MAX,
  AgentPublishRequestBodySchema,
  AgentPublishWithdrawBodySchema,
  AgentXError,
  AgentXNameSchema,
  CHANGE_APPROVAL_TTL_DAYS,
  MAX_OPEN_PUBLISH_REQUESTS,
  agentPublicationKey,
  agentPublicationsIndexKey,
  agentXError,
  canonicalInstant,
  canonicalJson,
  isBuiltinAgentId,
  type AgentId,
  type AgentOwner,
  type PublishTarget,
} from "@agentx/contracts";
import type { AdaptedHttpRequest } from "../aws/lambda.js";
import { StatusReply } from "../aws/status-reply.js";
import { requireAccountable, requireAgentAccess, requireOwnerAllowed, type AgentCaller } from "./access.js";
import { withdrawChange } from "./approvals-decide.js";
import { sameMember } from "./lifecycle.js";
import { confirmUrlFor, createPendingChange, getApproval, pendingChangeFor, type AgentPublicationSubject, type ApprovalRecord } from "./approvals-store.js";
import { requireActiveForConfirmation, requireWithinGuardrails, resolveRecipe } from "./changes.js";
import {
  agentShares, effectOf, isPublicationRecord, keepAuthorEditing, maintainsProject, maySeeRequest, publicationApprovers, publicationIndexItems, publicationOf, publishRequestView,
  requestedEvent, requireOpenProject, summaryOf, waitingFor, withdrawnEvent,
} from "./publication.js";
import { holdingOwnerCap, jsonBody, markRequest, parseBody, view, type AgentRouteDependencies } from "./routes.js";
import type { AgentRecord } from "./store.js";

export const PUBLISH_REQUESTS_PATH = /^\/v1\/app\/agent-publish-requests(?:\/([^/]+)\/(withdraw))?$/;
const DAY_MS = 86_400_000;
const PAGE = 100;
const MAX_PAGES = 5;

const conflict = () => agentXError("IDEMPOTENCY_CONFLICT", "requestId: this request ID was already used for a different request");
const isOrgAdmin = (caller: AgentCaller) => caller.orgRole === "owner" || caller.orgRole === "admin";

type PublicationRecord = ApprovalRecord & { subject: AgentPublicationSubject };

/** The 202 a waiting request answers, now and on a repeat. */
async function waitingAnswer(deps: AgentRouteDependencies, caller: AgentCaller, record: PublicationRecord): Promise<StatusReply> {
  return new StatusReply(202, { status: "NEEDS_CONFIRMATION", confirmUrl: confirmUrlFor(deps, record), changes: record.changes, request: await publishRequestView(deps, caller, record) });
}

async function publishedAnswer(deps: AgentRouteDependencies, caller: AgentCaller, agentId: AgentId): Promise<StatusReply> {
  const { agent, access } = await requireAgentAccess(deps, caller, agentId, "view");
  const shown = await view(deps, caller, agent, access);
  return new StatusReply(200, { status: "published", agent: "owner" in agent ? { ...shown, publication: await publicationOf(deps, caller, agent) } : shown, request: null });
}

/** How many requests `developerId` has waiting now: the org's index of the last week (a request lasts `CHANGE_APPROVAL_TTL_DAYS`), each read live. */
async function openRequestsOf(deps: AgentRouteDependencies, caller: AgentCaller): Promise<number> {
  const since = new Date(deps.now() - CHANGE_APPROVAL_TTL_DAYS * DAY_MS - DAY_MS).toISOString();
  let open = 0;
  let start: Record<string, unknown> | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND sk > :since", ConsistentRead: true, Limit: PAGE,
      ExpressionAttributeValues: { ":pk": agentPublicationsIndexKey(caller.orgId, since, "apr_00000000000000000000" as never).pk, ":since": canonicalInstant(since) },
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<{ approvalId?: unknown; requestedBy?: unknown }>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of response.Items ?? []) {
      if (item.requestedBy !== caller.developerId || typeof item.approvalId !== "string") continue;
      const record = await getApproval(deps, caller.orgId, item.approvalId as never);
      if (record?.status === "PENDING" && Date.parse(record.expiresAt) > deps.now()) open += 1;
    }
    start = response.LastEvaluatedKey;
    if (start === undefined) break;
  }
  return open;
}

/**
 * `POST /v1/app/agents/{id}/publish-requests`: the caller holds `manage` on the agent. A maintainer (or an org owner or admin) asking for a project they maintain gets it at
 * once, by the same write as `PUT owner` (`200 published`, or the owner cap's `202 NEEDS_ADMIN_APPROVAL`); anything else waits on the page (`202 NEEDS_CONFIRMATION`), an
 * admin's own company request included. A repeat with the same request id and body answers the stored outcome; another body is `409 IDEMPOTENCY_CONFLICT`.
 */
async function askToPublish(deps: AgentRouteDependencies, caller: AgentCaller, agentId: AgentId, body: unknown): Promise<StatusReply> {
  const input = parseBody(AgentPublishRequestBodySchema, body);
  if (isBuiltinAgentId(agentId)) throw agentXError("CONFIG_INVALID", "Built-in agents belong to the whole company, so they can't be requested.");
  const { agent: found } = await requireAgentAccess(deps, caller, agentId, "manage");
  if (!("owner" in found)) throw agentXError("CONFIG_INVALID", "Built-in agents belong to the whole company, so they can't be requested.");
  const agent: AgentRecord = found;
  if (agent.purpose === "process") throw agentXError("CONFIG_INVALID", "A project's way of working is not an agent, so it can't be requested.");
  const target: PublishTarget = input.target.kind === "project" ? { kind: "project", project: parseProject(input.target.project) } : { kind: "company" };
  const note = input.note?.trim() === "" ? undefined : input.note?.trim();

  // Repeats (R18), after the access check so a repeat tells nobody who lost access anything: a request that waits, then one applied at once.
  const earlier = await pendingChangeFor(deps, caller.orgId, caller.developerId, input.requestId);
  if (earlier !== undefined) {
    if (!isPublicationRecord(earlier) || earlier.subject.agentId !== agentId || canonicalJson(earlier.subject.target) !== canonicalJson(target) || earlier.subject.version !== input.version || earlier.subject.note !== note) throw conflict();
    return waitingAnswer(deps, caller, earlier);
  }
  const marked = await markRequest(deps, caller, "publish-request", agentId, { requestId: input.requestId, target, version: input.version, ...(note === undefined ? {} : { note }) }).catch((error: unknown) => {
    if (error instanceof AgentXError && error.code === "CONFIG_INVALID") throw conflict();
    throw error;
  });
  if (marked.replay !== undefined) return publishedAnswer(deps, caller, agentId);

  if (agent.status === "archived") throw agentXError("AGENT_UNAVAILABLE", `${agent.name} is archived, so it can't be published. Unarchive it first, then ask again.`);
  if (agent.currentVersion === undefined) throw agentXError("CONFIG_INVALID", `${agent.name} has no published version`);
  if (input.version !== agent.currentVersion) throw agentXError("CHANGE_STALE", `version: ${agent.name} runs version ${String(agent.currentVersion)} now. Reload it and ask again.`);
  const stored = await deps.store.getVersion(caller.orgId, agentId, agent.currentVersion);
  if (stored === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "The published version can't be read right now. Try again in a moment.");
  const recipe = await resolveRecipe(deps, caller.orgId, agentId, agent.currentVersion);
  if (target.kind === "project") {
    // A project the caller can't see reads as missing, the same as one that doesn't exist.
    if (!isOrgAdmin(caller) && await deps.projectMembers.roleOf(caller.orgId, target.project, { developerId: caller.developerId, orgRole: caller.orgRole }) === undefined) throw agentXError("PROJECT_NOT_FOUND", `no project called ${target.project} in your company`);
    await requireOpenProject(deps, caller.orgId, target.project);
    if (agent.owner.kind === "project") throw agentXError("CONFIG_INVALID", `${agent.name} already belongs to the ${agent.owner.project} project.`);
  } else {
    const company = (await agentShares(deps, caller.orgId, agentId)).find((share) => share.principal.kind === "org");
    if (company !== undefined && company.level !== "view") throw agentXError("CONFIG_INVALID", `${agent.name} is already shared with everyone in your company.`);
  }
  // The company's guardrails, now; they are checked again when it is approved.
  await requireWithinGuardrails(deps, caller.orgId, recipe);

  // A maintainer of the target project (an org owner or admin is one everywhere) publishes there at once: exactly `PUT owner`'s write, held to the same cap.
  if (target.kind === "project" && await maintainsProject(deps, caller.orgId, target.project, caller.developerId)) {
    const owner = await requireOwnerAllowed(deps, caller, { kind: "project", project: target.project }, agent.owner);
    const accountable = await requireAccountable(deps, caller.orgId, target.project, caller.developerId);
    const { accountable: _before, ...kept } = agent; // eslint-disable-line @typescript-eslint/no-unused-vars -- the new owner decides it
    const moved = await holdingOwnerCap(deps, caller, { kind: "agent", agentId }, agent, { ...kept, owner, accountable }, { op: "set_owner", owner, accountable }, marked.mark,
      (options) => deps.store.setOwner(caller.orgId, agentId, owner, caller.developerId, accountable, marked.mark, { ...options, actor: { developerId: caller.developerId, role: caller.orgRole }, manageSnapshot: agent }));
    if (moved instanceof StatusReply) return moved;
    if (agent.owner.kind === "member") await keepAuthorEditing(deps, caller.orgId, caller.developerId, agentId, agent.owner.developerId, accountable.developerId);
    try { await deps.triggerHooks?.recheckTriggersForTarget(caller.orgId, { kind: "agent", agentId }); } catch { /* the move was committed; a trigger left on is looked at again when it starts a run */ }
    return publishedAnswer(deps, caller, agentId);
  }

  requireActiveForConfirmation(agent);
  if (await openRequestsOf(deps, caller) >= MAX_OPEN_PUBLISH_REQUESTS) throw agentXError("TOO_MANY_REQUESTS", `You have ${String(MAX_OPEN_PUBLISH_REQUESTS)} requests waiting. Withdraw one, or wait for one to be decided, before asking again.`);
  const { waiting, seen } = await waitingFor(deps, caller.orgId, agentId, target);
  if (waiting !== undefined) throw agentXError("CHANGE_STALE", "A request for this target already waits.");
  const expectedOwner: AgentOwner = agent.owner;
  const subject: AgentPublicationSubject = {
    kind: "agent_publication", agentId, target, version: agent.currentVersion, digest: stored.digest, requestId: input.requestId,
    ...(note === undefined ? {} : { note }), expectedOwner, expectedSharesRevision: agent.sharesRevision ?? 0,
  };
  const changes = [effectOf(agent.name, target, expectedOwner.kind === "member" ? "Its author" : undefined), ...summaryOf(recipe, agent, stored.extends).lessSafe];
  let record: ApprovalRecord;
  try {
    record = await createPendingChange(deps, {
      orgId: caller.orgId, requestId: input.requestId, requestedBy: caller.developerId, subject, changes,
      approvers: await publicationApprovers(deps, caller.orgId, target, caller.developerId),
      extra: (made) => ({ items: publicationIndexItems(deps, made as PublicationRecord, seen), events: [requestedEvent(made as PublicationRecord)] }),
    });
  } catch (error) {
    // Two requests for one agent and target at once: the one whose pointer write lost waits for nothing.
    if (error instanceof Error && error.name === "TransactionCanceledException" && (await waitingFor(deps, caller.orgId, agentId, target)).waiting !== undefined) throw agentXError("CHANGE_STALE", "A request for this target already waits.");
    throw error;
  }
  if (!isPublicationRecord(record)) throw conflict();
  if (record.status !== "PENDING") throw agentXError("APPROVAL_CLOSED", "this request was already decided");
  return waitingAnswer(deps, caller, record);
}

function parseProject(raw: string): string {
  const parsed = AgentXNameSchema.safeParse(raw);
  if (!parsed.success) throw agentXError("PROJECT_NOT_FOUND", "that is not a valid project name");
  return parsed.data;
}

// ---- lists

/** One page of the opaque cursor: the base64url of the last index sort key read. */
const encodeCursor = (sk: string): string => Buffer.from(sk, "utf8").toString("base64url");
function decodeCursor(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  const sk = Buffer.from(raw, "base64url").toString("utf8");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z#apr_[0-9a-z]{20}$/u.test(sk) && !/^REQ#\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z#apr_[0-9a-z]{20}$/u.test(sk)) throw agentXError("CONFIG_INVALID", "cursor: is not one this list gave");
  return sk;
}

function limitOf(url: URL): number {
  const raw = url.searchParams.get("limit");
  if (raw === null) return 20;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > AGENT_PUBLISH_LIST_MAX) throw agentXError("CONFIG_INVALID", `limit: must be a whole number from 1 to ${String(AGENT_PUBLISH_LIST_MAX)}`);
  return limit;
}

/** Reads one index partition newest first, keeping the requests `keep` accepts, until `limit` or the read budget runs out. */
async function readRequests(deps: AgentRouteDependencies, caller: AgentCaller, pk: string, prefix: string | undefined, cursor: string | undefined, limit: number, keep: (record: PublicationRecord) => Promise<boolean>): Promise<{ requests: unknown[]; next?: string }> {
  const requests: unknown[] = [];
  let start: Record<string, unknown> | undefined = cursor === undefined ? undefined : { pk, sk: cursor };
  let last: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, ScanIndexForward: false, ConsistentRead: true, Limit: PAGE,
      KeyConditionExpression: prefix === undefined ? "pk = :pk" : "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": pk, ...(prefix === undefined ? {} : { ":prefix": prefix }) },
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<{ sk?: unknown; approvalId?: unknown; orgId?: unknown }>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of response.Items ?? []) {
      last = String(item.sk);
      if (item.orgId !== caller.orgId || typeof item.approvalId !== "string") continue;
      const record = await getApproval(deps, caller.orgId, item.approvalId as never);
      if (!isPublicationRecord(record) || !await keep(record)) continue;
      requests.push(await publishRequestView(deps, caller, record));
      if (requests.length >= limit) return { requests, next: encodeCursor(last) };
    }
    start = response.LastEvaluatedKey;
    if (start === undefined) return { requests };
  }
  return { requests, ...(last === undefined ? {} : { next: encodeCursor(last) }) };
}

/** `GET /v1/app/agent-publish-requests?state=pending|all&project=&mine=1&limit=&cursor=`: only requests the caller may see; `pending` keeps those that still wait (stale ones too). */
async function listRequests(deps: AgentRouteDependencies, caller: AgentCaller, url: URL): Promise<unknown> {
  const state = url.searchParams.get("state") ?? "pending";
  if (state !== "pending" && state !== "all") throw agentXError("CONFIG_INVALID", "state: must be pending or all");
  const mine = url.searchParams.get("mine");
  if (mine !== null && mine !== "1") throw agentXError("CONFIG_INVALID", "mine: must be 1");
  const rawProject = url.searchParams.get("project");
  const project = rawProject === null ? undefined : parseProject(rawProject);
  const pk = agentPublicationsIndexKey(caller.orgId, new Date(0).toISOString(), "apr_00000000000000000000" as never).pk;
  return readRequests(deps, caller, pk, undefined, decodeCursor(url.searchParams.get("cursor")), limitOf(url), async (record) => {
    if (state === "pending" && (record.status !== "PENDING" || Date.parse(record.expiresAt) <= deps.now())) return false;
    if (project !== undefined && (record.subject.target.kind !== "project" || record.subject.target.project !== project)) return false;
    if (mine === "1") return sameMember(deps, caller.orgId, record.requestedBy, caller.developerId);
    return maySeeRequest(deps, caller, record);
  });
}

/** `GET /v1/app/agents/{id}/publish-requests`: every request for one agent, newest first, to a person who manages it. */
async function listAgentRequests(deps: AgentRouteDependencies, caller: AgentCaller, agentId: AgentId, url: URL): Promise<unknown> {
  if (isBuiltinAgentId(agentId)) return { requests: [] };
  await requireAgentAccess(deps, caller, agentId, "manage");
  const pk = agentPublicationKey(caller.orgId, agentId, { pending: "company" }).pk;
  return readRequests(deps, caller, pk, "REQ#", decodeCursor(url.searchParams.get("cursor")), limitOf(url), async (record) => record.subject.agentId === agentId);
}

/**
 * `POST /v1/app/agent-publish-requests/{requestId}/withdraw`: the person who asked takes a waiting request back. The request is found by the asker's own request id, so
 * nobody else's id can name it; a repeat after it was withdrawn answers it again. A request already decided or expired is `409 APPROVAL_CLOSED`.
 */
async function withdraw(deps: AgentRouteDependencies, caller: AgentCaller, rawRequestId: string, body: unknown): Promise<unknown> {
  parseBody(AgentPublishWithdrawBodySchema, body);
  const requestId = AgentPublishWithdrawBodySchema.shape.requestId.safeParse(rawRequestId);
  const found = requestId.success ? await pendingChangeFor(deps, caller.orgId, caller.developerId, requestId.data) : undefined;
  if (!isPublicationRecord(found) || found.requestedBy !== caller.developerId) throw agentXError("NOT_FOUND", "no request has that ID");
  let record: PublicationRecord = found;
  if (record.status === "PENDING" && Date.parse(record.expiresAt) > deps.now()) {
    const at = new Date(deps.now()).toISOString();
    const ended = await withdrawChange(deps, record, caller.developerId, [withdrawnEvent(record, caller.developerId, at)]);
    const fresh = ended ?? await getApproval(deps, caller.orgId, record.approvalId);
    if (!isPublicationRecord(fresh)) throw agentXError("NOT_FOUND", "no request has that ID");
    record = fresh;
  }
  if (record.status !== "EXPIRED" || record.withdrawnBy !== caller.developerId) throw agentXError("APPROVAL_CLOSED", "this request was already decided or has expired");
  return { request: await publishRequestView(deps, caller, record) };
}

/** The routes of this file; undefined for any other path. `sub` is the agent path's own (`publish-requests`), routed by routes.ts. */
export async function routePublishRequests(deps: AgentRouteDependencies, caller: AgentCaller, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  const matched = PUBLISH_REQUESTS_PATH.exec(url.pathname);
  if (matched === null) return undefined;
  const [, rawRequestId, action] = matched;
  if (rawRequestId === undefined && request.method === "GET") return listRequests(deps, caller, url);
  if (rawRequestId !== undefined && action === "withdraw" && request.method === "POST") return withdraw(deps, caller, rawRequestId, jsonBody(request));
  throw agentXError("NOT_FOUND", "route not found");
}

/** `…/agents/{id}/publish-requests`. */
export async function routeAgentPublishRequests(deps: AgentRouteDependencies, caller: AgentCaller, request: AdaptedHttpRequest, agentId: AgentId, url: URL): Promise<unknown> {
  if (request.method === "POST") return askToPublish(deps, caller, agentId, jsonBody(request));
  if (request.method === "GET") return listAgentRequests(deps, caller, agentId, url);
  throw agentXError("NOT_FOUND", "route not found");
}
