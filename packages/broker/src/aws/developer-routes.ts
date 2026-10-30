import { projectSlackBrowserHttp } from "../org/project-slack-browser-http.js";
import { projectAllowedDomainsHttp, type AllowedDomainBrowserDependencies } from "../org/project-allowed-domains-http.js";
import { readAllowedDomainActorConditions } from "../org/second-person-evidence.js";
// Lane A G1: catalog-bound project money source, no setter or lifecycle claim.
import { getTaskStopProject } from "../org/task-stop-project.js";
// Lane A G1: existing agent money limit, no initialization or management.
import { getTaskStopAgent } from "../org/task-stop-agent.js";
// Lane A G1: configured company-default read, with no policy writer.
import { getTaskStopCompany } from "../org/task-stop-company.js";
// Lane A G1: narrow read of the existing company ceiling.
import { getTaskStopCeiling } from "../org/task-stop-ceiling.js";
// Lane A: read-only monthly base settings; no legacy proxy sync.
import { getAdminBudgetSettings } from "../org/admin-budget-settings.js";
import { createReviewedOrganizationInvite, getInviteCreationReceipt } from "../org/invite-creation.js";
import { getOrganizationInviteStatus } from "../org/invite-status.js";
import { readSlackWorkspaceEvidence } from "../org/slack-workspace-evidence.js";
import { WorkingBranchNameSchema } from "@agentx/contracts";
import { projectWorkingBranchSaveHttp } from "../org/project-working-branch-save-http.js";
import { readProjectWorkingBranchContextHttp } from "../org/project-working-branch-context.js";
import { readProjectWorkingBranchHttp } from "../org/project-working-branch-http.js";
import type { WorkingBranchReviewDependencies } from "../org/project-working-branch.js";
import type { WorkingBranchListDependencies } from "../org/project-working-branch-list.js";
import { readReviewedProjectRestoreAppPreview } from "../org/reviewed-project-restore-app.js";
import { readReviewedProjectArchiveAppPreview } from "../org/reviewed-project-archive-app.js";
import { revokeOrganizationInvite } from "../org/invite-revocation.js";
import { logDeveloperEvent } from "../developer/log.js";
import { listOrganizationInvites } from "../org/invite-directory.js";
import { changeReviewedMemberRole } from "../org/role-changes.js";
import { OrgMemberRoleChangeBodySchema } from "@agentx/contracts";
import { listOrganizationMembers, lookupOrganizationMember } from "../org/directory.js";
import { navigationReadCache } from "../app-nav/read-cache.js";
import { APP_NAV_CACHE_MS, appNav, orgTrial, type AppNavDependencies } from "../app-nav/nav.js";
import { navigationLive } from "../agent-sessions/live.js";
import { homeCards } from "../agent-sessions/home.js";
import { listSessions } from "../agent-sessions/read.js";
import { listRoster } from "../agents/roster.js";
import { listVisibleAgents } from "../agents/access.js";
// Spec 025 FR-009, FR-013, FR-014 and FR-016: GET projects, and the project access check the task
// routes use. /v1/dev/* has no API Gateway authorizer (D17): the broker verifies the developer
// access token itself, then checks the environment, the method and the sign-in session on every
// request (R12, R13), so a revoked session stops at once.
import { taskResponseForClient } from "../rovara-code/task-view-compat.js";
import { clearOrgHooks } from "../triggers/hooks.js";
import { deleteOrgTriggers } from "../triggers/lifecycle.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SlackRequestQueue } from "../developer/page-comments.js";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  AgentXNameSchema,
  RenameOrganizationBodySchema,
  CreateOrganizationInviteBodySchema,
  CHANNEL_MEMBERS_MAX_CHANNELS,
  DEFAULT_AGENT_ALLOW_DOMAINS,
  DEFAULT_DEVCONTAINER_CONFIG_PATH,
  DEVELOPER_TOKEN_AUDIENCE,
  DEVELOPER_WORKSPACES_PER_PROJECT,
  StoredProjectDefinitionSchema,
  WORKSPACE_PROJECT_INDEX,
  WorkspaceInstanceSchema,
  TaskPersonProofResponseSchema,
  TaskChannelPeopleResponseSchema,
  TaskPeopleDisplayReadResponseSchema,
  AgentXError,
  agentXError,
  LAST_OWNER_MESSAGE,
  MEMBER_GRANT_SK_PREFIX,
  PROJECT_REVISION_SK_PREFIX,
  SLACK_BINDING_SK_PREFIX,
  developerTaskPolicy,
  formatCommandLine,
  memberGrantsPk,
  orgMemberKey,
  orgProjectCatalogPk,
  projectAllows,
  workspaceProjectIndexValue,
  projectPk,
  slackBindingPk,
  workspaceRecordFields,
  type AgentId,
  type DeveloperTaskView,
  type RunInput,
  type AppMeResponse,
  SetMyNameBodySchema,
  type SetMyNameResponse,
  type AppProjectDetail,
  type AppProjectSummary,
  type AppProjectsResponse,
  type ProjectMember,
  StartDeveloperTaskRequestSchema,
  type ProjectMemberChangeResponse,
  type ProjectMemberRemoveResponse,
  type ProjectSlackChannelRemoveResponse,
  type ProjectSlackChannelResponse,
  type ProjectMembersResponse,
  type ProjectRole,
  type ChannelByNameRequest,
  type ChannelByNameResponse,
  type ChannelInfoRequest,
  type ChannelInfoResponse,
  type ChannelMembersRequest,
  type ChannelMembersResponse,
  type DeveloperProjectsResponse,
  type DeveloperSignInMethod,
  type DeveloperTaskPolicy,
  type DeveloperWorkspace,
  type DeveloperWorkspacesResponse,
  type EndDeveloperSessionsRequest,
  type EndDeveloperSessionsResponse,
  type RealtimeTokenAnswer,
  type RealtimeTokenRequest,
  type UnlinkIdentityRequest,
  type UnlinkIdentityResponse,
  type StartIdentityLinkRequest,
  type StartIdentityLinkResponse,
  StartIdentityLinkAppResponseSchema,
  type StartIdentityLinkAppResponse,
  UnlinkableSignInMethodSchema,
  type LinkedIdentity,
  type OrgId,
  type WorkspaceInstance,
  type OrgRole,
  OrgIdSchema,
  OrgRoleSchema,
  ProjectSetupCheckBodySchema,
  PutProjectMemberBodySchema,
  RemoveProjectSlackChannelBodySchema,
  RemoveProjectMemberBodySchema,
  type SlackAuthCheckRequest,
  type SlackAuthCheckResponse,
  type SlackChannelBinding,
  type SlackUserByEmailRequest,
  type SlackUserByEmailResponse,
  type TaskPersonProofRequest,
  type TaskPersonProofResponse,
  type TaskChannelPeopleRequest,
  type TaskChannelPeopleResponse,
  type TaskPeopleDisplayReadRequest,
  type TaskPeopleDisplayReadResponse,
  SESSION_PROJECT_BINDINGS_MAX,
  workflowAnswer,
  type MergeTrackingItem,
  type MergeView,
} from "@agentx/contracts";
import { accessDeniedMessage, resolveDeveloperAccess } from "../developer/access.js";
import { clearOrgEgress, readEgressDomains, type EgressDomainsDependencies } from "../org/egress-domains.js";
import { requireReviewedModelSourceWebWrite } from "../model-sources/routes.js";
import { releaseOrgModelSources } from "../model-sources/release.js";
import { restoreProjectReviewedWithEffects, archiveProjectReviewedWithEffects, applyArchiveRequest, archiveOrgProjects, type ProjectArchiveDependencies } from "../org/project-archive.js";
import { latestRevision, updateProjectSettings, type ProjectSettingsDependencies } from "../org/project-settings.js";
import { effectiveProjectRole, grantRoleOf, grantedByOf, readProjectMeta, requireNewWorkAllowed, type ProjectMetaItem } from "../developer/project-roles.js";
import { unbindProjectChannel, type ProjectSlackChannelDependencies } from "../org/slack-binding.js";
import { createProjectMembers, listProjectMembers, removeProjectMember, setProjectMember, survivorOf, type ProjectMembers, type ProjectMembersDependencies } from "../org/project-members.js";
import { evaluateProjectAuthority } from "../developer/task-project-access.js";
import { DEFAULT_ROVARA_WEB_ORIGIN, inviteUrl } from "../org/invite-url.js";
import { parseCreateProjectBody, type CreateProjectInput } from "../org/cloud-projects.js";
import { changeBudgets, ensureSynced, memberLimitOf, type BudgetDependencies, type OrgBudgetSettings } from "../org/budget.js";
import type { ModelAccess } from "../model-proxy/access.js";
import type { OrgStore } from "../org/store.js";
import type { AuditExportClientDeps } from "../audit/export.js";
import type { AuditRuntime } from "../audit/outbox.js";
import { isAuditOrgPath, routeAuditRequest } from "../audit/routes.js";
import { createAuditViewPage, isAuditViewPath } from "../audit/view-page.js";
import { checkTaskPersonIdentity, registerTaskChannelPeople, resolveTaskPickerPersonWithId, type ProjectAccessSubject, type TaskPersonIdentityDependencies } from "../developer/task-person-identity.js";
import { taskPeopleDisplayAdmission, type TaskPeopleDisplayAdmission } from "../developer/task-people-display-budget.js";
import { safeDisplayName } from "../developer/person-name.js";
import { readChosenName } from "../developer/chosen-name.js";
import { DeveloperSignInStore, META, endedByAdmin, endedByUnlink, methodSince, startedBeforeMethodOn, type DeveloperMarks, type DeveloperRecord, type SessionRecord } from "../developer/store.js";
import type { ChatGptConnections } from "../chatgpt/connections.js";
import { developerTaskIdentity, type DeveloperTaskRecord, type WorkspaceCharge } from "../developer/task-records.js";
import { developerCharge, limitReached, readWorkspaceLimits, type WorkspaceLimits } from "../developer/limits.js";
import { STUCK_SETUP_MS } from "./stuck-setup.js";
import { closeSetupCheck } from "./setup-check-close.js";
import { admitMachineTime, admitTrial } from "../org/trial.js";
import { commitSetupCheck, setupCheckLimitMessage, setupCheckReplay, setupStateOf, type SetupCheckDependencies } from "../org/project-setup-check.js";
import type { DeveloperTaskActions } from "./developer-task-actions.js";
import {
  createPageComment, decideOnPage, deletePageComment, editPageComment, getTaskDocumentView, getTaskFreshness, getTaskPageState, listPageComments, retryApplicationRoundOnPage, setPageSuggestion,
  confirmTaskPeopleProposal, getTaskPeopleCapabilities, getTaskPeopleForPage, getTaskPeopleProposal, getTaskPeopleProposalMetadata, getTaskPersonPresentationName,
  proposeTaskOwnershipForPage, proposeTaskPeopleRoleForPage,
  CLOSED_TASK, cancelTask, cancelTaskFor, getWorkflowFeedbackReview, loadOwnedTask, retryTaskWorkflowFor, routeDeveloperTaskRequest, startAlreadyMade, startTask, startTaskWorkflowUnderstandFromSystem, submitWorkflowFeedbackDecision, taskView, type DeveloperTaskRouteDependencies } from "./developer-tasks.js";
import type { AdaptedHttpRequest } from "./lambda.js";
import { StatusReply } from "./status-reply.js";
import { getModels } from "../agents/models-route.js";
import { isAgentRoute, routeAgentRequest, type AgentRouteDependencies } from "../agents/routes.js";
import { isChainRoute, routeChainRequest, type ChainRouteDependencies } from "../chains/routes.js";
import { chainRunPortsFor, type ChainRunPorts, type ChainRunnerDependencies } from "../chains/runner.js";
import { chainControlFor, chainSessionReads, chainSteerReadsFor } from "../chains/session-seam.js";
import { chainViewPortsFor } from "../chains/view-ports.js";
import { realtimeConfigFromEnvironment } from "../realtime/sink.js";
import { decidingOf, isAgentSessionRoute, routeAgentSessionRequest, type SessionRouteDependencies } from "../agent-sessions/routes.js";
import { closeOrgSessions, stopOrgSessions } from "../agent-sessions/lifecycle.js";
import type { HandoffRuntime } from "../agent-sessions/handoff.js";
import { stopSession } from "../agent-sessions/stop.js";
import { requireSessionLevel } from "../agent-sessions/access.js";
import type { SessionTakeOverDependencies } from "../agent-sessions/take-over.js";
import { isDeviceRoute, routeDeviceRequest } from "../devices/routes.js";
import { clearOrgConnections, type OrgConnectionStore } from "../connections/store.js";
import { startAgentRun, type AgentRunStarter } from "../agents/runs.js";
import { CODE_INTENT_PATH, routeCodeIntentStart, type CodeIntentRouteDependencies } from "../rovara-code/routes.js";
import { getCodeSettings, putCodeSettings } from "../rovara-code/code-settings.js";
import { projectProcessOf } from "../playbook/project-process.js";
import { HOW_WE_WORK_PATH, PLAYBOOK_PATH, PLAYBOOK_PROCESS_PATH, getProjectHowWeWork, routeProjectPlaybook, routeProjectProcess } from "../playbook/routes.js";
import { mergeViewOf } from "../rovara-code/merge.js";
import { applySetupDraft, getSetupDraft, startSetupDraft, type SetupDraftDependencies } from "../rovara-code/setup-draft.js";
import { startCodeIntent } from "../rovara-code/intent.js";
import { NEEDS_OWNER_APPROVAL, gateRunVersion } from "../agents/run-version-gate.js";
import { pausedTaskGate, requestForPausedTask, withdrawTaskSpendRequests } from "../spend/requests.js";
import { createFeedbackReviewWeb } from "./feedback-review-web.js";
import { TASK_PAGE, TASK_PEOPLE_CONFIRMATION, TASK_STATUS, createTaskWeb } from "./task-web.js";
import { TASK_PAGE_API_PREFIX, createTaskWebApi } from "./task-web-api.js";
import { getTaskE2EArtifact } from "./task-e2e-artifact.js";

/** How long the close spends asking running sessions to stop; the rest are stopped by the model-key mint and the dispatch guard. */
const CLOSE_STOP_BUDGET_MS = 8_000;

export interface DeveloperApiConfiguration {
  issuer: string; env: string; methods: { slack: boolean; oidc: boolean; cloud?: boolean; github?: boolean }; slackTeamId?: string;
  /** Each method's enabled-since cutoff, epoch seconds (FR-045): a session started before it was ended by a disable. */
  since?: { slack?: number; oidc?: number; cloud?: number; github?: number };
  signInTableName: string;
  /** The hosted Rovara web app's origin, which invite links point at (ROVARA_WEB_ORIGIN); https://rovara.dev when absent. */
  webOrigin?: string;
  channelMembers(request: ChannelMembersRequest): Promise<ChannelMembersResponse>;
  /** C0: optional until the compatible identity function is deployed; callers must fail closed when absent. */
  taskPersonProof?: (request: TaskPersonProofRequest) => Promise<TaskPersonProofResponse>;
  taskChannelPeople?: (request: TaskChannelPeopleRequest) => Promise<TaskChannelPeopleResponse>;
  /** E: one request-scoped, metered proof/list transport. Absence makes the complete People view unavailable. */
  taskPeopleDisplayRead?: (request: TaskPeopleDisplayReadRequest) => Promise<TaskPeopleDisplayReadResponse>;
  /** D: exact opt-in for role changes; an existing PEOPLE sidecar remains enforced while false. */
  taskPeopleConfiguration?: { peopleChangesEnabled: boolean };
  /** Spec 059: absent is the safe default; production factories intentionally leave graph starts disabled. */
  workflowDependenciesEnabled?: boolean;
  /** C: optional distinct claim-bound invitation endpoint; production leaves it absent until separately configured. */
  inviteTaskPerson?: DeveloperTaskRouteDependencies["inviteTaskPerson"];
  /** R10: bound channels' names and privacy, read by DeveloperIdentity. Optional: without it channels are listed by ID. */
  channelInfo?: (request: ChannelInfoRequest) => Promise<ChannelInfoResponse>;
  /** How long one request waits for channel names in all; the rest stay unnamed. Default 5 seconds. */
  channelInfoDeadlineMs?: number;
  /** Spec 025 A12: FR-012's email lookup, for an admin's Slack link. */
  slackUserByEmail?: (request: SlackUserByEmailRequest) => Promise<SlackUserByEmailResponse>;
  /** Spec 025 A13: the health route's Slack token check. */
  slackAuthCheck?: () => Promise<SlackAuthCheckResponse>;
  /** Spec 025 E9: an admin ends a developer's sign-in sessions, through DeveloperIdentity (the broker only reads the sign-in table). */
  endDeveloperSessions?: (request: EndDeveloperSessionsRequest) => Promise<EndDeveloperSessionsResponse>;
  /** Plan 5 Task 8: the realtime events API's HTTP endpoint, when the install has one (`REALTIME_HTTP_ENDPOINT`). */
  realtimeEndpoint?: string | undefined;
  /** Plan 5 Task 8: a realtime token for a signed-in person, signed by DeveloperIdentity (the broker holds no signing right). Without it `POST /v1/app/realtime/token` is unavailable. */
  realtimeToken?: (request: RealtimeTokenRequest) => Promise<RealtimeTokenAnswer>;
  /** Plan 2, Task 8: a person unlinks one of their own sign-in methods, through DeveloperIdentity (the broker only reads the sign-in table). */
  unlinkIdentity?: (request: UnlinkIdentityRequest) => Promise<UnlinkIdentityResponse>;
  /** Plan 2, Task 8b: a person starts adding a sign-in method they removed earlier back, through DeveloperIdentity (it owns the sign-in table's writes). */
  startIdentityLink?: (request: StartIdentityLinkRequest) => Promise<StartIdentityLinkResponse>;
  /** Spec 025 E12: a public channel by its name, through DeveloperIdentity. */
  channelByName?: (request: ChannelByNameRequest) => Promise<ChannelByNameResponse>;
  /** Verifies the Authorization header's developer access token (D17; verify-token.ts) and returns its claims. */
  verifyAccessToken(authorization: string | undefined): Promise<Record<string, unknown>>;
  /** Spec 061 slice 2: the Slack service's request queue, set only with SLACK_REQUEST_QUEUE_URL; "Ask AgentX to reply to this comment" needs it. */
  slackRequestQueue?: SlackRequestQueue;
}
export interface DeveloperRouteDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  developer: DeveloperApiConfiguration;
  now: () => number;
  /** The developer task routes' broker actions; without them /v1/dev/tasks* answers NOT_FOUND. */
  tasks?: DeveloperTaskActions;
  /** Rovara Code (Bug G): whether the viewer may press Merge now, for the words of a task page (the browser pages carry no `agents`, so they carry this instead). */
  codeMergeView?: (task: DeveloperTaskRecord, items: MergeTrackingItem[], viewerDeveloperId: string) => Promise<MergeView | undefined>;
  /** Reconciles all already-linked PRs using GitHub's current API state before owner decisions. */
  refreshTaskFeedback?(taskId: string): Promise<void>;
  /** Builds E2E projections only from the task's current server-owned admission and evidence references. */
  workflowE2EPresentation?: DeveloperTaskRouteDependencies["workflowE2EPresentation"];
  workflowE2EPublicationChecks?: DeveloperTaskRouteDependencies["workflowE2EPublicationChecks"];
  sessionDiffFiles?: NonNullable<SessionRouteDependencies["diff"]>["files"] | undefined;
  currentPullRequestHead?: DeveloperTaskRouteDependencies["currentPullRequestHead"];
  currentBaseCommit?: DeveloperTaskRouteDependencies["currentBaseCommit"];
  taskAutonomyNow?: DeveloperTaskRouteDependencies["taskAutonomyNow"];
  workflowE2EScenarioResults?: DeveloperTaskRouteDependencies["workflowE2EScenarioResults"];
  workflowE2EArtifact?: DeveloperTaskRouteDependencies["workflowE2EArtifact"];
  startWorkflowE2EBaseline?: DeveloperTaskRouteDependencies["startWorkflowE2EBaseline"];
  /** Checks a plan's application E2E intent when the owner approves it. */
  validateWorkflowE2EApplicationPlan?: DeveloperTaskRouteDependencies["validateWorkflowE2EApplicationPlan"];
  registeredRepositoryIdentity?: DeveloperTaskRouteDependencies["registeredRepositoryIdentity"];
  /** Plan 2, Task 15: the check that an org's GitHub connection still reaches a project's repositories (cloud installs). */
  requireRepositoriesConnected?: DeveloperTaskRouteDependencies["requireRepositoriesConnected"];
  /** Sign in with ChatGPT (#338): each developer's connection; without it /v1/dev/chatgpt/* answers NOT_FOUND. */
  chatgpt?: ChatGptConnections;
  /** Which org a developer belongs to: the membership a token's `org` claim is checked against on every request. */
  orgs?: Pick<OrgStore, "bindSlackTeam" | "renameOrg" | "orgForDeveloper" | "getOrg" | "createInvite" | "listMembers" | "setRole" | "removeMember" | "closeOrg">;
  /**
   * What closing an org does besides releasing its GitHub and Slack bindings: archive its projects (Task 20) and clear its egress domains
   * (Task 18). They default to `archiveOrgProjects` and `clearOrgEgress`; `POST /v1/app/org/leave` calls them when the last owner leaves.
   */
  closeOrgHooks?: { archiveProjects: (orgId: OrgId) => Promise<void>; clearEgress: (orgId: OrgId) => Promise<void>; clearConnections?: (orgId: OrgId) => Promise<void>; clearTriggers?: (orgId: OrgId) => Promise<void>; clearHooks?: (orgId: OrgId) => Promise<void>; releaseModelSources?: (orgId: OrgId) => Promise<void>; clearSessions?: (orgId: OrgId) => Promise<void>; stopWork?: (orgId: OrgId) => Promise<void> };
  /**
   * Plan 3 Task 11: what follows a project's archive on the agents platform (`onProjectArchived`). Called once the archive has applied, never on a
   * replay; a failure is logged and never undoes or fails the archive. Absent where agents are not set up.
   */
  projectArchived?: (orgId: OrgId, project: string) => Promise<void>;
  /** The model proxy, for budgets (ruling R28). Absent without one: budgets are not set up, and task starts are not checked against them. */
  modelAccess?: ModelAccess;
  /** A cloud install (ruling R42): trial lock and machine-time allowance apply to its orgs. */
  cloud?: boolean;
  /**
   * Plan 2, Task 16: creates a project in the caller's org from a repository the org's GitHub connection reaches, through the broker's
   * registration, and grants the caller access; a replay of the same request answers the same project with `duplicate: true`. The route
   * has already checked the install, the caller's role and the body.
   */
  createProject?: (caller: DeveloperCaller, input: CreateProjectInput) => Promise<{ duplicate: boolean }>;
  /** The Audit Ledger's reader and export client (Task 12). Absent on an install with no ledger: the audit routes then answer NOT_FOUND. */
  auditLedger?: AuditExportClientDeps;
  /** The Audit Ledger's outbox: what a route's audited action adds its pending item through. Absent on a legacy install, where nothing is recorded. */
  audit?: AuditRuntime;
  /**
   * Plan 2, Task 17: what `PUT /v1/app/projects/{name}/settings` needs from the broker: registering a revision, and (for an added repository)
   * GitHub's view of it. Without it the route answers NOT_FOUND.
   */
  projectSettings?: Pick<ProjectSettingsDependencies<DeveloperCaller>, "registerRevision" | "githubCredentialRef" | "repositoryIdentity" | "requireRepositoryConnected">;
  projectAllowedDomains?: Pick<AllowedDomainBrowserDependencies, "registerApproved">;
  /** Lane B: pinned, explicitly org-bound read-only branch provider; absent fails closed. */
  projectWorkingBranches?: () => Required<Pick<WorkingBranchListDependencies, "checkRepository" | "listBranches">> & { finish: () => Promise<void> };
  projectWorkingBranchPreview?: () => Required<Pick<WorkingBranchReviewDependencies, "checkRepository" | "resolveBranch">> & { finish: () => Promise<void> };
  /**
   * Plan 2, Task 18: pushes the approved domains to the cell's DNS firewall (Task 19's `syncCellAllowList`). Without it an approved change
   * waits for the scheduled sync, and the caller is told it will apply within 5 minutes.
   */
  egressSync?: EgressDomainsDependencies["sync"];
  /**
   * Plan 2, Task 21: who has which role in a project (the agents platform reads people through this). Built from the route dependencies
   * (`projectMembersOf`) when absent.
   */
  projectMembers?: ProjectMembers;
  /** Plan 2, Task 13: starts connecting GitHub to the caller's org (the broker's `startGithubConnect`). Without it the route answers NOT_FOUND. */
  githubConnect?: {
    start(caller: DeveloperCaller): Promise<{ installUrl: string; expiresAt: string; orgName?: string; ownerName?: string }>;
    /** Plan 2, Task 14: the org's requests to a GitHub admin (any member), and the cancelling of one that is waiting. */
    listRequests(caller: DeveloperCaller): Promise<{ requests: unknown[] }>;
    cancelRequest(caller: DeveloperCaller, githubUserId: string): Promise<{ githubUserId: string; status: "cancelled" }>;
    /** Plan 2, Task 15: the org's installations (any member), disconnecting one (owner or admin), and the repositories one reaches. */
    listInstallations(caller: DeveloperCaller): Promise<{ installations: unknown[] }>;
    disconnect(caller: DeveloperCaller, installationId: number): Promise<{ installationId: number; accountLogin: string; message: string }>;
    listRepositories(caller: DeveloperCaller, installationId: number): Promise<{ repositories: Array<{ fullName: string; githubRepositoryId: number; private: boolean; defaultBranch: string }> }>;
  };
  /** Plan 3 Task 12b: the org's connections, which closing the org clears. Independent of `agents`, which only the connection routes need. */
  orgConnections?: OrgConnectionStore;
  /** Plan 3, Task 7: what the agent routes (`/v1/app/agents*` and the other Plan 3 paths) need. Without it they answer NOT_FOUND. */
  agents?: AgentRouteDependencies;
  /**
   * Plan 5, Task 5: what session levels, shares and reads need. The broker supplies it with `agents` (as `agents.agentSessions`) and on the browser pages
   * (`/s/…`, `/review/…`), which don't carry `agents`. Without it the session routes answer NOT_FOUND and the task page admits nobody on a session level.
   */
  agentSessions?: SessionTakeOverDependencies;
  /** Plan 5, Task 19 (Plan 6's `HandoffRuntime`, H1): moving a session between a Mac and the cloud. Until Plan 6 supplies it the move route answers `RUNTIME_UNAVAILABLE`. */
  handoff?: HandoffRuntime | undefined;
  /**
   * Plan 3 final review (access m-2): what follows a person's project role changing or their grant being removed, on the agents platform (`onProjectMemberChanged`:
   * the agents they were accountable for move when they no longer hold `manage_agents`). Called after the change applied, also on a replay (it is repeatable);
   * a failure is logged and never undoes or fails the change. Absent where agents are not set up.
   */
  projectMemberChanged?: (orgId: OrgId, project: string, developerId: string) => Promise<void>;
}

export { StatusReply };
/** Who is asking about a project, and in which org: grants and revisions are read in that org only. */
export type ProjectAccessCaller = ProjectAccessSubject & { orgId: OrgId; orgRole: OrgRole };
export { effectiveProjectRole, requireNewWorkAllowed };
export interface DeveloperCaller { developerId: string; sessionId: string; amr: DeveloperSignInMethod; name: string; slackUserId?: string; email?: string; orgId: OrgId; orgRole: OrgRole; /** True only for a caller the web boundary authenticated with a live browser session cookie and its CSRF token (`authenticateWebRequest`); never for a token. */ browserSession?: true;
  /** Release 0.4.16: true once the person chose their own display name (`PUT /v1/app/me/name`). Set by the session read; absent on a caller built another way. */ nameChosen?: boolean }

/** What the broker needs from a Lambda invoke; `@aws-sdk/client-lambda`'s InvokeCommand output fits. */
export interface ChannelMembersInvokeResult { FunctionError?: string | undefined; Payload?: Uint8Array | undefined }

const errorName = (error: unknown) => (error instanceof Error ? error.name : "UnknownError");
const SLACK_UNAVAILABLE = { ok: false, error: "slack_unavailable" } as const;
/** A Slack or DeveloperIdentity error code: the only error text that may reach a log or an answer (R9). */
const SLACK_ERROR_CODE = /^[a-z_]{1,64}$/;
type IdentityRefusal = typeof SLACK_UNAVAILABLE | { ok: false; error: "invalid_request" };

/**
 * One direct invoke of the DeveloperIdentity function, which holds the Slack token (the broker
 * never reads the Slack secret). `readReply` returns the good answer from the decoded reply, or
 * undefined. Every failure fails closed as slack_unavailable with one `<event>_failed` log line;
 * an invalid_request reply is a broker bug, logged as `<event>_invalid_request`. Lines carry only
 * the reason, error name, FunctionError or reply error, never a payload.
 */
async function identityInvoke<T>(
  invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>,
  request: ChannelMembersRequest | TaskPersonProofRequest | TaskChannelPeopleRequest | ChannelInfoRequest | SlackUserByEmailRequest | SlackAuthCheckRequest | EndDeveloperSessionsRequest | UnlinkIdentityRequest | StartIdentityLinkRequest | ChannelByNameRequest | RealtimeTokenRequest,
  readReply: (reply: Record<string, unknown>) => T | undefined,
  event: string,
): Promise<T | IdentityRefusal> {
  const failed = (entry: Record<string, string>) => {
    logDeveloperEvent({ event: `${event}_failed`, ...entry });
    return SLACK_UNAVAILABLE;
  };
  let response: ChannelMembersInvokeResult;
  try {
    response = await invoke(Buffer.from(JSON.stringify(request)));
  } catch (error) {
    return failed({ reason: "invoke_error", error: errorName(error) });
  }
  if (response.FunctionError !== undefined) return failed({ reason: "function_error", functionError: response.FunctionError });
  if (response.Payload === undefined) return failed({ reason: "empty_reply" });
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(response.Payload).toString("utf8"));
  } catch {
    return failed({ reason: "unreadable_reply" });
  }
  const reply = typeof decoded === "object" && decoded !== null ? decoded as Record<string, unknown> : {};
  const good = readReply(reply);
  if (good !== undefined) return good;
  if (reply.ok === false && reply.error === "invalid_request") {
    logDeveloperEvent({ event: `${event}_invalid_request`, reason: "the identity function refused the broker's request; this is a broker bug" });
    return { ok: false, error: "invalid_request" };
  }
  // Only a code-shaped reply error (such as token_revoked) is logged; never free text.
  return failed({ reason: "reply_error", error: reply.ok === false && typeof reply.error === "string" && SLACK_ERROR_CODE.test(reply.error) ? reply.error : "malformed_reply" });
}

/** The broker's channel-members check (FR-013) through the DeveloperIdentity function. */
export function channelMembersThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: ChannelMembersRequest) => Promise<ChannelMembersResponse> {
  return (request) => identityInvoke(invoke, request, (reply) => (reply.ok === true && Array.isArray(reply.memberOf)
    ? { ok: true as const, memberOf: reply.memberOf.filter((entry): entry is string => typeof entry === "string") }
    : undefined), "developer.channel_members");
}

/** C0: one fresh proof through DeveloperIdentity. Any old or malformed reply fails closed. */
export function taskPersonProofThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: TaskPersonProofRequest) => Promise<TaskPersonProofResponse> {
  return (request) => identityInvoke(invoke, request, (reply): TaskPersonProofResponse | undefined => {
    const parsed = TaskPersonProofResponseSchema.safeParse(reply);
    if (!parsed.success) return undefined;
    if (!parsed.data.ok) return parsed.data.error === "ineligible" ? parsed.data : undefined;
    const requested = new Set(request.channelIds);
    const memberOf = parsed.data.memberOf;
    if (parsed.data.user.id !== request.slackUserId || new Set(memberOf).size !== memberOf.length || memberOf.some((channelId) => !requested.has(channelId))) return undefined;
    return parsed.data;
  }, "developer.task_person_proof");
}

/** E: complete fresh channel identities through DeveloperIdentity. Partial or malformed replies fail closed. */
export function taskChannelPeopleThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: TaskChannelPeopleRequest) => Promise<TaskChannelPeopleResponse> {
  return (request) => identityInvoke(invoke, request, (reply): TaskChannelPeopleResponse | undefined => {
    const parsed = TaskChannelPeopleResponseSchema.safeParse(reply);
    if (!parsed.success) return undefined;
    if (!parsed.data.ok) return parsed.data.error === "capacity_exceeded" ? parsed.data : undefined;
    const requested = new Set(request.channelIds);
    if (new Set(parsed.data.users.map((user) => user.id)).size !== parsed.data.users.length
      || parsed.data.users.some((user) => new Set(user.memberOf).size !== user.memberOf.length || user.memberOf.some((channelId) => !requested.has(channelId)))) return undefined;
    return parsed.data;
  }, "developer.task_channel_people");
}

/** E: strict metered display transport. Any missing or malformed usage seals the caller's admission. */
export function taskPeopleDisplayReadThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: TaskPeopleDisplayReadRequest) => Promise<TaskPeopleDisplayReadResponse> {
  return async (request) => {
    const failed = (reason: string): never => {
      logDeveloperEvent({ event: "developer.task_people_display_read_failed", reason });
      throw agentXError("SLACK_UNAVAILABLE", "the complete task People directory is unavailable");
    };
    let response: ChannelMembersInvokeResult;
    try { response = await invoke(Buffer.from(JSON.stringify(request))); }
    catch (error) { return failed(`invoke_${errorName(error)}`); }
    if (response.FunctionError !== undefined) return failed("function_error");
    if (response.Payload === undefined) return failed("empty_reply");
    let decoded: unknown;
    try { decoded = JSON.parse(Buffer.from(response.Payload).toString("utf8")); }
    catch { return failed("unreadable_reply"); }
    const parsed = TaskPeopleDisplayReadResponseSchema.safeParse(decoded);
    if (!parsed.success || parsed.data.operation !== request.operation
      || parsed.data.admission.slackCallsUsed > request.admission.slackCallsLimit) return failed("malformed_reply");
    if (parsed.data.operation === "proof") {
      const result = parsed.data.result;
      if (result.ok) {
        const requested = new Set(request.operation === "proof" ? request.request.channelIds : []);
        if (request.operation !== "proof" || result.user.id !== request.request.slackUserId
          || new Set(result.memberOf).size !== result.memberOf.length || result.memberOf.some((id) => !requested.has(id))) return failed("malformed_reply");
      }
    } else {
      const result = parsed.data.result;
      if (result.ok) {
        const requested = new Set(request.operation === "directory" ? request.request.channelIds : []);
        if (request.operation !== "directory" || new Set(result.users.map((user) => user.id)).size !== result.users.length
          || result.users.some((user) => new Set(user.memberOf).size !== user.memberOf.length || user.memberOf.some((id) => !requested.has(id)))) return failed("malformed_reply");
      }
    }
    return parsed.data;
  };
}

type ChannelEntry = { channelId: string; name: string; isPrivate: boolean };
const isChannelEntry = (entry: unknown): entry is ChannelEntry => {
  const candidate = entry as Partial<Record<keyof ChannelEntry, unknown>> | null;
  return typeof candidate === "object" && candidate !== null && typeof candidate.channelId === "string" && typeof candidate.name === "string" && typeof candidate.isPrivate === "boolean";
};

/** R10: bound channels' names and privacy through the DeveloperIdentity function; keeps only well-formed entries. */
export function channelInfoThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: ChannelInfoRequest) => Promise<ChannelInfoResponse> {
  return (request) => identityInvoke(invoke, request, (reply) => (reply.ok === true && Array.isArray(reply.channels)
    ? { ok: true as const, channels: reply.channels.filter(isChannelEntry).map(({ channelId, name, isPrivate }) => ({ channelId, name, isPrivate })) }
    : undefined), "developer.channel_info");
}

/** A12: who owns a verified email, through DeveloperIdentity; fails closed as slack_unavailable. */
export function slackUserByEmailThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: SlackUserByEmailRequest) => Promise<SlackUserByEmailResponse> {
  return (request) => identityInvoke(invoke, request, (reply) => (reply.ok === true
    ? (typeof reply.userId === "string" ? { ok: true as const, userId: reply.userId } : { ok: true as const })
    : undefined), "developer.slack_user_by_email");
}

/** A13: the bot token's auth.test, through DeveloperIdentity. Slack's refusal code passes through. */
export function slackAuthCheckThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): () => Promise<SlackAuthCheckResponse> {
  return async () => {
    let refusal: string | undefined;
    const answer = await identityInvoke(invoke, { kind: "slack-auth-check" }, (reply) => {
      if (reply.ok === true && typeof reply.teamId === "string") return { ok: true as const, teamId: reply.teamId };
      if (reply.ok === false && typeof reply.error === "string" && SLACK_ERROR_CODE.test(reply.error) && reply.error !== "invalid_request") refusal = reply.error;
      return undefined;
    }, "developer.slack_auth_check");
    if (answer.ok) return answer;
    return { ok: false, error: refusal ?? answer.error };
  };
}

/**
 * E9: ends a developer's sessions through DeveloperIdentity. A not_found reply is an answer (the
 * developer never signed in), not a failure, so it is neither logged as one nor turned into
 * unavailable (C15). Every other failure is unavailable.
 */
export function endDeveloperSessionsThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: EndDeveloperSessionsRequest) => Promise<EndDeveloperSessionsResponse> {
  return async (request) => {
    const answer = await identityInvoke(invoke, request, (reply): EndDeveloperSessionsResponse | undefined => {
      if (reply.ok === true) return { ok: true };
      if (reply.ok === false && reply.error === "not_found") return { ok: false, error: "not_found" };
      return undefined;
    }, "developer.end_sessions");
    if (answer.ok || answer.error === "not_found" || answer.error === "invalid_request") return answer;
    return { ok: false, error: "unavailable" };
  };
}

/** Plan 5 Task 8: asks DeveloperIdentity to sign a realtime token. Any failure is `unavailable` (the route answers that), after one `developer.realtime_token_failed` log line. */
export function realtimeTokenThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: RealtimeTokenRequest) => Promise<RealtimeTokenAnswer> {
  return async (request) => {
    const answer = await identityInvoke(invoke, request, (reply): RealtimeTokenAnswer | undefined =>
      (reply.ok === true && typeof reply.token === "string" && typeof reply.expiresAt === "string" ? { ok: true, token: reply.token, expiresAt: reply.expiresAt } : undefined), "developer.realtime_token");
    return answer.ok ? answer : { ok: false, error: answer.error === "invalid_request" ? "invalid_request" : "unavailable" };
  };
}

/** The words a refusal of the sign-in function carries to the person: short, and nothing the function did not write for them. */
const refusalMessageOf = (reply: Record<string, unknown>): string | undefined =>
  typeof reply.message === "string" && reply.message.length > 0 && reply.message.length <= 200 ? reply.message : undefined;

/**
 * Plan 2, Task 8 and 8b: unlinks a sign-in method through DeveloperIdentity. A refusal (the only way in, or the first sign-in), a sign-in
 * that is not fresh enough or is the method being removed (`reauth`), and a method that is not linked are answers, passed on in the
 * person's words; every other failure is unavailable.
 */
export function unlinkIdentityThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: UnlinkIdentityRequest) => Promise<UnlinkIdentityResponse> {
  return async (request) => {
    const answer = await identityInvoke(invoke, request, (reply): UnlinkIdentityResponse | undefined => {
      if (reply.ok === true) return { ok: true };
      if (reply.ok === false && reply.error === "not_found") return { ok: false, error: "not_found" };
      const message = refusalMessageOf(reply);
      if (reply.ok === false && (reply.error === "refused" || reply.error === "reauth") && message !== undefined) return { ok: false, error: reply.error, message };
      return undefined;
    }, "developer.unlink_identity");
    if (answer.ok || answer.error === "not_found" || answer.error === "refused" || answer.error === "reauth" || answer.error === "invalid_request") return answer;
    return { ok: false, error: "unavailable" };
  };
}

/** Plan 2, Task 8b: starts adding a removed sign-in method back through DeveloperIdentity; its answer is the sign-in link, or why not. */
export function startIdentityLinkThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: StartIdentityLinkRequest) => Promise<StartIdentityLinkResponse> {
  return async (request) => {
    const answer = await identityInvoke(invoke, request, (reply): StartIdentityLinkResponse | undefined => {
      if (reply.ok === true && typeof reply.authorizeUrl === "string" && StartIdentityLinkAppResponseSchema.safeParse({ authorizeUrl: reply.authorizeUrl }).success) return { ok: true, authorizeUrl: reply.authorizeUrl };
      const message = refusalMessageOf(reply);
      if (reply.ok === false && (reply.error === "refused" || reply.error === "reauth") && message !== undefined) return { ok: false, error: reply.error, message };
      return undefined;
    }, "developer.start_identity_link");
    if (answer.ok || answer.error === "refused" || answer.error === "reauth" || answer.error === "invalid_request") return answer;
    return { ok: false, error: "unavailable" };
  };
}

/** E12 (Q8): a public channel by name through DeveloperIdentity; fails closed as slack_unavailable. */
export function channelByNameThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: ChannelByNameRequest) => Promise<ChannelByNameResponse> {
  return (request) => identityInvoke(invoke, request, (reply) => {
    if (reply.ok !== true) return undefined;
    const channel = reply.channel as { channelId?: unknown; name?: unknown } | undefined;
    return typeof channel?.channelId === "string" && typeof channel.name === "string"
      ? { ok: true as const, channel: { channelId: channel.channelId, name: channel.name } }
      : { ok: true as const };
  }, "developer.channel_by_name");
}

/** The broker's copy of each method's enabled-since cutoff (FR-045), from its environment. */
export function developerSinceFromEnvironment(env: NodeJS.ProcessEnv): { slack?: number; oidc?: number } {
  const slack = methodSince(env.DEVELOPER_SIGNIN_SLACK_SINCE);
  const oidc = methodSince(env.DEVELOPER_OIDC_SINCE);
  return { ...(slack === undefined ? {} : { slack }), ...(oidc === undefined ? {} : { oidc }) };
}

/**
 * The sign-in server's public keys, read by invoking the DeveloperIdentity function with its own
 * JWKS route (D17): the broker may not call kms:GetPublicKey, which the key policy keeps to
 * DeveloperIdentity. Any failure throws, and the verifier answers 503 for it.
 */
export function developerKeysThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): () => Promise<unknown[]> {
  const request = { version: "2.0", rawPath: "/v1/auth/.well-known/jwks.json", requestContext: { requestId: "broker-jwks", http: { method: "GET" } } };
  const failed = (reason: string, entry: Record<string, string> = {}) => {
    logDeveloperEvent({ event: "developer.jwks_failed", reason, ...entry });
    return new Error(`the developer sign-in keys could not be read (${reason})`);
  };
  return async () => {
    let response: ChannelMembersInvokeResult;
    try {
      response = await invoke(Buffer.from(JSON.stringify(request)));
    } catch (error) {
      throw failed("invoke_error", { error: errorName(error) });
    }
    if (response.FunctionError !== undefined) throw failed("function_error", { functionError: response.FunctionError });
    if (response.Payload === undefined) throw failed("empty_reply");
    let keys: unknown;
    try {
      const reply = JSON.parse(Buffer.from(response.Payload).toString("utf8")) as { statusCode?: unknown; body?: unknown };
      if (reply.statusCode !== 200 || typeof reply.body !== "string") throw new Error("not 200");
      keys = (JSON.parse(reply.body) as { keys?: unknown }).keys;
    } catch {
      throw failed("unreadable_reply");
    }
    if (!Array.isArray(keys) || keys.length === 0) throw failed("no_keys");
    return keys as unknown[];
  };
}

const SIGN_IN_AGAIN = "your AgentX sign-in has ended; run agentx login <url> again";

/** What a verified developer token names: who, which sign-in, and the org and role the token was issued for. */
export interface DeveloperTokenClaims { developerId: string; sessionId: string; amr: DeveloperSignInMethod; orgId: OrgId; orgRole: OrgRole }

export function developerClaims(claims: Record<string, unknown> | undefined, config: DeveloperApiConfiguration): DeveloperTokenClaims {
  if (claims === undefined || claims.iss !== config.issuer || claims.aud !== DEVELOPER_TOKEN_AUDIENCE || claims.env !== config.env) {
    throw agentXError("AUTH_REQUIRED", "this route needs an AgentX developer sign-in; run agentx login <url>");
  }
  if (typeof claims.sub !== "string" || !/^[a-f0-9]{64}$/.test(claims.sub) || typeof claims.sid !== "string" || claims.sid === "") {
    throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  }
  const amr = claims.amr;
  if (amr !== "slack" && amr !== "oidc" && amr !== "cloud" && amr !== "github") throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  if (config.methods[amr] !== true) {
    throw agentXError("AUTH_REQUIRED", `${amr === "slack" ? "Slack" : amr === "cloud" ? "Cloud" : amr === "github" ? "GitHub" : "Company"} sign-in is turned off in this environment; sign in another way with agentx login <url>`);
  }
  // A token with no org (one issued before orgs, or forged) is refused like a token with no session: sign in again.
  const orgId = OrgIdSchema.safeParse(claims.org);
  const orgRole = OrgRoleSchema.safeParse(claims.org_role);
  if (!orgId.success || !orgRole.success) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  return { developerId: claims.sub, sessionId: claims.sid, amr, orgId: orgId.data, orgRole: orgRole.data };
}

async function getSignIn<T>(deps: DeveloperRouteDependencies, pk: string): Promise<T | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.developer.signInTableName, Key: { pk, sk: META }, ConsistentRead: true })) as { Item?: T };
  return response.Item;
}

export async function authenticateDeveloper(deps: DeveloperRouteDependencies, claims: Record<string, unknown> | undefined): Promise<DeveloperCaller> {
  const token = developerClaims(claims, deps.developer);
  return authenticateSession(deps, token);
}

/**
 * Plan 3, Task 21a-presence: who a bearer token names, for the confirmation machinery (it refuses a token but mints a ticket for its member).
 * The same checks as every developer route: the token, its live session, the method, and the org membership now.
 */
export async function authenticateBearer(deps: DeveloperRouteDependencies, authorization: string): Promise<{ developerId: string; orgId: OrgId }> {
  const caller = await authenticateDeveloper(deps, await deps.developer.verifyAccessToken(authorization));
  return { developerId: caller.developerId, orgId: caller.orgId };
}

/** A session's identity; `orgId` is present when a token named the org it was issued for, which must still be the developer's. */
async function authenticateSession(deps: DeveloperRouteDependencies, token: { developerId: string; sessionId: string; amr: DeveloperSignInMethod; orgId?: OrgId }): Promise<DeveloperCaller> {
  const session = await getSignIn<Pick<SessionRecord, "developerId" | "amr" | "endsAt" | "revokedAt" | "startedAt" | "slackUserId" | "identityKey">>(deps, `SESSION#${token.sessionId}`);
  if (session === undefined || session.developerId !== token.developerId || session.revokedAt !== undefined || session.endsAt <= Math.floor(deps.now() / 1000)) {
    throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  }
  if (session.amr !== token.amr) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  // The broker may only read the sign-in table (R13), so it refuses; the token endpoint revokes the
  // session at its next refresh.
  if (startedBeforeMethodOn(session.startedAt, deps.developer.since?.[token.amr])) {
    throw agentXError("AUTH_REQUIRED", `your sign-in ended when ${token.amr === "slack" ? "Slack" : token.amr === "cloud" ? "cloud sign-in" : token.amr === "github" ? "GitHub sign-in" : "company sign-in"} was turned off; sign in again with agentx login <url>`);
  }
  // Release 0.4.18: the name the person chose is an item in the State table, read with their sign-in record.
  const [developer, chosenName] = await Promise.all([
    getSignIn<Pick<DeveloperRecord, "displayName" | "displayNameChosen" | "slackUserId" | "email" | "revoked" | "sessionsEndedAt"> & DeveloperMarks>(deps, `DEVELOPER#${token.developerId}`),
    readChosenName(deps.documentClient, deps.tableName, token.developerId),
  ]);
  if (developer === undefined || developer.revoked) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  if (endedByAdmin(session.startedAt, developer.sessionsEndedAt)) {
    // E9: D16's per-request check ends the session at once; the token endpoint revokes it at its next refresh.
    throw agentXError("AUTH_REQUIRED", "an AgentX admin ended your sign-in; run agentx login <url> again");
  }
  // Plan 2, Task 8: the person removed this session's sign-in method from their account (the others' sessions go on).
  if (endedByUnlink(session, developer)) {
    throw agentXError("AUTH_REQUIRED", "this sign-in method was removed from your account; run agentx login <url> again");
  }
  // The org is the developer's membership now: a person removed from the org, or moved to another, is refused even
  // while their token is still valid. The role is the current one, so a demotion applies at once.
  const membership = await deps.orgs?.orgForDeveloper(token.developerId);
  if (membership === undefined || (token.orgId !== undefined && membership.orgId !== token.orgId)) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  return {
    developerId: token.developerId,
    sessionId: token.sessionId,
    amr: token.amr,
    orgId: membership.orgId,
    orgRole: membership.role,
    // Release 0.4.16: the caller's name is everywhere a task, a session or a comment names them, so it is never an email address.
    name: chosenName ?? safeDisplayName(developer.displayName, token.developerId),
    nameChosen: chosenName !== undefined || developer.displayNameChosen === true,
    ...(developer.slackUserId === undefined ? {} : { slackUserId: developer.slackUserId }),
    ...(developer.email === undefined ? {} : { email: developer.email }),
  };
}

/** Rechecks an opaque browser-cookie session against DeveloperIdentity on every page/API request. */
export async function authenticateDeveloperSessionId(deps: DeveloperRouteDependencies, sessionId: string): Promise<DeveloperCaller> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  const session = await getSignIn<Pick<SessionRecord, "developerId" | "amr" | "reviewExpiresAt">>(deps, `SESSION#${sessionId}`);
  if (session === undefined || (session.amr !== "slack" && session.amr !== "oidc" && session.amr !== "cloud" && session.amr !== "github")
    || session.reviewExpiresAt === undefined || session.reviewExpiresAt <= Math.floor(deps.now() / 1000)) {
    throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  }
  return authenticateSession(deps, { developerId: session.developerId, sessionId, amr: session.amr });
}

/** Every item under `pk` with the sort key prefix, following LastEvaluatedKey through each page. */
async function queryAll<T>(deps: DeveloperRouteDependencies, pk: string, prefix: string, bound?: { max: number; onCut: () => void }): Promise<T[]> {
  const items: T[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const response = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix },
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
      ConsistentRead: true,
    })) as { Items?: T[]; LastEvaluatedKey?: Record<string, unknown> };
    items.push(...(response.Items ?? []));
    start = response.LastEvaluatedKey;
    // A bounded read stops at its cap, with what it has: the rest is not read, and the caller is told it was cut.
    if (bound !== undefined && items.length >= bound.max && (start !== undefined || items.length > bound.max)) {
      bound.onCut();
      return items.slice(0, bound.max);
    }
  } while (start !== undefined);
  return items;
}

/** Channel names are for display only: they never hold the projects list near a timeout. */
const CHANNEL_NAMES_DEADLINE_MS = 5_000;
const REVISION_READS_AT_ONCE = 8;

/** `fn` over every item, at most `limit` at a time, results in the items' order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** The latest revision's number and task policy: the only fields read, so only they are fetched. */
async function latestDefinition(deps: DeveloperRouteDependencies, orgId: OrgId, project: string): Promise<{ revision: number; developerTasks?: unknown } | undefined> {
  const response = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": projectPk(orgId, project), ":prefix": PROJECT_REVISION_SK_PREFIX },
    ProjectionExpression: "#definition.#revision, #definition.#developerTasks",
    ExpressionAttributeNames: { "#definition": "definition", "#revision": "revision", "#developerTasks": "developerTasks" },
    ScanIndexForward: false,
    Limit: 1,
    ConsistentRead: true,
  })) as { Items?: Array<{ definition: { revision: number; developerTasks?: unknown } }> };
  return response.Items?.[0]?.definition;
}

/** Each named project's latest revision and task policy; projects with no revision are left out. */
export async function projectsWithPolicy(deps: DeveloperRouteDependencies, orgId: OrgId, names: readonly string[]): Promise<Map<string, { revision: number; policy: DeveloperTaskPolicy }>> {
  const unique = [...new Set(names)].sort();
  const definitions = await mapLimit(unique, REVISION_READS_AT_ONCE, (name) => latestDefinition(deps, orgId, name));
  const found = new Map<string, { revision: number; policy: DeveloperTaskPolicy }>();
  unique.forEach((name, index) => {
    const definition = definitions[index];
    // developerTaskPolicy fails closed: a policy that no longer parses turns tasks and channel access off.
    if (definition !== undefined) found.set(name, { revision: definition.revision, policy: developerTaskPolicy(definition) });
  });
  return found;
}

/** The channel-members check, failing closed (and logged by error name) when it throws. */
function safeChannelMembers(deps: DeveloperRouteDependencies): (request: ChannelMembersRequest) => Promise<ChannelMembersResponse> {
  return async (request) => {
    try {
      return await deps.developer.channelMembers(request);
    } catch (error) {
      logDeveloperEvent({ event: "developer.channel_members_failed", reason: "threw", error: errorName(error) });
      return SLACK_UNAVAILABLE;
    }
  };
}

/**
 * Channel names and privacy, best effort: without them the channels are listed by ID (R10).
 * Privacy comes from DeveloperIdentity's 10-minute cache. The whole lookup has one deadline.
 */
async function channelNames(deps: DeveloperRouteDependencies, channelIds: readonly string[]): Promise<Map<string, { name: string; isPrivate: boolean }>> {
  const names = new Map<string, { name: string; isPrivate: boolean }>();
  const channelInfo = deps.developer.channelInfo;
  if (channelInfo === undefined || channelIds.length === 0) return names;
  const unique = [...new Set(channelIds)].sort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), deps.developer.channelInfoDeadlineMs ?? CHANNEL_NAMES_DEADLINE_MS);
  });
  try {
    for (let start = 0; start < unique.length; start += CHANNEL_MEMBERS_MAX_CHANNELS) {
      let answer: ChannelInfoResponse | "deadline";
      try {
        answer = await Promise.race([channelInfo({ kind: "channel-info", channelIds: unique.slice(start, start + CHANNEL_MEMBERS_MAX_CHANNELS) }), expired]);
      } catch (error) {
        logDeveloperEvent({ event: "developer.channel_info_failed", reason: "threw", error: errorName(error) });
        return names;
      }
      if (answer === "deadline") {
        logDeveloperEvent({ event: "developer.channel_info_failed", reason: "deadline" });
        return names;
      }
      if (!answer.ok) return names;
      for (const channel of answer.channels) names.set(channel.channelId, { name: channel.name, isPrivate: channel.isPrivate });
    }
    return names;
  } finally {
    clearTimeout(timer);
  }
}

/** A private channel is flagged by ID only: its name never leaves the control plane (R10). */
const describeChannel = (channelId: string, names: Map<string, { name: string; isPrivate: boolean }>) => {
  const known = names.get(channelId);
  if (known === undefined) return { channelId };
  return known.isPrivate ? { channelId, isPrivate: true } : { channelId, name: known.name, isPrivate: false };
};

/**
 * FR-013: a grant is a row that gives a project role: `developer` (a maintainer or contributor) or, since Plan 2, Task 21, `viewer`. An
 * admin's `administrator` rows are the operator's and give none (a developer ID is built like an admin owner key, so they can sit under the
 * same key when both sign in through one IdP). Each row is returned whole: its role and who made it are read from it.
 */
async function grantRowsOf(deps: DeveloperRouteDependencies, caller: ProjectAccessCaller): Promise<Array<{ projectName: string; grant: GrantRow }>> {
  const rows = await queryAll<GrantRow & { projectName?: string }>(deps, memberGrantsPk(caller.orgId, caller.developerId), MEMBER_GRANT_SK_PREFIX);
  return rows.flatMap((row) => (typeof row.projectName === "string" && grantRoleOf(row) !== undefined ? [{ projectName: row.projectName, grant: row }] : []));
}
type GrantRow = { role?: unknown; projectRole?: unknown; grantedBy?: unknown };

/**
 * The install's Slack team's channel bindings inside one org. Every one of them is read, because a person's access to a project is computed from them: a cut here would silently take a
 * channel's access away. Only the project page (which shows a few channels) passes `boundEvent`, and then reads at most `SESSION_PROJECT_BINDINGS_MAX`, logging the cut with the org's id.
 */
async function bindingsOf(deps: DeveloperRouteDependencies, orgId: OrgId, boundEvent?: string): Promise<SlackChannelBinding[]> {
  if (deps.developer.slackTeamId === undefined) return [];
  const bound = boundEvent === undefined ? undefined : { max: SESSION_PROJECT_BINDINGS_MAX, onCut: () => logDeveloperEvent({ event: boundEvent, orgId }) };
  return queryAll<SlackChannelBinding>(deps, slackBindingPk(orgId, deps.developer.slackTeamId), SLACK_BINDING_SK_PREFIX, bound);
}

/** A developer's name for display: their sign-in record's, else "Unknown". */
async function nameOf(deps: DeveloperRouteDependencies, developerId: string): Promise<string> {
  return (await signInStoreOf(deps).getDeveloper(developerId))?.displayName ?? "Unknown";
}

async function listProjects(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<DeveloperProjectsResponse> {
  const grantRows = await grantRowsOf(deps, caller);
  const grantOf = new Map(grantRows.map((row) => [row.projectName, row.grant]));
  // An org owner or admin reaches every project of their org (Task 11, I4), so each one in the org's catalog is theirs to list.
  const orgMaintainer = caller.orgRole === "owner" || caller.orgRole === "admin";
  const catalogNames = orgMaintainer ? (await queryAll<{ name?: unknown }>(deps, orgProjectCatalogPk(caller.orgId), "PROJECT#")).flatMap((entry) => (typeof entry.name === "string" ? [entry.name] : [])) : [];
  const grants = [...new Set([...grantRows.map((row) => row.projectName), ...catalogNames])];
  const bindings = await bindingsOf(deps, caller.orgId);
  const policies = await projectsWithPolicy(deps, caller.orgId, [...grants, ...bindings.map((binding) => binding.projectName)]);
  const access = await resolveDeveloperAccess({
    grants,
    bindings,
    ...(caller.slackUserId === undefined ? {} : { slackUserId: caller.slackUserId }),
    // FR-013 with FR-014: a project's own switch decides whether channel members may use it.
    channelMembersMayUse: (project) => policies.get(project)?.policy.channelMembersMayUse === true,
    channelMembers: safeChannelMembers(deps),
  });
  const listed = [...access.projects].filter(([name]) => policies.has(name));
  // Like checkProjectAccess: a caller with no Slack link is never shown channel names.
  const names = caller.slackUserId === undefined ? new Map<string, { name: string; isPrivate: boolean }>() : await channelNames(deps, listed.flatMap(([, entry]) => entry.channels));
  // Who added the caller, for the projects a grant of a person gave them (Task 21): one name lookup per person.
  // A person who has since been merged into another is named as the one they became (the grant keeps the id it was made under).
  const merge = projectMembersDepsOf(deps);
  const adders = new Map<string, { id: string; name: string }>();
  for (const [name] of listed) {
    const by = orgMaintainer ? undefined : grantedByOf(grantOf.get(name));
    if (by !== undefined && "developerId" in by) adders.set(by.developerId, { id: by.developerId, name: "Unknown" });
  }
  await mapLimit([...adders.keys()], REVISION_READS_AT_ONCE, async (id) => {
    const survivor = await survivorOf(merge, id);
    adders.set(id, { id: survivor, name: await nameOf(deps, survivor) });
  });
  const projects: DeveloperProjectsResponse["projects"] = [];
  for (const [name, entry] of listed) {
    const known = policies.get(name)!;
    const grant = grantOf.get(name);
    const role = effectiveProjectRole(caller, grant, entry.access === "channel");
    const source = orgMaintainer ? "org_role" as const : grant !== undefined ? "grant" as const : "channel" as const;
    const by = source === "grant" ? grantedByOf(grant) : undefined;
    projects.push({
      name, latestRevision: known.revision, access: entry.access, channels: entry.channels.map((channelId) => describeChannel(channelId, names)), tasks: known.policy,
      ...(role === undefined ? {} : { role, roleSource: source }),
      ...(by === undefined || !("developerId" in by) ? {} : { addedBy: { developerId: adders.get(by.developerId)?.id ?? by.developerId, name: adders.get(by.developerId)?.name ?? "Unknown" } }),
    });
  }
  return {
    developer: {
      id: caller.developerId, name: caller.name, provider: caller.amr, orgRole: caller.orgRole,
      ...(caller.slackUserId === undefined ? {} : { slackUserId: caller.slackUserId }),
      ...(caller.email === undefined ? {} : { email: caller.email }),
    },
    projects,
    notices: access.slackUnavailable ? ["slack_unavailable"] : [],
  };
}

type StoredProject = z.infer<typeof StoredProjectDefinitionSchema>;

/** A project's latest revision as stored, with who registered it and when; undefined when it has none or the revision no longer parses. */
async function latestProjectRecord(deps: DeveloperRouteDependencies, orgId: OrgId, project: string): Promise<{ definition: StoredProject; registeredBy: string; registeredAt: string; workingBranchSelections?: unknown } | undefined> {
  const response = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": projectPk(orgId, project), ":prefix": PROJECT_REVISION_SK_PREFIX },
    ScanIndexForward: false,
    Limit: 1,
    ConsistentRead: true,
  })) as { Items?: Array<{ definition?: unknown; registeredBy?: unknown; registeredAt?: unknown; workingBranchSelections?: unknown }> };
  const item = response.Items?.[0];
  if (item === undefined) return undefined;
  const definition = StoredProjectDefinitionSchema.safeParse(item.definition);
  if (!definition.success) {
    logDeveloperEvent({ event: "developer.project_unreadable", project, reason: definition.error.issues[0]?.message ?? "invalid" });
    return undefined;
  }
  return { workingBranchSelections:item.workingBranchSelections, definition: definition.data, registeredBy: typeof item.registeredBy === "string" ? item.registeredBy : "unknown", registeredAt: typeof item.registeredAt === "string" ? item.registeredAt : "" };
}

/** GitHub's spelling of a repository, `owner/name`, from its URL; the repository's own name when the URL is no GitHub path. */
function repositoryFullName(repository: { name: string; url: string }): string {
  try {
    const parts = new URL(repository.url).pathname.replace(/\.git$/, "").split("/").filter(Boolean);
    if (parts.length === 2) return parts.join("/");
  } catch { /* fall through to the name */ }
  return repository.name;
}

async function appProjectSummary(
  deps: DeveloperRouteDependencies,
  name: string,
  role: ProjectRole,
  record: NonNullable<Awaited<ReturnType<typeof latestProjectRecord>>>,
  meta: ProjectMetaItem | undefined,
): Promise<AppProjectSummary> {
  const { definition } = record;
  return {
    name,
    ...(meta?.description === undefined ? {} : { description: meta.description }),
    status: meta?.status ?? "active",
    latestRevision: definition.revision,
    repositories: definition.repositories.map((repository) => ({ name: repository.name, fullName: repositoryFullName(repository), defaultBranch: repository.defaultBranch })),
    myRole: role,
    setup: await setupStateOf(setupCheckDepsOf(deps), meta, definition),
  };
}

/**
 * The projects the caller may see in the app and their role in each. Org owners and admins see every project in the org's own
 * catalog, as maintainers. Anyone else sees what a grant or channel access gives, as listProjects resolves it: contributors. Every
 * read is keyed by `caller.orgId`, so another org's project of the same name is never reached. With `only`, just that name.
 */
async function visibleProjectRoles(deps: DeveloperRouteDependencies, caller: DeveloperCaller, only?: string): Promise<Map<string, ProjectRole>> {
  const roles = new Map<string, ProjectRole>();
  if (caller.orgRole === "owner" || caller.orgRole === "admin") {
    const names = only !== undefined ? [only]
      : (await queryAll<{ name?: unknown }>(deps, orgProjectCatalogPk(caller.orgId), "PROJECT#")).flatMap((entry) => (typeof entry.name === "string" ? [entry.name] : []));
    for (const name of names) roles.set(name, effectiveProjectRole(caller, undefined, false)!);
    return roles;
  }
  const grantRows = (await grantRowsOf(deps, caller)).filter((row) => only === undefined || row.projectName === only);
  const grantOf = new Map(grantRows.map((row) => [row.projectName, row.grant]));
  const grants = grantRows.map((row) => row.projectName);
  const bindings = (await bindingsOf(deps, caller.orgId)).filter((binding) => only === undefined || binding.projectName === only);
  const policies = await projectsWithPolicy(deps, caller.orgId, [...grants, ...bindings.map((binding) => binding.projectName)]);
  const access = await resolveDeveloperAccess({
    grants, bindings,
    ...(caller.slackUserId === undefined ? {} : { slackUserId: caller.slackUserId }),
    channelMembersMayUse: (project) => policies.get(project)?.policy.channelMembersMayUse === true,
    channelMembers: safeChannelMembers(deps),
  });
  for (const [name, entry] of access.projects) {
    const role = effectiveProjectRole(caller, grantOf.get(name), entry.access === "channel");
    if (role !== undefined && policies.has(name)) roles.set(name, role);
  }
  return roles;
}

/** `GET /v1/app/projects`: the caller's projects, sorted by name. Archived ones only with `?include=archived`. */
async function listAppProjects(deps: DeveloperRouteDependencies, caller: DeveloperCaller, includeArchived: boolean): Promise<AppProjectsResponse> {
  const roles = await visibleProjectRoles(deps, caller);
  const names = [...roles.keys()].sort();
  const built = await mapLimit(names, REVISION_READS_AT_ONCE, async (name) => {
    const [record, meta] = await Promise.all([latestProjectRecord(deps, caller.orgId, name), readProjectMeta(deps, caller.orgId, name)]);
    // A catalog entry with no readable revision is not a project the app can show.
    if (record === undefined || (meta?.status === "archived" && !includeArchived)) return undefined;
    return appProjectSummary(deps, name, roles.get(name)!, record, meta);
  });
  return { projects: built.filter((project): project is AppProjectSummary => project !== undefined) };
}

const PROJECT_NOT_FOUND_IN_APP = "project not found";

const ArchiveBodySchema = z.object({ requestId: z.string().uuid() }).strict();

/** What archiving and restoring write and flip: the project's META, and its egress item through the same firewall sync as a settings save. */
function archiveDepsOf(deps: DeveloperRouteDependencies): ProjectArchiveDependencies {
  return { documentClient: deps.documentClient, tableName: deps.tableName, egress: egressDepsOf(deps), now: () => new Date(deps.now()) };
}

/** Where egress items are kept and how a change reaches the firewall (Plan 2, Task 18). */
function egressDepsOf(deps: DeveloperRouteDependencies): EgressDomainsDependencies {
  return { documentClient: deps.documentClient, tableName: deps.tableName, cloud: deps.cloud === true, now: () => new Date(deps.now()), sync: deps.egressSync ?? (async () => ({ ok: false })), ...(deps.audit === undefined ? {} : { audit: deps.audit }) };
}

/** `GET /v1/app/projects/{name}`: no access, no such project and another org's project all answer the same 404 PROJECT_NOT_FOUND. */
async function getAppProject(deps: DeveloperRouteDependencies, caller: DeveloperCaller, rawName: string): Promise<AppProjectDetail> {
  const notFound = () => agentXError("PROJECT_NOT_FOUND", PROJECT_NOT_FOUND_IN_APP);
  let name: string;
  try { name = decodeURIComponent(rawName); } catch { throw notFound(); }
  if (!AgentXNameSchema.safeParse(name).success) throw notFound();
  const role = (await visibleProjectRoles(deps, caller, name)).get(name);
  if (role === undefined) throw notFound();
  const [record, meta] = await Promise.all([latestProjectRecord(deps, caller.orgId, name), readProjectMeta(deps, caller.orgId, name)]);
  if (record === undefined) throw notFound();
  const { definition } = record;
  const createdBy = meta?.createdBy ?? "unknown";
  const creator = createdBy === "unknown" ? undefined : await signInStoreOf(deps).getDeveloper(createdBy);
  const egress = await readEgressDomains(deps, caller.orgId, { kind: "project", project: name });
  return {
    ...await appProjectSummary(deps, name, role, record, meta),
    ...(record.workingBranchSelections===undefined?{}:{savedWorkingBranches: (()=>{
      const selections=z.record(AgentXNameSchema,z.object({branch:WorkingBranchNameSchema,commit:z.string().regex(/^[a-f0-9]{40}$/),installationId:z.number().int().positive(),repositoryId:z.number().int().positive()}).strict()).safeParse(record.workingBranchSelections);
      if(!selections.success)throw agentXError("RUNTIME_UNAVAILABLE","Saved working branch settings could not be read.");
      return Object.entries(selections.data).map(([repository,value])=>{const repo=definition.repositories.find(r=>r.name===repository);if(repo===undefined||repo.installationId!==value.installationId||repo.githubRepositoryId!==value.repositoryId)throw agentXError("RUNTIME_UNAVAILABLE","Saved working branch settings could not be read.");return{repository,fullName:repositoryFullName(repo),branch:value.branch,commit:value.commit};});
    })()}),
    settings: {
      setupCommands: definition.setup.map(formatCommandLine),
      testCommands: definition.readiness.map(formatCommandLine),
      devcontainer: definition.devcontainer === undefined ? null
        : { repository: definition.devcontainer.repository, configPath: definition.devcontainer.configPath ?? DEFAULT_DEVCONTAINER_CONFIG_PATH },
      // A domain every project has is approved. Any other is as its egress item says; one the item does not list was never asked for (a
      // project that stored it before approvals existed), so on cloud it serves nothing and reads as pending until the next save asks.
      allowedDomains: (definition.network?.allowedDomains ?? []).map((domain) => {
        if (DEFAULT_AGENT_ALLOW_DOMAINS.includes(domain)) return { domain, status: "approved" as const };
        const entry = egress?.domains.find((candidate) => candidate.domain === domain);
        if (entry === undefined) return { domain, status: deps.cloud === true ? "pending" as const : "approved" as const };
        return { domain, status: entry.status, ...(entry.status === "rejected" && entry.reason !== undefined ? { reason: entry.reason } : {}) };
      }),
    },
    createdAt: meta?.createdAt ?? record.registeredAt,
    createdBy: { developerId: createdBy, name: creator?.displayName ?? "Unknown" },
  };
}

/**
 * `POST /v1/app/projects/{name}/archive` and `.../restore` (Plan 2, Task 20): a maintainer of the project (an org owner or admin, or the
 * project's own maintainer) archives it or brings it back, and the answer is the project as the app now shows it. No access is a 404 and a
 * role without `archive` a 403. Repeating either call on a project already in that state answers 200 and changes nothing (it does run the
 * firewall step again, which finishes a call that stopped half-way). The request id is stored: a replay of it applies nothing, even after the
 * opposite action. `warnings` says when the firewall could not be told at once. Archiving refuses only new work; it stops nothing that is running.
 */
async function changeProjectArchive(deps: DeveloperRouteDependencies, caller: DeveloperCaller, rawName: string, body: unknown, change: "archive" | "restore"): Promise<{ project: AppProjectDetail; warnings: string[] }> {
  const notFound = () => agentXError("PROJECT_NOT_FOUND", PROJECT_NOT_FOUND_IN_APP);
  let name: string;
  try { name = decodeURIComponent(rawName); } catch { throw notFound(); }
  if (!AgentXNameSchema.safeParse(name).success) throw notFound();
  const role = (await visibleProjectRoles(deps, caller, name)).get(name);
  if (role === undefined) throw notFound();
  if (!projectAllows(role, "archive")) throw agentXError("FORBIDDEN", "only a project maintainer can archive or restore a project");
  const parsed = ArchiveBodySchema.safeParse(body);
  if (!parsed.success) throw bodyError(parsed.error);
  if (await latestProjectRecord(deps, caller.orgId, name) === undefined) throw notFound();
  const { warnings, replayed } = await applyArchiveRequest(archiveDepsOf(deps), caller.orgId, name, change, parsed.data.requestId, { developerId: caller.developerId });
  if (!replayed) logDeveloperEvent({ event: change === "archive" ? "developer.project_archived" : "developer.project_restored", orgId: caller.orgId, project: name });
  if (!replayed && change === "archive" && deps.projectArchived !== undefined) {
    // Plan 3: the agents platform reacts to the archive. The project is archived whatever this does.
    try { await deps.projectArchived(caller.orgId, name); } catch (error) {
      logDeveloperEvent({ event: "developer.project_archived_hook_failed", orgId: caller.orgId, project: name, error: error instanceof Error ? error.name : "unknown" });
    }
  }
  return { project: await getAppProject(deps, caller, name), warnings };
}

/** What the setup status and the setup check read and write: the table and the clock. */
function setupCheckDepsOf(deps: DeveloperRouteDependencies): SetupCheckDependencies {
  return { documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now };
}

/**
 * What a setup check must pass: the admissions of a task start except the model budget (no model runs). The org's GitHub connection must still
 * reach every repository, a cloud org's trial must be unlocked and its month of machine time not used up, and the person must be under the
 * workspace limits; the check then takes a slot (`commitSetupCheck`). Everything is read before anything is written, so a refused check leaves
 * nothing behind.
 */
async function admitSetupCheck(deps: DeveloperRouteDependencies, caller: DeveloperCaller, definition: Parameters<NonNullable<DeveloperRouteDependencies["requireRepositoriesConnected"]>>[1], limitDefaults: { member: number; organization: number }): Promise<{ charge: WorkspaceCharge; limits: WorkspaceLimits }> {
  if (deps.requireRepositoriesConnected !== undefined) await deps.requireRepositoriesConnected(caller.orgId, definition);
  if (deps.cloud === true) {
    const trial = { documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now };
    await admitTrial(trial, caller.orgId);
    await admitMachineTime(trial, caller.orgId);
  }
  const limits = await readWorkspaceLimits(deps.documentClient, deps.tableName, caller.orgId, limitDefaults);
  const charge = developerCharge({ orgId: caller.orgId, teamId: deps.developer.slackTeamId, slackUserId: caller.slackUserId, developerId: caller.developerId });
  const full = await limitReached(deps.documentClient, deps.tableName, charge, limits);
  if (full !== undefined) throw agentXError("WORKSPACE_LIMIT", setupCheckLimitMessage(full, limits));
  return { charge, limits };
}

/**
 * The workspace a new check replaces is closed (its machine and volume deleted, its slot given back) before the new one is admitted, so the new
 * check does not count the old. Best effort: a close that cannot land now is left to the sweep, which closes any check older than 50 minutes.
 */
async function closeSupersededCheck(deps: DeveloperRouteDependencies, tasks: NonNullable<DeveloperRouteDependencies["tasks"]>, previous: { workspaceId: string; startedAt: string } | undefined): Promise<void> {
  if (previous === undefined) return;
  const started = Date.parse(previous.startedAt);
  try {
    await closeSetupCheck(deps.documentClient, deps.tableName, previous.workspaceId, {
      now: new Date(deps.now()), stalled: Number.isFinite(started) && deps.now() - started > STUCK_SETUP_MS, deleteCompute: (workspace) => tasks.deleteCompute(workspace as WorkspaceInstance),
    });
  } catch (error) {
    logDeveloperEvent({ event: "developer.setup_check_supersede_close_failed", workspaceId: previous.workspaceId, error: error instanceof Error ? error.name : "unknown" });
  }
}

const SETUP_CHECK_ATTEMPTS = 3;
const SETUP_CHECK_BUSY = "a setup check is already running for this project";

/**
 * `POST /v1/app/projects/{name}/setup-check` (Plan 2, Task 22): a maintainer of the project (an org owner or admin, or the project's own
 * maintainer; `setup_check` is theirs alone, so a viewer and a contributor are 403) has the project's setup and test commands run on a fresh
 * workspace of theirs at the latest revision. No access, no project and another org's project are the same 404. The role is read live.
 * A repeated request id answers the stored outcome (200, and starts nothing, even if the project has since been archived or locked); a new one
 * is 202. Refused: an archived project (PROJECT_ARCHIVED), a check already running (409 WORKSPACE_BUSY), a locked trial (TRIAL_LOCKED), used-up
 * machine time (MACHINE_TIME_EXCEEDED), a full workspace limit (WORKSPACE_LIMIT) and an unreachable repository.
 * The workspace, META's `setupCheck` and the request record are one transaction; a cancelled one is read again and judged afresh.
 */
async function startProjectSetupCheck(deps: DeveloperRouteDependencies, caller: DeveloperCaller, rawName: string, body: unknown): Promise<StatusReply> {
  const { name, role } = await projectRoleForRoute(deps, caller, rawName);
  if (!projectAllows(role, "setup_check")) throw agentXError("FORBIDDEN", "only a project maintainer can run a setup check");
  const parsed = ProjectSetupCheckBodySchema.safeParse(body);
  if (!parsed.success) throw bodyError(parsed.error);
  const tasks = deps.tasks;
  if (tasks === undefined) throw agentXError("NOT_FOUND", "setup checks are not set up in this deployment");
  const checks = setupCheckDepsOf(deps);
  const { requestId } = parsed.data;
  for (let attempt = 0; attempt < SETUP_CHECK_ATTEMPTS; attempt += 1) {
    // The replay comes before every admission: an id that was used answers what it started, whatever has changed since.
    if (await setupCheckReplay(checks, caller.orgId, name, requestId, caller.developerId) !== undefined) return new StatusReply(200, { project: await getAppProject(deps, caller, name) });
    await requireNewWorkAllowed(deps, caller.orgId, name, role, "setup_check");
    const project = await tasks.latestProject(caller.orgId, name);
    if (project === undefined) throw agentXError("PROJECT_NOT_FOUND", PROJECT_NOT_FOUND_IN_APP);
    const meta = await readProjectMeta(deps, caller.orgId, name);
    if ((await setupStateOf(checks, meta, project.definition)).status === "checking") throw agentXError("WORKSPACE_BUSY", SETUP_CHECK_BUSY);
    await closeSupersededCheck(deps, tasks, meta?.setupCheck);
    const { charge, limits } = await admitSetupCheck(deps, caller, project.definition, tasks.limitDefaults);
    // The workspace is the caller's own and fresh: an owner key of its own, derived from the caller (as a task's is), so the check never touches
    // a task's workspace or the caller's default one, and re-checking at a newer revision is a new workspace.
    const identity = developerTaskIdentity({ taskId: randomUUID(), developerId: caller.developerId, provider: caller.amr, developerName: caller.name, client: "Rovara app" }, caller.orgId);
    const preparation = await tasks.preparation(identity, project, requestId);
    const committed = await commitSetupCheck(checks, {
      orgId: caller.orgId, project: name, requestId, actorId: caller.developerId, revision: project.definition.revision,
      workspaceId: preparation.workspace.id, createdAt: preparation.workspace.createdAt, preparation: preparation.items, charge, limits, seenWorkspaceId: meta?.setupCheck?.workspaceId,
    });
    if (committed) {
      logDeveloperEvent({ event: "developer.project_setup_check_started", orgId: caller.orgId, project: name, workspaceId: preparation.workspace.id });
      return new StatusReply(202, { project: await getAppProject(deps, caller, name) });
    }
  }
  throw agentXError("WORKSPACE_BUSY", "AgentX could not start the setup check just now; try again with the same request id");
}

/** What the setup-draft routes (Plan 6 Task 10) need, from the developer API's dependencies and for one caller. */
function setupDraftDepsOf(deps: DeveloperRouteDependencies): SetupDraftDependencies {
  return {
    documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now,
    starter: agentRunStarterOf(deps),
    projectFor: (who, rawName) => projectRoleForRoute(deps, who, rawName),
    requireNewWork: (who, project, role) => requireNewWorkAllowed(deps, who.orgId, project, role, "task"),
    latest: async (orgId, project) => {
      const latest = await latestRevision({ documentClient: deps.documentClient, tableName: deps.tableName }, orgId, project);
      return latest === undefined ? undefined : { revision: latest.definition.revision, allowedDomains: latest.definition.network?.allowedDomains ?? [] };
    },
    updateSettings: (who, project, body) => putProjectSettings(deps, who, encodeURIComponent(project), body),
    startSetupCheck: async (who, project, requestId) => { await startProjectSetupCheck(deps, who, encodeURIComponent(project), { requestId }); },
    startPullRequest: async (who, request) => {
      const started = await startCodeIntent(codeIntentDependenciesOf(deps, who), who, { requestId: request.requestId, project: request.project, input: { text: request.text }, path: "QUICK", source: "app" });
      const taskId = (started.task as { taskId: string }).taskId;
      return { taskId, ...(started.sessionId === undefined ? {} : { sessionId: started.sessionId }), ...(started.sessionUrl === undefined ? {} : { sessionUrl: started.sessionUrl }) };
    },
    readProject: (who, project) => getAppProject(deps, who, project),
  };
}

/**
 * What reads and writes a project's people: the table, a developer's sign-in record (for `mergedInto`), and the two ways a Slack channel
 * gives access (a project the person reaches, and whether one project's channel gives it to them). Slack failing closes the channel route
 * only; the person's grants and org role still answer.
 */
function projectMembersDepsOf(deps: DeveloperRouteDependencies): ProjectMembersDependencies {
  const store = signInStoreOf(deps);
  const slackUserOf = async (developerId: string) => (await store.getDeveloper(developerId))?.slackUserId;
  return {
    documentClient: deps.documentClient,
    tableName: deps.tableName,
    developerRecord: (developerId) => store.getDeveloper(developerId),
    channelAccess: async (orgId, project, developerId) => {
      const slackUserId = await slackUserOf(developerId);
      if (slackUserId === undefined) return false;
      const known = (await projectsWithPolicy(deps, orgId, [project])).get(project);
      if (known === undefined || !known.policy.channelMembersMayUse) return false;
      const bindings = (await bindingsOf(deps, orgId)).filter((binding) => binding.projectName === project);
      if (bindings.length === 0) return false;
      const access = await resolveDeveloperAccess({ grants: [], bindings, slackUserId, channelMembersMayUse: () => true, channelMembers: safeChannelMembers(deps) });
      return access.projects.get(project)?.access === "channel";
    },
    channelProjects: async (orgId, developerId) => {
      const slackUserId = await slackUserOf(developerId);
      if (slackUserId === undefined) return [];
      const bindings = await bindingsOf(deps, orgId);
      const policies = await projectsWithPolicy(deps, orgId, bindings.map((binding) => binding.projectName));
      const access = await resolveDeveloperAccess({
        grants: [], bindings, slackUserId, channelMembersMayUse: (project) => policies.get(project)?.policy.channelMembersMayUse === true, channelMembers: safeChannelMembers(deps),
      });
      return [...access.projects].filter(([name, entry]) => entry.access === "channel" && policies.has(name)).map(([name]) => name);
    },
  };
}

/** Who has which role in a project (Plan 2, Task 21): the injected `projectMembers` when there is one, else built from these dependencies. */
export function projectMembersOf(deps: DeveloperRouteDependencies): ProjectMembers {
  return deps.projectMembers ?? createProjectMembers(projectMembersDepsOf(deps));
}

/** The caller's role in a project named in a route's path, or the same 404 PROJECT_NOT_FOUND as no access and no such project (never 403). */
async function projectRoleForRoute(deps: DeveloperRouteDependencies, caller: DeveloperCaller, rawName: string): Promise<{ name: string; role: ProjectRole }> {
  const notFound = () => agentXError("PROJECT_NOT_FOUND", PROJECT_NOT_FOUND_IN_APP);
  let name: string;
  try { name = decodeURIComponent(rawName); } catch { throw notFound(); }
  if (!AgentXNameSchema.safeParse(name).success) throw notFound();
  const role = (await visibleProjectRoles(deps, caller, name)).get(name);
  if (role === undefined || await latestDefinition(deps, caller.orgId, name) === undefined) throw notFound();
  return { name, role };
}

const ROLE_ORDER: Record<ProjectRole, number> = { maintainer: 0, contributor: 1, viewer: 2 };

/**
 * `GET /v1/app/projects/{name}/members`: everyone with a role in the project and where it comes from, for anyone who can see the project.
 * Org owners and admins are listed as maintainers by their org role (`org_role`), once, whatever grants they also hold.
 */
async function getProjectMembers(deps: DeveloperRouteDependencies, caller: DeveloperCaller, rawName: string): Promise<ProjectMembersResponse> {
  const { name } = await projectRoleForRoute(deps, caller, rawName);
  const merge = projectMembersDepsOf(deps);
  // Who added a person is shown as the developer they have since been merged into, if any.
  const rows = (await listProjectMembers(merge, caller.orgId, name)).map(async (row) => (row.grantedBy !== undefined && "developerId" in row.grantedBy
    ? { ...row, grantedBy: { developerId: await survivorOf(merge, row.grantedBy.developerId) } } : row));
  return buildProjectMembersResponse(deps, await Promise.all(rows), isOrgAdmin(caller));
}

/** Whether the caller is an owner or admin of the org: the people who may see other people's emails, join dates and sign-in methods (release 0.4.16, owner decision "option A"). */
const isOrgAdmin = (caller: Pick<DeveloperCaller, "orgRole">): boolean => caller.orgRole === "owner" || caller.orgRole === "admin";

/** The project's people. Names are email-safe for everyone; an email is shown to an owner or admin only (`showEmails`). */
async function buildProjectMembersResponse(deps: DeveloperRouteDependencies, rows: Awaited<ReturnType<typeof listProjectMembers>>, showEmails: boolean): Promise<ProjectMembersResponse> {
  const store = signInStoreOf(deps);
  const cards = new Map<string, { name: string; email?: string }>();
  const ids = [...new Set(rows.flatMap((row) => [row.developerId, ...(row.grantedBy !== undefined && "developerId" in row.grantedBy ? [row.grantedBy.developerId] : [])]))];
  const records = await store.getDevelopers(ids);
  await mapLimit(ids, REVISION_READS_AT_ONCE, async (id) => {
    const record = records.get(id);
    const identities = await store.identitiesOf(id);
    const email = showEmails ? record?.email ?? identities.find((identity) => identity.email !== undefined)?.email : undefined;
    cards.set(id, { name: record?.displayName ?? "Unknown", ...(email === undefined ? {} : { email }) });
  });
  const members: ProjectMember[] = rows.map((row) => {
    const card = cards.get(row.developerId)!;
    const by = row.grantedBy;
    return {
      developerId: row.developerId, name: card.name, ...(card.email === undefined ? {} : { email: card.email }), role: row.role, source: row.source,
      // The operator console's grants have no person to name.
      ...(row.source !== "grant" || by === undefined || !("developerId" in by) ? {} : { grantedBy: { developerId: by.developerId, name: cards.get(by.developerId)?.name ?? "Unknown" } }),
    };
  });
  members.sort((left, right) => ROLE_ORDER[left.role] - ROLE_ORDER[right.role] || left.name.localeCompare(right.name) || left.developerId.localeCompare(right.developerId));
  return { members };
}

/** Tells the agents platform a person's project role changed; what it fails with is logged, never raised (the change stands). */
async function notifyProjectMemberChanged(deps: DeveloperRouteDependencies, orgId: OrgId, project: string, developerId: string): Promise<void> {
  if (deps.projectMemberChanged === undefined) return;
  try {
    await deps.projectMemberChanged(orgId, project, developerId);
  } catch (error) {
    logDeveloperEvent({ event: "developer.project_member_hook_failed", orgId, project, error: error instanceof Error ? error.name : "unknown" });
  }
}

const MANAGE_MEMBERS_MESSAGE = "only a project maintainer can change who is in a project";

/**
 * `PUT /v1/app/projects/{name}/members/{developerId}`: a maintainer of the project (or an org owner or admin) gives a member of the org a role
 * in it. A contributor or viewer is refused (403), so nobody can grant themselves or another a higher role. The person must be in the caller's
 * org; an owner or admin takes no role. A replay of the request id answers the stored outcome.
 */
async function putProjectMember(deps: DeveloperRouteDependencies, caller: DeveloperCaller, rawName: string, developerId: string, body: unknown): Promise<ProjectMemberChangeResponse> {
  const { name, role } = await projectRoleForRoute(deps, caller, rawName);
  if (!projectAllows(role, "manage_members")) throw agentXError("FORBIDDEN", MANAGE_MEMBERS_MESSAGE);
  const parsed = PutProjectMemberBodySchema.safeParse(body);
  if (!parsed.success) throw bodyError(parsed.error);
  const member = await setProjectMember({ ...projectMembersDepsOf(deps), now: () => new Date(deps.now()), ...(deps.audit === undefined ? {} : { audit: deps.audit }) }, caller.orgId, name, {
    requestId: parsed.data.requestId, developerId, role: parsed.data.role, actor: { developerId: caller.developerId },
  });
  logDeveloperEvent({ event: "developer.project_member_set", orgId: caller.orgId, project: name, role: member.role });
  await notifyProjectMemberChanged(deps, caller.orgId, name, member.developerId);
  return { member };
}

/** `DELETE /v1/app/projects/{name}/members/{developerId}`: the same people may take a person's grant away. `removed` is false when they had none. */
async function deleteProjectMember(deps: DeveloperRouteDependencies, caller: DeveloperCaller, rawName: string, developerId: string, body: unknown): Promise<ProjectMemberRemoveResponse> {
  const { name, role } = await projectRoleForRoute(deps, caller, rawName);
  if (!projectAllows(role, "manage_members")) throw agentXError("FORBIDDEN", MANAGE_MEMBERS_MESSAGE);
  const parsed = RemoveProjectMemberBodySchema.safeParse(body);
  if (!parsed.success) throw bodyError(parsed.error);
  const removed = await removeProjectMember({ ...projectMembersDepsOf(deps), now: () => new Date(deps.now()), ...(deps.audit === undefined ? {} : { audit: deps.audit }) }, caller.orgId, name, {
    requestId: parsed.data.requestId, developerId, actor: { developerId: caller.developerId },
  });
  logDeveloperEvent({ event: "developer.project_member_removed", orgId: caller.orgId, project: name, removed: String(removed.removed) });
  await notifyProjectMemberChanged(deps, caller.orgId, name, removed.developerId);
  return removed;
}

const SLACK_BIND_ROLE_MESSAGE = "only an organization owner or admin can bind a Slack channel to a project";

/**
 * `PUT /v1/app/projects/{name}/slack-channel` (release 0.4.17): an org owner or admin binds a Slack channel of the org's Slack workspace to a
 * project of the org, with the developer sign-in. Owner or admin only, read live from the membership on every call: the operator's bind needs the
 * project's `administrator` membership, which a project's own maintainer does not hold, so a project maintainer who is only an org member is 403.
 * No access to the project is the usual 404. The team and channel checks, the replay and the audit are `bindProjectChannel`'s.
 */
async function putProjectSlackChannel(deps: DeveloperRouteDependencies, caller: DeveloperCaller, rawName: string): Promise<ProjectSlackChannelResponse> {
  await projectRoleForRoute(deps, caller, rawName);
  if (caller.orgRole !== "owner" && caller.orgRole !== "admin") throw agentXError("FORBIDDEN", SLACK_BIND_ROLE_MESSAGE);
  throw agentXError("FORBIDDEN", "Use the browser Slack approval flow to link a channel.");
}

/** `DELETE /v1/app/projects/{name}/slack-channel`: the same people unbind one of the project's channels. `removed` is false when it was not bound. */
async function deleteProjectSlackChannel(deps: DeveloperRouteDependencies, caller: DeveloperCaller, rawName: string, body: unknown): Promise<ProjectSlackChannelRemoveResponse> {
  const { name } = await projectRoleForRoute(deps, caller, rawName);
  if (caller.orgRole !== "owner" && caller.orgRole !== "admin") throw agentXError("FORBIDDEN", SLACK_BIND_ROLE_MESSAGE);
  const parsed = RemoveProjectSlackChannelBodySchema.safeParse(body);
  if (!parsed.success) throw bodyError(parsed.error);
  const result = await unbindProjectChannel(slackChannelDepsOf(deps), caller.orgId, name, { ...parsed.data, actor: { developerId: caller.developerId } });
  if (result.removed) logDeveloperEvent({ event: "developer.slack_channel_unbound", orgId: caller.orgId, project: name });
  return result;
}

/** What a bind writes and reads. A Rovara Cloud install gives an org no claim on the installation's own Slack team: its orgs connect their own. */
function slackChannelDepsOf(deps: DeveloperRouteDependencies): ProjectSlackChannelDependencies {
  if (deps.orgs === undefined) throw agentXError("NOT_FOUND", "organizations are not set up in this deployment");
  return {
    documentClient: deps.documentClient, tableName: deps.tableName, now: () => new Date(deps.now()), orgs: deps.orgs,
    ...(deps.audit === undefined ? {} : { audit: deps.audit }),
    ...(deps.cloud === true || deps.developer.slackTeamId === undefined ? {} : { installSlackTeamId: deps.developer.slackTeamId }),
  };
}

/**
 * `GET /v1/app/github/repositories?installation=<id>` (Plan 2, Task 15): the repositories one of the org's installations reaches, each marked with
 * the project of the caller's that already uses it. An installation that is not the org's answers NOT_FOUND, as a missing one does.
 */
async function listGithubRepositories(deps: DeveloperRouteDependencies, caller: DeveloperCaller, installation: string | null): Promise<{ repositories: Array<{ fullName: string; githubRepositoryId: number; private: boolean; defaultBranch: string; project?: string }> }> {
  if (deps.githubConnect === undefined) throw agentXError("NOT_FOUND", "connecting GitHub is not set up in this deployment");
  if (installation === null || !/^[1-9][0-9]{0,14}$/.test(installation)) throw agentXError("CONFIG_INVALID", "installation: give the installation's id, from agentx github list");
  const { repositories } = await deps.githubConnect.listRepositories(caller, Number(installation));
  // Only the caller's own visible projects are named: another project's name is not theirs to learn.
  const roles = await visibleProjectRoles(deps, caller);
  const projectOf = new Map<string, string>();
  for (const name of [...roles.keys()].sort()) {
    const record = await latestProjectRecord(deps, caller.orgId, name);
    for (const repository of record?.definition.repositories ?? []) {
      const key = repositoryFullName(repository).toLowerCase();
      if (!projectOf.has(key)) projectOf.set(key, name);
    }
  }
  return { repositories: repositories.map((repository) => {
    const project = projectOf.get(repository.fullName.toLowerCase());
    return { ...repository, ...(project === undefined ? {} : { project }) };
  }) };
}

/** `PUT /v1/app/projects/{name}/settings` (Plan 2, Task 17): a maintainer's change to the project's settings, as a new revision. */
async function putProjectSettings(deps: DeveloperRouteDependencies, caller: DeveloperCaller, rawName: string, body: unknown): Promise<{ project: AppProjectDetail; warnings: string[] }> {
  const notFound = () => agentXError("PROJECT_NOT_FOUND", PROJECT_NOT_FOUND_IN_APP);
  let name: string;
  try { name = decodeURIComponent(rawName); } catch { throw notFound(); }
  if (!AgentXNameSchema.safeParse(name).success) throw notFound();
  if (deps.projectSettings === undefined) throw agentXError("NOT_FOUND", "project settings are not set up in this deployment");
  return updateProjectSettings({
    documentClient: deps.documentClient,
    tableName: deps.tableName,
    cloud: deps.cloud === true,
    egress: egressDepsOf(deps),
    ...deps.projectSettings,
    allowedDomainAuthorityConditions: (who, project) => readAllowedDomainActorConditions({ documentClient: deps.documentClient, tableName: deps.tableName, signInTableName: deps.developer?.signInTableName ?? "", now: deps.now }, { orgId: who.orgId, project, actorId: who.developerId }),
    effectiveRole: async (who, project) => (await visibleProjectRoles(deps, who, project)).get(project),
    readProject: (who, project) => getAppProject(deps, who, project),
  }, caller, name, body);
}

/**
 * FR-018's first three checks, in order, for one project; the start route calls it (Task 8), and
 * every route must call it before a DeveloperTaskActions member that trusts its caller.
 * PROJECT_NOT_FOUND, then PROJECT_ACCESS_DENIED (naming only public bound channels, R10), or
 * SLACK_UNAVAILABLE when only a channel could have given access and Slack is down, then
 * PROJECT_TASKS_DISABLED.
 */
export async function checkProjectAccess(
  deps: DeveloperRouteDependencies,
  caller: ProjectAccessCaller,
  project: string,
  membership?: { freshMemberOf: readonly string[] },
): Promise<{ revision: number; policy: DeveloperTaskPolicy; access: "granted" | "channel"; channelIds: string[]; role: ProjectRole }> {
  // A name that is not a project name is never echoed back: it could be long or carry markup.
  if (!AgentXNameSchema.safeParse(project).success) throw agentXError("PROJECT_NOT_FOUND", "that is not a valid AgentX project name");
  const known = (await projectsWithPolicy(deps, caller.orgId, [project])).get(project);
  if (known === undefined) throw agentXError("PROJECT_NOT_FOUND", `project \`${project}\` doesn't exist in this AgentX`);
  const grant = (await grantRowsOf(deps, caller)).find((row) => row.projectName === project)?.grant;
  const bindings = (await bindingsOf(deps, caller.orgId)).filter((binding) => binding.projectName === project);
  // An org owner or admin counts as granted on every project in their org, with no grant (Plan 2, Task 11, I4). A project of another org
  // is never reached: `known` and every row read above are this org's.
  const orgMaintainer = caller.orgRole === "owner" || caller.orgRole === "admin";
  // Any grant counts as granted here, a viewer's too: what the role may do is decided by the effective role, below and at the places new work starts.
  const projectMemberships = grant !== undefined || orgMaintainer ? [{ projectName: project, role: "developer" }] : [];
  const evaluate = (freshMemberOf?: readonly string[]) => evaluateProjectAuthority({
    project,
    revision: { revision: known.revision, definition: { developerTasks: known.policy } },
    memberships: projectMemberships,
    bindings,
    ...(freshMemberOf === undefined ? {} : { freshMemberOf }),
    ...(caller.slackUserId === undefined ? {} : { slackUserId: caller.slackUserId }),
  });
  let result = evaluate(membership?.freshMemberOf);
  if (result.kind === "needs-membership") {
    const memberOf = new Set<string>();
    for (let start = 0; start < result.channelIds.length; start += CHANNEL_MEMBERS_MAX_CHANNELS) {
      const response = await safeChannelMembers(deps)({
        kind: "channel-members", slackUserId: caller.slackUserId!, channelIds: result.channelIds.slice(start, start + CHANNEL_MEMBERS_MAX_CHANNELS),
      });
      if (!response.ok) throw agentXError("SLACK_UNAVAILABLE", "Slack could not be reached to check your channel membership; try again, or ask an admin for access");
      for (const channelId of response.memberOf) memberOf.add(channelId);
    }
    result = evaluate([...memberOf]);
  }
  if (result.kind === "unavailable") throw agentXError("SLACK_UNAVAILABLE", "Slack could not be reached to check your channel membership; try again, or ask an admin for access");
  if (result.kind === "not-found") throw agentXError("PROJECT_NOT_FOUND", `project \`${project}\` doesn't exist in this AgentX`);
  if (result.kind === "needs-membership") throw agentXError("SLACK_UNAVAILABLE", "Slack could not be reached to check your channel membership; try again, or ask an admin for access");
  if (result.kind === "denied") {
    if (result.reason === "tasks-disabled") throw agentXError("PROJECT_TASKS_DISABLED", `tasks from AI tools are turned off for \`${project}\`; use the project's Slack channel, or ask an admin`);
    // Only a channel that would give access is worth naming, and only a public one (R10).
    const visible = caller.slackUserId === undefined || !known.policy.channelMembersMayUse
      ? []
      : [...(await channelNames(deps, result.visibleChannelIds)).values()].filter((channel) => !channel.isPrivate).map((channel) => channel.name).sort();
    throw agentXError("PROJECT_ACCESS_DENIED", accessDeniedMessage(project, visible));
  }
  // This function never refuses an archived project or a viewer: those refusals are requireNewWorkAllowed's, at the places new work
  // starts, because the E2E rechecks of a running task's creator also come through here.
  const role = effectiveProjectRole(caller, grant, result.access === "channel");
  if (role === undefined) throw agentXError("PROJECT_ACCESS_DENIED", accessDeniedMessage(project, []));
  return { revision: result.revision, policy: result.policy, access: result.access, channelIds: result.channelIds, role };
}

/**
 * Spec 041 FR-002: a project's workspaces, newest first, from the sparse byWorkspaceProject index.
 * Only a workspace's own fields are read; the index carries the whole item, so no second get is
 * needed per workspace.
 */
async function projectWorkspaces(deps: DeveloperRouteDependencies, orgId: OrgId, project: string): Promise<DeveloperWorkspace[]> {
  const items: Array<Record<string, unknown>> = [];
  let start: Record<string, unknown> | undefined;
  do {
    const response = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName,
      IndexName: WORKSPACE_PROJECT_INDEX.name,
      KeyConditionExpression: "#project = :project",
      ExpressionAttributeNames: { "#project": WORKSPACE_PROJECT_INDEX.partitionKey },
      ExpressionAttributeValues: { ":project": workspaceProjectIndexValue(orgId, project) },
      // Newest first, and never more than one page past the cap: a project with thousands of
      // thread workspaces must not turn one page load into an unbounded scan.
      ScanIndexForward: false,
      Limit: DEVELOPER_WORKSPACES_PER_PROJECT,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    items.push(...(response.Items ?? []));
    start = items.length >= DEVELOPER_WORKSPACES_PER_PROJECT ? undefined : response.LastEvaluatedKey;
  } while (start !== undefined);

  const workspaces: DeveloperWorkspace[] = [];
  for (const item of items.slice(0, DEVELOPER_WORKSPACES_PER_PROJECT)) {
    const parsed = WorkspaceInstanceSchema.safeParse(workspaceRecordFields(item));
    // A record this release cannot read is left out rather than failing the whole listing.
    if (!parsed.success) {
      logDeveloperEvent({ event: "developer.workspace_unreadable", project, reason: parsed.error.issues[0]?.message ?? "invalid" });
      continue;
    }
    const workspace = parsed.data;
    workspaces.push({
      id: workspace.id,
      projectName: workspace.projectName,
      projectRevision: workspace.projectRevision,
      status: workspace.status,
      busy: workspace.activeOperationId !== null,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    });
  }
  return workspaces;
}

/**
 * FR-001: the projects the caller may use, with the workspaces in each of them. The projects come
 * from listProjects itself, so this route applies exactly the same access rules (grants, and channel
 * membership only where the project's developerTasks policy allows it, failing closed).
 */
async function listWorkspaces(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<DeveloperWorkspacesResponse> {
  const listing = await listProjects(deps, caller);
  const workspaces: DeveloperWorkspace[] = [];
  for (const project of listing.projects) workspaces.push(...await projectWorkspaces(deps, caller.orgId, project.name));
  // Across projects, still newest first, so the page's list reads as one timeline.
  workspaces.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return { ...listing, workspaces };
}

/**
 * Plan 3, Task 15: what `startAgentRun` needs from the developer API: the person a run acts as (their sign-in record and org membership now),
 * and the task start for that person. Undefined where agents are not set up.
 */
export function agentRunStarterOf(deps: DeveloperRouteDependencies): AgentRunStarter | undefined {
  if (deps.agents === undefined) return undefined;
  return {
    ...deps.agents,
    callerFor: async (orgId, developerId) => {
      const [developer, chosenName] = await Promise.all([
        getSignIn<Pick<DeveloperRecord, "provider" | "displayName" | "slackUserId" | "email" | "revoked">>(deps, `DEVELOPER#${developerId}`),
        readChosenName(deps.documentClient, deps.tableName, developerId),
      ]);
      const membership = await deps.orgs?.orgForDeveloper(developerId);
      if (developer === undefined || developer.revoked || membership === undefined || membership.orgId !== orgId) return undefined;
      return {
        developerId, sessionId: "agent-run", amr: developer.provider, name: chosenName ?? safeDisplayName(developer.displayName, developerId), orgId, orgRole: membership.role,
        ...(developer.slackUserId === undefined ? {} : { slackUserId: developer.slackUserId }),
        ...(developer.email === undefined ? {} : { email: developer.email }),
      };
    },
    startTask: async (caller, body, run) => {
      // Plan 6 Task 3: a Rovara Code intent from a Slack thread is started shared to that thread, as the Slack workflow always was.
      const binding = run.codeIntent?.binding;
      const thread = binding?.kind === "slack_thread" ? { teamId: binding.teamId, channelId: binding.channelId, threadTs: binding.threadTs } : undefined;
      const answer = await startTask(developerTaskRouteDependencies(deps, caller, thread), caller, body, run);
      if (answer.run === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the run did not report its limits");
      // Plan 3, Task 32 (PF17): a run started with a run limit of 0 waits for its limit: the run_limit request asks for it. The start stands either way; a
      // request that can't be made now is asked for again by the next pause, or by a repeat of the start (the request is once per task).
      if (answer.run.paused && deps.agents !== undefined) {
        await requestForPausedTask(deps.agents, answer.task.taskId).catch((error: unknown) => {
          logDeveloperEvent({ event: "spend_request.not_asked", error: errorName(error) });
        });
      }
      return { task: answer.task, run: answer.run };
    },
    // Plan 4 Task 9: a chain stops a step's task through the owner's own cancel (the same path as their cancel button), so the workspace, the keys and the end are Plan 3's.
    cancelTask: async (caller, taskId, requestId) => {
      try {
        await cancelTask(developerTaskRouteDependencies(deps, caller), caller, taskId, { requestId });
      } catch (error) {
        // A task that was closed is over: there is nothing left to stop.
        if (error instanceof AgentXError && error.message.endsWith(CLOSED_TASK)) return;
        throw error;
      }
    },
  };
}

/**
 * Plan 6 Task 3: what `startCodeIntent` needs for one caller, from the developer API's dependencies: Plan 3's run start where agents are set up, the plain task start where they are
 * not, the person's own task view, and the origin session links are made from. The routes and the broker's Slack start and `createCodeIntentStarter` all build it here.
 */
export function codeIntentDependenciesOf(deps: DeveloperRouteDependencies, caller: DeveloperCaller): CodeIntentRouteDependencies {
  const taskDeps = developerTaskRouteDependencies(deps, caller);
  return {
    starter: agentRunStarterOf(deps),
    startPlainTask: (who, body, thread) => startTask(developerTaskRouteDependencies(deps, who, thread), who, body),
    ownedTask: async (who, taskId) => taskView(taskDeps, await loadOwnedTask(taskDeps, who, taskId), { events: 0, details: false }),
    projectProcess: (orgId, project) => projectProcessOf({ documentClient: deps.documentClient, tableName: deps.tableName, store: deps.agents?.store }, orgId, project),
    origin: new URL(deps.developer.issuer).origin,
    visibleProject: async (who, rawName) => (await projectRoleForRoute(deps, who, rawName)).name,
    // A follow-up may follow only a task of the caller's own org, whose session they can see, that ended Answered (read now, never trusted from the request).
    retryable: async (who, taskId) => {
      const sessions = sessionDependenciesOf(deps);
      if (sessions === undefined) return false;
      const item = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: { pk: `DEVTASK#${taskId}`, sk: "META" }, ConsistentRead: true }))) as { Item?: DeveloperTaskRecord };
      const task = item.Item;
      if (task === undefined || task.orgId !== who.orgId || task.sessionId === undefined || task.workflow === undefined || workflowAnswer(task.workflow) === undefined) return false;
      // Seen by the caller now (a person who cannot see the session reads it as missing): any refusal is a plain "no".
      try {
        await requireSessionLevel(sessions, who, task.sessionId, "view", "follow it up");
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * The start of an agent at a published version through `POST /v1/dev/tasks` (the CLI's and the AI tools' start): the same gate as the app route's. Only a plain
 * start is gated (no sharing or workflow options, which a run started after approval would not carry); any other start of a less safe older version is refused
 * by the start itself. Undefined when the start goes on as it is.
 */
async function gateDeveloperStart(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest): Promise<StatusReply | undefined> {
  if (deps.agents === undefined) return undefined;
  let value: unknown;
  try { value = request.body === undefined || request.body === "" ? undefined : JSON.parse(request.body) as unknown; } catch { return undefined; }
  const parsed = StartDeveloperTaskRequestSchema.safeParse(value);
  if (!parsed.success || parsed.data.agent === undefined || typeof parsed.data.agent.version !== "number") return undefined;
  const start = parsed.data;
  if (start.shareToChannel !== undefined || start.shareMode !== undefined || start.channel !== undefined || start.workflow !== undefined || start.workflowPath !== undefined) return undefined;
  // R8 first: a retry of a start already made is answered with the first task whatever the agent's versions are now, so it is never held for the owner or refused.
  if (await startAlreadyMade(developerTaskRouteDependencies(deps, caller), caller, start.requestId)) return undefined;
  const waiting = await gateRunVersion(deps.agents, caller, {
    requestId: start.requestId, project: start.project, agent: { agentId: start.agent!.agentId, version: start.agent!.version! }, input: start.input ?? { text: start.instructions }, origin: "cli",
  });
  return waiting === undefined ? undefined : new StatusReply(202, { status: NEEDS_OWNER_APPROVAL, confirmUrl: waiting.confirmUrl, changes: waiting.changes });
}

/** The app route that starts a run (`POST /v1/app/agents/{id}/runs`): the person's own request, from their own session, through the run start. */
async function startAppRun(
  deps: DeveloperRouteDependencies,
  caller: DeveloperCaller,
  input: { requestId: string; project: string; agent: { agentId: AgentId; version?: number | "draft" }; input: RunInput },
): Promise<{ task: DeveloperTaskView }> {
  const starter = agentRunStarterOf(deps);
  if (starter === undefined) throw agentXError("NOT_FOUND", "agents are not set up in this deployment");
  const started = await startAgentRun(starter, {
    requestId: input.requestId, orgId: caller.orgId, project: input.project, agent: input.agent, input: input.input, origin: "app",
    owner: { developerId: caller.developerId }, startedBy: { developerId: caller.developerId }, caller,
  });
  const taskDeps = developerTaskRouteDependencies(deps, caller);
  return { task: await taskView(taskDeps, await loadOwnedTask(taskDeps, caller, started.taskId), { events: 0, details: false }) };
}

/**
 * Plan 4's chain dependencies for one caller: the agent routes' own, the chain store, the run view's ports (built over the task layer for this caller, so the task's own rules apply
 * inside a run's view) and, where Plan 3's run start is held, the runner's ports. The chain routes and the chain reads of a session are made from this, once per request: a chain read
 * is bound to the org of the request, never to one fixed when the broker was built. Undefined where chains are not set up.
 */
function chainRouteDependenciesFor(deps: DeveloperRouteDependencies, caller: DeveloperCaller): (ChainRouteDependencies & { chainRuns?: ChainRunPorts }) | undefined {
  if (deps.agents?.chains === undefined) return undefined;
  // The chain runner starts each step through Plan 3's run start, which this API holds (the task start); a test may bring its own.
  const starter = deps.agents.chainRuns === undefined ? agentRunStarterOf(deps) : undefined;
  const admission = deps.modelAccess === undefined ? undefined : { documentClient: deps.documentClient, tableName: deps.tableName, access: deps.modelAccess, now: deps.now, cloud: deps.cloud === true };
  const agentDeps = deps.agents;
  const chainView = agentDeps.chainView ?? chainViewPortsFor({
    approvals: agentDeps, keySpend: deps.modelAccess === undefined ? undefined : (keyIds) => deps.modelAccess!.keySpend(keyIds),
    taskView: (task) => taskView(developerTaskRouteDependencies(deps, caller), task, { events: 20, details: true, actor: "viewer" }),
  });
  return { ...agentDeps, chains: deps.agents.chains, chainView, ...(starter === undefined ? {} : { chainRuns: chainRunPortsFor(starter, admission) }) };
}

/** What session levels and reads need, from the route dependencies: the broker's own, or those it gave the agent routes. */
function sessionDependenciesOf(deps: DeveloperRouteDependencies): SessionTakeOverDependencies | undefined {
  return deps.agentSessions ?? deps.agents?.agentSessions;
}

/** The session routes' dependencies for one caller: the task view is built with that caller's task dependencies, so the task's own rules apply inside the session. */
function sessionReadDependencies(deps: DeveloperRouteDependencies, caller: DeveloperCaller): SessionRouteDependencies {
  const sessions = sessionDependenciesOf(deps), tasks = deps.tasks;
  if (sessions === undefined || tasks === undefined) throw agentXError("NOT_FOUND", "sessions are not set up in this deployment");
  const taskDeps = developerTaskRouteDependencies(deps, caller);
  const mint = deps.developer.realtimeToken;
  // Plan 4's chain reads, messages, stop and retry, made for this request: the reads need the org of the person asking, which the broker doesn't have when it is built.
  const chainDeps = chainRouteDependenciesFor(deps, caller);
  return {
    ...sessions, origin: new URL(deps.developer.issuer).origin,
    ...(deps.handoff === undefined ? {} : { handoff: deps.handoff }),
    ...(deps.sessionDiffFiles === undefined ? {} : { diff: {
      files: deps.sessionDiffFiles,
      pullRequests: workspaceId => taskDeps.actions.pullRequests(workspaceId),
      repository: async (orgId, project, revision, repository) => {
        const registered = await tasks.projectRevision(orgId, project, revision);
        return registered?.definition.repositories.find(item => item.name === repository)?.url;
      },
    } satisfies NonNullable<SessionRouteDependencies["diff"]> }),
    ...(taskDeps.actions.turnRecordsTableName === undefined ? {} : { turnRecordsTableName: taskDeps.actions.turnRecordsTableName }),
    ...(chainDeps === undefined ? {} : {
      chain: chainSessionReads(chainDeps, caller.orgId),
      chainSteer: chainSteerReadsFor(chainDeps),
      ...(chainDeps.chainRuns === undefined ? {} : { chainControl: chainControlFor(chainDeps as ChainRunnerDependencies) }),
    }),
    // Plan 5 Task 13: Plan 3's cancel, workflow retry and run start, bound to this person. They are called only after the session routes read the person's level on the session.
    control: {
      cancelTask: async (task, requestId) => { await cancelTaskFor(taskDeps, task, { requestId, actor: { kind: "session", caller } }); },
      retryWorkflow: async (task, requestId) => { await retryTaskWorkflowFor(taskDeps, task, { requestId, actor: { kind: "session", caller } }); },
      // Plan 6 Task 5: Understand starts again as soon as people answered. A failed start is the answer's dispatch row's to redo, so it is logged by name and not raised.
      startUnderstanding: async (task, workflowRevision) => {
        try {
          await startTaskWorkflowUnderstandFromSystem(taskDeps, task.taskId, { workflowRevision });
        } catch (error) {
          console.log(JSON.stringify({ component: "broker", event: "rovara_code.understand_start_deferred", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" }));
        }
      },
      // Plan 6 Task 20: the open pull request's Fixes line follows a link, an unlink or a replace of the session's Linear issue at once.
      ...(taskDeps.actions.rewriteLinearCloseLine === undefined ? {} : { rewritePullRequestLinearLine: (task: DeveloperTaskRecord, key: string | undefined) => taskDeps.actions.rewriteLinearCloseLine!(task, key) }),
      startAgentRun: async (request) => {
        const starter = agentRunStarterOf(deps);
        if (starter === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "starting runs is not set up in this deployment");
        return startAgentRun(starter, { ...request, caller });
      },
      // Plan 6 Task 6: the "make a change anyway" start, as the caller (they pay), through the one entry point.
      startCodeIntent: (request) => startCodeIntent(codeIntentDependenciesOf(deps, caller), caller, request),
    },
    ...(deps.audit === undefined ? {} : { audit: deps.audit }),
    taskView: (task, options) => taskView(taskDeps, task, options),
    ...(deps.agents === undefined ? {} : { approvals: deps.agents }),
    // Plan 5 Task 16: the project's card, read after the page has checked the person's role in the project.
    projectPage: async (who, name) => {
      const [record, meta] = await Promise.all([latestProjectRecord(deps, who.orgId, name), readProjectMeta(deps, who.orgId, name)]);
      if (record === undefined) return undefined;
      const summary = await appProjectSummary(deps, name, "viewer", record, meta);
      const channels = (await bindingsOf(deps, who.orgId, "project_page.bindings_truncated")).filter((binding) => binding.projectName === name).map((binding) => binding.channelId);
      return {
        name, ...(summary.description === undefined ? {} : { description: summary.description }), status: summary.status, latestRevision: summary.latestRevision, repositories: summary.repositories,
        setup: summary.setup, channels: [...new Set(channels)].slice(0, 20),
      };
    },
    // Plan 5 Task 9: a person arriving on a session is told to its channel through the same API the sink publishes to.
    realtimePublish: realtimeConfigFromEnvironment(),
    // Plan 5 Task 8: the realtime token. Without the sign-in function's signing, or without an events API, the route says live updates are unavailable.
    realtime: {
      endpoint: deps.developer.realtimeEndpoint,
      projectsOf: async (caller) => (await projectMembersOf(deps).projectsOf(caller.orgId, { developerId: caller.developerId, orgRole: caller.orgRole })).map((entry) => entry.project),
      mint: async (request) => {
        const answer = mint === undefined ? undefined : await mint(request);
        if (answer === undefined || !answer.ok) throw agentXError("RUNTIME_UNAVAILABLE", "Live updates aren't available right now.");
        return { token: answer.token, expiresAt: answer.expiresAt };
      },
    },
  };
}

export function developerTaskRouteDependencies(
  deps: DeveloperRouteDependencies,
  caller: DeveloperCaller,
  initialSlackThread?: { teamId: string; channelId: string; threadTs: string },
  trustedCaller: DeveloperCaller | null = caller,
): DeveloperTaskRouteDependencies {
  const projectChannelIds = async (project: string) => (await bindingsOf(deps, caller.orgId))
    .filter((binding) => binding.projectName === project)
    .map((binding) => binding.channelId)
    .sort();
  const identityDependencies = (admission?: TaskPeopleDisplayAdmission): TaskPersonIdentityDependencies => {
    const slackTeamId = deps.developer.slackTeamId;
    const taskPersonProof = admission?.proof.bind(admission) ?? deps.developer.taskPersonProof;
    if (slackTeamId === undefined || taskPersonProof === undefined) throw agentXError("SLACK_UNAVAILABLE", "task person identity proof is unavailable");
    return {
      documentClient: deps.documentClient, tableName: deps.tableName, slackTeamId, now: deps.now, uuid: randomUUID, taskPersonProof,
      developerRecord: async (targetDeveloperId) => {
        const response = await deps.documentClient.send(new GetCommand({ TableName: deps.developer.signInTableName, Key: { pk: `DEVELOPER#${targetDeveloperId}`, sk: META }, ConsistentRead: true })) as { Item?: DeveloperRecord };
        return response.Item;
      },
      projectChannelIds,
      targetProjectAccess: async (subject, project, freshMemberOf) => {
        const revision = await latestDefinition(deps, caller.orgId, project);
        if (revision === undefined) throw agentXError("PROJECT_NOT_FOUND", `project \`${project}\` doesn't exist in this AgentX`);
        const [memberships, allBindings, subjectOrg] = await Promise.all([
          queryAll<{ projectName: string; role?: string }>(deps, memberGrantsPk(caller.orgId, subject.developerId), MEMBER_GRANT_SK_PREFIX),
          bindingsOf(deps, caller.orgId),
          deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: orgMemberKey(caller.orgId, subject.developerId), ConsistentRead: true })) as Promise<{ Item?: { role?: string } }>,
        ]);
        // An org owner or admin is a maintainer of every project in the org with no grant, as `checkProjectAccess` counts them (final review I1).
        const orgMember = subjectOrg.Item === undefined ? undefined : { ...orgMemberKey(caller.orgId, subject.developerId), ...(subjectOrg.Item.role === undefined ? {} : { role: subjectOrg.Item.role }) };
        const result = evaluateProjectAuthority({
          orgId: caller.orgId, developerId: subject.developerId,
          project,
          revision: { revision: revision.revision, definition: { developerTasks: revision.developerTasks } },
          memberships,
          bindings: allBindings,
          ...(orgMember === undefined ? {} : { orgMember }),
          freshMemberOf,
          ...(subject.slackUserId === undefined ? {} : { slackUserId: subject.slackUserId }),
        });
        if (result.kind === "allowed") return;
        if (result.kind === "denied" && result.reason === "project-viewer") return "viewer";
        if (result.kind === "unavailable" || result.kind === "needs-membership") {
          throw agentXError("SLACK_UNAVAILABLE", "task person identity proof is unavailable");
        }
        if (result.kind === "not-found") throw agentXError("PROJECT_NOT_FOUND", `project \`${project}\` doesn't exist in this AgentX`);
        if (result.kind === "denied" && result.reason === "tasks-disabled") {
          throw agentXError("PROJECT_TASKS_DISABLED", `tasks from AI tools are turned off for \`${project}\`; use the project's Slack channel, or ask an admin`);
        }
        // System qualification has no channel-name lookup or human-facing error decoration.
        throw agentXError("PROJECT_ACCESS_DENIED", "task person identity could not be verified");
      },
      ...(trustedCaller === null ? {} : { trustedCaller }),
    };
  };
  const agents = deps.agents;
  const agentSessions = sessionDependenciesOf(deps);
  return {
    documentClient: deps.documentClient,
    tableName: deps.tableName,
    orgId: caller.orgId,
    ...(agentSessions === undefined ? {} : { agentSessions }),
    // A taker who was merged into another member since is the owner as the member they became (Plan 5 Task 12a review, M-3).
    resolveMember: (developerId) => survivorOf(projectMembersDepsOf(deps), developerId),
    ...(deps.developer.slackTeamId === undefined ? {} : { slackTeamId: deps.developer.slackTeamId }),
    issuer: deps.developer.issuer,
    actions: deps.tasks!,
    ...(deps.modelAccess === undefined ? {} : { modelAccess: deps.modelAccess }),
    ...(deps.cloud === true ? { cloud: true } : {}),
    ...(deps.workflowE2EPresentation === undefined ? {} : { workflowE2EPresentation: deps.workflowE2EPresentation }),
    ...(deps.workflowE2EPublicationChecks === undefined ? {} : { workflowE2EPublicationChecks: deps.workflowE2EPublicationChecks }),
    ...(deps.currentPullRequestHead === undefined ? {} : { currentPullRequestHead: deps.currentPullRequestHead }),
    ...(deps.currentBaseCommit === undefined ? {} : { currentBaseCommit: deps.currentBaseCommit }),
    ...(deps.taskAutonomyNow === undefined ? {} : { taskAutonomyNow: deps.taskAutonomyNow }),
    ...(deps.workflowE2EScenarioResults === undefined ? {} : { workflowE2EScenarioResults: deps.workflowE2EScenarioResults }),
    ...(deps.workflowE2EArtifact === undefined ? {} : { workflowE2EArtifact: deps.workflowE2EArtifact }),
    ...(deps.startWorkflowE2EBaseline === undefined ? {} : { startWorkflowE2EBaseline: deps.startWorkflowE2EBaseline }),
    ...(deps.validateWorkflowE2EApplicationPlan === undefined ? {} : { validateWorkflowE2EApplicationPlan: deps.validateWorkflowE2EApplicationPlan }),
    ...(deps.registeredRepositoryIdentity === undefined ? {} : { registeredRepositoryIdentity: deps.registeredRepositoryIdentity }),
    ...(deps.requireRepositoriesConnected === undefined ? {} : { requireRepositoriesConnected: deps.requireRepositoriesConnected }),
    ...(agents?.codeMerge !== undefined ? { mergeView: (task: DeveloperTaskRecord, items: MergeTrackingItem[]) => mergeViewOf(agents, task, items, caller.developerId) }
      : deps.codeMergeView === undefined ? {} : { mergeView: (task: DeveloperTaskRecord, items: MergeTrackingItem[]) => deps.codeMergeView!(task, items, caller.developerId) }),
    ...(agents === undefined ? {} : { agentRuns: agents, agentEngine: agents, withdrawSpendRequests: (task: DeveloperTaskRecord) => withdrawTaskSpendRequests(agents, task), pausedTaskGate: (who, task: DeveloperTaskRecord) => pausedTaskGate(agents, who, task) }),
    ...(deps.developer.taskPeopleConfiguration === undefined ? {} : { taskPeopleConfiguration: deps.developer.taskPeopleConfiguration }),
    ...(deps.developer.workflowDependenciesEnabled === undefined ? {} : { workflowDependenciesEnabled: deps.developer.workflowDependenciesEnabled }),
    checkTaskPerson: async (task, developerId, admission) => {
      return checkTaskPersonIdentity(identityDependencies(admission), task, developerId);
    },
    resolveTaskPickerPerson: async (taskId, slackUserId) => {
      const dependencies = identityDependencies();
      const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: { pk: `DEVTASK#${taskId}`, sk: "META" }, ConsistentRead: true })) as { Item?: DeveloperTaskRecord };
      if (response.Item === undefined) throw agentXError("PROJECT_ACCESS_DENIED", "task person identity could not be verified");
      const task = response.Item;
      const resolved = await resolveTaskPickerPersonWithId(dependencies, task, slackUserId);
      const proof = await checkTaskPersonIdentity(dependencies, task, resolved.identity.developerId);
      if (!proof.eligible || proof.identity.developerId !== resolved.identity.developerId || proof.identity.slackUserId !== resolved.identity.slackUserId) {
        throw agentXError("PROJECT_ACCESS_DENIED", "task person identity could not be verified");
      }
      return { personId: resolved.personId, developerId: resolved.identity.developerId, slackUserId: resolved.identity.slackUserId, channelMember: proof.channelMember };
    },
    taskPeopleChannel: async (taskId) => {
      const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: { pk: `DEVTASK#${taskId}`, sk: "META" }, ConsistentRead: true })) as { Item?: DeveloperTaskRecord };
      const share = response.Item?.share;
      if (share === undefined || typeof share.teamId !== "string" || typeof share.channelId !== "string" || typeof share.threadTs !== "string") {
        throw agentXError("PROJECT_ACCESS_DENIED", "task channel could not be verified");
      }
      return { teamId: share.teamId, channelId: share.channelId, threadTs: share.threadTs };
    },
    ...(deps.developer.inviteTaskPerson === undefined ? {} : { inviteTaskPerson: deps.developer.inviteTaskPerson }),
    ...(deps.developer.taskPeopleDisplayRead === undefined ? {} : {
      createTaskPeopleDisplayAdmission: () => taskPeopleDisplayAdmission({ now: deps.now, read: deps.developer.taskPeopleDisplayRead! }),
      listTaskPeople: async (task: DeveloperTaskRecord, admission: TaskPeopleDisplayAdmission) => {
      const channels = [...new Set([...(await projectChannelIds(task.project)), ...(task.share === undefined ? [] : [task.share.channelId])])].sort();
      admission.assertOpen();
      const answer = await admission.directory({ kind: "task-channel-people", channelIds: channels });
      if (!answer.ok) throw agentXError("SLACK_UNAVAILABLE", "the complete task People directory is unavailable");
      admission.assertOpen();
      const identities = await registerTaskChannelPeople(identityDependencies(admission), task, answer.users, () => admission.assertOpen());
      admission.assertOpen();
      const bySlack = new Map(answer.users.map((user) => [user.id, user]));
      return identities.map((identity) => {
        const user = bySlack.get(identity.slackUserId);
        if (user === undefined) throw agentXError("SLACK_UNAVAILABLE", "the complete task People directory is unavailable");
        return { subject: { developerId: identity.developerId, slackUserId: identity.slackUserId }, identity, eligible: true,
          channelMember: task.share === undefined || user.memberOf.includes(task.share.channelId) };
      });
      },
    }),
    ...(deps.refreshTaskFeedback === undefined ? {} : { refreshTaskFeedback: deps.refreshTaskFeedback.bind(deps) }),
    ...(initialSlackThread === undefined ? {} : { initialSlackThread }),
    checkAccess: (project) => checkProjectAccess(deps, caller, project),
    channelMember: async (slackUserId, channelId) => {
      const answer = await safeChannelMembers(deps)({ kind: "channel-members", slackUserId, channelIds: [channelId] });
      if (!answer.ok) throw agentXError("SLACK_UNAVAILABLE", "Slack could not be reached to check your membership of that channel; try again shortly");
      return answer.memberOf.includes(channelId);
    },
    projectChannelIds,
    ...(deps.developer.slackRequestQueue === undefined ? {} : { slackRequestQueue: deps.developer.slackRequestQueue }),
    ...(deps.developer.channelInfo === undefined ? {} : {
      boundChannels: async (channelIds: readonly string[]) => {
        const known = await channelNames(deps, channelIds);
        return channelIds.map((channelId) => {
          const channel = known.get(channelId);
          return channel === undefined ? { channelId } : { channelId, name: channel.name, isPrivate: channel.isPrivate };
        });
      },
    }),
    now: deps.now,
  };
}

export async function routeDeveloperRequest(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest, url: URL, authenticated?: { caller: DeveloperCaller; csrf: string }): Promise<unknown> {
  // Website proposal routes accept only the trusted opaque-cookie adapter.
  // Reject token callers before authentication or any project/proposal lookup.
  if (/^\/v1\/app\/projects\/[^/]+\/allowed-websites(?:\/|$)/.test(url.pathname) && authenticated?.caller.browserSession !== true) {
    throw agentXError("FORBIDDEN", "Use a live browser session for allowed websites.");
  }
  // B34 reviewed reads/unbind are cookie-only; existing token Slack routes remain separate.
  if (/^\/v1\/app\/projects\/[^/]+\/slack-channel\/(links|review|requests|unbind|proposals)(?:\/|$)/.test(url.pathname) && authenticated?.caller.browserSession !== true) {
    throw agentXError("FORBIDDEN", "Use a live browser session for Slack linking.");
  }
  // The browser pages sign in with the opaque review session cookie, re-read (with the membership) on every request.
  const authenticateSession = async (sessionId: string) => {
    try { return await authenticateDeveloperSessionId(deps, sessionId); }
    catch { return undefined; }
  };
  // The audit page (Task 13): a read-only view for the org's owners and admins; the org is the session's own.
  if (isAuditViewPath(url.pathname)) {
    return createAuditViewPage({ origin: new URL(deps.developer.issuer).origin, authenticateSession, ledger: deps.auditLedger })(request, url);
  }
  // RULING Q37: Plan 7 Task 14 shared links are served exclusively by WebAppFunction.
  if (url.pathname.startsWith("/s/")) throw agentXError("NOT_FOUND", "route not found");
  if (url.pathname.startsWith("/review/")) {
    if (deps.tasks === undefined) throw agentXError("NOT_FOUND", "developer tasks are not set up in this deployment");
    // Task 18: the read-only task page and its "moved on" check; every other /review/ path is the PR-feedback review.
    // Spec 061 slice 2: the page's JSON API is matched here too, so the PR-feedback page never sees its paths.
    if (TASK_PAGE.test(url.pathname) || TASK_PEOPLE_CONFIRMATION.test(url.pathname) || TASK_STATUS.test(url.pathname) || TASK_PAGE_API_PREFIX.test(url.pathname)) {
      const routeDeps = (caller: DeveloperCaller) => developerTaskRouteDependencies(deps, caller);
      return createTaskWeb({
        authenticateSession,
        getTaskDocumentView: (caller, taskId) => getTaskDocumentView(routeDeps(caller), caller, taskId),
        getTaskFreshness: (caller, taskId) => getTaskFreshness(routeDeps(caller), caller, taskId),
        getTaskPeople: (caller, taskId) => getTaskPeopleForPage(routeDeps(caller), caller, taskId),
        getTaskPeopleRequest: (caller, taskId, requestId) => getTaskPeopleProposal(routeDeps(caller), caller, taskId, requestId),
        getTaskPeopleProposalMetadata: (caller, taskId, requestId) => getTaskPeopleProposalMetadata(routeDeps(caller), caller, taskId, requestId),
        getTaskPersonName: (caller, taskId, personId) => getTaskPersonPresentationName(routeDeps(caller), taskId, personId),
        getTaskPeopleCapabilities: (caller, taskId) => getTaskPeopleCapabilities(routeDeps(caller), caller, taskId),
        api: createTaskWebApi({
          origin: deps.developer.issuer,
          log: logDeveloperEvent,
          authenticateSession,
          taskState: (caller, taskId) => getTaskPageState(routeDeps(caller), caller, taskId),
          listComments: (caller, taskId) => listPageComments(routeDeps(caller), caller, taskId),
          createComment: (caller, taskId, input) => createPageComment(routeDeps(caller), caller, taskId, input),
          editComment: (caller, taskId, input) => editPageComment(routeDeps(caller), caller, taskId, input),
          deleteComment: (caller, taskId, input) => deletePageComment(routeDeps(caller), caller, taskId, input),
          setSuggestion: (caller, taskId, input) => setPageSuggestion(routeDeps(caller), caller, taskId, input),
          decide: (caller, taskId, input) => decideOnPage(routeDeps(caller), caller, taskId, input),
          retryApplicationRound: (caller, taskId, input) => retryApplicationRoundOnPage(routeDeps(caller), caller, taskId, input),
          readE2EArtifact: (caller, taskId, sha256) => getTaskE2EArtifact(routeDeps(caller), caller, taskId, sha256),
          getPeople: (caller, taskId) => getTaskPeopleForPage(routeDeps(caller), caller, taskId),
          proposePeopleRole: (caller, taskId, input) => proposeTaskPeopleRoleForPage(routeDeps(caller), caller, taskId, input),
          proposeOwnership: (caller, taskId, input) => proposeTaskOwnershipForPage(routeDeps(caller), caller, taskId, input),
          getPeopleRequest: (caller, taskId, requestId) => getTaskPeopleProposal(routeDeps(caller), caller, taskId, requestId),
          confirmPeopleRequest: (caller, taskId, requestId) => confirmTaskPeopleProposal(routeDeps(caller), caller, taskId, requestId),
        }),
      })(request, url);
    }
    const web = createFeedbackReviewWeb({
      origin: new URL(deps.developer.issuer).origin,
      authenticateSession,
      getWorkflowFeedbackReview: (caller, taskId) => getWorkflowFeedbackReview(developerTaskRouteDependencies(deps, caller), caller, taskId),
      submitWorkflowFeedbackDecision: (caller, taskId, input) => submitWorkflowFeedbackDecision(developerTaskRouteDependencies(deps, caller), caller, taskId, input),
      now: deps.now,
    });
    return web(request, url);
  }
  // Never request.jwtClaims: no API Gateway authorizer runs on /v1/dev/* (D17).
  const caller = authenticated?.caller ?? await authenticateDeveloper(deps, await deps.developer.verifyAccessToken(request.headers.authorization));
  // Lane C6: only the trusted cookie adapter supplies authenticated; source guards share the handlers' paths.
  if (authenticated !== undefined) requireReviewedModelSourceWebWrite(request, url);
  // Plan 3's paths, project sub-paths included, are matched before Plan 2's `/v1/app/projects/{name}*` handlers (PF24).
  if (request.method === "GET" && url.pathname === "/v1/app/models") {
    if (deps.agents === undefined) throw agentXError("NOT_FOUND", "agents are not set up in this deployment");
    return getModels(deps.agents, caller, url);
  }
  if (isAgentRoute(url.pathname)) {
    if (deps.agents === undefined) throw agentXError("NOT_FOUND", "agents are not set up in this deployment");
    return routeAgentRequest({ ...deps.agents, startRun: (_agentCaller, input) => startAppRun(deps, caller, input) }, caller, request, url);
  }
  // Plan 4's chains (`/v1/app/chains*`, `/v1/app/chain-runs*`), beside Plan 3's agents.
  if (isChainRoute(url.pathname)) {
    const chainDeps = chainRouteDependenciesFor(deps, caller);
    if (chainDeps === undefined) throw agentXError("NOT_FOUND", "chains are not set up in this deployment");
    // Rovara Code (Plan 6): a step's task is read like any task, so a client without `x-agentx-task-view: 2` gets the version 1 projection of it.
    return taskResponseForClient(await routeChainRequest(chainDeps, caller, request, url), request.headers);
  }
  // Plan 5, Task 5: `/v1/app/sessions*`.
  if (request.method === "GET" && url.pathname === "/v1/app/nav") return getAppNavigation(deps, caller);
  if (isAgentSessionRoute(url.pathname)) return routeAgentSessionRequest(sessionReadDependencies(deps, caller), caller, request, url);
  // Plan 5, Tasks 17, 18 and 22: `/v1/app/devices*` (the Mac's command poll, and a removal that ends the sessions on it) and `/v1/app/org/local-agents`.
  if (isDeviceRoute(url.pathname)) {
    const log = sessionDependenciesOf(deps)?.log;
    return routeDeviceRequest({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, ...(log === undefined ? {} : { log }), ...(deps.audit === undefined ? {} : { audit: deps.audit }) }, caller, request, url);
  }
  if (request.method === "GET" && url.pathname === "/v1/app/me") {
    const me = await getAppMe(deps, caller);
    return authenticated === undefined ? me : { ...me, csrf: authenticated.csrf };
  }
  if (request.method === "GET" && url.pathname === "/v1/dev/projects") return listProjects(deps, caller);
  if (request.method === "GET" && url.pathname === "/v1/app/projects") return listAppProjects(deps, caller, url.searchParams.get("include") === "archived");
  const appProject = /^\/v1\/app\/projects\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && appProject !== null) return getAppProject(deps, caller, appProject[1]!);
  const projectSettingsRoute = /^\/v1\/app\/projects\/([^/]+)\/settings$/.exec(url.pathname);
  if (request.method === "PUT" && projectSettingsRoute !== null) return putProjectSettings(deps, caller, projectSettingsRoute[1]!, jsonBody(request));
  const projectMembersRoute = /^\/v1\/app\/projects\/([^/]+)\/members(?:\/([a-f0-9]{64}))?$/.exec(url.pathname);
  if (projectMembersRoute !== null) {
    if (request.method === "GET" && projectMembersRoute[2] === undefined) return getProjectMembers(deps, caller, projectMembersRoute[1]!);
    if (request.method === "PUT" && projectMembersRoute[2] !== undefined) return putProjectMember(deps, caller, projectMembersRoute[1]!, projectMembersRoute[2], jsonBody(request));
    if (request.method === "DELETE" && projectMembersRoute[2] !== undefined) return deleteProjectMember(deps, caller, projectMembersRoute[1]!, projectMembersRoute[2], jsonBody(request));
  }
  const websiteReview = /^\/v1\/app\/projects\/([^/]+)\/allowed-websites$/.exec(url.pathname);
  if (request.method === "GET" && websiteReview !== null) return projectAllowedDomainsHttp({ ...deps, ...deps.projectAllowedDomains, signInTableName: deps.developer.signInTableName }, caller, websiteReview[1]!, { operation: "review", expectedOrgId: url.searchParams.get("expectedOrgId") });
  if (request.method === "POST" && websiteReview !== null) return projectAllowedDomainsHttp({ ...deps, ...deps.projectAllowedDomains, signInTableName: deps.developer.signInTableName }, caller, websiteReview[1]!, { operation: "save", body: jsonBody(request) });
  const websiteProposalCreate = /^\/v1\/app\/projects\/([^/]+)\/allowed-websites\/proposals$/.exec(url.pathname);
  if (request.method === "POST" && websiteProposalCreate !== null) return projectAllowedDomainsHttp({ ...deps, ...deps.projectAllowedDomains, signInTableName: deps.developer.signInTableName }, caller, websiteProposalCreate[1]!, { operation: "propose", body: jsonBody(request) });
  const websiteProposalStatus = /^\/v1\/app\/projects\/([^/]+)\/allowed-websites\/proposals\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && websiteProposalStatus !== null) return projectAllowedDomainsHttp({ ...deps, ...deps.projectAllowedDomains, signInTableName: deps.developer.signInTableName }, caller, websiteProposalStatus[1]!, { operation: "status", proposalId: websiteProposalStatus[2]!, expectedOrgId: url.searchParams.get("expectedOrgId") });
  const websiteProposalDecision = /^\/v1\/app\/projects\/([^/]+)\/allowed-websites\/proposals\/([^/]+)\/(approve|cancel|reject)$/.exec(url.pathname);
  if (request.method === "POST" && websiteProposalDecision !== null) return projectAllowedDomainsHttp({ ...deps, ...deps.projectAllowedDomains, signInTableName: deps.developer.signInTableName }, caller, websiteProposalDecision[1]!, { operation: websiteProposalDecision[3] as "approve" | "cancel" | "reject", proposalId: websiteProposalDecision[2]!, body: jsonBody(request) });
  const websiteRequestStatus = /^\/v1\/app\/projects\/([^/]+)\/allowed-websites\/requests\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && websiteRequestStatus !== null) return projectAllowedDomainsHttp({ ...deps, ...deps.projectAllowedDomains, signInTableName: deps.developer.signInTableName }, caller, websiteRequestStatus[1]!, { operation: "request-status", requestId: websiteRequestStatus[2]!, expectedOrgId: url.searchParams.get("expectedOrgId") });
  const slackProposal = /^\/v1\/app\/projects\/([^/]+)\/slack-channel\/proposals(?:\/([^/]+)(?:\/(approve))?)?$/.exec(url.pathname);
  if (slackProposal !== null) {
    let project: string;try { project = decodeURIComponent(slackProposal[1]!); } catch { throw agentXError("NOT_FOUND", "route not found"); }
    const slackDeps = { ...deps, signInTableName: deps.developer.signInTableName };
    if (request.method === "POST" && slackProposal[2] === undefined) return projectSlackBrowserHttp(slackDeps, caller, project, { operation: "propose", body: jsonBody(request) });
    if (request.method === "POST" && slackProposal[3] === "approve") return projectSlackBrowserHttp(slackDeps, caller, project, { operation: "approve", proposalId: slackProposal[2]!, body: jsonBody(request) });
    if (request.method === "GET" && slackProposal[2] !== undefined && slackProposal[3] === undefined) return projectSlackBrowserHttp(slackDeps, caller, project, { operation: "proposal", expectedOrgId: url.searchParams.get("expectedOrgId"), ...(slackProposal[2] === "current" ? {} : { proposalId: slackProposal[2] }) });
    throw agentXError("NOT_FOUND", "route not found");
  }
  const reviewedSlack = /^\/v1\/app\/projects\/([^/]+)\/slack-channel\/(links|review|unbind|requests\/([^/]+))$/.exec(url.pathname);
  if (reviewedSlack !== null) {
    let project: string;try { project = decodeURIComponent(reviewedSlack[1]!); } catch { throw agentXError("NOT_FOUND", "route not found"); }
    const slackDeps = { ...deps, signInTableName: deps.developer.signInTableName };
    const expectedOrgId = url.searchParams.get("expectedOrgId");
    if (request.method === "GET" && reviewedSlack[2] === "links") return projectSlackBrowserHttp(slackDeps, caller, project, { operation: "list", expectedOrgId, ...(url.searchParams.has("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}) });
    if (request.method === "GET" && reviewedSlack[2] === "review") return projectSlackBrowserHttp(slackDeps, caller, project, { operation: "target", expectedOrgId, teamId: url.searchParams.get("teamId") ?? "", channelId: url.searchParams.get("channelId") ?? "" });
    if (request.method === "GET" && reviewedSlack[3] !== undefined) return projectSlackBrowserHttp(slackDeps, caller, project, { operation: "status", expectedOrgId, requestId: reviewedSlack[3] });
    if (request.method === "POST" && reviewedSlack[2] === "unbind") return projectSlackBrowserHttp(slackDeps, caller, project, { operation: "unbind", body: jsonBody(request) });
    throw agentXError("NOT_FOUND", "route not found");
  }
  const workingBranchContextRoute = /^\/v1\/app\/projects\/([^/]+)\/working-branches$/.exec(url.pathname);
  if (request.method === "POST" && workingBranchContextRoute !== null) {
    if(caller.browserSession!==true)throw agentXError("FORBIDDEN","Use a live browser session for working branch settings.");
    return projectWorkingBranchSaveHttp(deps,caller,workingBranchContextRoute[1]!,jsonBody(request));
  }
  const workingBranchStatusRoute = /^\/v1\/app\/projects\/([^/]+)\/working-branches\/requests\/([^/]+)$/.exec(url.pathname);
  if(request.method === "GET" && workingBranchStatusRoute !== null)return projectWorkingBranchSaveHttp(deps,caller,workingBranchStatusRoute[1]!,undefined,workingBranchStatusRoute[2]);
  if (request.method === "GET" && workingBranchContextRoute !== null) return readProjectWorkingBranchContextHttp(deps, caller, workingBranchContextRoute[1]!, url, request.headers);
  // Lane B: read-only branch pages; all other method/path pairs fall through.
  const workingBranchesRoute = /^\/v1\/app\/projects\/([^/]+)\/repositories\/([^/]+)\/branches$/.exec(url.pathname);
  if (request.method === "GET" && workingBranchesRoute !== null) return readProjectWorkingBranchHttp(deps, caller, workingBranchesRoute[1]!, workingBranchesRoute[2]!, url, request.headers);
  const workingBranchPreviewRoute = /^\/v1\/app\/projects\/([^/]+)\/repositories\/([^/]+)\/branches\/preview$/.exec(url.pathname);
  if (request.method === "GET" && workingBranchPreviewRoute !== null) return readProjectWorkingBranchHttp(deps, caller, workingBranchPreviewRoute[1]!, workingBranchPreviewRoute[2]!, url, request.headers, true);
  // Lane B reviewed archive: strict pinned preview + acknowledged write; legacy routes remain compatible.
  const reviewedArchiveRoute = /^\/v1\/app\/projects\/([^/]+)\/(archive-preview|reviewed-archive)$/.exec(url.pathname);
  if (reviewedArchiveRoute !== null && ((request.method === "GET" && reviewedArchiveRoute[2] === "archive-preview") || (request.method === "POST" && reviewedArchiveRoute[2] === "reviewed-archive"))) {
    let name: string;
    try { name = decodeURIComponent(reviewedArchiveRoute[1]!); } catch { throw agentXError("NOT_FOUND", "That project is unavailable in this company."); }
    if (!AgentXNameSchema.safeParse(name).success) throw agentXError("NOT_FOUND", "That project is unavailable in this company.");
    if (request.method === "GET") return readReviewedProjectArchiveAppPreview(deps, caller, name);
    return archiveProjectReviewedWithEffects({ ...deps, egress: egressDepsOf(deps) }, caller, name, jsonBody(request));
  }
  // Lane B reviewed restore; existing browser auth/CSRF runs before this method/path pair.
  const reviewedRestoreRoute = /^\/v1\/app\/projects\/([^/]+)\/(restore-preview|reviewed-restore)$/.exec(url.pathname);
  if (reviewedRestoreRoute !== null && ((request.method === "GET" && reviewedRestoreRoute[2] === "restore-preview") || (request.method === "POST" && reviewedRestoreRoute[2] === "reviewed-restore"))) {
    let name: string;
    try { name = decodeURIComponent(reviewedRestoreRoute[1]!); } catch { throw agentXError("NOT_FOUND", "That project is unavailable in this company."); }
    if (!AgentXNameSchema.safeParse(name).success) throw agentXError("NOT_FOUND", "That project is unavailable in this company.");
    if (request.method === "GET") return readReviewedProjectRestoreAppPreview(deps, caller, name);
    return restoreProjectReviewedWithEffects({ ...deps, egress: egressDepsOf(deps) }, caller, name, jsonBody(request));
  }
  const projectSlackChannelRoute = /^\/v1\/app\/projects\/([^/]+)\/slack-channel$/.exec(url.pathname);
  if (projectSlackChannelRoute !== null) {
    if (request.method === "PUT") return putProjectSlackChannel(deps, caller, projectSlackChannelRoute[1]!);
    if (request.method === "DELETE") return deleteProjectSlackChannel(deps, caller, projectSlackChannelRoute[1]!, jsonBody(request));
  }
  const projectArchiveRoute = /^\/v1\/app\/projects\/([^/]+)\/(archive|restore)$/.exec(url.pathname);
  if (request.method === "POST" && projectArchiveRoute !== null) return changeProjectArchive(deps, caller, projectArchiveRoute[1]!, jsonBody(request), projectArchiveRoute[2] as "archive" | "restore");
  const codeIntentRoute = CODE_INTENT_PATH.exec(url.pathname);
  if (request.method === "POST" && codeIntentRoute !== null) return routeCodeIntentStart(codeIntentDependenciesOf(deps, caller), caller, codeIntentRoute[1]!, jsonBody(request), request.headers);
  // Rovara Code (Plan 6 Task 19): a project's code settings. Anyone who can see the project reads them; a maintainer changes them.
  const codeSettingsRoute = /^\/v1\/app\/projects\/([^/]+)\/code-settings$/.exec(url.pathname);
  if (codeSettingsRoute !== null && (request.method === "GET" || request.method === "PUT")) {
    const settingsDeps = { documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, projectFor: (who: DeveloperCaller, rawName: string) => projectRoleForRoute(deps, who, rawName) };
    return request.method === "GET" ? getCodeSettings(settingsDeps, caller, codeSettingsRoute[1]!) : putCodeSettings(settingsDeps, caller, codeSettingsRoute[1]!, jsonBody(request), deps.agents);
  }
  // "How we work": the project's playbook. Anyone who can see the project reads it; a maintainer changes it.
  const playbookRoute = PLAYBOOK_PATH.exec(url.pathname);
  const playbookProcessRoute = PLAYBOOK_PROCESS_PATH.exec(url.pathname);
  if ((playbookRoute !== null && (request.method === "GET" || request.method === "PUT")) || (playbookProcessRoute !== null && request.method === "POST")) {
    const playbookDeps = {
      documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, store: deps.agents?.store, audit: deps.agents?.audit, approvals: deps.agents,
      projectFor: (who: DeveloperCaller, rawName: string) => projectRoleForRoute(deps, who, rawName),
    };
    if (playbookProcessRoute !== null) return routeProjectProcess(playbookDeps, caller, playbookProcessRoute[1]!);
    return routeProjectPlaybook(playbookDeps, caller, request.method as "GET" | "PUT", playbookRoute![1]!, () => jsonBody(request));
  }
  // "How we work": the project's process as the tab shows it. Anyone who can see the project reads it.
  const howWeWorkRoute = HOW_WE_WORK_PATH.exec(url.pathname);
  if (request.method === "GET" && howWeWorkRoute !== null) {
    return getProjectHowWeWork({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, store: deps.agents?.store, projectFor: (who: DeveloperCaller, rawName: string) => projectRoleForRoute(deps, who, rawName) }, caller, howWeWorkRoute[1]!);
  }
  const setupDraftRoute = /^\/v1\/app\/projects\/([^/]+)\/setup-draft(\/apply)?$/.exec(url.pathname);
  if (setupDraftRoute !== null) {
    const drafting = setupDraftDepsOf(deps);
    if (request.method === "POST" && setupDraftRoute[2] === undefined) return startSetupDraft(drafting, caller, setupDraftRoute[1]!, jsonBody(request));
    if (request.method === "GET" && setupDraftRoute[2] === undefined) return getSetupDraft(drafting, caller, setupDraftRoute[1]!);
    if (request.method === "POST" && setupDraftRoute[2] !== undefined) return applySetupDraft(drafting, caller, setupDraftRoute[1]!, jsonBody(request));
  }
  const projectSetupCheckRoute = /^\/v1\/app\/projects\/([^/]+)\/setup-check$/.exec(url.pathname);
  if (request.method === "POST" && projectSetupCheckRoute !== null) return startProjectSetupCheck(deps, caller, projectSetupCheckRoute[1]!, jsonBody(request));
  if (request.method === "POST" && url.pathname === "/v1/app/github/connect") {
    if (deps.githubConnect === undefined) throw agentXError("NOT_FOUND", "connecting GitHub is not set up in this deployment");
    return deps.githubConnect.start(caller);
  }
  if (request.method === "GET" && url.pathname === "/v1/app/github/requests") {
    if (deps.githubConnect === undefined) throw agentXError("NOT_FOUND", "connecting GitHub is not set up in this deployment");
    return deps.githubConnect.listRequests(caller);
  }
  if (request.method === "GET" && url.pathname === "/v1/app/github/installations") {
    if (deps.githubConnect === undefined) throw agentXError("NOT_FOUND", "connecting GitHub is not set up in this deployment");
    return deps.githubConnect.listInstallations(caller);
  }
  const githubInstallationRoute = /^\/v1\/app\/github\/installations\/([1-9][0-9]{0,14})$/.exec(url.pathname);
  if (request.method === "DELETE" && githubInstallationRoute !== null) {
    if (deps.githubConnect === undefined) throw agentXError("NOT_FOUND", "connecting GitHub is not set up in this deployment");
    return deps.githubConnect.disconnect(caller, Number(githubInstallationRoute[1]));
  }
  if (request.method === "GET" && url.pathname === "/v1/app/github/repositories") return listGithubRepositories(deps, caller, url.searchParams.get("installation"));
  const githubRequestRoute = /^\/v1\/app\/github\/requests\/([0-9]{1,20})$/.exec(url.pathname);
  if (request.method === "DELETE" && githubRequestRoute !== null) {
    if (deps.githubConnect === undefined) throw agentXError("NOT_FOUND", "connecting GitHub is not set up in this deployment");
    return deps.githubConnect.cancelRequest(caller, githubRequestRoute[1]!);
  }
  if (request.method === "POST" && (url.pathname === "/v1/app/projects" || url.pathname === "/v1/dev/projects")) return createProject(deps, caller, jsonBody(request));
  if (request.method === "GET" && url.pathname === "/v1/dev/workspaces") return listWorkspaces(deps, caller);
  if (request.method === "PATCH" && url.pathname === "/v1/app/org") {
    if (caller.orgRole !== "owner") throw agentXError("FORBIDDEN", "only an owner can rename the organization");
    if (deps.orgs === undefined) throw agentXError("NOT_FOUND", "organizations are not set up in this deployment");
    const parsed = RenameOrganizationBodySchema.safeParse(jsonBody(request));
    if (!parsed.success) throw bodyError(parsed.error);
    await deps.orgs.renameOrg({ ...parsed.data, orgId: caller.orgId, developerId: caller.developerId });
    return getOrganization(deps, caller);
  }
  if (request.method === "GET" && (url.pathname === "/v1/dev/org" || url.pathname === "/v1/app/org")) return getOrganization(deps, caller);
  if (request.method === "GET" && url.pathname === "/v1/app/org/invites") return listOrganizationInvites(deps, caller, url);
  // Lane A G1: no policy write, default inference or paid-start permission.
  if (request.method === "GET" && url.pathname === "/v1/app/org/task-stop-ceiling") return getTaskStopCeiling(deps, caller);
  if (request.method === "GET" && url.pathname === "/v1/app/org/task-stop-policy") return getTaskStopCompany(deps, caller);
  const taskStopAgentPath = /^\/v1\/app\/org\/task-stop-policy\/agents\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && taskStopAgentPath !== null) return getTaskStopAgent(deps, caller, taskStopAgentPath[1]!);
  const taskStopProjectPath = /^\/v1\/app\/org\/task-stop-policy\/projects\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && taskStopProjectPath !== null) return getTaskStopProject(deps, caller, taskStopProjectPath[1]!);
  // Lane A: current-org, live-role monthly settings projection.
  if (request.method === "GET" && url.pathname === "/v1/app/org/budget-settings") return getAdminBudgetSettings(deps, caller);
  // Lane A: reviewed creation and actor-bound historical recovery, isolated from legacy onboarding.
  if (request.method === "POST" && url.pathname === "/v1/app/org/invites/reviewed") return createReviewedOrganizationInvite(deps, caller, jsonBody(request));
  const createReceipt = /^\/v1\/app\/org\/invites\/requests\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && createReceipt !== null) return getInviteCreationReceipt(deps, caller, createReceipt[1]!);
  // Lane A: explicit canonical review/recovery for the invite write flow.
  const inviteStatus = /^\/v1\/app\/org\/invites\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && inviteStatus !== null) return getOrganizationInviteStatus(deps, caller, inviteStatus[1]!);
  const revokeInvite = /^\/v1\/app\/org\/invites\/([^/]+)\/revoke$/.exec(url.pathname);
  if (request.method === "POST" && revokeInvite !== null) return revokeOrganizationInvite(deps, caller, revokeInvite[1]!, jsonBody(request));
  if (request.method === "POST" && (url.pathname === "/v1/dev/org/invites" || url.pathname === "/v1/app/org/invites")) return createOrganizationInvite(deps, caller, jsonBody(request));
  // Lane C17: metadata-only Slack association evidence; scope comes only from the authenticated caller.
  if (request.method === "GET" && url.pathname === "/v1/app/org/slack-workspace-evidence") {
    if (url.search !== "" || (request.body !== undefined && request.body.trim() !== "")) throw agentXError("CONFIG_INVALID", "Slack workspace evidence accepts no query parameters or body.");
    return readSlackWorkspaceEvidence(deps, caller);
  }
  if (request.method === "GET" && url.pathname === "/v1/app/org/members") return listOrganizationMembers(deps, caller);
  if (request.method === "POST" && url.pathname === "/v1/app/org/members/lookup") return lookupOrganizationMember(deps, caller, jsonBody(request));
  if (request.method === "POST" && url.pathname === "/v1/app/org/leave") return leaveOrganization(deps, caller, jsonBody(request));
  if (request.method === "PUT" && url.pathname === "/v1/app/me/name") return setMyName(deps, caller, jsonBody(request));
  const identityRoute = /^\/v1\/app\/me\/identities\/([a-z]{1,16})$/.exec(url.pathname);
  if (identityRoute !== null && request.method === "DELETE") return unlinkAppIdentity(deps, caller, identityRoute[1]!);
  if (identityRoute !== null && request.method === "POST") return startAppIdentityLink(deps, caller, identityRoute[1]!);
  const memberRoute = /^\/v1\/app\/org\/members\/([a-f0-9]{64})(\/role)?$/.exec(url.pathname);
  if (memberRoute !== null && request.method === "PUT" && memberRoute[2] !== undefined) {
    const body = jsonBody(request);
    // Only the trusted cookie adapter supplies authenticated; headers/body cannot opt into legacy authority.
    if (authenticated !== undefined && !OrgMemberRoleChangeBodySchema.required({ expectedRole: true }).safeParse(body).success) throw agentXError("CONFIG_INVALID", "Review a valid company role change before submitting.");
    return changeMemberRole(deps, caller, memberRoute[1]!, body);
  }
  if (memberRoute !== null && request.method === "DELETE" && memberRoute[2] === undefined) return removeOrganizationMember(deps, caller, memberRoute[1]!);
  if (request.method === "GET" && url.pathname === "/v1/dev/budget") return getBudget(deps, caller);
  if (request.method === "PUT" && url.pathname === "/v1/dev/org/budget") return putOrganizationBudget(deps, caller, jsonBody(request));
  if (url.pathname === "/v1/dev/tasks" || url.pathname.startsWith("/v1/dev/tasks/")) {
    if (deps.tasks === undefined) throw agentXError("NOT_FOUND", "developer tasks are not set up in this deployment");
    // An AI tool's start of an older version of an agent that is less safe than the current one waits for the agent's owner (owner decision 2026-10-22), as the app route's does.
    const waitingForOwner = request.method === "POST" && url.pathname === "/v1/dev/tasks" ? await gateDeveloperStart(deps, caller, request) : undefined;
    if (waitingForOwner !== undefined) return waitingForOwner;
    // Rovara Code (Plan 6): a client that does not send `x-agentx-task-view: 2` reads a version 1 projection of any task in the answer.
    return taskResponseForClient(await routeDeveloperTaskRequest(developerTaskRouteDependencies(deps, caller), caller, request, url), request.headers);
  }
  if (url.pathname === CHATGPT_CONNECTION_PATH || url.pathname === `${CHATGPT_CONNECTION_PATH}/finish`) {
    return routeChatGptConnection(deps, caller, request, url);
  }
  // The audit log: the org is the session's, and owners and admins only (the route checks the role before it says anything else).
  if (isAuditOrgPath(url.pathname)) {
    const reply = await routeAuditRequest(deps.auditLedger, { developerId: caller.developerId, orgId: caller.orgId, orgRole: caller.orgRole },
      { method: request.method, body: request.method === "POST" ? jsonBody(request) : {}, requestId: request.requestId }, url);
    return reply.status === 200 ? reply.body : new StatusReply(reply.status, reply.body);
  }
  throw agentXError("NOT_FOUND", "route not found");
}

/**
 * `POST /v1/app/projects` (and its alias `POST /v1/dev/projects`): an owner or admin of a cloud org creates a project from a repository its
 * own GitHub connection reaches. Order: the install, the role, the body; then (the broker, in this order) a replay of the request, whether the
 * connection reaches the repository, GitHub's description of it, the registration as a new name, and the record of the request. Any other
 * install registers projects through an administrator.
 */
async function createProject(deps: DeveloperRouteDependencies, caller: DeveloperCaller, body: unknown): Promise<StatusReply> {
  if (deps.cloud !== true) throw agentXError("FORBIDDEN", "projects on this install are created by an administrator; ask an administrator to run agentx project add");
  if (caller.orgRole !== "owner" && caller.orgRole !== "admin") throw agentXError("FORBIDDEN", "only an owner or admin can create a project; ask your organization's owner");
  if (deps.createProject === undefined) throw agentXError("NOT_FOUND", "project creation is not set up in this deployment");
  const created = await deps.createProject(caller, parseCreateProjectBody(body));
  return new StatusReply(created.duplicate ? 200 : 201, created);
}

/** Per-cell, per-person immutable source adapters keep the five-second appNav cache warm across route dependency objects. Authentication still precedes every call. */
const navigationAdapters = new WeakMap<object, Map<string, { at: number; deps: AppNavDependencies; release: () => void }>>();
async function getAppNavigation(deps: DeveloperRouteDependencies, caller: DeveloperCaller) {
 if (deps.agents === undefined || deps.orgs === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "Navigation is temporarily unavailable. Try again shortly.");
 const agents = deps.agents, orgs = deps.orgs;
 const features = process.env.WEB_FEATURES ?? "";
 const key = [deps.tableName, deps.developer.issuer, caller.orgId, caller.developerId, caller.orgRole, features].join("#");
 let adapters = navigationAdapters.get(deps.documentClient);
 if (adapters === undefined) { adapters = new Map();navigationAdapters.set(deps.documentClient, adapters); }
 let cached = adapters.get(key);
 if (cached === undefined || cached.at + APP_NAV_CACHE_MS <= deps.now()) {
  // RULING Q38: reuse canonical sources and their partitioned access reads; coalesce identical reads, never replace visibility policy.
  const cache = navigationReadCache(deps.documentClient);
  const cachedDeps = { ...deps, documentClient: cache.documentClient };
  const members = projectMembersOf(cachedDeps);
  const cachedAgents = { ...agents, documentClient: cache.documentClient, store: cache.store(agents.store), projectMembers: members };
  const sessionReads = { ...sessionReadDependencies(cachedDeps, caller), documentClient: cache.documentClient, projectMembers: members };
  const reads = { ...sessionReads, approvals: cachedAgents, deciding: sessionReads.deciding ?? decidingOf(cachedAgents) };
  let wall: ReturnType<typeof navigationLive> | undefined;
  const live = () => wall ??= navigationLive(reads, caller);
  const sources: NonNullable<AppNavDependencies["sources"]> = {
   projects: async () => (await members.projectsOf(caller.orgId, caller)).map(project => ({ name: project.project })),
   rosters: async (_who, names) => (await mapLimit(names, REVISION_READS_AT_ONCE, async project => (await listRoster(cachedAgents, caller, project)).filter(agent => !agent.disabled && agent.status === "active").map(agent => ({ project, agentId: agent.agentId, name: agent.name })))).flat(),
   live: async () => (await live()).map(tile => ({ sessionId: tile.sessionId, ...(tile.project === undefined ? {} : { project: tile.project }), ...(tile.agent === undefined ? {} : { agentId: tile.agent.agentId }), running: true, needsYou: tile.needsYou })),
   home: async () => homeCards(reads, caller),
   sharedAgents: async () => (await listVisibleAgents(cachedAgents, caller, "shared")).map(agent => ({ agentId: agent.agentId, name: agent.name })),
   sharedSessions: async () => (await listSessions(reads, caller, { shared: "me", status: "open", limit: 10 })).sessions.map(session => ({ sessionId: session.sessionId, title: session.title, ...(session.endedAt === undefined ? {} : { endedAt: session.endedAt }) })),
   org: async () => { const org = await orgs.getOrg(caller.orgId);if (org === undefined) throw agentXError("NOT_FOUND", "your organization was not found");return org; },
  };
  // PLAN8: local-agent product capabilities are not part of this web launch.
  cached = { at: deps.now(), deps: { sources, now: deps.now, webFeatures: features, localAgents: false }, release: cache.release };
  adapters.delete(key);adapters.set(key, cached);
  if (adapters.size > 256) { const first = adapters.keys().next().value;if (first !== undefined) adapters.delete(first); }
 }
 try { return await appNav(cached.deps, caller); }
 catch (error) { if (adapters.get(key) === cached) adapters.delete(key);throw error; }
 finally { cached.release(); }
}

/** `GET /v1/app/me`: the caller, their org, and every sign-in method linked to them. Never the providers' issuers or subjects. */
async function getAppMe(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<AppMeResponse> {
  if (deps.orgs === undefined) throw agentXError("NOT_FOUND", "organizations are not set up in this deployment");
  const org = await deps.orgs.getOrg(caller.orgId);
  if (org === undefined) throw agentXError("NOT_FOUND", "your organization was not found");
  const store = new DeveloperSignInStore({ documentClient: deps.documentClient, tableName: deps.developer.signInTableName, now: deps.now });
  return {
    developer: { id: caller.developerId, name: caller.name, ...(caller.email === undefined ? {} : { email: caller.email }), orgRole: caller.orgRole, nameChosen: caller.nameChosen === true },
    org: { orgId: org.orgId, name: org.name, plan: org.plan, nameIsDefault: org.nameIsDefault ?? org.createdBy !== "system", ...(orgTrial(org) === undefined ? {} : { trial: orgTrial(org) }) },
    identities: await store.identitiesOf(caller.developerId),
  };
}

/**
 * `PUT /v1/app/me/name` (release 0.4.16): the signed-in person chooses the name teammates see. The person is the verified session's (`caller.developerId`), never anything the
 * body carries, and the body is the name alone. A sign-in leaves a chosen name alone. Written with a `member.renamed` audit record (no name in it).
 */
async function setMyName(deps: DeveloperRouteDependencies, caller: DeveloperCaller, body: unknown): Promise<SetMyNameResponse> {
  const parsed = SetMyNameBodySchema.safeParse(body);
  if (!parsed.success) throw bodyError(parsed.error);
  const store = new DeveloperSignInStore({ documentClient: deps.documentClient, tableName: deps.developer.signInTableName, nameTableName: deps.tableName, now: deps.now, ...(deps.audit === undefined ? {} : { audit: deps.audit }) });
  const record = await store.setChosenDisplayName({ developerId: caller.developerId, orgId: caller.orgId, name: parsed.data.name });
  logDeveloperEvent({ event: "developer.name_chosen" });
  return { name: record.displayName, nameChosen: true };
}

/**
 * `DELETE /v1/app/me/identities/{provider}`: removes one of the caller's own sign-in methods. The developer is the verified token's
 * (`caller.developerId`), never anything the request carries. Its sessions end, the others' go on; the answer lists what is left.
 */
async function unlinkAppIdentity(deps: DeveloperRouteDependencies, caller: DeveloperCaller, provider: string): Promise<{ identities: LinkedIdentity[] }> {
  const method = UnlinkableSignInMethodSchema.safeParse(provider);
  if (!method.success) throw agentXError("CONFIG_INVALID", "name the sign-in method to remove: cloud or github");
  if (deps.developer.unlinkIdentity === undefined) throw agentXError("NOT_FOUND", "removing a sign-in method is not set up in this deployment");
  const answer = await deps.developer.unlinkIdentity({ kind: "unlink-identity", developerId: caller.developerId, sessionId: caller.sessionId, provider: method.data });
  if (!answer.ok) {
    // Removing a method needs a fresh sign-in with another method (Plan 2, Task 8b); the message says which is missing.
    if (answer.error === "reauth") throw agentXError("REAUTH_REQUIRED", answer.message);
    if (answer.error === "refused") throw agentXError("CONFIG_INVALID", answer.message);
    if (answer.error === "not_found") throw agentXError("NOT_FOUND", "that sign-in method is not linked to your account");
    throw agentXError("RUNTIME_UNAVAILABLE", "removing the sign-in method did not complete; try again");
  }
  logDeveloperEvent({ event: "developer.identity_unlinked", provider: method.data });
  return { identities: await signInStoreOf(deps).identitiesOf(caller.developerId) };
}

/**
 * `POST /v1/app/me/identities/{provider}`: starts adding a sign-in method the caller removed earlier back to their own account. The
 * developer and the session are the verified token's (`caller`), never anything the request carries; the session must be fresh. The answer
 * is the sign-in link to open, which links the identity back only to this developer.
 */
async function startAppIdentityLink(deps: DeveloperRouteDependencies, caller: DeveloperCaller, provider: string): Promise<StartIdentityLinkAppResponse> {
  const method = UnlinkableSignInMethodSchema.safeParse(provider);
  if (!method.success) throw agentXError("CONFIG_INVALID", "name the sign-in method to add back: cloud or github");
  if (deps.developer.startIdentityLink === undefined) throw agentXError("NOT_FOUND", "adding a sign-in method back is not set up in this deployment");
  const answer = await deps.developer.startIdentityLink({ kind: "start-identity-link", developerId: caller.developerId, sessionId: caller.sessionId, provider: method.data });
  if (!answer.ok) {
    if (answer.error === "reauth") throw agentXError("REAUTH_REQUIRED", answer.message);
    if (answer.error === "refused") throw agentXError("CONFIG_INVALID", answer.message);
    throw agentXError("RUNTIME_UNAVAILABLE", "adding the sign-in method back did not start; try again");
  }
  logDeveloperEvent({ event: "developer.identity_link_started", provider: method.data });
  return { authorizeUrl: answer.authorizeUrl };
}

/** The caller's own org and their role in it. */
async function getOrganization(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<{ org: { orgId: OrgId; name: string; plan: string }; role: OrgRole }> {
  if (deps.orgs === undefined) throw agentXError("NOT_FOUND", "organizations are not set up in this deployment");
  const org = await deps.orgs.getOrg(caller.orgId);
  if (org === undefined) throw agentXError("NOT_FOUND", "your organization was not found");
  return { org: { orgId: org.orgId, name: org.name, plan: org.plan }, role: caller.orgRole };
}



/**
 * An owner or admin invites someone to their org; only an owner may invite an admin. A replay of one requestId is
 * refused (IDEMPOTENCY_CONFLICT) because only the token's hash is stored, so the first link cannot be given again.
 */
async function createOrganizationInvite(deps: DeveloperRouteDependencies, caller: DeveloperCaller, body: unknown): Promise<{ inviteUrl: string }> {
  if (deps.orgs === undefined) throw agentXError("NOT_FOUND", "organizations are not set up in this deployment");
  let live: Record<string, unknown> | undefined;
  try { const answer = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: orgMemberKey(caller.orgId, caller.developerId), ConsistentRead: true })) as { Item?: Record<string, unknown> };live = answer.Item; } catch { throw agentXError("RUNTIME_UNAVAILABLE", "Invite access could not be checked. Try again."); }
  if (live?.orgId !== caller.orgId || live.developerId !== caller.developerId || (live.role !== "owner" && live.role !== "admin")) throw agentXError("FORBIDDEN", "only an owner or admin can invite people to the organization");
  const parsed = CreateOrganizationInviteBodySchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // Field names only: the values are the caller's.
    throw agentXError("CONFIG_INVALID", `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
  }
  const { requestId, role, email } = parsed.data;
  if (role === "admin" && live.role !== "owner") throw agentXError("FORBIDDEN", "only an owner can invite an admin; an admin can invite members");
  const { token } = await deps.orgs.createInvite({ orgId: caller.orgId, createdBy: caller.developerId, role, requestId, ...(email === undefined ? {} : { email }) });
  logDeveloperEvent({ event: "developer.org_invite_created", orgId: caller.orgId, role, targeted: String(email !== undefined) });
  // A cloud install shares the web app's link, with the token in the fragment so a static host never receives it. A private install's
  // link points at its own cell, which reads the token server-side, so it keeps the query.
  return { inviteUrl: deps.cloud === true
    ? inviteUrl(`${deps.developer.webOrigin ?? DEFAULT_ROVARA_WEB_ORIGIN}/join`, token, "fragment")
    : inviteUrl(`${deps.developer.issuer}/join`, token, "query") };
}

// The State table is given for the name a person chose (release 0.4.18): the store shows it instead of the sign-in record's.
const signInStoreOf = (deps: DeveloperRouteDependencies) => new DeveloperSignInStore({ documentClient: deps.documentClient, tableName: deps.developer.signInTableName, nameTableName: deps.tableName, now: deps.now });

const bodyError = (error: z.ZodError) => {
  const issue = error.issues[0];
  // Field names only: the values are the caller's.
  return agentXError("CONFIG_INVALID", `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
};

const ChangeRoleBodySchema = OrgMemberRoleChangeBodySchema;

/** `PUT /v1/app/org/members/{developerId}/role`: owners only. Demoting the last owner is LAST_OWNER (409). */
async function changeMemberRole(deps: DeveloperRouteDependencies, caller: DeveloperCaller, developerId: string, body: unknown): Promise<{ developerId: string; role: OrgRole }> {
  if (deps.orgs === undefined) throw agentXError("NOT_FOUND", "organizations are not set up in this deployment");
  const reviewed = typeof body === "object" && body !== null && Object.hasOwn(body, "expectedRole");
  // Preserve the released CLI's owner-first check and field-specific validation on legacy bodies.
  if (!reviewed && caller.orgRole !== "owner") throw agentXError("FORBIDDEN", "only an owner can change roles");
  const parsed = ChangeRoleBodySchema.safeParse(body);
  if (!parsed.success) throw reviewed ? agentXError("CONFIG_INVALID", "Review a valid company role change before submitting.") : bodyError(parsed.error);
  if (parsed.data.expectedRole !== undefined) return changeReviewedMemberRole(deps, caller, developerId, { ...parsed.data, expectedRole: parsed.data.expectedRole });
  if (caller.orgRole !== "owner") throw agentXError("FORBIDDEN", "only an owner can change roles");
  await deps.orgs.setRole({ orgId: caller.orgId, developerId, role: parsed.data.role, by: { kind: "member", id: caller.developerId }, requestId: parsed.data.requestId });
  logDeveloperEvent({ event: "developer.org_role_changed", orgId: caller.orgId, role: parsed.data.role });
  return { developerId, role: parsed.data.role };
}

/**
 * Ends a removed person's sign-in sessions through DeveloperIdentity. They are already refused (the membership is gone), so a failure
 * here is logged and never fails the removal.
 */
async function endSessionsAfterRemoval(deps: DeveloperRouteDependencies, developerId: string): Promise<void> {
  if (deps.developer.endDeveloperSessions === undefined) return;
  try {
    const answer = await deps.developer.endDeveloperSessions({ kind: "end-developer-sessions", developerId, at: new Date(deps.now()).toISOString() });
    if (!answer.ok && answer.error !== "not_found") logDeveloperEvent({ event: "developer.org_removal_sessions_not_ended", reason: answer.error });
  } catch (error) {
    logDeveloperEvent({ event: "developer.org_removal_sessions_not_ended", reason: errorName(error) });
  }
}

/** Every address that may hold a person's `ORG_EMAIL#` pointer: their developer record's and each linked identity's. */
async function emailsOf(store: DeveloperSignInStore, developerId: string): Promise<string[]> {
  const [record, identities] = await Promise.all([store.getDeveloper(developerId), store.identitiesOf(developerId)]);
  return [...new Set([record?.email, ...identities.map((identity) => identity.email)].filter((email): email is string => typeof email === "string"))];
}

const STOPS_AFTER_STEP = (name: string) => `${name}'s running tasks will stop after their current step. None of them will open a pull request.`;

/**
 * `DELETE /v1/app/org/members/{developerId}`. Owners may remove anyone but the last owner, admins members only; nobody removes themselves
 * (leaving has its own route). Their sessions end, and ruling R60 stops their running tasks at the next dispatch. A private install
 * bans the person from signing back in to its one org until an invite clears it; a cloud install lets them start a new org.
 */
async function removeOrganizationMember(deps: DeveloperRouteDependencies, caller: DeveloperCaller, developerId: string): Promise<{ removed: { developerId: string; name: string }; message: string }> {
  if (deps.orgs === undefined) throw agentXError("NOT_FOUND", "organizations are not set up in this deployment");
  if (caller.orgRole !== "owner" && caller.orgRole !== "admin") throw agentXError("FORBIDDEN", "only an owner or admin can remove people from the organization");
  if (developerId === caller.developerId) throw agentXError("FORBIDDEN", "use agentx org leave to leave");
  const target = (await deps.orgs.listMembers(caller.orgId)).find((member) => member.developerId === developerId);
  if (target === undefined) throw agentXError("NOT_FOUND", "that person is not a member of the organization");
  if (caller.orgRole === "admin" && target.role !== "member") throw agentXError("FORBIDDEN", "an admin can remove members only; ask an owner to remove an owner or admin");
  const store = signInStoreOf(deps);
  const [record, emails] = await Promise.all([store.getDeveloper(developerId), emailsOf(store, developerId)]);
  await deps.orgs.removeMember({ orgId: caller.orgId, developerId, emails, ban: deps.cloud !== true, expectedRole: target.role, by: { kind: "member", id: caller.developerId } });
  await endSessionsAfterRemoval(deps, developerId);
  const name = record?.displayName ?? "That person";
  logDeveloperEvent({ event: "developer.org_member_removed", orgId: caller.orgId, role: target.role, banned: String(deps.cloud !== true) });
  return { removed: { developerId, name }, message: STOPS_AFTER_STEP(name) };
}

/**
 * The plan's route text is `body { requestId }`. Leave needs no request record: a repeat finds the person out of the org and is refused at
 * sign-in, so an id could never be replayed. The id is accepted and ignored, so a client written to the plan works; other keys are refused.
 */
const LeaveBodySchema = z.object({ requestId: z.string().uuid().optional() }).strict();

/**
 * `POST /v1/app/org/leave`. Members and admins leave. An owner leaves when another owner exists; an owner who is the only member
 * closes the org (its GitHub connection and Slack workspace are released, its projects archived). Otherwise LAST_OWNER (409).
 */
async function leaveOrganization(deps: DeveloperRouteDependencies, caller: DeveloperCaller, body: unknown): Promise<{ left: true; orgClosed: boolean; message: string }> {
  if (deps.orgs === undefined) throw agentXError("NOT_FOUND", "organizations are not set up in this deployment");
  const parsed = LeaveBodySchema.safeParse(body);
  if (!parsed.success) throw bodyError(parsed.error);
  const store = signInStoreOf(deps);
  const emails = await emailsOf(store, caller.developerId);
  const sole = caller.orgRole === "owner" && (await deps.orgs.listMembers(caller.orgId)).every((member) => member.developerId === caller.developerId);
  // Ruling (Task 4, Minor 6): closing is for cloud orgs. A private install's only org is never closed: a closed org would take every
  // later sign-in with no owner. Its sole owner promotes someone else first.
  if (sole && deps.cloud !== true) throw agentXError("LAST_OWNER", LAST_OWNER_MESSAGE);
  if (sole) {
    const connections = deps.orgConnections ?? deps.agents?.connections;
    const clearConnections = deps.closeOrgHooks?.clearConnections ?? (connections === undefined ? undefined : (orgId: OrgId) => clearOrgConnections({ store: connections }, orgId));
    const triggers = deps.agents?.triggers;
    const clearTriggers = deps.closeOrgHooks?.clearTriggers ?? (triggers === undefined ? undefined : (orgId: OrgId) => deleteOrgTriggers({ triggers, ...(deps.agents?.triggerSchedules === undefined ? {} : { triggerSchedules: deps.agents.triggerSchedules }) }, orgId));
    const eventHooks = deps.agents?.eventHooks;
    const clearHooks = deps.closeOrgHooks?.clearHooks ?? (eventHooks === undefined ? undefined : (orgId: OrgId) => clearOrgHooks({ store: eventHooks.store, secrets: eventHooks.secrets }, orgId));
    const modelSources = deps.agents?.modelSources;
    const releaseModelSources = deps.closeOrgHooks?.releaseModelSources ?? (modelSources === undefined ? undefined : (orgId: OrgId) => releaseOrgModelSources(modelSources, orgId));
    // Plan 5 Task 21: the org's sessions go with it (live index, work entries, devices, change feeds; the rest expires in 30 days).
    // Plan 5 Task 21 review M-6: running work is asked to stop through the session stop (the task's own cancel, idempotent by a request id derived from the session), as the person who is leaving.
    const stopWork = deps.closeOrgHooks?.stopWork ?? (async (orgId: OrgId) => {
      let sessionDeps: SessionRouteDependencies;
      try {
        sessionDeps = sessionReadDependencies(deps, caller);
      } catch (error) {
        console.log(JSON.stringify({ component: "broker", event: "agent_session.close_stop_unavailable", orgId, error: error instanceof Error ? error.name : "unknown" }));
        return;
      }
      await stopOrgSessions({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, deadline: deps.now() + CLOSE_STOP_BUDGET_MS }, orgId, async (sessionId, requestId) => { await stopSession(sessionDeps, caller, sessionId, { requestId }); });
    });
    const clearSessions = deps.closeOrgHooks?.clearSessions ?? ((orgId: OrgId) => closeOrgSessions({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now }, orgId));
    await deps.orgs.closeOrg(caller.orgId, {
      archiveProjects: deps.closeOrgHooks?.archiveProjects ?? ((orgId) => archiveOrgProjects(archiveDepsOf(deps), orgId, { developerId: caller.developerId })), clearEgress: deps.closeOrgHooks?.clearEgress ?? ((orgId) => clearOrgEgress(egressDepsOf(deps), orgId)),
      // Plan 3 Task 12, PF11: the org's connection secrets are scheduled for deletion with the org.
      ...(clearConnections === undefined ? {} : { clearConnections }),
      // Plan 4 Task 18: the org's triggers, their activity and their notices go with it (and, Task 26, the schedules of its schedule triggers).
      ...(clearTriggers === undefined ? {} : { clearTriggers }),
      // Plan 4 Task 19: its event hooks stop receiving, and their secrets are scheduled for deletion.
      ...(clearHooks === undefined ? {} : { clearHooks }),
      // The org's company AI sources leave the model proxy with it, vendor keys included (Task 24b).
      ...(releaseModelSources === undefined ? {} : { releaseModelSources }),
      clearSessions,
      stopWork,
      emails,
      by: { kind: "member", id: caller.developerId },
    });
  } else {
    await deps.orgs.removeMember({ orgId: caller.orgId, developerId: caller.developerId, emails, ban: false, by: { kind: "member", id: caller.developerId } });
  }
  await endSessionsAfterRemoval(deps, caller.developerId);
  logDeveloperEvent({ event: "developer.org_left", orgId: caller.orgId, role: caller.orgRole, closed: String(sole) });
  return { left: true, orgClosed: sole, message: sole ? "You left and the organization is closed." : STOPS_AFTER_STEP(caller.name) };
}

function budgetDependencies(deps: DeveloperRouteDependencies): BudgetDependencies {
  if (deps.modelAccess === undefined) throw agentXError("NOT_FOUND", "budgets are not set up in this deployment");
  return { documentClient: deps.documentClient, tableName: deps.tableName, access: deps.modelAccess, cloud: deps.cloud === true, ...(deps.audit === undefined ? {} : { audit: deps.audit }) };
}

/** What the caller and their org have spent this month, and their limits: LiteLLM's figures (ruling R22), which a soft cap can leave over the limit (ruling R23). */
async function getBudget(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<{ member: { spentUsd: number; limitUsd: number | null }; org: { spentUsd: number; limitUsd: number | null } }> {
  const budgets = budgetDependencies(deps);
  const settings = await ensureSynced(budgets, caller.orgId, caller.developerId);
  const { member, org } = await budgets.access.spend(caller.orgId, caller.developerId);
  // Ruling R47: a limit that is not set is shown as none, not as the proxy's stand-in figure.
  return {
    member: { spentUsd: member.spentUsd, limitUsd: memberLimitOf(settings, caller.developerId) === undefined ? null : member.limitUsd },
    org: { spentUsd: org.spentUsd, limitUsd: settings.orgMonthlyUsd === undefined ? null : org.limitUsd },
  };
}

/**
 * An owner or admin sets the org's monthly limit, the members' default, and per-member overrides (changeBudgets).
 * If the proxy cannot be reached the settings stand and the call answers 503.
 */
async function putOrganizationBudget(deps: DeveloperRouteDependencies, caller: DeveloperCaller, body: unknown): Promise<{ budget: OrgBudgetSettings }> {
  if (caller.orgRole !== "owner" && caller.orgRole !== "admin") throw agentXError("FORBIDDEN", "only an owner or admin can change the organization's budgets");
  const budgets = budgetDependencies(deps);
  if (deps.orgs === undefined) throw agentXError("NOT_FOUND", "organizations are not set up in this deployment");
  const budget = await changeBudgets({ ...budgets, orgs: deps.orgs }, { authority: { developerId: caller.developerId, role: caller.orgRole }, orgId: caller.orgId, body, updatedBy: caller.developerId, at: new Date(deps.now()).toISOString() });
  logDeveloperEvent({ event: "developer.org_budget_changed", orgId: caller.orgId, overrides: String(Object.keys(budget.memberOverrides).length) });
  return { budget };
}

/** Sign in with ChatGPT (#338): the caller's own connection, and only theirs. No route answers a token. */
export const CHATGPT_CONNECTION_PATH = "/v1/dev/chatgpt/connection";

async function routeChatGptConnection(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  if (deps.chatgpt === undefined) throw agentXError("NOT_FOUND", "Sign in with ChatGPT is not set up in this deployment");
  const finish = url.pathname.endsWith("/finish");
  if (finish && request.method === "POST") return deps.chatgpt.finish(caller.developerId, jsonBody(request));
  if (!finish && request.method === "GET") return deps.chatgpt.view(caller.developerId);
  if (!finish && request.method === "POST") return deps.chatgpt.start(caller.developerId);
  if (!finish && request.method === "DELETE") return deps.chatgpt.disconnect(caller.developerId);
  throw agentXError("NOT_FOUND", "route not found");
}

function jsonBody(request: AdaptedHttpRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try {
    return JSON.parse(request.body) as unknown;
  } catch {
    throw agentXError("CONFIG_INVALID", "the request body is not JSON");
  }
}
