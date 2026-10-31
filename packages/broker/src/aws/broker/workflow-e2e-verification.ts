// Part of the broker (split out of ../broker.ts): verifying workflow E2E evidence, authority checks and presentations.

import { createHash } from "node:crypto";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { AgentXError, E2ESharedViewSchema, E2EPolicySchema, E2EScenarioBundleSchema, e2eScenarioBundleDigest, e2ePlanHasCompleteRequiredCriteria, E2ERunBindingSchema, E2ERoundSchema, buildE2ESharedView, CandidateManifestSchema, selectE2EExecutionPlan, verifyE2ESourceSnapshot, type DeveloperTaskView, canonicalJson, type OperationStatus, type OrgRole, projectAllows, orgProjectCatalogKey, projectMemberKey, slackBindingKey, projectRevisionKey, type OrgId, type E2ESourceSnapshot, type E2EWorkflowAdmissionRef, E2EWorkflowGroupEvidenceRefSchema, type E2EPolicy, E2EApplicationPlanIntentSchema, E2EApplicationSelectionRecordSchema, E2E_ANONYMOUS_ACCOUNT_PROFILE_ID, e2eAnonymousTargetId, e2eAnonymousVariantOf, type E2EScenarioResults, type E2ESharedView, type E2EApplicationExecutionAdmission, isE2EApplicationAdmissionSchemaVersion, type E2ERegisteredRuntime, ProjectSetupRunnerEnvironmentSchema, ProjectSetupRunnerToolchainSchema, cutEvidenceReason } from "@agentx/contracts";
import { compileE2EScenarios, collectE2EActualCliRun, qualifyE2ECollection, e2eSnapshotSourceDigest, parseE2EFirstPartyCapture, e2ePrivateTransferMaxBytes, decodeE2EApplicationExecutionAdmission } from "@agentx/verifier";
import { renderE2EMcpProjection, renderE2EPageHtml, renderE2EScenarioRowsHtml, renderE2EScenarioSlackBlocks, renderE2ESlackBlocks, renderE2ENotifierSlackBlocks } from "../../e2e-presentation.js";
import type { DisplayArtifact } from "../../e2e/application-display.js";
import { loadStoredScenarioResults, loadWorkflowE2EArtifact as loadStoredWorkflowE2EArtifact } from "../workflow-e2e-artifacts.js";
import { markWorkflowE2EBaselineUnavailable, readWorkflowE2EBaseline, readWorkflowE2EBaselineRecord, recordWorkflowE2EBaseline, verifyBaselineEvidence, type BaselineUnavailableReason, type SkippedAiScenarios } from "../workflow-e2e-baseline.js";
import { markWorkflowE2EReplayUnavailable, readWorkflowE2EReplayRecord, recordWorkflowE2EReplay, verifyReplayEvidence, type ReplayUnavailableReason } from "../workflow-e2e-replay.js";
import { loadWorkflowDocument, readObjectText as readStoredText } from "../../developer/plan-artifacts.js";
import { projectSetupBindingDigest } from "../project-setup-runtime-catalog.js";
import { deriveE2EFeatureExecutionAdmission } from "../../e2e/feature-plan-intent.js";
import { admitE2EFeatureVerifier, e2eFeatureVerifierKey, E2EFeatureVerifierRecordSchema, E2E_FEATURE_PROCESS_RESPONSE_SCOPE } from "../e2e-feature-verifier-catalog.js";
import { resolveWorkflowE2ECanonicalApproval, workflowE2ECurrentAuthorityMatches } from "../workflow-e2e-current-authority.js";
import { readWorkflowE2ENotifierProjection } from "../workflow-e2e-notifier-projection.js";
import { getItem, operationKey, type OperationRecord } from "../cancellation.js";
import { effectiveTaskOwner, taskKey, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { applicationIntentDigest, applicationIntentWithAccountRefs, applicationRoundIntent } from "../../e2e/application-plan-approval.js";
import { portableFeatureIntentOf } from "../../e2e/portable-feature-intent.js";
import { applicationSelectionStillCurrent } from "../../e2e/application-dispatch-check.js";
import { groundingPlanDigest } from "../../e2e/application-admission.js";
import { markWorkflowE2EGroundingUnavailable, readWorkflowE2EGroundingRecord, recordWorkflowE2EGrounding, verifyGroundingEvidence, type GroundingRecord, type GroundingUnavailableReason } from "../workflow-e2e-grounding.js";
import { applicationEvidenceLimits, modelRouteForAdmission, verifyApplicationE2EEvidence, type ApplicationEvidenceVerification } from "../../e2e/application-evidence.js";
import { checkProjectAccess } from "../developer-routes.js";
import type { TransactItems } from "../developer-task-actions.js";
import { parseRuntimeBinding } from "../lambda.js";
import type { AwsBrokerDependencies } from "./definitions.js";
import { requireRecordProject } from "./dependency-wiring.js";
import { getWorkflowE2ECreatorIdentity } from "./dispatch.js";
import { candidateSourceOperation } from "./e2e-rounds.js";
import { WORKFLOW_E2E_ADMISSION_MAX_BYTES } from "./evidence-and-setup.js";
import { ensureProjectCatalogPointer } from "./project-registration.js";
import { readOrgMember, requireLatestProject } from "./records.js";
import { orgOfRecord } from "./scope-helpers.js";
import { orgRoleAuthorityCheck } from "./sweeps-and-readiness.js";
import { evaluateWorkflowE2EApplicationSelectionNow } from "./task-operations.js";
import { loadWorkflowCandidateSourceExport } from "./workflow-items.js";

/** What a verification hands the presentation: the authenticated plan and round, the broker's own re-collected results, and (for a browser and API round) the display rows derived from them. */
export type WorkflowE2EProjection = { plan?: unknown; round?: unknown; results: unknown[]; allowStaleProjection?: boolean; display?: NonNullable<ApplicationEvidenceVerification["display"]> };

export interface WorkflowE2EVerificationDiagnostic {
  reason?: string;
  /** Set when the evidence verified was an application round's, whose reasons are safe and useful to show the owner. */
  application?: true;
  /** Set once current authority was judged (valid or not): a reason found without it is about the evidence, not about authority. */
  authorityEvaluated?: true;
  /**
   * Why an application round's authority moved, when it was the runtime: `requalified` (the admitted row was replaced; the owner approves the plan again against the
   * new row) or `unusable` (no ready row of that kind; an administrator qualifies the runtime again). `accounts`: a test account the plan was approved with is not the
   * registered one now (the owner approves the plan again). The result callback words its block by it.
   */
  runtimeChange?: "requalified" | "unusable" | "accounts";
  /** Exact authority rows validated for this result, carried into the same task-state transaction. */
  authorityChecks?: Array<Record<string, unknown>>;
}

/**
 * A terminal CHECKS operation's broker timestamp may anchor a later re-collection only when
 * the task still carries the exact canonical outcome written from that operation's immutable
 * admission and evidence. This never supplies a receipt for an active or first-time result.
 */
function workflowE2ETerminalReceiptAt(
  operation: OperationRecord,
  task: DeveloperTaskRecord,
  candidateDigest: string,
  reference: E2EWorkflowAdmissionRef,
  round: ReturnType<typeof E2ERoundSchema.parse>,
  allowStaleProjection: boolean,
): { at: string; outcome: "PASS" | "FAILED" } | undefined {
  if (operation.kind !== "task" || operation.workflowMode !== "CHECKS"
    || operation.status !== "SUCCEEDED" && operation.status !== "FAILED"
    || operation.workflowE2EAdmission === undefined || canonicalJson(operation.workflowE2EAdmission) !== canonicalJson(reference)
    || operation.workflowE2EEvidenceRef === undefined || operation.workflowE2EEvidenceRef.key !== `workflow-e2e-evidence/sha256/${operation.workflowE2EEvidenceRef.sha256}.json`
    || reference.taskId !== task.taskId || reference.candidateDigest !== candidateDigest || reference.roundId !== round.roundId
    || reference.workflowRevision !== round.workflowRevision || canonicalJson(reference.groupRunIds) !== canonicalJson(round.groupBindings.map((binding) => binding.runId))
    || new Set(operation.workflowE2EGroupRunIds ?? []).size !== reference.groupRunIds.length
    || canonicalJson([...(operation.workflowE2EGroupRunIds ?? [])].sort()) !== canonicalJson([...reference.groupRunIds].sort())) return undefined;
  const receiptTime = Date.parse(operation.updatedAt);
  if (!Number.isFinite(receiptTime) || new Date(receiptTime).toISOString() !== operation.updatedAt
    || receiptTime > Date.parse(round.deadlineAt)) return undefined;

  const workflowE2E = task.workflow?.e2e;
  if (operation.status === "SUCCEEDED" && !allowStaleProjection) {
    const qualified = workflowE2E?.qualifiedRound;
    if (!qualified || qualified.candidateDigest !== candidateDigest
      || qualified.roundId !== reference.roundId || canonicalJson(qualified.groupRunIds) !== canonicalJson(reference.groupRunIds)
      || qualified.admissionSha256 !== reference.admissionRef.sha256 || qualified.evidenceSha256 !== operation.workflowE2EEvidenceRef.sha256
      || qualified.contractDigest !== workflowE2E.contractDigest || qualified.policyDigest !== workflowE2E.policyDigest
      || qualified.bundleDigest !== workflowE2E.bundleDigest || qualified.executionPlanDigest !== workflowE2E.executionPlanDigest
      || workflowE2E.currentRoundId !== qualified.roundId || canonicalJson(workflowE2E.currentGroupRunIds) !== canonicalJson(qualified.groupRunIds)) return undefined;
    return { at: operation.updatedAt, outcome: "PASS" };
  }
  const failed = workflowE2E?.failedRound;
  if (!allowStaleProjection || failed?.status !== "FAILED" || failed.candidateDigest !== candidateDigest
    || failed.roundId !== reference.roundId || canonicalJson(failed.groupRunIds) !== canonicalJson(reference.groupRunIds)
    || failed.admissionSha256 !== reference.admissionRef.sha256 || failed.evidenceSha256 !== operation.workflowE2EEvidenceRef.sha256) return undefined;
  return { at: operation.updatedAt, outcome: "FAILED" };
}

/** Independently recompiles and collects every group; worker-supplied verdict fields are ignored. */
export async function verifyWorkflowE2EEvidence(
  dependencies: AwsBrokerDependencies, operation: OperationRecord, task: DeveloperTaskRecord, candidate: ReturnType<typeof CandidateManifestSchema.parse>,
  projection?: WorkflowE2EProjection,
  diagnostic?: WorkflowE2EVerificationDiagnostic,
  /** How the CHECKS operation is ending, when its stored record has not been written yet (the result callback verifies before it writes the terminal state). */
  options?: { terminalStatus?: "SUCCEEDED" | "FAILED" },
): Promise<"PASS" | "FAILED" | "UNKNOWN"> {
  const unavailable = (reason: string): "UNKNOWN" => { if (diagnostic !== undefined) diagnostic.reason = reason; return "UNKNOWN"; };
  try {
    const workflow = task.workflow;
    if (workflow === undefined) return unavailable("workflow-missing");
    const reference = operation.workflowE2EAdmission;
    // M1.3 Task 3.7b: this is the candidate's verification. A baseline round (the unchanged code, for information only) is never a candidate round, whatever the workflow's current
    // round says: its own completion path verifies it (verifyBaselineEvidence), and nothing here can turn it into a verdict on the candidate.
    if (reference?.purpose === "baseline") return unavailable("baseline-admission-is-not-a-candidate-round");
    if (reference?.purpose === "replay") return unavailable("replay-admission-is-not-a-candidate-round");
    if (reference?.purpose === "grounding") return unavailable("grounding-admission-is-not-a-candidate-round");
    const evidenceRef = operation.workflowE2EEvidenceRef;
    const groupEvidenceRefs = operation.workflowE2EGroupEvidenceRefs ?? [];
    const groupEvidenceRunIds = operation.workflowE2EGroupRunIds ?? [];
    const staleProjection = projection?.allowStaleProjection === true;
    if (!reference || reference.taskId !== task.taskId || reference.candidateDigest !== candidate.digest
      || (!staleProjection && (workflow.e2e?.currentRoundId !== reference.roundId
        || canonicalJson(workflow.e2e.currentGroupRunIds) !== canonicalJson(reference.groupRunIds)))) return unavailable("current-admission-reference-mismatch");
    const admissionText = await readStoredText(dependencies.s3, dependencies.artifactBucketName, reference.admissionRef.key, WORKFLOW_E2E_ADMISSION_MAX_BYTES);
    // The admission names its own kind. An application admission is verified by the application verifier and never reaches the portable code below; a task whose approved
    // plan is an application plan has no portable verification at all (Ruling AX), whatever admission and evidence are recorded for it.
    if (isE2EApplicationAdmissionSchemaVersion(storedAdmissionSchemaVersion(admissionText))) {
      if (diagnostic !== undefined) diagnostic.application = true;
      return await verifyApplicationWorkflowE2EEvidence({ dependencies, operation, task, candidate, reference, admissionText: admissionText!, projection, diagnostic, unavailable,
        ...(options?.terminalStatus === undefined ? {} : { terminalStatus: options.terminalStatus }) });
    }
    if (workflow.e2e?.applicationSelection !== undefined) {
      if (diagnostic !== undefined) diagnostic.application = true;
      return unavailable("application-e2e-plan-needs-application-verification");
    }
    const evidenceText = evidenceRef === undefined ? undefined
      : await readStoredText(dependencies.s3, dependencies.artifactBucketName, evidenceRef.key, WORKFLOW_E2E_ADMISSION_MAX_BYTES);
    if (admissionText === undefined || createHash("sha256").update(admissionText).digest("hex") !== reference.admissionRef.sha256
      || Buffer.byteLength(admissionText) !== reference.admissionRef.byteLength
      || evidenceRef !== undefined && (evidenceText === undefined || evidenceRef.key !== `workflow-e2e-evidence/sha256/${evidenceRef.sha256}.json`
        || createHash("sha256").update(evidenceText).digest("hex") !== evidenceRef.sha256 || Buffer.byteLength(evidenceText) !== evidenceRef.byteLength)) {
      return unavailable("admission-or-evidence-reference-integrity");
    }
    const admission = JSON.parse(admissionText) as Record<string, unknown>;
    const evidence = evidenceText === undefined ? undefined : JSON.parse(evidenceText) as Record<string, unknown>;
    if (admission.schemaVersion !== "workflow-e2e-admission/v1" || evidence !== undefined && (evidence.schemaVersion !== "workflow-e2e-evidence/v1"
      || evidence.admissionSha256 !== reference.admissionRef.sha256 || evidence.taskId !== task.taskId || evidence.operationId !== operation.id
      || evidence.operationFence !== operation.fence || evidence.workflowRevision !== reference.workflowRevision || evidence.candidateDigest !== candidate.digest)) {
      return unavailable("admission-or-evidence-subject-binding");
    }
    const sourceRecord = admission.sourceSnapshot as Record<string, unknown>;
    if (!sourceRecord || !Array.isArray(sourceRecord.sources)) return unavailable("admitted-source-snapshot-shape");
    const snapshot = { ...sourceRecord, sources: sourceRecord.sources.map((raw) => {
      const row = raw as Record<string, unknown>;
      if (typeof row.path !== "string" || typeof row.sha256 !== "string" || row.kind !== "blob" || typeof row.bytesBase64 !== "string") throw new Error("invalid source row");
      const bytes = Buffer.from(row.bytesBase64, "base64");
      if (bytes.toString("base64") !== row.bytesBase64) throw new Error("invalid source encoding");
      return { path: row.path, sha256: row.sha256, kind: "blob" as const, bytes };
    }) } as unknown as E2ESourceSnapshot;
    verifyE2ESourceSnapshot(snapshot, candidate);
    E2EPolicySchema.parse(admission.policy);
    const selectionInput = { ...(admission.selectionInput as Record<string, unknown>), sourceSnapshot: snapshot };
    const plan = selectE2EExecutionPlan(selectionInput as never);
    const bundle = E2EScenarioBundleSchema.parse(admission.bundle);
    const round = E2ERoundSchema.parse(admission.round);
    const projectionResults: unknown[] = [];
    const runtime = admission.runtime as Record<string, unknown>;
    const runnerEnvironment = ProjectSetupRunnerEnvironmentSchema.parse(runtime.runnerEnvironment);
    const runnerToolchain = ProjectSetupRunnerToolchainSchema.parse(runtime.runnerToolchain);
    const groupAdmissions = admission.groupAdmissions as Array<Record<string, unknown>>;
    const aggregateGroupRuns = evidence?.groupRuns;
    if (admission.taskId !== task.taskId || admission.operationId !== operation.id || admission.operationFence !== operation.fence
      || admission.workflowRevision !== reference.workflowRevision || admission.candidateDigest !== candidate.digest
      || round.roundId !== reference.roundId || round.taskId !== task.taskId || round.operationId !== operation.id || round.operationFence !== operation.fence
      || round.workflowRevision !== reference.workflowRevision || plan.groups.length === 0 || plan.groups.length !== groupAdmissions.length
      || plan.groups.length !== reference.groupRunIds.length
      || canonicalJson(plan) !== canonicalJson(admission.plan) || bundle.bundleDigest !== e2eScenarioBundleDigest(bundle)) return unavailable("current-plan-round-or-group-binding");
    if (evidence !== undefined && (!Array.isArray(aggregateGroupRuns) || aggregateGroupRuns.length !== reference.groupRunIds.length)) return unavailable("aggregate-group-results-incomplete");
    if (groupEvidenceRefs.length !== groupEvidenceRunIds.length
      || canonicalJson(groupEvidenceRefs.map((raw) => E2EWorkflowGroupEvidenceRefSchema.parse(raw).groupRunId)) !== canonicalJson(groupEvidenceRunIds)
      || new Set(groupEvidenceRunIds).size !== groupEvidenceRunIds.length
      || groupEvidenceRunIds.some((runId) => !reference.groupRunIds.includes(runId))) return unavailable("accepted-group-reference-list-invalid");
    if (evidence === undefined && groupEvidenceRefs.length === 0) return unavailable("group-results-not-yet-accepted");
    const aggregateByRun = new Map<string, Record<string, unknown>>();
    if (Array.isArray(aggregateGroupRuns)) {
      for (const raw of aggregateGroupRuns) {
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return unavailable("aggregate-group-result-shape");
        const run = raw as Record<string, unknown>;
        const binding = run.binding as Record<string, unknown> | undefined;
        if (typeof binding?.runId !== "string" || aggregateByRun.has(binding.runId)) return unavailable("aggregate-group-result-identity");
        aggregateByRun.set(binding.runId, run);
      }
    }
    const groupRunsById = new Map<string, Record<string, unknown>>();
    for (const raw of groupEvidenceRefs) {
      const parsedRef = E2EWorkflowGroupEvidenceRefSchema.safeParse(raw);
      if (!parsedRef.success) return unavailable("accepted-group-reference-schema");
      const { groupRunId, evidenceRef: storedGroupRef } = parsedRef.data;
      const index = reference.groupRunIds.indexOf(groupRunId);
      if (index < 0 || groupRunsById.has(groupRunId) || storedGroupRef.key !== `workflow-e2e-group-evidence/sha256/${storedGroupRef.sha256}.json`) {
        return unavailable("accepted-group-reference-subject");
      }
      const expectedCaseCount = groupAdmissions[index]?.expectedCases;
      if (!Array.isArray(expectedCaseCount)) return unavailable("admitted-group-case-count");
      const groupText = await readStoredText(dependencies.s3, dependencies.artifactBucketName, storedGroupRef.key,
        Math.min(WORKFLOW_E2E_ADMISSION_MAX_BYTES, e2ePrivateTransferMaxBytes(expectedCaseCount.length, 1)));
      if (groupText === undefined || Buffer.byteLength(groupText) !== storedGroupRef.byteLength
        || createHash("sha256").update(groupText).digest("hex") !== storedGroupRef.sha256) return unavailable("accepted-group-evidence-integrity");
      const envelope = JSON.parse(groupText) as Record<string, unknown>;
      const groupRun = envelope.groupRun as Record<string, unknown> | undefined;
      if (!groupRun || envelope.schemaVersion !== "workflow-e2e-group-evidence/v1" || envelope.admissionSha256 !== reference.admissionRef.sha256
        || envelope.taskId !== task.taskId || envelope.operationId !== operation.id || envelope.operationFence !== operation.fence
        || envelope.workflowRevision !== reference.workflowRevision || envelope.candidateDigest !== candidate.digest
        || canonicalJson(envelope.round) !== canonicalJson(round) || canonicalJson(groupRun.binding) !== canonicalJson(round.groupBindings[index])
        || canonicalJson(groupRun.group) !== canonicalJson(plan.groups[index])) return unavailable("accepted-group-evidence-subject");
      const aggregateRun = aggregateByRun.get(groupRunId);
      if (evidence !== undefined && (aggregateRun === undefined || canonicalJson(aggregateRun) !== canonicalJson(groupRun))) return unavailable("aggregate-group-evidence-mismatch");
      groupRunsById.set(groupRunId, groupRun);
    }
    if (evidence !== undefined && (groupEvidenceRefs.length !== reference.groupRunIds.length
      || canonicalJson([...groupRunsById.keys()].sort()) !== canonicalJson([...reference.groupRunIds].sort())
      || canonicalJson([...aggregateByRun.keys()].sort()) !== canonicalJson([...reference.groupRunIds].sort()))) return unavailable("aggregate-does-not-cover-accepted-groups");
    const semantic = (admission.portableApprovalBinding as { semanticApproval?: { digest?: unknown } } | undefined)?.semanticApproval?.digest;
    if (typeof semantic !== "string" || !/^[a-f0-9]{64}$/u.test(semantic)) return unavailable("semantic-approval-binding");
    const semanticApprovalDigests = new Map(bundle.scenarios.map((scenario) => [scenario.scenarioId, semantic]));
    const terminalReceipt = workflowE2ETerminalReceiptAt(operation, task, candidate.digest, reference, round, staleProjection);
    const qualifications: Array<"PASS" | "FAILED" | "UNKNOWN"> = [];
    for (const [index, group] of plan.groups.entries()) {
      const admitted = groupAdmissions[index]; const run = groupRunsById.get(reference.groupRunIds[index]!);
      if (!admitted || canonicalJson(admitted.group) !== canonicalJson(group)) return unavailable("admitted-group-identity");
      const compiled = compileE2EScenarios(bundle, plan.effectiveTargets, group, { selectionInput, executionPlan: plan, group } as never);
      if (admitted.expectedConfigDigest !== compiled.expectedConfigDigest || admitted.compiledInventoryDigest !== compiled.inventory.digest
        || admitted.selectionPacketPath !== compiled.selectionPacketPath || canonicalJson(admitted.expectedCases) !== canonicalJson(compiled.expectedCases)) return unavailable("compiled-group-expectations");
      const binding = E2ERunBindingSchema.parse(admitted.binding);
      if (binding.runId !== reference.groupRunIds[index] || binding.taskId !== task.taskId || binding.operationId !== operation.id
        || binding.operationFence !== operation.fence || binding.workflowRevision !== reference.workflowRevision || binding.candidateDigest !== candidate.digest
        || binding.roundId !== reference.roundId || canonicalJson(round.groupBindings[index]) !== canonicalJson(binding)) return unavailable("group-run-binding");
      if (run === undefined) { qualifications.push("UNKNOWN"); continue; }
      if (canonicalJson(run.group) !== canonicalJson(group) || canonicalJson(run.binding) !== canonicalJson(binding)) return unavailable("group-run-result-binding");
      const selection = JSON.parse(compiled.files.get(compiled.selectionPacketPath) ?? "null") as unknown;
      if (canonicalJson(run.selection) !== canonicalJson(selection) || !Array.isArray(run.hostRequestIds)) return unavailable("compiled-selection-or-host-request-list");
      const hostRequestIds = new Map<string, string>();
      for (const entry of run.hostRequestIds) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || typeof entry[1] !== "string" || hostRequestIds.has(entry[0])) return unavailable("host-request-identity-list");
        hostRequestIds.set(entry[0], entry[1]);
      }
      if (hostRequestIds.size !== compiled.hostRequestPayloads.size) return unavailable("host-request-count");
      const rawActual = run.actual as Record<string, unknown>;
      if (!rawActual || typeof rawActual.launchId !== "string" || typeof rawActual.rawReportBase64 !== "string" || typeof rawActual.runStartCaptureBase64 !== "string"
        || canonicalJson(rawActual.runnerToolchain) !== canonicalJson(runnerToolchain) || !Array.isArray(rawActual.candidateCaptures)
        || !Array.isArray(rawActual.assertionReceipts) || typeof rawActual.cleanupConfirmed !== "boolean" || typeof rawActual.cleanupServerListening !== "boolean") return unavailable("actual-run-capture-shape-or-toolchain");
      const rawReportBytes = Buffer.from(rawActual.rawReportBase64, "base64");
      const runStartCaptureBytes = Buffer.from(rawActual.runStartCaptureBase64, "base64");
      if (rawReportBytes.toString("base64") !== rawActual.rawReportBase64 || runStartCaptureBytes.toString("base64") !== rawActual.runStartCaptureBase64) return unavailable("actual-run-capture-encoding");
      const actual = { ...rawActual, rawReportBytes: new Uint8Array(rawReportBytes), runStartCaptureBytes: new Uint8Array(runStartCaptureBytes),
        runStartCapture: parseE2EFirstPartyCapture(runStartCaptureBytes, rawActual.launchId), evidenceDirectory: "" } as never;
      const result = collectE2EActualCliRun({ actual, compiled, binding, round, selection: selection as never,
        sourceDigest: e2eSnapshotSourceDigest(compiled, snapshot.sources.map(({ path, sha256 }) => ({ path, sha256 }))),
        semanticApprovalDigests, hostRequestIds,
        declaredMockComponentIds: Array.isArray(rawActual.declaredMockComponentIds) ? rawActual.declaredMockComponentIds as string[] : [],
        environment: runnerEnvironment,
        usage: { discoveredResults: Number(rawActual.selected) + Number(rawActual.filtered), maxAgentContextBytes: 0, maxLedgerBytes: 0, maxObservationBytes: 0, artifactBytes: 0, downloads: 0, events: 0, modelTokens: 0, maxModelCallsInStep: 0, maxActionStepsInStep: 0 },
        limits: { maxAgentContextBytes: 16_384, maxLedgerBytes: 8_192, maxObservationBytes: 262_144, maxEventsPerStep: 1_000, maxModelTokensPerCall: 64_000 } });
      const qualification = terminalReceipt !== undefined && result.collection !== null && result.oracle !== null
        ? qualifyE2ECollection(result.oracle, { ...result.collection, receivedAt: terminalReceipt.at })
        : result.qualification;
      const process = rawActual.runProcess as Record<string, unknown> | undefined;
      if (qualification?.result !== null && qualification?.result !== undefined) {
        // This is a broker-side projection of the independently re-collected result. The raw
        // collector labels its structural output exploratory; only this verified path promotes
        // the projection after matching the stored admission, source, round, capture and receipts.
        projectionResults.push({ ...qualification.result, producer: "broker-independent-e2e-verifier", qualification: "trusted",
          ...(process?.status === 0 && process.signal === null && process.aborted === false && process.timedOut === false ? {} : { status: "failed", reason: "host-process-failed" }) });
      }
      if (process?.status !== 0 || process.signal !== null || process.aborted !== false || process.timedOut !== false) qualifications.push("FAILED");
      else if (terminalReceipt?.outcome === "FAILED" && qualification?.status !== "FAILED") qualifications.push("UNKNOWN");
      else qualifications.push(qualification?.status ?? "UNKNOWN");
    }
    // Re-collect every supported admitted group for an honest scoped projection even when a
    // required criterion has no executable source-interface case. That criterion still holds
    // aggregate readiness: incomplete required coverage can never become PASS.
    const currentAuthorityValid = await workflowE2ECurrentAuthorityIsValid(dependencies, task, candidate, admission, snapshot, diagnostic);
    if (projection !== undefined) {
      projection.plan = plan;
      projection.round = round;
      if (currentAuthorityValid) projection.results.push(...projectionResults);
    }
    if (!currentAuthorityValid) return unavailable(diagnostic?.reason ?? "current-owner-policy-source-or-runtime-authority");
    if (!e2ePlanHasCompleteRequiredCriteria(plan)) return unavailable("required-criteria-unavailable");
    return qualifications.includes("FAILED") ? "FAILED" : qualifications.every((item) => item === "PASS") ? "PASS" : "UNKNOWN";
  } catch { return unavailable("verification-exception"); }
}

export type AuthorityMark = (stage: string) => void;
type AuthorityReject = (reason: string) => false;

/**
 * The task, plan and approval every current-authority check, portable or application, starts from: the task is open and still on this candidate with required E2E, its
 * latest plan is the one the E2E contract was approved for, and the Owner's approval of exactly that plan resolves. Calls `reject` and returns undefined when any of it fails.
 */
async function loadCurrentApprovedPlan(dependencies: AwsBrokerDependencies, task: DeveloperTaskRecord, candidate: ReturnType<typeof CandidateManifestSchema.parse>,
  mark: AuthorityMark, reject: AuthorityReject) {
  const workflow = task.workflow;
  const catalogId = dependencies.e2eFeatureRuntimeCatalogId;
  if (!workflow || workflow.e2e?.required !== true || workflow.candidate?.digest !== candidate.digest || !catalogId
    || task.closedAt !== undefined) { reject("current-task-or-approval-missing"); return undefined; }
  const artifact = workflow.artifacts.filter((entry) => entry.type === "plan").at(-1);
  if (artifact === undefined || workflow.e2e.contractDigest !== artifact.sha256) { reject("current-canonical-plan-missing-or-stale"); return undefined; }
  mark("canonical-artifact");
  const approved = await loadWorkflowDocument((key, maxBytes) => readStoredText(dependencies.s3, dependencies.artifactBucketName, key, maxBytes), artifact, {});
  if (approved?.format !== "structured") { reject("canonical-artifact-or-owner-decision-mismatch"); return undefined; }
  const canonicalApproval = resolveWorkflowE2ECanonicalApproval({ taskId: task.taskId,
    workflow: workflow as NonNullable<typeof workflow> & { artifacts: Array<{ id: string; type: string; sha256: string }>;
      decisions: Array<{ decision: string; actorId: string; artifactDigest?: string; workBreakdownDigest?: string; workflowRevision: number }> },
    artifact, plan: approved.plan });
  if (canonicalApproval === undefined) { reject("canonical-artifact-or-owner-decision-mismatch"); return undefined; }
  return { workflow, e2e: workflow.e2e, catalogId, artifact, approved, canonicalApproval };
}

/** The task's pinned project and the latest one, which must hold the same E2E policy and runtime binding, with the catalog entry that names the latest. */
async function loadCurrentProjectAuthority(dependencies: AwsBrokerDependencies, task: DeveloperTaskRecord, mark: AuthorityMark, reject: AuthorityReject) {
  mark("project-record");
  const orgId = await orgOfRecord(dependencies, task);
  const project = await requireRecordProject(dependencies, task, task.project, task.startingRevision);
  const latestProject = await requireLatestProject(dependencies, orgId, task.project);
  if (latestProject.setupApproval === undefined) { reject("current-project-setup-approval-unavailable"); return undefined; }
  // A catalog row written before the latest-revision pointer existed is repaired from the revision history first (never created);
  // the strict comparison below and the catalog fence in the transaction then stay exact. Both the portable and the application
  // authority come through here.
  mark("project-catalog-pointer");
  try {
    await ensureProjectCatalogPointer(dependencies, orgId, task.project);
  } catch (error) {
    if (error instanceof AgentXError && error.code === "CONFIG_INVALID") { reject(`config-invalid-project-catalog-pointer-unrepairable:${task.project}`); return undefined; }
    throw error;
  }
  const catalogKey = orgProjectCatalogKey(orgId, task.project);
  const projectCatalog = await getItem<Record<string, unknown>>(dependencies, catalogKey);
  if (projectCatalog?.entityType !== "PROJECT_CATALOG" || projectCatalog.name !== task.project
    || projectCatalog.latestRevision !== latestProject.definition.revision) { reject("current-project-latest-revision-unavailable"); return undefined; }
  const policy = E2EPolicySchema.parse(latestProject.definition.e2e);
  const pinnedPolicy = E2EPolicySchema.parse(project.definition.e2e);
  if (canonicalJson(policy) !== canonicalJson(pinnedPolicy)
    || canonicalJson(parseRuntimeBinding(latestProject.runtimeBinding)) !== canonicalJson(parseRuntimeBinding(project.runtimeBinding))) {
    reject("current-project-policy-or-runtime-changed"); return undefined;
  }
  return { project, latestProject, setupApproval: latestProject.setupApproval, catalogKey, policy, orgId };
}

/**
 * The creator's current authority over the project (an unrevoked identity with a versioned direct grant or locally bound channels), which must be exactly the proof the
 * round was admitted under (`admittedProof`): a grant re-issued, a role changed or a channel rebound during the round refuses.
 */
async function loadCurrentCreatorAuthority(dependencies: AwsBrokerDependencies, task: DeveloperTaskRecord, admittedProof: unknown, mark: AuthorityMark, reject: AuthorityReject) {
  mark("creator-project-access");
  const orgId = await orgOfRecord(dependencies, task);
  // The proofs are the task's owner now: the person who took it over, else its creator (Plan 5 Task 12a).
  const owner = effectiveTaskOwner(task);
  const creator = await getWorkflowE2ECreatorIdentity(dependencies, owner.developerId);
  if (creator === undefined || creator.revoked || dependencies.developer === undefined) { reject("current-creator-identity-unavailable"); return undefined; }
  // The creator's live org role, read afresh on every round: an owner or admin with no grant is a maintainer (finding 5).
  const creatorOrgMember = await readOrgMember(dependencies, orgId, owner.developerId);
  let creatorAccess: Awaited<ReturnType<typeof checkProjectAccess>>;
  try {
    creatorAccess = await checkProjectAccess({ documentClient: dependencies.documentClient, tableName: dependencies.tableName,
      developer: dependencies.developer, now: Date.now },
    { orgId, developerId: owner.developerId, orgRole: creatorOrgMember?.role ?? "member", ...(creator.slackUserId === undefined ? {} : { slackUserId: creator.slackUserId }) }, task.project);
  } catch { reject("current-creator-project-access-unavailable"); return undefined; }
  if (!projectAllows(creatorAccess.role, "start_tasks")) { reject("current-creator-can-only-view-project"); return undefined; }
  const creatorMembershipKey = projectMemberKey(orgId, owner.developerId, task.project);
  const creatorMembership = await getItem<Record<string, unknown>>(dependencies, creatorMembershipKey);
  const creatorAuthority = await workflowE2ECreatorAuthorityProof(dependencies, task, creatorMembership, creatorAccess, creatorOrgMember);
  if (creatorAuthority === undefined || canonicalJson(admittedProof) !== canonicalJson(creatorAuthority)) { reject("creator-membership-proof-changed-or-unavailable"); return undefined; }
  return { creatorAuthority, creatorAccess, creatorMembershipKey, developer: dependencies.developer };
}

/**
 * The rows the project, the creator and the creator's grant stand on, as conditions the transaction that records the verdict carries, so it fails if any of them moved
 * after it was checked. `base` is the project catalog, the project revision and the creator's identity; `creator` is the direct grant and the channel bindings.
 */
async function currentAuthorityFences(dependencies: AwsBrokerDependencies, task: DeveloperTaskRecord, input: {
  orgId: OrgId; catalogKey: { pk: string; sk: string }; latestProject: Awaited<ReturnType<typeof requireLatestProject>>; setupApproval: unknown; policy: E2EPolicy;
  creatorAuthority: NonNullable<Awaited<ReturnType<typeof workflowE2ECreatorAuthorityProof>>>; creatorAccess: Awaited<ReturnType<typeof checkProjectAccess>>;
  creatorMembershipKey: { pk: string; sk: string }; developer: NonNullable<AwsBrokerDependencies["developer"]>;
}, reject: AuthorityReject): Promise<{ base: Array<Record<string, unknown>>; creator: Array<Record<string, unknown>> } | undefined> {
  const { latestProject, creatorAuthority, creatorAccess, developer } = input;
  const base: Array<Record<string, unknown>> = [
    { ConditionCheck: { TableName: dependencies.tableName, Key: input.catalogKey,
      ConditionExpression: "entityType = :entity AND #name = :name AND latestRevision = :revision",
      ExpressionAttributeNames: { "#name": "name" },
      ExpressionAttributeValues: { ":entity": "PROJECT_CATALOG", ":name": task.project, ":revision": latestProject.definition.revision } } },
    { ConditionCheck: { TableName: dependencies.tableName, Key: projectRevisionKey(input.orgId, task.project, latestProject.definition.revision),
      ConditionExpression: "entityType = :entity AND registeredBy = :registeredBy AND #definition.#e2e = :policy AND runtimeBinding = :binding AND setupApproval = :setupApproval",
      ExpressionAttributeNames: { "#definition": "definition", "#e2e": "e2e" },
      ExpressionAttributeValues: { ":entity": "PROJECT", ":registeredBy": latestProject.registeredBy, ":policy": input.policy,
        ":binding": latestProject.runtimeBinding, ":setupApproval": input.setupApproval } } },
    { ConditionCheck: { TableName: developer.signInTableName, Key: { pk: `DEVELOPER#${effectiveTaskOwner(task).developerId}`, sk: "META" },
      ConditionExpression: "entityType = :entity AND revoked = :notRevoked",
      ExpressionAttributeValues: { ":entity": "DEVELOPER", ":notRevoked": false } } },
  ];
  const creator: Array<Record<string, unknown>> = [];
  if (creatorAuthority.kind === "direct-membership") {
    creator.push({ ConditionCheck: { TableName: dependencies.tableName, Key: input.creatorMembershipKey,
      ConditionExpression: "entityType = :entity AND ownerKey = :ownerKey AND projectName = :project AND #role = :role AND grantId = :grantId",
      ExpressionAttributeNames: { "#role": "role" },
      ExpressionAttributeValues: { ":entity": "MEMBERSHIP", ":ownerKey": effectiveTaskOwner(task).developerId, ":project": task.project,
        ":role": creatorAuthority.role, ":grantId": creatorAuthority.grantId } } });
  }
  if (creatorAuthority.kind === "org-role") creator.push(orgRoleAuthorityCheck(dependencies.tableName, creatorAuthority));
  if (creatorAccess.access === "channel") {
    const teamId = developer.slackTeamId;
    if (teamId === undefined || creatorAccess.channelIds.length === 0) { reject("current-channel-access-proof-unavailable"); return undefined; }
    for (const channelId of creatorAccess.channelIds) {
      const bindingKey: { pk: string; sk: string } = slackBindingKey(input.orgId, teamId, channelId);
      const binding: Record<string, unknown> | undefined = await getItem<Record<string, unknown>>(dependencies, bindingKey);
      if (binding?.teamId !== teamId || binding.channelId !== channelId || binding.projectName !== task.project
        || typeof binding.updatedAt !== "string" || binding.updatedAt.length === 0) { reject("current-channel-binding-unavailable"); return undefined; }
      creator.push({ ConditionCheck: { TableName: dependencies.tableName, Key: bindingKey,
        ConditionExpression: "teamId = :teamId AND channelId = :channelId AND projectName = :projectName AND updatedAt = :updatedAt",
        ExpressionAttributeValues: { ":teamId": teamId, ":channelId": channelId, ":projectName": task.project, ":updatedAt": binding.updatedAt } } });
    }
  }
  return { base, creator };
}

/** Rebuilds the admitted feature context from current canonical approval, project policy, source and runtime rows. Exported for tests. */
export async function workflowE2ECurrentAuthorityIsValid(
  dependencies: AwsBrokerDependencies,
  task: DeveloperTaskRecord,
  candidate: ReturnType<typeof CandidateManifestSchema.parse>,
  admission: Record<string, unknown>,
  admittedSnapshot: E2ESourceSnapshot,
  diagnostic?: WorkflowE2EVerificationDiagnostic,
): Promise<boolean> {
  const reject = (reason: string): false => { if (diagnostic !== undefined) diagnostic.reason = reason; return false; };
  let stage = "workflow";
  const mark: AuthorityMark = (next) => { stage = next; };
  try {
    const plan = await loadCurrentApprovedPlan(dependencies, task, candidate, mark, reject);
    if (plan === undefined) return false;
    const { catalogId, artifact, approved, canonicalApproval } = plan;
    // Application (v2) intents are verified by the application verification path (Task 2.4); this portable verifier never reads one.
    const portableIntent = portableFeatureIntentOf(approved.plan);
    if (!portableIntent.ok) return reject(portableIntent.reason);
    const e2eIntent = portableIntent.intent;
    const projectAuthority = await loadCurrentProjectAuthority(dependencies, task, mark, reject);
    if (projectAuthority === undefined) return false;
    const { project, latestProject, setupApproval, catalogKey, policy, orgId } = projectAuthority;
    const creator = await loadCurrentCreatorAuthority(dependencies, task, admission.creatorAuthority, mark, reject);
    if (creator === undefined) return false;
    const { creatorAuthority, creatorAccess, creatorMembershipKey, developer } = creator;
    stage = "candidate-source-operation";
    const sourceOperation = await candidateSourceOperation(dependencies, task, candidate.digest);
    if (!sourceOperation) return reject("candidate-source-operation-missing");
    stage = "candidate-source-export";
    const sourceExport = await loadWorkflowCandidateSourceExport(dependencies, sourceOperation, candidate);
    if (!sourceExport || sourceExport.repositories.length !== 1) return reject("candidate-source-export-missing-or-ambiguous");
    const repository = sourceExport.repositories[0]!;
    const snapshot: E2ESourceSnapshot = { candidate, commitSha: repository.commitSha, treeSha: repository.treeSha, treeComplete: true,
      treePaths: repository.treePaths, sources: repository.sources.map((source) => ({ path: source.path, sha256: source.sha256,
        kind: "blob" as const, bytes: Buffer.from(source.bytesBase64, "base64") })) };
    stage = "current-feature-runtime";
    const featureRow = await getItem<Record<string, unknown>>(dependencies, e2eFeatureVerifierKey(catalogId, policy.defaultSandboxProfileId));
    const runtimeBinding = parseRuntimeBinding(project.runtimeBinding);
    const parsedFeatureRow = featureRow === undefined || typeof featureRow.pk !== "string" || typeof featureRow.sk !== "string"
      ? undefined : E2EFeatureVerifierRecordSchema.safeParse(Object.fromEntries(Object.entries(featureRow).filter(([key]) => key !== "pk" && key !== "sk")));
    if (parsedFeatureRow === undefined || !parsedFeatureRow.success) return reject("current-feature-runtime-schema-invalid");
    const admittedRuntime = admitE2EFeatureVerifier(featureRow, { runtimeCatalogId: catalogId, profileId: policy.defaultSandboxProfileId,
      binding: runtimeBinding, scope: E2E_FEATURE_PROCESS_RESPONSE_SCOPE, now: Date.now() });
    if (!admittedRuntime) {
      const record = parsedFeatureRow.data;
      const expectedKey = e2eFeatureVerifierKey(catalogId, policy.defaultSandboxProfileId);
      if (featureRow?.pk !== expectedKey.pk || featureRow.sk !== expectedKey.sk) return reject("current-feature-runtime-storage-key-mismatch");
      if (record.state !== "READY") return reject("current-feature-runtime-not-ready");
      if (record.runtimeCatalogId !== catalogId || record.profileId !== policy.defaultSandboxProfileId) return reject("current-feature-runtime-catalog-or-profile-mismatch");
      if (record.bindingDigest !== projectSetupBindingDigest(runtimeBinding) || canonicalJson(record.binding) !== canonicalJson(runtimeBinding)) return reject("current-feature-runtime-binding-mismatch");
      if (!record.supportedFeatureScopes.includes(E2E_FEATURE_PROCESS_RESPONSE_SCOPE)) return reject("current-feature-runtime-scope-mismatch");
      if (Date.parse(record.qualifiedAt) > Date.now() || Date.parse(record.expiresAt) <= Date.now()) return reject("current-feature-runtime-freshness-mismatch");
      return reject("current-feature-runtime-admission-mismatch");
    }
    const planDigest = createHash("sha256").update(canonicalJson({
      domain: "workflow-feature-e2e-approved-plan/v1", taskId: task.taskId, artifactId: canonicalApproval.artifactId, artifactSha256: canonicalApproval.artifactDigest,
      graphDigest: canonicalApproval.graphDigest, graphRunId: canonicalApproval.runId, workflowRevision: canonicalApproval.workflowRevision, actorId: canonicalApproval.actorId,
    })).digest("hex");
    stage = "current-admission-derivation";
    const currentAdmission = deriveE2EFeatureExecutionAdmission({ intent: e2eIntent, snapshot, artifactId: artifact.id,
      artifactSha256: artifact.sha256, planDigest, policy, runtimeCatalogId: catalogId, runtimeBinding,
      featureVerifier: featureRow, now: Date.now() });
    const binding = admission.portableApprovalBinding as { semanticApproval?: { artifactId?: unknown; digest?: unknown }; planDigest?: unknown } | undefined;
    const semantic = binding?.semanticApproval;
    if (semantic?.artifactId !== artifact.id || semantic.digest !== artifact.sha256 || binding?.planDigest !== planDigest) return reject("canonical-approval-binding-mismatch");
    const approvalRecord = canonicalApproval;
    const authorityMatches = workflowE2ECurrentAuthorityMatches({
      admission: { candidateDigest: candidate.digest, intent: admission.intent, policy: admission.policy, runtime: admission.runtime,
        portableApprovalBinding: admission.portableApprovalBinding, creatorAuthority: admission.creatorAuthority, approval: approvalRecord },
      current: { candidateDigest: candidate.digest, intent: e2eIntent, policy, runtime: currentAdmission.runtime,
        portableApprovalBinding: currentAdmission.portableApprovalBinding, creatorAuthority, approval: approvalRecord, approvedDecision: true,
        creatorHasProjectAccess: true, now: Date.now() },
    }) && canonicalJson(admission.plan) === canonicalJson(currentAdmission.plan)
      && canonicalJson(admission.bundle) === canonicalJson(currentAdmission.bundle)
      && sameE2ESourceSnapshot(admittedSnapshot, snapshot);
    if (!authorityMatches) return reject("current-admission-runtime-plan-or-source-mismatch");
    const fences = await currentAuthorityFences(dependencies, task, { orgId, catalogKey, latestProject, setupApproval, policy, creatorAuthority, creatorAccess, creatorMembershipKey, developer }, reject);
    if (fences === undefined) return false;
    const key = e2eFeatureVerifierKey(catalogId, policy.defaultSandboxProfileId);
    const feature = parsedFeatureRow.data;
    const authorityChecks: Array<Record<string, unknown>> = [
      ...fences.base,
      { ConditionCheck: { TableName: dependencies.tableName, Key: key,
        ConditionExpression: "entityType = :entity AND #state = :ready AND runtimeCatalogId = :catalog AND catalogRevision = :catalogRevision AND profileId = :profile AND bindingDigest = :bindingDigest AND binding = :binding AND manifestDigest = :manifestDigest AND runnerEnvironmentDigest = :environmentDigest AND runnerEnvironment = :environment AND runnerToolchainDigest = :toolchainDigest AND runnerToolchain = :toolchain AND generation = :generation AND transportCorrelationId = :correlation AND supportedFeatureScopes = :scopes AND qualifiedAt = :qualifiedAt AND expiresAt = :expiresAt",
        ExpressionAttributeNames: { "#state": "state" },
        ExpressionAttributeValues: { ":entity": "E2E_FEATURE_VERIFIER", ":ready": "READY", ":catalog": feature.runtimeCatalogId,
          ":catalogRevision": feature.catalogRevision, ":profile": feature.profileId, ":bindingDigest": feature.bindingDigest, ":binding": feature.binding,
          ":manifestDigest": feature.manifestDigest, ":environmentDigest": feature.runnerEnvironmentDigest, ":environment": feature.runnerEnvironment,
          ":toolchainDigest": feature.runnerToolchainDigest, ":toolchain": feature.runnerToolchain, ":generation": feature.generation,
          ":correlation": feature.transportCorrelationId, ":scopes": feature.supportedFeatureScopes, ":qualifiedAt": feature.qualifiedAt, ":expiresAt": feature.expiresAt } } },
      ...fences.creator,
    ];
    if (diagnostic !== undefined) diagnostic.authorityChecks = authorityChecks;
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message.replace(/[^A-Za-z0-9 _./:-]/gu, "?").slice(0, 120) : "unknown-error";
    return reject(`current-authority-loader-exception:${stage}:${detail || "empty-error"}`);
  }
}

function storedAdmissionSchemaVersion(admissionText: string | undefined): string | undefined {
  if (admissionText === undefined) return undefined;
  try {
    const parsed = JSON.parse(admissionText) as { schemaVersion?: unknown };
    return typeof parsed?.schemaVersion === "string" ? parsed.schemaVersion : undefined;
  } catch { return undefined; }
}

const APPLICATION_VERDICT_REASON_MAX_CHARS = 240;

/**
 * The evidence an application round's operation has accepted, read back and held to the content addresses the broker recorded: the aggregate (when it was accepted), each accepted
 * group's evidence, and the broker's own receipt time of each group (when its upload started). The candidate's verification and the baseline's both start from this, so what a
 * round is judged on is read the same way for both. `unavailable` names the first thing that could not be read or does not match.
 */
export async function loadApplicationEvidenceInputs(dependencies: AwsBrokerDependencies, operation: OperationRecord, reference: E2EWorkflowAdmissionRef, admission: E2EApplicationExecutionAdmission):
  Promise<{ aggregate: unknown; groupEvidence: Map<string, unknown>; receivedAt: Map<string, string> } | { unavailable: string }> {
  const unavailableInputs = (reason: string) => ({ unavailable: reason });
  const limits = applicationEvidenceLimits(admission);
  const evidenceRef = operation.workflowE2EEvidenceRef;
  const groupEvidenceRefs = operation.workflowE2EGroupEvidenceRefs ?? [];
  const groupEvidenceRunIds = operation.workflowE2EGroupRunIds ?? [];
  if (groupEvidenceRefs.length !== groupEvidenceRunIds.length
    || canonicalJson(groupEvidenceRefs.map((raw) => E2EWorkflowGroupEvidenceRefSchema.parse(raw).groupRunId)) !== canonicalJson(groupEvidenceRunIds)
    || new Set(groupEvidenceRunIds).size !== groupEvidenceRunIds.length
    || groupEvidenceRunIds.some((runId) => !reference.groupRunIds.includes(runId))) return unavailableInputs("accepted-group-reference-list-invalid");
  if (evidenceRef === undefined && groupEvidenceRefs.length === 0) return unavailableInputs("group-results-not-yet-accepted");
  let aggregate: unknown;
  if (evidenceRef !== undefined) {
    const aggregateText = evidenceRef.key === `workflow-e2e-evidence/sha256/${evidenceRef.sha256}.json`
      ? await readStoredText(dependencies.s3, dependencies.artifactBucketName, evidenceRef.key, limits.aggregate) : undefined;
    if (aggregateText === undefined || createHash("sha256").update(aggregateText).digest("hex") !== evidenceRef.sha256 || Buffer.byteLength(aggregateText) !== evidenceRef.byteLength) {
      return unavailableInputs("admission-or-evidence-reference-integrity");
    }
    aggregate = JSON.parse(aggregateText) as unknown;
  }
  const groupEvidence = new Map<string, unknown>();
  const receivedAt = new Map<string, string>();
  for (const raw of groupEvidenceRefs) {
    const parsedRef = E2EWorkflowGroupEvidenceRefSchema.safeParse(raw);
    if (!parsedRef.success) return unavailableInputs("accepted-group-reference-schema");
    const { groupRunId, evidenceRef: stored } = parsedRef.data;
    const limit = limits.byGroup.get(groupRunId);
    if (limit === undefined || groupEvidence.has(groupRunId) || stored.key !== `workflow-e2e-group-evidence/sha256/${stored.sha256}.json`) return unavailableInputs("accepted-group-reference-subject");
    const groupText = await readStoredText(dependencies.s3, dependencies.artifactBucketName, stored.key, limit);
    if (groupText === undefined || Buffer.byteLength(groupText) !== stored.byteLength || createHash("sha256").update(groupText).digest("hex") !== stored.sha256) {
      return unavailableInputs("accepted-group-evidence-integrity");
    }
    groupEvidence.set(groupRunId, JSON.parse(groupText) as unknown);
    // The broker's own receipt of this group's evidence: the start of the upload that was accepted, recorded once with its row. A row that is not exactly this
    // operation's completed upload of exactly this content gives no receipt, and the group is then UNKNOWN.
    const upload = await getItem<Record<string, unknown>>(dependencies, { pk: `WORKSPACE#${operation.workspaceId}`, sk: `WORKFLOW_E2E_UPLOAD#${operation.id}#${groupRunId}` });
    const accepted = E2EWorkflowGroupEvidenceRefSchema.safeParse(upload?.groupEvidenceRef);
    if (upload?.entityType === "WORKFLOW_E2E_EVIDENCE_UPLOAD" && upload.status === "COMPLETE" && upload.operationId === operation.id && upload.groupRunId === groupRunId
      && upload.fence === operation.fence && upload.admissionSha256 === reference.admissionRef.sha256 && accepted.success && accepted.data.evidenceRef.sha256 === stored.sha256
      && typeof upload.receivedAt === "string") receivedAt.set(groupRunId, upload.receivedAt);
  }
  return { aggregate, groupEvidence, receivedAt };
}

/**
 * Independently decides what the stored evidence of an application round proves, for the result callback, the task presentation and publication alike. Everything the
 * verifier compares the worker's evidence with is the broker's: the stored admission, the operation's own reference and fence, the content-addressed evidence it accepted
 * itself, and the receipt time it recorded when each group's upload started. The verdict is then held to the current authority (creator, project, source, runtime rows),
 * so a round whose owner, source or runtime moved is UNKNOWN, as a portable round is.
 */
async function verifyApplicationWorkflowE2EEvidence(input: {
  dependencies: AwsBrokerDependencies; operation: OperationRecord; task: DeveloperTaskRecord; candidate: ReturnType<typeof CandidateManifestSchema.parse>;
  reference: E2EWorkflowAdmissionRef; admissionText: string; projection: WorkflowE2EProjection | undefined;
  diagnostic: WorkflowE2EVerificationDiagnostic | undefined; unavailable: (reason: string) => "UNKNOWN"; terminalStatus?: "SUCCEEDED" | "FAILED";
}): Promise<"PASS" | "FAILED" | "UNKNOWN"> {
  const { dependencies, operation, task, candidate, reference, admissionText, projection, diagnostic, unavailable } = input;
  const admissionBytes = Buffer.from(admissionText, "utf8");
  if (createHash("sha256").update(admissionBytes).digest("hex") !== reference.admissionRef.sha256 || admissionBytes.byteLength !== reference.admissionRef.byteLength) {
    return unavailable("admission-or-evidence-reference-integrity");
  }
  let admission: E2EApplicationExecutionAdmission;
  try { admission = decodeE2EApplicationExecutionAdmission(admissionBytes); } catch { return unavailable("application-admission-undecodable"); }
  const loaded = await loadApplicationEvidenceInputs(dependencies, operation, reference, admission);
  if ("unavailable" in loaded) return unavailable(loaded.unavailable);
  const { aggregate, groupEvidence, receivedAt } = loaded;
  const terminalStatus = input.terminalStatus ?? (operation.status === "SUCCEEDED" || operation.status === "FAILED" ? operation.status : undefined);
  // Task 4.4a (ruling DJ): a round with an AI navigation step is judged against the model route registry's own definition of the revision it was admitted under, never a definition the
  // worker uploads; one GetItem, only for a round that has such a step. A registry that cannot be asked leaves the round unverifiable, not judged.
  const route = await modelRouteForAdmission((key) => getItem<Record<string, unknown>>(dependencies, key), admission);
  if ("unavailable" in route) return unavailable(route.unavailable);
  const modelRouteDefinition = route.definition;
  const verified = verifyApplicationE2EEvidence({ admissionBytes, subject: { taskId: task.taskId, operationId: operation.id, operationFence: operation.fence, workflowRevision: reference.workflowRevision,
    candidateDigest: candidate.digest, roundId: reference.roundId, groupRunIds: reference.groupRunIds, admissionSha256: reference.admissionRef.sha256 },
  aggregate, groupEvidence, receivedAt, terminalStatus, ...(modelRouteDefinition === undefined ? {} : { modelRouteDefinition }) });
  const authorityValid = await workflowE2EApplicationAuthorityIsValid(dependencies, task, candidate, admission, diagnostic);
  if (projection !== undefined) {
    if (verified.plan !== undefined) projection.plan = verified.plan;
    if (verified.round !== undefined) projection.round = verified.round;
    if (authorityValid) {
      projection.results.push(...verified.results);
      if (verified.display !== undefined) projection.display = verified.display;
    }
  }
  if (!authorityValid) return unavailable(diagnostic?.reason ?? "current-owner-policy-source-or-runtime-authority");
  if (verified.verdict !== "PASS" && diagnostic !== undefined) {
    diagnostic.reason = cutEvidenceReason(verified.reason.replace(/\p{Cc}+/gu, " ").replace(/\s+/gu, " ").trim(), APPLICATION_VERDICT_REASON_MAX_CHARS);
  }
  return verified.verdict;
}

/**
 * M1.3 Task 3.7b: the baseline round's own completion. When its operation ends, this settles the baseline's record, and does nothing else: no workflow transition, no
 * `qualifiedRound` or `failedRound`, no send-back, no publication. An operation that did not succeed leaves the record saying the unchanged code could not be checked; one that
 * succeeded is verified exactly as a candidate's evidence is read (`loadApplicationEvidenceInputs`, then the verifier for the purpose it was signed with), and only that
 * verification's rows are recorded, conditionally, on the plan, base commit, attempt, operation and round the record started. It never throws: whatever goes wrong here, the baseline
 * is a record that stays STARTED and is shown as not run once its time is up.
 */
export async function settleBaselineRound(dependencies: AwsBrokerDependencies, operation: OperationRecord, status: OperationStatus): Promise<void> {
  const reference = operation.workflowE2EAdmission;
  if (operation.kind !== "task" || reference?.purpose !== "baseline" || reference.baseCommitSha === undefined || reference.attempt === undefined) return;
  try {
    const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(reference.taskId));
    if (task === undefined || task.workspaceId !== operation.workspaceId) return;
    const record = await readWorkflowE2EBaselineRecord(dependencies, task);
    if (record === undefined || record.state !== "STARTED" || record.operationId !== operation.id) return;
    const unavailable = (reason: BaselineUnavailableReason) => markWorkflowE2EBaselineUnavailable(dependencies, task, reason, { from: ["STARTED"], operationId: operation.id });
    // A baseline cancelled while its record still says it is running was stopped by someone (the system marks the record before it cancels a round that ran out of time).
    if (status !== "SUCCEEDED") { await unavailable(status === "CANCELLED" ? "stopped" : "run-failed"); return; }
    const verified = await verifyBaselineRound(dependencies, operation, reference, record.skippedAiScenarios);
    if (verified === undefined) { await unavailable("unverified"); return; }
    await recordWorkflowE2EBaseline({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, s3: dependencies.s3, artifactBucketName: dependencies.artifactBucketName }, task,
      { verified, expected: { operationId: operation.id, roundId: reference.roundId, admissionSha256: reference.admissionRef.sha256, baseCommitSha: reference.baseCommitSha, attempt: reference.attempt } });
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "workflow.e2e_baseline_settle_failed", taskId: reference.taskId, operationId: operation.id, errorName: error instanceof Error ? error.name : "unknown" }));
  }
}

/** The broker's own verification of a finished baseline round's evidence, or undefined when the admission or the evidence cannot be read or verify to no rows. */
async function verifyBaselineRound(dependencies: AwsBrokerDependencies, operation: OperationRecord, reference: E2EWorkflowAdmissionRef, skippedAiScenarios?: SkippedAiScenarios) {
  const admissionText = await readStoredText(dependencies.s3, dependencies.artifactBucketName, reference.admissionRef.key, WORKFLOW_E2E_ADMISSION_MAX_BYTES);
  if (admissionText === undefined) return undefined;
  const admissionBytes = Buffer.from(admissionText, "utf8");
  if (createHash("sha256").update(admissionBytes).digest("hex") !== reference.admissionRef.sha256 || admissionBytes.byteLength !== reference.admissionRef.byteLength) return undefined;
  let admission: E2EApplicationExecutionAdmission;
  try { admission = decodeE2EApplicationExecutionAdmission(admissionBytes); } catch { return undefined; }
  const loaded = await loadApplicationEvidenceInputs(dependencies, operation, reference, admission);
  if ("unavailable" in loaded) return undefined;
  return verifyBaselineEvidence({ admissionBytes, subject: { taskId: reference.taskId, operationId: operation.id, operationFence: operation.fence, workflowRevision: reference.workflowRevision,
    candidateDigest: reference.candidateDigest, roundId: reference.roundId, groupRunIds: reference.groupRunIds, admissionSha256: reference.admissionRef.sha256 },
  aggregate: loaded.aggregate, groupEvidence: loaded.groupEvidence, receivedAt: loaded.receivedAt, terminalStatus: "SUCCEEDED", ...(skippedAiScenarios === undefined ? {} : { skippedAiScenarios }) });
}

/**
 * M1.4 Task 4.6b: the audit replay's own completion. When its operation ends, this settles the replay's record, and does nothing else: no workflow transition, no `qualifiedRound` or
 * `failedRound`, no send-back, no publication, no task page. An operation that did not succeed leaves the record saying the replay could not be run; one that succeeded is verified exactly
 * as a candidate's evidence is read (`loadApplicationEvidenceInputs`, then the verifier for the purpose it was signed with), and only that verification is recorded, conditionally, on the
 * source round, attempt, operation, round and admission the record started. It never throws: whatever goes wrong here, the replay is a record that stays STARTED and is read as not run
 * once its time is up.
 */
export async function settleReplayRound(dependencies: AwsBrokerDependencies, operation: OperationRecord, status: OperationStatus): Promise<void> {
  const reference = operation.workflowE2EAdmission;
  if (operation.kind !== "task" || reference?.purpose !== "replay" || reference.sourceRoundId === undefined || reference.attempt === undefined) return;
  try {
    const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(reference.taskId));
    if (task === undefined || task.workspaceId !== operation.workspaceId) return;
    const round = { sourceRoundId: reference.sourceRoundId, attempt: reference.attempt };
    const record = await readWorkflowE2EReplayRecord(dependencies, task.taskId, round);
    if (record === undefined || record.state !== "STARTED" || record.operationId !== operation.id) return;
    const unavailable = (reason: ReplayUnavailableReason) => markWorkflowE2EReplayUnavailable(dependencies, task, round, reason, { from: ["STARTED"], operationId: operation.id });
    if (status !== "SUCCEEDED") { await unavailable(status === "CANCELLED" ? "stopped" : "run-failed"); return; }
    const verified = await verifyReplayRound(dependencies, operation, reference);
    if (verified === undefined) { await unavailable("unverified"); return; }
    await recordWorkflowE2EReplay(dependencies, task, { verified, expected: { ...round, operationId: operation.id, roundId: reference.roundId, admissionSha256: reference.admissionRef.sha256 } });
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "workflow.e2e_replay_settle_failed", taskId: reference.taskId, operationId: operation.id, errorName: error instanceof Error ? error.name : "unknown" }));
  }
}

/** The broker's own verification of a finished replay round's evidence, or undefined when the admission or the evidence cannot be read or verify to nothing. */
async function verifyReplayRound(dependencies: AwsBrokerDependencies, operation: OperationRecord, reference: E2EWorkflowAdmissionRef) {
  const admissionText = await readStoredText(dependencies.s3, dependencies.artifactBucketName, reference.admissionRef.key, WORKFLOW_E2E_ADMISSION_MAX_BYTES);
  if (admissionText === undefined) return undefined;
  const admissionBytes = Buffer.from(admissionText, "utf8");
  if (createHash("sha256").update(admissionBytes).digest("hex") !== reference.admissionRef.sha256 || admissionBytes.byteLength !== reference.admissionRef.byteLength) return undefined;
  let admission: E2EApplicationExecutionAdmission;
  try { admission = decodeE2EApplicationExecutionAdmission(admissionBytes); } catch { return undefined; }
  if (admission.replay === undefined) return undefined;
  const loaded = await loadApplicationEvidenceInputs(dependencies, operation, reference, admission);
  if ("unavailable" in loaded) return undefined;
  return verifyReplayEvidence({ admissionBytes, subject: { taskId: reference.taskId, operationId: operation.id, operationFence: operation.fence, workflowRevision: reference.workflowRevision,
    candidateDigest: reference.candidateDigest, roundId: reference.roundId, groupRunIds: reference.groupRunIds, admissionSha256: reference.admissionRef.sha256 },
  aggregate: loaded.aggregate, groupEvidence: loaded.groupEvidence, receivedAt: loaded.receivedAt, terminalStatus: "SUCCEEDED", replay: admission.replay });
}

/**
 * T7b: the grounding round's own completion. When its operation ends, this settles the grounding record, and does nothing else: no workflow transition, no `qualifiedRound` or `failedRound`,
 * no send-back, no publication, no model spend. An operation that did not succeed leaves the record saying the plan could not be checked on the current app (a fixed reason); one that
 * succeeded is verified exactly as a candidate's evidence is read (`loadApplicationEvidenceInputs`, then the verifier for the purpose it was signed with, bound to the plan digest and base
 * commit recomputed from the record), and only that verification is recorded, conditionally, on the plan artifact, base commit, attempt, operation, round and admission the record started.
 * It never throws: whatever goes wrong here, the record stays STARTED and is read as not run once its time is up. Whoever holds the plan's card back reads the record afterwards.
 */
export async function settleGroundingRound(dependencies: AwsBrokerDependencies, operation: OperationRecord, status: OperationStatus): Promise<void> {
  const reference = operation.workflowE2EAdmission;
  if (operation.kind !== "task" || reference?.purpose !== "grounding" || reference.baseCommitSha === undefined || reference.attempt === undefined || reference.planArtifactSha256 === undefined) return;
  try {
    const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(reference.taskId));
    if (task === undefined || task.workspaceId !== operation.workspaceId) return;
    const ref = { taskId: task.taskId, planArtifactSha256: reference.planArtifactSha256, attempt: reference.attempt };
    const record = await readWorkflowE2EGroundingRecord(dependencies, ref);
    if (record === undefined || record.state !== "STARTED" || record.operationId !== operation.id) return;
    const unavailable = (reason: GroundingUnavailableReason) => markWorkflowE2EGroundingUnavailable(dependencies, ref, reason, { from: ["STARTED"], operationId: operation.id });
    if (status !== "SUCCEEDED") { await unavailable(status === "CANCELLED" ? "stopped" : "run-failed"); return; }
    const verified = await verifyGroundingRound(dependencies, operation, reference, record);
    if (verified === undefined) { await unavailable("unverified"); return; }
    await recordWorkflowE2EGrounding({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, s3: dependencies.s3, artifactBucketName: dependencies.artifactBucketName }, task, ref,
      { verified, expected: { operationId: operation.id, roundId: reference.roundId, admissionSha256: reference.admissionRef.sha256, baseCommitSha: reference.baseCommitSha } });
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "workflow.e2e_grounding_settle_failed", taskId: reference.taskId, operationId: operation.id, errorName: error instanceof Error ? error.name : "unknown" }));
  }
}

/** The broker's own verification of a finished grounding round's evidence, or undefined when the admission or the evidence cannot be read or verify to no rows. */
async function verifyGroundingRound(dependencies: AwsBrokerDependencies, operation: OperationRecord, reference: E2EWorkflowAdmissionRef, record: GroundingRecord) {
  const admissionText = await readStoredText(dependencies.s3, dependencies.artifactBucketName, reference.admissionRef.key, WORKFLOW_E2E_ADMISSION_MAX_BYTES);
  if (admissionText === undefined || reference.baseCommitSha === undefined || reference.attempt === undefined) return undefined;
  const admissionBytes = Buffer.from(admissionText, "utf8");
  if (createHash("sha256").update(admissionBytes).digest("hex") !== reference.admissionRef.sha256 || admissionBytes.byteLength !== reference.admissionRef.byteLength) return undefined;
  let admission: E2EApplicationExecutionAdmission;
  try { admission = decodeE2EApplicationExecutionAdmission(admissionBytes); } catch { return undefined; }
  const loaded = await loadApplicationEvidenceInputs(dependencies, operation, reference, admission);
  if ("unavailable" in loaded) return undefined;
  const planDigest = groundingPlanDigest({ taskId: reference.taskId, artifactId: record.planArtifactId, artifactSha256: record.planArtifactSha256, workflowRevision: reference.workflowRevision,
    baseCommitSha: reference.baseCommitSha, attempt: reference.attempt });
  return verifyGroundingEvidence({ admissionBytes, subject: { taskId: reference.taskId, operationId: operation.id, operationFence: operation.fence, workflowRevision: reference.workflowRevision,
    candidateDigest: reference.candidateDigest, roundId: reference.roundId, groupRunIds: reference.groupRunIds, admissionSha256: reference.admissionRef.sha256 },
  aggregate: loaded.aggregate, groupEvidence: loaded.groupEvidence, receivedAt: loaded.receivedAt, terminalStatus: "SUCCEEDED", grounding: { planDigest, baseCommitSha: reference.baseCommitSha } });
}

/**
 * The current authority an application round's verdict stands on, held against what the round was admitted under: the approved plan and its recorded selection, the
 * pinned project and its policy, the creator's access (exactly the proof the admission carries), the candidate's exported source, and the runtime rows. A row that is not
 * exactly the admitted one was requalified (or revoked, or expired) during the round, and the evidence cannot be judged against a runtime that has moved. The rows are also
 * returned as conditions, so the transaction that records the verdict fails if any of this moves after it was checked. Exported for tests.
 */
export async function workflowE2EApplicationAuthorityIsValid(
  dependencies: AwsBrokerDependencies, task: DeveloperTaskRecord, candidate: ReturnType<typeof CandidateManifestSchema.parse>, admission: E2EApplicationExecutionAdmission,
  diagnostic?: WorkflowE2EVerificationDiagnostic,
): Promise<boolean> {
  const reject = (reason: string): false => { if (diagnostic !== undefined) diagnostic.reason = reason; return false; };
  if (diagnostic !== undefined) diagnostic.authorityEvaluated = true;
  let stage = "workflow";
  const mark: AuthorityMark = (next) => { stage = next; };
  try {
    const plan = await loadCurrentApprovedPlan(dependencies, task, candidate, mark, reject);
    if (plan === undefined) return false;
    const { e2e, artifact, approved } = plan;
    // An application admission is only ever verified for an approved application (v2) plan, and only for the intent that plan carries and the selection recorded for it.
    const storedIntent = approved.plan.e2e;
    if (storedIntent?.schemaVersion !== 2) return reject("application-admission-needs-application-plan");
    // The stored plan is the planner's: it leaves out what the schema makes optional, which the admission writes out as empty lists. Both sides are therefore held in the
    // form the admission builder derives its intent in (`applicationRoundIntent`), and the plan is bound to the approval record by the digest approval recorded.
    const parsedIntent = E2EApplicationPlanIntentSchema.safeParse(storedIntent);
    if (!parsedIntent.success) return reject("approved-plan-intent-is-not-readable");
    const intent = parsedIntent.data;
    const recorded = E2EApplicationSelectionRecordSchema.safeParse(e2e.applicationSelection);
    if (!recorded.success) return reject("no-recorded-application-selection");
    // The round ran with the account refs approval pinned, not the ones the stored plan was written with (they are the same until the plan is approved again).
    if (canonicalJson(applicationRoundIntent(applicationIntentWithAccountRefs(intent, recorded.data.accountRefs))) !== canonicalJson(admission.intent)) return reject("approved-plan-is-not-the-admitted-intent");
    const projectAuthority = await loadCurrentProjectAuthority(dependencies, task, mark, reject);
    if (projectAuthority === undefined) return false;
    const { latestProject, setupApproval, catalogKey, policy, orgId } = projectAuthority;
    // The admitted policy is the project's with the signed-out variants derived from its base targets (Ruling AZ, derived, never stored): held to the project's, each derived target
    // must be exactly the variant of a base target the project's policy holds.
    const admittedPolicy = E2EPolicySchema.parse(admission.policy);
    const derivedVariant = (target: E2EPolicy["targets"][number]) => target.accountProfileId === E2E_ANONYMOUS_ACCOUNT_PROFILE_ID
      && policy.targets.some((base) => base.kind === target.kind && e2eAnonymousTargetId(base.targetId) === target.targetId && canonicalJson(e2eAnonymousVariantOf(base)) === canonicalJson(target));
    if (canonicalJson(policy) !== canonicalJson({ ...admittedPolicy, targets: admittedPolicy.targets.filter((target) => !derivedVariant(target)) })) return reject("current-project-policy-or-runtime-changed");
    const creator = await loadCurrentCreatorAuthority(dependencies, task, admission.creatorAuthority, mark, reject);
    if (creator === undefined) return false;
    const { creatorAuthority, creatorAccess, creatorMembershipKey, developer } = creator;
    mark("candidate-source-export");
    const sourceOperation = await candidateSourceOperation(dependencies, task, candidate.digest);
    if (!sourceOperation) return reject("candidate-source-operation-missing");
    const sourceExport = await loadWorkflowCandidateSourceExport(dependencies, sourceOperation, candidate);
    if (!sourceExport || sourceExport.repositories.length !== 1) return reject("candidate-source-export-missing-or-ambiguous");
    const repository = sourceExport.repositories[0]!;
    const snapshot: E2ESourceSnapshot = { candidate, commitSha: repository.commitSha, treeSha: repository.treeSha, treeComplete: true,
      treePaths: repository.treePaths, sources: repository.sources.map((source) => ({ path: source.path, sha256: source.sha256, kind: "blob" as const, bytes: Buffer.from(source.bytesBase64, "base64") })) };
    const admittedSnapshot: E2ESourceSnapshot = { ...admission.sourceSnapshot, sources: admission.sourceSnapshot.sources.map((source) => ({ path: source.path, sha256: source.sha256,
      kind: "blob" as const, bytes: Buffer.from(source.bytesBase64, "base64") })) };
    if (!sameE2ESourceSnapshot(admittedSnapshot, snapshot) || admission.candidateCommitSha !== snapshot.commitSha || admission.candidateTreeSha !== snapshot.treeSha) {
      return reject("current-admission-runtime-plan-or-source-mismatch");
    }
    mark("current-runtime-rows");
    const current = await evaluateWorkflowE2EApplicationSelectionNow(dependencies, task, intent, artifact, { mode: "current", pinned: recorded.data.accountRefs });
    if (!current.ok) {
      if (current.kind === "refused" && current.scope === "runtime" && diagnostic !== undefined) diagnostic.runtimeChange = "unusable";
      if (current.kind === "refused" && current.scope === "accounts" && diagnostic !== undefined) diagnostic.runtimeChange = "accounts";
      return reject(`${current.kind === "unevaluable" ? "application-selection-unavailable" : "application-selection-refused"}: ${current.reason}`);
    }
    // The runtime rows the round was admitted on are the rows it is judged on: a row that is gone, not ready, or not exactly the admitted one was changed under the round.
    for (const { value: admitted } of admission.runtimeBindings) {
      const row = current.inputs.rows.find((item) => item.capabilities.kind === admitted.capabilities.kind && item.profileId === admitted.profileId);
      const label = `${admitted.capabilities.kind} runtime ${admitted.profileId}`;
      if (row === undefined) {
        if (diagnostic !== undefined) diagnostic.runtimeChange = "unusable";
        return reject(`the ${label} this round was admitted on is not ready now`);
      }
      if (canonicalJson(row) !== canonicalJson(admitted)) {
        if (diagnostic !== undefined) diagnostic.runtimeChange = "requalified";
        return reject(`the ${label} was requalified during the round (${changedRuntimeFields(row, admitted)})`);
      }
    }
    const unchanged = applicationSelectionStillCurrent(recorded.data, current.selection);
    if (!unchanged.ok) return reject(`application-selection-changed: ${unchanged.reason}`);
    if (canonicalJson(admission.selectionInput.approvedSemanticApproval) !== canonicalJson(recorded.data.semanticApproval)
      || canonicalJson(admission.selectionInput.setupApproval) !== canonicalJson(recorded.data.setupApproval)
      || applicationIntentDigest(intent) !== recorded.data.intentDigest
      || admission.intentDigest !== createHash("sha256").update(canonicalJson(admission.intent)).digest("hex")) return reject("canonical-approval-binding-mismatch");
    const fences = await currentAuthorityFences(dependencies, task, { orgId, catalogKey, latestProject, setupApproval, policy, creatorAuthority, creatorAccess, creatorMembershipKey, developer }, reject);
    if (fences === undefined) return false;
    // Each runtime row the verdict rests on, exactly as read, sits between the project's fences and the creator's.
    const authorityChecks = [...fences.base, ...current.conditions as Array<Record<string, unknown>>, ...fences.creator];
    if (diagnostic !== undefined) diagnostic.authorityChecks = authorityChecks;
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message.replace(/[^A-Za-z0-9 _./:-]/gu, "?").slice(0, 120) : "unknown-error";
    return reject(`current-authority-loader-exception:${stage}:${detail || "empty-error"}`);
  }
}

/** What moved in a runtime row that is not the admitted one: its generation if that did, else its expiry or qualification time, else that its record changed. */
function changedRuntimeFields(now: E2ERegisteredRuntime, admitted: E2ERegisteredRuntime): string {
  const moved = (["generation", "expiresAt", "qualifiedAt"] as const).find((field) => now[field] !== admitted[field]);
  if (moved === undefined) return "another field of its record changed";
  return moved === "generation" ? `generation ${now.generation} now, ${admitted.generation} when admitted` : `${moved} now ${now[moved]}, ${admitted[moved]} when admitted`;
}

export async function workflowE2ECreatorAuthorityProof(
  dependencies: AwsBrokerDependencies,
  task: DeveloperTaskRecord,
  membership: Record<string, unknown> | undefined,
  access: Awaited<ReturnType<typeof checkProjectAccess>>,
  orgMember: { role: OrgRole; memberUpdatedAt: string } | undefined,
): Promise<({ kind: "direct-membership"; developerId: string; project: string; role: "developer" | "administrator"; grantId: string }
  | { kind: "org-role"; developerId: string; project: string; orgId: OrgId; role: "owner" | "admin"; memberUpdatedAt: string }
  | { kind: "channel-access"; developerId: string; project: string; teamId: string; channelIds: string[]; bindings: Array<{ channelId: string; updatedAt: string }> }) | undefined> {
  const owner = effectiveTaskOwner(task);
  if (membership?.entityType === "MEMBERSHIP" && membership.ownerKey === owner.developerId && membership.projectName === task.project
    && (membership.role === "developer" || membership.role === "administrator") && typeof membership.grantId === "string"
    && /^[0-9a-f-]{36}$/iu.test(membership.grantId)) {
    return { kind: "direct-membership", developerId: owner.developerId, project: task.project, role: membership.role, grantId: membership.grantId };
  }
  // No grant, but a live org owner or admin, who maintains every project in the org. The record is the one read for this round.
  if (orgMember !== undefined && (orgMember.role === "owner" || orgMember.role === "admin")) {
    return { kind: "org-role", developerId: owner.developerId, project: task.project, orgId: await orgOfRecord(dependencies, task),
      role: orgMember.role, memberUpdatedAt: orgMember.memberUpdatedAt };
  }
  if (access.access !== "channel" || dependencies.developer?.slackTeamId === undefined || access.channelIds.length === 0) return undefined;
  const teamId = dependencies.developer.slackTeamId;
  const channelIds = [...new Set(access.channelIds)].sort();
  const bindings: Array<{ channelId: string; updatedAt: string }> = [];
  for (const channelId of channelIds) {
    const row = await getItem<Record<string, unknown>>(dependencies, slackBindingKey(await orgOfRecord(dependencies, task), teamId, channelId));
    if (row?.teamId !== teamId || row.channelId !== channelId || row.projectName !== task.project
      || typeof row.updatedAt !== "string" || row.updatedAt.length === 0) return undefined;
    bindings.push({ channelId, updatedAt: row.updatedAt });
  }
  return { kind: "channel-access", developerId: owner.developerId, project: task.project, teamId, channelIds, bindings };
}

function sameE2ESourceSnapshot(left: E2ESourceSnapshot, right: E2ESourceSnapshot): boolean {
  if (canonicalJson(left.candidate) !== canonicalJson(right.candidate) || left.commitSha !== right.commitSha || left.treeSha !== right.treeSha
    || left.treeComplete !== right.treeComplete || canonicalJson(left.treePaths) !== canonicalJson(right.treePaths)
    || left.sources.length !== right.sources.length) return false;
  const rightByPath = new Map(right.sources.map((source) => [source.path, source]));
  return left.sources.every((source) => {
    const actual = rightByPath.get(source.path);
    return actual !== undefined && source.sha256 === actual.sha256 && source.kind === actual.kind
      && Buffer.from(source.bytes).equals(Buffer.from(actual.bytes));
  });
}

/** Builds task projections only after reloading and independently qualifying the stored current CHECKS evidence. */
export async function workflowE2EPresentation(
  dependencies: AwsBrokerDependencies,
  task: DeveloperTaskRecord,
  operations: readonly unknown[],
  actor: "owner" | "viewer",
  /** A CHECKS operation whose terminal state is being written by the caller and is not yet in its stored record. */
  ending?: { operationId: string; status: "SUCCEEDED" | "FAILED" },
): Promise<NonNullable<DeveloperTaskView["e2ePresentation"]> | undefined> {
  return (await workflowE2EPresentationDetailed(dependencies, task, operations, actor, ending))?.presentation;
}

/** The page HTML and Slack blocks of a presentation with the rows added: the rows' section joins the page HTML only while the whole stays within the presentation's bound. */
function presentationWithResults(taskId: string, shared: E2ESharedView, results: E2EScenarioResults | undefined): { pageHtml: string; slackBlocks: unknown[] } {
  const artifactPath = (sha256: string) => `/review/${taskId}/task/api/e2e/artifacts/${sha256}`;
  const base = renderE2EPageHtml(shared);
  const candidates = results === undefined ? [] : [results, ...(results.baseline === undefined ? [] : [{ scenarios: results.scenarios }])];
  const section = candidates.map((candidate) => renderE2EScenarioRowsHtml(candidate, { artifactPath })).find((html) => base.length + html.length <= 65_536) ?? "";
  return { pageHtml: `${base}${section}`, slackBlocks: [...(results === undefined ? [] : renderE2EScenarioSlackBlocks(results)), ...renderE2ESlackBlocks(shared)].slice(0, 16) };
}

/**
 * The presentation of a task's current browser and API or portable round, and (for a browser and API round) its per-scenario rows and the screenshots behind them. The rows
 * are derived by the verification from evidence the broker re-collected itself; the baseline, when there is one, is the record of the informational round on the unchanged code.
 */
export async function workflowE2EPresentationDetailed(
  dependencies: AwsBrokerDependencies,
  task: DeveloperTaskRecord,
  operations: readonly unknown[],
  actor: "owner" | "viewer",
  ending?: { operationId: string; status: "SUCCEEDED" | "FAILED" },
): Promise<{ presentation: NonNullable<DeveloperTaskView["e2ePresentation"]>; scenarioResults?: E2EScenarioResults; artifacts: readonly DisplayArtifact[] } | undefined> {
  const workflow = task.workflow;
  const progress = workflow?.e2e;
  const candidateResult = CandidateManifestSchema.safeParse(workflow?.candidate);
  if (workflow === undefined || progress?.required !== true
    || candidateResult.success !== true || candidateResult.data.digest !== workflow.candidate?.digest) return undefined;
  if (task.closedAt !== undefined) {
    const qualified = progress.qualifiedRound;
    const failed = progress.failedRound;
    const round = qualified ?? failed;
    const roundMatchesClosedTask = round !== undefined && round.candidateDigest === candidateResult.data.digest
      && round.roundId === progress.currentRoundId && round.groupRunIds.length === progress.currentGroupRunIds.length
      && round.groupRunIds.every((runId, index) => runId === progress.currentGroupRunIds[index]);
    let captured: Awaited<ReturnType<typeof readWorkflowE2ENotifierProjection>>;
    if (roundMatchesClosedTask && round !== undefined && progress.displayRef !== undefined) {
      captured = await readWorkflowE2ENotifierProjection({
        ref: progress.displayRef, ownerKey: task.ownerKey, workspaceId: task.workspaceId,
        current: { candidateDigest: round.candidateDigest, roundId: round.roundId, groupRunIds: [...round.groupRunIds],
          admissionSha256: round.admissionSha256, evidenceSha256: round.evidenceSha256 },
        readPrivateObject: async (key, maxBytes) => {
          try {
            const object = await dependencies.s3.send(new GetObjectCommand({ Bucket: dependencies.artifactBucketName, Key: key })) as { ContentLength?: number; Body?: { transformToByteArray(): Promise<Uint8Array> } };
            if (!Number.isSafeInteger(object.ContentLength) || object.ContentLength! > maxBytes) return undefined;
            const bytes = await object.Body?.transformToByteArray();
            return bytes !== undefined && bytes.byteLength === object.ContentLength && bytes.byteLength <= maxBytes ? bytes : undefined;
          } catch { return undefined; }
        },
      });
    }
    const current = E2ESharedViewSchema.parse({ schemaVersion: 1,
      setup: { status: "unavailable", selectedTargetIds: [], executionPlanDigest: null, blockingInputIds: [], mockSubstitutableInputIds: [] },
      e2e: { status: "UNKNOWN", label: "Current eligibility unavailable: task closed.", executionPlanDigest: null,
        expectedGroups: 0, receivedGroups: 0, executedCases: 0, qualifiedCriteria: 0, requiredCriteria: 0,
        unavailableCriteria: 0, optionalUnavailableCriteria: 0, mockedComponentIds: [], observedMockedComponentIds: [],
        unexercisedBehaviors: [], policyPresence: "absent", workflowPhase: "closed", requiredUnexercisedCriteriaIds: [] }, actions: [] });
    const historyMatchesCloseTime = captured !== undefined && Date.parse(captured.capturedAt) <= Date.parse(task.closedAt);
    const history = historyMatchesCloseTime && captured !== undefined && (qualified !== undefined ? captured.view.e2e.status === "PASS"
      : failed !== undefined && captured.view.e2e.status === "FAILED") ? captured : undefined;
    const historicalHtml = history === undefined ? "" : `<section aria-labelledby="e2e-historical-${history.roundId}"><h2 id="e2e-historical-${history.roundId}">Recorded historical E2E result</h2><p>Recorded ${history.view.e2e.status} at ${history.capturedAt}; this is not current eligibility.</p>${renderE2EPageHtml(history.view).replaceAll("e2e-summary", `e2e-historical-summary-${history.roundId}`)}</section>`;
    const scope = history === undefined
      ? "Current eligibility unavailable: task closed. No verified historical E2E display is available."
      : `Current eligibility unavailable: task closed. Recorded historical ${history.view.e2e.status} at ${history.capturedAt}, candidate ${history.candidateDigest}, round ${history.roundId}; groups ${history.view.e2e.receivedGroups}/${history.view.e2e.expectedGroups}, cases ${history.view.e2e.executedCases}, criteria ${history.view.e2e.qualifiedCriteria}/${history.view.e2e.requiredCriteria}; these counts are historical only.`;
    const currentHtml = `<section aria-labelledby="e2e-current-eligibility"><h2 id="e2e-current-eligibility">Current E2E eligibility</h2><p>Unavailable because the task is closed. No current run counts are available.</p></section>`;
    const currentSlack = { type: "section", text: { type: "mrkdwn", text: "*Current E2E eligibility: UNKNOWN*\nTask closed. No current run counts are available." } };
    // A closed task keeps showing the rows its display recorded, as history: they are not current eligibility either.
    const recordedRows = history?.scenarioResults;
    const recordedRowsHtml = recordedRows === undefined ? "" : renderE2EScenarioRowsHtml(recordedRows, { artifactPath: (sha256) => `/review/${task.taskId}/task/api/e2e/artifacts/${sha256}` });
    const closedPageHtml = `${currentHtml}${historicalHtml}`;
    return { presentation: { shared: current,
      slackBlocks: [currentSlack, ...(history === undefined ? [] : renderE2ENotifierSlackBlocks(history.view,
        { candidateDigest: history.candidateDigest, roundId: history.roundId, capturedAt: history.capturedAt, ...(recordedRows === undefined ? {} : { scenarioResults: recordedRows }) }))].slice(0, 16),
      pageHtml: (closedPageHtml.length + recordedRowsHtml.length <= 65_536 ? `${closedPageHtml}${recordedRowsHtml}` : closedPageHtml).slice(0, 65_536),
      mcp: { ...renderE2EMcpProjection(current), scope: `${renderE2EMcpProjection(current).scope} ${scope}`.slice(0, 2_000) } },
      ...(recordedRows === undefined ? {} : { scenarioResults: recordedRows }), artifacts: [] };
  }
  const failedRound = progress.failedRound;
  const staleFailure = workflow.stage === "IMPLEMENT" && failedRound?.status === "FAILED"
    && failedRound.candidateDigest === candidateResult.data.digest;
  const presentationRoundId = staleFailure ? failedRound.roundId : progress.currentRoundId;
  if (presentationRoundId === undefined) return undefined;
  for (const raw of operations) {
    if (typeof raw !== "object" || raw === null || !("id" in raw) || typeof raw.id !== "string" || !("workflowMode" in raw) || raw.workflowMode !== "CHECKS") continue;
    const operation = await getItem<OperationRecord>(dependencies, operationKey(task.workspaceId, raw.id));
    const admission = operation?.workflowE2EAdmission;
    if (operation === undefined || operation.kind !== "task" || operation.workflowMode !== "CHECKS" || admission === undefined
      || admission.taskId !== task.taskId || admission.roundId !== presentationRoundId
      || admission.candidateDigest !== candidateResult.data.digest
      || operation.workflowE2EEvidenceRef === undefined && (operation.workflowE2EGroupEvidenceRefs?.length ?? 0) === 0) continue;
    if (staleFailure && (operation.workflowE2EEvidenceRef === undefined || failedRound.admissionSha256 !== admission.admissionRef.sha256
      || failedRound.evidenceSha256 !== operation.workflowE2EEvidenceRef.sha256
      || canonicalJson(failedRound.groupRunIds) !== canonicalJson(admission.groupRunIds))) continue;
    const projection: WorkflowE2EProjection & { allowStaleProjection: boolean } = { results: [], allowStaleProjection: staleFailure };
    await verifyWorkflowE2EEvidence(dependencies, operation, task, candidateResult.data, projection, undefined, ending?.operationId === operation.id ? { terminalStatus: ending.status } : undefined);
    if (projection.plan === undefined || projection.round === undefined) return undefined;
    const selectedTargetIds: string[] = [];
    const plan = projection.plan as Record<string, unknown>;
    if (typeof plan.digest !== "string" || !Array.isArray(plan.effectiveTargets)) return undefined;
    for (const target of plan.effectiveTargets as unknown[]) {
      if (typeof target !== "object" || target === null || Array.isArray(target)
        || !("targetId" in target) || typeof target.targetId !== "string") return undefined;
      selectedTargetIds.push(target.targetId);
    }
    const shared = buildE2ESharedView({
      plan: projection.plan,
      currentRound: projection.round,
      // After SendBack the old receipts are retained for explanation, but they cannot qualify the new candidate.
      // Keeping the authenticated plan and round with no current results preserves the obligation as UNKNOWN.
      results: staleFailure ? [] : projection.results,
      setup: { status: "unavailable", selectedTargetIds, executionPlanDigest: plan.digest, blockingInputIds: [], mockSubstitutableInputIds: [] },
      actor,
      control: { policyPresent: true, workflowPhase: "e2e", ownerActionProposals: [] },
    });
    // The per-scenario rows of a browser and API round (display schema v2), shown for the task's current round only: after SendBack the old round's rows are not shown as
    // current. The baseline is the informational record of the round on the unchanged code, read apart from this round and never able to change it.
    const rows = staleFailure || projection.display === undefined || projection.display.scenarios.length === 0 ? undefined : projection.display;
    const baseline = rows === undefined ? undefined : await readWorkflowE2EBaseline(dependencies, task).catch(() => undefined);
    const scenarioResults: E2EScenarioResults | undefined = rows === undefined ? undefined : { scenarios: [...rows.scenarios], ...(baseline === undefined ? {} : { baseline }) };
    const shown = presentationWithResults(task.taskId, shared, scenarioResults);
    return { presentation: { shared, slackBlocks: shown.slackBlocks, pageHtml: shown.pageHtml, mcp: renderE2EMcpProjection(shared) },
      ...(scenarioResults === undefined ? {} : { scenarioResults }), artifacts: rows?.artifacts ?? [] };
  }
  return undefined;
}

/**
 * The per-scenario rows of the task's current browser and API round (and the baseline round's), for the task page. Read-only; undefined when the task has none.
 * The rows are those of the stored display, which the result callback wrote from the broker's own verification when the round ended: the page does not verify the evidence
 * again on every render, every link on it is one the artifact route serves (the screenshots were stored before the display that names them), and a baseline recorded after
 * the display shows from the next display. A closed task keeps its recorded rows through the presentation, which reads the same display.
 */
export async function loadWorkflowE2EScenarioResults(
  dependencies: AwsBrokerDependencies,
  task: DeveloperTaskRecord,
  operations: readonly unknown[],
  actor: "owner" | "viewer" = "viewer",
): Promise<E2EScenarioResults | undefined> {
  if (task.closedAt !== undefined) return (await workflowE2EPresentationDetailed(dependencies, task, operations, actor))?.scenarioResults;
  const stored = await loadStoredScenarioResults({ s3: dependencies.s3, artifactBucketName: dependencies.artifactBucketName }, task);
  // M1.3 Task 3.7b: the baseline round has a record of its own and runs before the candidate's, so it shows as soon as it is recorded, or known not to have run, whether or not the
  // candidate's round has a single row yet. The record is the baseline's truth: a display written earlier may not carry it.
  const baseline = await readWorkflowE2EBaseline(dependencies, task).catch(() => undefined);
  if (stored === undefined && baseline === undefined) return undefined;
  return { scenarios: stored?.scenarios ?? [], ...((baseline ?? stored?.baseline) === undefined ? {} : { baseline: (baseline ?? stored?.baseline)! }) };
}

/** A screenshot behind a row of the task's current display, by its digest; undefined for a digest the display does not name. The caller has already checked who may read it. */
export async function loadWorkflowE2EArtifact(
  dependencies: AwsBrokerDependencies,
  task: DeveloperTaskRecord,
  sha256: string,
): Promise<{ contentType: "image/jpeg"; bytes: Uint8Array } | undefined> {
  const baseline = await readWorkflowE2EBaseline(dependencies, task).catch(() => undefined);
  return loadStoredWorkflowE2EArtifact({ s3: dependencies.s3, artifactBucketName: dependencies.artifactBucketName }, task, sha256, baseline === undefined ? {} : { baseline });
}

/** Reloads the exact current CHECKS evidence for publication and returns its final-effect fences. */
export async function workflowE2EPublicationChecks(
  dependencies: AwsBrokerDependencies,
  task: DeveloperTaskRecord,
  operations: readonly unknown[],
): Promise<TransactItems | undefined> {
  if (task.workflow?.e2e?.required !== true) return [];
  const candidate = CandidateManifestSchema.safeParse(task.workflow.candidate);
  const roundId = task.workflow.e2e.currentRoundId;
  if (!candidate.success || roundId === undefined || task.closedAt !== undefined) return undefined;
  const candidates = operations.flatMap((raw) => {
    if (typeof raw !== "object" || raw === null || !("id" in raw) || typeof raw.id !== "string") return [];
    return [raw.id];
  });
  const checks: OperationRecord[] = [];
  for (const id of candidates) {
    const operation = await getItem<OperationRecord>(dependencies, operationKey(task.workspaceId, id));
    if (operation?.entityType === "OPERATION" && operation.kind === "task" && operation.workflowMode === "CHECKS"
      && operation.workflowE2EAdmission?.taskId === task.taskId && operation.workflowE2EAdmission.roundId === roundId
      && operation.workflowE2EAdmission.candidateDigest === candidate.data.digest && operation.workflowE2EEvidenceRef !== undefined) checks.push(operation);
  }
  checks.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const operation = checks[0];
  if (operation === undefined) return undefined;
  const diagnostic: WorkflowE2EVerificationDiagnostic = {};
  if (await verifyWorkflowE2EEvidence(dependencies, operation, task, candidate.data, undefined, diagnostic) !== "PASS"
    || diagnostic.authorityChecks === undefined || diagnostic.authorityChecks.length === 0) return undefined;
  return diagnostic.authorityChecks;
}

/** Shared loader for authenticated task detail, page, and notifier projections. */
export async function loadWorkflowE2EPresentation(
  dependencies: AwsBrokerDependencies,
  task: DeveloperTaskRecord,
  operations: readonly unknown[],
  actor: "owner" | "viewer" = "viewer",
): Promise<NonNullable<DeveloperTaskView["e2ePresentation"]> | undefined> {
  return workflowE2EPresentation(dependencies, task, operations, actor);
}

/** The final-effect fences publication takes from the current CHECKS evidence, or undefined when that evidence does not qualify (publication is then STALE). */
export async function loadWorkflowE2EPublicationChecks(
  dependencies: AwsBrokerDependencies,
  task: DeveloperTaskRecord,
  operations: readonly unknown[],
): Promise<TransactItems | undefined> {
  return workflowE2EPublicationChecks(dependencies, task, operations);
}
