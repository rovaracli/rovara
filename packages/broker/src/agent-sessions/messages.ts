// Comments on a session (Plan 5 Task 10). A comment is a `MESSAGE#<messageId>` item on the session's partition. Sending one is a single transaction: the person's rate item for the
// window, the session's message count, the message, a check that the session is still there, the request item (R18) and a `comment` event, the event last (Task 6's contract).
//
// Comments are for people only. They need `view` and not a project viewer's role, they never reach the agent or the task (messages to the agent are Task 11a's, and need "can use"),
// and nothing in one can notify anybody: Slack's mention markup is made plain on the way in, and the only notice a comment makes is `session.updated` on the session's own channel (ids
// only), which people who can't view the session can't subscribe to. The text is cleaned and redacted first and cut to the limit after, so a secret is never cut in half and left;
// neither the event nor the request item nor any log holds any of it, so editing or deleting a comment leaves no copy behind.
//
// `GET …/messages` is one conversation over two stores (I11): this session's comments and, for a task session, the task page's comments read through (`source: "page"`; they are
// edited on the page). A message's id sorts by the time it was written, so both stores read in one order, and a cursor read repeats the seconds before the cursor to catch one that
// committed late.
import { createHash } from "node:crypto";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import {
  COMMENT_RATE,
  INDEX_EXPIRY_ATTRIBUTE,
  SESSION_MESSAGES_MAX,
  SESSION_MESSAGES_PAGE_MAX,
  SESSION_MESSAGE_MAX_CHARS,
  SESSION_RETENTION_DAYS,
  SESSION_REVISION_CONFLICT_MESSAGE,
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
  type SessionMessage,
  type SessionMessagePage,
} from "@agentx/contracts";
import { failedIndexes, isTransactionConflict, type Item, type TransactItem } from "../agents/table-writes.js";
import { listTaskComments } from "../developer/page-comments.js";
import { taskKey } from "../developer/task-records.js";
import { publishNotices, type RealtimeConfig } from "../realtime/publish.js";
import { requireSessionLevel, type SessionAccessDependencies, type SessionCaller } from "./access.js";
import { sessionEventItem } from "./store.js";

export interface SessionMessageDependencies extends SessionAccessDependencies {
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
const DELIVERED_TEXT = "The agent already has this message, so it can't be changed.";
const BUSY_TEXT = "This session is busy right now. Try again in a moment.";
const STEERING_LATER_TEXT = "Messages to the agent aren't available yet.";
/** What a deleted comment's text is: the original is gone, and a message always holds some text. */
export const DELETED_TEXT = "[deleted]";

const REQUEST_MEMORY_DAYS = 7;
const DAY_SECONDS = 86_400;
/** How many times a write is tried while it only loses to another transaction on the same items. */
const ATTEMPTS = 4;
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
export const SendBodySchema = z.object({ requestId: RequestIdSchema, kind: z.enum(["comment", "steer"]), text: TextSchema }).strict();
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

/** A comment's text as it is stored: cleaned and redacted (the page's rules), mentions made plain, and only then cut to the limit by characters. */
function storedText(raw: string): string {
  const cleaned = cleanCommentText(raw);
  if (!cleaned.ok) throw agentXError("CONFIG_INVALID", cleaned.reason === "empty" ? EMPTY_TEXT : TOO_LONG_TEXT);
  return [...plainMentions(cleaned.text)].slice(0, SESSION_MESSAGE_MAX_CHARS).join("");
}

// ---- ids

/** `msg_` and 20 characters: nine of the time (base 36, so ids sort by time) and eleven from the writer and their request, so a retry of one request is the same id. */
function newMessageId(nowMs: number, developerId: string, requestId: string): string {
  const time = nowMs.toString(36).padStart(ID_TIME_WIDTH, "0");
  return `msg_${time}${createHash("sha256").update(`${developerId}\n${requestId}`, "utf8").digest("hex").slice(0, 20 - ID_TIME_WIDTH)}`;
}

/** The id a task page comment has in a session's list: the same every read. */
const pageMessageId = (commentId: string): string => `msg_${createHash("sha256").update(`page-comment\0${commentId}`, "utf8").digest("hex").slice(0, 20)}`;

const messageKey = (session: { orgId: OrgId; sessionId: string }, messageId: string) => agentSessionKey(session.orgId, session.sessionId, `MESSAGE#${messageId}`);
const countKey = (session: { orgId: OrgId; sessionId: string }) => agentSessionKey(session.orgId, session.sessionId, "MESSAGE#COUNT");

function messageOf(item: Item | undefined, session: { orgId: OrgId; sessionId: string }, nowSeconds: number): SessionMessage | undefined {
  if (item === undefined || item["orgId"] !== session.orgId || item["sessionId"] !== session.sessionId) return undefined;
  const expires = item[INDEX_EXPIRY_ATTRIBUTE];
  if (typeof expires === "number" && expires <= nowSeconds) return undefined; // the table hasn't deleted it yet
  const parsed = SessionMessageSchema.safeParse(Object.fromEntries(Object.entries(item).filter(([key]) => !HOUSEKEEPING.has(key))));
  return parsed.success ? parsed.data : undefined;
}

// ---- the rate of writing

interface RateStep { room: boolean; item: TransactItem }

/**
 * One person's count of comments (or of changes to them) on one session in the current ten-minute window, as a step of the write's own transaction: the new count is set from the count
 * that was read, and the step is conditional on it, so two writes can't both take the last place. `room` is false when the window is full.
 */
async function rateStep(deps: SessionMessageDependencies, session: AgentSessionRecord, developerId: string, kind: "comment" | "change", limit: number, nowMs: number): Promise<RateStep> {
  const key = sessionRateKey(session.orgId, session.sessionId, developerId, kind);
  const stored = await getItem(deps, key);
  const window = Math.floor(nowMs / COMMENT_RATE.windowMs) * COMMENT_RATE.windowMs;
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
          ":type": "SESSION_RATE", ":org": session.orgId, ":session": session.sessionId, ":window": window, ":next": count + 1, ":expires": secondsOf(window + 2 * COMMENT_RATE.windowMs),
          ...(stored === undefined ? {} : { ":seenWindow": seenWindow, ":seenCount": seenCount }),
        },
      },
    },
  };
}

/** The check that the session is still there, so nothing is written into one that was removed since it was read. */
const sessionStillThere = (deps: SessionMessageDependencies, session: AgentSessionRecord): TransactItem => ({
  ConditionCheck: { TableName: deps.tableName, Key: agentSessionKey(session.orgId, session.sessionId, "META"), ConditionExpression: "attribute_exists(pk)" },
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
 * Sends a comment on a session [view, and not a project viewer]. `requestId` names the request: the same one again answers the same message and writes nothing, and with other words it is
 * `IDEMPOTENCY_CONFLICT`. At most `COMMENT_RATE.comments` per person and session in ten minutes, and at most `SESSION_MESSAGES_MAX` on a session; an ended session takes them too. A message to
 * the agent (`kind: "steer"`) is not available here.
 */
export async function sendSessionMessage(
  deps: SessionMessageDependencies,
  caller: MessageCaller,
  sessionId: string,
  input: { requestId: string; kind: "comment" | "steer"; text: string; source?: "app" | "linear" },
): Promise<SessionMessage> {
  if (!RequestIdSchema.safeParse(input.requestId).success) throw agentXError("CONFIG_INVALID", "requestId: must be a UUID");
  if (input.kind === "steer") throw agentXError("RUNTIME_UNAVAILABLE", STEERING_LATER_TEXT);
  if (input.source !== undefined && input.source !== "app") throw agentXError("CONFIG_INVALID", "source: a comment is written in the app");
  const { session } = await requireSessionLevel(deps, caller, sessionId, "view", "comment on it", { comment: true });
  const fingerprint = sha256({ op: "comment", sessionId: session.sessionId, text: input.text });
  const earlier = await replayOf(deps, session, caller.developerId, input.requestId, fingerprint);
  if (earlier !== undefined) return earlier;
  const text = storedText(input.text);

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const nowMs = deps.now();
    const rate = await rateStep(deps, session, caller.developerId, "comment", COMMENT_RATE.comments, nowMs);
    if (!rate.room) throw agentXError("TOO_MANY_REQUESTS", RATE_TEXT);
    const name = cleanSessionName(caller.name) ?? "Someone";
    const message = SessionMessageSchema.parse({
      messageId: newMessageId(nowMs, caller.developerId, input.requestId), sessionId: session.sessionId, kind: "comment", source: "app", author: { developerId: caller.developerId, name }, text, createdAt: isoOf(nowMs), rev: 1,
    });
    const event = sessionEventItem(deps, session, {
      eventId: sessionEventId("comment", message.messageId), at: message.createdAt, type: "comment", actor: { kind: "member", developerId: caller.developerId, name }, source: "app", messageId: message.messageId, text: `${name} commented.`,
    });
    const base: TransactItem[] = [
      rate.item,
      {
        Update: {
          TableName: deps.tableName, Key: countKey(session),
          UpdateExpression: "SET entityType = :type, orgId = :org, sessionId = :session, #expires = :expires ADD #count :one",
          ConditionExpression: "attribute_not_exists(#count) OR #count < :max",
          ExpressionAttributeNames: { "#count": "count", "#expires": INDEX_EXPIRY_ATTRIBUTE },
          ExpressionAttributeValues: { ":type": "AGENT_SESSION_MESSAGE_COUNT", ":org": session.orgId, ":session": session.sessionId, ":one": 1, ":max": SESSION_MESSAGES_MAX, ":expires": secondsOf(nowMs) + SESSION_RETENTION_DAYS * DAY_SECONDS },
        },
      },
      {
        Put: {
          TableName: deps.tableName,
          Item: { ...messageKey(session, message.messageId), entityType: "AGENT_SESSION_MESSAGE", orgId: session.orgId, ...message, [INDEX_EXPIRY_ATTRIBUTE]: secondsOf(nowMs) + SESSION_RETENTION_DAYS * DAY_SECONDS },
          ConditionExpression: "attribute_not_exists(pk)",
        },
      },
      sessionStillThere(deps, session),
      REQUEST_ITEM(deps, session, caller.developerId, input.requestId, fingerprint, message.messageId, nowMs),
    ];
    const RATE = 0, COUNT = 1, MESSAGE = 2, SESSION = 3, REQUEST = 4, EVENT = 5;
    try {
      try {
        await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [...base, event] }));
      } catch (error) {
        // The event is never a reason for a comment to fail: when only it refuses (it is recorded already), the rest is written without it.
        const failed = failedIndexes(error);
        if (failed === undefined || failed.size !== 1 || !failed.has(EVENT)) throw error;
        await deps.documentClient.send(new TransactWriteCommand({ TransactItems: base }));
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
        if (again !== undefined) return again;
      }
      if (failed.has(SESSION)) throw agentXError("NOT_FOUND", "session not found");
      if (failed.has(COUNT)) throw agentXError("CONFIG_INVALID", TOO_MANY_TEXT);
      // Another request of this person took a place since the count was read: read it again.
      if (failed.has(RATE)) continue;
      if (failed.has(MESSAGE)) throw agentXError("RUNTIME_UNAVAILABLE", BUSY_TEXT);
      throw error;
    }
    await tellSession(deps, session);
    return message;
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
      if (current.delivery !== undefined && current.delivery.state !== "queued") throw agentXError("CONFIG_INVALID", DELIVERED_TEXT);
      // The agent reads this one: it can only be rewritten by someone who may still send such messages.
      if (change.kind === "edit") await requireSessionLevel(deps, caller, sessionId, "use", "change messages to the agent");
    }
    if (current.rev !== change.rev) throw agentXError("SESSION_REVISION_CONFLICT", SESSION_REVISION_CONFLICT_MESSAGE);
    const rate = await rateStep(deps, session, caller.developerId, "change", COMMENT_RATE.changes, nowMs);
    if (!rate.room) throw agentXError("TOO_MANY_REQUESTS", RATE_TEXT);
    const at = isoOf(nowMs);
    const next: SessionMessage = SessionMessageSchema.parse({ ...current, text, rev: current.rev + 1, ...(change.kind === "edit" ? { editedAt: at } : { deletedAt: at }) });
    const RATE = 0, MESSAGE = 1, SESSION = 2;
    try {
      await deps.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          rate.item,
          {
            Update: {
              TableName: deps.tableName, Key: messageKey(session, messageId),
              UpdateExpression: `SET #text = :text, rev = :next, ${change.kind === "edit" ? "editedAt" : "deletedAt"} = :at`,
              ConditionExpression: `attribute_exists(pk) AND rev = :rev${current.kind === "steer" ? " AND #delivery.#state = :queued" : ""}`,
              ExpressionAttributeNames: { "#text": "text", ...(current.kind === "steer" ? { "#delivery": "delivery", "#state": "state" } : {}) },
              ExpressionAttributeValues: { ":text": text, ":next": next.rev, ":at": at, ":rev": current.rev, ...(current.kind === "steer" ? { ":queued": "queued" } : {}) },
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
      // The message moved since it was read (another change, or its delivery): read it again and say which.
      if (failed.has(MESSAGE) || failed.has(RATE)) continue;
      throw agentXError("RUNTIME_UNAVAILABLE", BUSY_TEXT);
    }
    await tellSession(deps, session);
    return next;
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
  const comments = await listTaskComments({ documentClient: deps.documentClient, tableName: deps.tableName, ...(deps.log === undefined ? {} : { log: deps.log }) }, session.subject.taskId);
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
export async function listSessionMessages(deps: SessionMessageDependencies, caller: SessionCaller, sessionId: string, query: { after?: string | undefined }): Promise<SessionMessagePage> {
  const cursor = parseCursor(query.after);
  const { session } = await requireSessionLevel(deps, caller, sessionId, "view", "read its comments");
  const all = [...await ownMessages(deps, session, cursor === undefined ? undefined : cursor.ms - REREAD_MS), ...await pageMessages(deps, session)].map(positioned).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
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
  return { messages: [...repeated, ...fresh].map((entry) => entry.message), ...(next === undefined ? {} : { next }) };
}
