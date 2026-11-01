// Stop & redirect: what a redirect does for a task in the state it is in (live-interaction design 3.1, "What the redirect does" and "When nothing is running"). A pure reading of the task row, so phase 1
// and phase 2 judge the same facts the same way and a state this code does not know is refused, not guessed at.
import { WORKFLOW_BLOCK_REASONS, type RedirectMode, type RedirectRefusal } from "@agentx/contracts";
import type { DeveloperTaskRecord } from "../developer/task-records.js";
import { WORKFLOW_STEP_STAGE, stoppedStepReason } from "../aws/workflow-cancel-reconcile.js";

/** The steps a redirect can reach. The plan check and the review of a pull request's comments are not among them: they are advice or a later stage, and Stop is the way to end them. */
export const REDIRECT_STEPS = ["UNDERSTAND", "PLAN", "IMPLEMENT", "VERIFY", "REVIEW"] as const;
export type RedirectStep = (typeof REDIRECT_STEPS)[number];

/** What phase 1 stands on: the step, the revision phase 2 will find the workflow at, and the exact row the transaction must still find. */
export interface RedirectPlan {
  /** `stop`: a running step is stopped. `queued`: a step waiting to start is cancelled (the cancel blocks it). `blocked`: the step is stopped already, so there is nothing to stop. */
  kind: "stop" | "queued" | "blocked";
  step: RedirectStep;
  /** The workflow revision the stopped step will have: one more than a running or queued step's, the step's own when it is blocked already. */
  blockedRevision: number;
  guard: { revision: number; stage: string; state: string };
}

export type RedirectClassification = RedirectPlan | { refusal: Exclude<RedirectRefusal, "old_worker" | "rate_limited" | "not_owner" | "stale" | "busy"> };

const stepOf = (stage: string): RedirectStep | undefined => REDIRECT_STEPS.find((step) => step === stage);

/**
 * How a redirect treats the task as it is now. Refuses (with the fixed reason) a task that ended, one that is paused for budget (the instruction is saved by the caller and used when work resumes),
 * a step a redirect does not reach, and every state it does not know.
 */
export function classifyRedirect(task: DeveloperTaskRecord): RedirectClassification {
  const workflow = task.workflow;
  if (task.closedAt !== undefined || task.outcome === "creator_removed") return { refusal: "session_ended" };
  if (workflow === undefined) return { refusal: "not_available" };
  if (workflow.stage === "MERGED" || workflow.stage === "CLOSED" || workflow.state === "COMPLETE") return { refusal: "session_ended" };
  if (task.budgetPause !== undefined || (workflow.state === "BLOCKED" && workflow.blockReason === WORKFLOW_BLOCK_REASONS.budgetPaused)) return { refusal: "paused_for_budget" };
  const step = stepOf(workflow.stage);
  if (step === undefined) return { refusal: "not_available" };
  const guard = { revision: workflow.revision, stage: workflow.stage, state: workflow.state };
  if (workflow.state === "RUNNING") return { kind: "stop", step, blockedRevision: workflow.revision + 1, guard };
  // The cancel of a step still waiting to start blocks it in its own transaction (Understand and Plan of a version 2 workflow, the only ones that wait as a dispatch row).
  if (workflow.state === "READY" && workflow.definitionVersion === "1.1.0" && (step === "UNDERSTAND" || step === "PLAN")) return { kind: "queued", step, blockedRevision: workflow.revision + 1, guard };
  return { refusal: "not_available" };
}

/**
 * Whether phase 2 starts a CODING run for this redirect, which is the run that carries `ownerRedirect` and so needs a worker that lists the feature. "Keep the plan" at coding does; a redirect during
 * the checks or the review restarts coding whatever the mode (as a send-back does, owner decision 2026-10-31); "this changes the plan" at coding goes to planning, and Understand and Plan restart themselves.
 */
export function needsCodingRestart(step: RedirectStep, mode: RedirectMode): boolean {
  return step === "VERIFY" || step === "REVIEW" || (step === "IMPLEMENT" && mode === "keep_plan");
}

/** The two reasons the stop of this step leaves on a blocked step (`<step> operation ended cancelled` or `... interrupted`): the only blocks phase 2 restarts from. */
export function stoppedBlockReasons(step: RedirectStep): readonly string[] {
  const mode = (Object.entries(WORKFLOW_STEP_STAGE) as Array<[keyof typeof WORKFLOW_STEP_STAGE, string]>).find(([, stage]) => stage === step)?.[0];
  if (mode === undefined || mode === "FEEDBACK_REVIEW" || mode === "PLAN_CRITIQUE") return [];
  return [stoppedStepReason(mode, "CANCELLED"), stoppedStepReason(mode, "INTERRUPTED")];
}
