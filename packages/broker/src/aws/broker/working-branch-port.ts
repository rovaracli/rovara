// "Continue in your own tool", the host side of "publish working branch" (E-28): reads and creates `agentx/<taskId>` in one of the task's repositories with a push token the broker mints for itself, the same
// grant and exchange a worker would use (issued and exchanged here, never sent anywhere). The branch is created at a commit the repository already holds; nothing is ever moved or deleted, and only a
// repository on GitHub is supported (the git API the client speaks is GitHub's).
import { randomUUID } from "node:crypto";
import { agentXError, codeRepositoriesOf } from "@rovara-code/contracts";
import type { DeveloperTaskRecord } from "../../developer/task-records.js";
import type { WorkingBranchPort } from "../developer-tasks/continue-loop.js";
import { githubSpecClient } from "../../spec/github-git-client.js";
import { GITHUB_HOST_KIND } from "../../plugins/code-host/github/index.js";
import { requireRecordProject } from "./dependency-wiring.js";
import { githubScopeOf } from "./scope-helpers.js";
import { hostOfRepository } from "./repository-hosts.js";
import type { AwsBrokerDependencies } from "./definitions.js";

async function clientOf(dependencies: AwsBrokerDependencies, task: DeveloperTaskRecord, repositoryName: string) {
  if (task.startingRevision === undefined) throw agentXError("CONFIG_INVALID", "This task has no pinned project revision.");
  const project = await requireRecordProject(dependencies, task, task.project, task.startingRevision);
  const repository = codeRepositoriesOf(project.definition).find((entry) => entry.name === repositoryName);
  if (repository === undefined) throw agentXError("CONFIG_INVALID", "That repository is not part of this task's project.");
  const host = hostOfRepository(dependencies, repository);
  if (host.kind !== GITHUB_HOST_KIND) throw agentXError("CONFIG_INVALID", "Rovara can make a working branch only in a repository on GitHub for now.");
  const operationId = randomUUID();
  const scope = await githubScopeOf(dependencies, task);
  const grant = dependencies.repositoryGrants.issue({
    ownerKey: task.ownerKey, projectName: project.definition.name, workspaceId: task.workspaceId, operationId, ttlSeconds: 120,
    repositories: [{ credentialRef: repository.credentialRef, repositoryUrl: repository.url, access: "push", hostKind: host.kind }],
  });
  const credential = await dependencies.repositoryGrants.exchange(grant, { workspaceId: task.workspaceId, operationId, credentialRef: repository.credentialRef, repositoryUrl: repository.url, access: "push" }, scope);
  const token = credential.token ?? credential.password;
  const parsed = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u.exec(repository.url);
  if (token === undefined || token === "" || parsed === null) throw agentXError("RUNTIME_UNAVAILABLE", "Rovara could not get access to that repository just now.");
  return githubSpecClient({ repository: { owner: parsed[1]!, name: parsed[2]! }, token });
}

export function workingBranchPortOf(dependencies: AwsBrokerDependencies): WorkingBranchPort {
  return {
    branchHead: async (task, repository, branch) => (await clientOf(dependencies, task, repository.name)).getBranch(branch),
    createBranch: async (task, repository, branch, commit) => { await (await clientOf(dependencies, task, repository.name)).createBranch(branch, commit); },
  };
}
