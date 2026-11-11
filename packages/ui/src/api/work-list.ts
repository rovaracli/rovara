import { useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { SessionListReaderSchema } from "@agentx/contracts/web";
import { useAppHost } from "../host.js";
import { createApiClient } from "./client.js";
import { mergeLiveTiles, useLive, type LiveFilter } from "./live.js";
export type ReadFinishedPage = ReturnType<typeof SessionListReaderSchema.parse>;
export type ReadFinishedTile = ReadFinishedPage["sessions"][number];

/** Finished work (its key starts with "live", so a realtime notice that refreshes Live refreshes this list too): the ended sessions of one project (everyone's, as far as the reader may see them), or with no project the reader's own. `GET /v1/app/sessions?owner=me|project=<p>&status=ended`; the broker answers newest first. */
export function useFinishedWork(project: string | undefined, enabled: boolean) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 return useInfiniteQuery({ queryKey: ["live", "finished", project], enabled, initialPageParam: undefined as string | undefined,
  queryFn: ({ pageParam }) => {
   const params = new URLSearchParams(project === undefined ? { owner: "me" } : { project });params.set("status", "ended");if (pageParam !== undefined) params.set("cursor", pageParam);
   return api.get("/v1/app/sessions?" + params.toString(), SessionListReaderSchema);
  }, getNextPageParam: (page, _pages, previous) => page.next === previous ? undefined : page.next });
}
const byId = <T extends { sessionId: string }>(items: readonly T[]): T[] => [...new Map(items.map(item => [item.sessionId, item])).values()];

/**
 * What the Work list reads: today's Live filters (two of them for Needs attention, merged by session) or, when `finishedOn`, the finished list. Only the queries that are asked for run.
 * `filters` is at most two long: the first is any Live filter, the second is read only when there are two.
 * A query that failed shows nothing of its own (its cached rows may be ones the person can no longer see). With two queries, one failing does not blank the other: `partial` says some work did not load.
 */
export function useWorkList(filters: readonly LiveFilter[], finishedOn: boolean, project: string | undefined) {
 const first = useLive(filters[0] ?? "mine", project, { enabled: !finishedOn && filters.length > 0 }), second = useLive(filters[1] ?? "failed", project, { enabled: !finishedOn && filters.length > 1 }), finished = useFinishedWork(project, finishedOn);
 const queries = finishedOn ? [finished] : filters.length > 1 ? [first, second] : [first];
 const loaded = queries.filter(query => !query.isError && query.data !== undefined), failed = queries.find(query => query.isError), ready = loaded.length > 0;
 const firstPages = !first.isError ? first.data?.pages : undefined, secondPages = !second.isError ? second.data?.pages : undefined;
 const live = useMemo(() => {
  if (finishedOn) return undefined;
  const usable = [firstPages, ...(filters.length > 1 ? [secondPages] : [])].filter(list => list !== undefined);
  return usable.length === 0 ? undefined : mergeLiveTiles(usable.flat());
 }, [finishedOn, filters.length, firstPages, secondPages]);
 const finishedPages = !finished.isError ? finished.data?.pages : undefined;
 const done = useMemo(() => finishedOn && finishedPages !== undefined ? byId(finishedPages.flatMap(page => page.sessions)) : undefined, [finishedOn, finishedPages]);
 return {
  live, finished: done, ready, isPending: !ready && failed === undefined, isError: !ready && failed !== undefined, partial: ready && failed !== undefined, error: failed?.error,
  hasNextPage: loaded.some(query => query.hasNextPage), isFetchingNextPage: queries.some(query => query.isFetchingNextPage),
  refetch: () => Promise.all(queries.map(query => query.refetch())), fetchNextPage: () => Promise.all(loaded.filter(query => query.hasNextPage).map(query => query.fetchNextPage())),
 };
}
