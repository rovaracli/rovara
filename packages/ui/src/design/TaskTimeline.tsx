import type { ReactNode } from "react";
import { VisibleText } from "./VisibleText.js";
import "./parts/decision-timeline.css";

export interface TaskTimelineItem {
 id: string;
 title: string;
 detail?: string;
 state: "done" | "running" | "next";
 elapsed?: string;
 log?: ReactNode;
}
export interface TaskTimelineProps { items: readonly TaskTimelineItem[] }
const STATE_WORDS = { done: "Done", running: "Running", next: "Next" } as const;

/** Confirmed steps only. Durations and log content belong to the caller; neither is inferred from step order. */
export function TaskTimeline({ items }: TaskTimelineProps) {
 return <ol className="rv-task-timeline" aria-label="Where this task is">{items.map(item => <li key={item.id} data-state={item.state} aria-current={item.state === "running" ? "step" : undefined}>
  <span className="rv-task-timeline-marker" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" focusable="false" aria-hidden="true">{item.state === "done" ? <path d="m6 12 4 4 8-9" /> : item.state === "running" ? <path d="M12 4a8 8 0 1 1-8 8" /> : <circle cx="12" cy="12" r="10" />}</svg></span>
  <div className="rv-task-timeline-content"><div className="rv-task-timeline-heading"><span className="rv-task-timeline-title"><VisibleText text={item.title} /></span><span className="rv-visually-hidden">{STATE_WORDS[item.state]}</span>{item.elapsed !== undefined && <span className="rv-task-timeline-elapsed"><VisibleText text={item.elapsed} /></span>}{item.state === "next" && item.elapsed === undefined && <span className="rv-task-timeline-next" aria-hidden="true">next</span>}</div>
   {item.detail !== undefined && <p className="rv-task-timeline-detail"><VisibleText text={item.detail} /></p>}
   {item.state === "running" && item.log != null && <details className="rv-task-timeline-log"><summary>Live log</summary><div>{item.log}</div></details>}
  </div>
 </li>)}</ol>;
}
