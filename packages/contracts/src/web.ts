import "./web-init.js";
export { configureZodForCsp } from "./web-init.js";
export { forwardReader, type ForwardReader, SessionViewSchema, type SessionView, SessionViewReaderSchema, SessionResponseSchema, SessionResponseReaderSchema, CLOSE_MESSAGES, SessionCloseResponseSchema, SessionCloseResponseReaderSchema, SessionStepTaskResponseSchema, SessionStepTaskResponseReaderSchema, SessionShareSchema, type SessionShare, SessionShareReaderSchema, SessionSharesResponseSchema, SessionSharesResponseReaderSchema, SessionSharePutResponseSchema, SessionSharePutResponseReaderSchema, SessionShareDeleteResponseSchema, SessionShareDeleteResponseReaderSchema, SessionTileSchema, type SessionTile, SessionTileReaderSchema, SessionListSchema, type SessionList, SessionListReaderSchema, SessionEventReaderSchema, SessionEventPageSchema, type SessionEventPage, SessionEventPageReaderSchema, ProjectOverviewSchema, type ProjectOverview, ProjectOverviewReaderSchema, NeedsConfirmationSchema, type NeedsConfirmation } from "./session-views.js";
export { SESSION_MESSAGE_MAX_CHARS, PRESENCE_HEARTBEAT_SECONDS, SessionIdSchema, STATUS_WORDS, LEVEL_WORDS, SessionMessageSchema } from "./agent-sessions.js";
export { projectAllows, isAllowedDomain, firstRefusedDomainIndex, ProjectRoleSchema, type ProjectRole, type ProjectPermission, PROJECT_PERMISSIONS, ProjectStatusSchema, type ProjectStatus, ProjectSetupStatusSchema, type ProjectSetupStatus, AppProjectSummarySchema, type AppProjectSummary, AppProjectDomainStatusSchema, AppProjectDetailSchema, type AppProjectDetail, ProjectArchiveResponseSchema, type ProjectArchiveResponse, ProjectSetupCheckBodySchema, type ProjectSetupCheckBody, ProjectSetupCheckResponseSchema, type ProjectSetupCheckResponse, ProjectMemberSourceSchema, type ProjectMemberSource, ProjectMemberSchema, type ProjectMember, ProjectMembersResponseSchema, type ProjectMembersResponse, PutProjectMemberBodySchema, type PutProjectMemberBody, ProjectMemberChangeResponseSchema, type ProjectMemberChangeResponse, RemoveProjectMemberBodySchema, ProjectMemberRemoveResponseSchema, type ProjectMemberRemoveResponse, AppProjectsResponseSchema, type AppProjectsResponse, ALLOWED_DOMAIN_MESSAGE, StoredAllowedDomainSchema, AllowedDomainSchema, ProjectSettingsBodySchema, type ProjectSettingsBody, ProjectSettingsResponseSchema, type ProjectSettingsResponse, SettingsProofSchema, type SettingsProof, SettingsHeldSchema, type SettingsHeld, ProjectSettingsUndoBodySchema, type ProjectSettingsUndoBody } from "./app-projects.js";
export { ModelListSchema, principalKey, isBuiltinAgentId, atLeast, AGENT_NAME_MAX, AGENT_DESCRIPTION_MAX, BUILTIN_AGENT_IDS, ROVARA_CODE_AGENT_ID, AgentIdSchema, SkillIdSchema, AgentOwnerSchema, AgentPrincipalSchema, AGENT_ACCESS_LEVELS, AgentAccessLevelSchema, AutonomySchema, BaseRefSchema } from "./agent.js";
export { ThinkingLevelSchema } from "./models.js";
export { StepThinkingLevelSchema, MAX_RECIPE_STEPS, CODING_STEP_KINDS, AGENT_STEP_KINDS, STEP_TOOLS, ToolGrantSchema, StepSettingsSchema, StepSpecSchema, RecipeOverlaySchema, ResolvedRecipeSchema } from "./agent-recipe.js";
export { errorStatus, agentXError, AgentXErrorCodeSchema, type AgentXErrorCode, LAST_OWNER_MESSAGE, projectNameTakenMessage, projectArchivedMessage, INVITE_WRONG_EMAIL_MESSAGE, GITHUB_INSTALLATION_TAKEN_MESSAGE, AgentXError, githubNotConnectedMessage } from "./errors.js";
export { scopeKey, pauseKey, spendOriginKind, suggestedTopUpUsd, suggestedMonthTopUpUsd, RUN_LIMIT_MULTIPLIER, LEAD_APPROVAL_THRESHOLD_USD, ADMIN_APPROVAL_THRESHOLD_USD, BUDGET_WARNING_RATIO, MAX_RUN_LIMIT_USD, type RunEstimateRange, DEFAULT_RUN_ESTIMATE_USD, RunEstimateSchema, type RunEstimate, RUN_LIMIT_BLOCK_PREFIX, RUN_LIMIT_WAITING_PREFIXES, runLimitWaitingText, isRunLimitBlockReason, runLimitBlockText, planRunLimitSubject, heldPlanStartKey, runLimitAskedKey, RUN_LIMIT_ASK_COOLDOWN_MS, DEFAULT_PLANNING_LIMIT_USD, TESTING_ALLOWANCE_USD, PER_TEST_CAP_USD, DEFAULT_MAX_AGENT_MONTHLY_USD, DEFAULT_MAX_PER_RUN_CEILING_USD, DEFAULT_OWNER_AGENT_BUDGET_CAP_USD, ESTIMATE_HISTORY_SIZE, ESTIMATE_MIN_SAMPLES, SPEND_REQUEST_TTL_DAYS, WRITE_APPROVAL_TTL_DAYS, CHANGE_APPROVAL_TTL_DAYS, OWNER_ANSWER_HOURS, MAX_PENDING_APPROVALS_PER_STEP, DEFAULT_MAX_AUTONOMY, APPROVAL_EXECUTING_RETRY_MINUTES, type BudgetScope, type PauseScope, FINALIZE_DELAY_MS, KEY_EXPIRY_GRACE_MS, FINALIZED_SETTLE_WINDOW_MS, BUDGET_ALERT_LEVELS, sourceCounter, modelCounter, personalCounter, type SpendOriginKind, SPEND_ORIGIN_KINDS, originCounter, PLANNING_LIMIT_MIN_USD, PLANNING_LIMIT_MAX_USD, MAX_SPEND_SETTING_USD, ProjectAiSettingsSchema, DEFAULT_MEMBER_ACCEPT_RUN_LIMIT_USD, type ProjectAiSettings, defaultProjectAiSettings, SpendPolicyFieldsSchema, SpendPolicySchema, type SpendPolicy, memberAcceptRunLimitUsd, defaultSpendPolicy, TRIAL_LIMITS_R49, SPEND_REQUEST_KINDS, type SpendRequestKind, SPEND_REQUEST_STATUSES, type SpendRequestStatus, SPEND_APPROVER_ROLES, type SpendApproverRole, SPEND_REQUEST_REASON_MAX, SPEND_RESUME_INSTRUCTIONS, type OwnerCapChange, type SpendRequestRecord } from "./spend.js";

// PLAN6: export its reader schemas when the owning plan lands; Part A does not invent their shapes. The plan card reads the time estimate and the plan check's words (staging 0.4.10).
export { formatMinutes, CRITIC_NOT_CHECKED_LINE, MergeDoneReaderSchema, INTENT_ANSWER_MAX_CHARS, ANSWER_EVERY_QUESTION_MESSAGE, answerSourceLine, plainAnswerText, ANSWER_SOURCES_MAX } from "./rovara-code.js";
// A coding run that needed no code change: the task page shows what the agent found (the words, and the stop they belong to).
export { NO_CHANGE_FOUND_HEADER, NO_CHANGE_NEEDED_LINE, NO_CHANGE_NO_CONCLUSION_LEAD, NO_CHANGE_COMMANDS_HEADER, NO_CHANGE_CHOICES_PAGE, NO_CHANGE_CHOICES_NO_THREAD, noChangeHasThread, isNoCodeChangedReason } from "./no-change-findings.js";

export { DeveloperSignInMethodSchema, AppMeResponseSchema, AppMeResponseReaderSchema, type AppMeResponse, LinkedIdentitySchema } from "./developer-web.js";
export { OrgRoleSchema, type OrgRole } from "./org.js";
export { RealtimeNoticeSchema, RealtimeTokenResponseSchema, parseRealtimeChannel, sessionChannel, type RealtimeNotice, type RealtimeTokenResponse } from "./realtime.js";
export { RealtimeNoticeReaderSchema, RealtimeTokenResponseReaderSchema, ChangesFeedPageReaderSchema, type ReadRealtimeNotice, type ReadFeedNotice } from "./realtime-readers.js";
export { PendingConfirmationReaderSchema, PendingAdminApprovalReaderSchema, ApiErrorResponseReaderSchema } from "./pending-api.js";

export type { OrgId } from "./org.js";

export * from "./app-nav.js";
export * from "./app-billing.js";
export * from "./script-tokens.js";

export { TICKET_PATTERN } from "./confirmation.js";
export { AppOrgMembersResponseSchema, AppOrgMembersResponseReaderSchema, OrgMemberLookupBodySchema, OrgMemberLookupResponseSchema, OrgMemberLookupResponseReaderSchema, SetMyNameBodySchema, type SetMyNameBody, SetMyNameResponseSchema, type SetMyNameResponse, SetMyNameResponseReaderSchema } from "./developer-web.js";
export { SessionMessageReaderSchema, SessionMessagePageReaderSchema, SessionFollowResponseReaderSchema, SessionPresenceResponseReaderSchema } from "./session-views.js";
export { SessionMessageIdSchema, SessionAnchorInputSchema, type SessionAnchorInput, type SessionAnchorRef } from "./agent-sessions.js";
export { DeveloperTaskViewSchema } from "./developer-tasks.js";

export { TaskResponseSchema, TaskResponseReaderSchema } from "./task-response.js";

export { DeveloperTaskViewReaderSchema } from "./session-views.js";
export { SessionAnchorRefSchema } from "./agent-sessions.js";
export { DIFF_FILES_PAGE_MAX, DIFF_PATCH_MAX_BYTES, SessionDiffSchema, SessionDiffReaderSchema, type SessionDiff } from "./session-views.js";

export { HomeCardSchema, type HomeCard, HomeCardReaderSchema, HomeResponseSchema, type HomeResponse, HomeResponseReaderSchema, HomeButtonSchema, HomeCardIdSchema, HomeDismissResponseSchema, HomeDismissResponseReaderSchema, HOME_NOT_DISMISSIBLE } from "./home.js";
export { LiveFilterSchema, LiveTileSchema, LiveTileReaderSchema, LiveResponseSchema, LiveResponseReaderSchema, SessionWhereViewSchema, ProjectOverviewProjectSchema, ProjectOverviewYouSchema, ProjectOverviewAgentSchema, ProjectOverviewBudgetSchema, ProjectOverviewLearningSchema, type ProjectOverviewLearning } from "./session-views.js";
export { LIVE_FILTERS, LIVE_VIEWING_MAX, SESSION_STATUS_WORDS } from "./agent-sessions.js";

export * from "./agent-web-views.js";

export { SessionMakeAgentBodySchema, AgentOriginViewSchema } from "./agent-sessions.js";

export * from "./onboarding.js";

export { ChainRunViewReaderSchema } from "./chain-session.js";

export { OrgMemberRoleChangeBodySchema, OrgMemberRoleChangeResponseSchema, OrgMemberRoleChangeResponseReaderSchema } from "./developer-web.js";

export { MemberRemovalBodySchema, MemberRemovalPreviewSchema, MemberRemovalPreviewReaderSchema, MemberRemovalStartedSchema, MemberRemovalStartedReaderSchema, MemberRemovalStatusSchema, MemberRemovalStatusReaderSchema } from "./member-removal-web.js";

export { AppOrgInvitesResponseSchema, AppOrgInvitesResponseReaderSchema } from "./developer-web.js";

// Lane A: canonical invite review/recovery, isolated from other admin lanes.
export { OrgInvitePublicIdSchema, AppOrgInviteStatusSchema } from "./developer-web.js";
export { OrgIdSchema } from "./org.js";

// Lane A: safe reviewed invite creation receipts.
export { ReviewedInviteCreateBodySchema, InviteCreateReceiptSchema, ReviewedInviteCreateResponseSchema, InviteEmailOutcomeSchema } from "./invite-creation.js";

// Lane A: strict read-only monthly base budget settings.
export { AdminBudgetMicrodollarsSchema, AdminMonthlyBaseLimitSchema, AdminBudgetSettingsSchema, type AdminBudgetSettings } from "./admin-budget.js";

// Lane A G1: pure finite stop calculation and exact display; no runtime admission.
export { calculateTaskStop, TaskStopAdmissionInputSchema, type TaskStopAdmissionInput, TaskStopCalculationInputSchema, TaskStopMicrousdSchema, type TaskStopCalculation, type TaskStopBindingScope } from "./task-stop.js";
export { formatUsdMicrodollars } from "./money-format.js";

// Lane A G1: current company ceiling read alias; other policy scopes are not loaded.
export { TaskStopCeilingReadSchema, type TaskStopCeilingRead } from "./task-stop-ceiling.js";

// Lane A G1: configured company default composed with the one existing ceiling.
export { TaskStopCompanyPolicySchema, TaskStopCompanyReadSchema, type TaskStopCompanyRead } from "./task-stop-company.js";

// Lane A G1: exact default micros and the narrow existing-agent limit read.
export { DEFAULT_MAX_PER_RUN_CEILING_MICROUSD } from "./spend.js";
export { TaskStopAgentReadSchema, type TaskStopAgentRead } from "./task-stop-agent.js";

// Lane A G1: versioned project intent, preserved but not set by legacy settings writes.
export { TaskStopProjectPolicySchema, type TaskStopProjectPolicy, TaskStopProjectReadSchema, type TaskStopProjectRead } from "./task-stop-project.js";

// Lane B reviewed project archive boundary.
export * from "./reviewed-project-archive.js";

// Lane B reviewed restore boundary.
export * from "./reviewed-project-restore.js";

// Lane B: browser-safe project-scoped working-branch page data.
export * from "./app-working-branches.js";
export { isPlaceholderDisplayName, isReservedDisplayName } from "./display-name.js";

// "How we work": the project playbook and its effective view (the How we work tab).
export * from "./project-playbook.js";
export * from "./design-review.js";
export * from "./design-review-state.js";
export { CODE_CITATION_UNCHECKED, codeCitationInPacket, codeCitationLinkPath, type CitablePacketItem } from "./design-review-citation-links.js";
export * from "./design-review-words.js";
export * from "./how-we-work.js";
export * from "./how-we-work-track-record.js";

// v1.2 learning loop: the schemas of a project's learning (stored shapes and the API the screens use).
export * from "./project-learning.js";

// Lane C17: bounded company Slack stored-evidence read, browser-safe metadata only.
export * from "./org-slack-workspace-evidence.js";
export { DATADOG_SITES, AWS_REGIONS, CLOUDWATCH_MAX_REGIONS } from "./connection-options.js";

export { AUDIT_INDEX_PAGE_DEFAULT, AUDIT_INDEX_PAGE_MAX, AuditIndexedQuerySchema, AuditIndexedResultSchema, type AuditIndexedQuery, type AuditIndexedResult } from "./audit-search.js";

export * from "./stage-models.js";

export { SoleOwnerConfirmationSchema } from "./session-views.js";
export * from "./app-allowed-websites.js";

// V3: the fixed line a refused process publish carries.
export * from "./stage-model-publish-refusal.js";
export * from "./app-project-slack.js";

export { TaskStopEditablePolicySchema, type TaskStopEditablePolicy, TaskStopPendingChangeSchema, TaskStopEditingContextSchema, TaskStopEditBodySchema, TaskStopDecisionBodySchema, TaskStopEditResultSchema, taskStopEditKind } from "./task-stop-editing.js";
export * from "./app-service-status.js";

// Proof and evidence (W4/W5): browser-safe schemas for the evidence view, decision cards and the test environment.
export * from "./evidence.js";
export * from "./decision-cards.js";
export * from "./decision-focus.js";
// Setup and test health SH19: the four test results and their fixed words, for the task page's Evidence tab.
export * from "./verification-result.js";
export * from "./decision-card-tabs.js";
export * from "./plan-one-screen.js";
export * from "./test-environment.js";
// Setup wizard (E4): what the test-environment setup routes answer and take (browser-safe).
export { TestEnvironmentStateSchema, TestEnvSummarySchema, TestEnvRunsSchema, TestEnvProposeBodySchema, TestEnvProveBodySchema, TestEnvCheckBodySchema, TestEnvApproveBodySchema, TestEnvEditBodySchema, TestEnvSeedBodySchema, TEST_ENV_SEED_COMMAND_MAX_CHARS, TestEnvApplyBodySchema, TestEnvApplyAnswerSchema, TestEnvRequestApprovalBodySchema, TestEnvRequestApprovalAnswerSchema, TestEnvApproveAnswerSchema, TEST_ENV_REFUSALS, TEST_ENV_APPLY_SKIPPED, type TestEnvironmentState, type TestEnvSummary, type TestEnvRuns, type TestEnvApplyAnswer, type TestEnvRequestApprovalAnswer, type TestEnvApproveAnswer, type TestEnvEditBody, type TestEnvApplyBody, type TestEnvCheckBody } from "./test-environment-wire.js";
// K1 C5b: what the agent loaded (browser-safe readers).
export * from "./knowledge-skills.js";
// Meta repo lane F: task intake (browser-safe).
export * from "./intake.js";
// Slice 5: ticket updates (browser-safe).
export * from "./ticket-updates.js";
export * from "./loaded-knowledge.js";

// Meta repo lane B: the setup agent's proposal, its review rows and the per-item apply, and the contracts they cite (provenance, the meta project body).
export * from "./provenance.js";
export * from "./setup-proposal.js";
export * from "./setup-agent-web.js";
export { CreateProjectFromMetaBodySchema, type CreateProjectFromMetaBody, META_KNOWLEDGE_DEFAULTS } from "./meta-project.js";
export { SetupDraftResponseSchema, type SetupDraftResponse, SetupDraftResponseReaderSchema, SetupDraftStartBodySchema, type SetupDraftStartBody, SETUP_DRAFT_STATUSES } from "./rovara-code.js";

// Learning v2 L3b: the Lessons tab, the Sources tab and the task page's lessons list.
export * from "./app-lessons.js";
export * from "./app-lessons-repo-file.js";
export * from "./lessons-local-tools.js";
// Team record source rows (learning v2): the Sources tab editor's bodies and views.
export * from "./team-record-sources.js";
// UX-4b: the project's learning mode, read and set on the project page.
export { LEARNING_MODES, LearningModeSchema, LearningModeViewSchema, LearningModeWriteBodySchema, type LearningMode, type LearningModeView, type LearningModeWriteBody } from "./team-record.js";
// UX-4b (owner decision 3): the team record search on the project page reads the record's own search and past-work routes.
export { PastWorkResponseSchema, RecordSearchResponseSchema, type PastWorkResponse, type RecordSearchResponse } from "./team-record.js";

export * from "./company-domains-web.js";
export { JiraOrgAdminMutationBodySchema, JiraOrgAdminResultReaderSchema, type JiraOrgAdminMutationBody } from "./jira-org-admin-web.js";
export { TrackerPeopleReaderSchema, TrackerPeopleMutationBodySchema, TrackerPeopleResultReaderSchema, type TrackerPeople, type TrackerPeopleMutationBody } from "./tracker-people-web.js";
export * from "./app-design-review-company.js";
export * from "./app-company-rules.js";
// The fixed wording of the standing instructions block: the Company rules page shows how the rules are put to the agent.
export { STANDING_INSTRUCTIONS_WORDING } from "./standing-instructions.js";
export * from "./app-known-failing.js";
export * from "./app-saved-env.js";
export * from "./app-second-review.js";

export * from "./task-stop-enrollment.js";
export { ASK_ANSWER_LABEL, ASK_QUESTION_MAX_CHARS, errorRefKey, type ErrorRef } from "./live-interaction.js";
export { AskStatusReaderSchema, type AskStatus } from "./live-ask.js";
export { DiagnosisStatusReaderSchema, DIAGNOSIS_ANSWER_LABEL, DIAGNOSIS_NO_PROVIDER_MESSAGE, DiagnosisIdSchema } from "./live-diagnosis.js";

export * from "./task-stop-start-preview.js";
export { SIGNED_OUT_REASONS, isSignedOutReason, type SignedOutReason } from "./sign-in-reasons.js";
export * from "./task-status.js";
export * from "./notification-prefs.js";
export { FINISHED_AS, FinishedAsSchema, type FinishedAs } from "./session-views.js";
// srv/needs-broker-ui-2 item 11: the merge rules a project screen reads (`GET /v1/app/projects/{p}/code-settings`).
export { CodeSettingsSchema, CodeSettingsResponseSchema, CodeSettingsResponseReaderSchema, DEFAULT_CODE_SETTINGS, type CodeSettings, type CodeSettingsResponse, type CodeSettingsResponseRead } from "./rovara-code.js";
