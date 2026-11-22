import { SessionViewReaderSchema, DeveloperTaskViewReaderSchema, ArtifactLinkSchema } from "@agentx/contracts/web";
import { createCandidateManifest } from "@agentx/contracts";
import { workspaceFixture, workspaceWorkflow } from "./workspace-fixture.js";

export const proofCandidate = createCandidateManifest([{ repositoryId: "payments", commitSha: "1".repeat(40), treeSha: "2".repeat(40), baseCommitSha: "3".repeat(40) }]);
export const proofIdentity = { developer: { id: "a".repeat(64), name: "Priya", orgRole: "member" }, org: { orgId: "org-proof", name: "Proof company", plan: "team" }, identities: [] };
export const proofArtifact = (state: "available" | "expired" | "withheld", letter = "a") => ArtifactLinkSchema.parse({ kind: "jpeg", sha256: letter.repeat(64), bytes: 128, retentionClass: "evidence-std", state, ...(state === "available" ? { href: "/v1/app/evidence/" + letter + ".jpg" } : {}) });
export function pageProofFixture(overrides: Record<string, unknown> = {}) {
 const base = workspaceFixture();
 if (base.body.kind !== "task") throw new Error("Expected task fixture");
 const task = DeveloperTaskViewReaderSchema.parse({ ...base.body.task,
  workflow: { ...workspaceWorkflow(), candidate: proofCandidate, verification: { candidateDigest: proofCandidate.digest, producer: "check-runner", environmentId: "fixture-worker", recordedAt: "2026-10-23T12:00:00.000Z", results: [{ checkId: "unit", status: "PASS" }] } },
  testing: { schemaVersion: 1, result: "verified", reasons: [], rows: [{ label: "Unit tests", command: "npm test", status: "passed" }] },
  proofTable: { rows: [], notTested: [{ kind: "claim", id: "R1", text: "Refund retries are idempotent.", reason: "no scenario names it" }, { kind: "check", id: "browser", text: "Browser check", reason: "not selected" }], testProofLines: [] },
  evidence: { schemaVersion: 1, candidateDigest: proofCandidate.digest, environment: { tier: "sandbox", envRevision: 1, services: [], dependencies: [], data: "synthetic", accounts: [] }, checks: [], selection: { method: "full", selected: 0, total: 0 }, api: [], browser: [{ scenarioId: "checkout", strip: { before: [proofArtifact("available", "a")], after: [proofArtifact("available", "b")] } }], notTested: [] },
  ...overrides,
 });
 return SessionViewReaderSchema.parse({ ...base, body: { kind: "task", task } });
}
