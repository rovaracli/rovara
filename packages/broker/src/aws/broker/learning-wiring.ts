// Part of the broker (split out of ../broker.ts): the learning lane's hook on the end of a task. Registered once per process, like the chain runner's; it reads the dependencies of the latest broker built.
//
// Lessons in production, lane 2 (WB-4): the hook never runs the reflector. It is registered where the broker has the learning dependencies (`dependencies.learning`, built by `installLessons` only with the Team
// record and a model path) AND a queue to send to (`dependencies.lessonsReflectQueue`), and a task's end then costs one message of ids. The LessonsWorker Lambda (`lessons-worker.ts`) does the reflecting.
// L6 (lane 1 review): there is exactly ONE human send-back listener, the Team record's (`team-record-wiring.ts#installTeamRecordEmitter`); this file registers none.
import { registerLearningTaskEnd, type TaskEndEnqueue, type TaskLearningDeps } from "../../lessons/task-end.js";
import type { ReflectQueue } from "../../lessons/reflect-queue.js";

let current: TaskEndEnqueue | undefined;
let currentDeps: TaskLearningDeps | undefined;
let removeHandler: (() => void) | undefined;

/** The dependencies the latest broker was built with (for the code that runs a reflection in this process: the worker, tests). */
export const learningDepsInUse = (): TaskLearningDeps | undefined => currentDeps;

/** At broker start (`broker/handler.ts`, after `installLessons`, which builds `dependencies.learning`). */
export function installLearningTaskEnd(dependencies: { learning?: TaskLearningDeps | undefined; lessonsReflectQueue?: ReflectQueue | undefined }): void {
  currentDeps = dependencies.learning;
  current = dependencies.learning === undefined || dependencies.lessonsReflectQueue === undefined ? undefined : { queue: dependencies.lessonsReflectQueue };
  if (current === undefined) return;
  removeHandler ??= registerLearningTaskEnd(() => current);
}

/** Takes the hook off again (for the tests that install it; a deployed broker never does). */
export function uninstallLearningTaskEnd(): void {
  removeHandler?.();
  removeHandler = undefined;
  current = undefined;
  currentDeps = undefined;
}
