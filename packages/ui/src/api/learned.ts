// The lessons screens' read layer (DEC 231): the Work inbox's batch row, the "Learned" section of How we work, and "Lessons used" on the task page, on Code's
// lessons API through Cloud (contract v0 `lessons.*`). Code decides who may see and decide each lesson; this file reads its answers, sends a person's
// decisions once (`retry: "never"`: a stale version, a refusal or a throttle is shown in Code's own words, never repeated here) and words what it read.
// Nothing is invented: a use count is what Code sends (loads, helpful, not helpful), never "used in N tasks". While Code's lessons are off every read
// answers 404 LESSONS_SWITCHED_OFF, which the screens show as a calm off state.
import { useMemo } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { LessonCitation, LessonDecision, LessonDecisionResult, LessonEdit, LessonInboxBatch, LessonItem, LessonList, LessonMode, LessonModeResponse, LessonRejectReason, LessonRetireReason, LessonRetireRequest, TaskLesson } from "@agentx/contracts/code-contract-v0";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient, type SendResult } from "./client.js";
import { ApiError } from "./errors.js";

export type { LessonDecision, LessonEdit, LessonItem, LessonList, LessonMode, TaskLesson };
const NEVER = { retry: "never" } as const;
const DAY_MS = 864e5;
/** An undecided lesson lapsing within this long gets the warning. */
export const EXPIRY_WARNING_MS = 2 * DAY_MS;
export const DECISIONS_MAX = 20;

// ---- Words ----
export const REJECT_REASONS: ReadonlyArray<{ value: LessonRejectReason; label: string }> = [
 { value: "wrong", label: "It's wrong" }, { value: "too_narrow", label: "Too narrow to be a rule" }, { value: "duplicate", label: "We already have it" }, { value: "not_useful", label: "Not useful" }, { value: "other", label: "Something else" },
];
export const RETIRE_REASONS: ReadonlyArray<{ value: LessonRetireReason; label: string }> = [
 { value: "outdated", label: "Out of date" }, { value: "wrong", label: "It's wrong" }, { value: "harmful", label: "It made things worse" }, { value: "not_useful", label: "Not useful" }, { value: "other", label: "Something else" },
];
export const MODES: ReadonlyArray<{ value: LessonMode; label: string; hint: string }> = [
 { value: "off", label: "Off", hint: "Rovara doesn't learn from corrections here." },
 { value: "suggest", label: "Suggest", hint: "Rovara proposes lessons. A person keeps each one before it is used." },
 { value: "auto", label: "Auto", hint: "Low-risk lessons go live on trial by themselves. The rest wait for a person." },
];
export const modeLabel = (mode: LessonMode) => MODES.find(entry => entry.value === mode)?.label ?? "Off";
const REASON_WORDS: Record<string, string> = Object.fromEntries([...REJECT_REASONS, ...RETIRE_REASONS].map(entry => [entry.value, entry.label]));
/** A retired lesson's reason, only in fixed words this build knows (an older path may have kept a person's free text, which is never shown). */
export const reasonWords = (reason: string | undefined) => (reason === undefined ? undefined : REASON_WORDS[reason]);
export const RETIRED_STATUS: Record<string, string> = { retired: "Retired", expired: "Lapsed: nobody decided in time", rejected: "Dropped" };
const STAGE_WORDS: Record<string, string> = { UNDERSTAND: "Understand", PLAN: "Plan", PLAN_CRITIQUE: "Plan check", PLAN_REVIEW: "Plan review", IMPLEMENT: "Build", VERIFY: "Checks", REVIEW: "Review", PULL_REQUEST: "Pull request" };
export const stageWords = (stage: string) => STAGE_WORDS[stage] ?? (stage === "" ? "A step" : stage.charAt(0) + stage.slice(1).toLowerCase().replaceAll("_", " "));
const WHY: Record<string, string> = { scope: "It covers this part of the project", similar: "It came from a similar task", path: "It is about the files this task touched" };
export const whyWords = (why: string) => WHY[why] ?? "Rovara matched it to this task";
const TASK_CITATION: Record<string, string> = { valid: "The code it cites is still there", moved: "The code it cites moved; Rovara used the new place", unchecked: "Its citation was not checked", stale_dropped: "The code it cited is gone, so the citation was left out", unchecked_dropped: "Its citation could not be checked, so it was left out", none: "It cites no code" };
export const taskCitationWords = (citation: string) => TASK_CITATION[citation] ?? "Its citation's state is unknown";
const CHECK: Record<string, string> = { valid: "still there", moved: "moved", stale: "gone", unchecked: "not checked yet" };
export function citationWords(citation: LessonCitation): { text: string; href?: string } {
 if (citation.kind === "code") return { text: `${citation.path}:${String(citation.startLine)}${citation.endLine > citation.startLine ? "-" + String(citation.endLine) : ""} (${CHECK[citation.check] ?? "not checked yet"})` };
 if (citation.kind === "pr") return { text: "The pull request it came from", href: citation.url };
 if (citation.kind === "task") return { text: "The task it came from" };
 if (citation.kind === "record") return { text: "The team record" };
 return { text: "Another kind of reference" };
}
const plural = (n: number, one: string, many = one + "s") => `${String(n)} ${n === 1 ? one : many}`;
/** What Code counted, honestly: loads, helpful and not helpful marks, and the tasks that back it. Never "used in N tasks" (Code has no such count yet). */
export function usageWords(lesson: Pick<LessonItem, "counters" | "supportTasks" | "usedInTasks">): string {
 const parts = [lesson.counters.loaded === 0 ? "Not loaded by a task yet" : `Loaded ${plural(lesson.counters.loaded, "time")}`];
 // The slot for Code's distinct-task count: shown only when Code sends it.
 if (lesson.usedInTasks !== undefined) parts.push(`used in ${plural(lesson.usedInTasks, "task")}`);
 if (lesson.counters.helpful > 0) parts.push(`${String(lesson.counters.helpful)} helpful`);
 if (lesson.counters.harmful > 0) parts.push(`${String(lesson.counters.harmful)} not helpful`);
 if (lesson.supportTasks > 0) parts.push(`learned from ${plural(lesson.supportTasks, "task")}`);
 return parts.join(" · ");
}
/** Who it came from: "your correction", or the names Code gave. */
export function fromWords(lesson: Pick<LessonItem, "from">): string | undefined {
 if (lesson.from.some(person => person.you === true)) return lesson.from.length === 1 ? "From your correction" : `From your correction and ${plural(lesson.from.length - 1, "other")}`;
 if (lesson.from.length === 0) return undefined;
 return `From ${lesson.from[0]!.name}'s correction${lesson.from.length > 1 ? ` and ${plural(lesson.from.length - 1, "other")}` : ""}`;
}
/** When an undecided lesson lapses: a warning when it is close, a plain date otherwise; past is "lapsing now". */
export function expiryWords(expiresAt: number, now: number): { text: string; soon: boolean } {
 const left = expiresAt - now;
 if (left <= 0) return { text: "Lapses now if nobody decides", soon: true };
 if (left < EXPIRY_WARNING_MS) {
  const hours = Math.ceil(left / 36e5);
  return { text: hours < 24 ? `Lapses in ${plural(hours, "hour")} if nobody decides` : `Lapses in ${plural(Math.ceil(left / DAY_MS), "day")} if nobody decides`, soon: true };
 }
 return { text: `Lapses on ${new Date(expiresAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })} if nobody decides`, soon: false };
}
/** What else a lesson touches, so Keep is never silent: a possible duplicate or a contradiction, named by title when the other lesson is in view. */
export function relationWords(lesson: Pick<LessonItem, "possibleDuplicate" | "contradicts">, titleOf: (id: string) => string | undefined): string[] {
 const name = (id: string) => { const title = titleOf(id); return title === undefined ? "another lesson" : `"${title}"`; };
 const out: string[] = [];
 if (lesson.possibleDuplicate !== undefined) out.push(`May duplicate ${name(lesson.possibleDuplicate)}. Keep keeps both; Drop if it repeats it.`);
 if (lesson.contradicts !== undefined) out.push(`Contradicts ${name(lesson.contradicts)}. Keep only the one that is right.`);
 return out;
}
export const isFromYou = (lesson: Pick<LessonItem, "from">) => lesson.from.some(person => person.you === true);
/** The batch's line in the list: "3 lessons from this week's corrections" (or "recent corrections" when one is older than a week). */
export function batchTitle(batch: Pick<LessonInboxBatch, "lessons">, now: number): string {
 const week = batch.lessons.every(lesson => now - lesson.createdAt <= 7 * DAY_MS);
 return `${plural(batch.lessons.length, "lesson")} from ${week ? "this week's" : "recent"} corrections`;
}
export const soonCount = (batch: Pick<LessonInboxBatch, "lessons">, now: number) => batch.lessons.filter(lesson => expiryWords(lesson.expiresAt, now).soon).length;
/** What one decision came to, in words. */
export function resultWords(result: LessonDecisionResult, decision: "keep" | "drop"): string {
 if (!result.ok) return result.message;
 if (result.status === "rejected") return "Dropped.";
 if (result.status === "pending") return "Kept. It waits for one more person before Rovara uses it.";
 return decision === "keep" ? "Kept. Rovara uses it in tasks from now on." : "Done.";
}
/** Code's lessons are off (its switch, or none wired for the company): the screens say so calmly. */
export const lessonsOff = (error: unknown) => error instanceof ApiError && error.code === "LESSONS_SWITCHED_OFF";
/** A read Cloud or Code does not serve yet (an older Code without the lessons API): said plainly, never as a failure to retry. */
/** Code's own lessons refusals that are real answers (a project or task the person cannot reach), never "not served". */
const CODE_REFUSALS = new Set(["No such project.", "No such task.", "That lesson is no longer there."]);
export const notServed = (error: unknown) => error instanceof ApiError && (error.status === 501 || (error.status === 404 && error.code !== "LESSONS_SWITCHED_OFF" && error.code !== "TASK_NOT_FOUND" && !CODE_REFUSALS.has(error.message)));
export const OFF_TEXT = "Lessons are off. Rovara isn't learning from corrections here, and no lessons are given to tasks.";

// ---- Readers: an answer that is not the shape is "unreadable", never half drawn ----
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): value is string => typeof value === "string";
const fin = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
function readLesson(raw: unknown): LessonItem | undefined {
 if (!isRecord(raw) || !str(raw["id"]) || !str(raw["title"]) || !fin(raw["version"]) || !fin(raw["expiresAt"]) || !fin(raw["createdAt"]) || !isRecord(raw["counters"])) return undefined;
 const counters = raw["counters"], n = (value: unknown) => (fin(value) && value > 0 ? Math.floor(value) : 0);
 return {
  ...(raw as unknown as LessonItem),
  description: str(raw["description"]) ? raw["description"] : "", body: str(raw["body"]) ? raw["body"] : "",
  counters: { loaded: n(counters["loaded"]), helpful: n(counters["helpful"]), harmful: n(counters["harmful"]) },
  from: Array.isArray(raw["from"]) ? raw["from"].filter((one): one is { name: string; you?: true } => isRecord(one) && str(one["name"])) : [],
  citations: Array.isArray(raw["citations"]) ? (raw["citations"].filter(isRecord) as unknown as LessonCitation[]) : [],
  supportTasks: n(raw["supportTasks"]), canApprove: raw["canApprove"] === true, canReject: raw["canReject"] === true, canRetire: raw["canRetire"] === true,
 };
}
const readLessons = (value: unknown): LessonItem[] => (Array.isArray(value) ? value.flatMap(one => { const lesson = readLesson(one); return lesson === undefined ? [] : [lesson]; }) : []);
export interface ReadInbox { state: "on" | "off"; batches: LessonInboxBatch[]; unavailable: string[] }
export const InboxReader = { parse(body: unknown): ReadInbox {
 if (!isRecord(body) || (body["state"] !== "on" && body["state"] !== "off") || !Array.isArray(body["batches"])) throw new Error("not an inbox");
 return {
  state: body["state"], unavailable: Array.isArray(body["unavailable"]) ? body["unavailable"].filter(str) : [],
  batches: body["batches"].filter(isRecord).flatMap(batch => { const lessons = readLessons(batch["lessons"]); return !str(batch["project"]) || lessons.length === 0 ? [] : [{ project: batch["project"], lessons, fromYou: lessons.filter(isFromYou).length, ...(batch["partial"] === true ? { partial: true as const } : {}) }]; }),
 };
} };
export interface ReadPage { list: LessonList; canDecide: boolean; lessons: LessonItem[]; next: string | undefined; partial: boolean }
const PageReader = { parse(body: unknown): ReadPage {
 if (!isRecord(body) || !Array.isArray(body["lessons"])) throw new Error("not a page");
 const list = body["list"] === "proposed" || body["list"] === "retired" ? body["list"] : "approved";
 return { list, canDecide: body["canDecide"] === true, lessons: readLessons(body["lessons"]), next: str(body["next"]) ? body["next"] : undefined, partial: body["partial"] === true };
} };
const ModeReader = { parse(body: unknown): LessonModeResponse {
 const mode = (value: unknown): LessonMode | undefined => (value === "off" || value === "suggest" || value === "auto" ? value : undefined);
 if (!isRecord(body) || mode(body["mode"]) === undefined || !str(body["project"])) throw new Error("not a mode");
 return { project: body["project"], mode: mode(body["mode"])!, effective: mode(body["effective"]) ?? mode(body["mode"])!, lockedByCompany: body["lockedByCompany"] === true, canChange: body["canChange"] === true };
} };
const RequestsReader = { parse(body: unknown): { requests: LessonRetireRequest[]; more: boolean } {
 if (!isRecord(body) || !Array.isArray(body["requests"])) throw new Error("not requests");
 return { more: body["more"] === true, requests: body["requests"].filter((one): one is LessonRetireRequest => isRecord(one) && str(one["lessonId"]) && str(one["title"]) && str(one["by"]) && fin(one["at"])) };
} };
const TaskLessonsReader = { parse(body: unknown): TaskLesson[] {
 if (!isRecord(body) || !Array.isArray(body["lessons"])) throw new Error("not task lessons");
 return body["lessons"].filter((one): one is TaskLesson => isRecord(one) && str(one["lessonId"]) && fin(one["version"]) && typeof one["visible"] === "boolean");
} };
const ResultsReader = { parse(body: unknown): LessonDecisionResult[] {
 if (!isRecord(body) || !Array.isArray(body["results"])) throw new Error("not results");
 return body["results"].filter((one): one is LessonDecisionResult => isRecord(one) && str(one["lessonId"]) && (one["ok"] === true ? str(one["status"]) : one["ok"] === false && str(one["message"])));
} };
const StatusReader = { parse(body: unknown): { status: string } {
 if (!isRecord(body)) throw new Error("not an answer");
 return { status: str(body["status"]) ? body["status"] : "unknown" };
} };
const AnyReader = { parse(body: unknown): Record<string, unknown> { if (!isRecord(body)) throw new Error("not an answer"); return body; } };

/** These routes answer 200 only: a 202 this build does not know is an unreadable answer, never a success. */
const settled = <T,>(result: SendResult<T>): T => { if (result.kind !== "done") throw new ApiError(502, "INVALID_RESPONSE", "Rovara returned an unreadable response. Reload this page.");return result.value; };
const projectPath = (project: string) => "/v1/app/projects/" + encodeURIComponent(project);
const lessonPath = (project: string, lessonId: string) => projectPath(project) + "/lessons/" + encodeURIComponent(lessonId);

export function createLearnedApi(host: AppHost) {
 const api = createApiClient(host);
 return {
  inbox: () => api.get("/v1/app/lessons/inbox", InboxReader),
  page: (project: string, list: LessonList, cursor?: string) => api.get(projectPath(project) + "/lessons?" + new URLSearchParams({ list, ...(cursor === undefined ? {} : { cursor }) }).toString(), PageReader),
  mode: (project: string) => api.get(projectPath(project) + "/lessons/mode", ModeReader),
  retireRequests: (project: string) => api.get(projectPath(project) + "/lessons/retire-requests", RequestsReader),
  taskLessons: (project: string, taskId: string) => api.get(projectPath(project) + "/tasks/" + encodeURIComponent(taskId) + "/lessons", TaskLessonsReader),
  async decide(project: string, decisions: LessonDecision[]) { return settled(await api.send("POST", projectPath(project) + "/lessons/decisions", { decisions }, ResultsReader, NEVER)); },
  async keep(project: string, lessonId: string, version: number, edit?: LessonEdit) { return settled(await api.send("POST", lessonPath(project, lessonId) + "/approve", { version, ...(edit === undefined ? {} : { edit }) }, StatusReader, NEVER)); },
  async drop(project: string, lessonId: string, version: number, reason: LessonRejectReason) { return settled(await api.send("POST", lessonPath(project, lessonId) + "/reject", { version, reason }, StatusReader, NEVER)); },
  async retire(project: string, lessonId: string, reason: LessonRetireReason) { return settled(await api.send("POST", lessonPath(project, lessonId) + "/retire", { reason }, StatusReader, NEVER)); },
  async askRetire(project: string, lessonId: string) { return settled(await api.send("POST", lessonPath(project, lessonId) + "/retire-request", {}, AnyReader, NEVER)); },
  async setMode(project: string, mode: LessonMode) { return settled(await api.send("PUT", projectPath(project) + "/lessons/mode", { mode }, ModeReader, NEVER)); },
  async notHelpful(project: string, taskId: string, lessonId: string) { return settled(await api.send("POST", projectPath(project) + "/tasks/" + encodeURIComponent(taskId) + "/lessons/" + encodeURIComponent(lessonId) + "/not-helpful", {}, AnyReader, NEVER)); },
 };
}
export function useLearnedApi() { const host = useAppHost();return useMemo(() => createLearnedApi(host), [host]); }
export const learnedKey = (project: string) => ["learned", "project", project] as const;
export const INBOX_KEY = ["learned", "inbox"] as const;
/** The inbox is read once and again after the person sends decisions or leaves the card, not on every focus (the card shows what was just decided until then). */
export function useLessonInbox() { const api = useLearnedApi();return useQuery({ queryKey: INBOX_KEY, queryFn: () => api.inbox(), refetchOnWindowFocus: false, staleTime: 60_000 }); }
export function useLessonPages(project: string, list: LessonList, enabled = true) {
 const api = useLearnedApi();
 return useInfiniteQuery({ queryKey: [...learnedKey(project), "list", list], enabled, initialPageParam: undefined as string | undefined, queryFn: ({ pageParam }) => api.page(project, list, pageParam), getNextPageParam: last => last.next });
}
export function useLessonMode(project: string) { const api = useLearnedApi();return useQuery({ queryKey: [...learnedKey(project), "mode"], queryFn: () => api.mode(project) }); }
export function useRetireRequests(project: string, enabled: boolean) { const api = useLearnedApi();return useQuery({ queryKey: [...learnedKey(project), "retire-requests"], enabled, queryFn: () => api.retireRequests(project) }); }
export function useTaskLessons(project: string, taskId: string) { const api = useLearnedApi();return useQuery({ queryKey: [...learnedKey(project), "task", taskId], queryFn: () => api.taskLessons(project, taskId) }); }
