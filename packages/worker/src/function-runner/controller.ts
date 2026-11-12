// The worker-side sandbox controller of the slice 4 function runner (lane W1; design slice4-function-runner-design.md sections 1 to 5 and 8). For each function and version it keeps a pool of warm gVisor sandboxes
// (`docker run -i --runtime=runsc`, sandbox-spec.ts), runs invokes over the agent's stdin/stdout (codec.ts, session.ts), and stops everything on request with a barrier. Nothing here talks to the front, the code store or the
// catalog: the caller hands in paths (code, layers, agent, image) and an event, and gets back one outcome.
//
// RULES, each with a test (tests/unit/worker-function-runner-controller.test.ts):
//   1. ARGV. Every `docker run` is built from a typed spec and re-checked against the allow-list before the launcher sees it; every control command (kill, rm, inspect) is one of four fixed shapes on a name this module made.
//   2. ONE INVOKE PER ENVIRONMENT at a time, up to the pool's `maxConcurrency` environments per function and version; one more is throttled, never queued. Warm environments are reused until `idleTimeoutMs`.
//   3. MEMORY. Every environment reserves its `--memory` against the run's function budget from before its container exists until its container is CONFIRMED gone. A start that does not fit first evicts idle environments
//      (least recently used first, anywhere in the controller) and waits for stops in progress; if it still does not fit it is throttled ("memory"). A function larger than the whole budget runs clamped to it.
//   4. A STOP IS A BARRIER. `stopFunction` and `stopAll` resolve true only when every container of the function is confirmed removed (`docker rm` said so, or said there is none) AND its docker client has exited.
//      After that no invoke can reach the function.
//   5. DEADLINES. The agent is told the deadline; the worker kills the container `backstopMs` after it and reports `timeout`. A crash reports the exit and whether the kernel's OOM killer did it.
//   6. THE REAPER (fixes the parked branch's leak). The parked reaper counted an environment as reaped after a forced kill of a stuck stop but never freed its record, address or memory. Here EVERY path that confirms a
//      container gone ends in `finalize`, exactly once (`ensureGone`); the reaper only retries unconfirmed stops, supersedes a stop that hangs past `stuckStopMs`, and ends idle and overdue-start environments. An
//      environment whose stop cannot be confirmed keeps its memory reserved (the container may still be running) and is retried on every tick.
// Logs from this module are fixed shapes only (`SandboxLogEvent`): never a function name, a payload, a variable or docker's own text.

import { randomUUID, createHash } from "node:crypto";
import { mkdir, rm, chmod } from "node:fs/promises";
import { lengthPrefixedJsonCodec, MAX_FRAME_BYTES, MAX_PAYLOAD_BYTES, REQUEST_ID, type AgentCodec, type ResultFrame } from "./codec.js";
import type { SandboxLauncher } from "./launcher.js";
import { SandboxSession } from "./session.js";
import {
  controlArgProblems, functionCpus, inspectIdArgs, inspectStateArgs, killArgs, removeArgs, sandboxContainerName, sandboxRunArgs, SandboxSpecError,
  ENV_MAX_TOTAL, ENV_MAX_VALUE, ENV_NAME, SANDBOX_TMPFS_MAX_MIB, type RunLabel, type SandboxNetwork, type SandboxScratch, type SandboxSpec,
} from "./sandbox-spec.js";

/** The one docker call this module needs: structurally the worker's `DockerCli.run`. */
export interface DockerControl {
  run(args: readonly string[], options?: { timeoutMs?: number }): Promise<{ exitCode: number | null; stdout: Buffer | string; stderr: string }>;
}

export interface FunctionKey {
  functionName: string;
  version: string;
}

export interface FunctionConfig {
  runtime: string;
  handler: string;
  /** The function's own variables. The controller adds the reserved ones (_HANDLER, AWS_LAMBDA_*, AWS_REGION, ...) and refuses a function that sets one. Passed as `docker run -e`. */
  environment: Readonly<Record<string, string>>;
  region?: string;
  functionArn?: string;
  memoryMb: number;
  timeoutSeconds: number;
  ephemeralMb: number;
  /** The AWS Lambda base image for the runtime, by digest, tag or id (the catalog provides it). */
  image: string;
  /** The agent binary on the worker (lane A1). */
  agentHostPath: string;
  agentArgs?: readonly string[];
  /** The unpacked function code (lane W2's store). */
  codeHostPath: string;
  /** The unpacked layers, in order, as one tree (lane W2's store). */
  layersHostPath?: string;
  extraMounts?: ReadonlyArray<{ hostPath: string; containerPath: string }>;
  network: SandboxNetwork;
  /** At most this many environments of the function and version at once. */
  maxConcurrency: number;
}

/** Where `/tmp` lives. `tmpfs` is size-capped but counts as the container's memory; `host-dir` gives each environment a folder under `baseDir` (disk-backed; its size cap is the host's to enforce). */
export type ScratchPolicy = { kind: "tmpfs" } | { kind: "host-dir"; baseDir: string };

export interface SandboxLogEvent {
  event: "cold_start" | "warm_hit" | "throttled" | "evicted" | "idle_reaped" | "stopped" | "stop_unconfirmed" | "stop_superseded" | "timeout" | "crash" | "init_error" | "start_failed" | "protocol_error" | "retired";
  environmentId?: string;
  reason?: string;
}

export interface SandboxControllerOptions {
  docker: DockerControl;
  launcher: SandboxLauncher;
  /** The most memory (MiB) all function sandboxes together may reserve: the run's budget (about 3 GiB) less the helpers. */
  memoryBudgetMiB: number;
  /** The run's labels, on every sandbox, so the worker-start sweep can find them. */
  labels: readonly RunLabel[];
  codec?: AgentCodec;
  scratch?: ScratchPolicy;
  /** Lambda allows executing files in /tmp, so the tmpfs does by default. */
  tmpExec?: boolean;
  idleTimeoutMs?: number;
  /** A start older than this is cancelled by the reaper. */
  startLimitMs?: number;
  /** A stop that has not ended within this is superseded by a second, forced attempt. */
  stuckStopMs?: number;
  /** How long after the deadline the worker kills the container. */
  backstopMs?: number;
  maxFrameBytes?: number;
  exitWaitMs?: number;
  dockerCallMs?: number;
  /** CPUs pro rata (1 vCPU per 1,769 MB), clamped. A tenth of a CPU would make a cold numpy import take ten seconds. */
  minCpus?: number;
  maxCpus?: number;
  /** Reads the container's cgroup peak memory in bytes, given its full id. Production passes `readCgroupMemoryPeak`. */
  readMemoryPeak?: (containerId: string) => Promise<number | undefined>;
  log?: (event: SandboxLogEvent) => void;
  now?: () => number;
  newEnvironmentId?: () => string;
  makeScratchDir?: (path: string) => Promise<void>;
  removeScratchDir?: (path: string) => Promise<void>;
  /** Starts the reaper's timer (default true). Tests call `reap` themselves. */
  autoReap?: boolean;
  reapIntervalMs?: number;
}

export interface InvokeRequest {
  key: FunctionKey;
  requestId: string;
  /** The event, as the bytes the function receives (at most 6,291,556). */
  payload: Buffer | string;
  /** Overrides the function's Timeout for this call (for example the engine's 28 s ceiling). */
  timeoutMs?: number;
  invokedFunctionArn?: string;
  traceId?: string;
  clientContext?: string;
  cognitoIdentity?: string;
}

export interface InvokeReport {
  durationMs?: number;
  billedDurationMs?: number;
  initDurationMs?: number;
}

interface Detail {
  environmentId: string;
  /** True when this call started the environment. */
  cold: boolean;
  /** Launch to the runtime's readiness (the agent's `ready`), or, when the agent never said so, to the first answer (which then includes the handler's own time). Cold calls only. */
  coldStartMs?: number;
  wallMs: number;
  /** The memory limit this environment ran under (the function's, or the whole budget when it asked for more). */
  memoryMb: number;
  memoryClamped: boolean;
  /** This call's log as the agent wrote it: START, the runtime's output, END, REPORT. */
  logTail: string;
  logsTruncated: boolean;
  /** What the runtime printed while starting, on the call that started it. */
  initLogTail?: string;
  report?: InvokeReport;
  /** The container's peak memory in bytes: read host-side from its cgroup (since the container started) when the controller was given a reader, else the agent's own sampling for this call. */
  maxMemoryUsedBytes?: number;
}

export type InvokeOutcome =
  | ({ kind: "response"; payload: Buffer } & Detail)
  /** The function raised: `payload` is the error document the runtime posted (what Lambda returns with `X-Amz-Function-Error: Unhandled`). The sandbox stays warm. */
  | ({ kind: "error"; errorType: string; errorMessage: string; payload: Buffer } & Detail)
  /** The runtime did not come up. The sandbox is removed. */
  | ({ kind: "init_error"; errorType: string; errorMessage: string; payload: Buffer } & Detail)
  /** The deadline passed (the agent said so, or the worker's backstop fired). The sandbox is removed. */
  | ({ kind: "timeout"; errorType: string; errorMessage: string } & Detail)
  /** The runtime or the whole sandbox died. `oomKilled` is the kernel's word (docker inspect); `exitCode` is null when the agent, not docker, reported it. The sandbox is removed. */
  | ({ kind: "crash"; exitCode: number | null; signal: string | null; oomKilled: boolean; errorType: string; errorMessage: string } & Detail)
  /** The agent refused the call before running it (payload too large, bad id). The sandbox stays warm. */
  | ({ kind: "rejected"; errorType: string; errorMessage: string } & Detail)
  | { kind: "throttled"; reason: "concurrency" | "memory" }
  | { kind: "unavailable"; reason: "not_registered" | "closed" | "start_failed" | "protocol_error" | "stopped" | "invalid_request"; /** Docker's or the agent's own text, control characters removed; for diagnosis only. */ detail?: string };

export interface PoolMetrics {
  invocations: number;
  coldStarts: number;
  warmStarts: number;
  throttled: number;
  timeouts: number;
  crashes: number;
  ooms: number;
  initErrors: number;
  startFailures: number;
  evictions: number;
  idleReaped: number;
  coldStartMsTotal: number;
  coldStartMsMax: number;
  lastColdStartMs: number | undefined;
}

const newMetrics = (): PoolMetrics => ({ invocations: 0, coldStarts: 0, warmStarts: 0, throttled: 0, timeouts: 0, crashes: 0, ooms: 0, initErrors: 0, startFailures: 0, evictions: 0, idleReaped: 0, coldStartMsTotal: 0, coldStartMsMax: 0, lastColdStartMs: undefined });

type Phase = "reserving" | "starting" | "idle" | "busy" | "stopping" | "gone";

interface Environment {
  id: string;
  container: string;
  pool: Pool;
  phase: Phase;
  /** MiB reserved against the budget; zero until the reservation is made and again after `finalize`. */
  reservedMiB: number;
  memoryMb: number;
  session: SandboxSession | undefined;
  lastUsedMs: number;
  createdMs: number;
  cancelled: boolean;
  /** The scratch folder made for this environment, removed at finalize. */
  scratchDir: string | undefined;
  containerId: string | undefined;
  attempt: Promise<boolean> | undefined;
  attemptStartedMs: number | undefined;
  /** The pool's configuration hash when this environment was made: a later change retires it when its call ends. */
  hash: string;
}

interface Pool {
  key: FunctionKey;
  config: FunctionConfig;
  hash: string;
  envs: Set<Environment>;
  closing: boolean;
  metrics: PoolMetrics;
}

const poolId = (key: FunctionKey): string => `${key.functionName}\0${key.version}`;
const NAME_TEXT = /^[^\p{Cc}\p{Cf}]{1,140}$/u;
const FUNCTION_ENV_MAX_ENTRIES = 256;
const FUNCTION_ENV_MAX_TOTAL = 64 * 1024;
const NOT_FOUND = /no such (?:container|object)/iu;
/** Variables the controller sets itself; a function that sets one is refused, as AWS refuses it at create time. */
export const RESERVED_ENVIRONMENT_NAMES: ReadonlySet<string> = new Set([
  "_HANDLER", "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_EXECUTION_ENV", "AWS_LAMBDA_FUNCTION_NAME", "AWS_LAMBDA_FUNCTION_VERSION", "AWS_LAMBDA_FUNCTION_MEMORY_SIZE", "AWS_LAMBDA_LOG_GROUP_NAME",
  "AWS_LAMBDA_LOG_STREAM_NAME", "AWS_LAMBDA_INITIALIZATION_TYPE", "AWS_LAMBDA_RUNTIME_API", "LAMBDA_TASK_ROOT", "LAMBDA_RUNTIME_DIR", "PATH", "LD_LIBRARY_PATH", "LANG", "TZ",
]);

/** Throws RangeError (fixed text) when `key` or `config` is not one the controller will run. */
export function validateFunctionConfig(key: FunctionKey, config: FunctionConfig): void {
  const bad = (what: string): never => { throw new RangeError(`not a valid function configuration: ${what}`); };
  if (!NAME_TEXT.test(key.functionName) || !/^[^\p{Cc}\p{Cf}]{1,64}$/u.test(key.version)) bad("name or version");
  if (!/^[a-z0-9.]{1,32}$/u.test(config.runtime)) bad("runtime");
  if (!/^[^\p{Cc}\p{Cf}]{1,256}$/u.test(config.handler)) bad("handler");
  const names = Object.keys(config.environment);
  if (names.length > FUNCTION_ENV_MAX_ENTRIES) bad("environment size");
  let total = 0;
  for (const name of names) {
    const value = config.environment[name]!;
    if (!ENV_NAME.test(name) || RESERVED_ENVIRONMENT_NAMES.has(name) || typeof value !== "string" || value.length > ENV_MAX_VALUE || value.includes("\0")) bad("environment entry");
    total += name.length + value.length;
  }
  if (total > Math.min(ENV_MAX_TOTAL, FUNCTION_ENV_MAX_TOTAL)) bad("environment size");
  if (!Number.isInteger(config.memoryMb) || config.memoryMb < 6) bad("memory");
  if (!Number.isInteger(config.timeoutSeconds) || config.timeoutSeconds < 1 || config.timeoutSeconds > 900) bad("timeout");
  if (!Number.isInteger(config.ephemeralMb) || config.ephemeralMb < 1) bad("ephemeral storage");
  if (!Number.isInteger(config.maxConcurrency) || config.maxConcurrency < 1 || config.maxConcurrency > 64) bad("concurrency");
}

function configHash(config: FunctionConfig): string {
  return createHash("sha256").update(JSON.stringify(config, (_key, value: unknown) => (value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1))) : value))).digest("hex");
}

export interface SandboxController {
  /** Declares (or changes) a function version. A changed configuration retires the old environments: idle ones are stopped now, busy ones when their call ends. */
  register(key: FunctionKey, config: FunctionConfig): Promise<void>;
  invoke(request: InvokeRequest): Promise<InvokeOutcome>;
  /** The barrier: true when every sandbox of the function and version is confirmed gone. Later invokes get `not_registered`. */
  stopFunction(key: FunctionKey): Promise<boolean>;
  /** Stops every sandbox of every function; the controller then refuses new work. True when none is left. */
  stopAll(): Promise<boolean>;
  /** Ends what is due (idle, overdue starts, failed or hung stops). Returns how many environments it confirmed gone. */
  reap(): Promise<number>;
  stats(): { environments: number; idle: number; busy: number; stopping: number; reservedMiB: number; budgetMiB: number };
  metrics(): { total: PoolMetrics; functions: Array<{ functionName: string; version: string; metrics: PoolMetrics }> };
}

export function createSandboxController(options: SandboxControllerOptions): SandboxController {
  if (!Number.isSafeInteger(options.memoryBudgetMiB) || options.memoryBudgetMiB < 1) throw new RangeError("the sandbox controller needs a memory budget");
  const { docker, launcher } = options;
  const codec = options.codec ?? lengthPrefixedJsonCodec;
  const now = options.now ?? Date.now;
  const idleTimeoutMs = options.idleTimeoutMs ?? 10 * 60_000;
  const startLimitMs = options.startLimitMs ?? 120_000;
  const stuckStopMs = options.stuckStopMs ?? 30_000;
  const backstopMs = options.backstopMs ?? 1_000;
  const exitWaitMs = options.exitWaitMs ?? 5_000;
  const dockerCallMs = options.dockerCallMs ?? 60_000;
  const minCpus = options.minCpus ?? 0.5;
  const maxCpus = options.maxCpus ?? 2;
  const scratchPolicy: ScratchPolicy = options.scratch ?? { kind: "tmpfs" };
  const newId = options.newEnvironmentId ?? ((): string => randomUUID());
  const makeScratchDir = options.makeScratchDir ?? (async (path: string): Promise<void> => { await mkdir(path, { recursive: true, mode: 0o1777 }); await chmod(path, 0o1777); });
  const removeScratchDir = options.removeScratchDir ?? (async (path: string): Promise<void> => { await rm(path, { recursive: true, force: true }); });
  const log = (event: SandboxLogEvent): void => { try { options.log?.(event); } catch { /* a log sink must not change what the controller does */ } };

  const pools = new Map<string, Pool>();
  const environments = new Map<string, Environment>();
  const total = newMetrics();
  let reservedMiB = 0;
  let closed = false;

  const bump = (pool: Pool, field: keyof Omit<PoolMetrics, "lastColdStartMs" | "coldStartMsMax">, by = 1): void => { pool.metrics[field] += by; total[field] += by; };

  // ---- docker control commands

  async function control(args: string[]): Promise<{ ok: boolean; notFound: boolean; stdout: string }> {
    if (controlArgProblems(args).length > 0) return { ok: false, notFound: false, stdout: "" };
    const result = await docker.run(args, { timeoutMs: dockerCallMs }).catch((error: unknown) => ({ exitCode: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }));
    return { ok: result.exitCode === 0, notFound: NOT_FOUND.test(result.stderr), stdout: typeof result.stdout === "string" ? result.stdout : result.stdout.toString("utf8") };
  }

  // ---- ending an environment

  /** The one place an environment's bookkeeping is released. Called only after its container is confirmed gone; idempotent. */
  function finalize(env: Environment): void {
    if (env.phase === "gone") return;
    env.phase = "gone";
    env.pool.envs.delete(env);
    environments.delete(env.id);
    reservedMiB = Math.max(0, reservedMiB - env.reservedMiB);
    env.reservedMiB = 0;
  }

  /**
   * Ends one environment and, only when its container is confirmed gone (`docker rm` succeeded or found none, after the docker client exited), releases everything it held. Concurrent callers share one attempt. Returns
   * false when the stop could not be confirmed: the environment stays, "stopping", with its memory reserved, for the reaper to retry.
   */
  function ensureGone(env: Environment): Promise<boolean> {
    if (env.phase === "gone") return Promise.resolve(true);
    if (env.attempt !== undefined) return env.attempt;
    env.phase = "stopping";
    env.cancelled = true;
    env.attemptStartedMs = now();
    const self: { promise?: Promise<boolean> } = {};
    const attempt = (async (): Promise<boolean> => {
      const session = env.session;
      session?.cancel();
      // The container first (a running one ends and its docker client follows), then the client, then the removal: a start still in flight cannot create it behind our back once its client is dead.
      await control(killArgs(env.container));
      session?.killClient();
      if (session !== undefined) {
        let wake: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([session.exited, new Promise<void>((resolve) => { wake = setTimeout(resolve, exitWaitMs); })]);
        clearTimeout(wake);
      }
      const removed = await control(removeArgs(env.container));
      const confirmed = (removed.ok || removed.notFound) && (session === undefined || session.exit !== undefined);
      if (!confirmed) {
        if (env.attempt === self.promise) env.attempt = undefined;
        log({ event: "stop_unconfirmed", environmentId: env.id });
        return false;
      }
      if (env.scratchDir !== undefined) await removeScratchDir(env.scratchDir).catch(() => undefined);
      finalize(env);
      log({ event: "stopped", environmentId: env.id });
      return true;
    })();
    self.promise = attempt;
    env.attempt = attempt;
    return attempt;
  }

  // ---- memory

  const idleVictim = (): Environment | undefined => [...environments.values()].filter((env) => env.phase === "idle").sort((a, b) => a.lastUsedMs - b.lastUsedMs)[0];

  /** Reserves `need` MiB, evicting idle environments (least recently used first) and waiting for stops in progress. False when it cannot fit. */
  async function makeRoom(need: number): Promise<boolean> {
    for (;;) {
      if (closed) return false;
      if (reservedMiB + need <= options.memoryBudgetMiB) { reservedMiB += need; return true; }
      const victim = idleVictim();
      if (victim !== undefined) {
        bump(victim.pool, "evictions");
        log({ event: "evicted", environmentId: victim.id });
        await ensureGone(victim);
        continue;
      }
      const stopping = [...environments.values()].filter((env) => env.phase === "stopping" && env.attempt !== undefined).map((env) => env.attempt!);
      if (stopping.length === 0) return false;
      // A stop that fails leaves its environment without an attempt, so the next pass does not wait on it again.
      await Promise.race(stopping);
    }
  }

  // ---- starting

  /** The sandbox's whole environment: the function's own variables, then the reserved ones (which a function cannot set, so they always win). PATH, LD_LIBRARY_PATH and LANG come from the base image's own ENV. */
  function environmentFor(env: Environment, memoryMb: number): Record<string, string> {
    const { config, key } = env.pool;
    const region = config.region ?? "us-east-1";
    return {
      ...config.environment,
      _HANDLER: config.handler,
      AWS_REGION: region,
      AWS_DEFAULT_REGION: region,
      AWS_EXECUTION_ENV: `AWS_Lambda_${config.runtime}`,
      AWS_LAMBDA_FUNCTION_NAME: key.functionName,
      AWS_LAMBDA_FUNCTION_VERSION: key.version,
      AWS_LAMBDA_FUNCTION_MEMORY_SIZE: String(memoryMb),
      AWS_LAMBDA_LOG_GROUP_NAME: `/aws/lambda/${key.functionName}`,
      AWS_LAMBDA_LOG_STREAM_NAME: `${new Date(now()).toISOString().slice(0, 10).replaceAll("-", "/")}/[${key.version}]${env.id.replace(/[^a-z0-9]/gu, "").slice(0, 32)}`,
      AWS_LAMBDA_INITIALIZATION_TYPE: "on-demand",
      LAMBDA_TASK_ROOT: "/var/task",
      LAMBDA_RUNTIME_DIR: "/var/runtime",
      TZ: ":UTC",
    };
  }

  async function startContainer(env: Environment, memoryMb: number): Promise<void> {
    const { config } = env.pool;
    let scratch: SandboxScratch;
    if (scratchPolicy.kind === "host-dir") {
      env.scratchDir = `${scratchPolicy.baseDir}/${env.id}`;
      await makeScratchDir(env.scratchDir);
      scratch = { kind: "host-dir", hostPath: env.scratchDir };
    } else {
      scratch = { kind: "tmpfs", sizeMb: Math.min(SANDBOX_TMPFS_MAX_MIB, config.ephemeralMb) };
    }
    const spec: SandboxSpec = {
      environmentId: env.id, image: config.image, agentHostPath: config.agentHostPath, ...(config.agentArgs === undefined ? {} : { agentArgs: config.agentArgs }),
      codeHostPath: config.codeHostPath, ...(config.layersHostPath === undefined ? {} : { layersHostPath: config.layersHostPath }), ...(config.extraMounts === undefined ? {} : { extraMounts: config.extraMounts }),
      environment: environmentFor(env, memoryMb), memoryMb, cpus: functionCpus(memoryMb, minCpus, maxCpus), scratch, tmpExec: options.tmpExec ?? true, network: config.network, labels: options.labels,
    };
    // Built from the typed spec and re-checked against the allow-list inside `sandboxRunArgs`: unsound arguments never reach the launcher.
    const args = sandboxRunArgs(spec);
    const session = new SandboxSession(launcher.start(args), {
      codec, maxFrameBytes: options.maxFrameBytes ?? MAX_FRAME_BYTES, now,
      // A runtime that died while idle makes the environment useless (the agent would restart it, with this sandbox's /tmp kept): remove it.
      onRuntimeExit: () => { if (env.phase === "idle") void ensureGone(env); },
    });
    env.session = session;
    env.phase = "starting";
    // An environment whose process ends while it is idle is cleaned up at once; the reaper is the fallback.
    void session.exited.then(() => { if (env.phase === "idle") void ensureGone(env); });
  }

  async function readPeak(env: Environment): Promise<number | undefined> {
    if (options.readMemoryPeak === undefined) return undefined;
    try {
      if (env.containerId === undefined) {
        const id = await control(inspectIdArgs(env.container));
        const text = id.stdout.trim();
        if (!id.ok || !/^[a-f0-9]{64}$/u.test(text)) return undefined;
        env.containerId = text;
      }
      return await options.readMemoryPeak(env.containerId);
    } catch {
      return undefined;
    }
  }

  async function oomKilled(env: Environment): Promise<boolean> {
    const state = await control(inspectStateArgs(env.container));
    if (!state.ok) return false;
    try {
      return (JSON.parse(state.stdout.trim()) as { OOMKilled?: unknown }).OOMKilled === true;
    } catch {
      return false;
    }
  }

  // ---- invoke

  function detail(env: Environment, cold: boolean, startedMs: number, result?: ResultFrame): Detail {
    const session = env.session;
    const report: InvokeReport = {
      ...(result?.durationMs === undefined ? {} : { durationMs: result.durationMs }), ...(result?.billedDurationMs === undefined ? {} : { billedDurationMs: result.billedDurationMs }),
      ...(result?.initDurationMs === undefined ? {} : { initDurationMs: result.initDurationMs }),
    };
    return {
      environmentId: env.id, cold, wallMs: now() - startedMs, memoryMb: env.memoryMb, memoryClamped: env.memoryMb < env.pool.config.memoryMb, logTail: result?.logTail ?? "", logsTruncated: result?.logTruncated === true,
      ...(cold && session !== undefined ? { coldStartMs: (session.readyAtMs ?? now()) - session.startedAtMs } : {}),
      ...(cold && session?.initLogTail !== undefined ? { initLogTail: session.initLogTail } : {}),
      ...(Object.keys(report).length === 0 ? {} : { report }),
    };
  }

  function recordCold(pool: Pool, ms: number | undefined): void {
    bump(pool, "coldStarts");
    if (ms === undefined) return;
    bump(pool, "coldStartMsTotal", ms);
    pool.metrics.coldStartMsMax = Math.max(pool.metrics.coldStartMsMax, ms);
    total.coldStartMsMax = Math.max(total.coldStartMsMax, ms);
    pool.metrics.lastColdStartMs = ms;
    total.lastColdStartMs = ms;
  }

  const startFailure = (pool: Pool, reason: string, text?: string): InvokeOutcome => {
    bump(pool, "startFailures");
    log({ event: "start_failed", reason });
    return { kind: "unavailable", reason: "start_failed", ...(text === undefined || text === "" ? {} : { detail: text.slice(0, 500) }) };
  };

  async function invoke(request: InvokeRequest): Promise<InvokeOutcome> {
    if (closed) return { kind: "unavailable", reason: "closed" };
    const pool = pools.get(poolId(request.key));
    if (pool === undefined || pool.closing) return { kind: "unavailable", reason: "not_registered" };
    const payload = typeof request.payload === "string" ? Buffer.from(request.payload, "utf8") : request.payload;
    if (!REQUEST_ID.test(request.requestId) || payload.length > MAX_PAYLOAD_BYTES) return { kind: "unavailable", reason: "invalid_request" };
    bump(pool, "invocations");
    const startedMs = now();

    // A warm environment: the most recently used idle one whose process is still alive.
    let env = [...pool.envs].filter((candidate) => candidate.phase === "idle" && candidate.session !== undefined && !candidate.session.dead).sort((a, b) => b.lastUsedMs - a.lastUsedMs)[0];
    let cold = false;
    if (env !== undefined) {
      env.phase = "busy";
      bump(pool, "warmStarts");
      log({ event: "warm_hit", environmentId: env.id });
    } else {
      if (pool.envs.size >= pool.config.maxConcurrency) {
        bump(pool, "throttled");
        log({ event: "throttled", reason: "concurrency" });
        return { kind: "throttled", reason: "concurrency" };
      }
      cold = true;
      const need = Math.min(pool.config.memoryMb, options.memoryBudgetMiB);
      const id = newId();
      env = { id, container: sandboxContainerName(id), pool, phase: "reserving", reservedMiB: 0, memoryMb: need, session: undefined, lastUsedMs: now(), createdMs: now(), cancelled: false, scratchDir: undefined, containerId: undefined, attempt: undefined, attemptStartedMs: undefined, hash: pool.hash };
      pool.envs.add(env);
      environments.set(id, env);
      const room = await makeRoom(need);
      if (!room || env.cancelled || closed || pool.closing) {
        if (room) reservedMiB = Math.max(0, reservedMiB - need);
        pool.envs.delete(env);
        environments.delete(id);
        env.phase = "gone";
        if (!room && !env.cancelled && !closed && !pool.closing) {
          bump(pool, "throttled");
          log({ event: "throttled", reason: "memory" });
          return { kind: "throttled", reason: "memory" };
        }
        return { kind: "unavailable", reason: closed ? "closed" : "stopped" };
      }
      env.reservedMiB = need;
      try {
        await startContainer(env, need);
      } catch (error) {
        await ensureGone(env);
        return startFailure(pool, error instanceof SandboxSpecError ? "spec" : "launch");
      }
      if (env.cancelled) { await ensureGone(env); return { kind: "unavailable", reason: "stopped" }; }
      env.phase = "busy";
      log({ event: "cold_start", environmentId: env.id });
    }

    const live = env;
    const timeoutMs = request.timeoutMs ?? pool.config.timeoutSeconds * 1000;
    const raw = await live.session!.invoke({
      requestId: request.requestId, payload: payload.toString("base64"), timeoutMs, backstopMs, functionVersion: pool.key.version, memorySizeMb: live.memoryMb,
      ...(pool.config.functionArn === undefined && request.invokedFunctionArn === undefined ? {} : { functionArn: request.invokedFunctionArn ?? pool.config.functionArn! }),
      ...(request.traceId === undefined ? {} : { traceId: request.traceId }),
      ...(request.clientContext === undefined ? {} : { clientContext: request.clientContext }),
      ...(request.cognitoIdentity === undefined ? {} : { cognitoIdentity: request.cognitoIdentity }),
    });

    switch (raw.kind) {
      case "result": {
        const result = raw.result;
        const answer = result.payload === undefined ? Buffer.alloc(0) : Buffer.from(result.payload, "base64");
        const errorType = result.errorType ?? "Unknown";
        const errorMessage = result.errorMessage ?? "";
        const hostPeak = await readPeak(live);
        const peak = hostPeak ?? result.maxMemoryUsed;
        const base: Detail = { ...detail(live, cold, startedMs, result), ...(peak === undefined ? {} : { maxMemoryUsedBytes: peak }) };
        if (cold) recordCold(pool, base.coldStartMs);
        live.lastUsedMs = now();
        switch (result.status) {
          case "ok":
          case "function_error":
          case "rejected":
            // The runtime stays warm after its own error, and after a refusal that ran nothing.
            if (live.phase === "busy") {
              if (pool.closing || live.hash !== pool.hash || live.cancelled || closed) void ensureGone(live);
              else live.phase = "idle";
            }
            if (result.status === "ok") return { kind: "response", payload: answer, ...base };
            if (result.status === "rejected") return { kind: "rejected", errorType, errorMessage, ...base };
            return { kind: "error", errorType, errorMessage, payload: answer, ...base };
          case "init_error":
            bump(pool, "initErrors");
            log({ event: "init_error", environmentId: live.id });
            void ensureGone(live);
            return { kind: "init_error", errorType, errorMessage, payload: answer, ...base };
          case "timeout":
            bump(pool, "timeouts");
            log({ event: "timeout", environmentId: live.id, reason: "agent" });
            await ensureGone(live);
            return { kind: "timeout", errorType, errorMessage, ...base };
          case "crash": {
            // A killed or crashed runtime leaves a sandbox with a half-used /tmp: it is removed, as Lambda replaces the environment. The agent usually survives, so the kernel's OOM flag is rarely set here.
            const oom = await oomKilled(live);
            await ensureGone(live);
            bump(pool, "crashes");
            if (oom) bump(pool, "ooms");
            log({ event: "crash", environmentId: live.id, reason: "runtime" });
            return { kind: "crash", exitCode: null, signal: null, oomKilled: oom, errorType, errorMessage, ...base };
          }
        }
        break;
      }
      case "timeout": {
        // The agent did not answer by its own deadline: the worker kills the sandbox.
        bump(pool, "timeouts");
        log({ event: "timeout", environmentId: live.id, reason: "backstop" });
        const base = detail(live, cold, startedMs);
        await ensureGone(live);
        return { kind: "timeout", errorType: "Sandbox.Timedout", errorMessage: `Task timed out after ${(timeoutMs / 1000).toFixed(2)} seconds`, ...base };
      }
      case "exit": {
        const base = detail(live, cold, startedMs);
        // Docker's own failures (the runtime is not registered, the image is missing) exit 125 to 127 before the agent says anything.
        if (!raw.sawFrames && raw.exit.code !== null && raw.exit.code >= 125 && raw.exit.code <= 127) {
          const text = live.session!.stderrTail();
          await ensureGone(live);
          return startFailure(pool, "docker", text);
        }
        if (raw.fatal !== undefined && raw.exit.code !== null && raw.exit.code !== 137) {
          await ensureGone(live);
          return startFailure(pool, "agent", raw.fatal);
        }
        const oom = await oomKilled(live);
        await ensureGone(live);
        bump(pool, "crashes");
        if (oom) bump(pool, "ooms");
        log({ event: "crash", environmentId: live.id, reason: oom ? "oom" : "exit" });
        return { kind: "crash", exitCode: raw.exit.code, signal: raw.exit.signal, oomKilled: oom, errorType: oom ? "Runtime.OutOfMemory" : "Runtime.ExitError", errorMessage: oom ? "The sandbox ran out of memory" : "The sandbox exited", ...base };
      }
      case "protocol_error": {
        log({ event: "protocol_error", environmentId: live.id, reason: raw.reason });
        await ensureGone(live);
        return { kind: "unavailable", reason: "protocol_error" };
      }
      case "stopped":
        await ensureGone(live);
        return { kind: "unavailable", reason: "stopped" };
    }
    return { kind: "unavailable", reason: "protocol_error" };
  }

  // ---- registration and stopping

  async function register(key: FunctionKey, config: FunctionConfig): Promise<void> {
    validateFunctionConfig(key, config);
    if (closed) throw new RangeError("the sandbox controller is closed");
    const id = poolId(key);
    const hash = configHash(config);
    const existing = pools.get(id);
    if (existing === undefined || existing.closing) {
      pools.set(id, { key: { ...key }, config, hash, envs: new Set(), closing: false, metrics: existing?.metrics ?? newMetrics() });
      return;
    }
    if (existing.hash === hash) return;
    existing.config = config;
    existing.hash = hash;
    const stops: Array<Promise<boolean>> = [];
    for (const env of existing.envs) {
      if (env.phase === "idle") { log({ event: "retired", environmentId: env.id }); stops.push(ensureGone(env)); }
    }
    await Promise.all(stops);
  }

  async function stopFunction(key: FunctionKey): Promise<boolean> {
    const pool = pools.get(poolId(key));
    if (pool === undefined) return true;
    pool.closing = true;
    const envs = [...pool.envs];
    for (const env of envs) env.cancelled = true;
    const results = await Promise.all(envs.filter((env) => env.phase !== "reserving").map((env) => ensureGone(env)));
    if (!results.every(Boolean)) return false;
    pools.delete(poolId(key));
    return true;
  }

  async function stopAll(): Promise<boolean> {
    closed = true;
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    const results = await Promise.all([...pools.values()].map((pool) => stopFunction(pool.key)));
    // Anything that slipped past a pool (a start that was reserving) is ended too.
    const rest = await Promise.all([...environments.values()].filter((env) => env.phase !== "reserving").map((env) => ensureGone(env)));
    return results.every(Boolean) && rest.every(Boolean) && reservedMiB === 0;
  }

  // ---- the reaper

  async function reap(): Promise<number> {
    const at = now();
    let reaped = 0;
    const work: Array<Promise<void>> = [];
    const end = (env: Environment, event: SandboxLogEvent["event"], reason: string): void => {
      log({ event, environmentId: env.id, reason });
      work.push(ensureGone(env).then((gone) => { if (gone) reaped += 1; }));
    };
    for (const env of [...environments.values()]) {
      if (env.phase === "idle" && env.session?.dead === true) {
        end(env, "idle_reaped", "dead");
      } else if (env.phase === "idle" && at - env.lastUsedMs > idleTimeoutMs) {
        bump(env.pool, "idleReaped");
        end(env, "idle_reaped", "idle");
      } else if (env.phase === "starting" && at - env.createdMs > startLimitMs) {
        env.cancelled = true;
        end(env, "stopped", "start_overdue");
      } else if (env.phase === "stopping" && env.attempt === undefined) {
        // A stop that could not be confirmed earlier: try again.
        end(env, "stopped", "retry");
      } else if (env.phase === "stopping" && env.attempt !== undefined && env.attemptStartedMs !== undefined && at - env.attemptStartedMs > stuckStopMs) {
        // A stop that hangs: supersede it with a second, forced attempt. Whichever confirms first runs `finalize`, so the record, the memory and the scratch folder are freed exactly once (the parked reaper never freed them).
        env.attempt = undefined;
        log({ event: "stop_superseded", environmentId: env.id });
        end(env, "stopped", "stuck");
      }
    }
    await Promise.all(work);
    return reaped;
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  if (options.autoReap !== false) {
    timer = setInterval(() => { void reap().catch(() => undefined); }, options.reapIntervalMs ?? 30_000);
    timer.unref();
  }

  return {
    register, invoke, stopFunction, stopAll, reap,
    stats: () => {
      const all = [...environments.values()];
      return { environments: all.length, idle: all.filter((env) => env.phase === "idle").length, busy: all.filter((env) => env.phase === "busy" || env.phase === "starting").length, stopping: all.filter((env) => env.phase === "stopping").length, reservedMiB, budgetMiB: options.memoryBudgetMiB };
    },
    metrics: () => ({ total: { ...total }, functions: [...pools.values()].map((pool) => ({ functionName: pool.key.functionName, version: pool.key.version, metrics: { ...pool.metrics } })) }),
  };
}

/** Production's reader for `readMemoryPeak`: the container's cgroup `memory.peak` (cgroup v2), under the cgroupfs or the systemd driver's layout. */
export async function readCgroupMemoryPeak(containerId: string, root = "/sys/fs/cgroup"): Promise<number | undefined> {
  if (!/^[a-f0-9]{64}$/u.test(containerId)) return undefined;
  const { readFile } = await import("node:fs/promises");
  for (const path of [`${root}/system.slice/docker-${containerId}.scope/memory.peak`, `${root}/docker/${containerId}/memory.peak`]) {
    try {
      const value = Number((await readFile(path, "utf8")).trim());
      if (Number.isSafeInteger(value) && value >= 0) return value;
    } catch { /* try the next layout */ }
  }
  return undefined;
}

