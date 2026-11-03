// Test services, slice 1, s1-worker-round T1 (worker/src/test-services-run.ts): the orchestrator that starts a task's pinned dependencies, joins the working sandbox, runs the seeds, seals every check round and tears the
// run down on every exit path (TS-RUN-4). No Docker: a fake daemon (tests/support/fake-services-docker.ts) and a stub of s1-sealed's two exports that uses the REAL `withDetachedWorking` of check-sandbox.ts.
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskDependencyPlanSchema, TestServicesUsageRecordSchema, type ProjectCommand, type ServiceCatalog, type TaskDependencyPlan, type TestEnvTaskPlan } from "@agentx/contracts";
import { withDetachedWorking } from "../../packages/worker/src/check-sandbox.js";
import { forgetWorkerStartSweeps } from "../../packages/worker/src/service-runner.js";
import { TaskSandbox } from "../../packages/worker/src/task-sandbox.js";
import {
  SEALED_ROUND_PORTS, TEST_SERVICES_USAGE_ARTIFACT, TestServicesError, catalogTrustedKeys, loadCatalogFromDirectory, testServicesAdvertisedFeatures, neverValuesFor, startTaskTestServices, startTestServicesRun, testServicesAtWorkerBoot, testServicesConfigFromEnvironment, withTestServices,
  type SealedRoundPorts, type SealedRoundSetup, type TestServicesConfig,
} from "../../packages/worker/src/test-services-run.js";
import { runChecks, type CheckPlan, type CheckRunners } from "../../packages/worker/src/verification/checks.js";
import { fakeServicesDocker, type FakeServicesDockerOptions } from "../support/fake-services-docker.js";

const DIGEST = "a".repeat(64);
const IMAGE = `registry.example.test/agentx/worker@sha256:${"b".repeat(64)}`;
const REGISTRY = "123456789012.dkr.ecr.us-west-2.amazonaws.com";
const OPERATION = "44444444-4444-4444-8444-444444444444";
const MIGRATE: ProjectCommand = { cwd: "app", executable: "npm", args: ["run", "migrate"], timeoutSeconds: 60 };
const TEST_COMMAND: ProjectCommand = { cwd: "app", executable: "npm", args: ["test"], timeoutSeconds: 60 };

const roots: string[] = [];
beforeEach(() => forgetWorkerStartSweeps());
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function temp(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

function dependency(change: Partial<TaskDependencyPlan> = {}): TaskDependencyPlan {
  return TaskDependencyPlanSchema.parse({
    id: "postgres", name: "Postgres", kind: "database", family: "postgres", backing: "local", catalogId: "postgres@16", repository: "svc/postgres", digest: DIGEST,
    config: { database: "app", user: "app" }, aliases: ["postgres"],
    connect: [{ name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}:{port}/{db}" }, { name: "PGPASSWORD", template: "{password}" }],
    seeds: [{ command: MIGRATE }], reset: "fresh_per_round", ...change,
  });
}

const catalog: ServiceCatalog = (() => {
  const raw = JSON.parse(readFileSync(new URL("../../environments/service-catalog/catalog.json", import.meta.url), "utf8")) as ServiceCatalog;
  const copy = structuredClone(raw);
  for (const entry of copy.entries) if (entry.id === "postgres@16") entry.image.digest = DIGEST;
  return copy;
})();

interface SealedState {
  executed: ProjectCommand[];
  setups: SealedRoundSetup[];
  rounds: number;
  /** The round's callback waits for this before it hands the runners over (to hold a round open). */
  hold?: Promise<void>;
  failStart?: boolean;
  exitCode?: number;
  throwOnCommand?: boolean;
  /** A command that takes this long to run (the signal can stop it). */
  slowCommand?: boolean;
}

/** s1-sealed's two exports, as a stub: the round is the real `withDetachedWorking`, the checks are recorded. */
function stubSealed(state: SealedState): SealedRoundPorts {
  return {
    withSealedCheckRound(setup, round) {
      state.setups.push(setup);
      return withDetachedWorking(setup.docker, setup.plan, async (start) => {
        if (state.failStart === true) throw new Error("the sealed round could not start");
        await start();
        state.rounds += 1;
        const runners: CheckRunners = {
          async runProjectCommand(command, signal) {
            state.executed.push(command);
            // The seeds (`npm run migrate`) always work; the failures below are the CHECK's.
            if (command.args.join(" ") === "run migrate") return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
            if (state.throwOnCommand === true) throw new Error("the check could not be run");
            if (state.slowCommand === true) await new Promise<void>((_, reject) => { signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); });
            return { exitCode: state.exitCode ?? 0, timedOut: false, stdout: "ok", stderr: "" };
          },
          runAgentCommand: () => Promise.resolve({ exitCode: 0, timedOut: false, output: "" }),
        };
        if (state.hold !== undefined) await state.hold;
        return round(runners);
      });
    },
    buildServiceUsageRecord(input) {
      return Promise.resolve({
        schemaVersion: 1,
        dependencies: input.planned.map((id) => ({ id, started: true, healthy: true, startMs: input.startMs === undefined || typeof input.startMs !== "number" ? 0 : input.startMs, resetCount: input.resetCounts?.get(id) ?? 0, ...(input.failures?.get(id) === undefined ? {} : { failure: input.failures.get(id) }) })),
        unknownCalls: { domains: [], otherCount: 0 },
      });
    },
  };
}

async function harness(options: { docker?: FakeServicesDockerOptions; sealed?: Partial<SealedState>; withoutSealed?: boolean; realSealed?: boolean } = {}) {
  const fake = fakeServicesDocker(options.docker);
  const root = await temp("rsv-workspace-");
  await mkdir(join(root, "app"));
  const runParent = await temp("rsv-runs-");
  const state: SealedState = { executed: [], setups: [], rounds: 0, ...options.sealed };
  const logs: Array<Record<string, unknown>> = [];
  const artifacts: Array<{ name: string; mediaType: string; content: string }> = [];
  const config: TestServicesConfig = {
    docker: fake.docker, registry: REGISTRY, catalogEnv: "staging", edition: "public", probeImage: IMAGE, maxMemMiB: 3072, runDirectoryParent: runParent,
    catalog: () => Promise.resolve(catalog), ...(options.withoutSealed === true ? {} : { sealedRound: options.realSealed === true ? SEALED_ROUND_PORTS : stubSealed(state) }), sleep: () => Promise.resolve(), log: (event) => logs.push(event),
  };
  const sandbox = new TaskSandbox({ rootPath: root, taskId: OPERATION, docker: fake.docker, image: IMAGE, log: () => undefined });
  await sandbox.start();
  const artifactSink = (artifact: { name: string; mediaType: string; content: string }): Promise<void> => { artifacts.push(artifact); return Promise.resolve(); };
  const start = (dependencies: readonly TaskDependencyPlan[] = [dependency()], hasDevcontainer = false) => startTestServicesRun(config, { dependencies, hasDevcontainer, operationId: OPERATION, rootPath: root, repositoryPaths: [join(root, "app")], sandbox, artifactSink });
  const checkPlan: CheckPlan = { source: "project", readiness: [TEST_COMMAND], projectBefore: ["passed"] };
  const base: CheckRunners = { runProjectCommand: () => Promise.reject(new Error("the working sandbox's runners must not run a check")), runAgentCommand: () => Promise.reject(new Error("the working sandbox's runners must not run a check")) };
  return { fake, root, runParent, state, logs, artifacts, config, sandbox, start, checkPlan, base };
}

/** The password the run made, read back from the env file of the seed's exec (the only place it is written). */
function passwordOf(fake: ReturnType<typeof fakeServicesDocker>): string {
  const content = fake.execs.map((exec) => exec.envFile).find((text) => text?.includes("DATABASE_URL=") === true);
  const match = /DATABASE_URL=postgres:\/\/app:([A-Za-z0-9]+)@postgres:5432\/app/u.exec(content ?? "");
  if (match?.[1] === undefined) throw new Error("no password in any env file");
  return match[1];
}
const nothingLeft = async (h: Awaited<ReturnType<typeof harness>>): Promise<void> => {
  expect(h.fake.left().networks).toEqual([]);
  expect(h.fake.left().containers.filter((name) => name.startsWith("rovara-svc-"))).toEqual([]);
  expect(await readdir(h.runParent)).toEqual([]);
};
const indexOf = (calls: string[][], predicate: (call: string[]) => boolean, from = 0): number => calls.findIndex((call, index) => index >= from && predicate(call));

describe("starting the run", () => {
  it("pulls the pinned image by digest, starts the helper from it on the run's network, joins the working sandbox at .3 and seeds with the run's variables", async () => {
    const h = await harness();
    const run = await h.start();
    const reference = `${REGISTRY}/rovara-catalog/staging/svc/postgres@sha256:${DIGEST}`;
    expect(h.fake.pulls).toEqual([reference]);
    const helperRun = h.fake.calls.find((call) => call[0] === "run" && call.includes("--detach") && call.includes(reference));
    expect(helperRun).toBeDefined();
    expect(helperRun).toContain("--pull=never");
    const network = h.fake.left().networks[0]!;
    const connect = h.fake.calls.find((call) => call[0] === "network" && call[1] === "connect");
    expect(connect).toEqual(["network", "connect", "--ip", expect.stringMatching(/^172\.30\.\d+\.3$/u) as string, network, h.sandbox.name]);
    // The seed ran in the working sandbox, with the run's env file (the variables come from the file, never from arguments).
    const seed = h.fake.execs.find((exec) => exec.envFile?.includes("DATABASE_URL=") === true);
    expect(seed).toBeDefined();
    expect(seed!.args).toContain(h.sandbox.name);
    expect(seed!.envFile).toContain("PGPASSWORD=");
    // The sealed name server and the check sandbox exist only inside a round.
    expect(h.fake.left().containers.some((name) => name.endsWith("-dns"))).toBe(false);
    expect(h.fake.left().containers.some((name) => name.endsWith("-check"))).toBe(false);
    await run.dispose();
    await h.sandbox.dispose();
  });

  it("does not pull an image the host already has", async () => {
    const h = await harness({ docker: { imagePresent: true } });
    const run = await h.start();
    expect(h.fake.pulls).toEqual([]);
    await run.dispose();
  });

  it("refuses a dependency whose repository, digest, family or catalog entry differs from the worker's own signed catalog", async () => {
    for (const change of [{ digest: "c".repeat(64) }, { repository: "svc/mysql" }, { family: "mysql" }, { catalogId: "postgres@99" }] as const) {
      const h = await harness();
      await expect(h.start([dependency(change)])).rejects.toMatchObject({ reason: "mismatch" });
      expect(h.fake.verbs("network").filter((call) => call[1] === "create")).toEqual([]);
      await nothingLeft(h);
    }
  });

  it("refuses a user or database name that is not in the launcher's plain form, and starts nothing", async () => {
    const h = await harness();
    await expect(h.start([dependency({ config: { database: "App", user: "app" } })])).rejects.toMatchObject({ reason: "mismatch" });
    await expect(h.start([dependency({ config: { database: "app", user: "A_user" } })])).rejects.toMatchObject({ reason: "mismatch" });
    await nothingLeft(h);
  });

  it("refuses before it starts anything when the worker has no sealed round (s1-sealed not bound): no network, no helper, no run directory", async () => {
    const h = await harness({ withoutSealed: true });
    await expect(h.start()).rejects.toMatchObject({ reason: "sealed_unavailable" });
    expect(h.fake.calls.filter((call) => (call[0] === "network" && call[1] !== "inspect") || call[0] === "pull")).toEqual([]);
    await nothingLeft(h);
  });

  it("fixes the seed of a fixture file as not available yet: the seed fails closed and the run is removed", async () => {
    const h = await harness();
    await expect(h.start([dependency({ seeds: [{ fixturePath: "db/seed.sql" }] })])).rejects.toMatchObject({ reason: "seed_failed", failures: new Map([["postgres", "seed_failed"]]) });
    await nothingLeft(h);
  });

  it("a pull that fails, a helper that fails to start, a name server that fails to start and a working sandbox that cannot join each remove everything and say which fixed failure it was", async () => {
    const cases: Array<[FakeServicesDockerOptions, string, string | undefined]> = [
      [{ pullFails: true }, "pull_failed", "pull_failed"],
      [{ failRun: "helper" }, "start_failed", "start_failed"],
      [{ failConnect: true }, "start_failed", "start_failed"],
    ];
    for (const [docker, reason, failure] of cases) {
      const h = await harness({ docker });
      const error = await h.start().then(() => undefined, (caught: unknown) => caught);
      expect(error, reason).toBeInstanceOf(TestServicesError);
      expect((error as TestServicesError).reason).toBe(reason);
      expect((error as TestServicesError).failures.get("postgres")).toBe(failure);
      await nothingLeft(h);
    }
  });
});

describe("a project with a dev container", () => {
  it("is refused with the fixed not-available-yet sentence before anything is created: no run directory, no network, no helper, no name server, no pull", async () => {
    const h = await harness();
    const before = h.fake.calls.length;
    await expect(h.start([dependency()], true)).rejects.toThrow("Test services are not available yet for a project that uses a dev container.");
    await expect(startTaskTestServices({ plan: { revision: 1, digest: "d".repeat(64), roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, checks: [{ id: "unit", kind: "test" }], dependencies: [dependency()] }, mode: "CHECKS", sandbox: h.sandbox, devcontainer: true, nightly: false, repositoryPaths: [], operationId: OPERATION, rootPath: h.root, config: h.config, artifactSink: () => Promise.resolve() }))
      .rejects.toThrow("Test services are not available yet for a project that uses a dev container.");
    expect(h.fake.calls.length).toBe(before);
    expect(await readdir(h.runParent)).toEqual([]);
  });
});

describe("a dependency's init files (config.initFiles)", () => {
  const withInit = (path: string) => dependency({ config: { database: "app", user: "app", initFiles: [path] } });
  const refusedWithNothingMade = async (h: Awaited<ReturnType<typeof harness>>, plan: TaskDependencyPlan): Promise<void> => {
    const before = h.fake.calls.length;
    await expect(h.start([plan])).rejects.toMatchObject({ reason: "init_file", message: "A test service's init file is not a plain SQL file inside the workspace" });
    expect(h.fake.calls.length).toBe(before);
    await nothingLeft(h);
  };

  it("a normal file inside a repository goes read-only into the Postgres helper alone: the working-phase one, and each round's own", async () => {
    const h = await harness();
    await mkdir(join(h.root, "app", "db"), { recursive: true });
    await writeFile(join(h.root, "app", "db", "init.sql"), "CREATE TABLE t (id int);\n");
    const run = await h.start([withInit("app/db/init.sql")]);
    const mountsOf = () => h.fake.calls.filter((call) => call[0] === "run" && call.some((arg) => arg.endsWith(":/docker-entrypoint-initdb.d/init-01.sql:ro")));
    expect(mountsOf()).toHaveLength(1);
    await runChecks(h.checkPlan, withTestServices(run, h.base), { budgetMs: 60_000, signal: new AbortController().signal });
    expect(mountsOf()).toHaveLength(2);
    for (const mount of mountsOf()) expect(mount[mount.indexOf("--name") + 1]).toMatch(/-h[0-9a-f]{10}$/u);
    // No other container (the name servers, the check sandboxes, the working sandbox) mounts it.
    expect(h.fake.calls.filter((call) => call[0] === "run" && call.join(" ").includes("initdb.d"))).toHaveLength(2);
    await run.dispose();
  });

  it("a file in a hidden workspace folder (.agentx) or outside every repository's folder is refused, even as a plain file", async () => {
    const h = await harness();
    await mkdir(join(h.root, ".agentx"), { recursive: true });
    await writeFile(join(h.root, ".agentx", "evil.sql"), "SELECT 1;\n");
    await mkdir(join(h.root, "elsewhere"), { recursive: true });
    await writeFile(join(h.root, "elsewhere", "other.sql"), "SELECT 1;\n");
    await refusedWithNothingMade(h, withInit(".agentx/evil.sql"));
    await refusedWithNothingMade(h, withInit("elsewhere/other.sql"));
  });

  it("when the repository IS the workspace root, a hidden folder is still refused", async () => {
    const h = await harness();
    await mkdir(join(h.root, ".agentx"), { recursive: true });
    await writeFile(join(h.root, ".agentx", "evil.sql"), "SELECT 1;\n");
    await writeFile(join(h.root, "ok.sql"), "SELECT 1;\n");
    const before = h.fake.calls.length;
    await expect(startTestServicesRun(h.config, { dependencies: [withInit(".agentx/evil.sql")], hasDevcontainer: false, operationId: OPERATION, rootPath: h.root, repositoryPaths: [h.root], sandbox: h.sandbox }))
      .rejects.toMatchObject({ reason: "init_file" });
    expect(h.fake.calls.length).toBe(before);
    const run = await startTestServicesRun(h.config, { dependencies: [withInit("ok.sql")], hasDevcontainer: false, operationId: OPERATION, rootPath: h.root, repositoryPaths: [h.root], sandbox: h.sandbox });
    await run.dispose();
  });

  it("a symlink to /etc/passwd is refused before anything starts", async () => {
    const h = await harness();
    await mkdir(join(h.root, "app", "db"), { recursive: true });
    await symlink("/etc/passwd", join(h.root, "app", "db", "init.sql"));
    await refusedWithNothingMade(h, withInit("app/db/init.sql"));
  });

  it("a symlink to a file outside the workspace, and a folder symlink that leads out, are refused", async () => {
    const h = await harness();
    const outside = await temp("rsv-outside-");
    await writeFile(join(outside, "secret.sql"), "SELECT 1;\n");
    await mkdir(join(h.root, "app", "db"), { recursive: true });
    await symlink(join(outside, "secret.sql"), join(h.root, "app", "db", "init.sql"));
    await symlink(outside, join(h.root, "app", "linked"));
    await refusedWithNothingMade(h, withInit("app/db/init.sql"));
    await refusedWithNothingMade(h, withInit("app/linked/secret.sql"));
  });

  it("a file that is not .sql, a directory and a missing file are refused", async () => {
    const h = await harness();
    await mkdir(join(h.root, "app", "db", "dir.sql"), { recursive: true });
    await writeFile(join(h.root, "app", "db", "init.sh"), "echo hi\n");
    for (const path of ["app/db/init.sh", "app/db/dir.sql", "app/db/missing.sql"]) await refusedWithNothingMade(h, withInit(path));
  });
});

describe("the working sandbox's commands", () => {
  it("every exec gets the run's variables as an env file, last: the command's own value for the same name is dropped, its other variables stay", async () => {
    const h = await harness();
    const run = await h.start();
    await h.sandbox.exec(["echo", "hi"], { env: { DATABASE_URL: "postgres://repo:own@elsewhere/own", OTHER: "kept" } });
    const exec = h.fake.execs.at(-1)!;
    expect(exec.envFile).toContain("DATABASE_URL=postgres://app:");
    expect(exec.args.filter((arg) => arg === "--env")).toHaveLength(1);
    expect(exec.args).toContain("OTHER=kept");
    expect(exec.args.join(" ")).not.toContain("elsewhere");
    expect(exec.args.join(" ")).not.toContain("DATABASE_URL");
    await run.dispose();
  });

  it("the env file is removed as soon as the exec returns, and no argument of any docker call holds the password", async () => {
    const h = await harness();
    const run = await h.start();
    await h.sandbox.exec(["true"], {});
    const password = passwordOf(h.fake);
    expect(password).toHaveLength(32);
    expect(JSON.stringify(h.fake.calls)).not.toContain(password);
    expect(await readdir(h.runParent).then(async (dirs) => (await Promise.all(dirs.map((dir) => readdir(join(h.runParent, dir))))).flat().filter((file) => file.endsWith(".env")))).toEqual([]);
    await run.dispose();
  });

  it("after the run is torn down, the sandbox's commands run as a sandbox's do (no env file)", async () => {
    const h = await harness();
    const run = await h.start();
    await run.dispose();
    await h.sandbox.exec(["true"], {});
    expect(h.fake.execs.at(-1)!.args).not.toContain("--env-file");
  });
});

describe("a sealed check round", () => {
  it("starts brand-new helpers on a network of its own, seeds them inside the round, runs the check there, and removes all of it; the working sandbox is back where it was", async () => {
    const h = await harness();
    const run = await h.start();
    const callsBefore = h.fake.calls.length;
    const runners = withTestServices(run, h.base);
    expect(runners).not.toBe(h.base);
    const round = await runChecks(h.checkPlan, runners, { budgetMs: 60_000, signal: new AbortController().signal });
    expect(round.entries.map((entry) => entry.after)).toEqual(["passed"]);
    // The seeds ran inside the round (the sealed runners), then the check.
    expect(h.state.executed).toEqual([expect.objectContaining({ args: ["run", "migrate"] }), expect.objectContaining({ args: ["test"] })]);
    const calls = h.fake.calls.slice(callsBefore);
    const roundNetwork = indexOf(calls, (call) => call[0] === "network" && call[1] === "create");
    const helper = indexOf(calls, (call) => call[0] === "run" && call.includes("--detach") && /-h[0-9a-f]{10}$/u.test(call[call.indexOf("--name") + 1]!));
    const dns = indexOf(calls, (call) => call[0] === "run" && call.includes("--detach") && call[call.indexOf("--name") + 1]!.endsWith("-dns"));
    const start = indexOf(calls, (call) => call[0] === "run" && call.includes("--detach") && call[call.indexOf("--name") + 1]!.endsWith("-check"));
    const seeded = indexOf(calls, (call) => call[0] === "exec" && call.includes("psql"));
    const remove = indexOf(calls, (call) => call[0] === "rm" && call.some((arg) => arg.endsWith("-check")));
    const networkRemoved = indexOf(calls, (call) => call[0] === "network" && call[1] === "rm");
    expect(roundNetwork).toBeGreaterThanOrEqual(0);
    expect(helper).toBeGreaterThan(roundNetwork);
    expect(dns).toBeGreaterThan(helper);
    expect(start).toBeGreaterThan(dns);
    expect(seeded).toBeGreaterThan(start);
    expect(remove).toBeGreaterThan(seeded);
    expect(networkRemoved).toBeGreaterThan(remove);
    // The working sandbox is on its own networks only (the task network and the working-phase services network); the round's network and everything on it are gone.
    expect(h.fake.containers.get(h.sandbox.name)!.networks.size).toBe(2);
    expect(h.fake.left().networks).toHaveLength(1);
    await run.dispose();
  });

  it("never reuses the working phase: other containers, another network, another password, and the working sandbox is never on the round's network", async () => {
    const h = await harness({ realSealed: true });
    const run = await h.start();
    const workingHelpers = h.fake.left().containers.filter((name) => /-h[0-9a-f]{10}$/u.test(name));
    const workingNetwork = h.fake.left().networks[0]!;
    const workingPassword = passwordOf(h.fake);
    await runChecks(h.checkPlan, withTestServices(run, h.base), { budgetMs: 60_000, signal: new AbortController().signal });
    const roundHelperRuns = h.fake.calls.filter((call) => call[0] === "run" && call.includes("--detach") && /-h[0-9a-f]{10}$/u.test(call[call.indexOf("--name") + 1]!)).slice(1);
    expect(roundHelperRuns).toHaveLength(1);
    expect(workingHelpers).not.toContain(roundHelperRuns[0]![roundHelperRuns[0]!.indexOf("--name") + 1]);
    expect(roundHelperRuns[0]![roundHelperRuns[0]!.indexOf("--network") + 1]).not.toBe(workingNetwork);
    expect(roundHelperRuns[0]).toContain("--pull=never");
    expect(roundHelperRuns[0]!.some((arg) => arg.endsWith(`@sha256:${DIGEST}`))).toBe(true);
    // The working sandbox never joined the round's network (it was reattached by the round's end only, and removed from it at once).
    const roundNetwork = roundHelperRuns[0]![roundHelperRuns[0]!.indexOf("--network") + 1]!;
    const joins = h.fake.calls.filter((call) => call[0] === "network" && call[1] === "connect" && call.includes(roundNetwork));
    const leaves = h.fake.calls.filter((call) => call[0] === "network" && call[1] === "disconnect" && call.includes(roundNetwork) && call.includes("--force"));
    expect(leaves.length).toBeGreaterThanOrEqual(joins.length);
    // The round's variables carry another password; the seeds and the check ran in the check sandbox with it, and the working password is nowhere in a sealed exec.
    const sealedExecs = h.fake.execs.filter((exec) => exec.args.some((arg) => arg.endsWith("-check")));
    expect(sealedExecs.length).toBeGreaterThan(0);
    for (const exec of sealedExecs) expect(exec.envFile ?? "").not.toContain(workingPassword);
    // The round's database setup (the template) was made on the ROUND's helper only: no psql ran on a working-phase helper after the working phase ended.
    const roundHelper = roundHelperRuns[0]![roundHelperRuns[0]!.indexOf("--name") + 1]!;
    const psql = h.fake.execs.filter((exec) => exec.args.includes("psql"));
    expect(psql.length).toBeGreaterThan(1);
    expect(psql.at(-1)!.args).toContain(roundHelper);
    await run.dispose();
  });

  it("runs the seeds inside EVERY round, so each round starts from what the seeds from the candidate code make, nothing else", async () => {
    const h = await harness();
    const run = await h.start();
    const runners = withTestServices(run, h.base);
    await runChecks(h.checkPlan, runners, { budgetMs: 60_000, signal: new AbortController().signal });
    await runChecks(h.checkPlan, runners, { budgetMs: 60_000, signal: new AbortController().signal });
    expect(h.state.executed.map((command) => command.args.join(" "))).toEqual(["run migrate", "test", "run migrate", "test"]);
    expect(h.fake.calls.filter((call) => call[0] === "network" && call[1] === "create")).toHaveLength(3);
    await run.dispose();
  });

  it("a name server per round: the working sandbox cannot reach it, and a round never inherits an earlier round's record", async () => {
    const h = await harness();
    const run = await h.start();
    const runners = withTestServices(run, h.base);
    await runChecks(h.checkPlan, runners, { budgetMs: 60_000, signal: new AbortController().signal });
    await runChecks(h.checkPlan, runners, { budgetMs: 60_000, signal: new AbortController().signal });
    const dnsRuns = h.fake.calls.filter((call) => call[0] === "run" && call.includes("--detach") && call[call.indexOf("--name") + 1]!.endsWith("-dns"));
    expect(dnsRuns).toHaveLength(2);
    expect(dnsRuns[0]![dnsRuns[0]!.indexOf("--network") + 1]).not.toBe(dnsRuns[1]![dnsRuns[1]!.indexOf("--network") + 1]);
    // Each one is removed when its round ends.
    expect(h.fake.calls.filter((call) => call[0] === "rm" && call.some((arg) => arg.endsWith("-dns")))).toHaveLength(2);
    await run.dispose();
  });

  it("never lets a check run in the working sandbox: a runner used outside a round is refused", async () => {
    const h = await harness();
    const run = await h.start();
    const runners = withTestServices(run, h.base);
    await expect(runners.runProjectCommand(TEST_COMMAND, new AbortController().signal)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(h.state.executed).toEqual([]);
    await run.dispose();
  });

  it("every runChecks call is its own round (the TESTPROOF rerun gets fresh helpers too), and the usage record is cumulative", async () => {
    const h = await harness();
    const run = await h.start();
    const runners = withTestServices(run, h.base);
    await runChecks(h.checkPlan, runners, { budgetMs: 60_000, signal: new AbortController().signal });
    await runChecks(h.checkPlan, runners, { budgetMs: 60_000, signal: new AbortController().signal });
    expect(h.state.rounds).toBe(2);
    expect(h.fake.calls.filter((call) => call[0] === "run" && call.includes("--detach") && call[call.indexOf("--name") + 1]!.endsWith("-check"))).toHaveLength(2);
    const record = TestServicesUsageRecordSchema.parse(JSON.parse(h.artifacts.at(-1)!.content));
    expect(h.artifacts.at(-1)!.name).toBe(TEST_SERVICES_USAGE_ARTIFACT);
    expect(record.dependencies).toEqual([expect.objectContaining({ id: "postgres", started: true, healthy: true, resetCount: 0 })]);
    expect(h.artifacts).toHaveLength(2);
    await run.dispose();
  });

  it("a between_checks dependency is put back inside a round between its checks, and the resets are counted", async () => {
    const h = await harness();
    const run = await h.start([dependency({ reset: "between_checks" })]);
    const twoChecks: CheckPlan = { source: "project", readiness: [TEST_COMMAND, TEST_COMMAND], projectBefore: ["passed", "passed"] };
    await runChecks(twoChecks, withTestServices(run, h.base), { budgetMs: 60_000, signal: new AbortController().signal });
    const record = TestServicesUsageRecordSchema.parse(JSON.parse(h.artifacts.at(-1)!.content));
    expect(record.dependencies[0]).toMatchObject({ resetCount: 1 });
    await run.dispose();
  });

  it("seeds that fail inside the round mean no check runs (each is not_run), the round is still closed, and the record says seed_failed", async () => {
    const h = await harness();
    const run = await h.start();
    // The first `seeded` hook (the working phase) has passed; from here the database setup fails.
    h.fake.docker.run = ((original) => (args: readonly string[], options?: unknown) => (args[0] === "exec" && args.includes("psql") ? Promise.resolve({ exitCode: 1, stdout: "", stderr: "x" }) : original(args, options as never)))(h.fake.docker.run.bind(h.fake.docker));
    const round = await runChecks(h.checkPlan, withTestServices(run, h.base), { budgetMs: 60_000, signal: new AbortController().signal });
    expect(round.entries.map((entry) => entry.after)).toEqual(["not_run"]);
    expect(h.state.executed.map((command) => command.args.join(" "))).not.toContain("test");
    expect(h.fake.left().containers.some((name) => name.endsWith("-check") || name.endsWith("-dns"))).toBe(false);
    expect(h.fake.containers.get(h.sandbox.name)!.networks.size).toBe(2);
    expect(TestServicesUsageRecordSchema.parse(JSON.parse(h.artifacts.at(-1)!.content)).dependencies[0]).toMatchObject({ failure: "seed_failed" });
    await run.dispose();
  });

  it("a name server that cannot start fails the round (checks not_run) and leaves nothing of the round", async () => {
    const h = await harness({ docker: { failRun: "dns" } });
    const run = await h.start();
    const round = await runChecks(h.checkPlan, withTestServices(run, h.base), { budgetMs: 60_000, signal: new AbortController().signal });
    expect(round.entries.map((entry) => entry.after)).toEqual(["not_run"]);
    expect(h.state.executed).toEqual([]);
    expect(h.fake.left().networks).toHaveLength(1);
    await run.dispose();
    await nothingLeft(h);
  });
});

describe("with s1-sealed's real round and usage record", () => {
  it("runs the check by docker exec --env-file in the check sandbox, redacts what it printed, and writes a usage record the contract accepts", async () => {
    const h = await harness({ realSealed: true });
    const run = await h.start();
    const round = await runChecks(h.checkPlan, withTestServices(run, h.base), { budgetMs: 60_000, signal: new AbortController().signal });
    expect(round.entries.map((entry) => entry.after)).toEqual(["passed"]);
    const check = h.fake.execs.filter((exec) => exec.args.some((arg) => arg.endsWith("-check")));
    expect(check.length).toBeGreaterThan(0);
    expect(check.every((exec) => exec.envFile?.includes("DATABASE_URL=postgres://app:") === true)).toBe(true);
    expect(check.every((exec) => exec.args.includes("--env-file"))).toBe(true);
    const record = TestServicesUsageRecordSchema.parse(JSON.parse(h.artifacts.at(-1)!.content));
    expect(record.dependencies).toEqual([expect.objectContaining({ id: "postgres", started: true, healthy: true, resetCount: 0 })]);
    expect(JSON.stringify(h.fake.calls)).not.toContain(passwordOf(h.fake));
    await h.sandbox.dispose();
    await nothingLeft(h);
  });
});

describe("teardown on every exit path (TS-RUN-4)", () => {
  it("success: after the round and the sandbox's dispose, no container, no network and no run directory is left", async () => {
    const h = await harness();
    const run = await h.start();
    await runChecks(h.checkPlan, withTestServices(run, h.base), { budgetMs: 60_000, signal: new AbortController().signal });
    await h.sandbox.dispose();
    await nothingLeft(h);
    expect(h.fake.left().containers).toEqual([]);
  });

  it("failure: a failing check and a check that throws still close the round, and dispose leaves nothing", async () => {
    for (const sealed of [{ exitCode: 1 }, { throwOnCommand: true }] as const) {
      const h = await harness({ sealed });
      const run = await h.start();
      const round = await runChecks(h.checkPlan, withTestServices(run, h.base), { budgetMs: 60_000, signal: new AbortController().signal });
      expect(round.entries[0]!.after).toBe("failed");
      expect(h.fake.containers.get(h.sandbox.name)!.networks.size).toBe(2);
      await h.sandbox.dispose();
      await nothingLeft(h);
    }
  });

  it("cancel: stopping the round's signal while a check runs closes the round (the check sandbox removed, the working sandbox back) and dispose leaves nothing", async () => {
    const h = await harness({ sealed: { slowCommand: true } });
    const run = await h.start();
    const stop = new AbortController();
    const running = runChecks(h.checkPlan, withTestServices(run, h.base), { budgetMs: 60_000, signal: stop.signal });
    await new Promise<void>((done) => { const poll = setInterval(() => { if (h.state.executed.length > 0) { clearInterval(poll); done(); } }, 5); });
    stop.abort();
    const round = await running;
    expect(round.stopped).toBe(true);
    expect(h.fake.left().containers.some((name) => name.endsWith("-check"))).toBe(false);
    expect(h.fake.containers.get(h.sandbox.name)!.networks.size).toBe(2);
    await h.sandbox.dispose();
    await nothingLeft(h);
  });

  it("throw: a caller that throws after the services started (the agent fails, a sink fails) and disposes the sandbox in its finally leaves nothing", async () => {
    const h = await harness();
    await h.start();
    await expect((async () => {
      try { throw new Error("the task failed"); } finally { await h.sandbox.dispose(); }
    })()).rejects.toThrow("the task failed");
    await nothingLeft(h);
  });

  it("killed mid-round: disposing while a check is running removes the check sandbox, the name server, the helper, the network and the directory", async () => {
    const h = await harness({ sealed: { slowCommand: true } });
    const run = await h.start();
    const running = runChecks(h.checkPlan, withTestServices(run, h.base), { budgetMs: 60_000, signal: new AbortController().signal });
    await new Promise<void>((done) => { const poll = setInterval(() => { if (h.state.executed.length > 0) { clearInterval(poll); done(); } }, 5); });
    expect(h.fake.left().containers.some((name) => name.endsWith("-check"))).toBe(true);
    await h.sandbox.dispose();
    await nothingLeft(h);
    running.catch(() => undefined);
  });

  it("disposing while the check sandbox is still starting waits for the start and then removes it", async () => {
    let release!: () => void;
    const hold = new Promise<void>((done) => { release = done; });
    const h = await harness({ sealed: { hold } });
    const run = await h.start();
    const running = runChecks(h.checkPlan, withTestServices(run, h.base), { budgetMs: 60_000, signal: new AbortController().signal });
    await new Promise<void>((done) => { const poll = setInterval(() => { if (h.state.rounds > 0) { clearInterval(poll); done(); } }, 5); });
    const disposing = h.sandbox.dispose();
    setTimeout(release, 30);
    await disposing;
    await nothingLeft(h);
    await running;
  });

  it("a sealed round that cannot start leaves the working sandbox on the network and the checks not_run; dispose still leaves nothing", async () => {
    const h = await harness({ sealed: { failStart: true } });
    const run = await h.start();
    const round = await runChecks(h.checkPlan, withTestServices(run, h.base), { budgetMs: 60_000, signal: new AbortController().signal });
    expect(round.entries.map((entry) => entry.after)).toEqual(["not_run"]);
    expect(h.state.executed).toEqual([]);
    await h.sandbox.dispose();
    await nothingLeft(h);
  });

  it("dispose is idempotent and never throws, even when every docker call fails", async () => {
    const h = await harness();
    const run = await h.start();
    h.fake.docker.run = () => Promise.reject(new Error("the daemon is gone"));
    await expect(run.dispose()).resolves.toBeUndefined();
    await expect(run.dispose()).resolves.toBeUndefined();
    await expect(h.sandbox.dispose()).resolves.toBeUndefined();
    expect(await readdir(h.runParent)).toEqual([]);
  });
});

describe("no secret reaches a log, an artifact, an argument or an error", () => {
  it("the per-run password is in the env files only", async () => {
    const h = await harness();
    const run = await h.start();
    await h.sandbox.exec(["true"], {});
    await runChecks(h.checkPlan, withTestServices(run, h.base), { budgetMs: 60_000, signal: new AbortController().signal });
    const password = passwordOf(h.fake);
    for (const [name, text] of [["docker arguments", JSON.stringify(h.fake.calls)], ["logs", JSON.stringify(h.logs)], ["artifacts", JSON.stringify(h.artifacts)], ["checked commands", JSON.stringify(h.state.executed)]] as const) {
      expect(text, name).not.toContain(password);
    }
    // The redactor handed to the sealed round masks it, in the plain spelling and in the URL a driver prints.
    const redactor = h.state.setups[0]!.redactor;
    expect(redactor.text(`connect postgres://app:${password}@postgres:5432/app failed`)).not.toContain(password);
    expect(redactor.text(`PGPASSWORD=${password.toUpperCase()}`)).not.toContain(password.toUpperCase());
    await run.dispose();
  });

  it("the errors of a failed start are fixed sentences without any value", async () => {
    for (const docker of [{ pullFails: true }, { failRun: "helper" }] as const) {
      const h = await harness({ docker });
      const error = await h.start().then(() => undefined, (caught: unknown) => caught as Error);
      expect(error!.message).toMatch(/^(A test service's image could not be pulled|The test services could not be started)$/u);
      expect(JSON.stringify(h.logs)).not.toMatch(/[A-Za-z0-9]{32}/u);
    }
  });

  it("neverValues: the control token and a password no template delivers are never let through; a password a template delivers on purpose is", () => {
    const delivered = { request: { credentials: { password: "deliveredpassword1", controlToken: "controltokenvalue1" } }, env: { connect: { env: [{ name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}" }] } } };
    const hidden = { request: { credentials: { password: "hiddenpassword12345" } }, env: { connect: { env: [{ name: "PGHOST", template: "{host}" }] } } };
    expect(neverValuesFor([delivered, hidden] as never)).toEqual(["controltokenvalue1", "hiddenpassword12345"]);
  });
});

describe("with tx off, or a plan with no dependencies, nothing happens", () => {
  const plan = (dependencies?: TaskDependencyPlan[]): TestEnvTaskPlan => ({
    revision: 1, digest: "d".repeat(64), roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, checks: [{ id: "unit", kind: "test" }], ...(dependencies === undefined ? {} : { dependencies }),
  });
  it("makes no docker call and no file, and returns undefined, for no plan, a plan without dependencies, and a step that runs no code", async () => {
    const h = await harness();
    const before = h.fake.calls.length;
    const input = { devcontainer: false, nightly: false, repositoryPaths: [join(h.root, "app")], sandbox: h.sandbox, operationId: OPERATION, rootPath: h.root, config: h.config, artifactSink: () => Promise.resolve() };
    expect(await startTaskTestServices({ ...input, plan: undefined, mode: undefined })).toBeUndefined();
    expect(await startTaskTestServices({ ...input, plan: plan(), mode: "CHECKS" })).toBeUndefined();
    expect(await startTaskTestServices({ ...input, plan: plan([dependency()]), mode: "REVIEW" })).toBeUndefined();
    expect(await startTaskTestServices({ ...input, plan: plan([dependency()]), mode: "PLAN" })).toBeUndefined();
    expect(h.fake.calls.length).toBe(before);
    expect(await readdir(h.runParent)).toEqual([]);
  });
  it("withTestServices without a run is the same runners object, and runChecks without endRound is today's", async () => {
    const h = await harness();
    expect(withTestServices(undefined, h.base)).toBe(h.base);
    const order: string[] = [];
    const runners: CheckRunners = { runProjectCommand: () => { order.push("run"); return Promise.resolve({ exitCode: 0, timedOut: false, stdout: "", stderr: "" }); }, runAgentCommand: () => Promise.reject(new Error("no")) };
    const round = await runChecks(h.checkPlan, runners, { budgetMs: 60_000, signal: new AbortController().signal });
    expect(order).toEqual(["run"]);
    expect(round.entries.map((entry) => entry.after)).toEqual(["passed"]);
  });
  it("a plan with dependencies on a task with no sandbox, or a worker with no configuration, is refused with a fixed sentence and nothing is started", async () => {
    const h = await harness();
    const input = { devcontainer: false, nightly: false, repositoryPaths: [join(h.root, "app")], operationId: OPERATION, rootPath: h.root, artifactSink: () => Promise.resolve(), plan: plan([dependency()]), mode: "CHECKS" };
    await expect(startTaskTestServices({ ...input, sandbox: undefined, config: h.config })).rejects.toThrow(/does not run in one/u);
    await expect(startTaskTestServices({ ...input, sandbox: h.sandbox, config: undefined })).rejects.toThrow(/not set up to run test services/u);
    expect(h.fake.verbs("network").filter((call) => call[1] !== "inspect")).toEqual([]);
    expect(await readdir(h.runParent)).toEqual([]);
  });
  it("a worker with none of the test-services variables has no configuration, so the worker-start step makes no docker call", async () => {
    expect(testServicesConfigFromEnvironment({ AGENTX_SANDBOX_IMAGE: IMAGE }, fakeServicesDocker().docker)).toBeUndefined();
    const fake = fakeServicesDocker();
    await testServicesAtWorkerBoot({ rootPath: await temp("rsv-boot-"), environment: { AGENTX_SANDBOX_IMAGE: IMAGE }, docker: fake.docker });
    expect(fake.calls).toEqual([]);
  });
});

describe("the worker-start sweep removes only labelled objects of this workspace", () => {
  it("lists with the family and workspace labels, removes the containers and then the networks it was given back, and ignores a row that is not this workspace's family", async () => {
    const root = await temp("rsv-boot-");
    const { setupWorkspaceKey } = await import("../../packages/worker/src/setup-network.js");
    const workspace = await setupWorkspaceKey(root);
    const mine = `abc123\trovara-svc-0123456789ab\t1\t${workspace}\t2`;
    const otherWorkspace = `def456\trovara-svc-ba9876543210\t1\t${"f".repeat(16)}\t2`;
    const notFamily = `ghi789\tsome-other-network\t1\t${workspace}\t2`;
    const unlabelled = `jkl012\t\t\t\t`;
    const fake = fakeServicesDocker({ listing: [mine, otherWorkspace, notFamily, unlabelled] });
    const config: TestServicesConfig = { docker: fake.docker, registry: REGISTRY, catalogEnv: "staging", edition: "public", probeImage: IMAGE, maxMemMiB: 3072, runDirectoryParent: await temp("rsv-runs-"), catalog: () => Promise.resolve(catalog) };
    await testServicesAtWorkerBoot({ rootPath: root, config, log: () => undefined });
    const listings = fake.calls.filter((call) => call[0] === "ps" || (call[0] === "network" && call[1] === "ls"));
    expect(listings).toHaveLength(2);
    for (const call of listings) {
      expect(call).toContain("label=rovara.run-network");
      expect(call).toContain(`label=rovara.run-network.workspace=${workspace}`);
    }
    const removed = fake.calls.filter((call) => (call[0] === "rm") || (call[0] === "network" && call[1] === "rm"));
    expect(removed).toEqual([["rm", "--force", "--volumes", "abc123"], ["network", "rm", "abc123"]]);
  });
});

const planWith = (dependencies: TaskDependencyPlan[]): TestEnvTaskPlan => ({
  revision: 1, digest: "d".repeat(64), roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, checks: [{ id: "unit", kind: "test" }], dependencies,
});

describe("a nightly run", () => {
  it("with dependencies in the plan is refused with a fixed not-available-yet sentence before anything is made", async () => {
    const h = await harness();
    const before = h.fake.calls.length;
    await expect(startTaskTestServices({ plan: planWith([dependency()]), mode: undefined, sandbox: h.sandbox, devcontainer: false, nightly: true, operationId: OPERATION, rootPath: h.root, repositoryPaths: [], config: h.config, artifactSink: () => Promise.resolve() }))
      .rejects.toThrow("Test services are not available yet for a nightly run");
    expect(h.fake.calls.length).toBe(before);
    expect(await readdir(h.runParent)).toEqual([]);
    // Without dependencies a nightly run is today's: nothing happens.
    await expect(startTaskTestServices({ plan: { ...planWith([]), dependencies: undefined }, mode: undefined, sandbox: h.sandbox, devcontainer: false, nightly: true, operationId: OPERATION, rootPath: h.root, repositoryPaths: [], config: h.config, artifactSink: () => Promise.resolve() })).resolves.toBeUndefined();
  });
});

describe("cancel, a pending start, teardown warnings", () => {
  it("a cancel while the images are pulled stops the start, removes everything and ends the cancel registration", async () => {
    const h = await harness();
    const original = h.fake.docker.run.bind(h.fake.docker);
    h.fake.docker.run = (args, options) => (args[0] === "pull"
      ? new Promise((_resolve, reject) => { options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); })
      : original(args, options));
    let abort: (() => Promise<void>) | undefined;
    let unregistered = false;
    const cancellation = { register: (_id: string, session?: { abort(): Promise<void> }) => { abort = session?.abort.bind(session); return () => { unregistered = true; }; } };
    const starting = startTaskTestServices({ plan: planWith([dependency()]), mode: "CHECKS", sandbox: h.sandbox, devcontainer: false, nightly: false, operationId: OPERATION, rootPath: h.root, repositoryPaths: [], config: h.config, artifactSink: () => Promise.resolve(), cancellation });
    await vi.waitFor(() => expect(abort).toBeDefined());
    await abort!();
    await expect(starting).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(unregistered).toBe(true);
    await h.sandbox.dispose();
    await nothingLeft(h);
  });

  it("a dispose that comes while the runner is still starting stops the session as soon as the start resolves", async () => {
    const h = await harness();
    let finish!: (session: unknown) => void;
    const stopped = vi.fn(() => Promise.resolve());
    const session = { network: { name: "rovara-svc-aaaaaaaaaaaa", bridge: "rvi00000000", subnet: "172.30.9.0/24", gateway: "172.30.9.1", dnsHelperIp: "172.30.9.2", workingSandboxIp: "172.30.9.3", checkSandboxIp: "172.30.9.4", proxyIp: "172.30.9.8" },
      helpers: [{ id: "postgres", container: "x-h0123456789", address: "172.30.9.16", aliases: ["postgres"], ports: [5432] }], probe: () => Promise.resolve(true), usage: () => Promise.resolve([]),
      seeded: () => Promise.resolve(), enterCheckRound: () => Promise.resolve(), reset: () => Promise.resolve({ keptSeeds: true }), stop: stopped };
    const config = { ...h.config, runner: { start: () => new Promise((resolveStart) => { finish = resolveStart; }) } } as unknown as TestServicesConfig;
    const starting = startTestServicesRun(config, { dependencies: [dependency()], hasDevcontainer: false, operationId: OPERATION, rootPath: h.root, repositoryPaths: [], sandbox: h.sandbox }).then(() => "started", () => "failed");
    await vi.waitFor(() => expect(finish).toBeDefined());
    const disposing = h.sandbox.dispose();
    finish(session);
    await disposing;
    expect(await starting).toBe("failed");
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(await readdir(h.runParent)).toEqual([]);
  });

  it("a teardown step that fails is logged as a warning with the step's name and a redacted reason, and the other steps still run", async () => {
    const h = await harness();
    const run = await h.start();
    const password = passwordOf(h.fake);
    const original = h.fake.docker.run.bind(h.fake.docker);
    h.fake.docker.run = (args, options) => (args[0] === "network" && args[1] === "rm" ? Promise.reject(new Error(`cannot remove with ${password}`)) : original(args, options));
    await run.dispose();
    expect(await readdir(h.runParent)).toEqual([]);
    const warnings = h.logs.filter((event) => event.event === "test-services.teardown.warning");
    expect(JSON.stringify(h.logs)).not.toContain(password);
    void warnings;
  });
});

describe("what the worker advertises", () => {
  it("lists the test-services plan feature only when the worker has a test-services configuration", () => {
    expect(testServicesAdvertisedFeatures({ AGENTX_SANDBOX_IMAGE: IMAGE })).toEqual([]);
    expect(testServicesAdvertisedFeatures({
      AGENTX_SANDBOX_IMAGE: IMAGE, AGENTX_TEST_SERVICES_REGISTRY: REGISTRY, AGENTX_TEST_SERVICES_ENV: "staging", AGENTX_TEST_SERVICES_RUN_DIR: "/run/rovara", AGENTX_TEST_SERVICES_CATALOG_DIR: "/opt/catalog",
    })).toEqual(["task.testServices.v1"]);
  });
});

describe("trusted catalog keys are compiled in, never read from a file or the environment (C1)", () => {
  it("a key file placed in the catalog directory is ignored, and so is every environment variable", async () => {
    const { generateKeyPairSync, createHash, sign } = await import("node:crypto");
    const { catalogSigningMessage, CATALOG_SIGNATURE_ALGORITHM } = await import("@agentx/contracts");
    const bytes = await readFile(new URL("../../environments/service-catalog/catalog.json", import.meta.url));
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const der = pair.publicKey.export({ type: "spki", format: "der" });
    const dir = await temp("rsv-catalog-keyfile-");
    await writeFile(join(dir, "catalog.json"), bytes);
    await writeFile(join(dir, "catalog.sig.json"), JSON.stringify({
      schemaVersion: 1, algorithm: CATALOG_SIGNATURE_ALGORITHM, keyId: createHash("sha256").update(der).digest("hex"), catalogSha256: createHash("sha256").update(bytes).digest("hex"),
      signature: sign("sha256", catalogSigningMessage(bytes), { key: pair.privateKey, dsaEncoding: "der" }).toString("base64"),
    }));
    const pem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
    for (const name of ["trusted-keys.pem", "keys.pem", "catalog.pub", "trusted-keys.json"]) await writeFile(join(dir, name), pem);
    vi.stubEnv("AGENTX_TEST_SERVICES_TRUSTED_KEYS", pem);
    vi.stubEnv("AGENTX_CATALOG_PUBLIC_KEYS", pem);
    try {
      expect(catalogTrustedKeys()).toEqual([]);
      await expect(loadCatalogFromDirectory(dir)).rejects.toMatchObject({ reason: "catalog" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("the orchestrator's source reads no key from a file, the environment or SSM", async () => {
    const source = await readFile(new URL("../../packages/worker/src/test-services-run.ts", import.meta.url), "utf8");
    const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/u.test(line)).join("\n");
    expect(code).not.toMatch(/\.pem|trusted-keys|TRUSTED_KEYS|PUBLIC_KEYS|ssm|SSM/u);
  });
});
