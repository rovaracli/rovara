// Learning v2 (L4): what the broker sends a worker as `learnedContext` for one stage, and what the worker reports back. The payload field in the
// worker invocation (protocol.ts) and the feature string `task.learnedContext.v1` are added by the record-core lane (R1); the shape lives here so the
// broker's loader and the worker's validator read one definition. Strict: a field this build does not know is refused, never ignored.
import { z } from "zod";

export const LEARNED_CONTEXT_FEATURE = "task.learnedContext.v1" as const;
export const LEARNED_CONTEXT_MAX_LESSONS = 12;
export const LEARNED_CONTEXT_MAX_BYTES = 6 * 1024;
export const LESSON_STAGES = ["UNDERSTAND", "PLAN", "IMPLEMENT", "PLAN_CRITIQUE", "REVIEW"] as const;
export const LessonStageSchema = z.enum(LESSON_STAGES);
export type LessonStage = z.infer<typeof LessonStageSchema>;
export const LESSON_TYPES = ["fact", "convention", "pitfall", "procedure", "preference", "review_check"] as const;
export const LessonTypeSchema = z.enum(LESSON_TYPES);
export type LessonType = z.infer<typeof LessonTypeSchema>;

const RepoName = z.string().min(1).max(200);
const RelativePath = z.string().min(1).max(400).refine((p) => !p.startsWith("/") && !p.split("/").includes(".."), "the path stays inside the repository");

export const CodeCitationSchema = z.object({
  kind: z.literal("code"), repo: RepoName, path: RelativePath,
  startLine: z.number().int().min(1).max(10_000_000), endLine: z.number().int().min(1).max(10_000_000),
  /** The first cited line, copied from the file. */
  anchor: z.string().min(1).max(400), commit: z.string().regex(/^[a-f0-9]{7,64}$/u),
}).strict().refine((c) => c.endLine >= c.startLine && c.endLine - c.startLine <= 400, "the range is at most 400 lines");
export type CodeCitation = z.infer<typeof CodeCitationSchema>;

export const LearnedLessonSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/u), version: z.number().int().min(1),
  type: LessonTypeSchema,
  title: z.string().min(1).max(80), description: z.string().max(160), body: z.string().min(1).max(600),
  /** A short human label of where the lesson applies, built by the broker (repo and paths). */
  scopeLabel: z.string().max(200),
  citations: z.array(CodeCitationSchema).max(6),
}).strict();
export type LearnedLesson = z.infer<typeof LearnedLessonSchema>;

export const LearnedContextSchema = z.object({
  v: z.literal(1), setVersion: z.number().int().min(0), stage: LessonStageSchema,
  lessons: z.array(LearnedLessonSchema).max(LEARNED_CONTEXT_MAX_LESSONS),
  /** For reviewer stages: the lessons the planner or coder loaded, so a reviewer can check whether one drove a bad change. */
  priorLoaded: z.array(z.object({ id: z.string().max(64), type: LessonTypeSchema, title: z.string().max(80) }).strict()).max(40).optional(),
}).strict();
export type LearnedContext = z.infer<typeof LearnedContextSchema>;

export const LESSON_CITATION_RESULTS = ["valid", "moved", "stale_dropped", "unchecked_dropped", "none"] as const;
export const LoadReportSchema = z.object({
  v: z.literal(1), stage: LessonStageSchema,
  lessons: z.array(z.object({
    id: z.string().max(64), version: z.number().int().min(1), citation: z.enum(LESSON_CITATION_RESULTS),
    /** Corrected ranges for a moved citation, by position in the lesson's citations. */
    corrected: z.array(z.object({ index: z.number().int().min(0).max(5), startLine: z.number().int().min(1), endLine: z.number().int().min(1) }).strict()).max(6).optional(),
  }).strict()).max(LEARNED_CONTEXT_MAX_LESSONS),
}).strict();
export type LoadReport = z.infer<typeof LoadReportSchema>;
