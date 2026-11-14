// S2 readers (0.5.18), Opus money review follow-ups: a task held in both forms, and the marker-form wiring of the places that confirm a release.
import { describe, expect, it } from "vitest";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";
import { chargeFormOf, developerCharge, releaseConflict, releaseItems } from "../../packages/broker/src/developer/limits.js";
import { reconcileWorkflowMergeRecoveryTask } from "../../packages/broker/src/aws/broker/terminal-and-github-events.js";

const TABLE = "state";
const developerId = "d".repeat(64);
const charge = developerCharge({ orgId: TEST_ORG, developerId });
const send = (db: FakeDynamoDb, items: unknown[]) => db.send({ constructor: { name: "TransactWriteCommand" }, input: { TransactItems: items } });
const fails = async (promise: Promise<unknown>) => promise.then(() => { throw new Error("expected a cancelled transaction"); }, (error: unknown) => error);
const marker = (taskId: string) => ({ pk: charge.member.pk, sk: `TASK#${taskId}`, entityType: "DEVELOPER_LIMIT_TASK", taskId, memberSk: charge.member.sk, chargedAt: "x" });

describe("a task held in BOTH forms is released once", () => {
  it("clears the set entry with the marker, so a second release frees nothing and the other task keeps its slot", async () => {
    const db = new FakeDynamoDb();
    // Two slots: X is in the set AND has a marker (the move half done); Y is in the set only.
    db.set({ ...charge.organization, entityType: "DEVELOPER_LIMIT", count: 2 });
    db.set({ ...charge.member, entityType: "DEVELOPER_LIMIT", count: 2, tasks: new Set(["X", "Y"]) });
    db.set(marker("X"));
    expect(await chargeFormOf(db, TABLE, charge, "X")).toBe("marker");
    await send(db, releaseItems(TABLE, charge, "X", "marker"));
    expect(db.get(charge.member)).toMatchObject({ count: 1, tasks: new Set(["Y"]) });
    expect(db.get(charge.member.pk, "TASK#X")).toBeUndefined();
    // Released again: the form is now the set form, and X is in neither, so nothing is freed.
    const form = await chargeFormOf(db, TABLE, charge, "X");
    expect(form).toBe("set");
    const repeat = await fails(send(db, releaseItems(TABLE, charge, "X", form)));
    expect(await releaseConflict(db, TABLE, charge, "X", repeat, form)).toBe("already_released");
    // And a stale marker-form release (the form read before the first one landed) is stopped by the marker, not by luck of the count.
    const stale = await fails(send(db, releaseItems(TABLE, charge, "X", "marker")));
    expect(await releaseConflict(db, TABLE, charge, "X", stale, "marker")).toBe("already_released");
    expect(db.get(charge.member)).toMatchObject({ count: 1, tasks: new Set(["Y"]) });
    expect(db.get(charge.organization)).toMatchObject({ count: 1 });
  });
});

describe("the merge recovery's release confirmation reads the marker form (terminal-and-github-events)", () => {
  const closed = (db: FakeDynamoDb, taskId: string) => {
    db.set({ pk: `DEVTASK#${taskId}`, sk: "META", entityType: "DEVELOPER_TASK", taskId, orgId: TEST_ORG, workspaceId: `ws-${taskId}`, closedAt: "2026-11-20T00:00:00.000Z", charge });
    db.set({ pk: `WORKSPACE#ws-${taskId}`, sk: "META", status: "CLOSED" });
    db.set({ ...charge.member, entityType: "DEVELOPER_LIMIT", count: 0 });
    db.set({ ...charge.organization, entityType: "DEVELOPER_LIMIT", count: 0 });
  };
  const reconcile = (db: FakeDynamoDb, taskId: string) => reconcileWorkflowMergeRecoveryTask({ documentClient: db, tableName: TABLE } as never, taskId, {} as never);

  it("is confirmed when the workspace is closed and neither form holds the slot", async () => {
    const db = new FakeDynamoDb();
    closed(db, "t1");
    expect(await reconcile(db, "t1")).toEqual({ kind: "TERMINAL", release: "confirmed" });
  });

  it("is not confirmed while the slot is still held as a marker", async () => {
    const db = new FakeDynamoDb();
    closed(db, "t1");
    db.set(marker("t1"));
    expect(await reconcile(db, "t1")).toMatchObject({ kind: "RETRY" });
    db.delete(charge.member.pk, "TASK#t1");
    expect(await reconcile(db, "t1")).toEqual({ kind: "TERMINAL", release: "confirmed" });
  });

  it("is not confirmed while the slot is still in the set", async () => {
    const db = new FakeDynamoDb();
    closed(db, "t1");
    db.set({ ...charge.member, entityType: "DEVELOPER_LIMIT", count: 0, tasks: new Set(["t1"]) });
    expect(await reconcile(db, "t1")).toMatchObject({ kind: "RETRY" });
  });
});
