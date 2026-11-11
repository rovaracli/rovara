import { useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { SessionListReaderSchema } from "@agentx/contracts/web";
import { useAppHost } from "../host.js";
import { createApiClient } from "./client.js";
import { mergeLiveTiles, useLive, type LiveFilter } from "./live.js";
export type ReadFinishedPage = ReturnType<typeof SessionListReaderSchema.parse>;
export type ReadFinishedTile = ReadFinishedPage["sessions"][number];

/** Finished work: the ended sessions of one project (everyone's, as far as the reader may see them), or with no project the reader's own. `GET /v1/app/sessions?owner=me|project=<p>&status=ended`; the broker answers newest first. */
export function useFinishedWork(project: string | undefined, enabled: boolean) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 return useInfiniteQuery({ queryKey: ["work-finished", project], enabled, initialPageParam: undefined as string | undefined,
  queryFn: ({ pageParam }) => {
   const params = new URLSearchParams(project === undefined ? { owner: "me" } : { project });params.set("status", "ended");if (pageParam !== undefined) params.set("cursor", pageParam);
   return api.get("/v1/app/sessions?" + params.toString(), SessionListReaderSchema);
  }, getNextPageParam: (page, _pages, previous) => page.next === previous ? undefined : page.next });
}
const byId = <T extends { sessionId: string }>(items: readonly T[]): T[] => [...new Map(items.map(item => [item.sessionId, item])).values()];

/**
 * What the Work list reads: today's Live filters (two of them for Needs attention, merged by session) or, when `finishedOn`, the finished list. Only the queries that are asked for run.
 * `filters` is at most two long: the first is any Live filter, the second is read only when there are two.
 */
export function useWorkList(filters: readonly LiveFilter[], finishedOn: boolean, project: string | undefined) {
 const first = useLive(filters[0] ?? "mine", project, { enabled: !finishedOn && filters.length > 0 }), second = useLive(filters[1] ?? "failed", project, { enabled: !finishedOn && filters.length > 1 }), finished = useFinishedWork(project, finishedOn);
 const queries = finishedOn ? [finished] : filters.length > 1 ? [first, second] : [first];
 const failed = queries.find(query => query.isError), hasFailed = failed !== undefined, ready = !hasFailed && queries.every(query => query.data !== undefined);
 const live = useMemo(() => {
  if (finishedOn || hasFailed) return undefined;
  const pages = [first, ...(filters.length > 1 ? [second] : [])].map(query => query.data?.pages);
  return pages.some(list => list === undefined) ? undefined : mergeLiveTiles(pages.flatMap(list => list ?? []));
 }, [finishedOn, hasFailed, filters.length, first.data, second.data]); // eslint-disable-line react-hooks/exhaustive-deps -- `first` and `second` are new objects every render; their data is what matters
 const done = useMemo(() => finishedOn && !hasFailed && finished.data !== undefined ? byId(finished.data.pages.flatMap(page => page.sessions)) : undefined, [finishedOn, hasFailed, finished.data]);
 return {
  live, finished: done, ready, isPending: !ready && !hasFailed, isError: hasFailed, error: failed?.error,
  hasNextPage: !hasFailed && queries.some(query => query.hasNextPage), isFetchingNextPage: queries.some(query => query.isFetchingNextPage),
  refetch: () => Promise.all(queries.map(query => query.refetch())), fetchNextPage: () => Promise.all(queries.filter(query => query.hasNextPage).map(query => query.fetchNextPage())),
 };
}
