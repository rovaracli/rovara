// DG-1 S2: "is this file in the repository now?", for the dev container path a diagnosis proposes. It reads the head of the repository's default branch (as GitHub names it today) and then the file at that
// commit, through the org's own installation. A leaf module: the caller hands in the three GitHub reads, so the wiring is one line and this file is tested without GitHub.
import type { OrgId } from "@agentx/contracts";

/** What the reader needs of GitHub: the repository's default branch, that branch's head commit, and a file at a commit. */
export interface DefaultBranchGitHub<Scope> {
  getRepositoryIdentity(repositoryUrl: string, scope: Scope): Promise<{ defaultBranch?: string | undefined } | undefined>;
  getDefaultBranchHead(repositoryUrl: string, branch: string, scope: Scope): Promise<string>;
  getFileAtCommit(repositoryUrl: string, path: string, commit: string, scope: Scope, options?: { timeoutMs?: number }): Promise<string | undefined>;
}

/**
 * The file's text at the head of the default branch, or undefined when it is not there. Throws when GitHub cannot answer, when the repository is not reachable or names no default branch, so the
 * caller refuses the change (a file that could not be checked is not a file that is there).
 */
export function defaultBranchFileReader<Scope>(github: DefaultBranchGitHub<Scope>, scopeOf: (orgId: OrgId) => Scope) {
  return async (orgId: OrgId, repositoryUrl: string, path: string, options: { timeoutMs: number }): Promise<string | undefined> => {
    const scope = scopeOf(orgId);
    const identity = await github.getRepositoryIdentity(repositoryUrl, scope);
    if (identity?.defaultBranch === undefined) throw new Error("the repository's default branch could not be read");
    const head = await github.getDefaultBranchHead(repositoryUrl, identity.defaultBranch, scope);
    return github.getFileAtCommit(repositoryUrl, path, head, scope, options);
  };
}
