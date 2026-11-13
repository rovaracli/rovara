import type { DesignActionsView, OrgId, DeveloperTaskPolicy, E2EApplicationPlanIntent, E2EApplicationSelectionRecord, E2EScenarioResults, TaskPersonInviteClaimRequest, TaskPersonInviteOutcome, ProjectRole } from "@rovara-code/contracts";
import type { GateReader } from "../../org/feature-rollout.js";
import type { DeveloperTaskView } from "@agentx/cloud-contracts";
import type { NightlyHeadReader } from "../../test-env/nightly-usable.js";
import type { EvidencePort } from "./evidence-port.js";
import type { BoundChannel } from "../../developer/share.js";
import type { ModelAccess } from "../../model-proxy/access.js";
import type { AdmitTaker } from "../../developer/take-over-eligible.js";
import type { DeveloperTaskRecord } from "../../developer/task-records.js";
import type { SpecPullRequestFacts } from "../../spec/refresh.js";
import type { SpecPublishOutcome } from "../../spec/hooks.js";
import type { SpecState } from "../../spec/state.js";
import type { DeveloperTaskActions, TransactItems } from "../developer-task-actions.js";
import type { TaskPersonCheck } from "../../developer/task-people.js";
import type { SlackRequestQueue } from "../../developer/page-comments.js";
import type { TaskPeopleDisplayAdmission } from "../../developer/task-people-display-budget.js";
import type { AgentRunDependencies } from "../../agents/runs.js";
import type { SessionAccessDependencies } from "../../agent-sessions/access.js";
import type { AgentRunEngineDependencies } from "../../agents/run-engine.js";
import type { MergeTrackingItem } from "@agentx/cloud-contracts";
import type { MergeView } from "@rovara-code/contracts";
import type { CodeHostRouter } from "../../plugins/registry.js";
import { type AuditRuntime } from "../../audit/outbox.js";
import type { DesignReviewRoundPorts } from "../../design-review/round-ports.js";
import type { StartOutsideRecheck, WorkingBranchPort } from "./continue-loop.js";

export interface DeveloperTaskRouteDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  /** The caller's org: every project, grant, limit and catalog key a route reads or writes is scoped to it. */
  orgId: OrgId;
  slackTeamId?: string;
  /** The model proxy (ruling R28): a task start is checked against the monthly budgets through it. Absent on an install with no proxy, where nothing is checked. */
  modelAccess?: ModelAccess;
  /** A cloud install (its sign-in is configured): its orgs are subject to the trial lock and the machine-time allowance (ruling R42). */
  cloud?: boolean;
  /** S2: the budget check of a real Take over, for telling the others when a step is stopped (`ownerStopTarget`). Set where these dependencies hold no `modelAccess` (the queued dispatch); else made from `modelAccess`. */
  admitTaker?: AdmitTaker;
  /** C: absent is write-disabled; an existing PEOPLE sidecar remains authoritative either way. */
  taskPeopleConfiguration?: { peopleChangesEnabled: boolean };
  /** Spec 059: absent is the safe default; production factories intentionally leave graph starts disabled. */
  workflowDependenciesEnabled?: boolean;
  /** C: trusted exact-principal eligibility and bound-channel proof; never supplied by a request body. */
  checkTaskPerson?: (task: DeveloperTaskRecord, developerId: string, admission?: TaskPeopleDisplayAdmission) => Promise<TaskPersonCheck>;
  listTaskPeople?: (task: DeveloperTaskRecord, admission: TaskPeopleDisplayAdmission) => Promise<readonly TaskPersonCheck[]>;
  createTaskPeopleDisplayAdmission?: () => TaskPeopleDisplayAdmission;
  actions: DeveloperTaskActions;
  /** Recollects every linked PR from GitHub; required before feedback decisions. */
  refreshTaskFeedback?(taskId: string): Promise<void>;
  /** Present only for a Slack-signed internal task start; the existing thread becomes the task thread. */
  initialSlackThread?: { teamId: string; channelId: string; threadTs: string };
  /** S2: the project access check bound to the TASK'S OWNER (not to whoever is calling), for the checks that ask whether Rovara may start work for them. Absent in a test double: the call's own `checkAccess` stands in. */
  ownerCheckAccess?(task: DeveloperTaskRecord): DeveloperTaskRouteDependencies["checkAccess"];
  checkAccess(project: string, options?: { ignoreTasksOff?: boolean }): Promise<{ revision: number; policy: DeveloperTaskPolicy; access: "granted" | "channel"; channelIds: string[]; role: ProjectRole }>;
  /** C3: bound channels' names and privacy, best effort (R10). */
  boundChannels?(channelIds: readonly string[]): Promise<BoundChannel[]>;
  /**
   * Q10: whether this Slack user is a member of this channel, through the access check's own Slack
   * lookup; SLACK_UNAVAILABLE when the lookup fails. Without it no private-channel share is allowed.
   */
  channelMember?(slackUserId: string, channelId: string): Promise<boolean>;
  /** C5: the project's bound channel IDs, sorted, for sharing a task that already exists (R11: no access check). */
  projectChannelIds(project: string): Promise<string[]>;
  /** The developer sign-in issuer; the task page the draft pull request links to is on its origin. */
  issuer?: string;
  /** Spec 061 slice 2: the Slack service's request queue, for "Ask AgentX to reply to this comment"; without it the page says AgentX can't answer here. */
  slackRequestQueue?: SlackRequestQueue;
  now(): number;
  log?(entry: Record<string, unknown>): void;
  resolveTaskPickerPerson?(taskId: string, slackUserId: string): Promise<{ personId: string; developerId: string; slackUserId: string; channelMember: boolean }>;
  taskPeopleChannel?(taskId: string): Promise<{ teamId: string; channelId: string; threadTs: string }>;
  inviteTaskPerson?(input: TaskPersonInviteClaimRequest): Promise<TaskPersonInviteOutcome>;
  /** Loads E2E presentation from the current server-owned CHECKS operation and its immutable evidence references. */
  workflowE2EPresentation?(input: { task: DeveloperTaskRecord; operations: readonly unknown[]; actor: "owner" | "viewer" }): Promise<DeveloperTaskView["e2ePresentation"] | undefined>;
  /** Atomic conditions for current managed-E2E authority, attached to publication admission. */
  workflowE2EPublicationChecks?(input: { task: DeveloperTaskRecord; operations: readonly unknown[] }): Promise<TransactItems | undefined>;
  /**
   * Meta repo lane D (D3): one file of the project's meta repository at a commit, through the project's own connection (the spec's files at the commit recorded when the spec was published). Undefined
   * when the file cannot be read. Without it a task whose spec is published cannot start its review: it waits (the sweep, which has it, starts it).
   */
  readMetaFile?(task: DeveloperTaskRecord, repositoryUrl: string, path: string, commit: string, maxBytes: number): Promise<string | undefined>;
  /** Meta repo lane D (C1 fix): publishes a task's spec files to its meta repository, the broker building the commit through GitHub with its own token. Absent: the spec waits for a path that has it. */
  publishSpecFiles?(task: DeveloperTaskRecord, state: SpecState, branch: string): Promise<SpecPublishOutcome>;
  /** Meta repo lane D (D4): GitHub's view of a task's spec pull request now (its head, state and reviews). Undefined when GitHub cannot say. Absent: the spec pull request is not looked at from here. */
  readSpecPullRequest?(task: DeveloperTaskRecord, repositoryUrl: string, number: number): Promise<SpecPullRequestFacts | undefined>;
  /** The head GitHub shows for one of the task's pull requests now (Plan 6 Task 15: checked before a fix's coding run is paid for). Throws when GitHub cannot say. */
  currentPullRequestHead?(task: DeveloperTaskRecord, pullRequest: { repositoryId: string; number: number }): Promise<string>;
  /** Design review (switch `dr`, DR7 slice B): what one round of the design review needs of the broker (readers, prices, budgets). Absent where the path that builds these dependencies has no such ports; the round then waits for the sweep, which does. */
  designReview?: DesignReviewRoundPorts;
  /** Design review (DR11): the Design first and Skip buttons for the caller these dependencies were built for; undefined when design review is not offered. Absent: the view carries none. */
  designActions?: (task: DeveloperTaskRecord) => Promise<DesignActionsView | undefined>;
  /** OWNER DECISION 7: the checks retry, Revise the plan and spec-hold offers for the caller these dependencies were built for (task-page.ts#taskPageActionsFor). Absent: the view carries none. */
  pageActions?: (task: DeveloperTaskRecord) => Promise<DeveloperTaskView["pageActions"]>;
  /** The commit the base branch of one of the task's pull requests is at now (Plan 6 Task 17: the commit Rovara merges into the branch). Throws when GitHub cannot say. */
  currentBaseCommit?(task: DeveloperTaskRecord, pullRequest: { repositoryId: string; number: number }): Promise<string>;
  /** Continue in your own tool: the host operations on a task repository's working branch (`agentx/<taskId>`), for the publish action. Absent: the action answers RUNTIME_UNAVAILABLE. */
  workingBranchPort?: WorkingBranchPort;
  /** Continue in your own tool: a stand-in for the start of a re-check of a head that changed outside Rovara (continue-loop.ts#StartOutsideRecheck), for tests. Production uses `outsideRecheckFeatures`. */
  startOutsideRecheck?: StartOutsideRecheck;
  /**
   * Continue in your own tool: the worker features of the task's workspace session (undefined when no session is ready to say). Present: this install starts re-checks itself (a read-only adoption
   * run, then the person's checks); a ready worker without the adoption feature is refused with a plain sentence. Absent (and no stand-in): the action answers RUNTIME_UNAVAILABLE and the view offers none.
   */
  outsideRecheckFeatures?: (task: DeveloperTaskRecord) => Promise<readonly string[] | undefined>;
  /**
   * Continue in your own tool: the company's Admission for a person's Recheck, which starts a machine and (when its checks pass) paid reviews: a locked trial or a month of machine time used up (on
   * a cloud install), and a budget without the minimum left, each refuse with their own words before anything starts. Absent: nothing more is admitted here (the checks' own acceptance still is).
   */
  admitOutsideRecheck?: (task: DeveloperTaskRecord) => Promise<void>;
  /** Continue in your own tool: the working branch, the pushes that did not come from Rovara and what the caller may press, for the caller these dependencies were built for. Absent: the view carries none. */
  continueLoop?: (task: DeveloperTaskRecord, tracked: readonly MergeTrackingItem[]) => Promise<DeveloperTaskView["continueLoop"]>;
  /** How far Rovara may go on its own with the task now: the stricter of its frozen recipe and the company's limit, read each time (`suggest` when it cannot be read). Checked before each paid step of a round Rovara decided itself (Plan 6 Task 16). */
  taskAutonomyNow?(task: DeveloperTaskRecord): Promise<"suggest" | "prepare" | "run">;
  /** M1.3 Task 3.7: the per-scenario rows of the task's current browser and API round, for the task page; the screenshot behind a row, by digest; the baseline round asked for at APPROVE. */
  workflowE2EScenarioResults?(input: { task: DeveloperTaskRecord; operations: readonly unknown[]; actor: "owner" | "viewer" }): Promise<E2EScenarioResults | undefined>;
  workflowE2EArtifact?(input: { task: DeveloperTaskRecord; sha256: string }): Promise<{ contentType: "image/jpeg"; bytes: Uint8Array } | undefined>;
  /** Proof and evidence (wire-proof): the evidence of a task's checks, for the pull request, the task page and the download. Present only while the proof switch is on; absent, nothing reads or shows any. */
  evidence?: EvidencePort;
  /** TE-A1: this request's gate reader (see DeveloperRouteDependencies.gates). */
  gates?: GateReader | undefined;
  /** Setup and test health (`vx` only): reads a project's default-branch head, so a quiet repository's older nightly baseline still counts. Absent, an older baseline is refused. */
  nightlyHead?: NightlyHeadReader;
  startWorkflowE2EBaseline?(input: { task: DeveloperTaskRecord }): Promise<unknown>;
  /**
   * Evaluates a plan's schema-v2 application intent for approval against the task's pinned project, the approved setup snapshot and the runtime rows
   * READY now: the selection to record and the conditions that keep those rows as read until the approval commits. It throws when the plan cannot be
   * approved (CONFIG_INVALID) or cannot be evaluated (RUNTIME_UNAVAILABLE); without it a v2 plan is never approved.
   */
  validateWorkflowE2EApplicationPlan?(input: { task: DeveloperTaskRecord; intent: E2EApplicationPlanIntent; artifact: { id: string; sha256: string };
    /** The owner's retry approving the same, already approved plan again: the latest registered test accounts are pinned, not compared with the plan's refs. */
    reapproval?: boolean }):
    Promise<{ selection: E2EApplicationSelectionRecord; conditions: TransactItems; baselineWanted?: boolean }>;
  /** Resolves only a URL loaded from the task's immutable registered project revision. */
  registeredRepositoryIdentity?(url: string, orgId: OrgId): Promise<{ repositoryId: number; fullName: string } | undefined>;
  /**
   * Rovara Cloud (Plan 2, Task 15): refuses, with GITHUB_NOT_CONNECTED, a project whose repositories the org's GitHub connection does not
   * reach (the installation uninstalled, suspended, disconnected, or no longer the one the repository's entry pins). Absent where
   * there are no bindings (a private install). Called at a task's start, before any budget, limit or machine time.
   */
  requireRepositoriesConnected?(orgId: OrgId, definition: { repositories: ReadonlyArray<{ url: string; installationId?: number | undefined }> }): Promise<void>;
  /** Enterprise foundations I3: the sign-in table, where a person's display name is read for the attribution a change request carries. Absent: the people it names are shown only by what the State table holds. */
  signInTableName?: string;
  /** Enterprise foundations P7: the code hosts this install registers. A task start refuses a repository whose `host.kind` is not among them, before any work is spent. Absent: no check. */
  codeHost?: Pick<CodeHostRouter, "kinds">;
  /**
   * Plan 3, Task 15: what choosing the agent a task runs needs (the roster, the guardrails, the frozen recipe). Absent where agents are not set
   * up: a start then names no agent, and the task is the plain task it always was, with no recipe stored.
   */
  agentRuns?: AgentRunDependencies;
  /**
   * Plan 6 Task 19: whether the viewer pressing Merge now would be allowed to, from the tracking items the view just read (the broker binds the viewer). Without it a task view has no `merge`.
   */
  mergeView?: (task: DeveloperTaskRecord, items: MergeTrackingItem[]) => Promise<MergeView | undefined>;
  /** Plan 5 Task 12a review (M-3): a developer id read as the member it was merged into (the end of its `mergedInto` chain). A taker merged away since is the owner as the member they became. */
  resolveMember?: (developerId: string) => Promise<string>;
  /**
   * Plan 5 Task 13: set only by `cancelTaskFor` and `retryTaskWorkflowFor` on their own copy of these dependencies, never by a request: the person whose session level the session
   * route checked just now ("can edit", live). For that person, and only for `retry` and `control` (stop), the task's own rules are not asked (they are not the task's owner);
   * a retry still needs their project role to start work. Every write is still fenced on the task's People revision.
   */
  sessionActor?: {
    developerId: string;
    /**
     * Stop & redirect's restart only: the person must be the task's effective owner or a co-owner on the People list THIS access read (the one whose revision every write is fenced on), else the
     * access is refused. One read for the check and the fence, so a removal or a take-over in between cannot slip through (fix round 1, S1).
     */
    requireOwner?: true;
  };
  /** Plan 5 Task 5: what a session's level needs. With it a person who can view a task's session reads the task page (read only), and a task from before sessions is given one when it is first read in full. */
  agentSessions?: SessionAccessDependencies;
  /** Plan 3, Task 22: the agent-step engine's dependencies (the same object as `agentRuns` where agents are set up); a cancel of a run that waits ends the run through it. */
  agentEngine?: AgentRunEngineDependencies;
  /**
   * Plan 3, Task 32: set only when a spend request's approval resumes the task as its owner. The approval already set the limits, and reset the cap window
   * where it should (`keepWindow` false); otherwise a retry keeps the window instead of starting a new one as a person's retry does (R38).
   */
  spendResume?: { keepWindow: boolean };
  /**
   * Plan 3, Task 32 (fix round 1, I-3): the open spend request of the pause a person's Continue removes, ended in the Continue's own transaction (the items),
   * with its audit flushed once that committed. Absent where agents are not set up.
   */
  withdrawSpendRequests?(task: DeveloperTaskRecord): Promise<{ items: TransactItems; flush(): Promise<void> }>;
  /**
   * Final fix wave (owner decision 2 = A): whether `caller` may go on with a task paused on a run limit, planning limit or max per run by a Continue, a workflow
   * retry or a send-back, which would start a new window and skip that approval. Allowed only to a person who may decide the request themselves. Absent where
   * agents are not set up.
   */
  pausedTaskGate?(caller: { orgId: OrgId; developerId: string }, task: DeveloperTaskRecord): Promise<{ allowed: true } | { allowed: false; who: string }>;
  /** v1.2 learning loop: the Audit Ledger, so a send-back that opens a suggested rule emits `rule.suggested` (learning/capture-decision.ts). Absent on a legacy install. Its own name: other code reads `audit` of the dependencies it is handed. */
  learningAudit?: AuditRuntime;
}
