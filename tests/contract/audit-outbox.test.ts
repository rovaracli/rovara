// tests/contract/audit-outbox.test.ts
// Task 6 of the Audit Ledger plan: the transactional outbox (ruling R70), the bounded flush, the drain and the event
// builders. DynamoDB is FakeDynamoDb and the intake queue is FakeAuditSqs; the fake DynamoDB does not enforce IAM, so
// what each function is allowed to do is pinned in audit-ledger-infrastructure.test.ts.
import { TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUDIT_FLUSH_DEADLINE_MS,
  AUDIT_PENDING_SHARDS,
  AUDIT_PENDING_TTL_DAYS,
  AuditEventInputSchema,
  auditOperatorId,
  INDEX_EXPIRY_ATTRIBUTE,
  type AuditEventInput,
} from "@agentx/contracts";
import { AUDIT_DRAIN_PAGE_SIZE, drainAuditPending, runAuditDrain } from "../../packages/broker/src/audit/drain.js";
import * as builders from "../../packages/broker/src/audit/events.js";
import { auditOccurrence } from "../../packages/broker/src/audit/events.js";
import { flushAuditEvents, recordAuditEventDurably, recordAuditRead } from "../../packages/broker/src/audit/flush.js";
import {
  auditPending,
  auditPendingItem,
  auditPendingKey,
  auditEventWithoutDetails,
  auditPendingShard,
  auditTransact,
  type AuditDeps,
  type AuditPendingItem,
} from "../../packages/broker/src/audit/outbox.js";
import { FakeAuditSqs } from "../support/fake-audit-sqs.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa";
const OTHER_ORG = "org_bbbbbbbbbbbbbbbbbbbb";
const START = Date.parse("2026-10-20T12:00:00.000Z");
const DAY = 86_400_000;

afterEach(() => vi.useRealTimers());

function harness() {
  const db = new FakeDynamoDb();
  const sqs = new FakeAuditSqs();
  const logs: Array<Record<string, unknown>> = [];
  const clock = { now: START };
  const documentClient = { send: db.send } as unknown as DynamoDBDocumentClient;
  const deps: AuditDeps = {
    audit: { sqs: sqs.client, queueUrl: "https://sqs.test/agentx-test-audit-intake.fifo", documentClient, tableName: "state", now: () => clock.now, log: (entry) => logs.push(entry) },
  };
  return { db, sqs, logs, clock, deps, documentClient };
}
type Harness = ReturnType<typeof harness>;

const pendingItems = (db: FakeDynamoDb): AuditPendingItem[] => db.find((item) => String(item.pk).startsWith("AUDIT_PENDING#")) as unknown as AuditPendingItem[];

function pullRequest(occurrence: string, overrides: { occurredAt?: string; orgId?: string; details?: AuditEventInput["details"] } = {}): AuditEventInput {
  return builders.auditPullRequestOpened({
    orgId: overrides.orgId ?? ORG,
    actor: { kind: "member", id: "dev_1" },
    occurredAt: overrides.occurredAt ?? "2026-10-20T11:59:00.000Z",
    occurrence,
    pullRequestId: "pr_1",
    number: 7,
    ...(overrides.details === undefined ? {} : { details: overrides.details }),
  });
}

/** An event whose id lands in `shard`: ids are hashes, so this tries occurrences until one fits. */
function eventInShard(shard: number, serial: number, overrides: { occurredAt?: string } = {}): AuditEventInput {
  for (let attempt = 0; ; attempt += 1) {
    const event = pullRequest(`shard-${String(shard)}-${String(serial)}-${String(attempt)}`, overrides);
    if (auditPendingShard(event.eventId) === shard) return event;
  }
}

/** A hooked site: the action's own item and the pending item, in one transaction. */
async function commitAction(h: Harness, event: AuditEventInput, key = "ACTION#1"): Promise<void> {
  await h.documentClient.send(new TransactWriteCommand({
    TransactItems: [{ Put: { TableName: "state", Item: { pk: key, sk: "META", done: true } } }, ...auditPending(h.deps, event)],
  }));
}

it("delivers the M47 system policy seed through the transactional outbox without changing its facts", async () => {
  const h = harness();
  const event = builders.auditTaskStopPolicySeeded({ orgId: ORG, actor: { kind: "system", id: "rovara" }, occurredAt: "2026-10-20T11:59:00.000Z",
    occurrence: "bootstrap-v1", source: "bootstrap", mode: "rovara_estimate", revision: 1, ceilingMicrousd: 100_000_000 });
  await commitAction(h, event, "TASK_STOP_SEED#1");
  expect(pendingItems(h.db).map(item => item.event)).toEqual([event]);
  await flushAuditEvents(h.deps, [event]);
  expect(pendingItems(h.db)).toEqual([]);
  expect(h.sqs.queue.map(message => AuditEventInputSchema.parse(JSON.parse(message.body)))).toEqual([event]);
  expect(event).toMatchObject({ actor: { kind: "system", id: "rovara" }, action: "spending.policy_seeded",
    facts: { source: "bootstrap", mode: "rovara_estimate", revision: 1, ceilingMicrousd: 100_000_000 } });
});

describe("the pending item", () => {
  it("is one unconditional Put of the plan's shape, in the shard of the event id", () => {
    const h = harness();
    const event = pullRequest("op-1");
    const items = auditPending(h.deps, event);
    expect(items).toHaveLength(1);
    const put = items[0]!.Put!;
    expect(put.ConditionExpression).toBeUndefined();
    expect(put.TableName).toBe("state");
    const shard = parseInt(event.eventId.slice(4, 6), 16) % AUDIT_PENDING_SHARDS;
    expect(put.Item).toStrictEqual({
      pk: `AUDIT_PENDING#${String(shard)}`,
      sk: `2026-10-20T11:59:00.000Z#${ORG}#${event.eventId}`,
      event,
      attempts: 0,
      createdAt: "2026-10-20T12:00:00.000Z",
      [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(START / 1000) + AUDIT_PENDING_TTL_DAYS * 86_400,
    });
  });

  it("writes the time at a fixed width, so that sort order is time order", () => {
    expect(auditPendingKey({ eventId: pullRequest("a").eventId, orgId: ORG, occurredAt: "2026-10-20T12:00:00Z" }).sk).toMatch(/^2026-10-20T12:00:00\.000Z#/);
  });

  it("spreads one org's events over the shards", () => {
    const shards = new Set(Array.from({ length: 60 }, (_, index) => auditPendingShard(pullRequest(`spread-${String(index)}`).eventId)));
    expect(shards.size).toBeGreaterThan(5);
    for (const shard of shards) expect(shard).toBeLessThan(AUDIT_PENDING_SHARDS);
  });

  it("is nothing on a legacy install: no item, no send, no query, no error", async () => {
    const h = harness();
    const none: AuditDeps = {};
    const event = pullRequest("legacy");
    expect(auditPending(none, event)).toStrictEqual([]);
    await flushAuditEvents(none, [event]);
    await recordAuditEventDurably(none, event);
    await recordAuditRead(none, event);
    expect(await drainAuditPending(none, START)).toStrictEqual({ examined: 0, sent: 0, failed: 0, stuck: 0, expiring: 0 });
    expect(h.sqs.calls).toHaveLength(0);
    expect(h.db.commandNames()).toHaveLength(0);
  });
});

describe("Review Focus 2 (R70): the action and its pending item commit together", () => {
  it("a hooked transaction commits the action and its pending item together", async () => {
    const h = harness();
    const event = pullRequest("op-1");
    await commitAction(h, event);
    expect(h.db.get("ACTION#1", "META")).toBeDefined();
    expect(pendingItems(h.db).map((item) => item.event.eventId)).toStrictEqual([event.eventId]);
    expect(h.db.commandNames()).toStrictEqual(["TransactWriteCommand"]);
  });

  it("with the flush never called (a simulated crash), the drain sends it once and deletes it", async () => {
    const h = harness();
    const event = pullRequest("op-1");
    await commitAction(h, event);
    const result = await drainAuditPending(h.deps, START + 31_000);
    expect(result).toMatchObject({ examined: 1, sent: 1, failed: 0 });
    expect(h.sqs.queue).toHaveLength(1);
    expect(h.sqs.queue[0]).toMatchObject({ groupId: ORG, dedupId: event.eventId });
    expect(JSON.parse(h.sqs.queue[0]!.body)).toStrictEqual(event);
    expect(pendingItems(h.db)).toHaveLength(0);
    // A second drain finds nothing to send.
    await drainAuditPending(h.deps, START + 92_000);
    expect(h.sqs.offered()).toBe(1);
  });

  it("with the flush succeeding, the drain sends nothing", async () => {
    const h = harness();
    const event = pullRequest("op-1");
    await commitAction(h, event);
    await flushAuditEvents(h.deps, [event]);
    expect(h.sqs.queue).toHaveLength(1);
    expect(pendingItems(h.db)).toHaveLength(0);
    const result = await drainAuditPending(h.deps, START + 31_000);
    expect(result.examined).toBe(0);
    expect(h.sqs.offered()).toBe(1);
  });

  it("leaves the pending item alone for the first 30 seconds, which belong to the flush", async () => {
    const h = harness();
    await commitAction(h, pullRequest("op-1", { occurredAt: new Date(START).toISOString() }));
    expect(await drainAuditPending(h.deps, START + 29_000)).toMatchObject({ examined: 0 });
    expect(await drainAuditPending(h.deps, START + 31_000)).toMatchObject({ examined: 1, sent: 1 });
  });

  it("a failed condition on the action's item commits neither the action nor a pending item", async () => {
    const h = harness();
    h.db.set({ pk: "ACTION#1", sk: "META", revision: 1 });
    const event = pullRequest("op-1");
    await expect(auditTransact({ ...h.deps, documentClient: h.documentClient }, {
      Put: { TableName: "state", Item: { pk: "ACTION#1", sk: "META", revision: 2 }, ConditionExpression: "attribute_not_exists(pk)" },
    }, [event])).rejects.toMatchObject({ name: "ConditionalCheckFailedException" });
    expect(h.db.get("ACTION#1", "META")).toStrictEqual({ pk: "ACTION#1", sk: "META", revision: 1 });
    expect(pendingItems(h.db)).toHaveLength(0);
  });
});

describe("crash points: no event is lost and none is recorded twice", () => {
  it("crash before the commit: neither the action nor an event exists", async () => {
    const h = harness();
    h.db.injectFault({ command: "TransactWriteCommand", error: { name: "InternalServerError" } });
    await expect(commitAction(h, pullRequest("op-1"))).rejects.toThrow();
    expect(h.db.get("ACTION#1", "META")).toBeUndefined();
    expect(pendingItems(h.db)).toHaveLength(0);
    await drainAuditPending(h.deps, START + 31_000);
    expect(h.sqs.offered()).toBe(0);
  });

  it("the queue accepted the event and the delete failed: the drain resends it and the queue holds it once", async () => {
    const h = harness();
    const event = pullRequest("op-1");
    await commitAction(h, event);
    h.db.injectFault({ command: "DeleteCommand", error: { name: "InternalServerError" } });
    await flushAuditEvents(h.deps, [event]);
    expect(pendingItems(h.db)).toHaveLength(1);
    expect(h.logs.map((entry) => entry.event)).toContain("audit.pending_delete_failed");
    await drainAuditPending(h.deps, START + 31_000);
    expect(h.sqs.offered()).toBe(2);
    expect(h.sqs.queue).toHaveLength(1);
    expect(pendingItems(h.db)).toHaveLength(0);
  });

  it("the queue is down: the event stays pending, is counted, and goes out once the queue is back", async () => {
    const h = harness();
    const event = pullRequest("op-1");
    await commitAction(h, event);
    h.sqs.mode = "throw";
    await flushAuditEvents(h.deps, [event]);
    expect(pendingItems(h.db)).toHaveLength(1);
    await drainAuditPending(h.deps, START + 31_000);
    await drainAuditPending(h.deps, START + 92_000);
    expect(pendingItems(h.db)[0]!.attempts).toBe(2);
    h.sqs.mode = "ok";
    await drainAuditPending(h.deps, START + 153_000);
    expect(h.sqs.queue).toHaveLength(1);
    expect(pendingItems(h.db)).toHaveLength(0);
  });

  it("a send that fails for some entries keeps only those pending", async () => {
    const h = harness();
    const events = [pullRequest("a"), pullRequest("b"), pullRequest("c")];
    h.db.set({ pk: "x", sk: "y" });
    await h.documentClient.send(new TransactWriteCommand({ TransactItems: events.flatMap((event) => auditPending(h.deps, event)) }));
    h.sqs.rejected.add(events[1]!.eventId);
    await flushAuditEvents(h.deps, events);
    expect(pendingItems(h.db).map((item) => item.event.eventId)).toStrictEqual([events[1]!.eventId]);
    h.sqs.rejected.clear();
    await drainAuditPending(h.deps, START + 31_000);
    expect(h.sqs.queue.map((message) => message.dedupId).sort()).toStrictEqual(events.map((event) => event.eventId).sort());
    expect(pendingItems(h.db)).toHaveLength(0);
  });

  it("an attempt count never recreates an item the flush has just deleted", async () => {
    const h = harness();
    const event = pullRequest("op-1");
    await commitAction(h, event);
    h.sqs.mode = "throw";
    h.sqs.onCall = () => h.db.delete(auditPendingKey(event));
    await drainAuditPending(h.deps, START + 31_000);
    expect(pendingItems(h.db)).toHaveLength(0);
  });
});

describe("I5: the flush never blocks", () => {
  it("returns within the deadline when the queue never answers, and the pending item remains", async () => {
    vi.useFakeTimers();
    const h = harness();
    const event = pullRequest("op-1");
    await commitAction(h, event);
    h.sqs.mode = "hang";
    let finished = false;
    const startedAt = Date.now();
    const flushed = flushAuditEvents(h.deps, [event]).then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(AUDIT_FLUSH_DEADLINE_MS - 1);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await flushed;
    expect(finished).toBe(true);
    expect(Date.now() - startedAt).toBeLessThanOrEqual(AUDIT_FLUSH_DEADLINE_MS);
    expect(pendingItems(h.db)).toHaveLength(1);
    expect(h.logs.map((entry) => entry.event)).toContain("audit.flush_deadline");
  });

  it("makes three SendMessageBatch calls for 25 events, ten at a time, in order", async () => {
    const h = harness();
    const events = Array.from({ length: 25 }, (_, index) => pullRequest(`bulk-${String(index)}`));
    await h.documentClient.send(new TransactWriteCommand({ TransactItems: events.flatMap((event) => auditPending(h.deps, event)) }));
    await flushAuditEvents(h.deps, events);
    expect(h.sqs.calls.map((call) => call.length)).toStrictEqual([10, 10, 5]);
    expect(h.sqs.calls.flat().map((entry) => entry.MessageDeduplicationId)).toStrictEqual(events.map((event) => event.eventId));
    expect(h.sqs.calls.flat().every((entry) => entry.MessageGroupId === ORG)).toBe(true);
    expect(pendingItems(h.db)).toHaveLength(0);
  });

  it("uses the org as the message group and the event id for deduplication", async () => {
    const h = harness();
    const events = [pullRequest("one"), pullRequest("two", { orgId: OTHER_ORG })];
    await h.documentClient.send(new TransactWriteCommand({ TransactItems: events.flatMap((event) => auditPending(h.deps, event)) }));
    await flushAuditEvents(h.deps, events);
    expect(h.sqs.queue.map((message) => [message.groupId, message.dedupId])).toStrictEqual(events.map((event) => [event.orgId, event.eventId]));
  });

  it("never throws, whatever fails", async () => {
    const h = harness();
    const event = pullRequest("op-1");
    h.sqs.mode = "throw";
    await expect(flushAuditEvents(h.deps, [event])).resolves.toBeUndefined();
    h.sqs.mode = "ok";
    h.db.injectFault({ command: "DeleteCommand", error: { name: "InternalServerError" } });
    await expect(flushAuditEvents(h.deps, [event])).resolves.toBeUndefined();
    await expect(flushAuditEvents(h.deps, [{ ...event, eventId: "nope" }])).resolves.toBeUndefined();
  });
});

describe("auditTransact", () => {
  it("maps a failed condition on the action's item to ConditionalCheckFailedException", async () => {
    const h = harness();
    h.db.set({ pk: "BUDGET#1", sk: "META", version: 1 });
    let caught: unknown;
    try {
      await auditTransact({ ...h.deps, documentClient: h.documentClient }, {
        Update: {
          TableName: "state",
          Key: { pk: "BUDGET#1", sk: "META" },
          UpdateExpression: "SET version = :next",
          ConditionExpression: "version = :expected",
          ExpressionAttributeValues: { ":next": 3, ":expected": 2 },
        },
      }, [pullRequest("op-1")]);
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe("ConditionalCheckFailedException");
    expect(h.db.get("BUDGET#1", "META")).toStrictEqual({ pk: "BUDGET#1", sk: "META", version: 1 });
    expect(pendingItems(h.db)).toHaveLength(0);
  });

  it("commits the write and the pending items in one transaction, once per event id", async () => {
    const h = harness();
    const event = pullRequest("op-1");
    const other = pullRequest("op-2");
    await auditTransact({ ...h.deps, documentClient: h.documentClient }, { Put: { TableName: "state", Item: { pk: "BUDGET#1", sk: "META", version: 1 } } }, [event, other, event]);
    expect(h.db.commandNames()).toStrictEqual(["TransactWriteCommand"]);
    expect(h.db.get("BUDGET#1", "META")).toBeDefined();
    expect(pendingItems(h.db).map((item) => item.event.eventId).sort()).toStrictEqual([event.eventId, other.eventId].sort());
  });

  it("overwrites a pending item that already exists for the event id, and the transaction succeeds (R1-1)", async () => {
    const h = harness();
    const event = pullRequest("op-1");
    h.db.set({ ...auditPendingItem(event, START - 5000), attempts: 4 });
    await auditTransact({ ...h.deps, documentClient: h.documentClient }, { Put: { TableName: "state", Item: { pk: "BUDGET#1", sk: "META", version: 1 } } }, [event]);
    const items = pendingItems(h.db);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ attempts: 0, createdAt: new Date(START).toISOString() });
  });

  it("rethrows any other cancellation as it is", async () => {
    const h = harness();
    h.db.injectFault({ command: "TransactWriteCommand", error: { name: "TransactionCanceledException", cancellationReasons: [{ Code: "TransactionConflict" }, { Code: "None" }] } });
    await expect(auditTransact({ ...h.deps, documentClient: h.documentClient }, { Put: { TableName: "state", Item: { pk: "A", sk: "B" } } }, [pullRequest("op-1")]))
      .rejects.toMatchObject({ name: "TransactionCanceledException" });
  });

  it("does not map a failed condition that is not the first item's", async () => {
    const h = harness();
    h.db.injectFault({ command: "TransactWriteCommand", error: { name: "TransactionCanceledException", cancellationReasons: [{ Code: "None" }, { Code: "ConditionalCheckFailed" }] } });
    await expect(auditTransact({ ...h.deps, documentClient: h.documentClient }, { Put: { TableName: "state", Item: { pk: "A", sk: "B" } } }, [pullRequest("op-1")]))
      .rejects.toMatchObject({ name: "TransactionCanceledException" });
  });

  it("with no ledger, or no valid event, makes the write alone, with its own error", async () => {
    const h = harness();
    h.db.set({ pk: "A", sk: "B" });
    await expect(auditTransact({ documentClient: h.documentClient }, { Put: { TableName: "state", Item: { pk: "A", sk: "B", x: 1 }, ConditionExpression: "attribute_not_exists(pk)" } }, [pullRequest("op-1")]))
      .rejects.toMatchObject({ name: "ConditionalCheckFailedException" });
    await auditTransact({ documentClient: h.documentClient }, { Delete: { TableName: "state", Key: { pk: "A", sk: "B" } } }, [pullRequest("op-1")]);
    expect(h.db.get("A", "B")).toBeUndefined();
    const invalid = { ...pullRequest("op-2"), facts: { notAFact: 1 } } as AuditEventInput;
    await auditTransact({ ...h.deps, documentClient: h.documentClient }, { Put: { TableName: "state", Item: { pk: "C", sk: "D" } } }, [invalid]);
    expect(h.db.commandNames().slice(-1)).toStrictEqual(["PutCommand"]);
    expect(pendingItems(h.db)).toHaveLength(0);
  });
});

describe("recordAuditEventDurably (staff reads)", () => {
  const staffRead = () => builders.auditStaffRead({ orgId: ORG, actor: { kind: "operator", id: `op_${"a".repeat(24)}` }, occurredAt: "2026-10-20T12:00:00.000Z", occurrence: "req-1", fromSeq: 1, toSeq: 5, count: 5, via: "api" });

  it("puts the pending item, sends, and deletes the item", async () => {
    const h = harness();
    await recordAuditEventDurably(h.deps, staffRead());
    expect(h.sqs.queue).toHaveLength(1);
    expect(pendingItems(h.db)).toHaveLength(0);
    expect(h.db.commandNames()[0]).toBe("PutCommand");
  });

  it("throws AUDIT_UNAVAILABLE (503) when the put fails, and sends nothing", async () => {
    const h = harness();
    h.db.injectFault({ command: "PutCommand", error: { name: "InternalServerError" } });
    await expect(recordAuditEventDurably(h.deps, staffRead())).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE", statusCode: 503, name: "AgentXError" });
    expect(h.sqs.offered()).toBe(0);
  });

  it("resolves when only the send fails: the pending item is durable", async () => {
    const h = harness();
    h.sqs.mode = "throw";
    await expect(recordAuditEventDurably(h.deps, staffRead())).resolves.toBeUndefined();
    expect(pendingItems(h.db)).toHaveLength(1);
  });

  it("resolves within the deadline when the queue never answers", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.sqs.mode = "hang";
    const done = recordAuditEventDurably(h.deps, staffRead());
    await vi.advanceTimersByTimeAsync(AUDIT_FLUSH_DEADLINE_MS);
    await expect(done).resolves.toBeUndefined();
    expect(pendingItems(h.db)).toHaveLength(1);
  });

  it("throws AUDIT_UNAVAILABLE for an event that cannot be made durable, logging paths and codes only", async () => {
    const h = harness();
    await expect(recordAuditEventDurably(h.deps, { ...staffRead(), orgId: "not an org" })).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE" });
    expect(h.logs.map((entry) => entry.event)).toStrictEqual(["audit.record_invalid"]);
    expect(pendingItems(h.db)).toHaveLength(0);
  });
});

describe("recordAuditRead (customer reads, the documented exception)", () => {
  const read = () => builders.auditRead({ orgId: ORG, actor: { kind: "member", id: "dev_1" }, occurredAt: "2026-10-20T12:00:00.000Z", occurrence: "req-9", fromSeq: 1, toSeq: 5, count: 5, via: "api" });

  it("sends, and writes no pending item when the send is accepted", async () => {
    const h = harness();
    await recordAuditRead(h.deps, read());
    expect(h.sqs.queue).toHaveLength(1);
    expect(pendingItems(h.db)).toHaveLength(0);
    expect(h.db.commandNames()).toHaveLength(0);
  });

  it("puts the pending item when the send fails", async () => {
    const h = harness();
    h.sqs.mode = "throw";
    await recordAuditRead(h.deps, read());
    expect(pendingItems(h.db)).toHaveLength(1);
  });

  it("puts the pending item within the deadline when the queue never answers", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.sqs.mode = "hang";
    let finished = false;
    const done = recordAuditRead(h.deps, read()).then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(AUDIT_FLUSH_DEADLINE_MS);
    await done;
    expect(finished).toBe(true);
    expect(pendingItems(h.db)).toHaveLength(1);
  });

  it("logs audit.record_failed, without details, when both fail, and never throws", async () => {
    const h = harness();
    h.sqs.mode = "throw";
    h.db.injectFault({ command: "PutCommand", error: { name: "InternalServerError" } });
    const event = { ...read(), details: [{ subject: "org", fields: { note: "Jane Roe read it" } }] };
    await expect(recordAuditRead(h.deps, event)).resolves.toBeUndefined();
    const failed = h.logs.filter((entry) => entry.event === "audit.record_failed");
    expect(failed).toHaveLength(1);
    expect(JSON.stringify(failed[0])).not.toContain("Jane Roe");
  });
});

describe("an invalid event never blocks the action", () => {
  it("adds no pending item, and the log holds paths and codes but no value", async () => {
    const h = harness();
    const event = {
      ...pullRequest("op-1"),
      facts: { "jane@example.com": "Jane Roe", number: 7.5 },
      details: [{ subject: "org", fields: { name: "Secret Person" } }, { subject: "org", fields: { name: "x".repeat(600) } }],
    } as AuditEventInput;
    expect(auditPending(h.deps, event)).toStrictEqual([]);
    await commitAction(h, event);
    expect(h.db.get("ACTION#1", "META")).toBeDefined();
    expect(pendingItems(h.db)).toHaveLength(0);
    expect(h.logs.length).toBeGreaterThan(0);
    for (const entry of h.logs) {
      expect(entry.event).toBe("audit.record_invalid");
      const text = JSON.stringify(entry);
      for (const secret of ["jane", "Jane", "example.com", "Secret", "x".repeat(20), "7.5"]) expect(text).not.toContain(secret);
      for (const issue of entry.issues as Array<{ path: unknown[]; code: string }>) {
        expect(Array.isArray(issue.path)).toBe(true);
        expect(typeof issue.code).toBe("string");
      }
    }
    const issues = h.logs.flatMap((entry) => entry.issues as Array<{ path: unknown[]; code: string }>);
    expect(issues).toContainEqual({ path: ["facts", "*"], code: "custom" });
    expect(issues.some((issue) => issue.path[0] === "details")).toBe(true);
  });

  it("an event with the wrong shape altogether is logged without its content", () => {
    const h = harness();
    expect(auditPending(h.deps, "a free text secret" as unknown as AuditEventInput)).toStrictEqual([]);
    expect(auditPending(h.deps, null as unknown as AuditEventInput)).toStrictEqual([]);
    expect(JSON.stringify(h.logs)).not.toContain("secret");
  });
});

describe("the drain", () => {
  it("logs audit.record_failed once, without details, for a pending item at day 13, and audit.pending_stuck each run", async () => {
    const h = harness();
    const event = pullRequest("old", { occurredAt: new Date(START - 13 * DAY).toISOString(), details: [{ subject: "org", fields: { repositoryName: "acme/secret-repo" } }] });
    h.db.set(auditPendingItem(event, START - 13 * DAY) as unknown as Record<string, unknown>);
    h.sqs.mode = "throw";
    await drainAuditPending(h.deps, START);
    await drainAuditPending(h.deps, START + 60_000);
    const failed = h.logs.filter((entry) => entry.event === "audit.record_failed");
    expect(failed).toHaveLength(1);
    expect(JSON.stringify(failed[0])).not.toContain("secret-repo");
    expect((failed[0]!.record as AuditEventInput).eventId).toBe(event.eventId);
    expect(failed[0]!.record).not.toHaveProperty("details");
    expect(h.logs.filter((entry) => entry.event === "audit.pending_stuck")).toHaveLength(2);
  });

  it("does not log a failure for a day-12 item, nor stuck for one under 10 minutes", async () => {
    const h = harness();
    h.db.set(auditPendingItem(pullRequest("a", { occurredAt: new Date(START - 12 * DAY).toISOString() }), START - 12 * DAY) as unknown as Record<string, unknown>);
    h.db.set(auditPendingItem(pullRequest("b", { occurredAt: new Date(START - 5 * 60_000).toISOString() }), START - 5 * 60_000) as unknown as Record<string, unknown>);
    h.sqs.mode = "throw";
    await drainAuditPending(h.deps, START);
    expect(h.logs.filter((entry) => entry.event === "audit.record_failed")).toHaveLength(0);
    expect(h.logs.filter((entry) => entry.event === "audit.pending_stuck")).toHaveLength(1);
  });

  it("does not log a failure or a stuck item that the drain delivers", async () => {
    const h = harness();
    h.db.set(auditPendingItem(pullRequest("old", { occurredAt: new Date(START - 13 * DAY).toISOString() }), START - 13 * DAY) as unknown as Record<string, unknown>);
    await drainAuditPending(h.deps, START);
    expect(h.logs.filter((entry) => ["audit.record_failed", "audit.pending_stuck"].includes(String(entry.event)))).toHaveLength(0);
    expect(h.sqs.queue).toHaveLength(1);
  });

  it("sends a shard's items oldest first", async () => {
    const h = harness();
    const times = ["2026-10-20T11:50:10.000Z", "2026-10-20T11:50:00.000Z", "2026-10-20T11:50:05.000Z"];
    const events = times.map((occurredAt, index) => eventInShard(3, index, { occurredAt }));
    for (const event of events) h.db.set(auditPendingItem(event, START) as unknown as Record<string, unknown>);
    await drainAuditPending(h.deps, START + 31_000);
    expect(h.sqs.queue.map((message) => message.dedupId)).toStrictEqual([events[1]!.eventId, events[2]!.eventId, events[0]!.eventId]);
  });

  it("pages 100 at a time, and resumes from its cursor without repeating or skipping", async () => {
    const h = harness();
    const events = Array.from({ length: 250 }, (_, index) => eventInShard(0, index, { occurredAt: new Date(START - 3_600_000 + index * 1000).toISOString() }));
    for (const event of events) h.db.set(auditPendingItem(event, START) as unknown as Record<string, unknown>);
    const first = await drainAuditPending(h.deps, START, undefined, { maxItems: 120 });
    expect(first.cursor).toBeDefined();
    expect(first.examined).toBe(200);
    const second = await drainAuditPending(h.deps, START, first.cursor);
    expect(second.cursor).toBeUndefined();
    expect(second.examined).toBe(50);
    expect(h.sqs.queue.map((message) => message.dedupId)).toStrictEqual(events.map((event) => event.eventId));
    expect(h.sqs.offered()).toBe(250);
    expect(pendingItems(h.db)).toHaveLength(0);
    expect(AUDIT_DRAIN_PAGE_SIZE).toBe(100);
    expect(h.db.commandNames().filter((name) => name === "QueryCommand").length).toBeGreaterThanOrEqual(3);
  });

  it("runAuditDrain continues through the cursor within its budget", async () => {
    const h = harness();
    for (let index = 0; index < 600; index += 1) h.db.set(auditPendingItem(eventInShard(index % 4, index, { occurredAt: "2026-10-20T11:00:00.000Z" }), START) as unknown as Record<string, unknown>);
    const result = await runAuditDrain(h.deps, { now: () => START + 61_000 });
    expect(result).toMatchObject({ examined: 600, sent: 600, more: false });
    expect(pendingItems(h.db)).toHaveLength(0);
  });

  it("when the queue is unreachable it tries once and then only does its bookkeeping", async () => {
    const h = harness();
    const fresh = eventInShard(1, 1, { occurredAt: "2026-10-20T11:55:00.000Z" });
    const stale = eventInShard(2, 2, { occurredAt: new Date(START - 13 * DAY).toISOString() });
    h.db.set(auditPendingItem(fresh, START - 5 * 60_000) as unknown as Record<string, unknown>);
    h.db.set(auditPendingItem(stale, START - 13 * DAY) as unknown as Record<string, unknown>);
    h.sqs.mode = "throw";
    await drainAuditPending(h.deps, START);
    expect(h.sqs.calls).toHaveLength(1);
    expect(h.logs.filter((entry) => entry.event === "audit.record_failed")).toHaveLength(1);
  });

  it("counts a failed Query and stops, without throwing", async () => {
    const h = harness();
    h.db.injectFault({ command: "QueryCommand", error: { name: "InternalServerError" } });
    await expect(drainAuditPending(h.deps, START)).resolves.toMatchObject({ examined: 0 });
    expect(h.logs.map((entry) => entry.event)).toContain("audit.drain_failed");
  });

  it("an item whose stored event is invalid is logged as invalid, not sent", async () => {
    const h = harness();
    const event = pullRequest("a");
    h.db.set({ ...auditPendingItem(event, START - 60_000), event: { ...event, facts: { notAFact: 1 } } });
    await drainAuditPending(h.deps, START);
    expect(h.sqs.offered()).toBe(0);
    expect(h.logs.map((entry) => entry.event)).toContain("audit.record_invalid");
  });
});

describe("failure logs hold no personal data", () => {
  const NAME = "Acme Secret Project";
  const NOTE = "Jane Roe asked for it";
  const personal = (occurredAt = "2026-10-20T11:59:00.000Z"): AuditEventInput => builders.auditProjectMemberChanged({
    orgId: ORG,
    actor: { kind: "member", id: "dev_1" },
    occurredAt,
    occurrence: "req-1",
    projectName: NAME,
    memberId: "dev_2",
    toRole: "admin",
    details: [{ subject: "org", fields: { note: NOTE } }],
  });
  const expectClean = (h: Harness): void => {
    expect(h.logs.length).toBeGreaterThan(0);
    const text = JSON.stringify(h.logs);
    for (const secret of [NAME, "Secret", "Acme", NOTE, "Jane"]) expect(text).not.toContain(secret);
  };

  it("the log-safe event keeps the ids, action and facts, drops details, and turns a name-keyed target into its kind", () => {
    const event = personal();
    expect(event.target).toStrictEqual({ kind: "project", name: NAME });
    const safe = auditEventWithoutDetails(event);
    expect(safe).toStrictEqual({ eventId: event.eventId, orgId: ORG, action: "project_member.changed", actor: { kind: "member", id: "dev_1" }, target: { kind: "project" }, occurredAt: event.occurredAt, related: ["dev_2"], facts: { toRole: "admin" } });
    expect(auditEventWithoutDetails(pullRequest("a")).target).toStrictEqual({ kind: "pull_request", id: "pr_1" });
  });

  it("audit.record_failed from a read that could not be recorded", async () => {
    const h = harness();
    h.sqs.mode = "throw";
    h.db.injectFault({ command: "PutCommand", error: { name: "InternalServerError" } });
    await recordAuditRead(h.deps, personal());
    expect(h.logs.map((entry) => entry.event)).toStrictEqual(["audit.record_failed"]);
    expect((h.logs[0]!.record as AuditEventInput).target).toStrictEqual({ kind: "project" });
    expectClean(h);
  });

  it("audit.record_failed and audit.pending_stuck from the drain, for an item at day 13", async () => {
    const h = harness();
    const event = personal(new Date(START - 13 * DAY).toISOString());
    h.db.set(auditPendingItem(event, START - 13 * DAY) as unknown as Record<string, unknown>);
    h.sqs.mode = "throw";
    await drainAuditPending(h.deps, START);
    expect(h.logs.map((entry) => entry.event)).toEqual(expect.arrayContaining(["audit.record_failed", "audit.pending_stuck"]));
    for (const entry of h.logs.filter((line) => line.record !== undefined)) expect((entry.record as AuditEventInput).target).toStrictEqual({ kind: "project" });
    expectClean(h);
  });

  it("audit.pending_stuck from the drain, for an item over 10 minutes", async () => {
    const h = harness();
    h.db.set(auditPendingItem(personal(new Date(START - 20 * 60_000).toISOString()), START - 20 * 60_000) as unknown as Record<string, unknown>);
    h.sqs.mode = "throw";
    await drainAuditPending(h.deps, START);
    expect(h.logs.map((entry) => entry.event)).toContain("audit.pending_stuck");
    expectClean(h);
  });

  it("the durable put, the flush, a failed drain query and a failed attempt count", async () => {
    const h = harness();
    h.db.injectFault({ command: "PutCommand", error: { name: "InternalServerError" } });
    await expect(recordAuditEventDurably(h.deps, personal())).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE" });
    h.sqs.mode = "throw";
    await flushAuditEvents(h.deps, [personal()]);
    h.db.set(auditPendingItem(personal(), START - 60_000) as unknown as Record<string, unknown>);
    h.db.injectFault({ command: "UpdateCommand", error: { name: "InternalServerError" } });
    await drainAuditPending(h.deps, START);
    h.db.injectFault({ command: "QueryCommand", error: { name: "InternalServerError" } });
    await drainAuditPending(h.deps, START);
    expect(h.logs.map((entry) => entry.event)).toEqual(expect.arrayContaining(["audit.durable_put_failed", "audit.drain_failed"]));
    expectClean(h);
  });

  it("audit.record_invalid for an invalid event with a name-keyed target", () => {
    const h = harness();
    expect(auditPending(h.deps, { ...personal(), facts: { toRole: "admin", [NOTE]: NAME } })).toStrictEqual([]);
    expect(h.logs.map((entry) => entry.event)).toStrictEqual(["audit.record_invalid"]);
    expectClean(h);
  });
});

describe("I4: the builders", () => {
  const base = { orgId: ORG, actor: { kind: "member", id: "dev_1" } as const, occurredAt: "2026-10-20T12:00:00.000Z" };
  const PERSONAL = ["Jane Roe", "jane@example.com", "jroe-login", "Secret Project", "secret-repo", "evil.example.org"];
  const details = [{ subject: "org", fields: { name: "Jane Roe", email: "jane@example.com", login: "jroe-login" } }];

  /** Each builder with the same facts for any occurrence. Name-keyed targets use personal names, which must stay in target.name. */
  const cases: Array<[string, (occurrence: string) => AuditEventInput]> = [
    ["auditApprovalDecided", (occurrence) => builders.auditApprovalDecided({ ...base, occurrence, details, approvalId: "apr_1", kind: "write", decision: "approved", subjectKind: "write", class: "A" })],
    ["auditApprovalExpired", (occurrence) => builders.auditApprovalExpired({ ...base, occurrence, details, approvalId: "apr_1", kind: "write", subjectKind: "write" })],
    ["auditApprovalRequested", (occurrence) => builders.auditApprovalRequested({ ...base, occurrence, details, approvalId: "apr_1", kind: "write", subjectKind: "agent_run", class: "consequential", connectorType: "linear", tool: "create_issue", argumentsHash: "a".repeat(64) })],
    ["auditApprovalRerouted", (occurrence) => builders.auditApprovalRerouted({ ...base, occurrence, details, approvalId: "apr_1", kind: "write", mode: "merged", from: "dev_1", to: "dev_2" })],
    ["auditWriteExecuted", (occurrence) => builders.auditWriteExecuted({ ...base, occurrence, details, approvalId: "apr_1", connectorType: "linear", tool: "create_issue", status: "APPROVED_DONE", argumentsHash: "a".repeat(64) })],
    ["auditSpendRequestCreated", (occurrence) => builders.auditSpendRequestCreated({ ...base, occurrence, details, spendRequestId: "spr_1", kind: "raise", scopeKind: "member", amountCents: 500 })],
    ["auditSpendRequestDecided", (occurrence) => builders.auditSpendRequestDecided({ ...base, occurrence, details, spendRequestId: "spr_1", kind: "raise", scopeKind: "member", amountCents: 500, decision: "approved" })],
    ["auditSpendRequestExpired", (occurrence) => builders.auditSpendRequestExpired({ ...base, occurrence, details, spendRequestId: "spr_1", kind: "raise", scopeKind: "member", amountCents: 500 })],
    ["auditSpendRequestEscalated", (occurrence) => builders.auditSpendRequestEscalated({ ...base, occurrence, details, spendRequestId: "spr_1", kind: "max_per_run", scopeKind: "agent", amountCents: 500 })],
    ["auditSpendRequestRerouted", (occurrence) => builders.auditSpendRequestRerouted({ ...base, occurrence, details, spendRequestId: "spr_1", kind: "month", mode: "merged", from: "dev_2", to: "dev_3" })],
    ["auditSpendRequestResumeDropped", (occurrence) => builders.auditSpendRequestResumeDropped({ ...base, occurrence, details, spendRequestId: "spr_1", taskId: "task_1", kind: "month", cause: "member_left" })],
    ["auditBudgetChanged", (occurrence) => builders.auditBudgetChanged({ ...base, occurrence, details, target: { kind: "budget", id: "dev_2" }, scopeKind: "member", field: "limit", fromCents: 50000, toCents: 80000 })],
    ["auditSpendPolicyChanged", (occurrence) => builders.auditSpendPolicyChanged({ ...base, occurrence, details, field: "threshold", from: 100, to: 200 })],
    ["auditPullRequestOpened", (occurrence) => builders.auditPullRequestOpened({ ...base, occurrence, details, pullRequestId: "pr_1", number: 7 })],
    ["auditPullRequestMerged", (occurrence) => builders.auditPullRequestMerged({ ...base, occurrence, details, pullRequestId: "pr_1", number: 7 })],
    ["auditPullRequestMergeRequested", (occurrence) => builders.auditPullRequestMergeRequested({ ...base, occurrence, details, pullRequestId: "pr_1", number: 7, method: "squash" })],
    ["auditMemberJoined", (occurrence) => builders.auditMemberJoined({ ...base, occurrence, details, memberId: "dev_2", role: "member", via: "invite" })],
    ["auditMemberRoleChanged", (occurrence) => builders.auditMemberRoleChanged({ ...base, occurrence, details, memberId: "dev_2", fromRole: "member", toRole: "admin" })],
    ["auditMemberRemoved", (occurrence) => builders.auditMemberRemoved({ ...base, occurrence, details, memberId: "dev_2", role: "member" })],
    ["auditMemberLeft", (occurrence) => builders.auditMemberLeft({ ...base, occurrence, details, memberId: "dev_2", role: "member" })],
    ["auditMemberRemovalCompleted", (occurrence) => builders.auditMemberRemovalCompleted({ ...base, occurrence, details, memberId: "dev_2", outcome: "done", wasRole: "member", counts: { approvalsMoved: 1, grantsRemoved: 2, signInEnded: true, countsComplete: true } })],
    ["auditProjectMemberChanged", (occurrence) => builders.auditProjectMemberChanged({ ...base, occurrence, details, projectName: "Secret Project", memberId: "dev_2", fromRole: "viewer", toRole: "editor" })],
    ["auditProjectMemberRemoved", (occurrence) => builders.auditProjectMemberRemoved({ ...base, occurrence, details, projectName: "Secret Project", memberId: "dev_2", role: "viewer" })],
    ["auditIdentityLinked", (occurrence) => builders.auditIdentityLinked({ ...base, occurrence, details, memberId: "dev_2", provider: "github" })],
    ["auditIdentityUnlinked", (occurrence) => builders.auditIdentityUnlinked({ ...base, occurrence, details, memberId: "dev_2", provider: "github" })],
    ["auditOrgClosed", (occurrence) => builders.auditOrgClosed({ ...base, occurrence, details, plan: "team" })],
    ["auditOrgRenamed", (occurrence) => builders.auditOrgRenamed({ ...base, occurrence, details })],
    ["auditOrgInviteCreated", (occurrence) => builders.auditOrgInviteCreated({ ...base, occurrence, details, inviteId: "11111111-1111-4111-8111-111111111111", role: "member", targeted: true })],
    ["auditOrgInviteRevoked", (occurrence) => builders.auditOrgInviteRevoked({ ...base, occurrence, details, inviteId: "11111111-1111-4111-8111-111111111111", role: "member" })],
    ["auditProjectRestored", (occurrence) => builders.auditProjectRestored({ ...base, occurrence, details, projectName: "Secret Project", fromRevision: 0, toRevision: 1, projectRevision: 3, requestId: "22222222-2222-4222-8222-222222222222" })],
    ["auditProjectArchived", (occurrence) => builders.auditProjectArchived({ ...base, occurrence, details, projectName: "Secret Project", fromRevision: 0, toRevision: 1, projectRevision: 3, requestId: "22222222-2222-4222-8222-222222222222" })],
    ["auditProjectWorkingBranchChanged", (occurrence) => builders.auditProjectWorkingBranchChanged({ ...base, occurrence, details, projectName: "Secret Project", fromRevision: 1, toRevision: 2, lifecycleRevision: 3, installationId: 11, repositoryId: 22, requestId: "22222222-2222-4222-8222-222222222222", previousConfigured: false })],
    // Call sites: developer/store.ts setChosenDisplayName; org/slack-binding.ts bind and unbind; aws/broker.ts connectSlackTeam and disconnectSlackTeam (operator actor).
    ["auditMemberRenamed", (occurrence) => builders.auditMemberRenamed({ ...base, occurrence, details, memberId: "dev_1" })],
    ["auditSlackChannelProposed", (occurrence) => builders.auditSlackChannelProposed({ ...base, occurrence, details, projectName: "project_1", teamId: "T123", channelId: "C123", requestId: "request_1" })],
    ["auditSlackChannelDecision", (occurrence) => builders.auditSlackChannelDecision({ ...base, occurrence, details, projectName: "project_1", teamId: "T123", channelId: "C123", requestId: "request_1", proposalId: "proposal_1", state: "cancelled" })],
    ["auditSlackChannelBound", (occurrence) => builders.auditSlackChannelBound({ ...base, occurrence, details, projectName: "Secret Project", teamId: "T0123ABCD", channelId: "C0123ABCD" })],
    ["auditSlackChannelUnbound", (occurrence) => builders.auditSlackChannelUnbound({ ...base, occurrence, details, projectName: "Secret Project", teamId: "T0123ABCD", channelId: "C0123ABCD" })],
    ["auditSlackTeamConnected", (occurrence) => builders.auditSlackTeamConnected({ ...base, actor: { kind: "operator", id: auditOperatorId("https://issuer.example", "operator-subject") }, occurrence, details, teamId: "T0123ABCD" })],
    ["auditSlackTeamDisconnected", (occurrence) => builders.auditSlackTeamDisconnected({ ...base, actor: { kind: "operator", id: auditOperatorId("https://issuer.example", "operator-subject") }, occurrence, details, teamId: "T0123ABCD" })],
    ["auditOwnerChanged (agent)", (occurrence) => builders.auditOwnerChanged({ ...base, occurrence, details, scope: "agent", targetId: "agt_1", field: "owner" })],
    ["auditOwnerChanged (chain)", (occurrence) => builders.auditOwnerChanged({ ...base, occurrence, details, scope: "chain", targetId: "chn_1", field: "owner" })],
    ["auditSessionOwnerChanged", (occurrence) => builders.auditSessionOwnerChanged({ ...base, occurrence, details, sessionId: "ses_0123456789abcdefghij", sessionKind: "task", payerMoved: true })],
    ["auditSessionStopped", (occurrence) => builders.auditSessionStopped({ ...base, occurrence, details, sessionId: "ses_0123456789abcdefghij", sessionKind: "task" })],
    ["auditSessionRetried", (occurrence) => builders.auditSessionRetried({ ...base, occurrence, details, sessionId: "ses_0123456789abcdefghij", sessionKind: "task", branch: "new_run" })],
    ["auditSessionSharedOrg", (occurrence) => builders.auditSessionSharedOrg({ ...base, occurrence, details, sessionId: "ses_0123456789abcdefghij", level: "use" })],
    ["auditSessionLinked", (occurrence) => builders.auditSessionLinked({ ...base, occurrence, details, sessionId: "ses_0123456789abcdefghij", issueKey: "ENG-142" })],
    ["auditSessionUnlinked", (occurrence) => builders.auditSessionUnlinked({ ...base, occurrence, details, sessionId: "ses_0123456789abcdefghij", issueKey: "ENG-142" })],
    ["auditPublished (agent)", (occurrence) => builders.auditPublished({ ...base, occurrence, details, scope: "agent", targetId: "agt_1", version: 3, safety: "safe" })],
    ["auditPublished (chain)", (occurrence) => builders.auditPublished({ ...base, occurrence, details, scope: "chain", targetId: "chn_1", version: 3, safety: "safe" })],
    ["auditRolledBack (agent)", (occurrence) => builders.auditRolledBack({ ...base, occurrence, details, scope: "agent", targetId: "agt_1", fromVersion: 3, toVersion: 2 })],
    ["auditRolledBack (chain)", (occurrence) => builders.auditRolledBack({ ...base, occurrence, details, scope: "chain", targetId: "chn_1", fromVersion: 3, toVersion: 2 })],
    ["auditBuiltinAdopted", (occurrence) => builders.auditBuiltinAdopted({ ...base, occurrence, details, agentId: "agt_1", version: 4 })],
    ["auditConnectionSaved", (occurrence) => builders.auditConnectionSaved({ ...base, occurrence, details, connectionId: "con_1", connectorType: "linear" })],
    ["auditConnectionRemoved", (occurrence) => builders.auditConnectionRemoved({ ...base, occurrence, details, connectionId: "con_1", connectorType: "linear" })],
    ["auditCodeSettingsChanged", (occurrence) => builders.auditCodeSettingsChanged({ ...base, occurrence, details, projectName: "web", revision: 2, changed: "selfApproval", selfApproval: true, mergeMethod: "squash", reviewers: 0 })],
    ["auditProjectConnectorChanged", (occurrence) => builders.auditProjectConnectorChanged({ ...base, occurrence, details, connectorId: "cnr_1", connectorType: "linear", revision: 3, change: "widened" })],
    ["auditGuardrailsChanged", (occurrence) => builders.auditGuardrailsChanged({ ...base, occurrence, details, guardrailsId: "grd_1", revision: 3, widened: true })],
    ["auditLocalAgentsPolicyChanged", (occurrence) => builders.auditLocalAgentsPolicyChanged({ ...base, occurrence, details, field: "tools", from: "codex", to: "none" })],
    ["auditOptOutApplied", (occurrence) => builders.auditOptOutApplied({ ...base, occurrence, details, repositoryName: "secret-repo", scope: "repository" })],
    ["auditOptOutLapsed", (occurrence) => builders.auditOptOutLapsed({ ...base, occurrence, details, repositoryName: "secret-repo", scope: "repository" })],
    ["auditEgressDecided", (occurrence) => builders.auditEgressDecided({ ...base, occurrence, details, domain: "evil.example.org", decision: "approved" })],
    ["auditTriggerEnabled", (occurrence) => builders.auditTriggerEnabled({ ...base, occurrence, details, triggerId: "trg_1", source: "github", type: "comment", targetKind: "agent" })],
    ["auditTriggerDisabled", (occurrence) => builders.auditTriggerDisabled({ ...base, occurrence, details, triggerId: "trg_1", cause: "person", source: "github", type: "comment", targetKind: "agent" })],
    ["auditGithubConnected", (occurrence) => builders.auditGithubConnected({ ...base, occurrence, details, installationId: "1234", accountType: "Organization", result: "connected" })],
    ["auditGithubDisconnected", (occurrence) => builders.auditGithubDisconnected({ ...base, occurrence, details, installationId: "1234", accountType: "Organization" })],
    ["auditGithubInstallationChanged", (occurrence) => builders.auditGithubInstallationChanged({ ...base, occurrence, details, installationId: "1234", status: "removed", accountType: "Organization" })],
    ["auditModelSourceSaved", (occurrence) => builders.auditModelSourceSaved({ ...base, occurrence, details, sourceId: "src_abcdefghij0123456789", sourceKind: "anthropic", change: "created" })],
    ["auditModelSourceRemoved", (occurrence) => builders.auditModelSourceRemoved({ ...base, occurrence, details, sourceId: "src_abcdefghij0123456789", sourceKind: "anthropic" })],
    ["auditModelSourceOrderChanged", (occurrence) => builders.auditModelSourceOrderChanged({ ...base, occurrence, details, count: 2 })],
    ["auditMemberRenamed", (occurrence) => builders.auditMemberRenamed({ ...base, occurrence, details, memberId: "dev_2" })],
    ["auditSlackChannelBound", (occurrence) => builders.auditSlackChannelBound({ ...base, occurrence, details, projectName: "project_1", teamId: "T123", channelId: "C123" })],
    ["auditSlackChannelUnbound", (occurrence) => builders.auditSlackChannelUnbound({ ...base, occurrence, details, projectName: "project_1", teamId: "T123", channelId: "C123" })],
    ["auditSlackTeamConnected", (occurrence) => builders.auditSlackTeamConnected({ ...base, occurrence, details, teamId: "T123" })],
    ["auditSlackTeamDisconnected", (occurrence) => builders.auditSlackTeamDisconnected({ ...base, occurrence, details, teamId: "T123" })],
    ["auditRead", (occurrence) => builders.auditRead({ ...base, occurrence, details, fromSeq: 1, toSeq: 9, count: 9, via: "api" })],
    ["auditStaffRead", (occurrence) => builders.auditStaffRead({ ...base, actor: { kind: "operator", id: `op_${"b".repeat(24)}` }, occurrence, details, fromSeq: 1, toSeq: 9, count: 9, via: "api" })],
    ["auditExported", (occurrence) => builders.auditExported({ ...base, occurrence, details, exportId: "exp_1", fromSeq: 1, toSeq: 9, withDetails: true })],
    ["auditSubjectErased", (occurrence) => builders.auditSubjectErased({ ...base, occurrence, details, subject: "dev_2" })],
    ["auditShredScheduled", (occurrence) => builders.auditShredScheduled({ ...base, occurrence, details, shredAfterDays: 30 })],
    // C53: model policy and visible task fallback events obey the same occurrence and privacy contract.
    ["auditModelPolicyChanged", (occurrence) => builders.auditModelPolicyChanged({ ...base, occurrence, details, revision: 3, policyDigest: "a".repeat(64), previousDigest: "b".repeat(64) })],
    ["auditModelPolicyLockSet", (occurrence) => builders.auditModelPolicyLockSet({ ...base, occurrence, details, revision: 3, policyDigest: "a".repeat(64), stage: "build" })],
    ["auditModelPolicyLockRemoved", (occurrence) => builders.auditModelPolicyLockRemoved({ ...base, occurrence, details, revision: 4, policyDigest: "a".repeat(64), stage: "build" })],
    ["auditModelFallbackUsed", (occurrence) => builders.auditModelFallbackUsed({ ...base, occurrence, details, projectName: "Secret Project", stage: "build", used: { provider: "anthropic", modelId: "private-model" }, wanted: { provider: "openai", modelId: "other-private-model" }, reasonCode: "DEFAULT_MODEL_UNAVAILABLE", companyRevision: 3 })],
    // "How we work" playbook (H1)
    ["auditProjectModelsChanged", (occurrence) => builders.auditProjectModelsChanged({ ...base, occurrence, details, projectName: "Secret Project", revision: 3, approvedCount: 2, defaultChanged: true })],
    ["auditProjectChecksChanged", (occurrence) => builders.auditProjectChecksChanged({ ...base, occurrence, details, projectName: "Secret Project", revision: 3, requiredCount: 2, optionalCount: 1 })],
    ["auditProjectE2ePolicyChanged", (occurrence) => builders.auditProjectE2ePolicyChanged({ ...base, occurrence, details, projectName: "Secret Project", revision: 3, screenshots: true, traces: false, video: false, downloads: true })],
    ["auditProjectModelSelectionChanged", (occurrence) => builders.auditProjectModelSelectionChanged({ ...base, occurrence, details, projectName: "Secret Project", surface: "slack", cleared: false })],
    ["auditProjectRosterChanged", (occurrence) => builders.auditProjectRosterChanged({ ...base, occurrence, details, projectName: "Secret Project", added: 2, removed: 1 })],
    ["auditProcessPublished", (occurrence) => builders.auditProcessPublished({ ...base, occurrence, details, agentId: "agt_1", version: 2, safety: "safe", selfConfirmedSoleOwner: false })],
    ["auditProcessRolledBack", (occurrence) => builders.auditProcessRolledBack({ ...base, occurrence, details, agentId: "agt_1", fromVersion: 3, toVersion: 2, safety: "safe" })],
    ["auditPlaybookDefaultProcessChanged", (occurrence) => builders.auditPlaybookDefaultProcessChanged({ ...base, occurrence, details, projectName: "Secret Project", revision: 4, processKind: "builtin" })],
    ["auditTaskStopPolicyChange (changed)", (occurrence) => builders.auditTaskStopPolicyChange({ ...base, details, occurrence, action: "spending.policy_changed", scopeKind: "company", revision: 2, requestId: "11111111-1111-4111-8111-111111111111", before: { kind: "limited", stopMicrousd: 1234567 }, after: { kind: "rovara_estimate" } })],
    ["auditTaskStopPolicyChange (requested)", (occurrence) => builders.auditTaskStopPolicyChange({ ...base, details, occurrence, action: "spending.policy_change_requested", scopeKind: "company", revision: 2, requestId: "11111111-1111-4111-8111-111111111111", before: { kind: "limited", stopMicrousd: 1234567 }, after: { kind: "rovara_estimate" } })],
    ["auditTaskStopPolicyChange (decided)", (occurrence) => builders.auditTaskStopPolicyChange({ ...base, details, occurrence, action: "spending.policy_change_decided", scopeKind: "company", revision: 2, requestId: "11111111-1111-4111-8111-111111111111", before: { kind: "limited", stopMicrousd: 1234567 }, after: { kind: "rovara_estimate" } })],
    ["auditTaskStopDecision", (occurrence) => builders.auditTaskStopDecision({ ...base, details, occurrence, action: "spending.stop_admitted", taskId: "11111111-1111-4111-8111-111111111111", admissionId: "22222222-2222-4222-8222-222222222222", effectiveStopMicrousd: 1234567, approvalCapMicrousd: 100000000, policyDigest: "a".repeat(64) })],
    ["auditTaskStopPolicySeeded", (occurrence) => builders.auditTaskStopPolicySeeded({ ...base, details, actor: { kind: "system", id: "rovara" }, occurrence, source: "bootstrap", mode: "rovara_estimate", revision: 1, ceilingMicrousd: 100_000_000 })],
    // Automatic runs: the system starts, pauses and ends them (no person); a maintainer changes the monthly cap
    ["auditAutomaticRunStarted", (occurrence) => builders.auditAutomaticRunStarted({ ...base, details, actor: { kind: "system", id: "rovara" }, occurrence, projectName: "Secret Project", job: "nightly", setupApprovedBy: "dev_1", runsThisMonth: 3, cap: 30 })],
    ["auditAutomaticRunStarted (no approver)", (occurrence) => builders.auditAutomaticRunStarted({ ...base, details, actor: { kind: "system", id: "rovara" }, occurrence, projectName: "Secret Project", job: "nightly", setupApprovedBy: undefined, runsThisMonth: 3, cap: 30 })],
    ["auditProjectAutomaticRunsCapChanged", (occurrence) => builders.auditProjectAutomaticRunsCapChanged({ ...base, occurrence, details, projectName: "Secret Project", fromCap: 30, toCap: 60 })],
    ["auditAutomaticRunsPaused", (occurrence) => builders.auditAutomaticRunsPaused({ ...base, details, actor: { kind: "system", id: "rovara" }, occurrence, projectName: "Secret Project", month: "2026-11", cap: 30 })],
    ["auditAutomaticRunEnded", (occurrence) => builders.auditAutomaticRunEnded({ ...base, details, actor: { kind: "system", id: "rovara" }, occurrence, projectName: "Secret Project", job: "nightly", reason: "cap_reached" })],
    ["auditCompanyChangeAppliedToProject", (occurrence) => builders.auditCompanyChangeAppliedToProject({ ...base, occurrence, details, projectName: "Secret Project", changeRevision: 5, settingCount: 2 })],
    // Test environment: a tier change records the tier and how many less-safe fields it turned on
    ["auditProjectTestEnvChanged", (occurrence) => builders.auditProjectTestEnvChanged({ ...base, occurrence, details, projectName: "Secret Project", revision: 3, tier: "preview", lessSafeCount: 1 })],
    // Proof and evidence P6: one event per evidence download, the artifact named by its fixed kind and retention class
    ["auditEvidenceDownloaded", (occurrence) => builders.auditEvidenceDownloaded({ ...base, occurrence, details, taskId: "tsk_1", artifactKind: "screenshot", retentionClass: "evidence-short" })],
    // Setup and test health SH17: a maintainer marked tests as already failing; the event carries the fixed cause word and a count, never a test name
    // Nightly health (SH28): a project setting changed (fixed word and a flag). Missing at the base of this branch; added with the Fix setup rows.
    ["auditProjectTestHealthSettingChanged", (occurrence) => builders.auditProjectTestHealthSettingChanged({ ...base, occurrence, details, projectName: "Secret Project", setting: "propose_fix_task", enabled: true })],
    ["auditProjectKnownFailingMarked", (occurrence) => builders.auditProjectKnownFailingMarked({ ...base, occurrence, details, projectName: "Secret Project", cause: "fails-on-original-code", testCount: 3, recordEpoch: 1, taskCount: 2, taskIdsSha256: "a".repeat(64), testSetSha256: "b".repeat(64), rowVersionAfter: 1, totalAfter: 3, approvalMode: "single", secondPersonWhy: "not_needed" })],
    ["auditProjectKnownFailingRemoved", (occurrence) => builders.auditProjectKnownFailingRemoved({ ...base, occurrence, details, projectName: "Secret Project", removal: "nightly_passing", testCount: 2, markEpoch: 0, testSetSha256: "b".repeat(64), rowVersionAfter: 4, totalAfter: 1 })],
    // Company sign-in (Enterprise foundations I1): the rule ids a sign-in matched, and the owners on the emergency list, are details
    ["auditSsoSignIn", (occurrence) => builders.auditSsoSignIn({ ...base, occurrence, details, memberId: "dev_1", role: "member", matchedRuleIds: ["users"] })],
    ["auditSsoSignInRefused", (occurrence) => builders.auditSsoSignInRefused({ ...base, occurrence, details, memberId: "dev_1", reason: "no_group" })],
    ["auditSsoBreakGlassUsed", (occurrence) => builders.auditSsoBreakGlassUsed({ ...base, occurrence, details, memberId: "dev_1", sessionSeconds: 3600 })],
    ["auditSsoGroupMappingChanged", (occurrence) => builders.auditSsoGroupMappingChanged({ ...base, occurrence, details, fromVersion: 1, toVersion: 2, rules: 3, added: ["users"], removed: [] })],
    ["auditSsoSamlChanged", (occurrence) => builders.auditSsoSamlChanged({ ...base, occurrence, details, fromVersion: 1, toVersion: 2, changed: ["certificate"], certificateSha256: "a".repeat(64) })],
    ["auditSsoBreakGlassChanged", (occurrence) => builders.auditSsoBreakGlassChanged({ ...base, occurrence, details, toVersion: 1, owners: 1, ownerIds: ["a".repeat(64)] })],
    // Lane E (private MCP servers, project Sources)
    ["auditMcpServerChanged", (occurrence) => builders.auditMcpServerChanged({ ...base, occurrence, details, action: "mcp_server.added", serverId: "mcp_1", label: "Docs server", transport: "http", hasToken: true })],
    ["auditMcpServerTokenChanged", (occurrence) => builders.auditMcpServerTokenChanged({ ...base, occurrence, details, serverId: "mcp_1", change: "stored" })],
    // Stdio MCP host (T10): hashes, counts and fixed words are facts; the package's destinations, the secret names and the addresses are the org's details
    ["auditMcpServerApproved", (occurrence) => builders.auditMcpServerApproved({ ...base, occurrence, details, serverId: "mcp_1", label: "Docs server", transport: "stdio", hasToken: true, pin: { integrity: `sha512-${"A".repeat(86)}==`, lockfileHash: "1".repeat(64), bundleHash: "2".repeat(64), toolsHash: "3".repeat(64), destinationCount: 1, secretCount: 1, secretVersion: "v1", destinations: "docs.corp.example:443", secretNames: "DOCS_TOKEN" } })],
    ["auditMcpServerInstalled", (occurrence) => builders.auditMcpServerInstalled({ ...base, occurrence, details, serverId: "mcp_1", name: "@acme/docs-mcp", version: "1.0.0", integrity: `sha512-${"A".repeat(86)}==`, lockfileHash: "1".repeat(64), bundleHash: "2".repeat(64), packageCount: 4, unpackedBytes: 4096 })],
    ["auditMcpServerProbed", (occurrence) => builders.auditMcpServerProbed({ ...base, occurrence, details, serverId: "mcp_1", purpose: "proposal", toolsHash: "3".repeat(64), bundleHash: "2".repeat(64), toolCount: 2 })],
    ["auditMcpServerChangedNeedsReview", (occurrence) => builders.auditMcpServerChangedNeedsReview({ ...base, occurrence, details, serverId: "mcp_1", approvedToolsHash: "3".repeat(64), observedToolsHash: "4".repeat(64) })],
    ["auditMcpServerTaskStarted", (occurrence) => builders.auditMcpServerTaskStarted({ ...base, occurrence, details, serverId: "mcp_1", trigger: "warm" })],
    ["auditMcpServerTaskStopped", (occurrence) => builders.auditMcpServerTaskStopped({ ...base, occurrence, details, serverId: "mcp_1", reason: "idle" })],
    ["auditMcpServerEgressUpdated", (occurrence) => builders.auditMcpServerEgressUpdated({ ...base, occurrence, details, serverId: "mcp_1", added: 1, removed: 0, addresses: "for docs.corp.example:443; added 10.1.2.9:443; removed " })],
    ["auditMcpServerSecretReplaced", (occurrence) => builders.auditMcpServerSecretReplaced({ ...base, occurrence, details, serverId: "mcp_1", secretCount: 1, secretVersion: "v2" })],
    ["auditContextSourceChange", (occurrence) => builders.auditContextSourceChange({ ...base, occurrence, details, action: "context_source.applied", projectName: "Secret Project", sourceId: "src_1", change: "set" })],
    // Live interaction part 2
    ["auditSessionRedirected", (occurrence) => builders.auditSessionRedirected({ ...base, occurrence, details, sessionId: "ses_1", taskId: "task_1", messageId: "msg_1", mode: "keep_plan", step: "IMPLEMENT", outcome: "restarted" })],
    ["auditTaskAsked (each)", (occurrence) => builders.auditTaskAsked({ ...base, occurrence, details, scope: "each", sessionId: "ses_1", askId: "ask_1", audience: "web", contextBytes: 2048, model: "model_1" })],
    ["auditAskLinearCommentKept", (occurrence) => builders.auditAskLinearCommentKept({ ...base, occurrence, details, sessionId: "ses_1", askId: "ask_1", reason: "not_rovaras", attempts: 10 })],
    ["auditTaskAsked (daily)", (occurrence) => builders.auditTaskAsked({ ...base, occurrence, details, scope: "daily", projectName: "Secret Project", count: 3 })],
    ["auditDiagnosisStarted", (occurrence) => builders.auditDiagnosisStarted({ ...base, occurrence, details, diagnosisId: "diag_1", errorKind: "task", errorCode: "CHECKS_FAILED", tier: "light" })],
    ["auditDiagnosisProposed", (occurrence) => builders.auditDiagnosisProposed({ ...base, occurrence, details, diagnosisId: "diag_1", counts: { explain: 1, retryWithNote: 1, redirect: 0, settingsChange: 0, newTask: 0, adminSteps: 0, contactSupport: 0 }, dropped: 0 })],
    ["auditDiagnosisProposalRaised", (occurrence) => builders.auditDiagnosisProposalRaised({ ...base, occurrence, details, diagnosisId: "diag_1", proposalKind: "settings_change", approvalId: "appr_1" })],
    ["auditDiagnosisSupportEscalated", (occurrence) => builders.auditDiagnosisSupportEscalated({ ...base, occurrence, details, diagnosisId: "diag_1", errorKind: "task" })],
    ["auditDiagnosisBundlePrepared", (occurrence) => builders.auditDiagnosisBundlePrepared({ ...base, occurrence, details, diagnosisId: "diag_1", errorKind: "task" })],
    // v1.2 learning loop (B7)
    ["auditRuleSuggested", (occurrence) => builders.auditRuleSuggested({ ...base, occurrence, details, projectName: "Secret Project", suggestionId: "sug_1", stage: "build", sourceCount: 2, sourceKinds: "comment,send_back", lessSafe: false, fromOnePerson: false })],
    ["auditRuleAccepted", (occurrence) => builders.auditRuleAccepted({ ...base, occurrence, details, projectName: "Secret Project", suggestionId: "sug_1", ruleId: "rul_1", stage: "build", processAgentId: "agt_1", outcome: "published", processVersion: 4, edited: true, lessSafe: false })],
    ["auditRuleNotApplied", (occurrence) => builders.auditRuleNotApplied({ ...base, occurrence, details, projectName: "Secret Project", suggestionId: "sug_1", ruleId: "rul_1", approvalOutcome: "declined" })],
    ["auditRuleDismissed", (occurrence) => builders.auditRuleDismissed({ ...base, occurrence, details, projectName: "Secret Project", suggestionId: "sug_1", stage: "build", dismissKind: "wrong" })],
    ["auditRuleWithdrawn", (occurrence) => builders.auditRuleWithdrawn({ ...base, occurrence, details, projectName: "Secret Project", suggestionId: "sug_1", stage: "build", cause: "forgotten" })],
    ["auditRuleRolledBack", (occurrence) => builders.auditRuleRolledBack({ ...base, occurrence, details, projectName: "Secret Project", ruleId: "rul_1", processAgentId: "agt_1", processVersion: 5 })],
    ["auditRuleCorrectionRemembered", (occurrence) => builders.auditRuleCorrectionRemembered({ ...base, occurrence, details, projectName: "Secret Project", correctionId: "cor_1", stage: "build", standing: "member", op: "remember" })],
    ["auditProjectLearningChanged", (occurrence) => builders.auditProjectLearningChanged({ ...base, occurrence, details, projectName: "Secret Project", revision: 2, enabled: true, selfConfirmedSoleOwner: false })],
    ["auditRuleSuggestionsSet", (occurrence) => builders.auditRuleSuggestionsSet({ ...base, occurrence, details, setting: "on", previous: "off", source: "company" })],
    ["auditReviewDefaultNoticeDismissed", (occurrence) => builders.auditReviewDefaultNoticeDismissed({ ...base, occurrence, details })],
    // Company domain verification
    ["auditCompanyDomainAdded", (occurrence) => builders.auditCompanyDomainAdded({ ...base, occurrence, details, domain: "acme.example" })],
    ["auditCompanyDomainVerified", (occurrence) => builders.auditCompanyDomainVerified({ ...base, occurrence, details, domain: "acme.example", wasState: "pending", tookOver: false })],
    ["auditCompanyDomainLost", (occurrence) => builders.auditCompanyDomainLost({ ...base, occurrence, details, domain: "acme.example", missingDays: 3 })],
    ["auditCompanyDomainRemoved", (occurrence) => builders.auditCompanyDomainRemoved({ ...base, occurrence, details, domain: "acme.example", wasState: "verified" })],
    // Setup agent website asks (SH12)
    ["auditSetupHostAsked", (occurrence) => builders.auditSetupHostAsked({ ...base, occurrence, details, projectName: "Secret Project", askId: "ask_1", taskId: "task_1", journalN: 4, host: "docs.corp.example", onBehalfOf: "dev_1", typedBy: "dev_2" })],
    ["auditSetupHostRefused", (occurrence) => builders.auditSetupHostRefused({ ...base, occurrence, details, projectName: "Secret Project", askId: "ask_1", refusal: "person", host: "docs.corp.example" })],
    // Setup run limits and company locks (sh-su-musts)
    ["auditSetupLimitsChanged", (occurrence) => builders.auditSetupLimitsChanged({ ...base, occurrence, details, projectName: "Secret Project", revision: 2, previousDigest: "a".repeat(64), nextDigest: "b".repeat(64), limits: { commands: 60, budgetCents: 800 } })],
    ["auditSetupLocksChange", (occurrence) => builders.auditSetupLocksChange({ ...base, occurrence, details, action: "setup.locks_change_approved", revision: 3, previousDigest: "a".repeat(64), nextDigest: "b".repeat(64), loosened: true, approvalMode: "second_person", membershipVersion: 7 })],
    // Tracker people (team record)
    ["auditRecordTrackerPersonMapped", (occurrence) => builders.auditRecordTrackerPersonMapped({ ...base, occurrence, details, memberId: "dev_1", source: "jira" })],
    ["auditRecordTrackerPersonUnmapped", (occurrence) => builders.auditRecordTrackerPersonUnmapped({ ...base, occurrence, details, memberId: "dev_1", source: "linear" })],
    ["auditRecordTrackerAutolinkChanged", (occurrence) => builders.auditRecordTrackerAutolinkChanged({ ...base, occurrence, details, enabled: true })],
    ["auditSetupRecipeChange", (occurrence) => builders.auditSetupRecipeChange({ ...base, occurrence, details, action: "setup_recipe.approved", facts: { recipeId: "rcp_" + "1".repeat(20), revision: 2, bodyDigest: "a".repeat(64), authority: "fresh_sign_in" } })],
    ["auditSavedEnvChanged", (occurrence) => builders.auditSavedEnvChanged({ ...base, occurrence, details, projectName: "Secret Project", change: "build_recorded", cause: "no_image", digest: "sha256:" + "a".repeat(64) })],
    ["auditSavedEnvSettingChanged", (occurrence) => builders.auditSavedEnvSettingChanged({ ...base, occurrence, details, projectName: "Secret Project", enabled: true })],
    ["auditTestAccountChange", (occurrence) => builders.auditTestAccountChange({ ...base, occurrence, details, action: "test_account.approved", accountId: "ta-0000000000000001", facts: { digest: "a".repeat(64), approvalMode: "second_person", approvals: 2, expiresInDays: 90 } })],
    ["auditProjectSetupRestored", (occurrence) => builders.auditProjectSetupRestored({ ...base, occurrence, details, projectName: "Secret Project", revision: 4, fromRevision: 3, provenRevision: 2 })],
  ];

  it("covers every builder the module exports (a new builder needs a case here)", () => {
    const exported = Object.keys(builders).filter((name) => name.startsWith("audit") && name !== "auditOccurrence").sort();
    const covered = [...new Set(cases.map(([name]) => name.replace(/ \(.*\)$/, "")))].sort();
    expect(covered).toStrictEqual(exported);
  });

  for (const [name, make] of cases) {
    describe(name, () => {
      it("gives different ids to two occurrences with identical facts, and the same id to one occurrence twice", () => {
        expect(make("occurrence-1").eventId).toBe(make("occurrence-1").eventId);
        expect(make("occurrence-1").eventId).not.toBe(make("occurrence-2").eventId);
        expect(make("occurrence-1")).toStrictEqual(make("occurrence-1"));
      });

      it("is a valid event", () => {
        const parsed = AuditEventInputSchema.safeParse(make("occurrence-1"));
        expect(parsed.error?.issues).toBeUndefined();
        expect(parsed.success).toBe(true);
      });

      it("keeps names, emails and logins in details (or a name-keyed target) only", () => {
        const event = make("occurrence-1");
        const { details: kept, ...chain } = event;
        const outside = JSON.stringify(chain.target !== undefined && "name" in chain.target ? { ...chain, target: { kind: chain.target.kind } } : chain);
        for (const personal of PERSONAL) expect(outside, personal).not.toContain(personal);
        expect(JSON.stringify(kept)).toContain("Jane Roe");
      });
    });
  }

  it("process events target kind process by the process layer's agent id, and carry the pinned actions", () => {
    const published = builders.auditProcessPublished({ ...base, occurrence: "e1", agentId: "agt_1", version: 2, safety: "safe", selfConfirmedSoleOwner: true });
    expect(published).toMatchObject({ action: "process.published", target: { kind: "process", id: "agt_1" }, facts: { version: 2, safety: "safe", selfConfirmedSoleOwner: true } });
    const rolled = builders.auditProcessRolledBack({ ...base, occurrence: "e1", agentId: "agt_1", fromVersion: 3, toVersion: 2, safety: "safe" });
    expect(rolled).toMatchObject({ action: "process.rolled_back", target: { kind: "process", id: "agt_1" }, facts: { fromVersion: 3, toVersion: 2, safety: "safe" } });
    expect(published.eventId).not.toBe(builders.auditPublished({ ...base, occurrence: "e1", scope: "agent", targetId: "agt_1", version: 2, safety: "safe" }).eventId);
  });

  it("the project playbook events target the project by name and carry only their fixed facts", () => {
    const models = builders.auditProjectModelsChanged({ ...base, occurrence: "p1", projectName: "web", revision: 3, approvedCount: 2, defaultChanged: false });
    expect(models).toMatchObject({ action: "project.models_changed", target: { kind: "project", name: "web" }, facts: { revision: 3, approvedCount: 2, defaultChanged: false } });
    const selection = builders.auditProjectModelSelectionChanged({ ...base, occurrence: "p1", projectName: "web", surface: "cli", cleared: true });
    expect(selection.facts).toStrictEqual({ surface: "cli", cleared: true });
    const company = builders.auditCompanyChangeAppliedToProject({ ...base, occurrence: "p1", projectName: "web", changeRevision: 5, settingCount: 0 });
    expect(company.facts).toStrictEqual({ changeRevision: 5, settingCount: 0 });
  });

  it("the learning events target the project by name, carry only their fixed facts, and an accepted rule differs from one awaiting approval", () => {
    const accepted = (outcome: "published" | "awaiting_approval") => builders.auditRuleAccepted({ ...base, occurrence: "rul_1", projectName: "web", suggestionId: "sug_1", ruleId: "rul_1", stage: "build", processAgentId: "agt_1", outcome, edited: false, lessSafe: true });
    expect(accepted("published")).toMatchObject({ action: "rule.accepted", target: { kind: "project", name: "web" }, facts: { outcome: "published", edited: false, lessSafe: true } });
    expect(accepted("published").facts).not.toHaveProperty("processVersion");
    expect(accepted("published").eventId).not.toBe(accepted("awaiting_approval").eventId);
    const remembered = (op: "remember" | "forget") => builders.auditRuleCorrectionRemembered({ ...base, occurrence: "cor_1", projectName: "web", correctionId: "cor_1", stage: "build", standing: "member", op });
    expect(remembered("remember").eventId).not.toBe(remembered("forget").eventId);
    const notApplied = builders.auditRuleNotApplied({ ...base, occurrence: "rul_1", projectName: "web", suggestionId: "sug_1", ruleId: "rul_1", approvalOutcome: "expired" });
    expect(notApplied.facts).toStrictEqual({ suggestionId: "sug_1", ruleId: "rul_1", approvalOutcome: "expired" });
  });

  it("the setup host events target the project by name, keep the website in the org's details only, and ask and refusal of one ask get different ids", () => {
    const asked = builders.auditSetupHostAsked({ ...base, occurrence: "ask_1", projectName: "web", askId: "ask_1", taskId: "task_1", host: "docs.corp.example", onBehalfOf: "dev_1" });
    expect(asked).toMatchObject({ action: "setup.host_asked", target: { kind: "project", name: "web" }, facts: { askId: "ask_1", taskId: "task_1" } });
    expect(asked.facts).not.toHaveProperty("typedBy");
    expect(asked.details).toContainEqual({ subject: "org", fields: { host: "docs.corp.example", onBehalfOf: "dev_1" } });
    const typed = builders.auditSetupHostAsked({ ...base, occurrence: "ask_1", projectName: "web", askId: "ask_1", taskId: "task_1", host: "docs.corp.example", onBehalfOf: "dev_1", typedBy: "dev_2" });
    expect(typed.details).toContainEqual({ subject: "org", fields: { host: "docs.corp.example", onBehalfOf: "dev_1", typedBy: "dev_2" } });
    const refused = builders.auditSetupHostRefused({ ...base, occurrence: "ask_1", projectName: "web", askId: "ask_1", refusal: "person", host: "docs.corp.example" });
    expect(refused).toMatchObject({ action: "setup.host_refused", target: { kind: "project", name: "web" }, facts: { askId: "ask_1", refusal: "person" } });
    expect(refused.details).toContainEqual({ subject: "org", fields: { host: "docs.corp.example" } });
    for (const event of [asked, typed, refused]) expect(JSON.stringify({ ...event, details: undefined, target: undefined })).not.toContain("docs.corp.example");
    expect(asked.eventId).not.toBe(refused.eventId);
  });

  it("the tracker people events target the member (the switch targets the company), carry only the tool's name and the new state, and a map and an unmap of one request differ", () => {
    const mapped = builders.auditRecordTrackerPersonMapped({ ...base, occurrence: "req_1", memberId: "dev_1", source: "jira" });
    expect(mapped).toMatchObject({ action: "record.tracker_person_mapped", target: { kind: "member", id: "dev_1" }, facts: { source: "jira" } });
    const unmapped = builders.auditRecordTrackerPersonUnmapped({ ...base, occurrence: "req_1", memberId: "dev_1", source: "jira" });
    expect(unmapped).toMatchObject({ action: "record.tracker_person_unmapped", target: { kind: "member", id: "dev_1" }, facts: { source: "jira" } });
    expect(mapped.eventId).not.toBe(unmapped.eventId);
    const on = builders.auditRecordTrackerAutolinkChanged({ ...base, occurrence: "req_2", enabled: true });
    expect(on).toMatchObject({ action: "record.tracker_autolink_changed", target: { kind: "org", id: base.orgId }, facts: { enabled: true } });
    expect(builders.auditRecordTrackerAutolinkChanged({ ...base, occurrence: "req_2", enabled: false }).facts).toStrictEqual({ enabled: false });
  });

  it("the id also depends on the pinned parts: the decision, the terminal status", () => {
    const decided = (decision: string) => builders.auditApprovalDecided({ ...base, occurrence: "apr_1", approvalId: "apr_1", kind: "write", decision, subjectKind: "write" }).eventId;
    expect(decided("approved")).not.toBe(decided("declined"));
    const executed = (status: string) => builders.auditWriteExecuted({ ...base, occurrence: "apr_1", approvalId: "apr_1", connectorType: "linear", tool: "t", status, argumentsHash: "a".repeat(64) }).eventId;
    expect(executed("APPROVED_DONE")).not.toBe(executed("APPROVED_FAILED"));
    const spend = (decision: string) => builders.auditSpendRequestDecided({ ...base, occurrence: "spr_1", spendRequestId: "spr_1", kind: "raise", scopeKind: "member", amountCents: 1, decision }).eventId;
    expect(spend("approved")).not.toBe(spend("declined"));
  });

  it("different actions of one occurrence get different ids", () => {
    const removed = builders.auditMemberRemoved({ ...base, occurrence: "req-1", memberId: "dev_2", role: "member" });
    const left = builders.auditMemberLeft({ ...base, occurrence: "req-1", memberId: "dev_2", role: "member" });
    expect(removed.eventId).not.toBe(left.eventId);
  });

  it("composes several values into one occurrence without letting them run together", () => {
    expect(auditOccurrence("a|b", "c")).not.toBe(auditOccurrence("a", "b|c"));
    expect(auditOccurrence("a", "b")).toBe(auditOccurrence("a", "b"));
    expect(auditOccurrence("x\ny")).not.toContain("\n");
  });

  it("puts a name-keyed target's name in the target and nowhere else", () => {
    const event = builders.auditEgressDecided({ ...base, occurrence: "req-1", domain: "evil.example.org", decision: "approved" });
    expect(event.target).toStrictEqual({ kind: "domain", name: "evil.example.org" });
    expect(JSON.stringify({ ...event, target: undefined })).not.toContain("evil.example.org");
  });
});
