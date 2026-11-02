// Part of the broker (split out of ../broker.ts): Linear lines, pull request reconciliation, event append and artifacts.

import { createHash, randomUUID } from "node:crypto";
import { PutCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { CheckReportSchema, LatestChecksSchema, PULL_REQUEST_BODY_MAX_CHARS, checksMakeDraft, checksSection, type StandingFailure, canonicalJson, workflowIsReviewOnly, blockWorkflow, WorkItemProgressV1Schema, WorkflowSnapshotSchema, taskGraphOrder, workflowDependencyAttemptTerminalProgress, UNDERSTAND_ARTIFACT_MAX_BYTES, UNDERSTAND_ARTIFACT_NAME, WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE, type CheckEntry, type LatestChecks, agentXError, type WorkflowSnapshot, WORKFLOW_PLAN_MAX_BYTES, WORKFLOW_FEEDBACK_REVIEW_ANSWER_ARTIFACT, redactText, auditPullRequestId, codeRepositoriesOf, type CodeHost } from "@agentx/contracts";
import { auditPending, auditTransact, tryAuditEvent } from "../../audit/outbox.js";
import { flushAuditEvents } from "../../audit/flush.js";
import { auditPullRequestOpened } from "../../audit/events.js";
import { parseGitHubRepository, pullRequestBodyWithDraftNote } from "../../github-app.js";
import { linearIssueKeyOf, linearIssueKeyOfTask } from "../../rovara-code/linear-close.js";
import { loadProofContext } from "../../rovara-code/proof-inputs.js";
import { evidenceRouteDependencies } from "./evidence-wiring.js";
import { loadTestingView } from "../developer-tasks/testing-view.js";
import { evidenceRiskOfTask } from "../developer-tasks/evidence-risk-input.js";
import { hadProofSection, proofReadLimitMs, withinTime } from "../../rovara-code/proof-keep.js";
import { withLinearCloseLine } from "../../rovara-code/pull-request-body.js";
import { sessionBindingsOf } from "../../rovara-code/session-bindings.js";
import { parallelStartTrees } from "../../rovara-code/parallel-parts.js";
import { approvedFeedbackFixes, withFeedbackFixes, withStatusLines } from "../../developer/pull-request-feedback-section.js";
import { getItem, operationKey, requireOperation, type OperationRecord } from "../cancellation.js";
import { taskKey, taskPointerKey, type DeveloperTaskPointerRecord, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { hashJson, isConditional } from "../broker-shared.js";
import { developerIdForSlackUser } from "../admin-actions.js";
import { reviewSameModelOf } from "../../rovara-code/review-model-lines.js";
import { secondReviewPullRequestLines } from "../../rovara-code/second-review-store.js";
import { candidateChangedFiles, approvedPlanForPullRequest, workflowPullRequestStatusLines } from "../developer-tasks.js";
import { readMergeTracking } from "../../rovara-code/merge-tracking.js";
import { taskAccessFence } from "../../developer/task-people.js";
import { assertCurrentWorkflowPublication, codeBuildKey, isStatus, object, pullRequestKey, startsConversation, workspaceKey } from "./admin-and-helpers.js";
import { EVENT_TRANSACTION_CHUNK, MAX_ARTIFACT_BYTES, type AwsBrokerDependencies, type CodeBuildRecord, type PullRequestRecord } from "./definitions.js";
import { developerTaskActions, requireRecordProject } from "./dependency-wiring.js";
import { readObjectText } from "./plan-answers.js";
import { requirePullRequest, requireWorkspace } from "./records.js";
import { githubScopeOf, githubScopeOfWorkspace, orgOfRecord } from "./scope-helpers.js";
import { GITHUB_HOST_KIND } from "../../plugins/code-host/github/index.js";
import { requireGithubHost, canReadParents, canReadTree, hostOfRepository, hostOfTaskRepository, hostOfWorkspaceRepository, changeRequestRef, repositoryFullNameOf, repositoryRefOf } from "./repository-hosts.js";
import { workspaceStandingFailures } from "./terminal-result.js";
import { loadWorkflowE2EScenarioResults } from "./workflow-e2e-verification.js";

/**
 * The Linear issue key the task's session follows now, read from the binding. `fallback` stands when the binding cannot be read (a read that fails is never read as "unlinked", which would take the line out).
 */
async function freshLinearKey(dependencies: AwsBrokerDependencies, task: DeveloperTaskRecord, fallback: string | undefined): Promise<string | undefined> {
  if (task.orgId === undefined || task.sessionId === undefined) return fallback;
  try {
    const bindings = await sessionBindingsOf({ documentClient: dependencies.documentClient, tableName: dependencies.tableName }, task.orgId, task.sessionId);
    return bindings.map(linearIssueKeyOf).find((found) => found !== undefined);
  } catch {
    return fallback;
  }
}

/**
 * Plan 6 Task 20: brings ONE open pull request's description to the Linear binding: the `Fixes <KEY>` line inside Rovara's block is set, changed or taken out (`withLinearCloseLine`) from the description
 * as GitHub has it now. GitHub has no conditional write for a description, so after each write the description and the binding are read again, and the line is set right again if another writer's
 * copy (a feedback rewrite that read the description before this write) undid it, or the binding moved meanwhile; at most three writes. `first`: the key the caller knows (a route's, right after its
 * commit); without it the binding is read. "failed": GitHub refused, the block is not as Rovara wrote it, the description would be too long, or the time ran out.
 */
async function settleLinearLine(
  dependencies: AwsBrokerDependencies, task: DeveloperTaskRecord, target: { repositoryUrl: string; number: number; host: CodeHost }, scope: Awaited<ReturnType<typeof githubScopeOf>>, first: { key: string | undefined } | undefined, deadline: number,
): Promise<"updated" | "same" | "failed"> {
  let wanted = first !== undefined ? first.key : await freshLinearKey(dependencies, task, undefined);
  let wrote = false;
  for (let round = 0; round < 4; round += 1) {
    if (Date.now() > deadline) return "failed";
    const ref = changeRequestRef(target.repositoryUrl, target.number);
    const next = withLinearCloseLine((await target.host.getChangeRequest(ref, scope)).body, wanted);
    if (next.kind === "same") return wrote ? "updated" : "same";
    // The fourth look only checks: a third write that was undone again is reported, not repeated.
    if (next.kind === "no_block" || next.body.length > PULL_REQUEST_BODY_MAX_CHARS || round === 3) return "failed";
    await target.host.updateChangeRequest(ref, { body: next.body }, scope);
    wrote = true;
    wanted = await freshLinearKey(dependencies, task, wanted);
  }
  return "failed";
}

/**
 * Plan 6 Task 20: the open pull requests' descriptions say what the session's Linear binding says, at once (a link, a replace or an unlink; the pull request just recorded). Each description is settled
 * (`settleLinearLine`) within the time a feedback description update has. A pull request that could not be read or written, whose block is not as Rovara wrote it, or past the time limit, counts as failed.
 * Never throws. `first`: the key a route knows right after its commit; without it the binding is read.
 */
async function settleOpenLinearLines(dependencies: AwsBrokerDependencies, task: DeveloperTaskRecord, first: { key: string | undefined } | undefined): Promise<{ updated: number; failed: number }> {
  const open = (task.workflow?.pullRequests ?? []).filter((pullRequest) => pullRequest.state === "OPEN" || pullRequest.state === "UNKNOWN");
  const result = { updated: 0, failed: 0 };
  const deadline = Date.now() + (dependencies.descriptionUpdateMaxMs ?? DESCRIPTION_UPDATE_MAX_MS);
  let scope: Awaited<ReturnType<typeof githubScopeOf>> | undefined;
  for (const pullRequest of open) {
    try {
      scope ??= await githubScopeOf(dependencies, task);
      const record = await getItem<PullRequestRecord>(dependencies, pullRequestKey(task.workspaceId, pullRequest.repositoryId, pullRequest.number));
      if (record === undefined) { result.failed += 1; continue; }
      // The code host the record's repository names; one this install has not registered is refused here, and counts as failed like any other pull request that could not be read.
      const host = await hostOfTaskRepository(dependencies, task, { name: pullRequest.repositoryId, url: record.repositoryUrl });
      const outcome = await settleLinearLine(dependencies, task, { repositoryUrl: record.repositoryUrl, number: pullRequest.number, host }, scope, first, deadline);
      if (outcome === "updated") result.updated += 1;
      else if (outcome === "failed") result.failed += 1;
    } catch (error) {
      result.failed += 1;
      console.log(JSON.stringify({ component: "broker", event: "linear_close.description_not_updated", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" }));
    }
  }
  return result;
}

export async function rewriteOpenLinearCloseLines(dependencies: AwsBrokerDependencies, task: DeveloperTaskRecord, key: string | undefined): Promise<{ updated: number; failed: number }> {
  return settleOpenLinearLines(dependencies, task, { key });
}

/**
 * Plan 6 Task 20: a pull request was just recorded for a version 2 task. Its title and description were fixed when the publication was accepted, so a link, replace or unlink made since is not in them: the
 * open descriptions are settled against the binding now. Best effort (the next rewrite of the description does it too); never throws.
 */
export async function settleRecordedPullRequest(dependencies: AwsBrokerDependencies, taskId: string): Promise<void> {
  try {
    const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(taskId));
    if (task?.workflow?.definitionVersion !== "1.1.0" || task.orgId === undefined || task.sessionId === undefined) return;
    await settleOpenLinearLines(dependencies, task, undefined);
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "linear_close.recorded_not_settled", taskId, error: error instanceof Error ? error.name : "unknown" }));
  }
}

/** How long the description update may hold up the worker's callback; past it the push is answered and the update gives up. */
const DESCRIPTION_UPDATE_MAX_MS = 5_000;

/** Playbook P1: the Proof section's inputs for the description rewrite after a pushed fix. The task's operations are read once and shared by the reads that need them. */
async function proofContextForRewrite(dependencies: AwsBrokerDependencies, task: DeveloperTaskRecord, workflow: WorkflowSnapshot): Promise<Awaited<ReturnType<typeof loadProofContext>>> {
  const actions = developerTaskActions(dependencies);
  const [operations, approvedPlan] = await Promise.all([actions.operations(task.workspaceId), approvedPlanForPullRequest({ actions }, workflow).catch(() => undefined)]);
  const evidence = evidenceRouteDependencies(dependencies).evidence;
  return loadProofContext({ actions, scenarioResults: () => loadWorkflowE2EScenarioResults(dependencies, task, operations, "owner"), ...(evidence === undefined ? {} : { evidence: (digest: string) => evidence.context(task, digest) }) }, task, workflow, approvedPlan, operations);
}

/**
 * D2: once an approved PR feedback fix is on the pull request, its description lists briefly what was changed for which
 * of that pull request's comments ("Fixes from PR feedback"), kept up to date across rounds. Best effort and bounded in
 * time (at most the newest approvals' reports are read): the push is recorded whatever happens here, and a description
 * that could not be updated, or whose section no longer fits, is logged. GitHub's description is read just before the write.
 *
 * The same update brings the description's checks and reviews lines up to date (withStatusLines) when the task's current
 * code is `candidateDigest`, the fix just pushed, and its checks ran on exactly that code: the description then names the
 * checks and reviews of the code on the pull request, never an earlier round's.
 */
export async function describeFeedbackFixes(dependencies: AwsBrokerDependencies, operation: Pick<OperationRecord, "id" | "workspaceId">, record: PullRequestRecord, candidateDigest: string): Promise<void> {
  const log = (event: string, error?: unknown) => console.log(JSON.stringify({ component: "broker", event, operationId: operation.id,
    ...(error === undefined ? {} : { error: error instanceof Error ? error.name : "unknown" }) }));
  // Past the time limit the update is abandoned: it must never write later (Lambda may resume a frozen promise in a
  // later invocation), so the flag and the deadline are checked again right before the write, after a fresh read.
  const deadline = Date.now() + (dependencies.descriptionUpdateMaxMs ?? DESCRIPTION_UPDATE_MAX_MS);
  let abandoned = false;
  const late = () => abandoned || Date.now() > deadline;
  const update = async (): Promise<void> => {
    const pointer = await getItem<DeveloperTaskPointerRecord>(dependencies, taskPointerKey(operation.workspaceId));
    const task = pointer === undefined ? undefined : await getItem<DeveloperTaskRecord>(dependencies, taskKey(pointer.taskId));
    if (late() || task?.workflow === undefined || task.workspaceId !== operation.workspaceId) return;
    // Playbook P1: the Proof section's reads start now, beside the reads below, with a short time of their own: a slow read leaves the Proof section as the description has it, never the whole update abandoned.
    const proofRead = task.workflow.definitionVersion === "1.1.0" && task.workflow.candidate?.digest === candidateDigest && task.workflow.verification?.candidateDigest === candidateDigest
      ? withinTime(proofReadLimitMs(dependencies.descriptionUpdateMaxMs ?? DESCRIPTION_UPDATE_MAX_MS), () => proofContextForRewrite(dependencies, task, task.workflow!)) : undefined;
    const { fixes, earlier } = await approvedFeedbackFixes(task.workflow, { repositoryId: record.repository, number: record.number },
      (key, maxBytes) => (late() ? Promise.resolve(undefined) : readObjectText(dependencies, key, maxBytes)), `private/${task.ownerKey}/${task.workspaceId}/feedback-reviews/`);
    if (late()) return;
    // The description as GitHub has it now, read just before the write, so a person's edit since is kept.
    const scope = await githubScopeOf(dependencies, task);
    const host = await hostOfTaskRepository(dependencies, task, { name: record.repository, url: record.repositoryUrl });
    const ref = changeRequestRef(record.repositoryUrl, record.number);
    const current = (await host.getChangeRequest(ref, scope)).body;
    const workflow = task.workflow;
    const pushedChecked = workflow.candidate?.digest === candidateDigest && workflow.verification?.candidateDigest === candidateDigest;
    // Rovara Code version 2 rewrites its whole block (what changed, tests, reviews and risk) for the code now on the pull request; its changed files come from the task's latest workspace diff.
    const changedFiles = pushedChecked && workflow.definitionVersion === "1.1.0"
      ? await candidateChangedFiles({ actions: developerTaskActions(dependencies), log: () => undefined }, task) : undefined;
    // The tracked pull request's checks basis and base branch (Plan 6 Task 14), so the description says when every check counted, because the base has no required ones.
    const tracked = workflow.definitionVersion === "1.1.0" && task.orgId !== undefined
      ? (await readMergeTracking(dependencies, task.taskId, task.orgId).catch(() => [])).find((item) => item.repositoryId === record.repository && item.number === record.number) : undefined;
    // The Linear issue the task's session follows, so the description says Fixes <KEY> once (Plan 6 Task 20); an issue bound after the pull request opened is added by this rewrite.
    const linearIssueKey = workflow.definitionVersion === "1.1.0" ? await linearIssueKeyOfTask({ documentClient: dependencies.documentClient, tableName: dependencies.tableName }, task) : undefined;
    const reviewSameModel = workflow.definitionVersion === "1.1.0" && reviewSameModelOf(task, workflow);
    // SH34: the second review's lines (switch `cr`), rewritten with the rest of the block.
    const secondReviewLines = workflow.definitionVersion === "1.1.0" ? secondReviewPullRequestLines(task, candidateDigest, workflow.acceptedFindings) : [];
    // Playbook P1: the Proof section is rewritten with the rest of the block (the approved plan, the browser/API rows and the test proof for the code now on the pull request); when its reads were too slow and the description had a Proof section, that section's body becomes a one-line marker (its old table describes the code before this fix).
    const proofResult = proofRead === undefined ? undefined : await proofRead;
    const stale = proofResult !== undefined && !proofResult.done && hadProofSection(current);
    const proof = proofResult === undefined ? undefined : proofResult.done ? proofResult.value : stale ? { stale } : undefined;
    // Proof and evidence P4: the risk shown keeps a security scan's new high findings on this code (only while the proof switch is on).
    const evidenceRisk = pushedChecked && workflow.definitionVersion === "1.1.0" ? await evidenceRiskOfTask(evidenceRouteDependencies(dependencies).evidence, task, candidateDigest) : undefined;
    // Setup and test health SH18: the Testing view of the code now on the pull request (only while `vx` is on).
    const testing = pushedChecked && workflow.definitionVersion === "1.1.0"
      ? await loadTestingView({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now, evidence: evidenceRouteDependencies(dependencies).evidence }, task, workflow) : undefined;
    const bodyContext = changedFiles === undefined && tracked === undefined && linearIssueKey === undefined && proof === undefined && !reviewSameModel && secondReviewLines.length === 0 && evidenceRisk === undefined && testing === undefined ? undefined : {
      ...(testing === undefined ? {} : { testing }),
      ...(reviewSameModel ? { reviewSameModel: true as const } : {}), ...(secondReviewLines.length === 0 ? {} : { secondReviewLines }), ...(changedFiles === undefined ? {} : { changedFiles }), ...(tracked === undefined ? {} : { ciBasis: tracked.ciBasis, baseBranch: tracked.baseBranch }),
      ...(linearIssueKey === undefined ? {} : { linearIssueKey }), ...(proof === undefined ? {} : { proof }), ...(evidenceRisk === undefined ? {} : { evidenceRisk }),
    };
    const status = pushedChecked ? withStatusLines(current, workflowPullRequestStatusLines(workflow, bodyContext)) : undefined;
    const withStatus = status !== undefined && status.length <= PULL_REQUEST_BODY_MAX_CHARS ? status : current;
    const fixed = withFeedbackFixes(withStatus, fixes, earlier);
    const next = { ...fixed, ...(fixed.body === undefined && withStatus !== current ? { body: withStatus } : {}) };
    if (next.dropped) log("workflow.pull_request_description_section_dropped");
    if (next.body === undefined) return;
    if (late()) {
      log("workflow.pull_request_description_abandoned");
      return;
    }
    await host.updateChangeRequest(ref, { body: next.body }, scope);
    // Plan 6 Task 20: this write carries a copy of the description read a moment ago, so a Linear link made meanwhile (and rewritten into the description by the route) could be undone by it: the line is settled again
    // against the binding as it is now. A failure here is logged with the rest of this update's.
    if (workflow.definitionVersion === "1.1.0" && late() === false) await settleLinearLine(dependencies, task, { repositoryUrl: record.repositoryUrl, number: record.number, host }, scope, undefined, deadline);
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([update(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        abandoned = true;
        reject(Object.assign(new Error("the description update took too long"), { name: "DescriptionUpdateTimeout" }));
      }, dependencies.descriptionUpdateMaxMs ?? DESCRIPTION_UPDATE_MAX_MS);
    })]);
  } catch (error) {
    log("workflow.pull_request_description_not_updated", error);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * A workflow publication whose branch or opened pull request is not the checked code: the task stops in plain words
 * with Retry opening the pull request. Only a task still ready to publish its current candidate is blocked; a failed
 * write is logged, since the refusal itself is what keeps the unchecked code from being recorded.
 */
async function blockUncheckedPublication(dependencies: AwsBrokerDependencies, operation: OperationRecord): Promise<void> {
  try {
    const pointer = await getItem<DeveloperTaskPointerRecord>(dependencies, taskPointerKey(operation.workspaceId));
    const task = pointer === undefined ? undefined : await getItem<DeveloperTaskRecord>(dependencies, taskKey(pointer.taskId));
    const workflow = task?.workflow;
    if (task === undefined || workflow === undefined || workflow.stage !== "PULL_REQUEST" || workflow.state !== "READY"
      || workflow.candidate?.digest !== operation.publication?.candidateDigest) return;
    const now = new Date().toISOString();
    await dependencies.documentClient.send(new UpdateCommand({
      TableName: dependencies.tableName, Key: taskKey(task.taskId),
      UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
      ConditionExpression: "workflow.revision = :revision AND workflow.#stage = :stage AND workflow.#state = :ready AND attribute_not_exists(closedAt)",
      ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
      ExpressionAttributeValues: { ":workflow": blockWorkflow(workflow, WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE, now), ":now": now,
        ":revision": workflow.revision, ":stage": "PULL_REQUEST", ":ready": "READY" },
    }));
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "workflow.unchecked_publication_block_failed", operationId: operation.id, error: error instanceof Error ? error.name : "unknown" }));
  }
}

/** Whether this publication is of a review-only task's verified candidate (its policy selects no check). */
async function reviewOnlyWorkflowPublication(dependencies: AwsBrokerDependencies, operation: OperationRecord): Promise<boolean> {
  const pointer = await getItem<DeveloperTaskPointerRecord>(dependencies, taskPointerKey(operation.workspaceId));
  const task = pointer === undefined ? undefined : await getItem<DeveloperTaskRecord>(dependencies, taskKey(pointer.taskId));
  const workflow = task?.workflow;
  return workflow !== undefined && workflow.candidate?.digest === operation.publication?.candidateDigest
    && workflow.verification?.candidateDigest === workflow.candidate?.digest
    && workflow.verification?.reviewOnly === true && workflowIsReviewOnly(workflow.checkPolicy);
}

export async function reconcilePullRequest(
  dependencies: AwsBrokerDependencies,
  operation: OperationRecord,
  value: unknown,
) {
  if (operation.kind !== "publish" || !operation.publication) {
    throw agentXError("CALLBACK_FORBIDDEN", "operation cannot create a pull request");
  }
  const input = object(value, "pull request callback");
  const expected = operation.publication;
  const allowed = new Set(["repository", "repositoryUrl", "headBranch", "baseBranch", "commit", "title", "body", "checks"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw agentXError("CONFIG_INVALID", "pull request callback contains unknown fields");
  }
  for (const key of ["repository", "repositoryUrl", "headBranch", "baseBranch", "title"] as const) {
    const expectedValue = expected[key];
    if (input[key] !== expectedValue) {
      throw agentXError("CALLBACK_FORBIDDEN", `pull request callback ${key} is outside the operation scope`);
    }
  }
  if (expected.body === undefined && input.body !== undefined) {
    throw agentXError("CALLBACK_FORBIDDEN", "pull request callback body is outside the operation scope");
  }
  if (typeof input.commit !== "string" || !/^[a-f0-9]{40,64}$/.test(input.commit)) {
    throw agentXError("CONFIG_INVALID", "published commit is invalid");
  }
  // A workflow publication opens only on the checked tree. GitHub, not the worker, says what the branch holds: its head
  // must be the reported commit, and that commit's tree the checked one, before the pull request opens from the branch.
  // P5d: the code host the repository's record names (an unknown kind is refused here, with the fixed sentence). P6: the commit-parent read is the port's too; the GitHub provider is kept
  // only to see whether a harness built it without the reads this check needs.
  const host = await hostOfWorkspaceRepository(dependencies, operation.workspaceId, { name: expected.repository, url: expected.repositoryUrl });
  const github = host.kind === GITHUB_HOST_KIND ? dependencies.githubPullRequests : undefined;
  // A workflow publication's result is recorded by GitHub-only code (the linked-pull-request rows are GitHub's, left for P6), so on any other host it is refused here, before the pull request is
  // opened or recorded: nothing is left open on a host the task cannot follow.
  if (operation.publication.expectedTreeSha !== undefined) requireGithubHost(host);
  const scope = await githubScopeOfWorkspace(dependencies, operation.workspaceId);
  const expectedTree = expected.expectedTreeSha;
  const expectedCommit = expected.expectedCommitSha;
  const expectedBase = expected.expectedBaseCommit;
  const publicationMode = expected.publicationMode;
  if (expectedTree !== undefined) await assertCurrentWorkflowPublication(dependencies, operation);
  // The exact admitted commit may contain more than one owner-approved edit commit. Its ancestry must still contain
  // the pinned base, while the worker and GitHub head remain exactly the checked commit.
  const onPinnedBase = async (commit: string) => {
    if (expectedBase === undefined) return true;
    if (!canReadParents(dependencies, host)) return false;
    const pending = [commit];
    const seen = new Set<string>();
    while (pending.length > 0 && seen.size < 512) {
      const current = pending.shift()!;
      if (current === expectedBase) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const parent of await host.commitParents(repositoryRefOf(expected.repositoryUrl), current, scope)) {
        if (!/^[a-f0-9]{40,64}$/u.test(parent)) return false;
        pending.push(parent);
      }
    }
    return false;
  };
  if (expectedTree !== undefined) {
    if (publicationMode === undefined || (publicationMode === "COMMITTED_HEAD" && expectedCommit === undefined)
      || (github !== undefined && (github.getCommitTree === undefined || github.getBranchHead === undefined)) || (expectedBase !== undefined && !canReadParents(dependencies, host))) {
      throw agentXError("RUNTIME_UNAVAILABLE", "cannot verify the pushed tree");
    }
    if (publicationMode === "COMMITTED_HEAD" && input.commit !== expectedCommit) {
      await blockUncheckedPublication(dependencies, operation);
      throw agentXError("CALLBACK_FORBIDDEN", "the pushed commit is not the checked commit");
    }
    const head = await host.branchHead(repositoryRefOf(expected.repositoryUrl), expected.headBranch, scope);
    if (head !== input.commit || await host.tree(repositoryRefOf(expected.repositoryUrl), input.commit, scope) !== expectedTree || !await onPinnedBase(input.commit)) {
      await blockUncheckedPublication(dependencies, operation);
      throw agentXError("CALLBACK_FORBIDDEN", "the pushed commit is not the checked code");
    }
  }
  const publishChecks = publicationChecks(input.checks);
  await assertCodeBuildGatesPassed(dependencies, operation, input.commit);
  // A revert undoes a merged pull request, so the workspace's own task work is not what it publishes.
  // A review-only workflow pull request keeps its description's review-only line, with no section for reruns of the
  // agent's own tests under it; a check that fails as the pull request opens (one added to the project since) is still
  // reported.
  const reviewOnly = expected.expectedTreeSha !== undefined && await reviewOnlyWorkflowPublication(dependencies, operation);
  const latestChecks = expected.mode === "revert" || reviewOnly ? undefined : await latestWorkspaceChecks(dependencies, operation.workspaceId);
  const standingFailures = expected.mode === "revert" || reviewOnly ? [] : await workspaceStandingFailures(dependencies, operation.workspaceId);
  const failingPublishChecks = publishChecks?.filter((check) => check.after === "failed" || check.after === "timed_out") ?? [];
  const checked = reviewOnly
    ? failingPublishChecks.length === 0 ? { body: expected.body, draft: expected.draft } : checkedPullRequest(expected.body, expected.draft, failingPublishChecks, undefined)
    : checkedPullRequest(expected.body, expected.draft, publishChecks, latestChecks, standingFailures);
  const body = checked.body;
  // A workflow publication is always a draft: humans merge.
  const draft = expected.expectedTreeSha !== undefined ? true : checked.draft;
  const reconciled = await host.reconcileChangeRequest({
    repository: repositoryRefOf(expected.repositoryUrl),
    sourceBranch: expected.headBranch,
    targetBranch: expected.baseBranch,
    title: expected.title,
    ...(body === undefined ? {} : { body }),
    ...(draft === undefined ? {} : { draft }),
  }, scope);
  const pullRequest = { number: Number(reconciled.ref.id), url: reconciled.ref.url, reconciled: reconciled.reconciled, ...(reconciled.draftRefused === true ? { draftRefused: true as const } : {}) };
  if (pullRequest.draftRefused === true) console.log(JSON.stringify({ component: "broker", event: "pull_request.draft_refused", operationId: operation.id, number: pullRequest.number }));
  // The branch could move between the check and the open (a force-push): the opened pull request's own head must still
  // be the checked commit, or it is closed again and nothing is recorded.
  if (expectedTree !== undefined) {
    let headCommit: string | undefined;
    let headTree: string | undefined;
    let headOnBase = false;
    // A read GitHub fails once (a 502) is read again before the pull request is judged: closing it over one blip left a
    // closed pull request and a second one on retry. A head that still can't be read is closed, as one that differs is.
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        headCommit = (await host.getChangeRequest(changeRequestRef(expected.repositoryUrl, pullRequest.number), scope)).headRevision;
        headTree = headCommit === input.commit ? await host.tree(repositoryRefOf(expected.repositoryUrl), headCommit, scope) : undefined;
        headOnBase = headCommit === input.commit && await onPinnedBase(headCommit);
        break;
      } catch (error) {
        headCommit = undefined;
        headTree = undefined;
        headOnBase = false;
        console.log(JSON.stringify({ component: "broker", event: "workflow.publication_head_unreadable", operationId: operation.id, attempt, error: error instanceof Error ? error.name : "unknown" }));
      }
    }
    if (headCommit !== input.commit || headTree !== expectedTree || !headOnBase) {
      await host.updateChangeRequest(changeRequestRef(expected.repositoryUrl, pullRequest.number), { state: "closed" }, scope).catch((error: unknown) => {
        console.log(JSON.stringify({ component: "broker", event: "workflow.unchecked_pull_request_close_failed", operationId: operation.id, number: pullRequest.number, error: error instanceof Error ? error.name : "unknown" }));
      });
      await blockUncheckedPublication(dependencies, operation);
      throw agentXError("CALLBACK_FORBIDDEN", "the opened pull request is not the checked code");
    }
  }
  // A worker that asks again (its answer was lost) is the same occurrence: on a ledger it keeps the first attempt's time, so the
  // retry overwrites that attempt's pending audit item instead of adding a second one (R1-1). The audit's reads and builder run
  // together, so a read that fails is logged and the callback goes on without an event.
  const recordKey = pullRequestKey(operation.workspaceId, expected.repository, pullRequest.number);
  let openedAt = new Date().toISOString();
  const opened = await tryAuditEvent(dependencies, async () => {
    const earlier = await getItem<PullRequestRecord>(dependencies, recordKey);
    if (earlier?.createdByOperationId === operation.id) openedAt = earlier.updatedAt;
    // GitHub's spelling comes from the address as before; another host says it through its identity read. One it cannot name leaves this best-effort audit event out.
    const repositoryFullName = await repositoryFullNameOf(host, expected.repositoryUrl, scope, (url) => { const repository = parseGitHubRepository(url); return `${repository.owner}/${repository.name}`; });
    if (repositoryFullName === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the code host did not name the repository");
    const requester = operation.requestedBy;
    return auditPullRequestOpened({
      orgId: await orgOfRecord(dependencies, await getItem<Record<string, unknown>>(dependencies, workspaceKey(operation.workspaceId)) ?? {}),
      actor: requester === undefined ? { kind: "system", id: "rovara" } : { kind: "member", id: "kind" in requester ? requester.developerId : developerIdForSlackUser(requester.userId) },
      occurredAt: openedAt, occurrence: operation.id,
      pullRequestId: auditPullRequestId(repositoryFullName, pullRequest.number), number: pullRequest.number,
      // I3: the people the change request names (full ids), so an auditor can go from the host's change request to the Rovara people behind it.
      ...(expected.relatedIds === undefined || expected.relatedIds.length === 0 ? {} : { related: [...expected.relatedIds] }),
      details: [{ subject: "org", fields: { repository: repositoryFullName } }],
    });
  });
  const record: PullRequestRecord = {
    ...recordKey,
    entityType: "PULL_REQUEST",
    workspaceId: operation.workspaceId,
    repository: expected.repository,
    repositoryUrl: expected.repositoryUrl,
    number: pullRequest.number,
    url: pullRequest.url,
    state: "open",
    headBranch: expected.headBranch,
    baseBranch: expected.baseBranch,
    expectedHeadCommit: input.commit,
    title: expected.title,
    // What was opened: with the note first when GitHub refused the draft (INTG1), so a later update of the description keeps it.
    body: pullRequest.draftRefused === true ? pullRequestBodyWithDraftNote(body) : body ?? "",
    ...(pullRequest.draftRefused === true ? { draftRefused: true as const } : {}),
    createdByOperationId: operation.id,
    ...(expected.mode === "replace" && expected.targetPullRequestNumber !== undefined
      ? { replacementFor: expected.targetPullRequestNumber }
      : {}),
    updatedAt: openedAt,
  };
  if (expected.mode === "replace" && expected.targetPullRequestNumber !== undefined) {
    const original = await requirePullRequest(
      dependencies,
      operation.workspaceId,
      expected.repository,
      expected.targetPullRequestNumber,
    );
    await host.updateChangeRequest(changeRequestRef(original.repositoryUrl, original.number), { state: "closed" }, scope);
    const linkedOriginal: PullRequestRecord = {
      ...original,
      // Asked to be closed and answered without a refusal: it is closed (the port's update returns nothing, so no second read is spent on it).
      state: "closed",
      replacedBy: pullRequest.number,
      updatedAt: new Date().toISOString(),
    };
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: dependencies.tableName, Item: record } },
      { Put: { TableName: dependencies.tableName, Item: linkedOriginal } },
      ...(opened === undefined ? [] : auditPending(dependencies, opened)),
    ] }));
  } else {
    await auditTransact(dependencies, { Put: { TableName: dependencies.tableName, Item: record } }, opened === undefined ? [] : [opened]);
  }
  if (opened !== undefined) await flushAuditEvents(dependencies, [opened]);
  // Ruling Z: the worker's result says whether the pull request is a draft, so the reply can say so. INTG1: one that GitHub refused as a draft was opened as a normal one, so it is not.
  return { ...pullRequest, draft: draft === true && pullRequest.draftRefused !== true };
}

/** Spec 051 (D-7): the checks the worker ran at publish, judged against their befores; none from an older worker. */
function publicationChecks(value: unknown): CheckEntry[] | undefined {
  if (value === undefined) return undefined;
  const parsed = CheckReportSchema.shape.checks.safeParse(value);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "pull request callback checks are invalid");
  return parsed.data;
}

/**
 * The workspace's latest checks (Ruling T), or undefined: none yet. One that does not parse is logged and treated as
 * none; a failing publish check still makes the draft (Ruling S).
 */
async function latestWorkspaceChecks(dependencies: AwsBrokerDependencies, workspaceId: string): Promise<LatestChecks | undefined> {
  const workspace = await getItem<{ latestChecks?: { report?: unknown; operationId?: unknown } }>(dependencies, workspaceKey(workspaceId));
  if (workspace?.latestChecks === undefined) return undefined;
  const parsed = LatestChecksSchema.safeParse(workspace.latestChecks.report);
  if (parsed.success) return parsed.data;
  console.log(JSON.stringify({ component: "broker", event: "pull_request.latest_checks_unreadable", workspaceId, operationId: typeof workspace.latestChecks.operationId === "string" ? workspace.latestChecks.operationId : undefined }));
  return undefined;
}

/** Spec 051 M-1: labels and outputs redacted again at the broker before they reach GitHub (as #154 does for errors). */
function redactedEntries(checks: readonly CheckEntry[]): CheckEntry[] {
  return checks.map((check) => ({ ...check, label: redactText(check.label), output: redactText(check.output) }));
}

/**
 * Spec 051 FR-008 (D-2): the pull request's description and draft flag, given the checks. A draft when a check that
 * passed before fails now, whatever was asked; otherwise the draft flag stays as asked (the developer API asks for a
 * draft by default). The checks section goes after the description, cut so the whole stays within GitHub's limit.
 * With nothing to report, both are exactly as asked (Review Focus 5).
 */
function checkedPullRequest(
  body: string | undefined,
  draft: boolean | undefined,
  publishChecks: readonly CheckEntry[] | undefined,
  latestChecks: LatestChecks | undefined,
  standingFailures: readonly StandingFailure[] = [],
): { body: string | undefined; draft: boolean | undefined } {
  const separator = body === undefined || body === "" ? "" : "\n\n";
  const shownPublish = publishChecks === undefined ? undefined : redactedEntries(publishChecks);
  const shownLatest = latestChecks === undefined || "reason" in latestChecks ? latestChecks : { ...latestChecks, checks: redactedEntries(latestChecks.checks) };
  const shownStanding = standingFailures.map((failure) => ({ ...failure, label: redactText(failure.label) }));
  const section = checksSection(shownPublish, shownLatest, PULL_REQUEST_BODY_MAX_CHARS - (body?.length ?? 0) - separator.length, shownStanding);
  return {
    body: section === "" ? body : `${body ?? ""}${separator}${section}`,
    draft: checksMakeDraft(publishChecks, latestChecks, standingFailures) ? true : draft,
  };
}

export async function assertCodeBuildGatesPassed(
  dependencies: AwsBrokerDependencies,
  operation: OperationRecord,
  commit: string,
): Promise<void> {
  const scope = operation.publication ?? operation.maintenance;
  if (!scope) throw agentXError("CALLBACK_FORBIDDEN", "operation has no publication scope");
  if (
    operation.maintenance?.action === "sync" &&
    commit === operation.maintenance.expectedHeadCommit
  ) return;
  for (const gate of scope.codeBuildGates) {
    const record = await getItem<CodeBuildRecord>(
      dependencies,
      codeBuildKey(operation.workspaceId, operation.id, gate.name),
    );
    if (
      !record || record.fence !== operation.fence || record.repository !== scope.repository ||
      record.projectName !== gate.projectName || record.requestedSourceVersion !== commit ||
      record.evidence.status !== "SUCCEEDED" || record.evidence.resolvedSourceVersion !== commit
    ) {
      throw agentXError("CALLBACK_FORBIDDEN", `CodeBuild gate ${gate.name} has not passed for this candidate`);
    }
  }
}

export async function appendEvents(
  dependencies: AwsBrokerDependencies,
  operation: OperationRecord,
  value: unknown,
): Promise<number> {
  const input = object(value, "event callback");
  if (!Array.isArray(input.events) || input.events.length < 1 || input.events.length > 500) {
    throw agentXError("CONFIG_INVALID", "callback must contain 1 through 500 events");
  }
  const events = input.events.map((event) => {
    const item = object(event, "event");
    if (typeof item.type !== "string" || typeof item.timestamp !== "string") {
      throw agentXError("CONFIG_INVALID", "event type and timestamp are required");
    }
    return { type: item.type, timestamp: item.timestamp, payload: item.payload };
  });
  for (let offset = 0; offset < events.length; offset += EVENT_TRANSACTION_CHUNK) {
    const chunk = events.slice(offset, offset + EVENT_TRANSACTION_CHUNK);
    const workflowProgress = await validateWorkflowProgressChunk(dependencies, operation, chunk);
    await appendEventChunk(dependencies, operation, chunk, offset, hashJson(value), workflowProgress);
  }
  if (events.some((event) => event.type === "lifecycle" && isStatus(event.payload, "RUNNING"))) {
    await dependencies.documentClient.send(new UpdateCommand({
      TableName: dependencies.tableName,
      Key: operationKey(operation.workspaceId, operation.id),
      UpdateExpression: "SET #status = :running, updatedAt = :now",
      ConditionExpression: "#status = :dispatching OR #status = :accepted OR #status = :running",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":running": "RUNNING", ":dispatching": "DISPATCHING", ":accepted": "ACCEPTED", ":now": new Date().toISOString() },
    })).catch(() => undefined);
  }
  if (events.some((event) => event.type === "lifecycle" && startsConversation(event.payload))) {
    await markConversationStarted(dependencies, operation);
  }
  return events.length;
}

/**
 * The authoritative record that a conversation owns a session. It outlives the workspace volume,
 * so a replaced volume fails closed on the next turn instead of silently starting the thread over.
 */
async function markConversationStarted(
  dependencies: AwsBrokerDependencies,
  operation: OperationRecord,
): Promise<void> {
  if (!operation.conversationId) return;
  await dependencies.documentClient.send(new UpdateCommand({
    TableName: dependencies.tableName,
    Key: { pk: `WORKSPACE#${operation.workspaceId}`, sk: `CONVERSATION#${operation.conversationId}` },
    UpdateExpression: "SET startedAt = :now, updatedAt = :now",
    ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(startedAt)",
    ExpressionAttributeValues: { ":now": new Date().toISOString() },
  })).catch((error: unknown) => {
    // Already marked by an earlier delivery of the same event. Anything else must reach the worker,
    // which retries the batch, so the record cannot quietly fall behind the workspace.
    if (!isConditional(error)) throw error;
  });
}

async function appendEventChunk(
  dependencies: AwsBrokerDependencies,
  operation: OperationRecord,
  events: Array<{ type: string; timestamp: string; payload: unknown }>,
  chunkOffset: number,
  batchHash: string,
  workflowProgress?: { taskId: string; workflow?: NonNullable<DeveloperTaskRecord["workflow"]>; expectedRevision: number; peopleRevision: number; approval: NonNullable<OperationRecord["workflowDependencies"]>["approval"] },
): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await requireOperation(dependencies, operation.workspaceId, operation.id);
    const start = current.eventSequence + 1;
    const markerKey = { pk: `OPERATION#${operation.id}`, sk: `EVENTBATCH#${batchHash}#${chunkOffset}` };
    if (await getItem(dependencies, markerKey)) return;
    const items = events.map((event, index) => ({
      pk: `OPERATION#${operation.id}`,
      sk: `EVENT#${String(start + index).padStart(12, "0")}`,
      entityType: "EVENT",
      workspaceId: operation.workspaceId,
      operationId: operation.id,
      sequence: start + index,
      ...event,
    }));
    try {
      await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
        { Update: {
          TableName: dependencies.tableName,
          Key: operationKey(operation.workspaceId, operation.id),
          UpdateExpression: "SET eventSequence = :next",
          ConditionExpression: "eventSequence = :current AND fence = :fence",
          ExpressionAttributeValues: { ":next": current.eventSequence + events.length, ":current": current.eventSequence, ":fence": operation.fence },
        } },
        { Put: { TableName: dependencies.tableName, Item: { ...markerKey, entityType: "EVENT_BATCH" }, ConditionExpression: "attribute_not_exists(pk)" } },
        ...items.map((item) => ({ Put: { TableName: dependencies.tableName, Item: item, ConditionExpression: "attribute_not_exists(pk)" } })),
        ...(workflowProgress === undefined ? [] : [workflowProgress.workflow === undefined ? { ConditionCheck: {
          TableName: dependencies.tableName,
          Key: taskKey(workflowProgress.taskId),
          ConditionExpression: "workflow.revision = :revision AND workflow.#stage = :stage AND workflow.#state = :state AND workflow.workflowDependenciesApproval.graphDigest = :graphDigest AND workflow.workflowDependenciesApproval.runId = :runId AND workflow.workflowDependenciesApproval.artifactDigest = :artifactDigest AND workflow.workflowDependenciesApproval.workflowRevision = :approvalRevision AND workflow.workflowDependenciesApproval.actorId = :actorId AND attribute_not_exists(closedAt)",
          ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
          ExpressionAttributeValues: { ":revision": workflowProgress.expectedRevision, ":stage": "IMPLEMENT", ":state": "RUNNING", ":graphDigest": workflowProgress.approval.graphDigest,
            ":runId": workflowProgress.approval.runId, ":artifactDigest": workflowProgress.approval.artifactDigest, ":approvalRevision": workflowProgress.approval.workflowRevision, ":actorId": workflowProgress.approval.actorId },
        } } : { Update: {
          TableName: dependencies.tableName,
          Key: taskKey(workflowProgress.taskId),
          UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
          ConditionExpression: "workflow.revision = :revision AND workflow.#stage = :stage AND workflow.#state = :state AND workflow.workflowDependenciesApproval.graphDigest = :graphDigest AND workflow.workflowDependenciesApproval.runId = :runId AND workflow.workflowDependenciesApproval.artifactDigest = :artifactDigest AND workflow.workflowDependenciesApproval.workflowRevision = :approvalRevision AND workflow.workflowDependenciesApproval.actorId = :actorId AND attribute_not_exists(closedAt)",
          ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
          ExpressionAttributeValues: { ":workflow": workflowProgress.workflow, ":now": new Date().toISOString(), ":revision": workflowProgress.expectedRevision,
            ":stage": "IMPLEMENT", ":state": "RUNNING", ":graphDigest": workflowProgress.approval.graphDigest,
            ":runId": workflowProgress.approval.runId, ":artifactDigest": workflowProgress.approval.artifactDigest,
            ":approvalRevision": workflowProgress.approval.workflowRevision, ":actorId": workflowProgress.approval.actorId },
        } },
        { ConditionCheck: {
          TableName: dependencies.tableName,
          Key: workspaceKey(operation.workspaceId),
          ConditionExpression: "activeOperationId = :operation AND fence = :fence AND #status = :busy",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":operation": operation.id, ":fence": operation.fence, ":busy": "BUSY" },
        } },
        taskAccessFence(dependencies.tableName, workflowProgress.taskId, workflowProgress.peopleRevision === 0 ? undefined : workflowProgress.peopleRevision)]),
      ] }));
      return;
    } catch (error) {
      if (!isConditional(error) || attempt === 3) throw error;
    }
  }
}

/** Validate each graph checkpoint against the canonical Owner-approved run before acknowledging it to the worker. */
async function validateWorkflowProgressChunk(
  dependencies: AwsBrokerDependencies,
  operation: OperationRecord,
  events: readonly { type: string; timestamp: string; payload: unknown }[],
): Promise<{ taskId: string; workflow?: NonNullable<DeveloperTaskRecord["workflow"]>; expectedRevision: number; peopleRevision: number; approval: NonNullable<OperationRecord["workflowDependencies"]>["approval"] } | undefined> {
  const rawProgress = events.flatMap((event) => {
    if (event.type !== "progress" || event.payload === null || typeof event.payload !== "object" || Array.isArray(event.payload)) return [];
    const payload = event.payload as Record<string, unknown>;
    return Object.hasOwn(payload, "workItemProgress") ? [payload.workItemProgress] : [];
  });
  if (rawProgress.length === 0) return undefined;
  const invocation = operation.workflowDependencies;
  if (invocation === undefined || operation.workflowMode !== "IMPLEMENT" || invocation.peopleRevision === undefined) {
    throw agentXError("CALLBACK_FORBIDDEN", "work breakdown progress is not bound to an active approved operation and People revision");
  }
  const parsed = rawProgress.map((entry) => WorkItemProgressV1Schema.safeParse(entry));
  if (parsed.some((entry) => !entry.success)) throw agentXError("CALLBACK_FORBIDDEN", "work breakdown progress is invalid");
  const taskId = invocation.graph.taskId;
  const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(taskId));
  if (task === undefined || task.closedAt !== undefined || task.workflow === undefined || task.workflow.stage !== "IMPLEMENT" || task.workflow.state !== "RUNNING"
    || task.workflow.workflowDependenciesApproval?.graphDigest !== invocation.approval.graphDigest
    || task.workflow.workflowDependenciesApproval.runId !== invocation.approval.runId
    || task.workflow.workflowDependenciesApproval.artifactDigest !== invocation.approval.artifactDigest
    || task.workflow.workflowDependenciesApproval.workflowRevision !== invocation.approval.workflowRevision
    || task.workflow.workflowDependenciesApproval.actorId !== invocation.approval.actorId) {
    throw agentXError("CALLBACK_FORBIDDEN", "work breakdown progress no longer matches the current task and Owner approval");
  }
  const workspace = await requireWorkspace(dependencies, operation.workspaceId);
  if (workspace.status !== "BUSY" || workspace.activeOperationId !== operation.id || workspace.fence !== operation.fence) {
    throw agentXError("CALLBACK_FORBIDDEN", "work breakdown progress belongs to a stale workspace operation");
  }
  const history = task.workflow.workflowDependenciesProgress ?? [];
  const order = taskGraphOrder(invocation.graph);
  let firstBaseTree = invocation.resumeTreeSha;
  if (firstBaseTree === undefined) {
    const baseCommit = (task.workflow.reviewBase ?? task.preparedBase)?.find((entry) => entry.repositoryId === invocation.graph.items[0]?.repository)?.baseCommitSha;
    if (baseCommit === undefined) throw agentXError("CALLBACK_FORBIDDEN", "the approved work breakdown base tree cannot be confirmed");
    const project = await requireRecordProject(dependencies, task, task.project, task.startingRevision);
    const repository = codeRepositoriesOf(project.definition).find((entry) => entry.name === invocation.graph.items[0]?.repository);
    if (repository === undefined) throw agentXError("CALLBACK_FORBIDDEN", "the approved work breakdown repository is no longer registered");
    // P5d: the base tree is read from the code host the repository's record names (an unknown kind is refused).
    const host = hostOfRepository(dependencies, repository);
    if (!canReadTree(dependencies, host)) throw agentXError("CALLBACK_FORBIDDEN", "the approved work breakdown base tree cannot be confirmed");
    firstBaseTree = await host.tree(repositoryRefOf(repository.url), baseCommit, await githubScopeOf(dependencies, task));
  }
  let latestSequence = history.at(-1)?.sequence ?? 0;
  if (latestSequence !== (invocation.sequenceStart ?? 0) + history.filter((entry) => entry.operationId === operation.id).length) {
    throw agentXError("CALLBACK_FORBIDDEN", "work breakdown progress cursor changed before this operation");
  }
  let nextWorkflow = task.workflow;
  let hadExactDuplicate = false;
  for (const result of parsed) {
    if (!result.success) throw agentXError("CALLBACK_FORBIDDEN", "work breakdown progress is invalid");
    const progress = result.data;
    const existing = history.find((entry) => entry.sequence === progress.sequence);
    if (existing !== undefined) {
      if (canonicalJson(existing) !== canonicalJson(progress)) throw agentXError("CALLBACK_FORBIDDEN", "work breakdown progress sequence was reused with different content");
      if (existing.operationId !== operation.id || existing.graphDigest !== invocation.approval.graphDigest || existing.runId !== invocation.approval.runId) {
        throw agentXError("CALLBACK_FORBIDDEN", "work breakdown progress replay is not bound to this operation");
      }
      hadExactDuplicate = true;
      continue;
    }
    if (progress.sequence !== latestSequence + 1 || progress.graphDigest !== invocation.approval.graphDigest || progress.runId !== invocation.approval.runId
      || progress.operationId !== operation.id) throw agentXError("CALLBACK_FORBIDDEN", "work breakdown progress is out of sequence or bound to another operation");
    if (invocation.parallel !== undefined) {
      // Rovara Code v2: several items may be running at once. The shape (what may start, how many run, what may finish) is the projection's; the trees are judged here: a part
      // starts from the tree the run began at or from a tree some finished part was merged into. A worker that builds parts side by side names that tree on each finished part
      // (`integratedTreeSha`); one that was not sent the setting (an older worker) builds them one after another, and the tree a finished part ends on is its own.
      const stored = [...(nextWorkflow.workflowDependenciesProgress ?? []), progress];
      const projected = workflowDependencyAttemptTerminalProgress({ graph: invocation.graph, approval: invocation.approval, operationId: operation.id,
        sequenceStart: invocation.sequenceStart, resumeProgress: invocation.resumeProgress, history: stored, parallel: invocation.parallel });
      const startTrees = parallelStartTrees(stored, firstBaseTree);
      if (projected === undefined || (progress.state === "STARTED" && !startTrees.has(progress.baseTreeSha))) {
        throw agentXError("CALLBACK_FORBIDDEN", "work breakdown progress does not continue the retained graph's trees and order");
      }
      latestSequence = progress.sequence;
      nextWorkflow = WorkflowSnapshotSchema.parse({ ...nextWorkflow, revision: nextWorkflow.revision + 1, workflowDependenciesProgress: stored });
      continue;
    }
    const operationHistory = [...history, ...((nextWorkflow.workflowDependenciesProgress ?? []).slice(history.length))]
      .filter((entry) => entry.operationId === operation.id);
    const active = operationHistory.at(-1)?.state === "STARTED" ? operationHistory.at(-1) : undefined;
    const attemptTerminals = workflowDependencyAttemptTerminalProgress({ graph: invocation.graph, approval: invocation.approval, operationId: operation.id,
      sequenceStart: invocation.sequenceStart, resumeProgress: invocation.resumeProgress, history: nextWorkflow.workflowDependenciesProgress ?? [] });
    if (attemptTerminals === undefined) throw agentXError("CALLBACK_FORBIDDEN", "work breakdown checkpoints do not match this operation attempt");
    const attemptSequenceStart = invocation.sequenceStart ?? 0;
    const attemptHalted = operationHistory.some((entry) => entry.operationId === operation.id && entry.sequence > attemptSequenceStart
      && (entry.state === "FAILED" || entry.state === "UNKNOWN"));
    const completed = new Set(attemptTerminals.filter((entry) => entry.state === "IMPLEMENTED").map((entry) => entry.itemId));
    const expectedItemId = order.find((itemId) => !completed.has(itemId));
    const previous = (nextWorkflow.workflowDependenciesProgress ?? []).at(-1);
    const expectedBase = active?.baseTreeSha ?? (previous?.state === "IMPLEMENTED" ? previous.candidateTreeSha : firstBaseTree);
    if (progress.state === "STARTED") {
      if (attemptHalted || active !== undefined || expectedItemId === undefined || progress.itemId !== expectedItemId || (expectedBase !== undefined && progress.baseTreeSha !== expectedBase)) {
        throw agentXError("CALLBACK_FORBIDDEN", "work breakdown item start does not continue the retained graph tree and order");
      }
    } else if (active === undefined || active.itemId !== progress.itemId || active.baseTreeSha !== progress.baseTreeSha
      || (progress.state === "IMPLEMENTED" && (expectedItemId === undefined || progress.itemId !== expectedItemId))) {
      throw agentXError("CALLBACK_FORBIDDEN", "work breakdown item result has no matching acknowledged start");
    }
    latestSequence = progress.sequence;
    nextWorkflow = WorkflowSnapshotSchema.parse({ ...nextWorkflow, revision: nextWorkflow.revision + 1,
      workflowDependenciesProgress: [...(nextWorkflow.workflowDependenciesProgress ?? []), progress] });
  }
  if (nextWorkflow === task.workflow && !hadExactDuplicate) return undefined;
  return { taskId, ...(nextWorkflow === task.workflow ? {} : { workflow: nextWorkflow }), expectedRevision: task.workflow.revision,
    peopleRevision: invocation.peopleRevision, approval: invocation.approval };
}

export async function putArtifact(
  dependencies: AwsBrokerDependencies,
  operation: OperationRecord,
  value: unknown,
): Promise<string> {
  const input = object(value, "artifact callback");
  if (typeof input.name !== "string" || typeof input.mediaType !== "string" || typeof input.content !== "string") {
    throw agentXError("CONFIG_INVALID", "artifact name, mediaType and content are required");
  }
  if (Buffer.byteLength(input.content, "utf8") > MAX_ARTIFACT_BYTES) {
    throw agentXError("CONFIG_INVALID", "artifact exceeds the 5 MB demo limit");
  }
  if (operation.workflowMode === "UNDERSTAND" && input.name === UNDERSTAND_ARTIFACT_NAME && Buffer.byteLength(input.content, "utf8") > UNDERSTAND_ARTIFACT_MAX_BYTES) {
    throw agentXError("CONFIG_INVALID", "understanding artifact exceeds the size limit");
  }
  if (operation.workflowMode === "PLAN" && input.name === "plan.md" && Buffer.byteLength(input.content, "utf8") > WORKFLOW_PLAN_MAX_BYTES) {
    throw agentXError("CONFIG_INVALID", "plan artifact exceeds the workflow plan size limit");
  }
  const workspace = await requireWorkspace(dependencies, operation.workspaceId);
  const artifactId = randomUUID();
  const feedbackReportMatch = operation.workflowMode === "FEEDBACK_REVIEW"
    ? /^workflow-feedback-review-([a-f0-9]{64})\.json$/.exec(input.name) : undefined;
  const feedbackReportDigest = feedbackReportMatch?.[1];
  // Beside the report, a feedback review may keep the reviewer's rejected answer (redacted by the worker), privately
  // under its operation; nothing reads it back into the task.
  const feedbackAnswer = operation.workflowMode === "FEEDBACK_REVIEW" && input.name === WORKFLOW_FEEDBACK_REVIEW_ANSWER_ARTIFACT;
  if (operation.workflowMode === "FEEDBACK_REVIEW" && !feedbackAnswer && (feedbackReportDigest === undefined
    || createHash("sha256").update(input.content, "utf8").digest("hex") !== feedbackReportDigest)) {
    throw agentXError("CONFIG_INVALID", "feedback critic report artifact name must match its content digest");
  }
  const objectKey = feedbackReportDigest === undefined
    ? `private/${workspace.ownerKey}/${workspace.id}/${operation.id}/${artifactId}`
    : `private/${workspace.ownerKey}/${workspace.id}/feedback-reviews/${feedbackReportDigest}.json`;
  await dependencies.s3.send(new PutObjectCommand({
    Bucket: dependencies.artifactBucketName,
    Key: objectKey,
    Body: input.content,
    ContentType: input.mediaType,
  }));
  await dependencies.documentClient.send(new PutCommand({
    TableName: dependencies.tableName,
    Item: {
      pk: `WORKSPACE#${workspace.id}`,
      sk: `ARTIFACT#${artifactId}`,
      entityType: "ARTIFACT",
      id: artifactId,
      workspaceId: workspace.id,
      operationId: operation.id,
      ownerKey: workspace.ownerKey,
      name: input.name,
      mediaType: input.mediaType,
      objectKey,
      size: Buffer.byteLength(input.content, "utf8"),
      createdAt: new Date().toISOString(),
    },
    ConditionExpression: "attribute_not_exists(pk)",
  }));
  return artifactId;
}
