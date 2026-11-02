// F5 (su): a setup run that a person stopped ends at once (the cancel's own transaction), and the worker, which was asked to abort, finishes within a few seconds and reports the partial proposal it had.
// That report reaches an operation that is already over. This is the one place where such a report is looked at: it can add the partial proposal to a run that holds a recorded stop, within a bound, and
// nothing else (rovara-code/setup-agent.ts `keepStoppedSetupProposal` holds the rules). Everything about the operation itself stays as the cancel left it.
import { getItem, type OperationRecord } from "../cancellation.js";
import { taskKey, taskPointerKey, type DeveloperTaskPointerRecord, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { setupDraftRepositoriesOf } from "../../rovara-code/setup-draft.js";
import { keepStoppedSetupProposal } from "../../rovara-code/setup-agent.js";
import { requireRecordProject } from "./dependency-wiring.js";
import type { AwsBrokerDependencies } from "./definitions.js";

/** Whether this is the setup run's own operation, already ended as cancelled: the only operation whose late report is looked at. */
export function isStoppedSetupOperation(operation: Pick<OperationRecord, "kind" | "workflowMode" | "status">): boolean {
  return operation.kind === "task" && operation.workflowMode === "SETUP_AGENT" && operation.status === "CANCELLED";
}

/** Keeps the partial proposal of a stopped setup run from the worker's late report. Never throws for a report that does not qualify; a table fault is raised so the worker's retry tries again. */
export async function keepStoppedSetupRun(dependencies: AwsBrokerDependencies, operation: OperationRecord, result: unknown): Promise<void> {
  const pointer = await getItem<DeveloperTaskPointerRecord>(dependencies, taskPointerKey(operation.workspaceId));
  if (pointer === undefined) return;
  const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(pointer.taskId));
  if (task?.purpose !== "setup_agent" || task.setupAgentStop === undefined) return;
  let repositories;
  try {
    repositories = setupDraftRepositoriesOf((await requireRecordProject(dependencies, task, task.project, task.startingRevision)).definition);
  } catch (error) {
    // A project revision that is gone has no repositories to read the proposal against: there is nothing to keep.
    if (error instanceof Error && "code" in error) return;
    throw error;
  }
  await keepStoppedSetupProposal({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now }, task, result, repositories);
}

