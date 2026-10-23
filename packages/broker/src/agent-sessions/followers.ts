// Following a session and seeing who is looking at it now (Plan 5 Task 9).
//
// A follow is a `FOLLOWER#<developerId>` item on the session's partition and a `followerCount` change on its META, written in one transaction, so the count never drifts
// from the items by a crash between two writes. Following is idempotent (a second follow writes nothing), at most `SESSION_FOLLOWERS_MAX`, and needs `view`. The session's
// effective owner follows without an item: they hear of everything already (Task 8's sink always tells them), so a follow would only double the count.
//
// A heartbeat (`PRESENCE_HEARTBEAT_SECONDS`) puts `PRESENCE#<developerId>`, trusted for `PRESENCE_TTL_SECONDS` and checked on read (the table's TTL deletion lags). The session's
// own channel is told `session.updated` only when the person was not there already, so a steady heartbeat is silent. Presence never goes to anyone's changes feed: it is
// not a thing to catch up on.
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  INDEX_EXPIRY_ATTRIBUTE,
  PRESENCE_TTL_SECONDS,
  PRESENCE_VIEWERS_MAX,
  SESSION_FOLLOWERS_MAX,
  SESSION_RETENTION_DAYS,
  SessionOwnerSchema,
  agentSessionKey,
  agentXError,
  cleanSessionName,
  sessionChannel,
  type AgentSessionRecord,
  type OrgId,
  type SessionOwner,
} from "@agentx/contracts";
import { errorName, failedIndexes, type Item, type TransactItem } from "../agents/table-writes.js";
import { publishNotices, type RealtimeConfig } from "../realtime/publish.js";
import { requireSessionLevel, type SessionAccessDependencies, type SessionCaller } from "./access.js";
import { AgentSessionStore } from "./store.js";

export interface SessionFollowerDependencies extends SessionAccessDependencies {
  /** The events API a presence notice is posted to; without it nothing is posted. */
  realtimePublish?: RealtimeConfig | undefined;
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

const FOLLOWER_PREFIX = "FOLLOWER#";
const PRESENCE_PREFIX = "PRESENCE#";
const DAY_SECONDS = 86_400;
/** The most presence items one read looks at: a session open on many screens at once is still read in a bounded number of pages. */
const PRESENCE_SCAN_MAX = 500;
const TOO_MANY_FOLLOWERS = "This session has the most followers it can have.";

const getItem = async (deps: Pick<SessionAccessDependencies, "documentClient" | "tableName">, key: { pk: string; sk: string }): Promise<Item | undefined> =>
  ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Item }).Item;

const followerKey = (session: { orgId: OrgId; sessionId: string }, developerId: string) =>
  agentSessionKey(session.orgId, session.sessionId, `${FOLLOWER_PREFIX}${developerId}`);

// ---- following

/** What an item written for an ended session expires with: its own record, a year after it ended. Undefined for an open session. */
const endedExpiry = (session: AgentSessionRecord): number | undefined =>
  session.endedAt === undefined ? undefined : Math.floor(Date.parse(session.endedAt) / 1000) + SESSION_RETENTION_DAYS * DAY_SECONDS;

/**
 * `POST /v1/app/sessions/{id}/follow` [view]. Writes the follower item and counts it in one transaction. The caller follows already (an item, or they are the effective owner):
 * nothing is written. At `SESSION_FOLLOWERS_MAX` it is `CONFIG_INVALID`. The request is naturally repeatable (its outcome is the state it leaves), so it carries no request id.
 */
export async function followSession(deps: SessionFollowerDependencies, caller: SessionCaller, sessionId: string): Promise<{ following: boolean }> {
  const { session, owner } = await requireSessionLevel(deps, caller, sessionId, "view", "follow it");
  if (owner) return { following: true };
  const key = followerKey(session, caller.developerId);
  if (await getItem(deps, key) !== undefined) return { following: true };
  const expiry = endedExpiry(session);
  const items: TransactItem[] = [
    {
      Put: {
        TableName: deps.tableName,
        Item: { ...key, entityType: "AGENT_SESSION_FOLLOWER", orgId: session.orgId, sessionId: session.sessionId, developerId: caller.developerId, ...(expiry === undefined ? {} : { [INDEX_EXPIRY_ATTRIBUTE]: expiry }) },
        ConditionExpression: "attribute_not_exists(pk)",
      },
    },
    {
      Update: {
        TableName: deps.tableName, Key: agentSessionKey(session.orgId, session.sessionId, "META"), UpdateExpression: "ADD #followers :one",
        ConditionExpression: "attribute_exists(pk) AND #followers < :max", ExpressionAttributeNames: { "#followers": "followerCount" },
        ExpressionAttributeValues: { ":one": 1, ":max": SESSION_FOLLOWERS_MAX },
      },
    },
  ];
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (error) {
    const failed = failedIndexes(error);
    if (failed === undefined) throw error;
    // Read it again before deciding: a lost race with the same person's other request means they follow, which is what was asked.
    if (await getItem(deps, key) !== undefined) return { following: true };
    if (failed.has(1)) {
      if (await new AgentSessionStore(deps).get(session.orgId, session.sessionId) === undefined) throw agentXError("NOT_FOUND", "session not found");
      throw agentXError("CONFIG_INVALID", TOO_MANY_FOLLOWERS);
    }
    throw error;
  }
  return { following: true };
}

/**
 * `DELETE /v1/app/sessions/{id}/follow` [view]. The follow goes and the count drops. Not following writes nothing. The effective owner always follows: the answer says so.
 */
export async function unfollowSession(deps: SessionFollowerDependencies, caller: SessionCaller, sessionId: string): Promise<{ following: boolean }> {
  const { session, owner } = await requireSessionLevel(deps, caller, sessionId, "view", "unfollow it");
  if (owner) return { following: true };
  await removeFollower(deps, session, caller.developerId);
  return { following: false };
}

/**
 * Removes one person's follow and takes it off the session's count, in one transaction; true when it removed one. A count that has drifted to zero (or a session record that is
 * gone) never keeps the follow: the item is then deleted alone, and the count is never taken below zero. Used by the unfollow route, the notice sink (a follower who lost access) and
 * the share removal.
 */
export async function removeFollower(deps: Pick<SessionAccessDependencies, "documentClient" | "tableName">, session: { orgId: OrgId; sessionId: string }, developerId: string): Promise<boolean> {
  const key = followerKey(session, developerId);
  if (await getItem(deps, key) === undefined) return false;
  try {
    await deps.documentClient.send(new TransactWriteCommand({
      TransactItems: [
        { Delete: { TableName: deps.tableName, Key: key, ConditionExpression: "attribute_exists(pk)" } },
        {
          Update: {
            TableName: deps.tableName, Key: agentSessionKey(session.orgId, session.sessionId, "META"), UpdateExpression: "ADD #followers :minusOne",
            ConditionExpression: "attribute_exists(pk) AND #followers > :zero", ExpressionAttributeNames: { "#followers": "followerCount" },
            ExpressionAttributeValues: { ":minusOne": -1, ":zero": 0 },
          },
        },
      ],
    }));
    return true;
  } catch (error) {
    if (failedIndexes(error) === undefined) throw error;
  }
  try {
    await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: key, ConditionExpression: "attribute_exists(pk)" }));
    return true;
  } catch (error) {
    if (errorName(error) === "ConditionalCheckFailedException") return false;
    throw error;
  }
}

// ---- presence

const fresh = (at: unknown, nowMs: number): boolean => {
  const when = typeof at === "string" ? Date.parse(at) : Number.NaN;
  return Number.isFinite(when) && nowMs - when < PRESENCE_TTL_SECONDS * 1000;
};

/**
 * The people looking at the session now: the presence items whose heartbeat is newer than `PRESENCE_TTL_SECONDS` (the time is checked here, since the table deletes late),
 * at most `PRESENCE_VIEWERS_MAX`, in name order. An item whose person or name doesn't read is left out.
 */
export async function viewingNow(deps: Pick<SessionAccessDependencies, "documentClient" | "tableName">, session: { orgId: OrgId; sessionId: string }, nowMs: number): Promise<SessionOwner[]> {
  const here: SessionOwner[] = [];
  let scanned = 0;
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ConsistentRead: true,
      ExpressionAttributeValues: { ":pk": agentSessionKey(session.orgId, session.sessionId, "META").pk, ":prefix": PRESENCE_PREFIX },
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      scanned += 1;
      if (!fresh(item["at"], nowMs)) continue;
      const person = SessionOwnerSchema.safeParse({ developerId: item["developerId"], name: item["name"] });
      if (person.success) here.push(person.data);
    }
    start = page.LastEvaluatedKey;
  } while (start !== undefined && scanned < PRESENCE_SCAN_MAX);
  here.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.developerId < b.developerId ? -1 : a.developerId > b.developerId ? 1 : 0));
  return here.slice(0, PRESENCE_VIEWERS_MAX);
}

/**
 * `POST /v1/app/sessions/{id}/presence` [view]: the caller's heartbeat. Puts their presence item (expiring `PRESENCE_TTL_SECONDS` on), and, when they were not already there
 * (no item, or one past its time that the table has not deleted yet), tells the session's channel `session.updated`. Answers who is looking now, this heartbeat included.
 */
export async function recordPresence(deps: SessionFollowerDependencies, caller: SessionCaller & { name: string }, sessionId: string): Promise<{ viewingNow: SessionOwner[] }> {
  const { session } = await requireSessionLevel(deps, caller, sessionId, "view", "watch it");
  const nowMs = deps.now();
  const at = new Date(nowMs).toISOString();
  const old = await deps.documentClient.send(new PutCommand({
    TableName: deps.tableName,
    Item: {
      ...agentSessionKey(session.orgId, session.sessionId, `${PRESENCE_PREFIX}${caller.developerId}`), entityType: "AGENT_SESSION_PRESENCE", orgId: session.orgId, sessionId: session.sessionId,
      developerId: caller.developerId, name: cleanSessionName(caller.name) ?? "Someone", at, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(nowMs / 1000) + PRESENCE_TTL_SECONDS,
    },
    ReturnValues: "ALL_OLD",
  })) as { Attributes?: Item };
  if (old.Attributes === undefined || !fresh(old.Attributes["at"], nowMs)) {
    // The session's own channel only, no feed: a person arriving is not something to catch up on. The revision is the summary's, as the sink's notices carry.
    await publishNotices({ realtime: deps.realtimePublish, now: deps.now, log: deps.log }, [
      { channel: sessionChannel(session.orgId, session.sessionId), notice: { type: "session.updated", sessionId: session.sessionId, revision: session.summaryRevision } },
    ]);
  }
  return { viewingNow: await viewingNow(deps, session, nowMs) };
}
