import { VisibleText, visibleText } from "./VisibleText.js";
export function StatusDot({ status, words }: { status: string; words: string }) { const known = ["running", "needs_person", "waiting", "failed", "succeeded", "stopped", "paused", "cancelled", "starting"].includes(status) ? status : "unknown";return <span role="img" aria-label={visibleText(words)} className="rv-status"><span aria-hidden="true" data-status={known} className="rv-status-dot" /><VisibleText text={words} /></span>; }
export type StatusTone = "wait" | "run" | "ok" | "bad" | "idle";
const TONE_WORDS: Record<StatusTone, string> = { wait: "Needs you", run: "Running", ok: "Done", bad: "Failed", idle: "Waiting" };
/** A task's tone as a small dot. The words are for a screen reader; the list row says the same in text. */
export function ToneDot({ tone, words }: { tone: StatusTone; words?: string }) { return <span className="rv-tone-dot" data-tone={tone} role="img" aria-label={words ?? TONE_WORDS[tone]} />; }
/** A tone as a pill with words (the proof table's result, the task's state). */
export function StatusPill({ tone, label }: { tone: StatusTone; label: string }) { return <span className="rv-status-pill" data-tone={tone}>{label}</span>; }
