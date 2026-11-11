// Before the Team record is built (the first upgrade after `agentx config set teamRecord.enabled 1`): what a failed earlier try can leave behind that would fail the next one.
// Found on staging, 2026-11-10: the 0.5.12 switch-on rolled back (the embedder function was refused), and the DynamoDB table `agentx-staging-team-record`, created minutes earlier with
// DeletionProtectionEnabled=true, could not be deleted by the rollback. The table kept its fixed name, so the next switch-on would have failed on "already exists". The check below finds
// such a table before anything is deployed and says what to do; it deletes nothing (deleting a table is the owner's decision, and a table WITH data is never an orphan to remove).
// What it can and cannot see: it asks DynamoDB for the one table by its fixed name (derived-names.ts), only while the control plane stack has no Team record yet. A table whose
// stack is built (the stack has the TeamRecordEnabled parameter) is the record itself and is never reported. Account LIMITS (Lambda memory, ...) are NOT readable here: they are
// not in any API this CLI may call; docs/runbooks/new-resource-size-vs-account-limit.md lists them and how to confirm each by hand.
import { agentXError, environmentStackName, teamRecordTableName } from "@agentx/contracts";
import type { ParameterStore } from "../environments/parameter-store.js";
import { embedderRepository } from "./parameters.js";
import { TEAM_RECORD_PARAMETER, readTeamRecordRecord } from "./team-record-switch.js";

/** What the preflight asks AWS. `undefined` means the probe could not tell (no permission, a network fault): the preflight then warns and the deploy goes on, because the worst case is a rollback. */
export interface TeamRecordProbe {
  tableState(tableName: string): Promise<{ exists: boolean; itemCount?: number; deletionProtected?: boolean } | undefined>;
  /**
   * The embedder's ECR repository (`rovara-bundle/<env>/embedder`): whether it exists, and whether the access stack holds it. A repository that exists but is not in the stack (retained after the
   * record was withdrawn, or made by hand) makes the access stack update fail on "already exists". Optional: a probe without it skips the check.
   */
  embedderRepositoryState?(repository: string, accessStackName: string): Promise<{ exists: boolean; inAccessStack: boolean } | undefined>;
}

export interface TeamRecordPreflight {
  /** Lines that stop the switch-on (each says what is in the way and what to do). Empty: nothing is in the way. */
  refusals: string[];
  /** Lines that do not stop it (a check that could not run). */
  warnings: string[];
}

export const NEW_RESOURCE_RUNBOOK = "docs/runbooks/new-resource-size-vs-account-limit.md";

/**
 * The checks before a Team record build. `built` is true when the control plane stack already has the record (nothing to check then: the table is the record's own).
 */
export async function teamRecordPreflight(input: { env: string; built: boolean; probe: TeamRecordProbe | undefined }): Promise<TeamRecordPreflight> {
  const result: TeamRecordPreflight = { refusals: [], warnings: [] };
  if (input.built) return result;
  if (input.probe?.embedderRepositoryState !== undefined) {
    const repository = embedderRepository(input.env);
    const accessStack = environmentStackName(input.env, "access");
    const repositoryState = await input.probe.embedderRepositoryState(repository, accessStack).catch(() => undefined);
    if (repositoryState === undefined) {
      result.warnings.push(`Could not check whether the ECR repository ${repository} is left over from an earlier try. To check by hand: aws ecr describe-repositories --repository-names ${repository}, and see whether the stack ${accessStack} lists it. A repository with that name that the access stack does not hold makes the access stack update fail on "already exists" (${NEW_RESOURCE_RUNBOOK}).`);
    } else if (repositoryState.exists && !repositoryState.inAccessStack) {
      result.refusals.push(`The ECR repository ${repository} exists but the access stack ${accessStack} does not hold it, so it is left over (kept when an earlier access stack no longer listed it, or made by hand), and the access stack update would fail on "already exists". `
        + `Look at what it holds first: aws ecr list-images --repository-name ${repository}. If it holds nothing you need, the account owner deletes it (aws ecr delete-repository --repository-name ${repository} --force) and runs this again; if it holds an image you need, do not delete it: ask for help to import it into the stack. Nothing was changed.`);
    }
  }
  const table = teamRecordTableName(input.env);
  const state = input.probe === undefined ? undefined : await input.probe.tableState(table).catch(() => undefined);
  if (state === undefined) {
    result.warnings.push(`Could not check whether the DynamoDB table ${table} is left over from an earlier try (the credentials in use may not be allowed to read it: the operator role is not, and \`agentx upgrade\` with admin credentials checks again before it changes anything). `
      + `To check by hand: aws dynamodb describe-table --table-name ${table}. A table with that name, while this install has no Team record, makes the build fail on "already exists" (${NEW_RESOURCE_RUNBOOK}).`);
    return result;
  }
  if (state.exists) {
    const detail = `${state.itemCount === undefined ? "item count unknown" : `about ${state.itemCount} items; DynamoDB refreshes this count only about every six hours, so it may be out of date`}${state.deletionProtected === true ? ", deletion protection on" : ""}`;
    result.refusals.push(`The DynamoDB table ${table} exists (${detail}) but this install has no Team record, so it is left over from an earlier try that rolled back, and the build would fail on "already exists". `
      + `Before anyone deletes it, look for rows with a live read, because the count above is not live: aws dynamodb scan --table-name ${table} --max-items 1. `
      + `If it holds no data you need, the account owner turns off its deletion protection and deletes it, then runs this again; if it holds data, do not delete it: ask for help. Nothing was changed.`);
  }
  return result;
}

/**
 * The check for a command that is about to deploy (agentx upgrade, its Enterprise bundle path, agentx deploy): when the Team record is recorded as on and the control plane has no Team record
 * yet, a left-over table stops the command BEFORE any AWS write, with the fix. Warnings (a check that could not run) are printed and the command goes on.
 */
export async function enforceTeamRecordPreflight(input: { env: string; store: ParameterStore; controlPlaneParameters: Record<string, string> | undefined; probe: TeamRecordProbe | undefined; write: (line: string) => void; stoppedMessage: string }): Promise<void> {
  if ((await readTeamRecordRecord(input.store, input.env))?.enabled !== true) return;
  const preflight = await teamRecordPreflight({ env: input.env, built: input.controlPlaneParameters?.[TEAM_RECORD_PARAMETER] !== undefined, probe: input.probe });
  for (const line of preflight.warnings) input.write(`Warning: ${line}`);
  if (preflight.refusals.length > 0) throw agentXError("CONFIG_INVALID", `${input.stoppedMessage}: ${preflight.refusals.join(" ")}`);
}
