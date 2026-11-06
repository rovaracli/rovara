import { useQueryClient } from "@tanstack/react-query";
import { useAppHost } from "../../host.js";
import { createRealtimeClient } from "../../realtime/client.js";
import { createNoticeInvalidator } from "../../realtime/invalidate.js";
import { Suspense, lazy, useCallback, useEffect, useRef, useSyncExternalStore } from "react";
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
import { withoutDecided } from "./one-card.js";
import type { ReadDecision } from "../../api/decisions.js";
// Decision cards load after the first paint: they bring the cards, the tabs and their contracts, which no other first-page view needs.
const NeedsYou = lazy(async () => ({ default: (await import("./NeedsYou.js")).NeedsYou }));
import "./home.css";
const DECISIONS_KEY = ["decisions"] as const;
export function HomeScreen() {
 const host = useAppHost(), query = useQueryClient(), home = useHome(), announce = useAnnounce(), previous = useRef<Array<{ cardId: string; title: string }> | undefined>(undefined);
 // The decision cards Needs you loaded, read from the cache (never fetched here, and no query options are set here, so Needs you's own read is untouched): an older card whose decision a pending card holds is not shown twice.
 const decisions = useSyncExternalStore(useCallback((changed: () => void) => query.getQueryCache().subscribe(changed), [query]), () => query.getQueryData<ReadDecision[]>(DECISIONS_KEY));
 const cards = home.isError ? undefined : home.data?.cards, ready = cards !== undefined;
 const shown = cards === undefined ? undefined : withoutDecided(cards, decisions), total = Math.max(0, (home.data?.total ?? 0) - (cards?.length ?? 0) + (shown?.length ?? 0));
 useEffect(() => { if (!ready) return;const invalidator = createNoticeInvalidator(query), realtime = createRealtimeClient(host, { onNotice: notice => invalidator.notice(notice), onStatus: () => undefined, onReset: () => invalidator.reset() });realtime.start();return () => { realtime.stop();invalidator.stop(); }; }, [host, query, ready]);
 useEffect(() => {
 if (cards === undefined) return;
 for (const card of previous.current ?? []) if (!cards.some(next => next.cardId === card.cardId)) announce(card.title + " no longer needs you");
 previous.current = cards;
 }, [cards, announce]);
 return <section className="rv-home"><PageHeader title="Home" {...(shown !== undefined && total > 0 ? { description: `${total} ${total === 1 ? "thing needs" : "things need"} you` } : {})} />
 <Suspense fallback={null}><NeedsYou /></Suspense>
 {home.isPending && <Skeleton label="Loading what needs you" />}
 {home.isError && <div className="rv-home-error" role="alert"><p><VisibleText text={home.error instanceof ApiError ? home.error.message : "Couldn't load what needs you. Try again."} /></p><Button onClick={() => { void home.refetch(); }}>Try again</Button></div>}
 {shown !== undefined && shown.length === 0 && total === 0 && decisions?.some(decision => decision.card.status === "pending") !== true && <EmptyState title="Nothing needs you right now" description="Your team's work can keep moving. Find ongoing sessions in Live." action={<Link to="/app/live">See work in progress</Link>} />}
 {cards !== undefined && cards.length === 0 && total > 0 && <div><p>Items are temporarily unavailable.</p><Button onClick={() => { void home.refetch(); }}>Try again</Button></div>}
 {shown !== undefined && total > shown.length && <p className="rv-muted">Showing {shown.length} of {total}</p>}
 {shown !== undefined && shown.length > 0 && <ol className="rv-attention-list" aria-label="What needs you">{shown.map(card => <HomeCard key={card.cardId} card={card} />)}</ol>}
 </section>;
}
