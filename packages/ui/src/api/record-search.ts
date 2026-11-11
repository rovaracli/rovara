// UX-4b (owner decision 3): the team record search on the project page. It reads the record's own routes (`GET .../record/search` and `.../record/past-work`), so the server applies the same read
// authority as everywhere else: a hit from a source the reader can't see is never sent. Those routes answer refusals with a flat `{code, message}` body, so this reads its own replies and keeps only the code.
import { useQuery } from "@tanstack/react-query";
import { PastWorkResponseSchema, ProjectOverviewProjectSchema, RecordSearchResponseSchema, type PastWorkResponse, type RecordSearchResponse } from "@agentx/cloud-contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { ApiError } from "./errors.js";
import { codeOf } from "./record-sources.js";

const recordPath = (project: string, route: "search" | "past-work") => "/v1/app/projects/" + encodeURIComponent(ProjectOverviewProjectSchema.shape.name.parse(project)) + "/record/" + route;

async function read<T>(host: AppHost, path: string, schema: { parse(value: unknown): T }): Promise<T> {
 let response;
 try { response = await host.transport.request({ method: "GET", path }); }
 catch (error) { if (error instanceof ApiError) throw error;throw new ApiError(0, "NETWORK_ERROR", "Couldn't reach Rovara. Check your connection and try again."); }
 if (response.status === 401) { host.signIn(host.currentPath(), { automatic: true });throw new ApiError(401, "AUTH_REQUIRED", "Sign in to continue."); }
 if (response.status < 200 || response.status >= 300) throw new ApiError(response.status, codeOf(response.body), "Rovara couldn't complete this request.");
 const own = typeof response.body === "object" && response.body !== null ? { ...(response.body as Record<string, unknown>) } : response.body;
 if (typeof own === "object" && own !== null) delete (own as Record<string, unknown>)["requestId"];
 try { return schema.parse(own); } catch { throw new ApiError(502, "INVALID_RESPONSE", "Rovara returned an unreadable response. Reload this page."); }
}

export interface RecordSearchAnswer { search: RecordSearchResponse; pastWork: PastWorkResponse }
/** One search: matching items from the record, and past tasks like it. Nothing is read until there is a query. */
export function useRecordSearch(project: string, query: string) {
 const host = useAppHost(), q = query.trim();
 return useQuery({ queryKey: ["record-search", project, q], enabled: q.length > 0, retry: false, staleTime: 30_000,
  queryFn: async (): Promise<RecordSearchAnswer> => {
   const params = (limit: number) => "?" + new URLSearchParams({ query: q, limit: String(limit) }).toString();
   const [search, pastWork] = await Promise.all([read(host, recordPath(project, "search") + params(10), RecordSearchResponseSchema), read(host, recordPath(project, "past-work") + params(5), PastWorkResponseSchema)]);
   return { search, pastWork };
  } });
}
