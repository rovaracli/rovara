// Part of the broker (split out of ../broker.ts): agent run, workflow and autofix dispatch.

import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { AgentXError, BUDGET_EXHAUSTED_FAILURE_MESSAGE, type IntentAssessment, UNDERSTAND_ARTIFACT_MAX_BYTES, UNDERSTAND_ARTIFACT_NAME, endStuckUnderstand, readIntentArtifact, agentXError, type WorkflowSnapshot, E2E_MODEL_ROUTE_DEFAULT_BUDGETS } from "@agentx/contracts";
import { StoredBaselineSourceSchema } from "../baseline-source.js";
import { queryAllItems } from "../admin-reads.js";
import { z } from "zod";
import type { DeveloperRecord } from "../../developer/store.js";
import { requireOrgId } from "../../org/resolve.js";
import { E2EPortablePlanReferenceError } from "../../e2e/feature-plan-intent.js";
import { TERMINAL, getItem, operationKey, type OperationRecord } from "../cancellation.js";
import { driveAgentRun } from "../../agents/run-engine.js";
import { END_LEASE_MS, type TaskEndOutcome } from "../../agents/task-end.js";
import { taskKey, taskAgentRunKey, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { operationEndDispatchItem, type WorkflowDispatchRecord, isConditional } from "../broker-shared.js";
import { recycleDriftedWorker, requalifyHoldActive } from "../../e2e/requalify-hold.js";
import { ApplicationDispatchRefusal, ApplicationPlanDefect } from "../../e2e/application-dispatch-check.js";
import { deriveE2EAgentRoute, e2eDayBudgetRoom } from "../../e2e/model-route-registry.js";
import { readTaskRecipe } from "../../agents/runs.js";
import { PlanCheckUnavailableError } from "../../rovara-code/critic.js";
import { developerTaskRouteDependencies } from "../developer-routes.js";
import type { EndTold } from "../developer-tasks.js";
import { startTaskWorkflowPlanRevisionFromSystem, finishedReleaseMarkItem, noteTaskEnded, startTaskWorkflowImplementationFromSystem, startTaskWorkflowPlanFromSystem, startTaskWorkflowPublicationFromSystem, startTaskWorkflowUnderstandFromSystem, startTaskWorkflowPlanCritiqueFromSystem, startTaskWorkflowBranchSyncFromSystem, startTaskWorkflowCriticRevisionFromSystem, startTaskWorkflowReviewFromSystem, workflowEndOutcome, taskPageUrl } from "../developer-tasks.js";
import { AUTOFIX_ROUND_ESTIMATE_USD, autofixDayBudgetNeed, postponeAutofixRow, recordAutofixGiveUpAsk, runWorkflowAutofix, type AutofixDependencies } from "../workflow-autofix-runner.js";
import { taskAutonomy } from "../../rovara-code/ci-fix.js";
import { blockedByEnvironmentHook } from "../../test-env/health-wiring.js";
import { autofixBlockCauseOf, autofixRowHeld } from "../workflow-autofix-dispatch-exhaust.js";
import { cancelRunningTask } from "./acceptance.js";
import type { AwsBrokerDependencies } from "./definitions.js";
import { agentRouteDependencies, developerTaskActions } from "./dependency-wiring.js";
import { candidateSourceOperation, runGroundingStep, startWorkflowE2EChecksDispatch } from "./e2e-rounds.js";
import { readStoredBytes } from "./evidence-and-setup.js";
import { companyAutonomyLimit, ownerCallerOf } from "./feedback-and-codebuild.js";
import { readObjectText } from "./plan-answers.js";
import { requireWorkspace } from "./records.js";
import { ec2Sessions } from "./runtime-clients.js";
import { canReadBaseBranchHead, changeRequestRef, hostNameOf, hostOfTaskRepository } from "./repository-hosts.js";
import { githubScopeOf, webhookRepositoryUrl } from "./scope-helpers.js";
import { workflowApplicationRouteDependencies } from "./slack-workflow-events.js";
import { blockWorkflowE2EReadiness, closeUncheckedPlanCheck, companyChoseCriticModel, ensureWorkflowE2EComputeReadiness, recordWorkflowDispatchFailure, returnWorkflowToCorrectE2EPlan, settleLostBranchSync, type AccessPausedWorkflowDispatch } from "./sweeps-and-readiness.js";
import { refreshTaskFeedbackForOwnerDecision, refusalText, releaseIfFinished } from "./terminal-and-github-events.js";
import { blockEndedOperationKeys, tellTaskStop } from "./terminal-result.js";
import { loadWorkflowE2EScenarioResults, workflowE2EPresentation, workflowE2EPublicationChecks } from "./workflow-e2e-verification.js";
import { specSeamsOf } from "./spec-wiring.js";
import { evidenceRouteDependencies } from "./evidence-wiring.js";
import { fixSetupDependencies } from "./fix-setup-wiring.js";

/**
 * Plan 3, Task 22: the agent-step engine's row. It runs the engine for the task (the result of a step that ended, the next step, an end whose follow-up is not
 * done, the watchdog of a step whose result never came) and leaves the row as the engine writes it; the engine deletes it when the run is over or paused.
 */
async function runAgentRunDispatch(dependencies: AwsBrokerDependencies, item: WorkflowDispatchRecord): Promise<"DISPATCHED" | "STALE" | "RETRY"> {
  const agents = agentRouteDependencies(dependencies, developerTaskActions(dependencies));
  if (agents === undefined) return "RETRY";
  try {
    return await driveAgentRun(agents, item.taskId) === "STALE" ? "STALE" : "DISPATCHED";
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "agent_run.drive_failed", taskId: item.taskId, error: error instanceof Error ? error.name : "unknown" }));
    await recordWorkflowDispatchFailure(dependencies, item);
    return "RETRY";
  }
}

/**
 * The end a task is owed for the kind of row that names it (`endOf`), or undefined when it is owed none (the row is stale): `closed` when the task is closed, `creator_removed`
 * when that was its outcome, and for `workflow` what its workflow ended as (never an agent-step run's, which its engine tells).
 */
function taskEndOwed(task: DeveloperTaskRecord, endOf: "closed" | "workflow" | "creator_removed"): TaskEndOutcome | undefined {
  if (endOf === "closed") return task.closedAt === undefined ? undefined : "closed";
  if (endOf === "creator_removed") return task.outcome === "creator_removed" ? "creator_removed" : undefined;
  return task.agentRunEnd === undefined ? workflowEndOutcome(task) : undefined;
}

/**
 * Plan 3, Task 22 (review I2): a task's operation ended in a Lambda that has no model proxy (the reaper, the dispatcher, the stuck-cancel sweep), which left this
 * row. The operation's model keys are blocked here, and the task's end is told as a result the broker heard itself would tell it (the first end a task has is the
 * one told). Both never throw, so a lost proxy is the key expiry's backstop, as for a result the broker heard. The row goes only when the end is finished (every
 * handler heard it, or none listens): while another call is telling it, the row is due again when that call's lease could have run out; when a handler threw, it
 * is tried again with the row's backoff (Task 22 re-check, N1).
 */
async function runOperationEndDispatch(dependencies: AwsBrokerDependencies, item: WorkflowDispatchRecord): Promise<"DISPATCHED" | "STALE" | "RETRY"> {
  const row = item as WorkflowDispatchRecord & { orgId?: unknown; workspaceId?: unknown; operationId?: unknown; endOf?: unknown };
  const key = { pk: item.pk, sk: item.sk };
  try {
    let told: EndTold;
    let orgId: string;
    if (row.endOf === "closed" || row.endOf === "workflow" || row.endOf === "creator_removed") {
      // M-6 (m-2): the `closed` end of a plain task whose close could not finish telling it; Plan 5 Task 7b (the Task 22 hand-off): the end of a workflow task that merged
      // or closed, and of a task whose creator was removed. The task, not an operation, is what is looked at, and the end it is owed is worked out from it now.
      const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(item.taskId));
      let outcome = task === undefined || task.orgId === undefined || task.orgId !== row.orgId ? undefined : taskEndOwed(task, row.endOf);
      // A removed creator's agent-step run is ended, and its end told, by its engine (the check that refuses it ends the run): a row left because the run could not be read
      // is not told here. A read that fails here throws, and the row is tried again.
      if (outcome === "creator_removed" && task?.agent !== undefined && await getItem(dependencies, taskAgentRunKey(item.taskId)) !== undefined) outcome = undefined;
      if (task === undefined || task.orgId === undefined || outcome === undefined) {
        await dependencies.documentClient.send(new DeleteCommand({ TableName: dependencies.tableName, Key: key }));
        return "STALE";
      }
      orgId = task.orgId;
      told = await noteTaskEnded(dependencies, task, outcome);
    } else {
      const operation = typeof row.workspaceId === "string" && typeof row.operationId === "string"
        ? await getItem<OperationRecord>(dependencies, operationKey(row.workspaceId, row.operationId)) : undefined;
      if (operation === undefined || !TERMINAL.has(operation.status) || operation.orgId === undefined || operation.orgId !== row.orgId) {
        await dependencies.documentClient.send(new DeleteCommand({ TableName: dependencies.tableName, Key: key }));
        return "STALE";
      }
      await blockEndedOperationKeys(dependencies, operation);
      orgId = operation.orgId;
      told = await tellTaskStop(dependencies, operation, item.taskId, operation.status, operation.kind === "task" && operation.workflowMode !== "PLAN_CRITIQUE" && operation.planRevision !== true && operation.status === "FAILED" && operation.error === BUDGET_EXHAUSTED_FAILURE_MESSAGE);
    }
    if (told === "in_progress") {
      // Another call holds the end and may die with it: the row stays, due when its lease could have run out, so whoever looks then finishes the end.
      await dependencies.documentClient.send(new PutCommand({ TableName: dependencies.tableName, Item: (operationEndDispatchItem(dependencies.tableName, {
        taskId: item.taskId, orgId, workspaceId: String(row.workspaceId), operationId: String(row.operationId), now: new Date().toISOString(), dueAt: new Date(Date.now() + END_LEASE_MS + 5_000).toISOString(),
        ...(row.endOf === "closed" || row.endOf === "workflow" || row.endOf === "creator_removed" ? { endOf: row.endOf } : {}),
      }) as { Put: { Item: Record<string, unknown> } }).Put.Item }));
      return "RETRY";
    }
    if (told === "failed") {
      // A handler threw: tried again with the row's backoff, and dropped (the keys are already blocked) when its tries are used up.
      await recordWorkflowDispatchFailure(dependencies, item);
      return "RETRY";
    }
    await dependencies.documentClient.send(new DeleteCommand({ TableName: dependencies.tableName, Key: key }));
    return "DISPATCHED";
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "operation_end.dispatch_failed", taskId: item.taskId, error: error instanceof Error ? error.name : "unknown" }));
    await recordWorkflowDispatchFailure(dependencies, item);
    return "RETRY";
  }
}

/**
 * Plan 6 Task 4: Understand never came back by its time limit (its worker was lost, or its result never reached the broker). The task ends, closed, with the reason; the row goes and the
 * task is marked as waiting for its release, all in the same commit, so a stop right after it loses neither. A task that moved on meanwhile (the result arrived) makes the commit fail its
 * condition: the row is stale and goes.
 *
 * The run is normally still on record as active (that is why no result came), and a workspace with an active run is not released ("busy"). So the run is stopped through the cancel
 * every owner's Cancel uses; its result (or, for a worker that is gone, the existing stuck-cancel handling) ends the operation, and the release then goes through, by that result and by the
 * release sweep's mark. Until the run has ended the slot is held.
 */
async function endStuckUnderstanding(dependencies: AwsBrokerDependencies, task: DeveloperTaskRecord & { workflow: WorkflowSnapshot }, item: WorkflowDispatchRecord): Promise<"DISPATCHED" | "STALE" | "RETRY"> {
  const now = new Date().toISOString();
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: dependencies.tableName, Key: taskKey(task.taskId),
        UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
        ConditionExpression: "workflow.revision = :revision AND workflow.#stage = :understand AND workflow.#state = :running AND attribute_not_exists(closedAt)",
        ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
        ExpressionAttributeValues: { ":workflow": endStuckUnderstand(task.workflow, now), ":now": now, ":revision": task.workflow.revision, ":understand": "UNDERSTAND", ":running": "RUNNING" },
      } },
      { Delete: { TableName: dependencies.tableName, Key: { pk: item.pk, sk: item.sk } } },
      finishedReleaseMarkItem(dependencies.tableName, task.taskId, now),
    ] }));
  } catch (error) {
    if (!isConditional(error)) throw error;
    await dependencies.documentClient.send(new DeleteCommand({ TableName: dependencies.tableName, Key: { pk: item.pk, sk: item.sk } }));
    return "STALE";
  }
  console.log(JSON.stringify({ component: "broker", event: "workflow.understand_timed_out", taskId: task.taskId }));
  try {
    const workspace = await requireWorkspace(dependencies, task.workspaceId);
    if (workspace.activeOperationId) await cancelRunningTask(dependencies, workspace, {});
  } catch (error) {
    // The task has ended; a run that could not be asked to stop is the release sweep's to find (its mark is written), and the reaper's.
    console.log(JSON.stringify({ component: "broker", event: "workflow.understand_stop_failed", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" }));
  }
  await releaseIfFinished(dependencies, task.taskId);
  return "DISPATCHED";
}

/** How long a row that is waiting for its machine to be prepared is put off. */
const WAIT_FOR_MACHINE_MS = 2 * 60_000;

/** Puts a waiting dispatch row's next sweep off, conditional on the attempts it was read with (a row someone else moved is left to them). */
async function waitForMachine(dependencies: AwsBrokerDependencies, item: WorkflowDispatchRecord): Promise<void> {
  const next = new Date(Date.now() + WAIT_FOR_MACHINE_MS).toISOString();
  try {
    await dependencies.documentClient.send(new UpdateCommand({
      TableName: dependencies.tableName, Key: { pk: item.pk, sk: item.sk },
      UpdateExpression: "SET nextAttemptAt = :next, dispatchDueSk = :due",
      ConditionExpression: "attribute_exists(pk) AND (attempts = :attempts OR (attribute_not_exists(attempts) AND :attempts = :zero))",
      ExpressionAttributeValues: { ":next": next, ":due": `${next}#${item.sk}`, ":attempts": item.attempts ?? 0, ":zero": 0 },
    }));
  } catch (error) {
    if (!isConditional(error)) throw error;
  }
}

/**
 * The commit a pull request's base branch is at now (Plan 6 Task 17), which is the commit a merge of the base takes. The base is an ordinary branch (`main`, `release/2026-11`): it is read with the
 * port's `baseBranchHead` (P6), not `branchHead`, which GitHub's provider answers for Rovara's own `agentx/<uuid>` branches only and refuses any other name. The host is the one the repository's record
 * names; an unknown host kind is refused with the router's fixed sentence.
 */
export function currentBaseCommitOf(dependencies: AwsBrokerDependencies): (target: DeveloperTaskRecord, pullRequest: { repositoryId: string; number: number }) => Promise<string> {
  return async (target, pullRequest) => {
    const url = await webhookRepositoryUrl(dependencies)(target.project, target.startingRevision, pullRequest.repositoryId, target.orgId);
    if (url === undefined) throw agentXError("CONFIG_INVALID", "the pull request's repository is not in the task's project");
    const scope = await githubScopeOf(dependencies, target);
    const host = await hostOfTaskRepository(dependencies, target, { name: pullRequest.repositoryId, url });
    const remote = await host.getChangeRequest(changeRequestRef(url, pullRequest.number), scope);
    if (!canReadBaseBranchHead(dependencies, host) || typeof remote.targetBranch !== "string") throw agentXError("RUNTIME_UNAVAILABLE", `${hostNameOf(host)} cannot say what the base branch is at`);
    return host.baseBranchHead({ url }, remote.targetBranch, scope);
  };
}

/** The assessment a finished Understand run saved, read from its artifact and checked here (never taken from the worker's word): undefined when it is missing, too long, not JSON or not valid. */
export async function readUnderstandingArtifact(dependencies: AwsBrokerDependencies, operation: OperationRecord): Promise<{ assessment: IntentAssessment; artifact: { id: string; objectKey: string; createdAt: string } } | undefined> {
  const artifacts = (await queryAllItems(dependencies, `WORKSPACE#${operation.workspaceId}`, "ARTIFACT#"))
    .filter((item) => item.operationId === operation.id && item.name === UNDERSTAND_ARTIFACT_NAME)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const artifact = artifacts.at(-1);
  if (artifact === undefined || typeof artifact.objectKey !== "string") return undefined;
  const text = await readObjectText(dependencies, artifact.objectKey, UNDERSTAND_ARTIFACT_MAX_BYTES + 1);
  if (text === undefined) return undefined;
  const read = readIntentArtifact(text);
  return read.ok ? { assessment: read.assessment, artifact: { id: String(artifact.id), objectKey: artifact.objectKey, createdAt: String(artifact.createdAt) } } : undefined;
}

export async function runWorkflowDispatch(dependencies: AwsBrokerDependencies, item: AccessPausedWorkflowDispatch): Promise<"DISPATCHED" | "STALE" | "RETRY"> {
  if (item.kind === "agent_run") return runAgentRunDispatch(dependencies, item);
  if (item.kind === "operation_end") return runOperationEndDispatch(dependencies, item);
  const key = { pk: item.pk, sk: item.sk };
  const remove = async () => {
    try {
      await dependencies.documentClient.send(new DeleteCommand({ TableName: dependencies.tableName, Key: key, ConditionExpression: "attribute_exists(pk)" }));
    } catch (error) {
      if (!isConditional(error)) throw error;
    }
  };
  if (item.kind === "AUTOFIX") return runAutofixDispatch(dependencies, item, remove);
  try {
    // Access pauses are lifted only by an explicit, freshly authorized owner retry. Recovery sweeps,
    // ownership restoration and takeover may still encounter the row but never restart its work.
    if (item.taskAccessPausedAt !== undefined) return "RETRY";
    const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(item.taskId));
    const workflow = task?.workflow;
    // Plan 6 Task 4: Understand's row at a READY revision starts it; at the RUNNING revision it is the step's watchdog. The plan step's row starts planning after Understand.
    const due = item.kind === "UNDERSTAND" ? workflow?.stage === "UNDERSTAND" && (workflow.state === "READY" || workflow.state === "RUNNING")
      : item.kind === "PLAN" ? workflow?.stage === "PLAN" && workflow.state === "READY"
      : item.kind === "CHECKS" ? workflow?.stage === "VERIFY" && workflow.state === "WAITING"
      : item.kind === "REVIEW" ? workflow?.stage === "REVIEW" && workflow.state === "WAITING"
      : item.kind === "IMPLEMENT" ? workflow?.stage === "IMPLEMENT" && workflow.state === "READY" && workflow.program !== undefined
      // Plan 6 Task 8: the plan check of a version 2 plan, and the one revision a blocking point of it asks for.
      : item.kind === "CRITIQUE" ? workflow?.stage === "PLAN_CRITIQUE" && workflow.state === "READY"
      : item.kind === "CRITIC_REPLAN" ? workflow?.stage === "PLAN" && workflow.state === "READY" && workflow.critique !== undefined
      // Plan 6 Task 17: the merge of the base branch the tracking pass queued.
      : item.kind === "SYNC" ? workflow?.stage === "WAIT_FOR_MERGE" && (workflow.state === "READY" || workflow.state === "RUNNING") && workflow.branchSync !== undefined
      : item.kind === "REPLAN" ? workflow?.stage === "PLAN" && workflow.state === "RUNNING"
      : item.kind === "GROUNDING" ? workflow?.stage === "PLAN" && workflow.state === "RUNNING" && task?.planGrounding?.artifactSha256 === item.candidateDigest
      : item.kind === "PUBLISH" || item.kind === "UPDATE" ? workflow?.stage === "PULL_REQUEST" && workflow.state === "READY" : false;
    if (task === undefined || task.closedAt !== undefined || workflow === undefined || workflow.revision !== item.workflowRevision
      || !due || dependencies.developer === undefined) {
      await remove();
      return "STALE";
    }
    // The watchdog needs no caller: it is due only after the step's time limit, and then it ends the task if the step never answered. Other work (a result of this task) runs the task's rows at
    // once, due or not, so a watchdog that is not due yet stays as it is.
    if (item.kind === "UNDERSTAND" && workflow.state === "RUNNING") {
      // Not a dispatch (and not a stale row: it stays); the sweep never reads it before it is due.
      if (Date.now() < Date.parse(item.nextAttemptAt)) return "STALE";
      return await endStuckUnderstanding(dependencies, task as DeveloperTaskRecord & { workflow: WorkflowSnapshot }, item);
    }
    // Plan 6 Task 17: a merge of the base whose machine was lost (the row names its operation): judged from what GitHub shows.
    if (item.kind === "SYNC" && workflow.state === "RUNNING") return await settleLostBranchSync(dependencies, task as DeveloperTaskRecord & { workflow: WorkflowSnapshot }, item);
    const caller = await ownerCallerOf(dependencies, task, "workflow-dispatch");
    const routeDependencies = developerTaskRouteDependencies({
      documentClient: dependencies.documentClient, tableName: dependencies.tableName, developer: dependencies.developer,
      now: Date.now, tasks: developerTaskActions(dependencies), refreshTaskFeedback: (taskId) => refreshTaskFeedbackForOwnerDecision(dependencies, taskId),
      workflowE2EPresentation: input => workflowE2EPresentation(dependencies, input.task, input.operations, input.actor),
      workflowE2EPublicationChecks: input => workflowE2EPublicationChecks(dependencies, input.task, input.operations),
      // Proof and evidence: the system-run publish and update rows (the autonomous path) read the same evidence port as an owner's press, so the risk rule and the evidence lines apply here too; empty with the proof switch off.
      ...evidenceRouteDependencies(dependencies),
      taskAutonomyNow: (target) => target.orgId === undefined ? Promise.resolve("suggest" as const)
        : taskAutonomy(() => readTaskRecipe(dependencies, target.taskId, target.orgId!), undefined, () => companyAutonomyLimit(dependencies, target.orgId!)),
      ...specSeamsOf(dependencies),
      currentPullRequestHead: async (target, pullRequest) => {
        const url = await webhookRepositoryUrl(dependencies)(target.project, target.startingRevision, pullRequest.repositoryId, target.orgId);
        if (url === undefined) throw agentXError("CONFIG_INVALID", "the pull request's repository is not in the task's project");
        // P5d: the code host the repository's record names (an unknown kind is refused).
        const host = await hostOfTaskRepository(dependencies, target, { name: pullRequest.repositoryId, url });
        const head = (await host.getChangeRequest(changeRequestRef(url, pullRequest.number), await githubScopeOf(dependencies, target)) as { headRevision?: unknown } | undefined)?.headRevision;
        if (typeof head !== "string" || !/^[a-f0-9]{40}$/u.test(head)) throw agentXError("RUNTIME_UNAVAILABLE", `${hostNameOf(host)} did not say what the pull request's head is`);
        return head;
      },
      // Plan 6 Task 17: the commit the pull request's base branch is at now, which is the commit a merge of the base takes.
      currentBaseCommit: currentBaseCommitOf(dependencies),
    }, caller, undefined, null);
    const expected = { workflowRevision: item.workflowRevision, candidateDigest: item.candidateDigest };
    // A fix for the pull requests already open is pushed to them by the same start, which sees they exist.
    let outcome: "STARTED" | "DUPLICATE" | "STALE" | "WAITING";
    if (item.kind === "CHECKS") {
      if (await requalifyHoldActive(dependencies, Date.now())) return "DISPATCHED"; // AUTOREQUALIFY: a switch is in progress; the row stays due
      const readiness = await ensureWorkflowE2EComputeReadiness(dependencies, routeDependencies, item);
      if (readiness.status === "WAITING") return "DISPATCHED";
      if (readiness.status === "STALE") {
        await remove();
        return "STALE";
      }
      if (await requalifyHoldActive(dependencies, Date.now())) return "DISPATCHED"; // checked again right before the round starts
      outcome = await startWorkflowE2EChecksDispatch(dependencies, routeDependencies, readiness.task, expected, caller);
      // The baseline round holds the workspace: the row stays, and the next pass (or the baseline's own result) tries again.
      if (outcome === "WAITING") return "DISPATCHED";
    } else if (item.kind === "UNDERSTAND") {
      outcome = await startTaskWorkflowUnderstandFromSystem(routeDependencies, item.taskId, { workflowRevision: item.workflowRevision });
      // The machine is still being prepared: the row stays, and the prepare's result runs it at once. Its due time moves on, with no attempt counted, so rows that wait for a machine
      // cannot fill the sweep's page and starve the others (the sweep reads the oldest due rows first).
      if (outcome === "WAITING") {
        await waitForMachine(dependencies, item);
        return "DISPATCHED";
      }
    } else if (item.kind === "PLAN") {
      outcome = await startTaskWorkflowPlanFromSystem(routeDependencies, item.taskId, { workflowRevision: item.workflowRevision });
    } else if (item.kind === "GROUNDING") {
      // T7c: the held plan's check on the current app: start it, then wait for it (the row stays and is looked at again) until the one finish ends the hold.
      if (await runGroundingStep(dependencies, routeDependencies, caller, item, task) === "WAIT") return "DISPATCHED";
      outcome = "STARTED";
    } else if (item.kind === "REPLAN") {
      // The planner's automatic second run (plan self-check); a row without its prompt can only be dropped.
      outcome = item.planPrompt === undefined ? "STALE"
        : await startTaskWorkflowPlanRevisionFromSystem(routeDependencies, item.taskId, { workflowRevision: item.workflowRevision, promptDigest: item.candidateDigest }, item.planPrompt);
    } else {
      outcome = item.kind === "PUBLISH" || item.kind === "UPDATE"
        ? await startTaskWorkflowPublicationFromSystem(routeDependencies, item.taskId, expected, { taskPageUrl: taskPageUrl(dependencies.developer.issuer, item.taskId) })
        : item.kind === "IMPLEMENT" ? await startTaskWorkflowImplementationFromSystem(routeDependencies, item.taskId, expected)
        : item.kind === "SYNC" ? await startTaskWorkflowBranchSyncFromSystem(routeDependencies, item.taskId, { workflowRevision: item.workflowRevision })
        : item.kind === "CRITIQUE" ? await startTaskWorkflowPlanCritiqueFromSystem(routeDependencies, item.taskId, { workflowRevision: item.workflowRevision })
        : item.kind === "CRITIC_REPLAN" ? await startTaskWorkflowCriticRevisionFromSystem(routeDependencies, item.taskId, { workflowRevision: item.workflowRevision })
        : await startTaskWorkflowReviewFromSystem(routeDependencies, item.taskId, expected);
    }
    // Meta repo lane D: a code publication held for its spec keeps its row; the spec's end (or the owner's choice) makes it due again.
    if (outcome === "WAITING") return "DISPATCHED";
    await remove();
    return outcome === "STALE" ? "STALE" : "DISPATCHED";
  } catch (error) {
    // AUTOREQUALIFY: a start refused by the hold fence inside its transaction surfaces as a busy workspace; while the hold stands that is a deferral, not a failure.
    if (error instanceof AgentXError && error.code === "WORKSPACE_BUSY" && await requalifyHoldActive(dependencies, Date.now()).catch(() => false)) return "DISPATCHED";
    if (error instanceof ApplicationPlanDefect) {
      // The approved plan can no longer run as written, which only a corrected plan fixes: the task goes back to plan review, where Request changes is the way on.
      try {
        if (await returnWorkflowToCorrectE2EPlan(dependencies, item, { reasonCode: "application-plan-not-approvable", blockReason: error.message })) return "STALE";
      } catch (recoveryError) {
        console.log(JSON.stringify({ component: "broker", event: "workflow.application_plan_return_failed", taskId: item.taskId, error: recoveryError instanceof Error ? recoveryError.name : "unknown" }));
      }
    }
    if (error instanceof ApplicationDispatchRefusal) {
      // Deterministic for this approval and these rows: the workflow says why it stopped, the row is removed, and nothing is retried.
      try {
        await blockWorkflowE2EReadiness(dependencies, item, error.message);
        console.log(JSON.stringify({ component: "broker", event: "workflow.application_dispatch_refused", taskId: item.taskId }));
        return "STALE";
      } catch (blockError) {
        console.log(JSON.stringify({ component: "broker", event: "workflow.application_dispatch_block_failed", taskId: item.taskId,
          error: blockError instanceof Error ? blockError.name : "unknown" }));
      }
      // If the block keeps failing until the budget is spent, the task still ends with this reason, not the generic one.
      await recordWorkflowDispatchFailure(dependencies, item, undefined, error.message);
      return "RETRY";
    }
    if (error instanceof E2EPortablePlanReferenceError) {
      try {
        if (await returnWorkflowToCorrectE2EPlan(dependencies, item, { reasonCode: error.reasonCode })) return "STALE";
      } catch (recoveryError) {
        console.log(JSON.stringify({ component: "broker", event: "workflow.e2e_plan_correction_failed", taskId: item.taskId,
          error: recoveryError instanceof Error ? recoveryError.name : "unknown" }));
      }
      await recordWorkflowDispatchFailure(dependencies, item);
      return "RETRY";
    }
    // PEOPLE-backed work with no current freshly qualified owner stays parked on its durable
    // dispatch row. It does not consume the bounded infrastructure failure budget; only a later
    // explicit owner action can start or redrive work.
    if (error instanceof AgentXError && error.code === "TASK_ACCESS_DENIED") {
      try {
        const pausedAt = new Date().toISOString();
        await dependencies.documentClient.send(new UpdateCommand({
          TableName: dependencies.tableName, Key: key,
          UpdateExpression: "SET taskAccessPausedAt = :pausedAt REMOVE dispatchDuePk, dispatchDueSk",
          ConditionExpression: "workflowRevision = :revision AND #kind = :kind AND candidateDigest = :candidate AND attribute_not_exists(taskAccessPausedAt)",
          ExpressionAttributeNames: { "#kind": "kind" },
          ExpressionAttributeValues: { ":pausedAt": pausedAt, ":revision": item.workflowRevision, ":kind": item.kind, ":candidate": item.candidateDigest },
        }));
      } catch (pauseError) {
        if (!isConditional(pauseError)) {
          console.log(JSON.stringify({ component: "broker", event: "workflow.dispatch_access_pause_failed", taskId: item.taskId,
            error: pauseError instanceof Error ? pauseError.name : "unknown" }));
        }
      }
      return "RETRY";
    }
    // Plan 3, Task 16: the company or the project no longer allows the model this step needs. Trying again cannot change that, so the task is
    // blocked at once with the refusal's own words, which the owner can read.
    if (error instanceof AgentXError && error.code === "MODEL_NOT_ALLOWED") {
      console.log(JSON.stringify({ component: "broker", event: "workflow.dispatch_refused", taskId: item.taskId, kind: item.kind, error: error.code }));
      // Plan 6 Task 8: only a model the company chose for the plan check blocks it. Rovara's own recommendation that no source can serve is no one's fault: the plan goes on, unchecked.
      // ... and a plan check whose every usable model was tried (the account could not use them) is no one's refusal either.
      if (item.kind === "CRITIQUE" && (error instanceof PlanCheckUnavailableError || !await companyChoseCriticModel(dependencies, item.taskId).catch(() => true))) {
        await closeUncheckedPlanCheck(dependencies, item);
        return "STALE";
      }
      await recordWorkflowDispatchFailure(dependencies, item, refusalText(error));
      return "STALE";
    }
    console.log(JSON.stringify({ component: "broker", event: "workflow.dispatch_failed", taskId: item.taskId, kind: item.kind, attempt: (item.attempts ?? 0) + 1,
      error: error instanceof AgentXError ? error.code : error instanceof Error ? error.name : "unknown" }));
    await recordWorkflowDispatchFailure(dependencies, item);
    return "RETRY";
  }
}

/** At most this many looks at one blocked step: a failing look is retried each sweep, then dropped (the task stays blocked with its card). */
const AUTOFIX_ATTEMPTS_MAX = 60;

/** AUTOFIX reads only the cost of a usage record, and not its other fields: a worker that adds a field must not make every task's spend unknown (which would switch automatic fixing off). */
const AutofixUsageCostSchema = z.object({ costUsd: z.number().nonnegative().nullable() });

/** At most this many pages of one operation's events are read for its usage records; an operation with more is spend that cannot be read. */
const AUTOFIX_USAGE_PAGES_MAX = 40;

/**
 * Every usage record of one operation, added up: a review run records one per reviewer (code and security), a coding run one. Undefined when the events cannot all be read (more pages than
 * the bound, or a read that failed): spend that is not known is never counted as zero.
 */
async function autofixOperationUsage(dependencies: AwsBrokerDependencies, operationId: string): Promise<{ total: number; records: number } | undefined> {
  let total = 0;
  let records = 0;
  let start: Record<string, unknown> | undefined;
  for (let page = 0; page < AUTOFIX_USAGE_PAGES_MAX; page += 1) {
    const response = await dependencies.documentClient.send(new QueryCommand({
      TableName: dependencies.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :event)", FilterExpression: "#type = :usage",
      ExpressionAttributeNames: { "#type": "type" }, ExpressionAttributeValues: { ":pk": `OPERATION#${operationId}`, ":event": "EVENT#", ":usage": "usage" },
      ConsistentRead: true, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<{ payload?: unknown }>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of response.Items ?? []) {
      const usage = AutofixUsageCostSchema.safeParse(item.payload);
      records += 1;
      // A usage record with no cost (an unpriced model) counts as one more round's estimate, never as free; one that cannot be read makes the whole spend unknown.
      if (!usage.success) return undefined;
      total += usage.data.costUsd !== null ? usage.data.costUsd : AUTOFIX_ROUND_ESTIMATE_USD;
    }
    start = response.LastEvaluatedKey;
    if (start === undefined) return { total, records };
  }
  return undefined;
}

/** AUTOFIX: the whole task's recorded model spend, every usage record of every run of the task. A model run with no usage record counts as one more round's estimate (never as zero). */
async function autofixTaskSpendUsd(dependencies: AwsBrokerDependencies, task: DeveloperTaskRecord): Promise<number | undefined> {
  try {
    const operations = (await developerTaskActions(dependencies).operations(task.workspaceId)).filter((operation) => operation.kind === "task");
    let total = 0;
    for (const operation of operations) {
      if (operation.workflowMode === "CHECKS") continue;
      const usage = await autofixOperationUsage(dependencies, operation.id);
      if (usage === undefined) return undefined;
      total += usage.records === 0 ? AUTOFIX_ROUND_ESTIMATE_USD : usage.total;
    }
    return total;
  } catch { return undefined; }
}

/** AUTOFIX: whether the project's AI-navigation day budget has room for one more call; true where the task uses no AI navigation. Undefined when unreadable. */
async function autofixDayBudgetHasRoom(dependencies: AwsBrokerDependencies, task: DeveloperTaskRecord): Promise<boolean | undefined> {
  if (task.workflow?.e2e?.required !== true || dependencies.e2eAgentInstallation === undefined) return true;
  try {
    const derived = deriveE2EAgentRoute(await dependencies.e2eAgentInstallation());
    const budgets = derived.status === "available" ? derived.definition.budgets : E2E_MODEL_ROUTE_DEFAULT_BUDGETS;
    return await e2eDayBudgetRoom({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, orgId: requireOrgId(task.orgId), projectName: task.project, now: Date.now() }, autofixDayBudgetNeed(budgets),
      { maxInputTokens: budgets.maxInputTokensPerProjectDay, maxCalls: budgets.maxCallsPerProjectDay });
  } catch { return undefined; }
}

/**
 * AUTOFIX dispatch row: look at the blocked step once. The row is removed when the task moved on or the policy acted or asked; it stays (the sweep looks again) while the original-code round is
 * not in yet, and after a failed look, up to a bound. It never blocks or gives up on anything: the task is already blocked.
 */
async function runAutofixDispatch(dependencies: AwsBrokerDependencies, item: AccessPausedWorkflowDispatch, remove: () => Promise<void>): Promise<"DISPATCHED" | "STALE" | "RETRY"> {
  const config = dependencies.autofix;
  const store = { documentClient: dependencies.documentClient, tableName: dependencies.tableName };
  let task: DeveloperTaskRecord | undefined;
  if (autofixRowHeld(item, Date.now())) return "RETRY"; // DISPATCHEXHAUST: the one automatic retry of an infrastructure fault waits out its delay; the sweep finds the row when it is due
  try {
    task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(item.taskId));
    if (config?.enabled !== true || task === undefined || dependencies.developer === undefined) { await remove(); return "STALE"; }
    // MONEY (mainline #408 sync; owner ruling pending): Rovara's own moves run as the task's effective owner in the task's own org with the plain member role, nothing elevated.
    const caller = await ownerCallerOf(dependencies, task, "workflow-autofix");
    const tasks = developerTaskActions(dependencies);
    const route = developerTaskRouteDependencies({
      documentClient: dependencies.documentClient, tableName: dependencies.tableName, developer: dependencies.developer, now: Date.now, tasks,
      refreshTaskFeedback: (taskId) => refreshTaskFeedbackForOwnerDecision(dependencies, taskId),
      workflowE2EPresentation: input => workflowE2EPresentation(dependencies, input.task, input.operations, input.actor),
      workflowE2EPublicationChecks: input => workflowE2EPublicationChecks(dependencies, input.task, input.operations),
      // AUTOREQUALIFY: the one automatic retry that approves the plan again after a mere renewal of the test machine needs the plan check (the retry itself refuses any other re-approval).
      validateWorkflowE2EApplicationPlan: workflowApplicationRouteDependencies(dependencies).validateWorkflowE2EApplicationPlan,
      ...specSeamsOf(dependencies),
    }, caller, undefined, null);
    const blockedByEnvironment = blockedByEnvironmentHook({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now, ...(dependencies.audit === undefined ? {} : { audit: dependencies.audit }) });
    const deps: AutofixDependencies = {
      config, route, store: { documentClient: dependencies.documentClient, tableName: dependencies.tableName },
      taskSpendUsd: (current) => autofixTaskSpendUsd(dependencies, current),
      dayBudgetHasRoom: (current) => autofixDayBudgetHasRoom(dependencies, current),
      scenarioResults: async (current) => loadWorkflowE2EScenarioResults(dependencies, current, [], "owner").catch(() => undefined),
      ownerCancelledChecks: async (current) => {
        // The stored records, not the public operations: a public operation does not carry which run a cancel targets (so this never saw an owner's stop). DISPATCHEXHAUST: the stage's own latest run.
        const operations = (await queryAllItems(dependencies, `WORKSPACE#${current.workspaceId}`, "OPERATION#")) as Array<{ id?: string; kind?: string; workflowMode?: string; createdAt: string; targetOperationId?: string }>;
        const mode = current.workflow?.stage === "REVIEW" ? "REVIEW" : "CHECKS";
        const latest = operations.filter((operation) => operation.kind === "task" && operation.workflowMode === mode).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        return latest !== undefined && operations.some((operation) => operation.kind === "cancel" && operation.targetOperationId === latest.id);
      },
      baselineSourceReady: async (current) => {
        const digest = current.workflow?.candidate?.digest;
        if (digest === undefined) return false;
        const source = await candidateSourceOperation(dependencies, current, digest);
        const exported = StoredBaselineSourceSchema.safeParse(source?.baselineSource);
        return exported.success && exported.data.status === "READY";
      },
      readArtifactText: async (key) => { const bytes = await readStoredBytes(dependencies, key, 64 * 1024 + 1); return bytes?.toString("utf8"); },
      recycleWorker: (current) => recycleDriftedWorker(ec2Sessions, current.workspaceId),
      // Setup and test health (SH28): undefined while the `nh` switch is off.
      ...(blockedByEnvironment === undefined ? {} : { blockedByEnvironment }),
      ...fixSetupDependencies(dependencies),
      now: Date.now,
      log: (entry) => console.log(JSON.stringify({ component: "broker", ...entry })),
    };
    const outcome = await runWorkflowAutofix(deps, task, { expectedRevision: item.workflowRevision, startedAt: item.createdAt, cause: autofixBlockCauseOf(item.autofixCause) });
    if (outcome !== "WAITING") { await remove(); return outcome === "STALE" || outcome === "DISABLED" ? "STALE" : "DISPATCHED"; }
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "autofix.look_failed", taskId: item.taskId, attempt: (item.attempts ?? 0) + 1, error: error instanceof AgentXError ? error.code : error instanceof Error ? error.name : "unknown" }));
    if ((item.attempts ?? 0) + 1 >= AUTOFIX_ATTEMPTS_MAX) {
      // Giving up: the owner is told a person must act, so the card never stands for a task nobody is looking at.
      try { if (task !== undefined) await recordAutofixGiveUpAsk(store, task, Date.now()); }
      catch (askError) { console.log(JSON.stringify({ component: "broker", event: "autofix.give_up_ask_failed", taskId: item.taskId, error: askError instanceof Error ? askError.name : "unknown" })); }
      await remove();
      return "STALE";
    }
  }
  // Look again at the next sweep, a minute from now (a waiting row too, so it never sits at the head of the due index).
  await postponeAutofixRow(store, item, Date.now());
  return "RETRY";
}

/** Reads the original creator from its authoritative, separately scoped sign-in table. */
export async function getWorkflowE2ECreatorIdentity(dependencies: AwsBrokerDependencies, developerId: string): Promise<Pick<DeveloperRecord, "revoked" | "slackUserId"> & { entityType?: unknown } | undefined> {
  const signInTableName = dependencies.developer?.signInTableName;
  if (signInTableName === undefined) return undefined;
  const response = await dependencies.documentClient.send(new GetCommand({
    TableName: signInTableName,
    Key: { pk: `DEVELOPER#${developerId}`, sk: "META" },
    ConsistentRead: true,
  })) as unknown as { Item?: Pick<DeveloperRecord, "revoked" | "slackUserId"> & { entityType?: unknown } };
  return response.Item?.entityType === "DEVELOPER" ? response.Item : undefined;
}
