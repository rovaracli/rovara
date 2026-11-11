// Lessons in production, lane 5 (DECISIONS 23): the lesson vectors kept WITH the lessons in the record table (lessons/dynamo-vectors.ts), and every way a lesson leaves: erasure, purge, withdrawal,
// retirement, a project erase. A vector is derived from lesson text, so it must never outlive its lesson.
import { describe, expect, it } from "vitest";
import { lessonDeletionPort } from "../../../packages/broker/src/lessons/deletion.js";
import { lessonKey } from "@rovara-code/contracts";
import { dynamoLessonVectors, lessonVectorKey } from "../../../packages/broker/src/lessons/dynamo-vectors.js";
import { DynamoLessonStore } from "../../../packages/broker/src/lessons/dynamo-store.js";
import { retireLesson } from "../../../packages/broker/src/lessons/curate.js";
import { docOf, keepVector, rankLessons } from "../../../packages/broker/src/lessons/similarity.js";
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
/** A vector is only written beside a lesson head (the write is fenced on it): these tests that exercise the vector item alone put a bare head first. */
const seedHeads = (db: FakeDynamoDb, ids: readonly string[]): void => { for (const id of ids) { const head = lessonKey(ORG_A, PROJECT, id); db.set({ ...head, entityType: "LESSON", id }); } };

describe("the vector item", () => {
  it("is one item beside the lesson head, in the project's partition, as 32-bit floats; a spec mismatch is a miss; a new spec replaces the old item", async () => {
    const db = new FakeDynamoDb();
    const vectors = dynamoLessonVectors({ documentClient: db, tableName: "TeamRecord" });
    seedHeads(db, ["les_aaaa1111"]);
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
    seedHeads(db, ids);
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

describe("review M1: a vector write is fenced like the lesson's own commit", () => {
  const embedAll = (lesson: ReturnType<typeof mk>, vectors: ReturnType<typeof dynamoLessonVectors>) => rankLessons({ embedder, vectors }, KEY, [lesson], docOf(mk("les_query001")), { embedMissing: true, queryKind: "document" });
  const world_ = async () => {
    const db = new FakeDynamoDb();
    const table = { documentClient: db, tableName: "TeamRecord" };
    const store = new DynamoLessonStore(table);
    await store.commit(KEY, await store.setVersion(KEY), [mk("les_aaaa1111")], 10);
    return { db, store, vectors: dynamoLessonVectors(table) };
  };

  it("positive control: a lesson that exists gets its vector from the lazy backfill", async () => {
    const { db, vectors } = await world_();
    await embedAll(mk("les_aaaa1111"), vectors);
    expect(vecItems(db).map((i) => i.id)).toEqual(["les_aaaa1111"]);
  });

  it("a purge between the curator's read of the pool and its backfill leaves NO vector (an erased person's lesson text is not kept as an embedding)", async () => {
    const { db, store, vectors } = await world_();
    const racing = { ...vectors, get: async (...args: Parameters<typeof vectors.get>) => { const found = await vectors.get(...args); await store.purge(KEY, "les_aaaa1111"); return found; } };
    const result = await embedAll(mk("les_aaaa1111"), racing);
    expect(result.mode).toBe("fused");
    expect(vecItems(db)).toEqual([]);
    expect(await store.getHead(KEY, "les_aaaa1111")).toBeUndefined();
  });

  it("the purge MARK alone (the head not yet removed) already refuses the write; a withdrawn mark does not", async () => {
    const { db, store, vectors } = await world_();
    await store.markGone(KEY, "les_aaaa1111", "purged");
    await vectors.put(ORG_A, PROJECT, "s", "les_aaaa1111", { hash: "h", vector: vec(1, 0) });
    expect(vecItems(db)).toEqual([]);
    const other = await world_();
    await other.store.markGone(KEY, "les_aaaa1111", "withdrawn");
    await other.vectors.put(ORG_A, PROJECT, "s", "les_aaaa1111", { hash: "h", vector: vec(1, 0) });
    expect(vecItems(other.db)).toHaveLength(1);
  });

  it("a lesson that was never written takes no vector, and the refusal is silent (a no-op, not an error)", async () => {
    const { db, vectors } = await world_();
    await expect(vectors.put(ORG_A, PROJECT, "s", "les_nothere1", { hash: "h", vector: vec(1, 0) })).resolves.toBeUndefined();
    expect(vecItems(db)).toEqual([]);
  });

  it("the write is ONE transaction with both checks and the put", async () => {
    const { db, vectors } = await world_();
    await vectors.put(ORG_A, PROJECT, "s", "les_aaaa1111", { hash: "h", vector: vec(1, 0) });
    const last = db.transactions().at(-1)!;
    expect(last.map((item) => Object.keys(item)[0])).toEqual(["ConditionCheck", "ConditionCheck", "Put"]);
  });
});

describe("review L2: keys the table leaves unprocessed are read again after a wait", () => {
  it("an unprocessed key is retried after a backoff and then found; one that stays unprocessed is a miss", async () => {
    const real = new FakeDynamoDb();
    const head = lessonKey(ORG_A, PROJECT, "les_aaaa1111");
    real.set({ ...head, entityType: "LESSON", id: "les_aaaa1111" });
    const sent: number[] = [];
    let first = true;
    const client = {
      send: async (command: { constructor: { name: string }; input: { RequestItems?: Record<string, { Keys: unknown[] }> } }) => {
        if (command.constructor.name === "BatchGetCommand") {
          sent.push(Date.now());
          if (first) { first = false; return { Responses: {}, UnprocessedKeys: { TeamRecord: { Keys: command.input.RequestItems!["TeamRecord"]!.Keys } } }; }
        }
        return real.send(command);
      },
    };
    const vectors = dynamoLessonVectors({ documentClient: client, tableName: "TeamRecord" });
    await vectors.put(ORG_A, PROJECT, "s", "les_aaaa1111", { hash: "h", vector: vec(1, 0) });
    const got = await vectors.get(ORG_A, PROJECT, "s", ["les_aaaa1111"]);
    expect([...got.keys()]).toEqual(["les_aaaa1111"]);
    expect(sent).toHaveLength(2);
    expect(sent[1]! - sent[0]!).toBeGreaterThanOrEqual(30);
    // Always unprocessed: a miss, never a vector, after a bounded number of tries.
    sent.length = 0;
    const stuck = dynamoLessonVectors({ documentClient: { send: async (c: { constructor: { name: string }; input: { RequestItems: Record<string, { Keys: unknown[] }> } }) => { sent.push(1); return { Responses: {}, UnprocessedKeys: { TeamRecord: { Keys: c.input.RequestItems["TeamRecord"]!.Keys } } }; } }, tableName: "TeamRecord" });
    expect((await stuck.get(ORG_A, PROJECT, "s", ["les_aaaa1111"])).size).toBe(0);
    expect(sent.length).toBe(4);
  });
});
