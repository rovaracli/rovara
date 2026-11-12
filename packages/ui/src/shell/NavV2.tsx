import { useEffect, useId, useRef } from "react";
import { Link, NavLink, useLocation } from "react-router";
import type { ReadAppNav } from "@agentx/cloud-contracts/web";
import { useAppHost } from "../host.js";
import { paths } from "../paths.js";
import { VisibleText } from "../design/VisibleText.js";
import { canOpenCompanySettings, currentDestination, destinationsFor, type Destination } from "./destinations.js";
import { NavIcon } from "./nav-icons.js";
import { useInsightsNavVisible } from "../api/insights-nav.js";
/** The sidebar lists this many of the person's projects as plain links; the Projects page lists them all. */
export const SIDEBAR_PROJECT_LIMIT = 8;
/** "Home, 3 need you": the count is part of the link's name, because the visible number is hidden from screen readers. */
function destinationName(destination: Destination): string | undefined {
 const count = destination.count ?? 0;
 return destination.id === "home" && count > 0 ? `Home, ${String(count)} ${count === 1 ? "needs" : "need"} you` : undefined;
}
function DestinationLink({ destination, current, onNavigate }: { destination: Destination; current: boolean; onNavigate?: (() => void) | undefined }) {
 const count = destination.count ?? 0;
 return <Link to={destination.to} aria-label={destinationName(destination)} aria-current={current ? "page" : undefined} onClick={onNavigate}><span className="rv-nav-label"><NavIcon id={destination.id} />{destination.label}</span>{count > 0 && <span className="rv-nav-count" aria-hidden="true">{count}</span>}</Link>;
}
/** The new navigation's sidebar (also the phone's Menu): the destinations once, the person's projects as plain links (no agents under them), shared work, and the older tools that have no destination yet. */
export function SidebarV2({ nav, onNavigate }: { nav: ReadAppNav; onNavigate?: () => void }) {
 const projectsHeading = useId(), sharedHeading = useId(), host = useAppHost(), current = currentDestination(useLocation().pathname), insights = useInsightsNavVisible(nav.me.developerId, nav.insights);
 const shown = nav.projects.slice(0, SIDEBAR_PROJECT_LIMIT), hidden = nav.projects.length - shown.length;
 return <nav aria-label="Workspace" className="rv-sidebar-nav rv-sidebar-nav-v2"><div className="rv-sidebar-primary">{destinationsFor(nav, { insights }).map(destination => <DestinationLink key={destination.id} destination={destination} current={current === destination.id} onNavigate={onNavigate} />)}</div>
 <section aria-labelledby={projectsHeading}><h2 id={projectsHeading}>My projects</h2>{shown.map(project => <NavLink key={project.name} to={paths.project(project.name)} onClick={onNavigate}><VisibleText text={project.name} /></NavLink>)}{hidden > 0 && <Link to={paths.projects} onClick={onNavigate}>{`See all ${String(nav.projects.length)} projects`}</Link>}{nav.projects.length === 0 && <p className="rv-nav-hint">Your projects appear here.</p>}</section>
 <section aria-labelledby={sharedHeading}><h2 id={sharedHeading}>Shared with me</h2>{nav.shared.agents.map(agent => <NavLink key={agent.agentId} to={paths.agent(agent.agentId)} onClick={onNavigate}><VisibleText text={agent.name} /></NavLink>)}{nav.shared.sessions.map(session => <NavLink key={session.sessionId} to={paths.session(session.sessionId)} onClick={onNavigate}><VisibleText text={session.title} /></NavLink>)}{nav.shared.agents.length + nav.shared.sessions.length === 0 && <p className="rv-nav-hint">Shared work appears here.</p>}</section>
 <div className="rv-sidebar-secondary">{host.kind === "web" && canOpenCompanySettings(nav) && <NavLink to="/app/admin/waiting" onClick={onNavigate}>Waiting for people</NavLink>}<NavLink to={paths.onboard} onClick={onNavigate}>Onboard a project</NavLink>{host.kind === "web" && nav.features.scriptTokens === true && <NavLink to="/app/settings/script-tokens" onClick={onNavigate}>Script tokens</NavLink>}{nav.features.usage && <NavLink to={paths.usage} onClick={onNavigate}>Usage</NavLink>}</div></nav>;
}
/** The room kept between a focused control and the tab bar (shell.css keeps the same 16px as scroll padding). */
const TABBAR_FOCUS_GAP = 16;
/**
 * WCAG 2.4.11: a control that takes focus is never left under the tab bar. shell.css's scroll padding does this where the browser applies scroll padding to a
 * focus scroll (Chromium); WebKit, and Firefox for some controls, do not, and stop scrolling once the control is in the viewport, under the bar. So, as focus
 * arrives (focusin runs before the browser's own scroll), the page is scrolled just enough for the control to end above the bar; the browser's scroll then
 * has nothing to do. A control taller than the room keeps its top in view. Nothing happens while the bar is hidden (above the phone line).
 */
export function keepFocusAboveTabBar(bar: HTMLElement, target: EventTarget | null, view: Pick<Window, "scrollBy"> = window): void {
 if (!(target instanceof HTMLElement) || bar.contains(target) || bar.getClientRects().length === 0) return;
 const limit = bar.getBoundingClientRect().top - TABBAR_FOCUS_GAP, box = target.getBoundingClientRect();
 if (box.height === 0 || box.bottom <= limit) return;
 const by = Math.min(box.bottom - limit, box.top);
 if (by > 0) view.scrollBy({ top: by, behavior: "instant" });
}
/** The phone's bottom tab bar: the same destinations, icon plus label, 44px targets (shell.css). Hidden above the phone line. */
export function TabBar({ nav }: { nav: ReadAppNav }) {
 const current = currentDestination(useLocation().pathname), bar = useRef<HTMLElement>(null);
 useEffect(() => {
  const onFocus = (event: FocusEvent) => { if (bar.current !== null) keepFocusAboveTabBar(bar.current, event.target); };
  document.addEventListener("focusin", onFocus);
  return () => { document.removeEventListener("focusin", onFocus); };
 }, []);
 return <nav ref={bar} aria-label="Main destinations" className="rv-tabbar">{destinationsFor(nav).map(destination => <DestinationLink key={destination.id} destination={destination} current={current === destination.id} />)}</nav>;
}
