import { useMemo } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { AppNavReaderSchema } from "@agentx/contracts/web";
import { createApiClient } from "../../api/client.js";
import { useAppHost } from "../../host.js";
import { paths } from "../../paths.js";
import { VisibleText } from "../../design/VisibleText.js";
import { ToneDot, type StatusTone } from "../../design/StatusDot.js";

/**
 * A slim row above the work list (DEC 223b): the agents of the person's projects and what each is doing now, one chip each (name, status, a link to the agent).
 * It reads the same navigation answer the sidebar reads. While Rovara Code does not serve agents the answer has none, and the row says so.
 */
export function AgentsRow() {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 const nav = useQuery({ queryKey: ["nav"], queryFn: () => api.get("/v1/app/nav", AppNavReaderSchema) });
 if (nav.data === undefined) return null;
 const agents = nav.data.projects.flatMap(project => project.agents.map(agent => ({ ...agent, project: project.name })));
 if (agents.length === 0) return null;
 return <section className="rv-agents-row" aria-label="Agents">
   <ul>{agents.map(agent => {
    const tone: StatusTone = agent.needsYou > 0 ? "wait" : agent.running > 0 ? "run" : "idle", words = agent.needsYou > 0 ? "needs you" : agent.running > 0 ? `${agent.running} running` : "idle";
    return <li key={agent.agentId}><Link className="rv-agent-chip" to={paths.agent(agent.agentId)}><ToneDot tone={tone} words={words} /><b><VisibleText text={agent.name} /></b><span className="rv-muted">{words}</span></Link></li>;
   })}</ul>
 </section>;
}
