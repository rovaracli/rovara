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
import { open, readFile, realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  CATALOG_FILE, CATALOG_REGISTRY_ROOT, CATALOG_SIGNATURE_FILE, TEST_SERVICES_PLAN_FEATURE, TEST_SERVICES_USAGE_LIMITS, TestServicesUsageRecordSchema, agentXError, catalogEntryById, catalogRepositoryName, loadSignedCatalog,
  type CatalogEdition, type CatalogEntry, type CatalogTrustContext, type ServiceCatalog, type TaskDependencyPlan, type TestEnvTaskPlan, type TestServicesStartFailure, type TestServicesUsageRecord,
} from "@agentx/contracts";
import { TASK_SANDBOX_IMAGE_ENVIRONMENT, type TaskSandbox } from "./task-sandbox.js";
import { SANDBOX_TARGET, executionFor } from "./execution-target.js";
import type { ArtifactSink } from "./artifacts.js";
import type { WorkerCancellationController } from "./cancel.js";
import type { CommandResult } from "./readiness.js";
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
import { createResetHooks, resetForNextCheck, seedRun, type ResetDependency, type SeedPorts } from "./service-reset.js";
import {
  createDockerServiceRunner, type SandboxAttachment, type ServiceRunner, type ServiceSession,
} from "./service-runner.js";
import { refuseTestServicesWithDevcontainer, withSealedCheckRound } from "./check-round-runners.js";
import { buildServiceUsageRecord, countResets } from "./service-usage-record.js";
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
  | "not_configured" | "unsupported" | "nightly" | "init_file" | "catalog" | "mismatch" | "sealed_unavailable" | "pull_failed" | "start_failed" | "not_healthy" | "seed_failed" | "setup_failed";

const SENTENCES: Record<TestServicesFailureReason, string> = {
  not_configured: "This worker is not set up to run test services",
  init_file: "A test service's init file is not a plain SQL file inside the workspace",
  nightly: "Test services are not available yet for a nightly run",
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
 * s1-sealed's two exports, as this module needs them. A config without them (`config.sealedRound` undefined) refuses a plan with dependencies before anything starts;
 * `SEALED_ROUND_PORTS` binds them. Tests stub them.
 */
export interface SealedRoundPorts {
  withSealedCheckRound<T>(input: SealedRoundSetup, round: (runners: CheckRunners) => Promise<T>): Promise<T>;
  buildServiceUsageRecord(input: UsageRecordSetup): Promise<unknown>;
}

/** s1-sealed's two exports, bound. This is the only file besides run-task.ts and prepare.ts that may import the sealed round or the usage-record builder (tests/unit/worker-sealed-source-guards.test.ts). */
export const SEALED_ROUND_PORTS: SealedRoundPorts = { withSealedCheckRound, buildServiceUsageRecord };

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
/** The AWS account the instance runs in: root writes it at boot from the instance identity (IMDSv2; the worker container cannot reach the metadata service). */
export const TEST_SERVICES_ACCOUNT_ENVIRONMENT = "AGENTX_TEST_SERVICES_ACCOUNT_ID";
/**
 * The signed catalog from a directory holding `catalog.json` and `catalog.sig.json`. OWNER RULE: the trusted keys are compiled into the release (contracts `catalog-trust.ts`: `CATALOG_TRUSTED_SIGNING_KEYS`, and the
 * staging-only list honoured only in the staging account AND a staging build) and are NEVER read from a file, the environment or SSM here. The only thing passed in is the account id the worker runs in (written at boot
 * from the instance identity, never from configuration a customer sets); a catalog that no trusted key signed is refused with one fixed error. `testKeys` is a test seam (the contract's own `trustedKeys` override).
 */
export async function loadCatalogFromDirectory(directory: string, trust: CatalogTrustContext, testKeys?: readonly string[]): Promise<ServiceCatalog> {
  try {
    const [catalogBytes, signatureBytes] = await Promise.all([readFile(join(directory, CATALOG_FILE)), readFile(join(directory, CATALOG_SIGNATURE_FILE))]);
    const loaded = loadSignedCatalog({ catalogBytes, signatureBytes, trust, ...(testKeys === undefined ? {} : { trustedKeys: testKeys }) });
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
    catalog: () => loadCatalogFromDirectory(catalogDirectory, { runningAccountId: environment[TEST_SERVICES_ACCOUNT_ENVIRONMENT] }), ...(roundPorts === undefined ? {} : { sealedRound: roundPorts }),
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

/** One dependency of the plan checked against the worker's own signed catalog; credentials and requests are made per phase (`materialize`). */
interface Base {
  plan: TaskDependencyPlan;
  entry: CatalogEntry;
  aliases: string[];
  host: string;
  port: number;
  user: string;
  database: string;
  resetDependency: ResetDependency;
  /** The dependency's init files (read once, checked), mounted into ITS helper alone, in the working phase and in every round. */
  files: NonNullable<HelperRequest["files"]>;
}

/** A dependency with one phase's own helper request and credentials (the working phase's, or one sealed round's). */
interface Resolved extends Base {
  request: HelperRequest;
  env: ServiceEnvDependency;
}

/** The most an init file may hold (the launcher's own limit for a helper's file). */
const INIT_FILE_MAX_BYTES = 1_048_576;
const INIT_FILE_FAMILIES: ReadonlySet<string> = new Set(["postgres", "mysql"]);

/**
 * A dependency's `config.initFiles` (init SQL from the repository), as files for ITS helper alone. The broker only checks that each is a relative path without `..`; a symlink inside the repository can still point anywhere,
 * so here each path is resolved to its real path, which must be a regular file under one of the REPOSITORIES' own folders (the manifest's paths, resolved), never under a hidden folder of the workspace (the worker's state,
 * the agent's sessions, the Docker data root), ending in `.sql` (the image runs a `.sh` it finds there), and small. It is opened without following a link, and the opened file must be the very file that was resolved (same device and
 * inode), then read through that handle. The content goes into the launcher's `HelperRequest.files`: the launcher writes it to the run's directory and mounts it read-only into that one helper. Anything else is one fixed error
 * (`init_file`) and nothing has been started yet.
 */
async function initFilesOf(plan: TaskDependencyPlan, root: string, repositoryPaths: readonly string[]): Promise<NonNullable<HelperRequest["files"]>> {
  const paths = plan.config.initFiles ?? [];
  if (paths.length === 0) return [];
  if (!INIT_FILE_FAMILIES.has(plan.family)) throw new TestServicesError("init_file");
  const within = (path: string, folder: string): boolean => path === folder || path.startsWith(`${folder}${sep}`);
  let repositories: string[];
  let hidden: string[];
  try {
    repositories = (await Promise.all(repositoryPaths.map((path) => realpath(path).catch(() => undefined)))).filter((path): path is string => path !== undefined);
    hidden = await Promise.all((await hiddenWorkspaceDirectories(root)).map((path) => realpath(path).catch(() => path)));
  } catch {
    throw new TestServicesError("init_file");
  }
  const files: Array<{ name: string; content: string; to: string }> = [];
  for (const [index, path] of paths.entries()) {
    try {
      const real = await realpath(resolve(root, path));
      if (!real.endsWith(".sql") || !repositories.some((folder) => real.startsWith(`${folder}${sep}`)) || hidden.some((folder) => within(real, folder))) throw new Error("outside");
      const resolvedInfo = await stat(real);
      const handle = await open(real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > INIT_FILE_MAX_BYTES || info.dev !== resolvedInfo.dev || info.ino !== resolvedInfo.ino) throw new Error("not the file that was resolved");
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
 * is `mismatch`: the broker's plan is never trusted to name an image. The user and the database come from the plan's config or fixed defaults, and must have the launcher's plain form.
 */
function resolveDependencies(catalog: ServiceCatalog, dependencies: readonly TaskDependencyPlan[], config: Pick<TestServicesConfig, "edition">): Base[] {
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
    return { plan, entry, aliases, host, port, user, database, resetDependency: { id: plan.id, seeds: plan.seeds, reset: plan.reset }, files: [] };
  });
}

/** One phase's helper request and variables, with a password made now: the working phase and every sealed round have their own, so no phase's helpers or password are another's. */
function materialize(base: Base): Resolved {
  const credentials = { user: base.user, password: randomAlphanumeric(32), database: base.database };
  return {
    ...base,
    request: { id: base.plan.id, name: base.plan.name, entry: base.entry, aliases: base.aliases, credentials, ...(base.files.length === 0 ? {} : { files: base.files }) },
    env: { id: base.plan.id, host: base.host, port: base.port, credentials, connect: { env: base.plan.connect, hostAliases: base.aliases } },
  };
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
  /** The repositories' folders (absolute, as the manifest has them): a dependency's init files may come only from under them. */
  repositoryPaths: readonly string[];
  /** The task's working sandbox, already started. */
  sandbox: TaskSandbox;
  /** The project has a dev container. Refused before anything is made (the first step). */
  hasDevcontainer: boolean;
  /** Where the usage record is written after each sealed round. */
  artifactSink?: ArtifactSink | undefined;
  /** Stops the start (pulls, helper starts, seeds) when the task is cancelled. */
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

/** Adds two usage records of one run: the later record's health and failures, the resets of both, and the unknown names of both (counts are lower bounds, so their sums are too). */
function mergeUsageRecords(earlier: TestServicesUsageRecord | undefined, later: TestServicesUsageRecord): TestServicesUsageRecord {
  if (earlier === undefined) return later;
  const limits = TEST_SERVICES_USAGE_LIMITS;
  const before = new Map(earlier.dependencies.map((entry) => [entry.id, entry]));
  const domains = new Map<string, number>();
  for (const row of [...earlier.unknownCalls.domains, ...later.unknownCalls.domains]) domains.set(row.domain, Math.min(limits.count, (domains.get(row.domain) ?? 0) + row.count));
  const ranked = [...domains].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
  const overflow = ranked.slice(limits.unknownDomains).reduce((sum, [, count]) => sum + count, 0);
  return {
    schemaVersion: 1,
    dependencies: later.dependencies.map((entry) => ({ ...entry, resetCount: Math.min(limits.resets, entry.resetCount + (before.get(entry.id)?.resetCount ?? 0)) })),
    unknownCalls: {
      domains: ranked.slice(0, limits.unknownDomains).map(([domain, count]) => ({ domain, count })),
      otherCount: Math.min(limits.count, earlier.unknownCalls.otherCount + later.unknownCalls.otherCount + overflow),
    },
  };
}

/** What one sealed round holds while it is open. Everything in it is the round's own: its network, its helpers, its passwords, its name server and its directory. */
interface RoundState {
  number: number;
  session: ServiceSession;
  counted: ServiceSession;
  resets: ReadonlyMap<string, number>;
  plan: CheckSandboxPlan;
  files: HelperFiles & { directory: string };
  redactor: ServiceRedactor;
  startMs: number;
  dnsStarted: boolean;
  /** Absent while the round is still starting. */
  runners: CheckRunners | undefined;
  /** Ends the sealed round (the check sandbox removed, the working sandbox put back). */
  sealedClose(): Promise<void>;
}

/**
 * Starts the run's WORKING PHASE: pulls the pinned images, makes the network, starts and health-waits the helpers, joins the working sandbox, and runs the seeds there. This is where the agent codes; the helpers here
 * are for the working phase ONLY. Every official check round (`checkRunners`) starts BRAND-NEW helpers of its own from the same pinned digests, on a network of its own that the working sandbox is never on, with new
 * passwords and its own name server, seeds them INSIDE the round from the candidate code, and removes all of it when the round ends (design 4.0 and 8.1): nothing the agent did to the working-phase database (a table, an
 * `ALTER SYSTEM`, a template, a file written by `COPY ... PROGRAM`) can reach a round. The working-phase helpers keep running between rounds. The working-phase Postgres user is the image's superuser (the catalog has
 * no field for a lesser role); that is why no round reuses it. On ANY failure everything made so far is removed before this throws a `TestServicesError`. On success the sandbox's `dispose()` tears the run down.
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
  const bases = resolveDependencies(catalog, input.dependencies, config);
  const root = await realpath(resolve(input.rootPath));
  // Before anything is made: the init files of each dependency, checked against the repositories' real folders.
  for (const base of bases) base.files = await initFilesOf(base.plan, root, input.repositoryPaths);
  const runId = `${input.operationId.replace(/[^A-Za-z0-9-]/gu, "-").slice(0, 48)}-${randomAlphanumeric(8)}`;
  const workspace = await setupWorkspaceKey(root);
  const files = await createRunDirectoryFiles(config.runDirectoryParent, `rsv-${sha(runId).slice(0, 16)}`).catch(() => { throw new TestServicesError("start_failed"); });
  const runner = config.runner ?? createDockerServiceRunner(docker);

  const failures = new Map<string, TestServicesStartFailure>();
  const ids = bases.map((base) => base.plan.id);
  const secrets: string[] = [];
  const pendingStarts = new Set<Promise<ServiceSession>>();
  let workSession: ServiceSession | undefined;
  let workStartMs = 0;
  let active = true;
  let torndown: Promise<void> | undefined;
  let round: RoundState | undefined;
  let opening: Promise<unknown> | undefined;
  let rounds = 0;
  let cumulative: TestServicesUsageRecord | undefined;
  let redactor: ServiceRedactor = createServiceRedactor([]);

  /** One teardown step: a failure is a warning with the step's name and a redacted reason, and the next step still runs. */
  const step = async (name: string, action: () => Promise<unknown>): Promise<void> => {
    try { await action(); } catch (error) { log({ event: "test-services.teardown.warning", step: name, reason: redactor.text(error instanceof Error ? error.message : String(error)).slice(0, 200) }); }
  };
  /** A start that teardown can still find: if `dispose` comes while it is pending, the session it returns is stopped. */
  const trackedStart = (input2: Parameters<ServiceRunner["start"]>[0]): Promise<ServiceSession> => {
    const pending = runner.start(input2);
    pendingStarts.add(pending);
    void pending.then(() => undefined, () => undefined).finally(() => { pendingStarts.delete(pending); });
    return pending;
  };
  const registry = `${config.registry}/${CATALOG_REGISTRY_ROOT}/${config.catalogEnv}`;
  const startInput = (phaseRunId: string, resolved: readonly Resolved[], phaseFiles: HelperFiles, extra: Partial<Parameters<ServiceRunner["start"]>[0]>): Parameters<ServiceRunner["start"]>[0] => ({
    runId: phaseRunId, workspace, roundBudgetMs: TEST_SERVICES_RUN_LIFETIME_MS, registry, edition: config.edition, probeImage: config.probeImage, maxMemMiB: config.maxMemMiB,
    helpers: resolved.map((item) => item.request), files: phaseFiles, resetHooks: createResetHooks(),
    ...(config.now === undefined ? {} : { now: config.now }), ...(config.sleep === undefined ? {} : { sleep: config.sleep }), ...extra,
  });

  const recordOf = async (open: RoundState): Promise<TestServicesUsageRecord | undefined> => {
    try {
      const built = await ports.buildServiceUsageRecord({
        planned: ids, session: open.session, startMs: open.startMs, resetCounts: open.resets, failures, redactor: open.redactor, dns: { docker, dnsHelperName: open.plan.dnsHelperName },
      });
      const parsed = TestServicesUsageRecordSchema.safeParse(built);
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  };

  /** Ends the open round: the sealed round first (the check sandbox removed), then (when asked) its usage record while its helpers and name server still run, then everything the round made. */
  const closeRound = async (emit: boolean): Promise<void> => {
    const open = round;
    round = undefined;
    if (open === undefined) return;
    await step("sealed-round", () => open.sealedClose());
    if (emit && active) {
      const record = await recordOf(open);
      if (record !== undefined) {
        cumulative = mergeUsageRecords(cumulative, record);
        if (input.artifactSink !== undefined) await input.artifactSink({ name: TEST_SERVICES_USAGE_ARTIFACT, mediaType: "application/json", content: JSON.stringify(cumulative) }).catch(() => log({ event: "test-services.usage.save.failed" }));
      }
    }
    await cleanupRound(open);
  };
  const cleanupRound = async (open: Pick<RoundState, "plan" | "session" | "files" | "dnsStarted">): Promise<void> => {
    // `withDetachedWorking` puts the working sandbox back on the round's network when the round ends; it leaves before the network is removed.
    await step("working-sandbox", () => docker.run(["network", "disconnect", "--force", open.plan.network.name, input.sandbox.name], { timeoutMs: DOCKER_CALL_TIMEOUT_MS }));
    if (open.dnsStarted) await step("name-server", () => docker.run(["rm", "--force", open.plan.dnsHelperName], { timeoutMs: DOCKER_CALL_TIMEOUT_MS }));
    await step("round-helpers", () => open.session.stop());
    await step("round-directory", () => removeRunDirectory(open.files.directory));
  };

  const teardown = (): Promise<void> => {
    torndown ??= (async () => {
      active = false;
      await step("opening", async () => { await opening?.catch(() => undefined); });
      await closeRound(false);
      // A start that was still pending when the run was disposed: its session is stopped as soon as it exists.
      for (const pending of [...pendingStarts]) await step("pending-start", async () => { (await pending.catch(() => undefined))?.stop(); });
      await step("helpers", async () => { await workSession?.stop(); });
      await step("directory", () => removeRunDirectory(files.directory));
    })();
    return torndown;
  };

  // ---- the working phase

  try {
    const working = materializeAll(bases);
    const workingEnv = buildServiceEnvironment({ sandbox: "working", sinkholeUrl: SINKHOLE_URL, dependencies: working.map((item) => item.env), neverValues: neverValuesFor(working) });
    secrets.push(...helperSecretValues(working.map((item) => item.request)), ...workingEnv.secretValues);
    redactor = createServiceRedactor(secrets);
    // The sandbox runs every command with the run's variables from here on, and tears the run down when it is disposed, even if the start below fails.
    input.sandbox.attachServices({ wrapExec: workingExec(docker, files, input.sandbox.name, workingEnv, () => active), teardown });

    // The images, by digest, before anything starts (the launcher runs with `--pull=never`).
    for (const item of working) {
      if (input.signal?.aborted === true) throw new TestServicesError("start_failed");
      const reference = `${config.registry}/${catalogRepositoryName(config.catalogEnv, item.plan.repository)}@sha256:${item.plan.digest}`;
      const present = await docker.run(["image", "inspect", "--format", "{{.Id}}", reference], { timeoutMs: DOCKER_CALL_TIMEOUT_MS, ...(input.signal === undefined ? {} : { signal: input.signal }) }).catch(() => undefined);
      if (present?.exitCode === 0) continue;
      const pulled = await docker.run(["pull", reference], { timeoutMs: PULL_TIMEOUT_MS, ...(input.signal === undefined ? {} : { signal: input.signal }) }).catch(() => undefined);
      if (pulled === undefined || pulled.exitCode !== 0) {
        failures.set(item.plan.id, "pull_failed");
        throw new TestServicesError("pull_failed", failures);
      }
    }

    const startedAt = now();
    try {
      workSession = await trackedStart(startInput(runId, working, files, { sandboxes: workingSandboxAttachment(docker, input.sandbox.name), ...(input.signal === undefined ? {} : { signal: input.signal }) }));
    } catch (error) {
      const failure = failureOf(error);
      for (const id of ids) if (!failure.failures.has(id)) failures.set(id, failure.reason === "not_healthy" ? "not_healthy" : "start_failed");
      for (const [id, reason] of failure.failures) failures.set(id, reason);
      throw new TestServicesError(failure.reason, failures);
    }
    workStartMs = Math.max(0, now() - startedAt);
    if (!active) throw new TestServicesError("start_failed");

    // The seeds, in the working sandbox (attached, with the run's variables), one dependency at a time so a failure names its dependency.
    const seedSignal = AbortSignal.any([AbortSignal.timeout(SEED_LIMIT_MS), ...(input.signal === undefined ? [] : [input.signal])]);
    const workingSeeds: SeedPorts = seedPorts((command, signal) => executionFor(SANDBOX_TARGET, { sandbox: input.sandbox }).runCommand(command, signal));
    for (const item of working) {
      try {
        await seedRun(countResets(workSession).session, [item.resetDependency], workingSeeds, seedSignal);
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

  // ---- one sealed round

  /** Brand-new helpers, a network of its own, a name server of its own, the sealed check sandbox, and the seeds run INSIDE it from the candidate code. */
  const startRound = async (signal: AbortSignal): Promise<RoundState> => {
    const check = (): void => { if (!active) throw new TestServicesError("start_failed"); };
    check();
    await closeRound(false);
    rounds += 1;
    const number = rounds;
    const resolved = materializeAll(bases);
    const environment = buildServiceEnvironment({ sandbox: "check", sinkholeUrl: SINKHOLE_URL, dependencies: resolved.map((item) => item.env), neverValues: neverValuesFor(resolved) });
    secrets.push(...helperSecretValues(resolved.map((item) => item.request)), ...environment.secretValues);
    redactor = createServiceRedactor(secrets);
    const roundRedactor = redactor;
    const roundFiles = await createRunDirectoryFiles(files.directory, `round-${String(number)}`).catch(() => { throw new TestServicesError("start_failed"); });
    const startedAt = now();
    let session: ServiceSession | undefined;
    let plan: CheckSandboxPlan | undefined;
    let dnsStarted = false;
    let closeSealed: (() => Promise<void>) | undefined;
    const partial = (): Pick<RoundState, "plan" | "session" | "files" | "dnsStarted"> | undefined => (session === undefined || plan === undefined ? undefined : { plan, session, files: roundFiles, dnsStarted });
    try {
      session = await trackedStart(startInput(`${runId}-r${String(number)}`, resolved, roundFiles, { signal }));
      check();
      const startMs = Math.max(0, now() - startedAt);
      const view = session.network;
      const slot = Number(/^172\.30\.(\d{1,3})\.0\/24$/u.exec(view.subnet)?.[1]);
      const createdAt = now();
      const expiresAt = createdAt + servicesNetworkStaleAfterMs(TEST_SERVICES_RUN_LIFETIME_MS);
      const net: CheckSandboxNetwork = {
        name: view.name, slot, subnet: view.subnet, dnsHelperIp: view.dnsHelperIp, workingSandboxIp: view.workingSandboxIp, checkSandboxIp: view.checkSandboxIp,
        labelArgs: () => runNetworkLabelArgs({ runId: `${runId}-r${String(number)}`, workspace, createdAt, expiresAt }),
      };
      const roundHelpers = session.helpers;
      plan = checkSandboxPlan({
        net, taskId: input.operationId, image: config.probeImage, rootPath: root, maskedPaths: await hiddenWorkspaceDirectories(root), filesDir: roundFiles.directory,
        helpers: roundHelpers.flatMap((helper) => helper.aliases.map((alias) => ({ alias, address: helper.address }))), sinkholeIp: runNetworkHelperIp(slot, SINKHOLE_HELPER_INDEX),
        workingSandboxName: input.sandbox.name,
      });
      await writeCheckSandboxFiles(plan);
      dnsStarted = true;
      const dns = await docker.run(plan.dnsHelperRunArgs, { timeoutMs: DOCKER_CALL_TIMEOUT_MS }).catch(() => undefined);
      if (dns === undefined || dns.exitCode !== 0) throw new TestServicesError("setup_failed");
      check();

      // The sealed round: the working sandbox was never on this network; the check sandbox starts inside `withSealedCheckRound`.
      const setup: SealedRoundSetup = { docker, hasDevcontainer: false, plan, rootPath: root, files: roundFiles, environment, redactor: roundRedactor };
      let release!: () => void;
      const closed = new Promise<void>((done) => { release = done; });
      let handOver!: (runners: CheckRunners) => void;
      let failStart!: (error: unknown) => void;
      const ready = new Promise<CheckRunners>((done, fail) => { handOver = done; failStart = fail; });
      const running = ports.withSealedCheckRound(setup, async (runners) => {
        handOver(runners);
        await closed;
      });
      // A rejection before the round was handed over is the start's failure; after it, `sealedClose` reports it.
      running.then(() => undefined, (error: unknown) => failStart(error));
      closeSealed = async () => { release(); await running; };
      const runners = await ready;

      const countedRound = countResets(session);
      const state: RoundState = { number, session, counted: countedRound.session, resets: countedRound.resets, plan, files: roundFiles, redactor: roundRedactor, startMs, dnsStarted, runners, sealedClose: closeSealed };
      round = state;

      // The seeds run INSIDE the round, in the sealed sandbox, from the candidate code: the agent's own migrations are applied, and the helpers hold nothing but what the seeds made.
      const seedSignal = AbortSignal.any([AbortSignal.timeout(SEED_LIMIT_MS), signal]);
      const roundSeeds = seedPorts((command, seedsSignal) => runners.runProjectCommand(command, seedsSignal));
      for (const item of resolved) {
        try {
          await seedRun(state.counted, [item.resetDependency], roundSeeds, seedSignal);
        } catch {
          failures.set(item.plan.id, "seed_failed");
          throw new TestServicesError("seed_failed", failures);
        }
      }
      return state;
    } catch (error) {
      const failure = failureOf(error);
      if (failure.reason !== "seed_failed") for (const id of ids) failures.set(id, failure.failures.get(id) ?? (failure.reason === "not_healthy" ? "not_healthy" : "start_failed"));
      if (round === undefined || round.session !== session) {
        // Not yet recorded as the open round: this attempt's own parts are removed here.
        await step("sealed-round", async () => { await closeSealed?.(); });
        const parts = partial();
        if (parts !== undefined) await cleanupRound(parts);
        else {
          await step("round-helpers", async () => { await session?.stop(); });
          await step("round-directory", () => removeRunDirectory(roundFiles.directory));
        }
      }
      throw failure;
    }
  };
  const currentRound = (): CheckRunners => {
    const runners = round?.runners;
    if (runners === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the sealed check round is not open, so no check was run");
    return runners;
  };
  const resetDependencies = bases.map((base) => base.resetDependency);

  const usageRecord = async (): Promise<TestServicesUsageRecord | undefined> => {
    if (!active) return undefined;
    if (round !== undefined) {
      const live = await recordOf(round);
      return live === undefined ? cumulative : mergeUsageRecords(cumulative, live);
    }
    if (cumulative !== undefined) return cumulative;
    // No round has run: the working phase's own answer, with whatever failed since.
    if (workSession === undefined) return undefined;
    try {
      const built = await ports.buildServiceUsageRecord({ planned: ids, session: workSession, startMs: workStartMs, failures, redactor });
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
          opening = startRound(signal);
          await opening;
        },
        async resetBetweenChecks(signal) {
          const open = round;
          if (open === undefined || open.runners === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the sealed check round is not open, so no check was run");
          const runners = open.runners;
          try {
            await resetForNextCheck(open.counted, resetDependencies, seedPorts((command, seedsSignal) => runners.runProjectCommand(command, seedsSignal)), signal);
          } catch (error) {
            for (const id of ids) failures.set(id, "reset_failed");
            throw error;
          }
        },
        async endRound() {
          await closeRound(true);
        },
      };
    },
    usageRecord,
    dispose: teardown,
  };
  return run;
}

function materializeAll(bases: readonly Base[]): Resolved[] {
  return bases.map(materialize);
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
  /** The invocation is a nightly run: refused with a fixed "not available yet" (the nightly with dependencies is TS31, later). */
  nightly: boolean;
  operationId: string;
  rootPath: string;
  /** The repositories' folders (absolute): init files come only from under them. */
  repositoryPaths: readonly string[];
  config?: TestServicesConfig | undefined;
  artifactSink: ArtifactSink;
  /** The worker's cancellation controller: a cancel while the services start stops the pulls, the helper starts and the seeds. */
  cancellation?: Pick<WorkerCancellationController, "register"> | undefined;
}

/**
 * The one call run-task makes after the working sandbox has started. Returns undefined, having done nothing at all (no Docker call, no file), when the task's plan has no dependencies, or the step does not run code.
 * Otherwise starts the run or throws one fixed-sentence error (the task then fails before the agent runs, as a sandbox that cannot start does). A plan with dependencies on a task with no sandbox, on a dev container or
 * in a nightly run is refused.
 */
export async function startTaskTestServices(input: StartTaskTestServicesInput): Promise<TestServicesRun | undefined> {
  const dependencies = input.plan?.dependencies;
  if (dependencies === undefined) return undefined;
  const refuse = (reason: TestServicesFailureReason): never => { throw agentXError("RUNTIME_UNAVAILABLE", SENTENCES[reason]); };
  if (input.nightly) return refuse("nightly");
  if (!MODES_WITH_SERVICES.has(input.mode)) return undefined;
  refuseTestServicesWithDevcontainer({ dependencies, devcontainer: input.devcontainer });
  if (input.sandbox === undefined) return refuse("unsupported");
  const config = input.config ?? testServicesConfigFromEnvironment();
  if (config === undefined) return refuse("not_configured");
  // A cancel that arrives while the services start stops the start. The registration ends before the task registers its own.
  const stop = new AbortController();
  const unregister = input.cancellation?.register(input.operationId, { abort: () => { stop.abort(); return Promise.resolve(); } });
  try {
    return await startTestServicesRun(config, {
      dependencies, operationId: input.operationId, rootPath: input.rootPath, repositoryPaths: input.repositoryPaths, sandbox: input.sandbox, hasDevcontainer: input.devcontainer,
      artifactSink: input.artifactSink, signal: stop.signal,
    });
  } catch (error) {
    const failure = failureOf(error);
    throw agentXError("RUNTIME_UNAVAILABLE", failure.message);
  } finally {
    unregister?.();
  }
}

/** The features this worker adds to /ping for test services: the plan feature only when the worker has a test-services configuration (a worker without one would only refuse such a plan). */
export function testServicesAdvertisedFeatures(environment: NodeJS.ProcessEnv = process.env): Array<typeof TEST_SERVICES_PLAN_FEATURE> {
  return testServicesConfigFromEnvironment(environment, undefined, undefined) === undefined ? [] : [TEST_SERVICES_PLAN_FEATURE];
}

// ---- the candidate check (Prove, worker side): prepare.ts

/** What a candidate check's preparation is given besides the project: the plan's dependencies (pinned, from the broker), which readiness commands are test checks, and where the usage record goes. */
export interface PrepareTestServices {
  dependencies: readonly TaskDependencyPlan[];
  /** The indexes of the readiness commands that are test checks and run SEALED (each in a round of its own, on fresh helpers). Absent: every readiness command. The others run in the working sandbox, with the run's variables. */
  testChecks?: readonly number[];
  config?: TestServicesConfig;
  /** Receives the usage record once, after the readiness commands and before the services stop (also when the start failed: then every dependency is `started: false` with its fixed failure). */
  onUsageRecord?(record: TestServicesUsageRecord): void | Promise<void>;
}

type ReadinessRunner = (command: Parameters<SeedPorts["runCommand"]>[0], index: number, rootPath: string) => Promise<CommandResult>;

export interface PrepareServices {
  /** The readiness runner for the preparation: a test check runs sealed, anything else as `inner` runs it. */
  sealedReadiness(inner: ReadinessRunner): ReadinessRunner;
  /** Hands the usage record on (once). Never throws. The services stop when the preparation's sandbox is disposed. */
  finish(): Promise<void>;
}

function failedStartRecord(ids: readonly string[], failures: ReadonlyMap<string, TestServicesStartFailure>): TestServicesUsageRecord {
  return { schemaVersion: 1, dependencies: ids.map((id) => ({ id, started: false, healthy: false, startMs: 0, resetCount: 0, failure: failures.get(id) ?? "start_failed" })), unknownCalls: { domains: [], otherCount: 0 } };
}

/**
 * Called by `prepareWorkspace` after the repositories are in place and before the setup commands. Does nothing (undefined) for a preparation with no `testServices`. Otherwise starts the dependencies for the preparation's
 * sandbox (setup and readiness commands then run with the run's variables, and a test check runs sealed); a dev container is refused first, a start that fails reports a failed-start record and throws a fixed sentence
 * (the preparation then fails and removes everything). The sandbox's `dispose()` (prepare's `finally`) tears the run down on every exit path.
 */
export async function startPrepareTestServices(input: { options: PrepareTestServices | undefined; sandbox: TaskSandbox | undefined; devcontainer: boolean; operationId: string; rootPath: string; repositoryPaths: readonly string[] }): Promise<PrepareServices | undefined> {
  const options = input.options;
  if (options === undefined) return undefined;
  refuseTestServicesWithDevcontainer({ dependencies: options.dependencies, devcontainer: input.devcontainer });
  const ids = options.dependencies.map((dependency) => dependency.id);
  const report = async (failures: ReadonlyMap<string, TestServicesStartFailure>): Promise<void> => { await Promise.resolve(options.onUsageRecord?.(failedStartRecord(ids, failures))).catch(() => undefined); };
  const refuse = async (reason: TestServicesFailureReason): Promise<never> => { await report(new Map()); throw agentXError("RUNTIME_UNAVAILABLE", SENTENCES[reason]); };
  if (input.sandbox === undefined) return refuse("unsupported");
  const config = options.config ?? testServicesConfigFromEnvironment();
  if (config === undefined) return refuse("not_configured");
  let run: TestServicesRun;
  try {
    await input.sandbox.start();
    run = await startTestServicesRun(config, { dependencies: options.dependencies, operationId: input.operationId, rootPath: input.rootPath, sandbox: input.sandbox, hasDevcontainer: false, repositoryPaths: input.repositoryPaths });
  } catch (error) {
    const failure = failureOf(error);
    await report(failure.failures);
    throw agentXError("RUNTIME_UNAVAILABLE", failure.message);
  }
  let finished = false;
  const unusedBase: CheckRunners = {
    runProjectCommand: () => Promise.reject(new Error("the working sandbox's runners run no check")),
    runAgentCommand: () => Promise.reject(new Error("the working sandbox's runners run no check")),
  };
  return {
    sealedReadiness(inner) {
      return async (command, index, rootPath) => {
        if (options.testChecks !== undefined && !options.testChecks.includes(index)) return inner(command, index, rootPath);
        const runners = run.checkRunners(unusedBase);
        const signal = new AbortController().signal;
        try {
          try {
            await runners.freshServices?.(signal);
          } catch {
            return { exitCode: -1, stdout: "", stderr: "AgentX did not run this check: the test services could not be put back as they were seeded." };
          }
          const result = await runners.runProjectCommand(command, signal);
          return { exitCode: result.exitCode ?? -1, timedOut: result.timedOut, stdout: result.stdout, stderr: result.stderr };
        } finally {
          await runners.endRound?.().catch(() => undefined);
        }
      };
    },
    async finish() {
      if (finished) return;
      finished = true;
      const record = await run.usageRecord().catch(() => undefined);
      if (record !== undefined) await Promise.resolve(options.onUsageRecord?.(record)).catch(() => undefined);
    },
  };
}
