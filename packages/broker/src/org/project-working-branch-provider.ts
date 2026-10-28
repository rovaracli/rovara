// Internal adapter only: no route, save or task-start integration.
import { agentXError, type StoredProjectDefinition } from "@agentx/contracts";
import type { GitHubAppCredentialProvider } from "../github-app.js";
import type { WorkingBranchReviewDependencies } from "./project-working-branch.js";
type Repository = Readonly<StoredProjectDefinition["repositories"][number]>;
type Reader = Pick<GitHubAppCredentialProvider, "readWorkingBranchRepository" | "readWorkingBranch">;
function registered(repository: Repository) {
  const installationId = repository.installationId, repositoryId = repository.githubRepositoryId;
  // Legacy unpinned repositories need a separately authorized registration, never a guessed pin.
  if (installationId === undefined || repositoryId === undefined) throw agentXError("CONFIG_INVALID", "Register this repository's connection before reviewing its working branch.");
  return { installationId, repositoryId };
}
export function createWorkingBranchProvider(provider: Reader): Required<Pick<WorkingBranchReviewDependencies, "checkRepository" | "resolveBranch">> {
  return {
    checkRepository: async (orgId, repository) => provider.readWorkingBranchRepository(repository.url, registered(repository), { orgId }),
    resolveBranch: async (orgId, repository, branch) => provider.readWorkingBranch(repository.url, branch, registered(repository), { orgId }),
  };
}

/** Internal listing seam; project authority and browser exposure are separate reviewed work. */
export function createWorkingBranchLister(provider: Pick<GitHubAppCredentialProvider, "listWorkingBranches">): { listBranches: (orgId: string, repository: Repository, page?: number) => ReturnType<GitHubAppCredentialProvider["listWorkingBranches"]> } {
  return { listBranches: async (orgId, repository, page = 1) => provider.listWorkingBranches(repository.url, registered(repository), { orgId }, page) };
}

/** Provider pair used by the read-only HTTP listing boundary. */
export function createWorkingBranchPageProvider(provider: Pick<GitHubAppCredentialProvider, "readWorkingBranchRepository" | "listWorkingBranches">) {
  return { checkRepository: async (orgId: string, repository: Repository) => provider.readWorkingBranchRepository(repository.url, registered(repository), { orgId }), ...createWorkingBranchLister(provider) };
}
