// The groups the developer files are split into. A name that is in no list is placed with its only user, or in `fallbackModule` (the dry run says which).
// The module keys are in the order the thin file re-exports them. To split another checkout of these files (the public mainline copies differ), run
// `node scripts/split/split-developer.ts --root <checkout> --dry-run`: it lists names the file no longer has and names this config does not know.
import type { SplitConfig } from "./split-lib.ts";

const TASKS_MODULES: SplitConfig["modules"] = {
  "types": [
    "DeveloperTaskRouteDependencies",
  ],
  "common": [
    "creatorGuard", "TASK_ID", "iso", "log", "parse", "taskWorkflowCheckPolicy", "body", "get", "putNew", "turnTable", "turnRecordFailed", "partyOf",
    "partyOfTaskActor", "redactedTitle", "REQUEST_TEXT_MAX_CHARS", "WHY_NOTE_MAX_CHARS", "WHY_NOTES_MAX", "PLANNER_WHY_AUTHOR", "cutText",
    "OWNER_LABEL", "ownerLabel", "storedRequestText", "FEEDBACK_REPORT_MAX_BYTES", "isAutomaticFeedbackRound", "stoppedByLoweredAutonomy",
    "estimateDependencies", "CLOSED_TASK", "NEVER_STARTED", "CLOSING_TASK", "RUN_LIMIT_NOT_APPROVED_REFUSAL", "blockedOnRunLimit", "taskPageUrl",
    "removedReasonOf", "TASK_PAGE_DOCUMENTS", "inertTaskTitle", "taskBaseOption",
  ],
  "publication-context": [
    "E2EPublicationSubjectSchema", "E2EPublicationJoinRequestSchema", "e2ePublicationContext",
  ],
  "task-people": [
    "taskPeopleEffectsDependencies", "getTaskPeople", "getTaskPeopleCapabilities", "getTaskPeopleForPage", "getTaskPeopleProposal",
    "getTaskPeopleProposalMetadata", "confirmTaskPeopleProposal", "proposeTaskPeopleRoleForPage", "proposeTaskOwnershipForPage",
    "getTaskPersonPresentationName", "submitSlackTaskPeopleRole", "submitSlackTaskOwnership", "codeOwnershipConfirmation",
  ],
  "access": [
    "refuse", "loadOwnedTask", "AuthorizedTask", "isSessionActor", "sessionActorAccess", "authorizeTaskAction", "authorizeTaskActor",
    "authorizeLegacyTaskAction", "systemTaskAccess", "accessFence", "systemTaskDispatchAccessFence",
  ],
  "access-resume": [
    "resumeParkedTaskDispatch", "WorkflowAccessRetryAudit", "resumeAccessPausedWorkflowDispatch",
  ],
  "feedback-review": [
    "FEEDBACK_REVIEW_RETRY_FROM_SLACK", "FEEDBACK_BUNDLE_MAX_BYTES", "FEEDBACK_BUNDLE_TOTAL_MAX_BYTES", "getWorkflowFeedbackReview",
    "verifiedFeedbackReview", "FEEDBACK_CHANGED_SINCE_CARD", "refuseIfFeedbackRecollected", "submitWorkflowFeedbackDecision", "feedbackFixPrompt",
    "feedbackCiBlock", "PROMPT_COMMENT_CHARS_MAX", "promptCommentBody", "AUTOMATIC_FEEDBACK_COMMENT_BYTES_MAX", "AutomaticFeedbackRound",
    "planAutomaticFeedbackRound", "approvedFix", "taskRepositoryPaths", "FEEDBACK_CODER_NOTE_MAX", "ownerNoteForCoder", "readFeedbackReviewNoticeAt",
    "emitFeedbackDecisionMeasures",
  ],
  "task-view": [
    "DIFF_READ_BYTES", "ARTIFACT_NAME_MAX", "DIFF_ARTIFACT", "TaskDetails", "ownArtifactKey", "changedFiles", "CANDIDATE_DIFF_OPERATIONS",
    "candidateChangedFiles", "taskDetails", "unpublishedOf", "WorkspaceReads", "workspaceReads", "statusOfRun", "taskProofTable", "taskView",
    "openTasksText", "monthSlots", "pauseViewOf", "runLimitViewOf",
  ],
  "start": [
    "limitError", "chargeFailure", "ProjectAccess", "shareFor", "ADMISSION_REFUSALS", "startingLimitUsd", "admissionPath", "NOT_A_MEMBER",
    "PRIVACY_UNKNOWN", "PRIVACY_NOT_SET_UP", "confirmMayShareInto", "surfaceIsBound", "startAlreadyMade", "startTask",
  ],
  "task-index": [
    "runResultOf", "ownerIndexRowOf", "syncIndex",
  ],
  "task-reads": [
    "whole", "readTask", "getTaskPlan", "TASK_INDEX_SK", "CURSOR_MAX", "LIST_SCAN_MAX", "encodeCursor", "decodeCursor", "listTasks", "taskEvents",
  ],
  "task-window": [
    "actionableWorkspace", "requireTaskRepositoriesConnected", "busyOrClosing", "channelDriver", "extraItemsCancelled", "busy", "capWindowBaseline",
    "staleBudgetPause", "requireMayGoOn", "AGENT_RUN_TURN_REFUSAL", "capWindowUpdate", "AUTOMATIC_KEEPS_WINDOW", "refuseAutomaticWhilePaused",
    "windowAndPauseUpdate", "RESUMED_WITH_ORIGINAL_INSTRUCTIONS", "noteResumedWithOriginal",
  ],
  "continue": [
    "continueTask", "resumeRequestId", "dispatchHeldStart", "SpendResumeInput", "resumeTaskAfterSpendApproval", "ContinueAsTaskSchema",
    "continueAsTask",
  ],
  "decide": [
    "decidableTask", "decideTaskWorkflow", "RunLimitOutcome", "settleRunLimit",
  ],
  "workflow-retry": [
    "startTaskWorkflowPlanRevisionFromSystem", "retryTaskWorkflow", "retryWorkflowUnderstand", "withoutWorkflowBlockReason",
    "isMissingCommittedSourceRecovery", "loadCommittedSourceRecovery",
  ],
  "workflow-inputs": [
    "retiredClaimIdList", "planUnreadablePrompt", "previousMarkdownBlock", "structuredWorkflowPrompt", "keptProposedIds", "approvedCodingPlan",
    "OWNER_PLAN_INSTRUCTIONS_MAX", "ownerConstraintsSection", "approvedWorkflowDependencies", "partsDecisionOf", "partsSettingOf",
    "workflowWithCurrentGraphOperation", "publicWorkflowDecision", "selectedCheckCommands", "NO_PUBLISH_NOTE",
  ],
  "workflow-coding": [
    "queueWorkflowCoding", "resumeAfterRunLimitApproval", "planCheckRetryKey", "retryPlanCritique", "ciFixRetryKey", "retryCiFix",
    "retryWorkflowImplementation", "sendTaskWorkflowBackToCoding", "resolveTaskWorkflowFindings", "startAcceptedStep", "retryTaskCanvasCloseout",
  ],
  "workflow-review": [
    "startTaskWorkflowReview", "AUTOMATIC_REVIEW_NOTE", "AUTOMATIC_REVIEW_ONLY_NOTE", "reviewCheckCommand", "workflowReviewRiskOption",
    "workflowReviewChecksOption", "workflowReviewPlanOption", "workflowReviewFeedbackOption", "queueWorkflowReview",
    "startTaskWorkflowReviewFromSystem", "startTaskWorkflowImplementationFromSystem", "laterProgramBuild", "fixStartHead",
    "startAutomaticFeedbackRound", "understandWatchdogDueAt",
  ],
  "workflow-starts": [
    "queueWorkflowUnderstand", "startTaskWorkflowUnderstandFromSystem", "startTaskWorkflowPlanFromSystem", "planCheckConversationId",
    "PLAN_CHECK_REQUEST_MAX_CHARS", "startTaskWorkflowPlanCritiqueFromSystem", "startTaskWorkflowCriticRevisionFromSystem", "AutomaticRetry",
    "automaticRetryDecision", "automaticCaller", "autoSendBackToCodingFromSystem", "autoRetryChecksFromSystem", "autoRetryReviewsFromSystem",
    "startTaskWorkflowE2EChecksFromSystem", "startTaskWorkflowE2EBaselineFromSystem", "startTaskWorkflowE2EGroundingFromSystem",
    "startTaskWorkflowE2EReplayFromSystem",
  ],
  "task-page": [
    "mergeViewForWords", "taskPageStage", "publicationAttempts", "HISTORY_REASON_MAX_CHARS", "taskPageStep", "decisionExtras", "cutReason",
    "getTaskPageState", "pageActor", "commentViewContext", "listPageComments", "ReplyLookup", "replyLookupCache", "REPLY_LOOKUP_CACHE_MAX",
    "replyLookups", "PageSuggestionListing", "currentSuggestions", "createPageComment", "editPageComment", "deletePageComment", "setPageSuggestion",
    "PAGE_BREAKDOWN_REFUSALS", "pageBreakdownRefusal", "decideOnPage", "retryApplicationRoundOnPage", "getTaskFreshness", "coherentPageAccess",
    "getTaskDocumentView", "planClaimIds", "claimsCitingComments", "DOCUMENT_TYPES", "legacyQuoteCommentRefs", "commentAnswersAvailable",
    "pageDecidingView",
  ],
  "pull-request-body": [
    "WORKFLOW_PULL_REQUEST_BODY_MAX_BYTES", "WORKFLOW_PLAN_SUMMARY_LINE_MAX", "WORKFLOW_PULL_REQUEST_ACCEPTED_LISTED", "workflowPullRequestBody",
    "workflowPullRequestStatusLines", "workflowReviewLines", "proofContextOfTask", "approvedPlanForPullRequest", "WorkflowPublicationAuthority",
  ],
  "publication": [
    "LoadedPublicationProject", "workflowPublicationMaterialDigest", "workflowPublicationAuthority", "currentWorkflowPublicationAuthorityForTask",
    "currentWorkflowPublicationModeForTask", "startTaskWorkflowPublicationFromSystem", "startTaskWorkflowPullRequestUpdate",
    "startTaskWorkflowBranchSyncFromSystem", "retryTaskWorkflowPublication", "keepTaskWorkflowPullRequests",
  ],
  "feedback-capture": [
    "startTaskWorkflowFeedbackReviewFromWebhook", "acceptFeedbackReview", "feedbackReviewWorkspaceReady", "FEEDBACK_REVIEW_RETRY_STALE",
    "FEEDBACK_REVIEW_RETRY_BUSY", "FEEDBACK_REVIEW_RETRY_CHANGED", "FEEDBACK_REVIEW_RETRY_STARTED", "retryTaskWorkflowFeedbackReview",
    "feedbackRetryRefusal", "slackEventRequestId", "captureWorkflowFeedbackNote",
  ],
  "thread-notes": [
    "planWhyEntries", "threadNoteKey", "THREAD_NOTE_SECTION_MAX_BYTES", "APP_NOTE_SECTION_HEADER", "isAppNote", "personLabel",
    "THREAD_NOTE_SECTION_HEADER", "truncateText", "noteCountUpdate", "answerIntentFromReply", "recordWorkflowThreadNote", "readWorkflowThreadNotes",
    "SessionNoteRefusal", "SessionNoteInput", "sessionNoteItems", "recordSessionNote", "markWorkflowThreadNoteAnswered", "SEND_BACK_PROBLEMS_HEADER",
    "promptTagId", "sendBackProblemsPromptSection", "threadNotesPromptSection", "ThreadNotesForStep", "threadNotesSuffix", "fedThroughUpdate",
    "agentStepNotes", "withCurrentThreadNotes",
  ],
  "task-answer-context": [
    "TASK_ANSWER_DOCUMENT_MAX_BYTES", "TASK_ANSWER_TITLE_MAX_CHARS", "TASK_ANSWER_PULL_REQUESTS_MAX", "TASK_ANSWER_SHORTENED_NOTE",
    "workflowTaskAnswerContext", "COMMENT_ANSWER_THREAD_ITEMS", "COMMENT_ANSWER_THREAD_MAX_BYTES", "COMMENT_ANSWER_ITEM_MAX_CHARS",
    "commentAnswerSection",
  ],
  "cancel": [
    "TaskActor", "actingDeps", "cancelTaskFor", "SESSION_RETRY_INSTRUCTIONS", "retryTaskWorkflowFor", "CANCEL_PAYLOAD_HASH", "cancelTask",
    "stopPlanReviewItem",
  ],
  "close": [
    "openPullRequest", "CLOSE_ATTEMPTS", "finishTaskClose", "endAgentRunOfClosedTask", "workflowTaskFinished", "workflowEndOutcome", "EndTold",
    "noteTaskEnded", "noteTaskPaused", "tellClosedTaskEnd", "resumeClose", "safeClose", "CLOSE_CHECKING", "CLOSE_REFUSED", "CLOSE_COMPUTE_PENDING",
    "CLOSE_DISCARD_PENDING", "CLOSE_CHECK_FAILED", "CLOSE_STILL_OPEN", "COMPUTE_STOPPING", "CLOSE_FAILED", "notClosedMessage", "closeNeverStarted",
    "GROUNDING_STOP_WAIT_MS", "GROUNDING_STOP_POLL_MS", "closeTask",
  ],
  "release": [
    "RELEASABLE_WORKSPACE", "FinishedTaskRelease", "ReleaseDeps", "recordFinishedRunCost", "releaseTurnId", "releaseFinishedTask", "SELF_HEAL_MAX",
    "releaseFinishedTasksOf", "FINISHED_RELEASE_PK", "finishedReleaseKey", "RELEASE_SWEEP_MAX", "RELEASE_SWEEP_SCAN", "RELEASE_RETRY_FIRST_MS",
    "RELEASE_RETRY_MAX_MS", "FinishedReleaseMark", "finishedReleaseMarkItem", "enqueueFinishedTaskRelease", "releaseFinishedTaskQuietly",
    "releasePendingFinishedTasks",
  ],
  "share": [
    "safeDecode", "SHARE_ATTEMPTS", "shareLabel", "nextShare", "withMode", "ShareAdmin", "ShareModeDependencies", "shareItems", "authorizeShare",
    "shareIdempotencyKey", "REUSED_REQUEST", "shareTask", "adminShareMode",
  ],
};

const ROUTES_MODULES: SplitConfig["modules"] = {
  "types": [
    "CLOSE_STOP_BUDGET_MS", "DeveloperApiConfiguration", "DeveloperRouteDependencies", "ProjectAccessCaller", "DeveloperCaller",
    "ChannelMembersInvokeResult",
  ],
  "common": [
    "PROJECT_NOT_FOUND_IN_APP", "signInStoreOf", "bodyError",
  ],
  "identity-lambda": [
    "errorName", "SLACK_UNAVAILABLE", "SLACK_ERROR_CODE", "IdentityRefusal", "identityInvoke", "channelMembersThroughLambda",
    "taskPersonProofThroughLambda", "taskChannelPeopleThroughLambda", "taskPeopleDisplayReadThroughLambda", "ChannelEntry", "isChannelEntry",
    "channelInfoThroughLambda", "slackUserByEmailThroughLambda", "slackAuthCheckThroughLambda", "endDeveloperSessionsThroughLambda",
    "realtimeTokenThroughLambda", "refusalMessageOf", "unlinkIdentityThroughLambda", "startIdentityLinkThroughLambda", "channelByNameThroughLambda",
    "developerSinceFromEnvironment", "developerKeysThroughLambda",
  ],
  "authentication": [
    "SIGN_IN_AGAIN", "DeveloperTokenClaims", "developerClaims", "getSignIn", "authenticateDeveloper", "authenticateBearer", "authenticateSession",
    "authenticateDeveloperSessionId",
  ],
  "project-list": [
    "queryAll", "CHANNEL_NAMES_DEADLINE_MS", "REVISION_READS_AT_ONCE", "mapLimit", "latestDefinition", "projectsWithPolicy", "safeChannelMembers",
    "channelNames", "describeChannel", "grantRowsOf", "GrantRow", "bindingsOf", "nameOf", "listProjects", "StoredProject", "latestProjectRecord",
    "repositoryFullName", "appProjectSummary", "visibleProjectRoles", "listAppProjects", "setupCheckDepsOf", "projectMembersDepsOf",
    "projectMembersOf",
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
  "project-access": [
    "checkProjectAccess", "projectWorkspaces", "listWorkspaces",
  ],
  "dependencies": [
    "setupDraftDepsOf", "agentRunStarterOf", "codeIntentDependenciesOf", "gateDeveloperStart", "startAppRun", "chainRouteDependenciesFor",
    "sessionDependenciesOf", "sessionReadDependencies", "developerTaskRouteDependencies",
  ],
  "organization": [
    "createProject", "navigationAdapters", "getAppNavigation", "getAppMe", "setMyName", "unlinkAppIdentity", "startAppIdentityLink",
    "getOrganization", "createOrganizationInvite", "ChangeRoleBodySchema", "changeMemberRole", "endSessionsAfterRemoval", "emailsOf",
    "STOPS_AFTER_STEP", "removeOrganizationMember", "LeaveBodySchema", "leaveOrganization", "budgetDependencies", "getBudget",
    "putOrganizationBudget", "CHATGPT_CONNECTION_PATH", "routeChatGptConnection", "jsonBody",
  ],
};

export const CONFIGS: Record<string, SplitConfig> = {
  tasks: {
    source: "packages/broker/src/aws/developer-tasks.ts",
    outDir: "packages/broker/src/aws/developer-tasks",
    modules: TASKS_MODULES,
    // The router and the two small helpers only it uses stay: the file is the composition.
    stay: ["routeDeveloperTaskRequest", "decideTaskWorkflowFeedback", "retryTaskWorkflowFeedback"],
    fallbackModule: "common",
    preserveImportOrder: true,
  },
  routes: {
    source: "packages/broker/src/aws/developer-routes.ts",
    outDir: "packages/broker/src/aws/developer-routes",
    modules: ROUTES_MODULES,
    // The router stays: the file is the composition.
    stay: ["routeDeveloperRequest"],
    fallbackModule: "common",
    preserveImportOrder: true,
  },
};
