import { useEffect, useRef } from "react";
import { Link } from "react-router";
import { useHome } from "../../api/home.js";
import { ApiError } from "../../api/errors.js";
import { useAnnounce } from "../../design/Announcer.js";
import { Button } from "../../design/Button.js";
import { EmptyState } from "../../design/EmptyState.js";
import { PageHeader } from "../../design/PageHeader.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import { HomeCard } from "./HomeCard.js";
import "./home.css";
export function HomeScreen() {
 const home = useHome(), announce = useAnnounce(), previous = useRef<Array<{ cardId: string; title: string }> | undefined>(undefined);
 const cards = home.isError ? undefined : home.data?.cards;
 useEffect(() => {
 if (cards === undefined) return;
 for (const card of previous.current ?? []) if (!cards.some(next => next.cardId === card.cardId)) announce(card.title + " no longer needs you");
 previous.current = cards;
 }, [cards, announce]);
 return <section className="rv-home"><PageHeader title="Home" {...(cards !== undefined && cards.length > 0 ? { description: `${cards.length} ${cards.length === 1 ? "thing needs" : "things need"} you` } : {})} />
 {home.isPending && <Skeleton label="Loading what needs you" />}
 {home.isError && <div className="rv-home-error" role="alert"><p><VisibleText text={home.error instanceof ApiError ? home.error.message : "Couldn't load what needs you. Try again."} /></p><Button onClick={() => { void home.refetch(); }}>Try again</Button></div>}
 {cards !== undefined && cards.length === 0 && <EmptyState title="Nothing needs you right now" description="Your team's work can keep moving. Find ongoing sessions in Live." action={<Link to="/app/live">See work in progress</Link>} />}
 {cards !== undefined && cards.length > 0 && <ol className="rv-attention-list" aria-label="What needs you">{cards.map(card => <HomeCard key={card.cardId} card={card} />)}</ol>}
 </section>;
}
