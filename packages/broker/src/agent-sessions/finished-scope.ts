// The Finished list for the Team and Company scopes: `GET /v1/app/sessions?scope=team|company&status=ended`. It lists only sessions the caller can already open, read from the indexes that
// already exist (each project's `PROJECT_SESSIONS` partition and, for the company scope, the caller's own `MY_SESSIONS` one): nothing new is stored and nothing becomes visible that was not.
//   team     the ended sessions of the projects the caller is on, by the Live wall's `team` rule (a task or chain on a project they hold a role on; a Mac session only when it is not theirs and
//            was shared with them)
//   company  every ended session the caller may open: the team ones, an owner's or admin's reach into every project, and the caller's own
// Every row is read again with the caller's live org role and judged by the one access rule (`sessionAccessFor`, as `listSessions` and the Live wall do), so a session the caller cannot open is
// never in the answer, whatever its index row says; the org is the caller's own (checked member), never the request's. The partitions are merged newest first under one sealed cursor bound to
// the org, the person and the scope. A project the caller reaches only through a Slack channel is listed too (`projectsOf` knows channels); a session shared with them alone is in "Shared with me".
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { OrgRoleSchema, orgMemberKey, type SessionList, type SessionTile } from "@agentx/cloud-contracts";
import { LIVE_INDEX_SCAN_MAX, LIVE_PAGE_MAX, SessionIdSchema, agentXError, mySessionsKey, projectSessionsKey } from "@rovara-code/contracts";
import type { Item } from "../agents/table-writes.js";
import { newSessionRoleMemo, requireLevelOf, sessionAccessFor } from "./access.js";
import { ownerNameOverlay, ownerNamedAt } from "./owner-names.js";
import { cursorKeyOf, openCursor, sealCursor, tileOf, type SessionListQuery, type SessionReadCaller, type SessionReadDependencies } from "./read.js";
import { AgentSessionStore } from "./store.js";

export const FINISHED_SCOPES = ["team", "company"] as const;
type Scope = (typeof FINISHED_SCOPES)[number];

/** The most project partitions one request reads; a person on more says so in the log, and the rest are left to their project's own list. */
export const FINISHED_PROJECTS_MAX = 100;
const LANE_PAGE = 50;
const LANES_AT_ONCE = 8;
const DEFAULT_PAGE = 50;
const PROBE_ID = "ses_00000000000000000000";
const PROBE_AT = "2000-01-01T00:00:00.000Z";

const invalid = (message: string) => agentXError("CONFIG_INVALID", message);
const isAgentXError = (error: unknown): boolean => error instanceof Error && error.name === "AgentXError";

interface Lane { pk: string; rows: Item[]; next: Record<string, unknown> | undefined; started: boolean }

/**
 * One page of the caller's finished sessions in `scope`, newest first. The query must say `status=ended` and no other list selector (`owner`, `project`, `shared`).
 */
export async function listFinishedScope(deps: SessionReadDependencies, caller: SessionReadCaller, query: SessionListQuery): Promise<SessionList> {
  const { scope } = query;
  if (scope !== "team" && scope !== "company") throw invalid("scope: must be team or company");
  if (query.owner !== undefined || query.project !== undefined || query.shared !== undefined) throw invalid("Choose one of owner, project, shared or scope.");
  if (query.status !== "ended") throw invalid("scope: lists finished sessions only; add status=ended");
  const limit = query.limit ?? DEFAULT_PAGE;
  if (!Number.isInteger(limit) || limit < 1 || limit > LIVE_PAGE_MAX) throw invalid(`limit: must be a whole number from 1 to ${String(LIVE_PAGE_MAX)}`);
  return readFinished(deps, caller, scope, limit, query.cursor);
}

async function readFinished(deps: SessionReadDependencies, caller: SessionReadCaller, scope: Scope, limit: number, cursor: string | undefined): Promise<SessionList> {
  const { orgId } = caller;
  cursorKeyOf(deps); // a list that can't seal its cursor doesn't start
  const label = `${orgId}#FINISHED#${scope}`;
  const after = cursor === undefined ? undefined : openCursor(deps, caller, label, cursor);

  // The caller's role is read now, from their member record: never the token's.
  const member = ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: orgMemberKey(orgId, caller.developerId), ConsistentRead: true }))) as { Item?: Item }).Item;
  const orgRole = OrgRoleSchema.safeParse(member?.["role"]);
  if (!orgRole.success) return { sessions: [] };
  const asker: SessionReadCaller = { ...caller, orgRole: orgRole.data };

  // The partitions: each project the caller reaches (all of them for an owner or admin), and for the company scope their own sessions too.
  const projectsOf = deps.projectMembers.projectsOf?.(orgId, { developerId: caller.developerId, orgRole: orgRole.data });
  if (projectsOf === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "Finished work can't be listed right now.");
  const reached = (await projectsOf).map((entry) => entry.project);
  const projects = [...new Set(reached)].sort();
  if (projects.length > FINISHED_PROJECTS_MAX) (deps.log ?? ((line: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", ...line }))))({ event: "agent_session.finished_projects_truncated", orgId });
  const pks = [
    ...projects.slice(0, FINISHED_PROJECTS_MAX).map((project) => projectSessionsKey(orgId, project, PROBE_AT, PROBE_ID).pk),
    ...(scope === "company" ? [mySessionsKey(orgId, caller.developerId, PROBE_AT, PROBE_ID).pk] : []),
  ];

  const fill = async (lane: Lane): Promise<void> => {
    const start = lane.started ? lane.next : after === undefined ? undefined : { pk: lane.pk, sk: after };
    lane.started = true;
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": lane.pk }, ConsistentRead: true, ScanIndexForward: false, Limit: LANE_PAGE,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    lane.rows = page.Items ?? [];
    lane.next = page.LastEvaluatedKey;
  };
  const lanes: Lane[] = pks.map((pk) => ({ pk, rows: [], next: undefined, started: false }));
  for (let from = 0; from < lanes.length; from += LANES_AT_ONCE) await Promise.all(lanes.slice(from, from + LANES_AT_ONCE).map(fill));
  const sk = (row: Item): string => (typeof row["sk"] === "string" ? row["sk"] : "");

  const store = new AgentSessionStore(deps);
  const memo = newSessionRoleMemo(); // the caller's role on each project, asked once for the whole request
  const seen = new Set<string>();
  const found: SessionTile[] = [];
  let lastSk: string | undefined;
  let scanned = 0;
  for (;;) {
    // The newest row at the head of any partition; a partition that ran dry is read on.
    let best: Lane | undefined;
    for (const lane of lanes) {
      while (lane.rows.length === 0 && lane.next !== undefined) await fill(lane);
      if (lane.rows.length > 0 && (best === undefined || sk(lane.rows[0]!) > sk(best.rows[0]!))) best = lane;
    }
    if (best === undefined) break;
    if (found.length >= limit || scanned >= LIVE_INDEX_SCAN_MAX) return finish(deps, asker, found, lastSk === undefined ? undefined : sealCursor(deps, caller, label, lastSk));
    const row = best.rows.shift()!;
    scanned += 1;
    lastSk = sk(row);
    const id = SessionIdSchema.safeParse(row["sessionId"]);
    if (!id.success || row["orgId"] !== orgId || seen.has(id.data)) continue;
    seen.add(id.data);
    const session = await store.get(orgId, id.data);
    if (session === undefined || session.endedAt === undefined) continue;
    try {
      const { access, shareRole } = await sessionAccessFor(deps, asker, orgRole.data, session, { memo, wantShareRole: true });
      if (access === undefined || access.level === "none") continue;
      requireLevelOf(access, "view", "view it");
      // The Live wall's `team` rule: a project's session when the caller has a role there; a Mac session only when it is not theirs.
      if (scope === "team" && !(session.kind === "local" ? !access.owner : shareRole !== undefined)) continue;
      found.push(tileOf(session, access.level, access.effectiveOwner, access.owner));
    } catch (error) {
      // A role that can't be read is no access, never a reason to show the session.
      if (isAgentXError(error)) continue;
      throw error;
    }
  }
  return finish(deps, asker, found, undefined);
}

async function finish(deps: SessionReadDependencies, caller: SessionReadCaller, found: SessionTile[], next: string | undefined): Promise<SessionList> {
  // The owners' chosen names, one BatchGetItem for the page (as `listSessions` does).
  const overlay = await ownerNameOverlay(deps, found.map((tile) => tile.owner.developerId), caller.orgId);
  const sessions = found.map((tile) => ({ ...tile, owner: ownerNamedAt(tile.owner, overlay, tile.createdAt) }));
  return { sessions, ...(next === undefined ? {} : { next }) };
}
