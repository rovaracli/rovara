// Lane 7: a replay copy's memory. `off` loads nothing; a frozen snapshot loads EXACTLY its lessons, at the versions it names, and never the live set; the install's lessons switch does not decide it (the plan names
// that), the project's own mode still does; the copy's loads are eval loads (the live counters never see them); delivery reads the same snapshot.
import { afterEach, describe, expect, it } from "vitest";
import { learnedContextForOperation } from "../../../packages/broker/src/aws/broker/lessons-dispatch.js";
import { applyLoadReport } from "../../../packages/broker/src/lessons/counters.js";
import { learnedContextFromRefs, type DeliveryDeps } from "../../../packages/broker/src/lessons/deliver.js";
import { loadLessonsForStage, type LoadDeps, type LoadRequest } from "../../../packages/broker/src/lessons/load.js";
import { setLearnedLessonsGate } from "../../../packages/broker/src/lessons/policy.js";
import { InMemorySnapshotStore, buildSnapshot } from "../../../packages/broker/src/lessons/replay-snapshot-store.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import type { Lesson } from "../../../packages/broker/src/lessons/types.js";
import { Audit, Clock, KEY, MemoryVectors, PROJECT, WS, allSharedTasks, allowAllAccess, embedder, lessonRecord, seed, settings } from "./lesson-helpers.js";

afterEach(() => { setLearnedLessonsGate(undefined); });
const ann = { approvalId: "ap-ann", by: "ann", at: 1, mode: "one" as const };
const conv = (id: string, over: Partial<Lesson> = {}): Lesson => lessonRecord({ id, type: "convention", tier: 1, stages: ["UNDERSTAND", "PLAN", "IMPLEMENT"], approvals: [ann], scope: {}, ...over });
const A = "les_aaaaaaaaaaaaaaaaaa01", B = "les_aaaaaaaaaaaaaaaaaa02", C = "les_aaaaaaaaaaaaaaaaaa03";
const request = (over: Partial<LoadRequest> = {}): LoadRequest => ({ workspaceId: WS, project: PROJECT, taskId: "copy-1", stage: "IMPLEMENT", round: 1, intent: "Retry failed HTTP calls", repos: ["api"], files: [], languages: [], taskAudience: { kind: "shared" }, ...over });
const ids = (r: Awaited<ReturnType<typeof loadLessonsForStage>>): string[] => (r.context?.lessons.map((l) => l.id) ?? []).sort();

async function world(s = settings({ mode: "On" })) {
  const store = new InMemoryLessonStore();
  const clock = new Clock();
  const deps: LoadDeps = { store, vectors: new MemoryVectors(), embedder, settings: s, access: allowAllAccess, audit: new Audit(), now: clock.now };
  await seed(store, conv(A, { title: "Use withRetry" }), conv(B, { title: "Lint first", body: "Run lint before the tests." }), conv(C, { title: "Live only", body: "Only the live set has this one." }));
  return { store, clock, deps };
}
const snapshotOf = (store: InMemoryLessonStore, ids: string[]) => store.list(KEY).then((all) => all.filter((l) => ids.includes(l.id)));

describe("the loader", () => {
  it("loads exactly the snapshot's lessons even though the live set holds more, and files the load as an eval load", async () => {
    const w = await world();
    const lessons = await snapshotOf(w.store, [A, B]);
    const live = await loadLessonsForStage(w.deps, request());
    expect(ids(live)).toEqual([A, B, C].sort());
    const result = await loadLessonsForStage(w.deps, request({ memory: { mode: "snapshot", snapshotId: `snp_${"a".repeat(20)}`, lessons } }));
    expect(ids(result)).toEqual([A, B]);
    expect(result.manifest).toMatchObject({ memory: "snapshot", snapshotId: `snp_${"a".repeat(20)}` });
    expect(result.manifest.lessons.map((e) => e.id).sort()).toEqual([A, B]);
  });
  it("is not decided by the install's lessons switch (a normal load is), but the project's own mode still decides", async () => {
    setLearnedLessonsGate(() => false);
    const w = await world();
    const lessons = await snapshotOf(w.store, [A]);
    expect(await loadLessonsForStage(w.deps, request())).toMatchObject({ skipped: "mode" });
    expect(ids(await loadLessonsForStage(w.deps, request({ memory: { mode: "snapshot", snapshotId: `snp_${"a".repeat(20)}`, lessons } })))).toEqual([A]);
    const off = await world(settings({ mode: "Off" }));
    expect(await loadLessonsForStage(off.deps, request({ memory: { mode: "snapshot", snapshotId: `snp_${"a".repeat(20)}`, lessons: await snapshotOf(off.store, [A]) } }))).toMatchObject({ skipped: "mode" });
  });
  it("memory off loads nothing, and the live set is never read for a snapshot", async () => {
    const w = await world();
    expect(await loadLessonsForStage(w.deps, request({ memory: { mode: "off" } }))).toMatchObject({ skipped: "memory_off" });
    let listed = 0;
    const list = w.store.list.bind(w.store);
    w.store.list = async (...args) => { listed += 1; return list(...args); };
    await loadLessonsForStage(w.deps, request({ memory: { mode: "snapshot", snapshotId: `snp_${"a".repeat(20)}`, lessons: await snapshotOf(w.store, [A]) } }));
    expect(listed).toBe(1); // only the snapshotOf helper above
  });
  it("a snapshot's lesson that was not active when frozen, or belongs to another project, is not loaded; a frozen lesson loads even if it has expired since", async () => {
    const w = await world();
    const frozen = [conv(A, { expiresAt: 5 }), conv(B, { status: "retired" }), conv(C, { project: "other" })];
    expect(ids(await loadLessonsForStage(w.deps, request({ memory: { mode: "snapshot", snapshotId: `snp_${"a".repeat(20)}`, lessons: frozen } })))).toEqual([A]);
  });
  it("a copy's load report never touches the live lessons", async () => {
    const w = await world();
    const lessons = await snapshotOf(w.store, [A]);
    const result = await loadLessonsForStage(w.deps, request({ memory: { mode: "snapshot", snapshotId: `snp_${"a".repeat(20)}`, lessons } }));
    expect(result.manifest.memory).toBe("snapshot");
    const counters = { access: undefined as never, store: w.store, judge: { rate: async () => { throw new Error("no"); } }, settings: settings({ mode: "On" }), audit: new Audit(), alerts: { alert: async () => undefined }, now: w.clock.now };
    await applyLoadReport(counters, { workspaceId: WS, project: PROJECT, taskId: "copy-1", stage: "IMPLEMENT", round: 1, report: { stage: "IMPLEMENT", lessons: [{ id: A, version: 1, citation: "valid" }] } as never });
    expect((await w.store.get(KEY, A))!.counters.loaded).toBe(0);
    // Positive control: the same report for a live load counts.
    const liveResult = await loadLessonsForStage(w.deps, request({ taskId: "live-1" }));
    await w.store.putManifest(liveResult.manifest).catch(() => undefined);
    await applyLoadReport(counters, { workspaceId: WS, project: PROJECT, taskId: "live-1", stage: "IMPLEMENT", round: 1, report: { stage: "IMPLEMENT", lessons: [{ id: A, version: 1, citation: "valid" }] } as never });
    expect((await w.store.get(KEY, A))!.counters.loaded).toBe(1);
  });
});

describe("the dispatch", () => {
  const definition = { repositories: [{ name: "api", url: "https://github.com/acme/api" }] } as never;
  const taskOf = (over: Record<string, unknown> = {}) => ({ taskId: "copy-1", orgId: WS, project: PROJECT, title: "Retry failed HTTP calls", shared: true, developerId: "d".repeat(64), developerName: "Maya", provider: "slack", workflow: { revision: 4 }, ...over });
  async function host() {
    const w = await world();
    const snapshots = new InMemorySnapshotStore();
    const snapshot = buildSnapshot({ key: KEY, refs: [{ id: A, version: 1 }], createdBy: "op", at: "2026-11-01T00:00:00.000Z" });
    await snapshots.put(snapshot);
    return { w, snapshot, host: { lessons: { load: w.deps, store: w.store, snapshots } } as never };
  }
  const ask = (h: never, task: Record<string, unknown>, env: NodeJS.ProcessEnv) => learnedContextForOperation(h, { orgId: WS, task: task as never, workflowMode: "IMPLEMENT", definition }, env);

  it("a copy with a snapshot is delivered exactly that snapshot with the install's switch off; the refs name the snapshot", async () => {
    const { host: h, snapshot } = await host();
    const result = await ask(h, taskOf({ evalRun: true, evalMemory: { mode: "snapshot", snapshotId: snapshot.snapshotId } }), {});
    expect(result.learnedRefs).toMatchObject({ snapshotId: snapshot.snapshotId, lessons: [{ id: A, version: 1 }] });
    expect(JSON.stringify(result)).not.toContain("Use withRetry");
    // Control: an ordinary task with the same switch off gets nothing; with it on it gets the live set.
    expect(await ask(h, taskOf(), {})).toEqual({});
    expect((await ask(h, taskOf(), { LEARNED_LESSONS_ENABLED: "1" })).learnedRefs?.lessons.length).toBe(3);
  });
  it("the file arm's refs name the repository whose checkout gets the file; without the mark they do not, and a project with no code repository sends nothing", async () => {
    const { host: h, snapshot } = await host();
    const memory = { mode: "snapshot", snapshotId: snapshot.snapshotId };
    expect((await ask(h, taskOf({ evalRun: true, evalMemory: memory, evalLessonsFile: true }), {})).learnedRefs).toMatchObject({ snapshotId: snapshot.snapshotId, file: { repository: "api" } });
    expect((await ask(h, taskOf({ evalRun: true, evalMemory: memory }), {})).learnedRefs).not.toHaveProperty("file");
    const none = await learnedContextForOperation(h, { orgId: WS, task: taskOf({ evalRun: true, evalMemory: memory, evalLessonsFile: true }) as never, workflowMode: "IMPLEMENT", definition: { repositories: [] } }, {});
    expect(none).toEqual({});
  });
  it("a copy with memory off, a mark with no memory, a snapshot that does not exist, and a bad memory all get nothing", async () => {
    const { host: h } = await host();
    expect(await ask(h, taskOf({ evalRun: true, evalMemory: { mode: "off" } }), { LEARNED_LESSONS_ENABLED: "1" })).toEqual({});
    expect(await ask(h, taskOf({ evalRun: true }), { LEARNED_LESSONS_ENABLED: "1" })).toEqual({});
    expect(await ask(h, taskOf({ evalMemory: { mode: "snapshot", snapshotId: `snp_${"a".repeat(20)}` } }), { LEARNED_LESSONS_ENABLED: "1" })).toEqual({});
    expect(await ask(h, taskOf({ evalRun: true, evalMemory: { mode: "snapshot", snapshotId: `snp_${"9".repeat(20)}` } }), { LEARNED_LESSONS_ENABLED: "1" })).toEqual({});
    expect(await ask(h, taskOf({ evalRun: true, evalMemory: { mode: "live" } }), { LEARNED_LESSONS_ENABLED: "1" })).toEqual({});
  });
});

describe("delivery", () => {
  async function delivery() {
    const store = new InMemoryLessonStore();
    await seed(store, conv(A, { title: "Old words", body: "The first wording." }), conv(B));
    // The live lesson moved on to version 2 after the snapshot was frozen.
    await store.commit(KEY, await store.setVersion(KEY), [{ ...conv(A, { title: "New words", body: "The second wording." }), version: 2, updatedAt: 5 }], 1);
    const snapshots = new InMemorySnapshotStore();
    const snapshot = buildSnapshot({ key: KEY, refs: [{ id: A, version: 1 }], createdBy: "op", at: "2026-11-01T00:00:00.000Z" });
    await snapshots.put(snapshot);
    const deps: DeliveryDeps = { store, snapshots, settings: settings({ mode: "On" }), access: { ...allowAllAccess, taskVisibility: allSharedTasks }, identity: async () => ({ principals: [], groups: [] }), now: new Clock().now };
    const refs = (over: Record<string, unknown> = {}) => ({ v: 1 as const, orgId: WS, project: PROJECT, setVersion: 0, stage: "IMPLEMENT" as const, audience: { kind: "shared" as const }, taskId: "copy-1", snapshotId: snapshot.snapshotId, lessons: [{ id: A, version: 1 }], ...over });
    return { deps, refs, store };
  }
  it("delivers the version the snapshot names, not the live head, with the install's switch off", async () => {
    setLearnedLessonsGate(() => false);
    const w = await delivery();
    expect((await learnedContextFromRefs(w.deps, w.refs()))?.lessons.map((l) => [l.id, l.title])).toEqual([[A, "Old words"]]);
    // Control: the same ref without the snapshot is the old version, which is no longer the live one: nothing is delivered.
    expect(await learnedContextFromRefs(w.deps, w.refs({ snapshotId: undefined }))).toBeUndefined();
  });
  it("delivers nothing for a lesson the snapshot does not name, a snapshot that is missing, or no snapshot store", async () => {
    const w = await delivery();
    expect(await learnedContextFromRefs(w.deps, w.refs({ lessons: [{ id: B, version: 1 }] }))).toBeUndefined();
    expect(await learnedContextFromRefs(w.deps, w.refs({ lessons: [{ id: A, version: 2 }] }))).toBeUndefined();
    expect(await learnedContextFromRefs(w.deps, w.refs({ snapshotId: `snp_${"9".repeat(20)}` }))).toBeUndefined();
    expect(await learnedContextFromRefs((({ snapshots: _snapshots, ...rest }) => { void _snapshots; return rest; })(w.deps), w.refs())).toBeUndefined();
  });
  it("the project's own mode still decides", async () => {
    const w = await delivery();
    expect(await learnedContextFromRefs({ ...w.deps, settings: settings({ mode: "Off" }) }, w.refs())).toBeUndefined();
  });
});
