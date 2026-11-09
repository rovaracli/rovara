// Lessons in the repo, lane R2 (owner decision 50.4; design LESSONS-REPO-FILE-DESIGN.md rev 2 section 8): a Rovara TASK's pull request may not add, change, delete or rename `.rovara/lessons.md`. The file is the team's and changes only
// through Rovara's weekly lessons pull request, which a person merges. This is the broker's check (the worker refuses to push such a diff in the first place: `packages/worker/src/lessons-file-guard.ts`); it is run through the code
// host's neutral `changedFiles` (via `changedPathsOf`), before a Rovara pull request is marked ready and before it is merged. It fails closed: a list that is incomplete or cannot be read is not "clean".
// Rovara's own lessons pull requests are not tasks and never come here (they have their own write path).
//
// Why there is no check before a pull request is marked ready (design section 8 names one): every Rovara push goes through a worker guard (`publish.ts` for the first push, `maintain-pull-request.ts#push` for every fix, update and
// base-merge push), so no pull request Rovara pushes can contain a change to the file, and a merge made by hand on the code host cannot introduce one either. A mark-ready check would cost one unbudgeted `changedFiles` read in the
// budgeted tracking pass for a case the push guard already closes.
import { LESSON_FILE_PATH, type ChangeRequestRef, type CodeHost, type HostScope } from "@agentx/contracts";
import { changedPathsOf } from "./host-port.js";

/** Whether a changed path is the lessons file, or something that would replace it: the file itself, or `.rovara` (the folder swapped for a file or a link), compared as NFC and without case (a checkout on a case-insensitive disk writes the same file). */
export function touchesLessonsFile(path: string): boolean {
  const folded = path.normalize("NFC").toLowerCase().replace(/\\/gu, "/").replace(/^(?:\.\/)+/u, "").replace(/\/+$/u, "");
  const file = LESSON_FILE_PATH.toLowerCase();
  return folded === file || folded === ".rovara" || folded.startsWith(`${file}/`);
}

export type LessonsFileVerdict = { ok: true } | { ok: false; reason: "touches" | "incomplete" | "unreadable" };

/** Whether the change request leaves the lessons file alone. A renamed file counts under both its names (the host's `previousPath`). */
export async function leavesLessonsFileAlone(codeHost: Pick<CodeHost, "changedFiles">, ref: ChangeRequestRef, scope: HostScope): Promise<LessonsFileVerdict> {
  try {
    const changed = await changedPathsOf(codeHost as CodeHost, ref, scope);
    if (changed.paths.some(touchesLessonsFile)) return { ok: false, reason: "touches" };
    return changed.complete ? { ok: true } : { ok: false, reason: "incomplete" };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}
