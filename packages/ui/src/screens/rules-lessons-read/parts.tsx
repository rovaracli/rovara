import { useEffect, useId, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { PageHeader } from "../../design/PageHeader.js";
import { type StatusChipProps } from "../../design/StatusChip.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import { StaleSlot } from "./stale.js";

/** Page title, breadcrumb and one meta line on the shared header. The last crumb is the current page, so it stays plain text. */
export function ReadHeader({ crumbs, title, description, meta, status }: { crumbs: readonly string[]; title: string; description?: string; meta?: ReactNode; status?: StatusChipProps }) {
 return <><PageHeader title={title} breadcrumbs={crumbs.map(label => ({ label }))} {...(description === undefined ? {} : { description })} {...(meta === undefined ? {} : { meta })} {...(status === undefined ? {} : { status })} /><StaleSlot /></>;
}
/** A titled block of the page. The heading names the region for assistive technology. */
export function Block({ title, meta, aside, children, id, className = "" }: { title: string; meta?: ReactNode; aside?: ReactNode; children: ReactNode; id?: string; className?: string }) {
 const auto = useId(), headingId = (id ?? auto) + "-title";
 return <section id={id} className={`g4-block ${className}`} aria-labelledby={headingId}><div className="g4-block-head"><h2 id={headingId}>{title}</h2>{aside !== undefined && <p className="g4-aside">{aside}</p>}</div>{meta !== undefined && <p className="g4-block-meta">{meta}</p>}{children}</section>;
}
/** Label on the left, facts on the right. Rows divide with one quiet rule. */
export function Rows({ children, label }: { children: ReactNode; label?: string }) { return <div className="g4-rows" role="group" {...(label === undefined ? {} : { "aria-label": label })}>{children}</div>; }
/** True from tablet width up. A phone folds each row to its label and one summary line (8c); jsdom has no media query, so it reads as wide. */
function useWide(): boolean {
 const query = "(min-width:640px)", [wide, setWide] = useState(() => typeof matchMedia === "undefined" || matchMedia(query).matches);
 useEffect(() => {
  if (typeof matchMedia === "undefined") return;
  const media = matchMedia(query), change = () => setWide(media.matches);
  media.addEventListener("change", change);change();
  return () => media.removeEventListener("change", change);
 }, []);
 return wide;
}
export function Row({ label, tag, summary, open, children, className = "", headingId }: { label: string; tag?: ReactNode; summary?: string; open?: boolean; children: ReactNode; className?: string; headingId?: string }) {
 const auto = useId(), id = headingId ?? auto, focusable = headingId === undefined ? {} : { tabIndex: -1 }, wide = useWide();
 if (!wide && summary !== undefined) return <details className={`g4-row g4-fold ${className}`} {...(open === true ? { open: true } : {})}><summary><svg className="g4-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5" /></svg><span className="g4-fold-text"><span className="g4-fold-label"><h3 id={id} {...focusable}><VisibleText text={label} /></h3>{tag}</span><span className="g4-fold-summary"><VisibleText text={summary} /></span></span></summary><div className="g4-row-body">{children}</div></details>;
 return <section className={`g4-row ${className}`} aria-labelledby={id}><div className="g4-row-label"><h3 id={id} {...focusable}><VisibleText text={label} /></h3>{tag}</div><div className="g4-row-body">{children}</div></section>;
}
const local = (iso: string, options: Intl.DateTimeFormatOptions) => { const time = Date.parse(iso);return Number.isNaN(time) ? iso : new Date(time).toLocaleDateString(undefined, options); };
/** A served ISO time as a plain date in the viewer's own zone ("15 Nov 2026"); anything that does not parse stays as served. */
export function when(iso: string): string { return local(iso, { day: "numeric", month: "short", year: "numeric" }); }
/** The same without the year ("12 Nov"), for rows that are all this year. */
export function whenShort(iso: string): string { return local(iso, { day: "numeric", month: "short" }); }
/** A served ISO time as day, month and clock time in the viewer's own zone ("12 Nov, 10:20"). */
export function whenAt(iso: string): string { const time = Date.parse(iso);return Number.isNaN(time) ? iso : new Date(time).toLocaleDateString(undefined, { day: "numeric", month: "short" }) + ", " + new Date(time).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }); }
/** When the page last answered, in the viewer's own clock ("Read at 15:36"). No zone is pinned. */
export function readAt(at: number): string { return at > 0 ? "Read at " + new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : ""; }
export function Fact({ children, from }: { children: ReactNode; from?: string }) { return <div className="g4-fact"><p>{children}</p>{from !== undefined && <small>{from}</small>}</div>; }
/** A fact Rovara has not been told: one quiet line, no icon, no action. */
export function Held({ children }: { children: ReactNode }) { return <p className="g4-held">{children}</p>; }
const chipIcons = { attention: <path d="M8 4.5v4M8 11v.2" />, ok: <path d="m4 8.5 2.5 2.5L12 5.5" />, new: <path d="M8 3.5v9M3.5 8h9" /> };
export function Notice({ children }: { children: ReactNode }) { return <p className="g4-notice" role="status"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6" /><path d="M8 4.8v3.8M8 11v.2" /></svg><span>{children}</span></p>; }
export function Chip({ children, tone }: { children: ReactNode; tone?: "attention" | "ok" | "new" }) { return <span className="g4-chip" {...(tone === undefined ? {} : { "data-tone": tone })}>{tone !== undefined && <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{tone === "attention" ? <><circle cx="8" cy="8" r="6" />{chipIcons.attention}</> : tone === "new" ? chipIcons.new : chipIcons.ok}</svg>}{children}</span>; }
/** A bordered list of rows (title + meta + trailing facts), the shared list shape for versions, lessons and recipes. */
export function List({ children, label }: { children: ReactNode; label: string }) { return <ul className="g4-list" aria-label={label}>{children}</ul>; }
export function Meta({ children }: { children: ReactNode[] }) { return <p className="g4-meta">{children.filter(Boolean).map((part, index) => <span key={index}>{part}</span>)}</p>; }
export const views = [["rules", "Rules"], ["learned", "Learned"], ["models", "Models by stage"], ["history", "History"]] as const;
export type ProjectView = (typeof views)[number][0];
/** The How we work views, one page each as on the board. Links change only the `view` query; every other query (the host's tab) stays. */
export function ViewPills({ current }: { current: ProjectView }) {
 const [params] = useSearchParams();
 const to = (view: ProjectView) => { const next = new URLSearchParams(params);next.delete("tab");next.set("tab", "how-we-work");next.set("view", view);return { search: "?" + next.toString() }; };
 return <nav className="g4-pills" aria-label="How we work">{views.map(([view, label]) => <Link key={view} to={to(view)} replace {...(view === current ? { "aria-current": "page" as const } : {})}>{label}</Link>)}</nav>;
}
/** What a failed read says is safe. Pages that write never say the page only reads, and never say "nothing was changed" after a change went through (they pass `safe`). */
export const SAFE_AFTER_READ = "Rovara couldn’t read this page.";
/** The 4e error block: red outline, icon, what happened, what is safe, what to do, one way to try again, its own reference with Copy. A read cannot have changed anything; a page that has just written passes its own `safe` line. */
export function ErrorBlock({ kind, scope, refName, retry, safe = SAFE_AFTER_READ }: { kind: "failed" | "denied"; scope: "page" | "section"; refName: string; retry: () => void; safe?: string }) {
 const id = useId(), [copied, setCopied] = useState<"" | "Copied" | "Couldn’t copy the reference.">(""), code = refName + (kind === "denied" ? "-ACCESS-LOST" : "-READ-FAILED");
 async function copy() { try { await navigator.clipboard.writeText(code);setCopied("Copied"); } catch { setCopied("Couldn’t copy the reference."); } }
 return <section className="g4-error" role="alert" aria-labelledby={id} data-kind={kind === "denied" ? "denied" : "failed"}>
  <h2 id={id}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v6m0 3v1" /></svg>Rovara couldn&#8217;t read this {scope}</h2>
  <dl className="g4-error-steps">
   <div><dt>What happened</dt><dd>{kind === "denied" ? `You no longer have access to this ${scope}. Earlier information is hidden.` : `Rovara did not return this ${scope}’s information. Earlier information is hidden.`}</dd></div>
   <div><dt>What is safe</dt><dd>{safe}</dd></div>
   <div><dt>What to do</dt><dd>{kind === "denied" ? `Ask an owner to share it with you again, then load the ${scope} again.` : `Load the ${scope} again. If it still cannot be read, ask an owner.`}</dd></div>
  </dl>
  <Button variant="primary" onClick={retry}>Load again</Button>
  <p className="g4-error-ref">Ref <code>{code}</code><span aria-hidden="true">·</span><Button variant="quiet" aria-label="Copy reference" onClick={() => { void copy(); }}>Copy</Button>{copied !== "" && <span role="status">{copied}</span>}</p>
 </section>;
}
