// Rovara Code (Plan 6 Task 6): a question that needs no code change ends the task Answered. The answer is a model's words: it was bounded, redacted and made plain text when it was
// read (`checkIntentAssessment`) and again when it was kept (`answerWorkflowIntent`), it is shown as an answer and never run, and it reaches only people who can see the task (its
// view, and the thread the task is shared to). The `answered` milestone, which other places hear (Plan 9 posts it), carries a fixed sentence and never the answer itself.
import type { CodeMilestone, OrgId } from "@rovara-code/contracts";
import type { WorkflowSnapshot } from "@agentx/cloud-contracts";
import { ANSWERED_MILESTONE_TEXT } from "@rovara-code/contracts";
import type { TransactItem } from "../agents/table-writes.js";
import { codeMilestoneItems } from "./milestones.js";

/**
 * The items that record an answer, for the transaction that ended the task: the `answered` milestone (one per task) and its line on the session's timeline. Nothing for a workflow that
 * did not end Answered, and nothing for a 1.0.0 task (it cannot end this way).
 */
export function answeredMilestoneItems(
  table: { tableName: string }, task: { taskId: string; orgId: OrgId; sessionId?: string | undefined }, next: Pick<WorkflowSnapshot, "outcome" | "definitionVersion">, at: string,
): TransactItem[] {
  if (next.outcome !== "ANSWERED") return [];
  const milestone: CodeMilestone = {
    kind: "answered", orgId: task.orgId, taskId: task.taskId, at, text: ANSWERED_MILESTONE_TEXT,
    ...(task.sessionId === undefined ? {} : { sessionId: task.sessionId }),
  };
  return codeMilestoneItems(table, milestone, 1, { definitionVersion: next.definitionVersion });
}
