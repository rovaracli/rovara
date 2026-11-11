// Work events (U3): the events commit in the transaction of the change that caused them, once, with a TTL and no content; a change that does not commit leaves none; an event never makes a change fail.
import { randomUUID } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import {
  INDEX_EXPIRY_ATTRIBUTE, WorkEventSchema, blockWorkflow, createWorkflowSnapshot, decideWorkflow, modelKeyKey, submitWorkflowArtifact, workEventExpiresAt, workEventPartition,
  type WorkflowSnapshot,
} from "@agentx/contracts";
import { WORK_EVENT_TRANSACTION_ITEMS_MAX, withWorkEvents, workEventsOfItems, type WorkEventDeps } from "../../packages/broker/src/work-events/emit.js";
import { listWorkEvents, workEventPutItem } from "../../packages/broker/src/work-events/store.js";
import { registerKey, settleKey, type KeyInput, type LedgerDependencies } from "../../packages/broker/src/spend/ledger.js";
import { mintTagsFor } from "../../packages/broker/src/spend/payer.js";
import { keyIdOf } from "../../packages/broker/src/org/budget.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { fakeModelAccess } from "../support/fake-model-access.js";

const taskId = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const ownerId = "a".repeat(64);
const orgId = "org_aaaaaaaaaaaaaaaaaaaa" as const;
const project = "billing-service";
const T0 = "2026-11-10T09:00:00.000Z";
const T1 = "2026-11-10T09:05:00.000Z";
const T2 = "2026-11-10T09:10:00.000Z";
const plan = { id: "plan-v1", type: "plan" as const, version: 1, sha256: "b".repeat(64), producer: "agentx-planner", objectKey: `tasks/${taskId}/plan-v1.json`, createdAt: T0, format: "structured" as const };
const planning = (): WorkflowSnapshot => createWorkflowSnapshot({ taskId, ownerId, now: T0 });
const waiting = (): WorkflowSnapshot => { const p = planning(); return submitWorkflowArtifact(p, { expectedRevision: p.revision, artifact: plan, now: T1 }); };
/** The decision as the route stores it: `decideWorkflow` readies the coding step, and the route starts it (revision + 1, RUNNING) in the same write. */
const approved = (): WorkflowSnapshot => { const decided = decideWorkflow(waiting(), {
  requestId: "d532a6e0-3de1-44e3-a6d2-e8c635d77f2b", expectedRevision: waiting().revision, decision: "APPROVE", artifactDigest: plan.sha256, reason: "Looks right.", answers: [],
}, { actorId: ownerId, role: "TASK_OWNER" }, { now: T2, allowedSkipStages: [], via: "PAGE" }); return { ...decided, revision: decided.revision + 1, state: "RUNNING", updatedAt: T2 }; };

const taskKey = { pk: `DEVTASK#${taskId}`, sk: "META" } as const;
/** The Update every workflow writer sends: it moves the task's workflow from a revision to the next snapshot, conditional on that revision. */
const moveWorkflow = (next: WorkflowSnapshot, expectedRevision: number) => ({ Update: {
  TableName: "state", Key: taskKey, UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
  ConditionExpression: "workflow.revision = :revision AND attribute_not_exists(closedAt)",
  ExpressionAttributeValues: { ":workflow": next, ":now": next.updatedAt, ":revision": expectedRevision },
} });

function world(options: { on?: boolean; stored?: WorkflowSnapshot } = {}) {
  const db = new FakeDynamoDb();
  const logs: Array<Record<string, unknown>> = [];
  db.set({ ...taskKey, entityType: "DEVELOPER_TASK", taskId, orgId, project, developerId: ownerId, client: "web", workflow: options.stored ?? waiting() });
  const deps: WorkEventDeps = { documentClient: db, tableName: "state", ...(options.on === false ? {} : { workEvents: { log: (entry: Record<string, unknown>) => { logs.push(entry); } } }) };
  const send = async (items: Parameters<typeof withWorkEvents>[1]) => db.send(new TransactWriteCommand({ TransactItems: await withWorkEvents(deps, items) }));
  const rows = () => db.find((item) => item.entityType === "WORK_EVENT").sort((a, b) => String(a.sk).localeCompare(String(b.sk)));
  return { db, deps, send, logs, rows };
}

describe("an event commits with its change", () => {
  it("writes the decision's events with the move of the workflow, each exactly once, in the company's month partition, with the TTL", async () => {
    const w = world();
    await w.send([moveWorkflow(approved(), waiting().revision)]);
    const rows = w.rows();
    expect(rows.map((row) => row.kind).sort()).toEqual(["decision_answered", "plan_approved", "step_started", "waiting_changed"]);
    for (const row of rows) {
      expect(row.pk).toBe(workEventPartition(orgId, "2026-11"));
      expect(row[INDEX_EXPIRY_ATTRIBUTE]).toBe(workEventExpiresAt(String(row.at)));
      expect(row).toMatchObject({ version: 1, orgId, project, taskId });
    }
    // The workflow itself moved in the same transaction.
    expect((w.db.get(taskKey)?.workflow as WorkflowSnapshot).stage).toBe("IMPLEMENT");
    // The TTL is 13 months after the month: 1 January 2028 for November 2026.
    expect(new Date(Number(rows[0]![INDEX_EXPIRY_ATTRIBUTE]) * 1000).toISOString()).toBe("2028-01-01T00:00:00.000Z");
  });

  it("writes exactly one event for one fact: a repeat of the same change writes the same rows, not more", async () => {
    const w = world();
    await w.send([moveWorkflow(approved(), waiting().revision)]);
    const first = w.rows().map((row) => row.sk);
    // Replay (e.g. a re-sent request): the stored workflow is put back at the earlier state, and the identical change is committed again.
    w.db.set({ ...taskKey, entityType: "DEVELOPER_TASK", taskId, orgId, project, workflow: waiting() });
    await w.send([moveWorkflow(approved(), waiting().revision)]);
    expect(w.rows().map((row) => row.sk)).toEqual(first);
  });

  it("holds no content: only the contract's fields, whatever the task and the workflow carry", async () => {
    const w = world();
    const noisy = { ...approved(), blockReason: "please rename secretThing, mail bob@example.com" } as WorkflowSnapshot;
    await w.send([moveWorkflow(noisy, waiting().revision)]);
    const text = JSON.stringify(w.rows());
    expect(text).not.toMatch(/secretThing|bob@example|Looks right|billing-service-notes/u);
    for (const row of w.rows()) {
      const event = Object.fromEntries(Object.entries(row).filter(([name]) => !["pk", "sk", "entityType", INDEX_EXPIRY_ATTRIBUTE].includes(name)));
      expect(WorkEventSchema.safeParse(event).success).toBe(true);
    }
  });

  it("writes the task_started event with the task's first transaction", async () => {
    const w = world();
    const fresh = randomUUID();
    const start = planning();
    await w.send([{ Put: { TableName: "state", Item: { pk: `DEVTASK#${fresh}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: fresh, orgId, project, client: "web", workflow: { ...start, taskId: fresh } }, ConditionExpression: "attribute_not_exists(pk)" } }]);
    const rows = w.rows().filter((row) => row.taskId === fresh);
    expect(rows.map((row) => row.kind).sort()).toEqual(["step_started", "task_started", "waiting_changed"]);
    expect(rows.find((row) => row.kind === "task_started")).toMatchObject({ origin: "web", path: "QUICK", actor: { kind: "person", personId: ownerId } });
  });

  it("writes the failure's events with the block", async () => {
    const w = world({ stored: approved() });
    await w.send([moveWorkflow(blockWorkflow(approved(), "The checks failed.", "2026-11-10T10:00:00.000Z"), approved().revision)]);
    expect(w.rows().map((row) => row.kind).sort()).toEqual(["step_ended", "task_failed", "waiting_changed"]);
  });
});

describe("a change that does not commit leaves no event", () => {
  it("emits nothing when the source write fails its condition", async () => {
    const w = world({ stored: waiting() });
    // The change is conditional on revision 2, but the task has moved to revision 3 before it commits: the read happens first, and the transaction is refused whole.
    w.db.set({ ...taskKey, entityType: "DEVELOPER_TASK", taskId, orgId, project, workflow: { ...waiting(), revision: 3 }, closedAt: T2 });
    await expect(w.send([moveWorkflow(approved(), waiting().revision)])).rejects.toMatchObject({ name: "TransactionCanceledException" });
    expect(w.rows()).toEqual([]);
  });

  it("emits nothing when a sibling item of the transaction fails, and the workflow stays as it was", async () => {
    const w = world();
    await expect(w.send([
      moveWorkflow(approved(), waiting().revision),
      { ConditionCheck: { TableName: "state", Key: { pk: "NOPE", sk: "NOPE" }, ConditionExpression: "attribute_exists(pk)" } },
    ])).rejects.toMatchObject({ name: "TransactionCanceledException" });
    expect(w.rows()).toEqual([]);
    expect((w.db.get(taskKey)?.workflow as WorkflowSnapshot).stage).toBe("PLAN_REVIEW");
  });

  it("describes no transition when the revision the change expects is not the revision read (a lost race is not an event)", async () => {
    const w = world();
    expect(await workEventsOfItems(w.deps, [moveWorkflow(approved(), waiting().revision + 4)])).toEqual([]);
    expect(await workEventsOfItems(w.deps, [moveWorkflow(approved(), waiting().revision)])).not.toEqual([]);
  });
});

describe("an event never makes a change fail", () => {
  it("returns the items as they came when the install has work events off, without reading anything", async () => {
    const w = world({ on: false });
    const items = [moveWorkflow(approved(), waiting().revision)];
    expect(await withWorkEvents(w.deps, items)).toBe(items);
    expect(w.db.commandNames()).toEqual([]);
    await w.send(items);
    expect(w.rows()).toEqual([]);
  });

  it("returns the items as they came, with a log line, when the read of the task fails", async () => {
    const w = world();
    w.db.injectFault({ command: "GetCommand", error: { name: "ProvisionedThroughputExceededException" } });
    const items = [moveWorkflow(approved(), waiting().revision)];
    expect(await withWorkEvents(w.deps, items)).toEqual(items);
    expect(w.logs).toEqual([{ event: "work_event.skipped", reason: "derive_failed", error: "ProvisionedThroughputExceededException" }]);
    // The change itself still commits.
    await w.send(items);
    expect((w.db.get(taskKey)?.workflow as WorkflowSnapshot).stage).toBe("IMPLEMENT");
  });

  it("leaves a transaction that is already too full as it is", async () => {
    const w = world();
    const filler = Array.from({ length: WORK_EVENT_TRANSACTION_ITEMS_MAX - 1 }, (_, index) => ({ Put: { TableName: "state", Item: { pk: `FILL#${String(index)}`, sk: "X" } } }));
    const items = [moveWorkflow(approved(), waiting().revision), ...filler];
    expect(await withWorkEvents(w.deps, items)).toBe(items);
    expect(w.logs).toMatchObject([{ event: "work_event.skipped", reason: "transaction_full" }]);
  });

  it("puts no condition on an event row, so a row that is already there can never refuse the change", async () => {
    const item = workEventPutItem("state", { version: 1, id: `wev_${"a".repeat(32)}`, kind: "task_failed", at: T0, orgId, project, taskId, actor: { kind: "system" }, reason: "blocked_plan" });
    expect(item.Put).not.toHaveProperty("ConditionExpression");
  });

  it("does not touch items that are not a task's workflow", async () => {
    const w = world();
    const other = { Update: { TableName: "state", Key: { pk: "X", sk: "Y" }, UpdateExpression: "SET a = :a", ExpressionAttributeValues: { ":a": 1 } } };
    expect(await withWorkEvents(w.deps, [other])).toEqual([other]);
    expect(w.db.commandNames()).toEqual([]);
  });
});

describe("the read for the Insights lane", () => {
  it("lists a company's events in a range by kind and task, oldest first, and never another company's", async () => {
    const w = world();
    await w.send([moveWorkflow(approved(), waiting().revision)]);
    const range = { orgId, from: "2026-11-01T00:00:00.000Z", to: "2026-11-30T23:59:59.999Z" } as const;
    const all = await listWorkEvents(w.deps, range);
    expect(all.unreadable).toBe(0);
    expect(all.events.map((event) => event.kind).sort()).toEqual(["decision_answered", "plan_approved", "step_started", "waiting_changed"]);
    expect((await listWorkEvents(w.deps, { ...range, kinds: ["plan_approved"] })).events).toHaveLength(1);
    expect((await listWorkEvents(w.deps, { ...range, taskId: randomUUID() })).events).toEqual([]);
    expect((await listWorkEvents(w.deps, { ...range, orgId: "org_bbbbbbbbbbbbbbbbbbbb" })).events).toEqual([]);
    expect((await listWorkEvents(w.deps, { ...range, from: "2026-12-01T00:00:00.000Z", to: "2026-12-31T00:00:00.000Z" })).events).toEqual([]);
  });
});

describe("cost settled", () => {
  const MONTH = "2026-11";
  const clock = Date.parse("2026-11-10T12:00:00.000Z");
  const setup = (on: boolean) => {
    const db = new FakeDynamoDb();
    const access = fakeModelAccess();
    const deps = (): LedgerDependencies => ({ documentClient: db, tableName: "state", access, now: () => clock, ...(on ? { workEvents: {} } : {}) });
    const secret = "sk-ledger-key-0001";
    const input = (extra: Partial<KeyInput> = {}): KeyInput => ({
      orgId, month: MONTH, keyId: keyIdOf(secret), capUsd: 5, scopes: [{ key: { kind: "org" } }],
      tags: mintTagsFor({ payer: { kind: "member", developerId: ownerId }, place: { project }, agentId: "agt_aaaaaaaaaaaaaaaaaaaaaaaa", origin: "app", taskId, operationId: "op-1" }),
      model: "claude-sonnet-4-6", expiresAt: clock + 3_600_000, ...extra,
    });
    const rows = () => db.find((item) => item.entityType === "WORK_EVENT");
    return { db, access, deps, secret, input, rows };
  };

  it("writes one event with the settlement, in whole micro-dollars, and none for a settle that adds nothing", async () => {
    const t = setup(true);
    const key = t.input();
    await registerKey(t.deps(), key);
    t.access.setKeySpent(t.secret, 1.2);
    await settleKey(t.deps(), orgId, key.keyId);
    expect(t.rows()).toHaveLength(1);
    expect(t.rows()[0]).toMatchObject({ kind: "cost_settled", micros: 1_200_000, currency: "USD", orgId, project, taskId, actor: { kind: "system" } });
    expect(t.rows()[0]![INDEX_EXPIRY_ATTRIBUTE]).toBe(workEventExpiresAt(String(t.rows()[0]!.at)));
    await settleKey(t.deps(), orgId, key.keyId);
    expect(t.rows()).toHaveLength(1);
    t.access.setKeySpent(t.secret, 2);
    await settleKey(t.deps(), orgId, key.keyId);
    expect(t.rows().map((row) => Number(row.micros)).sort((a, b) => a - b)).toEqual([800_000, 1_200_000]);
  });

  it("writes nothing when the install has work events off, and nothing for spend with no task", async () => {
    const off = setup(false);
    await registerKey(off.deps(), off.input());
    off.access.setKeySpent(off.secret, 1);
    await settleKey(off.deps(), orgId, off.input().keyId);
    expect(off.rows()).toEqual([]);
    const noTask = setup(true);
    const key = noTask.input({ tags: mintTagsFor({ payer: { kind: "member", developerId: ownerId }, place: { project }, agentId: "agt_aaaaaaaaaaaaaaaaaaaaaaaa", origin: "app" }) });
    await registerKey(noTask.deps(), key);
    noTask.access.setKeySpent(noTask.secret, 1);
    await settleKey(noTask.deps(), orgId, key.keyId);
    expect(noTask.rows()).toEqual([]);
    expect(noTask.db.get(modelKeyKey(orgId, key.keyId))).toBeDefined();
  });

  it("writes none when the settle loses its race (another settler counted first): the transaction is refused whole", async () => {
    const t = setup(true);
    const key = t.input();
    await registerKey(t.deps(), key);
    t.access.setKeySpent(t.secret, 1.2);
    // The record already counts this amount, so the settle sees nothing new and writes nothing at all.
    t.db.set({ ...t.db.get(modelKeyKey(orgId, key.keyId)), pk: modelKeyKey(orgId, key.keyId).pk, sk: modelKeyKey(orgId, key.keyId).sk, settledUsd: 1.2 });
    await settleKey(t.deps(), orgId, key.keyId);
    expect(t.rows()).toEqual([]);
  });
});
