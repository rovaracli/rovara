// Stdio MCP host redesign (T4), design sections 2, 3, 8 and 9: the bridge. It runs inside the `server` container of a runner task (uid 10003, never root) and turns the one stdio
// program of the approved package into a Streamable HTTP MCP server for the controller:
//
//   POST /mcp      MCP over HTTP. Bearer token (the task's own).
//   GET  /ready    200 once the program is up: {ready, bundleHash}. 503 before. Bearer token.
//   GET  /healthz  liveness, no login.
//
// What it will and will not do:
//   - It refuses to run as uid 0.
//   - It starts nothing until `verified.json` (written by the fetch step AFTER the bundle's sha256 matched the approved hash) names the approved bundle hash.
//   - It starts the program through setpriv and prlimit (confine.ts), with an environment built from nothing: a path, a home, a temp folder, a heap limit, and exactly the secret
//     names the approval declared. It deletes those secrets from its own environment once the program has them.
//   - It keeps the program's stderr out of everything (counted, not stored), caps a request and a reply at 1 MiB and a call at 60 s.
// What the program returns is untrusted data, as for any MCP server; the bridge shares the program's uid, so it adds no protection against a hostile program.
import { timingSafeEqual } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, CallToolResultSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { McpStdioProposalSchema, mcpSecretEnvNameProblem } from "@agentx/contracts";
import { binOf } from "./bin.js";
import { runsAsRoot } from "./identity.js";
import { runnerTokenWellFormed } from "./token-scope.js";
import { StdioChildTransport, type ChildProcessSpec } from "./stdio-transport.js";

export const BRIDGE_LIMITS = { bodyBytes: 1_048_576, replyBytes: 1_048_576, callMs: 60_000, startMs: 90_000, listPages: 10 } as const;

export interface BridgeOptions {
  /** The task's own bearer token. */
  token: string;
  /** The sha256 the approval names. The fetch step wrote it to `verified.json` only after the downloaded bytes matched it. */
  bundleHash: string;
  /** Holds `tree/` (the unpacked bundle, read-only for this container) and `verified.json`. */
  bundleDir: string;
  packageName: string;
  args: readonly string[];
  /** The names (never values) of the secrets the approval declared. */
  secretEnv: readonly string[];
  memoryMiB: number;
  /** Where the secret values are read from and then deleted (the container's own environment). */
  environment: Record<string, string | undefined>;
  /** The private folders: a home and a temp folder this container owns. */
  homeDir: string;
  tmpDir: string;
  /** Turns the program and its arguments into the command that is run (setpriv and prlimit in front). The only place a test may differ from production. */
  confine: (program: string, args: readonly string[]) => { file: string; args: string[] };
  getuid?: () => number | undefined;
  getgid?: () => number | undefined;
  geteuid?: () => number | undefined;
  getegid?: () => number | undefined;
  spawn?: ConstructorParameters<typeof StdioChildTransport>[1];
  callTimeoutMs?: number;
  startTimeoutMs?: number;
  /** Called once if the program stops after it was ready. The runner then exits, so the task stops. */
  onChildExit?: () => void;
  log?: (event: string, fields: Record<string, string | number>) => void;
}

export interface Bridge {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Verifies the bundle, starts the program and connects to it. Throws (with a fixed message) if anything is wrong; nothing is left running then. */
  start(): Promise<void>;
  close(): Promise<void>;
  isReady(): boolean;
  stderrBytes(): number;
}

function bearerMatches(header: string | undefined, token: string): boolean {
  const presented = Buffer.from(header?.startsWith("Bearer ") === true ? header.slice(7) : "", "utf8");
  const expected = Buffer.from(token, "utf8");
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

const send = (res: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
};

class BodyTooLarge extends Error {}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    total += chunk.byteLength;
    if (total > BRIDGE_LIMITS.bodyBytes) throw new BodyTooLarge();
    chunks.push(chunk);
  }
  return chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

type Tools = Awaited<ReturnType<Client["listTools"]>>["tools"];

export function createBridge(options: BridgeOptions): Bridge {
  if (runsAsRoot({ getuid: options.getuid, getgid: options.getgid, geteuid: options.geteuid, getegid: options.getegid })) throw new Error("the bridge must not run as root");
  if (!runnerTokenWellFormed(options.token)) throw new Error("the bridge's token is not a 256-bit token");
  if (!/^[0-9a-f]{64}$/u.test(options.bundleHash)) throw new Error("the bundle hash is not a sha256");
  // The name, arguments and secret names are validated by the same rules the approval used.
  const spec = McpStdioProposalSchema.safeParse({ registry: "npm", name: options.packageName, version: "0.0.0", args: options.args, secretEnv: options.secretEnv });
  if (!spec.success) throw new Error("the package, its arguments or its secret names are not valid");
  for (const name of options.secretEnv) if (mcpSecretEnvNameProblem(name) !== undefined) throw new Error("a secret name is not allowed");
  if (!Number.isInteger(options.memoryMiB) || options.memoryMiB < 256 || options.memoryMiB > 2_048) throw new Error("the memory size is not valid");
  const log = options.log ?? (() => undefined);
  const callMs = options.callTimeoutMs ?? BRIDGE_LIMITS.callMs;
  let transport: StdioChildTransport | undefined;
  let client: Client | undefined;
  let ready = false;
  let closing = false;

  const listAll = async (active: Client, timeout?: number): Promise<Tools> => {
    const tools: Tools = [];
    let cursor: string | undefined;
    for (let page = 0; page < BRIDGE_LIMITS.listPages; page += 1) {
      const listing = await active.listTools(cursor === undefined ? {} : { cursor }, timeout === undefined ? undefined : { timeout });
      tools.push(...listing.tools);
      cursor = listing.nextCursor;
      if (cursor === undefined) break;
    }
    return tools;
  };
  const capped = <T>(value: T): T => {
    if (Buffer.byteLength(JSON.stringify(value)) > BRIDGE_LIMITS.replyBytes) throw new Error("reply too large");
    return value;
  };

  async function start(): Promise<void> {
    // 1. The bundle is the approved one: the fetch step wrote the hash it verified.
    let verified: unknown;
    try { verified = (JSON.parse(await readFile(join(options.bundleDir, "verified.json"), "utf8")) as { bundleHash?: unknown }).bundleHash; } catch { throw new Error("the bundle has not been verified"); }
    const wanted = Buffer.from(options.bundleHash, "utf8");
    const found = Buffer.from(typeof verified === "string" ? verified : "", "utf8");
    if (found.length !== wanted.length || !timingSafeEqual(found, wanted)) throw new Error("the bundle is not the approved one");
    // 2. The program: the package's own `bin`, read from the bundle's package.json (the bundle hash pins it).
    const tree = join(options.bundleDir, "tree");
    let manifest: Record<string, unknown>;
    try { manifest = JSON.parse(await readFile(join(tree, "package.json"), "utf8")) as Record<string, unknown>; } catch { throw new Error("the bundle has no package.json"); }
    if (manifest.name !== options.packageName) throw new Error("the bundle is not the approved package");
    const bin = binOf(options.packageName, manifest);
    if (bin === undefined) throw new Error("the package has no program");
    const program = join(tree, ...bin.split("/"));
    const info = await lstat(program).catch(() => undefined);
    if (info === undefined || !info.isFile()) throw new Error("the package has no program");
    // 3. The program's environment: built from nothing, plus the declared secrets. A declared secret that is not there is a fault, not a reason to start without it.
    const env: Record<string, string> = {
      PATH: "/usr/local/bin", HOME: options.homeDir, TMPDIR: options.tmpDir, NODE_ENV: "production", NODE_OPTIONS: `--max-old-space-size=${Math.floor(options.memoryMiB * 0.75)}`,
    };
    for (const name of options.secretEnv) {
      const value = options.environment[name];
      if (value === undefined) throw new Error("a declared secret is missing");
      env[name] = value;
    }
    const command = options.confine(program, options.args);
    const child: ChildProcessSpec = { file: command.file, args: command.args, env, cwd: options.homeDir };
    // The program has its environment once it is started; from then on neither this object nor the container's environment holds the values.
    const forgetSecrets = (): void => { for (const name of options.secretEnv) delete options.environment[name]; };
    transport = new StdioChildTransport(child, options.spawn, forgetSecrets);
    client = new Client({ name: "rovara-mcp-bridge", version: "0.1.0" });
    client.onclose = () => {
      if (closing || !ready) return;
      ready = false;
      log("bridge.child_exited", { stderrBytes: transport?.stderrBytes() ?? 0 });
      options.onChildExit?.();
    };
    try {
      await client.connect(transport, { timeout: options.startTimeoutMs ?? BRIDGE_LIMITS.startMs });
    } catch (error) {
      forgetSecrets();
      await close();
      throw error;
    }
    ready = true;
  }

  async function close(): Promise<void> {
    closing = true;
    ready = false;
    const active = client;
    client = undefined;
    await active?.close().catch(() => undefined);
    await transport?.close().catch(() => undefined);
  }

  async function serve(active: Client, req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    const server = new Server({ name: "rovara-mcp-bridge", version: "0.1.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => capped({ tools: await listAll(active, callMs) }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => capped(CallToolResultSchema.parse(await active.callTool({ name: request.params.name, arguments: request.params.arguments ?? {} }, CallToolResultSchema, { timeout: callMs }))));
    const httpTransport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.on("close", () => { void httpTransport.close(); void server.close(); });
    // The SDK's getter types include undefined, which its own Transport interface omits under exactOptionalPropertyTypes (as in the lane E host).
    await server.connect(httpTransport as Transport);
    await httpTransport.handleRequest(req, res, body);
  }

  return {
    isReady: () => ready,
    stderrBytes: () => transport?.stderrBytes() ?? 0,
    start,
    close,
    async handle(req, res) {
      const pathname = (req.url ?? "/").split("?")[0] ?? "/";
      try {
        if (req.method === "GET" && pathname === "/healthz") { send(res, 200, { status: "ok" }); return; }
        if (!bearerMatches(req.headers.authorization, options.token)) { send(res, 401, { error: "unauthorized" }); return; }
        if (req.method === "GET" && pathname === "/ready") {
          if (ready) send(res, 200, { ready: true, bundleHash: options.bundleHash }); else send(res, 503, { ready: false });
          return;
        }
        if (pathname !== "/mcp") { send(res, 404, { error: "not_found" }); return; }
        if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }); res.end(); return; }
        const active = client;
        if (!ready || active === undefined) { send(res, 503, { error: "not_ready" }); return; }
        const body = await readBody(req);
        try {
          await serve(active, req, res, body);
        } catch (error) {
          log("bridge.serve_failed", { error: error instanceof Error ? error.name : "unknown" });
          if (!res.headersSent) send(res, 502, { error: "server_unavailable" });
        }
      } catch (error) {
        if (!res.headersSent) send(res, error instanceof BodyTooLarge ? 413 : 400, { error: error instanceof BodyTooLarge ? "too_large" : "bad_request" });
      }
    },
  };
}
