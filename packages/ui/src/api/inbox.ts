import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { INBOX_POLL_MS, InboxPageReaderSchema, InboxReadResponseReaderSchema, ProjectNoticesReaderSchema, type InboxReadBody } from "@agentx/contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient } from "./client.js";
import { ApiError } from "./errors.js";

/**
 * The inbox's calls (web task channel K5). Rovara Code decides whose rows these are, and Cloud answers only the signed-in person's own: nothing here names a
 * person or a company. A Code that has no inbox on this install answers 404 or 501, which reads as "not available" (the badge hides, the screen says so).
 */
export function createInboxApi(host: AppHost) {
 const api = createApiClient(host);
 return {
  page: (options: { cursor?: string; limit?: number } = {}) => {
   const query = new URLSearchParams();
   if (options.limit !== undefined) query.set("limit", String(options.limit));
   if (options.cursor !== undefined) query.set("cursor", options.cursor);
   return api.get("/v1/app/inbox" + (query.size > 0 ? "?" + query.toString() : ""), InboxPageReaderSchema);
  },
  // L4-U5b: the notices about a project that Code keeps in the person's own inbox (setup needs repair, nightly upkeep paused). Code shows one only to a person who still administers the project.
  projectNotices: () => api.get("/v1/app/inbox/project-notices", ProjectNoticesReaderSchema),
  // The answer is its own body, never a confirmation, so it is read with sendAnswer.
  markRead: (body: InboxReadBody) => api.sendAnswer("POST", "/v1/app/inbox/read", body, InboxReadResponseReaderSchema),
 };
}

/** Cloud's fixed answer when Code has no inbox on this install: 501 (404 from an older Cloud). A missing session or task is not that. */
export const inboxNotAvailable = (error: unknown) => error instanceof ApiError && (error.status === 501 || (error.status === 404 && error.code !== "SESSION_NOT_FOUND" && error.code !== "TASK_NOT_FOUND"));

/**
 * The count for the nav badge: the first page of one row (Code answers the unread count with the first page), read again every 30 seconds while the page is
 * in view. Not available (or any failure) is no badge; a Code that has no inbox is not asked again until the page is reloaded.
 */
export function useInboxBadge() {
 const host = useAppHost(), api = useMemo(() => createInboxApi(host), [host]);
 return useQuery({
  // Cloud's inbox is the web app's: a desktop host asks nothing.
  enabled: host.kind === "web", queryKey: ["inbox", "badge"], retry: false, refetchOnWindowFocus: false,
  queryFn: async (): Promise<{ available: boolean; unread: number }> => {
   try { return { available: true, unread: (await api.page({ limit: 1 })).unread ?? 0 }; }
   catch (error) { if (inboxNotAvailable(error)) return { available: false, unread: 0 };throw error; }
  },
  refetchInterval: query => (query.state.data?.available === false ? false : INBOX_POLL_MS),
 });
}
