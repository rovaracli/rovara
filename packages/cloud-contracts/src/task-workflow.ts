import { z } from "zod";
import { ActorIdSchema, CandidateManifestSchema, CI_FIX_PROBLEMS_MAX, E2EWorkflowProgressSchema, FEEDBACK_STOPPED_REASON, FeedbackCiFailuresSchema, FeedbackThreadObservationsSchema, FixSourceSchema, type ForwardReader, isStepNotRunReason, NO_CODE_CHANGED_REASON, NoChangeFindingsSchema, openSecondReviewFindings, PROGRAM_ROUNDS_MAX, readerOf, reviewCleared, RiskAssessmentSchema, StepIdSchema, SYNC_FAILURES_MAX, UNDERSTAND_ANSWER_PENDING_MESSAGE, UNDERSTAND_TIMED_OUT_MESSAGE, UNDERSTAND_UNREADABLE_MESSAGE, VerificationResultsSchema, WORKFLOW_ACCEPTED_FINDINGS_MAX, WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE, WORKFLOW_REGRESSED_CHECK_MAX, WORKFLOW_REGRESSED_CHECKS_MAX, WorkflowAcceptedFindingSchema, WorkflowArtifactSchema, WorkflowCanvasCloseoutAttemptSchema, WorkflowCanvasCloseoutSchema, WorkflowCanvasLineageSchema, WorkflowCheckPolicySchema, WorkflowCritiqueSchema, WorkflowDecisionRecordSchema, WorkflowDependencyApprovalSchema, WorkflowDesignReviewSchema, WorkflowFeedbackApprovalBindingSchema, WorkflowFeedbackDecisionSchema, WorkflowFeedbackNoteSchema, WorkflowFeedbackReviewRefSchema, WorkflowFeedbackReviewSchema, WorkflowFeedbackShownSchema, WorkflowFixRoundsSchema, WorkflowIntentSchema, workflowIsReviewOnly, WorkflowPathSchema, WorkflowProgramSchema, WorkflowPullRequestSchema, WorkflowPullRequestUpdateFailureSchema, WorkflowReviewBaseSchema, WorkflowReviewPhaseSchema, WorkflowReviewReportSchema, WorkflowSecondReviewBlockSchema, WorkflowStageSchema, WorkflowStateSchema, WorkflowVerificationRetrySchema, WorkItemProgressV1Schema } from "@rovara-code/contracts";
import { WorkflowBranchSyncSchema } from "./rovara-code.js";
import { WorkflowFlowSchema } from "./task-flow-tier.js";
// Code's own since the vendor pin 0e340c0e (one name, one owner): re-exported, not defined here.
export { BASE_MERGED_RETRY_REASON, BASE_MERGED_RETRIES_PER_DAY, BASE_MERGED_RECHECKING_MILESTONE, BASE_MERGED_NEEDS_YOU_MILESTONE } from "@rovara-code/contracts";


/** "Continue in your own tool": said once in the milestone feed when Rovara takes a head pushed outside Rovara as the task's code and starts its checks (a person asked). */
export const OUTSIDE_RECHECK_MILESTONE = "Someone pushed to the pull request outside Rovara and a re-check was asked for. Rovara is checking that code now.";

export const WORKFLOW_BLOCK_REASONS = {
  checksUnconfirmed: "AgentX couldn't confirm the selected checks ran on the final code. Choose checks and retry.",
  checkRetryStale: "This check run no longer matches the task's current step. Use the latest update in the thread.",
  checkReportUnreadable: "AgentX couldn't read the check results for the final code. Choose checks and retry.",
  /** The task has checks to run (project, proposed or chosen), but the worker reported none ran. */
  noChecksConfigured: "AgentX ran none of this task's checks on the final code. Choose checks and retry, or close the task.",
  /** Every failed check could not run: the check itself is broken, so coding again would not help. */
  checksBroken: "the checks couldn't run",
  checkRunnerFailed: "AgentX couldn't run the selected checks. Retry once the check runner is working.",
  /** Review only: AgentX's rerun of the agent's own tests found one that passed before and fails now. */
  regressionFound: "A test that passed before this change fails now. Send it back to coding, or close the task.",
  repositoriesIncomplete: "AgentX couldn't find every repository in the final code. Retry coding, or close the task.",
  /** The coding run finished, but the code is still what the task started from (WORKFLOW_NO_CODE_CHANGE_MESSAGE). */
  noCodeChanged: NO_CODE_CHANGED_REASON,
  /** A review stopped before it started: the base commit's rule files could not be checked against the commit's own ids (WORKFLOW_RULE_FILES_UNVERIFIED_MESSAGE). */
  ruleFilesUnverified: "AgentX couldn't verify the base rule files, so the review did not run. Retry the review, or close the task.",
  /** The same stop for Understand and the plan check (Cloud only), which are not reviews. */
  stepRuleFilesUnverified: "AgentX couldn't verify the base rule files, so this step did not run. Retry it, or close the task.",
  /**
   * Understand or Plan stopped because the owner's live message asked for a change outside what was approved (WORKFLOW_LIVE_STEER_REAPPROVAL_MESSAGE). Retry plans again with the message, and the
   * new plan is what the owner approves before anything is built.
   */
  liveSteerReapproval: "A live message from the owner asks for a change outside what was approved, so this step stopped. Choose Retry: Rovara plans again with that message, and you approve the new plan before anything is built.",
  /**
   * The same stop at Coding for a task whose plan cannot take the change in (a custom sequence, an open pull request or a fix round: `workflowReviseOffered` is false). Retry coding and Send back both keep the
   * approved plan, so the words say what the ways do: the run's changes stay in the workspace unchecked (a stopped coding run keeps its working tree: pinned by tests/integration/worker-cancelled-implement-keeps-work.test.ts), Retry continues the approved plan from the current code without the change, and a new task is how to include it.
   */
  liveSteerReapprovalCoding: "A live message from the owner asks for a change outside the approved plan, so coding stopped. What the run changed so far is still in the workspace but was not checked. Retry coding continues the approved plan from the current code without that change. To include the change, close this task and start a new task that asks for it.",
  /**
   * The same stop at Coding for a task whose plan can take the change in (`workflowReviseOffered`): the card and the page offer Revise the plan, which plans again with the owner's message and asks the
   * owner to approve the revised plan before coding continues; Retry coding still builds the approved plan without it.
   */
  liveSteerReapprovalRevise: "A live message from the owner asks for a change outside the approved plan, so coding stopped. What the run changed so far is still in the workspace but was not checked. Choose Revise the plan (in the task's Slack thread or on the task page): Rovara plans again with that change, and you approve the revised plan before coding continues. Or choose Retry coding to continue the approved plan from the current code without that change.",
  /** A step that only reads the code could not first stop the programs earlier work left running (WORKFLOW_LEFTOVER_PROCESSES_MESSAGE). */
  leftoverProcesses: "AgentX couldn't stop the programs left running from earlier work, so this step did not run.",
  /** The checks' fresh dev container ran its setup commands and they changed the project's files (WORKFLOW_SETUP_CHANGED_FILES_MESSAGE); the files are left as they are. */
  setupChangedFiles: "The dev container's setup changed the project's files, so the checks did not run. Look at what its setup commands change, then retry, or close the task.",
  /** An approved PR feedback fix left every repository's code as its open pull request holds it: nothing was pushed. */
  fixChangedNothing: "The approved fix didn't change any code, so nothing was pushed.",
  codeChangedAfterChecks: "The code changed after its checks ran. Run the checks again on the latest code.",
  /** The base branch was merged into the pull request's branch: the merged code is a new candidate, so its checks and reviews run again before the task waits for the merge (a merge is not trusted on its parents alone). */
  baseMergedRecheck: "The base branch was merged into this pull request, so the merged code needs its checks and reviews again before it is called ready.",
  /** "Continue in your own tool" (owner Q13): a person asked Rovara to re-check a pull request head pushed outside Rovara; Rovara took that exact head as the task's code and starts its checks now. */
  outsideRecheck: "Someone pushed to the pull request outside Rovara and a re-check was asked for, so Rovara took that code as the task's code and is starting its checks.",
  /** The pull request's head moved again while Rovara re-checked the earlier one: that result is not the code on the pull request, so it is not recorded as passing. */
  outsideRecheckStale: "The pull request changed again while Rovara was re-checking it, so that result doesn't count. Choose Retry checks to check the code Rovara took again, or send the task back.",
  /** The company's limit on how far Rovara may act on its own was lowered while the merged code's checks re-ran: the reviews (paid) did not start. */
  recheckAutonomyLowered: "Rovara is no longer set to act on its own here, so it stopped before the reviews of the merged code. Choose Retry reviews to run them.",
  /** A rerun of the checks of code a pull request already holds ran on other code than the code the pull request shows. */
  checkedOtherCode: "The checks ran on other code than the code on the pull request. Send the task back to coding, or close it.",
  startUnrecorded: "AgentX could not record where this change started. Close the task and start a new one.",
  startUnconfirmed: "AgentX could not confirm the task's starting commit on GitHub.",
  startChanged: "The code's starting point changed. Send the task back to coding or close it.",
  noCheckResults: "No required or selected optional checks ran. Configure or select at least one check, then retry.",
  planNotSaved: "The planning run finished without saving a document. Retry planning.",
  /** The saved plan is a structured document that could not be read back. */
  planUnreadable: "the plan couldn't be read",
  /** Plan 6 Task 8: the plan check's answer had no block Rovara could read. */
  planCheckUnreadable: "Rovara couldn't read the plan check's answer.",
  /** Plan 6 Task 8: the plan check or the revision after it could not be started, however often it was tried. */
  planCheckNotStarted: "Rovara couldn't start the plan check.",
  planRevisionNotStarted: "Rovara couldn't start revising the plan after its check.",
  pullRequestChanged: "The pull request on GitHub no longer holds the checked code, so I won't finish this task from it. Close the task.",
  /** A required pull request was closed on GitHub without merging; reopened, it is followed again. */
  pullRequestClosed: "The pull request was closed on GitHub without merging. Reopen it there, or close this task.",
  /** The pull request's feedback review failed; AgentX still watches the pull request for its merge. */
  feedbackReviewFailed: "I couldn't review the feedback on the pull request, so I have nothing to propose from it.",
  /** The approved fix could not be pushed to the pull request; AgentX still watches the pull request for its merge. */
  pullRequestUpdateFailed: "I couldn't push the fix to the pull request.",
  /** Shown only in a task view, never stored: the document waiting for approval failed its digest check. */
  documentUnverified: "The saved document couldn't be checked, so I stopped. Close this task and start again.",
  /** Plan 3, Task 32: a step ran out of its run's budget and a spend request is open; approving it retries the step. */
  budgetPaused: "Paused: this task needs more AI budget. I've asked for it.",
  /** Rovara Code version 2: Understand's answer could not be read, even after one more try. */
  understandUnreadable: UNDERSTAND_UNREADABLE_MESSAGE,
  /** Rovara Code version 2: the request needs no code change, and closing a task as answered is not available yet. */
  understandAnswerPending: UNDERSTAND_ANSWER_PENDING_MESSAGE,
  /** Rovara Code version 2: Understand never came back in time, so the task was ended. */
  understandTimedOut: UNDERSTAND_TIMED_OUT_MESSAGE,
  /** Rovara Code version 2: the dispatch could not start Understand, or the plan step after it, within its attempts. */
  understandNotStarted: "I couldn't start reading your request. Retry it.",
  planNotStarted: "I couldn't start the plan. Retry planning.",
  /** Rovara Code version 2: Understand chose the Full path, but a Full start would not be admitted on the budgets that are left. */
  understandFullNotAdmitted: "I chose the Full path for this task, but there isn't enough AI budget left to start a Full plan. Raise the budget, then retry.",
} as const;
/** The definition versions a stored snapshot may have: Rovara Code v1 (today's engine) and v2. */
export const WORKFLOW_DEFINITION_VERSIONS = ["1.0.0", "1.1.0"] as const;
export type WorkflowDefinitionVersion = (typeof WORKFLOW_DEFINITION_VERSIONS)[number];

/** The task snapshot's storage budget for its workflow metadata (the feedback, canvas and dependency records), in bytes of JSON. */
export const WORKFLOW_METADATA_BUDGET_BYTES = 262_144;
/** The bytes of JSON the metadata of a workflow takes against `WORKFLOW_METADATA_BUDGET_BYTES`. One definition, so a writer can measure a record before adding it. */
export function workflowMetadataBytes(workflow: { [K in "feedbackReview" | "feedbackDecisions" | "feedbackDispatchApproval" | "feedbackNotes" | "feedbackReviewHistory" | "feedbackShown" | "feedbackThreadObservations" | "verificationRetries" | "canvasLineage" | "canvasCloseout" | "canvasCloseoutAttempt" | "workflowDependenciesApproval" | "workflowDependenciesOperationId" | "workflowDependenciesProgress"]?: unknown }): number {
  const taskMetadata = { feedbackReview: workflow.feedbackReview, feedbackDecisions: workflow.feedbackDecisions, feedbackDispatchApproval: workflow.feedbackDispatchApproval, feedbackNotes: workflow.feedbackNotes, feedbackReviewHistory: workflow.feedbackReviewHistory, feedbackShown: workflow.feedbackShown, feedbackThreadObservations: workflow.feedbackThreadObservations, verificationRetries: workflow.verificationRetries, canvasLineage: workflow.canvasLineage, canvasCloseout: workflow.canvasCloseout, canvasCloseoutAttempt: workflow.canvasCloseoutAttempt, workflowDependenciesApproval: workflow.workflowDependenciesApproval, workflowDependenciesOperationId: workflow.workflowDependenciesOperationId, workflowDependenciesProgress: workflow.workflowDependenciesProgress };
  return new TextEncoder().encode(JSON.stringify(taskMetadata)).length;
}

export const WorkflowSnapshotShapeSchema = z.object({
  schemaVersion: z.literal(1),
  definitionId: z.literal("agentx-task-to-pr"),
  /** "1.1.0" (Rovara Code v2) alone may hold the stages UNDERSTAND and PLAN_CRITIQUE, the outcome ANSWERED, and `intent`, `critique` and `risk`. */
  definitionVersion: z.enum(WORKFLOW_DEFINITION_VERSIONS),
  taskId: z.string().uuid(),
  ownerId: ActorIdSchema,
  path: WorkflowPathSchema.default("QUICK"),
  reviewPhase: WorkflowReviewPhaseSchema.optional(),
  revision: z.number().int().positive(),
  stage: WorkflowStageSchema,
  state: WorkflowStateSchema,
  blockReason: z.string().max(500).optional(),
  /**
   * Review only: the tests (labels or commands, worker output, untrusted) AgentX's rerun found passed before this change
   * and fail now. Kept through a send-back so the coder hears of them; the next block or verification replaces them.
   */
  regressedChecks: z.array(z.string().trim().min(1).max(WORKFLOW_REGRESSED_CHECK_MAX)).min(1).max(WORKFLOW_REGRESSED_CHECKS_MAX).optional(),
  /**
   * A coding run that ended with no code change: the commands the agent ran, what they printed and the agent's own conclusion, redacted and bounded (`NoChangeFindingsSchema`), kept while the step is
   * blocked with `noCodeChanged` and shown with it. Absent from an older worker's result and from every other block.
   */
  noChangeFindings: NoChangeFindingsSchema.optional(),
  outcome: z.enum(["PASSED", "SKIPPED", "CHANGES_REQUESTED", "REJECTED", "MERGED", "CLOSED", "ANSWERED"]).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  artifacts: z.array(WorkflowArtifactSchema).max(100),
  decisions: z.array(WorkflowDecisionRecordSchema).max(100),
  checkPolicy: WorkflowCheckPolicySchema.optional(),
  /** Frozen E2E references. Results remain separately qualified by the broker. */
  e2e: E2EWorkflowProgressSchema.optional(),
  verificationRetries: z.array(WorkflowVerificationRetrySchema).max(100).optional(),
  candidate: CandidateManifestSchema.optional(),
  /** Each repository's base commit, pinned by the first verified candidate; later candidates must keep it. */
  reviewBase: WorkflowReviewBaseSchema.optional(),
  verification: VerificationResultsSchema.optional(),
  reviews: z.array(WorkflowReviewReportSchema).max(2).optional(),
  /** Blocking review findings the owner accepted, each for the candidate it was found on; the newest 100. */
  acceptedFindings: z.array(WorkflowAcceptedFindingSchema).max(WORKFLOW_ACCEPTED_FINDINGS_MAX).optional(),
  pullRequests: z.array(WorkflowPullRequestSchema).max(32).optional(),
  /** When an approved fix was last pushed to the existing pull requests. */
  pullRequestUpdatedAt: z.string().datetime().optional(),
  /** Why the latest push of a fix failed, for the owner's message: the pull requests it was for, and a plain cause when known. */
  pullRequestUpdateFailure: WorkflowPullRequestUpdateFailureSchema.optional(),
  feedbackReview: WorkflowFeedbackReviewSchema.optional(),
  /**
   * The review threads as last seen when there was nothing to review (feedback only in resolved threads), so a later reply
   * in a thread seen resolved counts as new feedback. A collected review keeps its own observations instead.
   */
  feedbackThreadObservations: FeedbackThreadObservationsSchema.optional(),
  feedbackReviewHistory: z.array(WorkflowFeedbackReviewRefSchema).max(100).optional(),
  feedbackDecisions: z.array(WorkflowFeedbackDecisionSchema).max(100).optional(),
  feedbackDispatchApproval: WorkflowFeedbackApprovalBindingSchema.optional(),
  /** Rovara Code v2: the failing checks added to the owner's feedback card while it waits (Plan 6 Task 16); moved into the decision once decided. */
  feedbackCiFailures: FeedbackCiFailuresSchema.optional(),
  feedbackNotes: z.array(WorkflowFeedbackNoteSchema).max(100).optional(),
  /** The comments the agent was shown in every feedback round (lessons capture); see `WorkflowFeedbackShownSchema`. */
  feedbackShown: WorkflowFeedbackShownSchema.optional(),
  canvasLineage: z.array(WorkflowCanvasLineageSchema).max(100).optional(),
  canvasLineageVersion: z.number().int().nonnegative().optional(),
  canvasCloseout: WorkflowCanvasCloseoutSchema.optional(),
  canvasCloseoutAttempt: WorkflowCanvasCloseoutAttemptSchema.optional(),
  workflowDependenciesApproval: WorkflowDependencyApprovalSchema.optional(),
  /** Broker-authored pointer to the accepted operation for the current approved graph attempt; never exposed in task views. */
  workflowDependenciesOperationId: z.string().uuid().optional(),
  workflowDependenciesProgress: z.array(WorkItemProgressV1Schema).max(32).optional(),
  /** A custom coding sequence the engine follows; absent for Rovara Code's own path. */
  program: WorkflowProgramSchema.optional(),
  /** The program step the workflow is at (or, before its first step, the plan step); only with a program. */
  programStepId: StepIdSchema.optional(),
  /** How many review rounds each review step has finished, so a step that keeps finding problems blocks at its `maxRounds`. */
  programRounds: z.record(StepIdSchema, z.number().int().min(1).max(PROGRAM_ROUNDS_MAX)).optional(),
  /** Rovara Code v2 (1.1.0 only): what Understand made of the request, the questions asked and the answers. */
  intent: WorkflowIntentSchema.optional(),
  /** Rovara Code v2 (1.1.0 only): the plan critic's points. */
  critique: WorkflowCritiqueSchema.optional(),
  /** Design review stage (DR6; 1.1.0 and the Full path only): the fresh-context reviewers' record for the task's design, beside `critique`. Absent when design review is off. */
  designReview: WorkflowDesignReviewSchema.optional(),
  /** The lighter flow (0.5.18 reader, both versions; nothing writes it yet): the tier of the change, the steps skipped and the quick checks. The same shape as Rovara Code's `flow` (`task-flow-tier.ts`). */
  flow: WorkflowFlowSchema.optional(),
  /** Rovara Code v2 (1.1.0 only): the risk level of the pull request's code. */
  risk: RiskAssessmentSchema.optional(),
  /** Both versions: how many fix rounds of each kind ran, and which kind the round now running is. */
  fixRounds: WorkflowFixRoundsSchema.optional(),
  /** SR-1 (switch `cr`, `on`): the second review's blocking findings for one candidate; see `WorkflowSecondReviewBlockSchema`. */
  secondReviewBlock: WorkflowSecondReviewBlockSchema.optional(),
  fixSource: FixSourceSchema.optional(),
  /** Both versions: the names of the failing checks the fix now running is for (at most five, one line each); present only with `fixSource`. */
  fixProblems: z.array(z.string().trim().min(1).max(200)).min(1).max(CI_FIX_PROBLEMS_MAX).optional(),
  /**
   * Both versions: a person told Rovara to go on with a CI fix it was waiting to be told about (Retry). It names the heads of the open pull requests that were failing when they said it, and only a
   * failure on one of those heads is covered. The next CI fix round starts whatever the autonomy and the rounds used (that one round is not counted), and clears it.
   */
  ciFixApproved: z.array(z.string().regex(/^[a-f0-9]{40}$/)).min(1).max(32).optional(),
  /**
   * Both versions (Plan 6 Task 17): Rovara is merging the base branch into one pull request's branch. WAIT_FOR_MERGE/READY while the merge is queued, WAIT_FOR_MERGE/RUNNING while the worker
   * runs it. It names the head the merge is for: a head that is no longer that one (a person pushed) stops it.
   */
  branchSync: WorkflowBranchSyncSchema.optional(),
  /**
   * Version 2 ("Continue in your own tool", owner Q13): a person's Recheck of a pull request head pushed outside Rovara. `adopting` (WAIT_FOR_MERGE/RUNNING): a read-only worker run checks the head out
   * and pushes nothing. `checking` (VERIFY): the head is the task's candidate and its checks run as the person's own Retry checks. Removed when the re-check's checks are recorded (pass or fail; a
   * result the pull request moved under puts back what the task had before the adoption), or when they could not start.
   */
  outsideRecheck: z.object({
    repositoryId: z.string().trim().min(1).max(200),
    number: z.number().int().positive(),
    headSha: z.string().regex(/^[a-f0-9]{40}$/),
    previousHeadSha: z.string().regex(/^[a-f0-9]{40}$/),
    requestId: z.string().uuid(),
    actorId: z.string().min(1).max(200),
    phase: z.enum(["adopting", "checking"]),
    at: z.string().datetime(),
  }).strict().optional(),
  /**
   * Version 2 ("Continue in your own tool"): the last re-check's result went stale (the pull request moved while its checks ran), so the task went back to its earlier checked code. Said once in the
   * thread; removed by the next change to the pull requests' heads (a push, a merge of the base, another re-check).
   */
  outsideRecheckStale: z.object({ headSha: z.string().regex(/^[a-f0-9]{40}$/), at: z.string().datetime() }).strict().optional(),
  /** S2: a queued step is waiting for Slack to answer the access check (an outage). `revision` is the workflow revision it waits at, so a later step never inherits the note. Set and cleared by the dispatcher; the page says "Waiting for Slack". */
  accessCheckWaitSince: z.object({ revision: z.number().int().positive(), since: z.string().datetime() }).strict().optional(),
  /**
   * Both versions (Plan 6 Task 17): the commit of the base branch whose merge conflicted, while a conflict round resolves it. The round's fix is pushed as a merge commit with this commit as its second
   * parent. Present only with `fixSource: "conflict"`.
   */
  conflictBase: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  /** Both versions: a person told Rovara to go on with a conflict it asked about (Retry): the heads of the open pull requests then. The merge it starts uses it up. */
  conflictApproved: z.array(z.string().regex(/^[a-f0-9]{40}$/)).min(1).max(32).optional(),
  /** Both versions: how many times a merge of the base failed on this head (a head a person pushes starts the count again). Rovara stops at `SYNC_FAILURES_MAX`. */
  syncFailures: z.object({
    headSha: z.string().regex(/^[a-f0-9]{40}$/),
    /** Real failures of the merge (its checks failed, Git refused): at `SYNC_FAILURES_MAX` Rovara stops trying this head. */
    count: z.number().int().min(0).max(SYNC_FAILURES_MAX),
    /** Failures that were not the merge's (GitHub, a lost machine): never a stop, but each doubles the wait before the next try. */
    transient: z.number().int().min(1).max(1000).optional(),
    retryAfter: z.string().datetime().optional(),
  }).strict().optional(),
}).superRefine((workflow, context) => {
  if (workflow.definitionVersion === "1.0.0") {
    if (workflow.stage === "UNDERSTAND" || workflow.stage === "PLAN_CRITIQUE") {
      context.addIssue({ code: "custom", path: ["stage"], message: "this stage needs definition version 1.1.0" });
    }
    if (workflow.outcome === "ANSWERED") context.addIssue({ code: "custom", path: ["outcome"], message: "this outcome needs definition version 1.1.0" });
    if (workflow.artifacts.some((artifact) => artifact.type === "answer")) context.addIssue({ code: "custom", path: ["artifacts"], message: "an answer needs definition version 1.1.0" });
    for (const field of ["intent", "critique", "risk", "designReview"] as const) {
      // The lighter flow's record lets a design review sit on a task of either version: only the one that carries `flow`.
      if (field === "designReview" && workflow.flow !== undefined) continue;
      if (workflow[field] !== undefined) context.addIssue({ code: "custom", path: [field], message: `${field} needs definition version 1.1.0` });
    }
    if (workflow.program?.steps.some((step) => step.kind === "plan_critic") === true) {
      context.addIssue({ code: "custom", path: ["program"], message: "a plan check step needs definition version 1.1.0" });
    }
    if (workflow.reviews?.some((review) => review.risk !== undefined) === true) context.addIssue({ code: "custom", path: ["reviews"], message: "a review's risk level needs definition version 1.1.0" });
  }
  if (workflow.designReview !== undefined) {
    // The lighter flow may ask for a design review on a Quick path: only a task that carries its `flow` record.
    if (workflow.path !== "FULL" && workflow.flow === undefined) context.addIssue({ code: "custom", path: ["designReview"], message: "design review runs on the Full path" });
    if (new TextEncoder().encode(JSON.stringify(workflow.designReview)).length > 150_000) context.addIssue({ code: "custom", path: ["designReview"], message: "the design review record is too large to keep" });
  }
  if (workflow.fixProblems !== undefined && workflow.fixSource === undefined) {
    context.addIssue({ code: "custom", path: ["fixProblems"], message: "the problems a fix is for need the fix's source" });
  }
  if (workflow.conflictBase !== undefined && workflow.fixSource !== "conflict") {
    context.addIssue({ code: "custom", path: ["conflictBase"], message: "the base commit of a conflict is kept only while a conflict round runs" });
  }
  if (workflow.branchSync !== undefined && !(workflow.stage === "WAIT_FOR_MERGE" && (workflow.state === "READY" || workflow.state === "RUNNING"))) {
    context.addIssue({ code: "custom", path: ["branchSync"], message: "a merge of the base branch is queued or running only while waiting for the merge" });
  }
  if (workflow.outsideRecheck !== undefined) {
    // Only the adopting phase is pinned to a step: the later phases ride along whatever a person does next (Send back, Close), and are removed when checks are recorded.
    const fits = workflow.outsideRecheck.phase !== "adopting" || (workflow.stage === "WAIT_FOR_MERGE" && workflow.state === "RUNNING" && workflow.branchSync === undefined);
    if (!fits) context.addIssue({ code: "custom", path: ["outsideRecheck"], message: "a re-check of an outside head is at the step its phase names" });
  }
  if (workflow.program === undefined) {
    if (workflow.programStepId !== undefined || workflow.programRounds !== undefined) {
      context.addIssue({ code: "custom", path: ["program"], message: "a program position needs its program" });
    }
  } else {
    if (workflow.programStepId !== undefined && !workflow.program.steps.some((step) => step.id === workflow.programStepId)) {
      context.addIssue({ code: "custom", path: ["programStepId"], message: "the program position must be a step of the program" });
    }
    if (Object.keys(workflow.programRounds ?? {}).some((id) => workflow.program?.steps.find((step) => step.id === id)?.kind !== "review")) {
      context.addIssue({ code: "custom", path: ["programRounds"], message: "review rounds are counted only for review steps of the program" });
    }
  }
  if (workflowMetadataBytes(workflow) > WORKFLOW_METADATA_BUDGET_BYTES) {
    context.addIssue({ code: "custom", message: "workflow metadata exceeds the task snapshot storage budget" });
  }
  const dependencyApproval = workflow.workflowDependenciesApproval;
  if (workflow.workflowDependenciesOperationId !== undefined && dependencyApproval === undefined) {
    context.addIssue({ code: "custom", path: ["workflowDependenciesOperationId"], message: "the current graph operation must reference a retained graph approval" });
  }
  if (dependencyApproval !== undefined) {
    if (!workflow.artifacts.some((artifact) => artifact.type === "plan" && artifact.sha256 === dependencyApproval.artifactDigest)
      || !workflow.decisions.some((decision) => decision.workflowRevision === dependencyApproval.workflowRevision
        && decision.actorId === dependencyApproval.actorId && decision.artifactDigest === dependencyApproval.artifactDigest
        && decision.workBreakdownDigest === dependencyApproval.graphDigest && decision.decision === "APPROVE")) {
      context.addIssue({ code: "custom", path: ["workflowDependenciesApproval"], message: "work breakdown approval must match a whole-plan decision and its artifact" });
    }
  }
  if (workflow.workflowDependenciesProgress !== undefined) {
    if (dependencyApproval === undefined || workflow.workflowDependenciesProgress.some((progress) => progress.graphDigest !== dependencyApproval.graphDigest
      || progress.runId !== dependencyApproval.runId)) {
      context.addIssue({ code: "custom", path: ["workflowDependenciesProgress"], message: "work item progress must match the current approved graph run" });
    }
    const sequences = workflow.workflowDependenciesProgress.map((progress) => progress.sequence);
    if (new Set(sequences).size !== sequences.length) context.addIssue({ code: "custom", path: ["workflowDependenciesProgress"], message: "work item progress sequence numbers must be unique" });
  }
  if (new Set((workflow.canvasLineage ?? []).map((canvas) => canvas.key)).size !== (workflow.canvasLineage ?? []).length) {
    context.addIssue({ code: "custom", path: ["canvasLineage"], message: "Canvas lineage keys must be unique" });
  }
  if (workflow.canvasLineage?.some((canvas) => !workflow.artifacts.some((artifact) => artifact.id === canvas.artifactId
    && artifact.objectKey === canvas.artifactRef && artifact.sha256 === canvas.artifactDigest))) {
    context.addIssue({ code: "custom", path: ["canvasLineage"], message: "Canvas lineage must reference a workflow artifact" });
  }
  if (workflow.feedbackReview?.reviewRef?.taskId !== undefined && workflow.feedbackReview.reviewRef.taskId !== workflow.taskId) {
    context.addIssue({ code: "custom", message: "feedback review must belong to this task" });
  }
  if (workflow.feedbackReview?.bundleRefs.some(b => b.taskId !== workflow.taskId)) {
    context.addIssue({ code: "custom", message: "collected bundles must belong to this task" });
  }
  if (workflow.path === "FULL" && workflow.reviewPhase === undefined) {
    context.addIssue({ code: "custom", path: ["reviewPhase"], message: "full workflow must name the current approval phase" });
  }
  // A pull request that merged while its approved fix was still being made holds earlier reviewed code: its checks and
  // reviews were recorded with that code (and its head and tree with the pull request), not with the fix's candidate.
  const mergedEarlierCode = workflow.stage === "MERGED" && workflow.candidate !== undefined
    && !(workflow.pullRequests ?? []).some((pullRequest) => pullRequest.required && pullRequest.candidateDigest === workflow.candidate?.digest);
  const atOrAfterPrReady = ["PULL_REQUEST", "WAIT_FOR_MERGE", "MERGED"].includes(workflow.stage) && !mergedEarlierCode;
  if (atOrAfterPrReady) {
    const currentDigest = workflow.candidate?.digest;
    const verification = currentDigest !== undefined && workflow.verification?.candidateDigest === currentDigest ? workflow.verification : undefined;
    // Passing results, or a review-only verification of a task with no check to run.
    const checksPass = verification !== undefined && (verification.results.length > 0
      ? verification.results.every((result) => result.status === "PASS")
      : verification.reviewOnly === true && workflowIsReviewOnly(workflow.checkPolicy));
    const reviewsPass = currentDigest !== undefined && (["CRITIC", "SECURITY"] as const).every((role) =>
      workflow.reviews?.some((review) => review.role === role && review.candidateDigest === currentDigest && reviewCleared(review, workflow.acceptedFindings)) === true);
    if (!checksPass) context.addIssue({ code: "custom", path: ["verification"], message: "PR readiness requires passing checks for the current candidate" });
    if (!reviewsPass) context.addIssue({ code: "custom", path: ["reviews"], message: "PR readiness requires critic and security passes for the current candidate" });
    if (openSecondReviewFindings(workflow).length > 0) context.addIssue({ code: "custom", path: ["secondReviewBlock"], message: "PR readiness requires every blocking finding of the second review to be resolved" });
  }
  // Ready, or blocked only because AgentX gave up opening the draft pull request on its own (the owner retries it), or
  // running only while a fix is pushed to the pull requests already open.
  if (workflow.stage === "PULL_REQUEST" && workflow.state !== "READY"
    && !(workflow.state === "BLOCKED" && (workflow.blockReason === WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE || isStepNotRunReason(workflow.blockReason)))
    && !(workflow.state === "RUNNING" && (workflow.pullRequests ?? []).length > 0)) {
    context.addIssue({ code: "custom", path: ["state"], message: "pull request stage must be ready" });
  }
  if (workflow.stage === "WAIT_FOR_MERGE" || workflow.stage === "MERGED") {
    const pullRequests = workflow.pullRequests ?? [];
    const required = pullRequests.filter((pullRequest) => pullRequest.required);
    // A pull request holds earlier reviewed code only after pushing its fix failed (or was stopped because the autonomy was lowered), or when it merged before the fix was pushed.
    const earlierAllowed = workflow.stage === "MERGED" || (workflow.state === "BLOCKED" && (workflow.blockReason === WORKFLOW_BLOCK_REASONS.pullRequestUpdateFailed || workflow.blockReason === FEEDBACK_STOPPED_REASON || isStepNotRunReason(workflow.blockReason)));
    if (required.length === 0 || workflow.candidate === undefined
      || (!earlierAllowed && pullRequests.some((pullRequest) => pullRequest.candidateDigest !== workflow.candidate?.digest))
      || workflow.candidate.repositories.some((repository) => !required.some((pullRequest) => pullRequest.repositoryId === repository.repositoryId))) {
      context.addIssue({ code: "custom", path: ["pullRequests"], message: "merge tracking requires candidate-bound required pull requests" });
    }
    if (workflow.stage === "MERGED" && (workflow.state !== "COMPLETE" || workflow.outcome !== "MERGED"
      || required.some((pullRequest) => pullRequest.state !== "MERGED"))) {
      context.addIssue({ code: "custom", path: ["pullRequests"], message: "merged stage requires every required pull request to be observed merged" });
    }
  }
});

/**
 * A workflow as a task view shows it. Besides every stored shape, a view may show an approval as blocked when its
 * saved document failed its digest check (`WORKFLOW_BLOCK_REASONS.documentUnverified`); that state is never stored.
 */
export const WorkflowSnapshotViewSchema = WorkflowSnapshotShapeSchema;

/**
 * A workflow as a client that sends `x-agentx-task-view: 2` reads it, tolerant of a newer server. A stage or outcome it does not know reads as
 * "unknown" (a missing one is still an error), `definitionVersion` is any string, and fields it does not know are kept. Derived from the strict
 * shape, so the two cannot drift apart. `WorkflowSnapshotReaderShape` is for a view that adds fields of its own.
 */
export const WorkflowSnapshotReaderShape = {
  ...Object.fromEntries(Object.entries(WorkflowSnapshotShapeSchema.shape).map(([key, field]) => [key, readerOf(field as z.ZodType)])),
  definitionVersion: z.string().min(1).max(32),
  // `readerOf` hands a field with a default, or a literal, back unchanged, so a value a newer server added would fail the whole read: these two read it as "unknown".
  definitionId: z.string().transform((value): "agentx-task-to-pr" | "unknown" => (value === "agentx-task-to-pr" ? value : "unknown")),
  path: z.string().optional().transform((value): z.infer<typeof WorkflowPathSchema> | "unknown" => (value === undefined ? "QUICK" : (WorkflowPathSchema.options as readonly string[]).includes(value) ? value as z.infer<typeof WorkflowPathSchema> : "unknown")),
};
export type WorkflowSnapshotReader = ForwardReader<Omit<z.output<typeof WorkflowSnapshotShapeSchema>, "definitionVersion"> & { definitionVersion: string }>;
export const WorkflowSnapshotReaderSchema = z.looseObject(WorkflowSnapshotReaderShape) as unknown as z.ZodType<WorkflowSnapshotReader>;
