// NOT FOR PRODUCTION until the follow-up redesign (lane E, "stdio host redesign"): package-run servers are off by default and the broker never calls this host unless the
// install switches them on. The code and its tests stay so the redesign starts from them.
// E6: the MCP host. A stdio MCP server cannot be reached over a network, and no server code may run in a worker or in the broker (design 3.6). The host is the one
// small service that runs stdio servers an admin approved, and shows each to the broker as a Streamable HTTP MCP server on a private listener:
//
//   POST /servers/{serverId}/mcp   the server, as MCP over HTTP (bearer token). Only an approved entry of the registry is served; anything else is 404.
//   POST /probe                    installs a package for a moment and lists its tools, so an admin sees what it offers (and its fingerprint) before approving. Bearer token.
//   GET  /healthz                  liveness, no login.
//
// What it runs is fixed by the admin's approval: an npm package at an exact version whose TARBALL hashes to the integrity the admin saw (review I3). The host downloads the
// tarball itself, hashes the bytes, and installs from that file with scripts off, once per package; it never runs `npx` and never re-fetches on a restart.
//
// Hosted servers are not trusted (review I4). Each runs under its own uid from a pool (the host starts as root and drops the child to that uid), in a private 0700 home it owns,
// with a scrubbed environment and open-file and process limits. So a hosted server cannot read the host's token or the task role's credentials (`/proc/1/environ`), nor another
// server's files. A host that cannot change uid refuses to start servers unless it is told explicitly that isolation is off (tests only).
import { execFile, spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { chown, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, CallToolResultSchema, ListToolsRequestSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { McpStdioProposalSchema, type McpStdioProposal, type McpStdioSpec } from "@agentx/contracts";

export interface HostRegistry {
  /** The spec of an approved stdio entry, or undefined for any other id. It throws when the registry cannot be read (the host then answers 503). */
  approvedStdio(serverId: string): Promise<McpStdioSpec | undefined>;
}

/** What `prepare` leaves ready to run. `integrity` is the tarball's, computed from the bytes that were installed. */
export interface PreparedPackage { command: string; args: string[]; integrity: string }

export interface HostLauncher {
  /**
   * Makes the package ready in `folder` (once per package): downloads its tarball, checks it against `spec.integrity` when there is one, installs from that file with
   * scripts off. It throws when the bytes do not match. The returned command runs the installed program, never a fresh download.
   */
  prepare(spec: McpStdioProposal, folder: string): Promise<PreparedPackage>;
}

type Exec = (command: string, args: string[], options: { cwd: string; env: Record<string, string>; timeoutMs: number }) => Promise<string>;

const defaultExec: Exec = (command, args, options) => new Promise((resolve, reject) => {
  execFile(command, args, { cwd: options.cwd, env: options.env, timeout: options.timeoutMs, maxBuffer: 4 * 1_048_576 }, (error, stdout) => { if (error) reject(new Error("command failed")); else resolve(stdout); });
});

/** `sha512-<base64>` of the bytes, the form npm records in `dist.integrity`. */
export function tarballIntegrity(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

/**
 * Installs from the registry's tarball, checked against the admin's integrity: `npm pack` downloads the tarball, the host hashes the file itself (not the registry's
 * metadata), and `npm install <that file> --ignore-scripts` unpacks it. A package's own dependencies are resolved by npm at that install (its shrinkwrap is honoured when it
 * has one); they are fixed from then on, because the host runs the installed tree and never installs again.
 */
export function npmLauncher(options: { exec?: Exec; timeoutMs?: number } = {}): HostLauncher {
  const exec = options.exec ?? defaultExec;
  const timeoutMs = options.timeoutMs ?? 120_000;
  return {
    async prepare(spec, folder) {
      const environment = scrubbedEnvironment(folder);
      const packed = JSON.parse(await exec("npm", ["pack", `${spec.name}@${spec.version}`, "--pack-destination", folder, "--ignore-scripts", "--json"], { cwd: folder, env: environment, timeoutMs })) as Array<{ filename?: unknown }>;
      const file = packed[0]?.filename;
      if (typeof file !== "string" || !/^[A-Za-z0-9._@+-]+\.tgz$/u.test(file)) throw new Error("no tarball");
      const tarball = join(folder, file);
      const integrity = tarballIntegrity(await readFile(tarball));
      if (spec.integrity !== undefined && !timingSafeStringEqual(integrity, spec.integrity)) throw new Error("integrity mismatch");
      await exec("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-save", "--prefix", folder, tarball], { cwd: folder, env: environment, timeoutMs });
      const manifest = JSON.parse(await readFile(join(folder, "node_modules", ...spec.name.split("/"), "package.json"), "utf8")) as { bin?: unknown };
      const bins = typeof manifest.bin === "string" ? [spec.name.split("/").at(-1)!] : typeof manifest.bin === "object" && manifest.bin !== null ? Object.keys(manifest.bin) : [];
      const bin = bins.find((name) => name === spec.name.split("/").at(-1)) ?? bins[0];
      if (bin === undefined || !/^[A-Za-z0-9._-]{1,100}$/u.test(bin)) throw new Error("no program");
      return { command: join(folder, "node_modules", ".bin", bin), args: [...spec.args], integrity };
    },
  };
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Which uids hosted servers run as. The pool must be unused by anything else in the container. */
export interface HostIsolation { firstUid: number; count: number; gid: number }

export interface McpHostOptions {
  /** The bearer token the broker presents. */
  token: string;
  registry: HostRegistry;
  launcher: HostLauncher;
  /** `{ firstUid, count, gid }`: run each server under its own uid. `"none"`: no isolation (tests only; a production host that cannot change uid refuses to start servers). */
  isolation: HostIsolation | "none";
  /** Most servers running at once; the least recently used one makes room. Default 8. */
  maxProcesses?: number;
  /** Most tests of a package at once. Default 2. */
  maxProbes?: number;
  /** A server idle this long is stopped (it starts again on the next request, from the installed copy). Default 10 minutes. */
  idleMs?: number;
  /** The longest a probe may take. Default 90 s (a package may need installing). */
  probeTimeoutMs?: number;
  /** Where private homes and installed packages are made. Default: the system's temp folder. */
  workRoot?: string;
  now?: () => number;
  log?: (event: string, fields: Record<string, string | number>) => void;
  /** Tests: replaces `spawn`, `chown` and `process.getuid`. */
  internals?: { spawn?: typeof spawn; chown?: (path: string, uid: number, gid: number) => Promise<void>; getuid?: () => number | undefined };
}

/** The environment a hosted server gets: a path, a private home, and the operator's registry. Nothing of the host's own (no token, no cloud credentials). */
export function scrubbedEnvironment(home: string, extra: Record<string, string> = {}): Record<string, string> {
  const environment: Record<string, string> = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: home, TMPDIR: home, NODE_ENV: "production", NODE_OPTIONS: "--max-old-space-size=384", npm_config_ignore_scripts: "true", npm_config_update_notifier: "false", npm_config_cache: join(home, ".npm") };
  if (process.env.npm_config_registry !== undefined) environment.npm_config_registry = process.env.npm_config_registry;
  return { ...environment, ...extra };
}

/** A stdio client transport that can run the child under another uid, with a bounded read buffer (the SDK's cannot set a uid). */
class IsolatedStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private child: ReturnType<typeof spawn> | undefined;
  private readonly buffer = new ReadBuffer({ maxBufferSize: 1_048_576 });
  constructor(private readonly input: { command: string; args: string[]; env: Record<string, string>; cwd: string; uid?: number; gid?: number; spawnProcess: typeof spawn }) {}
  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      // With a uid the child also gets limits on open files and processes: no shell is involved for the package, only for the limits, and the package is "$0".
      const wrapped = this.input.uid === undefined
        ? { command: this.input.command, args: this.input.args }
        : { command: "/bin/sh", args: ["-c", 'ulimit -n 256 2>/dev/null; ulimit -u 128 2>/dev/null; exec "$0" "$@"', this.input.command, ...this.input.args] };
      const child = this.input.spawnProcess(wrapped.command, wrapped.args, {
        env: this.input.env, cwd: this.input.cwd, stdio: ["pipe", "pipe", "ignore"], shell: false, windowsHide: true,
        ...(this.input.uid === undefined ? {} : { uid: this.input.uid, gid: this.input.gid ?? this.input.uid }),
      });
      this.child = child;
      child.on("error", (error) => { reject(error); this.onerror?.(error); });
      child.on("spawn", () => resolve());
      child.on("close", () => { this.child = undefined; this.onclose?.(); });
      child.stdout?.on("data", (chunk: Buffer) => {
        try {
          this.buffer.append(chunk);
          for (let message = this.buffer.readMessage(); message !== null; message = this.buffer.readMessage()) this.onmessage?.(message);
        } catch (error) { this.onerror?.(error instanceof Error ? error : new Error("bad output")); void this.close(); }
      });
    });
  }
  async send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.child?.stdin;
    if (stdin === null || stdin === undefined) throw new Error("not connected");
    await new Promise<void>((resolve) => { if (stdin.write(serializeMessage(message))) resolve(); else stdin.once("drain", resolve); });
  }
  async close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.buffer.clear();
    if (child === undefined) return;
    child.stdin?.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2_000);
      child.once("close", () => { clearTimeout(timer); resolve(); });
      child.kill("SIGTERM");
    });
  }
}

interface Running { ready: Promise<Client>; lastUsed: number }

const BODY_MAX_BYTES = 1_048_576;

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    total += chunk.byteLength;
    if (total > BODY_MAX_BYTES) throw new Error("body too large");
    chunks.push(chunk);
  }
  return chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

const send = (res: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
};

function bearerMatches(header: string | undefined, token: string): boolean {
  const presented = Buffer.from(header?.startsWith("Bearer ") === true ? header.slice(7) : "", "utf8");
  const expected = Buffer.from(token, "utf8");
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

type Tools = Awaited<ReturnType<Client["listTools"]>>["tools"];

export function createMcpHost(options: McpHostOptions): { handle(req: IncomingMessage, res: ServerResponse): Promise<void>; close(): Promise<void>; running(): number; spawned(): number } {
  if (options.token.length < 24) throw new Error("the MCP host's token is too short");
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  const maxProcesses = options.maxProcesses ?? 8;
  const maxProbes = options.maxProbes ?? 2;
  const idleMs = options.idleMs ?? 10 * 60_000;
  const spawnProcess = options.internals?.spawn ?? spawn;
  const changeOwner = options.internals?.chown ?? chown;
  const getuid = options.internals?.getuid ?? (() => process.getuid?.());
  const processes = new Map<string, Running>();
  const failures = new Map<string, number[]>();
  const installs = new Map<string, Promise<PreparedPackage>>();
  const installFolders: string[] = [];
  const disposers = new Map<Promise<Client>, () => Promise<void>>();
  let probes = 0;
  let closed = false;
  const activeProbes = new Set<Promise<unknown>>();
  let spawnedCount = 0;
  const freeUids: number[] = options.isolation === "none" ? [] : Array.from({ length: options.isolation.count }, (_, index) => (options.isolation as HostIsolation).firstUid + index);

  const isolation = options.isolation === "none" ? undefined : options.isolation;
  const isolated = isolation !== undefined;
  if (isolated && getuid() !== 0) log("mcp_host.cannot_isolate", { uid: getuid() ?? -1 });

  async function workFolder(): Promise<string> {
    const root = options.workRoot ?? tmpdir();
    await mkdir(root, { recursive: true });
    return mkdtemp(join(root, "mcp-host-"));
  }

  /** The package, installed once in a folder only the host writes (the servers read it, as another uid, and cannot change it). */
  function installed(spec: McpStdioProposal): Promise<PreparedPackage> {
    const key = `${spec.name}@${spec.version}#${spec.integrity ?? ""}#${spec.args.join(" ")}`;
    const cached = installs.get(key);
    if (cached !== undefined) return cached;
    const job = (async () => {
      const folder = await workFolder();
      installFolders.push(folder);
      try { return await options.launcher.prepare(spec, folder); } catch (error) { await rm(folder, { recursive: true, force: true }).catch(() => undefined); throw error; }
    })();
    installs.set(key, job);
    job.catch(() => installs.delete(key));
    return job;
  }

  /** Starts one server under its own uid and home. Returns the client and what undoes it. */
  async function startClient(spec: McpStdioProposal): Promise<{ client: Client; integrity: string; dispose: () => Promise<void> }> {
    const prepared = await installed(spec);
    let uid: number | undefined;
    if (isolated) {
      if (getuid() !== 0) throw new Error("cannot isolate");
      uid = freeUids.shift();
      if (uid === undefined) throw new Error("no free uid");
    }
    const home = await workFolder();
    const dispose = async () => {
      await client?.close().catch(() => undefined);
      await rm(home, { recursive: true, force: true }).catch(() => undefined);
      if (uid !== undefined) freeUids.push(uid);
    };
    let client: Client | undefined;
    try {
      const gid = isolation?.gid;
      if (uid !== undefined && gid !== undefined) await changeOwner(home, uid, gid);
      client = new Client({ name: "rovara-mcp-host", version: "0.1.0" });
      spawnedCount += 1;
      await client.connect(new IsolatedStdioTransport({
        command: prepared.command, args: prepared.args, env: scrubbedEnvironment(home), cwd: home, spawnProcess,
        ...(uid === undefined || gid === undefined ? {} : { uid, gid }),
      }), { timeout: options.probeTimeoutMs ?? 90_000 });
      return { client, integrity: prepared.integrity, dispose };
    } catch (error) {
      await dispose();
      throw error;
    }
  }

  async function stop(serverId: string): Promise<void> {
    const entry = processes.get(serverId);
    processes.delete(serverId);
    if (entry === undefined) return;
    // A server still starting is waited for and then stopped: every process that was spawned is stopped.
    const client = await entry.ready.catch(() => undefined);
    if (client !== undefined) await disposers.get(entry.ready)?.();
    disposers.delete(entry.ready);
  }

  /** The running server for an approved entry, started if it is not. The table entry exists BEFORE the first await, so concurrent first requests share one start. */
  function runningFor(serverId: string, spec: McpStdioSpec): Promise<Client> {
    if (closed) return Promise.reject(new Error("closed"));
    const existing = processes.get(serverId);
    if (existing !== undefined) { existing.lastUsed = now(); return existing.ready; }
    const recent = (failures.get(serverId) ?? []).filter((at) => now() - at < 60_000);
    if (recent.length >= 3) return Promise.reject(new Error("starting too often"));
    const victims: string[] = [];
    const idleOrder = [...processes.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (let index = 0; processes.size - victims.length >= maxProcesses && index < idleOrder.length; index += 1) victims.push(idleOrder[index]![0]);
    const entry: Running = { lastUsed: now(), ready: undefined as unknown as Promise<Client> };
    const stoppingVictims = victims.map((victim) => stop(victim));
    entry.ready = (async () => {
      await Promise.all(stoppingVictims);
      const started = await startClient(spec);
      disposers.set(entry.ready, started.dispose);
      started.client.onclose = () => { if (processes.get(serverId) === entry) void stop(serverId); };
      return started.client;
    })();
    processes.set(serverId, entry);
    entry.ready.catch(() => {
      failures.set(serverId, [...recent, now()]);
      if (processes.get(serverId) === entry) processes.delete(serverId);
    });
    return entry.ready;
  }

  const sweep = setInterval(() => {
    for (const [serverId, entry] of processes) if (now() - entry.lastUsed > idleMs) void stop(serverId);
  }, Math.max(1_000, Math.min(idleMs, 60_000)));
  sweep.unref();

  /** One MCP request for a hosted server, answered by a transport made for it (no session) that forwards to the running client. */
  async function serve(serverId: string, spec: McpStdioSpec, req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    const client = await runningFor(serverId, spec);
    const server = new Server({ name: "rovara-mcp-host", version: "0.1.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools: Tools = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page += 1) {
        const listing = await client.listTools(cursor === undefined ? {} : { cursor });
        tools.push(...listing.tools);
        cursor = listing.nextCursor;
        if (cursor === undefined) break;
      }
      return { tools };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => CallToolResultSchema.parse(await client.callTool({ name: request.params.name, arguments: request.params.arguments ?? {} }, CallToolResultSchema, { timeout: 60_000 })));
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void server.close(); });
    // The SDK's getter types include undefined, which its own Transport interface omits under exactOptionalPropertyTypes (as in mcp-client.ts).
    await server.connect(transport as Transport);
    await transport.handleRequest(req, res, body);
  }

  async function probe(spec: McpStdioProposal): Promise<{ tools: Tools; integrity: string }> {
    if (closed) throw new Error("closed");
    if (probes >= maxProbes) throw Object.assign(new Error("busy"), { busy: true });
    probes += 1;
    let started: Awaited<ReturnType<typeof startClient>> | undefined;
    try {
      started = await startClient(spec);
      const tools: Tools = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page += 1) {
        const listing = await started.client.listTools(cursor === undefined ? {} : { cursor }, { timeout: 30_000 });
        tools.push(...listing.tools);
        cursor = listing.nextCursor;
        if (cursor === undefined) break;
      }
      return { tools: tools.slice(0, 200), integrity: started.integrity };
    } finally {
      probes -= 1;
      await started?.dispose();
    }
  }

  return {
    running: () => processes.size,
    spawned: () => spawnedCount,
    async close() {
      closed = true;
      clearInterval(sweep);
      // A server that is starting is waited for and stopped; no new one starts after this.
      while (processes.size > 0) await Promise.all([...processes.keys()].map(stop));
      await Promise.all([...activeProbes].map((job) => job.catch(() => undefined)));
      await Promise.all(installFolders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }).catch(() => undefined)));
    },
    async handle(req, res) {
      const pathname = (req.url ?? "/").split("?")[0] ?? "/";
      try {
        if (req.method === "GET" && pathname === "/healthz") { send(res, 200, { status: "ok" }); return; }
        if (!bearerMatches(req.headers.authorization, options.token)) { send(res, 401, { error: "unauthorized" }); return; }
        if (req.method === "POST" && pathname === "/probe") {
          const parsed = McpStdioProposalSchema.safeParse((await readBody(req) as { spec?: unknown } | undefined)?.spec);
          if (!parsed.success) { send(res, 400, { error: "bad_spec" }); return; }
          try {
            const job = probe(parsed.data);
            activeProbes.add(job);
            job.then(() => activeProbes.delete(job), () => activeProbes.delete(job));
            send(res, 200, await job);
          } catch (error) {
            if ((error as { busy?: unknown } | null)?.busy === true) { send(res, 429, { error: "busy" }); return; }
            // The package's own error text is not passed on: it can hold paths and registry addresses.
            send(res, 200, { error: "host_refused" });
          }
          return;
        }
        const match = /^\/servers\/(mcp[a-z0-9]{6,24})\/mcp$/u.exec(pathname);
        if (match === null) { send(res, 404, { error: "not_found" }); return; }
        if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }); res.end(); return; }
        const serverId = match[1]!;
        let spec: McpStdioSpec | undefined;
        try { spec = await options.registry.approvedStdio(serverId); } catch { send(res, 503, { error: "registry_unavailable" }); return; }
        // Anything the registry does not call approved is not served, and does not say whether it exists.
        if (spec === undefined) { send(res, 404, { error: "not_found" }); return; }
        const body = await readBody(req);
        try {
          await serve(serverId, spec, req, res, body);
        } catch (error) {
          log("mcp_host.serve_failed", { serverId, error: error instanceof Error ? error.name : "unknown" });
          if (!res.headersSent) send(res, 503, { error: "server_unavailable" });
        }
      } catch {
        if (!res.headersSent) send(res, 400, { error: "bad_request" });
      }
    },
  };
}
