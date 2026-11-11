import type { WorkerInvocation } from "./protocol.js";
import { type WorkflowPublicationContextV1, WorkflowPublicationContextV1Schema } from "@rovara-code/contracts";

/** Extracts the immutable destination and candidate tuple from a workflow publish invocation. */
export function workflowPublicationContext(invocation: WorkerInvocation): WorkflowPublicationContextV1 | undefined {
  if (invocation.kind !== "publish") return undefined;
  const payload = invocation.payload;
  const workflowFieldsPresent = payload.publicationMode !== undefined || payload.candidateTreeSha !== undefined
    || payload.candidateCommitSha !== undefined || payload.workflowBaseCommit !== undefined;
  if (!workflowFieldsPresent) return undefined;
  if (payload.publicationMode === undefined || payload.candidateTreeSha === undefined) {
    throw new TypeError("workflow publication context is incomplete");
  }
  const repository = payload.project.repositories.find((entry) => entry.name === payload.repository);
  if (repository === undefined) throw new TypeError("workflow publication repository is not registered in the invocation");
  return WorkflowPublicationContextV1Schema.parse({
    schemaVersion: "workflow-publication-context/v1",
    workspaceId: invocation.workspaceId,
    operationId: invocation.operationId,
    fence: invocation.fence,
    projectRevision: invocation.projectRevision,
    kind: "publish",
    mode: payload.mode,
    publicationMode: payload.publicationMode,
    repository: payload.repository,
    repositoryUrl: repository.url,
    repositoryPath: repository.path,
    defaultBranch: repository.defaultBranch,
    headBranch: payload.headBranch,
    candidateTreeSha: payload.candidateTreeSha,
    candidateCommitSha: payload.candidateCommitSha ?? null,
    workflowBaseCommit: payload.workflowBaseCommit ?? null,
  });
}
