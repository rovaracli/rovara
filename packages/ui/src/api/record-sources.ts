// The project's Team record sources, as the Sources tab's editors see and change them (source-row lane T5). The admin view comes only from a live browser session; the writes go to the same route.
// A write is sent once and never retried. The route answers some refusals with a flat `{code, message}` body (SOURCE_REMOVAL_RUNNING, SOURCE_NOT_ALLOWED, SOURCE_KIND_NOT_YET), which the shared client cannot read,
// so a write reads its own refusal here. Only the fixed `code` is kept; the server's text is never shown.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ProjectOverviewProjectSchema, SourceWriteReplyReaderSchema, SourcesAdminViewReaderSchema, type SourceWriteBody } from "@agentx/contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient } from "./client.js";
import { ApiError } from "./errors.js";
import { lessonsKey } from "./lessons.js";

export type SourcesAdminViewData = ReturnType<typeof SourcesAdminViewReaderSchema.parse>;
export type SourceWriteResult = ReturnType<typeof SourceWriteReplyReaderSchema.parse>;
const path = (project: string) => "/v1/app/projects/" + encodeURIComponent(ProjectOverviewProjectSchema.shape.name.parse(project)) + "/record/sources";
const CLEARING_POLL_MS = 60_000;
export const sourcesAdminKey = (project: string) => [...lessonsKey(project), "sources-admin"] as const;
export const sourcesReadKey = (project: string) => [...lessonsKey(project), "sources"] as const;

/** The editors' view. Asked only for a person the project page says is a maintainer; a refusal or a reply of the members' shape leaves the read-only tab as it is. */
export function useSourcesAdmin(project: string, enabled: boolean) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 return useQuery({ queryKey: sourcesAdminKey(project), enabled, retry: false,
  // While a removed source is still being cleared the screen says so and blocks adding it again: read again every minute so that ends without a reload. Nothing else polls, and a hidden tab pauses (Query's default).
  refetchInterval: query => (query.state.data?.clearing?.length ?? 0) > 0 ? CLEARING_POLL_MS : false, queryFn: () => api.get(path(project), SourcesAdminViewReaderSchema, undefined, { retry: "never" }) });
}

const CODE = /^[A-Z][A-Z0-9_]{0,79}$/;
function codeOf(body: unknown): string {
 const inner = typeof body === "object" && body !== null && "error" in body ? body.error : body;
 const code = typeof inner === "object" && inner !== null && "code" in inner ? inner.code : undefined;
 return typeof code === "string" && CODE.test(code) ? code : "REQUEST_FAILED";
}

/** One write (add, change, remove, approve, reject). A 200 or a 202 (waiting for a second person) is an answer; anything else throws an `ApiError` carrying only the fixed code. */
export async function writeSource(host: AppHost, project: string, body: SourceWriteBody): Promise<SourceWriteResult> {
 let response;
 try { response = await host.transport.request({ method: "POST", path: path(project), body, retry: "never" }); }
 catch (error) {
  if (error instanceof ApiError) { if (error.code === "AUTH_REQUIRED") host.signIn(host.currentPath(), { automatic: true }); throw error; }
  throw new ApiError(0, "NETWORK_ERROR", "Couldn't reach Rovara. Check your connection and try again.");
 }
 if (response.status === 401) { host.signIn(host.currentPath(), { automatic: true }); throw new ApiError(401, "AUTH_REQUIRED", "Sign in to continue."); }
 if (response.status < 200 || response.status >= 300) throw new ApiError(response.status, codeOf(response.body), "Rovara couldn't complete this request.");
 try { return SourceWriteReplyReaderSchema.parse(response.body); } catch { throw new ApiError(502, "INVALID_RESPONSE", "Rovara returned an unreadable response. Reload this page."); }
}
