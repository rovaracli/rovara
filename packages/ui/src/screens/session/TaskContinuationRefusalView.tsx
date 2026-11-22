import { VisibleText } from "../../design/VisibleText.js";

export type TaskContinuationRefusalReason = "closed" | "released" | "approval";

export interface TaskContinuationRefusalViewProps {
  reason: TaskContinuationRefusalReason;
  taskTitle?: string | undefined;
  /** Supplied by the authorized task surface; this view does not construct a destination. */
  startHref?: string | undefined;
  /** Supplied by the authorized decision surface; this view does not construct a destination. */
  decisionHref?: string | undefined;
}

const COPY: Record<TaskContinuationRefusalReason, string> = {
  closed: "This task is closed and cannot accept another round. Its recorded work is kept.",
  released: "This task never started and no longer holds a workspace slot. Its request is kept.",
  approval: "Approve the plan first. This task is waiting for an approval decision. No new round was started.",
};

/** A presentation-only rendering of a definitive continuation refusal from the owning API surface. */
export function TaskContinuationRefusalView({ reason, taskTitle, startHref, decisionHref }: TaskContinuationRefusalViewProps) {
  const action = reason === "approval"
    ? decisionHref === undefined ? undefined : { href: decisionHref, label: "Open the current decision." }
    : startHref === undefined ? undefined : { href: startHref, label: "Start a new task." };

  return <section className="rv-task-actions" aria-label="Task continuation refusal">
    {taskTitle !== undefined && <p>Task: <strong><VisibleText text={taskTitle} /></strong></p>}
    <p>{COPY[reason]}</p>
    {action !== undefined && <p><a href={action.href}><VisibleText text={action.label} /></a></p>}
  </section>;
}
