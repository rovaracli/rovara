// Test services, slice 1, s1-sealed T3: ONE task with a real Postgres, end to end, on a fake Docker CLI. The real modules of all four lanes are chained, nothing is stubbed but Docker, the table and the object store:
//
//   a repository (compose file + pytest)  ->  the worker's detectors put the dependency in the setup draft  ->  the broker proposes it from the signed catalog (the approve card says so)
//   ->  a person proves and approves it (a revision)  ->  a task pins it  ->  the plan for a coding run (IMPLEMENT) and for the checks (CHECKS), pinned by digest
//   ->  the worker starts the run (working phase, then a sealed round on brand-new helpers)  ->  the usage record  ->  the evidence pack  ->  the pull request line.
//
// Then the teardown on every way out (success, a failing check, a failed start, a cancel, a killed worker), and the golden tests with `tx` off. The live done-check is scripts/staging-test-services-e2e.sh. What this does NOT
// cover (needs real Docker, the Linux checks TS-L1..L6 on a staging worker): that the walls hold, that the image really starts and that a real resolver answers. See DEFERRED-CHECKS.
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CATALOG_SIGNATURE_ALGORITHM, EvidencePackSchema, TestEnvDraftSchema, TestServicesUsageRecordSchema, catalogSigningMessage, parseBundlePublicKey, projectMetaKey, projectRevisionKey, sha256HexOf, testEnvDigest,
  type OrgId, type ProjectCommand, type TaskDependencyPlan, type TestEnvDraft, type TestEnvTaskPlan, type TestEnvironmentBody, type TestServicesUsageRecord,
} from "@agentx/contracts";
import { approveTestEnvironment, proposeTestEnvironment, recordTestEnvProveReport, type TestEnvDeps } from "../../packages/broker/src/org/test-environment.js";
import { buildEvidencePack } from "../../packages/broker/src/rovara-code/evidence-pack.js";
import { evidenceLines } from "../../packages/broker/src/rovara-code/evidence-lines.js";
import { dependencyCardLines } from "../../packages/broker/src/test-env/dependency-card-lines.js";
import { sanitizeTestEnvDraft } from "../../packages/broker/src/test-env/draft.js";
import { evidenceEnvironmentOf } from "../../packages/broker/src/test-env/evidence-line.js";
import { testEnvImplementPlanFor, testEnvPlanFor } from "../../packages/broker/src/test-env/task-plan.js";
import { testEnvironmentForStart } from "../../packages/broker/src/test-env/usable.js";
import { setupWorkspaceKey } from "../../packages/worker/src/setup-network.js";
import { forgetWorkerStartSweeps } from "../../packages/worker/src/service-runner.js";
import { TaskSandbox } from "../../packages/worker/src/task-sandbox.js";
import { detectTestEnvironment } from "../../packages/worker/src/test-env-detect.js";
import {
  SEALED_ROUND_PORTS, TEST_SERVICES_USAGE_ARTIFACT, startTaskTestServices, testServicesAdvertisedFeatures, testServicesAtWorkerBoot, withTestServices,
  type TestServicesConfig, type TestServicesRun,
} from "../../packages/worker/src/test-services-run.js";
import { runChecks, type CheckPlan, type CheckRunners } from "../../packages/worker/src/verification/checks.js";
import { serviceCatalogSourceOf } from "../../packages/broker/src/test-env/dependency-plan.js";
import { loadBakedCatalog, startPrepareTestServices, collectTestServicesUsage } from "../../packages/worker/src/test-services-run.js";
import { OMAR } from "../support/developer-task-broker.js";
import { ENV as WIZARD_ENV, NAME as WIZARD_NAME, command as wizardCommand, draftBody, setupWizardBench, withSwitch } from "../support/setup-wizard-testenv.js";
import { capturingAuditDeps, AUDIT_CAPTURE_TABLE } from "../support/audit-capture.js";
import { loaderTrusting, pinnedCatalog, testSigner, verifiedCatalog } from "../support/catalog-pinning.js";
import { fakeServicesDocker, type FakeServicesDockerOptions } from "../support/fake-services-docker.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const TEST_ORG_ID = TEST_ORG;
const PROJECT = "svc";
const TASK = "task-1";
const ON = { TEST_ENVIRONMENT_ENABLED: "1", TEST_SERVICES_ENABLED: "1" };
const OFF = { TEST_ENVIRONMENT_ENABLED: "1" };
const IMAGE = `registry.example.test/agentx/worker@sha256:${"b".repeat(64)}`;
const REGISTRY = "123456789012.dkr.ecr.us-west-2.amazonaws.com";
const COMPOSE = ["services:", "  db:", "    image: postgres:16.4-alpine", "    environment:", "      POSTGRES_DB: app", "    ports:", '      - "127.0.0.1:5432:5432"', ""].join("\n");
const PYTEST = "[tool.pytest.ini_options]\naddopts = \"-q\"\n";

const roots: string[] = [];
afterEach(async () => { forgetWorkerStartSweeps(); await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function temp(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

// ---- the broker half: the proposal, the approval and the plan -----------------------------------------------------------------------------------------------------------------------------------------

const catalogSource = () => async () => verifiedCatalog(pinnedCatalog());

/** The worker's detectors over a real repository on disk: what a setup draft run puts in the draft. */
async function detectedDraft(): Promise<{ draft: TestEnvDraft; root: string }> {
  const root = await temp("tsp-repo-");
  await mkdir(join(root, PROJECT, "tests"), { recursive: true });
  await writeFile(join(root, PROJECT, "pyproject.toml"), PYTEST);
  await writeFile(join(root, PROJECT, "requirements.txt"), "pytest\n");
  await writeFile(join(root, PROJECT, "docker-compose.yml"), COMPOSE);
  await writeFile(join(root, PROJECT, "tests", "test_a.py"), "def test_a():\n    assert True\n");
  const draft = await detectTestEnvironment({ rootPath: root, repositories: [{ name: PROJECT, path: PROJECT, defaultBranch: "main" }] });
  if (draft === undefined) throw new Error("the detectors found nothing to draft");
  return { draft, root };
}

interface Broker { db: FakeDynamoDb; deps: TestEnvDeps & { serviceCatalog?: ReturnType<typeof catalogSource> }; proposalDigest: string; body: TestEnvironmentBody; readiness: ProjectCommand[] }

/** Proposes the draft's environment (as the broker sanitizes it with `tx` on), proves it and approves it as revision 1, then pins it for a task. */
async function approvedProject(draft: TestEnvDraft, env: NodeJS.ProcessEnv = ON): Promise<Broker> {
  const sanitized = sanitizeTestEnvDraft(draft, { env, propose: { catalog: verifiedCatalog(pinnedCatalog()), edition: "public", projectId: PROJECT } });
  if (sanitized === undefined) throw new Error("the draft was refused");
  const body = sanitized.environment;
  const readiness = body.repos.flatMap((repo) => repo.checks.map((check) => check.command));
  const db = new FakeDynamoDb();
  const audit = capturingAuditDeps({ db });
  db.set({ ...projectMetaKey(ORG, PROJECT), status: "active" });
  db.set({ ...projectRevisionKey(ORG, PROJECT, 1), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z", runtimeBinding: {}, definition: { name: PROJECT, revision: 1, repositories: [{ name: PROJECT, url: "https://github.com/acme/svc.git", path: PROJECT, defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness, orchestratorInstructions: "Delegate work." } });
  const clock = { now: Date.UTC(2026, 10, 3, 10, 0, 0) };
  const deps: Broker["deps"] = { documentClient: db, tableName: AUDIT_CAPTURE_TABLE, now: () => clock.now, audit: audit.audit, env, serviceCatalog: catalogSource() };
  const proposal = await proposeTestEnvironment(deps, { orgId: ORG, project: PROJECT, proposedBy: "dev_a", role: "maintainer", body });
  await recordTestEnvProveReport(deps, { orgId: ORG, project: PROJECT, report: { schemaVersion: 1, proposalDigest: proposal.digest, steps: [{ step: "setup", status: "passed", durationMs: 0 }, { step: "full_suite", status: "passed", durationMs: 0 }, ...(body.dependencies === undefined ? [] : [{ step: "dependencies", status: "passed", durationMs: 0 }, { step: "dependency_usage", status: "passed", durationMs: 0 }]), ], services: [], finishedAt: new Date(clock.now).toISOString() } });
  await approveTestEnvironment(deps, { orgId: ORG, project: PROJECT, digest: proposal.digest, expectedRevision: 0, requestId: "request-12345678", approvedBy: "dev_a", role: "maintainer", approvedBySignedInAtMs: clock.now - 1_000 });
  const start = await testEnvironmentForStart(deps, { orgId: ORG, project: PROJECT, taskId: TASK }, env);
  db.set((start.pin as { Put: { Item: Record<string, unknown> } }).Put.Item);
  return { db, deps, proposalDigest: proposal.digest, body, readiness };
}

describe("1. the proposal: the detectors, the chooser and the approve card", () => {
  it("the worker's detectors put Postgres in the draft as a candidate, with where it was seen, and the draft's environment carries none", async () => {
    const { draft } = await detectedDraft();
    expect(TestEnvDraftSchema.safeParse(draft).success).toBe(true);
    expect(draft.dependencies?.map((item) => item.family)).toEqual(["postgres"]);
    expect(draft.dependencies?.[0]?.evidence.some((entry) => entry.path === `${PROJECT}/docker-compose.yml`)).toBe(true);
    expect(draft.environment.dependencies).toBeUndefined();
  });

  it("with tx on the broker proposes it from the signed catalog as real Postgres 16, and the approve card says so plainly with its source line", async () => {
    const { draft } = await detectedDraft();
    const sanitized = sanitizeTestEnvDraft(draft, { env: ON, propose: { catalog: verifiedCatalog(pinnedCatalog()), edition: "public", projectId: PROJECT } })!;
    const proposed = sanitized.environment.dependencies ?? [];
    expect(proposed.map((item) => [item.id, item.family, item.backing.kind])).toEqual([["postgres", "postgres", "local"]]);
    expect(proposed[0]!.backing).toMatchObject({ kind: "local", catalogId: "postgres@16" });
    const [line] = dependencyCardLines(proposed);
    expect(line).toContain("Postgres");
    // The source line names the file and line the detector read it from.
    expect(line).toContain(`Found in ${PROJECT}/docker-compose.yml`);
  });

  it("approving makes a revision whose digest is the proposal's, and any other backing is refused as not available yet", async () => {
    const { draft } = await detectedDraft();
    const broker = await approvedProject(draft);
    expect(testEnvDigest(broker.body)).toBe(broker.proposalDigest);
    // A backing slice 1 cannot serve is never planned: an emulated, fake or test-account backing is refused at the plan, in fixed words.
    const other = structuredClone(draft);
    other.dependencies = [{ ...draft.dependencies![0]!, family: "aws:s3", kind: "object_store" }];
    const sanitized = sanitizeTestEnvDraft(other, { env: ON, propose: { catalog: verifiedCatalog(pinnedCatalog()), edition: "public", projectId: PROJECT } })!;
    expect((sanitized.environment.dependencies ?? []).every((item) => item.backing.kind !== "local")).toBe(true);
  });
});

describe("2. the task plan: IMPLEMENT and CHECKS carry the same pinned Postgres", () => {
  it("pins the dependency by digest from the signed catalog, for the checks and for the coding run", async () => {
    const { draft } = await detectedDraft();
    const broker = await approvedProject(draft);
    const checks = (await testEnvPlanFor(broker.deps, { orgId: ORG, project: PROJECT, taskId: TASK, readiness: broker.readiness }, ON))!;
    const coding = (await testEnvImplementPlanFor(broker.deps, { orgId: ORG, project: PROJECT, taskId: TASK }, ON))!;
    for (const plan of [checks, coding]) {
      expect(plan.dependencies?.map((item) => [item.id, item.catalogId, item.repository, item.backing])).toEqual([["postgres", "postgres@16", "svc/postgres", "local"]]);
      expect(plan.dependencies?.[0]?.digest).toMatch(/^[a-f0-9]{64}$/u);
    }
    expect(coding.dependencies).toEqual(checks.dependencies);
  });
});

// ---- the worker half ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const OPERATION = randomUUID();
const CHECK_PLAN = (readiness: ProjectCommand[]): CheckPlan => ({ source: "project", readiness, projectBefore: ["passed"] });
const BASE_RUNNERS: CheckRunners = {
  runProjectCommand: () => Promise.reject(new Error("the working sandbox's runners must not run an official check")),
  runAgentCommand: () => Promise.reject(new Error("the working sandbox's runners must not run an official check")),
};

async function workerBench(options: { docker?: FakeServicesDockerOptions; slowChecks?: boolean } = {}) {
  const fake = fakeServicesDocker(options.docker);
  // Official checks (a docker exec into the sealed check sandbox) can be made to hang until the signal stops them (a cancel).
  const docker = options.slowChecks === true
    ? { ...fake.docker, run: (args: readonly string[], runOptions?: { signal?: AbortSignal }) => (args[0] === "exec" && args.some((arg) => arg.endsWith("-check"))
      ? new Promise<never>((_, reject) => { runOptions?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); })
      : fake.docker.run(args, runOptions)) }
    : fake.docker;
  const root = await temp("tsp-work-");
  await mkdir(join(root, PROJECT), { recursive: true });
  const runParent = await temp("tsp-runs-");
  const artifacts: Array<{ name: string; mediaType: string; content: string }> = [];
  const config: TestServicesConfig = {
    docker, registry: REGISTRY, catalogEnv: "staging", edition: "public", probeImage: IMAGE, guardImage: IMAGE, maxMemMiB: 3072, runDirectoryParent: runParent,
    catalog: () => Promise.resolve(pinnedCatalog()), sealedRound: SEALED_ROUND_PORTS, sleep: () => Promise.resolve(), log: () => undefined,
  };
  const sandbox = new TaskSandbox({ rootPath: root, taskId: OPERATION, docker, image: IMAGE, log: () => undefined });
  await sandbox.start();
  const start = (plan: TestEnvTaskPlan | undefined, mode: "IMPLEMENT" | "CHECKS", cancellation?: Parameters<typeof startTaskTestServices>[0]["cancellation"]) => startTaskTestServices({
    plan, mode, sandbox, devcontainer: false, nightly: false, operationId: OPERATION, rootPath: root, repositoryPaths: [join(root, PROJECT)], config,
    artifactSink: (artifact) => { artifacts.push(artifact); return Promise.resolve(); }, ...(cancellation === undefined ? {} : { cancellation }),
  });
  return { fake, docker, root, runParent, config, sandbox, artifacts, start };
}
type Bench = Awaited<ReturnType<typeof workerBench>>;
const lastUsage = (bench: Bench): TestServicesUsageRecord => TestServicesUsageRecordSchema.parse(JSON.parse(bench.artifacts.filter((artifact) => artifact.name === TEST_SERVICES_USAGE_ARTIFACT).at(-1)!.content));
const run = async (bench: Bench, plan: TestEnvTaskPlan, readiness: ProjectCommand[], mode: "IMPLEMENT" | "CHECKS" = "CHECKS", signal = new AbortController().signal) => {
  const started = await bench.start(plan, mode);
  if (started === undefined) throw new Error("no run was started");
  const round = await runChecks(CHECK_PLAN(readiness), withTestServices(started, BASE_RUNNERS), { budgetMs: 60_000, signal });
  return { started, round };
};
const nothingLeft = async (bench: Bench): Promise<void> => {
  expect(bench.fake.left().networks).toEqual([]);
  expect(bench.fake.left().containers.filter((name) => name.startsWith("rovara-svc-"))).toEqual([]);
  expect(await readdir(bench.runParent)).toEqual([]);
};

describe("3. a task passes a check round against a real Postgres, and the PR says so", () => {
  it("IMPLEMENT: the working sandbox gets Postgres while the agent codes (by digest, from the catalog repository, with the run's variables)", async () => {
    const { draft } = await detectedDraft();
    const broker = await approvedProject(draft);
    const plan = (await testEnvImplementPlanFor(broker.deps, { orgId: ORG, project: PROJECT, taskId: TASK }, ON))!;
    const bench = await workerBench();
    const started = (await bench.start(plan, "IMPLEMENT"))!;
    expect(started.ids).toEqual(["postgres"]);
    const digest = plan.dependencies![0]!.digest;
    // The worker never pulls: root pre-pulled the digest, and the worker only checks it is on the host.
    expect(bench.fake.pulls).toEqual([]);
    expect(bench.fake.verbs("image").some((call) => call[1] === "inspect" && call.includes(`${REGISTRY}/rovara-catalog/staging/svc/postgres@sha256:${digest}`))).toBe(true);
    const connect = bench.fake.verbs("network").find((call) => call[1] === "connect");
    expect(connect).toBeDefined();
    expect(connect).toContain(bench.sandbox.name);
    await started.dispose();
    await nothingLeft(bench);
  });

  it("CHECKS: the official round runs sealed on a fresh Postgres, the record says it ran healthy, and the evidence and the PR line say Postgres (real)", async () => {
    const { draft } = await detectedDraft();
    const broker = await approvedProject(draft);
    const plan = (await testEnvPlanFor(broker.deps, { orgId: ORG, project: PROJECT, taskId: TASK, readiness: broker.readiness }, ON))!;
    const bench = await workerBench();
    const { started, round } = await run(bench, plan, broker.readiness);
    expect(round.entries.map((entry) => entry.after)).toEqual(broker.readiness.map(() => "passed"));
    // The usage record the worker saved, in the broker's contract.
    const record = lastUsage(bench);
    expect(record.dependencies).toEqual([expect.objectContaining({ id: "postgres", started: true, healthy: true })]);
    expect(record.unknownCalls).toEqual({ domains: [], otherCount: 0 });
    // The broker turns it into evidence with ITS OWN labels (the worker's words never set one) and the pull request line.
    const chosen = await evidenceEnvironmentOf(broker.deps, { orgId: ORG, project: PROJECT, taskId: TASK }, ON);
    expect(chosen.dependencies).toEqual([{ id: "postgres", name: "Postgres", backing: "local" }]);
    const raw = JSON.stringify({ schemaVersion: 1, candidateDigest: "c".repeat(64), checks: [], selection: { method: "full", selected: 1, total: 1 }, testServices: record });
    const built = buildEvidencePack({ candidateDigest: "c".repeat(64), rawText: raw, checks: round.entries, environment: chosen.environment!, storedArtifacts: new Map(), ...(chosen.dependencies === undefined ? {} : { dependencies: chosen.dependencies }) });
    expect(EvidencePackSchema.safeParse(built.pack).success).toBe(true);
    expect(built.pack?.environment.dependencies).toEqual([expect.objectContaining({ name: "Postgres", backing: "local", label: "real" })]);
    expect(evidenceLines({ pack: built.pack, mode: "summary" }, "c".repeat(64), 0).lines).toContain("Integration tests ran against: Postgres (real).");
    await started.dispose();
    await nothingLeft(bench);
  });

  it("a test that calls an unlisted host is counted as 'Blocked by environment' by registrable domain and count, never by name", async () => {
    const { draft } = await detectedDraft();
    const broker = await approvedProject(draft);
    const plan = (await testEnvPlanFor(broker.deps, { orgId: ORG, project: PROJECT, taskId: TASK, readiness: broker.readiness }, ON))!;
    // The name server's record is read with one fixed `docker exec <dns helper> cat`: the fake answers it with names the program asked for, one of them carrying a secret as a label.
    const asked = JSON.stringify({ unknown: [{ name: "api.example-pay.com", queries: 3 }, { name: `${"x".repeat(5)}.tracker.example-pay.com`, queries: 4 }], dropped: 0, unrecorded: 0 });
    const bench = await workerBench();
    const dockerWithRecord = { ...bench.docker, run: (args: readonly string[], options?: unknown) => (args[0] === "exec" && args.includes("cat") && args.some((arg) => arg.endsWith("-dns")) ? Promise.resolve({ exitCode: 0, stdout: asked, stderr: "" }) : bench.docker.run(args, options as never)) };
    (bench.config as { docker: unknown }).docker = dockerWithRecord;
    const { started } = await run(bench, plan, broker.readiness);
    const record = lastUsage(bench);
    // 3 + 4 lookups under one registrable domain: the record shows the bucket they fall in (6 to 20), shown as its lower bound.
    expect(record.unknownCalls.domains).toEqual([{ domain: "example-pay.com", count: 6 }]);
    expect(JSON.stringify(record)).not.toContain("tracker");
    expect(JSON.stringify(record)).not.toContain("api.");
    await started.dispose();
  });

  it("the official round and the TESTPROOF rerun each get fresh helpers", async () => {
    const { draft } = await detectedDraft();
    const broker = await approvedProject(draft);
    const plan = (await testEnvPlanFor(broker.deps, { orgId: ORG, project: PROJECT, taskId: TASK, readiness: broker.readiness }, ON))!;
    const bench = await workerBench();
    const started = (await bench.start(plan, "CHECKS"))!;
    const runners = withTestServices(started, BASE_RUNNERS);
    await runChecks(CHECK_PLAN(broker.readiness), runners, { budgetMs: 60_000, signal: new AbortController().signal });
    const afterFirst = bench.fake.verbs("network").filter((call) => call[1] === "create").length;
    await runChecks(CHECK_PLAN(broker.readiness), runners, { budgetMs: 60_000, signal: new AbortController().signal });
    // A CHECKS run has no working phase: one network per round, and no working-phase Postgres at all.
    expect(afterFirst).toBe(1);
    expect(bench.fake.verbs("network").filter((call) => call[1] === "create")).toHaveLength(2);
    await started.dispose();
    await nothingLeft(bench);
  });
});

describe("4. teardown on every way out", () => {
  it("after a failing check: the round fails, and nothing with the run-network labels is left, and the run directory is gone", async () => {
    const { draft } = await detectedDraft();
    const broker = await approvedProject(draft);
    const plan = (await testEnvPlanFor(broker.deps, { orgId: ORG, project: PROJECT, taskId: TASK, readiness: broker.readiness }, ON))!;
    const bench = await workerBench({ docker: { execExit: (args) => (args.some((arg) => arg.endsWith("-check")) ? 1 : 0) } });
    const { started, round } = await run(bench, plan, broker.readiness);
    expect(round.entries.map((entry) => entry.after)).toEqual(broker.readiness.map(() => "failed"));
    await started.dispose();
    await nothingLeft(bench);
  });

  it("after a start that fails (the helper does not run): a coding run fails in fixed words, a CHECKS run's round is not run and its record says why; nothing is left", async () => {
    const { draft } = await detectedDraft();
    const broker = await approvedProject(draft);
    const plan = (await testEnvPlanFor(broker.deps, { orgId: ORG, project: PROJECT, taskId: TASK, readiness: broker.readiness }, ON))!;
    const coding = await workerBench({ docker: { failRun: "helper" } });
    await expect(coding.start(plan, "IMPLEMENT")).rejects.toThrow(/test services|could not be started|did not start|could not/iu);
    await nothingLeft(coding);
    // A CHECKS run starts services only inside its sealed rounds: the run starts, the round cannot, no check runs, and the record names the failure in fixed words.
    const checks = await workerBench({ docker: { failRun: "helper" } });
    const started = (await checks.start(plan, "CHECKS"))!;
    const round = await runChecks(CHECK_PLAN(broker.readiness), withTestServices(started, BASE_RUNNERS), { budgetMs: 60_000, signal: new AbortController().signal });
    expect(round.entries.map((entry) => entry.after)).toEqual(broker.readiness.map(() => "not_run"));
    expect((await started.usageRecord())?.dependencies).toEqual([expect.objectContaining({ id: "postgres", started: false, healthy: false, failure: "start_failed" })]);
    await started.dispose();
    await nothingLeft(checks);
  });

  it("after a cancel in the middle of an official check: the round stops, the check sandbox and everything else are removed", async () => {
    const { draft } = await detectedDraft();
    const broker = await approvedProject(draft);
    const plan = (await testEnvPlanFor(broker.deps, { orgId: ORG, project: PROJECT, taskId: TASK, readiness: broker.readiness }, ON))!;
    const bench = await workerBench({ slowChecks: true });
    const started = (await bench.start(plan, "CHECKS"))!;
    const controller = new AbortController();
    const running = runChecks(CHECK_PLAN(broker.readiness), withTestServices(started, BASE_RUNNERS), { budgetMs: 60_000, signal: controller.signal });
    await new Promise<void>((done) => { const poll = setInterval(() => { if (bench.fake.left().containers.some((name) => name.endsWith("-check"))) { clearInterval(poll); done(); } }, 5); });
    controller.abort();
    const round = await running;
    expect(round.stopped).toBe(true);
    await started.dispose();
    await nothingLeft(bench);
  });

  it("after a killed worker: the next worker's start removes what carries the run-network labels of this workspace, and only that", async () => {
    const { draft } = await detectedDraft();
    const broker = await approvedProject(draft);
    const listing: string[] = [];
    const bench = await workerBench({ docker: { listing } });
    // A coding run holds its working-phase helper and network for the whole task; the worker is killed in the middle of it, so nothing is disposed.
    const implement = (await testEnvImplementPlanFor(broker.deps, { orgId: ORG, project: PROJECT, taskId: TASK }, ON))!;
    await bench.start(implement, "IMPLEMENT");
    const workspace = await setupWorkspaceKey(bench.root);
    const leftover = [...bench.fake.left().containers.filter((name) => name.startsWith("rovara-svc-")), ...bench.fake.left().networks];
    expect(leftover.length).toBeGreaterThan(0);
    for (const id of leftover) listing.push(`${id}\trovara-svc-0123456789ab\t1\t${workspace}\t2`);
    // Another workspace's object and a thing without the family are in the listing's shadow: they are not rows of this workspace, so they are never asked for.
    forgetWorkerStartSweeps();
    await testServicesAtWorkerBoot({ rootPath: bench.root, config: bench.config, log: () => undefined });
    expect(bench.fake.left().containers.filter((name) => name.startsWith("rovara-svc-"))).toEqual([]);
    expect(bench.fake.left().networks).toEqual([]);
  });
});

describe("5. with tx off the worker and the broker are what they were (golden)", () => {
  it("the broker plans no dependencies, proposes none and the draft is today's draft", async () => {
    const { draft } = await detectedDraft();
    const off = sanitizeTestEnvDraft(draft, { env: OFF, propose: { catalog: verifiedCatalog(pinnedCatalog()), edition: "public", projectId: PROJECT } })!;
    expect(off.environment.dependencies).toBeUndefined();
    expect("dependencies" in off).toBe(false);
    const withoutCandidates = structuredClone(draft);
    delete withoutCandidates.dependencies;
    expect(off).toEqual(sanitizeTestEnvDraft(withoutCandidates, { env: OFF })!);
  });

  it("an environment WITHOUT dependencies gets the same plan with tx on and off, and no `dependencies` key", async () => {
    const { draft } = await detectedDraft();
    const plain = structuredClone(draft);
    delete plain.dependencies;
    const broker = await approvedProject(plain, OFF);
    const off = await testEnvPlanFor(broker.deps, { orgId: ORG, project: PROJECT, taskId: TASK, readiness: broker.readiness }, OFF);
    const on = await testEnvPlanFor(broker.deps, { orgId: ORG, project: PROJECT, taskId: TASK, readiness: broker.readiness }, ON);
    expect(off).toBeDefined();
    expect(JSON.stringify(on)).toBe(JSON.stringify(off));
    expect(JSON.stringify(off)).not.toContain("dependencies");
    expect(await testEnvImplementPlanFor(broker.deps, { orgId: ORG, project: PROJECT, taskId: TASK }, ON)).toBeUndefined();
    expect(await testEnvImplementPlanFor(broker.deps, { orgId: ORG, project: PROJECT, taskId: TASK }, OFF)).toBeUndefined();
  });

  it("an approved environment WITH dependencies is not used at all with tx off", async () => {
    const { draft } = await detectedDraft();
    const broker = await approvedProject(draft, ON);
    expect(await testEnvPlanFor(broker.deps, { orgId: ORG, project: PROJECT, taskId: TASK, readiness: broker.readiness }, OFF)).toBeUndefined();
    expect(await testEnvImplementPlanFor(broker.deps, { orgId: ORG, project: PROJECT, taskId: TASK }, OFF)).toBeUndefined();
  });

  it("the worker makes no Docker call and starts nothing for a plan without dependencies, and advertises nothing without a configuration", async () => {
    const bench = await workerBench();
    const before = bench.fake.calls.length;
    const plain: TestEnvTaskPlan = { revision: 1, digest: "d".repeat(64), roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, checks: [{ id: "unit", kind: "test" }] };
    const started: TestServicesRun | undefined = await bench.start(plain, "CHECKS");
    expect(started).toBeUndefined();
    expect(bench.fake.calls.length).toBe(before);
    // Runners are the caller's own, unchanged.
    expect(withTestServices(undefined, BASE_RUNNERS)).toBe(BASE_RUNNERS);
    expect(testServicesAdvertisedFeatures({})).toEqual([]);
  });

  it("the evidence and the PR lines of a run with no dependencies are today's", () => {
    const environment = { tier: "sandbox" as const, envRevision: 1, services: [], data: "synthetic" as const, accounts: [] };
    const checks = [{ id: "readiness:0", label: "pytest -q", source: "project" as const, before: "passed" as const, after: "passed" as const, class: "passing" as const, output: "", durationMs: 7, exitCode: 0 }];
    const built = buildEvidencePack({ candidateDigest: "c".repeat(64), rawText: undefined, checks, environment, storedArtifacts: new Map() });
    expect("dependencies" in built.pack!.environment).toBe(false);
    expect(evidenceLines({ pack: built.pack, mode: "summary" }, "c".repeat(64), 0).lines.join("\n")).not.toMatch(/ran against/u);
  });
});

// ---- 6. Prove, through the real seams: worker prepare -> the result the broker keeps -> the Prove report, with a catalog that arrives through the SIGNED trust path ---------------------------------------------------

describe("6. Prove: the candidate check's record goes from the worker to the Prove report", () => {
  afterEach(() => { delete process.env.TEST_SERVICES_ENABLED; delete process.env.TEST_ENVIRONMENT_ENABLED; vi.unstubAllEnvs(); });

  /** The release's catalog, signed by a TEST key and read through the broker's own source (signature check, minimum revision): `@agentx/contracts/testing` supplies the key, in test code only. */
  async function signedSource() {
    const signer = testSigner();
    const catalogBytes = Buffer.from(`${JSON.stringify(pinnedCatalog(), null, 2)}\n`, "utf8");
    const signature = { schemaVersion: 1, algorithm: CATALOG_SIGNATURE_ALGORITHM, keyId: parseBundlePublicKey(signer.publicKeyPem).keyId, catalogSha256: sha256HexOf(catalogBytes), signature: (await signer.sign(catalogSigningMessage(catalogBytes))).toString("base64") };
    return serviceCatalogSourceOf({ read: async () => ({ catalogBytes, signatureBytes: Buffer.from(JSON.stringify(signature)) }), trust: { runningAccountId: undefined }, load: loaderTrusting(signer.publicKeyPem) });
  }

  it("a proposal's candidate check is sent the pinned plan; the worker starts it, runs the test check sealed and reports a record; the broker keeps it and derives both dependency steps", async () => {
    const source = await signedSource();
    // The broker's side is checked first: a catalog nobody signed gives the broker nothing to pin.
    expect(await source()).toBeDefined();
    const bench = await setupWizardBench({ autoCandidate: false, brokerExtra: { serviceCatalog: source } });
    process.env.TEST_SERVICES_ENABLED = "1";
    await withSwitch("1", async () => {
      const postgres = {
        id: "postgres", name: "Postgres", kind: "database", family: "postgres", found: [{ path: "docker-compose.yml", line: 4 }], usedBy: ["integration"], backing: { kind: "local", catalogId: "postgres@16", config: {} },
        connect: { env: [{ name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}:{port}/{db}" }], hostAliases: ["postgres"] }, seeds: [], reset: "fresh_per_round",
      };
      const environment = draftBody({ dependencies: [postgres], repos: [{ repositoryId: "web", setupCommands: [wizardCommand("make", ["old-setup"], 900)], checks: [{ id: "unit", label: "Unit tests", command: wizardCommand("make", ["old-test"], 1800), kind: "test" }] }] });
      const proposal = await proposeTestEnvironment({ documentClient: bench.db, tableName: "state", now: () => Date.now() }, { orgId: TEST_ORG_ID, project: WIZARD_NAME, proposedBy: OMAR.developerId, role: "maintainer", body: environment });
      const started = await bench.dev(OMAR, "POST", `${WIZARD_ENV}/check`, { digest: proposal.digest, requestId: randomUUID() });
      expect(started.status, JSON.stringify(started.body)).toBe(202);
      const candidate = (bench.db.find((item) => item.entityType === "TEST_ENV_CANDIDATE_CHECK") as unknown as Array<{ workspaceId: string }>)[0]!;
      const outbox = bench.db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === candidate.workspaceId)[0] as unknown as { invocation: { payload: { testServices: { dependencies: TaskDependencyPlan[] } } } };
      const sent = outbox.invocation.payload.testServices.dependencies;
      expect(sent.map((entry) => entry.id)).toEqual(["postgres"]);

      // The worker half: the plan the broker sent, a catalog baked into the image (written here from the same release catalog), the fake Docker, the sealed round for the test check.
      const work = await workerBench();
      const dir = await temp("tsp-baked-");
      await writeFile(join(dir, "catalog.json"), JSON.stringify(pinnedCatalog()));
      (work.config as { catalog: () => Promise<unknown> }).catalog = () => loadBakedCatalog(join(dir, "catalog.json"));
      const collector = collectTestServicesUsage();
      const services = await startPrepareTestServices({ options: { dependencies: sent, testChecks: [0], config: work.config, onUsageRecord: collector.collect }, sandbox: work.sandbox, devcontainer: false, operationId: OPERATION, rootPath: work.root, repositoryPaths: [] });
      const ran = await services!.sealedReadiness(async () => ({ exitCode: 0, stdout: "", stderr: "" }))({ cwd: ".", executable: "make", args: ["old-test"], timeoutSeconds: 60 }, 0, work.root);
      expect(ran.exitCode).toBe(0);
      await services!.finish();
      await work.sandbox.dispose();
      const reported = collector.result();
      expect(Object.keys(reported)).toEqual(["testServicesUsage"]);

      // The broker half: the prepare result is finished with the worker's own result object; the record is kept on the check and Prove derives its steps from it.
      const prepareId = String((bench.db.get(`WORKSPACE#${candidate.workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
      await bench.finish(candidate.workspaceId, prepareId, "SUCCEEDED", { result: reported });
      const kept = (bench.db.find((item) => item.entityType === "TEST_ENV_CANDIDATE_CHECK") as unknown as Array<{ usage?: unknown }>)[0]!;
      expect(TestServicesUsageRecordSchema.parse(kept.usage).dependencies[0]).toMatchObject({ id: "postgres", started: true, healthy: true });
      const proved = await bench.dev(OMAR, "POST", `${WIZARD_ENV}/prove`, { digest: proposal.digest });
      expect(proved.status, JSON.stringify(proved.body)).toBe(200);
      const report = (bench.db.find((item) => item.entityType === "TEST_ENV_PROVE")[0] as unknown as { report: { steps: Array<{ step: string; status: string }> } }).report;
      expect(report.steps).toEqual(expect.arrayContaining([expect.objectContaining({ step: "dependencies", status: "passed" }), expect.objectContaining({ step: "dependency_usage", status: "passed" })]));
    });
  });
});
