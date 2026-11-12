// Retrying a session (Plan 5 Task 13). A retry can spend money, so it re-checks everything live and starts at most one run:
//   - the caller needs "can edit" on the session and a project role that starts work (read now, as the owner's retry reads it);
//   - a Rovara Code task whose workflow is BLOCKED goes on in the SAME session through Plan 3's workflow retry (the same run continues, so its payer keeps paying: the budget that is
//     checked is that payer's, and Plan 3's own approval gate still refuses a retry that would skip an approval the person may not decide);
//   - a failed or cancelled agent-step run, or a failed chain run, starts a NEW run of the same agent version and input (a chain run: the chain's CURRENT published version, with the old run's input), started by the retrier, who owns the
//     new session and pays for it when the payer is a person. The run's request id is derived from the old session, so however many times it is asked for, Plan 3's start makes one run,
//     and the retry is linked (`retryOf`, the old session's `retried` event, the one-time `RETRIED` mark) in ONE transaction that a repeat of the request completes if it was lost;
//   - a failed plain (CLI) task is continued by its owner where it started; a session on a Mac is retried there; anything else has nothing to retry.
// The chain parts are behind Plan 4's seam and refuse before anything is written when it is not wired.
import { createHash } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { AgentRunStateSchema, agentSessionKey, agentXError, INDEX_EXPIRY_ATTRIBUTE, projectAllows, runRequestKey, sessionEventId, type AgentSessionRecord, type OrgId, type WorkOrigin } from "@rovara-code/contracts";
import { type SessionView } from "@agentx/cloud-contracts";
import { isRovaraCodeTask } from "../agents/rovara-code-task.js";
import { RUN_RECORD_MEMORY_DAYS } from "../agents/runs.js";
import { paymentOfTask } from "../spend/payer.js";
import { failedIndexes, strip, type TransactItem } from "../agents/table-writes.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditSessionRetried } from "../audit/events.js";
import { auditPending, tryAuditEvents } from "../audit/outbox.js";
import { auditActorOf } from "../audit/plan3-hooks.js";
import { taskAgentRunKey, taskKey, type DeveloperTaskRecord } from "../developer/task-records.js";
import { SETUP_DRAFT_RETRY_WORDS, requireSessionLevel, type SessionAccess } from "./access.js";
import type { SessionReadDependencies } from "./read.js";
import { AgentSessionStore, sessionEventItem } from "./store.js";
import {
  afterControl, answerOf, controlRequestItem, getItem, isEnded, isoOf, nameOrSomeone, parseControlBody, readControlRequest, repeatOf, taskOfSession,
  type ControlCaller,
} from "./stop.js";

export const NOTHING_TO_RETRY = "There's nothing to retry right now.";
export const RETRY_ON_MAC = "Retry it on your Mac.";
/** An ended session with no run to retry again (its run was never kept, or it was a plain task): the person is told a new task is the way on. */
export const ENDED_NOTHING_TO_RETRY = "This task has ended and has no run to retry. Start a new task.";
export { SETUP_DRAFT_RETRY_WORDS };
/** A workflow task that ended failed (its workspace setup failed: the workflow never started) is not retried; a retry would start no new workspace. */
export const FAILED_TASK_NEEDS_NEW_TASK = "This task failed and has ended, so it can't be retried. Start a new task; if its setup failed, fix the project's setup or test command first.";
const ALREADY_RETRIED = "This session was already retried.";
const CHAIN_RETRY_UNAVAILABLE = "Retrying a chain run isn't available right now.";
const NOT_AVAILABLE = "Retrying a session isn't available right now.";
const NOT_READABLE = "This session can't be read right now.";
const NOT_LINKED = "The new session isn't ready yet. Try again in a moment.";
/** Where a retry's new run says it came from when its first came from nowhere a person sits (an event, a schedule, a chain). */
const FALLBACK_ORIGIN: WorkOrigin = "app";
const KEEPS_ORIGIN: readonly WorkOrigin[] = ["app", "cli", "mcp", "slack", "test_run"];
/** How long a retry's marks last: as long as Plan 3 remembers the run's own request (`RUN_REQUEST`), so a repeat can never meet a start that still answers the first run while the marks of its link are gone. */
const KEEP_SECONDS = RUN_RECORD_MEMORY_DAYS * 86_400;

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
      orgId: session.orgId, project: session.project, payer, agentId, agentName: task.agent?.name ?? session.agent?.name ?? "Rovara Code", path: isRovaraCodeTask(task) ? "TASK" : "AGENT",
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
  // A setup draft has no run to start again: a new draft is asked for from the project's page.
  if (task.purpose === "setup_draft") throw agentXError("CONFIG_INVALID", SETUP_DRAFT_RETRY_WORDS);
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
  if (isEnded(session) || task.workflow?.state !== "BLOCKED") {
    // Only a failed ending says more than "nothing to retry": the person is told a new task is the way on (Bug F, v0.4.11 rehearsal).
    const failedAndEnded = isEnded(session) && session.summary.status === "failed" && task.outcome !== "creator_removed";
    throw agentXError("CONFIG_INVALID", failedAndEnded ? FAILED_TASK_NEEDS_NEW_TASK : NOTHING_TO_RETRY);
  }
  if (deps.control === undefined) throw agentXError("RUNTIME_UNAVAILABLE", NOT_AVAILABLE);
  // The payer keeps paying (it is the same run), so their room is what is checked, and nothing is asked of Plan 3 when there is none.
  await admitCurrentPayer(deps, session, task);
  try {
    await deps.control.retryWorkflow(task, requestId);
  } catch (error) {
    // Plan 3 may fail after its transaction committed (the run is queued and spend can start). A retry that started a run is recorded whatever came after: the workflow moved on from the
    // revision this retry read, and the event, the request item and the audit item are written. A workflow that did not move is a refusal, and nothing is written.
    if (!await workflowMovedOn(deps, session, task, requestId)) throw error;
  }

  const nowMs = deps.now();
  const at = isoOf(nowMs);
  const name = nameOrSomeone(caller.name);
  const events = await tryAuditEvents(deps, () => [auditSessionRetried({
    orgId: session.orgId, actor: auditActorOf(caller.developerId), occurredAt: at, occurrence: requestId, related: [task.taskId], sessionId: session.sessionId, sessionKind: session.kind, branch: "workflow",
  })]);
  const items: TransactItem[] = [
    controlRequestItem(deps, session, requestId, { action: "retry", by: caller.developerId, at, sessionId: session.sessionId }, Math.floor(nowMs / 1000) + KEEP_SECONDS),
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

/**
 * Whether Plan 3 committed THIS request's run before its call failed: the workflow's revision moved on from the one this retry read, and the idempotency item of this request id (written
 * in the transaction that starts the run) is there. The state alone is not asked: a run that stopped again before this looked is BLOCKED once more, and is still this retry's. Another
 * person's retry moves the revision too but leaves its own request id, never this one, so it is not recorded as this caller's.
 */
async function workflowMovedOn(deps: SessionReadDependencies, session: AgentSessionRecord, read: DeveloperTaskRecord, requestId: string): Promise<boolean> {
  try {
    const fresh = await taskOfSession(deps, session);
    const before = read.workflow;
    const after = fresh?.workflow;
    if (fresh === undefined || before === undefined || after === undefined || after.revision <= before.revision) return false;
    return await getItem(deps, { pk: `IDEMPOTENCY#${fresh.ownerKey}#${fresh.workspaceId}`, sk: `REQUEST#${requestId}` }) !== undefined;
  } catch {
    return false;
  }
}

// ---- a new run

/** What a failed or cancelled agent-step run is retried from: its input, as the run kept it. */
async function inputOfRun(deps: SessionReadDependencies, task: DeveloperTaskRecord, session: AgentSessionRecord) {
  const item = await getItem(deps, taskAgentRunKey(task.taskId));
  // An ended session that kept no run says so in words that name the way on, with its own code (a person was offered Stop or Retry for it once and met "nothing to retry").
  if (item === undefined) throw isEnded(session) ? agentXError("SESSION_ENDED", ENDED_NOTHING_TO_RETRY) : agentXError("CONFIG_INVALID", NOTHING_TO_RETRY);
  const run = AgentRunStateSchema.safeParse(strip(item));
  if (!run.success) throw agentXError("RUNTIME_UNAVAILABLE", NOT_READABLE);
  return run.data;
}

async function retryRun(deps: SessionReadDependencies, caller: ControlCaller, access: SessionAccess, task: DeveloperTaskRecord, requestId: string): Promise<{ session: SessionView }> {
  const { session } = access;
  if (task.agent === undefined) throw agentXError("CONFIG_INVALID", NOTHING_TO_RETRY);
  const run = await inputOfRun(deps, task, session);
  if (run.state !== "FAILED" && run.state !== "CANCELLED") throw agentXError("CONFIG_INVALID", NOTHING_TO_RETRY);
  if (deps.control === undefined) throw agentXError("RUNTIME_UNAVAILABLE", NOT_AVAILABLE);

  const marked = await getItem(deps, retriedKey(session.orgId, session.sessionId));
  if (marked !== undefined) {
    if (marked["by"] === caller.developerId && typeof marked["sessionId"] === "string") return answerOf(deps, caller, marked["sessionId"]);
    throw agentXError("CONFIG_INVALID", ALREADY_RETRIED);
  }

  // Plan 3 already started the run for this session's retry, and the link to it was lost (the process ended between the two): the link is made now, for the person who started
  // the run, and whoever asked is told what they would have been told had it landed.
  const derived = retryRunRequestId(session.orgId, session.sessionId);
  const begun = await getItem(deps, runRequestKey(session.orgId, derived));
  if (begun !== undefined) return repairLink(deps, caller, access, begun, requestId);

  let started: { taskId: string };
  try {
    started = await deps.control.startAgentRun({
      requestId: derived, orgId: session.orgId, project: task.project, agent: { agentId: task.agent.agentId, version: task.agent.version }, input: run.input,
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

/**
 * The run was started and the link was not made. The starter (the person on the run request, who owns the new session) is the retrier: the link is written as theirs, under the request
 * id of the repeat when they are the one repeating it, else under the derived id. Anyone else asking is told the session was already retried; a link that cannot be made
 * (the new session has a retry link of its own already) is never overwritten.
 */
async function repairLink(deps: SessionReadDependencies, caller: ControlCaller, access: SessionAccess, begun: Record<string, unknown>, requestId: string): Promise<{ session: SessionView }> {
  const { session } = access;
  const starterId = begun["developerId"];
  if (begun["orgId"] !== session.orgId || typeof starterId !== "string") throw agentXError("RUNTIME_UNAVAILABLE", NOT_LINKED);
  let newSessionId = typeof begun["sessionId"] === "string" ? begun["sessionId"] : undefined;
  if (newSessionId === undefined && typeof begun["taskId"] === "string") {
    const created = await getItem(deps, taskKey(begun["taskId"]));
    newSessionId = created !== undefined && created["orgId"] === session.orgId && typeof created["sessionId"] === "string" ? created["sessionId"] : undefined;
  }
  if (newSessionId === undefined) throw agentXError("RUNTIME_UNAVAILABLE", NOT_LINKED);
  const created = await new AgentSessionStore(deps).get(session.orgId, newSessionId);
  if (created === undefined) throw agentXError("RUNTIME_UNAVAILABLE", NOT_LINKED);
  const own = starterId === caller.developerId;
  const starter: ControlCaller = own ? caller : { ...caller, developerId: starterId, name: created.owner.developerId === starterId ? created.owner.name : "Someone" };
  const input = { requestId: own ? requestId : retryRunRequestId(session.orgId, session.sessionId), newSessionId, related: [typeof begun["taskId"] === "string" ? begun["taskId"] : session.sessionId, newSessionId], branch: "new_run" as const };
  if (created.retryOf === undefined) {
    try {
      const answered = await link(deps, starter, access, input);
      if (own) return answered;
    } catch (error) {
      // The starter can no longer be shown the new session (they left): the link is still made, and the person who asked is told as anyone else is.
      if (own || !isAgentXError(error) || error.code !== "NOT_FOUND") throw error;
    }
  } else if (own) {
    return answerOf(deps, caller, newSessionId);
  }
  throw agentXError("CONFIG_INVALID", ALREADY_RETRIED);
}

// ---- a chain run

async function retryChain(deps: SessionReadDependencies, caller: ControlCaller, access: SessionAccess, requestId: string): Promise<{ session: SessionView }> {
  const { session } = access;
  if (session.subject.kind !== "chain") throw agentXError("CONFIG_INVALID", NOTHING_TO_RETRY);
  if (session.summary.status !== "failed") throw agentXError("CONFIG_INVALID", NOTHING_TO_RETRY);
  // Without Plan 4's chain control (no chain runs in this deployment) a chain run is not retried, and nothing is written.
  if (deps.chainControl === undefined) throw agentXError("RUNTIME_UNAVAILABLE", CHAIN_RETRY_UNAVAILABLE);
  const marked = await getItem(deps, retriedKey(session.orgId, session.sessionId));
  if (marked !== undefined) {
    if (marked["by"] === caller.developerId && typeof marked["sessionId"] === "string") return answerOf(deps, caller, marked["sessionId"]);
    throw agentXError("CONFIG_INVALID", ALREADY_RETRIED);
  }
  // Plan 4 starts the run (and applies the chain's `use` rule) under the derived id, so a session is retried into one chain run.
  const started = await deps.chainControl.retry(session.orgId, { kind: "session", developerId: caller.developerId }, session.subject.chainRunId, retryRunRequestId(session.orgId, session.sessionId));
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
  const expires = Math.floor(nowMs / 1000) + KEEP_SECONDS;
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
