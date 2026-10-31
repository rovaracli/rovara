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
  sessionBindingKey,
  sessionSurfaceKey,
  sharedSessionsKey,
  type AgentPrincipal,
  type AgentSessionRecord,
  type OrgId,
  type SessionBinding,
  type SessionId,
} from "@agentx/contracts";
import { closeQueuedSteers } from "./steer.js";
import { AgentSessionStore } from "./store.js";
import { ENDED_DRAIN_CURSOR_KEY, refreshSessionSummary, type SummaryDependencies } from "./summary.js";

export { ENDED_DRAIN_CURSOR_KEY };

type Item = Record<string, unknown>;
export const DRAIN_BUDGET_MS = 8_000;
/** How long an ended session's work item waits for a started move to the cloud to be linked or cancelled. */
const HANDOFF_WAIT_MAX_MS = 24 * 3_600_000;
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
        // A move to the cloud that started a task and never linked it (Task 19) is cancelled here once it is old enough.
        if (deps.recoverHandoffs !== undefined) {
          const open = await new AgentSessionStore(deps).get(orgId, sessionId);
          if (open !== undefined) await deps.recoverHandoffs(open);
        }
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
const PREFIXES = ["FOLLOWER#", "LEG#", "MESSAGE#", "SHARE#", "TURN#"] as const;

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
  // The bindings sit in a partition of their own (`sessionBindingKey`): each one and the surface item it names expire with the session.
  for (const kind of ["slack_thread", "linear_issue", "tracker_item"] as const) {
    const key = sessionBindingKey(orgId, sessionId, kind);
    for (const binding of await queryPartition(deps, key.pk, key.sk, undefined, undefined)) {
      if (binding["orgId"] !== orgId || binding["binding"] === undefined) continue;
      await stamp(deps, key, expires);
      await stamp(deps, sessionSurfaceKey(orgId, binding["binding"] as SessionBinding), expires);
    }
  }
}

/** One session's drain from its saved place: `done` when it finished, `more` when it has more to do, `waiting` when only a started move to the cloud (Task 19) is left, which the work item must outlive. */
async function drainSession(deps: SummaryDependencies, work: Item, deadline: number): Promise<"done" | "more" | "waiting"> {
  const orgId = text(work["orgId"]);
  const sessionId = text(work["sessionId"]);
  const key = { pk: work["pk"] as string, sk: work["sk"] as string };
  if (orgId === undefined || sessionId === undefined || key.sk !== `${orgId}#${sessionId}`) {
    warn(deps, { event: "agent_session.drain_org_mismatch", key: key.sk.slice(0, 80) });
    // Nothing to do for it, and it must not be read again: it names an org its key does not.
    await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: key }));
    return "done";
  }
  const session = await new AgentSessionStore(deps).get(orgId, sessionId);
  if (session?.endedAt === undefined) {
    await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: key }));
    return "done";
  }
  // A message to the agent no step took can never be delivered now: it is closed (the end's own refresh does this; this is the backstop, and a failure here is tried again like any drain failure).
  await closeQueuedSteers(deps, session);
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
    if (cursor.prefix < PREFIXES.length && deps.now() >= deadline) return "more";
  }
  await stampIndexItems(deps, session, expires);
  // A Mac that ended its own session after a move to the cloud was cut off leaves a started task behind (Task 19). Once the session has left the open list nothing else visits it, so the work item
  // stays until every attempt is linked or cancelled (an attempt younger than its window is cancelled by a later run), for at most a day.
  if (deps.recoverHandoffs !== undefined && await deps.recoverHandoffs(session) === "pending" && deps.now() - Date.parse(session.endedAt) < HANDOFF_WAIT_MAX_MS) return "waiting";
  await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: key }));
  return "done";
}

const dayAfter = (day: string) => new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);

/** How many times a work item may fail before the drain gives up on it (it is parked with an expiry and no longer read). */
export const DRAIN_ITEM_TRIES = 5;
const PARKED_KEEP_DAYS = 30;

/** Counts a failure on the work item; the one that uses up its tries parks it (true). Never throws: the item is only a tally. A tally that could not be written is not a parking. */
async function recordDrainFailure(deps: SummaryDependencies, work: Item): Promise<boolean> {
  try {
    const failures = (typeof work["failures"] === "number" ? work["failures"] : 0) + 1;
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: { pk: work["pk"] as string, sk: work["sk"] as string }, ConditionExpression: "attribute_exists(pk)",
      UpdateExpression: failures >= DRAIN_ITEM_TRIES ? "SET failures = :failures, #expires = :expires" : "SET failures = :failures",
      ...(failures >= DRAIN_ITEM_TRIES ? { ExpressionAttributeNames: { "#expires": INDEX_EXPIRY_ATTRIBUTE } } : {}),
      ExpressionAttributeValues: { ":failures": failures, ...(failures >= DRAIN_ITEM_TRIES ? { ":expires": Math.floor(deps.now() / 1000) + PARKED_KEEP_DAYS * SECONDS_PER_DAY } : {}) },
    }));
    return failures >= DRAIN_ITEM_TRIES;
  } catch (error) {
    // The item is gone (another run finished it): nothing is left to retry. Any other fault leaves the item as it was, to be tried again.
    if (conditionFailed(error)) return true;
    warn(deps, { event: "agent_session.drain_failure_not_recorded", error: error instanceof Error ? error.name : "unknown" });
    return false;
  }
}

/**
 * Gives the items of the sessions that ended on each UTC day, from the saved day on, an expiry a year after their end. It stops at its own deadline
 * (`DRAIN_BUDGET_MS`, or the caller's smaller `budgetMs`) and resumes from the saved day and the session's own place; a finished session's work item is deleted.
 * The work item is filed under the day of the refresh that found the end and the saved day never passes yesterday, so a late end is always seen. With no saved day
 * it starts two days back. One item that fails is logged, counted and skipped (parked after `DRAIN_ITEM_TRIES`); the items behind it are still drained. The saved
 * day never passes a day that still has an item being retried, so an item that fails on an older day is read again on every run until it is parked (and so gets its
 * expiry); the days after it are drained in the same run.
 */
export async function drainEndedSessions(deps: SummaryDependencies, now: number, options: { budgetMs?: number } = {}): Promise<{ drained: number; pending: boolean }> {
  const deadline = now + Math.min(DRAIN_BUDGET_MS, options.budgetMs ?? DRAIN_BUDGET_MS);
  const cursor = await get(deps, ENDED_DRAIN_CURSOR_KEY);
  const today = new Date(now).toISOString().slice(0, 10);
  const settled = new Date(now - 86_400_000).toISOString().slice(0, 10);
  let day = text(cursor?.["day"]) ?? new Date(now - 2 * 86_400_000).toISOString().slice(0, 10);
  let drained = 0;
  let failed = false;
  // Whether an item that failed is not parked yet: while one is, the saved day stays at the earliest day with such an item.
  let retrying = false;
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
        after = work["sk"] as string;
        // Given up on: parked with its own expiry, and not read again.
        if (typeof work["failures"] === "number" && work["failures"] >= DRAIN_ITEM_TRIES) continue;
        try {
          // A session with more to do stays (with its place saved) for the next run; the others are finished and their work item is gone.
          const outcome = await drainSession(deps, work, deadline);
          if (outcome === "more") return { drained, pending: true };
          if (outcome === "waiting") {
            // Kept for a later run: the saved day stays here until it is done, and the others are still drained.
            retrying = true;
            failed = true;
          } else {
            drained += 1;
          }
        } catch (error) {
          warn(deps, { event: "agent_session.drain_failed", error: error instanceof Error ? error.name : "unknown" });
          if (!await recordDrainFailure(deps, work)) retrying = true;
          failed = true;
        }
      }
    }
    // Today's day is read too (an end filed today is drained at once), but the saved day never passes yesterday: a late end is filed under the day of its refresh.
    day = dayAfter(day);
    if (day <= settled && !retrying) await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: { ...ENDED_DRAIN_CURSOR_KEY, entityType: "ENDED_DRAIN_CURSOR", day } }));
  }
  return { drained, pending: failed };
}
