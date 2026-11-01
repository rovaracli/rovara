// Stop & redirect, phase 1 (live-interaction design 3.1): the owner (or a co-owner) stops the agent now and gives it a new instruction. `POST /v1/app/sessions/{id}/redirect`
// `{ requestId, text, mode }`, strict: there is no field for a budget, a tool, a permission or an approval, so a redirect cannot widen anything.
//
// Phase 1 records, then stops. ONE transaction writes the instruction as the owner's steer message and its note (the same `MESSAGE#` and `NOTE#` items a steer writes, so whatever happens later the
// next step can still read it), the steer rates and the redirect's two rates (5 per task per hour, 3 per step attempt: the person's cap window is never reset by a redirect), the `REDIRECT#`
// record and its in-flight marker (one redirect in flight per task), the session's `stopped` event and the control request that makes a repeat of the request answer the stored outcome. After
// the commit the same cancel as Stop runs. Phase 2 (`redirect-continue.ts`) restarts the step once the stop has blocked it.
//
// Who: the task's effective owner and its co-owners, read live from the task's People list (a task that was taken over has the taker as its only owner). Anyone else is refused before anything is
// written. Plain Stop keeps its own rule. Fails closed everywhere: a task state this route does not know, a worker that cannot be asked, a rate counter that does not read, all refuse and write nothing.
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { z } from "zod";
import {
  INDEX_EXPIRY_ATTRIBUTE,
  OWNER_REDIRECT_FEATURE,
  REDIRECT_RATE,
  REDIRECT_REFUSAL_MESSAGES,
  REDIRECT_SLACK_STATUS_LINE,
  RedirectBodySchema,
  SESSION_ENDED_MESSAGE,
  SESSION_MESSAGES_MAX,
  SESSION_RETENTION_DAYS,
  STEER_RATE,
  SessionMessageSchema,
  agentXError,
  cleanSessionName,
  sessionEventId,
  type AgentSessionRecord,
  type RedirectMode,
  type RedirectRecord,
  type RedirectRefusal,
  type RedirectState,
  type SessionView,
} from "@agentx/contracts";
import { failedIndexes, isTransactionConflict, type TransactItem } from "../agents/table-writes.js";
import { auditSessionRedirected, auditSessionStopped } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, tryAuditEvents } from "../audit/outbox.js";
import { auditActorOf } from "../audit/plan3-hooks.js";
import { isTaskTakenOver, taskKey, type DeveloperTaskRecord } from "../developer/task-records.js";
import { sessionNoteItems } from "../aws/developer-tasks.js";
import { readTaskPeople, requireSessionLevel, type SessionAccess } from "./access.js";
import { countKey, messageKey, newMessageId, rateStep, sessionStillThere, storedText, type SessionMessageDependencies } from "./messages.js";
import { hourlyRedirects, readRedirect, redirectCreateItems, redirectTtl, stepRedirects, endRedirect, type RedirectStateDependencies } from "./redirect-state.js";
import type { SessionReadDependencies } from "./read.js";
import { planSteer, queuedSteersItem } from "./steer.js";
import { repeatOf, readControlRequest, controlRequestItem, afterControl, answerOf, isEnded, isoOf, nameOrSomeone, taskOfSession, getItem, type ControlCaller } from "./stop.js";
import { AgentSessionStore, sessionEventItem } from "./store.js";
import { classifyRedirect, needsCodingRestart, type RedirectPlan } from "./redirect-plan.js";

/** The outside world of a redirect that is not the table: asking a worker what it supports, and (phase 2) restarting the step. Present only when the switch is on. */
export interface RedirectConfig {
  /**
   * What the worker of the task's workspace lists on /ping. Rejects, or answers nothing, when the worker cannot be asked: the redirect is then refused (a worker that cannot be asked is treated as
   * one that does not support it, so the owner's instruction is never run without the re-approval stop that binds it).
   */
  workerFeatures(task: DeveloperTaskRecord): Promise<readonly string[] | undefined>;
  /** Phase 2 for a task: restarts the stopped step if the stop has landed (`redirect-continue.ts`, bound to the broker). Best effort, never throws. */
  continueRedirect?(taskId: string): Promise<void>;
}

export interface RedirectDependencies extends SessionReadDependencies {
  redirect?: RedirectConfig | undefined;
}

/** What the route answers: the session as `GET` shows it, and where the redirect stands. */
export interface RedirectAnswer {
  session: SessionView;
  redirect: { requestId: string; mode: RedirectMode; state: RedirectState };
}

const ATTEMPTS = 4;
const STEER_WINDOW_MS = 3_600_000;
const HOUR_MS = REDIRECT_RATE.windowSeconds * 1_000;
const BUSY = "This session is busy right now. Try again in a moment.";

/** The refusal as an error: the fixed words, and a code the client can tell apart. */
export function redirectRefusal(reason: Exclude<RedirectRefusal, "session_ended">): Error {
  const code = reason === "not_owner" ? "FORBIDDEN" : reason === "rate_limited" ? "TOO_MANY_REQUESTS" : reason === "stale" || reason === "busy" ? "IDEMPOTENCY_CONFLICT" : reason === "old_worker" ? "RUNTIME_UNAVAILABLE" : "CONFIG_INVALID";
  return agentXError(code, REDIRECT_REFUSAL_MESSAGES[reason]);
}

function parseRedirectBody(body: unknown): z.infer<typeof RedirectBodySchema> {
  const parsed = RedirectBodySchema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const path = issue === undefined || issue.path.length === 0 ? "body" : issue.path.join(".");
  throw agentXError("CONFIG_INVALID", `${path}: ${issue === undefined || issue.code === "unrecognized_keys" ? "has a field this route does not take" : issue.message}`);
}

/**
 * Whether the person may redirect the task: its effective owner, or a co-owner on its People list. A task that was taken over has the taker as its owner, and its earlier co-owners are not
 * owners any more (the session levels agree). A People list that does not read counts as nobody. Read live on every call, including by phase 2.
 */
export async function mayRedirectTask(deps: Pick<RedirectDependencies, "documentClient" | "tableName">, task: DeveloperTaskRecord, developerId: string, isEffectiveOwner: boolean): Promise<boolean> {
  if (isEffectiveOwner) return true;
  if (isTaskTakenOver(task)) return false;
  const people = await readTaskPeople(deps, task.taskId);
  return people instanceof Map && people.get(developerId) === "owner";
}

/** Whether the worker can take an owner redirect: it lists the feature. Anything else (older worker, no answer, no probe) is no. */
export async function workerTakesRedirect(config: RedirectConfig, task: DeveloperTaskRecord): Promise<boolean> {
  try {
    return (await config.workerFeatures(task))?.includes(OWNER_REDIRECT_FEATURE) === true;
  } catch {
    return false;
  }
}

async function answerFor(deps: RedirectDependencies, caller: ControlCaller, session: AgentSessionRecord, record: Pick<RedirectRecord, "requestId" | "mode"> & { state: RedirectState }): Promise<RedirectAnswer> {
  return { ...(await answerOf(deps, caller, session.sessionId)), redirect: { requestId: record.requestId, mode: record.mode, state: record.state } };
}

/** A repeat of a request that committed: the cancel is asked for again (it is idempotent by the request id, and a crash after the commit may have lost it), then the answer is the record as it stands. */
async function replayAnswer(deps: RedirectDependencies, config: RedirectConfig, caller: ControlCaller, session: AgentSessionRecord, task: DeveloperTaskRecord, requestId: string): Promise<RedirectAnswer> {
  const record = await readRedirect(deps, task.taskId, requestId);
  if (record === undefined) throw agentXError("RUNTIME_UNAVAILABLE", BUSY);
  if (record.state === "stopping" && deps.control !== undefined) {
    try {
      await deps.control.cancelTask(task, requestId);
    } catch {
      // The stop is asked for again by the next repeat, and the sweep ends a redirect nobody finished: the answer is the record as it stands.
    }
    await config.continueRedirect?.(task.taskId);
  }
  return answerFor(deps, caller, session, (await readRedirect(deps, task.taskId, requestId)) ?? record);
}

/** The audit item for one end of a redirect (ids and a fixed word only), to go in the transaction that ends it. */
export async function redirectOutcomeAudit(deps: Pick<RedirectDependencies, "audit">, record: RedirectRecord, outcome: "restarted" | "revise_started" | "left_blocked" | "refused", occurredAt: string): Promise<TransactItem[]> {
  const events = await tryAuditEvents(deps, () => [auditSessionRedirected({
    orgId: record.orgId, actor: auditActorOf(record.actorId), occurredAt, occurrence: record.requestId, sessionId: record.sessionId, taskId: record.taskId, messageId: record.messageId, mode: record.mode, step: record.step, outcome,
  })]);
  return events.flatMap((event) => auditPending(deps, event));
}

/**
 * `POST /v1/app/sessions/{id}/redirect`. Needs "can edit" and to be the task's owner or a co-owner. Records the instruction and stops the step (phase 1); the step starts again by itself once the stop
 * has landed (phase 2). Answers the session and the redirect's state (`stopping` until phase 2 ends it). A repeat of the same request id writes nothing new.
 */
export async function redirectSession(deps: RedirectDependencies, caller: ControlCaller, sessionId: string, body: unknown): Promise<RedirectAnswer> {
  const config = deps.redirect;
  // The switch is off (or the broker was built without it): the route does not exist.
  if (config === undefined) throw agentXError("NOT_FOUND", "route not found");
  const input = parseRedirectBody(body);
  const access = await requireSessionLevel(deps, caller, sessionId, "edit", "stop and redirect it");
  const { session } = access;
  if (session.kind !== "task" || session.subject.kind !== "task" || session.where.kind !== "cloud") throw redirectRefusal("not_available");
  const task = await taskOfSession(deps, session);
  if (task === undefined) throw agentXError("NOT_FOUND", "session not found");
  // The owner check comes before anything else is read or written, so a refused person learns nothing about the task and the table is unchanged.
  if (!await mayRedirectTask(deps, task, caller.developerId, access.owner)) throw redirectRefusal("not_owner");
  const prior = await readControlRequest(deps, session, input.requestId);
  if (prior !== undefined) {
    repeatOf(prior, "redirect", caller.developerId);
    return replayAnswer(deps, config, caller, session, task, input.requestId);
  }
  if (isEnded(session)) throw agentXError("SESSION_ENDED", SESSION_ENDED_MESSAGE);
  if (deps.control === undefined) throw agentXError("RUNTIME_UNAVAILABLE", REDIRECT_REFUSAL_MESSAGES.not_available);

  const sent = await recordAndStop(deps, config, caller, access, task, input);
  return sent;
}

async function recordAndStop(deps: RedirectDependencies, config: RedirectConfig, caller: ControlCaller, access: SessionAccess, firstTask: DeveloperTaskRecord, input: z.infer<typeof RedirectBodySchema>): Promise<RedirectAnswer> {
  const { session } = access;
  const stateDeps: RedirectStateDependencies = { documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now };
  const messageDeps = deps as unknown as SessionMessageDependencies;
  const text = storedText(input.text);
  let task = firstTask;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      const fresh = (await getItem(deps, taskKey(task.taskId))) as DeveloperTaskRecord | undefined;
      if (fresh === undefined || fresh.orgId !== session.orgId) throw agentXError("NOT_FOUND", "session not found");
      task = fresh;
    }
    const plan = classifyRedirect(task);
    if ("refusal" in plan) {
      if (plan.refusal === "session_ended") throw agentXError("SESSION_ENDED", SESSION_ENDED_MESSAGE);
      throw redirectRefusal(plan.refusal);
    }
    if (needsCodingRestart(plan.step, input.mode) && !await workerTakesRedirect(config, task)) throw redirectRefusal("old_worker");
    // Where the instruction goes as a note: a task that cannot take one (it holds all it keeps, it waits for answers) cannot be redirected, and nothing is written.
    const route = await planSteer(deps, session);
    if (route.kind !== "note") throw redirectRefusal("not_available");

    const nowMs = deps.now();
    const at = isoOf(nowMs);
    const person = await rateStep(messageDeps, session, caller.developerId, "steer", STEER_RATE.perPersonPerHour, nowMs, STEER_WINDOW_MS);
    const everyone = await rateStep(messageDeps, session, "session", "steer_all", STEER_RATE.perSessionPerHour, nowMs, STEER_WINDOW_MS);
    const hour = await hourlyRedirects(stateDeps, session.orgId, task.taskId, REDIRECT_RATE.perTaskPerHour, HOUR_MS);
    const step = await stepRedirects(stateDeps, session.orgId, task.taskId, plan.step, (task.workflow?.decisions ?? []).length, REDIRECT_RATE.perStepAttempt);
    if (!person.room || !everyone.room || !hour.room || !step.room) throw redirectRefusal("rate_limited");

    const name = nameOrSomeone(caller.name);
    const messageId = newMessageId(nowMs, caller.developerId, input.requestId);
    const message = SessionMessageSchema.parse({
      messageId, sessionId: session.sessionId, kind: "steer", source: "app", author: { developerId: caller.developerId, name: cleanSessionName(caller.name) ?? "Someone" }, text, createdAt: at, rev: 1,
      delivery: { state: "queued", at },
    });
    const record: RedirectRecord = {
      requestId: input.requestId, orgId: session.orgId, sessionId: session.sessionId, taskId: task.taskId, actorId: caller.developerId, messageId, mode: input.mode, blockedRevision: plan.blockedRevision,
      step: plan.step, state: "stopping", createdAt: at, ttl: redirectTtl(nowMs),
    };
    const note = sessionNoteItems(deps, task, { taskId: task.taskId, source: "app", developerId: caller.developerId, name, isOwner: true, sessionId: session.sessionId, messageId, text });
    if (note.outcome === "refused") throw redirectRefusal("not_available");
    // The task must still be at the revision, stage and state this was planned for: the note's count update is the one write on the task row, so the guard rides in it.
    const [noteItem, countUpdate] = note.items;
    const guarded = guardTask(countUpdate, plan);

    const events = await tryAuditEvents(deps, () => [auditSessionStopped({
      orgId: session.orgId, actor: auditActorOf(caller.developerId), occurredAt: at, occurrence: input.requestId, related: [task.taskId], sessionId: session.sessionId, sessionKind: session.kind,
    })]);
    const created = redirectCreateItems(deps, record);
    const base: TransactItem[] = [];
    const place = (item: TransactItem) => base.push(item) - 1;
    const RATE = place(person.item);
    const EVERYONE = place(everyone.item);
    const HOUR = place(hour.item);
    const STEP = place(step.item);
    const COUNT = place({
      Update: {
        TableName: deps.tableName, Key: countKey(session),
        UpdateExpression: "SET entityType = :type, orgId = :org, sessionId = :session, #expires = :expires ADD #count :one",
        ConditionExpression: "attribute_not_exists(#count) OR #count < :max",
        ExpressionAttributeNames: { "#count": "count", "#expires": INDEX_EXPIRY_ATTRIBUTE },
        ExpressionAttributeValues: { ":type": "AGENT_SESSION_MESSAGE_COUNT", ":org": session.orgId, ":session": session.sessionId, ":one": 1, ":max": SESSION_MESSAGES_MAX, ":expires": Math.floor(nowMs / 1000) + SESSION_RETENTION_DAYS * 86_400 },
      },
    });
    const MESSAGE = place({
      Put: { TableName: deps.tableName, Item: { ...messageKey(session, messageId), entityType: "AGENT_SESSION_MESSAGE", orgId: session.orgId, ...message, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(nowMs / 1000) + SESSION_RETENTION_DAYS * 86_400 }, ConditionExpression: "attribute_not_exists(pk)" },
    });
    const SESSION = place(sessionStillThere(messageDeps, session, true));
    const NOTE = place(noteItem);
    const TASK = place(guarded);
    place(queuedSteersItem(deps, session, 1, nowMs));
    const RECORD = place(created.record);
    const OPEN = place(created.open);
    const REQUEST = place(controlRequestItem(deps, session, input.requestId, { action: "redirect", by: caller.developerId, at, sessionId: session.sessionId }, Math.floor(nowMs / 1000) + 30 * 86_400));
    const EVENT = base.length;
    const eventItems: TransactItem[] = [
      sessionEventItem(deps, session, { eventId: sessionEventId("redirected", input.requestId), at, type: "stopped", actor: { kind: "member", developerId: caller.developerId, name }, text: `${name} ${REDIRECT_SLACK_STATUS_LINE}.` }),
      ...events.flatMap((event) => auditPending(deps, event)),
    ];
    try {
      try {
        await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [...base, ...eventItems] }));
      } catch (error) {
        // An event is never a reason for a redirect to fail: when only events refuse (they are recorded already), the rest is written without them.
        const failed = failedIndexes(error);
        if (failed === undefined || failed.size === 0 || [...failed].some((index) => index < EVENT)) throw error;
        await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [...base, ...eventItems.filter((_, index) => !failed.has(EVENT + index))] }));
      }
    } catch (error) {
      if (isTransactionConflict(error)) continue;
      const failed = failedIndexes(error);
      if (failed === undefined) throw error;
      // This very request committed already (a retry that crossed its own first try): its record is the answer.
      if (failed.has(REQUEST) || failed.has(RECORD)) return replayAnswer(deps, config, caller, session, task, input.requestId);
      if (failed.has(OPEN)) throw redirectRefusal("busy");
      if (failed.has(SESSION)) {
        // The session ended, or is gone, since it was read.
        if ((await new AgentSessionStore(deps).get(session.orgId, session.sessionId))?.endedAt !== undefined) throw agentXError("SESSION_ENDED", SESSION_ENDED_MESSAGE);
        throw agentXError("NOT_FOUND", "session not found");
      }
      if (failed.has(COUNT)) throw agentXError("CONFIG_INVALID", "This session has the most messages it can hold.");
      // The task changed since it was read (moved on, closed, filled up, a step moved its mark) or another request took a place of a rate: read it all again and decide again.
      if (failed.has(TASK) || failed.has(NOTE) || failed.has(RATE) || failed.has(EVERYONE) || failed.has(HOUR) || failed.has(STEP)) continue;
      if (failed.has(MESSAGE)) throw agentXError("RUNTIME_UNAVAILABLE", BUSY);
      throw error;
    }
    await flushAuditEvents(deps, events);
    return stopAfterCommit(deps, config, caller, access, task, record);
  }
  throw agentXError("RUNTIME_UNAVAILABLE", BUSY);
}

/** Adds to the note's count update the condition that the task is still where the plan read it. The update is the only write on the task row in the transaction. */
function guardTask(update: TransactItem, plan: RedirectPlan): TransactItem {
  const inner = update.Update;
  if (inner === undefined) throw agentXError("RUNTIME_UNAVAILABLE", BUSY);
  return {
    Update: {
      ...inner,
      ConditionExpression: `${String(inner.ConditionExpression)} AND workflow.revision = :guardRevision AND workflow.#guardStage = :guardStage AND workflow.#guardState = :guardState`,
      ExpressionAttributeNames: { ...(inner.ExpressionAttributeNames ?? {}), "#guardStage": "stage", "#guardState": "state" },
      ExpressionAttributeValues: { ...(inner.ExpressionAttributeValues ?? {}), ":guardRevision": plan.guard.revision, ":guardStage": plan.guard.stage, ":guardState": plan.guard.state },
    },
  };
}

/** After the commit: the same cancel as Stop; a cancel that fails ends the redirect `failed` (the instruction stays a note) and raises the cancel's own fixed error. */
async function stopAfterCommit(deps: RedirectDependencies, config: RedirectConfig, caller: ControlCaller, access: SessionAccess, task: DeveloperTaskRecord, record: RedirectRecord): Promise<RedirectAnswer> {
  const { session } = access;
  try {
    await deps.control!.cancelTask(task, record.requestId);
  } catch (error) {
    const audit = await redirectOutcomeAudit(deps, record, "refused", isoOf(deps.now()));
    await endRedirect(deps, record, ["stopping"], "failed", audit).catch(() => undefined);
    throw error;
  }
  // The stop may have landed already (a step that was queued is blocked by the cancel's own transaction): phase 2 runs now if so, and otherwise waits for the terminal result of the run.
  await config.continueRedirect?.(task.taskId);
  await afterControl(deps, session, caller.developerId, access.effectiveOwner.developerId);
  const current = await readRedirect(deps, task.taskId, record.requestId);
  return answerFor(deps, caller, session, current ?? record);
}
