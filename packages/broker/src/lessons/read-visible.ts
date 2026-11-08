// The ONE way lesson data reaches a person or an agent (fix round 10). Every function that returns lessons, lesson titles or lesson text to a caller (the loader, the digest, the
// panel, the approval queues, the prior-loaded list) takes its lessons through `readVisible`: the frozen snapshot AND the record core's access records, for the places each
// lesson was learned from. A caller without the access port gets nothing and a log line. `tests/unit/lessons/read-paths.test.ts` fails if a file reads the lesson store without
// importing this module or being listed there as an internal writer.
import { OrgIdSchema } from "@agentx/contracts";
import type { AccessCheckPort } from "../team-record/access-port.js";
import { liveVisible } from "./live-visibility.js";
import type { ScopeKey } from "./store.js";
import { lessonPlaces, satisfiesAcl, type IdentitySet, type Lesson } from "./types.js";

export type LessonLog = (event: string, fields: Record<string, unknown>) => void;

/**
 * The lessons of `lessons` that `viewer` may read now. A viewer of `undefined` is a shared task (nobody in particular): it reads only unrestricted lessons whose places no record
 * restricts. An unreadable record throws RUNTIME_UNAVAILABLE (the caller decides what that means; none of them treats it as "visible"). `where` names the caller in the log line.
 */
export async function readVisible(input: { access: AccessCheckPort; key: ScopeKey; viewer: IdentitySet | undefined; lessons: readonly Lesson[]; where: string; log?: LessonLog | undefined }): Promise<Lesson[]> {
  if ((input.access as AccessCheckPort | undefined) === undefined) {
    input.log?.(`learning.${input.where}_no_access_port`, {});
    return [];
  }
  const frozen = input.lessons.filter((lesson) => lesson.provenance.audience.kind !== "restricted" || (input.viewer !== undefined && satisfiesAcl(input.viewer, lesson.provenance.audience.acl)));
  const placed = frozen.filter((lesson) => lessonPlaces(lesson).scopes.length > 0);
  const live = (lessons: Lesson[]): Promise<Lesson[]> => liveVisible({ port: input.access.taskVisibility, key: input.key, viewer: input.viewer, lessons, where: input.where, log: input.log });
  if (placed.length === 0) return live(frozen);
  const answers = await input.access.mayRead(OrgIdSchema.parse(input.key.workspaceId), input.viewer, placed.map((lesson) => lessonPlaces(lesson)));
  const allowed = new Set(placed.filter((_, index) => answers[index] === true).map((lesson) => lesson.id));
  return live(frozen.filter((lesson) => !placed.includes(lesson) || allowed.has(lesson.id)));
}
