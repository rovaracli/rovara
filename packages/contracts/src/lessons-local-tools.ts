// Lessons for local coding tools (decision 46b, lane B1/B2): `POST /v1/dev/projects/{project}/lessons`, what the `agentx lessons` command and the `rovara_lessons` MCP tool send and read. The request is a POST so that the
// task text and file names ride in the body, never in an address a proxy or an access log keeps. Not browser-safe on purpose: the web app does not use it (it is not in `web.ts`).
import { z } from "zod";
import { forwardReader } from "./forward-reader.js";

export const LOCAL_LESSONS_STAGES = ["plan", "code", "review"] as const;
export const LocalLessonsStageSchema = z.enum(LOCAL_LESSONS_STAGES);
export const LOCAL_LESSONS_TASK_MAX = 2_000;
export const LOCAL_LESSONS_FILES_MAX = 50;
export const LOCAL_LESSONS_REMOTE_MAX = 400;
const NoControl = (value: string): boolean => !/[\p{Cc}\p{Cf}]/u.test(value);

/** The git remote of the checkout (`repo`), a one-line summary of the change (`task`), the files it will touch and the stage. Nothing else: no project (it is in the path), no person. */
export const LocalLessonsBodySchema = z.object({
  repo: z.string().min(1).max(LOCAL_LESSONS_REMOTE_MAX).refine(NoControl, "must not contain control characters").optional(),
  task: z.string().max(LOCAL_LESSONS_TASK_MAX).optional(),
  files: z.array(z.string().min(1).max(400).refine(NoControl, "must not contain control characters")).max(LOCAL_LESSONS_FILES_MAX).optional(),
  stage: LocalLessonsStageSchema.optional(),
  /** The whole allowed set for the repository in one block (at most 300 lessons and 64 KB), for a tool that wants one block at session start. */
  all: z.boolean().optional(),
  /** The tool reads the repository's `.rovara/lessons.md`: leave out the lessons already merged into it. Without this, those lessons are returned and marked `inRepoFile`. */
  skipRepoFile: z.boolean().optional(),
}).strict();
export type LocalLessonsBody = z.infer<typeof LocalLessonsBodySchema>;

export const LOCAL_LESSONS_OFF_REASONS = ["install_switch", "company_stays", "learning_off", "regulated", "project_setting"] as const;
export const LocalLessonSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/u), advice: z.string().max(400),
  why: z.string().max(400).optional(), citation: z.string().max(260).optional(), inRepoFile: z.literal(true).optional(),
}).strict();
export const LocalLessonsResponseSchema = z.object({
  status: z.enum(["ok", "off"]), reason: z.enum(LOCAL_LESSONS_OFF_REASONS).optional(), message: z.string().max(400),
  project: z.string().max(100), repo: z.string().max(400).optional(),
  lessons: z.array(LocalLessonSchema).max(300), markdown: z.string().max(100_000), complete: z.boolean(),
}).strict();
export type LocalLessonsResponse = z.infer<typeof LocalLessonsResponseSchema>;
/** What a client reads of the answer: a newer server's extra fields are kept, not refused. */
export const LocalLessonsResponseReaderSchema = forwardReader(LocalLessonsResponseSchema);
