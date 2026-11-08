// Learning v2 (DECISIONS 24): "Lessons used", the list of lessons a task loaded that its pull request description shows, each with a link to the task page ready to mark the lesson not helpful.
// The pull request description is read by everyone who can see the repository, so only lessons of the project's own audience are listed (never one learned from a restricted place), only those that
// reached the agent's prompt, at most LESSONS_USED_MAX, and each title is the lesson's own (the caller makes it inert). The reader is plugged in at handler start where lessons are on
// (`setLessonsUsedReader`), the way Home's lessons card is; without it, or with learning off for the project, the description has no section.
import type { AccessCheckPort } from "../team-record/access-port.js";
import { readVisible } from "./read-visible.js";
import { modeAllows, resolveLearning, type LearningSettingsReader } from "./policy.js";
import type { LessonStore, ScopeKey } from "./store.js";
import { isRestricted } from "./types.js";

export const LESSONS_USED_MAX = 30;
export interface LessonUsed { id: string; title: string; notHelpfulUrl: string }
export interface LessonsUsedInput { orgId: string; project: string; taskId: string; /** The task page's address (https); the link is this page with the lesson named. */ pageUrl: string | undefined }
export type LessonsUsedReader = (input: LessonsUsedInput) => Promise<readonly LessonUsed[]>;

let reader: LessonsUsedReader | undefined;
export function setLessonsUsedReader(next: LessonsUsedReader | undefined): void { reader = next; }
/** The lessons the task used, or none: never throws (a description never waits on, or fails because of, lessons). */
export async function lessonsUsedForTask(input: LessonsUsedInput): Promise<readonly LessonUsed[]> {
  const read = reader;
  if (read === undefined || input.pageUrl === undefined) return [];
  try { return await read(input); } catch { return []; }
}

const REACHED = new Set(["valid", "moved", "none"]);
/** The link: the task page with `notHelpful=<lesson id>`; the page asks before it marks anything. */
export function notHelpfulUrl(pageUrl: string, lessonId: string): string | undefined {
  try {
    const url = new URL(pageUrl);
    if (url.protocol !== "https:") return undefined;
    url.search = ""; url.hash = "";
    url.searchParams.set("notHelpful", lessonId);
    return url.href;
  } catch { return undefined; }
}

export function lessonsUsedReaderOver(deps: { store: LessonStore; settings: LearningSettingsReader; access: AccessCheckPort }): LessonsUsedReader {
  return async (input) => {
    if (input.pageUrl === undefined) return [];
    const key: ScopeKey = { workspaceId: input.orgId, project: input.project };
    if (!modeAllows((await resolveLearning(deps.settings, key.workspaceId, key.project)).mode, "load")) return [];
    const seen = new Set<string>();
    const out: LessonUsed[] = [];
    for (const manifest of await deps.store.manifests(key, input.taskId)) {
      for (const entry of manifest.lessons) {
        if (seen.has(entry.id) || !REACHED.has(entry.citation)) continue;
        seen.add(entry.id);
        const lesson = await deps.store.get(key, entry.id);
        // Read as "nobody in particular" (a shared task): a lesson from a restricted place, or one whose place the access records restrict now, is not named in a description the repository's readers see.
        if (lesson === undefined || isRestricted(lesson) || (await readVisible({ access: deps.access, key, viewer: undefined, lessons: [lesson], where: "pull_request" })).length !== 1) continue;
        const url = notHelpfulUrl(input.pageUrl, lesson.id);
        if (url === undefined) continue;
        out.push({ id: lesson.id, title: lesson.title, notHelpfulUrl: url });
        if (out.length >= LESSONS_USED_MAX) return out;
      }
    }
    return out;
  };
}
