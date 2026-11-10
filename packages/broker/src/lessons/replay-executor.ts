// Lane 7: the replay's executor for a real install. It is the ONLY way the harness starts a task, and it cannot start an unmarked one: the start request is built here with `evalRun: true` (a literal type, not a
// caller's choice), and after the start the mark is READ BACK from the task record; a task that does not carry it exactly is cancelled and the whole replay stops (`EvalMarkError`). It adds nothing else to the
// run: the arm's memory input or delivery, the run key, and the source task whose request is replayed.
//
// The port (`ReplayTaskPort`) is what the install offers: `POST/GET /v1/admin/tasks/{taskId}/lessons-replay` (`aws/broker/admin-and-helpers.ts#adminTaskLessonsReplay`, `aws/developer-tasks/lessons-replay.ts`), reached by
// `agentx admin task lessons-replay` and `scripts/lessons-replay-port.ts`. The route sets the mark itself at creation; the check here is a second lock, from outside. The file arm is not built on the install (the worker
// places a file arm's lessons file itself, from the snapshot).
import { isEvalRunMark } from "./eval-run.js";
import { EvalMarkError, ReplayLimitError, ReplayRunFailed, copyWorstCaseUsd, type ExecutedRun, type PlannedRun, type ReplayExecutor } from "./replay-harness.js";

/** What the install is asked to start. `evalRun` is always the literal true. */
export interface ReplayStartRequest {
  /** The past task whose request is replayed. */
  sourceTaskId: string;
  /** The run's key in the plan (the install may use it to make the start idempotent). */
  runKey: string;
  /** Off, or one snapshot (imported to the install beforehand: `agentx admin lessons-replay import-snapshot`). */
  memory?: { mode: "off" } | { mode: "snapshot"; snapshotId: string };
  /** The most the copy may spend, in US dollars (the run's own limit). */
  maxUsd: number;
  /** The file arm: the install places `.rovara/lessons.md` and its pointer in the copy's checkout from the snapshot. */
  file?: true;
  evalRun: true;
}
export interface ReplayTaskEnd { state: "completed" | "failed"; evidence: string; costUsd: number | null }
export interface ReplayTaskPort {
  /** `startLimitUsd`: the spend limit the copy started under (its planning limit); null when it started with none. */
  start(request: ReplayStartRequest): Promise<{ taskId: string; startLimitUsd?: number | null }>;
  /** The `evalRun` field of the started task's record, as stored. */
  readMark(taskId: string): Promise<unknown>;
  cancel(taskId: string): Promise<void>;
  /**
   * Waits for the copy to end: approves its plan when one waits (the install's guarded route), and CANCELS it and returns failed when its cost reaches `limits.maxUsd` (the copy's worst case: planning allowance plus run limit) or the wait runs out. `costUsd` is what it cost,
   * read from the install even when it failed.
   */
  waitForEnd(taskId: string, limits: { maxUsd: number }): Promise<ReplayTaskEnd>;
  /** What the copy has cost so far (null: not known). */
  costOf(taskId: string): Promise<number | null>;
  /** The content keys (`lessonContentKey`) of the lessons the copy was given, from its load records. */
  loadedKeys(taskId: string): Promise<string[]>;
  /** Learning model calls charged to the copy: always 0, since every learning path refuses a copy (tests prove it). The install does not count them, so this says 0 or, when it cannot be read, 1. */
  learningCalls(taskId: string): Promise<number>;
  /** Closes the copy once it is graded. */
  close(taskId: string): Promise<void>;
}

export interface StagingExecutorOptions {
  /** The run limit of one copy, in US dollars (what it may spend once its plan is approved). */
  maxUsdPerRun: number;
  /** What a copy may spend planning, before its plan is approved: the project's planning limit for the workflow path (Spending > Projects). The copy's real total is up to this plus the run limit, and the replay's budget reserves that. */
  planningLimitUsd: number;
}

export function stagingExecutor(port: ReplayTaskPort, options: StagingExecutorOptions): ReplayExecutor {
  if (!Number.isFinite(options.maxUsdPerRun) || options.maxUsdPerRun <= 0) throw new RangeError("A staging executor needs a positive spend limit for each copy.");
  if (!Number.isFinite(options.planningLimitUsd) || options.planningLimitUsd < 0) throw new RangeError("A staging executor needs the project's planning limit (zero or more) to reserve each copy's worst case.");
  const worstCaseUsd = copyWorstCaseUsd({ planningLimitUsd: options.planningLimitUsd, runLimitUsd: options.maxUsdPerRun });
  return {
    async run({ run, task }: { run: PlannedRun; task: { taskId: string } }): Promise<ExecutedRun> {
      // A plan that was edited by hand to drop the mark is refused before anything starts.
      if ((run as { evalRun?: unknown }).evalRun !== true || run.memory?.mode === "live") throw new EvalMarkError(run.key);
      const request: ReplayStartRequest = { sourceTaskId: task.taskId, runKey: run.key, evalRun: true, maxUsd: options.maxUsdPerRun,
        ...(run.memory === undefined ? {} : { memory: run.memory.mode === "snapshot" ? { mode: "snapshot" as const, snapshotId: run.memory.snapshotId } : { mode: "off" as const } }),
        ...(run.delivery === "file" ? { file: true as const } : {}) };
      const started = await port.start(request);
      // The copy must have started under the planning limit the budget reserved for, and under some limit at all: otherwise its worst case is not bounded and the whole replay stops.
      if (started.startLimitUsd === undefined || started.startLimitUsd === null || started.startLimitUsd > options.planningLimitUsd + 1e-9) {
        await port.cancel(started.taskId).catch(() => undefined);
        await port.close(started.taskId).catch(() => undefined);
        throw new ReplayLimitError(run.key, started.startLimitUsd === undefined || started.startLimitUsd === null ? "no limit" : `$${String(started.startLimitUsd)} against $${String(options.planningLimitUsd)} planned`);
      }
      // Read the mark back. Exactly `true`: a port that dropped it, or wrote something else, has started a task that could be learned from.
      let mark: unknown;
      try { mark = await port.readMark(started.taskId); } catch { mark = undefined; }
      if (mark !== true || !isEvalRunMark(mark)) {
        await port.cancel(started.taskId).catch(() => undefined);
        throw new EvalMarkError(run.key);
      }
      let end: ReplayTaskEnd;
      try {
        end = await port.waitForEnd(started.taskId, { maxUsd: worstCaseUsd });
        if (end.state !== "completed") throw new ReplayRunFailed(end.costUsd);
      } catch (error) {
        // A copy that did not finish is stopped, and what it cost is read from the install before it is counted.
        await port.cancel(started.taskId).catch(() => undefined);
        const cost = error instanceof ReplayRunFailed ? error.costUsd : await port.costOf(started.taskId).catch(() => null);
        await port.close(started.taskId).catch(() => undefined);
        throw new ReplayRunFailed(cost);
      }
      const loaded = await port.loadedKeys(started.taskId);
      return { loaded, costUsd: end.costUsd, evidence: end.evidence, evalRunMarked: true, learningCalls: await port.learningCalls(started.taskId), cleanup: () => port.close(started.taskId) };
    },
  };
}
