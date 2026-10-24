// Retrying a session (Plan 5 Task 13). A retry can spend money, so it re-checks everything live and starts at most one run:
//   - the caller needs "can edit" on the session and a project role that starts work (read now, as the owner's retry reads it);
//   - a Rovara Code task whose workflow is BLOCKED goes on in the SAME session through Plan 3's workflow retry (the same run continues, so its payer keeps paying: the budget that is
//     checked is that payer's, and Plan 3's own approval gate still refuses a retry that would skip an approval the person may not decide);
//   - a failed or cancelled agent-step run, or a failed chain run, starts a NEW run of the same agent version (or chain version) and input, started by the retrier, who owns the
//     new session and pays for it when the payer is a person. The run's request id is derived from the old session, so however many times it is asked for, Plan 3's start makes one run,
//     and the retry is linked (`retryOf`, the old session's `retried` event, the one-time `RETRIED` mark) in ONE transaction that a repeat of the request completes if it was lost;
//   - a failed plain (CLI) task is continued by its owner where it started; a session on a Mac is retried there; anything else has nothing to retry.
// The chain parts are behind Plan 4's seam and refuse before anything is written when it is not wired.
import { createHash } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  AgentRunStateSchema,
  agentSessionKey,
  agentXError,
  INDEX_EXPIRY_ATTRIBUTE,
  projectAllows,
  sessionEventId,
  type AgentSessionRecord,
  type OrgId,
  type SessionView,
  type WorkOrigin,
} from "@agentx/contracts";
import { paymentOfTask } from "../spend/payer.js";
import { failedIndexes, strip, type TransactItem } from "../agents/table-writes.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditSessionRetried } from "../audit/events.js";
import { auditPending, tryAuditEvents } from "../audit/outbox.js";
import { auditActorOf } from "../audit/plan3-hooks.js";
import { taskAgentRunKey, taskKey, type DeveloperTaskRecord } from "../developer/task-records.js";
import { requireSessionLevel, type SessionAccess } from "./access.js";
import type { SessionReadDependencies } from "./read.js";
import { sessionEventItem } from "./store.js";
import {
  afterControl, answerOf, controlRequestItem, getItem, isEnded, isoOf, nameOrSomeone, parseControlBody, readControlRequest, repeatOf, taskOfSession,
  type ControlCaller,
} from "./stop.js";

export const NOTHING_TO_RETRY = "There's nothing to retry right now.";
export const RETRY_ON_MAC = "Retry it on your Mac.";
const ALREADY_RETRIED = "This session was already retried.";
const CHAIN_RETRY_UNAVAILABLE = "Retrying a chain run isn't available right now.";
const NOT_AVAILABLE = "Retrying a session isn't available right now.";
const NOT_READABLE = "This session can't be read right now.";
const NOT_LINKED = "The new session isn't ready yet. Try again in a moment.";
/** Where a retry's new run says it came from when its first came from nowhere a person sits (an event, a schedule, a chain). */
const FALLBACK_ORIGIN: WorkOrigin = "app";
const KEEPS_ORIGIN: readonly WorkOrigin[] = ["app", "cli", "mcp", "slack", "test_run"];
const MONTH_SECONDS = 30 * 86_400;

/**
 * The request id the new run is started with: derived from the org and the old session, so every retry of one session names the same run. Plan 3's start answers a repeat of a
 * request with the first run (the same person) or refuses it (another person), so a session is retried into at most one run, whatever request ids come in.
 */
export function retryRunRequestId(orgId: OrgId, sessionId: string): string {
  const bytes = createHash("sha256").update(`session-retry\n${orgId}\n${sessionId}`, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const retriedKey = (orgId: OrgId, sessionId: string) => agentSessionKey(orgId, sessionId, "RETRIED");

const isAgentXError = (error: unknown): error is Error & { code?: string } => error instanceof Error && error.name === "AgentXError";

/** The role the caller needs on the session's project to retry work there. */
async function requireStartWork(deps: SessionReadDependencies, caller: ControlCaller, access: SessionAccess): Promise<void> {
  const project = access.session.project;
  if (project === undefined) return;
  const role = await deps.projectMembers.roleOf(caller.orgId, project, { developerId: caller.developerId, orgRole: access.orgRole });
  if (role === undefined || !projectAllows(role, "start_tasks")) throw agentXError("FORBIDDEN", `You need a role on ${project} that can start work to retry this.`);
}

/** Runs the budget check for the payer who keeps paying; a proxy outage is a retryable fault, never a refusal of the person. */
async function admitCurrentPayer(deps: SessionReadDependencies, session: AgentSessionRecord, task: DeveloperTaskRecord): Promise<void> {
  if (deps.admitPayer === undefined || session.project === undefined) return;
  const { payer, agentId } = paymentOfTask(task);
  try {
    await deps.admitPayer({
      orgId: session.orgId, project: session.project, payer, agentId, agentName: task.agent?.name ?? session.agent?.name ?? "Rovara Code", path: task.agent === undefined || agentId === "rovara-code" ? "TASK" : "AGENT",
    });
  } catch (error) {
    if (error instanceof Error && (error as { code?: string }).code === "MODEL_PROXY_UNAVAILABLE") throw agentXError("RUNTIME_UNAVAILABLE", "Rovara couldn't check the budget just now. Try again in a moment.");
    throw error;
  }
}

/** Commits the items of a retry; a lost condition means the same request (or the one retry) was recorded first, and its answer is this one's. */
async function commit(
  deps: SessionReadDependencies, caller: ControlCaller, session: AgentSessionRecord, requestId: string, items: TransactItem[],
): Promise<{ session: SessionView } | undefined> {
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
    return undefined;
  } catch (error) {
    const failed = failedIndexes(error);
    if (failed === undefined || failed.size === 0) throw error;
    const recorded = await readControlRequest(deps, session, requestId);
    if (recorded !== undefined) {
      repeatOf(recorded, "retry", caller.developerId);
      return answerOf(deps, caller, recorded.sessionId);
    }
    const marked = await getItem(deps, retriedKey(session.orgId, session.sessionId));
    if (marked !== undefined && marked["by"] === caller.developerId && typeof marked["sessionId"] === "string") return answerOf(deps, caller, marked["sessionId"]);
    if (marked !== undefined) throw agentXError("CONFIG_INVALID", ALREADY_RETRIED);
    throw error;
  }
}

/**
 * `POST /v1/app/sessions/{id}/retry` `{ requestId }`. Answers the session that carries on: the same one, or the new one a retry made.
 */
export async function retrySession(deps: SessionReadDependencies, caller: ControlCaller, sessionId: string, body: unknown): Promise<{ session: SessionView }> {
  const input = parseControlBody(body);
  const access = await requireSessionLevel(deps, caller, sessionId, "edit", "retry it");
  const { session } = access;
  const prior = await readControlRequest(deps, session, input.requestId);
  if (prior !== undefined) {
    repeatOf(prior, "retry", caller.developerId);
    return answerOf(deps, caller, prior.sessionId);
  }
  if (session.kind === "local" || session.where.kind !== "cloud") throw agentXError("CONFIG_INVALID", RETRY_ON_MAC);
  await requireStartWork(deps, caller, access);
  if (session.subject.kind === "chain") return retryChain(deps, caller, access, input.requestId);

  const task = await taskOfSession(deps, session);
  if (task === undefined) throw agentXError("NOT_FOUND", "session not found");
  if (task.workflow !== undefined) return retryWorkflow(deps, caller, access, task, input.requestId);
  if (task.agent !== undefined) return retryRun(deps, caller, access, task, input.requestId);
  // A plain (CLI) task is continued by its owner where it started it.
  if (session.summary.lastRunFailed === true || session.summary.status === "failed") {
    const client = nameOrClient(task.client);
    throw agentXError("CONFIG_INVALID", `Continue this task from ${client}.`);
  }
  throw agentXError("CONFIG_INVALID", NOTHING_TO_RETRY);
}

/** The tool a task was started from, as one line a person reads; "where you started it" for a task that names none. */
function nameOrClient(client: string | undefined): string {
  const clean = (client ?? "").replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim();
  return clean === "" ? "where you started it" : [...clean].slice(0, 60).join("");
}

// ---- the same run, in the same session

async function retryWorkflow(deps: SessionReadDependencies, caller: ControlCaller, access: SessionAccess, task: DeveloperTaskRecord, requestId: string): Promise<{ session: SessionView }> {
  const { session } = access;
  if (isEnded(session) || task.workflow?.state !== "BLOCKED") throw agentXError("CONFIG_INVALID", NOTHING_TO_RETRY);
  if (deps.control === undefined) throw agentXError("RUNTIME_UNAVAILABLE", NOT_AVAILABLE);
  // The payer keeps paying (it is the same run), so their room is what is checked, and nothing is asked of Plan 3 when there is none.
  await admitCurrentPayer(deps, session, task);
  try {
    await deps.control.retryWorkflow(task, requestId);
  } catch (error) {
    // Plan 3 may fail after its transaction committed (the run is queued and spend can start). A retry that started a run is recorded whatever came after: the workflow moved on from the
    // revision this retry read, and the event, the request item and the audit item are written. A workflow that did not move is a refusal, and nothing is written.
    if (!await workflowMovedOn(deps, session, task)) throw error;
  }

  const nowMs = deps.now();
  const at = isoOf(nowMs);
  const name = nameOrSomeone(caller.name);
  const events = await tryAuditEvents(deps, () => [auditSessionRetried({
    orgId: session.orgId, actor: auditActorOf(caller.developerId), occurredAt: at, occurrence: requestId, related: [task.taskId], sessionId: session.sessionId, sessionKind: session.kind, branch: "workflow",
  })]);
  const items: TransactItem[] = [
    controlRequestItem(deps, session, requestId, { action: "retry", by: caller.developerId, at, sessionId: session.sessionId }, Math.floor(nowMs / 1000) + MONTH_SECONDS),
    sessionEventItem(deps, { orgId: session.orgId, sessionId: session.sessionId }, {
      eventId: sessionEventId("retried", requestId), at, type: "retried", actor: { kind: "member", developerId: caller.developerId, name }, text: `${name} retried this.`,
    }),
    ...events.flatMap((event) => auditPending(deps, event)),
  ];
  const repeated = await commit(deps, caller, session, requestId, items);
  if (repeated !== undefined) return repeated;
  await flushAuditEvents(deps, events);
  await afterControl(deps, session, caller.developerId, access.effectiveOwner.developerId);
  return answerOf(deps, caller, session.sessionId);
}

/** Whether the task's workflow left the blocked state this retry read it in (a run was queued by the retry), read fresh. */
async function workflowMovedOn(deps: SessionReadDependencies, session: AgentSessionRecord, read: DeveloperTaskRecord): Promise<boolean> {
  try {
    const fresh = await taskOfSession(deps, session);
    const before = read.workflow;
    const after = fresh?.workflow;
    return before !== undefined && after !== undefined && after.revision > before.revision && after.state !== "BLOCKED";
  } catch {
    return false;
  }
}

// ---- a new run

/** What a failed or cancelled agent-step run is retried from: its input, as the run kept it. */
async function inputOfRun(deps: SessionReadDependencies, task: DeveloperTaskRecord) {
  const item = await getItem(deps, taskAgentRunKey(task.taskId));
  if (item === undefined) throw agentXError("CONFIG_INVALID", NOTHING_TO_RETRY);
  const run = AgentRunStateSchema.safeParse(strip(item));
  if (!run.success) throw agentXError("RUNTIME_UNAVAILABLE", NOT_READABLE);
  return run.data;
}

async function retryRun(deps: SessionReadDependencies, caller: ControlCaller, access: SessionAccess, task: DeveloperTaskRecord, requestId: string): Promise<{ session: SessionView }> {
  const { session } = access;
  if (task.agent === undefined) throw agentXError("CONFIG_INVALID", NOTHING_TO_RETRY);
  const run = await inputOfRun(deps, task);
  if (run.state !== "FAILED" && run.state !== "CANCELLED") throw agentXError("CONFIG_INVALID", NOTHING_TO_RETRY);
  if (deps.control === undefined) throw agentXError("RUNTIME_UNAVAILABLE", NOT_AVAILABLE);

  const marked = await getItem(deps, retriedKey(session.orgId, session.sessionId));
  if (marked !== undefined) {
    if (marked["by"] === caller.developerId && typeof marked["sessionId"] === "string") return answerOf(deps, caller, marked["sessionId"]);
    throw agentXError("CONFIG_INVALID", ALREADY_RETRIED);
  }

  let started: { taskId: string };
  try {
    started = await deps.control.startAgentRun({
      requestId: retryRunRequestId(session.orgId, session.sessionId), orgId: session.orgId, project: task.project, agent: { agentId: task.agent.agentId, version: task.agent.version }, input: run.input,
      origin: task.origin !== undefined && KEEPS_ORIGIN.includes(task.origin) ? task.origin : FALLBACK_ORIGIN, owner: { developerId: caller.developerId }, startedBy: { developerId: caller.developerId },
    });
  } catch (error) {
    // The request id of this retry was used by another person's retry of the same session.
    if (isAgentXError(error) && error.code === "IDEMPOTENCY_CONFLICT") throw agentXError("CONFIG_INVALID", ALREADY_RETRIED);
    throw error;
  }
  const created = await getItem(deps, taskKey(started.taskId));
  const newSessionId = created !== undefined && created["orgId"] === session.orgId && typeof created["sessionId"] === "string" ? created["sessionId"] : undefined;
  if (newSessionId === undefined) throw agentXError("RUNTIME_UNAVAILABLE", NOT_LINKED);
  return link(deps, caller, access, { requestId, newSessionId, related: [task.taskId, newSessionId], branch: "new_run" });
}

// ---- a chain run

async function retryChain(deps: SessionReadDependencies, caller: ControlCaller, access: SessionAccess, requestId: string): Promise<{ session: SessionView }> {
  const { session } = access;
  if (session.subject.kind !== "chain") throw agentXError("CONFIG_INVALID", NOTHING_TO_RETRY);
  if (session.summary.status !== "failed") throw agentXError("CONFIG_INVALID", NOTHING_TO_RETRY);
  // PLAN4: until Plan 4's lifecycle is wired a chain run is not retried, and nothing is written.
  if (deps.chainControl === undefined) throw agentXError("RUNTIME_UNAVAILABLE", CHAIN_RETRY_UNAVAILABLE);
  const marked = await getItem(deps, retriedKey(session.orgId, session.sessionId));
  if (marked !== undefined) {
    if (marked["by"] === caller.developerId && typeof marked["sessionId"] === "string") return answerOf(deps, caller, marked["sessionId"]);
    throw agentXError("CONFIG_INVALID", ALREADY_RETRIED);
  }
  // Plan 4 starts the run (and applies the chain's `use` rule) under the derived id, so a session is retried into one chain run.
  const started = await deps.chainControl.retry({ kind: "session", developerId: caller.developerId }, session.subject.chainRunId, retryRunRequestId(session.orgId, session.sessionId));
  return link(deps, caller, access, { requestId, newSessionId: started.sessionId, related: [session.subject.chainRunId, started.sessionId], branch: "new_chain_run" });
}

// ---- linking the new session to the old

/**
 * ONE transaction: the request item and the one-time `RETRIED` mark on the old session, its `retried` event, the new session's `retryOf` (written only if it has none), and the audit
 * item. A repeat of the request, or a second request by the same person, finds the mark and answers the new session.
 */
async function link(
  deps: SessionReadDependencies, caller: ControlCaller, access: SessionAccess,
  input: { requestId: string; newSessionId: string; related: string[]; branch: "new_run" | "new_chain_run" },
): Promise<{ session: SessionView }> {
  const { session } = access;
  const orgId = session.orgId;
  const nowMs = deps.now();
  const at = isoOf(nowMs);
  const name = nameOrSomeone(caller.name);
  const events = await tryAuditEvents(deps, () => [auditSessionRetried({
    orgId, actor: auditActorOf(caller.developerId), occurredAt: at, occurrence: input.requestId, related: input.related, sessionId: session.sessionId, sessionKind: session.kind, branch: input.branch,
  })]);
  const expires = Math.floor(nowMs / 1000) + MONTH_SECONDS;
  const items: TransactItem[] = [
    controlRequestItem(deps, session, input.requestId, { action: "retry", by: caller.developerId, at, sessionId: input.newSessionId }, expires),
    {
      Put: {
        TableName: deps.tableName, ConditionExpression: "attribute_not_exists(pk)",
        Item: { ...retriedKey(orgId, session.sessionId), entityType: "AGENT_SESSION_RETRIED", orgId, sessionId: input.newSessionId, by: caller.developerId, requestId: input.requestId, at, [INDEX_EXPIRY_ATTRIBUTE]: expires },
      },
    },
    {
      Update: {
        TableName: deps.tableName, Key: agentSessionKey(orgId, input.newSessionId, "META"), UpdateExpression: "SET retryOf = :old ADD #revision :one",
        ConditionExpression: "attribute_exists(pk) AND orgId = :org AND attribute_not_exists(retryOf)", ExpressionAttributeNames: { "#revision": "revision" },
        ExpressionAttributeValues: { ":old": session.sessionId, ":one": 1, ":org": orgId },
      },
    },
    sessionEventItem(deps, { orgId, sessionId: session.sessionId }, {
      eventId: sessionEventId("retried", session.sessionId), at, type: "retried", actor: { kind: "member", developerId: caller.developerId, name }, text: `${name} retried this in a new session.`,
    }),
    ...events.flatMap((event) => auditPending(deps, event)),
  ];
  const repeated = await commit(deps, caller, session, input.requestId, items);
  if (repeated !== undefined) return repeated;
  await flushAuditEvents(deps, events);
  await afterControl(deps, session, caller.developerId, access.effectiveOwner.developerId);
  return answerOf(deps, caller, input.newSessionId);
}
