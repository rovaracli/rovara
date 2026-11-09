// Lane 7: the replay's executor for a real install. It is the ONLY way the harness starts a task, and it cannot start an unmarked one: the start request is built here with `evalRun: true` (a literal type, not a
// caller's choice), and after the start the mark is READ BACK from the task record; a task that does not carry it exactly is cancelled and the whole replay stops (`EvalMarkError`). It adds nothing else to the
// run: the arm's memory input or delivery, the run key, and the source task whose request is replayed.
//
// The port (`ReplayTaskPort`) is what the install offers: `POST/GET /v1/admin/tasks/{taskId}/lessons-replay` (`aws/broker/admin-and-helpers.ts#adminTaskLessonsReplay`, `aws/developer-tasks/lessons-replay.ts`), reached by
// `agentx admin task lessons-replay` and `scripts/lessons-replay-port.ts`. The route sets the mark itself at creation; the check here is a second lock, from outside. The file arm is not built on the install (the worker
// cannot yet write a file into a checkout): a request that carries a lessons file is refused by name.
import { isEvalRunMark } from "./eval-run.js";
import { ArmNotBuiltError, EvalMarkError, type ExecutedRun, type LessonsFileOffer, type PlannedRun, type ReplayExecutor } from "./replay-harness.js";

/** What the install is asked to start. `evalRun` is always the literal true. */
export interface ReplayStartRequest {
  /** The past task whose request is replayed. */
  sourceTaskId: string;
  /** The run's key in the plan (the install may use it to make the start idempotent). */
  runKey: string;
  /** Off, or one snapshot: with `lessons` (the ids and versions it names) the install creates the snapshot if it does not exist yet. */
  memory?: { mode: "off" } | { mode: "snapshot"; snapshotId: string; lessons?: Array<{ id: string; version: number }> };
  /** The most the copy may spend, in US dollars (the run's own limit). */
  maxUsd: number;
  evalRun: true;
}
export interface ReplayTaskEnd { state: "completed" | "failed"; evidence: string; costUsd: number | null }
export interface ReplayTaskPort {
  start(request: ReplayStartRequest): Promise<{ taskId: string }>;
  /** The `evalRun` field of the started task's record, as stored. */
  readMark(taskId: string): Promise<unknown>;
  cancel(taskId: string): Promise<void>;
  waitForEnd(taskId: string): Promise<ReplayTaskEnd>;
  /** The content keys (`lessonContentKey`) of the lessons the copy was given, from its load records. */
  loadedKeys(taskId: string): Promise<string[]>;
  /** How many learning model calls were made for the task (always 0). */
  learningCalls(taskId: string): Promise<number>;
}

export interface StagingExecutorOptions {
  /** The most one copy may spend, in US dollars. */
  maxUsdPerRun: number;
  /** The lessons each snapshot names, for the install to create a snapshot it has not seen. */
  snapshotRefs?: ReadonlyMap<string, Array<{ id: string; version: number }>>;
}

export function stagingExecutor(port: ReplayTaskPort, options: StagingExecutorOptions): ReplayExecutor {
  if (!Number.isFinite(options.maxUsdPerRun) || options.maxUsdPerRun <= 0) throw new RangeError("A staging executor needs a positive spend limit for each copy.");
  return {
    async run({ run, task, lessonsFile }: { run: PlannedRun; task: { taskId: string }; lessonsFile?: LessonsFileOffer }): Promise<ExecutedRun> {
      // The file arm needs the worker to write a file into the copy's checkout: not built. Stopped before anything starts (the install refuses it by name as well).
      if (lessonsFile !== undefined || run.delivery !== undefined) throw new ArmNotBuiltError(run.arm, "the install cannot place the lessons file in a replay copy's checkout yet (TODO: the worker).");
      // A plan that was edited by hand to drop the mark is refused before anything starts.
      if ((run as { evalRun?: unknown }).evalRun !== true) throw new EvalMarkError(run.key);
      const refs = run.memory?.mode === "snapshot" ? options.snapshotRefs?.get(run.memory.snapshotId) : undefined;
      if (run.memory?.mode === "live") throw new EvalMarkError(run.key);
      const request: ReplayStartRequest = { sourceTaskId: task.taskId, runKey: run.key, evalRun: true, maxUsd: options.maxUsdPerRun,
        ...(run.memory === undefined ? {} : { memory: run.memory.mode === "snapshot" ? { mode: "snapshot" as const, snapshotId: run.memory.snapshotId, ...(refs === undefined ? {} : { lessons: refs }) } : { mode: "off" as const } }) };
      const started = await port.start(request);
      // Read the mark back. Exactly `true`: a port that dropped it, or wrote something else, has started a task that could be learned from.
      let mark: unknown;
      try { mark = await port.readMark(started.taskId); } catch { mark = undefined; }
      if (mark !== true || !isEvalRunMark(mark)) {
        await port.cancel(started.taskId).catch(() => undefined);
        throw new EvalMarkError(run.key);
      }
      const end = await port.waitForEnd(started.taskId);
      if (end.state !== "completed") throw new Error("the replayed task did not complete");
      const loaded = await port.loadedKeys(started.taskId);
      return { loaded, costUsd: end.costUsd, evidence: end.evidence, evalRunMarked: true, learningCalls: await port.learningCalls(started.taskId) };
    },
  };
}
