import { useId, useState, type ReactNode } from "react";
import { VisibleText, visibleText } from "./VisibleText.js";
import "./parts/chips-buttons.css";

export type StatusChipState = "queued" | "setting_up" | "needs_you" | "waiting_for" | "running" | "checking" | "ready_to_merge" | "done" | "merged" | "stopped" | "failed" | "blocked" | "could_not_run" | "not_run" | "unknown";
export type StatusChipProps = { state: Exclude<StatusChipState, "waiting_for"> } | { state: "waiting_for"; waitingFor: string };
const COPY = {
 queued: { label: "Queued", hue: "idle", icon: "clock", description: "Accepted. Starts when a runner is free." },
 setting_up: { label: "Setting up", hue: "running", icon: "setup", description: "Preparing the workspace. No code changed yet." },
 needs_you: { label: "Needs you", hue: "attention", icon: "alert", description: "Waiting for your decision or answer." },
 waiting_for: { label: "Waiting for", hue: "idle", icon: "person", description: "Someone else has to act. Quiet grey: amber is only for work you can resolve." },
 running: { label: "Running", hue: "running", icon: "activity", description: "Working. Nothing needed from you." },
 checking: { label: "Checking", hue: "running", icon: "search", description: "Running checks and reviews on the change." },
 ready_to_merge: { label: "Ready to merge", hue: "ok", icon: "tick", description: "Every required check and review is in for this version." },
 done: { label: "Done", hue: "ok", icon: "circle-tick", description: "Finished without a merge: an answer, or no change needed." },
 merged: { label: "Merged", hue: "ok", icon: "merge", description: "The change is in the base branch. Deploying is separate." },
 stopped: { label: "Stopped", hue: "idle", icon: "stop", description: "Stopped by a person. Files are kept." },
 failed: { label: "Failed", hue: "bad", icon: "cross", description: "The task's own work failed, for example a test." },
 blocked: { label: "Blocked", hue: "bad", icon: "prohibited", description: "Can't continue until something changes, such as a limit." },
 could_not_run: { label: "Could not run", hue: "idle", icon: "dash", description: "A check or step never ran. Not a pass and not a fail." },
 not_run: { label: "Not run", hue: "idle", icon: "dash", description: "A required review that hasn't happened. Says who can run it." },
 unknown: { label: "Unknown", hue: "idle", icon: "question", description: "Rovara can't confirm the state yet. It is checking." },
} as const;
const ICONS: Record<(typeof COPY)[StatusChipState]["icon"], ReactNode> = {
 clock: <><circle cx="8" cy="8" r="6" /><path d="M8 4v4l2.5 1.5" /></>,
 setup: <path d="M8 1v3m0 8v3M1 8h3m8 0h3" />,
 alert: <><circle cx="8" cy="8" r="6" /><path d="M8 4.5v4M8 11v.2" /></>,
 person: <><circle cx="8" cy="5" r="2.5" /><path d="M3 14c0-5 10-5 10 0" /></>,
 activity: <path d="M8 2a6 6 0 1 1-6 6" />,
 search: <><circle cx="6.5" cy="6.5" r="4.5" /><path d="m10 10 4 4" /></>,
 tick: <path d="m3 8 3 3 7-7" />,
 "circle-tick": <><circle cx="8" cy="8" r="6" /><path d="m4.5 8 2.5 2.5 4.5-5" /></>,
 merge: <><circle cx="4" cy="3" r="1.5" /><circle cx="4" cy="13" r="1.5" /><circle cx="12" cy="8" r="1.5" /><path d="M4 4.5v7M4 5c0 3 3 3 6.5 3" /></>,
 stop: <rect x="4" y="4" width="8" height="8" rx="1" />,
 cross: <path d="m4 4 8 8m0-8-8 8" />,
 prohibited: <><circle cx="8" cy="8" r="6" /><path d="m4 12 8-8" /></>,
 dash: <path d="M5 8h6" />,
 question: <><circle cx="8" cy="8" r="6" /><path d="M6 6a2 2 0 1 1 3 1.7C8 8.2 8 8.5 8 9M8 11v.2" /></>,
};

/** Presentation only: unknown inputs never imply a successful or ready state. */
export function StatusChip(props: StatusChipProps) {
 const id = useId();
 const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false), [dismissed, setDismissed] = useState(false);
 const state = Object.hasOwn(COPY, props.state) && (props.state !== "waiting_for" || (typeof props.waitingFor === "string" && props.waitingFor.trim().length > 0)) ? props.state : "unknown";
 const copy = COPY[state];
 const label = state === "waiting_for" && props.state === "waiting_for" ? `${copy.label} ${visibleText(props.waitingFor)}` : copy.label;
 return <span className="rv-status-chip-wrap" onMouseEnter={() => { setHovered(true); setDismissed(false); }} onMouseLeave={() => setHovered(false)}>
  <span className="rv-status-chip" role="img" tabIndex={0} aria-label={label} aria-describedby={id} data-state={state} data-hue={copy.hue}
   onFocus={() => { setFocused(true); setDismissed(false); }} onBlur={() => setFocused(false)} onKeyDown={event => { if (event.key === "Escape") setDismissed(true); }}>
   <svg className="rv-status-chip-icon" data-icon={copy.icon} aria-hidden="true" focusable="false" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{ICONS[copy.icon]}</svg>
   <VisibleText text={label} />
  </span>
  <span id={id} role="tooltip" className="rv-status-chip-description" hidden={dismissed || (!hovered && !focused)}>{copy.description}</span>
 </span>;
}
