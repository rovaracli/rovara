// WL-6: the dispatcher's lesson reader over the real Dynamo lesson store (the in-memory DynamoDB): a stage queued with ids and versions gets its text from the store at delivery, an erased or
// fenced person's lesson is not delivered, and an install with no Team record table builds nothing.
import { describe, expect, it } from "vitest";
import { memberGithubKey, type LearnedRefs } from "../../packages/contracts/src/index.js";
import { createLessonDelivery } from "../../packages/broker/src/lessons/delivery-wiring.js";
import { DynamoLessonStore } from "../../packages/broker/src/lessons/dynamo-store.js";
import { KEY, PROJECT, WS, lessonRecord } from "../unit/lessons/lesson-helpers.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ann = { approvalId: "ap-ann", by: "ann", at: 1, mode: "one" as const };
const NOW = 1_800_000_000_000;
const refs = (ids: string[], over: Partial<LearnedRefs> = {}): LearnedRefs => ({ v: 1, orgId: WS, project: PROJECT, setVersion: 1, stage: "IMPLEMENT", audience: { kind: "shared" }, lessons: ids.map((id) => ({ id, version: 1 })), ...over });

async function world() {
  const db = new FakeDynamoDb();
  const table = { documentClient: db, tableName: "record" };
  const store = new DynamoLessonStore(table, () => NOW);
  const mallory = lessonRecord({ id: "les_mallory01", type: "convention", tier: 1, stages: ["IMPLEMENT"], approvals: [ann], scope: {}, title: "Mallory's rule", body: "Call the internal retry endpoint at the secret path.", provenance: { ...lessonRecord().provenance, authors: ["mallory"] } });
  const other = lessonRecord({ id: "les_other0001", type: "convention", tier: 1, stages: ["IMPLEMENT"], approvals: [ann], scope: {}, title: "Other rule" });
  const committed = await store.commit(KEY, await store.setVersion(KEY), [mallory, other], NOW);
  expect(committed.ok).toBe(true);
  const deliver = createLessonDelivery({ documentClient: db, stateTable: "state", recordTable: "record", enabled: () => true, now: () => NOW })!;
  return { db, store, deliver };
}

describe("createLessonDelivery", () => {
  it("builds nothing where the install has no Team record table (the record is off)", () => {
    const db = new FakeDynamoDb();
    expect(createLessonDelivery({ documentClient: db, stateTable: "state", recordTable: undefined })).toBeUndefined();
    expect(createLessonDelivery({ documentClient: db, stateTable: "state", recordTable: "" })).toBeUndefined();
  });

  it("builds a shared stage's lessons from the stored lessons", async () => {
    const { deliver } = await world();
    const context = await deliver(refs(["les_mallory01", "les_other0001"]));
    expect(context?.lessons.map((l) => l.title)).toEqual(["Mallory's rule", "Other rule"]);
  });

  it("a private task's reader is looked up in the State table (the linked account), and a lookup that fails delivers nothing", async () => {
    const { deliver, db } = await world();
    db.set({ ...memberGithubKey(WS, "d".repeat(64)), githubUserId: "gh-1" });
    const private1 = refs(["les_other0001"], { audience: { kind: "private", developerId: "d".repeat(64) } });
    expect((await deliver(private1))?.lessons.map((l) => l.id)).toEqual(["les_other0001"]);
    expect(await deliver({ ...private1, orgId: "not-an-org" })).toBeUndefined();
  });

  it("a person erased after the stage was queued: their lesson is not delivered once the erasure is fenced, before anything is purged; the other lessons still are", async () => {
    const { deliver, store } = await world();
    await store.fence(KEY, { people: ["mallory"] });
    const context = await deliver(refs(["les_mallory01", "les_other0001"]));
    expect(context?.lessons.map((l) => l.id)).toEqual(["les_other0001"]);
    expect(JSON.stringify(context)).not.toContain("secret path");
  });

  it("S1: the install switch is asked at every delivery: with it off (or no switch given) a stage that was queued while it was on gets no lessons, and the store is not read", async () => {
    const { db, store } = await world();
    let on = true;
    const reads: string[] = [];
    const spy = { send: (command: unknown): Promise<unknown> => { reads.push("read"); return db.send(command); } };
    const deliver = createLessonDelivery({ documentClient: spy, stateTable: "state", recordTable: "record", enabled: () => on, now: () => NOW })!;
    expect((await deliver(refs(["les_other0001"])))?.lessons).toHaveLength(1);
    on = false;
    reads.length = 0;
    expect(await deliver(refs(["les_other0001"]))).toBeUndefined();
    expect(reads).toEqual([]);
    expect(await createLessonDelivery({ documentClient: db, stateTable: "state", recordTable: "record", now: () => NOW })!(refs(["les_other0001"]))).toBeUndefined();
    void store;
  });
});
