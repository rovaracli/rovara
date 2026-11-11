import { Link } from "react-router";
import { useNav } from "../../api/nav.js";
import { paths } from "../../paths.js";
import { PageHeader } from "../../design/PageHeader.js";
import { EmptyState } from "../../design/EmptyState.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import { PageError } from "../../shell/ErrorBoundary.js";
/** The new navigation's Projects destination: the person's projects, once each, as links to the project page. Counts come from the navigation answer (what needs the person, what is running); no agents are listed here. */
export function ProjectsListScreen() {
 const nav = useNav();
 if (nav.data === undefined) return nav.isPending ? <Skeleton label="Loading projects" /> : <PageError error={nav.error} reload={() => { void nav.refetch(); }} />;
 return <section><PageHeader title="Projects" description="The projects you are part of." />
 {nav.data.projects.length === 0 ? <EmptyState title="No projects yet" description="Projects you are part of will be listed here." action={<Link to={paths.onboard}>Onboard a project</Link>} /> : <ul className="rv-projects-list">{nav.data.projects.map(project => {
  const needsYou = project.agents.reduce((sum, agent) => sum + agent.needsYou, 0), running = project.agents.reduce((sum, agent) => sum + agent.running, 0);
  return <li key={project.name}><Link to={paths.project(project.name)}><span className="rv-projects-name"><VisibleText text={project.name} /></span><span className="rv-projects-counts rv-muted">{needsYou > 0 && <span>{needsYou} {needsYou === 1 ? "needs" : "need"} you</span>}{running > 0 && <span>{running} running</span>}</span></Link></li>;
 })}</ul>}</section>;
}
