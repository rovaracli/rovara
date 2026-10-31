// Wiring lane B, LR-W2: the lesson store contract, run against BOTH stores (the in-memory one and the DynamoDB one on a fake table), then what only the DynamoDB store has to get right:
// its keys sit where the project erase wipes them, the fence counter stops a commit that read before an erase, a rollback larger than one transaction still lands, and a purge leaves
// nothing that names the lesson. (The whole learning suite also runs against the DynamoDB store: `vitest.lessons-dynamo.config.ts`.)
import { describe, expect, it } from "vitest";
import { DynamoLessonStore, MAX_COMMIT_WRITES } from "../../../packages/broker/src/lessons/dynamo-store.js";
import { InMemoryLessonStore, type LessonStore, type LoadManifest } from "../../../packages/broker/src/lessons/store.js";
import type { Lesson } from "../../../packages/broker/src/lessons/types.js";
import { eraseProject } from "../../../packages/broker/src/team-record/erase.js";
import { ORG_A, ORG_B, world } from "../../support/team-record-core.js";
import { deleteDeps } from "../../support/team-record-delete.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { draft, lessonRecord } from "./lesson-helpers.js";

const KEY = { workspaceId: ORG_A, project: "web" };
const OTHER = { workspaceId: ORG_B, project: "web" };
const DAY = 86_400_000;
const mk = (id: string, over: Partial<Lesson> = {}): Lesson => lessonRecord({ id, workspaceId: ORG_A, project: "web", ...over });
const restricted = (principals: string[]) => ({ kind: "restricted" as const, acl: { source: "slack", scope: "slack:T1/C1", principals, capturedAt: "2026-10-30T09:00:00.000Z", liveCheck: "none" as const } });
const withAuthors = (id: string, authors: string[], over: Partial<Lesson> = {}): Lesson => mk(id, { provenance: { ...draft().provenance, authors, audience: { kind: "project" } }, ...over });
const manifest = (taskId: string, ids: string[], over: Partial<LoadManifest> = {}): LoadManifest => ({
  taskId, workspaceId: ORG_A, project: "web", stage: "PLAN", round: 1, setVersion: 1, memory: "live", at: 5, bytes: 10,
  lessons: ids.map((id) => ({ id, version: 1, score: 1, why: "scope", citation: "valid" })), ...over,
});
const commit = async (store: LessonStore, ...lessons: Lesson[]) => store.commit(KEY, await store.setVersion(KEY), lessons, 10);

const factories: Array<[string, () => { store: LessonStore; db?: FakeDynamoDb }]> = [
  ["in-memory", () => ({ store: new InMemoryLessonStore() })],
  ["dynamodb", () => { const db = new FakeDynamoDb(); return { store: new DynamoLessonStore({ documentClient: db, tableName: "TeamRecord" }), db }; }],
];

describe.each(factories)("the lesson store contract (%s)", (_name, make) => {
  it("commits in one conditional step: a stale set version or a skipped lesson version is a conflict and changes nothing", async () => {
    const { store } = make();
    expect(await commit(store, mk("les_a0000001"))).toEqual({ ok: true, setVersion: 1 });
    expect(await store.commit(KEY, 0, [mk("les_b0000001")], 1)).toEqual({ ok: false, reason: "conflict" });
    expect(await store.commit(KEY, 1, [{ ...mk("les_a0000001"), version: 3 }], 1)).toEqual({ ok: false, reason: "conflict" });
    expect(await store.get(KEY, "les_b0000001")).toBeUndefined();
    expect(await store.setVersion(KEY)).toBe(1);
    expect(await commit(store, { ...mk("les_a0000001", { title: "Second" }), version: 2 })).toEqual({ ok: true, setVersion: 2 });
    expect((await store.versions(KEY, "les_a0000001")).map((v) => v.title)).toEqual(["Retries use withRetry", "Second"]);
    expect((await store.snapshots(KEY)).map((s) => [s.setVersion, s.members.length])).toEqual([[0, 0], [1, 1], [2, 1]]);
  });
  it("one commit writes a lesson once, and refuses a lesson of another scope", async () => {
    const { store } = make();
    await expect(commit(store, mk("les_a0000001"), mk("les_a0000001"))).rejects.toThrow();
    await expect(commit(store, mk("les_a0000001", { project: "other" }))).rejects.toThrow();
  });
  it("the workspace and project are part of every key: another scope sees nothing", async () => {
    const { store } = make();
    await commit(store, mk("les_a0000001"));
    expect(await store.list(OTHER)).toEqual([]);
    expect(await store.getHead(OTHER, "les_a0000001")).toBeUndefined();
    expect(await store.list({ workspaceId: ORG_A, project: "api" })).toEqual([]);
  });
  it("list and get see the current set; a head outside the set is only in listAllHeads and getHead", async () => {
    const { store } = make();
    await commit(store, mk("les_a0000001"));
    await commit(store, mk("les_b0000001", { status: "pending", approvals: [] }));
    expect((await store.list(KEY)).map((l) => l.id)).toEqual(["les_a0000001", "les_b0000001"]);
    expect((await store.list(KEY, { statuses: ["pending"] })).map((l) => l.id)).toEqual(["les_b0000001"]);
    await store.rollback(KEY, 1, 2, 11);
    expect(await store.get(KEY, "les_b0000001")).toBeUndefined();
    expect((await store.getHead(KEY, "les_b0000001"))?.id).toBe("les_b0000001");
    expect((await store.listAllHeads(KEY)).map((l) => l.id)).toEqual(["les_a0000001", "les_b0000001"]);
  });
  it("mutate changes the volatile fields in place, with no new version, and a commit never rewinds a counter", async () => {
    const { store } = make();
    await commit(store, mk("les_a0000001"));
    const stale = (await store.get(KEY, "les_a0000001"))!;
    const changed = await store.mutate(KEY, "les_a0000001", (l) => ({ counters: { ...l.counters, loaded: l.counters.loaded + 3 } }));
    expect(changed?.counters.loaded).toBe(3);
    expect(await store.versions(KEY, "les_a0000001")).toHaveLength(1);
    expect(await store.mutate(KEY, "les_zzzzzzz1", () => ({ expiresAt: 1 }))).toBeUndefined();
    await commit(store, { ...stale, version: 2, title: "Edited" });
    expect((await store.get(KEY, "les_a0000001"))).toMatchObject({ title: "Edited", counters: { loaded: 3 } });
  });
  it("a rollback restores the earlier set as a NEW set version, pending and needing a person; a tier only rises; usage is not rewound", async () => {
    const { store } = make();
    await commit(store, mk("les_a0000001", { tier: 0 }));
    await commit(store, { ...mk("les_a0000001", { tier: 1, tierReasons: ["escalated"] }), version: 2 });
    await store.mutate(KEY, "les_a0000001", (l) => ({ counters: { ...l.counters, helpful: 4 } }));
    const result = await store.rollback(KEY, 1, 2, 20);
    expect(result).toEqual({ ok: true, setVersion: 3, restored: ["les_a0000001"] });
    const back = (await store.get(KEY, "les_a0000001"))!;
    expect(back).toMatchObject({ version: 1, status: "pending", reviewRequired: true, tier: 1, counters: { helpful: 4 } });
    expect(back.approvals.filter((a) => a.mode === "auto")).toEqual([]);
    expect(await commit(store, { ...back, version: 3, title: "Next" })).toMatchObject({ ok: true });
    expect(await store.rollback(KEY, 5, await store.setVersion(KEY), 1)).toEqual({ ok: false, reason: "conflict" });
    expect(await store.rollback(KEY, 3, 3, 1)).toEqual({ ok: false, reason: "conflict" });
  });
  it("a rollback keeps retired, rejected and withdrawn lessons as they are and skips a purged one", async () => {
    const { store } = make();
    await commit(store, mk("les_ret00001"), mk("les_rej00001"), mk("les_wit00001"), mk("les_pur00001"), mk("les_act00001"));
    await commit(store, { ...mk("les_ret00001", { status: "retired" }), version: 2 }, { ...mk("les_rej00001", { status: "rejected" }), version: 2 });
    await store.markGone(KEY, "les_wit00001", "withdrawn");
    await store.purge(KEY, "les_pur00001");
    const result = await store.rollback(KEY, 1, 2, 30);
    expect(result).toMatchObject({ ok: true });
    expect((await store.get(KEY, "les_ret00001"))?.status).toBe("retired");
    expect((await store.get(KEY, "les_rej00001"))?.status).toBe("rejected");
    expect((await store.get(KEY, "les_pur00001"))).toBeUndefined();
    expect((await store.get(KEY, "les_act00001"))?.status).toBe("pending");
    expect((result as { restored: string[] }).restored).toEqual(["les_act00001", "les_wit00001"].filter((id) => id !== "les_wit00001"));
  });
  it("the fence: an erased person or a deleted row cannot be written back, a narrowing write is scrubbed instead, and a rollback leaves such content alone", async () => {
    const { store } = make();
    await commit(store, withAuthors("les_a0000001", ["mallory"]));
    await store.fence(KEY, { people: ["Mallory"], ids: ["row-1"] });
    expect(await store.isErased(KEY, "MALLORY")).toBe(true);
    expect(await store.isErased(KEY, "ann")).toBe(false);
    expect(await commit(store, withAuthors("les_b0000001", ["MALLORY"]))).toEqual({ ok: false, reason: "erased" });
    expect(await commit(store, { ...withAuthors("les_a0000001", ["mallory"]), version: 2, status: "retired" })).toMatchObject({ ok: true });
    expect((await store.getHead(KEY, "les_a0000001"))?.provenance.authors).toEqual([]);
    const recorded = withAuthors("les_c0000001", ["ann"], { provenance: { ...draft().provenance, authors: ["ann"], sourceEvents: ["row-1"], audience: { kind: "project" } } });
    expect(await commit(store, recorded)).toEqual({ ok: false, reason: "erased" });
  });
  it("the fence holds an erased person's SOURCE ids: they leave a lesson's audience at commit and at rollback", async () => {
    const { store } = make();
    await commit(store, mk("les_a0000001", { provenance: { ...draft().provenance, audience: restricted(["U1", "UX"]) } }));
    await commit(store, { ...mk("les_a0000001", { provenance: { ...draft().provenance, audience: restricted(["U1", "UX"]) } }), version: 2 });
    await store.fence(KEY, { sourceIds: ["UX"] });
    await commit(store, mk("les_b0000001", { provenance: { ...draft().provenance, audience: restricted(["UX", "U2"]) } }));
    expect(JSON.stringify(await store.getHead(KEY, "les_b0000001"))).not.toContain("UX");
    await store.rollback(KEY, 1, await store.setVersion(KEY), 40);
    expect(JSON.stringify(await store.getHead(KEY, "les_a0000001"))).not.toContain("UX");
  });
  it("a rollback leaves a lesson alone while a deletion of it is open", async () => {
    const { store } = make();
    await commit(store, mk("les_a0000001"));
    await commit(store, { ...mk("les_a0000001", { title: "Second" }), version: 2 });
    await store.putIntent(KEY, { id: "int-1", lessonId: "les_a0000001", kind: "forget", cause: "x", deleted: [], outcome: "scrub", inSet: true, done: [], finished: false, at: 1 });
    await store.rollback(KEY, 1, 2, 50);
    expect((await store.get(KEY, "les_a0000001"))).toMatchObject({ version: 2, title: "Second" });
  });
  it("intents: open and finished, listed oldest first, and a finished one is no longer open", async () => {
    const { store } = make();
    const intent = { id: "int-1", lessonId: "les_a0000001", kind: "withdraw" as const, cause: "c", deleted: ["r"], outcome: "withdraw" as const, inSet: true, done: [], finished: false, at: 5 };
    await store.putIntent(KEY, intent);
    await store.putIntent(KEY, { ...intent, id: "int-0", at: 1 });
    expect((await store.listIntents(KEY, { finished: false })).map((i) => i.id)).toEqual(["int-0", "int-1"]);
    await store.putIntent(KEY, { ...intent, done: ["a"], finished: true });
    expect((await store.listIntents(KEY, { finished: false })).map((i) => i.id)).toEqual(["int-0"]);
    expect((await store.listIntents(KEY, { finished: true })).map((i) => i.id)).toEqual(["int-1"]);
    expect((await store.listIntents(KEY)).map((i) => i.id)).toEqual(["int-0", "int-1"]);
    expect(await store.getIntent(KEY, "int-1")).toMatchObject({ finished: true, done: ["a"] });
    expect(await store.getIntent(KEY, "nope")).toBeUndefined();
  });
  it("scrub rewrites the head AND every stored version; a purged lesson stays gone, with its manifest entries, once-keys and pending outcomes", async () => {
    const { store } = make();
    await commit(store, withAuthors("les_a0000001", ["mallory"]));
    await commit(store, { ...withAuthors("les_a0000001", ["mallory"]), version: 2 });
    await store.scrub(KEY, "les_a0000001", (l) => ({ ...l, provenance: { ...l.provenance, authors: [] } }));
    expect(JSON.stringify([await store.getHead(KEY, "les_a0000001"), await store.versions(KEY, "les_a0000001")])).not.toContain("mallory");
    expect((await store.versions(KEY, "les_a0000001")).map((v) => v.version)).toEqual([1, 2]);
    await commit(store, mk("les_b0000001"));
    await store.putManifest(manifest("task-1", ["les_a0000001", "les_b0000001"]));
    expect(await store.markOnce(KEY, "harmful:task-1:les_a0000001")).toBe(true);
    expect(await store.markOnce(KEY, "harmful:task-1:les_a0000001")).toBe(false);
    expect(await store.markOnce(KEY, "report:task-1:PLAN:1")).toBe(true);
    await store.addPending({ key: "helpful:task-1:les_a0000001", ...KEY, lessonId: "les_a0000001", taskId: "task-1", dueAt: 5 });
    await store.addPending({ key: "helpful:task-1:les_b0000001", ...KEY, lessonId: "les_b0000001", taskId: "task-1", dueAt: 6 });
    await store.purge(KEY, "les_a0000001");
    expect(await store.getHead(KEY, "les_a0000001")).toBeUndefined();
    expect(await store.versions(KEY, "les_a0000001")).toEqual([]);
    expect(await store.get(KEY, "les_a0000001")).toBeUndefined();
    expect((await store.manifests(KEY, "task-1"))[0]!.lessons.map((e) => e.id)).toEqual(["les_b0000001"]);
    expect(await store.markOnce(KEY, "harmful:task-1:les_a0000001")).toBe(true);
    expect(await store.markOnce(KEY, "report:task-1:PLAN:1")).toBe(false);
    expect((await store.duePending(KEY, 100, 10)).map((p) => p.lessonId)).toEqual(["les_b0000001"]);
    expect(await commit(store, { ...mk("les_a0000001"), version: 1 })).toEqual({ ok: false, reason: "erased" });
  });
  it("manifests: written once, listed by task, updated in place", async () => {
    const { store } = make();
    expect(await store.putManifest(manifest("task-1", []))).toBe(true);
    expect(await store.putManifest(manifest("task-1", []))).toBe(false);
    await store.putManifest(manifest("task-1", [], { stage: "REVIEW", at: 9 }));
    await store.putManifest(manifest("task-2", []));
    expect((await store.manifests(KEY, "task-1")).map((m) => m.stage)).toEqual(["PLAN", "REVIEW"]);
    await store.updateManifest(manifest("task-1", [], { bytes: 99 }));
    expect((await store.manifests(KEY, "task-1"))[0]!.bytes).toBe(99);
    await store.updateManifest(manifest("task-9", []));
    expect(await store.manifests(KEY, "task-9")).toEqual([]);
  });
  it("pending outcomes: due ones oldest first up to the limit; the same key again replaces; remove drops it", async () => {
    const { store } = make();
    const entry = (key: string, dueAt: number) => ({ key, ...KEY, lessonId: "les_a0000001", taskId: "t", dueAt });
    await store.addPending(entry("b", 20)); await store.addPending(entry("a", 10)); await store.addPending(entry("c", 30));
    expect((await store.duePending(KEY, 25, 10)).map((p) => p.key)).toEqual(["a", "b"]);
    expect((await store.duePending(KEY, 100, 2)).map((p) => p.key)).toEqual(["a", "b"]);
    await store.addPending(entry("a", 50));
    expect((await store.duePending(KEY, 25, 10)).map((p) => p.key)).toEqual(["b"]);
    await store.removePending(KEY, "b");
    await store.removePending(KEY, "missing");
    expect((await store.duePending(KEY, 100, 10)).map((p) => p.key)).toEqual(["c", "a"]);
  });
  it("source events: counted per day back from now, every spelling of a person is one source, and forgetting removes the counts and the pause", async () => {
    const { store } = make();
    const now = 100 * DAY;
    for (const at of [now, now - DAY + 1, now - DAY, now - 3 * DAY, now - 14 * DAY, now + 1]) await store.recordSourceEvent(KEY, { at, source: "member:Mallory" });
    await store.recordSourceEvent(KEY, { at: now, source: " member: mallory " });
    await store.recordSourceEvent(KEY, { at: now, source: "slack:C1" });
    expect(await store.sourceDays(KEY, "member:mallory", 4, now)).toEqual([3, 1, 0, 1]);
    expect((await store.sourceDays(KEY, "member:MALLORY", 15, now)).reduce((a, b) => a + b, 0)).toBe(6);
    await store.setFlags(KEY, { pausedSources: { "member:Mallory": { at: 1, reason: "spike" }, "slack:C1": { at: 1, reason: "spike" } } });
    await store.forgetSource(KEY, "member:mallory");
    expect(await store.sourceDays(KEY, "member:mallory", 15, now)).toEqual(new Array(15).fill(0));
    expect(await store.sourceDays(KEY, "slack:C1", 2, now)).toEqual([1, 0]);
    expect(Object.keys((await store.flags(KEY)).pausedSources ?? {})).toEqual(["slack:C1"]);
    expect(await make().store.flags(KEY)).toEqual({});
  });
});

describe("the DynamoDB lesson store only", () => {
  const dynamo = () => { const db = new FakeDynamoDb(); return { db, store: new DynamoLessonStore({ documentClient: db, tableName: "TeamRecord" }) }; };

  it("every item sits where the project erase wipes it: nothing is left after eraseProject", async () => {
    const w = world();
    const store = new DynamoLessonStore(w.table);
    await commit(store, mk("les_a0000001", { provenance: { ...draft().provenance, audience: restricted(["U1"]) } }), mk("les_b0000001"));
    await commit(store, { ...mk("les_a0000001"), version: 2 });
    await store.putManifest(manifest("task-1", ["les_a0000001"]));
    await store.markOnce(KEY, "harmful:task-1:les_a0000001");
    await store.markOnce(KEY, "report:task-1:PLAN:1");
    await store.addPending({ key: "helpful:task-1:les_a0000001", ...KEY, lessonId: "les_a0000001", taskId: "task-1", dueAt: 5 });
    await store.recordSourceEvent(KEY, { at: 5, source: "slack:C1" });
    await store.setFlags(KEY, { volumeAlertedAt: 3 });
    await store.fence(KEY, { people: ["mallory"], ids: ["row-1"], sourceIds: ["UX"] });
    await store.putIntent(KEY, { id: "int-1", lessonId: "les_b0000001", kind: "forget", cause: "x", deleted: [], outcome: "scrub", inSet: true, done: [], finished: false, at: 1 });
    await store.putIntent(KEY, { id: "int-2", lessonId: "les_b0000001", kind: "forget", cause: "x", deleted: [], outcome: "scrub", inSet: true, done: [], finished: true, at: 2 });
    await store.markGone(KEY, "les_b0000001", "withdrawn");
    expect(w.db.find((item) => String(item.pk).includes("#P#web")).length).toBeGreaterThan(15);
    const result = await eraseProject(deleteDeps(w, { lessonVectors: { async removeAll() { /* vectors are the caller's */ } } }).deps, ORG_A, "web", "project_archived", "arch-1");
    expect(result.complete).toBe(true);
    expect(w.db.find((item) => String(item.pk).includes("#P#web"))).toEqual([]);
  });

  it("a commit that read before an erase fenced fails its transaction and then sees the fence", async () => {
    const db = new FakeDynamoDb();
    const store = new DynamoLessonStore({ documentClient: db, tableName: "TeamRecord" });
    await commit(store, withAuthors("les_a0000001", ["ann"]));
    // The writer reads now; the erase fences between the writer's reads and its transaction.
    let fenced = false;
    const racing = new DynamoLessonStore({
      documentClient: { send: async (command: unknown) => {
        if (!fenced && (command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand") { fenced = true; await store.fence(KEY, { people: ["mallory"] }); }
        return db.send(command as never);
      } },
      tableName: "TeamRecord",
    });
    const result = await racing.commit(KEY, 1, [withAuthors("les_b0000001", ["Mallory"])], 5);
    expect(fenced).toBe(true);
    expect(result).toEqual({ ok: false, reason: "erased" });
    expect(await store.getHead(KEY, "les_b0000001")).toBeUndefined();
  });

  it("a rollback that restores more heads than one transaction holds still lands, every restored lesson pending", async () => {
    const { store, db } = dynamo();
    const ids = Array.from({ length: 130 }, (_, i) => `les_big${String(i).padStart(5, "0")}`);
    for (const group of [ids.slice(0, 40), ids.slice(40, 80), ids.slice(80, 120), ids.slice(120)]) await commit(store, ...group.map((id) => mk(id)));
    await commit(store, ...ids.slice(0, 40).map((id) => ({ ...mk(id, { title: "Later" }), version: 2 })));
    await commit(store, ...ids.slice(40, 80).map((id) => ({ ...mk(id, { title: "Later" }), version: 2 })));
    await commit(store, ...ids.slice(80, 120).map((id) => ({ ...mk(id, { title: "Later" }), version: 2 })));
    await commit(store, ...ids.slice(120).map((id) => ({ ...mk(id, { title: "Later" }), version: 2 })));
    const before = db.transactionLog.length;
    const result = await store.rollback(KEY, 4, 8, 99);
    expect(result).toMatchObject({ ok: true, setVersion: 9 });
    expect((result as { restored: string[] }).restored).toHaveLength(130);
    expect(db.transactionLog.length - before).toBeGreaterThan(1);
    const list = await store.list(KEY);
    expect(list).toHaveLength(130);
    expect(new Set(list.map((l) => l.status))).toEqual(new Set(["pending"]));
    expect(new Set(list.map((l) => l.title))).toEqual(new Set(["Retries use withRetry"]));
  });

  it("is bounded: a commit of too many lessons and a set past its limit throw, writing nothing", async () => {
    const { store } = dynamo();
    await expect(commit(store, ...Array.from({ length: MAX_COMMIT_WRITES + 1 }, (_, i) => mk(`les_many${String(i).padStart(4, "0")}`)))).rejects.toThrow();
    expect(await store.setVersion(KEY)).toBe(0);
  });

  it("a counter changed while a writer decides is not overwritten, and a lost head race retries on fresh state", async () => {
    const db = new FakeDynamoDb();
    const store = new DynamoLessonStore({ documentClient: db, tableName: "TeamRecord" });
    await commit(store, mk("les_a0000001"));
    let once = false;
    const racing = new DynamoLessonStore({
      documentClient: { send: async (command: unknown) => {
        if (!once && (command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand") { once = true; await store.mutate(KEY, "les_a0000001", (l) => ({ counters: { ...l.counters, loaded: 7 } })); }
        return db.send(command as never);
      } },
      tableName: "TeamRecord",
    });
    const stale = (await racing.get(KEY, "les_a0000001"))!;
    const result = await racing.commit(KEY, 1, [{ ...stale, version: 2, title: "Edited" }], 5);
    expect(result).toEqual({ ok: true, setVersion: 2 });
    expect(await store.get(KEY, "les_a0000001")).toMatchObject({ title: "Edited", counters: { loaded: 7 } });
  });
});
