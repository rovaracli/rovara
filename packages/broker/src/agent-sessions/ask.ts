// Live interaction A3: "Ask about this task", the broker's side. A person with "can use" on a task's session asks a question; the broker checks it, spends the rates, queues the question for the chat
// service (the existing no-tools answer turn, widened to tasks that did not start in Slack) and, when the service answers, stores the answer (`ask-store.ts`) and audits it (`ask-audit.ts`).
//
// Who may ask: "can use" on the session, read live (owner, co-owners, commenters, maintainers). A project viewer, a view-only share and the Enterprise Auditor are refused (an Ask costs money).
// What an Ask can change: nothing but its own records. The route writes only the request item (`ASKREQ#`, ids and a state, no question text), the rate items and the one-at-a-time lock; the
// service route writes the answer (`ASK#`), the audit item and the request's state. The answer is never sent to the agent: "Tell the agent" is a message the person sends as themselves.
// The switch (`ak`, LIVE_ASK_ENABLED) is OFF by default: the routes then answer NOT_FOUND exactly as if they did not exist.
import { createHash } from "node:crypto";
import { GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  ASK_ANSWER_LABEL, ASK_LIMITS, ASK_RATE, ASK_UNAVAILABLE_MESSAGE, redactText, AskAnsweredRequestSchema, AskBodySchema, AskQueueMessageSchema, AskStatusSchema, AskTurnRequestSchema, ASK_TURN_RULES, INDEX_EXPIRY_ATTRIBUTE,
  agentXError, askLockKey, askRequestKey, projectArchivedMessage, askRouteAttributes, sessionAskKey, sessionRateKey,
  type AskAnsweredRequest, type AskStatus, type AskTurnResult, type OrgId, type SessionLevel,
} from "@agentx/contracts";
import { failedIndexes } from "../agents/table-writes.js";
import { taskKey, type DeveloperTaskRecord } from "../developer/task-records.js";
import { readProjectMeta } from "../developer/project-roles.js";
import type { SlackRequestQueue } from "../developer/page-comments.js";
import type { DeveloperTaskRouteDependencies } from "../aws/developer-tasks/types.js";
import { requireSessionLevel, sessionLevelOf, type SessionAccessDependencies, type SessionCaller } from "./access.js";
import { askContext, type AskContextReaders, type AskViewer } from "./ask-context.js";
import { auditAsk, type AskAuditDependencies } from "./ask-audit.js";
import { readAskAsAsker, writeAsk, type AskPerson, type AskStoreDependencies } from "./ask-store.js";
import { AgentSessionStore } from "./store.js";

type Item = Record<string, unknown>;
type Edition = "enterprise" | "public";

/** The words a refusal says. Fixed: no refusal repeats the question or anything of the task. */
/** What a Linear Ask's turn gets in place of the project's chat instructions. */
export const LINEAR_TURN_INSTRUCTIONS = "Answer from the task data only, in a few plain sentences.";
export const ASK_RATE_TEXT = "You've asked a lot of questions lately. Try again a little later.";
export const ASK_BUSY_TEXT = "One question at a time: wait for the answer to your last one.";
export const ASK_ERASED_TEXT = "This account can't ask questions.";
export const ASK_CLOSED_TEXT = "This task is closed, so it can't be asked about.";

/** How many times an Ask reads the shared counters and tries again after losing a race to another Ask. */
export const RATE_RACE_ATTEMPTS = 4;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** How long a waiting Ask holds its person's lock (a turn holds a queue message for at most 15 minutes; the service answers or fails it well within). */
const LOCK_SECONDS = 15 * 60;
/** How long an Ask may be answered, and so how old it may be when a model key is made for it (LA-5, M2). */
export const ASK_LOCK_SECONDS = LOCK_SECONDS;
/** A request item is kept a day: long enough to answer a repeat, short enough that nothing about the Ask lingers. */
const REQUEST_TTL_SECONDS = 86_400;

export interface AskDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
  edition: Edition;
  /** The `ak` switch. Off: every Ask route answers NOT_FOUND. */
  enabled: boolean;
  /** The chat service's request queue. Absent: the install cannot answer an Ask, and the route says so. */
  queue: SlackRequestQueue | undefined;
  /** Session levels and project roles. */
  access: SessionAccessDependencies;
  actions: DeveloperTaskRouteDependencies["actions"];
  readers: AskContextReaders;
  /** The store for one org (the erased-person marker and the aliases are the org's). */
  store(orgId: OrgId): AskStoreDependencies;
  audit: AskAuditDependencies;
  /** The session's people with the names they are known by (the writer replaces them with labels before anything is stored). Best effort: a failure gives the asker alone. */
  people(task: DeveloperTaskRecord, askerId: string | undefined): Promise<readonly AskPerson[]>;
  /** The project's chat instructions, as every chat turn is given them. */
  orchestratorInstructions(orgId: OrgId, project: string): Promise<string>;
  /** The model the service reports when it does not say (a label only). */
  defaultModel: string;
  /** How a Linear Ask's answer reaches the issue (the only place a Linear answer is shown). Absent: no Linear Ask is taken (`linear-comments.ts`). */
  linearReply?: LinearAnswerPort | undefined;
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

export type AskCaller = SessionCaller;

/** Posts a comment on a Linear issue as Rovara (see `LinearReplyPort`; this is the part an Ask needs). */
export interface LinearAnswerPort { reply(input: { orgId: OrgId; issueKey: string; text: string }): Promise<void> }

/** Text for a Linear issue with every `@` that starts a word broken, so that it can never notify someone by mention and Rovara's own words can never read as a mention of Rovara. */
export const withoutMentions = (text: string): string => text.replace(/@(?=[\p{L}\p{N}_])/gu, "@\u200b");

/** An answer for a Linear issue: secrets redacted, mentions broken, with the AI label. */
export const linearAnswerText = (text: string): string => `${withoutMentions(redactText(text))}\n\n_${ASK_ANSWER_LABEL}_`;

const getItem = async (deps: Pick<AskDependencies, "documentClient" | "tableName">, key: { pk: string; sk: string }): Promise<Item | undefined> =>
  ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Item }).Item;

/** The Ask's id from the request's: the same request always gives the same Ask, so a repeat is that Ask and spends nothing. */
export function askIdFor(orgId: string, developerId: string, requestId: string): string {
  const digest = createHash("sha256").update(`ask\0${orgId}\0${developerId}\0${requestId}`, "utf8").digest();
  let value = BigInt(`0x${digest.subarray(0, 13).toString("hex")}`);
  let out = "";
  for (let index = 0; index < 20; index += 1) { out = "0123456789abcdefghijklmnopqrstuvwxyz"[Number(value % 36n)]! + out; value /= 36n; }
  return `ask_${out}`;
}

/** The queue event id of an Ask: stable per Ask, in the queue's event-id form (the queue deduplicates on it). */
export const askEventId = (askId: string): string => `Ev${createHash("sha256").update(askId, "utf8").digest("hex").slice(0, 32)}`;

const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", ASK_UNAVAILABLE_MESSAGE);

/** Refuses with `PROJECT_ARCHIVED` (the project's one archived sentence) when the project is archived; any other read failure is the Ask's own retryable fault. */
export async function requireProjectNotArchived(deps: Pick<AskDependencies, "documentClient" | "tableName">, orgId: OrgId, project: string): Promise<void> {
  let archived: boolean;
  try {
    archived = (await readProjectMeta(deps as never, orgId, project))?.status === "archived";
  } catch {
    throw unavailable();
  }
  if (archived) throw agentXError("PROJECT_ARCHIVED", projectArchivedMessage(project));
}
const notFound = () => agentXError("NOT_FOUND", "route not found");

// ---- the rates

interface RateStep { room: boolean; item: Record<string, unknown> }

/** One fixed-window counter as a step of the Ask's own transaction: the new count is set from the count that was read, conditional on it, so two Asks cannot both take the last place. */
async function rateStep(deps: AskDependencies, key: { pk: string; sk: string }, scope: { orgId: OrgId; sessionId: string }, limit: number, windowMs: number): Promise<RateStep> {
  const stored = await getItem(deps, key);
  const nowMs = deps.now();
  const window = Math.floor(nowMs / windowMs) * windowMs;
  const seenWindow = stored?.["windowStart"];
  const seenCount = stored?.["count"];
  if (stored !== undefined && (typeof seenWindow !== "number" || typeof seenCount !== "number")) throw unavailable();
  const count = typeof seenWindow === "number" && seenWindow === window && typeof seenCount === "number" ? seenCount : 0;
  return {
    room: count < limit,
    item: { Update: {
      TableName: deps.tableName, Key: key,
      UpdateExpression: "SET entityType = :type, orgId = :org, sessionId = :session, windowStart = :window, #count = :next, #expires = :expires",
      ConditionExpression: stored === undefined ? "attribute_not_exists(pk)" : "windowStart = :seenWindow AND #count = :seenCount",
      ExpressionAttributeNames: { "#count": "count", "#expires": INDEX_EXPIRY_ATTRIBUTE },
      ExpressionAttributeValues: {
        ":type": "SESSION_RATE", ":org": scope.orgId, ":session": scope.sessionId, ":window": window, ":next": count + 1, ":expires": Math.floor((window + 2 * windowMs) / 1000),
        ...(stored === undefined ? {} : { ":seenWindow": seenWindow, ":seenCount": seenCount }),
      },
    } },
  };
}

// ---- asking

/** What an admitted Ask is, whoever asks: the web's member, or (Linear intake) a person on a bound issue. */
export interface AskAdmission {
  audience: "web" | "linear";
  orgId: OrgId;
  sessionId: string;
  task: DeveloperTaskRecord;
  /** Names the person for the rates and the one-at-a-time lock: a member's developer id, or a stable hash of an outsider's Linear id. */
  askerKey: string;
  /** The member who asked; absent for an outsider (no erasure index, no label). */
  askedBy?: string | undefined;
  /** Linear only: the issue the Ask was made on (the answer's context is built for that issue's viewers). */
  issueId?: string | undefined;
  question: string;
  /** What makes the Ask the same Ask again: the web request's id, or the Linear comment's id. */
  requestId: string;
}

/**
 * Spends the rates, takes the one-at-a-time lock, records the waiting Ask (ids and a state, never the question) and queues the question for the chat service. The caller has already checked the
 * asker's right to ask and the task. A repeat of the same request is the same Ask and spends nothing.
 */
export async function admitAsk(deps: AskDependencies, adm: AskAdmission): Promise<AskStatus> {
  const queue = deps.queue;
  if (queue === undefined) throw unavailable();
  const { orgId, task } = adm;
  const askId = askIdFor(orgId, adm.askerKey, adm.requestId);
  const requestKey = askRequestKey(orgId, adm.sessionId, askId);
  const earlier = await getItem(deps, requestKey);
  if (earlier !== undefined) return statusOfRequest(deps, orgId, adm.sessionId, askId, earlier, adm.askerKey);
  // An archived project takes no new work, and an Ask costs its payer money (LA-5, M5): refused in the project's own fixed words, before anything is spent or written. A project that cannot be read is not guessed at.
  await requireProjectNotArchived(deps, orgId, task.project);

  const nowMs = deps.now();
  const scope = { orgId, sessionId: adm.sessionId };
  const lockKey = askLockKey(orgId, adm.sessionId, adm.askerKey);
  const expires = Math.floor(nowMs / 1000) + REQUEST_TTL_SECONDS;
  // The counters are shared (the task's day count is everyone's), so a transaction can lose a race to another person's Ask at the same moment: that is retried, a bounded number of times, with the
  // counters read again. Only the lock or the request item refusing means this person already has a question waiting (or this very request won).
  for (let attempt = 1; ; attempt += 1) {
    const person = await rateStep(deps, sessionRateKey(orgId, adm.sessionId, adm.askerKey, "ask"), scope, ASK_RATE.perPersonPerHour, HOUR_MS);
    const everyone = await rateStep(deps, sessionRateKey(orgId, adm.sessionId, "task", "ask_day"), scope, ASK_RATE.perTaskPerDay, DAY_MS);
    if (!person.room || !everyone.room) throw agentXError("TOO_MANY_REQUESTS", ASK_RATE_TEXT);
    const lock = await getItem(deps, lockKey);
    if (lock !== undefined && typeof lock["expiresAt"] === "number" && lock["expiresAt"] > nowMs) throw agentXError("TASK_BUSY", ASK_BUSY_TEXT);
    try {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
        person.item, everyone.item,
        { Put: { TableName: deps.tableName, Item: { ...lockKey, entityType: "ASK_LOCK", orgId, sessionId: adm.sessionId, askId, expiresAt: nowMs + LOCK_SECONDS * 1000, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(nowMs / 1000) + LOCK_SECONDS * 2 },
          ConditionExpression: "attribute_not_exists(pk) OR expiresAt <= :now", ExpressionAttributeValues: { ":now": nowMs } } },
        { Put: { TableName: deps.tableName, Item: { ...requestKey, entityType: "ASK_REQUEST", orgId, sessionId: adm.sessionId, askId, taskId: task.taskId, audience: adm.audience, askerKey: adm.askerKey,
          ...(adm.askedBy === undefined ? {} : { askedBy: adm.askedBy }), ...(adm.issueId === undefined ? {} : { issueId: adm.issueId }), state: "queued", createdAt: new Date(nowMs).toISOString(), [INDEX_EXPIRY_ATTRIBUTE]: expires },
          ConditionExpression: "attribute_not_exists(pk)" } },
      ] as never }));
      break;
    } catch (error) {
      // Another call won a place at the same moment: if it was this very request, that is the answer.
      const now = await getItem(deps, requestKey);
      if (now !== undefined) return statusOfRequest(deps, orgId, adm.sessionId, askId, now, adm.askerKey);
      if (!isCancelled(error)) throw error;
      const refused = failedIndexes(error);
      // The lock (item 2) or the request (item 3) refused: a question of this person's is waiting.
      if (refused?.has(2) === true || refused?.has(3) === true) throw agentXError("TASK_BUSY", ASK_BUSY_TEXT);
      // Only the counters moved (another person's Ask): read them again. Out of attempts, say so without blaming the asker.
      if (attempt >= RATE_RACE_ATTEMPTS) throw unavailable();
    }
  }
  try {
    const message = AskQueueMessageSchema.parse({ version: 1, eventId: askEventId(askId), ask: { orgId, sessionId: adm.sessionId, askId, audience: adm.audience }, text: adm.question, receivedAt: new Date(nowMs).toISOString() });
    await queue.send({ body: JSON.stringify(message), groupId: createHash("sha256").update(`ask\0${task.taskId}`, "utf8").digest("hex"), deduplicationId: message.eventId, attributes: askRouteAttributes() });
  } catch (error) {
    // The queue refused it: the Ask is over (failed), the asker's lock is let go, and they are told in fixed words. Nothing is retried in the background.
    deps.log?.({ event: "ask.queue_failed", orgId, error: error instanceof Error ? error.name : "unknown" });
    await settleRequest(deps, orgId, adm.sessionId, askId, adm.askerKey, "failed").catch(() => undefined);
    throw unavailable();
  }
  return AskStatusSchema.parse({ askId, state: "queued" });
}

/** The web route: a member with "can use" asks about a task's session. Answers the Ask's id and that it is queued; the answer is read with `askStatusFor`. */
export async function submitAsk(deps: AskDependencies, caller: AskCaller, sessionId: string, value: unknown): Promise<AskStatus> {
  if (!deps.enabled) throw notFound();
  const body = AskBodySchema.safeParse(value);
  if (!body.success) throw agentXError("CONFIG_INVALID", "an ask needs a request ID and a question of 1 to 1,000 characters");
  // "Can use", read live. Anyone below it (a viewer, a view-only share, an Auditor) is refused here, before anything is read of the task.
  const { session } = await requireSessionLevel(deps.access, caller, sessionId, "use", "ask about it");
  if (session.subject.kind !== "task") throw agentXError("CONFIG_INVALID", "You can ask about a task's session.");
  if (deps.queue === undefined) throw unavailable();
  const task = (await getItem(deps, taskKey(session.subject.taskId))) as DeveloperTaskRecord | undefined;
  if (task === undefined || task.orgId !== caller.orgId) throw notFound();
  if (task.closedAt !== undefined) throw agentXError("SESSION_ENDED", ASK_CLOSED_TEXT);
  if (await deps.store(caller.orgId).isErased(caller.developerId)) throw agentXError("FORBIDDEN", ASK_ERASED_TEXT);
  return admitAsk(deps, { audience: "web", orgId: caller.orgId, sessionId: session.sessionId, task, askerKey: caller.developerId, askedBy: caller.developerId, question: body.data.question, requestId: body.data.requestId });
}

const isCancelled = (error: unknown): boolean => (error as { name?: string }).name === "TransactionCanceledException";

/** Where an Ask is, for the person who asked: queued, answered (with the answer, once, to them alone) or failed. Anyone else gets NOT_FOUND. */
export async function askStatusFor(deps: AskDependencies, caller: AskCaller, sessionId: string, askId: string): Promise<AskStatus> {
  if (!deps.enabled) throw notFound();
  const { session } = await requireSessionLevel(deps.access, caller, sessionId, "view", "read it");
  const request = await getItem(deps, askRequestKey(caller.orgId, session.sessionId, askId));
  if (request === undefined || request["askerKey"] !== caller.developerId || request["orgId"] !== caller.orgId || request["audience"] !== "web") throw notFound();
  return statusOfRequest(deps, caller.orgId, session.sessionId, askId, request, caller.developerId);
}

async function statusOfRequest(deps: AskDependencies, orgId: OrgId, sessionId: string, askId: string, request: Item, viewer: string): Promise<AskStatus> {
  // A request another person made is never shown: the same request id from a different person is a different Ask (its id includes the person), so this only guards a forged id.
  if (request["askerKey"] !== viewer) throw notFound();
  const state = request["state"];
  // A waiting Ask that nobody answered within the lock's time was dropped (an older chat service refuses the message): it reads as failed, never as waiting for ever.
  if (state === "queued" && typeof request["createdAt"] === "string" && deps.now() - Date.parse(request["createdAt"]) > LOCK_SECONDS * 1000) return AskStatusSchema.parse({ askId, state: "failed" });
  if (state === "answered") {
    const record = await readAskAsAsker(deps, orgId, sessionId, askId, viewer, deps.now());
    return AskStatusSchema.parse({ askId, state: "answered", ...(record?.answer === undefined ? {} : { answer: record.answer }) });
  }
  return AskStatusSchema.parse({ askId, state: state === "failed" ? "failed" : "queued" });
}

/** Ends a waiting Ask in `state` and lets its person's lock go. Conditional on the state it was in, so only the first ending counts. Answers whether this call ended it. */
async function settleRequest(deps: AskDependencies, orgId: OrgId, sessionId: string, askId: string, askerKey: string, state: "answered" | "failed"): Promise<boolean> {
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: askRequestKey(orgId, sessionId, askId), UpdateExpression: "SET #state = :next, settledAt = :now",
      ConditionExpression: "#state = :queued", ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":next": state, ":queued": "queued", ":now": new Date(deps.now()).toISOString() },
    }));
  } catch (error) {
    if ((error as { name?: string }).name === "ConditionalCheckFailedException") return false;
    throw error;
  }
  // The lock is let go only if it is still this Ask's.
  await deps.documentClient.send(new UpdateCommand({
    TableName: deps.tableName, Key: askLockKey(orgId, sessionId as never, askerKey), UpdateExpression: "SET expiresAt = :zero", ConditionExpression: "askId = :ask",
    ExpressionAttributeValues: { ":zero": 0, ":ask": askId },
  })).catch(() => undefined);
  return true;
}

// ---- asking in Slack (the existing task-thread question, on the same rates, record and audit)

/** Names a Slack user with no member link for the rates: a hash of their Slack workspace and user id (nothing readable is stored). */
export const slackAskerKey = (teamId: string, userId: string): string => `slack_${createHash("sha256").update(`slack-asker\0${teamId}\0${userId}`, "utf8").digest("hex").slice(0, 32)}`;

/** The rates of a Slack Ask: the same 20 an hour per person and 100 a day per task as the web's. Spent BEFORE the answer turn; no room refuses it in fixed words. */
export async function takeSlackAskRates(deps: AskDependencies, task: DeveloperTaskRecord, askerKey: string): Promise<void> {
  if (task.orgId === undefined || task.sessionId === undefined) throw unavailable();
  const scope = { orgId: task.orgId, sessionId: task.sessionId };
  for (let attempt = 1; ; attempt += 1) {
    const person = await rateStep(deps, sessionRateKey(task.orgId, task.sessionId, askerKey, "ask"), scope, ASK_RATE.perPersonPerHour, HOUR_MS);
    const everyone = await rateStep(deps, sessionRateKey(task.orgId, task.sessionId, "task", "ask_day"), scope, ASK_RATE.perTaskPerDay, DAY_MS);
    if (!person.room || !everyone.room) throw agentXError("TOO_MANY_REQUESTS", ASK_RATE_TEXT);
    try {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [person.item, everyone.item] as never }));
      return;
    } catch (error) {
      // Another Ask took a place at the same moment: read the counters again (a bounded number of times). A genuinely full counter is refused above, on the next read.
      if (!isCancelled(error)) throw error;
      if (attempt >= RATE_RACE_ATTEMPTS) throw unavailable();
    }
  }
}

/**
 * Stores and audits a Slack Ask once its answer was posted (`ASK#` per `askStoresText`: Public keeps a hash and sizes only for Slack; Enterprise keeps the words). The Ask's id is made from the
 * saved reply (`messageTs`), so a redelivery of the "answered" call is the same Ask and writes nothing twice. Never throws: the answer is already in the thread.
 */
export async function recordSlackAsk(deps: AskDependencies, input: { task: DeveloperTaskRecord; messageTs: string; askedBy: string | undefined; question: string; answer: string; contextBytes: number; model?: string | undefined }): Promise<void> {
  try {
    const { task } = input;
    if (task.orgId === undefined || task.sessionId === undefined) return;
    const askId = askIdFor(task.orgId, "slack", `${task.taskId}:${input.messageTs}`);
    const nowMs = deps.now();
    const stored = await writeAsk(deps.store(task.orgId), {
      edition: deps.edition, orgId: task.orgId, sessionId: task.sessionId, askId, audience: "slack", askedBy: input.askedBy, question: input.question.slice(0, 1_000), answer: input.answer.slice(0, 20_000),
      contextBytes: Math.min(input.contextBytes, ASK_LIMITS.contextMaxBytes), model: input.model ?? deps.defaultModel, nowMs, people: await deps.people(task, input.askedBy).catch(() => []),
    });
    if (stored === "written") {
      await auditAsk(deps.audit, { edition: deps.edition, orgId: task.orgId, sessionId: task.sessionId, askId, audience: "slack", contextBytes: Math.min(input.contextBytes, ASK_LIMITS.contextMaxBytes), model: input.model ?? deps.defaultModel, askedBy: input.askedBy, projectName: task.project, nowMs });
    }
  } catch (error) {
    deps.log?.({ event: "ask.slack_record_failed", error: error instanceof Error ? error.name : "unknown" });
  }
}

// ---- the chat service's routes (the service role only; see ask-service.ts)

/** The context level port: a person's CURRENT level on a session of their org, "none" when they have none. Read live for every Ask. */
export function sessionLevelPort(access: SessionAccessDependencies): (person: { orgId: OrgId; developerId: string }, sessionId: string) => Promise<SessionLevel | "none"> {
  return async (person, sessionId) => {
    const session = await new AgentSessionStore(access).get(person.orgId, sessionId);
    return session === undefined ? "none" : sessionLevelOf(access, person, session, {});
  };
}

interface PendingAsk { request: Item; task: DeveloperTaskRecord; viewer: AskViewer; askerKey: string; askedBy: string | undefined; audience: "web" | "linear"; issueId: string | undefined }

/** The waiting Ask the service names, with its task and the viewer it is for, or undefined: not made by the broker, not waiting, another org's, or its task is gone. */
async function pendingAsk(deps: AskDependencies, ref: { orgId: OrgId; sessionId: string; askId: string }): Promise<PendingAsk | undefined> {
  const request = await getItem(deps, askRequestKey(ref.orgId, ref.sessionId, ref.askId));
  if (request === undefined || request["orgId"] !== ref.orgId || request["state"] !== "queued" || typeof request["askerKey"] !== "string" || typeof request["taskId"] !== "string") return undefined;
  const audience = request["audience"];
  if (audience !== "web" && audience !== "linear") return undefined;
  const task = (await getItem(deps, taskKey(request["taskId"]))) as DeveloperTaskRecord | undefined;
  if (task === undefined || task.orgId !== ref.orgId || task.sessionId !== ref.sessionId) return undefined;
  const askedBy = typeof request["askedBy"] === "string" ? request["askedBy"] : undefined;
  const issueId = request["issueId"];
  if (audience === "web" && askedBy === undefined) return undefined;
  if (audience === "linear" && typeof issueId !== "string") return undefined;
  const viewer: AskViewer = audience === "web" ? { audience: "web", orgId: ref.orgId, developerId: askedBy! } : { audience: "linear", orgId: ref.orgId, issueId: issueId as string };
  return { request, task, viewer, askerKey: request["askerKey"], askedBy, audience, issueId: typeof issueId === "string" ? issueId : undefined };
}

/**
 * The context of one waiting Ask, built NOW for its audience and for its asker's level NOW (a person whose "can use" ended, or who was erased, since asking gets nothing). Throws a fixed error and
 * the service then reports the Ask failed. Returns the turn's rules first, then the audience's context.
 */
export async function prepareAskTurn(deps: AskDependencies, value: unknown): Promise<AskTurnResult> {
  if (!deps.enabled) throw notFound();
  const ref = AskTurnRequestSchema.safeParse(value);
  if (!ref.success) throw agentXError("CONFIG_INVALID", "an ask is named by its org, session and ask ID");
  const pending = await pendingAsk(deps, ref.data);
  if (pending === undefined) throw notFound();
  if (pending.askedBy !== undefined && await deps.store(ref.data.orgId).isErased(pending.askedBy)) throw agentXError("FORBIDDEN", ASK_ERASED_TEXT);
  const context = await askContext({ documentClient: deps.documentClient, tableName: deps.tableName, actions: deps.actions, sessionLevel: sessionLevelPort(deps.access) }, pending.viewer, pending.task.taskId, deps.readers);
  if (context === undefined) throw agentXError("FORBIDDEN", "this question can't be answered now");
  // The project's chat instructions are admin-written configuration (internal links, repository names, policy): a Linear issue's viewers are not members, so their turn gets a fixed line instead.
  const instructions = pending.audience === "linear" ? LINEAR_TURN_INSTRUCTIONS : await deps.orchestratorInstructions(ref.data.orgId, pending.task.project);
  return { workspaceId: pending.task.workspaceId, orchestratorInstructions: instructions, taskContext: `${ASK_TURN_RULES}\n${context.text}` };
}

/**
 * The service's answer (or that there is none). Only a waiting Ask takes one, once: the request item moves from queued to answered/failed in one conditional step, and only the call that made the
 * move stores the answer and audits it, so a redelivery writes nothing twice. A stored answer is scrubbed of secrets and of the names of the session's people (`writeAsk`).
 */
export async function completeAsk(deps: AskDependencies, value: unknown): Promise<{ outcome: "ANSWERED" | "FAILED" }> {
  if (!deps.enabled) throw notFound();
  const parsed = AskAnsweredRequestSchema.safeParse(value);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "an answer needs the ask, an outcome and, for an answer, its text");
  const answer: AskAnsweredRequest = parsed.data;
  const pending = await pendingAsk(deps, answer);
  if (pending === undefined) {
    // A repeat of an outcome already recorded answers the same.
    const request = await getItem(deps, askRequestKey(answer.orgId, answer.sessionId, answer.askId));
    if (request !== undefined && request["orgId"] === answer.orgId && (request["state"] === "answered" || request["state"] === "failed")) return { outcome: request["state"] === "answered" ? "ANSWERED" : "FAILED" };
    throw notFound();
  }
  if (answer.outcome === "ANSWERED" && (answer.text === undefined || answer.text.trim() === "" || answer.question === undefined || answer.question.trim() === "")) throw agentXError("CONFIG_INVALID", "an answer needs the question and its text");
  const tellLinear = async (text: string): Promise<void> => {
    if (pending.audience !== "linear" || pending.issueId === undefined || deps.linearReply === undefined) return;
    try { await deps.linearReply.reply({ orgId: answer.orgId, issueKey: pending.issueId, text }); } catch (error) { deps.log?.({ event: "ask.linear_reply_failed", error: error instanceof Error ? error.name : "unknown" }); }
  };
  if (answer.outcome === "FAILED") {
    if (await settleRequest(deps, answer.orgId, answer.sessionId, answer.askId, pending.askerKey, "failed")) await tellLinear(ASK_UNAVAILABLE_MESSAGE);
    return { outcome: "FAILED" };
  }
  const nowMs = deps.now();
  const contextBytes = Math.min(answer.contextBytes ?? 0, ASK_LIMITS.contextMaxBytes);
  const stored = await writeAsk(deps.store(answer.orgId), {
    edition: deps.edition, orgId: answer.orgId, sessionId: answer.sessionId, askId: answer.askId, audience: pending.audience, askedBy: pending.askedBy,
    question: answer.question ?? "", answer: answer.text ?? "", contextBytes, model: answer.model ?? deps.defaultModel, nowMs, people: await deps.people(pending.task, pending.askedBy).catch(() => []),
  });
  if (stored === "erased") {
    if (await settleRequest(deps, answer.orgId, answer.sessionId, answer.askId, pending.askerKey, "failed")) await tellLinear(ASK_UNAVAILABLE_MESSAGE);
    return { outcome: "FAILED" };
  }
  const settled = await settleRequest(deps, answer.orgId, answer.sessionId, answer.askId, pending.askerKey, "answered");
  if (settled) {
    await tellLinear(linearAnswerText(answer.text ?? ""));
    await auditAsk(deps.audit, { edition: deps.edition, orgId: answer.orgId, sessionId: answer.sessionId, askId: answer.askId, audience: pending.audience, contextBytes, model: answer.model ?? deps.defaultModel, askedBy: pending.askedBy, projectName: pending.task.project, nowMs });
  }
  return { outcome: "ANSWERED" };
}

export { sessionAskKey };
