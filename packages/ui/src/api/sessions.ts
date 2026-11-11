import { useMemo } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { SessionMakeAgentBodySchema, SessionMakeAgentResponseReaderSchema, TaskResponseReaderSchema, DeveloperTaskViewSchema, SessionIdSchema, SessionMessageIdSchema, SessionResponseReaderSchema, SessionMessageReaderSchema, SessionMessagePageReaderSchema, SessionEventPageReaderSchema, SessionFollowResponseReaderSchema, SessionPresenceResponseReaderSchema, SessionSharesResponseReaderSchema, SessionSharePutResponseReaderSchema, SessionShareDeleteResponseReaderSchema, type SessionAnchorInput, type AgentPrincipalSchema } from "@agentx/cloud-contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient } from "./client.js";
import type { ReadSession } from "../screens/session/SessionHeader.js";
export type ReadMessage = ReturnType<typeof SessionMessageReaderSchema.parse>;
type Principal = ReturnType<typeof AgentPrincipalSchema.parse>;
const sessionPath = (id: string) => "/v1/app/sessions/" + encodeURIComponent(SessionIdSchema.parse(id));
export function acceptSessionRead(previous: ReadSession | undefined, next: ReadSession): ReadSession {
 if (previous !== undefined && (next.revision < previous.revision || Date.parse(next.updatedAt) < Date.parse(previous.updatedAt))) return previous;
 return next;
}
export function mergeSessionMessages(pages: readonly (readonly ReadMessage[])[]): ReadMessage[] {
 const byId = new Map<string, ReadMessage>();
 for (const message of pages.flat()) { const old = byId.get(message.messageId);if (old === undefined || message.rev >= old.rev) byId.set(message.messageId, message); }
 return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.messageId.localeCompare(b.messageId));
}
export function createSessionApi(host: AppHost) {
 const api = createApiClient(host);
 return {
 makeAgent(id: string, input: { requestId: string; name?: string }) { return api.send("POST", sessionPath(id) + "/agent", SessionMakeAgentBodySchema.parse(input), SessionMakeAgentResponseReaderSchema); },
 continueTask(taskId: string) { return api.send("POST", "/v1/app/tasks/" + encodeURIComponent(DeveloperTaskViewSchema.shape.taskId.parse(taskId)) + "/continue-as-task", { requestId: crypto.randomUUID() }, TaskResponseReaderSchema); },
 async read(id: string) { return (await api.get(sessionPath(id), SessionResponseReaderSchema, { "x-agentx-task-view": "2" })).session; },
 sendMessage(id: string, input: { kind: "comment" | "steer"; text: string; anchor?: SessionAnchorInput; threadId?: string }) { return api.send("POST", sessionPath(id) + "/messages", { ...input, requestId: crypto.randomUUID() }, SessionMessageReaderSchema); },
 editMessage(id: string, messageId: string, rev: number, text: string) { return api.send("PATCH", sessionPath(id) + "/messages/" + encodeURIComponent(SessionMessageIdSchema.parse(messageId)), { rev, text }, SessionMessageReaderSchema); },
 deleteMessage(id: string, messageId: string, rev: number) { return api.send("DELETE", sessionPath(id) + "/messages/" + encodeURIComponent(SessionMessageIdSchema.parse(messageId)), { rev }, SessionMessageReaderSchema); },
 setFollowing(id: string, following: boolean) { return api.send(following ? "POST" : "DELETE", sessionPath(id) + "/follow", undefined, SessionFollowResponseReaderSchema); },
 presence(id: string) { return api.send("POST", sessionPath(id) + "/presence", undefined, SessionPresenceResponseReaderSchema); },
 listShares(id: string) { return api.get(sessionPath(id) + "/shares", SessionSharesResponseReaderSchema); },
 share(id: string, principal: Principal, level: "view" | "use" | "edit") { return api.send("PUT", sessionPath(id) + "/shares", { requestId: crypto.randomUUID(), principal, level }, SessionSharePutResponseReaderSchema); },
 unshare(id: string, principalKey: string) { return api.send("DELETE", sessionPath(id) + "/shares/" + encodeURIComponent(principalKey), undefined, SessionShareDeleteResponseReaderSchema); },
 };
}
export function useSession(id: string) {
 const host = useAppHost(), api = useMemo(() => createSessionApi(host), [host]), query = useQueryClient();
 return useQuery({ queryKey: ["session", id], queryFn: async () => acceptSessionRead(query.getQueryData<ReadSession>(["session", id]), await api.read(id)) });
}
export function useSessionTimeline(id: string, enabled: boolean, anchor?: string) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 const messages = useInfiniteQuery({ queryKey: ["session", id, "messages", anchor ?? "all"], enabled, initialPageParam: undefined as string | undefined, queryFn: ({ pageParam }) => { const params = new URLSearchParams();if (pageParam !== undefined) params.set("after", pageParam);if (anchor !== undefined) params.set("anchor", anchor);return api.get(sessionPath(id) + "/messages" + (params.size ? "?" + params.toString() : ""), SessionMessagePageReaderSchema); }, getNextPageParam: (page, _pages, previous) => page.next === previous ? undefined : page.next });
 const events = useInfiniteQuery({ queryKey: ["session", id, "events"], enabled: enabled && anchor === undefined, initialPageParam: undefined as string | undefined, queryFn: ({ pageParam }) => api.get(sessionPath(id) + "/events" + (pageParam === undefined ? "" : "?after=" + encodeURIComponent(pageParam)), SessionEventPageReaderSchema), getNextPageParam: (page, _pages, previous) => page.next === previous ? undefined : page.next });
 const mergedMessages = useMemo(() => mergeSessionMessages(messages.data?.pages.map(page => page.messages) ?? []), [messages.data]);
 const mergedEvents = useMemo(() => [...new Map((events.data?.pages.flatMap(page => page.events) ?? []).map(event => [event.eventId, event])).values()], [events.data]);
 return { async reloadMessages() { const result = await messages.refetch();if (result.error) throw result.error;return mergeSessionMessages(result.data?.pages.map(page => page.messages) ?? []); }, messages: mergedMessages, events: mergedEvents, loading: messages.isPending, error: messages.error ?? events.error, hasMore: messages.hasNextPage || (anchor === undefined && events.hasNextPage), loadingMore: messages.isFetchingNextPage || events.isFetchingNextPage, async loadMore() { await Promise.all([...(messages.hasNextPage ? [messages.fetchNextPage()] : []), ...(anchor === undefined && events.hasNextPage ? [events.fetchNextPage()] : [])]); } };
}
