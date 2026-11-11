// UX2 slice 2 item 1: where a task stands in the ONE status model (`@agentx/contracts` task-status.ts), from its stored records. The session summary (`summary.ts`) stores it for Live, Home, the sidebar
// and the timeline; the task view (`task-view.ts`) adds it for the task page, the MCP tools and the CLI; Slack's start post reads it too. The reason and next-step sentences for a stage are the legacy
// task page's own (`taskPageStage`), so every surface says the same thing. Fixed words only: never task content, never a raw code.
import { TASK_STATUS_NEXT_MAX, TASK_STATUS_REASON_MAX, failureCause, taskStatusFromSession, type MergeView, type SessionStatus, type TaskStatus } from "@rovara-code/contracts";
import { type WorkflowSnapshot } from "@agentx/cloud-contracts";
import { taskPageStage } from "../aws/developer-tasks/task-page.js";
import { workflowDocumentName } from "../developer/workflow-messages.js";

export interface TaskStatusInput {
  workflow: WorkflowSnapshot | undefined;
  /** The owner closed the task. */
  closed: boolean;
  /** The task waits for money (`budgetPause`). */
  budgetPaused?: boolean | undefined;
  /** Ruling R60: the creator was removed, so the task ended (the sentence says why). */
  removedReason?: string | undefined;
  /** The workspace could not be prepared (the repository would not clone). */
  failedPrepare?: boolean | undefined;
  merge?: MergeView | undefined;
  publication?: "failed" | "retrying" | undefined;
  /** A task with no workflow: the session status it reads as, and the category of its last failed run. */
  sessionStatus?: SessionStatus | undefined;
  lastRunFailed?: true | undefined;
  failureCategory?: string | undefined;
}

const clean = (value: string, max: number): string => {
  const flat = value.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim();
  const characters = [...flat];
  return characters.length <= max ? flat : `${characters.slice(0, max - 1).join("")}…`;
};

/** Builds the status with its sentences cut to the contract's limits; a sentence that is empty after cleaning is left out. */
function status(state: TaskStatus["state"], reason?: string, next?: string, nextOthers?: string): TaskStatus {
  const r = reason === undefined ? "" : clean(reason, TASK_STATUS_REASON_MAX);
  const n = next === undefined ? "" : clean(next, TASK_STATUS_NEXT_MAX);
  const o = nextOthers === undefined ? "" : clean(nextOthers, TASK_STATUS_NEXT_MAX);
  return { state, ...(r === "" ? {} : { reason: r }), ...(n === "" ? {} : { next: n }), ...(o === "" || o === n ? {} : { nextOthers: o }) };
}

export const BUDGET_PAUSE_REASON = "it reached its spending limit";
export const BUDGET_PAUSE_NEXT = "Someone who can raise the limit decides; the work goes on once they do.";

/** Where a task stands now, in the one status model. The words are for the app, where every action is (a task's Slack thread may also have them). */
export function taskStatusOf(input: TaskStatusInput): TaskStatus {
  const { workflow, closed } = input;
  if (input.removedReason !== undefined && workflow?.stage !== "MERGED") return status("failed", input.removedReason, "Nothing; this task has ended.");
  if (workflow === undefined) return plainTaskStatus(input);
  if (workflow.stage === "MERGED") return status("merged", undefined, "Nothing; this task is complete.");
  if (workflow.outcome === "ANSWERED") return status("closed", "Answered: no code change was needed", "Nothing; no code change was needed.");
  if (!closed && workflow.stage === "CLOSED" && workflow.state === "COMPLETE" && workflow.outcome === "PASSED") {
    // Review I5: the session has ended (every step ran), so it is never "Needs you"; the next step still says the changes wait for the close.
    return status("closed", "every step finished and the changes wait in the task's workspace", "Close the task when you are done with the changes.");
  }
  if (closed || workflow.stage === "CLOSED") return status("closed", undefined, "Nothing; this task is closed.");
  if (input.failedPrepare === true) return status("failed", "the repository could not be prepared for the task", "Close the task and start it again.");
  if (input.budgetPaused === true) return status("paused_budget", BUDGET_PAUSE_REASON, BUDGET_PAUSE_NEXT);
  const owner = taskPageStage(workflow, false, true, input.publication, undefined, input.merge, false);
  const others = taskPageStage(workflow, false, false, input.publication, undefined, input.merge, false);
  const name = workflowDocumentName(workflow);
  if (workflow.state === "BLOCKED") return status("needs_you", owner.status, owner.nextStep, others.nextStep);
  const at = `${workflow.stage}/${workflow.state}`;
  if (at === "PLAN_REVIEW/WAITING") return status("needs_you", owner.status === "The E2E plan needs correction" ? owner.status : `the ${name} is waiting for approval`, owner.nextStep, others.nextStep);
  if (at === "UNDERSTAND/WAITING") return status("needs_you", "questions about the request need answers", "Answer them on the task page.", "The task owner answers them on the task page.");
  if (at === "WAIT_FOR_MERGE/WAITING") return status("ready_to_merge", undefined, owner.nextStep, others.nextStep);
  switch (workflow.stage) {
    case "UNDERSTAND": return status("understanding", undefined, "A plan follows once the request is understood.");
    case "PLAN": case "PLAN_CRITIQUE": case "PLAN_REVIEW": return status(name === "design" ? "reviewing_design" : "planning", undefined, owner.nextStep);
    case "IMPLEMENT": return status("building", undefined, owner.nextStep);
    case "VERIFY": case "REVIEW": case "PULL_REQUEST": return status("checking", undefined, owner.nextStep);
    case "WAIT_FOR_MERGE": return status("ready_to_merge", undefined, owner.nextStep, others.nextStep);
    default: return status("building", undefined, owner.nextStep);
  }
}

/** A task with no workflow (a plain or agent-run task): its session status, with a failure's cause said in words. A closed task reads Closed whatever its last run did. */
function plainTaskStatus(input: TaskStatusInput): TaskStatus {
  if (input.closed) return status("closed", undefined, "Nothing; this task is closed.");
  if (input.budgetPaused === true || input.sessionStatus === "paused") return status("paused_budget", BUDGET_PAUSE_REASON, BUDGET_PAUSE_NEXT);
  const base = taskStatusFromSession({ status: input.sessionStatus ?? "running", ...(input.lastRunFailed === undefined ? {} : { lastRunFailed: input.lastRunFailed }) });
  if (base.state === "failed") return status("failed", failureCause(input.failureCategory), input.sessionStatus === "failed" ? "Retry it from the task page, or start a new task." : "Retry it, or close the task.");
  if (input.sessionStatus === "needs_person") return status("needs_you", "an approval is waiting", "The approver decides on their card in Rovara.");
  // A run that was cancelled while the task stays open is not Closed: it stopped before it finished, and can be retried or closed.
  // Review I5: a run that was cancelled has ended its session: Closed, never "Needs you"; it can still be retried (`retryable`).
  if (input.sessionStatus === "cancelled") return { ...status("closed", "the run was cancelled before it finished", "Retry it, or close the task."), retryable: true };
  return base;
}
