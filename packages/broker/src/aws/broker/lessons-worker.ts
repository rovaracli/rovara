// Part of the broker: the LessonsWorker's handler (lessons in production, lane 2, WB-4). The Lambda has its own slim entry (`../lessons-worker-entry.ts`, M6: an explicit environment, no broker handler, no callback
// signing key) and builds the dependencies learning needs, then `installLessons` builds `dependencies.learning` from the Team record, the model path and the spend ledger, exactly as the broker does.
// It is built on the first message, not at start-up.
// A PAUSED record (TEAM_RECORD_ACTIVE exactly "0") learns nothing: every message is answered (dropped, one fixed log line) rather than held, and a later switch-on is served by the nightly re-reflection and the next
// task ends. Any other reason the dependencies cannot be built (a missing environment value, no table, no model path, no ledger) is a MISCONFIGURATION (re-check R5): the handler throws, so the Errors alarm fires and
// the messages stay in the queue (then its dead-letter queue, which alarms too), never a quiet drop.
import { LESSONS_WORKER_DEADLINE_SECONDS, OrgIdSchema } from "@rovara-code/contracts";
import { keysOutcome } from "../../spend/ledger.js";
import { dynamoReflectClaims } from "../../lessons/reflect-claims.js";
import type { ReflectVisibility } from "../../lessons/reflect-queue.js";
import { handleReflectBatch, type QueueBatch, type ReflectWorkerDeps, type WorkerContext } from "../../lessons/reflect-worker.js";
import { teamRecordIsPaused } from "../../team-record/runtime.js";
import { learnFromHumanEdit } from "../../lessons/human-edit.js";
import { learnFromEndedTaskTyped } from "../../lessons/task-end.js";
import type { LessonsHostDependencies } from "./definitions.js";
import { installLessons } from "./lessons-wiring.js";
import { ledgerOf } from "./sweeps-and-readiness.js";

const log = (event: string, fields: Record<string, string | number>): void => console.log(JSON.stringify({ component: "lessons", event, ...fields }));

export interface LessonsWorkerOptions { now?: () => number; deadlineMs?: number; visibility?: ReflectVisibility; env?: Record<string, string | undefined> }

/** The worker's dependencies from the install's, or undefined where learning is not set up in this install (or there is no spend ledger to look keys up in). */
export function lessonsWorkerDepsOf(dependencies: LessonsHostDependencies, options: LessonsWorkerOptions = {}): ReflectWorkerDeps | undefined {
  installLessons(dependencies);
  const learning = dependencies.learning;
  const ledger = ledgerOf(dependencies);
  if (learning === undefined || ledger === undefined) return undefined;
  // (A partial record runtime, as in some test harnesses, has no `humanEdit`: then a human-edit message is not answered and ends in the dead-letter queue.)
  const humanEditing = (dependencies.teamRecord as { humanEdit?: NonNullable<LessonsHostDependencies["teamRecord"]>["humanEdit"] } | undefined)?.humanEdit;
  return {
    claims: dynamoReflectClaims({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, keysOutcome: (orgId, keyIds) => keysOutcome(ledger, OrgIdSchema.parse(orgId), keyIds) }),
    learn: (request) => learnFromEndedTaskTyped(learning, { workspaceId: request.workspaceId, taskId: request.taskId, outcome: request.outcome }),
    // Lessons capture: a human fix-up commit is read and learned from under the same lease, deadline and attempt (the Team record's own once-claim is left out: the lease is the once-claim).
    ...(humanEditing === undefined ? {} : { humanEdit: (job) => learnFromHumanEdit({ run: (edit) => humanEditing.run(edit, { leased: true }), settings: learning.settings }, job) }),
    now: options.now ?? Date.now,
    deadlineMs: options.deadlineMs ?? LESSONS_WORKER_DEADLINE_SECONDS * 1000,
    ...(options.visibility === undefined ? {} : { visibility: options.visibility }),
    log,
  };
}

export function createLessonsWorkerHandler(build: () => LessonsHostDependencies, options: LessonsWorkerOptions = {}) {
  let built: { deps: ReflectWorkerDeps | undefined } | undefined;
  return async (event: QueueBatch, context?: WorkerContext): Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }> => {
    built ??= { deps: lessonsWorkerDepsOf(build(), options) };
    if (built.deps === undefined) {
      if (teamRecordIsPaused(options.env ?? process.env)) {
        log("lessons_worker.off", { messages: event.Records.length });
        return { batchItemFailures: [] };
      }
      // Not remembered: the next invocation builds again (a fixed environment value may have been corrected).
      built = undefined;
      log("lessons_worker.misconfigured", { messages: event.Records.length });
      throw new Error("the lessons worker is not configured: learning, the model path or the spend ledger is missing");
    }
    return handleReflectBatch(built.deps, event, context);
  };
}
