// The sweep and the retention drain (Plan 5 Task 7a). The sweep walks the global list of open sessions with a saved cursor, a page at a time, and refreshes
// each under its own org, so a session the stream missed (a batch dropped at the publisher's deadline, a task that ended while the projector was down, a
// session created lazily for an old task) is corrected within a few runs. The drain gives an ended session's items their retention expiry, day by day from
// a saved day, so a schedule that was down for any length of time loses nothing.
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  INDEX_EXPIRY_ATTRIBUTE,
  SESSION_RETENTION_DAYS,
  SESSION_SWEEP_BUDGET_MS,
  SESSION_SWEEP_CURSOR_KEY,
  SESSION_SWEEP_PAGE,
  agentSessionKey,
  mySessionsKey,
  projectSessionsKey,
  sessionSurfaceKey,
  sharedSessionsKey,
  type AgentPrincipal,
  type AgentSessionRecord,
  type OrgId,
  type SessionBinding,
  type SessionId,
} from "@agentx/contracts";
import { AgentSessionStore } from "./store.js";
import { ENDED_DRAIN_CURSOR_KEY, refreshSessionSummary, type SummaryDependencies } from "./summary.js";

export { ENDED_DRAIN_CURSOR_KEY };

type Item = Record<string, unknown>;
export const DRAIN_BUDGET_MS = 8_000;
const DRAIN_PAGE = 100;
const SECONDS_PER_DAY = 86_400;
const OPEN_LIST = "OPEN_AGENT_SESSIONS";

export interface SweepDependencies extends SummaryDependencies {
  /** What refreshes one session; `refreshSessionSummary` unless a test stands in. */
  refresh?: ((deps: SummaryDependencies, orgId: OrgId, sessionId: SessionId) => Promise<"unchanged" | "updated">) | undefined;
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const warn = (deps: Pick<SummaryDependencies, "log">, entry: Record<string, unknown>) => (deps.log ?? ((line) => console.log(JSON.stringify({ component: "broker", ...line }))))(entry);
const conditionFailed = (error: unknown) => error instanceof Error && error.name === "ConditionalCheckFailedException";

async function get(deps: SummaryDependencies, key: { pk: string; sk: string }): Promise<Item | undefined> {
  return ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Item }).Item;
}

/** Deletes the session's presence items whose time has passed (the table's own TTL is the backstop). */
async function clearPresence(deps: SummaryDependencies, orgId: OrgId, sessionId: SessionId): Promise<void> {
  const nowSeconds = Math.floor(deps.now() / 1000);
  const page = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ConsistentRead: true,
    ExpressionAttributeValues: { ":pk": agentSessionKey(orgId, sessionId, "META").pk, ":prefix": "PRESENCE#" },
  })) as { Items?: Item[] };
  for (const item of page.Items ?? []) {
    const expires = item["indexExpiresAt"];
    if (item["orgId"] !== orgId || typeof expires !== "number" || expires > nowSeconds) continue;
    await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: { pk: item["pk"] as string, sk: item["sk"] as string } }));
  }
}

export interface SweepResult { refreshed: number; unchanged: number; failed: number; skipped: number }

/**
 * Refreshes the open sessions from the saved cursor, `SESSION_SWEEP_PAGE` a page, wrapping to the start at the end, until the budget is spent. The cursor
 * is saved after each page and when the budget stops it. A list entry whose own record names another org than its key is skipped and logged.
 */
export async function sweepAgentSessions(deps: SweepDependencies, now: number, options: { budgetMs?: number } = {}): Promise<SweepResult> {
  const result: SweepResult = { refreshed: 0, unchanged: 0, failed: 0, skipped: 0 };
  const budget = options.budgetMs ?? SESSION_SWEEP_BUDGET_MS;
  const refresh = deps.refresh ?? refreshSessionSummary;
  const saved = text((await get(deps, SESSION_SWEEP_CURSOR_KEY))?.["after"]);
  const startedAfter = saved;
  let after = saved;
  let wrapped = false;
  let last: string | undefined;
  const save = async () => {
    if (last === undefined) return;
    await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: { ...SESSION_SWEEP_CURSOR_KEY, entityType: "SESSION_SWEEP_CURSOR", after: last, at: new Date(deps.now()).toISOString() } }));
  };
  for (;;) {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": OPEN_LIST }, ConsistentRead: true, Limit: SESSION_SWEEP_PAGE,
      ...(after === undefined ? {} : { ExclusiveStartKey: { pk: OPEN_LIST, sk: after } }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    const items = page.Items ?? [];
    if (items.length === 0) {
      // The end of the list: go back to the start once, and stop if that is where this run began.
      if (wrapped || after === undefined) break;
      wrapped = true;
      after = undefined;
      if (startedAfter === undefined) break;
      continue;
    }
    for (const item of items) {
      const sk = text(item["sk"]);
      if (sk === undefined) continue;
      // Back where this run began: every session has had its turn.
      if (wrapped && startedAfter !== undefined && sk > startedAfter) { await save(); return result; }
      if (deps.now() - now >= budget) { result.skipped += 1; await save(); return result; }
      const orgId = text(item["orgId"]);
      const sessionId = text(item["sessionId"]);
      if (orgId === undefined || sessionId === undefined || sk !== `${orgId}#${sessionId}`) {
        warn(deps, { event: "agent_session.sweep_org_mismatch", key: sk.slice(0, 80) });
        last = sk;
        continue;
      }
      try {
        const outcome = await refresh(deps, orgId, sessionId);
        if (outcome === "updated") result.refreshed += 1;
        else result.unchanged += 1;
        await clearPresence(deps, orgId, sessionId);
      } catch (error) {
        result.failed += 1;
        warn(deps, { event: "agent_session.sweep_refresh_failed", sessionId, error: error instanceof Error ? error.name : "unknown" });
      }
      last = sk;
    }
    after = last;
    await save();
    if (page.LastEvaluatedKey === undefined && items.length < SESSION_SWEEP_PAGE) {
      // That was the end of the list.
      if (wrapped || startedAfter === undefined) break;
      wrapped = true;
      after = undefined;
    }
  }
  await save();
  return result;
}

// ---- retention

/** The partition prefixes whose items expire with the session, in the order the drain walks them. */
const PREFIXES = ["BINDING#", "FOLLOWER#", "LEG#", "MESSAGE#", "SHARE#", "TURN#"] as const;

interface Cursor { prefix: number; after?: string }

/** Sets the expiry on an item that exists (never creates one). */
async function stamp(deps: SummaryDependencies, key: { pk: string; sk: string }, expires: number): Promise<void> {
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: key, UpdateExpression: "SET #expires = :expires", ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeNames: { "#expires": INDEX_EXPIRY_ATTRIBUTE }, ExpressionAttributeValues: { ":expires": expires },
    }));
  } catch (error) {
    if (!conditionFailed(error)) throw error;
  }
}

async function queryPartition(deps: SummaryDependencies, pk: string, prefix: string, after: string | undefined, limit: number | undefined): Promise<Item[]> {
  const page = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ConsistentRead: true,
    ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix }, ...(limit === undefined ? {} : { Limit: limit }), ...(after === undefined ? {} : { ExclusiveStartKey: { pk, sk: after } }),
  })) as { Items?: Item[] };
  return page.Items ?? [];
}

/** The list entries and surface keys of one session (small sets, so one pass). */
async function stampIndexItems(deps: SummaryDependencies, session: AgentSessionRecord, expires: number): Promise<void> {
  const { orgId, sessionId } = session;
  const pk = agentSessionKey(orgId, sessionId, "META").pk;
  const people = new Set<string>([session.owner.developerId]);
  if (session.startedBy.kind === "member") people.add(session.startedBy.developerId);
  for (const developerId of people) await stamp(deps, mySessionsKey(orgId, developerId, session.createdAt, sessionId), expires);
  if (session.project !== undefined) await stamp(deps, projectSessionsKey(orgId, session.project, session.createdAt, sessionId), expires);
  for (const share of await queryPartition(deps, pk, "SHARE#", undefined, undefined)) {
    if (share["orgId"] === orgId && share["principal"] !== undefined) await stamp(deps, sharedSessionsKey(orgId, share["principal"] as AgentPrincipal, sessionId), expires);
  }
  for (const binding of await queryPartition(deps, pk, "BINDING#", undefined, undefined)) {
    if (binding["orgId"] === orgId && binding["binding"] !== undefined) await stamp(deps, sessionSurfaceKey(orgId, binding["binding"] as SessionBinding), expires);
  }
}

/** One session's drain from its saved place. True when it finished. */
async function drainSession(deps: SummaryDependencies, work: Item, deadline: number): Promise<boolean> {
  const orgId = text(work["orgId"]);
  const sessionId = text(work["sessionId"]);
  const key = { pk: work["pk"] as string, sk: work["sk"] as string };
  if (orgId === undefined || sessionId === undefined || key.sk !== `${orgId}#${sessionId}`) {
    warn(deps, { event: "agent_session.drain_org_mismatch", key: key.sk.slice(0, 80) });
    return true; // nothing to do for it, and it must not hold the day up
  }
  const session = await new AgentSessionStore(deps).get(orgId, sessionId);
  if (session?.endedAt === undefined) {
    await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: key }));
    return true;
  }
  const expires = Math.floor(Date.parse(session.endedAt) / 1000) + SESSION_RETENTION_DAYS * SECONDS_PER_DAY;
  const pk = agentSessionKey(session.orgId, session.sessionId, "META").pk;
  let cursor = (work["cursor"] as Cursor | undefined) ?? { prefix: 0 };
  while (cursor.prefix < PREFIXES.length) {
    const prefix = PREFIXES[cursor.prefix]!;
    const items = await queryPartition(deps, pk, prefix, cursor.after, DRAIN_PAGE);
    for (const item of items) {
      if (item["orgId"] === session.orgId && item[INDEX_EXPIRY_ATTRIBUTE] !== expires) await stamp(deps, { pk, sk: item["sk"] as string }, expires);
    }
    cursor = items.length < DRAIN_PAGE ? { prefix: cursor.prefix + 1 } : { prefix: cursor.prefix, after: items.at(-1)!["sk"] as string };
    try {
      await deps.documentClient.send(new UpdateCommand({
        TableName: deps.tableName, Key: key, UpdateExpression: "SET #cursor = :cursor", ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeNames: { "#cursor": "cursor" }, ExpressionAttributeValues: { ":cursor": cursor },
      }));
    } catch (error) {
      if (!conditionFailed(error)) throw error;
    }
    if (cursor.prefix < PREFIXES.length && deps.now() >= deadline) return false;
  }
  await stampIndexItems(deps, session, expires);
  await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: key }));
  return true;
}

const dayAfter = (day: string) => new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);

/**
 * Gives the items of the sessions that ended on each UTC day, from the saved day on, an expiry a year after their end. It stops at its own deadline
 * (`DRAIN_BUDGET_MS`) and resumes from the saved day and the session's own place; a finished session's work item is deleted. The saved day never passes
 * yesterday, so a late stream record that lists yesterday's end is still seen.
 */
export async function drainEndedSessions(deps: SummaryDependencies, now: number): Promise<{ drained: number; pending: boolean }> {
  const deadline = now + DRAIN_BUDGET_MS;
  const cursor = await get(deps, ENDED_DRAIN_CURSOR_KEY);
  let day = text(cursor?.["day"]);
  if (day === undefined) return { drained: 0, pending: false };
  const today = new Date(now).toISOString().slice(0, 10);
  const settled = new Date(now - 86_400_000).toISOString().slice(0, 10);
  let drained = 0;
  while (day <= today) {
    const pk = `ENDED_AGENT_SESSIONS#${day}`;
    let after: string | undefined;
    for (;;) {
      const page = await deps.documentClient.send(new QueryCommand({
        TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": pk }, ConsistentRead: true, Limit: 25,
        ...(after === undefined ? {} : { ExclusiveStartKey: { pk, sk: after } }),
      })) as { Items?: Item[] };
      const items = page.Items ?? [];
      if (items.length === 0) break;
      for (const work of items) {
        if (deps.now() >= deadline) return { drained, pending: true };
        try {
          // A session with more to do stays (with its place saved) for the next run; the others are finished and their work item is gone.
          if (!await drainSession(deps, work, deadline)) return { drained, pending: true };
          drained += 1;
        } catch (error) {
          warn(deps, { event: "agent_session.drain_failed", error: error instanceof Error ? error.name : "unknown" });
          return { drained, pending: true };
        }
        after = work["sk"] as string;
      }
    }
    if (day >= settled) break;
    day = dayAfter(day);
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: ENDED_DRAIN_CURSOR_KEY, UpdateExpression: "SET #day = :day", ExpressionAttributeNames: { "#day": "day" }, ExpressionAttributeValues: { ":day": day },
    }));
  }
  return { drained, pending: false };
}
