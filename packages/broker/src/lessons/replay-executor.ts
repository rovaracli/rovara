// Lane 7: the replay's executor for a real install. It is the ONLY way the harness starts a task, and it cannot start an unmarked one: the start request is built here with `evalRun: true` (a literal type, not a
// caller's choice), and after the start the mark is READ BACK from the task record; a task that does not carry it exactly is cancelled and the whole replay stops (`EvalMarkError`). It adds nothing else to the
// run: the arm's memory input or delivery, the run key, and the source task whose request is replayed.
//
// The port (`ReplayTaskPort`) is what the install must offer. TODO (the one blocker for a real staging run): no broker route starts a copy of a past task with a `memory` input and the `evalRun` mark, and the
// loader does not yet honour `memory: { mode: "snapshot" }`. The existing e2e replay (`aws/workflow-e2e-replay.ts`, `agentx admin task e2e-replay`, `scripts/e2e-replay-round.ts`) re-verifies the recorded UI
// round of a task with no model; it starts no task and cannot carry a memory input, so it cannot be this port. Its shape (an admin route, a CLI client, a script that polls to the end) is the pattern to copy.
import { isEvalRunMark } from "./eval-run.js";
import { EvalMarkError, type ExecutedRun, type PlannedRun, type ReplayExecutor } from "./replay-harness.js";
import { lessonContentKey } from "./replay-lessonset.js";
import type { MemoryInput } from "@agentx/contracts";

/** What the install is asked to start. `evalRun` is always the literal true. */
export interface ReplayStartRequest {
  /** The past task whose request is replayed. */
  sourceTaskId: string;
  /** The run's key in the plan (the install may use it to make the start idempotent). */
  runKey: string;
  memory?: MemoryInput;
  delivery?: "file" | "mcp";
  evalRun: true;
}
export interface ReplayTaskEnd { state: "completed" | "failed"; evidence: string; costUsd: number | null }
export interface ReplayTaskPort {
  start(request: ReplayStartRequest): Promise<{ taskId: string }>;
  /** The `evalRun` field of the started task's record, as stored. */
  readMark(taskId: string): Promise<unknown>;
  cancel(taskId: string): Promise<void>;
  waitForEnd(taskId: string): Promise<ReplayTaskEnd>;
  /** The lessons the run was given, from its load records. */
  loadedLessons(taskId: string): Promise<Array<{ title: string; body: string }>>;
  /** How many learning model calls were made for the task (always 0). */
  learningCalls(taskId: string): Promise<number>;
}

export function stagingExecutor(port: ReplayTaskPort): ReplayExecutor {
  return {
    async run({ run, task }: { run: PlannedRun; task: { taskId: string } }): Promise<ExecutedRun> {
      // A plan that was edited by hand to drop the mark is refused before anything starts.
      if ((run as { evalRun?: unknown }).evalRun !== true) throw new EvalMarkError(run.key);
      const request: ReplayStartRequest = { sourceTaskId: task.taskId, runKey: run.key, evalRun: true, ...(run.memory === undefined ? {} : { memory: run.memory }), ...(run.delivery === undefined ? {} : { delivery: run.delivery }) };
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
      const loaded = (await port.loadedLessons(started.taskId)).map((lesson) => lessonContentKey(lesson));
      return { loaded, costUsd: end.costUsd, evidence: end.evidence, evalRunMarked: true, learningCalls: await port.learningCalls(started.taskId) };
    },
  };
}
