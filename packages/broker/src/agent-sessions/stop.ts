// Stopping a session (Plan 5 Task 13), and what stop and retry share. Stop acts on paid work, so it is Plan 3's own cancel (the one `POST /v1/dev/tasks/{id}/cancel` runs), asked for by the
// session actor after the session level was read live: "can edit", or an org owner or admin (`view` plus Stop). Plan 3's cancel is idempotent by the request id, so a repeat of the
// request writes nothing, and a request that was cancelled but never recorded is finished by asking again. A task session stays open and shows `stopped` (an agent-step run ends
// `cancelled`, which Plan 3 does); a budget pause stays a pause (the summary reads the task, and a stop never turns a pause into a failure). A chain session is stopped through
// Plan 4's `cancelChainRun` with the session actor, behind a seam: without it the stop is refused before anything is written. The stop is recorded in ONE transaction: the request
// item (so a repeat answers the stored outcome), the session's `stopped` event and the audit item.
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import {
  ENDED_SESSION_STATUSES,
  INDEX_EXPIRY_ATTRIBUTE,
  SESSION_ENDED_MESSAGE,
  agentSessionKey,
  agentXError,
  cleanSessionName,
  sessionEventId,
  type AgentSessionRecord,
  type OrgId,
  type SessionView,
} from "@agentx/contracts";
import type { AgentRunRequest, AgentRunResult } from "../agents/runs.js";
import { failedIndexes, type Item, type TransactItem } from "../agents/table-writes.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditSessionStopped } from "../audit/events.js";
import { auditPending, tryAuditEvents } from "../audit/outbox.js";
import { auditActorOf } from "../audit/plan3-hooks.js";
import { taskKey, type DeveloperTaskRecord } from "../developer/task-records.js";
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
  cancelTask(task: DeveloperTaskRecord, requestId: string): Promise<void>;
  /** `retryTaskWorkflowFor` with the session actor, at the task's revision now: the same retry as the task's own route. */
  retryWorkflow(task: DeveloperTaskRecord, requestId: string): Promise<void>;
  /** `startAgentRun`, which resolves the payer and applies the roster, budget and version rules; it is idempotent by the request's `requestId`. */
  startAgentRun(request: AgentRunRequest): Promise<AgentRunResult>;
}

/**
 * Plan 4's chain lifecycle as far as a session needs it, called with the internal session actor after Plan 5's own level check (Plan 4, M2): `cancelChainRun` ends the run (its
 * gate approval closes with it) and `retryChainRun` starts a new run of the same chain version and input (`startChainRun` applies Plan 4's `use` rule) and answers the new run's session.
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
  action: "stop" | "retry";
  by: string;
  at: string;
  /** The session that answers the request: the same session, or the new one a retry made. */
  sessionId: string;
}

export const requestKey = (orgId: OrgId, sessionId: string, requestId: string) => agentSessionKey(orgId, sessionId, `REQUEST#${requestId}`);

export async function readControlRequest(deps: SessionReadDependencies, session: Pick<AgentSessionRecord, "orgId" | "sessionId">, requestId: string): Promise<ControlRequest | undefined> {
  const item = await getItem(deps, requestKey(session.orgId, session.sessionId, requestId));
  if (item === undefined) return undefined;
  const { action, by, at, sessionId } = item;
  if ((action !== "stop" && action !== "retry") || typeof by !== "string" || typeof at !== "string" || typeof sessionId !== "string") throw agentXError("RUNTIME_UNAVAILABLE", NOT_READABLE);
  return { action, by, at, sessionId };
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
export async function answerOf(deps: SessionReadDependencies, caller: SessionReadCaller, sessionId: string): Promise<{ session: SessionView }> {
  return { session: await sessionView(deps, caller, sessionId) };
}

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
export async function stopSession(deps: SessionReadDependencies, caller: ControlCaller, sessionId: string, body: unknown): Promise<{ session: SessionView }> {
  const input = parseControlBody(body);
  const access: SessionAccess = await requireSessionLevel(deps, caller, sessionId, "edit", "stop it", { orgAdminMay: true });
  const { session } = access;
  const prior = await readControlRequest(deps, session, input.requestId);
  if (prior !== undefined) {
    repeatOf(prior, "stop", caller.developerId);
    return answerOf(deps, caller, session.sessionId);
  }
  if (isEnded(session)) throw agentXError("SESSION_ENDED", SESSION_ENDED_MESSAGE);
  if (session.kind === "local" || session.where.kind !== "cloud") throw agentXError("RUNTIME_UNAVAILABLE", MAC_STOP_UNAVAILABLE);

  let related: string;
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
    await deps.control.cancelTask(task, input.requestId);
  } else {
    throw agentXError("RUNTIME_UNAVAILABLE", MAC_STOP_UNAVAILABLE);
  }

  const nowMs = deps.now();
  const at = isoOf(nowMs);
  const name = nameOrSomeone(caller.name);
  const orgId = session.orgId;
  const events = await tryAuditEvents(deps, () => [auditSessionStopped({
    orgId, actor: auditActorOf(caller.developerId), occurredAt: at, occurrence: input.requestId, related: [related], sessionId: session.sessionId, sessionKind: session.kind,
  })]);
  const items: TransactItem[] = [
    controlRequestItem(deps, session, input.requestId, { action: "stop", by: caller.developerId, at, sessionId: session.sessionId }, Math.floor(nowMs / 1000) + 30 * 86_400),
    sessionEventItem(deps, { orgId, sessionId: session.sessionId }, {
      eventId: sessionEventId("stopped", input.requestId), at, type: "stopped", actor: { kind: "member", developerId: caller.developerId, name }, text: `${name} stopped this session.`,
    }),
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
    return answerOf(deps, caller, session.sessionId);
  }
  await flushAuditEvents(deps, events);
  await afterControl(deps, session, caller.developerId, access.effectiveOwner.developerId);
  return answerOf(deps, caller, session.sessionId);
}
