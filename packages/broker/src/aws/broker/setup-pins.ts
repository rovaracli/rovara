// P1 (su): the broker pins the commit a setup run reads. When it builds the run's prepare invocation it reads each repository's default-branch head from the code host the repository's RECORD names (the same read the
// meta repository's `knowledgeCommit` uses), and sends the commits as `pins`. The worker resolves the heads itself and refuses the preparation if any differs (a branch that moved between the two reads is a retry, not
// a run on a head nobody pinned). The broker keeps the pins on the prepare operation, and the task's `preparedBase` only when the worker's report equals them (`rovara-code/setup-agent.ts` `keepSetupPreparedBase`).
// A head that cannot be read refuses the start (RUNTIME_UNAVAILABLE), never a run without a pin.
import { agentXError, workerProjectDefinition, type OrgId, type PreparePins } from "@agentx/contracts";
import type { AwsBrokerDependencies } from "./definitions.js";
import type { RegisteredProjectRecord } from "./definitions.js";
import { canReadBaseBranchHead, hostOfRepository } from "./repository-hosts.js";
import { githubScope } from "./scope-helpers.js";

export const SETUP_PIN_UNREADABLE = "Rovara can't read the project's repositories just now; try again in a moment.";
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

/** The pins for the repositories a setup run's worker clones (the code repositories and, as a setup draft sends it, the meta repository too). */
export async function setupPinsOf(dependencies: AwsBrokerDependencies, project: RegisteredProjectRecord, orgId: OrgId): Promise<PreparePins> {
  const repositories = workerProjectDefinition(project.definition, { includeMeta: true }).repositories;
  const pins: PreparePins = [];
  for (const repository of repositories) {
    const host = hostOfRepository(dependencies, repository);
    if (!canReadBaseBranchHead(dependencies, host)) throw agentXError("RUNTIME_UNAVAILABLE", SETUP_PIN_UNREADABLE);
    let commit: string;
    try {
      commit = await host.baseBranchHead({ url: repository.url }, repository.defaultBranch, githubScope(dependencies, orgId));
    } catch {
      throw agentXError("RUNTIME_UNAVAILABLE", SETUP_PIN_UNREADABLE);
    }
    if (!COMMIT.test(commit)) throw agentXError("RUNTIME_UNAVAILABLE", SETUP_PIN_UNREADABLE);
    pins.push({ repository: repository.name, commit });
  }
  if (pins.length === 0) throw agentXError("RUNTIME_UNAVAILABLE", SETUP_PIN_UNREADABLE);
  return pins;
}
