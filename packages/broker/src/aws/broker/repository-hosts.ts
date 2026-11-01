// Enterprise foundations P5d/P5e: how the broker's task side and route side reach a repository's code host.
//
// P5a-c gave the consumers a resolver (`consumer-hosts.ts`). The rest of the broker (publication, the description rewrites, the spec publication, attribution erasure, the meta repo reads)
// held `githubPullRequests` directly. They now ask for the code host a repository RECORD names (task P7: `host.kind`, absent means GitHub) and call the port.
//
// Rules this module keeps in one place:
//  - A record that names a host this install has not registered is refused by the router with a fixed sentence (`NO_HOST_MESSAGE`). Nothing here answers it with GitHub.
//  - A repository is found by the project revision a task or workspace pinned, by name when the caller has it, else by address. An address held by repositories of different hosts is refused.
//  - A use the port cannot express yet (see "Left for P6" in the lane report) keeps the GitHub provider, through `githubProviderOf`, which refuses any other host with a fixed sentence.
import { agentXError, repositoryHostOf, type ChangeRequestDetails, type ChangeRequestFeedback, type CodeHost, type HostScope, type RepositoryDefinition } from "@agentx/contracts";
import type { GitHubPullRequestDetails } from "../../github-app.js";
import { GITHUB_HOST_KIND } from "../../plugins/code-host/github/index.js";
import { GITHUB_ONLY_MESSAGE } from "../../plugins/code-host/github-only.js";
import { NO_HOST_MESSAGE } from "../../plugins/registry.js";
import { changeRequestRef } from "../../rovara-code/host-port.js";
import { getItem } from "../cancellation.js";
import { requireProject } from "../project-records.js";
import { workspaceKey } from "./admin-and-helpers.js";
import { consumerCodeHostRouter } from "./consumer-hosts.js";
import type { AwsBrokerDependencies } from "./definitions.js";
import { orgOfRecord } from "./scope-helpers.js";

export { GITHUB_ONLY_MESSAGE };

type Github = AwsBrokerDependencies["githubPullRequests"];
type HostDependencies = Pick<AwsBrokerDependencies, "codeHost" | "githubPullRequests">;
type RepositoryPins = Pick<RepositoryDefinition, "host" | "installationId" | "githubRepositoryId">;
type OrgRecord = { orgId?: unknown; ownerKey?: unknown; developerId?: unknown };

/** The code host a repository record names. An unknown kind throws CONFIG_INVALID with the fixed sentence; it is never answered by GitHub. */
export function hostOfRepository(dependencies: HostDependencies, repository: RepositoryPins): CodeHost {
  return consumerCodeHostRouter(dependencies).forRecord(repository);
}

/** Whether the record names GitHub (a record with no host does). Unknown kinds are not refused here: the router does that where the host is asked for. */
export function isGithubRecord(repository: RepositoryPins): boolean {
  return repositoryHostOf(repository).kind === GITHUB_HOST_KIND;
}

/**
 * The GitHub provider, for a use the CodeHost port has no counterpart for. Throws CONFIG_INVALID with `GITHUB_ONLY_MESSAGE` when the host is anything else, so a repository on another host
 * is never asked through GitHub and the step stops with a clear sentence.
 */
export function githubProviderOf(dependencies: Pick<AwsBrokerDependencies, "githubPullRequests">, host: Pick<CodeHost, "kind">): Github {
  if (host.kind !== GITHUB_HOST_KIND) throw agentXError("CONFIG_INVALID", GITHUB_ONLY_MESSAGE);
  return dependencies.githubPullRequests;
}

/** The same check for a caller that holds a record, not a resolved host: refuses an unknown kind first (router), then any host that is not GitHub. */
export function githubProviderOfRecord(dependencies: HostDependencies, repository: RepositoryPins): Github {
  return githubProviderOf(dependencies, hostOfRepository(dependencies, repository));
}

/** Refuses (CONFIG_INVALID, fixed sentence) unless the host is GitHub; for a step whose every use is GitHub-only. */
export function requireGithubHost(host: Pick<CodeHost, "kind">): void {
  if (host.kind !== GITHUB_HOST_KIND) throw agentXError("CONFIG_INVALID", GITHUB_ONLY_MESSAGE);
}

/** How a caller names the repository it means: by the project's own name for it (better), or by its address. */
export type RepositoryMatch = { name?: string | undefined; url: string };

/**
 * The repository record of a project revision that `match` names. Undefined when the project holds none. Throws when the address is held by repositories on different hosts (the answer
 * would be a guess), so the caller names the repository by its project name.
 */
export function repositoryOfProject(repositories: readonly RepositoryDefinition[], match: RepositoryMatch): RepositoryDefinition | undefined {
  if (match.name !== undefined) {
    const named = repositories.find((repository) => repository.name === match.name);
    if (named !== undefined) return named;
  }
  const same = repositories.filter((repository) => repository.url === match.url);
  const [first] = same;
  if (first === undefined) return undefined;
  const kinds = new Set(same.map((repository) => repositoryHostOf(repository).kind));
  if (kinds.size > 1) throw agentXError("CONFIG_INVALID", NO_HOST_MESSAGE);
  return first;
}

/** The code host of a repository of a project revision a task (or any record that names its org) pinned. Refuses a repository the project does not hold. */
export async function hostOfProjectRepository(dependencies: AwsBrokerDependencies, record: OrgRecord, project: string, revision: number, match: RepositoryMatch): Promise<CodeHost> {
  const registered = await requireProject(dependencies, await orgOfRecord(dependencies, record), project, revision);
  const repository = repositoryOfProject(registered.definition.repositories, match);
  if (repository === undefined) throw agentXError("CONFIG_INVALID", "the repository is not part of the project revision");
  return hostOfRepository(dependencies, repository);
}

/** `hostOfProjectRepository` for a task record. */
export function hostOfTaskRepository(dependencies: AwsBrokerDependencies, task: OrgRecord & { project: string; startingRevision: number }, match: RepositoryMatch): Promise<CodeHost> {
  return hostOfProjectRepository(dependencies, task, task.project, task.startingRevision, match);
}

/** `hostOfProjectRepository` for the workspace an operation runs in (its pinned project revision). */
export async function hostOfWorkspaceRepository(dependencies: AwsBrokerDependencies, workspaceId: string, match: RepositoryMatch): Promise<CodeHost> {
  const workspace = await getItem<Record<string, unknown>>(dependencies, workspaceKey(workspaceId));
  if (workspace === undefined) throw agentXError("NOT_FOUND", "workspace not found");
  if (typeof workspace.projectName !== "string" || typeof workspace.projectRevision !== "number") throw agentXError("CONFIG_INVALID", "the workspace has no project revision");
  return hostOfProjectRepository(dependencies, workspace, workspace.projectName, workspace.projectRevision, match);
}

/**
 * Whether the tree of a commit can be read from this host. The port always can; for GitHub, a provider built without the read (a harness) cannot, and the caller then stops or leaves the
 * check to the worker's word exactly as it did before the port.
 */
export function canReadTree(dependencies: Pick<AwsBrokerDependencies, "githubPullRequests">, host: Pick<CodeHost, "kind">): boolean {
  return host.kind !== GITHUB_HOST_KIND || dependencies.githubPullRequests.getCommitTree !== undefined;
}

/**
 * Whether the tree the code host has for a commit is the one expected (the baseline and grounding rounds hold a worker's exported tree to the host's own). The host is the one the repository's RECORD
 * names (an unknown kind throws the router's sentence). A GitHub provider built without the tree read (a harness) cannot be asked, and the worker's word stands, as it did before the port.
 */
export async function baseTreeHolds(dependencies: HostDependencies, repository: Pick<RepositoryDefinition, "host" | "installationId" | "githubRepositoryId" | "url">, commit: string, scope: HostScope, expectedTree: string): Promise<boolean> {
  const host = hostOfRepository(dependencies, repository);
  if (!canReadTree(dependencies, host)) return true;
  return await host.tree({ url: repository.url }, commit, scope) === expectedTree;
}

/** Whether a branch head and a tree can both be read from this host (see `canReadTree`). */
export function canReadBranchAndTree(dependencies: Pick<AwsBrokerDependencies, "githubPullRequests">, host: Pick<CodeHost, "kind">): boolean {
  return host.kind !== GITHUB_HOST_KIND || (dependencies.githubPullRequests.getBranchHead !== undefined && dependencies.githubPullRequests.getCommitTree !== undefined);
}

/** Whether the feedback of a change request can be read from this host (a GitHub provider built without it, a harness, cannot). */
export function canReadFeedback(dependencies: Pick<AwsBrokerDependencies, "githubPullRequests">, host: Pick<CodeHost, "kind">): boolean {
  return host.kind !== GITHUB_HOST_KIND || dependencies.githubPullRequests.getPullRequestFeedback !== undefined;
}

/** What the workflow code reads of a pull request, in the shape it always read it (GitHub's words), from the port's feedback read. */
export interface PullRequestFacts {
  number: number; url: string; state: "open" | "closed" | "merged"; headBranch: string; baseBranch: string; headCommit: string; headTreeSha: string;
}

export function pullRequestFactsOf(feedback: ChangeRequestFeedback): { pullRequest: PullRequestFacts } {
  const change = feedback.changeRequest;
  return { pullRequest: {
    number: Number(change.ref.id), url: change.ref.url, state: change.state, headBranch: change.sourceBranch, baseBranch: change.targetBranch,
    headCommit: change.headRevision, headTreeSha: change.headTreeRevision,
  } };
}

/** A change request's details in the words the pull request code always read them in (GitHub's), for code that stores or compares them. */
export function pullRequestDetailsOf(details: ChangeRequestDetails): GitHubPullRequestDetails {
  return {
    number: Number(details.ref.id), url: details.ref.url, state: details.state, headBranch: details.sourceBranch, baseBranch: details.targetBranch, headCommit: details.headRevision,
    ...(details.mergeRevision === undefined ? {} : { mergeCommit: details.mergeRevision }), ...(details.mergedBy === undefined ? {} : { mergedBy: details.mergedBy }), title: details.title, body: details.body,
  };
}

/** How an error says which system it asked: GitHub keeps its name (the messages people already know), another host is "the code host". */
export const hostNameOf = (host: Pick<CodeHost, "kind">): string => (host.kind === GITHUB_HOST_KIND ? "GitHub" : "the code host");

/** The repository address as the port wants it. */
export const repositoryRefOf = (url: string): { url: string } => ({ url });

export { changeRequestRef };

/**
 * `owner/name` of a repository for a record that is keyed by it (an audit id). GitHub's own spelling comes from the address as before; another host says it through its identity read
 * (undefined: the host cannot say, and the caller decides what that means).
 */
export async function repositoryFullNameOf(host: CodeHost, url: string, scope: HostScope, spellGithub: (url: string) => string): Promise<string | undefined> {
  if (host.kind === GITHUB_HOST_KIND) return spellGithub(url);
  return (await host.repositoryIdentity({ url }, scope))?.fullName;
}
