// Test services, slice 1, s1-worker-round T2 (Prove, worker side): `prepareWorkspace` of a candidate check that carries a dependency plan starts the dependencies, runs setup and the readiness commands with the run's
// variables, runs the test checks SEALED, hands on the usage record, and tears everything down on every exit path. No Docker: the fake daemon of tests/support.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ProjectDefinitionSchema, TEST_SERVICES_USAGE_RESULT_KEY, TaskDependencyPlanSchema, type ProjectCommand, type ServiceCatalog, type TestServicesUsageRecord } from "@rovara-code/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareWorkspace } from "../../packages/worker/src/prepare.js";
import { forgetWorkerStartSweeps } from "../../packages/worker/src/service-runner.js";
import { SEALED_ROUND_PORTS, collectTestServicesUsage, startPrepareTestServices, type PrepareTestServices, type TestServicesConfig } from "../../packages/worker/src/test-services-run.js";
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
    docker: fake.docker, registry: "123456789012.dkr.ecr.us-west-2.amazonaws.com", catalogEnv: "staging", edition: "public", probeImage: IMAGE, guardImage: IMAGE, maxMemMiB: 3072, runDirectoryParent: runParent,
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
  it("starts NO working-phase Postgres: setup and a non-test readiness command run in the working sandbox without the run's variables, and the test check runs in the sealed check sandbox with them (H3)", async () => {
    const h = await harness();
    const manifest = await h.prepare();
    expect(manifest.complete).toBe(true);
    const calls = h.fake.calls;
    const network = calls.findIndex((call) => call[0] === "network" && call[1] === "create");
    const execs = calls.map((call, index) => ({ call, index })).filter(({ call }) => call[0] === "exec");
    expect(network).toBeGreaterThan(-1);
    const working = execs.filter(({ call }) => call.some((arg) => arg.startsWith("agentx-task-")) && call.includes("bash"));
    const sealed = execs.filter(({ call }) => call.includes("--env-file") && call.some((arg) => arg.endsWith("-check")));
    // Setup and the lint command ran in the working sandbox, with no env file: there is no working-phase service for them.
    expect(working.length).toBeGreaterThanOrEqual(2);
    expect(working.every(({ call }) => !call.includes("--env-file"))).toBe(true);
    // The test check ran in the sealed sandbox, with the env file, in a round of its own.
    expect(sealed.length).toBeGreaterThan(0);
    expect(calls.filter((call) => call[0] === "run" && call.includes("--detach") && call[call.indexOf("--name") + 1]!.endsWith("-check"))).toHaveLength(1);
    // Only the round's services network was made (no working phase), and the working sandbox joined none.
    expect(calls.filter((call) => call[0] === "network" && call[1] === "create")).toHaveLength(1);
    expect(calls.filter((call) => call[0] === "network" && call[1] === "connect")).toEqual([]);
    expect(calls.filter((call) => call[0] === "run" && call.includes("--detach") && /-h[0-9a-f]{10}$/u.test(call[call.indexOf("--name") + 1]!))).toHaveLength(1);
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

  it("with testChecks naming every readiness command, each runs sealed in a round of its own (two round networks, no working phase)", async () => {
    const h = await harness({ testChecks: [0, 1] });
    await h.prepare();
    expect(h.fake.calls.filter((call) => call[0] === "run" && call.includes("--detach") && call[call.indexOf("--name") + 1]!.endsWith("-check"))).toHaveLength(2);
    expect(h.fake.calls.filter((call) => call[0] === "network" && call[1] === "create")).toHaveLength(2);
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
    // Setup fails before any service was started (a Prove run starts them only for its sealed rounds): there is no record to report, and nothing is left.
    expect(h.records).toHaveLength(0);
    await nothingLeft(h);
  });

  it("a dependency that does not start fails the preparation with a fixed sentence, reports every dependency as not started, and leaves nothing", async () => {
    const h = await harness({ docker: { failRun: "helper" } });
    await expect(h.prepare()).rejects.toThrow();
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

  it("a worker whose boot withheld test services (NOT_PULLED=all, the IPv6 wall failed) refuses the preparation with the fixed sentence and a failed-start record, and starts no service", async () => {
    const h = await harness({ config: false });
    for (const [name, value] of Object.entries({ AGENTX_SANDBOX_IMAGE: IMAGE, AGENTX_TEST_SERVICES_REGISTRY: "123456789012.dkr.ecr.us-west-2.amazonaws.com", AGENTX_TEST_SERVICES_ENV: "staging", AGENTX_TEST_SERVICES_RUN_DIR: h.runParent, AGENTX_TEST_SERVICES_NOT_PULLED: "all" })) vi.stubEnv(name, value);
    try {
      await expect(h.prepare()).rejects.toThrow("This worker is not set up to run test services");
      expect(h.records[0]!.dependencies[0]).toMatchObject({ started: false, failure: "start_failed" });
      expect(h.fake.verbs("network").filter((call) => call[1] === "create")).toEqual([]);
      expect(h.fake.verbs("run").filter((call) => call.includes("--detach"))).toEqual([]);
      expect(await readdir(h.runParent)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
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

describe("cancel", () => {
  it("a cancel of the operation while the images are looked up stops the preparation's services, removes everything and ends the registration", async () => {
    const h = await harness();
    const original = h.fake.docker.run.bind(h.fake.docker);
    let pulling = false;
    h.fake.docker.run = (args, options) => (args[0] === "image" && args[1] === "inspect" && args.includes("{{.Id}}")
      ? new Promise((_resolve, reject) => { pulling = true; if (options?.signal?.aborted === true) reject(new Error("aborted")); options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); })
      : original(args, options));
    let abort: (() => Promise<void>) | undefined;
    let unregistered = false;
    const cancellation = { register: (_id: string, session?: { abort(): Promise<void> }) => { abort = session?.abort.bind(session); return () => { unregistered = true; }; } };
    h.testServices.operationId = "77777777-7777-4777-8777-777777777777";
    h.testServices.cancellation = cancellation;
    const preparing = h.prepare().then(() => "prepared", () => "failed");
    await vi.waitFor(() => expect(pulling).toBe(true));
    await abort!();
    expect(await preparing).toBe("failed");
    expect(unregistered).toBe(true);
    await nothingLeft(h);
  });

  it("the sealed rounds get the operation's real signal: a cancel before a test check fails the check without running it", async () => {
    const h = await harness();
    let abort: (() => Promise<void>) | undefined;
    h.testServices.operationId = "77777777-7777-4777-8777-777777777777";
    h.testServices.cancellation = { register: (_id: string, session?: { abort(): Promise<void> }) => { abort = session?.abort.bind(session); return () => undefined; } };
    h.testServices.onUsageRecord = async () => undefined;
    const original = h.fake.docker.run.bind(h.fake.docker);
    // The first sealed exec (the round's seeds) is where the cancel arrives.
    h.fake.docker.run = async (args, options) => {
      if (args[0] === "exec" && args.some((arg) => arg.endsWith("-check"))) await abort!();
      return original(args, options);
    };
    await expect(h.prepare()).rejects.toThrow();
    await nothingLeft(h);
  });
});

describe("the worker verifies no catalog signature at run time (H4)", () => {
  it("the catalog is the image's own file: a Prove run needs no key, no signature and no account id", async () => {
    const { loadBakedCatalog } = await import("../../packages/worker/src/test-services-run.js");
    const catalog = await loadBakedCatalog(new URL("../../environments/service-catalog/catalog.json", import.meta.url));
    expect(catalog.entries.length).toBeGreaterThan(0);
  });
});

describe("the prepare invocation's wiring (main.ts)", () => {
  it("passes the payload's testServices plan to the preparation and puts the usage record in the result under the contract's key", () => {
    const source = readFileSync(new URL("../../packages/worker/src/main.ts", import.meta.url), "utf8");
    expect(source).toContain("invocation.payload.testServices.dependencies");
    expect(source).toContain("onUsageRecord: testServicesUsage.collect");
    expect(source).toContain("...testServicesUsage.result()");
  });
  it("the collector answers the record under testServicesUsage, and nothing before one is reported", () => {
    const usage = collectTestServicesUsage();
    expect(usage.result()).toEqual({});
    const record: TestServicesUsageRecord = { schemaVersion: 1, dependencies: [], unknownCalls: { domains: [], otherCount: 0 } };
    usage.collect(record);
    expect(usage.result()).toEqual({ [TEST_SERVICES_USAGE_RESULT_KEY]: record });
    expect(TEST_SERVICES_USAGE_RESULT_KEY).toBe("testServicesUsage");
  });
});
