// Insights: STUCK work (design section 3). The rows come from the org's live index (open sessions that need someone) and from the open spending requests, read for the company and then cut down to the
// viewer's scope. What a row SAYS depends on the reader, row by row:
//   - every row in scope shows the state, its fixed words, the age, the project, the next actor (a person's name too, decision 91) and who owns the work;
//   - only a row the reader could OPEN today (`sessionAccessFor`, the rules the Live wall uses) also carries its title, its reason sentence and its link. A row the reader cannot open is a METADATA row:
//     no title, no reason, no link. A budget request that belongs to no session is always a metadata row.
// Counts and the order need only the sessions' own records, so the (bounded) access judging runs on the page that is answered, not on the whole list. A source that fails is skipped, logged with fixed
// words, and says so in `coverage.partial`; a list never fails for one source.
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  INSIGHTS_STUCK_NOT_COVERED, INSIGHTS_STUCK_SOURCES, LIVE_INDEX_SCAN_MAX, SessionIdSchema, TASK_STATUS_WORDS, agentSessionKey, agentXError, hideEmailAddresses, liveSessionKey, openSpendRequestsKey,
  sessionLink, sessionTaskStatus, statusNeedsSomeone,
  type AgentSessionRecord, type InsightsCoverage, type OrgId, type InsightsNextActor, type InsightsStuck, type InsightsStuckItem, type SpendRequestRecord, type TaskStatus,
} from "@agentx/contracts";
import { newSessionRoleMemo, effectiveOwnerId, sessionAccessFor } from "../agent-sessions/access.js";
import { batchGetItems, keyText, queryPartition, type LiveDependencies } from "../agent-sessions/live.js";
import { sessionFromItem } from "../agent-sessions/store.js";
import { taskKey } from "../developer/task-records.js";
import { getSpendRequest } from "../spend/requests.js";
import { insightsNames, type InsightsNameDependencies } from "./names.js";
import { opaqueRowId } from "./row-id.js";
import { inScope, type InsightsCaller, type InsightsViewer } from "./scope.js";

export interface InsightsStuckDependencies extends InsightsNameDependencies {
  /** The session reads (the Live wall's). Without them the sessions source is skipped and the list says so. */
  sessions?: LiveDependencies | undefined;
  /** The key a metadata row's opaque id is made with (`insightsRowKeyOf(server secret)`). Without it the list answers unavailable: a row the reader cannot open must never carry the raw id. */
  rowKey?: string | undefined;
}
export interface StuckQuery { project?: string | undefined; minAgeHours?: number | undefined; limit: number; cursor?: string | undefined }

type Item = Record<string, unknown>;
const NO_PROJECT = "No project";
const HOUR_MS = 3_600_000;
/** The most open spending requests read in one answer (Home reads the same number). */
const SPEND_SCAN_MAX = 200;
const CHUNK = 100;
const SPEND_ONLY_WORDS = "Waiting for a budget decision";
const KINDS = ["person", "group", "role", "rovara", "unknown"] as const;
const BLOCKERS = ["decision", "approval", "spend", "review", "merge", "budget", "failure", "setup", "unknown"] as const;
const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const isAgentXError = (error: unknown): boolean => error instanceof Error && error.name === "AgentXError";
const log = (event: string, fields: Record<string, unknown> = {}): void => console.log(JSON.stringify({ component: "broker", event, ...fields }));

/** One row before it is judged for the reader: what the records say, the same for every reader. */
interface Draft {
  /** The raw session id or spending request id. Leaves the broker only on a row the reader can open. */
  itemId: string;
  /** The opaque id of the same work: what the order and the cursor use, and what a metadata row carries. */
  sortId: string;
  project: string;
  session?: AgentSessionRecord | undefined;
  spend?: SpendRequestRecord | undefined;
  status: TaskStatus | undefined;
  blocker: InsightsStuckItem["blocker"];
  kind: InsightsNextActor["kind"];
  since: string;
  sinceKind: "state" | "last_update";
}

function blockerOf(session: AgentSessionRecord | undefined, spend: SpendRequestRecord | undefined, status: TaskStatus | undefined): InsightsStuckItem["blocker"] {
  if (spend !== undefined) return "spend";
  if (session === undefined || status === undefined) return "unknown";
  switch (status.state) {
    case "paused_budget": return "budget";
    case "failed": return "failure";
    case "ready_to_merge": return "merge";
    case "needs_you": return session.summary.pendingApprovals > 0 ? "approval" : "decision";
    default: return "unknown";
  }
}

function kindOf(session: AgentSessionRecord | undefined, spend: SpendRequestRecord | undefined, status: TaskStatus | undefined): InsightsNextActor["kind"] {
  if (spend !== undefined) {
    if (spend.approverRole === "org_admin" || spend.approverRole === "project_maintainer") return "role";
    return spend.approverIds.length === 1 ? "person" : spend.approverIds.length > 1 ? "group" : "role";
  }
  if (session === undefined || status === undefined) return "unknown";
  if (session.summary.needsPeople.length === 1) return "person";
  if (session.summary.needsPeople.length > 1) return "group";
  if (status.state === "paused_budget") return "role";
  return status.state === "needs_you" || status.state === "ready_to_merge" || status.state === "failed" ? "person" : "unknown";
}

const stuckSession = (session: AgentSessionRecord, status: TaskStatus): boolean => session.endedAt === undefined && (statusNeedsSomeone(status) || session.summary.needsPeople.length > 0);

// ---- the sources

async function readSessions(deps: LiveDependencies, orgId: OrgId, viewer: InsightsViewer, query: StuckQuery): Promise<{ sessions: AgentSessionRecord[]; truncated: boolean }> {
  const index = await queryPartition(deps, liveSessionKey(orgId, "ses_00000000000000000000").pk, { max: LIVE_INDEX_SCAN_MAX });
  const ids: string[] = [];
  for (const tile of index.items) {
    const id = SessionIdSchema.safeParse(tile["sessionId"]);
    if (!id.success || tile["orgId"] !== orgId || typeof tile["endedAt"] === "string") continue;
    const project = text(tile["project"]);
    // The viewer's scope narrows the index before anything is read: a maintainer's list never even loads another project's session.
    if (viewer.scope.kind === "projects" && (project === undefined || !inScope(viewer, project))) continue;
    if (query.project !== undefined && project !== query.project) continue;
    ids.push(id.data);
  }
  const sessions: AgentSessionRecord[] = [];
  for (let at = 0; at < ids.length; at += CHUNK) {
    const chunk = ids.slice(at, at + CHUNK);
    const metas = await batchGetItems(deps, chunk.map((id) => agentSessionKey(orgId, id, "META")));
    for (const id of chunk) {
      const item = metas.get(keyText(agentSessionKey(orgId, id, "META")));
      const session = item === undefined ? undefined : sessionFromItem(item);
      if (session === undefined || session.orgId !== orgId || session.sessionId !== id) continue;
      if (viewer.scope.kind === "projects" && (session.project === undefined || !inScope(viewer, session.project))) continue;
      sessions.push(session);
    }
  }
  return { sessions, truncated: index.more };
}

async function readOpenSpend(deps: InsightsStuckDependencies, orgId: OrgId, nowMs: number): Promise<SpendRequestRecord[]> {
  const open = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": openSpendRequestsKey(orgId, "2000-01-01T00:00:00.000Z", "spr_0").pk }, ConsistentRead: true, Limit: SPEND_SCAN_MAX,
  })) as { Items?: Item[] };
  const records: SpendRequestRecord[] = [];
  for (const row of (open.Items ?? []).slice(0, SPEND_SCAN_MAX)) {
    const id = text(row["spendRequestId"]);
    if (id === undefined || row["orgId"] !== orgId) continue;
    const record = await getSpendRequest(deps, orgId, id);
    if (record === undefined || record.status !== "PENDING" || Date.parse(record.expiresAt) <= nowMs) continue;
    records.push(record);
  }
  return records;
}

// ---- the list

// The cursor and the order use the opaque id, never the raw one: a cursor is handed to every reader, including one who cannot open the row.
const cursorOf = (draft: { since: string; sortId: string }): string => Buffer.from(JSON.stringify({ s: draft.since, i: draft.sortId })).toString("base64url");
function openCursor(raw: string): { since: string; sortId: string } {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { s?: unknown; i?: unknown };
    if (typeof parsed.s === "string" && typeof parsed.i === "string" && Number.isFinite(Date.parse(parsed.s)) && /^[A-Za-z0-9_-]{1,100}$/u.test(parsed.i)) return { since: parsed.s, sortId: parsed.i };
  } catch { /* not ours */ }
  throw agentXError("CONFIG_INVALID", "cursor: not a cursor from this list");
}

export const STUCK_COVERAGE = (partial: boolean, truncated: boolean, sessionsRead: boolean): InsightsCoverage => ({
  sources: INSIGHTS_STUCK_SOURCES.filter((source) => source !== "sessions" || sessionsRead), notCovered: [...INSIGHTS_STUCK_NOT_COVERED], partial, truncated,
});

export async function buildStuck(deps: InsightsStuckDependencies, caller: InsightsCaller, viewer: InsightsViewer, query: StuckQuery): Promise<InsightsStuck> {
  const nowMs = deps.now();
  const orgId = caller.orgId;
  // No key for the opaque ids: nothing is listed (a metadata row must never fall back to the raw id), and the answer says so the way every unreadable list does.
  if (deps.rowKey === undefined || deps.rowKey === "") {
    log("insights.stuck_row_key_missing");
    return { status: "unavailable", asOf: new Date(nowMs).toISOString(), coverage: STUCK_COVERAGE(true, false, false), summary: { total: 0, over24h: 0, over72h: 0, byNextActorKind: Object.fromEntries(KINDS.map((kind) => [kind, 0])), byBlocker: Object.fromEntries(BLOCKERS.map((blocker) => [blocker, 0])) }, items: [] };
  }
  const rowKey = deps.rowKey;
  let partial = false, truncated = false;
  const drafts = new Map<string, Draft>();

  if (deps.sessions !== undefined) {
    try {
      const read = await readSessions(deps.sessions, orgId, viewer, query);
      truncated = read.truncated;
      for (const session of read.sessions) {
        const status = sessionTaskStatus(session.summary);
        if (!stuckSession(session, status)) continue;
        drafts.set(session.sessionId, {
          itemId: session.sessionId, sortId: opaqueRowId(rowKey, orgId, session.sessionId), project: session.project ?? NO_PROJECT, session, status, blocker: blockerOf(session, undefined, status), kind: kindOf(session, undefined, status),
          since: session.updatedAt, sinceKind: "last_update",
        });
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      partial = true;
      log("insights.stuck_source_failed", { source: "sessions", error: error instanceof Error ? error.name : "unknown" });
    }
  } else partial = true;

  try {
    const requests = await readOpenSpend(deps, orgId, nowMs);
    const taskIds = requests.flatMap((record) => (record.taskId === undefined ? [] : [record.taskId]));
    const tasks = taskIds.length === 0 ? new Map<string, Item>() : await batchGetItems(deps, taskIds.map(taskKey));
    for (const record of requests) {
      const task = record.taskId === undefined ? undefined : tasks.get(keyText(taskKey(record.taskId)));
      const sessionId = task?.["orgId"] === orgId ? text(task["sessionId"]) : undefined;
      const known = sessionId === undefined ? undefined : drafts.get(sessionId);
      if (known?.session !== undefined) {
        // The session is already on the list (paused for budget): the request is WHY, so it is one row, and the wait is as old as the older of the two.
        known.spend = record;
        known.blocker = "spend";
        known.kind = kindOf(known.session, record, known.status);
        if (Date.parse(record.createdAt) < Date.parse(known.since)) { known.since = record.createdAt; known.sinceKind = "state"; }
        continue;
      }
      if (sessionId !== undefined && deps.sessions !== undefined) {
        // A request whose session is not on the list: a session that does not need anyone yet, or one outside the reader's scope. Only a session in scope is shown, from its own record.
        const metas = await batchGetItems(deps, [agentSessionKey(orgId, sessionId, "META")]);
        const item = metas.get(keyText(agentSessionKey(orgId, sessionId, "META")));
        const session = item === undefined ? undefined : sessionFromItem(item);
        if (session !== undefined && session.orgId === orgId && session.endedAt === undefined && (viewer.scope.kind === "company" || (session.project !== undefined && inScope(viewer, session.project)))) {
          const status = sessionTaskStatus(session.summary);
          drafts.set(session.sessionId, {
            itemId: session.sessionId, sortId: opaqueRowId(rowKey, orgId, session.sessionId), project: session.project ?? NO_PROJECT, session, spend: record, status, blocker: "spend", kind: kindOf(session, record, status),
            since: Date.parse(record.createdAt) < Date.parse(session.updatedAt) ? record.createdAt : session.updatedAt, sinceKind: "last_update",
          });
        }
        continue;
      }
      // A request that belongs to no session (an agent's budget, a month's budget): always a metadata row; a maintainer sees it only when it names one of their projects.
      const project = record.scope?.kind === "project" ? record.scope.project : undefined;
      if (viewer.scope.kind === "projects" && (project === undefined || !inScope(viewer, project))) continue;
      drafts.set(record.spendRequestId, { itemId: record.spendRequestId, sortId: opaqueRowId(rowKey, orgId, record.spendRequestId), project: project ?? NO_PROJECT, spend: record, status: undefined, blocker: "spend", kind: kindOf(undefined, record, undefined), since: record.createdAt, sinceKind: "state" });
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    partial = true;
    log("insights.stuck_source_failed", { source: "spend_requests", error: error.name });
  }

  const ageOf = (draft: Draft): number => Math.max(0, Math.floor((nowMs - Date.parse(draft.since)) / HOUR_MS));
  const rows = [...drafts.values()]
    .filter((draft) => (query.project === undefined || draft.project === query.project) && (query.minAgeHours === undefined || ageOf(draft) >= query.minAgeHours))
    .sort((a, b) => (Date.parse(a.since) - Date.parse(b.since)) || (a.sortId < b.sortId ? -1 : a.sortId > b.sortId ? 1 : 0));

  const byNextActorKind = Object.fromEntries(KINDS.map((kind) => [kind, 0])) as Record<string, number>;
  const byBlocker = Object.fromEntries(BLOCKERS.map((blocker) => [blocker, 0])) as Record<string, number>;
  for (const row of rows) { byNextActorKind[row.kind]! += 1; byBlocker[row.blocker]! += 1; }
  const summary = { total: rows.length, over24h: rows.filter((row) => ageOf(row) >= 24).length, over72h: rows.filter((row) => ageOf(row) >= 72).length, byNextActorKind, byBlocker };
  const coverage = STUCK_COVERAGE(partial, truncated, deps.sessions !== undefined);
  const asOf = new Date(nowMs).toISOString();
  if (deps.sessions === undefined && rows.length === 0 && partial) return { status: "unavailable", asOf, coverage, summary, items: [] };

  const after = query.cursor === undefined ? undefined : openCursor(query.cursor);
  const rest = after === undefined ? rows : rows.filter((row) => Date.parse(row.since) > Date.parse(after.since) || (Date.parse(row.since) === Date.parse(after.since) && row.sortId > after.sortId));
  const page = rest.slice(0, query.limit);
  const items = await judge(deps, caller, viewer, page, ageOf);
  return { status: "ready", asOf, coverage, summary, items, ...(rest.length > page.length ? { next: cursorOf(page.at(-1)!) } : {}) };
}

/** The page's rows as the reader may see them: names for everyone, content only where the reader could open the session. */
async function judge(deps: InsightsStuckDependencies, caller: InsightsCaller, viewer: InsightsViewer, page: Draft[], ageOf: (draft: Draft) => number): Promise<InsightsStuckItem[]> {
  const orgId = caller.orgId;
  const taskIds = [...new Set(page.flatMap((draft) => (draft.session?.subject.kind === "task" ? [draft.session.subject.taskId] : [])))];
  const tasks = taskIds.length === 0 ? new Map<string, Item>() : await batchGetItems(deps, taskIds.map(taskKey));
  const taskOf = (session: AgentSessionRecord): Item | undefined => {
    const task = session.subject.kind === "task" ? tasks.get(keyText(taskKey(session.subject.taskId))) : undefined;
    return task?.["orgId"] === session.orgId ? task : undefined;
  };
  const ownerOf = (draft: Draft): string | undefined => (draft.session === undefined ? undefined : effectiveOwnerId(draft.session, taskOf(draft.session)));
  const named = new Set<string>();
  for (const draft of page) {
    const owner = ownerOf(draft);
    if (owner !== undefined) named.add(owner);
    for (const id of draft.session?.summary.needsPeople ?? []) named.add(id);
    if (draft.spend !== undefined && draft.spend.approverRole !== "org_admin" && draft.spend.approverRole !== "project_maintainer") for (const id of draft.spend.approverIds) named.add(id);
  }
  const names = await insightsNames(deps, orgId, [...named].filter((id) => /^[a-f0-9]{64}$/u.test(id)));
  const nameOf = (id: string): string => names.get(id) ?? "Unknown";
  const memo = newSessionRoleMemo();
  const items: InsightsStuckItem[] = [];
  for (const draft of page) {
    const { session, spend, status } = draft;
    // May this reader OPEN the session? The Live wall's rules, judged for the reader now. A refusal, or a role that cannot be read, is no access: the row stays, as metadata.
    let opens: { owner: boolean } | undefined;
    if (session !== undefined && deps.sessions !== undefined) {
      try {
        const judged = await sessionAccessFor(deps.sessions, { orgId, developerId: caller.developerId }, viewer.role, session, { memo });
        opens = judged.access === undefined ? undefined : { owner: judged.access.owner };
      } catch (error) {
        if (!isAgentXError(error)) throw error;
      }
    }
    const nextActor = ((): InsightsNextActor => {
      if (spend !== undefined) {
        if (spend.approverRole === "org_admin") return { kind: "role", role: "admin" };
        if (spend.approverRole === "project_maintainer") return { kind: "role", role: "maintainer" };
        if (spend.approverIds.length === 1) return { kind: "person", name: nameOf(spend.approverIds[0]!), role: "approver" };
        if (spend.approverIds.length > 1) return { kind: "group", name: `${String(spend.approverIds.length)} approvers`, role: "approver" };
        return { kind: "role", role: "approver" };
      }
      if (draft.kind === "person" && session !== undefined) {
        const waiting = session.summary.needsPeople;
        if (waiting.length === 1) return { kind: "person", name: nameOf(waiting[0]!) };
        return { kind: "person", name: nameOf(ownerOf(draft)!), role: "owner" };
      }
      if (draft.kind === "group" && session !== undefined) return { kind: "group", name: `${nameOf(session.summary.needsPeople[0]!)} and ${String(session.summary.needsPeople.length - 1)} more` };
      if (draft.kind === "role") return { kind: "role", role: "approver" };
      return { kind: "unknown" };
    })();
    const ownerId = ownerOf(draft);
    const state = status?.state ?? "unknown";
    const readable = opens !== undefined && session !== undefined ? { owner: opens.owner, session } : undefined;
    const full = readable !== undefined;
    const reason = readable === undefined ? undefined : status?.reason;
    items.push({
      // The raw id only on a row the reader can open; a metadata row carries the opaque one.
      itemId: full ? draft.itemId : draft.sortId, project: draft.project, blocker: draft.blocker, state,
      stateWords: status === undefined ? SPEND_ONLY_WORDS : (TASK_STATUS_WORDS as Record<string, string>)[status.state] ?? "Status unavailable",
      nextActor, ...(ownerId === undefined ? {} : { owner: { id: ownerId, name: nameOf(ownerId) } }),
      since: draft.since, sinceKind: draft.sinceKind, ageHours: ageOf(draft), visibility: full ? "full" : "metadata",
      ...(readable === undefined ? {} : {
        title: readable.owner ? readable.session.title : hideEmailAddresses(readable.session.title),
        ...(reason === undefined ? {} : { reason: readable.owner ? reason : hideEmailAddresses(reason) }),
        link: sessionLink(deps.sessions!.origin, readable.session.sessionId),
      }),
    });
  }
  return items;
}
