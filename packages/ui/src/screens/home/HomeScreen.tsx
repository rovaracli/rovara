import { useQueryClient } from "@tanstack/react-query";
import { useAppHost } from "../../host.js";
import { createRealtimeClient } from "../../realtime/client.js";
import { createNoticeInvalidator } from "../../realtime/invalidate.js";
import { Suspense, lazy, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
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
import { isNewHomeOn } from "./home-flags.js";
import { workPlace } from "../../nav-flags.js";
import type { ReadDecision } from "../../api/decisions.js";
// Decision cards load after the first paint: they bring the cards, the tabs and their contracts, which no other first-page view needs.
const NeedsYou = lazy(async () => ({ default: (await import("./NeedsYou.js")).NeedsYou }));
// UX2 slice 2 item 7: the start box loads after the first paint too (it brings the project page's start form).
const HomeStart = lazy(async () => ({ default: (await import("./HomeStart.js")).HomeStart }));
// The new Home (exp/home) loads only where its switch is on: a person with the switch off downloads nothing of it.
const HomeV2 = lazy(async () => ({ default: (await import("./HomeV2.js")).HomeV2 }));
import "./home.css";
const DECISIONS_KEY = ["decisions"] as const;
export function HomeScreen() {
 const host = useAppHost(), place = workPlace(host), [newHome] = useState(() => isNewHomeOn(host)), query = useQueryClient(), home = useHome(), announce = useAnnounce(), previous = useRef<Array<{ cardId: string; title: string }> | undefined>(undefined);
 // The decision cards Needs you loaded, read from the cache (never fetched here, and no query options are set here, so Needs you's own read is untouched): an older card whose decision a pending card holds is not shown twice.
 // Only a read that succeeded and has no error since counts: a failed or stale-with-error read hides nothing (every older card shows).
 const decisions = useSyncExternalStore(useCallback((changed: () => void) => query.getQueryCache().subscribe(changed), [query]), () => {
  const state = query.getQueryState<ReadDecision[]>(DECISIONS_KEY);
  return state?.status === "success" && state.error === null ? state.data : undefined;
 });
 const cards = home.isError ? undefined : home.data?.cards, ready = cards !== undefined;
 const shown = cards === undefined ? undefined : withoutDecided(cards, decisions), total = Math.max(0, (home.data?.total ?? 0) - (cards?.length ?? 0) + (shown?.length ?? 0));
 // UX2 slice 2: the ONE "needs you" count, the server's (its cards and the pending decision cards, counted once; the sidebar shows the same number). An older server has none: the cards shown here count.
 const pendingCards = decisions?.filter(decision => decision.card.status === "pending").length ?? 0, needsYou = typeof home.data?.needsYou === "number" ? home.data.needsYou : total + pendingCards;
 useEffect(() => { if (!ready) return;const invalidator = createNoticeInvalidator(query), realtime = createRealtimeClient(host, { onNotice: notice => invalidator.notice(notice), onStatus: () => undefined, onReset: () => invalidator.reset() });realtime.start();return () => { realtime.stop();invalidator.stop(); }; }, [host, query, ready]);
 useEffect(() => {
 if (cards === undefined) return;
 for (const card of previous.current ?? []) if (!cards.some(next => next.cardId === card.cardId)) announce(card.title + " no longer needs you");
 previous.current = cards;
 }, [cards, announce]);
 if (newHome) return <Suspense fallback={<section className="rv-home"><PageHeader title="Home" /><Skeleton label="Loading Home" /></section>}><HomeV2 home={home} shown={shown} total={total} needsYou={needsYou} unavailable={cards !== undefined && cards.length === 0 && total > 0} /></Suspense>;
 return <section className="rv-home"><PageHeader title="Home" {...(shown !== undefined && needsYou > 0 ? { description: `${needsYou} ${needsYou === 1 ? "thing needs" : "things need"} you` } : {})} />
 <Suspense fallback={null}><HomeStart /></Suspense>
 <Suspense fallback={null}><NeedsYou /></Suspense>
 {home.isPending && <Skeleton label="Loading what needs you" />}
 {home.isError && <div className="rv-home-error" role="alert"><p><VisibleText text={home.error instanceof ApiError ? home.error.message : "Couldn't load what needs you. Try again."} /></p><Button onClick={() => { void home.refetch(); }}>Try again</Button></div>}
 {shown !== undefined && shown.length === 0 && total === 0 && needsYou === 0 && decisions?.some(decision => decision.card.status === "pending") !== true && <EmptyState title="Nothing needs you right now" description={`Your team's work can keep moving. Find ongoing sessions in ${place.name}.`} action={<Link to={place.path}>See work in progress</Link>} />}
 {cards !== undefined && cards.length === 0 && total > 0 && <div><p>Items are temporarily unavailable.</p><Button onClick={() => { void home.refetch(); }}>Try again</Button></div>}
 {shown !== undefined && total > shown.length && <p className="rv-muted">Showing {shown.length} of {total}</p>}
 {shown !== undefined && shown.length > 0 && <ol className="rv-attention-list" aria-label="What needs you">{shown.map(card => <HomeCard key={card.cardId} card={card} />)}</ol>}
 </section>;
}
