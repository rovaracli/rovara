// Meta repo lane A: the broker's wiring for creating a project from a meta repo and for the meta repo's config file, kept in one module so the handler needs two lines.
//   - `metaRepoRouteDependencies(dependencies)`: `createFromMeta` (POST /v1/app/projects with a `metaRepository`) and `metaConfig` (GET/POST /v1/app/projects/{name}/meta-config...).
//   - `metaConfigQueueFor(dependencies)`: what the GitHub push handler calls to queue a config import.
// Everything GitHub-facing goes through the org's own connection (`githubScope`), the same way project creation and settings do.
import { META_CONFIG_MAX_BYTES, agentXError, type OrgId } from "@agentx/contracts";
import { requireRepositoryConnected } from "../../org/github-connection.js";
import { createProjectFromMeta, type CreateFromMetaDependencies } from "../../org/create-from-meta.js";
import { queueMetaConfigImport, type QueueDependencies } from "../../meta-repo/config-import.js";
import type { MetaPush } from "../../triggers/github-events.js";
import type { DeveloperRouteDependencies } from "../developer-routes/types.js";
import type { AwsBrokerDependencies } from "./definitions.js";
import { repositoryGateOf } from "./dependency-wiring.js";
import { registerProjectFor } from "./project-registration.js";
import { githubScope } from "./scope-helpers.js";
import { githubProviderOfRecord, repositoryOfProject } from "./repository-hosts.js";
import { requireLatestProject } from "./records.js";

/** The reads of the meta repository the config import needs: the branch head and a file at a commit (read with the config size cap, so an oversized file stops the read). */
export function metaRepositoryReaders(dependencies: AwsBrokerDependencies): Pick<QueueDependencies, "readMetaFile" | "getHead"> {
  const github = dependencies.githubPullRequests;
  // P5e: the two reads have no code host port counterpart yet (a read capped in size, and the head of the default branch), so they are GitHub's alone. The repository's record decides: an unknown
  // host kind is refused with the router's fixed sentence, and a repository on another host with `GITHUB_ONLY_MESSAGE`; neither is ever asked of GitHub. Left for P6.
  const requireGithubRepository = async (orgId: OrgId, project: string, repository: { name: string; url: string }): Promise<void> => {
    const record = repositoryOfProject((await requireLatestProject(dependencies, orgId, project)).definition.repositories, repository);
    if (record === undefined) throw agentXError("CONFIG_INVALID", "the repository is not part of the project");
    githubProviderOfRecord(dependencies, record);
  };
  return {
    readMetaFile: async ({ orgId, project, repository, commit, path }) => {
      await requireGithubRepository(orgId, project, repository);
      if (github.getFileAtCommit === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "reading the meta repo is not set up in this deployment");
      return github.getFileAtCommit(repository.url, path, commit, githubScope(dependencies, orgId), { maxBytes: META_CONFIG_MAX_BYTES });
    },
    getHead: async ({ orgId, project, repository }) => {
      await requireGithubRepository(orgId, project, repository);
      if (github.getDefaultBranchHead === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "reading the meta repo is not set up in this deployment");
      return github.getDefaultBranchHead(repository.url, repository.defaultBranch, githubScope(dependencies, orgId));
    },
  };
}

/** What the GitHub push handler (`deliverGithubTriggerEvents`) calls: queue a config import for the project whose meta repository was pushed to. */
export function metaConfigQueueFor(dependencies: AwsBrokerDependencies): (push: MetaPush) => Promise<unknown> {
  return (push) => queueMetaConfigImport({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now, ...metaRepositoryReaders(dependencies) }, { orgId: push.orgId, project: push.project, commit: push.commit });
}

function createFromMetaDependencies(dependencies: AwsBrokerDependencies): CreateFromMetaDependencies {
  const github = dependencies.githubPullRequests;
  return {
    documentClient: dependencies.documentClient,
    tableName: dependencies.tableName,
    now: Date.now,
    defaults: dependencies.cloudProjects,
    requireRepositoryConnected: (orgId: OrgId, owner: string, name: string) => {
      const gate = repositoryGateOf(dependencies);
      if (gate === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "creating projects is not set up in this deployment; ask Rovara support");
      return requireRepositoryConnected(gate, orgId, owner, name);
    },
    repositoryIdentity: async (url: string, orgId: OrgId) => {
      if (github.getRepositoryIdentity === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "creating projects is not set up in this deployment; ask Rovara support");
      return github.getRepositoryIdentity(url, githubScope(dependencies, orgId));
    },
    registerProject: (actor, input, options) => registerProjectFor(dependencies, actor, input, options),
  };
}

/** The route dependencies for the meta repo's routes. `settings` is the same piece the settings route gets (`projectSettings`), so an added repository is checked the same way. */
export function metaRepoRouteDependencies(
  dependencies: AwsBrokerDependencies,
  settings: DeveloperRouteDependencies["projectSettings"],
): Pick<DeveloperRouteDependencies, "createFromMeta" | "metaConfig"> {
  const create = createFromMetaDependencies(dependencies);
  return {
    createFromMeta: (caller, input) => createProjectFromMeta(create, caller, input),
    ...(settings === undefined ? {} : { metaConfig: { ...settings, ...metaRepositoryReaders(dependencies) } }),
  };
}
