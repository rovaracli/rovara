import { Link } from "react-router";
import { AgentIdSchema } from "@agentx/contracts/web";
import { useMyAgents, usePublishRequests, type ReadAgentCard } from "../../api/agent-publish.js";
import { paths } from "../../paths.js";
import { VisibleText } from "../../design/VisibleText.js";
import FavouriteStar from "./FavouriteStar.js";
import { dedupeSuggested, reasonLabel } from "./publish-words.js";
import "./publish.css";

function CardList({ title, cards, label, showReason }: { title: string; cards: readonly ReadAgentCard[]; label: string; showReason: boolean }) {
 return <section className="rv-pub-col" aria-label={label}>
  <h2>{title}</h2>
  <ul className="rv-pub-agents" aria-label={label + " agents"}>{cards.map(card => {
   const reason = reasonLabel(card.reason);
   return <li key={card.agentId}><div>{AgentIdSchema.safeParse(card.agentId).success ? <Link to={paths.agent(card.agentId)}><VisibleText text={card.name} /></Link> : <VisibleText text={card.name} />}<p className="rv-muted"><VisibleText text={card.description} /></p>{(showReason || card.reason !== "favourite") && reason !== undefined && <p className="rv-pub-reason"><VisibleText text={reason} /></p>}</div><FavouriteStar agentId={card.agentId} name={card.name} /></li>;
  })}</ul>
 </section>;
}

/** Favourites and suggested agents side by side (decision 23), above the directory's own list. Says nothing at all when the server has neither, or cannot be read (an older server): the directory is then today's. */
export default function PublishDirectoryExtras({ project }: { project: string | undefined }) {
 const read = useMyAgents(project);
 if (read.isPending || read.isError) return null;
 const favourites = read.data.favourites, suggested = dedupeSuggested(favourites, read.data.suggested);
 if (favourites.length === 0 && suggested.length === 0) return null;
 return <div className="rv-pub-extras">
  {favourites.length > 0 && <CardList title="Your favourites" cards={favourites} label="Your favourites" showReason={false} />}
  {suggested.length > 0 && <CardList title="Suggested for you" cards={suggested} label="Suggested" showReason />}
 </div>;
}

/** The directory header's link to the requests page, with how many wait for this person to decide. */
export function PublishRequestsLink() {
 const read = usePublishRequests({ state: "pending" });
 const count = read.isError ? 0 : read.data?.pages.flatMap(page => page.requests).filter(request => request.state === "pending" && request.approval.canDecide).length ?? 0;
 return <Link className="rv-button" to={paths.agentRequests}>Publish requests{count > 0 && <span className="rv-pub-count" aria-label={`, ${String(count)} to decide`}>{count}</span>}</Link>;
}
