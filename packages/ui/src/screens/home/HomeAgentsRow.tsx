import type { ReactNode } from "react";
import { Link } from "react-router";
import { useMyAgents, type ReadAgentCard } from "../../api/agent-publish.js";
import { paths } from "../../paths.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import { dedupeSuggested, reasonLabel } from "../agents/publish-words.js";
import "../agents/publish.css";

/** The new Home's agents row shows at most this many favourites and this many suggested agents (the directory has the rest). */
export const HOME_FAVOURITES_MAX = 4, HOME_SUGGESTED_MAX = 4;

function Group({ title, cards, label, reasons }: { title: string; cards: readonly ReadAgentCard[]; label: string; reasons: boolean }) {
 return <><h3 className="rv-pub-home-sub">{title}</h3><ul className="rv-hv2-agent-list" aria-label={label}>{cards.map(card => <li key={card.agentId}><Link className="rv-hv2-agent" to={paths.agent(card.agentId)}><span className="rv-hv2-agent-name"><VisibleText text={card.name} /></span><span className="rv-hv2-agent-note"><VisibleText text={(reasons ? reasonLabel(card.reason) : undefined) ?? card.description} /></span></Link></li>)}</ul></>;
}

/**
 * The agents row of the new Home when the publishing switch is on: the person's favourites, then the agents the server suggests, each with the plain reason it is there. It replaces "recently used, then the directory".
 * The row is empty-safe (the server's starter agents fill it for someone with nothing), and when the server cannot answer yet (an older server) it shows `fallback`, today's row.
 */
export default function HomeAgentsRow({ fallback }: { fallback: ReactNode }) {
 const read = useMyAgents();
 if (read.isPending) return <Skeleton label="Loading agents" />;
 if (read.isError) return <>{fallback}</>;
 const favourites = read.data.favourites.slice(0, HOME_FAVOURITES_MAX), suggested = dedupeSuggested(read.data.favourites, read.data.suggested).slice(0, HOME_SUGGESTED_MAX);
 if (favourites.length === 0 && suggested.length === 0) return <p className="rv-hv2-empty">No agents are available yet.</p>;
 return <>
  {favourites.length > 0 && <Group title="Your favourites" cards={favourites} label="Favourite agents" reasons={false} />}
  {suggested.length > 0 && <Group title="Suggested for you" cards={suggested} label="Suggested agents" reasons />}
 </>;
}
