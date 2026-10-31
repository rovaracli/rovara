// Rovara Cloud only: the declarations that exist in this repository but not in the public one, added to the shared groups in developer-config.ts.
// Keep this file out of the public repository (its names are private features). The script merges it in when the file exists.
import type { ConfigOverlay } from "./split-lib.ts";

const TASKS: ConfigOverlay = {
  modules: {
    "common": [
      "creatorGuard", "isAutomaticFeedbackRound", "stoppedByLoweredAutonomy", "estimateDependencies", "RUN_LIMIT_NOT_APPROVED_REFUSAL",
      "blockedOnRunLimit", "removedReasonOf",
    ],
    "task-people": [
      "getTaskPeopleForPage", "codeOwnershipConfirmation",
    ],
    "access": [
      "isSessionActor", "sessionActorAccess",
    ],
    "feedback-review": [
      "verifiedFeedbackReview", "feedbackFixPrompt", "feedbackCiBlock", "PROMPT_COMMENT_CHARS_MAX", "promptCommentBody",
      "AUTOMATIC_FEEDBACK_COMMENT_BYTES_MAX", "AutomaticFeedbackRound", "planAutomaticFeedbackRound",
    ],
    "task-view": [
      "CANDIDATE_DIFF_OPERATIONS", "candidateChangedFiles", "statusOfRun", "taskProofTable", "monthSlots", "pauseViewOf", "runLimitViewOf",
    ],
    "start": [
      "ADMISSION_REFUSALS", "startingLimitUsd", "admissionPath", "surfaceIsBound", "startAlreadyMade",
    ],
    "task-index": [
      "runResultOf", "ownerIndexRowOf",
    ],
    "task-window": [
      "requireTaskRepositoriesConnected", "capWindowBaseline", "staleBudgetPause", "requireMayGoOn", "AGENT_RUN_TURN_REFUSAL", "capWindowUpdate",
      "AUTOMATIC_KEEPS_WINDOW", "refuseAutomaticWhilePaused", "windowAndPauseUpdate", "RESUMED_WITH_ORIGINAL_INSTRUCTIONS",
      "noteResumedWithOriginal",
    ],
    "continue": [
      "resumeRequestId", "dispatchHeldStart", "SpendResumeInput", "resumeTaskAfterSpendApproval", "ContinueAsTaskSchema", "continueAsTask",
    ],
    "decide": [
      "RunLimitOutcome", "settleRunLimit",
    ],
    "workflow-retry": [
      "retryWorkflowUnderstand",
    ],
    "workflow-inputs": [
      "partsDecisionOf", "partsSettingOf",
    ],
    "workflow-coding": [
      "resumeAfterRunLimitApproval", "planCheckRetryKey", "retryPlanCritique", "ciFixRetryKey", "retryCiFix", "startAcceptedStep",
    ],
    "workflow-review": [
      "workflowReviewRiskOption", "startTaskWorkflowImplementationFromSystem", "laterProgramBuild", "fixStartHead", "startAutomaticFeedbackRound",
      "understandWatchdogDueAt",
    ],
    "workflow-starts": [
      "queueWorkflowUnderstand", "startTaskWorkflowUnderstandFromSystem", "startTaskWorkflowPlanFromSystem", "planCheckConversationId",
      "PLAN_CHECK_REQUEST_MAX_CHARS", "startTaskWorkflowPlanCritiqueFromSystem", "startTaskWorkflowCriticRevisionFromSystem",
    ],
    "task-page": [
      "mergeViewForWords", "PAGE_BREAKDOWN_REFUSALS", "pageBreakdownRefusal",
    ],
    "pull-request-body": [
      "workflowReviewLines", "proofContextOfTask",
    ],
    "publication": [
      "startTaskWorkflowBranchSyncFromSystem",
    ],
    "thread-notes": [
      "APP_NOTE_SECTION_HEADER", "isAppNote", "personLabel", "noteCountUpdate", "answerIntentFromReply", "SessionNoteRefusal", "SessionNoteInput",
      "sessionNoteItems", "recordSessionNote", "agentStepNotes",
    ],
    "cancel": [
      "TaskActor", "actingDeps", "cancelTaskFor", "SESSION_RETRY_INSTRUCTIONS", "retryTaskWorkflowFor", "stopPlanReviewItem",
    ],
    "close": [
      "endAgentRunOfClosedTask", "workflowEndOutcome", "EndTold", "noteTaskEnded", "noteTaskPaused", "tellClosedTaskEnd",
    ],
    "release": [
      "recordFinishedRunCost", "finishedReleaseMarkItem",
    ],
    "share": [
      "authorizeShare",
    ],
  },
  stay: [],
  // The order of every module in the merged config (the order of the thin file's re-exports).
  moduleOrder: [
    "types", "common", "publication-context", "task-people", "access", "access-resume", "feedback-review", "task-view", "start", "task-index",
    "task-reads", "task-window", "continue", "decide", "workflow-retry", "workflow-inputs", "workflow-coding", "workflow-review", "workflow-starts",
    "task-page", "pull-request-body", "publication", "feedback-capture", "thread-notes", "task-answer-context", "cancel", "close", "release",
    "share",
  ],
};

const ROUTES: ConfigOverlay = {
  modules: {
    "types": [
      "CLOSE_STOP_BUDGET_MS", "ProjectAccessCaller",
    ],
    "common": [
      "PROJECT_NOT_FOUND_IN_APP", "signInStoreOf", "bodyError",
    ],
    "identity-lambda": [
      "realtimeTokenThroughLambda", "refusalMessageOf", "unlinkIdentityThroughLambda", "startIdentityLinkThroughLambda",
    ],
    "authentication": [
      "DeveloperTokenClaims", "authenticateBearer",
    ],
    "project-list": [
      "grantRowsOf", "GrantRow", "nameOf", "StoredProject", "latestProjectRecord", "repositoryFullName", "appProjectSummary", "visibleProjectRoles",
      "listAppProjects", "setupCheckDepsOf", "projectMembersDepsOf", "projectMembersOf",
    ],
    "project-archive-setup": [
      "ArchiveBodySchema", "archiveDepsOf", "egressDepsOf", "getAppProject", "changeProjectArchive", "admitSetupCheck", "closeSupersededCheck",
      "SETUP_CHECK_ATTEMPTS", "SETUP_CHECK_BUSY", "startProjectSetupCheck",
    ],
    "project-members": [
      "projectRoleForRoute", "ROLE_ORDER", "getProjectMembers", "isOrgAdmin", "buildProjectMembersResponse", "notifyProjectMemberChanged",
      "MANAGE_MEMBERS_MESSAGE", "putProjectMember", "deleteProjectMember", "SLACK_BIND_ROLE_MESSAGE", "putProjectSlackChannel",
      "deleteProjectSlackChannel", "slackChannelDepsOf",
    ],
    "project-settings": [
      "listGithubRepositories", "putProjectSettings",
    ],
    "dependencies": [
      "setupDraftDepsOf", "agentRunStarterOf", "codeIntentDependenciesOf", "gateDeveloperStart", "startAppRun", "chainRouteDependenciesFor",
      "sessionDependenciesOf", "sessionReadDependencies",
    ],
    "organization": [
      "createProject", "navigationAdapters", "getAppNavigation", "getAppMe", "setMyName", "unlinkAppIdentity", "startAppIdentityLink",
      "getOrganization", "createOrganizationInvite", "ChangeRoleBodySchema", "changeMemberRole", "endSessionsAfterRemoval", "emailsOf",
      "STOPS_AFTER_STEP", "removeOrganizationMember", "LeaveBodySchema", "leaveOrganization", "budgetDependencies", "getBudget",
      "putOrganizationBudget",
    ],
  },
  stay: [],
  // The order of every module in the merged config (the order of the thin file's re-exports).
  moduleOrder: [
    "types", "common", "identity-lambda", "authentication", "project-list", "project-archive-setup", "project-members", "project-settings",
    "project-access", "dependencies", "organization",
  ],
};

export const OVERLAYS: Record<string, ConfigOverlay> = {tasks: TASKS, routes: ROUTES};
