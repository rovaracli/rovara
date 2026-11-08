// The audit outbox (ruling R70). An audited action adds one AUDIT_PENDING item to its own DynamoDB transaction, so the
// action and its pending audit item commit together or not at all. Delivery to the intake queue is a separate,
// asynchronous step (flush.ts after the commit, drain.ts every minute) that can never fail or delay the action.
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { SQSClient } from "@aws-sdk/client-sqs";
import {
  DeleteCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import {
  AUDIT_ACTIONS,
  AUDIT_FACT_KEYS,
  AUDIT_PENDING_SHARDS,
  AUDIT_PENDING_TTL_DAYS,
  AuditEventIdSchema,
  AuditEventInputSchema,
  INDEX_EXPIRY_ATTRIBUTE,
  OrgIdSchema,
  type AuditEventInput,
} from "@agentx/contracts";

/** What the audit functions need at runtime. Both clients are made with `requestTimeout: AUDIT_SDK_REQUEST_TIMEOUT_MS` and `maxAttempts: 2`. */
export interface AuditRuntime {
  sqs: SQSClient;
  queueUrl: string;
  /** Writes pending items only; the action's own writes go through the caller's client. */
  documentClient: DynamoDBDocumentClient;
  /** The State table. */
  tableName: string;
  now: () => number;
  log: (entry: Record<string, unknown>) => void;
  /**
   * Lessons in production (lane 2, M6): the LessonsWorker has no right to the audit intake queue. With this set, an event is written as a pending item and never sent from this process: the broker's drain delivers it
   * (the same path as an event whose send failed). `sqs` is then never used.
   */
  pendingOnly?: true;
}

/** Embedded in a broker's dependencies. Absent on a legacy install: every audit function is then a no-op. */
export interface AuditDeps {
  audit?: AuditRuntime;
}

export type TransactItem = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];

/** The pending item, as stored in the State table. `failedLoggedAt` is added by the drain. */
export interface AuditPendingItem {
  pk: string;
  sk: string;
  event: AuditEventInput;
  attempts: number;
  createdAt: string;
  [INDEX_EXPIRY_ATTRIBUTE]: number;
  failedLoggedAt?: string;
}

export function auditPendingPartition(shard: number): string {
  return `AUDIT_PENDING#${String(shard)}`;
}

/** The shard of an event id: its first byte, modulo the shard count. Spreads one org's events over every shard. */
export function auditPendingShard(eventId: string): number {
  return parseInt(eventId.slice(4, 6), 16) % AUDIT_PENDING_SHARDS;
}

/**
 * `AUDIT_PENDING#<shard>` and `<occurredAt>#<orgId>#<eventId>`. The time is written with a fixed width (milliseconds, UTC)
 * so that sort order is time order. A site that retries one occurrence must pass the same `occurredAt`, or the retry
 * writes a second pending item for the same event (the appender's event claim removes that duplicate).
 */
export function auditPendingKey(event: Pick<AuditEventInput, "eventId" | "orgId" | "occurredAt">): { pk: string; sk: string } {
  return { pk: auditPendingPartition(auditPendingShard(event.eventId)), sk: `${new Date(event.occurredAt).toISOString()}#${event.orgId}#${event.eventId}` };
}

export function auditPendingItem(event: AuditEventInput, nowMs: number): AuditPendingItem {
  return {
    ...auditPendingKey(event),
    event,
    attempts: 0,
    createdAt: new Date(nowMs).toISOString(),
    [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(nowMs / 1000) + AUDIT_PENDING_TTL_DAYS * 86_400,
  };
}

/** Path segments that name a schema field or a fact key: the only strings an invalid-event log may repeat. Anything else is "*". */
const SAFE_PATH_SEGMENTS = new Set<string>([
  "eventId", "orgId", "action", "actor", "target", "occurredAt", "related", "facts", "proof", "details",
  "kind", "id", "name", "method", "authTime", "sessionRef", "via", "subject", "fields",
  ...Object.values(AUDIT_FACT_KEYS).flat(),
]);

/**
 * What a log may say about an event that failed validation: where it was wrong and the zod code, never a value. A path
 * segment that is a key of a record (a fact key, a field name) is shown only if it is a known name, because an invalid
 * event's keys can be anything the caller passed.
 */
export function describeInvalidAuditEvent(event: unknown): Record<string, unknown> {
  const parsed = AuditEventInputSchema.safeParse(event);
  const fields = event !== null && typeof event === "object" ? event as Record<string, unknown> : {};
  const known = <T>(schema: { safeParse: (value: unknown) => { success: boolean; data?: T } }, value: unknown): T | undefined => {
    const result = schema.safeParse(value);
    return result.success ? result.data : undefined;
  };
  const action = typeof fields.action === "string" && (AUDIT_ACTIONS as readonly string[]).includes(fields.action) ? fields.action : undefined;
  const eventId = known(AuditEventIdSchema, fields.eventId);
  const orgId = known(OrgIdSchema, fields.orgId);
  return {
    event: "audit.record_invalid",
    level: "error",
    ...(action === undefined ? {} : { action }),
    ...(eventId === undefined ? {} : { eventId }),
    ...(orgId === undefined ? {} : { orgId }),
    issues: parsed.success ? [] : parsed.error.issues.map((issue) => ({
      path: issue.path.map((segment) => typeof segment === "number" ? segment : SAFE_PATH_SEGMENTS.has(String(segment)) ? String(segment) : "*"),
      code: issue.code,
    })),
  };
}

/** An event as a failure log may show it: no personal data. */
export type LogSafeAuditEvent = Omit<AuditEventInput, "details" | "target"> & { target: { kind: string; id: string } | { kind: string } };

/**
 * The event as a failure log may carry it. Logs cannot be erased or shredded, so the event keeps only its ids, action,
 * times, facts (non-personal by the per-action allowlist) and proof. `details` is dropped, and a name-keyed target
 * (a repository, project or domain name, which the appender pseudonymizes) becomes `{ kind }`.
 */
export function auditEventWithoutDetails(event: AuditEventInput): LogSafeAuditEvent {
  const { details: _details, target, ...rest } = event;
  void _details;
  return { ...rest, target: "id" in target ? { kind: target.kind, id: target.id } : { kind: target.kind } };
}

/**
 * The pending item to put in the action's transaction: `[]` when there is no ledger (a legacy install) or the event is
 * invalid (logged as `audit.record_invalid`, without any value), so a bad event never blocks the action. The put is
 * unconditional on purpose (R1-1): a site that re-runs its write for the same occurrence while the earlier pending item
 * still exists overwrites an identical item, and a condition here could fail the audited action during an SQS outage.
 */
export function auditPending(deps: AuditDeps, event: AuditEventInput): TransactItem[] {
  const audit = deps.audit;
  if (audit === undefined) return [];
  const parsed = AuditEventInputSchema.safeParse(event);
  if (!parsed.success) {
    audit.log(describeInvalidAuditEvent(event));
    return [];
  }
  return [{ Put: { TableName: audit.tableName, Item: auditPendingItem(parsed.data, audit.now()) } }];
}

/**
 * Events for a hook site, built where a failure must not reach the action: `[]` on an install with no ledger (nothing is
 * built or looked up), and `[]` with an `audit.record_invalid` log (the error's name only, never its message, which could
 * quote a value) when the builder or a lookup it needs throws. The action then goes on without an event, as it does for an
 * event that fails validation (`auditPending`).
 */
export async function tryAuditEvents(deps: AuditDeps, build: () => AuditEventInput[] | Promise<AuditEventInput[]>): Promise<AuditEventInput[]> {
  const audit = deps.audit;
  if (audit === undefined) return [];
  try {
    return await build();
  } catch (error) {
    try { audit.log({ event: "audit.record_invalid", level: "error", reason: "builder_failed", error: error instanceof Error ? error.name : "unknown" }); } catch { /* nothing more can be done */ }
    return [];
  }
}

/** `tryAuditEvents` for a site with one event. */
export async function tryAuditEvent(deps: AuditDeps, build: () => AuditEventInput | Promise<AuditEventInput>): Promise<AuditEventInput | undefined> {
  return (await tryAuditEvents(deps, async () => [await build()]))[0];
}

export type AuditWrite =
  | { Put: NonNullable<TransactItem["Put"]> }
  | { Update: NonNullable<TransactItem["Update"]> }
  | { Delete: NonNullable<TransactItem["Delete"]> };

/** Whether a TransactionCanceledException says the first item's condition failed. */
function firstConditionFailed(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== "TransactionCanceledException") return false;
  const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons;
  return reasons?.[0]?.Code === "ConditionalCheckFailed";
}

/**
 * A single write (PutItem, UpdateItem or DeleteItem) that becomes one transaction of the write and its pending items,
 * so the action and its audit item commit together. `client` is the caller's own client (the action must not inherit
 * the audit client's short timeouts). A failed condition on the action's item is rethrown as the
 * `ConditionalCheckFailedException` the single write would have raised, so callers' handling is unchanged; other
 * cancellation reasons are rethrown as they are. With no ledger, or no valid event, the write is made alone.
 */
export async function auditTransact(
  deps: AuditDeps & { documentClient: { send(command: unknown): Promise<unknown> } },
  write: AuditWrite,
  events: AuditEventInput[],
): Promise<void> {
  const seen = new Set<string>();
  const pending = events.filter((event) => !seen.has(event.eventId) && seen.add(event.eventId)).flatMap((event) => auditPending(deps, event));
  if (pending.length === 0) {
    if ("Put" in write) await deps.documentClient.send(new PutCommand(write.Put));
    else if ("Update" in write) await deps.documentClient.send(new UpdateCommand(write.Update));
    else await deps.documentClient.send(new DeleteCommand(write.Delete));
    return;
  }
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [write, ...pending] }));
  } catch (error) {
    if (firstConditionFailed(error)) {
      throw new ConditionalCheckFailedException({ message: "The conditional request failed", $metadata: (error as { $metadata?: Record<string, unknown> }).$metadata ?? {} });
    }
    throw error;
  }
}
