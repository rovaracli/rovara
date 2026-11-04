// Part of the broker: the proof evidence's hook on the end of a verification run (wire-proof). When a CHECKS run's result is accepted and its verification is recorded, the evidence of that run is assembled and
// kept (rovara-code/evidence-keep.ts): the worker's test reports, the data guard, the pack, and the stored output tails. It runs only while the proof switch is on, is informational (a fault or a slow store only
// means there is no evidence for this code), and is bounded: a call past its time writes nothing more.
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { CheckEntry, OrgId } from "@agentx/contracts";
import { workflowSelectedChecks, type WorkflowSnapshot } from "@agentx/contracts";
import { createEvidenceErase, markEvidenceStored, resumeEvidenceErase, type EvidenceErase } from "../../rovara-code/evidence-erase.js";
import { keepEvidence, policyKindsOf, type KeepEvidenceResult } from "../../rovara-code/evidence-keep.js";
import { proofEvidenceEnabled } from "../../proof/switch.js";
import { evidenceEnvironmentOf } from "../../test-env/evidence-line.js";
import { developerTaskActions } from "./dependency-wiring.js";
import { createEvidencePort, type EvidencePort } from "../developer-tasks/evidence-port.js";
import type { AwsBrokerDependencies } from "./definitions.js";
import type { OperationRecord } from "../cancellation.js";
import type { DeveloperTaskRecord } from "../../developer/task-records.js";

/** How long the hook may hold up the worker's callback. */
export const EVIDENCE_KEEP_MAX_MS = 6_000;

/** Keeps the evidence of a verification run. Never throws; returns the result for the tests. */
export async function keepEvidenceAfterChecks(
  dependencies: Pick<AwsBrokerDependencies, "s3" | "artifactBucketName" | "tableName" | "documentClient"> & Partial<AwsBrokerDependencies>,
  input: { task: Pick<DeveloperTaskRecord, "taskId" | "ownerKey" | "workspaceId" | "orgId"> & { project?: string }; operation: Pick<OperationRecord, "id" | "workflowMode">; workflow: Pick<WorkflowSnapshot, "checkPolicy">; candidateDigest: string; checks: readonly CheckEntry[] },
  env: NodeJS.ProcessEnv = process.env,
): Promise<KeepEvidenceResult | undefined> {
  if (!proofEvidenceEnabled(env) || input.operation.workflowMode !== "CHECKS") return undefined;
  // A task with no org (before orgs) keeps no evidence: the erase finds evidence through the org, so none is stored that it could not find.
  const orgId = input.task.orgId;
  if (orgId === undefined) return undefined;
  let late = false;
  // Test environment (wire-testenv): the environment the task pinned, named in the pack (nothing while that switch is off). Inside the same bound as the rest.
  const run = evidenceEnvironmentOf({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now, ...(dependencies.fixtureStore === undefined ? {} : { fixtureStore: dependencies.fixtureStore }) }, input.task, env).then((chosen) => keepEvidence({
    actions: developerTaskActions(dependencies as AwsBrokerDependencies), store: { s3: dependencies.s3, artifactBucketName: dependencies.artifactBucketName }, markStored: (orgId) => markEvidenceStored({ documentClient: dependencies.documentClient, tableName: dependencies.tableName }, orgId), late: () => late,
    log: (event, fields) => console.log(JSON.stringify({ component: "broker", event, taskId: input.task.taskId, operationId: input.operation.id, ...fields })),
  }, {
    orgId, task: { ownerKey: input.task.ownerKey, workspaceId: input.task.workspaceId, taskId: input.task.taskId }, operationId: input.operation.id, candidateDigest: input.candidateDigest,
    checks: input.checks.filter((entry) => entry.source === "project"), policyKinds: policyKindsOf(workflowSelectedChecks(input.workflow.checkPolicy)),
    ...(chosen.environment === undefined ? {} : { environment: chosen.environment }), ...(chosen.dependencies === undefined ? {} : { dependencies: chosen.dependencies }), ...(chosen.deny === undefined ? {} : { deny: chosen.deny }), ...(chosen.note === undefined ? {} : { environmentNote: chosen.note }),
  }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => { timer = setTimeout(() => { late = true; resolve(undefined); }, EVIDENCE_KEEP_MAX_MS); timer.unref?.(); });
  try { return await Promise.race([run, timeout]); } finally { clearTimeout(timer); }
}

/**
 * The route dependency that shows a task's evidence (the pull request's lines, the task page's tab, the download): the evidence port, or NOTHING while the proof switch is off. Spread into the
 * application route dependencies (`workflowApplicationRouteDependencies`), so every path that builds task routes gets it, and none gets it with the switch off.
 */
export function evidenceRouteDependencies(dependencies: AwsBrokerDependencies, env: NodeJS.ProcessEnv = process.env): { evidence?: EvidencePort } {
  if (!proofEvidenceEnabled(env)) return {};
  return { evidence: createEvidencePort({ actions: developerTaskActions(dependencies), store: { s3: dependencies.s3, artifactBucketName: dependencies.artifactBucketName }, issuer: dependencies.developer?.issuer, audit: dependencies.audit,
    presign: ({ key, contentType, disposition, expiresInSeconds }) => getSignedUrl(dependencies.s3, new GetObjectCommand({ Bucket: dependencies.artifactBucketName, Key: key, ResponseContentType: contentType, ResponseContentDisposition: disposition }), { expiresIn: expiresInSeconds }) }) };
}

/** The deletion of stored evidence for a project, a company or a person (rovara-code/evidence-erase.ts). Not behind the proof switch: it erases what was kept while the switch was on. */
export function evidenceEraseOf(dependencies: Pick<AwsBrokerDependencies, "s3" | "artifactBucketName" | "documentClient" | "tableName">): EvidenceErase {
  return createEvidenceErase({ s3: dependencies.s3, artifactBucketName: dependencies.artifactBucketName, documentClient: dependencies.documentClient, tableName: dependencies.tableName });
}

/** What a person's erase does after the learning walk: the Team record's erase (where that switch is on), then the stored evidence of the person's tasks. Either one not finishing throws, and the request is repeated. */
export function personErasureStep(teamRecord: { erase: { person(orgId: OrgId, developerId: string): Promise<void> } } | undefined, evidence: Pick<EvidenceErase, "person">): (orgId: OrgId, developerId: string) => Promise<void> {
  return async (orgId, developerId) => {
    if (teamRecord !== undefined) await teamRecord.erase.person(orgId, developerId);
    await evidence.person(orgId, developerId);
  };
}

/** The most time the every-minute recovery run gives the evidence erases it finds unfinished; its own share, taken first. */
export const EVIDENCE_RESUME_BUDGET_MS = 3_000;

/** The scheduled run's share for the evidence erases a caller left unfinished (a company close or a project archive cannot be repeated; a person's erase may also have been abandoned). */
export function resumeEvidence(dependencies: Pick<AwsBrokerDependencies, "s3" | "artifactBucketName" | "documentClient" | "tableName">, millis: number): Promise<{ pending: number; finished: number }> {
  const ports = { s3: dependencies.s3, artifactBucketName: dependencies.artifactBucketName, documentClient: dependencies.documentClient, tableName: dependencies.tableName };
  return resumeEvidenceErase(ports, createEvidenceErase(ports), { millis });
}
