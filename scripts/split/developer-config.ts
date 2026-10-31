// The groups the developer files are split into, for the declarations that exist in the public repository AND in Rovara Cloud. Every declaration of the file
// must be listed here (strict): a name in no list is an error, and the dry run says where it would have gone, so the same name lands in the same file in every
// repository that carries it. Names a repository has and this file lacks go in its own overlay (developer-config.private.ts, kept out of the public repository).
// The module keys are in the order the thin file re-exports them. To split another checkout of these files run
// `node scripts/split/split-developer.ts --root <checkout> --dry-run`: it lists names the file no longer has and names this config does not know.
import type { SplitConfig } from "./split-lib.ts";

const TASKS_MODULES: SplitConfig["modules"] = {
  "types": [
    "DeveloperTaskRouteDependencies",
  ],
  "common": [
    "TASK_ID", "iso", "log", "parse", "taskWorkflowCheckPolicy", "body", "get", "putNew", "turnTable", "turnRecordFailed", "partyOf",
    "partyOfTaskActor", "redactedTitle", "REQUEST_TEXT_MAX_CHARS", "WHY_NOTE_MAX_CHARS", "WHY_NOTES_MAX", "PLANNER_WHY_AUTHOR", "cutText",
    "OWNER_LABEL", "ownerLabel", "storedRequestText", "FEEDBACK_REPORT_MAX_BYTES", "CLOSED_TASK", "NEVER_STARTED", "CLOSING_TASK", "taskPageUrl",
    "TASK_PAGE_DOCUMENTS", "inertTaskTitle", "taskBaseOption", "inertPlanLine",
  ],
  "publication-context": [
    "E2EPublicationSubjectSchema", "E2EPublicationJoinRequestSchema", "e2ePublicationContext",
  ],
  "task-people": [
    "taskPeopleEffectsDependencies", "getTaskPeople", "getTaskPeopleCapabilities", "getTaskPeopleProposal", "getTaskPeopleProposalMetadata",
    "confirmTaskPeopleProposal", "proposeTaskPeopleRoleForPage", "proposeTaskOwnershipForPage", "getTaskPersonPresentationName",
    "submitSlackTaskPeopleRole", "submitSlackTaskOwnership",
  ],
  "access": [
    "refuse", "loadOwnedTask", "AuthorizedTask", "authorizeTaskAction", "authorizeTaskActor", "authorizeLegacyTaskAction", "systemTaskAccess",
    "accessFence", "systemTaskDispatchAccessFence",
  ],
  "access-resume": [
    "resumeParkedTaskDispatch", "WorkflowAccessRetryAudit", "resumeAccessPausedWorkflowDispatch",
  ],
  "feedback-review": [
    "FEEDBACK_REVIEW_RETRY_FROM_SLACK", "FEEDBACK_BUNDLE_MAX_BYTES", "FEEDBACK_BUNDLE_TOTAL_MAX_BYTES", "getWorkflowFeedbackReview",
    "FEEDBACK_CHANGED_SINCE_CARD", "refuseIfFeedbackRecollected", "submitWorkflowFeedbackDecision", "approvedFix", "taskRepositoryPaths",
    "FEEDBACK_CODER_NOTE_MAX", "ownerNoteForCoder", "readFeedbackReviewNoticeAt", "emitFeedbackDecisionMeasures",
  ],
  "task-view": [
    "DIFF_READ_BYTES", "ARTIFACT_NAME_MAX", "DIFF_ARTIFACT", "TaskDetails", "ownArtifactKey", "changedFiles", "taskDetails", "unpublishedOf",
    "WorkspaceReads", "workspaceReads", "taskView", "openTasksText",
  ],
  "start": [
    "limitError", "chargeFailure", "ProjectAccess", "shareFor", "NOT_A_MEMBER", "PRIVACY_UNKNOWN", "PRIVACY_NOT_SET_UP", "confirmMayShareInto",
    "startTask",
  ],
  "task-index": [
    "syncIndex",
  ],
  "task-reads": [
    "whole", "readTask", "getTaskPlan", "TASK_INDEX_SK", "CURSOR_MAX", "LIST_SCAN_MAX", "encodeCursor", "decodeCursor", "listTasks", "taskEvents",
  ],
  "task-window": [
    "actionableWorkspace", "busyOrClosing", "channelDriver", "extraItemsCancelled", "busy",
  ],
  "continue": [
    "continueTask",
  ],
  "decide": [
    "decidableTask", "decideTaskWorkflow",
  ],
  "workflow-retry": [
    "startTaskWorkflowPlanRevisionFromSystem", "retryTaskWorkflow", "withoutWorkflowBlockReason", "isMissingCommittedSourceRecovery",
    "loadCommittedSourceRecovery",
  ],
  "workflow-inputs": [
    "retiredClaimIdList", "planUnreadablePrompt", "previousMarkdownBlock", "structuredWorkflowPrompt", "keptProposedIds", "approvedCodingPlan",
    "OWNER_PLAN_INSTRUCTIONS_MAX", "ownerConstraintsSection", "approvedWorkflowDependencies", "workflowWithCurrentGraphOperation",
    "publicWorkflowDecision", "selectedCheckCommands", "NO_PUBLISH_NOTE",
  ],
  "workflow-coding": [
    "queueWorkflowCoding", "retryWorkflowImplementation", "sendTaskWorkflowBackToCoding", "resolveTaskWorkflowFindings", "retryTaskCanvasCloseout",
    "startAcceptedPublication",
  ],
  "workflow-review": [
    "startTaskWorkflowReview", "AUTOMATIC_REVIEW_NOTE", "AUTOMATIC_REVIEW_ONLY_NOTE", "reviewCheckCommand", "workflowReviewChecksOption",
    "workflowReviewPlanOption", "workflowReviewFeedbackOption", "queueWorkflowReview", "startTaskWorkflowReviewFromSystem",
  ],
  "workflow-starts": [
    "AutomaticRetry", "automaticRetryDecision", "automaticCaller", "autoSendBackToCodingFromSystem", "autoRetryChecksFromSystem",
    "autoRetryReviewsFromSystem", "startTaskWorkflowE2EChecksFromSystem", "startTaskWorkflowE2EBaselineFromSystem",
    "startTaskWorkflowE2EGroundingFromSystem", "startTaskWorkflowE2EReplayFromSystem",
  ],
  "task-page": [
    "taskPageStage", "publicationAttempts", "HISTORY_REASON_MAX_CHARS", "taskPageStep", "decisionExtras", "cutReason", "getTaskPageState",
    "pageActor", "commentViewContext", "listPageComments", "ReplyLookup", "replyLookupCache", "REPLY_LOOKUP_CACHE_MAX", "replyLookups",
    "PageSuggestionListing", "currentSuggestions", "createPageComment", "editPageComment", "deletePageComment", "setPageSuggestion", "decideOnPage",
    "retryApplicationRoundOnPage", "getTaskFreshness", "coherentPageAccess", "getTaskDocumentView", "planClaimIds", "claimsCitingComments",
    "DOCUMENT_TYPES", "legacyQuoteCommentRefs", "commentAnswersAvailable", "pageDecidingView",
  ],
  "pull-request-body": [
    "WORKFLOW_PULL_REQUEST_BODY_MAX_BYTES", "WORKFLOW_PLAN_SUMMARY_LINE_MAX", "WORKFLOW_PULL_REQUEST_ACCEPTED_LISTED", "workflowPullRequestBody",
    "workflowPullRequestStatusLines", "approvedPlanForPullRequest", "WorkflowPublicationAuthority",
  ],
  "publication": [
    "LoadedPublicationProject", "workflowPublicationMaterialDigest", "workflowPublicationAuthority", "currentWorkflowPublicationAuthorityForTask",
    "currentWorkflowPublicationModeForTask", "startTaskWorkflowPublicationFromSystem", "startTaskWorkflowPullRequestUpdate",
    "retryTaskWorkflowPublication", "keepTaskWorkflowPullRequests",
  ],
  "feedback-capture": [
    "startTaskWorkflowFeedbackReviewFromWebhook", "acceptFeedbackReview", "feedbackReviewWorkspaceReady", "FEEDBACK_REVIEW_RETRY_STALE",
    "FEEDBACK_REVIEW_RETRY_BUSY", "FEEDBACK_REVIEW_RETRY_CHANGED", "FEEDBACK_REVIEW_RETRY_STARTED", "retryTaskWorkflowFeedbackReview",
    "feedbackRetryRefusal", "slackEventRequestId", "captureWorkflowFeedbackNote",
  ],
  "thread-notes": [
    "planWhyEntries", "threadNoteKey", "THREAD_NOTE_SECTION_MAX_BYTES", "THREAD_NOTE_SECTION_HEADER", "truncateText", "recordWorkflowThreadNote",
    "readWorkflowThreadNotes", "markWorkflowThreadNoteAnswered", "SEND_BACK_PROBLEMS_HEADER", "promptTagId", "sendBackProblemsPromptSection",
    "threadNotesPromptSection", "ThreadNotesForStep", "threadNotesSuffix", "fedThroughUpdate", "withCurrentThreadNotes",
  ],
  "task-answer-context": [
    "TASK_ANSWER_DOCUMENT_MAX_BYTES", "TASK_ANSWER_TITLE_MAX_CHARS", "TASK_ANSWER_PULL_REQUESTS_MAX", "TASK_ANSWER_SHORTENED_NOTE",
    "workflowTaskAnswerContext", "COMMENT_ANSWER_THREAD_ITEMS", "COMMENT_ANSWER_THREAD_MAX_BYTES", "COMMENT_ANSWER_ITEM_MAX_CHARS",
    "commentAnswerSection",
  ],
  "cancel": [
    "CANCEL_PAYLOAD_HASH", "cancelTask",
  ],
  "close": [
    "openPullRequest", "CLOSE_ATTEMPTS", "finishTaskClose", "workflowTaskFinished", "resumeClose", "safeClose", "CLOSE_CHECKING", "CLOSE_REFUSED",
    "CLOSE_COMPUTE_PENDING", "CLOSE_DISCARD_PENDING", "CLOSE_CHECK_FAILED", "CLOSE_STILL_OPEN", "COMPUTE_STOPPING", "CLOSE_FAILED",
    "notClosedMessage", "closeNeverStarted", "GROUNDING_STOP_WAIT_MS", "GROUNDING_STOP_POLL_MS", "closeTask",
  ],
  "release": [
    "RELEASABLE_WORKSPACE", "FinishedTaskRelease", "ReleaseDeps", "releaseTurnId", "releaseFinishedTask", "SELF_HEAL_MAX", "releaseFinishedTasksOf",
    "FINISHED_RELEASE_PK", "finishedReleaseKey", "RELEASE_SWEEP_MAX", "RELEASE_SWEEP_SCAN", "RELEASE_RETRY_FIRST_MS", "RELEASE_RETRY_MAX_MS",
    "FinishedReleaseMark", "enqueueFinishedTaskRelease", "releaseFinishedTaskQuietly", "releasePendingFinishedTasks",
  ],
  "share": [
    "safeDecode", "SHARE_ATTEMPTS", "shareLabel", "nextShare", "withMode", "ShareAdmin", "ShareModeDependencies", "shareItems",
    "shareIdempotencyKey", "REUSED_REQUEST", "shareTask", "adminShareMode",
  ],
};

const ROUTES_MODULES: SplitConfig["modules"] = {
  "types": [
    "DeveloperApiConfiguration", "DeveloperRouteDependencies", "DeveloperCaller", "ChannelMembersInvokeResult",
  ],
  "identity-lambda": [
    "errorName", "SLACK_UNAVAILABLE", "SLACK_ERROR_CODE", "IdentityRefusal", "identityInvoke", "channelMembersThroughLambda",
    "taskPersonProofThroughLambda", "taskChannelPeopleThroughLambda", "taskPeopleDisplayReadThroughLambda", "ChannelEntry", "isChannelEntry",
    "channelInfoThroughLambda", "slackUserByEmailThroughLambda", "slackAuthCheckThroughLambda", "endDeveloperSessionsThroughLambda",
    "channelByNameThroughLambda", "developerSinceFromEnvironment", "developerKeysThroughLambda",
  ],
  "authentication": [
    "SIGN_IN_AGAIN", "developerClaims", "getSignIn", "authenticateDeveloper", "authenticateSession", "authenticateDeveloperSessionId",
  ],
  "project-list": [
    "queryAll", "CHANNEL_NAMES_DEADLINE_MS", "REVISION_READS_AT_ONCE", "mapLimit", "latestDefinition", "projectsWithPolicy", "safeChannelMembers",
    "channelNames", "describeChannel", "bindingsOf", "listProjects",
  ],
  "project-access": [
    "checkProjectAccess", "projectWorkspaces", "listWorkspaces",
  ],
  "dependencies": [
    "developerTaskRouteDependencies",
  ],
  "organization": [
    "CHATGPT_CONNECTION_PATH", "routeChatGptConnection", "jsonBody",
  ],
  "common": [
    "logDeveloperEvent", "grantsOf",
  ],
};

export const CONFIGS: Record<string, SplitConfig> = {
  tasks: {
    source: "packages/broker/src/aws/developer-tasks.ts",
    outDir: "packages/broker/src/aws/developer-tasks",
    modules: TASKS_MODULES,
    // The router (and what only it uses) stays: the file is the composition.
    stay: ["routeDeveloperTaskRequest", "decideTaskWorkflowFeedback", "retryTaskWorkflowFeedback"],
    fallbackModule: "common",
    preserveImportOrder: true,
    strict: true,
  },
  routes: {
    source: "packages/broker/src/aws/developer-routes.ts",
    outDir: "packages/broker/src/aws/developer-routes",
    modules: ROUTES_MODULES,
    // The router (and what only it uses) stays: the file is the composition.
    stay: ["routeDeveloperRequest"],
    fallbackModule: "common",
    preserveImportOrder: true,
    strict: true,
  },
};
