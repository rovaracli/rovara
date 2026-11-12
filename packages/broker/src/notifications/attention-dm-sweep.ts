// A person's attention direct message waits in a `NOTIFY_DM` row (`attention.ts` writes it, the Slack notifier posts it: PENDING, then SENDING while one worker holds the claim, then SENT, or back to PENDING when the post failed).
// The notifier retries a notice for one hour and then drops it; a dropped notice is not a failed batch, so nothing queued it again, and the row stayed PENDING until the table expired it (found live on staging,
// 2026-11-12: a missing IAM grant refused every DM for an hour, and none was ever sent after the grant was fixed).
//
// This sweep runs on the broker's five-minute session sweep (no schedule of its own, no new grant: the broker already reads and writes the table). For each row of the NOTIFY_DM partition:
//   - PENDING, past the notifier's retry window, younger than 24 hours: "requeued". The row's `resweptAt` and `resweepCount` are set; that write reaches the notifier through the table's stream as a fresh notice
//     (`noticesOf`), and the notifier delivers it through the same claim as always (`deliverAttentionDm`: PENDING to SENDING to SENT, given back when the post fails), so a message is never posted twice, however many
//     sweeps or notices meet. The write is conditional on the row still being PENDING and not requeued since the cut-off, so two sweeps at once requeue it once.
//   - PENDING, older than 24 hours: "missed". The row is marked MISSED and NOT sent (a burst of stale messages after an outage helps nobody). The person still finds what is open under "Needs you" on Home, which is read from the
//     tasks themselves and never from these rows. A MISSED row is kept two days more so Health can count it.
// Counts only are logged. One company's rows are never read as another's: a row counts only when its sort key begins with its own `orgId`.
import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { AdminHealthCheck } from "@rovara-code/contracts";
import { INDEX_EXPIRY_ATTRIBUTE } from "@rovara-code/contracts";
import { ATTENTION_DM_FAILURE_KEEP_SECONDS, ATTENTION_DM_MAX_AGE_MS, ATTENTION_DM_REQUEUE_AFTER_MS } from "./attention-dm-limits.js";

type Item = Record<string, unknown>;
interface Table { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; now: () => number }

const DM_PK = "NOTIFY_DM";
const PAGE = 100;
/** The most rows one sweep reads (the partition holds at most two days of messages). */
export const ATTENTION_DM_SWEEP_READ_MAX = 2000;
/** The most rows one sweep puts in front of the notifier again, oldest first (they have the least time left). */
export const ATTENTION_DM_REQUEUE_BATCH_MAX = 25;
/** The most rows one sweep marks MISSED. */
export const ATTENTION_DM_MISSED_BATCH_MAX = 100;

export interface AttentionDmSweepOutcome { read: number; requeued: number; missed: number; skipped: number; failed: number }

interface DmRow { sk: string; at: string; atMs: number; lastMs: number; resweptAt: number | undefined }

/** The row as the sweep may act on it: a well formed attention DM of its own company, still PENDING. Anything else is left alone. */
function pendingRowOf(item: Item): DmRow | undefined {
  const { sk, orgId, at, status } = item;
  if (item["pk"] !== DM_PK || item["entityType"] !== "TASK_ATTENTION_DM" || status !== "PENDING") return undefined;
  if (typeof sk !== "string" || typeof orgId !== "string" || orgId === "" || !sk.startsWith(`${orgId}#`) || typeof at !== "string") return undefined;
  const atMs = Date.parse(at);
  if (Number.isNaN(atMs)) return undefined;
  const resweptAt = typeof item["resweptAt"] === "number" && Number.isFinite(item["resweptAt"]) ? item["resweptAt"] : undefined;
  return { sk, at, atMs, lastMs: Math.max(atMs, resweptAt ?? 0), resweptAt };
}

const isConditional = (error: unknown): boolean => error instanceof Error && error.name === "ConditionalCheckFailedException";

/** Pages of the NOTIFY_DM partition (or of one company's part of it), at most `ATTENTION_DM_SWEEP_READ_MAX` rows, stopping at the deadline. */
async function* rowsOf(deps: Table, orgPrefix: string | undefined, deadlineMs: number | undefined): AsyncGenerator<Item> {
  let start: Record<string, unknown> | undefined, read = 0;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, ConsistentRead: true, Limit: PAGE, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
      ...(orgPrefix === undefined
        ? { KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": DM_PK } }
        : { KeyConditionExpression: "pk = :pk AND begins_with(sk, :org)", ExpressionAttributeValues: { ":pk": DM_PK, ":org": orgPrefix } }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) { read += 1; yield item; }
    start = page.LastEvaluatedKey;
  } while (start !== undefined && read < ATTENTION_DM_SWEEP_READ_MAX && (deadlineMs === undefined || deps.now() < deadlineMs));
}

/** The sweep: requeues stranded messages and marks the stale ones MISSED. Never throws for one row; a read that fails throws (the caller logs it). */
export async function sweepAttentionDms(deps: Table & { log?: ((entry: Record<string, unknown>) => void) | undefined }, budget: { deadlineMs?: number | undefined } = {}): Promise<AttentionDmSweepOutcome> {
  const log = deps.log ?? ((entry: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", ...entry })));
  const outcome: AttentionDmSweepOutcome = { read: 0, requeued: 0, missed: 0, skipped: 0, failed: 0 };
  const nowMs = deps.now();
  const requeue: DmRow[] = [], stale: DmRow[] = [];
  for await (const item of rowsOf(deps, undefined, budget.deadlineMs)) {
    outcome.read += 1;
    if (item["status"] !== "PENDING") continue;
    const row = pendingRowOf(item);
    if (row === undefined) { outcome.skipped += 1; continue; }
    // Age is the row's own: the time it was written. A row written in the future (a bad clock) is never old.
    if (nowMs - row.atMs >= ATTENTION_DM_MAX_AGE_MS) stale.push(row);
    else if (nowMs - row.lastMs >= ATTENTION_DM_REQUEUE_AFTER_MS) requeue.push(row);
  }
  const late = () => budget.deadlineMs !== undefined && deps.now() >= budget.deadlineMs;
  requeue.sort((left, right) => left.atMs - right.atMs);
  for (const row of requeue.slice(0, ATTENTION_DM_REQUEUE_BATCH_MAX)) {
    if (late()) break;
    try {
      await deps.documentClient.send(new UpdateCommand({
        TableName: deps.tableName, Key: { pk: DM_PK, sk: row.sk },
        UpdateExpression: "SET resweptAt = :now ADD resweepCount :one",
        // Still PENDING, still the same message, and not requeued since the cut-off: of two sweeps at once, one wins.
        ConditionExpression: "#status = :pending AND #at = :at AND (attribute_not_exists(resweptAt) OR resweptAt <= :cutoff)",
        ExpressionAttributeNames: { "#status": "status", "#at": "at" },
        ExpressionAttributeValues: { ":now": nowMs, ":one": 1, ":pending": "PENDING", ":at": row.at, ":cutoff": nowMs - ATTENTION_DM_REQUEUE_AFTER_MS },
      }));
      outcome.requeued += 1;
    } catch (error) {
      if (isConditional(error)) outcome.skipped += 1; else { outcome.failed += 1; log({ event: "attention_dm.requeue_failed", error: error instanceof Error ? error.name : "unknown" }); }
    }
  }
  for (const row of stale.slice(0, ATTENTION_DM_MISSED_BATCH_MAX)) {
    if (late()) break;
    try {
      await deps.documentClient.send(new UpdateCommand({
        TableName: deps.tableName, Key: { pk: DM_PK, sk: row.sk },
        UpdateExpression: `SET #status = :missed, missedAt = :now, ${INDEX_EXPIRY_ATTRIBUTE} = :expires`,
        ConditionExpression: "#status = :pending AND #at = :at",
        ExpressionAttributeNames: { "#status": "status", "#at": "at" },
        ExpressionAttributeValues: { ":missed": "MISSED", ":pending": "PENDING", ":at": row.at, ":now": new Date(nowMs).toISOString(), ":expires": Math.floor(nowMs / 1000) + ATTENTION_DM_FAILURE_KEEP_SECONDS },
      }));
      outcome.missed += 1;
    } catch (error) {
      if (isConditional(error)) outcome.skipped += 1; else { outcome.failed += 1; log({ event: "attention_dm.missed_failed", error: error instanceof Error ? error.name : "unknown" }); }
    }
  }
  if (outcome.requeued > 0 || outcome.missed > 0 || outcome.failed > 0) log({ event: "attention_dm.swept", ...outcome, waiting: Math.max(0, requeue.length - outcome.requeued), staleLeft: Math.max(0, stale.length - outcome.missed) });
  return outcome;
}

/** What Health says about one company's attention messages that did not reach the person. */
export interface AttentionDmProblems { missed: number; stranded: number; lastAt?: string }

/**
 * Health: the company's attention messages still in the table (they expire two days after they were written, or after they were marked MISSED) that did not go out: MISSED ones, and PENDING ones the notifier gave up on
 * (a recorded delivery failure) or that waited past its retry window without being sent. Counts only. Read under the company's own sort-key prefix, and each row must say it is that company's.
 */
export async function readAttentionDmProblems(deps: Table, orgId: string): Promise<AttentionDmProblems> {
  const nowMs = deps.now();
  let missed = 0, stranded = 0, latest = 0;
  for await (const item of rowsOf(deps, `${orgId}#`, undefined)) {
    if (item["pk"] !== DM_PK || item["entityType"] !== "TASK_ATTENTION_DM" || item["orgId"] !== orgId || typeof item["sk"] !== "string" || !item["sk"].startsWith(`${orgId}#`)) continue;
    const when = (value: unknown) => { const ms = typeof value === "string" ? Date.parse(value) : Number.NaN; return Number.isNaN(ms) ? 0 : ms; };
    if (item["status"] === "MISSED") { missed += 1; latest = Math.max(latest, when(item["missedAt"]), when(item["at"])); continue; }
    if (item["status"] !== "PENDING") continue;
    const row = pendingRowOf(item);
    const failedAt = when(item["lastFailedAt"]);
    if (failedAt > 0 || (row !== undefined && nowMs - row.lastMs >= ATTENTION_DM_REQUEUE_AFTER_MS)) { stranded += 1; latest = Math.max(latest, failedAt, row?.lastMs ?? 0); }
  }
  return { missed, stranded, ...(latest === 0 ? {} : { lastAt: new Date(latest).toISOString() }) };
}

const plural = (count: number, one: string, many: string) => `${String(count)} ${count === 1 ? one : many}`;

/** The Health line: absent when every message went out (nothing to say), a warning with the counts otherwise. */
export function attentionDmCheck(problems: AttentionDmProblems): AdminHealthCheck | undefined {
  if (problems.missed === 0 && problems.stranded === 0) return undefined;
  const parts = [
    ...(problems.stranded === 0 ? [] : [`${plural(problems.stranded, "Slack message has", "Slack messages have")} not been delivered and ${problems.stranded === 1 ? "is" : "are"} being retried`]),
    ...(problems.missed === 0 ? [] : [`${plural(problems.missed, "Slack message was", "Slack messages were")} not sent because ${problems.missed === 1 ? "it was" : "they were"} more than a day old (still on Home under Needs you)`]),
  ];
  return { status: "warn", detail: `${parts.join("; ")}${problems.lastAt === undefined ? "" : `; latest ${problems.lastAt}`}` };
}
