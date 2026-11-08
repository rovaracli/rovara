// Lessons in production, lane 5 (DECISIONS 23): the lesson vectors kept WITH the lessons in the record table (lessons/dynamo-vectors.ts), and every way a lesson leaves: erasure, purge, withdrawal,
// retirement, a project erase. A vector is derived from lesson text, so it must never outlive its lesson.
import { describe, expect, it } from "vitest";
import { lessonDeletionPort } from "../../../packages/broker/src/lessons/deletion.js";
import { dynamoLessonVectors, lessonVectorKey } from "../../../packages/broker/src/lessons/dynamo-vectors.js";
import { DynamoLessonStore } from "../../../packages/broker/src/lessons/dynamo-store.js";
import { retireLesson } from "../../../packages/broker/src/lessons/curate.js";
import { keepVector } from "../../../packages/broker/src/lessons/similarity.js";
import { eraseProject } from "../../../packages/broker/src/team-record/erase.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { ORG_A, ORG_B, world } from "../../support/team-record-core.js";
import { deleteDeps } from "../../support/team-record-delete.js";
import { Audit, Clock, embedder, lessonRecord } from "./lesson-helpers.js";

const PROJECT = "web";
const KEY = { workspaceId: ORG_A, project: PROJECT };
const vec = (...v: number[]): number[] => v;
const mk = (id: string) => lessonRecord({ id, workspaceId: ORG_A, project: PROJECT });
const vecItems = (db: FakeDynamoDb) => db.find((item) => String(item.sk).endsWith("#VEC"));

describe("the vector item", () => {
  it("is one item beside the lesson head, in the project's partition, as 32-bit floats; a spec mismatch is a miss; a new spec replaces the old item", async () => {
    const db = new FakeDynamoDb();
    const vectors = dynamoLessonVectors({ documentClient: db, tableName: "TeamRecord" });
    await vectors.put(ORG_A, PROJECT, "spec-a", "les_aaaa1111", { hash: "h1", vector: vec(0.5, -0.25, 1) });
    const [item] = vecItems(db);
    expect(item).toMatchObject({ ...lessonVectorKey(ORG_A, PROJECT, "les_aaaa1111"), entityType: "LESSON_VECTOR", id: "les_aaaa1111", spec: "spec-a", hash: "h1" });
    expect(String(item!.sk)).toBe("LESSON#les_aaaa1111#VEC");
    expect(item!.vector).toBeInstanceOf(Uint8Array);
    expect((item!.vector as Uint8Array).byteLength).toBe(12);
    const got = await vectors.get(ORG_A, PROJECT, "spec-a", ["les_aaaa1111", "les_missing1"]);
    expect([...got.keys()]).toEqual(["les_aaaa1111"]);
    expect(got.get("les_aaaa1111")).toEqual({ hash: "h1", vector: [0.5, -0.25, 1] });
    expect((await vectors.get(ORG_A, PROJECT, "spec-b", ["les_aaaa1111"])).size).toBe(0);
    await vectors.put(ORG_A, PROJECT, "spec-b", "les_aaaa1111", { hash: "h1", vector: vec(1, 0, 0) });
    expect(vecItems(db)).toHaveLength(1);
    expect((await vectors.get(ORG_A, PROJECT, "spec-a", ["les_aaaa1111"])).size).toBe(0);
    expect((await vectors.get(ORG_A, PROJECT, "spec-b", ["les_aaaa1111"])).size).toBe(1);
  });

  it("another workspace or project never sees it; more than one batch of ids is read in full", async () => {
    const db = new FakeDynamoDb();
    const vectors = dynamoLessonVectors({ documentClient: db, tableName: "TeamRecord" });
    const ids = Array.from({ length: 230 }, (_, i) => `les_${String(i).padStart(8, "0")}`);
    for (const id of ids) await vectors.put(ORG_A, PROJECT, "s", id, { hash: "h", vector: vec(1, 2) });
    expect((await vectors.get(ORG_A, PROJECT, "s", ids)).size).toBe(230);
    expect((await vectors.get(ORG_B, PROJECT, "s", ids)).size).toBe(0);
    expect((await vectors.get(ORG_A, "api", "s", ids)).size).toBe(0);
  });

  it("an item that is not a vector of this spec, or does not parse, is a miss, never a vector", async () => {
    const db = new FakeDynamoDb();
    const vectors = dynamoLessonVectors({ documentClient: db, tableName: "TeamRecord" });
    db.set({ ...lessonVectorKey(ORG_A, PROJECT, "les_bad00001"), entityType: "LESSON_VECTOR", id: "les_bad00001", spec: "s", hash: "h", vector: new Uint8Array(3) });
    db.set({ ...lessonVectorKey(ORG_A, PROJECT, "les_oth00001"), entityType: "SOMETHING", id: "les_oth00001", spec: "s", hash: "h", vector: new Uint8Array(new Float32Array([1]).buffer) });
    expect((await vectors.get(ORG_A, PROJECT, "s", ["les_bad00001", "les_oth00001"])).size).toBe(0);
  });

  it("does not disturb the lesson store: the head, versions and the set read as before, and listAllHeads ignores the vector items", async () => {
    const db = new FakeDynamoDb();
    const table = { documentClient: db, tableName: "TeamRecord" };
    const store = new DynamoLessonStore(table);
    await store.commit(KEY, await store.setVersion(KEY), [mk("les_aaaa1111"), mk("les_bbbb2222")], 10);
    await keepVector({ embedder, vectors: dynamoLessonVectors(table) }, KEY, mk("les_aaaa1111"), new Array<number>(256).fill(0.1));
    expect(vecItems(db)).toHaveLength(1);
    expect((await store.listAllHeads(KEY)).map((l) => l.id)).toEqual(["les_aaaa1111", "les_bbbb2222"]);
    expect((await store.versions(KEY, "les_aaaa1111")).map((v) => v.version)).toEqual([1]);
  });
});

describe("a vector never outlives its lesson", () => {
  const setup = async () => {
    const db = new FakeDynamoDb();
    const table = { documentClient: db, tableName: "TeamRecord" };
    const store = new DynamoLessonStore(table);
    const vectors = dynamoLessonVectors(table);
    await store.commit(KEY, await store.setVersion(KEY), [mk("les_aaaa1111"), mk("les_bbbb2222")], 10);
    for (const id of ["les_aaaa1111", "les_bbbb2222"]) await vectors.put(ORG_A, PROJECT, "s", id, { hash: "h", vector: vec(1, 0) });
    return { db, table, store, vectors };
  };

  it("the store's own purge removes it", async () => {
    const { db, store } = await setup();
    await store.purge(KEY, "les_aaaa1111");
    expect(vecItems(db).map((i) => i.id)).toEqual(["les_bbbb2222"]);
  });

  it("the deletion port: a withdrawal and an erased person's lessons remove it (the vector step comes before the rows)", async () => {
    const { db, store, vectors } = await setup();
    const port = lessonDeletionPort({ store, vectors, audit: new Audit(), now: new Clock().now });
    await port.withdraw(ORG_A, PROJECT, "les_aaaa1111", "sources_deleted");
    expect(vecItems(db).map((i) => i.id)).toEqual(["les_bbbb2222"]);
    await port.withdraw(ORG_A, PROJECT, "les_bbbb2222", "person_erased");
    expect(vecItems(db)).toEqual([]);
    expect(await store.getHead(KEY, "les_bbbb2222")).toBeUndefined();
  });

  it("a vector that cannot be removed keeps the purge unfinished, and the retry removes it", async () => {
    const { db, store, table } = await setup();
    let failing = true;
    const flaky = { ...dynamoLessonVectors(table), remove: async (w: string, p: string, id: string) => { if (failing) throw new Error("down"); return dynamoLessonVectors(table).remove(w, p, id); } };
    const port = lessonDeletionPort({ store, vectors: flaky, audit: new Audit(), now: new Clock().now });
    await expect(port.withdraw(ORG_A, PROJECT, "les_aaaa1111", "person_erased")).rejects.toThrow();
    expect(vecItems(db)).toHaveLength(2);
    expect(await store.getHead(KEY, "les_aaaa1111")).toBeDefined();
    failing = false;
    await port.resumePending(ORG_A, PROJECT);
    expect(vecItems(db).map((i) => i.id)).toEqual(["les_bbbb2222"]);
    expect(await store.getHead(KEY, "les_aaaa1111")).toBeUndefined();
  });

  it("retiring a lesson removes it", async () => {
    const { db, store, vectors } = await setup();
    const loaded = await store.list(KEY, { statuses: ["active"] });
    const active = loaded.find((l) => l.id === "les_aaaa1111");
    expect(active).toBeDefined();
    expect(await retireLesson({ store, vectors, audit: new Audit(), now: new Clock().now }, KEY, "les_aaaa1111", "test", "ann")).toBe(true);
    expect(vecItems(db).map((i) => i.id)).toEqual(["les_bbbb2222"]);
  });

  it("a project erase removes the vector items with the lesson rows, and leaves nothing in the partition", async () => {
    const w = world();
    const store = new DynamoLessonStore(w.table);
    const vectors = dynamoLessonVectors(w.table);
    await store.commit(KEY, await store.setVersion(KEY), [mk("les_aaaa1111")], 10);
    await vectors.put(ORG_A, PROJECT, "s", "les_aaaa1111", { hash: "h", vector: vec(1, 0) });
    expect(w.db.find((item) => String(item.sk).endsWith("#VEC"))).toHaveLength(1);
    const result = await eraseProject(deleteDeps(w, { lessonVectors: { removeAll: async (org, project, ids) => { for (const id of ids) await vectors.remove(org, project, id); } } }).deps, ORG_A, PROJECT, "project_archived", "arch-vec");
    expect(result.complete).toBe(true);
    expect(w.db.find((item) => String(item.pk).includes("#P#web"))).toEqual([]);
  });
});
