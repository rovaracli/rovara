import { TaskTimeline } from "../../design/TaskTimeline.js";
import { TaskHeldStatesView } from "./TaskHeldStatesView.js";
import { HeldState } from "../../design/HeldState.js";

export interface ProgressStage {
 id: string;
 label: string;
 state: "done" | "current" | "blocked" | "upcoming";
 durationMs?: number | undefined;
}

export interface TaskRunningProgressViewProps {
 stages: readonly ProgressStage[];
 currentStepId?: string | undefined;
 lastKnownStepId?: string | undefined;
 activity: "observed" | "unknown";
 pageProjection?: "current" | "stale" | undefined;
 onCheck?: (() => void) | undefined;
}

function durationWords(durationMs: number): string {
 const totalSeconds = Math.max(0, Math.round(durationMs / 1_000));
 const hours = Math.floor(totalSeconds / 3_600), minutes = Math.floor((totalSeconds % 3_600) / 60), seconds = totalSeconds % 60;
 if (hours > 0) return `${hours}h ${minutes}m`;
 if (minutes > 0) return `${minutes}m ${seconds}s`;
 return `${seconds}s`;
}

/** Read-only progress drawn from the task session's supplied stages and observations. */
export function TaskRunningProgressView({ stages, currentStepId, lastKnownStepId, activity, pageProjection, onCheck }: TaskRunningProgressViewProps) {
 const observedStepId = activity === "observed" ? currentStepId : lastKnownStepId;
 return <aside className="rv-task-context" aria-label="Where this task is">
  <h2>Where this task is</h2>
  {pageProjection === "stale" && <p role="status" className="rv-muted">This page is old; the build may be fine.</p>}
  {activity === "unknown" && <div className="rv-task-activity-unknown">{onCheck === undefined ? <HeldState /> : <TaskHeldStatesView page="running" onCheck={onCheck} />}<span className="rv-visually-hidden">Rovara hasn't confirmed the build's latest activity.</span></div>}
  <TaskTimeline items={stages.map(stage => ({
   id: stage.id, title: stage.label,
   state: stage.state === "done" ? "done" : stage.state === "current" && observedStepId === stage.id ? "running" : stage.state === "blocked" ? "needs_you" : "next",
   ...(observedStepId === stage.id ? { detail: activity === "observed" ? "Current step" : "Last known step" } : stage.state === "done" ? { detail: "Finished" } : {}),
   ...(stage.durationMs === undefined ? {} : { elapsed: durationWords(stage.durationMs) }),
  }))} />
 </aside>;
}
