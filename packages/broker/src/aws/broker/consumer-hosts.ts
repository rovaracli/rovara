// Enterprise foundations P5a-c: the code host and check runner the broker hands to Rovara Code's consumers (merge, merge tracking, CI fix, feedback autonomy).
//
// The consumers ask for "the repository of this task's project" and get its address, the code host its RECORD names (task P7: `host.kind`, absent means GitHub) and the runner that
// reads its builds. An unknown kind is refused with a fixed sentence by the router; nothing here falls back to GitHub for a record that names another host.
//
// Production gives the registry's router (`dependencies.codeHost`). A harness that builds the broker without the registry gets a GitHub-only router over `githubPullRequests` instead: the
// same adapter, with the one thing a partial provider lacks made explicit (a person's standing falls back to their permission; code owners are off unless the provider reads them).
import type { CodeHost, CheckRunner, HostScope, OrgId, PluginKind } from "@rovara-code/contracts";
import { githubActionsCheckRunner, type GitHubActionsProvider } from "../../plugins/check-runner/github-actions/index.js";
import { githubCodeHost, GITHUB_HOST_KIND, type GitHubCodeHostProvider } from "../../plugins/code-host/github/index.js";
import { createPluginRegistry, type CodeHostRouter } from "../../plugins/registry.js";
import type { ConsumerRepository, RepositoryResolver } from "../../rovara-code/host-port.js";
import { requireProject } from "../project-records.js";
import type { AwsBrokerDependencies } from "./definitions.js";
import { installOrgId } from "./scope-helpers.js";

/** The check runner that reads each code host's builds. A host kind with no entry has no runner: a failing check's log is then reported as unreadable. */
export const CHECK_RUNNER_OF_HOST: Readonly<Record<string, PluginKind>> = { [GITHUB_HOST_KIND]: "github-actions" };

type Github = AwsBrokerDependencies["githubPullRequests"];

/** A partial GitHub provider (a harness) made into what the GitHub adapter reads: the standing falls back to the permission, and code owners are off unless both reads exist. */
function adapterProviderOver(github: Github): { provider: GitHubCodeHostProvider & GitHubActionsProvider; codeOwners: boolean } {
  const provider = new Proxy(github, {
    get(target, property) {
      if (property === "getRepositoryStanding" && target.getRepositoryStanding === undefined && target.getRepositoryPermission !== undefined) {
        return async (url: string, login: string, scope: HostScope, budget?: Parameters<NonNullable<Github["getRepositoryPermission"]>>[3]) =>
          ({ permission: await target.getRepositoryPermission!(url, login, scope, budget) });
      }
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as unknown as GitHubCodeHostProvider & GitHubActionsProvider;
  return { provider, codeOwners: github.readCodeOwners !== undefined && github.listPullRequestFiles !== undefined };
}

const fallbackRouters = new WeakMap<object, { router: CodeHostRouter; runner: CheckRunner | undefined }>();

function fallbackOf(github: Github): { router: CodeHostRouter; runner: CheckRunner | undefined } {
  let found = fallbackRouters.get(github);
  if (found === undefined) {
    const { provider, codeOwners } = adapterProviderOver(github);
    const host = githubCodeHost(provider, { credentialRef: "" });
    const adjusted: CodeHost = codeOwners ? host : { ...host, capabilities: { ...host.capabilities, codeOwners: false } };
    const registry = createPluginRegistry({ codeHosts: [adjusted], checkRunners: [] });
    found = { router: registry.codeHost, runner: github.getJobLogTail === undefined ? undefined : githubActionsCheckRunner(provider) };
    fallbackRouters.set(github, found);
  }
  return found;
}

/** The GitHub repository at `url` as the consumers read it, over a (possibly partial) GitHub provider: the harness-less path, and what the tests register. */
export function githubRepositoryOver(github: Github, url: string): ConsumerRepository {
  const { router, runner } = fallbackOf(github);
  return {
    url, codeHost: router.forKind(GITHUB_HOST_KIND), checkRunner: runner,
    ...(github.isTeamMember === undefined ? {} : { isTeamMember: (team: string, login: string, scope: HostScope) => github.isTeamMember!(url, team, login, scope) }),
  };
}

/** The router that serves the consumers: the registry's, or (a harness with no registry) a GitHub-only one over `githubPullRequests`. */
export function consumerCodeHostRouter(dependencies: Pick<AwsBrokerDependencies, "codeHost" | "githubPullRequests">): CodeHostRouter {
  return dependencies.codeHost ?? fallbackOf(dependencies.githubPullRequests).router;
}

/** The repository of a task's project with the code host its record names, for the consumers; the project is read once for the address and the host. */
export function consumerRepositoryResolver(dependencies: AwsBrokerDependencies): RepositoryResolver {
  const fallback = dependencies.codeHost === undefined ? fallbackOf(dependencies.githubPullRequests) : undefined;
  const router: CodeHostRouter = consumerCodeHostRouter(dependencies);
  return async (projectName: string, revision: number, repositoryId: string, orgId: OrgId): Promise<ConsumerRepository | undefined> => {
    const project = await requireProject(dependencies, orgId ?? installOrgId(dependencies), projectName, revision);
    const definition = project.definition.repositories.find((repository) => repository.name === repositoryId);
    if (definition === undefined) return undefined;
    // The router refuses a record that names a code host this install has not registered (a fixed sentence); it never answers with another host.
    const codeHost = router.forRecord(definition);
    const runnerKind = CHECK_RUNNER_OF_HOST[codeHost.kind];
    const runner = runnerKind === undefined ? undefined
      : fallback !== undefined ? fallback.runner
      : dependencies.checkRunner === undefined ? undefined : dependencies.checkRunner(runnerKind, { allowedRepositories: [definition.url] });
    const github = dependencies.githubPullRequests;
    return {
      url: definition.url, codeHost, checkRunner: runner,
      ...(codeHost.kind === GITHUB_HOST_KIND && github.isTeamMember !== undefined
        ? { isTeamMember: (team: string, login: string, scope: HostScope) => github.isTeamMember!(definition.url, team, login, scope) } : {}),
    };
  };
}
