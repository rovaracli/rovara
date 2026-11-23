import { Link } from "react-router";
import { AgentDirectoryResponseReaderSchema } from "@agentx/contracts/web";
import { VisibleText } from "../../design/VisibleText.js";
import { Fact, Facts, Foot, ReadFrom, Unknown } from "./parts.js";
import { ProjectFrame } from "./ProjectFrame.js";
import { ReadState } from "./ReadState.js";
import { useReadIdentity, useScopedRead } from "./read-model.js";

function Offered({ project }: { project: string }) {
 const offered = useScopedRead("/v1/app/agents?scope=all", AgentDirectoryResponseReaderSchema);
 return <ReadState query={offered} label="offered workflows">{(data, at) => {
  const shown = data.agents.filter(agent => agent.status === "active" && !agent.disabled);
  return <>
   <p className="g5-lede">An agent is a way of working that a task follows from request to result. These are the ones your company offers for <VisibleText text={project} />. <ReadFrom at={at} /></p>
   {shown.length === 0 ? <p className="g5-lede">No offered agents returned.</p> : <ul className="g5-opts">{shown.map(agent => <li className="g5-opt" key={agent.agentId}><div className="g5-opt-body"><strong><VisibleText text={agent.name} /></strong><p><VisibleText text={agent.description} /></p></div></li>)}</ul>}
  </>;
 }}</ReadState>;
}
/** `withStep`: the live Agents step (add agents) is drawn right under this frame by the page, as a sibling of the read, never inside it. */
export function SetupWorkflowsReadScreen({ project, withStep = false }: { project: string; withStep?: boolean }) {
 const { developer, org } = useReadIdentity();
 const companyAdmin = developer.orgRole === "owner" || developer.orgRole === "admin";
 return <ProjectFrame project={project}>
  <div className="g5-main g5-stack">
   <p className="g5-note" style={{ fontSize: "var(--rv-font-md)" }}><Link className="g5-crumb" to={`/app/projects/${encodeURIComponent(project)}`}>Setup</Link> / Agents for tasks</p>
   <section className="g5-card" aria-labelledby="g5-offered"><h2 id="g5-offered">Agents for tasks in <VisibleText text={project} /></h2>
    {companyAdmin ? <Offered project={project} /> : <p className="g5-unknown-line"><Unknown />The agent directory is available to company owners and admins.</p>}
    <Facts>
     <Fact label="Used in this project"><span className="g5-unknown-line"><Unknown />Which agents this project uses, and the default, can&apos;t be told yet.</span></Fact>
    </Facts>
   </section>
   <p className="g5-note"><Link className="g5-crumb" to={`/app/projects/${encodeURIComponent(project)}`}>Back to Setup</Link></p>
   <Foot><VisibleText text={org.name} />&apos;s owners decide which agents exist for the company. {withStep ? "The step below is where they are added." : "This page only shows them."}</Foot>
  </div>
 </ProjectFrame>;
}
