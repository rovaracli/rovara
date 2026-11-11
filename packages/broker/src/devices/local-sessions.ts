// Local sessions (Plan 5 Task 18): a coding agent running on a person's Mac, seen in Rovara only by the people it is shared with (owner answer 2).
//
// WHO MAY DO WHAT, read live on every call:
//   - register (`POST /v1/app/sessions/local`): the device is the caller's own and not removed; a project, when named, is one the caller has a role on (checked BEFORE the company's rule,
//     so the rule's words never name a project the caller can't see); the company's rule allows the tool and the project; every share names a person or project of the company (never the
//     whole company, which needs the confirmation page); at least one share and at most `LOCAL_REGISTER_SHARES_MAX`. The project is for rules and budgets only: it shares nothing.
//   - update (`POST …/local/updates`): the device is the caller's own and live, the session names that device, and the caller owns the session. Anything else is `NOT_FOUND` and writes
//     nothing, so a device id (which is no secret until Plan 8 adds device keys) opens nothing of anyone else's, and a session that moved to the cloud can't be touched by a late Mac update.
//     The company's rule for the session's tool and project, and the person's role on the project, are read again on every update; one that only ends the session is always taken.
//   - limits (an end is never limited): 30 updates a minute for a session and 120 for a device, 12 status changes an hour that tell followers (past it the status saves and only
//     followers are left out), 20 open sessions on a device, 60 registrations an hour for a person. Each count is moved in the write's own transaction. A Mac silent for
//     `LOCAL_ABANDONED_HOURS` has its session ended by the summary (`summary.ts`, found by the session sweep).
//   - commands (`GET /v1/app/devices/{id}/commands`): the device's own person only. The commands are written by the session's steer and stop, after those read the sender's level.
//   - a removed device ends its open sessions (`endSessionsOfDevice`), found through the device's own entries and confirmed by each session's `subject.deviceId`.
//
// WHAT IS WRITTEN: a session's state from the Mac is one `LOCAL` item (status, step, peek, the count of turns, a revision every writer moves), its transcript is `TURN#<n>` items with a
// `local_turn` event each, and its summary is worked out from the `LOCAL` item by `refreshSessionSummary` (`local-facts.ts`). An update is at most `LOCAL_UPDATE_TURNS_MAX` (40) turns,
// so it, its events, the status, the device's last sight and the request's own item (R18) are ONE transaction: all or nothing.
import { DeleteCommand, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { createHash } from "node:crypto";
import { DEVICE_COMMAND_KEEP_DAYS, DEVICE_COMMANDS_PAGE_MAX, DeviceCommandViewSchema, LOCAL_FOLLOWER_STATUS_PER_HOUR, LOCAL_NEEDS_SHARE_MESSAGE, LOCAL_OPEN_MAX_MESSAGE, LOCAL_OPEN_PER_DEVICE_MAX, LOCAL_REGISTER_RATE_MESSAGE, LOCAL_REGISTRATIONS_PER_HOUR, LOCAL_UPDATES_PER_MINUTE_DEVICE, LOCAL_UPDATES_PER_MINUTE_SESSION, LOCAL_UPDATE_RATE_MESSAGE, LOCAL_TOO_MANY_SHARES_MESSAGE, LOCAL_TRANSCRIPT_FULL_MESSAGE, LocalUpdateBodySchema, RegisterLocalSessionBodySchema, deviceCommandCounterKey, deviceCommandKey, deviceKey, deviceRemovedMessage, deviceSessionKey, deviceRateKey, personRateKey, userChannel, type DeviceCommandView, type OrgRole } from "@agentx/cloud-contracts";
import { INDEX_EXPIRY_ATTRIBUTE, LOCAL_REGISTER_SHARES_MAX, LOCAL_TURNS_MAX, LOCAL_TURN_MAX_CHARS, SESSION_RETENTION_DAYS, SessionIdSchema, agentSessionKey, agentXError, canonicalJson, newPrefixedId, principalKey, projectArchivedMessage, redactText, sessionEventId, sessionRateKey, sessionTurnSk, type AgentSessionRecord, type OrgId, type OrgKey, type SessionStatus } from "@rovara-code/contracts";
import { NOT_EXISTS, commit, errorName, failedIndexes, isTransactionConflict, readRequest, type Item, type RequestMark, type TableInput, type TransactItem } from "../agents/table-writes.js";
import { inertTaskTitle } from "../aws/developer-tasks.js";
import { readProjectMeta } from "../developer/project-roles.js";
import { LOCAL_TOOL_WORDS, createLocalSessionItems } from "../agent-sessions/create.js";
import { checkPrincipal, type SessionShareDependencies } from "../agent-sessions/shares.js";
import { deliverSteerToDevice } from "../agent-sessions/steer.js";
import { eventText, sessionEventItem, AgentSessionStore } from "../agent-sessions/store.js";
import { refreshSessionSummary } from "../agent-sessions/summary.js";
import { publishNotices, type RealtimeConfig } from "../realtime/publish.js";
import { MAC_NOT_AVAILABLE_MESSAGE, isEndedStatus, readLocalState } from "./local-facts.js";
import { checkLocalAgentAllowed, readLocalAgentPolicy } from "./policy.js";
import { invalidBody, readDevice, type DeviceDependencies } from "./store.js";

export interface LocalSessionDependencies extends SessionShareDependencies {
  log?: ((entry: Record<string, unknown>) => void) | undefined;
  realtimePublish?: RealtimeConfig | undefined;
}

/** Who asks. `orgRole` is the caller's live role (a project's role for an org owner or admin follows it). */
export interface LocalCaller {
  developerId: string;
  orgId: OrgId;
  orgRole: OrgRole;
  name: string;
}

const ATTEMPTS = 3;
const DAY_SECONDS = 86_400;
/** The day a registered session's `LOCAL` item, turns and device entry expire if nothing moves them: as long as the session's records stay. */
const KEEP_SECONDS = SESSION_RETENTION_DAYS * DAY_SECONDS;
const START_LOOKBACK_MS = 7 * DAY_SECONDS * 1000;
const DEVICE_ENTRY_PAGES_MAX = 20;
const DEVICE_ENTRY_PAGE = 100;
/** The words and reasons this module refuses with, beyond the plan's exact texts. */
export const LOCAL_ORG_SHARE_MESSAGE = "Share a local session with people or projects first; sharing it with everyone in your company is done from its page, where you confirm it.";
export const LOCAL_SELF_SHARE_MESSAGE = "You already own this session.";
export const LOCAL_DUPLICATE_SHARE_MESSAGE = "Each person or project can be shared with once.";
const TOO_MANY_COMMANDS = "This Mac has too many commands waiting.";
const COMMAND_SEQ_MAX = 999_999;

const notFound = (what: "device" | "session") => agentXError("NOT_FOUND", `${what} not found`);
const isoOf = (ms: number) => new Date(ms).toISOString();
const secondsOf = (ms: number) => Math.floor(ms / 1000);
const sha256 = (value: unknown) => createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
const logOf = (deps: Pick<LocalSessionDependencies, "log">) => deps.log ?? ((entry: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", ...entry })));

// ---- limits

/** What a count is kept for: a session, a device, or a person. */
export type LimitScope = { kind: "session"; orgId: OrgId; sessionId: string } | { kind: "device"; orgId: OrgId; deviceId: string } | { kind: "person"; orgId: OrgId; developerId: string };
export const LOCAL_HOUR_MS = 3_600_000;
const HOUR_MS = LOCAL_HOUR_MS;
const MINUTE_MS = 60_000;

function limitKey(scope: LimitScope, name: "update" | "status" | "stop" | "register"): OrgKey {
  if (scope.kind === "device") return deviceRateKey(scope.orgId, scope.deviceId, "update");
  if (scope.kind === "person") return personRateKey(scope.orgId, scope.developerId, "local_register");
  return sessionRateKey(scope.orgId, scope.sessionId, "session", name === "status" ? "local_status" : name === "stop" ? "local_stop" : "local_update");
}

/**
 * One count of a fixed window (a minute or an hour), as a step of the write's own transaction: the new count is set from the count that was read and is conditional on it, so two writes
 * can't both take the last place (the loser reads again). `room` is false when the window is full. The item expires with its window.
 */
export async function limitStep(
  deps: Pick<TableInput, "documentClient" | "tableName">, scope: LimitScope, name: "update" | "status" | "stop" | "register", limit: number, windowMs: number, nowMs: number,
): Promise<{ room: boolean; item: TransactItem }> {
  const key = limitKey(scope, name);
  const stored = ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Item }).Item;
  const window = Math.floor(nowMs / windowMs) * windowMs;
  const seenWindow = stored?.["windowStart"];
  const seenCount = stored?.["count"];
  if (stored !== undefined && (typeof seenWindow !== "number" || typeof seenCount !== "number")) throw agentXError("RUNTIME_UNAVAILABLE", "This session is busy right now. Try again.");
  const count = typeof seenWindow === "number" && seenWindow === window && typeof seenCount === "number" ? seenCount : 0;
  return {
    room: count < limit,
    item: {
      Update: {
        TableName: deps.tableName, Key: key,
        UpdateExpression: "SET entityType = :type, orgId = :org, windowStart = :window, #count = :next, #expires = :expires",
        ConditionExpression: stored === undefined ? "attribute_not_exists(pk)" : "windowStart = :seenWindow AND #count = :seenCount",
        ExpressionAttributeNames: { "#count": "count", "#expires": INDEX_EXPIRY_ATTRIBUTE },
        ExpressionAttributeValues: {
          ":type": "LOCAL_RATE", ":org": scope.orgId, ":window": window, ":next": count + 1, ":expires": secondsOf(window + 2 * windowMs),
          ...(stored === undefined ? {} : { ":seenWindow": seenWindow, ":seenCount": seenCount }),
        },
      },
    },
  };
}

// ---- the checks every call makes

/** The device, when it is this org's, the caller's own and not removed; otherwise `NOT_FOUND`, the same as a device that isn't there. */
export async function ownLiveDevice(deps: DeviceDependencies, caller: Pick<LocalCaller, "orgId" | "developerId">, deviceId: string) {
  const record = await readDevice(deps, caller.orgId, deviceId);
  if (record === undefined || record.developerId !== caller.developerId || record.revokedAt !== undefined) throw notFound("device");
  return record;
}

/** A transaction item that holds only while the device is still this person's and not removed (a removal between the read and the write cancels the write). */
export function deviceStillTheirs(table: Pick<TableInput, "tableName">, orgId: OrgId, deviceId: string, developerId: string): TransactItem {
  return {
    ConditionCheck: {
      TableName: table.tableName, Key: deviceKey(orgId, deviceId),
      ConditionExpression: "attribute_exists(pk) AND orgId = :org AND developerId = :developer AND attribute_not_exists(revokedAt)",
      ExpressionAttributeValues: { ":org": orgId, ":developer": developerId },
    },
  };
}

/** A transaction item that holds only while the session is still this device's, this person's and open. */
function sessionStillTheirs(table: Pick<TableInput, "tableName">, session: Pick<AgentSessionRecord, "orgId" | "sessionId">, deviceId: string, developerId: string): TransactItem {
  return {
    ConditionCheck: {
      TableName: table.tableName, Key: agentSessionKey(session.orgId, session.sessionId, "META"),
      ConditionExpression: "attribute_exists(pk) AND orgId = :org AND #subject.#kind = :local AND #subject.#deviceId = :device AND #owner.#developerId = :owner AND attribute_not_exists(endedAt)",
      ExpressionAttributeNames: { "#subject": "subject", "#kind": "kind", "#deviceId": "deviceId", "#owner": "owner", "#developerId": "developerId" },
      ExpressionAttributeValues: { ":org": session.orgId, ":local": "local", ":device": deviceId, ":owner": developerId },
    },
  };
}

// ---- registering

interface RegisterReply { sessionId: string }

async function earlierRegistration(deps: LocalSessionDependencies, mark: RequestMark): Promise<RegisterReply | undefined> {
  const earlier = await readRequest(deps, mark.orgId, mark.developerId, mark.requestId);
  if (earlier === undefined) return undefined;
  if (earlier.fingerprint !== mark.fingerprint) throw agentXError("CONFIG_INVALID", "requestId: this request ID was already used for a different request");
  const sessionId = SessionIdSchema.safeParse((earlier.result as { sessionId?: unknown } | null)?.sessionId);
  if (!sessionId.success) throw notFound("session");
  return { sessionId: sessionId.data };
}

/**
 * `POST /v1/app/sessions/local`. Checks the caller's authority (see the top of this file), then writes the session, its first leg, its start event, its lists, its shares, its `LOCAL`
 * state, the device's entry for it and the request's item in ONE transaction. A repeat of the request answers the same session and writes nothing.
 */
export async function registerLocalSession(deps: LocalSessionDependencies, caller: LocalCaller, body: unknown): Promise<RegisterReply> {
  const parsed = RegisterLocalSessionBodySchema.safeParse(body);
  if (!parsed.success) throw invalidBody(parsed.error.issues[0]);
  const input = parsed.data;
  if (input.shares.length === 0) throw agentXError("CONFIG_INVALID", LOCAL_NEEDS_SHARE_MESSAGE);
  if (input.shares.length > LOCAL_REGISTER_SHARES_MAX) throw agentXError("CONFIG_INVALID", LOCAL_TOO_MANY_SHARES_MESSAGE);
  const { orgId, developerId } = caller;
  const mark: RequestMark = {
    orgId, developerId, requestId: input.requestId,
    fingerprint: sha256({ route: "local_session_register", deviceId: input.deviceId, tool: input.tool, title: input.title, project: input.project ?? null, startedAt: input.startedAt, shares: input.shares }),
  };
  const replay = await earlierRegistration(deps, mark);
  if (replay !== undefined) return replay;

  const device = await ownLiveDevice(deps, caller, input.deviceId);
  if (input.project !== undefined) {
    // The role first: the rule's refusal names the project, so it is only said to someone who has a role on it. A project that isn't there reads the same as one without a role.
    const role = await deps.projectMembers.roleOf(orgId, input.project, { developerId, orgRole: caller.orgRole });
    if (role === undefined) throw agentXError("PROJECT_NOT_FOUND", "project not found");
    // New work is not started on an archived project.
    if ((await readProjectMeta(deps, orgId, input.project))?.status === "archived") throw agentXError("PROJECT_ARCHIVED", projectArchivedMessage(input.project));
  }
  checkLocalAgentAllowed(await readLocalAgentPolicy(deps, orgId), input.tool, input.project);

  const seen = new Set<string>();
  for (const { principal, level } of input.shares) {
    if (principal.kind === "org") throw agentXError("CONFIG_INVALID", LOCAL_ORG_SHARE_MESSAGE);
    if (principal.kind === "member" && principal.developerId === developerId) throw agentXError("CONFIG_INVALID", LOCAL_SELF_SHARE_MESSAGE);
    const key = principalKey(principal);
    if (seen.has(key)) throw agentXError("CONFIG_INVALID", LOCAL_DUPLICATE_SHARE_MESSAGE);
    seen.add(key);
    await checkPrincipal(deps, orgId, input.project === undefined ? {} : { project: input.project }, principal, level);
  }

  if (await openSessionsOnDevice(deps, orgId, device.deviceId, LOCAL_OPEN_PER_DEVICE_MAX) >= LOCAL_OPEN_PER_DEVICE_MAX) throw agentXError("CONFIG_INVALID", LOCAL_OPEN_MAX_MESSAGE);

  const nowMs = deps.now();
  const now = isoOf(nowMs);
  // The Mac's own clock only says when the work began: never in the future, and not further back than a week.
  const startedAt = isoOf(Math.max(Math.min(Date.parse(input.startedAt), nowMs), nowMs - START_LOOKBACK_MS));
  const sessionId = newPrefixedId("ses");
  const expires = secondsOf(nowMs) + KEEP_SECONDS;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    // 60 registrations an hour for a person, counted in this transaction.
    const rate = await limitStep(deps, { kind: "person", orgId, developerId }, "register", LOCAL_REGISTRATIONS_PER_HOUR, HOUR_MS, nowMs);
    if (!rate.room) throw agentXError("TOO_MANY_REQUESTS", LOCAL_REGISTER_RATE_MESSAGE);
    const items: TransactItem[] = [
      deviceStillTheirs(deps, orgId, device.deviceId, developerId),
      rate.item,
      ...createLocalSessionItems(deps, {
        orgId, sessionId, deviceId: device.deviceId, deviceLabel: device.label, tool: input.tool, ...(input.project === undefined ? {} : { project: input.project }),
        title: inertTaskTitle(input.title), owner: { developerId, name: caller.name }, startedAt, shares: input.shares, now,
      }),
      {
        Put: {
          TableName: deps.tableName, ConditionExpression: NOT_EXISTS,
          Item: { ...agentSessionKey(orgId, sessionId, "LOCAL"), entityType: "AGENT_SESSION_LOCAL", orgId, sessionId, deviceId: device.deviceId, status: "running", costUsd: 0, turnCount: 0, rev: 0, updatedAt: now, [INDEX_EXPIRY_ATTRIBUTE]: expires },
        },
      },
      {
        Put: {
          TableName: deps.tableName, ConditionExpression: NOT_EXISTS,
          Item: { ...deviceSessionKey(orgId, device.deviceId, sessionId), entityType: "DEVICE_SESSION", orgId, deviceId: device.deviceId, sessionId, createdAt: now, [INDEX_EXPIRY_ATTRIBUTE]: expires },
        },
      },
    ];
    try {
      await commit(deps, items, (failed) => (failed.has(0) ? notFound("device") : undefined), mark, { sessionId });
      return { sessionId };
    } catch (error) {
      // Lost to the same request running at the same time: its answer is this one's.
      if ((error as { code?: string }).code === "IDEMPOTENCY_CONFLICT") {
        const won = await earlierRegistration(deps, mark);
        if (won !== undefined) return won;
      }
      // The person's count moved under it (another registration took a place): read it again.
      const failed = failedIndexes(error);
      if (isTransactionConflict(error) || (failed !== undefined && failed.has(1))) continue;
      throw error;
    }
  }
  throw agentXError("RUNTIME_UNAVAILABLE", "Starting a session is busy right now. Try again.");
}

/**
 * How many of a device's sessions are open now, counting up to `stopAt`: its entries are confirmed by the sessions themselves (an entry of a session that ended without taking it away, or
 * that is gone, is not counted and is deleted).
 */
export async function openSessionsOnDevice(deps: DeviceDependencies, orgId: OrgId, deviceId: string, stopAt: number): Promise<number> {
  const store = new AgentSessionStore(deps);
  const pk = deviceKey(orgId, deviceId).pk;
  let open = 0;
  let start: Record<string, unknown> | undefined;
  for (let page = 0; page < DEVICE_ENTRY_PAGES_MAX && open < stopAt; page += 1) {
    const found = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, ConsistentRead: true, Limit: DEVICE_ENTRY_PAGE, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": pk, ":prefix": "SESSION#" }, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    for (const row of found.Items ?? []) {
      const id = SessionIdSchema.safeParse(row["sessionId"]);
      const session = id.success && row["orgId"] === orgId ? await store.get(orgId, id.data) : undefined;
      if (session !== undefined && session.subject.kind === "local" && session.subject.deviceId === deviceId && session.endedAt === undefined) {
        open += 1;
        continue;
      }
      await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: { pk: String(row["pk"]), sk: String(row["sk"]) } })).catch(() => undefined);
    }
    start = found.LastEvaluatedKey;
    if (start === undefined) break;
  }
  return open;
}

// ---- updates from the Mac

export interface LocalUpdateReply {
  sessionId: string;
  status: SessionStatus;
  /** How many turns the request carried (all of them were written). */
  accepted: number;
}

/** A turn's words as they are kept: redacted first (so a cut can't leave half a token), control and invisible-format characters other than line breaks (and the two joiners names and emoji need) turned into spaces, cut to the turn limit. */
function turnText(text: string): string {
  return [...redactText(text).replace(/(?![\n\t\r\u200C\u200D])[\p{Cc}\p{Cf}]/gu, " ")].slice(0, LOCAL_TURN_MAX_CHARS).join("");
}

/** One turn on the timeline: who said it and the start of what they said, redacted and cut to the event limit. */
const turnEventText = (speaker: string, text: string): string => eventText(`${speaker}: ${text}`);

async function earlierUpdate(deps: LocalSessionDependencies, mark: RequestMark): Promise<LocalUpdateReply | undefined> {
  const earlier = await readRequest(deps, mark.orgId, mark.developerId, mark.requestId);
  if (earlier === undefined) return undefined;
  if (earlier.fingerprint !== mark.fingerprint) throw agentXError("CONFIG_INVALID", "requestId: this request ID was already used for a different request");
  const stored = earlier.result as Partial<LocalUpdateReply> | null;
  if (typeof stored?.sessionId !== "string" || typeof stored.status !== "string" || typeof stored.accepted !== "number") throw notFound("session");
  return { sessionId: stored.sessionId, status: stored.status, accepted: stored.accepted };
}

/**
 * `POST /v1/app/sessions/{id}/local/updates`: what the Mac says of its session. Authority is read first (the device is the caller's own and live, the session names it, the caller owns the
 * session: any other answer is `NOT_FOUND` and nothing is written), then a repeat of the request answers its first answer, then an ended session is `SESSION_ENDED`. The status, step,
 * peek and the turns are written (redacted), the device's `lastSeenAt` moves, and the session's summary is worked out again at once. An ended status ends the session.
 */
export async function recordLocalUpdate(deps: LocalSessionDependencies, caller: LocalCaller, sessionId: string, body: unknown): Promise<LocalUpdateReply> {
  const parsed = LocalUpdateBodySchema.safeParse(body);
  if (!parsed.success) throw invalidBody(parsed.error.issues[0]);
  const input = parsed.data;
  const id = SessionIdSchema.safeParse(sessionId);
  if (!id.success) throw notFound("session");
  const { orgId, developerId } = caller;
  const device = await ownLiveDevice(deps, caller, input.deviceId);
  const owned = (session: AgentSessionRecord | undefined): session is AgentSessionRecord =>
    session !== undefined && session.subject.kind === "local" && session.subject.deviceId === device.deviceId && session.owner.developerId === developerId;
  const store = new AgentSessionStore(deps);
  const session = await store.get(orgId, id.data);
  if (!owned(session)) throw notFound("session");

  const turns = input.turns ?? [];
  const mark: RequestMark = {
    orgId, developerId, requestId: input.requestId,
    fingerprint: sha256({ route: "local_update", sessionId: session.sessionId, deviceId: device.deviceId, status: input.status, step: input.step ?? null, peek: input.peek ?? null, turns, tokens: input.tokens ?? null }),
  };
  const replay = await earlierUpdate(deps, mark);
  if (replay !== undefined) return replay;
  if (session.endedAt !== undefined || isEndedStatus(session.summary.status)) throw agentXError("SESSION_ENDED", "This session has ended.");

  const ended = isEndedStatus(input.status);
  // An update that only ends the session is always taken (the Mac can close cleanly whatever the rule says now), and no end is ever limited.
  const endOnly = ended && turns.length === 0;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const local = await readLocalState(deps, session);
    if (local !== undefined && isEndedStatus(local["status"])) throw agentXError("SESSION_ENDED", "This session has ended.");
    const rev = typeof local?.["rev"] === "number" ? local["rev"] : 0;
    const count = typeof local?.["turnCount"] === "number" ? local["turnCount"] : 0;
    if (count + turns.length > LOCAL_TURNS_MAX) throw agentXError("CONFIG_INVALID", LOCAL_TRANSCRIPT_FULL_MESSAGE);
    if (!endOnly) await requireStillAllowed(deps, caller, session);
    const extras: TransactItem[] = [];
    let quiet = false;
    if (!ended) {
      const nowMs = deps.now();
      for (const [scope, limit] of [[{ kind: "session", orgId, sessionId: session.sessionId }, LOCAL_UPDATES_PER_MINUTE_SESSION], [{ kind: "device", orgId, deviceId: device.deviceId }, LOCAL_UPDATES_PER_MINUTE_DEVICE]] as const) {
        const step = await limitStep(deps, scope, "update", limit, MINUTE_MS, nowMs);
        if (!step.room) throw agentXError("TOO_MANY_REQUESTS", LOCAL_UPDATE_RATE_MESSAGE);
        extras.push(step.item);
      }
      // A change into a status that tells followers is counted; past the hour's limit it saves and tells no follower.
      if (FOLLOWER_STATUSES.has(input.status) && local?.["status"] !== input.status) {
        const step = await limitStep(deps, { kind: "session", orgId, sessionId: session.sessionId }, "status", LOCAL_FOLLOWER_STATUS_PER_HOUR, HOUR_MS, nowMs);
        if (step.room) extras.push(step.item);
        else quiet = true;
      }
    }
    const reply = await writeUpdate(deps, { caller, session, device: { deviceId: device.deviceId, label: device.label }, input, mark, local, rev, count, turns, extras });
    if (reply === "again") continue;
    await refreshQuietly(deps, orgId, session.sessionId, quiet);
    return reply;
  }
  throw agentXError("RUNTIME_UNAVAILABLE", "This session is busy right now. Try again.");
}

/** The statuses that tell a session's followers when a Mac reports a change into them (an end tells them too, and is never limited). */
const FOLLOWER_STATUSES: ReadonlySet<string> = new Set(["needs_person", "waiting", "stopped"]);

/**
 * The company's rule and the person's role, read again for an update that does more than end the session: a rule that was tightened (the tool turned off, the project left out, local
 * agents switched off) or a role that was lost refuses further work, with the reason; a rule that can't be read refuses with a retryable 503. Role first, so the rule's words never name a
 * project the person has lost.
 */
async function requireStillAllowed(deps: LocalSessionDependencies, caller: LocalCaller, session: AgentSessionRecord): Promise<void> {
  if (session.subject.kind !== "local") throw notFound("session");
  if (session.project !== undefined) {
    const role = await deps.projectMembers.roleOf(caller.orgId, session.project, { developerId: caller.developerId, orgRole: caller.orgRole });
    if (role === undefined) throw agentXError("PROJECT_ACCESS_DENIED", `You no longer have a role on ${session.project}, so this session can't send more updates. End it from your Mac.`);
  }
  checkLocalAgentAllowed(await readLocalAgentPolicy(deps, caller.orgId), session.subject.tool, session.project);
}

async function refreshQuietly(deps: Pick<LocalSessionDependencies, "documentClient" | "tableName" | "now" | "log">, orgId: OrgId, sessionId: string, quiet = false): Promise<void> {
  try {
    await refreshSessionSummary({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, log: logOf(deps), ...(quiet ? { quiet: true } : {}) }, orgId, sessionId);
  } catch (error) {
    // The write is committed: the sweep corrects the summary.
    logOf(deps)({ event: "agent_session.local_refresh_failed", orgId, sessionId, error: errorName(error) ?? "unknown" });
  }
}

interface UpdateInput {
  caller: LocalCaller;
  session: AgentSessionRecord;
  device: { deviceId: string; label: string };
  input: ReturnType<typeof LocalUpdateBodySchema.parse>;
  mark: RequestMark;
  local: Item | undefined;
  rev: number;
  count: number;
  turns: ReadonlyArray<{ at: string; role: "person" | "agent"; text: string }>;
  /** The limits' steps (their counts move with the write). */
  extras: readonly TransactItem[];
}

/**
 * Writes one update as ONE transaction (at most `LOCAL_UPDATE_TURNS_MAX` turns, so with their events it stays under DynamoDB's 100 items): the device's `lastSeenAt` (conditional on it
 * still being this person's and live), the session check, the `LOCAL` state, every turn and its event, the request's item and, for an end, the removal of the device's entry. All or
 * nothing. `"again"` when the `LOCAL` item moved under it (the caller reads it again).
 */
async function writeUpdate(deps: LocalSessionDependencies, u: UpdateInput): Promise<LocalUpdateReply | "again"> {
  const { session, caller, input } = u;
  const { orgId, developerId } = caller;
  const nowMs = deps.now();
  const now = isoOf(nowMs);
  const expires = secondsOf(nowMs) + KEEP_SECONDS;
  const owner = session.owner.name;
  const toolWords = session.subject.kind === "local" ? LOCAL_TOOL_WORDS[session.subject.tool] : "The agent";
  const speaker = (role: "person" | "agent") => (role === "person" ? owner : toolWords);
  const ended = isEndedStatus(input.status);
  const document: Item = {
    ...agentSessionKey(orgId, session.sessionId, "LOCAL"), entityType: "AGENT_SESSION_LOCAL", orgId, sessionId: session.sessionId, deviceId: u.device.deviceId, costUsd: 0,
    turnCount: u.count + u.turns.length, rev: u.rev + 1, [INDEX_EXPIRY_ATTRIBUTE]: expires, status: input.status, updatedAt: now,
    ...(input.step === undefined ? {} : { step: input.step }), ...(input.peek === undefined ? {} : { peek: input.peek }),
    ...(input.status === "failed" ? { lastRunFailed: true } : {}), ...(input.tokens === undefined ? {} : { tokens: input.tokens }), ...(ended ? { endedAt: now } : {}),
  };
  // 0: the device; 1: the session; 2: the `LOCAL` item (conditional on the revision read).
  const items: TransactItem[] = [
    {
      Update: {
        TableName: deps.tableName, Key: deviceKey(orgId, u.device.deviceId), UpdateExpression: "SET lastSeenAt = :at",
        ConditionExpression: "attribute_exists(pk) AND orgId = :org AND developerId = :developer AND attribute_not_exists(revokedAt)",
        ExpressionAttributeValues: { ":at": now, ":org": orgId, ":developer": developerId },
      },
    },
    sessionStillTheirs(deps, session, u.device.deviceId, developerId),
    {
      Put: {
        TableName: deps.tableName, Item: document,
        ...(u.local === undefined ? { ConditionExpression: NOT_EXISTS } : { ConditionExpression: "#rev = :rev", ExpressionAttributeNames: { "#rev": "rev" }, ExpressionAttributeValues: { ":rev": u.rev } }),
      },
    },
    ...u.extras,
  ];
  u.turns.forEach((turn, offset) => {
    const seq = u.count + offset + 1;
    const text = turnText(turn.text);
    items.push({
      Put: {
        TableName: deps.tableName, ConditionExpression: NOT_EXISTS,
        Item: {
          ...agentSessionKey(orgId, session.sessionId, sessionTurnSk(seq)), entityType: "AGENT_SESSION_LOCAL_TURN", orgId, sessionId: session.sessionId, seq, at: isoOf(Math.min(Date.parse(turn.at), nowMs)), role: turn.role, text,
          [INDEX_EXPIRY_ATTRIBUTE]: expires,
        },
      },
    });
    // Events are ordered by time, then id: a millisecond apart keeps the turns in the order they were said.
    items.push(sessionEventItem(deps, session, {
      eventId: sessionEventId("local_turn", `${session.sessionId}:${String(seq)}`), at: isoOf(nowMs + offset), type: "local_turn",
      actor: turn.role === "person" ? { kind: "member", developerId: session.owner.developerId, name: owner } : { kind: "agent" }, source: "mac", text: turnEventText(speaker(turn.role), text),
    }));
  });
  // An end takes the device's entry for the session away, with the end; any other update keeps it from lapsing (and puts it back if it was lost).
  items.push(ended
    ? { Delete: { TableName: deps.tableName, Key: deviceSessionKey(orgId, u.device.deviceId, session.sessionId) } }
    : { Put: { TableName: deps.tableName, Item: { ...deviceSessionKey(orgId, u.device.deviceId, session.sessionId), entityType: "DEVICE_SESSION", orgId, deviceId: u.device.deviceId, sessionId: session.sessionId, createdAt: session.createdAt, [INDEX_EXPIRY_ATTRIBUTE]: expires } } });
  const reply: LocalUpdateReply = { sessionId: session.sessionId, status: input.status, accepted: u.turns.length };
  try {
    await commit(deps, items, (failed) => refusalOf(failed), u.mark, reply);
  } catch (error) {
    if (isTransactionConflict(error)) return "again";
    if ((error as { code?: string }).code === "IDEMPOTENCY_CONFLICT") {
      // The same request committed while this ran: its answer is this one's.
      return (await earlierUpdate(deps, u.mark)) ?? "again";
    }
    const failed = failedIndexes(error);
    if (failed !== undefined && failed.size > 0 && !failed.has(0) && !failed.has(1)) return "again"; // the LOCAL item moved, or a turn is already there: read it again
    if (failed !== undefined && failed.has(1)) await sessionGone(deps, session, u.device.deviceId, developerId);
    throw error;
  }
  return reply;
}

/** What a refused segment means when it is the device or the session that failed its check. */
function refusalOf(failed: Set<number>): Error | undefined {
  if (failed.has(0)) return notFound("device");
  return undefined;
}

/** The session check of a write failed: it ended, or it is no longer this device's. */
async function sessionGone(deps: LocalSessionDependencies, session: AgentSessionRecord, deviceId: string, developerId: string): Promise<never> {
  const now = await new AgentSessionStore(deps).get(session.orgId, session.sessionId);
  if (now !== undefined && now.subject.kind === "local" && now.subject.deviceId === deviceId && now.owner.developerId === developerId && now.endedAt !== undefined) {
    throw agentXError("SESSION_ENDED", "This session has ended.");
  }
  throw notFound("session");
}

// ---- the Mac's commands

/** Where a steer or a stop for a device goes: the device's own partition, in order. */
export interface DeviceCommandInput {
  kind: "steer" | "stop";
  sessionId: string;
  messageId?: string | undefined;
  /** The message's words as the session kept them (already redacted). */
  text?: string | undefined;
  by: { developerId: string; name: string };
}

/**
 * The items that give a device a command, to join the transaction that records the steer or the stop: [0] a check that the device is still its owner's and live, [1] the device's
 * count of commands moving up (conditional on what was read, so two commands never take one place), [2] the command, written only if absent, with an expiry. A caller reads the failed
 * indexes: any of them is a reason to read again and build again. `seq` is the command's number.
 */
export async function deviceCommandItems(
  deps: Pick<TableInput, "documentClient" | "tableName">, target: { orgId: OrgId; deviceId: string; ownerId: string }, command: DeviceCommandInput, nowMs: number,
): Promise<{ items: [TransactItem, TransactItem, TransactItem]; seq: number }> {
  const counterKey = deviceCommandCounterKey(target.orgId, target.deviceId);
  const stored = ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: counterKey, ConsistentRead: true }))) as { Item?: Item }).Item;
  const current = typeof stored?.["seq"] === "number" && Number.isInteger(stored["seq"]) && stored["seq"] >= 0 ? stored["seq"] : 0;
  if (stored !== undefined && stored["seq"] !== current) throw agentXError("RUNTIME_UNAVAILABLE", MAC_NOT_AVAILABLE_MESSAGE);
  const seq = current + 1;
  if (seq > COMMAND_SEQ_MAX) throw agentXError("CONFIG_INVALID", TOO_MANY_COMMANDS);
  const at = isoOf(nowMs);
  return {
    seq,
    items: [
      deviceStillTheirs(deps, target.orgId, target.deviceId, target.ownerId),
      {
        Put: {
          TableName: deps.tableName,
          // No expiry while the device lives: a counter that lapsed would restart below the Mac's cursor and hide new commands. It is given one when the device is removed.
          Item: { ...counterKey, entityType: "DEVICE_COMMAND_COUNTER", orgId: target.orgId, deviceId: target.deviceId, seq },
          ...(stored === undefined ? { ConditionExpression: NOT_EXISTS } : { ConditionExpression: "#seq = :read", ExpressionAttributeNames: { "#seq": "seq" }, ExpressionAttributeValues: { ":read": current } }),
        },
      },
      {
        Put: {
          TableName: deps.tableName, ConditionExpression: NOT_EXISTS,
          Item: {
            ...deviceCommandKey(target.orgId, target.deviceId, seq), entityType: "DEVICE_COMMAND", orgId: target.orgId, deviceId: target.deviceId, seq, kind: command.kind, sessionId: command.sessionId,
            ...(command.messageId === undefined ? {} : { messageId: command.messageId }), ...(command.text === undefined ? {} : { text: command.text }), by: command.by, at,
            [INDEX_EXPIRY_ATTRIBUTE]: secondsOf(nowMs) + DEVICE_COMMAND_KEEP_DAYS * DAY_SECONDS,
          },
        },
      },
    ],
  };
}

/** After the commit: tells the owner's channel there is a command (a device id and a number only). Never throws. */
export async function announceDeviceCommand(deps: Pick<LocalSessionDependencies, "realtimePublish" | "now" | "log">, orgId: OrgId, ownerId: string, deviceId: string, seq: number): Promise<void> {
  try {
    await publishNotices({ realtime: deps.realtimePublish, now: deps.now, log: deps.log }, [{ channel: userChannel(orgId, ownerId), notice: { type: "device.command", deviceId, seq } }]);
  } catch (error) {
    logOf(deps)({ event: "agent_session.device_command_notice_failed", orgId, error: errorName(error) ?? "unknown" });
  }
}

const AFTER = /^[0-9]{1,6}$/;

/**
 * `GET /v1/app/devices/{id}/commands?after=<seq>`: the device's own person reads its commands after `after`, oldest first, at most `DEVICE_COMMANDS_PAGE_MAX`. A command past its
 * time is left out although the table has not deleted it yet. A steer handed over is marked delivered on its message (the device has it); a failure there never fails the poll.
 */
export async function listDeviceCommands(
  deps: DeviceDependencies, caller: Pick<LocalCaller, "orgId" | "developerId">, deviceId: string, afterText: string | undefined,
): Promise<{ commands: DeviceCommandView[]; next: number }> {
  if (afterText !== undefined && !AFTER.test(afterText)) throw agentXError("CONFIG_INVALID", "after: must be a whole number");
  const after = afterText === undefined ? 0 : Number(afterText);
  const device = await ownLiveDevice(deps, caller, deviceId);
  if (after >= COMMAND_SEQ_MAX) return { commands: [], next: after };
  const response = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName, ConsistentRead: true, Limit: DEVICE_COMMANDS_PAGE_MAX, KeyConditionExpression: "pk = :pk AND sk BETWEEN :from AND :to",
    ExpressionAttributeValues: { ":pk": deviceKey(caller.orgId, device.deviceId).pk, ":from": deviceCommandKey(caller.orgId, device.deviceId, after + 1).sk, ":to": deviceCommandKey(caller.orgId, device.deviceId, COMMAND_SEQ_MAX).sk },
  })) as { Items?: Item[] };
  const nowSeconds = secondsOf(deps.now());
  const commands: DeviceCommandView[] = [];
  let next = after;
  for (const item of response.Items ?? []) {
    if (item["orgId"] !== caller.orgId || item["deviceId"] !== device.deviceId) continue;
    const seq = item["seq"];
    if (typeof seq === "number") next = Math.max(next, seq);
    const expires = item[INDEX_EXPIRY_ATTRIBUTE];
    if (typeof expires === "number" && expires <= nowSeconds) continue;
    const by = item["by"] as { name?: unknown } | undefined;
    const view = DeviceCommandViewSchema.safeParse({
      seq: item["seq"], kind: item["kind"], sessionId: item["sessionId"], messageId: item["messageId"], text: item["text"], from: typeof by?.name === "string" ? by.name : undefined, at: item["at"],
    });
    if (!view.success) {
      logOf(deps)({ event: "devices.command_unreadable", orgId: caller.orgId });
      continue;
    }
    commands.push(view.data);
  }
  for (const command of commands) {
    if (command.kind === "steer" && command.messageId !== undefined) await deliverSteerToDevice(deps, caller.orgId, command.sessionId, command.messageId);
  }
  return { commands, next };
}

// ---- a removed Mac

interface Ended { sessions: number; failed: number }

/**
 * Ends the open sessions of a REMOVED device: each is made `cancelled` with "<label> was removed, so this session stopped." (its summary's step and an `ended` event), in one transaction
 * with its `LOCAL` state and the removal of the device's entry for it, and its summary is worked out again. They are found through the device's own entries, and each is confirmed by
 * what the session itself says (`subject.deviceId`, local, open): an entry that names another device's session, another org's or an ended one ends nothing. A device that is not removed
 * ends nothing. Repeatable: the removal route and the member's removal both call it for every device, so a run that stopped part-way is finished by the next. Throws a retryable
 * `RUNTIME_UNAVAILABLE` after the others were tried when a session could not be ended.
 */
export async function endSessionsOfDevice(deps: DeviceDependencies, orgId: OrgId, deviceId: string): Promise<number> {
  const record = await readDevice(deps, orgId, deviceId);
  if (record === undefined || record.revokedAt === undefined) return 0;
  const store = new AgentSessionStore(deps);
  const result: Ended = { sessions: 0, failed: 0 };
  const pk = deviceKey(orgId, record.deviceId).pk;
  // The device's command counter has no expiry while it lives; now that it is removed the counter goes with its record.
  await deps.documentClient.send(new UpdateCommand({
    TableName: deps.tableName, Key: deviceCommandCounterKey(orgId, record.deviceId), UpdateExpression: "SET #expires = :expires", ConditionExpression: "attribute_exists(pk)",
    ExpressionAttributeNames: { "#expires": INDEX_EXPIRY_ATTRIBUTE }, ExpressionAttributeValues: { ":expires": secondsOf(deps.now()) + KEEP_SECONDS },
  })).catch((error: unknown) => {
    if (errorName(error) !== "ConditionalCheckFailedException") throw error;
  });
  let start: Record<string, unknown> | undefined;
  for (let page = 0; page < DEVICE_ENTRY_PAGES_MAX; page += 1) {
    const found = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, ConsistentRead: true, Limit: DEVICE_ENTRY_PAGE, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": pk, ":prefix": "SESSION#" }, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    for (const row of found.Items ?? []) {
      const id = SessionIdSchema.safeParse(row["sessionId"]);
      if (!id.success || row["orgId"] !== orgId || row["deviceId"] !== record.deviceId) continue;
      try {
        const session = await store.get(orgId, id.data);
        if (session === undefined || session.subject.kind !== "local" || session.subject.deviceId !== record.deviceId || session.endedAt !== undefined) continue;
        if (await endLocalSession(deps, session, deviceRemovedMessage(record.label), "device-removed")) result.sessions += 1;
      } catch (error) {
        result.failed += 1;
        logOf(deps)({ event: "devices.end_session_failed", orgId, error: errorName(error) ?? "unknown" });
      }
    }
    start = found.LastEvaluatedKey;
    if (start === undefined) break;
  }
  if (start !== undefined) result.failed += 1; // more entries than one run reads: the next run goes on
  if (result.failed > 0) throw agentXError("RUNTIME_UNAVAILABLE", "That device's sessions could not all be ended. Try again.");
  return result.sessions;
}

/**
 * Ends one open local session `cancelled` with `text` (its summary's step and an `ended` event named by `reason`), in one transaction with its `LOCAL` state and the removal of the device's
 * entry, then works its summary out again. For a removed device and for a closed company. Repeatable: a session already ended by its `LOCAL` state is only refreshed.
 */
export async function endLocalSession(deps: DeviceDependencies, session: AgentSessionRecord, text: string, reason: "device-removed" | "org-closed"): Promise<boolean> {
  const { orgId, sessionId } = session;
  const deviceId = (session.subject as { deviceId: string }).deviceId;
  const nowMs = deps.now();
  const at = isoOf(nowMs);
  const local = await readLocalState(deps, session);
  if (local === undefined || !isEndedStatus(local["status"])) {
    const items: TransactItem[] = [
      {
        ConditionCheck: {
          TableName: deps.tableName, Key: agentSessionKey(orgId, sessionId, "META"),
          ConditionExpression: "attribute_exists(pk) AND orgId = :org AND #subject.#kind = :local AND #subject.#deviceId = :device AND attribute_not_exists(endedAt)",
          ExpressionAttributeNames: { "#subject": "subject", "#kind": "kind", "#deviceId": "deviceId" }, ExpressionAttributeValues: { ":org": orgId, ":local": "local", ":device": deviceId },
        },
      },
      {
        Update: {
          TableName: deps.tableName, Key: agentSessionKey(orgId, sessionId, "LOCAL"),
          UpdateExpression: "SET entityType = :type, orgId = :org, sessionId = :session, deviceId = :device, #status = :cancelled, step = :step, endedAt = :at, updatedAt = :at, costUsd = :zero, turnCount = if_not_exists(turnCount, :zero), #expires = :expires ADD #rev :one",
          ConditionExpression: "attribute_not_exists(pk) OR (#status <> :succeeded AND #status <> :failed AND #status <> :cancelled)",
          ExpressionAttributeNames: { "#status": "status", "#expires": INDEX_EXPIRY_ATTRIBUTE, "#rev": "rev" },
          ExpressionAttributeValues: {
            ":type": "AGENT_SESSION_LOCAL", ":org": orgId, ":session": sessionId, ":device": deviceId, ":cancelled": "cancelled", ":step": text, ":at": at, ":zero": 0, ":one": 1,
            ":expires": secondsOf(nowMs) + KEEP_SECONDS, ":succeeded": "succeeded", ":failed": "failed",
          },
        },
      },
      sessionEventItem(deps, { orgId, sessionId }, { eventId: sessionEventId("ended", `${sessionId}:${reason}`), at, type: "ended", actor: { kind: "system" }, text }),
      { Delete: { TableName: deps.tableName, Key: deviceSessionKey(orgId, deviceId, sessionId) } },
    ];
    try {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
    } catch (error) {
      // The session ended (or moved) while this ran: what it says now is the answer; anything else is for the caller.
      if (failedIndexes(error) === undefined) throw error;
      const now = await new AgentSessionStore(deps).get(orgId, sessionId);
      if (now !== undefined && now.subject.kind === "local" && now.endedAt === undefined && !isEndedStatus((await readLocalState(deps, session))?.["status"])) throw error;
    }
  }
  await refreshQuietly(deps, orgId, sessionId);
  return true;
}
