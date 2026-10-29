// Rovara Code (playbook round 2, R1a): a path the person chose themselves always runs. A typed `quick:` or `full:` prefix and a Slack Quick or Full button both start the task with the path
// in the request (`intent.pathFrom` is "request"); a start that left the choice to Understand has "understand". Understand may answer a question instead of planning only when the person did
// not choose: otherwise its answer is read as the restatement of the change to plan, as it already is for a task that follows an answered one ("Make a change anyway").
import type { IntentAssessment, WorkflowPath, WorkflowSnapshot } from "@agentx/contracts";

/** The assumption an explicit-path conversion states, in fixed words (the person's own choice is the only thing named). */
export function explicitPathAssumption(path: WorkflowPath): string {
  return `You chose ${path === "FULL" ? "Full" : "Quick"}, so I planned the change instead of answering.`;
}

/** True when the person chose the path (a prefix or a button), not Understand. A hand-off or a start that left the choice open is not. */
export function isExplicitPath(workflow: Pick<WorkflowSnapshot, "intent">): boolean {
  return workflow.intent?.pathFrom === "request";
}

const EARLIER_ANSWER_ASSUMPTION = "An earlier answer said no change was needed; you asked for the change anyway.";

/**
 * What Understand's assessment means for this task. An `answer` ends the task Answered, except for a task that follows an answered one (`followsAnswer`) and a task whose person chose the
 * path (`workflow.intent.pathFrom`), which plan the change instead. Anything else is returned as it is.
 */
export function assessmentForTask(input: { assessment: IntentAssessment; workflow: Pick<WorkflowSnapshot, "intent" | "path">; followsAnswer: boolean }): IntentAssessment {
  const { assessment, workflow } = input;
  if (assessment.kind !== "answer" || !(input.followsAnswer || isExplicitPath(workflow))) return assessment;
  return { kind: "ready", path: workflow.path, restatement: assessment.restatement, assumptions: [input.followsAnswer ? EARLIER_ANSWER_ASSUMPTION : explicitPathAssumption(workflow.path)] };
}
