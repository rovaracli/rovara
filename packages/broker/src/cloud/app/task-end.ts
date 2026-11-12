// Convergence S0 WIRING: the end of a core task reaches Cloud's end handlers (triggers, chains, agents, lessons) on close AND on merge.
//
// The core tells its `taskEnded` seam when a task is CLOSED (vendor core/task-flow/close.ts finishClose) and not when a merge completes it. Cloud's end bookkeeping
// (agents/task-end.ts onTaskEnded) records the end once and tells every handler once, whichever call comes first, and a task whose pull request merged is over for
// them as much as one that was closed. What is needed upstream: Code calls its seam when the merge completes the task (core/merge/merged.ts, the commit that
// moves the task to MERGED). Until then the root closes the gap on its side: the core writes a `merged` milestone in that very commit, and the root registers a
// milestone handler that records the end as `merged`. The later close finds the end already recorded (`already_ended`) and changes nothing.
import type { CodeMilestoneHandler } from "@rovara-code/broker/core/milestones";
import { coreTaskEndedHandler, type CoreTaskEndedDeps, type CoreTaskEndedEvent } from "../rows/core-rows.js";

export interface CoreTaskEndWiring {
  /** Pass as the flow's `taskEnded` option: the end by a close. */
  onClose: (event: CoreTaskEndedEvent) => Promise<void>;
  /** Register with the core's milestones (`milestones.register`): the end by a merge. */
  onMerged: CodeMilestoneHandler;
}

export function coreTaskEndWiring(deps: CoreTaskEndedDeps): CoreTaskEndWiring {
  const close = coreTaskEndedHandler(deps, "closed");
  const merged = coreTaskEndedHandler(deps, "merged");
  return {
    onClose: close,
    onMerged: { name: "cloud_task_end", async on(milestone) { if (milestone.kind === "merged") await merged({ orgId: milestone.orgId, taskId: milestone.taskId }); } },
  };
}
