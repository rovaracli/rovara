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
import { REPLAY_EXPORT_RULE, exportViolations } from "./replay-export.js";
import { lessonContentKey, summarizeLessonSet } from "./replay-lessonset.js";
import { evalSnapshotIdOf } from "./replay-snapshot-store.js";
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
        else {
          // The file arm: the install places the snapshot's lessons as a file in the copy's checkout (and loads nothing else); the MCP arm is not built.
          run.delivery = parsed.kind;
          if (parsed.kind === "file") run.memory = { mode: "snapshot", snapshotId: snapshots[pipelineOf(arm)!]![day]! };
        }
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
/** A pipeline's builder exported its lessons by some other rule than `exportWithoutAPerson`: it cannot be an arm, because the arms would not be comparable. */
export class ReplayExportRuleError extends Error {
  constructor(readonly pipeline: string) { super(`The ${pipeline} pipeline did not export its lessons by the one rule every arm uses (active, and delivered without a person under the project's rules). It cannot be an arm.`); this.name = "ReplayExportRuleError"; }
}
export interface SnapshotResult {
  snapshotId: string;
  /** How the lessons were exported (`replay-export.ts`): the rule's name (every arm must carry the same one) and what the day's export counted. Required: a builder that does not say is refused. */
  export: { rule: string; proposed: number; needsPerson: number; truncated: number; /** Model calls of this build that failed and were left out. */ droppedCalls: number; /** Proposed lessons with a code citation that could not be verified (the clone could not tell, or none was given). */ unverified: number; /** Every way this pipeline's run differs from live, in words; the report states them. */ overrides: string[] };
  /** The pipeline's whole lesson set after this day, with simulated timestamps (createdAt/updatedAt at the day's end). */
  lessons: Lesson[];
  /** null: the pipeline was read as of a date and its cost was not measured. */
  costUsd: number | null;
  calls: number | null;
}
export interface SnapshotBuilder { build(request: SnapshotRequest): Promise<SnapshotResult> }

export interface BuiltSnapshots {
  snapshots: Record<string, Record<string, string>>;
  /** Learning cost per `on:<pipeline>` arm over the whole replay. `off` is listed with 0. */
  learning: ArmLearningCost[];
  /** The last day's lessons per pipeline: the final set. */
  finalLessons: Record<string, Lesson[]>;
  /** Each pipeline's whole lesson set on each simulated day (what a file arm offers a local agent on that day). */
  lessonsByDay: Record<string, Record<string, Lesson[]>>;
  lessonSets: ArmLessonSet[];
}

/** Builds each pipeline's snapshot for each simulated day, in time order, each from the outcomes of tasks before that day. */
export async function buildSnapshots(input: { key: { workspaceId: string; project: string }; tasks: readonly ReplayCandidate[]; arms: readonly string[]; builders: Record<string, SnapshotBuilder>; /** A hard limit on what the builders may spend in all. */ maxUsd?: number }): Promise<BuiltSnapshots> {
  const tasks = [...input.tasks].sort((a, b) => a.at - b.at || (a.taskId < b.taskId ? -1 : 1));
  const days = [...new Set(tasks.map((t) => dayOf(t.at)))].sort();
  const arms = input.arms.map(canonicalArm);
  const pipelines = [...new Set(arms.map((arm) => parseArm(arm)).filter((p) => p.kind !== "off").map((p) => p.label!))];
  const out: BuiltSnapshots = { snapshots: {}, learning: [], finalLessons: {}, lessonsByDay: {}, lessonSets: [] };
  for (const pipeline of pipelines) {
    const builder = input.builders[pipeline];
    if (builder === undefined) throw new ArmNotBuiltError(`on:${pipeline}`, `no snapshot builder for pipeline ${pipeline}.`);
    let usd: number | null = 0, calls: number | null = 0, dropped = 0;
    let last: SnapshotResult["export"] | undefined;
    out.snapshots[pipeline] = {};
    out.lessonsByDay[pipeline] = {};
    for (const day of days) {
      const historical = tasks.filter((t) => dayOf(t.at) < day);
      const built = await builder.build({ pipeline, day, learningCalls: "explicit", historical });
      // The rule is checked by what the builder DELIVERED, not by its name: offline there are no people, so a lesson that is not active, or that carries a person's approval, was not made by the pipeline under the rule.
      if (built.export?.rule !== REPLAY_EXPORT_RULE || exportViolations(built.lessons).length > 0) throw new ReplayExportRuleError(pipeline);
      last = built.export;
      dropped += built.export.droppedCalls;
      // The id the install derives from the lessons themselves, so the snapshot a copy is started on is exactly the one imported (not a name the builder chose).
      out.snapshots[pipeline][day] = evalSnapshotIdOf(input.key, built.lessons);
      usd = usd === null || built.costUsd === null ? null : usd + built.costUsd;
      calls = calls === null || built.calls === null ? null : calls + built.calls;
      if (input.maxUsd !== undefined && (usd ?? 0) > input.maxUsd) throw new RangeError(`Building the ${pipeline} snapshots cost more than --max-usd ${String(input.maxUsd)}. Stopped.`);
      out.finalLessons[pipeline] = built.lessons;
      out.lessonsByDay[pipeline][day] = built.lessons;
    }
    out.learning.push({ arm: `on:${pipeline}`, usd, calls, ...(last === undefined ? {} : { proposed: last.proposed, needsPerson: last.needsPerson, truncated: last.truncated, droppedCalls: dropped, unverified: last.unverified, overrides: last.overrides }) });
    out.lessonSets.push(summarizeLessonSet(`on:${pipeline}`, out.finalLessons[pipeline] ?? []));
  }
  if (arms.includes("off")) out.learning.push({ arm: "off", usd: 0, calls: 0 });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Running

/** How a local agent is offered lessons (DECISIONS 50.5). TODO(R2, MCP): both are stubs until the repository file (`.rovara/lessons.md`) and the MCP tool exist. */
export interface ExecutedRun {
  /** Content keys (`lessonContentKey`) of the lessons the run was given, from its load records. */
  loaded: string[];
  /** What the copy cost, or null when unpriced (it is then counted at its hold, never at 0). */
  costUsd: number | null;
  /** An opaque reference the grader reads the run's result from (a task id). */
  evidence: string;
  /** The executor confirms the task it made carries the eval marker. */
  evalRunMarked: boolean;
  /** Learning calls the run made: always 0. */
  learningCalls: number;
  /** Called after the run is graded (or when grading failed): closes the copy. Never throws into the replay. */
  cleanup?: () => Promise<void>;
}
/** The company's route answered a grading as another model than the one the replay declared (its lessons model is a setting that can change under a long run): gradings by two models are not comparable, so the replay stops. */
export class GraderModelChangedError extends Error {
  constructor(readonly declared: string, readonly answered: string | undefined) { super(`the grader answered as ${answered ?? "an unnamed model"}, not the declared ${declared}; the replay's grader must not change`); this.name = "GraderModelChangedError"; }
}
/** A copy that started under a spend limit the replay's budget did not reserve for (more planning allowance than declared, or none at all): its worst case cannot be bounded, so the whole replay stops. */
export class ReplayLimitError extends Error {
  constructor(readonly runKey: string, detail: string) { super(`The copy for ${runKey} started under a spend limit the replay did not reserve for (${detail}); the replay stopped.`); this.name = "ReplayLimitError"; }
}
/** The most one copy can cost: what planning may spend before the plan is approved, plus the run limit the approval then sets (the run limit's window restarts at what planning spent). A run is not started unless the budget has room for this. */
export const copyWorstCaseUsd = (limits: { planningLimitUsd: number; runLimitUsd: number }): number => limits.planningLimitUsd + limits.runLimitUsd;

/** A run that started a copy and did not finish it. The copy was cancelled; `costUsd` is what it had cost (null: not known, counted at its hold). */
export class ReplayRunFailed extends Error {
  constructor(readonly costUsd: number | null, message = "the replayed task did not finish") { super(message); this.name = "ReplayRunFailed"; }
}
export interface ReplayExecutor {
  run(input: { run: PlannedRun; task: ReplayCandidate; learning: { lessonsSwitch: "off"; calls: "none" } }): Promise<ExecutedRun>;
}
/** What the grader is shown. NO arm, pipeline or memory setting: it must grade blind. */
export interface GradeRequest { task: ReplayCandidate; repeat: number; evidence: string; priorCorrections: string[] }
export interface GradeResult { resolved: boolean; gradedBy: ReplayGradedBy; mistakes: string[]; /** What the grading cost (the grader's model); counted in the budget. */ costUsd?: number }
export interface ReplayGraderPort {
  identity: ReplayGrader;
  /** The most one grading may cost: a grading that throws is counted at this (it may have been paid for). */
  holdUsd?: number;
  grade(request: GradeRequest): Promise<GradeResult>;
}
export interface RunSink {
  /** The keys of runs already recorded (a replay resumes where it stopped). */
  done(): ReadonlySet<string>;
  /** What the recorded runs cost (copies and gradings, failed ones included): a resumed replay starts from it, so its limit holds across invocations. */
  spentUsd(): number;
  append(key: string, row: ReplayRunRow, chargeUsd: number): Promise<void>;
}
export interface RunDeps {
  executor: ReplayExecutor;
  grader: ReplayGraderPort;
  sink: RunSink;
  /** The ids of the historical corrections from before a task. */
  priorCorrections(task: ReplayCandidate): Promise<string[]>;
  /** A HARD limit (US dollars) on what the whole replay may spend. */
  maxUsd: number;
  /** The WORST CASE of one copy (`copyWorstCaseUsd`: planning allowance plus run limit): a run is not started unless the limit has room for all of it and the grading, and a run that fails or is unpriced is counted at this. */
  holdPerRunUsd: number;
  /** Spent before this replay's runs: building the lessons of the arms (their model calls). */
  alreadySpentUsd?: number;
}
export interface RunReport { ran: number; skipped: number; ungraded: number; costUsd: number; stoppedBy: "done" | "max_usd" }

export async function runReplay(plan: ReplayPlan, deps: RunDeps): Promise<RunReport> {
  if (deps.grader.identity.model !== plan.grader.model || deps.grader.identity.version !== plan.grader.version) {
    throw new GraderMismatchError(`The plan names grader ${plan.grader.model} ${plan.grader.version} but the grader given is ${deps.grader.identity.model} ${deps.grader.identity.version}.`);
  }
  // Before anything runs: the MCP arm is not built.
  for (const arm of plan.arms) if (parseArm(arm).kind === "mcp") throw new ArmNotBuiltError(arm, "the MCP lessons tool is not built yet (TODO: the MCP lane).");
  const byTask = new Map(plan.tasks.map((t) => [t.taskId, t] as const));
  const done = deps.sink.done();
  if (!Number.isFinite(deps.maxUsd) || deps.maxUsd <= 0) throw new RangeError("A replay run needs a positive maximum cost in US dollars (--max-usd).");
  if (!Number.isFinite(deps.holdPerRunUsd) || deps.holdPerRunUsd <= 0) throw new RangeError("A replay run needs the most one copy may cost, in US dollars.");
  const report: RunReport = { ran: 0, skipped: 0, ungraded: 0, costUsd: 0, stoppedBy: "done" };
  // The whole replay's spend: what was spent before it (the arms' lessons), what earlier invocations recorded, and what this one spends.
  let spent = (deps.alreadySpentUsd ?? 0) + deps.sink.spentUsd();
  for (const run of plan.runs) {
    if (done.has(run.key)) { report.skipped += 1; continue; }
    // A HARD stop: a run starts only if the limit has room for the most it may cost, and for the grading that follows.
    if (spent + deps.holdPerRunUsd + (deps.grader.holdUsd ?? 0) > deps.maxUsd) { report.stoppedBy = "max_usd"; return report; }
    const task = byTask.get(run.task)!;
    let executed: ExecutedRun | undefined;
    let charge = 0;
    const ungraded = (loaded: string[], costUsd: number | null): ReplayRunRow => ReplayRunRowSchema.parse({ task: run.task, repeat: run.repeat, arm: run.arm, resolved: null, loaded, costUsd });
    try {
      executed = await deps.executor.run({ run, task, learning: { lessonsSwitch: "off", calls: "none" } });
    } catch (error) {
      // A copy stopped by the limit check was started (and cancelled): its reserved hold is charged in the ledger before the replay stops, so a rerun does not forget the money.
      if (error instanceof ReplayLimitError) { await deps.sink.append(run.key, ungraded([], null), deps.holdPerRunUsd); throw error; }
      // An unmarked task or a learning call ends the whole replay; any other fault is one ungraded run, counted at what the copy cost, or at its hold when that is not known.
      if (error instanceof EvalMarkError || error instanceof ReplayLearningCallError || error instanceof ArmNotBuiltError) throw error;
      charge += error instanceof ReplayRunFailed && error.costUsd !== null ? error.costUsd : deps.holdPerRunUsd;
      executed = undefined;
    }
    if (executed !== undefined) {
      if (executed.evalRunMarked !== true) throw new EvalMarkError(run.key);
      if (executed.learningCalls !== 0) throw new ReplayLearningCallError(run.key);
    }
    let row: ReplayRunRow;
    let graderChanged: GraderModelChangedError | undefined;
    if (executed === undefined) row = ungraded([], null);
    else {
      charge += executed.costUsd ?? deps.holdPerRunUsd;
      try {
        const prior = await deps.priorCorrections(task);
        const graded = await deps.grader.grade({ task, repeat: run.repeat, evidence: executed.evidence, priorCorrections: prior });
        charge += graded.costUsd ?? 0;
        // A mistake must name a correction that was given before the task; anything else is not a repeat.
        if (graded.mistakes.some((id) => !prior.includes(id))) throw new Error("the grader named a correction that was not given before the task");
        row = ReplayRunRowSchema.parse({ task: run.task, repeat: run.repeat, arm: run.arm, resolved: graded.resolved, grader: deps.grader.identity, gradedBy: graded.gradedBy, loaded: executed.loaded, mistakes: [...new Set(graded.mistakes)], costUsd: executed.costUsd });
      } catch (error) {
        // A grading that failed may still have been paid for: it is counted at its hold.
        charge += deps.grader.holdUsd ?? 0;
        row = ungraded(executed.loaded, executed.costUsd);
        // The grader's model changed under the run: gradings by two models are not comparable, so the replay stops after this one is recorded.
        if (error instanceof GraderModelChangedError) graderChanged = error;
      }
      await executed.cleanup?.().catch(() => undefined);
    }
    if (row.resolved === null) report.ungraded += 1;
    spent += charge;
    report.costUsd += charge;
    await deps.sink.append(run.key, row, charge);
    report.ran += 1;
    if (graderChanged !== undefined) throw graderChanged;
  }
  return report;
}

export { lessonContentKey };
