// Ending an automatic run Rovara itself stops (owner decision 2026-11-02; Opus review M2). A system owner has no person to resume a parked operation or to press Stop, so a run that cannot go on, or is stuck, must be ended by
// the broker, or it keeps the project's ONE automatic slot for ever. Two ways in, one set of writes:
//   the dispatch guard    the project is archived or the company closed while the operation waited: the operation is failed (`failOutboxOperation`, which needs only the table), and the task is ended and queued for release;
//   the session sweep     a run older than `AUTOMATIC_RUN_MAX_MS` is cancelled on its worker (best effort), ended and queued for release, and its end audited ("automatic_run.ended").
// "Ended" is `agentRunEnd` (CANCELLED) plus the release mark the recovery sweep releases from: the workspace and the slot go back there, as they do for a night that finished. Every write is idempotent (the first end stands).
import { DeleteCommand, GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { AUTOMATIC_RUN_MAX_MS, AutomaticJobSchema, INDEX_EXPIRY_ATTRIBUTE, OrgIdSchema, projectPk, type AutomaticRunEndReason } from "@agentx/contracts";
import { auditAutomaticRunEnded } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditTransact, tryAuditEvent, type AuditDeps } from "../audit/outbox.js";
import { isSystemOwned } from "../developer/system-owner.js";
import { taskKey, type DeveloperTaskRecord, type TaskOwnerSource } from "../developer/task-records.js";
import { nightFailedItem } from "../test-env/night-status.js";

type Client = { send(command: unknown): Promise<unknown> };

/** Where each started automatic run is watched until its slot is back: sorted by when it started. The same shape as the stuck-setup watch. */
export const AUTOMATIC_RUN_WATCH_PK = "AUTOMATIC_RUN_WATCH";
export const automaticRunWatchKey = (startedAt: string, taskId: string) => ({ pk: AUTOMATIC_RUN_WATCH_PK, sk: `${startedAt}#${taskId}` });
/** The release mark the recovery sweep releases a finished task from (`FINISHED_RELEASE_PK` in the task release; a test holds the two equal). */
const FINISHED_RELEASE_PK = "FINISHED_RELEASE";
const WATCH_TTL_MS = 14 * 86_400_000;
const WATCH_PAGE = 100;

export interface AutomaticRunWatch { pk: string; sk: string; orgId: string; project: string; job: string; taskId: string; startedAt: string }

/** The watch of a run that started (a Put that stands if it is there already). Throws on a fault; the caller logs it. */
export async function putAutomaticRunWatch(client: Client, tableName: string, input: { orgId: string; project: string; job: string; taskId: string; startedAt: string; nowMs: number }): Promise<void> {
  try {
    const { orgId, project, job, taskId, startedAt, nowMs } = input;
    await client.send(new TransactWriteCommand({ TransactItems: [{ Put: { TableName: tableName, Item: { ...automaticRunWatchKey(startedAt, taskId), entityType: "AUTOMATIC_RUN_WATCH", orgId, project, job, taskId, startedAt, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor((nowMs + WATCH_TTL_MS) / 1000) }, ConditionExpression: "attribute_not_exists(pk)" } }] }));
  } catch (error) {
    if (!(error instanceof Error && (error.name === "ConditionalCheckFailedException" || error.name === "TransactionCanceledException"))) throw error;
  }
}

/**
 * Ends an automatic task: `agentRunEnd` CANCELLED and the reason (the first end stands), the release mark, and, for a nightly, the night's own `infra` row so the Home card and the same-day retry see it. Refuses a task that
 * is not a system owner's (this is never how a person's task is ended). Never touches a closed task.
 */
export async function markAutomaticTaskEnded(client: Client, tableName: string, task: Pick<DeveloperTaskRecord, "taskId" | "project" | "nightlyRun"> & TaskOwnerSource & { orgId?: string | undefined }, reason: AutomaticRunEndReason, nowIso: string): Promise<boolean> {
  if (!isSystemOwned(task)) throw new Error("only a system owner's task is ended this way");
  const org = OrgIdSchema.safeParse(task.orgId);
  const failedNight = task.nightlyRun !== undefined && org.success ? [nightFailedItem(tableName, { orgId: org.data, project: task.project, slotId: task.nightlyRun.slotId, reason: "infra", nowIso })] : [];
  try {
    await client.send(new TransactWriteCommand({ TransactItems: [
      ...failedNight,
      { Update: {
        TableName: tableName, Key: taskKey(task.taskId),
        UpdateExpression: "SET agentRunEnd = if_not_exists(agentRunEnd, :end), automaticEnd = if_not_exists(automaticEnd, :why), updatedAt = :now",
        // Only while the run has not ended: a night that completed between the read and this write keeps its own end, and NOTHING else here (the cause, the night's row, the release mark) is written.
        ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(closedAt) AND attribute_not_exists(agentRunEnd)",
        ExpressionAttributeValues: { ":end": { state: "CANCELLED", at: nowIso }, ":why": { reason, at: nowIso }, ":now": nowIso },
      } },
      { Update: {
        TableName: tableName, Key: { pk: FINISHED_RELEASE_PK, sk: `TASK#${task.taskId}` },
        UpdateExpression: "SET entityType = :entity, taskId = :task, markedAt = if_not_exists(markedAt, :now)",
        ExpressionAttributeValues: { ":entity": FINISHED_RELEASE_PK, ":task": task.taskId, ":now": nowIso },
      } },
    ] }));
  } catch (error) {
    // A task that is closed, gone or already ended has nothing to end, and nothing was written.
    if (error instanceof Error && error.name === "TransactionCanceledException") return false;
    throw error;
  }
  // The night's lock, when it is this run's (its slot id): the next night does not wait out the lock's own hours. Best effort and conditional on the run, so another night's lock is never taken.
  if (task.nightlyRun !== undefined && org.success) {
    await client.send(new DeleteCommand({ TableName: tableName, Key: { pk: projectPk(org.data, task.project), sk: "TESTENV#NIGHTLY#ACTIVE" }, ConditionExpression: "slotId = :slot", ExpressionAttributeValues: { ":slot": task.nightlyRun.slotId } })).catch(() => undefined);
  }
  return true;
}

/** The most one pass of the sweep takes, whatever its caller has left: the maintenance jobs after it need time too. */
export const AUTOMATIC_RUN_SWEEP_SLICE_MS = 5_000;

export interface AutomaticRunSweepDependencies extends AuditDeps {
  /** How long the pass may take in all (it stops between runs once this is used; the rest wait for the next pass). Absent: the slice above. */
  budgetMs?: number;
  documentClient: Client;
  tableName: string;
  now: () => number;
  /** Cancels what is running for the task on its worker, best effort (the broker's `cancelRunning` as the task's own identity). Absent: the run is ended without telling a worker. */
  cancelLive?: (task: DeveloperTaskRecord) => Promise<void>;
  /** Asks for the task's workspace and slot to be given back now (never throws); the recovery sweep tries again later when the workspace is busy. */
  release: (taskId: string) => Promise<void>;
  log?: (entry: Record<string, unknown>) => void;
}

export interface AutomaticRunSweepReport { ended: number; audited: number; watching: number; dropped: number; /** True when the pass stopped for lack of time. */ stoppedForTime?: true }

/**
 * The session sweep's job for automatic runs: reads the watch of every started run (one page, oldest first; there is one automatic slot per project, so it is small), ends a run past its time, and drops the watch of a run whose
 * slot is back, writing the audit of an end Rovara made (once, whichever of the dispatch guard or this sweep ended it).
 */
export async function sweepAutomaticRuns(deps: AutomaticRunSweepDependencies): Promise<AutomaticRunSweepReport> {
  const log = deps.log ?? (() => undefined);
  const report: AutomaticRunSweepReport = { ended: 0, audited: 0, watching: 0, dropped: 0 };
  const startedAt = deps.now();
  const budgetMs = Math.min(deps.budgetMs ?? AUTOMATIC_RUN_SWEEP_SLICE_MS, AUTOMATIC_RUN_SWEEP_SLICE_MS);
  const page = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": AUTOMATIC_RUN_WATCH_PK }, ConsistentRead: true, Limit: WATCH_PAGE,
  })) as { Items?: AutomaticRunWatch[] };
  for (const watch of page.Items ?? []) {
    if (deps.now() - startedAt >= budgetMs) { report.stoppedForTime = true; break; }
    try {
      const task = ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: taskKey(watch.taskId), ConsistentRead: true }))) as { Item?: DeveloperTaskRecord & { automaticEnd?: { reason?: unknown; at?: unknown } } }).Item;
      if (task === undefined || !isSystemOwned(task)) { await dropWatch(deps, watch); report.dropped += 1; continue; }
      let ending = task.automaticEnd;
      if (task.agentRunEnd === undefined && task.closedAt === undefined && deps.now() - Date.parse(watch.startedAt) > AUTOMATIC_RUN_MAX_MS) {
        // Ended first, and only if it still was not (a night that completed meanwhile keeps its own end and gets nothing from this pass); then its worker is told to stop.
        const at = new Date(deps.now()).toISOString();
        if (await markAutomaticTaskEnded(deps.documentClient, deps.tableName, task, "too_old", at)) {
          ending = { reason: "too_old", at };
          report.ended += 1;
          await deps.cancelLive?.(task).catch((error: unknown) => log({ event: "automatic_run.cancel_failed", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" }));
        }
      }
      if (ending !== undefined && (ending.reason === "too_old" || ending.reason === "project_stopped") && await auditEnd(deps, watch, ending.reason)) report.audited += 1;
      if (task.agentRunEnd !== undefined || ending !== undefined) await deps.release(task.taskId);
      // The slot is back when the task is released (or closed): the watch has done its job.
      const fresh = ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: taskKey(watch.taskId), ConsistentRead: true }))) as { Item?: { releasedAt?: unknown; closedAt?: unknown } }).Item;
      if (fresh === undefined || fresh.releasedAt !== undefined || fresh.closedAt !== undefined) { await dropWatch(deps, watch); report.dropped += 1; } else report.watching += 1;
    } catch (error) {
      log({ event: "automatic_run.sweep_item_failed", taskId: watch.taskId, error: error instanceof Error ? error.name : "unknown" });
      report.watching += 1;
    }
  }
  return report;
}

const dropWatch = (deps: AutomaticRunSweepDependencies, watch: AutomaticRunWatch) => deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: { pk: watch.pk, sk: watch.sk } }));

/** The audit of an end Rovara made, once per task (a marker in the project's partition). True when this call wrote it. */
async function auditEnd(deps: AutomaticRunSweepDependencies, watch: AutomaticRunWatch, reason: AutomaticRunEndReason): Promise<boolean> {
  const org = OrgIdSchema.safeParse(watch.orgId);
  const job = AutomaticJobSchema.safeParse(watch.job);
  if (!org.success || !job.success) return false;
  const at = new Date(deps.now()).toISOString();
  const event = await tryAuditEvent(deps, () => auditAutomaticRunEnded({ orgId: org.data, actor: { kind: "system", id: "rovara" }, occurredAt: at, occurrence: watch.taskId, projectName: watch.project, job: job.data, reason }));
  const marker = { pk: projectPk(org.data, watch.project), sk: `AUTOMATIC_RUNS#ENDED#${watch.taskId}` };
  try {
    await auditTransact({ ...deps, documentClient: deps.documentClient }, { Put: { TableName: deps.tableName, Item: { ...marker, entityType: "AUTOMATIC_RUN_ENDED", orgId: org.data, project: watch.project, job: job.data, reason, at, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor((deps.now() + 62 * 86_400_000) / 1000) }, ConditionExpression: "attribute_not_exists(pk)" } }, event === undefined ? [] : [event]);
    if (event !== undefined) await flushAuditEvents(deps, [event]);
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
    deps.log?.({ event: "automatic_run.end_audit_failed", taskId: watch.taskId, error: error instanceof Error ? error.name : "unknown" });
    return false;
  }
}
