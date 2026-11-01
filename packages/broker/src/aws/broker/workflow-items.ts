// Part of the broker (split out of ../broker.ts): retries, evidence jobs and the items each completed workflow step writes.

import { createHash } from "node:crypto";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { AgentXError, CheckReportSchema, skipPlanRevision, canonicalJson, type PlanEvidenceBundle, workflowIsReviewOnly, workflowPullRequestTrees, workflowSelectedChecks, blockWorkflow, endWorkflowCiFixUnrelated, WorkflowDependencyResultSchema, WorkflowSnapshotSchema, taskGraphOrder, workflowDependencyAttemptTerminalProgress, completeWorkflowFeedbackReview, createCandidateManifest, WORKFLOW_HISTORY_REWRITTEN_MESSAGE, FEEDBACK_NOT_RUN_REASON, WORKFLOW_NO_CODE_CHANGE_MESSAGE, noChangeFindingsFrom, WORKFLOW_RULE_FILES_UNVERIFIED_MESSAGE, WORKFLOW_LEFTOVER_PROCESSES_MESSAGE, WORKFLOW_SETUP_CHANGED_FILES_MESSAGE, WORKFLOW_LIVE_STEER_REAPPROVAL_MESSAGE, WORKFLOW_BLOCK_REASONS, BUDGET_EXHAUSTED_FAILURE_MESSAGE, type IntentAssessment, UNDERSTAND_UNREADABLE_MESSAGE, answerWorkflowIntent, recordIntentAssessment, WORKFLOW_MISSING_COMMITTED_SOURCE_EXPORT_REASON, WORKFLOW_DISPATCH_DUE_INDEX, WORKFLOW_REVIEW_RESULT_INCOMPLETE_MESSAGE, WorkflowReviewBaseSchema as PreparedBaseSchema, recordWorkflowVerification, completeWorkflowBuild, nextProgramStep, workflowReviewRoles, submitWorkflowReview, registerWorkflowPullRequest, blockWorkflowPullRequestUpdate, recordWorkflowPullRequestUpdate, recordWorkflowBranchSync, CONFLICT_ROUNDS_MAX, observeWorkflowPullRequestMergedWithFix, workflowPullRequestUpdateDue, WORKFLOW_PULL_REQUEST_UPDATE_WORKER_OUTDATED, WORKFLOW_FIX_DROPS_BASE_CHANGES, type WorkflowPullRequestUpdateCause, PullRequestLifecycleResultSchema, PullRequestResultSchema, agentXError, type OperationStatus, type WorkflowSnapshot, type CandidateRepository, WorkflowFeedbackBundleRefSchema, WorkflowFeedbackReviewReportSchema, WorkflowFeedbackReviewRefSchema, INDEX_EXPIRY_ATTRIBUTE, WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX, WORKFLOW_APPLICATION_SELECTION_CHANGED_PREFIX, WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX, ROVARA_CODE_AGENT_ID, type RunEstimate, codeRepositoriesOf } from "@agentx/contracts";
import { resultsWithStoredArtifacts, storeWorkflowE2EArtifacts } from "../workflow-e2e-artifacts.js";
import { queryAllItems } from "../admin-reads.js";
import type { z } from "zod";
import { mergedPullRequestCountItem } from "../github-webhooks.js";
import { plannerRepliesItem } from "../../developer/page-comments.js";
import { readObjectText as readStoredText } from "../../developer/plan-artifacts.js";
import { codeMilestoneItems } from "../../rovara-code/milestones.js";
import { answeredMilestoneItems } from "../../rovara-code/answered.js";
import { assessmentForTask } from "../../rovara-code/explicit-path.js";
import { questionsMilestoneItems } from "../../rovara-code/question-answers.js";
import { mergedMilestoneItems } from "../../rovara-code/merged.js";
import { mergedStateItems } from "../../rovara-code/merged-state.js";
import { PLAN_EVIDENCE_PK, attachEvidence, planEvidenceDueKey, planEvidenceEvent, planEvidenceJobItem, type PlanEvidenceEvent, type PlanEvidenceJob } from "../../developer/plan-evidence-jobs.js";
import { requireOrgId } from "../../org/resolve.js";
import { createWorkflowE2EDisplayObject } from "../workflow-e2e-notifier-projection.js";
import { getItem, type OperationRecord } from "../cancellation.js";
import { githubWorkflowPullRequestKey, taskKey, type DeveloperTaskPointerRecord, type DeveloperTaskRecord, type GithubWorkflowPullRequestRecord } from "../../developer/task-records.js";
import { WORKFLOW_DISPATCH_PK, WORKFLOW_NO_CANDIDATE_DIGEST, workflowDispatchItem, type WorkflowDispatchRecord } from "../broker-shared.js";
import { admitWork } from "../../spend/admission.js";
import { planningLimit, readProjectAi } from "../../spend/settings.js";
import { readTaskRecipe } from "../../agents/runs.js";
import type { TransactItems } from "../developer-task-actions.js";
import { ADMISSION_REFUSALS, finishedReleaseMarkItem, laterProgramBuild } from "../developer-tasks.js";
import type { PlanGroundingHold, PlanSelfCheckState } from "../../developer/plan-self-check.js";
import { mergeRecoveryItem, trackingRecoveryItem } from "../workflow-merge-recovery.js";
import { ciFixUnrelatedItems, taskAutonomy } from "../../rovara-code/ci-fix.js";
import { planBranchSyncOutcome, type BranchSyncGithub } from "../../rovara-code/branch-sync.js";
import { feedbackReplyItems } from "../../rovara-code/feedback-autonomy.js";
import { prHeadItems } from "../../rovara-code/tracking-events.js";
import { workflowRunEndedReason } from "../outbox-failure.js";
import { autofixBlockRows } from "../workflow-autofix-dispatch-exhaust.js";
import { setupDraftEndItems, setupDraftRepositoriesOf } from "../../rovara-code/setup-draft.js";
import { githubRepositoryFullName, pullRequestKey, pullRequestMatchesRepository } from "./admin-and-helpers.js";
import { GITHUB_HOST_KIND } from "../../plugins/code-host/github/index.js";
import { canReadBranchAndTree, canReadFeedback, canReadTree, changeRequestRef, hostOfRepository, pullRequestFactsOf, repositoryRefOf, requireGithubHost } from "./repository-hosts.js";
import { isSpecOperation, specOperationEndItems } from "../../spec/end-items.js";
import { specEndEnvironmentOf } from "./spec-wiring.js";
import { MAX_WORKFLOW_CANDIDATE_EXPORT_BYTES, type AwsBrokerDependencies, type PullRequestRecord } from "./definitions.js";
import { knowledgeCommitToStore, taskPreparedUpdate } from "../../meta-repo/prepare-meta.js";
import { requireRecordProject } from "./dependency-wiring.js";
import { readUnderstandingArtifact, runWorkflowDispatch } from "./dispatch.js";
import { PLAN_GROUNDING_HOLD_PK, isNonCandidateRound, sweepGroundingHolds } from "./e2e-rounds.js";
import { workflowCandidateSourceExportSchema } from "./evidence-and-setup.js";
import { readFeedbackBundlesForCritic } from "./feedback-and-codebuild.js";
import { ROVARA_CODE_NAME } from "./model-access.js";
import { planCritiqueOutcome, planRunEstimate, spendLimitKind, storePlanAnswer, type PlannerReplies } from "./plan-answers.js";
import { requirePullRequest } from "./records.js";
import { githubScopeOf } from "./scope-helpers.js";
import { liveSteerChangeItems, liveSteerCodingStop } from "../../agent-sessions/live-steer-revise.js";
import { PLAN_EVIDENCE_SWEEP_LIMIT, WORKFLOW_DISPATCH_SWEEP_LIMIT } from "./sweeps-and-readiness.js";
import { checkCommandCouldNotRun, regressedCheckLabels } from "./terminal-result.js";
import { verifyWorkflowE2EEvidence, workflowE2EPresentationDetailed, type WorkflowE2EVerificationDiagnostic } from "./workflow-e2e-verification.js";

/**
 * The recovery sweep: up to 25 rows that are due, oldest due first, each run once. It reads the sparse due-time
 * index, whose sort key starts with the row's next attempt time, so rows waiting out a backoff sort after the
 * bound and can never fill the page ahead of a due row. The index is eventually consistent: a row read just as
 * it changed only runs again later, since every write to it is conditional and the start itself is idempotent.
 */
export async function retryDueWorkflowDispatches(dependencies: AwsBrokerDependencies): Promise<{ attempted: number; dispatched: number }> {
  await sweepGroundingHolds(dependencies);
  const page = await dependencies.documentClient.send(new QueryCommand({
    TableName: dependencies.tableName,
    IndexName: WORKFLOW_DISPATCH_DUE_INDEX.name,
    KeyConditionExpression: `${WORKFLOW_DISPATCH_DUE_INDEX.partitionKey} = :pk AND ${WORKFLOW_DISPATCH_DUE_INDEX.sortKey} BETWEEN :from AND :due`,
    // ":" sorts after the "#" that follows each due time, so `${now}:` includes every row due at or before now.
    ExpressionAttributeValues: { ":pk": WORKFLOW_DISPATCH_PK, ":from": "0", ":due": `${new Date().toISOString()}:` },
    Limit: WORKFLOW_DISPATCH_SWEEP_LIMIT,
  }));
  const rows = (page.Items ?? []) as WorkflowDispatchRecord[];
  let dispatched = 0;
  for (const row of rows) if (await runWorkflowDispatch(dependencies, row) === "DISPATCHED") dispatched += 1;
  return { attempted: rows.length, dispatched };
}

/** The cited code a plan's own callback read, waiting for the plan to commit before it is attached. */
export interface InlineEvidence { taskId: string; artifactId: string; artifactSha256: string; bundle: PlanEvidenceBundle; prefix: string }

/** Attaches evidence read inside the plan callback; a failure is logged and leaves the plan's page saying it could not load the code. */
export async function attachInlineEvidence(dependencies: AwsBrokerDependencies, entries: readonly InlineEvidence[]): Promise<void> {
  for (const entry of entries) {
    try {
      await attachEvidence({ documentClient: dependencies.documentClient, s3: dependencies.s3, tableName: dependencies.tableName, bucketName: dependencies.artifactBucketName, now: Date.now }, entry);
    } catch (error) {
      console.log(JSON.stringify({ component: "broker", event: "plan_evidence.attach_failed", taskId: entry.taskId, artifactId: entry.artifactId, error: error instanceof Error ? error.name : "unknown" }));
    }
  }
}

/** Starts the evidence job for each event; a failed start is logged and left to the sweep, and never fails the caller. */
export async function startPlanEvidenceJobs(dependencies: AwsBrokerDependencies, events: readonly PlanEvidenceEvent[]): Promise<number> {
  const start = dependencies.startPlanEvidenceJob;
  if (start === undefined) return 0;
  let started = 0;
  for (const event of events) {
    try {
      await start(event);
      started += 1;
    } catch (error) {
      console.log(JSON.stringify({ component: "broker", event: "plan_evidence.start_failed", taskId: event.taskId, artifactId: event.artifactId, error: error instanceof Error ? error.name : "unknown" }));
    }
  }
  return started;
}

/**
 * The evidence jobs the sweep starts: up to 25 PLAN_EVIDENCE rows that are due, oldest first, from the same due-time index as
 * the dispatch rows under their own partition value. A row being worked holds a lease past now, and a row waiting out a backoff
 * sorts after the bound, so neither is started again early; the job's own claim keeps two starts of one row from both running.
 */
export async function startDuePlanEvidenceJobs(dependencies: AwsBrokerDependencies): Promise<{ attempted: number; started: number }> {
  if (dependencies.startPlanEvidenceJob === undefined) return { attempted: 0, started: 0 };
  const page = await dependencies.documentClient.send(new QueryCommand({
    TableName: dependencies.tableName,
    IndexName: WORKFLOW_DISPATCH_DUE_INDEX.name,
    KeyConditionExpression: `${WORKFLOW_DISPATCH_DUE_INDEX.partitionKey} = :pk AND ${WORKFLOW_DISPATCH_DUE_INDEX.sortKey} BETWEEN :from AND :due`,
    // ":" sorts after the "#" that follows each due time, so `${due(now)}:` includes every row due at or before now.
    ExpressionAttributeValues: { ":pk": PLAN_EVIDENCE_PK, ":from": "0", ":due": `${planEvidenceDueKey(Date.now())}:` },
    Limit: PLAN_EVIDENCE_SWEEP_LIMIT,
  }));
  const rows = (page.Items ?? []) as PlanEvidenceJob[];
  return { attempted: rows.length, started: await startPlanEvidenceJobs(dependencies, rows.map((row) => planEvidenceEvent(row.taskId, row.artifactId))) };
}

export function isWorkflowDispatchRecoveryEvent(event: unknown): event is { source: "agentx.workflow-dispatch-recovery" } {
  return event !== null && typeof event === "object" && (event as { source?: unknown }).source === "agentx.workflow-dispatch-recovery";
}

/**
 * Item 7: the result of pushing an approved fix to the workflow's pull request. Only the push the task is waiting on
 * counts: its candidate must still be the task's, at PULL_REQUEST/RUNNING; anything else (the pull request merged
 * meanwhile, the task closed or moved on) is dropped. A success is recorded only once GitHub says the pull request's head
 * is the pushed commit and that commit's tree is the reviewed tree; the pull request's link to the task then names the
 * fix's candidate. A failure, or a head GitHub does not confirm, blocks the task waiting for the merge, with a plain cause;
 * the pull request keeps the head and reviewed code it had, which merge tracking matches.
 */
async function completedPullRequestUpdateItems(
  dependencies: AwsBrokerDependencies,
  operation: OperationRecord,
  task: DeveloperTaskRecord & { workflow: WorkflowSnapshot },
  terminalStatus: OperationStatus,
  now: string,
  result: unknown,
  terminalError: string | undefined,
): Promise<TransactItems> {
  const binding = operation.maintenance?.workflowCandidate;
  const workflow = task.workflow;
  const maintenance = operation.maintenance;
  if (binding === undefined || maintenance === undefined || task.closedAt !== undefined || workflow.stage !== "PULL_REQUEST" || workflow.state !== "RUNNING"
    || workflow.candidate?.digest !== binding.candidateDigest) return [];
  const pullRequest = workflow.pullRequests?.find((entry) => entry.repositoryId === maintenance.repository && entry.number === maintenance.pullRequestNumber);
  if (pullRequest === undefined) return [];
  const candidateRepository = workflow.candidate.repositories.find((entry) => entry.repositoryId === maintenance.repository);
  const taskUpdate = (next: WorkflowSnapshot): TransactItems[number] => ({ Update: {
    TableName: dependencies.tableName,
    Key: taskKey(task.taskId),
    UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
    ConditionExpression: "workflow.revision = :revision AND workflow.#stage = :stage AND workflow.#state = :running AND attribute_not_exists(closedAt)",
    ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
    ExpressionAttributeValues: { ":workflow": next, ":now": now, ":revision": workflow.revision, ":stage": "PULL_REQUEST", ":running": "RUNNING" },
  } });
  const failed = (cause?: WorkflowPullRequestUpdateCause) => [taskUpdate(blockWorkflowPullRequestUpdate(workflow, { numbers: [pullRequest.number], cause, now }))];
  // Why the push failed, by the worker's own error: it could not take a reviewed fix; the pull request's head moved or the
  // push was not a fast-forward; or anything else on the way to GitHub (a CodeBuild gate included) stopped it.
  const cause: WorkflowPullRequestUpdateCause = terminalStatus === "SUCCEEDED" ? "PUSH_REFUSED"
    : terminalError?.includes(WORKFLOW_PULL_REQUEST_UPDATE_WORKER_OUTDATED) === true ? "WORKER_OUTDATED"
      : terminalError?.includes(WORKFLOW_FIX_DROPS_BASE_CHANGES) === true ? "BASE_CHANGES_DROPPED"
      : terminalError?.startsWith("STALE_FENCE") === true ? "HEAD_MOVED" : "PUSH_REFUSED";
  // A worker that could not take the fix never reached GitHub.
  if (cause === "WORKER_OUTDATED") return failed(cause);
  let pushedCommit: string | undefined;
  if (terminalStatus === "SUCCEEDED") {
    const pushed = PullRequestLifecycleResultSchema.safeParse(result);
    if (!pushed.success || pushed.data.action !== "append" || pushed.data.repository !== maintenance.repository || pushed.data.number !== maintenance.pullRequestNumber
      || pushed.data.treeSha !== binding.treeSha || candidateRepository?.treeSha !== binding.treeSha || !/^[a-f0-9]{40}$/.test(pushed.data.commit)) {
      return failed("PUSH_REFUSED");
    }
    pushedCommit = pushed.data.commit;
  }
  const project = await requireRecordProject(dependencies, task, task.project, task.startingRevision);
  const repository = codeRepositoriesOf(project.definition).find((entry) => entry.name === maintenance.repository);
  // P5d: the pull request is read from the code host the repository's record names (an unknown kind is refused with the router's fixed sentence). Only the commit-parent read, which the port does not
  // carry yet, stays GitHub's; another host then cannot show a fix's ancestry, and the fix is not taken as landed.
  const host = repository === undefined ? undefined : hostOfRepository(dependencies, repository);
  const github = host?.kind === GITHUB_HOST_KIND ? dependencies.githubPullRequests : undefined;
  if (repository === undefined || host === undefined || !canReadFeedback(dependencies, host)) {
    if (pushedCommit === undefined) return failed(cause);
    throw agentXError("RUNTIME_UNAVAILABLE", "cannot verify the updated pull request against the reviewed fix");
  }
  const record = await getItem<PullRequestRecord>(dependencies, pullRequestKey(task.workspaceId, maintenance.repository, maintenance.pullRequestNumber));
  // GitHub, not the worker, says what the pull request now holds. A failed push may still have landed (a CodeBuild gate
  // after the push, a lost result): then GitHub's head is AgentX's fast-forward of the recorded head, on the reviewed tree.
  const scope = await githubScopeOf(dependencies, task);
  let current: ReturnType<typeof pullRequestFactsOf>;
  try {
    current = pullRequestFactsOf(await host.feedback(changeRequestRef(repository.url, maintenance.pullRequestNumber), scope));
  } catch (error) {
    if (pushedCommit === undefined) return failed(cause);
    throw error;
  }
  let head = current.pullRequest.headCommit;
  let headTree = current.pullRequest.headTreeSha;
  // GitHub moves a pull request's head a moment after a push to its branch, and the push's result comes right after the
  // push: while the open pull request still shows the head before the push, its branch (read from Git itself) says
  // what it holds.
  if (head === maintenance.expectedHeadCommit && current.pullRequest.state === "open"
    && canReadBranchAndTree(dependencies, host)) {
    try {
      const branchHead = await host.branchHead(repositoryRefOf(repository.url), maintenance.headBranch, scope);
      if (branchHead !== head && /^[a-f0-9]{40}$/.test(branchHead)) {
        headTree = await host.tree(repositoryRefOf(repository.url), branchHead, scope);
        head = branchHead;
      }
    } catch {
      // GitHub could not say: the pull request's own head stands.
    }
  }
  // The pull request must still come from the branch AgentX pushed to: the same tree on another branch is not this push.
  const onReviewedTree = current.pullRequest.number === pullRequest.number && current.pullRequest.url === pullRequest.url
    && current.pullRequest.headBranch === maintenance.headBranch && headTree === binding.treeSha && head !== maintenance.expectedHeadCommit && /^[a-f0-9]{40}$/.test(head);
  // A fix is a fast-forward of the head the task recorded: that head is the commit's only parent. A conflict round's fix is a merge commit (Plan 6 Task 17): the head the task recorded first and the commit of
  // the base it merged second, and nothing else, whoever says the push is recorded.
  const mergeBase = binding.mergeBaseCommit;
  const parentsAreOurs = async (): Promise<boolean> => {
    try {
      return github?.getCommitParents !== undefined && JSON.stringify(await github.getCommitParents(repository.url, head, scope))
        === JSON.stringify(mergeBase === undefined ? [maintenance.expectedHeadCommit] : [maintenance.expectedHeadCommit, mergeBase]);
    } catch {
      return false;
    }
  };
  const ownFastForward = async (): Promise<boolean> => record?.expectedHeadCommit === head || await parentsAreOurs();
  const landed = onReviewedTree && (pushedCommit !== undefined ? head === pushedCommit && record?.expectedHeadCommit === head : await ownFastForward()) && (mergeBase === undefined || await parentsAreOurs());
  if (!landed || current.pullRequest.state === "closed") return failed(pushedCommit === undefined ? cause : "HEAD_MOVED");
  // Merged at the pushed fix before its result was recorded: the fix is recorded with the merge, which completes the task.
  const updated = current.pullRequest.state === "merged"
    ? observeWorkflowPullRequestMergedWithFix(workflow, { repositoryId: pullRequest.repositoryId, number: pullRequest.number, headSha: head, headTreeSha: binding.treeSha, observedAt: now }, now)
    : recordWorkflowPullRequestUpdate(workflow, { updates: [{ repositoryId: pullRequest.repositoryId, number: pullRequest.number, headSha: head, headTreeSha: binding.treeSha }], now });
  // A conflict round's fix was pushed as the merge of the base commit: the candidate is now on that base, so the next review and fix see only Rovara's change.
  const next = mergeBase !== undefined && current.pullRequest.state !== "merged"
    ? recordWorkflowBranchSync(updated, { repositoryId: pullRequest.repositoryId, number: pullRequest.number, headSha: head, headTreeSha: binding.treeSha, baseCommitSha: mergeBase, now })
    : updated;
  // The linked-pull-request rows are keyed by GitHub's full name (left for P6): a repository on another host stops here with a clear sentence.
  requireGithubHost(host);
  const repositoryFullName = githubRepositoryFullName(repository.url);
  // A pull request this save moves to MERGED counts in the project's month of merges, in the same transaction as the move (the task update is conditioned on the revision read, so a replay
  // counts nothing), as it does when a webhook or the sweep finds the merge. A task whose org is not known is not counted.
  const countsAsMerged = current.pullRequest.state === "merged" && pullRequest.state !== "MERGED" && task.orgId !== undefined
    && next.pullRequests?.some((after) => after.repositoryId === pullRequest.repositoryId && after.number === pullRequest.number && after.state === "MERGED") === true;
  const recordUpdated = record !== undefined && record.expectedHeadCommit !== head;
  return [taskUpdate(next), ...(countsAsMerged ? [mergedPullRequestCountItem(dependencies.tableName, task.orgId!, task.project, now, 1)] : []),
  // The pull request's link to the task now names the fix it holds (for a conflict round's, the fix on the new base).
  ...await candidateRekeyItems(dependencies, task, project, workflow, next, now),
  // A push that landed without its update callback: the pull request's record learns its head, for the next push, and GitHub's state (merged included: mergedStateItems below leaves this record to
  // this one update, because a transaction may not touch one item twice, C59).
  ...(recordUpdated ? [{ Update: {
    TableName: dependencies.tableName,
    Key: pullRequestKey(task.workspaceId, maintenance.repository, maintenance.pullRequestNumber),
    UpdateExpression: "SET expectedHeadCommit = :head, #state = :state, updatedAt = :now",
    ConditionExpression: "expectedHeadCommit = :previous",
    ExpressionAttributeNames: { "#state": "state" },
    ExpressionAttributeValues: { ":head": head, ":state": current.pullRequest.state, ":now": now, ":previous": maintenance.expectedHeadCommit },
  } }] : []),
  // The new head, for the check and status events that name only a commit.
  ...(task.orgId === undefined || workflow.definitionVersion !== "1.1.0" ? [] : prHeadItems(dependencies.tableName, { orgId: task.orgId, repositoryFullName, headSha: head, taskId: task.taskId, repositoryId: pullRequest.repositoryId, number: pullRequest.number }, Date.parse(now))),
  // The merge this save records is reported as the merged milestone, in the same transaction, as it is when a webhook or the sweep finds the merge (Plan 6 Task 20).
  ...await mergedMilestoneItems({ documentClient: dependencies.documentClient, tableName: dependencies.tableName }, task, workflow, next, now),
  // ... and what was kept about the pull request (its tracking row and its record) says merged too (Bug H).
  ...await mergedStateItems({ documentClient: dependencies.documentClient, tableName: dependencies.tableName }, task, workflow, next, now, [],
    recordUpdated && current.pullRequest.state === "merged" ? [{ repositoryId: pullRequest.repositoryId, number: pullRequest.number }] : []),
  // A round Rovara decided itself leaves one reply on each thread it fixed, sent after the commit (Plan 6 Task 16); a round a person decided leaves none.
  ...(task.orgId === undefined || current.pullRequest.state === "merged" ? [] : feedbackReplyItems({ tableName: dependencies.tableName, orgId: task.orgId, workflow, repositoryId: pullRequest.repositoryId, number: pullRequest.number, head, now })),
  // More pull requests to go: the next push is due, as the first one was after the reviews.
  ...(next.stage === "PULL_REQUEST" && next.state === "READY" && next.candidate !== undefined
    ? [workflowDispatchItem(dependencies.tableName, task.taskId, next.revision, "UPDATE", next.candidate.digest, now)] : [])];
}

/**
 * The link items of the pull requests whose reviewed code was renamed: each one's link to the task names the candidate it holds, and a merge of the base gives a new candidate. Conditional on the digest read,
 * so a link that moved meanwhile is the newer writer's and cancels the transaction (the result is then recorded by the next attempt, from what is there).
 */
async function candidateRekeyItems(
  dependencies: AwsBrokerDependencies, task: DeveloperTaskRecord, project: Awaited<ReturnType<typeof requireRecordProject>>, before: WorkflowSnapshot, after: WorkflowSnapshot, now: string,
): Promise<TransactItems> {
  const items: TransactItems = [];
  for (const pullRequest of after.pullRequests ?? []) {
    const earlier = before.pullRequests?.find((entry) => entry.repositoryId === pullRequest.repositoryId && entry.number === pullRequest.number);
    if (earlier === undefined || earlier.candidateDigest === pullRequest.candidateDigest) continue;
    const repository = codeRepositoriesOf(project.definition).find((entry) => entry.name === pullRequest.repositoryId);
    if (repository === undefined) throw agentXError("CONFIG_INVALID", "the pull request's repository is not part of the task's registered project revision");
    items.push({ Update: {
      TableName: dependencies.tableName,
      Key: githubWorkflowPullRequestKey(githubRepositoryFullName(repository.url), pullRequest.number),
      UpdateExpression: "SET candidateDigest = :candidate, updatedAt = :now",
      ConditionExpression: "taskId = :taskId AND #url = :url AND candidateDigest = :previous",
      ExpressionAttributeNames: { "#url": "url" },
      ExpressionAttributeValues: { ":candidate": pullRequest.candidateDigest, ":now": now, ":taskId": task.taskId, ":url": pullRequest.url, ":previous": earlier.candidateDigest },
    } });
  }
  return items;
}

/**
 * Plan 6 Task 17: the result of the merge of the base branch into a workflow task's pull request branch. Only the merge the task is waiting on counts: it must still be at WAIT_FOR_MERGE/RUNNING with this exact
 * merge marked; anything else (the pull request merged meanwhile, the task closed or moved on) is dropped. What the merge is comes from what GitHub shows (the head is a new commit whose parents are the head the
 * task recorded and the base commit it merged, on the task's own branch, with the tree the worker reported), never from the worker's word alone: see `planBranchSyncOutcome`. A clean merge is recorded as the
 * pull request's new head and a candidate on the new base; a conflict starts a conflict round (the workspace holds the merge's files); GitHub refusing workflow files, or the conflict rounds used up, stops with a
 * plain text and a stuck milestone; anything else ends the merge with nothing recorded and the task waits for the merge as it did.
 */
export async function completedBranchSyncItems(
  dependencies: AwsBrokerDependencies,
  operation: OperationRecord,
  task: DeveloperTaskRecord & { workflow: WorkflowSnapshot },
  terminalStatus: OperationStatus,
  now: string,
  result: unknown,
  terminalError: string | undefined,
  /** `lost`: the operation ended without a result; GitHub is the only witness, so it must be readable (else the caller tries again). */
  options: { lost?: boolean } = {},
): Promise<TransactItems> {
  const binding = operation.maintenance?.workflowSync;
  const maintenance = operation.maintenance;
  const workflow = task.workflow;
  const marker = workflow.branchSync;
  if (binding === undefined || maintenance === undefined || task.closedAt !== undefined || workflow.stage !== "WAIT_FOR_MERGE" || workflow.state !== "RUNNING" || marker === undefined
    || marker.repositoryId !== maintenance.repository || marker.number !== maintenance.pullRequestNumber || marker.expectedHeadCommit !== binding.expectedHeadCommit) return [];
  const pullRequest = workflow.pullRequests?.find((entry) => entry.repositoryId === marker.repositoryId && entry.number === marker.number);
  if (pullRequest === undefined || pullRequest.headSha !== binding.expectedHeadCommit) return [];
  const taskUpdate = (next: WorkflowSnapshot): TransactItems[number] => ({ Update: {
    TableName: dependencies.tableName,
    Key: taskKey(task.taskId),
    UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
    ConditionExpression: "workflow.revision = :revision AND workflow.#stage = :stage AND workflow.#state = :running AND attribute_not_exists(closedAt)",
    ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
    ExpressionAttributeValues: { ":workflow": next, ":now": now, ":revision": workflow.revision, ":stage": "WAIT_FOR_MERGE", ":running": "RUNNING" },
  } });
  const project = await requireRecordProject(dependencies, task, task.project, task.startingRevision);
  const repository = codeRepositoriesOf(project.definition).find((entry) => entry.name === maintenance.repository);
  const host = repository === undefined ? undefined : hostOfRepository(dependencies, repository);
  const githubProvider = host?.kind === GITHUB_HOST_KIND ? dependencies.githubPullRequests : undefined;
  const parsed = terminalStatus === "SUCCEEDED" ? PullRequestLifecycleResultSchema.safeParse(result) : undefined;
  const reported = parsed?.success === true && parsed.data.repository === maintenance.repository ? parsed.data : undefined;
  // What GitHub shows now. A merge the worker says it pushed is never judged without it (the result is then recorded by the next attempt); for a merge that failed, an unreadable GitHub shows nothing.
  let github: BranchSyncGithub | undefined;
  try {
    if (repository === undefined || host === undefined || !canReadFeedback(dependencies, host)) throw agentXError("RUNTIME_UNAVAILABLE", "cannot verify the merged pull request against the merge");
    const scope = await githubScopeOf(dependencies, task);
    const current = pullRequestFactsOf(await host.feedback(changeRequestRef(repository.url, maintenance.pullRequestNumber), scope));
    let head = current.pullRequest.headCommit;
    let headTree = current.pullRequest.headTreeSha;
    // GitHub moves a pull request's head a moment after a push to its branch, and the push's result comes right after it: while the open pull request still shows the head before the push, its branch says what it holds.
    if (head === binding.expectedHeadCommit && current.pullRequest.state === "open" && canReadBranchAndTree(dependencies, host)) {
      try {
        const branchHead = await host.branchHead(repositoryRefOf(repository.url), maintenance.headBranch, scope);
        if (branchHead !== head && /^[a-f0-9]{40}$/.test(branchHead)) {
          headTree = await host.tree(repositoryRefOf(repository.url), branchHead, scope);
          head = branchHead;
        }
      } catch {
        // GitHub could not say: the pull request's own head stands.
      }
    }
    const sameRequest = current.pullRequest.number === pullRequest.number && current.pullRequest.url === pullRequest.url;
    const parents = head !== binding.expectedHeadCommit && githubProvider?.getCommitParents !== undefined ? await githubProvider.getCommitParents(repository.url, head, scope).catch(() => undefined) : undefined;
    if (sameRequest) github = { state: current.pullRequest.state, headBranch: current.pullRequest.headBranch, headCommit: head, headTreeSha: headTree, parents };
  } catch (error) {
    if (options.lost === true || (reported !== undefined && reported.commit !== binding.expectedHeadCommit)) throw error;
  }
  // Autonomy is read again where the paid round would start: set to suggest by now, and not started by a person's go-ahead, a conflict is asked about instead.
  const askFirst = reported?.conflicts !== undefined && marker.approved !== true && task.orgId !== undefined
    && await taskAutonomy(() => readTaskRecipe(dependencies, task.taskId, task.orgId!), (event, fields) => console.log(JSON.stringify({ component: "broker", event, ...fields }))) === "suggest";
  const outcome = planBranchSyncOutcome({
    askFirst, workflow, binding: { repositoryId: marker.repositoryId, number: marker.number, baseCommit: binding.baseCommit, expectedHeadCommit: binding.expectedHeadCommit },
    terminalStatus, terminalError, result: reported, github, baseBranch: maintenance.baseBranch, recordedBranch: maintenance.headBranch, now,
  });
  const link = { repository: marker.repositoryId, number: marker.number, url: pullRequest.url };
  const milestone = (kind: "fixing" | "stuck", text: string, n: number): TransactItems => task.orgId === undefined ? [] : codeMilestoneItems({ tableName: dependencies.tableName }, {
    kind, orgId: task.orgId, taskId: task.taskId, ...(task.sessionId === undefined ? {} : { sessionId: task.sessionId }), at: now, text: text.slice(0, 500), pullRequests: [link],
  }, n);
  if (outcome.kind === "unchanged") return [taskUpdate(outcome.workflow)];
  if (outcome.kind === "stopped" || outcome.kind === "asked" || outcome.kind === "gave_up") return [taskUpdate(outcome.workflow), ...milestone("stuck", outcome.message, outcome.workflow.revision)];
  if (outcome.kind === "conflict") {
    const round = outcome.workflow.fixRounds?.conflict ?? 1;
    return [
      taskUpdate(outcome.workflow),
      workflowDispatchItem(dependencies.tableName, task.taskId, outcome.workflow.revision, "IMPLEMENT", outcome.workflow.candidate?.digest ?? WORKFLOW_NO_CANDIDATE_DIGEST, now),
      ...milestone("fixing", `The branch conflicts with ${maintenance.baseBranch}, so Rovara is resolving it (try ${String(round)} of ${String(CONFLICT_ROUNDS_MAX)}).`, outcome.workflow.revision),
    ];
  }
  // A clean merge, on GitHub: the pull request's record learns its head (the worker's callback usually did already), the link follows the new candidate, and the new head is indexed for check events.
  // The linked-pull-request rows are keyed by GitHub's full name (left for P6): a repository on another host stops here with a clear sentence.
  requireGithubHost(host!);
  const repositoryFullName = githubRepositoryFullName(repository!.url);
  const record = await getItem<PullRequestRecord>(dependencies, pullRequestKey(task.workspaceId, maintenance.repository, maintenance.pullRequestNumber));
  return [
    taskUpdate(outcome.workflow),
    ...await candidateRekeyItems(dependencies, task, project, workflow, outcome.workflow, now),
    ...(record !== undefined && record.expectedHeadCommit !== outcome.headSha ? [{ Update: {
      TableName: dependencies.tableName,
      Key: pullRequestKey(task.workspaceId, maintenance.repository, maintenance.pullRequestNumber),
      UpdateExpression: "SET expectedHeadCommit = :head, #state = :state, updatedAt = :now",
      ConditionExpression: "expectedHeadCommit = :previous",
      ExpressionAttributeNames: { "#state": "state" },
      ExpressionAttributeValues: { ":head": outcome.headSha, ":state": "open", ":now": now, ":previous": maintenance.expectedHeadCommit },
    } }] : []),
    ...(task.orgId === undefined || workflow.definitionVersion !== "1.1.0" ? [] : prHeadItems(dependencies.tableName, { orgId: task.orgId, repositoryFullName, headSha: outcome.headSha, taskId: task.taskId, repositoryId: marker.repositoryId, number: marker.number }, Date.parse(now))),
  ];
}

export async function readStoredCandidateSourceExport(
  dependencies: AwsBrokerDependencies,
  reference: NonNullable<OperationRecord["candidateSourceRef"]>,
): Promise<z.infer<ReturnType<typeof workflowCandidateSourceExportSchema>> | undefined> {
  if (reference.byteLength <= 0 || reference.byteLength > MAX_WORKFLOW_CANDIDATE_EXPORT_BYTES || !/^[a-f0-9]{64}$/.test(reference.sha256)) return undefined;
  const text = await readStoredText(dependencies.s3, dependencies.artifactBucketName, reference.key, MAX_WORKFLOW_CANDIDATE_EXPORT_BYTES);
  if (text === undefined) return undefined;
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength !== reference.byteLength || createHash("sha256").update(bytes).digest("hex") !== reference.sha256) return undefined;
  const parsed = workflowCandidateSourceExportSchema().safeParse(JSON.parse(text) as unknown);
  return parsed.success ? parsed.data : undefined;
}

export async function loadWorkflowCandidateSourceExport(
  dependencies: AwsBrokerDependencies,
  operation: OperationRecord,
  expectedCandidate: ReturnType<typeof createCandidateManifest>,
): Promise<z.infer<ReturnType<typeof workflowCandidateSourceExportSchema>> | undefined> {
  const reference = operation.candidateSourceRef;
  if (!reference || reference.candidateDigest !== expectedCandidate.digest) return undefined;
  const parsed = await readStoredCandidateSourceExport(dependencies, reference);
  if (parsed === undefined || parsed.candidate.digest !== expectedCandidate.digest
    || canonicalJson(parsed.candidate) !== canonicalJson(expectedCandidate)) return undefined;
  return parsed;
}

/**
 * Whether a finished coding run is a custom sequence's build that another build follows: the workflow program is at that
 * build, and the run carries no approved work breakdown (an ordered run records its candidate and checks as it always did).
 */
function programContinuesCoding(workflow: WorkflowSnapshot, operation: OperationRecord, dependencyBinding: unknown): boolean {
  if (operation.workflowMode !== "IMPLEMENT" || workflow.program === undefined || workflow.stage !== "IMPLEMENT" || dependencyBinding !== undefined) return false;
  if (workflow.program.steps.find((step) => step.id === workflow.programStepId)?.kind !== "build") return false;
  const move = nextProgramStep(workflow.program, workflow.programStepId, "done");
  return move.kind === "step" && move.step.kind === "build";
}

/* Plan 6 Task 10 note: the setup-draft branch is first in completedWorkflowItems. */
export async function completedWorkflowItems(
  dependencies: AwsBrokerDependencies,
  operation: OperationRecord,
  pointer: DeveloperTaskPointerRecord | undefined,
  terminalStatus: OperationStatus,
  now: string,
  result: unknown,
  terminalError?: string,
  /** Collects the evidence a stored plan's own callback read (no evidence job configured), to attach once the plan has committed. */
  inlineEvidence?: InlineEvidence[],
  /** Collects the planner's answers to the comments its Request changes sent, to write as replies once the plan has committed. */
  plannerReplies?: PlannerReplies[],
  /** A cancel may terminalize only this exact current graph IMPLEMENT operation. */
  graphCancelTarget?: OperationRecord,
  /** A cancel may terminalize only this exact current native E2E CHECKS round. */
  e2eCancelTarget?: OperationRecord,
): Promise<TransactItems> {
  if (pointer === undefined) return [];
  const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(pointer.taskId));
  // Plan 6 Task 10: a setup draft's result is its draft (or the reason there is none), written with the result.
  if (task?.purpose === "setup_draft") {
    const repositories = terminalStatus === "SUCCEEDED" && operation.kind === "task"
      ? setupDraftRepositoriesOf((await requireRecordProject(dependencies, task, task.project, task.startingRevision)).definition) : { names: [], urls: {} };
    return setupDraftEndItems(dependencies.tableName, task, operation, { status: terminalStatus, result, error: terminalError, repositories }, now);
  }
  if (task?.workflow === undefined) return [];
  // Meta repo lane D: a spec write's or a spec publication's end settles the task's spec state; neither is a step of the workflow, so nothing below applies to it.
  if (isSpecOperation(operation)) return specOperationEndItems(specEndEnvironmentOf(dependencies), task.taskId, operation, { status: terminalStatus, result });
  if (operation.kind === "prepare") {
    // The commit preparation checked out is the task's base until a verified candidate pins it. It comes from the
    // prepare's own result, before the agent has run, never from a later candidate the agent's workspace reports.
    if (terminalStatus !== "SUCCEEDED" || task.workflow.reviewBase !== undefined) return [];
    const reported = result !== null && typeof result === "object" ? (result as { preparedBase?: unknown }).preparedBase : undefined;
    const preparedBase = PreparedBaseSchema.safeParse(reported);
    // Meta repo lane A: the task's knowledgeCommit is the one the broker chose for this prepare, kept only when the worker reported the same one.
    const knowledgeCommit = knowledgeCommitToStore(operation.knowledgeCommit, result);
    return [{ Update: {
      TableName: dependencies.tableName,
      Key: taskKey(task.taskId),
      ...taskPreparedUpdate(preparedBase.success ? preparedBase.data : undefined, knowledgeCommit),
      ConditionExpression: "attribute_exists(pk)",
    } }];
  }
  if (operation.kind === "publish") {
    if (terminalStatus !== "SUCCEEDED" || task.workflow.stage !== "PULL_REQUEST" || task.workflow.state !== "READY" || task.workflow.candidate === undefined) return [];
    const published = PullRequestResultSchema.safeParse(result);
    if (!published.success) throw agentXError("CONFIG_INVALID", "workflow pull request result is invalid");
    const project = await requireRecordProject(dependencies, task, task.project, task.startingRevision);
    const repository = codeRepositoriesOf(project.definition).find((entry) => entry.name === published.data.repository);
    if (repository === undefined) throw agentXError("CONFIG_INVALID", "published pull request repository is not part of the task's registered project revision");
    // P5d: the code host the repository's record names (an unknown kind is refused). The linked-pull-request rows are keyed by GitHub's full name (left for P6), so another host stops here.
    const host = hostOfRepository(dependencies, repository);
    requireGithubHost(host);
    const repositoryFullName = githubRepositoryFullName(repository.url);
    if (!pullRequestMatchesRepository(published.data.url, repositoryFullName, published.data.number)) {
      throw agentXError("CONFIG_INVALID", "published pull request URL does not match the task's registered repository");
    }
    const publishedRecord = await requirePullRequest(dependencies, task.workspaceId, published.data.repository, published.data.number);
    if (publishedRecord.url !== published.data.url || publishedRecord.expectedHeadCommit !== published.data.commit) {
      throw agentXError("STALE_FENCE", "published pull request head does not match the broker-verified publication");
    }
    const candidateRepository = task.workflow.candidate.repositories.find(entry => entry.repositoryId === published.data.repository);
    if (candidateRepository === undefined || !canReadFeedback(dependencies, host)) {
      throw agentXError("RUNTIME_UNAVAILABLE", "cannot verify the published pull request against the checked candidate");
    }
    const publishedFeedback = pullRequestFactsOf(await host.feedback(changeRequestRef(repository.url, published.data.number), await githubScopeOf(dependencies, task)));
    if (publishedFeedback.pullRequest.number !== published.data.number
      || publishedFeedback.pullRequest.url !== published.data.url
      || publishedFeedback.pullRequest.state !== "open"
      || publishedFeedback.pullRequest.headCommit !== publishedRecord.expectedHeadCommit
      || publishedFeedback.pullRequest.headTreeSha !== candidateRepository.treeSha) {
      throw agentXError("STALE_FENCE", "published pull request does not contain the exact checked candidate tree");
    }
    const indexKey = githubWorkflowPullRequestKey(repositoryFullName, published.data.number);
    const existingIndex = await getItem<GithubWorkflowPullRequestRecord>(dependencies, indexKey);
    const indexRecord: GithubWorkflowPullRequestRecord = {
      ...indexKey,
      entityType: "GITHUB_WORKFLOW_PR",
      repositoryFullName,
      repositoryId: published.data.repository,
      number: published.data.number,
      url: published.data.url,
      taskId: task.taskId,
      workspaceId: task.workspaceId,
      candidateDigest: task.workflow.candidate.digest,
      createdAt: now,
    };
    if (existingIndex !== undefined && (existingIndex.taskId !== indexRecord.taskId
      || existingIndex.candidateDigest !== indexRecord.candidateDigest
      || existingIndex.url !== indexRecord.url)) {
      throw agentXError("CONFIG_INVALID", "this pull request is already linked to another task or candidate");
    }
    const next = registerWorkflowPullRequest(task.workflow, {
      repositoryId: published.data.repository,
      number: published.data.number,
      url: published.data.url,
      headSha: publishedRecord.expectedHeadCommit,
      headTreeSha: publishedFeedback.pullRequest.headTreeSha,
      candidateDigest: task.workflow.candidate.digest,
      required: true,
    }, now);
    return [{ Update: {
      TableName: dependencies.tableName,
      Key: taskKey(task.taskId),
      UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
      ConditionExpression: "workflow.revision = :revision AND workflow.#stage = :stage AND workflow.#state = :ready AND attribute_not_exists(closedAt)",
      ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
      ExpressionAttributeValues: { ":workflow": next, ":now": now, ":revision": task.workflow.revision, ":stage": "PULL_REQUEST", ":ready": "READY" },
    } }, ...(existingIndex === undefined ? [{ Put: {
      TableName: dependencies.tableName,
      Item: indexRecord,
      ConditionExpression: "attribute_not_exists(pk)",
    } }] : []),
    // More repositories to go: the next draft pull request is due, as the first one was after the reviews.
    ...(next.stage === "PULL_REQUEST" && next.state === "READY" && next.candidate !== undefined
      ? [workflowDispatchItem(dependencies.tableName, task.taskId, next.revision, "PUBLISH", next.candidate.digest, now)] : []),
    // The head, for the check and status events that name only a commit (Plan 6 Task 14).
    ...(task.orgId === undefined || task.workflow.definitionVersion !== "1.1.0" ? [] : prHeadItems(dependencies.tableName, {
      orgId: task.orgId, repositoryFullName, headSha: publishedRecord.expectedHeadCommit, taskId: task.taskId, repositoryId: published.data.repository,
      number: published.data.number, branch: publishedRecord.headBranch,
    }, Date.parse(now))),
    // The task's recovery row: a Rovara Code (version 2) task's becomes its tracking row; any other task's stays the merge row it always was.
    ...((task.workflow.pullRequests ?? []).length === 0
      ? [(task.workflow.definitionVersion === "1.1.0" ? trackingRecoveryItem : mergeRecoveryItem)(dependencies.tableName, task.taskId, now)] : [])];
  }
  // Plan 6 Task 17: a merge of the base branch is told apart from the push of a reviewed fix by what the operation was asked.
  if (operation.kind === "maintain" && operation.maintenance?.workflowSync !== undefined) return completedBranchSyncItems(dependencies, operation, task as DeveloperTaskRecord & { workflow: WorkflowSnapshot }, terminalStatus, now, result, terminalError);
  if (operation.kind === "maintain") return completedPullRequestUpdateItems(dependencies, operation, task as DeveloperTaskRecord & { workflow: WorkflowSnapshot }, terminalStatus, now, result, terminalError);
  if (operation.kind !== "task" || operation.workflowMode === undefined || task.workflow.state !== "RUNNING") return [];
  // M1.3 Task 3.7b: the candidate's completion refuses a baseline round (the unchanged code, for information only), whatever state the workflow is in. Its result moves nothing here:
  // it settles its own record (settleBaselineRound) after the terminal result is committed.
  // M1.4 Task 4.6b: the same for an audit replay of a verified round (no model, an operator's check): it settles its own record (settleReplayRound) and moves nothing here.
  if (isNonCandidateRound(operation.workflowE2EAdmission)) return [];
  let next: WorkflowSnapshot;
  // The planning answer's own outcome for the task record: why it could not be read, or `null` to forget an old reason.
  let planUnreadable: DeveloperTaskRecord["planUnreadable"] | null | undefined;
  /** Trust fix A2: what a review on the build's own model leaves on the task (`reviewSameModel`): the flag for this code, null to clear an earlier one, undefined to leave it. */
  let reviewSameModel: DeveloperTaskRecord["reviewSameModel"] | null | undefined;
  // Plan self-check: the answer was not shown (unreadable once, or its own checks found a problem); the planner is asked again by itself, once per document version.
  let planSelfCheck: PlanSelfCheckState | undefined;
  let planRevision: { prompt: string } | undefined;
  // T7c: the plan is held back for its check on the current app: the task keeps it (and a dispatch row for the check) instead of submitting it.
  let planHold: PlanGroundingHold | undefined;
  // A stored plan that cites code: the job that reads that code later, committed with the plan.
  let evidenceJob: { artifactId: string; artifactSha256: string } | undefined;
  /** The record of the comments the planner answered, committed with the plan it answered them in. */
  let recordedReplies: ReturnType<typeof plannerRepliesItem> | undefined;
  /** Plan 3, Task 34: what the coding plan that just reached review is expected to cost, committed with it. */
  let runEstimate: RunEstimate | undefined;
  let dropStaleEstimate = false;
  /** Plan 6 Task 4: Understand chose the Full path for a task that started under the Quick planning limit: the limit goes up with the result, from `seen` to `limit`. */
  let raisedPlanningLimit: { seen: number; limit: number } | undefined;
  /** Plan 6 Task 4: the finished Understand's watchdog row goes with its result. */
  let understandWatchdog: TransactItems = [];
  let answeredItems: TransactItems = [];
  /** Plan 6 Task 15: a CI fix round that changed nothing tells a person (the milestone), in the commit that stops it. */
  let fixExitItems: TransactItems = [];
  let e2eAuthorityChecks: Array<Record<string, unknown>> = [];
  if (operation.workflowMode === "IMPLEMENT" || operation.workflowMode === "CHECKS") {
    const reported = result !== null && typeof result === "object" ? result as Record<string, unknown> : {};
    const dependencyBinding = operation.workflowDependencies;
    const dependencyResult = dependencyBinding === undefined ? undefined : WorkflowDependencyResultSchema.safeParse(reported.workflowDependenciesResult);
    const dependencyOrder = dependencyBinding === undefined ? [] : taskGraphOrder(dependencyBinding.graph);
    const acknowledgedTerminal = dependencyBinding === undefined ? undefined : workflowDependencyAttemptTerminalProgress({
      graph: dependencyBinding.graph, approval: dependencyBinding.approval, operationId: operation.id,
      sequenceStart: dependencyBinding.sequenceStart, resumeProgress: dependencyBinding.resumeProgress,
      history: task.workflow.workflowDependenciesProgress ?? [], parallel: dependencyBinding.parallel,
    });
    const dependencyResultValid = dependencyBinding !== undefined && dependencyResult?.success === true
      && dependencyResult.data.taskId === dependencyBinding.graph.taskId
      && dependencyResult.data.graphDigest === dependencyBinding.approval.graphDigest
      && dependencyResult.data.runId === dependencyBinding.approval.runId
      && dependencyResult.data.operationId === operation.id
      && dependencyResult.data.workflowRevision === dependencyBinding.approval.workflowRevision
      && task.workflow.workflowDependenciesApproval?.artifactDigest === dependencyBinding.approval.artifactDigest
      && task.workflow.workflowDependenciesApproval.graphDigest === dependencyBinding.approval.graphDigest
      && task.workflow.workflowDependenciesApproval.workflowRevision === dependencyBinding.approval.workflowRevision
      && task.workflow.workflowDependenciesApproval.actorId === dependencyBinding.approval.actorId
      && task.workflow.workflowDependenciesApproval.runId === dependencyBinding.approval.runId
      && acknowledgedTerminal !== undefined
      && dependencyResult.data.items.length === acknowledgedTerminal.length
      && dependencyResult.data.items.every((item, index) => canonicalJson(item) === canonicalJson(acknowledgedTerminal[index]))
      && dependencyResult.data.items.every((item, index) => item.itemId === dependencyOrder[index]
        && item.sequence > 0
        // One at a time: each item starts on the tree the one before it ended on. In parallel the items are merged as they finish, so each names the tree it was merged into instead.
        && (dependencyBinding.parallel !== undefined
          ? item.state !== "IMPLEMENTED" || (item.integratedTreeSha ?? item.candidateTreeSha) !== undefined
          : index === 0 || dependencyResult.data.items[index - 1]?.state === "IMPLEMENTED"
            && dependencyResult.data.items[index - 1]?.candidateTreeSha === item.baseTreeSha));
    const graphItemsComplete = dependencyBinding !== undefined && dependencyResult?.success === true
      && dependencyResult.data.status === "SUCCEEDED"
      && dependencyResult.data.items.length === dependencyBinding.graph.items.length
      && dependencyResult.data.items.every((item) => item.state === "IMPLEMENTED");
    if (terminalStatus !== "SUCCEEDED") {
      next = blockWorkflow(task.workflow, terminalError?.includes(WORKFLOW_HISTORY_REWRITTEN_MESSAGE) === true ? WORKFLOW_HISTORY_REWRITTEN_MESSAGE
        : terminalError?.includes(WORKFLOW_NO_CODE_CHANGE_MESSAGE) === true ? WORKFLOW_BLOCK_REASONS.noCodeChanged
        // Live steer: the owner's live message asked for a change outside the approved plan and the step stopped for the owner's approval.
        : terminalError?.includes(WORKFLOW_LIVE_STEER_REAPPROVAL_MESSAGE) === true ? liveSteerCodingStop(task.workflow, terminalError)
        // The checks' rerun could not first stop the programs earlier work left running, so no check ran: its own reason, and a person decides (nothing sends it back or retries it by itself).
        : terminalError?.includes(WORKFLOW_LEFTOVER_PROCESSES_MESSAGE) === true ? WORKFLOW_BLOCK_REASONS.leftoverProcesses
        // The checks' fresh dev container ran its setup and that changed the project's files: the checks did not run on them, and a person decides.
        : terminalError?.includes(WORKFLOW_SETUP_CHANGED_FILES_MESSAGE) === true ? WORKFLOW_BLOCK_REASONS.setupChangedFiles
        // Plan 3, Task 32: the step's budget ran out; a spend request is asked for at the end of this result, and its approval retries the step.
        : terminalError === BUDGET_EXHAUSTED_FAILURE_MESSAGE ? WORKFLOW_BLOCK_REASONS.budgetPaused
        // Plan 6 Task 16: Rovara's own decision was refused when the worker started (a commenter lost write access, or the autonomy was lowered): the owner is told which.
        : task.workflow.fixSource === "feedback" && operation.workflowFeedbackApproval?.autonomy !== undefined && terminalError?.includes("feedback-approval failed") === true ? FEEDBACK_NOT_RUN_REASON
        : workflowRunEndedReason(operation.workflowMode, terminalStatus), now,
        // A coding run that left the code as it was reports what it found; it is rebuilt here (redacted and bounded again) and kept only with that stop, whatever else the result held.
        { noChangeFindings: noChangeFindingsFrom(reported.noChangeFindings) });
      const progress = task.workflow.workflowDependenciesProgress ?? [];
      const unfinished = progress.at(-1);
      if (dependencyBinding?.parallel !== undefined) {
        // Parts run side by side, so a stopped run can leave several started and unfinished: each is marked unknown, in the order it started.
        const open = new Map<string, (typeof progress)[number]>();
        for (const entry of progress) {
          if (entry.operationId !== operation.id) continue;
          if (entry.state === "STARTED") open.set(entry.itemId, entry);
          else open.delete(entry.itemId);
        }
        let marked = progress;
        for (const entry of [...open.values()].sort((left, right) => left.sequence - right.sequence)) {
          const { candidateTreeSha: _tree, integratedTreeSha: _integrated, ...rest } = entry;
          void _tree; void _integrated;
          marked = [...marked, { ...rest, sequence: (marked.at(-1)?.sequence ?? entry.sequence) + 1, state: "UNKNOWN" as const, at: now, producer: "agentx-broker-terminal" }];
        }
        if (marked !== progress) next = WorkflowSnapshotSchema.parse({ ...next, workflowDependenciesProgress: marked });
      } else if (dependencyBinding !== undefined && unfinished?.operationId === operation.id && unfinished.state === "STARTED") {
        const unknown = { ...unfinished, sequence: unfinished.sequence + 1, state: "UNKNOWN" as const, at: now, producer: "agentx-broker-terminal" };
        delete unknown.candidateTreeSha;
        next = WorkflowSnapshotSchema.parse({ ...next, workflowDependenciesProgress: [...progress, unknown] });
      }
    } else if (programContinuesCoding(task.workflow, operation, dependencyBinding)) {
      // A custom sequence's build followed by another build: the code is not checked or reviewed yet, so no candidate
      // is recorded; the workflow is ready for the next build, which the dispatch below starts.
      next = completeWorkflowBuild(task.workflow, now);
    } else {
      const repositories = Array.isArray(reported.workflowCandidateRepositories) ? reported.workflowCandidateRepositories : [];
      const checkedRepositories = Array.isArray(reported.workflowCheckCandidateRepositories) ? reported.workflowCheckCandidateRepositories : [];
      const checks = CheckReportSchema.safeParse(reported.checks);
      const verifying = { ...blockWorkflow(task.workflow, "candidate checks are being recorded", now), stage: "VERIFY" as const };
      let verificationFailure: string = WORKFLOW_BLOCK_REASONS.checksUnconfirmed;
      // Why, for the log only: the owner reads the plain reason.
      let verificationDetail: string | undefined;
      // Review only: the tests the rerun found regressed, for the owner's message and a send-back.
      let regressedChecks: string[] | undefined;
      let failedE2ERound: { status: "FAILED"; candidateDigest: string; roundId: string; groupRunIds: string[]; admissionSha256: string; evidenceSha256: string } | undefined;
      try {
        if (dependencyBinding !== undefined && (!dependencyResultValid || !graphItemsComplete)) {
          verificationFailure = "approved work breakdown result is missing, stale or incomplete";
          throw new Error(verificationFailure);
        }
        // A custom sequence runs the approved work breakdown in its first build only; its later builds carry none.
        // 0.4.17: the one run that may go without a graph is a CI, conflict or feedback fix (the worker protocol forbids a fix to carry one), and then only when the workflow names a different run as
        // carrying the graph. Every start that carries a binding writes that run's ID onto the workflow in the same transaction as the operation (workflowWithCurrentGraphOperation), so a fix
        // keeps the first build's ID. Any other unbound run still blocks, whatever ID the workflow names.
        if (dependencyBinding === undefined && task.workflow.workflowDependenciesApproval !== undefined && operation.workflowMode === "IMPLEMENT"
          && task.workflow.stage === "IMPLEMENT" && !laterProgramBuild(task.workflow)
          && !(task.workflow.fixSource !== undefined && task.workflow.workflowDependenciesOperationId !== undefined && task.workflow.workflowDependenciesOperationId !== operation.id)) {
          verificationFailure = "approved work breakdown was not carried into this implementation";
          throw new Error(verificationFailure);
        }
        if (operation.workflowMode === "CHECKS" && task.workflow.stage !== "VERIFY") {
          verificationFailure = WORKFLOW_BLOCK_REASONS.checkRetryStale;
          throw new Error("verification retry stage changed");
        }
        if (!checks.success) {
          verificationFailure = WORKFLOW_BLOCK_REASONS.checkReportUnreadable;
          throw new Error("invalid check report");
        }
        // Review only: the approved plan and the project select no check, so "no checks ran" is the expected report. The
        // candidate is still validated below exactly as for a checked task. A task with no stored policy is never this.
        const reviewOnly = workflowIsReviewOnly(task.workflow.checkPolicy);
        // Review only still stops on evidence AgentX saw itself: a rerun test that passed before fails now.
        if (reviewOnly && checks.data.status === "regression") {
          verificationFailure = WORKFLOW_BLOCK_REASONS.regressionFound;
          verificationDetail = checks.data.status;
          regressedChecks = regressedCheckLabels(checks.data.checks);
          throw new Error("a rerun test regressed");
        }
        // Review only: no checks to run, or a rerun of the agent's own tests that stopped or errored, is no evidence either
        // way (a regression that stands through a stop is reported as one); reviews decide.
        if (checks.data.status === "not_verified" && !reviewOnly) {
          verificationFailure = checks.data.notVerifiedReason === "no_checks" ? WORKFLOW_BLOCK_REASONS.noChecksConfigured : WORKFLOW_BLOCK_REASONS.checkRunnerFailed;
          verificationDetail = checks.data.notVerifiedReason ?? checks.data.status;
          throw new Error("checks were not verified");
        }
        const project = await requireRecordProject(dependencies, task, task.project, task.startingRevision);
        const expectedRepositoryIds = project.definition.repositories.map((repository) => repository.name).sort();
        const candidateInput = repositories as CandidateRepository[];
        const candidate = createCandidateManifest(candidateInput);
        if (task.workflow.e2e?.required === true && operation.workflowMode === "IMPLEMENT") {
          const sourceExport = await loadWorkflowCandidateSourceExport(dependencies, operation, candidate);
          if (sourceExport === undefined) {
            verificationFailure = WORKFLOW_MISSING_COMMITTED_SOURCE_EXPORT_REASON;
            throw new Error(verificationFailure);
          }
        }
        let e2eQualification: { candidateDigest: string; contractDigest: string; policyDigest: string; bundleDigest: string; executionPlanDigest: string;
          roundId: string; groupRunIds: string[]; admissionSha256: string; evidenceSha256: string } | undefined;
        if (operation.workflowMode === "CHECKS" && task.workflow.e2e?.required === true) {
          if (isNonCandidateRound(operation.workflowE2EAdmission)) throw new Error("a baseline or replay round is never a candidate's CHECKS");
          if (task.workflow.e2e.currentGroupRunIds.length === 0 || task.workflow.e2e.currentRoundId === undefined
            || operation.workflowE2EAdmission === undefined || operation.workflowE2EEvidenceRef === undefined) {
            verificationFailure = "the current candidate-bound E2E round or its private evidence is missing";
            throw new Error(verificationFailure);
          }
          const e2eDiagnostic: WorkflowE2EVerificationDiagnostic = {};
          // The operation's stored record is still RUNNING here; this callback is the one that ends it, as SUCCEEDED (a failed or stopped run never reaches verification).
          const qualification = await verifyWorkflowE2EEvidence(dependencies, operation, task, candidate, undefined, e2eDiagnostic, { terminalStatus: "SUCCEEDED" });
          e2eAuthorityChecks = e2eDiagnostic.authorityChecks ?? [];
          if (e2eAuthorityChecks.length === 0) {
            // An application round says why its authority could not be fenced (a requalified runtime, a moved source); the portable message is unchanged. A runtime that
            // moved under the round is worded as the dispatch words it, so the owner's retry approves the plan again against it (or asks an administrator first), in one step.
            const why = e2eDiagnostic.application === true ? e2eDiagnostic.reason?.slice(0, 240) : undefined;
            // Evidence that could not be read or decoded, found before authority was judged at all, is not an authority failure and is not worded as one.
            verificationFailure = e2eDiagnostic.application === true && e2eDiagnostic.authorityEvaluated !== true && why !== undefined ? `admitted E2E evidence is incomplete or unknown (${why})`
              : e2eDiagnostic.runtimeChange === "requalified" && why !== undefined ? `${WORKFLOW_APPLICATION_SELECTION_CHANGED_PREFIX}${why}`
              : e2eDiagnostic.runtimeChange === "unusable" && why !== undefined ? `${WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX}${why}`
              : e2eDiagnostic.runtimeChange === "accounts" && why !== undefined ? `${WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX}${why}`
              : `current E2E authority snapshot could not be fenced at terminal persistence${why === undefined ? "" : ` (${why})`}`;
            throw new Error(verificationFailure);
          }
          if (qualification !== "PASS") {
            if (qualification === "FAILED" && operation.workflowE2EAdmission !== undefined && operation.workflowE2EEvidenceRef !== undefined) {
              failedE2ERound = { status: "FAILED", candidateDigest: candidate.digest, roundId: operation.workflowE2EAdmission.roundId,
                groupRunIds: [...operation.workflowE2EAdmission.groupRunIds], admissionSha256: operation.workflowE2EAdmission.admissionRef.sha256,
                evidenceSha256: operation.workflowE2EEvidenceRef.sha256 };
            }
            verificationFailure = qualification === "FAILED" ? "one or more admitted E2E groups failed"
              : `admitted E2E evidence is incomplete or unknown${e2eDiagnostic.reason === undefined ? "" : ` (${e2eDiagnostic.reason})`}`;
            throw new Error(verificationFailure);
          }
          const admittedE2E = task.workflow.e2e;
          const admissionRef = operation.workflowE2EAdmission;
          const evidenceRef = operation.workflowE2EEvidenceRef;
          if (!admittedE2E || !admissionRef || !evidenceRef) throw new Error("trusted E2E aggregate references are unavailable");
          e2eQualification = { candidateDigest: candidate.digest, contractDigest: admittedE2E.contractDigest, policyDigest: admittedE2E.policyDigest,
            bundleDigest: admittedE2E.bundleDigest, executionPlanDigest: admittedE2E.executionPlanDigest, roundId: admissionRef.roundId,
            groupRunIds: [...admissionRef.groupRunIds], admissionSha256: admissionRef.admissionRef.sha256, evidenceSha256: evidenceRef.sha256 };
        }
        const checkedCandidate = createCandidateManifest(checkedRepositories as CandidateRepository[]);
        if (dependencyBinding !== undefined && dependencyResult?.success === true && dependencyResult.data.candidateDigest !== candidate.digest) {
          verificationFailure = "work breakdown result does not bind the final combined candidate";
          throw new Error(verificationFailure);
        }
        if (dependencyBinding !== undefined && dependencyResult?.success === true) {
          // In parallel the combined tree is the one the last part to finish was merged into; one at a time it is the last item's tree.
          const finalProgress = dependencyBinding.parallel === undefined ? dependencyResult.data.items.at(-1)
            : [...dependencyResult.data.items].sort((left, right) => right.sequence - left.sequence)[0];
          const actualFinalTree = candidate.repositories.length === 1 ? candidate.repositories[0]?.treeSha : undefined;
          const expectedFinalTree = dependencyBinding.parallel === undefined ? finalProgress?.candidateTreeSha : finalProgress?.integratedTreeSha ?? finalProgress?.candidateTreeSha;
          if (finalProgress?.state !== "IMPLEMENTED" || actualFinalTree === undefined || expectedFinalTree !== actualFinalTree) {
            verificationFailure = "work breakdown final item does not bind the final combined candidate tree";
            throw new Error(verificationFailure);
          }
        }
        if (candidate.repositories.map((repository) => repository.repositoryId).sort().join("\n") !== expectedRepositoryIds.join("\n")) {
          verificationFailure = WORKFLOW_BLOCK_REASONS.repositoriesIncomplete;
          throw new Error("candidate repositories are incomplete");
        }
        // An approved fix to an open pull request that leaves every repository's code as the pull request holds it changed
        // nothing: there is nothing to check again or push, so the thread must not say a fix was pushed. The comparison is
        // with what each pull request holds, never with the latest candidate: after a fix that failed its checks and a
        // Send back, the latest candidate is that failed fix.
        const pullRequestTrees = workflowPullRequestTrees(task.workflow);
        if (operation.workflowMode === "IMPLEMENT" && pullRequestTrees !== undefined
          && candidate.repositories.every((repository) => pullRequestTrees.get(repository.repositoryId) === repository.treeSha)) {
          verificationFailure = WORKFLOW_BLOCK_REASONS.fixChangedNothing;
          throw new Error("the fix left the pull request's code as it was");
        }
        if (checkedCandidate.digest !== candidate.digest) {
          verificationFailure = WORKFLOW_BLOCK_REASONS.codeChangedAfterChecks;
          throw new Error("checked candidate is stale");
        }
        // Reviewers judge the change from the task's base, so every repository must say where it started.
        if (candidate.repositories.some((repository) => repository.baseCommitSha === undefined)) {
          verificationFailure = WORKFLOW_BLOCK_REASONS.startUnrecorded;
          throw new Error("candidate has no base commit");
        }
        const pinnedBase = task.workflow.reviewBase;
        // Before the first pin, the candidate must start where preparation checked out; the worker's own report of
        // its base is never trusted on its own.
        const expectedBase = pinnedBase ?? task.preparedBase;
        if (expectedBase === undefined) {
          verificationFailure = WORKFLOW_BLOCK_REASONS.startUnrecorded;
          throw new Error("the task has no prepared base commit");
        }
        if (candidate.repositories.some((repository) =>
          expectedBase.find((entry) => entry.repositoryId === repository.repositoryId)?.baseCommitSha !== repository.baseCommitSha)) {
          verificationFailure = WORKFLOW_BLOCK_REASONS.startChanged;
          throw new Error("candidate base commit differs from the task's base");
        }
        // P5d: each repository's starting commit is confirmed with the code host its record names (an unknown kind is refused: the confirmation fails).
        if (pinnedBase === undefined) {
          // Before pinning, confirm GitHub has each starting commit, so the base is real history and not a local commit.
          try {
            for (const repository of candidate.repositories) {
              const definition = project.definition.repositories.find((entry) => entry.name === repository.repositoryId);
              if (definition === undefined) throw new Error("candidate repository is not registered");
              const host = hostOfRepository(dependencies, definition);
              // A GitHub provider built without the read (a harness) cannot confirm it: the worker's word stands, as it did before the port.
              if (!canReadTree(dependencies, host)) continue;
              await host.tree(repositoryRefOf(definition.url), repository.baseCommitSha as string, await githubScopeOf(dependencies, task));
            }
          } catch (error) {
            verificationFailure = WORKFLOW_BLOCK_REASONS.startUnconfirmed;
            throw error;
          }
        }
        const selectedChecks = workflowSelectedChecks(task.workflow.checkPolicy);
        // The worker reports the readiness commands it was sent (required, then proposed, then selected optional,
        // in selectedChecks order) as `readiness:<index>`; agent-claimed entries never stand in for them, not even when
        // no check was selected: then there are no results, a review-only task records none, and any other task stops
        // (fails closed).
        const byId = new Map(checks.data.checks.filter((entry) => entry.source === "project").map((entry) => [entry.id, entry]));
        const results = selectedChecks.map((check, index) => {
          const entry = byId.get(`readiness:${index}`);
          const status = entry === undefined || entry.after === "not_run" || entry.after === "unknown" ? "UNKNOWN" as const : entry.after === "passed" ? "PASS" as const : "FAILED" as const;
          // The worker's report of a program it could not start, which is all the check's output then holds.
          const programNotFound = status === "FAILED" && entry?.output.trim() === `spawn ${check.command.executable} ENOENT`;
          // Any other spawn error the worker reports as the check's whole output (EAGAIN, EACCES, ...), with no exit code:
          // the process never started. (A check that ran and printed those words has its exit code.)
          const neverStarted = status === "FAILED" && !programNotFound && entry?.exitCode == null && /^spawn \S+ E[A-Z]+$/u.test(entry?.output.trim() ?? "");
          const broken = status === "FAILED" && entry !== undefined && (programNotFound || neverStarted || checkCommandCouldNotRun(check.command, entry.exitCode, entry.output));
          return { checkId: check.id, status, ...(programNotFound ? { programNotFound: true as const } : {}), ...(broken ? { broken: true as const } : {}),
            ...(neverStarted ? { neverStarted: true as const } : {}) };
        });
        if (results.length === 0 && !reviewOnly) {
          verificationFailure = WORKFLOW_BLOCK_REASONS.noCheckResults;
          throw new Error("there are no selected check results");
        }
        next = recordWorkflowVerification(verifying, {
          candidate,
          checks: {
            candidateDigest: candidate.digest,
            producer: "agentx-worker-checks",
            environmentId: task.workspaceId,
            recordedAt: now,
            results,
            ...(reviewOnly ? { reviewOnly: true } : {}),
          },
          now,
          ...(e2eQualification === undefined ? {} : { e2eQualification }),
        });
      } catch (error) {
        console.log(JSON.stringify({ component: "broker", event: "workflow.verification_blocked", taskId: task.taskId, operationId: operation.id, errorName: error instanceof Error ? error.name : "unknown", reason: verificationFailure, ...(verificationDetail === undefined ? {} : { detail: verificationDetail }) }));
        if (verificationFailure === WORKFLOW_BLOCK_REASONS.fixChangedNothing && task.workflow.fixSource === "ci" && task.orgId !== undefined) {
          // A round for failing CI that left the code as the pull request holds it: the failure is not this change's, so a person is asked to look (the round stays counted).
          next = endWorkflowCiFixUnrelated(task.workflow, now);
          fixExitItems = ciFixUnrelatedItems({ tableName: dependencies.tableName, orgId: task.orgId, taskId: task.taskId, ...(task.sessionId === undefined ? {} : { sessionId: task.sessionId }), next, at: now });
        } else {
          next = verificationFailure === WORKFLOW_BLOCK_REASONS.fixChangedNothing ? blockWorkflow(task.workflow, verificationFailure, now)
            : blockWorkflow(verifying, verificationFailure, now, { ...(regressedChecks === undefined ? {} : { regressedChecks }),
              ...(failedE2ERound === undefined ? {} : { failedE2ERound }) });
        }
      }
    }
  } else if (operation.workflowMode === "REVIEW") {
    if (terminalStatus !== "SUCCEEDED") {
      // A review that stopped because its base rule files could not be verified says so; any other stop keeps the generic reason.
      next = blockWorkflow(task.workflow, terminalError?.includes(WORKFLOW_RULE_FILES_UNVERIFIED_MESSAGE) === true ? WORKFLOW_BLOCK_REASONS.ruleFilesUnverified
        // The programs earlier work left running could not be stopped, so the review never read the code: stopped here with its own reason, for the owner's Retry.
        : terminalError?.includes(WORKFLOW_LEFTOVER_PROCESSES_MESSAGE) === true ? WORKFLOW_BLOCK_REASONS.leftoverProcesses
        : workflowRunEndedReason("REVIEW", terminalStatus), now);
    } else {
      const reported = result !== null && typeof result === "object" ? result as Record<string, unknown> : {};
      const repositories = Array.isArray(reported.workflowCandidateRepositories) ? reported.workflowCandidateRepositories : [];
      const reviews = reported.workflowReviews;
      let reviewFailure = "independent candidate review was invalid, incomplete, or stale";
      try {
        if (!Array.isArray(reviews)) throw new Error("review result has an invalid report collection");
        const candidate = createCandidateManifest(repositories as CandidateRepository[]);
        if (task.workflow.stage !== "REVIEW" || task.workflow.candidate?.digest !== candidate.digest) {
          throw new Error("review result is stale, incomplete, or came from another operation");
        }
        if (task.workflow.e2e?.required === true) {
          const currentRoundId = task.workflow.e2e.currentRoundId;
          const checksOperations = (await queryAllItems(dependencies, `WORKSPACE#${task.workspaceId}`, "OPERATION#"))
            .filter((item) => item.entityType === "OPERATION" && item.kind === "task" && item.workflowMode === "CHECKS")
            .map((item) => item as unknown as OperationRecord)
            .filter((item) => item.workflowE2EAdmission?.candidateDigest === candidate.digest
              && item.workflowE2EAdmission.roundId === currentRoundId && item.workflowE2EEvidenceRef !== undefined)
            .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
          const checksOperation = checksOperations[0];
          const e2eDiagnostic: WorkflowE2EVerificationDiagnostic = {};
          if (checksOperation === undefined || await verifyWorkflowE2EEvidence(dependencies, checksOperation, task, candidate, undefined, e2eDiagnostic) !== "PASS") {
            throw new Error("current E2E evidence is not independently qualified for review");
          }
          e2eAuthorityChecks = e2eDiagnostic.authorityChecks ?? [];
          if (e2eAuthorityChecks.length === 0) throw new Error("current E2E authority snapshot could not be fenced at review persistence");
        }
        // What the workflow keeps of a report: neither the same-model flag (the broker's own record of the dispatch, never the worker's say) nor the model-failure sentence (it stays on the operation's
        // result, where the next dispatch reads it) is stored. The workflow's review record is strict, so a key an older broker does not know would fail it after a rollback.
        const kept = reviews.map((review) => {
          const { sameModelAsBuild: _reported, modelFailure: _failure, ...report } = (review ?? {}) as Record<string, unknown>;
          void _reported; void _failure;
          return report;
        });
        // Validate every report's complete contract and provenance before deciding that a role is missing.
        for (const review of kept) {
          if (review.operationId !== operation.id) throw new Error("review result is stale, incomplete, or came from another operation");
          submitWorkflowReview(task.workflow, review, now);
        }
        // Exactly the reviews the step asks for (one code review and one security review, unless a custom sequence's review
        // step asks for fewer): two of one kind would leave the stage waiting for the other.
        const roles = kept.map((review) => review.role).sort();
        const asked = workflowReviewRoles(task.workflow);
        if (roles.length !== asked.length || roles.some((role, index) => role !== asked[index])) {
          reviewFailure = WORKFLOW_REVIEW_RESULT_INCOMPLETE_MESSAGE;
          throw new Error("review result does not hold one code review and one security review");
        }
        next = task.workflow;
        for (const review of kept) next = submitWorkflowReview(next, review, now);
        // The note about the model belongs to the reviews just taken: set for this code when they ran on the build's own model, cleared when an earlier review of it had left one.
        if (operation.reviewSameModel === true && next.candidate !== undefined) reviewSameModel = { candidateDigest: next.candidate.digest };
        else if (task.reviewSameModel !== undefined) reviewSameModel = null;
      } catch {
        next = blockWorkflow(task.workflow, reviewFailure, now);
      }
    }
  } else if (operation.workflowMode === "FEEDBACK_REVIEW") {
    const binding = operation.workflowFeedbackReview;
    const current = task.workflow;
    if (binding === undefined || current.stage !== "WAIT_FOR_MERGE" || current.state !== "RUNNING"
      || current.revision !== binding.workflowRevision || current.taskId !== binding.taskId
      || current.candidate?.digest !== binding.candidateDigest || current.feedbackReview?.status !== "COLLECTING") return [];
    if (terminalStatus !== "SUCCEEDED") {
      // The programs earlier work left running could not be stopped, so the review read nothing: its own reason, like the other steps that only read.
      next = blockWorkflow(current, terminalError?.includes(WORKFLOW_LEFTOVER_PROCESSES_MESSAGE) === true ? WORKFLOW_BLOCK_REASONS.leftoverProcesses : WORKFLOW_BLOCK_REASONS.feedbackReviewFailed, now);
    } else {
      try {
        const reported = result !== null && typeof result === "object" ? result as Record<string, unknown> : {};
        const feedbackResult = reported.workflowFeedbackReviewResult;
        if (feedbackResult === null || typeof feedbackResult !== "object" || Array.isArray(feedbackResult)) throw new Error("feedback review result is missing");
        const resultRecord = feedbackResult as Record<string, unknown>;
        if (resultRecord.taskId !== binding.taskId || resultRecord.workflowRevision !== binding.workflowRevision
          || resultRecord.candidateDigest !== binding.candidateDigest || typeof resultRecord.outputDigest !== "string"
          || typeof resultRecord.artifactName !== "string" || typeof resultRecord.status !== "string") throw new Error("feedback review result does not match its operation binding");
        const artifacts = (await queryAllItems(dependencies, "WORKSPACE#" + operation.workspaceId, "ARTIFACT#"))
          .filter(item => item.operationId === operation.id && item.name === resultRecord.artifactName);
        if (artifacts.length !== 1 || typeof artifacts[0]?.objectKey !== "string") throw new Error("critic report artifact is missing or ambiguous");
        const object = await dependencies.s3.send(new GetObjectCommand({ Bucket: dependencies.artifactBucketName, Key: String(artifacts[0].objectKey) }));
        const reportBytes = object.Body ? Buffer.from(await object.Body.transformToByteArray()) : Buffer.alloc(0);
        if (reportBytes.byteLength > 1_000_000 || createHash("sha256").update(reportBytes).digest("hex") !== resultRecord.outputDigest) throw new Error("critic report bytes failed digest validation");
        const report = WorkflowFeedbackReviewReportSchema.parse(JSON.parse(reportBytes.toString("utf8")));
        const inputs = await readFeedbackBundlesForCritic(dependencies, operation, binding);
        // The critic's input as this broker builds it; a run an earlier release started (no notes marker) may also have been
        // given every note, or none (deploy skew), and only such a run.
        const requirementsDigests = operation.feedbackNotesScoped === true ? inputs.acceptedRequirementsDigests.slice(0, 1) : inputs.acceptedRequirementsDigests;
        const refs = current.feedbackReview.bundleRefs.map(ref => WorkflowFeedbackBundleRefSchema.parse(ref));
        if (operation.workflowMode !== "FEEDBACK_REVIEW" || report.operationMode !== operation.workflowMode
          || report.operationId !== operation.id || report.taskId !== current.taskId
          || report.workflowRevision !== binding.workflowRevision || report.qualification !== "AI_GENERATED_ADVISORY"
          || !requirementsDigests.includes(report.taskRequirementsDigest) || report.status !== resultRecord.status
          || refs.length !== report.bundleDigests.length || !refs.every(ref => report.bundleDigests.includes(ref.sha256))
          || refs.length !== report.candidateBindings.length || refs.some(ref => !report.candidateBindings.some(candidate =>
            candidate.repositoryId === ref.repositoryId && candidate.number === ref.number && candidate.headSha === ref.headSha
              && candidate.candidateDigest === ref.candidateDigest && candidate.commentSetDigest === ref.commentSetDigest && candidate.bundleDigest === ref.sha256))) {
          throw new Error("critic report provenance does not match the exact collected inputs");
        }
        const { findings, ...metadata } = report;
        void findings;
        const reviewRef = WorkflowFeedbackReviewRefSchema.parse({ ...metadata, sha256: resultRecord.outputDigest, objectKey: String(artifacts[0].objectKey) });
        next = completeWorkflowFeedbackReview(current, {
          expectedRevision: binding.workflowRevision, taskId: binding.taskId, candidateDigest: binding.candidateDigest,
          operationId: operation.id, bundleRefs: refs, reviewRef,
        }, now);
      } catch {
        next = blockWorkflow(current, WORKFLOW_BLOCK_REASONS.feedbackReviewFailed, now);
      }
    }
  } else if (operation.workflowMode === "UNDERSTAND") {
    const current = task.workflow;
    if (current.stage !== "UNDERSTAND") return [];
    // The answered step's watchdog goes with its result. A step that ended any other way leaves its row to go stale (a cancel's result may carry the step's own update alone).
    if (terminalStatus === "SUCCEEDED") understandWatchdog = [{ Delete: { TableName: dependencies.tableName, Key: { pk: WORKFLOW_DISPATCH_PK, sk: `${task.taskId}#${current.revision}` } } }];
    if (terminalStatus !== "SUCCEEDED") {
      // The step's budget ran out (a spend request is asked for at the end of this result, and its approval retries the step), or its worker could not read its own answer, or the run ended.
      next = blockWorkflow(current, terminalError === BUDGET_EXHAUSTED_FAILURE_MESSAGE ? WORKFLOW_BLOCK_REASONS.budgetPaused
        : terminalError?.includes(UNDERSTAND_UNREADABLE_MESSAGE) === true ? WORKFLOW_BLOCK_REASONS.understandUnreadable
        : terminalError?.includes(WORKFLOW_LIVE_STEER_REAPPROVAL_MESSAGE) === true ? WORKFLOW_BLOCK_REASONS.liveSteerReapproval
        // The base rule files could not be verified: Understand stopped before it started, and says so. A person chooses Retry; nothing starts it again by itself.
        : terminalError?.includes(WORKFLOW_RULE_FILES_UNVERIFIED_MESSAGE) === true ? WORKFLOW_BLOCK_REASONS.stepRuleFilesUnverified
        // The programs earlier work left running could not be stopped: Understand read nothing. A person chooses Retry; nothing starts it again by itself.
        : terminalError?.includes(WORKFLOW_LEFTOVER_PROCESSES_MESSAGE) === true ? WORKFLOW_BLOCK_REASONS.leftoverProcesses
        : workflowRunEndedReason("UNDERSTAND", terminalStatus), now);
    } else {
      // Understand's answer is untrusted, whatever the worker checked: it is read from the saved artifact, bounded, schema-checked and redacted here before it can pick the path or put a question to a person.
      const understood = await readUnderstandingArtifact(dependencies, operation);
      try {
        if (understood === undefined) throw new Error("no readable assessment");
        // A question that needs no code change ends the task Answered: the answer is kept, the milestone is written and the task is queued for its release, all in this commit.
        // A task that follows an answered one never answers again: the person asked for the change, so the answer is read as the restatement of a plan to make it.
        // Nor does a task whose person chose Quick or Full themselves (a typed prefix or a button): their choice runs.
        const assessed: IntentAssessment = assessmentForTask({ assessment: understood.assessment, workflow: current, followsAnswer: task.retryOfTaskId !== undefined });
        next = assessed.kind === "answer"
          ? answerWorkflowIntent(current, { expectedRevision: current.revision, assessment: assessed, artifact: understood.artifact, now })
          : recordIntentAssessment(current, { expectedRevision: current.revision, assessment: assessed, now });
        if (next.outcome === "ANSWERED") {
          answeredItems = [...answeredMilestoneItems({ tableName: dependencies.tableName }, { taskId: task.taskId, orgId: requireOrgId(task.orgId), ...(task.sessionId === undefined ? {} : { sessionId: task.sessionId }) }, next, now),
            finishedReleaseMarkItem(dependencies.tableName, task.taskId, now)];
        }
      } catch {
        next = blockWorkflow(current, WORKFLOW_BLOCK_REASONS.understandUnreadable, now);
      }
      // Understand chose the Full path for a task admitted under the Quick limit: the planning limit rises to the Full one, in this same commit (bounded: a request's own lower limit still wins).
      if (next.stage === "PLAN" && next.path === "FULL" && current.path === "QUICK" && task.budgetUsd !== undefined) {
        // It is a Full plan from here, so it must be admitted as a Full start is: the budgets it counts against must have the Full path's minimum left (it reads and writes nothing but the proxy's
        // limits). Refused, the step is blocked with a plain reason, as a Full start would have been refused; the payer's words are in the log's error code only.
        if (dependencies.modelAccess !== undefined) {
          try {
            await admitWork(
              { documentClient: dependencies.documentClient, tableName: dependencies.tableName, access: dependencies.modelAccess.access, cloud: dependencies.cloud === true },
              { orgId: requireOrgId(task.orgId), project: task.project, payer: task.payer ?? { kind: "member", developerId: task.developerId },
                agentId: task.agent?.agentId ?? ROVARA_CODE_AGENT_ID, agentName: task.agent?.name ?? ROVARA_CODE_NAME, path: "FULL",
                ...(task.origin === "test_run" ? { testRunBy: task.startedBy?.developerId ?? task.developerId } : {}) },
            );
          } catch (error) {
            if (!(error instanceof AgentXError) || !ADMISSION_REFUSALS.has(error.code)) throw error;
            console.log(JSON.stringify({ component: "broker", event: "workflow.understand_full_not_admitted", taskId: task.taskId, error: error.code }));
            next = blockWorkflow(current, WORKFLOW_BLOCK_REASONS.understandFullNotAdmitted, now);
          }
        }
      }
      if (next.stage === "PLAN" && next.path === "FULL" && current.path === "QUICK" && task.budgetUsd !== undefined) {
        const full = planningLimit(await readProjectAi({ documentClient: dependencies.documentClient, tableName: dependencies.tableName }, requireOrgId(task.orgId), task.project), "FULL");
        const limit = Math.max(task.budgetUsd, task.requestedRunLimitUsd === undefined ? full : Math.min(full, task.requestedRunLimitUsd));
        if (limit > task.budgetUsd) raisedPlanningLimit = { seen: task.budgetUsd, limit };
      }
    }
  } else if (operation.workflowMode === "PLAN_CRITIQUE") {
    // Plan 6 Task 8: a plan check's result counts only while the task waits for exactly that check; a late one changes nothing.
    if (task.workflow.stage !== "PLAN_CRITIQUE") return [];
    next = await planCritiqueOutcome(dependencies, task as DeveloperTaskRecord & { workflow: WorkflowSnapshot }, operation, terminalStatus, terminalError, now);
  } else if (task.workflow.stage !== "PLAN") {
    return [];
  } else if (terminalStatus === "SUCCEEDED") {
    const artifacts = (await queryAllItems(dependencies, `WORKSPACE#${operation.workspaceId}`, "ARTIFACT#"))
      .filter((item) => item.operationId === operation.id && item.name === "plan.md")
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const artifact = artifacts.at(-1);
    if (artifact === undefined) {
      next = blockWorkflow(task.workflow, WORKFLOW_BLOCK_REASONS.planNotSaved, now);
    } else {
      const stored = await storePlanAnswer(dependencies, task as DeveloperTaskRecord & { workflow: WorkflowSnapshot }, artifact, now, operation.workflowE2EPlanVersion === 2, operation);
      next = stored.next;
      planUnreadable = stored.planUnreadable;
      planSelfCheck = stored.selfCheck;
      planRevision = stored.revision;
      planHold = stored.hold;
      evidenceJob = stored.evidenceJob;
      if (stored.inlineEvidence !== undefined) inlineEvidence?.push({ ...stored.inlineEvidence, taskId: task.taskId });
      // The coding plan (not a requirements or design document) carries the estimate its approval will accept as the run limit. A version 2 plan reaches the person only after its
      // plan check; the estimate is made with the plan, and the plan check changes nothing about it.
      if ((stored.next.stage === "PLAN_REVIEW" || stored.next.stage === "PLAN_CRITIQUE") && stored.next.artifacts.at(-1)?.type === "plan") {
        runEstimate = await planRunEstimate(dependencies, task as DeveloperTaskRecord & { workflow: WorkflowSnapshot });
        // An estimate that could not be made must not leave the earlier plan's in place: the plan-ready line and the approval would use it.
        dropStaleEstimate = runEstimate === undefined && task.runEstimate !== undefined;
      }
      if (stored.plannerReplies !== undefined) {
        plannerReplies?.push(stored.plannerReplies);
        recordedReplies = plannerRepliesItem(dependencies.tableName, stored.plannerReplies, now);
      }
    }
  } else if (operation.planRevision === true && terminalError === BUDGET_EXHAUSTED_FAILURE_MESSAGE) {
    // Plan 6 Task 8: the revision a plan check asked for ran out of budget. No person asked for it, so it asks for nothing: the plan goes to the person as it was, with the points.
    next = skipPlanRevision(task.workflow, { expectedRevision: task.workflow.revision, limit: await spendLimitKind(dependencies, task), now });
  } else {
    // Plan 3, Task 32: a planning run whose budget ran out waits for its spend request; the approval retries planning.
    next = blockWorkflow(task.workflow, terminalError === BUDGET_EXHAUSTED_FAILURE_MESSAGE ? WORKFLOW_BLOCK_REASONS.budgetPaused
      : terminalError?.includes(WORKFLOW_LIVE_STEER_REAPPROVAL_MESSAGE) === true ? WORKFLOW_BLOCK_REASONS.liveSteerReapproval : workflowRunEndedReason("PLAN", terminalStatus), now);
  }
  // Gap 6: checks that passed make the reviews due. The intent commits with the result; the broker runs it
  // right after this commit, and the recovery sweep runs it if that is lost.
  // Only a coding or check run makes reviews due: a review run's own result never queues another review.
  // Task 12: both reviews passed, so the draft pull request is due the same way; AgentX opens it with no one asking.
  // Plan 6 Task 8: a version 2 plan is due its plan check, and a plan the check sent back is due its one revision, the same way.
  const dispatch = planHold !== undefined
    ? [workflowDispatchItem(dependencies.tableName, task.taskId, next.revision, "GROUNDING", planHold.artifactSha256, now),
      // The hold's own marker: the recovery sweep finds a hold past its deadline even if its dispatch row is lost.
      { Put: { TableName: dependencies.tableName, Item: { pk: PLAN_GROUNDING_HOLD_PK, sk: `TASK#${task.taskId}`, entityType: "PLAN_GROUNDING_HOLD", taskId: task.taskId, deadlineAt: planHold.deadlineAt,
        [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(Date.parse(planHold.deadlineAt) / 1000) + 7 * 86_400 } } }]
    : planRevision !== undefined
    ? [workflowDispatchItem(dependencies.tableName, task.taskId, next.revision, "REPLAN", createHash("sha256").update(planRevision.prompt, "utf8").digest("hex"), now, now, planRevision.prompt)]
      : operation.workflowMode === "UNDERSTAND" && next.stage === "PLAN" && next.state === "READY"
    ? [workflowDispatchItem(dependencies.tableName, task.taskId, next.revision, "PLAN", WORKFLOW_NO_CANDIDATE_DIGEST, now)]
    : operation.workflowMode === "PLAN" && next.stage === "PLAN_CRITIQUE" && next.state === "READY"
    ? [workflowDispatchItem(dependencies.tableName, task.taskId, next.revision, "CRITIQUE", WORKFLOW_NO_CANDIDATE_DIGEST, now)]
    // A plan check whose model the account could not use goes again on the next one (retryPlanCritique); the same dispatch row as the first start.
    : operation.workflowMode === "PLAN_CRITIQUE" && next.stage === "PLAN_CRITIQUE" && next.state === "READY"
    ? [workflowDispatchItem(dependencies.tableName, task.taskId, next.revision, "CRITIQUE", WORKFLOW_NO_CANDIDATE_DIGEST, now)]
    : operation.workflowMode === "PLAN_CRITIQUE" && next.stage === "PLAN" && next.state === "READY"
    ? [workflowDispatchItem(dependencies.tableName, task.taskId, next.revision, "CRITIC_REPLAN", WORKFLOW_NO_CANDIDATE_DIGEST, now)]
    : operation.workflowMode === "IMPLEMENT" && task.workflow.e2e?.required === true
    && next.stage === "VERIFY" && next.state === "WAITING" && next.candidate !== undefined
    ? [workflowDispatchItem(dependencies.tableName, task.taskId, next.revision, "CHECKS", next.candidate.digest, now)]
    : (operation.workflowMode === "IMPLEMENT" || operation.workflowMode === "CHECKS")
    && next.stage === "REVIEW" && next.state === "WAITING" && next.candidate !== undefined
    ? [workflowDispatchItem(dependencies.tableName, task.taskId, next.revision, "REVIEW", next.candidate.digest, now)]
    // Item 7: a fix of pull requests already open is pushed to them, not opened as new ones.
    : operation.workflowMode === "REVIEW" && next.stage === "PULL_REQUEST" && next.state === "READY" && next.candidate !== undefined
      ? [workflowDispatchItem(dependencies.tableName, task.taskId, next.revision, workflowPullRequestUpdateDue(next) ? "UPDATE" : "PUBLISH", next.candidate.digest, now)]
      // A custom sequence's next step: another review after a passed one, or the next coding step (after a build, a passed
      // check or review, or findings sent back).
      : operation.workflowMode === "REVIEW" && next.program !== undefined && next.stage === "REVIEW" && next.state === "WAITING" && next.candidate !== undefined
        ? [workflowDispatchItem(dependencies.tableName, task.taskId, next.revision, "REVIEW", next.candidate.digest, now)]
      : next.program !== undefined && next.stage === "IMPLEMENT" && next.state === "READY"
        && (operation.workflowMode === "IMPLEMENT" || operation.workflowMode === "CHECKS" || operation.workflowMode === "REVIEW")
        ? [workflowDispatchItem(dependencies.tableName, task.taskId, next.revision, "IMPLEMENT", next.candidate?.digest ?? WORKFLOW_NO_CANDIDATE_DIGEST, now)]
      // AUTOFIX (mainline #408, #411): checks or reviews that just blocked, with no pull request yet and not inside one of Plan 6's fix rounds (those blocks are Plan 6's to word), are looked at once by
      // the automatic-fix policy; the row commits with the block (an owner's stop carries its cause), the broker runs it right after, and the sweep runs it if that is lost.
      : dependencies.autofix?.enabled === true && next.state === "BLOCKED" && (next.stage === "VERIFY" || next.stage === "REVIEW") && task.workflow.state === "RUNNING"
        && next.fixSource === undefined && (next.pullRequests?.length ?? 0) === 0
        ? autofixBlockRows(dependencies.tableName, next, terminalStatus === "CANCELLED" ? "owner-stopped" : undefined, now)
        : [];
  // Plan 6 Task 5: Understand's questions are told to the people who can answer (the milestone and its timeline line) in the commit that asks them, never after it.
  const questionsMilestone = operation.workflowMode === "UNDERSTAND" && next.stage === "UNDERSTAND" && next.state === "WAITING"
    ? questionsMilestoneItems({ tableName: dependencies.tableName }, { taskId: task.taskId, orgId: requireOrgId(task.orgId), ...(task.sessionId === undefined ? {} : { sessionId: task.sessionId }) }, next, now)
    : [];
  // A saved plan forgets the reasons an earlier answer was unreadable; an unreadable answer keeps its own for Retry planning.
  const forget = planUnreadable === null && task.planUnreadable !== undefined;
  if (operation.kind === "task" && operation.workflowMode === "CHECKS" && task.workflow.e2e?.required === true
    && operation.workflowE2EAdmission !== undefined && operation.workflowE2EEvidenceRef !== undefined
    && next.e2e !== undefined && task.workflow.candidate !== undefined) {
    const rawOperations = await queryAllItems(dependencies, `WORKSPACE#${task.workspaceId}`, "OPERATION#");
    const detailed = await workflowE2EPresentationDetailed(dependencies, task, rawOperations, "viewer", { operationId: operation.id, status: terminalStatus === "SUCCEEDED" ? "SUCCEEDED" : "FAILED" });
    const presentation = detailed?.presentation;
    // The screenshots behind the rows are private objects by digest, stored before the display that links them; a row whose screenshot could not be stored loses its link, and
    // storing never decides anything (the baseline's were stored when it was recorded).
    let scenarioResults = detailed?.scenarioResults;
    if (scenarioResults !== undefined && detailed !== undefined) {
      const stored = await storeWorkflowE2EArtifacts({ s3: dependencies.s3, artifactBucketName: dependencies.artifactBucketName }, task, detailed.artifacts).catch(() => new Set<string>());
      scenarioResults = { ...resultsWithStoredArtifacts({ scenarios: scenarioResults.scenarios }, stored), ...(scenarioResults.baseline === undefined ? {} : { baseline: scenarioResults.baseline }) };
    }
    const display = presentation === undefined ? undefined : createWorkflowE2EDisplayObject({ ownerKey: task.ownerKey, workspaceId: task.workspaceId, capturedAt: new Date(now).toISOString(),
      view: presentation.shared, ...(scenarioResults === undefined ? {} : { scenarioResults }),
      current: { candidateDigest: task.workflow.candidate.digest, roundId: operation.workflowE2EAdmission.roundId,
        groupRunIds: [...operation.workflowE2EAdmission.groupRunIds],
        admissionSha256: operation.workflowE2EAdmission.admissionRef.sha256, evidenceSha256: operation.workflowE2EEvidenceRef.sha256 } });
    if (display !== undefined) {
      await dependencies.s3.send(new PutObjectCommand({ Bucket: dependencies.artifactBucketName, Key: display.ref.key, Body: display.bytes,
        ContentType: "application/json", Metadata: { sha256: display.ref.sha256 } }));
      next = WorkflowSnapshotSchema.parse({ ...next, e2e: { ...next.e2e, displayRef: display.ref } });
    }
  }
  const graphApproval = graphCancelTarget?.workflowDependencies?.approval;
  const graphCancelCondition = graphCancelTarget?.workflowDependencies === undefined ? "" :
    " AND workflow.workflowDependenciesOperationId = :graphOperationId AND workflow.workflowDependenciesApproval.graphDigest = :graphDigest AND workflow.workflowDependenciesApproval.runId = :graphRunId AND workflow.workflowDependenciesApproval.artifactDigest = :graphArtifactDigest AND workflow.workflowDependenciesApproval.workflowRevision = :graphApprovalRevision AND workflow.workflowDependenciesApproval.actorId = :graphActorId";
  const e2eCancelAdmission = e2eCancelTarget?.workflowE2EAdmission;
  const e2eCancelCondition = e2eCancelAdmission === undefined ? ""
    : " AND workflow.e2e.required = :e2eRequired AND workflow.e2e.currentRoundId = :e2eRoundId AND workflow.candidate.digest = :e2eCandidateDigest";
  return [...e2eAuthorityChecks, { Update: {
    TableName: dependencies.tableName,
    Key: taskKey(task.taskId),
    // A stored plan quoted the replies fed so far; the next plan's window starts after them.
    UpdateExpression: `SET workflow = :workflow, updatedAt = :now${planUnreadable === undefined || planUnreadable === null ? "" : ", planUnreadable = :unreadable"}${planSelfCheck === undefined ? "" : ", planSelfCheck = :selfCheck"}${planHold === undefined ? "" : ", planGrounding = :grounding"}${planUnreadable === null && task.threadNotesFedThrough !== undefined ? ", threadNotesFedFrom = :fedFrom" : ""}${runEstimate === undefined ? "" : ", runEstimate = :runEstimate"}${raisedPlanningLimit === undefined ? "" : ", budgetUsd = :raisedLimit"}${reviewSameModel === undefined || reviewSameModel === null ? "" : ", reviewSameModel = :reviewSameModel"}${forget || dropStaleEstimate || reviewSameModel === null ? ` REMOVE ${[...(forget ? ["planUnreadable"] : []), ...(dropStaleEstimate ? ["runEstimate"] : []), ...(reviewSameModel === null ? ["reviewSameModel"] : [])].join(", ")}` : ""}`,
    ConditionExpression: `workflow.revision = :revision AND workflow.#stage = :stage AND workflow.#state = :running${raisedPlanningLimit === undefined ? "" : " AND budgetUsd = :seenLimit"}${graphCancelCondition}${e2eCancelCondition}`,
    ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
    ExpressionAttributeValues: { ":workflow": next, ":now": now, ":revision": task.workflow.revision, ":stage": task.workflow.stage, ":running": "RUNNING",
      ...(raisedPlanningLimit === undefined ? {} : { ":raisedLimit": raisedPlanningLimit.limit, ":seenLimit": raisedPlanningLimit.seen }),
      ...(planUnreadable === undefined || planUnreadable === null ? {} : { ":unreadable": planUnreadable }),
      ...(planSelfCheck === undefined ? {} : { ":selfCheck": planSelfCheck }),
      ...(planHold === undefined ? {} : { ":grounding": planHold }),
      ...(planUnreadable === null && task.threadNotesFedThrough !== undefined ? { ":fedFrom": task.threadNotesFedThrough } : {}),
      ...(runEstimate === undefined ? {} : { ":runEstimate": runEstimate }),
      ...(reviewSameModel === undefined || reviewSameModel === null ? {} : { ":reviewSameModel": reviewSameModel }),
      ...(graphApproval === undefined || graphCancelTarget?.workflowDependencies === undefined ? {} : {
        ":graphOperationId": graphCancelTarget.id,
        ":graphDigest": graphApproval.graphDigest,
        ":graphRunId": graphApproval.runId,
        ":graphArtifactDigest": graphApproval.artifactDigest,
        ":graphApprovalRevision": graphApproval.workflowRevision,
        ":graphActorId": graphApproval.actorId,
      }),
      ...(e2eCancelAdmission === undefined ? {} : { ":e2eRequired": true, ":e2eRoundId": e2eCancelAdmission.roundId,
        ":e2eCandidateDigest": e2eCancelAdmission.candidateDigest }) },
  } }, ...dispatch, ...understandWatchdog, ...questionsMilestone, ...answeredItems, ...fixExitItems, ...liveSteerChangeItems(dependencies.tableName, task.taskId, next, terminalError, now),
  ...(evidenceJob === undefined ? [] : [{ Put: { TableName: dependencies.tableName, Item: planEvidenceJobItem({ taskId: task.taskId, ...evidenceJob, now: Date.parse(now) }), ConditionExpression: "attribute_not_exists(pk)" } }]),
  ...(recordedReplies === undefined ? [] : [{ Put: recordedReplies }])];
}
