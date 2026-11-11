// Plan 4 Task 9: how a chain run is stopped, timed and looked after. Retries are the runner's (`afterAttempt`); this file is what happens around them:
//
//   - THE SWEEP (`sweepChainRuns`), every 5 minutes. A run has one open item (`OPEN_CHAIN_RUNS`, ordered by when it is next due). The sweep reads each due run under the
//     org its item names and (1) ends a run that is older than its limit, (2) asks a step's task to stop when the step ran past its time, (3) recovers the work a dead process
//     or a lost callback left: a task that ended without its end being told, an attempt that never got its task, a gate that was decided without the run hearing, a run that
//     ended with its open item still there, and (4) moves the run's due time and its open item together, in one transaction that moves the run's version.
//   - THE TIMES. A step's time is its own `timeoutMinutes` (else 120). The sweep never ends the attempt itself: it records that the attempt ran over and asks Plan 3 to cancel
//     the task, and the task's own end (told, or found by the sweep) ends the attempt `timed_out`. So an attempt is never over while its task still runs, and a retry never
//     starts beside it. A paused attempt (budget) or one waiting on write approvals does not time out, and its clock starts again from when it was last seen waiting.
//     A gate's time is its approval's: only Plan 3's expiry (`expireApprovals`, then `onChainGateDecided`) ends a run `timed_out` for a gate, so that ending can't be written
//     for a gate that has a decision. A run's time is `limits.maxRunHours` (else 168).
//   - CANCEL. A person who may stops a run: it is marked `cancelled` in one transaction (with its attempt, its event and the request's own item), its open item stays, due now,
//     until the clean-up is done (the task is asked to stop, a gate's approval is closed), and then the item and the chain's place are given back, once. A crash between the
//     two leaves a cancelled run with its item, which the sweep finishes.
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ApprovalIdSchema, CHAIN_RUN_CLOSED_MESSAGE, CHAIN_RUN_MAX_HOURS, ChainRunIdSchema, GATE_DEFAULT_TIMEOUT_HOURS, OrgIdSchema, STEP_DEFAULT_TIMEOUT_MINUTES, agentXError, approvalKey, atLeast, chainKey, openChainRunKey, type ChainRunId, type OrgId, type PinnedChainDefinition } from "@rovara-code/contracts";
import { z } from "zod";
import { orgRoleOf, type AgentCaller } from "../agents/access.js";
import { getAnyApproval, approverDrops, commitOrLost, dueItems, type ApprovalDependencies } from "../agents/approvals-store.js";
import { onChainGateDecided } from "./gates.js";
import { resolveMember, sameMember } from "../agents/lifecycle.js";
import { markRequest } from "../agents/routes.js";
import { readRunRequest } from "../agents/runs.js";
import { Aliases, failedIndexes, requestMarkItem, type TransactItem } from "../agents/table-writes.js";
import { readTaskEndEvent } from "../agents/task-end.js";
import { auditApprovalExpired } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, tryAuditEvents } from "../audit/outbox.js";
import { auditActorOf } from "../audit/plan3-hooks.js";
import { taskAgentRunKey } from "../developer/task-records.js";
import { chainAccess } from "./access.js";
import { neutralText } from "./run-events.js";
import type { ChainSessionActor } from "./view.js";
import {
  advanceChainRun, attemptKey, designOf, errorName, getItem, isTerminalStatus, iso, lostRace, moveAttempt, moveRun, onStepTaskEnded, readChainRun, readStepAttempt, readStepAttempts,
  stepOf, stepRequestId, transact, update, type ChainRunFailure, type ChainRunRecord, type Deps, type EndStatus, type StepAttemptRecord,
} from "./runner.js";

const MINUTE = 60_000;
const HOUR = 3_600_000;
/** The most runs one sweep looks at. */
const SWEEP_LIMIT = 200;
/** How much of a function's time the sweep may use before it stops and leaves the rest for the next run. */
const SWEEP_BUDGET_MS = 25_000;
/** How soon the sweep looks at a run that has a step going, or has something to do, again. */
const LOOK_AGAIN_MS = 5 * MINUTE;
/** How soon it looks at a run that waits at a gate: the approval's own expiry brings the end, and a decision not yet applied is found by Plan 3's sweep as well. */
const GATE_LOOK_MS = 30 * MINUTE;
/** What Plan 3's agent run says of itself while it waits for write approvals. */
const WAITING_FOR_APPROVAL = "WAITING_FOR_APPROVAL";
const CLOSE_REASON_MAX = 300;

const log = (deps: Pick<Deps, "log">, event: string, fields: Record<string, unknown>): void =>
  (deps.log ?? ((name, detail) => console.log(JSON.stringify({ component: "broker", event: name, ...detail }))))(event, fields);

const runNotFound = () => agentXError("NOT_FOUND", "no chain run has that ID");

// ---- asking Plan 3 to stop a step's task

/** The request id of the cancel of one attempt's task: the same whoever asks (a timeout, a cancel, the sweep), so Plan 3 answers a repeat as the first. */
export const cancelRequestId = (runId: string, seq: number): string => stepRequestId(`${runId}:cancel`, seq);

/** Asks Plan 3 to cancel an attempt's task, as the run's owner. Nothing to do for a gate or an attempt that has no task. Throws what Plan 3's cancel throws. */
export async function cancelStepTask(deps: Deps, run: Pick<ChainRunRecord, "orgId" | "runId" | "owner">, attempt: Pick<StepAttemptRecord, "seq" | "kind" | "taskId">): Promise<void> {
  if (attempt.kind !== "agent" || attempt.taskId === undefined) return;
  await deps.chainRuns.cancelTask({ orgId: run.orgId, taskId: attempt.taskId, owner: { developerId: run.owner.developerId }, requestId: cancelRequestId(run.runId, attempt.seq) });
}

/** A task that a start made after its run was stopped (the attempt had no task id to be stopped by): asked to stop now. Best effort; it is logged when it fails. */
export async function cancelAbandonedTask(deps: Deps, run: Pick<ChainRunRecord, "orgId" | "runId" | "owner">, seq: number, taskId: string): Promise<void> {
  try {
    await cancelStepTask(deps, run, { seq, kind: "agent", taskId });
  } catch (error) {
    log(deps, "chain_run.abandoned_task_not_cancelled", { runId: run.runId, seq, taskId, error: errorName(error) });
  }
}

// ---- closing a gate's approval

/**
 * Closes a PENDING step approval of the chain run `runId`, as Plan 3's expiry does but without telling the subject's handler (the caller has already ended the run):
 * one conditional update, `PENDING` to `EXPIRED`, that holds only for a step approval whose subject is a gate of this very run in this very org, so a wrong id can't close a
 * write approval (that would skip Plan 3's `EXECUTING` retry) or another run's gate. It drops the record's `OPEN_APPROVALS` item and its `APPROVER#` items in the same
 * transaction, and leaves who closed it and why (`closedBy`, `closedReason`). A record that is not PENDING is left alone. True when this call closed it.
 */
export async function closeStepApproval(deps: ApprovalDependencies, orgId: OrgId, runId: string, approvalId: string, reason: string): Promise<boolean> {
  const id = ApprovalIdSchema.safeParse(approvalId);
  if (!id.success) return false;
  const record = await getAnyApproval(deps, orgId, id.data);
  if (record === undefined || record.kind !== "step" || record.status !== "PENDING") return false;
  const subject = record.subject as { kind?: unknown; chainRunId?: unknown };
  if (subject.kind !== "chain_gate" || subject.chainRunId !== runId) return false;
  const now = deps.now();
  const at = new Date(now).toISOString();
  const events = await tryAuditEvents(deps, () => [auditApprovalExpired({
    orgId: record.orgId, actor: auditActorOf("system"), occurredAt: at, occurrence: record.approvalId, approvalId: record.approvalId, kind: record.kind, subjectKind: record.subject.kind,
  })]);
  const aliases = new Aliases();
  const condition = [
    `${aliases.name("status")} = ${aliases.value("PENDING")}`, `${aliases.name("kind")} = ${aliases.value("step")}`, `${aliases.name("orgId")} = ${aliases.value(orgId)}`,
    `${aliases.name("subject")}.${aliases.name("kind")} = ${aliases.value("chain_gate")}`, `${aliases.name("subject")}.${aliases.name("chainRunId")} = ${aliases.value(runId)}`,
  ].join(" AND ");
  const fields = { status: "EXPIRED", handlerDone: true, closedBy: "system", closedReason: neutralText(reason, CLOSE_REASON_MAX), closedAt: at };
  const sets = Object.entries(fields).map(([name, value]) => `${aliases.name(name)} = ${aliases.value(value)}`);
  const items: TransactItem[] = [
    { Update: { TableName: deps.tableName, Key: approvalKey(record.orgId, record.approvalId), UpdateExpression: `SET ${sets.join(", ")}`, ConditionExpression: condition, ExpressionAttributeNames: aliases.names, ExpressionAttributeValues: aliases.values } },
    ...dueItems(deps, record, [record.expiresAt], undefined),
    ...approverDrops(deps, record),
    ...events.flatMap((event) => auditPending(deps, event)),
  ];
  if (!await commitOrLost(deps, items)) return false;
  await flushAuditEvents(deps, events);
  return true;
}

/**
 * The gate approval that `enterStep` made and then lost the race for: closed when the run will never wait on it (it ended, or moved on past this gate with another
 * approval or none). While the run may still enter this very gate on its next pass the approval is kept: it is the one that pass finds.
 */
export async function closeAbandonedGate(deps: Deps, run: Pick<ChainRunRecord, "orgId" | "runId">, approvalId: string, seq: number): Promise<void> {
  try {
    const fresh = await readChainRun(deps, run.orgId, run.runId);
    const never = fresh === undefined || isTerminalStatus(fresh.status) || fresh.currentSeq >= seq;
    if (!never) return;
    const attempt = fresh === undefined ? undefined : await readStepAttempt(deps, run.orgId, run.runId, seq);
    if (attempt?.approvalId === approvalId) return;
    await closeStepApproval(deps, run.orgId, run.runId, approvalId, "The run moved on before this gate opened.");
  } catch (error) {
    log(deps, "chain_run.abandoned_gate_not_closed", { runId: run.runId, seq, error: errorName(error) });
  }
}

// ---- finishing an ending

/** Whether a run that has ended may have a task still running that its ending was meant to stop: a cancel or a run timeout (every other ending follows the task's own end). */
const meantToStop = (run: ChainRunRecord): boolean => run.status === "cancelled" || run.failure?.reason === "run_timeout";

/**
 * The attempt as it is, with its task named. An attempt whose start died after Plan 3 committed it (the task and its request item exist) but before `startAgentRun` returned has
 * no task id, so nothing would stop its task: the task is found through Plan 3's request item for the attempt's start (`stepRequestId`), and named on the attempt (best effort, so the
 * task's end finds it). An attempt whose start never committed has no request item and nothing to stop.
 */
async function withTaskOfStart(deps: Deps, run: ChainRunRecord, attempt: StepAttemptRecord): Promise<StepAttemptRecord> {
  if (attempt.kind !== "agent" || attempt.taskId !== undefined) return attempt;
  const started = await readRunRequest(deps, run.orgId, stepRequestId(run.runId, attempt.seq));
  if (started === undefined) return attempt;
  try {
    await transact(deps, [update(deps, attemptKey(run, attempt.seq), { taskId: started.taskId }, (aliases) => `attribute_not_exists(${aliases.name("taskId")})`)]);
  } catch (error) {
    if (failedIndexes(error) === undefined) throw error;
  }
  return { ...attempt, taskId: started.taskId };
}

/**
 * What an ending leaves to do when the run has ended with its open item still there: the task is asked to stop (a cancel or a run timeout), a gate's approval is closed, and
 * then the item and the chain's place are given back in one transaction that holds only while the item is there, so two finishers give one place back. Does nothing when
 * the item is gone (the ending is finished). `staleItem` is a sort key of `OPEN_CHAIN_RUNS` the sweep found that is not the run's own, which goes too.
 */
async function finishEnding(deps: Deps, run: ChainRunRecord, staleItem?: string): Promise<void> {
  const own = openChainRunKey(run.dueAt, run.orgId, run.runId);
  if (await getItem(deps, own) === undefined) {
    if (staleItem !== undefined && staleItem !== own.sk) await deleteOpenItem(deps, staleItem);
    return;
  }
  const latest = run.currentSeq === 0 ? undefined : await readStepAttempt(deps, run.orgId, run.runId, run.currentSeq);
  if (latest !== undefined) {
    if (meantToStop(run)) await cancelStepTask(deps, run, await withTaskOfStart(deps, run, latest));
    if (latest.kind === "gate" && latest.approvalId !== undefined) await closeStepApproval(deps, run.orgId, run.runId, latest.approvalId, run.status === "cancelled" ? "The run was cancelled." : "The run ended.");
  }
  const aliases = new Aliases();
  const open = aliases.name("openRuns");
  const gone: TransactItem = { Delete: { TableName: deps.tableName, Key: own, ConditionExpression: "attribute_exists(pk)" } };
  const give: TransactItem = {
    Update: {
      TableName: deps.tableName, Key: chainKey(run.orgId, run.chainId, "META"), UpdateExpression: `SET ${open} = ${open} - ${aliases.value(1)}`, ConditionExpression: `${open} > ${aliases.value(0)}`,
      ExpressionAttributeNames: aliases.names, ExpressionAttributeValues: aliases.values,
    },
  };
  const stale: TransactItem[] = staleItem === undefined || staleItem === own.sk ? [] : [{ Delete: { TableName: deps.tableName, Key: { pk: own.pk, sk: staleItem } } }];
  try {
    await transact(deps, [gone, give, ...stale]);
  } catch (error) {
    const failed = failedIndexes(error);
    if (failed === undefined) throw error;
    // Someone else finished it (the item is gone): nothing is owed. Only the count refused (it drifted to 0): the item goes and the drift is logged.
    if (failed.has(0)) return;
    if (!failed.has(1)) throw error;
    log(deps, "chain_run.open_runs_drifted", { runId: run.runId, chainId: run.chainId });
    try {
      await transact(deps, [gone, ...stale]);
    } catch (again) {
      if (failedIndexes(again) === undefined) throw again;
    }
  }
}

async function deleteOpenItem(deps: Deps, sk: string): Promise<void> {
  await transact(deps, [{ Delete: { TableName: deps.tableName, Key: { pk: "OPEN_CHAIN_RUNS", sk } } }]);
}

/**
 * Ends a run that is not over by itself (a cancel, a run timeout): the run, its latest attempt, its event and any `mark` item in ONE transaction conditional on the run's
 * version, with the open item moved to now so that the clean-up is found by the sweep if this process dies before it is done; then does the clean-up. A run that moved meanwhile
 * is read again, up to three times. Undefined when the run turned out to be over already.
 */
async function endAndFinish(
  deps: Deps, first: ChainRunRecord,
  end: { status: Extract<EndStatus, "cancelled" | "timed_out">; text: string; failure?: ChainRunFailure; attemptFailure?: { reason: string; message: string }; fields?: Record<string, unknown>; mark?: TransactItem },
): Promise<ChainRunRecord | undefined> {
  let run: ChainRunRecord | undefined = first;
  for (let round = 0; round < 3; round += 1) {
    if (round > 0) run = await readChainRun(deps, first.orgId, first.runId);
    if (run === undefined || isTerminalStatus(run.status)) return undefined;
    const latest = run.currentSeq === 0 ? undefined : await readStepAttempt(deps, run.orgId, run.runId, run.currentSeq);
    const at = iso(deps);
    const items: TransactItem[] = [
      ...moveRun(deps, run, { status: end.status, endedAt: at, dueAt: at, ...(end.failure === undefined ? {} : { failure: end.failure }), ...end.fields }, [{ type: "ended", text: end.text }]),
    ];
    if (latest !== undefined && !isTerminalStatus(latest.status)) {
      // An agent attempt's task still has to end, and its spend is the run's: the task's end adds it (`settleStoppedSpend`).
      items.push(moveAttempt(deps, run, latest.seq, {
        status: end.status, endedAt: at, ...(end.attemptFailure === undefined ? {} : { failure: end.attemptFailure }), ...(latest.kind === "agent" ? { spendPending: true } : {}),
      }, ["starting", "running", "paused", "waiting"]));
    }
    if (at !== run.dueAt) {
      items.push({ Delete: { TableName: deps.tableName, Key: openChainRunKey(run.dueAt, run.orgId, run.runId) } });
      items.push({ Put: { TableName: deps.tableName, Item: { ...openChainRunKey(at, run.orgId, run.runId), entityType: "OPEN_CHAIN_RUN", orgId: run.orgId, runId: run.runId } } });
    }
    if (end.mark !== undefined) items.push(end.mark);
    try {
      await transact(deps, items);
    } catch (error) {
      if (await lostRace(deps, run, error)) continue;
      throw error;
    }
    const ended = await readChainRun(deps, first.orgId, first.runId);
    if (ended === undefined) return undefined;
    await finishEnding(deps, ended);
    return await readChainRun(deps, first.orgId, first.runId) ?? ended;
  }
  throw agentXError("WORKSPACE_BUSY", "the chain run kept changing while it was stopped; try again");
}

// ---- cancel

const CancelInputSchema = z.object({ requestId: z.string().uuid() }).strict();

/** Who may stop a run, read now: the starter, whoever holds `manage` on the chain, a maintainer of the project, an org owner or admin. Someone with no part in the run is told it isn't there. */
async function requireMayCancel(deps: Deps, caller: AgentCaller, run: ChainRunRecord, actor?: ChainSessionActor): Promise<AgentCaller> {
  const orgRole = await orgRoleOf(deps, caller.orgId, caller.developerId);
  if (orgRole === undefined) throw runNotFound();
  const live: AgentCaller = { ...caller, orgRole };
  // Plan 5 stops a chain session for a person it has judged (`edit` on the session, or an org owner or admin); the actor takes the place of this rule only, and is the caller themselves.
  if (actor !== undefined && actor.developerId === caller.developerId) return live;
  const member = await resolveMember(deps, run.orgId, caller.developerId);
  const role = await deps.projectMembers.roleOf(run.orgId, run.project, { developerId: member, orgRole });
  const chain = await deps.chains.get(run.orgId, run.chainId);
  const access = chain === undefined ? "none" : await chainAccess({ ...deps, store: deps.chains }, live, chain);
  const starter = run.startedBy.kind === "member" && await sameMember(deps, run.orgId, run.startedBy.developerId, caller.developerId);
  if (starter || orgRole === "owner" || orgRole === "admin" || role === "maintainer" || atLeast(access, "manage")) return live;
  if (role === undefined && !atLeast(access, "view")) throw runNotFound();
  throw agentXError("FORBIDDEN", `Only the person who started this run, ${run.chainName}'s owner or a maintainer of ${run.project} can stop it.`);
}

/**
 * Stops a run for `caller`: allowed for the starter, `manage` on the chain, a maintainer of the project or an org owner or admin. The run is marked `cancelled` once (its
 * version, its latest attempt and its event in one transaction, with the request's own item), then the current task is asked to stop (Plan 3's cancel, as the run's owner), a
 * gate's pending approval is closed, and the chain's place is given back once. A run that has ended answers `CHAIN_RUN_CLOSED`; the same request again answers the stored
 * outcome (and finishes what the first could not). A later end of the task, or decision of the gate, changes nothing.
 * `options.actor` is Plan 5's internal session actor (never set from a route): the session's own level check has been made, so it takes the place of the rule above and nothing else.
 */
export async function cancelChainRun(deps: Deps, caller: AgentCaller, runId: string, input: { requestId: string }, options: { actor?: ChainSessionActor } = {}): Promise<ChainRunRecord> {
  const id = ChainRunIdSchema.safeParse(runId);
  if (!id.success) throw runNotFound();
  const parsed = CancelInputSchema.safeParse(input);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", `requestId: ${parsed.error.issues[0]?.message ?? "is not valid"}`);
  const run = await readChainRun(deps, caller.orgId, id.data);
  if (run === undefined) throw runNotFound();
  const live = await requireMayCancel(deps, caller, run, options.actor);
  const { mark, replay } = await markRequest(deps, live, "chain-run-cancel", run.runId, parsed.data);
  if (replay !== undefined) return finishedCancel(deps, run);
  if (isTerminalStatus(run.status)) throw agentXError("CHAIN_RUN_CLOSED", CHAIN_RUN_CLOSED_MESSAGE);
  const member = await resolveMember(deps, run.orgId, caller.developerId);
  const ended = await endAndFinish(deps, run, {
    status: "cancelled", text: `${run.chainName} was cancelled.`, fields: { cancelledBy: member },
    mark: requestMarkItem(deps, mark, { runId: run.runId, status: "cancelled" }),
  });
  if (ended !== undefined) return ended;
  // The run ended another way first, or this very request got in first: the second is answered with the first's outcome.
  const again = await markRequest(deps, live, "chain-run-cancel", run.runId, parsed.data);
  if (again.replay !== undefined) return finishedCancel(deps, run);
  throw agentXError("CHAIN_RUN_CLOSED", CHAIN_RUN_CLOSED_MESSAGE);
}

/** The answer to a request that already stopped the run: the run as it is, with the clean-up finished if the first call could not. */
async function finishedCancel(deps: Deps, run: ChainRunRecord): Promise<ChainRunRecord> {
  const current = await readChainRun(deps, run.orgId, run.runId) ?? run;
  if (current.status === "cancelled") await finishEnding(deps, current);
  return await readChainRun(deps, run.orgId, run.runId) ?? current;
}

// ---- the sweep

export interface ChainSweepReport {
  /** The runs that were due and looked at. */
  examined: number;
  /** The runs that could not be looked at (logged); they are due again at the next sweep. */
  failed: number;
}

const DueSk = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)#([^#]+)#([^#]+)$/u;

/**
 * One sweep: the runs whose open items are due at `now` (at most 200, the earliest first), each read again under its own org and looked at once. A run that fails is logged
 * and counted, and the others go on; the sweep stops before its function's time is used.
 */
export async function sweepChainRuns(deps: Deps, now: number, options: { budgetMs?: number } = {}): Promise<ChainSweepReport> {
  const report: ChainSweepReport = { examined: 0, failed: 0 };
  const deadline = deps.now() + (options.budgetMs ?? SWEEP_BUDGET_MS);
  const page = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND sk < :bound", ExpressionAttributeValues: { ":pk": "OPEN_CHAIN_RUNS", ":bound": new Date(now + 1).toISOString() },
    ConsistentRead: true, Limit: SWEEP_LIMIT,
  })) as { Items?: Array<Record<string, unknown>> };
  for (const item of page.Items ?? []) {
    if (deps.now() >= deadline) break;
    const sk = String(item["sk"]);
    const parts = DueSk.exec(sk);
    const org = parts === null ? undefined : OrgIdSchema.safeParse(parts[2]);
    const run = parts === null ? undefined : ChainRunIdSchema.safeParse(parts[3]);
    report.examined += 1;
    try {
      if (org === undefined || !org.success || run === undefined || !run.success) await deleteOpenItem(deps, sk);
      else await sweepOne(deps, now, org.data, run.data, sk);
    } catch (error) {
      report.failed += 1;
      log(deps, "chain_sweep.run_failed", { orgId: parts?.[2], runId: parts?.[3], error: errorName(error) });
    }
  }
  return report;
}

async function sweepOne(deps: Deps, now: number, orgId: OrgId, runId: ChainRunId, sk: string): Promise<void> {
  const run = await readChainRun(deps, orgId, runId);
  // An item for a run that is not there under this org: nothing to look at.
  if (run === undefined) {
    await deleteOpenItem(deps, sk);
    return;
  }
  if (isTerminalStatus(run.status)) {
    await finishEnding(deps, run, sk);
    return;
  }
  const own = openChainRunKey(run.dueAt, orgId, runId);
  if (sk !== own.sk) {
    // Not the item the run points at: it goes, and the run's own is made, so the run is still looked at when it is due.
    await transact(deps, [
      { Delete: { TableName: deps.tableName, Key: { pk: own.pk, sk } } },
      { Put: { TableName: deps.tableName, Item: { ...own, entityType: "OPEN_CHAIN_RUN", orgId, runId } } },
    ]);
    return;
  }
  try {
    await lookAt(deps, run, now);
  } finally {
    // Whatever came of it, the run is looked at again later (a failure leaves it due; its move is the next sweep's).
    await scheduleNextLook(deps, orgId, runId, now).catch((error: unknown) => log(deps, "chain_sweep.reschedule_failed", { orgId, runId, error: errorName(error) }));
  }
}

const maxRunMs = (definition: PinnedChainDefinition): number => (definition.limits?.maxRunHours ?? CHAIN_RUN_MAX_HOURS) * HOUR;
const stepMinutes = (definition: PinnedChainDefinition, stepId: string): number => {
  const step = stepOf(definition, stepId);
  return (step?.kind === "agent" ? step.timeoutMinutes : undefined) ?? STEP_DEFAULT_TIMEOUT_MINUTES;
};
/** When an attempt's clock started: its start, or later when the sweep saw it paused or waiting since. */
const clockStart = (attempt: StepAttemptRecord): number => Math.max(Date.parse(attempt.startedAt), attempt.timeoutBase === undefined ? 0 : Date.parse(attempt.timeoutBase));

async function lookAt(deps: Deps, first: ChainRunRecord, now: number): Promise<void> {
  let run = first;
  // 0. A gate that was decided while the run did not hear is applied before anything else, so a decision that is made wins over the run's time (the run, as it is then, is looked at).
  const waiting = run.currentSeq === 0 ? undefined : await readStepAttempt(deps, run.orgId, run.runId, run.currentSeq);
  if (waiting?.kind === "gate" && await recoverGate(deps, run, waiting)) {
    const moved = await readChainRun(deps, run.orgId, run.runId);
    if (moved === undefined || isTerminalStatus(moved.status)) return;
    run = moved;
  }
  const definition = await designOf(deps, run);
  // 1. The run's own time.
  if (now - Date.parse(run.createdAt) >= maxRunMs(definition)) {
    const hours = definition.limits?.maxRunHours ?? CHAIN_RUN_MAX_HOURS;
    const message = `This run took longer than ${String(hours)} hour${hours === 1 ? "" : "s"}, so the chain stopped.`;
    await endAndFinish(deps, run, {
      status: "timed_out", text: message, failure: { reason: "run_timeout", message }, attemptFailure: { reason: "run_timeout", message },
    });
    return;
  }
  const attempts = await readStepAttempts(deps, run.orgId, run.runId);
  const latest = attempts.find((attempt) => attempt.seq === run.currentSeq);
  // 2. Work that stopped half way: a run with no step yet, an attempt that never got its task, or an attempt that ended without the run moving on.
  if (latest === undefined || (latest.status === "starting" && latest.taskId === undefined) || isTerminalStatus(latest.status)) {
    await advanceChainRun(deps, run.orgId, run.runId);
    return;
  }
  if (latest.kind === "gate") return;
  await watchStep(deps, run, latest, definition, now);
}

/**
 * A gate that waits: if its approval was decided or expired while the run did not hear (the decision is written, then the handler is told), the handler is told now. A record still PENDING
 * is left alone, even past its time: Plan 3's expiry owns that, so this can never end a run for a gate that has a decision. True when a decision was told to the handler.
 */
async function recoverGate(deps: Deps, run: ChainRunRecord, gate: StepAttemptRecord): Promise<boolean> {
  if (gate.status !== "waiting" || gate.approvalId === undefined) return false;
  const id = ApprovalIdSchema.safeParse(gate.approvalId);
  if (!id.success) return false;
  const record = await getAnyApproval(deps, run.orgId, id.data);
  if (record === undefined || record.status === "PENDING") return false;
  await onChainGateDecided(deps, record);
  return true;
}

/** The task of a running or paused step: its end, if it ended without being told, else its time. */
async function watchStep(deps: Deps, run: ChainRunRecord, attempt: StepAttemptRecord, definition: PinnedChainDefinition, now: number): Promise<void> {
  if (attempt.taskId === undefined) return;
  const agentRun = await getItem(deps, taskAgentRunKey(attempt.taskId));
  const own = agentRun !== undefined && agentRun["orgId"] === run.orgId ? agentRun : undefined;
  const finalReport = typeof own?.["finalReport"] === "string" ? own["finalReport"] : undefined;
  const branch = typeof own?.["branch"] === "string" ? own["branch"] : undefined;
  const end = await readTaskEndEvent(deps, run.orgId, attempt.taskId, { ...(finalReport === undefined ? {} : { finalReport }), ...(branch === undefined ? {} : { branch }) });
  if (end !== undefined) {
    // The task's end was recorded but this run was not told (or did not take it): telling it again is safe, it ends the attempt once.
    await onStepTaskEnded(deps, end);
    return;
  }
  if (attempt.status !== "running" && attempt.status !== "paused") return;
  // A step that waits (for budget, or for write approvals) is not running over: its clock starts again from now.
  if (attempt.status === "paused" || own?.["state"] === WAITING_FOR_APPROVAL) {
    await markClock(deps, run, attempt, now);
    return;
  }
  const minutes = stepMinutes(definition, attempt.stepId);
  if (now - clockStart(attempt) < minutes * MINUTE) return;
  if (!await flagTimedOut(deps, run, attempt, minutes, now)) return;
  await cancelStepTask(deps, run, attempt);
}

async function markClock(deps: Deps, run: ChainRunRecord, attempt: StepAttemptRecord, now: number): Promise<void> {
  try {
    await transact(deps, [moveAttempt(deps, run, attempt.seq, { timeoutBase: new Date(now).toISOString() }, ["running", "paused"])]);
  } catch (error) {
    // The attempt moved meanwhile (it ended, or went on): its end, or the next look, sees it as it is.
    if (failedIndexes(error) === undefined) throw error;
  }
}

/**
 * Records that the attempt ran past its time, once. True when it is flagged, by this call or an earlier one (so the cancel is asked again, with the same request id, until
 * the task ends); false when it is no longer running (it ended or was paused meanwhile): nothing is cancelled then.
 */
async function flagTimedOut(deps: Deps, run: ChainRunRecord, attempt: StepAttemptRecord, minutes: number, now: number): Promise<boolean> {
  try {
    await transact(deps, [update(deps, attemptKey(run, attempt.seq), { timedOutAt: new Date(now).toISOString(), timeoutMinutes: minutes }, (aliases) => `${aliases.name("status")} = ${aliases.value("running")} AND attribute_not_exists(${aliases.name("timedOutAt")})`)]);
    return true;
  } catch (error) {
    if (failedIndexes(error) === undefined) throw error;
    const again = await readStepAttempt(deps, run.orgId, run.runId, attempt.seq);
    return again?.status === "running" && again.timedOutAt !== undefined;
  }
}

/** The next time the run is due: when its step or its gate is due to run out, else soon, and never after its own time. Moves the run's due time and open item together. */
async function scheduleNextLook(deps: Deps, orgId: OrgId, runId: ChainRunId, now: number): Promise<void> {
  const run = await readChainRun(deps, orgId, runId);
  if (run === undefined || isTerminalStatus(run.status)) return;
  const definition = await designOf(deps, run);
  const latest = run.currentSeq === 0 ? undefined : await readStepAttempt(deps, orgId, runId, run.currentSeq);
  let due = now + LOOK_AGAIN_MS;
  if (latest?.kind === "gate" && latest.status === "waiting") {
    const step = stepOf(definition, latest.stepId);
    const expires = Date.parse(latest.startedAt) + (step?.kind === "gate" ? step.timeoutHours ?? GATE_DEFAULT_TIMEOUT_HOURS : GATE_DEFAULT_TIMEOUT_HOURS) * HOUR;
    if (expires > now) due = Math.min(expires, now + GATE_LOOK_MS);
  } else if (latest?.kind === "agent" && latest.status === "running" && latest.timedOutAt === undefined) {
    const over = clockStart(latest) + stepMinutes(definition, latest.stepId) * MINUTE;
    if (over > now) due = Math.min(due, over);
  }
  const dueAt = new Date(Math.max(Math.min(due, Date.parse(run.createdAt) + maxRunMs(definition)), now + 1000)).toISOString();
  if (dueAt === run.dueAt) return;
  try {
    await transact(deps, [
      ...moveRun(deps, run, { dueAt }, []),
      { Delete: { TableName: deps.tableName, Key: openChainRunKey(run.dueAt, orgId, runId) } },
      { Put: { TableName: deps.tableName, Item: { ...openChainRunKey(dueAt, orgId, runId), entityType: "OPEN_CHAIN_RUN", orgId, runId } } },
    ]);
  } catch (error) {
    // The run moved meanwhile (a step ended, a decision came): whoever moved it keeps its item, and the next sweep looks again.
    if (!await lostRace(deps, run, error)) throw error;
  }
}
