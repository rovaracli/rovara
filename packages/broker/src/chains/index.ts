// Plan 4 Task 6: what the chain runner registers at broker start. A chain step is an ordinary task of Plan 3's, so the runner hears that it ended (or was paused for
// money) the way everything else does: through the handlers of Plan 3's single end site. Both ignore a task with no chain, and do nothing while the broker has no
// runner dependencies (a deployment without agents or chains). Later tasks register their approval rules and selectors beside these.
import { registerTaskEndHandler, registerTaskPauseHandler, registerTaskResumeHandler, type TaskEndDependencies } from "../agents/task-end.js";
import { onStepTaskEnded, onStepTaskPaused, onStepTaskResumed, type ChainRunnerDependencies } from "./runner.js";

/** What the runner is given to work with when a task ends or pauses: the dependencies of the broker that serves the chain runs, if there are any. */
export type ChainRunnerProvider = (taskDeps: TaskEndDependencies) => ChainRunnerDependencies | undefined;

/** Registers the end, pause and resume handlers (H5). Returns the function that removes both. */
export function registerChainRunner(provider: ChainRunnerProvider): () => void {
  const removeEnd = registerTaskEndHandler(async (taskDeps, event) => {
    if (event.chain === undefined) return;
    const deps = provider(taskDeps);
    if (deps !== undefined) await onStepTaskEnded(deps, event);
  });
  const removePause = registerTaskPauseHandler(async (taskDeps, event) => {
    if (event.chain === undefined) return;
    const deps = provider(taskDeps);
    if (deps !== undefined) await onStepTaskPaused(deps, event);
  });
  const removeResume = registerTaskResumeHandler(async (taskDeps, event) => {
    if (event.chain === undefined) return;
    const deps = provider(taskDeps);
    if (deps !== undefined) await onStepTaskResumed(deps, event);
  });
  return () => {
    removeEnd();
    removePause();
    removeResume();
  };
}
