import { useCallback, useRef, useSyncExternalStore } from "react";
import { useQueryClient, type QueryCacheNotifyEvent } from "@tanstack/react-query";

/**
 * Read ORDER for the Merge section (SCREEN-STATE-RULES R6b). A read is ordered by when it was ISSUED, never by when its answer arrived or by a timestamp the server put in it (another clock).
 *
 * The stamp source cannot go backwards across tabs. One shared counter key cannot promise that (a tab that read it, paused, and wrote a stale value would roll it back), so every tab writes ONLY its own key
 * (`rovara.merge.stamp.v2:<writer id>`, a value only it ever writes, so no rollback is possible) and a stamp is `n * 1024 + slot`, with `n` one more than the highest `n` any tab has persisted (seeded from the clock) and `slot` a
 * random 10 bits that breaks ties between tabs. After writing its value a tab READS EVERY KEY BACK; if any other tab's value is not below its own it recomputes above it and writes again, and only returns once every other
 * persisted value is lower. So: any stamp persisted before a tab's check finishes is seen by the check and ends up lower; any stamp persisted after it sees this one in its own check and ends up higher. A later stamp is never
 * lower than one already persisted (given the browser's same-origin storage reads what other tabs have written). Keys of closed tabs are pruned after a week. If storage is blocked the source is per-tab memory only.
 */
const PREFIX = "rovara.merge.stamp.v2:", SLOTS = 1024, WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export interface StampStorage { length: number; key(index: number): string | null; getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

export function createStampSource(storage: () => StampStorage | undefined, clock: () => number = Date.now, random: () => number = Math.random): () => number {
 const writer = clock().toString(36) + Math.floor(random() * 2 ** 40).toString(36), ownKey = PREFIX + writer, slot = Math.floor(random() * SLOTS);
 let own = 0;
 /** The highest stamp persisted by any OTHER tab (or including this one's), ignoring anything that does not read as a stamp; stale keys of closed tabs are pruned. */
 function highest(store: StampStorage, includeOwn: boolean): number {
  let top = 0;
  const keys: string[] = [];
  for (let i = 0; i < store.length; i += 1) { const key = store.key(i); if (key !== null && key.startsWith(PREFIX)) keys.push(key); }
  for (const key of keys) {
   if (key === ownKey && !includeOwn) continue;
   const value = Number(store.getItem(key));
   if (!Number.isSafeInteger(value) || value <= 0) continue;
   if (key !== ownKey && value / SLOTS < clock() - WEEK_MS) { try { store.removeItem(key); } catch { /* stays */ } continue; }
   if (value > top) top = value;
  }
  return top;
 }
 return () => {
  let store: StampStorage | undefined;
  try { store = storage(); } catch { store = undefined; }
  for (let attempt = 0; attempt < 50; attempt += 1) {
   let seen = own;
   try { if (store !== undefined) seen = Math.max(seen, highest(store, true)); } catch { store = undefined; }
   const candidate = Math.max(Math.floor(seen / SLOTS) + 1, clock()) * SLOTS + slot;
   own = candidate;
   if (store === undefined) return candidate;
   try { store.setItem(ownKey, String(candidate)); } catch { return candidate; }
   // Read every other tab's value back: return only once all of them are lower than this stamp.
   try { if (highest(store, false) < candidate) return candidate; } catch { return candidate; }
  }
  return own;
 };
}
export const nextStamp = createStampSource(() => globalThis.localStorage);

/**
 * The issue stamp of the latest task read this page has seen COMPLETE. The task read belongs to the session screen, so it is observed from the query cache: a fetch of ["session", id] being issued takes a stamp,
 * and its success makes that stamp the latest. Data that arrived before this page was watching, or that was written without a fetch (a presence update), keeps the older stamp (0 if none): unknown order counts as
 * old, never as new, so it can never resolve or contradict anything.
 */
export function useLatestTaskReadStamp(sessionId: string): number {
 const client = useQueryClient(), book = useRef<{ latest: number; inflight: number | undefined }>({ latest: 0, inflight: undefined });
 const subscribe = useCallback((notify: () => void) => client.getQueryCache().subscribe((event: QueryCacheNotifyEvent) => {
  const key = event.query.queryKey as readonly unknown[];
  if (event.type !== "updated" || key.length !== 2 || key[0] !== "session" || key[1] !== sessionId) return;
  const action = event.action;
  if (action.type === "fetch") book.current.inflight ??= nextStamp();
  // A manual cache write (setQueryData: the presence heartbeat) is NOT a completed task read: it neither consumes the in-flight fetch's stamp nor promotes cached facts.
  else if (action.type === "success" && action.manual !== true) { if (book.current.inflight !== undefined) { book.current.latest = Math.max(book.current.latest, book.current.inflight); notify(); } book.current.inflight = undefined; }
  else if (action.type === "error") book.current.inflight = undefined;
 }), [client, sessionId]);
 return useSyncExternalStore(subscribe, () => book.current.latest, () => 0);
}
