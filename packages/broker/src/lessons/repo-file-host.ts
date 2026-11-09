// Lessons in the repo, lane R2: the few host reads the publish pass and the erasure sweep share. A repository as the lessons code sees it is a `CodeHost` (the neutral port), a repository reference and a scope.
import { randomBytes } from "node:crypto";
import { LESSON_FILE_BRANCH_PREFIX, type CodeHost, type HostScope, type RepositoryRef } from "@agentx/contracts";

/** One repository of a project, with the code host that serves it and the scope to call it in. Provider-neutral: the host is the `CodeHost` port. */
export interface RepoFileTarget { name: string; place: string; repository: RepositoryRef; scope: HostScope; host: CodeHost }

/** The head of a branch, or undefined when the host cannot say (a branch that is gone and a host that is down look the same, and neither is "Rovara's own"). */
export const headOf = (target: RepoFileTarget, branch: string): Promise<string | undefined> => target.host.baseBranchHead(target.repository, branch, target.scope).then((head) => head, () => undefined);

/**
 * A branch name nobody has: 12 random hex digits, and asked of the host first. A name that already exists is never used (nothing is adopted, and Rovara must never later delete a branch it did not make); the adapter
 * refuses it as well, so this is the second lock. Undefined after five tries (the caller stops: a conflict).
 */
export async function freshBranchName(source: { randomHex?(): string }, target: RepoFileTarget): Promise<string | undefined> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const branch = `${LESSON_FILE_BRANCH_PREFIX}${source.randomHex?.() ?? randomBytes(6).toString("hex")}`;
    if (await headOf(target, branch) === undefined) return branch;
  }
  return undefined;
}
