import type { WorkerInvocationFeature } from "@agentx/contracts";

/**
 * The optional invocation fields this worker implements, listed by hand and advertised on /ping. WORKER_INVOCATION_FEATURES
 * is the list of fields the shared schema knows; a worker that parses a field but does not act on it must not advertise
 * it, or the delivery guard would send it to a worker that silently ignores it. A task that adds a feature to the
 * contracts adds it here when the worker implements it ("task.agentRun" was added by Task 23).
 */
export const WORKER_IMPLEMENTED_FEATURES = [
  "model.thinkingLevel", "task.readiness", "task.workflowMode", "task.workflowReview", "task.workflowChecks", "task.workflowFeedbackReview",
  "task.workflowFeedbackApproval", "publish.reportChecks", "task.workflowBase", "publish.candidateTree", "publish.workflowBase", "publish.mode",
  "publish.contextDigest", "task.workflowReviewChecks", "task.structuredPlans", "task.workflowReviewPlan", "task.workflowPullRequestUpdate",
  "task.codeAnchors", "task.workflowReviewFeedback", "task.workflowReviewNote", "task.workflowReviewers", "model.chatgpt", "task.workflowDependencies", "task.workflowE2EAdmission",
  // M1.2 to M1.4: the application plan, application and baseline rounds, AI navigation steps, replay, and the model-free time limits and model choice (mainline's worker implements each).
  "task.workflowE2EApplicationPlan", "task.workflowE2EApplicationChecks", "task.workflowE2EApplicationChecks.v2", "task.workflowE2EBaselineChecks", "task.workflowE2EBaselineSource",
  "task.workflowE2EAgentSteps.v1", "task.workflowE2EReplayChecks.v1", "task.workflowE2EModelFreeLimits.v1", "task.workflowE2EAgentModelChoice.v1",
  "model.route", "task.agentStep", "task.agentRun",
  // Rovara Code version 2 (Plan 6): Understand runs read-only and answers with a `rovara-intent` block.
  "task.workflowUnderstand",
  // Plan 6 Task 8: the plan check of Rovara Code version 2 (a read-only model run that answers with a rovara-plan-critique block).
  "task.workflowPlanCritique",
  // Rovara Code (Plan 6 Task 10): a read-only run that drafts a project's dev setup.
  "task.setupDraft",
  // Plan 6 Task 13: the code review of a Rovara Code version 2 task states a risk level.
  "task.workflowReviewRisk",
  // Plan 6 Task 15: a coding run that fixes a pull request that is already open (CI, a conflict or comments).
  "task.workflowFix",
] as const satisfies readonly WorkerInvocationFeature[];
