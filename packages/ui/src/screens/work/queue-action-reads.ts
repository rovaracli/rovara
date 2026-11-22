import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { DecisionCardsViewReaderSchema, DecisionEvidenceOpenedAnswerSchema, DecisionOutcomeReaderSchema, InboxPageReaderSchema, InboxReadResponseReaderSchema, PendingConfirmationReaderSchema } from "@agentx/contracts/web";
import { createReadClient } from "../../api/read-client.js";
import { readDecisions, type ReadDecision } from "../../api/decisions-read.js";
import { InboxReader, type ReadInbox, type TaskLesson } from "../../api/learned.js";
import { readPlan, readTaskList, type ReadTask } from "../../api/work-read.js";
import type { ApiRequest, ApiResponse, AppHost } from "../../host.js";
import type { QueueActionRead } from "./queue-action-host.js";
const object = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
/** Select the existing served authority for each live wire operation; no inferred grants. */
export function queueActionReads(host: AppHost, query: QueryClient, input: ApiRequest): QueueActionRead[] {
 const api = createReadClient(host), route = input.path.split("?")[0]!, body = object(input.body);
 if (route.startsWith("/v1/app/decisions/") || route.includes("/design-review/")) {
  const key = ["decisions"], shown = query.getQueryData<ReadDecision[]>(key);
  const decision = shown?.find(item => route.startsWith("/v1/app/decisions/" + item.card.id.replace(":", "/") + "/") || item.card.actions.some(action => action.href.split("?")[0] === route));
  const cardId = route.startsWith("/v1/app/decisions/") ? route.split("/").slice(4, 6).join(":") : "approve_spend:" + route.split("/")[4];
  const pending = (response: ApiResponse) => {
   const parsed = DecisionOutcomeReaderSchema.safeParse(response.body);
   return (parsed.success && parsed.data.cardId === cardId && parsed.data.outcome === "needs_confirmation") || (!route.startsWith("/v1/app/decisions/") && PendingConfirmationReaderSchema.safeParse(response.body).success);
  };
  return [{ subject: "task:" + (decision?.card.taskId ?? decision?.card.id), key, shown, basis: value => (value as ReadDecision[] | undefined)?.filter(item => item.card.id === decision?.card.id), read: async () => readDecisions(await api.get("/v1/app/decisions", DecisionCardsViewReaderSchema, undefined, { retry: "never" })),
   pending,
   observed: value => { const current = (value as ReadDecision[]).find(item => item.card.id === cardId);return current === undefined || current.card.status !== "pending" || (typeof body["shownDigest"] === "string" && current.digest !== body["shownDigest"]); },
   permitted: () => decision !== undefined && decision.card.status === "pending" && (body["shownDigest"] === undefined || body["shownDigest"] === decision.digest) && (route.endsWith("/evidence-opened") || decision.card.actions.some(action => action.method === input.method && action.href.split("?")[0] === route)),
   answer: response => !route.startsWith("/v1/app/decisions/") || (route.endsWith("/evidence-opened") ? DecisionEvidenceOpenedAnswerSchema : DecisionOutcomeReaderSchema).safeParse(response.body).success && (!route.startsWith("/v1/app/decisions/") || object(response.body)["cardId"] === decision?.card.id) }];
 }
 if (route.endsWith("/answers")) {
  const key = ["work", "tasks"], shown = query.getQueryData<ReadTask[]>(key), id = route.split("/")[4];
  const task = shown?.find(item => item.taskId === id || item.sessionId === id);
  const reads: QueueActionRead[] = [{ subject: "task:" + task?.taskId, key, shown, basis: value => (value as ReadTask[] | undefined)?.filter(item => item.taskId === task?.taskId).map(item => ({ taskId: item.taskId, project: item.project, sessionId: item.sessionId, workflow: item.workflow, round: item.round, detailUnread: item.detailUnread })), read: () => api.get("/v1/app/sessions", { parse: readTaskList }, undefined, { retry: "never" }), observed: value => { const current = (value as ReadTask[]).find(item => item.taskId === id || item.sessionId === id);return current !== undefined && current.detailUnread !== true && current.workflow !== undefined && (current.workflow.state !== "WAITING" || current.workflow.revision !== body["revision"] || (current.round?.round ?? current.workflow.round) !== body["round"]); }, permitted: () => task !== undefined && task.detailUnread !== true && task.workflow?.state === "WAITING" && body["revision"] === task.workflow.revision && body["round"] === (task.round?.round ?? task.workflow.round) }];
  if (route.startsWith("/v1/app/sessions/") && task !== undefined) { const planKey = ["work", "plan", task.taskId];reads.push({ key: planKey, shown: query.getQueryData(planKey), read: () => api.get("/v1/app/tasks/" + task.taskId + "/documents/plan", { parse: readPlan }, undefined, { retry: "never" }), permitted: () => true }); }
  return reads;
 }
 if (route.endsWith("/lessons/decisions")) {
  const key = ["learned", "inbox"], shown = query.getQueryData<ReadInbox>(key), project = decodeURIComponent(route.split("/")[4]!);
  const batch = shown?.batches.find(item => item.project === project), decisions = body["decisions"] as Array<{ lessonId: string; version: number; decision: string }> | undefined;
  return [{ subject: "lesson-batch:" + project, key, shown, basis: value => (value as ReadInbox | undefined)?.batches.filter(batch => batch.project === project), read: () => api.get("/v1/app/lessons/inbox", InboxReader, undefined, { retry: "never" }), permitted: () => decisions !== undefined && decisions.length > 0 && decisions.every(choice => batch?.lessons.some(lesson => lesson.id === choice.lessonId && lesson.version === choice.version && (choice.decision === "keep" ? lesson.canApprove : choice.decision === "drop" && lesson.canReject)) === true),
   observed: value => { const inbox = value as ReadInbox;return inbox.state === "on" && !inbox.unavailable.includes(project) && !inbox.batches.some(batch => batch.project === project && batch.partial === true) && decisions !== undefined && decisions.length > 0 && decisions.every(choice => !inbox.batches.some(batch => batch.project === project && batch.lessons.some(lesson => lesson.id === choice.lessonId && lesson.version === choice.version && lesson.status === "pending"))); },
   answer: response => Array.isArray(object(response.body)["results"]) && decisions?.every(choice => (object(response.body)["results"] as Array<Record<string, unknown>>).some(result => result["lessonId"] === choice.lessonId && (result["ok"] === true ? typeof result["status"] === "string" : result["ok"] === false && typeof result["message"] === "string"))) === true }];
 }
 if (route.endsWith("/not-helpful")) {
  const parts = route.split("/"), project = decodeURIComponent(parts[4]!), taskId = decodeURIComponent(parts[6]!), lessonId = decodeURIComponent(parts[8]!);
  const key = ["learned", "project", project, "task", taskId], shown = query.getQueryData<TaskLesson[]>(key);
  return [{ subject: "task:" + taskId, key, shown, basis: value => (value as TaskLesson[] | undefined)?.filter(lesson => lesson.lessonId === lessonId), read: () => api.get(route.slice(0, route.indexOf("/lessons/") + 8), { parse: value => object(value)["lessons"] }, undefined, { retry: "never" }), observed: value => (value as TaskLesson[]).some(lesson => lesson.lessonId === lessonId && lesson.visible && lesson.canMark === false), permitted: () => shown?.some(lesson => lesson.lessonId === lessonId && lesson.visible && lesson.canMark) === true }];
 }
 if (route === "/v1/app/inbox/read") {
  type Page = ReturnType<typeof InboxPageReaderSchema.parse>;
  const key = ["inbox", "list"], shown = query.getQueryData<InfiniteData<Page>>(key), ids = body["ids"] as string[] | undefined;
  return [{ subject: "inbox", key, shown, basis: value => (value as InfiniteData<Page> | undefined)?.pages.flatMap(page => page.items).filter(item => ids?.includes(item.id)).map(item => ({ id: item.id, read: item.read })).sort((a, b) => a.id.localeCompare(b.id)), read: async () => ({ pages: await Promise.all((shown?.pageParams ?? []).map(cursor => api.get("/v1/app/inbox" + (typeof cursor === "string" ? "?cursor=" + encodeURIComponent(cursor) : ""), InboxPageReaderSchema, undefined, { retry: "never" }))), pageParams: shown?.pageParams }), observed: value => ids !== undefined && ids.length > 0 && ids.every(id => (value as InfiniteData<Page>).pages.some(page => page.items.some(item => item.id === id && item.read))), permitted: () => ids !== undefined && ids.length > 0 && ids.every(id => shown?.pages.some(page => page.items.some(item => item.id === id && !item.read))), answer: response => InboxReadResponseReaderSchema.safeParse(response.body).success }];
 }
 // Supplementary reads never invent a send surface.
 return [];
}
