// Proof and evidence (wire-proof): what the pull request gets. The Proof section reads the evidence kept for the exact code through the evidence port, and shows counts, the environment, what was not run and
// a link to the task page (behind sign-in); with no port (the switch off) the section is byte for byte what it was. A pack for other code shows nothing.
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PlanDocument } from "../../packages/contracts/src/index.js";
import { WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot, type WorkflowSnapshot } from "../../packages/contracts/src/task-workflow-node.js";
import { createEvidencePort } from "../../packages/broker/src/aws/developer-tasks/evidence-port.js";
import { proofContextOfTask } from "../../packages/broker/src/aws/developer-tasks/pull-request-body.js";
import { keepEvidence } from "../../packages/broker/src/rovara-code/evidence-keep.js";
import { loadProofContext } from "../../packages/broker/src/rovara-code/proof-inputs.js";
import { proofSection } from "../../packages/broker/src/rovara-code/proof-section.js";
import { rovaraPullRequestBody } from "../../packages/broker/src/rovara-code/pull-request-body.js";
import { environmentLine, evidenceNotTestedLines } from "../../packages/broker/src/rovara-code/evidence-lines.js";
import { EvidencePackSchema } from "../../packages/contracts/src/evidence.js";

const taskId = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const now = "2026-11-04T12:00:00.000Z";
const CODE = createCandidateManifest([{ repositoryId: "payments", commitSha: "1".repeat(40), treeSha: "1".repeat(40), baseCommitSha: "e".repeat(40) }]);
const OTHER = createCandidateManifest([{ repositoryId: "payments", commitSha: "2".repeat(40), treeSha: "2".repeat(40), baseCommitSha: "e".repeat(40) }]);
const command = { cwd: "repo/payments", executable: "pytest", args: ["-q"], timeoutSeconds: 30 };
const check = (id: string, label: string) => ({ id, label, command });
const TASK = { taskId, ownerKey: "owner-1", workspaceId: "ws-1" };
const PREFIX = `private/${TASK.ownerKey}/${TASK.workspaceId}/op-1/`;

const plan = (): PlanDocument => ({
  schemaVersion: 1, title: "Score partners", why: [{ text: "Partners with no region are scored wrongly.", author: "Priya" }],
  claims: [{ id: "1", text: "Score ignores partners with no region." }], notChanging: [], risks: [], decisions: [], checks: { proposed: [check("unit", "Unit tests")], proves: { unit: ["1"] } },
});
const workflow = (code = CODE): WorkflowSnapshot => WorkflowSnapshotSchema.parse({
  ...createWorkflowSnapshot({ taskId, ownerId: "a".repeat(64), now, definitionVersion: "1.1.0" }),
  stage: "PULL_REQUEST", state: "READY", candidate: code,
  checkPolicy: { required: [], optional: [], selectedOptionalIds: [], proposed: [check("unit", "Unit tests")] },
  verification: { candidateDigest: code.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: now, results: [{ checkId: "unit", status: "PASS" }] },
  reviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: randomUUID(), candidateDigest: code.digest, role, provider: "test", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now })),
});

function bucket() {
  const objects = new Map<string, string>();
  const s3 = { async send(command: unknown) {
    if (command instanceof PutObjectCommand) { objects.set(command.input.Key!, String(command.input.Body as string)); return {}; }
    if (command instanceof GetObjectCommand) { const found = objects.get(command.input.Key!); if (found === undefined) throw new Error("NoSuchKey"); return { Body: { transformToString: async () => found } }; }
    throw new Error("unexpected command");
  } } as unknown as S3Client;
  return { objects, s3 };
}
const raw = (digest: string) => JSON.stringify({ schemaVersion: 1, candidateDigest: digest, checks: [{ checkId: "readiness:0", tests: { total: 3, passed: 2, failed: 0, skipped: 1, errored: 0, names: [{ name: "test_a", status: "passed" }, { name: "test_b", status: "passed" }, { name: "test_c", status: "skipped" }], newTests: ["test_a"] } }] });
const entry = { id: "readiness:0", label: "pytest -q", source: "project" as const, before: "passed" as const, after: "passed" as const, class: "passing" as const, output: "", durationMs: 800, exitCode: 0 };

async function kept(issuer: string | undefined) {
  const { objects, s3 } = bucket();
  const actions = { artifacts: async () => [{ name: "evidence-raw.json", objectKey: `${PREFIX}evidence-raw.json` }], readArtifact: async (key: string, max: number) => (key.startsWith(PREFIX) ? raw(CODE.digest).slice(0, max) : objects.get(key) ?? "") };
  const store = { s3, artifactBucketName: "bucket" };
  await keepEvidence({ actions, store, markStored: async () => undefined }, { orgId: "org-a", task: TASK, operationId: "op-1", candidateDigest: CODE.digest, checks: [entry] });
  const port = createEvidencePort({ actions: { readArtifact: async (key, max) => { const found = objects.get(key); if (found === undefined) throw new Error("NoSuchKey"); return found.slice(0, max); } }, store, issuer });
  return { port, objects };
}
const taskRecord = TASK as never;
const proofDeps = (port: Awaited<ReturnType<typeof kept>>["port"] | undefined) => ({ actions: { operations: async () => [], artifacts: async () => [], readArtifact: async () => "" }, workflowE2EScenarioResults: undefined, ...(port === undefined ? {} : { evidence: port }) }) as never;
const plain = (ctx: Awaited<ReturnType<typeof loadProofContext>>) => proofSection(workflow(), ctx)!(0).join("\n");
const approved = { format: "structured", plan: plan() } as never;

describe("the pull request's Proof section", () => {
  it("carries the evidence kept for this exact code: counts, the environment, what was not run, and the link to the task page, in both editions' default mode", async () => {
    const { port } = await kept("https://rovara.example/");
    const ctx = await proofContextOfTask(proofDeps(port), taskRecord, workflow(), approved, "owner");
    expect(ctx?.evidence).toMatchObject({ mode: "link", origin: "https://rovara.example", taskUrl: `https://rovara.example/review/${taskId}/task` });
    const text = plain(ctx);
    expect(text).toContain("Checks by kind: pytest -q ✓: 2 passed, 1 skipped; 1 new");
    expect(text).toContain("Environment: sandbox. No approved test environment: the project's own test setup was used.");
    expect(text).not.toContain("Test data: synthetic");
    expect(text).toContain(`Full evidence (screenshots, API samples, video, logs): Rovara task page (sign-in needed): https://rovara.example/review/${taskId}/task`);
    expect(text).toContain("No approved test environment");
    const body = rovaraPullRequestBody({ summary: ["Score partners"], fallbackTitle: "Score partners", workflow: workflow(), context: { proof: ctx! }, reviewLines: () => [], pageUrl: `https://rovara.example/review/${taskId}/task` });
    expect(body).toContain("Checks by kind:");
    expect(Buffer.byteLength(body, "utf8")).toBeLessThan(30_000);
  });

  it("is exactly what it was with no evidence port: no key, byte for byte the same section", async () => {
    const { port } = await kept("https://rovara.example/");
    const off = await proofContextOfTask(proofDeps(undefined), taskRecord, workflow(), approved, "owner");
    expect(off).not.toHaveProperty("evidence");
    const baseline = proofSection(workflow(), { plan: plan() })!(0).join("\n");
    expect(plain(off)).toBe(baseline);
    expect(plain(await proofContextOfTask(proofDeps(port), taskRecord, workflow(), approved, "owner"))).not.toBe(baseline);
  });

  it("shows nothing for other code: a pack kept for one candidate is not read for another, and a fault in the port leaves the section as it was", async () => {
    const { port } = await kept("https://rovara.example");
    expect(await port.context(TASK, OTHER.digest)).toBeUndefined();
    const other = await proofContextOfTask(proofDeps(port), taskRecord, workflow(OTHER), approved, "owner");
    expect(other?.evidence).toBeUndefined();
    const ctx = await loadProofContext({ actions: (proofDeps(undefined) as { actions: never }).actions, evidence: async () => { throw new Error("down"); } }, taskRecord, workflow(), approved);
    expect(ctx).not.toHaveProperty("evidence");
  });

  it("without the issuer the section still says where to look, with no address", async () => {
    const { port } = await kept(undefined);
    const ctx = await proofContextOfTask(proofDeps(port), taskRecord, workflow(), approved, "owner");
    expect(ctx?.evidence).toMatchObject({ mode: "link" });
    expect(ctx?.evidence?.taskUrl).toBeUndefined();
    expect(plain(ctx)).toContain("Full evidence (screenshots, API samples, video, logs): Rovara task page (sign-in needed)");
    expect(plain(ctx)).not.toContain("http");
  });
});

describe("the environment line of a pack with no approved test environment", () => {
  const pack = EvidencePackSchema.parse({ schemaVersion: 1, candidateDigest: CODE.digest, environment: { tier: "sandbox", envRevision: 0, services: [], data: "synthetic", accounts: [] }, checks: [], selection: { method: "full", selected: 0, total: 0 }, api: [], browser: [], notTested: [] });
  it("says so instead of claiming synthetic test data nobody checked (replaces the pack's 'Test data: synthetic' for such a pack)", () => {
    expect(environmentLine(pack, 0)).toBe("Environment: sandbox. No approved test environment: the project's own test setup was used.");
    expect(environmentLine({ ...pack, environment: { ...pack.environment, envRevision: 2 } }, 0)).toBe("Environment: sandbox, approved test environment revision 2. Test data: synthetic.");
  });
});

describe("a run whose details were not captured", () => {
  it("the pull request says so under What wasn't tested, so a reader can tell it from evidence that expired", () => {
    const pack = EvidencePackSchema.parse({ schemaVersion: 1, candidateDigest: CODE.digest, environment: { tier: "sandbox", envRevision: 0, services: [], data: "synthetic", accounts: [] }, checks: [], selection: { method: "full", selected: 0, total: 0 }, api: [], browser: [],
      notTested: [{ kind: "environment", id: "evidence_capture", text: "Test details were not captured for this run", reason: "the worker reported none" }] });
    expect(evidenceNotTestedLines(pack, 0)).toEqual(["- Detail Test details were not captured for this run (the worker reported none)"]);
  });
});
