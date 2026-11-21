import type { CSSProperties } from "react";
import { LOOK_COLORS } from "@agentx/design-tokens";
import { Button } from "../Button.js";
import { StatusChip, type StatusChipProps } from "../StatusChip.js";

const examples: readonly (readonly [StatusChipProps, string])[] = [
 [{ state: "queued" }, "Accepted. Starts when a runner is free."],
 [{ state: "setting_up" }, "Preparing the workspace. No code changed yet."],
 [{ state: "needs_you" }, "Waiting for your decision or answer."],
 [{ state: "waiting_for", waitingFor: "Ana" }, "Someone else has to act. Quiet grey: amber is only for work you can resolve."],
 [{ state: "running" }, "Working. Nothing needed from you."],
 [{ state: "checking" }, "Running checks and reviews on the change."],
 [{ state: "ready_to_merge" }, "Every required check and review is in for this version."],
 [{ state: "done" }, "Finished without a merge: an answer, or no change needed."],
 [{ state: "merged" }, "The change is in the base branch. Deploying is separate."],
 [{ state: "stopped" }, "Stopped by a person. Files are kept."],
 [{ state: "failed" }, "The task's own work failed, for example a test."],
 [{ state: "blocked" }, "Can't continue until something changes, such as a limit."],
 [{ state: "could_not_run" }, "A check or step never ran. Not a pass and not a fail."],
 [{ state: "not_run" }, "A required review that hasn't happened. Says who can run it."],
 [{ state: "unknown" }, "Rovara can't confirm the state yet. It is checking."],
];
const darkRoles = Object.fromEntries(Object.entries(LOOK_COLORS.dark).map(([key, value]) => [`--rv-${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`, value])) as CSSProperties;

/** P5 mounts these presentation-only scenes; no company data or actions. */
export const chipsButtonsGalleryScenes = [
 { id: "statuses", title: "Status chips: the only vocabulary", render: () => <>
  <h2>Status chips: the only vocabulary</h2>
  <p className="rv-ds-chip-intro">Fifteen states. One hue, one icon and one sentence each. Screens do not invent their own words.</p>
  <div className="rv-ds-panel"><dl className="rv-ds-chip-list">{examples.map(([props, description]) => <div className="rv-ds-chip-row" key={props.state}><dt><StatusChip {...props} /></dt><dd>{description}</dd></div>)}</dl></div>
  <div className="rv-ds-panel" style={{ ...darkRoles, colorScheme: "dark" }}><h3>The same parts in dark</h3><p className="rv-ds-meta">Only the role values change. Names, sizes and layout stay.</p><div className="rv-ds-chip-strip">{examples.map(([props]) => <StatusChip key={props.state} {...props} />)}</div></div>
 </> },
 { id: "buttons", title: "Buttons", render: () => <div className="rv-ds-panel">
  <h2>Buttons</h2>
  <div className="rv-ds-button-examples"><Button variant="primary">Review evidence</Button><Button>Request changes</Button><Button variant="quiet">Other choices</Button><Button variant="danger">Remove Sam</Button></div>
  <div className="rv-ds-button-lock-example"><Button lockedReason="a required check couldn't run.">Merge #42</Button></div>
  <p className="rv-ds-meta">Primary: one per view. Secondary: at most two beside it. Quiet: everything else. Danger: repeats the verb and the object. A locked button always shows its reason next to it.</p>
 </div> },
] as const;
