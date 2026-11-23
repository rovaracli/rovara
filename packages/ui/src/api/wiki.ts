// The project Wiki tab's reads (lead 4 W5; Code's wiki read routes, W2, through Cloud). Code decides who may read; this client only asks. A refusal is shown in
// Cloud's fixed words (fixedWikiWords), never other text. Wiki text is untrusted data: every answer is read with a strict, bounded schema and drawn as plain text.
import { createContext, useContext, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
 AnswerGapsResponseSchema, ProjectOverviewProjectSchema, WIKI_CORRECTION_SENTENCES, WIKI_ID_PATTERN, WIKI_PAGE_ID_PATTERN, WIKI_SENTENCES, WikiAddNoteBodySchema, WikiCorrectionsResponseSchema, WikiDisputedResponseSchema, WikiIndexResponseSchema,
 WikiMarkWrongBodySchema, WikiMarkedResponseSchema, WikiNoteAddedResponseSchema, WikiNoteAcknowledgedResponseSchema, WikiNoteApprovedResponseSchema, WikiNoteDeletedResponseSchema, WikiPageResponseSchema, WikiResolvedResponseSchema, WikiSearchResponseSchema, WikiSourcesResponseSchema, WikiSuggestedResponseSchema,
} from "@agentx/contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient } from "./client.js";
import { ApiError } from "./errors.js";

export type { AnswerGapsResponse, WikiAddNoteBody, WikiCorrectionsResponse, WikiDisputedResponse, WikiMarkWrongBody, WikiNoteState, WikiSuggestedResponse, WikiYouCan } from "@agentx/contracts/web";
export type { WikiBlock, WikiIndexEntry, WikiIndexResponse, WikiLastBuild, WikiPageResponse, WikiSearchResponse, WikiShownClaim, WikiShownNote, WikiSourceState, WikiSourcesResponse } from "@agentx/contracts/web";

const base = (name: string) => "/v1/app/projects/" + encodeURIComponent(ProjectOverviewProjectSchema.shape.name.parse(name)) + "/wiki";
const pageId = (id: string): string => { if (!WIKI_PAGE_ID_PATTERN.test(id)) throw new ApiError(400, "CONFIG_INVALID", "the request is not valid"); return encodeURIComponent(id); };

const noteId = (id: string): string => { if (!WIKI_ID_PATTERN.test(id)) throw new ApiError(400, "CONFIG_INVALID", "the request is not valid"); return encodeURIComponent(id); };
const NEVER = { retry: "never" } as const;

export function createWikiApi(host: AppHost) {
 const api = createApiClient(host);
 return {
  index: (project: string) => api.get(base(project), WikiIndexResponseSchema),
  search: (project: string, query: string) => api.get(base(project) + "/search?q=" + encodeURIComponent(query), WikiSearchResponseSchema),
  page: (project: string, id: string) => api.get(base(project) + "/pages/" + pageId(id), WikiPageResponseSchema),
  sources: (project: string, id: string) => api.get(base(project) + "/pages/" + pageId(id) + "/sources", WikiSourcesResponseSchema),
  // Corrections (C1). Code decides who may do each; a write is never retried on its own (a second try could add a second note).
  corrections: (project: string, id: string) => api.get(base(project) + "/pages/" + pageId(id) + "/corrections", WikiCorrectionsResponseSchema),
  addNote: (project: string, id: string, body: { text: string; file?: { repo: string; path: string } }) => api.sendAnswer("POST", base(project) + "/pages/" + pageId(id) + "/notes", WikiAddNoteBodySchema.parse(body), WikiNoteAddedResponseSchema, NEVER),
  approveNote: (project: string, id: string, note: string) => api.sendAnswer("POST", base(project) + "/pages/" + pageId(id) + "/notes/" + noteId(note) + "/approve", {}, WikiNoteApprovedResponseSchema, NEVER),
  deleteNote: (project: string, id: string, note: string) => api.sendAnswer("POST", base(project) + "/pages/" + pageId(id) + "/notes/" + noteId(note) + "/delete", {}, WikiNoteDeletedResponseSchema, NEVER),
  suggestLesson: (project: string, id: string, note: string) => api.sendAnswer("POST", base(project) + "/pages/" + pageId(id) + "/notes/" + noteId(note) + "/suggest-lesson", {}, WikiSuggestedResponseSchema, NEVER),
  markWrong: (project: string, id: string, body: { claimId?: string; reason?: string }) => api.sendAnswer("POST", base(project) + "/pages/" + pageId(id) + "/flags", WikiMarkWrongBodySchema.parse(body), WikiMarkedResponseSchema, NEVER),
  resolveMarks: (project: string, id: string) => api.sendAnswer("POST", base(project) + "/pages/" + pageId(id) + "/flags/resolve", {}, WikiResolvedResponseSchema, NEVER),
  disputed: (project: string) => api.get(base(project) + "/disputed", WikiDisputedResponseSchema),
  /** The note's author or a maintainer says they checked the file that changed: the reminder clears. */
  acknowledgeNote: (project: string, id: string, note: string) => api.sendAnswer("POST", base(project) + "/pages/" + pageId(id) + "/notes/" + noteId(note) + "/acknowledge", {}, WikiNoteAcknowledgedResponseSchema, NEVER),
  /** Questions the wiki could not answer (maintainers only), as topics: never who asked. */
  gaps: (project: string) => api.get(base(project) + "/gaps", AnswerGapsResponseSchema),
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
export function useWikiSearch(project: string, query: string) {
 const api = useWikiApi();
 return useQuery({ queryKey: [...wikiKey(project), "search", query], enabled: query.trim().length > 0, queryFn: () => api.search(project, query.trim()), staleTime: 30_000, retry: false });
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

/** A refusal's words when they are one of the fixed sentences (Code's corrections words, Cloud's wiki words), else the fallback (never the server's other text). */
export function fixedCorrectionWords(error: unknown, fallback: string): string { return error instanceof ApiError && (WIKI_CORRECTION_SENTENCES.has(error.message) || WIKI_SENTENCES.has(error.message)) ? error.message : fallback; }
/** What this person may do on a page, and which notes need a look. Read after the page; a read that fails shows the page with no controls at all (never a button that would be refused). */
export function useWikiCorrections(project: string, id: string | undefined) {
 const api = useWikiApi();
 return useQuery({ queryKey: [...wikiKey(project), "corrections", id ?? ""], enabled: id !== undefined, queryFn: () => api.corrections(project, id!), staleTime: 30_000, retry: false });
}
/** Marks still open after their page was written again (maintainers only: others are not asked). */
export function useWikiDisputed(project: string, enabled: boolean) {
 const api = useWikiApi();
 return useQuery({ queryKey: [...wikiKey(project), "disputed"], enabled, queryFn: () => api.disputed(project), staleTime: 15_000, retry: false });
}
/** The questions the wiki could not answer (maintainers only: others are not asked). */
export function useWikiGaps(project: string, enabled: boolean) {
 const api = useWikiApi();
 return useQuery({ queryKey: [...wikiKey(project), "gaps"], enabled, queryFn: () => api.gaps(project), staleTime: 15_000, retry: false });
}
/** After a correction: the page, its list, its corrections and the disputed list are read again. */
/** A screen that keeps its own copy of the wiki reads (the Wiki pages) says here how to read them again after a write; the shared refresh then runs both. */
export const WikiRefreshAlso = createContext<(() => Promise<void>) | undefined>(undefined);
export function useWikiRefresh(project: string) {
 const query = useQueryClient(), also = useContext(WikiRefreshAlso);
 return async () => { await Promise.all([query.invalidateQueries({ queryKey: wikiKey(project) }), also?.()]); };
}
