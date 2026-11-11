// Stopping a session (Plan 5 Task 13), and what stop and retry share. Stop acts on paid work, so it is Plan 3's own cancel (the one `POST /v1/dev/tasks/{id}/cancel` runs), asked for by the
// session actor after the session level was read live: "can edit", or an org owner or admin (`view` plus Stop). Plan 3's cancel is idempotent by the request id, so a repeat of the
// request writes nothing, and a request that was cancelled but never recorded is finished by asking again. A task session stays open and shows `stopped` (an agent-step run ends
// `cancelled`, which Plan 3 does); a budget pause stays a pause (the summary reads the task, and a stop never turns a pause into a failure). A chain session is stopped through
// Plan 4's `cancelChainRun` with the session actor, behind a seam: without it the stop is refused before anything is written. The stop is recorded in ONE transaction: the request
// item (so a repeat answers the stored outcome), the session's `stopped` event and the audit item.
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { ENDED_SESSION_STATUSES, INDEX_EXPIRY_ATTRIBUTE, SESSION_ENDED_MESSAGE, agentSessionKey, agentXError, cleanSessionName, sessionEventId, type AgentSessionRecord, type CodeIntentResult, type OrgId } from "@rovara-code/contracts";
import { type SessionView, type SessionCloseResponseSchema } from "@agentx/cloud-contracts";
import { LOCAL_STOPS_PER_HOUR, LOCAL_STOP_RATE_MESSAGE, type DeveloperTaskView } from "@agentx/cloud-contracts";
import type { AgentRunRequest, AgentRunResult } from "../agents/runs.js";
import { failedIndexes, isTransactionConflict, type Item, type TransactItem } from "../agents/table-writes.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditSessionStopped } from "../audit/events.js";
import { auditPending, tryAuditEvents } from "../audit/outbox.js";
import { auditActorOf } from "../audit/plan3-hooks.js";
import { taskKey, type DeveloperTaskRecord } from "../developer/task-records.js";
import { MAC_NOT_AVAILABLE_MESSAGE, commandableDevice } from "../devices/local-facts.js";
import { LOCAL_HOUR_MS, announceDeviceCommand, deviceCommandItems, limitStep } from "../devices/local-sessions.js";
import { requireSessionLevel, type ChainSessionActor, type SessionAccess } from "./access.js";
import { sessionView, type SessionReadCaller, type SessionReadDependencies } from "./read.js";
import { tell } from "./take-over.js";
import { refreshSessionSummary } from "./summary.js";
import { sessionEventItem } from "./store.js";

/**
 * What Plan 3 does for a session's task, bound by the broker to the signed-in person (the session actor): the real cancel and workflow retry of the task, and the run start. Each is
 * called only after this module read the person's level on the session. Without it stop and retry answer `RUNTIME_UNAVAILABLE`.
 */
export interface SessionControlHost {
  /** `cancelTaskFor` with the session actor: the same cancel as the task's own route, idempotent by `requestId`. */
  cancelTask(task: DeveloperTaskRecord, requestId: string): Promise<{ nothingRunning: boolean; message?: string } | void>;
  /**
   * The task's own close (`closeTask`, the route the Slack button and the AI-tool close use) for the signed-in person: it checks that they own the task, and asks the workspace about unpublished work first.
   * `discardUnpublished` is the person's answer to that question. Without it a close is refused (`RUNTIME_UNAVAILABLE`).
   */
  closeTask?(task: DeveloperTaskRecord, input: { requestId: string; discardUnpublished: boolean }): Promise<{ closed: boolean; discardedUnpublished?: boolean; unpublished?: Array<{ repository: string; reasons: string[] }>; message?: string }>;
  /** `retryTaskWorkflowFor` with the session actor, at the task's revision now: the same retry as the task's own route. */
  retryWorkflow(task: DeveloperTaskRecord, requestId: string): Promise<void>;
  /**
   * Stop & redirect while the plan waits for approval: the owner's request for changes with the instruction as its words, through the task's own decision (it checks who may decide, the revision and the plan's
   * digest, and is idempotent by the request id). `reason` is the whole instruction, up to the redirect limit; the decision records the first 500 characters of it and the planner is given all of it. Without it a redirect of a plan that waits is refused.
   */
  requestPlanChanges?(task: DeveloperTaskRecord, input: { requestId: string; expectedRevision: number; artifactDigest: string; reason: string }): Promise<void>;
  /** `startAgentRun`, which resolves the payer and applies the roster, budget and version rules; it is idempotent by the request's `requestId`. */
  startAgentRun(request: AgentRunRequest): Promise<AgentRunResult>;
  /**
   * Plan 6 Task 5: after people answered Understand's questions, starts Understand again at once, for the workflow revision the answer wrote. A convenience only: the answer's dispatch row is the
   * guarantee, and the sweep starts it if this does nothing or fails. Never throws.
   */
  startUnderstanding?(task: DeveloperTaskRecord, workflowRevision: number): Promise<void>;
  /** Plan 6 Task 6: `startCodeIntent` for the signed-in person (the "make a change anyway" start). Without it the route answers `RUNTIME_UNAVAILABLE`. */
  startCodeIntent?(request: unknown): Promise<CodeIntentResult<DeveloperTaskView>>;
  /**
   * Plan 6 Task 20: after a person linked, replaced or unlinked the session's Linear issue, rewrites the `Fixes <KEY>` line in the open pull requests' descriptions (`key` undefined takes it out). Answers how many
   * descriptions it changed and how many it could not. Without it the route tells the person to edit the description by hand.
   */
  rewritePullRequestLinearLine?(task: DeveloperTaskRecord, key: string | undefined): Promise<{ updated: number; failed: number }>;
}

/**
 * Plan 4's chain lifecycle as far as a session needs it, called with the internal session actor after Plan 5's own level check (Plan 4, M2): `cancelChainRun` ends the run (its
 * gate approval closes with it) and `retryChainRun` starts a new run of the chain's CURRENT published version (not the old run's) with the old run's input (`startChainRun` applies Plan 4's `use` rule) and answers the new run's session.
 */
// Plan 4's side is `chainControlFor` (chains/session-seam.ts), built for each request. `orgId` is the session's own org, so a chain run of another org is never touched (Plan 4's hand-off from Task 10).
export interface ChainControl {
  cancel(orgId: OrgId, actor: ChainSessionActor, chainRunId: string, requestId: string): Promise<void>;
  retry(orgId: OrgId, actor: ChainSessionActor, chainRunId: string, requestId: string): Promise<{ sessionId: string }>;
}

/** Who acts: `DeveloperCaller` fits. */
export type ControlCaller = SessionReadCaller & { name: string };

const BodySchema = z.object({ requestId: z.string().uuid() }).strict();
export const NOT_AVAILABLE = "Stopping a session isn't available right now.";
export const CHAIN_STOP_UNAVAILABLE = "Stopping a chain run isn't available right now.";
/** A task session recorded as running on a Mac (a hand-off's second leg, before Task 19) is not stopped here: only a local session is, through its device. */
export const MAC_STOP_UNAVAILABLE = "Stopping a session on a Mac isn't available yet.";
const NOT_READABLE = "This session can't be read right now.";

export const getItem = async (deps: Pick<SessionReadDependencies, "documentClient" | "tableName">, key: { pk: string; sk: string }): Promise<Item | undefined> =>
  ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Item }).Item;
export const isoOf = (ms: number) => new Date(ms).toISOString();
export const nameOrSomeone = (name: string | undefined) => (name === undefined ? undefined : cleanSessionName(name)) ?? "Someone";

/** `{ requestId }` and nothing else: the id names one action on one session. */
export function parseControlBody(body: unknown): z.infer<typeof BodySchema> {
  const parsed = BodySchema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const path = issue === undefined || issue.path.length === 0 ? "body" : issue.path.join(".");
  throw agentXError("CONFIG_INVALID", `${path}: ${issue === undefined || issue.code === "unrecognized_keys" ? "has a field this route does not take" : issue.message}`);
}

// ---- the request item

/** What a stop or a retry answered, kept under its request id on the session so a repeat answers it again and writes nothing. */
export interface ControlRequest {
  action: "stop" | "retry" | "handoff" | "answer" | "redirect";
  by: string;
  at: string;
  /** The session that answers the request: the same session, or the new one a retry made. */
  sessionId: string;
  /** A move between a Mac and the cloud (Task 19) keeps what it asked, so the same id with another body is refused, and what it answered to a move to a Mac. */
  fingerprint?: string | undefined;
  result?: unknown;
  /** An answer's request also keeps a digest of what was answered, so the same id with other answers is told from a repeat. */
  bodyHash?: string;
}

export const requestKey = (orgId: OrgId, sessionId: string, requestId: string) => agentSessionKey(orgId, sessionId, `REQUEST#${requestId}`);

export async function readControlRequest(deps: SessionReadDependencies, session: Pick<AgentSessionRecord, "orgId" | "sessionId">, requestId: string): Promise<ControlRequest | undefined> {
  const item = await getItem(deps, requestKey(session.orgId, session.sessionId, requestId));
  if (item === undefined) return undefined;
  const { action, by, at, sessionId, fingerprint, result, bodyHash } = item;
  if ((action !== "stop" && action !== "retry" && action !== "handoff" && action !== "answer" && action !== "redirect") || typeof by !== "string" || typeof at !== "string" || typeof sessionId !== "string") throw agentXError("RUNTIME_UNAVAILABLE", NOT_READABLE);
  return { action, by, at, sessionId, ...(typeof fingerprint === "string" ? { fingerprint } : {}), ...(result === undefined ? {} : { result }), ...(typeof bodyHash === "string" ? { bodyHash } : {}) };
}

/** The request item for the transaction that records the action. */
export function controlRequestItem(deps: Pick<SessionReadDependencies, "tableName">, session: Pick<AgentSessionRecord, "orgId" | "sessionId">, requestId: string, request: ControlRequest, expiresAt: number): TransactItem {
  return {
    Put: {
      TableName: deps.tableName, ConditionExpression: "attribute_not_exists(pk)",
      Item: { ...requestKey(session.orgId, session.sessionId, requestId), entityType: "AGENT_SESSION_REQUEST", orgId: session.orgId, ...request, [INDEX_EXPIRY_ATTRIBUTE]: expiresAt },
    },
  };
}

export const isEnded = (session: AgentSessionRecord): boolean => session.endedAt !== undefined || (ENDED_SESSION_STATUSES as readonly string[]).includes(session.summary.status);

/** A task of the session's own org, or undefined. */
export async function taskOfSession(deps: SessionReadDependencies, session: AgentSessionRecord): Promise<DeveloperTaskRecord | undefined> {
  if (session.subject.kind !== "task") return undefined;
  const task = await getItem(deps, taskKey(session.subject.taskId));
  if (task === undefined || task["orgId"] !== session.orgId) throw agentXError("NOT_FOUND", "session not found");
  return task as unknown as DeveloperTaskRecord;
}

/** After the commit: the session's summary is recomputed so its status shows at once (stopped, cancelled, running), and the owner and followers are told. Never throws. */
export async function afterControl(deps: SessionReadDependencies, session: AgentSessionRecord, actorId: string, effectiveOwnerId: string): Promise<void> {
  const log = deps.log ?? ((entry: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", ...entry })));
  try {
    await refreshSessionSummary({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, log: (entry) => log(entry) }, session.orgId, session.sessionId);
  } catch (error) {
    log({ event: "agent_session.control_refresh_failed", sessionId: session.sessionId, error: error instanceof Error ? error.name : "unknown" });
  }
  await tell(deps, session, effectiveOwnerId, actorId, isoOf(deps.now()));
}

/** The answer to a stop or retry: the session as `GET` shows it to the caller. */
export async function answerOf(deps: SessionReadDependencies, caller: SessionReadCaller, sessionId: string, stop?: StopNote): Promise<{ session: SessionView } & Partial<StopNote>> {
  return { session: await sessionView(deps, caller, sessionId), ...(stop ?? {}) };
}

/** What a stop that found nothing to stop tells the page: that fact, and (for a blocked task only Close may end) why. */
export type StopNote = { stop: "NOTHING_RUNNING"; message?: string };

/** What a stop remembers about its answer: only the one fact the page needs, that the stop found nothing to stop. */
const stopOf = (prior: ControlRequest): StopNote | undefined => {
  const result = prior.result as { stop?: unknown; message?: unknown } | null | undefined;
  if (typeof result !== "object" || result === null || result.stop !== "NOTHING_RUNNING") return undefined;
  return { stop: "NOTHING_RUNNING", ...(typeof result.message === "string" ? { message: result.message } : {}) };
};

/** A stop or retry that finds its request item is a repeat of that request: the same id for the other action is a mistake. */
export function repeatOf(prior: ControlRequest, action: ControlRequest["action"], by: string): ControlRequest {
  if (prior.action !== action || prior.by !== by) throw agentXError("IDEMPOTENCY_CONFLICT", "this request_id was already used for another action on this session; use a new request_id");
  return prior;
}

// ---- stop

/**
 * `POST /v1/app/sessions/{id}/stop` `{ requestId }`. Needs "can edit" (an org owner or admin may stop with `view`). An ended session is `SESSION_ENDED`; a session on a Mac waits for a
 * later task. A task session is stopped by Plan 3's cancel; a chain session by Plan 4's, and without it nothing is written. Answers the session.
 */
export async function stopSession(deps: SessionReadDependencies, caller: ControlCaller, sessionId: string, body: unknown): Promise<{ session: SessionView } & Partial<StopNote>> {
  const input = parseControlBody(body);
  const access: SessionAccess = await requireSessionLevel(deps, caller, sessionId, "edit", "stop it", { orgAdminMay: true });
  const { session } = access;
  const prior = await readControlRequest(deps, session, input.requestId);
  if (prior !== undefined) {
    repeatOf(prior, "stop", caller.developerId);
    return answerOf(deps, caller, session.sessionId, stopOf(prior));
  }
  if (isEnded(session)) throw agentXError("SESSION_ENDED", SESSION_ENDED_MESSAGE);
  // A session on a Mac is stopped by telling its device (Task 18).
  if (session.kind === "local") return stopLocalSession(deps, caller, access, input.requestId);
  if (session.where.kind !== "cloud") throw agentXError("RUNTIME_UNAVAILABLE", MAC_STOP_UNAVAILABLE);

  let related: string;
  let note: StopNote | undefined;
  if (session.subject.kind === "chain") {
    // Without Plan 4's chain control (no chain runs in this deployment) a chain run is not stopped, and nothing is written.
    if (deps.chainControl === undefined) throw agentXError("RUNTIME_UNAVAILABLE", CHAIN_STOP_UNAVAILABLE);
    related = session.subject.chainRunId;
    await deps.chainControl.cancel(session.orgId, { kind: "session", developerId: caller.developerId }, related, input.requestId);
  } else if (session.subject.kind === "task") {
    if (deps.control === undefined) throw agentXError("RUNTIME_UNAVAILABLE", NOT_AVAILABLE);
    const task = await taskOfSession(deps, session);
    if (task === undefined) throw agentXError("NOT_FOUND", "session not found");
    related = task.taskId;
    const cancelled = await deps.control.cancelTask(task, input.requestId);
    if (cancelled?.nothingRunning === true) note = { stop: "NOTHING_RUNNING", ...(cancelled.message === undefined ? {} : { message: cancelled.message }) };
  } else {
    throw agentXError("RUNTIME_UNAVAILABLE", MAC_STOP_UNAVAILABLE);
  }

  const nowMs = deps.now();
  const at = isoOf(nowMs);
  const name = nameOrSomeone(caller.name);
  const orgId = session.orgId;
  // A stop that only told the person to use Close task changed nothing: no "stopped" event, no stop audit (the request item still makes a repeat answer the same).
  const changedNothing = note?.message !== undefined;
  const events = changedNothing ? [] : await tryAuditEvents(deps, () => [auditSessionStopped({
    orgId, actor: auditActorOf(caller.developerId), occurredAt: at, occurrence: input.requestId, related: [related], sessionId: session.sessionId, sessionKind: session.kind,
  })]);
  const items: TransactItem[] = [
    controlRequestItem(deps, session, input.requestId, { action: "stop", by: caller.developerId, at, sessionId: session.sessionId, ...(note === undefined ? {} : { result: note }) }, Math.floor(nowMs / 1000) + 30 * 86_400),
    ...(changedNothing ? [] : [sessionEventItem(deps, { orgId, sessionId: session.sessionId }, {
      eventId: sessionEventId("stopped", input.requestId), at, type: "stopped", actor: { kind: "member", developerId: caller.developerId, name }, text: `${name} stopped this session.`,
    })]),
    ...events.flatMap((event) => auditPending(deps, event)),
  ];
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (error) {
    // A condition failed: the same request was recorded by another call at the same moment; its answer is this one's.
    const failed = failedIndexes(error);
    if (failed === undefined || failed.size === 0) throw error;
    const recorded = await readControlRequest(deps, session, input.requestId);
    if (recorded === undefined) throw error;
    repeatOf(recorded, "stop", caller.developerId);
    return answerOf(deps, caller, session.sessionId, stopOf(recorded));
  }
  await flushAuditEvents(deps, events);
  await afterControl(deps, session, caller.developerId, access.effectiveOwner.developerId);
  return answerOf(deps, caller, session.sessionId, note);
}

// ---- close

const CloseBodySchema = z.object({ requestId: z.string().uuid(), discardUnpublished: z.boolean().optional() }).strict();
export const CLOSE_UNAVAILABLE = "Closing a task isn't available right now.";
/** A chain run or a session on a Mac has no cloud task to close here. */
export const CLOSE_NOT_A_TASK = "This session has no cloud task to close.";

/**
 * `POST /v1/app/sessions/{id}/close` `{ requestId, discardUnpublished? }`: closes the session's task exactly as `POST /v1/dev/tasks/{id}/close` does (same owner check, same request id, the same
 * check for unpublished work that stops the close until the person agrees to discard it). The task's close answers whether it is closed; this adds the session as `GET` shows it. A repeat of the
 * same request id is the task close's own repeat. Needs "can edit" on the session; only the task's owner passes the close itself.
 */
export async function closeSession(deps: SessionReadDependencies, caller: ControlCaller, sessionId: string, body: unknown): Promise<z.infer<typeof SessionCloseResponseSchema>> {
  const parsed = CloseBodySchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue === undefined || issue.path.length === 0 ? "body" : issue.path.join(".");
    throw agentXError("CONFIG_INVALID", `${path}: ${issue === undefined || issue.code === "unrecognized_keys" ? "has a field this route does not take" : issue.message}`);
  }
  const input = parsed.data;
  const access: SessionAccess = await requireSessionLevel(deps, caller, sessionId, "edit", "close it");
  const { session } = access;
  if (session.subject.kind !== "task" || session.kind === "local" || session.where.kind !== "cloud") throw agentXError("RUNTIME_UNAVAILABLE", CLOSE_NOT_A_TASK);
  if (deps.control?.closeTask === undefined) throw agentXError("RUNTIME_UNAVAILABLE", CLOSE_UNAVAILABLE);
  const task = await taskOfSession(deps, session);
  if (task === undefined) throw agentXError("NOT_FOUND", "session not found");
  const closed = await deps.control.closeTask(task, { requestId: input.requestId, discardUnpublished: input.discardUnpublished === true });
  await afterControl(deps, session, caller.developerId, access.effectiveOwner.developerId);
  const { session: view } = await answerOf(deps, caller, session.sessionId);
  return {
    session: view, closed: closed.closed,
    ...(closed.discardedUnpublished === undefined ? {} : { discardedUnpublished: closed.discardedUnpublished }),
    ...(closed.unpublished === undefined ? {} : { unpublished: closed.unpublished }),
    ...(closed.message === undefined ? {} : { message: closed.message }),
  };
}

// ---- a session on a Mac

const STOP_ATTEMPTS = 3;
const BUSY = "This session is busy right now. Try again.";

/**
 * Stops a local session: a `stop` command for its device, the request item (so a repeat adds no second command), the `stopped` event and the audit item, in ONE transaction. The
 * session's own state is what the Mac reports next (it stops, and says so), so the session stays as it is until then. The device must be the owner's and live, else nothing is written.
 */
async function stopLocalSession(deps: SessionReadDependencies, caller: ControlCaller, access: SessionAccess, requestId: string): Promise<{ session: SessionView }> {
  const { session } = access;
  const orgId = session.orgId;
  for (let attempt = 1; attempt <= STOP_ATTEMPTS; attempt += 1) {
    const device = await commandableDevice(deps, session);
    if (device === undefined) throw agentXError("RUNTIME_UNAVAILABLE", MAC_NOT_AVAILABLE_MESSAGE);
    const nowMs = deps.now();
    const at = isoOf(nowMs);
    const name = nameOrSomeone(caller.name);
    const command = await deviceCommandItems(deps, { orgId, deviceId: device.deviceId, ownerId: session.owner.developerId }, {
      kind: "stop", sessionId: session.sessionId, by: { developerId: caller.developerId, name },
    }, nowMs);
    // 20 stops an hour for a session, counted in this transaction: a stop that is asked again with a new request id still adds a command.
    const rate = await limitStep(deps, { kind: "session", orgId, sessionId: session.sessionId }, "stop", LOCAL_STOPS_PER_HOUR, LOCAL_HOUR_MS, nowMs);
    if (!rate.room) throw agentXError("TOO_MANY_REQUESTS", LOCAL_STOP_RATE_MESSAGE);
    const events = await tryAuditEvents(deps, () => [auditSessionStopped({
      orgId, actor: auditActorOf(caller.developerId), occurredAt: at, occurrence: requestId, related: [device.deviceId], sessionId: session.sessionId, sessionKind: session.kind,
    })]);
    const items: TransactItem[] = [
      ...command.items,
      rate.item,
      controlRequestItem(deps, session, requestId, { action: "stop", by: caller.developerId, at, sessionId: session.sessionId }, Math.floor(nowMs / 1000) + 30 * 86_400),
      sessionEventItem(deps, { orgId, sessionId: session.sessionId }, {
        eventId: sessionEventId("stopped", requestId), at, type: "stopped", actor: { kind: "member", developerId: caller.developerId, name }, text: `${name} stopped this session.`,
      }),
      ...events.flatMap((event) => auditPending(deps, event)),
    ];
    try {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
    } catch (error) {
      if (isTransactionConflict(error)) continue;
      const failed = failedIndexes(error);
      if (failed === undefined || failed.size === 0) throw error;
      // The same request was recorded by another call at the same moment: its answer is this one's.
      const recorded = await readControlRequest(deps, session, requestId);
      if (recorded !== undefined) {
        repeatOf(recorded, "stop", caller.developerId);
        return answerOf(deps, caller, session.sessionId);
      }
      // The device's count or the device itself moved: read them again.
      continue;
    }
    await flushAuditEvents(deps, events);
    await announceDeviceCommand(deps, orgId, session.owner.developerId, device.deviceId, command.seq);
    await afterControl(deps, session, caller.developerId, access.effectiveOwner.developerId);
    return answerOf(deps, caller, session.sessionId);
  }
  throw agentXError("RUNTIME_UNAVAILABLE", BUSY);
}
