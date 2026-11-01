// Learning v2: the lessons a stage carries (`invocation.payload.learnedContext`) are advice for ONE delivery. The stored outbox copy must not keep their text longer than that: a stage
// that waits (parked for task access or for its session) or that ends FAILED has no time limit, and nobody sweeps it when a lesson's author is erased, a lesson is retired or a reader loses
// access. So a copy drops them when it is delivered (dispatcher.ts markDeliveredCommand), parked, or failed, and a released stage runs without lessons (as for a worker that lists no support).
// Every kind of invocation has a `payload` map, so removing the one attribute is valid on any stored item; it is a no-op when the item carries none.
import type { DurableOutboxRecord } from "./lambda.js";

/** The REMOVE clause (to append to an UpdateExpression of an outbox item that exists) that drops the stored lessons. */
export const REMOVE_STORED_LESSONS = "REMOVE invocation.payload.learnedContext";

/** Whether a record still carries lessons (so an update that may create the item can leave the clause out when there is nothing to drop). */
export function storedLessonsOf(record: DurableOutboxRecord): boolean {
  // A stored record read back may be partial (an older or failed item without its invocation): it then carries no lessons.
  const invocation = (record as { invocation?: DurableOutboxRecord["invocation"] }).invocation;
  return invocation?.kind === "task" && (invocation.payload as { learnedContext?: unknown } | undefined)?.learnedContext !== undefined;
}
