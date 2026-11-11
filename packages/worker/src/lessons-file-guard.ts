// Lessons in the repo, lane R2 (owner decision 50.4; design LESSONS-REPO-FILE-DESIGN.md rev 2 section 8): a Rovara TASK may not push a change to `.rovara/lessons.md`. The file is the team's and changes only through Rovara's weekly
// lessons pull request, which a person merges. This is the worker's check, made on the commit it is about to push, before any credential is fetched or anything is sent; the broker re-checks the pull request through the code
// host before it is marked ready or merged (`packages/broker/src/rovara-code/lessons-file-guard.ts`). It looks at every path the commits add, change, delete or rename (a rename counts under both names; `--no-renames` lists each side),
// compared as NFC and without case, and at `.rovara` itself (the folder swapped for a file or a link). A diff that cannot be read fails closed.
import { COMPANY_RULES_DEFAULT_FILE_PATH, LESSON_FILE_PATH, agentXError } from "@agentx/contracts";

/** The sentence a task fails with. Fixed words: no path, no repository text. */
export const LESSONS_FILE_REFUSAL = "This change touches .rovara/lessons.md, which is the team's file and changes only through Rovara's weekly lessons pull request. Take that file out of the change.";
/**
 * G-04: the company rules file (`.rovara/company-rules.md`, the default a company connects) is the company's own and changes only through Rovara's pull request for an approved version, or a person's edit that an admin then adopts and a
 * second admin approves. A task may not push a change to it either. (The path a company connected under another name is checked by the broker before a merge: the worker does not know it.)
 */
export const COMPANY_RULES_FILE_REFUSAL = "This change touches .rovara/company-rules.md, which is the company's file and changes only through the company rules in Rovara. Take that file out of the change.";
export const LESSONS_FILE_MERGE_REFUSAL = "This merge combines changes to .rovara/lessons.md that came from both sides (the pull request and the base branch). Resolve the file by taking one side's version of it exactly, then try again.";
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Whether a changed path is the default company rules file or would replace it (the file itself; `.rovara` as a file or link is the lessons check's). */
export function isCompanyRulesFilePath(path: string): boolean {
  const folded = path.normalize("NFC").toLowerCase().replace(/\\/gu, "/").replace(/^(?:\.\/)+/u, "").replace(/\/+$/u, "");
  const file = COMPANY_RULES_DEFAULT_FILE_PATH.toLowerCase();
  return folded === file || folded.startsWith(`${file}/`);
}

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
  const paths = listed.split("\0").filter((path) => path !== "");
  if (paths.some(isLessonsFilePath)) throw agentXError("CONFIG_INVALID", LESSONS_FILE_REFUSAL);
  if (paths.some(isCompanyRulesFilePath)) throw agentXError("CONFIG_INVALID", COMPANY_RULES_FILE_REFUSAL);
}

/**
 * The guard for a push that adds a commit on top of a pull request that already exists (a fix round, a conflict round, a base merge: `maintain-pull-request.ts`). What counts is what THIS commit introduces, not what the pull
 * request or the base already held: a path is flagged only when the commit differs from EVERY parent in it. A clean merge of the base takes each file from one parent and is not flagged; a person's earlier change to the file
 * (already on the branch) is not flagged; a fix commit that edits the file differs from its only parent and is. A root commit is compared with the empty tree. A diff that cannot be read fails closed.
 */
export async function assertPushCarriesNoLessonsFile(git: (args: string[]) => Promise<string>, commit: string): Promise<void> {
  let parents: string[];
  try { parents = (await git(["rev-list", "--parents", "-n", "1", commit])).trim().split(/\s+/u).slice(1); } catch { throw agentXError("CONFIG_INVALID", "Rovara could not read the commit it was about to push, so it did not push"); }
  const touched = new Map<string, number>();
  const against = parents.length === 0 ? [EMPTY_TREE] : parents;
  for (const parent of against) {
    let listed: string;
    try { listed = await git(["diff", "--name-only", "-z", "--no-renames", "--ignore-submodules=none", parent, commit]); } catch { throw agentXError("CONFIG_INVALID", "Rovara could not read the list of files this push changes, so it did not push"); }
    for (const path of new Set(listed.split("\0").filter((name) => name !== "" && (isLessonsFilePath(name) || isCompanyRulesFilePath(name))))) touched.set(path, (touched.get(path) ?? 0) + 1);
  }
  const carried = [...touched.entries()].filter(([, count]) => count === against.length).map(([path]) => path);
  if (carried.length > 0) throw agentXError("CONFIG_INVALID", carried.every(isCompanyRulesFilePath) && !carried.some(isLessonsFilePath) ? COMPANY_RULES_FILE_REFUSAL : against.length > 1 ? LESSONS_FILE_MERGE_REFUSAL : LESSONS_FILE_REFUSAL);
}
