// Lane 7: the pieces that sit between the harness and a real install: the executor that cannot start an unmarked task, the blind rubric grader, pipeline B read as of a date, and the candidates exporter.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main as exportCandidates } from "../../../scripts/export-replay-candidates.js";
import { main as measure } from "../../../scripts/lessons-replay-measure.js";
import { candidatesFromItems } from "../../../packages/broker/src/lessons/replay-candidates.js";
import { rubricGrader, DEFAULT_RUBRIC, type GraderModel } from "../../../packages/broker/src/lessons/replay-grader.js";
import { EvalMarkError, buildReplayPlan, buildSnapshots, dayOf, runReplay, type PlannedRun, type ReplayExecutor } from "../../../packages/broker/src/lessons/replay-harness.js";
import { asOfSnapshotBuilder, lessonsAsOf } from "../../../packages/broker/src/lessons/replay-asof.js";
import { stagingExecutor, type ReplayStartRequest, type ReplayTaskPort } from "../../../packages/broker/src/lessons/replay-executor.js";
import { lessonContentKey } from "../../../packages/broker/src/lessons/replay-lessonset.js";
import type { ReplayCandidate } from "../../../packages/broker/src/lessons/replay-select.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import { KEY, lessonRecord, seed } from "./lesson-helpers.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 1);
const task: ReplayCandidate = { taskId: "t1", project: "p", repository: "api", at: T0, memberCorrections: 2, outcome: "merged" };
const run = (over: Partial<PlannedRun> = {}): PlannedRun => ({ key: "k1", task: "t1", repeat: 1, arm: "on:current", day: "2026-09-01", memory: { mode: "snapshot", snapshotId: `snp_${"a".repeat(20)}` }, evalRun: true, ...over });

class Port implements ReplayTaskPort {
  requests: ReplayStartRequest[] = [];
  cancelled: string[] = [];
  constructor(public mark: unknown = true) {}
  async start(request: ReplayStartRequest): Promise<{ taskId: string }> { this.requests.push(request); return { taskId: `replay-${String(this.requests.length)}` }; }
  async readMark(): Promise<unknown> { return this.mark; }
  async cancel(taskId: string): Promise<void> { this.cancelled.push(taskId); }
  async waitForEnd(): Promise<{ state: "completed"; evidence: string; costUsd: number }> { return { state: "completed", evidence: "pr:7", costUsd: 0.3 }; }
  async loadedLessons(): Promise<Array<{ title: string; body: string }>> { return [{ title: "Use withRetry", body: "Use withRetry for HTTP retries." }]; }
  async learningCalls(): Promise<number> { return 0; }
}

describe("the staging executor", () => {
  it("starts the task marked as an eval run with the arm's memory input, reads the mark back, and returns the load keys", async () => {
    const port = new Port();
    const result = await stagingExecutor(port).run({ run: run(), task, learning: { lessonsSwitch: "off", calls: "none" } });
    expect(port.requests).toEqual([{ sourceTaskId: "t1", runKey: "k1", evalRun: true, memory: { mode: "snapshot", snapshotId: `snp_${"a".repeat(20)}` } }]);
    expect(result).toEqual({ loaded: [lessonContentKey({ title: "Use withRetry", body: "Use withRetry for HTTP retries." })], costUsd: 0.3, evidence: "pr:7", evalRunMarked: true, learningCalls: 0 });
  });
  it("an unmarked start is impossible: a plan without the mark never starts a task", async () => {
    const port = new Port();
    await expect(stagingExecutor(port).run({ run: run({ evalRun: false as never }), task, learning: { lessonsSwitch: "off", calls: "none" } })).rejects.toThrow(EvalMarkError);
    expect(port.requests).toEqual([]);
  });
  it("an unmarked start is impossible: a port that dropped, changed or could not show the mark gets the task cancelled and the replay stopped", async () => {
    for (const mark of [undefined, false, "yes", 1, {}]) {
      const port = new Port();
      port.mark = mark;
      await expect(stagingExecutor(port).run({ run: run(), task, learning: { lessonsSwitch: "off", calls: "none" } }), JSON.stringify(mark)).rejects.toThrow(EvalMarkError);
      expect(port.cancelled, JSON.stringify(mark)).toEqual(["replay-1"]);
    }
    const unreadable = new Port();
    unreadable.readMark = async () => { throw new Error("down"); };
    await expect(stagingExecutor(unreadable).run({ run: run(), task, learning: { lessonsSwitch: "off", calls: "none" } })).rejects.toThrow(EvalMarkError);
    expect(unreadable.cancelled).toHaveLength(1);
  });
  it("through the harness, an unmarked task stops the WHOLE replay instead of becoming one ungraded run", async () => {
    const tasks = Array.from({ length: 4 }, (_, i) => ({ ...task, taskId: `t${String(i)}`, at: T0 + i * DAY }));
    const plan = buildReplayPlan({ tasks, arms: ["off", "on:current"], seed: "s", grader: { model: "g", version: "1" }, snapshots: { current: Object.fromEntries(tasks.map((t) => [dayOf(t.at), `snp_${"b".repeat(20)}`])) }, allowSmall: true, repeats: 1 });
    const appended: string[] = [];
    await expect(runReplay(plan, {
      executor: stagingExecutor(Object.assign(new Port(), { mark: false })), grader: { identity: { model: "g", version: "1" }, grade: async () => ({ resolved: true, gradedBy: "rubric", mistakes: [] }) },
      sink: { done: () => new Set(), append: async (k) => { appended.push(k); } }, priorCorrections: async () => [], maxUsd: 100,
    })).rejects.toThrow(EvalMarkError);
    expect(appended).toEqual([]);
  });
  it("a task that does not complete is one ungraded run, not a stop", async () => {
    const port = new Port();
    port.waitForEnd = async () => ({ state: "failed" as never, evidence: "", costUsd: 0 });
    const tasks = [task];
    const plan = buildReplayPlan({ tasks, arms: ["off", "on:current"], seed: "s", grader: { model: "g", version: "1" }, snapshots: { current: { [dayOf(T0)]: `snp_${"b".repeat(20)}` } }, allowSmall: true, repeats: 1 });
    const rows: unknown[] = [];
    const executor: ReplayExecutor = stagingExecutor(port);
    const report = await runReplay(plan, { executor, grader: { identity: { model: "g", version: "1" }, grade: async () => ({ resolved: true, gradedBy: "rubric", mistakes: [] }) }, sink: { done: () => new Set(), append: async (_k, r) => { rows.push(r); } }, priorCorrections: async () => [], maxUsd: 100 });
    expect(report.ungraded).toBe(2);
  });
});

describe("the rubric grader", () => {
  const model = (reply: string, seen: Array<{ system: string; user: string }> = []): GraderModel => ({ model: "grader-model", version: "2026-11", complete: async (input) => { seen.push(input); return reply; } });
  const deps = (m: GraderModel, extra: Record<string, unknown> = {}) => ({ model: m, evidence: { read: async () => ({ summary: "diff: replaced the loop with withRetry" }) }, correctionText: (id: string) => (id === "c1" ? "use withRetry for retries" : undefined), nonce: () => "n0nce", ...extra });
  const request = { task, repeat: 1, evidence: "pr:7", priorCorrections: ["c1"] };

  it("reads a strict JSON reply; its identity is the model, version and a digest of the rubric; the prompt holds the data in markers and no arm", async () => {
    const seen: Array<{ system: string; user: string }> = [];
    const grader = rubricGrader(deps(model('{"resolved":true,"mistakes":["c1","c1"]}', seen)));
    expect(await grader.grade(request)).toEqual({ resolved: true, gradedBy: "rubric", mistakes: ["c1"] });
    expect(grader.identity.model).toBe("grader-model");
    expect(grader.identity.version).toMatch(/^2026-11\+rubric-[0-9a-f]{8}$/);
    expect(seen[0]!.system).toBe(DEFAULT_RUBRIC);
    expect(seen[0]!.user).toContain("<<data n0nce id=c1>>");
    expect(seen[0]!.user).not.toMatch(/on:|off|snapshot|memory/);
    const other = rubricGrader(deps(model("{}"), { rubric: `${DEFAULT_RUBRIC}\nBe strict.` }));
    expect(other.identity.version).not.toBe(grader.identity.version);
  });
  it("hidden tests decide 'resolved' where the task has them; the mistakes still come from the rubric", async () => {
    const tests = { run: async (t: ReplayCandidate) => (t.taskId === "t1" ? false : undefined) };
    const grader = rubricGrader(deps(model('{"resolved":true,"mistakes":["c1"]}'), { tests }));
    expect(await grader.grade(request)).toEqual({ resolved: false, gradedBy: "hidden_tests", mistakes: ["c1"] });
    expect(await grader.grade({ ...request, task: { ...task, taskId: "t2" } })).toMatchObject({ gradedBy: "rubric", resolved: true });
  });
  it("refuses a reply that is not JSON, has the wrong shape, or names a correction that was not listed", async () => {
    for (const bad of ["resolved yes", '{"resolved":"yes","mistakes":[]}', '{"resolved":true}', '{"resolved":true,"mistakes":["zzz"]}', '{"resolved":true,"mistakes":[1]}']) {
      await expect(rubricGrader(deps(model(bad))).grade(request), bad).rejects.toThrow();
    }
  });
});

describe("pipeline B as of a date (read only)", () => {
  const lesson = (id: string, over: Record<string, unknown> = {}) => lessonRecord({ id, createdAt: T0 - 10 * DAY, updatedAt: T0 - 10 * DAY, expiresAt: T0 + 100 * DAY, ...over });
  it("keeps the lessons live at the start of the day at the version they had then", () => {
    const v1 = lesson("les_a", { version: 1, body: "old words" });
    const v2 = lesson("les_a", { version: 2, body: "new words", updatedAt: T0 + 2 * DAY });
    const later = lesson("les_b", { createdAt: T0 + DAY, updatedAt: T0 + DAY });
    const expired = lesson("les_c", { expiresAt: T0 - DAY });
    const retired = lesson("les_d", { status: "retired" });
    const versions = new Map([["les_a", [v1, v2]], ["les_b", [later]], ["les_c", [expired]], ["les_d", [retired]]]);
    expect(lessonsAsOf(versions, T0).map((l) => `${l.id}:${l.body}`)).toEqual(["les_a:old words"]);
    expect(lessonsAsOf(versions, T0 + 3 * DAY).map((l) => `${l.id}:${l.body}`)).toEqual(["les_a:new words", "les_b:" + later.body]);
  });
  it("is a snapshot builder: a deterministic id, no model, cost not measured, and the harness reads it", async () => {
    const store = new InMemoryLessonStore();
    await seed(store, lesson("les_a"), lesson("les_b", { title: "Lint first", body: "Run lint before tests." }));
    const pinned: string[] = [];
    const builder = asOfSnapshotBuilder({ store, key: KEY, pin: async (id, lessons) => { pinned.push(`${id}:${String(lessons.length)}`); } });
    const request = { pipeline: "current", day: dayOf(T0), learningCalls: "explicit" as const, historical: [] };
    const a = await builder.build(request);
    const b = await builder.build(request);
    expect(a.snapshotId).toBe(b.snapshotId);
    expect(a.snapshotId).toMatch(/^snp_[0-9a-f]{20}$/);
    expect(a).toMatchObject({ costUsd: null, calls: null });
    expect(a.lessons).toHaveLength(2);
    expect(pinned).toHaveLength(2);
    const tasks = [task, { ...task, taskId: "t2", at: T0 + DAY }];
    const built = await buildSnapshots({ tasks, arms: ["off", "on:current"], builders: { current: builder } });
    expect(built.learning).toEqual(expect.arrayContaining([{ arm: "on:current", usd: null, calls: null }, { arm: "off", usd: 0, calls: 0 }]));
    expect(built.lessonSets[0]).toMatchObject({ arm: "on:current", size: 2 });
  });
  it("a store from another project gives nothing", async () => {
    const store = new InMemoryLessonStore();
    await seed(store, lesson("les_a"));
    const builder = asOfSnapshotBuilder({ store, key: { workspaceId: KEY.workspaceId, project: "other" } });
    expect((await builder.build({ pipeline: "current", day: dayOf(T0), learningCalls: "explicit", historical: [] })).lessons).toEqual([]);
  });
});

describe("the --max-usd limit on building snapshots", () => {
  it("stops when the builders spend more than the limit", async () => {
    const dear = { build: async () => ({ snapshotId: `snp_${"c".repeat(20)}`, lessons: [], costUsd: 3, calls: 1 }) };
    const tasks = [task, { ...task, taskId: "t2", at: T0 + DAY }, { ...task, taskId: "t3", at: T0 + 2 * DAY }];
    await expect(buildSnapshots({ tasks, arms: ["off", "on:current"], builders: { current: dear }, maxUsd: 5 })).rejects.toThrow(/max-usd/);
    await expect(buildSnapshots({ tasks, arms: ["off", "on:current"], builders: { current: dear }, maxUsd: 50 })).resolves.toBeDefined();
  });
});

describe("the candidates exporter", () => {
  const meta = (taskId: string, over: Record<string, unknown> = {}, workflow: Record<string, unknown> = {}) => ({
    pk: `DEVTASK#${taskId}`, sk: "META", taskId, orgId: "org_a", project: "proj-1", createdAt: new Date(T0).toISOString(),
    workflow: { outcome: "MERGED", pullRequests: [{ repositoryId: "api" }], decisions: [{ source: "SEND_BACK", decision: "REQUEST_CHANGES", actorRole: "TASK_OWNER" }, { source: "SEND_BACK", decision: "REQUEST_CHANGES", actorRole: "TASK_OWNER" }, { source: "AUTO_FIX", decision: "REQUEST_CHANGES", actorRole: "AGENTX" }], ...workflow }, ...over,
  });
  it("counts the human send-backs (never Rovara's own) plus the Team record's counts, and says why it skipped a task", () => {
    const out = candidatesFromItems({
      items: [meta("a"), meta("b", { automatic: { job: "x" } }), meta("c", { evalRun: true }), meta("d", {}, { outcome: "OPEN" }), meta("e", {}, { pullRequests: [] }), meta("f", { orgId: "org_b" }), meta("g", { createdAt: "soon" }), { pk: "OTHER#1", sk: "x" }, meta("h", { evalRun: "yes" }), meta("i", {}, { outcome: "CLOSED" })],
      corrections: { a: { prComments: 3, humanEdits: 1, reverts: 1 }, i: { prComments: 1 } },
    }, { orgId: "org_a" });
    expect(out.candidates.map((c) => [c.taskId, c.memberCorrections, c.outcome])).toEqual([["a", 7, "merged"], ["i", 3, "closed"]]);
    expect(out.skipped).toMatchObject({ not_a_work_task: 1, eval_run: 2, not_finished: 1, no_repository: 1, wrong_org: 1, no_time: 1 });
    expect(out.ignoredItems).toBe(1);
  });
  it("feeds selection end to end: export, select, with the files the runbook names", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "l7-cand-"));
    const items = Array.from({ length: 70 }, (_, i) => meta(`t${String(i).padStart(2, "0")}`, { createdAt: new Date(T0 + i * DAY).toISOString() }, { pullRequests: [{ repositoryId: ["api", "web", "infra"][i % 3] }], decisions: Array.from({ length: 1 + (i % 4) }, () => ({ source: "SEND_BACK", decision: "REQUEST_CHANGES", actorRole: "TASK_OWNER" })) }));
    writeFileSync(path.join(dir, "items.json"), JSON.stringify({ items }));
    const lines: string[] = [];
    expect(exportCandidates(["--input", path.join(dir, "items.json"), "--out", path.join(dir, "candidates.json"), "--org", "org_a"], { out: (t) => lines.push(t), err: (t) => lines.push(t) })).toBe(0);
    expect(lines[0]).toMatch(/70 candidates/);
    expect(JSON.parse(readFileSync(path.join(dir, "candidates.json"), "utf8"))).toHaveLength(70);
    const out: string[] = [];
    return measure(["select", "--candidates", path.join(dir, "candidates.json"), "--seed", "s", "--target", "40", "--out", path.join(dir, "selection.json")], { out: (t) => out.push(t), err: (t) => out.push(t) }).then((code) => {
      expect(code).toBe(0);
      expect(out[0]).toMatch(/selected 40 tasks/);
    });
  });
  it("refuses bad usage with a message", () => {
    const lines: string[] = [];
    expect(exportCandidates(["--nope"], { out: (t) => lines.push(t), err: (t) => lines.push(t) })).toBe(1);
    expect(exportCandidates(["--input", "x"], { out: (t) => lines.push(t), err: (t) => lines.push(t) })).toBe(1);
  });
});
