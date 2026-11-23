import { sessionWriteHost, readSessionIdentity, sessionScope, beginSessionRead, finishSessionRead, assertSessionIdentity, bindSessionRead, isCurrentSessionRead, useSessionIdentity } from "./session-safety.js";
import { mergeTaskMoney, PendingConfirmationReaderSchema, PendingAdminApprovalReaderSchema } from "@agentx/contracts/web";
import { useEffect, useMemo } from "react";
import { z } from "zod";
import { useInfiniteQuery, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { SessionMakeAgentBodySchema, SessionMakeAgentResponseReaderSchema, TaskResponseReaderSchema, DeveloperTaskViewSchema, SessionIdSchema, SessionMessageIdSchema, SessionResponseReaderSchema, SessionMessageReaderSchema, SessionMessagePageReaderSchema, SessionEventPageReaderSchema, SessionFollowResponseReaderSchema, SessionPresenceResponseReaderSchema, SessionSharesResponseReaderSchema, SessionSharePutResponseReaderSchema, SessionShareDeleteResponseReaderSchema, type SessionAnchorInput, type AgentPrincipalSchema } from "@agentx/contracts/web";
import { talkRead, reconcileTalkMessages } from "../screens/session/talk-lifecycle.js";
import { ApiError } from "./errors.js";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient } from "./client.js";
import type { ReadSession } from "../screens/session/SessionHeader.js";
export type ReadMessage = ReturnType<typeof SessionMessageReaderSchema.parse>;
type Principal = ReturnType<typeof AgentPrincipalSchema.parse>;
const TASK_ID = z.string().uuid(), OpenedTaskSchema = z.object({ sessionId: SessionIdSchema, sessionUrl: z.string() });
const sessionPath = (id: string) => "/v1/app/sessions/" + encodeURIComponent(SessionIdSchema.parse(id));
export function acceptSessionRead(previous: ReadSession | undefined, next: ReadSession): ReadSession {
 const view = previous !== undefined && (next.revision < previous.revision || Date.parse(next.updatedAt) < Date.parse(previous.updatedAt)) ? previous : next;
 const money = mergeTaskMoney(previous?.money, next.money);
 return { ...view, you: next.you, anchors: next.anchors, money, ...(view.body.kind === "task" ? { body: { ...view.body, task: { ...view.body.task, money } } } : {}) };
}
export function mergeSessionMessages(pages: readonly (readonly ReadMessage[])[]): ReadMessage[] {
 const byId = new Map<string, ReadMessage>();
 for (const message of pages.flat()) { const old = byId.get(message.messageId);if (old === undefined || message.rev >= old.rev) byId.set(message.messageId, message); }
 return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.messageId.localeCompare(b.messageId));
}
export function createSessionApi(host: AppHost) {
 const api = createApiClient(sessionWriteHost(host));
 // Sharing has a structured pending reply of its own. Keep it pending until the
 // shares read observes the requested principal and level; never call a 202 applied.
 const sharing = createApiClient({ ...host, transport: { async request(input) {
  const response = await host.transport.request(input);
  if (response.status === 202 && !PendingConfirmationReaderSchema.safeParse(response.body).success && !PendingAdminApprovalReaderSchema.safeParse(response.body).success) throw new ApiError(202, "PENDING", "Rovara didn't confirm this yet. Check its current status before acting again.");
  return response;
 } } });
 return {
 makeAgent(id: string, input: { requestId: string; name?: string }) { return api.send("POST", sessionPath(id) + "/agent", SessionMakeAgentBodySchema.parse(input), SessionMakeAgentResponseReaderSchema, { retry: "never" }); },
 /** K2: the Cloud session of a Code task (made on the first open by anyone Code lets read it); a refusal reads as a missing session. */
 async openTask(taskId: string) { const sent = await api.send("POST", "/v1/app/tasks/" + encodeURIComponent(TASK_ID.parse(taskId)) + "/open", undefined, { parse: (value: unknown) => OpenedTaskSchema.parse(value) }, { retry: "never" });return sent.kind === "done" ? sent.value.sessionId : undefined; },
 continueTask(taskId: string, requestId: string = crypto.randomUUID()) { return api.send("POST", "/v1/app/tasks/" + encodeURIComponent(DeveloperTaskViewSchema.shape.taskId.parse(taskId)) + "/continue-as-task", { requestId }, TaskResponseReaderSchema, { retry: "never" }); },
 // Merge owns its identity and body-bound fence. Keep its reader as shipped.
 async read(id: string) { return (await createApiClient(host).get(sessionPath(id), SessionResponseReaderSchema, { "x-agentx-task-view": "2" })).session; },
 sendMessage(id: string, input: { requestId?: string; kind: "comment" | "steer"; text: string; anchor?: SessionAnchorInput; threadId?: string }) { return api.send("POST", sessionPath(id) + "/messages", { ...input, requestId: input.requestId ?? crypto.randomUUID() }, SessionMessageReaderSchema, { retry: "never" }); },
 editMessage(id: string, messageId: string, rev: number, text: string) { return api.send("PATCH", sessionPath(id) + "/messages/" + encodeURIComponent(SessionMessageIdSchema.parse(messageId)), { rev, text }, SessionMessageReaderSchema, { retry: "never" }); },
 deleteMessage(id: string, messageId: string, rev: number) { return api.send("DELETE", sessionPath(id) + "/messages/" + encodeURIComponent(SessionMessageIdSchema.parse(messageId)) + "?rev=" + encodeURIComponent(String(rev)), undefined, SessionMessageReaderSchema, { retry: "never" }); },
 setFollowing(id: string, following: boolean) { return api.send(following ? "POST" : "DELETE", sessionPath(id) + "/follow", undefined, SessionFollowResponseReaderSchema); },
 presence(id: string) { return api.send("POST", sessionPath(id) + "/presence", undefined, SessionPresenceResponseReaderSchema); },
 listShares(id: string) { return api.get(sessionPath(id) + "/shares", SessionSharesResponseReaderSchema); },
 share(id: string, principal: Principal, level: "view" | "use" | "edit") { return sharing.send("PUT", sessionPath(id) + "/shares", { requestId: crypto.randomUUID(), principal, level }, SessionSharePutResponseReaderSchema); },
 unshare(id: string, principalKey: string) { return sharing.send("DELETE", sessionPath(id) + "/shares/" + encodeURIComponent(principalKey), undefined, SessionShareDeleteResponseReaderSchema); },
 };
}
/** Task-page reads add their identity/fence without changing Merge's independent reader. */
export function createTaskSessionApi(host: AppHost) {
 const api = createApiClient(sessionWriteHost(host));
 return { ...createSessionApi(host),
 async read(id: string): Promise<ReadSession> {
  const identity = await readSessionIdentity(host), scope = sessionScope(identity, id), issue = beginSessionRead(host, scope);
  try {
   const value = (await api.get(sessionPath(id), SessionResponseReaderSchema, { "x-agentx-task-view": "2" }, { retry: "never" })).session;
   assertSessionIdentity(host, identity);finishSessionRead(host, scope, issue);bindSessionRead(host, identity, id, value);return value;
  } catch (error) { finishSessionRead(host, scope, issue, error);throw error; }
 },
 };
}

type SessionRead = Pick<UseQueryResult<ReadSession, Error>, "refetch" | "failureCount"> & { data: ReadSession | undefined; isPending: boolean; isError: boolean; error: Error | null };
export function useSession(id: string, enabled = true, scope?: string): SessionRead {
 const host = useAppHost(), api = useMemo(() => createTaskSessionApi(host), [host]), identity = useSessionIdentity(host), query = useQueryClient();
 const read = useQuery({ queryKey: ["session", id], enabled: enabled && identity.data !== undefined, retry: false, queryFn: () => talkRead(host, scope, "session", async () => acceptSessionRead(isCurrentSessionRead(host, identity.data, id) ? query.getQueryData<ReadSession>(["session", id]) : undefined, await api.read(id))) });
 const bound = isCurrentSessionRead(host, identity.data, id), identityReady = identity.data !== undefined;
 const { isFetching, isError, refetch } = read;
 useEffect(() => { if (enabled && identityReady && !bound && !isFetching && !isError) void refetch(); }, [enabled, identityReady, bound, isFetching, isError, refetch]);
 return { ...read, data: bound ? read.data : undefined, isPending: read.isPending || (enabled && !bound && !read.isError && !identity.isError), isError: read.isError || identity.isError, error: read.error ?? identity.error };
}
export function useSessionTimeline(id: string, enabled: boolean, anchor?: string, scope?: string) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 const messages = useInfiniteQuery({ queryKey: ["session", id, "messages", anchor ?? "all", ...(scope === undefined ? [] : [scope])], enabled, initialPageParam: undefined as string | undefined, queryFn: ({ pageParam }) => { const params = new URLSearchParams();if (pageParam !== undefined) params.set("after", pageParam);if (anchor !== undefined) params.set("anchor", anchor);return talkRead(host, scope, "messages:" + (anchor ?? "all"), () => api.get(sessionPath(id) + "/messages" + (params.size ? "?" + params.toString() : ""), SessionMessagePageReaderSchema, undefined, { retry: "never" })).then(page => { if (pageParam === undefined) reconcileTalkMessages(host, scope, "messages:" + (anchor ?? "all"), page.messages);return page; }); }, getNextPageParam: (page, _pages, previous) => page.next === previous ? undefined : page.next });
 const events = useInfiniteQuery({ queryKey: ["session", id, "events", ...(scope === undefined ? [] : [scope])], enabled: enabled && anchor === undefined, initialPageParam: undefined as string | undefined, queryFn: ({ pageParam }) => talkRead(host, scope, "events", () => api.get(sessionPath(id) + "/events" + (pageParam === undefined ? "" : "?after=" + encodeURIComponent(pageParam)), SessionEventPageReaderSchema, undefined, { retry: "never" })), getNextPageParam: (page, _pages, previous) => page.next === previous ? undefined : page.next });
 const mergedMessages = useMemo(() => mergeSessionMessages(messages.data?.pages.map(page => page.messages) ?? []), [messages.data]);
 const mergedEvents = useMemo(() => [...new Map((events.data?.pages.flatMap(page => page.events) ?? []).map(event => [event.eventId, event])).values()], [events.data]);
 return { async reloadMessage(messageId: string) {
  // A failed single-comment read keeps the mounted editor and its exact local draft.
  // It still updates the shared authority fence; it cannot restore a refused timeline from cache.
  return talkRead(host, scope, "messages:" + (anchor ?? "all"), async () => {
   const seen = new Set<string>();let after: string | undefined;
   for (;;) {
    const params = new URLSearchParams();if (anchor !== undefined) params.set("anchor", anchor);if (after !== undefined) params.set("after", after);
    const page = await api.get(sessionPath(id) + "/messages" + (params.size ? "?" + params.toString() : ""), SessionMessagePageReaderSchema, undefined, { retry: "never" });
    const found = page.messages.find(message => message.messageId === messageId);if (found !== undefined) return found.deletedAt === undefined ? found : undefined;
    if (page.next === undefined) return undefined;
    if (seen.has(page.next)) throw new ApiError(502, "INVALID_RESPONSE", "Couldn't read the current comment.");
    seen.add(page.next);after = page.next;
   }
  });
 }, async reload() { const results = await Promise.all([messages.refetch(), ...(anchor === undefined ? [events.refetch()] : [])]);const failed = results.find(result => result.isError);if (failed) throw failed.error; }, async reloadMessages() { const result = await messages.refetch();if (result.error) throw result.error;return mergeSessionMessages(result.data?.pages.map(page => page.messages) ?? []); }, messages: mergedMessages, events: mergedEvents, loading: messages.isPending, error: messages.error ?? events.error, hasMore: messages.hasNextPage || (anchor === undefined && events.hasNextPage), loadingMore: messages.isFetchingNextPage || events.isFetchingNextPage, async loadMore() { await Promise.all([...(messages.hasNextPage ? [messages.fetchNextPage()] : []), ...(anchor === undefined && events.hasNextPage ? [events.fetchNextPage()] : [])]); } };
}
