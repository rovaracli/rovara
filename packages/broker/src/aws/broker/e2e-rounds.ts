// Part of the broker (split out of ../broker.ts): application E2E rounds (baseline, replay, grounding) and their dispatch.

import { createHash, randomUUID } from "node:crypto";
import { DeleteCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { AgentXError, E2EPolicySchema, groundingScenarioIds, canonicalJson, type PlanDocument, blockWorkflow, WORKFLOW_BLOCK_REASONS, agentXError, type WorkflowSnapshot, type OrgId, type E2ESourceSnapshot, type E2EReplayRefusal, type E2EReplaySourceCase, E2E_REPLAY_ATTEMPTS_MAX, E2E_REPLAY_RECORDS_MAX, E2EWorkflowAdmissionRefSchema, type E2EApplicationPlanIntent, E2EApplicationSelectionRecordSchema, E2E_MODEL_ROUTE_DEFAULT_BUDGETS, E2E_APPLICATION_BUILD_SOURCE_MANIFEST_MAX_BYTES, E2EApplicationBuildSourceManifestSchema, WORKFLOW_APPLICATION_SELECTION_CHANGED_PREFIX, type E2EApplicationExecutionAdmission, type E2ERegisteredRuntime } from "@agentx/contracts";
import { decodeE2EApplicationExecutionAdmission } from "@agentx/verifier";
import { StoredBaselineSourceSchema, parseBaselineExport, type ReadyBaselineSource } from "../baseline-source.js";
import { E2E_BASELINE_ATTEMPT, E2E_BASELINE_PURPOSE, E2E_BASELINE_RUN_GRACE_MS, baselineStartFailureReason, baselineStartItem, markWorkflowE2EBaselineUnavailable, readWorkflowE2EBaselineRecord, type BaselineRecord, type BaselineUnavailableReason } from "../workflow-e2e-baseline.js";
import { E2E_REPLAY_PURPOSE, E2E_REPLAY_RUN_GRACE_MS, listWorkflowE2EReplayRecords, markWorkflowE2EReplayUnavailable, replaySourceCasesOf, replayStartItem, requestWorkflowE2EReplay, type ReplayRecord } from "../workflow-e2e-replay.js";
import { queryAllItems } from "../admin-reads.js";
import { plannerRepliesItem } from "../../developer/page-comments.js";
import { loadWorkflowDocument, readObjectText as readStoredText } from "../../developer/plan-artifacts.js";
import { planEvidenceEvent, planEvidenceJobItem } from "../../developer/plan-evidence-jobs.js";
import { buildE2EFeatureRound, deriveE2EFeatureExecutionAdmission } from "../../e2e/feature-plan-intent.js";
import { e2eFeatureVerifierKey } from "../e2e-feature-verifier-catalog.js";
import { resolveWorkflowE2ECanonicalApproval } from "../workflow-e2e-current-authority.js";
import { TERMINAL, getItem, operationKey, requestCancellation, type OperationRecord } from "../cancellation.js";
import { taskKey, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { WORKFLOW_DISPATCH_PK, workflowDispatchItem, type WorkflowDispatchRecord, isConditional } from "../broker-shared.js";
import { portableFeatureIntentOf } from "../../e2e/portable-feature-intent.js";
import { E2E_OWNER_SENTENCES } from "../../e2e/owner-sentences.js";
import { ApplicationRuntimeRenewed, assertNoRequalifyHold, replayPredatesRenewal, requalifyHoldActive, selectionChangedRefusal } from "../../e2e/requalify-hold.js";
import { ApplicationDispatchRefusal, ApplicationPlanDefect, applicationAccountsRefusal, applicationRoundRefusal, applicationRuntimeRefusal, applicationSelectionStillCurrent } from "../../e2e/application-dispatch-check.js";
import { applicationApprovedPlanDigest, buildApplicationExecutionAdmission, buildApplicationGroundingAdmission, buildApplicationReplayAdmission } from "../../e2e/application-admission.js";
import { groundingRoundLapsed, E2E_GROUNDING_ATTEMPT, E2E_GROUNDING_PURPOSE, groundingStartFailureReason, groundingStartItem, markWorkflowE2EGroundingUnavailable, readWorkflowE2EGroundingRecord, requestWorkflowE2EGroundingRound, type GroundingRecord, type GroundingUnavailableReason } from "../workflow-e2e-grounding.js";
import { groundingFindingsOf } from "../../developer/plan-grounding-findings.js";
import { checkE2EAgentRouteCurrent, deriveE2EAgentRoute, isTransientAwsFault, e2eDayBudgetRoom, type E2EAgentInstallation } from "../../e2e/model-route-registry.js";
import { modelRouteForAdmission, verifyApplicationE2EEvidence, type VerifiedAgentTrace } from "../../e2e/application-evidence.js";
import type { TransactItems } from "../developer-task-actions.js";
import { startTaskWorkflowE2EGroundingFromSystem, startTaskWorkflowE2EBaselineFromSystem, startTaskWorkflowE2EChecksFromSystem, startTaskWorkflowE2EReplayFromSystem, type startTaskWorkflowReviewFromSystem } from "../developer-tasks.js";
import type { GroundingOutcome } from "../../developer/plan-self-check.js";
import { StoredCandidateBuildSourceSchema, candidateBuildSourceAdmissionReference, type StoredCandidateBuildSource } from "../candidate-build-source.js";
import { runDueWorkflowMergeTracking } from "../workflow-merge-recovery.js";
import { workflowRunEndedReason } from "../outbox-failure.js";
import { cancelRunningTask } from "./acceptance.js";
import { MAX_WORKFLOW_CANDIDATE_EXPORT_BYTES, type AwsBrokerDependencies } from "./definitions.js";
import { requireRecordProject } from "./dependency-wiring.js";
import { runWorkflowDispatch } from "./dispatch.js";
import { WORKFLOW_E2E_ADMISSION_MAX_BYTES, readStoredBytes } from "./evidence-and-setup.js";
import { storePlanAnswer, writeAllPlannerReplies, type PlannerReplies } from "./plan-answers.js";
import { requireWorkspace } from "./records.js";
import { githubScope, githubScopeOf, orgOfRecord } from "./scope-helpers.js";
import { requireWorkflowE2ECreatorAuthority } from "./sweeps-and-readiness.js";
import { evaluateWorkflowE2EApplicationSelectionNow, type ApplicationSelectionNow } from "./task-operations.js";
import { reconcileWorkflowTrackingTask } from "./terminal-and-github-events.js";
import { loadApplicationEvidenceInputs, settleBaselineRound } from "./workflow-e2e-verification.js";
import { attachInlineEvidence, loadWorkflowCandidateSourceExport, startPlanEvidenceJobs } from "./workflow-items.js";

/**
 * Ruling AL, dispatch half: derives the approved application selection again from the approved setup and the runtime rows READY right now, and refuses
 * (a terminal ApplicationDispatchRefusal that blocks the workflow with its reason) when anything differs from what the Owner approved. The block text begins with
 * `WORKFLOW_APPLICATION_SELECTION_CHANGED_PREFIX`: a row that was merely requalified is not the approved one, and the comparison stays byte-exact, so the owner's
 * way on is to retry the checks, which approves the same plan again against the rows that are there now (see `retryTaskWorkflow`). A selection that cannot be derived
 * because something could not be read is a retryable RUNTIME_UNAVAILABLE instead. It never widens what was approved. Returns what the derivation read.
 */
async function requireApplicationSelectionStillCurrent(dependencies: AwsBrokerDependencies, task: DeveloperTaskRecord, intent: E2EApplicationPlanIntent,
  artifact: { id: string; sha256: string }): Promise<Extract<ApplicationSelectionNow, { ok: true }>> {
  const recorded = E2EApplicationSelectionRecordSchema.safeParse(task.workflow?.e2e?.applicationSelection);
  if (!recorded.success) throw applicationRoundRefusal("the approved plan has no recorded application selection");
  const current = await evaluateWorkflowE2EApplicationSelectionNow(dependencies, task, intent, artifact, { mode: "current", pinned: recorded.data.accountRefs });
  if (!current.ok) {
    if (current.kind === "unevaluable") throw agentXError("RUNTIME_UNAVAILABLE", `the approved application selection could not be checked at dispatch (${current.reason})`);
    // A plan that can never run as written goes back to planning; a runtime that cannot carry it asks for an administrator; a test account that moved on asks for the plan to be
    // approved again (accounts-changed-reapprove); any other change asks for the plan to be approved again too.
    if (current.scope === "plan") throw new ApplicationPlanDefect(current.reason);
    if (current.scope === "runtime") throw applicationRuntimeRefusal(current.reason);
    if (current.scope === "accounts") throw applicationAccountsRefusal(current.reason);
    throw new ApplicationDispatchRefusal(`${WORKFLOW_APPLICATION_SELECTION_CHANGED_PREFIX}${current.reason}`);
  }
  const unchanged = applicationSelectionStillCurrent(recorded.data, current.selection);
  if (!unchanged.ok) throw selectionChangedRefusal(recorded.data, current.selection, unchanged.reason, WORKFLOW_APPLICATION_SELECTION_CHANGED_PREFIX);
  return current;
}

/** Whether an operation's signed reference is for a round that is not the candidate's: the baseline (the unchanged code) or an audit replay (Task 4.6b). Neither can ever be a verdict on the candidate. */
export const isNonCandidateRound = (reference: { purpose?: "baseline" | "replay" | "grounding" | undefined } | undefined): boolean => reference?.purpose === "baseline" || reference?.purpose === "grounding" || reference?.purpose === "replay";

const NO_COMMITTED_EXPORT_REASON = "the candidate has no committed source export, so there is no source to build and run";
const NO_BUILD_SOURCE_REASON = "no build source manifest was exported for this candidate";

/** The newest IMPLEMENT operation that exported the given candidate's committed source (its `candidateSourceRef` names the candidate). */
export async function candidateSourceOperation(dependencies: AwsBrokerDependencies, task: DeveloperTaskRecord, candidateDigest: string): Promise<OperationRecord | undefined> {
  return (await queryAllItems(dependencies, `WORKSPACE#${task.workspaceId}`, "OPERATION#"))
    .filter((item) => item.entityType === "OPERATION" && item.kind === "task" && item.workflowMode === "IMPLEMENT")
    .map((item) => item as unknown as OperationRecord)
    .filter((operation) => operation.candidateSourceRef?.candidateDigest === candidateDigest)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}

/**
 * The build source the worker exported for the candidate and the broker judged (Task 2.4b), as the IMPLEMENT operation records it: READY, or a refusal with its
 * reason. Absent means the worker sent nothing (an old worker, a delivery failure), which is refused too. Never falls back to anything.
 */
function readyCandidateBuildSource(operation: OperationRecord, candidateDigest: string): Extract<StoredCandidateBuildSource, { status: "READY" }> {
  if (operation.candidateBuildSource === undefined) throw applicationRoundRefusal(NO_BUILD_SOURCE_REASON);
  const stored = StoredCandidateBuildSourceSchema.safeParse(operation.candidateBuildSource);
  if (!stored.success) throw applicationRoundRefusal("the stored build source record for this candidate cannot be read");
  if (stored.data.candidateDigest !== candidateDigest) throw applicationRoundRefusal("the stored build source record is for another candidate than the one being checked");
  if (stored.data.status === "REFUSED") throw applicationRoundRefusal(stored.data.reason);
  return stored.data;
}

/**
 * Checks an approved application plan before its workspace is warmed: the selection is checked (Ruling AL) and the candidate must have a usable build source, so
 * compute is never woken for a round that cannot run. Only a task that carries an application selection record is read here, so a portable task reads nothing
 * extra; the rest of the round's inputs are read, and the admission built, by `startWorkflowE2EChecksDispatch`. Every refusal is terminal and carries its reason.
 */
export async function refuseApplicationRoundBeforeWarmUp(dependencies: AwsBrokerDependencies, task: DeveloperTaskRecord): Promise<void> {
  const workflow = task.workflow;
  if (workflow?.e2e?.applicationSelection === undefined) return;
  const artifact = workflow.artifacts.filter((entry) => entry.type === "plan").at(-1);
  if (artifact === undefined || workflow.e2e.contractDigest !== artifact.sha256) return;
  const approved = await loadWorkflowDocument((key, maxBytes) => readStoredText(dependencies.s3, dependencies.artifactBucketName, key, maxBytes), artifact, {});
  if (approved?.format !== "structured" || approved.plan.e2e?.schemaVersion !== 2) return;
  const current = await requireApplicationSelectionStillCurrent(dependencies, task, approved.plan.e2e, artifact);
  // Task 4.2: a round with an agent step is refused here, before compute is woken, when its route is no longer the installation's or the project's day has no room. The dispatch
  // checks it again once the round is being admitted (`startApplicationE2EChecksDispatch`).
  await requireAgentRouteStillCurrent(dependencies, await orgOfRecord(dependencies, task), task.project, approved.plan.e2e, E2EPolicySchema.parse(current.inputs.policy));
  if (workflow.candidate === undefined) return;
  const source = await candidateSourceOperation(dependencies, task, workflow.candidate.digest);
  if (source === undefined) throw applicationRoundRefusal(NO_COMMITTED_EXPORT_REASON);
  readyCandidateBuildSource(source, workflow.candidate.digest);
}

/** The exported build source manifest, read back and held to the digest and size the broker recorded when it judged it. */
async function readCandidateBuildSourceManifest(dependencies: AwsBrokerDependencies, stored: Extract<StoredCandidateBuildSource, { status: "READY" }>) {
  let bytes: Buffer | undefined;
  try {
    const response = await dependencies.s3.send(new GetObjectCommand({ Bucket: dependencies.artifactBucketName, Key: stored.manifestRef.key,
      Range: `bytes=0-${E2E_APPLICATION_BUILD_SOURCE_MANIFEST_MAX_BYTES - 1}` })) as { Body?: { transformToByteArray(): Promise<Uint8Array> } };
    bytes = response.Body === undefined ? undefined : Buffer.from(await response.Body.transformToByteArray());
  } catch (error) {
    const name = error && typeof error === "object" ? (error as { name?: unknown }).name : undefined;
    const status = error && typeof error === "object" ? (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode : undefined;
    if (name !== "NoSuchKey" && status !== 404) throw error;
  }
  if (bytes === undefined) throw applicationRoundRefusal("the exported build source manifest is missing from storage");
  if (bytes.byteLength !== stored.manifestRef.byteLength || createHash("sha256").update(bytes).digest("hex") !== stored.manifestRef.sha256) {
    throw applicationRoundRefusal("the stored build source manifest does not match the digest recorded for it");
  }
  let json: unknown;
  try { json = JSON.parse(bytes.toString("utf8")) as unknown; } catch { throw applicationRoundRefusal("the stored build source manifest is not valid JSON"); }
  const manifest = E2EApplicationBuildSourceManifestSchema.safeParse(json);
  if (!manifest.success) throw applicationRoundRefusal(`the stored build source manifest is not valid: ${manifest.error.issues[0]?.message ?? "unreadable"}`);
  if (manifest.data.manifestDigest !== stored.manifestDigest) throw applicationRoundRefusal("the stored build source manifest is not the one the record names");
  return manifest.data;
}

/** Stores an admission under its content address; an object already there must be the same bytes. */
async function storeWorkflowE2EAdmission(dependencies: AwsBrokerDependencies, input: { key: string; sha256: string; bytes: Buffer; taskId: string; candidateDigest: string }): Promise<void> {
  if (input.bytes.byteLength > WORKFLOW_E2E_ADMISSION_MAX_BYTES) throw agentXError("CONFIG_INVALID", "the immutable E2E admission exceeds its bounded object size");
  try {
    await dependencies.s3.send(new PutObjectCommand({ Bucket: dependencies.artifactBucketName, Key: input.key,
      Body: input.bytes, ContentType: "application/json", Metadata: { sha256: input.sha256, task: input.taskId, candidate: input.candidateDigest }, IfNoneMatch: "*" }));
  } catch (error) {
    const status = error && typeof error === "object" ? (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode : undefined;
    if (status !== 412 && (error as { name?: unknown } | undefined)?.name !== "PreconditionFailed") throw error;
    if (await readStoredText(dependencies.s3, dependencies.artifactBucketName, input.key, input.bytes.byteLength + 1) !== input.bytes.toString("utf8")) {
      throw agentXError("RUNTIME_UNAVAILABLE", "the content-addressed E2E admission object conflicts with its digest");
    }
  }
}

/**
 * AI navigation steps call a model provider with the installation's own credentials; the only meter is the project's day budget, and none of it is charged to the org's
 * spend ledger or held to its limits. So a cloud install refuses every round with an `agent` step until those calls are charged through the cloud spend ledger. Legacy and self-hosted
 * installs (no `cloud` flag) keep the day budget as their only meter.
 */
export const AI_NAVIGATION_NOT_ON_CLOUD = "ai-navigation-not-available: AI navigation steps are not available on Rovara Cloud yet, because their model calls are not yet charged to your organization's spend limits. The checks did not start; remove the AI navigation steps from the plan, or run them on a self-hosted install";

/**
 * Task 4.2, the dispatch half of the route registry. For a plan with an `agent` step: the route is derived from the installation's worker settings again and must be the one the
 * project's policy pinned and the registry holds (any change of provider, model, secret ARN or OpenRouter policy is `model-route-changed-reapprove`; no usable route is
 * `agent-route-not-approved`), and the project's UTC day must have room for the round's worst case (`model-route-budget-exhausted`, before anything starts). Each is a terminal
 * refusal that blocks the workflow with its code and a plain sentence. A plan with no agent step is not judged here. Returns whether the plan has an agent step.
 */
export async function requireAgentRouteStillCurrent(dependencies: AwsBrokerDependencies, orgId: OrgId, projectName: string, intent: E2EApplicationPlanIntent, policy: ReturnType<typeof E2EPolicySchema.parse>): Promise<boolean> {
  const agentSteps = intent.scenarios.reduce((total, scenario) => total + scenario.steps.filter((step) => step.kind === "agent").length, 0);
  if (agentSteps === 0) return false;
  // Fail closed on a cloud install, before the route, the budget or any compute is looked at.
  if (dependencies.cloud === true) throw new ApplicationDispatchRefusal(AI_NAVIGATION_NOT_ON_CLOUD);
  const store = { documentClient: dependencies.documentClient, tableName: dependencies.tableName };
  // No round starts without the check. What cannot be read for a lasting reason (settings missing or denied, a malformed row) is a plain refusal with its code. A fault that a later
  // attempt can get past (throttling, a 5xx, a network error, a timeout) is rethrown, so the dispatch takes its ordinary bounded retry path and the task is not blocked.
  const unreadable = (what: string, error: unknown): Error => isTransientAwsFault(error) ? (error instanceof Error ? error : new Error(String(error)))
    : new ApplicationDispatchRefusal(`agent-route-not-approved: ${what} could not be read, so the AI navigation steps were not started. Retry the checks once it can be`);
  let installation: E2EAgentInstallation;
  try {
    if (dependencies.e2eAgentInstallation === undefined) throw new Error("not configured");
    installation = await dependencies.e2eAgentInstallation();
  } catch (error) { throw unreadable("The AI navigation settings of this installation", error); }
  let check: Awaited<ReturnType<typeof checkE2EAgentRouteCurrent>>;
  try { check = await checkE2EAgentRouteCurrent(store, installation, policy.modelRouteRevision); }
  catch (error) { throw unreadable("The approved AI navigation route", error); }
  if (!check.ok) throw new ApplicationDispatchRefusal(`${check.code}: ${check.detail}`);
  const derived = deriveE2EAgentRoute(installation);
  const budgets = derived.status === "available" ? derived.definition.budgets : E2E_MODEL_ROUTE_DEFAULT_BUDGETS;
  const calls = Math.min(budgets.maxModelCallsPerGroup, agentSteps * (budgets.maxActionsPerStep + budgets.extraModelCallsPerStep));
  const need = { calls, inputTokens: Math.min(budgets.maxInputTokensPerGroup, calls * budgets.maxInputTokens) };
  let room: boolean;
  try { room = await e2eDayBudgetRoom({ ...store, orgId, projectName, now: Date.now() }, need, { maxInputTokens: budgets.maxInputTokensPerProjectDay, maxCalls: budgets.maxCallsPerProjectDay }); }
  catch (error) { throw unreadable("The project's daily AI navigation budget", error); }
  if (!room) throw new ApplicationDispatchRefusal("model-route-budget-exhausted: This project's daily AI navigation budget is spent, so the checks did not start. They can run again tomorrow (UTC)");
  return true;
}

/**
 * Admits and starts one application round for an approved v2 plan: the selection is checked against what was approved (Ruling AL), the candidate's stored
 * export and build source are read and held to the candidate, the admission is built from them and the approved setup, and the one CHECKS operation that carries
 * exactly that one admission is started. Anything missing or disagreeing is a terminal refusal with its reason: never the portable path, never a retry loop.
 * The operation record keeps the round id, the per-group run ids and the admission reference; Task 2.4d verifies the round from them.
 */
async function startApplicationE2EChecksDispatch(
  dependencies: AwsBrokerDependencies,
  routeDependencies: Parameters<typeof startTaskWorkflowE2EChecksFromSystem>[0],
  input: { task: DeveloperTaskRecord; expected: { workflowRevision: number; candidateDigest: string }; caller: Parameters<typeof startTaskWorkflowReviewFromSystem>[3];
    intent: E2EApplicationPlanIntent; artifact: { id: string; sha256: string };
    approval: NonNullable<ReturnType<typeof resolveWorkflowE2ECanonicalApproval>> },
): Promise<"STARTED" | "DUPLICATE" | "STALE"> {
  const { task, expected, intent, artifact, approval } = input;
  const workflow = task.workflow!;
  const candidate = workflow.candidate!;
  const current = await requireApplicationSelectionStillCurrent(dependencies, task, intent, artifact);
  // Task 4.2: a round with an agent step runs only on the route the installation has now, and only while the project's day has room for its worst case.
  const usesAgentSteps = await requireAgentRouteStillCurrent(dependencies, await orgOfRecord(dependencies, task), task.project, intent, E2EPolicySchema.parse(current.inputs.policy));
  const sourceOperation = await candidateSourceOperation(dependencies, task, candidate.digest);
  if (sourceOperation === undefined) throw applicationRoundRefusal(NO_COMMITTED_EXPORT_REASON);
  const stored = readyCandidateBuildSource(sourceOperation, candidate.digest);
  const exportRecord = await getItem<Record<string, unknown>>(dependencies, { pk: `WORKSPACE#${task.workspaceId}`, sk: `CANDIDATE_EXPORT#${sourceOperation.id}` });
  if (exportRecord === undefined || canonicalJson(exportRecord.buildSource ?? null) !== canonicalJson(stored)) {
    throw applicationRoundRefusal("the candidate's build source record on its export and on its operation are missing or disagree");
  }
  const sourceExport = await loadWorkflowCandidateSourceExport(dependencies, sourceOperation, candidate);
  if (sourceExport === undefined || sourceExport.repositories.length !== 1) throw applicationRoundRefusal("the stored candidate source export is unavailable or does not hold exactly one repository");
  const repository = sourceExport.repositories[0]!;
  if (stored.repositoryId !== repository.repositoryId || stored.commitSha !== repository.commitSha || stored.treeSha !== repository.treeSha) {
    throw applicationRoundRefusal("the stored build source is for another commit or tree than the exported candidate");
  }
  const manifest = await readCandidateBuildSourceManifest(dependencies, stored);
  const snapshot: E2ESourceSnapshot = { candidate, commitSha: repository.commitSha, treeSha: repository.treeSha, treeComplete: true, treePaths: repository.treePaths,
    sources: repository.sources.map((source) => ({ path: source.path, sha256: source.sha256, kind: "blob" as const, bytes: Buffer.from(source.bytesBase64, "base64") })) };
  // The original creator's current project access, once more now that compute is ready; the admission keeps the proof, and verification holds the round to it.
  const creatorAuthority = await requireWorkflowE2ECreatorAuthority(dependencies, task);
  const workspace = await routeDependencies.actions.workspace(task.workspaceId);
  const operationId = randomUUID();
  const planDigest = applicationApprovedPlanDigest(task.taskId, approval);
  const built = buildApplicationExecutionAdmission({ taskId: task.taskId, operationId, operationFence: workspace.fence + 1, workflowRevision: workflow.revision + 1, roundId: randomUUID(),
    runId: randomUUID, intent, artifact, snapshot, setupProposal: current.inputs.setup.setupProposal, setupApproval: current.inputs.setup.setupApproval, policy: current.inputs.policy,
    registeredRuntimes: current.inputs.rows, runtimeCatalogId: current.inputs.runtimeCatalogId, runtimeBinding: current.inputs.runtimeBinding,
    buildSource: { manifest, reference: candidateBuildSourceAdmissionReference(stored) }, planDigest, now: Date.now(), creatorAuthority, accountEntries: current.inputs.accountEntries,
    recordedSelection: E2EApplicationSelectionRecordSchema.parse(workflow.e2e?.applicationSelection) });
  const admissionRef = E2EWorkflowAdmissionRefSchema.parse({ schemaVersion: 1, kind: "application", ...(usesAgentSteps ? { agentSteps: true } : {}), taskId: task.taskId, workflowRevision: workflow.revision + 1, candidateDigest: candidate.digest,
    roundId: built.roundId, groupRunIds: built.groupRunIds, admissionRef: { key: `workflow-e2e-admissions/sha256/${built.sha256}.json`, sha256: built.sha256, byteLength: built.bytes.byteLength } });
  await storeWorkflowE2EAdmission(dependencies, { key: admissionRef.admissionRef.key, sha256: built.sha256, bytes: built.bytes, taskId: task.taskId, candidateDigest: candidate.digest });
  return startTaskWorkflowE2EChecksFromSystem(routeDependencies, task.taskId, expected, admissionRef, operationId, input.caller);
}

/** Why the checks stopped when the owner stopped the check on the unchanged code, and when that check would not stop. Both are plain sentences for the owner. */
const BASELINE_STOPPED_REASON = "The check on the unchanged code was stopped, so the checks were stopped with it. Retry the checks when you are ready.";
const BASELINE_STUCK_REASON = "The check on the unchanged code did not stop in time and still holds the workspace, so the checks could not start. Retry the checks once it has stopped.";

/** How long a baseline round that ran out of time is waited for to stop (after it was marked and cancelled) before the candidate's CHECKS stop waiting for it. */
const BASELINE_HOLD_LIMIT_MS = 20 * 60_000;

/**
 * M1.3 Task 3.7b, owner decision D2: the baseline round runs before the candidate's CHECKS, on the same ready compute (a workspace runs one operation at a time, so the two cannot
 * overlap). The candidate's CHECKS dispatch asks here first. The answer is:
 *  - WAIT: the baseline is being started or is running within its time, or was cancelled for running out of it and has not stopped yet (for a while only);
 *  - GO: anything else (recorded, could not run, never asked for, whatever went wrong with it): the candidate goes on, because a baseline never gates;
 *  - STOPPED: the owner stopped the baseline, which stops the whole CHECKS step with it, as a Stop of the candidate's round does;
 *  - STUCK: the baseline ran out of time, was cancelled, and still holds the workspace after the wait. The candidate goes on and tries to start; if the workspace is still busy
 *    the dispatch is blocked with a reason that names the baseline, and the busy workspace does not spend the dispatch's attempts.
 * A started record whose deadline cannot be read is late (it fails open).
 */
async function runBaselineRoundFirst(
  dependencies: AwsBrokerDependencies,
  routeDependencies: Parameters<typeof startTaskWorkflowE2EChecksFromSystem>[0],
  input: { task: DeveloperTaskRecord; caller: Parameters<typeof startTaskWorkflowReviewFromSystem>[3]; intent: E2EApplicationPlanIntent; artifact: { id: string; sha256: string };
    approval: NonNullable<ReturnType<typeof resolveWorkflowE2ECanonicalApproval>> },
): Promise<"WAIT" | "GO" | "STOPPED" | "STUCK"> {
  const { task } = input;
  const store = { documentClient: dependencies.documentClient, tableName: dependencies.tableName };
  try {
    const record = await readWorkflowE2EBaselineRecord(store, task);
    if (record === undefined || record.state === "RECORDED") return "GO";
    if (record.state === "REQUESTED") return await startBaselineApplicationRound(dependencies, routeDependencies, { ...input, record });
    const operation = record.operationId === undefined ? undefined : await getItem<OperationRecord>(dependencies, operationKey(task.workspaceId, record.operationId));
    // An operation whose cancel failed ends INTERRUPTED but keeps its workspace, as it might still run: where the workspace still names it as active, it did not stop, so it is
    // stuck exactly as one that never confirmed its cancel (the candidate then tries, and a busy or not-ready workspace blocks the dispatch with the reason that names it).
    if (operation?.status === "INTERRUPTED" && (record.state === "STARTED" || record.state === "UNAVAILABLE")) {
      const holder = await requireWorkspace(dependencies, task.workspaceId);
      if (holder.activeOperationId === operation.id) {
        await markWorkflowE2EBaselineUnavailable(store, task, "cancel-unconfirmed", { from: ["STARTED", "UNAVAILABLE"], operationId: operation.id });
        return "STUCK";
      }
    }
    if (operation === undefined || TERMINAL.has(operation.status)) {
      if (record.state === "STARTED") {
        // Its operation has ended but the record was not settled (the settling is best effort): settle it now. Settling twice is harmless.
        if (operation?.status === "SUCCEEDED") { await settleBaselineRound(dependencies, operation, "SUCCEEDED"); return "GO"; }
        // Cancelled while the record still said it was running: nobody but its owner (or a Stop from Slack) did that, since the system marks the record before it cancels.
        const cancelled = operation?.status === "CANCELLED";
        await markWorkflowE2EBaselineUnavailable(store, task, "run-failed", { from: ["STARTED"], ...(record.operationId === undefined ? {} : { operationId: record.operationId }) });
        return cancelled ? "STOPPED" : "GO";
      }
      if (record.state === "UNAVAILABLE" && record.reason === "stopped") {
        // The result callback recorded the Stop; it stops the step once, and a retry of the checks then goes on.
        return await markWorkflowE2EBaselineUnavailable(store, task, "run-failed", { from: ["UNAVAILABLE"], ...(record.operationId === undefined ? {} : { operationId: record.operationId }) }) ? "STOPPED" : "GO";
      }
      return "GO";
    }
    // The operation is still going. Within its time, it is waited for.
    const timeUp = Date.parse(record.deadlineAt ?? "") + E2E_BASELINE_RUN_GRACE_MS;
    if (record.state === "STARTED" && Number.isFinite(timeUp) && Date.now() <= timeUp) return "WAIT";
    if (record.state === "STARTED") await markWorkflowE2EBaselineUnavailable(store, task, "timed-out", { from: ["STARTED"], operationId: operation.id });
    // Past its time: the round is dead or stuck. Ask for it to be cancelled, so the workspace is free for the candidate, and wait for the worker to say so, for a while only.
    // A marked record whose time cannot be read is past the hold (it fails open, as an unreadable deadline does): it is never waited on.
    const markedAt = record.state === "UNAVAILABLE" ? Date.parse(record.recordedAt ?? "") : Number.NaN;
    if (record.state === "UNAVAILABLE" && (!Number.isFinite(markedAt) || Date.now() - markedAt > BASELINE_HOLD_LIMIT_MS)) {
      await markWorkflowE2EBaselineUnavailable(store, task, "cancel-unconfirmed", { from: ["UNAVAILABLE"], operationId: operation.id });
      return "STUCK";
    }
    const workspace = await requireWorkspace(dependencies, task.workspaceId);
    if (workspace.activeOperationId === operation.id && operation.status !== "CANCEL_REQUESTED") await requestCancellation(dependencies, workspace, operation.id, {});
    return "WAIT";
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "workflow.e2e_baseline_dispatch_failed", taskId: task.taskId, errorName: error instanceof Error ? error.name : "unknown" }));
    return "GO";
  }
}

/** The base commit the task pinned for its one repository: the workflow's pinned base, else the base the candidate recorded. */
function pinnedBaseCommitOf(task: DeveloperTaskRecord): { repositoryId: string; baseCommitSha: string } | undefined {
  const candidate = task.workflow?.candidate;
  if (candidate === undefined || candidate.repositories.length !== 1) return undefined;
  const repositoryId = candidate.repositories[0]!.repositoryId;
  const baseCommitSha = task.workflow?.reviewBase?.find((entry) => entry.repositoryId === repositoryId)?.baseCommitSha ?? candidate.repositories[0]!.baseCommitSha;
  return baseCommitSha === undefined ? undefined : { repositoryId, baseCommitSha };
}

/**
 * Starts the baseline round: the unchanged code the coding run exported (held to the base the task pinned), an admission built from it with the same code as a candidate's and
 * signed as a baseline, and the one CHECKS operation that carries exactly that admission, with the record's own start in the same transaction. Anything missing or disagreeing
 * leaves the record saying the unchanged code could not be checked, and the candidate goes on.
 */
async function startBaselineApplicationRound(
  dependencies: AwsBrokerDependencies,
  routeDependencies: Parameters<typeof startTaskWorkflowE2EChecksFromSystem>[0],
  input: { task: DeveloperTaskRecord; caller: Parameters<typeof startTaskWorkflowReviewFromSystem>[3]; intent: E2EApplicationPlanIntent; artifact: { id: string; sha256: string };
    approval: NonNullable<ReturnType<typeof resolveWorkflowE2ECanonicalApproval>>; record: BaselineRecord },
): Promise<"WAIT" | "GO"> {
  const { task, intent, artifact, approval } = input;
  const workflow = task.workflow!;
  const candidate = workflow.candidate!;
  const store = { documentClient: dependencies.documentClient, tableName: dependencies.tableName };
  const unavailable = async (reason: BaselineUnavailableReason): Promise<"GO"> => {
    await markWorkflowE2EBaselineUnavailable(store, task, reason, { from: ["REQUESTED"] });
    return "GO";
  };
  const sourceOperation = await candidateSourceOperation(dependencies, task, candidate.digest);
  const exported = StoredBaselineSourceSchema.safeParse(sourceOperation?.baselineSource);
  if (!exported.success) return unavailable("not-exported");
  if (exported.data.status === "REFUSED") return unavailable("refused");
  const stored: ReadyBaselineSource = exported.data;
  const pinned = pinnedBaseCommitOf(task);
  if (pinned === undefined || stored.repositoryId !== pinned.repositoryId || stored.baseCommitSha !== pinned.baseCommitSha || stored.buildSource.commitSha !== stored.baseCommitSha
    || stored.buildSource.treeSha !== stored.baseTreeSha) return unavailable("refused");
  try {
    // The base commit is the task's real one (GitHub has it, and it is pinned); the tree the worker exported for it is held to GitHub's tree for that commit, so a worker cannot label
    // other code as the unchanged code. Where the broker cannot ask GitHub, the exported tree is the worker's word, and it only ever shapes informational rows.
    if (dependencies.githubPullRequests.getCommitTree !== undefined) {
      const project = await requireRecordProject(dependencies, task, task.project, task.startingRevision);
      const url = project.definition.repositories.find((entry) => entry.name === stored.repositoryId)?.url;
      if (url === undefined || await dependencies.githubPullRequests.getCommitTree(url, stored.baseCommitSha, githubScope(dependencies, await orgOfRecord(dependencies, task))) !== stored.baseTreeSha) return await unavailable("refused");
    }
    const sourceBytes = await readStoredBytes(dependencies, stored.sourceRef.key, MAX_WORKFLOW_CANDIDATE_EXPORT_BYTES);
    if (sourceBytes === undefined || sourceBytes.byteLength !== stored.sourceRef.byteLength || createHash("sha256").update(sourceBytes).digest("hex") !== stored.sourceRef.sha256) return await unavailable("refused");
    const exportedSource = parseBaselineExport(sourceBytes);
    const repository = exportedSource.repositories[0]!;
    if (repository.commitSha !== stored.baseCommitSha || repository.treeSha !== stored.baseTreeSha || exportedSource.candidate.digest !== stored.sourceRef.candidateDigest) return await unavailable("refused");
    const manifest = await readCandidateBuildSourceManifest(dependencies, stored.buildSource);
    const snapshot: E2ESourceSnapshot = { candidate: exportedSource.candidate, commitSha: repository.commitSha, treeSha: repository.treeSha, treeComplete: true, treePaths: repository.treePaths,
      sources: repository.sources.map((source) => ({ path: source.path, sha256: source.sha256, kind: "blob" as const, bytes: Buffer.from(source.bytesBase64, "base64") })) };
    const current = await requireApplicationSelectionStillCurrent(dependencies, task, intent, artifact);
    const creatorAuthority = await requireWorkflowE2ECreatorAuthority(dependencies, task);
    const workspace = await routeDependencies.actions.workspace(task.workspaceId);
    const operationId = randomUUID();
    const planDigest = createHash("sha256").update(canonicalJson({
      domain: "workflow-application-e2e-baseline-plan/v1", taskId: task.taskId, artifactId: approval.artifactId, artifactSha256: approval.artifactDigest,
      graphDigest: approval.graphDigest, graphRunId: approval.runId, workflowRevision: approval.workflowRevision, actorId: approval.actorId, baseCommitSha: stored.baseCommitSha,
    })).digest("hex");
    const built = buildApplicationExecutionAdmission({ taskId: task.taskId, operationId, operationFence: workspace.fence + 1, workflowRevision: workflow.revision, roundId: randomUUID(),
      runId: randomUUID, intent, artifact, snapshot, setupProposal: current.inputs.setup.setupProposal, setupApproval: current.inputs.setup.setupApproval, policy: current.inputs.policy,
      registeredRuntimes: current.inputs.rows, runtimeCatalogId: current.inputs.runtimeCatalogId, runtimeBinding: current.inputs.runtimeBinding,
      buildSource: { manifest, reference: candidateBuildSourceAdmissionReference(stored.buildSource) }, planDigest, now: Date.now(), creatorAuthority, accountEntries: current.inputs.accountEntries,
      recordedSelection: E2EApplicationSelectionRecordSchema.parse(workflow.e2e?.applicationSelection), baseline: { baseCommitSha: stored.baseCommitSha, attempt: E2E_BASELINE_ATTEMPT } });
    const admissionRef = E2EWorkflowAdmissionRefSchema.parse({ schemaVersion: 1, kind: "application", taskId: task.taskId, workflowRevision: workflow.revision, candidateDigest: built.admission.candidateDigest,
      roundId: built.roundId, groupRunIds: built.groupRunIds, admissionRef: { key: `workflow-e2e-admissions/sha256/${built.sha256}.json`, sha256: built.sha256, byteLength: built.bytes.byteLength },
      purpose: E2E_BASELINE_PURPOSE, baseCommitSha: stored.baseCommitSha, attempt: E2E_BASELINE_ATTEMPT });
    await storeWorkflowE2EAdmission(dependencies, { key: admissionRef.admissionRef.key, sha256: built.sha256, bytes: built.bytes, taskId: task.taskId, candidateDigest: built.admission.candidateDigest });
    const outcome = await startTaskWorkflowE2EBaselineFromSystem(routeDependencies, task.taskId, { workflowRevision: workflow.revision, candidateDigest: candidate.digest }, admissionRef, operationId,
      [baselineStartItem(store, task, { baseCommitSha: stored.baseCommitSha, operationId, roundId: built.roundId, admissionSha256: built.sha256, startedAt: new Date().toISOString(), deadlineAt: built.admission.round.deadlineAt,
        skippedAiScenarios: [...built.skippedAiScenarios] })],
      input.caller);
    return outcome === "STALE" ? "GO" : "WAIT";
  } catch (error) {
    // The candidate goes on: its own dispatch makes the same checks and, for a plan that cannot run, blocks the workflow with the reason. The baseline only says it could not be checked.
    // A plan that is only AI navigation scenarios has nothing to run on the unchanged code (Ruling DD): that is said as its own reason, and it gates nothing.
    // AUTOREQUALIFY: a start refused by the hold fence is a deferral (the dispatch row stays due), not a baseline that could not be checked.
    if (error instanceof AgentXError && (error.code === "WORKSPACE_BUSY" || error.code === "WORKSPACE_NOT_READY") && await requalifyHoldActive(dependencies, Date.now()).catch(() => false)) throw error;
    const reason = baselineStartFailureReason(error);
    console.log(JSON.stringify({ component: "broker", event: "workflow.e2e_baseline_not_started", taskId: task.taskId, reason, errorName: error instanceof Error ? error.name : "unknown" }));
    return unavailable(reason);
  }
}

/**
 * T7b: starts one grounding round for a coding plan the task is holding back: the proposed plan's must-not-change scenarios (`groundingScenarioIds`) on the unchanged code the PLAN run
 * exported (held to the base the task pinned and to GitHub's tree for it), with an admission built from that code and signed as a grounding round, and the one CHECKS operation that
 * carries exactly that admission, with the record's own start in the same transaction. The selection is derived now for the proposed artifact in approve mode (nothing is reused at
 * approval, which derives its own). Anything missing or disagreeing leaves the record saying the plan could not be checked, with a fixed reason; it never throws for those, and it never
 * changes the workflow. Returns what happened so whoever holds the card back knows whether to wait for the round or post the card now.
 */
export async function startPlanGroundingRound(
  dependencies: AwsBrokerDependencies,
  routeDependencies: Parameters<typeof startTaskWorkflowE2EChecksFromSystem>[0],
  input: { task: DeveloperTaskRecord; caller: Parameters<typeof startTaskWorkflowReviewFromSystem>[3]; planOperationId: string; plan: PlanDocument; artifact: { id: string; sha256: string }; attempt?: number },
): Promise<{ outcome: "STARTED" | "DUPLICATE" | "STALE" } | { outcome: "UNAVAILABLE"; reason: GroundingUnavailableReason } | { outcome: "NOTHING_TO_GROUND" }> {
  const { task, plan, artifact } = input;
  const attempt = input.attempt ?? E2E_GROUNDING_ATTEMPT;
  const workflow = task.workflow!;
  const scenarioIds = groundingScenarioIds(plan);
  if (scenarioIds.length === 0) return { outcome: "NOTHING_TO_GROUND" };
  const store = { documentClient: dependencies.documentClient, tableName: dependencies.tableName };
  const ref = { taskId: task.taskId, planArtifactSha256: artifact.sha256, attempt };
  await requestWorkflowE2EGroundingRound(store, ref, { scenarioIds, planArtifactId: artifact.id });
  const existing = await readWorkflowE2EGroundingRecord(store, ref);
  if (existing === undefined) return { outcome: "UNAVAILABLE", reason: "start-failed" };
  if (existing.state !== "REQUESTED") return { outcome: "DUPLICATE" };
  const unavailable = async (reason: GroundingUnavailableReason): Promise<{ outcome: "UNAVAILABLE"; reason: GroundingUnavailableReason }> => {
    await markWorkflowE2EGroundingUnavailable(store, ref, reason, { from: ["REQUESTED"] });
    return { outcome: "UNAVAILABLE", reason };
  };
  try {
    const intent = plan.e2e;
    if (intent?.schemaVersion !== 2) return await unavailable("refused");
    const planOperation = await getItem<OperationRecord>(dependencies, operationKey(task.workspaceId, input.planOperationId));
    if (planOperation === undefined || planOperation.kind !== "task" || planOperation.workflowMode !== "PLAN" || planOperation.groundingSourceAsked !== true) return await unavailable("not-exported");
    const exported = StoredBaselineSourceSchema.safeParse(planOperation.baselineSource);
    if (!exported.success || exported.data.status === "REFUSED") return await unavailable("not-exported");
    const stored: ReadyBaselineSource = exported.data;
    const project = await requireRecordProject(dependencies, task, task.project, task.startingRevision);
    const repository = project.definition.repositories.length === 1 ? project.definition.repositories[0] : undefined;
    const pinned = repository === undefined ? undefined : (workflow.reviewBase ?? task.preparedBase)?.find((entry) => entry.repositoryId === repository.name);
    if (repository === undefined || pinned === undefined || stored.repositoryId !== pinned.repositoryId || stored.baseCommitSha !== pinned.baseCommitSha || stored.buildSource.commitSha !== stored.baseCommitSha
      || stored.buildSource.treeSha !== stored.baseTreeSha) return await unavailable("refused");
    // The exported tree is held to GitHub's tree for the pinned base, so a worker cannot label other code as the unchanged code (as the baseline round does).
    if (dependencies.githubPullRequests.getCommitTree !== undefined && await dependencies.githubPullRequests.getCommitTree(repository.url, stored.baseCommitSha, await githubScopeOf(dependencies, task)) !== stored.baseTreeSha) return await unavailable("refused");
    const sourceBytes = await readStoredBytes(dependencies, stored.sourceRef.key, MAX_WORKFLOW_CANDIDATE_EXPORT_BYTES);
    if (sourceBytes === undefined || sourceBytes.byteLength !== stored.sourceRef.byteLength || createHash("sha256").update(sourceBytes).digest("hex") !== stored.sourceRef.sha256) return await unavailable("refused");
    const exportedSource = parseBaselineExport(sourceBytes);
    const exportedRepository = exportedSource.repositories[0]!;
    if (exportedRepository.commitSha !== stored.baseCommitSha || exportedRepository.treeSha !== stored.baseTreeSha || exportedSource.candidate.digest !== stored.sourceRef.candidateDigest) return await unavailable("refused");
    const manifest = await readCandidateBuildSourceManifest(dependencies, stored.buildSource);
    const snapshot: E2ESourceSnapshot = { candidate: exportedSource.candidate, commitSha: exportedRepository.commitSha, treeSha: exportedRepository.treeSha, treeComplete: true, treePaths: exportedRepository.treePaths,
      sources: exportedRepository.sources.map((source) => ({ path: source.path, sha256: source.sha256, kind: "blob" as const, bytes: Buffer.from(source.bytesBase64, "base64") })) };
    // The selection for the proposed artifact, derived now in approve mode: the same derivation approval would make, kept nowhere but as a digest on the record.
    const derived = await evaluateWorkflowE2EApplicationSelectionNow(dependencies, task, intent, artifact, { mode: "approve", pinned: [] });
    if (!derived.ok) return await unavailable(derived.kind === "unevaluable" ? "start-failed" : derived.scope === "runtime" ? "runtime-not-ready" : derived.scope === "accounts" ? "accounts-not-ready" : "refused");
    const creatorAuthority = await requireWorkflowE2ECreatorAuthority(dependencies, task);
    const workspace = await routeDependencies.actions.workspace(task.workspaceId);
    const operationId = randomUUID();
    const built = buildApplicationGroundingAdmission({ taskId: task.taskId, operationId, operationFence: workspace.fence + 1, workflowRevision: workflow.revision, roundId: randomUUID(),
      runId: randomUUID, intent, artifact, planArtifactId: artifact.id, snapshot, setupProposal: derived.inputs.setup.setupProposal, setupApproval: derived.inputs.setup.setupApproval, policy: derived.inputs.policy,
      registeredRuntimes: derived.inputs.rows, runtimeCatalogId: derived.inputs.runtimeCatalogId, runtimeBinding: derived.inputs.runtimeBinding,
      buildSource: { manifest, reference: candidateBuildSourceAdmissionReference(stored.buildSource) }, now: Date.now(), creatorAuthority, accountEntries: derived.inputs.accountEntries,
      recordedSelection: derived.selection, grounding: { baseCommitSha: stored.baseCommitSha, attempt, scenarioIds } });
    const admissionRef = E2EWorkflowAdmissionRefSchema.parse({ schemaVersion: 1, kind: "application", taskId: task.taskId, workflowRevision: workflow.revision, candidateDigest: built.admission.candidateDigest,
      roundId: built.roundId, groupRunIds: built.groupRunIds, admissionRef: { key: `workflow-e2e-admissions/sha256/${built.sha256}.json`, sha256: built.sha256, byteLength: built.bytes.byteLength },
      purpose: E2E_GROUNDING_PURPOSE, baseCommitSha: stored.baseCommitSha, attempt, planArtifactSha256: artifact.sha256 });
    await storeWorkflowE2EAdmission(dependencies, { key: admissionRef.admissionRef.key, sha256: built.sha256, bytes: built.bytes, taskId: task.taskId, candidateDigest: built.admission.candidateDigest });
    const outcome = await startTaskWorkflowE2EGroundingFromSystem(routeDependencies, task.taskId, { workflowRevision: workflow.revision, planArtifactSha256: artifact.sha256 }, admissionRef, operationId,
      [groundingStartItem(store, ref, { baseCommitSha: stored.baseCommitSha, operationId, roundId: built.roundId, admissionSha256: built.sha256,
        selectionDigest: createHash("sha256").update(canonicalJson(derived.selection)).digest("hex"), startedAt: new Date().toISOString(), deadlineAt: built.admission.round.deadlineAt })],
      input.caller);
    if (outcome === "STALE") return await unavailable("start-failed");
    return { outcome };
  } catch (error) {
    // Only a fixed reason is kept; the error's text (it can name paths or accounts) is not logged.
    // A busy workspace is not a failed start: the record stays REQUESTED and the held plan's next look starts it again.
    if (error instanceof AgentXError && (error.code === "WORKSPACE_BUSY" || error.code === "WORKSPACE_NOT_READY")) throw error;
    const reason = groundingStartFailureReason(error);
    console.log(JSON.stringify({ component: "broker", event: "workflow.e2e_grounding_not_started", taskId: task.taskId, reason, errorName: error instanceof Error ? error.name : "unknown" }));
    return unavailable(reason);
  }
}

/**
 * M1.4 Task 4.6b: the operator's request to replay a verified AI-navigated round. Everything that can refuse refuses here, before a runner is started or anything is recorded:
 *
 *  - the task is open, and the round asked for is its qualified round, of its current candidate (`replay-task-closed`, `replay-not-qualified`);
 *  - no attempt of this round is still running, and the attempts have not run out (`replay-in-progress`, `replay-attempts-exhausted`);
 *  - the source round, loaded by the content addresses `qualifiedRound` binds and verified again by the broker with the registry's own route definition, is PASS (`replay-source-not-pass`),
 *    can be read (`replay-source-unavailable`) and left at least one recording the broker's review kept (`replay-no-recording`: every round from before the recordings was kept, and a
 *    round whose runtime would now run other cases than it ran then, are covered by the last two);
 *  - the candidate's exported source and the approved plan can be read and the admission builds (`replay-source-unavailable`).
 *
 * Then the admission is built from the same inputs a candidate round's is (the same candidate, plan, accounts and runtime rows, read now), with no model route, and the one CHECKS
 * operation that carries exactly that admission is started, with the replay record's own start in the same transaction. The workflow is not touched: no revision, state, round or
 * qualification changes, and the candidate's verification, completion, send-back and publication all refuse a replay round.
 */
export async function startReplayApplicationRound(
  dependencies: AwsBrokerDependencies,
  routeDependencies: Parameters<typeof startTaskWorkflowE2EChecksFromSystem>[0],
  input: { task: DeveloperTaskRecord; sourceRoundId: string; admin: { issuer: string; subject: string; ownerKey: string; displayName?: string } },
): Promise<{ sourceRoundId: string; attempt: number; operationId: string; roundId: string; state: "STARTED" }> {
  const { task, sourceRoundId } = input;
  const refuse = (code: E2EReplayRefusal, detail: string) => agentXError(code === "replay-in-progress" ? "TASK_BUSY" : "CONFIG_INVALID", `${code}: ${detail}`);
  const store = { documentClient: dependencies.documentClient, tableName: dependencies.tableName };
  if (task.closedAt !== undefined) throw refuse("replay-task-closed", "the task is closed");
  await assertNoRequalifyHold(store, Date.now()); // AUTOREQUALIFY: no replay starts while the test machine is being switched (the start transaction holds the same fence)
  const workflow = task.workflow;
  const qualified = workflow?.e2e?.required === true ? workflow.e2e.qualifiedRound : undefined;
  if (workflow === undefined || qualified === undefined || qualified.roundId !== sourceRoundId) throw refuse("replay-not-qualified", "that round is not the task's qualified round");
  const candidate = workflow.candidate;
  if (candidate === undefined || candidate.digest !== qualified.candidateDigest) throw refuse("replay-source-unavailable", "the task's candidate is no longer the one that was qualified");

  // Attempts: one at a time, a few in all. A record that never got going (or whose run ran out of time) does not hold the next one.
  const records = await listWorkflowE2EReplayRecords(store, task.taskId, sourceRoundId);
  const latest = records.at(-1);
  if (latest !== undefined) {
    const lapsed = latest.state === "REQUESTED" ? Date.now() - Date.parse(latest.requestedAt) > REPLAY_REQUEST_GRACE_MS
      : latest.state === "STARTED" && Date.now() > Date.parse(latest.deadlineAt ?? "") + E2E_REPLAY_RUN_GRACE_MS;
    if ((latest.state === "REQUESTED" || latest.state === "STARTED") && !lapsed) throw refuse("replay-in-progress", "a replay of this round is still running");
    if (lapsed) await markWorkflowE2EReplayUnavailable(store, task, { sourceRoundId, attempt: latest.attempt }, latest.state === "REQUESTED" ? "start-failed" : "timed-out", { from: [latest.state as "REQUESTED" | "STARTED"] });
  }
  // The attempt number is the next unused one; the cap counts the attempts that got going. A start that was refused before anything ran (the record says `start-failed`, or the request
  // that lapsed just now) used no runner and spent nothing, so it does not count (Task FU2, REPLAYCAP); the records those leave are bounded on their own.
  const attempt = (latest?.attempt ?? 0) + 1;
  const neverRan = (record: ReplayRecord) => (record.state === "UNAVAILABLE" && record.reason === "start-failed") || (record === latest && record.state === "REQUESTED");
  const ran = records.filter((record) => !neverRan(record)).length;
  if (ran >= E2E_REPLAY_ATTEMPTS_MAX || records.length >= E2E_REPLAY_RECORDS_MAX || attempt > E2E_REPLAY_RECORDS_MAX) throw refuse("replay-attempts-exhausted", `a round is replayed at most ${E2E_REPLAY_ATTEMPTS_MAX} times`);

  // The source round, verified again by the broker.
  const source = await reverifyQualifiedRound(dependencies, task, qualified);
  if ("refusal" in source) throw refuse(source.refusal, source.detail);

  // The admission: the same inputs a candidate round's is built from, read now. A candidate whose inputs cannot be read, or that would now run other cases, cannot be replayed.
  let built: ReturnType<typeof buildApplicationExecutionAdmission>;
  let operationId: string;
  try {
    const artifact = workflow.artifacts.filter((entry) => entry.type === "plan").at(-1);
    if (artifact === undefined || workflow.e2e?.contractDigest !== artifact.sha256) throw applicationRoundRefusal("the approved plan is no longer the one that was qualified");
    const approved = await loadWorkflowDocument((key, maxBytes) => readStoredText(dependencies.s3, dependencies.artifactBucketName, key, maxBytes), artifact, {});
    if (approved?.format !== "structured" || approved.plan.e2e?.schemaVersion !== 2) throw applicationRoundRefusal("the approved plan is not an application plan");
    const canonicalApproval = resolveWorkflowE2ECanonicalApproval({ taskId: task.taskId,
      workflow: workflow as NonNullable<typeof workflow> & { artifacts: Array<{ id: string; type: string; sha256: string }>;
        decisions: Array<{ decision: string; actorId: string; artifactDigest?: string; workBreakdownDigest?: string; workflowRevision: number }> },
      artifact, plan: approved.plan });
    if (canonicalApproval === undefined) throw applicationRoundRefusal("the approved plan's approval cannot be read");
    const intent = approved.plan.e2e;
    const current = await requireApplicationSelectionStillCurrent(dependencies, task, intent, artifact);
    if (replayPredatesRenewal(source.admittedRuntimes, current.inputs.rows)) throw refuse("replay-runtime-renewed", E2E_OWNER_SENTENCES.replayRuntimeRenewed);
    const sourceOperation = await candidateSourceOperation(dependencies, task, candidate.digest);
    if (sourceOperation === undefined) throw applicationRoundRefusal(NO_COMMITTED_EXPORT_REASON);
    const stored = readyCandidateBuildSource(sourceOperation, candidate.digest);
    const sourceExport = await loadWorkflowCandidateSourceExport(dependencies, sourceOperation, candidate);
    if (sourceExport === undefined || sourceExport.repositories.length !== 1) throw applicationRoundRefusal("the stored candidate source export is unavailable or does not hold exactly one repository");
    const repository = sourceExport.repositories[0]!;
    if (stored.repositoryId !== repository.repositoryId || stored.commitSha !== repository.commitSha || stored.treeSha !== repository.treeSha) {
      throw applicationRoundRefusal("the stored build source is for another commit or tree than the exported candidate");
    }
    const manifest = await readCandidateBuildSourceManifest(dependencies, stored);
    const snapshot: E2ESourceSnapshot = { candidate, commitSha: repository.commitSha, treeSha: repository.treeSha, treeComplete: true, treePaths: repository.treePaths,
      sources: repository.sources.map((item) => ({ path: item.path, sha256: item.sha256, kind: "blob" as const, bytes: Buffer.from(item.bytesBase64, "base64") })) };
    const creatorAuthority = await requireWorkflowE2ECreatorAuthority(dependencies, task);
    const workspace = await routeDependencies.actions.workspace(task.workspaceId);
    operationId = randomUUID();
    built = buildApplicationReplayAdmission({ taskId: task.taskId, operationId, operationFence: workspace.fence + 1, workflowRevision: workflow.revision, roundId: randomUUID(),
      runId: randomUUID, intent, artifact, snapshot, setupProposal: current.inputs.setup.setupProposal, setupApproval: current.inputs.setup.setupApproval, policy: current.inputs.policy,
      registeredRuntimes: current.inputs.rows, runtimeCatalogId: current.inputs.runtimeCatalogId, runtimeBinding: current.inputs.runtimeBinding,
      buildSource: { manifest, reference: candidateBuildSourceAdmissionReference(stored) }, approval: canonicalApproval, now: Date.now(), creatorAuthority, accountEntries: current.inputs.accountEntries,
      recordedSelection: E2EApplicationSelectionRecordSchema.parse(workflow.e2e?.applicationSelection),
      replay: { sourceRoundId, sourceAdmissionSha256: qualified.admissionSha256, sourceEvidenceSha256: qualified.evidenceSha256, attempt, sourceCases: source.sourceCases,
        traces: source.traces.map((trace) => ({ caseId: trace.caseId, stepIndex: trace.stepIndex, keyHash: trace.keyHash, traceBase64: Buffer.from(trace.bytes).toString("base64"), binding: trace.binding })) } });
  } catch (error) {
    // The admission could not be built from what the task holds now: nothing was started or recorded. A fault that a later attempt can get past is the operator's to retry.
    if (error instanceof ApplicationRuntimeRenewed) throw refuse("replay-runtime-renewed", E2E_OWNER_SENTENCES.replayRuntimeRenewed);
    if (error instanceof ApplicationDispatchRefusal || error instanceof ApplicationPlanDefect) throw refuse("replay-source-unavailable", error.message.replace(/\p{Cc}+/gu, " ").slice(0, 300));
    throw error;
  }

  // Past every refusal: the record is asked for (once per round and attempt), then the operation and the record's start commit together.
  if (await requestWorkflowE2EReplay(store, task, { sourceRoundId, attempt, requestedBy: input.admin.ownerKey }) === "ALREADY") throw refuse("replay-in-progress", "a replay of this round is already being started");
  // Who asked, for the audit trail (the administrator's owner key only; the task's developer is the task's owner, not the requester).
  console.log(JSON.stringify({ component: "broker", event: "workflow.e2e_replay_requested", taskId: task.taskId, sourceRoundId, attempt, adminOwnerKey: input.admin.ownerKey }));
  try {
    const admissionRef = E2EWorkflowAdmissionRefSchema.parse({ schemaVersion: 1, kind: "application", taskId: task.taskId, workflowRevision: workflow.revision, candidateDigest: candidate.digest,
      roundId: built.roundId, groupRunIds: built.groupRunIds, admissionRef: { key: `workflow-e2e-admissions/sha256/${built.sha256}.json`, sha256: built.sha256, byteLength: built.bytes.byteLength },
      purpose: E2E_REPLAY_PURPOSE, sourceRoundId, attempt });
    await storeWorkflowE2EAdmission(dependencies, { key: admissionRef.admissionRef.key, sha256: built.sha256, bytes: built.bytes, taskId: task.taskId, candidateDigest: candidate.digest });
    const outcome = await startTaskWorkflowE2EReplayFromSystem(routeDependencies, task.taskId, { sourceRoundId, candidateDigest: candidate.digest }, admissionRef, operationId,
      [replayStartItem(store, task, { sourceRoundId, attempt, operationId, roundId: built.roundId, admissionSha256: built.sha256, startedAt: new Date().toISOString(), deadlineAt: built.admission.round.deadlineAt })],
      { issuer: input.admin.issuer, subject: input.admin.subject, ...(input.admin.displayName === undefined ? {} : { displayName: input.admin.displayName }) });
    if (outcome === "STALE") {
      await markWorkflowE2EReplayUnavailable(store, task, { sourceRoundId, attempt }, "start-failed", { from: ["REQUESTED"] });
      throw refuse("replay-not-qualified", "the task moved on while the replay was being started");
    }
    return { sourceRoundId, attempt, operationId, roundId: built.roundId, state: "STARTED" };
  } catch (error) {
    // The operation was not started (a busy workspace, a fault): the record says so, and the operator asks again.
    await markWorkflowE2EReplayUnavailable(store, task, { sourceRoundId, attempt }, "start-failed", { from: ["REQUESTED"] }).catch(() => false);
    throw error;
  }
}

/** How long a replay that was asked for and never started holds the next attempt back. */
const REPLAY_REQUEST_GRACE_MS = 10 * 60_000;

/**
 * Loads the task's qualified round by the content addresses `qualifiedRound` binds (its admission and its evidence), verifies it again as the broker verified it, with the registry's own
 * definition of the round's route, and takes what the replay needs from that: the recordings its review kept and what each case showed. A refusal names the first thing that fails.
 */
async function reverifyQualifiedRound(dependencies: AwsBrokerDependencies, task: DeveloperTaskRecord, qualified: NonNullable<NonNullable<NonNullable<DeveloperTaskRecord["workflow"]>["e2e"]>["qualifiedRound"]>):
  Promise<{ sourceCases: E2EReplaySourceCase[]; traces: readonly VerifiedAgentTrace[]; admittedRuntimes: readonly E2ERegisteredRuntime[] } | { refusal: E2EReplayRefusal; detail: string }> {
  const unavailable = (detail: string) => ({ refusal: "replay-source-unavailable" as const, detail });
  try {
    const operation = (await queryAllItems(dependencies, `WORKSPACE#${task.workspaceId}`, "OPERATION#"))
      .filter((item) => item.entityType === "OPERATION" && item.kind === "task" && item.workflowMode === "CHECKS")
      .map((item) => item as unknown as OperationRecord)
      .filter((item) => item.status === "SUCCEEDED" && item.workflowE2EAdmission?.purpose === undefined && item.workflowE2EAdmission?.roundId === qualified.roundId
        && item.workflowE2EAdmission.admissionRef.sha256 === qualified.admissionSha256 && item.workflowE2EEvidenceRef?.sha256 === qualified.evidenceSha256)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    const reference = operation?.workflowE2EAdmission;
    if (operation === undefined || reference === undefined) return unavailable("the checks operation of the qualified round cannot be found");
    const text = await readStoredText(dependencies.s3, dependencies.artifactBucketName, reference.admissionRef.key, WORKFLOW_E2E_ADMISSION_MAX_BYTES);
    if (text === undefined) return unavailable("the qualified round's admission is unavailable");
    const admissionBytes = Buffer.from(text, "utf8");
    if (createHash("sha256").update(admissionBytes).digest("hex") !== qualified.admissionSha256 || admissionBytes.byteLength !== reference.admissionRef.byteLength) return unavailable("the qualified round's admission changed");
    let admission: E2EApplicationExecutionAdmission;
    try { admission = decodeE2EApplicationExecutionAdmission(admissionBytes); } catch { return unavailable("the qualified round's admission cannot be read"); }
    const loaded = await loadApplicationEvidenceInputs(dependencies, operation, reference, admission);
    if ("unavailable" in loaded) return unavailable("the qualified round's evidence cannot be read");
    const route = await modelRouteForAdmission((key) => getItem<Record<string, unknown>>(dependencies, key), admission);
    if ("unavailable" in route) return unavailable("the model route registry cannot be read");
    const verified = verifyApplicationE2EEvidence({ admissionBytes, subject: { taskId: task.taskId, operationId: operation.id, operationFence: operation.fence, workflowRevision: reference.workflowRevision,
      candidateDigest: qualified.candidateDigest, roundId: reference.roundId, groupRunIds: reference.groupRunIds, admissionSha256: reference.admissionRef.sha256 },
    aggregate: loaded.aggregate, groupEvidence: loaded.groupEvidence, receivedAt: loaded.receivedAt, terminalStatus: "SUCCEEDED", ...(route.definition === undefined ? {} : { modelRouteDefinition: route.definition }) });
    if (verified.verdict !== "PASS") return { refusal: "replay-source-not-pass" as const, detail: "the qualified round does not verify as PASS now" };
    const traces = verified.agentTraces ?? [];
    if (traces.length === 0) return { refusal: "replay-no-recording" as const, detail: "the qualified round left no recording to replay" };
    return { sourceCases: replaySourceCasesOf(verified), traces, admittedRuntimes: admission.runtimeBindings.map((item) => item.value) };
  } catch (error) {
    if (error instanceof ApplicationDispatchRefusal) return unavailable(error.message.slice(0, 300));
    if (isTransientAwsFault(error)) throw error;
    return unavailable("the qualified round could not be loaded");
  }
}

/** Creates the content-addressed admission and starts the separate current CHECKS operation. */
export async function startWorkflowE2EChecksDispatch(
  dependencies: AwsBrokerDependencies,
  routeDependencies: Parameters<typeof startTaskWorkflowE2EChecksFromSystem>[0],
  task: DeveloperTaskRecord,
  expected: { workflowRevision: number; candidateDigest: string },
  caller: Parameters<typeof startTaskWorkflowReviewFromSystem>[3],
): Promise<"STARTED" | "DUPLICATE" | "STALE" | "WAITING"> {
  const workflow = task.workflow;
  const candidate = workflow?.candidate;
  const catalogId = dependencies.e2eFeatureRuntimeCatalogId;
  if (workflow?.e2e?.required !== true || workflow.stage !== "VERIFY" || workflow.state !== "WAITING"
    || workflow.revision !== expected.workflowRevision || candidate?.digest !== expected.candidateDigest
    || catalogId === undefined || dependencies.projectSetupRuntimeCatalogId === undefined) {
    throw agentXError("RUNTIME_UNAVAILABLE", "the current approved feature E2E admission is unavailable");
  }
  const artifact = workflow.artifacts.filter((entry) => entry.type === "plan").at(-1);
  if (artifact === undefined || workflow.e2e.contractDigest !== artifact.sha256) {
    throw agentXError("RUNTIME_UNAVAILABLE", "the current canonical feature E2E plan is unavailable or stale");
  }
  const approved = await loadWorkflowDocument((key, maxBytes) => readStoredText(dependencies.s3, dependencies.artifactBucketName, key, maxBytes), artifact, {});
  if (approved?.format !== "structured") {
    throw agentXError("RUNTIME_UNAVAILABLE", "the canonical Owner-approved E2E intent is unavailable or stale");
  }
  const canonicalApproval = resolveWorkflowE2ECanonicalApproval({ taskId: task.taskId,
    workflow: workflow as NonNullable<typeof workflow> & { artifacts: Array<{ id: string; type: string; sha256: string }>;
      decisions: Array<{ decision: string; actorId: string; artifactDigest?: string; workBreakdownDigest?: string; workflowRevision: number }> },
    artifact, plan: approved.plan });
  if (canonicalApproval === undefined) {
    throw agentXError("RUNTIME_UNAVAILABLE", "the canonical Owner-approved E2E intent is unavailable or stale");
  }
  // An application (v2) intent is never dispatched through the portable path below: it has its own admission, and every way it can fail ends in a block.
  if (approved.plan.e2e?.schemaVersion === 2) {
    // M1.3 Task 3.7b: the informational baseline round runs first, on this same ready compute; the candidate's CHECKS wait for it (without spending the dispatch's attempts) or go on.
    const baseline = await runBaselineRoundFirst(dependencies, routeDependencies, { task, caller, intent: approved.plan.e2e, artifact, approval: canonicalApproval });
    if (baseline === "WAIT") return "WAITING";
    if (baseline === "STOPPED") throw new ApplicationDispatchRefusal(BASELINE_STOPPED_REASON);
    try {
      return await startApplicationE2EChecksDispatch(dependencies, routeDependencies, { task, expected, caller, intent: approved.plan.e2e, artifact, approval: canonicalApproval });
    } catch (error) {
      // The baseline would not stop and still holds the workspace: the candidate cannot start, and the reason says so instead of spending the dispatch's attempts on a busy workspace.
      if (baseline === "STUCK" && error instanceof AgentXError && (error.code === "WORKSPACE_BUSY" || error.code === "WORKSPACE_NOT_READY")) throw new ApplicationDispatchRefusal(BASELINE_STUCK_REASON);
      throw error;
    }
  }
  const portableIntent = portableFeatureIntentOf(approved.plan);
  if (!portableIntent.ok) {
    throw agentXError("RUNTIME_UNAVAILABLE", portableIntent.reason === "canonical-e2e-intent-missing"
      ? "the canonical E2E intent is unavailable" : "application E2E intents are not dispatched by the portable feature checks");
  }
  const e2eIntent = portableIntent.intent;
  const sourceOperation = await candidateSourceOperation(dependencies, task, candidate.digest);
  if (sourceOperation === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the current candidate has no first-party committed source export");
  const sourceExport = await loadWorkflowCandidateSourceExport(dependencies, sourceOperation, candidate);
  if (sourceExport === undefined || sourceExport.repositories.length !== 1) {
    throw agentXError("RUNTIME_UNAVAILABLE", "the current candidate source export is unavailable for portable feature checks");
  }
  const sourceRepository = sourceExport.repositories[0]!;
  const snapshot: E2ESourceSnapshot = {
    candidate, commitSha: sourceRepository.commitSha, treeSha: sourceRepository.treeSha,
    treeComplete: true, treePaths: sourceRepository.treePaths,
    sources: sourceRepository.sources.map((source) => ({ path: source.path, sha256: source.sha256, kind: "blob" as const, bytes: Buffer.from(source.bytesBase64, "base64") })),
  };
  const project = await requireRecordProject(dependencies, task, task.project, task.startingRevision);
  if (project.runtimeBinding.deploymentMode !== "ec2-ebs") throw agentXError("RUNTIME_UNAVAILABLE", "the qualified feature verifier binding is not an EC2 runtime");
  const policy = E2EPolicySchema.parse(project.definition.e2e);
  const featureRecord = await getItem<Record<string, unknown>>(dependencies, e2eFeatureVerifierKey(catalogId, policy.defaultSandboxProfileId));
  if (featureRecord === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the separately qualified feature verifier is unavailable");
  const planDigest = createHash("sha256").update(canonicalJson({
    domain: "workflow-feature-e2e-approved-plan/v1", taskId: task.taskId, artifactId: canonicalApproval.artifactId, artifactSha256: canonicalApproval.artifactDigest,
    graphDigest: canonicalApproval.graphDigest, graphRunId: canonicalApproval.runId, workflowRevision: canonicalApproval.workflowRevision, actorId: canonicalApproval.actorId,
  })).digest("hex");
  const featureAdmission = deriveE2EFeatureExecutionAdmission({
    intent: e2eIntent, snapshot, artifactId: artifact.id, artifactSha256: artifact.sha256, planDigest,
    policy, runtimeCatalogId: catalogId, runtimeBinding: project.runtimeBinding, featureVerifier: featureRecord, now: Date.now(),
  });
  const creatorAuthority = await requireWorkflowE2ECreatorAuthority(dependencies, task);
  const workspace = await routeDependencies.actions.workspace(task.workspaceId);
  const operationId = randomUUID();
  const fence = workspace.fence + 1;
  const workflowRevision = workflow.revision + 1;
  const roundId = randomUUID();
  const runIds = featureAdmission.plan.groups.map(() => randomUUID());
  const admittedAtMs = Date.now();
  const admittedAt = new Date(admittedAtMs).toISOString();
  const deadlineAt = new Date(admittedAtMs + policy.limits.runTimeoutMs).toISOString();
  const built = buildE2EFeatureRound({ admission: featureAdmission, taskId: task.taskId, operationId, operationFence: fence,
    workflowRevision, roundId, runIds, admittedAt, deadlineAt });
  const { sourceSnapshot: _selectionSourceSnapshot, ...storedSelectionInput } = featureAdmission.selectionInput;
  void _selectionSourceSnapshot;
  const admissionObject = {
    schemaVersion: "workflow-e2e-admission/v1", taskId: task.taskId, operationId, operationFence: fence, workflowRevision,
    candidateDigest: candidate.digest, sourceSnapshot: { ...snapshot, sources: snapshot.sources.map((source) => ({ path: source.path,
      sha256: source.sha256, kind: source.kind, bytesBase64: Buffer.from(source.bytes).toString("base64") })) },
    intent: e2eIntent, policy, runtime: featureAdmission.runtime, plan: featureAdmission.plan, bundle: featureAdmission.bundle,
    selectionInput: storedSelectionInput, portableApprovalBinding: featureAdmission.portableApprovalBinding, creatorAuthority,
    round: built.round, groupAdmissions: built.groupAdmissions,
  };
  const admissionBytes = Buffer.from(canonicalJson(admissionObject), "utf8");
  const admissionSha = createHash("sha256").update(admissionBytes).digest("hex");
  const admissionRef = E2EWorkflowAdmissionRefSchema.parse({ schemaVersion: 1, taskId: task.taskId, workflowRevision,
    candidateDigest: candidate.digest, roundId, groupRunIds: built.round.groupBindings.map((binding) => binding.runId),
    admissionRef: { key: `workflow-e2e-admissions/sha256/${admissionSha}.json`, sha256: admissionSha, byteLength: admissionBytes.byteLength } });
  await storeWorkflowE2EAdmission(dependencies, { key: admissionRef.admissionRef.key, sha256: admissionSha, bytes: admissionBytes, taskId: task.taskId, candidateDigest: candidate.digest });
  return startTaskWorkflowE2EChecksFromSystem(routeDependencies, task.taskId, expected, admissionRef, operationId, caller);
}

/** Run the task's dispatch rows right after the result that wrote them committed. Never throws. */
export function trackingPassDependencies(dependencies: AwsBrokerDependencies): Parameters<typeof runDueWorkflowMergeTracking>[0] {
  return {
    documentClient: dependencies.documentClient,
    tableName: dependencies.tableName,
    now: Date.now,
    reconcile: (taskId, budget) => reconcileWorkflowTrackingTask(dependencies, taskId, budget),
  };
}

/** The pass for rows a webhook woke (review-woken ones first of all): never throws, reads only woken rows, and does not move the heartbeat gate. */
export async function runWokenTrackingPass(dependencies: AwsBrokerDependencies, budgetMs: number): Promise<{ attempted: number; reconciled: number; deferred: number }> {
  try {
    return await runDueWorkflowMergeTracking(trackingPassDependencies(dependencies), { budgetMs, wokenOnly: true });
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "workflow.merge_tracking_woken_failed", error: error instanceof Error ? error.name : "unknown" }));
    return { attempted: 0, reconciled: 0, deferred: 0 };
  }
}

export async function dispatchWorkflowContinuation(dependencies: AwsBrokerDependencies, taskId: string): Promise<void> {
  try {
    const rows = await queryAllItems(dependencies, WORKFLOW_DISPATCH_PK, `${taskId}#`);
    for (const row of rows) await runWorkflowDispatch(dependencies, row as unknown as WorkflowDispatchRecord);
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "workflow.dispatch_failed", taskId, error: error instanceof Error ? error.name : "unknown" }));
  }
}

/** T7c: the marker partition of held plans (one small item per hold), read by the recovery sweep. */
export const PLAN_GROUNDING_HOLD_PK = "PLAN_GROUNDING_HOLD";

/**
 * T7c: the last resort for a held plan whose finish keeps failing: planning is stopped with its Retry (as a failed planning run would leave it), the hold, its row and its marker are removed
 * in one transaction conditioned on the hold. Never throws.
 */
export async function stopStuckGroundingHold(dependencies: AwsBrokerDependencies, taskId: string): Promise<void> {
  try {
    const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(taskId));
    const hold = task?.planGrounding;
    const workflow = task?.workflow;
    if (task === undefined || hold === undefined || workflow === undefined) {
      await dependencies.documentClient.send(new DeleteCommand({ TableName: dependencies.tableName, Key: { pk: PLAN_GROUNDING_HOLD_PK, sk: `TASK#${taskId}` } }));
      return;
    }
    const now = new Date().toISOString();
    const stopped = workflow.stage === "PLAN" && workflow.state === "RUNNING" && task.closedAt === undefined;
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Update: { TableName: dependencies.tableName, Key: taskKey(taskId),
        UpdateExpression: stopped ? "SET workflow = :workflow, updatedAt = :now REMOVE planGrounding, planGroundingAbandoned" : "REMOVE planGrounding, planGroundingAbandoned",
        ConditionExpression: "planGrounding.artifactSha256 = :held AND workflow.revision = :revision", ExpressionAttributeValues: { ":held": hold.artifactSha256, ":revision": workflow.revision,
          ...(stopped ? { ":workflow": blockWorkflow(workflow, workflowRunEndedReason("PLAN", "FAILED"), now), ":now": now } : {}) } } },
      { Delete: { TableName: dependencies.tableName, Key: { pk: WORKFLOW_DISPATCH_PK, sk: `${taskId}#${workflow.revision}` } } },
      { Delete: { TableName: dependencies.tableName, Key: { pk: PLAN_GROUNDING_HOLD_PK, sk: `TASK#${taskId}` } } },
    ] }));
  } catch (error) {
    if (!isConditional(error)) console.log(JSON.stringify({ component: "broker", event: "workflow.grounding_stop_failed", taskId, error: error instanceof Error ? error.name : "unknown" }));
  }
}

/** The sweep's look at the held plans: one past its deadline is finished (its row may be lost); one that cannot be finished long after that is stopped. Never throws. */
export async function sweepGroundingHolds(dependencies: AwsBrokerDependencies): Promise<void> {
  try {
    const holds = await queryAllItems(dependencies, PLAN_GROUNDING_HOLD_PK, "TASK#");
    for (const marker of holds) {
      const taskId = String(marker.taskId);
      const deadline = Date.parse(String(marker.deadlineAt));
      if (!Number.isFinite(deadline) || Date.now() < deadline) continue;
      try { await finishPlanGrounding(dependencies, taskId); } catch (error) {
        console.log(JSON.stringify({ component: "broker", event: "workflow.grounding_sweep_finish_failed", taskId, error: error instanceof Error ? error.name : "unknown" }));
        if (Date.now() > deadline + 30 * 60_000) await stopStuckGroundingHold(dependencies, taskId);
      }
    }
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "workflow.grounding_sweep_failed", error: error instanceof Error ? error.name : "unknown" }));
  }
}

/** T7c: how soon the held plan's check is looked at again while it runs. */
const GROUNDING_POLL_MS = 30_000;

/** Looks again at the held plan's row later: its due time moves, nothing else. */
async function pollGroundingLater(dependencies: AwsBrokerDependencies, item: WorkflowDispatchRecord): Promise<void> {
  const next = new Date(Date.now() + GROUNDING_POLL_MS).toISOString();
  try {
    await dependencies.documentClient.send(new UpdateCommand({ TableName: dependencies.tableName, Key: { pk: item.pk, sk: item.sk },
      UpdateExpression: "SET nextAttemptAt = :next, dispatchDueSk = :due", ConditionExpression: "attribute_exists(pk)", ExpressionAttributeValues: { ":next": next, ":due": `${next}#${item.sk}` } }));
  } catch (error) {
    if (!isConditional(error)) console.log(JSON.stringify({ component: "broker", event: "workflow.grounding_poll_failed", taskId: item.taskId, error: error instanceof Error ? error.name : "unknown" }));
  }
}

/**
 * T7c: one look at a held plan: start its check on the current app if it has not started, then try the one finish. "WAIT": the check is still running (the row stays and is looked at
 * again). "DONE": the hold ended (finished, or the task moved on). Never throws: whatever fails to start ends the hold through the one finish, as a plan that was not checked.
 */
export async function runGroundingStep(dependencies: AwsBrokerDependencies, routeDependencies: Parameters<typeof startTaskWorkflowE2EChecksFromSystem>[0],
  caller: Parameters<typeof startTaskWorkflowReviewFromSystem>[3], item: WorkflowDispatchRecord, task: DeveloperTaskRecord): Promise<"WAIT" | "DONE"> {
  const hold = task.planGrounding;
  if (hold === undefined) return "DONE";
  const store = { documentClient: dependencies.documentClient, tableName: dependencies.tableName };
  const abandoned = task.planGroundingAbandoned === hold.artifactSha256;
  // Only a read or the finish itself can fail outside the start; those errors go to the row's retry (bounded, and at its end the give-up finishes the hold), never into the round.
  const record = abandoned ? undefined : await readWorkflowE2EGroundingRecord(store, { taskId: task.taskId, planArtifactSha256: hold.artifactSha256, attempt: hold.attempt });
  if (!abandoned && (record === undefined || record.state === "REQUESTED")) {
    const entry = { id: hold.artifactId, type: "plan" as const, version: hold.version, sha256: hold.artifactSha256, producer: "agentx-worker-untrusted" as const,
      objectKey: `private/${task.ownerKey}/${task.workspaceId}/plan-documents/${hold.artifactId}.json`, createdAt: hold.artifactCreatedAt, format: "structured" as const };
    let plan: PlanDocument | undefined;
    try {
      const loaded = await loadWorkflowDocument((key, maxBytes) => readStoredText(dependencies.s3, dependencies.artifactBucketName, key, maxBytes), entry, {});
      if (loaded?.format === "structured") plan = loaded.plan;
    } catch { plan = undefined; }
    if (plan === undefined) return await finishThenWait(dependencies, item, task.taskId, "start-failed");
    try {
      await (dependencies.startPlanGrounding ?? startPlanGroundingRound)(dependencies, routeDependencies, { task, caller, planOperationId: hold.planOperationId, plan, artifact: { id: hold.artifactId, sha256: hold.artifactSha256 }, attempt: hold.attempt });
    } catch (error) {
      // A workspace that is busy for a moment is waited out (the finish ends the hold at its deadline); any other fault of the start ends the hold as a plan that could not be checked.
      if (error instanceof AgentXError && (error.code === "WORKSPACE_BUSY" || error.code === "WORKSPACE_NOT_READY")) return await finishThenWait(dependencies, item, task.taskId);
      console.log(JSON.stringify({ component: "broker", event: "workflow.grounding_step_failed", taskId: task.taskId, error: error instanceof AgentXError ? error.code : error instanceof Error ? error.name : "unknown" }));
      return await finishThenWait(dependencies, item, task.taskId, "start-failed");
    }
  }
  return await finishThenWait(dependencies, item, task.taskId);
}

async function finishThenWait(dependencies: AwsBrokerDependencies, item: WorkflowDispatchRecord, taskId: string, force?: GroundingUnavailableReason): Promise<"WAIT" | "DONE"> {
  const finished = await finishPlanGrounding(dependencies, taskId, force === undefined ? {} : { force });
  if (finished === "WAITING") { await pollGroundingLater(dependencies, item); return "WAIT"; }
  return "DONE";
}

/** After a grounding round's terminal result (settled, cancelled, lost): the one finish, if that round belongs to a held plan. Never throws. */
export async function finishGroundingForOperation(dependencies: AwsBrokerDependencies, operation: OperationRecord): Promise<void> {
  const reference = operation.workflowE2EAdmission;
  if (operation.kind !== "task" || reference?.purpose !== "grounding") return;
  try { await finishPlanGrounding(dependencies, reference.taskId); } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "workflow.grounding_finish_failed", taskId: reference.taskId, error: error instanceof Error ? error.name : "unknown" }));
  }
}

/**
 * T7c: THE one finish of a held plan, idempotent and conditioned on the hold it read. Every exit calls it: a settled round, a refused or failed start, the give-up, a lost delivery (the
 * row's next look), the deadline and a close. It reads the grounding record, then:
 *  - the task was closed or the owner closed it (`abandoned`): the hold is cleared and nobody is asked anything;
 *  - the check is still running and is not overdue: "WAITING", nothing changes;
 *  - otherwise the plan is read again from the planner's saved answer and stored with what the check found (a fixable mismatch with a revision left sends the planner back, once; otherwise
 *    the plan is submitted and its card posts as for any plan, with the findings or the "not checked" reason beside it). `force` ends a check that has not given a result with that reason.
 * "NOOP": no hold, or another finish got there first.
 */
export async function finishPlanGrounding(dependencies: AwsBrokerDependencies, taskId: string, options: { force?: GroundingUnavailableReason } = {}): Promise<"FINISHED" | "WAITING" | "NOOP"> {
  const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(taskId));
  const hold = task?.planGrounding;
  const workflow = task?.workflow;
  if (task === undefined || hold === undefined || workflow === undefined) return "NOOP";
  const rowKey = { pk: WORKFLOW_DISPATCH_PK, sk: `${taskId}#${workflow.revision}` };
  const holdCondition = "workflow.revision = :revision AND workflow.#stage = :plan AND workflow.#state = :running AND planGrounding.artifactSha256 = :held AND attribute_not_exists(closedAt)";
  const holdNames = { "#stage": "stage", "#state": "state" };
  const holdValues = { ":revision": workflow.revision, ":plan": "PLAN", ":running": "RUNNING", ":held": hold.artifactSha256 };
  const now = new Date().toISOString();
  if (task.closedAt !== undefined || workflow.stage !== "PLAN" || workflow.state !== "RUNNING") {
    // The task moved on (closed, or stopped to a block): the hold means nothing now and asks nobody anything; the dispatch run drops the row, and the marker goes so no sweep reads it again.
    await dependencies.documentClient.send(new DeleteCommand({ TableName: dependencies.tableName, Key: { pk: PLAN_GROUNDING_HOLD_PK, sk: `TASK#${taskId}` } }));
    return "NOOP";
  }
  const markerKey = { pk: PLAN_GROUNDING_HOLD_PK, sk: `TASK#${taskId}` };
  if (task.planGroundingAbandoned === hold.artifactSha256) {
    try {
      // The owner closed the task: nobody is asked anything, and planning is stopped (never left running with nothing running); the close goes on.
      await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
        { Update: { TableName: dependencies.tableName, Key: taskKey(taskId), UpdateExpression: "SET workflow = :stopped, updatedAt = :now REMOVE planGrounding, planGroundingAbandoned", ConditionExpression: holdCondition, ExpressionAttributeNames: holdNames,
          ExpressionAttributeValues: { ...holdValues, ":stopped": blockWorkflow(workflow, workflowRunEndedReason("PLAN", "CANCELLED"), now), ":now": now } } },
        { Delete: { TableName: dependencies.tableName, Key: rowKey } },
        { Delete: { TableName: dependencies.tableName, Key: markerKey } },
      ] }));
      return "FINISHED";
    } catch (error) { if (isConditional(error)) return "NOOP"; throw error; }
  }
  const store = { documentClient: dependencies.documentClient, tableName: dependencies.tableName };
  const ref = { taskId, planArtifactSha256: hold.artifactSha256, attempt: hold.attempt };
  let record = await readWorkflowE2EGroundingRecord(store, ref);
  const overdue = Date.now() >= Date.parse(hold.deadlineAt);
  const open = (candidate: GroundingRecord | undefined) => candidate === undefined || candidate.state === "REQUESTED" || candidate.state === "STARTED";
  if (open(record) && (options.force !== undefined || overdue || (record?.state === "STARTED" && groundingRoundLapsed(record, Date.now())))) {
    const reason: GroundingUnavailableReason = options.force ?? "timed-out";
    if (record !== undefined) {
      await markWorkflowE2EGroundingUnavailable(store, ref, reason, { from: ["REQUESTED", "STARTED"] });
      // A check still running past the hold's time is asked to stop, so it frees the workspace for what the owner does next. Best effort: a late result changes nothing.
      if (record.state === "STARTED" && record.operationId !== undefined) {
        try {
          const workspace = await requireWorkspace(dependencies, task.workspaceId);
          if (workspace.activeOperationId === record.operationId) await cancelRunningTask(dependencies, workspace, {});
        } catch (error) { console.log(JSON.stringify({ component: "broker", event: "workflow.grounding_cancel_failed", taskId, error: error instanceof Error ? error.name : "unknown" })); }
      }
      record = await readWorkflowE2EGroundingRecord(store, ref);
    }
  }
  let outcome: GroundingOutcome;
  if (record === undefined || open(record)) {
    if (options.force === undefined && !overdue) return "WAITING";
    outcome = { kind: "unavailable", reason: options.force ?? "timed-out" };
  } else if (record.state === "RECORDED") {
    outcome = { kind: "checked", findings: record.findings ?? [], undecided: record.results === undefined ? 0 : groundingFindingsOf(record.results).undecidedScenarioIds.length };
  } else outcome = { kind: "unavailable", reason: record.reason ?? "run-failed" };

  // The plan is read again from the planner's saved answer, as it was when held; the check's result is added to it.
  const planOperation = await getItem<OperationRecord>(dependencies, operationKey(task.workspaceId, hold.planOperationId));
  const answer = await getItem<Record<string, unknown>>(dependencies, { pk: `WORKSPACE#${task.workspaceId}`, sk: `ARTIFACT#${hold.artifactId}` });
  const plannerReplies: PlannerReplies[] = [];
  let stored: Awaited<ReturnType<typeof storePlanAnswer>> | undefined;
  let next: WorkflowSnapshot;
  if (planOperation === undefined || answer === undefined) {
    next = blockWorkflow(workflow, WORKFLOW_BLOCK_REASONS.planNotSaved, now);
  } else {
    stored = await storePlanAnswer(dependencies, task as DeveloperTaskRecord & { workflow: WorkflowSnapshot }, answer, now, planOperation.workflowE2EPlanVersion === 2, planOperation, { sha256: hold.artifactSha256, outcome });
    next = stored.next;
  }
  const unreadable = stored?.planUnreadable;
  const forget = unreadable === null && task.planUnreadable !== undefined;
  const items: TransactItems = [
    { Update: { TableName: dependencies.tableName, Key: taskKey(taskId),
      UpdateExpression: `SET workflow = :workflow, updatedAt = :now${unreadable === undefined || unreadable === null ? "" : ", planUnreadable = :unreadable"}${stored?.selfCheck === undefined ? "" : ", planSelfCheck = :selfCheck"}${unreadable === null && task.threadNotesFedThrough !== undefined ? ", threadNotesFedFrom = :fedFrom" : ""} REMOVE planGrounding, planGroundingAbandoned${forget ? ", planUnreadable" : ""}`,
      ConditionExpression: holdCondition, ExpressionAttributeNames: holdNames,
      ExpressionAttributeValues: { ...holdValues, ":workflow": next, ":now": now,
        ...(unreadable === undefined || unreadable === null ? {} : { ":unreadable": unreadable }),
        ...(stored?.selfCheck === undefined ? {} : { ":selfCheck": stored.selfCheck }),
        ...(unreadable === null && task.threadNotesFedThrough !== undefined ? { ":fedFrom": task.threadNotesFedThrough } : {}) } } },
    { Delete: { TableName: dependencies.tableName, Key: rowKey } },
    { Delete: { TableName: dependencies.tableName, Key: markerKey } },
    ...(stored?.revision === undefined ? [] : [workflowDispatchItem(dependencies.tableName, taskId, next.revision, "REPLAN", createHash("sha256").update(stored.revision.prompt, "utf8").digest("hex"), now, now, stored.revision.prompt)]),
    ...(stored?.evidenceJob === undefined ? [] : [{ Put: { TableName: dependencies.tableName, Item: planEvidenceJobItem({ taskId, ...stored.evidenceJob, now: Date.parse(now) }), ConditionExpression: "attribute_not_exists(pk)" } }]),
    ...(stored?.plannerReplies === undefined ? [] : [{ Put: plannerRepliesItem(dependencies.tableName, stored.plannerReplies, now) }]),
  ];
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (error) {
    // Another finish (or the owner's close) got there first.
    if (isConditional(error)) return "NOOP";
    throw error;
  }
  if (stored?.plannerReplies !== undefined) plannerReplies.push(stored.plannerReplies);
  if (stored?.evidenceJob !== undefined) await startPlanEvidenceJobs(dependencies, [planEvidenceEvent(taskId, stored.evidenceJob.artifactId)]);
  if (stored?.inlineEvidence !== undefined) await attachInlineEvidence(dependencies, [{ ...stored.inlineEvidence, taskId }]);
  await writeAllPlannerReplies(dependencies, plannerReplies);
  await dispatchWorkflowContinuation(dependencies, taskId);
  return "FINISHED";
}
