// Test services, slice 3 (s3-fakes-run), the run layer: a plan with a fake starts the fake server from the worker's own image in the coding phase and in every sealed round (a new fake each), the approved fixture set is fetched at
// the start of each phase and goes into that one helper's run directory only, the round's fake answers the check sandbox alone, and what it was asked comes back as five bucketed counts. No Docker: the fake daemon of
// tests/support/fake-services-docker.ts and the stub of the sealed round used by worker-test-services-run.test.ts.
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixtureSetSchema, TaskDependencyPlanSchema, TestServicesUsageRecordSchema, fixtureEntry, fixtureSetDigest, type FixtureSet, type ProjectCommand, type ServiceCatalog, type TaskDependencyPlan } from "@rovara-code/contracts";
import { withDetachedWorking } from "../../packages/worker/src/check-sandbox.js";
import { forgetWorkerStartSweeps } from "../../packages/worker/src/service-runner.js";
import { TASK_SANDBOX_IMAGE_ENVIRONMENT, TaskSandbox } from "../../packages/worker/src/task-sandbox.js";
import { buildServiceUsageRecord } from "../../packages/worker/src/service-usage-record.js";
import { FixtureDeliveryRefused, type FixtureDelivery } from "../../packages/worker/src/fixture-delivery.js";
import { fakeServerBaked, startTestServicesRun, testServicesAdvertisedFeatures, withTestServices, type SealedRoundPorts, type SealedRoundSetup, type TestServicesConfig } from "../../packages/worker/src/test-services-run.js";
import { runChecks, type CheckPlan, type CheckRunners } from "../../packages/worker/src/verification/checks.js";
import { fakeServicesDocker, type FakeServicesDockerOptions } from "../support/fake-services-docker.js";

const DIGEST = "a".repeat(64);
const IMAGE = `registry.example.test/agentx/worker@sha256:${"b".repeat(64)}`;
const REGISTRY = "123456789012.dkr.ecr.us-west-2.amazonaws.com";
const OPERATION = "44444444-4444-4444-8444-444444444444";
const TEST_COMMAND: ProjectCommand = { cwd: "app", executable: "npm", args: ["test"], timeoutSeconds: 60 };
/** A word that only the fixture set holds: it must be found in the one helper's file and nowhere else. */
const MARKER = "tomato-ledger-7391";

const roots: string[] = [];
beforeEach(() => forgetWorkerStartSweeps());
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function temp(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

const setDependency = { id: "payments", family: "http:api.example-pay.com", protocol: "http_json", target: "api.example-pay.com" } as const;
const match = { ignorePaths: [] as string[] };
const makeSet = (revision = 1): FixtureSet => FixtureSetSchema.parse({
  schemaVersion: 2, dependency: setDependency, origin: "written", writtenBy: "Priya", revision, syntheticOnly: true, match,
  entries: [fixtureEntry({ dependency: setDependency, match }, { method: "GET", path: "/v1/ping", contentType: "", body: "" }, { status: 200, headers: [], contentType: "application/json", body: JSON.stringify({ note: MARKER }), latencyMs: 0 })],
  faults: [],
});
const SET = makeSet();
const SET_DIGEST = fixtureSetDigest(SET);

function fakeDependency(change: Record<string, unknown> = {}): TaskDependencyPlan {
  return TaskDependencyPlanSchema.parse({
    id: "payments", name: "Payments API", kind: "http_api", family: "http:api.example-pay.com", backing: "fake", catalogId: "fake-server@r1", repository: "svc/fake-server",
    fake: { fixtureSetRef: SET_DIGEST, unmatched: "fail" }, config: {}, aliases: ["fake-payments"], connect: [{ name: "PAYMENTS_API_URL", template: "http://{host}:{port}" }], seeds: [], reset: "fresh_per_round", ...change,
  });
}
function postgresDependency(): TaskDependencyPlan {
  return TaskDependencyPlanSchema.parse({
    id: "postgres", name: "Postgres", kind: "database", family: "postgres", backing: "local", catalogId: "postgres@16", repository: "svc/postgres", digest: DIGEST, config: { database: "app", user: "app" }, aliases: ["postgres"],
    connect: [{ name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}:{port}/{db}" }], seeds: [], reset: "fresh_per_round",
  });
}

const catalog: ServiceCatalog = (() => {
  const copy = structuredClone(JSON.parse(readFileSync(new URL("../../environments/service-catalog/catalog.json", import.meta.url), "utf8")) as ServiceCatalog);
  for (const entry of copy.entries) if (entry.id === "postgres@16") entry.image.digest = DIGEST;
  return copy;
})();

interface SealedState { setups: SealedRoundSetup[]; rounds: number; executed: ProjectCommand[] }
function stubSealed(state: SealedState, build: SealedRoundPorts["buildServiceUsageRecord"] = (input) => buildServiceUsageRecord(input)): SealedRoundPorts {
  return {
    withSealedCheckRound(setup, round) {
      state.setups.push(setup);
      return withDetachedWorking(setup.docker, setup.plan, async (start) => {
        await start();
        state.rounds += 1;
        const runners: CheckRunners = {
          runProjectCommand: (command) => { state.executed.push(command); return Promise.resolve({ exitCode: 0, timedOut: false, stdout: "ok", stderr: "" }); },
          runAgentCommand: () => Promise.resolve({ exitCode: 0, timedOut: false, output: "" }),
        };
        return round(runners);
      });
    },
    buildServiceUsageRecord: build,
  };
}

/** A delivery that counts its asks and can be told to fail the Nth one. */
function delivery(options: { failFrom?: number; set?: FixtureSet } = {}) {
  const asked: string[] = [];
  const fetchSet: FixtureDelivery = (digest) => {
    asked.push(digest);
    if (options.failFrom !== undefined && asked.length >= options.failFrom) return Promise.reject(new FixtureDeliveryRefused("refused"));
    return Promise.resolve(options.set ?? SET);
  };
  return { fetchSet, asked };
}

const SUMMARY = { schemaVersion: 1, trusted: true, matched: 4, unmatched: 0, synthesized: 0, faults: 0, foreign: 0 };
const isSummaryExec = (args: readonly string[]): boolean => args.includes("--summarize");

async function harness(options: { docker?: FakeServicesDockerOptions; delivery?: ReturnType<typeof delivery> | "none" } = {}) {
  const fake = fakeServicesDocker({ execStdout: (args) => (isSummaryExec(args) ? `${JSON.stringify(SUMMARY)}\n` : undefined), ...options.docker });
  const root = await temp("rsf-workspace-");
  await mkdir(join(root, "app"));
  const runParent = await temp("rsf-runs-");
  const state: SealedState = { setups: [], rounds: 0, executed: [] };
  const logs: Array<Record<string, unknown>> = [];
  const artifacts: Array<{ name: string; mediaType: string; content: string }> = [];
  const config: TestServicesConfig = {
    docker: fake.docker, registry: REGISTRY, catalogEnv: "staging", edition: "public", probeImage: IMAGE, guardImage: IMAGE, maxMemMiB: 3072, runDirectoryParent: runParent,
    catalog: () => Promise.resolve(catalog), sealedRound: stubSealed(state), sleep: () => Promise.resolve(), log: (event) => { logs.push(event); },
  };
  const sandbox = new TaskSandbox({ rootPath: root, taskId: OPERATION, docker: fake.docker, image: IMAGE, log: () => undefined });
  await sandbox.start();
  const given = options.delivery === "none" ? undefined : options.delivery ?? delivery();
  const start = (dependencies: readonly TaskDependencyPlan[] = [fakeDependency()], extra: { workingPhase?: boolean } = {}) => startTestServicesRun(config, {
    dependencies, hasDevcontainer: false, operationId: OPERATION, rootPath: root, repositoryPaths: [join(root, "app")], sandbox, ...extra, ...(given === undefined ? {} : { fixtureDelivery: given.fetchSet }),
    artifactSink: (artifact) => { artifacts.push(artifact); return Promise.resolve(); },
  });
  const checkPlan: CheckPlan = { source: "project", readiness: [TEST_COMMAND], projectBefore: ["passed"] };
  const base: CheckRunners = { runProjectCommand: () => Promise.reject(new Error("no")), runAgentCommand: () => Promise.reject(new Error("no")) };
  const round = async (run: Awaited<ReturnType<typeof start>>) => runChecks(checkPlan, withTestServices(run, base), { budgetMs: 60_000, signal: new AbortController().signal });
  return { fake, root, runParent, state, config, sandbox, start, round, delivery: given, logs, artifacts };
}
type Harness = Awaited<ReturnType<typeof harness>>;

const nothingLeft = async (h: Harness): Promise<void> => {
  expect(h.fake.left().networks).toEqual([]);
  expect(h.fake.left().containers.filter((name) => name.startsWith("rovara-svc-"))).toEqual([]);
  expect(await readdir(h.runParent)).toEqual([]);
};
const flag = (args: readonly string[], name: string): string[] => args.flatMap((arg, index) => (args[index - 1] === name ? [arg] : []));
/** The `docker run --detach` of the fake servers, in order. */
const fakeRuns = (h: Harness): string[][] => h.fake.calls.filter((call) => call[0] === "run" && call.includes("--detach") && call.includes("/opt/agentx/packages/worker/dist/fake-helper.js"));

describe("a fake in the coding phase", () => {
  it("starts the fake server from the worker's own image, answering the working sandbox alone, with the set mounted into that one helper", async () => {
    const h = await harness();
    const run = await h.start();
    const runs = fakeRuns(h);
    expect(runs).toHaveLength(1);
    const call = runs[0]!;
    // The worker's image (by id), node in place of the entrypoint, the program and its numbers; no registry image, no digest of an image.
    expect(call).toContain("--entrypoint");
    expect(flag(call, "--entrypoint")).toEqual(["/usr/local/bin/node"]);
    expect(call.some((arg) => arg.includes(REGISTRY))).toBe(false);
    const program = call.slice(call.indexOf(IMAGE) + 1);
    expect(program[0]).toBe("/opt/agentx/packages/worker/dist/fake-helper.js");
    expect(flag(program, "--caller")).toEqual([expect.stringMatching(/^172\.30\.\d+\.3$/u) as string]);
    expect(flag(program, "--digest")).toEqual([SET_DIGEST]);
    expect(flag(program, "--unmatched")).toEqual(["fail"]);
    expect(flag(program, "--listen")).toEqual([expect.stringMatching(/^172\.30\.\d+\.16$/u) as string]);
    expect(flag(call, "--network-alias")).toEqual(["fake-payments"]);
    // The set is a read-only file of that helper's run directory, mounted at one fixed path; it is the whole of where it went.
    const mounted = h.fake.mounts.filter((mount) => mount.content?.includes(MARKER) === true);
    expect(mounted).toHaveLength(1);
    expect(mounted[0]).toMatchObject({ to: "/rovara/fixture.json" });
    expect(JSON.parse(mounted[0]!.content!)).toEqual(SET);
    expect(h.delivery?.asked).toEqual([SET_DIGEST]);
    // The agent's commands know where the fake is by name, and by nothing else it holds.
    const env = h.fake.execs.map((exec) => exec.envFile).filter((text): text is string => text !== undefined);
    await run.dispose();
    await h.sandbox.dispose();
    void env;
  });

  it("gives the sandbox's commands the connection variable (from the plan's template) and no fixture content anywhere an agent can see", async () => {
    const h = await harness();
    const run = await h.start([fakeDependency(), postgresDependency()]);
    // Run a command through the sandbox's wrapped exec: the run's variables come from the env file.
    await h.sandbox.exec(["true"], { cwd: "/workspace" } as never).catch(() => undefined);
    const files = h.fake.execs.map((exec) => exec.envFile).filter((text): text is string => text !== undefined);
    expect(files.some((text) => text.includes("PAYMENTS_API_URL=http://fake-payments:8080"))).toBe(true);
    const everywhere = JSON.stringify([h.fake.calls, h.fake.execs]);
    expect(everywhere).not.toContain(MARKER);
    expect(everywhere).not.toContain("api.example-pay.com\\\"");
    await run.dispose();
    await h.sandbox.dispose();
  });
});

describe("a fake in a sealed round", () => {
  it("is a new fake each round, on the round's own network, answering the check sandbox alone, with a set fetched at the start of the round", async () => {
    const h = await harness();
    const run = await h.start();
    await h.round(run);
    await h.round(run);
    const runs = fakeRuns(h);
    // working phase + two rounds
    expect(runs).toHaveLength(3);
    const callers = runs.map((call) => flag(call.slice(call.indexOf(IMAGE) + 1), "--caller")[0]!);
    expect(callers[0]).toMatch(/\.3$/u);
    expect(callers[1]).toMatch(/\.4$/u);
    expect(callers[2]).toMatch(/\.4$/u);
    // never the working sandbox's address in a round, and never both
    for (const call of runs.slice(1)) {
      expect(flag(call.slice(call.indexOf(IMAGE) + 1), "--caller")).toHaveLength(1);
      expect(call.join(" ")).not.toMatch(/172\.30\.\d+\.3\b/u);
    }
    // each fake on a network of its own (the working phase's is never a round's)
    const networks = runs.map((call) => flag(call, "--network")[0]!);
    expect(new Set(networks).size).toBe(3);
    expect(h.delivery?.asked).toEqual([SET_DIGEST, SET_DIGEST, SET_DIGEST]);
    // the set was mounted into each of the three helpers, once each, and into no other container
    expect(h.fake.mounts.filter((mount) => mount.content?.includes(MARKER) === true)).toHaveLength(3);
    for (const setup of h.state.setups) {
      // the working sandbox is never on the round's network, and the check sandbox has no copy of the set
      expect(setup.workingPhaseNetwork?.name).not.toBe(setup.plan.network.name);
      expect(JSON.stringify([setup.plan.sandboxRunArgs, setup.plan.dnsHelperRunArgs])).not.toContain(MARKER);
    }
    await run.dispose();
    await h.sandbox.dispose();
    await nothingLeft(h);
  });

  it("starts no fake in the coding phase for a checks run (no agent), and one in each round", async () => {
    const h = await harness();
    const run = await h.start([fakeDependency()], { workingPhase: false });
    expect(fakeRuns(h)).toHaveLength(0);
    expect(h.delivery?.asked).toEqual([]);
    await h.round(run);
    expect(fakeRuns(h)).toHaveLength(1);
    await run.dispose();
    await h.sandbox.dispose();
    await nothingLeft(h);
  });

  it("asks again for every round: a set withdrawn after the first round is not served in the next, and the run says what failed", async () => {
    const h = await harness({ delivery: delivery({ failFrom: 3 }) });
    const run = await h.start();
    await h.round(run);
    expect(h.state.rounds).toBe(1);
    // the second round's fetch is refused: no round starts, no check runs, and no fake is started for it
    await h.round(run).catch(() => undefined);
    expect(h.state.rounds).toBe(1);
    expect(h.state.executed).toHaveLength(1);
    expect(fakeRuns(h)).toHaveLength(2);
    expect(h.delivery?.asked).toEqual([SET_DIGEST, SET_DIGEST, SET_DIGEST]);
    await run.dispose();
    await h.sandbox.dispose();
    await nothingLeft(h);
  });

  it("reports what the fake was asked as bucketed counts, one row for the fake and nothing the program sent", async () => {
    const summary = { ...SUMMARY, matched: 4, unmatched: 3, faults: 0, foreign: 0 };
    const h = await harness({ docker: { execStdout: (args) => (isSummaryExec(args) ? `${JSON.stringify(summary)}\n` : undefined) } });
    const run = await h.start();
    await h.round(run);
    const record = await run.usageRecord();
    expect(TestServicesUsageRecordSchema.safeParse(record).success).toBe(true);
    expect(record?.fakes).toEqual([{ id: "payments", ledger: "read", matched: 2, unmatched: 2, synthesized: 0, faults: 0, foreign: 0 }]);
    // the summary was read inside the fake's container by a fixed command with fixed values
    const exec = h.fake.execs.find((entry) => isSummaryExec(entry.args))!;
    expect(exec.args.slice(0, 1)).toEqual(["exec"]);
    expect(exec.args).toEqual(expect.arrayContaining(["--ledger", "/tmp/fake-ledger.jsonl", "--fixture", "/rovara/fixture.json", "--digest", SET_DIGEST]));
    expect(flag(exec.args, "--caller")[0]).toMatch(/^172\.30\.\d+\.4$/u);
    expect(JSON.stringify(record)).not.toContain(MARKER);
    // what the run wrote for the broker (the usage artifact) and what it logged hold no content of the set and no address
    expect(h.artifacts.length).toBeGreaterThan(0);
    expect(JSON.stringify(h.artifacts)).not.toContain(MARKER);
    expect(JSON.stringify(h.logs)).not.toContain(MARKER);
    await run.dispose();
    await h.sandbox.dispose();
    expect(JSON.stringify(h.logs)).not.toContain(MARKER);
  });

  it("adds the rounds' counts up (lower bounds add), and a round whose ledger was not read makes the fake unreadable for the run", async () => {
    let call = 0;
    const h = await harness({ docker: { execStdout: (args) => { if (!isSummaryExec(args)) return undefined; call += 1; return `${JSON.stringify({ ...SUMMARY, matched: 2, unmatched: 1 })}\n`; } } });
    const run = await h.start();
    await h.round(run);
    await h.round(run);
    expect((await run.usageRecord())?.fakes).toEqual([{ id: "payments", ledger: "read", matched: 4, unmatched: 2, synthesized: 0, faults: 0, foreign: 0 }]);
    expect(call).toBeGreaterThanOrEqual(2);
    await run.dispose();
    await h.sandbox.dispose();

    let reads = 0;
    const second = await harness({ docker: { execStdout: (args) => { if (!isSummaryExec(args)) return undefined; reads += 1; return reads === 1 ? `${JSON.stringify(SUMMARY)}\n` : "not a summary\n"; } } });
    const again = await second.start();
    await second.round(again);
    await second.round(again);
    expect((await again.usageRecord())?.fakes).toEqual([{ id: "payments", ledger: "unreadable", matched: 0, unmatched: 0, synthesized: 0, faults: 0, foreign: 0 }]);
    await again.dispose();
    await second.sandbox.dispose();
  });

  it("is unreadable, never 'no calls', when the summary fails, is not one line of the shape, is untrusted, or the fake was not running", async () => {
    const cases: Array<[string, FakeServicesDockerOptions]> = [
      ["exit code", { execExit: (args) => (isSummaryExec(args) ? 1 : 0), execStdout: () => `${JSON.stringify(SUMMARY)}\n` }],
      ["garbage", { execStdout: (args) => (isSummaryExec(args) ? "hello\n" : undefined) }],
      ["two lines", { execStdout: (args) => (isSummaryExec(args) ? `${JSON.stringify(SUMMARY)}\n${JSON.stringify(SUMMARY)}\n` : undefined) }],
      ["extra field", { execStdout: (args) => (isSummaryExec(args) ? `${JSON.stringify({ ...SUMMARY, paths: ["/secret"] })}\n` : undefined) }],
      ["untrusted", { execStdout: (args) => (isSummaryExec(args) ? `${JSON.stringify({ ...SUMMARY, trusted: false, matched: 0 })}\n` : undefined) }],
      ["untrusted with counts", { execStdout: (args) => (isSummaryExec(args) ? `${JSON.stringify({ ...SUMMARY, trusted: false })}\n` : undefined) }],
    ];
    // the fake stops while its ledger is being read: what it recorded cannot be the whole of what it was asked
    let stopped = false;
    cases.push(["stopped during the read", { execStdout: (args) => { if (!isSummaryExec(args)) return undefined; stopped = true; return `${JSON.stringify(SUMMARY)}\n`; }, stateOf: () => (stopped ? "exited" : "running") }]);
    for (const [name, docker] of cases) {
      const h = await harness({ docker });
      const run = await h.start();
      await h.round(run);
      const record = await run.usageRecord();
      expect(record?.fakes, name).toEqual([{ id: "payments", ledger: "unreadable", matched: 0, unmatched: 0, synthesized: 0, faults: 0, foreign: 0 }]);
      await run.dispose();
      await h.sandbox.dispose();
    }
  });

  it("with a fake and Postgres, the record is Postgres's as before plus the fake's row", async () => {
    const h = await harness();
    const run = await h.start([postgresDependency(), fakeDependency()]);
    await h.round(run);
    const record = await run.usageRecord();
    expect(record?.dependencies.map((entry) => entry.id)).toEqual(["postgres", "payments"]);
    expect(record?.fakes?.map((entry) => entry.id)).toEqual(["payments"]);
    await run.dispose();
    await h.sandbox.dispose();
    await nothingLeft(h);
  });
});

describe("what is refused before anything starts", () => {
  it("a plan with a fake and no delivery (a worker without the callback)", async () => {
    const h = await harness({ delivery: "none" });
    await expect(h.start()).rejects.toMatchObject({ reason: "fixtures", message: "The approved answers a test service needs could not be fetched" });
    await nothingLeft(h);
  });
  it("a set that cannot be fetched or is not the pinned one", async () => {
    const h = await harness({ delivery: delivery({ failFrom: 1 }) });
    await expect(h.start()).rejects.toMatchObject({ reason: "fixtures" });
    await nothingLeft(h);
  });
  it("a plan the worker's own catalog does not agree with: another repository, an image digest, a made-up-answer policy, seeds, a restart between checks, no name, a retired or missing entry", async () => {
    const bad: Array<Record<string, unknown>> = [
      { repository: "svc/postgres" }, { seeds: [{ command: TEST_COMMAND }] }, { reset: "between_checks" }, { aliases: [] },
    ];
    for (const change of bad) {
      const h = await harness();
      await expect(h.start([fakeDependency(change)]), JSON.stringify(change)).rejects.toMatchObject({ reason: "mismatch" });
      await nothingLeft(h);
    }
    const missing = await harness();
    await expect(missing.start([fakeDependency({ catalogId: "fake-server@r9" })])).rejects.toMatchObject({ reason: "pull_failed" });
    const retired = await harness();
    (retired.config as { catalog: () => Promise<ServiceCatalog> }).catalog = () => Promise.resolve({ ...catalog, entries: catalog.entries.map((entry) => (entry.family === "fake-server" ? { ...entry, status: "retired" as const } : entry)) });
    await expect(retired.start()).rejects.toMatchObject({ reason: "mismatch" });
    await nothingLeft(retired);
  });
  it("the plan schema itself refuses an image digest on a fake, so a forged plan never reaches the launcher", () => {
    expect(TaskDependencyPlanSchema.safeParse({ ...fakeDependency(), digest: DIGEST }).success).toBe(false);
  });
});

describe("the feature the worker lists", () => {
  const shipped = (catalogFile: string) => ({ catalog: catalogFile, prepull: new URL("../../packages/worker/service-catalog/prepull.json", import.meta.url) });
  const real = new URL("../../environments/service-catalog/catalog.json", import.meta.url);
  it("lists the fake feature only with a test-services configuration and the baked catalog's fake server", async () => {
    const configured = { AGENTX_TEST_SERVICES_REGISTRY: REGISTRY, AGENTX_TEST_SERVICES_ENV: "staging", AGENTX_TEST_SERVICES_RUN_DIR: "/run/rovara", [TASK_SANDBOX_IMAGE_ENVIRONMENT]: IMAGE, AGENTX_WORKER_IMAGE: IMAGE } as NodeJS.ProcessEnv;
    expect(testServicesAdvertisedFeatures({}, shipped(real.pathname))).toEqual([]);
    expect(fakeServerBaked(shipped(real.pathname))).toBe(true);
    // 2026-11-04 (0.5.5 integration): the shipped catalog now pins local-aws@r1 (revision 2, staging pin), so the baked image also lists the emulated-AWS feature.
    expect(testServicesAdvertisedFeatures(configured, shipped(real.pathname))).toEqual(["task.testServices.v1", "task.testServices.fileSeed.v1", "task.testServices.seedLock.v1", "task.testServices.aws.v1", "task.testServices.fake.v1"]);
    // Root withheld test services (NOT_PULLED=all, also when the IPv6 wall failed and the images ARE here): no configuration, so neither feature is listed, though the fake server is baked and needs no image.
    expect(testServicesAdvertisedFeatures({ ...configured, AGENTX_TEST_SERVICES_NOT_PULLED: "all" }, shipped(real.pathname))).toEqual([]);
    // a catalog baked without the fake server (an older image) does not list it, and a catalog that cannot be read does not either
    const dir = await temp("rsf-catalog-");
    const without = JSON.parse(readFileSync(real, "utf8")) as { entries: Array<{ family: string }> };
    without.entries = without.entries.filter((entry) => entry.family !== "fake-server");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "catalog.json"), JSON.stringify(without));
    expect(fakeServerBaked(shipped(join(dir, "catalog.json")))).toBe(false);
    expect(testServicesAdvertisedFeatures(configured, shipped(join(dir, "catalog.json")))).toEqual(["task.testServices.v1", "task.testServices.fileSeed.v1", "task.testServices.seedLock.v1", "task.testServices.aws.v1"]);
    expect(fakeServerBaked(shipped(join(dir, "missing.json")))).toBe(false);
  });
});
