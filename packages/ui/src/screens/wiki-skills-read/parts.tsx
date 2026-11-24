import { createContext, useContext, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Button } from "../../design/Button.js";
import { PageHeader } from "../../design/PageHeader.js";
import { VisibleText } from "../../design/VisibleText.js";
import { SOURCES_TAB_OFFERED } from "../project/sources-tab-gate.js";

/** A titled block of the page; the heading names the region for readers and tests. */
export function Section({ title, aside, children, label }: { title: string; aside?: ReactNode; children: ReactNode; label?: string }) {
 return <section className="rv-wsr-section" aria-label={label ?? title}><div className="rv-wsr-section-head"><h2>{title}</h2>{aside}</div>{children}</section>;
}

/** The lead of a page body: one heading and one plain paragraph. */
export function Intro({ title, children }: { title: string; children?: ReactNode }) {
 return <div className="rv-wsr-intro"><h2>{title}</h2>{children !== undefined && <p>{children}</p>}</div>;
}

/** 4e list rows: a bordered group with one row per item. */
export function Rows({ label, children }: { label: string; children: ReactNode }) {
 return <ul className="rv-wsr-rows" aria-label={label}>{children}</ul>;
}
export function Row({ title, level = 3, detail, extra, side, children }: { title: ReactNode; level?: 2 | 3; detail?: ReactNode; extra?: ReactNode; side?: ReactNode; children?: ReactNode }) {
 const Heading = level === 2 ? "h2" : "h3";
 return <li className="rv-wsr-row"><div className="rv-wsr-row-line"><div className="rv-wsr-row-main"><Heading>{title}</Heading>{detail !== undefined && <p>{detail}</p>}{extra}</div>{side !== undefined && <div className="rv-wsr-row-side">{side}</div>}</div>{children}</li>;
}

/** Label and value pairs in the 4e key-value form. */
export function Facts({ children }: { children: ReactNode }) {
 return <dl className="rv-wsr-facts">{children}</dl>;
}
export function Fact({ label, children }: { label: string; children: ReactNode }) {
 return <div><dt>{label}</dt><dd>{children}</dd></div>;
}

/** A bordered card. `attention` is the quiet amber outline for something that needs a person. */
export function Card({ title, chip, tone, children, level = 2 }: { title?: string; chip?: ReactNode; tone?: "attention"; children: ReactNode; level?: 2 | 3 }) {
 const Heading = level === 2 ? "h2" : "h3";
 return <section className="rv-wsr-card" data-tone={tone}>{(title !== undefined || chip !== undefined) && <div className="rv-wsr-card-head">{title !== undefined && <Heading>{title}</Heading>}{chip}</div>}{children}</section>;
}

type Tone = "ok" | "attention" | "running" | "neutral";
const CHIP_ICONS = {
 ok: <path d="m3 8 3 3 7-7" />,
 attention: <><circle cx="8" cy="8" r="6" /><path d="M8 4.5v4M8 11v.2" /></>,
 running: <path d="M8 2a6 6 0 1 1-6 6" />,
 clock: <><circle cx="8" cy="8" r="6" /><path d="M8 4v4l2.5 1.5" /></>,
 dash: <path d="M5 8h6" />,
 box: <rect x="4" y="4" width="8" height="8" rx="1.5" />,
 stop: <><circle cx="8" cy="8" r="6" /><rect x="6" y="6" width="4" height="4" rx="0.5" /></>,
} as const;
/** The design system's chip look (same tokens and hues) for facts the shared status set does not name. Neutral chips are quiet grey. */
export function Chip({ tone = "neutral", icon, dashed = false, children }: { tone?: Tone; icon?: keyof typeof CHIP_ICONS; dashed?: boolean; children: string }) {
 const glyph = icon ?? (tone === "ok" ? "ok" : tone === "attention" ? "attention" : tone === "running" ? "running" : "clock");
 return <span className="rv-status-chip rv-wsr-chip" data-hue={tone === "neutral" ? undefined : tone} data-dashed={dashed || undefined}><svg className="rv-status-chip-icon" aria-hidden="true" focusable="false" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{CHIP_ICONS[glyph]}</svg>{children}</span>;
}

/** "HH:MM" of the successful read, shown as "Read from Rovara HH:MM". */
export function readClock(updatedAt: number): string | undefined {
 if (!Number.isFinite(updatedAt) || updatedAt <= 0) return undefined;
 // The viewer's own local time: no fixed locale or zone.
 return new Date(updatedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
/** A served calendar date stays on its day; instants use a short date in the viewer's own zone ("12 Nov"; the year only when it is not this year). */
export function day(iso: string) {
 const at = new Date(iso.length === 10 ? iso + "T00:00:00" : iso);
 if (Number.isNaN(at.getTime())) return iso;
 return at.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(at.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }) });
}
/** A served instant as short date and time in the viewer's own zone. */
export function dayTime(iso: string) {
 const at = new Date(iso);
 return Number.isNaN(at.getTime()) ? iso : day(iso) + ", " + at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export type Crumb = { label: string; href?: string };
/** The project frame of every board: the project sections row and the How we work pills. Targets follow the host's `?tab=` convention; WIRING owns the host tabs. */
// Every target is a real tab of the project page: the setup checklist is on the overview, and the project's people are in its Settings.
const SECTIONS = ([["Tasks", ""], ["How we work", "how-we-work"], ["Sources", "sources"], ["People", "settings"], ["Setup", ""], ["Settings", "settings"]] as const).filter(([label]) => label !== "Sources" || SOURCES_TAB_OFFERED);
const PILLS = [["Rules", "how-we-work"], ["Learned", "how-we-work"], ["Models by stage", "how-we-work"], ["History", "how-we-work"], ["Wiki", "wiki"], ["Skills", "skills"]] as const;
export function ProjectTabs({ project, pill }: { project: string; pill: "Wiki" | "Skills" }) {
 const base = "/app/projects/" + encodeURIComponent(project), to = (tab: string) => tab === "" ? base : base + "?tab=" + tab;
 return <>
  <nav className="rv-wsr-tabs" aria-label="Project sections">{SECTIONS.map(([label, tab]) => <Link key={label} to={to(tab)} {...(label === "How we work" ? { "aria-current": "page" as const } : {})}>{label}</Link>)}</nav>
  <nav className="rv-wsr-pills" aria-label="How we work">{PILLS.map(([label, tab]) => <Link key={label} to={to(tab)} {...(label === pill ? { "aria-current": "page" as const } : {})}>{label}</Link>)}</nav>
 </>;
}
/** The shared header: project name, one meta line, breadcrumbs to the places the host really has, then the project frame. */
export function Header({ project, trail, meta, readAt, always = false }: { project: string; trail: readonly string[]; meta?: string; readAt?: string | undefined; always?: boolean }) {
 const base = "/app/projects/" + encodeURIComponent(project);
 const known: Record<string, string> = { [project]: base, "How we work": base + "?tab=how-we-work", Wiki: base + "?tab=wiki", Skills: base + "?tab=skills" };
 const crumbs: Crumb[] = [{ label: "Projects" }, { label: project, href: base }, { label: "How we work", href: known["How we work"]! }, ...trail.map((label, index) => (index < trail.length - 1 && known[label] !== undefined ? { label, href: known[label] } : { label }))];
 const line = readAt === undefined && !always ? "" : [meta, readAt === undefined ? undefined : "Read from Rovara " + readAt].filter((part): part is string => part !== undefined).join(" · ");
 return <><PageHeader title={project} breadcrumbs={crumbs} {...(line === "" ? {} : { meta: line })} /><ProjectTabs project={project} pill={trail[0] === "Skills" ? "Skills" : "Wiki"} /></>;
}

/** A page lead: heading and one plain paragraph on the left, quiet links on the right (the board's head row). */
export function HeadRow({ title, text, actions }: { title: string; text?: string; actions?: ReactNode }) {
 return <div className="rv-wsr-headrow"><div className="rv-wsr-intro"><h2>{title}</h2>{text !== undefined && <p>{text}</p>}</div>{actions !== undefined && <div className="rv-wsr-actions">{actions}</div>}</div>;
}
/** The main column with its side rail (the board's two-column read). */
export function Two({ children, rail }: { children: ReactNode; rail: ReactNode }) {
 return <div className="rv-wsr-two"><div className="rv-wsr-main">{children}</div><aside className="rv-wsr-rail">{rail}</aside></div>;
}
export function RailCard({ title, children }: { title: string; children: ReactNode }) {
 return <section className="rv-wsr-railcard" aria-label={title}><h2>{title}</h2><div className="rv-wsr-card">{children}</div></section>;
}

/** The 4e error block: full outline, what happened, what is safe, what to do, one recovery button and a copyable reference. */
export function ErrorBlock({ code, happened, onRetry, busy, title = "Rovara couldn't read this page", safe = "Nothing was changed. Your work and saved settings are kept.", todo = "Load the page again. If it still cannot be read, ask a project maintainer." }: { code: string; happened: string; onRetry: () => void; busy: boolean; title?: string; safe?: string; todo?: string }) {
 const [copied, setCopied] = useState(false);
 return <section className="rv-wsr-error" role="alert" aria-labelledby={code + "-title"}>
  <h2 id={code + "-title"}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="6.5" /><path d="M8 4.5v4M8 11v.2" /></svg>{title}</h2>
  <dl>
   <div><dt>What happened</dt><dd>{happened}</dd></div>
   <div><dt>What is safe</dt><dd>{safe}</dd></div>
   <div><dt>What to do</dt><dd>{todo}</dd></div>
  </dl>
  <div className="rv-wsr-recovery"><Button variant="primary" busy={busy} onClick={onRetry}>Load again</Button>
   <span className="rv-wsr-reference"><span>Ref <code>{code}</code></span><span aria-hidden="true">·</span><Button variant="quiet" aria-label="Copy reference" onClick={() => { void navigator.clipboard?.writeText(code).then(() => { setCopied(true); }, () => undefined); }}>{copied ? "Copied" : "Copy"}</Button></span>
  </div>
 </section>;
}

/** The board's stale form: the kept page, with one line saying when it was last read. */
export function StaleLine({ at }: { at: string | undefined }) {
 return <p className="rv-wsr-stale" role="status"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false"><path d="M8 2a6 6 0 1 1-6 6" /></svg>{at === undefined ? "Reconnecting" : "Updated " + at + " · Reconnecting"}</p>;
}

/** Which project frame an access-ended page keeps. The project name is never part of it: nothing from the project stays on the page. */
export const AccessFrameContext = createContext<{ project: string; pill: "Wiki" | "Skills" } | undefined>(undefined);
/**
 * Access ended: the 4e error block with its own reference, under one frame shared by every page (breadcrumb, the project
 * tabs and pills; no project name). `bare` leaves the frame out for a block nested inside a page.
 */
export function AccessEnded({ onRetry, busy = false, bare = false }: { onRetry: () => void; busy?: boolean; bare?: boolean }) {
 const frame = useContext(AccessFrameContext);
 const block = <ErrorBlock code="WIKI-ACCESS-ENDED" title="Access ended" happened="Your access to this project ended. Nothing from it is shown." safe="Nothing was changed. Nothing from this project stays on this page." todo="Ask a project maintainer to add you again, then load the page again." busy={busy} onRetry={onRetry} />;
 if (bare || frame === undefined) return block;
 return <><PageHeader title={frame.pill} breadcrumbs={[{ label: "Projects" }, { label: "How we work" }, { label: frame.pill }]} /><ProjectTabs project={frame.project} pill={frame.pill} />{block}</>;
}

/** A held read: Rovara has no answer to show, so it says so once and offers a way back. */
export function HeldLine({ children, back }: { children: ReactNode; back?: { label: string; href: string } }) {
 return <div className="rv-wsr-held" role="status"><p>{children}</p>{back !== undefined && <Link className="rv-button rv-button-secondary" to={back.href}>{back.label}</Link>}</div>;
}

export function Notice({ children, role }: { children: ReactNode; role?: "status" | "alert" }) {
 return <p className="rv-wsr-line" {...(role === undefined ? {} : { role })}>{children}</p>;
}

export function Loading({ children }: { children: ReactNode }) {
 return <div className="rv-wsr-loading"><p role="status" className="rv-wsr-loading-line"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false"><path d="M8 2a6 6 0 1 1-6 6" /></svg>{children}</p>
  <div aria-hidden="true" className="rv-wsr-skeleton-rows"><span className="rv-skeleton" /><span className="rv-skeleton" /><span className="rv-skeleton" /></div></div>;
}

export { VisibleText };
