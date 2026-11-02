// Part of the broker (split out of ../broker.ts): closing workspaces, admitting Slack work, thread workspaces and their preparation.

import { approvalGrantChange } from "../../org/approval-membership.js";
import { randomUUID } from "node:crypto";
import { PutCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { AgentXError, plainPageRefs, githubConnectorOf, SlackTaskAnswerRequestSchema, SlackThreadNoteAnsweredRequestSchema, SlackCommentAnsweredRequestSchema, WorkspaceClosePreflightResultSchema, WorkspaceInstanceSchema, agentXError, parseSlackThreadSubject, unhandledDeploymentMode, type OperationRequester, type ProjectDefinition, type SlackRequester, type SlackThread, type SlackThreadPrepareResult, type SlackThreadWorkspaceResult, type SlackWorkspaceCloseCompleteResult, type SlackWorkspaceCloseStartResult, type ThreadConnector, type WorkerInvocation, type WorkspaceInstance, emailSafeName, defaultWorkspaceKey, slackMemberLimitKey, slackOrganizationLimitKey, type OrgId, INDEX_EXPIRY_ATTRIBUTE, indexExpiresAt, workerProjectDefinition, ROVARA_CODE_AGENT_ID, type Payer } from "@agentx/contracts";
import type { AuthenticatedIdentity } from "../../auth.js";
import { authorizeWorkspace } from "../../authorization.js";
import { resolveConnectors, type ResolvedConnector } from "../connector-types.js";
import { DeveloperSignInStore } from "../../developer/store.js";
import { requireRepositoriesConnected } from "../../org/github-connection.js";
import { isPageRefusal, writeCommentAnswer } from "../../developer/page-comments.js";
import { loadWorkflowDocument } from "../../developer/plan-artifacts.js";
import { ROVARA_STATUS_START } from "../../developer/pull-request-feedback-section.js";
import { requireOrgId } from "../../org/resolve.js";
import { requireProject } from "../project-records.js";
import { getItem, issueCapability, operationKey, operationOrg, operationRecord, outboxRecord, publicOperation, requireOperation, type OperationRecord } from "../cancellation.js";
import { requireNewWorkAllowed, viewerCannotStartTasksMessage } from "../../developer/project-roles.js";
import { developerFooter, taskKey, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { readWorkspaceLimits } from "../../developer/limits.js";
import { hashJson, isConditional } from "../broker-shared.js";
import { admitWork } from "../../spend/admission.js";
import { githubLoginOf, personNameForText } from "../../developer/requester-text.js";
import type { ExtraItems, TransactItems } from "../developer-task-actions.js";
import { releaseFinishedTasksOf, markWorkflowThreadNoteAnswered, taskCommentSection, taskOwnsThread, workflowTaskAnswerContext } from "../developer-tasks.js";
import { askContext } from "../../agent-sessions/ask-context.js";
import { ASK_RATE_TEXT, recordSlackAsk, slackAskerKey, takeSlackAskRates } from "../../agent-sessions/ask.js";
import { publicWorkspace } from "../../workspaces.js";
import { taskAccessFence } from "../../developer/task-people.js";
import { closeReleasesStorage, issueRepositoryGrant, object, uuid, workspaceItem, workspaceKey, workspaceRuntime } from "./admin-and-helpers.js";
import type { AwsBrokerDependencies, RegisteredProjectRecord, SlackServiceConfiguration } from "./definitions.js";
import { developerTaskActions, repositoryGateOf } from "./dependency-wiring.js";
import { ROVARA_CODE_NAME, linkedRequester, slackWorkPayment } from "./model-access.js";
import { EARLIER_PLAN_MAX_BYTES, readObjectText } from "./plan-answers.js";
import { developerRequested, getDefaultWorkspace, getMembership, getThreadWorkspace, requireLatestProject, requireWorkspace } from "./records.js";
import { resolveSlackThreadKey } from "./scope-helpers.js";
import { registriesPrepareOf } from "./registry-credentials.js";
import { MEMBERSHIP_PREPARATION_ATTEMPTS, membershipMovedSince, membershipPreparationItem, newWorkspacePreparation, metaPrepareOf, requireSlackRequesterMayWork, slackRequesterRole } from "./workspace-preparation.js";
import { connectorTypeContext } from "./workspace-routes.js";
import { OUTCOME_SETTLE_PASS_MS, releaseDependenciesOf } from "./terminal-and-github-events.js";

/** The close preflight's operation, worker invocation and outbox item: the Slack close's and a developer task's. */
function closeOperationParts(
  dependencies: AwsBrokerDependencies,
  workspace: WorkspaceInstance,
  requestId: string,
  requester: { requestedBy?: OperationRequester },
  now: string,
  discardUnpublished = false,
): { operation: OperationRecord; outbox: ReturnType<typeof outboxRecord>; fence: number } {
  const operationId = randomUUID();
  const fence = workspace.fence + 1;
  const operation = operationRecord({
    ...operationOrg(workspace),
    id: operationId,
    workspaceId: workspace.id,
    kind: "close",
    requestId,
    payloadHash: hashJson({ action: "close", workspaceId: workspace.id, discardUnpublished }),
    status: "ACCEPTED",
    fence,
    createdAt: now,
    updatedAt: now,
    ...requester,
  });
  if (discardUnpublished) operation.discardUnpublished = true;
  if (workspace.status === "READY" || workspace.status === "STOPPED") operation.closePreviousStatus = workspace.status;
  const invocation: WorkerInvocation = {
    protocolVersion: 1,
    kind: "close",
    operationId,
    workspaceId: workspace.id,
    fence,
    projectRevision: workspace.projectRevision,
    callbackCapability: issueCapability(dependencies, workspace.id, operationId, fence),
    payload: {},
  };
  return { operation, outbox: outboxRecord(workspace, invocation), fence };
}

export async function startThreadWorkspaceClose(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  value: unknown,
): Promise<SlackWorkspaceCloseStartResult> {
  if (!identity.slack) throw agentXError("FORBIDDEN", "a Slack thread identity is required");
  const input = object(value, "thread workspace close request");
  // C11: only the developer closes a shared task, from their AI tool.
  if (identity.sharedTask !== undefined) {
    if (input.includeSharedTask === true) return { outcome: "REFUSED", reason: "shared_task" };
    throw agentXError("FORBIDDEN", SHARED_CLOSE_REFUSED);
  }
  const requestId = uuid(input.requestId, "requestId");
  if (input.discard_unpublished !== undefined && typeof input.discard_unpublished !== "boolean") {
    throw agentXError("CONFIG_INVALID", "discard_unpublished must be a boolean");
  }
  const discardUnpublished = input.discard_unpublished === true;
  const workspace = await getThreadWorkspace(dependencies, requireOrgId(identity.orgId), identity.ownerKey);
  if (!workspace) return { outcome: "NOT_FOUND" };
  if (discardUnpublished) {
    const thread = await getItem<{ starterUserId?: unknown }>(dependencies, await resolveSlackThreadKey(dependencies, requireOrgId(identity.orgId), identity.ownerKey));
    if (typeof thread?.starterUserId !== "string" || thread.starterUserId !== identity.slack.requester.userId) {
      return { outcome: "REFUSED", reason: "not_owner" };
    }
  }
  // Spec 014: a thread that never needed the worker has no compute, so there is nothing to close.
  if (workspace.status === "UNPREPARED") return { outcome: "NOT_FOUND" };
  // #213: a failed preparation that was released holds no slot and has nothing to check, and a
  // lazy turn was told it has no compute; answered as an UNPREPARED thread is.
  if (workspace.status === "PREPARATION_FAILED" && !workspace.activeOperationId) {
    const thread = await getItem<{ starterUserId?: unknown }>(dependencies, await resolveSlackThreadKey(dependencies, requireOrgId(identity.orgId), identity.ownerKey));
    if (typeof thread?.starterUserId !== "string") return { outcome: "NOT_FOUND" };
  }
  if (workspace.status === "CLOSED" && workspace.closedAt) {
    const closeOperation = workspace.closeOperationId
      ? await requireOperation(dependencies, workspace.id, workspace.closeOperationId)
      : undefined;
    const closePreflight = closeOperation?.kind === "close" && closeOperation.status === "SUCCEEDED"
      ? WorkspaceClosePreflightResultSchema.safeParse(closeOperation.result)
      : undefined;
    return {
      outcome: "CLOSED",
      workspaceId: workspace.id,
      closedAt: workspace.closedAt,
      ...(closeOperation?.kind === "close" && closeOperation.discardUnpublished === true && closePreflight?.success && !closePreflight.data.safeToClose
        ? { discardedUnpublished: true }
        : {}),
    };
  }
  if (workspace.status === "CLOSING" && workspace.closeOperationId) {
    const operation = await requireOperation(dependencies, workspace.id, workspace.closeOperationId);
    return { outcome: "PREFLIGHT", workspaceId: workspace.id, operationId: operation.id, status: operation.status };
  }

  const idempotencyKey = {
    pk: `IDEMPOTENCY#${identity.ownerKey}#CLOSE`,
    sk: `REQUEST#${requestId}`,
  };
  const previous = await getItem<{ operationId: string; workspaceId: string }>(dependencies, idempotencyKey);
  if (previous) {
    const operation = await requireOperation(dependencies, previous.workspaceId, previous.operationId);
    return { outcome: "PREFLIGHT", workspaceId: previous.workspaceId, operationId: operation.id, status: operation.status };
  }
  if ((workspace.status !== "READY" && workspace.status !== "STOPPED") || workspace.activeOperationId) {
    throw agentXError("WORKSPACE_BUSY", `workspace is ${workspace.status}; wait for active work before closing it`);
  }

  const now = new Date().toISOString();
  const { operation, outbox, fence } = closeOperationParts(dependencies, workspace, requestId, requesterOf(identity), now, discardUnpublished);
  const operationId = operation.id;
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: dependencies.tableName,
        Key: workspaceKey(workspace.id),
        UpdateExpression: "SET #status = :closing, activeOperationId = :operation, closeOperationId = :operation, closedBy = :requester, fence = :fence, updatedAt = :now REMOVE closeError",
        ConditionExpression: "ownerKey = :owner AND attribute_not_exists(activeOperationId) AND (#status = :ready OR #status = :stopped)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":owner": identity.ownerKey,
          ":closing": "CLOSING",
          ":ready": "READY",
          ":stopped": "STOPPED",
          ":operation": operationId,
          ":requester": identity.slack.requester,
          ":fence": fence,
          ":now": now,
        },
      } },
      { Put: { TableName: dependencies.tableName, Item: operation, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: dependencies.tableName, Item: outbox, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: {
        TableName: dependencies.tableName,
        Item: { ...idempotencyKey, entityType: "IDEMPOTENCY", operationId, workspaceId: workspace.id },
        ConditionExpression: "attribute_not_exists(pk)",
      } },
    ] }));
  } catch (error) {
    if (!isConditional(error)) throw error;
    const concurrent = await getItem<{ operationId: string; workspaceId: string }>(dependencies, idempotencyKey);
    if (concurrent) {
      const existing = await requireOperation(dependencies, concurrent.workspaceId, concurrent.operationId);
      return { outcome: "PREFLIGHT", workspaceId: concurrent.workspaceId, operationId: existing.id, status: existing.status };
    }
    throw agentXError("WORKSPACE_BUSY", "another operation acquired the workspace before closure");
  }
  return { outcome: "PREFLIGHT", workspaceId: workspace.id, operationId, status: "ACCEPTED" };
}

/**
 * A developer task's close preflight (spec 025): the Slack close's flow, keyed the same way, with
 * no Slack `closedBy`, and with the task's extra items in the same transaction.
 */
export async function startTaskClose(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspace: WorkspaceInstance,
  requestId: string,
  extra: ExtraItems,
  discardUnpublished = false,
): Promise<{ operationId: string; duplicate: boolean }> {
  authorizeWorkspace(identity, workspace);
  if ((workspace.status === "CLOSING" || workspace.status === "CLOSED") && workspace.closeOperationId) {
    return { operationId: workspace.closeOperationId, duplicate: true };
  }
  const idempotencyKey = {
    pk: `IDEMPOTENCY#${identity.ownerKey}#CLOSE`,
    sk: `REQUEST#${requestId}`,
  };
  const previous = await getItem<{ operationId: string }>(dependencies, idempotencyKey);
  if (previous) return { operationId: previous.operationId, duplicate: true };
  if ((workspace.status !== "READY" && workspace.status !== "STOPPED") || workspace.activeOperationId) {
    throw agentXError("WORKSPACE_BUSY", `workspace is ${workspace.status}; wait for active work before closing it`);
  }
  const now = new Date().toISOString();
  const { operation, outbox, fence } = closeOperationParts(dependencies, workspace, requestId, requesterOf(identity), now, discardUnpublished);
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: dependencies.tableName,
        Key: workspaceKey(workspace.id),
        UpdateExpression: "SET #status = :closing, activeOperationId = :operation, closeOperationId = :operation, fence = :fence, updatedAt = :now REMOVE closeError",
        ConditionExpression: "ownerKey = :owner AND attribute_not_exists(activeOperationId) AND (#status = :ready OR #status = :stopped)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":owner": identity.ownerKey,
          ":closing": "CLOSING",
          ":ready": "READY",
          ":stopped": "STOPPED",
          ":operation": operation.id,
          ":fence": fence,
          ":now": now,
        },
      } },
      { Put: { TableName: dependencies.tableName, Item: operation, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: dependencies.tableName, Item: outbox, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: {
        TableName: dependencies.tableName,
        Item: { ...idempotencyKey, entityType: "IDEMPOTENCY", operationId: operation.id, workspaceId: workspace.id },
        ConditionExpression: "attribute_not_exists(pk)",
      } },
      ...extra(publicOperation(operation)),
    ] }));
  } catch (error) {
    if (!isConditional(error)) throw error;
    const concurrent = await getItem<{ operationId: string }>(dependencies, idempotencyKey);
    if (concurrent) return { operationId: concurrent.operationId, duplicate: true };
    throw agentXError("WORKSPACE_BUSY", "another operation acquired the workspace before closure");
  }
  return { operationId: operation.id, duplicate: false };
}

/** Deletes a workspace's compute and storage by its deployment mode; the one place that switch lives (FR-024). */
export async function deleteWorkspaceCompute(dependencies: AwsBrokerDependencies, workspace: WorkspaceInstance): Promise<void> {
  switch (workspace.deploymentMode) {
    case "instances-ebs":
    case "demo-microvm":
      throw agentXError("RUNTIME_UNAVAILABLE", "retired workspace storage cannot be managed");
    case "ec2-ebs":
      // The session deleter terminates the instance and deletes the volume; without it, refuse
      // rather than mark the workspace CLOSED and leak the volume.
      if (dependencies.deleteEc2Session === undefined) {
        throw agentXError("RUNTIME_UNAVAILABLE", "this control plane cannot delete ec2-ebs workspace storage");
      }
      try {
        await dependencies.deleteEc2Session(workspace.id);
      } catch (error) {
        // Compute that is starting or stopping refuses with WORKSPACE_BUSY; the close is retried.
        if (error instanceof AgentXError) throw error;
        throw agentXError("RUNTIME_UNAVAILABLE", "workspace resource cleanup failed; retry the close request");
      }
      break;
    default:
      unhandledDeploymentMode(workspace);
  }
}

export async function completeThreadWorkspaceClose(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  value: unknown,
): Promise<SlackWorkspaceCloseCompleteResult> {
  const slack = identity.slack;
  if (!slack) throw agentXError("FORBIDDEN", "a Slack thread identity is required");
  const input = object(value, "thread workspace close completion");
  if (identity.sharedTask !== undefined) throw agentXError("FORBIDDEN", SHARED_CLOSE_REFUSED);
  uuid(input.requestId, "requestId");
  const operationId = uuid(input.operationId, "operationId");
  const workspace = await getThreadWorkspace(dependencies, requireOrgId(identity.orgId), identity.ownerKey);
  if (!workspace) throw agentXError("NOT_FOUND", "thread workspace not found");
  const operation = await requireOperation(dependencies, workspace.id, operationId);
  if (operation.kind !== "close") throw agentXError("CONFIG_INVALID", "operation is not a workspace close");
  const preflight = operation.status === "SUCCEEDED" ? WorkspaceClosePreflightResultSchema.safeParse(operation.result) : undefined;
  const discardedUnpublished = operation.discardUnpublished === true && preflight?.success === true && !preflight.data.safeToClose;
  if (workspace.status === "CLOSED" && workspace.closedAt && workspace.closeOperationId === operationId) {
    return {
      outcome: "CLOSED",
      workspaceId: workspace.id,
      operationId,
      closedAt: workspace.closedAt,
      storageReleased: closeReleasesStorage(workspace),
      ...(discardedUnpublished ? { discardedUnpublished: true } : {}),
    };
  }
  if (operation.kind !== "close" || operation.status !== "SUCCEEDED" || workspace.status !== "CLOSING" || workspace.closeOperationId !== operationId) {
    throw agentXError("WORKSPACE_NOT_READY", "workspace close preflight has not completed safely");
  }
  const parsedPreflight = WorkspaceClosePreflightResultSchema.parse(operation.result);
  if (!parsedPreflight.safeToClose && operation.discardUnpublished !== true) throw agentXError("WORKSPACE_NOT_READY", "workspace contains unpublished work");
  if (operation.discardUnpublished === true) {
    const thread = await getItem<{ starterUserId?: unknown }>(dependencies, await resolveSlackThreadKey(dependencies, requireOrgId(identity.orgId), identity.ownerKey));
    const requestedBy = operation.requestedBy;
    if (typeof thread?.starterUserId !== "string"
      || thread.starterUserId !== slack.requester.userId
      || requestedBy === undefined
      || "kind" in requestedBy
      || requestedBy.userId !== thread.starterUserId
      || requestedBy.teamId !== slack.thread.teamId) {
      throw agentXError("FORBIDDEN", "only the Slack thread starter who authorized discard may complete this close");
    }
  }

  await deleteWorkspaceCompute(dependencies, workspace);
  const storageReleased = closeReleasesStorage(workspace);

  const thread = await getItem<{ starterUserId?: string; closedAt?: string }>(dependencies, await resolveSlackThreadKey(dependencies, requireOrgId(identity.orgId), identity.ownerKey));
  if (typeof thread?.starterUserId !== "string") throw agentXError("CONFIG_INVALID", "Slack thread starter is missing");
  const orgId = requireOrgId(identity.orgId);
  const organizationKey = slackOrganizationLimitKey(orgId, slack.thread.teamId);
  const memberKey = slackMemberLimitKey(orgId, slack.thread.teamId, thread.starterUserId);
  const organization = await getItem<{ count?: number }>(dependencies, organizationKey);
  const member = await getItem<{ count?: number; threads?: string[] }>(dependencies, memberKey);
  const organizationCount = organization?.count ?? 0;
  const memberCount = member?.count ?? 0;
  if (organizationCount < 1 || memberCount < 1) throw agentXError("CONFIG_INVALID", "workspace quota record is inconsistent");
  const remainingThreads = (member?.threads ?? []).filter((subject) => subject !== identity.subject);
  const closedAt = new Date().toISOString();
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: dependencies.tableName,
        Key: workspaceKey(workspace.id),
        UpdateExpression: "SET #status = :closed, closedAt = :closedAt, updatedAt = :closedAt REMOVE activeOperationId, closeError",
        ConditionExpression: "#status = :closing AND closeOperationId = :operation AND fence = :fence",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":closed": "CLOSED", ":closing": "CLOSING", ":closedAt": closedAt, ":operation": operationId, ":fence": operation.fence },
      } },
      { Update: {
        TableName: dependencies.tableName,
        Key: organizationKey,
        UpdateExpression: "SET #count = :next",
        ConditionExpression: "#count = :current",
        ExpressionAttributeNames: { "#count": "count" },
        ExpressionAttributeValues: { ":next": organizationCount - 1, ":current": organizationCount },
      } },
      { Update: {
        TableName: dependencies.tableName,
        Key: memberKey,
        UpdateExpression: "SET #count = :next, #threads = :threads",
        ConditionExpression: "#count = :current",
        ExpressionAttributeNames: { "#count": "count", "#threads": "threads" },
        ExpressionAttributeValues: { ":next": memberCount - 1, ":current": memberCount, ":threads": remainingThreads },
      } },
      { Update: {
        TableName: dependencies.tableName,
        Key: await resolveSlackThreadKey(dependencies, requireOrgId(identity.orgId), identity.ownerKey),
        UpdateExpression: "SET closedAt = :closedAt, closeOperationId = :operation",
        ConditionExpression: "attribute_not_exists(closedAt)",
        ExpressionAttributeValues: { ":closedAt": closedAt, ":operation": operationId },
      } },
    ] }));
  } catch (error) {
    if (!isConditional(error)) throw error;
    const closed = await requireWorkspace(dependencies, workspace.id);
    if (closed.status === "CLOSED" && closed.closedAt) {
      return {
        outcome: "CLOSED",
        workspaceId: closed.id,
        operationId,
        closedAt: closed.closedAt,
        storageReleased,
        ...(discardedUnpublished ? { discardedUnpublished: true } : {}),
      };
    }
    throw agentXError("WORKSPACE_BUSY", "workspace close completion conflicted; retry");
  }
  return { outcome: "CLOSED", workspaceId: workspace.id, operationId, closedAt, storageReleased, ...(operation.discardUnpublished === true ? { discardedUnpublished: !parsedPreflight.safeToClose } : {}) };
}

/**
 * Ruling R31: Slack-started work is admitted against the budgets before anything is charged, as a developer task start is.
 * The member is the developer the Slack user signs in as, when the org has them; an unlinked requester answers to the org alone.
 * Nothing is checked on an install with no model proxy.
 */
async function admitSlackWork(dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity): Promise<void> {
  const modelAccess = dependencies.modelAccess;
  if (modelAccess === undefined || identity.slack === undefined) return;
  const orgId = requireOrgId(identity.orgId);
  // Task 29: with agents set up, the member's own limit applies only when that member pays (not when the project does).
  const project = identity.slack.binding.projectName;
  const paying = dependencies.agents === undefined ? undefined : await slackWorkPayment(dependencies, orgId, project, identity.slack.requester);
  const linked = paying === undefined ? await linkedRequester(dependencies, orgId, identity.slack.requester) : undefined;
  // Work of an unlinked requester answers to the project (and the org) alone.
  const payer: Payer = paying?.payer ?? (linked === undefined ? { kind: "project", project } : { kind: "member", developerId: linked });
  await admitWork(
    { documentClient: dependencies.documentClient, tableName: dependencies.tableName, access: modelAccess.access, cloud: dependencies.cloud === true },
    { orgId, payer, project, agentId: ROVARA_CODE_AGENT_ID, agentName: ROVARA_CODE_NAME, path: "CHAT" },
  );
}

export async function ensureThreadWorkspace(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  value: unknown,
): Promise<SlackThreadWorkspaceResult> {
  const slack = identity.slack;
  const limits = dependencies.slack;
  if (!slack || !limits) throw agentXError("FORBIDDEN", "a Slack thread identity is required");
  const input = object(value, "thread workspace request");
  const requestId = uuid(input.requestId, "requestId");
  // Older deployed Slack services parse a strict response; add discovery metadata only on opt-in.
  const includeIntegrations = input.includeIntegrations === true;
  const includeSettingsRevision = input.includeSettingsRevision === true;
  const includeConnectors = input.includeConnectors === true;
  // A separate opt-in: an older Slack service parses the connectors array with a schema that
  // still requires type "github", so every other resolved connector type is withheld unless the
  // service says it can parse them too.
  const includeAllConnectorTypes = input.includeAllConnectorTypes === true;
  // A separate opt-in: the Slack service released before this field existed already sends
  // includeConnectors: true but parses the WORKSPACE result with a strict schema that lacks
  // recoverableOperations. The control plane deploys first, so gating this on includeConnectors
  // would fail every turn until the Slack service caught up.
  const includeRecoverableOperations = input.includeRecoverableOperations === true;
  // Spec 014, a separate opt-in: a service that sends lazyPreparation: true parses status
  // UNPREPARED and prepares compute through POST /v1/threads/workspace/prepare when a tool first
  // needs the worker. Every other service keeps getting a workspace whose compute is prepared now.
  const lazyPreparation = input.lazyPreparation === true;
  // A separate opt-in (feature 014): services released before the action gate parse strictly.
  const includeActionPolicy = input.includeActionPolicy === true;
  const include: IntegrationInclude = {
    integrations: includeIntegrations,
    connectors: includeConnectors,
    allConnectorTypes: includeAllConnectorTypes,
    recoverableOperations: includeRecoverableOperations,
    actionPolicy: includeActionPolicy,
  };
  if (identity.sharedTask !== undefined) {
    // Task mode (a separate opt-in, so a service that never sends it keeps the closed workflow thread): only for exactly
    // the open Slack-started task whose own thread this is.
    const taskAnswer = input.taskAnswer === undefined ? undefined : SlackTaskAnswerRequestSchema.safeParse(input.taskAnswer);
    if (taskAnswer !== undefined && !taskAnswer.success) throw agentXError("CONFIG_INVALID", "taskAnswer needs the task's ID");
    if (taskAnswer?.data.taskId === identity.sharedTask.taskId && identity.sharedTask.taskAnswer === true) {
      const answer = await taskAnswerWorkspace(dependencies, requireOrgId(identity.orgId), slack.thread, identity.sharedTask, slack.requester, taskAnswer.data.commentId, taskAnswer.data.noteTs);
      if (answer !== undefined) return answer;
    }
    return sharedThreadWorkspace(dependencies, identity, identity.sharedTask, input.includeSharedTask === true, include, includeSettingsRevision);
  }
  // Viewers only view (Plan 2, Task 21): a follow-up in a thread that already has its workspace drives the agent too, so it is refused for
  // an explicit viewer. Everyone else keeps today's behaviour.
  const requesterRole = await slackRequesterRole(dependencies, identity);
  if (requesterRole === "viewer") throw agentXError("PROJECT_ACCESS_DENIED", viewerCannotStartTasksMessage(slack.binding.projectName));
  const threadWorkspace = await getThreadWorkspace(dependencies, requireOrgId(identity.orgId), identity.ownerKey);
  if (threadWorkspace) {
    if (threadWorkspace.status === "CLOSED" && threadWorkspace.closedAt) {
      return { outcome: "CLOSED", workspaceId: threadWorkspace.id, closedAt: threadWorkspace.closedAt };
    }
    if (threadWorkspace.projectName !== slack.binding.projectName) {
      throw agentXError("FORBIDDEN", "this thread's workspace belongs to the channel's previous project binding");
    }
  }
  const existing = threadWorkspace ?? await getDefaultWorkspace(dependencies, requireOrgId(identity.orgId), identity.ownerKey, slack.binding.projectName);
  if (existing) {
    if (existing.status === "CLOSED" && existing.closedAt) {
      return { outcome: "CLOSED", workspaceId: existing.id, closedAt: existing.closedAt };
    }
    // Plan 2, Task 15: a follow-up in a thread that has its workspace can wake the machine, so it needs the org's GitHub connection too.
    const followUpGate = repositoryGateOf(dependencies);
    if (followUpGate !== undefined) {
      const bound = await requireLatestProject(dependencies, requireOrgId(identity.orgId), slack.binding.projectName);
      await requireRepositoriesConnected(followUpGate, requireOrgId(identity.orgId), bound.definition);
    }
    if (existing.status === "UNPREPARED" && !lazyPreparation) {
      // An older Slack service cannot parse UNPREPARED and expects compute now: prepare it at once.
      const prepared = await startThreadPreparation(dependencies, identity, requestId, existing, input.includeOpenTaskCount === true);
      if (prepared.outcome !== "WORKSPACE") return prepared;
      const current = await requireWorkspace(dependencies, existing.id);
      const result = await existingThreadWorkspace(dependencies, identity, requestId, current, include, includeSettingsRevision, input.includeOpenTaskCount === true);
      return result.outcome === "WORKSPACE" ? { ...result, created: prepared.created } : result;
    }
    return existingThreadWorkspace(dependencies, identity, requestId, existing, include, includeSettingsRevision, input.includeOpenTaskCount === true, lazyPreparation);
  }

  // New threads use the latest revision; an existing thread keeps the revision its workspace was prepared with.
  const project = await requireLatestProject(dependencies, requireOrgId(identity.orgId), slack.binding.projectName);
  // Plan 2, Task 11: a new thread is new work, so an archived project refuses it. The requester's role is their real one (Task 21): an
  // explicit grant (a viewer's included) wins, an org owner or admin maintains, and otherwise the bound channel makes them a contributor.
  // Threads that already have a workspace were answered above and keep going.
  await requireNewWorkAllowed(dependencies, requireOrgId(identity.orgId), slack.binding.projectName, requesterRole, "task");
  // Plan 2, Task 15: a new thread is new work that needs the org's GitHub connection (cloud installs), before any budget or charge.
  const gate = repositoryGateOf(dependencies);
  if (gate !== undefined) await requireRepositoriesConnected(gate, requireOrgId(identity.orgId), project.definition);
  if (lazyPreparation) {
    return createUnpreparedThreadWorkspace(dependencies, identity, requestId, project, include, includeSettingsRevision);
  }
  // Before the limit's counters are read and before the charge: a spent budget, or a proxy that cannot say, stops it here.
  await admitSlackWork(dependencies, identity);
  const effective = await effectiveSlackLimits(dependencies, requireOrgId(identity.orgId), limits);
  await healSlackMemberSlots(dependencies, requireOrgId(identity.orgId), slack.requester, effective);
  const { teamId, userId } = slack.requester;
  let preparation: Awaited<ReturnType<typeof newWorkspacePreparation>> | undefined;
  for (let attempt = 0; attempt < MEMBERSHIP_PREPARATION_ATTEMPTS; attempt += 1) {
    const attempted = await newWorkspacePreparation(dependencies, identity, project, identity.ownerKey, requestId);
    try {
      await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
        ...attempted.items,
        { Put: {
          TableName: dependencies.tableName,
          Item: { pk: `IDEMPOTENCY#${identity.ownerKey}#THREAD`, sk: `REQUEST#${requestId}`, entityType: "IDEMPOTENCY", operationId: attempted.operationId, workspaceId: attempted.workspace.id },
          ConditionExpression: "attribute_not_exists(pk)",
        } },
        // #213: the starter is recorded with the charge, so a failed preparation can always find it.
        ...threadChargeItems(dependencies, identity, effective, attempted.workspace.id, await resolveSlackThreadKey(dependencies, requireOrgId(identity.orgId), identity.ownerKey)),
      ] }));
      preparation = attempted;
      break;
    } catch (error) {
      if (!isConditional(error)) throw error;
      // The membership changed since it was read: decide again from the row as it now is, never over it.
      if (await membershipMovedSince(dependencies, requireOrgId(identity.orgId), identity.ownerKey, slack.binding.projectName, attempted.membership)) continue;
      const concurrent = await getDefaultWorkspace(dependencies, requireOrgId(identity.orgId), identity.ownerKey, slack.binding.projectName);
      if (concurrent) {
        return existingThreadWorkspace(dependencies, identity, requestId, concurrent, include, includeSettingsRevision, input.includeOpenTaskCount === true);
      }
      return threadWorkspaceLimitRefusal(dependencies, requireOrgId(identity.orgId), teamId, userId, effective, input.includeOpenTaskCount === true);
    }
  }
  if (preparation === undefined) throw agentXError("WORKSPACE_BUSY", "thread workspace creation conflicted with another request; retry");
  await recordThreadRequester(dependencies, identity, preparation.workspace.id, true);
  return {
    outcome: "WORKSPACE",
    workspaceId: preparation.workspace.id,
    status: "PREPARING",
    operationId: preparation.operationId,
    created: true,
    orchestratorInstructions: project.definition.orchestratorInstructions,
    ...await threadIntegrations(project.definition, include, dependencies, identity.orgId),
    ...(include.recoverableOperations ? { recoverableOperations: [] } : {}),
    ...(includeSettingsRevision ? { settingsRevision: project.definition.revision } : {}),
    ...(include.actionPolicy && project.definition.actionPolicy ? { actionPolicy: project.definition.actionPolicy } : {}),
  };
}

/**
 * Spec 014: a new thread's record with no compute and no limit charge. The workspace ID exists
 * from the first message because connector routes, the connector ledger and conversations are keyed
 * by it. startThreadPreparation prepares compute the first time the thread needs the worker.
 */
async function createUnpreparedThreadWorkspace(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  requestId: string,
  project: RegisteredProjectRecord,
  include: IntegrationInclude,
  includeSettingsRevision: boolean,
): Promise<SlackThreadWorkspaceResult> {
  const projectName = project.definition.name;
  const orgId = requireOrgId(identity.orgId);
  let workspace: WorkspaceInstance | undefined;
  for (let attempt = 0; attempt < MEMBERSHIP_PREPARATION_ATTEMPTS; attempt += 1) {
    const attempted = unpreparedWorkspace(project, identity.ownerKey, orgId);
    const existingMembership = await getMembership(dependencies, orgId, identity.ownerKey, projectName);
    try {
      await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: dependencies.tableName, Item: workspaceItem(orgId, attempted), ConditionExpression: "attribute_not_exists(pk)" } },
        { Put: {
          TableName: dependencies.tableName,
          Item: { ...defaultWorkspaceKey(orgId, identity.ownerKey, projectName), entityType: "DEFAULT_WORKSPACE", workspaceId: attempted.id },
          ConditionExpression: "attribute_not_exists(pk)",
        } },
        // Created only when absent; an existing row is required to be as it was read, never rewritten.
        membershipPreparationItem(dependencies, orgId, identity.ownerKey, projectName, existingMembership),
        { Put: {
          TableName: dependencies.tableName,
          Item: { pk: `IDEMPOTENCY#${identity.ownerKey}#THREAD`, sk: `REQUEST#${requestId}`, entityType: "IDEMPOTENCY", workspaceId: attempted.id },
          ConditionExpression: "attribute_not_exists(pk)",
        } },
        // Capture creation provenance atomically, before a later participant can touch the thread.
        { Update: {
          TableName: dependencies.tableName,
          Key: await resolveSlackThreadKey(dependencies, requireOrgId(identity.orgId), identity.ownerKey),
          UpdateExpression: "SET #creator = if_not_exists(#creator, :creator)",
          ExpressionAttributeNames: { "#creator": "creator" },
          ExpressionAttributeValues: { ":creator": { userId: identity.slack!.requester.userId, ...(identity.slack!.requesterName === undefined ? {} : { name: identity.slack!.requesterName }) } },
        } },
        ...(existingMembership === undefined || typeof existingMembership.grantId !== "string"
          ? await approvalGrantChange({ ...dependencies, now: () => new Date() }, orgId, projectName, false) : []),
      ] }));
      workspace = attempted;
      break;
    } catch (error) {
      if (!isConditional(error)) throw error;
      // The membership changed since it was read: decide again from the row as it now is, never over it.
      if (await membershipMovedSince(dependencies, orgId, identity.ownerKey, projectName, existingMembership)) continue;
      // Another first message in this thread created the record.
      const concurrent = await getDefaultWorkspace(dependencies, orgId, identity.ownerKey, projectName);
      if (concurrent) return existingThreadWorkspace(dependencies, identity, requestId, concurrent, include, includeSettingsRevision);
      throw agentXError("WORKSPACE_BUSY", "thread workspace creation conflicted with another request; retry");
    }
  }
  if (workspace === undefined) throw agentXError("WORKSPACE_BUSY", "thread workspace creation conflicted with another request; retry");
  // The starter is recorded when compute is prepared, because that member is the one charged.
  await recordThreadRequester(dependencies, identity, workspace.id, false);
  // Each optional field is its own spread, so a later opt-in (phase 14c's action policy) adds one
  // more spread line here, after settingsRevision, the same way ensureThreadWorkspace gains it.
  return {
    outcome: "WORKSPACE",
    workspaceId: workspace.id,
    status: "UNPREPARED",
    operationId: null,
    created: true,
    orchestratorInstructions: project.definition.orchestratorInstructions,
    ...await threadIntegrations(project.definition, include, dependencies, identity.orgId),
    ...(include.recoverableOperations ? { recoverableOperations: [] } : {}),
    ...(includeSettingsRevision ? { settingsRevision: project.definition.revision } : {}),
    ...(include.actionPolicy && project.definition.actionPolicy ? { actionPolicy: project.definition.actionPolicy } : {}),
  };
}

/**
 * A workspace record naming the thread's starting revision and runtime, with fence 0 and no
 * operation. startThreadPreparation replaces the revision with the latest one when it prepares.
 */
function unpreparedWorkspace(project: RegisteredProjectRecord, ownerKey: string, orgId: OrgId): WorkspaceInstance {
  const now = new Date().toISOString();
  return WorkspaceInstanceSchema.parse({
    id: randomUUID(),
    ownerKey,
    orgId,
    projectName: project.definition.name,
    projectRevision: project.definition.revision,
    ...workspaceRuntime(project.runtimeBinding),
    rootPath: "/mnt/workspace",
    status: "UNPREPARED",
    fence: 0,
    createdAt: now,
    updatedAt: now,
  });
}

/** POST /v1/threads/workspace/prepare (spec 014): prepares compute for this thread's workspace. */
export async function prepareThreadWorkspace(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  value: unknown,
): Promise<SlackThreadPrepareResult> {
  const slack = identity.slack;
  if (!slack || !dependencies.slack) throw agentXError("FORBIDDEN", "a Slack thread identity is required");
  await requireSlackRequesterMayWork(dependencies, identity, slack.binding.projectName);
  const input = object(value, "thread workspace preparation");
  const requestId = uuid(input.requestId, "requestId");
  // C11: a shared task's workspace is the developer's; the thread never prepares it.
  if (identity.sharedTask !== undefined) {
    // Q3: as the ensure route does, a service that sends includeSharedTask hears VIEW_ONLY, never
    // the ordinary "start a new thread" or a bare refusal.
    const includeSharedTask = input.includeSharedTask === true;
    const shared = identity.sharedTask;
    if (shared.state !== "continue") {
      if (!includeSharedTask) throw agentXError("FORBIDDEN", SHARED_VIEW_ONLY);
      return { outcome: "VIEW_ONLY", taskId: shared.taskId, closed: shared.state === "closed" };
    }
    const workspace = await requireWorkspace(dependencies, shared.workspaceId);
    if (workspace.ownerKey !== identity.ownerKey) throw agentXError("FORBIDDEN", "the workspace does not belong to this task");
    if (workspace.status === "CLOSED" && workspace.closedAt) {
      return includeSharedTask
        ? { outcome: "VIEW_ONLY", taskId: shared.taskId, closed: true }
        : { outcome: "CLOSED", workspaceId: workspace.id, closedAt: workspace.closedAt };
    }
    return { outcome: "WORKSPACE", workspaceId: workspace.id, status: workspace.status, operationId: (await activeOperationForChannel(dependencies, workspace)).operationId, created: false };
  }
  const workspace = await getThreadWorkspace(dependencies, requireOrgId(identity.orgId), identity.ownerKey)
    ?? await getDefaultWorkspace(dependencies, requireOrgId(identity.orgId), identity.ownerKey, slack.binding.projectName);
  if (!workspace) throw agentXError("NOT_FOUND", "thread workspace not found");
  if (workspace.status === "CLOSED" && workspace.closedAt) {
    return { outcome: "CLOSED", workspaceId: workspace.id, closedAt: workspace.closedAt };
  }
  if (workspace.projectName !== slack.binding.projectName) {
    throw agentXError("FORBIDDEN", "this thread's workspace belongs to the channel's previous project binding");
  }
  return startThreadPreparation(dependencies, identity, requestId, workspace, input.includeOpenTaskCount === true);
}

/**
 * Moves an UNPREPARED thread workspace to PREPARING. The same transaction writes the prepare
 * operation and outbox item, charges the requesting member and the organization, and records that
 * member as the thread's starter, whose charge closing releases. So a limit counts only prepared
 * threads. An UNPREPARED workspace has no disk yet, so it is built from the project's latest
 * registered revision (#12), not the one the thread started with. The same transaction writes
 * that revision onto the workspace record, so the record, the operation's payload hash, the
 * invocation and the outbox routing all name one revision. From then on the workspace stays on
 * it, as retryWorkspacePreparation does. Any other status is answered as it stands: a racing
 * request prepared it already.
 */
async function startThreadPreparation(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  requestId: string,
  workspace: WorkspaceInstance,
  includeOpenTaskCount = false,
): Promise<SlackThreadPrepareResult> {
  const slack = identity.slack;
  const limits = dependencies.slack;
  if (!slack || !limits) throw agentXError("FORBIDDEN", "a Slack thread identity is required");
  if (workspace.status === "PREPARATION_FAILED" && !workspace.activeOperationId) {
    // #213: a released failed workspace a lazy turn was told is UNPREPARED; prepared again, charged afresh (so admitted afresh).
    await admitSlackWork(dependencies, identity);
    const pinned = await requireProject(dependencies, requireOrgId(identity.orgId), workspace.projectName, workspace.projectRevision);
    const retried = await retryThreadPreparation(dependencies, identity, requestId, pinned, workspace, includeOpenTaskCount);
    if ("outcome" in retried) {
      if (retried.outcome === "LIMIT_REACHED") return retried;
      throw agentXError("WORKSPACE_BUSY", "thread workspace preparation conflicted with another request; retry");
    }
    return { outcome: "WORKSPACE", workspaceId: workspace.id, status: retried.status, operationId: retried.operationId, created: false };
  }
  if (workspace.status !== "UNPREPARED") {
    return { outcome: "WORKSPACE", workspaceId: workspace.id, status: workspace.status, operationId: workspace.activeOperationId, created: false };
  }
  // The lazy path's first charge: admitted against the budgets before it (ruling R31).
  await admitSlackWork(dependencies, identity);
  const effective = await effectiveSlackLimits(dependencies, requireOrgId(identity.orgId), limits);
  await healSlackMemberSlots(dependencies, requireOrgId(identity.orgId), slack.requester, effective);
  // One read of the latest revision feeds every field below, so a revision registered meanwhile
  // cannot mix in. The fence condition refuses the write if the workspace changed since it was read.
  const latest = await requireLatestProject(dependencies, requireOrgId(identity.orgId), workspace.projectName);
  const projectRevision = latest.definition.revision;
  const now = new Date().toISOString();
  const operationId = randomUUID();
  const fence = workspace.fence + 1;
  const operation = operationRecord({
    ...operationOrg(workspace),
    id: operationId,
    workspaceId: workspace.id,
    kind: "prepare",
    requestId,
    payloadHash: hashJson({ projectName: workspace.projectName, projectRevision, targetOwnerKey: identity.ownerKey }),
    status: "ACCEPTED",
    fence,
    createdAt: now,
    updatedAt: now,
    ...requesterOf(identity),
  });
  const metaPrepare = await metaPrepareOf(dependencies, latest, requireOrgId(identity.orgId));
  if (metaPrepare.knowledgeCommit !== undefined) operation.knowledgeCommit = metaPrepare.knowledgeCommit;
  const invocation: WorkerInvocation = {
    protocolVersion: 1,
    kind: "prepare",
    operationId,
    workspaceId: workspace.id,
    fence,
    projectRevision,
    callbackCapability: issueCapability(dependencies, workspace.id, operationId, fence),
    payload: {
      project: workerProjectDefinition(latest.definition),
      repositoryGrant: issueRepositoryGrant(dependencies, latest, identity.ownerKey, workspace.id, operationId),
      ...(metaPrepare.meta === undefined ? {} : { meta: metaPrepare.meta }),
      ...registriesPrepareOf(dependencies, latest, { orgId: requireOrgId(identity.orgId) }),
    },
  };
  // The runtime fields stay the workspace's own (only deploymentMode today); outboxRecord refuses a
  // latest revision whose runtime does not match, before anything is written.
  const updated = WorkspaceInstanceSchema.parse({ ...workspace, projectRevision, status: "PREPARING", activeOperationId: operationId, fence, updatedAt: now });
  const outbox = outboxRecord(updated, invocation, latest.runtimeBinding);
  const { teamId, userId } = slack.requester;
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: dependencies.tableName,
        Key: workspaceKey(workspace.id),
        UpdateExpression: "SET #status = :preparing, projectRevision = :revision, activeOperationId = :operation, fence = :nextFence, updatedAt = :now",
        ConditionExpression: "ownerKey = :owner AND #status = :unprepared AND fence = :currentFence",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":owner": identity.ownerKey,
          ":preparing": "PREPARING",
          ":revision": projectRevision,
          ":unprepared": "UNPREPARED",
          ":operation": operationId,
          ":nextFence": fence,
          ":currentFence": workspace.fence,
          ":now": now,
        },
      } },
      { Put: { TableName: dependencies.tableName, Item: operation, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: dependencies.tableName, Item: outbox, ConditionExpression: "attribute_not_exists(pk)" } },
      ...threadChargeItems(dependencies, identity, effective, workspace.id, await resolveSlackThreadKey(dependencies, requireOrgId(identity.orgId), identity.ownerKey)),
    ] }));
  } catch (error) {
    if (!isConditional(error)) throw error;
    const current = await requireWorkspace(dependencies, workspace.id);
    if (current.status !== "UNPREPARED") {
      return { outcome: "WORKSPACE", workspaceId: current.id, status: current.status, operationId: current.activeOperationId, created: false };
    }
    // threadWorkspaceLimitRefusal throws its own WORKSPACE_BUSY, worded for creation, when no limit
    // is reached. Answer with this route's wording instead.
    try {
      const refusal = await threadWorkspaceLimitRefusal(dependencies, requireOrgId(identity.orgId), teamId, userId, effective, includeOpenTaskCount);
      if (refusal.outcome === "LIMIT_REACHED") return refusal;
    } catch (refusalError) {
      if (!(refusalError instanceof AgentXError) || refusalError.code !== "WORKSPACE_BUSY") throw refusalError;
    }
    throw agentXError("WORKSPACE_BUSY", "thread workspace preparation conflicted with another request; retry");
  }
  return { outcome: "WORKSPACE", workspaceId: workspace.id, status: "PREPARING", operationId, created: true };
}

/**
 * A thread preparation's charge: the requesting member and the organization, each refused at its
 * limit, and the member recorded as the thread's starter, whose charge a close or a failed
 * preparation (#213) gives back. A thread already charged fails the starter condition.
 */
function threadChargeItems(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  effective: SlackServiceConfiguration,
  workspaceId: string,
  threadKey: { pk: string; sk: string },
): TransactItems {
  const slack = identity.slack;
  if (!slack) throw agentXError("FORBIDDEN", "a Slack thread identity is required");
  const { teamId, userId } = slack.requester;
  const orgId = requireOrgId(identity.orgId);
  return [
    { Update: {
      TableName: dependencies.tableName,
      Key: slackOrganizationLimitKey(orgId, teamId),
      UpdateExpression: "SET #count = if_not_exists(#count, :zero) + :one, entityType = :entity",
      ConditionExpression: "attribute_not_exists(#count) OR #count < :limit",
      ExpressionAttributeNames: { "#count": "count" },
      ExpressionAttributeValues: { ":zero": 0, ":one": 1, ":limit": effective.organizationWorkspaceLimit, ":entity": "SLACK_LIMIT" },
    } },
    { Update: {
      TableName: dependencies.tableName,
      Key: slackMemberLimitKey(orgId, teamId, userId),
      UpdateExpression: "SET #count = if_not_exists(#count, :zero) + :one, #threads = list_append(if_not_exists(#threads, :none), :thread), entityType = :entity",
      ConditionExpression: "attribute_not_exists(#count) OR #count < :limit",
      ExpressionAttributeNames: { "#count": "count", "#threads": "threads" },
      ExpressionAttributeValues: {
        ":zero": 0,
        ":one": 1,
        ":limit": effective.memberWorkspaceLimit,
        ":none": [],
        ":thread": [identity.subject],
        ":entity": "SLACK_LIMIT",
      },
    } },
    { Update: {
      TableName: dependencies.tableName,
      Key: threadKey,
      // The same record recordThreadRequester(..., true) writes, so a missing thread row is
      // created whole and the charged member is among its requesters.
      UpdateExpression: "SET #entity = :entity, #thread = if_not_exists(#thread, :thread), #workspace = if_not_exists(#workspace, :workspace), starterUserId = :user, #starter = :starter, orgId = :org ADD #requesters :users",
      ConditionExpression: "attribute_not_exists(starterUserId)",
      ExpressionAttributeNames: { "#entity": "entityType", "#thread": "thread", "#workspace": "workspaceId", "#requesters": "requesters", "#starter": "starter" },
      ExpressionAttributeValues: {
        // The org whose counters this charge took; a failed preparation gives the charge back there.
        ":org": orgId,
        ":entity": "SLACK_THREAD",
        ":thread": identity.subject,
        ":workspace": workspaceId,
        ":user": userId,
        ":users": new Set([userId]),
        ":starter": { userId, ...(identity.slack?.requesterName === undefined ? {} : { name: identity.slack.requesterName }) },
      },
    } },
  ];
}

/** The most characters of context the Slack service takes in a task-mode answer (its schema's bound). */
const SLACK_TASK_CONTEXT_CHARS = 39_000;

/**
 * What a question the Ask rules refuse is answered with: a context with no data in it that tells the answer turn to say one fixed sentence. The question is then answered (the service posts the sentence
 * and marks the note answered), so a refused question never stays behind as a note the next agent step could read as an instruction.
 */
export const slackAskRefusalContext = (words: string): string => `This question cannot be answered. Do not use any other information. Reply with exactly this sentence and nothing else: "${words}"`;
export const SLACK_ASK_NOT_ALLOWED_WORDS = "This question can't be answered here.";

/** The marker a refused Slack question leaves on its saved reply (`noteTs`): ids and an expiry, never the words. The "answered" call finds it and records no Ask for that reply (LA-6, N5). */
const slackAskRefusedKey = (taskId: string, noteTs: string) => ({ pk: `DEVTASK#${taskId}`, sk: `ASKREFUSED#${noteTs}` });
async function markSlackAskRefused(dependencies: AwsBrokerDependencies, taskId: string, noteTs: string | undefined): Promise<void> {
  if (noteTs === undefined) return;
  try {
    await dependencies.documentClient.send(new PutCommand({ TableName: dependencies.tableName, Item: { ...slackAskRefusedKey(taskId, noteTs), entityType: "SLACK_ASK_REFUSED", [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(Date.now() / 1000) + 2 * 86_400 } }));
  } catch {
    // Best effort: the refusal is answered either way; without the marker that reply is recorded as before.
  }
}

/**
 * Task mode for the chat agent in a Slack-started task's own thread: a read-only view. No repositories, connectors or actions, no operation and no compute (nothing is created, prepared or
 * charged); `taskContext` is the broker's untrusted-data text about the task. Undefined (the thread stays closed) when the task is closed or its context cannot be built.
 *
 * Two settings. Ask switch OFF (`slackAsk.ask` undefined, the default): exactly what this did before Ask: anyone in the task's own thread (the model-access route already refused removed, banned
 * and other-org people), the context of `workflowTaskAnswerContext`, no session or agents runtime needed. Ask switch ON: the question is an Ask for the Slack audience (`askContext`: file names
 * and counts, never patch text, because the channel may hold people who are not members): the asker must be a member of the org with "can use" on the task's session, read now; it spends the Ask
 * rates; and a refusal is answered in fixed words instead of leaving the question as a note.
 */
async function taskAnswerWorkspace(
  dependencies: AwsBrokerDependencies,
  orgId: OrgId,
  thread: SlackThread,
  shared: NonNullable<AuthenticatedIdentity["sharedTask"]>,
  requester: SlackRequester,
  commentId?: string,
  noteTs?: string,
): Promise<SlackThreadWorkspaceResult | undefined> {
  const workspace = await requireWorkspace(dependencies, shared.workspaceId);
  // A merged (or rejected) task gave back its workspace but is not closed: its thread is still answered, which needs no
  // compute. A closed task's thread stays closed (the context below is undefined for it).
  const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(shared.taskId));
  if (workspace.status === "CLOSED" && task?.releasedAt === undefined) return undefined;
  const actions = developerTaskActions(dependencies);
  const reply = async (taskContext: string): Promise<SlackThreadWorkspaceResult> => ({
    outcome: "WORKSPACE", mode: "task-answer", workspaceId: workspace.id, status: workspace.status, operationId: null, created: false,
    orchestratorInstructions: (await requireLatestProject(dependencies, orgId, workspace.projectName)).definition.orchestratorInstructions, taskContext,
  });
  const slackAsk = dependencies.slackAsk;
  if (slackAsk?.ask === undefined || task === undefined) {
    // The Ask switch is off: the context and the people rule are what they were before Ask existed.
    const taskContext = await workflowTaskAnswerContext(
      { documentClient: dependencies.documentClient, tableName: dependencies.tableName, actions },
      { taskId: shared.taskId, workspaceId: shared.workspaceId, thread, ...(commentId === undefined ? {} : { commentId }) },
    );
    return taskContext === undefined ? undefined : reply(taskContext);
  }
  // The Ask switch is on. A thread that is not this open task's own stays closed, as before; any other refusal is answered in fixed words.
  if (!await taskOwnsThread({ documentClient: dependencies.documentClient, tableName: dependencies.tableName }, { taskId: shared.taskId, workspaceId: shared.workspaceId, thread })) return undefined;
  // Anyone in the task's own thread may ask (owner decision 2026-11-01): the identity route already refused removed, banned and other-org people. A member is rated under their developer id, a Slack
  // user with no member link under their Slack workspace and user id. What they see is the Slack tier's alone.
  const developerId = await linkedRequester(dependencies, orgId, requester);
  const context = await askContext(slackAsk.context, { audience: "slack", workspaceId: shared.workspaceId, thread, ...(developerId === undefined ? {} : { asker: { developerId } }) }, shared.taskId, slackAsk.readers);
  const refuse = async (words: string): Promise<SlackThreadWorkspaceResult> => { await markSlackAskRefused(dependencies, shared.taskId, noteTs); return reply(slackAskRefusalContext(words)); };
  if (context === undefined) return refuse(SLACK_ASK_NOT_ALLOWED_WORDS);
  // A page-comment answer whose section is gone is not answered, and spends nothing: the section is read before the rates are taken (LA-5, M3).
  let section: string[] | undefined;
  if (commentId !== undefined) {
    section = await taskCommentSection({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, actions }, shared.taskId, commentId);
    if (section === undefined) return undefined;
  }
  try {
    await takeSlackAskRates(slackAsk.ask, task, developerId ?? slackAskerKey(thread.teamId, requester.userId));
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "TOO_MANY_REQUESTS") return refuse(ASK_RATE_TEXT);
    // A task with no session has nothing to rate on: answered in fixed words, never left as a note.
    if (code === "RUNTIME_UNAVAILABLE") return refuse(SLACK_ASK_NOT_ALLOWED_WORDS);
    throw error;
  }
  let taskContext = context.text;
  if (section !== undefined) {
    // The answer is shown on the task page, not in the thread: the context says so (the audience's limits are the Slack tier's all the same).
    taskContext = [taskContext.replace(/^This Slack thread is an AgentX task/u, "This is an AgentX task"), ...section].join("\n");
  }
  if (taskContext.length > SLACK_TASK_CONTEXT_CHARS) taskContext = Array.from(taskContext).slice(0, SLACK_TASK_CONTEXT_CHARS).join("");
  return reply(taskContext);
}

/**
 * POST /v1/service/tasks/thread-notes/answered: the chat agent answered a reply in a Slack-started task's thread as a
 * question, so the next step skips it. The call must be from that task's own open thread and name it; the broker then
 * marks the saved reply (and nothing else). A repeat answers the same.
 */
export async function markThreadNoteAnswered(dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity, value: unknown): Promise<{ outcome: "ANSWERED" }> {
  if (dependencies.developer === undefined || identity.slack === undefined) throw agentXError("FORBIDDEN", "a Slack thread identity is required");
  const input = SlackThreadNoteAnsweredRequestSchema.safeParse(value);
  if (!input.success) throw agentXError("CONFIG_INVALID", "taskId, messageTs and thread are required");
  const { thread } = identity.slack;
  const body = input.data;
  const own = identity.sharedTask;
  if (own?.taskAnswer !== true || own.taskId !== body.taskId || body.thread.teamId !== thread.teamId || body.thread.channelId !== thread.channelId || body.thread.threadTs !== thread.threadTs
    || dependencies.developer.slackTeamId !== thread.teamId) {
    throw agentXError("FORBIDDEN", "this thread is not that task's own thread");
  }
  const outcome = await markWorkflowThreadNoteAnswered({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now }, { taskId: body.taskId, thread, messageTs: body.messageTs });
  if (outcome === "refused") throw agentXError("FORBIDDEN", "this thread is not that task's own thread");
  if (outcome === "missing") throw agentXError("NOT_FOUND", "that reply was not saved for this task");
  // Live interaction A3: with the Ask switch on, the question is kept as an Ask (rates were spent when its context was built) and audited. The answer is already in the thread: nothing here can fail it.
  const slackAsk = dependencies.slackAsk?.ask;
  if (slackAsk !== undefined && body.ask !== undefined && identity.orgId !== undefined) {
    const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(body.taskId));
    const askedBy = await linkedRequester(dependencies, identity.orgId, identity.slack.requester);
    // A question the broker refused in fixed words (its reply carries the marker) is not an Ask: nothing is recorded or counted for it.
    const refused = await getItem(dependencies, slackAskRefusedKey(body.taskId, body.messageTs)) !== undefined;
    if (task !== undefined && !refused) await recordSlackAsk(slackAsk, { task, messageTs: body.messageTs, askedBy, question: body.ask.question, answer: body.ask.answer, contextBytes: body.ask.contextBytes ?? 0 });
  }
  return { outcome: "ANSWERED" };
}

/**
 * POST /v1/service/tasks/comments/answered (spec 061 slice 2): AgentX's answer to a task page comment, from the Slack
 * service. The call must come from that task's own open thread and name it; only a comment still waiting for an answer
 * takes one, and a repeat answers the same. The answer becomes AgentX's reply on the page; nothing is posted in Slack.
 */
export async function markCommentAnswered(dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity, value: unknown): Promise<{ outcome: "ANSWERED" | "FAILED" }> {
  if (dependencies.developer === undefined || identity.slack === undefined) throw agentXError("FORBIDDEN", "a Slack thread identity is required");
  const input = SlackCommentAnsweredRequestSchema.safeParse(value);
  if (!input.success) throw agentXError("CONFIG_INVALID", "taskId, commentId, thread and outcome are required");
  const { thread } = identity.slack;
  const body = input.data;
  const own = identity.sharedTask;
  if (own?.taskAnswer !== true || own.taskId !== body.taskId || body.thread.teamId !== thread.teamId || body.thread.channelId !== thread.channelId || body.thread.threadTs !== thread.threadTs
    || dependencies.developer.slackTeamId !== thread.teamId) {
    throw agentXError("FORBIDDEN", "this thread is not that task's own thread");
  }
  let state: "answered" | "failed";
  try {
    state = await writeCommentAnswer(
      { documentClient: dependencies.documentClient, tableName: dependencies.tableName, actions: developerTaskActions(dependencies), now: Date.now },
      { taskId: body.taskId, commentId: body.commentId, outcome: body.outcome, ...(body.outcome === "ANSWERED" ? { text: await withPlainRefs(dependencies, body.taskId, body.commentId, body.text) } : {}) },
    );
  } catch (error) {
    if (isPageRefusal(error)) throw agentXError("IDEMPOTENCY_CONFLICT", "that comment is not waiting for an answer");
    throw error;
  }
  console.log(JSON.stringify({ component: "broker", event: "developer.comment_answer_written", taskId: body.taskId, outcome: state }));
  return { outcome: state === "answered" ? "ANSWERED" : "FAILED" };
}

/**
 * AgentX's answer to a page comment with the plan's labels made plain: "decision d1" names the decision by its question,
 * read from the document and version the question was asked on, and "comment c1" reads "that comment". The model is told
 * not to use them; this is for the one that slips through. Where the document cannot be read, the label is only dropped.
 */
async function withPlainRefs(dependencies: AwsBrokerDependencies, taskId: string, commentId: string, text: string): Promise<string> {
  if (!/\b(?:decisions?|comments?)\s+[dc][1-9][0-9]{0,2}\b/iu.test(text)) return text;
  const decisions = new Map<string, string>();
  try {
    const asked = await getItem<{ document?: string; version?: number }>(dependencies, { pk: `DEVTASK#${taskId}`, sk: `COMMENT#${commentId}` });
    const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(taskId));
    const entry = task?.workflow?.artifacts.find((artifact) => artifact.type === asked?.document && artifact.version === asked.version);
    if (entry?.format === "structured") {
      const loaded = await loadWorkflowDocument((key) => readObjectText(dependencies, key, EARLIER_PLAN_MAX_BYTES), entry, {}).catch(() => undefined);
      if (loaded?.format === "structured") for (const decision of loaded.plan.decisions) decisions.set(decision.id, decision.question);
    }
  } catch {
    // The labels are still removed below, only without the decision's words.
  }
  return plainPageRefs(text, { decisions });
}

const SHARED_VIEW_ONLY = "this thread follows a task started from an AI tool and is view only";
const SHARED_CLOSE_REFUSED = "only the developer who started this task can close it, from their AI tool";

/**
 * Spec 025 C11: a shared thread's workspace. View or closed: VIEW_ONLY, and nothing is created.
 * Continue: the task's workspace as it is, never created, prepared again or charged (FR-054), with
 * no recoverable operations, because the running one may be the developer's own.
 */
async function sharedThreadWorkspace(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  shared: NonNullable<AuthenticatedIdentity["sharedTask"]>,
  includeSharedTask: boolean,
  include: IntegrationInclude,
  includeSettingsRevision: boolean,
): Promise<SlackThreadWorkspaceResult> {
  if (shared.state !== "continue") {
    if (!includeSharedTask) throw agentXError("FORBIDDEN", SHARED_VIEW_ONLY);
    return { outcome: "VIEW_ONLY", taskId: shared.taskId, closed: shared.state === "closed" };
  }
  const workspace = await requireWorkspace(dependencies, shared.workspaceId);
  if (workspace.ownerKey !== identity.ownerKey) throw agentXError("FORBIDDEN", "the workspace does not belong to this task");
  if (workspace.status === "CLOSED" && workspace.closedAt) {
    // Q3: a shared task's thread says the task is closed, never the ordinary "start a new thread".
    return includeSharedTask
      ? { outcome: "VIEW_ONLY", taskId: shared.taskId, closed: true }
      : { outcome: "CLOSED", workspaceId: workspace.id, closedAt: workspace.closedAt };
  }
  const settings = await requireLatestProject(dependencies, requireOrgId(identity.orgId), workspace.projectName);
  const active = await activeOperationForChannel(dependencies, workspace);
  return {
    outcome: "WORKSPACE",
    workspaceId: workspace.id,
    status: workspace.status,
    operationId: active.operationId,
    created: false,
    orchestratorInstructions: settings.definition.orchestratorInstructions,
    ...await threadIntegrations(settings.definition, include, dependencies, identity.orgId),
    ...(include.recoverableOperations ? { recoverableOperations: [] } : {}),
    ...(includeSettingsRevision ? { settingsRevision: settings.definition.revision } : {}),
    ...(include.actionPolicy && settings.definition.actionPolicy ? { actionPolicy: settings.definition.actionPolicy } : {}),
    ...(includeSharedTask ? { sharedTask: { taskId: shared.taskId, developerName: emailSafeName(shared.developerName) ?? "a member" } } : {}),
    ...(includeSharedTask && active.developer ? { activeOperation: "developer" as const } : {}),
  };
}

/**
 * D22: the task's active operation, named to the channel only when the channel started it. The
 * developer's own run stays private (its events and result are theirs), so the channel learns only
 * that the developer is running something, and the Slack service waits for it (C12).
 */
async function activeOperationForChannel(dependencies: AwsBrokerDependencies, workspace: WorkspaceInstance): Promise<{ operationId: string | null; developer: boolean }> {
  if (!workspace.activeOperationId) return { operationId: null, developer: false };
  const operation = await getItem<OperationRecord>(dependencies, operationKey(workspace.id, workspace.activeOperationId));
  // A pointer to a record that is gone names nothing to wait for: the workspace reads as idle.
  if (!operation) return { operationId: null, developer: false };
  const developer = developerRequested(operation);
  return developer ? { operationId: null, developer: true } : { operationId: operation.id, developer: false };
}

async function existingThreadWorkspace(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  requestId: string,
  workspace: WorkspaceInstance,
  include: IntegrationInclude,
  includeSettingsRevision: boolean,
  includeOpenTaskCount = false,
  lazyPreparation = false,
): Promise<SlackThreadWorkspaceResult> {
  await recordThreadRequester(dependencies, identity, workspace.id, false);
  // Preparation rebuilds the workspace's disk, so it keeps the revision recorded on the workspace
  // (for a Slack thread, the latest revision when its compute was first prepared). Everything the
  // model is told comes from the project's latest registered revision.
  const pinned = await requireProject(dependencies, requireOrgId(identity.orgId), workspace.projectName, workspace.projectRevision);
  const settings = await requireLatestProject(dependencies, requireOrgId(identity.orgId), workspace.projectName);
  const applied = {
    orchestratorInstructions: settings.definition.orchestratorInstructions,
    ...await threadIntegrations(settings.definition, include, dependencies, identity.orgId),
    ...(include.recoverableOperations ? { recoverableOperations: workspace.status === "BUSY" && workspace.activeOperationId ? [workspace.activeOperationId] : [] } : {}),
    ...(includeSettingsRevision ? { settingsRevision: settings.definition.revision } : {}),
    ...(include.actionPolicy && settings.definition.actionPolicy ? { actionPolicy: settings.definition.actionPolicy } : {}),
  };
  if (workspace.status === "PREPARATION_FAILED" && !workspace.activeOperationId) {
    const retried = await retryThreadPreparation(dependencies, identity, requestId, pinned, workspace, includeOpenTaskCount);
    // #213: a lazy service's turn is never refused for a slot it may not need. Its released
    // workspace has no compute and no charge, as a new thread's has, so it is answered UNPREPARED,
    // and the prepare route retries it (and refuses at the limit) when a tool needs the worker.
    if ("outcome" in retried && retried.outcome === "LIMIT_REACHED" && lazyPreparation) {
      return { outcome: "WORKSPACE", workspaceId: workspace.id, status: "UNPREPARED", operationId: null, created: false, ...applied };
    }
    if ("outcome" in retried) return retried;
    return {
      outcome: "WORKSPACE",
      workspaceId: workspace.id,
      status: retried.status,
      operationId: retried.operationId,
      created: false,
      ...applied,
    };
  }
  return {
    outcome: "WORKSPACE",
    workspaceId: workspace.id,
    status: workspace.status,
    operationId: workspace.activeOperationId,
    created: false,
    ...applied,
  };
}

export interface IntegrationInclude { integrations: boolean; connectors: boolean; allConnectorTypes: boolean; recoverableOperations: boolean; actionPolicy: boolean }

/**
 * Every connector the project's latest revision configures, for services that opt in with
 * includeConnectors. An older Slack service's schema still requires type "github", so every other
 * resolved type is withheld unless the service also sends includeAllConnectorTypes.
 * githubMcpRepositories stays github-only regardless, for feature 007's included integrations.
 */
async function threadIntegrations(project: ProjectDefinition, include: IntegrationInclude, dependencies: AwsBrokerDependencies, orgId: OrgId | undefined): Promise<{
  githubMcpRepositories?: string[];
  connectors?: ThreadConnector[];
  repositories?: string[];
}> {
  const github = githubConnectorOf(project);
  const repositories = github?.repositories.map((repository) => repository.name) ?? [];
  let connectors: ThreadConnector[] | undefined;
  if (include.connectors) {
    // Only whether each connector is connected is read here: no token is minted, so asking for a scope is a bug.
    const resolved = resolveConnectors(project, connectorTypeContext(dependencies, orgId, () => Promise.reject(agentXError("RUNTIME_UNAVAILABLE", "listing a thread's connectors mints no GitHub token"))), dependencies.connectorTypes);
    const visible = include.allConnectorTypes ? resolved : resolved.filter((connector) => connector.type === "github");
    connectors = await Promise.all(visible.map(async (connector) => ({
      name: connector.name,
      type: connector.type,
      label: connector.label,
      scopes: connector.scopes.map((scope) => scope.alias),
      connected: await configuredSafely(connector, project),
    })));
  }
  return {
    ...(include.integrations && github ? { githubMcpRepositories: repositories } : {}),
    ...(include.connectors ? { repositories: project.repositories.map((repository) => repository.name), connectors: connectors ?? [] } : {}),
  };
}

/**
 * One connector's `configured()` throwing, for example a DynamoDB error in CredentialRegistry.has,
 * must not fail the whole Slack turn: every other connector, GitHub included, still needs to reach
 * the thread. Log the connector's name and its error's class name only, never its message, which
 * could carry vendor detail.
 */
async function configuredSafely(connector: ResolvedConnector, project: ProjectDefinition): Promise<boolean> {
  try {
    return await connector.configured();
  } catch (error) {
    console.log(JSON.stringify({
      component: "broker", event: "connector.configured_failed",
      project: project.name, revision: project.revision, connector: connector.name,
      error: error instanceof Error ? error.constructor.name : "UnknownError",
    }));
    return false;
  }
}

async function threadWorkspaceLimitRefusal(
  dependencies: AwsBrokerDependencies,
  orgId: OrgId,
  teamId: string,
  userId: string,
  limits: SlackServiceConfiguration,
  includeOpenTaskCount: boolean,
): Promise<SlackThreadWorkspaceResult> {
  const member = await getItem<{ count?: number; threads?: string[]; tasks?: unknown }>(dependencies, slackMemberLimitKey(orgId, teamId, userId));
  if ((member?.count ?? 0) >= limits.memberWorkspaceLimit) {
    return {
      outcome: "LIMIT_REACHED",
      limit: "MEMBER",
      maximum: limits.memberWorkspaceLimit,
      starterThreads: (member?.threads ?? []).map((subject) => parseSlackThreadSubject(subject)),
      // C16: the member's open AI-tool tasks share this counter (25b R6), so the reply counts them.
      // A count only: a task's title stays with its developer, never in the channel (D22).
      ...(includeOpenTaskCount ? { openTaskCount: openTaskCount(member?.tasks) } : {}),
    };
  }
  const organization = await getItem<{ count?: number }>(dependencies, slackOrganizationLimitKey(orgId, teamId));
  if ((organization?.count ?? 0) >= limits.organizationWorkspaceLimit) {
    return { outcome: "LIMIT_REACHED", limit: "ORGANIZATION", maximum: limits.organizationWorkspaceLimit, starterThreads: [] };
  }
  throw agentXError("WORKSPACE_BUSY", "thread workspace creation conflicted with another request; retry");
}

/** The size of the member counter's `tasks` string set, which the document client reads as a Set. */
function openTaskCount(tasks: unknown): number {
  if (tasks instanceof Set) return tasks.size;
  return Array.isArray(tasks) ? tasks.length : 0;
}

/** The Slack limits with the admin's setting applied (R7); read only when a workspace is created. */
/**
 * Before a Slack thread workspace is charged: a member at the limit first gives back the slots their finished developer
 * tasks still hold (the counter is shared, so they count here too). Best effort; never fails the request.
 */
async function healSlackMemberSlots(dependencies: AwsBrokerDependencies, orgId: OrgId, requester: { teamId: string; userId: string }, effective: SlackServiceConfiguration): Promise<void> {
  try {
    const key = slackMemberLimitKey(orgId, requester.teamId, requester.userId);
    const member = await getItem<{ count?: number }>(dependencies, key);
    if ((member?.count ?? 0) < effective.memberWorkspaceLimit) return;
    await releaseFinishedTasksOf(releaseDependenciesOf(dependencies, Date.now() + OUTCOME_SETTLE_PASS_MS), key);
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "developer.finished_task_heal_failed", error: error instanceof Error ? error.name : "unknown" }));
  }
}

async function effectiveSlackLimits(dependencies: AwsBrokerDependencies, orgId: OrgId, configured: SlackServiceConfiguration): Promise<SlackServiceConfiguration> {
  const limits = await readWorkspaceLimits(dependencies.documentClient, dependencies.tableName, orgId, {
    member: configured.memberWorkspaceLimit,
    organization: configured.organizationWorkspaceLimit,
  });
  return { ...configured, memberWorkspaceLimit: limits.member, organizationWorkspaceLimit: limits.organization };
}

async function recordThreadRequester(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspaceId: string,
  starter: boolean,
): Promise<void> {
  const slack = identity.slack;
  if (!slack) return;
  await dependencies.documentClient.send(new UpdateCommand({
    TableName: dependencies.tableName,
    Key: await resolveSlackThreadKey(dependencies, requireOrgId(identity.orgId), identity.ownerKey),
    UpdateExpression: [
      "SET #entity = :entity, #thread = if_not_exists(#thread, :thread), #workspace = if_not_exists(#workspace, :workspace)",
      ...(starter ? [", #starter = if_not_exists(#starter, :user), #creator = if_not_exists(#creator, :creator)"] : []),
      " ADD #requesters :users",
    ].join(""),
    ExpressionAttributeNames: {
      "#entity": "entityType",
      "#thread": "thread",
      "#workspace": "workspaceId",
      "#requesters": "requesters",
      ...(starter ? { "#starter": "starterUserId", "#creator": "creator" } : {}),
    },
    ExpressionAttributeValues: {
      ":entity": "SLACK_THREAD",
      ":thread": identity.subject,
      ":workspace": workspaceId,
      ":users": new Set([slack.requester.userId]),
      ...(starter ? { ":user": slack.requester.userId, ":creator": { userId: slack.requester.userId, ...(slack.requesterName === undefined ? {} : { name: slack.requesterName }) } } : {}),
    },
  }));
}

/** The login of the GitHub account a developer linked (C55: the name a pull request footer uses when the display name is an email address). */
export async function githubLoginOfDeveloper(dependencies: AwsBrokerDependencies, developerId: string): Promise<string | undefined> {
  const developer = dependencies.developer;
  if (developer === undefined) return undefined;
  return githubLoginOf(new DeveloperSignInStore({ documentClient: dependencies.documentClient, tableName: developer.signInTableName, now: Date.now }), developerId);
}

/** A pull request body with who asked for it: the developer footer (FR-023) or the Slack thread. */
export async function attributedBody(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  body: string | undefined,
): Promise<string | undefined> {
  if (identity.developer) {
    // A Rovara Code (version 2) description is built with its own markers and never says AgentX, so its footer doesn't either.
    // C55: never the requester's email address: their display name, else their linked GitHub login (read only when the name is an address), else "the task owner".
    const login = personNameForText(identity.developer.name) !== undefined ? undefined : await githubLoginOfDeveloper(dependencies, identity.developer.developerId);
    const footer = developerFooter(identity.developer.name, identity.developer.client, body?.includes(ROVARA_STATUS_START) === true ? "Rovara" : "AgentX", login);
    const attributed = body ? `${body}\n\n---\n${footer}` : footer;
    return Buffer.byteLength(attributed, "utf8") <= 32_768 ? attributed : body;
  }
  const slack = identity.slack;
  if (!slack) return body;
  const thread = await getItem<{ requesters?: Iterable<string> }>(dependencies, await resolveSlackThreadKey(dependencies, requireOrgId(identity.orgId), identity.ownerKey));
  const requesters = [...new Set([...(thread?.requesters ?? []), slack.requester.userId])].sort();
  const link = `https://slack.com/archives/${slack.thread.channelId}/p${slack.thread.threadTs.replace(".", "")}`;
  const attribution = `Requested in Slack thread ${link} by ${requesters.join(", ")}.`;
  const attributed = body ? `${body}\n\n---\n${attribution}` : attribution;
  return Buffer.byteLength(attributed, "utf8") <= 32_768 ? attributed : body;
}

/** C13: who started an operation from a shared thread, for the developer's TASK_BUSY (C14). */
export function channelOperation(dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity): ExtraItems {
  const shared = identity.sharedTask as (NonNullable<AuthenticatedIdentity["sharedTask"]> & { peopleAccessBound?: true; peopleRevision?: number }) | undefined;
  const slack = identity.slack;
  if (shared?.state !== "continue" || slack === undefined) return () => [];
  return (operation) => [{ Put: {
    TableName: dependencies.tableName,
    Item: {
      pk: `DEVTASK#${shared.taskId}`, sk: `CHANNEL_OPERATION#${operation.id}`, entityType: "CHANNEL_OPERATION",
      slackUserId: slack.requester.userId, ...(slack.requesterName === undefined ? {} : { name: slack.requesterName }), createdAt: operation.createdAt,
      // 25c note 2: the State table's TTL attribute, 30 days on; the busy read needs it only while the
      // operation runs. Shared threads exist only in named environments, whose State table expires on it.
      [INDEX_EXPIRY_ATTRIBUTE]: indexExpiresAt(operation.createdAt),
    },
    ConditionExpression: "attribute_not_exists(pk)",
  } }, ...(shared.peopleAccessBound === true ? [taskAccessFence(dependencies.tableName, shared.taskId, shared.peopleRevision)] : [])];
}

/** Who asked, for the operation record (FR-022): a Slack member or a developer. */
export function requesterOf(identity: AuthenticatedIdentity): { requestedBy?: OperationRequester } {
  if (identity.slack) return { requestedBy: identity.slack.requester };
  if (identity.developer) return { requestedBy: { kind: "developer", developerId: identity.developer.developerId, provider: identity.developer.provider } };
  return {};
}

/** Connector calls come from Slack turns only; their context keeps the Slack requester alone (R13). */
export function slackRequesterOf(identity: AuthenticatedIdentity): { requestedBy?: SlackRequester } {
  return identity.slack ? { requestedBy: identity.slack.requester } : {};
}

/** Attempts at a thread's retry: a release or another retry that commits meanwhile is decided again once. */
const THREAD_RETRY_ATTEMPTS = 2;

/**
 * #213: a thread's failed preparation gave its charge back (releaseFailedPreparation), so its
 * retry charges again, as a first preparation does: the member who asked and the organization,
 * refused at either limit, with the workspace left failed and uncharged. A failure recorded before
 * #213, or one whose release did not land, still holds its starter's charge, and that retry is held
 * to it, so a release that commits meanwhile cancels the retry instead of leaving a preparing
 * workspace uncharged. A racing retry that won is answered with the workspace as it now stands.
 */
async function retryThreadPreparation(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  requestId: string,
  project: RegisteredProjectRecord,
  workspace: WorkspaceInstance,
  includeOpenTaskCount: boolean,
): Promise<{ status: WorkspaceInstance["status"]; operationId: string | null } | SlackThreadWorkspaceResult> {
  const slack = identity.slack;
  const limits = dependencies.slack;
  if (!slack || !limits) throw agentXError("FORBIDDEN", "a Slack thread identity is required");
  let current = workspace;
  for (let attempt = 0; attempt < THREAD_RETRY_ATTEMPTS; attempt += 1) {
    const thread = await getItem<{ starterUserId?: unknown }>(dependencies, await resolveSlackThreadKey(dependencies, requireOrgId(identity.orgId), identity.ownerKey));
    const starter = typeof thread?.starterUserId === "string" ? thread.starterUserId : undefined;
    const effective = starter === undefined ? await effectiveSlackLimits(dependencies, requireOrgId(identity.orgId), limits) : undefined;
    if (effective !== undefined) await healSlackMemberSlots(dependencies, requireOrgId(identity.orgId), slack.requester, effective);
    const charge: TransactItems = effective === undefined
      ? [{ ConditionCheck: {
        TableName: dependencies.tableName,
        Key: await resolveSlackThreadKey(dependencies, requireOrgId(identity.orgId), identity.ownerKey),
        ConditionExpression: "starterUserId = :user",
        ExpressionAttributeValues: { ":user": starter },
      } }]
      : threadChargeItems(dependencies, identity, effective, current.id, await resolveSlackThreadKey(dependencies, requireOrgId(identity.orgId), identity.ownerKey));
    try {
      const retried = await retryWorkspacePreparation(dependencies, identity, requestId, identity.ownerKey, project, current, charge);
      return { status: "PREPARING", operationId: retried.operationId };
    } catch (error) {
      if (!isConditional(error)) throw error;
      current = await requireWorkspace(dependencies, workspace.id);
      if (current.status !== "PREPARATION_FAILED" || current.activeOperationId) {
        return { status: current.status, operationId: current.activeOperationId ?? null };
      }
      if (effective !== undefined) {
        // threadWorkspaceLimitRefusal throws its own WORKSPACE_BUSY when no limit is reached.
        try {
          const refusal = await threadWorkspaceLimitRefusal(dependencies, requireOrgId(identity.orgId), slack.requester.teamId, slack.requester.userId, effective, includeOpenTaskCount);
          if (refusal.outcome === "LIMIT_REACHED") return refusal;
        } catch (refusalError) {
          if (!(refusalError instanceof AgentXError) || refusalError.code !== "WORKSPACE_BUSY") throw refusalError;
        }
      }
    }
  }
  throw agentXError("WORKSPACE_BUSY", "thread workspace preparation conflicted with another request; retry");
}

export async function retryWorkspacePreparation(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  requestId: string,
  targetOwnerKey: string,
  project: RegisteredProjectRecord,
  workspace: WorkspaceInstance,
  /** Items that join the retry's transaction: a Slack thread's charge, or its check (#213). */
  extra: TransactItems = [],
): Promise<{
  operationId: string;
  workspace: ReturnType<typeof publicWorkspace>;
  alreadyReady: false;
}> {
  const metaPrepare = await metaPrepareOf(dependencies, project, requireOrgId(identity.orgId));
  const now = new Date().toISOString();
  const operationId = randomUUID();
  const fence = workspace.fence + 1;
  const operation = operationRecord({
    ...operationOrg(workspace),
    id: operationId,
    workspaceId: workspace.id,
    kind: "prepare",
    requestId,
    payloadHash: hashJson({
      projectName: workspace.projectName,
      projectRevision: workspace.projectRevision,
      targetOwnerKey,
    }),
    status: "ACCEPTED",
    fence,
    createdAt: now,
    updatedAt: now,
    ...requesterOf(identity),
  });
  if (metaPrepare.knowledgeCommit !== undefined) operation.knowledgeCommit = metaPrepare.knowledgeCommit;
  const invocation: WorkerInvocation = {
    protocolVersion: 1,
    kind: "prepare",
    operationId,
    workspaceId: workspace.id,
    fence,
    projectRevision: workspace.projectRevision,
    callbackCapability: issueCapability(dependencies, workspace.id, operationId, fence),
    payload: {
      project: workerProjectDefinition(project.definition),
      repositoryGrant: issueRepositoryGrant(
        dependencies,
        project,
        targetOwnerKey,
        workspace.id,
        operationId,
      ),
      ...(metaPrepare.meta === undefined ? {} : { meta: metaPrepare.meta }),
      ...registriesPrepareOf(dependencies, project, { orgId: requireOrgId(identity.orgId) }),
    },
  };
  const updated = WorkspaceInstanceSchema.parse({
    ...workspace,
    status: "PREPARING",
    activeOperationId: operationId,
    fence,
    updatedAt: now,
  });
  const outbox = outboxRecord(updated, invocation, project.runtimeBinding);
  await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
    { Update: {
      TableName: dependencies.tableName,
      Key: workspaceKey(workspace.id),
      UpdateExpression: "SET #status = :preparing, activeOperationId = :operation, fence = :nextFence, updatedAt = :now",
      ConditionExpression: "#status = :failed AND attribute_not_exists(activeOperationId) AND fence = :currentFence",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":preparing": "PREPARING",
        ":failed": "PREPARATION_FAILED",
        ":operation": operationId,
        ":nextFence": fence,
        ":currentFence": workspace.fence,
        ":now": now,
      },
    } },
    { Put: { TableName: dependencies.tableName, Item: operation, ConditionExpression: "attribute_not_exists(pk)" } },
    { Put: { TableName: dependencies.tableName, Item: outbox, ConditionExpression: "attribute_not_exists(pk)" } },
    { Put: {
      TableName: dependencies.tableName,
      Item: {
        pk: `IDEMPOTENCY#${identity.ownerKey}#ADMIN`,
        sk: `REQUEST#${requestId}`,
        entityType: "IDEMPOTENCY",
        operationId,
        workspaceId: workspace.id,
      },
      ConditionExpression: "attribute_not_exists(pk)",
    } },
    ...extra,
  ] }));
  return { operationId, workspace: publicWorkspace(updated), alreadyReady: false };
}
