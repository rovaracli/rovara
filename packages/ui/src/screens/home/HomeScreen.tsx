import { useQueryClient } from "@tanstack/react-query";
import { useAppHost } from "../../host.js";
import { createRealtimeClient } from "../../realtime/client.js";
import { createNoticeInvalidator } from "../../realtime/invalidate.js";
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
import { NeedsYou } from "./NeedsYou.js";
import "./home.css";
export function HomeScreen() {
 const host = useAppHost(), query = useQueryClient(), home = useHome(), announce = useAnnounce(), previous = useRef<Array<{ cardId: string; title: string }> | undefined>(undefined);
 const cards = home.isError ? undefined : home.data?.cards, total = home.data?.total ?? 0, ready = cards !== undefined;
 useEffect(() => { if (!ready) return;const invalidator = createNoticeInvalidator(query), realtime = createRealtimeClient(host, { onNotice: notice => invalidator.notice(notice), onStatus: () => undefined, onReset: () => invalidator.reset() });realtime.start();return () => { realtime.stop();invalidator.stop(); }; }, [host, query, ready]);
 useEffect(() => {
 if (cards === undefined) return;
 for (const card of previous.current ?? []) if (!cards.some(next => next.cardId === card.cardId)) announce(card.title + " no longer needs you");
 previous.current = cards;
 }, [cards, announce]);
 return <section className="rv-home"><PageHeader title="Home" {...(cards !== undefined && total > 0 ? { description: `${total} ${total === 1 ? "thing needs" : "things need"} you` } : {})} />
 <NeedsYou />
 {home.isPending && <Skeleton label="Loading what needs you" />}
 {home.isError && <div className="rv-home-error" role="alert"><p><VisibleText text={home.error instanceof ApiError ? home.error.message : "Couldn't load what needs you. Try again."} /></p><Button onClick={() => { void home.refetch(); }}>Try again</Button></div>}
 {cards !== undefined && cards.length === 0 && total === 0 && <EmptyState title="Nothing needs you right now" description="Your team's work can keep moving. Find ongoing sessions in Live." action={<Link to="/app/live">See work in progress</Link>} />}
 {cards !== undefined && cards.length === 0 && total > 0 && <div><p>Items are temporarily unavailable.</p><Button onClick={() => { void home.refetch(); }}>Try again</Button></div>}
 {cards !== undefined && total > cards.length && <p className="rv-muted">Showing {cards.length} of {total}</p>}
 {cards !== undefined && cards.length > 0 && <ol className="rv-attention-list" aria-label="What needs you">{cards.map(card => <HomeCard key={card.cardId} card={card} />)}</ol>}
 </section>;
}
