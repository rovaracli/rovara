import { randomUUID } from "node:crypto";
import {
  GetCommand,
  QueryCommand,
  UpdateCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { TRACKING_COALESCE_SECONDS, TRACKING_GATE_SECONDS, TRACKING_HEARTBEAT_MINUTES, TRACKING_MAX_ROWS } from "@rovara-code/contracts";

type TransactItems = NonNullable<TransactWriteCommandInput["TransactItems"]>;
type DocumentClient = { send(command: unknown): Promise<unknown> };

export interface GithubMergeReadBudget {
  signal: AbortSignal;
  beforeRequest: () => void;
}
export type MergeRecoveryResult =
  /** `nextAt` (a tracking row only): when the row must be looked at again if nothing wakes it sooner. Never sooner than the next gate or later than the heartbeat. */
  | { kind: "OBSERVED"; nextAt?: number }
  | { kind: "RETRY"; retryAt: number; scope: "task" | "github-global" }
  | { kind: "TERMINAL"; release: "confirmed" | "queued" }
  | { kind: "MISSING" };

export interface MergeRecoveryDependencies {
  documentClient: DocumentClient;
  tableName: string;
  now: () => number;
  reconcile: (taskId: string, budget: GithubMergeReadBudget) => Promise<MergeRecoveryResult>;
  validateSeed?: (taskId: string) => Promise<boolean>;
}

interface RecoveryRow {
  pk: string;
  sk: string;
  entityType: typeof RECOVERY_PK;
  taskId: string;
  attempts: number;
  nextAttemptAt: number;
  /** Absent means `"merge"`: every row written before Rovara Code tracking, and every row of a task that does not track. */
  kind?: "tracking";
  dispatchDuePk: typeof RECOVERY_PK | typeof TRACKING_DUE_PK;
  dispatchDueSk: string;
  leaseToken?: string;
  leaseExpiresAt?: number;
  /** A tracking row only: when a webhook last said GitHub changed something for the task. */
  wakeAt?: number;
}

interface TaskRecord {
  taskId: string;
  workspaceId?: string;
  releasedAt?: string;
  closedAt?: string;
  charge?: {
    member?: { pk?: string; sk?: string };
    organization?: { pk?: string; sk?: string };
  };
}

interface GlobalSweepRow {
  leaseToken?: string;
  nextSweepAt?: number;
  rateLimitedUntil?: number;
}

type Settlement = "committed" | "stale" | "unknown";

const RECOVERY_PK = "WORKFLOW_MERGE_RECOVERY" as const;
/** The due partition of tracking rows (Rovara Code): their own, so neither pass can starve the other. */
export const TRACKING_DUE_PK = "WORKFLOW_MERGE_TRACKING" as const;
const SWEEP_PK = "WORKFLOW_MERGE_SWEEP";
const SWEEP_SK = "META";
const TRACKING_SWEEP_SK = "TRACKING";
const DUE_INDEX = "workflow-dispatch-due";
const LEASE_MS = 30_000;
export const SWEEP_INTERVAL_MS = 5 * 60_000;
const TRACKING_GATE_MS = TRACKING_GATE_SECONDS * 1_000;
const TRACKING_COALESCE_MS = TRACKING_COALESCE_SECONDS * 1_000;
/** The tracking gate opens this much before its 60 seconds are up: the schedule fires every minute, and an invocation a few milliseconds early would otherwise wait for the next one. */
const TRACKING_GATE_SLACK_MS = 5_000;
const TRACKING_HEARTBEAT_MS = TRACKING_HEARTBEAT_MINUTES * 60_000;
const GITHUB_BUDGET_MS = 20_000;
const GITHUB_START_RESERVE_MS = 2_000;
const MAX_ROWS = 10;
const MAX_REQUESTS = 256;
const RETIRED_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_SEED_TASKS = 25;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class GithubBudgetExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubBudgetExhaustedError";
  }
}

function validTaskId(taskId: string): boolean {
  return UUID.test(taskId);
}

function representableDateMilliseconds(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isFinite(new Date(value).getTime());
}

function dueKey(at: number, taskId: string): string {
  return `${new Date(at).toISOString()}#${taskId}`;
}

function isConditional(error: unknown): boolean {
  const name = error instanceof Error ? error.name : undefined;
  return name === "ConditionalCheckFailedException" || name === "TransactionCanceledException";
}

function asItem(response: unknown): Record<string, unknown> | undefined {
  if (response === null || typeof response !== "object") return undefined;
  const item = (response as { Item?: unknown }).Item;
  return item !== null && typeof item === "object" ? item as Record<string, unknown> : undefined;
}

async function readItem(
  dependencies: Pick<MergeRecoveryDependencies, "documentClient" | "tableName">,
  key: { pk: string; sk: string },
): Promise<Record<string, unknown> | undefined> {
  return asItem(await dependencies.documentClient.send(new GetCommand({
    TableName: dependencies.tableName,
    Key: key,
    ConsistentRead: true,
  })));
}

function recoveryRow(item: Record<string, unknown> | undefined): RecoveryRow | undefined {
  if (item === undefined
    || item.pk !== RECOVERY_PK
    || typeof item.sk !== "string"
    || item.entityType !== RECOVERY_PK
    || typeof item.taskId !== "string"
    || !validTaskId(item.taskId)
    || item.sk !== `TASK#${item.taskId}`
    || typeof item.attempts !== "number"
    || !Number.isInteger(item.attempts)
    || item.attempts < 0
    || !representableDateMilliseconds(item.nextAttemptAt)
    // The due partition must be the one the row's kind belongs to: a tracking row in the merge partition (or the other way round) is not a row either pass accepts.
    || (item.kind !== undefined && item.kind !== "tracking")
    || item.dispatchDuePk !== (item.kind === "tracking" ? TRACKING_DUE_PK : RECOVERY_PK)
    || (item.wakeAt !== undefined && !representableDateMilliseconds(item.wakeAt))
    || typeof item.dispatchDueSk !== "string"
    || item.dispatchDueSk !== dueKey(item.nextAttemptAt, item.taskId)
    || (item.leaseToken !== undefined && typeof item.leaseToken !== "string")
    || (item.leaseExpiresAt !== undefined && (typeof item.leaseExpiresAt !== "number" || !Number.isFinite(item.leaseExpiresAt)))) {
    return undefined;
  }
  return item as unknown as RecoveryRow;
}

function taskRecord(item: Record<string, unknown> | undefined, taskId: string): TaskRecord | undefined {
  if (item === undefined || item.taskId !== taskId) return undefined;
  return item as unknown as TaskRecord;
}

function retryDelay(attempts: number): number {
  return Math.min(SWEEP_INTERVAL_MS * 2 ** Math.max(0, attempts - 1), 30 * 60_000);
}

/** The two passes that share this module's rows: the merge pass (kind-less rows, today's behaviour) and the Rovara Code tracking pass. */
interface Lane {
  kind: "merge" | "tracking";
  duePk: typeof RECOVERY_PK | typeof TRACKING_DUE_PK;
  /** The sort key of the lane's gate item in the sweep partition. */
  gateSk: string;
  intervalMs: number;
  /** How much earlier than `intervalMs` the next pass may start, so that a schedule that fires a few milliseconds early is not refused for a whole interval. */
  slackMs: number;
  maxRows: number;
  /** How long a row waits after its `attempts`th failure. */
  retryDelay(attempts: number): number;
}

const MERGE_LANE: Lane = { kind: "merge", duePk: RECOVERY_PK, gateSk: SWEEP_SK, intervalMs: SWEEP_INTERVAL_MS, slackMs: 0, maxRows: MAX_ROWS, retryDelay };
const TRACKING_LANE: Lane = {
  kind: "tracking", duePk: TRACKING_DUE_PK, gateSk: TRACKING_SWEEP_SK, intervalMs: TRACKING_GATE_MS, slackMs: TRACKING_GATE_SLACK_MS, maxRows: TRACKING_MAX_ROWS,
  retryDelay: (attempts) => Math.min(TRACKING_GATE_MS * Math.max(1, attempts), TRACKING_HEARTBEAT_MS),
};

/** When an observed tracking row is next due: the heartbeat, or the pass's own hint when that is sooner, never sooner than the next gate. */
function trackingObservedNext(now: number, hint: number | undefined): number {
  const latest = now + TRACKING_HEARTBEAT_MS;
  return hint === undefined || !Number.isFinite(hint) ? latest : Math.min(latest, Math.max(now + TRACKING_GATE_MS, hint));
}

export function mergeRecoveryItem(tableName: string, taskId: string, now: string): TransactItems[number] {
  if (!validTaskId(taskId)) throw new Error("workflow merge recovery taskId must be a lowercase UUID");
  const at = Date.parse(now);
  if (!representableDateMilliseconds(at)) throw new Error("workflow merge recovery now must be a representable ISO timestamp");
  return { Update: {
    TableName: tableName,
    Key: { pk: RECOVERY_PK, sk: `TASK#${taskId}` },
    UpdateExpression: "SET entityType = if_not_exists(entityType, :entity), taskId = if_not_exists(taskId, :task), createdAt = if_not_exists(createdAt, :now), updatedAt = :now, attempts = if_not_exists(attempts, :zero), nextAttemptAt = if_not_exists(nextAttemptAt, :at), dispatchDuePk = if_not_exists(dispatchDuePk, :pk), dispatchDueSk = if_not_exists(dispatchDueSk, :due)",
    ExpressionAttributeValues: {
      ":entity": RECOVERY_PK,
      ":task": taskId,
      ":now": now,
      ":zero": 0,
      ":at": at,
      ":pk": RECOVERY_PK,
      ":due": dueKey(at, taskId),
    },
  } };
}

/**
 * The item that makes a Rovara Code task's recovery row its tracking row (Plan 6 Task 14): the same row (`TASK#<taskId>`), `kind = "tracking"` and the tracking due
 * partition. Written in the transaction that records the task's first pull request. A row that exists keeps its attempts, lease and due time (it is the same row); a
 * kind-less row becomes a tracking row, and the old enrolment (`mergeRecoveryItem`) never turns one back.
 */
export function trackingRecoveryItem(tableName: string, taskId: string, now: string): TransactItems[number] {
  if (!validTaskId(taskId)) throw new Error("workflow merge recovery taskId must be a lowercase UUID");
  const at = Date.parse(now);
  if (!representableDateMilliseconds(at)) throw new Error("workflow merge recovery now must be a representable ISO timestamp");
  return { Update: {
    TableName: tableName,
    Key: { pk: RECOVERY_PK, sk: `TASK#${taskId}` },
    UpdateExpression: "SET entityType = if_not_exists(entityType, :entity), taskId = if_not_exists(taskId, :task), createdAt = if_not_exists(createdAt, :now), updatedAt = :now, attempts = if_not_exists(attempts, :zero), nextAttemptAt = if_not_exists(nextAttemptAt, :at), dispatchDuePk = :pk, dispatchDueSk = if_not_exists(dispatchDueSk, :due), #kind = :tracking",
    ExpressionAttributeNames: { "#kind": "kind" },
    ExpressionAttributeValues: {
      ":entity": RECOVERY_PK,
      ":task": taskId,
      ":now": now,
      ":zero": 0,
      ":at": at,
      ":pk": TRACKING_DUE_PK,
      ":due": dueKey(at, taskId),
      ":tracking": "tracking",
    },
  } };
}

/**
 * A webhook says GitHub changed something for the task (Plan 6 Task 14). Two writes, so a bump made during a lease is not lost and an earlier time is never pushed later:
 * 1. `wakeAt = now`, on a live tracking row only; it lands even during a lease;
 * 2. `nextAttemptAt` and `dispatchDueSk` together move to now plus `TRACKING_COALESCE_SECONDS`, only if the row is due later than that. A refusal (an earlier time, or a
 *    lease, whose time is ahead of that) is expected and ignored: the pass that holds the lease settles the row for `wakeAt` when it ends.
 * A task with no tracking row gets none, and a kind-less (merge) row is left exactly as it is.
 */
export async function wakeTrackingRow(
  dependencies: Pick<MergeRecoveryDependencies, "documentClient" | "tableName" | "now">,
  taskId: string,
  /** How long the wake waits so a burst of deliveries is one pass: `TRACKING_COALESCE_SECONDS`, or a review's shorter `TRACKING_REVIEW_COALESCE_SECONDS`. */
  options: { coalesceSeconds?: number } = {},
): Promise<"woken" | "none"> {
  if (!validTaskId(taskId)) return "none";
  const now = dependencies.now();
  const key = { pk: RECOVERY_PK, sk: `TASK#${taskId}` };
  const live = "attribute_exists(pk) AND #kind = :tracking AND attribute_not_exists(recoveryStatus)";
  try {
    await dependencies.documentClient.send(new UpdateCommand({
      TableName: dependencies.tableName, Key: key, UpdateExpression: "SET wakeAt = :now", ConditionExpression: live,
      ExpressionAttributeNames: { "#kind": "kind" }, ExpressionAttributeValues: { ":now": now, ":tracking": "tracking" },
    }));
  } catch (error) {
    if (isConditional(error)) return "none";
    throw error;
  }
  const at = now + (options.coalesceSeconds === undefined ? TRACKING_COALESCE_MS : options.coalesceSeconds * 1_000);
  try {
    await dependencies.documentClient.send(new UpdateCommand({
      TableName: dependencies.tableName, Key: key, UpdateExpression: "SET nextAttemptAt = :at, dispatchDueSk = :due", ConditionExpression: `${live} AND nextAttemptAt > :at`,
      ExpressionAttributeNames: { "#kind": "kind" }, ExpressionAttributeValues: { ":at": at, ":due": dueKey(at, taskId), ":tracking": "tracking" },
    }));
  } catch (error) {
    if (!isConditional(error)) throw error;
  }
  return "woken";
}

export async function seedWorkflowMergeRecovery(
  dependencies: MergeRecoveryDependencies,
  taskIds: readonly string[],
): Promise<{ seeded: number; skipped: number }> {
  if (taskIds.length > MAX_SEED_TASKS) throw new Error(`workflow merge recovery seeds are limited to ${MAX_SEED_TASKS} task IDs`);
  if (dependencies.validateSeed === undefined) throw new Error("workflow merge recovery seed validator is required");
  if (taskIds.some((taskId) => !validTaskId(taskId))) throw new Error("every workflow merge recovery seed must be a lowercase UUID");
  if (new Set(taskIds).size !== taskIds.length) throw new Error("workflow merge recovery seed task IDs must be unique");

  let seeded = 0;
  let skipped = 0;
  for (const taskId of taskIds) {
    const allowed = await dependencies.validateSeed(taskId);
    if (!allowed) {
      skipped += 1;
      continue;
    }
    const task = taskRecord(await readItem(dependencies, { pk: `DEVTASK#${taskId}`, sk: "META" }), taskId);
    if (task === undefined) {
      skipped += 1;
      continue;
    }
    const item = mergeRecoveryItem(dependencies.tableName, taskId, new Date(dependencies.now()).toISOString());
    await dependencies.documentClient.send(new UpdateCommand(item.Update!));
    seeded += 1;
  }
  return { seeded, skipped };
}

/**
 * Takes the lane's gate item. `bypassInterval` (the pass for review-woken rows) takes the lease without waiting for `nextSweepAt` and leaves `nextSweepAt` as it was, so the heartbeat passes keep
 * their rhythm and their GitHub cost; the lease still keeps the two passes from running at once.
 */
async function claimGlobalSweep(dependencies: MergeRecoveryDependencies, now: number, token: string, lane: Lane = MERGE_LANE, bypassInterval = false): Promise<boolean> {
  // GitHub's rate limit is shared: either pass that met it wrote `rateLimitedUntil` on the merge pass's gate item, and neither starts until it has passed.
  if (lane.kind === "tracking") {
    try {
      const shared = await readItem(dependencies, { pk: SWEEP_PK, sk: SWEEP_SK });
      if (typeof shared?.rateLimitedUntil === "number" && shared.rateLimitedUntil > now) return false;
    } catch {
      return false;
    }
  }
  try {
    await dependencies.documentClient.send(new UpdateCommand({
      TableName: dependencies.tableName,
      Key: { pk: SWEEP_PK, sk: lane.gateSk },
      UpdateExpression: `SET entityType = :entity, leaseToken = :token, leaseExpiresAt = :lease, nextSweepAt = ${bypassInterval ? "if_not_exists(nextSweepAt, :next)" : ":next"}, createdAt = if_not_exists(createdAt, :nowIso), updatedAt = :nowIso`,
      ConditionExpression: `(attribute_not_exists(leaseExpiresAt) OR leaseExpiresAt <= :now)${bypassInterval ? "" : " AND (attribute_not_exists(nextSweepAt) OR nextSweepAt <= :now)"}${lane.kind === "merge" ? " AND (attribute_not_exists(rateLimitedUntil) OR rateLimitedUntil <= :now)" : ""}`,
      ExpressionAttributeValues: {
        ":entity": SWEEP_PK,
        ":token": token,
        ":lease": now + LEASE_MS,
        ":next": now + lane.intervalMs - lane.slackMs,
        ":now": now,
        ":nowIso": new Date(now).toISOString(),
      },
    }));
    return true;
  } catch {
    return false;
  }
}

async function releaseGlobalSweep(dependencies: MergeRecoveryDependencies, token: string, now: number, lane: Lane = MERGE_LANE): Promise<void> {
  try {
    await dependencies.documentClient.send(new UpdateCommand({
      TableName: dependencies.tableName,
      Key: { pk: SWEEP_PK, sk: lane.gateSk },
      UpdateExpression: "SET updatedAt = :now REMOVE leaseToken, leaseExpiresAt",
      ConditionExpression: "leaseToken = :token",
      ExpressionAttributeValues: { ":now": new Date(now).toISOString(), ":token": token },
    }));
  } catch {
    // A stale or ambiguous global settlement remains fenced by its lease and nextSweepAt.
  }
}

async function queryDueRows(dependencies: MergeRecoveryDependencies, now: number, lane: Lane = MERGE_LANE): Promise<Record<string, unknown>[]> {
  const response = await dependencies.documentClient.send(new QueryCommand({
    TableName: dependencies.tableName,
    IndexName: DUE_INDEX,
    KeyConditionExpression: "dispatchDuePk = :pk AND dispatchDueSk BETWEEN :low AND :high",
    ExpressionAttributeValues: {
      ":pk": lane.duePk,
      ":low": "0",
      ":high": `${new Date(now).toISOString()}:`,
    },
    Limit: lane.maxRows,
  })) as { Items?: Record<string, unknown>[] };
  return response.Items ?? [];
}

async function quarantine(
  dependencies: MergeRecoveryDependencies,
  item: Record<string, unknown>,
  now: number,
  errorClass: "MALFORMED_DISCOVERY" | "MISSING_TASK" | "RECONCILE_MISSING",
  token?: string,
): Promise<Settlement> {
  if (item.pk !== RECOVERY_PK || typeof item.sk !== "string" || typeof item.dispatchDueSk !== "string") return "stale";
  const condition = token === undefined ? "dispatchDueSk = :due" : "dispatchDueSk = :due AND leaseToken = :token";
  try {
    await dependencies.documentClient.send(new UpdateCommand({
      TableName: dependencies.tableName,
      Key: { pk: item.pk, sk: item.sk },
      UpdateExpression: "SET recoveryStatus = :status, recoveryErrorClass = :error, updatedAt = :now, indexExpiresAt = :ttl REMOVE nextAttemptAt, dispatchDuePk, dispatchDueSk, leaseToken, leaseExpiresAt",
      ConditionExpression: condition,
      ExpressionAttributeValues: {
        ":due": item.dispatchDueSk,
        ":status": "QUARANTINED",
        ":error": errorClass,
        ":now": new Date(now).toISOString(),
        ":ttl": Math.floor(now / 1_000) + RETIRED_TTL_SECONDS,
        ...(token === undefined ? {} : { ":token": token }),
      },
    }));
    return "committed";
  } catch (error) {
    return isConditional(error) ? "stale" : "unknown";
  }
}

async function claimRow(
  dependencies: MergeRecoveryDependencies,
  row: RecoveryRow,
  now: number,
  token: string,
): Promise<RecoveryRow | undefined> {
  try {
    await dependencies.documentClient.send(new UpdateCommand({
      TableName: dependencies.tableName,
      Key: { pk: row.pk, sk: row.sk },
      UpdateExpression: "SET leaseToken = :token, leaseExpiresAt = :lease, updatedAt = :nowIso, attempts = if_not_exists(attempts, :zero) + :one, nextAttemptAt = :lease, dispatchDueSk = :leaseKey",
      ConditionExpression: "entityType = :entity AND taskId = :task AND nextAttemptAt = :dueAt AND dispatchDuePk = :pk AND dispatchDueSk = :dueKey AND (attribute_not_exists(leaseExpiresAt) OR leaseExpiresAt <= :now)",
      ExpressionAttributeValues: {
        ":token": token,
        ":lease": now + LEASE_MS,
        ":nowIso": new Date(now).toISOString(),
        ":zero": 0,
        ":one": 1,
        ":entity": RECOVERY_PK,
        ":task": row.taskId,
        ":dueAt": row.nextAttemptAt,
        ":pk": row.dispatchDuePk,
        ":dueKey": row.dispatchDueSk,
        ":now": now,
        ":leaseKey": dueKey(now + LEASE_MS, row.taskId),
      },
    }));
  } catch {
    return undefined;
  }
  const claimed = recoveryRow(await readItem(dependencies, { pk: row.pk, sk: row.sk }));
  return claimed?.leaseToken === token ? claimed : undefined;
}

async function settleActive(
  dependencies: MergeRecoveryDependencies,
  row: RecoveryRow,
  token: string,
  now: number,
  nextAttemptAt: number,
  attempts: number,
  /** A tracking row's pass: when it claimed the row. A wake after that has not been seen by the pass, and the row is settled for it. */
  claimedAt?: number,
): Promise<Settlement> {
  // The due partition is not written here: the claim required the row's own, and a row converted to tracking while it was leased must keep the one it now has.
  const write = (next: number, wakeCondition: string, values: Record<string, unknown>) => dependencies.documentClient.send(new UpdateCommand({
    TableName: dependencies.tableName,
    Key: { pk: row.pk, sk: row.sk },
    UpdateExpression: "SET attempts = :attempts, nextAttemptAt = :next, dispatchDueSk = :due, updatedAt = :now REMOVE leaseToken, leaseExpiresAt",
    ConditionExpression: `leaseToken = :token${wakeCondition}`,
    ExpressionAttributeValues: {
      ":attempts": attempts,
      ":next": next,
      ":due": dueKey(next, row.taskId),
      ":now": new Date(now).toISOString(),
      ":token": token,
      ...values,
    },
  }));
  try {
    if (claimedAt === undefined) {
      await write(nextAttemptAt, "", {});
      return "committed";
    }
    // A tracking row: a webhook may have woken it after the pass claimed it. The wake is read, and the settlement is conditioned on having read it (a newer one makes
    // the pass read again); after three lost races the row is simply due at the next coalescing time, which is early, never late.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await readItem(dependencies, { pk: row.pk, sk: row.sk });
      if (current?.leaseToken !== token) return "stale";
      const wake = typeof current.wakeAt === "number" && Number.isFinite(current.wakeAt) ? current.wakeAt : undefined;
      const next = wake !== undefined && wake > claimedAt ? Math.min(nextAttemptAt, Math.max(now, wake + TRACKING_COALESCE_MS)) : nextAttemptAt;
      try {
        await write(next, wake === undefined ? " AND attribute_not_exists(wakeAt)" : " AND wakeAt = :seenWake", wake === undefined ? {} : { ":seenWake": wake });
        return "committed";
      } catch (error) {
        if (!isConditional(error)) throw error;
      }
    }
    await write(Math.min(nextAttemptAt, now + TRACKING_COALESCE_MS), "", {});
    return "committed";
  } catch (error) {
    return isConditional(error) ? "stale" : "unknown";
  }
}

async function retire(
  dependencies: MergeRecoveryDependencies,
  row: RecoveryRow,
  token: string,
  now: number,
): Promise<Settlement> {
  try {
    await dependencies.documentClient.send(new UpdateCommand({
      TableName: dependencies.tableName,
      Key: { pk: row.pk, sk: row.sk },
      UpdateExpression: "SET recoveryStatus = :status, retiredAt = :now, updatedAt = :now, indexExpiresAt = :ttl REMOVE nextAttemptAt, dispatchDuePk, dispatchDueSk, leaseToken, leaseExpiresAt",
      ConditionExpression: "leaseToken = :token",
      ExpressionAttributeValues: {
        ":status": "RETIRED",
        ":now": new Date(now).toISOString(),
        ":ttl": Math.floor(now / 1_000) + RETIRED_TTL_SECONDS,
        ":token": token,
      },
    }));
    return "committed";
  } catch (error) {
    return isConditional(error) ? "stale" : "unknown";
  }
}

async function setGlobalCooldown(
  dependencies: MergeRecoveryDependencies,
  token: string,
  retryAt: number,
  now: number,
  lane: Lane = MERGE_LANE,
): Promise<Settlement> {
  let global: GlobalSweepRow;
  try {
    global = await readItem(dependencies, { pk: SWEEP_PK, sk: lane.gateSk }) ?? {};
  } catch {
    return "unknown";
  }
  if (global.leaseToken !== token || typeof global.nextSweepAt !== "number") return "stale";
  const next = Math.max(global.nextSweepAt, retryAt);
  try {
    await dependencies.documentClient.send(new UpdateCommand({
      TableName: dependencies.tableName,
      Key: { pk: SWEEP_PK, sk: lane.gateSk },
      UpdateExpression: "SET nextSweepAt = :next, updatedAt = :now",
      ConditionExpression: "leaseToken = :token AND nextSweepAt = :current",
      ExpressionAttributeValues: {
        ":next": next,
        ":now": new Date(now).toISOString(),
        ":token": token,
        ":current": global.nextSweepAt,
      },
    }));
  } catch (error) {
    return isConditional(error) ? "stale" : "unknown";
  }
  // The limit is GitHub's, not the lane's: the other pass waits for it as well. Marking it is best effort; the lane's own gate already holds.
  try {
    await dependencies.documentClient.send(new UpdateCommand({
      TableName: dependencies.tableName,
      Key: { pk: SWEEP_PK, sk: SWEEP_SK },
      UpdateExpression: "SET rateLimitedUntil = :limit, updatedAt = :now",
      ConditionExpression: "attribute_not_exists(rateLimitedUntil) OR rateLimitedUntil < :limit",
      ExpressionAttributeValues: { ":limit": retryAt, ":now": new Date(now).toISOString() },
    }));
  } catch {
    // Already as late or later, or not writable now.
  }
  return "committed";
}

async function terminalReceipt(
  dependencies: MergeRecoveryDependencies,
  taskId: string,
): Promise<"confirmed" | "queued" | "missing" | "unproven"> {
  const task = taskRecord(await readItem(dependencies, { pk: `DEVTASK#${taskId}`, sk: "META" }), taskId);
  if (task === undefined) return "missing";

  if (task.closedAt !== undefined) {
    if (typeof task.workspaceId !== "string"
      || typeof task.charge?.member?.pk !== "string"
      || typeof task.charge.member.sk !== "string"
      || typeof task.charge?.organization?.pk !== "string"
      || typeof task.charge.organization.sk !== "string") return "unproven";
    const workspace = await readItem(dependencies, { pk: `WORKSPACE#${task.workspaceId}`, sk: "META" });
    const member = await readItem(dependencies, { pk: task.charge.member.pk, sk: task.charge.member.sk });
    const organization = await readItem(dependencies, { pk: task.charge.organization.pk, sk: task.charge.organization.sk });
    const tasks = member?.tasks;
    const readableTasks = tasks === undefined || tasks instanceof Set;
    const memberReleased = typeof member?.count === "number" && member.count >= 0 && readableTasks
      && (tasks === undefined || !tasks.has(taskId));
    const organizationReleased = typeof organization?.count === "number" && organization.count >= 0
      && (!(organization.tasks instanceof Set) || !organization.tasks.has(taskId));
    return workspace?.status === "CLOSED" && memberReleased && organizationReleased ? "confirmed" : "unproven";
  }

  if (task.releasedAt !== undefined && typeof task.workspaceId === "string") {
    const workspace = await readItem(dependencies, { pk: `WORKSPACE#${task.workspaceId}`, sk: "META" });
    if (workspace?.status === "CLOSED") return "confirmed";
  }

  const marker = await readItem(dependencies, { pk: "FINISHED_RELEASE", sk: `TASK#${taskId}` });
  return marker?.entityType === "FINISHED_RELEASE" && marker.taskId === taskId ? "queued" : "unproven";
}

function makeBudget(dependencies: MergeRecoveryDependencies, startedAt: number, budgetMs: number = GITHUB_BUDGET_MS): {
  budget: GithubMergeReadBudget;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
} {
  const controller = new AbortController();
  let requests = 0;
  const timer = setTimeout(() => controller.abort(), budgetMs);
  timer.unref();
  return {
    controller,
    timer,
    budget: {
      signal: controller.signal,
      beforeRequest: () => {
        if (controller.signal.aborted || dependencies.now() >= startedAt + budgetMs) {
          controller.abort();
          throw new GithubBudgetExhaustedError("workflow merge recovery GitHub deadline exhausted");
        }
        if (requests >= MAX_REQUESTS) {
          controller.abort();
          throw new GithubBudgetExhaustedError("workflow merge recovery GitHub request budget exhausted");
        }
        requests += 1;
      },
    },
  };
}

/** The merge pass: kind-less rows, one global gate every 5 minutes, 10 rows a pass (today's behaviour, unchanged). */
export async function runDueWorkflowMergeRecovery(
  dependencies: MergeRecoveryDependencies,
): Promise<{ attempted: number; reconciled: number; deferred: number }> {
  return runSweep(dependencies, MERGE_LANE, GITHUB_BUDGET_MS);
}

/**
 * The Rovara Code tracking pass (Plan 6 Task 14): tracking rows only, in their own due partition and behind their own gate, opened every `TRACKING_GATE_SECONDS`, at most
 * `TRACKING_MAX_ROWS` rows a pass. `budgetMs` is the time the pass may spend (the Lambda runs the merge pass first, and this one with what is left).
 */
export async function runDueWorkflowMergeTracking(
  dependencies: MergeRecoveryDependencies,
  /**
   * `wokenOnly` (approval-to-ready latency): the pass for rows a webhook woke (they carry `wakeAt`) and that are due. It does not wait for the heartbeat gate and does not move it, reads only the
   * woken rows (each once: a burst of deliveries is one row, one pass), and leaves every other due row to the gated pass. Run it on every schedule tick after the gated pass.
   */
  options: { budgetMs?: number; wokenOnly?: true } = {},
): Promise<{ attempted: number; reconciled: number; deferred: number }> {
  return runSweep(dependencies, TRACKING_LANE, Math.min(options.budgetMs ?? GITHUB_BUDGET_MS, GITHUB_BUDGET_MS), options.wokenOnly === true);
}

async function runSweep(
  dependencies: MergeRecoveryDependencies,
  lane: Lane,
  budgetMs: number,
  wokenOnly = false,
): Promise<{ attempted: number; reconciled: number; deferred: number }> {
  const startedAt = dependencies.now();
  const globalToken = randomUUID();
  const result = { attempted: 0, reconciled: 0, deferred: 0 };
  if (budgetMs <= GITHUB_START_RESERVE_MS) return result;
  // The woken pass takes the gate only when some row is due, so a quiet tick writes nothing.
  if (wokenOnly) {
    try {
      if ((await queryDueRows(dependencies, startedAt, lane)).length === 0) return result;
    } catch {
      return result;
    }
  }
  if (!await claimGlobalSweep(dependencies, startedAt, globalToken, lane, wokenOnly)) return result;

  const { budget, controller, timer } = makeBudget(dependencies, startedAt, budgetMs);
  let keepGlobalLease = false;
  try {
    let discovered: Record<string, unknown>[];
    try {
      discovered = await queryDueRows(dependencies, startedAt, lane);
    } catch {
      keepGlobalLease = true;
      return result;
    }

    for (const discovery of discovered) {
      if (dependencies.now() > startedAt + budgetMs - GITHUB_START_RESERVE_MS) break;
      if (typeof discovery.pk !== "string" || typeof discovery.sk !== "string") {
        result.deferred += 1;
        continue;
      }
      let current: Record<string, unknown> | undefined;
      try {
        current = await readItem(dependencies, { pk: discovery.pk, sk: discovery.sk });
      } catch {
        result.deferred += 1;
        keepGlobalLease = true;
        break;
      }
      const row = recoveryRow(current);
      if (row === undefined) {
        const settled = await quarantine(dependencies, current ?? discovery, dependencies.now(), "MALFORMED_DISCOVERY");
        result.deferred += 1;
        if (settled === "unknown") {
          keepGlobalLease = true;
          break;
        }
        continue;
      }
      // A row read in the other lane was converted between the query and the read: the other pass has it.
      if ((row.kind === "tracking") !== (lane.kind === "tracking")) continue;
      // The woken pass leaves a row nobody woke to the gated heartbeat pass.
      if (wokenOnly && row.wakeAt === undefined) continue;
      if (row.nextAttemptAt > dependencies.now() || (row.leaseExpiresAt !== undefined && row.leaseExpiresAt > dependencies.now())) continue;

      let task: TaskRecord | undefined;
      try {
        task = taskRecord(await readItem(dependencies, { pk: `DEVTASK#${row.taskId}`, sk: "META" }), row.taskId);
      } catch {
        result.deferred += 1;
        keepGlobalLease = true;
        break;
      }
      if (task === undefined) {
        const settled = await quarantine(dependencies, row as unknown as Record<string, unknown>, dependencies.now(), "MISSING_TASK");
        result.deferred += 1;
        if (settled === "unknown") {
          keepGlobalLease = true;
          break;
        }
        continue;
      }

      const rowToken = randomUUID();
      const claimedAt = dependencies.now();
      const claimed = await claimRow(dependencies, row, claimedAt, rowToken);
      if (claimed === undefined) continue;
      result.attempted += 1;

      let outcome: MergeRecoveryResult;
      try {
        outcome = await dependencies.reconcile(claimed.taskId, budget);
      } catch (error) {
        const now = dependencies.now();
        const settlement = await settleActive(dependencies, claimed, rowToken, now, now + lane.retryDelay(claimed.attempts), claimed.attempts, lane.kind === "tracking" ? claimedAt : undefined);
        result.deferred += 1;
        if (settlement === "unknown" || error instanceof GithubBudgetExhaustedError || controller.signal.aborted) {
          keepGlobalLease = settlement === "unknown";
          break;
        }
        continue;
      }

      const now = dependencies.now();
      if (outcome.kind === "RETRY" && !representableDateMilliseconds(outcome.retryAt)) {
        const settlement = await settleActive(dependencies, claimed, rowToken, now, now + lane.retryDelay(claimed.attempts), claimed.attempts, lane.kind === "tracking" ? claimedAt : undefined);
        result.deferred += 1;
        if (settlement === "unknown") keepGlobalLease = true;
        if (outcome.scope === "github-global" || settlement === "unknown") return result;
        continue;
      }
      if (outcome.kind === "MISSING") {
        const settlement = await quarantine(dependencies, claimed as unknown as Record<string, unknown>, now, "RECONCILE_MISSING", rowToken);
        result.deferred += 1;
        if (settlement === "unknown") {
          keepGlobalLease = true;
          break;
        }
        continue;
      }

      if (outcome.kind === "RETRY" && outcome.scope === "github-global") {
        const cooldown = await setGlobalCooldown(dependencies, globalToken, outcome.retryAt, now, lane);
        result.deferred += 1;
        if (cooldown === "committed") {
          const next = Math.max(outcome.retryAt, now + lane.retryDelay(claimed.attempts));
          const settlement = await settleActive(dependencies, claimed, rowToken, now, next, claimed.attempts, lane.kind === "tracking" ? claimedAt : undefined);
          if (settlement === "unknown") keepGlobalLease = true;
        } else {
          keepGlobalLease = true;
        }
        return result;
      }

      if (outcome.kind === "TERMINAL") {
        let receipt: "confirmed" | "queued" | "missing" | "unproven";
        try {
          receipt = await terminalReceipt(dependencies, claimed.taskId);
        } catch {
          receipt = "unproven";
        }
        if (receipt === "missing") {
          const settlement = await quarantine(dependencies, claimed as unknown as Record<string, unknown>, now, "MISSING_TASK", rowToken);
          result.deferred += 1;
          if (settlement === "unknown") {
            keepGlobalLease = true;
            break;
          }
          continue;
        }
        if (receipt === "confirmed" || receipt === "queued") {
          const settlement = await retire(dependencies, claimed, rowToken, now);
          if (settlement === "committed") result.reconciled += 1;
          else result.deferred += 1;
          if (settlement === "unknown") {
            keepGlobalLease = true;
            break;
          }
          continue;
        }
        const settlement = await settleActive(dependencies, claimed, rowToken, now, now + lane.retryDelay(claimed.attempts), claimed.attempts, lane.kind === "tracking" ? claimedAt : undefined);
        result.deferred += 1;
        if (settlement === "unknown") {
          keepGlobalLease = true;
          break;
        }
        continue;
      }

      const next = outcome.kind === "RETRY"
        ? Math.max(outcome.retryAt, now + lane.retryDelay(claimed.attempts))
        : lane.kind === "tracking" ? trackingObservedNext(now, outcome.nextAt) : now + SWEEP_INTERVAL_MS;
      const attempts = outcome.kind === "OBSERVED" ? 0 : claimed.attempts;
      const settlement = await settleActive(dependencies, claimed, rowToken, now, next, attempts, lane.kind === "tracking" ? claimedAt : undefined);
      if (settlement === "committed" && outcome.kind === "OBSERVED") result.reconciled += 1;
      else result.deferred += 1;
      if (settlement === "unknown") {
        keepGlobalLease = true;
        break;
      }
    }
    return result;
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (!keepGlobalLease) await releaseGlobalSweep(dependencies, globalToken, dependencies.now(), lane);
  }
}
