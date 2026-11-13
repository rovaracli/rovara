import { afterEach, describe, expect, it, vi } from "vitest";
import { EvidencePackSchema, createCandidateManifest, type EvidencePack } from "@rovara-code/contracts";
import { WorkflowSnapshotSchema, createWorkflowSnapshot, orgFeatureRolloutKey, type WorkflowSnapshot } from "@agentx/cloud-contracts";
import type { OrgId } from "@rovara-code/contracts";
import { keepEvidenceAfterChecks } from "../../packages/broker/src/aws/broker/evidence-wiring.js";
import { gatedEvidencePort } from "../../packages/broker/src/aws/developer-tasks/evidence-gate.js";
import { evidenceRiskOfTask } from "../../packages/broker/src/aws/developer-tasks/evidence-risk-input.js";
import type { EvidencePort } from "../../packages/broker/src/aws/developer-tasks/evidence-port.js";
import { loadTestingView, type TestingViewDeps } from "../../packages/broker/src/aws/developer-tasks/testing-view.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { MAYA, OMAR } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { setupWizardBench } from "../support/setup-wizard-testenv.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

// TE-A1: the company gate where the evidence features are used. Each surface is shown on (positive control: the path ran) and off for the same company, and off for a company whose neighbour's gate is on.

afterEach(() => { delete process.env.VERIFY_RESULTS_ENABLED; });
const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const NOW = "2026-11-13T12:00:00.000Z";
const TASK_ID = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const GATES_ON = { proofEvidence: true, verifyResults: true, testEnvironment: true, testServices: true };
const INSTALL_ON = { PROOF_EVIDENCE_ENABLED: "1", VERIFY_RESULTS_ENABLED: "1" } as NodeJS.ProcessEnv;

function store(rows: Array<[OrgId, Record<string, unknown>]> = []) {
  const db = new FakeDynamoDb({ rolloutGates: "stored" });
  for (const [orgId, gates] of rows) db.set({ ...orgFeatureRolloutKey(orgId), entityType: "FEATURE_ROLLOUT", orgId, gates, revision: 1 });
  let sends = 0;
  const documentClient = { send: (command: unknown) => { sends += 1; return db.send(command as never); } };
  return { db, deps: { documentClient, tableName: "state", now: () => Date.parse(NOW) }, sends: () => sends };
}

describe("the evidence port", () => {
  const key = (orgId: OrgId | undefined) => ({ taskId: TASK_ID, ownerKey: "dev_a", workspaceId: "ws", ...(orgId === undefined ? {} : { orgId }) });
  const base = () => {
    const calls = { pack: 0, context: 0, view: 0 };
    const port: EvidencePort = {
      pack: async () => { calls.pack += 1; return { schemaVersion: 1 } as never; },
      context: async () => { calls.context += 1; return { pack: {} } as never; },
      view: async () => { calls.view += 1; return {} as never; },
      download: { store: {} as never, presign: async () => "" },
    };
    return { port, calls };
  };

  it("shows a company whose gate is on, and nothing to a company whose gate is off, absent, a neighbour's, or unknown", async () => {
    const s = store([[ORG_A, { proofEvidence: true }], [ORG_B, { proofEvidence: false }]]);
    const { port, calls } = base();
    const gated = gatedEvidencePort(port, s.deps, INSTALL_ON);
    expect(await gated.pack(key(ORG_A), "d")).toBeDefined();
    expect(await gated.context(key(ORG_A), "d")).toBeDefined();
    expect(await gated.view(key(ORG_A), "d")).toBeDefined();
    expect(calls).toEqual({ pack: 1, context: 1, view: 1 });
    for (const orgId of [ORG_B, "org_cccccccccccccccccccc" as OrgId, undefined]) {
      expect(await gated.pack(key(orgId), "d")).toBeUndefined();
      expect(await gated.context(key(orgId), "d")).toBeUndefined();
      expect(await gated.view(key(orgId), "d")).toBeUndefined();
      expect(await gated.on?.(key(orgId))).toBe(false);
    }
    expect(calls).toEqual({ pack: 1, context: 1, view: 1 });
  });

  it("the install switch off is off even for a company whose gate is on, and the gate is read live (a change is the next read)", async () => {
    const s = store([[ORG_A, { proofEvidence: true }]]);
    const { port } = base();
    expect(await gatedEvidencePort(port, s.deps, { PROOF_EVIDENCE_ENABLED: "0" }).pack(key(ORG_A), "d")).toBeUndefined();
    const gated = gatedEvidencePort(port, s.deps, INSTALL_ON);
    expect(await gated.pack(key(ORG_A), "d")).toBeDefined();
    s.db.set({ ...orgFeatureRolloutKey(ORG_A), entityType: "FEATURE_ROLLOUT", orgId: ORG_A, gates: { proofEvidence: false }, revision: 2 });
    expect(await gated.pack(key(ORG_A), "d")).toBeUndefined();
  });

  it("a gate that cannot be read shows nothing", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const gated = gatedEvidencePort(base().port, { documentClient: { send: async () => { throw new Error("down"); } }, tableName: "state", now: () => 0 }, INSTALL_ON);
    expect(await gated.pack(key(ORG_A), "d")).toBeUndefined();
    log.mockRestore();
  });

  it("a company whose gate is off is not marked 'evidence unavailable' (the risk is as with the switch off); one whose gate is on and has no pack is", async () => {
    const s = store([[ORG_A, { proofEvidence: true }], [ORG_B, { proofEvidence: false }]]);
    const empty: EvidencePort = { ...base().port, pack: async () => undefined };
    const gated = gatedEvidencePort(empty, s.deps, INSTALL_ON);
    expect(await evidenceRiskOfTask(gated, key(ORG_A), "d", ["security"], true)).toEqual({ highNewFindings: 0, evidenceUnavailable: true });
    expect(await evidenceRiskOfTask(gated, key(ORG_B), "d", ["security"], true)).toBeUndefined();
  });
});

describe("keeping evidence", () => {
  const dependencies = (documentClient: unknown) => ({ s3: { send: async () => { throw new Error("NoSuchKey"); } }, artifactBucketName: "bucket", tableName: "state", documentClient }) as never;
  const args = (orgId: OrgId | undefined) => ({ task: { taskId: TASK_ID, ownerKey: "dev_a", workspaceId: "ws", ...(orgId === undefined ? {} : { orgId }) }, operation: { id: "op", workflowMode: "CHECKS" } as never, workflow: { checkPolicy: undefined } as never, candidateDigest: "c".repeat(64), checks: [] });

  it("is done for a company whose gate is on, and is not for one whose gate is off, absent, or unknown", async () => {
    const s = store([[ORG_A, { proofEvidence: true }], [ORG_B, { proofEvidence: false }]]);
    expect(await keepEvidenceAfterChecks(dependencies(s.deps.documentClient), args(ORG_A), INSTALL_ON)).toBeDefined();
    for (const orgId of [ORG_B, "org_cccccccccccccccccccc" as OrgId, undefined]) expect(await keepEvidenceAfterChecks(dependencies(s.deps.documentClient), args(orgId), INSTALL_ON)).toBeUndefined();
  });
});

describe("the four test results", () => {
  const candidate = createCandidateManifest([{ repositoryId: "app", commitSha: "1".repeat(40), treeSha: "2".repeat(40), baseCommitSha: "3".repeat(40) }]);
  const workflow = (): WorkflowSnapshot => WorkflowSnapshotSchema.parse({
    ...createWorkflowSnapshot({ taskId: TASK_ID, ownerId: "a".repeat(64), now: NOW }), definitionVersion: "1.1.0", revision: 7, stage: "REVIEW", state: "READY",
    candidate, verification: { candidateDigest: candidate.digest, producer: "worker", environmentId: "env", recordedAt: NOW, results: [{ checkId: "unit", status: "PASS" }] },
    checkPolicy: { required: [{ id: "unit", label: "Unit tests", command: { cwd: "repo/app", executable: "pytest", args: ["-q"], timeoutSeconds: 600 } }], optional: [], selectedOptionalIds: [], proposed: [] },
  });
  const pack = (): EvidencePack => EvidencePackSchema.parse({
    schemaVersion: 1, candidateDigest: candidate.digest, environment: { tier: "sandbox", envRevision: 1, services: [], data: "synthetic", accounts: [] },
    checks: [{ checkId: "unit", kind: "test", label: "unit", before: "passed", after: "passed", class: "passing", durationMs: 5 }], selection: { method: "full", selected: 10, total: 10 }, api: [], browser: [], notTested: [],
  });
  const task = (orgId: OrgId | undefined) => ({ taskId: TASK_ID, project: "web", ownerKey: "dev_a", workspaceId: "ws", ...(orgId === undefined ? {} : { orgId }) }) as unknown as DeveloperTaskRecord;
  const deps = (s: ReturnType<typeof store>): TestingViewDeps => ({ ...s.deps, evidence: { pack: async () => pack() } });
  const ON = { VERIFY_RESULTS_ENABLED: "1" };

  it("are decided for a company whose gate is on, and not for one whose gate is off, absent, a neighbour's or unknown", async () => {
    const s = store([[ORG_A, { verifyResults: true }], [ORG_B, { verifyResults: false, proofEvidence: true }]]);
    expect((await loadTestingView(deps(s), task(ORG_A), workflow(), ON))?.result).toBe("verified");
    for (const orgId of [ORG_B, "org_cccccccccccccccccccc" as OrgId, undefined]) expect(await loadTestingView(deps(s), task(orgId), workflow(), ON), String(orgId)).toBeUndefined();
  });

  it("an install with the switch off reads nothing at all, gate or no gate", async () => {
    const s = store([[ORG_A, { verifyResults: true }]]);
    expect(await loadTestingView(deps(s), task(ORG_A), workflow(), {})).toBeUndefined();
    expect(s.sends()).toBe(0);
  });
});

describe("through the broker's route dispatcher (a company's gate decides what its routes see)", () => {
  const POLICY = "/v1/app/org/known-failing-policy";
  const setGates = (db: FakeDynamoDb, gates: Record<string, unknown> | undefined) => {
    if (gates !== undefined) db.set({ ...orgFeatureRolloutKey(TEST_ORG), entityType: "FEATURE_ROLLOUT", orgId: TEST_ORG, gates, revision: 1 });
  };

  it("a vx route is found only while the company's verifyResults gate is on, and the install switch is still the emergency off", async () => {
    const t = await setupWizardBench({});
    process.env.VERIFY_RESULTS_ENABLED = "1";
    // The test table reads a company with no row as all-on (tests/support/fake-dynamodb.ts); a row says what it says.
    expect((await t.web(OMAR, "GET", POLICY)).status).toBe(200);
    setGates(t.db, { ...GATES_ON, verifyResults: false });
    expect((await t.web(OMAR, "GET", POLICY)).status).toBe(404);
    setGates(t.db, { ...GATES_ON, verifyResults: "true" });
    expect((await t.web(OMAR, "GET", POLICY)).status).toBe(404);
    setGates(t.db, { ...GATES_ON, verifyResults: true });
    expect((await t.web(OMAR, "GET", POLICY)).status).toBe(200);
    process.env.VERIFY_RESULTS_ENABLED = "0";
    expect((await t.web(OMAR, "GET", POLICY)).status).toBe(404);
  });

  it("the Preview features route is found for an owner in a browser, and refused to a member and to a token", async () => {
    const t = await setupWizardBench({});
    await t.person(MAYA, "member");
    const path = "/v1/app/org/feature-rollout";
    const owner = await t.web(OMAR, "GET", path);
    expect(owner.status).toBe(200);
    expect((owner.body as { features: Array<{ name: string }> }).features.map((row) => row.name)).toContain("proofEvidence");
    expect((await t.web(MAYA, "GET", path)).status).toBe(403);
    expect((await t.dev(OMAR, "GET", path)).status).toBe(403);
  });
});
