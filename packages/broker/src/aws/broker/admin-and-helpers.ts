// Part of the broker (split out of ../broker.ts): SWE-bench routes, admin task reads, keys, request parsing helpers and event hooks.

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { CandidateManifestSchema, WEB_API_RUNTIME_PROFILE_ID, canonicalJson, SlackChannelIdSchema, SlackTeamIdSchema, agentXError, unhandledDeploymentMode, workspaceProjectIndexAttributes, type WorkspaceInstance, modelKey, orgProjectCatalogKey, projectMemberKey, type OrgId, cloudwatchRoleAccount, codeRepositoriesOf } from "@agentx/contracts";
import { listWorkflowE2EReplayRecords, type ReplayRecord } from "../workflow-e2e-replay.js";
import type { AuthenticatedIdentity } from "../../auth.js";
import { z } from "zod";
import { admitMachineTime, admitTrial } from "../../org/trial.js";
import { requireOrgId } from "../../org/resolve.js";
import { e2eRegisteredRuntimeKey } from "../e2e-runtime-readiness.js";
import { getItem, requireOperation, type CallbackClaims, type OperationRecord } from "../cancellation.js";
import { requireWorkspaceCreatorStillMember } from "../../developer/creator-member.js";
import { effectiveTaskOwner, taskKey, taskPointerKey, type DeveloperTaskPointerRecord, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { ModelCheckError, readCurrentTiers, readModelCheck, startModelCheck, type ModelCheckDependencies } from "../../e2e/model-checks.js";
import type { ConnectedAwsAccounts } from "../../triggers/hooks.js";
import { HookIngressMemory } from "../../triggers/ingress.js";
import { json } from "../json-reply.js";
import { developerTaskRouteDependencies, type DeveloperCaller } from "../developer-routes.js";
import type { DeveloperTaskActions } from "../developer-task-actions.js";
import { adminShareMode, currentWorkflowPublicationAuthorityForTask } from "../developer-tasks.js";
import type { AdaptedHttpRequest, RuntimeBinding } from "../lambda.js";
import { deleteSwebenchChannel, getSwebenchChannel, putSwebenchChannel, type SwebenchSlackContext } from "../swebench.js";
import { withEvalBatches, type EvalBatchDependencies } from "../eval-batch.js";
import { batchResults, parseStartBody, requireBatchProject, showBatch, startBatch, stopBatchById } from "../eval-batch-admin.js";
import type { AwsBrokerDependencies, MembershipRecord, RegisteredProjectRecord } from "./definitions.js";
import { developerTaskActions } from "./dependency-wiring.js";
import { startReplayApplicationRound } from "./e2e-rounds.js";
import { approvedSelection, getMembership, readOrgMember, requireAdministrator, requireLatestProject, resolveProjectModel } from "./records.js";
import { creatorCheckOf, githubScopeOfWorkspace, orgConnectionStoreOf, orgOfRecord } from "./scope-helpers.js";
import { refreshTaskFeedbackForOwnerDecision } from "./terminal-and-github-events.js";
import { workflowE2EPresentation, workflowE2EPublicationChecks } from "./workflow-e2e-verification.js";
import { getSlackBinding } from "./workspace-preparation.js";
import { auditOperatorId } from "@agentx/contracts";
import { developerIdForSlackUser } from "../admin-actions.js";
import { requirePricedTaskStopAdmission } from "../../org/task-stop-unpriced.js";

/** Spec 043: the SWE-bench module's dependencies, from the broker's; spec 052 wires its batches into them. */
export function swebenchDependencies(dependencies: AwsBrokerDependencies): EvalBatchDependencies {
  const swebench = dependencies.swebench;
  if (swebench === undefined) throw agentXError("NOT_FOUND", "SWE-bench runs are not available in this deployment");
  return withEvalBatches({
    documentClient: dependencies.documentClient,
    s3: dependencies.s3,
    tableName: dependencies.tableName,
    artifactBucketName: dependencies.artifactBucketName,
    callbackSigningKey: dependencies.callbackSigningKey,
    ...swebench,
  });
}

/** The thread, requester and project model a SWE-bench run takes from the Slack service identity. */
export function swebenchSlackContext(dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity): SwebenchSlackContext {
  const slack = identity.slack;
  if (!slack) throw agentXError("FORBIDDEN", "Slack thread context is required");
  return { orgId: requireOrgId(identity.orgId), developerId: developerIdForSlackUser(slack.requester.userId), thread: slack.thread, requester: slack.requester, ...swebenchProjectContext(dependencies, requireOrgId(identity.orgId), slack.binding.projectName) };
}

/** The project and its approved models, for a run or batch whose thread and requester the caller supplies. */
function swebenchProjectContext(dependencies: AwsBrokerDependencies, orgId: OrgId, projectName: string): Pick<SwebenchSlackContext, "projectName" | "projectModel"> {
  return {
    projectName,
    projectModel: async (requested) => {
      const project = await requireLatestProject(dependencies, orgId, projectName);
      const policy = project.definition.models;
      if (requested !== undefined) {
        const approved = policy?.approved.find((candidate) => modelKey(candidate) === modelKey(requested));
        if (!approved) throw agentXError("CONFIG_INVALID", `model ${requested.provider}/${requested.modelId} is not approved for this project`);
        return approvedSelection(approved);
      }
      const resolved=await resolveProjectModel(dependencies,orgId,project);
      if(resolved.selectionUnavailable===true)throw agentXError("MODEL_NOT_ALLOWED","The project model selection is unavailable. Check How we work.");
      return resolved.model;
    },
  };
}

/** Spec 052 FR-001: an administrator of the channel's project starts a batch from a file. */
export async function routeStartEvalBatch(dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity, value: unknown): Promise<unknown> {
  const body = parseStartBody(value);
  const binding = await getSlackBinding(dependencies, requireOrgId(identity.orgId), body.teamId, body.channelId);
  if (!binding) throw agentXError("NOT_FOUND", "Slack channel binding not found; bind the channel to a project first");
  await requireAdministrator(dependencies, identity, binding.projectName);
  return startBatch(swebenchDependencies(dependencies), { ...swebenchProjectContext(dependencies, requireOrgId(identity.orgId), binding.projectName), orgId: requireOrgId(identity.orgId), developerId: identity.ownerKey }, body);
}

/** Spec 052 FR-009, FR-010: show, stop or read the results of a batch, for an administrator of its channel's project. */
export async function routeEvalBatch(dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity, batchId: string, action: "show" | "stop" | "results"): Promise<unknown> {
  // The admin claim first, so a non-administrator learns nothing about which batch IDs exist.
  if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
  const swebench = swebenchDependencies(dependencies);
  // The project stored on the batch, not the channel's current binding: a rebound channel does not hand over old batches.
  await requireAdministrator(dependencies, identity, await requireBatchProject(swebench, batchId));
  if (action === "stop") return stopBatchById(swebench, batchId);
  return action === "results" ? batchResults(swebench, batchId) : showBatch(swebench, batchId);
}

/** Spec 043 FR-002: an administrator of the channel's project enables, reads or disables SWE-bench runs there. */
export async function routeSwebenchChannel(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  method: "PUT" | "DELETE" | "GET",
  teamIdValue: string,
  channelIdValue: string,
  body: unknown,
): Promise<unknown> {
  const teamId = SlackTeamIdSchema.parse(decodeURIComponent(teamIdValue));
  const channelId = SlackChannelIdSchema.parse(decodeURIComponent(channelIdValue));
  const binding = await getSlackBinding(dependencies, requireOrgId(identity.orgId), teamId, channelId);
  if (!binding) throw agentXError("NOT_FOUND", "Slack channel binding not found; bind the channel to a project first");
  await requireAdministrator(dependencies, identity, binding.projectName);
  const swebench = swebenchDependencies(dependencies);
  if (method === "PUT") return { channel: await putSwebenchChannel(swebench, teamId, channelId, body), projectName: binding.projectName };
  if (method === "DELETE") return deleteSwebenchChannel(swebench, teamId, channelId);
  const channel = await getSwebenchChannel(swebench, teamId, channelId);
  if (!channel) throw agentXError("NOT_FOUND", "SWE-bench runs are not enabled in this channel");
  return { channel, projectName: binding.projectName };
}

const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Spec 025 C25: the admin claim first, so a non-admin learns nothing about task IDs; then the task;
 * then the administrator membership on the task's project (FR-015). The audit record names the
 * admin by issuer and subject, and by the token's name or email claim when it has one.
 */
export async function adminTaskShareMode(dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity, taskId: string, value: unknown, tasks: DeveloperTaskActions) {
  if (!dependencies.developer) throw agentXError("NOT_FOUND", "developer tasks are not set up in this deployment");
  if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
  // A malformed ID is never echoed back: it could be long or carry markup.
  if (!TASK_ID_PATTERN.test(taskId)) throw agentXError("TASK_NOT_FOUND", "that is not a task ID");
  const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(taskId));
  if (task === undefined) throw agentXError("TASK_NOT_FOUND", `no task ${taskId}`);
  // FR-015's membership check, answered FORBIDDEN (requireAdministrator's missing-membership answer
  // is NOT_FOUND, which would read as "no such task").
  const orgId = requireOrgId(identity.orgId);
  const membership = await getMembership(dependencies, orgId, identity.ownerKey, task.project);
  if (membership?.role !== "administrator") throw agentXError("FORBIDDEN", "administrator project membership is required");
  const claimed = [identity.claims.name, identity.claims.email].find((claim): claim is string => typeof claim === "string" && claim.trim() !== "");
  return adminShareMode(
    { documentClient: dependencies.documentClient, tableName: dependencies.tableName, actions: tasks, orgId, now: Date.now, ...(dependencies.developer === undefined ? {} : { issuer: dependencies.developer.issuer }) },
    { issuer: identity.issuer, subject: identity.subject, ...(claimed === undefined ? {} : { displayName: claimed.trim() }) },
    task,
    value,
  );
}

/**
 * M1.4 Task 4.10C: `POST /v1/admin/e2e/model-checks { kind: "drive" | "discover", modelId? }` asks the qualified runner for a driving test or a discovery (202 and the check's id);
 * `GET .../<checkId>` is pending until the runner has answered, then the validated outcome in the owner's sentence; `GET .../model-checks` (no id) is the tiers on record.
 */
export async function adminModelChecks(dependencies: AwsBrokerDependencies, method: string, checkId: string | undefined, body: unknown, requestId: string): Promise<ReturnType<typeof json>> {
  if (dependencies.e2eAgentInstallation === undefined || dependencies.e2eFeatureRuntimeCatalogId === undefined) throw agentXError("NOT_FOUND", "AI navigation model checks are not set up in this deployment");
  const catalogId = dependencies.e2eFeatureRuntimeCatalogId;
  const checks: ModelCheckDependencies = {
    documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now, installation: dependencies.e2eAgentInstallation,
    readRuntimeRow: async () => (await getItem<Record<string, unknown>>(dependencies, e2eRegisteredRuntimeKey(catalogId, WEB_API_RUNTIME_PROFILE_ID, "web"))) ?? undefined,
    putObject: async (key, text) => { await dependencies.s3.send(new PutObjectCommand({ Bucket: dependencies.artifactBucketName, Key: key, Body: text, ContentType: "application/json" })); },
    getObject: async (key) => {
      try {
        const object = await dependencies.s3.send(new GetObjectCommand({ Bucket: dependencies.artifactBucketName, Key: key }));
        return object.Body === undefined ? new Uint8Array() : await object.Body.transformToByteArray();
      } catch (error) {
        // Without a list grant S3 answers a missing key with AccessDenied: not there yet.
        const name = error instanceof Error ? error.name : "";
        if (name === "NoSuchKey" || name === "AccessDenied" || name === "Forbidden") return undefined;
        throw error;
      }
    },
  };
  try {
    if (method === "POST") return json(await startModelCheck(checks, body, WEB_API_RUNTIME_PROFILE_ID), requestId, 202);
    if (checkId !== undefined) return json(await readModelCheck(checks, checkId), requestId);
    return json({ tiers: await readCurrentTiers(checks) }, requestId);
  } catch (error) {
    if (!(error instanceof ModelCheckError)) throw error;
    // The code of the error is the fixed one of the check; the message never carries a model id from the request.
    throw agentXError(error.status === 400 ? "CONFIG_INVALID" : error.status === 404 ? "NOT_FOUND" : error.code === "check-in-progress" ? "WORKSPACE_BUSY" : "RUNTIME_UNAVAILABLE", `${error.code}: ${error.message}`);
  }
}

/**
 * M1.4 Task 4.6b: the operator's routes for an audit replay of a task's qualified round: `POST /v1/admin/tasks/{taskId}/e2e-replay` (body `{ roundId }`) starts one, `GET` (query `roundId`,
 * default the qualified round) reads the record of each attempt. Both are an administrator's, of the task's project. Neither touches the task: the record is kept apart from it and the
 * task page does not show it in M1.4.
 */
export async function adminTaskE2EReplay(dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity, taskId: string, method: "POST" | "GET", value: unknown, query: URLSearchParams): Promise<unknown> {
  if (!dependencies.developer) throw agentXError("NOT_FOUND", "developer tasks are not set up in this deployment");
  if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
  if (!TASK_ID_PATTERN.test(taskId)) throw agentXError("TASK_NOT_FOUND", "that is not a task ID");
  const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(taskId));
  if (task === undefined) throw agentXError("TASK_NOT_FOUND", `no task ${taskId}`);
  // MERGE-DECISION: the administrator's membership is read in the administrator's own org, and the task must be in that org (a task of another org with a project of the same name is not theirs).
  const orgId = requireOrgId(identity.orgId);
  if (await orgOfRecord(dependencies, task) !== orgId) throw agentXError("TASK_NOT_FOUND", `no task ${taskId}`);
  const membership = await getMembership(dependencies, orgId, identity.ownerKey, task.project);
  if (membership?.role !== "administrator") throw agentXError("FORBIDDEN", "administrator project membership is required");
  const store = { documentClient: dependencies.documentClient, tableName: dependencies.tableName };
  if (method === "GET") {
    const asked = query.get("roundId") ?? task.workflow?.e2e?.qualifiedRound?.roundId;
    const roundId = z.string().uuid().safeParse(asked);
    if (!roundId.success) throw agentXError("CONFIG_INVALID", "replay-not-qualified: the task has no qualified round to read replays of");
    const records = await listWorkflowE2EReplayRecords(store, taskId, roundId.data);
    return { sourceRoundId: roundId.data, replays: records.map(replayRecordView) };
  }
  await requirePricedTaskStopAdmission(dependencies, { orgId, actor: { kind: "operator", id: auditOperatorId(identity.issuer, identity.subject) }, workKind: "admin-e2e-replay" });
  const { roundId } = z.object({ roundId: z.string().uuid() }).strict().parse(value);
  // A replay runs a runner for the task's org, so on a cloud install it is admitted like any other launch: a locked trial, or a month of machine time used up, refuses it before anything is created.
  if (dependencies.cloud === true) {
    const trial = { documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now };
    await admitTrial(trial, orgId);
    await admitMachineTime(trial, orgId);
  }
  // The route dependencies act for the task's developer (the task's owner); the request is the administrator's, and is recorded as theirs (Task FU2, REPLAYACTOR).
  // The task's owner now (Plan 5 Task 12a): the person who took it over, else its creator.
  const owner = effectiveTaskOwner(task);
  const caller: DeveloperCaller = { developerId: owner.developerId, sessionId: "replay-admin", amr: owner.provider, name: owner.name, orgId,
    orgRole: (await readOrgMember(dependencies, orgId, owner.developerId))?.role ?? "member" };
  const claimed = [identity.claims.name, identity.claims.email].find((claim): claim is string => typeof claim === "string" && claim.trim() !== "");
  const routeDependencies = developerTaskRouteDependencies({
    documentClient: dependencies.documentClient, tableName: dependencies.tableName, developer: dependencies.developer,
    now: Date.now, tasks: developerTaskActions(dependencies), refreshTaskFeedback: (id) => refreshTaskFeedbackForOwnerDecision(dependencies, id),
    workflowE2EPresentation: input => workflowE2EPresentation(dependencies, input.task, input.operations, input.actor),
    workflowE2EPublicationChecks: input => workflowE2EPublicationChecks(dependencies, input.task, input.operations),
  }, caller, undefined, null);
  return { replay: await startReplayApplicationRound(dependencies, routeDependencies, { task, sourceRoundId: roundId,
    admin: { issuer: identity.issuer, subject: identity.subject, ownerKey: identity.ownerKey, ...(claimed === undefined ? {} : { displayName: claimed.trim() }) } }) };
}

/** What the operator reads of a replay record: its state, when, and the broker's own result; never an id of an operation or an object. */
function replayRecordView(record: ReplayRecord) {
  return { attempt: record.attempt, state: record.state, requestedAt: record.requestedAt, ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
    ...(record.recordedAt === undefined ? {} : { recordedAt: record.recordedAt }), ...(record.reason === undefined ? {} : { reason: record.reason }), ...(record.replay === undefined ? {} : { replay: record.replay }) };
}

/** Whether closing a workspace of this mode deletes its storage. */
export function closeReleasesStorage(workspace: WorkspaceInstance): boolean {
  switch (workspace.deploymentMode) {
    case "instances-ebs":
    case "ec2-ebs":
      return true;
    case "demo-microvm":
      return false;
    default:
      return unhandledDeploymentMode(workspace);
  }
}

/** The workspace fields a project's runtime binding fixes. An ec2-ebs workspace keeps only its mode. */
export function workspaceRuntime(runtimeBinding: RuntimeBinding) {
  switch (runtimeBinding.deploymentMode) {
    case "instances-ebs":
    case "demo-microvm":
      throw agentXError("CONFIG_INVALID", "retired project revision cannot create workspaces; register an ec2-ebs revision");
    case "ec2-ebs":
      return { deploymentMode: runtimeBinding.deploymentMode };
    default:
      return unhandledDeploymentMode(runtimeBinding);
  }
}

export function workspaceItem(orgId: OrgId, workspace: WorkspaceInstance) {
  // Spec 041: the sparse byWorkspaceProject index attributes make this record findable by project,
  // which is how a developer's workspaces are listed. They are storage keys, not record fields, so
  // workspaceRecordFields strips them again on the way back.
  return {
    ...workspaceKey(workspace.id),
    entityType: "WORKSPACE",
    ...workspaceProjectIndexAttributes({ orgId, projectName: workspace.projectName, createdAt: workspace.createdAt }),
    ...workspace,
    orgId,
  };
}

export function membershipRecord(orgId: OrgId, ownerKey: string, projectName: string, role: MembershipRecord["role"], details: Pick<MembershipRecord, "projectRole" | "grantedBy" | "grantedAt"> = {}): MembershipRecord {
  return { ...projectMemberKey(orgId, ownerKey, projectName), entityType: "MEMBERSHIP", ownerKey, projectName, role, grantId: randomUUID(), ...details };
}

export function githubRepositoryFullName(repositoryUrl: string): string {
  let url: URL;
  try { url = new URL(repositoryUrl); } catch { throw agentXError("CONFIG_INVALID", "registered repository URL is invalid for GitHub PR tracking"); }
  const segments = url.pathname.split("/").filter(Boolean);
  const name = segments[1]?.endsWith(".git") ? segments[1].slice(0, -4) : segments[1];
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.port !== ""
    || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== ""
    || segments.length !== 2 || segments.some((segment) => segment.includes("%"))
    || !segments[0] || !name || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(segments[0])
    || !/^[A-Za-z0-9_.-]{1,100}$/.test(name)) {
    throw agentXError("CONFIG_INVALID", "registered repository URL is not a canonical GitHub repository");
  }
  return `${segments[0]}/${name}`;
}

export function pullRequestMatchesRepository(pullRequestUrl: string, repositoryFullName: string, number: number): boolean {
  try {
    const url = new URL(pullRequestUrl);
    return url.protocol === "https:" && url.hostname.toLowerCase() === "github.com" && url.port === ""
      && url.username === "" && url.password === "" && url.search === "" && url.hash === ""
      && url.pathname.toLowerCase() === `/${repositoryFullName.toLowerCase()}/pull/${number}`;
  } catch {
    return false;
  }
}

export function workspaceKey(id: string) {
  return { pk: `WORKSPACE#${id}`, sk: "META" };
}

export function pullRequestKey(workspaceId: string, repository: string, number: number) {
  return {
    pk: `WORKSPACE#${workspaceId}`,
    sk: `PULL_REQUEST#${repository}#${String(number).padStart(12, "0")}`,
  };
}

export function codeBuildKey(workspaceId: string, operationId: string, gate: string) {
  return {
    pk: `WORKSPACE#${workspaceId}`,
    sk: `CODEBUILD#${operationId}#${gate}`,
  };
}

export function issueRepositoryGrant(
  dependencies: AwsBrokerDependencies,
  project: RegisteredProjectRecord,
  ownerKey: string,
  workspaceId: string,
  operationId: string,
  access: "clone" | "push" = "clone",
  repositoryName?: string,
): string {
  return dependencies.repositoryGrants.issue({
    ownerKey,
    projectName: project.definition.name,
    workspaceId,
    operationId,
    // Meta repo lane A: a task never writes to the project's meta repository from a builder session, so no push grant names a meta repository that is not also code
    // (a clone grant does: the worker brings it in read-only).
    repositories: (access === "push" ? codeRepositoriesOf(project.definition) : project.definition.repositories)
      .filter((repository) => repositoryName === undefined || repository.name === repositoryName)
      .map((repository) => ({
      credentialRef: repository.credentialRef,
      repositoryUrl: repository.url,
      access,
    })),
  });
}

export async function exchangeRepositoryCredential(
  dependencies: AwsBrokerDependencies,
  request: AdaptedHttpRequest,
  workspaceId: string,
  operationId: string,
) {
  const grant = request.headers["x-agentx-repository-grant"];
  if (!grant) throw agentXError("FORBIDDEN", "repository grant is required");
  const input = object(parseBody(request.body), "repository credential exchange");
  const credentialRef = name(input.credentialRef, "credentialRef");
  const access = input.access === "clone" || input.access === "push" ? input.access : undefined;
  if (!access) throw agentXError("CONFIG_INVALID", "repository access is invalid");
  if (typeof input.repositoryUrl !== "string" || input.repositoryUrl.length > 2_048) {
    throw agentXError("CONFIG_INVALID", "repositoryUrl is invalid");
  }
  // Ruling R60: a removed creator's task pushes nothing, so the token that would let a worker push is never minted. A clone is not
  // refused: the step that needs one is already running and finishes.
  if (access === "push") await requireWorkspaceCreatorStillMember(creatorCheckOf(dependencies), workspaceId);
  const operation = await requireOperation(dependencies, workspaceId, operationId);
  if (operation.kind === "publish") await assertCurrentWorkflowPublication(dependencies, operation);
  return dependencies.repositoryGrants.exchange(grant, {
    workspaceId,
    operationId,
    credentialRef,
    repositoryUrl: input.repositoryUrl,
    access,
  }, await githubScopeOfWorkspace(dependencies, workspaceId));
}

/** A stored mode is a selector, not continuing authority: reload the current task and project before issuing push credentials. */
export async function assertCurrentWorkflowPublication(dependencies: AwsBrokerDependencies, operation: OperationRecord): Promise<void> {
  const publication = operation.publication;
  if (publication?.expectedTreeSha === undefined) return;
  const taskPointer = await getItem<DeveloperTaskPointerRecord>(dependencies, taskPointerKey(operation.workspaceId));
  const task = taskPointer === undefined ? undefined : await getItem<DeveloperTaskRecord>(dependencies, taskKey(taskPointer.taskId));
  const workflow = task?.workflow;
  const candidate = workflow?.candidate === undefined ? undefined : CandidateManifestSchema.safeParse(workflow.candidate);
  const repository = candidate?.success ? candidate.data.repositories.find((item) => item.repositoryId === publication.repository) : undefined;
  if (task === undefined || task.workspaceId !== operation.workspaceId || task.closedAt !== undefined || workflow?.stage !== "PULL_REQUEST"
    || workflow.state !== "READY" || workflow.candidate?.digest !== publication.candidateDigest || repository === undefined
    || repository.treeSha !== publication.expectedTreeSha
    || (publication.publicationMode === "COMMITTED_HEAD" && (repository.commitSha !== publication.expectedCommitSha || publication.expectedCommitSha === undefined))
    || (publication.publicationMode === "CHECKED_TREE" && publication.expectedCommitSha !== undefined)
    || publication.publicationMode === undefined) {
    throw agentXError("CALLBACK_FORBIDDEN", "workflow publication authority is stale");
  }
  const baseCommitSha = (workflow.reviewBase ?? task.preparedBase)?.find((item) => item.repositoryId === repository.repositoryId)?.baseCommitSha;
  if (baseCommitSha !== publication.expectedBaseCommit) throw agentXError("CALLBACK_FORBIDDEN", "workflow publication base is stale");
  // B32/C94: retain the existing stale refusal, with a fixed settings reason.
  const publicationOrg = await orgOfRecord(dependencies, task);
  const currentCatalog = await getItem<{latestRevision?:unknown}>(dependencies,orgProjectCatalogKey(publicationOrg,task.project));
  if(currentCatalog?.latestRevision!==publication.admittedLatestRevision){
    throw Object.assign(agentXError("CALLBACK_FORBIDDEN","Project settings changed. Review again before publishing."),{reason:"settingsChanged" as const});
  }
  const currentAuthority = await currentWorkflowPublicationAuthorityForTask({
    actions: developerTaskActions(dependencies),
    tableName: dependencies.tableName,
    orgId: await orgOfRecord(dependencies, task),
    workflowE2EPresentation: (input) => workflowE2EPresentation(dependencies, input.task, input.operations, input.actor),
    workflowE2EPublicationChecks: (input) => workflowE2EPublicationChecks(dependencies, input.task, input.operations),
  }, task);
  if (currentAuthority === undefined || currentAuthority.mode !== publication.publicationMode
    || currentAuthority.pinnedRevision !== publication.admittedPinnedRevision
    || currentAuthority.latestRevision !== publication.admittedLatestRevision
    || currentAuthority.materialDigest !== publication.admittedMaterialDigest
    || currentAuthority.workflowRevision !== publication.admittedWorkflowRevision
    || canonicalJson(currentAuthority.planArtifact) !== canonicalJson(publication.admittedPlanArtifact)
    || canonicalJson(currentAuthority.ownerApproval) !== canonicalJson(publication.admittedOwnerApproval)
    || currentAuthority.workflowAuthorityDigest !== publication.admittedWorkflowAuthorityDigest) {
    throw agentXError("CALLBACK_FORBIDDEN", "workflow publication policy or admitted project material changed");
  }
}

export function verifyCapability(
  dependencies: AwsBrokerDependencies,
  token: string,
  action: CallbackClaims["actions"][number],
): CallbackClaims {
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra) throw agentXError("CALLBACK_FORBIDDEN", "invalid callback capability");
  const expected = createHmac("sha256", dependencies.callbackSigningKey).update(body).digest();
  const actual = Buffer.from(signature, "base64url");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw agentXError("CALLBACK_FORBIDDEN", "invalid callback signature");
  }
  const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as CallbackClaims;
  if (claims.expiresAt <= Math.floor(Date.now() / 1_000) || !claims.actions.includes(action)) {
    throw agentXError("CALLBACK_FORBIDDEN", `callback capability does not allow ${action}`);
  }
  return claims;
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw agentXError("CONFIG_INVALID", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function parseBody(body: string | undefined): unknown {
  if (!body) return {};
  try {
    return JSON.parse(body) as unknown;
  } catch {
    // Issue #48: the parser's own words quote the body, so fixed words instead.
    throw agentXError("CONFIG_INVALID", "the request body is not valid JSON");
  }
}

export function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw agentXError("CONFIG_INVALID", `${label} must be a UUID`);
  }
  return value;
}

export function name(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,62}$/.test(value)) {
    throw agentXError("CONFIG_INVALID", `${label} is invalid`);
  }
  return value;
}

export function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw agentXError("CONFIG_INVALID", `${label} must be a positive integer`);
  }
  return value;
}

export function encodeCursor(sequence: number): string {
  return Buffer.from(String(sequence)).toString("base64url");
}

export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const value = Number.parseInt(Buffer.from(cursor, "base64url").toString("utf8"), 10);
  if (!Number.isInteger(value) || value < 0) throw agentXError("CONFIG_INVALID", "event cursor is invalid");
  return value;
}

/** The worker reports, once per conversation, that a saved session now exists for it. */
export function startsConversation(value: unknown): boolean {
  if (!value || typeof value !== "object" || !("conversation" in value)) return false;
  const conversation = value.conversation;
  return Boolean(
    conversation && typeof conversation === "object" && "started" in conversation && conversation.started === true,
  );
}

export function isStatus(value: unknown, status: string): boolean {
  return Boolean(value && typeof value === "object" && "status" in value && value.status === status);
}

export function withoutKeys(record: RegisteredProjectRecord): Omit<RegisteredProjectRecord, "pk" | "sk"> {
  return {
    entityType: record.entityType,
    definition: record.definition,
    runtimeBinding: record.runtimeBinding,
    registeredBy: record.registeredBy,
    registeredAt: record.registeredAt,
  };
}

export function parseStoredEvent(item: Record<string, unknown>): {
  sequence: number;
  type: string;
  timestamp: string;
  payload: unknown;
} {
  if (
    typeof item.sequence !== "number" ||
    typeof item.type !== "string" ||
    typeof item.timestamp !== "string"
  ) {
    throw agentXError("RUNTIME_UNAVAILABLE", "stored event is invalid");
  }
  return {
    sequence: item.sequence,
    type: item.type,
    timestamp: item.timestamp,
    payload: item.payload,
  };
}

/** `{ [key]: value }`, or nothing when there is no value (exactOptionalPropertyTypes). */
export function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return value === undefined ? {} : { [key]: value } as { [P in K]?: V };
}

/**
 * Plan 4 Task 25: whether an AWS account is one the org connected, read from the org's own CloudWatch connections (the account of each role ARN) at the moment of asking. Undefined
 * where there is no connection store, and then no CloudWatch hook is made or confirmed.
 */
export function connectedAwsAccountsOf(dependencies: AwsBrokerDependencies): ConnectedAwsAccounts | undefined {
  const given = dependencies.agents?.eventHooks?.awsAccounts;
  if (given !== undefined) return given;
  const store = orgConnectionStoreOf(dependencies);
  if (store === undefined) return undefined;
  return { isConnected: async (orgId, awsAccountId) => (await store.list(orgId)).some((connection) => connection.type === "cloudwatch" && cloudwatchRoleAccount(connection.roleArn) === awsAccountId) };
}

/** `/v1/hooks/{source}/{hookId}` (Plan 4 Task 19). */
export const HOOK_DELIVERY_PATH = /^\/v1\/hooks\/([^/]+)\/([^/]+)$/;
/** The one route key a delivery arrives on (infra/lib/control-plane.ts `EventHookRoute`): the same path under any other route is not a hook delivery. */
export const HOOK_ROUTE_KEY = "POST /v1/hooks/{source}/{hookId}";
const hookMemories = new WeakMap<object, HookIngressMemory>();

/** What this broker's event hooks remember between requests: one table per broker, shared by the routes that rotate a secret and the endpoint that reads it. */
export function hookMemoryOf(dependencies: AwsBrokerDependencies): HookIngressMemory {
  const configured = dependencies.agents?.eventHooks?.memory;
  if (configured !== undefined) return configured;
  let memory = hookMemories.get(dependencies);
  if (memory === undefined) {
    memory = new HookIngressMemory();
    hookMemories.set(dependencies, memory);
  }
  return memory;
}

/** A hook's answer exactly as ingress made it: the uniform refusal carries nothing but its fixed body, not even a request id. */
export function hookReply(answer: { status: number; body: Record<string, unknown> }): { statusCode: number; headers: Record<string, string>; body: string } {
  return { statusCode: answer.status, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(answer.body) };
}
