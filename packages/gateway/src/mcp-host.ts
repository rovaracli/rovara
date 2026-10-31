// E6: the MCP host. A stdio MCP server cannot be reached over a network, and no server code may run in a worker or in the broker (design 3.6). The host is the one
// small service that runs stdio servers an admin approved, and shows each to the broker as a Streamable HTTP MCP server on a private listener:
//
//   POST /servers/{serverId}/mcp   the server, as MCP over HTTP (bearer token). Only an approved entry of the registry is served; anything else is 404.
//   POST /probe                    starts a package for a moment and lists its tools, so an admin sees what it offers before approving. Bearer token.
//   GET  /healthz                  liveness, no login.
//
// What it runs is fixed by the admin's approval: an npm package at an exact version (and its integrity hash when the admin gave one), arguments that are plain
// words, no shell. The process gets a scrubbed environment, a private working folder, and is stopped after it has been idle. The host never reads a request's body
// as anything but MCP, never starts a package a request names (apart from /probe, which only the broker can call), and fails closed when the registry cannot be read.
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, CallToolResultSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { McpStdioSpecSchema, type McpStdioSpec } from "@agentx/contracts";

export interface HostRegistry {
  /** The spec of an approved stdio entry, or undefined for any other id. It throws when the registry cannot be read (the host then answers 503). */
  approvedStdio(serverId: string): Promise<McpStdioSpec | undefined>;
}

export interface HostLauncher {
  command(spec: McpStdioSpec): { command: string; args: string[] };
  /** Whether the package is the one whose integrity the admin gave. Called only for a spec with an `integrity`. */
  verify?(spec: McpStdioSpec): Promise<boolean>;
}

/** Runs the package with `npx`, scripts off, from the registry the operator chose (`npm_config_registry`). */
export function npxLauncher(): HostLauncher {
  return {
    command: (spec) => ({ command: "npx", args: ["--yes", `${spec.name}@${spec.version}`, ...spec.args] }),
    verify: (spec) => new Promise<boolean>((resolve) => {
      const child = spawn("npm", ["view", `${spec.name}@${spec.version}`, "dist.integrity"], { env: scrubbedEnvironment("/tmp"), stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8").slice(0, 400); });
      child.on("error", () => resolve(false));
      child.on("close", () => resolve(out.trim() === spec.integrity));
    }),
  };
}

export interface McpHostOptions {
  /** The bearer token the broker presents. */
  token: string;
  registry: HostRegistry;
  launcher: HostLauncher;
  /** Most servers running at once; the least recently used idle one makes room. Default 8. */
  maxProcesses?: number;
  /** A server idle this long is stopped (it starts again on the next request). Default 10 minutes. */
  idleMs?: number;
  /** The longest a probe may take. Default 90 s (a package may need installing). */
  probeTimeoutMs?: number;
  /** Where a server's private working folder is made. Default: the system's temp folder. */
  workRoot?: string;
  now?: () => number;
  log?: (event: string, fields: Record<string, string | number>) => void;
}

/** The environment a hosted server gets: a path, a private home, and the operator's registry. Nothing of the host's own (no token, no cloud credentials). */
export function scrubbedEnvironment(home: string, extra: Record<string, string> = {}): Record<string, string> {
  const environment: Record<string, string> = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: home, NODE_ENV: "production", npm_config_ignore_scripts: "true", npm_config_update_notifier: "false", npm_config_cache: join(home, ".npm") };
  if (process.env.npm_config_registry !== undefined) environment.npm_config_registry = process.env.npm_config_registry;
  return { ...environment, ...extra };
}

interface Running { client: Client; home: string; lastUsed: number; starting?: Promise<void> }

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

export function createMcpHost(options: McpHostOptions): { handle(req: IncomingMessage, res: ServerResponse): Promise<void>; close(): Promise<void>; running(): number } {
  if (options.token.length < 24) throw new Error("the MCP host's token is too short");
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  const maxProcesses = options.maxProcesses ?? 8;
  const idleMs = options.idleMs ?? 10 * 60_000;
  const processes = new Map<string, Running>();
  const failures = new Map<string, number[]>();

  async function startClient(spec: McpStdioSpec, home: string): Promise<Client> {
    if (spec.integrity !== undefined && options.launcher.verify !== undefined && !await options.launcher.verify(spec)) throw new Error("integrity mismatch");
    const { command, args } = options.launcher.command(spec);
    const client = new Client({ name: "rovara-mcp-host", version: "0.1.0" });
    await client.connect(new StdioClientTransport({ command, args, env: scrubbedEnvironment(home), cwd: home, stderr: "ignore" }), { timeout: options.probeTimeoutMs ?? 90_000 });
    return client;
  }

  async function workFolder(): Promise<string> {
    return mkdtemp(join(options.workRoot ?? tmpdir(), "mcp-host-"));
  }

  async function stop(serverId: string): Promise<void> {
    const entry = processes.get(serverId);
    processes.delete(serverId);
    if (entry === undefined) return;
    await entry.client?.close().catch(() => undefined);
    await rm(entry.home, { recursive: true, force: true }).catch(() => undefined);
  }

  /** The running server for an approved entry, started if it is not. Too many failed starts in a minute turn the server away for a while. */
  async function runningFor(serverId: string, spec: McpStdioSpec): Promise<Client> {
    const existing = processes.get(serverId);
    if (existing?.starting !== undefined) await existing.starting;
    const again = processes.get(serverId);
    if (again !== undefined) { again.lastUsed = now(); return again.client; }
    const recent = (failures.get(serverId) ?? []).filter((at) => now() - at < 60_000);
    if (recent.length >= 3) throw new Error("starting too often");
    // Make room: the least recently used server stops.
    if (processes.size >= maxProcesses) {
      const oldest = [...processes.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (oldest !== undefined) await stop(oldest[0]);
    }
    const home = await workFolder();
    try {
      const client = await startClient(spec, home);
      client.onclose = () => { if (processes.get(serverId)?.client === client) void stop(serverId); };
      processes.set(serverId, { client, home, lastUsed: now() });
      return client;
    } catch (error) {
      failures.set(serverId, [...recent, now()]);
      await rm(home, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
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
      const tools: Awaited<ReturnType<Client["listTools"]>>["tools"] = [];
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

  async function probe(spec: McpStdioSpec): Promise<Awaited<ReturnType<Client["listTools"]>>["tools"]> {
    const home = await workFolder();
    let client: Client | undefined;
    try {
      client = await startClient(spec, home);
      const tools: Awaited<ReturnType<Client["listTools"]>>["tools"] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page += 1) {
        const listing = await client.listTools(cursor === undefined ? {} : { cursor }, { timeout: 30_000 });
        tools.push(...listing.tools);
        cursor = listing.nextCursor;
        if (cursor === undefined) break;
      }
      return tools;
    } finally {
      await client?.close().catch(() => undefined);
      await rm(home, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  return {
    running: () => processes.size,
    async close() {
      clearInterval(sweep);
      await Promise.all([...processes.keys()].map(stop));
    },
    async handle(req, res) {
      const pathname = (req.url ?? "/").split("?")[0] ?? "/";
      try {
        if (req.method === "GET" && pathname === "/healthz") { send(res, 200, { status: "ok" }); return; }
        if (!bearerMatches(req.headers.authorization, options.token)) { send(res, 401, { error: "unauthorized" }); return; }
        if (req.method === "POST" && pathname === "/probe") {
          const parsed = McpStdioSpecSchema.safeParse((await readBody(req) as { spec?: unknown } | undefined)?.spec);
          if (!parsed.success) { send(res, 400, { error: "bad_spec" }); return; }
          try {
            send(res, 200, { tools: await probe(parsed.data) });
          } catch {
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
