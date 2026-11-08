// LV-1 (SRL-4 review F1): a lesson learned from a task that was project-wide must stop reaching the project once that task is narrowed. Every lesson read goes through `readVisible`, which asks the
// LIVE visibility of every task the lesson was learned from (`supportTasks`, task citations, the Rovara events it cites), in one batched read, and fails closed.
import { describe, expect, it } from "vitest";
import { OrgIdSchema } from "../../../packages/contracts/src/index.js";
import { buildWeeklyDigest } from "../../../packages/broker/src/lessons/digest.js";
import { learnedContextFromRefs, type DeliveryDeps } from "../../../packages/broker/src/lessons/deliver.js";
import { liveVisible, lessonTaskRefs } from "../../../packages/broker/src/lessons/live-visibility.js";
import { loadLessonsForStage, type LoadDeps, type LoadRequest } from "../../../packages/broker/src/lessons/load.js";
import { readVisible } from "../../../packages/broker/src/lessons/read-visible.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import { buildLessonsView, type LessonViewDeps } from "../../../packages/broker/src/lessons/view.js";
import type { AccessCheckPort } from "../../../packages/broker/src/team-record/access-port.js";
import type { TaskVisibilityPort } from "../../../packages/broker/src/team-record/live-audience.js";
import type { TaskVisibility } from "../../../packages/broker/src/team-record/sources/rovara.js";
import type { Lesson } from "../../../packages/broker/src/lessons/types.js";
import { Audit, Clock, KEY, MemoryVectors, PROJECT, WS, directory, embedder, lessonRecord, seed, settings } from "./lesson-helpers.js";

const SHARED: TaskVisibility = { kind: "shared" };
const PRIVATE_ANN: TaskVisibility = { kind: "private", ownerDeveloperId: "ann" };

/** A port over a table of live visibilities; a task missing from the table reads as unreadable. Counts its batched reads. */
function port(table: Record<string, TaskVisibility | undefined | "throw">) {
  const reads: string[][] = [];
  const value: TaskVisibilityPort = {
    async read(_org, ids) {
      reads.push([...ids]);
      const out = new Map<string, TaskVisibility | undefined>();
      for (const id of ids) {
        const v = table[id];
        if (v === "throw") throw new Error("down");
        out.set(id, v);
      }
      return out;
    },
  };
  return { value, reads };
}
const accessOf = (tasks: TaskVisibilityPort): AccessCheckPort => ({ mayRead: async (_o, _v, places) => places.map(() => true), taskVisibility: tasks });
const fromTasks = (id: string, tasks: string[], over: Partial<Lesson> = {}): Lesson =>
  lessonRecord({ id, type: "convention", tier: 1, approvals: [{ approvalId: "ap", by: "ann", at: 1, mode: "one" }], provenance: { ...lessonRecord().provenance, supportTasks: tasks }, ...over });
const asReader = (developerId: string | undefined) => (developerId === undefined ? undefined : { principals: [], groups: [], developerId });
const idsOf = (lessons: readonly Lesson[]): string[] => lessons.map((l) => l.id);

describe("which tasks a lesson was learned from", () => {
  it("collects supportTasks, task citations, Rovara source events (both id forms), record citations and task places", () => {
    const l = fromTasks("les_aaaaaaa1", ["t1"], {
      citations: [{ kind: "task", taskId: "t2" }, { kind: "record", eventId: "task:t3:sendback:s1" }],
      provenance: { ...lessonRecord().provenance, supportTasks: ["t1"], sourceEvents: ["rovara:task:t4:note:n1", "task:t5", "ev-1", "slack:C1:123"], sourceScopes: ["rovara:project/p", "rovara:task/t6"] },
    });
    expect(lessonTaskRefs(l)).toEqual({ taskIds: ["t1", "t2", "t4", "t5", "t3", "t6"], unreadable: false });
  });
  it("a lesson with no task names none, and a malformed task id is unreadable", () => {
    expect(lessonTaskRefs(fromTasks("les_aaaaaaa1", [], { provenance: { ...lessonRecord().provenance, supportTasks: [], sourceEvents: ["ev-1"] } }))).toEqual({ taskIds: [], unreadable: false });
    expect(lessonTaskRefs(fromTasks("les_aaaaaaa1", ["bad id!"])).unreadable).toBe(true);
  });
});

describe("liveVisible (one module, fail closed)", () => {
  const key = KEY;
  it("a narrowed source task hides the lesson from a project-wide reader; lessons whose tasks are all still project-wide are unchanged", async () => {
    const p = port({ ok: SHARED, narrowed: PRIVATE_ANN });
    const kept = await liveVisible({ port: p.value, key, viewer: undefined, where: "t", lessons: [fromTasks("les_okokokok", ["ok"]), fromTasks("les_narrowed", ["narrowed"])] });
    expect(idsOf(kept)).toEqual(["les_okokokok"]);
  });

  it("a lesson with several source tasks is withheld if any one of them is narrowed", async () => {
    const p = port({ a: SHARED, b: SHARED, c: { kind: "shared_with", developerIds: ["bob", "carl"] } });
    const lessons = [fromTasks("les_all_shrd", ["a", "b"]), fromTasks("les_one_narr", ["a", "b", "c"])];
    expect(idsOf(await liveVisible({ port: p.value, key, viewer: undefined, where: "t", lessons }))).toEqual(["les_all_shrd"]);
    // A shared-task reader (nobody in particular) never reads a task that is not project-wide, and a person without a developer id is the same.
    expect(idsOf(await liveVisible({ port: p.value, key, viewer: { principals: [], groups: [] } as never, where: "t", lessons }))).toEqual(["les_all_shrd"]);
  });

  it("a person allowed on a private task still sees a lesson from it; others do not", async () => {
    const p = port({ mine: PRIVATE_ANN, list: { kind: "shared_with", developerIds: ["ann", "bob"] } });
    const lessons = [fromTasks("les_from_mine", ["mine"]), fromTasks("les_from_list", ["list"]), fromTasks("les_from_both", ["mine", "list"])];
    expect(idsOf(await liveVisible({ port: p.value, key, viewer: asReader("ann"), where: "t", lessons }))).toEqual(["les_from_mine", "les_from_list", "les_from_both"]);
    expect(idsOf(await liveVisible({ port: p.value, key, viewer: asReader("bob"), where: "t", lessons }))).toEqual(["les_from_list"]);
    expect(idsOf(await liveVisible({ port: p.value, key, viewer: asReader("eve"), where: "t", lessons }))).toEqual([]);
  });

  it("a read that throws, a missing task or an unreadable verdict withholds the lesson (and logs counts and codes only)", async () => {
    const lines: Array<[string, Record<string, unknown>]> = [];
    const log = (event: string, fields: Record<string, unknown>): void => { lines.push([event, fields]); };
    const lesson = fromTasks("les_secretone", ["task-secret-id"]);
    expect(await liveVisible({ port: port({ "task-secret-id": "throw" }).value, key, viewer: undefined, where: "t", lessons: [lesson], log })).toEqual([]);
    expect(await liveVisible({ port: port({ "task-secret-id": undefined }).value, key, viewer: undefined, where: "t", lessons: [lesson], log })).toEqual([]);
    expect(await liveVisible({ port: port({}).value, key, viewer: undefined, where: "t", lessons: [lesson], log })).toEqual([]);
    expect(await liveVisible({ port: undefined, key, viewer: undefined, where: "t", lessons: [lesson], log })).toEqual([]);
    expect(await liveVisible({ port: port({ x: SHARED }).value, key, viewer: undefined, where: "t", lessons: [fromTasks("les_badid0001", ["bad id!"])], log })).toEqual([]);
    expect(await liveVisible({ port: port({ x: SHARED }).value, key: { ...key, workspaceId: "not-an-org" }, viewer: undefined, where: "t", lessons: [lesson], log })).toEqual([]);
    expect(lines.length).toBeGreaterThan(0);
    expect(JSON.stringify(lines)).not.toContain("task-secret-id");
    expect(lines.some(([event]) => event === "learning.t_live_withheld")).toBe(true);
  });

  it("a timeout withholds every lesson that names a task", async () => {
    const slow: TaskVisibilityPort = { read: () => new Promise(() => undefined) };
    expect(await liveVisible({ port: slow, key, viewer: undefined, where: "t", timeoutMs: 20, lessons: [fromTasks("les_slowslow1", ["a"])] })).toEqual([]);
  });

  it("batches: one read for all the lessons, none when no lesson names a task, each task asked once", async () => {
    const p = port({ a: SHARED, b: SHARED });
    await liveVisible({ port: p.value, key, viewer: undefined, where: "t", lessons: [fromTasks("les_00000001", ["a", "b"]), fromTasks("les_00000002", ["a"]), fromTasks("les_00000003", ["b"])] });
    expect(p.reads).toEqual([["a", "b"]]);
    const none = port({});
    const free = fromTasks("les_00000004", [], { provenance: { ...lessonRecord().provenance, supportTasks: [], sourceEvents: ["ev-1"] } });
    expect(idsOf(await liveVisible({ port: none.value, key, viewer: undefined, where: "t", lessons: [free] }))).toEqual(["les_00000004"]);
    expect(none.reads).toEqual([]);
  });

  it("past the per-call bound a lesson is withheld, never shown", async () => {
    const table: Record<string, TaskVisibility> = {};
    const lessons = Array.from({ length: 7 }, (_, n) => fromTasks(`les_bound000${String(n)}`, Array.from({ length: 50 }, (_x, i) => { const id = `t${String(n * 50 + i)}`; table[id] = SHARED; return id; })));
    const kept = await liveVisible({ port: port(table).value, key, viewer: undefined, where: "t", lessons });
    expect(idsOf(kept)).toEqual(idsOf(lessons.slice(0, 6)));
  });
});

describe("readVisible applies it (so the delivery, the tab, Home, the digest, the panel and the queues all do)", () => {
  it("hides a lesson from a project-wide reader after its task was narrowed, even when the frozen snapshot and the access records allow it", async () => {
    const tasks: Record<string, TaskVisibility> = { t1: SHARED };
    const access = accessOf({ read: async (_o, ids) => new Map(ids.map((id) => [id, tasks[id]])) });
    const lesson = fromTasks("les_fromtask01", ["t1"]);
    expect(idsOf(await readVisible({ access, key: KEY, viewer: undefined, lessons: [lesson], where: "t" }))).toEqual(["les_fromtask01"]);
    tasks["t1"] = PRIVATE_ANN;
    expect(await readVisible({ access, key: KEY, viewer: undefined, lessons: [lesson], where: "t" })).toEqual([]);
    expect(idsOf(await readVisible({ access, key: KEY, viewer: asReader("ann"), lessons: [lesson], where: "t" }))).toEqual(["les_fromtask01"]);
  });

  it("an access port without the task reader withholds lessons that name a task (fail closed)", async () => {
    const access = { mayRead: async (_o: unknown, _v: unknown, places: readonly unknown[]) => places.map(() => true) } as unknown as AccessCheckPort;
    expect(await readVisible({ access, key: KEY, viewer: undefined, lessons: [fromTasks("les_fromtask01", ["t1"])], where: "t" })).toEqual([]);
  });
});

describe("every read path", () => {
  const T = OrgIdSchema.parse(WS);
  const world = (tasks: Record<string, TaskVisibility | undefined>) => {
    const p = port(tasks);
    return { p, access: accessOf(p.value), store: new InMemoryLessonStore(), clock: new Clock() };
  };
  const narrowed = fromTasks("les_narrowed1", ["tn"]);
  const open = fromTasks("les_stayopen1", ["to"]);
  const tasks = { tn: PRIVATE_ANN, to: SHARED };

  it("dispatch loader: the lesson of a narrowed task is not loaded for a project-wide task, and the loader reads the tasks once", async () => {
    const w = world(tasks);
    const vectors = new MemoryVectors();
    await seed(w.store, narrowed, open);
    for (const l of [narrowed, open]) await vectors.upsert(l.workspaceId, l.project, l.id, await embedder.embed(`${l.title}\n${l.description}\n${l.body}`), { status: l.status });
    const deps: LoadDeps = { access: w.access, store: w.store, embedder, vectors, settings: settings(), audit: new Audit(), now: w.clock.now };
    const request: LoadRequest = { workspaceId: WS, project: PROJECT, taskId: "task-9", stage: "IMPLEMENT", round: 1, intent: "x", repos: ["api"], files: [], languages: [], taskAudience: { kind: "shared" } };
    const result = await loadLessonsForStage(deps, request);
    expect(result.context?.lessons.map((l) => l.id)).toEqual(["les_stayopen1"]);
    expect(w.p.reads.length).toBe(1);
    // The owner's private task still gets the lesson of their own private task (the loader carries the owner's developer id).
    const owner = await loadLessonsForStage(deps, { ...request, taskAudience: { kind: "private", identity: { principals: [], groups: [], developerId: "ann" } } });
    expect(owner.context?.lessons.map((l) => l.id).sort()).toEqual(["les_narrowed1", "les_stayopen1"]);
  });

  it("delivery: the lesson of a narrowed task is not delivered; a private task's owner still gets it", async () => {
    const w = world(tasks);
    await seed(w.store, narrowed, open);
    const deps: DeliveryDeps = { store: w.store, settings: settings(), access: w.access, identity: async () => ({ principals: [], groups: [] }), now: w.clock.now };
    const refs = (audience: { kind: "shared" } | { kind: "private"; developerId: string }) => ({ v: 1 as const, orgId: WS, project: PROJECT, setVersion: 5, stage: "IMPLEMENT" as const, audience, lessons: [{ id: "les_narrowed1", version: 1 }, { id: "les_stayopen1", version: 1 }] });
    expect((await learnedContextFromRefs(deps, refs({ kind: "shared" })))?.lessons.map((l) => l.id)).toEqual(["les_stayopen1"]);
    expect((await learnedContextFromRefs(deps, refs({ kind: "private", developerId: "ann" })))?.lessons.map((l) => l.id)).toEqual(["les_narrowed1", "les_stayopen1"]);
    expect((await learnedContextFromRefs(deps, refs({ kind: "private", developerId: "eve" })))?.lessons.map((l) => l.id)).toEqual(["les_stayopen1"]);
    // A task whose visibility cannot be read delivers nothing from it.
    const down = world({ tn: undefined, to: undefined });
    await seed(down.store, narrowed, open);
    expect(await learnedContextFromRefs({ ...deps, store: down.store, access: down.access }, refs({ kind: "shared" }))).toBeUndefined();
  });

  it("digest, the Lessons tab and the Home count: the lesson of a narrowed task is not listed or counted", async () => {
    const w = world(tasks);
    const pending = (id: string, t: string): Lesson => fromTasks(id, [t], { status: "pending", approvals: [], pendingExpiresAt: 1_900_000_000_000 });
    await seed(w.store, narrowed, open, pending("les_pendnarr01", "tn"), pending("les_pendopen01", "to"));
    const digest = await buildWeeklyDigest(w.store, KEY, w.clock.now(), { principals: [], groups: [] }, w.access);
    expect(digest.top.map((i) => i.id).sort()).toEqual(["les_pendopen01", "les_stayopen1"]);
    expect(digest.waiting.map((i) => i.id)).toEqual(["les_pendopen01"]);
    const dir = directory({ eligibleIds: ["owner", "bob"], ownerIds: ["owner"] });
    dir.identity = async (_ws, developerId) => ({ principals: [], groups: [], developerId });
    const deps: LessonViewDeps = { store: w.store, directory: dir, settings: settings(), access: w.access, now: w.clock.now, names: { isErased: async () => false, memberName: async (_o: string, id: string) => id } };
    const tab = await buildLessonsView(deps, { orgId: T, developerId: "bob" }, PROJECT);
    expect(tab.active.map((l) => l.id)).toEqual(["les_stayopen1"]);
    expect(tab.waiting.map((l) => l.id)).toEqual(["les_pendopen01"]); // the Home card counts `waiting` of this very view
    // The task's owner, who decides here, sees the lessons of their own narrowed task again.
    dir.identity = async (_ws, developerId) => ({ principals: [], groups: [], developerId: developerId === "owner" ? "ann" : developerId });
    const ownerTab = await buildLessonsView(deps, { orgId: T, developerId: "owner" }, PROJECT);
    expect(ownerTab.active.map((l) => l.id).sort()).toEqual(["les_narrowed1", "les_stayopen1"]);
  });
});
