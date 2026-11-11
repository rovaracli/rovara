// What happens to sessions when a member leaves or merges into another, and when the company closes (Plan 5 Task 21).
//
// A member REMOVED: their follows, their presence and the shares made with them go (each with its index row; a follow is counted off the session), and their devices are revoked
// (Task 18 ends the sessions of a revoked device). NOTHING passes to the successor: a session they started keeps them as its owner, and a task session they own follows ruling
// R60 through `effectiveTaskOwner` (the next dispatch finds the owner is no longer a member and ends the task). A member MERGED into another: their follows, shares, the sessions
// they own (the session record, its live tile, its "mine" row, and the task's current owner with the task-list row of a taker) and their devices become the survivor's.
//
// Both run as members of Plan 3's member lifecycle (`registerMemberMover`): the removal's marker and the merge's marker stay until every mover has finished, a mover that runs out of
// the time its caller gave it (`checkTime`) leaves the marker for the settlement run's drain, and every step can be repeated: a step looks at what is there now and writes
// conditionally on it. Every key is built from the org the marker names, and only keys of the person are read or written.
//
// A merge is not a take-over: it writes no `session.owner_changed` audit event, does not refuse a Mac session and does not check the survivor's limits. It is the same person under
// two sign-ins (Plan 2's merge carries its own audit and moves their budget), so no spend is put on anyone new. A share the survivor already held on a session the duplicate owned is
// left standing once the session is theirs (harmless).
//
// An org CLOSED: `clearOrgSessions` deletes the org's live index and presence, its open and ended work entries, its devices and its change feeds, and gives everything else of the
// sessions an expiry 30 days on (vision 11b). An expiry is only ever shortened, so a repeat never pushes one out.
import { moveAsksOnMerge } from "./ask-erase.js";
import { createHash } from "node:crypto";
import { DeleteCommand, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { AGENTX_NAME_PATTERN, DeviceIdSchema, INDEX_EXPIRY_ATTRIBUTE, LIVE_INDEX_SCAN_MAX, OrgIdSchema, SessionIdSchema, SlackUserIdSchema, agentSessionKey, agentXError, changesKey, cleanSessionName, livePresenceKey, liveSessionKey, mySessionsKey, openAgentSessionKey, orgPk, orgProjectCatalogPk, projectMonthStatsKey, projectSessionsKey, sessionBindingKey, sessionSurfaceKey, sharedSessionsKey, type AgentPrincipal, type OrgId, type Payer, type SessionBinding, type SessionLevel } from "@rovara-code/contracts";
import { LOCAL_ORG_CLOSED_MESSAGE, deviceKey, memberDevicesKey, type DeveloperSignInMethod } from "@agentx/cloud-contracts";
import { checkTime, registerMemberMover } from "../agents/lifecycle.js";
import { errorName, failedIndexes, type Item, type TransactItem } from "../agents/table-writes.js";
import type { DeveloperSignInStore } from "../developer/store.js";
import { paymentOfTask } from "../spend/payer.js";
import { UNNAMED_MEMBER, currentOwnerAfterMerge, holdsTaskByTakeOver, ownerFenceOf, taskIndexKey, taskKey, tryEffectiveTaskOwner, type DeveloperTaskRecord } from "../developer/task-records.js";
import { endLocalSession, endSessionsOfDevice } from "../devices/local-sessions.js";
import { removeFollower } from "./followers.js";
import { AgentSessionStore } from "./store.js";
import { batchGetItems, keyText } from "./live.js";
import { ENDED_DRAIN_CURSOR_KEY } from "./summary.js";

/** What these steps need of the broker. `deadline` is the time `checkTime` stops the steps at, between two items. */
export interface SessionLifecycleDeps {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
  /** Where a survivor's name is read (a merge). */
  signInStore?: Pick<DeveloperSignInStore, "getDeveloper">;
  deadline?: number;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

const MEMBER_ID = /^[a-f0-9]{64}$/;
const PAGE = 100;
/** The most pages one person's rows are read in a run: more than this is finished by the next run (what was handled is gone from the partition by then). */
const PAGES_MAX = 50;
const DAY_SECONDS = 86_400;
/** How long a closed org's session data stays before the table's TTL deletes it (vision 11b). */
const CLOSED_ORG_KEEP_DAYS = 30;
/** How long a revoked device's record stays: as long as the sessions that name it. */
const REVOKED_DEVICE_KEEP_DAYS = 365;
const CONFLICT_RETRIES = 3;
/** How much of one run a close may take before it stops and asks to be run again. */
const CLOSE_BUDGET_MS = 15_000;
/** The most days of ended-session work entries looked at for an org (the drain keeps well inside this). */
const ENDED_DAYS_MAX = 400;
const LEVEL_RANK: Record<SessionLevel, number> = { view: 1, use: 2, edit: 3 };
const SHARE_PREFIX = "SHARE#";
const FOLLOWER_PREFIX = "FOLLOWER#";
const BINDING_PREFIX = "BINDING#";

const invalid = (message: string) => agentXError("CONFIG_INVALID", message);
const unavailable = (message: string) => agentXError("RUNTIME_UNAVAILABLE", message);
const log = (deps: Pick<SessionLifecycleDeps, "log">, event: string, fields: Record<string, unknown>): void =>
  (deps.log ?? ((name, detail) => console.log(JSON.stringify({ component: "broker", event: name, ...detail }))))(event, fields);
const isoOf = (ms: number) => new Date(ms).toISOString();
const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Refuses what is not an org id or a member id, before anything is read: the keys below are built from these. */
function requireIds(orgId: string, ...developerIds: string[]): OrgId {
  const org = OrgIdSchema.safeParse(orgId);
  if (!org.success) throw invalid("orgId: is not an organization id");
  for (const id of developerIds) if (!MEMBER_ID.test(id)) throw invalid("developerId: is not a member id");
  return org.data;
}

// ---- reading

async function getItem(deps: SessionLifecycleDeps, key: { pk: string; sk: string }): Promise<Item | undefined> {
  return ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Item }).Item;
}

/**
 * Reads the items of one partition a page at a time and hands each page to `visit`, stopping between pages when the caller's time has run out. `maxPages` bounds a run that deletes
 * or moves what it reads (it goes on from the start next time, the handled rows being gone); without it only the deadline bounds the read.
 */
async function eachPage(deps: SessionLifecycleDeps, query: { pk: string; prefix?: string }, visit: (items: Item[]) => Promise<void>, maxPages?: number): Promise<void> {
  let start: Record<string, unknown> | undefined;
  let pages = 0;
  do {
    checkTime(deps);
    if (maxPages !== undefined && pages >= maxPages) throw unavailable("There is more to move than one run does; the next run goes on.");
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, ConsistentRead: true, Limit: PAGE,
      KeyConditionExpression: query.prefix === undefined ? "pk = :pk" : "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": query.pk, ...(query.prefix === undefined ? {} : { ":prefix": query.prefix }) },
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    await visit(page.Items ?? []);
    start = page.LastEvaluatedKey;
    pages += 1;
  } while (start !== undefined);
}

/** One transaction; a lost race on the items (conditions or other transactions) answers false so the caller reads again, any other fault is thrown. */
async function transact(deps: SessionLifecycleDeps, items: TransactItem[]): Promise<boolean> {
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
    return true;
  } catch (error) {
    if (failedIndexes(error) === undefined) throw error;
    return false;
  }
}

const sessionIdOf = (row: Item, orgId: OrgId): string | undefined => {
  const sessionId = SessionIdSchema.safeParse(row["sessionId"]);
  return row["orgId"] === orgId && sessionId.success && row["sk"] === sessionId.data ? sessionId.data : undefined;
};

/** The sessions the org lists as live (open, or ended in the last day), at most what the Live wall reads. */
async function liveSessionIds(deps: SessionLifecycleDeps, orgId: OrgId): Promise<string[]> {
  const ids: string[] = [];
  let capped = false;
  try {
    await eachPage(deps, { pk: liveSessionKey(orgId, "ses_00000000000000000000").pk }, async (items) => {
      for (const item of items) if (typeof item["sk"] === "string") ids.push(item["sk"]);
      if (ids.length >= LIVE_INDEX_SCAN_MAX) throw new Error("capped");
    });
  } catch (error) {
    if (!(error instanceof Error && error.message === "capped")) throw error;
    capped = true;
  }
  if (capped) log(deps, "agent_session.lifecycle_live_scan_capped", { orgId, max: LIVE_INDEX_SCAN_MAX });
  return ids.slice(0, LIVE_INDEX_SCAN_MAX);
}

// ---- a member is removed

/**
 * Takes a removed member out of the sessions of the org: the shares made with them (the item on the session and its index row, together), their follows (counted off the
 * session) and presence on every session they had a share on or that is live, and their devices (revoked). Nothing passes to anyone. Repeatable.
 */
export async function onSessionMemberRemoved(deps: SessionLifecycleDeps, removal: { orgId: string; developerId: string; /** A person who is a member again: only shares and devices from before this instant go (a follow or a presence item can't give access, so they all go). */ since?: string }): Promise<void> {
  const orgId = requireIds(removal.orgId, removal.developerId);
  const { developerId } = removal;
  const principal: AgentPrincipal = { kind: "member", developerId };
  const touched = new Set<string>();
  await eachPage(deps, { pk: sharedSessionsKey(orgId, principal, "ses_00000000000000000000").pk }, async (rows) => {
    for (const row of rows) {
      checkTime(deps);
      const sessionId = sessionIdOf(row, orgId);
      if (sessionId === undefined) {
        // Not a row this partition writes: it is the person's own partition, so it goes with them.
        log(deps, "agent_session.lifecycle_share_row_unreadable", { orgId });
        await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: { pk: String(row["pk"]), sk: String(row["sk"]) } }));
        continue;
      }
      // After a rejoin only what was shared before the removal goes; one shared since belongs to the new membership.
      if (removal.since !== undefined && typeof row["sharedAt"] === "string" && row["sharedAt"] >= removal.since) continue;
      touched.add(sessionId);
      // Both go or neither: an index row with no share (or the reverse) would list a session to someone who cannot open it, or open one nobody lists.
      await deps.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          { Delete: { TableName: deps.tableName, Key: agentSessionKey(orgId, sessionId, `${SHARE_PREFIX}MEMBER#${developerId}`) } },
          { Delete: { TableName: deps.tableName, Key: sharedSessionsKey(orgId, principal, sessionId) } },
        ],
      }));
    }
  }, PAGES_MAX);
  for (const sessionId of await liveSessionIds(deps, orgId)) touched.add(sessionId);
  await dropFollowsAndPresence(deps, orgId, developerId, [...touched]);
  await revokeDevices(deps, orgId, developerId, removal.since);
}

/** Deletes the person's follow (with the count) and presence items on these sessions. A follow another request removed first is gone, which is what is wanted. */
async function dropFollowsAndPresence(deps: SessionLifecycleDeps, orgId: OrgId, developerId: string, sessionIds: readonly string[]): Promise<void> {
  const keys = sessionIds.flatMap((sessionId) => [
    agentSessionKey(orgId, sessionId, `${FOLLOWER_PREFIX}${developerId}`), agentSessionKey(orgId, sessionId, `PRESENCE#${developerId}`), livePresenceKey(orgId, sessionId, developerId),
  ]);
  const found = await batchGetItems(deps, keys);
  for (const sessionId of sessionIds) {
    checkTime(deps);
    if (found.has(keyText(agentSessionKey(orgId, sessionId, `${FOLLOWER_PREFIX}${developerId}`)))) await removeFollower(deps, { orgId, sessionId }, developerId);
    for (const key of [agentSessionKey(orgId, sessionId, `PRESENCE#${developerId}`), livePresenceKey(orgId, sessionId, developerId)]) {
      if (found.has(keyText(key))) await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: key }));
    }
  }
}

/**
 * Marks each of the person's devices revoked (Task 17's `revokedAt`), once, and lets the record go a year later, and ends the open sessions of every one of them (Task 18): also for a
 * device already marked, so a run that stopped between the mark and the end is finished by the next.
 */
async function revokeDevices(deps: SessionLifecycleDeps, orgId: OrgId, developerId: string, since?: string): Promise<void> {
  const at = isoOf(deps.now());
  const expires = Math.floor(deps.now() / 1000) + REVOKED_DEVICE_KEEP_DAYS * DAY_SECONDS;
  await eachPage(deps, { pk: memberDevicesKey(orgId, developerId, "dvc_00000000000000000000").pk }, async (rows) => {
    for (const row of rows) {
      checkTime(deps);
      const deviceId = DeviceIdSchema.safeParse(row["sk"]);
      if (!deviceId.success || row["orgId"] !== orgId) continue;
      // A device registered since a rejoin belongs to the new membership.
      if (since !== undefined && typeof row["createdAt"] === "string" && row["createdAt"] >= since) continue;
      try {
        await deps.documentClient.send(new UpdateCommand({
          TableName: deps.tableName, Key: deviceKey(orgId, deviceId.data), UpdateExpression: "SET revokedAt = :at, #expires = :expires",
          ConditionExpression: "attribute_exists(pk) AND orgId = :org AND developerId = :developer AND attribute_not_exists(revokedAt)",
          ExpressionAttributeNames: { "#expires": INDEX_EXPIRY_ATTRIBUTE }, ExpressionAttributeValues: { ":at": at, ":expires": expires, ":org": orgId, ":developer": developerId },
        }));
      } catch (error) {
        // Already revoked, gone, or no longer theirs: nothing to mark.
        if (errorName(error) !== "ConditionalCheckFailedException") throw error;
      }
      await endSessionsOfDevice({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, log: (entry) => log(deps, typeof entry["event"] === "string" ? entry["event"] : "devices.end_sessions", entry) }, orgId, deviceId.data);
    }
  }, PAGES_MAX);
}

// ---- two members are merged

interface Survivor { developerId: string; name: string; provider: DeveloperSignInMethod; slackUserId?: string }

async function survivorOf(deps: SessionLifecycleDeps, developerId: string): Promise<Survivor> {
  const record = deps.signInStore === undefined ? undefined : await deps.signInStore.getDeveloper(developerId);
  if (record === undefined) throw agentXError("NOT_FOUND", "the member the sessions move to could not be found");
  return {
    developerId, name: cleanSessionName(record.displayName) ?? UNNAMED_MEMBER, provider: record.provider,
    ...(record.slackUserId !== undefined && SlackUserIdSchema.safeParse(record.slackUserId).success ? { slackUserId: record.slackUserId } : {}),
  };
}

/**
 * Makes a merged duplicate's sessions the survivor's, in this order (each step repeatable, and a run that stopped is finished by the next): the sessions they own, then the shares
 * made with them, their follows, and their devices. Nothing is read or written outside the org the marker names.
 */
export async function onSessionMembersMerged(deps: SessionLifecycleDeps, merge: { orgId: string; survivorId: string; duplicateId: string }): Promise<void> {
  const orgId = requireIds(merge.orgId, merge.survivorId, merge.duplicateId);
  const { survivorId, duplicateId } = merge;
  if (survivorId === duplicateId) throw invalid("a member cannot be merged into itself");
  const survivor = await survivorOf(deps, survivorId);
  const touched = new Set<string>(await moveOwnedSessions(deps, orgId, duplicateId, survivor));
  await moveShares(deps, orgId, duplicateId, survivor, touched);
  for (const sessionId of await liveSessionIds(deps, orgId)) touched.add(sessionId);
  await rewriteSharers(deps, orgId, duplicateId, survivor, [...touched]);
  await moveFollows(deps, orgId, duplicateId, survivorId, [...touched]);
  await moveDevices(deps, orgId, duplicateId, survivorId);
  // Live interaction Asks: the duplicate's Asks (and its label in other people's stored answers) become the survivor's, so erasing the survivor finds them all. Repeatable and bounded.
  for (let pass = 0; pass < 25; pass += 1) {
    if ((await moveAsksOnMerge(deps, orgId, duplicateId, survivorId)).complete) break;
  }
  // The tasks come last: the steps above consume what they read, so a duplicate with a great many tasks (or a run that stops early) can't keep them from finishing.
  await moveCreatedTasks(deps, orgId, duplicateId, survivor);
}

/** The duplicate's "mine" rows: each session's owner, its live tile, its row and (for a task) the task's current owner and the taker's task-list row, in one transaction on what was read. */
async function moveOwnedSessions(deps: SessionLifecycleDeps, orgId: OrgId, duplicateId: string, survivor: Survivor): Promise<string[]> {
  const seen: string[] = [];
  await eachPage(deps, { pk: mySessionsKey(orgId, duplicateId, "2026-01-01T00:00:00.000Z", "ses_00000000000000000000").pk }, async (rows) => {
    for (const row of rows) {
      checkTime(deps);
      const sessionId = sessionIdOf({ ...row, sk: String(row["sk"]).split("#").slice(1).join("#") }, orgId);
      if (sessionId === undefined || typeof row["createdAt"] !== "string") {
        log(deps, "agent_session.lifecycle_mine_row_unreadable", { orgId });
        continue;
      }
      seen.push(sessionId);
      await moveOwnedSession(deps, orgId, duplicateId, survivor, sessionId, row);
    }
  }, PAGES_MAX);
  return seen;
}

async function moveOwnedSession(deps: SessionLifecycleDeps, orgId: OrgId, duplicateId: string, survivor: Survivor, sessionId: string, row: Item): Promise<void> {
  const headerKey = agentSessionKey(orgId, sessionId, "META");
  const rowKey = { pk: String(row["pk"]), sk: String(row["sk"]) };
  const createdAt = String(row["createdAt"]);
  for (let attempt = 0; attempt < CONFLICT_RETRIES; attempt += 1) {
    const header = await getItem(deps, headerKey);
    const owner = isRecord(header?.["owner"]) ? header["owner"] : undefined;
    // Not theirs any more (a take-over, or an earlier run moved it): only the stale row is left to go.
    if (header === undefined || header["orgId"] !== orgId || owner?.["developerId"] !== duplicateId || typeof header["revision"] !== "number") {
      await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: rowKey }));
      return;
    }
    const revision = header["revision"];
    const at = isoOf(deps.now());
    const newOwner = { developerId: survivor.developerId, name: survivor.name };
    // The session keeps a copy of who pays; a person-paid copy naming the duplicate names the survivor now (the task's own payer moves in the same transaction).
    const paidBy = isRecord(header["payer"]) ? header["payer"] : undefined;
    const payer: Payer | undefined = paidBy?.["kind"] === "member" && paidBy["developerId"] === duplicateId ? { kind: "member", developerId: survivor.developerId } : undefined;
    const items: TransactItem[] = [
      {
        Update: {
          TableName: deps.tableName, Key: headerKey, UpdateExpression: `SET #owner = :owner, updatedAt = :at${payer === undefined ? "" : ", payer = :payer"} ADD #revision :one`,
          ConditionExpression: "attribute_exists(pk) AND orgId = :org AND #owner.developerId = :duplicate AND #revision = :revision",
          ExpressionAttributeNames: { "#owner": "owner", "#revision": "revision" },
          ExpressionAttributeValues: { ":owner": newOwner, ":at": at, ":one": 1, ":org": orgId, ":duplicate": duplicateId, ":revision": revision, ...(payer === undefined ? {} : { ":payer": payer }) },
        },
      },
      { Delete: { TableName: deps.tableName, Key: rowKey } },
      { Put: { TableName: deps.tableName, Item: { ...row, ...mySessionsKey(orgId, survivor.developerId, createdAt, sessionId), developerId: survivor.developerId } } },
    ];
    if (await getItem(deps, liveSessionKey(orgId, sessionId)) !== undefined) {
      items.push({
        Update: {
          TableName: deps.tableName, Key: liveSessionKey(orgId, sessionId), UpdateExpression: "SET ownerId = :ownerId, #owner = :owner, #revision = :revision",
          ConditionExpression: "attribute_exists(pk)", ExpressionAttributeNames: { "#owner": "owner", "#revision": "revision" },
          ExpressionAttributeValues: { ":ownerId": survivor.developerId, ":owner": newOwner, ":revision": revision + 1 },
        },
      });
    }
    const subject = isRecord(header["subject"]) ? header["subject"] : undefined;
    if (subject?.["kind"] === "task" && typeof subject["taskId"] === "string") {
      const plan = await taskPlan(deps, orgId, subject["taskId"], duplicateId, survivor, at);
      // The session and its task never disagree about who owns them: a session moves only with its task (or when the task is the survivor's already, or gone). Otherwise both wait for a later run.
      if (plan.hold === "other") {
        log(deps, "agent_session.lifecycle_session_left", { orgId, sessionId });
        return;
      }
      items.push(...plan.items);
    }
    if (await transact(deps, items)) return;
  }
  throw unavailable("This session is busy right now; the next run moves it.");
}

/** What a merge finds on a task: `handed` (the duplicate held it; the survivor gets it), `already` (the survivor owns it), `gone` (no such task in this org) or `other` (someone else owns it, or its owner can't be read). */
type TaskHold = "handed" | "already" | "gone" | "other";

/**
 * What a merge changes on one task, as transaction items (none when there is nothing to change), and who holds the task: the survivor becomes the task's current owner when the duplicate
 * held it (see `currentOwnerAfterMerge`), the survivor pays where the duplicate did (the explicit payer, or the creator-default one a take-over would have written), and the survivor gets
 * the task-list row (a copy of the creator's; a taker's own copy moves). Conditional on the owner the task was read with.
 */
async function taskPlan(deps: SessionLifecycleDeps, orgId: OrgId, taskId: string, duplicateId: string, survivor: Survivor, at: string): Promise<{ items: TransactItem[]; hold: TaskHold }> {
  const found = await getItem(deps, taskKey(taskId));
  if (found === undefined || found["orgId"] !== orgId) return { items: [], hold: "gone" };
  const task = found as unknown as DeveloperTaskRecord & Item;
  let handedOn: ReturnType<typeof currentOwnerAfterMerge>;
  let fence: ReturnType<typeof ownerFenceOf>;
  let already: boolean;
  try {
    handedOn = currentOwnerAfterMerge(task, duplicateId, { developerId: survivor.developerId, name: survivor.name, provider: survivor.provider, ...(survivor.slackUserId === undefined ? {} : { slackUserId: survivor.slackUserId }) }, at);
    fence = ownerFenceOf(task);
    already = tryEffectiveTaskOwner(task)?.developerId === survivor.developerId;
  } catch (error) {
    // A task whose owner can't be read is nobody's to hand on: it is left as it is.
    log(deps, "agent_session.lifecycle_task_owner_unreadable", { orgId, taskId, error: errorName(error) ?? "unknown" });
    return { items: [], hold: "other" };
  }
  const paid = paymentOfTask(task).payer;
  const payer: Payer | undefined = paid.kind === "member" && paid.developerId === duplicateId ? { kind: "member", developerId: survivor.developerId } : undefined;
  const hold: TaskHold = handedOn !== undefined ? "handed" : already ? "already" : "other";
  if (handedOn === undefined && payer === undefined) return { items: [], hold };
  const sets = ["updatedAt = :at", ...(handedOn === undefined ? [] : ["currentOwner = :currentOwner"]), ...(payer === undefined ? [] : ["payer = :payer"])];
  const items: TransactItem[] = [{
    Update: {
      TableName: deps.tableName, Key: taskKey(taskId), UpdateExpression: `SET ${sets.join(", ")}`,
      ConditionExpression: `attribute_exists(pk) AND orgId = :org AND ${fence.expression}`, ExpressionAttributeNames: fence.names,
      ExpressionAttributeValues: { ...fence.values, ":at": at, ":org": orgId, ...(handedOn === undefined ? {} : { ":currentOwner": handedOn }), ...(payer === undefined ? {} : { ":payer": payer }) },
    },
  }];
  if (handedOn !== undefined && typeof task.createdAt === "string") {
    // A taker's row is their own copy and moves with them; for a task the duplicate created, the survivor gets a copy and the creator's row stays as history.
    const taker = holdsTaskByTakeOver(task, duplicateId);
    const row = await getItem(deps, taskIndexKey(duplicateId, task.createdAt, taskId));
    if (row !== undefined) {
      if (taker) items.push({ Delete: { TableName: deps.tableName, Key: taskIndexKey(duplicateId, task.createdAt, taskId) } });
      items.push({ Put: { TableName: deps.tableName, Item: { ...row, ...taskIndexKey(survivor.developerId, task.createdAt, taskId) } } });
    }
  }
  return { items, hold };
}

/**
 * The tasks the duplicate has a list row for (the ones it created, also those with no session, and its taker copies), each handed on in a transaction on what was read, read
 * again after a lost race. The row is marked handed on (`mergedTo`) in the same transaction, or by a write of its own when there was nothing to hand on, and a marked row is
 * skipped next time: a run that stopped (the deadline, a fault) is continued by the next from where the marks end, however many rows the duplicate has. A taker copy that moves is deleted instead of marked.
 */
async function moveCreatedTasks(deps: SessionLifecycleDeps, orgId: OrgId, duplicateId: string, survivor: Survivor): Promise<void> {
  await eachPage(deps, { pk: taskIndexKey(duplicateId, "2026-01-01T00:00:00.000Z", "x").pk, prefix: "TASK#" }, async (rows) => {
    for (const row of rows) {
      const taskId = text(row["taskId"]);
      if (row["mergedTo"] !== undefined || taskId === undefined || String(row["sk"]).split("#")[2] !== taskId) continue;
      checkTime(deps);
      const rowKey = { pk: String(row["pk"]), sk: String(row["sk"]) };
      const mark: TransactItem = {
        Update: {
          TableName: deps.tableName, Key: rowKey, UpdateExpression: "SET mergedTo = :survivor", ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(mergedTo)",
          ExpressionAttributeValues: { ":survivor": survivor.developerId },
        },
      };
      let moved = false;
      for (let attempt = 0; attempt < CONFLICT_RETRIES && !moved; attempt += 1) {
        const { items } = await taskPlan(deps, orgId, taskId, duplicateId, survivor, isoOf(deps.now()));
        const rowDeleted = items.some((item) => item.Delete?.Key?.["pk"] === rowKey.pk && item.Delete.Key["sk"] === rowKey.sk);
        moved = await transact(deps, [...items, ...(rowDeleted ? [] : [mark])]);
      }
      if (!moved) throw unavailable("A task is busy right now; the next run hands it on.");
    }
  });
}

/** The shares the duplicate made on these sessions say the survivor made them (who may remove a share follows the person who made it). Only the duplicate's are touched. */
async function rewriteSharers(deps: SessionLifecycleDeps, orgId: OrgId, duplicateId: string, survivor: Survivor, sessionIds: readonly string[]): Promise<void> {
  for (const sessionId of sessionIds) {
    checkTime(deps);
    const pk = agentSessionKey(orgId, sessionId, "META").pk;
    const shares: Item[] = [];
    await eachPage(deps, { pk, prefix: SHARE_PREFIX }, async (items) => { shares.push(...items); });
    for (const share of shares) {
      if (share["orgId"] !== orgId || !isRecord(share["sharedBy"]) || share["sharedBy"]["developerId"] !== duplicateId) continue;
      try {
        await deps.documentClient.send(new UpdateCommand({
          TableName: deps.tableName, Key: { pk, sk: String(share["sk"]) }, UpdateExpression: "SET #by = :by",
          ConditionExpression: "attribute_exists(pk) AND #by.developerId = :duplicate", ExpressionAttributeNames: { "#by": "sharedBy" },
          ExpressionAttributeValues: { ":by": { developerId: survivor.developerId, name: survivor.name }, ":duplicate": duplicateId },
        }));
      } catch (error) {
        // Removed or changed since it was read: not the duplicate's any more.
        if (errorName(error) !== "ConditionalCheckFailedException") throw error;
      }
    }
  }
}

/** Each share made with the duplicate becomes the survivor's at the higher of the two levels; on a session the survivor owns it is dropped (no one shares with themselves). */
async function moveShares(deps: SessionLifecycleDeps, orgId: OrgId, duplicateId: string, survivor: Survivor, touched: Set<string>): Promise<void> {
  const from: AgentPrincipal = { kind: "member", developerId: duplicateId };
  const to: AgentPrincipal = { kind: "member", developerId: survivor.developerId };
  await eachPage(deps, { pk: sharedSessionsKey(orgId, from, "ses_00000000000000000000").pk }, async (rows) => {
    for (const row of rows) {
      checkTime(deps);
      const sessionId = sessionIdOf(row, orgId);
      if (sessionId === undefined) {
        log(deps, "agent_session.lifecycle_share_row_unreadable", { orgId });
        await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: { pk: String(row["pk"]), sk: String(row["sk"]) } }));
        continue;
      }
      touched.add(sessionId);
      await moveShare(deps, orgId, sessionId, from, to);
    }
  }, PAGES_MAX);
}

async function moveShare(deps: SessionLifecycleDeps, orgId: OrgId, sessionId: string, from: Extract<AgentPrincipal, { kind: "member" }>, to: Extract<AgentPrincipal, { kind: "member" }>): Promise<void> {
  const oldShare = agentSessionKey(orgId, sessionId, `${SHARE_PREFIX}MEMBER#${from.developerId}`);
  const newShare = agentSessionKey(orgId, sessionId, `${SHARE_PREFIX}MEMBER#${to.developerId}`);
  for (let attempt = 0; attempt < CONFLICT_RETRIES; attempt += 1) {
    const [dup, own, header] = await Promise.all([getItem(deps, oldShare), getItem(deps, newShare), getItem(deps, agentSessionKey(orgId, sessionId, "META"))]);
    const dupLevel = text(dup?.["level"]) as SessionLevel | undefined;
    // The share is gone already (an earlier run moved it, or it was removed), or no longer reads: the index row alone is left to delete.
    if (dup === undefined || dup["orgId"] !== orgId || dupLevel === undefined || LEVEL_RANK[dupLevel] === undefined) {
      await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: sharedSessionsKey(orgId, from, sessionId) }));
      return;
    }
    const survivorOwns = isRecord(header?.["owner"]) && header["owner"]["developerId"] === to.developerId;
    // The share the duplicate had is still what was read when it goes (a share changed since is read again).
    const dropped: TransactItem[] = [
      { Delete: { TableName: deps.tableName, Key: oldShare, ConditionExpression: "attribute_exists(pk) AND #level = :dupLevel", ExpressionAttributeNames: { "#level": "level" }, ExpressionAttributeValues: { ":dupLevel": dupLevel } } },
      { Delete: { TableName: deps.tableName, Key: sharedSessionsKey(orgId, from, sessionId) } },
    ];
    if (survivorOwns) {
      if (await transact(deps, dropped)) return;
      continue;
    }
    const ownLevel = text(own?.["level"]) as SessionLevel | undefined;
    const level = ownLevel !== undefined && LEVEL_RANK[ownLevel] !== undefined && LEVEL_RANK[ownLevel] >= LEVEL_RANK[dupLevel] ? ownLevel : dupLevel;
    const base = own !== undefined && ownLevel === level ? own : { ...dup, ...newShare, principal: to };
    const index = await getItem(deps, sharedSessionsKey(orgId, to, sessionId));
    const indexBase = index ?? { ...sharedSessionsKey(orgId, to, sessionId), entityType: "SHARED_SESSION", orgId, sessionId, sharedAt: dup["sharedAt"], ...(dup[INDEX_EXPIRY_ATTRIBUTE] === undefined ? {} : { [INDEX_EXPIRY_ATTRIBUTE]: dup[INDEX_EXPIRY_ATTRIBUTE] }) };
    const items: TransactItem[] = [
      // The survivor's own share is still as it was read (absent, or at the level it was).
      own === undefined
        ? { Put: { TableName: deps.tableName, Item: { ...base, level }, ConditionExpression: "attribute_not_exists(pk)" } }
        : { Put: { TableName: deps.tableName, Item: { ...base, level }, ConditionExpression: "#level = :ownLevel", ExpressionAttributeNames: { "#level": "level" }, ExpressionAttributeValues: { ":ownLevel": ownLevel } } },
      { Put: { TableName: deps.tableName, Item: { ...indexBase, principal: to, level } } },
      ...dropped,
    ];
    if (await transact(deps, items)) return;
  }
  throw unavailable("This session is busy right now; the next run moves its share.");
}

/** The duplicate's follows on these sessions become the survivor's (the count stays); where the survivor follows already, or owns the session, the duplicate's goes and the count drops. */
async function moveFollows(deps: SessionLifecycleDeps, orgId: OrgId, duplicateId: string, survivorId: string, sessionIds: readonly string[]): Promise<void> {
  const keys = sessionIds.map((sessionId) => agentSessionKey(orgId, sessionId, `${FOLLOWER_PREFIX}${duplicateId}`));
  const found = await batchGetItems(deps, keys);
  for (const sessionId of sessionIds) {
    checkTime(deps);
    if (!found.has(keyText(agentSessionKey(orgId, sessionId, `${FOLLOWER_PREFIX}${duplicateId}`)))) continue;
    await moveFollow(deps, orgId, sessionId, duplicateId, survivorId);
  }
}

async function moveFollow(deps: SessionLifecycleDeps, orgId: OrgId, sessionId: string, duplicateId: string, survivorId: string): Promise<void> {
  const oldKey = agentSessionKey(orgId, sessionId, `${FOLLOWER_PREFIX}${duplicateId}`);
  const newKey = agentSessionKey(orgId, sessionId, `${FOLLOWER_PREFIX}${survivorId}`);
  for (let attempt = 0; attempt < CONFLICT_RETRIES; attempt += 1) {
    const [dup, own, header] = await Promise.all([getItem(deps, oldKey), getItem(deps, newKey), getItem(deps, agentSessionKey(orgId, sessionId, "META"))]);
    if (dup === undefined) return;
    // The session's owner follows without an item (Task 9): a follow of the survivor's own session is only dropped.
    const survivorOwns = isRecord(header?.["owner"]) && header["owner"]["developerId"] === survivorId;
    if (own !== undefined || survivorOwns || header === undefined) {
      await removeFollower(deps, { orgId, sessionId }, duplicateId);
      return;
    }
    const moved = await transact(deps, [
      { Delete: { TableName: deps.tableName, Key: oldKey, ConditionExpression: "attribute_exists(pk)" } },
      { Put: { TableName: deps.tableName, Item: { ...dup, ...newKey, developerId: survivorId }, ConditionExpression: "attribute_not_exists(pk)" } },
    ]);
    if (moved) return;
  }
  throw unavailable("This session is busy right now; the next run moves its follower.");
}

/** The duplicate's devices become the survivor's: the record's owner and the member's list row. A device is kept whole, so the survivor may end up past the per-member limit; registering another is what the limit stops. */
async function moveDevices(deps: SessionLifecycleDeps, orgId: OrgId, duplicateId: string, survivorId: string): Promise<void> {
  await eachPage(deps, { pk: memberDevicesKey(orgId, duplicateId, "dvc_00000000000000000000").pk }, async (rows) => {
    for (const row of rows) {
      checkTime(deps);
      const deviceId = DeviceIdSchema.safeParse(row["sk"]);
      const rowKey = { pk: String(row["pk"]), sk: String(row["sk"]) };
      if (!deviceId.success || row["orgId"] !== orgId) {
        await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: rowKey }));
        continue;
      }
      const record = await getItem(deps, deviceKey(orgId, deviceId.data));
      if (record === undefined || record["orgId"] !== orgId || (record["developerId"] !== duplicateId && record["developerId"] !== survivorId)) {
        await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: rowKey }));
        continue;
      }
      const items: TransactItem[] = [
        { Delete: { TableName: deps.tableName, Key: rowKey } },
        { Put: { TableName: deps.tableName, Item: { ...row, ...memberDevicesKey(orgId, survivorId, deviceId.data), developerId: survivorId } } },
        record["developerId"] === duplicateId
          ? { Update: { TableName: deps.tableName, Key: deviceKey(orgId, deviceId.data), UpdateExpression: "SET developerId = :survivor", ConditionExpression: "attribute_exists(pk) AND developerId = :duplicate", ExpressionAttributeValues: { ":survivor": survivorId, ":duplicate": duplicateId } } }
          : { ConditionCheck: { TableName: deps.tableName, Key: deviceKey(orgId, deviceId.data), ConditionExpression: "attribute_exists(pk) AND developerId = :survivor", ExpressionAttributeValues: { ":survivor": survivorId } } },
      ];
      if (!await transact(deps, items)) throw unavailable("A device changed while it was moved; the next run goes on.");
    }
  }, PAGES_MAX);
}

// ---- an org is closed

/**
 * Closes the org's session data, in a way that makes progress however many runs it takes. Each session is finished in this order: its partition's items get the expiry, the
 * feeds and devices of the people it names are deleted, the index rows that name it get the expiry, and its record (`META`) gets the expiry LAST. A record that already has the
 * expiry (or an earlier one) marks the session as finished, and a later run skips it with one batched read for a hundred sessions and no read of its partition. An expiry is only
 * shortened, so a run at any later time compares against a later value and still skips what an earlier run finished. Then the org's lists and the live index are deleted (the live
 * index last, as it names sessions); each of those steps consumes what it reads, so a run that stops is continued by the next. Everything is found by keys built from `orgId`, and the
 * global lists by the org's own prefix.
 *
 * Not found: the change feed and revoked devices of a member removed earlier who is named by no session of the org, and sessions that no list, project or live index names. They expire
 * through their own TTLs (a revoked device a year after its revoking).
 */
export async function clearOrgSessions(deps: SessionLifecycleDeps, orgId: string): Promise<void> {
  const org = requireIds(orgId);
  const expires = Math.floor(deps.now() / 1000) + CLOSED_ORG_KEEP_DAYS * DAY_SECONDS;
  const run: CloseRun = { org, expires, purged: new Set(), looked: new Set() };

  const memberIds: string[] = [];
  await eachPage(deps, { pk: orgPk(org), prefix: "MEMBER#" }, async (items) => {
    for (const item of items) if (typeof item["developerId"] === "string" && MEMBER_ID.test(item["developerId"])) memberIds.push(item["developerId"]);
  });
  for (const developerId of memberIds) await purgePerson(deps, run, developerId);
  // The members' own lists and the projects' lists name the sessions that ended long ago; the live index names the rest.
  for (const developerId of memberIds) await stampList(deps, run, mySessionsKey(org, developerId, "2026-01-01T00:00:00.000Z", "ses_00000000000000000000").pk);
  const projects: string[] = [];
  await eachPage(deps, { pk: orgProjectCatalogPk(org), prefix: "PROJECT#" }, async (items) => {
    for (const item of items) if (typeof item["sk"] === "string" && AGENTX_NAME_PATTERN.test(item["sk"].slice("PROJECT#".length))) projects.push(item["sk"].slice("PROJECT#".length));
  });
  for (const project of projects) {
    await stampList(deps, run, projectSessionsKey(org, project, "2026-01-01T00:00:00.000Z", "ses_00000000000000000000").pk);
    await stampPartition(deps, projectMonthStatsKey(org, project, "2026-01").pk, expires);
  }
  await stampSessions(deps, run, await liveSessionIds(deps, org));

  // What is deleted: the org's entries in the global lists, the live presence, and the live index last.
  await deleteByPrefix(deps, openAgentSessionKey(org, "ses_00000000000000000000").pk, `${org}#`);
  for (const day of await endedDays(deps)) await deleteByPrefix(deps, `ENDED_AGENT_SESSIONS#${day}`, `${org}#`);
  await deleteWholePartition(deps, livePresenceKey(org, "ses_00000000000000000000", "0".repeat(64)).pk);
  await deleteWholePartition(deps, liveSessionKey(org, "ses_00000000000000000000").pk);
}

/** What one closing run remembers: the expiry it gives, the people whose feed and devices it already deleted, and the sessions it already looked at. */
interface CloseRun { org: OrgId; expires: number; purged: Set<string>; looked: Set<string> }

/** Deletes one person's change feed and devices in the org, once per run. */
async function purgePerson(deps: SessionLifecycleDeps, run: CloseRun, developerId: string): Promise<void> {
  if (run.purged.has(developerId)) return;
  run.purged.add(developerId);
  await deleteWholePartition(deps, changesKey(run.org, developerId, "2026-01-01T00:00:00.000Z", 0).pk);
  await deleteDevices(deps, run.org, developerId);
}

/** The sessions a list (a member's or a project's) names: each is finished (see `stampSessions`); a row whose session has no record is stale and gets the expiry itself. */
async function stampList(deps: SessionLifecycleDeps, run: CloseRun, pk: string): Promise<void> {
  await eachPage(deps, { pk }, async (rows) => {
    const named = rows.flatMap((row) => {
      const sessionId = SessionIdSchema.safeParse(row["sessionId"]);
      return row["orgId"] === run.org && sessionId.success ? [{ row, sessionId: sessionId.data }] : [];
    });
    const missing = await stampSessions(deps, run, named.map((entry) => entry.sessionId));
    for (const { row, sessionId } of named) {
      if (missing.has(sessionId) && needsExpiry(row, run.expires)) await shorten(deps, { pk: String(row["pk"]), sk: String(row["sk"]) }, run.expires);
    }
  });
}

/** Finishes each session not finished yet (a hundred records are read in one batch); answers the ids that have no record. */
async function stampSessions(deps: SessionLifecycleDeps, run: CloseRun, sessionIds: readonly string[]): Promise<Set<string>> {
  const missing = new Set<string>();
  const fresh = [...new Set(sessionIds)].filter((id) => !run.looked.has(id));
  for (let at = 0; at < fresh.length; at += PAGE) {
    checkTime(deps);
    const chunk = fresh.slice(at, at + PAGE);
    const found = await batchGetItems(deps, chunk.map((id) => agentSessionKey(run.org, id, "META")));
    for (const sessionId of chunk) {
      checkTime(deps);
      run.looked.add(sessionId);
      const record = found.get(keyText(agentSessionKey(run.org, sessionId, "META")));
      if (record === undefined || record["orgId"] !== run.org) missing.add(sessionId);
      else if (needsExpiry(record, run.expires)) await stampSession(deps, run, sessionId);
    }
  }
  return missing;
}

/** The request id a close stops a session with: the same for the same org and session, so asking again (the leave run twice) writes nothing more. A v4-shaped uuid from a hash. */
export function closeStopRequestId(orgId: string, sessionId: string): string {
  const hex = createHash("sha256").update(`rovara-close-stop|${orgId}|${sessionId}`).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = "89ab"[Number.parseInt(hex[16]!, 16) % 4]!;
  const joined = hex.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

/** The most sessions one close asks to stop: more than this is logged, and the dispatch guard (the owner is no longer a member) stops the rest at their next step. */
const CLOSE_STOP_MAX = 500;

/**
 * Asks the org's open sessions to stop before the org is closed, so that no work keeps spending (Plan 5 Task 21, review M-6). `stop` is the existing stop of a session (the task's own
 * cancel, or the chain run's), bound by the caller; the request id is `closeStopRequestId`, so it is idempotent. Best effort: a session that can't be stopped (a Mac session, a stop that
 * fails) is logged and the close goes on; the dispatch guard and the model-key mint stay the backstops. It stops asking at `deps.deadline`. The org's open list is read before the close deletes it.
 */
export async function stopOrgSessions(deps: SessionLifecycleDeps, orgId: string, stop: (sessionId: string, requestId: string) => Promise<void>): Promise<void> {
  const org = requireIds(orgId);
  const ids: string[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, ConsistentRead: true, Limit: PAGE, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": openAgentSessionKey(org, "ses_00000000000000000000").pk, ":prefix": `${org}#` },
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      const sessionId = SessionIdSchema.safeParse(item["sessionId"]);
      if (item["orgId"] === org && sessionId.success && item["sk"] === `${org}#${sessionId.data}`) ids.push(sessionId.data);
    }
    start = ids.length >= CLOSE_STOP_MAX ? undefined : page.LastEvaluatedKey;
  } while (start !== undefined);
  if (ids.length >= CLOSE_STOP_MAX) log(deps, "agent_session.close_stop_capped", { orgId: org, max: CLOSE_STOP_MAX });
  for (const sessionId of ids.slice(0, CLOSE_STOP_MAX)) {
    // The time this takes is bounded: what is not asked in time is stopped by the model-key mint and the dispatch guard at its next step, and a repeat of the leave asks again.
    if (deps.deadline !== undefined && deps.now() >= deps.deadline) {
      log(deps, "agent_session.close_stop_deadline", { orgId: org });
      break;
    }
    try {
      // A session on a Mac has no cloud work to stop: it is ended here, with the company's words, and the Mac is told by its next update being refused.
      const session = await new AgentSessionStore(deps).get(org, sessionId);
      if (session !== undefined && session.subject.kind === "local") {
        if (session.endedAt === undefined) await endLocalSession({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, log: (entry) => log(deps, typeof entry["event"] === "string" ? entry["event"] : "devices.end_sessions", entry) }, session, LOCAL_ORG_CLOSED_MESSAGE, "org-closed");
        continue;
      }
      await stop(sessionId, closeStopRequestId(org, sessionId));
    } catch (error) {
      log(deps, "agent_session.close_stop_failed", { orgId: org, sessionId, error: errorName(error) ?? "unknown" });
    }
  }
}

/** A closing run: stops and says so after `budgetMs` (a retryable refusal), so the leave that called it can be run again to finish. */
export async function closeOrgSessions(deps: Pick<SessionLifecycleDeps, "documentClient" | "tableName" | "now" | "log">, orgId: string, options: { budgetMs?: number } = {}): Promise<void> {
  try {
    await clearOrgSessions({ ...deps, deadline: deps.now() + (options.budgetMs ?? CLOSE_BUDGET_MS) }, orgId);
  } catch (error) {
    if (errorName(error) === "LifecycleDeadline") throw unavailable("Closing the company's sessions is taking a while. Leave again to finish.");
    throw error;
  }
}

/** Gives an item that exists an expiry, only if it has none or a later one. */
async function shorten(deps: SessionLifecycleDeps, key: { pk: string; sk: string }, expires: number): Promise<void> {
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: key, UpdateExpression: "SET #expires = :expires",
      ConditionExpression: "attribute_exists(pk) AND (attribute_not_exists(#expires) OR #expires > :expires)",
      ExpressionAttributeNames: { "#expires": INDEX_EXPIRY_ATTRIBUTE }, ExpressionAttributeValues: { ":expires": expires },
    }));
  } catch (error) {
    if (errorName(error) !== "ConditionalCheckFailedException") throw error;
  }
}

const needsExpiry = (item: Item, expires: number): boolean => typeof item[INDEX_EXPIRY_ATTRIBUTE] !== "number" || item[INDEX_EXPIRY_ATTRIBUTE] > expires;

/** Gives every item of a partition the expiry (an item already at or past it is not written), and shows each to `also`. */
async function stampPartition(deps: SessionLifecycleDeps, pk: string, expires: number, also?: (item: Item) => void): Promise<void> {
  await eachPage(deps, { pk }, async (items) => {
    for (const item of items) {
      checkTime(deps);
      also?.(item);
      if (needsExpiry(item, expires)) await shorten(deps, { pk: String(item["pk"]), sk: String(item["sk"]) }, expires);
    }
  });
}

/** One session, record last (see `clearOrgSessions`): its partition's items, the people it names (their feeds and devices go), the index items that name it, then `META`. */
async function stampSession(deps: SessionLifecycleDeps, run: CloseRun, sessionId: string): Promise<void> {
  const { org, expires } = run;
  const index: Array<{ pk: string; sk: string }> = [];
  const people = new Set<string>();
  let meta: Item | undefined;
  await eachPage(deps, { pk: agentSessionKey(org, sessionId, "META").pk }, async (items) => {
    for (const item of items) {
      checkTime(deps);
      if (item["orgId"] !== org) continue;
      const sk = String(item["sk"]);
      if (sk === "META") {
        meta = item;
        continue;
      }
      if (sk.startsWith(SHARE_PREFIX) && isRecord(item["principal"])) {
        const principal = item["principal"] as unknown as AgentPrincipal;
        try { index.push(sharedSessionsKey(org, principal, sessionId)); } catch { /* a share that does not read has no index row to find */ }
        if (principal.kind === "member" && MEMBER_ID.test(principal.developerId)) people.add(principal.developerId);
      } else if (sk.startsWith(FOLLOWER_PREFIX) && MEMBER_ID.test(sk.slice(FOLLOWER_PREFIX.length))) people.add(sk.slice(FOLLOWER_PREFIX.length));
      else if (sk.startsWith(BINDING_PREFIX) && isRecord(item["binding"])) {
        try { index.push(sessionSurfaceKey(org, item["binding"] as unknown as SessionBinding)); } catch { /* a binding that does not read has no surface row to find */ }
      }
      if (needsExpiry(item, expires)) await shorten(deps, { pk: String(item["pk"]), sk }, expires);
    }
  });
  // The bindings sit in a partition of their own (`sessionBindingKey`, Task 20 review I1), not the session's: each one and the surface item it names get the expiry too.
  await eachPage(deps, { pk: sessionBindingKey(org, sessionId, "slack_thread").pk }, async (items) => {
    for (const item of items) {
      checkTime(deps);
      if (item["orgId"] !== org || !String(item["sk"]).startsWith(BINDING_PREFIX)) continue;
      if (isRecord(item["binding"])) {
        try { index.push(sessionSurfaceKey(org, item["binding"] as unknown as SessionBinding)); } catch { /* a binding that does not read has no surface row to find */ }
      }
      if (needsExpiry(item, expires)) await shorten(deps, { pk: String(item["pk"]), sk: String(item["sk"]) }, expires);
    }
  });
  const found = meta;
  if (found !== undefined) {
    const createdAt = text(found["createdAt"]);
    const ownerId = isRecord(found["owner"]) ? text(found["owner"]["developerId"]) : undefined;
    const startedBy = isRecord(found["startedBy"]) ? text(found["startedBy"]["developerId"]) : undefined;
    for (const developerId of [ownerId, startedBy]) {
      if (developerId === undefined || !MEMBER_ID.test(developerId) || createdAt === undefined) continue;
      people.add(developerId);
      index.push(mySessionsKey(org, developerId, createdAt, sessionId));
    }
    const project = text(found["project"]);
    if (project !== undefined && createdAt !== undefined && AGENTX_NAME_PATTERN.test(project)) index.push(projectSessionsKey(org, project, createdAt, sessionId));
  }
  for (const developerId of people) await purgePerson(deps, run, developerId);
  for (const key of index) {
    checkTime(deps);
    await shorten(deps, key, expires);
  }
  // The record last: once it has the expiry, a later run treats the session as finished.
  if (found !== undefined) await shorten(deps, { pk: String(found["pk"]), sk: "META" }, expires);
}

/** The UTC days whose ended-session work entries can still be waiting: from the day the drain has reached (at most `ENDED_DAYS_MAX` back) to tomorrow. A parked entry older than that expires on its own. */
async function endedDays(deps: SessionLifecycleDeps): Promise<string[]> {
  const dayOf = (ms: number) => isoOf(ms).slice(0, 10);
  const cursor = text((await getItem(deps, ENDED_DRAIN_CURSOR_KEY))?.["day"]);
  const oldest = dayOf(deps.now() - ENDED_DAYS_MAX * DAY_SECONDS * 1000);
  const reached = cursor !== undefined && /^\d{4}-\d{2}-\d{2}$/u.test(cursor) ? cursor : dayOf(deps.now() - 2 * DAY_SECONDS * 1000);
  const last = dayOf(deps.now() + DAY_SECONDS * 1000);
  const days: string[] = [];
  for (let day = reached < oldest ? oldest : reached; day <= last && days.length <= ENDED_DAYS_MAX + 2; day = dayOf(Date.parse(`${day}T00:00:00.000Z`) + DAY_SECONDS * 1000)) days.push(day);
  return days;
}

/** Deletes the items of a partition whose sort key starts with `prefix` (the org's own entries in a global list). */
async function deleteByPrefix(deps: SessionLifecycleDeps, pk: string, prefix: string): Promise<void> {
  let start: Record<string, unknown> | undefined;
  do {
    checkTime(deps);
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, ConsistentRead: true, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix },
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      checkTime(deps);
      await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: { pk: String(item["pk"]), sk: String(item["sk"]) } }));
    }
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
}

/** Deletes every item of a partition that is one org's by its key (`orgScoped`). */
async function deleteWholePartition(deps: SessionLifecycleDeps, pk: string): Promise<void> {
  if (!pk.startsWith("ORG#org_")) throw new Error("only an org's own partition is deleted whole");
  let start: Record<string, unknown> | undefined;
  do {
    checkTime(deps);
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, ConsistentRead: true, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": pk },
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      checkTime(deps);
      await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: { pk, sk: String(item["sk"]) } }));
    }
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
}

/** A person's devices: each device's own partition (record and queued commands), then the row in their list. */
async function deleteDevices(deps: SessionLifecycleDeps, orgId: OrgId, developerId: string): Promise<void> {
  const listPk = memberDevicesKey(orgId, developerId, "dvc_00000000000000000000").pk;
  const rows: Item[] = [];
  await eachPage(deps, { pk: listPk }, async (items) => { rows.push(...items); });
  for (const row of rows) {
    const deviceId = DeviceIdSchema.safeParse(row["sk"]);
    if (deviceId.success) await deleteWholePartition(deps, deviceKey(orgId, deviceId.data).pk);
  }
  await deleteWholePartition(deps, listPk);
}

// ---- joining the member lifecycle

/** Registers the sessions' mover with Plan 3's member lifecycle (name `agent_sessions`). Registering again replaces it; the returned function removes it. */
export function registerSessionMemberMover(): () => void {
  return registerMemberMover({
    name: "agent_sessions",
    merged: (deps, merge) => onSessionMembersMerged(deps, merge),
    // A step of a removal's cut-off: it runs also when the person has rejoined, then only for what was theirs before the removal.
    cutOff: (deps, cut) => onSessionMemberRemoved(deps, { orgId: cut.orgId, developerId: cut.developerId, ...(cut.rejoined && cut.removedAt !== undefined ? { since: cut.removedAt } : {}) }),
  });
}

registerSessionMemberMover();

