import { StatusChip, type StatusChipState } from "./StatusChip.js";
import { VisibleText, visibleText } from "./VisibleText.js";
// Only exact task words opt into the canonical chip; counts, PR metadata and aggregates keep their meaning.
const CANONICAL: readonly (readonly [string, string, Exclude<StatusChipState, "waiting_for">])[] = [
 ["running", "Running", "running"], ["starting", "Setting up", "setting_up"],
 ["needs_person", "Needs you", "needs_you"], ["failed", "Failed", "failed"],
 ["succeeded", "Done", "done"], ["stopped", "Stopped", "stopped"],
];
export function StatusDot({ status, words }: { status: string; words: string }) {
 const match = CANONICAL.find(([legacy, label]) => status === legacy && words === label);
 if (match !== undefined) return <StatusChip state={match[2]} />; const known = ["running", "needs_person", "waiting", "failed", "succeeded", "stopped", "paused", "cancelled", "starting"].includes(status) ? status : "unknown";return <span role="img" aria-label={visibleText(words)} className="rv-status"><span aria-hidden="true" data-status={known} className="rv-status-dot" /><VisibleText text={words} /></span>; }
export type StatusTone = "wait" | "run" | "ok" | "bad" | "idle";
const TONE_WORDS: Record<StatusTone, string> = { wait: "Needs you", run: "Running", ok: "Done", bad: "Failed", idle: "Waiting" };
/** A task's tone as a small dot. The words are for a screen reader; the list row says the same in text. */
export function ToneDot({ tone, words }: { tone: StatusTone; words?: string }) { return <span className="rv-tone-dot" data-tone={tone} role="img" aria-label={words ?? TONE_WORDS[tone]} />; }
/** A tone as a pill with words (the proof table's result, the task's state). */
export function StatusPill({ tone, label }: { tone: StatusTone; label: string }) { return <span className="rv-status-pill" data-tone={tone}>{label}</span>; }
