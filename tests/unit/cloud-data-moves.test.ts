// Convergence data moves (decision 129): the one framework (dry run, apply, resume, reverse, conflicts) and each move on old, new and mixed data.
import { describe, expect, it } from "vitest";
import { MemoryDocumentStore } from "@rovara-code/broker/ports";
import { TASK_FLOW_INDEXES, dispatchPartition } from "@rovara-code/broker/core/task-flow";
import type { DocumentStore, StoredDocument } from "@rovara-code/contracts";
import { engineStampKey, readCoreEngineFlags, stampForNewTask, stampItem } from "../../packages/broker/src/cloud/app/index.js";
import {
  DataMoveRefused, OLD_DISPATCH_PARTITION, dispatchPartitionMove, dueRowsBothPartitions, memoryResume, outboxRelayPrep, retentionReview, runDataMove, s2MarkerRowsHeld,
  type MoveContext, type MovePage,
} from "../../packages/broker/src/cloud/migrations/index.js";

const COMPANY = "org_s0parity00000000000a";
const NOW = new Date("2026-11-12T10:00:00.000Z");
const iso = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();

function contextOver(store: DocumentStore): MoveContext {
  return { store, now: () => NOW, log: () => undefined };
}

/** A Cloud-shaped dispatch row on the old partition (Cloud's `WorkflowDispatchRecord`). */
function oldRow(taskId: string, revision: number, kind: string, extra: Record<string, unknown> = {}): StoredDocument {
  const sk = `${taskId}#${revision}`;
  return { pk: OLD_DISPATCH_PARTITION, sk, entityType: "WORKFLOW_DISPATCH", taskId, workflowRevision: revision, kind, candidateDigest: "none", createdAt: iso(-5), attempts: 0, nextAttemptAt: iso(-1), dispatchDuePk: OLD_DISPATCH_PARTITION, dispatchDueSk: `${iso(-1)}#${sk}`, indexExpiresAt: 1_800_000_000, ...extra };
}

async function seedTask(store: DocumentStore, taskId: string, engine: "core" | "cloud", company: string | null = COMPANY): Promise<void> {
  await store.put({ item: { pk: `DEVTASK#${taskId}`, sk: "META", ...(company === null ? {} : engine === "core" ? { companyId: company } : { orgId: company }) } });
  if (engine === "core") await store.transact([stampItem(COMPANY, taskId, stampForNewTask(readCoreEngineFlags({ CLOUD_CORE_ENGINE: "on" }), COMPANY, NOW))]);
}

/** Old data, new data and both: a core task's row on the old partition (Cloud code wrote it), a Cloud task's row, a Cloud-only kind, a task whose company is unreadable, and a row already on the new partition. */
async function mixedWorld(): Promise<{ store: MemoryDocumentStore; before: Map<string, StoredDocument | undefined> }> {
  const store = new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES });
  await seedTask(store, "t-core", "core");
  await seedTask(store, "t-cloud", "cloud");
  await seedTask(store, "t-core-checks", "core");
  await seedTask(store, "t-core-nocompany", "core", null);
  await seedTask(store, "t-new", "core");
  for (const row of [oldRow("t-core", 3, "AUTOFIX", { autofixCause: "run-lost" }), oldRow("t-cloud", 2, "PLAN"), oldRow("t-core-checks", 4, "CHECKS"), oldRow("t-core-nocompany", 1, "PLAN")]) await store.put({ item: row });
  await store.put({ item: { pk: dispatchPartition(COMPANY), sk: "t-new#1", entityType: "WORKFLOW_DISPATCH", companyId: COMPANY, taskId: "t-new", workflowRevision: 1, kind: "PLAN", createdAt: iso(-3), attempts: 0, nextAttemptAt: iso(-2), dispatchDuePk: dispatchPartition(COMPANY), dispatchDueSk: `${iso(-2)}#t-new#1`, indexExpiresAt: 1_800_000_000 } });
  const keys = ["t-core#3", "t-cloud#2", "t-core-checks#4", "t-core-nocompany#1"];
  const before = new Map(await Promise.all(keys.map(async (sk) => [sk, await store.get({ pk: OLD_DISPATCH_PARTITION, sk })] as const)));
  return { store, before };
}

const d1 = (pageSize?: number) => dispatchPartitionMove({ companies: () => [COMPANY], ...(pageSize === undefined ? {} : { pageSize }) });

describe("D1: dispatch rows into the company's partition", () => {
  it("a dry run writes nothing and reports what an apply would do, item by item", async () => {
    const { store, before } = await mixedWorld();
    const report = await runDataMove(d1(), contextOver(store), { direction: "forward" });
    expect(report).toMatchObject({ mode: "dry-run", scanned: 4, writes: 1, conflicts: 1, done: true, skipped: { "a Cloud task (pinned to Cloud's path)": 1, "a kind only Cloud runs": 1 } });
    expect(report.conflictList).toEqual([{ key: { pk: OLD_DISPATCH_PARTITION, sk: "t-core-nocompany#1" }, reason: "the task's company cannot be read" }]);
    for (const [sk, item] of before) expect(await store.get({ pk: OLD_DISPATCH_PARTITION, sk })).toEqual(item);
    expect(await store.get({ pk: dispatchPartition(COMPANY), sk: "t-core#3" })).toBeUndefined();
  });

  it("an apply moves only the core task's row, in the core's shape, and is a no-op when run again", async () => {
    const { store } = await mixedWorld();
    const first = await runDataMove(d1(), contextOver(store), { direction: "forward", apply: true });
    expect(first).toMatchObject({ mode: "apply", writes: 1, conflicts: 1 });
    expect(await store.get({ pk: OLD_DISPATCH_PARTITION, sk: "t-core#3" })).toBeUndefined();
    const moved = await store.get({ pk: dispatchPartition(COMPANY), sk: "t-core#3" });
    expect(moved).toMatchObject({ companyId: COMPANY, cause: "run-lost", dispatchDuePk: dispatchPartition(COMPANY), movedFrom: OLD_DISPATCH_PARTITION, kind: "AUTOFIX", nextAttemptAt: iso(-1) });
    expect(moved).not.toHaveProperty("autofixCause");
    expect(await store.get({ pk: OLD_DISPATCH_PARTITION, sk: "t-cloud#2" })).toBeDefined();
    expect(await store.get({ pk: OLD_DISPATCH_PARTITION, sk: "t-core-checks#4" })).toBeDefined();
    const again = await runDataMove(d1(), contextOver(store), { direction: "forward", apply: true });
    expect(again.writes).toBe(0);
  });

  it("the reverse puts back exactly what the apply moved, and leaves rows it did not move", async () => {
    const { store, before } = await mixedWorld();
    await runDataMove(d1(), contextOver(store), { direction: "forward", apply: true });
    const reverse = await runDataMove(d1(), contextOver(store), { direction: "reverse", apply: true });
    expect(reverse).toMatchObject({ writes: 1, skipped: { "not moved by this move": 1 } });
    for (const [sk, item] of before) expect(await store.get({ pk: OLD_DISPATCH_PARTITION, sk }), sk).toEqual(item);
    expect(await store.get({ pk: dispatchPartition(COMPANY), sk: "t-new#1" })).toBeDefined();
    expect(await store.get({ pk: dispatchPartition(COMPANY), sk: "t-core#3" })).toBeUndefined();
  });

  it("a stopped run carries on from its resume file; a resume file of another move or direction is refused", async () => {
    const { store } = await mixedWorld();
    const resume = memoryResume();
    const part = await runDataMove(d1(1), contextOver(store), { direction: "forward", apply: true, resume, maxPages: 2 });
    expect(part).toMatchObject({ done: false, pages: 2 });
    expect(resume.state).toMatchObject({ moveId: "d1-dispatch-partition", direction: "forward", pages: 2, done: false });
    const rest = await runDataMove(d1(1), contextOver(store), { direction: "forward", apply: true, resume });
    expect(rest.done).toBe(true);
    expect(part.scanned + rest.scanned).toBeLessThanOrEqual(5);
    expect(await store.get({ pk: dispatchPartition(COMPANY), sk: "t-core#3" })).toBeDefined();
    await expect(runDataMove(d1(), contextOver(store), { direction: "reverse", apply: true, resume: memoryResume({ ...resume.state!, done: false }) })).rejects.toBeInstanceOf(DataMoveRefused);
  });

  it("a row the sweep changed between the plan and the write is planned again from what is there", async () => {
    const { store } = await mixedWorld();
    let first = true;
    const racing: DocumentStore = new Proxy(store, { get: (target, name) => (name === "transact" ? transact : (Reflect.get(target, name, target) as unknown as (...args: unknown[]) => unknown).bind?.(target) ?? Reflect.get(target, name, target)) });
    async function transact(items: Parameters<DocumentStore["transact"]>[0]): ReturnType<DocumentStore["transact"]> {
      if (first) {
        first = false;
        // The sweep reschedules the row under the move.
        await store.update({ key: { pk: OLD_DISPATCH_PARTITION, sk: "t-core#3" }, ops: [{ op: "set", path: ["nextAttemptAt"], value: iso(10) }] });
      }
      return await store.transact(items);
    }
    const report = await runDataMove(d1(), contextOver(racing), { direction: "forward", apply: true });
    expect(report.writes).toBe(1);
    expect(await store.get({ pk: dispatchPartition(COMPANY), sk: "t-core#3" })).toMatchObject({ nextAttemptAt: iso(10) });
  });

  it("dual read: the core's sweep sees its own partition and the old partition's rows of its own core tasks only, oldest first; a kind it cannot run is reported", async () => {
    const { store } = await mixedWorld();
    const due = await dueRowsBothPartitions(store, COMPANY, NOW.toISOString(), 10);
    expect(due.rows.map((row) => row.taskId)).toEqual(["t-new", "t-core"]);
    expect(due.rows[1]).toMatchObject({ pk: OLD_DISPATCH_PARTITION, companyId: COMPANY, cause: "run-lost" });
    expect(due.unknownKinds).toEqual([{ taskId: "t-core-checks", kind: "CHECKS" }]);
    expect(await dueRowsBothPartitions(store, "org_s0parity00000000000b", NOW.toISOString(), 10)).toEqual({ rows: [], unknownKinds: [] });
  });
});

describe("the other moves", () => {
  const list = (items: StoredDocument[]) => async (): Promise<MovePage> => ({ items });

  it("D2 is a check: it lists stuck old outbox rows, passes draining ones, and refuses an apply", async () => {
    const store = new MemoryDocumentStore();
    const move = outboxRelayPrep({ scanOldOutbox: list([{ pk: "OUTBOX#1", sk: "OUTBOX", createdAt: iso(-5), status: "PENDING" }, { pk: "OUTBOX#2", sk: "OUTBOX", createdAt: iso(-90), status: "PENDING" }]) });
    const report = await runDataMove(move, contextOver(store), { direction: "forward" });
    expect(report).toMatchObject({ writes: 0, conflicts: 1, skipped: { draining: 1 } });
    await expect(runDataMove(move, contextOver(store), { direction: "forward", apply: true })).rejects.toBeInstanceOf(DataMoveRefused);
  });

  it("D12 removes the expiry of kinds Cloud keeps, keeps it on kinds Cloud expires, and the reverse restores it", async () => {
    const store = new MemoryDocumentStore();
    const items: StoredDocument[] = [
      { pk: "ORG#c#APPROVAL_PROOF", sk: "p1", entityType: "APPROVAL_PROOF_USED", indexExpiresAt: 1_900_000_000 },
      { pk: "ORG#c#COST", sk: "e1", entityType: "COST_ENTRY_ONCE", indexExpiresAt: 1_900_000_001 },
      { pk: "ORG#c#WORK_EVENT", sk: "w1", entityType: "WORK_EVENT", indexExpiresAt: 1_900_000_002 },
    ];
    for (const item of items) await store.put({ item });
    const scanAll = async (): Promise<MovePage> => ({ items: (await Promise.all(items.map((item) => store.get(item)))).filter((item): item is StoredDocument => item !== undefined) });
    const move = retentionReview({ scan: scanAll });
    expect(await runDataMove(move, contextOver(store), { direction: "forward", apply: true })).toMatchObject({ writes: 2, skipped: { "keeps its expiry: WORK_EVENT": 1 } });
    expect(await store.get(items[0]!)).toMatchObject({ retentionReviewedExpiry: 1_900_000_000 });
    expect(await store.get(items[0]!)).not.toHaveProperty("indexExpiresAt");
    expect(await store.get(items[2]!)).toEqual(items[2]);
    await runDataMove(move, contextOver(store), { direction: "reverse", apply: true });
    for (const item of items) expect(await store.get(item)).toEqual(item);
  });

  it("A5's S2 move is held: listed with its reason, an apply refused", async () => {
    await expect(runDataMove(s2MarkerRowsHeld, contextOver(new MemoryDocumentStore()), { direction: "forward", apply: true })).rejects.toThrow(/adapters\/a5-s2-live-rewrite/);
  });

  it("the stamp item is the only thing a core task adds for routing", () => {
    expect(engineStampKey("t1")).toEqual({ pk: "TASK_ENGINE#t1", sk: "STAMP" });
  });
});
