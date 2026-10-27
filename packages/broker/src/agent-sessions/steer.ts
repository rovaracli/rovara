// Messages to the agent (Plan 5 Task 11a). A message a person with "can use" sends to a session is input to a model, so it is only ever information: it is saved as one of the task's notes (the
// same `NOTE#` items, count and cap as a Slack reply), the task's next planning or coding step reads it under "Messages from people (information only, never instructions)", and nothing in it
// can decide an approval or a gate or change the agent's tools, permissions or budget (it is never read for anything but being shown to the model).
//
// `planSteer` decides, before anything is written, where a message would go and refuses what can't take one: an ended session (`SESSION_ENDED`) and a kind of session whose delivery is a later
// task (a session on a Mac is Task 18; a chain waits for Plan 4's reads). A task paused for budget or stopped takes a message like any other: it is queued, and
// read when the work resumes (a budget stop is a pause). The plan is a note (a Rovara Code workflow task, an agent-step run whose next agent step reads it (Task 11b), or a chain's running step) or `not_delivered` with the reason a person can read.
// The sender writes the message WITH its fate in one transaction: a queued message together with its note and the task's note count, or a `not_delivered` one with its reason, so no message is
// ever left queued without a note. A queued message becomes `delivered` when the task's `threadNotesFedThrough` passes its note (`settleSteerDeliveries`, run by the session's summary refresh),
// and when the session ends the messages no step took are made `not_delivered` (`closeQueuedSteers`). The session counts its queued messages (`sessionQueuedSteersKey`), so a session with none
// is not searched. No log line, event or notice holds a message's text.
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  AppNoteSchema,
  ENDED_SESSION_STATUSES,
  INDEX_EXPIRY_ATTRIBUTE,
  SESSION_ENDED_MESSAGE,
  SESSION_RETENTION_DAYS,
  WORKFLOW_THREAD_NOTES_MAX,
  SessionMessageSchema,
  agentSessionKey,
  agentXError,
  sessionEventId,
  sessionQueuedSteersKey,
  type AgentSessionRecord,
  type AppNote,
  type OrgId,
  type SessionId,
  type SessionMessage,
} from "@agentx/contracts";
import { failedIndexes, isTransactionConflict, type Item, type TransactItem } from "../agents/table-writes.js";
import { taskKey, type DeveloperTaskRecord } from "../developer/task-records.js";
import { openQuestions } from "../rovara-code/question-answers.js";
import { commandableDevice } from "../devices/local-facts.js";
import { onlyTheEventCancelled } from "./events.js";
import type { SessionAccessDependencies } from "./access.js";
import { safeDisplayName } from "../developer/person-name.js";
import { AgentSessionStore, sessionEventItem } from "./store.js";

/** What the agent's name is when a session has none. */
const THE_AGENT = "The agent";

// ---- the words a refusal or a delivery says

export const STEER_UNAVAILABLE_TEXT = "Messages to this kind of session aren't available yet.";
const NOT_READABLE_TEXT = "This session can't be read right now.";
export const PLAIN_TASK_REASON = "this task takes instructions only from its owner's next request";
export const CHAIN_GATE_REASON = "the chain is waiting for an approval";
export const NO_STEP_REASON = "no step of the chain is running right now";
export const TASK_FULL_REASON = "this task already holds all the messages it keeps";
export const SESSION_ENDED_REASON = "the session has ended";
export const MAC_GONE_REASON = "this Mac isn't available";
/** What a message to a task that waits for answers is told (Rovara Code asked questions and nothing reads a note until they are answered). */
export const WAITING_FOR_ANSWERS_REASON = (sessionId: string): string => `it is waiting for your answers to its questions; answer them in the app, with agentx session answer ${sessionId}, or with agentx_answer_task_questions`;

/**
 * Plan 4's chain run, as far as a message needs it: what the run is doing now. Injected where Plan 4 is merged; until it is, a message to a chain session is refused before anything is written.
 * `step` names the task of the section that is running; the broker checks that it is this chain's, in this org, before giving it anything.
 */
// Supplied by Plan 4 (`chainSteerReadsFor`, chains/session-seam.ts).
export interface ChainSteerReads {
  current(orgId: OrgId, chainRunId: string): Promise<{ kind: "gate" } | { kind: "step"; taskId: string } | { kind: "none" }>;
}

export interface SteerDependencies extends Pick<SessionAccessDependencies, "documentClient" | "tableName" | "now"> {
  chainSteer?: ChainSteerReads | undefined;
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

/** Where a message goes now. */
type Route =
  | { kind: "note"; task: DeveloperTaskRecord }
  | { kind: "device"; deviceId: string }
  | { kind: "not_delivered"; reason: string }
  | { kind: "ended"; taskId?: string }
  | { kind: "unavailable"; message: string };

/** What `planSteer` decides: a note for a task's next step, a command for the Mac a local session runs on, or the reason the message can't be delivered. */
export type SteerPlan = { kind: "note"; task: DeveloperTaskRecord } | { kind: "device"; deviceId: string } | { kind: "not_delivered"; reason: string };

const getItem = async (deps: Pick<SteerDependencies, "documentClient" | "tableName">, key: { pk: string; sk: string }): Promise<Item | undefined> =>
  ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Item }).Item;
const isoOf = (ms: number) => new Date(ms).toISOString();
const HOUSEKEEPING = new Set(["pk", "sk", "entityType", "orgId", INDEX_EXPIRY_ATTRIBUTE]);

const messageKey = (session: { orgId: OrgId; sessionId: string }, messageId: string) => agentSessionKey(session.orgId, session.sessionId, `MESSAGE#${messageId}`);

function messageOf(item: Item | undefined, session: { orgId: OrgId; sessionId: string }): SessionMessage | undefined {
  if (item === undefined || item["orgId"] !== session.orgId || item["sessionId"] !== session.sessionId) return undefined;
  const parsed = SessionMessageSchema.safeParse(Object.fromEntries(Object.entries(item).filter(([key]) => !HOUSEKEEPING.has(key))));
  if (!parsed.success) return undefined;
  // Release 0.4.16: an author stored under their email reads under the placeholder.
  const name = safeDisplayName(parsed.data.author.name, parsed.data.author.developerId);
  return name === parsed.data.author.name ? parsed.data : { ...parsed.data, author: { ...parsed.data.author, name } };
}

const agentName = (session: AgentSessionRecord): string | undefined => session.agent?.name;

// ---- where a message goes

/** Whether the task's own work is over, by what the task itself says (the session's record may not have caught up). */
const taskEnded = (task: DeveloperTaskRecord): boolean =>
  task.closedAt !== undefined || task.outcome === "creator_removed" || task.agentRunEnd !== undefined || task.workflow?.stage === "MERGED" || task.workflow?.stage === "CLOSED";

function taskRoute(session: AgentSessionRecord, task: DeveloperTaskRecord): Route {
  if (taskEnded(task)) return { kind: "ended", taskId: task.taskId };
  // Rovara Code asked its questions and waits: no step runs to read a note, and the answers have their own route, so a message would sit "queued" for good. Say where to answer instead.
  if (openQuestions(task.workflow).length > 0) return { kind: "not_delivered", reason: WAITING_FOR_ANSWERS_REASON(session.sessionId) };
  // A Rovara Code (workflow) task reads notes at its next planning or coding step: today's path, whatever the task is doing now (a task paused for budget or stopped takes it too: it is read when the work resumes, since a budget stop is a pause).
  if (task.workflow !== undefined) return { kind: "note", task };
  // An agent-step run reads them at its next agent step, or at the continuation of the step after its write approvals (Task 11b: `advanceAgentRun`'s dispatch gives the task's unfed notes).
  if (task.agent !== undefined) return { kind: "note", task };
  return { kind: "not_delivered", reason: PLAIN_TASK_REASON };
}

async function routeOf(deps: SteerDependencies, session: AgentSessionRecord): Promise<Route> {
  if (session.endedAt !== undefined || (ENDED_SESSION_STATUSES as readonly string[]).includes(session.summary.status)) {
    return { kind: "ended", ...(session.subject.kind === "task" ? { taskId: session.subject.taskId } : {}) };
  }
  const readTask = async (taskId: string): Promise<DeveloperTaskRecord | undefined> => {
    const task = await getItem(deps, taskKey(taskId)) as DeveloperTaskRecord | undefined;
    return task === undefined || task.orgId !== session.orgId ? undefined : task;
  };
  if (session.subject.kind === "task") {
    const task = await readTask(session.subject.taskId);
    return task === undefined ? { kind: "unavailable", message: NOT_READABLE_TEXT } : taskRoute(session, task);
  }
  if (session.subject.kind === "chain") {
    // Without Plan 4's reads (no chains in this deployment) a message to a chain is refused: nothing says which step is running.
    if (deps.chainSteer === undefined) return { kind: "unavailable", message: STEER_UNAVAILABLE_TEXT };
    const current = await deps.chainSteer.current(session.orgId, session.sessionId);
    if (current.kind === "gate") return { kind: "not_delivered", reason: CHAIN_GATE_REASON };
    if (current.kind === "none") return { kind: "not_delivered", reason: NO_STEP_REASON };
    const step = await readTask(current.taskId);
    // A task that isn't this chain run's step (no chain, another run's) is never given the message.
    if (step?.chain?.chainRunId !== session.sessionId) return { kind: "not_delivered", reason: NO_STEP_REASON };
    const route = taskRoute(session, step);
    return route.kind === "ended" ? { kind: "not_delivered", reason: NO_STEP_REASON } : route;
  }
  // A session on a Mac: the message goes to its device as a command (Task 18), if the device is its owner's and not removed.
  const device = await commandableDevice(deps, session);
  return device === undefined ? { kind: "not_delivered", reason: MAC_GONE_REASON } : { kind: "device", deviceId: device.deviceId };
}

/** Before anything is written: where a message will go, or the refusal a person is given. A task with no room left for a note takes the message as `not_delivered`. */
export async function planSteer(deps: SteerDependencies, session: AgentSessionRecord): Promise<SteerPlan> {
  const route = await routeOf(deps, session);
  if (route.kind === "ended") throw agentXError("SESSION_ENDED", SESSION_ENDED_MESSAGE);
  if (route.kind === "unavailable") throw agentXError("RUNTIME_UNAVAILABLE", route.message);
  if (route.kind === "not_delivered" || route.kind === "device") return route;
  return (route.task.threadNoteCount ?? 0) >= WORKFLOW_THREAD_NOTES_MAX ? { kind: "not_delivered", reason: TASK_FULL_REASON } : route;
}

// ---- the queue's count and the answers

/** What a delivery answer says: the session's own words, one per answer. */
const answerText = (session: AgentSessionRecord, author: string, answer: { state: "delivered" } | { state: "not_delivered"; reason: string }): string =>
  answer.state === "delivered" ? `${agentName(session) ?? THE_AGENT} got ${author}'s message.` : `${agentName(session) ?? THE_AGENT} can't take messages right now: ${answer.reason}.`;

/**
 * The session's count of queued messages to the agent going up (`1`, in the transaction that writes a queued message) or down (`-1`, in the one that answers it). Never conditional: the message's
 * own condition (it is queued, or it is new) is what makes each message count once.
 */
export function queuedSteersItem(deps: Pick<SteerDependencies, "tableName">, session: Pick<AgentSessionRecord, "orgId" | "sessionId">, change: 1 | -1, nowMs: number): TransactItem {
  return {
    Update: {
      TableName: deps.tableName, Key: sessionQueuedSteersKey(session.orgId, session.sessionId),
      UpdateExpression: "SET entityType = :type, orgId = :org, sessionId = :session, #expires = :expires ADD #count :change",
      ExpressionAttributeNames: { "#count": "count", "#expires": INDEX_EXPIRY_ATTRIBUTE },
      ExpressionAttributeValues: { ":type": "AGENT_SESSION_QUEUED_STEERS", ":org": session.orgId, ":session": session.sessionId, ":change": change, ":expires": Math.floor(nowMs / 1000) + SESSION_RETENTION_DAYS * 86_400 },
    },
  };
}

/** How many messages to the agent the session counts as queued; 0 when it has never counted one. */
async function queuedCount(deps: Pick<SteerDependencies, "documentClient" | "tableName">, session: Pick<AgentSessionRecord, "orgId" | "sessionId">): Promise<number> {
  const count = (await getItem(deps, sessionQueuedSteersKey(session.orgId, session.sessionId)))?.["count"];
  return typeof count === "number" ? count : 0;
}

/** The session's event that a message could not be given to the agent, for the transaction that writes (or answers) the message; the event is last in it. */
export function steerNotDeliveredEvent(deps: SteerDependencies, session: AgentSessionRecord, message: Pick<SessionMessage, "messageId" | "source" | "author">, reason: string): TransactItem {
  return sessionEventItem(deps, session, {
    eventId: sessionEventId("steer_not_delivered", message.messageId), at: isoOf(deps.now()), type: "steer_not_delivered", actor: { kind: "agent" }, source: message.source === "linear" ? "linear" : "app",
    messageId: message.messageId, text: answerText(session, message.author.name, { state: "not_delivered", reason }),
  });
}

/**
 * Answers a queued message: its `delivery`, the queue's count down by one, any `extra` items, and the session's own event for it, the event last. When only the event refuses (it is told already)
 * the rest is written without it. When a condition on the message or an extra item fails, the message was answered already: the answer is the message as it is stored (`wrote` false). Other failures
 * are thrown.
 */
async function answerMessage(
  deps: SteerDependencies, session: AgentSessionRecord, message: SessionMessage, answer: { state: "delivered" } | { state: "not_delivered"; reason: string }, extra: TransactItem[] = [],
): Promise<{ message: SessionMessage | undefined; wrote: boolean }> {
  const at = isoOf(deps.now());
  const type = answer.state === "delivered" ? "steer_delivered" : "steer_not_delivered";
  const change: TransactItem = {
    Update: {
      TableName: deps.tableName, Key: messageKey(session, message.messageId),
      UpdateExpression: "SET delivery = :delivery",
      ConditionExpression: "attribute_exists(pk) AND delivery.#state = :queued",
      ExpressionAttributeNames: { "#state": "state" },
      ExpressionAttributeValues: { ":delivery": { state: answer.state, at, ...(answer.state === "not_delivered" ? { reason: answer.reason } : {}) }, ":queued": "queued" },
    },
  };
  const event = sessionEventItem(deps, session, {
    eventId: sessionEventId(type, message.messageId), at, type, actor: { kind: "agent" }, source: message.source === "linear" ? "linear" : "app", messageId: message.messageId, text: answerText(session, message.author.name, answer),
  });
  const base = [...extra, change, queuedSteersItem(deps, session, -1, deps.now())];
  const EVENT = base.length;
  try {
    try {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [...base, event] }));
    } catch (error) {
      if (!onlyTheEventCancelled(error, EVENT)) throw error;
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: base }));
    }
    return { message: messageOf(await getItem(deps, messageKey(session, message.messageId)), session), wrote: true };
  } catch (error) {
    // A condition failed (the message was answered, or the note settled, by another run): what is stored is the answer. A conflict or any other failure is for the caller.
    const failed = failedIndexes(error);
    if (failed === undefined || failed.size === 0) throw error;
    return { message: messageOf(await getItem(deps, messageKey(session, message.messageId)), session), wrote: false };
  }
}

// ---- telling the session a step took a message

const SETTLE_MAX = 50;

/**
 * Marks the session's queued messages `delivered` for every note the task's `threadNotesFedThrough` has passed: the message's delivery, a `steer_delivered` event and the note's `settledAt`
 * go in one transaction, so each message is told once, and a note already settled or a message already answered is left alone. `taskId` names the task whose notes are read (a task session's
 * own, by default; a chain session passes the step's). Answers how many messages it marked.
 */
export async function settleSteerDeliveries(deps: SteerDependencies, session: AgentSessionRecord, taskId?: string): Promise<number> {
  const id = taskId ?? (session.subject.kind === "task" ? session.subject.taskId : undefined);
  if (id === undefined) return 0;
  // A session with no queued message has nothing to settle: the task's notes are not read at all.
  if (await queuedCount(deps, session) <= 0) return 0;
  const task = await getItem(deps, taskKey(id)) as DeveloperTaskRecord | undefined;
  if (task === undefined || task.orgId !== session.orgId || task.threadNotesFedThrough === undefined || (task.threadNoteCount ?? 0) === 0) return 0;
  // The task is this session's own, or (a chain) one of its steps.
  const own = session.subject.kind === "task" ? session.subject.taskId === task.taskId : task.chain?.chainRunId === session.sessionId;
  if (!own) return 0;
  const through = task.threadNotesFedThrough;
  const due: AppNote[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :note)", ConsistentRead: true,
      ExpressionAttributeValues: { ":pk": `DEVTASK#${task.taskId}`, ":note": "NOTE#msg_" }, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      const parsed = AppNoteSchema.safeParse(Object.fromEntries(Object.entries(item).filter(([key]) => key !== "pk" && key !== "sk" && key !== "entityType")));
      if (parsed.success && parsed.data.sessionId === session.sessionId && parsed.data.settledAt === undefined && parsed.data.receivedAt <= through) due.push(parsed.data);
    }
    start = page.LastEvaluatedKey;
  } while (start !== undefined);

  let delivered = 0;
  for (const note of due.slice(0, SETTLE_MAX)) {
    const message = messageOf(await getItem(deps, messageKey(session, note.messageId)), session);
    const settled: TransactItem = {
      Update: {
        TableName: deps.tableName, Key: { pk: `DEVTASK#${task.taskId}`, sk: `NOTE#${note.messageId}` },
        UpdateExpression: "SET settledAt = :at", ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(settledAt)", ExpressionAttributeValues: { ":at": isoOf(deps.now()) },
      },
    };
    if (message?.delivery?.state !== "queued") {
      // Nothing to tell (the message is gone or was answered otherwise): the note is settled so it is not looked at again.
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [settled] })).catch((error: unknown) => {
        if (failedIndexes(error) === undefined) throw error;
      });
      continue;
    }
    try {
      if ((await answerMessage(deps, session, message, { state: "delivered" }, [settled])).wrote) delivered += 1;
    } catch (error) {
      // A conflict with another writer: the next refresh settles it. Anything else is for the caller.
      if (!isTransactionConflict(error)) throw error;
    }
  }
  return delivered;
}

/** The most messages one look closes on an ended session (the session holds at most `SESSION_MESSAGES_MAX`); a session with more is closed by its next look. */
const CLOSE_MAX = 100;

/**
 * When a session has ended, its messages to the agent that no step took can never be delivered: each is made `not_delivered` with a fixed reason and the session's own event, in one transaction
 * with the queue's count going down, so it is told once. Answers how many it closed. Nothing happens for a session that has not ended, or that counts no queued message. Run after
 * `settleSteerDeliveries`, so a message a step did take is `delivered` first. A conflict with another writer leaves that message for the next look.
 */
export async function closeQueuedSteers(deps: SteerDependencies, session: AgentSessionRecord): Promise<number> {
  if (session.endedAt === undefined || await queuedCount(deps, session) <= 0) return 0;
  const queued: SessionMessage[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ConsistentRead: true,
      ExpressionAttributeValues: { ":pk": agentSessionKey(session.orgId, session.sessionId, "META").pk, ":prefix": "MESSAGE#msg_" }, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      const message = messageOf(item, session);
      if (message?.kind === "steer" && message.delivery?.state === "queued" && queued.length < CLOSE_MAX) queued.push(message);
    }
    start = page.LastEvaluatedKey;
  } while (start !== undefined && queued.length < CLOSE_MAX);
  let closed = 0;
  for (const message of queued) {
    try {
      if ((await answerMessage(deps, session, message, { state: "not_delivered", reason: SESSION_ENDED_REASON })).wrote) closed += 1;
    } catch (error) {
      if (!isTransactionConflict(error)) throw error;
    }
  }
  return closed;
}

/**
 * `settleSteerDeliveries` and, for an ended session, `closeQueuedSteers`, for a session known by id: reads it, and never throws (a mark it can't make is made by the next refresh, and for an ended
 * session by the retention drain).
 */
export async function settleSteerDeliveriesFor(deps: SteerDependencies, orgId: OrgId, sessionId: SessionId, taskId?: string): Promise<void> {
  try {
    const session = await new AgentSessionStore(deps).get(orgId, sessionId);
    if (session !== undefined) {
      await settleSteerDeliveries(deps, session, taskId);
      await closeQueuedSteers(deps, session);
    }
  } catch (error) {
    deps.log?.({ event: "agent_session.steer_settle_failed", orgId, sessionId, error: error instanceof Error ? error.name : "unknown" });
  }
}

/**
 * A steer the Mac's poll handed over is `delivered` (it has the words now): its message, the queue's count and the session's event, as a step taking a note does. Never throws: a message
 * left queued is closed when the session ends.
 */
export async function deliverSteerToDevice(deps: SteerDependencies, orgId: OrgId, sessionId: SessionId, messageId: string): Promise<void> {
  try {
    const session = await new AgentSessionStore(deps).get(orgId, sessionId);
    if (session === undefined || session.subject.kind !== "local") return;
    const message = messageOf(await getItem(deps, messageKey(session, messageId)), session);
    if (message?.kind !== "steer" || message.delivery?.state !== "queued") return;
    await answerMessage(deps, session, message, { state: "delivered" });
  } catch (error) {
    deps.log?.({ event: "agent_session.steer_deliver_failed", orgId, sessionId, error: error instanceof Error ? error.name : "unknown" });
  }
}
