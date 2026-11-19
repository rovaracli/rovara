import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { WeeklyLessonsReaderSchema, WeeklySummaryReaderSchema, LessonReplayReaderSchema, LessonTuningReaderSchema, LessonRepeatsReaderSchema, CompanyLessonRepeatsReaderSchema } from "@agentx/contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient } from "./client.js";
import { learnedKey } from "./learned.js";

const NEVER = { retry: "never" } as const;
const AnswerReader = { parse(value: unknown): unknown { return value; } };
const base = (project: string) => `/v1/app/projects/${encodeURIComponent(project)}/lessons`;
export function createLessonsExtrasApi(host: AppHost) {
 const api = createApiClient(host);
 return {
  weekly: (project: string) => api.get(base(project) + "/weekly", WeeklyLessonsReaderSchema),
  summary: (project: string) => api.get(base(project) + "/weekly-summary", WeeklySummaryReaderSchema),
  async setSummary(project: string, on: boolean) { return api.send("PUT", base(project) + "/weekly-summary", { on }, WeeklySummaryReaderSchema, NEVER); },
  async keep(project: string, lessonId: string) { return api.send("POST", base(project) + "/" + encodeURIComponent(lessonId) + "/keep", {}, AnswerReader, NEVER); },
  async trial(project: string, decision: "accept" | "not_now") { return api.send("POST", base(project) + "/mode/trial-offer", { decision }, AnswerReader, NEVER); },
  replay: (project: string, tasks: number) => api.get(base(project) + `/replay?tasks=${tasks}`, LessonReplayReaderSchema),
  tuning: (project: string) => api.get(base(project) + "/tuning", LessonTuningReaderSchema),
  repeats: (project: string) => api.get(base(project) + "/repeats", LessonRepeatsReaderSchema),
  companyRepeats: () => api.get("/v1/app/lessons/repeats", CompanyLessonRepeatsReaderSchema),
 };
}
export function useLessonsExtrasApi() { const host = useAppHost();return useMemo(() => createLessonsExtrasApi(host), [host]); }
export function useWeeklyLessons(project: string, enabled: boolean) { const api = useLessonsExtrasApi();return useQuery({ queryKey: [...learnedKey(project), "weekly"], enabled, queryFn: () => api.weekly(project), retry: false }); }
export function useWeeklySummary(project: string) { const api = useLessonsExtrasApi();return useQuery({ queryKey: [...learnedKey(project), "weekly-summary"], queryFn: () => api.summary(project), retry: false }); }
export function useLessonReplay(project: string, tasks: number, enabled: boolean) { const api = useLessonsExtrasApi();return useQuery({ queryKey: [...learnedKey(project), "replay", tasks], queryFn: () => api.replay(project, tasks), enabled, retry: false }); }
export function useLessonTuning(project: string, enabled: boolean) { const api = useLessonsExtrasApi();return useQuery({ queryKey: [...learnedKey(project), "tuning"], queryFn: () => api.tuning(project), enabled, retry: false }); }
export function useLessonRepeats(project: string) { const api = useLessonsExtrasApi();return useQuery({ queryKey: [...learnedKey(project), "repeats"], queryFn: () => api.repeats(project), retry: false }); }
export function useCompanyLessonRepeats(enabled = true) { const api = useLessonsExtrasApi();return useQuery({ queryKey: ["lessons", "company", "repeats"], queryFn: () => api.companyRepeats(), enabled, retry: false }); }
