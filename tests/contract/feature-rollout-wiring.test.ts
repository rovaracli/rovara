import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EvidencePackSchema, createCandidateManifest, type EvidencePack } from "@rovara-code/contracts";
import { WorkflowSnapshotSchema, createWorkflowSnapshot, orgFeatureRolloutKey, type WorkflowSnapshot } from "@agentx/cloud-contracts";
import type { OrgId } from "@rovara-code/contracts";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { keepEvidenceAfterChecks } from "../../packages/broker/src/aws/broker/evidence-wiring.js";
import { createGateReader, isGateUnavailable } from "../../packages/broker/src/org/feature-rollout.js";
import { fixSetupDependencies } from "../../packages/broker/src/aws/broker/fix-setup-wiring.js";
import { gatedEvidencePort } from "../../packages/broker/src/aws/developer-tasks/evidence-gate.js";
import { evidenceRiskOfTask } from "../../packages/broker/src/aws/developer-tasks/evidence-risk-input.js";
import type { EvidencePort } from "../../packages/broker/src/aws/developer-tasks/evidence-port.js";
import { loadTestingView, type TestingViewDeps } from "../../packages/broker/src/aws/developer-tasks/testing-view.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { PROOF_WORDS } from "../../packages/broker/src/org/settings-proof.js";
import { MAYA, OMAR } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { setupWizardBench } from "../support/setup-wizard-testenv.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

// TE-A1: the company gate where the evidence features are used. Each surface is shown on (positive control: the path ran) and off for the same company, and off for a company whose neighbour's gate is on.

afterEach(() => { delete process.env.VERIFY_RESULTS_ENABLED; delete process.env.TEST_ENVIRONMENT_ENABLED; });
const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const NOW = "2026-11-13T12:00:00.000Z";
const TASK_ID = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const GATES_ON = { proofEvidence: true, verifyResults: true, testEnvironment: true, testServices: true };
const INSTALL_ON = { PROOF_EVIDENCE_ENABLED: "1", VERIFY_RESULTS_ENABLED: "1" } as NodeJS.ProcessEnv;

function store(rows: Array<[OrgId, Record<string, unknown>]> = []) {
  const db = new FakeDynamoDb();
  for (const [orgId, gates] of rows) db.set({ ...orgFeatureRolloutKey(orgId), entityType: "FEATURE_ROLLOUT", orgId, gates, revision: 1 });
  let sends = 0;
  const documentClient = { send: (command: unknown) => { sends += 1; return db.send(command as never); } };
  return { db, deps: { documentClient, tableName: "state", now: () => Date.parse(NOW) }, sends: () => sends };
}

describe("the evidence port", () => {
  const key = (orgId: OrgId | undefined) => ({ taskId: TASK_ID, ownerKey: "dev_a", workspaceId: "ws", orgId });
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

  it("shows a company whose gate is on or that never chose (it follows the install), and nothing to a company whose gate is off or whose company is unknown", async () => {
    const s = store([[ORG_A, { proofEvidence: true }], [ORG_B, { proofEvidence: false }]]);
    const { port, calls } = base();
    const gated = gatedEvidencePort(port, s.deps, INSTALL_ON);
    expect(await gated.pack(key(ORG_A), "d")).toBeDefined();
    expect(await gated.context(key(ORG_A), "d")).toBeDefined();
    expect(await gated.view(key(ORG_A), "d")).toBeDefined();
    expect(calls).toEqual({ pack: 1, context: 1, view: 1 });
    expect(await gated.pack(key("org_cccccccccccccccccccc"), "d")).toBeDefined();
    expect(calls.pack).toBe(2);
    for (const orgId of [ORG_B, undefined]) {
      expect(await gated.pack(key(orgId), "d")).toBeUndefined();
      expect(await gated.context(key(orgId), "d")).toBeUndefined();
      expect(await gated.view(key(orgId), "d")).toBeUndefined();
      expect(await gated.on?.(key(orgId))).toBe(false);
    }
    expect(calls).toEqual({ pack: 2, context: 1, view: 1 });
  });

  it("a port scoped to one request's reader reads a company's gate once however often it is used; a new request reads again", async () => {
    const s = store([[ORG_A, { proofEvidence: true }]]);
    const { port } = base();
    const gated = gatedEvidencePort(port, s.deps, INSTALL_ON);
    const reader = createGateReader(s.deps);
    const scoped = gated.scoped!(reader);
    const before = s.sends();
    await scoped.pack(key(ORG_A), "d"); await scoped.context(key(ORG_A), "d"); await scoped.view(key(ORG_A), "d"); await scoped.on!(key(ORG_A));
    expect(s.sends() - before).toBe(1);
    await gated.scoped!(createGateReader(s.deps)).pack(key(ORG_A), "d");
    expect(s.sends() - before).toBe(2);
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

  it("is done for a company whose gate is on or that never chose, and is not for one whose gate is off or whose company is unknown", async () => {
    const s = store([[ORG_A, { proofEvidence: true }], [ORG_B, { proofEvidence: false }]]);
    expect(await keepEvidenceAfterChecks(dependencies(s.deps.documentClient), args(ORG_A), INSTALL_ON)).toBeDefined();
    expect(await keepEvidenceAfterChecks(dependencies(s.deps.documentClient), args("org_cccccccccccccccccccc"), INSTALL_ON)).toBeDefined();
    for (const orgId of [ORG_B, undefined]) expect(await keepEvidenceAfterChecks(dependencies(s.deps.documentClient), args(orgId), INSTALL_ON)).toBeUndefined();
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

  it("are decided for a company whose gate is on or that never chose, and not for one whose gate is off or whose company is unknown", async () => {
    const s = store([[ORG_A, { verifyResults: true }], [ORG_B, { verifyResults: false, proofEvidence: true }]]);
    expect((await loadTestingView(deps(s), task(ORG_A), workflow(), ON))?.result).toBe("verified");
    expect((await loadTestingView(deps(s), task("org_cccccccccccccccccccc"), workflow(), ON))?.result).toBe("verified");
    for (const orgId of [ORG_B, undefined]) expect(await loadTestingView(deps(s), task(orgId), workflow(), ON), String(orgId)).toBeUndefined();
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

  const failGateReads = (db: FakeDynamoDb) => db.injectFault({ command: "GetCommand", match: (input) => (input.Key as { sk?: string } | undefined)?.sk === "FEATURE_ROLLOUT", error: { name: "ProvisionedThroughputExceededException", message: "throttled" }, times: 1 });

  it("a request reads the company's gates once, and the next request reads again (no cache between requests)", async () => {
    const t = await setupWizardBench({});
    process.env.VERIFY_RESULTS_ENABLED = "1";
    let gateReads = 0;
    const original = t.db.send.bind(t.db);
    t.db.send = ((command: { constructor: { name: string }; input?: { Key?: { sk?: string } } }) => { if (command.constructor.name === "GetCommand" && command.input?.Key?.sk === "FEATURE_ROLLOUT") gateReads += 1; return original(command as never); });
    expect((await t.web(OMAR, "GET", POLICY)).status).toBe(200);
    expect(gateReads).toBe(1);
    expect((await t.web(OMAR, "GET", POLICY)).status).toBe(200);
    expect(gateReads).toBe(2);
  });

  it("a gated route answers 503 RUNTIME_UNAVAILABLE when the request's gate could not be read: an explicit per-company OFF is never turned into ON, and a counter line says so", async () => {
    const t = await setupWizardBench({});
    process.env.VERIFY_RESULTS_ENABLED = "1";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    setGates(t.db, { ...GATES_ON, verifyResults: false });
    expect((await t.web(OMAR, "GET", POLICY)).status).toBe(404);
    failGateReads(t.db);
    const outage = await t.web(OMAR, "GET", POLICY);
    expect(outage.status).toBe(503);
    expect(JSON.stringify(outage.body)).toContain("RUNTIME_UNAVAILABLE");
    // The company's own row says on: still 503 while the read fails (never the answer a stale guess would give), and 200 once it reads.
    setGates(t.db, { ...GATES_ON, verifyResults: true });
    failGateReads(t.db);
    expect((await t.web(OMAR, "GET", POLICY)).status).toBe(503);
    expect((await t.web(OMAR, "GET", POLICY)).status).toBe(200);
    const lines = log.mock.calls.map((call) => String(call[0]));
    log.mockRestore();
    const counters = lines.filter((line) => line.includes("feature_rollout_unavailable"));
    expect(counters.length).toBeGreaterThanOrEqual(2);
    expect(counters[0]).toContain("verifyResults");
    expect(counters.join("")).not.toContain(TEST_ORG);
  });

  it("a route that reads no gate is untouched by a failed gate read", async () => {
    const t = await setupWizardBench({});
    process.env.VERIFY_RESULTS_ENABLED = "1";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    failGateReads(t.db);
    const me = await t.web(OMAR, "GET", "/v1/app/me");
    log.mockRestore();
    expect(me.status).toBe(200);
  });

  it("the browser save of setup and test commands is refused while the test environment is on, open to a company that turned it off, and a 503 (never open, never saved) when the gate cannot be read", async () => {
    const t = await setupWizardBench({});
    process.env.TEST_ENVIRONMENT_ENABLED = "1";
    let n = 0;
    const save = (expectedRevision = 1) => t.web(OMAR, "PUT", "/v1/app/projects/web/settings", { setupCommands: [`make new-setup-${(n += 1)}`], expectedRevision, requestId: `00000000-0000-4000-8000-00000000004${n}` });
    const refused = (reply: { status: number; body: unknown }) => JSON.stringify(reply.body).includes(PROOF_WORDS.provedInTestEnvironment);
    // No row: follows the install, on.
    expect(refused(await save())).toBe(true);
    // The company turned it off: the old save path is open to it (it is not this refusal).
    setGates(t.db, { ...GATES_ON, testEnvironment: false });
    expect(refused(await save())).toBe(false);
    // Its row cannot be read: the save is answered 503 and nothing is saved (a failed read never opens the save).
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    failGateReads(t.db);
    const revisionBefore = t.db.find((item) => item.entityType === "PROJECT").length;
    // (The save with the gate off went through, so the project is at revision 2.)
    const third = await save(2);
    log.mockRestore();
    expect(third.status).toBe(503);
    expect(refused(third)).toBe(false);
    expect(t.db.find((item) => item.entityType === "PROJECT")).toHaveLength(revisionBefore);
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

describe("the Fix setup wiring reads the evidence with the task's company (H2)", () => {
  const DIGEST = "d".repeat(64);
  const pack = EvidencePackSchema.parse({
    schemaVersion: 1, candidateDigest: DIGEST, environment: { tier: "sandbox", envRevision: 1, services: [], data: "synthetic", accounts: [] },
    checks: [{ checkId: "unit", kind: "test", label: "unit", before: "failed", after: "failed", class: "already_failing", durationMs: 5, tests: { total: 10, passed: 9, failed: 1, skipped: 0, errored: 0, newTests: [], names: [{ name: "Y", status: "failed" }] } }],
    selection: { method: "full", selected: 10, total: 10 }, api: [], browser: [], notTested: [],
  });
  const taskOf = (orgId: OrgId) => ({
    taskId: TASK_ID, orgId, project: "web", ownerKey: "dev_a", workspaceId: "ws",
    workflow: { candidate: { digest: DIGEST }, checkPolicy: { required: [{ id: "unit", label: "unit", kind: "test", command: { cwd: "repo/app", executable: "pytest", args: [], timeoutSeconds: 60 } }], optional: [], selectedOptionalIds: [], proposed: [] }, verification: { candidateDigest: DIGEST, results: [{ checkId: "unit", status: "FAILED" }] } },
  }) as unknown as DeveloperTaskRecord;
  const run = async (gate: boolean, orgId: OrgId = ORG_A) => {
    const db = new FakeDynamoDb();
    db.set({ ...orgFeatureRolloutKey(ORG_A), entityType: "FEATURE_ROLLOUT", orgId: ORG_A, gates: { proofEvidence: gate }, revision: 1 });
    let reads = 0;
    const s3 = { send: async (command: unknown) => { expect(command).toBeInstanceOf(GetObjectCommand); reads += 1; return { Body: { transformToString: async () => JSON.stringify(pack) } }; } };
    const dependencies = { documentClient: db, tableName: "state", now: Date.now, s3, artifactBucketName: "bucket" } as never;
    const checks = await fixSetupDependencies(dependencies, { VERIFY_RESULTS_ENABLED: "1", PROOF_EVIDENCE_ENABLED: "1" }).newFailingChecks!(taskOf(orgId), { unit: "failed" });
    return { checks, reads };
  };

  it("the real gated port reads the pack for the task's company when its gate is on", async () => {
    // The pack is read from the store for this company's task (the key carries its company, so the gated port lets it through).
    const on = await run(true);
    expect(on.reads).toBe(1);
    expect(on.checks).toEqual(["unit"]);
  });

  it("with the gate off the port reads nothing and the check is named from the run's own facts; a company with no row follows the install and reads", async () => {
    const off = await run(false);
    expect(off.reads).toBe(0);
    expect(off.checks).toEqual(["unit"]);
    const other = await run(true, ORG_B);
    expect(other.reads).toBe(1);
  });
});

describe("a gate that cannot be read is RUNTIME_UNAVAILABLE where work starts or is kept, never a silent off (M3)", () => {
  const PREPARED = { result: { preparedBase: [{ repositoryId: "web", baseCommitSha: "e".repeat(40) }] } };
  const failGateReads = (db: FakeDynamoDb) => db.injectFault({ command: "GetCommand", match: (input) => (input.Key as { sk?: string } | undefined)?.sk === "FEATURE_ROLLOUT", error: { name: "ProvisionedThroughputExceededException", message: "throttled" }, times: 50 });
  const tasks = (db: FakeDynamoDb) => db.find((item) => String(item.pk).startsWith("DEVTASK#") && item.sk === "META");
  const taskOf = (t: Awaited<ReturnType<typeof setupWizardBench>>) => t.db.find((item) => String(item.pk).startsWith("DEVTASK#") && item.purpose === "setup_draft").at(-1) as unknown as { taskId: string; workspaceId: string };
  const quick = (t: Awaited<ReturnType<typeof setupWizardBench>>) => t.dev(OMAR, "POST", "/v1/app/projects/web/code", { requestId: randomUUID(), input: { text: "Fix the retry bug" }, path: "QUICK" });

  it("the keep path throws RUNTIME_UNAVAILABLE and writes nothing", async () => {
    const calls: string[] = [];
    const documentClient = { send: async (command: unknown) => { calls.push((command as { constructor: { name: string } }).constructor.name); throw new Error("down"); } };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = await keepEvidenceAfterChecks({ s3: { send: async () => { throw new Error("no"); } }, artifactBucketName: "bucket", tableName: "state", documentClient } as never, { task: { taskId: TASK_ID, ownerKey: "dev_a", workspaceId: "ws", orgId: ORG_A }, operation: { id: "op", workflowMode: "CHECKS" } as never, workflow: { checkPolicy: undefined }, candidateDigest: "c".repeat(64), checks: [] }, INSTALL_ON).catch((caught: unknown) => caught as Error);
    log.mockRestore();
    expect(error).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(isGateUnavailable(error)).toBe(true);
    expect(calls).toEqual(["GetCommand"]);
  });

  it("starting a task refuses with RUNTIME_UNAVAILABLE and creates no task; the same start goes through when the gate reads", async () => {
    const t = await setupWizardBench({});
    process.env.TEST_ENVIRONMENT_ENABLED = "1";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect((await quick(t)).status).toBe(202);
    const before = tasks(t.db).length;
    failGateReads(t.db);
    const refused = await quick(t);
    log.mockRestore();
    expect(refused.status).toBeGreaterThanOrEqual(500);
    expect(JSON.stringify(refused.body)).toContain("RUNTIME_UNAVAILABLE");
    expect(tasks(t.db)).toHaveLength(before);
  });

  it("dispatching a run: a gate read that fails does NOT fail the prepare (it is told to be sent again, nothing is recorded), and the retried callback queues the run", async () => {
    const t = await setupWizardBench({});
    process.env.TEST_ENVIRONMENT_ENABLED = "1";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect((await t.ask()).status).toBe(202);
    const task = taskOf(t);
    const prepare = t.operations(task.workspaceId).find((operation) => operation.kind === "prepare")!;
    // Finishing the preparation reads the company's gate twice: the setup draft's end items (first), then the dispatch of the run (second). Only the second read fails, once: a DynamoDB throttle.
    let seen = 0;
    t.db.injectFault({ command: "GetCommand", match: (input) => (input.Key as { sk?: string } | undefined)?.sk === "FEATURE_ROLLOUT" && (seen += 1) >= 2, error: { name: "ProvisionedThroughputExceededException", message: "throttled" }, times: 1 });
    const first = await t.finish(task.workspaceId, prepare.id, "SUCCEEDED", PREPARED).catch((caught: unknown) => caught as Error);
    // The worker is told to try again; the prepare is not recorded as FAILED ("close this task and start a new one") and no run was sent.
    expect(first).toBeInstanceOf(Error);
    expect((first as Error).message).toContain("send the result again");
    expect(t.operations(task.workspaceId).find((operation) => operation.id === prepare.id)!.status).not.toBe("FAILED");
    expect(t.operations(task.workspaceId).some((operation) => operation.kind === "task")).toBe(false);
    // The retried callback reads the gate and queues the run.
    await t.finish(task.workspaceId, prepare.id, "SUCCEEDED", PREPARED);
    const lines = log.mock.calls.map((call) => String(call[0]));
    log.mockRestore();
    expect(seen).toBeGreaterThanOrEqual(2);
    expect(t.operations(task.workspaceId).find((operation) => operation.id === prepare.id)!.status).toBe("SUCCEEDED");
    expect(t.operations(task.workspaceId).some((operation) => operation.kind === "task")).toBe(true);
    expect(lines.some((line) => line.includes("feature_rollout_read_failed"))).toBe(true);
  });

  it("ending a setup draft throws RUNTIME_UNAVAILABLE (its environment draft is not dropped)", async () => {
    const t = await setupWizardBench({});
    process.env.TEST_ENVIRONMENT_ENABLED = "1";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect((await t.ask()).status).toBe(202);
    const task = taskOf(t);
    await t.finish(task.workspaceId, t.operations(task.workspaceId).find((operation) => operation.kind === "prepare")!.id, "SUCCEEDED", PREPARED);
    const own = t.operations(task.workspaceId).find((operation) => operation.kind === "task")!;
    failGateReads(t.db);
    const error = await t.finish(task.workspaceId, own.id, "SUCCEEDED", { result: { conversationId: randomUUID(), reopened: false, workflowMode: "SETUP_DRAFT" } }).catch((caught: unknown) => caught as Error);
    log.mockRestore();
    // A DynamoDB throttle reaches the worker as the temporary-error 503 it always did (RUNTIME_UNAVAILABLE), to be sent again.
    expect((error as Error).message).toContain("RUNTIME_UNAVAILABLE");
  });
});
