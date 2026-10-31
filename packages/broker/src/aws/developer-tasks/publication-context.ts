import { createHash } from "node:crypto";
import { CandidateManifestSchema, canonicalJson } from "@agentx/contracts";
import { z } from "zod";
import type { DeveloperCaller } from "../developer-routes.js";
import type { DeveloperTaskRouteDependencies } from "./types.js";
import { iso } from "./common.js";
import { loadOwnedTask } from "./access.js";

const E2EPublicationSubjectSchema = z.object({
  projectName: z.string().min(1).max(100), projectRevision: z.number().int().positive(), repositoryId: z.number().int().positive(),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/), treeSha: z.string().regex(/^[a-f0-9]{40}$/), baseCommitSha: z.string().regex(/^[a-f0-9]{40}$/),
}).strict();
const E2EPublicationJoinRequestSchema = z.object({
  taskRef: z.string().uuid(), subject: E2EPublicationSubjectSchema, sourceBindingRef: z.string().regex(/^cli-source:v1:[a-f0-9]{64}$/),
}).strict();

export async function e2ePublicationContext(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, pathTaskId: string, input: unknown) {
  const request = E2EPublicationJoinRequestSchema.safeParse(input);
  if (!request.success || request.data.taskRef !== pathTaskId) {
    return { schemaVersion: 1, status: "UNKNOWN", reasonCode: "invalid_or_mismatched_task_selector", checkedAt: iso(deps) };
  }
  const task = await loadOwnedTask(deps, caller, pathTaskId);
  const { subject } = request.data;
  const unknown = (reasonCode: string) => ({ schemaVersion: 1, status: "UNKNOWN", subject, reasonCode, checkedAt: iso(deps) });
  if (task.workflow?.e2e?.required !== true || task.workflow.candidate === undefined || task.workflow.e2e.currentRoundId === undefined
    || subject.projectName !== task.project || subject.projectRevision !== task.startingRevision) return unknown("current_task_scope_unavailable");
  const candidate = CandidateManifestSchema.safeParse(task.workflow.candidate);
  if (!candidate.success) return unknown("current_candidate_unavailable");
  const project = await deps.actions.projectRevision(deps.orgId, task.project, task.startingRevision);
  if (project === undefined || project.definition.revision !== subject.projectRevision) return unknown("registered_project_revision_unavailable");
  const candidateRepositories = candidate.data.repositories.filter((item) => item.commitSha === subject.commitSha && item.treeSha === subject.treeSha);
  if (candidateRepositories.length !== 1) return unknown("candidate_commit_tree_or_base_mismatch");
  const candidateRepository = candidateRepositories[0]!;
  const candidateBase = candidateRepository.baseCommitSha
    ?? task.workflow.reviewBase?.find((item) => item.repositoryId === candidateRepository.repositoryId)?.baseCommitSha;
  if (candidateBase !== subject.baseCommitSha) return unknown("candidate_commit_tree_or_base_mismatch");
  const registeredRepository = project.definition.repositories.find((item) => item.name === candidateRepository.repositoryId);
  if (registeredRepository === undefined || deps.registeredRepositoryIdentity === undefined) return unknown("registered_repository_identity_unavailable");
  const identity = await deps.registeredRepositoryIdentity(registeredRepository.url, deps.orgId);
  if (identity === undefined || identity.repositoryId !== subject.repositoryId) return unknown("registered_repository_id_mismatch");
  const url = new URL(registeredRepository.url);
  const pathParts = url.pathname.split("/").filter(Boolean);
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || pathParts.length !== 2) return unknown("registered_repository_url_unsupported");
  const registeredFullName = `${pathParts[0]}/${pathParts[1]!.replace(/\.git$/u, "")}`;
  if (identity.fullName.toLowerCase() !== registeredFullName.toLowerCase()) return unknown("registered_repository_full_name_mismatch");
  const operations = await deps.actions.operations(task.workspaceId);
  const publicationChecks = await deps.workflowE2EPublicationChecks?.({ task, operations });
  const presentation = await deps.workflowE2EPresentation?.({ task, operations, actor: "owner" });
  if (publicationChecks === undefined || publicationChecks.length === 0 || presentation?.shared.e2e.status !== "PASS") {
    return unknown("current_e2e_evidence_unavailable");
  }
  const progress = task.workflow.e2e;
  const qualified = progress.qualifiedRound;
  if (qualified === undefined || qualified.roundId !== progress.currentRoundId || qualified.candidateDigest !== candidate.data.digest
    || qualified.groupRunIds.length === 0 || canonicalJson(qualified.groupRunIds) !== canonicalJson(progress.currentGroupRunIds)) {
    return unknown("current_e2e_round_unavailable");
  }
  const evidenceSetDigest = createHash("sha256").update(canonicalJson({
    domain: "agentx-e2e-publication-context/v1", taskId: task.taskId, candidateDigest: candidate.data.digest,
    roundId: qualified.roundId, admissionSha256: qualified.admissionSha256,
    evidenceSha256: qualified.evidenceSha256, groupRunIds: qualified.groupRunIds,
  })).digest("hex");
  const planDigest = progress.executionPlanDigest;
  if (planDigest === undefined || qualified.contractDigest !== progress.contractDigest
    || qualified.policyDigest !== progress.policyDigest || qualified.executionPlanDigest !== planDigest
    ) return unknown("current_e2e_plan_unavailable");
  return { schemaVersion: 1, status: "READY", subject, candidateDigest: candidate.data.digest,
    contractDigest: progress.contractDigest, policyDigest: progress.policyDigest,
    planDigest, roundId: qualified.roundId, evidenceSetDigest, checkedAt: iso(deps) };
}
