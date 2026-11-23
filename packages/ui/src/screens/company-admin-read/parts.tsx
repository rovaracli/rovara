import { useState, type ReactNode } from "react";
import { Button } from "../../design/Button.js";
import { viewerTime } from "../../design/viewer-time.js";
import { VisibleText, visibleText } from "../../design/VisibleText.js";

/** A titled block of the page. The heading names the region, so tests and screen readers can find it. */
export function ReadSection({ title, children, className = "" }: { title: string; children: ReactNode; className?: string }) {
 const id = `rv-car-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
 return <section className={`rv-car-section ${className}`.trim()} aria-labelledby={id}><h2 id={id}>{title}</h2>{children}</section>;
}

/** 4e list rows: bordered group, one row per destination or fact. */
export function Rows({ label, children }: { label?: string; children: ReactNode }) {
 return <ul className="rv-car-rows" aria-label={label}>{children}</ul>;
}

/** `inert` marks a destination that has no page here yet: same shape, quieter mark. */
export function Chevron({ inert = false }: { inert?: boolean }) {
 return <svg className={inert ? "rv-car-chevron rv-car-chevron-inert" : "rv-car-chevron"} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="m6 3 5 5-5 5" /></svg>;
}

/** Label and value pairs in the 4e key-value form. */
export function Facts({ children }: { children: ReactNode }) {
 return <dl className="rv-car-facts">{children}</dl>;
}
export function Fact({ label, children }: { label: string; children: ReactNode }) {
 return <div><dt>{label}</dt><dd>{children}</dd></div>;
}

/** "HH:MM" of the successful read, shown as "Read from Rovara HH:MM". */
export function readClock(updatedAt: number): string | undefined {
 if (!Number.isFinite(updatedAt) || updatedAt <= 0) return undefined;
 return clock(new Date(updatedAt));
}
/** Every time on these pages goes through the shared viewer-local formatter (viewerTime). 24-hour clock, no zone named. */
const clock = (at: Date) => viewerTime(at, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** The viewer's own clock and day, never a fixed zone. Today reads "today 15:10"; another day reads "21 Nov 15:10". An unreadable value is shown as received. */
export function localStamp(iso: string, now: Date = new Date()): string {
 const at = new Date(iso);
 if (Number.isNaN(at.getTime())) return visibleText(iso);
 const sameDay = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
 return sameDay ? `today ${clock(at)}` : `${String(at.getDate())} ${viewerTime(at, { month: "short" })} ${clock(at)}`;
}
export function Stamp({ iso }: { iso: string }) {
 return <time dateTime={iso}>{localStamp(iso)}</time>;
}
/** A row time in the viewer's own clock: "Today 15:10", or the day and time ("21 Nov 15:10") on another day. */
export function RowStamp({ iso }: { iso: string }) {
 const text = localStamp(iso);
 return <time dateTime={iso}>{text.startsWith("today ") ? `Today ${text.slice(6)}` : text}</time>;
}
export function eventClock(iso: string): string | undefined {
 const at = new Date(iso);
 return Number.isNaN(at.getTime()) ? undefined : clock(at);
}

/** A result mark in the shared chip look: green with a tick when done, grey with a question mark when the outcome is not confirmed. */
export function ResultChip({ outcome }: { outcome: string }) {
 const text = outcome.trim().toLowerCase();
 const done = text === "recorded", unconfirmed = text === "not confirmed";
 return <span className="rv-status-chip rv-car-result" data-hue={done ? "ok" : "idle"} data-state={done ? "done" : "result"}>
  <svg className="rv-status-chip-icon" aria-hidden="true" focusable="false" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{done ? <path d="m3 8 3 3 7-7" /> : unconfirmed ? <><circle cx="8" cy="8" r="6" /><path d="M6 6a2 2 0 1 1 3 1.7C8 8.2 8 8.5 8 9M8 11v.2" /></> : <path d="M5 8h6" />}</svg>
  <VisibleText text={done ? "Done" : unconfirmed ? "Not confirmed" : outcome} />
 </span>;
}

/** The 4e error block: full outline, what happened, what is safe, what to do, one recovery button, a copyable reference. */
export function ErrorBlock({ code, happened, next = "Load the page again. If it still cannot be read, ask a company owner or admin.", safe = "Rovara couldn't read this page.", onRetry, busy }: { code: string; happened: string; next?: string; /** What is safe. The default is neutral and never false; "Nothing was changed" may appear only where the code knows nothing was sent. */ safe?: string; onRetry: () => void; busy: boolean }) {
 const [copied, setCopied] = useState(false);
 return <section className="rv-car-error" role="alert" aria-labelledby={`${code}-title`}>
  <h2 id={`${code}-title`}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="6.5" /><path d="M8 4.5v4M8 11v.2" /></svg>Rovara couldn&apos;t read this page</h2>
  <dl>
   <div><dt>What happened</dt><dd>{happened}</dd></div>
   <div><dt>What is safe</dt><dd>{safe}</dd></div>
   <div><dt>What to do</dt><dd>{next}</dd></div>
  </dl>
  <div className="rv-car-recovery"><Button variant="primary" busy={busy} onClick={onRetry}>Load again</Button>
   <span className="rv-car-reference"><span>Ref <code>{code}</code></span><span aria-hidden="true">·</span><Button variant="quiet" aria-label="Copy reference" onClick={() => { void navigator.clipboard?.writeText(code).then(() => setCopied(true), () => undefined); }}>{copied ? "Copied" : "Copy"}</Button></span>
  </div>
 </section>;
}

/** One quiet line: access ended, or a read that has not answered yet. */
export function Notice({ role, children }: { role: "alert" | "status"; children: ReactNode }) {
 return <p className="rv-car-notice" role={role}>{children}</p>;
}

export function Loading({ children }: { children: ReactNode }) {
 return <div className="rv-car-loading"><p role="status" className="rv-car-loading-line"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false"><path d="M8 2a6 6 0 1 1-6 6" /></svg>{children}</p>
  <div aria-hidden="true" className="rv-car-skeleton-rows"><span className="rv-skeleton" /><span className="rv-skeleton" /><span className="rv-skeleton" /></div></div>;
}

export { VisibleText };
