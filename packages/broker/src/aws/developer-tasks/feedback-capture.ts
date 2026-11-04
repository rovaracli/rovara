import { createHash, randomUUID } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  AgentXError,
  SlackMessageTimestampSchema,
  SlackThreadSchema,
  SlackUserIdSchema,
  agentXError,
  type WorkspaceInstance,
  type WorkflowSnapshot,
  WorkflowFeedbackNoteSchema,
  WorkflowTransitionError,
  retryWorkflowFeedbackReview,
} from "@agentx/contracts";
import { aiToolTurn, developerTaskIdentity, partyOfTask, taskKey, taskOwnerKey, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { isConditional } from "../broker-shared.js";
import type { DeveloperCaller } from "../developer-routes.js";
import { requireProjectSendBackRole, type TaskAccess } from "../../developer/task-access.js";
import { stopIfOwnerRefused } from "./owner-stop.js";
import type { DeveloperTaskRouteDependencies } from "./types.js";
import { creatorGuard, get, iso, partyOfTaskActor, taskBaseOption, turnTable } from "./common.js";
import { accessFence, authorizeTaskAction, authorizeTaskActor, systemTaskAccess } from "./access.js";
import { actionableWorkspace } from "./task-window.js";

/** A linked PR event may enqueue a read-only critic only for the exact current COLLECTING snapshot. */
export async function startTaskWorkflowFeedbackReviewFromWebhook(
  deps: DeveloperTaskRouteDependencies,
  taskId: string,
): Promise<boolean> {
  const task = await get<DeveloperTaskRecord>(deps, taskKey(taskId));
  const workflow = task?.workflow;
  if (task === undefined || task.closedAt !== undefined || workflow === undefined || workflow.stage !== "WAIT_FOR_MERGE"
    || workflow.state !== "WAITING" || workflow.candidate === undefined || workflow.feedbackReview?.status !== "COLLECTING") return false;
  await creatorGuard(deps, task);
  const access = await systemTaskAccess(deps, task);
  // S2: the critic run spends model money for the task's owner, so it meets the send-back's project access rule too; refused, it is not started, the task says why, and it is audited.
  if (await stopIfOwnerRefused(deps, task, workflow, "feedback_review")) return false;
  return acceptFeedbackReview(deps, task, workflow, workflow, access);
}

/**
 * Starts the read-only critic on `collecting` (a COLLECTING snapshot waiting for merge) in one transaction with the task
 * write, conditioned on the task still being exactly `stored`: either the review started and the task is RUNNING, or
 * nothing changed. False when the workspace cannot take it now.
 */
async function acceptFeedbackReview(
  deps: DeveloperTaskRouteDependencies,
  task: DeveloperTaskRecord,
  stored: WorkflowSnapshot,
  collecting: WorkflowSnapshot,
  access?: TaskAccess,
  actor?: DeveloperCaller,
): Promise<boolean> {
  if (task.closedAt !== undefined || collecting.candidate === undefined || collecting.feedbackReview?.status !== "COLLECTING") return false;
  const workspace = await deps.actions.workspace(task.workspaceId);
  if (!feedbackReviewWorkspaceReady(task, workspace)) return false;
  const taskId = task.taskId;
  const now = iso(deps);
  const next: WorkflowSnapshot = { ...collecting, revision: collecting.revision + 1, state: "RUNNING", updatedAt: now };
  const binding = { taskId, workflowRevision: next.revision, candidateDigest: collecting.candidate.digest };
  const requestId = randomUUID();
  await creatorGuard(deps, task);
  try {
    await deps.actions.acceptTask(developerTaskIdentity(task, deps.orgId), task.workspaceId, {
      requestId, conversationId: task.conversationId,
      prompt: "Review the current linked pull request feedback against the exact candidate. Produce a read-only, evidence-backed proposal. Do not edit code or send replies.",
    }, operation => [
      { Update: {
        TableName: deps.tableName, Key: taskKey(taskId),
        UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
        ConditionExpression: "workflow.revision = :revision AND workflow.#stage = :stage AND workflow.#state = :waiting AND workflow.feedbackReview.#status = :status AND workflow.candidate.digest = :candidate AND attribute_not_exists(closedAt)",
        ExpressionAttributeNames: { "#stage": "stage", "#state": "state", "#status": "status" },
        ExpressionAttributeValues: { ":workflow": next, ":now": now, ":revision": stored.revision, ":stage": "WAIT_FOR_MERGE", ":waiting": "WAITING",
          ":status": stored.feedbackReview?.status ?? "COLLECTING", ":candidate": binding.candidateDigest },
      } },
      { Put: { TableName: turnTable(deps), Item: aiToolTurn({
        party: actor === undefined ? partyOfTask(task) : partyOfTaskActor(task, actor), turnId: randomUUID(), action: "continue", phase: "accepted", outcome: "accepted", receivedAt: now, finishedAt: iso(deps),
        request: "Review linked PR feedback", response: "Read-only PR feedback review started as operation " + operation.id + ".", operationId: operation.id,
      }), ConditionExpression: "attribute_not_exists(pk)" } },
      ...(access === undefined ? [] : [accessFence(deps, access)]),
    ], { sharedTask: task.shared === true, workflowMode: "FEEDBACK_REVIEW", workflowFeedbackReview: binding, ...taskBaseOption(task, next) });
    return true;
  } catch (error) {
    if (error instanceof AgentXError && ["WORKSPACE_BUSY", "WORKSPACE_NOT_READY", "IDEMPOTENCY_CONFLICT"].includes(error.code)) return false;
    throw error;
  }
}

/** The task's own workspace, idle: the only one a feedback review can start on. */
function feedbackReviewWorkspaceReady(task: DeveloperTaskRecord, workspace: WorkspaceInstance): boolean {
  return workspace.ownerKey === taskOwnerKey(task.developerId, task.taskId) && ["READY", "STOPPED"].includes(workspace.status);
}

/** Said to the owner when Retry review no longer matches the task. */
const FEEDBACK_REVIEW_RETRY_STALE = "this review changed; use the latest AgentX message";
/** Said to the owner when Retry review meets a workspace that cannot start the review now; nothing changed. */
export const FEEDBACK_REVIEW_RETRY_BUSY = "AgentX is busy on this task; try Retry review again in a minute.";
/** Said to the owner when Retry review lost to another change of the task (another press started the review): a new card follows. */
export const FEEDBACK_REVIEW_RETRY_CHANGED = "This review changed; a new card is coming.";
/** Said privately to the owner once the retried review has started. */
const FEEDBACK_REVIEW_RETRY_STARTED = "Reviewing the feedback again.";

/**
 * The owner's Retry review of a PR feedback review that failed, timed out or was interrupted: the same comments are
 * reviewed again. The workspace is checked first, and the review goes back to collection and starts in one write, so a
 * retry that cannot start changes nothing (the card keeps its button) and is refused as busy. A press for a report that
 * was already replaced changes nothing, except that a retry left collecting is started now. `note` is said privately
 * to the owner only when a review started.
 */
export async function retryTaskWorkflowFeedbackReview(
  deps: DeveloperTaskRouteDependencies,
  caller: DeveloperCaller,
  taskId: string,
  input: { reviewDigest: string },
): Promise<{ started: boolean; note?: string }> {
  const access = await authorizeTaskAction(deps, caller, taskId, "feedback");
  const { task } = access;
  // S2: Retry review starts a model run for this person, so it meets the send-back's project access rule and the archive check.
  await requireProjectSendBackRole(deps, task, caller);
  const current = task.workflow;
  if (current === undefined) throw agentXError("CONFIG_INVALID", FEEDBACK_REVIEW_RETRY_STALE);
  const workspace = await actionableWorkspace(deps, task);
  const review = current.feedbackReview;
  if (review?.reviewRef?.sha256 !== input.reviewDigest
    && current.feedbackReviewHistory?.some(ref => ref.sha256 === input.reviewDigest && ref.status !== "COMPLETE")) {
    // Already retried: a review still collecting (never started) is started now; one running or done is left alone.
    if (review?.status !== "COLLECTING" || current.state !== "WAITING") return { started: false };
    if (!feedbackReviewWorkspaceReady(task, workspace)) throw agentXError("CONFIG_INVALID", FEEDBACK_REVIEW_RETRY_BUSY);
    if (!await acceptFeedbackReview(deps, task, current, current, access, caller)) {
      await authorizeTaskActor(deps, caller, taskId, "feedback");
      throw await feedbackRetryRefusal(deps, task, current);
    }
    return { started: true, note: FEEDBACK_REVIEW_RETRY_STARTED };
  }
  let collecting: WorkflowSnapshot;
  try {
    collecting = retryWorkflowFeedbackReview(current, { reviewDigest: input.reviewDigest, actor: { actorId: access.actorId, role: "TASK_OWNER" }, now: iso(deps) }, access.authority);
  } catch (error) {
    if (error instanceof WorkflowTransitionError) throw agentXError("CONFIG_INVALID", FEEDBACK_REVIEW_RETRY_STALE);
    throw error;
  }
  if (!feedbackReviewWorkspaceReady(task, workspace)) throw agentXError("CONFIG_INVALID", FEEDBACK_REVIEW_RETRY_BUSY);
  if (!await acceptFeedbackReview(deps, task, current, collecting, access, caller)) {
    await authorizeTaskActor(deps, caller, taskId, "feedback");
    throw await feedbackRetryRefusal(deps, task, current);
  }
  return { started: true, note: FEEDBACK_REVIEW_RETRY_STARTED };
}

/**
 * Why a retry that found the workspace idle still could not start: the task is gone or closed (the press is out of date,
 * and no card is coming), the task changed under it (another press won and started the review, so its new card is
 * coming), or else the workspace really became busy.
 */
async function feedbackRetryRefusal(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord, read: WorkflowSnapshot): Promise<AgentXError> {
  const latest = await get<DeveloperTaskRecord>(deps, taskKey(task.taskId));
  if (latest === undefined || latest.closedAt !== undefined) return agentXError("CONFIG_INVALID", FEEDBACK_REVIEW_RETRY_STALE);
  return agentXError("CONFIG_INVALID", latest.workflow?.revision !== read.revision ? FEEDBACK_REVIEW_RETRY_CHANGED : FEEDBACK_REVIEW_RETRY_BUSY);
}

function slackEventRequestId(eventId: string): string {
  const digest = createHash("sha256").update(`agentx-slack-feedback-note:${eventId}`, "utf8").digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/** Persist an owner's short signed Slack reply as input only; it never submits a decision or starts work. */
export async function captureWorkflowFeedbackNote(
  deps: DeveloperTaskRouteDependencies,
  caller: DeveloperCaller,
  taskId: string,
  input: { thread: unknown; userId: string; eventId: string; messageTs: string; text: string },
): Promise<{ captured: boolean; duplicate?: boolean }> {
  const thread = SlackThreadSchema.parse(input.thread);
  const userId = SlackUserIdSchema.parse(input.userId);
  const messageTs = SlackMessageTimestampSchema.parse(input.messageTs);
  const eventId = input.eventId.trim();
  if (!eventId || eventId.length > 128 || input.text.trim().length === 0 || input.text.trim().length > 500
    || Buffer.byteLength(input.text.trim(), "utf8") > 1_000) throw agentXError("CONFIG_INVALID", "Slack feedback note is empty or too long");
  const requestId = slackEventRequestId(eventId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const access = await authorizeTaskActor(deps, caller, taskId, "feedback");
    const { task } = access;
    if (caller.slackUserId !== userId
      || task.share?.teamId !== thread.teamId || task.share.channelId !== thread.channelId || task.share.threadTs !== thread.threadTs) {
      throw agentXError("FORBIDDEN", "only the task owner may add a note in this task thread");
    }
    const current = task.workflow;
    if (current?.stage !== "WAIT_FOR_MERGE" || current.state !== "WAITING" || current.feedbackReview?.status !== "PENDING") {
      return { captured: false };
    }
    const prior = current.feedbackNotes?.find(note => note.requestId === requestId || note.slack?.eventId === eventId);
    if (prior !== undefined) {
      if (prior.slack?.eventId !== eventId || prior.slack.userId !== userId || prior.slack.threadTs !== thread.threadTs || prior.text !== input.text.trim()) {
        throw agentXError("IDEMPOTENCY_CONFLICT", "this Slack reply event was already used");
      }
      return { captured: true, duplicate: true };
    }
    if ((current.feedbackNotes?.length ?? 0) >= 100) throw agentXError("RUNTIME_UNAVAILABLE", "the feedback note limit has been reached");
    const now = iso(deps);
    const note = WorkflowFeedbackNoteSchema.parse({
      schemaVersion: 1, requestId, actorId: access.actorId, source: "THREAD_REPLY", sourceId: eventId,
      text: input.text.trim(), at: now,
      slack: { teamId: thread.teamId, channelId: thread.channelId, threadTs: thread.threadTs, userId, messageTs, eventId },
    });
    const next = { ...current, revision: current.revision + 1, feedbackNotes: [...(current.feedbackNotes ?? []), note], updatedAt: now };
    try {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [{ Update: {
        TableName: deps.tableName, Key: taskKey(taskId), UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
        ConditionExpression: "workflow.revision = :revision AND workflow.feedbackReview.#status = :pending AND attribute_not_exists(closedAt)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":workflow": next, ":now": now, ":revision": current.revision, ":pending": "PENDING" },
      } }, accessFence(deps, access)] }));
      return { captured: true };
    } catch (error) {
      if (!isConditional(error)) throw error;
    }
  }
  throw agentXError("RUNTIME_UNAVAILABLE", "the feedback note could not be saved");
}
