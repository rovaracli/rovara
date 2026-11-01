// Part of the broker (split out of ../broker.ts): worker callbacks, workflow candidate export, build source and baseline source.

import { authorizeTurnModelFallback } from "../../model-selection/turn-fallback.js";
import { resolveAndAuthorizeTaskFallback } from "../../model-selection/fallback-request.js";
import { createHash, randomUUID } from "node:crypto";
import { cancelCallbackForbidden, verifyCancelCallbackCapability } from "../cancel-callback-capability.js";
import { PutCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { CandidateManifestSchema, verifyE2ESourceSnapshot, canonicalJson, createCandidateManifest, agentXError, E2E_APPLICATION_BUILD_SOURCE_MANIFEST_MAX_BYTES } from "@agentx/contracts";
import { BaselineSourceBodySchema, BaselineSourceWireSchema, StoredBaselineSourceSchema, assessBaselineSource, type StoredBaselineSource } from "../baseline-source.js";
import { readWorkflowE2EBaselineRecord } from "../workflow-e2e-baseline.js";
import { readWorkflowE2EReplayRecord } from "../workflow-e2e-replay.js";
import { z } from "zod";
import { DeveloperSignInStore } from "../../developer/store.js";
import { readObjectText as readStoredText } from "../../developer/plan-artifacts.js";
import { TERMINAL, getItem, operationKey, publicOperation, requireOperation, type CallbackClaims, type OperationRecord } from "../cancellation.js";
import { requireWorkspaceCreatorStillMember } from "../../developer/creator-member.js";
import { taskKey, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { isConditional } from "../broker-shared.js";
import { readWorkflowE2EGroundingRecord } from "../workflow-e2e-grounding.js";
import { handleE2EModelBudgetCallback } from "../../e2e/model-budget-endpoint.js";
import { json } from "../json-reply.js";
import { CandidateBuildSourceBodySchema, StoredCandidateBuildSourceSchema, assessCandidateBuildSource, type StoredCandidateBuildSource } from "../candidate-build-source.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import { parseBody, verifyCapability } from "./admin-and-helpers.js";
import { MAX_WORKFLOW_CANDIDATE_EXPORT_BYTES, WORKFLOW_CANDIDATE_CHUNK_BYTES, type AwsBrokerDependencies } from "./definitions.js";
import { AI_NAVIGATION_NOT_ON_CLOUD } from "./e2e-rounds.js";
import { GROUNDING_SOURCE_NOT_EXPORTED_REASON, GROUNDING_SOURCE_REFUSED_REASON, handleWorkflowE2EEvidenceUpload, readSetupChunk, readStoredBytes, workflowCandidateSourceExportSchema } from "./evidence-and-setup.js";
import { authorizeWorkflowFeedbackApproval, handleCodeBuild, logCallbackRefusal, readFeedbackBundlesForCritic, reconcilePullRequestUpdate } from "./feedback-and-codebuild.js";
import { appendEvents, putArtifact, reconcilePullRequest } from "./pull-request-reconcile.js";
import { creatorCheckOf, orgOfRecord, routingOf } from "./scope-helpers.js";
import { chatGptTaskToken, recordChatGptFallback } from "./task-operations.js";
import { afterWorkerEvents } from "./lessons-report.js";
import { recordTerminalResult } from "./terminal-result.js";
import { readStoredCandidateSourceExport } from "./workflow-items.js";

export async function handleCallback(
  dependencies: AwsBrokerDependencies,
  request: AdaptedHttpRequest,
  workspaceId: string,
  operationId: string,
  action: string,
) {
  const token = request.headers["x-agentx-callback-capability"];
  if (!token) throw agentXError("CALLBACK_FORBIDDEN", "callback capability is required");
  // #201 Release A: accept the child format before any reconciler starts issuing it. The key
  // family is selected by the envelope, never by unverified claims or signature fallback.
  const cancelClaims = token.startsWith("cancel-v1.")
    ? verifyCancelCallbackCapability(dependencies.callbackSigningKey, token, action)
    : undefined;
  const claims = cancelClaims ?? verifyCapability(dependencies, token, action as CallbackClaims["actions"][number]);
  if (claims.workspaceId !== workspaceId || claims.operationId !== operationId) {
    throw agentXError("CALLBACK_FORBIDDEN", "callback route is outside the capability scope");
  }
  const operation = await requireOperation(dependencies, workspaceId, operationId);
  if (cancelClaims !== undefined) {
    if (operation.kind !== "cancel" || operation.id !== operationId || operation.workspaceId !== workspaceId
      || operation.fence !== cancelClaims.fence || operation.targetOperationId !== cancelClaims.targetOperationId) {
      throw cancelCallbackForbidden();
    }
    const target = await getItem<OperationRecord>(dependencies, operationKey(workspaceId, cancelClaims.targetOperationId));
    if (target === undefined || target.id !== cancelClaims.targetOperationId
      || target.workspaceId !== workspaceId || target.fence !== cancelClaims.fence) {
      throw cancelCallbackForbidden();
    }
  }
  if (operation.fence !== claims.fence) throw agentXError("STALE_FENCE", "callback fence is stale");
  if (action !== "result" && TERMINAL.has(operation.status)) {
    throw agentXError("STALE_FENCE", "terminal operations cannot publish more output");
  }
  if(action==="model-fallback") {
    if(cancelClaims!==undefined||operation.orgId===undefined||(operation.modelTaskId===undefined&&operation.modelTurnPin===undefined))throw agentXError("CALLBACK_FORBIDDEN","This operation cannot authorize a model fallback.");
    const signInTableName=dependencies.developer?.signInTableName;
    const signInStore=signInTableName===undefined?undefined:new DeveloperSignInStore({documentClient:dependencies.documentClient,tableName:signInTableName,nameTableName:dependencies.tableName,now:Date.now});
    if(operation.modelTurnPin!==undefined)return json(await authorizeTurnModelFallback({...dependencies,allowImplicitSlack:dependencies.orgResolver===undefined,routing:routingOf(dependencies,true)??{},now:Date.now,...(signInStore===undefined?{}:{signInStore}),...(signInTableName===undefined?{}:{modelSignInTableName:signInTableName})},{orgId:operation.orgId,workspaceId,operationId,fence:claims.fence,verifiedClaims:claims,request:parseBody(request.body)}),request.requestId);
    if(signInStore===undefined||signInTableName===undefined)throw agentXError("RUNTIME_UNAVAILABLE","The task's model authority is unavailable.");
    if(operation.modelTaskId===undefined)throw agentXError("CALLBACK_FORBIDDEN","This operation has no task model authority.");
    return json(await resolveAndAuthorizeTaskFallback({...dependencies,routing:routingOf(dependencies)??{},now:Date.now,signInStore,modelSignInTableName:signInTableName},{orgId:operation.orgId,taskId:operation.modelTaskId,workspaceId,operationId,fence:claims.fence,verifiedClaims:claims,request:parseBody(request.body)}),request.requestId);
  }
  if (action === "chatgpt-token") return json(await chatGptTaskToken(dependencies, operation), request.requestId);
  if (action === "chatgpt-status") return json(await recordChatGptFallback(dependencies, operation, parseBody(request.body)), request.requestId);
  const body = parseBody(request.body);
  if (action === "events") {
    const accepted = await appendEvents(dependencies, operation, body);
    // Learning v2: the worker's load report and loaded-knowledge record, where lessons are on (lessons-report.ts; never fails the events).
    await afterWorkerEvents(dependencies, operation, body);
    return json({ accepted }, request.requestId);
  }
  if (action === "artifacts") {
    const artifactId = await putArtifact(dependencies, operation, body);
    return json({ artifactId }, request.requestId);
  }
  if (action === "candidate-export") {
    if (operation.kind !== "task" || operation.workflowMode !== "IMPLEMENT" || operation.status !== "RUNNING") {
      throw agentXError("CALLBACK_FORBIDDEN", "candidate source export is limited to the current implementation operation");
    }
    return json(await handleWorkflowCandidateExport(dependencies, operation, body), request.requestId);
  }
  if (action === "candidate-build-source") {
    if (operation.kind !== "task" || operation.workflowMode !== "IMPLEMENT" || operation.status !== "RUNNING") {
      throw agentXError("CALLBACK_FORBIDDEN", "candidate build source export is limited to the current implementation operation");
    }
    return json(await handleWorkflowCandidateBuildSource(dependencies, operation, body), request.requestId);
  }
  if (action === "baseline-source") {
    // T7b: the current implementation run's, or a planning run that was asked for the unchanged code to ground its plan (and only that: the upload is keyed to the operation that sends it).
    const planAsked = operation.workflowMode === "PLAN" && operation.groundingSourceAsked === true;
    if (operation.kind !== "task" || (operation.workflowMode !== "IMPLEMENT" && !planAsked) || operation.status !== "RUNNING") {
      throw agentXError("CALLBACK_FORBIDDEN", "baseline source export is limited to the current implementation operation or a planning operation asked for it");
    }
    return json(await handleWorkflowBaselineSource(dependencies, operation, body), request.requestId);
  }
  if (action === "e2e-admission") {
    if (operation.kind !== "task" || operation.workflowMode !== "CHECKS" || operation.status !== "RUNNING" || operation.workflowE2EAdmission === undefined) {
      throw agentXError("CALLBACK_FORBIDDEN", "E2E admission reads require the active server-assigned CHECKS operation");
    }
    const body = z.object({ stage: z.literal("read"), offset: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(parseBody(request.body));
    const reference = operation.workflowE2EAdmission;
    if (body.sha256 !== reference.admissionRef.sha256 || body.offset % WORKFLOW_CANDIDATE_CHUNK_BYTES !== 0
      || body.offset >= reference.admissionRef.byteLength) throw agentXError("CALLBACK_FORBIDDEN", "E2E admission read is outside its immutable reference");
    const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(reference.taskId));
    if (reference.purpose === "replay") {
      // M1.4 Task 4.6b: an audit replay is not the workflow's round either (the workflow has moved past its checks, and its candidate round is the replay's source): it is read on what the
      // replay's own record says, this operation is the round that record started, for this source round and attempt.
      const record = task === undefined || reference.sourceRoundId === undefined || reference.attempt === undefined ? undefined
        : await readWorkflowE2EReplayRecord(dependencies, task.taskId, { sourceRoundId: reference.sourceRoundId, attempt: reference.attempt });
      if (task === undefined || task.workspaceId !== operation.workspaceId || task.closedAt !== undefined || record === undefined || record.state !== "STARTED" || record.operationId !== operation.id
        || record.roundId !== reference.roundId || record.admissionSha256 !== reference.admissionRef.sha256) {
        throw agentXError("STALE_FENCE", "the replay round is no longer the one that was started");
      }
    } else if (reference.purpose === "grounding") {
      // T7b: a grounding round is not the workflow's round either (the task is holding its plan card back, in PLAN): it is read on what the grounding record says, this operation is the
      // round that record started, for this plan artifact, base commit and attempt, and the task is still open and still holding that plan.
      const record = task === undefined || reference.planArtifactSha256 === undefined || reference.attempt === undefined ? undefined
        : await readWorkflowE2EGroundingRecord(dependencies, { taskId: task.taskId, planArtifactSha256: reference.planArtifactSha256, attempt: reference.attempt });
      const held = (task as { planGrounding?: { artifactSha256?: unknown } } | undefined)?.planGrounding;
      if (task === undefined || task.workspaceId !== operation.workspaceId || task.closedAt !== undefined || record === undefined || record.state !== "STARTED" || record.operationId !== operation.id
        || record.roundId !== reference.roundId || record.admissionSha256 !== reference.admissionRef.sha256 || record.baseCommitSha !== reference.baseCommitSha
        || record.attempt !== reference.attempt || record.planArtifactSha256 !== reference.planArtifactSha256 || held?.artifactSha256 !== reference.planArtifactSha256) {
        throw agentXError("STALE_FENCE", "the grounding round is no longer the one that was started");
      }
    } else if (reference.purpose === "baseline") {
      // M1.3 Task 3.7b: a baseline round is not the workflow's current round (the workflow is not running it, and its candidate is another), so it is read on what the baseline's
      // own record says instead: this operation is the round that record started, for this plan, base commit and attempt.
      const record = task === undefined ? undefined : await readWorkflowE2EBaselineRecord(dependencies, task);
      if (task === undefined || task.workspaceId !== operation.workspaceId || task.closedAt !== undefined || record === undefined || record.state !== "STARTED" || record.operationId !== operation.id
        || record.roundId !== reference.roundId || record.admissionSha256 !== reference.admissionRef.sha256 || record.baseCommitSha !== reference.baseCommitSha || record.attempt !== reference.attempt) {
        throw agentXError("STALE_FENCE", "the baseline round is no longer the one that was started");
      }
    } else if (task?.workspaceId !== operation.workspaceId || task.workflow?.stage !== "VERIFY" || task.workflow.state !== "RUNNING"
      || task.workflow.revision !== reference.workflowRevision || task.workflow.candidate?.digest !== reference.candidateDigest
      || task.workflow.e2e?.currentRoundId !== reference.roundId
      || canonicalJson(task.workflow.e2e.currentGroupRunIds) !== canonicalJson(reference.groupRunIds)) {
      throw agentXError("STALE_FENCE", "E2E CHECKS admission is no longer current");
    }
    const text = await readStoredText(dependencies.s3, dependencies.artifactBucketName, reference.admissionRef.key, reference.admissionRef.byteLength);
    if (text === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "E2E admission object is unavailable");
    const bytes = Buffer.from(text, "utf8");
    if (bytes.byteLength !== reference.admissionRef.byteLength || createHash("sha256").update(bytes).digest("hex") !== reference.admissionRef.sha256) throw agentXError("CONFIG_INVALID", "E2E admission object failed its content address");
    const chunk = bytes.subarray(body.offset, Math.min(body.offset + WORKFLOW_CANDIDATE_CHUNK_BYTES, bytes.byteLength));
    return json({ offset: body.offset, totalBytes: bytes.byteLength, sha256: reference.admissionRef.sha256, chunkBase64: chunk.toString("base64") }, request.requestId);
  }
  if (action === "e2e-evidence") {
    if (operation.kind !== "task" || operation.workflowMode !== "CHECKS" || operation.status !== "RUNNING" || operation.workflowE2EAdmission === undefined) {
      throw agentXError("CALLBACK_FORBIDDEN", "E2E evidence upload requires the active server-assigned CHECKS operation");
    }
    return json(await handleWorkflowE2EEvidenceUpload(dependencies, operation, parseBody(request.body)), request.requestId);
  }
  if (action === "e2e-model-budget") {
    // Defence in depth with the dispatch refusal: nothing on a cloud install may spend the installation's model credentials through this meter.
    if (dependencies.cloud === true) throw agentXError("CALLBACK_FORBIDDEN", AI_NAVIGATION_NOT_ON_CLOUD);
    return json(await handleE2EModelBudgetCallback({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now,
      orgOf: (record) => orgOfRecord(dependencies, record),
      log: (entry) => console.log(JSON.stringify({ component: "broker", ...entry })),
      ...(dependencies.e2eAgentInstallation === undefined ? {} : { e2eAgentInstallation: dependencies.e2eAgentInstallation }) }, operation, body), request.requestId);
  }
  if (action === "feedback-bundles") {
    const { acceptedRequirementsDigests: _accepted, ...inputs } = await readFeedbackBundlesForCritic(dependencies, operation, body);
    void _accepted;
    return json(inputs, request.requestId);
  }
  if (action === "feedback-approval") {
    await authorizeWorkflowFeedbackApproval(dependencies, operation, body);
    return json({ authorized: true }, request.requestId);
  }
  if (action === "pull-request") {
    // Ruling R60: a publish step that began before the removal still opens no pull request, and mints no installation token.
    await requireWorkspaceCreatorStillMember(creatorCheckOf(dependencies), operation.workspaceId);
    const pullRequest = await logCallbackRefusal(action, operation, () => reconcilePullRequest(dependencies, operation, body));
    return json(pullRequest, request.requestId);
  }
  if (action === "pull-request-update") {
    // Ruling R60, as for the pull request callback above.
    await requireWorkspaceCreatorStillMember(creatorCheckOf(dependencies), operation.workspaceId);
    const pullRequest = await logCallbackRefusal(action, operation, () => reconcilePullRequestUpdate(dependencies, operation, body));
    return json(pullRequest, request.requestId);
  }
  if (action === "codebuild") {
    const build = await handleCodeBuild(dependencies, operation, body);
    return json(build, request.requestId);
  }
  const result = await recordTerminalResult(dependencies, operation, body);
  return json({ operation: publicOperation(result) }, request.requestId);
}

async function handleWorkflowCandidateExport(dependencies: AwsBrokerDependencies, operation: OperationRecord, rawBody: unknown): Promise<unknown> {
  const body = z.discriminatedUnion("stage", [
    z.object({ stage: z.literal("init"), schemaVersion: z.literal("workflow-candidate-export-upload/v1"), totalBytes: z.number().int().positive().max(MAX_WORKFLOW_CANDIDATE_EXPORT_BYTES),
      chunkCount: z.number().int().positive().max(Math.ceil(MAX_WORKFLOW_CANDIDATE_EXPORT_BYTES / WORKFLOW_CANDIDATE_CHUNK_BYTES)), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    z.object({ stage: z.literal("chunk"), schemaVersion: z.literal("workflow-candidate-export-chunk/v1"), uploadId: z.string().uuid(), index: z.number().int().nonnegative(),
      bytesBase64: z.string().min(1).max(Math.ceil(WORKFLOW_CANDIDATE_CHUNK_BYTES * 4 / 3) + 8), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    z.object({ stage: z.literal("finalize"), schemaVersion: z.literal("workflow-candidate-export-finalize/v1"), uploadId: z.string().uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  ]).parse(rawBody);
  const key = { pk: `WORKSPACE#${operation.workspaceId}`, sk: `CANDIDATE_EXPORT#${operation.id}` };
  if (body.stage === "init") {
    if (body.chunkCount !== Math.ceil(body.totalBytes / WORKFLOW_CANDIDATE_CHUNK_BYTES)) throw agentXError("CONFIG_INVALID", "candidate source chunk count does not match its total");
    const existing = await getItem<Record<string, unknown>>(dependencies, key);
    if (existing) {
      if (existing.entityType !== "WORKFLOW_CANDIDATE_EXPORT" || existing.status !== "OPEN" || existing.operationId !== operation.id
        || existing.fence !== operation.fence || existing.totalBytes !== body.totalBytes || existing.chunkCount !== body.chunkCount || existing.sha256 !== body.sha256
        || typeof existing.uploadId !== "string") throw agentXError("CALLBACK_FORBIDDEN", "implementation already owns a different candidate source export");
      return { uploadId: existing.uploadId, chunkBytes: WORKFLOW_CANDIDATE_CHUNK_BYTES, totalBytes: body.totalBytes, chunkCount: body.chunkCount };
    }
    const uploadId = randomUUID();
    await dependencies.documentClient.send(new PutCommand({ TableName: dependencies.tableName, Item: { ...key, entityType: "WORKFLOW_CANDIDATE_EXPORT", schemaVersion: 1,
      workspaceId: operation.workspaceId, operationId: operation.id, fence: operation.fence, uploadId, totalBytes: body.totalBytes, chunkCount: body.chunkCount,
      sha256: body.sha256, nextChunkIndex: 0, status: "OPEN", createdAt: new Date().toISOString() }, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" }));
    return { uploadId, chunkBytes: WORKFLOW_CANDIDATE_CHUNK_BYTES, totalBytes: body.totalBytes, chunkCount: body.chunkCount };
  }
  const upload = await getItem<Record<string, unknown>>(dependencies, key);
  if (!upload || upload.entityType !== "WORKFLOW_CANDIDATE_EXPORT" || upload.operationId !== operation.id || upload.fence !== operation.fence) {
    throw agentXError("STALE_FENCE", "candidate source export is not current");
  }
  if (body.stage === "finalize" && upload.status === "COMPLETE" && upload.uploadId === body.uploadId && upload.sha256 === body.sha256
    && operation.candidateSourceRef && typeof operation.candidateSourceRef.key === "string") return { sourceRef: operation.candidateSourceRef, duplicate: true };
  if (upload.status !== "OPEN") throw agentXError("STALE_FENCE", "candidate source export is no longer open");
  if (body.stage === "chunk") {
    if (upload.uploadId !== body.uploadId || !Number.isSafeInteger(body.index) || body.index >= Number(upload.chunkCount)) throw agentXError("CALLBACK_FORBIDDEN", "candidate source chunk is outside its owned upload");
    const bytes = Buffer.from(body.bytesBase64, "base64");
    const expected = body.index === Number(upload.chunkCount) - 1 ? Number(upload.totalBytes) - body.index * WORKFLOW_CANDIDATE_CHUNK_BYTES : WORKFLOW_CANDIDATE_CHUNK_BYTES;
    if (bytes.byteLength !== expected || bytes.toString("base64") !== body.bytesBase64 || createHash("sha256").update(bytes).digest("hex") !== body.sha256) throw agentXError("CONFIG_INVALID", "candidate source chunk bytes or digest are invalid");
    const nextIndex = Number(upload.nextChunkIndex);
    if (body.index > nextIndex) throw agentXError("CONFIG_INVALID", "candidate source chunks must arrive in order");
    const chunkKey = `workflow-candidate-staging/${operation.workspaceId}/${operation.id}/${body.uploadId}/${body.index}.chunk`;
    if (body.index < nextIndex) {
      const prior = await readSetupChunk(dependencies, chunkKey);
      if (!prior?.equals(bytes)) throw agentXError("CALLBACK_FORBIDDEN", "replayed candidate source chunk differs from its owned bytes");
      return { accepted: true, index: body.index, duplicate: true };
    }
    await dependencies.s3.send(new PutObjectCommand({ Bucket: dependencies.artifactBucketName, Key: chunkKey, Body: bytes,
      ContentType: "application/octet-stream", Metadata: { sha256: body.sha256, upload: body.uploadId, index: String(body.index) }, IfNoneMatch: "*" }));
    await dependencies.documentClient.send(new UpdateCommand({ TableName: dependencies.tableName, Key: key, UpdateExpression: "SET nextChunkIndex = :next",
      ConditionExpression: "#status = :open AND nextChunkIndex = :index AND operationId = :operationId AND fence = :fence",
      ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":next": body.index + 1, ":open": "OPEN", ":index": body.index,
        ":operationId": operation.id, ":fence": operation.fence } }));
    return { accepted: true, index: body.index, duplicate: false };
  }
  if (upload.uploadId !== body.uploadId || upload.sha256 !== body.sha256 || Number(upload.nextChunkIndex) !== Number(upload.chunkCount)) {
    throw agentXError("STALE_FENCE", "candidate source export is incomplete or changed");
  }
  const chunks: Buffer[] = [];
  const chunkKeys: string[] = [];
  for (let index = 0; index < Number(upload.chunkCount); index += 1) {
    const chunkKey = `workflow-candidate-staging/${operation.workspaceId}/${operation.id}/${body.uploadId}/${index}.chunk`;
    const chunk = await readSetupChunk(dependencies, chunkKey);
    if (!chunk) throw agentXError("RUNTIME_UNAVAILABLE", "an owned candidate source chunk is missing");
    chunks.push(chunk);
    chunkKeys.push(chunkKey);
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.byteLength !== Number(upload.totalBytes) || createHash("sha256").update(bytes).digest("hex") !== body.sha256) throw agentXError("CONFIG_INVALID", "candidate source export bytes do not match their stored digest");
  let parsed: z.infer<ReturnType<typeof workflowCandidateSourceExportSchema>>;
  try { parsed = workflowCandidateSourceExportSchema().parse(JSON.parse(bytes.toString("utf8")) as unknown); }
  catch { throw agentXError("CONFIG_INVALID", "candidate source export is malformed or outside its immutable bounds"); }
  const manifest = CandidateManifestSchema.safeParse(parsed.candidate);
  if (!manifest.success || createCandidateManifest(manifest.data.repositories).digest !== manifest.data.digest || manifest.data.repositories.length !== parsed.repositories.length) {
    throw agentXError("CONFIG_INVALID", "candidate source export manifest is invalid");
  }
  let sourceBytes = 0;
  for (const [index, repository] of parsed.repositories.entries()) {
    const identity = manifest.data.repositories[index];
    if (!identity || identity.repositoryId !== repository.repositoryId || identity.commitSha !== repository.commitSha || identity.treeSha !== repository.treeSha
      || identity.baseCommitSha !== repository.baseCommitSha) throw agentXError("CONFIG_INVALID", "candidate source repository differs from its immutable manifest");
    const singleCandidate = createCandidateManifest([identity]);
    const sources = repository.sources.map((source) => {
      const decoded = Buffer.from(source.bytesBase64, "base64");
      if (decoded.toString("base64") !== source.bytesBase64) throw agentXError("CONFIG_INVALID", "candidate source blob encoding is invalid");
      sourceBytes += decoded.byteLength;
      if (sourceBytes > 4 * 1024 * 1024) throw agentXError("CONFIG_INVALID", "candidate source blobs exceed their aggregate bound");
      return { path: source.path, sha256: source.sha256, bytes: decoded, kind: "blob" as const };
    });
    try { verifyE2ESourceSnapshot({ candidate: singleCandidate, commitSha: repository.commitSha, treeSha: repository.treeSha,
      treeComplete: repository.treeComplete, treePaths: repository.treePaths, sources }, singleCandidate); }
    catch { throw agentXError("CONFIG_INVALID", "candidate source bytes do not match their committed tree inventory"); }
  }
  const candidateDigest = manifest.data.digest;
  const sourceRef = { key: `workflow-candidate-sources/sha256/${body.sha256}.json`, sha256: body.sha256, byteLength: bytes.byteLength, candidateDigest };
  try {
    await dependencies.s3.send(new PutObjectCommand({ Bucket: dependencies.artifactBucketName, Key: sourceRef.key, Body: bytes, ContentType: "application/json",
      Metadata: { sha256: body.sha256, candidate: candidateDigest, operation: operation.id }, IfNoneMatch: "*" }));
  } catch (error) {
    const status = error && typeof error === "object" ? (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode : undefined;
    if (status !== 412 && (error as { name?: unknown } | undefined)?.name !== "PreconditionFailed") throw error;
    if (await readStoredText(dependencies.s3, dependencies.artifactBucketName, sourceRef.key, MAX_WORKFLOW_CANDIDATE_EXPORT_BYTES) !== bytes.toString("utf8")) {
      throw agentXError("RUNTIME_UNAVAILABLE", "existing candidate source object does not match its content address");
    }
  }
  await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
    { Update: { TableName: dependencies.tableName, Key: key, UpdateExpression: "SET #status = :complete, sourceRef = :sourceRef",
      ConditionExpression: "#status = :open AND uploadId = :uploadId AND sha256 = :sha256 AND operationId = :operationId AND fence = :fence",
      ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":complete": "COMPLETE", ":open": "OPEN", ":sourceRef": sourceRef,
        ":uploadId": body.uploadId, ":sha256": body.sha256, ":operationId": operation.id, ":fence": operation.fence } } },
    { Update: { TableName: dependencies.tableName, Key: operationKey(operation.workspaceId, operation.id), UpdateExpression: "SET candidateSourceRef = :sourceRef",
      ConditionExpression: "#status = :running AND fence = :fence AND workflowMode = :mode AND attribute_not_exists(candidateSourceRef)",
      ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":sourceRef": sourceRef, ":running": "RUNNING", ":fence": operation.fence, ":mode": "IMPLEMENT" } } },
  ] }));
  for (const chunkKey of chunkKeys) await dependencies.s3.send(new DeleteObjectCommand({ Bucket: dependencies.artifactBucketName, Key: chunkKey }));
  return { sourceRef };
}

/**
 * Receives the build source manifest a worker computed for the candidate it just exported (Task 2.4b). It only ever follows a finalized candidate source
 * export, is judged against that stored export, and records either the validated manifest's location and digest or the reason there is none, on the export
 * record (`buildSource`) and on the IMPLEMENT operation (`candidateBuildSource`). A refusal is a successful answer, never an error: the portable export and
 * the terminal result do not depend on this, and an application round later refuses with the recorded reason.
 */
async function handleWorkflowCandidateBuildSource(dependencies: AwsBrokerDependencies, operation: OperationRecord, rawBody: unknown): Promise<unknown> {
  const body = CandidateBuildSourceBodySchema.parse(rawBody);
  const sourceRef = operation.candidateSourceRef;
  if (sourceRef === undefined) throw agentXError("STALE_FENCE", "the candidate build source follows a finalized candidate source export");
  const exportKey = { pk: `WORKSPACE#${operation.workspaceId}`, sk: `CANDIDATE_EXPORT#${operation.id}` };
  const uploadKey = { pk: `WORKSPACE#${operation.workspaceId}`, sk: `CANDIDATE_BUILD_SOURCE#${operation.id}` };
  /**
   * Records `stored` once. `upload` closes the upload row too: COMPLETE for the upload that carried the manifest, ABORTED for one the worker abandoned by
   * reporting it has no manifest. Losing a race (another finalize, or an unavailable report, recorded first) is answered from what won, never as an error.
   */
  const record = async (stored: StoredCandidateBuildSource, upload?: { uploadId: string; sha256: string; closing: "COMPLETE" | "ABORTED" }): Promise<unknown> => {
    try {
      await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
        ...(upload === undefined ? [] : [{ Update: { TableName: dependencies.tableName, Key: uploadKey, UpdateExpression: upload.closing === "COMPLETE" ? "SET #status = :closing, buildSource = :stored" : "SET #status = :closing",
          ConditionExpression: "#status = :open AND uploadId = :uploadId AND sha256 = :sha256 AND operationId = :operationId AND fence = :fence",
          ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":closing": upload.closing, ":open": "OPEN", ...(upload.closing === "COMPLETE" ? { ":stored": stored } : {}),
            ":uploadId": upload.uploadId, ":sha256": upload.sha256, ":operationId": operation.id, ":fence": operation.fence } } }]),
        { Update: { TableName: dependencies.tableName, Key: exportKey, UpdateExpression: "SET buildSource = :stored",
          ConditionExpression: "entityType = :entity AND #status = :complete AND operationId = :operationId AND fence = :fence AND attribute_not_exists(buildSource)",
          ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":stored": stored, ":entity": "WORKFLOW_CANDIDATE_EXPORT", ":complete": "COMPLETE",
            ":operationId": operation.id, ":fence": operation.fence } } },
        { Update: { TableName: dependencies.tableName, Key: operationKey(operation.workspaceId, operation.id), UpdateExpression: "SET candidateBuildSource = :stored",
          ConditionExpression: "#status = :running AND fence = :fence AND workflowMode = :mode AND attribute_exists(candidateSourceRef) AND attribute_not_exists(candidateBuildSource)",
          ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":stored": stored, ":running": "RUNNING", ":fence": operation.fence, ":mode": "IMPLEMENT" } } },
      ] }));
    } catch (error) {
      if (!isConditional(error)) throw error;
      const current = await getItem<OperationRecord>(dependencies, operationKey(operation.workspaceId, operation.id));
      const winner = StoredCandidateBuildSourceSchema.safeParse(current?.candidateBuildSource);
      if (!winner.success) throw agentXError("STALE_FENCE", "candidate build source can no longer be recorded for this operation");
      if (canonicalJson(winner.data) !== canonicalJson(stored)) throw agentXError("CALLBACK_FORBIDDEN", "this implementation already recorded a different build source");
      return { accepted: stored.status === "READY", buildSource: stored, duplicate: true };
    }
    return { accepted: stored.status === "READY", buildSource: stored };
  };
  const alreadyRecorded = StoredCandidateBuildSourceSchema.safeParse(operation.candidateBuildSource);
  if (body.stage === "unavailable") {
    const stored: StoredCandidateBuildSource = { status: "REFUSED", reason: `the worker could not export a build source manifest: ${body.reason}`.slice(0, 600), candidateDigest: sourceRef.candidateDigest };
    if (alreadyRecorded.success) {
      if (canonicalJson(alreadyRecorded.data) !== canonicalJson(stored)) throw agentXError("CALLBACK_FORBIDDEN", "this implementation already recorded a different build source");
      return { accepted: false, buildSource: stored, duplicate: true };
    }
    // An upload the worker started and then abandoned is closed with the answer, and what it staged is deleted.
    const abandoned = await getItem<Record<string, unknown>>(dependencies, uploadKey);
    if (abandoned?.entityType === "WORKFLOW_CANDIDATE_BUILD_SOURCE" && abandoned.status === "OPEN" && typeof abandoned.uploadId === "string" && typeof abandoned.sha256 === "string") {
      const answer = await record(stored, { uploadId: abandoned.uploadId, sha256: abandoned.sha256, closing: "ABORTED" });
      for (let index = 0; index < Number(abandoned.chunkCount); index += 1) {
        await dependencies.s3.send(new DeleteObjectCommand({ Bucket: dependencies.artifactBucketName, Key: `workflow-candidate-build-source-staging/${operation.workspaceId}/${operation.id}/${abandoned.uploadId}/${index}.chunk` }));
      }
      return answer;
    }
    return record(stored);
  }
  const upload = await getItem<Record<string, unknown>>(dependencies, uploadKey);
  if (body.stage === "init") {
    if (body.chunkCount !== Math.ceil(body.totalBytes / WORKFLOW_CANDIDATE_CHUNK_BYTES)) throw agentXError("CONFIG_INVALID", "candidate build source chunk count does not match its total");
    if (upload) {
      if (upload.entityType !== "WORKFLOW_CANDIDATE_BUILD_SOURCE" || upload.status !== "OPEN" || upload.operationId !== operation.id || upload.fence !== operation.fence
        || upload.totalBytes !== body.totalBytes || upload.chunkCount !== body.chunkCount || upload.sha256 !== body.sha256 || typeof upload.uploadId !== "string") {
        throw agentXError("CALLBACK_FORBIDDEN", "implementation already owns a different candidate build source upload");
      }
      return { uploadId: upload.uploadId, chunkBytes: WORKFLOW_CANDIDATE_CHUNK_BYTES, totalBytes: body.totalBytes, chunkCount: body.chunkCount };
    }
    if (alreadyRecorded.success) throw agentXError("CALLBACK_FORBIDDEN", "this implementation already recorded its build source");
    const uploadId = randomUUID();
    await dependencies.documentClient.send(new PutCommand({ TableName: dependencies.tableName, Item: { ...uploadKey, entityType: "WORKFLOW_CANDIDATE_BUILD_SOURCE", schemaVersion: 1,
      workspaceId: operation.workspaceId, operationId: operation.id, fence: operation.fence, uploadId, totalBytes: body.totalBytes, chunkCount: body.chunkCount,
      sha256: body.sha256, nextChunkIndex: 0, status: "OPEN", createdAt: new Date().toISOString() }, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" }));
    return { uploadId, chunkBytes: WORKFLOW_CANDIDATE_CHUNK_BYTES, totalBytes: body.totalBytes, chunkCount: body.chunkCount };
  }
  if (!upload || upload.entityType !== "WORKFLOW_CANDIDATE_BUILD_SOURCE" || upload.operationId !== operation.id || upload.fence !== operation.fence) {
    throw agentXError("STALE_FENCE", "candidate build source upload is not current");
  }
  if (body.stage === "finalize" && upload.status === "COMPLETE" && upload.uploadId === body.uploadId && upload.sha256 === body.sha256 && alreadyRecorded.success) {
    return { accepted: alreadyRecorded.data.status === "READY", buildSource: alreadyRecorded.data, duplicate: true };
  }
  if (upload.status !== "OPEN") throw agentXError("STALE_FENCE", "candidate build source upload is no longer open");
  const stagingKey = (index: number) => `workflow-candidate-build-source-staging/${operation.workspaceId}/${operation.id}/${String(upload.uploadId)}/${index}.chunk`;
  if (body.stage === "chunk") {
    if (upload.uploadId !== body.uploadId || !Number.isSafeInteger(body.index) || body.index >= Number(upload.chunkCount)) throw agentXError("CALLBACK_FORBIDDEN", "candidate build source chunk is outside its owned upload");
    const bytes = Buffer.from(body.bytesBase64, "base64");
    const expected = body.index === Number(upload.chunkCount) - 1 ? Number(upload.totalBytes) - body.index * WORKFLOW_CANDIDATE_CHUNK_BYTES : WORKFLOW_CANDIDATE_CHUNK_BYTES;
    if (bytes.byteLength !== expected || bytes.toString("base64") !== body.bytesBase64 || createHash("sha256").update(bytes).digest("hex") !== body.sha256) throw agentXError("CONFIG_INVALID", "candidate build source chunk bytes or digest are invalid");
    const nextIndex = Number(upload.nextChunkIndex);
    if (body.index > nextIndex) throw agentXError("CONFIG_INVALID", "candidate build source chunks must arrive in order");
    if (body.index < nextIndex) {
      const prior = await readSetupChunk(dependencies, stagingKey(body.index));
      if (!prior?.equals(bytes)) throw agentXError("CALLBACK_FORBIDDEN", "replayed candidate build source chunk differs from its owned bytes");
      return { accepted: true, index: body.index, duplicate: true };
    }
    await dependencies.s3.send(new PutObjectCommand({ Bucket: dependencies.artifactBucketName, Key: stagingKey(body.index), Body: bytes,
      ContentType: "application/octet-stream", Metadata: { sha256: body.sha256, upload: body.uploadId, index: String(body.index) }, IfNoneMatch: "*" }));
    await dependencies.documentClient.send(new UpdateCommand({ TableName: dependencies.tableName, Key: uploadKey, UpdateExpression: "SET nextChunkIndex = :next",
      ConditionExpression: "#status = :open AND nextChunkIndex = :index AND operationId = :operationId AND fence = :fence",
      ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":next": body.index + 1, ":open": "OPEN", ":index": body.index,
        ":operationId": operation.id, ":fence": operation.fence } }));
    return { accepted: true, index: body.index, duplicate: false };
  }
  if (upload.uploadId !== body.uploadId || upload.sha256 !== body.sha256 || Number(upload.nextChunkIndex) !== Number(upload.chunkCount)) {
    throw agentXError("STALE_FENCE", "candidate build source upload is incomplete or changed");
  }
  const chunks: Buffer[] = [];
  for (let index = 0; index < Number(upload.chunkCount); index += 1) {
    const chunk = await readSetupChunk(dependencies, stagingKey(index));
    if (!chunk) throw agentXError("RUNTIME_UNAVAILABLE", "an owned candidate build source chunk is missing");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.byteLength !== Number(upload.totalBytes) || createHash("sha256").update(bytes).digest("hex") !== body.sha256) throw agentXError("CONFIG_INVALID", "candidate build source bytes do not match their stored digest");
  const committed = await readStoredCandidateSourceExport(dependencies, sourceRef);
  if (committed === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the committed candidate source export is unavailable to check its build source against");
  const stored = assessCandidateBuildSource({ manifestBytes: bytes, committed });
  if (stored.status === "READY") {
    try {
      await dependencies.s3.send(new PutObjectCommand({ Bucket: dependencies.artifactBucketName, Key: stored.manifestRef.key, Body: bytes, ContentType: "application/json",
        Metadata: { sha256: stored.manifestRef.sha256, candidate: stored.candidateDigest, operation: operation.id }, IfNoneMatch: "*" }));
    } catch (error) {
      const status = error && typeof error === "object" ? (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode : undefined;
      if (status !== 412 && (error as { name?: unknown } | undefined)?.name !== "PreconditionFailed") throw error;
      const existing = await readStoredBytes(dependencies, stored.manifestRef.key, E2E_APPLICATION_BUILD_SOURCE_MANIFEST_MAX_BYTES);
      if (existing === undefined || !existing.equals(bytes)) {
        throw agentXError("RUNTIME_UNAVAILABLE", "existing candidate build source object does not match its content address");
      }
    }
  }
  const answer = await record(stored, { uploadId: body.uploadId, sha256: body.sha256, closing: "COMPLETE" });
  for (let index = 0; index < Number(upload.chunkCount); index += 1) await dependencies.s3.send(new DeleteObjectCommand({ Bucket: dependencies.artifactBucketName, Key: stagingKey(index) }));
  return answer;
}

/**
 * M1.3 Task 3.7b: receives the unchanged code (the task's base commit) a worker exported at the end of a coding run, for the baseline round. It follows nothing and decides nothing
 * about the coding run: one upload (the export and its build source manifest, as the exact bytes the worker made) or one report that there is none, judged by `assessBaselineSource`
 * and recorded once on the coding operation. A refusal of the manifest is a successful answer (the baseline then says it could not be checked); an export that is not the unchanged
 * code of one repository is an error and records nothing. Whether it is the base the task pinned is decided at the baseline's dispatch, not here.
 */
async function handleWorkflowBaselineSource(dependencies: AwsBrokerDependencies, operation: OperationRecord, rawBody: unknown): Promise<unknown> {
  const body = BaselineSourceBodySchema.parse(rawBody);
  const operationRowKey = operationKey(operation.workspaceId, operation.id);
  const uploadKey = { pk: `WORKSPACE#${operation.workspaceId}`, sk: `BASELINE_SOURCE#${operation.id}` };
  const stagingKey = (uploadId: string, index: number) => `workflow-baseline-staging/${operation.workspaceId}/${operation.id}/${uploadId}/${index}.chunk`;
  const recorded = StoredBaselineSourceSchema.safeParse(operation.baselineSource);
  // T7b: a planning run asked for the unchanged code uploads it under its own operation (the same per-operation upload key and fence), and the record lands on that operation's row only,
  // so it can never replace an implementation run's baseline source. Its worker's free text (git and file system messages) is never stored: a failure is one fixed sentence.
  const planAsked = operation.workflowMode === "PLAN" && operation.groundingSourceAsked === true;
  /** Records `stored` once; a record already there is answered from, and differs only as an error. `closing` closes the upload row in the same transaction. */
  const record = async (stored: StoredBaselineSource, closing?: { uploadId: string; sha256: string }): Promise<unknown> => {
    try {
      await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
        ...(closing === undefined ? [] : [{ Update: { TableName: dependencies.tableName, Key: uploadKey, UpdateExpression: "SET #status = :complete",
          ConditionExpression: "#status = :open AND uploadId = :uploadId AND sha256 = :sha256 AND operationId = :operationId AND fence = :fence",
          ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":complete": "COMPLETE", ":open": "OPEN", ":uploadId": closing.uploadId, ":sha256": closing.sha256,
            ":operationId": operation.id, ":fence": operation.fence } } }]),
        { Update: { TableName: dependencies.tableName, Key: operationRowKey, UpdateExpression: "SET baselineSource = :stored",
          ConditionExpression: `#status = :running AND fence = :fence AND workflowMode = :mode AND attribute_not_exists(baselineSource)${planAsked ? " AND groundingSourceAsked = :asked" : ""}`,
          ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":stored": stored, ":running": "RUNNING", ":fence": operation.fence, ":mode": planAsked ? "PLAN" : "IMPLEMENT", ...(planAsked ? { ":asked": true } : {}) } } },
      ] }));
    } catch (error) {
      if (!isConditional(error)) throw error;
      const winner = StoredBaselineSourceSchema.safeParse((await getItem<OperationRecord>(dependencies, operationRowKey))?.baselineSource);
      if (!winner.success) throw agentXError("STALE_FENCE", "the baseline source can no longer be recorded for this operation");
      if (canonicalJson(winner.data) !== canonicalJson(stored)) throw agentXError("CALLBACK_FORBIDDEN", "this implementation already recorded a different baseline source");
      return { accepted: stored.status === "READY", baselineSource: stored, duplicate: true };
    }
    return { accepted: stored.status === "READY", baselineSource: stored };
  };
  if (body.stage === "unavailable") {
    const stored: StoredBaselineSource = { status: "REFUSED", reason: planAsked ? GROUNDING_SOURCE_NOT_EXPORTED_REASON : `the worker could not export the unchanged code: ${body.reason}`.slice(0, 600) };
    if (recorded.success) {
      if (canonicalJson(recorded.data) !== canonicalJson(stored)) throw agentXError("CALLBACK_FORBIDDEN", "this implementation already recorded a different baseline source");
      return { accepted: false, baselineSource: stored, duplicate: true };
    }
    return record(stored);
  }
  const upload = await getItem<Record<string, unknown>>(dependencies, uploadKey);
  if (body.stage === "init") {
    if (body.chunkCount !== Math.ceil(body.totalBytes / WORKFLOW_CANDIDATE_CHUNK_BYTES) || body.totalBytes > MAX_WORKFLOW_CANDIDATE_EXPORT_BYTES) {
      throw agentXError("CONFIG_INVALID", "baseline source chunk count does not match its total, or the upload is over its bound");
    }
    if (upload) {
      if (upload.entityType !== "WORKFLOW_BASELINE_SOURCE" || upload.status !== "OPEN" || upload.operationId !== operation.id || upload.fence !== operation.fence
        || upload.totalBytes !== body.totalBytes || upload.chunkCount !== body.chunkCount || upload.sha256 !== body.sha256 || typeof upload.uploadId !== "string") {
        throw agentXError("CALLBACK_FORBIDDEN", "implementation already owns a different baseline source upload");
      }
      return { uploadId: upload.uploadId, chunkBytes: WORKFLOW_CANDIDATE_CHUNK_BYTES, totalBytes: body.totalBytes, chunkCount: body.chunkCount };
    }
    if (recorded.success) throw agentXError("CALLBACK_FORBIDDEN", "this implementation already recorded its baseline source");
    const uploadId = randomUUID();
    await dependencies.documentClient.send(new PutCommand({ TableName: dependencies.tableName, Item: { ...uploadKey, entityType: "WORKFLOW_BASELINE_SOURCE", schemaVersion: 1,
      workspaceId: operation.workspaceId, operationId: operation.id, fence: operation.fence, uploadId, totalBytes: body.totalBytes, chunkCount: body.chunkCount, sha256: body.sha256,
      nextChunkIndex: 0, status: "OPEN", createdAt: new Date().toISOString() }, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" }));
    return { uploadId, chunkBytes: WORKFLOW_CANDIDATE_CHUNK_BYTES, totalBytes: body.totalBytes, chunkCount: body.chunkCount };
  }
  if (!upload || upload.entityType !== "WORKFLOW_BASELINE_SOURCE" || upload.operationId !== operation.id || upload.fence !== operation.fence) {
    throw agentXError("STALE_FENCE", "baseline source upload is not current");
  }
  if (body.stage === "finalize" && upload.status === "COMPLETE" && upload.uploadId === body.uploadId && upload.sha256 === body.sha256 && recorded.success) {
    return { accepted: recorded.data.status === "READY", baselineSource: recorded.data, duplicate: true };
  }
  if (upload.status !== "OPEN") throw agentXError("STALE_FENCE", "baseline source upload is no longer open");
  if (body.stage === "chunk") {
    if (upload.uploadId !== body.uploadId || body.index >= Number(upload.chunkCount)) throw agentXError("CALLBACK_FORBIDDEN", "baseline source chunk is outside its owned upload");
    const bytes = Buffer.from(body.bytesBase64, "base64");
    const expected = body.index === Number(upload.chunkCount) - 1 ? Number(upload.totalBytes) - body.index * WORKFLOW_CANDIDATE_CHUNK_BYTES : WORKFLOW_CANDIDATE_CHUNK_BYTES;
    if (bytes.byteLength !== expected || bytes.toString("base64") !== body.bytesBase64 || createHash("sha256").update(bytes).digest("hex") !== body.sha256) {
      throw agentXError("CONFIG_INVALID", "baseline source chunk bytes or digest are invalid");
    }
    const nextIndex = Number(upload.nextChunkIndex);
    if (body.index > nextIndex) throw agentXError("CONFIG_INVALID", "baseline source chunks must arrive in order");
    if (body.index < nextIndex) {
      const prior = await readSetupChunk(dependencies, stagingKey(body.uploadId, body.index));
      if (!prior?.equals(bytes)) throw agentXError("CALLBACK_FORBIDDEN", "replayed baseline source chunk differs from its owned bytes");
      return { accepted: true, index: body.index, duplicate: true };
    }
    await dependencies.s3.send(new PutObjectCommand({ Bucket: dependencies.artifactBucketName, Key: stagingKey(body.uploadId, body.index), Body: bytes,
      ContentType: "application/octet-stream", Metadata: { sha256: body.sha256, upload: body.uploadId, index: String(body.index) }, IfNoneMatch: "*" }));
    await dependencies.documentClient.send(new UpdateCommand({ TableName: dependencies.tableName, Key: uploadKey, UpdateExpression: "SET nextChunkIndex = :next",
      ConditionExpression: "#status = :open AND nextChunkIndex = :index AND operationId = :operationId AND fence = :fence",
      ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":next": body.index + 1, ":open": "OPEN", ":index": body.index, ":operationId": operation.id, ":fence": operation.fence } }));
    return { accepted: true, index: body.index, duplicate: false };
  }
  if (upload.uploadId !== body.uploadId || upload.sha256 !== body.sha256 || Number(upload.nextChunkIndex) !== Number(upload.chunkCount)) {
    throw agentXError("STALE_FENCE", "baseline source upload is incomplete or changed");
  }
  const chunks: Buffer[] = [];
  for (let index = 0; index < Number(upload.chunkCount); index += 1) {
    const chunk = await readSetupChunk(dependencies, stagingKey(body.uploadId, index));
    if (!chunk) throw agentXError("RUNTIME_UNAVAILABLE", "an owned baseline source chunk is missing");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.byteLength !== Number(upload.totalBytes) || createHash("sha256").update(bytes).digest("hex") !== body.sha256) throw agentXError("CONFIG_INVALID", "baseline source bytes do not match their stored digest");
  let sourceBytes: Buffer;
  let manifestBytes: Buffer;
  let stored: StoredBaselineSource;
  try {
    const wire = BaselineSourceWireSchema.parse(JSON.parse(bytes.toString("utf8")) as unknown);
    sourceBytes = Buffer.from(wire.sourceBase64, "base64");
    manifestBytes = Buffer.from(wire.manifestBase64, "base64");
    if (sourceBytes.toString("base64") !== wire.sourceBase64 || manifestBytes.toString("base64") !== wire.manifestBase64) throw new Error("the baseline source encoding is invalid");
    stored = assessBaselineSource({ sourceBytes, manifestBytes });
  } catch (error) {
    throw agentXError("CONFIG_INVALID", `baseline source export is malformed or is not the unchanged code of one repository: ${planAsked ? "unreadable" : error instanceof Error ? error.message : "unreadable"}`.slice(0, 480));
  }
  // A planning run's refused export keeps no text of the validator's (it can name paths): one fixed sentence, which the grounding record reads as `not-exported`.
  if (planAsked && stored.status === "REFUSED") stored = { status: "REFUSED", reason: GROUNDING_SOURCE_REFUSED_REASON };
  if (stored.status === "READY") {
    const content = [{ key: stored.sourceRef.key, bytes: sourceBytes, limit: MAX_WORKFLOW_CANDIDATE_EXPORT_BYTES }, { key: stored.buildSource.manifestRef.key, bytes: manifestBytes, limit: E2E_APPLICATION_BUILD_SOURCE_MANIFEST_MAX_BYTES }];
    for (const item of content) {
      try {
        await dependencies.s3.send(new PutObjectCommand({ Bucket: dependencies.artifactBucketName, Key: item.key, Body: item.bytes, ContentType: "application/json",
          Metadata: { sha256: createHash("sha256").update(item.bytes).digest("hex"), candidate: stored.sourceRef.candidateDigest, operation: operation.id }, IfNoneMatch: "*" }));
      } catch (error) {
        const status = error && typeof error === "object" ? (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode : undefined;
        if (status !== 412 && (error as { name?: unknown } | undefined)?.name !== "PreconditionFailed") throw error;
        const existing = await readStoredBytes(dependencies, item.key, item.limit);
        if (existing === undefined || !existing.equals(item.bytes)) throw agentXError("RUNTIME_UNAVAILABLE", "an existing baseline source object does not match its content address");
      }
    }
  }
  const answer = await record(stored, { uploadId: body.uploadId, sha256: body.sha256 });
  for (let index = 0; index < Number(upload.chunkCount); index += 1) await dependencies.s3.send(new DeleteObjectCommand({ Bucket: dependencies.artifactBucketName, Key: stagingKey(body.uploadId, index) }));
  return answer;
}
