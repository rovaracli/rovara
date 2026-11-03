// SU-1 addendum 3: the commits a setup run used, as the test-environment candidate check and Prove need them. A setup run's proposal was written for the repository as the run read it (the task's `preparedBase`, kept
// only when it equalled the heads the broker pinned). The candidate check of that proposal prepares at THOSE commits, and a Prove is accepted only from a check made at them, so main moving on can never mix a newer
// checkout into an approval. With no complete record (no marker for this proposal, a task that kept no base, or a repository the base does not cover) the proposal cannot be checked or proved: a re-run is asked for, never a pin read now.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { PreparePinsSchema, type OrgId, type PreparePins } from "@agentx/contracts";
import { readSetupRunProposal } from "../rovara-code/setup-run-proposal.js";
import { taskKey } from "../developer/task-records.js";

type Store = { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; now: () => number };

/**
 * The commits the setup run behind the proposal `digest` used, for exactly `repositories` (the code repositories), or undefined when the broker has no complete record of them. The run is the one the project's
 * setup-run marker names for this digest; its task must be this company's setup run for this project.
 */
export async function setupRunCommitsOf(store: Store, orgId: OrgId, project: string, digest: string, repositories: readonly string[]): Promise<PreparePins | undefined> {
  const marker = await readSetupRunProposal(store, orgId, project);
  if (marker === undefined || marker.digest !== digest || marker.taskId === "") return undefined;
  const task = ((await store.documentClient.send(new GetCommand({ TableName: store.tableName, Key: taskKey(marker.taskId), ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
  if (task === undefined || task["orgId"] !== orgId || task["project"] !== project || task["purpose"] !== "setup_agent" || !Array.isArray(task["preparedBase"])) return undefined;
  const recorded = new Map((task["preparedBase"] as Array<{ repositoryId?: unknown; baseCommitSha?: unknown }>).map((entry) => [entry.repositoryId, entry.baseCommitSha]));
  if (repositories.length === 0 || !repositories.every((name) => recorded.has(name))) return undefined;
  const pins = PreparePinsSchema.safeParse(repositories.map((repository) => ({ repository, commit: recorded.get(repository) })));
  return pins.success ? pins.data : undefined;
}

/**
 * Whether a candidate check made at `checked` (its recorded pins) is a check at the setup run's commits. A check with no pins is not, and with no run record (`run` undefined) nothing can be said to match, so it is not either;
 * otherwise every repository must be pinned at exactly the run's commit.
 */
export function checkedAtRunCommits(checked: PreparePins | undefined, run: PreparePins | undefined): boolean {
  if (checked === undefined || checked.length === 0) return false;
  if (run === undefined) return false;
  return run.every((wanted) => checked.find((pin) => pin.repository === wanted.repository)?.commit === wanted.commit) && checked.length === run.length;
}
