// Lane 7: the replay COPY of a past task, the logic behind `POST /v1/admin/tasks/{taskId}/lessons-replay`. Fakes only: the start, the lesson store, the snapshot store and the audit sink.
import { describe, expect, it } from "vitest";
import { LessonsReplayStartSchema, copyStateOf, planWaitingOf, replayCopyView, requestOf, startReplayCopy, type ReplayCopyDeps } from "../../../packages/broker/src/aws/developer-tasks/lessons-replay.js";
import type { RunStartOptions } from "../../../packages/broker/src/agents/runs.js";
import type { DeveloperTaskRecord } from "../../../packages/broker/src/developer/task-records.js";
import { InMemoryEvalSnapshotStore, InMemorySnapshotStore, buildEvalSnapshot, buildSnapshot, snapshotIdOf, resolveSnapshotLessons } from "../../../packages/broker/src/lessons/replay-snapshot-store.js";
import { lessonContentKey } from "../../../packages/broker/src/lessons/replay-lessonset.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import { Audit, KEY, WS, lessonRecord, seed } from "./lesson-helpers.js";

const REQUEST = "11111111-1111-4111-8111-111111111111";
const source = (over: Record<string, unknown> = {}): DeveloperTaskRecord => ({ taskId: "source-task-1", orgId: WS, project: KEY.project, title: "Retries", requestText: "Use withRetry for the HTTP calls", workflow: { path: "FULL", stage: "WAIT_FOR_MERGE", state: "COMPLETE", artifacts: [], decisions: [] }, ...over }) as unknown as DeveloperTaskRecord;

async function world() {
  const store = new InMemoryLessonStore();
  await seed(store, lessonRecord({ id: "les_aaaaaaaaaaaaaaaaaa01" }), lessonRecord({ id: "les_aaaaaaaaaaaaaaaaaa02", title: "Lint first", body: "Run lint before the tests." }));
  const snapshots = new InMemorySnapshotStore();
  const evalSnapshots = new InMemoryEvalSnapshotStore();
  const audit = new Audit();
  const calls: Array<{ body: Record<string, unknown>; run: RunStartOptions; auditedBefore: number }> = [];
  const deps: ReplayCopyDeps = {
    store, snapshots, evalSnapshots, audit, now: () => 1_800_000_000_000, perTestCapUsd: async () => 5,
    start: async (body, run) => { calls.push({ body, run, auditedBefore: audit.actions().filter((a) => a === "lesson.replay_started").length }); return { task: { taskId: "copy-task-1" } }; },
  };
  const refs = [{ id: "les_aaaaaaaaaaaaaaaaaa01", version: 1 }, { id: "les_aaaaaaaaaaaaaaaaaa02", version: 1 }];
  return { deps, store, snapshots, audit, calls, refs };
}
const input = (body: unknown, over: Partial<{ source: DeveloperTaskRecord }> = {}) => ({ source: over.source ?? source(), orgId: WS, operatorId: "op_aaaaaaaaaaaaaaaaaaaaaaaa", operatorDeveloperId: "o".repeat(64), body });

describe("starting a copy", () => {
  it("starts through startTask with the replay mark set by the start itself, the run's own spend limit, and nothing shared", async () => {
    const w = await world();
    const result = await startReplayCopy(w.deps, input({ requestId: REQUEST, memory: { mode: "off" }, maxUsd: 2.5 }));
    expect(result).toEqual({ taskId: "copy-task-1", evalRun: true, memory: "off" });
    expect(w.calls).toHaveLength(1);
    // A test (billed to the project), started by the OPERATOR, never the past task's member; a workflow of the past task's path.
    expect(w.calls[0]!.run).toMatchObject({ origin: "test_run", autonomous: false, startedBy: { developerId: "o".repeat(64) }, runLimitUsd: 2.5, evalReplay: { memory: { mode: "off" }, sourceTaskId: "source-task-1" } });
    expect(w.calls[0]!.body).toEqual({ requestId: REQUEST, project: KEY.project, instructions: "Use withRetry for the HTTP calls", title: "Lessons replay of source-t", workflow: true, workflowPath: "FULL" });
    // Nothing that shares or publishes is in the start.
    for (const field of ["shareToChannel", "shareMode", "channel", "agent", "input"]) expect(w.calls[0]!.body, field).not.toHaveProperty(field);
  });

  it("an unmarked start is impossible: every start carries evalReplay, whatever the body says; the body has no field that could drop it", async () => {
    const w = await world();
    const id = snapshotIdOf(KEY, w.refs);
    for (const memory of [{ mode: "off" }, { mode: "snapshot", snapshotId: id, lessons: w.refs }, { mode: "snapshot", snapshotId: id }]) {
      await startReplayCopy(w.deps, input({ requestId: REQUEST, memory, maxUsd: 1 }));
    }
    expect(w.calls).toHaveLength(3);
    expect(w.calls.every((c) => c.run.evalReplay !== undefined)).toBe(true);
    for (const extra of [{ evalRun: false }, { evalRun: true }, { evalReplay: undefined }, { workflow: true }, { shareToChannel: true }, { origin: "slack" }, { agent: { agentId: "x" } }]) {
      expect(LessonsReplayStartSchema.safeParse({ requestId: REQUEST, memory: { mode: "off" }, maxUsd: 1, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
    const before = w.calls.length;
    await expect(startReplayCopy(w.deps, input({ requestId: REQUEST, memory: { mode: "off" }, maxUsd: 1, evalRun: false }))).rejects.toThrow(/not valid/);
    expect(w.calls).toHaveLength(before);
  });

  it("memory is off or exactly one snapshot, never live", () => {
    for (const memory of [{ mode: "live" }, { mode: "snapshot" }, { mode: "snapshot", snapshotId: "latest" }, "off", undefined]) {
      expect(LessonsReplayStartSchema.safeParse({ requestId: REQUEST, memory, maxUsd: 1 }).success, JSON.stringify(memory)).toBe(false);
    }
  });

  it("the audit line is written BEFORE the start, with ids and counts only; a ledger that cannot take it stops the start", async () => {
    const w = await world();
    await startReplayCopy(w.deps, input({ requestId: REQUEST, memory: { mode: "snapshot", snapshotId: snapshotIdOf(KEY, w.refs), lessons: w.refs }, maxUsd: 3 }));
    expect(w.calls[0]!.auditedBefore).toBe(1);
    const line = w.audit.events.find((e) => e.action === "lesson.replay_started")!;
    expect(line.facts).toEqual({ operator: "op_aaaaaaaaaaaaaaaaaaaaaaaa", memory: "snapshot", snapshotLessons: 2, maxCents: 300, sourceTask: "source-task-1" });
    expect(JSON.stringify(line)).not.toContain("withRetry");
    const broken = await world();
    broken.audit.emit = async () => { throw new Error("ledger down"); };
    await expect(startReplayCopy(broken.deps, input({ requestId: REQUEST, memory: { mode: "off" }, maxUsd: 1 }))).rejects.toThrow(/audit ledger/);
    expect(broken.calls).toEqual([]);
  });

  it("refuses a copy of a copy, an automatic run, a setup or diagnosis, another company's task, a task with nothing to replay, and the file arm", async () => {
    const w = await world();
    const ok = { requestId: REQUEST, memory: { mode: "off" }, maxUsd: 1 };
    for (const odd of [{ evalRun: true }, { evalRun: "yes" }, { automatic: { job: "x" } }, { purpose: "diagnosis" }, { orgId: "org_bbbbbbbbbbbbbbbbbbbb" }, { requestText: "", title: "" }]) {
      await expect(startReplayCopy(w.deps, input(ok, { source: source(odd) })), JSON.stringify(odd)).rejects.toThrow();
    }
    // The file arm is asked for by a flag; a file's text from the request is not a field.
    await expect(startReplayCopy(w.deps, input({ ...ok, lessonsFile: { path: ".rovara/lessons.md", content: "x" } }))).rejects.toThrow(/not valid/);
    await expect(startReplayCopy(w.deps, input({ ...ok, file: true }))).rejects.toThrow(/needs a snapshot/);
    // Only a workflow task has the shape a copy repeats; a copy runs as a test and stops at the company's per-test cap.
    await expect(startReplayCopy(w.deps, input(ok, { source: source({ workflow: undefined }) }))).rejects.toThrow(/no workflow/);
    await expect(startReplayCopy(w.deps, input({ ...ok, maxUsd: 5.01 }))).rejects.toThrow(/per-test cap/);
    expect(w.calls).toEqual([]);
    expect(requestOf(source({ requestText: "", title: "A title" }))).toBe("A title");
  });
});

describe("snapshots", () => {
  it("one named by lessons is created, audited, and named by its content: an id cannot name other lessons", async () => {
    const w = await world();
    const id = snapshotIdOf(KEY, w.refs);
    await startReplayCopy(w.deps, input({ requestId: REQUEST, memory: { mode: "snapshot", snapshotId: id, lessons: w.refs }, maxUsd: 1 }));
    expect((await w.snapshots.get(KEY, id))!.lessons).toEqual(w.refs);
    expect(w.audit.actions()).toContain("lesson.snapshot_created");
    await expect(startReplayCopy(w.deps, input({ requestId: REQUEST, memory: { mode: "snapshot", snapshotId: id, lessons: [w.refs[0]!] }, maxUsd: 1 }))).rejects.toThrow(/not the one/);
    await expect(startReplayCopy(w.deps, input({ requestId: REQUEST, memory: { mode: "snapshot", snapshotId: `snp_${"0".repeat(20)}` }, maxUsd: 1 }))).rejects.toThrow(/no such snapshot/);
    const ghost = [{ id: "les_ffffffffffffffffffff", version: 1 }];
    await expect(startReplayCopy(w.deps, input({ requestId: REQUEST, memory: { mode: "snapshot", snapshotId: snapshotIdOf(KEY, ghost), lessons: ghost }, maxUsd: 1 }))).rejects.toThrow(/does not exist/);
  });

  it("a snapshot of another project is not found, and resolves to the lessons at the versions it names, never the live set", async () => {
    const w = await world();
    const snapshot = buildSnapshot({ key: KEY, refs: [w.refs[0]!], createdBy: "op", at: "2026-11-01T00:00:00.000Z" });
    await w.snapshots.put(snapshot);
    expect(await w.snapshots.get({ workspaceId: KEY.workspaceId, project: "other" }, snapshot.snapshotId)).toBeUndefined();
    expect((await resolveSnapshotLessons(w.store, KEY, snapshot)).lessons.map((l) => l.id)).toEqual(["les_aaaaaaaaaaaaaaaaaa01"]);
    // The live set holds a second lesson; the snapshot does not.
    expect((await w.store.list(KEY)).map((l) => l.id).sort()).toEqual(["les_aaaaaaaaaaaaaaaaaa01", "les_aaaaaaaaaaaaaaaaaa02"]);
    // A lesson that is gone from the history is left out and the snapshot is incomplete (privacy wins).
    const gone = buildSnapshot({ key: KEY, refs: [{ id: "les_aaaaaaaaaaaaaaaaaa01", version: 9 }], createdBy: "op", at: "2026-11-01T00:00:00.000Z" });
    expect(await resolveSnapshotLessons(w.store, KEY, gone)).toEqual({ lessons: [], incomplete: true });
    expect(await resolveSnapshotLessons(w.store, { workspaceId: KEY.workspaceId, project: "other" }, snapshot)).toEqual({ lessons: [], incomplete: true });
  });

  it("the store refuses an id reused for other content", async () => {
    const w = await world();
    const a = buildSnapshot({ key: KEY, refs: [w.refs[0]!], createdBy: "op", at: "2026-11-01T00:00:00.000Z" });
    expect(await w.snapshots.put(a)).toBe("created");
    expect(await w.snapshots.put(a)).toBe("exists");
    await expect(w.snapshots.put({ ...a, contentDigest: "f".repeat(64) })).rejects.toThrow();
    expect(() => buildSnapshot({ key: KEY, refs: Array.from({ length: 301 }, (_, i) => ({ id: `les_${i.toString(16).padStart(20, "0")}`, version: 1 })), createdBy: "op", at: "2026-11-01T00:00:00.000Z" })).toThrow();
  });
});

describe("reading a copy", () => {
  it("shows the mark as stored and the lessons the copy loaded by content key, from its snapshot loads only", async () => {
    const w = await world();
    const task = source({ taskId: "copy-task-1", evalRun: true, workflow: { stage: "IMPLEMENT", state: "RUNNING", artifacts: [], decisions: [] } });
    await w.store.putManifest({ taskId: "copy-task-1", workspaceId: KEY.workspaceId, project: KEY.project, stage: "IMPLEMENT", round: 1, setVersion: 0, memory: "snapshot", snapshotId: `snp_${"a".repeat(20)}`, at: 1,
      lessons: [{ id: "les_aaaaaaaaaaaaaaaaaa01", version: 1, score: 1, why: "scope", citation: "valid" }], bytes: 10 });
    await w.store.putManifest({ taskId: "copy-task-1", workspaceId: KEY.workspaceId, project: KEY.project, stage: "PLAN", round: 1, setVersion: 3, memory: "live", at: 2,
      lessons: [{ id: "les_aaaaaaaaaaaaaaaaaa02", version: 1, score: 1, why: "scope", citation: "valid" }], bytes: 10 });
    const view = await replayCopyView({ store: w.store }, task, WS, 0.4);
    const lesson = (await w.store.get(KEY, "les_aaaaaaaaaaaaaaaaaa01"))!;
    expect(view).toMatchObject({ taskId: "copy-task-1", evalRun: true, costUsd: 0.4, learningCalls: null, loadedKeys: [lessonContentKey(lesson)] });
  });
});

describe("where a copy stands", () => {
  const wf = (over: Record<string, unknown>) => ({ workflow: { stage: "IMPLEMENT", state: "RUNNING", artifacts: [], decisions: [], revision: 3, ...over } }) as never;
  it("is completed only when the checks and reviews are done and the code is READY to publish, not after a single step", () => {
    expect(copyStateOf(wf({ stage: "PLAN", state: "READY" }))).toBe("running");
    expect(copyStateOf(wf({ stage: "IMPLEMENT", state: "COMPLETE" }))).toBe("running");
    expect(copyStateOf(wf({ stage: "REVIEW", state: "WAITING", candidate: {} }))).toBe("running");
    expect(copyStateOf(wf({ stage: "PULL_REQUEST", state: "READY", candidate: {} }))).toBe("completed");
    expect(copyStateOf(wf({ stage: "PULL_REQUEST", state: "READY" }))).toBe("running");
    expect(copyStateOf({ workflow: undefined, closedAt: undefined } as never)).toBe("running");
  });
  it("is failed when blocked, closed or rejected, and awaiting_plan when a plan waits", () => {
    expect(copyStateOf(wf({ stage: "IMPLEMENT", state: "BLOCKED" }))).toBe("failed");
    expect(copyStateOf(wf({ stage: "CLOSED", state: "COMPLETE" }))).toBe("failed");
    expect(copyStateOf(wf({ outcome: "REJECTED" }))).toBe("failed");
    expect(copyStateOf(wf({ stage: "PLAN_REVIEW", state: "WAITING" }))).toBe("awaiting_plan");
  });
  it("a plan is approvable only at plan review, waiting, with a plan document: the revision and digest the decision names", () => {
    const plan = { type: "plan", sha256: "a".repeat(64) };
    expect(planWaitingOf(wf({ stage: "PLAN_REVIEW", state: "WAITING", artifacts: [{ type: "design", sha256: "b".repeat(64) }, plan] }))).toEqual({ revision: 3, digest: "a".repeat(64) });
    expect(planWaitingOf(wf({ stage: "PLAN_REVIEW", state: "WAITING", artifacts: [] }))).toBeUndefined();
    expect(planWaitingOf(wf({ stage: "IMPLEMENT", state: "RUNNING", artifacts: [plan] }))).toBeUndefined();
    expect(planWaitingOf(wf({ stage: "PLAN_REVIEW", state: "BLOCKED", artifacts: [plan] }))).toBeUndefined();
    expect(planWaitingOf({ workflow: undefined } as never)).toBeUndefined();
  });
});

describe("imported eval snapshots (an arm's own pipeline, built offline)", () => {
  const lesson = (id: string, over: Record<string, unknown> = {}) => lessonRecord({ id, ...over });
  it("a copy can be given one: it holds the lessons' texts, apart from the live set, and its id is made from them", async () => {
    const w = await world();
    const offline = [lesson("les_cccccccccccccccccc01", { title: "Consolidated", body: "Retries go through withRetry." }), lesson("les_cccccccccccccccccc02", { title: "Lint", body: "Lint first." })];
    const snapshot = buildEvalSnapshot({ key: KEY, pipeline: "consolidated", day: "2026-09-01", lessons: offline, createdBy: "op", at: "2026-11-01T00:00:00.000Z" });
    expect(await w.deps.evalSnapshots.put(snapshot)).toBe("created");
    expect(await w.deps.evalSnapshots.put(snapshot)).toBe("exists");
    // None of them is a live lesson.
    expect((await w.store.list(KEY)).map((l) => l.id)).not.toContain("les_cccccccccccccccccc01");
    await startReplayCopy(w.deps, input({ requestId: REQUEST, memory: { mode: "snapshot", snapshotId: snapshot.snapshotId }, maxUsd: 1 }));
    expect(w.calls[0]!.run.evalReplay!.memory).toEqual({ mode: "snapshot", snapshotId: snapshot.snapshotId });
    expect(w.audit.events.find((e) => e.action === "lesson.replay_started")!.facts).toMatchObject({ snapshotLessons: 2 });
    // The id follows the content: other lessons, another id; another project, not found.
    expect(buildEvalSnapshot({ key: KEY, pipeline: "consolidated", day: "2026-09-01", lessons: [offline[0]!], createdBy: "op", at: "2026-11-01T00:00:00.000Z" }).snapshotId).not.toBe(snapshot.snapshotId);
    expect(await w.deps.evalSnapshots.get({ workspaceId: KEY.workspaceId, project: "other" }, snapshot.snapshotId)).toBeUndefined();
  });
  it("is refused when it holds another project's lessons, a lesson that is not active, a lesson twice, or too much", () => {
    const base = { key: KEY, pipeline: "consolidated", day: "2026-09-01", createdBy: "op", at: "2026-11-01T00:00:00.000Z" };
    expect(() => buildEvalSnapshot({ ...base, lessons: [lesson("les_cccccccccccccccccc01", { project: "other" })] })).toThrow(/this project/);
    expect(() => buildEvalSnapshot({ ...base, lessons: [lesson("les_cccccccccccccccccc01", { status: "retired" })] })).toThrow(/active/);
    expect(() => buildEvalSnapshot({ ...base, lessons: [lesson("les_cccccccccccccccccc01"), lesson("les_cccccccccccccccccc01")] })).toThrow(/once/);
    expect(() => buildEvalSnapshot({ ...base, lessons: Array.from({ length: 81 }, (_, i) => lesson(`les_${i.toString(16).padStart(20, "0")}`)) })).toThrow(/at most 80/);
    expect(() => buildEvalSnapshot({ ...base, lessons: [lesson("les_cccccccccccccccccc01", { body: "x".repeat(400_000) })] })).toThrow(/too large|too long|must/);
    expect(() => buildEvalSnapshot({ ...base, day: "tomorrow", lessons: [] })).toThrow();
  });
});
