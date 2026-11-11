// Part of the broker (split out of ../broker.ts): scheduled event predicates, dispatch failure records, E2E readiness.

import { DeleteCommand, GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { AgentXError, AGENTX_PROTOCOL_VERSION, WORKFLOW_AUTO_IMPLEMENT_FAILED_MESSAGE, WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE, WORKFLOW_AUTO_REVIEW_FAILED_MESSAGE, BRANCH_SYNC_UNSURE_MESSAGE, WorkspaceInstanceSchema, agentXError, workspaceRecordFields, workflowRequestId, workspaceSessionKey, projectAllows, projectMemberKey, type OrgId } from "@rovara-code/contracts";
import { blockWorkflow, WorkflowSnapshotSchema, WORKFLOW_BLOCK_REASONS, blockWorkflowPullRequestUpdate, nextWorkflowPullRequestUpdate, endWorkflowBranchSync, blockWorkflowBranchSync, type WorkerInvocation, type WorkflowSnapshot, orgMemberKey } from "@agentx/cloud-contracts";
import { closeUnstartedCheck } from "../../design-review/check-ends.js";
import { codeMilestoneItems } from "../../rovara-code/milestones.js";
import { TERMINAL, getItem, issueCapability, operationKey, operationOrg, operationRecord, outboxRecord, type OperationRecord } from "../cancellation.js";
import { giveUpAgentRun } from "../../agents/run-engine.js";
import { E2E_PLAN_REFERENCE_INVALID_BLOCK_REASON, effectiveTaskOwner, taskKey, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { workflowDispatchItem, type WorkflowDispatchRecord, type WorkflowE2EReadinessMarker, hashJson, isConditional } from "../broker-shared.js";
import type { ModelSourceSweepDependencies } from "../../model-sources/sweep.js";
import type { LedgerDependencies } from "../../spend/ledger.js";
import { CHAIN_SCHEDULE_SOURCE } from "../../triggers/schedules.js";
import { readTaskRecipe } from "../../agents/runs.js";
import { checkProjectAccess } from "../developer-routes.js";
import { type startTaskWorkflowE2EChecksFromSystem, systemTaskDispatchAccessFence } from "../developer-tasks.js";
import { workflowRunEndedReason } from "../outbox-failure.js";
import { dispatchExhaustRows } from "../workflow-autofix-dispatch-exhaust.js";
import { workspaceKey } from "./admin-and-helpers.js";
import type { AwsBrokerDependencies } from "./definitions.js";
import { agentRouteDependencies, developerTaskActions } from "./dependency-wiring.js";
import { getWorkflowE2ECreatorIdentity } from "./dispatch.js";
import { dispatchWorkflowContinuation, finishPlanGrounding, refuseApplicationRoundBeforeWarmUp, stopStuckGroundingHold } from "./e2e-rounds.js";
import { readOrgMember } from "./records.js";
import { egressDepsOf, modelSourceStoreOf, orgOfRecord } from "./scope-helpers.js";
import { workflowE2ECreatorAuthorityProof } from "./workflow-e2e-verification.js";
import { completedBranchSyncItems } from "./workflow-items.js";

export function isAuditDrainEvent(event: unknown): event is { source: "agentx.audit-drain" } {
  return event !== null && typeof event === "object" && (event as { source?: unknown }).source === "agentx.audit-drain";
}

export function isGithubInstallRequestReminderEvent(event: unknown): event is { kind: "github-install-request-reminders" } {
  return event !== null && typeof event === "object" && (event as { kind?: unknown }).kind === "github-install-request-reminders";
}

/** What the session sweep event may spend in all (the sweep and then the drain), inside the broker's 30-second timeout. */
export const SESSION_EVENT_BUDGET_MS = 25_000;

export function isSessionSweepEvent(event: unknown): event is { source: "agentx.session-sweep" } {
  return event !== null && typeof event === "object" && (event as { source?: unknown }).source === "agentx.session-sweep";
}

export function isSpendSettlementEvent(event: unknown): event is { source: "agentx.spend-settlement" } {
  return event !== null && typeof event === "object" && (event as { source?: unknown }).source === "agentx.spend-settlement";
}

/**
 * The audit of the proxy's scoped keys is the last job and gets the least of the function's time (`settlementBudgets`); what it did not reach it says,
 * and when it throws, what it had done (the counts travel in the error's words) is logged, since the report names only the error.
 */
export async function auditModelKeys(access: { auditKeys(options?: { budgetMs?: number }): Promise<{ checked: number; blocked: number; truncated: boolean }> }, budgetMs: number) {
  const result = await access.auditKeys({ budgetMs }).catch((error: unknown) => {
    console.log(JSON.stringify({ component: "broker", event: "model_keys.audit_failed", errorName: error instanceof Error ? error.name : "unknown", message: error instanceof Error && error.name === "AgentXError" ? error.message.slice(0, 300) : undefined }));
    throw error;
  });
  if (result.truncated) console.log(JSON.stringify({ component: "broker", event: "model_keys.audit_truncated", checked: result.checked, blocked: result.blocked }));
  return result;
}

/** Task 24b: what the model-source sweep needs, or undefined where the install has no agents or no model proxy (it then has no sources to sweep). */
export function modelSourceSweepOf(dependencies: AwsBrokerDependencies): ModelSourceSweepDependencies | undefined {
  if (dependencies.agents === undefined || dependencies.modelAccess === undefined) return undefined;
  return {
    documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now,
    store: modelSourceStoreOf(dependencies), access: dependencies.modelAccess.access, egress: egressDepsOf(dependencies),
    log: (entry) => console.log(JSON.stringify({ component: "broker", ...entry })),
  };
}

/** Task 30: what the spend ledger needs, or undefined where the install has no agents or no model proxy (it then keeps no ledger). */
export function ledgerOf(dependencies: Pick<AwsBrokerDependencies, "agents" | "modelAccess" | "documentClient" | "tableName" | "cloud">): LedgerDependencies | undefined {
  if (dependencies.agents === undefined || dependencies.modelAccess === undefined) return undefined;
  return {
    documentClient: dependencies.documentClient, tableName: dependencies.tableName, access: dependencies.modelAccess.access, now: Date.now,
    ...(dependencies.cloud === true ? { cloud: true } : {}),
  };
}

export function isEgressDomainsSyncEvent(event: unknown): event is { source: "agentx.egress-domains-sync" } {
  return event !== null && typeof event === "object" && (event as { source?: unknown }).source === "agentx.egress-domains-sync";
}

export function isGithubWebhookRecoveryEvent(event: unknown): event is { source: "agentx.github-webhook-recovery" } {
  return event !== null && typeof event === "object" && (event as { source?: unknown }).source === "agentx.github-webhook-recovery";
}

/** The scheduler's invocation: an event of its own, which has no request context (a request through the API always has one, so its body can never pass for this). */
export function isChainScheduleEvent(event: unknown): event is { source: typeof CHAIN_SCHEDULE_SOURCE } {
  return event !== null && typeof event === "object" && !("requestContext" in event) && (event as { source?: unknown }).source === CHAIN_SCHEDULE_SOURCE;
}

/** Meta repo lane F (F2): the scheduler's every-minute tick of the intake poll. */
export function isIntakePollEvent(event: unknown): event is { source: "agentx.intake-poll" } {
  return event !== null && typeof event === "object" && !("requestContext" in event) && (event as { source?: unknown }).source === "agentx.intake-poll";
}

export function isChainSweepEvent(event: unknown): event is { source: "agentx.chain-sweep" } {
  return event !== null && typeof event === "object" && (event as { source?: unknown }).source === "agentx.chain-sweep";
}

export function isWorkflowMergeRecoveryEvent(event: unknown): event is { source: "agentx.workflow-merge-recovery" } {
  return event !== null && typeof event === "object" && (event as { source?: unknown }).source === "agentx.workflow-merge-recovery";
}

export const WORKFLOW_DISPATCH_SWEEP_LIMIT = 25;
export const PLAN_EVIDENCE_SWEEP_LIMIT = 25;
/** After this many failed runs the task is blocked with a plain reason and the owner's Retry reviews (or Retry opening the pull request) takes over. */
const WORKFLOW_DISPATCH_MAX_ATTEMPTS = 10;
const WORKFLOW_DISPATCH_MAX_BACKOFF_MINUTES = 15;

/** The minutes to wait after the given number of failed runs: 1, 2, 4, 8, then 15. */
function workflowDispatchBackoffMinutes(attempts: number): number {
  return Math.min(2 ** Math.max(attempts - 1, 0), WORKFLOW_DISPATCH_MAX_BACKOFF_MINUTES);
}

/**
 * A failed run: count it and push the row's due time back, or at the cap delete the row and block the task with a
 * plain reason in one transaction, so the owner sees Retry reviews (or Retry opening the pull request) instead of a task silently waiting. Both writes
 * hold only while the row still has the attempts this run read; a row someone else moved is left to them.
 */
export async function recordWorkflowDispatchFailure(dependencies: AwsBrokerDependencies, item: WorkflowDispatchRecord, finalReason?: string,
  /** The plain reason to block with when this failure spends the budget, in place of the generic one for the kind of work (a deterministic refusal knows better). */
  exhaustedReason?: string): Promise<void> {
  const previous = item.attempts ?? 0;
  const attempts = previous + 1;
  const now = new Date().toISOString();
  const key = { pk: item.pk, sk: item.sk };
  const sameRow = { ConditionExpression: "attribute_exists(pk) AND (attempts = :previous OR (attribute_not_exists(attempts) AND :previous = :zero))",
    ExpressionAttributeValues: { ":previous": previous, ":zero": 0 } };
  try {
    // A refusal that cannot change by trying again (`finalReason`) skips the retries and blocks the task with its own words.
    if (finalReason === undefined && attempts < WORKFLOW_DISPATCH_MAX_ATTEMPTS) {
      const nextAttemptAt = new Date(Date.parse(now) + workflowDispatchBackoffMinutes(attempts) * 60_000).toISOString();
      await dependencies.documentClient.send(new UpdateCommand({
        TableName: dependencies.tableName, Key: key,
        UpdateExpression: "SET attempts = :attempts, nextAttemptAt = :next, dispatchDueSk = :due",
        ConditionExpression: sameRow.ConditionExpression,
        ExpressionAttributeValues: { ...sameRow.ExpressionAttributeValues, ":attempts": attempts, ":next": nextAttemptAt, ":due": `${nextAttemptAt}#${item.sk}` },
      }));
      return;
    }
    // The keys' expiry and the next end are the backstop for an operation whose end could not be told: the row goes (Plan 3, Task 22).
    if (item.kind === "operation_end") {
      await dependencies.documentClient.send(new DeleteCommand({ TableName: dependencies.tableName, Key: key }));
      console.log(JSON.stringify({ component: "broker", event: "operation_end.dispatch_gave_up", taskId: item.taskId, attempts }));
      return;
    }
    // The agent-step engine could not take a run forward: the run ends FAILED with a clear reason, and the row goes (Plan 3, Task 22).
    if (item.kind === "agent_run") {
      const agents = agentRouteDependencies(dependencies, developerTaskActions(dependencies));
      if (agents !== undefined) await giveUpAgentRun(agents, item.taskId);
      console.log(JSON.stringify({ component: "broker", event: "agent_run.dispatch_gave_up", taskId: item.taskId, attempts }));
      return;
    }
    // Plan 6 Task 8: a plan check that could not be started, however often it was tried, is not a reason to hold the plan back: it goes to the person, unchecked.
    if (item.kind === "CRITIQUE" && finalReason === undefined) {
      await closeUncheckedPlanCheck(dependencies, item);
      console.log(JSON.stringify({ component: "broker", event: "workflow.dispatch_gave_up", taskId: item.taskId, kind: item.kind, attempts }));
      return;
    }
    // Plan 6 Task 17: a merge of the base that could not be started is not a reason to stop the task: it ends, and the task waits for the merge as it did (the day's count keeps a retry bounded).
    if (item.kind === "SYNC") {
      await endUnstartedBranchSync(dependencies, item, { gaveUp: true });
      console.log(JSON.stringify({ component: "broker", event: "workflow.dispatch_gave_up", taskId: item.taskId, kind: item.kind, attempts }));
      return;
    }
    // T7c: the held plan's check could not be looked after: the one finish ends the hold as a plan that could not be checked (its card posts); if even that fails, planning is stopped with its Retry.
    if (item.kind === "GROUNDING") {
      try { if (await finishPlanGrounding(dependencies, item.taskId, { force: "start-failed" }) !== "WAITING") { await dependencies.documentClient.send(new DeleteCommand({ TableName: dependencies.tableName, Key: key })); return; } } catch (finishError) {
        console.log(JSON.stringify({ component: "broker", event: "workflow.grounding_give_up_finish_failed", taskId: item.taskId, error: finishError instanceof Error ? finishError.name : "unknown" }));
      }
      await stopStuckGroundingHold(dependencies, item.taskId);
      return;
    }
    const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(item.taskId));
    const workflow = task?.workflow;
    const deleteRow = { Delete: { TableName: dependencies.tableName, Key: key, ...sameRow } };
    // The stage and state the row was due in, and the plain reason the owner sees when AgentX gives up on it.
    const [stage, state, usualReason] = item.kind === "UNDERSTAND" ? ["UNDERSTAND", "READY", WORKFLOW_BLOCK_REASONS.understandNotStarted] as const
      : item.kind === "PLAN" ? ["PLAN", "READY", WORKFLOW_BLOCK_REASONS.planNotStarted] as const
      : item.kind === "CHECKS"
      ? ["VERIFY", "WAITING", exhaustedReason ?? WORKFLOW_BLOCK_REASONS.checksUnconfirmed] as const
      : item.kind === "REVIEW" ? ["REVIEW", "WAITING", WORKFLOW_AUTO_REVIEW_FAILED_MESSAGE] as const
      : item.kind === "IMPLEMENT" ? ["IMPLEMENT", "READY", WORKFLOW_AUTO_IMPLEMENT_FAILED_MESSAGE] as const
      : item.kind === "CRITIQUE" ? ["PLAN_CRITIQUE", "READY", WORKFLOW_BLOCK_REASONS.planCheckNotStarted] as const
      : item.kind === "CRITIC_REPLAN" ? ["PLAN", "READY", WORKFLOW_BLOCK_REASONS.planRevisionNotStarted] as const
      // The planner's automatic second run could not be started: planning stops with its Retry, as a failed planning run would leave it.
      : item.kind === "REPLAN" ? ["PLAN", "RUNNING", workflowRunEndedReason("PLAN", "FAILED")] as const
      : ["PULL_REQUEST", "READY", WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE] as const;
    const reason = finalReason ?? usualReason;
    // A fix AgentX gave up pushing: the task waits for the merge, blocked, naming the pull request.
    const updating = item.kind === "UPDATE" && workflow !== undefined ? nextWorkflowPullRequestUpdate(workflow) : undefined;
    if (workflow === undefined || workflow.revision !== item.workflowRevision || workflow.stage !== stage || workflow.state !== state || task?.closedAt !== undefined
      || (item.kind === "UPDATE" && updating === undefined)) {
      await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [deleteRow] }));
      return;
    }
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [deleteRow, { Update: {
      TableName: dependencies.tableName, Key: taskKey(item.taskId),
      UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
      ConditionExpression: "workflow.revision = :revision AND workflow.#stage = :stage AND workflow.#state = :state AND attribute_not_exists(closedAt)",
      ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
      ExpressionAttributeValues: { ":workflow": updating === undefined ? blockWorkflow(workflow, reason, now) : blockWorkflowPullRequestUpdate(workflow, { numbers: [updating.number], now }), ":now": now,
        ":revision": item.workflowRevision, ":stage": stage, ":state": state },
    } }, ...dispatchExhaustRows(dependencies, item, workflow, exhaustedReason, now)] }));
    console.log(JSON.stringify({ component: "broker", event: "workflow.dispatch_gave_up", taskId: item.taskId, kind: item.kind, attempts }));
  } catch (error) {
    // A row or task that changed meanwhile is the newer writer's; anything else is retried by the next sweep.
    if (!isConditional(error)) {
      console.log(JSON.stringify({ component: "broker", event: "workflow.dispatch_failure_unrecorded", taskId: item.taskId, error: error instanceof Error ? error.name : "unknown" }));
    }
  }
}

/** Whether the company chose the plan check's model (its recipe step names one): only then is a refused model the company's to fix. */
export async function companyChoseCriticModel(dependencies: AwsBrokerDependencies, taskId: string): Promise<boolean> {
  const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(taskId));
  if (task?.orgId === undefined) return true;
  const frozen = await readTaskRecipe(dependencies, taskId, task.orgId);
  const step = frozen?.recipe.steps.find((candidate) => candidate.kind === "plan_critic");
  return step !== undefined && (step.settings as { model?: unknown } | undefined)?.model != null;
}

/**
 * Plan 6 Task 17: a merge of the base branch whose machine was lost (the row names the operation, which has ended without a result): it is judged as a finished one is, from what GitHub shows, and
 * recorded as Rovara's own when GitHub shows exactly the merge it asked for; with no result there is nothing to show that Rovara's checks passed, so no approval carries (`unverified`). GitHub
 * that cannot be read is tried again (the row backs off, and gives up by ending the merge). One transaction with the row's delete.
 */
export async function settleLostBranchSync(dependencies: AwsBrokerDependencies, task: DeveloperTaskRecord & { workflow: WorkflowSnapshot }, item: WorkflowDispatchRecord): Promise<"DISPATCHED" | "STALE" | "RETRY"> {
  const row = item as WorkflowDispatchRecord & { workspaceId?: unknown; operationId?: unknown };
  const deleteRow = { Delete: { TableName: dependencies.tableName, Key: { pk: item.pk, sk: item.sk } } };
  const operation = typeof row.workspaceId === "string" && typeof row.operationId === "string" ? await getItem<OperationRecord>(dependencies, operationKey(row.workspaceId, row.operationId)) : undefined;
  if (operation === undefined || !TERMINAL.has(operation.status) || operation.maintenance?.workflowSync === undefined) {
    // Not an operation that ended: nothing to judge, and the merge must not stay RUNNING for it.
    await endUnstartedBranchSync(dependencies, item);
    return "STALE";
  }
  const items = await completedBranchSyncItems(dependencies, operation, task, operation.status, new Date().toISOString(), undefined, operation.error, { lost: true });
  if (items.length === 0) {
    await endUnstartedBranchSync(dependencies, item);
    return "STALE";
  }
  await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [deleteRow, ...items] }));
  return "DISPATCHED";
}

/**
 * Plan 6 Task 17: a merge of the base branch that could not be started, however often it was tried: its dispatch row goes and the task waits for the merge again, as it did. One transaction, conditional on the
 * row and on the task still waiting to start exactly this merge; a task that moved on, or a row someone else took, is left alone.
 */
async function endUnstartedBranchSync(dependencies: AwsBrokerDependencies, item: WorkflowDispatchRecord, options: { gaveUp?: boolean } = {}): Promise<void> {
  const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(item.taskId));
  const workflow = task?.workflow;
  const deleteRow = { Delete: { TableName: dependencies.tableName, Key: { pk: item.pk, sk: item.sk } } };
  if (task === undefined || task.closedAt !== undefined || workflow === undefined || workflow.revision !== item.workflowRevision || workflow.stage !== "WAIT_FOR_MERGE"
    || (workflow.state !== "READY" && workflow.state !== "RUNNING") || workflow.branchSync === undefined) {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [deleteRow] }));
    return;
  }
  const now = new Date().toISOString();
  // A lost merge that GitHub could not be asked about through every retry may or may not have pushed: that is said (a stop), never left as a silent stall behind the guard that waits for the workflow to
  // learn the head. A merge that could not even be started is only tried again later, after a delay.
  const unsure = options.gaveUp === true && workflow.state === "RUNNING";
  const next = unsure ? blockWorkflowBranchSync(workflow, { reason: BRANCH_SYNC_UNSURE_MESSAGE, now }) : endWorkflowBranchSync(workflow, now, options.gaveUp === true ? { failed: "transient" } : {});
  const pullRequest = workflow.pullRequests?.find((entry) => entry.repositoryId === workflow.branchSync?.repositoryId && entry.number === workflow.branchSync.number);
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [deleteRow, { Update: {
      TableName: dependencies.tableName, Key: taskKey(item.taskId),
      UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
      ConditionExpression: "workflow.revision = :revision AND workflow.#stage = :stage AND workflow.#state = :state AND attribute_not_exists(closedAt)",
      ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
      ExpressionAttributeValues: { ":workflow": next, ":now": now, ":revision": item.workflowRevision, ":stage": "WAIT_FOR_MERGE", ":state": workflow.state },
    } }, ...(unsure && task.orgId !== undefined && pullRequest !== undefined ? codeMilestoneItems({ tableName: dependencies.tableName }, {
      kind: "stuck", orgId: task.orgId, taskId: task.taskId, ...(task.sessionId === undefined ? {} : { sessionId: task.sessionId }), at: now, text: BRANCH_SYNC_UNSURE_MESSAGE,
      pullRequests: [{ repository: pullRequest.repositoryId, number: pullRequest.number, url: pullRequest.url }],
    }, next.revision) : [])] }));
  } catch (error) {
    if (!isConditional(error)) console.log(JSON.stringify({ component: "broker", event: "workflow.branch_sync_end_failed", taskId: item.taskId, error: error instanceof Error ? error.name : "unknown" }));
  }
}

/**
 * Plan 6 Task 8: the plan check can't be started (its start was given up, or no model Rovara could recommend is usable): its dispatch row goes and the plan goes to the person at PLAN_REVIEW, shown
 * as not checked. One transaction, conditional on the row and on the task still waiting for exactly this check; a task that moved on, or a row someone else took, is left alone.
 */
export async function closeUncheckedPlanCheck(dependencies: AwsBrokerDependencies, item: WorkflowDispatchRecord, reason?: "no_model_source"): Promise<void> {
  const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(item.taskId));
  const workflow = task?.workflow;
  const deleteRow = { Delete: { TableName: dependencies.tableName, Key: { pk: item.pk, sk: item.sk } } };
  if (task === undefined || task.closedAt !== undefined || workflow === undefined || workflow.revision !== item.workflowRevision || workflow.stage !== "PLAN_CRITIQUE" || workflow.state !== "READY") {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [deleteRow] }));
    return;
  }
  const now = new Date().toISOString();
  const next = closeUnstartedCheck(workflow, now, reason);
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [deleteRow, { Update: {
      TableName: dependencies.tableName, Key: taskKey(item.taskId),
      UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
      ConditionExpression: "workflow.revision = :revision AND workflow.#stage = :stage AND workflow.#state = :state AND attribute_not_exists(closedAt)",
      ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
      ExpressionAttributeValues: { ":workflow": next, ":now": now, ":revision": item.workflowRevision, ":stage": "PLAN_CRITIQUE", ":state": "READY" },
    } }] }));
  } catch (error) {
    // A task that moved meanwhile is the newer writer's; anything else is tried again by the next sweep.
    if (!isConditional(error)) console.log(JSON.stringify({ component: "broker", event: "workflow.plan_check_close_failed", taskId: item.taskId, error: error instanceof Error ? error.name : "unknown" }));
  }
}

/**
 * Run one dispatch row: start its step if the task is still exactly where the row says, then delete the row.
 * STALE (the task moved on, closed, or never matched) deletes the row too; RETRY keeps it for the sweep. Never throws.
 */
export type AccessPausedWorkflowDispatch = WorkflowDispatchRecord & { taskAccessPausedAt?: string };

/** A deterministic source-reference mismatch returns the same owner-approved candidate to plan review. */
export async function returnWorkflowToCorrectE2EPlan(dependencies: AwsBrokerDependencies, item: WorkflowDispatchRecord,
  correction: { reasonCode: string; /** Why, when it is not the portable reference text. */ blockReason?: string }): Promise<boolean> {
  if (item.kind !== "CHECKS") return false;
  const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(item.taskId));
  const workflow = task?.workflow;
  const artifact = workflow?.artifacts.filter((entry) => entry.type === "plan").at(-1);
  if (task === undefined || task.closedAt !== undefined || workflow === undefined || artifact === undefined
    || workflow.revision !== item.workflowRevision || workflow.stage !== "VERIFY" || workflow.state !== "WAITING"
    || workflow.e2e?.required !== true || workflow.candidate?.digest !== item.candidateDigest) return false;
  const {
    e2e: _e2e, verification: _verification, reviews: _reviews, acceptedFindings: _acceptedFindings,
    regressedChecks: _regressedChecks, workflowDependenciesApproval: _workflowDependenciesApproval,
    workflowDependenciesOperationId: _workflowDependenciesOperationId,
    workflowDependenciesProgress: _workflowDependenciesProgress, feedbackDispatchApproval: _feedbackDispatchApproval,
    outcome: _outcome, ...retained
  } = workflow;
  void _e2e; void _verification; void _reviews; void _acceptedFindings; void _regressedChecks;
  void _workflowDependenciesApproval; void _workflowDependenciesOperationId; void _workflowDependenciesProgress;
  void _feedbackDispatchApproval; void _outcome;
  const now = new Date().toISOString();
  const next = WorkflowSnapshotSchema.parse({ ...retained, revision: workflow.revision + 1, stage: "PLAN_REVIEW", state: "WAITING",
    updatedAt: now, blockReason: correction.blockReason ?? E2E_PLAN_REFERENCE_INVALID_BLOCK_REASON });
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Delete: { TableName: dependencies.tableName, Key: { pk: item.pk, sk: item.sk },
        ConditionExpression: "attribute_exists(pk) AND workflowRevision = :revision AND #kind = :checks AND candidateDigest = :candidate",
        ExpressionAttributeNames: { "#kind": "kind" }, ExpressionAttributeValues: {
          ":revision": item.workflowRevision, ":checks": "CHECKS", ":candidate": item.candidateDigest,
        } } },
      { Update: { TableName: dependencies.tableName, Key: taskKey(item.taskId),
        UpdateExpression: "SET workflow = :workflow, e2ePlanCorrection = :correction, updatedAt = :now",
        ConditionExpression: "workflow.revision = :revision AND workflow.#stage = :verify AND workflow.#state = :waiting AND workflow.e2e.required = :required AND workflow.candidate.digest = :candidate AND attribute_not_exists(closedAt)",
        ExpressionAttributeNames: { "#stage": "stage", "#state": "state" }, ExpressionAttributeValues: {
          ":workflow": next, ":correction": { artifactId: artifact.id, artifactSha256: artifact.sha256,
            candidateDigest: item.candidateDigest, reasonCode: correction.reasonCode, requiredE2E: true }, ":now": now,
          ":revision": item.workflowRevision, ":verify": "VERIFY", ":waiting": "WAITING", ":required": true,
          ":candidate": item.candidateDigest,
        } } },
    ] }));
    console.log(JSON.stringify({ component: "broker", event: "workflow.e2e_plan_reference_rejected", taskId: item.taskId,
      reasonCode: correction.reasonCode, artifactId: artifact.id }));
    return true;
  } catch (caught) {
    if (isConditional(caught)) return false;
    throw caught;
  }
}

export type WorkflowE2EReadinessResult = { status: "WAITING" } | { status: "STALE" } | { status: "READY"; task: DeveloperTaskRecord };

export async function blockWorkflowE2EReadiness(dependencies: AwsBrokerDependencies, item: WorkflowDispatchRecord, reason: string): Promise<void> {
  const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(item.taskId));
  const workflow = task?.workflow;
  if (task === undefined || task.closedAt !== undefined || workflow === undefined || workflow.revision !== item.workflowRevision
    || workflow.stage !== "VERIFY" || workflow.state !== "WAITING" || workflow.candidate?.digest !== item.candidateDigest) {
    await dependencies.documentClient.send(new DeleteCommand({ TableName: dependencies.tableName, Key: { pk: item.pk, sk: item.sk },
      ConditionExpression: "attribute_exists(pk) AND workflowRevision = :revision AND candidateDigest = :candidate",
      ExpressionAttributeValues: { ":revision": item.workflowRevision, ":candidate": item.candidateDigest } }));
    return;
  }
  const now = new Date().toISOString();
  const blocked = blockWorkflow(workflow, reason, now);
  await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
    { Delete: { TableName: dependencies.tableName, Key: { pk: item.pk, sk: item.sk },
      ConditionExpression: "attribute_exists(pk) AND workflowRevision = :revision AND candidateDigest = :candidate",
      ExpressionAttributeValues: { ":revision": item.workflowRevision, ":candidate": item.candidateDigest } } },
    { Update: { TableName: dependencies.tableName, Key: taskKey(item.taskId),
      UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
      ConditionExpression: "workflow.revision = :revision AND workflow.#stage = :verify AND workflow.#state = :waiting AND workflow.candidate.digest = :candidate AND attribute_not_exists(closedAt)",
      ExpressionAttributeNames: { "#stage": "stage", "#state": "state" }, ExpressionAttributeValues: {
        ":workflow": blocked, ":now": now, ":revision": item.workflowRevision,
        ":verify": "VERIFY", ":waiting": "WAITING", ":candidate": item.candidateDigest,
      } } },
    // AUTOFIX (LIVEFIX-1): a block written here, before the round started, is looked at by the automatic-fix policy exactly like one a finished run writes: it sends the work back, retries, or
    // asks. The row commits with the block, so no blocked VERIFY step is left for nobody to decide.
    ...(dependencies.autofix?.enabled === true && blocked.fixSource === undefined && (blocked.pullRequests?.length ?? 0) === 0 ? [workflowDispatchItem(dependencies.tableName, item.taskId, blocked.revision, "AUTOFIX", blocked.candidate?.digest ?? "0".repeat(64), now)] : []),
  ] }));
  // Run the look right away (never throws); the recovery sweep is the fallback if this is lost.
  if (dependencies.autofix?.enabled === true) await dispatchWorkflowContinuation(dependencies, item.taskId);
}

/**
 * The transaction check that keeps an `org-role` proof honest at commit: the creator's member record must still name the role and the
 * time the proof saw. A demotion, or a role changed and changed back, fails it.
 */
export function orgRoleAuthorityCheck(tableName: string, proof: { developerId: string; orgId: OrgId; role: "owner" | "admin"; memberUpdatedAt: string }): Record<string, unknown> {
  return { ConditionCheck: { TableName: tableName, Key: orgMemberKey(proof.orgId, proof.developerId),
    ConditionExpression: "developerId = :developer AND #role = :role AND (roleUpdatedAt = :updatedAt OR (attribute_not_exists(roleUpdatedAt) AND joinedAt = :updatedAt))",
    ExpressionAttributeNames: { "#role": "role" },
    ExpressionAttributeValues: { ":developer": proof.developerId, ":role": proof.role, ":updatedAt": proof.memberUpdatedAt } } };
}

/**
 * Required native E2E rounds are admitted only after the existing EC2 outbox path reports the exact
 * READY session generation. The readiness operation has no feature payload and never reaches a worker.
 */
/** Rechecks the original task creator's live project grant before warm-up and round admission. */
export async function requireWorkflowE2ECreatorAuthority(dependencies: AwsBrokerDependencies, task: DeveloperTaskRecord) {
  // The proofs are the task's owner now: the person who took it over, else its creator (Plan 5 Task 12a).
  const owner = effectiveTaskOwner(task);
  const creatorRecord = await getWorkflowE2ECreatorIdentity(dependencies, owner.developerId);
  if (creatorRecord?.revoked === true) {
    throw agentXError("TASK_ACCESS_DENIED", "the original task creator's account has been revoked");
  }
  if (creatorRecord === undefined || dependencies.developer === undefined) {
    throw agentXError("RUNTIME_UNAVAILABLE", "the original creator identity is unavailable for this E2E round");
  }
  const orgId = await orgOfRecord(dependencies, task);
  // The creator's live org role, read afresh on every round (finding 5): a demoted or removed creator loses an org-role proof here.
  const creatorOrgMember = await readOrgMember(dependencies, orgId, owner.developerId);
  let creatorAccess: Awaited<ReturnType<typeof checkProjectAccess>>;
  try {
    creatorAccess = await checkProjectAccess({ documentClient: dependencies.documentClient, tableName: dependencies.tableName,
      developer: dependencies.developer, now: Date.now },
    { orgId, developerId: owner.developerId, orgRole: creatorOrgMember?.role ?? "member", ...(creatorRecord.slackUserId === undefined ? {} : { slackUserId: creatorRecord.slackUserId }) }, task.project);
  } catch (error) {
    if (error instanceof AgentXError && error.code === "PROJECT_ACCESS_DENIED") {
      throw agentXError("TASK_ACCESS_DENIED", "the original creator no longer has current access to this task's project");
    }
    throw agentXError("RUNTIME_UNAVAILABLE", "the original creator's current project access is unavailable");
  }
  // A creator lowered to viewer still passes the access check (a viewer sees the project) but takes no part in running work: say so.
  if (!projectAllows(creatorAccess.role, "start_tasks")) {
    throw agentXError("TASK_ACCESS_DENIED", "the original creator can now only view this task's project and can no longer run its checks");
  }
  const creatorMembership = await getItem<Record<string, unknown>>(dependencies, projectMemberKey(orgId, owner.developerId, task.project));
  const creatorAuthority = await workflowE2ECreatorAuthorityProof(dependencies, task, creatorMembership, creatorAccess, creatorOrgMember);
  if (creatorAuthority === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the creator has no versioned direct or locally bound channel access proof for this E2E round");
  return creatorAuthority;
}

export async function ensureWorkflowE2EComputeReadiness(
  dependencies: AwsBrokerDependencies,
  routeDependencies: Parameters<typeof startTaskWorkflowE2EChecksFromSystem>[0],
  item: WorkflowDispatchRecord,
): Promise<WorkflowE2EReadinessResult> {
  const dispatchKey = { pk: item.pk, sk: item.sk };
  const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(item.taskId));
  const workflow = task?.workflow;
  if (task === undefined || task.closedAt !== undefined || workflow === undefined || workflow.revision !== item.workflowRevision
    || workflow.stage !== "VERIFY" || workflow.state !== "WAITING" || workflow.e2e?.required !== true
    || workflow.candidate?.digest !== item.candidateDigest) return { status: "STALE" };
  const row = await getItem<WorkflowDispatchRecord>(dependencies, dispatchKey);
  if (row === undefined || row.workflowRevision !== item.workflowRevision || row.kind !== "CHECKS" || row.candidateDigest !== item.candidateDigest) {
    return { status: "STALE" };
  }
  // Keep the original creator's current project access in front of every warm-up start or resume.
  // The feature-round admission rechecks this authority again after compute becomes ready.
  await requireWorkflowE2ECreatorAuthority(dependencies, task);
  // An approved application plan is checked, and refused, before any compute is woken for it: after the staleness and creator checks above (a revoked creator
  // is paused for access, whatever the plan), before the warm-up below.
  await refuseApplicationRoundBeforeWarmUp(dependencies, task);
  if (row.readinessOperationId === undefined) {
    const accessFence = await systemTaskDispatchAccessFence(routeDependencies, task);
    const workspaceResult = await dependencies.documentClient.send(new GetCommand({ TableName: dependencies.tableName,
      Key: workspaceKey(task.workspaceId), ConsistentRead: true }));
    const workspace = WorkspaceInstanceSchema.safeParse(workspaceResult.Item === undefined ? undefined : workspaceRecordFields(workspaceResult.Item));
    if (!workspace.success || !["READY", "STOPPED"].includes(workspace.data.status) || workspace.data.activeOperationId !== null) {
      throw agentXError("WORKSPACE_BUSY", "the task workspace cannot start its bounded E2E readiness operation");
    }
    const now = new Date().toISOString();
    const marker: WorkflowE2EReadinessMarker = { purpose: "workflow-e2e-readiness", taskId: item.taskId,
      workflowRevision: item.workflowRevision, candidateDigest: item.candidateDigest, dispatchSk: item.sk };
    const operationId = workflowRequestId("agentx-workflow-e2e-readiness", item.taskId, item.workflowRevision, item.candidateDigest);
    const requestId = operationId;
    const fence = workspace.data.fence + 1;
    const operation = operationRecord({ ...operationOrg(workspace.data), id: operationId, workspaceId: task.workspaceId, kind: "resume", requestId,
      payloadHash: hashJson(marker), status: "ACCEPTED", fence, createdAt: now, updatedAt: now });
    const outboxId = workflowRequestId("agentx-workflow-e2e-readiness-outbox", item.taskId, item.workflowRevision, item.candidateDigest);
    operation.workflowE2EReadiness = { ...marker, outboxId };
    const invocation: WorkerInvocation = { protocolVersion: AGENTX_PROTOCOL_VERSION, kind: "resume", operationId,
      workspaceId: task.workspaceId, fence, projectRevision: workspace.data.projectRevision,
      callbackCapability: issueCapability(dependencies, task.workspaceId, operationId, fence), payload: {} };
    const generatedOutbox = outboxRecord(workspace.data, invocation);
    const outbox = { ...generatedOutbox, id: outboxId, pk: `OUTBOX#${outboxId}`, workflowE2EReadiness: marker };
    try {
      await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
        { ConditionCheck: { TableName: dependencies.tableName, Key: taskKey(item.taskId),
          ConditionExpression: "workflow.revision = :revision AND workflow.#stage = :verify AND workflow.#state = :waiting AND workflow.e2e.required = :required AND workflow.candidate.digest = :candidate AND attribute_not_exists(closedAt)",
          ExpressionAttributeNames: { "#stage": "stage", "#state": "state" }, ExpressionAttributeValues: {
            ":revision": item.workflowRevision, ":verify": "VERIFY", ":waiting": "WAITING", ":required": true, ":candidate": item.candidateDigest,
          } } },
        { Update: { TableName: dependencies.tableName, Key: workspaceKey(task.workspaceId),
          UpdateExpression: "SET #status = :busy, activeOperationId = :operation, fence = :fence, updatedAt = :now",
          ConditionExpression: "attribute_not_exists(activeOperationId) AND (#status = :ready OR #status = :stopped) AND fence = :previousFence",
          ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: {
            ":busy": "BUSY", ":ready": "READY", ":stopped": "STOPPED", ":operation": operationId,
            ":fence": fence, ":previousFence": workspace.data.fence, ":now": now,
          } } },
        { Put: { TableName: dependencies.tableName, Item: operation, ConditionExpression: "attribute_not_exists(pk)" } },
        { Put: { TableName: dependencies.tableName, Item: outbox, ConditionExpression: "attribute_not_exists(pk)" } },
        { Update: { TableName: dependencies.tableName, Key: dispatchKey,
          UpdateExpression: "SET readinessOperationId = :operation",
          ConditionExpression: "attribute_not_exists(readinessOperationId) AND workflowRevision = :revision AND #kind = :checks AND candidateDigest = :candidate",
          ExpressionAttributeNames: { "#kind": "kind" }, ExpressionAttributeValues: {
            ":operation": operationId, ":revision": item.workflowRevision, ":checks": "CHECKS", ":candidate": item.candidateDigest,
          } } },
        ...(accessFence === undefined ? [] : [accessFence]),
      ] }));
    } catch (error) {
      if (!isConditional(error)) throw error;
      const current = await getItem<WorkflowDispatchRecord>(dependencies, dispatchKey);
      return current?.readinessOperationId === undefined ? { status: "WAITING" } : { status: "WAITING" };
    }
    return { status: "WAITING" };
  }

  const operation = await getItem<OperationRecord>(dependencies, operationKey(task.workspaceId, row.readinessOperationId));
  const marker = operation?.workflowE2EReadiness;
  const expectedMarker = { purpose: "workflow-e2e-readiness", taskId: item.taskId, workflowRevision: item.workflowRevision,
    candidateDigest: item.candidateDigest, dispatchSk: item.sk } as const;
  if (operation === undefined || operation.kind !== "resume" || marker === undefined || marker.purpose !== expectedMarker.purpose
    || marker.taskId !== expectedMarker.taskId || marker.workflowRevision !== expectedMarker.workflowRevision
    || marker.candidateDigest !== expectedMarker.candidateDigest || marker.dispatchSk !== expectedMarker.dispatchSk
    || marker.outboxId !== workflowRequestId("agentx-workflow-e2e-readiness-outbox", item.taskId, item.workflowRevision, item.candidateDigest)) {
    await blockWorkflowE2EReadiness(dependencies, item, "E2E compute readiness could not be verified; no feature round was admitted.");
    return { status: "STALE" };
  }
  if (operation.status !== "SUCCEEDED") {
    if (["FAILED", "CANCELLED", "INTERRUPTED"].includes(operation.status)) {
      await blockWorkflowE2EReadiness(dependencies, item, "E2E compute readiness failed; no feature round was admitted.");
      return { status: "STALE" };
    }
    return { status: "WAITING" };
  }
  const generation = marker.readyGeneration;
  if (!Number.isInteger(generation) || generation! < 1) {
    await blockWorkflowE2EReadiness(dependencies, item, "E2E compute readiness completed without a valid READY session witness.");
    return { status: "STALE" };
  }
  const accessFence = await systemTaskDispatchAccessFence(routeDependencies, task);
  const now = new Date().toISOString();
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Update: { TableName: dependencies.tableName, Key: workspaceSessionKey(task.workspaceId),
        UpdateExpression: "SET lastActivityAt = :now",
        ConditionExpression: "#state = :ready AND generation = :generation",
        ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":now": now, ":ready": "READY", ":generation": generation } } },
      { ConditionCheck: { TableName: dependencies.tableName, Key: taskKey(item.taskId),
        ConditionExpression: "workflow.revision = :revision AND workflow.#stage = :verify AND workflow.#state = :waiting AND workflow.e2e.required = :required AND workflow.candidate.digest = :candidate AND attribute_not_exists(closedAt)",
        ExpressionAttributeNames: { "#stage": "stage", "#state": "state" }, ExpressionAttributeValues: {
          ":revision": item.workflowRevision, ":verify": "VERIFY", ":waiting": "WAITING", ":required": true, ":candidate": item.candidateDigest,
        } } },
      { ConditionCheck: { TableName: dependencies.tableName, Key: dispatchKey,
        ConditionExpression: "readinessOperationId = :operation AND workflowRevision = :revision AND candidateDigest = :candidate",
        ExpressionAttributeValues: { ":operation": row.readinessOperationId, ":revision": item.workflowRevision, ":candidate": item.candidateDigest } } },
      ...(accessFence === undefined ? [] : [accessFence]),
    ] }));
  } catch (error) {
    if (!isConditional(error)) throw error;
    const session = await getItem<{ state?: unknown; generation?: unknown }>(dependencies, workspaceSessionKey(task.workspaceId));
    if (session?.state !== "READY" || session.generation !== generation) {
      await blockWorkflowE2EReadiness(dependencies, item, "The exact E2E-ready compute session is no longer available; no feature round was admitted.");
      return { status: "STALE" };
    }
    return { status: "WAITING" };
  }
  const freshTask = await getItem<DeveloperTaskRecord>(dependencies, taskKey(item.taskId));
  if (freshTask === undefined || freshTask.closedAt !== undefined || freshTask.workflow?.revision !== item.workflowRevision
    || freshTask.workflow.stage !== "VERIFY" || freshTask.workflow.state !== "WAITING"
    || freshTask.workflow.candidate?.digest !== item.candidateDigest) return { status: "STALE" };
  return { status: "READY", task: freshTask };
}
