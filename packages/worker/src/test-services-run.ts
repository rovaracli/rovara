// Test services, slice 1 (design test-services.md 4.0 and 8; round plan ROUND-2026-11-03-test-services-hookup.md, s1-worker-round T1): the orchestrator that turns a task's pinned dependency plan into a running set of real
// services for the whole task, and puts the pieces built earlier together:
//
//   - the helpers (service-helpers.ts) start through the ServiceRunner (service-runner.ts) on the run's own services network, from images the worker's own signed catalog pins (the plan's digest must AGREE with it);
//   - the WORKING sandbox joins the services network at .3 and every command it runs gets the run's connection variables LAST, as an env file (service-env.ts), so a repository's own `DATABASE_URL` never wins;
//   - the seeds run once the helpers are healthy (`seedRun`), in the working sandbox;
//   - every official check round (the normal round, the CHECKS retry, the TESTPROOF rerun, the baseline scans: all of them go through `runChecks`) is SEALED: the working sandbox leaves the network, the sealed check
//     sandbox starts only through s1-sealed's `withSealedCheckRound` (= `withDetachedWorking`), the helpers are put back to their seeded state first, and the sandbox is removed and the working sandbox put back when
//     `runChecks` returns, whatever happened (`CheckRunners.endRound`);
//   - the run is torn down on every exit path (TS-RUN-4): `TaskSandbox.dispose()` calls `teardown()` first, and run-task disposes its sandboxes in a `finally`, so success, failure, cancel and a throw all end the same way: the
//     check sandbox and the sealed name server removed, the sandbox off the network, the helpers and the network removed, the run's directory deleted. A killed worker leaves labelled objects only; the worker-start sweep
//     (`testServicesAtWorkerBoot`, TS-RN-3 rule 3) removes those, and nothing that is not labelled.
//
// Rules this module keeps, each with a test (tests/unit/worker-test-services-run.test.ts):
//   - NOTHING HAPPENS WITHOUT A PLAN WITH DEPENDENCIES. With `tx` off the broker sends none; `startTaskTestServices` returns undefined at once (no Docker call, no file), `withTestServices(undefined, runners)` is the same object,
//     and `testServicesAtWorkerBoot` does nothing when the worker is not configured for test services.
//   - NO SECRET IN ANY LOG, ARGUMENT OR ERROR. A per-run password is made here, used in the env files (0600, on the run's tmpfs directory, removed after each exec) and nowhere else; `helperSecretValues` goes to the redactor, and
//     to `neverValues` except for a password that a connection template deliberately delivers to the sandbox (service-env.ts refuses a variable that holds a never value). Every error this module throws is a fixed sentence.
//   - FAIL CLOSED. A worker without the sealed round (s1-sealed) or without configuration refuses a plan with dependencies before it starts anything. A dependency whose repository, digest or family differs from the worker's
//     signed catalog is refused. A check that is asked for with no sealed round open is refused (it never falls back to the working sandbox).
//
// WHAT IS NOT HERE (listed in the lane report): fixture seeds (`seeds[].fixturePath`: refused, "not available yet"), a sinkhole container (slice 3: the sealed name server still counts every unknown name, which is what the
// usage record reads), Prove's use of this module (T2, prepare.ts), and any backing but `local` (the plan schema allows only that).
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, readFile, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  CATALOG_FILE, CATALOG_REGISTRY_ROOT, CATALOG_SIGNATURE_FILE, TestServicesUsageRecordSchema, agentXError, catalogEntryById, catalogRepositoryName, loadSignedCatalog,
  type CatalogEdition, type CatalogEntry, type ServiceCatalog, type TaskDependencyPlan, type TestEnvTaskPlan, type TestServicesStartFailure, type TestServicesUsageRecord,
} from "@agentx/contracts";
import { TASK_SANDBOX_IMAGE_ENVIRONMENT, type TaskSandbox } from "./task-sandbox.js";
import { SANDBOX_TARGET, executionFor } from "./execution-target.js";
import type { ArtifactSink } from "./artifacts.js";
import {
  checkSandboxPlan, writeCheckSandboxFiles,
  type CheckSandboxNetwork, type CheckSandboxPlan,
} from "./check-sandbox.js";
import type { ContainerExec } from "./devcontainer.js";
import { runNetworkHelperIp, runNetworkLabelArgs, servicesNetworkStaleAfterMs } from "./run-network.js";
import {
  HELPER_CREDENTIAL_PATTERNS, HelperStartError, sweepServicesNetworksAtWorkerStart,
  type HelperFiles, type HelperRequest,
} from "./service-helpers.js";
import {
  buildServiceEnvironment, createRunDirectoryFiles, createServiceRedactor, helperSecretValues, removeRunDirectory, withServiceEnvFile,
  type ServiceEnvDependency, type ServiceEnvironment, type ServiceRedactor,
} from "./service-env.js";
import { freshHelpers, createResetHooks, resetForNextCheck, seedRun, type ResetDependency, type SeedPorts } from "./service-reset.js";
import {
  createDockerServiceRunner, type SandboxAttachment, type ServiceRunner, type ServiceSession,
} from "./service-runner.js";
import { SEALED_ROUND_PORTS } from "./test-services-sealed.js";
import { refuseTestServicesWithDevcontainer } from "./check-round-runners.js";
import { countResets } from "./service-usage-record.js";
import { loadPrepullList, prepullCatalogImages, type PrepullPorts } from "./service-prepull.js";
import { setupWorkspaceKey } from "./setup-network.js";
import { createDockerCli, type DockerCli } from "./swebench/containers.js";
import type { CheckRunners } from "./verification/checks.js";
import { hiddenWorkspaceDirectories } from "./workspace-state.js";

/** The artifact the usage record is written to after every sealed round (latest wins). s1-broker's evidence step reads it by this name. */
export const TEST_SERVICES_USAGE_ARTIFACT = "test-services-usage.json";
/**
 * How long the run's objects count as live for OTHER runs' allocation sweeps: they remove an object only once its own expiry has come (run-network.ts). A task can code for hours, so the budget stamped on a task's
 * run is generous (12 hours); a killed worker's leftovers go at the worker-start sweep, not at this expiry.
 */
export const TEST_SERVICES_RUN_LIFETIME_MS = 12 * 60 * 60_000;
const DOCKER_CALL_TIMEOUT_MS = 60_000;
const PULL_TIMEOUT_MS = 5 * 60_000;
const SEED_LIMIT_MS = 10 * 60_000;
/** Slice 1 has no sinkhole container; the sealed name server needs an address for it, and this one belongs to no helper (the last of the 32). */
const SINKHOLE_HELPER_INDEX = 31;
const SINKHOLE_URL = "http://sinkhole";
const DEFAULT_USER = "rovara";
const DEFAULT_DATABASE = "app";
const DEFAULT_MAX_MEM_MIB = 3072;
const MODES_WITH_SERVICES: ReadonlySet<string | undefined> = new Set([undefined, "IMPLEMENT", "CHECKS"]);

// ---- errors

export type TestServicesFailureReason =
  | "not_configured" | "unsupported" | "init_file" | "catalog" | "mismatch" | "sealed_unavailable" | "pull_failed" | "start_failed" | "not_healthy" | "seed_failed" | "setup_failed";

const SENTENCES: Record<TestServicesFailureReason, string> = {
  not_configured: "This worker is not set up to run test services",
  init_file: "A test service's init file is not a plain SQL file inside the workspace",
  unsupported: "Test services need the task sandbox, and this task does not run in one",
  catalog: "The test services catalog could not be used",
  mismatch: "A test service in the plan is not the one this worker's catalog pins",
  sealed_unavailable: "This worker cannot run sealed check rounds, so it did not start the test services",
  pull_failed: "A test service's image could not be pulled",
  start_failed: "The test services could not be started",
  not_healthy: "A test service did not become healthy",
  seed_failed: "A test service's seeds did not complete",
  setup_failed: "The sealed check round's name server could not be set up",
};

/** The one error of this module. `message` is a fixed sentence (never a command's output, a path or a value); `failures` is what the usage record says per dependency. */
export class TestServicesError extends Error {
  constructor(readonly reason: TestServicesFailureReason, readonly failures: ReadonlyMap<string, TestServicesStartFailure> = new Map()) {
    super(SENTENCES[reason]);
    this.name = "TestServicesError";
  }
}

// ---- the ports and the configuration

/** What a sealed round needs from the caller (s1-sealed's `SealedCheckRoundInput`; `withSealedCheckRound` accepts exactly this). */
export interface SealedRoundSetup {
  docker: DockerCli;
  /** The project has a dev container: the round is refused. Always false here (a task with a dev container never starts services). */
  hasDevcontainer: boolean;
  plan: CheckSandboxPlan;
  rootPath: string;
  files: HelperFiles;
  environment: ServiceEnvironment;
  redactor: ServiceRedactor;
}

/** What the usage record is built from (s1-sealed's `ServiceUsageRecordInput`). */
export interface UsageRecordSetup {
  planned: readonly string[];
  session?: Pick<ServiceSession, "helpers" | "probe">;
  startMs?: ReadonlyMap<string, number> | number;
  resetCounts?: ReadonlyMap<string, number>;
  failures?: ReadonlyMap<string, TestServicesStartFailure>;
  dns?: { docker: DockerCli; dnsHelperName: string };
  redactor: ServiceRedactor;
}

/**
 * s1-sealed's two exports, as this module needs them. Until that lane is merged the worker has none (`config.sealedRound` is undefined and a plan with dependencies is refused before anything starts); after the merge,
 * `test-services-sealed.ts` binds them: `withSealedCheckRound` (check-round-runners.ts) and `buildServiceUsageRecord` (service-usage-record.ts). Tests stub them.
 */
export interface SealedRoundPorts {
  withSealedCheckRound<T>(input: SealedRoundSetup, round: (runners: CheckRunners) => Promise<T>): Promise<T>;
  buildServiceUsageRecord(input: UsageRecordSetup): Promise<unknown>;
}

export interface TestServicesConfig {
  docker: DockerCli;
  /** The install's registry host (and optional port). */
  registry: string;
  /** The named environment in `rovara-catalog/<env>/svc/...`. */
  catalogEnv: string;
  edition: CatalogEdition;
  /** The worker's own image (digest or id): the health probes and the sealed sandbox run from it. */
  probeImage: string;
  maxMemMiB: number;
  /** A directory on the worker's tmpfs, at the same path on the host (Docker bind-mounts from it), where each run's directory is made. */
  runDirectoryParent: string;
  /** The worker's verified catalog (`loadSignedCatalog`). */
  catalog(): Promise<ServiceCatalog>;
  sealedRound?: SealedRoundPorts;
  runner?: ServiceRunner;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** One JSON line per event, fixed words only. Default: the worker's console. */
  log?: (event: Record<string, unknown>) => void;
}

const defaultLog = (event: Record<string, unknown>): void => console.log(JSON.stringify({ component: "worker", ...event }));

// ---- the configuration a worker makes from its environment

export const TEST_SERVICES_REGISTRY_ENVIRONMENT = "AGENTX_TEST_SERVICES_REGISTRY";
export const TEST_SERVICES_ENV_ENVIRONMENT = "AGENTX_TEST_SERVICES_ENV";
export const TEST_SERVICES_RUN_DIR_ENVIRONMENT = "AGENTX_TEST_SERVICES_RUN_DIR";
export const TEST_SERVICES_CATALOG_DIR_ENVIRONMENT = "AGENTX_TEST_SERVICES_CATALOG_DIR";
export const TEST_SERVICES_EDITION_ENVIRONMENT = "AGENTX_TEST_SERVICES_EDITION";
export const TEST_SERVICES_MAX_MEM_ENVIRONMENT = "AGENTX_TEST_SERVICES_MAX_MEM_MIB";
/** The trusted catalog-signing public keys (PEM, one or more) in the catalog directory. */
export const TEST_SERVICES_TRUSTED_KEYS_FILE = "trusted-keys.pem";

/** The signed catalog from a directory holding `catalog.json`, `catalog.sig.json` and `trusted-keys.pem`. Throws a fixed error when any of the three is missing or the signature does not hold. */
export async function loadCatalogFromDirectory(directory: string): Promise<ServiceCatalog> {
  try {
    const [catalogBytes, signatureBytes, keys] = await Promise.all([
      readFile(join(directory, CATALOG_FILE)), readFile(join(directory, CATALOG_SIGNATURE_FILE)), readFile(join(directory, TEST_SERVICES_TRUSTED_KEYS_FILE), "utf8"),
    ]);
    const trustedKeys = keys.split(/(?<=-----END [A-Z ]+-----)/u).map((block) => block.trim()).filter((block) => block.startsWith("-----BEGIN"));
    const loaded = loadSignedCatalog({ catalogBytes, signatureBytes, trustedKeys });
    if (!loaded.ok) throw new Error("catalog");
    return loaded.catalog;
  } catch {
    throw new TestServicesError("catalog");
  }
}

/**
 * The worker's configuration for test services, or undefined when it has none (every variable that is needed must be set; a worker with `tx` off has none of them, so it never makes a Docker call for this). The sealed
 * ports come from `test-services-sealed.ts`. The probe image is the sandbox image (boot.sh sets it to the worker's own image).
 */
export function testServicesConfigFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env, docker: DockerCli = createDockerCli(), roundPorts: SealedRoundPorts | undefined = SEALED_ROUND_PORTS,
): TestServicesConfig | undefined {
  const registry = environment[TEST_SERVICES_REGISTRY_ENVIRONMENT];
  const catalogEnv = environment[TEST_SERVICES_ENV_ENVIRONMENT];
  const runDirectoryParent = environment[TEST_SERVICES_RUN_DIR_ENVIRONMENT];
  const catalogDirectory = environment[TEST_SERVICES_CATALOG_DIR_ENVIRONMENT];
  const probeImage = environment[TASK_SANDBOX_IMAGE_ENVIRONMENT];
  if (!registry || !catalogEnv || !runDirectoryParent || !catalogDirectory || !probeImage) return undefined;
  const edition = environment[TEST_SERVICES_EDITION_ENVIRONMENT] === "enterprise" ? "enterprise" : "public";
  const mem = Number(environment[TEST_SERVICES_MAX_MEM_ENVIRONMENT] ?? DEFAULT_MAX_MEM_MIB);
  return {
    docker, registry, catalogEnv, edition, probeImage, runDirectoryParent, maxMemMiB: Number.isSafeInteger(mem) && mem > 0 ? mem : DEFAULT_MAX_MEM_MIB,
    catalog: () => loadCatalogFromDirectory(catalogDirectory), ...(roundPorts === undefined ? {} : { sealedRound: roundPorts }),
  };
}

// ---- the worker's start (TS-RN-3 rule 3 and TS19)

/**
 * Called once when the worker starts, before it takes any work: removes what a killed worker left (every container and network that carries the run-network family label AND this workspace's key, and nothing else), and
 * starts the catalog images' pre-pull in the background (bounded; it never holds the worker's start). A worker with no test services configuration does nothing at all. Never throws.
 */
export async function testServicesAtWorkerBoot(input: { rootPath: string; config?: TestServicesConfig | undefined; environment?: NodeJS.ProcessEnv; docker?: DockerCli; log?: (event: Record<string, unknown>) => void }): Promise<void> {
  const log = input.log ?? defaultLog;
  try {
    const config = input.config ?? testServicesConfigFromEnvironment(input.environment ?? process.env, input.docker ?? createDockerCli());
    if (config === undefined) return;
    const swept = await sweepServicesNetworksAtWorkerStart(config.docker, await setupWorkspaceKey(input.rootPath));
    if (swept.containers + swept.networks > 0) log({ event: "test-services.leftovers.removed", ...swept });
    const ports: PrepullPorts = {
      pull: async (reference, signal) => {
        const pulled = await config.docker.run(["pull", reference], { timeoutMs: PULL_TIMEOUT_MS, signal });
        if (pulled.exitCode !== 0) throw new Error("pull failed");
      },
      present: async (reference, signal) => (await config.docker.run(["image", "inspect", "--format", "{{.Id}}", reference], { timeoutMs: DOCKER_CALL_TIMEOUT_MS, signal })).exitCode === 0,
    };
    // Not awaited: the pre-pull is an optimisation and the worker takes work while it runs.
    void loadPrepullList()
      .then((list) => prepullCatalogImages({ list, registry: config.registry, env: config.catalogEnv, ports }))
      .then((result) => { if (result.pulled.length + result.failed.length > 0) log({ event: "test-services.prepull", pulled: result.pulled.length, failed: result.failed.length, skipped: result.skipped.length }); })
      .catch(() => log({ event: "test-services.prepull.failed" }));
  } catch {
    log({ event: "test-services.boot.failed" });
  }
}

// ---- the plan to helper requests and the run's environment

interface Resolved {
  plan: TaskDependencyPlan;
  entry: CatalogEntry;
  request: HelperRequest;
  env: ServiceEnvDependency;
  resetDependency: ResetDependency;
  image: string;
}

/** The most an init file may hold (the launcher's own limit for a helper's file). */
const INIT_FILE_MAX_BYTES = 1_048_576;
const INIT_FILE_FAMILIES: ReadonlySet<string> = new Set(["postgres", "mysql"]);

/**
 * A dependency's `config.initFiles` (init SQL from the repository), as files for ITS helper alone. The broker only checks that each is a relative path without `..`; a symlink inside the repository can still point anywhere,
 * so here each path is resolved to its real path, which must be a regular file INSIDE the workspace root (the root is already canonical), ending in `.sql` (the image runs a `.sh` it finds there), and small. It is opened
 * without following a link and read through that handle. The content goes into the launcher's `HelperRequest.files`: the launcher writes it to the run's directory and mounts it read-only into that one helper. Anything else
 * is one fixed error (`init_file`) and nothing has been started yet.
 */
async function initFilesOf(plan: TaskDependencyPlan, root: string): Promise<NonNullable<HelperRequest["files"]>> {
  const paths = plan.config.initFiles ?? [];
  if (paths.length === 0) return [];
  if (!INIT_FILE_FAMILIES.has(plan.family)) throw new TestServicesError("init_file");
  const files: Array<{ name: string; content: string; to: string }> = [];
  for (const [index, path] of paths.entries()) {
    try {
      const real = await realpath(resolve(root, path));
      if (!real.startsWith(`${root}${sep}`) || !real.endsWith(".sql")) throw new Error("outside");
      const handle = await open(real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > INIT_FILE_MAX_BYTES) throw new Error("not a plain file");
        const number = String(index + 1).padStart(2, "0");
        files.push({ name: `init-${number}.sql`, content: await handle.readFile("utf8"), to: `/docker-entrypoint-initdb.d/init-${number}.sql` });
      } finally {
        await handle.close();
      }
    } catch {
      throw new TestServicesError("init_file");
    }
  }
  return files;
}

const randomAlphanumeric = (length: number): string => randomBytes(length).toString("hex").slice(0, length);

/**
 * The plan's dependencies against the worker's own signed catalog: the plan names an entry, a repository and a digest, and the catalog must say the same (family, backing, pinned digest, edition, not retired). Anything else
 * is `mismatch`: the broker's plan is never trusted to name an image. Each helper gets a fresh per-run password; the user and the database come from the plan's config or fixed defaults, and must have the launcher's plain form.
 */
function resolveDependencies(catalog: ServiceCatalog, dependencies: readonly TaskDependencyPlan[], config: Pick<TestServicesConfig, "edition" | "registry" | "catalogEnv">): Resolved[] {
  return dependencies.map((plan) => {
    const entry = catalogEntryById(catalog, plan.catalogId);
    if (entry === undefined || entry.backing !== "local" || entry.status === "retired" || entry.family !== plan.family || !entry.editions.includes(config.edition)
      || entry.image.repository !== plan.repository || entry.image.digest !== plan.digest) throw new TestServicesError("mismatch");
    const user = plan.config.user ?? DEFAULT_USER;
    const database = plan.config.database ?? DEFAULT_DATABASE;
    if (!HELPER_CREDENTIAL_PATTERNS.user.test(user) || !HELPER_CREDENTIAL_PATTERNS.database.test(database)) throw new TestServicesError("mismatch");
    const aliases = plan.aliases.length > 0 ? [...plan.aliases] : [...entry.connect.defaultAliases];
    const host = aliases[0];
    const port = entry.run.ports[0];
    if (host === undefined || port === undefined) throw new TestServicesError("mismatch");
    const credentials = { user, password: randomAlphanumeric(32), database };
    return {
      plan, entry,
      request: { id: plan.id, name: plan.name, entry, aliases, credentials },
      env: { id: plan.id, host, port, credentials, connect: { env: plan.connect, hostAliases: aliases } },
      resetDependency: { id: plan.id, seeds: plan.seeds, reset: plan.reset },
      image: `${CATALOG_REGISTRY_ROOT}/${config.catalogEnv}/${plan.repository}@sha256:${plan.digest}`,
    };
  });
}

/**
 * The values the sandboxes' variables must never hold: every secret of the helpers (`helperSecretValues`) EXCEPT a password that one of the dependency's own connection templates delivers on purpose (`{password}` in
 * `DATABASE_URL`). The control token and a password no template uses are never let through.
 */
export function neverValuesFor(resolved: ReadonlyArray<Pick<Resolved, "request" | "env">>): string[] {
  return resolved.flatMap((item) => {
    const delivered = item.env.connect.env.some((variable) => variable.template.includes("{password}"));
    const password = item.request.credentials?.password;
    return helperSecretValues([{ credentials: { ...(delivered || password === undefined ? {} : { password }), ...(item.request.credentials?.controlToken === undefined ? {} : { controlToken: item.request.credentials.controlToken }) } }]);
  });
}

// ---- the working sandbox's place on the network

/**
 * The working sandbox joins the run's network at .3 and leaves it at the end. the sealed round takes it off the network again for every official check round
 * (`withDetachedWorking`, with proof), so `enterCheckRound` has nothing to do.
 */
function workingSandboxAttachment(docker: DockerCli, sandboxName: string): SandboxAttachment {
  let joined: { network: string; ip: string } | undefined;
  return {
    async attach(view) {
      const connected = await docker.run(["network", "connect", "--ip", view.workingSandboxIp, view.name, sandboxName], { timeoutMs: DOCKER_CALL_TIMEOUT_MS }).catch(() => undefined);
      if (connected === undefined || connected.exitCode !== 0) throw agentXError("RUNTIME_UNAVAILABLE", SENTENCES.start_failed);
      joined = { network: view.name, ip: view.workingSandboxIp };
    },
    async detach() {
      if (joined === undefined) return;
      await docker.run(["network", "disconnect", "--force", joined.network, sandboxName], { timeoutMs: DOCKER_CALL_TIMEOUT_MS }).catch(() => undefined);
    },
    // The sealed round detaches the working sandbox itself (withDetachedWorking, with proof) before `freshServices` runs, so there is nothing left to do here.
    enterCheckRound() { return Promise.resolve(); },
  };
}

/** `docker exec [--env-file F] [--env K=V ...] <sandbox> <command>`: the run's variables come from the env file, and a name the run sets is taken out of the command's own `env` (Docker lets `--env` win over `--env-file`). */
function workingExec(docker: DockerCli, files: HelperFiles, sandboxName: string, environment: ServiceEnvironment, active: () => boolean): (inner: ContainerExec) => ContainerExec {
  const owned = new Set(environment.entries.map(([name]) => name));
  const prefix = randomAlphanumeric(12);
  let counter = 0;
  return (inner) => async (command, options) => {
    if (!active()) return inner(command, options);
    counter += 1;
    const own = Object.entries(options.env ?? {}).filter(([name]) => !owned.has(name));
    return withServiceEnvFile(files, `wrk-${prefix}-${String(counter)}`, environment, (envFileArgs) => docker.run([
      "exec", ...envFileArgs, ...own.flatMap(([name, value]) => ["--env", `${name}=${value}`]), sandboxName, ...command,
    ], {
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onStdout === undefined ? {} : { onStdout: options.onStdout }),
      ...(options.onStderr === undefined ? {} : { onStderr: options.onStderr }),
    }));
  };
}

// ---- the run

export interface TestServicesRun {
  /** The dependency ids of the run, in the plan's order. */
  readonly ids: readonly string[];
  /** The runners of an official check round: sealed. `base` (the working sandbox's runners) is not used for any check. */
  checkRunners(base: CheckRunners): CheckRunners;
  /** The usage record as of now (health asked again, the name server's record read), or undefined when it cannot be built. */
  usageRecord(): Promise<TestServicesUsageRecord | undefined>;
  /** Tears the run down (idempotent, never throws). `TaskSandbox.dispose()` calls it. */
  dispose(): Promise<void>;
}

/** `runners` for a task with test services, or the same object for one without (the golden path: nothing changes). */
export function withTestServices(run: TestServicesRun | undefined, runners: CheckRunners): CheckRunners {
  return run === undefined ? runners : run.checkRunners(runners);
}

export interface StartTestServicesInput {
  dependencies: readonly TaskDependencyPlan[];
  /** The operation's id: labels the check sandbox like every task sandbox, and (with a random suffix) names the run. */
  operationId: string;
  /** The canonical workspace root. */
  rootPath: string;
  /** The task's working sandbox, already started. */
  sandbox: TaskSandbox;
  /** The project has a dev container. Refused before anything is made (the first step). */
  hasDevcontainer: boolean;
  /** Where the usage record is written after each sealed round. */
  artifactSink?: ArtifactSink | undefined;
  signal?: AbortSignal;
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

function failureOf(error: unknown): TestServicesError {
  if (error instanceof TestServicesError) return error;
  if (error instanceof HelperStartError) {
    const failures = new Map<string, TestServicesStartFailure>();
    const failure: TestServicesStartFailure = error.reason === "health_timeout" || error.reason === "exited" ? "not_healthy" : "start_failed";
    if (error.dependencyId !== undefined) failures.set(error.dependencyId, failure);
    return new TestServicesError(failure === "not_healthy" ? "not_healthy" : "start_failed", failures);
  }
  return new TestServicesError("start_failed");
}

/**
 * Starts the run: pulls the pinned images, makes the network, starts and health-waits the helpers, joins the working sandbox, starts the sealed name server, and runs the seeds. On ANY failure everything made so far is
 * removed before this throws a `TestServicesError`. On success the sandbox's `dispose()` tears the run down.
 */
export async function startTestServicesRun(config: TestServicesConfig, input: StartTestServicesInput): Promise<TestServicesRun> {
  // The very first step: a project with a dev container is "not available yet", before a directory, a network, a name server or a helper exists.
  refuseTestServicesWithDevcontainer({ dependencies: input.dependencies, devcontainer: input.hasDevcontainer });
  const ports = config.sealedRound;
  if (ports === undefined) throw new TestServicesError("sealed_unavailable");
  const log = config.log ?? defaultLog;
  const now = config.now ?? Date.now;
  const docker = config.docker;
  const catalog = await config.catalog().catch(() => { throw new TestServicesError("catalog"); });
  const resolved = resolveDependencies(catalog, input.dependencies, config);
  const root = await realpath(resolve(input.rootPath));
  // Before anything is made: the init files of each dependency, checked against the real workspace root.
  for (const item of resolved) {
    const files = await initFilesOf(item.plan, root);
    if (files.length > 0) item.request = { ...item.request, files };
  }
  const runId = `${input.operationId.replace(/[^A-Za-z0-9-]/gu, "-").slice(0, 48)}-${randomAlphanumeric(8)}`;
  const workspace = await setupWorkspaceKey(root);
  const files = await createRunDirectoryFiles(config.runDirectoryParent, `rsv-${sha(runId).slice(0, 16)}`).catch(() => { throw new TestServicesError("start_failed"); });

  const requests = resolved.map((item) => item.request);
  const failures = new Map<string, TestServicesStartFailure>();
  const ids = resolved.map((item) => item.plan.id);
  let resets: ReadonlyMap<string, number> = new Map<string, number>();
  let session: ServiceSession | undefined;
  let counted: ServiceSession | undefined;
  let sealedPlan: CheckSandboxPlan | undefined;
  let sealedInput: SealedRoundSetup | undefined;
  let redactor: ServiceRedactor = createServiceRedactor(helperSecretValues(requests));
  let startMs = 0;
  let active = true;
  let torndown: Promise<void> | undefined;
  let round: { runners: CheckRunners | undefined; close(): Promise<void> } | undefined;
  let dnsStarted = false;

  const closeRound = async (): Promise<void> => {
    const open = round;
    round = undefined;
    await open?.close().catch(() => log({ event: "test-services.round.close.failed" }));
  };
  const teardown = (): Promise<void> => {
    torndown ??= (async () => {
      active = false;
      await closeRound();
      if (dnsStarted && sealedPlan !== undefined) await docker.run(["rm", "--force", sealedPlan.dnsHelperName], { timeoutMs: DOCKER_CALL_TIMEOUT_MS }).catch(() => undefined);
      await session?.stop().catch(() => undefined);
      await removeRunDirectory(files.directory);
    })();
    return torndown;
  };

  try {
    const working = buildServiceEnvironment({ sandbox: "working", sinkholeUrl: SINKHOLE_URL, dependencies: resolved.map((item) => item.env), neverValues: neverValuesFor(resolved) });
    const checkEnvironment = buildServiceEnvironment({ sandbox: "check", sinkholeUrl: SINKHOLE_URL, dependencies: resolved.map((item) => item.env), neverValues: neverValuesFor(resolved) });
    redactor = createServiceRedactor([...helperSecretValues(requests), ...working.secretValues, ...checkEnvironment.secretValues]);
    // The sandbox runs every command with the run's variables from here on, and tears the run down when it is disposed, even if the start below fails.
    input.sandbox.attachServices({ wrapExec: workingExec(docker, files, input.sandbox.name, working, () => active), teardown });

    // The images, by digest, before anything starts (the launcher runs with `--pull=never`).
    for (const item of resolved) {
      const reference = `${config.registry}/${catalogRepositoryName(config.catalogEnv, item.plan.repository)}@sha256:${item.plan.digest}`;
      const present = await docker.run(["image", "inspect", "--format", "{{.Id}}", reference], { timeoutMs: DOCKER_CALL_TIMEOUT_MS, ...(input.signal === undefined ? {} : { signal: input.signal }) }).catch(() => undefined);
      if (present?.exitCode === 0) continue;
      const pulled = await docker.run(["pull", reference], { timeoutMs: PULL_TIMEOUT_MS, ...(input.signal === undefined ? {} : { signal: input.signal }) }).catch(() => undefined);
      if (pulled === undefined || pulled.exitCode !== 0) {
        failures.set(item.plan.id, "pull_failed");
        throw new TestServicesError("pull_failed", failures);
      }
    }

    const runner = config.runner ?? createDockerServiceRunner(docker);
    const startedAt = now();
    try {
      session = await runner.start({
        runId, workspace, roundBudgetMs: TEST_SERVICES_RUN_LIFETIME_MS, registry: `${config.registry}/${CATALOG_REGISTRY_ROOT}/${config.catalogEnv}`, edition: config.edition,
        probeImage: config.probeImage, maxMemMiB: config.maxMemMiB, helpers: requests, files, sandboxes: workingSandboxAttachment(docker, input.sandbox.name),
        resetHooks: createResetHooks(), ...(input.signal === undefined ? {} : { signal: input.signal }), ...(config.now === undefined ? {} : { now: config.now }), ...(config.sleep === undefined ? {} : { sleep: config.sleep }),
      });
    } catch (error) {
      const failure = failureOf(error);
      for (const id of ids) if (!failure.failures.has(id)) failures.set(id, failure.reason === "not_healthy" ? "not_healthy" : "start_failed");
      for (const [id, reason] of failure.failures) failures.set(id, reason);
      throw new TestServicesError(failure.reason, failures);
    }
    startMs = Math.max(0, now() - startedAt);
    const live = session;
    // `reset` is counted for the usage record; everything that resets goes through the counted session.
    const countedSession = countResets(live);
    counted = countedSession.session;
    resets = countedSession.resets;

    // The sealed name server and the check sandbox's files (the sandbox itself starts only inside a round).
    const view = live.network;
    const slot = Number(/^172\.30\.(\d{1,3})\.0\/24$/u.exec(view.subnet)?.[1]);
    const createdAt = now();
    const expiresAt = createdAt + servicesNetworkStaleAfterMs(TEST_SERVICES_RUN_LIFETIME_MS);
    const net: CheckSandboxNetwork = {
      name: view.name, slot, subnet: view.subnet, dnsHelperIp: view.dnsHelperIp, workingSandboxIp: view.workingSandboxIp, checkSandboxIp: view.checkSandboxIp,
      labelArgs: () => runNetworkLabelArgs({ runId, workspace, createdAt, expiresAt }),
    };
    sealedPlan = checkSandboxPlan({
      net, taskId: input.operationId, image: config.probeImage, rootPath: root, maskedPaths: await hiddenWorkspaceDirectories(root), filesDir: files.directory,
      helpers: live.helpers.flatMap((helper) => helper.aliases.map((alias) => ({ alias, address: helper.address }))), sinkholeIp: runNetworkHelperIp(slot, SINKHOLE_HELPER_INDEX),
      workingSandboxName: input.sandbox.name,
    });
    await writeCheckSandboxFiles(sealedPlan);
    dnsStarted = true;
    const dns = await docker.run(sealedPlan.dnsHelperRunArgs, { timeoutMs: DOCKER_CALL_TIMEOUT_MS }).catch(() => undefined);
    if (dns === undefined || dns.exitCode !== 0) throw new TestServicesError("setup_failed");
    sealedInput = { docker, hasDevcontainer: false, plan: sealedPlan, rootPath: root, files, environment: checkEnvironment, redactor };

    // The seeds, in the working sandbox (attached, with the run's variables), one dependency at a time so a failure names its dependency.
    const seedSignal = AbortSignal.any([AbortSignal.timeout(SEED_LIMIT_MS), ...(input.signal === undefined ? [] : [input.signal])]);
    const workingSeeds: SeedPorts = seedPorts(executionFor(SANDBOX_TARGET, { sandbox: input.sandbox }).runCommand);
    for (const item of resolved) {
      try {
        await seedRun(counted, [item.resetDependency], workingSeeds, seedSignal);
      } catch {
        failures.set(item.plan.id, "seed_failed");
        throw new TestServicesError("seed_failed", failures);
      }
    }
  } catch (error) {
    await teardown();
    const failure = failureOf(error);
    log({ event: "test-services.start.failed", reason: failure.reason });
    throw failure;
  }

  // ---- the sealed round

  const openRound = async (): Promise<CheckRunners> => {
    if (!active || sealedInput === undefined) throw agentXError("RUNTIME_UNAVAILABLE", SENTENCES.setup_failed);
    await closeRound();
    let release!: () => void;
    const closed = new Promise<void>((done) => { release = done; });
    let handOver!: (runners: CheckRunners) => void;
    let failStart!: (error: unknown) => void;
    const ready = new Promise<CheckRunners>((done, fail) => { handOver = done; failStart = fail; });
    const running = ports.withSealedCheckRound(sealedInput, async (runners) => {
      handOver(runners);
      await closed;
    });
    // A rejection before the round was handed over is the start's failure; after it, `close` reports it.
    running.then(() => undefined, (error: unknown) => failStart(error));
    // Registered BEFORE the start finishes, so a teardown that arrives while the check sandbox is still starting waits for it and removes it.
    const open: { runners: CheckRunners | undefined; close(): Promise<void> } = { runners: undefined, close: async () => { release(); await running; } };
    round = open;
    try {
      open.runners = await ready;
    } catch (error) {
      if (round === open) round = undefined;
      await running.catch(() => undefined);
      throw error;
    }
    return open.runners;
  };
  const currentRound = (): CheckRunners => {
    const runners = round?.runners;
    if (runners === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the sealed check round is not open, so no check was run");
    return runners;
  };
  const roundSeeds = (runners: CheckRunners): SeedPorts => seedPorts((command, signal) => runners.runProjectCommand(command, signal));
  const resetDependencies = resolved.map((item) => item.resetDependency);

  const usageRecord = async (): Promise<TestServicesUsageRecord | undefined> => {
    if (!active || session === undefined) return undefined;
    try {
      const built = await ports.buildServiceUsageRecord({
        planned: ids, session, startMs, resetCounts: resets, failures, redactor,
        ...(sealedPlan === undefined ? {} : { dns: { docker, dnsHelperName: sealedPlan.dnsHelperName } }),
      });
      const parsed = TestServicesUsageRecordSchema.safeParse(built);
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  };

  const run: TestServicesRun = {
    ids,
    checkRunners() {
      return {
        runProjectCommand: async (command, signal) => currentRound().runProjectCommand(command, signal),
        runAgentCommand: async (replay, timeoutMs, signal) => currentRound().runAgentCommand(replay, timeoutMs, signal),
        async freshServices(signal) {
          const sealed = await openRound();
          try {
            await freshHelpers(counted, resetDependencies, roundSeeds(sealed), signal);
          } catch (error) {
            for (const id of ids) failures.set(id, "reset_failed");
            throw error;
          }
        },
        async resetBetweenChecks(signal) {
          try {
            await resetForNextCheck(counted, resetDependencies, roundSeeds(currentRound()), signal);
          } catch (error) {
            for (const id of ids) failures.set(id, "reset_failed");
            throw error;
          }
        },
        async endRound() {
          await closeRound();
          if (input.artifactSink === undefined) return;
          const record = await usageRecord();
          if (record !== undefined) await input.artifactSink({ name: TEST_SERVICES_USAGE_ARTIFACT, mediaType: "application/json", content: JSON.stringify(record) }).catch(() => log({ event: "test-services.usage.save.failed" }));
        },
      };
    },
    usageRecord,
    dispose: teardown,
  };
  return run;
}

/** The seeds' ports: a command runs where the caller says; a fixture file is not available in slice 1 (refused, so the seed fails closed). */
function seedPorts(runCommand: (command: Parameters<SeedPorts["runCommand"]>[0], signal: AbortSignal) => Promise<{ exitCode: number | null; timedOut?: boolean | undefined }>): SeedPorts {
  return {
    runCommand: async (command, signal) => {
      const result = await runCommand(command, signal);
      return { exitCode: result.exitCode, timedOut: result.timedOut === true };
    },
    applyFixture: () => Promise.reject(new Error("fixture seeds are not available yet")),
  };
}

// ---- what run-task calls

export interface StartTaskTestServicesInput {
  plan: TestEnvTaskPlan | undefined;
  mode: string | undefined;
  /** The task's working sandbox, started; undefined for a task in a dev container or on the local shell (refused: no sandbox, no services). */
  sandbox: TaskSandbox | undefined;
  /** The task runs in a dev container (refused with the fixed "not available yet" sentence, before anything else). */
  devcontainer: boolean;
  operationId: string;
  rootPath: string;
  config?: TestServicesConfig | undefined;
  artifactSink: ArtifactSink;
}

/**
 * The one call run-task makes after the working sandbox has started. Returns undefined, having done nothing at all (no Docker call, no file), when the task's plan has no dependencies, or the step does not run code.
 * Otherwise starts the run or throws one fixed-sentence error (the task then fails before the agent runs, as a sandbox that cannot start does). A plan with dependencies on a task with no sandbox is refused.
 */
export async function startTaskTestServices(input: StartTaskTestServicesInput): Promise<TestServicesRun | undefined> {
  const dependencies = input.plan?.dependencies;
  if (dependencies === undefined || !MODES_WITH_SERVICES.has(input.mode)) return undefined;
  refuseTestServicesWithDevcontainer({ dependencies, devcontainer: input.devcontainer });
  const refuse = (reason: TestServicesFailureReason): never => { throw agentXError("RUNTIME_UNAVAILABLE", SENTENCES[reason]); };
  if (input.sandbox === undefined) return refuse("unsupported");
  const config = input.config ?? testServicesConfigFromEnvironment();
  if (config === undefined) return refuse("not_configured");
  try {
    return await startTestServicesRun(config, { dependencies, operationId: input.operationId, rootPath: input.rootPath, sandbox: input.sandbox, hasDevcontainer: input.devcontainer, artifactSink: input.artifactSink });
  } catch (error) {
    const failure = failureOf(error);
    throw agentXError("RUNTIME_UNAVAILABLE", failure.message);
  }
}
