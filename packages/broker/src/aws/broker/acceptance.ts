// Part of the broker (split out of ../broker.ts): accepting tasks and pull requests, and cancelling tasks.

import { joinTaskModelFallback } from "../../model-selection/fallback-record.js";
import { randomUUID } from "node:crypto";
import { TransactWriteCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { type AgentXError, OperationRequestSchema, PullRequestRequestSchema, PullRequestLifecycleRequestSchema, PullRequestLifecycleResultSchema, agentXError, type Operation, type OperationRequester, type OperationStatus, type ProjectCommand, type WorkflowFeedbackApprovalBinding, type OwnerRedirectInvocation, type WorkflowDependencyInvocation, type WorkflowReviewBase, type WorkflowReviewChecks, type WorkflowReviewPlan, type WorkflowReviewFeedback, type WorkflowReviewNote, type PullRequestLifecycleResult, type WorkspaceInstance, type E2EWorkflowAdmissionRef, workflowPublicationContextDigest, codeRepositoriesOf } from "@rovara-code/contracts";
import { workerProjectDefinition } from "@agentx/cloud-contracts";
import { blockWorkflow, type WorkflowFixPayload, type WorkerInvocation, workflowPublicationContext } from "@agentx/cloud-contracts";
import type { SpecReviewInput, SpecWriteBinding } from "@rovara-code/contracts";
import type { ResolvedAttribution } from "../../attribution/resolve.js";
import type { AuthenticatedIdentity } from "../../auth.js";
import { flushAuditEvents } from "../../audit/flush.js";
import { assertNoUntrustedRoutingFields } from "../../authorization.js";
import { requireOrgId } from "../../org/resolve.js";
import { TERMINAL, getItem, issueCapability, operationKey, operationOrg, operationRecord, outboxRecord, publicOperation, requestCancellation, requireOperation, type OperationRecord } from "../cancellation.js";
import { requireWorkspaceCreatorStillMember } from "../../developer/creator-member.js";
import { taskKey, taskPointerKey, type DeveloperTaskPointerRecord, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { WORKFLOW_DISPATCH_PK, type WorkflowDispatchRecord, GATED_TASK_PULL_REQUEST_ACTION_REFUSAL, GATED_TASK_PULL_REQUEST_REFUSAL, GATED_TASK_TURN_REFUSAL, hashJson, isConditional } from "../broker-shared.js";
import type { AgentRunStepInput } from "../../agents/dispatch.js";
import type { ExtraItems } from "../developer-task-actions.js";
import { workflowRunEndedReason } from "../outbox-failure.js";
import { ownerStopRows } from "../workflow-autofix-dispatch-exhaust.js";
import { issueRepositoryGrant, pullRequestKey, workspaceKey } from "./admin-and-helpers.js";
import type { AwsBrokerDependencies, PullRequestRecord } from "./definitions.js";
import { gatedTaskWorkspace, workspaceTaskOwner } from "./model-access.js";
import { boundedTurnAdmission } from "../../model-selection/turn-admission.js";
import { adoptLegacyPullRequest, publicationProject, requireAdministrator, requireOwnedWorkspace, requireProjectAuthority, requireWorkspace } from "./records.js";
import { creatorCheckOf, githubScopeOf } from "./scope-helpers.js";
import { canReadBranchAndTree, changeRequestRef, hostOfRepository, pullRequestDetailsOf, repositoryRefOf, requireGithubHost } from "./repository-hosts.js";
import { taskOperationParts } from "./task-operations.js";
import { recordModelUse } from "../../org/health-observations.js";
import type { DesignReviewDispatch } from "../../design-review/round-ports.js";
import { latestChecksItem, recordTerminalResult } from "./terminal-result.js";
import { withdrawParkedDelivery } from "../parked-stop.js";
import { attributedBody, requesterOf } from "./thread-workspaces.js";
import { requireSlackRequesterMayWork } from "./workspace-preparation.js";
import { newTaskStopWindowReference, requireTaskStopWindowContext, withAdmittedTaskSource } from "../../org/task-stop-window.js";

export async function acceptTask(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspaceId: string,
  value: unknown,
  extra: ExtraItems = () => [],
  options: { sharedTask?: boolean; planRevision?: true; operationId?: string; workflowMode?: "UNDERSTAND" | "PLAN" | "PLAN_CRITIQUE" | "IMPLEMENT" | "REVIEW" | "CHECKS" | "FEEDBACK_REVIEW" | "SPEC_WRITE"; specWrite?: SpecWriteBinding; workflowReviewSpec?: SpecReviewInput; workflowPhase?: "REQUIREMENTS" | "DESIGN" | "IMPLEMENTATION_PLAN"; readiness?: ProjectCommand[]; workflowFeedbackReview?: { taskId: string; workflowRevision: number; candidateDigest: string }; workflowFeedbackApproval?: WorkflowFeedbackApprovalBinding; workflowE2EAdmission?: E2EWorkflowAdmissionRef; workflowE2EBaselineSource?: true; workflowDependencies?: WorkflowDependencyInvocation; workflowBase?: WorkflowReviewBase; workflowReviewChecks?: WorkflowReviewChecks; workflowReviewPlan?: WorkflowReviewPlan; workflowReviewFeedback?: WorkflowReviewFeedback; workflowReviewNote?: WorkflowReviewNote; programStepId?: string; workflowReviewers?: ReadonlyArray<"CRITIC" | "SECURITY">; workflowReviewRisk?: true; workflowFix?: WorkflowFixPayload; ownerRedirect?: OwnerRedirectInvocation; retiredClaimIds?: readonly string[]; agentRun?: AgentRunStepInput; firstEvent?: string; designReview?: DesignReviewDispatch } = {},
): Promise<{ operation: Operation; duplicate: boolean }> {
  assertNoUntrustedRoutingFields(value);
  const request = OperationRequestSchema.parse(value);
  const workspace = await requireOwnedWorkspace(dependencies, identity, workspaceId);
  await requireSlackRequesterMayWork(dependencies, identity, workspace.projectName);
  await requireProjectAuthority(dependencies, requireOrgId(identity.orgId), identity.ownerKey, workspace.projectName, { taskCreator: () => workspaceTaskOwner(dependencies, workspace.id) });
  const requestHash = hashJson({ conversationId: request.conversationId, prompt: request.prompt,
    ...(options.workflowReviewNote === undefined ? {} : { workflowReviewNote: options.workflowReviewNote }),
    ...(options.workflowReviewers === undefined ? {} : { workflowReviewers: options.workflowReviewers }),
    ...(options.workflowReviewRisk === true ? { workflowReviewRisk: true as const } : {}),
    ...(options.workflowFix === undefined ? {} : { workflowFix: options.workflowFix }),
    ...(options.ownerRedirect === undefined ? {} : { ownerRedirect: options.ownerRedirect }),
    ...(options.specWrite === undefined ? {} : { specWrite: options.specWrite }),
    ...(options.workflowReviewSpec === undefined ? {} : { workflowReviewSpec: options.workflowReviewSpec }),
    ...(options.workflowDependencies === undefined ? {} : { workflowDependencies: options.workflowDependencies }),
    ...(options.workflowE2EAdmission === undefined ? {} : { workflowE2EAdmission: options.workflowE2EAdmission }) });
  const idempotencyKey = {
    pk: `IDEMPOTENCY#${identity.ownerKey}#${workspaceId}`,
    sk: `REQUEST#${request.requestId}`,
  };
  const previous = await getItem<{ operationId: string; payloadHash: string }>(dependencies, idempotencyKey);
  if (previous) {
    if (previous.payloadHash !== requestHash) throw agentXError("IDEMPOTENCY_CONFLICT", "request ID was reused with another payload");
    return { operation: publicOperation(await requireOperation(dependencies, workspaceId, previous.operationId)), duplicate: true };
  }
  // Gap 10a: a gated developer task's workspace takes only its own workflow-mode dispatches, never an
  // ordinary write-capable turn, whoever asks (the owner, a shared-thread service identity, anyone).
  if (options.workflowMode === undefined && await gatedTaskWorkspace(dependencies, workspaceId)) {
    throw agentXError("WORKSPACE_BUSY", GATED_TASK_TURN_REFUSAL);
  }
  const conversation = await getItem<{ startedAt?: string }>(dependencies, {
    pk: `WORKSPACE#${workspaceId}`,
    sk: `CONVERSATION#${request.conversationId}`,
  });
  if (!conversation) throw agentXError("NOT_FOUND", "conversation not found");
  // Only a recorded attribute means "started"; conversations from before this attribute existed
  // have none, so their next task creates the session instead of failing closed.
  const conversationStarted = typeof conversation.startedAt === "string";
  if (!["READY", "STOPPED"].includes(workspace.status) || workspace.activeOperationId) {
    throw agentXError(workspace.status === "BUSY" ? "WORKSPACE_BUSY" : "WORKSPACE_NOT_READY", `workspace is ${workspace.status}`);
  }
  const now = new Date().toISOString();
  const { operation, outbox, fence,fallback,modelChecks,turnAudit,modelUse } = await taskOperationParts(dependencies, workspace, {
    requestId: request.requestId,
    conversationId: request.conversationId,
    prompt: request.prompt,
    conversationStarted,
    requester: requesterOf(identity),
    ...(identity.orgId === undefined ? {} : { orgId: identity.orgId }),
    ...(identity.slack === undefined ? {} : { slackThread: identity.slack.thread }),
    // 25c note 1: a turn from an open shared thread, or the developer's own turn on a shared task.
    shared: identity.sharedTask?.state === "continue" || options.sharedTask === true,
    ...(options.workflowMode === undefined ? {} : { workflowMode: options.workflowMode }),
    ...(options.planRevision === true ? { planRevision: true as const } : {}),
    ...(options.operationId === undefined ? {} : { operationId: options.operationId }),
    ...(options.workflowPhase === undefined ? {} : { workflowPhase: options.workflowPhase }),
    ...(options.workflowFeedbackReview === undefined ? {} : { workflowFeedbackReview: options.workflowFeedbackReview }),
    ...(options.workflowFeedbackApproval === undefined ? {} : { workflowFeedbackApproval: options.workflowFeedbackApproval }),
    ...(options.workflowE2EAdmission === undefined ? {} : { workflowE2EAdmission: options.workflowE2EAdmission }),
    ...(options.workflowE2EBaselineSource === true ? { workflowE2EBaselineSource: true as const } : {}),
    ...(options.workflowDependencies === undefined ? {} : { workflowDependencies: options.workflowDependencies }),
    ...(options.workflowBase === undefined ? {} : { workflowBase: options.workflowBase }),
    ...(options.workflowReviewChecks === undefined ? {} : { workflowReviewChecks: options.workflowReviewChecks }),
    ...(options.workflowReviewPlan === undefined ? {} : { workflowReviewPlan: options.workflowReviewPlan }),
    ...(options.workflowReviewFeedback === undefined ? {} : { workflowReviewFeedback: options.workflowReviewFeedback }),
    ...(options.workflowReviewNote === undefined ? {} : { workflowReviewNote: options.workflowReviewNote }),
    ...(options.programStepId === undefined ? {} : { programStepId: options.programStepId }),
    ...(options.workflowReviewers === undefined ? {} : { workflowReviewers: options.workflowReviewers }),
    ...(options.workflowReviewRisk === true ? { workflowReviewRisk: true as const } : {}),
    ...(options.workflowFix === undefined ? {} : { workflowFix: options.workflowFix }),
    ...(options.ownerRedirect === undefined ? {} : { ownerRedirect: options.ownerRedirect }),
    ...(options.specWrite === undefined ? {} : { specWrite: options.specWrite }),
    ...(options.workflowReviewSpec === undefined ? {} : { workflowReviewSpec: options.workflowReviewSpec }),
    ...(options.retiredClaimIds === undefined ? {} : { retiredClaimIds: options.retiredClaimIds }),
    ...(options.readiness === undefined ? {} : { readiness: options.readiness }),
    ...(options.agentRun === undefined ? {} : { agentRun: options.agentRun }),
    ...(options.designReview === undefined ? {} : { designReview: options.designReview }),
  }, now);
  let dispatchExtras = extra(publicOperation(operation));
  const taskPointer = await getItem<DeveloperTaskPointerRecord>(dependencies, taskPointerKey(workspaceId));
  const admittedTask = taskPointer === undefined ? undefined : await getItem<DeveloperTaskRecord>(dependencies, taskKey(taskPointer.taskId));
  if (admittedTask !== undefined && (admittedTask.spendingStop !== undefined || admittedTask.spendingAdmission !== undefined)) {
    await requireTaskStopWindowContext(dependencies, admittedTask);
    const reference = newTaskStopWindowReference(dispatchExtras, admittedTask) ?? admittedTask.spendingAdmission;
    if (reference === undefined) throw agentXError("TASK_STOP_CONFIG_INVALID", "The task admission reference is unavailable.");
    operation.spendingTaskId = admittedTask.taskId; operation.spendingAdmission = reference;
    dispatchExtras = withAdmittedTaskSource(dependencies.tableName, admittedTask, dispatchExtras, "operationWindow").items;
  }
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: boundedTurnAdmission(joinTaskModelFallback([
      { Update: {
        TableName: dependencies.tableName,
        Key: workspaceKey(workspaceId),
        // Spec 051 Ruling T: until its own result arrives, the task reads as interrupted, so no older report stands.
        UpdateExpression: "SET #status = :busy, activeOperationId = :operation, fence = :fence, updatedAt = :now, latestChecks = :latestChecks",
        ConditionExpression: "ownerKey = :owner AND attribute_not_exists(activeOperationId) AND (#status = :ready OR #status = :stopped)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":owner": identity.ownerKey, ":busy": "BUSY", ":ready": "READY", ":stopped": "STOPPED", ":operation": operation.id, ":fence": fence, ":now": now,
          ":latestChecks": latestChecksItem({ status: "not_verified", reason: "interrupted" }, operation.id, fence, now),
        },
      } },
      // A first event (Bug N) makes the operation start at sequence 1, so the worker's own events follow it.
      { Put: { TableName: dependencies.tableName, Item: options.firstEvent === undefined ? operation : { ...operation, eventSequence: 1 }, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: dependencies.tableName, Item: outbox, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: dependencies.tableName, Item: { ...idempotencyKey, entityType: "IDEMPOTENCY", operationId: operation.id, payloadHash: requestHash }, ConditionExpression: "attribute_not_exists(pk)" } },
      ...dispatchExtras,
      // Last, so the caller's extra items keep their positions in a cancellation's reasons.
      ...(options.firstEvent === undefined ? [] : [{ Put: {
        TableName: dependencies.tableName,
        Item: { pk: `OPERATION#${operation.id}`, sk: `EVENT#${String(1).padStart(12, "0")}`, entityType: "EVENT", workspaceId, operationId: operation.id, sequence: 1,
          type: "progress", timestamp: now, payload: { message: options.firstEvent } },
        ConditionExpression: "attribute_not_exists(pk)",
      } }]),
      ...(modelChecks??[]),
    ],fallback?.items??[])) }));
  } catch (error) {
    if (isConditional(error)) {
      const concurrent = await getItem<{ operationId: string; payloadHash: string }>(dependencies, idempotencyKey);
      if (concurrent) {
        if (concurrent.payloadHash !== requestHash) {
          throw agentXError("IDEMPOTENCY_CONFLICT", "request ID was reused with another payload");
        }
        return {
          operation: publicOperation(await requireOperation(dependencies, workspaceId, concurrent.operationId)),
          duplicate: true,
        };
      }
      // Which of the caller's own items failed (after this function's four), so it can tell its own conditions apart.
      const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? [];
      throw Object.assign(agentXError("WORKSPACE_BUSY", "workspace already has an active writer"), { extraCancellation: reasons.slice(4).map((reason) => reason.Code ?? "None") });
    }
    throw error;
  }
  if(fallback?.event!==undefined)await flushAuditEvents(dependencies,[fallback.event]);
  if(turnAudit!==undefined)await flushAuditEvents(dependencies,[turnAudit.event]);
  if(modelUse!==undefined)await recordModelUse(dependencies,modelUse.orgId,modelUse.use);
  return { operation: publicOperation(operation), duplicate: false };
}

/** The four items every accepted request writes first: the workspace claim, the operation, its outbox row and the idempotency record. */
const ACCEPTANCE_OWN_ITEMS = ["workspace", "operation", "outbox", "idempotency"] as const;

/**
 * A cancelled acceptance transaction, read item by item and logged (item names and DynamoDB reason codes only). When
 * the four own items held and only the caller's extra items failed their conditions, the workspace was not the
 * conflict: the refusal is CONFIG_INVALID naming the extra items, not WORKSPACE_BUSY. `extraCancellation` keeps each
 * extra item's reason in the order the caller built them, so the caller can name which one it was.
 */
function acceptancePullRequestCancellation(error: unknown, context: { workspaceId: string; requestId: string; action: string }): AgentXError {
  const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? [];
  const codes = reasons.map((reason) => reason.Code ?? "None");
  console.log(JSON.stringify({ component: "broker", event: "pull_request.acceptance_cancelled", action: context.action,
    workspaceId: context.workspaceId, requestId: context.requestId,
    items: codes.map((code, index) => ({ item: index < ACCEPTANCE_OWN_ITEMS.length ? ACCEPTANCE_OWN_ITEMS[index] : `extra-${index - ACCEPTANCE_OWN_ITEMS.length}`, code })) }));
  const extraCancellation = codes.slice(ACCEPTANCE_OWN_ITEMS.length);
  const ownItemsHeld = codes.length > ACCEPTANCE_OWN_ITEMS.length
    && codes.slice(0, ACCEPTANCE_OWN_ITEMS.length).every((code) => code !== "ConditionalCheckFailed");
  const failedExtras = extraCancellation.flatMap((code, index) => code === "ConditionalCheckFailed" ? [index] : []);
  if (ownItemsHeld && failedExtras.length > 0) {
    return Object.assign(agentXError("CONFIG_INVALID",
      `the records this request depends on changed while it was being accepted (extra item${failedExtras.length === 1 ? "" : "s"} ${failedExtras.join(", ")} failed its condition); the workspace itself was free`), { extraCancellation });
  }
  return Object.assign(agentXError("WORKSPACE_BUSY", "workspace already has an active writer"), { extraCancellation });
}

export async function acceptPullRequest(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspaceId: string,
  value: unknown,
  extra: ExtraItems = () => [],
  options: { workflowCandidate?: { repositoryId: string; treeSha: string; commitSha?: string; candidateDigest: string; baseCommitSha?: string; publicationMode: "COMMITTED_HEAD" | "CHECKED_TREE"; admittedPinnedRevision: number; admittedLatestRevision: number; admittedMaterialDigest: string; admittedWorkflowRevision: number; admittedPlanArtifact: { id: string; type: string; version: number; objectKey: string; sha256: string; format: "markdown" | "structured" }; admittedOwnerApproval: { requestId: string; workflowRevision: number; actorId: string; actorRole: "TASK_OWNER" | "PROJECT_ADMIN"; artifactDigest: string; workBreakdownDigest: string | null; at: string }; admittedWorkflowAuthorityDigest: string }; attribution?: ResolvedAttribution } = {},
): Promise<{ operation: Operation; duplicate: boolean }> {
  const request = PullRequestRequestSchema.parse(value);
  // Ruling R60: before any access check, so a removed creator's task says why instead of "project not found".
  await requireWorkspaceCreatorStillMember(creatorCheckOf(dependencies), workspaceId);
  const workspace = await requireOwnedWorkspace(dependencies, identity, workspaceId);
  await requireSlackRequesterMayWork(dependencies, identity, workspace.projectName);
  await requireProjectAuthority(dependencies, requireOrgId(identity.orgId), identity.ownerKey, workspace.projectName, { taskCreator: () => workspaceTaskOwner(dependencies, workspace.id) });
  const candidate = options.workflowCandidate;
  if (candidate !== undefined && (candidate.repositoryId !== request.repository || !/^[a-f0-9]{40}$/.test(candidate.treeSha)
    || (candidate.commitSha !== undefined && !/^[a-f0-9]{40}$/.test(candidate.commitSha))
    || (candidate.publicationMode === "COMMITTED_HEAD" && candidate.commitSha === undefined)
    || (candidate.publicationMode === "CHECKED_TREE" && candidate.commitSha !== undefined)
    || !/^[a-f0-9]{64}$/.test(candidate.candidateDigest) || (candidate.baseCommitSha !== undefined && !/^[a-f0-9]{40}$/.test(candidate.baseCommitSha))
    || candidate.admittedPinnedRevision !== workspace.projectRevision || candidate.admittedLatestRevision < candidate.admittedPinnedRevision
    || !/^[a-f0-9]{64}$/.test(candidate.admittedMaterialDigest) || !Number.isInteger(candidate.admittedWorkflowRevision)
    || candidate.admittedWorkflowRevision < 1 || candidate.admittedPlanArtifact.sha256.length !== 64
    || candidate.admittedPlanArtifact.sha256 !== candidate.admittedOwnerApproval.artifactDigest
    || !/^[a-f0-9]{64}$/.test(candidate.admittedWorkflowAuthorityDigest))) {
    throw agentXError("CONFIG_INVALID", "workflow publication does not match its checked candidate");
  }
  const requestHash = hashJson({
    repository: request.repository,
    title: request.title,
    ...(request.body === undefined ? {} : { body: request.body }),
    ...(request.draft === undefined ? {} : { draft: request.draft }),
    ...(candidate === undefined ? {} : { candidateTreeSha: candidate.treeSha, ...(candidate.commitSha === undefined ? {} : { candidateCommitSha: candidate.commitSha }), ...(candidate.baseCommitSha === undefined ? {} : { candidateBaseCommitSha: candidate.baseCommitSha }), candidateDigest: candidate.candidateDigest, publicationMode: candidate.publicationMode, admittedPinnedRevision: candidate.admittedPinnedRevision, admittedLatestRevision: candidate.admittedLatestRevision, admittedMaterialDigest: candidate.admittedMaterialDigest,
      admittedWorkflowRevision: candidate.admittedWorkflowRevision, admittedPlanArtifact: candidate.admittedPlanArtifact, admittedOwnerApproval: candidate.admittedOwnerApproval, admittedWorkflowAuthorityDigest: candidate.admittedWorkflowAuthorityDigest }),
  });
  const idempotencyKey = {
    pk: `IDEMPOTENCY#${identity.ownerKey}#${workspaceId}`,
    sk: `REQUEST#${request.requestId}`,
  };
  const previous = await getItem<{ operationId: string; payloadHash: string }>(dependencies, idempotencyKey);
  if (previous) {
    if (previous.payloadHash !== requestHash) {
      throw agentXError("IDEMPOTENCY_CONFLICT", "request ID was reused with another payload");
    }
    return {
      operation: publicOperation(await requireOperation(dependencies, workspaceId, previous.operationId)),
      duplicate: true,
    };
  }
  // Ruling A: a gated developer task's workspace publishes only through its own checked-tree publication, never a
  // pull request anyone asks for (the owner, a shared thread's teammate, anyone).
  if (candidate === undefined && await gatedTaskWorkspace(dependencies, workspaceId)) {
    throw agentXError("CONFIG_INVALID", GATED_TASK_PULL_REQUEST_REFUSAL);
  }
  if (!['READY', 'STOPPED'].includes(workspace.status) || workspace.activeOperationId) {
    throw agentXError(
      workspace.status === "BUSY" ? "WORKSPACE_BUSY" : "WORKSPACE_NOT_READY",
      `workspace is ${workspace.status}`,
    );
  }
  const { project, settingsRevision } = await publicationProject(dependencies, workspace);
  const repository = codeRepositoriesOf(project.definition).find((candidate) => candidate.name === request.repository);
  if (!repository) throw agentXError("CONFIG_INVALID", "repository is not registered for this project");
  // P10: a workflow publication is accepted for any host the repository's record names; an unknown host kind is refused with the router's sentence, before the idempotency row is written, the
  // workspace claimed, the push sent or its grant issued.
  if (candidate !== undefined) hostOfRepository(dependencies, repository);
  const body = await attributedBody(dependencies, identity, request.body);
  const draft = candidate === undefined ? request.draft : true;

  const now = new Date().toISOString();
  const operationId = randomUUID();
  const fence = workspace.fence + 1;
  const headBranch = `agentx/${operationId}`;
  const operation = operationRecord({
    ...operationOrg(workspace),
    id: operationId,
    workspaceId,
    kind: "publish",
    requestId: request.requestId,
    payloadHash: requestHash,
    status: "ACCEPTED",
    fence,
    createdAt: now,
    updatedAt: now,
    ...requesterOf(identity),
  });
  operation.settingsRevision = settingsRevision;
  operation.publication = {
    repository: repository.name,
    repositoryUrl: repository.url,
    headBranch,
    baseBranch: repository.defaultBranch,
    title: request.title,
    codeBuildGates: repository.codeBuildGates ?? [],
    ...(body === undefined ? {} : { body }),
    ...(draft === undefined ? {} : { draft }),
    ...(candidate === undefined ? {} : { expectedTreeSha: candidate.treeSha, ...(candidate.commitSha === undefined ? {} : { expectedCommitSha: candidate.commitSha }), candidateDigest: candidate.candidateDigest, publicationMode: candidate.publicationMode,
      admittedPinnedRevision: candidate.admittedPinnedRevision, admittedLatestRevision: candidate.admittedLatestRevision, admittedMaterialDigest: candidate.admittedMaterialDigest,
      admittedWorkflowRevision: candidate.admittedWorkflowRevision, admittedPlanArtifact: candidate.admittedPlanArtifact, admittedOwnerApproval: candidate.admittedOwnerApproval,
      admittedWorkflowAuthorityDigest: candidate.admittedWorkflowAuthorityDigest }),
    ...(candidate?.baseCommitSha === undefined ? {} : { expectedBaseCommit: candidate.baseCommitSha }),
    // I3: whose change this is, for the audit event the opening records (the full ids; the host sees only names and a random reference).
    ...(options.attribution === undefined || options.attribution.relatedIds.length === 0 ? {} : { relatedIds: [...options.attribution.relatedIds] }),
  };
  const invocation: WorkerInvocation = {
    protocolVersion: 1,
    kind: "publish",
    operationId,
    workspaceId,
    fence,
    projectRevision: workspace.projectRevision,
    callbackCapability: issueCapability(dependencies, workspaceId, operationId, fence, { pullRequest: true }),
    payload: {
      mode: "create",
      project: workerProjectDefinition(project.definition),
      repository: repository.name,
      title: request.title,
      ...(body === undefined ? {} : { body }),
      headBranch,
      repositoryGrant: issueRepositoryGrant(
        dependencies,
        project,
        identity.ownerKey,
        workspaceId,
        operationId,
        "push",
        repository.name,
      ),
      // Spec 051 P-2: a failing check opens a draft (reconcilePullRequest) rather than refusing the publication.
      // Without readiness there is no check to report, and the worker need not be asked whether it can.
      ...(project.definition.readiness.length === 0 ? {} : { reportChecks: true as const }),
      // The tree the checks and reviews passed on: the worker publishes exactly it, or refuses before pushing.
      ...(candidate === undefined ? {} : { candidateTreeSha: candidate.treeSha }),
      ...(candidate === undefined ? {} : { candidateCommitSha: candidate.commitSha }),
      ...(candidate === undefined ? {} : { publicationMode: candidate.publicationMode }),
      // The task's pinned base, as the published commit's parent, in place of the workspace's own record of it.
      ...(candidate?.baseCommitSha === undefined ? {} : { workflowBaseCommit: candidate.baseCommitSha }),
      // I3: sent only to a worker that lists "publish.attribution"; ec2-delivery drops it for an older worker, which publishes as before (no trailer) with the description the broker wrote.
      ...(options.attribution === undefined ? {} : { attribution: options.attribution.attribution }),
    },
  };
  const publicationContext = workflowPublicationContext(invocation);
  if (publicationContext !== undefined && invocation.kind === "publish") {
    const publicationContextDigest = workflowPublicationContextDigest(publicationContext);
    invocation.payload.publicationContextDigest = publicationContextDigest;
    operation.publication.publicationContextDigest = publicationContextDigest;
  }
  const outbox = outboxRecord(workspace, invocation);
  // I3: the operation says which outbox item carries its description and attribution, so erasing a person can rewrite that copy too.
  if (options.attribution !== undefined) operation.publication.outboxId = outbox.id;
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: dependencies.tableName,
        Key: workspaceKey(workspaceId),
        UpdateExpression: "SET #status = :busy, activeOperationId = :operation, fence = :fence, updatedAt = :now",
        ConditionExpression: "ownerKey = :owner AND attribute_not_exists(activeOperationId) AND (#status = :ready OR #status = :stopped)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":owner": identity.ownerKey,
          ":busy": "BUSY",
          ":ready": "READY",
          ":stopped": "STOPPED",
          ":operation": operationId,
          ":fence": fence,
          ":now": now,
        },
      } },
      { Put: { TableName: dependencies.tableName, Item: operation, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: dependencies.tableName, Item: outbox, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: {
        TableName: dependencies.tableName,
        Item: { ...idempotencyKey, entityType: "IDEMPOTENCY", operationId, payloadHash: requestHash },
        ConditionExpression: "attribute_not_exists(pk)",
      } },
      ...extra(publicOperation(operation)),
    ] }));
  } catch (error) {
    if (isConditional(error)) {
      const concurrent = await getItem<{ operationId: string; payloadHash: string }>(dependencies, idempotencyKey);
      if (concurrent) {
        if (concurrent.payloadHash !== requestHash) {
          throw agentXError("IDEMPOTENCY_CONFLICT", "request ID was reused with another payload");
        }
        return {
          operation: publicOperation(await requireOperation(dependencies, workspaceId, concurrent.operationId)),
          duplicate: true,
        };
      }
      throw acceptancePullRequestCancellation(error, { workspaceId, requestId: request.requestId, action: "publish" });
    }
    throw error;
  }
  return { operation: publicOperation(operation), duplicate: false };
}

export async function acceptPullRequestLifecycle(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspaceId: string,
  value: unknown,
  // C13: a continue thread's marker naming the teammate, as tasks and pull requests write (final review M2).
  extra: ExtraItems = () => [],
  /**
   * A workflow task's own push of a fix whose checks and reviews passed to its existing pull request: only an append, of
   * exactly the reviewed tree on the task's pinned base, onto the head the workflow recorded. Only the broker's own
   * dispatch passes it; nothing a person asks for changes a workflow task's pull request.
   */
  options: {
    workflowCandidate?: { candidateDigest: string; treeSha: string; baseCommitSha: string; expectedHeadCommit: string; fixSource?: WorkflowFixPayload["source"]; mergeBaseCommit?: string };
    /**
     * Plan 6 Task 17: a workflow task's merge of the base branch into its pull request's branch: only a sync, of exactly the base commit named, onto the head the workflow recorded. Only the broker's
     * own dispatch passes it.
     */
    workflowSync?: { baseCommit: string; expectedHeadCommit: string };
    /**
     * "Continue in your own tool" (owner Q13): a read-only adoption of a pull request head pushed outside Rovara, asked for by a person's Recheck: only a sync whose worker checks out exactly
     * `headCommit`, which GitHub must show as the head now, on a pull request whose record still holds `previousHeadCommit` (Rovara's own last head). The grant is a clone grant: it cannot push.
     */
    workflowAdopt?: { headCommit: string; previousHeadCommit: string };
  } = {},
): Promise<{ operation: Operation; duplicate: boolean }> {
  const request = PullRequestLifecycleRequestSchema.parse(value);
  // Ruling R60: before any access check, as for acceptPullRequest.
  await requireWorkspaceCreatorStillMember(creatorCheckOf(dependencies), workspaceId);
  const workspace = await requireOwnedWorkspace(dependencies, identity, workspaceId);
  await requireSlackRequesterMayWork(dependencies, identity, workspace.projectName);
  await requireProjectAuthority(dependencies, requireOrgId(identity.orgId), identity.ownerKey, workspace.projectName, { taskCreator: () => workspaceTaskOwner(dependencies, workspace.id) });
  const candidate = options.workflowCandidate;
  const branchSync = options.workflowSync;
  if (candidate !== undefined && (request.action !== "append" || !/^[a-f0-9]{64}$/.test(candidate.candidateDigest)
    || !/^[a-f0-9]{40}$/.test(candidate.treeSha) || !/^[a-f0-9]{40}$/.test(candidate.baseCommitSha) || !/^[a-f0-9]{40}$/.test(candidate.expectedHeadCommit)
    || (candidate.mergeBaseCommit !== undefined && !/^[a-f0-9]{40}$/.test(candidate.mergeBaseCommit)))) {
    throw agentXError("CONFIG_INVALID", "workflow pull request update does not match its reviewed fix");
  }
  if (branchSync !== undefined && (candidate !== undefined || request.action !== "sync" || !/^[a-f0-9]{40}$/.test(branchSync.baseCommit) || !/^[a-f0-9]{40}$/.test(branchSync.expectedHeadCommit))) {
    throw agentXError("CONFIG_INVALID", "workflow merge of the base branch does not match its request");
  }
  const adopt = options.workflowAdopt;
  if (adopt !== undefined && (candidate !== undefined || branchSync !== undefined || request.action !== "sync" || !/^[a-f0-9]{40}$/.test(adopt.headCommit) || !/^[a-f0-9]{40}$/.test(adopt.previousHeadCommit)
    || adopt.headCommit === adopt.previousHeadCommit)) {
    throw agentXError("CONFIG_INVALID", "workflow adoption of an outside head does not match its request");
  }
  // The head the workflow recorded, for either kind of change the workflow makes to its own pull request (an adoption: the head Rovara recorded before the outside push).
  const workflowHead = candidate?.expectedHeadCommit ?? branchSync?.expectedHeadCommit ?? adopt?.previousHeadCommit;
  const workflowBound = workflowHead !== undefined;
  const requestHash = hashJson({
    repository: request.repository,
    pullRequestNumber: request.pullRequestNumber,
    action: request.action,
    ...(request.title === undefined ? {} : { title: request.title }),
    ...(request.body === undefined ? {} : { body: request.body }),
    ...(candidate === undefined ? {} : { candidateDigest: candidate.candidateDigest, candidateTreeSha: candidate.treeSha, ...(candidate.mergeBaseCommit === undefined ? {} : { mergeBaseCommit: candidate.mergeBaseCommit }) }),
    ...(branchSync === undefined ? {} : { branchSyncBase: branchSync.baseCommit, branchSyncHead: branchSync.expectedHeadCommit }),
    ...(adopt === undefined ? {} : { adoptHead: adopt.headCommit, adoptPrevious: adopt.previousHeadCommit }),
  });
  const idempotencyKey = {
    pk: `IDEMPOTENCY#${identity.ownerKey}#${workspaceId}`,
    sk: `REQUEST#${request.requestId}`,
  };
  const previous = await getItem<{ operationId: string; payloadHash: string }>(dependencies, idempotencyKey);
  if (previous) {
    if (previous.payloadHash !== requestHash) {
      throw agentXError("IDEMPOTENCY_CONFLICT", "request ID was reused with another payload");
    }
    return { operation: publicOperation(await requireOperation(dependencies, workspaceId, previous.operationId)), duplicate: true };
  }
  // Ruling A: nothing replaces, reverts, edits, closes or reopens a gated task's pull request through AgentX on request.
  // The workflow's own push of its reviewed fix is the one change it makes, and only its dispatch asks for it.
  if (!workflowBound && await gatedTaskWorkspace(dependencies, workspaceId)) throw agentXError("CONFIG_INVALID", GATED_TASK_PULL_REQUEST_ACTION_REFUSAL);
  const { project, settingsRevision } = await publicationProject(dependencies, workspace);
  const repository = codeRepositoriesOf(project.definition).find((candidate) => candidate.name === request.repository);
  if (!repository) throw agentXError("CONFIG_INVALID", "repository is not registered for this project");
  const existingRecord = await getItem<PullRequestRecord>(
    dependencies,
    pullRequestKey(workspaceId, request.repository, request.pullRequestNumber),
  );
  // The workflow's pull request was recorded when AgentX opened it, on the head the workflow recorded too.
  if (workflowBound && existingRecord?.expectedHeadCommit !== workflowHead) {
    throw agentXError("STALE_FENCE", "the pull request's recorded head is not the one the task recorded");
  }
  const scope = await githubScopeOf(dependencies, workspace);
  // P5d: the pull request is read and changed through the code host the repository's record names (an unknown kind is refused with the router's fixed sentence).
  const host = hostOfRepository(dependencies, repository);
  // The workflow's own push of a fix or merge of the base is handled by GitHub-only code once the worker has pushed (the linked-pull-request rows are GitHub's, left for P6): refused here, before the
  // pull request is read, an operation is claimed or the worker is sent to push, on any host that is not GitHub.
  if (workflowBound) requireGithubHost(host);
  const ref = changeRequestRef(repository.url, request.pullRequestNumber);
  const remote = pullRequestDetailsOf(await host.getChangeRequest(ref, scope));
  const record = existingRecord ?? await adoptLegacyPullRequest(
    dependencies,
    workspaceId,
    repository.name,
    repository.url,
    remote,
  );
  if (record.repositoryUrl !== repository.url) throw agentXError("FORBIDDEN", "pull request repository is outside this project revision");
  if (remote.headBranch !== record.headBranch || remote.baseBranch !== record.baseBranch) {
    throw agentXError("STALE_FENCE", "pull request branch identity changed outside AgentX");
  }
  // An adoption is of the head the person saw: GitHub must show exactly it now (the fence when the run starts); any other change is refused if the head moved.
  if (remote.headCommit !== (adopt?.headCommit ?? record.expectedHeadCommit)) {
    throw agentXError("STALE_FENCE", adopt === undefined ? "pull request head changed outside AgentX; reconcile it before retrying" : "the pull request changed again since the re-check was asked for");
  }
  // An adoption's branch (read from Git) must be at the head too: GitHub moves a pull request's head a moment after a push, and a push that just landed must not be adopted past.
  if (adopt !== undefined && canReadBranchAndTree(dependencies, host) && await host.branchHead(repositoryRefOf(repository.url), record.headBranch, scope) !== adopt.headCommit) {
    throw agentXError("STALE_FENCE", "the pull request changed again since the re-check was asked for");
  }

  const now = new Date().toISOString();
  const operationId = randomUUID();
  if (request.action === "edit" || request.action === "close" || request.action === "reopen") {
    if (request.action === "edit" && remote.state === "merged") {
      throw agentXError("CONFIG_INVALID", "merged pull request metadata is immutable through AgentX");
    }
    if (request.action === "close" && remote.state !== "open") {
      throw agentXError("CONFIG_INVALID", "only an open pull request can be closed");
    }
    if (request.action === "reopen" && remote.state !== "closed") {
      throw agentXError("CONFIG_INVALID", "only a closed, unmerged pull request can be reopened");
    }
    // The port's update returns nothing, so the pull request is read again: the stored record and the answer carry what the host holds after the change.
    await host.updateChangeRequest(changeRequestRef(record.repositoryUrl, record.number), {
      ...(request.title === undefined ? {} : { title: request.title }),
      ...(request.body === undefined
        ? {}
        : { body: (await attributedBody(dependencies, identity, request.body)) ?? request.body }),
      ...(request.action === "close" ? { state: "closed" as const } : {}),
      ...(request.action === "reopen" ? { state: "open" as const } : {}),
    }, scope);
    const updated = pullRequestDetailsOf(await host.getChangeRequest(changeRequestRef(record.repositoryUrl, record.number), scope));
    const result: PullRequestLifecycleResult = PullRequestLifecycleResultSchema.parse({
      action: request.action,
      repository: record.repository,
      number: record.number,
      url: updated.url,
      state: updated.state,
      headBranch: record.headBranch,
      baseBranch: record.baseBranch,
      commit: updated.headCommit,
      checks: [],
      reconciled: false,
    });
    const operation = operationRecord({
      ...operationOrg(workspace),
      id: operationId, workspaceId, kind: "maintain", requestId: request.requestId,
      payloadHash: requestHash, status: "SUCCEEDED", fence: workspace.fence,
      createdAt: now, updatedAt: now, result,
      ...requesterOf(identity),
    });
    const updatedRecord: PullRequestRecord = {
      ...record,
      state: updated.state,
      expectedHeadCommit: updated.headCommit,
      title: updated.title,
      body: updated.body,
      updatedAt: now,
    };
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: dependencies.tableName, Item: operation, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: dependencies.tableName, Item: updatedRecord } },
      { Put: {
        TableName: dependencies.tableName,
        Item: { ...idempotencyKey, entityType: "IDEMPOTENCY", operationId, payloadHash: requestHash },
        ConditionExpression: "attribute_not_exists(pk)",
      } },
      ...extra(publicOperation(operation)),
    ] }));
    return { operation: publicOperation(operation), duplicate: false };
  }

  if (request.action === "replace" || request.action === "revert") {
    if (request.action === "replace" && remote.state !== "open") {
      throw agentXError("CONFIG_INVALID", "only an open pull request can be replaced");
    }
    if (request.action === "revert" && (remote.state !== "merged" || !remote.mergeCommit)) {
      throw agentXError("CONFIG_INVALID", "only a merged pull request with a merge commit can be reverted");
    }
    if (!['READY', 'STOPPED'].includes(workspace.status) || workspace.activeOperationId) {
      throw agentXError(workspace.status === "BUSY" ? "WORKSPACE_BUSY" : "WORKSPACE_NOT_READY", `workspace is ${workspace.status}`);
    }
    const fence = workspace.fence + 1;
    const title = request.title ?? `${request.action === "replace" ? "Replace" : "Revert"}: ${remote.title}`;
    const baseBody = request.body ?? (request.action === "replace"
      ? `Clean replacement for #${record.number}.`
      : `Reverts merged pull request #${record.number}.`);
    const body = (await attributedBody(dependencies, identity, baseBody)) ?? baseBody;
    const headBranch = `agentx/${operationId}`;
    const operation = operationRecord({
      ...operationOrg(workspace),
      id: operationId, workspaceId, kind: "publish", requestId: request.requestId,
      payloadHash: requestHash, status: "ACCEPTED", fence, createdAt: now, updatedAt: now,
      ...requesterOf(identity),
    });
    operation.settingsRevision = settingsRevision;
    operation.publication = {
      repository: record.repository,
      repositoryUrl: record.repositoryUrl,
      headBranch,
      baseBranch: record.baseBranch,
      title,
      body,
      codeBuildGates: repository.codeBuildGates ?? [],
      mode: request.action,
      targetPullRequestNumber: record.number,
      ...(remote.mergeCommit === undefined ? {} : { revertCommit: remote.mergeCommit }),
    };
    const invocation: WorkerInvocation = {
      protocolVersion: 1,
      kind: "publish",
      operationId,
      workspaceId,
      fence,
      projectRevision: workspace.projectRevision,
      callbackCapability: issueCapability(dependencies, workspaceId, operationId, fence, { pullRequest: true }),
      payload: {
        mode: request.action,
        project: workerProjectDefinition(project.definition),
        repository: record.repository,
        title,
        body,
        headBranch,
        repositoryGrant: issueRepositoryGrant(
          dependencies, project, identity.ownerKey, workspaceId, operationId, "push", record.repository,
        ),
        targetPullRequestNumber: record.number,
        ...(remote.mergeCommit === undefined ? {} : { revertCommit: remote.mergeCommit }),
        // Spec 051 P-2, as for a new pull request.
        ...(project.definition.readiness.length === 0 ? {} : { reportChecks: true as const }),
      },
    };
    const outbox = outboxRecord(workspace, invocation);
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: dependencies.tableName,
        Key: workspaceKey(workspaceId),
        UpdateExpression: "SET #status = :busy, activeOperationId = :operation, fence = :fence, updatedAt = :now",
        ConditionExpression: "ownerKey = :owner AND attribute_not_exists(activeOperationId) AND (#status = :ready OR #status = :stopped)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":owner": identity.ownerKey, ":busy": "BUSY", ":ready": "READY", ":stopped": "STOPPED",
          ":operation": operationId, ":fence": fence, ":now": now,
        },
      } },
      { Put: { TableName: dependencies.tableName, Item: operation, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: dependencies.tableName, Item: outbox, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: {
        TableName: dependencies.tableName,
        Item: { ...idempotencyKey, entityType: "IDEMPOTENCY", operationId, payloadHash: requestHash },
        ConditionExpression: "attribute_not_exists(pk)",
      } },
      ...extra(publicOperation(operation)),
    ] }));
    return { operation: publicOperation(operation), duplicate: false };
  }

  if (request.action !== "append" && request.action !== "sync") {
    throw agentXError("CONFIG_INVALID", "pull request action is not supported");
  }
  // A workflow task's pull request merged or closed on GitHub since AgentX opened it: it changed there, like a moved head.
  if (remote.state !== "open") throw agentXError(workflowBound ? "STALE_FENCE" : "CONFIG_INVALID", "only an open pull request can be maintained");
  if (!['READY', 'STOPPED'].includes(workspace.status) || workspace.activeOperationId) {
    throw agentXError(workspace.status === "BUSY" ? "WORKSPACE_BUSY" : "WORKSPACE_NOT_READY", `workspace is ${workspace.status}`);
  }
  const fence = workspace.fence + 1;
  const operation = operationRecord({
    ...operationOrg(workspace),
    id: operationId, workspaceId, kind: "maintain", requestId: request.requestId,
    payloadHash: requestHash, status: "ACCEPTED", fence, createdAt: now, updatedAt: now,
    ...requesterOf(identity),
  });
  operation.settingsRevision = settingsRevision;
  operation.maintenance = {
    action: request.action,
    repository: record.repository,
    repositoryUrl: record.repositoryUrl,
    pullRequestNumber: record.number,
    headBranch: record.headBranch,
    baseBranch: record.baseBranch,
    expectedHeadCommit: record.expectedHeadCommit,
    codeBuildGates: repository.codeBuildGates ?? [],
    ...(candidate === undefined ? {} : { workflowCandidate: { candidateDigest: candidate.candidateDigest, treeSha: candidate.treeSha, baseCommitSha: candidate.baseCommitSha, ...(candidate.mergeBaseCommit === undefined ? {} : { mergeBaseCommit: candidate.mergeBaseCommit }) } }),
    ...(branchSync === undefined ? {} : { workflowSync: { baseCommit: branchSync.baseCommit, expectedHeadCommit: branchSync.expectedHeadCommit } }),
    ...(adopt === undefined ? {} : { workflowAdopt: { headCommit: adopt.headCommit, previousHeadCommit: adopt.previousHeadCommit } }),
  };
  const invocation: WorkerInvocation = {
    protocolVersion: 1,
    kind: "maintain",
    operationId,
    workspaceId,
    fence,
    projectRevision: workspace.projectRevision,
    callbackCapability: issueCapability(dependencies, workspaceId, operationId, fence, { pullRequest: true }),
    payload: {
      action: request.action,
      project: workerProjectDefinition(project.definition),
      repository: record.repository,
      pullRequestNumber: record.number,
      headBranch: record.headBranch,
      baseBranch: record.baseBranch,
      // An adoption fences on the outside head it checks out; every other change on the head Rovara recorded.
      expectedHeadCommit: adopt?.headCommit ?? record.expectedHeadCommit,
      // An adoption pushes nothing, so its grant is a clone grant: a push with it is refused by the host's credential exchange.
      repositoryGrant: issueRepositoryGrant(
        dependencies, project, identity.ownerKey, workspaceId, operationId, adopt === undefined ? "push" : "clone", record.repository,
      ),
      // The reviewed fix: the worker pushes exactly this tree, built on the pinned base's history, or refuses before pushing.
      ...(candidate === undefined ? {} : { workflowCandidateTreeSha: candidate.treeSha, workflowBaseCommit: candidate.baseCommitSha }),
      // Which fix it is, for its commit's message (Plan 6 Task 15).
      ...(candidate?.fixSource === undefined ? {} : { workflowFix: { source: candidate.fixSource } }),
      // A conflict round's fix is a merge commit of the base commit the merge was tried with; a merge of the base names that commit and the head it is for (Plan 6 Task 17).
      ...(candidate?.mergeBaseCommit === undefined ? {} : { workflowMergeBase: candidate.mergeBaseCommit }),
      ...(branchSync === undefined ? {} : { workflowSync: { baseCommit: branchSync.baseCommit, expectedHeadCommit: branchSync.expectedHeadCommit } }),
      ...(adopt === undefined ? {} : { workflowAdopt: { headCommit: adopt.headCommit } }),
    },
  };
  const outbox = outboxRecord(workspace, invocation);
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: dependencies.tableName,
        Key: workspaceKey(workspaceId),
        UpdateExpression: "SET #status = :busy, activeOperationId = :operation, fence = :fence, updatedAt = :now",
        ConditionExpression: "ownerKey = :owner AND attribute_not_exists(activeOperationId) AND (#status = :ready OR #status = :stopped)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":owner": identity.ownerKey, ":busy": "BUSY", ":ready": "READY", ":stopped": "STOPPED",
          ":operation": operationId, ":fence": fence, ":now": now,
        },
      } },
      { Put: { TableName: dependencies.tableName, Item: operation, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: dependencies.tableName, Item: outbox, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: {
        TableName: dependencies.tableName,
        Item: { ...idempotencyKey, entityType: "IDEMPOTENCY", operationId, payloadHash: requestHash },
        ConditionExpression: "attribute_not_exists(pk)",
      } },
      ...extra(publicOperation(operation)),
    ] }));
  } catch (error) {
    // The workflow's push, as its publication: a concurrent start of the same request is a duplicate, anything else busy.
    if (!workflowBound || !isConditional(error)) throw error;
    const concurrent = await getItem<{ operationId: string; payloadHash: string }>(dependencies, idempotencyKey);
    if (concurrent === undefined) throw acceptancePullRequestCancellation(error, { workspaceId, requestId: request.requestId, action: request.action });
    if (concurrent.payloadHash !== requestHash) throw agentXError("IDEMPOTENCY_CONFLICT", "request ID was reused with another payload");
    return { operation: publicOperation(await requireOperation(dependencies, workspaceId, concurrent.operationId)), duplicate: true };
  }
  return { operation: publicOperation(operation), duplicate: false };
}

export async function acceptCancellation(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspaceId: string,
  targetOperationId: string,
) {
  const workspace = await requireOwnedWorkspace(dependencies, identity, workspaceId);
  const target = await requireOperation(dependencies, workspaceId, targetOperationId);
  if (target.kind === "resume" && target.workflowE2EReadiness?.purpose === "workflow-e2e-readiness"
    && !TERMINAL.has(target.status)) {
    await cancelWorkflowE2EReadiness(dependencies, workspace, target);
    return { operation: publicOperation(await requireOperation(dependencies, workspaceId, targetOperationId)), duplicate: false };
  }
  return requestCancellation(dependencies, workspace, targetOperationId, requesterOf(identity));
}

export async function stopWorkspace(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspaceId: string,
) {
  const workspace = await requireWorkspace(dependencies, workspaceId);
  await requireAdministrator(dependencies, identity, workspace.projectName);
  if (workspace.status !== "READY" || workspace.activeOperationId) {
    throw agentXError("WORKSPACE_BUSY", "cancel or finish active work before stopping compute");
  }
  throw agentXError("RUNTIME_UNAVAILABLE", "manual compute stop is not supported; idle sessions stop automatically");
}

/** Only a coding task is cancelled: stopping a prepare or a publish midway could leave half a clone or push. */
const CANCELLABLE_KINDS: ReadonlySet<string> = new Set(["task"]);

export type TaskCancellation =
  | { outcome: "CANCEL_REQUESTED"; workspaceId: string; targetOperationId: string; cancelOperationId: string }
  // Issue 196: finishedStatus names the final status when the running task had already finished.
  // `stopped`: no run was live, but the planner's automatic second run was waiting to start; the cancel stopped it.
  | { outcome: "NOTHING_RUNNING"; workspaceId?: string; finishedStatus?: OperationStatus; stopped?: "PLAN_REVISION" };

/** Cancels the workspace's running task, if it has one (#126). */
export async function cancelRunningTask(
  dependencies: AwsBrokerDependencies,
  workspace: WorkspaceInstance,
  requester: { requestedBy?: OperationRequester },
  extra: ExtraItems = () => [],
): Promise<TaskCancellation> {
  const targetOperationId = workspace.activeOperationId;
  if (!targetOperationId) {
    await stopQueuedWorkflowE2EReadiness(dependencies, workspace, extra);
    if (await stopQueuedPlanRevision(dependencies, workspace)) return { outcome: "NOTHING_RUNNING", workspaceId: workspace.id, stopped: "PLAN_REVISION" };
    return { outcome: "NOTHING_RUNNING", workspaceId: workspace.id };
  }
  const target = await requireOperation(dependencies, workspace.id, targetOperationId);
  if (target.workflowE2EReadiness?.purpose === "workflow-e2e-readiness" && target.kind === "resume"
    && !TERMINAL.has(target.status)) {
    await cancelWorkflowE2EReadiness(dependencies, workspace, target, extra);
    return { outcome: "NOTHING_RUNNING", workspaceId: workspace.id, finishedStatus: "CANCELLED" };
  }
  if (!CANCELLABLE_KINDS.has(target.kind) || target.status === "CANCEL_REQUESTED") {
    return { outcome: "NOTHING_RUNNING", workspaceId: workspace.id };
  }
  if (TERMINAL.has(target.status)) return { outcome: "NOTHING_RUNNING", workspaceId: workspace.id, finishedStatus: target.status };
  const result = await requestCancellation(dependencies, workspace, targetOperationId, requester, extra);
  // A duplicate here means the task finished before the cancel was recorded.
  if (result.duplicate) return { outcome: "NOTHING_RUNNING", workspaceId: workspace.id, finishedStatus: result.operation.status };
  // 058-stop-close: a step that was only dispatching, its delivery parked until the compute is ready, never reached a worker. Its delivery is withdrawn and the cancel is ended here, as a
  // worker's success would end it (the step cancelled, the workspace free, the workflow step blocked), instead of sending a cancel that has nothing to find.
  if ((target.status === "ACCEPTED" || target.status === "DISPATCHING") && await withdrawParkedDelivery(dependencies.documentClient, dependencies.tableName, workspace.id, targetOperationId)) {
    await recordTerminalResult(dependencies, await requireOperation(dependencies, workspace.id, result.operation.id), { status: "SUCCEEDED", result: { status: "CANCELLED", remainingProcesses: 0, withdrawnBeforeStart: true } });
  }
  return { outcome: "CANCEL_REQUESTED", workspaceId: workspace.id, targetOperationId, cancelOperationId: result.operation.id };
}

/**
 * Plan self-check: between a sent-back planning answer and the start of the planner's automatic second run, planning is RUNNING with no live
 * run (a REPLAN dispatch row waits, longer when the workspace is busy). A cancel then stops that run: the row is deleted and planning is blocked
 * (Retry planning is offered), in one transaction conditional on the same workflow revision, so the run never starts and never spends.
 * True when it stopped one.
 */
async function stopQueuedPlanRevision(dependencies: AwsBrokerDependencies, workspace: WorkspaceInstance): Promise<boolean> {
  const pointer = await getItem<DeveloperTaskPointerRecord>(dependencies, taskPointerKey(workspace.id));
  if (pointer === undefined) return false;
  const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(pointer.taskId));
  const workflow = task?.workflow;
  if (task === undefined || task.closedAt !== undefined || workflow === undefined || workflow.stage !== "PLAN" || workflow.state !== "RUNNING") return false;
  const rowKey = { pk: WORKFLOW_DISPATCH_PK, sk: `${task.taskId}#${workflow.revision}` };
  const row = await getItem<WorkflowDispatchRecord>(dependencies, rowKey);
  if (row === undefined || row.kind !== "REPLAN" || row.taskId !== task.taskId || row.workflowRevision !== workflow.revision) return false;
  const now = new Date().toISOString();
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Delete: { TableName: dependencies.tableName, Key: rowKey, ConditionExpression: "#kind = :replan AND workflowRevision = :revision",
        ExpressionAttributeNames: { "#kind": "kind" }, ExpressionAttributeValues: { ":replan": "REPLAN", ":revision": workflow.revision } } },
      { Update: { TableName: dependencies.tableName, Key: taskKey(task.taskId),
        UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
        ConditionExpression: "attribute_not_exists(closedAt) AND workflow.revision = :revision AND workflow.#stage = :plan AND workflow.#state = :running",
        ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
        ExpressionAttributeValues: { ":workflow": blockWorkflow(workflow, workflowRunEndedReason("PLAN", "CANCELLED"), now), ":now": now,
          ":revision": workflow.revision, ":plan": "PLAN", ":running": "RUNNING" } } },
    ] }));
    return true;
  } catch (error) {
    // The run started (or the task moved) first: the ordinary cancel of a live run is the caller's next answer.
    if (isConditional(error)) return false;
    throw error;
  }
}

/** Stops a verified warm-up in the brief idle interval before recovery can admit its feature round. */
async function stopQueuedWorkflowE2EReadiness(
  dependencies: AwsBrokerDependencies,
  workspace: WorkspaceInstance,
  extra: ExtraItems,
): Promise<void> {
  const pointer = await getItem<DeveloperTaskPointerRecord>(dependencies, taskPointerKey(workspace.id));
  if (pointer === undefined) return;
  const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(pointer.taskId));
  const workflow = task?.workflow;
  if (task === undefined || task.closedAt !== undefined || workflow === undefined || workflow.stage !== "VERIFY"
    || workflow.state !== "WAITING" || workflow.e2e?.required !== true || workflow.candidate === undefined) return;
  const dispatchKey = { pk: "WORKFLOW_DISPATCH", sk: `${task.taskId}#${workflow.revision}` };
  const dispatch = await getItem<WorkflowDispatchRecord>(dependencies, dispatchKey);
  if (dispatch === undefined || dispatch.kind !== "CHECKS" || dispatch.taskId !== task.taskId
    || dispatch.workflowRevision !== workflow.revision || dispatch.candidateDigest !== workflow.candidate.digest
    || dispatch.readinessOperationId === undefined) return;
  const readiness = await getItem<OperationRecord>(dependencies, operationKey(workspace.id, dispatch.readinessOperationId));
  if (readiness?.kind !== "resume" || readiness.workflowE2EReadiness?.purpose !== "workflow-e2e-readiness"
    || readiness.workflowE2EReadiness.taskId !== task.taskId || readiness.workflowE2EReadiness.workflowRevision !== workflow.revision
    || readiness.workflowE2EReadiness.candidateDigest !== workflow.candidate.digest || readiness.status !== "SUCCEEDED"
    || !Number.isInteger(readiness.workflowE2EReadiness.readyGeneration)) return;
  const now = new Date().toISOString();
  await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
    { Delete: { TableName: dependencies.tableName, Key: dispatchKey,
      ConditionExpression: "taskId = :task AND workflowRevision = :revision AND #kind = :checks AND candidateDigest = :candidate AND readinessOperationId = :operation",
      ExpressionAttributeNames: { "#kind": "kind" }, ExpressionAttributeValues: {
        ":task": task.taskId, ":revision": workflow.revision, ":checks": "CHECKS", ":candidate": workflow.candidate.digest,
        ":operation": readiness.id,
      } } },
    { Update: { TableName: dependencies.tableName, Key: taskKey(task.taskId),
      UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
      ConditionExpression: "attribute_not_exists(closedAt) AND workflow.revision = :revision AND workflow.#stage = :verify AND workflow.#state = :waiting AND workflow.e2e.required = :required AND workflow.candidate.digest = :candidate",
      ExpressionAttributeNames: { "#stage": "stage", "#state": "state" }, ExpressionAttributeValues: {
        ":workflow": blockWorkflow(workflow, "E2E compute readiness was stopped; no feature round was admitted.", now),
        ":now": now, ":revision": workflow.revision, ":verify": "VERIFY", ":waiting": "WAITING", ":required": true,
        ":candidate": workflow.candidate.digest,
      } } },
    ...ownerStopRows(dependencies, workflow, now),
    ...extra(publicOperation(readiness)),
  ] }));
}

/** A readiness resume never reaches a worker, so cancel it locally and release its exact lease. */
async function cancelWorkflowE2EReadiness(
  dependencies: AwsBrokerDependencies,
  workspace: WorkspaceInstance,
  operation: OperationRecord,
  extra: ExtraItems = () => [],
): Promise<void> {
  const marker = operation.workflowE2EReadiness!;
  const dispatchKey = { pk: "WORKFLOW_DISPATCH", sk: marker.dispatchSk };
  const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(marker.taskId));
  const workflow = task?.workflow;
  const taskMatches = task !== undefined && task.closedAt === undefined && workflow?.revision === marker.workflowRevision
    && workflow.stage === "VERIFY" && workflow.state === "WAITING" && workflow.candidate?.digest === marker.candidateDigest;
  const now = new Date().toISOString();
  const items: TransactWriteCommandInput["TransactItems"] = [
    { Update: { TableName: dependencies.tableName, Key: operationKey(workspace.id, operation.id),
      UpdateExpression: "SET #status = :cancelled, updatedAt = :now, #result = :result REMOVE workflowE2EReadiness.readyGeneration",
      ConditionExpression: "(#status = :accepted OR #status = :dispatching OR #status = :cancelRequested) AND #kind = :resume AND workspaceId = :workspace AND fence = :fence AND workflowE2EReadiness.purpose = :purpose AND workflowE2EReadiness.outboxId = :outbox",
      ExpressionAttributeNames: { "#status": "status", "#result": "result", "#kind": "kind" }, ExpressionAttributeValues: {
        ":cancelled": "CANCELLED", ":accepted": "ACCEPTED", ":dispatching": "DISPATCHING", ":cancelRequested": "CANCEL_REQUESTED",
        ":resume": "resume", ":workspace": workspace.id, ":fence": operation.fence, ":purpose": "workflow-e2e-readiness", ":outbox": marker.outboxId,
        ":now": now, ":result": { status: "CANCELLED", reason: "E2E compute readiness was cancelled by an authorized owner." },
      } } },
    { Update: { TableName: dependencies.tableName, Key: workspaceKey(workspace.id),
      UpdateExpression: "SET #status = :ready, updatedAt = :now REMOVE activeOperationId",
      ConditionExpression: "#status = :busy AND activeOperationId = :operation AND fence = :fence",
      ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: {
        ":ready": "READY", ":busy": "BUSY", ":now": now, ":operation": operation.id, ":fence": operation.fence,
      } } },
    { Update: { TableName: dependencies.tableName, Key: { pk: `OUTBOX#${marker.outboxId}`, sk: "OUTBOX" },
      UpdateExpression: "SET #status = :delivered, deliveredAt = :now",
      ConditionExpression: "(#status = :pending OR #status = :queued OR #status = :waitingSession OR #status = :waitingAccess) AND operationId = :operation AND workspaceId = :workspace AND workflowE2EReadiness.purpose = :purpose AND workflowE2EReadiness.taskId = :task AND workflowE2EReadiness.workflowRevision = :revision AND workflowE2EReadiness.candidateDigest = :candidate AND workflowE2EReadiness.dispatchSk = :dispatchSk",
      ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: {
        ":delivered": "DELIVERED", ":pending": "PENDING", ":queued": "QUEUED", ":waitingSession": "WAITING_FOR_SESSION",
        ":waitingAccess": "WAITING_FOR_TASK_ACCESS", ":now": now, ":operation": operation.id, ":workspace": workspace.id,
        ":purpose": "workflow-e2e-readiness", ":task": marker.taskId, ":revision": marker.workflowRevision,
        ":candidate": marker.candidateDigest, ":dispatchSk": marker.dispatchSk,
      } } },
    { Delete: { TableName: dependencies.tableName, Key: dispatchKey,
      ConditionExpression: "readinessOperationId = :operation AND workflowRevision = :revision AND candidateDigest = :candidate",
      ExpressionAttributeValues: { ":operation": operation.id, ":revision": marker.workflowRevision, ":candidate": marker.candidateDigest } } },
    ...(taskMatches && workflow !== undefined ? [{ Update: { TableName: dependencies.tableName, Key: taskKey(marker.taskId),
      UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
      ConditionExpression: "attribute_not_exists(closedAt) AND workflow.revision = :revision AND workflow.#stage = :verify AND workflow.#state = :waiting AND workflow.candidate.digest = :candidate",
      ExpressionAttributeNames: { "#stage": "stage", "#state": "state" }, ExpressionAttributeValues: {
        ":workflow": blockWorkflow(workflow, "E2E compute readiness was cancelled; no feature round was admitted.", now),
        ":now": now, ":revision": marker.workflowRevision, ":verify": "VERIFY", ":waiting": "WAITING", ":candidate": marker.candidateDigest,
      } } }] : []),
    ...(taskMatches && workflow !== undefined ? ownerStopRows(dependencies, workflow, now) : []),
    ...extra(publicOperation({ ...operation, status: "CANCELLED", updatedAt: now,
      result: { status: "CANCELLED", reason: "E2E compute readiness was cancelled by an authorized owner." } })),
  ];
  await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
}

/** An administrator cancels any workspace's running task (#126). */
export async function cancelWorkspaceTask(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspaceId: string,
): Promise<TaskCancellation> {
  const workspace = await requireWorkspace(dependencies, workspaceId);
  await requireAdministrator(dependencies, identity, workspace.projectName);
  return cancelRunningTask(dependencies, workspace, {});
}
