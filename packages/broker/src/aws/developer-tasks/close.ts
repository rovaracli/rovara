import { randomUUID } from "node:crypto";
import { refuseReplayCopy } from "../../developer/eval-copy.js";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  AgentXError,
  CLOSE_MESSAGES,
  DeveloperPullRequestRequestSchema,
  DeveloperTaskCloseRequestSchema,
  PullRequestResultSchema,
  WorkspaceClosePreflightResultSchema,
  agentXError,
  sharedTaskKey,
  workspaceSessionKey,
  type DeveloperCloseResponse,
  type DeveloperPullRequestResponse,
  type Operation,
} from "@agentx/contracts";
import { releaseConflict, releaseItems } from "../../developer/limits.js";
import {
  aiToolTurn,
  developerTaskIdentity,
  partyOfTask,
  taskIndexKey,
  taskAgentRunKey,
  taskKey,
  type DeveloperTaskRecord,
} from "../../developer/task-records.js";
import { GATED_TASK_PULL_REQUEST_REFUSAL, isConditional } from "../broker-shared.js";
import type { DeveloperTaskActions, TransactItems } from "../developer-task-actions.js";
import type { DeveloperCaller } from "../developer-routes.js";
import { cancelAgentRun, type AgentRunEngineDependencies } from "../../agents/run-engine.js";
import { hasTaskEndHandlers, onTaskEnded, onTaskPaused, type TaskEndOutcome } from "../../agents/task-end.js";
import { leaveTaskEndRow } from "../task-end-row.js";
import type { DeveloperTaskRouteDependencies } from "./types.js";
import { creatorGuard, get, iso, log, parse, partyOfTaskActor, putNew, turnTable } from "./common.js";
import { type AuthorizedTask, accessFence, authorizeLegacyTaskAction, authorizeTaskAction, authorizeTaskActor } from "./access.js";
import { type WorkspaceReads, taskView, unpublishedOf, workspaceReads } from "./task-view.js";
import { ownerIndexRowOf, syncIndex } from "./task-index.js";
import { actionableWorkspace, busy, busyOrClosing } from "./task-window.js";
import { outcomeDepsOf, settleTaskOutcomes } from "../../rovara-code/outcome-hooks.js";
import { requireProjectSendBackRole } from "../../developer/task-access.js";
import { releaseFailedCancelWorkspace } from "../failed-cancel-release.js";
import { wakeAgentRun } from "../agent-run-wakeup.js";
import { blockStoppedWorkflowRun, type StoppedRunOperation } from "../workflow-cancel-reconcile.js";

/**
 * R22. A repeated requestId returns the same operation, except once the task is closed: the closed
 * check comes first, so a repeat after the close answers "this task is closed" like any new call.
 */
export async function openPullRequest(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, value: unknown): Promise<DeveloperPullRequestResponse> {
  const request = parse(DeveloperPullRequestRequestSchema, value, deps, "pull-request");
  const access = await authorizeLegacyTaskAction(deps, caller, taskId, "publish");
  const { task } = access;
  refuseReplayCopy(task);
  await creatorGuard(deps, task);
  // Task 12: the workflow opens its own draft of the checked code; MCP and Slack follow it, nobody opens another.
  if (task.workflow !== undefined) throw agentXError("CONFIG_INVALID", GATED_TASK_PULL_REQUEST_REFUSAL);
  const turns = turnTable(deps);
  const workspace = await actionableWorkspace(deps, task);
  let repository = request.repository;
  if (repository === undefined) {
    // The revision the workspace was prepared from, which the publication pushes from: a
    // repository a newer revision added is not in this workspace.
    const pinned = await deps.actions.projectRevision(deps.orgId, workspace.projectName, workspace.projectRevision);
    if (pinned === undefined) throw agentXError("CONFIG_INVALID", "this task's project revision is no longer registered; ask an admin");
    const repositories = pinned.definition.repositories.map((entry) => entry.name);
    if (repositories.length > 1) throw agentXError("CONFIG_INVALID", `this project has several repositories; name one of: ${repositories.join(", ")}`);
    if (repositories.length === 0) throw agentXError("CONFIG_INVALID", `project \`${task.project}\` has no repositories; ask an admin`);
    repository = repositories[0]!;
  }
  // S2 (any path): opening the pull request is a worker run started for this person, so it meets the send-back's project access rule and the archive check.
  await requireProjectSendBackRole(deps, task, caller);
  const receivedAt = iso(deps);
  let accepted: Awaited<ReturnType<DeveloperTaskActions["acceptPullRequest"]>>;
  try {
    // R22: answers at once. A repeated requestId returns the same operation and writes nothing.
    accepted = await deps.actions.acceptPullRequest(developerTaskIdentity(task, deps.orgId), task.workspaceId, {
      requestId: request.requestId, repository, title: request.title, draft: request.draft,
      ...(request.body === undefined ? {} : { body: request.body }),
    }, (operation) => [
      putNew(turns, aiToolTurn({
        party: partyOfTaskActor(task, caller), turnId: randomUUID(), action: "pull_request", phase: "accepted", outcome: "accepted", receivedAt, finishedAt: iso(deps),
        request: `${request.title}\n\n${request.body ?? ""}`, response: `Opening a pull request on ${repository} as operation ${operation.id}.`, operationId: operation.id,
      })),
      accessFence(deps, access),
    ]);
  } catch (error) {
    if (isConditional(error)) await authorizeTaskAction(deps, caller, taskId, "publish");
    return busyOrClosing(deps, task, error);
  }
  const published = PullRequestResultSchema.safeParse(accepted.operation.result);
  const pullRequest = accepted.operation.status === "SUCCEEDED" && published.success
    ? { repository: published.data.repository, number: published.data.number, url: published.data.url, state: "open" as const }
    : undefined;
  const view = await taskView(deps, task, { events: 0, details: true });
  await syncIndex(deps, task, view.status, view.updatedAt);
  return {
    task: view,
    operationId: accepted.operation.id,
    operationStatus: accepted.operation.status,
    ...(pullRequest === undefined ? {} : { pullRequest }),
  };
}

/** A share changed meanwhile (by the notifier or either share route) retries the close; 4 attempts, then the last conflict is rethrown. */
const CLOSE_ATTEMPTS = 4;

/**
 * R15: deletes the compute, then in one transaction releases the counters the task charged (R6:
 * the charge stored on the task, whatever the developer's Slack link is now), closes the
 * workspace, sets the task's `closedAt` and marks the index row CLOSED. The task's own `closedAt`
 * transition guards the release, so it happens exactly once. `extra` joins the same transaction
 * (ruling F15: the close's accepted record when no preflight ran). `closeOperationId` is the safe
 * preflight's operation, or undefined for a workspace whose preparation failed.
 *
 * A failed condition is decided from fresh reads: a lost race (another call closed the task first)
 * is not an error; counters an earlier release already gave back (releaseConflict) do not block
 * the close, which is sent again without them; anything else is rethrown, never hidden. Callers
 * load the owned task, or are the worker's authenticated callback.
 *
 * C24, ruling F4: a shared task's thread record is marked closed in the same transaction, and a
 * share the notifier changed after the task was read (a thread it just recorded) is read again, so
 * the thread's record is closed too.
 */
export async function finishTaskClose(
  deps: { tableName: string; actions: DeveloperTaskActions; documentClient: { send(command: unknown): Promise<unknown> }; agentEngine?: AgentRunEngineDependencies },
  task: DeveloperTaskRecord,
  closeOperationId: string | undefined,
  extra: TransactItems = [],
  /** When the close was requested (its preflight operation's createdAt): the completed record's receivedAt. */
  requestedAt?: string,
  discardedUnpublished = false,
): Promise<void> {
  const workspace = await deps.actions.workspace(task.workspaceId);
  if (workspace.status !== "CLOSED") await deps.actions.deleteCompute(workspace);
  const now = new Date().toISOString();
  // Fixed across the retries below, so every attempt writes the same record key.
  const closeTurn = { turnId: closeOperationId ?? randomUUID(), receivedAt: requestedAt ?? now };
  const closing = (current: DeveloperTaskRecord): TransactItems => [
    ...(workspace.status === "CLOSED" ? [] : [{ Update: {
      TableName: deps.tableName,
      Key: { pk: `WORKSPACE#${task.workspaceId}`, sk: "META" },
      UpdateExpression: "SET #status = :closed, closedAt = :now, updatedAt = :now REMOVE activeOperationId, closeError",
      ConditionExpression: closeOperationId === undefined ? "#status = :failed" : "#status = :closing AND closeOperationId = :operation",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":closed": "CLOSED", ":now": now,
        ...(closeOperationId === undefined ? { ":failed": "PREPARATION_FAILED" } : { ":closing": "CLOSING", ":operation": closeOperationId }),
      },
    } }]),
    // Ruling F4: a shared task's close holds only while its share is the one read here, so a thread
    // the notifier recorded meanwhile is read again and closed below, never left open.
    { Update: {
      TableName: deps.tableName, Key: taskKey(task.taskId),
      UpdateExpression: "SET closedAt = :now, updatedAt = :now",
      ConditionExpression: current.share === undefined
        ? "attribute_exists(pk) AND attribute_not_exists(closedAt)"
        : "attribute_exists(pk) AND attribute_not_exists(closedAt) AND shareVersion = :sv",
      ExpressionAttributeValues: { ":now": now, ...(current.share === undefined ? {} : { ":sv": current.shareVersion ?? 0 }) },
    } },
    // Deliberately unconditional (an upsert): the start writes this row with the task, and a close
    // must mark it CLOSED whatever status a read last synced into it.
    { Update: {
      TableName: deps.tableName, Key: taskIndexKey(task.developerId, task.createdAt, task.taskId),
      UpdateExpression: "SET #status = :closed, updatedAt = :now", ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":closed": "CLOSED", ":now": now },
    } },
    // The row of the person who took the task over, too (Plan 5 Task 12a).
    ...(ownerIndexRowOf(task) === undefined ? [] : [{ Update: {
      TableName: deps.tableName, Key: ownerIndexRowOf(task)!,
      UpdateExpression: "SET #status = :closed, updatedAt = :now", ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":closed": "CLOSED", ":now": now },
    } }]),
    // C24: the shared thread's record says the task closed, so its mentions get the closed notice.
    ...(current.share?.threadTs === undefined ? [] : [{ Update: {
      TableName: deps.tableName,
      Key: sharedTaskKey({ teamId: current.share.teamId, channelId: current.share.channelId, threadTs: current.share.threadTs }),
      UpdateExpression: "SET closedAt = :now", ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeValues: { ":now": now },
    } }]),
    // E20 (25c C22): the close's own completed record, in the close's transaction, so it commits once.
    // No requester check: only the task's developer can close it, a shared one too (C11).
    ...(deps.actions.turnRecordsTableName === undefined ? [] : [{ Put: {
      TableName: deps.actions.turnRecordsTableName,
      Item: aiToolTurn({
        party: partyOfTask(current), turnId: closeTurn.turnId, action: "close", phase: "completed", outcome: "succeeded",
        receivedAt: closeTurn.receivedAt, finishedAt: now, request: "close", response: discardedUnpublished
          ? "The task is closed; its unpublished workspace changes were discarded and its workspace is released."
          : "The task is closed, and its workspace is released.",
        ...(closeOperationId === undefined ? {} : { operationId: closeOperationId }),
      }),
      ConditionExpression: "attribute_not_exists(pk)",
    } }]),
    ...extra,
  ];
  let current = task;
  let release = true;
  let lastError: unknown;
  for (let attempt = 0; attempt < CLOSE_ATTEMPTS; attempt += 1) {
    try {
      // First, at positions 0 and 1: releaseConflict reads the cancellation reasons by position.
      await deps.actions.transact([...(release ? releaseItems(deps.tableName, task.charge, task.taskId) : []), ...closing(current)]);
      await endAgentRunOfClosedTask(deps, task);
      await tellClosedTaskEnd(deps, task);
      await settleTaskOutcomes(outcomeDepsOf({ documentClient: deps.documentClient, tableName: deps.tableName }), task, new Date().toISOString());
      return;
    } catch (error) {
      if (!isConditional(error)) throw error;
      lastError = error;
      const fresh = await get<DeveloperTaskRecord>(deps, taskKey(task.taskId));
      // Another call finished the close first; its transaction released the counters once.
      if (fresh?.closedAt !== undefined) {
        await endAgentRunOfClosedTask(deps, task);
        await tellClosedTaskEnd(deps, task);
        await settleTaskOutcomes(outcomeDepsOf({ documentClient: deps.documentClient, tableName: deps.tableName }), task, new Date().toISOString());
        return;
      }
      // Ruling F4: the notifier changed the share (it recorded the thread) meanwhile: close that one.
      if (fresh !== undefined && fresh.shareVersion !== current.shareVersion) {
        current = fresh;
        continue;
      }
      if (!release) throw error;
      // Rethrows anything but counters that no longer hold this task.
      await releaseConflict(deps.documentClient, deps.tableName, task.charge, task.taskId, error);
      console.log(JSON.stringify({ component: "broker", event: "developer.task_release_already_released", taskId: task.taskId }));
      release = false;
    }
  }
  throw lastError;
}

/**
 * Plan 3, Task 22 (review I1): the task was closed, so an agent-step run that is waiting (for a person, between steps) ends CANCELLED with its approvals expired
 * and its end told, instead of waiting for a decision nobody can use. A run that is over is left as it is. Never throws: the close is done, and the engine's
 * sweep finds a run whose task is closed.
 */
async function endAgentRunOfClosedTask(deps: { agentEngine?: AgentRunEngineDependencies }, task: DeveloperTaskRecord): Promise<void> {
  if (deps.agentEngine === undefined || task.agent === undefined || task.workflow !== undefined) return;
  try {
    await cancelAgentRun(deps.agentEngine, task.taskId, "The task was closed.");
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "agent_run.close_failed", taskId: task.taskId, errorName: error instanceof Error ? error.name : "unknown" }));
  }
}

/**
 * Whether a workflow task is finished and gives its workspace back at once: all its pull requests merged, or its workflow
 * ended in the CLOSED stage (the owner rejected its plan). Nothing changes either after. A custom sequence that ran every
 * step and has no pull request step also ends CLOSED, with the outcome PASSED, but its code was never published: it is
 * not released here: its workspace and the owner's task slot are kept until the owner closes the task (an owner action, which works on this ending).
 */
export function workflowTaskFinished(task: Pick<DeveloperTaskRecord, "workflow"> & Partial<Pick<DeveloperTaskRecord, "agentRunEnd">>): boolean {
  // An agent-step run that ended (completed, failed or cancelled) is finished the same way (Plan 3, Task 22).
  if (task.agentRunEnd !== undefined) return true;
  const workflow = task.workflow;
  return workflow?.state === "COMPLETE" && ((workflow.stage === "MERGED" && workflow.outcome === "MERGED") || (workflow.stage === "CLOSED" && workflow.outcome !== "PASSED"));
}

/** How a finished workflow task ended, for the end handlers: merged, passed every step of its own sequence, or closed (its plan rejected). */
export function workflowEndOutcome(task: Pick<DeveloperTaskRecord, "workflow">): TaskEndOutcome | undefined {
  const workflow = task.workflow;
  if (workflow?.state !== "COMPLETE") return undefined;
  if (workflow.stage === "MERGED" && workflow.outcome === "MERGED") return "merged";
  // A question that needed no code change is a success that opened no pull request.
  if (workflow.stage === "CLOSED") return workflow.outcome === "PASSED" ? "succeeded" : workflow.outcome === "ANSWERED" ? "answered" : "closed";
  return undefined;
}

/**
 * How telling a task's end went: `told` (every handler heard it, or nobody listens), `in_progress` (another call holds the end and is telling now), `failed` (a
 * handler threw, or the end could not be read or written). Anything but `told` means the end is not finished and has to be looked at again.
 */
export type EndTold = "told" | "in_progress" | "failed";

/** Tells the end handlers a task ended (Plan 3, G7). Never throws: the ending it follows is done, and the answer says whether the end is finished, so a caller that can keep a row can try again. */
export async function noteTaskEnded(deps: { tableName: string; documentClient: { send(command: unknown): Promise<unknown> } }, task: DeveloperTaskRecord, outcome: TaskEndOutcome): Promise<EndTold> {
  try {
    return await onTaskEnded({ documentClient: deps.documentClient, tableName: deps.tableName, now: Date.now }, task, outcome) === "in_progress" ? "in_progress" : "told";
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "task_end.not_told", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" }));
    return "failed";
  }
}

/**
 * Plan 3, M-6: a plain task's operation stopped on a budget, and the task is paused (its `budgetPause`), not ended: Task 32 may resume it. Tells the pause
 * handlers (`onTaskPaused`, as the agent-step engine does) and marks the stop as told on the task (`budgetPauseToldFor`), so a replay or the recovery sweep tells it
 * once; the mark also says the task's end is still owed (`tellClosedTaskEnd`). Never throws: `failed` means a handler threw or the mark could not be written, and the caller
 * keeps a recovery row to try again.
 */
export async function noteTaskPaused(deps: { tableName: string; documentClient: { send(command: unknown): Promise<unknown> } }, task: DeveloperTaskRecord, operationId: string): Promise<EndTold> {
  try {
    if (task.budgetPause === undefined) return "told";
    await onTaskPaused({ documentClient: deps.documentClient, tableName: deps.tableName, now: Date.now }, task, task.budgetPause.scope);
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: taskKey(task.taskId), UpdateExpression: "SET budgetPauseToldFor = :operation", ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeValues: { ":operation": operationId },
    }));
    return "told";
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "task_pause.not_told", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" }));
    return "failed";
  }
}

/**
 * Plan 3, M-6: a plain task (no workflow, no agent-step run) that was closed while its end was still owed (it stopped on a budget, so its end was not told) has ended: tells `closed`. The first
 * end a task has is the one told, so a task that already ended tells nobody again. Never throws; a close that could not tell is left for the recovery sweep (an `operation_end` row with `endOf: "closed"`).
 */
async function tellClosedTaskEnd(deps: { tableName: string; documentClient: { send(command: unknown): Promise<unknown> } }, task: DeveloperTaskRecord): Promise<void> {
  if (!hasTaskEndHandlers() || task.workflow !== undefined) return;
  try {
    const fresh = await get<DeveloperTaskRecord>(deps, taskKey(task.taskId)) ?? task;
    if (fresh.budgetPause === undefined && fresh.budgetPauseToldFor === undefined) return;
    // An agent-step run's end is its engine's (the close cancels the run above).
    if (fresh.agent !== undefined && await get(deps, taskAgentRunKey(task.taskId)) !== undefined) return;
    const told = await noteTaskEnded(deps, fresh, "closed");
    // An end that is not finished (a handler threw, or another call is telling it) is left to the recovery sweep, as a plain task's operation end is (Task 22, N1).
    if (told !== "told") await leaveTaskEndRow(deps, fresh, "closed", told);
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "task_end.close_not_told", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" }));
  }
}

/**
 * R15: finishes a close whose preflight ended safe but whose completion did not land (the worker's
 * callback could not delete the compute, say). Answers whether it closed the task. A failure is
 * logged by its name and left for the next read or close. `loaded` is the caller's reads, when it
 * has them. Callers load the owned task first.
 */
export async function resumeClose(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord, loaded?: WorkspaceReads): Promise<boolean> {
  if (task.closedAt !== undefined) return false;
  const safe = safeClose(loaded ?? await workspaceReads(deps, task));
  if (safe === undefined) return false;
  try {
    const preflight = WorkspaceClosePreflightResultSchema.parse(safe.result);
    await finishTaskClose(deps, task, safe.id, [], safe.createdAt, safe.discardUnpublished === true && !preflight.safeToClose);
    return true;
  } catch (error) {
    log(deps, { event: "developer.task_close_failed", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" });
    return false;
  }
}

/** The close operation of a CLOSING workspace with safe preflight or persisted discard authorization. */
function safeClose({ workspace, operations }: WorkspaceReads): Operation | undefined {
  if (workspace.status !== "CLOSING" || workspace.closeOperationId === undefined) return undefined;
  const operation = operations.find((entry) => entry.id === workspace.closeOperationId);
  const preflight = WorkspaceClosePreflightResultSchema.safeParse(operation?.result);
  return operation?.status === "SUCCEEDED" && preflight.success
    && (preflight.data.safeToClose || operation.discardUnpublished === true) ? operation : undefined;
}

const CLOSE_CHECKING = CLOSE_MESSAGES.checking;
const CLOSE_REFUSED = "not closed: some work is not published; push it or open a pull request with agentx_open_pull_request, then close the task again";
const CLOSE_COMPUTE_PENDING = CLOSE_MESSAGES.computePending;
const CLOSE_DISCARD_PENDING = CLOSE_MESSAGES.discardPending;
const CLOSE_CHECK_FAILED = CLOSE_MESSAGES.checkFailed;
const CLOSE_STILL_OPEN = CLOSE_MESSAGES.stillOpen;
const COMPUTE_STOPPING = "the task's compute is still stopping; try agentx_close_task again shortly";
const CLOSE_FAILED = "AgentX could not close this task just now; try agentx_close_task again, and ask an admin if it keeps failing";

/** Why a close did not close the task (it always says, so the AI tool can tell the developer). */
function notClosedMessage(reads: WorkspaceReads, operation: Operation | undefined, unpublished: DeveloperCloseResponse["unpublished"]): string {
  if (operation?.discardUnpublished === true && unpublished !== undefined) return CLOSE_DISCARD_PENDING;
  if (unpublished !== undefined) return CLOSE_REFUSED;
  if (safeClose(reads) !== undefined) return CLOSE_COMPUTE_PENDING;
  if (reads.workspace.status === "CLOSING" || operation?.status === "ACCEPTED" || operation?.status === "RUNNING") return CLOSE_CHECKING;
  if (operation !== undefined && operation.status !== "SUCCEEDED") return CLOSE_CHECK_FAILED;
  return CLOSE_STILL_OPEN;
}

/** A setup-failed task's close (ruling F15: its accepted record commits with the close). */
async function closeNeverStarted(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord, record: TransactItems[number], receivedAt: string, access?: AuthorizedTask): Promise<void> {
  try {
    await finishTaskClose(deps, task, undefined, [record, ...(access === undefined ? [] : [accessFence(deps, access)])], receivedAt);
  } catch (error) {
    // The compute refuses while it is starting or stopping: its own words, not busy()'s.
    if (error instanceof AgentXError && error.code === "WORKSPACE_BUSY") throw agentXError("TASK_BUSY", COMPUTE_STOPPING);
    if (!isConditional(error)) throw error;
    log(deps, { event: "developer.task_close_failed", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" });
    throw agentXError("WORKSPACE_BUSY", CLOSE_FAILED);
  }
}

/**
 * FR-016, R15, R22, owner decisions 5 and 6. Answers at once: usually `closing: true` while the
 * worker checks for unpublished work, which the AI tool then follows with agentx_get_task. There
 * is no force: unpublished work refuses the close, listing each repository and why.
 *
 * Idempotent: the same requestId reports its preflight's outcome and writes nothing. A fresh
 * requestId while a close is in flight, or after the task closed, answers with that close and
 * writes no new record: nothing new was accepted (the close already has its accepted record).
 */
/** How long a close waits for a stopped grounding round to free the workspace, and how often it looks. */
const GROUNDING_STOP_WAIT_MS = 12_000;
const GROUNDING_STOP_POLL_MS = 400;

/** What Close answers while an earlier stop that did not reach the task is still being confirmed: the workspace stays held, as the reconciler holds it, until the worker is shown to have stopped. */
export const CLOSE_STOP_NOT_CONFIRMED = "The earlier stop did not reach this task, and Rovara cannot yet tell that it has stopped. Closing now could discard work it is still writing, so the task stays open and nothing is deleted. Your request is noted: once the task is idle, the next check (about every 10 minutes) frees the workspace, so close the task again then. If it is still busy, the workspace stays reserved until it finishes.";

/** The session states that mean no worker runs the workspace's task any more (the reconciler's `compute: gone`, as far as the control plane can tell without asking the worker). */
const COMPUTE_GONE_STATES: ReadonlySet<string> = new Set(["STOPPED", "FAILED", "DELETING", "DELETED"]);

/**
 * 058-stop-close (QA6-13): a task whose stop did not reach it ended INTERRUPTED but still holds its workspace, "as the worker may still run it" (issue 202). Close does not drop that hold on its
 * own say-so: the old run may still be writing to the workspace, and two operations must never run in one workspace.
 * - The workspace's compute is gone (its session is stopped, failed or deleted, or there is none): nothing can run there. The hold is freed, and Close goes on to its own check for unpublished work.
 * - Otherwise Close marks the operation (`closeRequestedAt`), so the reconciler's next run frees it as soon as the worker answers its ping idle, without the usual ten-minute wait, and answers that
 *   the stop is not yet confirmed. The hold stays; nothing is closed or deleted.
 * A running operation is never released. Answers the workspace as it is afterwards, and what to do once Close's own step has been tried (the engine wake and the workflow step's block).
 */
async function releaseHeldInterruptedOperation(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord, workspace: Awaited<ReturnType<DeveloperTaskActions["workspace"]>>): Promise<{ workspace: Awaited<ReturnType<DeveloperTaskActions["workspace"]>>; afterwards?: () => Promise<void> }> {
  if (workspace.activeOperationId === undefined || workspace.activeOperationId === null) return { workspace };
  const operationId = workspace.activeOperationId;
  const held = await get<{ id?: string; kind?: string; status?: string; fence?: number; workspaceReleasedAt?: string } & Record<string, unknown>>(deps, { pk: `WORKSPACE#${task.workspaceId}`, sk: `OPERATION#${operationId}` });
  if (held === undefined || held.kind !== "task" || held.status !== "INTERRUPTED" || typeof held.fence !== "number" || held.workspaceReleasedAt !== undefined) return { workspace };
  const session = await get<{ state?: string }>(deps, workspaceSessionKey(task.workspaceId));
  const gone = session === undefined || (typeof session.state === "string" && COMPUTE_GONE_STATES.has(session.state));
  if (!gone) {
    try {
      await deps.documentClient.send(new UpdateCommand({
        TableName: deps.tableName, Key: { pk: `WORKSPACE#${task.workspaceId}`, sk: `OPERATION#${operationId}` },
        UpdateExpression: "SET closeRequestedAt = if_not_exists(closeRequestedAt, :now)",
        ConditionExpression: "#status = :interrupted AND attribute_not_exists(workspaceReleasedAt)",
        ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":now": iso(deps), ":interrupted": "INTERRUPTED" },
      }));
    } catch (error) {
      if (!isConditional(error)) throw error;
    }
    log(deps, { event: "developer.task_close_hold_kept", taskId: task.taskId, operationId });
    throw agentXError("TASK_BUSY", CLOSE_STOP_NOT_CONFIRMED);
  }
  const released = await releaseFailedCancelWorkspace(deps.documentClient, deps.tableName, { workspaceId: task.workspaceId, operationId }, held, "compute-gone", new Date());
  if (!released) return { workspace: await deps.actions.workspace(task.workspaceId) };
  log(deps, { event: "developer.task_close_released_hold", taskId: task.taskId, operationId });
  return {
    workspace: await deps.actions.workspace(task.workspaceId),
    // After Close's own step has been tried, not before: the old run's step and the engine are told only once the workspace has been claimed again.
    afterwards: async () => {
      await wakeAgentRun(deps.documentClient, deps.tableName, task.workspaceId, operationId);
      await blockStoppedWorkflowRun(deps.documentClient, deps.tableName, { ...(held as object), id: operationId, workspaceId: task.workspaceId } as unknown as StoppedRunOperation, "INTERRUPTED");
    },
  };
}

export async function closeTask(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, value: unknown): Promise<DeveloperCloseResponse> {
  const request = parse(DeveloperTaskCloseRequestSchema, value, deps, "close");
  let access = await authorizeTaskActor(deps, caller, taskId, "close");
  let task = access.task;
  const turns = turnTable(deps);
  const receivedAt = iso(deps);
  const record = (response: string, operationId?: string) => putNew(turns, aiToolTurn({
    party: partyOfTaskActor(task, caller), turnId: randomUUID(), action: "close", phase: "accepted", outcome: "accepted", receivedAt, finishedAt: iso(deps),
    request: "close", response, ...(operationId === undefined ? {} : { operationId }),
  }));
  let unpublished: DeveloperCloseResponse["unpublished"];
  let operation: Operation | undefined;
  if (task.closedAt === undefined) {
    let workspace = await deps.actions.workspace(task.workspaceId);
    if (workspace.status === "PREPARATION_FAILED") {
      // A task whose setup failed has nothing to check: it closes now and frees its slot.
      await closeNeverStarted(deps, task, record("Closed; the task's workspace never started."), receivedAt, access);
    } else if (workspace.status === "PREPARING") {
      throw agentXError("TASK_BUSY", `task ${taskId} is still starting; cancel it with agentx_cancel_task, then close it once it has stopped`);
    } else if (workspace.status !== "CLOSED") {
      // T7c: a plan held back for its check on the current app is not asked about again: the hold is marked abandoned (its one finish then clears it quietly) and the round is stopped,
      // so the workspace is free for the close.
      if (task.planGrounding !== undefined && task.workflow?.stage === "PLAN" && task.workflow.state === "RUNNING") {
        try {
          await deps.actions.transact([{ Update: { TableName: deps.tableName, Key: taskKey(taskId), UpdateExpression: "SET planGroundingAbandoned = :held",
            ConditionExpression: "planGrounding.artifactSha256 = :held", ExpressionAttributeValues: { ":held": task.planGrounding.artifactSha256 } } }]);
        } catch (error) {
          if (!isConditional(error)) throw error;
        }
        if (workspace.activeOperationId) {
          await deps.actions.cancelRunning(developerTaskIdentity(task, deps.orgId), workspace, () => []).catch(() => undefined);
          // The stopped round frees the workspace within seconds; the close waits for it (bounded) instead of answering busy.
          for (let waited = 0; waited < GROUNDING_STOP_WAIT_MS; waited += GROUNDING_STOP_POLL_MS) {
            if ((await deps.actions.workspace(task.workspaceId)).activeOperationId === undefined) break;
            await new Promise((resolve) => setTimeout(resolve, GROUNDING_STOP_POLL_MS));
          }
          workspace = await deps.actions.workspace(task.workspaceId);
        }
      }
      const hold = await releaseHeldInterruptedOperation(deps, task, workspace);
      workspace = hold.workspace;
      let started: Awaited<ReturnType<DeveloperTaskActions["startClose"]>>;
      try {
        // startClose answers a close in flight, and a repeated requestId, with the existing close
        // operation and writes nothing; otherwise the record commits with the preflight (R12).
        started = await deps.actions.startClose(developerTaskIdentity(task, deps.orgId), workspace, request.requestId, (operation) => [
          record("Checking the workspace for unpublished work before closing.", operation.id),
          accessFence(deps, access),
        ], request.discard_unpublished === true);
      } catch (error) {
        if (isConditional(error)) await authorizeTaskActor(deps, caller, taskId, "close");
        await hold.afterwards?.().catch(() => undefined);
        busy(error, taskId);
      }
      await hold.afterwards?.().catch(() => undefined);
      operation = (await deps.actions.operations(task.workspaceId)).find((entry) => entry.id === started.operationId);
      if (operation?.status === "SUCCEEDED") unpublished = unpublishedOf(operation.result);
    }
    await resumeClose(deps, task);
    access = await authorizeTaskActor(deps, caller, taskId, "close");
    task = access.task;
  }
  const reads = await workspaceReads(deps, task);
  if (operation === undefined && reads.workspace.closeOperationId !== undefined) {
    operation = reads.operations.find((entry) => entry.id === reads.workspace.closeOperationId);
  }
  const view = await taskView(deps, task, { events: 0, details: false, loaded: reads });
  await syncIndex(deps, task, view.status, view.updatedAt);
  const closePreflight = operation?.kind === "close" ? WorkspaceClosePreflightResultSchema.safeParse(operation.result) : undefined;
  const discardedUnpublished = request.discard_unpublished === true && operation?.discardUnpublished === true
    && closePreflight?.success === true && !closePreflight.data.safeToClose;
  if (view.status === "CLOSED") return { task: view, closed: true, ...(discardedUnpublished ? { discardedUnpublished: true } : {}) };
  return { task: view, closed: false, ...(unpublished === undefined ? {} : { unpublished }), message: notClosedMessage(reads, operation, unpublished) };
}
