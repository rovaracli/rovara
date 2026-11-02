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

export function nightlyHeadReaderOf(dependencies: AwsBrokerDependencies, env: NodeJS.ProcessEnv = process.env): NightlyHeadReader | undefined {
  if (!verifyResultsEnabled(env)) return undefined;
  return (orgId: OrgId, project: string) => async (branch: string) => {
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
  };
}

/** The route dependency: the reader, or NOTHING while `vx` is off. Spread beside `evidenceRouteDependencies`. */
export function nightlyHeadDependencies(dependencies: AwsBrokerDependencies, env: NodeJS.ProcessEnv = process.env): { nightlyHead?: NightlyHeadReader } {
  const reader = nightlyHeadReaderOf(dependencies, env);
  return reader === undefined ? {} : { nightlyHead: reader };
}
