import { useQueryClient } from "@tanstack/react-query";
import { useAppHost } from "../../host.js";
import { createRealtimeClient } from "../../realtime/client.js";
import { createNoticeInvalidator } from "../../realtime/invalidate.js";
import { Suspense, lazy, useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useHome } from "../../api/home.js";
import { useAnnounce } from "../../design/Announcer.js";
import { PageHeader } from "../../design/PageHeader.js";
import { Skeleton } from "../../design/Skeleton.js";
import { withoutDecided } from "./one-card.js";
import type { ReadDecision } from "../../api/decisions.js";
// Home's sections (exp/home; the only Home since decision 125) load after the first paint: they bring the rows, the decision words and the start box, which no other first-page view needs.
const HomeV2 = lazy(async () => ({ default: (await import("./HomeV2.js")).HomeV2 }));
import "./home.css";
const DECISIONS_KEY = ["decisions"] as const;
export function HomeScreen() {
 const host = useAppHost(), query = useQueryClient(), home = useHome(), announce = useAnnounce(), previous = useRef<Array<{ cardId: string; title: string }> | undefined>(undefined);
 // The decision cards Home loaded (HomeV2 reads them), read from the cache (never fetched here, and no query options are set here, so that read is untouched): an older card whose decision a pending card holds is not shown twice.
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
 return <Suspense fallback={<section className="rv-home"><PageHeader title="Home" /><Skeleton label="Loading Home" /></section>}><HomeV2 home={home} shown={shown} total={total} needsYou={needsYou} unavailable={cards !== undefined && cards.length === 0 && total > 0} /></Suspense>;
}
