// 0.5.11 (QA6-12b): what approving a coding plan does to the run limit, worked out from the task record alone, for the surfaces that show it before the approval (the Slack plan message, the task view the
// tools read). It measures as the decision does (`planRunLimit` in estimate.ts, then `settleRunLimit` in aws/developer-tasks/decide.ts): the plan's estimate held to a lower limit the start asked for, against the
// task's limit or the per-task default. The decision itself recomputes the limit (the estimate or the spend policy may have moved since) and refuses an acknowledgement that no longer matches.
import { PER_TASK_BUDGET_USD, runLimitRaises, type WorkflowSnapshot } from "@agentx/contracts";
import type { DeveloperTaskRecord } from "../developer/task-records.js";
import { planRunLimit, type EstimateDependencies } from "./estimate.js";

export interface PlanRunLimitChange {
  /** The limit the task has now (the per-task default when it has none). */
  currentUsd: number;
  /** The limit approving the plan sets. */
  proposedUsd: number;
  /** Whether approving raises the limit (and so needs the amount acknowledged). */
  raises: boolean;
}

/** Whether the workflow waits on the coding plan's approval (a Full task's requirements and design gates set no run limit). */
export const waitsOnCodingPlan = (workflow: Pick<WorkflowSnapshot, "path" | "reviewPhase" | "stage" | "state"> | undefined): boolean =>
  workflow !== undefined && workflow.stage === "PLAN_REVIEW" && workflow.state === "WAITING"
  && !(workflow.path === "FULL" && (workflow.reviewPhase === "REQUIREMENTS" || workflow.reviewPhase === "DESIGN"));

/** The run limit change approving the task's coding plan makes, or undefined when the record carries no estimate (an install without a model proxy sets no limit; an older task is worked out by the decision). */
export function planRunLimitChange(task: Pick<DeveloperTaskRecord, "budgetUsd" | "runEstimate" | "requestedRunLimitUsd">): PlanRunLimitChange | undefined {
  const estimate = task.runEstimate;
  if (estimate === undefined) return undefined;
  const proposedUsd = task.requestedRunLimitUsd === undefined ? estimate.runLimitUsd : Math.min(estimate.runLimitUsd, task.requestedRunLimitUsd);
  const currentUsd = task.budgetUsd ?? PER_TASK_BUDGET_USD;
  return { currentUsd, proposedUsd, raises: runLimitRaises(currentUsd, proposedUsd) };
}

/**
 * `planRunLimitChange`, and for a coding plan whose record carries no estimate (the estimate failed when the plan reached review, or the task is older) the limit the decision itself will work out
 * (`planRunLimit`, as the plan card does), so the Approve button and the tools still carry the amount. Undefined when there is no org to work it out for or it cannot be read: the decision then refuses a
 * raise sent without the amount, with the words and a link. `requireLimit` keeps this to a task that has a limit of its own (an install with no model proxy sets none, and approving sets none).
 */
export async function planRunLimitChangeLive(deps: EstimateDependencies, task: DeveloperTaskRecord, requireLimit: boolean): Promise<PlanRunLimitChange | undefined> {
  const stored = planRunLimitChange(task);
  if (stored !== undefined || task.orgId === undefined || (requireLimit && task.budgetUsd === undefined)) return stored;
  try {
    const proposedUsd = await planRunLimit(deps, task);
    const currentUsd = task.budgetUsd ?? PER_TASK_BUDGET_USD;
    return { currentUsd, proposedUsd, raises: runLimitRaises(currentUsd, proposedUsd) };
  } catch {
    return undefined;
  }
}
