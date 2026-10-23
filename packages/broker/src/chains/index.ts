// Plan 4 Tasks 6 and 8: what the chain runner registers at broker start. A chain step is an ordinary task of Plan 3's, so the runner hears that it ended (or was paused for
// money) the way everything else does: through the handlers of Plan 3's single end site. Both ignore a task with no chain, and do nothing while the broker has no
// runner dependencies (a deployment without agents or chains). Task 8 registers the gate's approval rule and handler and the autonomous write approvers beside them.
import { registerTaskEndHandler, registerTaskPauseHandler, registerTaskResumeHandler, type TaskEndDependencies } from "../agents/task-end.js";
import { registerChainGates } from "./gates.js";
// What chains do when a member leaves or is merged registers itself when this loads (Plan 4 Task 18).
import "./members.js";
import { onStepTaskEnded, onStepTaskPaused, onStepTaskResumed, type ChainRunnerDependencies } from "./runner.js";
import { registerChainWriteApprovers } from "./write-approvers.js";

/** What the runner is given to work with when a task ends or pauses, or a gate is decided: the dependencies of the broker that serves the chain runs, if there are any. */
export type ChainRunnerProvider = (deps: Pick<TaskEndDependencies, "documentClient" | "tableName" | "now">) => ChainRunnerDependencies | undefined;

/**
 * Registers what the chain runner needs at broker start: the end, pause and resume handlers (H5); the gate's approver rule, its words and its subject's handler; and
 * the autonomous write approver rule with the selector that names it (H4). Returns the function that removes the handlers, the provider and the selector.
 */
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
  const removeGates = registerChainGates(provider);
  const removeWriters = registerChainWriteApprovers();
  return () => {
    removeEnd();
    removePause();
    removeResume();
    removeGates();
    removeWriters();
  };
}
