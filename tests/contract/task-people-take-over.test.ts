// Plan 5 Task 12b (12a review I-2, the controller's ruling): a take-over makes the taker the ONLY owner. In the same transaction as the take-over, every other owner entry
// of the task's People list (the creator, a co-owner from before, the middle owner of a chain A to B to C) is lowered to commenter, so no earlier owner's decision still counts.
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { loadTaskPeople, takeOverTaskPeopleItems } from "../../packages/broker/src/developer/task-people.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const hex = (digit: string) => digit.repeat(64);
const A = hex("a");
const B = hex("b");
const C = hex("c");
const CASEY = hex("d");
const VERA = hex("e");

const entry = (developerId: string, slackUserId: string, name: string, role: string) => ({ developerId, slackUserId, name, role });
function seed(people: Array<Record<string, unknown>>, revision = 4, orphaned = false) {
  const db = new FakeDynamoDb();
  db.set({ pk: `DEVTASK#${TASK_ID}`, sk: "PEOPLE", schemaVersion: 1, revision, orphaned, people });
  return db;
}
const task = { taskId: TASK_ID } as never;
const roles = (db: FakeDynamoDb) => Object.fromEntries((db.get(`DEVTASK#${TASK_ID}`, "PEOPLE") as unknown as { people: Array<{ developerId: string; role: string }> }).people.map((person) => [person.developerId, person.role]));

describe("lowering the other owners at a take-over", () => {
  it("lowers every other owner to commenter in one Update, bumps the revision and clears orphaned, and keeps everyone else as they are", async () => {
    const db = seed([
      entry(A, "U0AAAAAAA1", "Ann", "owner"), entry(B, "U0BBBBBBB1", "Bea", "owner"), entry(CASEY, "U0DDDDDDD1", "Casey", "owner"),
      entry(VERA, "U0EEEEEEE1", "Vera", "viewer"), entry(C, "U0CCCCCCC1", "Cy", "commenter"),
    ], 4, true);
    const people = (await loadTaskPeople({ documentClient: db, tableName: "state" }, TASK_ID))!;
    const items = takeOverTaskPeopleItems({ tableName: "state" }, task, people, C);
    expect(items).toHaveLength(1);
    await db.send(new TransactWriteCommand({ TransactItems: items }));
    expect(roles(db)).toEqual({ [A]: "commenter", [B]: "commenter", [CASEY]: "commenter", [VERA]: "viewer", [C]: "commenter" });
    expect(db.get(`DEVTASK#${TASK_ID}`, "PEOPLE")).toMatchObject({ revision: 5, orphaned: false });
  });

  it("keeps the taker's own owner entry, and lowers the middle owner of a chain of take-overs (A to B to C)", async () => {
    const db = seed([entry(A, "U0AAAAAAA1", "Ann", "commenter"), entry(B, "U0BBBBBBB1", "Bea", "owner"), entry(C, "U0CCCCCCC1", "Cy", "owner")]);
    const people = (await loadTaskPeople({ documentClient: db, tableName: "state" }, TASK_ID))!;
    await db.send(new TransactWriteCommand({ TransactItems: takeOverTaskPeopleItems({ tableName: "state" }, task, people, C) }));
    expect(roles(db)).toEqual({ [A]: "commenter", [B]: "commenter", [C]: "owner" });
  });

  it("writes nothing when no one else is an owner and the task is not orphaned", async () => {
    const db = seed([entry(A, "U0AAAAAAA1", "Ann", "commenter"), entry(C, "U0CCCCCCC1", "Cy", "owner")]);
    const people = (await loadTaskPeople({ documentClient: db, tableName: "state" }, TASK_ID))!;
    expect(takeOverTaskPeopleItems({ tableName: "state" }, task, people, C)).toEqual([]);
  });

  it("fails the transaction when the list changed since it was read, so a stale list is never written over a newer one", async () => {
    const db = seed([entry(A, "U0AAAAAAA1", "Ann", "owner")]);
    const people = (await loadTaskPeople({ documentClient: db, tableName: "state" }, TASK_ID))!;
    db.set({ pk: `DEVTASK#${TASK_ID}`, sk: "PEOPLE", schemaVersion: 1, revision: 5, orphaned: false, people: [entry(A, "U0AAAAAAA1", "Ann", "owner"), entry(CASEY, "U0DDDDDDD1", "Casey", "owner")] });
    await expect(db.send(new TransactWriteCommand({ TransactItems: takeOverTaskPeopleItems({ tableName: "state" }, task, people, C) }))).rejects.toMatchObject({ name: "TransactionCanceledException" });
    expect(roles(db)[CASEY]).toBe("owner");
  });

  it("reads a list as it is stored, and nothing for a task with none", async () => {
    const db = new FakeDynamoDb();
    expect(await loadTaskPeople({ documentClient: db, tableName: "state" }, TASK_ID)).toBeUndefined();
  });
});
