/// <reference types="vite/client" />
import { useEffect, useRef, type ReactNode } from "react";
import { VisibleText, visibleText } from "./VisibleText.js";
import { StatusPill, type StatusTone } from "./StatusDot.js";
import "./parts/shell-gallery.css";
// Same presentation vocabulary as P1; 9d can replace this structural type with
// StatusChipProps when that part lands. No Code observation is inferred here.
type HeaderStatus = { state: "queued" | "setting_up" | "needs_you" | "running" | "checking" | "ready_to_merge" | "done" | "merged" | "stopped" | "failed" | "blocked" | "could_not_run" | "not_run" | "unknown" } | { state: "waiting_for"; waitingFor: string };
const statusModules = import.meta.glob<{ StatusChip: (props: HeaderStatus) => ReactNode }>("./StatusChip.{js,tsx}", { eager: true });
const HeaderChip = Object.values(statusModules)[0]?.StatusChip;
const statuses: Record<string, readonly [string, StatusTone]> = {
 queued: ["Queued", "idle"], setting_up: ["Setting up", "run"], needs_you: ["Needs you", "wait"], running: ["Running", "run"], checking: ["Checking", "run"], ready_to_merge: ["Ready to merge", "ok"], done: ["Done", "ok"], merged: ["Merged", "ok"], stopped: ["Stopped", "idle"], failed: ["Failed", "bad"], blocked: ["Blocked", "bad"], could_not_run: ["Could not run", "idle"], not_run: ["Not run", "idle"], unknown: ["Unknown", "idle"],
};
export function PageHeader({ title, description, actions, focusOnMount = false, breadcrumbs, status, meta }: { title: string; description?: string; actions?: ReactNode; focusOnMount?: boolean; breadcrumbs?: readonly { label: string; href?: string }[]; status?: HeaderStatus; meta?: ReactNode }) {
 const heading = useRef<HTMLHeadingElement>(null);
 // Async pages opt in when their real heading replaces a loading screen; refetches never move focus.
 useEffect(() => { if (focusOnMount) heading.current?.focus(); }, [focusOnMount]);
 const entry = status?.state === "waiting_for" ? [`Waiting for ${status.waitingFor}`, "idle"] as const : statuses[status?.state ?? "unknown"] ?? statuses.unknown;
 return <header className="rv-page-header"><div>
  {breadcrumbs && breadcrumbs.length > 0 && <nav aria-label="Breadcrumb" className="rv-page-breadcrumbs"><ol>{breadcrumbs.map((crumb, index) => <li key={index}>{crumb.href ? <a href={crumb.href}><VisibleText text={crumb.label} /></a> : <span aria-current={index === breadcrumbs.length - 1 ? "page" : undefined}><VisibleText text={crumb.label} /></span>}</li>)}</ol></nav>}
  <h1 ref={heading} tabIndex={-1}><VisibleText text={title} /></h1>
  {(status || meta) && <div className="rv-page-meta">{status && entry && (HeaderChip ? <HeaderChip {...status} /> : <StatusPill tone={entry[1]} label={visibleText(entry[0])} />)}{meta && <span>{meta}</span>}</div>}
  {description && <p className="rv-muted"><VisibleText text={description} /></p>}
 </div>{actions && <div className="rv-actions">{actions}</div>}</header>;
}
