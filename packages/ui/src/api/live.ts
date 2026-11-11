import { useMemo } from "react";
import { useInfiniteQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { LiveResponseReaderSchema, type LiveFilterSchema, type LiveTileReaderSchema } from "@agentx/cloud-contracts/web";
import { useAppHost } from "../host.js";
import { createApiClient } from "./client.js";
export type ReadLivePage = ReturnType<typeof LiveResponseReaderSchema.parse>;
export type ReadLiveTile = ReturnType<typeof LiveTileReaderSchema.parse>;
export type LiveFilter = ReturnType<typeof LiveFilterSchema.parse>;
export function mergeLiveTiles(pages: readonly ReadLivePage[]): ReadLiveTile[] { const byId = new Map<string, ReadLiveTile>();for (const tile of pages.flatMap(page => page.tiles)) { const old = byId.get(tile.sessionId);if (old === undefined || Date.parse(tile.updatedAt) >= Date.parse(old.updatedAt)) byId.set(tile.sessionId, tile); }return [...byId.values()]; }
export function acceptLivePage(previous: ReadLivePage | undefined, next: ReadLivePage): ReadLivePage {
 const old = new Map(previous?.tiles.map(tile => [tile.sessionId, tile]));
 return { ...next, tiles: next.tiles.map(tile => { const earlier = old.get(tile.sessionId);return earlier !== undefined && Date.parse(tile.updatedAt) < Date.parse(earlier.updatedAt) ? earlier : tile; }) };
}
export function useLive(filter: LiveFilter, project?: string, options: { enabled?: boolean } = {}) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]), query = useQueryClient(), key = ["live", filter, project];
 return useInfiniteQuery({ queryKey: key, enabled: options.enabled ?? true, initialPageParam: undefined as string | undefined, queryFn: async ({ pageParam }) => {
  const params = new URLSearchParams({ filter });if (project !== undefined) params.set("project", project);if (pageParam !== undefined) params.set("cursor", pageParam);
  const next = await api.get("/v1/app/live?" + params.toString(), LiveResponseReaderSchema);
  // Read the cache after awaiting: a newer response may have settled while this one was in flight.
  const previous = query.getQueryData<InfiniteData<ReadLivePage, string | undefined>>(key), index = previous?.pageParams.findIndex(cursor => cursor === pageParam) ?? -1;
  return acceptLivePage(index < 0 ? undefined : previous?.pages[index], next);
 }, getNextPageParam: (page, _pages, previous) => page.next === previous ? undefined : page.next });
}
