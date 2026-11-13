// Part of the broker (split out of ../broker.ts): queued first tasks, terminal results, GitHub workflow events, merge recovery.

import { coreOperationEvents } from "../../cloud/rows/core-rows.js";
import { type prepareTurnModelFallback, type prepareTaskModelFallback, joinTaskModelFallback } from "../../model-selection/fallback-record.js";
import { createHash, randomUUID } from "node:crypto";
import { GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { AgentXError, hostRateLimitRetryAt, WorkspaceClosePreflightResultSchema, agentXError, type CodeHost, type MergeObservation, type OperationStatus, type WorkspaceInstance, WorkflowFeedbackBundleSchema, type OrgId } from "@rovara-code/contracts";
import type { AuthenticatedIdentity } from "../../auth.js";
import { queryAllItems } from "../admin-reads.js";
import { flushAuditEvents } from "../../audit/flush.js";
import { GithubWebhookRefusal, authorizeLinkedGithubWebhook, listDueGithubWebhookDeliveries, processGithubWebhookDelivery, reconcileTaskPullRequestFeedback, type ReceivedGithubWebhook } from "../github-webhooks.js";
import { DeveloperSignInStore } from "../../developer/store.js";
import { deliverCodeMilestones } from "../../rovara-code/milestones.js";
import { OrgStore } from "../../org/store.js";
import { TERMINAL, getItem, operationKey, type OperationRecord } from "../cancellation.js";
import { aiToolTurn, completedTurn, githubWorkflowPullRequestKey, OUTCOME, partyOfTask, taskKey, taskPointerKey, type DeveloperTaskPointerRecord, type DeveloperTaskRecord, type StoredEvent } from "../../developer/task-records.js";
import { findLinkedChangeRequest } from "../../rovara-code/linked-change-requests.js";
import { recordOutsidePushEvent, type OutsidePushDependencies } from "../../rovara-code/outside-push.js";
import type { GitHubPullRequestFeedback } from "../../github-app.js";
import { codeHostRepositoryKey } from "../../plugins/events/repository-key.js";
import { GITHUB_HOST_KIND } from "../../plugins/code-host/github/index.js";
import { isConditional, isTemporaryAwsError } from "../broker-shared.js";
import { readTaskRecipe } from "../../agents/runs.js";
import { developerTaskRouteDependencies } from "../developer-routes.js";
import type { TransactItems } from "../developer-task-actions.js";
import { enqueueFinishedTaskRelease, releaseFinishedTaskQuietly, startTaskWorkflowFeedbackReviewFromWebhook, planAutomaticFeedbackRound } from "../developer-tasks.js";
import { wakeTrackingRow, type GithubMergeReadBudget, type MergeRecoveryResult } from "../workflow-merge-recovery.js";
import { reconcileTrackingTask, type MergeTrackingDependencies } from "../../rovara-code/merge-tracking.js";
import type { CodeMergeHost } from "../../rovara-code/merge.js";
import { installCiFixDecider, taskAutonomy, taskAutonomyBinding } from "../../rovara-code/ci-fix.js";
import { installBranchSyncDeciders } from "../../rovara-code/branch-sync.js";
import { installFeedbackDecider, sendFeedbackReplies } from "../../rovara-code/feedback-autonomy.js";
import { backfillGithubMembers } from "../../rovara-code/github-members.js";
import { capturePullRequestCorrections } from "../../learning/capture-pr.js";
import { boundInstallationOrg, resolveHeadEventTask, wakeFromHeadEvent, wakeFromPullRequestEvent, wakesTrackingRow, type HeadEventDependencies } from "../../rovara-code/tracking-events.js";
import { STUCK_SETUP_MESSAGE } from "../stuck-setup.js";
import { parseStoredEvent, pullRequestKey, workspaceKey } from "./admin-and-helpers.js";
import type { AwsBrokerDependencies, PullRequestRecord } from "./definitions.js";
import { developerTaskActions } from "./dependency-wiring.js";
import { FEEDBACK_BUNDLE_MAX_BYTES, companyAutonomyLimit, ownerCallerOf } from "./feedback-and-codebuild.js";
import { boundedTurnAdmission, TurnAdmissionLimitError } from "../../model-selection/turn-admission.js";
import { readObjectText } from "./plan-answers.js";
import { describeFeedbackFixes } from "./pull-request-reconcile.js";
import { githubScope, installOrgId, orgOfRecord, webhookRepositoryUrl } from "./scope-helpers.js";
import { consumerRepositoryResolver } from "./consumer-hosts.js";
import { changeRequestRef } from "../../rovara-code/host-port.js";
import { taskOperationParts } from "./task-operations.js";
import { recordModelUse, type ModelUseObservation } from "../../org/health-observations.js";
import { latestChecksItem } from "./terminal-result.js";
import { handleSpecPullRequestEvent } from "./spec-wiring.js";
import { type EndedPullRequestReader, outcomeDepsOf, scoreMergedCandidate } from "../../rovara-code/outcome-hooks.js";
import { canonicalJson } from "@rovara-code/contracts";
import { requireTaskStopWindowContext, withAdmittedTaskSource } from "../../org/task-stop-window.js";

/**
 * Spec 025 R3: the first instructions of a developer task, queued in the prepare's own result
 * transaction. Returns the workspace update that replaces the prepare's (PREPARING straight to
 * BUSY) and the task's items. The pointer's condition makes a cancel that lands first win.
 */
async function queuedFirstTask(
  dependencies: AwsBrokerDependencies,
  workspace: WorkspaceInstance,
  prepare: OperationRecord,
  pointer: DeveloperTaskPointerRecord & { pendingPrompt: string },
  now: string,
): Promise<{ workspaceUpdate: TransactItems[number]; items: TransactItems; admittedTask?: DeveloperTaskRecord; turnAudit?:ReturnType<typeof prepareTurnModelFallback>; fallback?:Awaited<ReturnType<typeof prepareTaskModelFallback>>; modelUse?: ModelUseObservation }> {
  const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(pointer.taskId));
  const { operation, outbox, fence,fallback,modelChecks,turnAudit,modelUse } = await taskOperationParts(dependencies, workspace, {
    requestId: pointer.firstRequestId,
    conversationId: pointer.conversationId,
    prompt: pointer.pendingPrompt,
    conversationStarted: false,
    requester: pointer.requester === undefined ? {} : { requestedBy: pointer.requester },
    workflowMode: pointer.pendingWorkflowMode ?? "IMPLEMENT",
    ...(pointer.pendingWorkflowMode === undefined ? { legacyTask: true } : {}),
    ...(task?.workflow?.reviewPhase === undefined ? {} : { workflowPhase: task.workflow.reviewPhase }),
  }, now);
  if (prepare.spendingAdmission !== undefined || task?.spendingStop !== undefined || task?.spendingAdmission !== undefined) {
    if (task === undefined || task.spendingStop === undefined || task.spendingAdmission === undefined || prepare.spendingTaskId !== task.taskId
      || canonicalJson(prepare.spendingAdmission) !== canonicalJson(task.spendingAdmission)) throw agentXError("TASK_STOP_CONFIG_INVALID", "The preparation spending window changed.");
    await requireTaskStopWindowContext(dependencies, task);
    operation.spendingTaskId = task.taskId; operation.spendingAdmission = task.spendingAdmission;
  }
  return {
    ...(task?.spendingStop === undefined ? {} : { admittedTask: task }),
    ...(fallback===undefined?{}:{fallback}),
    ...(turnAudit===undefined?{}:{turnAudit}),
    ...(modelUse===undefined?{}:{modelUse}),
    workspaceUpdate: { Update: {
      TableName: dependencies.tableName,
      Key: workspaceKey(workspace.id),
      UpdateExpression: "SET #status = :busy, updatedAt = :now, preparationManifest = :manifest, activeOperationId = :task, fence = :taskFence, latestChecks = :latestChecks",
      ConditionExpression: "activeOperationId = :operation AND fence = :fence",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":busy": "BUSY", ":now": now, ":manifest": ".agentx/preparation-manifest.json",
        ":task": operation.id, ":taskFence": fence, ":operation": prepare.id, ":fence": prepare.fence,
        ":latestChecks": latestChecksItem({ status: "not_verified", reason: "interrupted" }, operation.id, fence, now),
      },
    } },
    items: [
      { Put: { TableName: dependencies.tableName, Item: operation, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: dependencies.tableName, Item: outbox, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: {
        TableName: dependencies.tableName,
        Item: { pk: `IDEMPOTENCY#${workspace.ownerKey}#${workspace.id}`, sk: `REQUEST#${pointer.firstRequestId}`, entityType: "IDEMPOTENCY", operationId: operation.id, payloadHash: operation.payloadHash },
        ConditionExpression: "attribute_not_exists(pk)",
      } },
      { Update: {
        TableName: dependencies.tableName,
        Key: taskPointerKey(workspace.id),
        UpdateExpression: "REMOVE pendingPrompt, pendingWorkflowMode",
        ConditionExpression: "attribute_exists(pendingPrompt) AND attribute_not_exists(cancelledAt)",
      } },
      ...(modelChecks??[]),
    ],
  };
}

/** The queuing transaction met a transaction in flight; `cause` is DynamoDB's error. */
export class QueuingConflict extends Error {
  constructor(override readonly cause: unknown) {
    super("the first task's transaction met another transaction in flight");
  }
}

function isTransactionConflict(error: unknown): boolean {
  const reasons = error instanceof Error ? (error as Error & { CancellationReasons?: Array<{ Code?: string } | undefined> }).CancellationReasons : undefined;
  return error instanceof Error && error.name === "TransactionCanceledException"
    && Array.isArray(reasons) && reasons.some((reason) => reason?.Code === "TransactionConflict");
}

/**
 * Sends a terminal result. For a developer task's prepare (it has a pointer; a Slack workspace has
 * none) a success queues the first instructions in this same transaction (R3), and any other
 * outcome clears the raw instructions (controller ruling, Task 9 fix round 1). The pointer update
 * is always conditioned on the pointer existing, so it never creates one. `taskPointer` is the
 * caller's one read of the pointer for this decision (P39).
 */
export async function sendTerminalResult(
  dependencies: AwsBrokerDependencies,
  workspace: WorkspaceInstance,
  operation: OperationRecord,
  taskPointer: DeveloperTaskPointerRecord | undefined,
  terminalStatus: OperationStatus,
  now: string,
  transactItems: TransactItems,
  workspaceUpdate: TransactItems[number],
  send: (items: TransactItems) => Promise<unknown>,
  /** Filled with the refusal's words when the task's first operation is refused (Plan 3, Task 16), for the failure the caller records. */
  startRefusal: { text?: string } = {},
): Promise<OperationStatus> {
  const pointer = operation.kind === "prepare" ? taskPointer : undefined;
  const withoutTask: TransactItems = pointer === undefined ? transactItems : [...transactItems, { Update: {
    TableName: dependencies.tableName,
    Key: taskPointerKey(workspace.id),
    UpdateExpression: "REMOVE pendingPrompt, pendingWorkflowMode",
    ConditionExpression: "attribute_exists(pk)",
  } }];
  let queued: Awaited<ReturnType<typeof queuedFirstTask>> | undefined;
  if (terminalStatus === "SUCCEEDED" && pointer?.pendingPrompt !== undefined && pointer.cancelledAt === undefined) {
    try {
      queued = await queuedFirstTask(dependencies, workspace, operation, { ...pointer, pendingPrompt: pointer.pendingPrompt }, now);
    } catch (partsError) {
      if (isConditional(partsError)) throw partsError;
      // FR-055, C19: the worker tries the result again; if every try fails, the stuck-setup sweep
      // ends the prepare (D21). Nothing is recorded, so the next try can still queue the task.
      if (isTemporaryAwsError(partsError)) throw firstTaskQueueRetry(pointer.taskId, operation.id, partsError);
      // Final review I1: the task's parts could not be built (the project's latest revision or
      // its model could not be read). The prepare is recorded as FAILED, so the task reads as
      // setup_failed, its instructions are cleared and its slot is released (#213), instead of
      // the task waiting in STARTING forever. The error name only: its message could quote the task.
      console.log(JSON.stringify({ component: "broker", event: "developer.first_task_queue_failed", taskId: pointer.taskId, operationId: operation.id, error: partsError instanceof Error ? partsError.name : "unknown" }));
      // Plan 3, Task 16: a model the company or the project does not allow is the owner's to fix, and the refusal's words say how.
      // Only that error is quoted: its message names the agent, the step and the model, never the task.
      if (partsError instanceof TurnAdmissionLimitError || partsError instanceof AgentXError && partsError.code === "MODEL_NOT_ALLOWED") startRefusal.text = refusalText(partsError);
      await send(failedPrepareItems(dependencies, workspace, operation, now, startRefusal.text));
      return "FAILED";
    }
  }
  if (queued === undefined) {
    await send(withoutTask);
    return terminalStatus;
  }
  try {
    const queuedItems = boundedTurnAdmission(joinTaskModelFallback([...transactItems.filter((item) => item !== workspaceUpdate), queued.workspaceUpdate, ...queued.items],queued.fallback?.items??[]));
    await send(queued.admittedTask === undefined ? queuedItems : withAdmittedTaskSource(dependencies.tableName, queued.admittedTask, queuedItems, "firstOperationWindow").items);
    if(queued.fallback?.event!==undefined)await flushAuditEvents(dependencies,[queued.fallback.event]);
    if(queued.turnAudit!==undefined)await flushAuditEvents(dependencies,[queued.turnAudit.event]);
    if(queued.modelUse!==undefined)await recordModelUse(dependencies,queued.modelUse.orgId,queued.modelUse.use);
  } catch (queueError) {
    if(queueError instanceof TurnAdmissionLimitError) {
      startRefusal.text=refusalText(queueError);
      await send(failedPrepareItems(dependencies,workspace,operation,now,startRefusal.text));
      return "FAILED";
    }
    // C19: a temporary error from the one queuing write committed nothing; the worker tries again.
    // A TransactionCanceledException with a TransactionConflict reason is not temporary here: it
    // keeps the QueuingConflict path below.
    if (isTemporaryAwsError(queueError)) throw firstTaskQueueRetry(pointer?.taskId ?? "unknown", operation.id, queueError);
    if (!isConditional(queueError)) throw queueError;
    if (isTransactionConflict(queueError)) throw new QueuingConflict(queueError);
    // R16: a cancel that removed the instructions first wins; record the prepare without the task.
    // A concurrent duplicate callback that already queued the task lands here too, and the plain
    // write below then fails its fence condition and is answered by the caller's handler.
    const again = await getItem<DeveloperTaskPointerRecord>(dependencies, taskPointerKey(workspace.id));
    if (again?.pendingPrompt !== undefined) throw queueError;
    await send(withoutTask);
  }
  return terminalStatus;
}

/** C19: logs a temporary error while queuing a task's first instructions (its name only) and answers 503. */
function firstTaskQueueRetry(taskId: string, operationId: string, error: Error): AgentXError {
  console.log(JSON.stringify({ component: "broker", event: "developer.first_task_queue_retry", taskId, operationId, error: error.name }));
  return agentXError("RUNTIME_UNAVAILABLE", "the task's first instructions could not be queued yet; send the result again");
}

/** A refusal's words without the `CODE: ` the error class puts in front of them: what the owner is told. */
export const refusalText = (error: AgentXError): string => error.message.startsWith(`${error.code}: `) ? error.message.slice(error.code.length + 2) : error.message;

/** The error a prepare is recorded with when its task's first instructions could not be queued (final review I1). */
export const FIRST_TASK_QUEUE_FAILED = "the task's first instructions could not be queued; close this task and start a new one";

/** A prepare that the worker reported SUCCEEDED but that was recorded FAILED because its first task could not be queued. */
export const isQueueFailedPrepare = (operation: OperationRecord, reported: unknown): boolean =>
  operation.kind === "prepare" && operation.status === "FAILED" && (operation.error === FIRST_TASK_QUEUE_FAILED || operation.startRefused === true) && reported === "SUCCEEDED";

/** C18: a prepare the stuck-setup sweep failed; the worker's late result is answered, not refused. */
export const isSweptPrepare = (operation: OperationRecord): boolean =>
  operation.kind === "prepare" && operation.status === "FAILED" && operation.error === STUCK_SETUP_MESSAGE;

/**
 * A developer task's prepare recorded as FAILED (final review I1): the operation, the workspace
 * released as PREPARATION_FAILED, and the raw instructions cleared from an existing pointer.
 */
function failedPrepareItems(dependencies: AwsBrokerDependencies, workspace: WorkspaceInstance, operation: OperationRecord, now: string, refusal?: string): TransactItems {
  return [
    { Update: {
      TableName: dependencies.tableName,
      Key: operationKey(operation.workspaceId, operation.id),
      UpdateExpression: `SET #status = :status, updatedAt = :now, #error = :error${refusal === undefined ? "" : ", startRefused = :refused"}`,
      ConditionExpression: "fence = :fence",
      ExpressionAttributeNames: { "#status": "status", "#error": "error" },
      ExpressionAttributeValues: { ":status": "FAILED", ":now": now, ":error": refusal ?? FIRST_TASK_QUEUE_FAILED, ":fence": operation.fence, ...(refusal === undefined ? {} : { ":refused": true }) },
    } },
    { Update: {
      TableName: dependencies.tableName,
      Key: workspaceKey(workspace.id),
      UpdateExpression: "SET #status = :status, updatedAt = :now REMOVE activeOperationId, closeError",
      ConditionExpression: "activeOperationId = :operation AND fence = :fence",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":status": "PREPARATION_FAILED", ":now": now, ":operation": operation.id, ":fence": operation.fence },
    } },
    { Update: {
      TableName: dependencies.tableName,
      Key: taskPointerKey(workspace.id),
      UpdateExpression: "REMOVE pendingPrompt, pendingWorkflowMode",
      ConditionExpression: "attribute_exists(pk)",
    } },
  ];
}

/** The operation kinds whose result may concern a developer task: one pointer read serves them all (P39). */
export const TASK_POINTER_KINDS: ReadonlySet<string> = new Set(["prepare", "task", "publish", "maintain", "close", "cancel"]);

/** What a successful cancel's result makes of its target, and what a failed one does. */
export const cancelledTargetStatus = (cancelStatus: OperationStatus): OperationStatus => (cancelStatus === "SUCCEEDED" ? "CANCELLED" : "INTERRUPTED");

/** At most `limit` of an operation's events, newest first, across pages. */
export async function operationEventsNewestFirst(dependencies: AwsBrokerDependencies, operationId: string, limit: number, workspaceId?: string): Promise<StoredEvent[]> {
  const items = (await queryAllItems(dependencies, `OPERATION#${operationId}`, "EVENT#", { limit, newestFirst: true })).filter((item) => item.entityType === "EVENT");
  // An operation of a core task keeps its events under its workspace (D18): looked for only where Cloud's own partition has none.
  const found = items.length > 0 || workspaceId === undefined ? items : await coreOperationEvents(dependencies, workspaceId, operationId, { limit, newestFirst: true });
  return found.map((item) => parseStoredEvent(item));
}

/**
 * Spec 025 R12: the `completed` turn record of the developer task or publish operation this result
 * ends (or the push of a workflow task's approved fix, whose accepted record the push wrote), for the result's own transaction, so the record and the result land together or not at
 * all. A task's own result ends it; a cancel's result ends its target (ruling F13: the target's
 * own later result finds it terminal and writes nothing). A Slack workspace has no pointer and
 * gets none.
 */
export async function completedTurnItems(
  dependencies: AwsBrokerDependencies,
  operation: OperationRecord,
  pointer: DeveloperTaskPointerRecord | undefined,
  terminalStatus: OperationStatus,
  outcome: { result: unknown; error: string | undefined },
  now: string,
): Promise<TransactItems> {
  const table = dependencies.turnRecordsTableName;
  if (pointer === undefined || table === undefined) return [];
  let ended: { operation: OperationRecord; status: OperationStatus } | undefined;
  const recordsTurn = (record: OperationRecord) => record.kind === "task" || record.kind === "publish"
    || (record.kind === "maintain" && (record.maintenance?.workflowCandidate !== undefined || record.maintenance?.workflowSync !== undefined));
  if (recordsTurn(operation)) {
    ended = {
      operation: { ...operation, ...(outcome.result === undefined ? {} : { result: outcome.result }), ...(outcome.error === undefined ? {} : { error: outcome.error }) },
      status: terminalStatus,
    };
  } else if (operation.kind === "cancel" && operation.targetOperationId) {
    const target = await getItem<OperationRecord>(dependencies, operationKey(operation.workspaceId, operation.targetOperationId));
    if (target !== undefined && recordsTurn(target) && !TERMINAL.has(target.status)) {
      ended = { operation: target, status: cancelledTargetStatus(terminalStatus) };
    }
  }
  // E20 (25c C22): a close that did not close gets its completed record in the preflight result's
  // transaction: refused for unpublished work, or the check's own outcome when it did not finish.
  // A safe preflight's record is finishTaskClose's, which writes it with the close.
  if (operation.kind === "close") {
    const requester = operation.requestedBy;
    const preflight = terminalStatus === "SUCCEEDED" ? WorkspaceClosePreflightResultSchema.safeParse(outcome.result) : undefined;
    const refusal = preflight?.success === true && !preflight.data.safeToClose
      ? `Not closed: unpublished work in ${preflight.data.repositories.map((repository) => `${repository.name} (${repository.reasons.join(", ")})`).join("; ")}`
      : undefined;
    const unfinished = terminalStatus !== "SUCCEEDED";
    if ((refusal !== undefined || unfinished) && operation.discardUnpublished !== true && requester !== undefined && "kind" in requester && requester.kind === "developer") {
      const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(pointer.taskId));
      if (task === undefined) {
        // The pointer and the task are written in one transaction, so this is not expected.
        console.log(JSON.stringify({ component: "broker", event: "developer.task_record_missing", taskId: pointer.taskId, operationId: operation.id }));
        return [];
      }
      return [{ Put: { TableName: table, Item: aiToolTurn({
        party: partyOfTask(task), turnId: operation.id, operationId: operation.id, action: "close", phase: "completed",
        outcome: refusal !== undefined ? "refused" : OUTCOME[terminalStatus] ?? "failed",
        receivedAt: operation.createdAt, finishedAt: now, request: "close",
        response: refusal ?? "Not closed: the check for unpublished work did not finish",
      }), ConditionExpression: "attribute_not_exists(pk)" } }];
    }
  }
  if (ended === undefined) return [];
  // F3: a teammate's operation from a continue thread gets an ordinary Slack turn record (FR-037,
  // FR-054), never an AI-tool record under the developer's name.
  const endedBy = ended.operation.requestedBy;
  if (endedBy === undefined || !("kind" in endedBy) || endedBy.kind !== "developer") return [];
  const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(pointer.taskId));
  if (task === undefined) {
    // The pointer and the task are written in one transaction, so this is not expected.
    console.log(JSON.stringify({ component: "broker", event: "developer.task_record_missing", taskId: pointer.taskId, operationId: ended.operation.id }));
    return [];
  }
  // A task's summary is its last assistant message; a publish's is its pull request.
  const events = ended.operation.kind === "task" ? (await operationEventsNewestFirst(dependencies, ended.operation.id, 500, ended.operation.workspaceId)).reverse() : [];
  let item: Record<string, unknown>;
  try {
    item = completedTurn({ task, pointer, operation: ended.operation, status: ended.status, events, now });
  } catch (error) {
    // Together or not at all (R12): the result is not recorded either, and the worker's callback
    // fails. The error name only: its message could quote the task's text.
    console.log(JSON.stringify({ component: "broker", event: "developer.completed_turn_failed", taskId: task.taskId, operationId: ended.operation.id, error: error instanceof Error ? error.name : "unknown" }));
    throw error;
  }
  return [{ Put: { TableName: table, Item: item, ConditionExpression: "attribute_not_exists(pk)" } }];
}

/** What every release of a finished task needs, the track record's fresh GitHub read included: the settle after a release is the same whichever path made the release. */
export function releaseDependenciesOf(dependencies: AwsBrokerDependencies, settleUntil?: number) {
  return {
    tableName: dependencies.tableName, actions: developerTaskActions(dependencies), documentClient: dependencies.documentClient,
    ...(dependencies.modelAccess === undefined ? {} : { modelAccess: dependencies.modelAccess.access }),
    outcomeReader: (task: DeveloperTaskRecord) => endedPullRequestReader(dependencies, task),
    ...(settleUntil === undefined ? {} : { outcomeSettleUntil: settleUntil }),
  };
}

/** A finished workflow task gives back its workspace slot and its workspace (releaseFinishedTask); never throws. */
export async function releaseIfFinished(dependencies: AwsBrokerDependencies, taskId: string): Promise<void> {
  await releaseFinishedTaskQuietly(releaseDependenciesOf(dependencies), taskId);
}

/** Refresh all linked PRs from the GitHub API before an owner decision (webhook payloads are hints only). */
export async function refreshTaskFeedbackForOwnerDecision(dependencies: AwsBrokerDependencies, taskId: string): Promise<void> {
  if (dependencies.githubPullRequests.getPullRequestFeedback === undefined) {
    throw agentXError("RUNTIME_UNAVAILABLE", "current GitHub PR feedback collection is not configured");
  }
  const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(taskId));
  const workflow = task?.workflow;
  const linked = workflow?.pullRequests?.find(pr => pr.state === "OPEN" || pr.state === "UNKNOWN");
  const parsed = linked === undefined ? undefined : /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/.exec(linked.url);
  if (!task || !linked || !parsed) throw agentXError("CONFIG_INVALID", "the task has no verifiable open linked PRs");
  await processGithubWorkflowEvent(dependencies, {
    kind: "PULL_REQUEST", action: "synchronize", installationId: 0, repositoryId: 0,
    fullName: parsed[1]!, number: Number(parsed[2]),
  }, `owner-decision-${randomUUID()}`);
}

/** P10: the change request a merge observation reads is on this code host (not GitHub) at this registered repository address. */
export interface NeutralMergeObservation { host: CodeHost; repositoryAddress: string }

/** A host's merge observation in the words the reconcile reads a pull request in. */
function mergeObservationFacts(observation: MergeObservation): GitHubPullRequestFeedback["pullRequest"] {
  return {
    number: Number(observation.ref.id), url: observation.ref.url, state: observation.state, headBranch: observation.sourceBranch, baseBranch: observation.targetBranch,
    headCommit: observation.headRevision, headTreeSha: observation.headTreeRevision, title: observation.title, body: observation.body,
    ...(observation.mergeRevision === undefined ? {} : { mergeCommit: observation.mergeRevision }), ...(observation.mergedAt === undefined ? {} : { mergedAt: observation.mergedAt }),
    ...(observation.mergedBy === undefined ? {} : { mergedBy: observation.mergedBy }),
  };
}

export function outsidePushDependencies(dependencies: AwsBrokerDependencies): OutsidePushDependencies {
  return {
    documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: () => new Date().toISOString(),
    loadTask: (taskId) => getItem<DeveloperTaskRecord>(dependencies, taskKey(taskId)),
    repositoryUrl: (project, revision, repositoryId, orgId) => webhookRepositoryUrl(dependencies)(project, revision, repositoryId, orgId),
    installationOrg: (installationId) => boundInstallationOrg({ documentClient: dependencies.documentClient, tableName: dependencies.tableName }, installationId),
  };
}

/** Reconcile every PR webhook against GitHub; comments and delivery order never grant authority. */
export async function processGithubWorkflowEvent(
  dependencies: AwsBrokerDependencies,
  event: ReceivedGithubWebhook["event"],
  deliveryId: string,
  options?: { observationMode: "merge"; budget: GithubMergeReadBudget; release: "queue"; neutral?: NeutralMergeObservation },
): Promise<void> {
  // A check or status event only wakes the task's tracking row; the pass that follows reads GitHub (Plan 6 Task 14).
  if (event.kind === "HEAD_STATUS") {
    await wakeFromHeadEvent(headEventDependencies(dependencies), event);
    return;
  }
  // "Last pushed by": a push to a task's working branch only says who pushed which head; there is no pull request to read.
  if (event.kind === "BRANCH_PUSH") {
    await recordOutsidePushEvent(outsidePushDependencies(dependencies), event);
    return;
  }
  const neutral = options?.neutral;
  // Meta repo lane D (D4): a person editing or approving a task's spec pull request. One read for any other pull request; a failure here never fails the delivery.
  if (neutral === undefined) await handleSpecPullRequestEvent(dependencies, event);
  // Bug I: a review (given, edited or dismissed), or a pull request made ready, pushed to or reopened, wakes the task's tracking row too, so the pass that reads the reviews from GitHub
  // comes in seconds, not at the heartbeat. The delivery still goes on to the feedback path below; a wake that fails only means the pass comes at its own time.
  // A push to a pull request (synchronize) names its pusher: kept as a hint for "last pushed by"; a failure here never fails the delivery.
  if (options === undefined && neutral === undefined && event.action === "synchronize") {
    await recordOutsidePushEvent(outsidePushDependencies(dependencies), event).catch((error: unknown) => {
      console.log(JSON.stringify({ component: "broker", event: "outside_push.record_failed", deliveryId, error: error instanceof Error ? error.name : "unknown" }));
    });
  }
  if (options === undefined && wakesTrackingRow(event)) {
    await wakeFromPullRequestEvent(headEventDependencies(dependencies), event).catch((error: unknown) => {
      console.log(JSON.stringify({ component: "broker", event: "tracking.wake_failed", deliveryId, error: error instanceof Error ? error.name : "unknown" }));
    });
  }
  const hasRead = neutral !== undefined ? neutral.host.mergeObservation !== undefined
    : options === undefined
    ? dependencies.githubPullRequests.getPullRequestFeedback !== undefined
    : dependencies.githubPullRequests.getPullRequestMergeObservation !== undefined;
  if (!hasRead) throw agentXError("RUNTIME_UNAVAILABLE", options === undefined
    ? "current GitHub feedback collection is not configured"
    : "current GitHub merge observation is not configured");
  const learningBudget = { remaining: 20, skipped: 0 };
  const changed = await reconcileTaskPullRequestFeedback({
    documentClient: dependencies.documentClient, tableName: dependencies.tableName,
    repositoryFullName: event.fullName, number: event.number, deliveryId,
    ...(neutral === undefined ? {} : { neutralHost: { kind: neutral.host.kind, repositoryAddress: neutral.repositoryAddress } }),
    ...(event.headSha === undefined ? {} : { expectedHeadSha: event.headSha }),
    loadTask: (taskId) => getItem<DeveloperTaskRecord>(dependencies, taskKey(taskId)),
    repositoryUrl: webhookRepositoryUrl(dependencies),
    // P10: each repository's own host decides how its pull request is read: GitHub's below, another host's merge observation here (merge mode only; nothing else is read from such a host).
    hostOfRepository: async (project, revision, repositoryId, orgId) => {
      if (orgId === undefined) return undefined;
      const home = await consumerRepositoryResolver(dependencies)(project, revision, repositoryId, orgId).catch(() => undefined);
      if (home === undefined || home.codeHost.kind === GITHUB_HOST_KIND) return undefined;
      const host = home.codeHost;
      return {
        kind: host.kind,
        observe: async (repositoryUrl, number, scopeOrg) => {
          if (options === undefined || host.mergeObservation === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the code host cannot show a merge");
          return mergeObservationFacts(await host.mergeObservation(changeRequestRef(repositoryUrl, number), githubScope(dependencies, scopeOrg), options.budget));
        },
      };
    },
    getCurrentFeedback: async (url, number, orgId) => options === undefined
      ? dependencies.githubPullRequests.getPullRequestFeedback!.call(dependencies.githubPullRequests, url, number, githubScope(dependencies, orgId))
      : { pullRequest: await dependencies.githubPullRequests.getPullRequestMergeObservation!.call(dependencies.githubPullRequests, url, number, options.budget, githubScope(dependencies, orgId)), comments: [], threads: [] },
    ...(options === undefined ? {} : { observationMode: options.observationMode }),
    ...(options === undefined && event.installationId > 0 ? { onFeedbackRead: async (task, comments) => {
      if (task.orgId === undefined) return;
      // The original delivery's binding, never a login or webhook body claim, fences company intake.
      const installationOrgId = await boundInstallationOrg({ documentClient: dependencies.documentClient, tableName: dependencies.tableName }, event.installationId);
      await capturePullRequestCorrections({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: () => Date.now(), ...(dependencies.audit === undefined ? {} : { audit: dependencies.audit }) }, { task: { taskId: task.taskId, orgId: task.orgId, project: task.project }, installationOrgId, repositoryId: task.repositoryId, comments, budget: learningBudget });
    } } : {}),
    recordedHead: async (workspaceId, repositoryId, number) => (await getItem<PullRequestRecord>(dependencies, pullRequestKey(workspaceId, repositoryId, number)))?.expectedHeadCommit,
    ...(neutral !== undefined || dependencies.githubPullRequests.getCommitParents === undefined ? {} : {
      commitParents: (url: string, commit: string, orgId: OrgId | undefined) => dependencies.githubPullRequests.getCommitParents!(url, commit, githubScope(dependencies, orgId)),
    }),
    // A fix push taken for failed but landed: recorded as its result would have, together or not at all.
    saveLandedPushes: async (taskId, expectedRevision, workflow, pushes, extraItems = []) => {
      await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
        { Update: {
          TableName: dependencies.tableName, Key: taskKey(taskId),
          UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
          ConditionExpression: "workflow.revision = :revision AND attribute_not_exists(closedAt)",
          ExpressionAttributeValues: { ":workflow": workflow, ":now": workflow.updatedAt, ":revision": expectedRevision },
        } },
        ...pushes.flatMap((push) => [
          { Update: {
            TableName: dependencies.tableName, Key: githubWorkflowPullRequestKey(push.repositoryFullName, push.number),
            UpdateExpression: "SET candidateDigest = :candidate, updatedAt = :now",
            ConditionExpression: "taskId = :taskId AND #url = :url AND candidateDigest = :previous",
            ExpressionAttributeNames: { "#url": "url" },
            ExpressionAttributeValues: { ":candidate": push.candidateDigest, ":now": workflow.updatedAt, ":taskId": taskId, ":url": push.url, ":previous": push.previousCandidateDigest },
          } },
          { Update: {
            TableName: dependencies.tableName, Key: pullRequestKey(push.workspaceId, push.repositoryId, push.number),
            UpdateExpression: "SET expectedHeadCommit = :head, #state = :state, updatedAt = :now",
            ConditionExpression: "expectedHeadCommit = :previous OR expectedHeadCommit = :head",
            ExpressionAttributeNames: { "#state": "state" },
            ExpressionAttributeValues: { ":head": push.headSha, ":previous": push.previousHeadSha, ":state": push.state, ":now": workflow.updatedAt },
          } },
        ]),
        ...extraItems,
      ] }));
      console.log(JSON.stringify({ component: "broker", event: "workflow.landed_fix_push_recorded", taskId, pullRequests: pushes.map((push) => push.number) }));
      // The fix is on the pull request as if its result had come: its description lists it too.
      for (const push of pushes) {
        const record = await getItem<PullRequestRecord>(dependencies, pullRequestKey(push.workspaceId, push.repositoryId, push.number));
        if (record !== undefined) await describeFeedbackFixes(dependencies, { id: `landed-${deliveryId}`, workspaceId: push.workspaceId }, record, push.candidateDigest);
      }
    },
    reviewedComments: async (taskId, bundleDigests) => {
      const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(taskId));
      if (task === undefined) return undefined;
      const comments: Array<{ id: string; updatedAt: string; bodyDigest: string }> = [];
      for (const digest of bundleDigests) {
        const text = await readObjectText(dependencies, `private/${task.ownerKey}/${task.workspaceId}/feedback/${digest}.json`, FEEDBACK_BUNDLE_MAX_BYTES);
        if (text === undefined || createHash("sha256").update(text, "utf8").digest("hex") !== digest) return undefined;
        const bundle = WorkflowFeedbackBundleSchema.safeParse(JSON.parse(text));
        if (!bundle.success || bundle.data.taskId !== taskId) return undefined;
        comments.push(...bundle.data.comments.map(({ id, updatedAt, bodyDigest }) => ({ id, updatedAt, bodyDigest })));
      }
      return comments;
    },
    persistBundle: async (bundle, bytes, sha256) => {
      const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(bundle.taskId));
      if (!task) throw new GithubWebhookRefusal("linked feedback task no longer exists");
      const objectKey = `private/${task.ownerKey}/${task.workspaceId}/feedback/${sha256}.json`;
      try {
        await dependencies.s3.send(new PutObjectCommand({ Bucket: dependencies.artifactBucketName, Key: objectKey,
          Body: bytes, ContentType: "application/json", IfNoneMatch: "*" }));
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "PreconditionFailed") throw error;
        const existing = await dependencies.s3.send(new GetObjectCommand({ Bucket: dependencies.artifactBucketName, Key: objectKey }));
        const existingBytes = await existing.Body?.transformToString();
        if (existingBytes === undefined || createHash("sha256").update(existingBytes, "utf8").digest("hex") !== sha256) {
          throw agentXError("RUNTIME_UNAVAILABLE", "immutable feedback artifact failed digest validation");
        }
      }
      return objectKey;
    },
    saveWorkflow: async (taskId, expectedRevision, workflow, extraItems = []) => {
      const update = {
        TableName: dependencies.tableName, Key: taskKey(taskId),
        UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
        ConditionExpression: "workflow.revision = :revision AND attribute_not_exists(closedAt)",
        ExpressionAttributeValues: { ":workflow": workflow, ":now": workflow.updatedAt, ":revision": expectedRevision },
      };
      // Pending audit items commit with the update or not at all; with none (no ledger, or nothing to record) it is the plain update.
      // A cancelled transaction is a lost race like a failed condition: the caller reads the task again.
      if (extraItems.length === 0) await dependencies.documentClient.send(new UpdateCommand(update));
      else await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [{ Update: update }, ...extraItems] }));
    },
    measure: (entry) => console.log(JSON.stringify({ component: "broker", ...entry })),
    ...(dependencies.audit === undefined ? {} : {
      audit: dependencies.audit,
      auditOrgId: async (taskId: string) => orgOfRecord(dependencies, await getItem<Record<string, unknown>>(dependencies, taskKey(taskId)) ?? {}),
    }),
    now: new Date().toISOString(),
  });
  // P6: the link is read from the neutral row, then the old GitHub row.
  const linked = await findLinkedChangeRequest(dependencies, neutral === undefined
    ? { hostKind: "github", repositoryAddress: `https://github.com/${event.fullName}`, id: String(event.number) }
    : { hostKind: neutral.host.kind, repositoryAddress: neutral.repositoryAddress, id: String(event.number) });
  // A merge that finished the task gives back its slot and workspace (again for a redelivery, which changes nothing).
  if (linked !== undefined && options?.release !== "queue") await releaseIfFinished(dependencies, linked.taskId);
  // Track record: after the release, which never waits on it, and never throwing.
  if (linked !== undefined) await scoreMergedPullRequestOutcomes(dependencies, linked.taskId, linked.repositoryId, event.number, options?.budget);
  // Plan 6 Task 20: the merged milestone this save wrote is told to the registered handlers now; one that was not told is told again by the sweep.
  if (linked !== undefined && changed) {
    await deliverCodeMilestones({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now }, linked.taskId).catch((error: unknown) => {
      console.log(JSON.stringify({ component: "broker", event: "code_milestone.delivery_failed", taskId: linked.taskId, error: error instanceof Error ? error.name : "unknown" }));
    });
  }
  if (linked !== undefined && options?.release !== "queue") {
    const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(linked.taskId));
    if (task !== undefined && dependencies.developer !== undefined) {
      const caller = await ownerCallerOf(dependencies, task, "github-webhook");
      const routeDependencies = developerTaskRouteDependencies({
        documentClient: dependencies.documentClient, tableName: dependencies.tableName, developer: dependencies.developer,
        now: Date.now, tasks: developerTaskActions(dependencies),
      }, caller, undefined, null);
      await startTaskWorkflowFeedbackReviewFromWebhook(routeDependencies, task.taskId);
    }
  }
}

const MERGE_RECOVERY_RETRY_MS = 5 * 60_000;
/** What one run of the merge-recovery schedule may spend in all (the merge pass, then the tracking pass), inside the broker's 30-second timeout. */
export const SWEEP_EVENT_BUDGET_MS = 26_000;
/** What a pass over many finished tasks may spend settling their track record in all: well inside the sweep's event budget, which also has the rest of its work to do. */
export const OUTCOME_SETTLE_PASS_MS = SWEEP_EVENT_BUDGET_MS - 20_000;

async function stronglyRead<T>(dependencies: AwsBrokerDependencies, key: { pk: string; sk: string }): Promise<T | undefined> {
  const response = await dependencies.documentClient.send(new GetCommand({
    TableName: dependencies.tableName,
    Key: key,
    ConsistentRead: true,
  })) as { Item?: T };
  return response.Item;
}

async function mergeRecoveryReleaseConfirmed(dependencies: AwsBrokerDependencies, task: DeveloperTaskRecord): Promise<boolean> {
  const workspace = await stronglyRead<Record<string, unknown>>(dependencies, workspaceKey(task.workspaceId));
  if (workspace?.status !== "CLOSED") return false;
  if (task.releasedAt !== undefined) return true;
  const [member, organization] = await Promise.all([
    stronglyRead<Record<string, unknown>>(dependencies, task.charge.member),
    stronglyRead<Record<string, unknown>>(dependencies, task.charge.organization),
  ]);
  if (member === undefined || organization === undefined) return false;
  if (!Number.isInteger(member.count) || (member.count as number) < 0
    || !Number.isInteger(organization.count) || (organization.count as number) < 0) return false;
  if (member.tasks !== undefined && (!(member.tasks instanceof Set) || member.tasks.has(task.taskId))) return false;
  return true;
}

/** What a check or status delivery is matched with (Plan 6 Task 14): the installation's org, the task, and the project's pinned repository. */
export function headEventDependencies(dependencies: AwsBrokerDependencies): HeadEventDependencies {
  return {
    documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now,
    loadTask: (taskId) => getItem<DeveloperTaskRecord>(dependencies, taskKey(taskId)),
    repositoryUrl: async (project, revision, repositoryId, orgId) => webhookRepositoryUrl(dependencies)(project, revision, repositoryId, orgId),
    verifyRepository: (repositoryUrl, scope) => dependencies.githubPullRequests.verifyWebhookRepository(repositoryUrl, scope),
    orgOfInstallation: async (installationId) => {
      if (dependencies.cloud !== true) return installOrgId(dependencies);
      return boundInstallationOrg({ documentClient: dependencies.documentClient, tableName: dependencies.tableName }, installationId);
    },
  };
}

/**
 * Whether the stored review of a task's feedback is sound enough for Rovara to decide it itself (Plan 6 Task 16): the report and comments read and checked as the owner's card reads them. An
 * unreadable record throws; the tracking pass then leaves the round to the owner.
 */
async function automaticFeedbackRoundIsSound(dependencies: AwsBrokerDependencies, taskId: string): Promise<boolean> {
  const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(taskId));
  if (task?.workflow === undefined || dependencies.developer === undefined) return false;
  const routeDependencies = developerTaskRouteDependencies({
    documentClient: dependencies.documentClient, tableName: dependencies.tableName, developer: dependencies.developer,
    now: Date.now, tasks: developerTaskActions(dependencies),
  }, await ownerCallerOf(dependencies, task, "workflow-feedback-autonomy"), undefined, null);
  return await planAutomaticFeedbackRound(routeDependencies, task) !== undefined;
}

/**
 * Track record: a fresh GitHub read of one of a task's pull requests (its checks and reviews, its merge commit and time, and a person's permission on its repository), for scoring a candidate's
 * samples. Undefined where the provider cannot read a pull request's status or a person's permission: what waits on it is then `code_host_unavailable`, never guessed.
 */
export function endedPullRequestReader(dependencies: AwsBrokerDependencies, task: DeveloperTaskRecord, budget?: GithubMergeReadBudget): EndedPullRequestReader | undefined {
  if (task.orgId === undefined) return undefined;
  const orgId = task.orgId;
  const resolve = consumerRepositoryResolver(dependencies);
  const permissions = new Map<string, Promise<"admin" | "write" | "read" | "none">>();
  return async (repositoryId, number) => {
    // The code host is the one the repository's record names (P5a), as the tracking pass reads it; an unknown kind is refused here, before anything is read.
    const home = await resolve(task.project, task.startingRevision, repositoryId, orgId);
    if (home === undefined) throw agentXError("CONFIG_INVALID", "the pull request's repository is not in the task's project");
    const { url, codeHost } = home;
    const scope = githubScope(dependencies, orgId);
    // Every read goes through the budgeted port (the tracking pass's own): the sweep's budget when there is one, else this read's own short signal. A spent budget refuses the read and the
    // samples wait for a later pass.
    const reads: GithubMergeReadBudget = budget ?? { signal: AbortSignal.timeout(OUTCOME_READ_SIGNAL_MS), beforeRequest: () => undefined };
    const status = await codeHost.changeRequestStatus(changeRequestRef(url, number), scope, reads);
    // The merge commit and time (P6, register SY-3): the host's own budgeted merge observation, whichever host it is. A host that cannot read it leaves the samples to wait.
    const details = status.state === "merged" && codeHost.mergeObservation !== undefined
      ? await codeHost.mergeObservation(changeRequestRef(url, number), scope, reads).catch(() => undefined) : undefined;
    return {
      status, mergeCommit: details?.mergeRevision, mergedAt: details?.mergedAt,
      permission: (login) => {
        const key = `${url}:${login.toLowerCase()}`;
        let found = permissions.get(key);
        if (found === undefined) { found = codeHost.standing({ url }, { login }, scope, reads).then((read) => read.permission); permissions.set(key, found); }
        return found;
      },
    };
  };
}
/** How long one read of a pull request may take when no sweep budget bounds it. */
const OUTCOME_READ_SIGNAL_MS = 8_000;

/**
 * Track record: a pull request the workflow now records as merged has its candidate's samples scored, from GitHub's answer read now, not from the tracking item. Only a version 2 task, and nothing
 * is read once no sample of the candidate is open. A close is not scored here (it may be reopened; the task's end settles it). Best effort: it never throws.
 */
async function scoreMergedPullRequestOutcomes(dependencies: AwsBrokerDependencies, taskId: string, repositoryId: string, number: number, budget?: GithubMergeReadBudget): Promise<void> {
  try {
    const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(taskId));
    const workflow = task?.workflow;
    if (task === undefined || workflow === undefined || task.orgId === undefined || workflow.definitionVersion !== "1.1.0") return;
    const ended = workflow.pullRequests?.find((entry) => entry.repositoryId === repositoryId && entry.number === number);
    const read = endedPullRequestReader(dependencies, task, budget);
    if (ended === undefined || ended.state !== "MERGED" || read === undefined) return;
    await scoreMergedCandidate(outcomeDepsOf(dependencies), { taskId, orgId: task.orgId, project: task.project, agent: task.agent, workflow }, { candidateDigest: ended.candidateDigest, read, now: new Date().toISOString(), ...(budget === undefined ? {} : { signal: budget.signal }) });
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", level: "warn", event: "outcomes.merge_failed", taskId, error: error instanceof Error ? error.name : "unknown" }));
  }
}

/** What the tracking pass needs, or undefined where the GitHub provider cannot read a pull request's status (then no row is tracked). */
function mergeTrackingDependencies(dependencies: AwsBrokerDependencies): Omit<MergeTrackingDependencies, "budget"> | undefined {
  const github = dependencies.githubPullRequests;
  if (github.getPullRequestStatus === undefined || github.getRepositoryPermission === undefined || github.markPullRequestReady === undefined || github.requestReviewers === undefined) return undefined;
  return {
    documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now, outcomes: outcomeDepsOf(dependencies),
    // P5a: the code host (and the runner that reads its builds) is the one each repository's record names; everything a pass reads or does goes through that host's port.
    repository: consumerRepositoryResolver(dependencies),
    // How far Rovara may go on its own with this task's pull requests: what the task's frozen recipe says (a task with none is `prepare`; a recipe that cannot be read is `suggest`, so it asks first).
    autonomy: (task) => task.orgId === undefined ? "prepare" : taskAutonomy(() => readTaskRecipe(dependencies, task.taskId, task.orgId!), (event, fields) => console.log(JSON.stringify({ component: "broker", event, ...fields })), () => companyAutonomyLimit(dependencies, task.orgId!)),
    // The origin session links are made from (the approved milestone's "Ready to merge" link).
    ...(dependencies.developer === undefined ? {} : { origin: new URL(dependencies.developer.issuer).origin }),
    // The autonomy and the digest of the task's frozen recipe, read together: an automatic decision on review comments is bound to both (Plan 6 Task 16).
    autonomyBinding: (task) => task.orgId === undefined ? Promise.resolve({ autonomy: "prepare" as const }) : taskAutonomyBinding(() => readTaskRecipe(dependencies, task.taskId, task.orgId!), (event, fields) => console.log(JSON.stringify({ component: "broker", event, ...fields })), () => companyAutonomyLimit(dependencies, task.orgId!)),
    // Whether the waiting round's stored report and comments are sound enough for Rovara to decide it (Plan 6 Task 16); the report is read and checked as the owner's card reads it.
    feedbackRoundCheck: (task) => automaticFeedbackRoundIsSound(dependencies, task.taskId),
    ...(github.replyToReviewThread === undefined ? {} : { sendFeedbackReplies: (task: Parameters<typeof sendFeedbackReplies>[1], budget?: GithubMergeReadBudget) => sendFeedbackReplies({
      documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now,
      scope: (orgId) => githubScope(dependencies, orgId),
      // P5b: the reply goes through the port of the code host each repository's record names.
      repository: consumerRepositoryResolver(dependencies),
      log: (event, fields) => console.log(JSON.stringify({ component: "broker", event, ...fields })),
    }, task, budget) }),
    scope: (orgId) => githubScope(dependencies, orgId),
    loadTask: (taskId) => getItem<DeveloperTaskRecord>(dependencies, taskKey(taskId)),
    repositoryUrl: async (project, revision, repositoryId, orgId) => webhookRepositoryUrl(dependencies)(project, revision, repositoryId, orgId),
    recordedHead: async (workspaceId, repositoryId, number) => (await getItem<PullRequestRecord>(dependencies, pullRequestKey(workspaceId, repositoryId, number)))?.expectedHeadCommit,
    log: (event, fields) => console.log(JSON.stringify({ component: "broker", event, ...fields })),
  };
}

/**
 * What merging a task's pull requests needs of the broker (Plan 6 Task 19): GitHub's status and permission reads and the merge, the task, the repository's URL as the project pins it and the
 * base branch Rovara opened the pull request against. Undefined where the provider cannot read status or merge (a test double without them). A press that finds a branch GitHub needs up to date
 * wakes the tracking row, whose sync slot merges the base in.
 */
export function codeMergeHostOf(dependencies: AwsBrokerDependencies): CodeMergeHost | undefined {
  const github = dependencies.githubPullRequests;
  if (github.getPullRequestStatus === undefined || github.getRepositoryPermission === undefined || github.mergePullRequest === undefined) return undefined;
  return {
    // P5a: status, standing, code owners, changed paths and the merge go through the port of the code host each repository's record names (task P7). Code owners (owner decision
    // 2026-10-27) are read only; a host that cannot read them leaves the check off. Team membership is outside the port (`isTeamMember` on the repository).
    repository: consumerRepositoryResolver(dependencies),
    scope: (orgId) => githubScope(dependencies, orgId),
    loadTask: (taskId) => getItem<DeveloperTaskRecord>(dependencies, taskKey(taskId)),
    repositoryUrl: async (project, revision, repositoryId, orgId) => webhookRepositoryUrl(dependencies)(project, revision, repositoryId, orgId),
    recordedBase: async (workspaceId, repositoryId, number) => (await getItem<PullRequestRecord>(dependencies, pullRequestKey(workspaceId, repositoryId, number)))?.baseBranch,
    requireSyncForMerge: async (task) => { await wakeTrackingRow({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now }, task.taskId); },
    log: (event, fields) => console.log(JSON.stringify({ component: "broker", event, ...fields })),
  };
}

/** The tracking pass's reconcile for one tracking row: tracking, then today's merge observation (Plan 6 Task 14). Without a provider that can read status it is today's merge observation alone. */
export async function reconcileWorkflowTrackingTask(
  dependencies: AwsBrokerDependencies,
  taskId: string,
  budget: GithubMergeReadBudget,
): Promise<MergeRecoveryResult> {
  const tracking = mergeTrackingDependencies(dependencies);
  const observeMerge = (id: string, merged: GithubMergeReadBudget) => reconcileWorkflowMergeRecoveryTask(dependencies, id, merged);
  if (tracking === undefined) return observeMerge(taskId, budget);
  // Plan 6 Task 15: failing CI is fixed on Rovara's own pull requests; the slot is filled once for the process.
  installCiFixDecider();
  // Plan 6 Task 17: keeping the branch up to date (a conflict, or behind a base that requires it) fills the conflict and sync slots.
  installBranchSyncDeciders();
  // Plan 6 Task 16: a writer's actionable review comments are fixed on Rovara's own decision (and failing CI is added to the owner's card); the slot is filled once for the process.
  installFeedbackDecider();
  // The first pass for an org links the members who signed in with GitHub before the links were kept; once done it is marked and not run again. A failure never stops the pass.
  const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(taskId)).catch(() => undefined);
  if (task?.orgId !== undefined && dependencies.developer !== undefined) {
    const store = new DeveloperSignInStore({ documentClient: dependencies.documentClient, tableName: dependencies.developer.signInTableName, now: Date.now });
    const orgs = new OrgStore({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now });
    const orgId = task.orgId;
    await backfillGithubMembers({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now }, orgId, async () => {
      const found: Array<{ developerId: string; githubUserId: string }> = [];
      for (const member of (await orgs.listMembers(orgId)).slice(0, 500)) {
        const githubUserId = await store.githubUserIdOf(member.developerId);
        if (githubUserId !== undefined) found.push({ developerId: member.developerId, githubUserId });
      }
      return found;
    }).catch((error: unknown) => console.log(JSON.stringify({ component: "broker", event: "github_member.backfill_failed", error: error instanceof Error ? error.name : "unknown" })));
  }
  return reconcileTrackingTask({ ...tracking, observeMerge }, taskId, budget);
}

/** Reconciles one recovery row using one exact reverse-linked PR and the bounded merge-only GitHub reader. */
export async function reconcileWorkflowMergeRecoveryTask(
  dependencies: AwsBrokerDependencies,
  taskId: string,
  budget: GithubMergeReadBudget,
): Promise<MergeRecoveryResult> {
  const retry = (): MergeRecoveryResult => ({ kind: "RETRY", retryAt: Date.now() + MERGE_RECOVERY_RETRY_MS, scope: "task" });
  const task = await stronglyRead<DeveloperTaskRecord>(dependencies, taskKey(taskId));
  if (task === undefined) return { kind: "MISSING" };
  if (task.closedAt !== undefined || task.releasedAt !== undefined) {
    return await mergeRecoveryReleaseConfirmed(dependencies, task) ? { kind: "TERMINAL", release: "confirmed" } : retry();
  }
  const pullRequests = task.workflow?.pullRequests ?? [];
  let selected: { fullName: string; number: number; neutral?: NeutralMergeObservation } | undefined;
  for (const pullRequest of pullRequests) {
    // P10: a change request on a code host other than GitHub is found by the repository's own record (its host and address), then by the neutral link; GitHub's is found by its address as before.
    const home = task.orgId === undefined ? undefined : await consumerRepositoryResolver(dependencies)(task.project, task.startingRevision, pullRequest.repositoryId, task.orgId).catch(() => undefined);
    if (home !== undefined && home.codeHost.kind !== GITHUB_HOST_KIND) {
      const key = codeHostRepositoryKey(home.codeHost.kind, home.url);
      const neutralLink = key === undefined ? undefined : await findLinkedChangeRequest(dependencies, { hostKind: home.codeHost.kind, repositoryAddress: home.url, id: String(pullRequest.number) });
      if (key !== undefined && neutralLink?.taskId === task.taskId && neutralLink.workspaceId === task.workspaceId && neutralLink.repositoryId === pullRequest.repositoryId
        && neutralLink.number === pullRequest.number && neutralLink.url === pullRequest.url && neutralLink.candidateDigest === pullRequest.candidateDigest) {
        selected = { fullName: key, number: pullRequest.number, neutral: { host: home.codeHost, repositoryAddress: home.url } };
        break;
      }
      continue;
    }
    const parsed = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/.exec(pullRequest.url);
    if (parsed === null || Number(parsed[2]) !== pullRequest.number) continue;
    const linked = await findLinkedChangeRequest(dependencies, { hostKind: "github", repositoryAddress: `https://github.com/${parsed[1]!}`, id: String(pullRequest.number) });
    if (linked?.taskId === task.taskId && linked.workspaceId === task.workspaceId && linked.repositoryId === pullRequest.repositoryId
      && linked.number === pullRequest.number && linked.url === pullRequest.url && linked.candidateDigest === pullRequest.candidateDigest) {
      selected = { fullName: parsed[1]!, number: pullRequest.number };
      break;
    }
  }
  if (selected === undefined) return retry();
  try {
    await processGithubWorkflowEvent(dependencies, {
      kind: "PULL_REQUEST",
      action: "closed",
      installationId: 0,
      repositoryId: 0,
      fullName: selected.fullName,
      number: selected.number,
    }, `merge-recovery-${taskId}`, { observationMode: "merge", budget, release: "queue", ...(selected.neutral === undefined ? {} : { neutral: selected.neutral }) });
  } catch (error) {
    const limitedUntil = hostRateLimitRetryAt(error);
    if (limitedUntil !== undefined) return { kind: "RETRY", retryAt: limitedUntil, scope: "github-global" };
    return retry();
  }
  const fresh = await stronglyRead<DeveloperTaskRecord>(dependencies, taskKey(taskId));
  if (fresh === undefined) return { kind: "MISSING" };
  if (fresh.closedAt !== undefined || fresh.releasedAt !== undefined) {
    return await mergeRecoveryReleaseConfirmed(dependencies, fresh) ? { kind: "TERMINAL", release: "confirmed" } : retry();
  }
  if (fresh.workflow?.stage !== "MERGED" || fresh.workflow.state !== "COMPLETE" || fresh.workflow.outcome !== "MERGED") {
    return { kind: "OBSERVED" };
  }
  try {
    await enqueueFinishedTaskRelease({ documentClient: dependencies.documentClient, tableName: dependencies.tableName }, taskId);
    const marker = await stronglyRead<Record<string, unknown>>(dependencies, { pk: "FINISHED_RELEASE", sk: `TASK#${taskId}` });
    return marker?.entityType === "FINISHED_RELEASE" && marker.taskId === taskId
      ? { kind: "TERMINAL", release: "queued" }
      : retry();
  } catch {
    return retry();
  }
}

async function githubEventStillAuthorized(dependencies: AwsBrokerDependencies, event: ReceivedGithubWebhook["event"]): Promise<boolean> {
  if (event.kind === "HEAD_STATUS") return await resolveHeadEventTask(headEventDependencies(dependencies), event) !== undefined;
  // A push to a working branch is checked against the task's own rows and the installation's binding when it is recorded.
  if (event.kind === "BRANCH_PUSH") return true;
  return authorizeLinkedGithubWebhook({
    documentClient: dependencies.documentClient,
    tableName: dependencies.tableName,
    scope: { installationId: event.installationId, repositoryId: event.repositoryId, fullName: event.fullName, pullRequestNumber: event.number },
    loadTask: (taskId) => getItem<DeveloperTaskRecord>(dependencies, taskKey(taskId)),
    repositoryUrl: webhookRepositoryUrl(dependencies),
    verifyRepository: (repositoryUrl, scope) => dependencies.githubPullRequests.verifyWebhookRepository(repositoryUrl, scope),
  });
}

export async function retryDueGithubWebhookEvents(dependencies: AwsBrokerDependencies): Promise<{ attempted: number; processed: number; delayed: number }> {
  const now = new Date().toISOString();
  const due = await listDueGithubWebhookDeliveries({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now, limit: 25 });
  let processed = 0;
  let delayed = 0;
  for (const delivery of due) {
    try {
      const result = await processGithubWebhookDelivery({
        documentClient: dependencies.documentClient,
        tableName: dependencies.tableName,
        received: { delivery: "ACCEPTED", deliveryId: delivery.deliveryId, event: delivery.event },
        process: async (event) => {
          // Revalidate under the delivery lease. Revoked scope is terminal; transient GitHub/API
          // errors consume the ordinary bounded retry budget instead of leaving a hot due row.
          if (!await githubEventStillAuthorized(dependencies, event)) {
            throw new GithubWebhookRefusal("linked GitHub pull request is no longer authorized");
          }
          await processGithubWorkflowEvent(dependencies, event, delivery.deliveryId);
        },
        now: () => new Date().toISOString(),
      });
      if (result === "PROCESSED") processed += 1;
      else delayed += 1;
    } catch (error) {
      console.log(JSON.stringify({ component: "broker", event: "github.webhook_retry_failed", deliveryId: delivery.deliveryId, error: error instanceof Error ? error.name : "unknown" }));
    }
  }
  return { attempted: due.length, processed, delayed };
}

export async function retryGithubWebhookAsAdministrator(dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity, deliveryId: string) {
  if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deliveryId)) throw agentXError("NOT_FOUND", "webhook delivery not found");
  const key = { pk: `GITHUB_DELIVERY#${deliveryId}`, sk: "META" };
  const stored = await getItem<Record<string, unknown>>(dependencies, key);
  if (stored === undefined || (stored.status !== "RETRYABLE" && stored.status !== "DEAD") || stored.event === undefined) throw agentXError("CONFIG_INVALID", "only a failed GitHub delivery can be retried");
  const event = stored.event as ReceivedGithubWebhook["event"];
  if (!await githubEventStillAuthorized(dependencies, event)) throw agentXError("FORBIDDEN", "linked GitHub pull request is no longer authorized");
  const now = new Date().toISOString();
  await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
    { Update: { TableName: dependencies.tableName, Key: key,
      UpdateExpression: "SET #status = :received, updatedAt = :now, nextAttemptAt = :now, webhookRecoveryPk = :pk, webhookRecoverySk = :sk REMOVE leaseToken, leaseExpiresAt, attempts",
      ConditionExpression: "#status = :retryable OR #status = :dead",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":received": "RECEIVED", ":retryable": "RETRYABLE", ":dead": "DEAD", ":now": now, ":pk": "GITHUB_WEBHOOK_RECOVERY", ":sk": `${now}#${deliveryId}` },
    } },
    { Put: { TableName: dependencies.tableName, Item: { pk: `GITHUB_DELIVERY#${deliveryId}`, sk: `RETRY#${now}`, entityType: "GITHUB_WEBHOOK_RETRY_AUDIT", deliveryId, actor: identity.subject, at: now }, ConditionExpression: "attribute_not_exists(pk)" } },
  ] }));
  return { deliveryId, status: "RETRY_QUEUED" as const };
}
