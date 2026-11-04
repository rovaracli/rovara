// The Live wall's data (Plan 5 Task 14): `GET /v1/app/live?filter=all|mine|team|needs_me|failed&project=&cursor=&limit=`. The wall shows other people's work, so every tile is judged for the
// caller, now, by the same rules as a session's own view (`sessionAccessFor`, Task 4): a session they cannot view is not on their wall, whatever its id or its tile says, and what a tile
// offers (`actions`, `approvalUrl`) is theirs. A request reads the org's live index once (at most `LIVE_INDEX_SCAN_MAX` tiles, sorted newest first in memory), then the caller's grants and
// the shares that reach them once, and the sessions themselves, their tasks, People lists and follow items in batches of 100 keys; the people looking come from one query of the org's
// presence index and the caller's decisions from one list. So the reads grow with the number of 100-session batches judged (at most ten), never with the number of tiles.
//
// The index item (`LIVE_SESSIONS`) is only a list of ids with the few facts that narrow it before anything is read (open or ended, project, who is needed); a tile's words, owner and cost
// come from the session record, which the summary refresh writes in the same transaction. Nothing here is cached: a revoked grant or share is gone from the next answer.
import { BatchGetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  AGENTX_NAME_PATTERN,
  INDEX_EXPIRY_ATTRIBUTE,
  LIVE_ENDED_KEEP_HOURS,
  LIVE_FILTERS,
  LIVE_INDEX_SCAN_MAX,
  LIVE_PAGE_MAX,
  LIVE_VIEWING_MAX,
  LiveTileSchema,
  MEMBER_GRANT_SK_PREFIX,
  OrgRoleSchema,
  SESSION_STATUS_WORDS,
  SessionIdSchema,
  SessionLevelSchema,
  agentSessionKey,
  agentXError,
  livePresenceKey,
  liveSessionKey,
  memberGrantsPk,
  orgMemberKey,
  sharedSessionsKey,
  type AgentPrincipal,
  type AgentSessionRecord,
  type LiveFilter,
  type LiveResponse,
  type LiveTile,
  type OrgId,
  type ProjectRole,
  type SessionLevel,
  type SessionOwner,
} from "@agentx/contracts";
import { grantRoleOf } from "../developer/project-roles.js";
import { taskKey } from "../developer/task-records.js";
import type { Item } from "../agents/table-writes.js";
import { closableSession, newSessionRoleMemo, peopleOfItem, sessionActionsFor, sessionAccessFor, type SessionAccess, type SessionAccessPrefetch } from "./access.js";
import { presenceIsFresh } from "./followers.js";
import { approveLink, cursorKeyOf, openCursor, sealCursor, type SessionReadCaller, type SessionReadDependencies } from "./read.js";
import { sessionFromItem } from "./store.js";
import { chosenOwnerNames, withChosenOwnerName } from "./owner-names.js";

export type LiveDependencies = SessionReadDependencies;

export interface LiveQuery {
  filter?: string | undefined;
  project?: string | undefined;
  cursor?: string | undefined;
  /** Tiles in a page: 1 to `LIVE_PAGE_MAX`, which is also the default. */
  limit?: number | undefined;
}

type Key = { pk: string; sk: string };
const invalid = (message: string) => agentXError("CONFIG_INVALID", message);
const isAgentXError = (error: unknown): error is Error & { code?: string } => error instanceof Error && error.name === "AgentXError";
const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/** Keys DynamoDB takes in one `BatchGetItem`. */
const BATCH_KEYS = 100;
/** Sessions judged together: one batch of their records, then the batches of what they need. */
const CHUNK = 100;
/** How many times the keys a batch did not serve are asked for again before the wall says it is unavailable. */
const BATCH_ATTEMPTS = 5;
const BATCH_BACKOFF_MS = 25;
/** The most rows read of one share partition, of the caller's grants and of the org's presence. */
const ROWS_MAX = LIVE_INDEX_SCAN_MAX;
const UNAVAILABLE = "The Live wall can't be shown right now. Try again in a moment.";

export const keyText = (key: Key) => `${key.pk}\u0000${key.sk}`;

/**
 * The items at `keys` (any number, repeats ignored), in batches of 100, asking again for the keys the table left unprocessed (with a short wait between rounds). Keys with no item are
 * absent from the answer. A table that still has keys unprocessed after `BATCH_ATTEMPTS` rounds is `RUNTIME_UNAVAILABLE`: a wall with sessions missing would read as "nothing there".
 */
export async function batchGetItems(deps: Pick<LiveDependencies, "documentClient" | "tableName">, keys: readonly Key[]): Promise<Map<string, Item>> {
  const found = new Map<string, Item>();
  let pending = [...new Map(keys.map((key) => [keyText(key), { pk: key.pk, sk: key.sk }])).values()];
  for (let round = 0; pending.length > 0; round += 1) {
    if (round >= BATCH_ATTEMPTS) throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE);
    if (round > 0) await new Promise((resolve) => setTimeout(resolve, BATCH_BACKOFF_MS * 2 ** (round - 1)));
    const left: Key[] = [];
    for (let at = 0; at < pending.length; at += BATCH_KEYS) {
      const answer = await deps.documentClient.send(new BatchGetCommand({ RequestItems: { [deps.tableName]: { Keys: pending.slice(at, at + BATCH_KEYS), ConsistentRead: true } } })) as {
        Responses?: Record<string, Item[]>; UnprocessedKeys?: Record<string, { Keys?: Key[] }>;
      };
      for (const item of answer.Responses?.[deps.tableName] ?? []) found.set(keyText({ pk: String(item["pk"]), sk: String(item["sk"]) }), item);
      left.push(...(answer.UnprocessedKeys?.[deps.tableName]?.Keys ?? []));
    }
    pending = left;
  }
  return found;
}

/** The items of one partition (those whose sort key starts with `prefix`, when given), at most `max`; `more` says there were more. */
export async function queryPartition(deps: Pick<LiveDependencies, "documentClient" | "tableName">, pk: string, options: { prefix?: string; max: number }): Promise<{ items: Item[]; more: boolean }> {
  const items: Item[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, ConsistentRead: true,
      KeyConditionExpression: options.prefix === undefined ? "pk = :pk" : "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": pk, ...(options.prefix === undefined ? {} : { ":prefix": options.prefix }) },
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    items.push(...(page.Items ?? []));
    start = page.LastEvaluatedKey;
  } while (start !== undefined && items.length < options.max);
  return { items: items.slice(0, options.max), more: items.length > options.max || start !== undefined };
}

// ---- the index: which sessions, newest first

interface Candidate { sessionId: string; createdAt: string; key: string }

const sortKey = (createdAt: string, sessionId: string) => `${createdAt}#${sessionId}`;
const WINDOW_MS = LIVE_ENDED_KEEP_HOURS * 3_600_000;
const withinWindow = (endedAt: unknown, now: number): boolean => typeof endedAt === "string" && now - Date.parse(endedAt) < WINDOW_MS;

/**
 * What the index item says that cannot be right for the filter, so the session is not even read. A tile written at the start has only its id, project, owner and time, so a fact it
 * lacks never drops a session the filter might keep: only Needs me and Failed (whose sessions always have the summary that says so) are narrowed by the summary.
 */
function tileMayMatch(tile: Item, filter: LiveFilter, project: string | undefined, developerId: string, now: number): boolean {
  if (project !== undefined && tile["project"] !== project) return false;
  const ended = typeof tile["endedAt"] === "string";
  const summary = tile["summary"] as { needsPeople?: unknown; lastRunFailed?: unknown } | undefined;
  switch (filter) {
    case "failed":
      return ended ? tile["status"] === "failed" && withinWindow(tile["endedAt"], now) : summary?.lastRunFailed === true;
    case "needs_me":
      return !ended && Array.isArray(summary?.needsPeople) && (summary.needsPeople as unknown[]).includes(developerId);
    default:
      return !ended;
  }
}

/** The same question of the session record itself, which is what decides. */
function sessionMatches(session: AgentSessionRecord, filter: LiveFilter, project: string | undefined, developerId: string, now: number): boolean {
  if (project !== undefined && session.project !== project) return false;
  const ended = session.endedAt !== undefined;
  switch (filter) {
    case "failed":
      return ended ? session.summary.status === "failed" && withinWindow(session.endedAt, now) : session.summary.lastRunFailed === true;
    case "needs_me":
      return !ended && session.summary.needsPeople.includes(developerId);
    default:
      return !ended;
  }
}

// ---- what is read once for the caller

/** The caller's own grant rows, by project. */
async function readGrants(deps: LiveDependencies, caller: SessionReadCaller): Promise<Map<string, ProjectRole>> {
  const grants = new Map<string, ProjectRole>();
  const { items } = await queryPartition(deps, memberGrantsPk(caller.orgId, caller.developerId), { prefix: MEMBER_GRANT_SK_PREFIX, max: ROWS_MAX });
  for (const item of items) {
    const sk = text(item["sk"]);
    const role = grantRoleOf(item);
    if (sk !== undefined && role !== undefined) grants.set(sk.slice(MEMBER_GRANT_SK_PREFIX.length), role);
  }
  return grants;
}

/** The shares that reach the caller, by session: those to them, to the whole company and to each of `projects`, from the org's share index. */
async function readShares(deps: LiveDependencies, caller: SessionReadCaller, projects: Iterable<string>, log: (entry: Record<string, unknown>) => void): Promise<Map<string, Array<{ principal: AgentPrincipal; level: SessionLevel }>>> {
  const principals: AgentPrincipal[] = [{ kind: "member", developerId: caller.developerId }, { kind: "org" }, ...[...projects].map((project) => ({ kind: "project" as const, project }))];
  const shares = new Map<string, Array<{ principal: AgentPrincipal; level: SessionLevel }>>();
  for (const principal of principals) {
    const { items, more } = await queryPartition(deps, sharedSessionsKey(caller.orgId, principal, "ses_00000000000000000000").pk, { max: ROWS_MAX });
    // Shares past the cap are not read, so a session shared only through them stays off the wall: say so (the kind of partition only; never a project name or a session).
    if (more) log({ event: "agent_session.live_shares_truncated", orgId: caller.orgId, principal: principal.kind });
    for (const item of items) {
      const id = SessionIdSchema.safeParse(item["sessionId"]);
      const level = SessionLevelSchema.safeParse(item["level"]);
      if (!id.success || !level.success || item["orgId"] !== caller.orgId) continue;
      shares.set(id.data, [...(shares.get(id.data) ?? []), { principal, level: level.data }]);
    }
  }
  return shares;
}

/** Whether a row's own expiry (epoch seconds, set by the heartbeat) has passed; the table deletes late. A row with no readable expiry is judged by its heartbeat time alone. */
const presenceHasExpired = (expiresAt: unknown, nowMs: number): boolean => typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt * 1000 <= nowMs;

/** The people looking now, by session, from the org's presence index: fresh heartbeats only (the table deletes late), the names as the heartbeat stored them. */
async function readViewers(deps: LiveDependencies, orgId: OrgId, nowMs: number, log: (entry: Record<string, unknown>) => void): Promise<Map<string, SessionOwner[]>> {
  const viewers = new Map<string, SessionOwner[]>();
  const { items, more } = await queryPartition(deps, livePresenceKey(orgId, "ses_00000000000000000000", "x").pk, { max: ROWS_MAX });
  if (more) log({ event: "agent_session.live_presence_truncated", orgId });
  for (const item of items) {
    const sessionId = text(item["sessionId"]);
    const developerId = text(item["developerId"]);
    const name = text(item["name"]);
    if (item["orgId"] !== orgId || sessionId === undefined || developerId === undefined || name === undefined || !presenceIsFresh(item["at"], nowMs) || presenceHasExpired(item[INDEX_EXPIRY_ATTRIBUTE], nowMs)) continue;
    viewers.set(sessionId, [...(viewers.get(sessionId) ?? []), { developerId, name }]);
  }
  return viewers;
}

// ---- the wall

function checkedQuery(query: LiveQuery): { filter: LiveFilter; project: string | undefined; limit: number } {
  const filter = query.filter ?? "all";
  if (!(LIVE_FILTERS as readonly string[]).includes(filter)) throw invalid(`filter: must be one of ${LIVE_FILTERS.slice(0, -1).join(", ")} or ${LIVE_FILTERS.at(-1)!}`);
  if (query.project !== undefined && !AGENTX_NAME_PATTERN.test(query.project)) throw invalid("project: is not a project name");
  const limit = query.limit ?? LIVE_PAGE_MAX;
  if (!Number.isInteger(limit) || limit < 1 || limit > LIVE_PAGE_MAX) throw invalid(`limit: must be a whole number from 1 to ${String(LIVE_PAGE_MAX)}`);
  return { filter: filter as LiveFilter, project: query.project, limit };
}

interface Judged { session: AgentSessionRecord; access: SessionAccess }

/**
 * `GET /v1/app/live`: one page of the caller's wall, newest session first. `all` is every open session the caller can view; `mine` the ones they own now or started; `team` the ones on
 * projects they have a role in (a local session only when it was shared with them); `needs_me` the ones waiting on them; `failed` the ones that ended failed within the last
 * `LIVE_ENDED_KEEP_HOURS` or are open with a failed last run. A person who is no longer in the org has an empty wall.
 */
export async function liveSessions(deps: LiveDependencies, caller: SessionReadCaller, query: LiveQuery): Promise<LiveResponse> {
  return readLive(deps, caller, query, false);
}

/** Task 6: all caller-visible open tiles for navigation, using the exact same access checks and one live-index read. Never a public page-size option. */
export async function navigationLive(deps: LiveDependencies, caller: SessionReadCaller): Promise<LiveTile[]> {
  return (await readLive(deps, caller, { filter: "all" }, true)).tiles;
}

async function readLive(deps: LiveDependencies, caller: SessionReadCaller, query: LiveQuery, navigation: boolean): Promise<LiveResponse> {
  const checked = checkedQuery(query);
  const { filter, project } = checked;
  const limit = navigation ? LIVE_INDEX_SCAN_MAX : checked.limit;
  const { orgId } = caller;
  cursorKeyOf(deps); // a wall that can't seal its cursor doesn't start
  const cursorLabel = `${orgId}#LIVE#${filter}#${project ?? ""}`;
  const after = query.cursor === undefined ? undefined : openCursor(deps, caller, cursorLabel, query.cursor);
  const log = (entry: Record<string, unknown>) => (deps.log ?? ((line: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", ...line }))))(entry);
  const nowMs = deps.now();

  const member = (await batchGetItems(deps, [orgMemberKey(orgId, caller.developerId)])).values().next().value;
  const orgRole = OrgRoleSchema.safeParse(member?.["role"]);
  if (!orgRole.success) return { tiles: [] };

  // The index: every open session of the org (and recent ends), newest first.
  const index = await queryPartition(deps, liveSessionKey(orgId, "ses_00000000000000000000").pk, { max: LIVE_INDEX_SCAN_MAX });
  if (index.more) log({ event: "agent_session.live_index_truncated", orgId });
  const candidates: Candidate[] = [];
  const tileProjects = new Set<string>();
  for (const tile of index.items) {
    const id = SessionIdSchema.safeParse(tile["sessionId"]);
    const createdAt = text(tile["createdAt"]);
    if (!id.success || tile["orgId"] !== orgId || createdAt === undefined || !tileMayMatch(tile, filter, project, caller.developerId, nowMs)) continue;
    const key = sortKey(createdAt, id.data);
    if (after !== undefined && key >= after) continue;
    candidates.push({ sessionId: id.data, createdAt, key });
    const tileProject = text(tile["project"]);
    if (tileProject !== undefined) tileProjects.add(tileProject);
  }
  candidates.sort((left, right) => (left.key < right.key ? 1 : left.key > right.key ? -1 : 0));
  if (candidates.length === 0) return { tiles: [] };

  // What the rules need that is the same for every session: the caller's grants, and the shares that reach them.
  const grants = await readGrants(deps, caller);
  const shares = await readShares(deps, caller, new Set([...grants.keys(), ...tileProjects]), log);
  const memo = newSessionRoleMemo();

  const judgedAll: Array<Judged & { key: string }> = [];
  const followers = new Set<string>();
  for (let from = 0; from < candidates.length && judgedAll.length <= limit; from += CHUNK) {
    const chunk = candidates.slice(from, from + CHUNK);
    const metas = await batchGetItems(deps, chunk.map((candidate) => agentSessionKey(orgId, candidate.sessionId, "META")));
    const sessions: Array<{ index: number; session: AgentSessionRecord }> = [];
    for (const [offset, candidate] of chunk.entries()) {
      const item = metas.get(keyText(agentSessionKey(orgId, candidate.sessionId, "META")));
      if (item === undefined) continue;
      const session = sessionFromItem(item);
      if (session === undefined || session.orgId !== orgId || session.sessionId !== candidate.sessionId) {
        log({ event: "agent_session.live_session_unreadable", sessionId: candidate.sessionId });
        continue;
      }
      if (sessionMatches(session, filter, project, caller.developerId, nowMs)) sessions.push({ index: from + offset, session });
    }
    if (sessions.length === 0) continue;

    // Their tasks and People lists, and whether the caller follows each, in the fewest batches.
    const taskIds = [...new Set(sessions.flatMap(({ session }) => (session.subject.kind === "task" ? [session.subject.taskId] : [])))];
    const wanted = [
      ...taskIds.flatMap((taskId) => [taskKey(taskId), { pk: `DEVTASK#${taskId}`, sk: "PEOPLE" }]),
      ...sessions.map(({ session }) => agentSessionKey(orgId, session.sessionId, `FOLLOWER#${caller.developerId}`)),
    ];
    const read = await batchGetItems(deps, wanted);
    const prefetch: SessionAccessPrefetch = {
      grant: (name) => grants.get(name),
      task: (taskId) => read.get(keyText(taskKey(taskId))),
      people: (taskId) => peopleOfItem(read.get(keyText({ pk: `DEVTASK#${taskId}`, sk: "PEOPLE" }))),
      shares: (session) => shares.get(session.sessionId) ?? [],
    };

    for (const { index: at, session } of sessions) {
      let judged: Awaited<ReturnType<typeof sessionAccessFor>>;
      try {
        judged = await sessionAccessFor(deps, caller, orgRole.data, session, { prefetch, memo, ...(filter === "team" ? { wantShareRole: true as const } : {}) });
      } catch (error) {
        // A role that cannot be read is no access (as a list does), never a reason to show the session.
        if (isAgentXError(error)) continue;
        throw error;
      }
      const { access, shareRole } = judged;
      if (access === undefined) continue;
      if (filter === "mine" && !(access.owner || (session.startedBy.kind === "member" && session.startedBy.developerId === caller.developerId))) continue;
      if (filter === "team" && !(session.kind === "local" ? !access.owner : shareRole !== undefined)) continue;
      judgedAll.push({ session, access, key: candidates[at]!.key });
      if (read.has(keyText(agentSessionKey(orgId, session.sessionId, `FOLLOWER#${caller.developerId}`)))) followers.add(session.sessionId);
    }
  }
  if (judgedAll.length === 0) return { tiles: [] };
  // One more than a page is judged, so there is a next page exactly when a further session the caller may see exists (never a cursor to an empty page, and never a hint that hidden ones follow).
  const more = judgedAll.length > limit;
  const page = judgedAll.slice(0, limit);

  // The decisions the caller may make, listed once for the page, only for sessions that have one waiting.
  const decided = new Map<string, string>();
  const waiting = page.filter(({ session }) => session.summary.pendingApprovals > 0).map(({ session }) => session);
  if (waiting.length > 0 && deps.deciding?.approvalsFor !== undefined) {
    try {
      for (const [sessionId, decisions] of await deps.deciding.approvalsFor(caller, waiting)) {
        const first = decisions[0];
        if (first !== undefined) decided.set(sessionId, approveLink(deps, first.approvalId));
      }
    } catch (error) {
      // The decisions could not be read: no link, never a wall that fails for it.
      if (!isAgentXError(error)) throw error;
    }
  }
  const viewers = await readViewers(deps, orgId, nowMs, log);

  // Release 0.4.18: the owners' chosen names, one BatchGetItem for the page.
  const ownerNames = await chosenOwnerNames(deps, page.map(({ access }) => access.effectiveOwner.developerId));
  const tiles: LiveTile[] = [];
  for (const { session, access } of page) {
    const { summary } = session;
    const looking = [...(viewers.get(session.sessionId) ?? [])].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.developerId < b.developerId ? -1 : a.developerId > b.developerId ? 1 : 0));
    const approvalUrl = decided.get(session.sessionId);
    const built = LiveTileSchema.safeParse({
      contractVersion: 1,
      sessionId: session.sessionId,
      kind: session.kind,
      title: session.title,
      ...(session.agent === undefined ? {} : { agent: session.agent }),
      ...(session.project === undefined ? {} : { project: session.project }),
      owner: withChosenOwnerName(access.effectiveOwner, ownerNames),
      where: session.where.kind === "cloud" ? { kind: "cloud" } : { kind: "mac", label: session.where.label, offline: summary.offline === true },
      status: summary.status,
      statusWords: SESSION_STATUS_WORDS[summary.status],
      ...(summary.step === undefined ? {} : { step: summary.step }),
      ...(summary.peek === undefined ? {} : { peek: summary.peek }),
      ...(summary.lastRunFailed === undefined ? {} : { lastRunFailed: summary.lastRunFailed }),
      costUsd: summary.costUsd,
      viewingNow: looking.slice(0, LIVE_VIEWING_MAX),
      viewingNowCount: looking.length,
      needsYou: summary.needsPeople.includes(caller.developerId),
      following: access.owner || followers.has(session.sessionId),
      actions: sessionActionsFor(access, { ...summary, closable: closableSession(session) }),
      ...(approvalUrl === undefined ? {} : { approvalUrl }),
      updatedAt: session.updatedAt,
    });
    if (built.success) tiles.push(built.data);
    else log({ event: "agent_session.live_tile_invalid", sessionId: session.sessionId, problem: built.error.issues[0]?.path.join(".") ?? "tile" });
  }
  return { tiles, ...(more ? { next: sealCursor(deps, caller, cursorLabel, page.at(-1)!.key) } : {}) };
}
