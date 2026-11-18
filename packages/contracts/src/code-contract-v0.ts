// Contract v0 between Rovara Cloud's web app and Rovara Code (migration plan v3.2, lane W, job W0).
//
// This file has NO imports and no runtime dependencies, so the same bytes can sit in both repositories (plan 3.1, lane CI:
// a byte-identical check; until that check exists, copy it whole and change it in one place first). Cloud's copy is
// `packages/contracts/src/code-contract-v0.ts`; Code's copy goes in its contracts package under the same file name.
//
// It describes two layers.
//   1. CODE_ROUTES: the calls Cloud's server makes to Code as the signed-in person (plan 2.5 path 1). Each has a typed
//      request and response (CodeRouteTypes), who may call it, and whether Code serves it today. This is what Code builds
//      to and what the fake Code (scripts/fake-code.ts) implements.
//   2. APP_ROUTES: the calls the web app makes to Cloud (`/v1/app/*`, which the browser calls as `/v1/web/*`), who owns
//      each (plan 2.2), and which Code routes back it. Their answer shapes are the app's reader schemas
//      (`@agentx/cloud-contracts/web` on integ/0519; `@agentx/contracts/web` here), named by `source`.
//
// "Served" means what a Rovara Code install that Cloud points at answers (ROVARA_CODE_URL): the deployed API.
// `awsApi` says `yes` (public code/next serves it) or `no`. A `no` route whose code exists only in code/next's laptop core
// (decision cards, the evidence read, understanding answers, the playbook, script tokens) names `arrivesWith: "E2"`: it is
// NOT served anywhere today and arrives when the core runs on AWS (lane E2), not as an adapter on the old broker. `mainline` says whether Code's release branch serves it (so it
// arrives with the second sync). Counts were taken on code/next 7c6ee20ab, mainline 1e1ce33e8 and the web app on
// integ/0519 3b408ae40. A route not served answers 501 NOT_ON_CODE_YET through Cloud (never a guess).

export const CODE_CONTRACT_V0_VERSION = "0.1.0";

// ---------------------------------------------------------------------------------------------------------------
// Vocabulary

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type AwsApi = "yes" | "no";
export type Owner = "code" | "cloud" | "gateway";
/** The named scope Cloud's token needs for the call (plan 7.2). `full` is today's full access, to be narrowed by lane ID. */
export type Scope = "none" | "full" | "projects:members" | "projects:create";
/** The must-pass screens (plan 4.2 phase 5), `shell` (every screen) and `later` (not must-pass). */
export type Screen = "shell" | "home" | "request" | "session" | "plan" | "proof" | "how-we-work" | "admin" | "budgets" | "settings" | "later";

export type JsonObject = Record<string, unknown>;
export type DeveloperId = string;
export type TaskId = string;
export type Iso = string;

/** The error body every refusal carries (Code: `{ error: { code, message } }`), with the HTTP status. */
export interface ErrorBody { error: { code: string; message: string } }

// ---------------------------------------------------------------------------------------------------------------
// Types: sign-in and the person

export interface TokenRequestCode { grant_type: "authorization_code"; code: string; code_verifier: string; redirect_uri: string }
export interface TokenRequestRefresh { grant_type: "refresh_token"; refresh_token: string }
export interface TokenResponse { access_token: string; refresh_token?: string; token_type?: "Bearer"; scope?: string }

/** Who the person is and what they may use (Code spec 063 FR-004). The reply to `POST /v1/dev/access`. */
export interface AccessResponse {
  developerId: DeveloperId;
  displayName: string;
  /** True once the person chose their own name; an older Code leaves it out. */
  nameChosen?: boolean;
  /** Code's install administrator. Not the company role: Cloud reads `companyRole` for that (DEC 253z). */
  administrator: boolean;
  /** The person's company from live membership (Code PR #820, DEC 253z). All three are absent when Code names no company; Cloud then refuses company routes. */
  companyId?: string;
  companyRole?: "owner" | "admin" | "member";
  companyName?: string;
  /** True only when this session's sign-in spent an invite secret or a pre-approval for the session's company (Code PR #826); absent otherwise. */
  joinedByInvite?: boolean;
  /** L4-SIGNIN: the Slack workspace id of the person's own Slack sign-in (a "T" and 6 to 15 capitals or digits); absent for any other sign-in. */
  slackTeamId?: string;
  projects: Array<{ name: string; access: string /* known: administrator, developer */ }>;
  notices: string[];
}

export interface SetNameRequest { name: string }
export interface SetNameResponse { name: string; nameChosen: true }

export interface ChannelLink { channel: string; workspace: string; account: string; displayName?: string; linkedAt: Iso }

// ---------------------------------------------------------------------------------------------------------------
// Types: projects, repositories, project members

export interface ProjectRepository { name: string; url: string; defaultBranch: string; fullName?: string }
export interface ProjectView { name: string; latestRevision: number; access: string /* known: administrator, developer */; repositories: ProjectRepository[] }
export interface CreateProjectRequest { repository: string; name?: string; setupCommands?: string[]; testCommands?: string[] }
/** Guided onboarding PR 10 (Code PR #837): the same route with `repositories` (1 to 32) instead of `repository` makes ONE project holding them all. */
export interface CreateProjectsRequest { repositories: string[]; name?: string; setupCommands?: string[]; testCommands?: string[] }
export interface CreateProjectResponse { name: string }
/** `POST /v1/dev/client/projects/bulk`: one project per repository; a repository that made none says why, in Code's four fixed words. */
export interface BulkCreateProjectsRequest { repositories: string[] }
export interface BulkCreateProjectsResponse { results: Array<{ repository: string; outcome: "created"; project: string } | { repository: string; outcome: "refused"; reason: "not_available" | "name_taken" | "unavailable" | "not_started" }> }
/** `GET /v1/dev/client/repositories/available?q=&limit=&after=`: the repositories the caller's company's connected GitHub accounts reach, with the company's own projects that hold each. */
export interface RepositoryChoicesResponse {
  repositories: Array<{ installationId: number; accountLogin: string; fullName: string; githubRepositoryId: number; private: boolean; defaultBranch: string; projects: string[] }>;
  next?: string;
  incomplete: boolean;
}
export interface GithubInstallation {
  installationId: number; accountLogin: string; accountType: string; repositorySelection: string; status: string;
  repositories: Array<{ fullName: string; githubRepositoryId: number; private: boolean; defaultBranch: string }>;
}
export interface RepositoriesResponse { installations: GithubInstallation[] }
export interface ProjectMember { developerId: DeveloperId; name: string; role: string /* known: administrator, developer */ }
export interface MembersResponse { members: ProjectMember[] }
export interface PutMemberResponse { developerId: DeveloperId }
export interface RemoveMemberResponse { developerId: DeveloperId; outcome: string /* known: revoked, not_a_member */ }

/** Code's project settings read for merge rules (project page "code settings"); proposed. */
export interface CodeSettings { requireSecondReviewer: boolean; mergeRule: "owner" | "maintainer" | "two_people"; protectedPaths: string[]; revision: number }
export interface PutCodeSettingsRequest { requestId: string; expectedRevision: number; settings: Omit<CodeSettings, "revision"> }

// ---------------------------------------------------------------------------------------------------------------
// Types: tasks and the workflow (Code's task view version 2 is sent when the call carries `x-agentx-task-view: 2`)

export type TaskStatus = "STARTING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "INTERRUPTED" | "CLOSED";
/** Code's workflow stages and states, as its task view sends them (task-workflow.ts `WorkflowStageSchema`, `WorkflowStateSchema`). A newer Code may send others. */
export type WorkflowStage = "UNDERSTAND" | "PLAN" | "PLAN_CRITIQUE" | "PLAN_REVIEW" | "IMPLEMENT" | "VERIFY" | "REVIEW" | "PULL_REQUEST" | "WAIT_FOR_MERGE" | "MERGED" | "CLOSED";
export type WorkflowState = "READY" | "RUNNING" | "WAITING" | "BLOCKED" | "COMPLETE";

/** One saved document of the workflow (task-workflow.ts `WorkflowArtifactSchema`): every field below is required in Code's view. */
export interface WorkflowArtifact {
  id: string;
  type: "requirements" | "design" | "plan" | "test_plan" | "review_report" | "answer";
  version: number;
  /** 64 lowercase hex characters. */
  sha256: string;
  producer: string;
  objectKey: string;
  createdAt: Iso;
  format?: "markdown" | "structured";
}
export interface WorkflowReview { operationId?: string; role?: string /* known: CRITIC, SECURITY */; status?: string /* known: PASS, FINDINGS, FAILED, INTERRUPTED, UNKNOWN */; failureReason?: string; candidateDigest?: string; findings?: Array<{ advisory?: boolean; origin?: string } | string>; [field: string]: unknown }
/**
 * Code's workflow snapshot (task-workflow.ts `WorkflowSnapshotViewSchema`). The first block is what the app's task reader REQUIRES: a snapshot missing any of
 * them makes the whole task unreadable, which the app shows as "Rovara returned an unreadable response" (found by running Cloud on the fake Code).
 */
export interface TaskWorkflow {
  schemaVersion: 1;
  definitionId: "agentx-task-to-pr";
  /** `1.0.0` or `1.1.0` (Rovara Code v2: the UNDERSTAND and PLAN_CRITIQUE stages). */
  definitionVersion: string;
  taskId: TaskId;
  /** 64 lowercase hex characters: the task owner's developer id. */
  ownerId: DeveloperId;
  revision: number;
  stage: WorkflowStage;
  state: WorkflowState;
  createdAt: Iso;
  updatedAt: Iso;
  artifacts: WorkflowArtifact[];
  /** The decisions made so far (`WorkflowDecisionRecordSchema`); empty before the first. */
  decisions: JsonObject[];
  path?: string /* known: QUICK, STANDARD */;
  outcome?: string /* known: PASSED, SKIPPED, CHANGES_REQUESTED, REJECTED, MERGED, CLOSED, ANSWERED */;
  blockReason?: string;
  candidate?: { digest?: string };
  verification?: { candidateDigest?: string; reviewOnly?: boolean; results?: Array<{ checkId?: string; status?: string }>; [field: string]: unknown };
  reviews?: WorkflowReview[];
  pullRequests?: JsonObject[];
  [field: string]: unknown;
}
export interface TaskPullRequest { repository?: string; number?: number; url?: string; state?: string /* known: open, merged, closed */ }
/** Code's task view, as much as Cloud reads. Cloud passes the whole object through to the app, so extra fields are allowed. */
export interface TaskView {
  taskId: TaskId;
  title: string;
  project: string;
  status: TaskStatus;
  startingRevision?: number;
  client?: string;
  shared?: boolean;
  workflow?: TaskWorkflow;
  pullRequests?: TaskPullRequest[];
  events?: unknown[];
  changedFiles?: unknown[];
  artifacts?: unknown[];
  createdAt: Iso;
  updatedAt: Iso;
  [field: string]: unknown;
}

export interface StartTaskRequest {
  /** A UUID: a repeat of the same request answers the same task. */
  requestId: string;
  project: string;
  instructions: string;
  workflow?: boolean;
  workflowPath?: string /* known: QUICK, STANDARD */;
  client?: string;
  designFirst?: boolean;
}
export interface TaskResponse { task: TaskView }
export interface TaskListResponse { tasks: TaskView[]; nextCursor?: string }
export interface TaskEvent {
  seq: number; at: Iso; kind: string /* Code's kinds: status, progress, tool, message, error */; text?: string;
  /** Optional (UX audit 2026-11-15): the plan task (`SpecTask.id`) this line belongs to, so live lines group under it; and which try of that task. */
  taskItemId?: string;
  attempt?: number;
  [field: string]: unknown;
}
export interface TaskEventsResponse { events: TaskEvent[]; next?: string }

/**
 * One stored version of the task's plan (`GET /v1/dev/tasks/{id}/plan`, Code's PLANFULLDOC `aws/task-plan-document.ts` TaskPlanDocumentView), as Code answers it: wrapped in
 * `{ plan }`. `content` is the canonical plan document (its `title`, `claims` with ids "1", "1.1", and `decisions` with options and Code's `recommended` one); `summary` is
 * Code's plan-check summary (`checks` with a `label` each, `lines`, ...). Code names no estimate, run limit or task status here. Cloud's work-reads.ts turns it into what the
 * spec screen draws (SpecRequirement, UnderstandingQuestion).
 */
export interface PlanView {
  taskId: TaskId;
  document: "requirements" | "design" | "plan";
  version: number;
  sha256: string;
  approved: boolean;
  current: boolean;
  versions: readonly number[];
  /** The canonical plan document, whole. Untrusted model text. */
  content: JsonObject;
  summary: JsonObject;
}
export interface PlanResponse { plan: PlanView }

/** A requirement of the structured spec. Ids are stable across plan versions (a changed requirement keeps its id). */
export interface SpecRequirement { id: string; title: string; criteria: SpecCriterion[] }
/** One acceptance criterion: when ..., then ... . `taskIds` are the plan tasks that build it. */
export interface SpecCriterion { id: string; when: string; then: string; taskIds?: string[] }
/** A task of the plan. `criterionIds` are the criteria it serves. */
export interface SpecTask { id: string; title: string; status: "todo" | "running" | "done" | "blocked"; criterionIds?: string[] }
/** One understanding question. `criterionId` ties it to the criterion it settles; `defaultOptionId` is the answer Code will use if nobody answers. */
export interface UnderstandingQuestion { questionId: string; text: string; options?: Array<{ optionId: string; label: string }>; criterionId?: string; defaultOptionId?: string }

/** The proof index of one task (UX audit 2026-11-15): every item of evidence and what it proves, so the proof page can answer "which of the things I asked for are proven?". */
export interface ProofItem {
  /** The item's id in the index (Code's `check:<n>`, `evidence:<n>`, `review:code`, `review:security`). Optional: an older Code sends none, and the digest is the key then. */
  id?: string;
  /** The digest of the check's stored output; read it with `tasks.evidence.get`. Code sends it only when it kept the output. */
  sha256?: string;
  title: string;
  kind: string /* known: test_report, screenshot, log, diff, check_result, eval */;
  verdict: "pass" | "fail" | "unknown";
  /** The criteria (`SpecCriterion.id`) this item speaks to; empty for an "also checked" item. */
  criterionIds: string[];
  /** The commit it was checked on, and whether the code has changed since. */
  commit?: string;
  stale?: boolean;
  /** An eval: how many cases passed of how many, and the bar to reach. */
  passed?: number;
  total?: number;
  bar?: number;
}
/** TE-A6 (DEC 254zt/254zzf): one failing test of a failed check, as Code words it (plain text): the check, the test, and "likely broken by a change ... to <files>" or "unknown (<why>)". */
export interface ProofFailure { check: string; test: string; cause: string }
/** `failures` (at most ten) and `failuresNotListed` (how many more) are optional: a Code without TE-A6, or a task with no failing test that has a cause, sends neither. */
export interface ProofIndexResponse { taskId: TaskId; items: ProofItem[]; failures?: ProofFailure[]; failuresNotListed?: number }

/** Cloud's own `GET /v1/app/org/spend` gains two optional numbers (no Code route behind it): what the company spent this month and what is left of its budget (absent when there is no budget). */
export interface OrgSpendSummaryAddition { spentThisMonthUsd?: number; remainingUsd?: number }

export interface CancelRequest { requestId: string }
export interface CloseRequest { requestId: string; discard_unpublished?: true }
export interface CloseResponse { task: TaskView; closed: boolean; discardedUnpublished?: boolean; unpublished?: unknown; message?: string }
export interface ContinueRequest { requestId: string; [field: string]: unknown }
export interface OpenPullRequestRequest { requestId: string; repository: string; [field: string]: unknown }
export interface ShareTaskRequest { requestId: string; [field: string]: unknown }

/** Code's task People view (packages/contracts/src/task-people.ts in Rovara Code): ids are the task person's, not the developer's; `method` names how the person signs in, when Code says. */
export interface PeopleView {
  revision: number; orphaned: boolean; canManage: boolean; canTakeOwnership: boolean;
  people: Array<{ personId: string; name: string; role: string; you: boolean; effectiveRole: string | null; method?: string }>;
}
/** `PENDING` waits for the person to confirm on Code's page (`confirmationUrl`); `COMMITTED` carries the list as it is now. */
export interface PeopleChange { status: string /* known: PENDING, COMMITTED */; requestId?: string; confirmationUrl?: string; expiresAt?: string; view?: PeopleView }
export interface PeopleResponse { view: PeopleView }
export interface PeopleChangeResponse { change: PeopleChange }
export interface PeopleRoleRequest { requestId: string; expectedPeopleRevision: number; personId: string; role: string }
export interface TakeOwnershipRequest { requestId: string; expectedPeopleRevision: number }
/** Web task channel C4 (planned): the owner adds a person from the web; the candidates are names and opaque developer ids, at most 200. */
export interface PeopleAddRequest { requestId: string; expectedPeopleRevision: number; developerId: string; role: "owner" | "commenter" | "viewer" }
export interface PeopleCandidatesResponse { candidates: { candidates: Array<{ developerId: DeveloperId; name: string }>; complete: boolean } }

export interface TaskReader { developerId: DeveloperId; name: string; role: string; projectMember: boolean; grantedAt: Iso }
export interface ReadersResponse { readers: TaskReader[] }
export interface PutReaderRequest { requestId: string; role: "viewer" }
export interface PutReaderResponse { reader: TaskReader }
export interface RemoveReaderResponse { removed: boolean }

export interface WorkflowDecisionRequest {
  requestId: string; expectedRevision: number; decision: "APPROVE" | "REQUEST_CHANGES"; reason: string; artifactDigest: string;
  /** Plan choices (answers to the plan's questions) and the run limit the approver saw; both optional. */
  choices?: Record<string, string>;
  acknowledgedRunLimitUsd?: number;
}
export interface WorkflowReviewRequest { requestId: string; instructions: string; [field: string]: unknown }
export interface WorkflowSendBackRequest { requestId?: string; expectedRevision: number; instructions: string }
export interface WorkflowFindingsRequest { requestId?: string; expectedRevision: number; candidateDigest: string; [field: string]: unknown }
export interface WorkflowRetryRequest { requestId: string; expectedRevision?: number; [field: string]: unknown }
export interface WorkflowFeedbackResponse { review: JsonObject | null }
export interface StartedResponse { task: TaskView; started?: boolean }

// Proposed (not served on the deployed API today): what the session, plan and proof screens need beyond the task view.
export interface TaskMessage { messageId: string; kind: "comment" | "steer"; author: { developerId: DeveloperId; name: string }; text: string; at: Iso; rev: number; threadId?: string; anchor?: string }
export interface MessagesResponse { messages: TaskMessage[]; next?: string }
export interface SendMessageRequest { requestId: string; kind: "comment" | "steer"; text: string; threadId?: string; anchor?: string }
export interface SendMessageResponse { message: TaskMessage }
export interface DiffResponse { repository: string; number: number; page: number; files: Array<{ path: string; additions: number; deletions: number; patch: string }>; more: boolean }
export interface AnswersRequest { requestId: string; round: number; revision: number; answers: Array<{ questionId: string; optionId?: string; text?: string; criterionId?: string }> }
export interface MergeRequest { requestId: string; risk?: "low" | "medium" | "high" }
export interface MergeResponse { task: TaskView; merged: boolean; message?: string }
/** The proof page: one item of evidence by digest (Code core, `core/proof/evidence-pack.ts`). */
export interface EvidenceItem { sha256: string; kind: string /* known: test_report, screenshot, log, diff, check_result */; title: string; contentType: string; sizeBytes: number; body: string; checkedAt: Iso; verdict: "pass" | "fail" | "unknown" }
export interface PlanComment {
  commentId: string; document: "requirements" | "design" | "plan"; author: { developerId: DeveloperId; name: string }; text: string; at: Iso; rev: number; resolved: boolean;
  /** Optional: the passage the comment is about (a criterion id, or a passage id of the document); Code returns what `CreateCommentRequest.anchor` sent. */
  anchor?: string;
  /** Optional: the `commentId` this comment answers (a thread). */
  replyTo?: string;
}
export interface CommentsResponse { comments: PlanComment[] }
export interface CreateCommentRequest { requestId: string; document: "requirements" | "design" | "plan"; text: string; anchor?: string; replyTo?: string }
export interface CreateCommentResponse { comment: PlanComment }

// ---------------------------------------------------------------------------------------------------------------
// Types: decision cards (Home), How we work, company, script tokens (proposed; the decision, answers, playbook and script-token routes arrive with E2)

/** Decision card kinds (`DECISION_KINDS` in decision-cards.ts); a newer Code may send others. */
export type DecisionKind = string /* known: approve_plan, approve_requirements, approve_design, merge, answer_question, choose_checks, approve_dependency, approve_e2e_plan, review_feedback, autofix_ask, approve_setting, approve_spend, approve_test_env, confirm_env_change, spec_choice, fix_setup, setup_host, second_review_notice, approve_fixture_set */;
export type DecisionRisk = "low" | "medium" | "high";
/** An action of a card. `href` is a path of the Cloud the app talks to (`/v1/app/decisions/{kind}/{subject}/{approve|reject}` or an `/app/` page): the app follows only exactly those. */
export interface DecisionCardAction { kind: "approve" | "reject" | "open" | "answer" | "choose"; label: string; href: string; method: "GET" | "POST" }
export interface DecisionEvidenceChip { kind: string; label: string; value: string; state: "good" | "warning" | "bad" | "unknown"; href?: string }
/**
 * One decision card, exactly as the app reads it (`DecisionCardSchema` in decision-cards.ts; the app's reader is strict about the required fields and drops the rest).
 * Code's core builds it, Cloud passes it through unchanged, so the card the person sees is the card Code will check.
 */
export interface DecisionCard {
  /** `<kind>:<subject>`. The id's colon is carried as a slash in the paths. */
  id: string;
  kind: DecisionKind;
  taskId?: TaskId;
  project: string;
  title: string;
  question: string;
  recommended: { action: DecisionCardAction["kind"]; why: string };
  next: { text: string; costUsd?: number; minutes?: number };
  evidence: DecisionEvidenceChip[];
  risk: DecisionRisk;
  riskReasons: string[];
  friction: { expandEvidenceFirst: boolean; freshSignIn: boolean; secondPerson: boolean };
  /** A high-risk card has no approve action; an answered card has none. */
  actions: DecisionCardAction[];
  rejectReasons: string[];
  status: "pending" | "approved" | "rejected" | "answered_by_rule" | "expired" | "cancelled";
  answeredByRule?: { ruleId: string; at: Iso };
  createdAt: Iso;
  expiresAt?: Iso;
}
/** The reply to `decisions.list`: the app's `DecisionCardsView`. `digests` has an entry for every card: what Code shows NOW, sent back as `shownDigest` when the person acts, so a changed card answers 409 CHANGE_STALE. */
export interface DecisionsResponse {
  cards: DecisionCard[];
  total: number;
  tabs: Record<string, Array<{ id: "requirements" | "design"; title: string; summary: string; evidence: DecisionEvidenceChip[]; approved: boolean }>>;
  details: Record<string, Array<{ tab?: "requirements" | "design"; title: string; lines: string[] }>>;
  digests: Record<string, string>;
  dropped: number;
  unconfirmed?: string[];
}
export type DecisionAction = "approve" | "request-changes" | "reject" | "evidence-opened";
/** The body of `decisions.act`: approve `{requestId, shownDigest, tab?, reason?}`; reject `{requestId, reason}` (a fixed reason word); evidence-opened `{requestId, shownDigest}`. */
export interface DecisionActRequest { requestId: string; shownDigest?: string; reason?: string; tab?: string; acknowledgedRunLimitUsd?: number; includedCommentIds?: string[] }
/**
 * The reply: decided, waiting on a confirmation page (nothing was decided), or (evidence-opened) whether the open was recorded. Cloud passes it through
 * unchanged, so `confirmUrl` must already be a page the app accepts (Cloud's own `/v1/app/approve/<id>`); until Cloud serves one for a card kind, the app shows no link.
 */
export type DecisionOutcome =
  | { cardId: string; outcome: "approved" | "rejected"; tab?: "requirements" | "design"; remainingTabs: Array<"requirements" | "design"> }
  | { cardId: string; outcome: "needs_confirmation"; confirmUrl: string; merging?: Array<{ repositoryId: string; number: number; baseBranch: string }> }
  | { cardId: string; opened: true; recorded: boolean };

export interface PlaybookLayer { kind: string /* known: project_process, default */; agentId?: string; name?: string }
export interface PlaybookView { revision: number; defaultProcess: PlaybookLayer; designReview: string /* known: off, ask, always */ }
export interface PutPlaybookRequest { expectedRevision: number; defaultProcess?: PlaybookLayer; designReview?: string }
export interface HowWeWorkView { project: string; revision: number; layers: Array<{ title: string; summary: string; editable: boolean }> }
export interface ProcessLayerResponse { layer: PlaybookLayer }

export interface CompanyMember { developerId: DeveloperId; name: string; email?: string; role: string /* known: owner, admin, member */; joinedAt: Iso }
export interface CompanyMembersResponse { members: CompanyMember[] }
export interface SetCompanyRoleRequest { requestId: string; role: "admin" | "member" }
export interface RemovalPreview { developerId: DeveloperId; ownedTasks: number; ownedProjects: string[]; successorRequired: boolean }
export interface RemoveCompanyMemberRequest { requestId: string; successorId?: DeveloperId }
/** The invite workflow is Cloud's (plan 2.2); Code only learns "this email is pre-approved for company C" (decision 17). */
export interface PreApprovedEmailsRequest { requestId: string; emails: string[] }
export interface PreApprovedEmailsResponse { emails: string[]; revision: number }
/** Code's member pre-approval (DEC 253z): the inviting admin's own call; Code checks their live company role. Every refusal is NOT_FOUND. */
export interface CompanyPreapprovalRequest { email: string; role: "member"; expiresInHours: number }
export interface CompanyOkResponse { ok: true }
/**
 * Code's answer to a pre-approval (DEC 254h): also the single-use invite secret it minted for it, returned once (Code keeps only its SHA-256),
 * expiring with the pre-approval. An older Code answers `{ ok: true }` alone.
 */
export interface CompanyPreapprovalResponse { ok: true; invite?: { secret: string; expiresAt: string } }
/** A person with no company creates one with an operator's invite code (DEC 254a; Code PR 4) and becomes its owner. */
export interface CreateCompanyRequest { name: string; inviteCode: string }
export interface CreateCompanyResponse { companyId: string; companyName: string; companyRole: "owner" }
/** Guided onboarding (Code PR #830): a company owner or admin connects the company's GitHub App installation, proving control with a GitHub user authorization. */
export interface GithubConnectStart { state: string; expiresAt: Iso; installUrl: string; authorizeUrl: string }
export interface GithubClaimRequest { state: string; code?: string; installationId?: number; setupAction?: "install" | "update" | "request" }
export interface GithubConnected { status: "connected"; alreadyConnected: boolean; installation: { installationId: number; accountLogin: string; accountType: string }; githubUser: { id: number; login: string } }
export interface GithubChoice { installationId: number; accountLogin: string; accountType: string; suspended: boolean; connection: string /* known: this_company, another_company, unbound */ }
export type GithubClaimResponse = GithubConnected | { status: "choose"; ticket: string; expiresAt: Iso; githubUser: { id: number; login: string }; installations: GithubChoice[] } | { status: "requested" };
export interface GithubChooseRequest { ticket: string; installationId: number }
/** Guided onboarding (Code PRs #836, #840, #838): Add to Slack, a project's Slack channel, Connect Linear and a project's Linear team. */
export interface SlackInstallStart { state: string; expiresAt: Iso; authorizeUrl: string; signedInWorkspace?: { teamId: string; teamName?: string } }
export type SlackInstallComplete = { status: "connected"; alreadyConnected: boolean; workspace: { teamId: string; teamName?: string }; signedInWorkspace?: { teamId: string; teamName?: string }; matchesSignIn?: boolean } | { status: "cancelled" };
export interface SlackWorkspaceRead { workspace: null | { teamId: string; teamName?: string; state: string; connectedAt: Iso; connectedBy: { kind: string; personId?: string; name?: string } } }
export interface SlackDisconnected { status: "disconnected"; workspace: { teamId: string; teamName?: string }; projectsLosingChannel: string[] }
export interface SlackChannelsPage { workspace: { teamId: string }; channels: Array<{ id: string; name: string; isPrivate: boolean; linked?: true; linkedProject?: string }>; nextCursor?: string }
export interface SlackProjectChannel { workspace: null | { teamId: string }; channels: Array<{ channelId: string }> }
export type SlackChannelLinked = { status: "linked"; workspace: { teamId: string }; channel: { id: string; name: string; isPrivate: boolean }; alreadyLinked: boolean; replaced: string[] } | { status: "invite_needed"; workspace: { teamId: string }; channel: { id: string }; message: string };
export interface SlackChannelUnlinked { status: "unlinked"; teamId: string; channels: string[] }
export interface LinearConnectStart { state: string; expiresAt: Iso; authorizeUrl: string }
export interface LinearConnected { status: "connected"; reconnected: boolean; workspace: { id: string; name: string; urlKey: string } }
export type LinearConnectionRead = { status: "disconnected" } | { status: "connected" | "needs_reconnect" | "disconnected"; statusAt: Iso; workspace: { id: string; name: string; urlKey: string }; connectedAt: Iso; connectedBy: { personId: string; name?: string } };
export interface LinearDisconnected { status: "disconnected"; workspaceName: string; projects: string[] }
export interface LinearTeam { id: string; key: string; name: string }
export interface LinearProjectTeam { project: string; team: LinearTeam | null; teams?: LinearTeam[]; cleared?: boolean }
export interface GithubConnectionsResponse { installations: Array<{ installationId: number; accountLogin: string; status?: "active" | "suspended" | "uninstalled"; accountType?: "User" | "Organization"; connectedAt: Iso; connectedBy: { kind: "person"; personId: string; name?: string } | { kind: "operator" } }> }
/** Guided onboarding PR 12b (Code #832): a company owner disconnects one of the company's GitHub installations (refused while in use). */
export interface GithubDisconnected { status: "disconnected"; installationId: number; accountLogin: string; uninstallUrl: string }
/**
 * One engine action (Code's `GET /v1/dev/client/company/audit/records`, lane AU, Rovara PR #649). The optional fields are what Code adds: the record's id, the actor's kind and the caller the
 * action came through ("person via caller": `web`, `slack`, `cli`, `client:<id>`). An older Code leaves them out.
 */
export interface AuditRecord { at: Iso; actor: { developerId: DeveloperId; name: string; type?: string /* known: person, agent, system */ }; action: string; subject: string; outcome: string /* known: ok, refused */; eventId?: string; via?: string }
/** `next` says where to go on (a page may be short while it is present); `skipped` counts rows not shown (not this company's, or unreadable), never their content. Rows are newest first within a page only. */
export interface AuditRecordsResponse { records: AuditRecord[]; next?: string; skipped?: number }

/** Where a line of the company audit list was recorded: `cloud` is Cloud's own record of a Cloud action or a hook answer; `engine` is one of Code's. */
export type CompanyAuditSource = "cloud" | "engine";
/**
 * One line of the company audit list (Cloud's `GET /v1/app/company/audit`, plan v3.2 7.5): a Cloud record and an engine record read alike. `id` is `cloud:<id>` or `engine:<eventId>`, unique in the list.
 * Newest first by `at`, ties by `id` (higher first), the same in every page.
 */
export interface CompanyAuditEntry {
  id: string;
  source: CompanyAuditSource;
  at: Iso;
  actor: { developerId: DeveloperId; name: string; type?: string /* known: person, agent, system */ };
  /** The caller the action came through: `web`, `slack`, `cli`, `client:<id>`, `policy-hook`. */
  via?: string;
  /** Cloud actions: `company.rules.changed`, `company.invite.created`, `company.invite.revoked`, `company.budget.changed`, `company.signin_client.changed`, `hook.<kind>.answered`, `hook.<kind>.unanswered`. Engine actions: Code's (`task.approved`). */
  action: string;
  /** `<type>:<id>` of what the action was about, or empty. */
  subject: string;
  /** The project, when the action was about one (always set for Cloud records that have one; engine lines carry it in `subject`). */
  project?: string;
  outcome: string /* known: ok, refused */;
  /** A short fixed-word note (Cloud records only): the answer's code, or what was asked. Never free text from a person. */
  detail?: string;
}
/**
 * Whether the engine's records are in the list: `connected` (all of the filtered range was read), `not_connected` (Code does not serve the audit read yet: the list is Cloud's own records),
 * `unavailable` (Code did not answer: Cloud's own records only), `incomplete` (Code has more records than one call reads: the engine lines shown are not all of them, and an older page may miss some).
 * `message` is plain words for the page to show whenever the state is not `connected`.
 */
export interface CompanyAuditEngineStatus { state: "connected" | "not_connected" | "unavailable" | "incomplete"; message?: string }
export interface CompanyAuditQuery { from?: Iso; to?: Iso; person?: DeveloperId; project?: string; /** Exact (`task.approved`) or a family (`task.*`). */ action?: string; limit?: number; cursor?: string }
/** The reply to `GET /v1/app/company/audit` (admin only): the merged list, `next` (pass back as `cursor` with the same filters) while there may be more, and the engine's status. A page may be short while `next` is present. */
export interface CompanyAuditPage { records: CompanyAuditEntry[]; next?: string; engine: CompanyAuditEngineStatus }

export interface ScriptToken { tokenId: string; name: string; hint: string; projects: string[]; permissions: Array<"read" | "start" | "lessons" | "wiki">; createdAt: Iso; expiresAt: Iso; lastUsedAt?: Iso; revokedAt?: Iso; status: "active" | "expired" | "revoked"; mine: boolean; createdBy?: string }
export interface ScriptTokensResponse { tokens: ScriptToken[] }
export interface CreateScriptTokenRequest { requestId: string; name: string; projects: string[]; permissions: Array<"read" | "start" | "lessons" | "wiki">; days?: number }
/** The secret is shown once, in this answer only. */
export interface CreateScriptTokenResponse { token: ScriptToken; secret: string }
export interface RevokeScriptTokenResponse { token: ScriptToken }

/** Guided onboarding PR 16/17 (Code #839): a reviewed archive or restore names the preview's revisions and acknowledges what it does (Code's ReviewedProject*Body). */
export interface ArchiveProjectRequest { requestId: string; expectedOrgId?: string; expectedRevision: number; expectedProjectRevision: number; acknowledgeNewWorkStops?: true; acknowledgeNewWorkAllowed?: true }
/** Code's ReviewedProject*Preview: the lifecycle state, the revisions a change must name, the one action the person may take, and what it does. */
export interface ProjectLifecyclePreview { orgId: string; project: string; status: "archived" | "active"; expectedRevision: number; expectedProjectRevision: number; checkedAt: Iso; prerequisites?: "checked" | "not_required"; access: { actions: Array<"archive" | "restore"> }; impact?: JsonObject }
/** Code's ReviewedProject*Outcome: the original receipt, whether this answer replays it, and the current state read afresh. */
export interface ArchiveProjectResponse { receipt: JsonObject; replayed: boolean; current: ProjectLifecyclePreview; effects: JsonObject }

/**
 * Guided onboarding PR 14/15 (Code #835, DEC 254n item 1): the company's engine model. `model` is what the company's tasks resolve to now (its own, else the
 * install default, null where there is none); `offered` is the gateway's live list for THIS company; `preselect` is `model` when offered, else the first offered.
 */
/** `GET /v1/dev/company/egress-addresses` (L4-EGR; Code company-egress-addresses.ts): Rovara's outbound addresses, up to 4 distinct public IPv4 addresses, empty where this install has none yet. */
export interface CompanyEgressAddressesView { addresses: string[] }
export interface CompanyEngineModelView { model: string | null; source: "company" | "install"; offered: string[]; preselect: string }
/** A model id, or null to clear the company's own (the install default applies again). Nothing else. */
export interface PutCompanyEngineModelRequest { model: string | null }
/**
 * Code #1075 (DEC 254zzz58/63): the model the company's lessons LEARN with, separate from the engine model. `model` is what lessons learn with now (the company's own, else the
 * install default, null only where the install's setting is broken); `offered` holds only the Claude models the gateway offers THIS company now (it can be empty); `preselect` is
 * `model` when offered, else the first offered, else null.
 */
export interface CompanyLearningModelView { model: string | null; source: "company" | "install"; offered: string[]; preselect: string | null }
/** A Claude model id, or null to clear the company's own (the install default applies again). Nothing else. */
export interface PutCompanyLearningModelRequest { model: string | null }
/** Code's project settings (M4a, `GET|PUT /v1/dev/projects/{name}/settings`): the stored preset and overrides, the revision, and what applies under the company's bounds. */
export interface ProjectSettingsView { preset: string | null; overrides: JsonObject; revision: number; updatedAt: Iso | null; updatedBy: string | null; resolved: JsonObject; values: JsonObject; clamped: JsonObject[] }
/** A change names the revision read; Code decides who may change a cost field (such as `model_budget_usd`, the per-task model budget). */
export interface PutProjectSettingsRequest { expectedRevision: number; preset?: "lightweight" | "balanced" | "careful"; overrides?: JsonObject }

/** Guided onboarding PR 9 (Code #841): the project checklist read (contracts project-setup-status.ts ProjectSetupChecklistSchema has every field). */
export type ProjectSetupStatusView = JsonObject & { project: string };
export interface ProjectSetupSkipRequest { row: "slackChannel" | "linear" | "invites"; skipped: boolean }
export interface ProjectSetupSkipView { project: string; row: ProjectSetupSkipRequest["row"]; skipped: boolean; skippedRows: Array<ProjectSetupSkipRequest["row"]> }

// ---------------------------------------------------------------------------------------------------------------
// Types: lessons (Code's lessons API, PrepLabsAI/Rovara#713, LM8 part 1; DEC 225, 226, 231). One project of the caller's own company: the
// company comes from Code's live membership, never from the path. Every refusal is fixed words. While Code's lessons switch does not cover
// the company (or the lessons are not wired), every route answers 404 `LESSONS_SWITCHED_OFF` "Lessons are off.", which the app shows as a
// calm off state, never as an error.

export type LessonList = "proposed" | "approved" | "retired";
export type LessonMode = "off" | "suggest" | "auto";
/** Why a person drops a proposed lesson: fixed words, so no person's text is kept with a lesson. */
export type LessonRejectReason = "wrong" | "too_narrow" | "duplicate" | "not_useful" | "other";
/** Why a person retires a lesson: fixed words. */
export type LessonRetireReason = "outdated" | "wrong" | "harmful" | "not_useful" | "other";
/** A person as Code names them: a display name, or "a former member" for someone erased. `you` marks the signed-in person. */
export interface LessonPerson { name: string; you?: true }
export type LessonCitation =
  | { kind: "code"; repo: string; path: string; startLine: number; endLine: number; check: string /* known: valid, moved, stale, unchecked */; checkedAt?: number }
  | { kind: "pr"; url: string }
  | { kind: "task"; taskId: string }
  | { kind: "record" }
  /** A kind a newer Code added: Cloud keeps it as this (it never reads it as a known kind). */
  | { kind: "other" };
/** What a lesson waiting for people still needs: people in all (1, or 2 for reviewer, check and security lessons) and how many approved. */
export interface LessonNeeds { required: 1 | 2; have: number; first?: LessonPerson; firstAt?: number; groups: string[] }
/** One lesson as Code's list sends it (contracts `LessonViewSchema`; Cloud keeps the fields its screens draw). Times are milliseconds. */
export interface LessonItem {
  id: string; version: number; type: string; stages: string[];
  title: string; description: string; body: string;
  scope: { repos: string[]; paths: string[]; languages: string[] };
  tier: 0 | 1 | 2;
  status: string /* known: candidate, pending, active, stale, retired, rejected, expired, withdrawn */;
  /** How often tasks loaded it, and how many helpful and not helpful (thumbs-down or "wrong here") marks it has. Not a count of distinct tasks. */
  counters: { loaded: number; helpful: number; harmful: number };
  createdAt: number; updatedAt: number;
  /** When an undecided lesson lapses (the expiry warning). */
  expiresAt: number;
  lastUsedAt?: number;
  citations: LessonCitation[];
  /** The people whose corrections or edits it came from. */
  from: LessonPerson[];
  measured: boolean;
  /** How many tasks back it. */
  supportTasks: number;
  needs?: LessonNeeds;
  /** Older paths may have kept a free-text reason here; the app shows only the fixed words it knows. */
  rejectedReason?: string;
  /** Live with no approval, on trial for 14 days or stable after it. */
  trial?: string /* known: trial, stable */;
  /** The lesson this one may duplicate (kept apart, never merged): Keep keeps both. */
  possibleDuplicate?: string;
  /** The lesson this one contradicts. */
  contradicts?: string;
  /** How many distinct tasks were given it. Not sent by Code yet (being added); shown only when present. */
  usedInTasks?: number;
  /** A lesson a person made permanent (L4-LP4G): it is retired, not handed to agents as a lesson any more, and stays in the retired list with this link. */
  became?: LessonBecame;
  canApprove: boolean; canReject: boolean; canRetire: boolean;
}
/** What a lesson became: a team rule, a draft task to add a check, or a skill; `other` is a kind a newer Code added (Cloud keeps the link and never reads it as a known kind). */
export interface LessonBecame { kind: "rule" | "check" | "skill" | "other"; ref: string; at: number }
export interface LessonsPageResponse { project: string; list: LessonList; canDecide: boolean; lessons: LessonItem[]; next?: string; partial?: true }
export interface LessonEdit { title: string; description: string; body: string }
export interface ApproveLessonRequest { version: number; edit?: LessonEdit }
export interface ApproveLessonResponse { project: string; lessonId: string; status: string /* known: active, pending */; version: number; needs?: LessonNeeds }
export interface RejectLessonRequest { version: number; reason: LessonRejectReason }
export interface RejectLessonResponse { project: string; lessonId: string; status: "rejected" }
export type LessonDecision = { lessonId: string; version: number; decision: "keep"; edit?: LessonEdit } | { lessonId: string; version: number; decision: "drop"; reason: LessonRejectReason };
/** Keep or Drop for 1 to 20 distinct proposed lessons at once (the inbox's batch). */
export interface LessonDecisionsRequest { decisions: LessonDecision[] }
/** One answer per decision, in the order sent; a refusal of one never undoes or blocks another. */
export type LessonDecisionResult = { lessonId: string; ok: true; status: string /* known: active, pending, rejected */ } | { lessonId: string; ok: false; code: string; message: string };
export interface LessonDecisionsResponse { project: string; results: LessonDecisionResult[] }
export interface RetireLessonRequest { reason: LessonRetireReason }
export interface RetireLessonResponse { project: string; lessonId: string; status: "retired" }
export interface RetireRequestResponse { project: string; lessonId: string; requested: true }
export interface LessonRetireRequest { lessonId: string; title: string; status: string; by: string; at: number }
export interface RetireRequestsResponse { project: string; requests: LessonRetireRequest[]; more: boolean }
/** One lesson a task was given ("Lessons used"). `visible` false: the viewer cannot see its source, and the row has no words. */
export interface TaskLesson {
  stage: string; round: number; lessonId: string; version: number;
  why: string /* known: scope, similar, path */;
  citation: string /* known: unchecked, valid, moved, stale_dropped, unchecked_dropped, none */;
  visible: boolean; title?: string; type?: string; helpful?: number; harmful?: number; canMark: boolean; trial?: string;
}
export interface TaskLessonsResponse { project: string; taskId: string; lessons: TaskLesson[] }
export interface NotHelpfulResponse { project: string; taskId: string; lessonId: string; marked: "not_helpful" }
/** The project's own mode, the mode in force (the stricter of it and the company's), whether the company is the reason, and whether this person may change it. */
export interface LessonModeResponse { project: string; mode: LessonMode; effective: LessonMode; lockedByCompany: boolean; canChange: boolean }
/** Code's counts only phase 0 measurement, returned only to a project maintainer or company owner/admin. */
export interface LessonMeasureResponse {
  project: string; windowDays: number; floor: number; loads: number; lessonsInUse: number | null; loadedLessons: number; loadedBelowFloor: number;
  loadsWithBelowFloor: number; loadedNoMatch: number; meanWordsLoaded: number | null; meanWordsLeftOut: number | null; loadsCapBound: number;
  leftOutAtOrAboveFloor: number; meanFitLoaded: number | null; meanFitLeftOut: number | null;
  cleanMerge: { merged: number; reverted: number; clean: number; rate: number | null };
  revertDetection: "not_wired" | "wired"; truncated: boolean; unreadable: number;
}
export interface PutLessonModeRequest { mode: LessonMode }
/** Lead 4 L4-LP3W: the approved lessons by code area (Code `GET .../lessons/areas`; the strict shape is contracts `app-lessons-areas.ts`). A folder holds the lessons anchored at it or below it, each counted once. */
export interface LessonAreaFile { name: string; lessons: number }
export interface LessonAreaNode { name: string; /** The folder with a trailing slash (`src/billing/`). */ path: string; lessons: number; children: LessonAreaNode[]; moreChildren?: number; files: LessonAreaFile[]; moreFiles?: number }
/** `repo` null: lessons that name paths but no repository. */
export interface LessonAreaRepo { repo: string | null; lessons: number; children: LessonAreaNode[]; moreChildren?: number; files: LessonAreaFile[]; moreFiles?: number }
export interface LessonAreasResponse {
  project: string; total: number; wholeProject: number; repos: LessonAreaRepo[]; partial?: true;
  /** Present when one node was asked for (`repo` and `folder`, or `whole`): its lessons, in the same shape as the lessons list. */
  selection?: { whole?: true; repo?: string | null; folder?: string; lessons: LessonItem[]; moreLessons?: number };
}
/** Lead 4 L4-LP3W: "Where Rovara learns from". Counts are the last 30 days; Cloud words every row itself. */
export type LearningSourceKey = "task_decisions" | "review_comments" | "pr_edits" | "remember" | "after_merge" | "ci" | "tickets";
export interface LearningSourceRow { key: LearningSourceKey; label: string; detail: string; seen: number; suggested: number; kept: number; paused: boolean; example?: { lessonId: string; title: string } }
export interface LearningSourcesResponse { project: string; windowDays: 30; canPause: boolean; sources: LearningSourceRow[]; partial?: true }
export interface PutLearningSourceRequest { paused: boolean }
export interface PutLearningSourceResponse { project: string; key: LearningSourceKey; paused: boolean }
/** Cloud's inbox read (`GET /v1/app/lessons/inbox`): one batch per project with proposed lessons the person can decide, theirs first. */
export interface LessonInboxBatch { project: string; lessons: LessonItem[]; fromYou: number; partial?: true }
export interface LessonInboxResponse { state: "on" | "off"; batches: LessonInboxBatch[]; unavailable: string[] }

// Lessons phase 4 (L4-LP4G, lead 4): graduation and tidy. For the people who decide lessons only (Code refuses everyone else, a script token included, in its
// own fixed sentences, which Cloud passes through). A proven lesson gets at most one "Make this permanent?" card a week; the target is inside Rovara.
export type GraduationTarget = "rule" | "check" | "skill";
/** `first`: what the first person asked for (set once someone has asked; the card's target and paths then follow it). */
export interface GraduationNeeds { required: 1 | 2; have: number; you: boolean; first?: { target: GraduationTarget; paths: string[] } }
/** The week's one card. `target` is the suggestion and one of `targets`; `paths` prefill a team rule's code area (none: the whole project). */
export interface GraduationCard {
  lessonId: string; version: number; title: string; description: string; type: string; tier: 0 | 1 | 2;
  target: GraduationTarget; targets: GraduationTarget[]; paths: string[]; tasks: number; days: number; needs: GraduationNeeds;
}
export interface TidyLesson { lessonId: string; version: number; title: string; type: string; tasks: number; days: number }
/** The tidy card: up to 10 least used lessons, for the person to retire the ones they choose. */
export interface TidyCard { period: number; lessons: TidyLesson[] }
/** A draft task to add a check: text a person starts themselves (nothing starts it for them). */
export interface CheckDraft { id: string; lessonId: string; title: string; request: string; paths: string[]; createdAt: number }
/** A live team rule a lesson became (read into the standing block as "How we work", scoped to its paths and repositories); people who decide see these and can retire one. */
export interface TeamRule { id: string; text: string; paths: string[]; repos: string[]; fromLesson: string; createdAt: number }
export interface GraduationResponse { project: string; canDecide: boolean; card?: GraduationCard; tidy?: TidyCard; drafts: CheckDraft[]; rules: TeamRule[] }
export interface GraduateRequest { target: GraduationTarget; paths?: string[]; name?: string }
export type GraduateResponse =
  | { project: string; lessonId: string; target: GraduationTarget; state: "done"; ref: string; already: boolean }
  | { project: string; lessonId: string; target: GraduationTarget; state: "waiting"; needs: "second_person" }
  | { project: string; lessonId: string; target: "skill"; state: "drafted"; name: string; version: number }
  /** A state a newer Code added: Cloud keeps nothing of it, and the screen says to reload. */
  | { project: string; lessonId: string; target: GraduationTarget; state: "unknown" };
export interface GraduateLaterResponse { project: string; lessonId: string; later: true }
/** "Both, in different places": the third answer to a conflict; the waiting lesson is then kept as usual. */
export interface BothPlacesRequest { version: number; cardPaths: string[]; otherPaths: string[] }
export interface BothPlacesResponse {
  project: string; lessonId: string; otherId: string; cardPaths: string[]; otherPaths: string[]; version: number;
  status: string /* known: active, pending */; needs: string /* known: nothing, second_person, group_member, decision */;
}
export interface TidyRetireRequest { ids: string[] }
export interface TidyRetireResponse { project: string; retired: string[]; skipped: number }
export interface TidyLaterResponse { project: string; closed: true }
/** The person says which of their own tasks they started from a draft. */
export interface CheckDraftStartedRequest { taskId: string }
export interface CheckDraftStartedResponse { project: string; draftId: string; status: "started" }
export interface CheckDraftDismissResponse { project: string; draftId: string; status: "dismissed" }
export interface RuleRetireResponse { project: string; ruleId: string; status: "retired" }

// ---------------------------------------------------------------------------------------------------------------
// The typed map: one entry per Code route id (request is the JSON body or `void`, response the 2xx JSON body).

export interface CodeRouteTypes {
  "auth.authorize": { request: void; response: void };
  "auth.token": { request: TokenRequestCode | TokenRequestRefresh; response: TokenResponse };
  "auth.revoke": { request: { token: string }; response: JsonObject };
  "auth.jwks": { request: void; response: { keys: JsonObject[] } };
  "access.check": { request: JsonObject; response: AccessResponse };
  "me.setName": { request: SetNameRequest; response: SetNameResponse };
  "channelLinks.list": { request: void; response: { links: ChannelLink[] } };
  "channelLinks.remove": { request: void; response: { removed: boolean } };
  "projects.list": { request: void; response: { projects: Array<{ name: string; access: string }> } };
  "client.projects.create": { request: CreateProjectRequest | CreateProjectsRequest; response: CreateProjectResponse };
  "client.projects.bulk": { request: BulkCreateProjectsRequest; response: BulkCreateProjectsResponse };
  "client.projects.get": { request: void; response: ProjectView };
  "client.projects.archivePreview": { request: void; response: ProjectLifecyclePreview };
  "client.projects.archive": { request: ArchiveProjectRequest; response: ArchiveProjectResponse };
  "client.projects.restorePreview": { request: void; response: ProjectLifecyclePreview };
  "client.projects.restore": { request: ArchiveProjectRequest; response: ArchiveProjectResponse };
  "client.projects.setupStatus": { request: void; response: ProjectSetupStatusView };
  "client.projects.setupSkips": { request: ProjectSetupSkipRequest; response: ProjectSetupSkipView };
  "client.projects.codeSettings.get": { request: void; response: { settings: CodeSettings } };
  "client.projects.codeSettings.put": { request: PutCodeSettingsRequest; response: { settings: CodeSettings } };
  "client.repositories.list": { request: void; response: RepositoriesResponse };
  "client.repositories.available": { request: void; response: RepositoryChoicesResponse };
  "client.members.list": { request: void; response: MembersResponse };
  "client.members.put": { request: void; response: PutMemberResponse };
  "client.members.remove": { request: void; response: RemoveMemberResponse };
  "tasks.start": { request: StartTaskRequest; response: TaskResponse };
  "tasks.list": { request: void; response: TaskListResponse };
  "tasks.get": { request: void; response: TaskResponse };
  "tasks.events": { request: void; response: TaskEventsResponse };
  "tasks.plan": { request: void; response: PlanResponse };
  "tasks.cancel": { request: CancelRequest; response: TaskResponse };
  "tasks.close": { request: CloseRequest; response: CloseResponse };
  "tasks.continue": { request: ContinueRequest; response: TaskResponse };
  "tasks.pullRequests.open": { request: OpenPullRequestRequest; response: TaskResponse };
  "tasks.share": { request: ShareTaskRequest; response: TaskResponse };
  "tasks.people.get": { request: void; response: PeopleResponse };
  "tasks.people.role": { request: PeopleRoleRequest; response: PeopleChangeResponse };
  "tasks.people.takeOwnership": { request: TakeOwnershipRequest; response: PeopleChangeResponse };
  "tasks.people.candidates": { request: void; response: PeopleCandidatesResponse };
  "tasks.people.add": { request: PeopleAddRequest; response: PeopleChangeResponse };
  "tasks.people.request": { request: void; response: PeopleChangeResponse };
  "tasks.readers.list": { request: void; response: ReadersResponse };
  "tasks.readers.put": { request: PutReaderRequest; response: PutReaderResponse };
  "tasks.readers.remove": { request: void; response: RemoveReaderResponse };
  "tasks.workflow.decision": { request: WorkflowDecisionRequest; response: TaskResponse };
  "tasks.workflow.review": { request: WorkflowReviewRequest; response: TaskResponse };
  "tasks.workflow.retry": { request: WorkflowRetryRequest; response: TaskResponse };
  "tasks.workflow.sendBack": { request: WorkflowSendBackRequest; response: TaskResponse };
  "tasks.workflow.reviewFindings": { request: WorkflowFindingsRequest; response: TaskResponse };
  "tasks.workflow.publishRetry": { request: WorkflowRetryRequest; response: StartedResponse };
  "tasks.workflow.keepPullRequests": { request: WorkflowRetryRequest; response: TaskResponse };
  "tasks.workflow.feedback": { request: void; response: WorkflowFeedbackResponse };
  "tasks.workflow.feedbackDecision": { request: JsonObject; response: TaskResponse };
  "tasks.workflow.feedbackRetry": { request: JsonObject; response: StartedResponse };
  "tasks.messages.list": { request: void; response: MessagesResponse };
  "tasks.messages.send": { request: SendMessageRequest; response: SendMessageResponse };
  "tasks.diff": { request: void; response: DiffResponse };
  "tasks.answers": { request: AnswersRequest; response: TaskResponse };
  "tasks.merge": { request: MergeRequest; response: MergeResponse };
  "tasks.evidence.list": { request: void; response: ProofIndexResponse };
  "tasks.evidence.get": { request: void; response: EvidenceItem };
  "tasks.comments.list": { request: void; response: CommentsResponse };
  "tasks.comments.create": { request: CreateCommentRequest; response: CreateCommentResponse };
  "decisions.list": { request: void; response: DecisionsResponse };
  "decisions.act": { request: DecisionActRequest; response: DecisionOutcome };
  "playbook.get": { request: void; response: PlaybookView };
  "playbook.put": { request: PutPlaybookRequest; response: PlaybookView };
  "playbook.process": { request: JsonObject; response: ProcessLayerResponse };
  "howWeWork.get": { request: void; response: HowWeWorkView };
  "company.members.list": { request: void; response: CompanyMembersResponse };
  "company.members.setRole": { request: SetCompanyRoleRequest; response: { member: CompanyMember } };
  "company.members.removalPreview": { request: void; response: RemovalPreview };
  "company.members.remove": { request: RemoveCompanyMemberRequest; response: { removed: boolean } };
  "company.preApproved.put": { request: PreApprovedEmailsRequest; response: PreApprovedEmailsResponse };
  "company.preapprovals.create": { request: CompanyPreapprovalRequest; response: CompanyPreapprovalResponse };
  "company.preapprovals.withdraw": { request: void; response: CompanyOkResponse };
  "company.create": { request: CreateCompanyRequest; response: CreateCompanyResponse };
  "company.github.connect": { request: JsonObject; response: GithubConnectStart };
  "company.github.claim": { request: GithubClaimRequest; response: GithubClaimResponse };
  "company.github.choose": { request: GithubChooseRequest; response: GithubConnected };
  "company.github.status": { request: void; response: GithubConnectionsResponse };
  "company.github.disconnect": { request: void; response: GithubDisconnected };
  "company.slack.install": { request: { redirectUri: string }; response: SlackInstallStart };
  "company.slack.installComplete": { request: { state: string; code?: string; error?: string }; response: SlackInstallComplete };
  "company.slack.get": { request: void; response: SlackWorkspaceRead };
  "company.slack.disconnect": { request: JsonObject; response: SlackDisconnected };
  "company.slack.channels": { request: void; response: SlackChannelsPage };
  "company.slack.channel.get": { request: void; response: SlackProjectChannel };
  "company.slack.channel.link": { request: { channelId: string }; response: SlackChannelLinked };
  "company.slack.channel.check": { request: { channelId: string }; response: SlackChannelLinked };
  "company.slack.channel.unlink": { request: void; response: SlackChannelUnlinked };
  "company.linear.connect": { request: JsonObject; response: LinearConnectStart };
  "company.linear.complete": { request: { state: string; code: string }; response: LinearConnected };
  "company.linear.get": { request: void; response: LinearConnectionRead };
  "company.linear.disconnect": { request: void; response: LinearDisconnected };
  "company.linear.team.get": { request: void; response: LinearProjectTeam };
  "company.linear.team.put": { request: { teamId: string }; response: LinearProjectTeam };
  "company.linear.team.clear": { request: void; response: LinearProjectTeam };
  "company.audit.records": { request: void; response: AuditRecordsResponse };
  "scriptTokens.list": { request: void; response: ScriptTokensResponse };
  "scriptTokens.create": { request: CreateScriptTokenRequest; response: CreateScriptTokenResponse };
  "scriptTokens.revoke": { request: void; response: RevokeScriptTokenResponse };
  "lessons.list": { request: void; response: LessonsPageResponse };
  "lessons.approve": { request: ApproveLessonRequest; response: ApproveLessonResponse };
  "lessons.reject": { request: RejectLessonRequest; response: RejectLessonResponse };
  "lessons.decisions": { request: LessonDecisionsRequest; response: LessonDecisionsResponse };
  "lessons.retire": { request: RetireLessonRequest; response: RetireLessonResponse };
  "lessons.retireRequest": { request: JsonObject; response: RetireRequestResponse };
  "lessons.retireRequests": { request: void; response: RetireRequestsResponse };
  "lessons.task": { request: void; response: TaskLessonsResponse };
  "lessons.notHelpful": { request: JsonObject; response: NotHelpfulResponse };
  "lessons.mode.get": { request: void; response: LessonModeResponse };
  "lessons.mode.put": { request: PutLessonModeRequest; response: LessonModeResponse };
  "lessons.graduation": { request: void; response: GraduationResponse };
  "lessons.graduate": { request: GraduateRequest; response: GraduateResponse };
  "lessons.graduateLater": { request: JsonObject; response: GraduateLaterResponse };
  "lessons.bothPlaces": { request: BothPlacesRequest; response: BothPlacesResponse };
  "lessons.tidy.retire": { request: TidyRetireRequest; response: TidyRetireResponse };
  "lessons.tidy.later": { request: JsonObject; response: TidyLaterResponse };
  "lessons.checkDraft.started": { request: CheckDraftStartedRequest; response: CheckDraftStartedResponse };
  "lessons.checkDraft.dismiss": { request: JsonObject; response: CheckDraftDismissResponse };
  "lessons.rules.retire": { request: JsonObject; response: RuleRetireResponse };
  "lessons.measure": { request: void; response: LessonMeasureResponse };
  "lessons.areas": { request: void; response: LessonAreasResponse };
  "lessons.learningSources.get": { request: void; response: LearningSourcesResponse };
  "lessons.learningSources.put": { request: PutLearningSourceRequest; response: PutLearningSourceResponse };
  "company.egressAddresses.get": { request: void; response: CompanyEgressAddressesView };
  // L4-JA7: Knowledge stays in Rovara and a project's local coding tools setting (shapes in cloud-server/src/knowledge-switch-routes.ts).
  "company.knowledgeStays.get": { request: void; response: { stays: boolean } };
  "company.knowledgeStays.put": { request: { stays: boolean }; response: { stays: boolean } };
  "lessons.localTools.get": { request: void; response: { enabled: boolean; own?: boolean; reason?: "company_stays" | "regulated" | "project_setting"; preset: "standard" | "regulated"; companyStays: boolean; canChange: boolean } };
  "lessons.localTools.put": { request: { enabled: boolean }; response: { enabled: boolean; own?: boolean; reason?: "company_stays" | "regulated" | "project_setting"; preset: "standard" | "regulated"; companyStays: boolean; canChange: boolean } };
  "company.engineModel.get": { request: void; response: CompanyEngineModelView };
  "company.engineModel.put": { request: PutCompanyEngineModelRequest; response: CompanyEngineModelView };
  "company.learningModel.get": { request: void; response: CompanyLearningModelView };
  "company.learningModel.put": { request: PutCompanyLearningModelRequest; response: CompanyLearningModelView };
  "projects.settings.get": { request: void; response: ProjectSettingsView };
  "projects.settings.put": { request: PutProjectSettingsRequest; response: ProjectSettingsView };
}

export type CodeRouteId = keyof CodeRouteTypes;
export type CodeRequest<K extends CodeRouteId> = CodeRouteTypes[K]["request"];
export type CodeResponse<K extends CodeRouteId> = CodeRouteTypes[K]["response"];

// ---------------------------------------------------------------------------------------------------------------
// Layer 1: the Cloud to Code routes

export interface CodeRouteSpec {
  id: CodeRouteId;
  method: HttpMethod;
  /** `{name}` marks a path segment. Auth routes are not under /v1/dev. */
  path: string;
  summary: string;
  scope: Scope;
  /** The must-pass screens that need it (`later` when none does). */
  screens: readonly Screen[];
  /** Served by the deployed API on code/next (`yes`), or not served (`no`). */
  awsApi: AwsApi;
  /** Set on a route that is not served and arrives with a named lane: `E2` is "the core on AWS" (its code exists in the laptop core today). */
  arrivesWith?: string;
  /** Served on Code's release branch (mainline); the second sync brings it to code/next. */
  mainline: boolean;
  /** Where it is served (path under packages/broker/src on the branch that serves it), or `none`. */
  evidence: string;
  /** Cloud's server (cloud/next packages/cloud-server) calls it today. */
  cloudCallsToday: boolean;
}

const DEV = "aws/developer-routes.ts";
const TASKS = "aws/developer-tasks.ts";
const AUTH = "developer/server.ts";
const MAIN = "mainline:";

function spec(
  id: CodeRouteId, method: HttpMethod, path: string, summary: string, scope: Scope, screens: Screen[], awsApi: AwsApi, mainline: boolean, evidence: string, cloudCallsToday = false, arrivesWith?: string,
): CodeRouteSpec {
  return { id, method, path, summary, scope, screens, awsApi, mainline, evidence, cloudCallsToday, ...(arrivesWith === undefined ? {} : { arrivesWith }) };
}

/** The laptop core's code for a route that arrives with E2 (lane E2 puts the core on AWS); the route itself is served nowhere today. */
const E2 = (laptopCore: string) => `E2 (core on AWS); laptop core: ${laptopCore}`;

const T = "/v1/dev/tasks/{taskId}";
const CP = "/v1/dev/client/projects/{project}";
const DP = "/v1/dev/projects/{project}";

export const CODE_ROUTES: readonly CodeRouteSpec[] = [
  // Sign-in (Code's sign-in server; Cloud is the client `rovara-cloud`, PKCE)
  spec("auth.authorize", "GET", "/v1/auth/authorize", "Start sign-in; Code sends the browser back with a code", "none", ["shell"], "yes", true, `${AUTH}:577`, true),
  spec("auth.token", "POST", "/v1/auth/token", "Exchange a code or a refresh token for the person's tokens", "none", ["shell"], "yes", true, `${AUTH}:587`, true),
  spec("auth.revoke", "POST", "/v1/auth/revoke", "End the person's sign-in", "none", ["shell"], "yes", true, `${AUTH}:588`),
  spec("auth.jwks", "GET", "/v1/auth/.well-known/jwks.json", "Code's public signing keys", "none", ["later"], "yes", true, `${AUTH}:573`),
  // The person
  spec("access.check", "POST", "/v1/dev/access", "Who the person is, administrator or not, the projects they may use", "none", ["shell"], "yes", true, `${DEV}:1053`, true),
  spec("me.setName", "PUT", "/v1/dev/me/name", "The person chooses their own name", "full", ["shell", "settings"], "no", true, `${MAIN}${DEV}:1261`, true),
  spec("channelLinks.list", "GET", "/v1/dev/channel-links", "The person's linked Slack accounts", "full", ["settings"], "yes", true, `${DEV}:1075`),
  spec("channelLinks.remove", "DELETE", "/v1/dev/channel-links/{channel}/{workspace}/{account}", "Unlink one account", "full", ["settings"], "yes", true, `${DEV}:1076`),
  // Projects and project members
  spec("projects.list", "GET", "/v1/dev/projects", "Projects the person may use", "full", ["admin"], "yes", true, `${DEV}:1056`),
  spec("client.projects.create", "POST", "/v1/dev/client/projects", "Create a project from a repository", "projects:create", ["admin"], "no", true, `${MAIN}${DEV}:854`, true),
  // Guided onboarding PR 10 (Code PR #837, pr/go-multi-repo): not on code/next yet. A company owner or admin may call them once Code PR 19 lands; until then Code answers 403 "only a Rovara administrator can create a project".
  spec("client.projects.bulk", "POST", "/v1/dev/client/projects/bulk", "One project per repository, each named after it; each repository answers created or one fixed refusal", "projects:create", ["admin"], "no", false, "none", true),
  spec("client.projects.get", "GET", CP, "One project: revision, access, repositories", "none", ["admin", "request"], "no", true, `${MAIN}${DEV}:870`, true),
  // Guided onboarding PR 16 (Code #839, not on code/next yet): preview first; a live company owner/admin or the project's admin changes, a project user only sees.
  spec("client.projects.archivePreview", "GET", `${CP}/archive-preview`, "What archiving the project does, and whether the person may", "full", ["later"], "no", false, "none", true),
  spec("client.projects.archive", "POST", `${CP}/archive`, "Archive a project (reviewed)", "full", ["later"], "no", false, "none", true),
  spec("client.projects.restorePreview", "GET", `${CP}/restore-preview`, "What restoring the project does, and whether the person may", "full", ["later"], "no", false, "none", true),
  spec("client.projects.restore", "POST", `${CP}/restore`, "Restore an archived project (reviewed)", "full", ["later"], "no", false, "none", true),
  // Guided onboarding PR 9: the project checklist (Code #841) not on code/next yet. The hosted setup run (Code #844) is Code's laptop /v1/app path served on the deployed API, so it is an app row (LT) Cloud forwards as is, like eval-confirm.
  spec("client.projects.setupStatus", "GET", `${CP}/setup-status`, "The project setup checklist, every row from Code's real state (any member of the company)", "full", ["later"], "no", false, "none", true),
  spec("client.projects.setupSkips", "PUT", `${CP}/setup-status/skips`, "Set an optional checklist row aside, or undo it (company owner/admin or project admin)", "full", ["later"], "no", false, "none", true),
  spec("client.projects.codeSettings.get", "GET", `${CP}/code-settings`, "Merge rules for the project", "full", ["admin"], "no", false, "none"),
  spec("client.projects.codeSettings.put", "PUT", `${CP}/code-settings`, "Change the merge rules (revision-checked)", "full", ["admin"], "no", false, "none"),
  spec("client.repositories.list", "GET", "/v1/dev/client/repositories", "The repositories Code's GitHub App can reach", "projects:create", ["admin"], "no", true, `${MAIN}${DEV}:855`, true),
  spec("client.repositories.available", "GET", "/v1/dev/client/repositories/available", "The repositories the company's connected GitHub accounts reach, paged, with the company's projects that hold each", "projects:create", ["admin"], "no", false, "none", true),
  spec("client.members.list", "GET", `${CP}/members`, "The project's members", "projects:members", ["admin"], "no", true, `${MAIN}${DEV}:895`, true),
  spec("client.members.put", "PUT", `${CP}/members/{developerId}`, "Grant a person contributor access", "projects:members", ["admin"], "no", true, `${MAIN}${DEV}:902`, true),
  spec("client.members.remove", "DELETE", `${CP}/members/{developerId}`, "Revoke a person's access", "projects:members", ["admin"], "no", true, `${MAIN}${DEV}:877`, true),
  // Tasks
  spec("tasks.start", "POST", "/v1/dev/tasks", "Start a task (the request box); the same requestId answers the same task", "full", ["request"], "yes", true, `${TASKS}:6260`, true),
  spec("tasks.list", "GET", "/v1/dev/tasks", "The person's tasks, newest first", "full", ["home", "session"], "yes", true, `${TASKS}:6261`),
  spec("tasks.get", "GET", T, "One task (send `x-agentx-task-view: 2` for the full view)", "full", ["home", "session", "plan", "proof"], "yes", true, `${TASKS}:6274`, true),
  spec("tasks.events", "GET", `${T}/events`, "The task's event stream, paged", "full", ["session"], "yes", true, `${TASKS}:6275`),
  spec("tasks.plan", "GET", `${T}/plan`, "One stored version of the plan, with its estimate (query: document, version)", "full", ["plan"], "yes", true, `${TASKS}:6276`),
  spec("tasks.cancel", "POST", `${T}/cancel`, "Stop the running step", "full", ["session"], "yes", true, `${TASKS}:6298`, true),
  spec("tasks.close", "POST", `${T}/close`, "Close the task; the first ask never discards unpublished work", "full", ["session"], "yes", true, `${TASKS}:6299`, true),
  spec("tasks.continue", "POST", `${T}/continue`, "Continue the task as a task / continue in a tool", "full", ["session"], "yes", true, `${TASKS}:6286`),
  spec("tasks.pullRequests.open", "POST", `${T}/pull-requests`, "Open a pull request for the task's code", "full", ["session"], "yes", true, `${TASKS}:6300`),
  spec("tasks.share", "POST", `${T}/share`, "Share the task (Slack share)", "full", ["later"], "yes", true, `${TASKS}:6301`),
  spec("tasks.people.get", "GET", `${T}/people`, "Who is on the task and the people revision", "full", ["session"], "yes", true, `${TASKS}:6277`, true),
  spec("tasks.people.role", "POST", `${T}/people/role`, "Propose a role change (a pending change the person confirms)", "full", ["session"], "yes", true, `${TASKS}:6278`),
  spec("tasks.people.takeOwnership", "POST", `${T}/people/take-ownership`, "Propose taking the task over", "full", ["session"], "yes", true, `${TASKS}:6282`, true),
  spec("tasks.people.candidates", "GET", `${T}/people/candidates`, "The people an owner may add from the web (names and opaque ids, at most 200; owner only). Planned: web task channel C4, not served yet", "full", ["session"], "no", false, "none", true),
  spec("tasks.people.add", "POST", `${T}/people/add`, "Add a person from the web, then the usual confirm step (owner only). Planned: web task channel C4, not served yet", "full", ["session"], "no", false, "none", true),
  spec("tasks.people.request", "GET", `${T}/people/requests/{requestId}`, "Read one pending people change", "full", ["session"], "yes", true, `${TASKS}:6266`),
  spec("tasks.readers.list", "GET", `${T}/readers`, "The people who may read the task (owner only)", "full", ["session"], "no", true, `${MAIN}${TASKS}:6286`, true),
  spec("tasks.readers.put", "PUT", `${T}/readers/{developerId}`, "Share the task with a project member, at view", "full", ["session"], "no", true, `${MAIN}aws/task-readers.ts:109`, true),
  spec("tasks.readers.remove", "DELETE", `${T}/readers/{developerId}`, "Stop sharing with a person", "full", ["session"], "no", true, `${MAIN}aws/task-readers.ts:135`, true),
  spec("tasks.workflow.decision", "POST", `${T}/workflow/decision`, "Approve a plan or request changes (revision- and digest-checked)", "full", ["plan", "home"], "yes", true, `${TASKS}:6287`, true),
  spec("tasks.workflow.review", "POST", `${T}/workflow/review`, "Run the reviews again on the same checked code (Retry reviews)", "full", ["session"], "yes", true, `${TASKS}:6290`, true),
  spec("tasks.workflow.retry", "POST", `${T}/workflow/retry`, "Retry a failed workflow step", "full", ["session"], "yes", true, `${TASKS}:6288`),
  spec("tasks.workflow.sendBack", "POST", `${T}/workflow/send-back`, "Send the work back to coding with a note", "full", ["session"], "yes", true, `${TASKS}:6293`),
  spec("tasks.workflow.reviewFindings", "POST", `${T}/workflow/review-findings`, "Resolve the reviewers' findings", "full", ["session"], "yes", true, `${TASKS}:6294`),
  spec("tasks.workflow.publishRetry", "POST", `${T}/workflow/publish-retry`, "Retry publishing the branch", "full", ["later"], "yes", true, `${TASKS}:6291`),
  spec("tasks.workflow.keepPullRequests", "POST", `${T}/workflow/keep-pull-requests`, "Keep the open pull requests when closing", "full", ["later"], "yes", true, `${TASKS}:6292`),
  spec("tasks.workflow.feedback", "GET", `${T}/workflow/feedback`, "The pull-request feedback review", "full", ["later"], "yes", true, `${TASKS}:6295`),
  spec("tasks.workflow.feedbackDecision", "POST", `${T}/workflow/feedback-decision`, "Decide on the pull-request feedback proposal", "full", ["later"], "yes", true, `${TASKS}:6296`),
  spec("tasks.workflow.feedbackRetry", "POST", `${T}/workflow/feedback-retry`, "Retry a feedback review that could not finish", "full", ["later"], "yes", true, `${TASKS}:6297`),
  // Proposed: needed by the session, plan and proof screens
  spec("tasks.messages.list", "GET", `${T}/messages`, "Comments and steering notes on the task, paged", "full", ["session"], "no", false, "none"),
  spec("tasks.messages.send", "POST", `${T}/messages`, "Add a comment, or steer the running step", "full", ["session"], "no", false, "none"),
  spec("tasks.diff", "GET", `${T}/diff`, "A pull request's diff, paged (query: repository, number, page)", "full", ["session"], "no", false, "none"),
  spec("tasks.answers", "POST", `${T}/workflow/answers`, "Answer the understanding questions", "full", ["session"], "no", false, "none", false, E2("local/app/answers.ts")),
  spec("tasks.merge", "POST", `${T}/merge`, "Press merge on the task's pull request", "full", ["session", "home"], "no", false, "none"),
  spec("tasks.evidence.list", "GET", `${T}/evidence`, "The task's proof index: each item of evidence, the criteria it speaks to, its verdict and whether the code changed since (UX audit 2026-11-15)", "full", ["proof"], "no", false, "none"),
  spec("tasks.evidence.get", "GET", `${T}/evidence/{sha256}`, "One item of evidence by digest (the proof page)", "full", ["proof"], "no", false, "none", false, E2("core/proof/evidence-pack.ts:305")),
  spec("tasks.comments.list", "GET", `${T}/comments`, "Comments on the plan documents", "full", ["plan"], "no", false, "none"),
  spec("tasks.comments.create", "POST", `${T}/comments`, "Comment on a plan document", "full", ["plan"], "no", false, "none"),
  // Proposed: Home's decision cards, How we work
  spec("decisions.list", "GET", "/v1/dev/client/decisions", "The person's pending decision cards, each with a digest", "full", ["home"], "no", false, "none", false, E2("core/decisions/routes.ts:2")),
  spec("decisions.act", "POST", "/v1/dev/client/decisions/{kind}/{subject}/{action}", "Approve, request changes, reject or record that evidence was opened (one card, one request)", "full", ["home", "plan", "proof"], "no", false, "none", false, E2("core/decisions/routes.ts:3")),
  spec("playbook.get", "GET", `${CP}/playbook`, "The project's playbook (default process, design review)", "full", ["how-we-work"], "no", false, "none", false, E2("local/app/playbook.ts:8")),
  spec("playbook.put", "PUT", `${CP}/playbook`, "Change the playbook (revision-checked)", "full", ["how-we-work"], "no", false, "none", false, E2("local/app/playbook.ts:9")),
  spec("playbook.process", "POST", `${CP}/playbook/process`, "Make the project's process layer", "full", ["how-we-work"], "no", false, "none"),
  spec("howWeWork.get", "GET", `${CP}/how-we-work`, "How we work: the layers that shape a task in this project", "full", ["how-we-work"], "no", false, "none", false, E2("local/app/playbook.ts:7")),
  // Proposed: company membership and isolation (plan 2.4, decision 17), admin
  spec("company.members.list", "GET", "/v1/dev/client/company/members", "The company's people and roles", "full", ["admin"], "no", false, "none"),
  spec("company.members.setRole", "PUT", "/v1/dev/client/company/members/{developerId}/role", "Change a person's company role", "full", ["admin"], "no", false, "none"),
  spec("company.members.removalPreview", "GET", "/v1/dev/client/company/members/{developerId}/removal-preview", "What removing a person would hand over", "full", ["admin"], "no", false, "none"),
  spec("company.members.remove", "POST", "/v1/dev/client/company/members/{developerId}/removal", "Remove a person; hand their work to a successor", "full", ["admin"], "no", false, "none"),
  spec("company.preApproved.put", "PUT", "/v1/dev/client/company/pre-approved-emails", "Cloud's invite tells Code an email is pre-approved (written by the inviting admin's own call)", "full", ["admin"], "no", false, "none"),
  spec("company.preapprovals.create", "POST", "/v1/dev/company/preapprovals", "Cloud's invite pre-approves a member's email in the inviter's company (the inviting admin's own call; Code checks the role)", "full", ["admin"], "yes", false, `${DEV}:1561`, true),
  spec("company.preapprovals.withdraw", "DELETE", "/v1/dev/company/preapprovals/{emailHash}", "Withdraw a pre-approval by the SHA-256 of the email", "full", ["admin"], "yes", false, `${DEV}:1561`, true),
  spec("company.create", "POST", "/v1/dev/company", "A person with no company creates one with an operator's invite code and becomes its owner (DEC 254a)", "full", ["shell"], "no", false, "none", true),
  // Guided onboarding (Code PR #830, pr/go-github-claim): not on code/next yet; Code answers 404 while COMPANY_SIGNIN is off.
  spec("company.github.connect", "POST", "/v1/dev/company/github/connect", "A company owner or admin starts connecting GitHub: a single-use state and GitHub's install and authorize addresses", "full", ["admin"], "no", false, "none", true),
  spec("company.github.claim", "POST", "/v1/dev/company/github/claim", "GitHub's return: spend the state, check the person controls the installation, bind it or list the ones they control", "full", ["admin"], "no", false, "none", true),
  spec("company.github.choose", "POST", "/v1/dev/company/github/choose", "Bind one installation from a claim's checked list, with its single-use ticket", "full", ["admin"], "no", false, "none", true),
  spec("company.github.status", "GET", "/v1/dev/company/github", "The company's connected GitHub installations, who connected each and when (any member)", "full", ["admin"], "no", false, "none", true),
  spec("company.github.disconnect", "DELETE", "/v1/dev/company/github/{installationId}", "A company owner disconnects one GitHub installation (refused while projects use it)", "full", ["admin"], "no", false, "none", true),
  // Guided onboarding (Code PRs #836 pr/go-slack-install, #840 pr/go-slack-channel, #838 pr/go-linear-oauth): not on code/next yet.
  spec("company.slack.install", "POST", "/v1/dev/company/slack/install", "A company owner or admin starts Add to Slack: a single-use state and Slack's OAuth v2 address for Cloud's callback", "full", ["admin"], "no", false, "none", true),
  spec("company.slack.installComplete", "POST", "/v1/dev/company/slack/install/complete", "Slack's return: spend the state, exchange the code, bind the workspace to the company", "full", ["admin"], "no", false, "none", true),
  spec("company.slack.get", "GET", "/v1/dev/company/slack", "The company's Slack workspace, who connected it and when (any member)", "full", ["admin"], "no", false, "none", true),
  spec("company.slack.disconnect", "POST", "/v1/dev/company/slack/disconnect", "A company owner disconnects Slack", "full", ["admin"], "no", false, "none", true),
  spec("company.slack.channels", "GET", "/v1/dev/company/slack/channels", "One page of the company workspace's channels a project may link", "full", ["admin"], "no", false, "none", true),
  spec("company.slack.channel.get", "GET", "/v1/dev/company/slack/projects/{project}/channel", "A project's linked Slack channel", "full", ["admin"], "no", false, "none", true),
  spec("company.slack.channel.link", "PUT", "/v1/dev/company/slack/projects/{project}/channel", "Link a project's Slack channel (or say the bot must be invited)", "full", ["admin"], "no", false, "none", true),
  spec("company.slack.channel.check", "POST", "/v1/dev/company/slack/projects/{project}/channel/check", "Check again after /invite, then link", "full", ["admin"], "no", false, "none", true),
  spec("company.slack.channel.unlink", "DELETE", "/v1/dev/company/slack/projects/{project}/channel", "Unlink a project's Slack channel", "full", ["admin"], "no", false, "none", true),
  spec("company.linear.connect", "POST", "/v1/dev/company/linear/connect", "A company owner or admin starts Connect Linear: a single-use state and Linear's consent address (as the app, PKCE)", "full", ["admin"], "no", false, "none", true),
  spec("company.linear.complete", "POST", "/v1/dev/company/linear/complete", "Linear's return: spend the state, exchange the code, bind the Linear workspace", "full", ["admin"], "no", false, "none", true),
  spec("company.linear.get", "GET", "/v1/dev/company/linear", "The company's Linear connection (any member)", "full", ["admin"], "no", false, "none", true),
  spec("company.linear.disconnect", "DELETE", "/v1/dev/company/linear", "A company owner disconnects Linear", "full", ["admin"], "no", false, "none", true),
  spec("company.linear.team.get", "GET", "/v1/dev/company/linear/projects/{project}", "A project's Linear team and the teams the company's token sees", "full", ["admin"], "no", false, "none", true),
  spec("company.linear.team.put", "PUT", "/v1/dev/company/linear/projects/{project}", "Pick a project's Linear team", "full", ["admin"], "no", false, "none", true),
  spec("company.linear.team.clear", "DELETE", "/v1/dev/company/linear/projects/{project}", "Clear a project's Linear team", "full", ["admin"], "no", false, "none", true),
  spec("company.audit.records", "GET", "/v1/dev/client/company/audit/records", "Engine audit records, for a company administrator (lane AU)", "full", ["admin"], "no", false, "none"),
  // Settings: the person's script tokens
  spec("scriptTokens.list", "GET", "/v1/app/script-tokens", "The caller's tokens, or company tokens Code lets them manage", "full", ["settings"], "yes", true, "core-host/dev-routes.ts:455-476 (code/next 5b8f7f504)", true),
  spec("scriptTokens.create", "POST", "/v1/app/script-tokens", "Make a script token; secret shown once", "full", ["settings"], "yes", true, "core-host/dev-routes.ts:455-476 (code/next 5b8f7f504)", true),
  spec("scriptTokens.revoke", "POST", "/v1/app/script-tokens/{tokenId}/revoke", "Revoke one", "full", ["settings"], "yes", true, "core-host/dev-routes.ts:455-476 (code/next 5b8f7f504)", true),
  // Lessons (PrepLabsAI/Rovara#713, LM8 part 1): served by code/next once merged and wired (its Step 6); until then every route answers 404 LESSONS_SWITCHED_OFF "Lessons are off."
  spec("lessons.list", "GET", `${DP}/lessons`, "One page of a project's lessons (query: list=proposed|approved|retired, since, limit 1..100, cursor)", "full", ["home", "how-we-work"], "no", false, "none", true),
  spec("lessons.approve", "POST", `${DP}/lessons/{lessonId}/approve`, "Keep a proposed lesson: the version read, or an edit of it", "full", ["how-we-work"], "no", false, "none", true),
  spec("lessons.reject", "POST", `${DP}/lessons/{lessonId}/reject`, "Drop a proposed lesson, with a fixed reason", "full", ["how-we-work"], "no", false, "none", true),
  spec("lessons.decisions", "POST", `${DP}/lessons/decisions`, "Keep or Drop up to 20 proposed lessons at once (the inbox batch); one result each", "full", ["home"], "no", false, "none", true),
  spec("lessons.retire", "POST", `${DP}/lessons/{lessonId}/retire`, "Retire a lesson, with a fixed reason", "full", ["how-we-work"], "no", false, "none", true),
  spec("lessons.retireRequest", "POST", `${DP}/lessons/{lessonId}/retire-request`, "Anyone on the project asks the people who decide to retire a lesson", "full", ["how-we-work"], "no", false, "none", true),
  spec("lessons.retireRequests", "GET", `${DP}/lessons/retire-requests`, "The open retire requests (people who decide)", "full", ["how-we-work"], "no", false, "none", true),
  spec("lessons.task", "GET", `${DP}/tasks/{taskId}/lessons`, "The lessons a task was given (Lessons used)", "full", ["session"], "no", false, "none", true),
  spec("lessons.notHelpful", "POST", `${DP}/tasks/{taskId}/lessons/{lessonId}/not-helpful`, "Mark a lesson the task was given as not helpful", "full", ["session"], "no", false, "none", true),
  spec("lessons.mode.get", "GET", `${DP}/lessons/mode`, "The project's learning mode, the mode in force and whether the company locks it", "full", ["how-we-work"], "no", false, "none", true),
  spec("lessons.mode.put", "PUT", `${DP}/lessons/mode`, "Set the learning mode (a project admin, or a company owner or admin)", "full", ["how-we-work"], "no", false, "none", true),
  spec("lessons.graduation", "GET", `${DP}/lessons/graduation`, "This week's one Make this permanent card, the tidy card and the draft tasks (people who decide)", "full", ["how-we-work"], "no", false, "none", true),
  spec("lessons.graduate", "POST", `${DP}/lessons/{lessonId}/graduate`, "Make a proven lesson permanent: a team rule, a draft task to add a check, or a skill", "full", ["how-we-work"], "no", false, "none", true),
  spec("lessons.graduateLater", "POST", `${DP}/lessons/{lessonId}/graduate-later`, "Not now: no card for this lesson for 60 days", "full", ["how-we-work"], "no", false, "none", true),
  spec("lessons.bothPlaces", "POST", `${DP}/lessons/{lessonId}/both-places`, "A conflict's third answer: both lessons are right, each in its own place", "full", ["how-we-work"], "no", false, "none", true),
  spec("lessons.tidy.retire", "POST", `${DP}/lessons/tidy/retire-chosen`, "Retire the lessons chosen on the tidy card (1 to 10)", "full", ["how-we-work"], "no", false, "none", true),
  spec("lessons.tidy.later", "POST", `${DP}/lessons/tidy/later`, "Not now: close this period's tidy card", "full", ["how-we-work"], "no", false, "none", true),
  spec("lessons.checkDraft.started", "POST", `${DP}/lessons/check-drafts/{draftId}/started`, "The person says which of their own tasks they started from a draft", "full", ["how-we-work"], "no", false, "none", true),
  spec("lessons.checkDraft.dismiss", "POST", `${DP}/lessons/check-drafts/{draftId}/dismiss`, "Drop a draft task", "full", ["how-we-work"], "no", false, "none", true),
  spec("lessons.rules.retire", "POST", `${DP}/lessons/rules/{ruleId}/retire`, "Retire a live team rule (people who decide; audited)", "full", ["how-we-work"], "no", false, "none", true),
  spec("lessons.measure", "GET", `${DP}/lessons/measure`, "Counts only lesson fit, below-floor loads, clean merges and revert detection (maintainer or company owner/admin)", "full", ["how-we-work"], "no", false, "none", true),
  // Lead 4 L4-LP3W (Code pr/l4-lessons-by-area): the approved lessons by code area, and "Where Rovara learns from" with its Pause.
  spec("lessons.areas", "GET", `${DP}/lessons/areas`, "The approved lessons by code area (a tree), and the lessons at one node (query: repo, folder, whole=1)", "full", ["how-we-work"], "no", false, "none", true),
  spec("lessons.learningSources.get", "GET", `${DP}/lessons/learning-sources`, "Where Rovara learns from: a row per kind of source with seen, suggested and kept counts (30 days), one example and whether it is paused", "full", ["how-we-work"], "no", false, "none", true),
  spec("lessons.learningSources.put", "PUT", `${DP}/lessons/learning-sources/{source}`, "Pause or resume one source (a project admin, or a company owner or admin; recorded first)", "full", ["how-we-work"], "no", false, "none", true),
  // Guided onboarding PR 15 (DEC 254l item 7, 254n item 1): the company's AI model (Code #835, not on code/next yet) and a project's per-task model budget (Code's M4a settings).
  // L4-EGR: Rovara's fixed outbound addresses (owner or admin), shown read-only in company settings. Code company-egress-routes.ts.
  // L4-JA7 (Code pr/l4-ja-knowledge-switch-hosted): "Knowledge stays in Rovara" (company owner or admin) and a project's "local coding tools can fetch lessons" (the project's admin, or a company owner or admin; recorded first).
  spec("company.knowledgeStays.get", "GET", "/v1/dev/company/lessons/local-tools", "Whether the company keeps team knowledge inside Rovara (owner or admin)", "full", ["admin"], "no", false, "none", true),
  spec("company.knowledgeStays.put", "PUT", "/v1/dev/company/lessons/local-tools", "Turn Knowledge stays in Rovara on or off (owner or admin; recorded first)", "full", ["admin"], "no", false, "none", true),
  spec("lessons.localTools.get", "GET", `${DP}/lessons/local-tools`, "Whether local coding tools get the project's lessons now, and the first reason they do not (a person on the project)", "full", ["how-we-work"], "no", false, "none", true),
  spec("lessons.localTools.put", "PUT", `${DP}/lessons/local-tools`, "Turn the project's local coding tools setting on or off (a project admin, or a company owner or admin; recorded first)", "full", ["how-we-work"], "no", false, "none", true),
  spec("company.egressAddresses.get", "GET", "/v1/dev/company/egress-addresses", "Rovara's outbound addresses (the same for every company on this Rovara), for a company owner or admin", "full", ["admin"], "no", false, "none", true),
  spec("company.engineModel.get", "GET", "/v1/dev/company/engine-model", "The company's engine model, the models the gateway offers it now, and the one to preselect (any member)", "full", ["later"], "no", false, "none", true),
  spec("company.engineModel.put", "PUT", "/v1/dev/company/engine-model", "Set or clear the company's engine model, only from its offered list (owner or admin)", "full", ["later"], "no", false, "none", true),
  // Code #1075 (DEC 254zzz63): the model lessons learn with, a company choice beside the install default.
  spec("company.learningModel.get", "GET", "/v1/dev/company/learning-model", "The model lessons learn with, whether it is the company's choice or the install default, and the Claude models the gateway offers it now (any member)", "full", ["later"], "no", false, "none", true),
  spec("company.learningModel.put", "PUT", "/v1/dev/company/learning-model", "Set or clear the company's lessons learning model, only from its offered Claude models (owner or admin)", "full", ["later"], "no", false, "none", true),
  spec("projects.settings.get", "GET", `${DP}/settings`, "A project's cost and approval settings (preset, overrides, what applies)", "full", ["later"], "yes", false, `${DEV}:1924`, true),
  spec("projects.settings.put", "PUT", `${DP}/settings`, "Change them (revision-checked; the project's administrator)", "full", ["later"], "yes", false, `${DEV}:1924`, true),
];

// ---------------------------------------------------------------------------------------------------------------
// Layer 2: the web app's routes to Cloud (`/v1/app/*`)

export interface AppRouteSpec {
  method: HttpMethod;
  path: string;
  /** Who holds the data or the rule (plan 2.2): Code, Cloud's backend or Cloud's gateway. */
  owner: Owner;
  /** The must-pass screen that needs it, or `later`. */
  screen: Screen;
  /** The Code routes that back it (empty when Cloud answers from its own tables). */
  codeRoutes: readonly CodeRouteId[];
  /** The app module on integ/0519 (`packages/ui/src/api/<name>.ts` or the screen file) that calls it and holds its reader. */
  source: string;
  /** cloud/next's cloud-server answers it today (`packages/cloud-server/src/routes.ts`). */
  cloudServerToday: boolean;
  /** code/next's core already serves the same `/v1/app` path in the laptop app. */
  codeCoreLocal: boolean;
}

/**
 * One line per route: `METHOD /path | owner | screen | code route ids (comma) | source | flags`.
 * Owners: k = Code, c = Cloud backend, g = Cloud gateway. Flags: T = answered by cloud-server today, L = code/next core serves the same path locally.
 * Counted from the web app's call sites on integ/0519 3b408ae40 (packages/ui/src), each method and path once.
 */
const APP_ROUTE_ROWS = `
GET /v1/app/me | c | shell | access.check | onboarding | T
PUT /v1/app/me/name | k | shell | me.setName | shell/NameForm | T
GET /v1/app/me/sign-ins | k | later | | sign-ins | T
POST /v1/app/me/sign-ins/link | k | later | | sign-ins | T
DELETE /v1/app/me/sign-ins/{method} | k | later | | sign-ins | T
GET /v1/app/me/lessons-slack | k | later | | admin-company | T
PUT /v1/app/me/lessons-slack | k | later | | admin-company | T
GET /v1/app/me/github | k | later | | github-link | T
POST /v1/app/me/github/link | k | later | | github-link | T
DELETE /v1/app/me/github | k | later | | github-link | T
GET /v1/app/nav | c | shell | access.check,tasks.list,decisions.list | nav | T
GET /v1/app/home | c | home | tasks.list,tasks.get,decisions.list | home | T
POST /v1/app/home/cards/{card}/dismiss | c | home | | work-list |
GET /v1/app/decisions | k | home | decisions.list | decisions | LT
POST /v1/app/decisions/{kind}/{subject}/approve | k | home | decisions.act | decisions | LT
POST /v1/app/decisions/{kind}/{subject}/request-changes | k | home | decisions.act | decisions | LT
POST /v1/app/decisions/{kind}/{subject}/reject | k | home | decisions.act | decisions | LT
POST /v1/app/decisions/{kind}/{subject}/evidence-opened | k | proof | decisions.act | decisions | LT
GET /v1/app/changes | c | session | tasks.list | realtime/client |
POST /v1/app/realtime/token | c | later | | session-routes | T
GET /v1/app/live | c | later | tasks.list | live |
GET /v1/app/sessions | c | home | tasks.list | work-list |
GET /v1/app/inbox | k | later | | inbox | T
POST /v1/app/inbox/read | k | later | | inbox | T
GET /v1/app/inbox/project-notices | k | later | | inbox | T
GET /v1/app/sessions/{id} | c | session | tasks.get,tasks.people.get | sessions | T
GET /v1/app/sessions/{id}/events | k | session | tasks.events | sessions | T
GET /v1/app/sessions/{id}/log | k | later | | screens/session/DecisionsCard | T
GET /v1/app/sessions/{id}/messages | k | session | tasks.messages.list | sessions | T
POST /v1/app/sessions/{id}/messages | k | session | tasks.messages.send | sessions | T
PATCH /v1/app/sessions/{id}/messages/{messageId} | k | session | tasks.messages.send | sessions | T
DELETE /v1/app/sessions/{id}/messages/{messageId} | k | session | tasks.messages.send | sessions | T
POST /v1/app/sessions/{id}/stop | k | session | tasks.cancel | session-actions | T
POST /v1/app/sessions/{id}/retry | k | session | tasks.workflow.review | session-actions | T
POST /v1/app/sessions/{id}/take-over | k | session | tasks.people.takeOwnership | session-actions | T
GET /v1/app/sessions/{id}/people | k | session | tasks.people.get | screens/session/PeoplePanel | T
GET /v1/app/sessions/{id}/people/candidates | k | session | tasks.people.candidates | screens/session/PeoplePanel | T
POST /v1/app/sessions/{id}/people/role | k | session | tasks.people.role | screens/session/PeoplePanel | T
POST /v1/app/sessions/{id}/people/add | k | session | tasks.people.add | screens/session/PeoplePanel | T
POST /v1/app/sessions/{id}/people/take-ownership | k | session | tasks.people.takeOwnership | screens/session/PeoplePanel | T
POST /v1/app/sessions/{id}/close | k | session | tasks.close | session-actions | T
POST /v1/app/sessions/{id}/merge | k | session | tasks.merge | session-actions |
POST /v1/app/sessions/{id}/answers | k | session | tasks.answers | session-actions | L
POST /v1/app/sessions/{id}/change-anyway | k | session | tasks.workflow.retry | session-actions |
POST /v1/app/sessions/{id}/agent | k | later | | sessions |
POST /v1/app/sessions/{id}/follow | c | session | | sessions | LT
DELETE /v1/app/sessions/{id}/follow | c | session | | sessions | LT
POST /v1/app/sessions/{id}/presence | c | session | | sessions | LT
GET /v1/app/sessions/{id}/shares | k | session | tasks.readers.list | sessions | T
PUT /v1/app/sessions/{id}/shares | k | session | tasks.readers.put | sessions | T
DELETE /v1/app/sessions/{id}/shares/{principalKey} | k | session | tasks.readers.remove | sessions | T
GET /v1/app/sessions/{id}/diff | k | session | tasks.diff | screens/session/ChangesTab |
GET /v1/app/sessions/{id}/sections/{n}/task | k | later | tasks.get | screens/session/ChainSections |
POST /v1/app/sessions/{id}/ask | k | later | | session-ask | L
GET /v1/app/sessions/{id}/asks/{askId} | k | later | | session-ask | L
POST /v1/app/tasks/{t}/continue-as-task | k | session | tasks.continue | sessions |
POST /v1/app/tasks/{t}/answers | k | home | tasks.answers | work | T
POST /v1/app/tasks/{t}/continue/publish-branch | k | later | tasks.continue | continue-loop |
POST /v1/app/tasks/{t}/continue/recheck | k | later | tasks.continue | continue-loop |
GET /v1/app/tasks/{t}/documents/{document} | k | plan | tasks.plan | plan-panel |
GET /v1/app/tasks/{t}/comments | k | plan | tasks.comments.list | plan-panel |
POST /v1/app/tasks/{t}/comments | k | plan | tasks.comments.create | plan-panel |
POST /v1/app/tasks/{t}/comments/{commentId}/edit | k | plan | tasks.comments.create | plan-panel |
POST /v1/app/tasks/{t}/comments/{commentId}/delete | k | plan | tasks.comments.create | plan-panel |
POST /v1/app/tasks/{t}/comments/{commentId}/remember | k | later | | plan-panel |
POST /v1/app/tasks/{t}/comments/{commentId}/forget | k | later | | plan-panel |
POST /v1/app/tasks/{t}/suggestions | k | plan | tasks.comments.create | plan-panel |
GET /v1/app/tasks/{t}/workflow/feedback | k | later | tasks.workflow.feedback | plan-panel |
POST /v1/app/tasks/{t}/workflow/feedback-retry | k | later | tasks.workflow.feedbackRetry | plan-panel |
POST /v1/app/tasks/{t}/workflow/feedback-decision | k | later | tasks.workflow.feedbackDecision | plan-panel |
POST /v1/app/tasks/{t}/workflow/review-findings | k | session | tasks.workflow.reviewFindings | screens/session/FindingsActions |
POST /v1/app/tasks/{t}/workflow/send-back | k | session | tasks.workflow.sendBack | screens/session/FindingsActions |
POST /v1/app/tasks/{t}/workflow/checks-retry | k | session | tasks.workflow.retry | screens/session/StoppedTaskActions |
POST /v1/app/tasks/{t}/workflow/revise-plan | k | plan | tasks.workflow.retry | screens/session/StoppedTaskActions |
POST /v1/app/tasks/{t}/spec/{choice} | k | later | | screens/session/StoppedTaskActions |
GET /v1/app/tasks/{t}/people | k | session | tasks.people.get | screens/session/TaskPagePeopleAndComments |
POST /v1/app/tasks/{t}/people/role | k | session | tasks.people.role | screens/session/TaskPagePeopleAndComments |
POST /v1/app/tasks/{t}/people/take-ownership | k | session | tasks.people.takeOwnership | screens/session/TaskPagePeopleAndComments |
GET /v1/app/tasks/{t}/evidence/{sha256} | k | proof | tasks.evidence.get | screens/session/EvidenceTab |
GET /v1/app/tasks/{t}/loaded-knowledge | k | later | | loaded-knowledge |
GET /v1/app/tasks/{t}/loaded-knowledge/{operationId}/{stage}/items/{index}/text | k | later | | loaded-knowledge |
GET /v1/app/tasks/{t}/lessons | k | later | | lessons | L
POST /v1/app/tasks/{t}/lessons/{lessonId}/feedback | k | later | | lessons | L
POST /v1/app/tasks/{t}/second-review-acknowledge | k | later | | second-review |
POST /v1/app/tasks/{t}/design-review/first | k | later | | design-review |
POST /v1/app/tasks/{t}/design-review/skip | k | later | | design-review |
POST /v1/app/tasks/{t}/design-review/retry | k | later | | design-review |
GET /v1/app/tasks/{t}/design-review/approve | k | later | | design-review |
POST /v1/app/tasks/{t}/design-review/approve | k | later | | design-review |
POST /v1/app/tasks/{t}/design-review/answers | k | later | | design-review |
POST /v1/app/tasks/{t}/design-review/resume | k | later | | design-review |
POST /v1/app/tasks/{t}/design-review/spend/{choice} | k | later | | design-review |
GET /v1/app/tasks/{t}/review | k | later | | review-groups |
POST /v1/app/tasks/{t}/review/claim | k | later | | review-groups |
POST /v1/app/tasks/{t}/review/release | k | later | | review-groups |
POST /v1/app/tasks/{t}/review/reassign | k | later | | review-groups |
POST /v1/app/projects/{p}/code | k | request | tasks.start | code | T
POST /v1/app/projects/{p}/code/suggest | k | request | | code | T
POST /v1/app/projects/{p}/start-preview | c | later | | code | T
GET /v1/app/projects | k | admin | access.check,client.projects.get | projects | T
POST /v1/app/projects | k | admin | client.projects.create,client.projects.bulk | onboarding | T
GET /v1/app/projects/{p} | k | admin | access.check,client.projects.get | onboarding | T
GET /v1/app/projects/{p}/overview | c | shell | client.projects.get,tasks.list | projects | T
GET /v1/app/projects/{p}/members | k | admin | client.members.list | review-groups | T
PUT /v1/app/projects/{p}/members/{who} | k | admin | client.members.put | project-people | T
DELETE /v1/app/projects/{p}/members/{who} | k | admin | client.members.remove | project-people | T
GET /v1/app/projects/{p}/people | k | admin | client.members.list | project-people |
PUT /v1/app/projects/{p}/people/{who} | k | admin | client.members.put | project-people |
DELETE /v1/app/projects/{p}/people/{who} | k | admin | client.members.remove | project-people |
GET /v1/app/projects/{p}/code-settings | k | admin | client.projects.codeSettings.get | project-people |
PUT /v1/app/projects/{p}/code-settings | k | admin | client.projects.codeSettings.put | project-people |
GET /v1/app/projects/{p}/how-we-work | k | how-we-work | howWeWork.get | how-we-work | LT
POST /v1/app/projects/{p}/playbook/process | k | how-we-work | playbook.process | how-we-work |
GET /v1/app/projects/{p}/playbook | k | how-we-work | playbook.get | how-we-work | L
PUT /v1/app/projects/{p}/playbook | k | how-we-work | playbook.put | how-we-work | L
GET /v1/app/projects/{p}/spend | g | budgets | | spending |
GET /v1/app/projects/{p}/archive-preview | k | later | client.projects.archivePreview | admin/projects/ArchiveProject | T
POST /v1/app/projects/{p}/reviewed-archive | k | later | client.projects.archive | admin/projects/ArchiveProject | T
GET /v1/app/projects/{p}/restore-preview | k | later | client.projects.restorePreview | admin/projects/RestoreProject | T
POST /v1/app/projects/{p}/reviewed-restore | k | later | client.projects.restore | admin/projects/RestoreProject | T
GET /v1/app/projects/{p}/lifecycle | k | later | client.projects.archivePreview,client.projects.restorePreview | admin/projects/ProjectDetailScreen | T
GET /v1/app/projects/{p}/working-branches | k | later | | admin/projects/WorkingBranches |
POST /v1/app/projects/{p}/working-branches | k | later | | admin/projects/SaveWorkingBranch |
GET /v1/app/projects/{p}/working-branches/requests/{requestId} | k | later | | admin/projects/SaveWorkingBranch |
GET /v1/app/projects/{p}/repositories/{repo}/branches | k | later | | admin/projects/WorkingBranches |
GET /v1/app/projects/{p}/allowed-websites | k | later | | allowed-websites |
POST /v1/app/projects/{p}/allowed-websites | k | later | | allowed-websites |
POST /v1/app/projects/{p}/allowed-websites/proposals | k | later | | allowed-websites |
GET /v1/app/projects/{p}/allowed-websites/proposals/{proposalId} | k | later | | allowed-websites |
POST /v1/app/projects/{p}/allowed-websites/proposals/{proposalId}/{decision} | k | later | | allowed-websites |
GET /v1/app/projects/{p}/allowed-websites/requests/{requestId} | k | later | | allowed-websites |
GET /v1/app/projects/{p}/slack-channel/links | k | later | | project-slack |
GET /v1/app/projects/{p}/slack-channel/review | k | later | | project-slack |
GET /v1/app/projects/{p}/slack-channel/requests/{requestId} | k | later | | project-slack |
GET /v1/app/projects/{p}/slack-channel/proposals/{proposalId} | k | later | | project-slack |
POST /v1/app/projects/{p}/slack-channel/proposals | k | later | | project-slack |
POST /v1/app/projects/{p}/slack-channel/proposals/{proposalId}/approve | k | later | | project-slack |
POST /v1/app/projects/{p}/slack-channel/proposals/{proposalId}/{decision} | k | later | | project-slack |
GET /v1/app/projects/{p}/slack-channel/decisions/{requestId} | k | later | | project-slack |
POST /v1/app/projects/{p}/slack-channel/unbind | k | later | | project-slack |
GET /v1/app/projects/{p}/setup-draft | k | later | | onboarding |
POST /v1/app/projects/{p}/setup-draft | k | later | | onboarding |
POST /v1/app/projects/{p}/setup-draft/apply | k | later | | onboarding |
POST /v1/app/projects/{p}/setup-draft/typed | k | later | | onboarding |
GET /v1/app/projects/{p}/branch-check | k | later | | onboarding |
POST /v1/app/projects/{p}/branch-check/continue | k | later | | onboarding |
PUT /v1/app/projects/{p}/default-branch | k | later | | onboarding |
PUT /v1/app/projects/{p}/settings | k | later | | onboarding |
POST /v1/app/projects/{p}/settings/undo | k | later | | onboarding |
POST /v1/app/projects/{p}/setup-check | k | later | | onboarding |
PUT /v1/app/projects/{p}/agents/{agentId} | k | later | | onboarding |
GET /v1/app/projects/{p}/setup-agent | k | later | | setup-agent | LT
GET /v1/app/projects/{p}/setup-agent/journal | k | later | | setup-agent | LT
POST /v1/app/projects/{p}/setup-agent | k | later | | setup-agent | LT
POST /v1/app/projects/{p}/setup-agent/stop | k | later | | setup-agent | LT
GET /v1/app/projects/{p}/setup-status | k | later | client.projects.setupStatus | setup-status | T
PUT /v1/app/projects/{p}/setup-status/skips | k | later | client.projects.setupSkips | setup-status | T
GET /v1/app/projects/{p}/wiki | k | later | | wiki | T
GET /v1/app/projects/{p}/wiki/search | k | later | | wiki | T
GET /v1/app/projects/{p}/wiki/pages/{pageId} | k | later | | wiki | T
GET /v1/app/projects/{p}/wiki/pages/{pageId}/sources | k | later | | wiki | T
GET /v1/app/projects/{p}/wiki/pages/{pageId}/lessons | k | later | | wiki | T
GET /v1/app/projects/{p}/wiki/pages/{pageId}/corrections | k | later | | wiki | T
POST /v1/app/projects/{p}/wiki/pages/{pageId}/notes | k | later | | wiki | T
POST /v1/app/projects/{p}/wiki/pages/{pageId}/notes/{noteId}/approve | k | later | | wiki | T
POST /v1/app/projects/{p}/wiki/pages/{pageId}/notes/{noteId}/delete | k | later | | wiki | T
POST /v1/app/projects/{p}/wiki/pages/{pageId}/notes/{noteId}/acknowledge | k | later | | wiki | T
POST /v1/app/projects/{p}/wiki/pages/{pageId}/notes/{noteId}/suggest-lesson | k | later | | wiki | T
POST /v1/app/projects/{p}/wiki/pages/{pageId}/flags | k | later | | wiki | T
POST /v1/app/projects/{p}/wiki/pages/{pageId}/flags/resolve | k | later | | wiki | T
GET /v1/app/projects/{p}/wiki/disputed | k | later | | wiki | T
GET /v1/app/projects/{p}/wiki/gaps | k | later | | wiki | T
GET /v1/app/projects/{p}/wiki-map | k | later | | wiki-setup | T
POST /v1/app/projects/{p}/wiki-map | k | later | | wiki-setup | T
GET /v1/app/projects/{p}/wiki-build | k | later | | wiki-setup | T
POST /v1/app/projects/{p}/wiki-build | k | later | | wiki-setup | T
POST /v1/app/projects/{p}/wiki-build/continue | k | later | | wiki-setup | T
POST /v1/app/projects/{p}/wiki-build/stop | k | later | | wiki-setup | T
POST /v1/app/projects/{p}/wiki-build/refresh | k | later | | wiki-setup | T
POST /v1/app/projects/{p}/wiki-build/agents | k | later | | wiki-setup | T
POST /v1/app/projects/{p}/wiki-build/delete | k | later | | wiki-setup | T
GET /v1/app/projects/{p}/upkeep | k | later | | wiki-setup | T
PUT /v1/app/projects/{p}/upkeep | k | later | | wiki-setup | T
GET /v1/app/projects/{p}/ci-eval-check | k | later | | eval-check | T
PUT /v1/app/projects/{p}/ci-eval-check | k | later | | eval-check | T
POST /v1/app/projects/{p}/answers | k | later | | answers | T
POST /v1/app/projects/{p}/answers/{a}/not-right | k | later | | answers | T
GET /v1/app/company/system-runs | k | later | | wiki-setup | T
PUT /v1/app/company/system-runs | k | later | | wiki-setup | T
GET /v1/app/projects/{p}/setup-repair | k | later | | setup-repair | T
POST /v1/app/projects/{p}/setup-repair/recheck | k | later | | setup-repair | T
POST /v1/app/projects/{p}/setup-agent/command | k | later | | setup-agent | L
POST /v1/app/projects/{p}/setup-agent/confirm | k | later | | setup-agent | LT
POST /v1/app/projects/{p}/setup-agent/discard | k | later | | setup-agent | LT
POST /v1/app/projects/{p}/setup-agent/decide | k | later | | setup-agent | T
POST /v1/app/projects/{p}/setup-agent/eval-confirm | k | later | | setup-agent | LT
GET /v1/app/projects/{p}/setup-agent/eval | k | later | | setup-agent | T
POST /v1/app/projects/{p}/setup-agent/eval-approve | k | later | | setup-agent | T
POST /v1/app/projects/{p}/setup-agent/eval-decide | k | later | | setup-agent | T
POST /v1/app/projects/{p}/setup-agent/eval-health | k | later | | setup-agent | T
POST /v1/app/projects/{p}/setup-agent/eval-wrapper | k | later | | setup-agent | T
GET /v1/app/projects/{p}/setup-agent/limits | k | later | | setup-limits |
PUT /v1/app/projects/{p}/setup-agent/limits | k | later | | setup-limits |
GET /v1/app/projects/{p}/setup-recipe | k | later | | setup-recipes |
POST /v1/app/projects/{p}/setup-recipe | k | later | | setup-recipes |
GET /v1/app/projects/{p}/environment-image | k | later | | saved-env | T
POST /v1/app/projects/{p}/environment-image | k | later | | saved-env |
PUT /v1/app/projects/{p}/environment-image/setting | k | later | | saved-env |
GET /v1/app/projects/{p}/test-environment | k | later | | test-environment |
GET /v1/app/projects/{p}/machine-size | k | later | | machine-size | T
POST /v1/app/projects/{p}/machine-size | k | later | | machine-size | T
POST /v1/app/projects/{p}/test-environment/propose | k | later | | test-environment |
POST /v1/app/projects/{p}/test-environment/edit | k | later | | test-environment |
POST /v1/app/projects/{p}/test-environment/seed | k | later | | test-environment |
POST /v1/app/projects/{p}/test-environment/prove | k | later | | test-environment |
POST /v1/app/projects/{p}/test-environment/check | k | later | | test-environment |
POST /v1/app/projects/{p}/test-environment/apply-commands | k | later | | test-environment |
POST /v1/app/projects/{p}/test-environment/request-approval | k | later | | test-environment |
POST /v1/app/projects/{p}/test-environment/approve | k | later | | test-environment |
GET /v1/app/projects/{p}/review-groups | k | later | | review-groups |
PUT /v1/app/projects/{p}/review-groups | k | later | | review-groups |
GET /v1/app/projects/{p}/product-decisions | k | later | | product-decisions |
POST /v1/app/projects/{p}/product-decisions/{id} | k | later | | product-decisions |
GET /v1/app/projects/{p}/collaborator-approvals | k | later | | product-decisions |
PUT /v1/app/projects/{p}/collaborator-approvals | k | later | | product-decisions |
GET /v1/app/projects/{p}/known-failing | k | later | | known-failing |
POST /v1/app/projects/{p}/known-failing | k | later | | known-failing |
GET /v1/app/projects/{p}/lessons | k | how-we-work | lessons.list | learned | T
GET /v1/app/projects/{p}/lessons/digest | k | later | | lessons | L
GET /v1/app/projects/{p}/lessons/sources | k | later | | lessons | L
GET /v1/app/projects/{p}/lessons/{lessonId}/history | k | later | | lessons | L
POST /v1/app/projects/{p}/lessons/{lessonId}/approve | k | how-we-work | lessons.approve | learned | T
POST /v1/app/projects/{p}/lessons/{lessonId}/reject | k | how-we-work | lessons.reject | learned | T
POST /v1/app/projects/{p}/lessons/{lessonId}/merge | k | later | | lessons | L
POST /v1/app/projects/{p}/lessons/{lessonId}/retire | k | how-we-work | lessons.retire | learned | T
POST /v1/app/projects/{p}/lessons/{lessonId}/retire-request | k | how-we-work | lessons.retireRequest | learned | T
GET /v1/app/projects/{p}/lessons/retire-requests | k | how-we-work | lessons.retireRequests | learned | T
GET /v1/app/projects/{p}/lessons/areas | k | how-we-work | lessons.areas | learned | T
GET /v1/app/projects/{p}/lessons/learning-sources | k | how-we-work | lessons.learningSources.get | learned | T
PUT /v1/app/projects/{p}/lessons/learning-sources/{source} | k | how-we-work | lessons.learningSources.put | learned | T
POST /v1/app/projects/{p}/lessons/decisions | k | home | lessons.decisions | learned | T
GET /v1/app/projects/{p}/lessons/mode | k | how-we-work | lessons.mode.get | learned | T
GET /v1/app/projects/{p}/lessons/measure | k | how-we-work | lessons.measure | learned | T
GET /v1/app/projects/{p}/lessons/local-tools | k | how-we-work | lessons.localTools.get | learned | T
PUT /v1/app/projects/{p}/lessons/local-tools | k | how-we-work | lessons.localTools.put | learned | T
GET /v1/app/company/lessons/local-tools | k | admin | company.knowledgeStays.get | learned | T
PUT /v1/app/company/lessons/local-tools | k | admin | company.knowledgeStays.put | learned | T
PUT /v1/app/projects/{p}/lessons/mode | k | how-we-work | lessons.mode.put | learned | T
GET /v1/app/projects/{p}/lessons/graduation | k | how-we-work | lessons.graduation | learned | T
POST /v1/app/projects/{p}/lessons/{lessonId}/graduate | k | how-we-work | lessons.graduate | learned | T
POST /v1/app/projects/{p}/lessons/{lessonId}/graduate-later | k | how-we-work | lessons.graduateLater | learned | T
POST /v1/app/projects/{p}/lessons/{lessonId}/both-places | k | how-we-work | lessons.bothPlaces | learned | T
POST /v1/app/projects/{p}/lessons/tidy/retire | k | how-we-work | lessons.tidy.retire | learned | T
POST /v1/app/projects/{p}/lessons/tidy/later | k | how-we-work | lessons.tidy.later | learned | T
POST /v1/app/projects/{p}/lessons/check-drafts/{draftId}/started | k | how-we-work | lessons.checkDraft.started | learned | T
POST /v1/app/projects/{p}/lessons/check-drafts/{draftId}/dismiss | k | how-we-work | lessons.checkDraft.dismiss | learned | T
POST /v1/app/projects/{p}/lessons/rules/{ruleId}/retire | k | how-we-work | lessons.rules.retire | learned | T
GET /v1/app/projects/{p}/tasks/{t}/lessons | k | session | lessons.task | learned | T
POST /v1/app/projects/{p}/tasks/{t}/lessons/{lessonId}/not-helpful | k | session | lessons.notHelpful | learned | T
GET /v1/app/lessons/inbox | k | home | lessons.list | learned | T
POST /v1/app/projects/{p}/lessons/rollback | k | later | | lessons |
POST /v1/app/projects/{p}/lessons/sources/resume | k | later | | lessons |
POST /v1/app/projects/{p}/lessons/preset | k | later | | lessons |
POST /v1/app/projects/{p}/lessons/preset/approve | k | later | | lessons |
POST /v1/app/projects/{p}/lessons/preset/cancel | k | later | | lessons |
POST /v1/app/projects/{p}/lessons/local-tools | k | later | | lessons-local-tools | L
GET /v1/app/projects/{p}/learning | k | later | | learning |
POST /v1/app/projects/{p}/learning/suggestions/{suggestionId}/accept | k | later | | learning |
POST /v1/app/projects/{p}/learning/suggestions/{suggestionId}/dismiss | k | later | | learning |
POST /v1/app/projects/{p}/learning/dismissed/{suggestionId}/reopen | k | later | | learning |
PUT /v1/app/projects/{p}/learning/settings | k | later | | learning |
POST /v1/app/projects/{p}/learning/settings/proposals/{proposalId}/decide | k | later | | learning |
POST /v1/app/projects/{p}/learning/rules/{ruleId}/remove | k | later | | learning |
GET /v1/app/projects/{p}/record/search | k | later | | record-search |
GET /v1/app/projects/{p}/record/past-work | k | later | | record-search |
GET /v1/app/projects/{p}/record/sources | k | later | | record-sources |
POST /v1/app/projects/{p}/record/sources | k | later | | record-sources |
GET /v1/app/projects/{p}/record/learning-mode | k | later | | learning-mode |
POST /v1/app/projects/{p}/record/learning-mode | k | later | | learning-mode |
GET /v1/app/projects/{p}/intake | k | later | | intake | L
GET /v1/app/projects/{p}/intake/updates | k | later | | intake | L
PUT /v1/app/projects/{p}/intake/updates | k | later | | intake | L
PUT /v1/app/projects/{p}/intake/sources | k | later | | intake | L
POST /v1/app/projects/{p}/intake/{itemId}/start | k | later | | intake | L
POST /v1/app/projects/{p}/intake/{itemId}/dismiss | k | later | | intake | L
GET /v1/app/projects/{p}/context-sources | k | later | | context-sources |
POST /v1/app/projects/{p}/context-sources/discover | k | later | | context-sources |
POST /v1/app/projects/{p}/context-sources/changes | k | later | | context-sources |
POST /v1/app/projects/{p}/context-sources/changes/{changeId}/confirm | k | later | | context-sources |
POST /v1/app/projects/{p}/context-sources/changes/{changeId}/reject | k | later | | context-sources |
GET /v1/app/projects/{p}/automations | k | later | | automations |
GET /v1/app/github/installations | k | admin | client.repositories.list | onboarding | T
GET /v1/app/github/repositories | k | admin | client.repositories.list | onboarding | T
GET /v1/app/github/repository-choices | k | admin | client.repositories.available | onboarding | T
POST /v1/app/github/connect | k | admin | company.github.connect | onboarding | T
POST /v1/app/github/connect/result | c | admin | | onboarding | T
POST /v1/app/github/choose | k | admin | company.github.choose | onboarding | T
GET /v1/app/github/connections | k | admin | company.github.status | onboarding | T
DELETE /v1/app/github/connections/{installationId} | k | admin | company.github.disconnect | admin/connections | T
POST /v1/app/slack/install | k | admin | company.slack.install | onboarding | T
POST /v1/app/slack/install/result | c | admin | | onboarding | T
GET /v1/app/slack | k | admin | company.slack.get | onboarding | T
POST /v1/app/slack/disconnect | k | admin | company.slack.disconnect | admin/connections | T
GET /v1/app/slack/channels | k | admin | company.slack.channels | project-setup | T
GET /v1/app/projects/{p}/slack/channel | k | admin | company.slack.channel.get | project-setup | T
PUT /v1/app/projects/{p}/slack/channel | k | admin | company.slack.channel.link | project-setup | T
POST /v1/app/projects/{p}/slack/channel/check | k | admin | company.slack.channel.check | project-setup | T
DELETE /v1/app/projects/{p}/slack/channel | k | admin | company.slack.channel.unlink | project-setup | T
POST /v1/app/linear/connect | k | admin | company.linear.connect | project-setup | T
POST /v1/app/linear/connect/result | c | admin | | project-setup | T
GET /v1/app/linear | k | admin | company.linear.get | project-setup | T
DELETE /v1/app/linear | k | admin | company.linear.disconnect | admin/connections | T
GET /v1/app/projects/{p}/linear | k | admin | company.linear.team.get | project-setup | T
PUT /v1/app/projects/{p}/linear | k | admin | company.linear.team.put | project-setup | T
DELETE /v1/app/projects/{p}/linear | k | admin | company.linear.team.clear | project-setup | T
GET /v1/app/github/requests | k | admin | | readiness |
GET /v1/app/org/members | k | admin | company.members.list | project-people |
PUT /v1/app/org/members/{developerId}/role | k | admin | company.members.setRole | admin/RoleChangeDialog |
GET /v1/app/org/members/{developerId}/removal-preview | k | admin | company.members.removalPreview | admin/RemoveMemberDialog |
POST /v1/app/org/members/{developerId}/removal | k | admin | company.members.remove | admin/RemoveMemberDialog |
GET /v1/app/org/invites | c | admin | | admin/InvitesScreen |
POST /v1/app/org/invites | c | admin | company.preapprovals.create | onboarding |
POST /v1/app/org/invites/reviewed | c | admin | company.preapprovals.create | invite-admin |
GET /v1/app/org/invites/requests/{requestId} | c | admin | | invite-admin |
DELETE /v1/app/org/invites/{inviteId} | c | admin | company.preapprovals.withdraw | invite-admin |
PATCH /v1/app/org | c | admin | | onboarding |
GET /v1/app/companies | c | shell | | companies |
POST /v1/app/companies | c | shell | company.create | onboarding/CreateCompany |
GET /v1/app/org/audit/status | c | admin | | admin/audit/AuditScreen |
GET /v1/app/org/audit/records | k | admin | company.audit.records | admin/audit/AuditScreen |
GET /v1/app/company/audit | c | admin | company.audit.records | admin/audit/CompanyAudit | T
GET /v1/app/audit/view | c | later | | admin/audit/metadata |
GET /v1/app/budget | g | budgets | | spending |
GET /v1/app/org/spend | g | budgets | | spending |
GET /v1/app/org/report | c | admin | | admin/report | T
GET /v1/app/org/report/features/{featureId} | c | admin | | admin/report | T
GET /v1/app/tasks/{t}/feature-choices | k | later | | design/PlanFeature | T
POST /v1/app/org/report/features | c | admin | | admin/report | T
POST /v1/app/org/report/features/{featureId}/rename | c | admin | | admin/report | T
POST /v1/app/org/report/features/{featureId}/merge | c | admin | | admin/report | T
POST /v1/app/org/report/features/{featureId}/state | c | admin | | admin/report | T
POST /v1/app/tasks/{taskId}/feature | c | admin | | admin/report | T
GET /v1/app/spend-requests | g | budgets | | spending |
GET /v1/app/org/budget-settings | g | budgets | | spending |
GET /v1/app/org/egress-addresses | k | admin | company.egressAddresses.get | admin/settings/OutboundAddresses | T
GET /v1/app/org/engine-model | k | later | company.engineModel.get | setup/AiSpendStep | T
PUT /v1/app/org/engine-model | k | later | company.engineModel.put | setup/AiSpendStep | T
GET /v1/app/org/learning-model | k | later | company.learningModel.get | admin/ai-spending/LearningModelCard | T
PUT /v1/app/org/learning-model | k | later | company.learningModel.put | admin/ai-spending/LearningModelCard | T
GET /v1/app/projects/{p}/spend-limits | k | later | projects.settings.get | setup/ProjectSpendLimits | T
PUT /v1/app/projects/{p}/spend-limits | k | later | projects.settings.put | setup/ProjectSpendLimits | T
GET /v1/app/trial | c | budgets | | trial-billing |
GET /v1/app/org/billing | c | budgets | | trial-billing |
POST /v1/app/org/billing | c | budgets | | trial-billing |
GET /v1/app/org/billing/invoices | c | budgets | | trial-billing |
GET /v1/app/org/model-sources | g | admin | | admin/models |
POST /v1/app/org/model-sources | g | admin | | admin/models/ProviderSetup |
DELETE /v1/app/org/model-sources/{sourceId} | g | admin | | admin/models/ProviderSetup |
POST /v1/app/org/model-sources/{sourceId}/check | g | admin | | admin/models/ProviderSetup |
PUT /v1/app/org/model-sources-order | g | admin | | admin/models/SourceOrderEditor |
GET /v1/app/models | g | later | | builder |
GET /v1/app/org/model-selection-policy | g | later | | company-model-policy |
PUT /v1/app/org/model-selection-policy | g | later | | company-model-policy |
POST /v1/app/org/model-selection-policy/preview | g | later | | company-model-policy |
GET /v1/app/me/notifications | c | settings | | notifications |
PUT /v1/app/me/notifications | c | settings | | notifications | L
GET /v1/app/script-tokens | k | settings | scriptTokens.list | script-tokens | T
POST /v1/app/script-tokens | k | settings | scriptTokens.create | script-tokens | T
POST /v1/app/script-tokens/{tokenId}/revoke | k | settings | scriptTokens.revoke | script-tokens | T
POST /v1/app/me/identities/slack | k | settings | | shell/SlackLink |
DELETE /v1/app/me/identities/slack | k | settings | channelLinks.remove | shell/SlackLink |
POST /v1/app/me/identities/github | k | settings | | shell/GithubLink |
GET /v1/app/org/company-rules | c | settings | | company-rules |
POST /v1/app/org/company-rules | c | settings | | company-rules |
GET /v1/app/org/company-rules/current | c | settings | | company-rules |
GET /v1/app/org/company-rules/history | c | settings | | company-rules |
GET /v1/app/org/company-rules/versions/{version} | c | settings | | company-rules |
GET /v1/app/org/company-rules/sync | c | settings | | company-rules |
GET /v1/app/org/approval-window | c | settings | | approval-window |
POST /v1/app/org/approval-window | c | settings | | approval-window |
GET /v1/app/org/second-review | c | later | | second-review |
POST /v1/app/org/second-review | c | later | | second-review |
GET /v1/app/org/design-review | c | later | | design-review-company |
POST /v1/app/org/design-review | c | later | | design-review-company |
GET /v1/app/org/review-default-notice | c | later | | review-default-notice |
POST /v1/app/org/review-default-notice | c | later | | review-default-notice |
GET /v1/app/org/known-failing-policy | c | later | | known-failing |
POST /v1/app/org/known-failing-policy | c | later | | known-failing |
GET /v1/app/org/task-stop-policy | c | later | | task-stop-editing |
PUT /v1/app/org/task-stop-policy | c | later | | task-stop-editing |
GET /v1/app/org/task-stop-policy/projects/{p} | c | later | | task-stop-editing |
GET /v1/app/org/learning-settings | c | later | | learning |
PUT /v1/app/org/learning-settings | c | later | | learning |
GET /v1/app/org/lessons/preset | c | later | | lessons |
POST /v1/app/org/lessons/preset | c | later | | lessons |
POST /v1/app/org/lessons/preset/approve | c | later | | lessons |
POST /v1/app/org/lessons/preset/cancel | c | later | | lessons |
GET /v1/app/org/lessons/local-tools | c | later | | lessons-local-tools | L
POST /v1/app/org/lessons/local-tools | c | later | | lessons-local-tools | L
GET /v1/app/org/domains | c | later | | company-domains |
POST /v1/app/org/domains | c | later | | company-domains |
POST /v1/app/org/domains/check | c | later | | company-domains |
POST /v1/app/org/domains/remove | c | later | | company-domains |
GET /v1/app/org/private-addresses | c | later | | private-addresses |
POST /v1/app/org/private-addresses | c | later | | private-addresses |
GET /v1/app/org/test-images | c | later | | company-test-images |
POST /v1/app/org/test-images | c | later | | company-test-images |
GET /v1/app/org/setup-recipes | c | later | | setup-recipes |
POST /v1/app/org/setup-recipes | c | later | | setup-recipes |
GET /v1/app/org/setup-agent/locks | c | later | | setup-limits |
PUT /v1/app/org/setup-agent/locks | c | later | | setup-limits |
POST /v1/app/org/setup-agent/locks/approve | c | later | | setup-limits |
POST /v1/app/org/setup-agent/locks/repair | c | later | | setup-limits |
GET /v1/app/org/agent-guardrails | c | later | | builder |
PUT /v1/app/org/agent-guardrails | c | later | | admin/agents/PrLearningLockRow |
GET /v1/app/org/insights-access | c | later | | insights |
POST /v1/app/org/insights-access | c | later | | insights |
GET /v1/app/insights | c | later | | insights |
GET /v1/app/insights/stuck | c | later | | insights |
GET /v1/app/insights/shipped | c | later | | insights |
GET /v1/app/insights/spend | c | later | | insights |
GET /v1/app/insights/flow | c | later | | insights |
GET /v1/app/org/service-status | c | later | | service-status |
GET /v1/app/org/health-observations | c | later | | readiness |
GET /v1/app/org/approvals/pending-summary | c | later | | readiness |
GET /v1/app/org/slack-workspace-evidence | k | later | | admin/connections/SlackWorkspaceEvidence |
POST /v1/app/org/jira-org-admin | c | later | | admin/connections/JiraOrgAdminKey |
GET /v1/app/org/tracker-people | c | later | | admin/tracker-people |
POST /v1/app/org/tracker-people | c | later | | admin/tracker-people |
GET /v1/app/org/mcp-servers | k | later | | context-sources |
POST /v1/app/org/mcp-servers | k | later | | context-sources |
POST /v1/app/org/mcp-servers/{serverId}/approve | k | later | | context-sources |
POST /v1/app/org/mcp-servers/{serverId}/review | k | later | | context-sources |
POST /v1/app/org/mcp-servers/{serverId}/reapprove | k | later | | context-sources |
POST /v1/app/org/mcp-servers/{serverId}/disable | k | later | | context-sources |
DELETE /v1/app/org/mcp-servers/{serverId} | k | later | | context-sources |
GET /v1/app/connections | k | later | | readiness |
POST /v1/app/connections | k | later | | admin/connections/RegistryItems |
DELETE /v1/app/connections/{connectionId} | k | later | | admin/connections/RegistryItems |
POST /v1/app/connections/{connectionId}/check | k | later | | admin/connections/RegistryItems |
GET /v1/app/connection-usage | k | later | | admin/connections/ConnectionsScreen |
GET /v1/app/agents | k | later | | agents |
POST /v1/app/agents | k | later | | builder |
GET /v1/app/agents/{id} | k | later | | agents |
GET /v1/app/agents/{id}/versions | k | later | | agents |
GET /v1/app/agents/{id}/spend | g | later | | agents |
GET /v1/app/agents/{id}/shares | k | later | | agents |
PUT /v1/app/agents/{id}/shares | k | later | | agents |
PUT /v1/app/agents/{id}/owner | k | later | | agents |
PUT /v1/app/agents/{id}/accountable | k | later | | agents |
POST /v1/app/agents/{id}/archive | k | later | | agents |
POST /v1/app/agents/{id}/adopt | k | later | | agents |
GET /v1/app/agents/{id}/draft | k | later | | agents |
PUT /v1/app/agents/{id}/draft | k | later | | builder |
POST /v1/app/agents/{id}/update-base | k | later | | agents |
GET /v1/app/agents/{id}/diff | k | later | | agents |
POST /v1/app/agents/{id}/publish | k | later | | builder |
POST /v1/app/agents/{id}/rollback | k | later | | builder |
PUT /v1/app/agents/{id}/budget | g | later | | builder |
POST /v1/app/agents/{id}/runs | k | later | | runs |
GET /v1/app/agents/{id}/publish-requests | k | later | | agent-publish |
POST /v1/app/agents/{id}/publish-requests | k | later | | agent-publish |
GET /v1/app/agent-publish-requests | k | later | | agent-publish |
POST /v1/app/agent-publish-requests/{requestId}/withdraw | k | later | | agent-publish |
GET /v1/app/me/agents | k | later | | agent-publish |
PUT /v1/app/me/agents/favourites | k | later | | agent-publish |
GET /v1/app/skills | k | later | | builder |
GET /v1/app/chains/{id} | k | later | | automations |
POST /v1/app/chains | k | later | | automations |
GET /v1/app/chains/{id}/versions | k | later | | automations |
GET /v1/app/chains/{id}/draft | k | later | | automations |
PUT /v1/app/chains/{id}/draft | k | later | | automations |
POST /v1/app/chains/{id}/publish | k | later | | automations |
POST /v1/app/chains/{id}/rollback | k | later | | automations |
POST /v1/app/chains/{id}/archive | k | later | | automations |
POST /v1/app/chains/{id}/unarchive | k | later | | automations |
PUT /v1/app/chains/{id}/budget | g | later | | automations |
PUT /v1/app/chains/{id}/accountable | k | later | | automations |
GET /v1/app/chains/{id}/shares | k | later | | automations |
GET /v1/app/chains/{id}/triggers | k | later | | automations |
PUT /v1/app/chains/{id}/triggers/{triggerId} | k | later | | automations |
DELETE /v1/app/chains/{id}/triggers/{triggerId} | k | later | | automations |
GET /v1/app/chains/{id}/triggers/{triggerId}/activity | k | later | | automations |
GET /v1/app/chain-runs | k | later | | automations |
POST /v1/app/diagnoses | k | later | | diagnoses |
GET /v1/app/diagnoses/{id} | k | later | | diagnoses | L
`;

const OWNERS: Record<string, Owner> = { k: "code", c: "cloud", g: "gateway" };
const SCREENS: readonly string[] = ["shell", "home", "request", "session", "plan", "proof", "how-we-work", "admin", "budgets", "settings", "later"];
const METHODS: readonly string[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const CODE_IDS: ReadonlySet<string> = new Set(CODE_ROUTES.map((route) => route.id));

function parseAppRoutes(text: string): AppRouteSpec[] {
  const rows: AppRouteSpec[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const [head = "", owner = "", screen = "", ids = "", source = "", flags = ""] = line.split("|").map((part) => part.trim());
    const [method = "", path = ""] = head.split(" ");
    const known = METHODS.includes(method) && path.startsWith("/v1/app/") && owner in OWNERS && SCREENS.includes(screen) && source !== "";
    const codeRoutes = ids === "" ? [] : ids.split(",").map((id) => id.trim());
    if (!known || codeRoutes.some((id) => !CODE_IDS.has(id))) throw new Error(`code-contract-v0: bad app route row: ${line}`);
    rows.push({
      method: method as HttpMethod, path, owner: OWNERS[owner] as Owner, screen: screen as Screen, codeRoutes: codeRoutes as CodeRouteId[], source,
      cloudServerToday: flags.includes("T"), codeCoreLocal: flags.includes("L"),
    });
  }
  return rows;
}

export const APP_ROUTES: readonly AppRouteSpec[] = parseAppRoutes(APP_ROUTE_ROWS);

// ---------------------------------------------------------------------------------------------------------------
// Helpers shared by the fake Code, Cloud's server and the tests

/** A path template as a regular expression; each `{name}` captures one segment. */
export function pathPattern(template: string): RegExp {
  const source = template.split("/").map((part) => (/^\{[A-Za-z0-9]+\}$/u.test(part) ? "([^/]+)" : part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))).join("/");
  return new RegExp(`^${source}$`, "u");
}

/** The names in a path template, in order. */
export function pathParamNames(template: string): string[] {
  return template.split("/").filter((part) => /^\{[A-Za-z0-9]+\}$/u.test(part)).map((part) => part.slice(1, -1));
}

export interface MatchedCodeRoute { route: CodeRouteSpec; params: Record<string, string> }

/** The Code route a request is for (a path with more specific literal segments wins), with its decoded path parameters. */
export function matchCodeRoute(method: string, pathname: string): MatchedCodeRoute | undefined {
  let best: { route: CodeRouteSpec; params: Record<string, string>; literals: number } | undefined;
  for (const route of CODE_ROUTES) {
    if (route.method !== method) continue;
    const match = pathPattern(route.path).exec(pathname);
    if (match === null) continue;
    const names = pathParamNames(route.path);
    const params: Record<string, string> = {};
    names.forEach((name, index) => { params[name] = decodeURIComponent(match[index + 1] ?? ""); });
    const literals = route.path.split("/").length - names.length;
    if (best === undefined || literals > best.literals) best = { route, params, literals };
  }
  return best === undefined ? undefined : { route: best.route, params: best.params };
}

export interface ContractCounts {
  codeRoutes: number;
  /** Code routes at least one must-pass screen needs. */
  codeNeeded: number;
  neededServed: number;
  /** Needed routes not served that arrive with E2 (the core on AWS): their code exists in the laptop core only. */
  neededArrivesWithE2: number;
  neededMissing: number;
  /** Needed routes served on mainline but not on code/next (they arrive with the second sync). */
  neededMainlineOnly: number;
  appRoutes: number;
  appMustPass: number;
  appCloudServerToday: number;
  appCodeCoreLocal: number;
}

export function contractCounts(): ContractCounts {
  const needed = CODE_ROUTES.filter((route) => route.screens.some((screen) => screen !== "later"));
  const appMust = APP_ROUTES.filter((route) => route.screen !== "later");
  return {
    codeRoutes: CODE_ROUTES.length,
    codeNeeded: needed.length,
    neededServed: needed.filter((route) => route.awsApi === "yes").length,
    neededArrivesWithE2: needed.filter((route) => route.arrivesWith !== undefined).length,
    neededMissing: needed.filter((route) => route.awsApi === "no").length,
    neededMainlineOnly: needed.filter((route) => route.awsApi === "no" && route.mainline).length,
    appRoutes: APP_ROUTES.length,
    appMustPass: appMust.length,
    appCloudServerToday: APP_ROUTES.filter((route) => route.cloudServerToday).length,
    appCodeCoreLocal: APP_ROUTES.filter((route) => route.codeCoreLocal).length,
  };
}
