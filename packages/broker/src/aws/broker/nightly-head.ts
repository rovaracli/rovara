// Setup and test health SH17 (quiet repository): the reader of a project's default-branch head that lets a nightly baseline older than 7 days still count when the branch has not moved since it ran
// (`test-env/nightly-usable.ts`). It exists only while `vx` is on. It asks the code host the repository's RECORD names (`baseBranchHead`), in the org's own connection, and only for a project with exactly
// one repository: a nightly records one head, which several repositories cannot be compared with. Any failure to read (no host, a project that cannot be read, a host error) is "unknown", and an unknown head
// refuses the stale baseline, which is what happens without this reader.
import type { OrgId } from "@agentx/contracts";
import type { NightlyHeadReader } from "../../test-env/nightly-usable.js";
import { verifyResultsEnabled } from "../../verification/switch.js";
import type { AwsBrokerDependencies } from "./definitions.js";
import { canReadBaseBranchHead, hostOfRepository } from "./repository-hosts.js";
import { requireLatestProject } from "./records.js";
import { githubScope } from "./scope-helpers.js";

/** The head of a branch of a one-repository project, as the code host of the repository's record says; undefined for anything else, and for any failure. NH-1 uses it for the nightly run (no switch of its own here). */
export async function defaultBranchHeadOf(dependencies: AwsBrokerDependencies, orgId: OrgId, project: string, branch: string): Promise<string | undefined> {
  try {
    const repositories = (await requireLatestProject(dependencies, orgId, project)).definition.repositories;
    if (repositories.length !== 1) return undefined;
    const repository = repositories[0]!;
    const host = hostOfRepository(dependencies, repository);
    if (!canReadBaseBranchHead(dependencies, host)) return undefined;
    return await host.baseBranchHead({ url: repository.url }, branch, githubScope(dependencies, orgId));
  } catch {
    return undefined;
  }
}

/** The default branch of the repository of a one-repository project (the project definition's own record of it), or undefined. */
export async function repositoryDefaultBranchOf(dependencies: AwsBrokerDependencies, orgId: OrgId, project: string): Promise<string | undefined> {
  try {
    const repositories = (await requireLatestProject(dependencies, orgId, project)).definition.repositories;
    return repositories.length === 1 ? repositories[0]!.defaultBranch : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the project's latest definition lists private package registries; undefined when the project cannot be read. */
export async function projectUsesRegistries(dependencies: AwsBrokerDependencies, orgId: OrgId, project: string): Promise<boolean | undefined> {
  try {
    return ((await requireLatestProject(dependencies, orgId, project)).definition.registries ?? []).length > 0;
  } catch {
    return undefined;
  }
}

export function nightlyHeadReaderOf(dependencies: AwsBrokerDependencies, env: NodeJS.ProcessEnv = process.env): NightlyHeadReader | undefined {
  if (!verifyResultsEnabled(env)) return undefined;
  return (orgId: OrgId, project: string) => (branch: string) => defaultBranchHeadOf(dependencies, orgId, project, branch);
}

/** The route dependency: the reader, or NOTHING while `vx` is off. Spread beside `evidenceRouteDependencies`. */
export function nightlyHeadDependencies(dependencies: AwsBrokerDependencies, env: NodeJS.ProcessEnv = process.env): { nightlyHead?: NightlyHeadReader } {
  const reader = nightlyHeadReaderOf(dependencies, env);
  return reader === undefined ? {} : { nightlyHead: reader };
}
