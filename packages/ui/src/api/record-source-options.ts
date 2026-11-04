// The Add form's pickers (source-row lane T10): `GET .../record/sources/options?kind=slack|linear|jira&cursor=`, read live, a page at a time, only while the Add form shows that kind. Nothing is kept: the list is
// read again each time the form picks the kind. The route answers its refusals with a flat `{code, message}` body that the shared client cannot read, so this reads the transport itself and keeps only the fixed
// `code` (the screen has its own words); the server's text is never shown. Imported only by the lazy editing screen.
import { useMemo } from "react";
import { useInfiniteQuery, type InfiniteData } from "@tanstack/react-query";
import { SourceOptionsViewReaderSchema, type SourcePickerKind } from "@agentx/contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { ApiError } from "./errors.js";
import { lessonsKey } from "./lessons.js";
import { codeOf, sourcesPath } from "./record-sources.js";

export type SourceOptionsPage = ReturnType<typeof SourceOptionsViewReaderSchema.parse>;
export const sourceOptionsKey = (project: string, kind: SourcePickerKind) => [...lessonsKey(project), "source-options", kind] as const;

async function readPage(host: AppHost, project: string, kind: SourcePickerKind, cursor: string | undefined): Promise<SourceOptionsPage> {
 const query = "?kind=" + kind + (cursor === undefined ? "" : "&cursor=" + encodeURIComponent(cursor));
 let response;
 try { response = await host.transport.request({ method: "GET", path: sourcesPath(project) + "/options" + query, retry: "never" }); }
 catch (error) {
  if (error instanceof ApiError) { if (error.code === "AUTH_REQUIRED") host.signIn(host.currentPath(), { automatic: true }); throw error; }
  throw new ApiError(0, "NETWORK_ERROR", "Couldn't reach Rovara. Check your connection and try again.");
 }
 if (response.status === 401) { host.signIn(host.currentPath(), { automatic: true }); throw new ApiError(401, "AUTH_REQUIRED", "Sign in to continue."); }
 if (response.status < 200 || response.status >= 300) throw new ApiError(response.status, codeOf(response.body), "Rovara couldn't complete this request.");
 try { return SourceOptionsViewReaderSchema.parse(response.body); } catch { throw new ApiError(502, "INVALID_RESPONSE", "Rovara returned an unreadable response."); }
}

/** The places the picker offers, page by page (the server bounds the pages). Never retried, never kept: a fresh read each time the form picks the kind. */
export function useSourceOptions(project: string, kind: SourcePickerKind, enabled: boolean) {
 const host = useAppHost(), key = useMemo(() => sourceOptionsKey(project, kind), [project, kind]);
 return useInfiniteQuery<SourceOptionsPage, Error, InfiniteData<SourceOptionsPage, string | undefined>, ReturnType<typeof sourceOptionsKey>, string | undefined>({
  queryKey: key, enabled, retry: false, gcTime: 0, staleTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false,
  initialPageParam: undefined as string | undefined, getNextPageParam: last => last.next,
  queryFn: ({ pageParam }) => readPage(host, project, kind, pageParam),
 });
}
