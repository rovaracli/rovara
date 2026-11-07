import { useAppHost } from "../host.js";
import { useId, useMemo, useSyncExternalStore } from "react";
import { NavLink } from "react-router";
import type { ReadAppNav } from "@agentx/contracts/web";
import { paths } from "../paths.js";
import { VisibleText } from "../design/VisibleText.js";
import { StatusDot } from "../design/StatusDot.js";
export function Sidebar({ nav, onNavigate }: { nav: ReadAppNav; onNavigate?: () => void }) {
 const projectsHeading = useId(), sharedHeading = useId(), host = useAppHost();
 // Lane C: don't offer the desktop queue on an unsupported viewport.
 const viewport = useMemo(() => ({ subscribe: (listener: () => void) => host.viewport?.subscribe(listener) ?? (() => undefined), snapshot: () => (host.viewport?.width() ?? 0) >= 1024 }), [host]);
 const largeScreen = useSyncExternalStore(viewport.subscribe, viewport.snapshot, () => false);
 return <nav aria-label="Workspace" className="rv-sidebar-nav"><div className="rv-sidebar-primary"><NavLink to={paths.home} end aria-label={`Home, ${nav.homeCount} waiting`} onClick={onNavigate}>Home<span className="rv-nav-count" aria-hidden="true">{nav.homeCount > 0 ? nav.homeCount : ""}</span></NavLink><NavLink to={paths.live} onClick={onNavigate}>Live</NavLink></div>
 <section aria-labelledby={projectsHeading}><h2 id={projectsHeading}>My projects</h2>{nav.projects.map(project => <div key={project.name} className="rv-nav-project"><NavLink to={paths.project(project.name)} onClick={onNavigate}><VisibleText text={project.name} /></NavLink>{project.agents.map(agent => <NavLink key={agent.agentId} to={paths.agent(agent.agentId)} className="rv-nav-agent" onClick={onNavigate}><span><VisibleText text={agent.name} /></span><span className="rv-nav-agent-status">{agent.running > 0 && <StatusDot status="running" words={`${agent.running} running`} />}{agent.needsYou > 0 && <StatusDot status="needs_person" words={`${agent.needsYou} needs you`} />}</span></NavLink>)}</div>)}</section>
 <section aria-labelledby={sharedHeading}><h2 id={sharedHeading}>Shared with me</h2>{nav.shared.agents.map(agent => <NavLink key={agent.agentId} to={paths.agent(agent.agentId)} onClick={onNavigate}><VisibleText text={agent.name} /></NavLink>)}{nav.shared.sessions.map(session => <NavLink key={session.sessionId} to={paths.session(session.sessionId)} onClick={onNavigate}><VisibleText text={session.title} /></NavLink>)}{nav.shared.agents.length + nav.shared.sessions.length === 0 && <p className="rv-nav-hint">Shared work appears here.</p>}</section>
 <div className="rv-sidebar-secondary">{/* Lane C: this read-only queue adds no content authority. */}{host.kind === "web" && host.features.admin && largeScreen && <NavLink to="/app/admin/waiting" onClick={onNavigate}>Waiting for people</NavLink>}<NavLink to={paths.directory} onClick={onNavigate}>Agent directory</NavLink><NavLink to={paths.onboard} onClick={onNavigate}>Onboard a project</NavLink>{host.kind === "web" && nav.features.scriptTokens === true && <NavLink to="/app/settings/script-tokens" onClick={onNavigate}>Script tokens</NavLink>}{nav.features.usage && <NavLink to={paths.usage} onClick={onNavigate}>Usage</NavLink>}{nav.features.admin && (nav.me.orgRole === "owner" || nav.me.orgRole === "admin") && <NavLink to={paths.admin.home} onClick={onNavigate}>Admin</NavLink>}</div></nav>;
}
