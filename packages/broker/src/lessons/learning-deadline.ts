// Lessons in production, lane 2: the time one reflection may take. The worker runs a reflection inside `withLearningDeadline`; the model path (`aws/broker/learning-model.ts`) asks `learningCallMayStart`
// before it mints a key, and a call that could still be running at the deadline is refused (nothing is reserved, nothing is charged). Outside the worker (the broker, tests) there is no deadline.
import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage<{ deadlineAt: number }>();

/** Runs `work` with a deadline (epoch milliseconds). */
export const withLearningDeadline = <T>(deadlineAt: number, work: () => Promise<T>): Promise<T> => storage.run({ deadlineAt }, work);

/** Whether a model call that may take `waitMs` can start now and be over by the deadline. True where there is no deadline. */
export function learningCallMayStart(now: number, waitMs: number): boolean {
  const deadline = storage.getStore()?.deadlineAt;
  return deadline === undefined || now + waitMs <= deadline;
}
