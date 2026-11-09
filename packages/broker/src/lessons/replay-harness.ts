// Lane 7 (0.5.12, DECISIONS 38, 47, 49, 50.5): the replay harness. It plans the runs (task x arm x repeat), builds each lesson pipeline's frozen snapshots from HISTORICAL outcomes, runs each planned run through an
// executor, grades it with ONE fixed grader that never sees the arm, and appends one result row per run. It runs nothing itself: the executor, the grader and the snapshot builders are ports. The real ones (a
// run on a staging task, the pipeline B and C builders, a grader model) are the operator's (docs/runbooks/lessons-replay-measure.md); tests use fakes.
//
// Guarantees (each has a test):
//   - Every planned run is marked as an eval run (`evalRun: true`), and the executor must confirm the task it made carries the marker, or the whole replay stops: an unmarked replay task would feed learning.
//   - Decision 47: replays are run with the install's lessons switch (`ll`) at 0 and make NO learning calls. The plan says so, hands the executor "no learning calls", and stops if a run reports any. The lesson
//     snapshots are built by the harness with learning calls named explicitly in the plan (`snapshotBuilds: "explicit"`), never through the install's switch.
//   - An "on" arm reads a frozen snapshot of its pipeline for the task's day, never live memory (`memoryInputForArm`). A file or MCP arm (DECISIONS 50.5) needs a built delivery adapter; the stubs refuse.
//   - The grader's identity is in the plan and in every graded row; a grader that differs from the plan's is refused. The grader's request holds no arm.
//   - A mistake the grader flags must name a historical correction from BEFORE the task; any other flag makes the run ungraded.
import {
  GraderMismatchError, REPLAY_REPEATS, REPLAY_TASKS_MAX, REPLAY_TASKS_MIN, ReplayRunRowSchema, canonicalArm, memoryInputForArm, parseArm,
  type ArmLearningCost, type ArmLessonSet, type LearningCallsNote, type MemoryInput, type ReplayGradedBy, type ReplayGrader, type ReplayRunRow,
} from "@agentx/contracts";
import { lessonContentKey, summarizeLessonSet } from "./replay-lessonset.js";
import type { ReplayCandidate } from "./replay-select.js";
import type { Lesson } from "./types.js";

const DAY = 86_400_000;
/** The simulated day (UTC) of a task. */
export const dayOf = (at: number): string => new Date(Math.floor(at / DAY) * DAY).toISOString().slice(0, 10);

export const LEARNING_CALLS_NOTE = "Replays run with the install's lessons switch (ll) at 0 and make no learning calls (decision 47). The lesson snapshots are built offline by the harness, with learning calls named explicitly in this plan, never through the install's switch. Every replayed task carries the eval marker, so no lesson is learned from it.";

export class ArmNotBuiltError extends Error {
  constructor(arm: string, detail: string) { super(`The ${arm} arm cannot run yet: ${detail}`); this.name = "ArmNotBuiltError"; }
}
export class EvalMarkError extends Error {
  constructor(runKey: string) { super(`The task for run ${runKey} was not marked as an eval run. Stopped: an unmarked replay would be learned from.`); this.name = "EvalMarkError"; }
}
export class ReplayLearningCallError extends Error {
  constructor(runKey: string) { super(`Run ${runKey} made learning calls. A replay makes none (decision 47). Stopped.`); this.name = "ReplayLearningCallError"; }
}

// ---------------------------------------------------------------------------------------------------------------------------
// The plan

export interface PlannedRun {
  key: string;
  task: string;
  repeat: number;
  arm: string;
  day: string;
  /** Rovara arms: the dispatch's memory input (off, or this pipeline's frozen snapshot for the task's day). Absent for a file or MCP arm. */
  memory?: MemoryInput;
  /** DECISIONS 50.5: how a LOCAL agent is offered the arm's lessons. */
  delivery?: "file" | "mcp";
  /** Always true: the task a run makes carries the eval marker. */
  evalRun: true;
}
export interface ReplayPlan {
  version: 1;
  seed: string;
  repeats: number;
  tasks: ReplayCandidate[];
  arms: string[];
  grader: ReplayGrader;
  learningCalls: LearningCallsNote;
  /** (project, day) pairs the replay covers: the divisor of the learning cost. */
  projectDays: number;
  /** The frozen snapshot of each pipeline on each simulated day: pipeline label -> day -> snapshot id. */
  snapshots: Record<string, Record<string, string>>;
  runs: PlannedRun[];
  notes: string[];
}
export interface PlanInput {
  tasks: readonly ReplayCandidate[];
  arms: readonly string[];
  seed: string;
  grader: ReplayGrader;
  snapshots?: Record<string, Record<string, string>>;
  repeats?: number;
  /** A rehearsal with fewer tasks or repeats than the real replay. Never for the replay the owner reads. */
  allowSmall?: boolean;
}

export function buildReplayPlan(input: PlanInput): ReplayPlan {
  const repeats = input.repeats ?? REPLAY_REPEATS;
  if (input.allowSmall !== true) {
    if (input.tasks.length < REPLAY_TASKS_MIN || input.tasks.length > REPLAY_TASKS_MAX) throw new RangeError(`A replay uses ${String(REPLAY_TASKS_MIN)} to ${String(REPLAY_TASKS_MAX)} tasks; this has ${String(input.tasks.length)}.`);
    if (repeats !== REPLAY_REPEATS) throw new RangeError(`A replay runs each task ${String(REPLAY_REPEATS)} times.`);
  }
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new RangeError("Repeats are a whole number from 1 to 10.");
  if (input.seed.trim() === "") throw new RangeError("A replay names its seed.");
  if (new Set(input.tasks.map((t) => t.taskId)).size !== input.tasks.length) throw new RangeError("A task is listed twice.");
  const arms = input.arms.map(canonicalArm);
  if (arms.length < 2 || new Set(arms).size !== arms.length) throw new RangeError("A replay compares at least two different arms.");
  const tasks = [...input.tasks].sort((a, b) => a.at - b.at || (a.taskId < b.taskId ? -1 : 1));
  const snapshots = input.snapshots ?? {};
  const days = [...new Set(tasks.map((t) => dayOf(t.at)))];
  const pipelineOf = (arm: string): string | undefined => parseArm(arm).label;
  for (const arm of arms) {
    const parsed = parseArm(arm);
    if (parsed.kind === "off") continue;
    for (const day of days) if (snapshots[parsed.label!]?.[day] === undefined) throw new RangeError(`The ${arm} arm has no frozen snapshot of pipeline ${parsed.label!} for ${day}. Build the snapshots first.`);
  }
  const runs: PlannedRun[] = [];
  for (const task of tasks) {
    for (const arm of arms) {
      const parsed = parseArm(arm);
      for (let repeat = 1; repeat <= repeats; repeat += 1) {
        const day = dayOf(task.at);
        const run: PlannedRun = { key: JSON.stringify([task.taskId, repeat, arm]), task: task.taskId, repeat, arm, day, evalRun: true };
        if (parsed.kind === "off" || parsed.kind === "on") run.memory = memoryInputForArm(arm, parsed.kind === "on" ? snapshots[pipelineOf(arm)!]![day]! : undefined);
        else run.delivery = parsed.kind;
        runs.push(run);
      }
    }
  }
  const projectDays = new Set(tasks.map((t) => `${t.project}\u0000${dayOf(t.at)}`)).size;
  const learningCalls: LearningCallsNote = { lessonsSwitch: "off", replayLearningCalls: 0, snapshotBuilds: "explicit" };
  return { version: 1, seed: input.seed, repeats, tasks, arms, grader: input.grader, learningCalls, projectDays, snapshots, runs, notes: [LEARNING_CALLS_NOTE] };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Snapshots: the lesson pipelines, from historical outcomes only

export interface SnapshotRequest {
  /** The pipeline (the label of its on:<label> arm). */
  pipeline: string;
  /** The simulated day the snapshot is for (UTC date). */
  day: string;
  /** Decision 47: the builder is told in words that learning calls are allowed here; it never reads the install's switch. */
  learningCalls: "explicit";
  /** The tasks that finished BEFORE this day, with their original (historical) outcomes: the only things a pipeline learns from. Replayed runs are never among them. */
  historical: ReplayCandidate[];
}
export interface SnapshotResult {
  snapshotId: string;
  /** The pipeline's whole lesson set after this day, with simulated timestamps (createdAt/updatedAt at the day's end). */
  lessons: Lesson[];
  costUsd: number;
  calls: number;
}
export interface SnapshotBuilder { build(request: SnapshotRequest): Promise<SnapshotResult> }

export interface BuiltSnapshots {
  snapshots: Record<string, Record<string, string>>;
  /** Learning cost per `on:<pipeline>` arm over the whole replay. `off` is listed with 0. */
  learning: ArmLearningCost[];
  /** The last day's lessons per pipeline: the final set. */
  finalLessons: Record<string, Lesson[]>;
  lessonSets: ArmLessonSet[];
}

/** Builds each pipeline's snapshot for each simulated day, in time order, each from the outcomes of tasks before that day. */
export async function buildSnapshots(input: { tasks: readonly ReplayCandidate[]; arms: readonly string[]; builders: Record<string, SnapshotBuilder> }): Promise<BuiltSnapshots> {
  const tasks = [...input.tasks].sort((a, b) => a.at - b.at || (a.taskId < b.taskId ? -1 : 1));
  const days = [...new Set(tasks.map((t) => dayOf(t.at)))].sort();
  const arms = input.arms.map(canonicalArm);
  const pipelines = [...new Set(arms.map((arm) => parseArm(arm)).filter((p) => p.kind !== "off").map((p) => p.label!))];
  const out: BuiltSnapshots = { snapshots: {}, learning: [], finalLessons: {}, lessonSets: [] };
  for (const pipeline of pipelines) {
    const builder = input.builders[pipeline];
    if (builder === undefined) throw new ArmNotBuiltError(`on:${pipeline}`, `no snapshot builder for pipeline ${pipeline}.`);
    let usd = 0, calls = 0;
    out.snapshots[pipeline] = {};
    for (const day of days) {
      const historical = tasks.filter((t) => dayOf(t.at) < day);
      const built = await builder.build({ pipeline, day, learningCalls: "explicit", historical });
      out.snapshots[pipeline][day] = built.snapshotId;
      usd += built.costUsd;
      calls += built.calls;
      out.finalLessons[pipeline] = built.lessons;
    }
    out.learning.push({ arm: `on:${pipeline}`, usd, calls });
    out.lessonSets.push(summarizeLessonSet(`on:${pipeline}`, out.finalLessons[pipeline] ?? []));
  }
  if (arms.includes("off")) out.learning.push({ arm: "off", usd: 0, calls: 0 });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Running

/** How a local agent is offered lessons (DECISIONS 50.5). TODO(R2, MCP): both are stubs until the repository file (`.rovara/lessons.md`) and the MCP tool exist. */
export interface LessonDelivery { kind: "file" | "mcp"; built: boolean }
export const UNBUILT_DELIVERIES: Record<"file" | "mcp", LessonDelivery> = { file: { kind: "file", built: false }, mcp: { kind: "mcp", built: false } };

export interface ExecutedRun {
  /** Content keys (`lessonContentKey`) of the lessons the run was given, from its load records. */
  loaded: string[];
  costUsd: number | null;
  /** An opaque reference the grader reads the run's result from (a branch, a pull request, an evidence id). */
  evidence: string;
  /** The executor confirms the task it made carries the eval marker. */
  evalRunMarked: boolean;
  /** Learning calls the run made: always 0. */
  learningCalls: number;
}
export interface ReplayExecutor {
  run(input: { run: PlannedRun; task: ReplayCandidate; delivery?: LessonDelivery; learning: { lessonsSwitch: "off"; calls: "none" } }): Promise<ExecutedRun>;
}
/** What the grader is shown. NO arm, pipeline or memory setting: it must grade blind. */
export interface GradeRequest { task: ReplayCandidate; repeat: number; evidence: string; priorCorrections: string[] }
export interface GradeResult { resolved: boolean; gradedBy: ReplayGradedBy; mistakes: string[] }
export interface ReplayGraderPort { identity: ReplayGrader; grade(request: GradeRequest): Promise<GradeResult> }
export interface RunSink {
  /** The keys of runs already recorded (a replay resumes where it stopped). */
  done(): ReadonlySet<string>;
  append(key: string, row: ReplayRunRow): Promise<void>;
}
export interface RunDeps {
  executor: ReplayExecutor;
  grader: ReplayGraderPort;
  sink: RunSink;
  deliveries?: Partial<Record<"file" | "mcp", LessonDelivery>>;
  /** The ids of the historical corrections from before a task. */
  priorCorrections(task: ReplayCandidate): Promise<string[]>;
  costCapUsd?: number;
}
export interface RunReport { ran: number; skipped: number; ungraded: number; costUsd: number; stoppedBy: "done" | "cost_cap" }

export async function runReplay(plan: ReplayPlan, deps: RunDeps): Promise<RunReport> {
  if (deps.grader.identity.model !== plan.grader.model || deps.grader.identity.version !== plan.grader.version) {
    throw new GraderMismatchError(`The plan names grader ${plan.grader.model} ${plan.grader.version} but the grader given is ${deps.grader.identity.model} ${deps.grader.identity.version}.`);
  }
  // Before anything runs: a file or MCP arm needs a built adapter.
  for (const arm of plan.arms) {
    const kind = parseArm(arm).kind;
    if (kind === "file" || kind === "mcp") {
      const delivery = deps.deliveries?.[kind];
      if (delivery === undefined || !delivery.built) throw new ArmNotBuiltError(arm, kind === "file" ? "the repository lessons file (.rovara/lessons.md) is not built yet (TODO: lane R2)." : "the MCP lessons tool is not built yet (TODO: the MCP lane).");
    }
  }
  const byTask = new Map(plan.tasks.map((t) => [t.taskId, t] as const));
  const done = deps.sink.done();
  const report: RunReport = { ran: 0, skipped: 0, ungraded: 0, costUsd: 0, stoppedBy: "done" };
  for (const run of plan.runs) {
    if (done.has(run.key)) { report.skipped += 1; continue; }
    if (deps.costCapUsd !== undefined && report.costUsd >= deps.costCapUsd) { report.stoppedBy = "cost_cap"; return report; }
    const task = byTask.get(run.task)!;
    const delivery = run.delivery === undefined ? undefined : deps.deliveries?.[run.delivery];
    let executed: ExecutedRun | undefined;
    try {
      executed = await deps.executor.run({ run, task, ...(delivery === undefined ? {} : { delivery }), learning: { lessonsSwitch: "off", calls: "none" } });
    } catch { executed = undefined; }
    if (executed !== undefined) {
      if (executed.evalRunMarked !== true) throw new EvalMarkError(run.key);
      if (executed.learningCalls !== 0) throw new ReplayLearningCallError(run.key);
    }
    const ungraded = (loaded: string[], costUsd: number | null): ReplayRunRow => ReplayRunRowSchema.parse({ task: run.task, repeat: run.repeat, arm: run.arm, resolved: null, loaded, costUsd });
    let row: ReplayRunRow;
    if (executed === undefined) row = ungraded([], null);
    else {
      report.costUsd += executed.costUsd ?? 0;
      try {
        const prior = await deps.priorCorrections(task);
        const graded = await deps.grader.grade({ task, repeat: run.repeat, evidence: executed.evidence, priorCorrections: prior });
        // A mistake must name a correction that was given before the task; anything else is not a repeat.
        if (graded.mistakes.some((id) => !prior.includes(id))) throw new Error("the grader named a correction that was not given before the task");
        row = ReplayRunRowSchema.parse({ task: run.task, repeat: run.repeat, arm: run.arm, resolved: graded.resolved, grader: deps.grader.identity, gradedBy: graded.gradedBy, loaded: executed.loaded, mistakes: [...new Set(graded.mistakes)], costUsd: executed.costUsd });
      } catch { row = ungraded(executed.loaded, executed.costUsd); }
    }
    if (row.resolved === null) report.ungraded += 1;
    await deps.sink.append(run.key, row);
    report.ran += 1;
  }
  return report;
}

export { lessonContentKey };
