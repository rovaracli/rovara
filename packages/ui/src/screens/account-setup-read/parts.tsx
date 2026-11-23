import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Button } from "../../design/Button.js";
import { StatusChip } from "../../design/StatusChip.js";
import { VisibleText, visibleText } from "../../design/VisibleText.js";
import { viewerTime } from "../../design/viewer-time.js";
import "../../design/parts/chips-buttons.css";
import { READ_FAILED_SAFE, STALE_REFUSAL } from "./read-model.js";

/** A titled block of the page; the heading names the region. `note` is the small muted text at the right of the heading. */
export function Section({ title, children, label, note }: { title: string; children: ReactNode; label?: string; note?: ReactNode }) {
 const id = `g5-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
 return <section className="g5-section" aria-labelledby={label === undefined ? id : undefined} aria-label={label}><div className="g5-h"><h2 id={id}>{title}</h2>{note !== undefined && <span>{note}</span>}</div>{children}</section>;
}

/** 4e list rows: one bordered group, one row per fact. */
export function Rows({ label, children }: { label?: string; children: ReactNode }) {
 return <ul className="g5-rows" aria-label={label}>{children}</ul>;
}
export type RowTone = "ok" | "idle" | "none" | "ban" | "attention" | "running" | "failed";
const MARKS: Record<RowTone, ReactNode> = {
 ok: <path d="m3 8.5 3.2 3.2L13 4.5" />,
 idle: <circle cx="8" cy="8" r="5.5" />,
 none: <path d="M5 8h6" />,
 ban: <><circle cx="8" cy="8" r="6" /><path d="m4 12 8-8" /></>,
 attention: <><circle cx="8" cy="8" r="6" /><path d="M8 4.5v4M8 11v.2" /></>,
 running: <path d="M8 2a6 6 0 1 1-6 6" />,
 failed: <path d="m4 4 8 8m0-8-8 8" />,
};
export function Mark({ tone }: { tone: RowTone }) {
 return <svg className="g5-row-mark" data-tone={tone} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{MARKS[tone]}</svg>;
}
export function Chevron() {
 return <svg className="g5-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="m6 3 5 5-5 5" /></svg>;
}
type BodyProps = { title?: ReactNode; detail?: ReactNode; aside?: ReactNode; chip?: ReactNode; mark?: RowTone; lead?: ReactNode; go?: boolean; children?: ReactNode };
/** The inside of one row: optional leading mark or avatar, a title and detail on the left, one text aside and/or one chip on the right. */
export function RowBody({ title, detail, aside, chip, mark, lead, go, children }: BodyProps) {
 return <>
  {mark !== undefined && <span className="g5-row-lead"><Mark tone={mark} /></span>}
  {lead !== undefined && <span className="g5-row-lead" data-wide>{lead}</span>}
  <div className="g5-row-main">{title !== undefined && <h3>{title}</h3>}{detail !== undefined && <p className="g5-row-detail">{detail}</p>}{children}</div>
  {aside !== undefined && <div className="g5-row-aside">{aside}</div>}
  {chip !== undefined && <div className="g5-row-aside" data-chip>{chip}</div>}
  {go === true && <span className="g5-go"><Chevron /></span>}
 </>;
}
export function Row({ label, selected, ...body }: BodyProps & { label?: string; selected?: boolean }) {
 return <li className="g5-row" aria-label={label} {...(selected ? { "data-selected": "" } : {})}><RowBody {...body} /></li>;
}
/** A row that opens another page: the whole row is the link, with a chevron. */
export function LinkRow({ to, label, ...body }: BodyProps & { to: string; label?: string }) {
 return <li className="g5-row g5-row-link" aria-label={label}><Link to={to}><RowBody {...body} go /></Link></li>;
}
/** The inside of a row that opens another page: the whole row is the link, with a chevron. For a row that is itself a read (`rowLabel`). */
export function LinkBody({ to, ...body }: BodyProps & { to: string }) {
 return <Link className="g5-rowlink" to={to}><RowBody {...body} go /></Link>;
}
export function Foot({ children }: { children: ReactNode }) {
 return <p className="g5-foot">{children}</p>;
}

/** Label and value pairs in the 4e key-value form. */
export function Facts({ children }: { children: ReactNode }) {
 return <dl className="g5-facts">{children}</dl>;
}
export function Fact({ label, children }: { label: string; children: ReactNode }) {
 return <div><dt>{label}</dt><dd>{children}</dd></div>;
}

const PILL_ICONS = { ok: <path d="m3.5 8.5 3 3 6-7" />, idle: <rect x="4" y="4" width="8" height="8" rx="1.5" />, info: <path d="m3.5 8.5 3 3 6-7" />, bad: <path d="m4 4 8 8m0-8-8 8" />, running: <path d="M8 2a6 6 0 1 1-6 6" /> } as const;
/** The shared chip look for words the shared StatusChip does not own (Linked, Current, Active, Expired). */
export function Pill({ tone = "idle", state, children }: { tone?: "ok" | "idle" | "bad" | "info" | "running"; state?: string; children: ReactNode }) {
 const hue = tone === "info" || tone === "running" ? "running" : tone === "bad" ? "bad" : tone === "ok" ? "ok" : "neutral";
 return <span className="rv-status-chip-wrap g5-pill" data-state={state}><span className="rv-status-chip" data-hue={hue}><svg className="rv-status-chip-icon" aria-hidden="true" focusable="false" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{PILL_ICONS[tone]}</svg>{children}</span></span>;
}
/** The one Unknown chip a held fact shows in its frame (4e): nothing is guessed. */
export function Unknown() {
 return <StatusChip state="unknown" />;
}

/** The viewer's own local time (no fixed zone); an unreadable value is shown as received. */
export function localStamp(iso: string, withTime = false): string {
 const at = new Date(iso);
 if (Number.isNaN(at.getTime())) return visibleText(iso);
 const day = viewerTime(at, { day: "numeric", month: "short" });
 return withTime ? `${day} ${at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}` : day;
}
export function localClock(iso: string): string {
 const at = new Date(iso);
 return Number.isNaN(at.getTime()) ? visibleText(iso) : at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
export function Stamp({ iso, withTime = false }: { iso: string; withTime?: boolean }) {
 return <time dateTime={iso}>{localStamp(iso, withTime)}</time>;
}
/** Clock time of the last successful read, in the viewer's local time. */
export function readClock(updatedAt: number): string | undefined {
 if (!Number.isFinite(updatedAt) || updatedAt <= 0) return undefined;
 return new Date(updatedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
/** "Read from Rovara 14:31", from the time of the last good read. */
export function ReadFrom({ at }: { at: number }) {
 const clock = readClock(at);
 return clock === undefined ? null : <>Read from Rovara {clock}.</>;
}

/** The 4e error block: full outline, what happened, what is safe, what to do, one recovery button, a copyable reference. */
export function ErrorBlock({ code, happened, onRetry, busy, safe = READ_FAILED_SAFE }: { code: string; happened: string; onRetry: () => void; busy: boolean; safe?: string }) {
 const [copied, setCopied] = useState(false);
 return <section className="g5-error" role="alert" aria-labelledby={`${code}-title`}>
  <h2 id={`${code}-title`}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="6.5" /><path d="M8 4.5v4M8 11v.2" /></svg>Rovara couldn&apos;t read this page</h2>
  <dl>
   <div><dt>What happened</dt><dd>{happened}</dd></div>
   <div><dt>What is safe</dt><dd>{safe}</dd></div>
   <div><dt>What to do</dt><dd>Load the page again. If it still cannot be read, ask another owner.</dd></div>
  </dl>
  <div className="g5-recovery"><Button variant="primary" busy={busy} data-read-retry onClick={onRetry}>Load again</Button>
   <span className="g5-reference"><span>Ref <code>{code}</code></span><span aria-hidden="true">·</span><Button variant="quiet" data-copy-ref aria-label="Copy reference" onClick={() => { void navigator.clipboard?.writeText(code).then(() => setCopied(true), () => undefined); }}>{copied ? "Copied" : "Copy"}</Button></span>
  </div>
 </section>;
}

/** A section that cannot be read: the rest of the page stays, this one says so and offers one retry. */
export function SectionUnknown({ children, onRetry, busy }: { children: ReactNode; onRetry: () => void; busy: boolean }) {
 return <div className="g5-unknown" role="status"><p>{children}</p><Button variant="secondary" busy={busy} data-read-retry onClick={onRetry}>Check again</Button></div>;
}

/** The one 4f line for a failed refresh that keeps the earlier details. */
export function StaleLine({ at }: { at: number }) {
 const clock = readClock(at);
 return <p className="g5-stale" role="status" data-stale-line><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false"><path d="M8 2a6 6 0 1 1-6 6" /></svg>{clock === undefined ? "Reconnecting" : `Updated ${clock} · Reconnecting`}</p>;
}

export function Loading({ children }: { children: ReactNode }) {
 return <div className="g5-loading"><p role="status" className="g5-loading-line"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false"><path d="M8 2a6 6 0 1 1-6 6" /></svg>{children}</p>
  <div aria-hidden="true" className="g5-skeleton-rows"><span className="rv-skeleton" /><span className="rv-skeleton" /><span className="rv-skeleton" /></div></div>;
}

export { VisibleText };

/** A notice line after an action or a return from a provider: one fixed sentence, ok or bad. */
export function Notice({ tone, testId, children }: { tone: "ok" | "bad"; testId?: string; children: ReactNode }) {
 return <p className="g5-notice" data-tone={tone} role={tone === "ok" ? "status" : "alert"} {...(testId === undefined ? {} : { "data-testid": testId })}>{tone === "ok" ? <Mark tone="ok" /> : <Mark tone="attention" />}<span>{children}</span></p>;
}
/** A part Rovara Code does not serve yet: said once, nothing guessed. `row` draws it as one list row. */
export function NotOnCode({ what, row = false }: { what: string; row?: boolean }) {
 const body = <><RowBody title={what} detail={`Not connected yet. ${what} isn't connected to Rovara Code yet. Nothing is lost; this fills in when it is.`} chip={<Unknown />} /></>;
 return row ? <li className="g5-row" data-testid="not-connected">{body}</li> : <div className="g5-row g5-row-alone" data-testid="not-connected" role="status">{body}</div>;
}

/**
 * Send-time guard for a live FORM (Change name, Create automation key). `allowed()` is read at the moment of the submit, so a form that was
 * opened on a fresh read and is submitted after the read went stale is stopped before the form sees the event: nothing is sent, and the form says why.
 * The form itself (and its show-once secret) is not touched.
 */
export function GuardedSubmit({ allowed, children }: { allowed: () => boolean; children: ReactNode }) {
 const [refused, setRefused] = useState(false);
 return <div onSubmitCapture={event => { if (allowed()) { setRefused(false); return; } event.preventDefault(); event.stopPropagation(); setRefused(true); }}>{children}{refused && <p role="alert" className="g5-dialog-alert">{STALE_REFUSAL}</p>}</div>;
}
