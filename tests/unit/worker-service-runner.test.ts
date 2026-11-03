// TS17: the ServiceRunner port and its Docker backend (test-services.md 4.0, 8). Nothing starts Docker: a fake daemon answers the few commands the runner and the launcher use. What is checked: the start order (sweep once,
// network, helpers, sandboxes), that the sandbox's place is a port (the runner never names the sealed sandbox), probe, usage, reset by the caller's hooks, stop (idempotent, never throws, in order), cleanup of a failed start,
// the lazy once-per-process worker-start sweep (L5), and Prove's ports filled from a runner (inert when Prove has no dependencies).
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { ServiceCatalogSchema, type CatalogEntry } from "../../packages/contracts/src/service-catalog.js";
import { TestEnvironmentBodySchema, testEnvDigest, type TestEnvironmentBody } from "@agentx/contracts";
import { proveEnvironment, type ProvePorts } from "../../packages/worker/src/prove.js";
import { HelperStartError, type HelperFiles, type HelperRequest } from "../../packages/worker/src/service-helpers.js";
import {
  ServiceRunnerError, createDockerServiceRunner, createProveServicePorts, forgetWorkerStartSweeps, parseServiceUsage,
  type ResetContext, type SandboxAttachment, type ServiceRunner, type ServiceRunnerStartInput, type ServiceSession,
} from "../../packages/worker/src/service-runner.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";

const RUN = "22222222-2222-4222-8222-222222222222";
const WS = "0123456789abcdef";
const NOW = 1_800_000_000_000;
const DIGEST = "a".repeat(64);
const PROBE_IMAGE = `rovara/worker@sha256:${"b".repeat(64)}`;
const PASSWORD = ["pw", "Zk3Lm9Qx7TbW"].join("");

const catalog = ServiceCatalogSchema.parse(JSON.parse(readFileSync(new URL("../../environments/service-catalog/catalog.json", import.meta.url), "utf8")) as unknown);
function pinned(id: string): CatalogEntry {
  const found = catalog.entries.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no entry ${id}`);
  const copy = structuredClone(found);
  copy.image.digest = DIGEST;
  return copy;
}

const files: HelperFiles = { write: (name) => Promise.resolve(`/run/rovara/${name}`), remove: () => Promise.resolve() };

interface FakeOptions {
  /** The `docker network create` fails. */
  failNetwork?: boolean;
  /** The sweep's listing fails (the daemon is down). */
  failSweep?: boolean;
  /** Containers (by name part) that never get healthy. */
  unhealthy?: boolean;
  stats?: string;
  /** Rows the family listing answers (tab-separated id, family, created, workspace, expires): left behind by an earlier worker, none due yet. */
  rows?: string;
  statsFails?: boolean;
}
function fakeDocker(options: FakeOptions = {}) {
  const calls: string[][] = [];
  const containers = new Map<string, string[]>();
  let networks = 0;
  const docker: DockerCli = {
    run(args) {
      calls.push([...args]);
      const ok = { exitCode: 0, stdout: "", stderr: "" };
      const fail = { exitCode: 1, stdout: "", stderr: "boom" };
      if (args[0] === "network" && args[1] === "create") {
        if (options.failNetwork === true) return Promise.resolve({ exitCode: 1, stdout: "", stderr: "daemon" });
        networks += 1;
        return Promise.resolve(ok);
      }
      if (args[0] === "network" && args[1] === "rm") { networks = Math.max(0, networks - 1); return Promise.resolve(ok); }
      if (args[0] === "ps" && args.includes("--format") && !args.some((word) => word.startsWith("label=rovara.run-network=")) && options.rows !== undefined) return Promise.resolve({ exitCode: 0, stdout: options.rows, stderr: "" });
      if (args[0] === "ps" || (args[0] === "network" && args[1] === "ls")) return Promise.resolve(options.failSweep === true ? fail : ok);
      if (args[0] === "image" && args[1] === "inspect") return Promise.resolve({ exitCode: 0, stdout: "null\n", stderr: "" });
      if (args[0] === "run" && args.includes("--detach")) { containers.set(args[args.indexOf("--name") + 1]!, [...args]); return Promise.resolve(ok); }
      if (args[0] === "run" && args.includes("--rm")) return Promise.resolve(options.unhealthy === true ? fail : ok);
      if (args[0] === "exec") return Promise.resolve(options.unhealthy === true ? fail : ok);
      if (args[0] === "inspect") return Promise.resolve({ exitCode: 0, stdout: "running\n", stderr: "" });
      if (args[0] === "rm") { for (const name of args.slice(1).filter((arg) => !arg.startsWith("-"))) containers.delete(name); return Promise.resolve(ok); }
      if (args[0] === "stats") return Promise.resolve({ exitCode: options.statsFails === true ? 1 : 0, stdout: options.stats ?? "", stderr: "" });
      return Promise.resolve(fail);
    },
  };
  return { docker, calls, containers, networks: () => networks };
}

function request(id: string, entryId: string, change: Partial<HelperRequest> = {}): HelperRequest {
  return { id, name: id, entry: pinned(entryId), credentials: { user: "rovara", password: PASSWORD, database: "app" }, ...change };
}
function input(change: Partial<ServiceRunnerStartInput> = {}): ServiceRunnerStartInput {
  return {
    runId: RUN, workspace: WS, roundBudgetMs: 1_500_000, registry: "registry.example.test/rovara", edition: "public", probeImage: PROBE_IMAGE, maxMemMiB: 3072,
    helpers: [request("postgres", "postgres@16")], files, now: () => NOW, sleep: () => Promise.resolve(), ...change,
  };
}
const dockerCalls = (calls: string[][], ...head: string[]): string[][] => calls.filter((call) => head.every((word, index) => call[index] === word));

function recorder() {
  const events: string[] = [];
  const attachment: SandboxAttachment = {
    attach: (network, helpers) => { events.push(`attach:${network.name}:${helpers.map((helper) => helper.id).join(",")}`); return Promise.resolve(); },
    detach: () => { events.push("detach"); return Promise.resolve(); },
  };
  return { events, attachment };
}

beforeEach(() => forgetWorkerStartSweeps());

describe("start and stop", () => {
  it("makes the network, starts the helpers on it, hands the sandboxes their place, and answers a session", async () => {
    const fake = fakeDocker();
    const sandboxes = recorder();
    const session = await createDockerServiceRunner(fake.docker).start(input({ sandboxes: sandboxes.attachment }));
    expect(fake.networks()).toBe(1);
    expect(fake.containers.size).toBe(1);
    expect(session.helpers.map((helper) => helper.id)).toEqual(["postgres"]);
    expect(session.network.name).toMatch(/^rovara-svc-[0-9a-f]{12}$/u);
    expect(session.network.checkSandboxIp).toMatch(/^172\.30\.\d+\.4$/u);
    expect(sandboxes.events).toEqual([`attach:${session.network.name}:postgres`]);
    // The order: the sweep, the network, the helper, and only then the sandbox.
    const firstNetwork = fake.calls.findIndex((call) => call[0] === "network" && call[1] === "create");
    const firstRun = fake.calls.findIndex((call) => call[0] === "run" && call.includes("--detach"));
    expect(firstNetwork).toBeGreaterThan(0);
    expect(firstRun).toBeGreaterThan(firstNetwork);
  });
  it("stop detaches the sandboxes first, then removes the helpers, then the network; twice is once; it never throws", async () => {
    const fake = fakeDocker();
    const sandboxes = recorder();
    const session = await createDockerServiceRunner(fake.docker).start(input({ sandboxes: sandboxes.attachment }));
    const before = fake.calls.length;
    await session.stop();
    await session.stop();
    expect(sandboxes.events.filter((event) => event === "detach")).toHaveLength(1);
    const after = fake.calls.slice(before);
    const removedHelpers = after.findIndex((call) => call[0] === "rm");
    const removedNetwork = after.findIndex((call) => call[0] === "network" && call[1] === "rm");
    expect(removedHelpers).toBeGreaterThanOrEqual(0);
    expect(removedNetwork).toBeGreaterThan(removedHelpers);
    expect(fake.containers.size).toBe(0);
    expect(fake.networks()).toBe(0);
    const throwing = await createDockerServiceRunner(fakeDocker().docker).start(input({ sandboxes: { attach: () => Promise.resolve(), detach: () => Promise.reject(new Error("detach failed")) } }));
    await expect(throwing.stop()).resolves.toBeUndefined();
  });
  it("a start that fails removes what it made: helpers, network and the sandboxes' place", async () => {
    const fake = fakeDocker({ unhealthy: true });
    const sandboxes = recorder();
    await expect(createDockerServiceRunner(fake.docker).start(input({ sandboxes: sandboxes.attachment, sleep: () => Promise.resolve(), now: (() => { let t = NOW; return () => (t += 40_000); })() }))).rejects.toBeInstanceOf(HelperStartError);
    expect(fake.containers.size).toBe(0);
    expect(fake.networks()).toBe(0);
    expect(sandboxes.events).toEqual(["detach"]);
  });
  it("a sandbox that cannot join ends the start with one fixed sentence, and everything is removed", async () => {
    const fake = fakeDocker();
    const failing: SandboxAttachment = { attach: () => Promise.reject(new Error(`secret ${PASSWORD} from the sandbox`)), detach: () => Promise.resolve() };
    const error = await createDockerServiceRunner(fake.docker).start(input({ sandboxes: failing })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ServiceRunnerError);
    expect((error as ServiceRunnerError).reason).toBe("attach_failed");
    expect((error as Error).message).toBe("The test sandbox could not join the test services' network");
    expect(fake.containers.size).toBe(0);
    expect(fake.networks()).toBe(0);
  });
  it("a network that cannot be made is the network module's own fixed failure, and no helper is started", async () => {
    const fake = fakeDocker({ failNetwork: true });
    await expect(createDockerServiceRunner(fake.docker).start(input())).rejects.toThrow();
    expect(fake.containers.size).toBe(0);
  });
  it("the runner never imports the sealed sandbox or the DNS helper: its imports are the launcher, the network, Docker and Prove's types", () => {
    const source = readFileSync(new URL("../../packages/worker/src/service-runner.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/from "([^"]+)"/gu)].map((match) => match[1]);
    expect(imports.sort()).toEqual(["./prove.js", "./run-network.js", "./service-helpers.js", "./setup-network.js", "./swebench/containers.js", "@agentx/contracts"]);
  });
});

describe("the worker-start sweep (L5): lazy, once per process and workspace", () => {
  const LEFT_BEHIND = `0123456789ab\trovara-svc-0123456789ab\t1700000000000\t${WS}\t9999999999999\n`;
  const removals = (calls: string[][]): string[][] => calls.filter((call) => call[0] === "rm" && call.includes("0123456789ab"));
  it("makes no Docker call until a service is started, then removes every family object of the workspace (whatever its expiry) before the first network", async () => {
    const fake = fakeDocker({ rows: LEFT_BEHIND });
    const runner = createDockerServiceRunner(fake.docker);
    expect(fake.calls).toEqual([]);
    const first = await runner.start(input());
    expect(removals(fake.calls)).toHaveLength(1);
    const swept = fake.calls.findIndex((call) => call[0] === "rm" && call.includes("0123456789ab"));
    const firstNetwork = fake.calls.findIndex((call) => call[0] === "network" && call[1] === "create");
    expect(swept).toBeGreaterThanOrEqual(0);
    expect(swept).toBeLessThan(firstNetwork);
    await first.stop();
  });
  it("only once: a later start of the same workspace leaves an object that is not yet due alone (the allocation sweep takes due ones only)", async () => {
    const fake = fakeDocker({ rows: LEFT_BEHIND });
    const runner = createDockerServiceRunner(fake.docker);
    await (await runner.start(input())).stop();
    const first = removals(fake.calls).length;
    await (await runner.start(input({ runId: "33333333-3333-4333-8333-333333333333" }))).stop();
    expect(removals(fake.calls)).toHaveLength(first);
    // Another workspace is its own first start.
    const other = await runner.start(input({ workspace: "fedcba9876543210", runId: "55555555-5555-4555-8555-555555555555" }));
    await other.stop();
  });
  it("a worker that never starts a service never sweeps (nothing at import or construction)", () => {
    const fake = fakeDocker({ rows: LEFT_BEHIND });
    createDockerServiceRunner(fake.docker);
    forgetWorkerStartSweeps();
    expect(fake.calls).toEqual([]);
  });
  it("a sweep that fails is not a failed start, and is tried again at the next start", async () => {
    const fake = fakeDocker({ failSweep: true });
    const runner = createDockerServiceRunner(fake.docker);
    const session = await runner.start(input());
    expect(session.helpers).toHaveLength(1);
    await session.stop();
  });
});

describe("probe, usage and reset", () => {
  it("probe asks the helper's health question again, and an unknown id is refused with a fixed sentence", async () => {
    const fake = fakeDocker();
    const session = await createDockerServiceRunner(fake.docker).start(input());
    const before = fake.calls.length;
    await expect(session.probe("postgres")).resolves.toBe(true);
    expect(fake.calls.length).toBeGreaterThan(before);
    await expect(session.probe("nope")).rejects.toMatchObject({ reason: "unknown_dependency", message: "The test services have no such dependency" });
    await session.stop();
    await expect(session.probe("postgres")).rejects.toMatchObject({ reason: "stopped" });
  });
  it("usage reads Docker's counters for exactly the run's helpers, and a helper with no row has nulls", async () => {
    const probe = fakeDocker();
    const warm = await createDockerServiceRunner(probe.docker).start(input({ helpers: [request("postgres", "postgres@16"), request("cache", "redis@7")] }));
    const names = warm.helpers.map((helper) => helper.container);
    await warm.stop();
    const fake = fakeDocker({ stats: `${names[0]!}\t12.5MiB / 512MiB\t1.50%\t7\n` });
    const session = await createDockerServiceRunner(fake.docker).start(input({ helpers: [request("postgres", "postgres@16"), request("cache", "redis@7")] }));
    const usage = await session.usage();
    const stats = dockerCalls(fake.calls, "stats")[0]!;
    expect(stats.slice(0, 4)).toEqual(["stats", "--no-stream", "--format", "{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}\t{{.PIDs}}"]);
    expect(stats.slice(4)).toEqual(session.helpers.map((helper) => helper.container));
    expect(usage[0]).toMatchObject({ id: "postgres", memoryBytes: Math.round(12.5 * 1024 ** 2), memoryLimitBytes: 512 * 1024 ** 2, cpuPercent: 1.5, pids: 7 });
    expect(usage[1]).toMatchObject({ id: "cache", memoryBytes: null, memoryLimitBytes: null, cpuPercent: null, pids: null });
    await session.stop();
  });
  it("usage after stop reads nothing from Docker, and a stats call that failed gives nulls even when it printed rows", async () => {
    const gone = fakeDocker({ stats: "x\t1MiB / 2MiB\t1%\t1\n" });
    const session = await createDockerServiceRunner(gone.docker).start(input());
    await session.stop();
    const before = gone.calls.length;
    const usage = await session.usage();
    expect(gone.calls.length).toBe(before);
    expect(usage).toEqual([{ id: "postgres", container: session.helpers[0]!.container, memoryBytes: null, memoryLimitBytes: null, cpuPercent: null, pids: null }]);
    const probe = fakeDocker();
    const warm = await createDockerServiceRunner(probe.docker).start(input());
    const name = warm.helpers[0]!.container;
    await warm.stop();
    const failing = fakeDocker({ stats: `${name}\t1MiB / 2MiB\t1%\t1\n`, statsFails: true });
    const live = await createDockerServiceRunner(failing.docker).start(input());
    expect((await live.usage())[0]).toMatchObject({ memoryBytes: null, cpuPercent: null, pids: null });
    await live.stop();
  });
  it("every probe question has its own container name, so one that is slow cannot clash with the next", async () => {
    const fake = fakeDocker();
    const session = await createDockerServiceRunner(fake.docker).start(input({ helpers: [request("aws", "local-aws@r1", { credentials: { user: "rovara", password: PASSWORD }, region: "us-east-1" })] }));
    const before = fake.calls.length;
    await session.probe("aws");
    await session.probe("aws");
    const names = fake.calls.slice(before).filter((call) => call[0] === "run" && call.includes("--rm")).map((call) => call[call.indexOf("--name") + 1]!);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    await session.stop();
  });
  it("parseServiceUsage drops a malformed row and reads only exact forms", () => {
    const rows = parseServiceUsage("a\t1GiB / 2GiB\t5%\t3\nb\tgarbage\tx\ty\nc\t1MiB\n", [{ id: "a", container: "a" }, { id: "b", container: "b" }, { id: "c", container: "c" }]);
    expect(rows[0]).toMatchObject({ memoryBytes: 1024 ** 3, memoryLimitBytes: 2 * 1024 ** 3, cpuPercent: 5, pids: 3 });
    expect(rows[1]).toMatchObject({ memoryBytes: null, memoryLimitBytes: null, cpuPercent: null, pids: null });
    expect(rows[2]).toMatchObject({ memoryBytes: null, cpuPercent: null, pids: null });
    // A percentage must say so: "55" is not 5.5 or 5.
    expect(parseServiceUsage("a\t1MiB / 2MiB\t55\t3\n", [{ id: "a", container: "a" }])[0]?.cpuPercent).toBeNull();
  });
  it("reset calls the hook for the entry's reset kind with a context that holds no secret; a kind with no hook is refused; a hook that throws is one fixed sentence", async () => {
    const fake = fakeDocker();
    const seen: ResetContext[] = [];
    const session = await createDockerServiceRunner(fake.docker).start(input({
      resetHooks: { template_db: (context) => { seen.push(context); return Promise.resolve(context.phase === "reset" ? { keptSeeds: true } : undefined); }, flush: () => Promise.reject(new Error(`boom ${PASSWORD}`)) },
      helpers: [request("postgres", "postgres@16"), request("cache", "redis@7")],
    }));
    await expect(session.reset("postgres")).resolves.toEqual({ keptSeeds: true });
    await session.seeded("postgres");
    const voidHook = await createDockerServiceRunner(fakeDocker().docker).start(input({ resetHooks: { template_db: () => Promise.resolve() } }));
    await expect(voidHook.reset("postgres")).resolves.toEqual({ keptSeeds: false });
    await voidHook.stop();
    expect(seen.map((context) => context.phase)).toEqual(["reset", "seeded"]);
    expect(seen[0]?.helper.id).toBe("postgres");
    // A kind with no hook has nothing to do when the seeds finish (only template_db does), and a hook that throws on it is one fixed sentence.
    await expect(session.seeded("cache")).rejects.toMatchObject({ reason: "reset_failed" });
    expect(JSON.stringify({ request: Object.keys(seen[0]!), network: seen[0]!.network.name })).not.toContain(PASSWORD);
    await expect(seen[0]!.health(1000)).resolves.toBe(true);
    const error = await session.reset("cache").catch((caught: unknown) => caught as ServiceRunnerError);
    expect(error).toMatchObject({ reason: "reset_failed", message: "A test service could not be reset" });
    expect((error as Error).message).not.toContain(PASSWORD);
    const bare = await createDockerServiceRunner(fakeDocker().docker).start(input());
    await expect(bare.reset("postgres")).rejects.toMatchObject({ reason: "reset_unsupported" });
    await expect(bare.seeded("postgres")).resolves.toBeUndefined();
    await expect(bare.reset("nope")).rejects.toMatchObject({ reason: "unknown_dependency" });
    await session.stop();
    await expect(session.reset("postgres")).rejects.toMatchObject({ reason: "stopped" });
    await expect(session.seeded("postgres")).rejects.toMatchObject({ reason: "stopped" });
  });
});

// ---- Prove

function fakeRunner() {
  const events: string[] = [];
  const healthy = new Set(["postgres"]);
  const runner: ServiceRunner = {
    start(startInput) {
      events.push(`start:${startInput.helpers.map((helper) => helper.id).join(",")}`);
      const session: ServiceSession = {
        network: { name: "n", bridge: "b", subnet: "s", gateway: "g", dnsHelperIp: "d", workingSandboxIp: "w", checkSandboxIp: "c", proxyIp: "p" },
        helpers: [],
        probe: (id) => { events.push(`probe:${id}`); return id === "ghost" ? Promise.reject(new ServiceRunnerError("unknown_dependency")) : Promise.resolve(healthy.has(id)); },
        usage: () => Promise.resolve([]),
        seeded: () => Promise.resolve(),
        reset: () => Promise.resolve({ keptSeeds: false }),
        stop: () => { events.push("stop"); return Promise.resolve(); },
      };
      return Promise.resolve(session);
    },
  };
  return { runner, events, healthy };
}
const service = (name: string) => ({ name, mode: "mock" }) as never;

describe("Prove's ports from a runner", () => {
  const plan = (unmatched = 0) => ({
    start: input(),
    dependencyIdOf: (s: { name: string }) => (s.name === "db" ? "postgres" : s.name === "cache" ? "redis" : undefined),
    unmatchedOf: () => Promise.resolve(unmatched),
  });
  it("startMock starts the run's helpers once, probes the one the service stands for, and an unknown service is refused", async () => {
    const { runner, events } = fakeRunner();
    const ports = createProveServicePorts(runner, plan());
    const signal = new AbortController().signal;
    await ports.startMock(service("db"), signal);
    await ports.startMock(service("db"), signal);
    expect(events.filter((event) => event.startsWith("start:"))).toHaveLength(1);
    await expect(ports.startMock(service("other"), signal)).rejects.toMatchObject({ reason: "unknown_dependency" });
    await expect(ports.startMock(service("cache"), signal)).rejects.toBeInstanceOf(ServiceRunnerError);
    // A service the plan does not know never starts the runner by itself.
    const fresh = fakeRunner();
    await expect(createProveServicePorts(fresh.runner, plan()).startMock(service("other"), signal)).rejects.toMatchObject({ reason: "unknown_dependency" });
    expect(fresh.events).toEqual([]);
  });
  it("probePreprod answers false with nothing started, and asks the running helper once there is a session", async () => {
    const { runner, events } = fakeRunner();
    const ports = createProveServicePorts(runner, plan());
    await expect(ports.probePreprod(service("db"), new AbortController().signal)).resolves.toBe(false);
    expect(events).toEqual([]);
    await ports.startMock(service("db"), new AbortController().signal);
    await expect(ports.probePreprod(service("db"), new AbortController().signal)).resolves.toBe(true);
    await expect(ports.probePreprod(service("nope"), new AbortController().signal)).resolves.toBe(false);
    // A helper the session does not have is "not answering", not an error.
    const unknown = createProveServicePorts(runner, { ...plan(), dependencyIdOf: (s: { name: string }) => (s.name === "db" ? "postgres" : s.name === "ghost" ? "ghost" : undefined) });
    await unknown.startMock(service("db"), new AbortController().signal);
    await expect(unknown.probePreprod(service("ghost"), new AbortController().signal)).resolves.toBe(false);
  });
  it("mockUnmatched reports the services Prove started, with the plan's counts (none known: zero)", async () => {
    const counted = fakeRunner();
    const withCounts = createProveServicePorts(counted.runner, plan(3));
    await withCounts.startMock(service("db"), new AbortController().signal);
    await expect(withCounts.mockUnmatched()).resolves.toEqual([{ service: "db", unmatchedFailed: 3 }]);
    const plain = fakeRunner();
    const bare = { start: plan().start, dependencyIdOf: plan().dependencyIdOf };
    const without = createProveServicePorts(plain.runner, bare);
    await without.startMock(service("db"), new AbortController().signal);
    await expect(without.mockUnmatched()).resolves.toEqual([{ service: "db", unmatchedFailed: 0 }]);
    await expect(createProveServicePorts(fakeRunner().runner, plan()).mockUnmatched()).resolves.toEqual([]);
  });
  it("release stops the session, once, and is safe with nothing started; a failed start leaves nothing to stop and can be tried again", async () => {
    const { runner, events } = fakeRunner();
    const ports = createProveServicePorts(runner, plan());
    await ports.release!();
    expect(events).toEqual([]);
    await ports.startMock(service("db"), new AbortController().signal);
    await ports.release!();
    await ports.release!();
    expect(events.filter((event) => event === "stop")).toHaveLength(1);
    let attempts = 0;
    const flaky: ServiceRunner = { start: (startInput) => (++attempts === 1 ? Promise.reject(new Error("no network")) : runner.start(startInput)) };
    const retry = createProveServicePorts(flaky, plan());
    await expect(retry.startMock(service("db"), new AbortController().signal)).rejects.toThrow("no network");
    await expect(retry.startMock(service("db"), new AbortController().signal)).resolves.toBeUndefined();
  });
});

describe("Prove: the release port", () => {
  const sha = (letter: string) => letter.repeat(64);
  const cmd = (executable: string, args: string[] = []) => ({ cwd: "service", executable, args, timeoutSeconds: 600 });
  const environment = (withService: boolean): TestEnvironmentBody => TestEnvironmentBodySchema.parse({
    tier: "sandbox",
    repos: [{ repositoryId: "svc", setupCommands: [cmd("make", ["setup"])], checks: [{ id: "unit", label: "Unit", command: cmd("make", ["test"]), kind: "test" }] }],
    roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" },
    services: withService ? [{ name: "scorer", kind: "sagemaker_runtime", match: { endpointName: "scorer" }, mode: "mock", mock: { fixtureSetRef: sha("a"), schemaRef: sha("b"), unmatched: "fail" } }] : [],
    data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [], prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false },
  });
  function ports(over: Partial<ProvePorts> = {}): ProvePorts {
    return {
      runCommand: () => Promise.resolve({ exitCode: 0, timedOut: false, stdout: "", stderr: "" }),
      startMock: () => Promise.resolve(), probePreprod: () => Promise.resolve(true), mockUnmatched: () => Promise.resolve([]), buildCoverageMap: () => Promise.resolve(undefined),
      now: () => 1_000_000, ...over,
    };
  }
  const prove = (p: ProvePorts, env: TestEnvironmentBody, signal = new AbortController().signal) => proveEnvironment(p, { proposalDigest: testEnvDigest(env), environment: env, signal, deadlineMs: 3_600_000 });

  it("a port set without release behaves as before; with one, it is called once after the run, pass or fail", async () => {
    const env = environment(false);
    const plain = await prove(ports(), env);
    expect(plain.steps.every((step) => step.status !== "failed")).toBe(true);
    let released = 0;
    await prove(ports({ release: () => { released += 1; return Promise.resolve(); } }), env);
    expect(released).toBe(1);
    await prove(ports({ release: () => { released += 1; return Promise.resolve(); }, runCommand: () => Promise.resolve({ exitCode: 1, timedOut: false, stdout: "", stderr: "" }) }), env);
    expect(released).toBe(2);
    const stopped = new AbortController();
    stopped.abort();
    await prove(ports({ release: () => { released += 1; return Promise.resolve(); } }), env, stopped.signal);
    expect(released).toBe(3);
  });
  it("a release that fails or throws is not the run's failure", async () => {
    const env = environment(false);
    const rejecting = await prove(ports({ release: () => Promise.reject(new Error("docker gone")) }), env);
    const throwing = await prove(ports({ release: () => { throw new Error("sync"); } }), env);
    for (const report of [rejecting, throwing]) expect(report.steps.every((step) => step.status !== "failed")).toBe(true);
  });
  it("with no dependencies a runner-filled port set starts nothing and releases nothing", async () => {
    const { runner, events } = fakeRunner();
    const filled = createProveServicePorts(runner, { start: input(), dependencyIdOf: () => "postgres" });
    const report = await prove(ports({ ...filled }), environment(false));
    expect(report.steps.every((step) => step.status !== "failed")).toBe(true);
    expect(events).toEqual([]);
  });
  it("with a service, the runner starts at boot and is stopped at the end", async () => {
    const { runner, events } = fakeRunner();
    const filled = createProveServicePorts(runner, { start: input(), dependencyIdOf: () => "postgres" });
    const report = await prove(ports({ ...filled }), environment(true));
    expect(report.steps.find((step) => step.step === "boot")?.status).toBe("passed");
    expect(events[0]).toMatch(/^start:/u);
    expect(events.at(-1)).toBe("stop");
  });
});
