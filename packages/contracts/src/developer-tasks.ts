import { z } from "zod";
import {ModelFallbacksSchema} from "./stage-model-shared.js";
import { DeveloperShareModeSchema } from "./project.js";
import { AGENT_RUN_STATES, AGENT_RUN_STEP_STATUSES, AgentStepToolsSchema } from "./agent-run.js";
import { StepIdSchema } from "./agent-recipe.js";
import { ApprovalIdSchema, AgentIdSchema, SpendRequestIdSchema } from "./agent.js";
import { WorkflowSnapshotViewSchema, WORKFLOW_PLAN_MAX_BYTES, WorkflowSnapshotReaderShape, type WorkflowSnapshotReader } from "./task-workflow.js";
import { E2ESharedViewSchema } from "./e2e-view.js";
import { RunEstimateSchema } from "./spend.js";
import { SessionIdSchema } from "./agent-sessions.js";
import { EvidenceViewSchema } from "./evidence.js";
import { MergeTrackingItemSchema, MergeViewSchema, ProofTableViewSchema, VerificationReportSchema } from "./rovara-code.js";
import { readsAsUnknown } from "./forward-reader-unknown.js";

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
 * the last step's report once the run is COMPLETE, `branch` the result the worker chose, `endReason` why a FAILED or CANCELLED run ended ("Unverified, needs a person: ..." when the report was not backed by the agent's tool calls; the report is then the `finalReport`).
 */
export const DeveloperTaskRunViewSchema = z.object({
  state: z.enum(AGENT_RUN_STATES),
  currentStep: z.object({ id: StepIdSchema, name: z.string() }).strict().optional(),
  // A step is read tolerantly (an unknown field is dropped, not refused): the broker may show a client more about a step than this build knows, and `tools` and `unverified` are optional.
  steps: z.array(z.object({
    id: StepIdSchema, name: z.string(), status: z.enum(AGENT_RUN_STEP_STATUSES), report: z.string().optional(),
    /** The tool calls the step made and the ones that failed (shown when one failed or the report was unverified). */
    tools: AgentStepToolsSchema.optional(),
    /** Why the step's report was not backed by what the agent did: the run ended FAILED with these words, "Unverified, needs a person". */
    unverified: z.array(z.string().max(300)).max(10).optional(),
  })),
  pendingApprovals: z.array(z.object({ approvalId: ApprovalIdSchema, kind: z.enum(["write", "step"]), text: z.string(), confirmUrl: z.string().optional() }).strict()),
  finalReport: z.string().optional(),
  branch: z.string().optional(),
  endReason: z.string().optional(),
}).strict();

export const DeveloperTaskViewSchema = z.object({
  /** Actual audited fallback history; absent only on older servers. Current broker emits [] when none. */
  modelFallbacks:ModelFallbacksSchema.optional(),
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
  /**
   * Plan 6, Task 12 (Rovara Code version 2 only; the broker leaves it out of a version 1 task's view, and out of a client that does not send `x-agentx-task-view: 2`):
   * what passed, what failed, what could not be checked and which tests the change added, for the code the checks ran on. Worker output, redacted and bounded; plain
   * text that every reader escapes for its own markup.
   */
  verificationReport: VerificationReportSchema.optional(),
  /** Playbook P3 (version 2 only, full reads only, like `verificationReport`): the proof table of the approved plan's requirements, as the pull request's Proof section has it. Absent when there is no approved plan with claims. */
  proofTable: ProofTableViewSchema.optional(),
  /** Proof and evidence P1 (version 2 only, full reads only, like `proofTable`): the evidence of the code now on the task, with every artifact as a link behind sign-in. Absent until the broker has built one for the current candidate. */
  evidence: EvidenceViewSchema.optional(),
  /**
   * Playbook P2 (version 2 only, like `verificationReport`): which model reviewed the code now on the task, and, when it was the build's own, the note that says so. These are the lines the pull request's Reviews section has
   * (Trust fix A2's `reviewModelLines`), passed on word for word; absent before any review of the current code. Plain text that every reader escapes for its own markup.
   */
  reviewModelLines: z.array(z.string().min(1).max(300)).min(1).max(4).optional(),
  /** Plan 6, Task 12 (version 2 only, like `verificationReport`): the review round whose problems are being fixed, with the sentence the thread says. */
  reviewRound: z.object({ round: z.number().int().min(1).max(100), max: z.number().int().min(1).max(5), message: z.string().min(1).max(200) }).strict().optional(),
  /**
   * Plan 6, Task 14 (version 2 only, full reads only, and only for a client that sends `x-agentx-task-view: 2`): what GitHub says about each pull request of the task,
   * as merge tracking last read it. The merge claim is the broker's own and is never part of the view.
   */
  mergeTracking: z.array(MergeTrackingItemSchema.omit({ mergeClaim: true })).max(32).optional(),
  /**
   * Plan 6, Task 19 (version 2 only, full reads only, and only for a client that sends `x-agentx-task-view: 2`): whether the viewer pressing Merge now would be allowed to, from what merge
   * tracking last read. Advisory: the press re-reads GitHub.
   */
  merge: MergeViewSchema.optional(),
});

/**
 * The task as a client that sends `x-agentx-task-view: 2` reads it: the same view, with the workflow read tolerantly (`WorkflowSnapshotReaderShape`), so a stage or
 * outcome a newer control plane added reads as "unknown" instead of failing the whole answer. The type says what the reader does: `stage` and `outcome` may be
 * "unknown", so a caller has to decide what to do with a stage it does not know.
 */
export type DeveloperTaskClientView = Omit<z.infer<typeof DeveloperTaskViewSchema>, "workflow"> & {
  workflow?: (WorkflowSnapshotReader & { planContent?: string | undefined; workBreakdownDigest?: string | undefined }) | undefined;
};
export const DeveloperTaskClientViewSchema = DeveloperTaskViewSchema.extend({
  workflow: z.looseObject({
    ...WorkflowSnapshotReaderShape,
    planContent: z.string().max(WORKFLOW_PLAN_MAX_BYTES).optional(),
    workBreakdownDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  }).optional(),
}) as unknown as z.ZodType<DeveloperTaskClientView>;
/**
 * The task as the strict view, or undefined when the control plane named a stage, outcome or other value this build does not know (a newer server), which the
 * reader gave as "unknown". The reader differs from the strict view only by those markers and by keeping fields it does not know, so a task with no marker
 * is the strict view. Code that decides what to do from a stage reads the task through this, and tells the person when it is undefined. Only the places the
 * reader can write the marker count (`readsAsUnknown` walks the strict schema), so free text that is the word "unknown" does not.
 */
export function knownTaskView(view: DeveloperTaskClientView): z.infer<typeof DeveloperTaskViewSchema> | undefined {
  return readsAsUnknown(DeveloperTaskViewSchema.shape.workflow, view.workflow) ? undefined : (view as z.infer<typeof DeveloperTaskViewSchema>);
}
