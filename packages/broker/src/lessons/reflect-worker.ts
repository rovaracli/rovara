// Lessons in production, lane 2 (WB-4, H1, M4): the LessonsWorker's work. One queue message is one finished task (`reflect-queue.ts`). The worker:
//   1. reads the message (anything that is not exactly the four ids is dropped with one fixed log line: a poison message must never be retried or hold the queue);
//   2. takes the lease on `LEARN#<org>#<task>#<outcome>` (`reflect-claims.ts`): a redelivery, a second task-end call or the nightly re-send never runs the model twice. A fault that is known to have spent nothing
//      leaves the lease at `retry`; the next take runs the work again only if every model key the earlier attempt minted settled with nothing spent;
//   3. runs `learnFromEndedTaskTyped` as one attempt (`learning-deadline.ts`): no model call starts that could still be running at the deadline, the deadline's abort signal goes into the model call, the lesson store
//      stops writing once it is aborted, and a race gives up a little after it as the last guard (logged as a fault);
//   4. ends the lease: `done` for every final outcome, `retry` for a typed retryable fault (or the deadline).
// A message that must come back (a retry, a lease it must wait for, a claim that could not be made) is answered as a batch item failure, with a visibility backoff of 60 s, 300 s, then 900 s instead of the queue's whole
// 1800 s; the queue sends it to its dead-letter queue (which alarms) after five receives. The metric is the `lessons_worker.result` line, one per message, with a fixed class.
import { LESSONS_REFLECT_MAX_ATTEMPTS, LESSONS_REFLECT_RETRY_BACKOFF_SECONDS } from "@agentx/contracts";
import { withLearningAttempt, type LearningAttempt } from "./learning-deadline.js";
import { CLAIM_TTL_SECONDS, type ClaimStore } from "./reflect-claims.js";
import { parseReflectMessage, type ReflectMessage, type ReflectVisibility } from "./reflect-queue.js";
import type { LearnResult, LearnStatus } from "./task-end.js";

export { CLAIM_TTL_SECONDS };
export type { ClaimStore };

/** The worker keeps this much of the invocation's time for ending the lease and answering (the deadline is the invocation's remaining time less this). */
export const WORKER_RESERVE_MS = 60_000;
/** The race gives up this long after the abort signal, so the work can stop by itself first. */
export const DEADLINE_GRACE_MS = 10_000;

export interface ReflectWorkerDeps {
  claims: ClaimStore;
  learn(input: { workspaceId: string; taskId: string; outcome: ReflectMessage["outcome"] }): Promise<LearnResult>;
  now(): number;
  /** The reflection stops being started this long after the worker began it (default: the contracts' 240 s), or sooner when the invocation has less time left. */
  deadlineMs: number;
  graceMs?: number;
  /** Where a retry's backoff is set; without it a retry waits the queue's visibility timeout. */
  visibility?: ReflectVisibility;
  log(event: string, fields: Record<string, string | number>): void;
}

export type ReflectResult = LearnStatus | "invalid" | "already" | "wait" | "exhausted" | "timed_out" | "failed" | "no_time";
/** `retry`: the message must come back (a batch item failure). */
export interface ReflectOutcome { result: ReflectResult; retry: boolean }

export interface WorkerContext { getRemainingTimeInMillis?: () => number }

export async function runReflectMessage(deps: ReflectWorkerDeps, body: string, context?: WorkerContext): Promise<ReflectOutcome> {
  const message = parseReflectMessage(body);
  if (message === undefined) {
    deps.log("lessons_worker.invalid_message", {});
    return { result: "invalid", retry: false };
  }
  const remaining = context?.getRemainingTimeInMillis?.();
  const deadlineMs = remaining === undefined ? deps.deadlineMs : Math.min(deps.deadlineMs, remaining - WORKER_RESERVE_MS);
  if (deadlineMs <= 0) {
    deps.log("lessons_worker.result", { class: "no_time" });
    return { result: "no_time", retry: true };
  }
  const taken = await deps.claims.take(message, deps.now());
  if (taken.kind !== "taken") {
    deps.log("lessons_worker.result", { class: taken.kind, taskId: message.taskId });
    return taken.kind === "already" ? { result: "already", retry: false } : { result: taken.kind, retry: true };
  }
  const { lease } = taken;
  const startedAt = deps.now();
  const controller = new AbortController();
  const attempt: LearningAttempt = {
    deadlineAt: startedAt + deadlineMs, signal: controller.signal, attemptId: lease.attemptId, leaseKey: lease.key, lastAttempt: lease.attempt >= LESSONS_REFLECT_MAX_ATTEMPTS,
    callStarting: () => deps.claims.markCallStarted(lease, deps.now()),
    callNotSent: () => deps.claims.clearCallStarted(lease),
  };
  let abortTimer: ReturnType<typeof setTimeout> | undefined, raceTimer: ReturnType<typeof setTimeout> | undefined;
  let outcome: LearnResult;
  let result: ReflectResult;
  try {
    abortTimer = setTimeout(() => controller.abort(), deadlineMs);
    const timedOut = new Promise<"timed_out">((resolve) => { raceTimer = setTimeout(() => resolve("timed_out"), deadlineMs + (deps.graceMs ?? DEADLINE_GRACE_MS)); });
    const done = withLearningAttempt(attempt, () => deps.learn({ workspaceId: message.orgId, taskId: message.taskId, outcome: message.outcome }));
    // The loser of the race keeps running without anyone waiting for it; its own failure must not become an unhandled rejection.
    done.catch(() => undefined);
    const first = await Promise.race([done, timedOut]);
    if (first === "timed_out") {
      // The last guard: the work did not stop by itself. A fault, not a normal end (the lesson store refuses its writes once the signal is aborted).
      deps.log("lessons_worker.deadline", { taskId: message.taskId });
      outcome = { status: "not_reflected", retry: true };
      result = "timed_out";
    } else {
      outcome = first;
      result = first.status;
    }
  } catch {
    deps.log("lessons_worker.failed", { taskId: message.taskId });
    outcome = { status: "not_reflected", retry: true };
    result = "failed";
  } finally {
    if (abortTimer !== undefined) clearTimeout(abortTimer);
    if (raceTimer !== undefined) clearTimeout(raceTimer);
    // Whatever is still running past this point finds the signal aborted.
    controller.abort();
  }
  try {
    await deps.claims.finish(lease, outcome.retry ? "retry" : "done", deps.now());
  } catch {
    // The lease stays `running`; once it lapses the next take decides by the model keys (nothing spent: tried again; spent: never).
    deps.log("lessons_worker.finish_failed", { taskId: message.taskId });
  }
  deps.log("lessons_worker.result", { class: outcome.retry ? "retry" : result === "timed_out" || result === "failed" ? result : outcome.status, taskId: message.taskId, attempt: lease.attempt });
  return { result, retry: outcome.retry };
}

export interface QueueBatch { Records: Array<{ messageId: string; body: string; receiptHandle?: string; attributes?: { ApproximateReceiveCount?: string } }> }

/** The wait before a message that must come back is visible again, by how many times it has been received. */
export const retryDelaySeconds = (receiveCount: number): number => LESSONS_REFLECT_RETRY_BACKOFF_SECONDS[Math.min(Math.max(receiveCount, 1), LESSONS_REFLECT_RETRY_BACKOFF_SECONDS.length) - 1]!;

/** The partial-batch answer SQS reads: a message comes back when it must be tried again, when it waits for the ledger, or when its lease could not be taken. */
export async function handleReflectBatch(deps: ReflectWorkerDeps, event: QueueBatch, context?: WorkerContext): Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }> {
  const batchItemFailures: Array<{ itemIdentifier: string }> = [];
  for (const record of event.Records) {
    let comeBack: boolean;
    try {
      comeBack = (await runReflectMessage(deps, record.body, context)).retry;
    } catch {
      deps.log("lessons_worker.claim_failed", {});
      deps.log("lessons_worker.result", { class: "claim_failed" });
      comeBack = true;
    }
    if (!comeBack) continue;
    batchItemFailures.push({ itemIdentifier: record.messageId });
    if (deps.visibility !== undefined && record.receiptHandle !== undefined) {
      try { await deps.visibility.delay(record.receiptHandle, retryDelaySeconds(Number(record.attributes?.ApproximateReceiveCount ?? "1") || 1)); } catch { deps.log("lessons_worker.backoff_failed", {}); }
    }
  }
  return { batchItemFailures };
}
