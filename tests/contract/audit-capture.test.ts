// tests/contract/audit-capture.test.ts
// Task 16 of the Audit Ledger plan: the fakes the hook tests (Tasks 17 to 19) use to see what an action audited.
// `capturingAuditDeps` records the events the intake queue accepted and the pending items still waiting; `hangingAuditDeps`
// is the same with a queue that never answers. The developer task broker harness takes either.
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AUDIT_FLUSH_DEADLINE_MS, AuditEventInputSchema, type AuditEventInput } from "@agentx/cloud-contracts";
import { auditBudgetChanged, auditPullRequestOpened } from "../../packages/broker/src/audit/events.js";
import { flushAuditEvents } from "../../packages/broker/src/audit/flush.js";
import { auditPending } from "../../packages/broker/src/audit/outbox.js";
import { capturingAuditDeps, hangingAuditDeps, type AuditCapture } from "../support/audit-capture.js";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { loadSlackBroker } from "../support/slack-broker.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa";

afterEach(() => vi.useRealTimers());

function pullRequest(occurrence: string): AuditEventInput {
  return auditPullRequestOpened({ orgId: ORG, actor: { kind: "member", id: "dev_1" }, occurredAt: "2026-10-20T11:59:00.000Z", occurrence, pullRequestId: "pr_1", number: 7 });
}

function budget(): AuditEventInput {
  return auditBudgetChanged({ orgId: ORG, actor: { kind: "member", id: "dev_1" }, occurredAt: "2026-10-20T11:59:00.000Z", occurrence: "b-1", target: { kind: "org", id: ORG }, scopeKind: "org", field: "monthlyBudget", fromCents: 50000, toCents: 80000 });
}

/** A hooked site: the action's own item and the pending items, in one transaction on the capture's table. */
async function commitAction(capture: AuditCapture, db: FakeDynamoDb, ...events: AuditEventInput[]): Promise<void> {
  await db.send(new TransactWriteCommand({
    TransactItems: [{ Put: { TableName: "state", Item: { pk: "ACTION#1", sk: "META", done: true } } }, ...events.flatMap((event) => auditPending(capture.deps, event))],
  }));
}

describe("capturingAuditDeps", () => {
  it("shows an event as pending after its action commits, and as flushed once the queue has accepted it", async () => {
    const db = new FakeDynamoDb();
    const capture = capturingAuditDeps({ db });
    const event = pullRequest("op-1");
    await commitAction(capture, db, event);
    expect(capture.pending()).toStrictEqual([event]);
    expect(capture.flushed()).toStrictEqual([]);
    expect(capture.recorded()).toStrictEqual([event]);

    await flushAuditEvents(capture.deps, [event]);
    expect(capture.flushed()).toStrictEqual([event]);
    expect(capture.pending()).toStrictEqual([]);
    expect(capture.recorded()).toStrictEqual([event]);
    expect(AuditEventInputSchema.safeParse(capture.flushed()[0]).success).toBe(true);
  });

  it("counts an event once when it is both queued and still pending, and when it is flushed twice", async () => {
    const db = new FakeDynamoDb();
    const capture = capturingAuditDeps({ db });
    const event = pullRequest("op-1");
    await commitAction(capture, db, event);
    // Accepted by the queue, but the pending item's delete failed: the event is in both places.
    db.injectFault({ command: "DeleteCommand", error: { name: "InternalServerError" } });
    await flushAuditEvents(capture.deps, [event]);
    expect(capture.pending()).toStrictEqual([event]);
    expect(capture.flushed()).toStrictEqual([event]);
    expect(capture.recorded()).toStrictEqual([event]);
    expect(capture.logs).toContainEqual(expect.objectContaining({ event: "audit.pending_delete_failed" }));
    // The drain or a repeat flush sends it again; the queue deduplicates on the event id.
    await flushAuditEvents(capture.deps, [event]);
    expect(capture.flushed()).toStrictEqual([event]);
    expect(capture.pending()).toStrictEqual([]);
  });

  it("keeps events in the order they were queued, and picks them by action", async () => {
    const db = new FakeDynamoDb();
    const capture = capturingAuditDeps({ db });
    const opened = pullRequest("op-1");
    const changed = budget();
    await commitAction(capture, db, opened, changed);
    await flushAuditEvents(capture.deps, [changed, opened]);
    expect(capture.flushed()).toStrictEqual([changed, opened]);
    expect(capture.recordedBy("budget.changed")).toStrictEqual([changed]);
    expect(capture.recordedBy("pull_request.merged")).toStrictEqual([]);
  });

  it("leaves the pending items in place while the queue is down, and delivers them when it is back", async () => {
    const db = new FakeDynamoDb();
    const capture = capturingAuditDeps({ db });
    const event = pullRequest("op-1");
    capture.queueDown();
    await commitAction(capture, db, event);
    await flushAuditEvents(capture.deps, [event]);
    expect(capture.flushed()).toStrictEqual([]);
    expect(capture.pending()).toStrictEqual([event]);
    expect(capture.pendingItems()).toHaveLength(1);
    capture.queueUp();
    await flushAuditEvents(capture.deps, [event]);
    expect(capture.flushed()).toStrictEqual([event]);
    expect(capture.pending()).toStrictEqual([]);
  });

  it("collects what the audit code logs", async () => {
    const capture = capturingAuditDeps();
    expect(auditPending(capture.deps, { ...pullRequest("op-1"), orgId: "nope" })).toStrictEqual([]);
    expect(capture.logs).toMatchObject([{ event: "audit.record_invalid" }]);
  });

  it("reads and deletes through whichever table it is attached to", async () => {
    const own = new FakeDynamoDb();
    const other = new FakeDynamoDb();
    const capture = capturingAuditDeps({ db: own });
    const event = pullRequest("op-1");
    capture.attach(other);
    await commitAction(capture, other, event);
    expect(capture.pending()).toStrictEqual([event]);
    expect(own.find((item) => String(item.pk).startsWith("AUDIT_PENDING#"))).toStrictEqual([]);
    await flushAuditEvents(capture.deps, [event]);
    expect(other.find((item) => String(item.pk).startsWith("AUDIT_PENDING#"))).toStrictEqual([]);
  });

  it("has a table of its own when none is given, and refuses nothing about the table name the broker uses", async () => {
    const capture = capturingAuditDeps();
    expect(capture.audit.tableName).toBe("state");
    expect(capture.pending()).toStrictEqual([]);
  });
});

describe("hangingAuditDeps", () => {
  it("never answers the queue: a flush returns when the deadline passes, logs it, and leaves the pending item", async () => {
    vi.useFakeTimers();
    const db = new FakeDynamoDb();
    const capture = hangingAuditDeps({ db });
    const event = pullRequest("op-1");
    await commitAction(capture, db, event);
    let returned = false;
    const flushing = flushAuditEvents(capture.deps, [event]).then(() => { returned = true; });
    await vi.advanceTimersByTimeAsync(AUDIT_FLUSH_DEADLINE_MS - 1);
    expect(returned).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await flushing;
    expect(returned).toBe(true);
    expect(capture.sqs.offered()).toBe(1);
    expect(capture.flushed()).toStrictEqual([]);
    expect(capture.pending()).toStrictEqual([event]);
    expect(capture.logs).toContainEqual(expect.objectContaining({ event: "audit.flush_deadline", count: 1 }));
  });

  it("does not hold an action's own commit: the transaction succeeds before any flush", async () => {
    const db = new FakeDynamoDb();
    const capture = hangingAuditDeps({ db });
    await commitAction(capture, db, pullRequest("op-1"));
    expect(db.get("ACTION#1", "META")).toMatchObject({ done: true });
    expect(capture.sqs.offered()).toBe(0);
  });
});

describe("the developer task broker harness", () => {
  beforeAll(loadSlackBroker);

  it("gives the broker the capture's audit deps and attaches the capture to the broker's table", async () => {
    const capture = capturingAuditDeps();
    const b = await createDeveloperTaskBroker({ audit: capture });
    expect((b.brokerInput as { audit?: unknown }).audit).toBe(capture.audit);
    const event = budget();
    await commitAction(capture, b.db, event);
    expect(capture.pending()).toStrictEqual([event]);
    await flushAuditEvents(capture.deps, [event]);
    expect(capture.flushed()).toStrictEqual([event]);
    expect(b.db.find((item) => String(item.pk).startsWith("AUDIT_PENDING#"))).toStrictEqual([]);
    // The broker still works with it.
    expect((await b.dev(MAYA, "GET", "/v1/dev/tasks")).status).toBeLessThan(500);
  });

  it("takes hanging deps the same way", async () => {
    const capture = hangingAuditDeps();
    const b = await createDeveloperTaskBroker({ audit: capture });
    expect((b.brokerInput as { audit?: unknown }).audit).toBe(capture.audit);
    expect(capture.sqs.mode).toBe("hang");
  });

  it("has no audit deps unless asked, as a legacy install", async () => {
    const b = await createDeveloperTaskBroker();
    expect((b.brokerInput as { audit?: unknown }).audit).toBeUndefined();
  });
});
