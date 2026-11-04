// Test services, slice 2: ONE task with a real Postgres AND an S3 bucket, an SQS queue and a DynamoDB table (Rovara local AWS), end to end, on a fake Docker CLI and a fake emulator control. Same chain as the slice-1 e2e
// (test-services-postgres.test.ts), with the real modules of every lane:
//
//   a repository (compose file + CloudFormation template + pytest)  ->  the worker's detectors (compose + D7 IaC) put the dependencies in the draft  ->  the broker proposes Postgres (local) and S3, SQS and DynamoDB (emulated)
//   ->  a person approves a revision  ->  the plans for coding (IMPLEMENT) and for the checks (CHECKS), pinned by digest  ->  the worker starts ONE emulator for the three, seeds it from the project's template through the
//   control API, runs a sealed round on brand-new helpers and reads the request ledger  ->  the usage record  ->  the evidence pack  ->  the pull request line and the IAM line.
//
// Then the failure cases (a call outside the plan, a flooded ledger, a seed refusal), teardown on every way out, and Prove. Not covered (needs the real emulator and a Linux host): that the image starts, that the control paths
// are really refused from the sealed sandbox (FORK-CTRL-1 and the done-check's escape tests), memory in a 384 MiB container. See the staging steps in the s2-integration report.
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CATALOG_SIGNATURE_ALGORITHM, EvidencePackSchema, TestEnvDraftSchema, catalogSigningMessage, parseBundlePublicKey, sha256HexOf, type TaskDependencyPlan, TestServicesUsageRecordSchema, projectMetaKey, projectRevisionKey, testEnvDigest,
  type OrgId, type ProjectCommand, type TestEnvDraft, type TestEnvTaskPlan, type TestEnvironmentBody, type TestServicesUsageRecord,
} from "@agentx/contracts";
import { approveTestEnvironment, proposeTestEnvironment, recordTestEnvProveReport, type TestEnvDeps } from "../../packages/broker/src/org/test-environment.js";
import { buildEvidencePack } from "../../packages/broker/src/rovara-code/evidence-pack.js";
import { evidenceLines } from "../../packages/broker/src/rovara-code/evidence-lines.js";
import { AWS_PERMISSIONS_NOT_CHECKED, AWS_USAGE_ITEM_ID } from "../../packages/broker/src/rovara-code/dependency-evidence.js";
import { dependencyCardLines } from "../../packages/broker/src/test-env/dependency-card-lines.js";
import { sanitizeTestEnvDraft } from "../../packages/broker/src/test-env/draft.js";
import { evidenceEnvironmentOf } from "../../packages/broker/src/test-env/evidence-line.js";
import { testEnvImplementPlanFor, testEnvPlanFor } from "../../packages/broker/src/test-env/task-plan.js";
import { testEnvironmentForStart } from "../../packages/broker/src/test-env/usable.js";
import { forgetWorkerStartSweeps } from "../../packages/worker/src/service-runner.js";
import { TaskSandbox } from "../../packages/worker/src/task-sandbox.js";
import { detectTestEnvironment } from "../../packages/worker/src/test-env-detect.js";
import {
  SEALED_ROUND_PORTS, TEST_SERVICES_USAGE_ARTIFACT, collectTestServicesUsage, loadBakedCatalog, startPrepareTestServices, startTaskTestServices, withTestServices, type TestServicesConfig,
} from "../../packages/worker/src/test-services-run.js";
import { runChecks, type CheckPlan, type CheckRunners } from "../../packages/worker/src/verification/checks.js";
import { serviceCatalogSourceOf } from "../../packages/broker/src/test-env/dependency-plan.js";
import { OMAR } from "../support/developer-task-broker.js";
import { ENV as WIZARD_ENV, NAME as WIZARD_NAME, command as wizardCommand, draftBody, setupWizardBench, withSwitch } from "../support/setup-wizard-testenv.js";
import { TEST_ORG } from "../support/orgs.js";
import { loaderTrusting, testSigner } from "../support/catalog-pinning.js";
import { capturingAuditDeps, AUDIT_CAPTURE_TABLE } from "../support/audit-capture.js";
import { digestOfId, pinnedCatalog, verifiedCatalog } from "../support/catalog-pinning.js";
import { fakeLocalAws, ledgerOf, type FakeLocalAwsOptions } from "../support/fake-local-aws.js";
import { fakeServicesDocker, type FakeServicesDockerOptions } from "../support/fake-services-docker.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const PROJECT = "svc";
const TASK = "task-1";
const ON = { TEST_ENVIRONMENT_ENABLED: "1", TEST_SERVICES_ENABLED: "1" };
const OFF = { TEST_ENVIRONMENT_ENABLED: "1" };
const IMAGE = `registry.example.test/agentx/worker@sha256:${"b".repeat(64)}`;
const REGISTRY = "123456789012.dkr.ecr.us-west-2.amazonaws.com";
const AWS_IMAGE = `${REGISTRY}/rovara-catalog/staging/svc/local-aws@sha256:${digestOfId("local-aws@r1")}`;
const COMPOSE = ["services:", "  db:", "    image: postgres:16.4-alpine", "    environment:", "      POSTGRES_DB: app", ""].join("\n");
const PYTEST = "[tool.pytest.ini_options]\naddopts = \"-q\"\n";
const TEMPLATE = `AWSTemplateFormatVersion: "2010-09-09"
Resources:
  OrdersTable:
    Type: AWS::DynamoDB::Table
    Properties:
      TableName: orders
      AttributeDefinitions:
        - { AttributeName: orderId, AttributeType: S }
      KeySchema:
        - { AttributeName: orderId, KeyType: HASH }
  ArchiveBucket:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: orders-archive
  EventsQueue:
    Type: AWS::SQS::Queue
    Properties:
      QueueName: order-events
  AlertsTopic:
    Type: AWS::SNS::Topic
    Properties:
      TopicName: alerts
`;
const SEED: ProjectCommand = { cwd: PROJECT, executable: "seed-aws-data", args: [], timeoutSeconds: 60 };
const PR_LINE = "Integration tests ran against: Postgres (real), S3, SQS and DynamoDB (Rovara local AWS).";
const GOOD_LEDGER = ledgerOf({ s3: { PutObject: { calls: 3 }, GetObject: { calls: 2 } }, sqs: { SendMessage: { calls: 2 } }, dynamodb: { PutItem: { calls: 4 } } });

const roots: string[] = [];
afterEach(async () => { forgetWorkerStartSweeps(); await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function temp(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}
async function writeRepo(root: string): Promise<void> {
  await mkdir(join(root, PROJECT, "tests"), { recursive: true });
  await writeFile(join(root, PROJECT, "pyproject.toml"), PYTEST);
  await writeFile(join(root, PROJECT, "requirements.txt"), "pytest\n");
  await writeFile(join(root, PROJECT, "docker-compose.yml"), COMPOSE);
  await writeFile(join(root, PROJECT, "template.yaml"), TEMPLATE);
  await writeFile(join(root, PROJECT, "tests", "test_a.py"), "def test_a():\n    assert True\n");
}

// ---- the broker half ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const catalogSource = () => async () => verifiedCatalog(pinnedCatalog());
const proposeContext = { catalog: verifiedCatalog(pinnedCatalog()), edition: "public" as const, projectId: PROJECT };

async function detectedDraft(): Promise<TestEnvDraft> {
  const root = await temp("tsa-repo-");
  await writeRepo(root);
  const draft = await detectTestEnvironment({ rootPath: root, repositories: [{ name: PROJECT, path: PROJECT, defaultBranch: "main" }] });
  if (draft === undefined) throw new Error("the detectors found nothing to draft");
  return draft;
}

interface Broker { db: FakeDynamoDb; deps: TestEnvDeps & { serviceCatalog?: ReturnType<typeof catalogSource> }; proposalDigest: string; body: TestEnvironmentBody; readiness: ProjectCommand[] }

async function approvedProject(draft: TestEnvDraft, env: NodeJS.ProcessEnv = ON): Promise<Broker> {
  const sanitized = sanitizeTestEnvDraft(draft, { env, propose: proposeContext });
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
  await recordTestEnvProveReport(deps, { orgId: ORG, project: PROJECT, report: { schemaVersion: 1, proposalDigest: proposal.digest, steps: [{ step: "setup", status: "passed", durationMs: 0 }, { step: "full_suite", status: "passed", durationMs: 0 }, ...(body.dependencies === undefined ? [] : [{ step: "dependencies", status: "passed", durationMs: 0 }, { step: "dependency_usage", status: "passed", durationMs: 0 }])], services: [], finishedAt: new Date(clock.now).toISOString() } });
  await approveTestEnvironment(deps, { orgId: ORG, project: PROJECT, digest: proposal.digest, expectedRevision: 0, requestId: "request-12345678", approvedBy: "dev_a", role: "maintainer", approvedBySignedInAtMs: clock.now - 1_000 });
  const start = await testEnvironmentForStart(deps, { orgId: ORG, project: PROJECT, taskId: TASK }, env);
  db.set((start.pin as { Put: { Item: Record<string, unknown> } }).Put.Item);
  return { db, deps, proposalDigest: proposal.digest, body, readiness };
}

describe("1. the proposal: Postgres local, S3 SQS and DynamoDB emulated, from the real detectors", () => {
  it("the detectors put Postgres and the three AWS services in the draft, with where they were seen; SNS is a candidate too", async () => {
    const draft = await detectedDraft();
    expect(TestEnvDraftSchema.safeParse(draft).success).toBe(true);
    expect(draft.dependencies?.map((item) => item.family).sort()).toEqual(["aws:dynamodb", "aws:s3", "aws:sns", "aws:sqs", "postgres"]);
    expect(draft.dependencies?.filter((item) => item.family.startsWith("aws:")).every((item) => item.evidence.every((entry) => entry.path === `${PROJECT}/template.yaml`))).toBe(true);
  });

  it("the broker proposes Postgres as local and S3, SQS and DynamoDB as emulated (one alias, the template as the resource pointer); SNS is left out; the card says so plainly", async () => {
    const draft = await detectedDraft();
    const sanitized = sanitizeTestEnvDraft(draft, { env: ON, propose: proposeContext })!;
    const proposed = sanitized.environment.dependencies ?? [];
    expect(proposed.map((item) => [item.id, item.backing.kind])).toEqual(expect.arrayContaining([["postgres", "local"], ["aws-s3", "emulated"], ["aws-sqs", "emulated"], ["aws-dynamodb", "emulated"]]));
    expect(proposed).toHaveLength(4);
    const emulated = proposed.filter((item) => item.backing.kind === "emulated");
    expect(emulated.map((item) => item.connect.hostAliases.length).sort()).toEqual([0, 0, 1]);
    for (const item of emulated) expect(item.backing).toMatchObject({ kind: "emulated", catalogId: "local-aws@r1", region: "us-east-1", resources: { provider: "cloudformation", path: `${PROJECT}/template.yaml` } });
    expect(sanitized.notes.join(" ")).toMatch(/cannot start yet/u);
    const lines = dependencyCardLines(proposed);
    expect(lines.filter((line) => line.includes("Rovara local AWS"))).toHaveLength(3);
    expect(lines.filter((line) => line.includes(": runs ")).every((line) => line.includes("Found in"))).toBe(true);
    expect(lines.join("\n")).toContain("Not checked here: AWS permissions and exact AWS behaviour");
  });

  it("the PR line follows the order of the approved environment: the detectors' own (alphabetical) order reads DynamoDB, S3 and SQS", async () => {
    const broker = await approvedProject(await detectedDraft());
    const checks = (await testEnvPlanFor(broker.deps, { orgId: ORG, project: PROJECT, taskId: TASK, readiness: broker.readiness }, ON))!;
    const bench = await workerBench();
    const { started, round } = await run(bench, checks, broker.readiness);
    const { lines } = await evidenceFor(broker, lastUsage(bench), round);
    expect(lines.lines).toContain("Integration tests ran against: Postgres (real), DynamoDB, S3 and SQS (Rovara local AWS).");
    await started.dispose();
    await bench.sandbox.dispose();
  });

  it("approving makes a revision whose digest is the proposal's", async () => {
    const broker = await approvedProject(await detectedDraft());
    expect(testEnvDigest(broker.body)).toBe(broker.proposalDigest);
  });

  it("with tx off the draft proposes no dependencies at all", async () => {
    const off = sanitizeTestEnvDraft(await detectedDraft(), { env: OFF, propose: proposeContext })!;
    expect(off.environment.dependencies).toBeUndefined();
  });
});

describe("2. the task plan: IMPLEMENT and CHECKS carry the same pinned dependencies", () => {
  it("pins Postgres and the three emulated entries by digest, the emulated ones with their services, region and the template pointer", async () => {
    const broker = await approvedProject(await detectedDraft());
    const checks = (await testEnvPlanFor(broker.deps, { orgId: ORG, project: PROJECT, taskId: TASK, readiness: broker.readiness }, ON))!;
    const coding = (await testEnvImplementPlanFor(broker.deps, { orgId: ORG, project: PROJECT, taskId: TASK }, ON))!;
    for (const plan of [checks, coding]) {
      const byId = new Map((plan.dependencies ?? []).map((item) => [item.id, item]));
      expect([...byId.keys()].sort()).toEqual(["aws-dynamodb", "aws-s3", "aws-sqs", "postgres"]);
      expect(byId.get("postgres")).toMatchObject({ catalogId: "postgres@16", backing: "local" });
      for (const [id, service] of [["aws-s3", "s3"], ["aws-sqs", "sqs"], ["aws-dynamodb", "dynamodb"]] as const) {
        expect(byId.get(id)).toMatchObject({ catalogId: "local-aws@r1", repository: "svc/local-aws", backing: "emulated", digest: digestOfId("local-aws@r1"), aws: { services: [service], region: "us-east-1", resources: { provider: "cloudformation", path: `${PROJECT}/template.yaml` } } });
      }
    }
    expect(coding.dependencies).toEqual(checks.dependencies);
  });

  it("with tx off the plans carry nothing, and an approved environment with these dependencies is not used", async () => {
    const broker = await approvedProject(await detectedDraft(), ON);
    expect(await testEnvPlanFor(broker.deps, { orgId: ORG, project: PROJECT, taskId: TASK, readiness: broker.readiness }, OFF)).toBeUndefined();
    expect(await testEnvImplementPlanFor(broker.deps, { orgId: ORG, project: PROJECT, taskId: TASK }, OFF)).toBeUndefined();
  });

  it("a catalog without a pinned local-aws gives no plan for AWS: the dependency is 'not available yet', never started", async () => {
    const broker = await approvedProject(await detectedDraft());
    const without = verifiedCatalog(pinnedCatalog((entries) => { entries.splice(0, entries.length, ...entries.filter((entry) => entry["id"] !== "local-aws@r1")); }));
    const deps = { ...broker.deps, serviceCatalog: async () => without };
    await expect(testEnvPlanFor(deps, { orgId: ORG, project: PROJECT, taskId: TASK, readiness: broker.readiness }, ON)).rejects.toThrow("not available yet");
    await expect(testEnvImplementPlanFor(deps, { orgId: ORG, project: PROJECT, taskId: TASK }, ON)).rejects.toThrow("not available yet");
  });
});

// ---- the worker half ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const OPERATION = randomUUID();
const CHECK_PLAN = (readiness: ProjectCommand[]): CheckPlan => ({ source: "project", readiness, projectBefore: ["passed"] });
const BASE_RUNNERS: CheckRunners = {
  runProjectCommand: () => Promise.reject(new Error("the working sandbox's runners must not run an official check")),
  runAgentCommand: () => Promise.reject(new Error("the working sandbox's runners must not run an official check")),
};
const envOf = (file: string | undefined, name: string): string | undefined => new RegExp(`^${name}=(.*)$`, "mu").exec(file ?? "")?.[1];

async function workerBench(options: { docker?: FakeServicesDockerOptions; aws?: Partial<FakeLocalAwsOptions>; slowChecks?: boolean } = {}) {
  const fake = fakeServicesDocker(options.docker);
  const aws = fakeLocalAws(fake, { image: AWS_IMAGE, ledger: GOOD_LEDGER, mark: SEED.executable, ...(options.aws ?? {}) });
  const docker = options.slowChecks === true
    ? { ...fake.docker, run: (args: readonly string[], runOptions?: { signal?: AbortSignal }) => (args[0] === "exec" && args.some((arg) => arg.endsWith("-check"))
      ? new Promise<never>((_, reject) => { runOptions?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); })
      : fake.docker.run(args, runOptions)) }
    : fake.docker;
  const root = await temp("tsa-work-");
  await writeRepo(root);
  const runParent = await temp("tsa-runs-");
  const artifacts: Array<{ name: string; mediaType: string; content: string }> = [];
  const config: TestServicesConfig = {
    docker, registry: REGISTRY, catalogEnv: "staging", edition: "public", probeImage: IMAGE, maxMemMiB: 3072, runDirectoryParent: runParent,
    catalog: () => Promise.resolve(pinnedCatalog()), sealedRound: SEALED_ROUND_PORTS, sleep: () => Promise.resolve(), log: () => undefined,
  };
  const sandbox = new TaskSandbox({ rootPath: root, taskId: OPERATION, docker, image: IMAGE, log: () => undefined });
  await sandbox.start();
  const start = (plan: TestEnvTaskPlan | undefined, mode: "IMPLEMENT" | "CHECKS") => startTaskTestServices({
    plan, mode, sandbox, devcontainer: false, nightly: false, operationId: OPERATION, rootPath: root, repositoryPaths: [join(root, PROJECT)], config,
    artifactSink: (artifact) => { artifacts.push(artifact); return Promise.resolve(); },
  });
  return { fake, aws, docker, root, runParent, config, sandbox, artifacts, start };
}
type Bench = Awaited<ReturnType<typeof workerBench>>;
const lastUsage = (bench: Bench): TestServicesUsageRecord => TestServicesUsageRecordSchema.parse(JSON.parse(bench.artifacts.filter((artifact) => artifact.name === TEST_SERVICES_USAGE_ARTIFACT).at(-1)!.content));
const run = async (bench: Bench, plan: TestEnvTaskPlan, readiness: ProjectCommand[]) => {
  const started = await bench.start(plan, "CHECKS");
  if (started === undefined) throw new Error("no run was started");
  const round = await runChecks(CHECK_PLAN(readiness), withTestServices(started, BASE_RUNNERS), { budgetMs: 60_000, signal: new AbortController().signal });
  return { started, round };
};
const nothingLeft = async (bench: Bench): Promise<void> => {
  expect(bench.fake.left().networks).toEqual([]);
  expect(bench.fake.left().containers.filter((name) => name.startsWith("rovara-svc-"))).toEqual([]);
  expect(await readdir(bench.runParent)).toEqual([]);
};
/** The draft with its dependencies in the order the design's PR line reads (the detectors list them alphabetically; the line follows the approved environment's order). */
async function orderedDraft(): Promise<TestEnvDraft> {
  const draft = await detectedDraft();
  const rank = ["postgres", "aws:s3", "aws:sqs", "aws:dynamodb"];
  draft.dependencies = [...(draft.dependencies ?? [])].sort((a, b) => rank.indexOf(a.family) - rank.indexOf(b.family));
  return draft;
}
async function plans() {
  const broker = await approvedProject(await orderedDraft());
  const checks = (await testEnvPlanFor(broker.deps, { orgId: ORG, project: PROJECT, taskId: TASK, readiness: broker.readiness }, ON))!;
  const coding = (await testEnvImplementPlanFor(broker.deps, { orgId: ORG, project: PROJECT, taskId: TASK }, ON))!;
  return { broker, checks, coding };
}
/** The broker's evidence for a round's record, the way the real pack is built from the raw file. */
async function evidenceFor(broker: Broker, record: TestServicesUsageRecord, round: { entries: Parameters<typeof buildEvidencePack>[0]["checks"] }) {
  const chosen = await evidenceEnvironmentOf(broker.deps, { orgId: ORG, project: PROJECT, taskId: TASK }, ON);
  const raw = JSON.stringify({ schemaVersion: 1, candidateDigest: "c".repeat(64), checks: [], selection: { method: "full", selected: 1, total: 1 }, testServices: record });
  const built = buildEvidencePack({ candidateDigest: "c".repeat(64), rawText: raw, checks: round.entries, environment: chosen.environment!, storedArtifacts: new Map(), ...(chosen.dependencies === undefined ? {} : { dependencies: chosen.dependencies }) });
  expect(EvidencePackSchema.safeParse(built.pack).success).toBe(true);
  return { pack: built.pack!, lines: evidenceLines({ pack: built.pack, mode: "summary" }, "c".repeat(64), 0) };
}

describe("3. a task passes a check round against Postgres and Rovara local AWS, and the PR says so", () => {
  it("IMPLEMENT: ONE emulator for the three, with the run contract; the template's resources are created through the control API before the project's seed; the working sandbox gets per-service endpoints", async () => {
    const { coding: approved } = await plans();
    // The project's own seed command on the first emulated entry (a maintainer adds it on the card): it must run AFTER the template's resources exist.
    const coding = { ...approved, dependencies: approved.dependencies!.map((item) => (item.id === "aws-s3" ? { ...item, seeds: [{ command: SEED }] } : item)) };
    const bench = await workerBench();
    const started = (await bench.start(coding, "IMPLEMENT"))!;
    expect([...started.ids].sort()).toEqual(["aws-dynamodb", "aws-s3", "aws-sqs", "postgres"]);
    expect(bench.aws.emulatorEnv).toHaveLength(1);
    const file = bench.aws.emulatorEnv[0]!;
    expect(envOf(file, "ROVARA_AWS_BASE_URL")).toBe("http://aws:4566");
    const secrets = ["ROVARA_AWS_AUTH_PRESIGN_SECRET", "ROVARA_AWS_SERVICES_SQS_RECEIPT_HANDLE_SECRET", "ROVARA_AWS_CONTROL_TOKEN"].map((name) => envOf(file, name)!);
    expect(new Set(secrets).size).toBe(3);
    // The services the plan does not name are switched off in the emulator.
    expect(file).toContain("ROVARA_AWS_SERVICES_SNS_ENABLED=false");
    // The seed call carries the emulator's own token and exactly the template's three resources (the topic is not seeded).
    const seed = bench.aws.controls.filter((call) => call.path === "/_rovara/seed");
    expect(seed).toHaveLength(1);
    expect(seed[0]!.token).toBe(envOf(file, "ROVARA_AWS_CONTROL_TOKEN"));
    const document = JSON.parse(seed[0]!.body!) as { s3: { buckets: Array<{ name: string }> }; sqs: { queues: Array<{ name: string }> }; dynamodb: { tables: Array<{ request: { TableName: string } }> } };
    expect([document.s3.buckets[0]!.name, document.sqs.queues[0]!.name, document.dynamodb.tables[0]!.request.TableName]).toEqual(["orders-archive", "order-events", "orders"]);
    expect(JSON.stringify(document)).not.toContain("alerts");
    // The sandbox sees S3, SQS and DynamoDB at the emulator and every other service and the global endpoint at the emulator too (it refuses what the plan did not ask for AND counts it); none of the three values.
    const exec = bench.fake.execs.find((entry) => entry.envFile?.includes("AWS_ENDPOINT_URL_S3=") === true)!;
    for (const name of ["S3", "SQS", "DYNAMODB"]) expect(envOf(exec.envFile, `AWS_ENDPOINT_URL_${name}`)).toBe("http://aws:4566");
    expect(envOf(exec.envFile, "AWS_ENDPOINT_URL_SNS")).toBe("http://aws:4566");
    expect(envOf(exec.envFile, "AWS_ENDPOINT_URL")).toBe("http://aws:4566");
    expect(exec.envFile).not.toContain("sinkhole");
    for (const secret of secrets) { expect(exec.envFile).not.toContain(secret); expect(bench.fake.calls.flat().join(" ")).not.toContain(secret); }
    expect(bench.aws.order.indexOf("marked")).toBeGreaterThan(bench.aws.order.indexOf("seed"));
    expect(bench.aws.order.indexOf("seed")).toBeGreaterThan(bench.aws.order.indexOf("emulator"));
    expect(bench.fake.pulls).toEqual([]);
    await started.dispose();
    await bench.sandbox.dispose();
    await nothingLeft(bench);
  });

  it("CHECKS: the sealed round runs on a fresh emulator, the ledger says what the code called, and the evidence and the PR line say Postgres (real), S3, SQS and DynamoDB (Rovara local AWS), plus the IAM line", async () => {
    const { broker, checks } = await plans();
    const bench = await workerBench();
    const { started, round } = await run(bench, checks, broker.readiness);
    expect(round.entries.map((entry) => entry.after)).toEqual(broker.readiness.map(() => "passed"));
    const record = lastUsage(bench);
    expect(record.dependencies.map((entry) => entry.id).sort()).toEqual(["aws-dynamodb", "aws-s3", "aws-sqs", "postgres"]);
    expect(record.dependencies.every((entry) => entry.started && entry.healthy)).toBe(true);
    expect(record.aws).toMatchObject({ ledger: "read", otherCalls: 0, otherUnsupported: 0, unsupportedOperations: [] });
    expect(record.aws?.services.map((entry) => entry.service).sort()).toEqual(["dynamodb", "s3", "sqs"]);
    // The round's emulator has its own token, and the seed and the ledger read both used it.
    const token = envOf(bench.aws.emulatorEnv.at(-1), "ROVARA_AWS_CONTROL_TOKEN");
    expect(bench.aws.controls.filter((call) => call.path === "/_rovara/ledger/summary").map((call) => call.token)).toEqual([token]);
    const { pack, lines } = await evidenceFor(broker, record, round);
    expect(pack.environment.dependencies).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Postgres", label: "real" }), expect.objectContaining({ name: "S3", label: "rovara_local_aws" }), expect.objectContaining({ name: "SQS", label: "rovara_local_aws" }), expect.objectContaining({ name: "DynamoDB", label: "rovara_local_aws" })]));
    expect(lines.lines).toContain(PR_LINE);
    expect(lines.notTested).toContain(`- ${AWS_PERMISSIONS_NOT_CHECKED}`);
    // A clean run is flagged for nothing else.
    expect(pack.notTested.some((item) => item.id === AWS_USAGE_ITEM_ID)).toBe(false);
    expect(lines.notTested.join("\n")).not.toMatch(/not in the plan|could not be checked|do not support/u);
    await started.dispose();
    await bench.sandbox.dispose();
    await nothingLeft(bench);
  });

  it("the official round and the TESTPROOF rerun each get their own emulator, with their own three values", async () => {
    const { broker, checks } = await plans();
    const bench = await workerBench();
    const started = (await bench.start(checks, "CHECKS"))!;
    const runners = withTestServices(started, BASE_RUNNERS);
    await runChecks(CHECK_PLAN(broker.readiness), runners, { budgetMs: 60_000, signal: new AbortController().signal });
    await runChecks(CHECK_PLAN(broker.readiness), runners, { budgetMs: 60_000, signal: new AbortController().signal });
    expect(bench.aws.emulatorEnv).toHaveLength(2);
    const values = bench.aws.emulatorEnv.flatMap((file) => ["ROVARA_AWS_AUTH_PRESIGN_SECRET", "ROVARA_AWS_SERVICES_SQS_RECEIPT_HANDLE_SECRET", "ROVARA_AWS_CONTROL_TOKEN"].map((name) => envOf(file, name)!));
    expect(new Set(values).size).toBe(6);
    await started.dispose();
    await bench.sandbox.dispose();
    await nothingLeft(bench);
  });
});

describe("4. failure cases are flagged, never a quiet pass", () => {
  it("an out-of-plan service call (SNS) made through the SDK's own endpoint variable reaches the emulator, is counted by its ledger, and is flagged: the record names it, the pack carries the aws-usage item and the PR says so", async () => {
    const { broker, checks } = await plans();
    // The fake emulator's ledger follows WHERE the sealed sandbox's SNS endpoint points: only a call that reaches the emulator (which has SNS switched off) is refused AND written to the ledger. A call to any other host is
    // nobody's: a static sinkhole name is never looked up, so nothing counts it. This is what the SDK does with AWS_ENDPOINT_URL_SNS.
    let bench: Bench;
    const callsSns = (): boolean => {
      const exec = bench.fake.execs.find((entry) => entry.envFile?.includes("AWS_ENDPOINT_URL_SNS=") === true);
      return exec !== undefined && envOf(exec.envFile, "AWS_ENDPOINT_URL_SNS") === "http://aws:4566";
    };
    bench = await workerBench({ aws: { ledger: () => ledgerOf({ s3: { PutObject: { calls: 3 } }, ...(callsSns() ? { sns: { Publish: { calls: 2, unsupported: 0, errors: 2 } } } : {}) }) } });
    const { started, round } = await run(bench, checks, broker.readiness);
    const sealedExec = bench.fake.execs.filter((entry) => entry.envFile?.includes("AWS_ENDPOINT_URL_SNS=") === true).at(-1)!;
    expect(envOf(sealedExec.envFile, "AWS_ENDPOINT_URL_SNS")).toBe("http://aws:4566");
    expect(envOf(sealedExec.envFile, "AWS_ENDPOINT_URL")).toBe("http://aws:4566");
    expect(callsSns()).toBe(true);
    const record = lastUsage(bench);
    expect(record.aws?.services.map((entry) => entry.service)).toContain("sns");
    const { pack, lines } = await evidenceFor(broker, record, round);
    const item = pack.notTested.find((entry) => entry.id === AWS_USAGE_ITEM_ID);
    expect(item?.text).toContain("The code called AWS services that are not in the plan");
    expect(item?.text).toContain("sns");
    expect(lines.notTested.join("\n")).toContain("not in the plan");
    await started.dispose();
    await bench.sandbox.dispose();
    await nothingLeft(bench);
  });

  it("an operation the emulator does not support is flagged in fixed words", async () => {
    const { broker, checks } = await plans();
    const bench = await workerBench({ aws: { ledger: ledgerOf({ s3: { PutObject: { calls: 3 }, PutBucketReplication: { calls: 1, unsupported: 1, errors: 1 } } }) } });
    const { started, round } = await run(bench, checks, broker.readiness);
    const { pack } = await evidenceFor(broker, lastUsage(bench), round);
    expect(pack.notTested.find((entry) => entry.id === AWS_USAGE_ITEM_ID)?.text).toBe("The code called AWS operations that Rovara local AWS does not support");
    await started.dispose();
    await bench.sandbox.dispose();
  });

  it("a flooded ledger (more different calls than the worker reads, or an answer past the probe's limit) is 'flooded', not clean and not 'no calls'", async () => {
    const { broker, checks } = await plans();
    const many: Record<string, { calls: number }> = {};
    for (let index = 0; index < 250; index += 1) many[`Op${index}`] = { calls: 1 };
    for (const aws of [{ ledger: ledgerOf({ s3: many }) }, { ledgerExit: 2 }] as Array<Partial<FakeLocalAwsOptions>>) {
      const bench = await workerBench({ aws });
      const { started, round } = await run(bench, checks, broker.readiness);
      const record = lastUsage(bench);
      expect(record.aws).toEqual({ ledger: "flooded", services: [], unsupportedOperations: [], otherCalls: 0, otherUnsupported: 0 });
      const { pack, lines } = await evidenceFor(broker, record, round);
      expect(pack.notTested.find((entry) => entry.id === AWS_USAGE_ITEM_ID)?.text).toBe("AWS usage could not be checked: the code made too many different AWS calls");
      expect(lines.notTested.join("\n")).toContain("too many different AWS calls");
      await started.dispose();
      await bench.sandbox.dispose();
      await nothingLeft(bench);
    }
  });

  it("a ledger that cannot be read is 'could not be checked' (unreadable), never a pass", async () => {
    const { broker, checks } = await plans();
    const bench = await workerBench({ aws: { ledgerExit: 1 } });
    const { started, round } = await run(bench, checks, broker.readiness);
    const record = lastUsage(bench);
    expect(record.aws?.ledger).toBe("unreadable");
    const { pack } = await evidenceFor(broker, record, round);
    expect(pack.notTested.find((entry) => entry.id === AWS_USAGE_ITEM_ID)?.text).toBe("AWS usage could not be checked");
    await started.dispose();
    await bench.sandbox.dispose();
  });

  it("a record with no AWS facts at all (an older worker's) is 'could not be checked' for a plan with Rovara local AWS", async () => {
    const { broker, checks } = await plans();
    const bench = await workerBench();
    const { started, round } = await run(bench, checks, broker.readiness);
    const record = lastUsage(bench);
    const withoutAws: TestServicesUsageRecord = { ...record };
    delete withoutAws.aws;
    const { pack } = await evidenceFor(broker, withoutAws, round);
    expect(pack.notTested.find((entry) => entry.id === AWS_USAGE_ITEM_ID)?.text).toBe("AWS usage could not be checked");
    await started.dispose();
    await bench.sandbox.dispose();
  });

  it("a seed the emulator refuses: a coding run fails in the fixed seed sentence and starts no project seed; a CHECKS round is not run and its record says why; nothing is left", async () => {
    const { broker, checks, coding } = await plans();
    const implement = await workerBench({ aws: { seedExit: 1 } });
    const seeded = { ...coding, dependencies: coding.dependencies!.map((item) => (item.id === "aws-s3" ? { ...item, seeds: [{ command: SEED }] } : item)) };
    await expect(implement.start(seeded, "IMPLEMENT")).rejects.toThrow("A test service's seeds did not complete");
    expect(implement.fake.execs.filter((entry) => entry.args.includes("seed-aws-data"))).toEqual([]);
    await implement.sandbox.dispose();
    await nothingLeft(implement);
    const sealed = await workerBench({ aws: { seedAnswer: () => JSON.stringify({ ok: true, failed: 0, steps: [] }) } });
    const started = (await sealed.start(checks, "CHECKS"))!;
    const round = await runChecks(CHECK_PLAN(broker.readiness), withTestServices(started, BASE_RUNNERS), { budgetMs: 60_000, signal: new AbortController().signal });
    expect(round.entries.map((entry) => entry.after)).toEqual(broker.readiness.map(() => "not_run"));
    const record = (await started.usageRecord())!;
    expect(record.dependencies.filter((entry) => entry.id.startsWith("aws-")).every((entry) => entry.failure === "seed_failed")).toBe(true);
    const { pack, lines } = await evidenceFor(broker, record, round);
    expect(pack.environment.dependencies?.filter((entry) => entry.label === "not_available").length).toBeGreaterThan(0);
    expect(lines.lines).not.toContain(PR_LINE);
    await started.dispose();
    await sealed.sandbox.dispose();
    await nothingLeft(sealed);
  });

  it("a template the plan points at that setup does not read as resources (a moved or foreign file) fails the start with the seed sentence and sends the emulator no control call", async () => {
    const { checks } = await plans();
    const bench = await workerBench();
    await writeFile(join(bench.root, PROJECT, "template.yaml"), "not: a template\n");
    await expect(bench.start({ ...checks, dependencies: checks.dependencies }, "IMPLEMENT")).rejects.toThrow("A test service's seeds did not complete");
    expect(bench.aws.controls.filter((call) => call.path === "/_rovara/seed")).toEqual([]);
    await bench.sandbox.dispose();
    await nothingLeft(bench);
  });
});

describe("5. teardown on every way out", () => {
  it("after a failing check: the round fails, nothing with the run-network labels is left, and the run directory is gone", async () => {
    const { broker, checks } = await plans();
    const bench = await workerBench({ docker: { execExit: (args) => (args.some((arg) => arg.endsWith("-check")) ? 1 : 0) } });
    const { started, round } = await run(bench, checks, broker.readiness);
    expect(round.entries.map((entry) => entry.after)).toEqual(broker.readiness.map(() => "failed"));
    await started.dispose();
    await bench.sandbox.dispose();
    await nothingLeft(bench);
  });

  it("after a cancel in the middle of an official check: the round stops and the emulator, the check sandbox and everything else are removed", async () => {
    const { broker, checks } = await plans();
    const bench = await workerBench({ slowChecks: true });
    const started = (await bench.start(checks, "CHECKS"))!;
    const controller = new AbortController();
    const running = runChecks(CHECK_PLAN(broker.readiness), withTestServices(started, BASE_RUNNERS), { budgetMs: 60_000, signal: controller.signal });
    await new Promise<void>((done) => { const poll = setInterval(() => { if (bench.fake.left().containers.some((name) => name.endsWith("-check"))) { clearInterval(poll); done(); } }, 5); });
    controller.abort();
    expect((await running).stopped).toBe(true);
    await started.dispose();
    await bench.sandbox.dispose();
    await nothingLeft(bench);
  });

  it("after an emulator that does not start: a coding run fails and nothing is left", async () => {
    const { coding } = await plans();
    const bench = await workerBench({ docker: { failRun: "helper" } });
    await expect(bench.start(coding, "IMPLEMENT")).rejects.toThrow();
    await bench.sandbox.dispose();
    await nothingLeft(bench);
  });
});

describe("6. with tx off or without AWS dependencies the output is today's", () => {
  it("an environment with Postgres alone gives today's slice-1 PR line and no IAM line", async () => {
    const draft = await detectedDraft();
    const postgresOnly = structuredClone(draft);
    postgresOnly.dependencies = postgresOnly.dependencies!.filter((item) => item.family === "postgres");
    const broker = await approvedProject(postgresOnly);
    const checks = (await testEnvPlanFor(broker.deps, { orgId: ORG, project: PROJECT, taskId: TASK, readiness: broker.readiness }, ON))!;
    const bench = await workerBench();
    const { started, round } = await run(bench, checks, broker.readiness);
    const record = lastUsage(bench);
    expect(record.aws).toBeUndefined();
    expect(bench.aws.emulatorEnv).toEqual([]);
    const { lines } = await evidenceFor(broker, record, round);
    expect(lines.lines).toContain("Integration tests ran against: Postgres (real).");
    expect(lines.notTested.join("\n")).not.toContain("IAM");
    await started.dispose();
    await bench.sandbox.dispose();
  });
});

// ---- 7. Prove, through the real seams: worker prepare -> the result the broker keeps -> the Prove report, with a catalog that arrives through the SIGNED trust path ----------------------------------------------------

describe("7. Prove: the candidate check's record (with the ledger) goes from the worker to the Prove report", () => {
  afterEach(() => { delete process.env.TEST_SERVICES_ENABLED; delete process.env.TEST_ENVIRONMENT_ENABLED; vi.unstubAllEnvs(); });

  async function signedSource() {
    const signer = testSigner();
    const catalogBytes = Buffer.from(`${JSON.stringify(pinnedCatalog(), null, 2)}\n`, "utf8");
    const signature = { schemaVersion: 1, algorithm: CATALOG_SIGNATURE_ALGORITHM, keyId: parseBundlePublicKey(signer.publicKeyPem).keyId, catalogSha256: sha256HexOf(catalogBytes), signature: (await signer.sign(catalogSigningMessage(catalogBytes))).toString("base64") };
    return serviceCatalogSourceOf({ read: async () => ({ catalogBytes, signatureBytes: Buffer.from(JSON.stringify(signature)) }), trust: { runningAccountId: undefined }, load: loaderTrusting(signer.publicKeyPem) });
  }
  const aws = (service: string, first: boolean) => ({
    id: `aws-${service}`, name: { s3: "S3", sqs: "SQS", dynamodb: "DynamoDB" }[service]!, kind: service === "s3" ? "object_store" : service === "sqs" ? "queue" : "database", family: `aws:${service}`,
    found: [{ path: "template.yaml", line: 3 }], usedBy: ["integration"],
    backing: { kind: "emulated", catalogId: "local-aws@r1", awsServices: [service], region: "us-east-1", resources: { provider: "cloudformation", path: `${PROJECT}/template.yaml` } },
    connect: { env: [], hostAliases: first ? ["aws"] : [] }, seeds: [], reset: "fresh_per_round",
  });
  const postgres = {
    id: "postgres", name: "Postgres", kind: "database", family: "postgres", found: [{ path: "docker-compose.yml", line: 4 }], usedBy: ["integration"], backing: { kind: "local", catalogId: "postgres@16", config: {} },
    connect: { env: [{ name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}:{port}/{db}" }], hostAliases: ["postgres"] }, seeds: [], reset: "fresh_per_round",
  };

  async function prove(ledger: string): Promise<Array<{ step: string; status: string }>> {
    const bench = await setupWizardBench({ autoCandidate: false, brokerExtra: { serviceCatalog: await signedSource() } });
    process.env.TEST_SERVICES_ENABLED = "1";
    let steps: Array<{ step: string; status: string }> = [];
    await withSwitch("1", async () => {
      const environment = draftBody({ dependencies: [postgres, aws("s3", true), aws("sqs", false), aws("dynamodb", false)], repos: [{ repositoryId: "web", setupCommands: [wizardCommand("make", ["old-setup"], 900)], checks: [{ id: "unit", label: "Unit tests", command: wizardCommand("make", ["old-test"], 1800), kind: "test" }] }] });
      const proposal = await proposeTestEnvironment({ documentClient: bench.db, tableName: "state", now: () => Date.now() }, { orgId: TEST_ORG, project: WIZARD_NAME, proposedBy: OMAR.developerId, role: "maintainer", body: environment });
      const started = await bench.dev(OMAR, "POST", `${WIZARD_ENV}/check`, { digest: proposal.digest, requestId: randomUUID() });
      expect(started.status, JSON.stringify(started.body)).toBe(202);
      const candidate = (bench.db.find((item) => item.entityType === "TEST_ENV_CANDIDATE_CHECK") as unknown as Array<{ workspaceId: string }>)[0]!;
      const outbox = bench.db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === candidate.workspaceId)[0] as unknown as { invocation: { payload: { testServices: { dependencies: TaskDependencyPlan[] } } } };
      const sent = outbox.invocation.payload.testServices.dependencies;
      expect(sent.map((entry) => entry.id)).toEqual(["postgres", "aws-s3", "aws-sqs", "aws-dynamodb"]);

      // The worker half: the plan the broker sent, a catalog baked into the image, the fake Docker with the fake emulator, the sealed round for the test check, the ledger read at the end.
      const work = await workerBench({ aws: { ledger } });
      const dir = await temp("tsa-baked-");
      await writeFile(join(dir, "catalog.json"), JSON.stringify(pinnedCatalog()));
      (work.config as { catalog: () => Promise<unknown> }).catalog = () => loadBakedCatalog(join(dir, "catalog.json"));
      const collector = collectTestServicesUsage();
      const services = await startPrepareTestServices({ options: { dependencies: sent, testChecks: [0], config: work.config, onUsageRecord: collector.collect }, sandbox: work.sandbox, devcontainer: false, operationId: OPERATION, rootPath: work.root, repositoryPaths: [join(work.root, PROJECT)] });
      const ran = await services!.sealedReadiness(async () => ({ exitCode: 0, stdout: "", stderr: "" }))({ cwd: ".", executable: "make", args: ["old-test"], timeoutSeconds: 60 }, 0, work.root);
      expect(ran.exitCode).toBe(0);
      await services!.finish();
      await work.sandbox.dispose();
      await nothingLeft(work);
      const reported = collector.result();

      const prepareId = String((bench.db.get(`WORKSPACE#${candidate.workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
      await bench.finish(candidate.workspaceId, prepareId, "SUCCEEDED", { result: reported });
      const kept = (bench.db.find((item) => item.entityType === "TEST_ENV_CANDIDATE_CHECK") as unknown as Array<{ usage?: unknown }>)[0]!;
      expect(TestServicesUsageRecordSchema.parse(kept.usage).aws?.ledger).toBeDefined();
      const proved = await bench.dev(OMAR, "POST", `${WIZARD_ENV}/prove`, { digest: proposal.digest });
      expect(proved.status, JSON.stringify(proved.body)).toBe(200);
      steps = (bench.db.find((item) => item.entityType === "TEST_ENV_PROVE")[0] as unknown as { report: { steps: Array<{ step: string; status: string }> } }).report.steps;
    });
    return steps;
  }

  it("a clean ledger: 'start dependencies' and 'dependency usage check' both pass", async () => {
    const steps = await prove(GOOD_LEDGER);
    expect(steps).toEqual(expect.arrayContaining([expect.objectContaining({ step: "dependencies", status: "passed" }), expect.objectContaining({ step: "dependency_usage", status: "passed" })]));
  });

  it("a call to a service outside the plan (SNS) fails 'dependency usage check'", async () => {
    const steps = await prove(ledgerOf({ s3: { PutObject: { calls: 1 } }, sns: { Publish: { calls: 1 } } }));
    expect(steps).toEqual(expect.arrayContaining([expect.objectContaining({ step: "dependencies", status: "passed" }), expect.objectContaining({ step: "dependency_usage", status: "failed" })]));
  });

  it("a flooded ledger fails 'dependency usage check'", async () => {
    const many: Record<string, { calls: number }> = {};
    for (let index = 0; index < 250; index += 1) many[`Op${index}`] = { calls: 1 };
    const steps = await prove(ledgerOf({ s3: many }));
    expect(steps).toEqual(expect.arrayContaining([expect.objectContaining({ step: "dependency_usage", status: "failed" })]));
  });
});
