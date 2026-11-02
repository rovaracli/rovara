// Test environment (wire-testenv): the task flow's broker half. Which approved environment a task may use (the production list, recordings, sandbox only), how a task pins the revision it started with, the plan
// a verification run is sent, and what the evidence says about the environment.
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { TestEnvironmentBodySchema, projectMetaKey, projectPk, testEnvDigest, type CheckEntry, type OrgId, type TestEnvironment, type TestEnvironmentBody, type ProjectCommand } from "@agentx/contracts";
import { keepEvidence, loadEvidencePack, type KeepEvidenceDeps } from "../../packages/broker/src/rovara-code/evidence-keep.js";
import { approveTestEnvironment, proposeTestEnvironment, recordTestEnvProveReport, type TestEnvDeps } from "../../packages/broker/src/org/test-environment.js";
import { evidenceEnvironmentOf } from "../../packages/broker/src/test-env/evidence-line.js";
import { testEnvPlanFor } from "../../packages/broker/src/test-env/task-plan.js";
import { UNUSED_WORDS, environmentUnusedReason, readTestEnvPin, testEnvPinItem, testEnvironmentForStart, usableTestEnvironment } from "../../packages/broker/src/test-env/usable.js";
import { taskWorkflowCheckPolicy } from "../../packages/broker/src/aws/developer-tasks/common.js";
import { capturingAuditDeps, AUDIT_CAPTURE_TABLE } from "../support/audit-capture.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const PROJECT = "service";
const ON = { TEST_ENVIRONMENT_ENABLED: "1" };
const cmd = (executable: string, args: string[] = []): ProjectCommand => ({ cwd: "service", executable, args, timeoutSeconds: 600 });
const body = (over: Record<string, unknown> = {}): TestEnvironmentBody => TestEnvironmentBodySchema.parse({
  tier: "sandbox",
  repos: [{ repositoryId: "service", setupCommands: [cmd("pip", ["install", "-e", "."])], checks: [
    { id: "unit", label: "Unit tests", command: cmd("pytest", ["-q"]), kind: "test", selectArgs: ["{tests}"] },
    { id: "lint", label: "Lint", command: cmd("ruff", ["check"]), kind: "lint" },
  ] }],
  roundBudgetMin: 30, selection: { method: "coverage_map", alwaysRun: ["lint"], fullSuiteOn: ["poetry.lock"] },
  nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" }, services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [],
  prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false },
  ...over,
});
const asEnvironment = (environment: TestEnvironmentBody, revision = 1): TestEnvironment => ({ revision, approvedAt: "2026-11-02T10:00:00.000Z", environment });

function harness() {
  const db = new FakeDynamoDb();
  const audit = capturingAuditDeps({ db });
  db.set({ ...projectMetaKey(ORG, PROJECT), status: "active" });
  const clock = { now: Date.UTC(2026, 10, 2, 10, 0, 0) };
  const deps: TestEnvDeps = { documentClient: db, tableName: AUDIT_CAPTURE_TABLE, now: () => clock.now, audit: audit.audit };
  /** Approves `environment` as the project's next revision (the Prove run is recorded directly: the store is under test here, not the setup check). */
  const approve = async (environment: TestEnvironmentBody, expectedRevision = 0) => {
    const proposal = await proposeTestEnvironment(deps, { orgId: ORG, project: PROJECT, proposedBy: "dev_a", role: "maintainer", body: environment });
    await recordTestEnvProveReport(deps, { orgId: ORG, project: PROJECT, report: { schemaVersion: 1, proposalDigest: proposal.digest, steps: [{ step: "setup", status: "passed", durationMs: 0 }, { step: "full_suite", status: "passed", durationMs: 0 }], services: [], finishedAt: new Date(clock.now).toISOString() } });
    return approveTestEnvironment(deps, { orgId: ORG, project: PROJECT, digest: proposal.digest, expectedRevision, requestId: `request-${proposal.digest.slice(0, 8)}`, approvedBy: "dev_a", role: "maintainer", approvedBySignedInAtMs: clock.now - 1_000 });
  };
  return { db, deps, clock, approve };
}

describe("which approved environment a task may use", () => {
  it("a plain sandbox is used", () => {
    expect(environmentUnusedReason(asEnvironment(body()))).toBeUndefined();
  });

  it("an environment that points at production is not used, whatever approved it", () => {
    // The approval refuses these; the task flow reads again, so one approved by an earlier build or a path with fewer checks is still not used.
    const preprod = body({
      services: [{ name: "scorer", kind: "sagemaker_runtime", match: { endpointName: "scorer" }, mode: "preprod", preprod: { endpointArn: "arn:aws:sagemaker:us-west-2:222233334444:endpoint/scorer", roleArn: "arn:aws:iam::222233334444:role/invoke", region: "us-west-2" } }],
      prodDeny: { accountIds: ["999900001111"], hosts: [], arnPrefixes: [] },
    });
    // The same environment, with a deny list that names its account, as the store holds it when approved by a path that did not refuse it.
    const named = { ...preprod, prodDeny: { accountIds: ["222233334444"], hosts: [], arnPrefixes: [] } } as TestEnvironmentBody;
    expect(environmentUnusedReason(asEnvironment(named))).toBe("names_production");
    // And one that reaches a remote with no list at all.
    expect(environmentUnusedReason(asEnvironment({ ...preprod, prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] } }))).toBe("names_production");
  });

  it("recordings are not allowed in the shared tier, whatever the accounts", () => {
    const shared = { ...body(), tier: "shared", shared: { baseUrl: "https://beta.example.com", leaseScope: "env", dataNamespace: "task_prefix" }, capture: { screenshots: "failed", video: true, traces: false }, accounts: [{ profileId: "buyer", provisioner: "seed_command", command: cmd("python", ["seed.py"]) }], prodDeny: { accountIds: [], hosts: ["*.prod.example.com"], arnPrefixes: [] } } as TestEnvironmentBody;
    expect(environmentUnusedReason(asEnvironment(shared))).toBe("recording_not_allowed");
    expect(environmentUnusedReason(asEnvironment({ ...shared, capture: { screenshots: "failed", video: false, traces: true } }))).toBe("recording_not_allowed");
    // Without a recording the shared tier is simply not carried out by tasks yet.
    expect(environmentUnusedReason(asEnvironment({ ...shared, capture: { screenshots: "failed", video: false, traces: false } }))).toBe("tier_not_connected");
  });

  it("services, accounts and the preview or shared tiers are not carried out by tasks yet, so the environment is not applied", () => {
    const withService = body({ services: [{ name: "scorer", kind: "sagemaker_runtime", match: { endpointName: "scorer" }, mode: "mock", mock: { fixtureSetRef: "a".repeat(64), schemaRef: "b".repeat(64), unmatched: "fail" } }] });
    expect(environmentUnusedReason(asEnvironment(withService))).toBe("services_not_connected");
    // A long-lived (registered) account is a credential that outlives the round: never carried by a task.
    expect(environmentUnusedReason(asEnvironment(body({ accounts: [{ profileId: "buyer", provisioner: "registered", registryProfileId: "buyer" }] })))).toBe("accounts_not_connected");
    expect(environmentUnusedReason(asEnvironment(body({ accounts: [{ profileId: "buyer", provisioner: "seed_command", command: cmd("python", ["seed.py"]) }] })))).toBe("accounts_not_connected");
    const preview = body({ tier: "preview", preview: { provider: "cdk", stackTemplate: "infra/stack.ts", deployRoleArn: "arn:aws:iam::222233334444:role/deploy", ttlHours: 4, costCapUsdPerDay: 10, fallbackTier: "sandbox" }, prodDeny: { accountIds: ["111122223333"], hosts: [], arnPrefixes: [] } });
    expect(environmentUnusedReason(asEnvironment(preview))).toBe("tier_not_connected");
    for (const reason of ["services_not_connected", "accounts_not_connected", "tier_not_connected", "names_production", "recording_not_allowed"] as const) expect(UNUSED_WORDS[reason]).not.toMatch(/\d/u);
  });

  it("with the switch off nothing is read, and it is never an environment", async () => {
    const h = harness();
    await h.approve(body());
    const reads = vi.fn(h.db.send.bind(h.db));
    const counted = { ...h.deps, documentClient: { send: reads } };
    for (const env of [{}, { TEST_ENVIRONMENT_ENABLED: "0" }, { TEST_ENVIRONMENT_ENABLED: "true" }]) {
      expect(await usableTestEnvironment(counted, ORG, PROJECT, undefined, env)).toEqual({ ok: false, reason: "none" });
      expect(await testEnvironmentForStart(counted, { orgId: ORG, project: PROJECT, taskId: "t1" }, env)).toEqual({});
      expect(await testEnvPlanFor(counted, { orgId: ORG, project: PROJECT, taskId: "t1", readiness: [cmd("pytest", ["-q"])] }, env)).toBeUndefined();
      expect(await evidenceEnvironmentOf(counted, { orgId: ORG, project: PROJECT, taskId: "t1" }, env)).toEqual({});
    }
    expect(reads).not.toHaveBeenCalled();
  });

  it("with the switch on the newest approved sandbox is used, and none approved is none", async () => {
    const h = harness();
    expect(await usableTestEnvironment(h.deps, ORG, PROJECT, undefined, ON)).toEqual({ ok: false, reason: "none" });
    await h.approve(body());
    const found = await usableTestEnvironment(h.deps, ORG, PROJECT, undefined, ON);
    expect(found.ok && found.environment.revision).toBe(1);
  });

  it("an item that does not read back is unreadable, never used", async () => {
    const h = harness();
    await h.approve(body());
    const item = h.db.find((entry) => String(entry.sk).startsWith("TESTENV#REV#"))[0]!;
    h.db.set({ ...item, environment: { tier: "sandbox" } });
    expect(await usableTestEnvironment(h.deps, ORG, PROJECT, undefined, ON)).toEqual({ ok: false, reason: "unreadable" });
  });
});

describe("recordings in the approval", () => {
  const shared = (capture: { video: boolean; traces: boolean }) => body({
    tier: "shared", shared: { baseUrl: "https://beta.example.com", leaseScope: "env", dataNamespace: "task_prefix" },
    accounts: [{ profileId: "buyer", provisioner: "seed_command", command: cmd("python", ["seed.py"]) }], prodDeny: { accountIds: [], hosts: ["*.prod.example.com"], arnPrefixes: [] },
    capture: { screenshots: "failed", ...capture },
  });
  it("a video or a trace in the shared tier is refused when proposed, and never approvable", async () => {
    const h = harness();
    for (const capture of [{ video: true, traces: false }, { video: false, traces: true }]) {
      await expect(proposeTestEnvironment(h.deps, { orgId: ORG, project: PROJECT, proposedBy: "dev_a", role: "maintainer", body: shared(capture) })).rejects.toThrow(/video and traces are kept only in the sandbox/);
    }
    // The same environment without a recording is a proposal like any other (a less-safe one: a second person on the confirmation page).
    await expect(proposeTestEnvironment(h.deps, { orgId: ORG, project: PROJECT, proposedBy: "dev_a", role: "maintainer", body: shared({ video: false, traces: false }) })).resolves.toMatchObject({ risk: "high" });
  });
});

describe("the task's pin", () => {
  it("a task start pins the revision it uses, and a later approval does not change it", async () => {
    const h = harness();
    await h.approve(body());
    const start = await testEnvironmentForStart(h.deps, { orgId: ORG, project: PROJECT, taskId: "t1" }, ON);
    expect(start.used?.revision).toBe(1);
    h.db.set((start.pin as { Put: { Item: Record<string, unknown> } }).Put.Item);
    // A later revision that runs more (one more file that runs the whole suite): narrowing which tests run would be a less-safe change with a second person.
    await h.approve(body({ roundBudgetMin: 30, selection: { method: "coverage_map", alwaysRun: ["lint"], fullSuiteOn: ["poetry.lock", "Makefile"] } }), 1);
    expect((await usableTestEnvironment(h.deps, ORG, PROJECT, undefined, ON) as { environment: TestEnvironment }).environment.revision).toBe(2);
    expect(await readTestEnvPin(h.deps, ORG, PROJECT, "t1")).toMatchObject({ revision: 1 });
  });

  it("an environment that exists but cannot be applied is pinned as not applied, with the reason", async () => {
    const h = harness();
    await h.approve(body({ accounts: [{ profileId: "buyer", provisioner: "seed_command", command: cmd("python", ["seed.py"]) }] }));
    const start = await testEnvironmentForStart(h.deps, { orgId: ORG, project: PROJECT, taskId: "t2" }, ON);
    expect(start.used).toBeUndefined();
    h.db.set((start.pin as { Put: { Item: Record<string, unknown> } }).Put.Item);
    expect(await readTestEnvPin(h.deps, ORG, PROJECT, "t2")).toMatchObject({ revision: 1, unused: "accounts_not_connected" });
    // The evidence says which, in place of the plain "no approved environment".
    const chosen = await evidenceEnvironmentOf(h.deps, { orgId: ORG, project: PROJECT, taskId: "t2" }, ON);
    expect(chosen.environment).toBeUndefined();
    expect(chosen.note?.text).toContain(UNUSED_WORDS.accounts_not_connected);
  });

  it("a pin for an environment that was not applied names the revision that was judged: the newest revision is read once", async () => {
    const h = harness();
    await h.approve(body({ accounts: [{ profileId: "buyer", provisioner: "seed_command", command: cmd("python", ["seed.py"]) }] }));
    const latestReads: unknown[] = [];
    const spy = { ...h.deps, documentClient: { send: (command: { input?: { Key?: { sk?: string } } }) => { if (command.input?.Key?.sk === "TESTENV#LATEST") latestReads.push(1); return h.db.send(command as never); } } };
    const start = await testEnvironmentForStart(spy, { orgId: ORG, project: PROJECT, taskId: "t5" }, ON);
    expect(latestReads).toHaveLength(1);
    expect((start.pin as { Put: { Item: Record<string, unknown> } }).Put.Item).toMatchObject({ revision: 1, unused: "accounts_not_connected" });
  });

  it("a pin is another task's, another org's or damaged: none", async () => {
    const h = harness();
    await h.approve(body());
    const start = await testEnvironmentForStart(h.deps, { orgId: ORG, project: PROJECT, taskId: "t3" }, ON);
    const item = (start.pin as { Put: { Item: Record<string, unknown> } }).Put.Item;
    h.db.set(item);
    expect(await readTestEnvPin(h.deps, ORG, PROJECT, "other")).toBeUndefined();
    expect(await readTestEnvPin(h.deps, "org_bbbbbbbbbbbbbbbbbbbb", PROJECT, "t3")).toBeUndefined();
    h.db.set({ ...item, revision: "1" });
    expect(await readTestEnvPin(h.deps, ORG, PROJECT, "t3")).toBeUndefined();
    h.db.set({ ...item, unused: "something_else" });
    expect(await readTestEnvPin(h.deps, ORG, PROJECT, "t3")).toBeUndefined();
    expect(testEnvPinItem("t", { orgId: ORG, project: PROJECT, taskId: "x", nowMs: 0 })).toBeUndefined();
  });
});

describe("the checks a task is held to", () => {
  const project = { readiness: [cmd("make", ["old-test"]), cmd("pytest", ["-q"])] } as never;

  it("are the project's readiness commands without an environment, as before", () => {
    const policy = taskWorkflowCheckPolicy(project);
    expect(policy.required.map((check) => check.command.executable)).toEqual(["make", "pytest"]);
    expect(policy.required.every((check) => check.kind === undefined)).toBe(true);
  });

  it("are the environment's checks first, with their kinds, then any readiness command the environment does not run", () => {
    const policy = taskWorkflowCheckPolicy(project, body());
    expect(policy.required.map((check) => [check.id, check.command.executable, check.kind])).toEqual([["required-1", "pytest", "test"], ["required-2", "ruff", "lint"], ["required-3", "make", undefined]]);
    expect(policy.required[0]!.label).toBe("Unit tests");
  });
});

describe("the plan a verification run is sent", () => {
  async function pinned(environment: TestEnvironmentBody = body()) {
    const h = harness();
    await h.approve(environment);
    const start = await testEnvironmentForStart(h.deps, { orgId: ORG, project: PROJECT, taskId: "t1" }, ON);
    h.db.set((start.pin as { Put: { Item: Record<string, unknown> } }).Put.Item);
    return h;
  }
  const readiness = [cmd("pytest", ["-q"]), cmd("ruff", ["check"]), cmd("make", ["old-test"])];
  const planOf = (h: Awaited<ReturnType<typeof pinned>>, ready = readiness, env: NodeJS.ProcessEnv = ON) => testEnvPlanFor(h.deps, { orgId: ORG, project: PROJECT, taskId: "t1", readiness: ready }, env);

  it("carries the environment's checks, selection rules and budget, bound to its digest", async () => {
    const h = await pinned();
    const plan = (await planOf(h))!;
    expect(plan).toMatchObject({ revision: 1, digest: testEnvDigest(body()), roundBudgetMin: 30, selection: { method: "coverage_map", alwaysRun: ["lint"], fullSuiteOn: ["poetry.lock"] } });
    expect(plan.checks).toEqual([{ id: "unit", kind: "test", selectArgs: ["{tests}"] }, { id: "lint", kind: "lint" }]);
    expect(plan.coverageMap).toBeUndefined();
  });

  it("carries the approved coveragePath of a check (S-2), and nothing for a check that has none", async () => {
    const withPath = body({ repos: [{ repositoryId: "service", setupCommands: [], checks: [
      { id: "unit", label: "Unit tests", command: cmd("pytest", ["-q"]), kind: "test", selectArgs: ["{tests}"], coveragePath: "reports/coverage.xml" },
      { id: "lint", label: "Lint", command: cmd("ruff", ["check"]), kind: "lint" },
    ] }] });
    const h = await pinned(withPath);
    const plan = (await planOf(h))!;
    expect(plan.checks).toEqual([{ id: "unit", kind: "test", coveragePath: "reports/coverage.xml", selectArgs: ["{tests}"] }, { id: "lint", kind: "lint" }]);
  });

  it("carries the tests that failed in the last nightly, when there is a baseline", async () => {
    const h = await pinned();
    h.db.set({ pk: projectPk(ORG, PROJECT), sk: "TESTENV#BASELINE#LATEST", entityType: "TEST_ENV_BASELINE_LATEST", orgId: ORG, project: PROJECT, baseline: {
      recordedAt: "2026-11-02T06:00:00.000Z", envRevision: 1, branch: "main", headSha: "a".repeat(40), finishedAt: "2026-11-02T06:00:00.000Z", tests: { total: 10, passed: 9, failed: 1, skipped: 0 }, failed: ["tests/test_a.py::test_x"], flaky: [],
    } });
    expect((await planOf(h))!.lastNightlyFailures).toEqual(["tests/test_a.py::test_x"]);
  });

  it("is not built when the run's first commands are not the environment's checks, or fewer", async () => {
    const h = await pinned();
    expect(await planOf(h, [cmd("make", ["old-test"]), cmd("pytest", ["-q"]), cmd("ruff", ["check"])])).toBeUndefined();
    expect(await planOf(h, [cmd("pytest", ["-q"])])).toBeUndefined();
    expect(await planOf(h, [cmd("pytest", ["-q", "-x"]), cmd("ruff", ["check"])])).toBeUndefined();
    expect(await planOf(h, [])).toBeUndefined();
  });

  it("is not built for a task with no pin, a pin for an environment that was not applied, or a pin for other contents", async () => {
    const h = harness();
    await h.approve(body());
    expect(await planOf(h)).toBeUndefined();
    const start = await testEnvironmentForStart(h.deps, { orgId: ORG, project: PROJECT, taskId: "t1" }, ON);
    const item = (start.pin as { Put: { Item: Record<string, unknown> } }).Put.Item;
    h.db.set({ ...item, unused: "services_not_connected" });
    expect(await planOf(h)).toBeUndefined();
    h.db.set({ ...item, digest: "f".repeat(64) });
    expect(await planOf(h)).toBeUndefined();
    h.db.set(item);
    expect(await planOf(h)).toBeDefined();
    expect(await planOf(h, readiness, {})).toBeUndefined();
  });

  it("re-checks the narrowing rule at dispatch: an approved environment with `{tests}` on a command that is not a test runner, or that passes with no tests, gets no plan", async () => {
    for (const unsafe of [cmd("make", ["old-test"]), cmd("pnpm", ["run", "jest"]), cmd("jest", ["--passWithNoTests"])]) {
      const h = harness();
      await h.approve(body({ repos: [{ repositoryId: "service", setupCommands: [], checks: [{ id: "unit", label: "Unit tests", command: unsafe, kind: "test", selectArgs: ["{tests}"] }] }], selection: { method: "coverage_map", alwaysRun: [], fullSuiteOn: [] } }));
      const start = await testEnvironmentForStart(h.deps, { orgId: ORG, project: PROJECT, taskId: "t1" }, ON);
      h.db.set((start.pin as { Put: { Item: Record<string, unknown> } }).Put.Item);
      expect(await planOf(h, [unsafe]), JSON.stringify(unsafe.args)).toBeUndefined();
    }
  });

  it("is not built when the pinned revision can no longer be used (it names production now)", async () => {
    const h = await pinned();
    const stored = h.db.find((entry) => String(entry.sk).startsWith("TESTENV#REV#"))[0]!;
    // The store holds a revision whose digest and contents agree, but whose deny list now names a remote it reaches.
    const hostile = { ...body(), services: [{ name: "scorer", kind: "sagemaker_runtime", match: { endpointName: "scorer" }, mode: "preprod", preprod: { endpointArn: "arn:aws:sagemaker:us-west-2:222233334444:endpoint/scorer", roleArn: "arn:aws:iam::222233334444:role/invoke", region: "us-west-2" } }], prodDeny: { accountIds: ["222233334444"], hosts: [], arnPrefixes: [] } };
    h.db.set({ ...stored, environment: hostile, digest: "x" });
    expect(await planOf(h)).toBeUndefined();
  });
});

describe("the evidence's environment", () => {
  it("names the pinned environment and its revision, and gives the data guard its production list", async () => {
    const h = harness();
    await h.approve(body({ prodDeny: { accountIds: ["111122223333"], hosts: [], arnPrefixes: [] } }));
    const start = await testEnvironmentForStart(h.deps, { orgId: ORG, project: PROJECT, taskId: "t1" }, ON);
    h.db.set((start.pin as { Put: { Item: Record<string, unknown> } }).Put.Item);
    const chosen = await evidenceEnvironmentOf(h.deps, { orgId: ORG, project: PROJECT, taskId: "t1" }, ON);
    expect(chosen.environment).toEqual({ tier: "sandbox", envRevision: 1, services: [], data: "synthetic", accounts: [] });
    expect(chosen.deny).toEqual({ accountIds: ["111122223333"], hosts: [], arnPrefixes: [] });
    expect(chosen.note).toBeUndefined();
    // A task with no pin says nothing (the pack then reads as it always did).
    expect(await evidenceEnvironmentOf(h.deps, { orgId: ORG, project: PROJECT, taskId: "t9" }, ON)).toEqual({});
    expect(await evidenceEnvironmentOf(h.deps, { project: PROJECT, taskId: "t1" }, ON)).toEqual({});
  });
});

describe("the pack kept for a task that pinned an environment", () => {
  const DIGEST = "c".repeat(64);
  const OP = "op-1";
  const TASK = { ownerKey: "owner-1", workspaceId: "ws-1", taskId: "t1" };
  const PREFIX = `private/${TASK.ownerKey}/${TASK.workspaceId}/${OP}/`;
  const raw = JSON.stringify({ schemaVersion: 1, candidateDigest: DIGEST, checks: [{ checkId: "readiness:0", tests: { total: 3, passed: 3, failed: 0, skipped: 0, errored: 0, names: [{ name: "a", status: "passed" }, { name: "b", status: "passed" }, { name: "c", status: "passed" }], newTests: [] } }], selection: { method: "full", selected: 3, total: 3 } });
  const objects = new Map<string, string>();
  const s3 = { async send(command: unknown) {
    if (command instanceof PutObjectCommand) { objects.set(command.input.Key!, String(command.input.Body as string)); return {}; }
    if (command instanceof GetObjectCommand) { const found = objects.get(command.input.Key!); if (found === undefined) throw new Error("NoSuchKey"); return { Body: { transformToString: async () => found } }; }
    throw new Error("unexpected command");
  } } as unknown as S3Client;
  const actions: KeepEvidenceDeps["actions"] = { async artifacts() { return [{ name: "evidence-raw.json", objectKey: `${PREFIX}evidence-raw.json` }]; }, async readArtifact(key) { return key.startsWith(PREFIX) ? raw : objects.get(key) ?? ""; } };
  const deps: KeepEvidenceDeps = { actions, store: { s3, artifactBucketName: "bucket" }, markStored: async () => undefined };
  const checks: CheckEntry[] = [{ id: "readiness:0", label: "pytest -q", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 7, exitCode: 0 }];

  it("keepEvidence names the revision it ran in, and says why when the project's environment was not applied", async () => {
    const used = await keepEvidence(deps, { orgId: TEST_ORG, task: TASK, operationId: OP, candidateDigest: DIGEST, checks, environment: { tier: "sandbox", envRevision: 4, services: [], data: "synthetic", accounts: [] } });
    expect(used).toMatchObject({ kept: true });
    const pack = await loadEvidencePack(actions, TASK, DIGEST);
    expect(pack?.environment).toMatchObject({ tier: "sandbox", envRevision: 4 });
    expect(pack?.notTested.some((item) => item.id === "test_environment")).toBe(false);
    const note = { kind: "environment" as const, id: "test_environment", text: `${UNUSED_WORDS.accounts_not_connected}: the project's own test setup was used`, reason: "not applied" };
    objects.clear();
    expect(await keepEvidence(deps, { orgId: TEST_ORG, task: TASK, operationId: OP, candidateDigest: DIGEST, checks, environmentNote: note })).toMatchObject({ kept: true });
    const unused = await loadEvidencePack(actions, TASK, DIGEST);
    expect(unused?.environment.envRevision).toBe(0);
    expect(unused?.notTested.find((item) => item.id === "test_environment")?.text).toContain("test accounts");
  });
});
