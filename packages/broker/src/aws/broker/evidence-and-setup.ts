// Part of the broker (split out of ../broker.ts): workflow E2E evidence upload and project setup evidence and callbacks.

import { createHash, randomUUID } from "node:crypto";
import { GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { AgentXError, E2EPolicySchema, E2EScenarioBundleSchema, e2eScenarioBundleDigest, E2ERunBindingSchema, E2ERoundSchema, CandidateManifestSchema, selectE2EExecutionPlan, inspectE2ERepository, inspectE2ERepositoryBeforeContractApiTargets, verifyE2ESourceSnapshot, canonicalJson, agentXError, projectMemberKey, projectSetupApprovalKey, type E2ESourceSnapshot, type E2EWorkflowAdmissionRef, E2EWorkflowEvidenceRefSchema, E2EWorkflowGroupEvidenceRefSchema, type E2EApplicationExecutionAdmission, isE2EApplicationAdmissionSchemaVersion, ProjectSetupExecutionSchema, ProjectSetupOperationSchema, ProjectSetupSessionSchema, ProjectSetupRunnerEnvironmentSchema, ProjectSetupRunnerToolchainSchema, projectSetupExecutionKey, projectSetupOperationKey, projectSetupSessionKey } from "@rovara-code/contracts";
import { compileE2EScenarios, collectE2EActualCliRun, e2eSnapshotSourceDigest, parseE2EFirstPartyCapture, e2ePrivateTransferMaxBytes, decodeE2EApplicationExecutionAdmission } from "@agentx/verifier";
import { z } from "zod";
import { readObjectText as readStoredText } from "../../developer/plan-artifacts.js";
import { admitProjectSetupRuntime, projectSetupRuntimeKey, ProjectSetupRuntimeRecordSchema } from "../project-setup-runtime-catalog.js";
import { projectSetupTerminalAuthorityChecks } from "../project-setup-terminal-conditions.js";
import { verifyProjectSetupCapability } from "../project-setup-capability.js";
import { getItem, operationKey, type OperationRecord } from "../cancellation.js";
import { applicationEvidenceLimits } from "../../e2e/application-evidence.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import { parseBody } from "./admin-and-helpers.js";
import { MAX_SETUP_EVIDENCE_BYTES, MAX_SETUP_PROPOSAL_BYTES, SETUP_ARTIFACT_CHUNK_BYTES, type AwsBrokerDependencies } from "./definitions.js";
import { requireRecordProject } from "./dependency-wiring.js";
import { projectSetupDomainRecord, projectSetupRuntimeRecord } from "./feedback-and-codebuild.js";
import { orgOfRecord } from "./scope-helpers.js";

/** The one sentence a planning run's failed export of the unchanged code is stored as (the grounding record reads it as `not-exported`). */
export const GROUNDING_SOURCE_REFUSED_REASON = "the unchanged code's build source was refused for the plan";
export const GROUNDING_SOURCE_NOT_EXPORTED_REASON = "the worker could not export the unchanged code for the plan";

const WORKFLOW_E2E_TRANSFER_CHUNK_BYTES = 64 * 1024;
export const WORKFLOW_E2E_ADMISSION_MAX_BYTES = 24 * 1024 * 1024;

/**
 * An application admission as the evidence upload judges it: decoded by the worker's own decoder (its content address is already checked), with the groups the
 * operation's reference names equal to the groups the admission holds (as sets: the admission is the authority, not the order of the reference), and the sizes its
 * cases and shards allow. Anything else is an admission that is no longer the operation's.
 */
function applicationUploadAdmission(admissionText: string, referencedRunIds: readonly string[]) {
  let admission: E2EApplicationExecutionAdmission;
  try { admission = decodeE2EApplicationExecutionAdmission(Buffer.from(admissionText, "utf8")); }
  catch { throw agentXError("STALE_FENCE", "E2E admission object is unavailable or changed"); }
  const admitted = admission.groups.map((group) => group.outerBinding.runId);
  if (admitted.length !== referencedRunIds.length || canonicalJson([...admitted].sort()) !== canonicalJson([...referencedRunIds].sort())
    || admission.round.groupBindings.length !== admission.groups.length) throw agentXError("STALE_FENCE", "E2E admission no longer matches its operation");
  return { admission, limits: applicationEvidenceLimits(admission) };
}

/** The open upload row an evidence call continues: this operation's, under this fence and admission, and the upload the caller names. */
function requireOpenEvidenceUpload(upload: Record<string, unknown> | undefined, operation: OperationRecord, admissionRef: E2EWorkflowAdmissionRef, groupRunId: string | undefined, uploadId: string): Record<string, unknown> {
  if (!upload || upload.entityType !== "WORKFLOW_E2E_EVIDENCE_UPLOAD" || upload.operationId !== operation.id || upload.fence !== operation.fence
    || upload.groupRunId !== groupRunId || upload.admissionSha256 !== admissionRef.admissionRef.sha256 || upload.status !== "OPEN" || upload.uploadId !== uploadId) throw agentXError("STALE_FENCE", "CHECKS evidence upload is no longer current");
  return upload;
}

/** Stores the next 64 KiB chunk of an open upload, once and in order. */
async function acceptEvidenceChunk(dependencies: AwsBrokerDependencies, operation: OperationRecord, admissionRef: E2EWorkflowAdmissionRef, key: { pk: string; sk: string },
  groupRunId: string | undefined, upload: Record<string, unknown>, body: { index: number; uploadId: string; bytesBase64: string; sha256: string }): Promise<unknown> {
  const index = Number(upload.nextChunkIndex);
  if (body.index !== index || body.index >= Number(upload.chunkCount)) throw agentXError("CALLBACK_FORBIDDEN", "E2E evidence chunks must be uploaded once in order");
  const bytes = Buffer.from(body.bytesBase64, "base64");
  const expected = body.index === Number(upload.chunkCount) - 1 ? Number(upload.totalBytes) - body.index * WORKFLOW_E2E_TRANSFER_CHUNK_BYTES : WORKFLOW_E2E_TRANSFER_CHUNK_BYTES;
  if (bytes.byteLength !== expected || bytes.toString("base64") !== body.bytesBase64 || createHash("sha256").update(bytes).digest("hex") !== body.sha256) throw agentXError("CONFIG_INVALID", "E2E evidence chunk bytes or digest are invalid");
  const chunkKey = `workflow-e2e-staging/${operation.workspaceId}/${operation.id}/${groupRunId ?? "aggregate"}/${body.uploadId}/${body.index}.chunk`;
  await dependencies.s3.send(new PutObjectCommand({ Bucket: dependencies.artifactBucketName, Key: chunkKey, Body: bytes, ContentType: "application/octet-stream", Metadata: { sha256: body.sha256 }, IfNoneMatch: "*" }));
  await dependencies.documentClient.send(new UpdateCommand({ TableName: dependencies.tableName, Key: key, UpdateExpression: "SET nextChunkIndex = :next",
    ConditionExpression: "#status = :open AND nextChunkIndex = :index AND operationId = :operation AND fence = :fence AND admissionSha256 = :admission",
    ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":next": index + 1, ":open": "OPEN", ":index": index, ":operation": operation.id, ":fence": operation.fence, ":admission": admissionRef.admissionRef.sha256 } }));
  return { accepted: true, index };
}

export async function handleWorkflowE2EEvidenceUpload(dependencies: AwsBrokerDependencies, operation: OperationRecord, rawBody: unknown): Promise<unknown> {
  const body = z.discriminatedUnion("stage", [
    z.object({ stage: z.literal("init"), groupRunId: z.string().uuid().optional(), totalBytes: z.number().int().positive().max(WORKFLOW_E2E_ADMISSION_MAX_BYTES), chunkCount: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    z.object({ stage: z.literal("chunk"), groupRunId: z.string().uuid().optional(), uploadId: z.string().uuid(), index: z.number().int().nonnegative(), bytesBase64: z.string().min(1).max(Math.ceil(WORKFLOW_E2E_TRANSFER_CHUNK_BYTES * 4 / 3) + 8), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    z.object({ stage: z.literal("finalize"), groupRunId: z.string().uuid().optional(), uploadId: z.string().uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  ]).parse(rawBody);
  const admissionRef = operation.workflowE2EAdmission;
  if (admissionRef === undefined || operation.workflowMode !== "CHECKS") throw agentXError("CALLBACK_FORBIDDEN", "E2E evidence has no server-assigned admission");
  // A chunk of an application upload continues a row whose init was judged against the decoded admission and carries its digest (`admissionSha256`, which must still be the
  // operation's): it does not read, hash and parse a multi-megabyte admission again for each 64 KiB. Anything else takes the full path below.
  if (body.stage === "chunk" && (body.groupRunId === undefined || admissionRef.groupRunIds.includes(body.groupRunId))) {
    const chunkRowKey = { pk: `WORKSPACE#${operation.workspaceId}`, sk: `WORKFLOW_E2E_UPLOAD#${operation.id}${body.groupRunId === undefined ? "" : `#${body.groupRunId}`}` };
    const row = await getItem<Record<string, unknown>>(dependencies, chunkRowKey);
    if (row?.applicationAdmission === true) {
      return acceptEvidenceChunk(dependencies, operation, admissionRef, chunkRowKey, body.groupRunId, requireOpenEvidenceUpload(row, operation, admissionRef, body.groupRunId, body.uploadId), body);
    }
  }
  const admissionText = await readStoredText(dependencies.s3, dependencies.artifactBucketName, admissionRef.admissionRef.key, WORKFLOW_E2E_ADMISSION_MAX_BYTES);
  if (admissionText === undefined || Buffer.byteLength(admissionText) !== admissionRef.admissionRef.byteLength
    || createHash("sha256").update(admissionText).digest("hex") !== admissionRef.admissionRef.sha256) throw agentXError("STALE_FENCE", "E2E admission object is unavailable or changed");
  const stored = JSON.parse(admissionText) as { schemaVersion?: string; round?: { groupBindings?: Array<{ runId?: string; groupId?: string; expectedCases?: unknown[] }> }; plan?: { groups?: unknown[] };
    taskId?: string; operationId?: string; operationFence?: number; workflowRevision?: number; candidateDigest?: string };
  // An application admission is judged by its own decoder: its groups, plan groups and sizes come from it, never from the portable plan an application round does not have.
  const applicationKind = isE2EApplicationAdmissionSchemaVersion(stored.schemaVersion);
  const application = applicationKind ? applicationUploadAdmission(admissionText, admissionRef.groupRunIds) : undefined;
  const admission = (application?.admission ?? stored) as typeof stored;
  const groups = admission.round?.groupBindings;
  const caseCount = groups?.reduce((sum, group) => sum + (group.expectedCases?.length ?? 0), 0) ?? 0;
  if (!Array.isArray(groups) || groups.length !== admissionRef.groupRunIds.length || caseCount < 1
    || admission.taskId !== admissionRef.taskId || admission.operationId !== operation.id || admission.operationFence !== operation.fence
    || admission.workflowRevision !== admissionRef.workflowRevision || admission.candidateDigest !== admissionRef.candidateDigest) throw agentXError("STALE_FENCE", "E2E admission no longer matches its operation");
  const maxBytes = applicationKind ? application?.limits.aggregate ?? 0 : Math.min(WORKFLOW_E2E_ADMISSION_MAX_BYTES, e2ePrivateTransferMaxBytes(caseCount, groups.length));
  const groupRunId = body.groupRunId;
  const admittedGroupIndex = groupRunId === undefined ? -1 : admissionRef.groupRunIds.indexOf(groupRunId);
  if (groupRunId !== undefined && admittedGroupIndex < 0) throw agentXError("CALLBACK_FORBIDDEN", "E2E group upload is outside the immutable admission");
  // A group is found by its run id in the admission itself; the order of the operation's reference is not what names it.
  const applicationGroupBinding = groupRunId === undefined ? undefined : groups.find((binding) => binding.runId === groupRunId);
  if (application !== undefined && groupRunId !== undefined && (applicationGroupBinding === undefined || !application.limits.byGroup.has(groupRunId))) {
    throw agentXError("CALLBACK_FORBIDDEN", "E2E group upload is outside the immutable admission");
  }
  const selectedGroup = groupRunId === undefined ? undefined : groups[admittedGroupIndex];
  const selectedGroupCaseCount = selectedGroup?.expectedCases?.length ?? 0;
  const transferLimit = groupRunId === undefined ? maxBytes : applicationKind ? application?.limits.byGroup.get(groupRunId) ?? 0
    : Math.min(WORKFLOW_E2E_ADMISSION_MAX_BYTES, e2ePrivateTransferMaxBytes(selectedGroupCaseCount, 1));
  const key = { pk: `WORKSPACE#${operation.workspaceId}`, sk: `WORKFLOW_E2E_UPLOAD#${operation.id}${groupRunId === undefined ? "" : `#${groupRunId}`}` };
  if (body.stage === "init") {
    if (body.chunkCount !== Math.ceil(body.totalBytes / WORKFLOW_E2E_TRANSFER_CHUNK_BYTES) || body.totalBytes > transferLimit) throw agentXError("CONFIG_INVALID", "E2E evidence exceeds its admission-derived transfer bound");
    const existing = await getItem<Record<string, unknown>>(dependencies, key);
    if (existing) {
      if (groupRunId !== undefined && existing.status === "COMPLETE" && existing.entityType === "WORKFLOW_E2E_EVIDENCE_UPLOAD"
        && existing.operationId === operation.id && existing.groupRunId === groupRunId && existing.fence === operation.fence
        && existing.admissionSha256 === admissionRef.admissionRef.sha256 && existing.sha256 === body.sha256
        && existing.totalBytes === body.totalBytes && existing.chunkCount === body.chunkCount && typeof existing.uploadId === "string") {
        const groupEvidenceRef = E2EWorkflowGroupEvidenceRefSchema.safeParse(existing.groupEvidenceRef);
        if (!groupEvidenceRef.success || groupEvidenceRef.data.groupRunId !== groupRunId || groupEvidenceRef.data.evidenceRef.sha256 !== body.sha256) {
          throw agentXError("CALLBACK_FORBIDDEN", "completed group upload does not match its accepted content reference");
        }
        return { uploadId: existing.uploadId, groupRunId, complete: true, evidenceRef: groupEvidenceRef.data.evidenceRef,
          chunkBytes: WORKFLOW_E2E_TRANSFER_CHUNK_BYTES, chunkCount: body.chunkCount };
      }
      if (existing.entityType !== "WORKFLOW_E2E_EVIDENCE_UPLOAD" || existing.status !== "OPEN" || existing.operationId !== operation.id
        || existing.groupRunId !== groupRunId || existing.fence !== operation.fence || existing.admissionSha256 !== admissionRef.admissionRef.sha256 || existing.totalBytes !== body.totalBytes
        || existing.chunkCount !== body.chunkCount || existing.sha256 !== body.sha256 || typeof existing.uploadId !== "string") throw agentXError("CALLBACK_FORBIDDEN", "CHECKS already owns a different evidence upload");
      return { uploadId: existing.uploadId, ...(groupRunId === undefined ? {} : { groupRunId }), chunkBytes: WORKFLOW_E2E_TRANSFER_CHUNK_BYTES, chunkCount: body.chunkCount };
    }
    const uploadId = randomUUID();
    const startedAt = new Date().toISOString();
    // The broker's own receipt of a group's evidence is when its upload started, written once with the row (the condition below refuses a second write, and a retried
    // init finds this row), so a slow or retried upload never moves it. The collector judges the post-close harvest window against it; nothing the worker sends sets it.
    await dependencies.documentClient.send(new PutCommand({ TableName: dependencies.tableName, Item: { ...key, entityType: "WORKFLOW_E2E_EVIDENCE_UPLOAD", schemaVersion: 1,
      operationId: operation.id, ...(groupRunId === undefined ? {} : { groupRunId }), fence: operation.fence, admissionSha256: admissionRef.admissionRef.sha256, uploadId, totalBytes: body.totalBytes,
      chunkCount: body.chunkCount, sha256: body.sha256, nextChunkIndex: 0, status: "OPEN", createdAt: startedAt,
      ...(application === undefined ? {} : { applicationAdmission: true, ...(groupRunId === undefined ? {} : { receivedAt: startedAt }) }) },
      ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" }));
    return { uploadId, ...(groupRunId === undefined ? {} : { groupRunId }), chunkBytes: WORKFLOW_E2E_TRANSFER_CHUNK_BYTES, chunkCount: body.chunkCount };
  }
  const upload = requireOpenEvidenceUpload(await getItem<Record<string, unknown>>(dependencies, key), operation, admissionRef, groupRunId, body.uploadId);
  if (body.stage === "chunk") return acceptEvidenceChunk(dependencies, operation, admissionRef, key, groupRunId, upload, body);
  if (body.sha256 !== upload.sha256 || Number(upload.nextChunkIndex) !== Number(upload.chunkCount)) throw agentXError("STALE_FENCE", "E2E evidence upload is incomplete or changed");
  const chunks: Buffer[] = [];
  const chunkKeys: string[] = [];
  for (let index = 0; index < Number(upload.chunkCount); index += 1) {
    const chunkKey = `workflow-e2e-staging/${operation.workspaceId}/${operation.id}/${groupRunId ?? "aggregate"}/${body.uploadId}/${index}.chunk`;
    const chunk = await readSetupChunk(dependencies, chunkKey);
    if (!chunk) throw agentXError("RUNTIME_UNAVAILABLE", "an owned E2E evidence chunk is missing");
    chunks.push(chunk); chunkKeys.push(chunkKey);
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.byteLength !== Number(upload.totalBytes) || bytes.byteLength > transferLimit || createHash("sha256").update(bytes).digest("hex") !== body.sha256) throw agentXError("CONFIG_INVALID", "assembled E2E evidence failed its bound or digest");
  if (groupRunId !== undefined) {
    const decoded = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    const expectedBinding = application === undefined ? groups[admittedGroupIndex] : applicationGroupBinding;
    const expectedPlanGroup = application === undefined ? admission.plan?.groups?.[admittedGroupIndex]
      : application.admission.executionPlan.groups.find((planGroup) => planGroup.groupId === expectedBinding?.groupId);
    const groupResult = decoded.groupRun as Record<string, unknown> | undefined;
    if (decoded.schemaVersion !== "workflow-e2e-group-evidence/v1" || decoded.admissionSha256 !== admissionRef.admissionRef.sha256
      || decoded.taskId !== admissionRef.taskId || decoded.operationId !== operation.id || decoded.operationFence !== operation.fence
      || decoded.workflowRevision !== admissionRef.workflowRevision || decoded.candidateDigest !== admissionRef.candidateDigest
      || canonicalJson(decoded.round) !== canonicalJson(admission.round) || expectedBinding?.runId !== groupRunId
      || !groupResult || canonicalJson(groupResult.binding) !== canonicalJson(expectedBinding)
      || canonicalJson(groupResult.group) !== canonicalJson(expectedPlanGroup)) {
      throw agentXError("CALLBACK_FORBIDDEN", "E2E group evidence is outside its exact admitted run binding");
    }
    const groupRef = E2EWorkflowGroupEvidenceRefSchema.parse({ groupRunId,
      evidenceRef: { key: `workflow-e2e-group-evidence/sha256/${body.sha256}.json`, sha256: body.sha256, byteLength: bytes.byteLength } });
    const existingObject = await readStoredText(dependencies.s3, dependencies.artifactBucketName, groupRef.evidenceRef.key, transferLimit);
    if (existingObject !== undefined && (Buffer.byteLength(existingObject) !== bytes.byteLength
      || createHash("sha256").update(existingObject).digest("hex") !== body.sha256 || existingObject !== bytes.toString("utf8"))) {
      throw agentXError("CALLBACK_FORBIDDEN", "content-addressed E2E group evidence conflicts with an existing object");
    }
    if (existingObject === undefined) await dependencies.s3.send(new PutObjectCommand({ Bucket: dependencies.artifactBucketName,
      Key: groupRef.evidenceRef.key, Body: bytes, ContentType: "application/json", Metadata: { sha256: body.sha256, operation: operation.id, groupRunId }, IfNoneMatch: "*" }));
    const storedGroupText = await readStoredText(dependencies.s3, dependencies.artifactBucketName, groupRef.evidenceRef.key, transferLimit);
    if (storedGroupText === undefined || Buffer.byteLength(storedGroupText) !== bytes.byteLength
      || createHash("sha256").update(storedGroupText).digest("hex") !== body.sha256 || storedGroupText !== bytes.toString("utf8")) {
      throw agentXError("RUNTIME_UNAVAILABLE", "stored E2E group evidence could not be read back exactly");
    }
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Update: { TableName: dependencies.tableName, Key: key, UpdateExpression: "SET #status = :complete, groupEvidenceRef = :ref",
        ConditionExpression: "#status = :open AND nextChunkIndex = chunkCount AND uploadId = :upload AND groupRunId = :run AND operationId = :operation AND fence = :fence AND admissionSha256 = :admission",
        ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":complete": "COMPLETE", ":open": "OPEN", ":ref": groupRef,
          ":upload": body.uploadId, ":run": groupRunId, ":operation": operation.id, ":fence": operation.fence, ":admission": admissionRef.admissionRef.sha256 } } },
      { Update: { TableName: dependencies.tableName, Key: operationKey(operation.workspaceId, operation.id),
        UpdateExpression: "SET workflowE2EGroupEvidenceRefs = list_append(if_not_exists(workflowE2EGroupEvidenceRefs, :emptyRefs), :refs), workflowE2EGroupRunIds = list_append(if_not_exists(workflowE2EGroupRunIds, :emptyIds), :runIds)",
        ConditionExpression: "#status = :running AND fence = :fence AND workflowMode = :checks AND workflowE2EAdmission.admissionRef.sha256 = :admission AND (attribute_not_exists(workflowE2EGroupRunIds) OR NOT contains(workflowE2EGroupRunIds, :run))",
        ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":emptyRefs": [], ":refs": [groupRef], ":emptyIds": [], ":runIds": [groupRunId],
          ":run": groupRunId, ":running": "RUNNING", ":fence": operation.fence, ":checks": "CHECKS", ":admission": admissionRef.admissionRef.sha256 } } },
    ] }));
    for (const chunkKey of chunkKeys) await dependencies.s3.send(new DeleteObjectCommand({ Bucket: dependencies.artifactBucketName, Key: chunkKey }));
    return { key: groupRef.evidenceRef.key, sha256: groupRef.evidenceRef.sha256, groupRunId };
  }
  const evidenceRef = E2EWorkflowEvidenceRefSchema.parse({ key: `workflow-e2e-evidence/sha256/${body.sha256}.json`, sha256: body.sha256, byteLength: bytes.byteLength });
  const decoded = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  if (decoded.schemaVersion !== "workflow-e2e-evidence/v1" || decoded.admissionSha256 !== admissionRef.admissionRef.sha256
    || decoded.taskId !== admissionRef.taskId || decoded.operationId !== operation.id || decoded.operationFence !== operation.fence
    || decoded.workflowRevision !== admissionRef.workflowRevision || decoded.candidateDigest !== admissionRef.candidateDigest) throw agentXError("CALLBACK_FORBIDDEN", "E2E evidence is outside its admitted CHECKS operation");
  // An application aggregate carries its group runs under its payload and nothing at the top; the portable shape is not one, whatever it holds.
  const payload = decoded.payload as { kind?: unknown; groupRuns?: unknown } | undefined;
  if (application !== undefined && (decoded.groupRuns !== undefined || payload === null || typeof payload !== "object" || Array.isArray(payload) || payload.kind !== "application")) {
    throw agentXError("CALLBACK_FORBIDDEN", "E2E evidence is outside its admitted CHECKS operation");
  }
  const aggregateGroups = application === undefined ? decoded.groupRuns : payload?.groupRuns;
  const currentOperation = await getItem<OperationRecord>(dependencies, operationKey(operation.workspaceId, operation.id));
  const acceptedGroupRefs = currentOperation?.workflowE2EGroupEvidenceRefs ?? [];
  const acceptedGroupIds = currentOperation?.workflowE2EGroupRunIds ?? [];
  if (!Array.isArray(aggregateGroups) || aggregateGroups.length !== admissionRef.groupRunIds.length
    || acceptedGroupRefs.length !== admissionRef.groupRunIds.length || acceptedGroupIds.length !== admissionRef.groupRunIds.length
    || canonicalJson([...acceptedGroupIds].sort()) !== canonicalJson([...admissionRef.groupRunIds].sort())) {
    throw agentXError("STALE_FENCE", "CHECKS aggregate is missing one or more separately accepted admitted group results");
  }
  const acceptedReferenceIds = acceptedGroupRefs.map((raw) => E2EWorkflowGroupEvidenceRefSchema.parse(raw).groupRunId);
  if (new Set(acceptedReferenceIds).size !== admissionRef.groupRunIds.length
    || canonicalJson([...acceptedReferenceIds].sort()) !== canonicalJson([...admissionRef.groupRunIds].sort())) {
    throw agentXError("CALLBACK_FORBIDDEN", "accepted group evidence references do not cover the immutable admission exactly once");
  }
  const aggregateByRun = new Map(aggregateGroups.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw agentXError("CONFIG_INVALID", "CHECKS aggregate group result is malformed");
    const run = raw as Record<string, unknown>;
    const binding = run.binding as Record<string, unknown> | undefined;
    if (typeof binding?.runId !== "string") throw agentXError("CONFIG_INVALID", "CHECKS aggregate group binding is malformed");
    return [binding.runId, run] as const;
  }));
  if (aggregateByRun.size !== admissionRef.groupRunIds.length) throw agentXError("CALLBACK_FORBIDDEN", "CHECKS aggregate contains duplicate or foreign group runs");
  for (const accepted of acceptedGroupRefs) {
    const reference = E2EWorkflowGroupEvidenceRefSchema.parse(accepted);
    if (!admissionRef.groupRunIds.includes(reference.groupRunId)
      || reference.evidenceRef.key !== `workflow-e2e-group-evidence/sha256/${reference.evidenceRef.sha256}.json`) {
      throw agentXError("CALLBACK_FORBIDDEN", "accepted group evidence reference is outside the immutable admission");
    }
    const groupText = await readStoredText(dependencies.s3, dependencies.artifactBucketName, reference.evidenceRef.key, application !== undefined
      ? application.limits.byGroup.get(reference.groupRunId) ?? 0
      : Math.min(maxBytes, e2ePrivateTransferMaxBytes(groups[admissionRef.groupRunIds.indexOf(reference.groupRunId)]?.expectedCases?.length ?? 0, 1)));
    if (groupText === undefined || Buffer.byteLength(groupText) !== reference.evidenceRef.byteLength
      || createHash("sha256").update(groupText).digest("hex") !== reference.evidenceRef.sha256) throw agentXError("STALE_FENCE", "an accepted E2E group result is unavailable or changed");
    const groupEnvelope = JSON.parse(groupText) as Record<string, unknown>;
    const aggregateGroup = aggregateByRun.get(reference.groupRunId);
    if (groupEnvelope.schemaVersion !== "workflow-e2e-group-evidence/v1" || groupEnvelope.admissionSha256 !== admissionRef.admissionRef.sha256
      || groupEnvelope.taskId !== admissionRef.taskId || groupEnvelope.operationId !== operation.id || groupEnvelope.operationFence !== operation.fence
      || groupEnvelope.workflowRevision !== admissionRef.workflowRevision || groupEnvelope.candidateDigest !== admissionRef.candidateDigest
      || canonicalJson(groupEnvelope.round) !== canonicalJson(admission.round) || canonicalJson(groupEnvelope.groupRun) !== canonicalJson(aggregateGroup)) {
      throw agentXError("CALLBACK_FORBIDDEN", "CHECKS aggregate differs from a separately accepted group result");
    }
  }
  await dependencies.s3.send(new PutObjectCommand({ Bucket: dependencies.artifactBucketName, Key: evidenceRef.key, Body: bytes, ContentType: "application/json", Metadata: { sha256: body.sha256, operation: operation.id }, IfNoneMatch: "*" }));
  await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
    { Update: { TableName: dependencies.tableName, Key: key, UpdateExpression: "SET #status = :complete, evidenceRef = :ref", ConditionExpression: "#status = :open AND nextChunkIndex = chunkCount AND uploadId = :upload AND operationId = :operation AND fence = :fence AND admissionSha256 = :admission",
      ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":complete": "COMPLETE", ":open": "OPEN", ":ref": evidenceRef, ":upload": body.uploadId, ":operation": operation.id, ":fence": operation.fence, ":admission": admissionRef.admissionRef.sha256 } } },
    { Update: { TableName: dependencies.tableName, Key: operationKey(operation.workspaceId, operation.id), UpdateExpression: "SET workflowE2EEvidenceRef = :ref",
      ConditionExpression: "#status = :running AND fence = :fence AND workflowMode = :checks AND attribute_not_exists(workflowE2EEvidenceRef)",
      ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":ref": evidenceRef, ":running": "RUNNING", ":fence": operation.fence, ":checks": "CHECKS" } } },
  ] }));
  for (const chunkKey of chunkKeys) await dependencies.s3.send(new DeleteObjectCommand({ Bucket: dependencies.artifactBucketName, Key: chunkKey }));
  return { key: evidenceRef.key, sha256: evidenceRef.sha256 };
}

export function workflowCandidateSourceExportSchema() {
  return z.object({ schemaVersion: z.literal("workflow-candidate-source/v1"), candidate: CandidateManifestSchema,
    repositories: z.array(z.object({ repositoryId: z.string().min(1).max(200), commitSha: z.string().regex(/^[a-f0-9]{40}$/), treeSha: z.string().regex(/^[a-f0-9]{40}$/),
      baseCommitSha: z.string().regex(/^[a-f0-9]{40}$/).optional(), treeComplete: z.literal(true), treePaths: z.array(z.string().min(1).max(1024)).max(100_000),
      sources: z.array(z.object({ path: z.string().min(1).max(1024), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytesBase64: z.string().max(700_000), kind: z.literal("blob") }).strict()).max(512),
    }).strict()).max(32),
  }).strict();
}

export async function handleProjectSetupExecutionRead(dependencies: AwsBrokerDependencies, request: AdaptedHttpRequest, setupExecutionId: string, rawOffset: string | null): Promise<unknown> {
  const authorized = await requireProjectSetupCapability(dependencies, request, setupExecutionId, "read-execution");
  const offset = rawOffset === null ? 0 : Number(rawOffset);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset % SETUP_ARTIFACT_CHUNK_BYTES !== 0 || offset >= authorized.execution.executionRef.byteLength) throw agentXError("CONFIG_INVALID", "project setup source chunk offset is invalid");
  const deadlineAt = authorized.execution.deadlineAt;
  if (Date.parse(deadlineAt) <= Date.now()) throw agentXError("STALE_FENCE", "project setup source read is past its stored deadline");
  const lastByte = Math.min(offset + SETUP_ARTIFACT_CHUNK_BYTES, authorized.execution.executionRef.byteLength) - 1;
  const response = await dependencies.s3.send(new GetObjectCommand({ Bucket: dependencies.artifactBucketName, Key: authorized.execution.executionRef.key,
    Range: `bytes=${offset}-${lastByte}` }) as never) as { Body?: { transformToByteArray(): Promise<Uint8Array> }; ContentRange?: string; ContentLength?: number };
  if (!response.Body || typeof response.ContentRange !== "string") throw agentXError("RUNTIME_UNAVAILABLE", "approved project setup source object is unreadable");
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.ContentRange);
  if (!range || Number(range[1]) !== offset || Number(range[2]) !== lastByte || Number(range[3]) !== authorized.execution.executionRef.byteLength) throw agentXError("RUNTIME_UNAVAILABLE", "approved project setup source range is inconsistent");
  const totalBytes = Number(range[3]);
  const bytes = await response.Body.transformToByteArray();
  if (totalBytes > MAX_SETUP_PROPOSAL_BYTES || bytes.byteLength !== lastByte - offset + 1 || bytes.byteLength > SETUP_ARTIFACT_CHUNK_BYTES) {
    throw agentXError("RUNTIME_UNAVAILABLE", "approved project setup source object exceeds its bounded range");
  }
  return { setupExecutionId, operationId: authorized.claims.operationId, fence: authorized.claims.fence, executionRef: authorized.execution.executionRef,
    offset, totalBytes, deadlineAt, chunkBase64: Buffer.from(bytes).toString("base64") };
}

export async function handleProjectSetupEvidenceInit(dependencies: AwsBrokerDependencies, request: AdaptedHttpRequest, setupExecutionId: string): Promise<unknown> {
  const authorized = await requireProjectSetupCapability(dependencies, request, setupExecutionId, "write-evidence");
  const body = z.object({ schemaVersion: z.literal("project-setup-evidence-upload/v1"), totalBytes: z.number().int().positive().max(MAX_SETUP_EVIDENCE_BYTES),
    chunkCount: z.number().int().positive().max(Math.ceil(MAX_SETUP_EVIDENCE_BYTES / SETUP_ARTIFACT_CHUNK_BYTES)), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(parseBody(request.body));
  const expectedChunkCount = Math.ceil(body.totalBytes / SETUP_ARTIFACT_CHUNK_BYTES);
  if (body.chunkCount !== expectedChunkCount || body.totalBytes > authorized.execution.evidenceByteLimit) throw agentXError("CONFIG_INVALID", "setup evidence exceeds its admitted constituent ceiling or chunk count");
  const deadlineAt = authorized.execution.deadlineAt;
  if (Date.parse(deadlineAt) <= Date.now()) throw agentXError("STALE_FENCE", "project setup evidence upload is past its stored deadline");
  const uploadKey = { pk: `PROJECT_SETUP#${setupExecutionId}`, sk: `EVIDENCE_UPLOAD#${authorized.claims.operationId}` };
  const existing = await getItem<Record<string, unknown>>(dependencies, uploadKey);
  const existingSession = projectSetupDomainRecord(existing, uploadKey, "PROJECT_SETUP_EVIDENCE_UPLOAD");
  if (existing) {
    if (existingSession.status !== "OPEN" || existingSession.setupExecutionId !== setupExecutionId || existingSession.subjectId !== authorized.execution.subjectId
      || existingSession.operationId !== authorized.claims.operationId || existingSession.fence !== authorized.claims.fence
      || existingSession.totalBytes !== body.totalBytes || existingSession.chunkCount !== body.chunkCount || existingSession.sha256 !== body.sha256
      || existingSession.evidenceByteLimit !== authorized.execution.evidenceByteLimit
      || typeof existingSession.uploadId !== "string") throw agentXError("CALLBACK_FORBIDDEN", "project setup operation already owns a different evidence upload");
    return { setupExecutionId, operationId: authorized.claims.operationId, fence: authorized.claims.fence, uploadId: existingSession.uploadId,
      totalBytes: body.totalBytes, chunkCount: body.chunkCount, chunkBytes: SETUP_ARTIFACT_CHUNK_BYTES, deadlineAt: existingSession.deadlineAt };
  }
  const uploadId = randomUUID();
  const item = { ...uploadKey, entityType: "PROJECT_SETUP_EVIDENCE_UPLOAD",
    schemaVersion: 1, setupExecutionId, subjectId: authorized.execution.subjectId, operationId: authorized.claims.operationId, uploadId, fence: authorized.claims.fence,
    approvalRevision: authorized.execution.approvalRevision, transportCorrelationId: authorized.execution.transportCorrelationId,
    totalBytes: body.totalBytes, evidenceByteLimit: authorized.execution.evidenceByteLimit, chunkCount: body.chunkCount, sha256: body.sha256, nextChunkIndex: 0, deadlineAt, status: "OPEN", createdAt: new Date().toISOString() };
  await dependencies.documentClient.send(new PutCommand({ TableName: dependencies.tableName, Item: item, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" }));
  return { setupExecutionId, operationId: authorized.claims.operationId, fence: authorized.claims.fence, uploadId, totalBytes: body.totalBytes,
    chunkCount: body.chunkCount, chunkBytes: SETUP_ARTIFACT_CHUNK_BYTES, deadlineAt };
}

export async function handleProjectSetupEvidenceChunk(dependencies: AwsBrokerDependencies, request: AdaptedHttpRequest, setupExecutionId: string): Promise<unknown> {
  const authorized = await requireProjectSetupCapability(dependencies, request, setupExecutionId, "write-evidence");
  const body = z.object({ schemaVersion: z.literal("project-setup-evidence-chunk/v1"), uploadId: z.string().uuid(), index: z.number().int().nonnegative(),
    bytesBase64: z.string().min(1).max(Math.ceil(SETUP_ARTIFACT_CHUNK_BYTES * 4 / 3) + 8), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(parseBody(request.body));
  const key = { pk: `PROJECT_SETUP#${setupExecutionId}`, sk: `EVIDENCE_UPLOAD#${authorized.claims.operationId}` };
  const upload = await getItem<Record<string, unknown>>(dependencies, key);
  const session = projectSetupDomainRecord(upload, key, "PROJECT_SETUP_EVIDENCE_UPLOAD");
  const deadlineAt = typeof session.deadlineAt === "string" ? session.deadlineAt : "";
  if (session.status !== "OPEN" || session.uploadId !== body.uploadId || session.setupExecutionId !== setupExecutionId || session.subjectId !== authorized.execution.subjectId
    || session.operationId !== authorized.claims.operationId || session.fence !== authorized.claims.fence || session.approvalRevision !== authorized.execution.approvalRevision
    || session.transportCorrelationId !== authorized.execution.transportCorrelationId || Date.parse(deadlineAt) <= Date.now()) throw agentXError("STALE_FENCE", "setup evidence upload is not current");
  const totalBytes = Number(session.totalBytes);
  const chunkCount = Number(session.chunkCount);
  if (!Number.isSafeInteger(body.index) || body.index >= chunkCount || totalBytes > authorized.execution.evidenceByteLimit
    || session.evidenceByteLimit !== authorized.execution.evidenceByteLimit || chunkCount !== Math.ceil(totalBytes / SETUP_ARTIFACT_CHUNK_BYTES)) throw agentXError("CONFIG_INVALID", "setup evidence chunk index or admitted total is outside its upload");
  const bytes = Buffer.from(body.bytesBase64, "base64");
  const expectedLength = body.index === chunkCount - 1 ? totalBytes - body.index * SETUP_ARTIFACT_CHUNK_BYTES : SETUP_ARTIFACT_CHUNK_BYTES;
  if (bytes.byteLength !== expectedLength || bytes.toString("base64") !== body.bytesBase64 || createHash("sha256").update(bytes).digest("hex") !== body.sha256) throw agentXError("CONFIG_INVALID", "setup evidence chunk length or digest is invalid");
  const nextChunkIndex = Number(session.nextChunkIndex);
  if (body.index > nextChunkIndex) throw agentXError("CONFIG_INVALID", "setup evidence chunks must arrive in order");
  const objectKey = `project-setup-staging/${setupExecutionId}/${authorized.claims.operationId}/${body.uploadId}/${body.index}.chunk`;
  if (body.index < nextChunkIndex) {
    const existing = await readSetupChunk(dependencies, objectKey);
    if (!existing || !existing.equals(bytes)) throw agentXError("CALLBACK_FORBIDDEN", "replayed setup evidence chunk differs from the owned chunk");
    return { accepted: true, index: body.index, duplicate: true };
  }
  try {
    await dependencies.s3.send(new PutObjectCommand({ Bucket: dependencies.artifactBucketName, Key: objectKey, Body: bytes,
      ContentType: "application/octet-stream", Metadata: { sha256: body.sha256, upload: body.uploadId, index: String(body.index) }, IfNoneMatch: "*" }));
  } catch (error) {
    const status = error && typeof error === "object" ? (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode : undefined;
    if (status !== 412 && (error as { name?: unknown } | undefined)?.name !== "PreconditionFailed") throw error;
    const existing = await readSetupChunk(dependencies, objectKey);
    if (!existing || !existing.equals(bytes)) throw agentXError("CALLBACK_FORBIDDEN", "setup evidence chunk key is already occupied by different bytes");
  }
  await dependencies.documentClient.send(new UpdateCommand({ TableName: dependencies.tableName, Key: key,
    UpdateExpression: "SET nextChunkIndex = :next", ConditionExpression: "#status = :open AND nextChunkIndex = :index AND fence = :fence AND operationId = :operationId",
    ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":next": body.index + 1, ":open": "OPEN", ":index": body.index,
      ":fence": authorized.claims.fence, ":operationId": authorized.claims.operationId } }));
  return { accepted: true, index: body.index, duplicate: false };
}

export async function handleProjectSetupEvidenceFinalize(dependencies: AwsBrokerDependencies, request: AdaptedHttpRequest, setupExecutionId: string): Promise<unknown> {
  const authorized = await requireProjectSetupCapability(dependencies, request, setupExecutionId, "write-evidence");
  const body = z.object({ schemaVersion: z.literal("project-setup-evidence-finalize/v1"), uploadId: z.string().uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(parseBody(request.body));
  const key = { pk: `PROJECT_SETUP#${setupExecutionId}`, sk: `EVIDENCE_UPLOAD#${authorized.claims.operationId}` };
  const raw = await getItem<Record<string, unknown>>(dependencies, key);
  const session = projectSetupDomainRecord(raw, key, "PROJECT_SETUP_EVIDENCE_UPLOAD");
  if (session.status === "COMPLETE" && session.uploadId === body.uploadId && session.sha256 === body.sha256 && session.operationId === authorized.claims.operationId
    && session.fence === authorized.claims.fence && session.evidenceKey === `project-setup-evidence/sha256/${body.sha256}.json`) {
    return { evidenceRef: { key: session.evidenceKey, sha256: body.sha256 } };
  }
  if (session.status !== "OPEN" || session.uploadId !== body.uploadId || session.setupExecutionId !== setupExecutionId || session.subjectId !== authorized.execution.subjectId
    || session.operationId !== authorized.claims.operationId || session.fence !== authorized.claims.fence || session.sha256 !== body.sha256
    || Number(session.nextChunkIndex) !== Number(session.chunkCount) || Number(session.totalBytes) > authorized.execution.evidenceByteLimit
    || session.evidenceByteLimit !== authorized.execution.evidenceByteLimit || Date.parse(String(session.deadlineAt)) <= Date.now()) throw agentXError("STALE_FENCE", "setup evidence upload is incomplete or no longer current");
  const chunks: Buffer[] = [];
  const chunkKeys: string[] = [];
  for (let index = 0; index < Number(session.chunkCount); index += 1) {
    const chunkKey = `project-setup-staging/${setupExecutionId}/${authorized.claims.operationId}/${body.uploadId}/${index}.chunk`;
    const chunk = await readSetupChunk(dependencies, chunkKey);
    if (!chunk) throw agentXError("RUNTIME_UNAVAILABLE", "an owned setup evidence chunk is missing");
    chunks.push(chunk);
    chunkKeys.push(chunkKey);
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.byteLength !== Number(session.totalBytes) || createHash("sha256").update(bytes).digest("hex") !== body.sha256) throw agentXError("CONFIG_INVALID", "assembled setup evidence does not match its declared bytes or digest");
  let evidence: Record<string, unknown>;
  try {
    const decoded: unknown = JSON.parse(bytes.toString("utf8"));
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("invalid evidence");
    evidence = decoded as Record<string, unknown>;
  } catch { throw agentXError("CONFIG_INVALID", "setup evidence object is malformed"); }
  if (evidence.schemaVersion !== "project-setup-smoke-evidence/v1" || evidence.setupExecutionId !== setupExecutionId
    || evidence.subjectId !== authorized.execution.subjectId || evidence.transportCorrelationId !== authorized.execution.transportCorrelationId
    || evidence.executionRefSha256 !== authorized.execution.executionRef.sha256 || evidence.candidateDigest !== authorized.execution.candidateDigest) {
    throw agentXError("CALLBACK_FORBIDDEN", "setup evidence is outside its stored project execution");
  }
  const evidenceKey = `project-setup-evidence/sha256/${body.sha256}.json`;
  try {
    await dependencies.s3.send(new PutObjectCommand({ Bucket: dependencies.artifactBucketName, Key: evidenceKey, Body: bytes, ContentType: "application/json",
      Metadata: { sha256: body.sha256, domain: "project-setup-smoke-evidence-v1" }, IfNoneMatch: "*" }));
  } catch (error) {
    const status = error && typeof error === "object" ? (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode : undefined;
    if (status !== 412 && (error as { name?: unknown } | undefined)?.name !== "PreconditionFailed") throw error;
    if (await readStoredText(dependencies.s3, dependencies.artifactBucketName, evidenceKey, MAX_SETUP_EVIDENCE_BYTES) !== bytes.toString("utf8")) {
      throw agentXError("RUNTIME_UNAVAILABLE", "existing setup evidence object does not match its content address");
    }
  }
  await dependencies.documentClient.send(new UpdateCommand({ TableName: dependencies.tableName, Key: { pk: `PROJECT_SETUP#${setupExecutionId}`, sk: `EVIDENCE_UPLOAD#${authorized.claims.operationId}` },
    UpdateExpression: "SET #status = :complete, evidenceKey = :evidenceKey, completedAt = :completedAt",
    ConditionExpression: "#status = :open AND nextChunkIndex = chunkCount AND operationId = :operationId AND fence = :fence",
    ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":complete": "COMPLETE", ":open": "OPEN", ":evidenceKey": evidenceKey,
      ":completedAt": new Date().toISOString(), ":operationId": authorized.claims.operationId, ":fence": authorized.claims.fence } }));
  for (const chunkKey of chunkKeys) await dependencies.s3.send(new DeleteObjectCommand({ Bucket: dependencies.artifactBucketName, Key: chunkKey }));
  return { evidenceRef: { key: evidenceKey, sha256: body.sha256 } };
}

/** An object's exact bytes, at most `maxBytes` of them; undefined when it cannot be read. */
export async function readStoredBytes(dependencies: AwsBrokerDependencies, key: string, maxBytes: number): Promise<Buffer | undefined> {
  try {
    const response = await dependencies.s3.send(new GetObjectCommand({ Bucket: dependencies.artifactBucketName, Key: key, Range: `bytes=0-${maxBytes - 1}` })) as { Body?: { transformToByteArray(): Promise<Uint8Array> } };
    return response.Body ? Buffer.from(await response.Body.transformToByteArray()) : undefined;
  } catch { return undefined; }
}

export async function readSetupChunk(dependencies: AwsBrokerDependencies, key: string): Promise<Buffer | undefined> {
  try {
    const response = await dependencies.s3.send(new GetObjectCommand({ Bucket: dependencies.artifactBucketName, Key: key })) as { Body?: { transformToByteArray(): Promise<Uint8Array> } };
    if (!response.Body) return undefined;
    const bytes = Buffer.from(await response.Body.transformToByteArray());
    return bytes.byteLength > 0 && bytes.byteLength <= SETUP_ARTIFACT_CHUNK_BYTES ? bytes : undefined;
  } catch (error) {
    const name = error && typeof error === "object" ? (error as { name?: unknown }).name : undefined;
    const status = error && typeof error === "object" ? (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode : undefined;
    if (name === "NoSuchKey" || status === 404) return undefined;
    throw error;
  }
}

async function requireProjectSetupCapability(
  dependencies: AwsBrokerDependencies, request: AdaptedHttpRequest, setupExecutionId: string, action: "read-execution" | "write-evidence" | "result",
): Promise<{ execution: ReturnType<typeof ProjectSetupExecutionSchema.parse>; claims: NonNullable<ReturnType<typeof verifyProjectSetupCapability>>;
  runtime: ReturnType<typeof ProjectSetupRuntimeRecordSchema.parse>; session: ReturnType<typeof ProjectSetupSessionSchema.parse> }> {
  const token = request.headers["x-agentx-callback-capability"];
  const claims = token ? verifyProjectSetupCapability(dependencies.callbackSigningKey, token) : undefined;
  if (!claims || claims.setupExecutionId !== setupExecutionId || !claims.actions.includes(action)) throw agentXError("CALLBACK_FORBIDDEN", "setup capability does not authorize this artifact action");
  const [executionItem, operationItem, sessionItem] = await Promise.all([
    getItem<Record<string, unknown>>(dependencies, projectSetupExecutionKey(setupExecutionId)),
    getItem<Record<string, unknown>>(dependencies, projectSetupOperationKey(setupExecutionId, claims.operationId)),
    getItem<Record<string, unknown>>(dependencies, projectSetupSessionKey(setupExecutionId)),
  ]);
  const execution = ProjectSetupExecutionSchema.safeParse(projectSetupDomainRecord(executionItem, projectSetupExecutionKey(setupExecutionId), "PROJECT_SETUP_EXECUTION"));
  const operation = ProjectSetupOperationSchema.safeParse(projectSetupDomainRecord(operationItem, projectSetupOperationKey(setupExecutionId, claims.operationId), "PROJECT_SETUP_OPERATION"));
  const session = ProjectSetupSessionSchema.safeParse(projectSetupDomainRecord(sessionItem, projectSetupSessionKey(setupExecutionId), "PROJECT_SETUP_SESSION"));
  if (!execution.success || !operation.success || !session.success || execution.data.state !== "DISPATCHING"
    || operation.data.status !== "DISPATCHING" && operation.data.status !== "DELIVERED"
    || execution.data.operationId !== claims.operationId || execution.data.subjectId !== claims.subjectId
    || execution.data.transportCorrelationId !== claims.transportCorrelationId || execution.data.approvalRevision !== claims.approvalRevision
    || execution.data.fence !== claims.fence || operation.data.fence !== claims.fence || session.data.state !== "READY"
    || session.data.generation !== execution.data.runtimeGeneration || session.data.bindingDigest !== execution.data.bindingDigest) {
    throw agentXError("STALE_FENCE", "setup artifact operation is no longer current");
  }
  if (!(await setupAdmissionMatchesExecution(dependencies, execution.data))) {
    throw agentXError("STALE_FENCE", "immutable setup admission no longer matches its stored execution identity");
  }
  const project = await requireRecordProject(dependencies, execution.data, execution.data.projectName, execution.data.projectRevision);
  if (project.runtimeBinding.deploymentMode !== "ec2-ebs") throw agentXError("RUNTIME_UNAVAILABLE", "project setup requires the configured EC2 setup runtime");
  const approval = await getItem<Record<string, unknown>>(dependencies, projectSetupApprovalKey(await orgOfRecord(dependencies, execution.data), execution.data.projectName, execution.data.proposalSha256));
  if (project.registeredBy !== execution.data.ownerKey || project.setupApproval?.decision !== "approve"
    || project.setupApproval.proposalSha256 !== execution.data.proposalSha256 || !approval || approval.ownerKey !== execution.data.ownerKey
    || approval.decision !== "approve" || approval.proposalRef !== execution.data.proposalRef || approval.policyDigest !== execution.data.policyDigest) {
    throw agentXError("CALLBACK_FORBIDDEN", "current project setup approval is no longer valid");
  }
  const member = await getItem<{ role?: unknown }>(dependencies, projectMemberKey(await orgOfRecord(dependencies, execution.data), execution.data.ownerKey, execution.data.projectName));
  const catalogId = dependencies.projectSetupRuntimeCatalogId;
  if (member?.role !== "administrator" || !catalogId) throw agentXError("CALLBACK_FORBIDDEN", "project setup owner authority or runtime catalog is unavailable");
  const catalogItem = await dependencies.documentClient.send(new GetCommand({ TableName: dependencies.tableName,
    Key: projectSetupRuntimeKey(catalogId, execution.data.bindingDigest), ConsistentRead: true }));
  const runtimeKey = projectSetupRuntimeKey(catalogId, execution.data.bindingDigest);
  const runtime = ProjectSetupRuntimeRecordSchema.safeParse(projectSetupRuntimeRecord(catalogItem.Item, runtimeKey));
  if (!runtime.success || runtime.data.runtimeCatalogId !== execution.data.runtimeCatalogId
    || runtime.data.catalogRevision !== execution.data.runtimeCatalogRevision
    || runtime.data.transportCorrelationId !== execution.data.transportCorrelationId || runtime.data.generation !== execution.data.runtimeGeneration
    || !admitProjectSetupRuntime(runtime.data, { runtimeCatalogId: catalogId, binding: project.runtimeBinding, scope: "source-interface", now: Date.now() })) {
    throw agentXError("STALE_FENCE", "current configured setup runtime is no longer qualified");
  }
  return { execution: execution.data, claims, runtime: runtime.data, session: session.data };
}

export async function setupAdmissionMatchesExecution(
  dependencies: AwsBrokerDependencies,
  execution: ReturnType<typeof ProjectSetupExecutionSchema.parse>,
): Promise<boolean> {
  const text = await readStoredText(dependencies.s3, dependencies.artifactBucketName, execution.executionRef.key, MAX_SETUP_PROPOSAL_BYTES);
  if (text === undefined || Buffer.byteLength(text, "utf8") !== execution.executionRef.byteLength
    || createHash("sha256").update(text, "utf8").digest("hex") !== execution.executionRef.sha256) return false;
  let admission: unknown;
  try { admission = JSON.parse(text); } catch { return false; }
  if (!admission || typeof admission !== "object" || Array.isArray(admission)) return false;
  const value = admission as Record<string, unknown>;
  const runtime = value.runtime && typeof value.runtime === "object" && !Array.isArray(value.runtime)
    ? value.runtime as Record<string, unknown> : undefined;
  return value.domain === "project-setup-source-interface/v1" && value.setupExecutionId === execution.setupExecutionId
    && value.subjectId === execution.subjectId && value.transportCorrelationId === execution.transportCorrelationId
    && value.candidateDigest === execution.candidateDigest && runtime?.runtimeCatalogId === execution.runtimeCatalogId
    && runtime.catalogRevision === execution.runtimeCatalogRevision && runtime.bindingDigest === execution.bindingDigest
    && runtime.generation === execution.runtimeGeneration && runtime.transportCorrelationId === execution.transportCorrelationId;
}

export async function handleProjectSetupCallback(
  dependencies: AwsBrokerDependencies,
  request: AdaptedHttpRequest,
  setupExecutionId: string,
  operationId: string,
): Promise<{ accepted: true; parked?: true; qualification?: "UNKNOWN" }> {
  const token = request.headers["x-agentx-callback-capability"];
  const claims = token ? verifyProjectSetupCapability(dependencies.callbackSigningKey, token) : undefined;
  if (!claims || claims.setupExecutionId !== setupExecutionId || claims.operationId !== operationId) {
    throw agentXError("CALLBACK_FORBIDDEN", "callback capability is outside the project setup result scope");
  }
  const body = z.object({
    domain: z.literal("project-setup-source-interface/v1"), setupExecutionId: z.string().uuid(), operationId: z.string().uuid(),
    candidateDigest: z.string().regex(/^[a-f0-9]{64}$/), processStatus: z.enum(["SUCCEEDED", "FAILED", "UNKNOWN"]),
    qualification: z.enum(["PASS", "FAILED", "UNKNOWN"]), cleanupConfirmed: z.boolean(),
    evidenceRef: z.object({ key: z.string().min(1).max(512), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
  }).strict().parse(parseBody(request.body));
  const authorized = await requireProjectSetupCapability(dependencies, request, setupExecutionId, "result").catch(async (error: unknown) => {
    if (!(error instanceof AgentXError) || !["CALLBACK_FORBIDDEN", "STALE_FENCE", "RUNTIME_UNAVAILABLE"].includes(error.code)) throw error;
    const parked = await parkProjectSetupResultAfterAuthorityChange(dependencies, setupExecutionId, operationId, claims, {
      setupExecutionId: body.setupExecutionId, operationId: body.operationId, candidateDigest: body.candidateDigest,
      processStatus: body.processStatus, qualification: body.qualification, cleanupConfirmed: body.cleanupConfirmed,
      ...(body.evidenceRef ? { evidenceRef: body.evidenceRef } : {}),
    });
    if (!parked) throw error;
    return undefined;
  });
  if (!authorized) return { accepted: true, parked: true, qualification: "UNKNOWN" };
  const current = authorized.execution;
  if (body.setupExecutionId !== current.setupExecutionId || body.operationId !== current.operationId) {
    throw agentXError("CALLBACK_FORBIDDEN", "project setup result does not match its immutable source execution");
  }
  if (body.candidateDigest === "0".repeat(64)) {
    if ((body.processStatus !== "FAILED" && body.processStatus !== "UNKNOWN") || body.qualification !== "UNKNOWN"
      || body.cleanupConfirmed !== false || body.evidenceRef !== undefined) {
      throw agentXError("CALLBACK_FORBIDDEN", "an unbound worker failure may only report an unknown, unqualified terminal result");
    }
    const now = new Date().toISOString();
    const parkedResult = { domain: body.domain, candidateDigest: current.candidateDigest, processStatus: "UNKNOWN", qualification: "UNKNOWN",
      cleanupConfirmed: false, reportedCandidateDigest: body.candidateDigest, reportedProcessStatus: body.processStatus, reportedQualification: body.qualification,
      reportedCleanupConfirmed: body.cleanupConfirmed, parkReason: "worker-failure-without-candidate" };
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      ...projectSetupTerminalAuthorityChecks(dependencies.tableName, await orgOfRecord(dependencies, current), current, authorized.runtime, authorized.session),
      { Update: { TableName: dependencies.tableName, Key: projectSetupExecutionKey(setupExecutionId),
        UpdateExpression: "SET #state = :parked, updatedAt = :now, completedAt = :now, #result = :result",
        ConditionExpression: "#state = :dispatching AND operationId = :operationId AND subjectId = :subjectId AND fence = :fence AND approvalRevision = :approvalRevision AND transportCorrelationId = :correlation",
        ExpressionAttributeNames: { "#state": "state", "#result": "result" }, ExpressionAttributeValues: { ":parked": "PARKED", ":dispatching": "DISPATCHING",
          ":now": now, ":result": parkedResult, ":operationId": operationId, ":subjectId": current.subjectId, ":fence": current.fence,
          ":approvalRevision": current.approvalRevision, ":correlation": current.transportCorrelationId } } },
      { Update: { TableName: dependencies.tableName, Key: projectSetupOperationKey(setupExecutionId, operationId),
        UpdateExpression: "SET #status = :parked, updatedAt = :now, #result = :result",
        ConditionExpression: "(#status = :dispatching OR #status = :delivered) AND setupExecutionId = :setupExecutionId AND operationId = :operationId AND fence = :fence AND transportCorrelationId = :correlation",
        ExpressionAttributeNames: { "#status": "status", "#result": "result" }, ExpressionAttributeValues: { ":parked": "PARKED", ":dispatching": "DISPATCHING",
          ":delivered": "DELIVERED", ":now": now, ":result": parkedResult, ":setupExecutionId": setupExecutionId,
          ":operationId": operationId, ":fence": current.fence, ":correlation": current.transportCorrelationId } } },
    ] }));
    return { accepted: true, parked: true, qualification: "UNKNOWN" };
  }
  if (body.candidateDigest !== current.candidateDigest) {
    throw agentXError("CALLBACK_FORBIDDEN", "project setup result does not match its immutable source execution");
  }
  const verified = body.evidenceRef ? await verifyProjectSetupSmokeEvidence(dependencies, current, body.evidenceRef, authorized.runtime.runnerEnvironment, authorized.runtime.runnerToolchain) : undefined;
  const processStatus = verified?.processStatus ?? "UNKNOWN";
  const qualification = verified?.qualification ?? "UNKNOWN";
  const cleanupConfirmed = verified?.cleanupConfirmed ?? false;
  const terminalState = processStatus === "SUCCEEDED" ? "SUCCEEDED" : processStatus === "FAILED" ? "FAILED" : "PARKED";
  const persistedResult = { domain: body.domain, candidateDigest: current.candidateDigest, processStatus,
    qualification, cleanupConfirmed, ...(verified?.evidenceRef ? { evidenceRef: verified.evidenceRef } : {}) };
  const terminalAt = new Date().toISOString();
  if (Date.parse(authorized.runtime.qualifiedAt) > Date.parse(terminalAt) || Date.parse(authorized.runtime.expiresAt) <= Date.parse(terminalAt)) {
    const parked = await parkProjectSetupResultAfterAuthorityChange(dependencies, setupExecutionId, operationId, claims, {
      setupExecutionId: body.setupExecutionId, operationId: body.operationId, candidateDigest: body.candidateDigest,
      processStatus, qualification, cleanupConfirmed, ...(verified?.evidenceRef ? { evidenceRef: verified.evidenceRef } : {}),
    });
    if (parked) return { accepted: true, parked: true, qualification: "UNKNOWN" };
    throw agentXError("STALE_FENCE", "qualified setup runtime expired before terminal persistence");
  }
  const terminalItems = [
    ...projectSetupTerminalAuthorityChecks(dependencies.tableName, await orgOfRecord(dependencies, current), current, authorized.runtime, authorized.session),
    { Update: { TableName: dependencies.tableName, Key: projectSetupExecutionKey(setupExecutionId),
      UpdateExpression: "SET #state = :state, completedAt = :now, #result = :result",
      ConditionExpression: "#state = :dispatching AND operationId = :operationId AND fence = :fence",
      ExpressionAttributeNames: { "#state": "state", "#result": "result" },
      ExpressionAttributeValues: { ":state": terminalState, ":now": terminalAt, ":result": persistedResult,
        ":dispatching": "DISPATCHING", ":operationId": operationId, ":fence": claims.fence } } },
    { Update: { TableName: dependencies.tableName, Key: projectSetupOperationKey(setupExecutionId, operationId),
      UpdateExpression: "SET #status = :status, updatedAt = :now, #result = :result",
      ConditionExpression: "(#status = :dispatching OR #status = :delivered) AND fence = :fence",
      ExpressionAttributeNames: { "#status": "status", "#result": "result" },
      ExpressionAttributeValues: { ":status": terminalState, ":now": terminalAt, ":result": persistedResult,
        ":dispatching": "DISPATCHING", ":delivered": "DELIVERED", ":fence": claims.fence } } },
  ];
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: terminalItems }));
  } catch (error) {
    const cancellationReasons = error && typeof error === "object"
      ? (error as { CancellationReasons?: Array<{ Code?: unknown }> }).CancellationReasons : undefined;
    const authorityConditionFailed = error instanceof Error && error.name === "TransactionCanceledException"
      && cancellationReasons?.slice(0, 5).some((reason) => reason.Code === "ConditionalCheckFailed");
    if (!authorityConditionFailed) throw error;
    const parked = await parkProjectSetupResultAfterAuthorityChange(dependencies, setupExecutionId, operationId, claims, {
      setupExecutionId: body.setupExecutionId, operationId: body.operationId, candidateDigest: body.candidateDigest,
      processStatus, qualification, cleanupConfirmed, ...(verified?.evidenceRef ? { evidenceRef: verified.evidenceRef } : {}),
    });
    if (!parked) throw error;
    return { accepted: true, parked: true, qualification: "UNKNOWN" };
  }
  return { accepted: true };
}

async function parkProjectSetupResultAfterAuthorityChange(
  dependencies: AwsBrokerDependencies,
  setupExecutionId: string,
  operationId: string,
  claims: NonNullable<ReturnType<typeof verifyProjectSetupCapability>>,
  body: { setupExecutionId: string; operationId: string; candidateDigest: string; processStatus: "SUCCEEDED" | "FAILED" | "UNKNOWN";
    qualification: "PASS" | "FAILED" | "UNKNOWN"; cleanupConfirmed: boolean; evidenceRef?: { key: string; sha256: string } },
): Promise<boolean> {
  const executionKey = projectSetupExecutionKey(setupExecutionId);
  const operationKey = projectSetupOperationKey(setupExecutionId, operationId);
  const [executionItem, operationItem] = await Promise.all([
    getItem<Record<string, unknown>>(dependencies, executionKey), getItem<Record<string, unknown>>(dependencies, operationKey),
  ]);
  const execution = ProjectSetupExecutionSchema.safeParse(projectSetupDomainRecord(executionItem, executionKey, "PROJECT_SETUP_EXECUTION"));
  const operation = ProjectSetupOperationSchema.safeParse(projectSetupDomainRecord(operationItem, operationKey, "PROJECT_SETUP_OPERATION"));
  if (!execution.success || !operation.success || execution.data.state !== "DISPATCHING"
    || !["DISPATCHING", "DELIVERED"].includes(operation.data.status)
    || claims.setupExecutionId !== setupExecutionId || claims.operationId !== operationId || claims.actions.includes("result") === false
    || execution.data.operationId !== operationId || execution.data.subjectId !== claims.subjectId || execution.data.fence !== claims.fence
    || execution.data.transportCorrelationId !== claims.transportCorrelationId || execution.data.approvalRevision !== claims.approvalRevision
    || operation.data.fence !== claims.fence || body.setupExecutionId !== setupExecutionId || body.operationId !== operationId
    || body.candidateDigest !== execution.data.candidateDigest) return false;
  const now = new Date().toISOString();
  const parkedResult = { domain: "project-setup-source-interface/v1", candidateDigest: execution.data.candidateDigest,
    processStatus: "UNKNOWN", qualification: "UNKNOWN", cleanupConfirmed: false,
    reportedProcessStatus: body.processStatus, reportedQualification: body.qualification, reportedCleanupConfirmed: body.cleanupConfirmed,
    ...(body.evidenceRef ? { unqualifiedEvidenceRef: body.evidenceRef } : {}), parkReason: "current-setup-authority-changed" };
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Update: { TableName: dependencies.tableName, Key: executionKey,
        UpdateExpression: "SET #state = :parked, updatedAt = :now, completedAt = :now, #result = :result",
        ConditionExpression: "#state = :dispatching AND operationId = :operationId AND subjectId = :subjectId AND fence = :fence AND approvalRevision = :approvalRevision AND transportCorrelationId = :correlation",
        ExpressionAttributeNames: { "#state": "state", "#result": "result" },
        ExpressionAttributeValues: { ":parked": "PARKED", ":dispatching": "DISPATCHING", ":now": now, ":result": parkedResult,
          ":operationId": operationId, ":subjectId": claims.subjectId, ":fence": claims.fence, ":approvalRevision": claims.approvalRevision,
          ":correlation": claims.transportCorrelationId } } },
      { Update: { TableName: dependencies.tableName, Key: operationKey,
        UpdateExpression: "SET #status = :parked, updatedAt = :now, #result = :result",
        ConditionExpression: "(#status = :dispatching OR #status = :delivered) AND setupExecutionId = :setupExecutionId AND operationId = :operationId AND fence = :fence AND transportCorrelationId = :correlation",
        ExpressionAttributeNames: { "#status": "status", "#result": "result" },
        ExpressionAttributeValues: { ":parked": "PARKED", ":dispatching": "DISPATCHING", ":delivered": "DELIVERED", ":now": now,
          ":result": parkedResult, ":setupExecutionId": setupExecutionId, ":operationId": operationId, ":fence": claims.fence,
          ":correlation": claims.transportCorrelationId } } },
    ] }));
    return true;
  } catch {
    const [latestExecution, latestOperation] = await Promise.all([
      getItem<Record<string, unknown>>(dependencies, executionKey), getItem<Record<string, unknown>>(dependencies, operationKey),
    ]);
    const latestExec = ProjectSetupExecutionSchema.safeParse(projectSetupDomainRecord(latestExecution, executionKey, "PROJECT_SETUP_EXECUTION"));
    const latestOp = ProjectSetupOperationSchema.safeParse(projectSetupDomainRecord(latestOperation, operationKey, "PROJECT_SETUP_OPERATION"));
    return latestExec.success && latestOp.success && latestExec.data.state === "PARKED" && latestOp.data.status === "PARKED"
      && latestExec.data.operationId === operationId && latestExec.data.fence === claims.fence;
  }
}

async function verifyProjectSetupSmokeEvidence(
  dependencies: AwsBrokerDependencies,
  execution: ReturnType<typeof ProjectSetupExecutionSchema.parse>,
  reference: { key: string; sha256: string },
  approvedRunnerEnvironmentInput: unknown,
  approvedRunnerToolchainInput: unknown,
): Promise<{ evidenceRef: { key: string; sha256: string }; processStatus: "SUCCEEDED" | "FAILED" | "UNKNOWN"; qualification: "PASS" | "FAILED" | "UNKNOWN"; cleanupConfirmed: boolean } | undefined> {
  const approvedRunnerEnvironment = ProjectSetupRunnerEnvironmentSchema.safeParse(approvedRunnerEnvironmentInput);
  const approvedRunnerToolchain = ProjectSetupRunnerToolchainSchema.safeParse(approvedRunnerToolchainInput);
  if (!approvedRunnerEnvironment.success || !approvedRunnerToolchain.success) return undefined;
  if (reference.key !== `project-setup-evidence/sha256/${reference.sha256}.json`) return undefined;
  const evidenceText = await readStoredText(dependencies.s3, dependencies.artifactBucketName, reference.key, execution.evidenceByteLimit);
  if (evidenceText === undefined || createHash("sha256").update(evidenceText, "utf8").digest("hex") !== reference.sha256) return undefined;
  let evidence: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(evidenceText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    evidence = parsed as Record<string, unknown>;
  } catch { return undefined; }
  if (evidence.schemaVersion !== "project-setup-smoke-evidence/v1" || evidence.setupExecutionId !== execution.setupExecutionId
    || evidence.subjectId !== execution.subjectId || evidence.transportCorrelationId !== execution.transportCorrelationId
    || evidence.executionRefSha256 !== execution.executionRef.sha256 || evidence.candidateDigest !== execution.candidateDigest
    || canonicalJson(evidence.runnerToolchain) !== canonicalJson(approvedRunnerToolchain.data)) return undefined;
  const admissionText = await readStoredText(dependencies.s3, dependencies.artifactBucketName, execution.executionRef.key, MAX_SETUP_PROPOSAL_BYTES);
  if (admissionText === undefined || createHash("sha256").update(admissionText, "utf8").digest("hex") !== execution.executionRef.sha256) return undefined;
  let admission: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(admissionText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    admission = parsed as Record<string, unknown>;
  } catch { return undefined; }
  const admittedRuntime = admission.runtime && typeof admission.runtime === "object" && !Array.isArray(admission.runtime)
    ? admission.runtime as Record<string, unknown> : undefined;
  if (admittedRuntime?.runtimeCatalogId !== execution.runtimeCatalogId
    || admittedRuntime.catalogRevision !== execution.runtimeCatalogRevision
    || admittedRuntime.bindingDigest !== execution.bindingDigest
    || admittedRuntime.generation !== execution.runtimeGeneration
    || admittedRuntime.transportCorrelationId !== execution.transportCorrelationId) return undefined;
  if (typeof admission.planDigest !== "string" || evidence.planDigest !== admission.planDigest) return undefined;
  if (admission.domain !== "project-setup-source-interface/v1" || admission.setupExecutionId !== execution.setupExecutionId
    || admission.subjectId !== execution.subjectId || admission.transportCorrelationId !== execution.transportCorrelationId
    || admission.candidateDigest !== execution.candidateDigest
    || !admission.sourceSnapshot || typeof admission.sourceSnapshot !== "object" || !admission.selectionInput || typeof admission.selectionInput !== "object"
    || !admission.setupRunContext || typeof admission.setupRunContext !== "object" || !Array.isArray(admission.scenarios)) return undefined;
  try {
    const sourceRecord = admission.sourceSnapshot as Record<string, unknown>;
    if (!Array.isArray(sourceRecord.sources)) return undefined;
    const snapshot = { ...sourceRecord, sources: sourceRecord.sources.map((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid source row");
      const source = raw as Record<string, unknown>;
      if (typeof source.path !== "string" || typeof source.sha256 !== "string" || source.kind !== "blob" || typeof source.bytesBase64 !== "string") throw new Error("invalid source row");
      return { path: source.path, sha256: source.sha256, kind: "blob" as const, bytes: Buffer.from(source.bytesBase64, "base64") };
    }) } as unknown as E2ESourceSnapshot;
    verifyE2ESourceSnapshot(snapshot, snapshot.candidate);
    // An admission stored before a web app's contract could name its API target recorded discovery without it; it is read against that derivation as well as the current one.
    const sourceInspections = [inspectE2ERepository(snapshot, snapshot.candidate).inspection, inspectE2ERepositoryBeforeContractApiTargets(snapshot, snapshot.candidate).inspection];
    const sourceInspection = sourceInspections.find((candidate) => canonicalJson(admission.discoveredApplications) === canonicalJson(candidate.applications)
      && canonicalJson(admission.discoveryMissingInputs) === canonicalJson(candidate.missingInputs)
      && canonicalJson(admission.discoveredTargetIds) === canonicalJson(candidate.proposedTargets.map((target) => target.targetId).sort()));
    if (sourceInspection === undefined) return undefined;
    const discoveredTargetIds = sourceInspection.proposedTargets.map((target) => target.targetId).sort();
    if (canonicalJson(evidence.discoveredApplications) !== canonicalJson(sourceInspection.applications)
      || canonicalJson(evidence.discoveryMissingInputs) !== canonicalJson(sourceInspection.missingInputs)
      || canonicalJson(evidence.discoveredTargetIds) !== canonicalJson(discoveredTargetIds)) return undefined;
    E2EPolicySchema.parse(admission.policy);
    const selectionInput = { ...(admission.selectionInput as Record<string, unknown>), sourceSnapshot: snapshot };
    const plan = selectE2EExecutionPlan(selectionInput as never);
    if (plan.groups.length === 0) return undefined;
    const bundleBody = { schemaVersion: 1 as const, planDigest: admission.planDigest, templateVersion: "trusted-e2e/v1", scenarios: admission.scenarios, bundleDigest: "0".repeat(64) };
    const bundle = E2EScenarioBundleSchema.parse({ ...bundleBody, bundleDigest: e2eScenarioBundleDigest(bundleBody) });
    const runContext = admission.setupRunContext as Record<string, unknown>;
    const round = E2ERoundSchema.parse((evidence.round) ?? null);
    const groupAdmissions = runContext.groupAdmissions;
    if (!Array.isArray(groupAdmissions) || groupAdmissions.length !== plan.groups.length || plan.groups.length === 0
      || canonicalJson(runContext.plan) !== canonicalJson(plan) || canonicalJson(runContext.bundle) !== canonicalJson(bundle)
      || canonicalJson(runContext.round) !== canonicalJson(round) || canonicalJson(runContext.runnerEnvironment) !== canonicalJson(approvedRunnerEnvironment.data)
      || canonicalJson(runContext.runnerToolchain) !== canonicalJson(approvedRunnerToolchain.data)
      || runContext.runnerToolchainDigest !== createHash("sha256").update(canonicalJson(approvedRunnerToolchain.data)).digest("hex")
      || !Array.isArray(evidence.groupRuns) || evidence.groupRuns.length !== plan.groups.length) return undefined;
    const authenticatedGroupAdmissions = groupAdmissions as unknown as unknown[];
    const submittedGroupRuns = evidence.groupRuns as unknown as unknown[];
    const unsupportedTargetIds = admission.unsupportedTargetIds;
    const selectedTargetIds = Array.isArray(admission.selectedTargetIds) ? admission.selectedTargetIds : [];
    const expectedNotExecutedTargetIds = discoveredTargetIds.filter((targetId) => !selectedTargetIds.includes(targetId));
    if (!Array.isArray(unsupportedTargetIds) || canonicalJson(evidence.unsupportedTargetIds) !== canonicalJson(unsupportedTargetIds)) return undefined;
    if (canonicalJson(unsupportedTargetIds) !== canonicalJson(expectedNotExecutedTargetIds)
      || canonicalJson(admission.notExecutedTargetIds) !== canonicalJson(expectedNotExecutedTargetIds)
      || canonicalJson(evidence.notExecutedTargetIds) !== canonicalJson(expectedNotExecutedTargetIds)) return undefined;
    const semanticApprovalDigests = new Map(bundle.scenarios.map((scenario) => [scenario.scenarioId, (admission.semanticApproval as { digest: string }).digest]));
    const qualifications: Array<"PASS" | "FAILED" | "UNKNOWN"> = [];
    const cleanupStates: boolean[] = [];
    const processStates: boolean[] = [];
    for (const [index, group] of plan.groups.entries()) {
      const admissionGroup = authenticatedGroupAdmissions[index];
      const rawGroupRun = submittedGroupRuns[index];
      if (!admissionGroup || !rawGroupRun || typeof admissionGroup !== "object" || typeof rawGroupRun !== "object" || Array.isArray(rawGroupRun)) return undefined;
      const admitted = admissionGroup as Record<string, unknown>;
      const groupRun = rawGroupRun as Record<string, unknown>;
      const compiled = compileE2EScenarios(bundle, plan.effectiveTargets, group, { selectionInput, executionPlan: plan, group } as never);
      if (canonicalJson(admitted.group) !== canonicalJson(group) || admitted.expectedConfigDigest !== compiled.expectedConfigDigest
        || admitted.compiledInventoryDigest !== compiled.inventory.digest || admitted.selectionPacketPath !== compiled.selectionPacketPath
        || canonicalJson(admitted.expectedCases) !== canonicalJson(compiled.expectedCases)) return undefined;
      const binding = E2ERunBindingSchema.parse(admitted.binding);
      if (binding.operationId !== execution.operationId || binding.operationFence !== execution.fence || binding.workflowRevision !== execution.projectRevision
        || binding.candidateDigest !== execution.candidateDigest || binding.planDigest !== admission.planDigest || binding.groupId !== group.groupId
        || canonicalJson(round.groupBindings[index]) !== canonicalJson(binding) || canonicalJson(groupRun.group) !== canonicalJson(group)
        || canonicalJson(groupRun.binding) !== canonicalJson(binding)) return undefined;
      const selection = JSON.parse(compiled.files.get(compiled.selectionPacketPath) ?? "null") as unknown;
      if (canonicalJson(groupRun.selection) !== canonicalJson(selection) || !Array.isArray(groupRun.hostRequestIds)) return undefined;
      const hostRequestIds = new Map<string, string>();
      for (const row of groupRun.hostRequestIds) {
        if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== "string" || typeof row[1] !== "string" || hostRequestIds.has(row[0])) return undefined;
        hostRequestIds.set(row[0], row[1]);
      }
      if (hostRequestIds.size !== compiled.hostRequestPayloads.size || [...compiled.hostRequestPayloads.keys()].some((caseId) => !hostRequestIds.has(caseId))) return undefined;
      const actualValue = groupRun.actual;
      if (!actualValue || typeof actualValue !== "object" || Array.isArray(actualValue)) return undefined;
      const actualRecord = actualValue as Record<string, unknown>;
      if (canonicalJson(actualRecord.runnerToolchain) !== canonicalJson(approvedRunnerToolchain.data)) return undefined;
      if (typeof actualRecord.launchId !== "string" || typeof actualRecord.rawReportBase64 !== "string" || typeof actualRecord.runStartCaptureBase64 !== "string"
        || !Array.isArray(actualRecord.candidateCaptures) || !Array.isArray(actualRecord.assertionReceipts)
        || typeof actualRecord.cleanupConfirmed !== "boolean" || typeof actualRecord.cleanupServerListening !== "boolean") return undefined;
      const rawReportBytes = Buffer.from(actualRecord.rawReportBase64, "base64");
      const runStartCaptureBytes = Buffer.from(actualRecord.runStartCaptureBase64, "base64");
      const runStartCapture = parseE2EFirstPartyCapture(runStartCaptureBytes, actualRecord.launchId);
      const actual = { launchId: actualRecord.launchId, launchConfigDigest: actualRecord.launchConfigDigest, fixedAssetDigests: actualRecord.fixedAssetDigests,
        publicList: actualRecord.publicList, selected: actualRecord.selected, filtered: actualRecord.filtered,
        rawReportBytes: new Uint8Array(rawReportBytes), runStartCaptureBytes: new Uint8Array(runStartCaptureBytes), runStartCapture,
        assertionReceipts: actualRecord.assertionReceipts, declaredMockComponentIds: actualRecord.declaredMockComponentIds,
        candidateCaptures: actualRecord.candidateCaptures, listProcess: actualRecord.listProcess, runProcess: actualRecord.runProcess,
        cleanupConfirmed: actualRecord.cleanupConfirmed, cleanupServerListening: actualRecord.cleanupServerListening, evidenceDirectory: "" } as never;
      const actualQualification = collectE2EActualCliRun({ actual, compiled, binding, round, selection: selection as never,
        sourceDigest: e2eSnapshotSourceDigest(compiled, snapshot.sources.map(({ path, sha256 }) => ({ path, sha256 }))), semanticApprovalDigests, hostRequestIds,
        declaredMockComponentIds: Array.isArray(actualRecord.declaredMockComponentIds) ? actualRecord.declaredMockComponentIds as string[] : [],
        environment: approvedRunnerEnvironment.data,
        usage: { discoveredResults: Number(actualRecord.selected) + Number(actualRecord.filtered), maxAgentContextBytes: 0, maxLedgerBytes: 0, maxObservationBytes: 0, artifactBytes: 0, downloads: 0, events: 0, modelTokens: 0, maxModelCallsInStep: 0, maxActionStepsInStep: 0 },
        limits: { maxAgentContextBytes: 16_384, maxLedgerBytes: 8_192, maxObservationBytes: 262_144, maxEventsPerStep: 1_000, maxModelTokensPerCall: 64_000 } });
      qualifications.push(actualQualification.qualification?.status ?? "UNKNOWN");
      cleanupStates.push(actualRecord.cleanupConfirmed === true && actualRecord.cleanupServerListening === false);
      const runProcess = actualRecord.runProcess as Record<string, unknown> | undefined;
      processStates.push(runProcess?.status === 0 && runProcess.signal === null && runProcess.aborted === false && runProcess.timedOut === false);
    }
    const cleanupConfirmed = cleanupStates.length === plan.groups.length && cleanupStates.every(Boolean);
    const processStatus = processStates.every(Boolean) ? "SUCCEEDED" : "FAILED";
    const qualification = qualifications.includes("FAILED") ? "FAILED" : qualifications.length === plan.groups.length && qualifications.every((item) => item === "PASS") ? "PASS" : "UNKNOWN";
    return { evidenceRef: reference, processStatus, qualification: cleanupConfirmed ? qualification : "UNKNOWN", cleanupConfirmed };
  } catch {
    return undefined;
  }
}
