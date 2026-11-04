// Part of the broker (split out of ../broker.ts): workspace preparation, Slack identities, shared threads and Slack bindings.

import { fixtureDigestsOfPlan } from "../../test-env/fixture-lookup.js";
import { approvalGrantChange } from "../../org/approval-membership.js";
import { randomUUID } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { registriesPrepareOf } from "./registry-credentials.js";
import { savedEnvPrepareOf } from "./saved-env-prepare.js";
import { AgentXError, DEVELOPER_TASK_OWNER_ISSUER, type TaskDependencyPlan, SharedTaskRecordSchema, sharedTaskKey, type SharedTaskRecord, SLACK_THREAD_OWNER_ISSUER, SlackChannelBindingSchema, SlackChannelIdSchema, SlackRequesterSchema, SlackTeamIdSchema, WorkspaceInstanceSchema, agentXError, parseSlackThreadSubject, slackThreadSubject, workspaceRecordFields, type SlackChannelBinding, type SlackThread, type WorkerInvocation, type WorkspaceInstance, cleanDisplayName, emailSafeName, DISPLAY_NAME_MAX_ENCODED_LENGTH, OrgIdSchema, type OrgRole, type ProjectRole, projectMemberKey, defaultWorkspaceKey, slackBindingKey, type RunCheckout, type OrgId, auditOperatorId, workerProjectDefinition, metaRepositoryOf, type CodeHost, type PreparePins, type TestEnvProdDeny } from "@agentx/contracts";
import type { AuthenticatedIdentity } from "../../auth.js";
import { auditPending, tryAuditEvent } from "../../audit/outbox.js";
import { flushAuditEvents } from "../../audit/flush.js";
import { auditOccurrence, auditSlackChannelBound, auditSlackChannelUnbound, auditSlackTeamConnected, auditSlackTeamDisconnected } from "../../audit/events.js";
import { requireOrgId } from "../../org/resolve.js";
import { listTeamChannels, readSlackBinding, slackBindingItem } from "../../org/slack-binding.js";
import { getItem, issueCapability, operationKey, operationOrg, operationRecord, outboxRecord, requireOperation } from "../cancellation.js";
import { effectiveProjectRole, viewerCannotStartTasksMessage } from "../../developer/project-roles.js";
import { effectiveTaskOwner, taskKey, taskOwnerKey, taskOwnerSubject, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { requirePerson } from "../../developer/system-owner.js";
import { hashJson } from "../broker-shared.js";
import { developerIdForSlackUser } from "../admin-actions.js";
import { taskSpendBaseline } from "../../org/budget.js";
import { orgRoleOf } from "../../agents/access.js";
import type { SpendRequestHost } from "../../spend/requests.js";
import type { AgentRouteDependencies } from "../../agents/routes.js";
import { developerTaskRouteDependencies, type DeveloperCaller } from "../developer-routes.js";
import type { DeveloperTaskActions, ExtraItems, TransactItems } from "../developer-task-actions.js";
import { continueAsTask, prepareTaskApprovalAdmission, resumeTaskAfterSpendApproval } from "../developer-tasks.js";
import { isAssumedRoleOf, ownerKeyForSubject, type AdaptedHttpRequest } from "../lambda.js";
import type { TaskAccess } from "../../developer/task-access.js";
import { taskAccessFence } from "../../developer/task-people.js";
import { issueRepositoryGrant, membershipRecord, object, workspaceItem, workspaceKey, workspaceRuntime } from "./admin-and-helpers.js";
import type { AwsBrokerDependencies, MembershipRecord, RegisteredProjectRecord } from "./definitions.js";
import { developerTaskActions, orgStoreOf, requireSlackAllowedByEdition, requireSlackRequesterWriterRole, slackRequesterStanding, slackTeamOrg, type RequesterStanding } from "./dependency-wiring.js";
import { getMembership, requireAdministrator, requireLatestProject, requireWorkspace } from "./records.js";
import { ensureInstallOrg } from "./scope-helpers.js";
import { slackTaskAccess } from "./slack-workflow-events.js";
import { requesterOf } from "./thread-workspaces.js";
import { metaPrepareFor, needsMetaCheckout, type MetaHeadReader } from "../../meta-repo/prepare-meta.js";
import { canReadBaseBranchHead, hostOfRepository } from "./repository-hosts.js";
import { githubScope } from "./scope-helpers.js";
import { pinsStillAtHead, setupPinsOf } from "./setup-pins.js";

/** Meta repo lane A: reads a meta repository's default-branch head through the code host the repository's record names (P6: the port's `baseBranchHead`). Undefined where that host cannot be asked (a project with a meta repo is then refused). */
export function metaHeadReaderOf(dependencies: AwsBrokerDependencies, host: CodeHost): MetaHeadReader | undefined {
  if (!canReadBaseBranchHead(dependencies, host)) return undefined;
  return { getHead: ({ orgId, repositoryUrl, branch }) => host.baseBranchHead({ url: repositoryUrl }, branch, githubScope(dependencies, orgId)) };
}

/** The `meta` request and the commit the broker pinned for it, for a project whose meta repository is a separate one; nothing otherwise. */
export async function metaPrepareOf(dependencies: AwsBrokerDependencies, project: RegisteredProjectRecord, orgId: OrgId | undefined) {
  if (!needsMetaCheckout(project.definition)) return metaPrepareFor(project.definition, undefined, orgId);
  // The head of the meta repository's default branch is read from the code host its RECORD names (P6; P5e had it GitHub's alone). An unknown host kind is refused with the router's fixed sentence,
  // and is not turned into "cannot read just now".
  const host = hostOfRepository(dependencies, metaRepositoryOf(project.definition)!);
  return metaPrepareFor(project.definition, metaHeadReaderOf(dependencies, host), orgId);
}

/** Attempts to create a workspace around a project membership that another request keeps changing; the registration retry style. */
export const MEMBERSHIP_PREPARATION_ATTEMPTS = 3;

/** True when the membership row is no longer the one a transaction was built from: gone, created, or another role or grantId. */
export async function membershipMovedSince(dependencies: AwsBrokerDependencies, orgId: OrgId, ownerKey: string, projectName: string, observed: MembershipRecord | undefined): Promise<boolean> {
  const current = await getMembership(dependencies, orgId, ownerKey, projectName);
  return current?.role !== observed?.role || current?.grantId !== observed?.grantId;
}

/**
 * The transaction item for the membership of a workspace's owner, decided from the row as it was read. An absent row is created as a
 * developer, only if still absent. An existing row keeps its role and grantId: the item only requires it to be as it was read (a legacy row with no
 * grantId also gains one).
 */
export function membershipPreparationItem(
  dependencies: AwsBrokerDependencies,
  orgId: OrgId,
  ownerKey: string,
  projectName: string,
  observed: MembershipRecord | undefined,
  grantedBy?: unknown,
): TransactItems[number] {
  if (observed === undefined) {
    const created: MembershipRecord = { ...membershipRecord(orgId, ownerKey, projectName, "developer"), ...(grantedBy === undefined ? {} : { grantedBy, grantedAt: new Date().toISOString() }) };
    return { Put: { TableName: dependencies.tableName, Item: created, ConditionExpression: "attribute_not_exists(pk)" } };
  }
  const key = projectMemberKey(orgId, ownerKey, projectName);
  // A row from before grants were versioned has no grantId. It gets one here, in the same transaction, and keeps everything else it has;
  // the condition lets it happen only to the row that was read, and never replaces a grantId that exists.
  if (typeof observed.grantId !== "string") {
    return { Update: {
      TableName: dependencies.tableName,
      Key: key,
      UpdateExpression: "SET grantId = :grantId",
      ConditionExpression: "#role = :role AND attribute_not_exists(grantId)",
      ExpressionAttributeNames: { "#role": "role" },
      ExpressionAttributeValues: { ":role": observed.role, ":grantId": randomUUID() },
    } };
  }
  return { ConditionCheck: {
    TableName: dependencies.tableName,
    Key: key,
    ConditionExpression: "#role = :role AND grantId = :grantId",
    ExpressionAttributeNames: { "#role": "role" },
    ExpressionAttributeValues: { ":role": observed.role, ":grantId": observed.grantId },
  } };
}

export async function newWorkspacePreparation(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  project: RegisteredProjectRecord,
  targetOwnerKey: string,
  requestId: string,
  options: { checkout?: readonly RunCheckout[]; readOnly?: boolean; setupDraft?: boolean; pinHeads?: boolean; pins?: PreparePins; grantedBy?: unknown; testEnvPin?: { revision: number; digest: string }; testServices?: readonly TaskDependencyPlan[]; testServicesDeny?: TestEnvProdDeny } = {},
): Promise<{ workspace: WorkspaceInstance; operationId: string; items: TransactItems; membership: MembershipRecord | undefined; pins?: PreparePins }> {
  const projectName = project.definition.name;
  const projectRevision = project.definition.revision;
  // Meta repo lane A: read before anything is written, so a meta repo that cannot be read refuses the start.
  // A setup draft reads the meta repo whole, as an ordinary read-only checkout of the project (so no sparse `meta` request, no head to read, no `prepare.metaRepo` needed).
  const metaPrepare = options.setupDraft === true ? {} as Awaited<ReturnType<typeof metaPrepareOf>> : await metaPrepareOf(dependencies, project, requireOrgId(identity.orgId));
  // P1 (su): a setup run's heads are read by the broker and pinned (setup-pins.ts), before anything is written.
  // SU-1 addendum 3: given pins (the commits a setup run used) must still be the heads; else the heads are read now (a meta repository only for a setup draft's preparation).
  const pins = options.pins !== undefined ? await pinsStillAtHead(dependencies, project, requireOrgId(identity.orgId), options.pins)
    : options.pinHeads === true ? await setupPinsOf(dependencies, project, requireOrgId(identity.orgId), options.setupDraft === true) : undefined;
  const now = new Date().toISOString();
  const workspaceId = randomUUID();
  const operationId = randomUUID();
  const workspace = WorkspaceInstanceSchema.parse({
    id: workspaceId,
    ownerKey: targetOwnerKey,
    orgId: requireOrgId(identity.orgId),
    projectName,
    projectRevision,
    ...workspaceRuntime(project.runtimeBinding),
    rootPath: "/mnt/workspace",
    status: "PREPARING",
    activeOperationId: operationId,
    fence: 1,
    createdAt: now,
    updatedAt: now,
  });
  // Saved environments (SH25): the image this task's preparation may pull (a reference only; the worker asks for the login at pull time). Only a developer task's start sends a pin, and never a setup draft.
  const savedEnv = await savedEnvPrepareOf(dependencies, project, { readOnly: options.readOnly === true, orgId: requireOrgId(identity.orgId), setupDraft: options.setupDraft === true, testEnvPin: options.testEnvPin });
  const operation = operationRecord({
    ...operationOrg(workspace),
    id: operationId,
    workspaceId,
    kind: "prepare",
    requestId,
    payloadHash: hashJson({ projectName, projectRevision, targetOwnerKey }),
    status: "ACCEPTED",
    fence: workspace.fence,
    createdAt: now,
    updatedAt: now,
    ...requesterOf(identity),
  });
  if (metaPrepare.knowledgeCommit !== undefined) operation.knowledgeCommit = metaPrepare.knowledgeCommit;
  // The digest this operation was told to pull is kept with the operation, so the login exchange gives a login for THAT image only and never for one the worker names.
  if (savedEnv.savedEnv !== undefined) operation.savedEnvDigest = savedEnv.savedEnv.digest;
  if (pins !== undefined) operation.preparePins = pins;
  // Test services (slice 3): a candidate check whose plan has a fake may ask for that set's read address and no other (the capability has the action only then).
  const fixtureDigests = fixtureDigestsOfPlan({ dependencies: options.testServices });
  if (fixtureDigests.length > 0) operation.fixtureSetDigests = fixtureDigests;
  // The proposal's own production list (the project may have no approved environment yet): the fixture-set callback scans with the union of this and the approved environment's.
  if (fixtureDigests.length > 0 && options.testServicesDeny !== undefined) operation.fixtureProdDeny = options.testServicesDeny;
  const invocation: WorkerInvocation = {
    protocolVersion: 1,
    kind: "prepare",
    operationId,
    workspaceId,
    fence: workspace.fence,
    projectRevision,
    callbackCapability: issueCapability(dependencies, workspaceId, operationId, workspace.fence, fixtureDigests.length > 0 ? { fixtureDelivery: true } : {}),
    payload: {
      project: workerProjectDefinition(project.definition, options.setupDraft === true ? { includeMeta: true } : {}),
      repositoryGrant: issueRepositoryGrant(
        dependencies,
        project,
        targetOwnerKey,
        workspaceId,
        operationId,
      ),
      // An agent-step run that looks at a pull request: the worker checks each head out, read-only, after cloning (Plan 3, Task 22).
      ...(options.checkout === undefined || options.checkout.length === 0 ? {} : { checkout: [...options.checkout] }),
      // An agent-step run's preparation clones and checks out only; none of the repository's code runs (final fix wave, runs I-2).
      ...(options.readOnly === true ? { readOnly: true as const } : {}),
      ...(metaPrepare.meta === undefined ? {} : { meta: metaPrepare.meta }),
      ...(pins === undefined ? {} : { pins }),
      // Test services: a candidate check's dependencies (pinned; no secret). Nothing for any other preparation.
      ...(options.testServices === undefined || options.testServices.length === 0 ? {} : { testServices: { dependencies: [...options.testServices] } }),
      // N9 (INTG2): the project's registries (where, never a credential), only for a run that runs the project's code.
      ...registriesPrepareOf(dependencies, project, { readOnly: options.readOnly === true, orgId: requireOrgId(identity.orgId) }),
      ...savedEnv,
    },
  };
  const outbox = outboxRecord(workspace, invocation, project.runtimeBinding);
  const existingMembership = await getMembership(dependencies, requireOrgId(identity.orgId), targetOwnerKey, projectName);
  return {
    workspace,
    operationId,
    membership: existingMembership,
    ...(pins === undefined ? {} : { pins }),
    items: [
      { Put: { TableName: dependencies.tableName, Item: workspaceItem(requireOrgId(identity.orgId), workspace), ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: dependencies.tableName, Item: { ...defaultWorkspaceKey(requireOrgId(identity.orgId), targetOwnerKey, projectName), entityType: "DEFAULT_WORKSPACE", workspaceId }, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: dependencies.tableName, Item: operation, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: dependencies.tableName, Item: outbox, ConditionExpression: "attribute_not_exists(pk)" } },
      // The target's membership is created here only when absent, recording who granted it; an existing row is required to be as it was read, never rewritten.
      membershipPreparationItem(dependencies, requireOrgId(identity.orgId), targetOwnerKey, projectName, existingMembership, options.grantedBy),
      ...(existingMembership === undefined || typeof existingMembership.grantId !== "string"
        ? await approvalGrantChange({ ...dependencies, now: () => new Date(now) }, requireOrgId(identity.orgId), projectName, false) : []),
    ],
  };
}

/**
 * Plan 3, Task 32: the spend requests' host. The resume and continue-as-task act as the task's owner (a retry or a Continue is theirs), with the owner's
 * live sign-in record and org role; a revoked or departed owner gets nothing resumed. What a task's keys spent is the proxy's figure.
 */
export function spendRequestHostOf(dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, agents: AgentRouteDependencies): SpendRequestHost {
  const asOwner = async (orgId: OrgId, developerId: string, orgRole?: OrgRole) => {
    // Nothing acts AS a project's system owner (automatic runs): a spend request or a Continue is a person's.
    requirePerson(developerId, "act as the owner");
    const developer = dependencies.developer;
    if (developer === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "developer sign-in is not set up in this deployment");
    const record = await agents.signInStore.getDeveloper(developerId);
    const role = orgRole ?? await orgRoleOf(agents, orgId, developerId);
    if (record === undefined || record.revoked || role === undefined) throw agentXError("FORBIDDEN", "the task's owner can't act in this organization now");
    const caller: DeveloperCaller = {
      developerId, sessionId: "spend-request", amr: record.provider, name: record.displayName, orgId, orgRole: role,
      ...(record.slackUserId === undefined ? {} : { slackUserId: record.slackUserId }),
    };
    const deps = developerTaskRouteDependencies({
      documentClient: dependencies.documentClient, tableName: dependencies.tableName, developer, now: Date.now, tasks, orgs: orgStoreOf(dependencies), agents,
      ...(dependencies.modelAccess === undefined ? {} : { modelAccess: dependencies.modelAccess.access }),
      ...(dependencies.cloud === true ? { cloud: true } : {}),
    }, caller);
    return { deps, caller };
  };
  return {
    prepareApprovalAdmission: async (input) => {
      const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(input.taskId));
      if (task === undefined || task.orgId !== input.orgId) throw agentXError("TASK_NOT_FOUND", "The task is no longer available.");
      const { deps, caller } = await asOwner(input.orgId, effectiveTaskOwner(task).developerId);
      return prepareTaskApprovalAdmission(deps, caller, input);
    },
    resumeTask: async (input) => {
      const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(input.taskId));
      if (task === undefined || task.orgId !== input.orgId) return;
      const { deps, caller } = await asOwner(input.orgId, effectiveTaskOwner(task).developerId);
      return resumeTaskAfterSpendApproval(deps, caller, input);
    },
    continueAsTask: async (caller, taskId, body) => {
      const { deps, caller: owner } = await asOwner(caller.orgId, caller.developerId, caller.orgRole);
      return continueAsTask(deps, owner, taskId, body);
    },
    ...(dependencies.modelAccess === undefined ? {} : {
      taskSpentUsd: (keyIds: readonly string[]) => taskSpendBaseline({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, access: dependencies.modelAccess!.access }, keyIds),
    }),
  };
}

/**
 * Plan 3, Task 32: the outbox item that sends the preparation a run held at its start was given (Task 15's paused start wrote the workspace and the
 * operation but no outbox item). The invocation is built now, as `newWorkspacePreparation` builds one, with a new capability and repository grant for the
 * same operation and fence; the put is conditional on there being none yet. The workspace must still be PREPARING with that preparation active.
 */
export async function heldPreparationDispatch(
  dependencies: AwsBrokerDependencies, project: RegisteredProjectRecord, workspaceId: string, operationId: string, ownerKey: string,
  options: { checkout?: readonly RunCheckout[]; readOnly?: boolean; setupDraft?: boolean; pinHeads?: boolean; testEnvPin?: { revision: number; digest: string } } = {},
): Promise<{ workspace: WorkspaceInstance; items: TransactItems }> {
  const workspace = await requireWorkspace(dependencies, workspaceId);
  const operation = await requireOperation(dependencies, workspaceId, operationId);
  if (workspace.status !== "PREPARING" || workspace.activeOperationId !== operationId || operation.kind !== "prepare" || operation.status !== "ACCEPTED" || operation.fence !== workspace.fence) {
    throw agentXError("STALE_FENCE", "the held preparation is no longer this workspace's");
  }
  const metaPrepare = options.setupDraft === true ? {} as Awaited<ReturnType<typeof metaPrepareOf>> : await metaPrepareOf(dependencies, project, workspace.orgId);
  const savedEnv = await savedEnvPrepareOf(dependencies, project, { readOnly: options.readOnly === true, orgId: workspace.orgId, setupDraft: options.setupDraft === true, testEnvPin: options.testEnvPin });
  // P1 (su): a setup run's heads are read again now and replace the pins its start kept on the operation (setup-pins.ts).
  const pins = options.pinHeads === true ? await setupPinsOf(dependencies, project, requireOrgId(workspace.orgId)) : undefined;
  const invocation: WorkerInvocation = {
    protocolVersion: 1, kind: "prepare", operationId, workspaceId, fence: workspace.fence, projectRevision: project.definition.revision,
    callbackCapability: issueCapability(dependencies, workspaceId, operationId, workspace.fence),
    payload: {
      project: workerProjectDefinition(project.definition, options.setupDraft === true ? { includeMeta: true } : {}),
      repositoryGrant: issueRepositoryGrant(dependencies, project, ownerKey, workspaceId, operationId),
      ...(options.checkout === undefined || options.checkout.length === 0 ? {} : { checkout: [...options.checkout] }),
      // An agent-step run's preparation clones and checks out only; none of the repository's code runs (final fix wave, runs I-2).
      ...(options.readOnly === true ? { readOnly: true as const } : {}),
      ...(metaPrepare.meta === undefined ? {} : { meta: metaPrepare.meta }),
      ...(pins === undefined ? {} : { pins }),
      ...registriesPrepareOf(dependencies, project, { readOnly: options.readOnly === true, orgId: workspace.orgId }),
      ...savedEnv,
    },
  };
  const pinHeadsItem: TransactItems = pins === undefined ? [] : [{ Update: {
    TableName: dependencies.tableName, Key: operationKey(workspaceId, operationId), UpdateExpression: "SET preparePins = :pins",
    ConditionExpression: "attribute_exists(pk)", ExpressionAttributeValues: { ":pins": pins },
  } }];
  const pinKnowledge: TransactItems = metaPrepare.knowledgeCommit === undefined ? [] : [{ Update: {
    TableName: dependencies.tableName, Key: operationKey(workspaceId, operationId), UpdateExpression: "SET knowledgeCommit = :commit",
    ConditionExpression: "attribute_exists(pk)", ExpressionAttributeValues: { ":commit": metaPrepare.knowledgeCommit },
  } }];
  const pinSavedEnv: TransactItems = savedEnv.savedEnv === undefined ? [] : [{ Update: {
    TableName: dependencies.tableName, Key: operationKey(workspaceId, operationId), UpdateExpression: "SET savedEnvDigest = :digest",
    ConditionExpression: "attribute_exists(pk)", ExpressionAttributeValues: { ":digest": savedEnv.savedEnv.digest },
  } }];
  return { workspace, items: [...pinKnowledge, ...pinHeadsItem, ...pinSavedEnv, { Put: { TableName: dependencies.tableName, Item: outboxRecord(workspace, invocation, project.runtimeBinding), ConditionExpression: "attribute_not_exists(pk)" } }] };
}

/**
 * The project role of the Slack person behind a thread request (Plan 2, Task 21): their live org role, their own grant on the bound project
 * (a viewer's included, which wins) and, failing both, the bound channel they are speaking in, which makes them a contributor.
 */
export async function slackRequesterRole(dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity): Promise<ProjectRole> {
  const slack = identity.slack;
  if (slack === undefined) return "contributor";
  return slackRequesterProjectRole(dependencies, requireOrgId(identity.orgId), slack.requester.userId, slack.binding.projectName);
}

/** The Slack person's project role in the team's org, by the one requester rule (see requireSlackRequesterWriterRole): refused outright when they are not a current writer there. */
export async function slackRequesterProjectRole(dependencies: AwsBrokerDependencies, orgId: OrgId, userId: string, projectName: string): Promise<ProjectRole> {
  return (await slackRequesterProjectAccess(dependencies, orgId, userId, projectName)).role;
}

/** `slackRequesterProjectRole`, and the standing the check read (SY-7), for a caller that mints money for the person and re-asserts it in its own write. */
export async function slackRequesterProjectAccess(dependencies: AwsBrokerDependencies, orgId: OrgId, userId: string, projectName: string): Promise<{ role: ProjectRole; standing: RequesterStanding }> {
  const developerId = developerIdForSlackUser(userId);
  // The one rule for the requester's own identity, shared with the ingress callers (slackCallerFor): their org must be the team's, the company sign-in must allow them, their role is read
  // under every id they answer to (a merge), and the Auditor, a role this release does not know, a record with no role and a missing record outside a single-org install are all refused.
  const { role: orgRole, ids, standing } = await slackRequesterStanding(dependencies, userId, orgId, { allowUnlinked: true });
  // The explicit grant is read under the id whose role wins, as the role is: the survivor's grant first, then back along the merge and link chain to the Slack id's own. The ids are the ones the
  // rule just walked and org-checked (not walked again here). An explicit grant (a viewer's included) is applied before channel access, so linking or merging a Slack identity into a
  // developer with a restrictive grant does not hand it the channel's contributor role.
  let grant: Awaited<ReturnType<typeof getMembership>>;
  for (const id of [...ids].reverse()) {
    grant = await getMembership(dependencies, orgId, id, projectName);
    if (grant !== undefined) break;
  }
  return { role: effectiveProjectRole({ developerId, orgRole }, grant, true) ?? "contributor", standing };
}

/**
 * Viewers only view (Plan 2, Task 21): a Slack person in their own thread (not a teammate in a shared task's thread, who was checked when the
 * identity was made) who holds the viewer role cannot change the project or start work. Called by every Slack service route that does either.
 */
export async function requireSlackRequesterMayWork(dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity, projectName: string): Promise<void> {
  if (identity.slack === undefined || identity.sharedTask !== undefined) return;
  if (await slackRequesterRole(dependencies, identity) === "viewer") throw agentXError("PROJECT_ACCESS_DENIED", viewerCannotStartTasksMessage(projectName));
}

/** The service routes' caller must be the Slack orchestrator's role. */
export function requireSlackServiceRole(dependencies: AwsBrokerDependencies, request: AdaptedHttpRequest): void {
  const configuration = dependencies.slack;
  if (!configuration) throw agentXError("NOT_FOUND", "route not found");
  if (!request.iamPrincipalArn || !isAssumedRoleOf(request.iamPrincipalArn, configuration.orchestratorRoleArn)) {
    throw agentXError("FORBIDDEN", "only the Slack orchestrator role may call service routes");
  }
}

export async function slackServiceIdentity(
  dependencies: AwsBrokerDependencies,
  request: AdaptedHttpRequest,
): Promise<AuthenticatedIdentity> {
  requireSlackServiceRole(dependencies, request);
  const context = parseSlackHeaders(request.headers);
  // The thread acts in the org its Slack team is bound to, and the channel binding is read only inside that org.
  const orgId = await slackTeamOrg(dependencies, context.thread.teamId);
  // Enterprise foundations I-6: the person acting through Slack must still be allowed by the company sign-in.
  await requireSlackAllowedByEdition(dependencies, context.requester.userId, orgId);
  const binding = await getSlackBinding(dependencies, orgId, context.thread.teamId, context.thread.channelId);
  if (!binding) throw agentXError("FORBIDDEN", "Slack channel is not bound to a project");
  // A person removed from the company (or banned), of another org, or with an unreadable role record is refused here, for every Slack service route (member removal), by the one requester rule
  // (requireSlackRequesterWriterRole): the routes that start or change work add the writer check on top (requireSlackRequesterMayWork), and the Auditor, who only reads, is let through here
  // alone. A person who never joined has no tombstone and is served as before.
  await requireSlackRequesterWriterRole(dependencies, context.requester.userId, orgId, { allowUnlinked: true, allowReadOnly: true });
  const subject = slackThreadSubject(context.thread);
  const threadOwnerKey = ownerKeyForSubject(SLACK_THREAD_OWNER_ISSUER, subject);
  const own: AuthenticatedIdentity = {
    issuer: SLACK_THREAD_OWNER_ISSUER,
    subject,
    ownerKey: threadOwnerKey,
    orgId,
    isAdministrator: false,
    claims: {},
    slack: { ...context, binding },
  };
  const shared = await sharedThread(dependencies, context.thread);
  if (shared === undefined) return own;
  const sharedTask = { taskId: shared.taskId, workspaceId: shared.workspaceId, developerName: emailSafeName(shared.developerName) ?? "a member" };
  // C11: open only while continue, not closed, and the channel still serves the task's project.
  // A Slack-started task's own thread is driven by its owner's buttons, never by the channel's chat agent: closed to it.
  if (!sharedThreadOpen(shared, binding)) {
    // The ordinary chat workspace stays closed; only a request for task mode (a read-only view with no tools) may use an open one.
    const taskAnswer = shared.workflowThread === true && shared.closedAt === undefined && binding.projectName === shared.project;
    return { ...own, sharedTask: { ...sharedTask, state: shared.closedAt !== undefined || shared.workflowThread === true ? "closed" : "view", ...(taskAnswer ? { taskAnswer: true as const } : {}) } };
  }
  if (dependencies.developer === undefined) throw agentXError("FORBIDDEN", "developer task workflows are not configured");
  let access: TaskAccess;
  try { ({ access } = await slackTaskAccess(dependencies, developerTaskActions(dependencies), shared.taskId, context.requester.userId, "comment")); }
  catch {
    // A person the task's rules still let read it (their role was lowered to viewer) is told what the thread's notice says: they have view-only access. Anyone else gets the plain refusal.
    const mayRead = await slackTaskAccess(dependencies, developerTaskActions(dependencies), shared.taskId, context.requester.userId, "read").then(() => true, () => false);
    throw agentXError("FORBIDDEN", mayRead ? "you have view-only access to this task, so this Slack member cannot continue it" : "this Slack member cannot continue the task");
  }
  if (access.task.share?.teamId !== context.thread.teamId || access.task.share.channelId !== context.thread.channelId
    || access.task.share.threadTs !== context.thread.threadTs) throw agentXError("FORBIDDEN", "this task belongs to another Slack thread");
  const authorizedSharedTask = { ...sharedTask, state: "continue" as const, peopleAccessBound: true as const, peopleRevision: access.peopleRevision };
  return {
    issuer: DEVELOPER_TASK_OWNER_ISSUER,
    subject: taskOwnerSubject(shared.developerId, shared.taskId),
    ownerKey: shared.ownerKey,
    orgId,
    isAdministrator: false,
    claims: {},
    // The teammate's Slack context: requesterOf records them on every operation (FR-054).
    slack: { ...context, binding },
    sharedTask: authorizedSharedTask,
  };
}

/** Spec 025 FR-035, FR-054: the thread's shared task record, or undefined for an ordinary thread. */
export async function sharedThread(dependencies: AwsBrokerDependencies, thread: SlackThread): Promise<SharedTaskRecord | undefined> {
  // Developer tasks exist only where developer sign-in is set up (D14); nothing else reads this key.
  if (dependencies.developer === undefined) return undefined;
  const item = await getItem<Record<string, unknown>>(dependencies, sharedTaskKey(thread));
  if (item === undefined) return undefined;
  const record = SharedTaskRecordSchema.safeParse(item);
  // Fail closed: an unreadable record must never let the thread act as an ordinary one.
  if (!record.success || record.data.ownerKey !== taskOwnerKey(record.data.developerId, record.data.taskId)) {
    throw agentXError("FORBIDDEN", "this thread's shared task record cannot be read; ask an admin");
  }
  return record.data;
}

/**
 * C11, F16: a shared thread acts on the task only in continue, before the close, while its channel serves the task's
 * project, and never when it is a Slack-started task's own thread (only its owner's buttons move that task).
 */
export function sharedThreadOpen(shared: SharedTaskRecord, binding: SlackChannelBinding): boolean {
  return shared.mode === "continue" && shared.closedAt === undefined && shared.workflowThread !== true && binding.projectName === shared.project;
}

function sharedStopForbidden(): never {
  throw agentXError("FORBIDDEN", "this shared thread is not bound to the task's workspace");
}

export async function verifiedSharedStopBinding(
  dependencies: AwsBrokerDependencies,
  thread: SlackThread,
  binding: SlackChannelBinding,
  shared: SharedTaskRecord,
): Promise<{ task: DeveloperTaskRecord; workspace: WorkspaceInstance }> {
  const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(shared.taskId));
  if (task === undefined || task.pk !== `DEVTASK#${shared.taskId}` || task.sk !== "META" || task.entityType !== "DEVELOPER_TASK"
    || task.taskId !== shared.taskId || task.developerId !== shared.developerId || task.ownerKey !== shared.ownerKey
    || task.ownerKey !== taskOwnerKey(task.developerId, task.taskId) || task.project !== shared.project
    || task.workspaceId !== shared.workspaceId || task.closedAt !== undefined || binding.projectName !== task.project
    || task.share?.teamId !== thread.teamId || task.share.channelId !== thread.channelId || task.share.threadTs !== thread.threadTs
    || task.share.mode !== shared.mode || !Number.isSafeInteger(task.shareVersion)) sharedStopForbidden();

  const workspaceItem = await getItem<Record<string, unknown>>(dependencies, workspaceKey(shared.workspaceId));
  const parsedWorkspace = workspaceItem === undefined
    ? undefined
    : WorkspaceInstanceSchema.safeParse(workspaceRecordFields(workspaceItem));
  if (parsedWorkspace === undefined || !parsedWorkspace.success || parsedWorkspace.data.id !== shared.workspaceId
    || parsedWorkspace.data.ownerKey !== task.ownerKey || parsedWorkspace.data.projectName !== task.project) sharedStopForbidden();
  return { task, workspace: parsedWorkspace.data };
}

export function sharedStopFences(
  dependencies: AwsBrokerDependencies,
  thread: SlackThread,
  shared: SharedTaskRecord,
  task: DeveloperTaskRecord,
  workspace: WorkspaceInstance,
  peopleRevision: number | undefined,
): ExtraItems {
  const taskShare = task.share!;
  return () => [
    { ConditionCheck: {
      TableName: dependencies.tableName,
      Key: taskKey(task.taskId),
      ConditionExpression: "taskId = :taskId AND developerId = :developerId AND ownerKey = :ownerKey AND #project = :project AND workspaceId = :workspaceId AND shareVersion = :shareVersion AND #share.#team = :team AND #share.#channel = :channel AND #share.#thread = :thread AND #share.#mode = :mode AND attribute_not_exists(closedAt)",
      ExpressionAttributeNames: { "#project": "project", "#share": "share", "#team": "teamId", "#channel": "channelId", "#thread": "threadTs", "#mode": "mode" },
      ExpressionAttributeValues: {
        ":taskId": task.taskId, ":developerId": task.developerId, ":ownerKey": task.ownerKey, ":project": task.project,
        ":workspaceId": workspace.id, ":shareVersion": task.shareVersion, ":team": taskShare.teamId, ":channel": taskShare.channelId,
        ":thread": thread.threadTs, ":mode": "continue",
      },
    } },
    { ConditionCheck: {
      TableName: dependencies.tableName,
      Key: sharedTaskKey(thread),
      ConditionExpression: "taskId = :taskId AND developerId = :developerId AND ownerKey = :ownerKey AND #project = :project AND workspaceId = :workspaceId AND #mode = :mode AND attribute_not_exists(closedAt) AND attribute_not_exists(workflowThread)",
      ExpressionAttributeNames: { "#project": "project", "#mode": "mode" },
      ExpressionAttributeValues: {
        ":taskId": shared.taskId, ":developerId": shared.developerId, ":ownerKey": shared.ownerKey, ":project": shared.project,
        ":workspaceId": workspace.id, ":mode": "continue",
      },
    } },
    { ConditionCheck: {
      TableName: dependencies.tableName,
      Key: workspaceKey(workspace.id),
      ConditionExpression: "ownerKey = :ownerKey AND projectName = :project AND activeOperationId = :operationId AND fence = :fence",
      ExpressionAttributeValues: {
        ":ownerKey": workspace.ownerKey, ":project": workspace.projectName,
        ":operationId": workspace.activeOperationId, ":fence": workspace.fence,
      },
    } },
    taskAccessFence(dependencies.tableName, task.taskId, peopleRevision),
  ];
}

export function parseSlackHeaders(headers: Record<string, string | undefined>): Omit<NonNullable<AuthenticatedIdentity["slack"]>, "binding"> {
  try {
    const thread = parseSlackThreadSubject(headers["x-agentx-slack-thread"] ?? "");
    const requester = SlackRequesterSchema.parse({ teamId: thread.teamId, userId: headers["x-agentx-slack-user"] });
    const requesterName = displayName(headers["x-agentx-slack-user-name"]);
    return { thread, requester, ...(requesterName === undefined ? {} : { requesterName }) };
  } catch {
    throw agentXError("CONFIG_INVALID", "valid x-agentx-slack-thread and x-agentx-slack-user headers are required");
  }
}

/** A Slack display name from the orchestrator, percent-encoded, cleaned by the same rules the Slack service used. */
function displayName(value: string | undefined): string | undefined {
  if (!value || value.length > DISPLAY_NAME_MAX_ENCODED_LENGTH) return undefined;
  try {
    return cleanDisplayName(decodeURIComponent(value));
  } catch { return undefined; }
}

/**
 * Release 0.4.17: `PUT /v1/admin/slack/teams/{teamId}` with `{ orgId }`. An operator (the admin pool, which belongs to no org) connects a Slack
 * workspace to one named org, so its owner can then bind channels with the developer sign-in. Only an operator may: an org can never claim a
 * workspace on a cloud install by itself. A closed or closing org takes none. The link is audited in that org's ledger in the same write;
 * repeating it for the org that holds the workspace changes and records nothing; a workspace another org holds is SLACK_TEAM_TAKEN.
 */
export async function connectSlackTeam(dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity, teamIdValue: string, body: unknown): Promise<{ teamId: string; orgId: OrgId }> {
  if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
  const teamId = SlackTeamIdSchema.safeParse(decodeURIComponent(teamIdValue));
  const orgId = OrgIdSchema.safeParse(object(body, "Slack team connection").orgId);
  if (!teamId.success) throw agentXError("CONFIG_INVALID", "teamId: not a Slack workspace ID");
  if (!orgId.success) throw agentXError("CONFIG_INVALID", "orgId: not an organization ID");
  const orgs = orgStoreOf(dependencies);
  if (await orgs.getOrg(orgId.data) === undefined) throw agentXError("NOT_FOUND", "organization not found");
  if (await orgs.orgForSlackTeam(teamId.data) !== orgId.data) {
    const at = new Date().toISOString();
    // The chain names the operator by a pseudonymous id, never by their identity.
    const event = await tryAuditEvent(dependencies, () => auditSlackTeamConnected({
      orgId: orgId.data, actor: { kind: "operator", id: auditOperatorId(identity.issuer, identity.subject) }, occurredAt: at, occurrence: auditOccurrence(teamId.data, at), teamId: teamId.data,
    }));
    await orgs.bindSlackTeam({ orgId: orgId.data, teamId: teamId.data, event });
    console.log(JSON.stringify({ component: "broker", event: "admin.slack_team_connected", orgId: orgId.data }));
  }
  return { teamId: teamId.data, orgId: orgId.data };
}

/**
 * Release 0.4.17: `DELETE /v1/admin/slack/teams/{teamId}`. An operator releases a Slack workspace from the org that holds it. It is refused while that
 * org still has channels bound in the workspace (their owner unbinds them first), so no binding is left pointing at a workspace that routes nowhere.
 * A channel bound in the instant after the check stays in the org's own partition and is never reached: the workspace then belongs to no org, so its
 * Slack events are ignored. Audited in the org's ledger in the same write.
 */
export async function disconnectSlackTeam(dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity, teamIdValue: string): Promise<{ teamId: string; orgId: OrgId }> {
  if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
  const teamId = SlackTeamIdSchema.safeParse(decodeURIComponent(teamIdValue));
  if (!teamId.success) throw agentXError("CONFIG_INVALID", "teamId: not a Slack workspace ID");
  const orgs = orgStoreOf(dependencies);
  const orgId = await orgs.orgForSlackTeam(teamId.data);
  if (orgId === undefined) throw agentXError("NOT_FOUND", "that Slack workspace is not connected to an organization");
  const channels = await listTeamChannels(dependencies, orgId, teamId.data);
  if (channels.length > 0) {
    throw agentXError("CONFIG_INVALID", `${String(channels.length)} channel(s) of that organization are still bound in this Slack workspace (${channels.slice(0, 10).join(", ")}${channels.length > 10 ? ", ..." : ""}); the organization's owner or admin unbinds each one first with: rovara --project <project> slack unbind --channel <channel>`);
  }
  const at = new Date().toISOString();
  const event = await tryAuditEvent(dependencies, () => auditSlackTeamDisconnected({
    orgId, actor: { kind: "operator", id: auditOperatorId(identity.issuer, identity.subject) }, occurredAt: at, occurrence: auditOccurrence(teamId.data, at), teamId: teamId.data,
  }));
  await orgs.unbindSlackTeam({ orgId, teamId: teamId.data, event });
  console.log(JSON.stringify({ component: "broker", event: "admin.slack_team_disconnected", orgId }));
  return { teamId: teamId.data, orgId };
}

export async function putSlackBinding(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  teamIdValue: string,
  channelIdValue: string,
  value: unknown,
): Promise<{ binding: SlackChannelBinding; latestRevision: number }> {
  const input = object(value, "Slack channel binding");
  // Older CLIs still send projectRevision; the binding follows the project's latest revision instead.
  const binding = SlackChannelBindingSchema.parse({
    teamId: decodeURIComponent(teamIdValue),
    channelId: decodeURIComponent(channelIdValue),
    projectName: input.projectName,
    updatedAt: new Date().toISOString(),
  });
  await requireAdministrator(dependencies, identity, binding.projectName);
  const orgId = requireOrgId(identity.orgId);
  const existing = await getSlackBinding(dependencies, orgId, binding.teamId, binding.channelId);
  if (existing && existing.projectName !== binding.projectName) {
    await requireAdministrator(dependencies, identity, existing.projectName);
  }
  const latest = await requireLatestProject(dependencies, orgId, binding.projectName);
  const event = auditSlackChannelBound({ orgId,
    actor: { kind: "operator", id: auditOperatorId(identity.issuer, identity.subject) },
    occurredAt: binding.updatedAt, occurrence: auditOccurrence(randomUUID(), binding.projectName, binding.teamId, binding.channelId),
    projectName: binding.projectName, teamId: binding.teamId, channelId: binding.channelId,
  });
  const pending = auditPending(dependencies, event);
  if (pending.length !== 1) throw agentXError("AUDIT_UNAVAILABLE", "Slack changes require the audit ledger.");
  // The team joins the org first; a team another org already holds is refused here (SLACK_TEAM_TAKEN).
  await ensureInstallOrg(dependencies, orgId);
  await orgStoreOf(dependencies).bindSlackTeam({ orgId, teamId: binding.teamId });
  await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [{ Put: {
    TableName: dependencies.tableName, Item: slackBindingItem(orgId, binding, identity.ownerKey),
    ConditionExpression: existing === undefined ? "attribute_not_exists(pk)" : "projectName = :project AND updatedAt = :at",
    ...(existing === undefined ? {} : { ExpressionAttributeValues: { ":project": existing.projectName, ":at": existing.updatedAt } }),
  } }, ...pending] }));
  await flushAuditEvents(dependencies, [event]);
  return { binding, latestRevision: latest.definition.revision };
}

export async function deleteSlackBinding(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  teamIdValue: string,
  channelIdValue: string,
  source?: "admin_change_plan",
): Promise<{ deleted: true; binding: SlackChannelBinding }> {
  const teamId = SlackTeamIdSchema.parse(decodeURIComponent(teamIdValue));
  const channelId = SlackChannelIdSchema.parse(decodeURIComponent(channelIdValue));
  const orgId = requireOrgId(identity.orgId);
  const binding = await getSlackBinding(dependencies, orgId, teamId, channelId);
  if (!binding) throw agentXError("NOT_FOUND", "Slack channel binding not found");
  await requireAdministrator(dependencies, identity, binding.projectName);
  const occurredAt = new Date().toISOString();
  const event = auditSlackChannelUnbound({ orgId,
    actor: source === "admin_change_plan" ? { kind: "member", id: identity.ownerKey } : { kind: "operator", id: auditOperatorId(identity.issuer, identity.subject) }, occurredAt,
    ...(source === undefined ? {} : { source }),
    occurrence: auditOccurrence(randomUUID(), binding.projectName, teamId, channelId),
    projectName: binding.projectName, teamId, channelId,
  });
  const pending = auditPending(dependencies, event);
  if (pending.length !== 1) throw agentXError("AUDIT_UNAVAILABLE", "Slack changes require the audit ledger.");
  await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [{ Delete: {
    TableName: dependencies.tableName, Key: slackBindingKey(orgId, teamId, channelId),
    ConditionExpression: "projectName = :project AND updatedAt = :at",
    ExpressionAttributeValues: { ":project": binding.projectName, ":at": binding.updatedAt },
  } }, ...pending] }));
  await flushAuditEvents(dependencies, [event]);
  return { deleted: true, binding };
}

/** A channel's binding inside one org; another org's binding for the same team and channel is never read. */
export async function getSlackBinding(
  dependencies: AwsBrokerDependencies,
  orgId: OrgId,
  teamId: string,
  channelId: string,
): Promise<SlackChannelBinding | undefined> {
  return readSlackBinding(dependencies, orgId, teamId, channelId);
}

/** A channel's binding inside the org its Slack team is bound to; a team bound to no org has none. */
export async function getTeamSlackBinding(dependencies: AwsBrokerDependencies, teamId: string, channelId: string): Promise<SlackChannelBinding | undefined> {
  let orgId: OrgId;
  try {
    orgId = await slackTeamOrg(dependencies, teamId);
  } catch (error) {
    if (error instanceof AgentXError && error.code === "SLACK_TEAM_NOT_BOUND") return undefined;
    throw error;
  }
  return getSlackBinding(dependencies, orgId, teamId, channelId);
}
