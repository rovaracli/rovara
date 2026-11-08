// Lessons in production, lane 2 (WB-4): the LessonsWorker's work. One queue message is one finished task (`reflect-queue.ts`). The worker:
//   1. reads the message (anything that is not exactly the four ids is dropped with one fixed log line: a poison message must never be retried or hold the queue);
//   2. claims `LEARN#<task>#<outcome>` once, with a conditional put that expires in 30 days, so a redelivery (SQS delivers at least once, and a worker can die after it began) never runs the model or charges a second time;
//   3. runs `learnFromEndedTask` under a deadline: no model call starts that could still be running at the deadline, and the work is given up at the deadline whatever is running (a call in flight keeps its key's
//      cap held in the spend ledger until the ordinary sweep settles it, so giving up never loses or double-counts money).
// Only a fault of the claim itself (the table could not be written) makes the message fail and come back; the work after the claim never does, because a second run is exactly what the claim forbids.
import type { LearnStatus } from "./task-end.js";
import { withLearningDeadline } from "./learning-deadline.js";
import { parseReflectMessage, type ReflectMessage } from "./reflect-queue.js";

/** How long a claim is kept: far past the queue's 4 days of retention, so no redelivery of the same message can find the claim gone. */
export const CLAIM_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface ClaimStore {
  /** Takes the claim for this (task, outcome) once. `claimed`: this call took it; `already`: someone had. Throws when the table could not be written (the message is then tried again). */
  claim(message: ReflectMessage, nowSeconds: number): Promise<"claimed" | "already">;
}

export interface ReflectWorkerDeps {
  claims: ClaimStore;
  learn(input: { workspaceId: string; taskId: string; outcome: ReflectMessage["outcome"] }): Promise<LearnStatus>;
  now(): number;
  /** The reflection stops being started this long after the worker began it (default: the contracts' 240 s). */
  deadlineMs: number;
  log(event: string, fields: Record<string, string | number>): void;
}

export type ReflectResult = LearnStatus | "invalid" | "already" | "timed_out" | "failed";

export async function runReflectMessage(deps: ReflectWorkerDeps, body: string): Promise<ReflectResult> {
  const message = parseReflectMessage(body);
  if (message === undefined) {
    deps.log("lessons_worker.invalid_message", {});
    return "invalid";
  }
  const claimed = await deps.claims.claim(message, Math.floor(deps.now() / 1000));
  if (claimed === "already") {
    deps.log("lessons_worker.already_claimed", { taskId: message.taskId });
    return "already";
  }
  const startedAt = deps.now();
  const deadlineAt = startedAt + deps.deadlineMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timedOut = new Promise<"timed_out">((resolve) => { timer = setTimeout(() => resolve("timed_out"), deps.deadlineMs); });
    const done = withLearningDeadline(deadlineAt, () => deps.learn({ workspaceId: message.orgId, taskId: message.taskId, outcome: message.outcome }));
    // The loser of the race keeps running without anyone waiting for it; its own failure must not become an unhandled rejection.
    done.catch(() => undefined);
    const result = await Promise.race([done, timedOut]);
    if (result === "timed_out") deps.log("lessons_worker.deadline", { taskId: message.taskId });
    return result;
  } catch {
    deps.log("lessons_worker.failed", { taskId: message.taskId });
    return "failed";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface QueueBatch { Records: Array<{ messageId: string; body: string }> }

/** The partial-batch answer SQS reads: only a message whose claim could not be made comes back. */
export async function handleReflectBatch(deps: ReflectWorkerDeps, event: QueueBatch): Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }> {
  const batchItemFailures: Array<{ itemIdentifier: string }> = [];
  for (const record of event.Records) {
    try {
      await runReflectMessage(deps, record.body);
    } catch {
      deps.log("lessons_worker.claim_failed", {});
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}
