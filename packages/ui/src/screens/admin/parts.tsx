// Small parts the Hybrid 1 admin pages share (DEC 223): "not connected yet", a stat, a meter and a section card.
import type { ReactNode } from "react";

/** What a page says for a route Cloud or Code does not serve yet. Never a spinner, never an empty table that looks like "nothing there". */
export function NotConnected({ what, children }: { what: string; children?: ReactNode }) {
 return <div className="rv-not-connected" data-testid="not-connected" role="status"><b>Not connected yet</b><p>{what} isn't connected to Rovara Code yet. {children ?? "Nothing is lost; this page fills in when it is."}</p></div>;
}

export function Stat({ label, children, note, tone }: { label: string; children: ReactNode; note?: ReactNode; tone?: "bad" | "warn" | "ok" }) {
 return <div className="rv-stat" {...(tone === undefined ? {} : { "data-tone": tone })}><span className="rv-stat-label">{label}</span><b className="rv-stat-value">{children}</b>{note !== undefined && <span className="rv-stat-note">{note}</span>}</div>;
}

/** A meter with a held part: the spent part is solid, the held part is lighter. Words go beside it; the bar alone says nothing to a screen reader. */
export function SpendMeter({ used, held = 0, bad = false, label, caption = false }: { used: number; held?: number; bad?: boolean; label: string; caption?: boolean }) {
 const pct = (n: number) => `${Math.round(Math.min(1, Math.max(0, n)) * 100)}%`;
 return <><div className="rv-meter rv-spend-meter" role="img" aria-label={label}><i className={bad ? "bad" : ""} style={{ width: pct(used) }} />{held > 0 && <u style={{ width: pct(Math.min(held, 1 - Math.min(1, used))) }} />}</div>{caption && <p className="rv-meter-caption" aria-hidden="true">{label}</p>}</>;
}

export function AdminSection({ id, title, note, children, actions }: { id?: string; title: string; note?: ReactNode; children: ReactNode; actions?: ReactNode }) {
 return <section className="rv-admin-card" {...(id === undefined ? {} : { id })} aria-label={title}><div className="rv-section-head"><h2>{title}</h2>{actions ?? (note !== undefined && <span>{note}</span>)}</div>{children}</section>;
}
