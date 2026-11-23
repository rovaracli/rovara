import type { ReactNode } from 'react';
import { StatusChip } from '../../design/StatusChip.js';
/** The one Unknown marker: a fact that is not served. Never a verdict, never repeated as plain text. */
export function Unknown() {
 return <StatusChip state="unknown" />;
}
const FACT_ICONS = {
 tick: <path d="m3 8 3 3 7-7" />,
 dash: <path d="M5 8h6" />,
 activity: <path d="M8 2a6 6 0 1 1-6 6" />,
 stop: <rect x="4" y="4" width="8" height="8" rx="1" />,
} as const;
/** A small fact chip in the shared chip shape. Neutral by default: a connected key is not a verified one, an open task is not a running one. */
export function FactChip({ children, icon = 'dash', hue = 'idle', dashed = false }: { children: ReactNode; icon?: keyof typeof FACT_ICONS; hue?: 'idle' | 'running'; dashed?: boolean }) {
 return <span className="rv-status-chip g2-fact" data-hue={hue} {...(dashed ? { 'data-state': 'not_run' } : {})}>
  <svg className="rv-status-chip-icon" aria-hidden="true" focusable="false" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{FACT_ICONS[icon]}</svg>{children}
 </span>;
}
export function Note({ title, children }: { title?: string; children: ReactNode }) {
 return <section className="g2-grey">{title !== undefined && <h2>{title}</h2>}<p>{children}</p></section>;
}
/** One quiet line for a state that is not an error (loading, not here yet). */
export function HeldLine({ children, role }: { children: ReactNode; role?: 'status' | 'alert' }) {
 return <p className="rv-held-line g2-held" {...(role === undefined ? {} : { role })}>{children}</p>;
}
export function Facts({ rows }: { rows: ReadonlyArray<readonly [string, ReactNode]> }) {
 return <dl className="g2-kv">{rows.map(([term, value]) => <div key={term}><dt>{term}</dt><dd>{value}</dd></div>)}</dl>;
}
/** A bordered card with an optional sub line under its title. `actions` sit in the card header, right of the title (the boards' Rename / Merge / Mark done). */
export function Card({ title, sub, label, eyebrow, actions, children }: { title: string; sub?: ReactNode; label?: string; eyebrow?: string; actions?: ReactNode; children: ReactNode }) {
 const head = <>
  {eyebrow !== undefined && <span className="g2-eyebrow">{eyebrow}</span>}
  <h2>{title}</h2>
  {sub !== undefined && <p className="g2-sub">{sub}</p>}
 </>;
 return <section className="g2-card" aria-label={label ?? title}>
  {actions === undefined ? head : <div className="g2-card-head"><div className="g2-card-title">{head}</div><div className="g2-card-actions">{actions}</div></div>}
  {children}
 </section>;
}
/** A section on the page background: a heading with an optional quiet line and the section's own actions on its right. */
export function Section({ title, right, actions, id, label, children }: { title: string; right?: ReactNode; actions?: ReactNode; id?: string; label?: string; children: ReactNode }) {
 return <section className="g2-sec" {...(id === undefined ? {} : { id })} aria-label={label ?? title}>
  <div className="g2-sec-head"><h2>{title}</h2>{right !== undefined && <span className="g2-sec-right">{right}</span>}{actions !== undefined && <div className="g2-sec-actions">{actions}</div>}</div>
  {children}
 </section>;
}
/** One bordered list of rows. */
export function RowList({ children, ordered = false, label, big = false }: { children: ReactNode; ordered?: boolean; label?: string; big?: boolean }) {
 const Tag = ordered ? 'ol' : 'ul';
 return <Tag className="g2-rows" {...(big ? { 'data-big': true } : {})} {...(label === undefined ? {} : { 'aria-label': label })}>{children}</Tag>;
}
export function Row({ title, chip, meta, end, lead, selected = false }: { title: ReactNode; chip?: ReactNode; meta?: ReactNode; end?: ReactNode; lead?: ReactNode; selected?: boolean }) {
 return <li className="g2-row" {...(selected ? { 'aria-current': 'true' as const } : {})}>
  {lead}
  <div className="g2-copy"><div className="g2-ttl"><strong>{title}</strong>{chip}</div>{meta !== undefined && <span className="g2-meta">{meta}</span>}</div>
  {end !== undefined && <span className="g2-end">{end}</span>}
 </li>;
}
/** First table cell: a title, an optional sub line, and the phone summary line with its chevron (desktop hides both). */
export function TitleCell({ title, sub, summary, plain = false }: { title: ReactNode; sub?: ReactNode; summary: ReactNode; plain?: boolean }) {
 return <>
  {plain ? title : <strong>{title}</strong>}
  {sub !== undefined && <small className="g2-sub2">{sub}</small>}
  <span className="g2-summary">{summary}</span>
  <span className="g2-go" aria-hidden="true">&rsaquo;</span>
 </>;
}
/** A served time in the viewer's own local time zone. No zone is named or fixed; the same day shows the time only. */
export function readTime(iso: string | number, now: Date = new Date()): string {
 const date = new Date(iso);
 if (Number.isNaN(date.getTime())) return String(iso);
 const hm = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } as const;
 const day = (d: Date) => `${String(d.getFullYear())}-${String(d.getMonth())}-${String(d.getDate())}`;
 if (day(date) === day(now)) return date.toLocaleTimeString('en-GB', hm);
 return date.toLocaleString('en-GB', { day: 'numeric', month: 'short', ...hm });
}
/** Whole dollars when the cents are zero ("$61"), cents otherwise ("$61.23"). */
export function dollarsShort(cents: number, floor = false): string {
 const text = `$${cents % 100 === 0 ? (cents / 100).toLocaleString('en-US') : (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
 return floor ? `${text} or more` : text;
}
/** A length of time as "2 h 05 min", "35 min", "1 d 3 h". Calendar time, so it can include waiting. */
export function durationHm(ms: number): string {
 const minutes = Math.round(ms / 60_000);
 if (minutes < 1) return 'under 1\u00a0min';
 const nb = '\u00a0';
 if (minutes < 60) return `${String(minutes)}${nb}min`;
 const hours = Math.floor(minutes / 60), rest = minutes % 60;
 if (hours >= 48) return `${String(Math.floor(hours / 24))}${nb}d${nb}${String(hours % 24)}${nb}h`;
 return `${String(hours)}${nb}h${nb}${String(rest).padStart(2, '0')}${nb}min`;
}
/** A model id as people say it: "claude-sonnet-4-5" is "Claude Sonnet 4.5". An id this does not know stays as served. */
export function modelName(id: string): string {
 const match = /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/u.exec(id);
 if (match === null) return id;
 const family = (match[1] ?? '').replace(/^./u, letter => letter.toUpperCase());
 return `Claude ${family} ${match[2] ?? ''}${match[3] === undefined ? '' : `.${match[3]}`}`;
}
