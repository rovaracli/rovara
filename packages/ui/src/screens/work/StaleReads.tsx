import { useSyncExternalStore } from "react";
import { notifyManager, useQueryClient } from "@tanstack/react-query";
import { isAccessEnded } from "../../api/served-read.js";
/** One last-success line for independent reads retained under DEC 254zzz324,
 * including the live action components' supplementary spec and lesson reads. */
export function StaleReads({ reads }: { reads: readonly { staleSince: number | undefined }[] }) {
 const cache = useQueryClient().getQueryCache();
 useSyncExternalStore(listener => cache.subscribe(notifyManager.batchCalls(listener)), () => cache.getAll().map(query => [query.queryHash, query.getObserversCount(), query.state.status, query.state.fetchFailureCount, query.state.errorUpdatedAt, query.state.dataUpdatedAt].join(":" )).join("|"), () => "");
 const times = reads.flatMap(read => read.staleSince === undefined ? [] : [read.staleSince]);
 for (const query of cache.getAll()) {
  const state = query.state;
  if (query.getObserversCount() > 0 && state.data !== undefined && (state.status === "error" || state.fetchFailureCount > 0) && !isAccessEnded(state.error) && !isAccessEnded(state.fetchFailureReason)) times.push(state.dataUpdatedAt);
 }
 return times.length === 0 ? null : <p role="status" className="rv-qp-note">Updated {new Date(Math.min(...times)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · Reconnecting</p>;
}
