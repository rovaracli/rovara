// Lessons in the repo, lane R2 (owner decision 50.4; design LESSONS-REPO-FILE-DESIGN.md rev 2 section 8): a Rovara TASK may not push a change to `.rovara/lessons.md`. The file is the team's and changes only through Rovara's weekly
// lessons pull request, which a person merges. This is the worker's check, made on the commit it is about to push, before any credential is fetched or anything is sent; the broker re-checks the pull request through the code
// host before it is marked ready or merged (`packages/broker/src/rovara-code/lessons-file-guard.ts`). It looks at every path the commits add, change, delete or rename (a rename counts under both names; `--no-renames` lists each side),
// compared as NFC and without case, and at `.rovara` itself (the folder swapped for a file or a link). A diff that cannot be read fails closed.
import { LESSON_FILE_PATH, agentXError } from "@agentx/contracts";

/** The sentence a task fails with. Fixed words: no path, no repository text. */
export const LESSONS_FILE_REFUSAL = "This change touches .rovara/lessons.md, which is the team's file and changes only through Rovara's weekly lessons pull request. Take that file out of the change.";
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Whether a changed path is the lessons file or would replace it (the file, or `.rovara` as a file or link). */
export function isLessonsFilePath(path: string): boolean {
  const folded = path.normalize("NFC").toLowerCase().replace(/\\/gu, "/").replace(/^(?:\.\/)+/u, "").replace(/\/+$/u, "");
  const file = LESSON_FILE_PATH.toLowerCase();
  return folded === file || folded === ".rovara" || folded.startsWith(`${file}/`);
}

/**
 * Throws (CONFIG_INVALID, the fixed sentence) when the commits from `base` to `commit` touch the lessons file. With no `base` the commit's first parent is the base (the empty tree for a root commit): a publication commit is one
 * commit on the latest base. `git` runs a Git command in the workspace's isolated repository and returns its output.
 */
export async function assertLessonsFileUntouched(git: (args: string[]) => Promise<string>, commit: string, base?: string): Promise<void> {
  let from = base;
  if (from === undefined) from = (await git(["rev-parse", "--verify", "--quiet", `${commit}^1`]).catch(() => "")).trim() || EMPTY_TREE;
  let listed: string;
  try { listed = await git(["diff", "--name-only", "-z", "--no-renames", "--ignore-submodules=none", from, commit]); } catch { throw agentXError("CONFIG_INVALID", "Rovara could not read the list of files this change touches, so it did not push"); }
  if (listed.split("\0").some((path) => path !== "" && isLessonsFilePath(path))) throw agentXError("CONFIG_INVALID", LESSONS_FILE_REFUSAL);
}
