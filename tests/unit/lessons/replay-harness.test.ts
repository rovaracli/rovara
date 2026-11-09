// Lane 7: the replay harness with fakes. No AWS, no model: the executor, the grader and the pipelines' snapshot builders are ports.
import { describe, expect, it } from "vitest";
import { GraderMismatchError, REPLAY_REPEATS, buildMeasureReport, type ReplayRunRow } from "@agentx/contracts";
import {
  ArmNotBuiltError, EvalMarkError, ReplayLearningCallError, UNBUILT_DELIVERIES, buildReplayPlan, buildSnapshots, dayOf, runReplay,
  type ExecutedRun, type GradeRequest, type ReplayExecutor, type ReplayGraderPort, type RunSink, type SnapshotBuilder,
} from "../../../packages/broker/src/lessons/replay-harness.js";
import { lessonContentKey, summarizeLessonSet } from "../../../packages/broker/src/lessons/replay-lessonset.js";
import { repeatMistakeChecks } from "../../../packages/broker/src/lessons/replay-mistakes.js";
import type { ReplayCandidate } from "../../../packages/broker/src/lessons/replay-select.js";
import type { CorrectionRecord, CorrectionSource } from "../../../packages/broker/src/lessons/metric.js";
import { signatureMatcher } from "../../../packages/broker/src/lessons/metric-source.js";
import { KEY, lessonRecord } from "./lesson-helpers.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 1);
const GRADER = { model: "grader-model", version: "v1" };
const tasks = (n = 40): ReplayCandidate[] => Array.from({ length: n }, (_, i) => ({ taskId: `t${String(i).padStart(2, "0")}`, project: "p", repository: "api", at: T0 + Math.floor(i / 2) * DAY, memberCorrections: 2, outcome: "merged" as const }));
const snapshotsFor = (list: ReplayCandidate[], pipelines: string[]): Record<string, Record<string, string>> =>
  Object.fromEntries(pipelines.map((p) => [p, Object.fromEntries([...new Set(list.map((t) => dayOf(t.at)))].map((d, i) => [d, `snp_${String(i).padStart(20, "0")}`]))]));
const ARMS = ["off", "on:current", "on:consolidated"];
const plan = (n = 40, arms = ARMS) => buildReplayPlan({ tasks: tasks(n), arms, seed: "s", grader: GRADER, snapshots: snapshotsFor(tasks(n), ["current", "consolidated"]) });

class Sink implements RunSink {
  rows = new Map<string, ReplayRunRow>();
  constructor(private readonly already: string[] = []) {}
  done(): ReadonlySet<string> { return new Set([...this.already, ...this.rows.keys()]); }
  async append(key: string, row: ReplayRunRow): Promise<void> { this.rows.set(key, row); }
}
const okRun = (over: Partial<ExecutedRun> = {}): ExecutedRun => ({ loaded: ["k1"], costUsd: 0.4, evidence: "ev", evalRunMarked: true, learningCalls: 0, ...over });
const grader = (over: Partial<ReplayGraderPort> = {}): ReplayGraderPort & { seen: GradeRequest[] } => {
  const seen: GradeRequest[] = [];
  return { identity: GRADER, seen, grade: async (request) => { seen.push(request); return { resolved: true, gradedBy: "hidden_tests", mistakes: [] }; }, ...over };
};

const go = (p: Parameters<typeof runReplay>[0], deps: Omit<Parameters<typeof runReplay>[1], "maxUsd"> & { maxUsd?: number }) => runReplay(p, { maxUsd: 100_000, ...deps });

describe("the plan", () => {
  it("is every task x arm x repeat, 3 repeats, in time order, each marked as an eval run", () => {
    const p = plan(40);
    expect(p.repeats).toBe(REPLAY_REPEATS);
    expect(p.runs).toHaveLength(40 * 3 * 3);
    expect(p.runs.every((r) => r.evalRun === true)).toBe(true);
    const times = p.runs.map((r) => p.tasks.find((t) => t.taskId === r.task)!.at);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(new Set(p.runs.map((r) => r.key)).size).toBe(p.runs.length);
  });
  it("gives off the off input and each on arm its OWN pipeline's frozen snapshot for the task's day, never live", () => {
    const p = plan(40);
    const snapshots = snapshotsFor(tasks(40), ["current", "consolidated"]);
    for (const run of p.runs) {
      const day = dayOf(p.tasks.find((t) => t.taskId === run.task)!.at);
      if (run.arm === "off") expect(run.memory).toEqual({ mode: "off" });
      else expect(run.memory).toEqual({ mode: "snapshot", snapshotId: snapshots[run.arm.slice(3)]![day] });
      expect(run.memory?.mode).not.toBe("live");
    }
  });
  it("says what learning calls the replay makes (decision 47) and counts project-days", () => {
    const p = plan(40);
    expect(p.learningCalls).toEqual({ lessonsSwitch: "off", replayLearningCalls: 0, snapshotBuilds: "explicit" });
    expect(p.notes.join(" ")).toMatch(/lessons switch \(ll\) at 0 and make no learning calls/);
    expect(p.projectDays).toBe(20);
  });
  it("refuses fewer than 40 or more than 60 tasks, other repeats, a missing snapshot, one arm, a repeated arm or task; a rehearsal may be small", () => {
    const base = { arms: ARMS, seed: "s", grader: GRADER };
    expect(() => buildReplayPlan({ ...base, tasks: tasks(39), snapshots: snapshotsFor(tasks(39), ["current", "consolidated"]) })).toThrow(/40 to 60/);
    expect(() => buildReplayPlan({ ...base, tasks: tasks(61), snapshots: snapshotsFor(tasks(61), ["current", "consolidated"]) })).toThrow(/40 to 60/);
    expect(() => buildReplayPlan({ ...base, tasks: tasks(40), repeats: 2, snapshots: snapshotsFor(tasks(40), ["current", "consolidated"]) })).toThrow(/3 times/);
    expect(() => buildReplayPlan({ ...base, tasks: tasks(40), snapshots: snapshotsFor(tasks(40), ["current"]) })).toThrow(/no frozen snapshot/);
    expect(() => buildReplayPlan({ ...base, arms: ["off"], tasks: tasks(40) })).toThrow(/at least two/);
    expect(() => buildReplayPlan({ ...base, arms: ["off", "off"], tasks: tasks(40) })).toThrow(/at least two/);
    expect(() => buildReplayPlan({ ...base, tasks: [...tasks(40), tasks(40)[0]!], snapshots: snapshotsFor(tasks(40), ["current", "consolidated"]) })).toThrow(/twice/);
    expect(buildReplayPlan({ ...base, tasks: tasks(4), repeats: 1, allowSmall: true, snapshots: snapshotsFor(tasks(4), ["current", "consolidated"]) }).runs).toHaveLength(12);
  });
  it("a file or MCP arm (decision 50.5) is planned with its delivery and the pipeline's snapshot, and has no memory input", () => {
    const p = buildReplayPlan({ tasks: tasks(40), arms: ["off", "on:current", "file:current", "mcp:current"], seed: "s", grader: GRADER, snapshots: snapshotsFor(tasks(40), ["current"]) });
    const file = p.runs.find((r) => r.arm === "file:current")!;
    expect(file).toMatchObject({ delivery: "file" });
    expect(file.memory).toBeUndefined();
    expect(p.runs.find((r) => r.arm === "mcp:current")).toMatchObject({ delivery: "mcp" });
  });
});

describe("running", () => {
  const executor = (over: Partial<ExecutedRun> = {}, log: Array<{ arm: string; learning: unknown }> = []): ReplayExecutor => ({ run: async ({ run, learning }) => { log.push({ arm: run.arm, learning }); return okRun(over); } });
  it("runs every planned run once, records the grader on each row, and hands the executor 'no learning calls'", async () => {
    const p = plan(40);
    const sink = new Sink();
    const log: Array<{ arm: string; learning: unknown }> = [];
    const report = await go(p, { executor: executor({}, log), grader: grader(), sink, priorCorrections: async () => [] });
    expect(report).toMatchObject({ ran: 360, skipped: 0, ungraded: 0, stoppedBy: "done" });
    expect(report.costUsd).toBeCloseTo(144, 6);
    expect(sink.rows.size).toBe(360);
    for (const row of sink.rows.values()) expect(row).toMatchObject({ resolved: true, grader: GRADER, gradedBy: "hidden_tests" });
    expect(log.every((l) => JSON.stringify(l.learning) === JSON.stringify({ lessonsSwitch: "off", calls: "none" }))).toBe(true);
    // Three runs per task per arm.
    const per = new Map<string, number>();
    for (const row of sink.rows.values()) per.set(`${row.task}|${row.arm}`, (per.get(`${row.task}|${row.arm}`) ?? 0) + 1);
    expect([...per.values()].every((n) => n === 3)).toBe(true);
    expect(per.size).toBe(120);
  });
  it("the grader is blind: its request holds no arm, pipeline, memory setting or snapshot", async () => {
    const g = grader();
    await go(plan(40), { executor: executor(), grader: g, sink: new Sink(), priorCorrections: async () => [] });
    expect(g.seen.length).toBe(360);
    for (const request of g.seen) {
      expect(Object.keys(request).sort()).toEqual(["evidence", "priorCorrections", "repeat", "task"]);
      const text = JSON.stringify(request);
      for (const word of ["off", "on:", "current", "consolidated", "snapshot", "snp_", "memory", "arm"]) expect(text, word).not.toContain(word);
    }
  });
  it("resumes: runs already recorded are skipped", async () => {
    const p = plan(40);
    const first = p.runs.slice(0, 10).map((r) => r.key);
    const sink = new Sink(first);
    const report = await go(p, { executor: executor(), grader: grader(), sink, priorCorrections: async () => [] });
    expect(report).toMatchObject({ ran: 350, skipped: 10 });
  });
  it("--max-usd is a hard stop: never past the limit, and not before a run that could pass it; a run needs a limit", async () => {
    const report = await go(plan(40), { executor: executor(), grader: grader(), sink: new Sink(), priorCorrections: async () => [], maxUsd: 1 });
    expect(report.stoppedBy).toBe("max_usd");
    expect(report.ran).toBe(2);
    expect(report.costUsd).toBeLessThanOrEqual(1);
    await expect(runReplay(plan(40), { executor: executor(), grader: grader(), sink: new Sink(), priorCorrections: async () => [], maxUsd: 0 })).rejects.toThrow(/maximum cost/);
    await expect(runReplay(plan(40), { executor: executor(), grader: grader(), sink: new Sink(), priorCorrections: async () => [] } as never)).rejects.toThrow(/maximum cost/);
  });
  it("a run that fails is an ungraded row, and the replay goes on", async () => {
    let n = 0;
    const flaky: ReplayExecutor = { run: async () => { n += 1; if (n === 2) throw new Error("worker lost"); return okRun(); } };
    const sink = new Sink();
    const report = await go(plan(40), { executor: flaky, grader: grader(), sink, priorCorrections: async () => [], maxUsd: 2 });
    expect(report.ungraded).toBe(1);
    const second = [...sink.rows.values()][1]!;
    expect(second).toMatchObject({ resolved: null, grader: null, gradedBy: null });
  });
  it("stops the whole replay when a task was not marked as an eval run", async () => {
    const sink = new Sink();
    await expect(go(plan(40), { executor: executor({ evalRunMarked: false }), grader: grader(), sink, priorCorrections: async () => [] })).rejects.toThrow(EvalMarkError);
    expect(sink.rows.size).toBe(0);
  });
  it("stops the whole replay when a replay made a learning call (decision 47)", async () => {
    const sink = new Sink();
    await expect(go(plan(40), { executor: executor({ learningCalls: 1 }), grader: grader(), sink, priorCorrections: async () => [] })).rejects.toThrow(ReplayLearningCallError);
    expect(sink.rows.size).toBe(0);
  });
  it("refuses a grader that is not the plan's", async () => {
    await expect(go(plan(40), { executor: executor(), grader: grader({ identity: { model: "other", version: "v1" } }), sink: new Sink(), priorCorrections: async () => [] })).rejects.toThrow(GraderMismatchError);
  });
  it("a mistake that names a correction not given before the task makes the run ungraded", async () => {
    const lying = grader({ grade: async () => ({ resolved: true, gradedBy: "rubric", mistakes: ["made-up"] }) });
    const sink = new Sink();
    await go(plan(40), { executor: executor(), grader: lying, sink, priorCorrections: async () => ["c1"], maxUsd: 0.5 });
    expect([...sink.rows.values()][0]).toMatchObject({ resolved: null });
    const honest = grader({ grade: async () => ({ resolved: false, gradedBy: "rubric", mistakes: ["c1", "c1"] }) });
    const sink2 = new Sink();
    await go(plan(40), { executor: executor(), grader: honest, sink: sink2, priorCorrections: async () => ["c1"], maxUsd: 0.5 });
    expect([...sink2.rows.values()][0]).toMatchObject({ resolved: false, mistakes: ["c1"] });
  });
  it("a file or MCP arm refuses to run before anything runs, until its adapter is built (stubs, DECISIONS 50.5)", async () => {
    const p = buildReplayPlan({ tasks: tasks(40), arms: ["off", "file:current", "mcp:current", "on:current"], seed: "s", grader: GRADER, snapshots: snapshotsFor(tasks(40), ["current"]) });
    let ran = 0;
    const counting: ReplayExecutor = { run: async () => { ran += 1; return okRun(); } };
    await expect(go(p, { executor: counting, grader: grader(), sink: new Sink(), priorCorrections: async () => [] })).rejects.toThrow(ArmNotBuiltError);
    await expect(go(p, { executor: counting, grader: grader(), sink: new Sink(), priorCorrections: async () => [], deliveries: UNBUILT_DELIVERIES })).rejects.toThrow(/TODO: lane R2/);
    expect(ran).toBe(0);
    const built = { file: { kind: "file" as const, built: true }, mcp: { kind: "mcp" as const, built: true } };
    const report = await go(p, { executor: counting, grader: grader(), sink: new Sink(), priorCorrections: async () => [], deliveries: built, maxUsd: 1 });
    expect(report.ran).toBeGreaterThan(0);
  });
  it("produces rows the report accepts, end to end", async () => {
    const sink = new Sink();
    let n = 0;
    const varied: ReplayExecutor = { run: async ({ run }) => { n += 1; return okRun({ loaded: run.arm === "on:current" ? ["a", "b"] : run.arm === "on:consolidated" ? ["c", "d"] : [] }); } };
    await go(plan(40), { executor: varied, grader: grader(), sink, priorCorrections: async () => [] });
    const report = buildMeasureReport({ rows: [...sink.rows.values()], compare: { b: "on:current", c: "on:consolidated" }, projectDays: 20, learning: [], lessonSets: [] });
    expect(report.stopped).toBe(false);
    expect(report.results!.pairs).toBe(120);
    expect(n).toBe(360);
  });
});

describe("building the snapshots (historical outcomes only)", () => {
  const lesson = (title: string, body: string) => lessonRecord({ id: `les_${lessonContentKey({ title, body }).slice(0, 8)}`, title, body, description: "d" });
  it("builds each pipeline for each day in time order, from tasks before that day only, with learning calls named explicitly; off costs nothing", async () => {
    const calls: Array<{ pipeline: string; day: string; historical: number; learningCalls: string }> = [];
    const builder = (usd: number): SnapshotBuilder => ({ build: async (req) => { calls.push({ pipeline: req.pipeline, day: req.day, historical: req.historical.length, learningCalls: req.learningCalls }); return { snapshotId: `snp_${req.day.replace(/-/gu, "").padEnd(20, "0")}`, lessons: [lesson(`L ${req.day}`, `Always run lint ${req.day}`)], costUsd: usd, calls: 2 }; } });
    const t = tasks(6);
    const built = await buildSnapshots({ tasks: t, arms: ARMS, builders: { current: builder(0.5), consolidated: builder(0.25) } });
    const days = [...new Set(t.map((x) => dayOf(x.at)))].sort();
    expect(calls.filter((c) => c.pipeline === "current").map((c) => c.day)).toEqual(days);
    expect(calls.filter((c) => c.pipeline === "current").map((c) => c.historical)).toEqual([0, 2, 4]);
    expect(calls.every((c) => c.learningCalls === "explicit")).toBe(true);
    expect(built.learning).toEqual(expect.arrayContaining([{ arm: "on:current", usd: 1.5, calls: 6 }, { arm: "on:consolidated", usd: 0.75, calls: 6 }, { arm: "off", usd: 0, calls: 0 }]));
    expect(built.snapshots["current"]![days[0]!]).toMatch(/^snp_/);
    expect(built.lessonSets.map((s) => s.arm).sort()).toEqual(["on:consolidated", "on:current"]);
  });
  it("a pipeline with no builder is refused, not skipped", async () => {
    await expect(buildSnapshots({ tasks: tasks(4), arms: ARMS, builders: {} })).rejects.toThrow(ArmNotBuiltError);
  });
});

describe("the final lesson set", () => {
  const lesson = (title: string, body: string, repos: string[] = ["api"]) => lessonRecord({ title, body, scope: { repos } });
  it("counts size, duplicates (same words once filler is set aside) and contradictions (a flipped copy that reaches the same place)", () => {
    const set = summarizeLessonSet("on:current", [
      lesson("Use pnpm", "Use pnpm to install packages in this repository."),
      lesson("Use pnpm", "Use pnpm to install the packages in this repository."),
      lesson("Never use pnpm", "Never use pnpm to install packages in this repository."),
      lesson("Lint first", "Run lint before the unit tests every time."),
      lessonRecord({ title: "Old", body: "Use yarn.", status: "retired" }),
    ]);
    expect(set.size).toBe(4);
    expect(set.duplicates).toBe(1);
    expect(set.contradictions).toBeGreaterThanOrEqual(1);
  });
  it("a flipped pair in different repositories is not a contradiction", () => {
    const set = summarizeLessonSet("on:current", [lesson("Use pnpm", "Use pnpm to install packages here.", ["api"]), lesson("Never use pnpm", "Never use pnpm to install packages here.", ["web"])]);
    expect(set.contradictions).toBe(0);
  });
  it("the content key follows the words, not the id or the case", () => {
    expect(lessonContentKey({ title: "Use  PNPM", body: "Use pnpm." })).toBe(lessonContentKey({ title: "use pnpm", body: "use   pnpm" }));
    expect(lessonContentKey({ title: "Use pnpm", body: "Use pnpm." })).not.toBe(lessonContentKey({ title: "Use npm", body: "Use npm." }));
  });
});

describe("the repeat-mistake metric on the replay (CONNECT-2)", () => {
  const key = KEY;
  const history: CorrectionRecord[] = [
    { id: "c1", taskId: "t00", at: T0, kind: "send_back", member: true, text: "use the shared retry helper withRetry" },
    { id: "c2", taskId: "t30", at: T0 + 30 * DAY, kind: "send_back", member: true, text: "never log secrets in handlers" },
  ];
  const source: CorrectionSource = { list: async (_k, range) => ({ corrections: history.filter((c) => c.at >= range.since && c.at < range.until), truncated: false }) };
  const matcher = { sameAsCorrection: async (a: CorrectionRecord, b: CorrectionRecord) => a.text === b.text, sameAsLesson: async (c: CorrectionRecord, l: { body: string }) => l.body.includes("withRetry") && c.text?.includes("retry") === true };
  const t = tasks(40);
  const retryLesson = lessonRecord({ id: "les_retry001", title: "Use withRetry", body: "Use withRetry for HTTP retries.", createdAt: T0 - DAY, updatedAt: T0 - DAY, expiresAt: T0 + 400 * DAY });
  const row = (task: string, arm: string, mistakes: string[], loaded: string[] = []): ReplayRunRow => ({ task, repeat: 1, arm, resolved: false, grader: GRADER, gradedBy: "hidden_tests", loaded, mistakes, costUsd: 0.1 });

  it("confirms a flagged repeat of an EARLIER correction and splits it by whether a lesson was loaded; a flag that names a later task's correction is not a repeat", async () => {
    const rows = [
      row("t10", "on:current", ["c1"], [lessonContentKey(retryLesson)]), // lesson existed and was loaded
      row("t11", "on:current", ["c1"], []), // lesson existed, not loaded
      row("t12", "off", ["c1"], []), // off: no lessons at all
      row("t13", "on:current", ["c2"], []), // c2 is on t30, a LATER task: not a repeat
    ];
    const checks = await repeatMistakeChecks(rows, { key, tasks: t, corrections: source, matcher, lessonsOf: (arm) => (arm === "off" ? [] : [retryLesson]) });
    const current = checks.find((c) => c.arm === "on:current")!;
    expect(current.confirmed).toBe(2);
    expect(current.split).toEqual({ lessonLoaded: 1, lessonNotLoaded: 1, noLesson: 0 });
    expect(checks.find((c) => c.arm === "off")).toMatchObject({ confirmed: 1, split: { lessonLoaded: 0, lessonNotLoaded: 0, noLesson: 1 } });
  });
  it("the real signature matcher is wired behind the same port", () => {
    expect(typeof signatureMatcher({ orgId: "org_aaaaaaaaaaaaaaaaaaaa", project: "p", projectCreatedAt: "2026-01-01T00:00:00.000Z" }).sameAsCorrection).toBe("function");
  });
});
