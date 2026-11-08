// Part of the broker (split out of ../broker.ts): the learning lane's hook on the end of a task. Registered once per process, like the chain runner's; it reads the dependencies of
// the latest broker built and does nothing where the broker was given no `learning` dependencies (the pilot default: suggestions off, nothing wired).
import { registerHumanSendBackListener, sendBackToRecord } from "../../lessons/send-back-events.js";
import { registerLearningTaskEnd, type TaskLearningDeps } from "../../lessons/task-end.js";

/**
 * Lessons in production, lane 1: the inline task-end handler (`learningTaskEndHandler`) calls the model WHILE the task ends (register WB-4). Production wiring therefore does NOT register it: this stays false
 * until the reflection runs from a queue (lane 2 replaces the inline call with an enqueue and flips the registration to that). The dependencies are still built and kept (`learningDepsInUse`) for it.
 * A test that wants the inline handler passes `{ inline: true }` explicitly.
 */
export const INLINE_LEARNING_TASK_END_ENABLED = false;

let current: TaskLearningDeps | undefined;
let removeHandler: (() => void) | undefined;
let removeSendBack: (() => void) | undefined;

/** The dependencies the latest broker was built with, for the queue worker that replaces the inline handler. */
export const learningDepsInUse = (): TaskLearningDeps | undefined => current;

/** At broker start (`broker/handler.ts`, after `installLessons`, which builds `dependencies.learning`). */
export function installLearningTaskEnd(dependencies: { learning?: TaskLearningDeps | undefined }, options: { inline?: boolean } = {}): void {
  current = dependencies.learning;
  if (current === undefined) return;
  // The inline handler and the send-back listener below belong together (they use the same dependencies); neither is registered while the inline path is off. The Team record's own wiring
  // (`installTeamRecordEmitter`) records every human send-back to the record by itself, so nothing is lost by this.
  if (options.inline !== true && !INLINE_LEARNING_TASK_END_ENABLED) return;
  removeHandler ??= registerLearningTaskEnd(() => current);
  // A human send-back is written to the record with the person who sent it; the listener reads the latest broker's emitter, and does nothing where there is none.
  removeSendBack ??= registerHumanSendBackListener(async (event) => { const emitter = current?.rovara; if (emitter !== undefined) await sendBackToRecord(emitter)(event); });
}

/** Takes the hook off again (for the tests that install it; a deployed broker never does). */
export function uninstallLearningTaskEnd(): void {
  removeHandler?.();
  removeHandler = undefined;
  removeSendBack?.();
  removeSendBack = undefined;
  current = undefined;
}
