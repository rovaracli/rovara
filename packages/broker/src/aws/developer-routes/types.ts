import type { ServiceCatalogSource } from "../../test-env/dependency-plan.js";
import type { TeamRecordRuntime } from "../../team-record/runtime.js";
import type { EvidenceErase } from "../../rovara-code/evidence-erase.js";
import type { CreateProjectFromMetaBody, EditionPolicy } from "@agentx/contracts";
import type { CodeHostRouter } from "../../plugins/registry.js";
import type { LessonViewDeps } from "../../lessons/view.js";
import type { ApproveDeps } from "../../lessons/approve.js";
import type { ProcessDeps } from "../../lessons/process.js";
import type { CounterDeps } from "../../lessons/counters.js";
import type { LoadedKnowledgeRouteDependencies } from "../../developer/loaded-knowledge.js";
import type { MetaProjectCreated } from "../../org/create-from-meta.js";
import type { MetaConfigDependencies } from "../../meta-repo/config-import.js";
import type { SavedEnvDeps } from "../../test-env/saved-env.js";
import type { ServiceStatusDependencies } from "../../org/service-status.js";
import type { AllowedDomainBrowserDependencies } from "../../org/project-allowed-domains-http.js";
import type { WorkingBranchReviewDependencies } from "../../org/project-working-branch.js";
import type { WorkingBranchListDependencies } from "../../org/project-working-branch-list.js";
import type { SlackRequestQueue } from "../../developer/page-comments.js";
import type {
  ChannelByNameRequest,
  ChannelByNameResponse,
  ChannelInfoRequest,
  ChannelInfoResponse,
  ChannelMembersRequest,
  ChannelMembersResponse,
  DeveloperSignInMethod,
  EndDeveloperSessionsRequest,
  EndDeveloperSessionsResponse,
  RealtimeTokenAnswer,
  RealtimeTokenRequest,
  UnlinkIdentityRequest,
  UnlinkIdentityResponse,
  StartIdentityLinkRequest,
  StartIdentityLinkResponse,
  OrgId,
  OrgRole,
  SlackAuthCheckResponse,
  SlackUserByEmailRequest,
  SlackUserByEmailResponse,
  TaskPersonProofRequest,
  TaskPersonProofResponse,
  TaskChannelPeopleRequest,
  TaskChannelPeopleResponse,
  TaskPeopleDisplayReadRequest,
  TaskPeopleDisplayReadResponse,
  MergeTrackingItem,
  MergeView,
} from "@agentx/contracts";
import type { EgressDomainsDependencies } from "../../org/egress-domains.js";
import type { ProjectSettingsDependencies } from "../../org/project-settings.js";
import type { ProjectMembers } from "../../org/project-members.js";
import type { CreateProjectInput } from "../../org/cloud-projects.js";
import type { ModelAccess } from "../../model-proxy/access.js";
import type { OrgStore } from "../../org/store.js";
import type { AuditExportClientDeps } from "../../audit/export.js";
import type { AuditRuntime } from "../../audit/outbox.js";
import type { TxtResolver } from "../../org/company-domains/resolver.js";
import type { ProjectAccessSubject } from "../../developer/task-person-identity.js";
import type { ChatGptConnections } from "../../chatgpt/connections.js";
import type { DeveloperTaskRecord } from "../../developer/task-records.js";
import type { DeveloperTaskActions } from "../developer-task-actions.js";
import type { DeveloperTaskRouteDependencies } from "../developer-tasks.js";
import type { AgentRouteDependencies } from "../../agents/routes.js";
import type { SessionRouteDependencies } from "../../agent-sessions/routes.js";
import type { HandoffRuntime } from "../../agent-sessions/handoff.js";
import type { SessionTakeOverDependencies } from "../../agent-sessions/take-over.js";
import type { OrgConnectionStore } from "../../connections/store.js";
import type { SsoStores } from "../../developer/sso-sign-in.js";
import type { IdentityNoticeDependencies } from "../../developer/identity-notice.js";

/** How long the close spends asking running sessions to stop; the rest are stopped by the model-key mint and the dispatch guard. */
export const CLOSE_STOP_BUDGET_MS = 8_000;

export interface DeveloperApiConfiguration {
  /**
   * Enterprise foundations I4: the issuers of the install's other sign-in methods (the company OpenID Connect provider, the hosted cloud provider, Slack, GitHub, this sign-in server). A SAML entity id
   * equal to one of them is refused when the settings are saved. A defence beside the method prefix in every SAML account key.
   */
  reservedIssuers?: readonly string[];
  issuer: string; env: string; methods: { slack: boolean; oidc: boolean; cloud?: boolean; github?: boolean; saml?: boolean }; slackTeamId?: string;
  /** Each method's enabled-since cutoff, epoch seconds (FR-045): a session started before it was ended by a disable. */
  since?: { slack?: number; oidc?: number; cloud?: number; github?: number; saml?: number };
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
  /** Test services (slice 1): the release's signed service image catalog (`serviceCatalogSourceOf`). The setup draft's dependency candidates become proposed dependencies only with it; without it none are proposed. */
  serviceCatalog?: ServiceCatalogSource;
  /** Saved project images: the registry (store, sessions, ECR), only where the install's `sv` switch is on and it was installed. Without it the project's Environment panel routes do not exist. */
  savedEnv?: SavedEnvDeps;
  /**
   * Meta repo lane B: a file of one of an org's repositories at a commit, as GitHub holds it (undefined when it is not there; throws when GitHub cannot answer). The setup agent's
   * citations are re-read through it. Without it every citation reads `unchecked` and nothing is pre-ticked.
   */
  setupCitationReader?: (orgId: OrgId, repositoryUrl: string, path: string, commit: string, options: { untilLine?: number; timeoutMs: number }) => Promise<string | undefined>;
  /** DG-1 S2: a file of one of an org's repositories at the head of its default branch, as GitHub holds it now. "Apply this change" checks a proposed dev container file with it. Absent: that change cannot be applied. */
  defaultBranchFileReader?: (orgId: OrgId, repositoryUrl: string, path: string, options: { timeoutMs: number }) => Promise<string | undefined>;
  serviceStatus?: Pick<ServiceStatusDependencies, "runtimeStatus">;
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
  readMetaFile?: DeveloperTaskRouteDependencies["readMetaFile"];
  readSpecPullRequest?: DeveloperTaskRouteDependencies["readSpecPullRequest"];
  publishSpecFiles?: DeveloperTaskRouteDependencies["publishSpecFiles"];
  currentBaseCommit?: DeveloperTaskRouteDependencies["currentBaseCommit"];
  taskAutonomyNow?: DeveloperTaskRouteDependencies["taskAutonomyNow"];
  workflowE2EScenarioResults?: DeveloperTaskRouteDependencies["workflowE2EScenarioResults"];
  workflowE2EArtifact?: DeveloperTaskRouteDependencies["workflowE2EArtifact"];
  /** Proof and evidence (wire-proof): present only while the proof switch is on. */
  evidence?: DeveloperTaskRouteDependencies["evidence"];
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
  /** Team record (wire-team-record): the record's runtime, absent while its switch is off. Its routes, and its erase when a project is archived or a company closes. */
  teamRecord?: TeamRecordRuntime;
  /** Proof and evidence (wire-proof fix round 1): deletes the stored evidence of a project or a company when it is archived or closed. Not behind the proof switch: evidence kept while it was on is erased after it is turned off. */
  evidenceErase?: Pick<EvidenceErase, "project" | "workspace">;
  closeOrgHooks?: { archiveProjects: (orgId: OrgId) => Promise<void>; clearEgress: (orgId: OrgId) => Promise<void>; clearConnections?: (orgId: OrgId) => Promise<void>; clearTriggers?: (orgId: OrgId) => Promise<void>; clearHooks?: (orgId: OrgId) => Promise<void>; releaseModelSources?: (orgId: OrgId) => Promise<void>; clearSessions?: (orgId: OrgId) => Promise<void>; stopWork?: (orgId: OrgId) => Promise<void>; clearLearning?: (orgId: OrgId) => Promise<void>; clearTeamRecord?: (orgId: OrgId) => Promise<void> };
  /**
   * Plan 3 Task 11: what follows a project's archive on the agents platform (`onProjectArchived`). Called once the archive has applied, never on a
   * replay; a failure is logged and never undoes or fails the archive. Absent where agents are not set up.
   */
  projectArchived?: (orgId: OrgId, project: string) => Promise<void>;
  /** The model proxy, for budgets (ruling R28). Absent without one: budgets are not set up, and task starts are not checked against them. */
  modelAccess?: ModelAccess;
  /** A cloud install (ruling R42): trial lock and machine-time allowance apply to its orgs. */
  cloud?: boolean;
  /** Enterprise foundations I1: the group mapping and break-glass stores behind the company sign-in routes. Absent where the edition has no company sign-in. */
  sso?: SsoStores;
  /** Enterprise foundations I4: the SES sender the owners are told of a change to the SAML settings through (the sign-in notices' sender). Absent: nothing is sent, and the skip is logged. */
  ownerNotice?: IdentityNoticeDependencies;
  /** Enterprise foundations E2: the edition's feature table. Absent on an install deployed before editions (no gates, today's behaviour). The Auditor role (I2) needs it: without a policy, or with one that has no `auditorRole`, an Auditor's session is refused and the role cannot be given. */
  editionPolicy?: EditionPolicy;
  /** Enterprise foundations P7: the code hosts this install registers (the router's kinds). A task start refuses a repository whose host is not among them. Absent in a harness that builds no registry: no check. */
  codeHost?: Pick<CodeHostRouter, "kinds">;
  /**
   * Plan 2, Task 16: creates a project in the caller's org from a repository the org's GitHub connection reaches, through the broker's
   * registration, and grants the caller access; a replay of the same request answers the same project with `duplicate: true`. The route
   * has already checked the install, the caller's role and the body.
   */
  createProject?: (caller: DeveloperCaller, input: CreateProjectInput) => Promise<{ duplicate: boolean }>;
  /** Meta repo lane A: `POST /v1/app/projects` with a `metaRepository` (same checks as `createProject`, different body). Without it the route answers NOT_FOUND. */
  createFromMeta?: (caller: DeveloperCaller, input: CreateProjectFromMetaBody) => Promise<MetaProjectCreated>;
  /** Meta repo lane A: what the project's meta-config routes need beyond the settings' own pieces: reading the meta repository's head and files. */
  metaConfig?: Pick<MetaConfigDependencies<DeveloperCaller>, "registerRevision" | "githubCredentialRef" | "repositoryIdentity" | "requireRepositoryConnected" | "readMetaFile" | "getHead">;
  /** The Audit Ledger's reader and export client (Task 12). Absent on an install with no ledger: the audit routes then answer NOT_FOUND. */
  auditLedger?: AuditExportClientDeps;
  /** The Audit Ledger's outbox: what a route's audited action adds its pending item through. Absent on a legacy install, where nothing is recorded. */
  audit?: AuditRuntime;
  /** Company domain verification: how the verification record is looked up. Absent: the broker's own DNS (`nodeTxtResolver`). A test gives a fake; no route has a network call of its own. */
  domainResolver?: TxtResolver;
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
  /**
   * Learning v2 L3b: the lesson library's ports for the Lessons tab, the Sources tab and the task page's lessons list (store, approver directory, settings, access port, names, sources table, audit,
   * citation and code checks, the models rollback and the marks use). Built where the Team record is wired. Absent (the default): the lessons routes answer as they did before lessons existed.
   */
  lessons?: LessonViewDeps & ApproveDeps & ProcessDeps & CounterDeps;
  /** K1: the two reads the rule text of "What the agent loaded" needs. Absent: the records are listed and no rule text is served. */
  loadedKnowledge?: Pick<LoadedKnowledgeRouteDependencies, "canReadRepository" | "readRuleFile">;
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

/** Who is asking about a project, and in which org: grants and revisions are read in that org only. */
export type ProjectAccessCaller = ProjectAccessSubject & { orgId: OrgId; orgRole: OrgRole };

export interface DeveloperCaller { developerId: string; sessionId: string; amr: DeveloperSignInMethod; name: string; slackUserId?: string; email?: string; orgId: OrgId; orgRole: OrgRole; /** True only for a caller the web boundary authenticated with a live browser session cookie and its CSRF token (`authenticateWebRequest`); never for a token. */ browserSession?: true;
  /** Release 0.4.16: true once the person chose their own display name (`PUT /v1/app/me/name`). Set by the session read; absent on a caller built another way. */ nameChosen?: boolean }

/** What the broker needs from a Lambda invoke; `@aws-sdk/client-lambda`'s InvokeCommand output fits. */
export interface ChannelMembersInvokeResult { FunctionError?: string | undefined; Payload?: Uint8Array | undefined }
