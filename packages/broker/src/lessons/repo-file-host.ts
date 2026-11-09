// Lessons in the repo, lane R2: the few host reads the publish pass and the erasure sweep share. A repository as the lessons code sees it is a `CodeHost` (the neutral port), a repository reference and a scope.
import { randomBytes } from "node:crypto";
import { LESSON_FILE_BRANCH_PREFIX, type CodeHost, type HostScope, type RepositoryRef } from "@agentx/contracts";
import type { PrRow } from "./repo-file-state.js";

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

/** The host kind a place names (`github:repo/123` is on `github`). */
export const hostKindOfPlace = (place: string): string => place.slice(0, Math.max(0, place.indexOf(":")));

/**
 * The repository's WATCH row: written when the feature is switched on and before the first host write in the repository, and it says who the repository is (its address and the project's name for it), so the erasure sweep can reach
 * it later even when the project no longer lists it. Rows already there keep what a sweep recorded on them (a repository it could not reach, a branch it could not match).
 */
export function watchRowOf(target: Pick<RepoFileTarget, "place" | "name" | "repository">, at: number, previous?: PrRow): PrRow {
  const url = target.repository.url;
  return { ...(previous ?? {}), place: target.place, kind: "watch", number: "0", ids: [], at: previous?.at ?? at, ...(url.length > 0 && url.length <= 500 ? { repoUrl: url } : {}), repoName: target.name.slice(0, 200) };
}
