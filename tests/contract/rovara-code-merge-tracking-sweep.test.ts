// Rovara Code (Plan 6 Task 14): the tracking rows of the merge-recovery sweep. A Rovara Code task's recovery row becomes its tracking row, with its own due partition, its
// own 60-second gate and its own 25-row page; a webhook wakes it with two writes; the existing merge pass (5 minutes, 10 rows) is neither slowed nor starved by it.
import { TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import {
  TRACKING_DUE_PK,
  mergeRecoveryItem,
  runDueWorkflowMergeRecovery,
  runDueWorkflowMergeTracking,
  trackingRecoveryItem,
  wakeTrackingRow,
  type GithubMergeReadBudget,
  type MergeRecoveryDependencies,
  type MergeRecoveryResult,
} from "../../packages/broker/src/aws/workflow-merge-recovery.js";
import { TRACKING_COALESCE_SECONDS, TRACKING_GATE_SECONDS, TRACKING_HEARTBEAT_MINUTES, TRACKING_MAX_ROWS } from "@rovara-code/contracts";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const TABLE = "state";
const RECOVERY_PK = "WORKFLOW_MERGE_RECOVERY";
const SWEEP_PK = "WORKFLOW_MERGE_SWEEP";
const GATE = TRACKING_GATE_SECONDS * 1_000;
const COALESCE = TRACKING_COALESCE_SECONDS * 1_000;
const HEARTBEAT = TRACKING_HEARTBEAT_MINUTES * 60_000;
const FIVE_MINUTES = 5 * 60_000;

const uuid = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const taskRecord = (taskId: string): Record<string, unknown> => ({ pk: `DEVTASK#${taskId}`, sk: "META", entityType: "DEVELOPER_TASK", taskId, workspaceId: `workspace-${taskId}` });
const rowOf = (db: FakeDynamoDb, taskId: string) => db.get(RECOVERY_PK, `TASK#${taskId}`)!;

function harness(options: { reconcile?: (taskId: string, budget: GithubMergeReadBudget) => Promise<MergeRecoveryResult> } = {}) {
  const db = new FakeDynamoDb();
  let now = Date.parse("2026-10-25T12:00:00.000Z");
  const commands: unknown[] = [];
  const reconcile = vi.fn(options.reconcile ?? (async () => ({ kind: "OBSERVED" } as const)));
  const dependencies: MergeRecoveryDependencies = {
    documentClient: { send: async (command: unknown) => { commands.push(command); return db.send(command as never); } },
    tableName: TABLE, now: () => now, reconcile,
  };
  return { db, commands, reconcile, dependencies, now: () => now, setNow: (value: number) => { now = value; } };
}

async function enrollTracking(db: FakeDynamoDb, taskId: string, at: number): Promise<void> {
  db.set(taskRecord(taskId));
  await db.send(new TransactWriteCommand({ TransactItems: [trackingRecoveryItem(TABLE, taskId, new Date(at).toISOString())] }));
}

async function enrollMerge(db: FakeDynamoDb, taskId: string, at: number): Promise<void> {
  db.set(taskRecord(taskId));
  await db.send(new TransactWriteCommand({ TransactItems: [mergeRecoveryItem(TABLE, taskId, new Date(at).toISOString())] }));
}

describe("a tracking row", () => {
  it("is the task's recovery row with kind tracking in its own due partition", async () => {
    const h = harness();
    await enrollTracking(h.db, uuid(1), h.now());
    expect(rowOf(h.db, uuid(1))).toMatchObject({ kind: "tracking", dispatchDuePk: TRACKING_DUE_PK, entityType: RECOVERY_PK, attempts: 0 });
    expect(TRACKING_DUE_PK).toBe("WORKFLOW_MERGE_TRACKING");
  });

  it("is what a kind-less row becomes, keeping its attempts and lease, and is not turned back by the old enrolment", async () => {
    const h = harness();
    await enrollMerge(h.db, uuid(1), h.now());
    await h.db.send(new UpdateCommand({ TableName: TABLE, Key: { pk: RECOVERY_PK, sk: `TASK#${uuid(1)}` }, UpdateExpression: "SET attempts = :a, leaseToken = :t, leaseExpiresAt = :l", ExpressionAttributeValues: { ":a": 2, ":t": "lease", ":l": h.now() + 5_000 } }));
    await h.db.send(new TransactWriteCommand({ TransactItems: [trackingRecoveryItem(TABLE, uuid(1), new Date(h.now()).toISOString())] }));
    expect(rowOf(h.db, uuid(1))).toMatchObject({ kind: "tracking", dispatchDuePk: TRACKING_DUE_PK, attempts: 2, leaseToken: "lease" });
    await h.db.send(new TransactWriteCommand({ TransactItems: [mergeRecoveryItem(TABLE, uuid(1), new Date(h.now()).toISOString())] }));
    expect(rowOf(h.db, uuid(1))).toMatchObject({ kind: "tracking", dispatchDuePk: TRACKING_DUE_PK });
  });

  it("is read by the tracking pass only, and a kind-less row only by the merge pass", async () => {
    const h = harness();
    await enrollTracking(h.db, uuid(1), h.now() - 1_000);
    await enrollMerge(h.db, uuid(2), h.now() - 1_000);
    expect(await runDueWorkflowMergeRecovery(h.dependencies)).toEqual({ attempted: 1, reconciled: 1, deferred: 0 });
    expect(h.reconcile.mock.calls.map(([taskId]) => taskId)).toEqual([uuid(2)]);
    expect(await runDueWorkflowMergeTracking(h.dependencies)).toEqual({ attempted: 1, reconciled: 1, deferred: 0 });
    expect(h.reconcile.mock.calls.map(([taskId]) => taskId)).toEqual([uuid(2), uuid(1)]);
  });

  it("keeps its due partition when it is settled (a kind it was not read as is never written back)", async () => {
    const h = harness();
    await enrollTracking(h.db, uuid(1), h.now() - 1_000);
    await runDueWorkflowMergeTracking(h.dependencies);
    expect(rowOf(h.db, uuid(1))).toMatchObject({ kind: "tracking", dispatchDuePk: TRACKING_DUE_PK });
  });

  it("is left to the tracking pass when it was converted between the merge pass's query and its read", async () => {
    const h = harness();
    await enrollMerge(h.db, uuid(1), h.now() - 1_000);
    const stale = structuredClone(rowOf(h.db, uuid(1)));
    await enrollTracking(h.db, uuid(1), h.now() - 1_000);
    expect(rowOf(h.db, uuid(1)).kind).toBe("tracking");
    // The merge pass's query still shows the row as it was in the merge partition.
    const original = h.dependencies.documentClient;
    h.dependencies.documentClient = { send: async (command: unknown) => {
      if ((command as { constructor: { name: string } }).constructor.name === "QueryCommand") return { Items: [stale] };
      return original.send(command);
    } };
    expect(await runDueWorkflowMergeRecovery(h.dependencies)).toEqual({ attempted: 0, reconciled: 0, deferred: 0 });
    expect(h.reconcile).not.toHaveBeenCalled();
  });

  it("is refused as malformed when its partition does not match its kind, and is then quarantined, never reconciled", async () => {
    const h = harness();
    await enrollTracking(h.db, uuid(1), h.now() - 1_000);
    await h.db.send(new UpdateCommand({ TableName: TABLE, Key: { pk: RECOVERY_PK, sk: `TASK#${uuid(1)}` }, UpdateExpression: "SET dispatchDuePk = :p", ExpressionAttributeValues: { ":p": RECOVERY_PK } }));
    await runDueWorkflowMergeRecovery(h.dependencies);
    expect(h.reconcile).not.toHaveBeenCalled();
    // The row now sits in the merge partition as kind tracking: that is not a row either pass accepts.
    expect(rowOf(h.db, uuid(1))).toMatchObject({ recoveryStatus: "QUARANTINED", recoveryErrorClass: "MALFORMED_DISCOVERY" });
  });
});

describe("the tracking pass", () => {
  it("opens its own gate every 60 seconds, apart from the merge pass's 5 minutes", async () => {
    const h = harness();
    await enrollTracking(h.db, uuid(1), h.now() - 1);
    await enrollMerge(h.db, uuid(2), h.now() - 1);
    expect((await runDueWorkflowMergeTracking(h.dependencies)).attempted).toBe(1);
    // The gate opens 5 seconds before its 60 are up, so a schedule that fires a few milliseconds early is not refused for a whole minute.
    h.setNow(h.now() + GATE - 5_000 - 1);
    await enrollTracking(h.db, uuid(3), h.now() - 1);
    expect((await runDueWorkflowMergeTracking(h.dependencies)).attempted).toBe(0);
    h.setNow(h.now() + 1);
    expect((await runDueWorkflowMergeTracking(h.dependencies)).attempted).toBe(1);
    expect(h.db.get(SWEEP_PK, "TRACKING")).toMatchObject({ nextSweepAt: h.now() + GATE - 5_000 });
    // The merge pass was not opened by any of that, and still opens on its own gate.
    expect((await runDueWorkflowMergeRecovery(h.dependencies)).attempted).toBe(1);
    expect(h.db.get(SWEEP_PK, "META")).toMatchObject({ nextSweepAt: h.now() + FIVE_MINUTES });
  });

  it("takes at most 25 rows a pass, oldest due first, and the merge pass its own 10", async () => {
    const h = harness();
    for (let index = 1; index <= 30; index += 1) await enrollTracking(h.db, uuid(index), h.now() - (100 - index) * 1_000);
    for (let index = 31; index <= 45; index += 1) await enrollMerge(h.db, uuid(index), h.now() - 1_000);
    const merge = await runDueWorkflowMergeRecovery(h.dependencies);
    const tracking = await runDueWorkflowMergeTracking(h.dependencies);
    expect(TRACKING_MAX_ROWS).toBe(25);
    expect(merge.attempted).toBe(10);
    expect(tracking.attempted).toBe(25);
    const tracked = h.reconcile.mock.calls.map(([taskId]) => taskId ?? "").filter((taskId) => Number(taskId.slice(-12)) <= 30);
    expect(tracked).toEqual(Array.from({ length: 25 }, (_, index) => uuid(index + 1)));
    h.setNow(h.now() + GATE);
    expect((await runDueWorkflowMergeTracking(h.dependencies)).attempted).toBe(5);
  });

  it("settles an observed row for the 15-minute heartbeat, or sooner when the pass says when it must look again", async () => {
    const h = harness({ reconcile: async (taskId) => taskId === uuid(2) ? { kind: "OBSERVED", nextAt: h.now() + 2 * GATE } : { kind: "OBSERVED" } });
    await enrollTracking(h.db, uuid(1), h.now() - 1);
    await enrollTracking(h.db, uuid(2), h.now() - 1);
    await runDueWorkflowMergeTracking(h.dependencies);
    expect(rowOf(h.db, uuid(1))).toMatchObject({ nextAttemptAt: h.now() + HEARTBEAT, attempts: 0 });
    expect(rowOf(h.db, uuid(2))).toMatchObject({ nextAttemptAt: h.now() + 2 * GATE });
    for (const taskId of [uuid(1), uuid(2)]) expect(rowOf(h.db, taskId).dispatchDueSk).toBe(`${new Date(rowOf(h.db, taskId).nextAttemptAt as number).toISOString()}#${taskId}`);
  });

  it("never settles a hint earlier than the next gate or later than the heartbeat", async () => {
    const h = harness({ reconcile: async (taskId) => ({ kind: "OBSERVED", nextAt: taskId === uuid(1) ? h.now() + 1 : h.now() + 10 * HEARTBEAT }) });
    await enrollTracking(h.db, uuid(1), h.now() - 1);
    await enrollTracking(h.db, uuid(2), h.now() - 1);
    await runDueWorkflowMergeTracking(h.dependencies);
    expect(rowOf(h.db, uuid(1)).nextAttemptAt).toBe(h.now() + GATE);
    expect(rowOf(h.db, uuid(2)).nextAttemptAt).toBe(h.now() + HEARTBEAT);
  });

  it("retries a failing row after one gate, then two, never past the heartbeat, and keeps it", async () => {
    const h = harness({ reconcile: async () => ({ kind: "RETRY", retryAt: h.now(), scope: "task" }) });
    await enrollTracking(h.db, uuid(1), h.now() - 1);
    const delays: number[] = [];
    for (let round = 0; round < 20; round += 1) {
      const before = h.now();
      await runDueWorkflowMergeTracking(h.dependencies);
      const row = rowOf(h.db, uuid(1));
      delays.push((row.nextAttemptAt as number) - before);
      h.setNow(row.nextAttemptAt as number);
    }
    expect(delays.slice(0, 3)).toEqual([GATE, 2 * GATE, 3 * GATE]);
    expect(Math.max(...delays)).toBe(HEARTBEAT);
    expect(rowOf(h.db, uuid(1))).not.toHaveProperty("recoveryStatus");
  });

  it("retires a finished task's row and quarantines a missing task's", async () => {
    const h = harness({ reconcile: async (taskId) => taskId === uuid(1) ? { kind: "MISSING" } : { kind: "TERMINAL", release: "confirmed" } });
    await enrollTracking(h.db, uuid(1), h.now() - 1);
    await enrollTracking(h.db, uuid(2), h.now() - 1);
    h.db.set({ pk: `WORKSPACE#workspace-${uuid(2)}`, sk: "META", status: "CLOSED" });
    h.db.set({ ...taskRecord(uuid(2)), releasedAt: "2026-10-25T11:00:00.000Z" });
    await runDueWorkflowMergeTracking(h.dependencies);
    expect(rowOf(h.db, uuid(1))).toMatchObject({ recoveryStatus: "QUARANTINED", recoveryErrorClass: "RECONCILE_MISSING" });
    expect(rowOf(h.db, uuid(2))).toMatchObject({ recoveryStatus: "RETIRED" });
    expect(rowOf(h.db, uuid(2))).not.toHaveProperty("dispatchDuePk");
  });

  it("shares GitHub's rate limit with the merge pass in both directions", async () => {
    const h = harness({ reconcile: async () => ({ kind: "RETRY", retryAt: h.now() + 10 * 60_000, scope: "github-global" }) });
    await enrollTracking(h.db, uuid(1), h.now() - 1);
    await enrollMerge(h.db, uuid(2), h.now() - 1);
    await runDueWorkflowMergeTracking(h.dependencies);
    expect(h.db.get(SWEEP_PK, "META")).toMatchObject({ rateLimitedUntil: h.now() + 10 * 60_000 });
    // The merge pass is refused while GitHub is limited, though its own gate is open.
    h.reconcile.mockClear();
    expect(await runDueWorkflowMergeRecovery(h.dependencies)).toEqual({ attempted: 0, reconciled: 0, deferred: 0 });
    expect(h.reconcile).not.toHaveBeenCalled();
    h.setNow(h.now() + 10 * 60_000);
    expect((await runDueWorkflowMergeRecovery(h.dependencies)).attempted).toBe(1);

    // And the other way round: a limit the merge pass met stops the tracking pass.
    const other = harness({ reconcile: async () => ({ kind: "RETRY", retryAt: other.now() + 10 * 60_000, scope: "github-global" }) });
    await enrollMerge(other.db, uuid(1), other.now() - 1);
    await enrollTracking(other.db, uuid(2), other.now() - 1);
    await runDueWorkflowMergeRecovery(other.dependencies);
    other.reconcile.mockClear();
    other.setNow(other.now() + GATE);
    expect(await runDueWorkflowMergeTracking(other.dependencies)).toEqual({ attempted: 0, reconciled: 0, deferred: 0 });
    expect(other.reconcile).not.toHaveBeenCalled();
  });

  it("gives a tracking pass the time budget it is given and stops starting rows when it is spent", async () => {
    const h = harness({ reconcile: async () => { h.setNow(h.now() + 4_000); return { kind: "OBSERVED" }; } });
    for (let index = 1; index <= 10; index += 1) await enrollTracking(h.db, uuid(index), h.now() - 1_000);
    const result = await runDueWorkflowMergeTracking(h.dependencies, { budgetMs: 10_000 });
    expect(result.attempted).toBeLessThan(10);
    expect(result.attempted).toBeGreaterThan(0);
  });
});

describe("a webhook wakes a tracking row", () => {
  it("sets wakeAt and brings the row forward to now plus 30 seconds, due time and key together", async () => {
    const h = harness();
    await enrollTracking(h.db, uuid(1), h.now() - 1);
    await runDueWorkflowMergeTracking(h.dependencies);
    expect(rowOf(h.db, uuid(1)).nextAttemptAt).toBe(h.now() + HEARTBEAT);
    h.setNow(h.now() + 10_000);
    expect(await wakeTrackingRow(h.dependencies, uuid(1))).toBe("woken");
    const row = rowOf(h.db, uuid(1));
    expect(row).toMatchObject({ wakeAt: h.now(), nextAttemptAt: h.now() + COALESCE });
    expect(row.dispatchDueSk).toBe(`${new Date(h.now() + COALESCE).toISOString()}#${uuid(1)}`);
    expect(row.dispatchDuePk).toBe(TRACKING_DUE_PK);
  });

  it("never pushes an earlier time later, however many deliveries arrive", async () => {
    const h = harness();
    await enrollTracking(h.db, uuid(1), h.now() - 1);
    await runDueWorkflowMergeTracking(h.dependencies);
    await wakeTrackingRow(h.dependencies, uuid(1));
    const first = rowOf(h.db, uuid(1)).nextAttemptAt as number;
    for (let delivery = 1; delivery <= 20; delivery += 1) {
      h.setNow(h.now() + 100);
      await wakeTrackingRow(h.dependencies, uuid(1));
      expect(rowOf(h.db, uuid(1)).nextAttemptAt).toBe(first);
    }
    expect(rowOf(h.db, uuid(1)).wakeAt).toBe(h.now());
  });

  it("leaves a row that is due sooner than the wake alone, and creates no row for a task that has none", async () => {
    const h = harness();
    await enrollTracking(h.db, uuid(1), h.now() + 5_000);
    await wakeTrackingRow(h.dependencies, uuid(1));
    expect(rowOf(h.db, uuid(1)).nextAttemptAt).toBe(h.now() + 5_000);
    expect(await wakeTrackingRow(h.dependencies, uuid(9))).toBe("none");
    expect(h.db.get(RECOVERY_PK, `TASK#${uuid(9)}`)).toBeUndefined();
  });

  it("touches nothing of a kind-less merge row (version 1 tasks keep today's behaviour)", async () => {
    const h = harness();
    await enrollMerge(h.db, uuid(1), h.now() + HEARTBEAT);
    const before = structuredClone(rowOf(h.db, uuid(1)));
    expect(await wakeTrackingRow(h.dependencies, uuid(1))).toBe("none");
    expect(rowOf(h.db, uuid(1))).toEqual(before);
  });

  it("is not lost during a lease: wakeAt lands, the lease stands, and the pass settles the row for the wake", async () => {
    let wokenDuring: string | undefined;
    const h = harness({ reconcile: async (taskId) => { h.setNow(h.now() + 5_000); wokenDuring = await wakeTrackingRow(h.dependencies, taskId); return { kind: "OBSERVED" }; } });
    await enrollTracking(h.db, uuid(1), h.now() - 1);
    const claimedAt = h.now();
    await runDueWorkflowMergeTracking(h.dependencies);
    expect(wokenDuring).toBe("woken");
    const row = rowOf(h.db, uuid(1));
    expect(row.wakeAt).toBe(claimedAt + 5_000);
    // Settled for the wake (30 seconds after it), not for the 15-minute heartbeat.
    expect(row.nextAttemptAt).toBe(claimedAt + 5_000 + COALESCE);
    expect(row.dispatchDueSk).toBe(`${new Date(claimedAt + 5_000 + COALESCE).toISOString()}#${uuid(1)}`);
    expect(row).not.toHaveProperty("leaseToken");
  });

  it("does not honour a wake that came before the pass claimed the row (its read already had it)", async () => {
    const h = harness();
    await enrollTracking(h.db, uuid(1), h.now() - 1);
    await h.db.send(new UpdateCommand({ TableName: TABLE, Key: { pk: RECOVERY_PK, sk: `TASK#${uuid(1)}` }, UpdateExpression: "SET wakeAt = :w", ExpressionAttributeValues: { ":w": h.now() - 500 } }));
    await runDueWorkflowMergeTracking(h.dependencies);
    expect(rowOf(h.db, uuid(1)).nextAttemptAt).toBe(h.now() + HEARTBEAT);
  });

  it("is never quarantined: a woken row is a valid row", async () => {
    const h = harness();
    await enrollTracking(h.db, uuid(1), h.now() - 1);
    await runDueWorkflowMergeTracking(h.dependencies);
    for (let round = 0; round < 3; round += 1) {
      h.setNow(h.now() + GATE);
      await wakeTrackingRow(h.dependencies, uuid(1));
      h.setNow(h.now() + COALESCE + GATE);
      await runDueWorkflowMergeTracking(h.dependencies);
    }
    expect(rowOf(h.db, uuid(1))).not.toHaveProperty("recoveryStatus");
    expect(h.reconcile).toHaveBeenCalledTimes(4);
  });

  it("tracks a woken task within two passes among 50 waiting tasks of three organizations, and touches no other", async () => {
    const h = harness();
    for (let index = 1; index <= 50; index += 1) await enrollTracking(h.db, uuid(index), h.now() - 1);
    // Three passes settle all 50 rows to their heartbeat (25 a pass), then everything waits.
    await runDueWorkflowMergeTracking(h.dependencies);
    h.setNow(h.now() + GATE);
    await runDueWorkflowMergeTracking(h.dependencies);
    h.setNow(h.now() + GATE);
    expect(await runDueWorkflowMergeTracking(h.dependencies)).toEqual({ attempted: 0, reconciled: 0, deferred: 0 });
    h.reconcile.mockClear();
    // Task 37 (the third organization's) is woken by a check_run delivery.
    await wakeTrackingRow(h.dependencies, uuid(37));
    h.setNow(h.now() + COALESCE);
    const first = await runDueWorkflowMergeTracking(h.dependencies);
    h.setNow(h.now() + GATE);
    const second = await runDueWorkflowMergeTracking(h.dependencies);
    expect(first.attempted + second.attempted).toBe(1);
    expect(h.reconcile.mock.calls.map(([taskId]) => taskId)).toEqual([uuid(37)]);
  });
});

describe("the merge pass is not starved", () => {
  it("runs its rows and its gate while 40 tracking rows are due", async () => {
    const h = harness();
    for (let index = 1; index <= 40; index += 1) await enrollTracking(h.db, uuid(index), h.now() - 1_000);
    await enrollMerge(h.db, uuid(99), h.now() - 1_000);
    await runDueWorkflowMergeTracking(h.dependencies);
    h.reconcile.mockClear();
    expect(await runDueWorkflowMergeRecovery(h.dependencies)).toEqual({ attempted: 1, reconciled: 1, deferred: 0 });
    expect(h.reconcile.mock.calls.map(([taskId]) => taskId)).toEqual([uuid(99)]);
  });

  it("keeps the merge pass's request budget for the tracking pass's own use", async () => {
    const seen = new Set<GithubMergeReadBudget>();
    const h = harness({ reconcile: async (_taskId, budget) => { seen.add(budget); return { kind: "OBSERVED" }; } });
    await enrollTracking(h.db, uuid(1), h.now() - 1);
    await enrollMerge(h.db, uuid(2), h.now() - 1);
    await runDueWorkflowMergeRecovery(h.dependencies);
    await runDueWorkflowMergeTracking(h.dependencies);
    expect(seen.size).toBe(2);
  });
});
