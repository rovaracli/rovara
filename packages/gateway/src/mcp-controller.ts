// Stdio MCP host redesign (T6, T7), design sections 2, 3 and 6. This REPLACES the lane E host (one root task, a uid per server inside it): there is no uid pool and no root here.
//
// The controller is the small service the broker talks to. It runs no customer code. It authenticates the broker, checks the approval, starts and stops the tasks that DO hold
// customer code (install, probe and serve tasks, through a `TaskRunner`), and forwards MCP requests to the bridge inside a serve task.
//
// Two listeners, two kinds of caller, and no route shared between them:
//   broker listener  (bearer = the broker's token)         POST /install  POST /probe  POST /servers/{id}/mcp  POST /servers/{id}/warm  POST /servers/{id}/release  GET /healthz
//   runner listener  (bearer = one task's own token)        GET /bundles/{hash}  PUT /bundles/{hash}  PUT /result
// A runner's token reaches the runner listener only, and only what `runnerTokenAllows` says: an install task may PUT one bundle and one result; a fetch, serve or probe task may GET the
// one bundle it was approved to run. The server container can read its own token (same uid), so a token is worth nothing else (T4 review I4).
//
// Fail closed: a missing or unreadable approval is a 404 or 503, never a start; every wait and size has a bound; a task that is not exactly the approved one is stopped.
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpStdioProposalSchema, type McpStdioProposal, type McpStdioSpec } from "@agentx/contracts";
import { BUNDLE_LIMITS } from "./mcp-runner/bundle.js";
import type { BundleStore } from "./mcp-runner/bundle-store.js";
import { parseInstallOutcome, type InstallOutcome } from "./mcp-runner/install-result.js";
import { RUNNER_FAMILY_PREFIX, approvalOf, serveFamily, type StopReason, type TaskRunner } from "./mcp-runner/task-runner.js";
import { generateRunnerToken, runnerTokenAllows, runnerTokenWellFormed, type RunnerTokenScope } from "./mcp-runner/token-scope.js";

// ---------------------------------------------------------------------------------------------
// What the controller is given
// ---------------------------------------------------------------------------------------------

export interface ApprovedServer {
  /** The complete spec of an approved entry: its hashes, destinations, secret names and size. */
  spec: McpStdioSpec;
  /** The tools hash the admin approved. A started task whose tools hash differs is stopped (design section 6, "First call"). */
  toolsHash: string;
  /** The version of the server's secret, when it has one. A different version restarts the task (secret replaced). */
  secretVersion?: string | undefined;
  /** The name or ARN of the server's secret in the secret store: how the task definition names it. */
  secretRef?: string | undefined;
}

export interface ControllerRegistry {
  /** The approved entry for an id, or undefined for any other id (not approved, disabled, needs re-approval, unknown). Throws when the registry cannot be read (the controller then answers 503). */
  approved(serverId: string): Promise<ApprovedServer | undefined>;
  /** Told when a started server's tools are not the ones approved. The admin sees the diff; the server is not served until they look. */
  toolsChanged?(serverId: string, change: { approved: string; observed: string }): Promise<void>;
  /**
   * The secret a TEST of a proposal reads (T9). `serverId` is the proposal's own id, named by the broker. It resolves only for an id that has no entry yet (a proposal being tested for the
   * first time) or whose entry is still waiting for approval; for an approved, disabled or other entry it answers undefined, so an approved server's secret never goes into a test of
   * a package the broker names. Absent, or undefined: the test runs with no secrets (and a package that declares secret names then cannot start).
   * Fix round 2 (N1): a PAUSED entry (tools changed after approval) also resolves, but only for the review and re-approve test of that same server: `test` must be its own pinned package, same
   * name, version, arguments and secret names, with both pinned hashes equal. A test of any other package under that id gets no secret.
   */
  probeSecret?(serverId: string, test?: { spec: McpStdioProposal; pinned?: { lockfileHash: string; bundleHash: string } | undefined }): Promise<string | undefined>;
}

/** What a task definition is made from. */
export interface RunnerSpec {
  name: string;
  args: string[];
  secretEnv: string[];
  destinations: Array<{ host: string; port: number }>;
  size: { cpu: number; memoryMiB: number };
  bundleHash: string;
}

/** The per-server task definition and security group (T7). The default (static) one only names the families the infrastructure created. */
export interface ServerResources {
  /** Makes (or confirms) what a task of this server needs, and returns what to start it with. Throws when it cannot (the controller then does not start). */
  ensure(input: { kind: "serve" | "probe"; id: string; spec: RunnerSpec; secretRef?: string | undefined }): Promise<{ family: string; taskDefinition: string; securityGroupId?: string | undefined }>;
  /** Removes them: deregisters the task definition and deletes the security group. */
  release(kind: "serve" | "probe", id: string): Promise<void>;
  /** The servers that have resources, for reconcile. */
  list?(): Promise<Array<{ kind: "serve" | "probe"; id: string }>>;
}

export const staticServerResources: ServerResources = {
  async ensure(input) { const family = input.kind === "serve" ? serveFamily(input.id) : `${RUNNER_FAMILY_PREFIX}probe`; return { family, taskDefinition: family }; },
  async release() { /* nothing was made */ },
};

/**
 * Which controller instances are alive. Two instances can run side by side for a while (a deploy), and each must judge only its own tasks. A task of another instance is stopped only when
 * that instance's lease has run out. Without leases no other instance's task is ever judged.
 */
export interface InstanceLeases {
  /** Records that this instance is alive for the next while. */
  renew(): Promise<void>;
  /** Whether the instance renewed its lease recently. */
  alive(instanceId: string): Promise<boolean>;
}

/** At most N install-or-probe jobs at once for the org (T7 backs this with a conditional counter in DynamoDB). */
export interface ProbeSlots {
  /** A release function, or undefined when all slots are taken. */
  acquire(): Promise<(() => Promise<void>) | undefined>;
}

export function memoryProbeSlots(max: number): ProbeSlots {
  let active = 0;
  return {
    async acquire() {
      if (active >= max) return undefined;
      active += 1;
      let released = false;
      return async () => { if (!released) { released = true; active -= 1; } };
    },
  };
}

export interface ProbedTool { name: string; description?: string | undefined; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> | undefined }

export interface ControllerLimits {
  /** Serve tasks at once; the least recently used makes room. */
  maxServeTasks: number;
  /** Time for an install task to report. */
  installMs: number;
  /** Time for a task to be RUNNING and its bridge ready. */
  startMs: number;
  /** One call (the bridge also stops a call at 60 s). */
  callMs: number;
  bodyBytes: number;
  replyBytes: number;
  /**
   * The longest an install-and-probe job may take, whatever its parts add up to. It must be shorter than the broker's wait for the controller (`HOST_PROBE_TIMEOUT_MS`, 450 s), which
   * must be shorter than the probe slot's lease (10 min): a job is over, or answered, before its slot can be taken by another.
   */
  probeJobMs: number;
  /** A bootstrap nonce is good this long. */
  nonceMs: number;
  /** A server idle this long is stopped. */
  idleMs: number;
  /** A serve task older than this is stopped (the next call starts a fresh one). */
  maxLifetimeMs: number;
  /** An install or probe task older than this is a leftover. */
  jobMaxMs: number;
  /** This many failed starts or crashes of one server within `failureWindowMs` put it into backoff. */
  maxFailures: number;
  failureWindowMs: number;
  /** How long a server in backoff is not started. */
  backoffMs: number;
}

export const CONTROLLER_LIMITS: ControllerLimits = {
  probeJobMs: 420_000, nonceMs: 3 * 60_000, maxServeTasks: 16, installMs: 4 * 60_000, startMs: 120_000, callMs: 60_000, bodyBytes: 1_048_576, replyBytes: 1_048_576, idleMs: 10 * 60_000, maxLifetimeMs: 12 * 3_600_000, jobMaxMs: 5 * 60_000,
  maxFailures: 3, failureWindowMs: 10 * 60_000, backoffMs: 10 * 60_000,
};

/**
 * What the controller tells the broker has happened to a package-run server (T10). Fixed words, hashes and counts; never a package's output. The broker records each as an audit event and
 * keeps the last few for the "recent starts" line. The sink must not throw and is not waited for.
 */
export type ControllerEvent =
  | { type: "task_started"; serverId: string; trigger: "call" | "warm" }
  | { type: "task_stopped"; serverId: string; reason: StopReason }
  | { type: "changed_needs_review"; serverId: string; approved: string; observed: string };

/**
 * Why a server is not started (fix round 1, S2). When a started task shows tools other than the approved ones, the CONTROLLER records a pause right then, keyed by the approval it saw (the tools
 * hash and the bundle hash). While the registry still names that very approval, a call or a warm-up is refused at once, with no task started: the server does not restart in a loop while it waits for
 * an admin. An admin approving the new tools changes the approval, which no longer matches, and the pause is removed by the next start. The registry itself is not written by the controller (its role
 * only reads the approvals); the broker moves the entry to `changed_needs_review` from the event the controller also writes.
 */
export interface PauseStore {
  get(serverId: string): Promise<{ toolsHash: string; bundleHash: string } | undefined>;
  set(serverId: string, pause: { toolsHash: string; bundleHash: string }): Promise<void>;
  clear(serverId: string): Promise<void>;
}

export function memoryPauses(): PauseStore {
  const held = new Map<string, { toolsHash: string; bundleHash: string }>();
  return { get: async (serverId) => held.get(serverId), set: async (serverId, pause) => { held.set(serverId, pause); }, clear: async (serverId) => { held.delete(serverId); } };
}

export interface McpControllerOptions {
  /** Where a pause after a tools change is kept (the install's table in production, so a restarted controller keeps it). Default: in memory. */
  pauses?: PauseStore | undefined;
  /** Told of the events above. Absent: only the log records them. */
  events?: ((event: ControllerEvent) => Promise<void>) | undefined;
  /** The bearer token the broker presents. */
  token: string;
  registry: ControllerRegistry;
  runner: TaskRunner;
  bundles: BundleStore;
  /** What tasks use to reach the runner listener: https (or this machine's loopback). */
  controllerUrl: string;
  /** A private certificate authority for the runner listener, passed to tasks. */
  controllerCa?: string | undefined;
  /** The install's one npm registry. */
  npmRegistry: string;
  installFamily?: string | undefined;
  installSecurityGroupId?: string | undefined;
  resources?: ServerResources | undefined;
  leases?: InstanceLeases | undefined;
  probeSlots?: ProbeSlots | undefined;
  /** The hash of a tools list that the approval binds (the broker's `summariseProbe`). */
  toolsHashOf: (tools: ProbedTool[]) => string;
  limits?: Partial<ControllerLimits> | undefined;
  /** How often to look at a task that is starting. */
  pollMs?: number | undefined;
  /** How often reconcile runs (it also runs once at start). Default 60 s. 0: never on its own (a test calls `reconcile()`). */
  sweepMs?: number | undefined;
  now?: (() => number) | undefined;
  /** No ids or text from tasks: server ids, task ids and fixed words only. */
  log?: ((event: string, fields: Record<string, string | number>) => void) | undefined;
}

/** A refusal the controller can name to the broker as a fixed word. */
export class ControllerError extends Error {
  constructor(readonly code: "closed" | "start_failed" | "start_timeout" | "task_stopped" | "tools_changed" | "bundle_mismatch" | "keeps_stopping" | "busy" | "resources_failed" | "destination_refused" | "paused") {
    super(code);
    this.name = "ControllerError";
  }
}

// ---------------------------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------------------------

class BodyTooLarge extends Error {}

async function readBytes(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new BodyTooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const send = (res: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
};

function brokerTokenMatches(header: string | undefined, token: string): boolean {
  const presented = Buffer.from(header?.startsWith("Bearer ") === true ? header.slice(7) : "", "utf8");
  const expected = Buffer.from(token, "utf8");
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The most a bundle upload may be: the same bound the fetch step puts on a download. */
const MAX_BUNDLE_TAR_BYTES = BUNDLE_LIMITS.maxUnpackedBytes + BUNDLE_LIMITS.maxEntries * 4 * 512 + 1_024;
const RESULT_MAX_BYTES = 16_384;
const SERVER_ID = /^mcp[a-z0-9]{6,24}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const BUNDLE_PATH = /^\/bundles\/([0-9a-f]{64})$/u;

interface Grant {
  scope: RunnerTokenScope;
  /** An install token: the one bundle it uploaded, once it did. */
  uploaded?: string | undefined;
  bundleAttempted: boolean;
  resultAttempted: boolean;
  onResult?: ((outcome: InstallOutcome | undefined) => void) | undefined;
}

interface Nonce {
  grantKey: string;
  token: string;
  /** What the task is told besides the token (the install request). */
  request: string | undefined;
  /** The task this nonce was issued to; unknown until RunTask has answered. */
  taskId: string | undefined;
  expiresAt: number;
  redeemed: boolean;
}

interface Serving {
  serverId: string;
  /** The first 12 hex characters of the bundle hash this task was started for. */
  approval: string;
  bundleHash: string;
  secretVersion: string | undefined;
  token: string;
  grantKey: string;
  taskId: string | undefined;
  base: string | undefined;
  startedAt: number;
  lastUsed: number;
  cancelled: boolean;
  ready: Promise<void>;
}

interface Launched { taskId: string; base: string; token: string; grantKey: string }

export interface McpController {
  /** The broker-facing routes. Mount this on the broker listener only. */
  handleBroker(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** The runner-facing routes (bundles and the install result). Mount this on the runner listener only, over TLS. */
  handleRunner(req: IncomingMessage, res: ServerResponse): Promise<void>;
  close(): Promise<void>;
  /**
   * One pass of reconcile, from the cloud's own records: stops idle servers, servers older than the maximum lifetime, tasks that are unknown, over-age, not approved or not the approved
   * one; notices tasks that died; removes the task definitions and security groups of servers that are no longer approved. It stops nothing if the cloud cannot be read.
   */
  reconcile(): Promise<void>;
  /** Recent failed starts and crashes of a server, and until when it is in backoff. For the server card ("This server keeps stopping"). */
  recentStarts(serverId: string): { failures: number; backoffUntil?: number };
  /** How many serve tasks are up or starting. */
  running(): number;
  /** How many serve tasks have been started in all. */
  started(): number;
}

// ---------------------------------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------------------------------

export function createMcpController(options: McpControllerOptions): McpController {
  if (options.token.length < 43) throw new Error("the MCP controller's token is too short (256 bits are needed)");
  const limits: ControllerLimits = { ...CONTROLLER_LIMITS, ...options.limits };
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  const pauses = options.pauses ?? memoryPauses();
  /** Tells the broker; never waits, never throws. */
  const emit = (event: ControllerEvent): void => { if (options.events !== undefined) void Promise.resolve().then(() => options.events!(event)).catch(() => undefined); };
  const pollMs = options.pollMs ?? 1_000;
  const resources = options.resources ?? staticServerResources;
  const probeSlots = options.probeSlots ?? memoryProbeSlots(2);
  const installFamily = options.installFamily ?? `${RUNNER_FAMILY_PREFIX}install`;
  const runner = options.runner;
  const grants = new Map<string, Grant>();
  const serving = new Map<string, Serving>();
  const nonces = new Map<string, Nonce>();
  const jobs = new Set<Promise<unknown>>();
  const failures = new Map<string, number[]>();
  const backoffUntil = new Map<string, number>();
  /** Install and probe tasks this controller started and has not finished with. Serve tasks are the entries of `serving`. */
  const activeTaskIds = new Set<string>();
  const activeProbeIds = new Set<string>();
  /** Starts that have been asked of the runner and not yet recorded, by server id: a task of that server that exists but is not recorded yet is not a leftover; every other task is judged. */
  const startsInFlight = new Map<string, number>();
  let startedCount = 0;
  let closed = false;
  let sweeping = false;

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  /** Asks the runner for a task. The task is recorded (by `record`) before the start counts as finished, so reconcile never sees a task that exists and is not recorded. */
  async function startTask(spec: Parameters<TaskRunner["start"]>[0], record: (taskId: string) => void): Promise<string> {
    startsInFlight.set(spec.serverId, (startsInFlight.get(spec.serverId) ?? 0) + 1);
    try {
      const taskId = await runner.start(spec);
      startedCount += 1;
      record(taskId);
      return taskId;
    } finally {
      const left = (startsInFlight.get(spec.serverId) ?? 1) - 1;
      if (left <= 0) startsInFlight.delete(spec.serverId); else startsInFlight.set(spec.serverId, left);
    }
  }

  function recordFailure(serverId: string): void {
    const at = now();
    const recent = [...(failures.get(serverId) ?? []).filter((time) => at - time < limits.failureWindowMs), at];
    failures.set(serverId, recent);
    if (recent.length >= limits.maxFailures) { backoffUntil.set(serverId, at + limits.backoffMs); log("mcp_controller.backoff", { serverId, failures: recent.length }); }
  }
  function inBackoff(serverId: string): boolean {
    const until = backoffUntil.get(serverId);
    if (until === undefined) return false;
    if (now() < until) return true;
    // Backoff is over: the server gets a fresh count.
    backoffUntil.delete(serverId);
    failures.delete(serverId);
    return false;
  }

  // ---- grants: one token per task and purpose ----------------------------------------------------------
  function addGrant(scope: RunnerTokenScope, onResult?: (outcome: InstallOutcome | undefined) => void): { token: string; key: string } {
    const token = generateRunnerToken();
    // The token is looked up by its hash: the map never holds it, and a lookup by hash leaks nothing about the token.
    const key = sha256Hex(token);
    grants.set(key, { scope, bundleAttempted: false, resultAttempted: false, onResult });
    return { token, key };
  }
  const revoke = (key: string): void => {
    grants.delete(key);
    for (const [hash, nonce] of nonces) if (nonce.grantKey === key) nonces.delete(hash);
  };

  // ---- bootstrap nonces: what RunTask carries instead of a token ---------------------------------------------
  /**
   * A one-time nonce for one container of one task. RunTask parameters are readable (DescribeTasks, CloudTrail), so they carry only this: it is redeemed once, within minutes, over TLS, from the
   * task's own address, for the real token. Read afterwards by anyone else it is worth nothing.
   */
  function issueNonce(grantKey: string, token: string, request?: string): { nonce: string; entry: Nonce } {
    const nonce = generateRunnerToken();
    const entry: Nonce = { grantKey, token, request, taskId: undefined, expiresAt: now() + limits.nonceMs, redeemed: false };
    nonces.set(sha256Hex(nonce), entry);
    return { nonce, entry };
  }

  // ---- starting a task and waiting for it --------------------------------------------------------------
  async function waitRunning(taskId: string, isCancelled: () => boolean): Promise<string> {
    const deadline = Date.now() + limits.startMs;
    for (;;) {
      if (isCancelled()) throw new ControllerError("task_stopped");
      const status = await runner.describe(taskId);
      if (status === undefined || status.state === "stopped") throw new ControllerError("task_stopped");
      if (status.state === "running" && status.endpoint !== undefined) return status.endpoint;
      if (Date.now() > deadline) throw new ControllerError("start_timeout");
      await sleep(pollMs);
    }
  }

  async function waitReady(base: string, token: string, bundleHash: string, isCancelled: () => boolean): Promise<void> {
    const deadline = Date.now() + limits.startMs;
    for (;;) {
      if (isCancelled()) throw new ControllerError("task_stopped");
      try {
        // The bridge shares the package's uid, so it is untrusted: a redirect from it is an error, never followed (it would make the controller call any address its group reaches).
        const response = await fetch(`${base}/ready`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000), redirect: "error" });
        if (response.status === 200) {
          const body = await response.json().catch(() => undefined) as { ready?: unknown; bundleHash?: unknown } | undefined;
          // The bridge says which bundle it verified and started. Anything but the approved one is stopped.
          if (body?.ready === true && body.bundleHash === bundleHash) return;
          throw new ControllerError("bundle_mismatch");
        }
        await response.body?.cancel();
      } catch (error) {
        if (error instanceof ControllerError) throw error;
      }
      if (Date.now() > deadline) throw new ControllerError("start_timeout");
      await sleep(pollMs);
    }
  }

  async function listTools(base: string, token: string): Promise<ProbedTool[]> {
    const client = new Client({ name: "rovara-mcp-controller", version: "0.1.0" });
    try {
      const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` }, redirect: "error" } }) as Transport;
      await client.connect(transport, { timeout: 30_000 });
      const tools: ProbedTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page += 1) {
        const listing = await client.listTools(cursor === undefined ? {} : { cursor }, { timeout: 30_000 });
        for (const tool of listing.tools) {
          // The same projection the broker keeps, so a hash of this list equals the hash of the list the admin saw.
          tools.push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations });
        }
        cursor = listing.nextCursor;
        if (cursor === undefined) break;
      }
      return tools.slice(0, 200);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  /** Starts a serve or probe task for a bundle and waits until its bridge is ready. On any failure the task is stopped and its token revoked. */
  async function launch(input: { kind: "serve" | "probe"; id: string; spec: RunnerSpec; secretRef?: string | undefined; trigger?: "call" | "warm"; isCancelled: () => boolean; onTask: (taskId: string) => void; reason: () => StopReason }): Promise<Launched> {
    const { token, key } = addGrant({ purpose: input.kind, bundleHash: input.spec.bundleHash });
    // One nonce for each container that needs the token. RunTask carries these and nothing secret.
    const fetchNonce = issueNonce(key, token);
    const serverNonce = issueNonce(key, token);
    let taskId: string | undefined;
    try {
      let made: { family: string; taskDefinition: string; securityGroupId?: string | undefined };
      try { made = await resources.ensure({ kind: input.kind, id: input.id, spec: input.spec, secretRef: input.secretRef }); } catch (error) {
        // A destination the install does not allow is the admin's to fix, so it has its own code (and, to the broker, its own fixed sentence); anything else is the cloud's.
        throw new ControllerError((error as { name?: unknown } | null)?.name === "DestinationRefused" ? "destination_refused" : "resources_failed");
      }
      if (input.isCancelled()) throw new ControllerError("task_stopped");
      const bundleHash = input.spec.bundleHash;
      taskId = await startTask({
        purpose: input.kind, serverId: input.id, approval: approvalOf(bundleHash), family: made.family, taskDefinition: made.taskDefinition, securityGroupId: made.securityGroupId, size: input.spec.size,
        containers: {
          // Each container gets the controller's address and its own one-time nonce, and what it needs to start; the token comes only from redeeming the nonce.
          fetch: { MCP_CONTROLLER_URL: options.controllerUrl, MCP_BOOTSTRAP_NONCE: fetchNonce.nonce, MCP_BUNDLE_HASH: bundleHash, ...(options.controllerCa === undefined ? {} : { ROVARA_MCP_CONTROLLER_CA: options.controllerCa }) },
          server: {
            MCP_CONTROLLER_URL: options.controllerUrl, MCP_BOOTSTRAP_NONCE: serverNonce.nonce, ...(options.controllerCa === undefined ? {} : { ROVARA_MCP_CONTROLLER_CA: options.controllerCa }), MCP_BUNDLE_HASH: bundleHash, MCP_PACKAGE_NAME: input.spec.name, MCP_SERVER_ARGS: JSON.stringify(input.spec.args), MCP_SECRET_ENV: JSON.stringify(input.spec.secretEnv),
            MCP_MEMORY_MIB: String(input.spec.size.memoryMiB), PORT: "8080",
          },
        },
      }, (started) => { fetchNonce.entry.taskId = started; serverNonce.entry.taskId = started; input.onTask(started); if (input.kind !== "serve") activeTaskIds.add(started); });
      log("mcp_controller.task_started", { serverId: input.id, taskId, purpose: input.kind });
      if (input.kind === "serve") emit({ type: "task_started", serverId: input.id, trigger: input.trigger ?? "call" });
      if (input.isCancelled()) throw new ControllerError("task_stopped");
      const base = await waitRunning(taskId, input.isCancelled);
      await waitReady(base, token, bundleHash, input.isCancelled);
      return { taskId, base, token, grantKey: key };
    } catch (error) {
      revoke(key);
      if (taskId !== undefined) {
        await runner.stop(taskId, input.reason()).catch(() => undefined);
        activeTaskIds.delete(taskId);
        log("mcp_controller.task_stopped", { serverId: input.id, taskId, reason: input.reason() });
        if (input.kind === "serve") emit({ type: "task_stopped", serverId: input.id, reason: input.reason() });
      }
      if (error instanceof ControllerError) throw error;
      throw new ControllerError("start_failed");
    }
  }

  // ---- serve tasks -------------------------------------------------------------------------------------------
  async function stopServing(serverId: string, reason: StopReason): Promise<void> {
    const entry = serving.get(serverId);
    if (entry === undefined) return;
    serving.delete(serverId);
    entry.cancelled = true;
    revoke(entry.grantKey);
    if (entry.taskId !== undefined) {
      await runner.stop(entry.taskId, reason).catch(() => undefined);
      log("mcp_controller.task_stopped", { serverId, taskId: entry.taskId, reason });
      emit({ type: "task_stopped", serverId, reason });
    }
    // A task that is still starting finds itself cancelled and stops what it started; its end is awaited so nothing is left behind.
    await entry.ready.catch(() => undefined);
  }

  const sameApproval = (entry: Serving, approved: ApprovedServer): boolean => entry.bundleHash === approved.spec.bundleHash && entry.secretVersion === approved.secretVersion;

  /** The running serve task for an approved entry, started if it is not. The table entry exists BEFORE the first await, so concurrent first requests share one start. */
  async function ensureServing(serverId: string, approved: ApprovedServer, trigger: "call" | "warm" = "call"): Promise<Serving> {
    for (;;) {
      if (closed) throw new ControllerError("closed");
      const existing = serving.get(serverId);
      if (existing === undefined) break;
      if (sameApproval(existing, approved)) { existing.lastUsed = now(); await existing.ready; return existing; }
      // The approval moved while a task was up (another bundle, or a replaced secret): that task is not the approved one any more.
      await stopServing(serverId, existing.bundleHash === approved.spec.bundleHash ? "secret_replaced" : "approval_changed");
    }
    // A server whose tools changed after approval stays paused until its approval changes: no task, no restart loop. An unreadable pause is a refusal, not a start.
    const paused = await pauses.get(serverId).catch(() => "unreadable" as const);
    if (paused === "unreadable") throw new ControllerError("start_failed");
    if (paused !== undefined) {
      if (paused.toolsHash === approved.toolsHash && paused.bundleHash === approved.spec.bundleHash) throw new ControllerError("paused");
      // The admin approved something else (the new tools, or another bundle): the pause is over.
      await pauses.clear(serverId).catch(() => undefined);
    }
    if (inBackoff(serverId)) throw new ControllerError("keeps_stopping");
    const victims: string[] = [];
    const byUse = [...serving.values()].sort((a, b) => a.lastUsed - b.lastUsed);
    for (let index = 0; serving.size - victims.length >= limits.maxServeTasks && index < byUse.length; index += 1) victims.push(byUse[index]!.serverId);
    const entry: Serving = {
      serverId, approval: approvalOf(approved.spec.bundleHash), bundleHash: approved.spec.bundleHash, secretVersion: approved.secretVersion, token: "", grantKey: "", taskId: undefined, base: undefined,
      startedAt: now(), lastUsed: now(), cancelled: false, ready: undefined as unknown as Promise<void>,
    };
    const making = victims.map((victim) => stopServing(victim, "room"));
    entry.ready = (async () => {
      await Promise.all(making);
      const spec: RunnerSpec = { name: approved.spec.name, args: approved.spec.args, secretEnv: approved.spec.secretEnv, destinations: approved.spec.destinations, size: approved.spec.size, bundleHash: approved.spec.bundleHash };
      const launched = await launch({ kind: "serve", id: serverId, spec, secretRef: approved.secretRef, trigger, isCancelled: () => entry.cancelled || closed, onTask: (taskId) => { entry.taskId = taskId; }, reason: () => (entry.cancelled ? "disabled" : "failed") });
      entry.token = launched.token;
      entry.grantKey = launched.grantKey;
      entry.base = launched.base;
      // The tools must be the ones the admin approved. If they are not, the task is stopped and the admin looks at the difference.
      let observed: string;
      try { observed = options.toolsHashOf(await listTools(launched.base, launched.token)); } catch { await runner.stop(launched.taskId, "failed").catch(() => undefined); revoke(launched.grantKey); throw new ControllerError("start_failed"); }
      if (observed !== approved.toolsHash) {
        await runner.stop(launched.taskId, "tools_changed").catch(() => undefined);
        revoke(launched.grantKey);
        log("mcp_controller.tools_changed", { serverId });
        // Paused right here, by the controller that saw it (S2): before anything else, so a failure below cannot leave the server free to restart.
        await pauses.set(serverId, { toolsHash: approved.toolsHash, bundleHash: approved.spec.bundleHash }).catch(() => { log("mcp_controller.pause_not_kept", { serverId }); });
        emit({ type: "task_stopped", serverId, reason: "tools_changed" });
        emit({ type: "changed_needs_review", serverId, approved: approved.toolsHash, observed });
        await options.registry.toolsChanged?.(serverId, { approved: approved.toolsHash, observed }).catch(() => undefined);
        throw new ControllerError("tools_changed");
      }
    })();
    serving.set(serverId, entry);
    entry.ready.catch(() => {
      // A start that was cancelled (the server was disabled, the controller closed) is not a crash.
      if (!entry.cancelled) recordFailure(serverId);
      if (serving.get(serverId) === entry) serving.delete(serverId);
    });
    await entry.ready;
    return entry;
  }

  // ---- install and probe -------------------------------------------------------------------------------------
  /** Runs the install task for a proposal and returns what it reported. */
  async function runInstall(proposal: McpStdioProposal, jobCancelled: () => boolean = () => false): Promise<InstallOutcome> {
    let settle!: (outcome: InstallOutcome | undefined) => void;
    const result = new Promise<InstallOutcome | undefined>((resolve) => { settle = resolve; });
    const { token, key } = addGrant({ purpose: "install" }, (outcome) => settle(outcome));
    // The request (the package name and version) is told to the task by the bootstrap, with the token; the override carries only the nonce.
    const installNonce = issueNonce(key, token, JSON.stringify({ registry: "npm", name: proposal.name, version: proposal.version, args: proposal.args, ...(proposal.integrity === undefined ? {} : { integrity: proposal.integrity }) }));
    let taskId: string | undefined;
    try {
      taskId = await startTask({
        purpose: "install", serverId: "install", approval: "", family: installFamily, taskDefinition: installFamily, securityGroupId: options.installSecurityGroupId, size: { cpu: 512, memoryMiB: 1_024 },
        containers: {
          install: {
            MCP_BOOTSTRAP_NONCE: installNonce.nonce, MCP_CONTROLLER_URL: options.controllerUrl, ROVARA_MCP_NPM_REGISTRY: options.npmRegistry,
            ...(options.controllerCa === undefined ? {} : { ROVARA_MCP_CONTROLLER_CA: options.controllerCa }),
          },
        },
      }, (started) => { installNonce.entry.taskId = started; activeTaskIds.add(started); });
      log("mcp_controller.task_started", { serverId: "install", taskId, purpose: "install" });
      const watched = taskId;
      const deadline = Date.now() + limits.installMs;
      // The result arrives from the task itself (PUT /result). A task that stops without having sent one is a failed install, not a hang.
      const outcome = await new Promise<InstallOutcome | undefined>((resolve) => {
        let finished = false;
        const done = (value: InstallOutcome | undefined): void => { if (!finished) { finished = true; resolve(value); } };
        void result.then(done);
        const watch = async (): Promise<void> => {
          while (!finished) {
            await sleep(pollMs);
            if (finished) return;
            const status = await runner.describe(watched).catch(() => undefined);
            if (status === undefined || status.state === "stopped") { await sleep(Math.min(250, pollMs)); done(undefined); return; }
            if (Date.now() > deadline || jobCancelled()) { done({ ok: false, code: "timed_out", sentence: "Installing this package took longer than Rovara allows." }); return; }
          }
        };
        void watch();
      });
      if (outcome === undefined) return { ok: false, code: "install_failed", sentence: "Rovara could not install this package's dependencies from your registry." };
      if (outcome.ok) {
        const grant = grants.get(key);
        // The bundle must be in the store under the hash the task reports, uploaded by this task.
        if (grant?.uploaded !== outcome.report.bundleHash || !await options.bundles.has(outcome.report.bundleHash)) return { ok: false, code: "upload_failed", sentence: "Rovara could not store the prepared package." };
      }
      return outcome;
    } finally {
      revoke(key);
      if (taskId !== undefined) {
        await runner.stop(taskId, "done").catch(() => undefined);
        activeTaskIds.delete(taskId);
        log("mcp_controller.task_stopped", { serverId: "install", taskId, reason: "done" });
      }
    }
  }

  async function runProbe(spec: RunnerSpec, id: string, secretRef: string | undefined, jobCancelled: () => boolean = () => false): Promise<ProbedTool[]> {
    let launched: Launched | undefined;
    activeProbeIds.add(id);
    try {
      launched = await launch({ kind: "probe", id, spec, secretRef, isCancelled: () => closed || jobCancelled(), onTask: () => undefined, reason: () => "failed" });
      return await listTools(launched.base, launched.token);
    } finally {
      if (launched !== undefined) {
        revoke(launched.grantKey);
        await runner.stop(launched.taskId, "done").catch(() => undefined);
        activeTaskIds.delete(launched.taskId);
        log("mcp_controller.task_stopped", { serverId: id, taskId: launched.taskId, reason: "done" });
      }
      await resources.release("probe", id).catch(() => undefined);
      activeProbeIds.delete(id);
    }
  }

  /** The install-then-probe (or probe-only, when the bundle is pinned) a proposal and an approval need. */
  async function probe(proposal: McpStdioProposal, pinned: { lockfileHash: string; bundleHash: string } | undefined, jobCancelled: () => boolean, secretRef?: string): Promise<
    { ok: true; tools: ProbedTool[]; integrity: string; lockfileHash: string; bundleHash: string; installed?: { packageCount: number; unpackedBytes: number } } | { ok: false; install?: InstallOutcome & { ok: false } }
  > {
    let lockfileHash: string;
    let bundleHash: string;
    let integrity: string;
    let installed: { packageCount: number; unpackedBytes: number } | undefined;
    if (pinned === undefined) {
      const outcome = await runInstall(proposal, jobCancelled);
      if (!outcome.ok) return { ok: false, install: outcome };
      ({ lockfileHash, bundleHash, integrity } = outcome.report);
      installed = { packageCount: outcome.report.packageCount, unpackedBytes: outcome.report.unpackedBytes };
    } else {
      // An approval probes the bundle it pinned. Nothing is installed again.
      if (proposal.integrity === undefined || !await options.bundles.has(pinned.bundleHash)) return { ok: false };
      ({ lockfileHash, bundleHash } = pinned);
      integrity = proposal.integrity;
    }
    const probeId = `probe${createHash("sha256").update(`${bundleHash}${now()}${Math.random()}`).digest("hex").slice(0, 10)}`;
    const tools = await runProbe({ name: proposal.name, args: proposal.args, secretEnv: proposal.secretEnv, destinations: proposal.destinations, size: proposal.size, bundleHash }, probeId, secretRef, jobCancelled);
    return { ok: true, tools, integrity, lockfileHash, bundleHash, ...(installed === undefined ? {} : { installed }) };
  }

  function track<T>(job: Promise<T>): Promise<T> {
    jobs.add(job);
    const forget = (): void => { jobs.delete(job); };
    job.then(forget, forget);
    return job;
  }

  // ---- the broker's routes -----------------------------------------------------------------------------------
  async function handleProbe(req: IncomingMessage, res: ServerResponse, installOnly: boolean): Promise<void> {
    let body: { spec?: unknown; pinned?: unknown; serverId?: unknown } | undefined;
    try { body = JSON.parse((await readBytes(req, limits.bodyBytes)).toString("utf8")) as typeof body; } catch { send(res, 400, { error: "bad_request" }); return; }
    const parsed = McpStdioProposalSchema.safeParse(body?.spec);
    if (!parsed.success) { send(res, 400, { error: "bad_spec" }); return; }
    // The id of the proposal being tested, named by the broker so a package that declares secrets can be tested with them. Only the shape of a server id is accepted.
    const proposalId = body?.serverId;
    if (proposalId !== undefined && (typeof proposalId !== "string" || !/^mcp[a-z0-9]{6,24}$/u.test(proposalId))) { send(res, 400, { error: "bad_spec" }); return; }
    let pinned: { lockfileHash: string; bundleHash: string } | undefined;
    if (body?.pinned !== undefined) {
      const candidate = body.pinned as { lockfileHash?: unknown; bundleHash?: unknown };
      if (typeof candidate !== "object" || candidate === null || typeof candidate.lockfileHash !== "string" || typeof candidate.bundleHash !== "string" || !SHA256.test(candidate.lockfileHash) || !SHA256.test(candidate.bundleHash)) { send(res, 400, { error: "bad_spec" }); return; }
      pinned = { lockfileHash: candidate.lockfileHash, bundleHash: candidate.bundleHash };
    }
    if (installOnly && pinned !== undefined) { send(res, 400, { error: "bad_spec" }); return; }
    const release = await probeSlots.acquire();
    if (release === undefined) { send(res, 429, { error: "busy" }); return; }
    // The whole job has a deadline. At the deadline the broker is answered and the job is told to stop; its tasks are stopped as it ends, and only then is the slot given back.
    let overtime = false;
    const job = (async () => {
      try {
        if (installOnly) {
          const outcome = await runInstall(parsed.data, () => overtime);
          return { status: 200, body: outcome.ok ? { ok: true, ...outcome.report } : outcome };
        }
        // A test of a proposal with secret names reads the secret the broker stored for the proposal (see `probeSecret`). The lookup failing is "no secret", which stops the start.
        const secretRef = parsed.data.secretEnv.length === 0 || proposalId === undefined ? undefined : await options.registry.probeSecret?.(proposalId, { spec: parsed.data, pinned }).catch(() => undefined);
        const result = await probe(parsed.data, pinned, () => overtime, secretRef);
        if (!result.ok) return { status: 200, body: { error: "host_refused", ...(result.install === undefined ? {} : { install: result.install }) } };
        return { status: 200, body: { tools: result.tools, integrity: result.integrity, lockfileHash: result.lockfileHash, bundleHash: result.bundleHash, ...(result.installed === undefined ? {} : { installed: result.installed }) } };
      } catch (error) {
        // The task's own text is never passed on: it can hold paths and registry addresses. Only a refused destination is named: it is the admin's to fix.
        log("mcp_controller.probe_failed", { error: error instanceof ControllerError ? error.code : "unknown" });
        return { status: 200, body: { error: "host_refused", ...(error instanceof ControllerError && error.code === "destination_refused" ? { reason: "destination_refused" } : {}) } };
      } finally {
        await release().catch(() => undefined);
      }
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<{ status: number; body: unknown }>((resolve) => { timer = setTimeout(() => { overtime = true; log("mcp_controller.probe_job_timed_out", {}); resolve({ status: 200, body: { error: "host_refused" } }); }, limits.probeJobMs); });
    const done = await Promise.race([track(job), late]);
    clearTimeout(timer);
    send(res, done.status, done.body);
  }

  async function forward(entry: Serving, req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${entry.token}`, "content-type": "application/json", accept: "application/json, text/event-stream",
    };
    const version = req.headers["mcp-protocol-version"];
    if (typeof version === "string" && /^[0-9-]{1,20}$/u.test(version)) headers["mcp-protocol-version"] = version;
    let response: Response;
    try {
      response = await fetch(`${entry.base}/mcp`, { method: "POST", headers, body, signal: AbortSignal.timeout(limits.callMs + 5_000), redirect: "error" });
    } catch {
      // The task may have stopped under us: if the runner says so, it is dropped and counted.
      const status = entry.taskId === undefined ? undefined : await runner.describe(entry.taskId).catch(() => undefined);
      if (status === undefined || status.state === "stopped") { if (serving.get(entry.serverId) === entry) { serving.delete(entry.serverId); revoke(entry.grantKey); recordFailure(entry.serverId); } }
      send(res, 503, { error: "server_unavailable" });
      return;
    }
    if (response.status !== 200 && response.status !== 202) { await response.body?.cancel(); send(res, 502, { error: "server_unavailable" }); return; }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > limits.replyBytes) { send(res, 502, { error: "reply_too_large" }); return; }
      chunks.push(Buffer.from(chunk));
    }
    const reply = Buffer.concat(chunks);
    res.writeHead(response.status, { "content-type": response.headers.get("content-type")?.startsWith("application/json") === true ? "application/json" : "text/event-stream", "content-length": reply.byteLength });
    res.end(reply);
  }

  async function handleServer(req: IncomingMessage, res: ServerResponse, serverId: string, action: "mcp" | "warm" | "release"): Promise<void> {
    if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }); res.end(); return; }
    let approved: ApprovedServer | undefined;
    try { approved = await options.registry.approved(serverId); } catch { send(res, 503, { error: "registry_unavailable" }); return; }
    if (action === "release") {
      // A server that was disabled or removed: its task stops at once and its task definition and security group go. An approved server cannot be released this way.
      if (approved !== undefined) { send(res, 409, { error: "still_approved" }); return; }
      await stopServing(serverId, "disabled");
      let removed = true;
      try { await resources.release("serve", serverId); } catch { removed = false; log("mcp_controller.release_pending", { serverId }); }
      send(res, 200, { status: "released", resources: removed ? "removed" : "pending" });
      return;
    }
    // Anything the registry does not call approved is not served, and does not say whether it exists.
    if (approved === undefined) { send(res, 404, { error: "not_found" }); return; }
    if (action === "warm") {
      const existing = serving.get(serverId);
      if (existing !== undefined && sameApproval(existing, approved)) { existing.lastUsed = now(); send(res, 200, { status: existing.base === undefined ? "starting" : "ready" }); return; }
      // A start without a call: it goes on after this answer, and a failure is counted like any other.
      void track(ensureServing(serverId, approved, "warm").catch((error: unknown) => { log("mcp_controller.warm_failed", { serverId, error: error instanceof ControllerError ? error.code : "unknown" }); }));
      send(res, 202, { status: "starting" });
      return;
    }
    let body: Buffer;
    try { body = await readBytes(req, limits.bodyBytes); } catch (error) { send(res, error instanceof BodyTooLarge ? 413 : 400, { error: error instanceof BodyTooLarge ? "too_large" : "bad_request" }); return; }
    let entry: Serving;
    try {
      entry = await ensureServing(serverId, approved);
    } catch (error) {
      const code = error instanceof ControllerError ? error.code : "start_failed";
      log("mcp_controller.start_failed", { serverId, error: code });
      if (code === "tools_changed" || code === "paused") send(res, 409, { error: "needs_review" });
      else if (code === "keeps_stopping") send(res, 503, { error: "keeps_stopping" });
      else send(res, 503, { error: "server_unavailable" });
      return;
    }
    entry.lastUsed = now();
    await forward(entry, req, res, body);
  }

  async function handleBroker(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = (req.url ?? "/").split("?")[0] ?? "/";
    try {
      if (req.method === "GET" && pathname === "/healthz") { send(res, 200, { status: "ok" }); return; }
      if (!brokerTokenMatches(req.headers.authorization, options.token)) { send(res, 401, { error: "unauthorized" }); return; }
      if (closed) { send(res, 503, { error: "closed" }); return; }
      if (pathname === "/probe" || pathname === "/install") {
        if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }); res.end(); return; }
        await handleProbe(req, res, pathname === "/install");
        return;
      }
      const match = /^\/servers\/(mcp[a-z0-9]{6,24})\/(mcp|warm|release)$/u.exec(pathname);
      if (match === null || !SERVER_ID.test(match[1]!)) { send(res, 404, { error: "not_found" }); return; }
      await handleServer(req, res, match[1]!, match[2] as "mcp" | "warm" | "release");
    } catch {
      if (!res.headersSent) send(res, 400, { error: "bad_request" });
    }
  }

  // ---- the runner's routes -----------------------------------------------------------------------------------
  /**
   * `POST /bootstrap {nonce}`: a task's container exchanges its one-time nonce for the token. Only from the address ECS reports for the task the nonce was issued to (the runner listener
   * is reached directly, so the peer address is the task's own), only once, and only before it expires. The nonce is not consumed by a request from any other address, so a copy read
   * from CloudTrail cannot be used to spend it. A second redemption from the right address is a task that is running twice: the task is stopped.
   */
  async function handleBootstrap(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }); res.end(); return; }
    let nonce: unknown;
    try { nonce = (JSON.parse((await readBytes(req, 1_024)).toString("utf8")) as { nonce?: unknown }).nonce; } catch { send(res, 400, { error: "bad_request" }); return; }
    const entry = typeof nonce === "string" && /^[A-Za-z0-9_-]{43}$/u.test(nonce) ? nonces.get(sha256Hex(nonce)) : undefined;
    if (entry === undefined || now() >= entry.expiresAt || !grants.has(entry.grantKey) || closed) { send(res, 401, { error: "unauthorized" }); return; }
    // The task's address, from the cloud's record of the task. Until the controller knows the task and its address the container is told to try again.
    if (entry.taskId === undefined) { send(res, 409, { error: "not_yet" }); return; }
    let status: Awaited<ReturnType<TaskRunner["describe"]>>;
    try { status = await runner.describe(entry.taskId); } catch { send(res, 409, { error: "not_yet" }); return; }
    if (status === undefined || status.state === "stopped") { send(res, 401, { error: "unauthorized" }); return; }
    if (status.address === undefined) { send(res, 409, { error: "not_yet" }); return; }
    const peer = (req.socket.remoteAddress ?? "").replace(/^::ffff:/u, "");
    if (peer === "" || peer !== status.address) { send(res, 403, { error: "forbidden" }); return; }
    if (entry.redeemed) {
      // Spent already, and asked for again from the task's own address: stop the task and everything it holds.
      log("mcp_controller.bootstrap_replayed", { taskId: entry.taskId });
      revoke(entry.grantKey);
      await runner.stop(entry.taskId, "failed").catch(() => undefined);
      send(res, 401, { error: "unauthorized" });
      return;
    }
    entry.redeemed = true;
    send(res, 200, { token: entry.token, ...(entry.request === undefined ? {} : { request: entry.request }) });
  }

  async function handleRunner(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = (req.url ?? "/").split("?")[0] ?? "/";
    try {
      if (req.method === "GET" && pathname === "/healthz") { send(res, 200, { status: "ok" }); return; }
      if (pathname === "/bootstrap") { await handleBootstrap(req, res); return; }
      const bundle = BUNDLE_PATH.exec(pathname);
      if (bundle === null && pathname !== "/result") { send(res, 404, { error: "not_found" }); return; }
      const header = req.headers.authorization;
      const presented = header?.startsWith("Bearer ") === true ? header.slice(7) : "";
      const grant = runnerTokenWellFormed(presented) ? grants.get(sha256Hex(presented)) : undefined;
      if (grant === undefined) { send(res, 401, { error: "unauthorized" }); return; }
      if (!runnerTokenAllows(grant.scope, req.method ?? "", pathname)) { send(res, 403, { error: "forbidden" }); return; }
      if (closed) { send(res, 503, { error: "closed" }); return; }
      if (req.method === "GET" && bundle !== null) {
        const stored = await options.bundles.open(bundle[1]!);
        if (stored === undefined) { send(res, 404, { error: "not_found" }); return; }
        res.writeHead(200, { "content-type": "application/x-tar", "content-length": stored.size });
        stored.stream.on("error", () => res.destroy());
        stored.stream.pipe(res);
        return;
      }
      if (grant.scope.purpose !== "install") { send(res, 403, { error: "forbidden" }); return; }
      if (pathname === "/result") {
        // Once. A second report, or one with no upload behind it, is refused.
        if (grant.resultAttempted) { send(res, 409, { error: "already_reported" }); return; }
        grant.resultAttempted = true;
        let outcome: InstallOutcome | undefined;
        try { outcome = parseInstallOutcome(JSON.parse((await readBytes(req, RESULT_MAX_BYTES)).toString("utf8"))); } catch { outcome = undefined; }
        if (outcome === undefined) { send(res, 400, { error: "bad_result" }); grant.onResult?.(undefined); return; }
        send(res, 200, { status: "ok" });
        grant.onResult?.(outcome);
        return;
      }
      // PUT /bundles/{hash}: once, and only bytes whose sha256 is the hash in the address.
      if (grant.bundleAttempted) { send(res, 409, { error: "already_uploaded" }); return; }
      grant.bundleAttempted = true;
      const hash = bundle![1]!;
      const outcome = await options.bundles.put(hash, req as AsyncIterable<Buffer>, MAX_BUNDLE_TAR_BYTES);
      if (outcome !== "stored") { send(res, outcome === "too_large" ? 413 : 400, { error: outcome }); return; }
      grant.uploaded = hash;
      send(res, 201, { status: "stored" });
    } catch {
      if (!res.headersSent) send(res, 400, { error: "bad_request" });
    }
  }

  // ---- reconcile ---------------------------------------------------------------------------------------------
  async function reconcile(): Promise<void> {
    if (closed || sweeping) return;
    sweeping = true;
    try {
      const at = now();
      // 1. Tasks this controller is serving: idle, too old, or dead.
      for (const entry of [...serving.values()]) {
        if (entry.cancelled || entry.base === undefined) continue;
        if (at - entry.lastUsed > limits.idleMs) { await stopServing(entry.serverId, "idle"); continue; }
        if (at - entry.startedAt > limits.maxLifetimeMs) { await stopServing(entry.serverId, "lifetime"); continue; }
        if (entry.taskId === undefined) continue;
        let status: Awaited<ReturnType<TaskRunner["describe"]>>;
        try { status = await runner.describe(entry.taskId); } catch { continue; }
        if (status === undefined || status.state === "stopped") {
          // The task died on its own: it is dropped, counted, and started afresh by the next call (unless it keeps dying).
          if (serving.get(entry.serverId) === entry) { serving.delete(entry.serverId); revoke(entry.grantKey); recordFailure(entry.serverId); }
          await runner.stop(entry.taskId, "crash").catch(() => undefined);
          log("mcp_controller.task_stopped", { serverId: entry.serverId, taskId: entry.taskId, reason: "crash" });
          emit({ type: "task_stopped", serverId: entry.serverId, reason: "crash" });
        }
      }
      // 2. The cloud's own list of tasks. If it cannot be read, nothing is judged from it.
      let renewed = false;
      if (options.leases !== undefined) { try { await options.leases.renew(); renewed = true; } catch { log("mcp_controller.lease_failed", {}); } }
      let listed: Awaited<ReturnType<TaskRunner["list"]>> | undefined;
      try { listed = await runner.list(); } catch { log("mcp_controller.list_failed", {}); }
      if (listed !== undefined) {
        for (const task of listed) {
          // A task another instance started is that instance's to judge. It is stopped only if that instance is known to be gone; with no leases, or when this instance's own lease could not
          // be renewed, it is left alone.
          if (runner.instanceId !== undefined && task.owner !== runner.instanceId) {
            if (!renewed) continue;
            let alive = true;
            if (task.owner === "") alive = false; else { try { alive = await options.leases!.alive(task.owner); } catch { continue; } }
            if (alive) continue;
            await runner.stop(task.taskId, "leftover").catch(() => undefined);
            log("mcp_controller.task_stopped", { serverId: task.serverId, taskId: task.taskId, reason: "leftover" });
            if (task.purpose === "serve") emit({ type: "task_stopped", serverId: task.serverId, reason: "leftover" });
            continue;
          }
          const entry = task.purpose === "serve" ? [...serving.values()].find((candidate) => candidate.taskId === task.taskId) : undefined;
          const known = task.purpose === "serve" ? entry !== undefined : activeTaskIds.has(task.taskId);
          if (!known) {
            // A start that is in flight may have made a task that is not recorded yet; it is judged on the next pass.
            if ((startsInFlight.get(task.serverId) ?? 0) > 0) continue;
            await runner.stop(task.taskId, "leftover").catch(() => undefined);
            log("mcp_controller.task_stopped", { serverId: task.serverId, taskId: task.taskId, reason: "leftover" });
            if (task.purpose === "serve") emit({ type: "task_stopped", serverId: task.serverId, reason: "leftover" });
            continue;
          }
          if (task.purpose !== "serve") {
            if (at - task.startedAt > limits.jobMaxMs) {
              await runner.stop(task.taskId, "leftover").catch(() => undefined);
              log("mcp_controller.task_stopped", { serverId: task.serverId, taskId: task.taskId, reason: "leftover" });
            }
            continue;
          }
          if (entry === undefined) continue;
          if (at - task.startedAt > limits.maxLifetimeMs) { await stopServing(entry.serverId, "lifetime"); continue; }
          let approved: ApprovedServer | undefined;
          try { approved = await options.registry.approved(task.serverId); } catch { continue; }
          if (approved === undefined) { await stopServing(entry.serverId, "disabled"); continue; }
          if (approvalOf(approved.spec.bundleHash) !== task.approval || approved.spec.bundleHash !== entry.bundleHash) { await stopServing(entry.serverId, "approval_changed"); continue; }
          if (approved.secretVersion !== entry.secretVersion) await stopServing(entry.serverId, "secret_replaced");
        }
      }
      // 3. What a server that is gone left behind: its task definition and security group.
      if (resources.list !== undefined) {
        let held: Awaited<ReturnType<NonNullable<ServerResources["list"]>>> = [];
        try { held = await resources.list(); } catch { log("mcp_controller.resources_list_failed", {}); }
        for (const item of held) {
          if (item.kind === "probe" ? activeProbeIds.has(item.id) : serving.has(item.id)) continue;
          if (item.kind === "serve") {
            let approved: ApprovedServer | undefined;
            try { approved = await options.registry.approved(item.id); } catch { continue; }
            if (approved !== undefined) continue;
          }
          await resources.release(item.kind, item.id).catch(() => { log("mcp_controller.release_pending", { serverId: item.id }); });
        }
      }
    } finally {
      sweeping = false;
    }
  }

  const sweepMs = options.sweepMs ?? 60_000;
  let timer: ReturnType<typeof setInterval> | undefined;
  if (sweepMs > 0) {
    // At start, and then every minute, from the cloud's records and not from memory, so a restart of this service cannot orphan a task.
    void reconcile().catch(() => undefined);
    timer = setInterval(() => { void reconcile().catch(() => undefined); }, sweepMs);
    timer.unref();
  }

  return {
    running: () => serving.size,
    started: () => startedCount,
    reconcile,
    recentStarts: (serverId) => {
      const until = backoffUntil.get(serverId);
      return { failures: (failures.get(serverId) ?? []).filter((time) => now() - time < limits.failureWindowMs).length, ...(until === undefined || now() >= until ? {} : { backoffUntil: until }) };
    },
    handleBroker,
    handleRunner,
    async close() {
      closed = true;
      if (timer !== undefined) clearInterval(timer);
      for (const serverId of [...serving.keys()]) await stopServing(serverId, "shutdown");
      await Promise.all([...jobs].map((job) => job.catch(() => undefined)));
    },
  };
}
