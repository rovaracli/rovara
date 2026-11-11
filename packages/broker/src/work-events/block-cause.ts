// Work events (U3): why a workflow step was blocked, as a closed cause code. A blocked workflow carries a text reason (`blockReason`); that text is never stored in an event. It is matched here against the
// broker's own fixed reasons (the constants and prefixes below, which are the only writers of a block), and anything not recognised is `other`, a failure. A stop on purpose (a cancel, a budget pause, a pause for
// setup) is a STOP cause, so a failure rate counts real failures only.
import {
  BUDGET_EXHAUSTED_FAILURE_MESSAGE, FEEDBACK_STOPPED_REASON, RUN_LIMIT_BLOCK_PREFIX, UNDERSTAND_ANSWER_PENDING_MESSAGE, UNDERSTAND_TIMED_OUT_MESSAGE, UNDERSTAND_UNREADABLE_MESSAGE,
  WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX, WORKFLOW_APPLICATION_EVIDENCE_INCOMPLETE_PREFIX, WORKFLOW_APPLICATION_PLAN_NOT_APPROVABLE_PREFIX, WORKFLOW_APPLICATION_ROUND_REFUSED_PREFIX,
  WORKFLOW_APPLICATION_RUNTIME_RENEWED_PREFIX, WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX, WORKFLOW_APPLICATION_SELECTION_CHANGED_PREFIX, WORKFLOW_AUTO_IMPLEMENT_FAILED_MESSAGE,
  WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE, WORKFLOW_AUTO_REVIEW_FAILED_MESSAGE, WORKFLOW_BLOCK_REASONS, WORKFLOW_REVIEW_RESULT_INCOMPLETE_MESSAGE,
  isBranchSyncBlockReason, isCiFixBlockReason, isStepNotRunReason,
  type WorkEventBlockCause,
} from "@agentx/contracts";

const R = WORKFLOW_BLOCK_REASONS;
type Reason = keyof typeof WORKFLOW_BLOCK_REASONS;

/** Every reason key has a cause: the type is complete, so a new reason constant does not compile until it is placed (review L1). */
export const BLOCK_CAUSE_BY_KEY: Record<Reason, WorkEventBlockCause> = {
  checksUnconfirmed: "checks_failed", checkRetryStale: "checks_failed", checkReportUnreadable: "checks_failed", noChecksConfigured: "checks_failed", checksBroken: "checks_failed",
  checkRunnerFailed: "checks_failed", regressionFound: "checks_failed", setupChangedFiles: "checks_failed", codeChangedAfterChecks: "checks_failed", checkedOtherCode: "checks_failed", noCheckResults: "checks_failed",
  repositoriesIncomplete: "run_failed", ruleFilesUnverified: "run_failed", stepRuleFilesUnverified: "run_failed", leftoverProcesses: "run_failed", startUnrecorded: "run_failed",
  startUnconfirmed: "run_failed", startChanged: "run_failed", documentUnverified: "run_failed",
  noCodeChanged: "no_code_change", fixChangedNothing: "no_code_change",
  planNotSaved: "plan_failed", planUnreadable: "plan_failed", planCheckUnreadable: "plan_failed", planCheckNotStarted: "plan_failed", planRevisionNotStarted: "plan_failed", planNotStarted: "plan_failed",
  understandUnreadable: "plan_failed", understandTimedOut: "plan_failed", understandNotStarted: "plan_failed",
  feedbackReviewFailed: "review_failed",
  pullRequestUpdateFailed: "pr_update_failed", pullRequestChanged: "pr_update_failed",
  pullRequestClosed: "pr_closed",
  budgetPaused: "budget_paused", understandFullNotAdmitted: "budget_paused",
  understandAnswerPending: "needs_owner", liveSteerReapproval: "needs_owner", liveSteerReapprovalCoding: "needs_owner", liveSteerReapprovalRevise: "needs_owner",
  baseMergedRecheck: "needs_owner", recheckAutonomyLowered: "not_started",
};

const EXACT = new Map<string, WorkEventBlockCause>();
for (const [key, cause] of Object.entries(BLOCK_CAUSE_BY_KEY)) EXACT.set(R[key as Reason], cause);
for (const [text, cause] of [
  [UNDERSTAND_UNREADABLE_MESSAGE, "plan_failed"], [UNDERSTAND_TIMED_OUT_MESSAGE, "plan_failed"], [UNDERSTAND_ANSWER_PENDING_MESSAGE, "needs_owner"],
  [WORKFLOW_AUTO_IMPLEMENT_FAILED_MESSAGE, "run_failed"], [WORKFLOW_AUTO_REVIEW_FAILED_MESSAGE, "review_failed"], [WORKFLOW_REVIEW_RESULT_INCOMPLETE_MESSAGE, "review_failed"],
  [WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE, "pr_update_failed"], [BUDGET_EXHAUSTED_FAILURE_MESSAGE, "budget_exhausted"], [FEEDBACK_STOPPED_REASON, "not_started"],
] as const) EXACT.set(text, cause);

const SETUP_PREFIXES = [
  WORKFLOW_APPLICATION_ROUND_REFUSED_PREFIX, WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX, WORKFLOW_APPLICATION_EVIDENCE_INCOMPLETE_PREFIX, WORKFLOW_APPLICATION_PLAN_NOT_APPROVABLE_PREFIX,
  WORKFLOW_APPLICATION_RUNTIME_RENEWED_PREFIX, WORKFLOW_APPLICATION_SELECTION_CHANGED_PREFIX, WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX,
];

/** "<step> operation ended <status>": the reason a run that ended without a result records (`workflowRunEndedReason`, and the feedback review's own wording). Only the status word is read. */
const RUN_ENDED = /operation ended ([a-z_]+)$/u;

/**
 * The cause of a block, from its reason text. The text is read, never kept. An unrecognised reason is `other` (counted as a failure; a reader can leave `other` out), and no reason at all is `other` too.
 */
export function blockCauseOf(reason: string | undefined): WorkEventBlockCause {
  if (typeof reason !== "string" || reason === "") return "other";
  const exact = EXACT.get(reason);
  if (exact !== undefined) return exact;
  if (reason.startsWith(RUN_LIMIT_BLOCK_PREFIX)) return "budget_paused";
  if (isStepNotRunReason(reason)) return "not_started";
  if (SETUP_PREFIXES.some((prefix) => reason.startsWith(prefix))) return "waiting_setup";
  if (isCiFixBlockReason(reason)) return "ci_fix_gave_up";
  if (isBranchSyncBlockReason(reason)) return "branch_sync_failed";
  const ended = RUN_ENDED.exec(reason)?.[1];
  // "interrupted" is a stop that never confirmed (the stuck-cancel release, Close releasing a held workspace), so it is a stop with "cancelled", not a failure.
  if (ended === "cancelled" || ended === "canceled" || ended === "interrupted") return "cancelled";
  if (ended === "failed") return "run_failed";
  return "other";
}
