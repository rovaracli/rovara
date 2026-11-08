// Delivery of audit events to the intake queue. `flushAuditEvents` runs right after an action's transaction commits and
// is bounded by AUDIT_FLUSH_DEADLINE_MS; whatever it does not finish stays as a pending item for the drain.
import { SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import { DeleteCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  AUDIT_ERROR_MESSAGES,
  AUDIT_FLUSH_DEADLINE_MS,
  AUDIT_SDK_REQUEST_TIMEOUT_MS,
  AuditEventInputSchema,
  agentXError,
  type AuditEventInput,
} from "@agentx/contracts";
import { auditEventWithoutDetails, auditPendingItem, auditPendingKey, describeInvalidAuditEvent, type AuditDeps, type AuditRuntime } from "./outbox.js";

/** SendMessageBatch takes at most ten entries. */
export const AUDIT_SEND_BATCH_SIZE = 10;

type Within<T> = { completed: true; value: T } | { completed: false };

/** Runs `work` for at most `ms`, aborting its signal when the time is up. The caller gets control back at `ms` even if `work` ignores the signal. */
async function within<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<Within<T>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<Within<T>>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ completed: false });
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal).then((value): Within<T> => ({ completed: true, value })), expired]);
  } finally {
    clearTimeout(timer);
  }
}

export interface AuditSendOutcome {
  /** Accepted by the queue. */
  sent: AuditEventInput[];
  /** Offered to the queue and not accepted. */
  failed: AuditEventInput[];
  /** Not offered: the signal fired, or an earlier call showed the queue unreachable. */
  skipped: AuditEventInput[];
  /** A call threw: the queue is unreachable or too slow, so nothing after it was tried. */
  unreachable: boolean;
}

/**
 * Sends events in order, ten to a call, one call at a time (so one org's events keep their order within the queue's
 * message group). The queue deduplicates on the event id for five minutes, and the appender claims every event id, so
 * sending an event twice is harmless. Never throws.
 */
export async function sendAuditEvents(audit: AuditRuntime, events: AuditEventInput[], signal?: AbortSignal): Promise<AuditSendOutcome> {
  const outcome: AuditSendOutcome = { sent: [], failed: [], skipped: [], unreachable: false };
  for (let start = 0; start < events.length; start += AUDIT_SEND_BATCH_SIZE) {
    const chunk = events.slice(start, start + AUDIT_SEND_BATCH_SIZE);
    if (outcome.unreachable || signal?.aborted === true) {
      outcome.skipped.push(...chunk);
      continue;
    }
    try {
      const response = await audit.sqs.send(new SendMessageBatchCommand({
        QueueUrl: audit.queueUrl,
        Entries: chunk.map((event, index) => ({
          Id: `e${String(index)}`,
          MessageBody: JSON.stringify(event),
          MessageGroupId: event.orgId,
          MessageDeduplicationId: event.eventId,
        })),
      }), signal === undefined ? undefined : { abortSignal: signal });
      const accepted = new Set((response.Successful ?? []).map((entry) => entry.Id));
      for (const [index, event] of chunk.entries()) (accepted.has(`e${String(index)}`) ? outcome.sent : outcome.failed).push(event);
    } catch {
      outcome.failed.push(...chunk);
      outcome.unreachable = true;
    }
  }
  return outcome;
}

/** Deletes the pending items of events the queue has accepted. A failed delete is only logged: the drain resends the event and the appender drops the duplicate. */
export async function deleteAuditPending(audit: AuditRuntime, events: AuditEventInput[]): Promise<void> {
  const results = await Promise.allSettled(events.map((event) => audit.documentClient.send(new DeleteCommand({ TableName: audit.tableName, Key: auditPendingKey(event) }))));
  const failed = results.filter((result) => result.status === "rejected").length;
  if (failed > 0) audit.log({ event: "audit.pending_delete_failed", level: "warn", count: failed });
}

/**
 * After the action's transaction has committed: sends its events and deletes the pending items of those the queue
 * accepted. The whole call returns when AUDIT_FLUSH_DEADLINE_MS passes; what is not done stays pending for the drain.
 * Never throws, and never waits longer than the deadline.
 */
export async function flushAuditEvents(deps: AuditDeps, events: AuditEventInput[]): Promise<void> {
  const audit = deps.audit;
  if (audit === undefined || audit.pendingOnly === true) return;
  try {
    // An invalid event has no pending item (auditPending logged it); there is nothing to send.
    const valid = events.filter((event) => AuditEventInputSchema.safeParse(event).success);
    if (valid.length === 0) return;
    const result = await within(AUDIT_FLUSH_DEADLINE_MS, async (signal) => {
      const outcome = await sendAuditEvents(audit, valid, signal);
      if (outcome.sent.length > 0) await deleteAuditPending(audit, outcome.sent);
    });
    if (!result.completed) audit.log({ event: "audit.flush_deadline", level: "warn", count: valid.length });
  } catch (error) {
    // Unreachable in practice (the work above does not throw); the action must not fail whatever happens here.
    try { audit.log({ event: "audit.flush_failed", level: "warn", error: error instanceof Error ? error.name : "unknown" }); } catch { /* nothing more can be done */ }
  }
}

/**
 * Staff reads only (fail-closed): the event is made durable first, as a pending item, and only then sent. Throws
 * AUDIT_UNAVAILABLE (503) if the item cannot be put, so the caller reads nothing. A failed send is fine: the pending
 * item is durable and the drain delivers it. An invalid event cannot be made durable, so it also throws.
 */
export async function recordAuditEventDurably(deps: AuditDeps, event: AuditEventInput): Promise<void> {
  const audit = deps.audit;
  if (audit === undefined) return;
  const unavailable = () => agentXError("AUDIT_UNAVAILABLE", AUDIT_ERROR_MESSAGES.AUDIT_UNAVAILABLE);
  const parsed = AuditEventInputSchema.safeParse(event);
  if (!parsed.success) {
    audit.log(describeInvalidAuditEvent(event));
    throw unavailable();
  }
  try {
    await audit.documentClient.send(new PutCommand({ TableName: audit.tableName, Item: auditPendingItem(parsed.data, audit.now()) }));
  } catch (error) {
    audit.log({ event: "audit.durable_put_failed", level: "error", action: parsed.data.action, error: error instanceof Error ? error.name : "unknown" });
    throw unavailable();
  }
  await flushAuditEvents(deps, [parsed.data]);
}

/**
 * Customer-admin reads of the log, the one documented exception to the transactional outbox (a read has no write to
 * join): send; if the send fails or is too slow, put the pending item; if that fails too, log `audit.record_failed`.
 * The send gets AUDIT_SDK_REQUEST_TIMEOUT_MS so that the put still fits in AUDIT_FLUSH_DEADLINE_MS. Never throws.
 */
export async function recordAuditRead(deps: AuditDeps, event: AuditEventInput): Promise<void> {
  const audit = deps.audit;
  if (audit === undefined) return;
  try {
    const parsed = AuditEventInputSchema.safeParse(event);
    if (!parsed.success) {
      audit.log(describeInvalidAuditEvent(event));
      return;
    }
    await within(AUDIT_FLUSH_DEADLINE_MS, async () => {
      const attempt = await within(AUDIT_SDK_REQUEST_TIMEOUT_MS, (signal) => sendAuditEvents(audit, [parsed.data], signal));
      if (attempt.completed && attempt.value.sent.length === 1) return;
      try {
        await audit.documentClient.send(new PutCommand({ TableName: audit.tableName, Item: auditPendingItem(parsed.data, audit.now()) }));
      } catch (error) {
        audit.log({ event: "audit.record_failed", level: "error", reason: "read_not_recorded", error: error instanceof Error ? error.name : "unknown", record: auditEventWithoutDetails(parsed.data) });
      }
    });
  } catch {
    // The read is already served; recording it is best effort.
  }
}
