import { Link } from "react-router";
import type { ReadAgentProfile } from "../../api/agents.js";
import { publicationOf, useAgentPublishRequests, usePublishRequests, type ReadPublishRequest } from "../../api/agent-publish.js";
import { paths } from "../../paths.js";
import { VisibleText } from "../../design/VisibleText.js";
import { agentAllows } from "./agent-access.js";
import AskToPublish, { canAskToPublish } from "./AskToPublish.js";
import { STALE_LINE, publicationLine, targetKey, waitingLine } from "./publish-words.js";
import "./publish.css";

/**
 * The profile's "Who can use it" section: who the agent is published to, a waiting request in plain words (with a way in for the person who decides it), the sentence for a request that went out of date with
 * an Ask again, and the Ask to publish button. An older server that sends no `publication` shows only the button.
 */
export default function ProfilePublishing({ profile, initialAsk, initialTarget }: { profile: ReadAgentProfile; initialAsk: boolean; initialTarget: string | undefined }) {
 const agent = profile.agent, publication = publicationOf(agent), manage = !agent.builtin && agentAllows(agent, "manage");
 const mine = useAgentPublishRequests(agent.agentId, manage && publication !== undefined);
 const waiting = usePublishRequests({ state: "pending" }, publication?.pending != null);
 const list: ReadPublishRequest[] = mine.isError ? [] : mine.data?.requests ?? [];
 const pendingId = publication?.pending?.requestId, pendingRequest = list.find(request => request.requestId === pendingId) ?? list.find(request => request.state === "pending");
 const stale = pendingRequest === undefined && publication?.pending == null ? [...list].filter(request => request.state === "stale").sort((a, b) => Date.parse(b.requestedAt) - Date.parse(a.requestedAt))[0] : undefined;
 const decidable = waiting.isError ? undefined : waiting.data?.pages.flatMap(page => page.requests).find(request => request.requestId === pendingId && request.approval.canDecide);
 const canAsk = canAskToPublish(profile);
 if (agent.builtin || (publication === undefined && !canAsk)) return null;
 return <section className="rv-agent-section rv-pub-profile" aria-labelledby="rv-pub-heading">
  <h2 id="rv-pub-heading">Who can use it</h2>
  {publication !== undefined && <p>Published to: <strong><VisibleText text={publicationLine(publication)} /></strong></p>}
  {publication?.pending != null && <>
   <p role="status"><VisibleText text={waitingLine(publication.pending.target)} />.</p>
   {pendingRequest !== undefined && <>{pendingRequest.note !== null && pendingRequest.note !== "" && <p className="rv-pub-note">“<VisibleText text={pendingRequest.note} />”</p>}<p><VisibleText text={pendingRequest.effect} /></p></>}
   {decidable !== undefined && <p><Link className="rv-button rv-button-primary" to={paths.agentRequests}>Review and decide</Link></p>}
  </>}
  {stale !== undefined && targetKey(stale.target) !== undefined && <p>{STALE_LINE} <Link className="rv-button" to={paths.agent(agent.agentId) + "?publish=1&to=" + encodeURIComponent(targetKey(stale.target) ?? "")}>Ask again</Link></p>}
  <div className="rv-actions"><AskToPublish key={initialAsk ? "ask:" + (initialTarget ?? "") : "idle"} profile={profile} initialOpen={initialAsk} initialTarget={initialTarget} /><Link className="rv-button rv-button-quiet" to={paths.agentRequests}>Publish requests</Link></div>
 </section>;
}
