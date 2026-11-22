import type { ReactNode } from "react";
import { VisibleText } from "../../design/VisibleText.js";
import type { MergeTone } from "./merge-facts.js";
import { useTaskPagePolicy } from "./task-page-policy.js";
import "./merge-section.css";

const TONE_ICON: Record<MergeTone, string> = { ok: "M2.5 6.5l2.5 2.5 4.5-5", wait: "M6 3v3.5M6 8.6v.1", bad: "M3.5 3.5l5 5M8.5 3.5l-5 5", idle: "M3.5 6h5", run: "M6 2.5v3.5l2 1.5" };

/** A status chip: a hue, an icon and a word, never a hue alone (DIRECTION: status vocabulary). */
export function MergeChip({ tone, children }: { tone: MergeTone; children: ReactNode }) {
 return <span className="rv-merge-chip" data-tone={tone}><svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d={TONE_ICON[tone]} /></svg>{children}</span>;
}

/** A clock time from a server instant, with the whole instant on hover. An instant that does not read says so. */
export function Clock({ at }: { at: string }) {
 const taskPage = useTaskPagePolicy() !== undefined, time = Date.parse(at);
 if (!Number.isFinite(time)) return <span>time unavailable</span>;
 return <time dateTime={at} title={new Date(time).toISOString()}>{new Date(time).toLocaleTimeString([], taskPage ? { hour: "2-digit", minute: "2-digit", hour12: false } : { hour: "2-digit", minute: "2-digit" })}</time>;
}

/** Label and value pairs, as the boards' "What would be merged" block. */
export function Facts({ rows }: { rows: ReadonlyArray<{ label: string; value: ReactNode; tone?: MergeTone }> }) {
 return <dl className="rv-merge-facts">{rows.map(row => <div key={row.label}><dt>{row.label}</dt><dd data-tone={row.tone}>{row.value}</dd></div>)}</dl>;
}

export const Sha = ({ value }: { value: string }) => <code className="rv-merge-sha">{value.slice(0, 7)}</code>;

/** The board's three-part error pattern: what happened, what is safe, what to do. */
export function ThreeParts({ happened, safe, next }: { happened: ReactNode; safe: ReactNode; next: ReactNode }) {
 return <dl className="rv-merge-three"><div><dt>What happened</dt><dd>{happened}</dd></div><div><dt>What is safe</dt><dd>{safe}</dd></div><div><dt>What to do</dt><dd>{next}</dd></div></dl>;
}

export const Plain = ({ text }: { text: string }) => <VisibleText text={text} />;
