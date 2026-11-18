import { z } from "zod";
import { forwardReader } from "./forward-reader.js";

const Project = z.string().min(1).max(100);
const SmallRecord = z.record(z.string(), z.unknown());
export const WeeklySummarySchema = z.object({ project: Project, on: z.boolean(), source: z.enum(["chosen", "pilot_default", "default"]), canChange: z.boolean() }).strict();
export const WeeklyLessonsSchema = z.object({ project: Project, weekly: z.object({ needLook: z.array(SmallRecord).max(50), picks: z.array(SmallRecord).max(50) }).strict() }).strict();
export const LessonReplaySchema = z.object({ project: Project, tasks: z.array(SmallRecord).max(100), totals: SmallRecord }).strict();
export const LessonTuningSchema = z.object({ project: Project, windowDays: z.number().int(), ready: z.boolean(), message: z.string(), evidence: SmallRecord, suggestions: z.array(SmallRecord).max(100), note: z.string() }).strict();
export const LessonRepeatsSchema = z.object({ project: Project, month: z.string(), repeated: z.number().int(), corrections: z.number().int(), enoughData: z.boolean(), split: SmallRecord, unjudged: z.number().int(), truncated: z.boolean() }).strict();
export const CompanyLessonRepeatsSchema = z.object({ scope: z.literal("company"), month: z.string(), projects: z.array(SmallRecord).max(100), repeated: z.number().int(), corrections: z.number().int(), enoughData: z.boolean() }).strict();
export const WeeklySummaryReaderSchema = forwardReader(WeeklySummarySchema);
export const WeeklyLessonsReaderSchema = forwardReader(WeeklyLessonsSchema);
export const LessonReplayReaderSchema = forwardReader(LessonReplaySchema);
export const LessonTuningReaderSchema = forwardReader(LessonTuningSchema);
export const LessonRepeatsReaderSchema = forwardReader(LessonRepeatsSchema);
export const CompanyLessonRepeatsReaderSchema = forwardReader(CompanyLessonRepeatsSchema);
