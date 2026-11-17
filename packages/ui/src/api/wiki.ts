// The project Wiki tab's reads (lead 4 W5; Code's wiki read routes, W2, through Cloud). Code decides who may read; this client only asks. A refusal is shown in
// Cloud's fixed words (fixedWikiWords), never other text. Wiki text is untrusted data: every answer is read with a strict, bounded schema and drawn as plain text.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ProjectOverviewProjectSchema, WIKI_PAGE_ID_PATTERN, WIKI_SENTENCES, WikiIndexResponseSchema, WikiPageResponseSchema, WikiSourcesResponseSchema } from "@agentx/contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient } from "./client.js";
import { ApiError } from "./errors.js";

export type { WikiBlock, WikiIndexEntry, WikiIndexResponse, WikiLastBuild, WikiPageResponse, WikiShownClaim, WikiShownNote, WikiSourceState, WikiSourcesResponse } from "@agentx/contracts/web";

const base = (name: string) => "/v1/app/projects/" + encodeURIComponent(ProjectOverviewProjectSchema.shape.name.parse(name)) + "/wiki";
const pageId = (id: string): string => { if (!WIKI_PAGE_ID_PATTERN.test(id)) throw new ApiError(400, "CONFIG_INVALID", "the request is not valid"); return encodeURIComponent(id); };

export function createWikiApi(host: AppHost) {
 const api = createApiClient(host);
 return {
  index: (project: string) => api.get(base(project), WikiIndexResponseSchema),
  page: (project: string, id: string) => api.get(base(project) + "/pages/" + pageId(id), WikiPageResponseSchema),
  sources: (project: string, id: string) => api.get(base(project) + "/pages/" + pageId(id) + "/sources", WikiSourcesResponseSchema),
 };
}
export function useWikiApi() { const host = useAppHost(); return useMemo(() => createWikiApi(host), [host]); }
export const wikiKey = (project: string) => ["wiki", project] as const;

/** Cloud says the wiki is not on this Rovara's Code yet: the project page shows no Wiki tab at all. */
export const wikiAbsent = (error: unknown) => error instanceof ApiError && (error.code === "NOT_ON_CODE_YET" || error.status === 501);
/** A refusal's words when they are one of Cloud's fixed wiki sentences, else the fallback (never the server's other text). */
export function fixedWikiWords(error: unknown, fallback: string): string { return error instanceof ApiError && WIKI_SENTENCES.has(error.message) ? error.message : fallback; }

/** The page list. It is also how the project page learns whether to offer the tab, so it is read once and kept for a minute. */
export function useWikiIndex(project: string, enabled = true) {
 const api = useWikiApi();
 return useQuery({ queryKey: [...wikiKey(project), "index"], enabled, queryFn: () => api.index(project), staleTime: 60_000 });
}
export function useWikiPage(project: string, id: string | undefined) {
 const api = useWikiApi();
 return useQuery({ queryKey: [...wikiKey(project), "page", id ?? ""], enabled: id !== undefined, queryFn: () => api.page(project, id!), staleTime: 60_000, retry: false });
}
/** The cited files of a page, read when the person opens the "Relevant source files" fold. */
export function useWikiSources(project: string, id: string, enabled: boolean) {
 const api = useWikiApi();
 return useQuery({ queryKey: [...wikiKey(project), "sources", id], enabled, queryFn: () => api.sources(project, id), staleTime: 60_000, retry: false });
}
/** Whether the project page offers the Wiki tab: once the list has been read, or when it could not be read for a reason worth retrying. Not offered while Code has no wiki, or the person has no wiki to see (4xx). */
export const wikiOffered = (query: { isSuccess: boolean; isError: boolean; error: unknown }): boolean => query.isSuccess || (query.isError && !wikiAbsent(query.error) && !(query.error instanceof ApiError && query.error.status >= 400 && query.error.status < 500));
