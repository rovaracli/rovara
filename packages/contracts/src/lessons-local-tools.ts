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
export type LocalLessonsRead = z.output<typeof LocalLessonsResponseReaderSchema>;

/** What a local tool says, and then carries on, when Rovara cannot answer (offline, a failed read, too many requests). Never a stale copy of earlier lessons. */
export const LOCAL_LESSONS_UNAVAILABLE_LINE = "Rovara lessons are not available right now. Continue without them.";
/** What a tool says when the repository is not one of the project's (the broker's answer is the same as for a missing project). */
export const LOCAL_LESSONS_NOT_FOUND_LINE = "No Rovara lessons: this repository is not one of your Rovara project's repositories. Continue without them.";
/** The tool's own words when it cannot tell which project: no checkout remote and no project given, or several projects that hold the repository. */
export const LOCAL_LESSONS_NO_PROJECT_LINE = "No Rovara lessons: say which Rovara project this is (pass the project), or run in a git checkout of one of its repositories. Continue without them.";
export const LOCAL_LESSONS_AMBIGUOUS_LINE = "No Rovara lessons: this repository is in more than one of your Rovara projects. Pass the project you mean. Continue without them.";
/** The most projects a client asks, one by one, when it was not told which project the checkout belongs to. */
export const LOCAL_LESSONS_PROJECTS_MAX = 25;
/** The lessons file a team merges into a repository (decision 50a); a tool that finds it in the checkout asks for the lessons that are not already in it. */
export const LOCAL_LESSONS_REPO_FILE = ".rovara/lessons.md";

/**
 * The description given to AI tools for the lessons tool (MCP) and the line for AGENTS.md (decision 51's setup lines). One text in one place, so the tool, the docs and a test say the same thing.
 */
export const LOCAL_LESSONS_TOOL_DESCRIPTION = `Get your team's lessons for this repository from Rovara: short rules learned from past reviews and fixes (conventions, pitfalls, facts about this code). `
  + `Call it once before you plan or write code in a repository, and again when you start on a different part of the code. Pass a one-line summary of the task and the files you expect to change. `
  + `Follow the lessons unless the user's request says otherwise. It returns nothing when no lesson fits or Rovara can't be reached; then continue normally. `
  + `Do not copy lesson text into code comments, commits or pull requests.`;

/** What one project said to a client that asked it for a repository's lessons. */
export type LocalLessonsAsk = { kind: "answer"; response: LocalLessonsRead } | { kind: "not_found" } | { kind: "unavailable" };
export type LocalLessonsAcross =
  | { kind: "answer"; project: string; response: LocalLessonsRead }
  | { kind: "none" } | { kind: "ambiguous" } | { kind: "unavailable" };
/**
 * A client that was not told the project asks each project the person is on, one at a time, and keeps the one whose registered repositories hold the checkout's remote (the broker answers "not found" for the others,
 * exactly as for a project that does not exist). Two projects holding the repository is `ambiguous`: the person names one. A failure of any ask is `unavailable`, never a guess. Pure over `ask`.
 */
export async function lessonsAcrossProjects(projects: readonly string[], ask: (project: string) => Promise<LocalLessonsAsk>): Promise<LocalLessonsAcross> {
  let found: { project: string; response: LocalLessonsRead } | undefined;
  for (const project of projects.slice(0, LOCAL_LESSONS_PROJECTS_MAX)) {
    const answer = await ask(project);
    if (answer.kind === "unavailable") return { kind: "unavailable" };
    if (answer.kind === "not_found") continue;
    if (found !== undefined) return { kind: "ambiguous" };
    found = { project, response: answer.response };
  }
  return found === undefined ? { kind: "none" } : { kind: "answer", ...found };
}
