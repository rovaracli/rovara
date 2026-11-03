// TE-2: a test-environment proposal's candidate check, as the routes use it. The check is prepared from the commands the proposal would put in the settings, run on a fresh workspace BEFORE they are applied; its
// result is stored for (project, digest, settings revision). The Prove reads it, and the approval writes into the settings only the commands it ran. See org/test-env-candidate.ts for what is stored.
import { testEnvDigest, workerProjectDefinition, type AppProjectSummary, type OrgId, type ProjectCommand, type TestEnvironmentBody } from "@agentx/contracts";
import { setupStateOfCheck } from "../../org/project-setup-check.js";
import { readCandidateCheck, type CandidateCheck } from "../../org/test-env-candidate.js";
import { proposalIsSetupRun } from "../../org/test-environment.js";
import { checkedAtRunCommits, setupRunCommitsOf } from "../../test-env/setup-run-pin.js";
import { candidateListsChecked, identicalCommands } from "../../test-env/candidate-commands.js";
import { proveReportFromSetupCheck, type ProveFromSetupCheck } from "../../test-env/prove-from-setup-check.js";
import { setupCheckDepsOf } from "./project-list.js";
import type { DeveloperRouteDependencies } from "./types.js";

export interface CandidateDefinition { revision: number; repositories: ReadonlyArray<{ path: string; name?: string }>; setup: readonly ProjectCommand[]; readiness: readonly ProjectCommand[] }

/** The candidate check of a proposal at the project's current settings revision, and where it stands (derived from its workspace on every read). */
export async function candidateStateOf(deps: DeveloperRouteDependencies, orgId: OrgId, name: string, digest: string, definition: CandidateDefinition): Promise<{ check: CandidateCheck | undefined; setup: AppProjectSummary["setup"] }> {
  const checks = setupCheckDepsOf(deps);
  const check = await readCandidateCheck(checks, orgId, name, digest, definition.revision);
  // A failing step is named from the commands the CHECK ran (its lists), not the settings'.
  const setup = await setupStateOfCheck(checks, check, check === undefined ? definition : { revision: definition.revision, setup: check.setup, readiness: check.readiness });
  return { check, setup };
}

/**
 * The Prove report of a proposal from ITS OWN candidate check, as it stands NOW: the check must have passed on a workspace prepared from the lists the proposal makes, at the settings revision as they stand now,
 * and be recent; every command of the proposal must be among the commands that check ran. The settings' own check is never read. `candidate` is the check that proved it (to compare with what is written).
 */
export async function deriveCandidateProve(deps: DeveloperRouteDependencies, orgId: OrgId, name: string, proposal: TestEnvironmentBody, definition: CandidateDefinition): Promise<ProveFromSetupCheck & { candidate?: CandidateCheck }> {
  const { check, setup } = await candidateStateOf(deps, orgId, name, testEnvDigest(proposal), definition);
  if (check === undefined) return { ok: false, refusal: "no_setup_check" };
  const derived = proveReportFromSetupCheck({ environment: proposal, definition: { revision: definition.revision, setup: check.setup, readiness: check.readiness }, setup, nowMs: deps.now() });
  if (!derived.ok) return derived;
  // The check ran exactly the lists the settings would hold with this proposal's commands added: a record that says otherwise (damaged, or the proposal changed under its digest) proves nothing.
  const lists = candidateListsChecked(proposal, definition);
  if (!identicalCommands(lists.setup, check.setup) || !identicalCommands(lists.readiness, check.readiness)) return { ok: false, refusal: "commands_differ" };
  // SU-1 addendum 3: a setup run's proposal is proved only by a check made at the commits the run used (with none recorded it is refused): never on a newer main.
  const store = { documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now };
  if (check.origin === "setup_run" || await proposalIsSetupRun(store, orgId, name, testEnvDigest(proposal))) {
    const run = await setupRunCommitsOf(store, orgId, name, testEnvDigest(proposal), workerProjectDefinition(definition).repositories.flatMap((repository) => repository.name === undefined ? [] : [repository.name]));
    if (!checkedAtRunCommits(check.pins, run)) return { ok: false, refusal: "setup_run_moved" };
  }
  return { ...derived, candidate: check };
}

/** Words for the apply. */
export const CANDIDATE_APPLY_WORDS = {
  notApproved: "The commands are added to the project's settings when the test environment is approved, after a check ran them. Run the check, prove it, then approve it.",
} as const;
