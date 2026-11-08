// Part of the broker: the LessonsWorker's handler (lessons in production, lane 2, WB-4). The Lambda has its own slim entry (`../lessons-worker-entry.ts`, M6: an explicit environment, no broker handler, no callback
// signing key) and builds the dependencies learning needs, then `installLessons` builds `dependencies.learning` from the Team record, the model path and the spend ledger, exactly as the broker does.
// It is built on the first message, not at start-up.
// Where the Team record is off or paused, or the install has no model path, there is nothing to learn with: every message is answered (dropped, one fixed log line) rather than held, because a paused record
// "learns nothing" and a later switch-on is served by the nightly re-reflection and the next task ends.
import { LESSONS_WORKER_DEADLINE_SECONDS, OrgIdSchema } from "@agentx/contracts";
import { keysOutcome } from "../../spend/ledger.js";
import { dynamoReflectClaims } from "../../lessons/reflect-claims.js";
import type { ReflectVisibility } from "../../lessons/reflect-queue.js";
import { handleReflectBatch, type QueueBatch, type ReflectWorkerDeps, type WorkerContext } from "../../lessons/reflect-worker.js";
import { learnFromEndedTaskTyped } from "../../lessons/task-end.js";
import type { LessonsHostDependencies } from "./definitions.js";
import { installLessons } from "./lessons-wiring.js";
import { ledgerOf } from "./sweeps-and-readiness.js";

const log = (event: string, fields: Record<string, string | number>): void => console.log(JSON.stringify({ component: "lessons", event, ...fields }));

export interface LessonsWorkerOptions { now?: () => number; deadlineMs?: number; visibility?: ReflectVisibility }

/** The worker's dependencies from the install's, or undefined where learning is not set up in this install (or there is no spend ledger to look keys up in). */
export function lessonsWorkerDepsOf(dependencies: LessonsHostDependencies, options: LessonsWorkerOptions = {}): ReflectWorkerDeps | undefined {
  installLessons(dependencies);
  const learning = dependencies.learning;
  const ledger = ledgerOf(dependencies);
  if (learning === undefined || ledger === undefined) return undefined;
  return {
    claims: dynamoReflectClaims({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, keysOutcome: (orgId, keyIds) => keysOutcome(ledger, OrgIdSchema.parse(orgId), keyIds) }),
    learn: (request) => learnFromEndedTaskTyped(learning, { workspaceId: request.workspaceId, taskId: request.taskId, outcome: request.outcome }),
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
      log("lessons_worker.off", { messages: event.Records.length });
      return { batchItemFailures: [] };
    }
    return handleReflectBatch(built.deps, event, context);
  };
}
