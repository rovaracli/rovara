import { z } from "zod";
import { DeveloperShareModeSchema } from "./project.js";
import { AGENT_RUN_STATES, AGENT_RUN_STEP_STATUSES } from "./agent-run.js";
import { StepIdSchema } from "./agent-recipe.js";
import { ApprovalIdSchema, AgentIdSchema, SpendRequestIdSchema } from "./agent.js";
import { WorkflowSnapshotViewSchema, WORKFLOW_PLAN_MAX_BYTES } from "./task-workflow.js";
import { E2ESharedViewSchema } from "./e2e-view.js";
import { RunEstimateSchema } from "./spend.js";
import { SessionIdSchema } from "./agent-sessions.js";

export const DEVELOPER_TASK_SUMMARY_MAX = 4_000;

export const DEVELOPER_FAILURE_MESSAGE_MAX = 1_000;

export const DEVELOPER_EVENT_TEXT_MAX = 300;

export const DEVELOPER_EVENTS_MAX = 50;

export const CHANNEL_TURNS_MAX = 20;

export const CHANNEL_TURN_REQUEST_MAX = 300;

export const DeveloperTaskShareSchema = z.object({
  mode: DeveloperShareModeSchema,
  channelId: z.string(),
  /** A public channel's name only (R10). */
  channelName: z.string().optional(),
  sharedReason: z.enum(["requested", "required"]),
  modeReason: z.literal("continue_not_allowed").optional(),
  /** Absent while the notifier has not posted the start message yet (C6). */
  threadUrl: z.string().url().optional(),
  /** The start message could not be posted within an hour (C9). */
  postFailed: z.boolean().optional(),
});

/** C15: one Slack turn a teammate ran on the task in its shared thread. */
export const ChannelTurnSchema = z.object({
  author: z.object({ slackUserId: z.string(), name: z.string().optional() }),
  at: z.string().datetime(),
  request: z.string().max(CHANNEL_TURN_REQUEST_MAX),
  outcome: z.string(),
});

export const DeveloperTaskStatusSchema = z.enum(["STARTING", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED", "CLOSED"]);

export const DeveloperTaskFailureCategorySchema = z.enum(["setup_failed", "worker_unavailable", "task_failed", "timed_out", "interrupted", "publication_failed", "budget_exhausted"]);

/** #154: where a failure happened. "setup" means the workspace was never set up, so the task
 * cannot be continued. Optional (a control plane that predates it sends none), and a stage this
 * release does not know is dropped rather than refusing the view. */
export const DeveloperTaskFailureStageSchema = z.enum(["setup"]);

export const DeveloperTaskFailureSchema = z.object({
  category: DeveloperTaskFailureCategorySchema,
  stage: DeveloperTaskFailureStageSchema.optional().catch(undefined),
  message: z.string().max(DEVELOPER_FAILURE_MESSAGE_MAX),
});

export const DeveloperTaskEventSchema = z.object({
  at: z.string(),
  kind: z.enum(["status", "progress", "tool", "message", "error"]),
  text: z.string().max(DEVELOPER_EVENT_TEXT_MAX),
});

export const PullRequestSummarySchema = z.object({
  repository: z.string(),
  number: z.number().int().positive(),
  url: z.string().url(),
  state: z.enum(["open", "closed", "merged"]),
});

/**
 * Plan 3, Task 22: where an agent-step run is. `currentStep` is the step the run is at (the one that runs or waits); a step's `report` is its
 * latest one; `pendingApprovals` are the actions and approval steps waiting for a person, each with the page where it is decided; `finalReport` is
 * the last step's report once the run is COMPLETE, `branch` the result the worker chose, `endReason` why a FAILED or CANCELLED run ended.
 */
export const DeveloperTaskRunViewSchema = z.object({
  state: z.enum(AGENT_RUN_STATES),
  currentStep: z.object({ id: StepIdSchema, name: z.string() }).strict().optional(),
  steps: z.array(z.object({ id: StepIdSchema, name: z.string(), status: z.enum(AGENT_RUN_STEP_STATUSES), report: z.string().optional() }).strict()),
  pendingApprovals: z.array(z.object({ approvalId: ApprovalIdSchema, kind: z.enum(["write", "step"]), text: z.string(), confirmUrl: z.string().optional() }).strict()),
  finalReport: z.string().optional(),
  branch: z.string().optional(),
  endReason: z.string().optional(),
}).strict();

export const DeveloperTaskViewSchema = z.object({
  taskId: z.string().uuid(),
  title: z.string(),
  project: z.string(),
  status: DeveloperTaskStatusSchema,
  workflow: WorkflowSnapshotViewSchema.extend({
    planContent: z.string().max(WORKFLOW_PLAN_MAX_BYTES).optional(),
    workBreakdownDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  }).optional(),
  e2ePresentation: z.object({ shared: E2ESharedViewSchema, slackBlocks: z.array(z.unknown()).max(16), pageHtml: z.string().max(65_536), mcp: z.object({ scope: z.string().max(2_000), view: E2ESharedViewSchema }).strict() }).strict().optional(),
  failure: DeveloperTaskFailureSchema.optional(),
  /** Ruling R60: set when the task's creator was removed from the org; the task has ended (status CANCELLED) and `outcomeReason` says why. */
  outcome: z.literal("creator_removed").optional(),
  outcomeReason: z.string().max(1000).optional(),
  startingRevision: z.number().int().positive(),
  client: z.string(),
  shared: z.boolean(),
  closing: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  events: z.array(DeveloperTaskEventSchema).max(DEVELOPER_EVENTS_MAX),
  summary: z.string().max(DEVELOPER_TASK_SUMMARY_MAX).optional(),
  changedFiles: z.array(z.object({ repository: z.string(), path: z.string(), added: z.number().int().nonnegative(), removed: z.number().int().nonnegative() })).optional(),
  artifacts: z.array(z.object({ name: z.string(), size: z.number().int().nonnegative().optional() })).optional(),
  pullRequests: z.array(PullRequestSummarySchema).optional(),
  /** R22: what the latest close preflight found, when it refused to close. */
  unpublished: z.array(z.object({ repository: z.string(), reasons: z.array(z.string()) })).optional(),
  /** C1: how the task is shared; absent for a private task. */
  share: DeveloperTaskShareSchema.optional(),
  /** C15: the shared thread's channel turns on this task, newest first. */
  channelTurns: z.array(ChannelTurnSchema).max(CHANNEL_TURNS_MAX).optional(),
  /** Plan 3, Task 15: the agent and version the task runs; absent on a task from before agents. */
  agent: z.object({ agentId: AgentIdSchema, name: z.string(), version: z.union([z.number().int().min(1), z.literal("draft")]), builtin: z.boolean() }).strict().optional(),
  /** Plan 3, Task 22: an agent-step run's progress; absent on every other task. */
  run: DeveloperTaskRunViewSchema.optional(),
  /** Plan 3, Task 32: the task is waiting for money: the limit it reached (`PauseScope`) and, when one was made, the request that asks for more. */
  paused: z.object({ reason: z.literal("budget"), spendRequestId: SpendRequestIdSchema.optional(), scope: z.record(z.string(), z.string()), message: z.string().max(300).optional() }).strict().optional(),
  /** Plan 3, Task 32: what a planning run found before it reached its limit (its last answer), at most 4,096 characters. */
  planningSoFar: z.string().max(4096).optional(),
  /** Plan 3, Task 32: a test run that reached its cap may go on as a normal task (`POST /v1/app/tasks/{id}/continue-as-task`). */
  testOffer: z.object({ capUsd: z.number().nonnegative() }).strict().optional(),
  /** Plan 3, Task 34: what the coding plan under review is expected to cost and the run limit approving it accepts. */
  runEstimate: RunEstimateSchema.optional(),
  /** Plan 5, Task 2: the task's session and its link (`<origin>/s/<sessionId>`); absent on a task with no session (before sessions, a chain step, an install without agents). */
  sessionId: SessionIdSchema.optional(),
  sessionUrl: z.string().url().optional(),
  /**
   * Plan 3, Task 35b: a plan blocked on its run limit: the limit it waits for, the request that asks for it while one is open, and whether its owner may ask
   * again (`POST /v1/app/tasks/{id}/run-limit-request`, once the last request was denied or ran out, not while its start is pending, and at most once per ten
   * minutes: `askAgainAfter` is when). Absent unless the plan is blocked on its run limit.
   */
  runLimit: z.object({ limitUsd: z.number().nonnegative(), spendRequestId: SpendRequestIdSchema.optional(), canAskAgain: z.boolean(), askAgainAfter: z.string().max(40).optional() }).strict().optional(),
});
