// Test services, slice 1, s1-worker-round T2 (Prove, worker side): `prepareWorkspace` of a candidate check that carries a dependency plan starts the dependencies, runs setup and the readiness commands with the run's
// variables, runs the test checks SEALED, hands on the usage record, and tears everything down on every exit path. No Docker: the fake daemon of tests/support.
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CATALOG_SIGNATURE_ALGORITHM, ProjectDefinitionSchema, TaskDependencyPlanSchema, catalogSigningMessage, type ProjectCommand, type ServiceCatalog, type TestServicesUsageRecord } from "@agentx/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareWorkspace } from "../../packages/worker/src/prepare.js";
import { forgetWorkerStartSweeps } from "../../packages/worker/src/service-runner.js";
import { SEALED_ROUND_PORTS, loadCatalogFromDirectory, startPrepareTestServices, type PrepareTestServices, type TestServicesConfig } from "../../packages/worker/src/test-services-run.js";
import { fakeServicesDocker, type FakeServicesDockerOptions } from "../support/fake-services-docker.js";

const run = promisify(execFile);
const IMAGE = `registry.example.test/agentx/worker@sha256:${"b".repeat(64)}`;
const DIGEST = "a".repeat(64);
const roots: string[] = [];
beforeEach(() => forgetWorkerStartSweeps());
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function temp(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

const SETUP: ProjectCommand = { cwd: "repo/sample", executable: "npm", args: ["ci"], timeoutSeconds: 60 };
const LINT: ProjectCommand = { cwd: "repo/sample", executable: "npm", args: ["run", "lint"], timeoutSeconds: 60 };
const TEST: ProjectCommand = { cwd: "repo/sample", executable: "npm", args: ["test"], timeoutSeconds: 60 };

const dependencies = () => [TaskDependencyPlanSchema.parse({
  id: "postgres", name: "Postgres", kind: "database", family: "postgres", backing: "local", catalogId: "postgres@16", repository: "svc/postgres", digest: DIGEST,
  config: { database: "app", user: "app" }, aliases: ["postgres"], connect: [{ name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}:{port}/{db}" }],
  seeds: [], reset: "fresh_per_round",
})];

async function harness(options: { docker?: FakeServicesDockerOptions; testChecks?: readonly number[]; config?: boolean } = {}) {
  const fake = fakeServicesDocker({ imagePresent: true, ...options.docker });
  const root = await temp("rsv-prep-");
  const source = await temp("rsv-prep-source-");
  await run("git", ["init", "--quiet", "--initial-branch=main", source]);
  await writeFile(join(source, "README.md"), "# sample\n");
  await run("git", ["-C", source, "add", "."]);
  await run("git", ["-C", source, "-c", "user.name=AgentX", "-c", "user.email=agentx@example.test", "commit", "--quiet", "-m", "fixture"]);
  const project = ProjectDefinitionSchema.parse({
    name: "sample", revision: 1,
    repositories: [{ name: "sample", url: "http://127.0.0.1/sample.git", path: "repo/sample", defaultBranch: "main", credentialRef: "sample-readwrite" }],
    setup: [SETUP], readiness: [LINT, TEST], orchestratorInstructions: "Delegate all code changes to the remote worker.",
  });
  const raw = JSON.parse(readFileSync(new URL("../../environments/service-catalog/catalog.json", import.meta.url), "utf8")) as ServiceCatalog;
  const catalog = structuredClone(raw);
  for (const entry of catalog.entries) if (entry.id === "postgres@16") entry.image.digest = DIGEST;
  const runParent = await temp("rsv-prep-runs-");
  const config: TestServicesConfig = {
    docker: fake.docker, registry: "123456789012.dkr.ecr.us-west-2.amazonaws.com", catalogEnv: "staging", edition: "public", probeImage: IMAGE, maxMemMiB: 3072, runDirectoryParent: runParent,
    catalog: () => Promise.resolve(catalog), sealedRound: SEALED_ROUND_PORTS, sleep: () => Promise.resolve(), log: () => undefined,
  };
  const records: TestServicesUsageRecord[] = [];
  const testServices: PrepareTestServices = {
    dependencies: dependencies(), ...(options.testChecks === undefined ? { testChecks: [1] } : { testChecks: options.testChecks }),
    ...(options.config === false ? {} : { config }), onUsageRecord: (record) => { records.push(record); },
  };
  const prepare = (extra: object = {}) => prepareWorkspace({
    rootPath: root, project, creationIdentity: "66666666-6666-4666-8666-666666666666", testServices,
    taskShell: { kind: "sandbox", docker: fake.docker, image: IMAGE },
    materializer: async (_repository: unknown, destination: string) => { await run("git", ["clone", "--quiet", source, destination]); },
    ...extra,
  });
  return { fake, root, runParent, records, prepare, testServices };
}
const nothingLeft = async (h: Awaited<ReturnType<typeof harness>>): Promise<void> => {
  expect(h.fake.left().networks).toEqual([]);
  expect(h.fake.left().containers).toEqual([]);
  expect(await readdir(h.runParent)).toEqual([]);
};

describe("a candidate check that carries a dependency plan", () => {
  it("starts the dependencies after the clone and before setup; setup and a non-test readiness command run in the working sandbox with the env file; the test check runs in the sealed check sandbox", async () => {
    const h = await harness();
    const manifest = await h.prepare();
    expect(manifest.complete).toBe(true);
    const calls = h.fake.calls;
    const network = calls.findIndex((call) => call[0] === "network" && call[1] === "create");
    const execs = calls.map((call, index) => ({ call, index })).filter(({ call }) => call[0] === "exec" && call.includes("--env-file"));
    expect(network).toBeGreaterThan(-1);
    const working = execs.filter(({ call }) => call.some((arg) => arg.startsWith("agentx-task-")));
    const sealed = execs.filter(({ call }) => call.some((arg) => arg.endsWith("-check")));
    // Setup and the lint command: both in the working sandbox, after the network exists.
    expect(working.length).toBeGreaterThanOrEqual(2);
    expect(working.every(({ index }) => index > network)).toBe(true);
    // The test check ran in the sealed sandbox, with the env file, in a round of its own.
    expect(sealed.length).toBeGreaterThan(0);
    expect(calls.filter((call) => call[0] === "run" && call.includes("--detach") && call[call.indexOf("--name") + 1]!.endsWith("-check"))).toHaveLength(1);
    // The sealed round started helpers of its own: two services networks were made in all (the working phase's, and the round's).
    expect(calls.filter((call) => call[0] === "network" && call[1] === "create")).toHaveLength(2);
    expect(h.fake.execs.filter((exec) => exec.args.some((arg) => arg.endsWith("-check")) && exec.envFile?.includes("DATABASE_URL=postgres://app:") === true).length).toBeGreaterThan(0);
    await nothingLeft(h);
  });

  it("hands on one usage record, taken before the services stop", async () => {
    const h = await harness();
    await h.prepare();
    expect(h.records).toHaveLength(1);
    expect(h.records[0]!.dependencies).toEqual([expect.objectContaining({ id: "postgres", started: true, healthy: true, resetCount: 0 })]);
    expect(JSON.stringify(h.records)).not.toMatch(/[A-Za-z0-9]{32}/u);
  });

  it("with testChecks naming every readiness command, each runs sealed in a round of its own (a working network and two round networks)", async () => {
    const h = await harness({ testChecks: [0, 1] });
    await h.prepare();
    expect(h.fake.calls.filter((call) => call[0] === "run" && call.includes("--detach") && call[call.indexOf("--name") + 1]!.endsWith("-check"))).toHaveLength(2);
    expect(h.fake.calls.filter((call) => call[0] === "network" && call[1] === "create")).toHaveLength(3);
  });

  it("a test check that fails fails the preparation, still reports the record, and leaves nothing", async () => {
    const h = await harness({ docker: { execExit: (args) => (args.some((arg) => arg.endsWith("-check")) ? 1 : 0) } });
    await expect(h.prepare()).rejects.toThrow();
    expect(h.records).toHaveLength(1);
    expect(h.records[0]!.dependencies[0]).toMatchObject({ started: true });
    await nothingLeft(h);
  });

  it("a setup step that fails fails the preparation, still reports the record, and leaves nothing", async () => {
    const h = await harness({ docker: { execExit: (args) => (args.some((arg) => arg.startsWith("agentx-task-")) && !args.includes("pg_isready") ? 1 : 0) } });
    await expect(h.prepare()).rejects.toThrow();
    expect(h.records).toHaveLength(1);
    await nothingLeft(h);
  });

  it("a dependency that does not start fails the preparation with a fixed sentence, reports every dependency as not started, and leaves nothing", async () => {
    const h = await harness({ docker: { failRun: "helper" } });
    await expect(h.prepare()).rejects.toThrow("The test services could not be started");
    expect(h.records).toEqual([{ schemaVersion: 1, dependencies: [{ id: "postgres", started: false, healthy: false, startMs: 0, resetCount: 0, failure: "start_failed" }], unknownCalls: { domains: [], otherCount: 0 } }]);
    await nothingLeft(h);
  });

  it("a worker with no configuration, and a preparation with no sandbox of its own, refuse with a fixed sentence and a failed-start record", async () => {
    const none = await harness({ config: false });
    await expect(none.prepare()).rejects.toThrow("This worker is not set up to run test services");
    expect(none.records[0]!.dependencies[0]).toMatchObject({ started: false, failure: "start_failed" });
    const injected = await harness();
    await expect(injected.prepare({ commandRunner: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }) })).rejects.toThrow(/need the task sandbox/u);
    expect(injected.fake.verbs("network").filter((call) => call[1] === "create")).toEqual([]);
  });

  it("a dev container is refused before anything is made", async () => {
    const h = await harness();
    const before = h.fake.calls.length;
    await expect(startPrepareTestServices({ options: h.testServices, sandbox: undefined, devcontainer: true, operationId: "x", rootPath: h.root, repositoryPaths: [] })).rejects.toThrow("Test services are not available yet for a project that uses a dev container.");
    expect(h.fake.calls.length).toBe(before);
    expect(h.records).toEqual([]);
  });

  it("without testServices the preparation makes no services network and no sealed round", async () => {
    const h = await harness();
    await h.prepare({ testServices: undefined });
    expect(h.fake.calls.filter((call) => call[0] === "network" && call[1] === "create")).toEqual([]);
    expect(h.fake.calls.some((call) => call.includes("--env-file"))).toBe(false);
    expect(h.records).toEqual([]);
  });
});

describe("the catalog's trusted keys are compiled in, never read at runtime", () => {
  it("loadCatalogFromDirectory accepts a catalog signed by a key the test seam is given and refuses one signed by another or by none", async () => {
    const bytes = readFileSync(new URL("../../environments/service-catalog/catalog.json", import.meta.url));
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const dir = await temp("rsv-catalog-signed-");
    const keyId = createHash("sha256").update(pair.publicKey.export({ type: "spki", format: "der" })).digest("hex");
    const signature = sign("sha256", catalogSigningMessage(bytes), { key: pair.privateKey, dsaEncoding: "der" }).toString("base64");
    await writeFile(join(dir, "catalog.json"), bytes);
    await writeFile(join(dir, "catalog.sig.json"), JSON.stringify({ schemaVersion: 1, algorithm: CATALOG_SIGNATURE_ALGORITHM, keyId, catalogSha256: createHash("sha256").update(bytes).digest("hex"), signature }));
    const pem = (key: typeof pair.publicKey) => key.export({ type: "spki", format: "pem" }).toString();
    const trust = { runningAccountId: "944937319445" };
    await expect(loadCatalogFromDirectory(dir, trust, [pem(pair.publicKey)])).resolves.toMatchObject({ entries: expect.any(Array) as unknown[] });
    await expect(loadCatalogFromDirectory(dir, trust, [pem(other.publicKey)])).rejects.toMatchObject({ reason: "catalog" });
    // No key compiled in yet: nothing verifies in any account.
    await expect(loadCatalogFromDirectory(dir, trust)).rejects.toMatchObject({ reason: "catalog" });
    await expect(loadCatalogFromDirectory(dir, { runningAccountId: undefined })).rejects.toMatchObject({ reason: "catalog" });
  });
});
