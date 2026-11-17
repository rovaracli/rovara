import { useQueryClient } from "@tanstack/react-query";
import { useAppHost } from "../../host.js";
import { createRealtimeClient } from "../../realtime/client.js";
import { createNoticeInvalidator } from "../../realtime/invalidate.js";
import { Suspense, lazy, useEffect, useRef } from "react";
import { useHome } from "../../api/home.js";
import { ApiError } from "../../api/errors.js";
import { useAnnounce } from "../../design/Announcer.js";
import { Button } from "../../design/Button.js";
import { PageHeader } from "../../design/PageHeader.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import { HomeCard } from "./HomeCard.js";
// Decision cards load after the first paint: they bring the cards, the tabs and their contracts, which no other first-page view needs.
const NeedsYou = lazy(async () => ({ default: (await import("./NeedsYou.js")).NeedsYou }));
// The empty state is in the same lazy chunk: it must know whether decision cards wait, and reading them would bring their contracts into the first page.
const NothingNeedsYou = lazy(async () => ({ default: (await import("./NeedsYou.js")).NothingNeedsYou }));
// The tasks the person was added to load after the first paint too (web task channel K4).
const InvolvedHome = lazy(async () => ({ default: (await import("./InvolvedHome.js")).InvolvedHome }));
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
 return <section className="rv-home" data-testid="home"><PageHeader title="Home" {...(cards !== undefined && total > 0 ? { description: `${total} ${total === 1 ? "thing needs" : "things need"} you` } : {})} />
 <Suspense fallback={null}><NeedsYou /></Suspense>
 {home.isPending && <Skeleton label="Loading what needs you" />}
 {home.isError && <div className="rv-home-error" role="alert" data-testid="load-error"><p><VisibleText text={home.error instanceof ApiError ? home.error.message : "Couldn't load what needs you. Try again."} /></p><Button onClick={() => { void home.refetch(); }}>Try again</Button></div>}
 {cards !== undefined && cards.length === 0 && total === 0 && <Suspense fallback={null}><NothingNeedsYou /></Suspense>}
 {cards !== undefined && cards.length === 0 && total > 0 && <div><p>Items are temporarily unavailable.</p><Button onClick={() => { void home.refetch(); }}>Try again</Button></div>}
 {cards !== undefined && total > cards.length && <p className="rv-muted">Showing {cards.length} of {total}</p>}
 {cards !== undefined && cards.length > 0 && <ol className="rv-attention-list" aria-label="What needs you">{cards.map(card => <HomeCard key={card.cardId} card={card} />)}</ol>}
 {ready && <Suspense fallback={null}><InvolvedHome /></Suspense>}
 </section>;
}
