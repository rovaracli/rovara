import { useCallback, useRef, useSyncExternalStore } from "react";
import { useQueryClient, type QueryCacheNotifyEvent } from "@tanstack/react-query";

/**
 * Read ORDER for the Merge section (SCREEN-STATE-RULES R6b). A read is ordered by when it was ISSUED, never by when its answer arrived or by a timestamp the server put in it (another clock). `nextStamp()` is a strictly
 * increasing integer taken at issue time, kept in localStorage so it keeps increasing across reloads and tabs of one browser (and in memory if storage is blocked). The press carries the stamp of its own issue inside
 * its saved record, so a read issued before the press can never resolve it, void it or contradict it, however late that read's answer arrives.
 */
const KEY = "rovara.merge.stamp.v1";
let memory = 0;
export function nextStamp(): number {
 let last = memory;
 try { const raw = globalThis.localStorage.getItem(KEY), saved = raw === null ? 0 : Number(raw); if (Number.isSafeInteger(saved) && saved > last) last = saved; } catch { /* in-memory only */ }
 const next = Math.max(Date.now(), last + 1);
 memory = next;
 try { globalThis.localStorage.setItem(KEY, String(next)); } catch { /* in-memory only */ }
 return next;
}

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
  else if (action.type === "success") { if (book.current.inflight !== undefined) { book.current.latest = Math.max(book.current.latest, book.current.inflight); notify(); } book.current.inflight = undefined; }
  else if (action.type === "error") book.current.inflight = undefined;
 }), [client, sessionId]);
 return useSyncExternalStore(subscribe, () => book.current.latest, () => 0);
}
