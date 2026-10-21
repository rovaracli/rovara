import type { WorkerInvocationFeature } from "@agentx/contracts";

/**
 * The optional invocation fields this worker implements, listed by hand and advertised on /ping. WORKER_INVOCATION_FEATURES
 * is the list of fields the shared schema knows; a worker that parses a field but does not act on it must not advertise
 * it, or the delivery guard would send it to a worker that silently ignores it. A task that adds a feature to the
 * contracts adds it here when the worker implements it ("task.agentStep", "task.agentRun" and "model.route" are not yet).
 */
export const WORKER_IMPLEMENTED_FEATURES = [
  "model.thinkingLevel", "task.readiness", "task.workflowMode", "task.workflowReview", "task.workflowChecks", "task.workflowFeedbackReview",
  "task.workflowFeedbackApproval", "publish.reportChecks", "task.workflowBase", "publish.candidateTree", "publish.workflowBase", "publish.mode",
  "publish.contextDigest", "task.workflowReviewChecks", "task.structuredPlans", "task.workflowReviewPlan", "task.workflowPullRequestUpdate",
  "task.codeAnchors", "task.workflowReviewFeedback", "task.workflowReviewNote", "model.chatgpt", "task.workflowDependencies", "task.workflowE2EAdmission",
] as const satisfies readonly WorkerInvocationFeature[];
