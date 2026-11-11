import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ReadAppNav } from "@agentx/cloud-contracts/web";
import { useProject } from "../../api/projects.js";
import { VisibleText } from "../../design/VisibleText.js";
import { StartWorkBox } from "../project/StartWorkBox.js";

/**
 * UX2 slice 2 item 7: start a task from Home too. The person picks one of their projects (the sidebar's list, read from the cache: never fetched here) and the project's own start box shows, only where
 * the project page would show it (the broker's `canStartWork` for this person). The start route checks everything again.
 */
export function HomeStart() {
 // Read-only observer: no queryFn (not skipToken, a truthy value that a refetch would run if this observer set the query's options last), so the shell's own queryFn always runs.
 const nav = useQuery<ReadAppNav>({ queryKey: ["nav"], enabled: false }).data, field = useId();
 const projects = (nav?.projects ?? []).map(project => project.name);
 const [chosen, setChosen] = useState<string>();
 const project = chosen !== undefined && projects.includes(chosen) ? chosen : projects[0];
 const overview = useProject(project);
 if (project === undefined) return null;
 return <section className="rv-home-start" aria-label="Start a task">
  {projects.length > 1 && <div className="rv-field"><label htmlFor={field}>Project</label><select id={field} className="rv-input" value={project} onChange={event => setChosen(event.target.value)}>{projects.map(name => <option key={name} value={name}>{name}</option>)}</select></div>}
  {projects.length === 1 && <p className="rv-muted">Project: <VisibleText text={project} /></p>}
  {overview.data?.you.canStartWork === true && <StartWorkBox key={project} project={project} agents={overview.data.agents} />}
  {overview.data !== undefined && overview.data.you.canStartWork !== true && <p className="rv-muted">You can't start work in this project. Ask one of its maintainers.</p>}
 </section>;
}
