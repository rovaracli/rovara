// Part of the broker: the LessonsWorker's handler (lessons in production, lane 2, WB-4). The Lambda is the broker's own bundle with its own entry (`lessonsWorkerHandler`, exported by `../broker.ts`), outside the
// VPC like the broker, so it builds the same dependencies the same way (`brokerDependencies`, then `installLessons`, which builds `dependencies.learning` from the Team record, the model path and the spend ledger).
// It is built on the first message, not at start-up, so the broker's own container (which loads the same module) never builds it.
// Where the Team record is off or paused, or the install has no model path, there is nothing to learn with: every message is answered (dropped, one fixed log line) rather than held, because a paused record
// "learns nothing" and a later switch-on is served by the nightly re-reflection and the next task ends.
import { LESSONS_WORKER_DEADLINE_SECONDS } from "@agentx/contracts";
import { dynamoReflectClaims } from "../../lessons/reflect-claims.js";
import { handleReflectBatch, type QueueBatch, type ReflectWorkerDeps } from "../../lessons/reflect-worker.js";
import { learnFromEndedTask } from "../../lessons/task-end.js";
import { brokerDependencies } from "./dependency-wiring.js";
import type { AwsBrokerInput } from "./definitions.js";
import { installLessons } from "./lessons-wiring.js";

const log = (event: string, fields: Record<string, string | number>): void => console.log(JSON.stringify({ component: "lessons", event, ...fields }));

/** The worker's dependencies from the broker's input, or undefined where learning is not set up in this install. */
export function lessonsWorkerDepsOf(input: AwsBrokerInput, options: { now?: () => number; deadlineMs?: number } = {}): ReflectWorkerDeps | undefined {
  const dependencies = brokerDependencies(input);
  installLessons(dependencies);
  const learning = dependencies.learning;
  if (learning === undefined) return undefined;
  return {
    claims: dynamoReflectClaims({ documentClient: dependencies.documentClient, tableName: dependencies.tableName }),
    learn: (request) => learnFromEndedTask(learning, { workspaceId: request.workspaceId, taskId: request.taskId, outcome: request.outcome }),
    now: options.now ?? Date.now,
    deadlineMs: options.deadlineMs ?? LESSONS_WORKER_DEADLINE_SECONDS * 1000,
    log,
  };
}

export function createLessonsWorkerHandler(input: AwsBrokerInput, options: { now?: () => number; deadlineMs?: number } = {}) {
  let built: { deps: ReflectWorkerDeps | undefined } | undefined;
  return async (event: QueueBatch): Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }> => {
    built ??= { deps: lessonsWorkerDepsOf(input, options) };
    if (built.deps === undefined) {
      log("lessons_worker.off", { messages: event.Records.length });
      return { batchItemFailures: [] };
    }
    return handleReflectBatch(built.deps, event);
  };
}
