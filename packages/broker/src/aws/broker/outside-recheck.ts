// "Continue in your own tool" (owner Q13), the broker's half of a person's Recheck of a pull request head pushed outside Rovara. The route (developer-tasks/continue-loop.ts) starts a read-only worker run
// that checks the head out (a maintain run with `workflowAdopt`, which pushes nothing); its result (workflow-items.ts completedOutsideAdoptItems) makes that head the task's new candidate, as a merge of the
// base is (decision 70c), and commits a RECHECK row. This file runs that row: the checks start as the person's OWN Retry checks (retryTaskWorkflow, as them), so every rule a person's paid retry meets
// applies (their live role on the task and the project, the archive check, the task creator's membership, the spend cap window, the company's spending stop at acceptance, the budget wait). Autonomy
// is not consulted: the person asked. A refusal leaves the task blocked at VERIFY with the refusal in plain words; the adopted code stays the candidate, and Retry checks is the way on.
import { createHash } from "node:crypto";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { AgentXError } from "@rovara-code/contracts";
import { WORKFLOW_BLOCK_REASONS, WorkflowSnapshotSchema, type WorkflowSnapshot } from "@agentx/cloud-contracts";
import { taskKey, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { admitMachineTime, admitTrial } from "../../org/trial.js";
import { admitWork } from "../../spend/admission.js";
import { ROVARA_CODE_AGENT_ID } from "@rovara-code/contracts";
import { ROVARA_CODE_NAME } from "./model-access.js";
import { getItem } from "../cancellation.js";
import { isConditional, type WorkflowDispatchRecord } from "../broker-shared.js";
import { retryTaskWorkflow } from "../developer-tasks/workflow-retry.js";
import { restartDependencies } from "./redirect-runtime.js";
import type { AwsBrokerDependencies } from "./definitions.js";

/**
 * The company's Admission for a person's Recheck, as any launch for the company meets it: on a cloud install a locked trial or a month of machine time used up refuses it; and the budgets the task's
 * work is charged to must have the minimum a Quick start needs left (its checks may be followed by paid reviews). Each refusal is the admission's own plain sentence.
 */
export async function admitOutsideRecheckOf(dependencies: AwsBrokerDependencies, task: DeveloperTaskRecord): Promise<void> {
  if (task.orgId === undefined) return;
  if (dependencies.cloud === true) {
    const trial = { documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now };
    await admitTrial(trial, task.orgId);
    await admitMachineTime(trial, task.orgId);
  }
  if (dependencies.modelAccess === undefined) return;
  await admitWork({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, access: dependencies.modelAccess.access, now: () => Date.now(), cloud: dependencies.cloud === true }, {
    orgId: task.orgId, project: task.project, payer: task.payer ?? { kind: "member", developerId: task.developerId },
    agentId: task.agent?.agentId ?? ROVARA_CODE_AGENT_ID, agentName: task.agent?.name ?? ROVARA_CODE_NAME, path: "QUICK",
    ...(task.origin === "test_run" ? { testRunBy: task.startedBy?.developerId ?? task.developerId } : {}),
  });
}

/** What the person is told when their re-check's checks could not start: Rovara's words first, then the refusal itself. */
export const OUTSIDE_RECHECK_NOT_STARTED = "Rovara took the pull request's new code as the task's code, but its checks couldn't start:";
const NOT_STARTED_FALLBACK = "try Retry checks.";
/** Refusals that will not change by trying again: the person, the project, the money or the task said no. Anything else (a busy workspace, a host or table fault) is retried by the dispatch. */
const FINAL_REFUSALS: ReadonlySet<string> = new Set(["FORBIDDEN", "TASK_NOT_FOUND", "TASK_ACCESS_DENIED", "PROJECT_ACCESS_DENIED", "PROJECT_ARCHIVED", "CONFIG_INVALID", "IDEMPOTENCY_CONFLICT",
  "TASK_STOP_CONFIG_INVALID", "BUDGET_EXCEEDED", "SPEND_LIMIT_REACHED", "MODEL_ACCESS_DENIED"]);

/** The request ID of the person's checks: one per adopted head and request, so a repeated row starts nothing more. */
export function outsideRecheckChecksRequestId(taskId: string, marker: NonNullable<WorkflowSnapshot["outsideRecheck"]>): string {
  const hex = createHash("sha256").update(`agentx-outside-recheck-checks\n${taskId}\n${marker.headSha}\n${marker.requestId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Whether the task still waits for this row's checks to start. */
function waitingForChecks(task: DeveloperTaskRecord | undefined, item: Pick<WorkflowDispatchRecord, "workflowRevision">): task is DeveloperTaskRecord & { workflow: WorkflowSnapshot & { outsideRecheck: NonNullable<WorkflowSnapshot["outsideRecheck"]> } } {
  const workflow = task?.workflow;
  return task !== undefined && task.closedAt === undefined && task.orgId !== undefined && workflow !== undefined && workflow.revision === item.workflowRevision && workflow.stage === "VERIFY"
    && workflow.state === "BLOCKED" && workflow.blockReason === WORKFLOW_BLOCK_REASONS.outsideRecheck && workflow.outsideRecheck?.phase === "checking";
}

/** The checks could not start for good: the task says why (blocked at VERIFY, so Retry checks and Send back are offered as for any stopped checks), and the re-check is over. */
export async function refuseOutsideRecheck(dependencies: Pick<AwsBrokerDependencies, "documentClient" | "tableName">, taskId: string, workflowRevision: number, message: string): Promise<void> {
  const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(taskId));
  if (!waitingForChecks(task, { workflowRevision })) return;
  const now = new Date().toISOString();
  const { outsideRecheck: _marker, ...rest } = task.workflow;
  void _marker;
  const said = message.replace(/^[A-Z_]+: /u, "").trim();
  const next = WorkflowSnapshotSchema.parse({ ...rest, revision: task.workflow.revision + 1, blockReason: `${OUTSIDE_RECHECK_NOT_STARTED} ${said === "" ? NOT_STARTED_FALLBACK : said}`.slice(0, 500), updatedAt: now });
  try {
    await dependencies.documentClient.send(new UpdateCommand({
      TableName: dependencies.tableName, Key: taskKey(taskId),
      UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
      ConditionExpression: "workflow.revision = :revision AND workflow.#stage = :stage AND workflow.#state = :state AND attribute_not_exists(closedAt)",
      ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
      ExpressionAttributeValues: { ":workflow": next, ":now": now, ":revision": workflowRevision, ":stage": "VERIFY", ":state": "BLOCKED" },
    }));
  } catch (error) {
    if (!isConditional(error)) throw error;
  }
}

/**
 * The RECHECK row: the person's checks of the adopted head, as their own Retry checks. A row whose task moved on (a person pressed Retry checks or Send back first, or closed it) is dropped. A refusal that
 * will not change ends the re-check with its words; anything else is thrown for the dispatch's bounded retry (and its give-up ends the re-check the same way).
 */
export async function runOutsideRecheckDispatch(dependencies: AwsBrokerDependencies, item: WorkflowDispatchRecord, remove: () => Promise<void>): Promise<"DISPATCHED" | "STALE"> {
  const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(item.taskId));
  if (!waitingForChecks(task, item)) { await remove(); return "STALE"; }
  const marker = task.workflow.outsideRecheck;
  const refuse = async (message: string): Promise<"STALE"> => {
    await refuseOutsideRecheck(dependencies, task.taskId, item.workflowRevision, message);
    await remove();
    return "STALE";
  };
  // MONEY: a task that waits for an approval of more spend runs nothing until it is approved (the approver decides), whoever asked.
  if (task.budgetPause !== undefined) return refuse("this task is waiting for more spend to be approved.");
  try {
    const { deps, caller } = await restartDependencies(dependencies, { orgId: task.orgId!, actorId: marker.actorId });
    await retryTaskWorkflow(deps, caller, task.taskId, {
      requestId: outsideRecheckChecksRequestId(task.taskId, marker), expectedRevision: task.workflow.revision,
      instructions: "Re-check the code someone pushed to the pull request outside Rovara.",
    });
  } catch (error) {
    if (error instanceof AgentXError && FINAL_REFUSALS.has(error.code)) return refuse(error.message);
    throw error;
  }
  await remove();
  return "DISPATCHED";
}
