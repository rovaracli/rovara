// Learning v2 (WL-6): the stored and queued form of a stage's lessons is `invocation.payload.learnedRefs`: lesson IDS and VERSIONS only, never text (the dispatcher builds the text from the lesson store at
// delivery, `lessons/deliver.ts`). So no outbox row, queue message or dead-letter copy holds lesson text. `learnedContext` (the text) can only be on a row queued by a build from before that change; it is
// dropped on the same events as the refs. What follows is the older rule, kept for those rows and for tidiness: the lessons a stage carries are advice for ONE delivery. The stored outbox copy must not keep them longer than that: a stage
// that waits (parked for task access or for its session) or that ends FAILED has no time limit, and nobody sweeps it when a lesson's author is erased, a lesson is retired or a reader loses
// access. So a copy drops them when it is delivered (dispatcher.ts markDeliveredCommand), parked, or failed, and a released stage runs without lessons (as for a worker that lists no support).
// Every kind of invocation has a `payload` map, so removing the one attribute is valid on any stored item; it is a no-op when the item carries none.
import type { DurableOutboxRecord } from "./lambda.js";

/** The REMOVE clause (to append to an UpdateExpression of an outbox item that exists) that drops the stored lessons. */
export const REMOVE_STORED_LESSONS = "REMOVE invocation.payload.learnedContext, invocation.payload.learnedRefs";

/** Whether a record still carries lessons (so an update that may create the item can leave the clause out when there is nothing to drop). */
export function storedLessonsOf(record: DurableOutboxRecord): boolean {
  // A stored record read back may be partial (an older or failed item without its invocation): it then carries no lessons.
  const invocation = (record as { invocation?: DurableOutboxRecord["invocation"] }).invocation;
  const payload = invocation?.kind === "task" ? (invocation.payload as { learnedContext?: unknown; learnedRefs?: unknown } | undefined) : undefined;
  return payload?.learnedContext !== undefined || payload?.learnedRefs !== undefined;
}
