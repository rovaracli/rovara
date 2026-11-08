// The ONE way lesson data reaches a person or an agent (fix round 10). Every function that returns lessons, lesson titles or lesson text to a caller (the loader, the digest, the
// panel, the approval queues, the prior-loaded list) takes its lessons through `readVisible`: the frozen snapshot AND the record core's access records, for the places each
// lesson was learned from. A caller without the access port gets nothing and a log line. `tests/unit/lessons/read-paths.test.ts` fails if a file reads the lesson store without
// importing this module or being listed there as an internal writer.
import { OrgIdSchema } from "@agentx/contracts";
import type { AccessCheckPort } from "../team-record/access-port.js";
import { createLessonLiveReader, type LessonLiveReader } from "./live-visibility.js";
import type { ScopeKey } from "./store.js";
import { lessonPlaces, satisfiesAcl, type IdentitySet, type Lesson } from "./types.js";

export type LessonLog = (event: string, fields: Record<string, unknown>) => void;

export interface ReadVisibleInput { access: AccessCheckPort; key: ScopeKey; viewer: IdentitySet | undefined; lessons: readonly Lesson[]; where: string; log?: LessonLog | undefined; /** One reader for a whole request (LV-1 M1): the tasks it has looked up are remembered across calls. Absent: a fresh one for this call. */ live?: LessonLiveReader | undefined }

/**
 * The lessons of `lessons` that `viewer` may read now. A viewer of `undefined` is nobody in particular (a project-wide running task, or a path whose readers are everyone): it reads only unrestricted lessons whose places no record
 * restricts and whose source tasks are all project-wide. An unreadable record throws RUNTIME_UNAVAILABLE (the caller decides what that means; none of them treats it as "visible"). `where` names the caller in the log line.
 */
export async function readVisible(input: ReadVisibleInput): Promise<Lesson[]> {
  if ((input.access as AccessCheckPort | undefined) === undefined) {
    input.log?.(`learning.${input.where}_no_access_port`, {});
    return [];
  }
  const frozen = input.lessons.filter((lesson) => lesson.provenance.audience.kind !== "restricted" || (input.viewer !== undefined && satisfiesAcl(input.viewer, lesson.provenance.audience.acl)));
  const placed = frozen.filter((lesson) => lessonPlaces(lesson).scopes.length > 0);
  const live = input.live ?? createLessonLiveReader({ port: input.access.taskVisibility, key: input.key, where: input.where, log: input.log });
  const keep = (lessons: Lesson[]): Promise<Lesson[]> => live.keep(input.viewer, lessons);
  if (placed.length === 0) return keep(frozen);
  const answers = await input.access.mayRead(OrgIdSchema.parse(input.key.workspaceId), input.viewer, placed.map((lesson) => lessonPlaces(lesson)));
  const allowed = new Set(placed.filter((_, index) => answers[index] === true).map((lesson) => lesson.id));
  return keep(frozen.filter((lesson) => !placed.includes(lesson) || allowed.has(lesson.id)));
}

/**
 * Reads RANKED lessons a page at a time until `enough` says the kept ones are enough (LV-1 M1), so the access and visibility reads are paid only for the best candidates, not for every lesson of the
 * project. `kept` keeps the ranking. `complete` is false when it stopped at `deadlineAt` (a wall-clock time, ms) with lessons unchecked: those are simply not offered. An unreadable record throws, as `readVisible` does.
 */
export async function readVisibleRanked(input: Omit<ReadVisibleInput, "lessons"> & { ranked: readonly Lesson[]; pageSize: number; enough: (kept: readonly Lesson[]) => boolean; deadlineAt?: number | undefined }): Promise<{ kept: Lesson[]; checked: number; complete: boolean }> {
  const kept: Lesson[] = [];
  const live = input.live ?? createLessonLiveReader({ port: input.access?.taskVisibility, key: input.key, where: input.where, log: input.log });
  let checked = 0;
  while (checked < input.ranked.length) {
    if (input.enough(kept)) return { kept, checked, complete: true };
    if (input.deadlineAt !== undefined && Date.now() >= input.deadlineAt) return { kept, checked, complete: false };
    const page = input.ranked.slice(checked, checked + input.pageSize);
    checked += page.length;
    kept.push(...await readVisible({ ...input, lessons: page, live }));
  }
  return { kept, checked, complete: true };
}
