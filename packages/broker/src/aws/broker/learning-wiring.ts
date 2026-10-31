// Part of the broker (split out of ../broker.ts): the learning lane's hook on the end of a task. Registered once per process, like the chain runner's; it reads the dependencies of
// the latest broker built and does nothing where the broker was given no `learning` dependencies (the pilot default: suggestions off, nothing wired).
import { registerHumanSendBackListener, sendBackToRecord } from "../../lessons/send-back-events.js";
import { registerLearningTaskEnd, type TaskLearningDeps } from "../../lessons/task-end.js";

let current: TaskLearningDeps | undefined;
let removeHandler: (() => void) | undefined;
let removeSendBack: (() => void) | undefined;

/** At broker start (`broker/handler.ts`). */
export function installLearningTaskEnd(dependencies: { learning?: TaskLearningDeps | undefined }): void {
  current = dependencies.learning;
  if (current === undefined) return;
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
