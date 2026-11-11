// Part of the broker (split out of ../broker.ts): reading artifacts, workspaces, projects, pull requests and memberships.

import { ModelIdentifierSchema } from "@rovara-code/contracts";
import { writeProjectModelSelection } from "../../model-selection/selection-write.js";
import { survivorOf } from "../../org/project-members.js";
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { ProjectModelOptionsSchema, ProjectModelSelectionRequestSchema, WorkspaceInstanceSchema, agentXError, workspaceRecordFields, type Operation, type ProjectDefinition, type WorkspaceInstance, modelKey, type ModelRef, type ModelSelection, type ProjectModelOptions, PROJECT_REVISION_SK_PREFIX, projectMemberKey, defaultWorkspaceKey, projectPk, projectSelectionKey, type OrgId } from "@rovara-code/contracts";
import { OrgRoleSchema, isWriterOrgRole, type OrgRole, orgMemberKey } from "@agentx/cloud-contracts";
import type { AuthenticatedIdentity } from "../../auth.js";
import { authorizeWorkspace } from "../../authorization.js";
import type { GitHubAppCredentialProvider } from "../../github-app.js";
import { requireOrgId } from "../../org/resolve.js";
import { getItem, operationKey, publicOperation, requireOperation, type OperationRecord } from "../cancellation.js";
import { grantRoleOf } from "../../developer/project-roles.js";
import { developerIdForSlackUser } from "../admin-actions.js";
import { decodeCursor, encodeCursor, parseStoredEvent, pullRequestKey, workspaceKey } from "./admin-and-helpers.js";
import type { AwsBrokerDependencies, MembershipRecord, ProjectModelSelectionRecord, PullRequestRecord, RegisteredProjectRecord } from "./definitions.js";
import { agentRouteDependencies, developerTaskActions, requireRecordLatestProject, requireRecordProject } from "./dependency-wiring.js";
import { workspaceTaskOwner } from "./model-access.js";
import { installOrgId, resolveSlackThreadKey } from "./scope-helpers.js";
import { requireSlackRequesterMayWork } from "./workspace-preparation.js";

export async function pageEvents(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspaceId: string,
  operationId: string,
  input: { cursor?: string; limit: number },
) {
  await getAuthorizedOperation(dependencies, identity, workspaceId, operationId);
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) {
    throw agentXError("CONFIG_INVALID", "event limit must be from 1 through 500");
  }
  const after = decodeCursor(input.cursor);
  const response = await dependencies.documentClient.send(new QueryCommand({
    TableName: dependencies.tableName,
    ExpressionAttributeValues: {
      ":pk": `OPERATION#${operationId}`,
      ":after": `EVENT#${String(after).padStart(12, "0")}`,
      ":end": "EVENT#\uffff",
    },
    KeyConditionExpression: "pk = :pk AND sk BETWEEN :after AND :end",
    Limit: input.limit,
    ConsistentRead: true,
  }));
  const events = (response.Items ?? [])
    .filter((item) => item.entityType === "EVENT")
    .map((item) => parseStoredEvent(item));
  const last = events.at(-1)?.sequence;
  return { events, ...(response.LastEvaluatedKey && last !== undefined ? { cursor: encodeCursor(last) } : {}) };
}

export async function getArtifact(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspaceId: string,
  artifactId: string,
) {
  await requireOwnedWorkspace(dependencies, identity, workspaceId);
  const artifact = await getItem<Record<string, unknown>>(dependencies, {
    pk: `WORKSPACE#${workspaceId}`,
    sk: `ARTIFACT#${artifactId}`,
  });
  if (!artifact || artifact.ownerKey !== identity.ownerKey || typeof artifact.objectKey !== "string") {
    throw agentXError("NOT_FOUND", "artifact not found");
  }
  if (identity.sharedTask?.state === "continue") {
    // D22: an artifact of the developer's own run is theirs, answered as if it did not exist.
    const operation = typeof artifact.operationId === "string" ? await getItem<OperationRecord>(dependencies, operationKey(workspaceId, artifact.operationId)) : undefined;
    if (operation === undefined || developerRequested(operation)) throw agentXError("NOT_FOUND", "artifact not found");
  }
  const object = await dependencies.s3.send(new GetObjectCommand({ Bucket: dependencies.artifactBucketName, Key: artifact.objectKey }));
  const content = object.Body ? await object.Body.transformToString("utf8") : "";
  return { id: artifactId, name: artifact.name, mediaType: artifact.mediaType, operationId: artifact.operationId, content };
}

export async function getAuthorizedOperation(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspaceId: string,
  operationId: string,
): Promise<Operation> {
  const workspace = await requireOwnedWorkspace(dependencies, identity, workspaceId);
  await requireProjectAuthority(dependencies, requireOrgId(identity.orgId), identity.ownerKey, workspace.projectName, { taskCreator: () => workspaceTaskOwner(dependencies, workspace.id) });
  const operation = await requireOperation(dependencies, workspaceId, operationId);
  // D22: from a shared thread, the developer's own run (its status, result and events) answers
  // exactly as an unknown operation does, so it cannot be probed. Channel operations stay readable.
  if (identity.sharedTask?.state === "continue" && developerRequested(operation)) throw agentXError("NOT_FOUND", "operation not found");
  return publicOperation(operation);
}

/** An operation a developer started from an AI tool (FR-022), rather than from Slack. */
export function developerRequested(operation: Pick<OperationRecord, "requestedBy">): boolean {
  const requester = operation.requestedBy;
  return requester !== undefined && "kind" in requester && requester.kind === "developer";
}

export async function requireOwnedWorkspace(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspaceId: string,
): Promise<WorkspaceInstance> {
  const workspace = await requireWorkspace(dependencies, workspaceId);
  authorizeWorkspace(identity, workspace);
  return workspace;
}

export async function requireWorkspace(dependencies: AwsBrokerDependencies, workspaceId: string): Promise<WorkspaceInstance> {
  const item = await getItem<Record<string, unknown>>(dependencies, workspaceKey(workspaceId));
  if (!item) throw agentXError("NOT_FOUND", "workspace not found");
  return WorkspaceInstanceSchema.parse(workspaceRecordFields(item));
}

/**
 * A person's default workspace for a project in one org. The map is keyed by org, person and project (`defaultWorkspaceKey`): a person has one owner key across orgs, so a
 * person who left one org and joined another with a same-named project must not read the first org's workspace. A row written before the key carried the org (the old
 * `OWNER#<person>` / `PROJECT#<name>`) is still found, but is returned only if the workspace it names belongs to this very org (one with no org recorded belongs to the install's single org);
 * a workspace of any other org reads as absent.
 */
export async function getDefaultWorkspace(
  dependencies: AwsBrokerDependencies,
  orgId: OrgId,
  ownerKey: string,
  projectName: string,
): Promise<WorkspaceInstance | undefined> {
  const scoped = await getItem<{ workspaceId: string }>(dependencies, defaultWorkspaceKey(orgId, ownerKey, projectName));
  if (scoped) return requireWorkspace(dependencies, scoped.workspaceId);
  const earlier = await getItem<{ workspaceId: string }>(dependencies, { pk: `OWNER#${ownerKey}`, sk: `PROJECT#${projectName}` });
  if (!earlier) return undefined;
  const workspace = await requireWorkspace(dependencies, earlier.workspaceId);
  // A workspace from before records named their org belongs to the install's single org (the same rule as `installOrgId`); a workspace of another org reads as absent.
  return (workspace.orgId ?? installOrgId(dependencies)) === orgId ? workspace : undefined;
}

export async function getThreadWorkspace(
  dependencies: AwsBrokerDependencies,
  orgId: OrgId,
  ownerKey: string,
): Promise<WorkspaceInstance | undefined> {
  const thread = await getItem<{ workspaceId?: string }>(dependencies, await resolveSlackThreadKey(dependencies, orgId, ownerKey));
  if (typeof thread?.workspaceId !== "string") return undefined;
  const workspace = await requireWorkspace(dependencies, thread.workspaceId);
  return (workspace.orgId ?? installOrgId(dependencies)) === orgId && workspace.ownerKey === ownerKey ? workspace : undefined;
}

/**
 * The definition a publication or maintenance run works from: the workspace's own revision for
 * everything that touches its disk, and the project's latest registered revision for the settings
 * that do not. Returns the revision whose settings applied, for the operation record.
 */
export async function publicationProject(
  dependencies: AwsBrokerDependencies,
  workspace: WorkspaceInstance,
): Promise<{ project: RegisteredProjectRecord; settingsRevision: number }> {
  const pinned = await requireRecordProject(dependencies, workspace, workspace.projectName, workspace.projectRevision);
  const settings = await requireRecordLatestProject(dependencies, workspace, workspace.projectName);
  if (settings.definition.revision === pinned.definition.revision) {
    return { project: pinned, settingsRevision: pinned.definition.revision };
  }
  const definition: ProjectDefinition = {
    ...pinned.definition,
    readiness: settings.definition.readiness,
    repositories: pinned.definition.repositories.map((repository) => {
      const latest = settings.definition.repositories.find((candidate) => candidate.name === repository.name);
      // A repository the latest revision dropped keeps the gates it was registered with.
      if (!latest) return repository;
      const withoutGates = { ...repository };
      delete withoutGates.codeBuildGates;
      return { ...withoutGates, ...(latest.codeBuildGates === undefined ? {} : { codeBuildGates: latest.codeBuildGates }) };
    }),
  };
  return { project: { ...pinned, definition }, settingsRevision: settings.definition.revision };
}

export async function requireLatestProject(
  dependencies: Pick<AwsBrokerDependencies, "documentClient" | "tableName">,
  orgId: OrgId,
  projectName: string,
): Promise<RegisteredProjectRecord> {
  // Revision sort keys are zero-padded, so the last key in descending order is the highest revision.
  const response = await dependencies.documentClient.send(new QueryCommand({
    TableName: dependencies.tableName,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :revision)",
    ExpressionAttributeValues: { ":pk": projectPk(orgId, projectName), ":revision": PROJECT_REVISION_SK_PREFIX },
    ScanIndexForward: false,
    Limit: 1,
    ConsistentRead: true,
  }));
  const project = response.Items?.[0] as RegisteredProjectRecord | undefined;
  if (!project) throw agentXError("NOT_FOUND", "registered project not found");
  return project;
}

function projectModelSelectionKey(orgId: OrgId, projectName: string) {
  return { pk: projectSelectionKey(orgId, projectName).pk, sk: "SELECTION" as const };
}

export async function getProjectModels(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
): Promise<ProjectModelOptions> {
  const projectName = identity.slack?.binding.projectName;
  if (!projectName) throw agentXError("FORBIDDEN", "Slack project binding is required");
  const orgId = requireOrgId(identity.orgId);
  const project = await requireLatestProject(dependencies, orgId, projectName);
  const policy = project.definition.models;
  if (!policy) throw agentXError("CONFIG_INVALID", "this project has no approved coding models; ask an administrator to configure models");
  const selection = await getItem<ProjectModelSelectionRecord>(dependencies, projectModelSelectionKey(orgId, projectName));
  const selected = selection === undefined
    ? undefined
    : policy.approved.find((candidate) => modelKey(candidate) === modelKey(selection.model));
  const current = selected ?? approvedDefault(policy.default, policy.approved);
  return ProjectModelOptionsSchema.parse({
    projectName,
    approved: policy.approved,
    current,
    source: selected === undefined ? "default" : "selection",
  });
}

export async function putProjectModel(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  value: unknown,
  requestId: string,
): Promise<ProjectModelOptions> {
  const projectName = identity.slack?.binding.projectName;
  const requester = identity.slack?.requester;
  if (!projectName || !requester) throw agentXError("FORBIDDEN", "Slack project binding and requester are required");
  await requireSlackRequesterMayWork(dependencies, identity, projectName);
  const requested = ProjectModelSelectionRequestSchema.parse(value);
  const orgId = requireOrgId(identity.orgId);
  const agents=agentRouteDependencies(dependencies,developerTaskActions(dependencies));
  if(agents===undefined)throw agentXError("RUNTIME_UNAVAILABLE","The model authority check is unavailable.");
  const signedInId=developerIdForSlackUser(requester.userId);
  const developerId=await survivorOf({developerRecord:id=>agents.signInStore.getDeveloper(id)},signedInId);
  const applied=await writeProjectModelSelection(agents,{orgId,project:projectName,signedInId,developerId,model:requested,surface:"slack",requestId});
  const project = await requireLatestProject(dependencies, orgId, projectName);
  const policy = project.definition.models;
  const selected=policy?.approved.find(candidate=>modelKey(candidate)===modelKey(applied.model));
  if(policy===undefined||selected===undefined)throw agentXError("PLAYBOOK_STALE","The model settings changed. Reload and try again.");
  return ProjectModelOptionsSchema.parse({
    projectName,
    approved: policy.approved,
    current: selected,
    source: "selection",
  });
}

export async function resolveProjectModel(
  dependencies: {documentClient:{send(command:unknown):Promise<unknown>};tableName:string},
  orgId: OrgId,
  project: Pick<RegisteredProjectRecord,"definition">,
): Promise<{ model?: ModelSelection; selectionUnavailable?: true }> {
  const policy = project.definition.models;
  const selection=(await dependencies.documentClient.send(new GetCommand({TableName:dependencies.tableName,Key:projectModelSelectionKey(orgId,project.definition.name),ConsistentRead:true})) as {Item?:Record<string,unknown>}).Item;
  if(policy===undefined)return selection===undefined?{}:{selectionUnavailable:true};
  const parsed=selection===undefined?undefined:ModelIdentifierSchema.safeParse(selection.model);
  const selected=parsed?.success?policy.approved.find(candidate=>modelKey(candidate)===modelKey(parsed.data)):undefined;
  if(selection!==undefined&&selected===undefined)return {selectionUnavailable:true};
  return {model:approvedSelection(selected??approvedDefault(policy.default,policy.approved))};
}

/** Spec 053: what a task or eval run runs: the approved entry's model and, only when it has one, its level. */
export function approvedSelection(model: ModelRef): ModelSelection {
  return {
    provider: model.provider,
    modelId: model.modelId,
    ...(model.thinkingLevel === undefined ? {} : { thinkingLevel: model.thinkingLevel }),
  };
}

function approvedDefault(defaultModel: ModelRef, approved: readonly ModelRef[]): ModelRef {
  const model = approved.find((candidate) => modelKey(candidate) === modelKey(defaultModel));
  if (!model) throw agentXError("CONFIG_INVALID", "project default model is not approved");
  return model;
}

export async function requirePullRequest(
  dependencies: AwsBrokerDependencies,
  workspaceId: string,
  repository: string,
  number: number,
): Promise<PullRequestRecord> {
  const record = await getItem<PullRequestRecord>(dependencies, pullRequestKey(workspaceId, repository, number));
  if (!record) throw agentXError("NOT_FOUND", "AgentX pull request record not found");
  return record;
}

export async function adoptLegacyPullRequest(
  dependencies: AwsBrokerDependencies,
  workspaceId: string,
  repository: string,
  repositoryUrl: string,
  remote: Awaited<ReturnType<GitHubAppCredentialProvider["getPullRequest"]>>,
): Promise<PullRequestRecord> {
  const match = /^agentx\/([0-9a-f-]{36})$/iu.exec(remote.headBranch);
  if (!match?.[1]) throw agentXError("NOT_FOUND", "pull request is not owned by this AgentX workspace");
  const operation = await requireOperation(dependencies, workspaceId, match[1]);
  if (
    operation.kind !== "publish" || operation.status !== "SUCCEEDED" || !operation.publication ||
    operation.publication.repository !== repository || operation.publication.repositoryUrl !== repositoryUrl ||
    operation.publication.headBranch !== remote.headBranch || operation.publication.baseBranch !== remote.baseBranch
  ) {
    throw agentXError("NOT_FOUND", "pull request is not backed by a successful AgentX publication");
  }
  const record: PullRequestRecord = {
    ...pullRequestKey(workspaceId, repository, remote.number),
    entityType: "PULL_REQUEST",
    workspaceId,
    repository,
    repositoryUrl,
    number: remote.number,
    url: remote.url,
    state: remote.state,
    headBranch: remote.headBranch,
    baseBranch: remote.baseBranch,
    expectedHeadCommit: remote.headCommit,
    title: remote.title,
    body: remote.body,
    createdByOperationId: operation.id,
    updatedAt: new Date().toISOString(),
  };
  await dependencies.documentClient.send(new PutCommand({ TableName: dependencies.tableName, Item: record }));
  return record;
}

export async function requireMembership(
  dependencies: AwsBrokerDependencies,
  orgId: OrgId,
  ownerKey: string,
  projectName: string,
): Promise<MembershipRecord> {
  const membership = await getMembership(dependencies, orgId, ownerKey, projectName);
  if (!membership) throw agentXError("NOT_FOUND", "project not found");
  return membership;
}

/**
 * What authorizes work on a project's task paths (`acceptTask`, both pull-request accepts, `getAuthorizedOperation` and the workspace
 * connectors): a `MEMBERSHIP` grant (today's behavior), or else a live org owner or admin, who maintains every project in their org
 * (Plan 2, Task 11, I4). The org role is read consistently from the member record on every call, but that branch answers only when no
 * grant row exists: a task identity always has its per-task MEMBERSHIP row (newWorkspacePreparation), so a demotion does not stop a
 * running task here. New work (checkProjectAccess) and each required-E2E round (the org-role proof) are where a demotion bites. `taskCreator` names the developer whose task this workspace runs, when it runs one: the record read is theirs, and only for
 * them does a cloud install answer a missing record with the removal's words. Anything else with no grant is NOT_FOUND "project not
 * found", exactly as before, on every install.
 */
export async function requireProjectAuthority(
  dependencies: AwsBrokerDependencies,
  orgId: OrgId,
  ownerKey: string,
  projectName: string,
  options: { taskCreator?: () => Promise<string | undefined> } = {},
): Promise<{ kind: "grant"; membership: MembershipRecord } | { kind: "org-role"; role: "owner" | "admin" }> {
  const membership = await getMembership(dependencies, orgId, ownerKey, projectName);
  // I2: a person who has become an Auditor writes nothing, whatever grant or task they still hold: the task paths stop for them here, so their open tasks stop publishing too.
  // The record read is the task creator's when there is one (the person the work runs for), else the key's; a missing record is left to the branches below.
  const creator = await options.taskCreator?.();
  const holder = await readOrgMember(dependencies, orgId, creator ?? ownerKey);
  // The raw role is read too: a record whose role does not parse (a role this release does not know) is no writer either, so it is refused, not waved through by its grant.
  // A record with no role at all is unreadable too, not a member: only a missing record is left to the branches below.
  const rawRecord = await getItem<{ role?: unknown }>(dependencies, orgMemberKey(orgId, creator ?? ownerKey));
  if (rawRecord !== undefined && !isWriterOrgRole(rawRecord.role)) throw agentXError("TASK_ACCESS_DENIED", "your company role can no longer work on tasks");
  // A viewer's row is no authority to work on a project's task paths (Plan 2, Task 21): it falls through to the org role, then NOT_FOUND.
  if (membership && grantRoleOf(membership) !== "viewer") return { kind: "grant", membership };
  const member = holder;
  if (member?.role === "owner" || member?.role === "admin") return { kind: "org-role", role: member.role };
  // R60 has already ended the task at its call sites; this only keeps the words right when the creator's record is gone.
  if (member === undefined && creator !== undefined && dependencies.cloud === true) {
    throw agentXError("TASK_ACCESS_DENIED", "you are no longer a member of this organization");
  }
  throw agentXError("NOT_FOUND", "project not found");
}

/** A developer's live org member record (a consistent read), or undefined when they have none; the role is the one on record. */
export async function readOrgMember(dependencies: Pick<AwsBrokerDependencies, "documentClient" | "tableName">, orgId: OrgId, developerId: string): Promise<{ role: OrgRole; memberUpdatedAt: string } | undefined> {
  const record = await getItem<{ role?: unknown; roleUpdatedAt?: unknown; joinedAt?: unknown }>(dependencies, orgMemberKey(orgId, developerId));
  const role = OrgRoleSchema.safeParse(record?.role);
  if (record === undefined || !role.success) return undefined;
  return { role: role.data, memberUpdatedAt: typeof record.roleUpdatedAt === "string" ? record.roleUpdatedAt : typeof record.joinedAt === "string" ? record.joinedAt : "" };
}

export async function getMembership(dependencies: AwsBrokerDependencies, orgId: OrgId, ownerKey: string, projectName: string) {
  return getItem<MembershipRecord>(dependencies, projectMemberKey(orgId, ownerKey, projectName));
}

export async function requireAdministrator(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  projectName: string,
): Promise<void> {
  if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
  const membership = await requireMembership(dependencies, requireOrgId(identity.orgId), identity.ownerKey, projectName);
  if (membership.role !== "administrator") throw agentXError("FORBIDDEN", "administrator project membership is required");
}
