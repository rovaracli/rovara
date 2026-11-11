// The drain: every minute, sends whatever the flush did not deliver. Idempotent by construction: the queue deduplicates on
// the event id for five minutes and the appender claims every event id, so an event sent twice is appended once.
import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { AUDIT_PENDING_FAIL_AFTER_DAYS, AUDIT_PENDING_SHARDS, AuditEventInputSchema } from "@agentx/cloud-contracts";
import { deleteAuditPending, sendAuditEvents } from "./flush.js";
import { auditEventWithoutDetails, auditPendingPartition, describeInvalidAuditEvent, type AuditDeps, type AuditPendingItem, type AuditRuntime } from "./outbox.js";

/** An item younger than this belongs to the flush that just ran, so the drain leaves it alone. */
export const AUDIT_DRAIN_MIN_AGE_MS = 30_000;
/** An item older than this is stuck: the drain has been failing to deliver it. */
export const AUDIT_DRAIN_STUCK_AGE_MS = 10 * 60_000;
export const AUDIT_DRAIN_PAGE_SIZE = 100;
/** Items examined by one call; the caller resumes from `cursor` while it has time. */
export const AUDIT_DRAIN_MAX_ITEMS = 500;
/** How long the scheduled run keeps draining before it stops and leaves the rest to the next minute. */
export const AUDIT_DRAIN_BUDGET_MS = 20_000;

export interface AuditDrainCursor {
  shard: number;
  /** The sort key of the last item examined in `shard`. */
  after?: string;
}

export interface AuditDrainResult {
  examined: number;
  sent: number;
  failed: number;
  stuck: number;
  /** Items that reached AUDIT_PENDING_FAIL_AFTER_DAYS this call (logged as audit.record_failed). */
  expiring: number;
  /** Set when the call stopped early; pass it back to continue. */
  cursor?: AuditDrainCursor;
}

const DAY_MS = 86_400_000;

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

function ageMs(item: AuditPendingItem, nowMs: number): number {
  const created = Date.parse(item.createdAt);
  return nowMs - (Number.isNaN(created) ? Date.parse(item.sk.slice(0, item.sk.indexOf("#"))) : created);
}

/** Counts a failed send on a pending item that still exists (the condition stops an update from recreating a deleted one). */
async function countAttempts(audit: AuditRuntime, item: AuditPendingItem): Promise<void> {
  try {
    await audit.documentClient.send(new UpdateCommand({
      TableName: audit.tableName,
      Key: { pk: item.pk, sk: item.sk },
      UpdateExpression: "SET #attempts = if_not_exists(#attempts, :zero) + :one",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeNames: { "#attempts": "attempts" },
      ExpressionAttributeValues: { ":zero": 0, ":one": 1 },
    }));
  } catch (error) {
    if (errorName(error) !== "ConditionalCheckFailedException") audit.log({ event: "audit.drain_attempts_failed", level: "warn", error: errorName(error) });
  }
}

/**
 * Logs `audit.record_failed` once for an item that is about to reach its TTL undelivered. "Once" is the conditional write
 * of `failedLoggedAt`; if that write fails for another reason the line is logged anyway (a repeat beats silence).
 */
async function logFailedOnce(audit: AuditRuntime, item: AuditPendingItem, nowMs: number): Promise<boolean> {
  try {
    await audit.documentClient.send(new UpdateCommand({
      TableName: audit.tableName,
      Key: { pk: item.pk, sk: item.sk },
      UpdateExpression: "SET #logged = :now",
      ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(#logged)",
      ExpressionAttributeNames: { "#logged": "failedLoggedAt" },
      ExpressionAttributeValues: { ":now": new Date(nowMs).toISOString() },
    }));
  } catch (error) {
    if (errorName(error) === "ConditionalCheckFailedException") return false;
  }
  audit.log({ event: "audit.record_failed", level: "error", reason: "undelivered_before_expiry", ageDays: Math.floor(ageMs(item, nowMs) / DAY_MS), attempts: item.attempts, record: auditEventWithoutDetails(item.event) });
  return true;
}

/**
 * For each shard, oldest first: sends the items older than 30 seconds, ten to a call, deletes the ones the queue
 * accepts and counts a failed attempt on the others. An item still undelivered after 10 minutes logs
 * `audit.pending_stuck`; one at AUDIT_PENDING_FAIL_AFTER_DAYS logs `audit.record_failed` once, with the event but not its
 * details, before the 14-day TTL can remove it. When a call finds the queue unreachable the rest of the call only does
 * that bookkeeping, so a long outage costs queries and no timeouts. Stops after `maxItems` and returns a cursor.
 */
export async function drainAuditPending(
  deps: AuditDeps,
  nowMs: number,
  cursor?: AuditDrainCursor,
  options: { maxItems?: number } = {},
): Promise<AuditDrainResult> {
  const result: AuditDrainResult = { examined: 0, sent: 0, failed: 0, stuck: 0, expiring: 0 };
  const audit = deps.audit;
  if (audit === undefined) return result;
  const maxItems = options.maxItems ?? AUDIT_DRAIN_MAX_ITEMS;
  const cutoff = new Date(nowMs - AUDIT_DRAIN_MIN_AGE_MS).toISOString();
  let sendingDisabled = false;

  for (let shard = cursor?.shard ?? 0; shard < AUDIT_PENDING_SHARDS; shard += 1) {
    const partition = auditPendingPartition(shard);
    let after = cursor !== undefined && shard === cursor.shard ? cursor.after : undefined;
    for (;;) {
      if (result.examined >= maxItems) return { ...result, cursor: { shard, ...(after === undefined ? {} : { after }) } };
      let page;
      try {
        page = await audit.documentClient.send(new QueryCommand({
          TableName: audit.tableName,
          ConsistentRead: true,
          Limit: AUDIT_DRAIN_PAGE_SIZE,
          KeyConditionExpression: "pk = :pk AND sk < :cutoff",
          ExpressionAttributeValues: { ":pk": partition, ":cutoff": cutoff },
          ...(after === undefined ? {} : { ExclusiveStartKey: { pk: partition, sk: after } }),
        }));
      } catch (error) {
        audit.log({ event: "audit.drain_failed", level: "error", error: errorName(error) });
        return result;
      }
      const items: AuditPendingItem[] = [];
      for (const raw of (page.Items ?? []) as AuditPendingItem[]) {
        if (!AuditEventInputSchema.safeParse(raw.event).success) audit.log(describeInvalidAuditEvent(raw.event));
        else items.push(raw);
      }
      result.examined += (page.Items ?? []).length;

      const events = items.map((item) => item.event);
      let undelivered: AuditPendingItem[] = items;
      if (!sendingDisabled && items.length > 0) {
        const outcome = await sendAuditEvents(audit, events);
        if (outcome.unreachable) sendingDisabled = true;
        const sent = new Set(outcome.sent.map((event) => event.eventId));
        const failed = new Set(outcome.failed.map((event) => event.eventId));
        if (outcome.sent.length > 0) await deleteAuditPending(audit, outcome.sent);
        result.sent += outcome.sent.length;
        result.failed += outcome.failed.length;
        await Promise.all(items.filter((item) => failed.has(item.event.eventId)).map((item) => countAttempts(audit, item)));
        undelivered = items.filter((item) => !sent.has(item.event.eventId));
      }
      for (const item of undelivered) {
        const age = ageMs(item, nowMs);
        if (age >= AUDIT_PENDING_FAIL_AFTER_DAYS * DAY_MS && await logFailedOnce(audit, item, nowMs)) result.expiring += 1;
        if (age >= AUDIT_DRAIN_STUCK_AGE_MS) {
          result.stuck += 1;
          audit.log({ event: "audit.pending_stuck", level: "error", ageMinutes: Math.floor(age / 60_000), attempts: item.attempts, record: auditEventWithoutDetails(item.event) });
        }
      }

      if (page.LastEvaluatedKey === undefined) break;
      after = String((page.LastEvaluatedKey as { sk?: unknown }).sk);
    }
  }
  if (result.examined > 0) audit.log({ event: "audit.drain", level: "info", examined: result.examined, sent: result.sent, failed: result.failed, stuck: result.stuck });
  return result;
}

/** The scheduled run: drains in slices until it is done or `budgetMs` has passed (the broker function has 30 s). */
export async function runAuditDrain(deps: AuditDeps, options: { budgetMs?: number; now?: () => number } = {}): Promise<AuditDrainResult & { more: boolean }> {
  const clock = options.now ?? Date.now;
  const started = clock();
  const budget = options.budgetMs ?? AUDIT_DRAIN_BUDGET_MS;
  const total: AuditDrainResult = { examined: 0, sent: 0, failed: 0, stuck: 0, expiring: 0 };
  let cursor: AuditDrainCursor | undefined;
  do {
    const slice = await drainAuditPending(deps, clock(), cursor);
    total.examined += slice.examined;
    total.sent += slice.sent;
    total.failed += slice.failed;
    total.stuck += slice.stuck;
    total.expiring += slice.expiring;
    cursor = slice.cursor;
  } while (cursor !== undefined && clock() - started < budget);
  return { ...total, more: cursor !== undefined };
}
