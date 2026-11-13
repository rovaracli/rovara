import { createHash, randomUUID } from "node:crypto";
import { evidenceKeyOf } from "./evidence-port.js";
import { isReplayCopy } from "../../developer/eval-copy.js";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { AgentXError, type WorkflowPullRequestUpdateCause, orgProjectCatalogKey, agentXError, E2EPolicySchema, WorkflowTransitionError, WorkflowPublishRetryRequestSchema, canonicalJson, workflowRequestId, workflowPublicationRetryable, WORKFLOW_KEEP_PULL_REQUESTS_NOTE } from "@rovara-code/contracts";
import { blockWorkflowPullRequestUpdate, endWorkflowBranchSync, startWorkflowBranchSyncRun, nextWorkflowPullRequestUpdate, startWorkflowPullRequestUpdate, workflowPullRequestUpdateDue, type DeveloperTaskView, type WorkflowSnapshot, holdWorkflowCandidateOnPullRequests, unblockWorkflowPublication, keepWorkflowPullRequests } from "@agentx/cloud-contracts";
import { aiToolTurn, developerTaskIdentity, partyOfTask, taskKey, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { isConditional } from "../broker-shared.js";
import type { LoadedDocument } from "../../developer/plan-artifacts.js";
import type { DeveloperTaskActions, TransactItems } from "../developer-task-actions.js";
import type { DeveloperCaller } from "../developer-routes.js";
import { requireProjectSendBackRole, type TaskAccess } from "../../developer/task-access.js";
import { taskAccessFence } from "../../developer/task-people.js";
import { branchSyncRequestId } from "../../rovara-code/branch-sync.js";
import { inertPlanLine } from "../../rovara-code/inert-text.js";
import { attributionForPublication } from "../../wiring/enterprise-identity.js";
import { recomputeRisk, type PullRequestBodyContext } from "../../rovara-code/pull-request-body.js";
import { evidenceRiskOfTask, securityCheckIdsOf } from "./evidence-risk-input.js";
import { linearIssueKeyOfTask } from "../../rovara-code/linear-close.js";
import { loadTestProofLines } from "../../developer/test-proof-lines.js";
import type { DeveloperTaskRouteDependencies } from "./types.js";
import { creatorGuard, get, iso, parse, partyOfTaskActor, putNew, stoppedByLoweredAutonomy, taskPageUrl, turnTable } from "./common.js";
import { accessFence, authorizeTaskAction, systemTaskAccess } from "./access.js";
import { resumeParkedTaskDispatch } from "./access-resume.js";
import { candidateChangedFiles, taskView } from "./task-view.js";
import { syncIndex } from "./task-index.js";
import { actionableWorkspace, busyOrClosing, extraItemsCancelled } from "./task-window.js";
import { specPublicationGate } from "./spec-wiring.js";
import { withSpecLink } from "../../spec/link.js";
import { loadTestingView } from "./testing-view.js";
import { type WorkflowPublicationAuthority, approvedPlanForPullRequest, proofContextOfTask, pullRequestTitle, workflowPullRequestBody } from "./pull-request-body.js";
import { recordPublishedCandidateOutcomes } from "./decide.js";
import { lessonsUsedForTask, lessonsUsedSection } from "../../lessons/used-in-pr.js";
import { stopIfOwnerRefused } from "./owner-stop.js";

type LoadedPublicationProject = NonNullable<Awaited<ReturnType<DeveloperTaskActions["latestProject"]>>>;

function workflowPublicationMaterialDigest(pinned: LoadedPublicationProject, latest: LoadedPublicationProject): string {
  const material = (project: LoadedPublicationProject) => ({
    projectName: project.definition.name,
    revision: project.definition.revision,
    registeredBy: project.registeredBy,
    definition: project.definition,
    runtimeBinding: project.runtimeBinding,
    setupApproval: project.setupApproval ?? null,
  });
  return createHash("sha256").update(canonicalJson({
    domain: "workflow-publication-project-material/v1",
    pinned: material(pinned),
    latest: material(latest),
  })).digest("hex");
}

async function workflowPublicationAuthority(
  deps: Pick<DeveloperTaskRouteDependencies, "actions" | "tableName" | "orgId">,
  task: DeveloperTaskRecord,
  workflow: WorkflowSnapshot,
  approvedPlan: LoadedDocument | undefined,
  admittedWorkflowRevision = workflow.revision,
): Promise<{ authority: WorkflowPublicationAuthority; conditions: TransactItems } | undefined> {
  if (approvedPlan === undefined) return undefined;
  const ownerDecision = workflow.decisions.filter((decision) => decision.decision === "APPROVE"
    && decision.artifactDigest === approvedPlan.artifact.sha256).at(-1);
  // The broker's own automatic decisions (AGENTX) are never an approval; the workflow schema already forbids an AGENTX approval, and this keeps it out of the publication authority too.
  if (ownerDecision === undefined || ownerDecision.artifactDigest === undefined || ownerDecision.actorRole === "AGENTX") return undefined;
  if (task.startingRevision === undefined) return undefined;
  const [pinned, latest] = await Promise.all([
    deps.actions.projectRevision(deps.orgId, task.project, task.startingRevision),
    deps.actions.latestProject(deps.orgId, task.project),
  ]);
  if (pinned === undefined || latest === undefined || pinned.definition.name !== task.project || latest.definition.name !== task.project
    || pinned.definition.revision !== task.startingRevision || latest.definition.revision < pinned.definition.revision) return undefined;
  const planArtifact = { id: approvedPlan.artifact.id, type: approvedPlan.artifact.type, version: approvedPlan.artifact.version,
    objectKey: approvedPlan.artifact.objectKey, sha256: approvedPlan.artifact.sha256, format: approvedPlan.format };
  const ownerApproval = { requestId: ownerDecision.requestId, workflowRevision: ownerDecision.workflowRevision, actorId: ownerDecision.actorId,
    actorRole: ownerDecision.actorRole, artifactDigest: ownerDecision.artifactDigest,
    workBreakdownDigest: ownerDecision.workBreakdownDigest ?? null, at: ownerDecision.at };
  const materialDigest = workflowPublicationMaterialDigest(pinned, latest);
  const workflowAuthorityDigest = createHash("sha256").update(canonicalJson({
    domain: "workflow-publication-approved-authority/v1", workflowRevision: admittedWorkflowRevision,
    planArtifact, ownerDecision, graphApproval: workflow.workflowDependenciesApproval ?? null, projectMaterialDigest: materialDigest,
  })).digest("hex");
  const authority: WorkflowPublicationAuthority = {
    mode: workflow.e2e?.required === true ? "COMMITTED_HEAD" : "CHECKED_TREE",
    pinnedRevision: pinned.definition.revision,
    latestRevision: latest.definition.revision,
    materialDigest,
    workflowRevision: admittedWorkflowRevision,
    planArtifact,
    ownerApproval,
    workflowAuthorityDigest,
  };
  const conditions: TransactItems = [{ ConditionCheck: { TableName: deps.tableName, Key: orgProjectCatalogKey(deps.orgId, task.project),
    ConditionExpression: "latestRevision = :revision", ExpressionAttributeValues: { ":revision": latest.definition.revision } } }];
  // The required-E2E current-authority checks already include the stronger catalog condition
  // for this same key. DynamoDB transactions cannot contain two operations on one item.
  if (workflow.e2e?.required === true) return { authority, conditions: [] };
  // Only the original approved artifact bytes/hash and positively loaded pinned/current records establish checked-tree
  // authority. Structured plans must positively lack E2E intent; verified legacy Markdown stays opaque.
  if (workflow.e2e !== undefined || approvedPlan === undefined
    || (approvedPlan.format === "structured" && approvedPlan.plan.e2e !== undefined)
    || task.startingRevision === undefined || approvedPlan.artifact.type !== "plan"
    || !workflow.decisions.some((decision) => decision.decision === "APPROVE" && decision.artifactDigest === approvedPlan.artifact.sha256)) return undefined;
  if (pinned.definition.e2e === undefined && latest.definition.e2e === undefined) return { authority, conditions };
  if (pinned.definition.e2e === undefined || latest.definition.e2e === undefined) return undefined;
  const pinnedPolicy = E2EPolicySchema.safeParse(pinned.definition.e2e);
  const latestPolicy = E2EPolicySchema.safeParse(latest.definition.e2e);
  if (!pinnedPolicy.success || !latestPolicy.success
    || pinnedPolicy.data.baselineScenarioIds.length > 0 || latestPolicy.data.baselineScenarioIds.length > 0) return undefined;
  return {
    authority,
    conditions,
  };
}

/** Recollects current task/project material and policy before a worker receives workflow push credentials. */
export async function currentWorkflowPublicationAuthorityForTask(
  deps: Pick<DeveloperTaskRouteDependencies, "actions" | "tableName" | "orgId" | "workflowE2EPresentation" | "workflowE2EPublicationChecks">,
  task: DeveloperTaskRecord,
): Promise<WorkflowPublicationAuthority | undefined> {
  const workflow = task.workflow;
  if (task.closedAt !== undefined || workflow?.candidate === undefined) return undefined;
  const approvedPlan = await approvedPlanForPullRequest(deps, workflow);
  const selection = await workflowPublicationAuthority(deps, task, workflow, approvedPlan);
  if (selection === undefined) return undefined;
  if (selection.authority.mode === "COMMITTED_HEAD") {
    if (deps.workflowE2EPresentation === undefined || deps.workflowE2EPublicationChecks === undefined) return undefined;
    const operations = await deps.actions.operations(task.workspaceId);
    const presentation = await deps.workflowE2EPresentation({ task, operations, actor: "owner" });
    const checks = await deps.workflowE2EPublicationChecks({ task, operations });
    if (presentation?.shared.e2e.status !== "PASS" || checks === undefined || checks.length === 0) return undefined;
  }
  return selection.authority;
}

/** Compatibility projection for callers that only need the selected protocol. */
export async function currentWorkflowPublicationModeForTask(
  deps: Pick<DeveloperTaskRouteDependencies, "actions" | "tableName" | "orgId" | "workflowE2EPresentation" | "workflowE2EPublicationChecks">,
  task: DeveloperTaskRecord,
): Promise<"COMMITTED_HEAD" | "CHECKED_TREE" | undefined> {
  return (await currentWorkflowPublicationAuthorityForTask(deps, task))?.mode;
}

/**
 * Task 12: open the draft pull request of exactly the candidate whose checks and both reviews passed, with no one asking.
 * Answers STALE unless the task is open and ready to publish at the expected revision with that candidate. One
 * repository at a time, the first without a pull request by ID; the next one is due when this one's result lands.
 *
 * The request ID is derived from the task, revision, candidate, repository and attempt, where the attempt counts this
 * tree's publications that ended without succeeding, so a recovered or repeated dispatch is the broker's duplicate.
 * After a failed publication the system never tries again on its own (STALE); the owner's retry (`ownerRetry`) does,
 * with the next attempt's new request ID, and may also lift the block AgentX left when it gave up starting it.
 * WORKSPACE_BUSY and WORKSPACE_NOT_READY propagate so the dispatcher tries again later.
 *
 * The publication is accepted only while the task is still exactly where it was read (its revision, stage and state,
 * and open). An owner's retry moves the revision on, so the card that offered the retry loses its buttons.
 */
export async function startTaskWorkflowPublicationFromSystem(
  deps: DeveloperTaskRouteDependencies,
  taskId: string,
  expected: { workflowRevision: number; candidateDigest: string },
  origin: { taskPageUrl?: string; ownerRetry?: boolean; ownerAccess?: Pick<TaskAccess, "peopleRevision">; ownerActor?: DeveloperCaller },
): Promise<"STARTED" | "DUPLICATE" | "STALE" | "WAITING"> {
  const task = await get<DeveloperTaskRecord>(deps, taskKey(taskId));
  // Lane 7: a replay copy that reached the end of its checks is never published; the dispatch row is answered STALE so it is dropped, not retried.
  if (isReplayCopy(task)) return "STALE";
  const workflow = task?.workflow;
  const ownerRetry = origin.ownerRetry === true;
  if (task === undefined || task.closedAt !== undefined || workflow === undefined || workflow.revision !== expected.workflowRevision
    || !(ownerRetry ? workflowPublicationRetryable(workflow) : workflow.stage === "PULL_REQUEST" && workflow.state === "READY")
    || workflow.candidate === undefined || workflow.candidate.digest !== expected.candidateDigest) return "STALE";
  // Ruling R60: a removed creator's task opens or updates no pull request; this is before the E2E proof, the access check and any token.
  await creatorGuard(deps, task);
  // S2: the push also starts straight after a gated press (`startAcceptedStep`), so the owner's access is asked at the start itself; a person's own Retry was gated by the send-back rule already.
  if (!ownerRetry && await stopIfOwnerRefused(deps, task, workflow, "direct_start")) return "STALE";
  let currentE2EChecks: TransactItems = [];
  if (workflow.e2e?.required === true) {
    if (deps.workflowE2EPresentation === undefined) return "STALE";
    const operations = await deps.actions.operations(task.workspaceId);
    const presentation = await deps.workflowE2EPresentation({ task, operations, actor: "owner" });
    if (presentation?.shared.e2e.status !== "PASS") return "STALE";
    if (deps.workflowE2EPublicationChecks === undefined) return "STALE";
    currentE2EChecks = await deps.workflowE2EPublicationChecks({ task, operations }) ?? [];
    if (currentE2EChecks.length === 0) return "STALE";
  }
  const dispatchAccess = origin.ownerAccess ?? await systemTaskAccess(deps, task);
  const workspace = await deps.actions.workspace(task.workspaceId);
  if (workspace.status === "CLOSED" || workspace.status === "PREPARATION_FAILED") return "STALE";
  const repository = [...workflow.candidate.repositories].sort((left, right) => left.repositoryId.localeCompare(right.repositoryId))
    .find((entry) => !(workflow.pullRequests ?? []).some((pullRequest) => pullRequest.repositoryId === entry.repositoryId));
  // Every repository has its pull request: an approved fix whose checks and reviews passed is pushed to them instead.
  if (repository === undefined) {
    // Plan 6 Task 16: before the fix of a round Rovara decided itself is pushed, the autonomy is read again (an owner's own retry is their go-ahead).
    if (!ownerRetry && workflow.state === "READY" && workflowPullRequestUpdateDue(workflow) && await stoppedByLoweredAutonomy(deps, task, workflow)) return "STALE";
    if (workflow.state === "READY" && workflowPullRequestUpdateDue(workflow)) {
      return startTaskWorkflowPullRequestUpdate(deps, task, { ...workflow, candidate: workflow.candidate }, expected, currentE2EChecks, dispatchAccess, origin.ownerActor);
    }
    // Every open pull request already holds the candidate (a merge of the base that was checked and reviewed again, or a fix whose push landed before its result): there is nothing to push, and the task
    // waits for the merge. The owner's Retry at a publication block does the same, so a repeat finds it done (the revision moved on) and an unrepeated one is not left blocked.
    let held: WorkflowSnapshot | undefined;
    try { held = holdWorkflowCandidateOnPullRequests(workflow, iso(deps)); } catch (error) { if (!(error instanceof WorkflowTransitionError)) throw error; }
    if (held !== undefined) {
      try {
        await deps.actions.transact([{ Update: { TableName: deps.tableName, Key: taskKey(taskId), UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
          ConditionExpression: "workflow.revision = :revision AND workflow.#stage = :stage AND workflow.#state = :state AND attribute_not_exists(closedAt)",
          ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
          ExpressionAttributeValues: { ":workflow": held, ":now": held.updatedAt, ":revision": workflow.revision, ":stage": "PULL_REQUEST", ":state": workflow.state } } },
        ...currentE2EChecks,
        ...(dispatchAccess === undefined ? [] : [taskAccessFence(deps.tableName, taskId, dispatchAccess.peopleRevision)])]);
      } catch (error) {
        if (!isConditional(error)) throw error;
        return "STALE";
      }
      return "STARTED";
    }
    return "STALE";
  }
  const attempt = 1 + await deps.actions.failedPublications(task.workspaceId, { repositoryId: repository.repositoryId, candidateDigest: expected.candidateDigest, treeSha: repository.treeSha });
  if (attempt > 1 && !ownerRetry) return "STALE";
  const requestId = workflowRequestId("agentx-auto-publish", taskId, expected.workflowRevision, expected.candidateDigest, repository.repositoryId, attempt);
  const approvedPlan = await approvedPlanForPullRequest(deps, workflow);
  // The catalog guard below needs the project's latest-revision pointer. A catalog row written before the pointer existed
  // is repaired from the revision history first (CONFIG_INVALID naming the project when that is not possible). A required
  // E2E task carries the same guard in its current-authority checks, which repair it where they are built. This is before the spec gate: a project whose record is damaged is refused here with the plain sentence,
  // where the gate (which holds on anything it cannot read) would only answer WAITING, and no spec is started for a project that cannot publish.
  if (workflow.e2e?.required !== true) await deps.actions.ensureProjectCatalogPointer(deps.orgId, task.project);
  // Meta repo lane D: a project that asked for a spec gets it first. The spec is written and published (this is where that is started), and the code pull request waits for it, HELD, never opened without it
  // unless the owner chose to continue without; a published spec's link goes in the description. A task with no spec target is not affected (one read).
  const spec = await specPublicationGate(deps, task, workflow);
  if (!spec.proceed) {
    deps.log?.({ event: "developer.task_publication_held_for_spec", taskId, reason: spec.hold.reason });
    return "WAITING";
  }
  const publication = await workflowPublicationAuthority(deps, task, workflow, approvedPlan, workflow.revision + (ownerRetry ? 1 : 0));
  if (publication === undefined) return "STALE";
  // Rovara Code version 2: the description says what changed, how it was tested and how risky it is, and the risk is recorded with the code it was judged on (in the same write that opens the pull request).
  const rovaraV2 = workflow.definitionVersion === "1.1.0";
  // A session bound to a Linear issue gets `Fixes <KEY>` once in the description, so Linear's own GitHub integration closes the issue when the pull request merges (Plan 6 Task 20).
  const linearIssueKey = rovaraV2 ? await linearIssueKeyOfTask({ documentClient: deps.documentClient, tableName: deps.tableName }, task) : undefined;
  // Playbook P1: the Proof section's inputs (the approved plan, the browser/API rows, the test proof); each one that cannot be read is left out.
  const proof = rovaraV2 ? await proofContextOfTask(deps, task, workflow, approvedPlan, "owner") : undefined;
  // Enterprise foundations I3: who asked for the work and who approved its plan, from the very workflow snapshot this publication is conditioned on (the transaction below checks its revision).
  // The same resolved attribution goes into the description, the worker's publish payload (and so the commit) and the audit event's `related`; the host never sees an id.
  const resolvedAttribution = await attributionForPublication(
    { documentClient: deps.documentClient, stateTable: deps.tableName, signInTable: deps.signInTableName ?? deps.tableName, teamRecordTable: deps.tableName },
    { orgId: deps.orgId, taskId, requesterId: task.developerId, decisions: workflow.decisions, origin: origin.taskPageUrl ?? deps.issuer },
  );
  // Proof and evidence P4: a security scan's new high findings on this code raise the risk (only while the proof switch is on; otherwise there is no port and no signal).
  const evidenceRisk = rovaraV2 ? await evidenceRiskOfTask(deps.evidence, evidenceKeyOf(task), workflow.candidate?.digest, securityCheckIdsOf(workflow.checkPolicy)) : undefined;
  // Setup and test health SH18: the Testing view of this code (only while `vx` is on; otherwise undefined and the description is what it was).
  const testing = rovaraV2 ? await loadTestingView(deps, task, workflow) : undefined;
  // Approve by exception (DECISIONS 24): the lessons this task used, each with a not-helpful link (none where lessons are off).
  const lessonsUsed = lessonsUsedSection(await lessonsUsedForTask({ orgId: deps.orgId, project: task.project, taskId, pageUrl: origin.taskPageUrl, repo: repository.repositoryId, startingRevision: task.startingRevision }));
  const bodyContext: PullRequestBodyContext | undefined = rovaraV2
    ? { changedFiles: await candidateChangedFiles(deps, task), ...(lessonsUsed === undefined ? {} : { lessonsUsed }), ...(testing === undefined ? {} : { testing }), ...(linearIssueKey === undefined ? {} : { linearIssueKey }), ...(proof === undefined ? {} : { proof }), ...(evidenceRisk === undefined ? {} : { evidenceRisk }), attribution: resolvedAttribution.attribution }
    : { attribution: resolvedAttribution.attribution, ...(lessonsUsed === undefined ? {} : { lessonsUsed }) };
  const judged = rovaraV2 ? recomputeRisk(workflow, bodyContext?.changedFiles, {}, evidenceRisk) : workflow;
  // Linear reads the title as well as the body, and links a pull request by a bare key in it: no key may stand in a title Rovara writes.
  const title = pullRequestTitle(task.title, rovaraV2);
  const body = withSpecLink(workflowPullRequestBody(task, judged, approvedPlan, origin.taskPageUrl, bodyContext, await loadTestProofLines(deps.actions, task, workflow.candidate?.digest, inertPlanLine)), spec.linkLine);
  const receivedAt = iso(deps);
  const unchanged = {
    ConditionExpression: "workflow.revision = :revision AND workflow.#stage = :stage AND workflow.#state = :state AND attribute_not_exists(closedAt)",
    ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
  };
  const at = { ":revision": workflow.revision, ":stage": "PULL_REQUEST", ":state": workflow.state };
  // AgentX gave up starting it on its own: the owner's retry makes it ready again in the same transaction. An owner's
  // retry after a failed publication moves the revision on (the step is otherwise unchanged), which retires the card
  // that offered it. An automatic start only checks the task is still where it was read.
  const taskItem: TransactItems[number] = workflow.state === "BLOCKED"
    ? { Update: { TableName: deps.tableName, Key: taskKey(taskId), UpdateExpression: "SET workflow = :workflow, updatedAt = :now", ...unchanged,
      ExpressionAttributeValues: { ":workflow": unblockWorkflowPublication(judged, receivedAt), ":now": receivedAt, ...at } } }
    : ownerRetry
      ? { Update: { TableName: deps.tableName, Key: taskKey(taskId), UpdateExpression: "SET workflow = :workflow, updatedAt = :now", ...unchanged,
        ExpressionAttributeValues: { ":workflow": { ...judged, revision: workflow.revision + 1, updatedAt: receivedAt }, ":now": receivedAt, ...at } } }
      // A version 2 task records its risk without moving the revision: it is derived from the very code this write is conditioned on.
      : judged !== workflow
        ? { Update: { TableName: deps.tableName, Key: taskKey(taskId), UpdateExpression: "SET workflow = :workflow", ...unchanged, ExpressionAttributeValues: { ":workflow": judged, ...at } } }
        : { ConditionCheck: { TableName: deps.tableName, Key: taskKey(taskId), ...unchanged, ExpressionAttributeValues: at } };
  // The base the task's code was reviewed against is the published commit's parent, which the broker checks on GitHub.
  const baseCommitSha = (workflow.reviewBase ?? task.preparedBase)?.find((entry) => entry.repositoryId === repository.repositoryId)?.baseCommitSha;
  // What each extra item below checks, in the same order, for naming the one a cancelled acceptance failed on.
  const extraItemLabels = ["the task", ...currentE2EChecks.map(() => "the current E2E authority"),
    ...publication.conditions.map(() => `project ${task.project}'s catalog pointer`), "the turn record",
    ...(dispatchAccess === undefined ? [] : ["the task's people access"])];
  let accepted: Awaited<ReturnType<DeveloperTaskActions["acceptPullRequest"]>>;
  try {
    accepted = await deps.actions.acceptPullRequest(developerTaskIdentity(task, deps.orgId), task.workspaceId, {
      requestId, repository: repository.repositoryId, title, body, draft: true,
    }, (operation) => [
      taskItem,
      ...currentE2EChecks,
      ...publication.conditions,
      putNew(turnTable(deps), aiToolTurn({
        party: origin.ownerActor === undefined ? partyOfTask(task) : partyOfTaskActor(task, origin.ownerActor), turnId: randomUUID(), action: "pull_request", phase: "accepted", outcome: "accepted", receivedAt, finishedAt: iso(deps),
        request: ownerRetry ? "Retry opening the pull request" : "Open the draft pull request",
        response: `AgentX is opening a draft pull request on ${repository.repositoryId} as operation ${operation.id}.`, operationId: operation.id,
      })),
      ...(dispatchAccess === undefined ? [] : [taskAccessFence(deps.tableName, taskId, dispatchAccess.peopleRevision)]),
    ], { workflowCandidate: { repositoryId: repository.repositoryId, treeSha: repository.treeSha,
      ...(publication.authority.mode === "COMMITTED_HEAD" ? { commitSha: repository.commitSha } : {}), candidateDigest: expected.candidateDigest,
      ...(baseCommitSha === undefined ? {} : { baseCommitSha }), publicationMode: publication.authority.mode,
      admittedPinnedRevision: publication.authority.pinnedRevision, admittedLatestRevision: publication.authority.latestRevision,
      admittedMaterialDigest: publication.authority.materialDigest, admittedWorkflowRevision: publication.authority.workflowRevision,
      admittedPlanArtifact: publication.authority.planArtifact, admittedOwnerApproval: publication.authority.ownerApproval,
      admittedWorkflowAuthorityDigest: publication.authority.workflowAuthorityDigest }, attribution: resolvedAttribution });
  } catch (error) {
    // The task moved on (or closed) between the read and the commit: nothing was started, and nothing is due.
    const failedExtras = extraItemsCancelled(error);
    if (error instanceof AgentXError && (error.code === "WORKSPACE_BUSY" || failedExtras !== undefined)) {
      const fresh = await get<DeveloperTaskRecord>(deps, taskKey(taskId));
      if (fresh === undefined || fresh.closedAt !== undefined || fresh.workflow?.revision !== workflow.revision || fresh.workflow.state !== workflow.state) return "STALE";
    }
    // The workspace was free; one of the publication's own conditions failed. Say which, never "busy".
    if (failedExtras !== undefined) {
      const names = failedExtras.flatMap((code, index) => code === "ConditionalCheckFailed" ? [extraItemLabels[index] ?? `item ${index}`] : []);
      throw agentXError("CONFIG_INVALID", `AgentX could not start opening the pull request because ${names.join(" and ")} changed while it was starting; try again`);
    }
    throw error;
  }
  // A replayed request writes nothing, so a block lifted by this retry is lifted on its own: the publication it replays
  // (still running, or just finished) needs the task ready to record its pull request.
  if (accepted.duplicate && workflow.state === "BLOCKED") {
    try {
      await deps.actions.transact([taskItem, ...currentE2EChecks, ...(dispatchAccess === undefined ? [] : [taskAccessFence(deps.tableName, taskId, dispatchAccess.peopleRevision)])]);
    } catch (error) {
      if (!isConditional(error)) throw error;
    }
  }
  await recordPublishedCandidateOutcomes(deps, task, judged, receivedAt);
  return accepted.duplicate ? "DUPLICATE" : "STARTED";
}

/**
 * Item 7: push the fix whose checks and reviews passed to the pull request AgentX already opened, one pull request at a
 * time (the next is due when this one's result lands). The worker appends exactly the reviewed tree, on the task's pinned
 * base, onto the head the workflow recorded; the task runs until the result lands. The request ID is derived from the
 * task, revision, candidate and repository, so a recovered or repeated dispatch is the broker's duplicate (a failed push
 * blocks the task and is never retried on its own, so the attempt is always the first).
 *
 * A pull request that changed on GitHub since AgentX opened it (its head moved, or it merged or closed) is not pushed to:
 * the task waits for the merge, blocked, saying so. WORKSPACE_BUSY and WORKSPACE_NOT_READY propagate so the dispatcher
 * tries again later.
 */
async function startTaskWorkflowPullRequestUpdate(
  deps: DeveloperTaskRouteDependencies,
  task: DeveloperTaskRecord,
  workflow: WorkflowSnapshot & { candidate: NonNullable<WorkflowSnapshot["candidate"]> },
  expected: { workflowRevision: number; candidateDigest: string },
  currentE2EChecks: TransactItems,
  ownerAccess?: Pick<TaskAccess, "peopleRevision">,
  ownerActor?: DeveloperCaller,
): Promise<"STARTED" | "DUPLICATE" | "STALE"> {
  if (isReplayCopy(task)) return "STALE";
  if (workflow.e2e?.required === true && currentE2EChecks.length === 0) return "STALE";
  const pullRequest = nextWorkflowPullRequestUpdate(workflow);
  const repository = workflow.candidate.repositories.find((entry) => entry.repositoryId === pullRequest?.repositoryId);
  const baseCommitSha = workflow.reviewBase?.find((entry) => entry.repositoryId === repository?.repositoryId)?.baseCommitSha;
  if (pullRequest === undefined || repository === undefined) return "STALE";
  const unchanged = {
    ConditionExpression: "workflow.revision = :revision AND workflow.#stage = :stage AND workflow.#state = :state AND attribute_not_exists(closedAt)",
    ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
  };
  const at = { ":revision": workflow.revision, ":stage": "PULL_REQUEST", ":state": "READY" };
  const block = async (cause?: WorkflowPullRequestUpdateCause): Promise<"STALE"> => {
    const now = iso(deps);
    try {
      await deps.actions.transact([{ Update: { TableName: deps.tableName, Key: taskKey(task.taskId), UpdateExpression: "SET workflow = :workflow, updatedAt = :now", ...unchanged,
        ExpressionAttributeValues: { ":workflow": blockWorkflowPullRequestUpdate(workflow, { numbers: [pullRequest.number], cause, now }), ":now": now, ...at } } },
      ...currentE2EChecks,
      ...(ownerAccess === undefined ? [] : [taskAccessFence(deps.tableName, task.taskId, ownerAccess.peopleRevision)])]);
    } catch (error) {
      if (!isConditional(error)) throw error;
    }
    return "STALE";
  };
  // A pull request recorded before AgentX kept its head, or a task with no pinned base, cannot be pushed to as reviewed.
  if (pullRequest.headSha === undefined || baseCommitSha === undefined) return block();
  const requestId = workflowRequestId("agentx-auto-update", task.taskId, expected.workflowRevision, expected.candidateDigest, repository.repositoryId, 1);
  const receivedAt = iso(deps);
  // Rovara Code version 2: the code on the pull request changes with this push, so its risk is judged again for the new code, in the write that starts the push.
  const started = startWorkflowPullRequestUpdate(workflow, receivedAt);
  const judged = workflow.definitionVersion === "1.1.0" ? recomputeRisk(started, await candidateChangedFiles(deps, task), {}, await evidenceRiskOfTask(deps.evidence, evidenceKeyOf(task), started.candidate?.digest, securityCheckIdsOf(workflow.checkPolicy))) : started;
  let accepted: Awaited<ReturnType<DeveloperTaskActions["acceptPullRequestUpdate"]>>;
  try {
    accepted = await deps.actions.acceptPullRequestUpdate(developerTaskIdentity(task, deps.orgId), task.workspaceId, {
      requestId, repository: repository.repositoryId, pullRequestNumber: pullRequest.number, action: "append",
    }, (operation) => [
      { Update: { TableName: deps.tableName, Key: taskKey(task.taskId), UpdateExpression: "SET workflow = :workflow, updatedAt = :now", ...unchanged,
        ExpressionAttributeValues: { ":workflow": judged, ":now": receivedAt, ...at } } },
      putNew(turnTable(deps), aiToolTurn({
        party: ownerActor === undefined ? partyOfTask(task) : partyOfTaskActor(task, ownerActor), turnId: randomUUID(), action: "pull_request", phase: "accepted", outcome: "accepted", receivedAt, finishedAt: iso(deps),
        request: "Push the approved fix to the pull request",
        response: `AgentX is pushing the approved fix to pull request #${pullRequest.number} on ${repository.repositoryId} as operation ${operation.id}.`, operationId: operation.id,
      })),
      ...currentE2EChecks,
      ...(ownerAccess === undefined ? [] : [taskAccessFence(deps.tableName, task.taskId, ownerAccess.peopleRevision)]),
    ], { candidateDigest: expected.candidateDigest, treeSha: repository.treeSha, baseCommitSha, expectedHeadCommit: pullRequest.headSha, ...(workflow.fixSource === undefined ? {} : { fixSource: workflow.fixSource }),
      // A conflict round's fix is pushed as the merge of the base commit whose merge conflicted (Plan 6 Task 17).
      ...(workflow.fixSource === "conflict" && workflow.conflictBase !== undefined ? { mergeBaseCommit: workflow.conflictBase } : {}) });
  } catch (error) {
    if (error instanceof AgentXError && error.code === "STALE_FENCE") {
      // The pull request changed on GitHub. A merge at the head AgentX recorded completes the task: GitHub is read again
      // (as a webhook would be) before the task is blocked, and a task that moved on meanwhile is left as it is.
      try {
        await deps.refreshTaskFeedback?.(task.taskId);
      } catch {
        // Not readable now: the task is blocked below, and a later webhook still observes a merge.
      }
      const fresh = await get<DeveloperTaskRecord>(deps, taskKey(task.taskId));
      if (fresh?.workflow?.revision !== workflow.revision) return "STALE";
      return block("HEAD_MOVED");
    }
    // The task moved on (or closed) between the read and the commit: nothing was started, and nothing is due.
    if (error instanceof AgentXError && (error.code === "WORKSPACE_BUSY" || extraItemsCancelled(error) !== undefined)) {
      const fresh = await get<DeveloperTaskRecord>(deps, taskKey(task.taskId));
      if (fresh === undefined || fresh.closedAt !== undefined || fresh.workflow?.revision !== workflow.revision || fresh.workflow.state !== workflow.state) return "STALE";
    }
    throw error;
  }
  await recordPublishedCandidateOutcomes(deps, task, judged, receivedAt, pullRequest.candidateDigest);
  return accepted.duplicate ? "DUPLICATE" : "STARTED";
}

/**
 * Plan 6 Task 17: the merge of the base branch into a pull request's branch, started with no one asking. The task is at WAIT_FOR_MERGE/READY with the merge marked (the tracking pass queued it and counted it
 * against the day's merges). Before any machine is asked for, the pull request's head on GitHub must still be the head the merge is for (a person's push wins, and ends the merge) and the base branch's
 * commit is read now: that exact commit is merged. The worker then merges it (`git merge --no-ff`: never a rebase, never a force-push), runs the readiness checks and pushes onto that head.
 * Every way the merge cannot start ends it (the task waits for the merge as it did); WORKSPACE_BUSY and WORKSPACE_NOT_READY propagate so the dispatcher tries again, and so does a GitHub that cannot say.
 * The request ID comes from the task, revision and base commit, so a recovered or repeated dispatch is the broker's duplicate of the first.
 */
export async function startTaskWorkflowBranchSyncFromSystem(
  deps: DeveloperTaskRouteDependencies,
  taskId: string,
  expected: { workflowRevision: number },
  actor?: DeveloperCaller,
): Promise<"STARTED" | "DUPLICATE" | "STALE"> {
  const task = await get<DeveloperTaskRecord>(deps, taskKey(taskId));
  if (isReplayCopy(task)) return "STALE";
  const workflow = task?.workflow;
  if (task === undefined || task.closedAt !== undefined || workflow === undefined || workflow.revision !== expected.workflowRevision || workflow.stage !== "WAIT_FOR_MERGE"
    || workflow.state !== "READY" || workflow.branchSync === undefined) return "STALE";
  const marker = workflow.branchSync;
  const unchanged = {
    ConditionExpression: "workflow.revision = :revision AND workflow.#stage = :stage AND workflow.#state = :state AND attribute_not_exists(closedAt)",
    ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
  };
  const at = { ":revision": workflow.revision, ":stage": "WAIT_FOR_MERGE", ":state": "READY" };
  /** The merge cannot start: it ends, and the task waits for the merge as it did. A task that moved on meanwhile is left as it is. */
  const end = async (): Promise<"STALE"> => {
    const now = iso(deps);
    try {
      await deps.actions.transact([{ Update: { TableName: deps.tableName, Key: taskKey(task.taskId), UpdateExpression: "SET workflow = :workflow, updatedAt = :now", ...unchanged,
        ExpressionAttributeValues: { ":workflow": endWorkflowBranchSync(workflow, now), ":now": now, ...at } } }]);
    } catch (error) {
      if (!isConditional(error)) throw error;
    }
    return "STALE";
  };
  await creatorGuard(deps, task);
  const dispatchAccess = await systemTaskAccess(deps, task);
  const workspace = await deps.actions.workspace(task.workspaceId);
  const pullRequest = (workflow.pullRequests ?? []).find((entry) => entry.repositoryId === marker.repositoryId && entry.number === marker.number && (entry.state === "OPEN" || entry.state === "UNKNOWN"));
  if (workspace.status === "CLOSED" || workspace.status === "PREPARATION_FAILED" || pullRequest === undefined || pullRequest.headSha !== marker.expectedHeadCommit
    || deps.currentPullRequestHead === undefined || deps.currentBaseCommit === undefined) return end();
  // A person's push wins: if the head is no longer the one this merge is for, nothing is merged.
  if (await deps.currentPullRequestHead(task, pullRequest) !== marker.expectedHeadCommit) return end();
  const baseCommit = await deps.currentBaseCommit(task, pullRequest);
  if (!/^[a-f0-9]{40}$/u.test(baseCommit)) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub did not say what the base branch is at");
  const requestId = branchSyncRequestId(taskId, workflow.revision, baseCommit);
  const receivedAt = iso(deps);
  const next = startWorkflowBranchSyncRun(workflow, receivedAt);
  let accepted: Awaited<ReturnType<DeveloperTaskActions["acceptPullRequestUpdate"]>>;
  try {
    accepted = await deps.actions.acceptPullRequestUpdate(developerTaskIdentity(task, deps.orgId), task.workspaceId, {
      requestId, repository: marker.repositoryId, pullRequestNumber: marker.number, action: "sync",
    }, (operation) => [
      { Update: { TableName: deps.tableName, Key: taskKey(task.taskId), UpdateExpression: "SET workflow = :workflow, updatedAt = :now", ...unchanged,
        ExpressionAttributeValues: { ":workflow": next, ":now": receivedAt, ...at } } },
      putNew(turnTable(deps), aiToolTurn({
        party: actor === undefined ? partyOfTask(task) : partyOfTaskActor(task, actor), turnId: randomUUID(), action: "pull_request", phase: "accepted", outcome: "accepted", receivedAt, finishedAt: iso(deps),
        request: "Merge the base branch into the pull request's branch",
        response: `AgentX is merging the base branch into pull request #${marker.number} on ${marker.repositoryId} as operation ${operation.id}.`, operationId: operation.id,
      })),
      ...(dispatchAccess === undefined ? [] : [accessFence(deps, dispatchAccess)]),
    ], { sync: { baseCommit, expectedHeadCommit: marker.expectedHeadCommit } });
  } catch (error) {
    // The pull request changed on GitHub (its head moved, or it is no longer open): nothing is merged, and the task waits for the merge.
    if (error instanceof AgentXError && error.code === "STALE_FENCE") return end();
    // The task moved on (or closed) between the read and the commit: nothing was started, and nothing is due.
    if (error instanceof AgentXError && (error.code === "WORKSPACE_BUSY" || extraItemsCancelled(error) !== undefined)) {
      const fresh = await get<DeveloperTaskRecord>(deps, taskKey(task.taskId));
      if (fresh === undefined || fresh.closedAt !== undefined || fresh.workflow?.revision !== workflow.revision || fresh.workflow.state !== workflow.state) return "STALE";
    }
    throw error;
  }
  return accepted.duplicate ? "DUPLICATE" : "STARTED";
}

/** The owner asks AgentX to open the draft pull request again: after a failed publication, or after AgentX gave up. */
export async function retryTaskWorkflowPublication(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, value: unknown): Promise<{ task: DeveloperTaskView }> {
  const request = parse(WorkflowPublishRetryRequestSchema, value, deps, "workflow-publish-retry");
  const access = await authorizeTaskAction(deps, caller, taskId, "publish");
  // S2 (any path): opening the pull request again is a worker run started for this person, so it meets the send-back's project access rule and the archive check.
  await requireProjectSendBackRole(deps, access.task, caller);
  const resumed = await resumeParkedTaskDispatch(deps, caller, access, request);
  if (resumed !== undefined) return resumed;
  const { task } = access;
  const workflow = task.workflow;
  if (workflow === undefined || workflow.candidate === undefined || !workflowPublicationRetryable(workflow)) {
    throw agentXError("CONFIG_INVALID", "AgentX can retry opening the pull request only after the checks and reviews passed and before it is open");
  }
  if (request.expectedRevision !== workflow.revision) {
    throw agentXError("IDEMPOTENCY_CONFLICT", "this retry is out of date; refresh the task and try again");
  }
  await actionableWorkspace(deps, task);
  let outcome: Awaited<ReturnType<typeof startTaskWorkflowPublicationFromSystem>>;
  try {
    outcome = await startTaskWorkflowPublicationFromSystem(deps, taskId, { workflowRevision: workflow.revision, candidateDigest: workflow.candidate.digest },
      { ownerRetry: true, ownerAccess: access, ownerActor: caller, ...(deps.issuer === undefined ? {} : { taskPageUrl: taskPageUrl(deps.issuer, taskId) }) });
  } catch (error) {
    if (isConditional(error)) await authorizeTaskAction(deps, caller, taskId, "publish");
    return busyOrClosing(deps, task, error);
  }
  if (outcome === "STALE") throw agentXError("IDEMPOTENCY_CONFLICT", "this retry is out of date; refresh the task and try again");
  const fresh = (await authorizeTaskAction(deps, caller, taskId, "publish")).task;
  const view = await taskView(deps, fresh, { events: 0, details: false });
  await syncIndex(deps, fresh, view.status, view.updatedAt);
  return { task: view };
}

/**
 * The owner keeps the pull requests as they are after an approved fix changed nothing: the task waits for the merge again,
 * and the feedback the fix was for is recorded as dismissed. Owner only, at the exact revision; nothing runs.
 */
export async function keepTaskWorkflowPullRequests(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, value: unknown): Promise<{ task: DeveloperTaskView }> {
  const request = parse(WorkflowPublishRetryRequestSchema, value, deps, "workflow-keep-pull-requests");
  const access = await authorizeTaskAction(deps, caller, taskId, "decide");
  const { task } = access;
  const workflow = task.workflow;
  if (workflow === undefined) throw agentXError("NOT_FOUND", "this task does not have a workflow record");
  // A repeated request answers as the first, but only when that request was this same Keep at this revision.
  const prior = workflow.feedbackDecisions?.find((decision) => decision.requestId === request.requestId)
    ?? (workflow.decisions.some((decision) => decision.requestId === request.requestId) ? { decision: "OTHER" as const } : undefined);
  if (prior !== undefined) {
    if (!("ownerNote" in prior) || prior.decision !== "DISMISS" || prior.ownerNote !== WORKFLOW_KEEP_PULL_REQUESTS_NOTE || prior.workflowRevision !== request.expectedRevision) {
      throw agentXError("IDEMPOTENCY_CONFLICT", "this request ID was already used for another decision on this task; use a new one");
    }
    return { task: await taskView(deps, task, { events: 0, details: false }) };
  }
  if (request.expectedRevision !== workflow.revision) throw agentXError("IDEMPOTENCY_CONFLICT", "this request is out of date; refresh the task and try again");
  const now = iso(deps);
  let next: WorkflowSnapshot;
  try {
    next = keepWorkflowPullRequests(workflow, { requestId: request.requestId, actorId: access.actorId, now }, access.authority);
  } catch (error) {
    if (error instanceof WorkflowTransitionError) throw agentXError("CONFIG_INVALID", error.message);
    throw error;
  }
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [{ Update: { TableName: deps.tableName, Key: taskKey(taskId),
      UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
      ConditionExpression: "workflow.revision = :revision AND attribute_not_exists(closedAt)",
      ExpressionAttributeValues: { ":workflow": next, ":now": now, ":revision": workflow.revision } } }, accessFence(deps, access)] }));
  } catch (error) {
    if (isConditional(error)) {
      await authorizeTaskAction(deps, caller, taskId, "decide");
      throw agentXError("IDEMPOTENCY_CONFLICT", "this request is out of date; refresh the task and try again");
    }
    throw error;
  }
  const fresh = (await authorizeTaskAction(deps, caller, taskId, "decide")).task;
  const view = await taskView(deps, fresh, { events: 0, details: false });
  await syncIndex(deps, fresh, view.status, view.updatedAt);
  return { task: view };
}
