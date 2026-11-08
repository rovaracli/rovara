// The Lessons tab, Sources tab and task-page lessons calls (learning v2, L3b). The server decides who may see and decide each lesson; this file only sends and reads. A write is sent once from
// the browser session and never retried (`retry: "never"`): a stale version, a refusal or a throttle is thrown as an `ApiError` for the screen to show in the server's own fixed words.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  DeveloperTaskViewSchema, LessonApproveAnswerReaderSchema, LessonApproveBodySchema, LessonDoneAnswerReaderSchema, LessonFeedbackBodySchema, LessonHistoryReaderSchema, LessonPresetAnswerReaderSchema, LessonPresetBodySchema, LessonRejectBodySchema,
  LessonResumeAnswerReaderSchema, LessonResumeSourceBodySchema, LessonRetireBodySchema, LessonRollbackAnswerReaderSchema, LessonRollbackBodySchema, LessonSourcesReaderSchema, LessonsDigestReaderSchema, LessonsViewReaderSchema, LoadedLessonsReaderSchema,
  ProjectOverviewProjectSchema,
} from "@agentx/contracts/web";
import type { z } from "zod";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient, type SendResult } from "./client.js";
import { ApiError } from "./errors.js";

export type LessonsView = ReturnType<typeof LessonsViewReaderSchema.parse>;
export type LessonItem = LessonsView["waiting"][number];
export type LessonsDigest = ReturnType<typeof LessonsDigestReaderSchema.parse>;
export type LessonSources = ReturnType<typeof LessonSourcesReaderSchema.parse>;
export type LessonHistory = ReturnType<typeof LessonHistoryReaderSchema.parse>;
export type LoadedLessons = ReturnType<typeof LoadedLessonsReaderSchema.parse>;
export type LoadedLessonRow = LoadedLessons["lessons"][number];

const NEVER = { retry: "never" } as const;
const base = (project: string) => "/v1/app/projects/" + encodeURIComponent(ProjectOverviewProjectSchema.shape.name.parse(project)) + "/lessons";
const taskBase = (taskId: string) => "/v1/app/tasks/" + encodeURIComponent(DeveloperTaskViewSchema.shape.taskId.parse(taskId)) + "/lessons";
/** These routes answer 200 only; a 202 this build does not know is an unreadable answer, never a success. */
const settled = <T,>(result: SendResult<T>): T => { if (result.kind !== "done") throw new ApiError(502, "INVALID_RESPONSE", "Rovara returned an unreadable response. Reload this page.");return result.value; };
type ApproveInput = z.input<typeof LessonApproveBodySchema>;
type RejectInput = z.input<typeof LessonRejectBodySchema>;

export function createLessonsApi(host: AppHost) {
 const api = createApiClient(host), one = (id: string) => encodeURIComponent(id);
 return {
  view: (project: string) => api.get(base(project), LessonsViewReaderSchema),
  digest: (project: string) => api.get(base(project) + "/digest", LessonsDigestReaderSchema),
  sources: (project: string) => api.get(base(project) + "/sources", LessonSourcesReaderSchema),
  history: (project: string, id: string) => api.get(base(project) + "/" + one(id) + "/history", LessonHistoryReaderSchema),
  async approve(project: string, id: string, input: ApproveInput) { return settled(await api.send("POST", base(project) + "/" + one(id) + "/approve", LessonApproveBodySchema.parse(input), LessonApproveAnswerReaderSchema, NEVER)); },
  async reject(project: string, id: string, input: RejectInput) { return settled(await api.send("POST", base(project) + "/" + one(id) + "/reject", LessonRejectBodySchema.parse(input), LessonDoneAnswerReaderSchema, NEVER)); },
  async retire(project: string, id: string, reason?: string) { return settled(await api.send("POST", base(project) + "/" + one(id) + "/retire", LessonRetireBodySchema.parse(reason === undefined ? {} : { reason }), LessonDoneAnswerReaderSchema, NEVER)); },
  async rollback(project: string, input: z.input<typeof LessonRollbackBodySchema>) { return settled(await api.send("POST", base(project) + "/rollback", LessonRollbackBodySchema.parse(input), LessonRollbackAnswerReaderSchema, NEVER)); },
  /** UX-4b: a maintainer resumes a paused source; the lessons held while it was paused wait for people again (none goes live from here). */
  async resume(project: string, source: string, scope: string) { return settled(await api.send("POST", base(project) + "/sources/resume", LessonResumeSourceBodySchema.parse({ source, scope }), LessonResumeAnswerReaderSchema, NEVER)); },
  loaded: (taskId: string) => api.get(taskBase(taskId), LoadedLessonsReaderSchema),
  /** A maintainer makes this project stricter: every lesson needs a person first (Regulated). */
  async requirePerson(project: string) { return settled(await api.send("POST", base(project) + "/preset", LessonPresetBodySchema.parse({ preset: "regulated" }), LessonPresetAnswerReaderSchema, NEVER)); },
  async mark(taskId: string, lessonId: string, kind: "helpful" | "wrong_here" | "thumbs_down") { return settled(await api.send("POST", taskBase(taskId) + "/" + one(lessonId) + "/feedback", LessonFeedbackBodySchema.parse({ kind }), LessonDoneAnswerReaderSchema, NEVER)); },
 };
}
export function useLessonsApi() { const host = useAppHost();return useMemo(() => createLessonsApi(host), [host]); }
export const lessonsKey = (project: string) => ["lessons", project] as const;
export function useLessons(project: string) { const api = useLessonsApi();return useQuery({ queryKey: [...lessonsKey(project), "view"], queryFn: () => api.view(project) }); }
export function useLessonsDigest(project: string, enabled: boolean) { const api = useLessonsApi();return useQuery({ queryKey: [...lessonsKey(project), "digest"], enabled, queryFn: () => api.digest(project) }); }
export function useLessonSources(project: string) { const api = useLessonsApi();return useQuery({ queryKey: [...lessonsKey(project), "sources"], queryFn: () => api.sources(project) }); }
export function useLessonHistory(project: string, id: string, enabled: boolean) { const api = useLessonsApi();return useQuery({ queryKey: [...lessonsKey(project), "history", id], enabled, queryFn: () => api.history(project, id) }); }
export function useLoadedLessons(taskId: string, enabled: boolean) { const api = useLessonsApi();return useQuery({ queryKey: ["task", taskId, "lessons"], enabled, retry: false, queryFn: () => api.loaded(taskId) }); }
