import type { TaskFundingProof } from "../org/task-stop-funding.js";
import type { SpendingAdmissionReference } from "@agentx/contracts";
import type { CapturedTaskStop } from "../org/task-stop-admission.js";
import type { StoredSecondOpinion } from "../rovara-code/second-review-store.js";
// Spec 025 phase 25b: a developer task's records, owner key, status and failure rules, event text
// and audit records. No I/O; aws/developer-tasks.ts and the broker's result hook call these.
import type {ModelFallback} from "@agentx/contracts";
import { createHash } from "node:crypto";
import {
  BUDGET_EXHAUSTED_FAILURE_MESSAGE,
  WORKFLOW_NO_CODE_CHANGE_MESSAGE,
  DeveloperSignInMethodSchema,
  agentXError,
  inertName,
  AiToolTurnRecordSchema,
  DEVELOPER_EVENT_TEXT_MAX,
  DEVELOPER_FAILURE_MESSAGE_MAX,
  DEVELOPER_TASK_OWNER_ISSUER,
  PullRequestLifecycleResultSchema,
  PullRequestResultSchema,
  TURN_TEXT_LIMIT,
  UNKNOWN_CLIENT_NAME,
  WORKFLOW_APPLICATION_PLAN_NOT_APPROVABLE_PREFIX,
  aiToolTurnRecordKeys,
  capText,
  lastAssistantResponse,
  redactAndCap,
  redactText,
  slackThreadSubject,
  slackThreadUrl,
  type AiToolTurnRecord,
  type DeveloperRequester,
  type DeveloperTaskEvent,
  type DeveloperTaskFailure,
  type DeveloperTaskFailureCategory,
  type DeveloperTaskShare,
  type DeveloperTaskStatus,
  type Operation,
  type PauseScope,
  type RunCheckout,
  type SetupDraft,
  type SetupProposal,
  type SetupRunEndWord,
  type SetupRunSummary,
  type WorkflowSnapshot,
  type WorkflowReviewBase,
  type DeveloperSignInMethod,
  type ErrorRef,
  type OrgId,
  type Payer,
  type Place,
  type RunEstimate,
  type WorkOrigin,
} from "@agentx/contracts";
import type { AuthenticatedIdentity } from "../auth.js";
import type { TaskAgentRef } from "../agents/roster.js";
import { isHeartbeat, modelCallView } from "./model-call-view.js";
import { personNameForText } from "./requester-text.js";
import { safeDisplayName } from "./person-name.js";
import type { ShareDecision } from "./share.js";
import type { PlanGroundingHold, PlanSelfCheckState } from "./plan-self-check.js";
import type { PlanUnreadableCategory } from "./plan-check-summary.js";
import type { AutoFixAsk } from "./autofix-messages.js";

/** Whether a block reason is one of the two that send a task back to plan review for a corrected E2E plan: a source reference that does not match the candidate, or an application plan that can no longer run as written. */
export function isE2EPlanCorrectionBlockReason(blockReason: string | undefined): boolean {
  return blockReason !== undefined && (blockReason === E2E_PLAN_REFERENCE_INVALID_BLOCK_REASON || blockReason.startsWith(WORKFLOW_APPLICATION_PLAN_NOT_APPROVABLE_PREFIX));
}

export const E2E_PLAN_REFERENCE_INVALID_BLOCK_REASON = "The approved feature E2E plan references a source operation that does not match the protected candidate. Request changes and submit a corrected E2E plan before coding resumes.";

export interface CounterKey { pk: string; sk: string }
export interface WorkspaceCharge { member: CounterKey; organization: CounterKey }

/** DEVTASK#<taskId> / META: the task. */
export interface DeveloperTaskRecord {
  /** Written together with model.fallback_used, never inferred by a reader. */
  modelFallbacks?: ModelFallback[];
  /** Internal bounded occurrence receipts and optimistic version, committed with the audit outbox. */
  modelFallbackRevision?: number;
  modelFallbackReceipts?: Array<{key:string;digest:string;eventId:string;at:string}>;
  pk: string;
  sk: "META";
  entityType: "DEVELOPER_TASK";
  taskId: string;
  /** The org the task belongs to; every task this release starts carries it, and a caller of another org never sees the task. */
  orgId?: OrgId;
  /** What the task's model proxy key may spend, in US dollars (ruling R29); a task without one gets PER_TASK_BUDGET_USD. */
  budgetUsd?: number;
  /** Immutable numeric capture for this accepted admission; not an authority lease. */
  spendingStop?: CapturedTaskStop;
  fundingProof?: TaskFundingProof;
  /** Durable receipt of the approved plain-task window; never fresh money. */
  spendingAdmission?: SpendingAdmissionReference;
  /** Ruling R38: the task keys' cumulative spend when its owner last chose Continue; the task's cap counts spend above it. */
  budgetBaselineUsd?: number;
  /** The model proxy keys minted for this task, by key id (a hash, never the key); the next key's cap counts their spend (ruling R30). */
  modelKeyIds?: string[];
  developerId: string;
  provider: DeveloperSignInMethod;
  developerName: string;
  slackUserId?: string;
  client: string;
  project: string;
  title: string;
  workspaceId: string;
  ownerKey: string;
  conversationId: string;
  startingRevision: number;
  charge: WorkspaceCharge;
  /** C1: whether the task is shared to its channel, and how. */
  shared: boolean;
  share?: TaskShare;
  /** C1: every write of `share` replaces the whole map, conditioned on this number. */
  shareVersion?: number;
  /** Latest legacy Code share request; a later change invalidates every older undo. */
  codeShareRequestId?: string;
  /** Serializes append-only task Canvas lineage mutations without advancing workflow revision. */
  canvasLineageVersion?: number;
  canvasCloseoutVersion?: number;
  canvasCloseoutRetry?: { requestId: string; workflowRevision: number; manifestDigest?: string; actorId: string; requestedAt: string; dispatchAttempt: number };
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  /**
   * Plan 5 Task 12a: set when someone other than the creator took the task over (Task 12b writes it). From then on the taker is the task's owner for every read that
   * carries authority (see `effectiveTaskOwner`); the creator's own fields stay as history, and `ownerKey` (the task's principal) never changes.
   */
  currentOwner?: TaskCurrentOwner;
  /** Ruling R60: set when the task's creator was removed from the org; the task dispatches and publishes nothing more. */
  outcome?: "creator_removed";
  /** The sentence the task ended with (`<name> is no longer a member of <org>, so Rovara stopped this task.`) and when. */
  outcomeReason?: string;
  outcomeAt?: string;
  /**
   * When a finished workflow task (all its pull requests merged, or its workflow closed) gave back its workspace slot and
   * its workspace. A closed task gives them back with its close instead, and has none.
   */
  releasedAt?: string;
  /** When that release claimed the workspace (CLOSING) before deleting its compute; removed once it is released. */
  releaseClaimedAt?: string;
  workflow?: WorkflowSnapshot;
  /** Trust fix A2: the latest reviews ran on the build's own model, for the code with this digest. Kept here, never in the (strict) workflow, so an older broker still reads the workflow after a rollback; it ignores this key. */
  reviewSameModel?: { candidateDigest: string };
  /** Owner decision 2026-11-02: the latest reviews ran on the build's own company, because the default is another company's model and none was usable, for the code with this digest and on this model. Kept here for the same reason as `reviewSameModel`. */
  reviewNoOtherCompany?: { candidateDigest: string; model: { provider: string; modelId: string } };
  /**
   * Second review by another AI company (SH34, switch `cr`). Kept here and NEVER in the (strict) workflow, so the first review's record, `reviewCleared` and everything that reads the workflow are untouched by it
   * and an older broker ignores these keys. `secondOpinion` is its result for one candidate; `secondReviewAcknowledged` holds the keys the task owner acknowledged (`secondReviewAcknowledgement`).
   */
  secondOpinion?: StoredSecondOpinion;
  secondReviewAcknowledged?: string[];
  /** The commit each repository's preparation checked out, from the prepare result; the task's base until one is pinned. */
  preparedBase?: WorkflowReviewBase;
  /** Meta repo lane A: the meta repository's default-branch head the broker pinned for this task's preparation (the worker reported the same one). Every stage reads the team's knowledge at this commit. */
  knowledgeCommit?: string;
  /** Spec 061: why the planner's last answer could not be read, kept for Retry planning; `workflowRevision` is the blocked step's revision. */
  planUnreadable?: { workflowRevision: number; errors: string[]; /** The fixed category of the problem (never the validator's words), for the owner's message. */ category?: PlanUnreadableCategory; /** Whether AgentX already asked the planner once more by itself. */ autoRetried?: true };
  /** AUTOFIX: why Rovara asked the owner instead of fixing a blocked step by itself, for the blocked revision `workflowRevision` (see autofix-messages.ts). */
  autofixAsk?: AutoFixAsk;
  /** Plan self-check: which document version the automatic revision budget is for, and how much is spent (see plan-self-check.ts). */
  planSelfCheck?: PlanSelfCheckState;
  /** T7c: the coding plan the task is holding back while its must-not-change checks run on the current app; the plan is not yet submitted, so there is nothing to approve. */
  planGrounding?: PlanGroundingHold;
  /** T7c: the owner closed the task while the plan was held (the held plan's digest): the finish clears the hold and asks nobody anything. */
  planGroundingAbandoned?: string;
  /** Broker-private fence requiring a new E2E plan after the protected source disproved an approved plan reference. */
  e2ePlanCorrection?: { artifactId: string; artifactSha256: string; candidateDigest: string; reasonCode: string; requiredE2E: true };
  /** Gap 2: how many thread replies are saved for the task (NOTE# items). */
  threadNoteCount?: number;
  /** Gap 2: the newest saved reply's receivedAt already given to a planning or coding step; each reply is given once. */
  threadNotesFedThrough?: string;
  /**
   * The thread replies received after this and through `threadNotesFedThrough` were given to steps since the last plan
   * that was stored; they are what that plan's "why" quotes. Set to `threadNotesFedThrough` when a plan is stored; absent
   * until the first one is.
   */
  threadNotesFedFrom?: string;
  /** The owner's original request, redacted and cut to 4,000 characters; the first entry of each plan's "why". Tasks created earlier have none. */
  requestText?: string;
  /** Plan 3, Task 15: the agent and version the task runs (its recipe is frozen at `RECIPE`, see `taskRecipeKey`). Tasks from before agents have none. */
  agent?: TaskAgentRef;
  /** Plan 3, Task 15: where the start came from. A draft test run is `test_run`. */
  origin?: WorkOrigin;
  /**
   * Plan 3, Task 29: whose budget the task is charged to (`resolvePayer`) and the project it is counted against. Written with the start when agents are
   * set up; a task without them was paid for by its owner, in the project it names (`paymentOfTask`).
   */
  payer?: Payer;
  place?: Place;
  /** Plan 3, Task 29: the person who started the run (a test run is counted on their testing allowance). A task without it was started by its owner. */
  startedBy?: { developerId: string };
  /** Plan 3, Task 15: the chain step that started the run, for work Plan 4's chains start. */
  chain?: { chainRunId: string; stepId: string };
  /** Plan 3, Task 15: the agent's cap on one run as it was when the run started; absent when the agent set none. */
  maxPerRunUsd?: number;
  /**
   * Plan 3, Tasks 15 and 31: what the run is waiting on for money. `scope` is the limit that was reached (`PauseScope`) and `at` when it was written.
   * A run started with a run limit of 0 has `firstDispatch.operationId` too: nothing was dispatched or charged, the workspace and its prepare
   * operation exist but the prepare has no outbox item, no workspace slot is taken and no setup watch runs. A run that was refused a model key
   * mid-run (`mintOperationKey`) has no `firstDispatch`, and keeps the first pause it was given. Task 32's approval of the raise clears this field
   * (and, for `firstDispatch`, takes the slot and writes the outbox and the watch).
   */
  budgetPause?: { scope: PauseScope; at: string; firstDispatch?: { operationId: string; checkout?: RunCheckout[]; readOnly?: true } };
  /**
   * Plan 3, M-6: the plain task's operation whose budget stop the pause handlers were told about (`noteTaskPaused`). A plain task that stops on a budget is paused,
   * not ended, so its end handlers are not told; this marks the stop as told (a replay or the recovery sweep tells nobody again) and says the task's end is still
   * owed: closing it tells `closed` once.
   */
  budgetPauseToldFor?: string;
  /**
   * Plan 3, M-6 (I-1): the operation that a budget refusal stopped, written with the pause (and by the ask that works out a pause that was never written) and kept when
   * an approval removes the pause. It says that operation's end is a pause answered, not a failure, however early the approval came.
   */
  budgetStopOf?: string;
  /**
   * Plan 3, Task 22: set in the transaction that ends an agent-step run (COMPLETE, FAILED or CANCELLED), with when. An ended run is finished the way a
   * merged workflow task is: it gives back its workspace slot and its workspace (`workflowTaskFinished`, `releaseFinishedTask`).
   */
  agentRunEnd?: { state: "COMPLETE" | "FAILED" | "CANCELLED"; at: string };
  /**
   * Plan 6, Task 10: the task is Rovara drafting a project's dev setup (read-only look at the repositories; its result is a proposal in the project's `SETUP_DRAFT` item). It is
   * no workflow and no agent-step run: its result sets `agentRunEnd`, which is how it gives back its workspace, and it never feeds the run-cost estimates.
   */
  purpose?: "setup_draft" | "diagnosis" | "setup_agent" | "nightly_run";
  /** NH-1: what a `purpose: "nightly_run"` task was started to run, fixed by the broker when the fire started it (slot, environment revision, branch, the commit it resolved). The nightly result is accepted only for exactly this. */
  nightlyRun?: { slotId: string; envRevision: number; branch: string; headSha: string };
  /**
   * Live interaction F3 (Fix with agent, deep tier): a `purpose: "diagnosis"` task reads the repositories read-only to diagnose the error `errorRef` names (codes and ids only). It is no workflow and no agent-step
   * run: like a setup draft its end sets `agentRunEnd` and it never feeds the run-cost estimates, and its answer is written to `DIAGNOSIS#<diagnosisId>` in the same transaction (diagnosis/deep.ts).
   */
  diagnosis?: { diagnosisId: string; errorRef: ErrorRef };
  /** Plan 6, Task 10: what a setup-draft task ended with, written in the same transaction as `agentRunEnd`: the sanitized draft, or a fixed sentence saying why there is none. */
  /** The setup agent's result (meta repo lane B). `draft` is a version 1 draft stored by the earlier code: it reads as outdated and is never applied. */
  setupDraftResult?: { status: "ready"; proposal: SetupProposal } | { status: "ready"; draft: SetupDraft } | { status: "failed"; failure: string };
  /**
   * Setup agent (SH11): what a `purpose: "setup_agent"` task ended with, written in the same transaction as `agentRunEnd` (rovara-code/setup-agent.ts). `stop` is the word the run ended with: the broker's own
   * (a person's stop, the budget, a fault) or, for a run that finished, one of the worker's that the broker accepts. `proposal` is the broker's reading of the worker's answer, never the worker's copy.
   */
  /** Setup agent: who pressed Stop, written before the cancel (rovara-code/setup-agent.ts). A cancelled run is a person's stop only when this is here; a system cancel has none. */
  setupAgentStop?: { by: string; at: string };
  /** SH14: the limits a setup run started with (fixed at start; the worker is sent these, read again through `effectiveSetupAgentLimits`). */
  setupAgentLimits?: { commands: number; sameStepTries: number; wallClockMin: number; budgetCents: number; hostAsks: number };
  /** SH13: how far a running setup run has got, for the Live wall tile: the highest journal position stored and when. Fixed words and numbers only. */
  setupAgentProgress?: { commands: number; at: string };
  setupAgentResult?: { status: "ready"; proposal: SetupProposal; summary: SetupRunSummary; stop: SetupRunEndWord } | { status: "failed"; stop: SetupRunEndWord; failure: string; proposal?: SetupProposal; summary?: SetupRunSummary };
  /**
   * Plan 3, Task 34: what the coding plan under review is expected to cost and the run limit that follows (`estimateRun`), written when a plan reaches
   * review on an install with a model proxy. Approving the plan accepts `runLimitUsd` (`acceptRunLimit`); the plan-ready message and the task view show it.
   */
  runEstimate?: RunEstimate;
  /** Plan 3, Task 34: the run limit a start asked for (`runLimitUsd` of `startAgentRun`); approving the plan accepts no more than it. */
  requestedRunLimitUsd?: number;
  /** Plan 5, Task 2: the session this task is the subject of, created in the task's start transaction. A chain step's task has none (its chain run is the session). */
  sessionId?: string;
  /** Plan 6 Task 6: the answered task this one follows ("make the change anyway"). Understand is told the person has read the answer and wants the change. */
  retryOfTaskId?: string;
  /** Plan 3, Task 34: when the run's cost was written for the estimates (`recordRunCost`), so a run is counted once. */
  runCostRecordedAt?: string;
  /** Plan 6 Task 7: when this version 2 task's duration was written for the next time estimate (`recordTaskDuration`), so a task is counted once. */
  durationRecordedAt?: string;
}

/** C1: a shared task's thread, as the task record keeps it. */
export interface TaskShare {
  teamId: string;
  channelId: string;
  channelName?: string;
  mode: "view" | "continue";
  sharedReason: "requested" | "required";
  modeReason?: "continue_not_allowed";
  sharedAt: string;
  threadTs?: string;
  postFailedAt?: string;
}

export function taskShare(decision: ShareDecision, teamId: string, sharedAt: string): TaskShare {
  return {
    teamId, channelId: decision.channelId,
    ...(decision.channelName === undefined ? {} : { channelName: decision.channelName }),
    mode: decision.mode, sharedReason: decision.sharedReason,
    ...(decision.modeReason === undefined ? {} : { modeReason: decision.modeReason }),
    sharedAt,
  };
}

/** The wire view of a share: a thread link only once the notifier has posted (C6). */
export function shareView(share: TaskShare): DeveloperTaskShare {
  return {
    mode: share.mode, channelId: share.channelId,
    ...(share.channelName === undefined ? {} : { channelName: share.channelName }),
    sharedReason: share.sharedReason,
    ...(share.modeReason === undefined ? {} : { modeReason: share.modeReason }),
    ...(share.threadTs === undefined ? {} : { threadUrl: slackThreadUrl({ teamId: share.teamId, channelId: share.channelId, threadTs: share.threadTs }) }),
    ...(share.postFailedAt === undefined ? {} : { postFailed: true }),
  };
}

/** The shared thread's Slack subject, the key of its Slack-side records (ruling F11: contracts' builder, which validates). */
export const sharedSubject = (share: TaskShare & { threadTs: string }): string =>
  slackThreadSubject({ teamId: share.teamId, channelId: share.channelId, threadTs: share.threadTs });

/** DEVELOPER#<developerId> / TASK#<createdAt>#<taskId>: the task index of FR-017. */
export interface DeveloperTaskIndexRecord {
  pk: string;
  sk: string;
  entityType: "DEVELOPER_TASK_INDEX";
  taskId: string;
  /** The org the task was started in; the list shows only rows of the caller's current org. */
  orgId?: OrgId;
  project: string;
  title: string;
  client: string;
  status: DeveloperTaskStatus;
  shared: boolean;
  startingRevision: number;
  workspaceId: string;
  createdAt: string;
  updatedAt: string;
}

/** WORKSPACE#<workspaceId> / DEVELOPER_TASK: how a worker callback finds the task (R2, R3). */
export interface DeveloperTaskPointerRecord {
  pk: string;
  sk: "DEVELOPER_TASK";
  entityType: "DEVELOPER_TASK_POINTER";
  taskId: string;
  developerId: string;
  requester: DeveloperRequester;
  conversationId: string;
  firstRequestId: string;
  /** The first instructions, until the prepare's result queues them (R3). */
  pendingPrompt?: string;
  /** The first plan-only operation is selected by the broker, never by the request. */
  pendingWorkflowMode?: "PLAN" | "IMPLEMENT" | "SETUP_DRAFT" | "SETUP_AGENT" | "CHECKS";
  /** Set when the task was cancelled before its instructions ran (R16). */
  cancelledAt?: string;
}

/** GITHUB_PR#<owner/repo> / PR#<number>: exact reverse link from a published PR to its task. */
export interface GithubWorkflowPullRequestRecord {
  pk: string;
  sk: string;
  entityType: "GITHUB_WORKFLOW_PR";
  repositoryFullName: string;
  repositoryId: string;
  number: number;
  url: string;
  taskId: string;
  workspaceId: string;
  candidateDigest: string;
  createdAt: string;
}

export const taskKey = (taskId: string) => ({ pk: `DEVTASK#${taskId}`, sk: "META" as const });
/**
 * The frozen recipe of an agent run, `{ orgId, recipe, digest }`. Task partitions are global, so a reader re-checks `orgId` on the item
 * (a named exception to org-scoped keys, see the plan's global constraints).
 */
export const taskRecipeKey = (taskId: string) => ({ pk: `DEVTASK#${taskId}`, sk: "RECIPE" as const });
/** The state of an agent-step run (Task 22's engine); the same named exception as `taskRecipeKey`. */
export const taskAgentRunKey = (taskId: string) => ({ pk: `DEVTASK#${taskId}`, sk: "AGENT_RUN" as const });
/** The item stored with a plan: which comments the planner answered in it (the Slack card for the plan reads it). */
export const plannerRepliesKey = (taskId: string, artifactId: string) => ({ pk: `DEVTASK#${taskId}`, sk: `PLANREPLIES#${artifactId}` });
export const taskIndexKey = (developerId: string, createdAt: string, taskId: string) => ({ pk: `DEVELOPER#${developerId}`, sk: `TASK#${createdAt}#${taskId}` });
export const taskPointerKey = (workspaceId: string) => ({ pk: `WORKSPACE#${workspaceId}`, sk: "DEVELOPER_TASK" as const });
export function githubWorkflowPullRequestKey(repositoryFullName: string, number: number) {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repositoryFullName);
  if (!match || !Number.isSafeInteger(number) || number < 1) throw new Error("GitHub pull request identity is invalid");
  return { pk: `GITHUB_PR#${repositoryFullName.toLowerCase()}`, sk: `PR#${String(number).padStart(10, "0")}` };
}
export const startIdempotencyKey = (developerId: string, requestId: string) => ({ pk: `IDEMPOTENCY#${developerId}#DEVTASK`, sk: `REQUEST#${requestId}` });

/** The idempotency item of one request of a task's action (a cancel, a continue): the same key every action of the task uses, so one request id names one action. */
export const taskActionRequestKey = (task: { ownerKey: string; workspaceId: string }, requestId: string) => ({ pk: `IDEMPOTENCY#${task.ownerKey}#${task.workspaceId}`, sk: `REQUEST#${requestId}` });

export const taskOwnerSubject = (developerId: string, taskId: string): string => `${developerId}/${taskId}`;

/** FR-017: the same function as ownerKeyForSubject, so every workspace handler accepts it. */
export function taskOwnerKey(developerId: string, taskId: string): string {
  return createHash("sha256").update(DEVELOPER_TASK_OWNER_ISSUER).update("\0").update(taskOwnerSubject(developerId, taskId)).digest("hex");
}

// ---- the effective owner (Plan 5 Task 12a)

/** Who owns a task now: the creator's own fields, or the taker's once the task was taken over. */
export interface TaskOwner { developerId: string; name: string; slackUserId?: string; provider: DeveloperSignInMethod }
/** The taker, as `currentOwner` stores them, and when they took the task over. */
export interface TaskCurrentOwner extends TaskOwner { since: string }
/** What the owner functions read of a task: its creator's fields and its `currentOwner`. A `DeveloperTaskRecord` fits, and so does a stored row read as one. */
export type TaskOwnerSource = Pick<DeveloperTaskRecord, "taskId" | "developerId" | "developerName" | "provider" | "slackUserId" | "currentOwner">;

const present = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/** What shows for a taker whose name was not recorded. Authority never reads the name: it is by id, so a missing name only changes what is displayed. */
export const UNNAMED_MEMBER = "a member";

/** The task's owner could not be worked out, so nobody is it: every read that carries authority refuses rather than fall back to the creator. */
export const TASK_OWNER_UNREADABLE_MESSAGE = "Rovara can't tell who owns this task right now, so it did nothing.";

function unreadableOwner(): Error {
  return agentXError("TASK_ACCESS_DENIED", TASK_OWNER_UNREADABLE_MESSAGE);
}

/** The stored taker, or undefined for anything that is not exactly one (a missing or empty id, an unknown sign-in method, no usable time, a Slack id that is not a string). */
function readCurrentOwner(value: unknown): TaskCurrentOwner | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const taker = value as Record<string, unknown>;
  const provider = DeveloperSignInMethodSchema.safeParse(taker["provider"]);
  if (!present(taker["developerId"]) || !provider.success || !present(taker["since"]) || !Number.isFinite(Date.parse(taker["since"]))) return undefined;
  if (taker["slackUserId"] !== undefined && !present(taker["slackUserId"])) return undefined;
  return {
    developerId: taker["developerId"], name: present(taker["name"]) ? taker["name"] : UNNAMED_MEMBER, provider: provider.data, since: taker["since"],
    ...(taker["slackUserId"] === undefined ? {} : { slackUserId: taker["slackUserId"] }),
  };
}

/**
 * The only place that says who owns a task now: its `currentOwner` once someone took it over, else its creator. Read the task live (a consistent read) and call this
 * on that record; never remember the answer across calls. Fails closed: a `currentOwner` that is present but not a whole taker, or a task with no creator, throws
 * `TASK_ACCESS_DENIED` (never the creator, who handed the task over).
 */
export function effectiveTaskOwner(task: TaskOwnerSource): TaskOwner {
  if (Object.hasOwn(task, "currentOwner") && task.currentOwner !== undefined) {
    const taker = readCurrentOwner(task.currentOwner);
    if (taker === undefined) throw unreadableOwner();
    const { since: _since, ...owner } = taker; // eslint-disable-line @typescript-eslint/no-unused-vars
    // Release 0.4.16: a taker stored under their email is named without it.
    return { ...owner, name: safeDisplayName(owner.name, owner.developerId) };
  }
  if (!present(task.developerId) || typeof task.developerName !== "string") throw unreadableOwner();
  // Release 0.4.16: a task started while the creator's name was their email names them without it.
  return { developerId: task.developerId, name: safeDisplayName(task.developerName, task.developerId), provider: task.provider, ...(task.slackUserId === undefined ? {} : { slackUserId: task.slackUserId }) };
}

/**
 * Whether someone other than the creator took the task over: its `currentOwner` is there, whether or not it can be read (a taken-over task whose taker can't be
 * read is never read as the creator's, and `effectiveTaskOwner` is what refuses it).
 */
export function isTaskTakenOver(task: TaskOwnerSource): boolean {
  return Object.hasOwn(task, "currentOwner") && task.currentOwner !== undefined;
}

/** When the task was taken over (the taker's `since`), or undefined for a task nobody took over or whose taker can't be read. */
export function takenOverSince(task: TaskOwnerSource): string | undefined {
  return isTaskTakenOver(task) ? readCurrentOwner(task.currentOwner)?.since : undefined;
}

/**
 * A merge hands the duplicate's hold on a task to the survivor (Plan 5 Task 21), through the same `currentOwner` a take-over uses, so every authority read follows the survivor and the
 * creator's own fields, the principal and the earlier decisions stay as history: a taker's record with the person changed and the take-over's `since` kept; or, for a task the
 * duplicate created and nobody took over, a new record that begins at `at`. Undefined when the duplicate does not hold the task (someone else took it over, the taker can't be read, or it
 * is another person's), so a merge never touches a task it does not own.
 */
export function currentOwnerAfterMerge(task: TaskOwnerSource, duplicateId: string, survivor: TaskOwner, at: string): TaskCurrentOwner | undefined {
  const person = { developerId: survivor.developerId, name: survivor.name, provider: survivor.provider, ...(survivor.slackUserId === undefined ? {} : { slackUserId: survivor.slackUserId }) };
  if (!isTaskTakenOver(task)) return tryEffectiveTaskOwner(task)?.developerId === duplicateId ? { ...person, since: at } : undefined;
  const taker = readCurrentOwner(task.currentOwner);
  return taker === undefined || taker.developerId !== duplicateId ? undefined : { ...person, since: taker.since };
}

/** Whether `developerId` holds the task by a take-over (it is theirs now and they did not create it): their task-list row is a copy of the creator's, which moves with them. */
export function holdsTaskByTakeOver(task: TaskOwnerSource, developerId: string): boolean {
  return isTaskTakenOver(task) && tryEffectiveTaskOwner(task)?.developerId === developerId && task.developerId !== developerId;
}

/**
 * Whether an owner's decision (made by `actorId` at `decidedAt`, the time stored with it) still counts as the task owner's now: the owner's actor id counts; so does the
 * creator's, when the decision was made before someone took the task over (never judged by the time it is acted on); `ownerActorIds` (the task's People owners, when it
 * has any) count as well. A taker's decision from before they took the task over does not.
 */
export function ownerDecisionCounts(task: TaskOwnerSource, actorId: string, decidedAt: string, ownerActorIds?: readonly string[]): boolean {
  const takenAt = takenOverSince(task);
  const before = takenAt !== undefined && Date.parse(decidedAt) < Date.parse(takenAt);
  const creator = taskOwnerKey(task.developerId, task.taskId);
  if (ownerActorIds !== undefined) return ownerActorIds.includes(actorId) || (before && actorId === creator);
  return actorId === (before ? creator : ownerActorIdOf(task));
}

/** The owner's name for a display: the one recorded, or the fixed `UNNAMED_MEMBER` when none is (or the owner can't be read). Never the creator's name for someone else, never blank. */
export function ownerDisplayName(task: TaskOwnerSource): string {
  const name = tryEffectiveTaskOwner(task)?.name;
  return present(name) ? name : UNNAMED_MEMBER;
}

/**
 * Whether `developerId` is the task's owner now. Without a way to follow merges, only the stored id is the owner. With one (`resolveMember`: a developer merged into
 * another reads as that other), a taker who was merged away since is the owner as the member they became; only the taker is followed, never the creator (the merge
 * moves the creator's own tasks). An owner that can't be read is nobody.
 */
export async function isTaskOwner(task: TaskOwnerSource, developerId: string, resolveMember?: (developerId: string) => Promise<string>): Promise<boolean> {
  const owner = tryEffectiveTaskOwner(task);
  if (owner === undefined) return false;
  if (owner.developerId === developerId) return true;
  if (resolveMember === undefined || !isTaskTakenOver(task)) return false;
  return (await resolveMember(owner.developerId)) === (await resolveMember(developerId));
}

/** `effectiveTaskOwner`, for a read that shows or lists rather than decides: `undefined` when the owner can't be read (nobody is the owner then). */
export function tryEffectiveTaskOwner(task: TaskOwnerSource): TaskOwner | undefined {
  try {
    return effectiveTaskOwner(task);
  } catch {
    return undefined;
  }
}

/** The owner's actor id: what an actor is compared with when the code asks "is this the owner?". Before a take-over it is the task's `ownerKey`; after one it names the taker. */
export function ownerActorIdOf(task: TaskOwnerSource): string {
  return taskOwnerKey(effectiveTaskOwner(task).developerId, task.taskId);
}

/**
 * The name an earlier decision or message shows for an actor: the creator's for the creator's actor id (`task.ownerKey`), the taker's for the current owner's, so a
 * decision made before a take-over still reads as the creator's. `undefined` for any other actor.
 */
export function ownerNameOfActor(task: TaskOwnerSource, actorId: string): string | undefined {
  if (actorId === taskOwnerKey(task.developerId, task.taskId)) return safeDisplayName(task.developerName, task.developerId);
  return tryEffectiveTaskOwner(task) !== undefined && actorId === ownerActorIdOf(task) ? effectiveTaskOwner(task).name : undefined;
}

/**
 * The condition a write puts on the task row so it holds only while the owner it was decided for is still the owner: no `currentOwner` for an untaken task, else
 * the taker and the time they took it. Names and values carry the `owner` prefix, so they join any other condition on the row.
 */
export function ownerFenceOf(task: TaskOwnerSource): { expression: string; names: Record<string, string>; values: Record<string, unknown> } {
  const owner = effectiveTaskOwner(task);
  if (task.currentOwner === undefined) return { expression: "attribute_not_exists(#ownerFence)", names: { "#ownerFence": "currentOwner" }, values: {} };
  return {
    expression: "#ownerFence.#ownerFenceId = :ownerFenceId AND #ownerFence.#ownerFenceSince = :ownerFenceSince",
    names: { "#ownerFence": "currentOwner", "#ownerFenceId": "developerId", "#ownerFenceSince": "since" },
    values: { ":ownerFenceId": owner.developerId, ":ownerFenceSince": task.currentOwner.since },
  };
}

export interface OperationFacts { id: string; kind: string; status: string; error?: string | undefined; createdAt: string; updatedAt?: string | undefined; fence?: number | undefined; workflowMode?: string | undefined }

const LIVE = new Set(["ACCEPTED", "DISPATCHING", "RUNNING", "CANCEL_REQUESTED"]);

/**
 * Oldest first. F9: exported so Task 10 reuses it rather than redeclaring it. Two operations can
 * share a millisecond, so a tie goes to the fence: each writer operation takes the workspace's
 * next fence, so the later one has the higher fence.
 */
export const byCreated = (left: OperationFacts, right: OperationFacts) =>
  left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : (left.fence ?? 0) - (right.fence ?? 0);

/**
 * A plan check that failed. The check is advice that a person never asked for and that never holds a plan back (the plan goes to review, shown as not checked), so its failure is not the task's:
 * v0.4.10 staging showed `FAILED` for a task whose plan waited at review (and the session `Needs a person`).
 */
const failedPlanCheck = (operation: OperationFacts): boolean => operation.kind === "task" && operation.workflowMode === "PLAN_CRITIQUE" && operation.status === "FAILED";

/** The newest task or publish operation: what the developer last asked for (R4). A failed plan check is not one of them. */
export function currentOperation(operations: readonly OperationFacts[]): OperationFacts | undefined {
  return operations.filter((operation) => (operation.kind === "task" || operation.kind === "publish") && !failedPlanCheck(operation)).sort(byCreated).at(-1);
}

const DISPATCH_OR_COMPUTE = /^RUNTIME_UNAVAILABLE:/;
const WORKER_CALLBACK_REFUSED = /^RUNTIME_UNAVAILABLE: worker callback pull-request(?:-update)? failed with HTTP \d{3}$/;
/** F18: also matches the worker devcontainer's "timeout:<ms>" error text (packages/worker/src/devcontainer.ts). */
const TIMED_OUT = /\btimed? ?out\b|\btimeout:/i;

/** R5. */
export function failureCategory(kind: string, status: string, error: string | undefined): DeveloperTaskFailureCategory {
  if (status === "INTERRUPTED") return "interrupted";
  // Task 16: the worker's one message for a spent AI budget, whoever's budget it was.
  if (error === BUDGET_EXHAUSTED_FAILURE_MESSAGE) return "budget_exhausted";
  // A worker that ran and whose callback the control plane refused (opening the pull request on GitHub failed, say) was
  // available: that is the step failing, not "no worker was free".
  if (error !== undefined && DISPATCH_OR_COMPUTE.test(error) && !WORKER_CALLBACK_REFUSED.test(error)) return "worker_unavailable";
  if (kind === "prepare") return "setup_failed";
  if (kind === "publish") return "publication_failed";
  if (error !== undefined && TIMED_OUT.test(error)) return "timed_out";
  return "task_failed";
}

const COMPUTE_LOST = /^RUNTIME_UNAVAILABLE: workspace compute was lost\b/;
/** #154: a setup that never finished cannot be continued, so "retry the request" is wrong there. */
export const COMPUTE_LOST_DURING_SETUP = "workspace compute was lost during setup; close this task and start a new one";

function failureOf(kind: string, status: string, error: string | undefined): DeveloperTaskFailure {
  const category = failureCategory(kind, status, error);
  if (kind !== "prepare") {
    // redactAndCap redacts then caps surrogate-pair-safely (a plain .slice can split an emoji).
    return { category, message: redactAndCap(error ?? `the ${kind} operation ended ${status}`, DEVELOPER_FAILURE_MESSAGE_MAX).text };
  }
  const text = error !== undefined && COMPUTE_LOST.test(error) ? COMPUTE_LOST_DURING_SETUP : error ?? `the ${kind} operation ended ${status}`;
  return { category, stage: "setup", message: redactAndCap(text, DEVELOPER_FAILURE_MESSAGE_MAX).text };
}

export interface DerivedStatus {
  status: DeveloperTaskStatus;
  failure?: DeveloperTaskFailure;
  closing: boolean;
  current?: OperationFacts;
  /** #225: the prepare whose failure the task reads as: its events and its last change are the task's. */
  failedPrepare?: OperationFacts;
}

/** R4's table. */
export function deriveTaskStatus(input: {
  closedAt?: string | undefined;
  workspaceStatus: string;
  pointer?: { pendingPrompt?: string | undefined; cancelledAt?: string | undefined } | undefined;
  operations: readonly OperationFacts[];
  /** Ruling R60: a task whose creator was removed has ended, whatever its last operation was. */
  outcome?: DeveloperTaskRecord["outcome"] | undefined;
}): DerivedStatus {
  const closing = input.workspaceStatus === "CLOSING" || input.operations.some((operation) => operation.kind === "close" && LIVE.has(operation.status));
  const current = currentOperation(input.operations);
  const withCurrent = current === undefined ? {} : { current };
  if (input.closedAt !== undefined || input.workspaceStatus === "CLOSED") return { status: "CLOSED", closing: false, ...withCurrent };
  if (input.outcome === "creator_removed") return { status: "CANCELLED", closing, ...withCurrent };
  if (input.pointer?.cancelledAt !== undefined && current === undefined) return { status: "CANCELLED", closing };
  if (input.workspaceStatus === "PREPARATION_FAILED") {
    const prepare = input.operations.filter((operation) => operation.kind === "prepare").sort(byCreated).at(-1);
    return { status: "FAILED", closing, failure: failureOf("prepare", prepare?.status ?? "FAILED", prepare?.error), ...(prepare === undefined ? {} : { failedPrepare: prepare }) };
  }
  if (input.pointer?.pendingPrompt !== undefined || input.workspaceStatus === "PREPARING" || current === undefined) return { status: "STARTING", closing };
  if (LIVE.has(current.status)) return { status: "RUNNING", closing, current };
  // A build that changed nothing finished its run; the workflow holds it for a person (`noCodeChanged`) in plain words. It is not a failed task with the worker's config wording.
  const ranToItsEnd = current.kind === "task" && current.status === "FAILED" && current.error?.includes(WORKFLOW_NO_CODE_CHANGE_MESSAGE) === true;
  const status = (ranToItsEnd ? "SUCCEEDED" : current.status) as "SUCCEEDED" | "FAILED" | "CANCELLED" | "INTERRUPTED";
  return {
    status, closing, current,
    ...(status === "FAILED" || status === "INTERRUPTED" ? { failure: failureOf(current.kind, status, current.error) } : {}),
  };
}

export interface StoredEvent { sequence: number; type: string; timestamp: string; payload: unknown }

// capText caps surrogate-pair-safely (a plain .slice can split an emoji at the boundary).
const text = (value: string) => capText(redactText(value).replace(/\s+/g, " ").trim(), DEVELOPER_EVENT_TEXT_MAX).text;
const field = (payload: unknown, name: string): unknown => (payload && typeof payload === "object" ? (payload as Record<string, unknown>)[name] : undefined);

/** One worker event as a line the developer can read, or undefined for streaming noise. */
export function taskEvent(event: StoredEvent): DeveloperTaskEvent | undefined {
  const at = event.timestamp;
  const payload = event.payload;
  switch (event.type) {
    case "lifecycle":
    case "result": {
      const status = field(payload, "status");
      return typeof status === "string" ? { at, kind: "status", text: text(`Worker status: ${status}`) } : undefined;
    }
    case "error": {
      const message = field(payload, "message");
      return { at, kind: "error", text: text(typeof message === "string" ? message : "the worker reported an error") };
    }
    case "tool_start":
    case "tool_end": {
      const name = field(payload, "toolName");
      const tool = typeof name === "string" ? name : "a tool";
      const verb = event.type === "tool_start" ? "Started" : field(payload, "isError") === true ? "Failed" : "Finished";
      return { at, kind: "tool", text: text(`${verb} ${tool}`) };
    }
    case "progress": {
      // PLANINC-1: a model failure, retry or wait reads as a fixed sentence; the provider's own text is never shown. null: a sanitized payload with nothing to show.
      const modelCall = modelCallView(payload);
      if (modelCall === null) return undefined;
      if (modelCall !== undefined) return { at, kind: modelCall.kind, text: text(modelCall.text) };
      const message = field(payload, "message");
      if (typeof message === "string") return { at, kind: "progress", text: text(message) };
      // F7: reuse lastAssistantResponse (Task 2) instead of a second copy of its block-extraction logic.
      const said = lastAssistantResponse([{ payload }]);
      return said === undefined ? undefined : { at, kind: "message", text: text(said) };
    }
    default:
      return undefined;
  }
}

/** The newest `count` readable events, returned oldest first. A heartbeat (one a minute) is kept only when it is the newest, so a long wait never pushes a failure or a retry out of the list. */
export function recentTaskEvents(newestFirst: readonly StoredEvent[], count: number): DeveloperTaskEvent[] {
  const picked: DeveloperTaskEvent[] = [];
  let heartbeatKept = false;
  for (const event of newestFirst) {
    if (picked.length >= count) break;
    if (event.type === "progress" && isHeartbeat(event.payload)) {
      if (heartbeatKept) continue;
      heartbeatKept = true;
    }
    const readable = taskEvent(event);
    if (readable !== undefined) picked.push(readable);
  }
  return picked.reverse();
}

export interface TurnParty {
  taskId: string;
  developerId: string;
  provider: DeveloperSignInMethod;
  developerName: string;
  slackUserId?: string | undefined;
  client: string;
  workspaceId?: string | undefined;
  settingsRevision?: number | undefined;
}

/** F8: the turn record's party, built from a task record, so Task 11's routes and result hook
 * do not each repeat this literal. */
export function partyOfTask(task: DeveloperTaskRecord): TurnParty {
  return {
    taskId: task.taskId, developerId: task.developerId, provider: task.provider, developerName: task.developerName,
    slackUserId: task.slackUserId, client: task.client, workspaceId: task.workspaceId, settingsRevision: task.startingRevision,
  };
}

/**
 * R12: one immutable AI-tool turn record and its keys. Free text only through redactAndCap, so a
 * secret-looking request or response never reaches storage. Each call is one phase (accepted,
 * completed or refused) of one action; the caller's turnId (a fresh id per phase, or the
 * operation's id for a completed phase) keeps aiToolTurnRecordKeys' sk (TURN#<receivedAt>#<turnId>)
 * distinct per phase, so the three phases of one action are three rows, written once each with
 * PutItem and never updated.
 */
export function aiToolTurn(input: {
  party: TurnParty;
  turnId: string;
  action: AiToolTurnRecord["action"];
  phase: AiToolTurnRecord["phase"];
  outcome: AiToolTurnRecord["outcome"];
  receivedAt: string;
  finishedAt: string;
  request: string;
  response: string;
  operationId?: string | undefined;
  errorCode?: string | undefined;
  /** C25: the AgentX admin who took this action on the developer's task (a share mode change). */
  admin?: { issuer: string; subject: string; displayName?: string } | undefined;
}): Record<string, unknown> & AiToolTurnRecord {
  const request = redactAndCap(input.request, TURN_TEXT_LIMIT);
  const response = redactAndCap(input.response, TURN_TEXT_LIMIT);
  const { party } = input;
  const record = AiToolTurnRecordSchema.parse({
    origin: "ai_tool",
    taskId: party.taskId,
    turnId: input.turnId,
    action: input.action,
    phase: input.phase,
    developer: {
      developerId: party.developerId,
      provider: party.provider,
      displayName: party.developerName.slice(0, 200) || "developer",
      ...(party.slackUserId === undefined ? {} : { slackUserId: party.slackUserId }),
    },
    client: party.client,
    ...(input.admin === undefined ? {} : { admin: {
      issuer: input.admin.issuer.slice(0, 512), subject: input.admin.subject.slice(0, 256),
      ...(input.admin.displayName === undefined ? {} : { displayName: input.admin.displayName.slice(0, 200) }),
    } }),
    receivedAt: input.receivedAt,
    ...(party.settingsRevision === undefined ? {} : { settingsRevision: party.settingsRevision }),
    ...(party.workspaceId === undefined ? {} : { workspaceId: party.workspaceId }),
    ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
    outcome: input.outcome,
    startedAt: input.receivedAt,
    finishedAt: input.finishedAt,
    durationMs: Math.max(0, Date.parse(input.finishedAt) - Date.parse(input.receivedAt)),
    requestText: request.text,
    responseText: response.text,
    ...(request.truncated || response.truncated ? { textTruncated: true } : {}),
    ...(input.errorCode === undefined ? {} : { error: { code: input.errorCode.slice(0, 64) } }),
  });
  return { ...aiToolTurnRecordKeys(record), ...record };
}

/** A terminal operation status as a completed turn record's outcome. */
export const OUTCOME: Record<string, AiToolTurnRecord["outcome"]> = { SUCCEEDED: "succeeded", FAILED: "failed", CANCELLED: "cancelled", INTERRUPTED: "interrupted" };

/**
 * R12: the result of a developer's task or publish operation, or of the push of a workflow task's approved fix (a
 * maintain operation). Its turnId and receivedAt are the
 * operation's ID and creation time, so its key is fixed and a repeated result cannot write it
 * twice. The response text is the result summary (FR-037), redacted and capped by aiToolTurn.
 */
export function completedTurn(input: {
  task: DeveloperTaskRecord;
  pointer: Pick<DeveloperTaskPointerRecord, "firstRequestId">;
  operation: Pick<Operation, "id" | "kind" | "requestId" | "createdAt"> & { result?: unknown; error?: string | undefined };
  status: string;
  events: readonly StoredEvent[];
  now: string;
}): Record<string, unknown> & AiToolTurnRecord {
  const { operation } = input;
  const ended = `ended ${input.status}${operation.error ? `: ${operation.error}` : ""}`;
  const published = operation.kind === "publish" ? PullRequestResultSchema.safeParse(operation.result) : undefined;
  const pushed = operation.kind === "maintain" ? PullRequestLifecycleResultSchema.safeParse(operation.result) : undefined;
  const response = operation.kind === "publish"
    ? (published?.success ? `Pull request ${published.data.url}` : `The pull request ${ended}`)
    : operation.kind === "maintain"
      ? (pushed?.success ? `Pushed the fix to pull request ${pushed.data.url}` : `The fix push ${ended}`)
      : lastAssistantResponse(input.events) ?? `The task ${ended}`;
  return aiToolTurn({
    party: partyOfTask(input.task),
    turnId: operation.id,
    action: operation.kind === "publish" || operation.kind === "maintain" ? "pull_request" : operation.requestId === input.pointer.firstRequestId ? "start" : "continue",
    phase: "completed",
    outcome: OUTCOME[input.status] ?? "failed",
    receivedAt: operation.createdAt,
    finishedAt: input.now,
    request: "",
    response,
    operationId: operation.id,
  });
}

/** Moved to the contracts package so the MCP server marks names the same way (final review M7). */
export { inertName };

/** The client name a task keeps when the Slack workflow started it, so its footer can tell Slack from an AI tool. */
export const SLACK_CLIENT_NAME = "Slack";

/** The session ID of the caller the Slack workflow starts tasks as (slack-workflow-caller.ts). */
export const SLACK_WORKFLOW_SESSION_ID = "slack-workflow";

/** What a person reads for the owner when no name anyone knows is on record. */
export const TASK_OWNER_LABEL = "the task owner";
const SLACK_FALLBACK_NAME = /^Slack user U[A-Z0-9]+$/;

/** The owner's name for people to read: "the task owner" when it is empty or only the Slack-ID fallback of a Slack-started task. */
export function taskOwnerLabel(name: string): string {
  const trimmed = name.trim();
  return trimmed === "" || SLACK_FALLBACK_NAME.test(trimmed) ? TASK_OWNER_LABEL : name;
}

/**
 * FR-023. The client is one of the fixed names cleanClientName gives, or "Slack" for a task the Slack workflow
 * started, so it needs no escaping. A task stored before Slack was kept as a client is told by its Slack-ID name.
 */
export function developerFooter(name: string, client: string, product: "AgentX" | "Rovara" = "AgentX", githubLogin?: string): string {
  // C55: text on GitHub never carries an email address, which is what a provider that has no name for a person uses as the display name: the name without it, else the GitHub login, else "the task owner".
  const label = taskOwnerLabel(personNameForText(name, githubLogin) ?? "");
  const owner = label === TASK_OWNER_LABEL ? label : inertName(label);
  const slack = client === SLACK_CLIENT_NAME || (client === UNKNOWN_CLIENT_NAME && SLACK_FALLBACK_NAME.test(name.trim()));
  return `Requested by ${owner} via ${product}, started from ${slack ? SLACK_CLIENT_NAME : client}`;
}

/** The identity every workspace handler sees for a developer task: its own owner key (FR-021). */
export function developerTaskIdentity(task: Pick<DeveloperTaskRecord, "taskId" | "developerId" | "provider" | "developerName" | "client">, orgId: OrgId): AuthenticatedIdentity {
  return {
    issuer: DEVELOPER_TASK_OWNER_ISSUER,
    subject: taskOwnerSubject(task.developerId, task.taskId),
    ownerKey: taskOwnerKey(task.developerId, task.taskId),
    orgId,
    isAdministrator: false,
    claims: {},
    developer: { developerId: task.developerId, provider: task.provider, name: task.developerName, client: task.client, taskId: task.taskId },
  };
}
