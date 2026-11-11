// Fakes for the Audit Ledger hook tests (Tasks 17 to 19): what an audited action left behind, and an intake queue that never answers.
//
// `capturingAuditDeps()` builds the `AuditDeps` a broker takes (an `AuditRuntime` with a fake intake queue) and reads back
// two things: the events the queue accepted (`flushed`) and the pending items still waiting in the State table (`pending`).
// The action's own transaction writes the pending item into whatever table the test's DynamoDB fake holds, and the flush deletes it
// from there once the queue accepts the event, so the capture is bound to that fake with `attach` (the developer task broker harness
// does it for the broker's table). `hangingAuditDeps()` is the same with a queue whose calls never resolve, as in an outage that
// makes every request time out: a flush must still return at its deadline and leave the pending item for the drain.
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { AuditEventInputSchema, type AuditAction, type AuditEventInput } from "@agentx/cloud-contracts";
import type { AuditDeps, AuditPendingItem, AuditRuntime } from "../../packages/broker/src/audit/outbox.js";
import { FakeAuditSqs } from "./fake-audit-sqs.js";
import { FakeDynamoDb } from "./fake-dynamodb.js";

export const AUDIT_CAPTURE_QUEUE_URL = "https://sqs.test/agentx-test-audit-intake.fifo";
/** The State table's name in the broker harnesses. FakeDynamoDb keeps one store and ignores table names; the code under test passes this one. */
export const AUDIT_CAPTURE_TABLE = "state";

export interface AuditCaptureOptions {
  /** The fake the pending items live in. Default: a new one, replaceable with `attach`. */
  db?: FakeDynamoDb;
  /** The clock the pending items are stamped with. Default: `Date.now`, which fake timers also move. */
  now?: () => number;
}

export interface AuditCapture {
  /** What a broker takes as `audit`. */
  audit: AuditRuntime;
  /** `{ audit }`, for the outbox functions (`auditPending`, `auditTransact`, `flushAuditEvents`). */
  deps: AuditDeps;
  /** The fake intake queue: `mode`, `calls`, `offered()`, `rejected`. */
  sqs: FakeAuditSqs;
  /** Everything the audit code logged. */
  logs: Array<Record<string, unknown>>;
  /** Points the capture at another DynamoDB fake: pending items are read from it and deleted from it. */
  attach: (db: FakeDynamoDb) => void;
  /** Events the queue accepted, in the order it queued them (a repeat of an event id is not queued twice). */
  flushed: () => AuditEventInput[];
  /** Events of the pending items still in the State table, oldest first. */
  pending: () => AuditEventInput[];
  /** The pending items themselves (attempts, TTL, timestamps). */
  pendingItems: () => AuditPendingItem[];
  /** Flushed events, then pending ones not already flushed: everything the action audited, once each. */
  recorded: () => AuditEventInput[];
  /** `recorded()` for one action. */
  recordedBy: (action: AuditAction) => AuditEventInput[];
  /** The queue refuses every call, as in an outage; the pending items stay. */
  queueDown: () => void;
  /** The queue accepts calls again. */
  queueUp: () => void;
}

function capture(mode: "ok" | "hang", options: AuditCaptureOptions): AuditCapture {
  let db = options.db ?? new FakeDynamoDb();
  const sqs = new FakeAuditSqs();
  sqs.mode = mode;
  const logs: Array<Record<string, unknown>> = [];
  // The runtime's client forwards to whichever fake is attached now, so a broker can be built before its table exists.
  const documentClient = { send: (command: never) => db.send(command) } as unknown as DynamoDBDocumentClient;
  const audit: AuditRuntime = {
    sqs: sqs.client,
    queueUrl: AUDIT_CAPTURE_QUEUE_URL,
    documentClient,
    tableName: AUDIT_CAPTURE_TABLE,
    now: options.now ?? Date.now,
    log: (entry) => logs.push(entry),
  };
  const pendingItems = (): AuditPendingItem[] => (db.find((item) => String(item.pk).startsWith("AUDIT_PENDING#")) as unknown as AuditPendingItem[])
    .sort((left, right) => left.sk.localeCompare(right.sk));
  const flushed = (): AuditEventInput[] => sqs.queue.map((message) => AuditEventInputSchema.parse(JSON.parse(message.body)));
  const pending = (): AuditEventInput[] => pendingItems().map((item) => item.event);
  const recorded = (): AuditEventInput[] => {
    const queued = flushed();
    const seen = new Set(queued.map((event) => event.eventId));
    return [...queued, ...pending().filter((event) => !seen.has(event.eventId))];
  };
  return {
    audit,
    deps: { audit },
    sqs,
    logs,
    attach: (next) => { db = next; },
    flushed,
    pending,
    pendingItems,
    recorded,
    recordedBy: (action) => recorded().filter((event) => event.action === action),
    queueDown: () => { sqs.mode = "throw"; },
    queueUp: () => { sqs.mode = "ok"; },
  };
}

/** A queue that accepts events, so a test can see what was flushed and what stayed pending. */
export function capturingAuditDeps(options: AuditCaptureOptions = {}): AuditCapture {
  return capture("ok", options);
}

/** A queue whose calls never resolve (`queueUp` makes it answer). */
export function hangingAuditDeps(options: AuditCaptureOptions = {}): AuditCapture {
  return capture("hang", options);
}
