// Saved project images (SV wiring): starting the rebuild job. The registry (test-env/saved-env.ts) queues a job WITH the commits it is for; this makes the job a PREPARATION on a fresh workspace and hands it to
// the dispatcher, which adds the lease token once, when it delivers (`leaseForDispatch`, see ec2-delivery.ts `savedEnvBuildLease`).
//   - the workspace belongs to `ownerForAutomaticRun` (today the person who approved the environment revision, and only while they are still an active member of the company; their access to the repositories is
//     what the clone runs on, as a nightly run's is), is NOT their default workspace and is written WITHOUT the project index attributes, so it is in no list of their workspaces or of the project's;
//   - the preparation is READ ONLY (no setup command runs on it) and PINNED to the job's commits (the same `pins` a setup run has): the worker refuses it if its own resolution of a branch head differs, so the build
//     is for exactly the commits the job was queued for, and the result is held to them again by `recordBuild`;
//   - `savedEnvBuild` carries the approved environment, the repository the push login will be for and the key's inputs, and NO credential: the stored invocation (outbox, stream, queue) never holds the lease token;
//   - one start per job (a marker row with `attribute_not_exists`), so a retried trigger does not make a second workspace.
// Fails closed: no approver, a moved approved environment, a repository the job has no commit for, or no build inputs (the base image and secret names, from the install) start nothing, and the job's lease runs out.
import { randomUUID } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { WorkspaceInstanceSchema, savedEnvRepositoryName, testEnvDigest, workerProjectDefinition, type OrgId, type PrepareSavedEnvBuild } from "@rovara-code/contracts";
import { type WorkerInvocation } from "@agentx/cloud-contracts";
import { readApprovedBy, readApprovedTestEnvironment } from "../../org/test-environment.js";
import type { SavedEnvDeps } from "../../test-env/saved-env.js";
import { savedEnvEnabled } from "../../test-env/saved-env-switch.js";
import { startMarkerItem } from "../../test-env/saved-env-markers.js";
import { issueCapability, operationOrg, operationRecord, outboxRecord } from "../cancellation.js";
import { hashJson } from "../broker-shared.js";
import { issueRepositoryGrant, workspaceKey, workspaceRuntime } from "./admin-and-helpers.js";
import { orgStoreOf } from "./dependency-wiring.js";
import type { AwsBrokerDependencies } from "./definitions.js";
import { requireLatestProject } from "./records.js";

/** What the install knows of the key's inputs: the base image the saved image is for, the project's secret NAMES, and the detectors' globs. Undefined: the install cannot say, and no job is started. */
export interface SavedEnvBuildInputs { baseImageDigest: string; secretNames: readonly string[]; detectorGlobs: readonly string[] }

export type StartRebuildResult =
  | { started: true; workspaceId: string; operationId: string }
  | { started: false; why: "disabled" | "nothing_queued" | "no_project" | "approved_moved" | "no_owner" | "commits_mismatch" | "no_build_inputs" | "already_started" };


/**
 * WHO a rebuild runs as. Today: the person who approved the environment revision, if they are still an active member of the company (a person who left, or lost their place, owns no automatic work; the start is
 * refused with `no_owner` and the job ended). The decision "System owner for automatic runs" (2026-11-02) replaces this with the project's own automatic identity ("Rovara (project: X)"): that lane swaps THIS function
 * and nothing else here changes.
 */
export async function ownerForAutomaticRun(dependencies: AwsBrokerDependencies, input: { orgId: OrgId; project: string; approvedRevision: number }): Promise<string | undefined> {
  const table = { documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now, ...(dependencies.audit === undefined ? {} : { audit: dependencies.audit }) };
  const approver = await readApprovedBy(table, input.orgId, input.project, input.approvedRevision);
  if (approver === undefined) return undefined;
  try {
    return (await orgStoreOf(dependencies).orgForDeveloper(approver))?.orgId === input.orgId ? approver : undefined;
  } catch {
    return undefined;
  }
}

export async function startSavedEnvRebuild(
  dependencies: AwsBrokerDependencies, ids: { orgId: string; projectId: string },
  inputs: ((orgId: string, project: string) => Promise<SavedEnvBuildInputs | undefined>) | undefined, env: NodeJS.ProcessEnv = process.env,
): Promise<StartRebuildResult> {
  const deps: SavedEnvDeps | undefined = dependencies.savedEnvDeps;
  if (deps === undefined || !savedEnvEnabled(env) || !deps.session.config.enabled) return { started: false, why: "disabled" };
  const orgId = ids.orgId;
  const state = await deps.store.get(ids.orgId, ids.projectId);
  const job = state?.job;
  // Only a queued job that nobody has been given the lease of, and whose lease is live.
  if (state === undefined || job === undefined || job.dispatchedAt !== undefined || Date.parse(job.leaseUntil) <= deps.now() || state.deleted === true || state.archived === true || !state.enabled) return { started: false, why: "nothing_queued" };
  let project;
  try { project = await requireLatestProject(dependencies, orgId, ids.projectId); } catch { return { started: false, why: "no_project" }; }
  const table = { documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: () => deps.now(), ...(dependencies.audit === undefined ? {} : { audit: dependencies.audit }) };
  // The environment the job was queued for is still the newest approved one: the build proves THIS body.
  const approved = await readApprovedTestEnvironment(table, orgId, ids.projectId);
  if (approved === undefined || approved.revision !== job.approved.revision || testEnvDigest(approved.environment) !== job.approved.digest) return { started: false, why: "approved_moved" };
  const owner = await ownerForAutomaticRun(dependencies, { orgId, project: ids.projectId, approvedRevision: approved.revision });
  if (owner === undefined) return { started: false, why: "no_owner" };
  const repositories = workerProjectDefinition(project.definition).repositories;
  // Every repository of the project has a commit in the job, and the job names no other: the pins are the job's commits, whole.
  const names = repositories.map((repository) => repository.name);
  const committed = Object.keys(job.commits);
  if (names.length !== committed.length || names.some((name) => job.commits[name] === undefined)) return { started: false, why: "commits_mismatch" };
  const build = await inputs?.(ids.orgId, ids.projectId);
  if (build === undefined) return { started: false, why: "no_build_inputs" };

  const now = new Date(deps.now()).toISOString();
  const workspaceId = randomUUID();
  const operationId = randomUUID();
  const workspace = WorkspaceInstanceSchema.parse({
    id: workspaceId, ownerKey: owner, orgId, projectName: ids.projectId, projectRevision: project.definition.revision, ...workspaceRuntime(project.runtimeBinding), rootPath: "/mnt/workspace",
    status: "PREPARING", activeOperationId: operationId, fence: 1, createdAt: now, updatedAt: now,
  });
  const pins = names.map((repository) => ({ repository, commit: job.commits[repository]! }));
  const operation = operationRecord({
    ...operationOrg(workspace), id: operationId, workspaceId, kind: "prepare", requestId: randomUUID(), payloadHash: hashJson({ projectName: ids.projectId, jobId: job.jobId }),
    status: "ACCEPTED", fence: workspace.fence, createdAt: now, updatedAt: now,
  });
  operation.savedEnvJobId = job.jobId;
  operation.preparePins = pins;
  const savedEnvBuild: PrepareSavedEnvBuild = {
    jobId: job.jobId, reason: job.reason, approved: job.approved, repository: savedEnvRepositoryName({ env: deps.session.config.env, orgId: ids.orgId, projectId: ids.projectId }),
    expectedKey: job.expectedKey, environment: approved.environment, commits: job.commits, detectorGlobs: [...build.detectorGlobs], secretNames: [...build.secretNames], baseImageDigest: build.baseImageDigest,
  };
  const invocation: WorkerInvocation = {
    protocolVersion: 1, kind: "prepare", operationId, workspaceId, fence: workspace.fence, projectRevision: project.definition.revision, callbackCapability: issueCapability(dependencies, workspaceId, operationId, workspace.fence, { savedEnvBuild: true }),
    payload: { project: workerProjectDefinition(project.definition), repositoryGrant: issueRepositoryGrant(dependencies, project, owner, workspaceId, operationId), readOnly: true, pins, savedEnvBuild },
  };
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      // The marker: one start per job, the ids the sweep needs to settle the end, a time to look again (the sparse index), and an expiry.
      { Put: { TableName: dependencies.tableName, Item: startMarkerItem({ orgId, projectId: ids.projectId, jobId: job.jobId, workspaceId, operationId, createdAt: now, nowMs: deps.now() }), ConditionExpression: "attribute_not_exists(pk)" } },
      // The workspace is written WITHOUT the project index attributes (`workspaceItem` adds them): it is in no list of workspaces, the project's or a person's.
      { Put: { TableName: dependencies.tableName, Item: { ...workspaceKey(workspace.id), entityType: "WORKSPACE", ...workspace }, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: dependencies.tableName, Item: operation, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: dependencies.tableName, Item: outboxRecord(workspace, invocation, project.runtimeBinding), ConditionExpression: "attribute_not_exists(pk)" } },
    ] }));
  } catch (error) {
    if (error instanceof Error && (error.name === "TransactionCanceledException" || error.name === "ConditionalCheckFailedException")) return { started: false, why: "already_started" };
    throw error;
  }
  return { started: true, workspaceId, operationId };
}

