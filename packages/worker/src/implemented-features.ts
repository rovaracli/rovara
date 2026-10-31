import type { WorkerInvocationFeature } from "@agentx/contracts";

/**
 * The optional invocation fields this worker implements, listed by hand and advertised on /ping. WORKER_INVOCATION_FEATURES
 * is the list of fields the shared schema knows; a worker that parses a field but does not act on it must not advertise
 * it, or the delivery guard would send it to a worker that silently ignores it. A task that adds a feature to the
 * contracts adds it here when the worker implements it ("task.agentRun" was added by Task 23).
 */
export const WORKER_IMPLEMENTED_FEATURES = [
  "task.modelPolicy",
  "model.thinkingLevel", "task.readiness", "task.workflowMode", "task.workflowReview", "task.workflowChecks", "task.workflowFeedbackReview",
  "task.workflowFeedbackApproval", "publish.reportChecks", "task.workflowBase", "publish.candidateTree", "publish.workflowBase", "publish.mode",
  "publish.contextDigest", "task.workflowReviewChecks", "task.structuredPlans", "task.workflowReviewPlan", "task.workflowPullRequestUpdate",
  "task.codeAnchors", "task.workflowReviewFeedback", "task.workflowReviewNote", "task.workflowReviewers", "model.chatgpt", "task.workflowDependencies", "task.workflowE2EAdmission",
  // M1.2 to M1.4: the application plan, application and baseline rounds, AI navigation steps, replay, and the model-free time limits and model choice (mainline's worker implements each).
  "task.workflowE2EApplicationPlan", "task.workflowE2EApplicationChecks", "task.workflowE2EApplicationChecks.v2", "task.workflowE2EBaselineChecks", "task.workflowE2EBaselineSource",
  "task.workflowE2EAgentSteps.v1", "task.workflowE2ECaptureExtras.v1", "task.workflowE2EReplayChecks.v1", "task.workflowE2EModelFreeLimits.v1", "task.workflowE2EAgentModelChoice.v1",
  "model.route", "task.agentStep", "task.agentRun", "task.agentGrounding.v1",
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
  // Plan 6 Task 16: a coding run whose PR feedback approval is Rovara's own (it carries the autonomy it was decided under).
  "task.workflowFeedbackAutonomy",
  // Rovara Code v2: independent parts of an approved plan build side by side (parallel-parts.ts).
  "task.workflowParallelParts",
  // Plan 6 Task 17: a merge of the base branch into a workflow task's pull request branch, and a conflict round's fix pushed as a merge commit.
  "maintain.workflowSync",
  // Mainline #408: the plan dry run (a coding plan's proposed checks tried on the unchanged code; the executor monitor withholds it on a host without the executor image) and the grounding round (T7a/T7b).
  "task.workflowPlanDryRun.v1", "task.workflowE2EGroundingChecks.v1",
  // Mainline #413 (MIDSTEPCOOKIE): the executor syncs the browser's session values before every model call; the application-runtime monitor withholds it on a host whose executor image lacks the session-sync label.
  "task.workflowE2EMidStepSync.v1",
  // Live steer: a person's message reaches the running Understand, Plan or Implement step's session (steer-invocation.ts).
  "task.liveSteer.v1",
  // Meta repo lane A3: the prepare invocation's `meta` request (the project's meta repository, read-only and sparse; meta-checkout.ts).
  "prepare.metaRepo",
  // Lane E (MCP context sources): an Understand, Plan, Plan-check or Review stage asks the broker for the project's source tools (worker/src/context-sources).
  "task.contextSources.v1",
] as const satisfies readonly WorkerInvocationFeature[];
