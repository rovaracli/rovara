// Proof and evidence (wire-proof): what the task routes need to show a task's evidence: the pack kept for the task's current code (rovara-code/evidence-keep.ts), as the pull request shows it (counts, a link) and as the
// task page shows it (links to stored artifacts). It exists only while the proof switch is on (`evidenceRouteDependencies`, aws/broker/evidence-wiring.ts): with the switch off nothing builds it, every reader sees `undefined`
// and the pull request, the task view and the routes are exactly what they were. A pack is read only for the digest it was kept for, so evidence of earlier code is never shown against later code.
import type { GateReader } from "../../org/feature-rollout.js";
import { resolveEvidenceMode, type EvidencePack, type EvidenceView, type OrgId } from "@rovara-code/contracts";
import type { TestProofActions } from "../../developer/test-proof-lines.js";
import { evidenceViewOf, type EvidenceArtifactState } from "../../rovara-code/evidence-pack.js";
import type { ProofEvidenceContext } from "../../rovara-code/evidence-lines.js";
import { loadEvidencePack } from "../../rovara-code/evidence-keep.js";
import { statEvidenceArtifacts, type EvidenceArtifactStore, type EvidenceDownloadDependencies } from "../evidence-artifacts.js";
import type { AuditDeps } from "../../audit/outbox.js";
import { taskPageUrl } from "./common.js";
import type { DeveloperTaskRouteDependencies } from "./types.js";

/** `orgId` is the task's company (a task record always has it; `undefined` only for a task from before companies): the company gate (TE-A1, `gatedEvidencePort`) is read for it. It is a required key, so a literal that leaves it out does not compile; `undefined` is a task whose company is unknown, and the gated port shows it nothing. */
export interface EvidenceTaskKey { taskId: string; ownerKey: string; workspaceId: string; orgId: OrgId | undefined }

/** The evidence key of a task record: the three the store is keyed by, and the company the gate is read for (`orgId` is undefined only for a task from before companies). */
export const evidenceKeyOf = (task: { taskId: string; ownerKey: string; workspaceId: string; orgId?: OrgId | undefined }): EvidenceTaskKey => ({ taskId: task.taskId, ownerKey: task.ownerKey, workspaceId: task.workspaceId, orgId: task.orgId });

export interface EvidencePort {
  /** Whether evidence is on for this task's company (TE-A1). Absent on a port that is not company-gated: it is on. A reader that finds none must treat the task as the proof switch off, not as evidence lost. */
  on?(task: EvidenceTaskKey): Promise<boolean>;
  /** The same port reading a company's gate through one request's reader (`createGateReader`), so the request reads it once. Only the company-gated port has it. */
  scoped?(gates: GateReader): EvidencePort;
  /** The pack kept for exactly this code; undefined when there is none. */
  pack(task: EvidenceTaskKey, candidateDigest: string | undefined): Promise<EvidencePack | undefined>;
  /** What the pull request's Proof section shows of it: the pack, how much of it, and where the rest is (the task page, behind sign-in). Undefined when there is no pack. */
  context(task: EvidenceTaskKey, candidateDigest: string | undefined): Promise<ProofEvidenceContext | undefined>;
  /** The task page's view of it: each stored artifact a link while the store holds it, else expired. Undefined when there is no pack. */
  view(task: EvidenceTaskKey, candidateDigest: string | undefined): Promise<EvidenceView | undefined>;
  /** What the download route needs: the store the artifacts are in, a signer for the large kinds, and the audit ledger (absent on a legacy install). */
  download: { store: EvidenceArtifactStore; presign: EvidenceDownloadDependencies["presign"]; audit?: AuditDeps["audit"] | undefined };
}

export interface EvidencePortInput {
  actions: Pick<TestProofActions, "readArtifact">;
  store: EvidenceArtifactStore;
  /** The sign-in issuer: the task page the link names is on its origin. Without it the pull request still says where to look, with no address. */
  issuer?: string | undefined;
  /** A signer for video and trace downloads. Absent: those kinds answer unavailable (none is gathered on this path). */
  presign?: EvidenceDownloadDependencies["presign"] | undefined;
  audit?: AuditDeps["audit"] | undefined;
}

const originOf = (issuer: string | undefined): string | undefined => {
  if (issuer === undefined) return undefined;
  try { const url = new URL(issuer); return url.protocol === "https:" ? url.origin : undefined; } catch { return undefined; }
};

export function createEvidencePort(input: EvidencePortInput): EvidencePort {
  const pack = (task: EvidenceTaskKey, digest: string | undefined) => loadEvidencePack(input.actions, task, digest);
  return {
    pack,
    download: { store: input.store, presign: input.presign ?? (() => Promise.reject(new Error("no signer"))), audit: input.audit },
    async context(task, digest) {
      const found = await pack(task, digest);
      if (found === undefined) return undefined;
      const origin = originOf(input.issuer);
      // Both editions default to the summary plus the link (owner decision on proof Q8): the link is a task page address, and the page asks for sign-in and access to the project. `embed` is never chosen here (no setting, no known repository visibility).
      return { pack: found, mode: resolveEvidenceMode({ repositoryVisibility: "unknown", embedAllowed: false }), ...(origin === undefined || input.issuer === undefined ? {} : { origin, taskUrl: taskPageUrl(input.issuer, task.taskId) }) };
    },
    async view(task, digest) {
      const found = await pack(task, digest);
      if (found === undefined) return undefined;
      const refs = found.checks.flatMap((check) => (check.outputTailRef === undefined ? [] : [check.outputTailRef]));
      const held = await statEvidenceArtifacts(input.store, task, refs.map((ref) => ref.sha256)).catch(() => new Map<string, { kind: string; bytes: number }>());
      const stateOf = (ref: { sha256: string; kind: string; bytes: number }): EvidenceArtifactState => {
        const stored = held.get(ref.sha256);
        return stored !== undefined && stored.kind === ref.kind && stored.bytes === ref.bytes ? "available" : "expired";
      };
      return evidenceViewOf(found, task.taskId, stateOf);
    },
  };
}

/**
 * Whether the person may see this task's evidence: they hold the project (a grant, an org owner's or admin's standing, or the project's Slack channel when that gives access), on top of the task page's own
 * rule. A company-wide session share lets a person read the task page and does not give them the project, so it does not give them the evidence (owner decision on proof Q8: signed in with access to the
 * project). A person with no access reads as "no", and so does anything that cannot be checked (fail closed).
 */
export async function mayReadEvidence(deps: Pick<DeveloperTaskRouteDependencies, "checkAccess">, task: { project: string }): Promise<boolean> {
  try {
    await deps.checkAccess(task.project, { ignoreTasksOff: true });
    return true;
  } catch {
    return false;
  }
}
