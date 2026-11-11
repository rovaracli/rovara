// Part of the broker (split out of ../broker.ts): Slack workflow, people and note events.

import { nightlyHeadDependencies } from "./nightly-head.js";
import { evidenceRouteDependencies } from "./evidence-wiring.js";
import { liveWriterRole } from "../../org/live-role.js";
import type { SlackWorkflowRevisePlanEvent } from "../../agent-sessions/live-steer-revise.js";
import { createHash } from "node:crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { AgentXError, RUN_INPUT_TEXT_MAX_BYTES, sharedTaskKey, SLACK_THREAD_OWNER_ISSUER, SlackMessageTimestampSchema, SlackRequesterSchema, SlackThreadSchema, agentXError, slackThreadSubject, type SlackThread, type OrgId, WORKFLOW_RESOLVE_FINDINGS_MAX, type E2EApplicationPlanIntent } from "@rovara-code/contracts";
import { projectE2EBaselineWanted, requestWorkflowE2EBaselineRound } from "../workflow-e2e-baseline.js";
import { DeveloperSignInStore, type DeveloperRecord } from "../../developer/store.js";
import { getItem } from "../cancellation.js";
import { requireCreatorStillMember } from "../../developer/creator-member.js";
import { grantRoleOf } from "../../developer/project-roles.js";
import { ownerActorIdOf, taskKey, tryEffectiveTaskOwner, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { peopleOfItem, requireSessionLevel } from "../../agent-sessions/access.js";
import { slackReplyAuthor } from "../../agent-sessions/events.js";
import { codeIntentDependenciesOf, developerTaskRouteDependencies, type DeveloperCaller, type DeveloperRouteDependencies } from "../developer-routes.js";
import type { DeveloperTaskActions } from "../developer-task-actions.js";
import { SLACK_SEND_BACK_INSTRUCTIONS, captureWorkflowFeedbackNote, confirmTaskPeopleProposal, getTaskPeople, getWorkflowFeedbackReview, recordWorkflowThreadNote, retryTaskWorkflowFeedbackReview, routeDeveloperTaskRequest, submitSlackTaskOwnership, submitSlackTaskPeopleRole, submitWorkflowFeedbackDecision } from "../developer-tasks.js";
import { ownerKeyForSubject } from "../lambda.js";
import { stopSwebenchRun } from "../swebench.js";
import { startCodeIntent } from "../../rovara-code/intent.js";
import { designFirstRequestOf, markDesignFirst } from "../../design-review/design-first.js";
import { parseWorkflowStartRequest } from "../slack-workflow-choice.js";
import { WORK_ACTIONS, can, requireProjectWorkRole, resolveTaskAccess, type TaskAccess, type TaskAction } from "../../developer/task-access.js";
import { taskAccessFence } from "../../developer/task-people.js";
import { cancelRunningTask, type TaskCancellation } from "./acceptance.js";
import { swebenchDependencies } from "./admin-and-helpers.js";
import type { AwsBrokerDependencies } from "./definitions.js";
import { agentRouteDependencies, developerTaskActions, requireRecordProject, requireSlackAllowedByEdition, requireSlackRequesterWriterRole, slackCallerFor, slackTeamOrg } from "./dependency-wiring.js";
import { slackMemberRule } from "../../org/slack-explicit-members.js";
import { dispatchWorkflowContinuation } from "./e2e-rounds.js";
import { getMembership, requireWorkspace } from "./records.js";
import { creatorCheckOf, githubScope, installOrgId, resolveSlackThreadKey } from "./scope-helpers.js";
import { validateWorkflowE2EApplicationPlan } from "./task-operations.js";
import { refreshTaskFeedbackForOwnerDecision } from "./terminal-and-github-events.js";
import { loadWorkflowE2EArtifact, loadWorkflowE2EScenarioResults, workflowE2EPresentation, workflowE2EPublicationChecks } from "./workflow-e2e-verification.js";
import { getSlackBinding, sharedStopFences, sharedThread, sharedThreadOpen, verifiedSharedStopBinding } from "./workspace-preparation.js";
import { specSeamsOf } from "./spec-wiring.js";
import { workingBranchPortOf } from "./working-branch-port.js";
import { recordSlackWorkflowRefusal } from "./workspace-routes.js";

/**
 * The Slack ingress's stop command (#126): a thread's messages queue behind its running task, so a
 * "stop" in the thread is handled before the queue, here. Invoked by the ingress Lambda only, never
 * through API Gateway. Any member of the bound channel may stop the thread's task, as any member
 * may start one.
 */
export interface SlackStopTaskEvent {
  source: "agentx.slack-ingress";
  action: "stop-task";
  thread: SlackThread;
  userId: string;
}

export interface SlackWorkflowStartEvent {
  source: "agentx.slack-ingress";
  action: "start-workflow";
  thread: SlackThread;
  userId: string;
  instructions: string;
  workflowPath: "QUICK" | "FULL";
  requestId: string;
}

export interface SlackWorkflowDecisionEvent {
  source: "agentx.slack-ingress";
  action: "workflow-decision";
  taskId: string;
  userId: string;
  thread: SlackThread;
  requestId: string;
  expectedRevision: number;
  artifactDigest: string;
  workBreakdownDigest?: string;
  /** QA6-12b: the run limit the Approve button showed; sent as `acknowledgedRunLimitUsd`, which the decision checks against the limit approving would set now. */
  acknowledgedRunLimitUsd?: number;
  decision: "APPROVE" | "REQUEST_CHANGES";
  reason: string;
  selectedOptionalCheckIds: string[];
}

export interface SlackWorkflowRetryEvent {
  source: "agentx.slack-ingress";
  action: "workflow-retry";
  taskId: string;
  userId: string;
  thread: SlackThread;
  requestId: string;
  expectedRevision: number;
  selectedOptionalCheckIds: string[];
  /** The approved plan's proposed checks the owner kept; all of them when absent. */
  selectedProposedCheckIds?: string[];
  /** Task 16: which blocked step the owner retries; the checks when absent. */
  step?: "plan" | "coding" | "plan_check";
}

/** Task 16: the owner's Send back to coding, from the task's own thread. */
export interface SlackWorkflowSendBackEvent {
  source: "agentx.slack-ingress";
  action: "workflow-send-back";
  taskId: string;
  userId: string;
  thread: SlackThread;
  requestId: string;
  expectedRevision: number;
}

/** The owner's answer for each blocking review finding (the Resolve findings form), from the task's own thread. */
export interface SlackWorkflowResolveFindingsEvent {
  source: "agentx.slack-ingress";
  action: "workflow-resolve-findings";
  taskId: string;
  userId: string;
  thread: SlackThread;
  requestId: string;
  expectedRevision: number;
  candidateDigest: string;
  resolutions: Array<{ findingId: string; action: "ACCEPT" | "FIX"; note: string }>;
}

/** Task 16: the owner's confirmed Close task, from the task's own thread. */
export interface SlackWorkflowCloseEvent {
  source: "agentx.slack-ingress";
  action: "workflow-close";
  taskId: string;
  userId: string;
  thread: SlackThread;
  requestId: string;
}

export interface SlackWorkflowReviewRetryEvent {
  source: "agentx.slack-ingress";
  action: "workflow-review-retry";
  taskId: string;
  userId: string;
  thread: SlackThread;
  requestId: string;
  expectedRevision: number;
  candidateDigest: string;
}

export interface SlackWorkflowFeedbackFindingsDecisionEvent {
  source: "agentx.slack-ingress";
  action: "workflow-feedback-findings-decision";
  taskId: string; userId: string; thread: SlackThread; requestId: string; expectedRevision: number;
  reviewDigest: string; proposalDigest: string; bundleSetDigest: string;
  /** ANSWER: the owner's words answer the reviewer's questions shown on the card; they approve those findings only. */
  selection: "RECOMMENDED" | "ANSWER";
  /** ANSWER only: the findings whose questions the card showed (one to three). */
  questionFindingIds?: string[];
  decision: "APPROVE" | "REQUEST_CHANGES" | "DISMISS"; ownerNote?: string;
}

export interface SlackWorkflowFeedbackNoteEvent {
  source: "agentx.slack-ingress"; action: "feedback-note"; taskId: string; userId: string; thread: SlackThread;
  eventId: string; messageTs: string; text: string;
}

export interface SlackTaskAuthorizationEvent {
  source: "agentx.slack-ingress"; action: "task-people-authorize"; taskId: string; userId: string; thread: SlackThread;
  taskAction: "decide" | "retry" | "publish" | "feedback" | "close" | "control";
}

export interface SlackTaskPeopleConfirmEvent {
  source: "agentx.slack-ingress"; action: "task-people-confirm"; taskId: string; requestId: string; userId: string; thread: SlackThread;
}

export interface SlackTaskPeopleReadEvent {
  source: "agentx.slack-ingress"; action: "task-people-read"; taskId: string; userId: string; thread: SlackThread;
}
export interface SlackTaskPeopleChangeEvent {
  source: "agentx.slack-ingress"; action: "task-people-change"; taskId: string; requestId: string; expectedPeopleRevision: number;
  slackUserId: string; role: "owner" | "commenter" | "viewer" | "denied"; userId: string; thread: SlackThread;
}
export interface SlackTaskPeopleTakeOwnershipEvent {
  source: "agentx.slack-ingress"; action: "task-people-take-ownership"; taskId: string; requestId: string; expectedPeopleRevision: number;
  userId: string; thread: SlackThread;
}

function slackTaskPeopleBase(event: unknown, action: SlackTaskPeopleReadEvent["action"] | SlackTaskPeopleChangeEvent["action"] | SlackTaskPeopleTakeOwnershipEvent["action"]): event is Record<string, unknown> {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  return value.source === "agentx.slack-ingress" && value.action === action && value.requestContext === undefined
    && typeof value.taskId === "string" && typeof value.userId === "string" && typeof value.thread === "object" && value.thread !== null;
}
export const isSlackTaskPeopleReadEvent = (event: unknown): event is SlackTaskPeopleReadEvent => slackTaskPeopleBase(event, "task-people-read");
export const isSlackTaskPeopleChangeEvent = (event: unknown): event is SlackTaskPeopleChangeEvent => {
  if (!slackTaskPeopleBase(event, "task-people-change")) return false;
  return typeof event.requestId === "string" && Number.isSafeInteger(event.expectedPeopleRevision) && typeof event.slackUserId === "string"
    && (event.role === "owner" || event.role === "commenter" || event.role === "viewer" || event.role === "denied");
};
export const isSlackTaskPeopleTakeOwnershipEvent = (event: unknown): event is SlackTaskPeopleTakeOwnershipEvent => {
  if (!slackTaskPeopleBase(event, "task-people-take-ownership")) return false;
  return typeof event.requestId === "string" && Number.isSafeInteger(event.expectedPeopleRevision);
};

export async function handleSlackTaskPeople(dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions,
  event: SlackTaskPeopleReadEvent | SlackTaskPeopleChangeEvent | SlackTaskPeopleTakeOwnershipEvent) {
  if (dependencies.developer === undefined) throw agentXError("NOT_FOUND", "developer task workflows are not configured");
  const thread = SlackThreadSchema.parse(event.thread);
  const caller = await slackCallerFor(dependencies, SlackRequesterSchema.shape.userId.parse(event.userId), thread.teamId);
  const taskId = randomUUIDSchema.parse(event.taskId);
  const agents = agentRouteDependencies(dependencies, tasks);
  const routeDeps = developerTaskRouteDependencies({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, developer: dependencies.developer, now: Date.now, tasks, ...(agents === undefined ? {} : { agents }) }, caller);
  const access = await resolveTaskAccess(routeDeps, caller, taskId, event.action === "task-people-read" ? "read" : event.action === "task-people-change" ? "peopleManage" : "read");
  if (access.task.share?.teamId !== thread.teamId || access.task.share.channelId !== thread.channelId || access.task.share.threadTs !== thread.threadTs) {
    throw agentXError("FORBIDDEN", "this task belongs to another Slack thread");
  }
  if (event.action === "task-people-read") return getTaskPeople(routeDeps, caller, taskId);
  const requestId = randomUUIDSchema.parse(event.requestId);
  if (!Number.isSafeInteger(event.expectedPeopleRevision) || event.expectedPeopleRevision < 1) throw agentXError("CONFIG_INVALID", "People revision is invalid");
  if (event.action === "task-people-take-ownership") return submitSlackTaskOwnership(routeDeps, caller, taskId, { requestId, expectedPeopleRevision: event.expectedPeopleRevision });
  return submitSlackTaskPeopleRole(routeDeps, caller, taskId, { requestId, expectedPeopleRevision: event.expectedPeopleRevision,
    slackUserId: SlackRequesterSchema.shape.userId.parse(event.slackUserId), role: event.role, teamId: thread.teamId, channelId: thread.channelId });
}

export function isSlackTaskPeopleConfirmEvent(event: unknown): event is SlackTaskPeopleConfirmEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  return value.source === "agentx.slack-ingress" && value.action === "task-people-confirm" && value.requestContext === undefined
    && typeof value.taskId === "string" && typeof value.requestId === "string" && typeof value.userId === "string" && typeof value.thread === "object" && value.thread !== null;
}

export async function confirmSlackTaskPeople(dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, event: SlackTaskPeopleConfirmEvent) {
  if (dependencies.developer === undefined) throw agentXError("NOT_FOUND", "developer task workflows are not configured");
  const thread = SlackThreadSchema.parse(event.thread);
  const caller = await slackCallerFor(dependencies, SlackRequesterSchema.shape.userId.parse(event.userId), thread.teamId);
  const taskId = randomUUIDSchema.parse(event.taskId);
  const requestId = randomUUIDSchema.parse(event.requestId);
  const routeDeps = developerTaskRouteDependencies({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, developer: dependencies.developer, now: Date.now, tasks }, caller);
  const access = await resolveTaskAccess(routeDeps, caller, taskId, "read");
  if (access.task.share?.teamId !== thread.teamId || access.task.share.channelId !== thread.channelId || access.task.share.threadTs !== thread.threadTs) throw agentXError("FORBIDDEN", "this task belongs to another Slack thread");
  return confirmTaskPeopleProposal(routeDeps, caller, taskId, requestId);
}

export function isSlackTaskAuthorizationEvent(event: unknown): event is SlackTaskAuthorizationEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  return value.source === "agentx.slack-ingress" && value.action === "task-people-authorize" && value.requestContext === undefined
    && typeof value.taskId === "string" && typeof value.userId === "string" && typeof value.thread === "object" && value.thread !== null
    && ["decide", "retry", "publish", "feedback", "close", "control"].includes(String(value.taskAction));
}

export async function authorizeSlackTaskAction(dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, event: SlackTaskAuthorizationEvent) {
  if (dependencies.developer === undefined) throw agentXError("NOT_FOUND", "developer task workflows are not configured");
  const thread = SlackThreadSchema.parse(event.thread);
  const caller = await slackCallerFor(dependencies, SlackRequesterSchema.shape.userId.parse(event.userId), thread.teamId);
  const taskId = randomUUIDSchema.parse(event.taskId);
  const routeDeps = developerTaskRouteDependencies({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, developer: dependencies.developer, now: Date.now, tasks }, caller);
  // This signed UI port reports the current lifecycle state (for example, a retired button) after
  // a fresh read+role check. The separately invoked mutation route still requires an open task.
  const access = await resolveTaskAccess(routeDeps, caller, taskId, "read");
  if (!can(access.role, event.taskAction, access.source)) throw agentXError("TASK_NOT_FOUND", "no task here that you can see");
  // The button's press is gated like the action behind it: a project viewer (an owner lowered to viewer included) is not offered work.
  if (WORK_ACTIONS.includes(event.taskAction)) await requireProjectWorkRole(routeDeps, access.task, caller);
  if (access.task.share?.teamId !== thread.teamId || access.task.share.channelId !== thread.channelId || access.task.share.threadTs !== thread.threadTs) {
    throw agentXError("FORBIDDEN", "this task belongs to another Slack thread");
  }
  return { authorized: true };
}

export function isSlackWorkflowStartEvent(event: unknown): event is SlackWorkflowStartEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  return value.source === "agentx.slack-ingress" && value.action === "start-workflow" && value.requestContext === undefined
    && typeof value.instructions === "string" && value.instructions.trim().length > 0
    && typeof value.requestId === "string" && (value.workflowPath === "QUICK" || value.workflowPath === "FULL");
}

export async function startSlackWorkflow(dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, event: SlackWorkflowStartEvent) {
  if (dependencies.developer === undefined) throw agentXError("NOT_FOUND", "developer task workflows are not configured");
  const thread = SlackThreadSchema.parse(event.thread);
  const userId = SlackRequesterSchema.shape.userId.parse(event.userId);
  const requestId = randomUUIDSchema.parse(event.requestId);
  let instructions = event.instructions.trim();
  if (!instructions || Buffer.byteLength(instructions, "utf8") > RUN_INPUT_TEXT_MAX_BYTES) throw agentXError("CONFIG_INVALID", "workflow request is empty or too long");
  if (dependencies.developer.slackTeamId !== thread.teamId) throw agentXError("FORBIDDEN", "Slack workspace is not enabled for developer tasks");
  const teamOrg = await slackTeamOrg(dependencies, thread.teamId);
  const binding = await getSlackBinding(dependencies, teamOrg, thread.teamId, thread.channelId);
  if (binding === undefined) throw agentXError("FORBIDDEN", "Slack channel is not bound to a project");
  // `design first:` (DR11) is read HERE, where the project is known, and only while the design review stage exists for the company (`dr` on and the company allows it). With the stage off the text is exactly what the person typed.
  const first = await designFirstRequestOf(dependencies, teamOrg, instructions);
  if (first.designFirst) {
    const nested = parseWorkflowStartRequest(first.rest);
    instructions = (nested.kind === "start" ? nested.instructions : first.rest).trim();
    if (!instructions) throw agentXError("CONFIG_INVALID", "workflow request is empty or too long");
  }
  const existingWorkflowThread = await getItem(dependencies, sharedTaskKey(thread));
  const threadOwnerKey = ownerKeyForSubject(SLACK_THREAD_OWNER_ISSUER, slackThreadSubject(thread));
  const existingThreadTask = await getItem<{ workspaceId?: string; closedAt?: string }>(dependencies, await resolveSlackThreadKey(dependencies, await slackTeamOrg(dependencies, thread.teamId), threadOwnerKey));
  if (existingWorkflowThread !== undefined || (typeof existingThreadTask?.workspaceId === "string" && existingThreadTask.closedAt === undefined)) {
    throw agentXError("WORKSPACE_BUSY", "this Slack thread already has a task; start the workflow in a new thread");
  }
  const caller = await slackCallerFor(dependencies, userId, thread.teamId);
  const agents = agentRouteDependencies(dependencies, tasks);
  const routeDependencies: DeveloperRouteDependencies = { documentClient: dependencies.documentClient, tableName: dependencies.tableName, developer: dependencies.developer, now: Date.now, tasks,
    ...(dependencies.modelAccess === undefined ? {} : { modelAccess: dependencies.modelAccess.access }),
    ...(dependencies.cloud === true ? { cloud: true } : {}),
    // Plan 3, Task 15: a Slack-started workflow stores its agent snapshot like any other start.
    ...(agents === undefined ? {} : { agents }) };
  // Plan 6 Task 3: the Slack start is a Rovara Code intent from the thread, through the one entry point; the explicit path the member chose is the request's.
  const started = await startCodeIntent(codeIntentDependenciesOf(routeDependencies, caller), caller, {
    requestId, project: binding.projectName, input: { text: instructions }, path: event.workflowPath, source: "slack",
    binding: { kind: "slack_thread", teamId: thread.teamId, channelId: thread.channelId, threadTs: thread.threadTs },
  });
  // `design first:` (DR11): recorded on the task for the Understand step's mode resolution, which only turns it on while the switch is on for the project.
  if (first.designFirst) await markDesignFirst(dependencies, started.task.taskId, caller.developerId);
  return { task: started.task, sessionUrl: started.sessionUrl };
}

const randomUUIDSchema = { parse(value: string): string { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw agentXError("CONFIG_INVALID", "workflow request ID is invalid"); return value; } };

export function isSlackWorkflowDecisionEvent(event: unknown): event is SlackWorkflowDecisionEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  return value.source === "agentx.slack-ingress" && value.action === "workflow-decision" && value.requestContext === undefined
    && typeof value.taskId === "string" && typeof value.userId === "string" && typeof value.requestId === "string"
    && Number.isInteger(value.expectedRevision) && typeof value.artifactDigest === "string"
    && (value.workBreakdownDigest === undefined || (typeof value.workBreakdownDigest === "string" && /^[a-f0-9]{64}$/.test(value.workBreakdownDigest)))
    && (value.acknowledgedRunLimitUsd === undefined || (typeof value.acknowledgedRunLimitUsd === "number" && Number.isFinite(value.acknowledgedRunLimitUsd) && value.acknowledgedRunLimitUsd >= 0 && value.acknowledgedRunLimitUsd <= 100_000))
    && (value.decision === "APPROVE" || value.decision === "REQUEST_CHANGES") && typeof value.reason === "string"
    && Array.isArray(value.selectedOptionalCheckIds);
}

export function isSlackWorkflowRetryEvent(event: unknown): event is SlackWorkflowRetryEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  return value.source === "agentx.slack-ingress" && value.action === "workflow-retry" && value.requestContext === undefined
    && typeof value.taskId === "string" && typeof value.userId === "string" && typeof value.requestId === "string"
    && Number.isInteger(value.expectedRevision) && Array.isArray(value.selectedOptionalCheckIds)
    && value.selectedOptionalCheckIds.every((id) => typeof id === "string") && typeof value.thread === "object" && value.thread !== null
    && (value.selectedProposedCheckIds === undefined || (Array.isArray(value.selectedProposedCheckIds) && value.selectedProposedCheckIds.every((id) => typeof id === "string")))
    && (value.step === undefined || value.step === "plan" || value.step === "coding" || value.step === "plan_check");
}

export function isSlackWorkflowSendBackEvent(event: unknown): event is SlackWorkflowSendBackEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  return value.source === "agentx.slack-ingress" && value.action === "workflow-send-back" && value.requestContext === undefined
    && typeof value.taskId === "string" && typeof value.userId === "string" && typeof value.requestId === "string"
    && Number.isInteger(value.expectedRevision) && typeof value.thread === "object" && value.thread !== null;
}

export function isSlackWorkflowResolveFindingsEvent(event: unknown): event is SlackWorkflowResolveFindingsEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  return value.source === "agentx.slack-ingress" && value.action === "workflow-resolve-findings" && value.requestContext === undefined
    && typeof value.taskId === "string" && typeof value.userId === "string" && typeof value.requestId === "string"
    && Number.isInteger(value.expectedRevision) && typeof value.candidateDigest === "string" && /^[a-f0-9]{64}$/.test(value.candidateDigest)
    && typeof value.thread === "object" && value.thread !== null
    && Array.isArray(value.resolutions) && value.resolutions.length >= 1 && value.resolutions.length <= WORKFLOW_RESOLVE_FINDINGS_MAX
    && value.resolutions.every((entry: unknown) => {
      const resolution = entry as Record<string, unknown> | null;
      return typeof resolution === "object" && resolution !== null && typeof resolution.findingId === "string" && /^[a-f0-9]{64}$/.test(resolution.findingId)
        && (resolution.action === "ACCEPT" || resolution.action === "FIX") && typeof resolution.note === "string";
    });
}

/** The owner's answers to the blocking review findings, through the same route an AI tool uses; the route holds every rule. */
export async function resolveSlackWorkflowFindings(dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, event: SlackWorkflowResolveFindingsEvent) {
  const { taskId, requestId, caller, developer } = await ownedSlackWorkflowTask(dependencies, event, "resolve these review findings");
  const routeDeps = slackWorkflowRouteDependencies(dependencies, tasks, developer, caller);
  const body = JSON.stringify({ requestId, expectedRevision: event.expectedRevision, candidateDigest: event.candidateDigest,
    resolutions: event.resolutions.map((resolution) => ({ findingId: resolution.findingId, action: resolution.action, note: resolution.note })) });
  const path = `/v1/dev/tasks/${taskId}/workflow/review-findings`;
  return routeDeveloperTaskRequest(routeDeps, caller, { method: "POST", path, headers: {}, requestId, body }, new URL(path, "https://agentx.invalid"));
}

export function isSlackWorkflowCloseEvent(event: unknown): event is SlackWorkflowCloseEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  return value.source === "agentx.slack-ingress" && value.action === "workflow-close" && value.requestContext === undefined
    && typeof value.taskId === "string" && typeof value.userId === "string" && typeof value.requestId === "string"
    && typeof value.thread === "object" && value.thread !== null;
}

/**
 * The application wiring every task route needs (the E2E presentation and publication checks, the plan-approval check, the
 * registered repository identity and the PR feedback refresh). The HTTP routes and every Slack workflow press build their
 * route dependencies from this one place, so a press can never reach a route whose check is not installed.
 */
export function workflowApplicationRouteDependencies(dependencies: AwsBrokerDependencies) {
  return {
    workflowE2EPresentation: (input: { task: DeveloperTaskRecord; operations: readonly unknown[]; actor: "owner" | "viewer" }) => workflowE2EPresentation(dependencies, input.task, input.operations, input.actor),
    workflowE2EPublicationChecks: (input: { task: DeveloperTaskRecord; operations: readonly unknown[] }) => workflowE2EPublicationChecks(dependencies, input.task, input.operations),
    // M1.3 Task 3.7: the task page's rows, the screenshot behind a row, and the baseline round asked for when an application plan is approved.
    workflowE2EScenarioResults: (input: { task: DeveloperTaskRecord; operations: readonly unknown[]; actor: "owner" | "viewer" }) => loadWorkflowE2EScenarioResults(dependencies, input.task, input.operations, input.actor),
    workflowE2EArtifact: (input: { task: DeveloperTaskRecord; sha256: string }) => loadWorkflowE2EArtifact(dependencies, input.task, input.sha256),
    startWorkflowE2EBaseline: async (input: { task: DeveloperTaskRecord }) => requestWorkflowE2EBaselineRound({ documentClient: dependencies.documentClient, tableName: dependencies.tableName }, input.task,
      { enabled: projectE2EBaselineWanted(await requireRecordProject(dependencies, input.task, input.task.project, input.task.startingRevision)) }),
    validateWorkflowE2EApplicationPlan: (input: { task: DeveloperTaskRecord; intent: E2EApplicationPlanIntent; artifact: { id: string; sha256: string }; reapproval?: boolean }) =>
      validateWorkflowE2EApplicationPlan(dependencies, input.task, input.intent, input.artifact, input.reapproval === true ? { reapproval: true } : {}),
    registeredRepositoryIdentity: dependencies.githubPullRequests.getRepositoryIdentity === undefined ? undefined : (url: string, orgId: OrgId) => dependencies.githubPullRequests.getRepositoryIdentity!(url, githubScope(dependencies, orgId)),
    refreshTaskFeedback: (taskId: string) => refreshTaskFeedbackForOwnerDecision(dependencies, taskId),
    // Wire lane D (MD-1): the spec seams, so a publication or a review that needs the spec works on this path too.
    ...specSeamsOf(dependencies),
    // Continue in your own tool: the host side of "publish working branch".
    workingBranchPort: dependencies.workingBranchPort ?? workingBranchPortOf(dependencies),
    ...(dependencies.outsideRecheck === undefined ? {} : { startOutsideRecheck: dependencies.outsideRecheck }),
    // Proof and evidence (wire-proof): the evidence port, only while the proof switch is on (nothing is added otherwise).
    ...evidenceRouteDependencies(dependencies),
    ...nightlyHeadDependencies(dependencies),
  };
}

/** The route dependencies of a Slack workflow press: the same application wiring as the HTTP routes. */
function slackWorkflowRouteDependencies(dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, developer: NonNullable<AwsBrokerDependencies["developer"]>, caller: DeveloperCaller,
  /** What only some presses need on top (see `decideSlackWorkflow`). */ extra: Partial<DeveloperRouteDependencies> = {}) {
  return developerTaskRouteDependencies({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, developer, now: Date.now, tasks,
    ...(dependencies.audit === undefined ? {} : { audit: dependencies.audit }), ...extra,
    ...workflowApplicationRouteDependencies(dependencies) }, caller);
}

/** The owner's task, read for a Slack workflow press from its own thread; anyone else, or another thread, is refused. */
async function ownedSlackWorkflowTask(dependencies: AwsBrokerDependencies, event: { taskId: string; userId: string; thread: SlackThread; requestId: string }, what: string,
  legacySlackOwner = false) {
  if (dependencies.developer === undefined) throw agentXError("NOT_FOUND", "developer task workflows are not configured");
  const thread = SlackThreadSchema.parse(event.thread);
  const userId = SlackRequesterSchema.shape.userId.parse(event.userId);
  const taskId = randomUUIDSchema.parse(event.taskId);
  const requestId = randomUUIDSchema.parse(event.requestId);
  if (dependencies.developer.slackTeamId !== thread.teamId) throw agentXError("FORBIDDEN", "Slack workspace is not enabled for developer tasks");
  let caller: DeveloperCaller;
  let task: DeveloperTaskRecord;
  try {
    const result = await slackTaskAccess(dependencies, developerTaskActions(dependencies), taskId, userId, "read", legacySlackOwner);
    caller = result.caller;
    const access = result.access;
    if (access.role !== "owner") throw agentXError("FORBIDDEN", `only a current task owner can ${what}`);
    task = access.task;
  } catch {
    const stored = await getItem<DeveloperTaskRecord>(dependencies, taskKey(taskId));
    const sidecar = await getItem<Record<string, unknown>>(dependencies, { pk: `DEVTASK#${taskId}`, sk: "PEOPLE" });
    let exactNativeOwner = false;
    // The owner here is the task's owner now: whoever took it over, else its creator (Plan 5 Task 12a).
    const storedOwner = stored === undefined ? undefined : tryEffectiveTaskOwner(stored);
    if (!legacySlackOwner && sidecar === undefined && stored?.client !== "slack" && storedOwner !== undefined) {
      const record = (await dependencies.documentClient.send(new GetCommand({
        TableName: dependencies.developer.signInTableName,
        Key: { pk: `DEVELOPER#${storedOwner.developerId}`, sk: "META" },
        ConsistentRead: true,
      }))).Item as DeveloperRecord | undefined;
      // The row is keyed by the person: a sign-in writes no `developerId` attribute (store.ts getDeveloper), so only a row naming someone else is not theirs.
      exactNativeOwner = record !== undefined && (record.developerId === undefined || record.developerId === storedOwner.developerId) && record.provider === "slack"
        && record.slackUserId === userId && record.revoked === false;
    }
    if (exactNativeOwner) {
      throw agentXError("TASK_NOT_FOUND", "this task cannot be changed from Slack");
    }
    throw agentXError("FORBIDDEN", `only a current task owner can ${what}`);
  }
  if (task.share?.teamId !== thread.teamId || task.share.channelId !== thread.channelId || task.share.threadTs !== thread.threadTs) {
    throw agentXError("FORBIDDEN", "this task belongs to another Slack thread");
  }
  return { task, taskId, requestId, caller, developer: dependencies.developer };
}

/**
 * Resolves the signed Slack actor. A task with PEOPLE uses the canonical native principal. A
 * pre-PEOPLE Slack task may retain its stored native creator ID; exact-thread teammates retain the
 * legacy commenter input path. Linked OIDC principals are never substituted for the Slack actor.
 */
export async function slackTaskAccess(
  dependencies: AwsBrokerDependencies,
  tasks: DeveloperTaskActions,
  taskId: string,
  userId: string,
  action: TaskAction,
  legacySlackOwner = false,
): Promise<{ caller: DeveloperCaller; routeDeps: ReturnType<typeof developerTaskRouteDependencies>; access: TaskAccess }> {
  if (dependencies.developer === undefined) throw agentXError("NOT_FOUND", "developer task workflows are not configured");
  const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(taskId));
  if (task === undefined) throw agentXError("FORBIDDEN", "task access could not be verified");
  const sidecar = await getItem<Record<string, unknown>>(dependencies, { pk: `DEVTASK#${taskId}`, sk: "PEOPLE" });
  const canonical = await slackCallerFor(dependencies, userId, dependencies.developer.slackTeamId ?? "");
  // The legacy Slack owner of a task with no People list is the effective owner (Plan 5 Task 12a): the person who took it over, else its creator.
  const legacyOwner = sidecar === undefined && legacySlackOwner ? tryEffectiveTaskOwner(task) : undefined;
  const caller = legacyOwner !== undefined && legacyOwner.provider === "slack" && legacyOwner.slackUserId === userId
    ? { ...canonical, developerId: legacyOwner.developerId, name: legacyOwner.name }
    : canonical;
  // I2: the swapped-in owner is a person too; if they have become an Auditor (or hold a role that is not a writer's) the task is not theirs to steer from Slack.
  if (caller !== canonical) await liveWriterRole({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, signInTableName: dependencies.developer.signInTableName }, caller.orgId, caller.developerId);
  const routeDeps = developerTaskRouteDependencies({ documentClient: dependencies.documentClient, tableName: dependencies.tableName,
    developer: dependencies.developer, now: Date.now, tasks }, caller);
  try {
    return { caller, routeDeps, access: await resolveTaskAccess(routeDeps, caller, taskId, action) };
  } catch (error) {
    // A verified Slack message/service call in the task's exact linked thread is the legacy
    // commenter proof. The caller validates that exact thread before using this result.
    if (sidecar !== undefined || action !== "comment" || task.share === undefined) throw error;
    // A project viewer only views (Plan 2, Task 21): their explicit grant beats the thread fallback. Anyone with no grant keeps it.
    if (grantRoleOf(await getMembership(dependencies, caller.orgId, caller.developerId, task.project)) === "viewer") throw error;
    return { caller, routeDeps, access: { task, role: "commenter", ownerActorIds: tryEffectiveTaskOwner(task) === undefined ? [] : [ownerActorIdOf(task)] } };
  }
}

/** Task 16: Send back to coding, through the same route an AI tool uses. */
/** Live steer: the owner's Revise the plan, through the same route the task page uses. */
export async function reviseSlackWorkflowPlan(dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, event: SlackWorkflowRevisePlanEvent) {
  const { taskId, requestId, caller, developer } = await ownedSlackWorkflowTask(dependencies, event, "revise the plan");
  const routeDeps = slackWorkflowRouteDependencies(dependencies, tasks, developer, caller);
  const path = `/v1/dev/tasks/${taskId}/workflow/revise-plan`;
  return routeDeveloperTaskRequest(routeDeps, caller, { method: "POST", path, headers: {}, requestId, body: JSON.stringify({ requestId, expectedRevision: event.expectedRevision }) }, new URL(path, "https://agentx.invalid"));
}

export async function sendSlackWorkflowBack(dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, event: SlackWorkflowSendBackEvent) {
  const { taskId, requestId, caller, developer } = await ownedSlackWorkflowTask(dependencies, event, "send this task back to coding");
  const routeDeps = slackWorkflowRouteDependencies(dependencies, tasks, developer, caller);
  const body = JSON.stringify({ requestId, expectedRevision: event.expectedRevision, instructions: SLACK_SEND_BACK_INSTRUCTIONS });
  const path = `/v1/dev/tasks/${taskId}/workflow/send-back`;
  return routeDeveloperTaskRequest(routeDeps, caller, { method: "POST", path, headers: {}, requestId, body }, new URL(path, "https://agentx.invalid"));
}

/**
 * Task 16: Close task, after the owner confirmed in Slack that code not in a pull request is discarded (its open pull
 * request stays on GitHub). That confirmation is the owner's authorization to discard, with or without a pull request:
 * otherwise an approved fix that was never pushed refused the close, and the thread, told "I'll post here when it's
 * closed", heard nothing more.
 */
export async function closeSlackWorkflowTask(dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, event: SlackWorkflowCloseEvent) {
  const { taskId, requestId, caller, developer } = await ownedSlackWorkflowTask(dependencies, event, "close this task");
  const routeDeps = slackWorkflowRouteDependencies(dependencies, tasks, developer, caller);
  const body = JSON.stringify({ requestId, discard_unpublished: true });
  const path = `/v1/dev/tasks/${taskId}/close`;
  return routeDeveloperTaskRequest(routeDeps, caller, { method: "POST", path, headers: {}, requestId, body }, new URL(path, "https://agentx.invalid"));
}

export function isSlackWorkflowReviewRetryEvent(event: unknown): event is SlackWorkflowReviewRetryEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  return value.source === "agentx.slack-ingress" && value.action === "workflow-review-retry" && value.requestContext === undefined
    && typeof value.taskId === "string" && typeof value.userId === "string" && typeof value.requestId === "string"
    && Number.isInteger(value.expectedRevision) && typeof value.candidateDigest === "string" && /^[a-f0-9]{64}$/.test(value.candidateDigest)
    && typeof value.thread === "object" && value.thread !== null;
}

export async function retrySlackWorkflowChecks(dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, event: SlackWorkflowRetryEvent) {
  // The same checks as every other Slack press: this Slack workspace, the task's owner, and the task's own thread.
  const { taskId, requestId, caller, developer } = await ownedSlackWorkflowTask(dependencies, event, "retry verification");
  const routeDeps = slackWorkflowRouteDependencies(dependencies, tasks, developer, caller);
  const instructions = event.step === "plan" ? "The previous planning run stopped before it saved a plan. Plan the request again."
    : event.step === "plan_check" ? "Retry the plan check."
    : event.step === "coding" ? "Retry the coding step." : "Retry the owner-selected project checks without changing code.";
  const body = JSON.stringify({ requestId, expectedRevision: event.expectedRevision, instructions,
    ...(event.step === undefined ? { selectedOptionalCheckIds: event.selectedOptionalCheckIds,
      ...(event.selectedProposedCheckIds === undefined ? {} : { selectedProposedCheckIds: event.selectedProposedCheckIds }) } : {}) });
  const path = `/v1/dev/tasks/${taskId}/workflow/retry`;
  return routeDeveloperTaskRequest(routeDeps, caller, { method: "POST", path, headers: {}, requestId, body }, new URL(path, "https://agentx.invalid"));
}

export async function retrySlackWorkflowReviews(dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, event: SlackWorkflowReviewRetryEvent) {
  // The same checks as every other Slack press: this Slack workspace, the task's owner, and the task's own thread.
  const { taskId, requestId, caller, developer } = await ownedSlackWorkflowTask(dependencies, event, "retry reviews");
  const routeDeps = slackWorkflowRouteDependencies(dependencies, tasks, developer, caller);
  const body = JSON.stringify({ requestId, expectedRevision: event.expectedRevision, candidateDigest: event.candidateDigest,
    instructions: "Retry the independent read-only code and security reviews on the same verified candidate. Do not edit files." });
  const path = `/v1/dev/tasks/${taskId}/workflow/review`;
  return routeDeveloperTaskRequest(routeDeps, caller, { method: "POST", path, headers: {}, requestId, body }, new URL(path, "https://agentx.invalid"));
}

export interface SlackWorkflowPublishRetryEvent {
  source: "agentx.slack-ingress";
  action: "workflow-publish-retry";
  taskId: string;
  userId: string;
  thread: SlackThread;
  requestId: string;
  expectedRevision: number;
}

export function isSlackWorkflowPublishRetryEvent(event: unknown): event is SlackWorkflowPublishRetryEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  return value.source === "agentx.slack-ingress" && value.action === "workflow-publish-retry" && value.requestContext === undefined
    && typeof value.taskId === "string" && typeof value.userId === "string" && typeof value.requestId === "string"
    && Number.isInteger(value.expectedRevision) && typeof value.thread === "object" && value.thread !== null;
}

/** Task 12: the owner's Retry opening the pull request, from the task's own thread. */
export async function retrySlackWorkflowPublication(dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, event: SlackWorkflowPublishRetryEvent) {
  // Ruling R60: a removed creator's task publishes nothing, so this refuses before the Slack checks and before any token is minted.
  const stored = await getItem<DeveloperTaskRecord>(dependencies, taskKey(event.taskId));
  if (stored !== undefined) await requireCreatorStillMember(creatorCheckOf(dependencies), stored);
  // The same checks as every other Slack press: this Slack workspace, the task's owner, and the task's own thread.
  const { taskId, requestId, caller, developer } = await ownedSlackWorkflowTask(dependencies, event, "retry opening the pull request");
  const routeDeps = slackWorkflowRouteDependencies(dependencies, tasks, developer, caller);
  const body = JSON.stringify({ requestId, expectedRevision: event.expectedRevision });
  const path = `/v1/dev/tasks/${taskId}/workflow/publish-retry`;
  return routeDeveloperTaskRequest(routeDeps, caller, { method: "POST", path, headers: {}, requestId, body }, new URL(path, "https://agentx.invalid"));
}

/** The owner's "Keep the pull request as it is" after an approved fix changed nothing, from the task's own thread. */
export interface SlackWorkflowKeepPullRequestsEvent {
  source: "agentx.slack-ingress";
  action: "workflow-keep-pull-requests";
  taskId: string;
  userId: string;
  thread: SlackThread;
  requestId: string;
  expectedRevision: number;
}

export function isSlackWorkflowKeepPullRequestsEvent(event: unknown): event is SlackWorkflowKeepPullRequestsEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  return value.source === "agentx.slack-ingress" && value.action === "workflow-keep-pull-requests" && value.requestContext === undefined
    && typeof value.taskId === "string" && typeof value.userId === "string" && typeof value.requestId === "string"
    && Number.isInteger(value.expectedRevision) && typeof value.thread === "object" && value.thread !== null;
}

/** Keep the pull request as it is, through the same route an AI tool uses. */
export async function keepSlackWorkflowPullRequests(dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, event: SlackWorkflowKeepPullRequestsEvent) {
  const { taskId, requestId, caller, developer } = await ownedSlackWorkflowTask(dependencies, event, "keep the pull request as it is");
  const routeDeps = slackWorkflowRouteDependencies(dependencies, tasks, developer, caller);
  const body = JSON.stringify({ requestId, expectedRevision: event.expectedRevision });
  const path = `/v1/dev/tasks/${taskId}/workflow/keep-pull-requests`;
  return routeDeveloperTaskRequest(routeDeps, caller, { method: "POST", path, headers: {}, requestId, body }, new URL(path, "https://agentx.invalid"));
}

export async function decideSlackWorkflow(dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, event: SlackWorkflowDecisionEvent) {
  // The same checks as every other Slack press: this Slack workspace, the task's owner, and the task's own thread.
  const { taskId, requestId, caller, developer } = await ownedSlackWorkflowTask(dependencies, event, "decide this plan");
  // QA6-12b: approving the coding plan accepts its run limit (by the approver's tier, asking for it when the tier is too low) and checks the amount the Approve button showed. That needs the model proxy
  // (the planning spend the new window starts from), the cloud edition and the agent wiring (the request for a higher tier's approval), as the HTTP routes have them; without them the press skipped the run limit entirely.
  const agents = agentRouteDependencies(dependencies, tasks);
  const routeDeps = slackWorkflowRouteDependencies(dependencies, tasks, developer, caller, {
    ...(dependencies.modelAccess === undefined ? {} : { modelAccess: dependencies.modelAccess.access }),
    ...(dependencies.cloud === true ? { cloud: true } : {}),
    ...(agents === undefined ? {} : { agents }),
  });
  const body = JSON.stringify({
    requestId, expectedRevision: event.expectedRevision, artifactDigest: event.artifactDigest,
    ...(event.decision === "APPROVE" && event.workBreakdownDigest !== undefined ? { workBreakdownDigest: event.workBreakdownDigest } : {}),
    ...(event.decision === "APPROVE" && event.acknowledgedRunLimitUsd !== undefined ? { acknowledgedRunLimitUsd: event.acknowledgedRunLimitUsd } : {}),
    decision: event.decision, reason: event.reason, selectedOptionalCheckIds: event.selectedOptionalCheckIds,
  });
  return routeDeveloperTaskRequest(routeDeps, caller, { method: "POST", path: `/v1/dev/tasks/${taskId}/workflow/decision`, headers: {}, requestId, body }, new URL(`/v1/dev/tasks/${taskId}/workflow/decision`, "https://agentx.invalid"));
}

export function isSlackWorkflowFeedbackFindingsDecisionEvent(event: unknown): event is SlackWorkflowFeedbackFindingsDecisionEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  return value.source === "agentx.slack-ingress" && value.action === "workflow-feedback-findings-decision" && value.requestContext === undefined
    && typeof value.taskId === "string" && typeof value.userId === "string" && typeof value.requestId === "string"
    && Number.isInteger(value.expectedRevision) && typeof value.reviewDigest === "string" && /^[a-f0-9]{64}$/.test(value.reviewDigest)
    && typeof value.proposalDigest === "string" && /^[a-f0-9]{64}$/.test(value.proposalDigest)
    && typeof value.bundleSetDigest === "string" && /^[a-f0-9]{64}$/.test(value.bundleSetDigest)
    && ((value.selection === "RECOMMENDED" && (value.decision === "APPROVE" || value.decision === "REQUEST_CHANGES" || value.decision === "DISMISS"))
      || (value.selection === "ANSWER" && value.decision === "APPROVE" && Array.isArray(value.questionFindingIds)
        && value.questionFindingIds.length >= 1 && value.questionFindingIds.length <= 3
        && value.questionFindingIds.every(id => typeof id === "string" && id.length > 0 && id.length <= 128)))
    && (value.selection === "ANSWER" || value.questionFindingIds === undefined)
    && (value.ownerNote === undefined || typeof value.ownerNote === "string");
}

export function isSlackWorkflowFeedbackNoteEvent(event: unknown): event is SlackWorkflowFeedbackNoteEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  return value.source === "agentx.slack-ingress" && value.action === "feedback-note" && value.requestContext === undefined
    && typeof value.taskId === "string" && typeof value.userId === "string" && typeof value.eventId === "string"
    && value.eventId.length > 0 && value.eventId.length <= 128 && typeof value.messageTs === "string"
    && typeof value.text === "string" && value.text.trim().length > 0 && value.text.trim().length <= 500
    && typeof value.thread === "object" && value.thread !== null;
}

export async function decideSlackWorkflowFeedbackFindings(dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, event: SlackWorkflowFeedbackFindingsDecisionEvent) {
  const { task, taskId, requestId, caller, developer } = await ownedSlackWorkflowTask(dependencies, event, "decide this PR feedback", true);
  const workflow = task.workflow;
  const review = workflow?.feedbackReview;
  const bundleDigests = review?.bundleRefs.map(bundle => bundle.sha256) ?? [];
  const bundleSetDigest = createHash("sha256").update(JSON.stringify(bundleDigests), "utf8").digest("hex");
  if (workflow?.revision !== event.expectedRevision || workflow.stage !== "WAIT_FOR_MERGE" || workflow.state !== "WAITING"
    || review?.status !== "PENDING" || review.reviewRef.sha256 !== event.reviewDigest || review.reviewRef.proposalDigest !== event.proposalDigest
    || bundleSetDigest !== event.bundleSetDigest) throw agentXError("CONFIG_INVALID", "this review changed; reopen the AgentX review details");
  if ((event.decision !== "APPROVE" || event.selection === "ANSWER")
    && (typeof event.ownerNote !== "string" || event.ownerNote.trim().length === 0 || event.ownerNote.trim().length > 500)) {
    throw agentXError("CONFIG_INVALID", event.selection === "ANSWER" ? "add your answer before sending it" : "add a short note before requesting changes");
  }
  const routeDeps = slackWorkflowRouteDependencies(dependencies, tasks, developer, caller);
  // A comment that arrived since the check above reset the review: say the approval is out of date, not that it was not saved.
  const view = await getWorkflowFeedbackReview(routeDeps, caller, taskId).catch((error: unknown) => {
    if (error instanceof AgentXError && error.code === "NOT_FOUND") throw agentXError("CONFIG_INVALID", "this review changed; reopen the AgentX review details");
    throw error;
  });
  const findings = Array.isArray(view.findings) ? view.findings as Array<Record<string, unknown>> : [];
  // An answer approves only the questions its card showed; the owner's words say how. Recommended fixes are approved apart.
  const ownerDecision = (finding: Record<string, unknown>) => finding.proposedDisposition === "OWNER_DECISION";
  const questionIds = [...new Set(event.questionFindingIds ?? [])];
  if (event.selection === "ANSWER") {
    if (!findings.some(ownerDecision)) throw agentXError("CONFIG_INVALID", "this review has no question to answer; reopen the AgentX review details");
    if (!questionIds.every(id => findings.some(finding => String(finding.id) === id && ownerDecision(finding)))) {
      throw agentXError("CONFIG_INVALID", "that question is no longer in this review; reopen the AgentX review details");
    }
  }
  const selectedFindingIds = event.decision !== "APPROVE" ? [] : event.selection === "ANSWER" ? questionIds
    : findings.filter(finding => finding.recommended === true).map(finding => String(finding.id));
  return submitWorkflowFeedbackDecision(routeDeps, caller, taskId, {
    requestId, expectedRevision: event.expectedRevision, reviewDigest: event.reviewDigest, proposalDigest: event.proposalDigest,
    bundleDigests, decision: event.decision, selectedFindingIds, ...(event.ownerNote === undefined ? {} : { ownerNote: event.ownerNote.trim() }),
  });
}

/** The owner's Retry review on a failed PR feedback review's card, from the task's own thread. */
export interface SlackWorkflowFeedbackReviewRetryEvent {
  source: "agentx.slack-ingress"; action: "workflow-feedback-review-retry";
  taskId: string; userId: string; thread: SlackThread; requestId: string; reviewDigest: string;
}

export function isSlackWorkflowFeedbackReviewRetryEvent(event: unknown): event is SlackWorkflowFeedbackReviewRetryEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  return value.source === "agentx.slack-ingress" && value.action === "workflow-feedback-review-retry" && value.requestContext === undefined
    && typeof value.taskId === "string" && typeof value.userId === "string" && typeof value.requestId === "string"
    && typeof value.reviewDigest === "string" && /^[a-f0-9]{64}$/.test(value.reviewDigest)
    && typeof value.thread === "object" && value.thread !== null;
}

export async function retrySlackWorkflowFeedbackReview(dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, event: SlackWorkflowFeedbackReviewRetryEvent) {
  // The same checks as every other Slack press: this Slack workspace, the task's owner, and the task's own thread.
  const { taskId, developer, caller } = await ownedSlackWorkflowTask(dependencies, event, "retry this review", true);
  const routeDeps = slackWorkflowRouteDependencies(dependencies, tasks, developer, caller);
  return retryTaskWorkflowFeedbackReview(routeDeps, caller, taskId, { reviewDigest: event.reviewDigest });
}

export async function captureSlackWorkflowFeedbackNote(dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, event: SlackWorkflowFeedbackNoteEvent) {
  if (dependencies.developer === undefined) throw agentXError("NOT_FOUND", "developer task workflows are not configured");
  const thread = SlackThreadSchema.parse(event.thread);
  const userId = SlackRequesterSchema.shape.userId.parse(event.userId);
  const taskId = randomUUIDSchema.parse(event.taskId);
  if (dependencies.developer.slackTeamId !== thread.teamId) throw agentXError("FORBIDDEN", "Slack workspace is not enabled for developer tasks");
  const shared = await getItem<{ taskId?: string; mode?: string; closedAt?: string }>(dependencies, sharedTaskKey(thread));
  if (shared?.taskId !== taskId || shared.closedAt !== undefined) throw agentXError("FORBIDDEN", "this Slack thread is not linked to the task");
  let caller: DeveloperCaller;
  let routeDeps: ReturnType<typeof developerTaskRouteDependencies>;
  let access: TaskAccess;
  try { ({ caller, routeDeps, access } = await slackTaskAccess(dependencies, tasks, taskId, userId, "feedback", true)); }
  catch { throw agentXError("FORBIDDEN", "only a current task owner can add a note in this PR review"); }
  if (access.task.share?.teamId !== thread.teamId || access.task.share.channelId !== thread.channelId || access.task.share.threadTs !== thread.threadTs) {
    throw agentXError("FORBIDDEN", "this PR feedback belongs to another Slack thread");
  }
  return captureWorkflowFeedbackNote(routeDeps, caller, taskId, event);
}

export interface SlackThreadNoteEvent {
  source: "agentx.slack-ingress"; action: "thread-note"; taskId: string; userId: string; thread: SlackThread;
  eventId: string; messageTs: string; text: string;
}

export function isSlackThreadNoteEvent(event: unknown): event is SlackThreadNoteEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  return value.source === "agentx.slack-ingress" && value.action === "thread-note" && value.requestContext === undefined
    && typeof value.taskId === "string" && typeof value.userId === "string" && typeof value.eventId === "string"
    && value.eventId.length > 0 && value.eventId.length <= 128 && typeof value.messageTs === "string"
    && typeof value.text === "string" && value.text.trim().length > 0
    && typeof value.thread === "object" && value.thread !== null;
}

/**
 * Gap 2: a reply anyone posted in a Slack-started task's own thread, saved as input for the task's next step.
 * Every expected answer (saved, already saved, or not saved because the thread or task no longer takes notes)
 * is a 200 with its outcome, so Slack is never asked to retry it.
 */
/** What a person hears (privately, in the thread) when their reply to Rovara's questions is too long or says nothing. */
const SLACK_ANSWER_REFUSED = "I couldn't take that as an answer. Keep it under 2,000 characters and reply again.";
/** A stable id for a Slack message's refusal, so the same message is told once. */
const refusalIdOf = (taskId: string, messageTs: string): string => {
  const bytes = createHash("sha256").update(`answer-refusal\n${taskId}\n${messageTs}`, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** Whether `caller` has "can use" on the task's session in their org, by the same check the app route runs (level, org, project role). Any failure to tell is a no. */
export async function mayAnswerFromSlack(dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, caller: DeveloperCaller, task: DeveloperTaskRecord): Promise<boolean> {
  const sessions = agentRouteDependencies(dependencies, tasks)?.agentSessions;
  if (sessions === undefined || task.sessionId === undefined || task.orgId !== caller.orgId) return false;
  try {
    await requireSessionLevel(sessions, caller, task.sessionId, "use", "answer its questions");
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether (and with which People revision) `userId` is a PROJECT-ROLE VIEWER of the task's project in the task's own org and the task's own open thread: the one person the Ask switch lets ask though they cannot comment. Everyone
 * else the note-save step refuses stays refused: a removed, banned or other-org person (`slackCallerFor` throws), a person the task's People list denies, a person of another org than the task's.
 */
async function projectViewerInThread(dependencies: AwsBrokerDependencies, taskId: string, userId: string, thread: SlackThread): Promise<{ peopleRevision?: number } | undefined> {
  try {
    if (dependencies.developer === undefined) return undefined;
    const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(taskId));
    if (task === undefined || task.closedAt !== undefined || task.workflow === undefined || task.share?.teamId !== thread.teamId || task.share.channelId !== thread.channelId || task.share.threadTs !== thread.threadTs) return undefined;
    const caller = await slackCallerFor(dependencies, userId, dependencies.developer.slackTeamId ?? "");
    if (task.orgId !== caller.orgId) return undefined;
    const sidecar = await getItem<Record<string, unknown>>(dependencies, { pk: `DEVTASK#${taskId}`, sk: "PEOPLE" });
    const people = peopleOfItem(sidecar);
    // A list that cannot be read is not guessed at; a person the list denies is not asked about.
    if (people === "unreadable" || (people !== undefined && people.get(caller.developerId) === "denied")) return undefined;
    if (grantRoleOf(await getMembership(dependencies, caller.orgId, caller.developerId, task.project)) !== "viewer") return undefined;
    return typeof sidecar?.revision === "number" ? { peopleRevision: sidecar.revision } : {};
  } catch {
    return undefined;
  }
}

export async function recordSlackThreadNote(dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, event: SlackThreadNoteEvent): Promise<{ outcome: "captured" | "duplicate" | "refused"; askOnly?: true }> {
  if (dependencies.developer === undefined) return { outcome: "refused" };
  const thread = SlackThreadSchema.safeParse(event.thread);
  const userId = SlackRequesterSchema.shape.userId.safeParse(event.userId);
  const taskId = event.taskId;
  const messageTs = SlackMessageTimestampSchema.safeParse(event.messageTs);
  if (!thread.success || !userId.success || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId) || !messageTs.success || dependencies.developer.slackTeamId !== thread.data.teamId) return { outcome: "refused" };
  const shared = await getItem<{ taskId?: string; workflowThread?: unknown; closedAt?: string }>(dependencies, sharedTaskKey(thread.data));
  if (shared === undefined || shared.taskId !== taskId || shared.workflowThread !== true || shared.closedAt !== undefined) return { outcome: "refused" };
  let access: TaskAccess;
  let actor: DeveloperCaller;
  try { ({ access, caller: actor } = await slackTaskAccess(dependencies, tasks, taskId, userId.data, "comment", true)); }
  catch {
    // Owner decision 2026-11-01, Ask switch ON only: a project viewer in the task's own thread may ask. Their message is kept already answered (so the next step never reads it) and the question goes on to
    // the Ask route. With the switch off, or for anyone else (removed, banned, other org, denied), nothing changes: refused.
    const viewer = dependencies.slackAsk?.ask === undefined ? undefined : await projectViewerInThread(dependencies, taskId, userId.data, thread.data);
    if (viewer === undefined) return { outcome: "refused" };
    const result = await recordWorkflowThreadNote({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, actions: tasks, now: Date.now },
      { taskId, thread: thread.data, userId: userId.data, messageTs: messageTs.data, eventId: event.eventId, text: event.text, peopleAccess: { ...(viewer.peopleRevision === undefined ? {} : { peopleRevision: viewer.peopleRevision }), isOwner: false } }, { preAnswered: true });
    // `askOnly` tells the ingress to send it on as a question only, never as a possible instruction.
    return result.outcome === "captured" ? { ...result, askOnly: true } : result;
  }
  if (access.task.share?.teamId !== thread.data.teamId || access.task.share.channelId !== thread.data.channelId
    || access.task.share.threadTs !== thread.data.threadTs) return { outcome: "refused" };
  const author = await slackReplyAuthor(dependencies, new DeveloperSignInStore({ documentClient: dependencies.documentClient, tableName: dependencies.developer.signInTableName, nameTableName: dependencies.tableName, now: Date.now }), access.task, userId.data, actor);
  // Plan 6 Task 5: a reply answers Understand's questions only from a person who has "can use" on the task's session in this org, judged live the way the app route judges it (the project
  // role included). It is recorded under that person, whoever owns the task.
  const waiting = access.task.workflow?.stage === "UNDERSTAND" && access.task.workflow.state === "WAITING";
  // Who the Slack user is in this org: the task's effective owner when the Slack user is theirs, else the member the Slack user maps to (merges followed).
  const effectiveOwner = tryEffectiveTaskOwner(access.task);
  const replier = { developerId: effectiveOwner?.slackUserId === userId.data ? effectiveOwner.developerId : author.developerId, name: author.name };
  const mayAnswer = waiting && await mayAnswerFromSlack(dependencies, tasks, { ...actor, developerId: replier.developerId }, access.task);
  const result = await recordWorkflowThreadNote({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, actions: tasks, now: Date.now },
    { taskId, thread: thread.data, userId: userId.data, messageTs: messageTs.data, eventId: event.eventId, text: event.text,
      peopleAccess: { ...(access.peopleRevision === undefined ? {} : { peopleRevision: access.peopleRevision }), isOwner: access.role === "owner" },
      actor: author, ...(mayAnswer ? { answerBy: replier } : {}) });
  // A reply that could have answered but could not be taken as one is told to the person who wrote it, privately in the thread.
  if (result.outcome === "refused" && mayAnswer) await recordSlackWorkflowRefusal(dependencies, { taskId, userId: userId.data, thread: thread.data, requestId: refusalIdOf(taskId, messageTs.data) }, SLACK_ANSWER_REFUSED, "reply");
  // Plan 6 Task 5: an owner's reply that answered Understand's questions made the next Understand run due: it starts now, and the sweep starts it if this is lost.
  if (result.outcome === "captured" && access.task.workflow?.stage === "UNDERSTAND" && access.task.workflow.state === "WAITING") await dispatchWorkflowContinuation(dependencies, taskId);
  // The PR feedback review page keeps showing the owner's own replies, as before (best effort).
  if (result.outcome === "captured") {
    const task = access.task;
    if (access.role === "owner" && task.workflow?.stage === "WAIT_FOR_MERGE" && task.workflow.feedbackReview?.status === "PENDING") {
      try {
        await captureSlackWorkflowFeedbackNote(dependencies, tasks, { ...event, action: "feedback-note" });
      } catch (error) {
        console.log(JSON.stringify({ component: "broker", event: "slack.thread_note_feedback_failed", taskId, errorName: error instanceof Error ? error.name : "unknown" }));
      }
    }
  }
  return result;
}

export function isSlackStopTaskEvent(event: unknown): event is SlackStopTaskEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  // API Gateway always sets requestContext, so a request from outside can never take this path.
  return value.source === "agentx.slack-ingress" && value.action === "stop-task" && value.requestContext === undefined;
}

export async function stopSlackThreadTask(dependencies: AwsBrokerDependencies, event: SlackStopTaskEvent): Promise<TaskCancellation | { outcome: "NOT_OWNER" } | { outcome: "NOT_A_MEMBER" }> {
  const thread = SlackThreadSchema.parse(event.thread);
  const requester = SlackRequesterSchema.parse({ teamId: thread.teamId, userId: event.userId });
  const teamOrg = await slackTeamOrg(dependencies, thread.teamId);
  // Enterprise foundations I-6: whoever stops a task through Slack must still be allowed by the company sign-in, in every branch below.
  await requireSlackAllowedByEdition(dependencies, requester.userId, teamOrg);
  // Slack explicit membership (0.5.14, switch `sm`): the legacy teammate stop (a shared thread with no People record, a plain thread workspace) used to let anyone in the thread stop a task. With the switch on,
  // on a cloud install, the person must be an explicit, current member, as for every other Slack entry point; otherwise they are told so, as a private notice, and nothing is stopped. The "warn" and "0" values
  // leave this path exactly as it was.
  if (dependencies.orgResolver !== undefined && slackMemberRule() === "require") {
    try { await requireSlackRequesterWriterRole(dependencies, requester.userId, teamOrg, { allowUnlinked: true }); }
    catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code !== "SLACK_ACCOUNT_NOT_LINKED" && code !== "REMOVED_FROM_ORG") throw error;
      return { outcome: "NOT_A_MEMBER" };
    }
  }
  const binding = await getSlackBinding(dependencies, teamOrg, thread.teamId, thread.channelId);
  if (!binding) throw agentXError("FORBIDDEN", "Slack channel is not bound to a project");
  // Spec 043 FR-005: a thread running a SWE-bench run stops the run.
  if (dependencies.swebench !== undefined) {
    const runId = await stopSwebenchRun(swebenchDependencies(dependencies), thread, requester);
    if (runId !== undefined) return { outcome: "CANCEL_REQUESTED", workspaceId: runId, targetOperationId: runId, cancelOperationId: runId };
  }
  // Q8: in a continue thread a teammate's stop cancels the task's running task operation, whoever
  // started it, as the developer's own cancel would. A view-only or closed thread, or one whose
  // channel now serves another project (F16), stops nothing.
  const shared = await sharedThread(dependencies, thread);
  // A task started in Slack is driven from its own thread, and only its owner stops it there.
  if (shared?.workflowThread === true) {
    if (shared.closedAt !== undefined || binding.projectName !== shared.project) return { outcome: "NOTHING_RUNNING" };
    if (dependencies.developer === undefined) return { outcome: "NOT_OWNER" };
    let access: TaskAccess;
    try { ({ access } = await slackTaskAccess(dependencies, developerTaskActions(dependencies), shared.taskId, requester.userId, "control", true)); }
    catch { return { outcome: "NOT_OWNER" }; }
    if (access.task.share?.teamId !== thread.teamId || access.task.share.channelId !== thread.channelId || access.task.share.threadTs !== thread.threadTs) return { outcome: "NOT_OWNER" };
    const workspace = await requireWorkspace(dependencies, shared.workspaceId);
    if (workspace.ownerKey !== shared.ownerKey) throw agentXError("FORBIDDEN", "workspace does not belong to this task");
    return cancelRunningTask(dependencies, workspace, { requestedBy: requester }, () => [taskAccessFence(dependencies.tableName, shared.taskId, access.peopleRevision)]);
  }
  if (shared !== undefined) {
    if (!sharedThreadOpen(shared, binding)) return { outcome: "NOTHING_RUNNING" };
    const { task, workspace } = await verifiedSharedStopBinding(dependencies, thread, binding, shared);
    // A strongly read absence preserves FR-054's verified legacy teammate stop. Any present or
    // unreadable sidecar stays under current People authorization; only the transaction fence below
    // can turn the observed absence into a cancellation.
    const people = await getItem<Record<string, unknown>>(dependencies, { pk: `DEVTASK#${task.taskId}`, sk: "PEOPLE" });
    if (people === undefined) {
      return cancelRunningTask(dependencies, workspace, { requestedBy: requester },
        sharedStopFences(dependencies, thread, shared, task, workspace, undefined));
    }
    if (dependencies.developer === undefined) return { outcome: "NOT_OWNER" };
    let access: TaskAccess;
    try { ({ access } = await slackTaskAccess(dependencies, developerTaskActions(dependencies), task.taskId, requester.userId, "control", true)); }
    catch { return { outcome: "NOT_OWNER" }; }
    if (access.peopleRevision === undefined || access.task.share?.teamId !== thread.teamId
      || access.task.share.channelId !== thread.channelId || access.task.share.threadTs !== thread.threadTs) return { outcome: "NOT_OWNER" };
    return cancelRunningTask(dependencies, workspace, { requestedBy: requester },
      sharedStopFences(dependencies, thread, shared, task, workspace, access.peopleRevision));
  }
  const orgId = await slackTeamOrg(dependencies, thread.teamId);
  const ownerKey = ownerKeyForSubject(SLACK_THREAD_OWNER_ISSUER, slackThreadSubject(thread));
  const record = await getItem<{ workspaceId?: string; closedAt?: string }>(dependencies, await resolveSlackThreadKey(dependencies, orgId, ownerKey));
  if (typeof record?.workspaceId !== "string" || record.closedAt !== undefined) return { outcome: "NOTHING_RUNNING" };
  const workspace = await requireWorkspace(dependencies, record.workspaceId);
  if (workspace.ownerKey !== ownerKey || (workspace.orgId ?? installOrgId(dependencies)) !== orgId) throw agentXError("FORBIDDEN", "workspace does not belong to this thread");
  return cancelRunningTask(dependencies, workspace, { requestedBy: requester });
}
