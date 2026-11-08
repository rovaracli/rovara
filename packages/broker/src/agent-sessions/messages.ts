// Comments on a session (Plan 5 Task 10) and messages to the agent (Task 11a, `steer.ts`). A comment is a `MESSAGE#<messageId>` item on the session's partition. Sending one is a single transaction: the person's rate item for the
// window, the session's message count, the message, a check that the session is still there, the request item (R18) and a `comment` event, the event last (Task 6's contract).
//
// Comments are for people only. They need `view` and not a project viewer's role, they never reach the agent or the task (a message to the agent is `kind: "steer"`: it needs "can use", has its own rate, and is delivered by `steer.ts`),
// and nothing in one can notify anybody: Slack's mention markup is made plain on the way in, and the only notice a comment makes is `session.updated` on the session's own channel (ids
// only), which people who can't view the session can't subscribe to. The text is cleaned and redacted first and cut to the limit after, so a secret is never cut in half and left;
// neither the event nor the request item nor any log holds any of it, so editing or deleting a comment leaves no copy behind.
//
// `GET …/messages` is one conversation over two stores (I11): this session's comments and, for a task session, the task page's comments read through (`source: "page"`; they are
// edited on the page). A message's id sorts by the time it was written, so both stores read in one order, and a cursor read repeats the seconds before the cursor to catch one that
// committed late.
import { replacementNames, shownNameOf } from "../developer/name-resolver.js";
import { createHash } from "node:crypto";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import {
  COMMENT_RATE,
  INDEX_EXPIRY_ATTRIBUTE,
  SESSION_MESSAGES_MAX,
  SESSION_MESSAGES_PAGE_MAX,
  STEER_RATE,
  SESSION_ENDED_MESSAGE,
  SESSION_ANCHOR_EXCERPT_MAX,
  SESSION_ANCHOR_TARGETS,
  SESSION_MESSAGE_MAX_CHARS,
  SESSION_RETENTION_DAYS,
  SESSION_REVISION_CONFLICT_MESSAGE,
  SessionAnchorInputSchema,
  SessionAnchorSchema,
  SessionMessageIdSchema,
  SessionMessageSchema,
  agentSessionKey,
  agentXError,
  cleanCommentText,
  cleanSessionName,
  sessionChannel,
  sessionEventId,
  sessionRateKey,
  sessionRequestKey,
  type AgentSessionRecord,
  type OrgId,
  type SessionAnchorInput,
  type SessionAnchorRef,
  type SessionMessage,
  type SessionMessagePage,
} from "@agentx/contracts";
import { failedIndexes, isTransactionConflict, type Item, type TransactItem } from "../agents/table-writes.js";
import { listTaskComments } from "../developer/page-comments.js";
import { sessionNoteItems } from "../aws/developer-tasks.js";
import { taskKey } from "../developer/task-records.js";
import { publishNotices, type RealtimeConfig } from "../realtime/publish.js";
import { anchorKey, anchorTargetsFor, anchoredOn, presentMessages, withoutExcerpt, type AnchorDependencies } from "./anchors.js";
import { requireSessionLevel, type SessionAccessDependencies, type SessionCaller } from "./access.js";
import { announceDeviceCommand, deviceCommandItems } from "../devices/local-sessions.js";
import { planSteer, queuedSteersItem, steerNotDeliveredEvent, type SteerDependencies } from "./steer.js";
import { enqueueLiveSteer } from "./live-steer.js";
import { safeDisplayName } from "../developer/person-name.js";
import { AgentSessionStore, sessionEventItem } from "./store.js";

export interface SessionMessageDependencies extends SessionAccessDependencies, Pick<SteerDependencies, "chainSteer">, Pick<AnchorDependencies, "taskView"> {
  /** Live steer: with the broker's signing key, a message to a task whose step is running is also given to that step's session within seconds (`live-steer.ts`). Without it every message is a note only. */
  liveSteer?: { callbackSigningKey: string } | undefined;
  /** The events API a comment's `session.updated` notice is posted to; without it nothing is posted. */
  realtimePublish?: RealtimeConfig | undefined;
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

/** Who writes: `DeveloperCaller` fits. */
export interface MessageCaller extends SessionCaller { name: string }

// ---- the words a refusal says (the page's, where the page has the same refusal)

const EMPTY_TEXT = "Write something first.";
const TOO_LONG_TEXT = "Keep comments under 2,000 characters.";
const RATE_TEXT = "You've posted a lot in the last 10 minutes. Try again in a few minutes.";
const TOO_MANY_TEXT = "This session has the most comments it can hold.";
const NOT_YOURS_TEXT = "Only the person who wrote a comment can change it.";
const GONE_TEXT = "This comment was deleted.";
const SENT_TEXT = "The agent has this message, so it can't be changed.";
const TOO_LONG_STEER_TEXT = "Keep messages to the agent under 2,000 characters.";
const PERSON_STEER_RATE_TEXT = `You've sent ${String(STEER_RATE.perPersonPerHour)} messages to this agent in the last hour. Try again later.`;
const SESSION_STEER_RATE_TEXT = "This agent has had a lot of messages in the last hour. Try again later.";
const BUSY_TEXT = "This session is busy right now. Try again in a moment.";
/** What a deleted comment's text is: the original is gone, and a message always holds some text. */
export const DELETED_TEXT = "[deleted]";

const REQUEST_MEMORY_DAYS = 7;
const DAY_SECONDS = 86_400;
/** How many times a write is tried while it only loses to another transaction on the same items. */
const ATTEMPTS = 4;
const STEER_WINDOW_MS = 3_600_000;
/** A cursor read repeats the messages from this long before the cursor, up to `REREAD_MAX` of them. */
const REREAD_MS = 5_000;
const REREAD_MAX = 100;
/** Items one read looks at in the session's own store (the most a session can hold, and some room). */
const SCAN_MAX = SESSION_MESSAGES_MAX + 50;
const ID_TIME_WIDTH = 9;
const MESSAGE_PREFIX = "MESSAGE#msg_";
const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)#(msg_[0-9a-z]{20})$/;
const HOUSEKEEPING = new Set(["pk", "sk", "entityType", "orgId", INDEX_EXPIRY_ATTRIBUTE]);
/** Slack's markup for a person, a channel, `@here` and a group: `<@U123>`, `<#C123|name>`, `<!channel>`, `<!subteam^S1|team>`. */
const SLACK_MARKUP = /<([@!#])([^<>\n]{0,200})>/gu;

const getItem = async (deps: Pick<SessionAccessDependencies, "documentClient" | "tableName">, key: { pk: string; sk: string }): Promise<Item | undefined> =>
  ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Item }).Item;

const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const secondsOf = (ms: number) => Math.floor(ms / 1000);
const isoOf = (ms: number) => new Date(ms).toISOString();

// ---- request bodies

const RequestIdSchema = z.string().uuid();
const TextSchema = z.string().max(10_000);
export const SendBodySchema = z.object({ requestId: RequestIdSchema, kind: z.enum(["comment", "steer"]), text: TextSchema, anchor: SessionAnchorInputSchema.optional(), threadId: SessionMessageIdSchema.optional() }).strict();
export const EditBodySchema = z.object({ rev: z.number().int().min(1), text: TextSchema }).strict();
export const DeleteBodySchema = z.object({ rev: z.number().int().min(1) }).strict();

/** The body as the schema reads it, or `CONFIG_INVALID` naming the field and never echoing what was sent. */
export function parseMessageBody<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const path = issue === undefined || issue.path.length === 0 ? "body" : issue.path.join(".");
  throw agentXError("CONFIG_INVALID", `${path}: ${issue === undefined || issue.code === "unrecognized_keys" ? "has a field this route does not take" : issue.message}`);
}

// ---- text

/** Slack's mention markup made plain (`<@U123>` reads `[@U123]`), so the text can't ping or name anyone wherever it is shown. */
export const plainMentions = (text: string): string => text.replace(SLACK_MARKUP, "[$1$2]");

/**
 * The text with its control and format characters taken out (zero-width spaces and joiners, soft hyphens, direction marks), except the line breaks and tabs the text keeps. This comes BEFORE
 * redaction: a secret split by an invisible character is one secret to whoever copies the text, and the redactor must see it whole.
 */
export const withoutInvisible = (raw: string): string => raw.replace(/(?![\t\n\r])[\p{Cc}\p{Cf}]/gu, "");

/** A comment's text as it is stored: cleaned and redacted (the page's rules), mentions made plain, and only then cut to the limit by characters. */
export function storedText(raw: string, tooLong: string = TOO_LONG_TEXT): string {
  const cleaned = cleanCommentText(withoutInvisible(raw));
  if (!cleaned.ok) throw agentXError("CONFIG_INVALID", cleaned.reason === "empty" ? EMPTY_TEXT : tooLong);
  return [...plainMentions(cleaned.text)].slice(0, SESSION_MESSAGE_MAX_CHARS).join("");
}

/** The part of the session was not found, or the writer can't see it. Names nothing the client sent. */
const PART_NOT_FOUND_TEXT = "that part of the session was not found";
const PART_UNAVAILABLE_TEXT = "That part of the session can't be checked right now.";

/**
 * What an anchor's excerpt is when stored: cleaned and redacted like a comment, mentions made plain, flattened to one line with no control or format characters, and only then cut to the limit.
 * Undefined when nothing is left. The client's excerpt is for display only: nothing decides on it.
 */
function storedExcerpt(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const cleaned = cleanCommentText(withoutInvisible(raw));
  if (!cleaned.ok) return undefined;
  const line = plainMentions(cleaned.text).replace(/\s+/gu, " ").replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  const cut = [...line].slice(0, SESSION_ANCHOR_EXCERPT_MAX).join("").trim();
  return cut === "" ? undefined : cut;
}

/** `<target>:<targetId>`, the spelling `?anchor=` takes: the target is one of the known parts, the id is anything that is a valid id (a colon may be in it). `CONFIG_INVALID`, echoing nothing, otherwise. */
export function parseAnchorQuery(raw: string): Pick<SessionAnchorRef, "target" | "targetId"> {
  const separator = raw.indexOf(":");
  const parsed = separator < 0 ? undefined : SessionAnchorInputSchema.pick({ target: true, targetId: true }).safeParse({ target: raw.slice(0, separator), targetId: raw.slice(separator + 1) });
  if (parsed === undefined || !parsed.success) throw agentXError("CONFIG_INVALID", `anchor: must be <${SESSION_ANCHOR_TARGETS.join("|")}>:<id>`);
  return parsed.data;
}

// ---- ids

/** `msg_` and 20 characters: nine of the time (base 36, so ids sort by time) and eleven from the writer and their request, so a retry of one request is the same id. */
export function newMessageId(nowMs: number, developerId: string, requestId: string): string {
  const time = nowMs.toString(36).padStart(ID_TIME_WIDTH, "0");
  return `msg_${time}${createHash("sha256").update(`${developerId}\n${requestId}`, "utf8").digest("hex").slice(0, 20 - ID_TIME_WIDTH)}`;
}

/** The id a task page comment has in a session's list: the same every read. */
const pageMessageId = (commentId: string): string => `msg_${createHash("sha256").update(`page-comment\0${commentId}`, "utf8").digest("hex").slice(0, 20)}`;

export const messageKey = (session: { orgId: OrgId; sessionId: string }, messageId: string) => agentSessionKey(session.orgId, session.sessionId, `MESSAGE#${messageId}`);
export const countKey = (session: { orgId: OrgId; sessionId: string }) => agentSessionKey(session.orgId, session.sessionId, "MESSAGE#COUNT");

function messageOf(item: Item | undefined, session: { orgId: OrgId; sessionId: string }, nowSeconds: number): SessionMessage | undefined {
  if (item === undefined || item["orgId"] !== session.orgId || item["sessionId"] !== session.sessionId) return undefined;
  const expires = item[INDEX_EXPIRY_ATTRIBUTE];
  if (typeof expires === "number" && expires <= nowSeconds) return undefined; // the table hasn't deleted it yet
  const parsed = SessionMessageSchema.safeParse(Object.fromEntries(Object.entries(item).filter(([key]) => !HOUSEKEEPING.has(key))));
  if (!parsed.success) return undefined;
  // Release 0.4.16: an author stored under their email reads under the placeholder.
  const name = safeDisplayName(parsed.data.author.name, parsed.data.author.developerId);
  return name === parsed.data.author.name ? parsed.data : { ...parsed.data, author: { ...parsed.data.author, name } };
}

// ---- the rate of writing

export interface RateStep { room: boolean; item: TransactItem }

/**
 * One person's count of comments (or of changes to them) on one session in the current ten-minute window (or of messages to the agent in the current hour), as a step of the write's own transaction: the new count is set from the count
 * that was read, and the step is conditional on it, so two writes can't both take the last place. `room` is false when the window is full.
 */
export async function rateStep(deps: SessionMessageDependencies, session: AgentSessionRecord, developerId: string, kind: "comment" | "change" | "steer" | "steer_all", limit: number, nowMs: number, windowMs: number = COMMENT_RATE.windowMs): Promise<RateStep> {
  const key = sessionRateKey(session.orgId, session.sessionId, developerId, kind);
  const stored = await getItem(deps, key);
  const window = Math.floor(nowMs / windowMs) * windowMs;
  const seenWindow = stored?.["windowStart"];
  const seenCount = stored?.["count"];
  if (stored !== undefined && (typeof seenWindow !== "number" || typeof seenCount !== "number")) throw agentXError("RUNTIME_UNAVAILABLE", BUSY_TEXT);
  const count = typeof seenWindow === "number" && seenWindow === window && typeof seenCount === "number" ? seenCount : 0;
  return {
    room: count < limit,
    item: {
      Update: {
        TableName: deps.tableName, Key: key,
        UpdateExpression: "SET entityType = :type, orgId = :org, sessionId = :session, windowStart = :window, #count = :next, #expires = :expires",
        ConditionExpression: stored === undefined ? "attribute_not_exists(pk)" : "windowStart = :seenWindow AND #count = :seenCount",
        ExpressionAttributeNames: { "#count": "count", "#expires": INDEX_EXPIRY_ATTRIBUTE },
        ExpressionAttributeValues: {
          ":type": "SESSION_RATE", ":org": session.orgId, ":session": session.sessionId, ":window": window, ":next": count + 1, ":expires": secondsOf(window + 2 * windowMs),
          ...(stored === undefined ? {} : { ":seenWindow": seenWindow, ":seenCount": seenCount }),
        },
      },
    },
  };
}

/** The check that the session is still there, so nothing is written into one that was removed since it was read; `open` also needs it not to have ended (a message to the agent is never queued into an ended session). */
export const sessionStillThere = (deps: SessionMessageDependencies, session: AgentSessionRecord, open = false): TransactItem => ({
  ConditionCheck: { TableName: deps.tableName, Key: agentSessionKey(session.orgId, session.sessionId, "META"), ConditionExpression: open ? "attribute_exists(pk) AND attribute_not_exists(endedAt)" : "attribute_exists(pk)" },
});

/** Tells the session's own channel that it changed: ids only, never the feed of anyone (a comment is not something to catch up on). Never throws. */
async function tellSession(deps: SessionMessageDependencies, session: AgentSessionRecord): Promise<void> {
  await publishNotices({ realtime: deps.realtimePublish, now: deps.now, log: deps.log }, [
    { channel: sessionChannel(session.orgId, session.sessionId), notice: { type: "session.updated", sessionId: session.sessionId, revision: session.summaryRevision } },
  ]);
}

// ---- sending

const REQUEST_ITEM = (deps: SessionMessageDependencies, session: AgentSessionRecord, developerId: string, requestId: string, fingerprint: string, messageId: string, nowMs: number): TransactItem => ({
  Put: {
    TableName: deps.tableName,
    Item: {
      ...sessionRequestKey(session.orgId, developerId, requestId), entityType: "SESSION_REQUEST", orgId: session.orgId, fingerprint, result: { messageId }, at: isoOf(nowMs),
      [INDEX_EXPIRY_ATTRIBUTE]: secondsOf(nowMs) + REQUEST_MEMORY_DAYS * DAY_SECONDS,
    },
    ConditionExpression: "attribute_not_exists(pk) OR #expires <= :now",
    ExpressionAttributeNames: { "#expires": INDEX_EXPIRY_ATTRIBUTE },
    ExpressionAttributeValues: { ":now": secondsOf(nowMs) },
  },
});

/** What an earlier request of the same id did: its message as it is now (never as it was written, so a deleted comment's text is not brought back), or undefined when there was none. */
async function replayOf(deps: SessionMessageDependencies, session: AgentSessionRecord, developerId: string, requestId: string, fingerprint: string): Promise<SessionMessage | undefined> {
  const item = await getItem(deps, sessionRequestKey(session.orgId, developerId, requestId));
  const expires = item?.[INDEX_EXPIRY_ATTRIBUTE];
  if (item === undefined || (typeof expires === "number" && expires <= secondsOf(deps.now()))) return undefined;
  if (item["fingerprint"] !== fingerprint) throw agentXError("IDEMPOTENCY_CONFLICT", "this request ID was already used for a different request");
  const messageId = (item["result"] as { messageId?: unknown } | undefined)?.messageId;
  const message = typeof messageId === "string" ? messageOf(await getItem(deps, messageKey(session, messageId)), session, secondsOf(deps.now())) : undefined;
  if (message === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "This comment can't be read right now.");
  return message;
}

/**
 * Sends a comment on a session [view, and not a project viewer], or (`kind: "steer"`) a message to the agent [use, and not a project viewer; see `steer.ts`]. `requestId` names the request: the
 * same one again answers the same message and writes nothing (a message to the agent is written with its note and its fate in one transaction, so there is nothing left to finish), and with other words it is `IDEMPOTENCY_CONFLICT`.
 * At most `COMMENT_RATE.comments` comments per person and session in ten minutes, `STEER_RATE` messages to the agent per person and per session in an hour (`TOO_MANY_REQUESTS`), and at
 * most `SESSION_MESSAGES_MAX` of both on a session; an ended session takes comments but not messages to the agent (`SESSION_ENDED`). A paused or stopped task queues a message to the agent, which its next step reads when it resumes.
 */
export async function sendSessionMessage(
  deps: SessionMessageDependencies,
  caller: MessageCaller,
  sessionId: string,
  input: { requestId: string; kind: "comment" | "steer"; text: string; source?: "app" | "linear" | "page" | "slack"; anchor?: unknown; threadId?: unknown },
): Promise<SessionMessage> {
  if (!RequestIdSchema.safeParse(input.requestId).success) throw agentXError("CONFIG_INVALID", "requestId: must be a UUID");
  const steer = input.kind === "steer";
  // A comment is written in the app; a message to the agent in the app or by Linear (the page's comments are read through, and Slack's replies come by their own path).
  if (input.source !== undefined && input.source !== "app" && !(steer && input.source === "linear")) throw agentXError("CONFIG_INVALID", steer ? "source: a message to the agent is sent from the app or Linear" : "source: a comment is written in the app");
  const source: "app" | "linear" = input.source === "linear" ? "linear" : "app";
  // A comment can be pinned to a part of the session (`anchor`) or answer a thread (`threadId`, which takes the thread's anchor); a message to the agent can do neither.
  if (steer && (input.anchor !== undefined || input.threadId !== undefined)) throw agentXError("CONFIG_INVALID", "anchor: a message to the agent can't be pinned or threaded");
  if (input.anchor !== undefined && input.threadId !== undefined) throw agentXError("CONFIG_INVALID", "anchor: a reply takes the anchor of its thread");
  const anchorInput: SessionAnchorInput | undefined = input.anchor === undefined ? undefined : parseMessageBody(z.object({ anchor: SessionAnchorInputSchema }).strict(), { anchor: input.anchor }).anchor;
  const threadId: string | undefined = input.threadId === undefined ? undefined : parseMessageBody(z.object({ threadId: SessionMessageIdSchema }).strict(), { threadId: input.threadId }).threadId;
  const access = steer
    ? await requireSessionLevel(deps, caller, sessionId, "use", "send messages to the agent")
    : await requireSessionLevel(deps, caller, sessionId, "view", "comment on it", { comment: true });
  const { session } = access;
  const fingerprint = sha256(steer
    ? { op: "steer", sessionId: session.sessionId, source, text: input.text }
    : { op: "comment", sessionId: session.sessionId, text: input.text, ...(anchorInput === undefined ? {} : { anchor: anchorInput }), ...(threadId === undefined ? {} : { threadId }) });
  const earlier = await replayOf(deps, session, caller.developerId, input.requestId, fingerprint);
  if (earlier !== undefined) return (await presentMessages(deps, session, access, [earlier]))[0]!;

  // Where a comment is pinned: its part, found in the view built for the writer (a part they can't see is not found); or its thread's anchor, which a reply takes as it is now (without the excerpt).
  let anchor: SessionMessage["anchor"];
  let targets: SessionAnchorRef[] | undefined;
  if (anchorInput !== undefined) {
    targets = await anchorTargetsFor(deps, session, access);
    if (targets === undefined) throw agentXError("RUNTIME_UNAVAILABLE", PART_UNAVAILABLE_TEXT);
    if (!targets.some((part) => anchorKey(part) === anchorKey(anchorInput))) throw agentXError("NOT_FOUND", PART_NOT_FOUND_TEXT);
    const excerpt = storedExcerpt(anchorInput.excerpt);
    anchor = SessionAnchorSchema.parse({ target: anchorInput.target, targetId: anchorInput.targetId, revision: anchorInput.revision, ...(excerpt === undefined ? {} : { excerpt }) });
  } else if (threadId !== undefined) {
    const root = messageOf(await getItem(deps, messageKey(session, threadId)), session, secondsOf(deps.now()));
    if (root === undefined || root.kind !== "comment" || root.threadId !== undefined || root.deletedAt !== undefined) throw agentXError("NOT_FOUND", "message not found");
    if (root.anchor !== undefined) anchor = withoutExcerpt(root.anchor);
  }

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    // Where a message to the agent goes is read again on every try, so a task that closed, filled up or moved its mark since is seen (a refusal leaves nothing written).
    const plan = steer ? await planSteer(deps, session) : undefined;
    const text = storedText(input.text, steer ? TOO_LONG_STEER_TEXT : TOO_LONG_TEXT);
    const nowMs = deps.now();
    const rate = steer ? await rateStep(deps, session, caller.developerId, "steer", STEER_RATE.perPersonPerHour, nowMs, STEER_WINDOW_MS) : await rateStep(deps, session, caller.developerId, "comment", COMMENT_RATE.comments, nowMs);
    if (!rate.room) throw agentXError("TOO_MANY_REQUESTS", steer ? PERSON_STEER_RATE_TEXT : RATE_TEXT);
    const everyone = steer ? await rateStep(deps, session, "session", "steer_all", STEER_RATE.perSessionPerHour, nowMs, STEER_WINDOW_MS) : undefined;
    if (everyone !== undefined && !everyone.room) throw agentXError("TOO_MANY_REQUESTS", SESSION_STEER_RATE_TEXT);
    const name = cleanSessionName(caller.name) ?? "Someone";
    const message = SessionMessageSchema.parse({
      messageId: newMessageId(nowMs, caller.developerId, input.requestId), sessionId: session.sessionId, kind: input.kind, source, author: { developerId: caller.developerId, name }, text, createdAt: isoOf(nowMs), rev: 1,
      ...(anchor === undefined ? {} : { anchor }), ...(threadId === undefined ? {} : { threadId }),
      ...(plan === undefined ? {} : { delivery: plan.kind === "note" || plan.kind === "device" ? { state: "queued", at: isoOf(nowMs) } : { state: "not_delivered", at: isoOf(nowMs), reason: plan.reason } }),
    });
    const events = [sessionEventItem(deps, session, steer
      ? { eventId: sessionEventId("steer", message.messageId), at: message.createdAt, type: "steer", actor: { kind: "member", developerId: caller.developerId, name }, source, messageId: message.messageId, text: `${name} sent ${session.agent?.name ?? "the agent"} a message.` }
      : { eventId: sessionEventId("comment", message.messageId), at: message.createdAt, type: "comment", actor: { kind: "member", developerId: caller.developerId, name }, source: "app", messageId: message.messageId, text: `${name} commented.` }),
      // A message that can't be given to the agent says so, in the same transaction.
      ...(plan?.kind === "not_delivered" ? [steerNotDeliveredEvent(deps, session, message, plan.reason)] : []),
    ];
    // Where each item sits, for reading a cancellation by position; the event is always last.
    const base: TransactItem[] = [];
    const place = (item: TransactItem) => base.push(item) - 1;
    const RATE = place(rate.item);
    const EVERYONE = everyone === undefined ? -1 : place(everyone.item);
    const COUNT = place({
      Update: {
        TableName: deps.tableName, Key: countKey(session),
        UpdateExpression: "SET entityType = :type, orgId = :org, sessionId = :session, #expires = :expires ADD #count :one",
        ConditionExpression: "attribute_not_exists(#count) OR #count < :max",
        ExpressionAttributeNames: { "#count": "count", "#expires": INDEX_EXPIRY_ATTRIBUTE },
        ExpressionAttributeValues: { ":type": "AGENT_SESSION_MESSAGE_COUNT", ":org": session.orgId, ":session": session.sessionId, ":one": 1, ":max": SESSION_MESSAGES_MAX, ":expires": secondsOf(nowMs) + SESSION_RETENTION_DAYS * DAY_SECONDS },
      },
    });
    const MESSAGE = place({
      Put: {
        TableName: deps.tableName,
        Item: { ...messageKey(session, message.messageId), entityType: "AGENT_SESSION_MESSAGE", orgId: session.orgId, ...message, [INDEX_EXPIRY_ATTRIBUTE]: secondsOf(nowMs) + SESSION_RETENTION_DAYS * DAY_SECONDS },
        ConditionExpression: "attribute_not_exists(pk)",
      },
    });
    const SESSION = place(sessionStillThere(deps, session, steer));
    const REQUEST = place(REQUEST_ITEM(deps, session, caller.developerId, input.requestId, fingerprint, message.messageId, nowMs));
    // A message the task takes is written with its note, the task's count and the session's queue count, so it is never left queued without its note.
    let noteItems: number[] = [];
    if (plan?.kind === "note") {
      const note = sessionNoteItems(deps, plan.task, { taskId: plan.task.taskId, source, developerId: caller.developerId, name, isOwner: access.owner, sessionId: session.sessionId, messageId: message.messageId, text });
      if (note.outcome === "refused") continue; // the plan read the task a moment ago: read it again
      noteItems = [place(note.items[0]), place(note.items[1]), place(queuedSteersItem(deps, session, 1, nowMs))];
    }
    // A message to a session on a Mac is a command for its device (Task 18), written with the message, the queue's count and the device's own count of commands.
    let deviceSeq: number | undefined;
    if (plan?.kind === "device") {
      const command = await deviceCommandItems(deps, { orgId: session.orgId, deviceId: plan.deviceId, ownerId: session.owner.developerId }, {
        kind: "steer", sessionId: session.sessionId, messageId: message.messageId, text, by: { developerId: caller.developerId, name },
      }, nowMs);
      deviceSeq = command.seq;
      noteItems = [...command.items.map((item) => place(item)), place(queuedSteersItem(deps, session, 1, nowMs))];
    }
    const EVENT = base.length;
    try {
      try {
        await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [...base, ...events] }));
      } catch (error) {
        // An event is never a reason for a message to fail: when only events refuse (they are recorded already), the rest is written without them.
        const failed = failedIndexes(error);
        if (failed === undefined || failed.size === 0 || [...failed].some((index) => index < EVENT)) throw error;
        await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [...base, ...events.filter((_, index) => !failed.has(EVENT + index))] }));
      }
    } catch (error) {
      if (isTransactionConflict(error)) {
        continue; // the loop's own end is the bound
      }
      const failed = failedIndexes(error);
      if (failed === undefined) throw error;
      // This very request committed already (a retry that crossed its own first try): its message is the answer.
      if (failed.has(REQUEST)) {
        const again = await replayOf(deps, session, caller.developerId, input.requestId, fingerprint);
        if (again !== undefined) return (await presentMessages(deps, session, access, [again]))[0]!;
      }
      if (failed.has(SESSION)) {
        // A message to the agent finds out whether the session ended or is gone.
        if (steer && (await new AgentSessionStore(deps).get(session.orgId, session.sessionId))?.endedAt !== undefined) throw agentXError("SESSION_ENDED", SESSION_ENDED_MESSAGE);
        throw agentXError("NOT_FOUND", "session not found");
      }
      if (failed.has(COUNT)) throw agentXError("CONFIG_INVALID", TOO_MANY_TEXT);
      // The task changed since it was read (it closed, filled up, lost its workflow or a step moved its mark): read it again and build again.
      if (noteItems.some((index) => failed.has(index))) continue;
      // Another request of this person (or, for a message to the agent, of anyone on the session) took a place since the count was read: read it again.
      if (failed.has(RATE) || failed.has(EVERYONE)) continue;
      if (failed.has(MESSAGE)) throw agentXError("RUNTIME_UNAVAILABLE", BUSY_TEXT);
      throw error;
    }
    await tellSession(deps, session);
    // The note is saved; a message to a task whose step is running goes to that step's session as well (never throws; the note is the fallback).
    if (plan?.kind === "note" && deps.liveSteer !== undefined) await enqueueLiveSteer({ ...deps, ...deps.liveSteer }, session, message, plan.task, access.owner);
    if (plan?.kind === "device" && deviceSeq !== undefined) await announceDeviceCommand(deps, session.orgId, session.owner.developerId, plan.deviceId, deviceSeq);
    // A pinned comment answers with its state: the part was read for this write, so it is not read again.
    return (await presentMessages(deps, session, access, [message], anchorInput === undefined ? undefined : targets))[0]!;
  }
  throw agentXError("RUNTIME_UNAVAILABLE", BUSY_TEXT);
}

// ---- changing

type Change = { kind: "edit"; rev: number; text: string } | { kind: "delete"; rev: number };

async function changeMessage(deps: SessionMessageDependencies, caller: MessageCaller, sessionId: string, messageId: string, change: Change): Promise<SessionMessage> {
  // Taking a comment back needs only the right to see the session; rewriting one needs the right to write one.
  const access = await requireSessionLevel(deps, caller, sessionId, "view", "change comments", change.kind === "edit" ? { comment: true } : {});
  const { session } = access;
  if (!SessionMessageIdSchema.safeParse(messageId).success) throw agentXError("NOT_FOUND", "message not found");
  const nowMs = deps.now();
  const text = change.kind === "edit" ? storedText(change.text) : DELETED_TEXT;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const current = messageOf(await getItem(deps, messageKey(session, messageId)), session, secondsOf(nowMs));
    if (current === undefined) throw agentXError("NOT_FOUND", "message not found");
    if (current.author.developerId !== caller.developerId) throw agentXError("FORBIDDEN", NOT_YOURS_TEXT);
    if (current.deletedAt !== undefined) throw agentXError("IDEMPOTENCY_CONFLICT", GONE_TEXT);
    if (current.kind === "steer") {
      // The agent reads this one: it can only be looked at by someone who may still send such messages, and once sent its text is the task's note, so it can't be changed or taken back.
      if (change.kind === "edit") await requireSessionLevel(deps, caller, sessionId, "use", "change messages to the agent");
      throw agentXError("CONFIG_INVALID", SENT_TEXT);
    }
    if (current.rev !== change.rev) throw agentXError("SESSION_REVISION_CONFLICT", SESSION_REVISION_CONFLICT_MESSAGE);
    const rate = await rateStep(deps, session, caller.developerId, "change", COMMENT_RATE.changes, nowMs);
    if (!rate.room) throw agentXError("TOO_MANY_REQUESTS", RATE_TEXT);
    const at = isoOf(nowMs);
    // A deleted comment keeps no copy of what it quoted: its anchor loses the excerpt, in the store too.
    const anchor = change.kind === "delete" && current.anchor !== undefined ? withoutExcerpt(current.anchor) : current.anchor;
    const next: SessionMessage = SessionMessageSchema.parse({ ...current, text, rev: current.rev + 1, ...(anchor === undefined ? {} : { anchor }), ...(change.kind === "edit" ? { editedAt: at } : { deletedAt: at }) });
    const RATE = 0, MESSAGE = 1, SESSION = 2;
    try {
      await deps.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          rate.item,
          {
            Update: {
              TableName: deps.tableName, Key: messageKey(session, messageId),
              UpdateExpression: `SET #text = :text, rev = :next, ${change.kind === "edit" ? "editedAt" : "deletedAt"} = :at${change.kind === "delete" && anchor !== undefined ? ", anchor = :anchor" : ""}`,
              ConditionExpression: "attribute_exists(pk) AND rev = :rev",
              ExpressionAttributeNames: { "#text": "text" },
              ExpressionAttributeValues: { ":text": text, ":next": next.rev, ":at": at, ":rev": current.rev, ...(change.kind === "delete" && anchor !== undefined ? { ":anchor": anchor } : {}) },
            },
          },
          sessionStillThere(deps, session),
        ],
      }));
    } catch (error) {
      if (isTransactionConflict(error)) {
        continue; // the loop's own end is the bound
      }
      const failed = failedIndexes(error);
      if (failed === undefined) throw error;
      if (failed.has(SESSION)) throw agentXError("NOT_FOUND", "session not found");
      // The message moved since it was read (another change): read it again and say which.
      if (failed.has(MESSAGE) || failed.has(RATE)) continue;
      throw agentXError("RUNTIME_UNAVAILABLE", BUSY_TEXT);
    }
    await tellSession(deps, session);
    return (await presentMessages(deps, session, access, [next]))[0]!;
  }
  throw agentXError("RUNTIME_UNAVAILABLE", BUSY_TEXT);
}

/** `PATCH …/messages/{messageId}` `{ rev, text }`: the author changes their own comment, at the revision they saw. Not once the agent has the message. */
export function editSessionMessage(deps: SessionMessageDependencies, caller: MessageCaller, sessionId: string, messageId: string, input: { rev: number; text: string }): Promise<SessionMessage> {
  return changeMessage(deps, caller, sessionId, messageId, { kind: "edit", rev: input.rev, text: input.text });
}

/** `DELETE …/messages/{messageId}` `{ rev }`: the author takes their comment back; its text is replaced by `DELETED_TEXT` and the message stays in its place. */
export function deleteSessionMessage(deps: SessionMessageDependencies, caller: MessageCaller, sessionId: string, messageId: string, input: { rev: number }): Promise<SessionMessage> {
  return changeMessage(deps, caller, sessionId, messageId, { kind: "delete", rev: input.rev });
}

// ---- reading

interface Positioned { key: string; message: SessionMessage }
const positioned = (message: SessionMessage): Positioned => ({ key: `${message.createdAt}#${message.messageId}`, message });

function parseCursor(after: string | undefined): { at: string; ms: number; key: string } | undefined {
  if (after === undefined) return undefined;
  const bad = () => agentXError("CONFIG_INVALID", "after: is not a cursor this list gave");
  const match = CURSOR.exec(after);
  if (match === null) throw bad();
  const ms = Date.parse(match[1]!);
  if (Number.isNaN(ms) || isoOf(ms) !== match[1]) throw bad();
  return { at: match[1], ms, key: after };
}

/** This session's own comments from the time `fromMs` on (all of them when undefined). */
async function ownMessages(deps: SessionMessageDependencies, session: AgentSessionRecord, fromMs: number | undefined): Promise<SessionMessage[]> {
  const pk = agentSessionKey(session.orgId, session.sessionId, "META").pk;
  const low = `${MESSAGE_PREFIX}${fromMs === undefined ? "" : Math.max(0, fromMs).toString(36).padStart(ID_TIME_WIDTH, "0")}`;
  const found: SessionMessage[] = [];
  const nowSeconds = secondsOf(deps.now());
  let scanned = 0;
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND sk BETWEEN :low AND :high", ConsistentRead: true,
      ExpressionAttributeValues: { ":pk": pk, ":low": low, ":high": `${MESSAGE_PREFIX}~` }, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      scanned += 1;
      const message = messageOf(item, session, nowSeconds);
      if (message !== undefined) found.push(message);
    }
    start = page.LastEvaluatedKey;
  } while (start !== undefined && scanned < SCAN_MAX);
  return found;
}

/** The task page's comments as session messages: people's, not deleted, mentions made plain, each with the same id on every read. Nothing for a session with no task of its own org. */
async function pageMessages(deps: SessionMessageDependencies, session: AgentSessionRecord): Promise<SessionMessage[]> {
  if (session.subject.kind !== "task") return [];
  const task = await getItem(deps, taskKey(session.subject.taskId));
  if (task === undefined || task["orgId"] !== session.orgId) return [];
  const comments = await listTaskComments({ documentClient: deps.documentClient, tableName: deps.tableName, ...(deps.log === undefined ? {} : { log: deps.log }) }, session.subject.taskId, session.orgId);
  const messages: SessionMessage[] = [];
  for (const comment of comments) {
    if (comment.author.kind !== "person" || comment.deletedAt !== undefined) continue;
    const parsed = SessionMessageSchema.safeParse({
      messageId: pageMessageId(comment.commentId), sessionId: session.sessionId, kind: "comment", source: "page", author: { developerId: comment.author.developerId, name: cleanSessionName(comment.author.name) ?? "Someone" },
      text: [...plainMentions(comment.text)].slice(0, SESSION_MESSAGE_MAX_CHARS).join(""), createdAt: isoOf(Date.parse(comment.createdAt)), rev: comment.rev,
      ...(comment.editedAt === undefined ? {} : { editedAt: isoOf(Date.parse(comment.editedAt)) }),
    });
    if (parsed.success) messages.push(parsed.data);
  }
  return messages;
}

/**
 * `GET /v1/app/sessions/{id}/messages?after=<cursor>` [view]: `{ messages, next? }`, oldest first (by time, then id), at most `SESSION_MESSAGES_PAGE_MAX` new ones. With a cursor
 * (`<createdAt>#<messageId>`, the last message of the previous page) it first repeats the five seconds before it (at most `REREAD_MAX`, never the cursor's own), so a message committed late is
 * still found; readers de-duplicate by `messageId`. A person who can view the session can read it, a project viewer included; anyone else gets `NOT_FOUND`.
 */
export async function listSessionMessages(deps: SessionMessageDependencies, caller: SessionCaller, sessionId: string, query: { after?: string | undefined; anchor?: string | undefined }): Promise<SessionMessagePage> {
  const cursor = parseCursor(query.after);
  const only = query.anchor === undefined ? undefined : parseAnchorQuery(query.anchor);
  const access = await requireSessionLevel(deps, caller, sessionId, "view", "read its comments");
  const { session } = access;
  // The comments of one part (and their replies, which hold its anchor) come from the session's own store: the task page's comments are never pinned.
  const kept = (message: SessionMessage) => only === undefined || anchoredOn(message.anchor, only);
  // A viewer who can't see the part can't list by its id either: it is the empty list, no different from a part nobody commented on. A view that can't be built is the same (fail closed).
  const targets = only === undefined ? undefined : await anchorTargetsFor(deps, session, access);
  const visible = only === undefined || targets?.some((part) => anchorKey(part) === anchorKey(only)) === true;
  const all = [...(visible ? (await ownMessages(deps, session, cursor === undefined ? undefined : cursor.ms - REREAD_MS)).filter(kept) : []), ...(only === undefined ? await pageMessages(deps, session) : [])].map(positioned).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  let repeated: Positioned[] = [];
  let fresh: Positioned[];
  if (cursor === undefined) {
    fresh = all;
  } else {
    const from = isoOf(cursor.ms - REREAD_MS);
    repeated = all.filter((entry) => entry.key < cursor.key && entry.message.createdAt >= from).slice(-REREAD_MAX);
    fresh = all.filter((entry) => entry.key > cursor.key);
  }
  fresh = fresh.slice(0, SESSION_MESSAGES_PAGE_MAX);
  const next = fresh.at(-1)?.key ?? query.after;
  const presented = await presentMessages(deps, session, access, [...repeated, ...fresh].map((entry) => entry.message), targets);
  // ERASE-NAME-2: the author's name was stored with the message; an erased person reads "A former member", a removed one never the name they chose (developer/name-resolver.ts).
  const replaced = await replacementNames({ documentClient: deps.documentClient, tableName: deps.tableName, orgId: session.orgId }, presented.map((message) => message.author.developerId));
  const shown = replaced.size === 0 ? presented : presented.map((message) => (replaced.has(message.author.developerId) ? { ...message, author: { ...message.author, name: shownNameOf(message.author.name, message.author.developerId, replaced) } } : message));
  return { messages: shown, ...(next === undefined ? {} : { next }) };
}
