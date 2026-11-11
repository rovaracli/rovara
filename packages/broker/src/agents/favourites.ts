// Favourite and suggested agents (experience decision 23): `GET /v1/app/me/agents?project=` (the Home row: the person's favourites, then agents the server suggests by
// rules that can be explained) and `PUT /v1/app/me/agents/favourites` (the whole ordered list, fenced by its revision). One small item per person and company
// (`agentFavouritesKey`), in the State table. Only agents the person can see now are shown or accepted; a stored favourite that became invisible (access removed, agent
// archived, a built-in turned off) is kept, left out of the answer without a word, and comes back when access does. Suggestions come from data that exists:
// `project_roster` (the asked project's roster), `used_by_you` (the person's own last sessions), `starter` (built-ins the company has not turned off). `popular_in_company`
// needs run counts, which are not kept, so it is never sent. Favourites are a personal preference and are not audited.
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { createHash } from "node:crypto";
import { FavouriteAgentsBodySchema, MAX_FAVOURITE_AGENTS, MAX_SUGGESTED_AGENTS, MY_AGENTS_PATH, MY_FAVOURITE_AGENTS_PATH, agentFavouritesKey, type AgentCard } from "@agentx/cloud-contracts";
import { AgentIdSchema, AgentXNameSchema, BUILTIN_AGENTS, agentSessionKey, agentXError, canonicalJson, mySessionsKey, type AgentId, type SessionId } from "@rovara-code/contracts";
import type { AdaptedHttpRequest } from "../aws/lambda.js";
import { listVisibleAgents, type AgentCaller, type VisibleAgent } from "./access.js";
import { publicationOf } from "./publication.js";
import { listRoster } from "./roster.js";
import { jsonBody, parseBody, type AgentRouteDependencies } from "./routes.js";

/** Stored favourites a person can't see now are kept, up to this many ids in all, so the item stays small. */
const MAX_STORED_FAVOURITES = 50;
/** How many of the person's own sessions are read for `used_by_you`. */
const RECENT_SESSIONS = 20;
const PROBE_ID = "s_00000000000000000000" as SessionId;

interface StoredFavourites { agentIds: AgentId[]; revision: number; lastRequestId?: string; lastFingerprint?: string }

export const isMyAgentsRoute = (pathname: string): boolean => pathname === MY_AGENTS_PATH || pathname === MY_FAVOURITE_AGENTS_PATH;

async function readFavourites(deps: AgentRouteDependencies, caller: AgentCaller): Promise<StoredFavourites> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: agentFavouritesKey(caller.orgId, caller.developerId), ConsistentRead: true })) as { Item?: Record<string, unknown> };
  const item = response.Item;
  if (item === undefined) return { agentIds: [], revision: 0 };
  const revision = typeof item["revision"] === "number" && Number.isInteger(item["revision"]) ? item["revision"] : 0;
  // A stored id that is not an agent id is dropped on read (never shown, never kept on the next save).
  const agentIds = Array.isArray(item["agentIds"]) ? item["agentIds"].flatMap((id) => { const parsed = AgentIdSchema.safeParse(id); return parsed.success ? [parsed.data] : []; }) : [];
  return {
    agentIds, revision,
    ...(typeof item["lastRequestId"] === "string" ? { lastRequestId: item["lastRequestId"] } : {}),
    ...(typeof item["lastFingerprint"] === "string" ? { lastFingerprint: item["lastFingerprint"] } : {}),
  };
}

/** The agents the person can see now and may pick: active, and not a built-in the company turned off (an admin sees those marked, but can't run them). */
async function pickable(deps: AgentRouteDependencies, caller: AgentCaller): Promise<Map<string, VisibleAgent>> {
  const visible = await listVisibleAgents(deps, caller, "all");
  return new Map(visible.filter((agent) => agent.disabled !== true && (agent.record === undefined || agent.record.status === "active")).map((agent) => [agent.agentId, agent]));
}

async function cardOf(deps: AgentRouteDependencies, caller: AgentCaller, agent: VisibleAgent, reason: AgentCard["reason"]): Promise<AgentCard> {
  const record = agent.record;
  if (record === undefined) {
    return {
      agentId: agent.agentId, name: agent.name, description: BUILTIN_AGENTS[agent.agentId as keyof typeof BUILTIN_AGENTS].description, builtin: true, status: "active", access: agent.access,
      publication: { level: "company", projects: [], pending: null }, reason,
    };
  }
  return {
    agentId: record.agentId, name: record.name, description: record.description, builtin: false, status: record.status, access: agent.access,
    ...(record.currentVersion === undefined ? {} : { currentVersion: record.currentVersion }), owner: record.owner,
    publication: await publicationOf(deps, caller, record), reason,
  };
}

/** The agents named by the person's own last sessions, newest first (the session's own record says which agent ran; nothing else of it is read). */
async function usedByYou(deps: AgentRouteDependencies, caller: AgentCaller): Promise<AgentId[]> {
  const listed = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": mySessionsKey(caller.orgId, caller.developerId, new Date(0).toISOString(), PROBE_ID).pk },
    ScanIndexForward: false, Limit: RECENT_SESSIONS, ConsistentRead: true,
  })) as { Items?: Array<{ sessionId?: unknown; orgId?: unknown }> };
  const ids: AgentId[] = [];
  for (const row of listed.Items ?? []) {
    if (row.orgId !== caller.orgId || typeof row.sessionId !== "string") continue;
    let session: { Item?: { orgId?: unknown; agent?: { agentId?: unknown } } };
    try {
      session = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: agentSessionKey(caller.orgId, row.sessionId, "META"), ProjectionExpression: "#org, #agent", ExpressionAttributeNames: { "#org": "orgId", "#agent": "agent" } })) as typeof session;
    } catch {
      continue; // a session id that is not one (or a read that failed) suggests nothing
    }
    if (session.Item?.orgId !== caller.orgId) continue;
    const parsed = AgentIdSchema.safeParse(session.Item.agent?.agentId);
    if (parsed.success && !ids.includes(parsed.data)) ids.push(parsed.data);
  }
  return ids;
}

/** `GET /v1/app/me/agents?project=`. */
async function myAgents(deps: AgentRouteDependencies, caller: AgentCaller, url: URL): Promise<unknown> {
  const rawProject = url.searchParams.get("project");
  let project: string | undefined;
  if (rawProject !== null) {
    const parsed = AgentXNameSchema.safeParse(rawProject);
    if (!parsed.success) throw agentXError("PROJECT_NOT_FOUND", "that is not a valid project name");
    project = parsed.data;
  }
  const stored = await readFavourites(deps, caller);
  const can = await pickable(deps, caller);
  const favourites: AgentCard[] = [];
  for (const id of stored.agentIds) {
    const agent = can.get(id);
    if (agent !== undefined && favourites.length < MAX_FAVOURITE_AGENTS) favourites.push(await cardOf(deps, caller, agent, "favourite"));
  }
  const taken = new Set(favourites.map((card) => card.agentId));
  const suggested: AgentCard[] = [];
  const suggest = async (id: string, reason: AgentCard["reason"], onProject: Set<string> | undefined) => {
    if (suggested.length >= MAX_SUGGESTED_AGENTS || taken.has(id)) return;
    const agent = can.get(id);
    // Never an agent the person can't see, nor one the asked project's roster leaves out.
    if (agent === undefined || (onProject !== undefined && !onProject.has(id))) return;
    taken.add(id);
    suggested.push(await cardOf(deps, caller, agent, reason));
  };
  // The asked project's roster (the person needs a role on it: listRoster says not found otherwise); built-ins are on every roster.
  const roster = project === undefined ? undefined : await listRoster(deps, caller, project);
  const onProject = roster === undefined ? undefined : new Set(roster.map((entry) => entry.agentId));
  for (const entry of roster ?? []) if (!entry.builtin) await suggest(entry.agentId, "project_roster", onProject);
  for (const id of await usedByYou(deps, caller)) await suggest(id, "used_by_you", onProject);
  for (const agent of can.values()) if (agent.builtin) await suggest(agent.agentId, "starter", onProject);
  return { favourites, suggested, limits: { maxFavourites: MAX_FAVOURITE_AGENTS, maxSuggested: MAX_SUGGESTED_AGENTS }, revision: stored.revision };
}

const fingerprintOf = (body: { expectedRevision: number; agentIds: readonly string[] }): string => createHash("sha256").update(canonicalJson({ expectedRevision: body.expectedRevision, agentIds: body.agentIds }), "utf8").digest("hex");

/**
 * `PUT /v1/app/me/agents/favourites`: the whole ordered list, up to 12 agents the person can see now, while the stored list is still at `expectedRevision` (0: none yet).
 * An id they can't see is `CONFIG_INVALID` with one sentence for unknown and hidden alike. Stored favourites they can't see now are kept after the new list. A repeat of the
 * same request answers the list as it is; the same request id with another body is `409 IDEMPOTENCY_CONFLICT`; a moved revision is `409 CHANGE_STALE`.
 */
async function putFavourites(deps: AgentRouteDependencies, caller: AgentCaller, body: unknown): Promise<unknown> {
  const input = parseBody(FavouriteAgentsBodySchema, body);
  const stored = await readFavourites(deps, caller);
  const print = fingerprintOf(input);
  const answer = async (agentIds: readonly AgentId[], revision: number) => {
    const can = await pickable(deps, caller);
    const favourites: AgentCard[] = [];
    for (const id of agentIds) { const agent = can.get(id); if (agent !== undefined && favourites.length < MAX_FAVOURITE_AGENTS) favourites.push(await cardOf(deps, caller, agent, "favourite")); }
    return { favourites, revision };
  };
  if (stored.lastRequestId === input.requestId) {
    if (stored.lastFingerprint !== print) throw agentXError("IDEMPOTENCY_CONFLICT", "requestId: this request ID was already used for a different request");
    return answer(stored.agentIds, stored.revision);
  }
  if (input.expectedRevision !== stored.revision) throw agentXError("CHANGE_STALE", "Your favourites changed somewhere else. Reload them and try again.");
  if (new Set(input.agentIds).size !== input.agentIds.length) throw agentXError("CONFIG_INVALID", "agentIds: an agent is in the list twice");
  const can = await pickable(deps, caller);
  if (input.agentIds.some((id) => !can.has(id))) throw agentXError("CONFIG_INVALID", "agentIds: one of these isn't an agent you can pick");
  const hidden = stored.agentIds.filter((id) => !can.has(id) && !input.agentIds.includes(id));
  const agentIds = [...input.agentIds, ...hidden].slice(0, MAX_STORED_FAVOURITES);
  const revision = stored.revision + 1;
  try {
    await deps.documentClient.send(new PutCommand({
      TableName: deps.tableName,
      Item: { ...agentFavouritesKey(caller.orgId, caller.developerId), entityType: "AGENT_FAVOURITES", orgId: caller.orgId, agentIds, revision, lastRequestId: input.requestId, lastFingerprint: print, updatedAt: new Date(deps.now()).toISOString() },
      ...(stored.revision === 0 ? { ConditionExpression: "attribute_not_exists(pk)" } : { ConditionExpression: "#revision = :seen", ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":seen": stored.revision } }),
    }));
  } catch (error) {
    if (error instanceof Error && error.name === "ConditionalCheckFailedException") throw agentXError("CHANGE_STALE", "Your favourites changed somewhere else. Reload them and try again.");
    throw error;
  }
  return answer(agentIds, revision);
}

export async function routeMyAgents(deps: AgentRouteDependencies, caller: AgentCaller, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  if (url.pathname === MY_AGENTS_PATH && request.method === "GET") return myAgents(deps, caller, url);
  if (url.pathname === MY_FAVOURITE_AGENTS_PATH && request.method === "PUT") return putFavourites(deps, caller, jsonBody(request));
  throw agentXError("NOT_FOUND", "route not found");
}
