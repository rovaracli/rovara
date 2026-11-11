// P1 (su): the broker pins the commit a setup run reads. When it builds the run's prepare invocation it reads each repository's default-branch head from the code host the repository's RECORD names (the same read the
// meta repository's `knowledgeCommit` uses), and sends the commits as `pins`. The worker resolves the heads itself and refuses the preparation if any differs (a branch that moved between the two reads is a retry, not
// a run on a head nobody pinned). The broker keeps the pins on the prepare operation, and the task's `preparedBase` only when the worker's report equals them (`rovara-code/setup-agent.ts` `keepSetupPreparedBase`).
// A head that cannot be read refuses the start (RUNTIME_UNAVAILABLE), never a run without a pin.
import { agentXError, workerProjectDefinition, type OrgId, type PreparePins } from "@rovara-code/contracts";
import type { AwsBrokerDependencies } from "./definitions.js";
import type { RegisteredProjectRecord } from "./definitions.js";
import { canReadBaseBranchHead, hostOfRepository } from "./repository-hosts.js";
import { githubScope } from "./scope-helpers.js";

export const SETUP_PIN_UNREADABLE = "Rovara can't read the project's repositories just now; try again in a moment.";
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

/** The pins for the repositories a setup run's worker clones (the code repositories and, as a setup draft sends it, the meta repository too). */
export async function setupPinsOf(dependencies: AwsBrokerDependencies, project: RegisteredProjectRecord, orgId: OrgId, includeMeta = true): Promise<PreparePins> {
  const repositories = workerProjectDefinition(project.definition, includeMeta ? { includeMeta: true } : {}).repositories;
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

export const SETUP_PIN_MOVED = "The project's default branch has moved since the setup run read it. Ask Rovara to run setup again.";

/**
 * SU-1 addendum 3: a candidate check of a setup run's proposal prepares at the commits the RUN used. They are sent as the pins (the worker refuses a branch that is anywhere else), after the broker has read the
 * heads now and found each exactly there: a default branch that has moved is a re-run, never a check on a newer commit than the proposal was written for. `wanted` must name every code repository.
 */
export async function pinsStillAtHead(dependencies: AwsBrokerDependencies, project: RegisteredProjectRecord, orgId: OrgId, wanted: PreparePins): Promise<PreparePins> {
  const heads = await setupPinsOf(dependencies, project, orgId, false);
  if (!heads.every((head) => wanted.find((pin) => pin.repository === head.repository)?.commit === head.commit)) throw agentXError("CHANGE_STALE", SETUP_PIN_MOVED);
  return heads;
}
