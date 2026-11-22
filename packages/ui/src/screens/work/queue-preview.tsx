import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";

/** One clock for a screen: relative words stay current without every row running its own timer. */
export function useNow(intervalMs = 30000): number {
 const [now, setNow] = useState(() => Date.now());
 useEffect(() => { const timer = setInterval(() => setNow(Date.now()), intervalMs);return () => clearInterval(timer); }, [intervalMs]);
 return now;
}

/** The time column of a row, in the words of the approved boards: 20 s, 4 min, 1 h, 1 d, then the weekday, then the date. */
export function shortAge(at: string, now: number): string {
 const time = Date.parse(at);
 if (!Number.isFinite(time)) return "";
 const seconds = Math.max(0, Math.floor((now - time) / 1000));
 if (seconds < 60) return String(seconds) + " s";
 const minutes = Math.floor(seconds / 60);
 if (minutes < 60) return String(minutes) + " min";
 const hours = Math.floor(minutes / 60);
 if (hours < 24) return String(hours) + " h";
 if (hours < 48) return "1 d";
 const when = new Date(time);
 return hours < 24 * 7 ? when.toLocaleDateString(undefined, { weekday: "short" }) : when.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
/** "Updated 20 s ago", or "Updated just now" for the first few seconds; older than a week it is the date ("Updated Nov 14"), never "Nov 14 ago". */
export function updatedWords(at: string, now: number): string {
 const age = shortAge(at, now);
 return age === "" ? "" : Math.floor((now - Date.parse(at)) / 1000) < 10 ? "Updated just now" : /^\d+ (s|min|h|d)$/u.test(age) ? "Updated " + age + " ago" : "Updated " + age;
}
/** A viewer-local clock time (HH:MM), never a fixed zone. */
export function clockTime(at: string): string {
 const time = Date.parse(at);
 return Number.isFinite(time) ? new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) : "";
}

export interface QueueTab { key: string; label: string; /** Shown only when the read behind it was current; absent means Rovara cannot count it. */ count?: string | undefined }
/**
 * The tabs of a screen. The counts come from the served rows, a count that cannot be known is left out (never "0"). On a phone the row scrolls sideways and
 * a soft edge shows there is more, so no label is cut off with no hint.
 */
export function QueueTabs({ label, value, items, onSelect }: { label: string; value: string; items: readonly QueueTab[]; onSelect: (key: string) => void }) {
 return <div className="rv-qp-tabs" role="group" aria-label={label}>{items.map(item => <button key={item.key} type="button" aria-pressed={value === item.key} onClick={() => onSelect(item.key)}>{item.count === undefined ? item.label : `${item.label} · ${item.count}`}</button>)}</div>;
}

/** The reference of a failed read, with a Copy that never needs anything but the page. */
export function ErrorRef({ code }: { code: string }) {
 const [copied, setCopied] = useState(false);
 return <span className="rv-qp-ref"><span className="rv-qp-ref-label">Ref <code>{code}</code></span><span aria-hidden="true">·</span><Button variant="quiet" aria-label="Copy reference" onClick={() => { void navigator.clipboard?.writeText(code).then(() => { setCopied(true); }, () => undefined); }}>{copied ? "Copied" : "Copy"}</Button></span>;
}
/** What a refused or failed read says: the answer's own sentence, and for an ended access that nothing from before is shown (the earlier rows are wiped, never kept). */
export function readFailureWords(error: unknown, fallback: string): string {
 if (error instanceof ApiError) return error.message + (error.status === 401 || error.status === 403 ? " Nothing from before is shown." : "");
 return fallback;
}
/** What to do about a failed read: an ended access needs an admin first; anything else can simply be tried again. */
export function readFailureTodo(error: unknown): string {
 return error instanceof ApiError && (error.status === 401 || error.status === 403) ? "Ask your company's admin for access, then try again." : "Try again. If it still cannot be read, ask your company's admin.";
}
/**
 * The 4e error block, the same form on every failed or access-lost read: a red outline, an icon, what happened, what is safe, what to do, one primary way to
 * try again and its own reference with Copy. A failed read is never an empty one, so nothing under this block claims there is nothing to show.
 */
export function ErrorBlock({ title, children, safe = "Nothing was changed. Running tasks are not affected.", todo = "Try again. If it still cannot be read, ask your company's admin.", retryLabel = "Try again", onRetry, refCode, testId, live = "status" }: { title: string; children: ReactNode; safe?: string; todo?: string; retryLabel?: string; onRetry: () => void; refCode: string; testId?: string; live?: "alert" | "status" }) {
 const id = "rv-qp-error-" + refCode.toLowerCase();
 return <section className="rv-qp-error" role={live} aria-labelledby={id} data-testid={testId}>
  <h2 id={id}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="6.5" /><path d="M8 4.5v4M8 11v.2" /></svg>{title}</h2>
  <dl><div><dt>What happened</dt><dd>{children}</dd></div><div><dt>What is safe</dt><dd>{safe}</dd></div><div><dt>What to do</dt><dd>{todo}</dd></div></dl>
  <div className="rv-qp-recovery"><Button variant="primary" onClick={onRetry}>{retryLabel}</Button><ErrorRef code={refCode} /></div>
 </section>;
}
/** A quiet sentence under the list, for a side read that failed (it does not change what the rest of the page shows). */
export function QuietNote({ children, actionLabel, onAction, testId }: { children: ReactNode; actionLabel?: string; onAction?: () => void; testId?: string }) {
 return <p className="rv-qp-note" role="status" data-testid={testId}>{children}{actionLabel !== undefined && onAction !== undefined && <> <Button variant="quiet" onClick={onAction}>{actionLabel}</Button></>}</p>;
}
/** The empty and held blocks of the list: a heading, one sentence, at most one link. */
export function QueueEmpty({ title, children, testId, link }: { title: string; children: ReactNode; testId?: string; link?: { to: string; label: string } }) {
 return <section className="rv-qp-empty" data-testid={testId}><h2>{title}</h2><p>{children}</p>{link !== undefined && <Link to={link.to}>{link.label}</Link>}</section>;
}

const CHEVRON = <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m10 3-5 5 5 5" /></svg>;
/** Back on a phone (hidden on a desktop, where the list stays beside the peek). */
export function BackButton({ label, onClick }: { label: string; onClick: () => void }) {
 return <button type="button" className="rv-qp-back" aria-label={label} onClick={onClick}>{CHEVRON}</button>;
}
/**
 * The short peek of boards 2a and 2c. On a desktop it sits beside the list: the project and when it was read, the title, the status, one step and Open task.
 * On a phone it is the full-width view of 2e: a header bar (Back, the title and its project) and the same content at full width, with Open task at the foot.
 * It never carries the task's evidence: that stays on the task page.
 */
export function QueuePeek({ label, backLabel, onBack, project, updated, title, titleRef, titleTestId, status, children, openTo, openLabel, footnote }: {
 label: string; backLabel: string; onBack: () => void; project: string; updated: string; title: string; titleRef?: ((element: HTMLHeadingElement | null) => void) | undefined; titleTestId?: string; status: ReactNode; children: ReactNode; openTo?: string | undefined; openLabel?: string; footnote?: string;
}) {
 return <section className="rv-qp-peek" aria-label={label}>
  <header className="rv-qp-peek-head">
   <BackButton label={backLabel} onClick={onBack} />
   <p className="rv-qp-peek-project"><VisibleText text={project} />{updated !== "" && <span className="rv-qp-peek-updated"> · {updated}</span>}</p>
   <h2 ref={titleRef} tabIndex={-1} {...(titleTestId === undefined ? {} : { "data-testid": titleTestId })}><VisibleText text={title} /></h2>
  </header>
  <div className="rv-qp-peek-status">{status}{updated !== "" && <span className="rv-qp-peek-age">{updated}</span>}</div>
  <div className="rv-qp-peek-body">{children}</div>
  {openTo !== undefined && <div className="rv-qp-peek-actions"><Link className="rv-button rv-button-primary" to={openTo}>{openLabel ?? "Open task"}</Link>{footnote !== undefined && <p className="rv-qp-peek-foot">{footnote}</p>}</div>}
 </section>;
}
