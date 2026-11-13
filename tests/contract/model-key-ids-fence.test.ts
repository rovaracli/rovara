// Convergence lane A5 (owner decision 60 item S2): a record's `modelKeyIds` is written whole, fenced on the exact list the caller read, instead of a list
// append fenced by `size`. The stored shape (a list in mint order) is unchanged, so the rows the previous release wrote are read and extended as they are.
import { describe, expect, it } from "vitest";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { recordMintedKey } from "../../packages/broker/src/org/budget.js";
import { recordKey } from "../../packages/broker/src/spend/admission.js";

const TABLE = "state";
const TASK = { pk: "DEVTASK#task-1", sk: "META" };
const OPERATION = { pk: "WORKSPACE#ws-1", sk: "OPERATION#op-1" };
const id = (n: number) => String(n).padStart(64, "0");
const deps = (db: FakeDynamoDb) => ({ documentClient: db, tableName: TABLE, access: {} as never });
const ids = (db: FakeDynamoDb, key: { pk: string; sk: string }) => db.get(key)?.["modelKeyIds"];

describe("modelKeyIds: whole-list writes fenced on the exact list", () => {
  it("extends a list the previous release wrote, and refuses a list that moved since the read", async () => {
    const db = new FakeDynamoDb();
    db.set({ ...TASK, entityType: "DEVELOPER_TASK", modelKeyIds: [id(1), id(2)] });
    expect(await recordMintedKey(deps(db), TASK, id(3), [id(1), id(2)])).toBe(true);
    expect(ids(db, TASK)).toEqual([id(1), id(2), id(3)]);
    expect(await recordMintedKey(deps(db), TASK, id(4), [id(1), id(2)])).toBe(false);
    expect(ids(db, TASK)).toEqual([id(1), id(2), id(3)]);
  });

  it("the first key needs a record with no list; a missing record refuses", async () => {
    const db = new FakeDynamoDb();
    expect(await recordMintedKey(deps(db), TASK, id(1), [])).toBe(false);
    db.set({ ...TASK, entityType: "DEVELOPER_TASK" });
    expect(await recordMintedKey(deps(db), TASK, id(1), [])).toBe(true);
    expect(await recordMintedKey(deps(db), TASK, id(2), [])).toBe(false);
    expect(ids(db, TASK)).toEqual([id(1)]);
  });

  it("two mints that read the same list race: exactly one is recorded (no key is given the whole remainder twice)", async () => {
    const db = new FakeDynamoDb();
    db.set({ ...TASK, entityType: "DEVELOPER_TASK", modelKeyIds: [id(1)] });
    const results = await Promise.all([recordMintedKey(deps(db), TASK, id(2), [id(1)]), recordMintedKey(deps(db), TASK, id(3), [id(1)])]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((ids(db, TASK) as string[]).length).toBe(2);
  });

  it("a list emptied and refilled to the same length since the read is not overwritten (the old size fence would have been fooled)", async () => {
    const db = new FakeDynamoDb();
    db.set({ ...TASK, entityType: "LEASE", modelKeyIds: [id(7)] });
    expect(await recordMintedKey(deps(db), TASK, id(9), [id(1)])).toBe(false);
    expect(ids(db, TASK)).toEqual([id(7)]);
  });

  it("an unfenced record (the old unconditional append) never loses a key to a concurrent one: concurrent writers all land", async () => {
    const db = new FakeDynamoDb();
    db.set({ ...OPERATION, entityType: "OPERATION" });
    const results = await Promise.all([1, 2, 3, 4].map((n) => recordKey(deps(db), [{ key: OPERATION }], id(n))));
    expect(results).toEqual([true, true, true, true]);
    expect([...(ids(db, OPERATION) as string[])].sort()).toEqual([id(1), id(2), id(3), id(4)]);
  });

  it("a fenced task and an unfenced operation in one write: a moved task list is a lost race, nothing written", async () => {
    const db = new FakeDynamoDb();
    db.set({ ...TASK, entityType: "DEVELOPER_TASK", modelKeyIds: [id(1), id(2)] });
    db.set({ ...OPERATION, entityType: "OPERATION" });
    expect(await recordKey(deps(db), [{ key: TASK, knownIds: [id(1)] }, { key: OPERATION }], id(5))).toBe(false);
    expect(ids(db, TASK)).toEqual([id(1), id(2)]);
    expect(ids(db, OPERATION)).toBeUndefined();
    expect(await recordKey(deps(db), [{ key: TASK, knownIds: [id(1), id(2)] }, { key: OPERATION }], id(5))).toBe(true);
    expect(ids(db, TASK)).toEqual([id(1), id(2), id(5)]);
    expect(ids(db, OPERATION)).toEqual([id(5)]);
  });

  it("a guard that refuses is false, and is not retried as if a list had moved", async () => {
    const db = new FakeDynamoDb();
    db.set({ ...OPERATION, entityType: "OPERATION" });
    const guard = (items: readonly unknown[]) => [...items, { ConditionCheck: { TableName: TABLE, Key: { pk: "NOPE", sk: "NOPE" }, ConditionExpression: "attribute_exists(pk)" } }] as never;
    expect(await recordKey(deps(db), [{ key: OPERATION }], id(1), guard)).toBe(false);
    expect(ids(db, OPERATION)).toBeUndefined();
    expect(db.transactions().length).toBe(1);
  });
});
