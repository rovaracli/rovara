// Stdio MCP host redesign (T6, T7): fakes for the controller's tests. A `FakeRunner` is a TaskRunner whose "tasks" are small in-process bridges (the same stateless Streamable HTTP
// shape the real bridge serves), so the controller's state machine can be tested without a cloud, a package or a child process.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ProbedTool } from "../../packages/gateway/src/mcp-controller.js";
import { bootstrapEnvironment } from "../../packages/gateway/src/mcp-runner/bootstrap.js";
import type { RunnerTaskInfo, RunnerTaskSpec, RunnerTaskStatus, StopReason, TaskRunner } from "../../packages/gateway/src/mcp-runner/task-runner.js";

export const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
/** A tools hash for the tests: the names, in order. */
export const toolsHashOfNames = (tools: ProbedTool[]): string => sha256(tools.map((tool) => tool.name).join(","));

export interface FakeBridgeOptions { token: string; bundleHash: string; tools: ProbedTool[]; reply?: (name: string) => string; replyStatus?: number; /** Answer these requests with a 303 to this address (a hostile bridge). */ redirect?: { to: string; on: Array<"ready" | "list" | "call"> }; /** The status for a tool call only (the tools list answers normally). */ callStatus?: number }

/** A bridge: GET /ready, POST /mcp (tools/list and tools/call). It records the bearer tokens it was shown. */
export async function fakeBridge(options: FakeBridgeOptions): Promise<{ url: string; seen: string[]; calls: string[]; close(): Promise<void> }> {
  const seen: string[] = [];
  const calls: string[] = [];
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const bearer = String(req.headers.authorization ?? "");
    seen.push(bearer);
    if (bearer !== `Bearer ${options.token}`) { res.writeHead(401); res.end(); return; }
    if (options.redirect?.on.includes("ready") === true && req.url === "/ready") { res.writeHead(303, { location: options.redirect.to }); res.end(); return; }
    if (req.method === "GET" && req.url === "/ready") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ready: true, bundleHash: options.bundleHash })); return; }
    if (req.method !== "POST" || req.url !== "/mcp") { res.writeHead(404); res.end(); return; }
    if (options.replyStatus !== undefined) { res.writeHead(options.replyStatus); res.end("{}"); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk);
    const body = chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    const method = (body as { method?: unknown } | undefined)?.method;
    if (options.redirect !== undefined && ((method === "tools/call" && options.redirect.on.includes("call")) || (method === "tools/list" && options.redirect.on.includes("list")))) { res.writeHead(303, { location: options.redirect.to }); res.end(); return; }
    if (options.callStatus !== undefined && (body as { method?: unknown } | undefined)?.method === "tools/call") { res.writeHead(options.callStatus); res.end("{}"); return; }
    const server = new McpServer({ name: "fake-bridge", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: options.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: { type: "object" as const, ...tool.inputSchema }, annotations: tool.annotations })) }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => { calls.push(request.params.name); return { content: [{ type: "text", text: options.reply?.(request.params.name) ?? `called:${request.params.name}` }] }; });
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport as Transport);
    await transport.handleRequest(req, res, body);
  };
  const server: Server = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, calls,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

export interface FakeRunnerOptions {
  /** The tools the task of a spec offers. */
  tools?: (spec: RunnerTaskSpec) => ProbedTool[];
  /** The bundle hash the bridge reports (default: the one the task was started with). */
  reportedBundle?: (spec: RunnerTaskSpec) => string;
  /** The task never reaches RUNNING. */
  neverRunning?: boolean;
  /** `start` throws. */
  failStart?: boolean;
  replyStatus?: number;
  callStatus?: number;
  /** The address the task reports (default the loopback, where the tests run). `null`: it has none yet. */
  taskAddress?: string | null;
  redirect?: { to: string; on: Array<"ready" | "list" | "call"> };
  /** `start` takes this long to answer; the task already exists (and is listed) meanwhile, as an ECS task does. */
  startDelayMs?: number;
  reply?: (name: string) => string;
  /** What an install task does (the test PUTs the bundle and the result with the token it was given). */
  install?: (input: { taskId: string; token: string; request: Record<string, unknown>; environment: Record<string, string> }) => Promise<void>;
}

interface FakeTask { spec: RunnerTaskSpec; state: RunnerTaskStatus; bridge?: Awaited<ReturnType<typeof fakeBridge>> | undefined; stoppedFor?: StopReason; startedAt: number }

export class FakeRunner implements TaskRunner {
  readonly instanceId = "fakeinst1";
  readonly tasks = new Map<string, FakeTask>();
  readonly stops: Array<{ taskId: string; reason: StopReason }> = [];
  private counter = 0;
  /** What `list` returns on top of the tasks started here (leftovers, for reconcile). */
  readonly extra: RunnerTaskInfo[] = [];
  listFails = false;
  listCalls = 0;
  /** `list` takes this long to answer. */
  listDelayMs = 0;
  constructor(readonly options: FakeRunnerOptions = {}) {}

  /** The tokens each container got by redeeming its nonce, by task. */
  readonly tokens = new Map<string, { fetch?: string; server?: string; install?: string }>();
  tokenOf(taskId: string, container: "fetch" | "server" | "install" = "server"): string {
    const found = this.tokens.get(taskId)?.[container];
    if (found === undefined) throw new Error("that container has not redeemed its nonce");
    return found;
  }

  async start(spec: RunnerTaskSpec): Promise<string> {
    if (this.options.failStart === true) throw new Error("no capacity");
    this.counter += 1;
    const taskId = `fake-${this.counter}`;
    // Like an ECS task, it has an address from the start (the loopback of this machine) and is pending until its containers are up.
    const task: FakeTask = { spec, state: { state: "pending", ...this.addressField() }, startedAt: Date.now() };
    this.tasks.set(taskId, task);
    if (this.options.startDelayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, this.options.startDelayMs));
    if (this.options.neverRunning === true && spec.purpose !== "install") return taskId;
    // The containers redeem their nonces once the controller has answered RunTask (until then it says "not yet").
    void this.boot(taskId, task);
    return taskId;
  }

  private addressField(): { address?: string } {
    const address = this.options.taskAddress === undefined ? "127.0.0.1" : this.options.taskAddress;
    return address === null ? {} : { address };
  }

  private async boot(taskId: string, task: FakeTask): Promise<void> {
    const spec = task.spec;
    const redeem = async (container: string): Promise<Record<string, string>> => {
      const environment = { ...(spec.containers[container] ?? {}) } as Record<string, string | undefined>;
      await bootstrapEnvironment(environment, { delayMs: 10 });
      return environment as Record<string, string>;
    };
    try {
      if (spec.purpose === "install") {
        const environment = await redeem("install");
        this.tokens.set(taskId, { install: environment.MCP_RUNNER_TOKEN! });
        task.state = { state: "running", ...this.addressField() };
        await this.options.install?.({ taskId, token: environment.MCP_RUNNER_TOKEN!, request: JSON.parse(environment.MCP_INSTALL_REQUEST ?? "{}") as Record<string, unknown>, environment });
        if ((task.state as RunnerTaskStatus).state !== "stopped") task.state = { state: "stopped", exitCode: 0 };
        return;
      }
      const fetchEnvironment = await redeem("fetch");
      const server = await redeem("server");
      this.tokens.set(taskId, { fetch: fetchEnvironment.MCP_RUNNER_TOKEN!, server: server.MCP_RUNNER_TOKEN! });
      if (task.state.state === "stopped") return;
      const bridge = await fakeBridge({
        token: server.MCP_RUNNER_TOKEN!, bundleHash: this.options.reportedBundle?.(spec) ?? server.MCP_BUNDLE_HASH ?? "", tools: this.options.tools?.(spec) ?? [{ name: "echo", inputSchema: { type: "object" } }],
        ...(this.options.replyStatus === undefined ? {} : { replyStatus: this.options.replyStatus }), ...(this.options.callStatus === undefined ? {} : { callStatus: this.options.callStatus }), ...(this.options.redirect === undefined ? {} : { redirect: this.options.redirect }), ...(this.options.reply === undefined ? {} : { reply: this.options.reply }),
      });
      if ((task.state as RunnerTaskStatus).state === "stopped") { await bridge.close(); return; }
      task.bridge = bridge;
      task.state = { state: "running", ...this.addressField(), endpoint: bridge.url };
    } catch {
      if (task.state.state !== "stopped") task.state = { state: "stopped", exitCode: 1 };
    }
  }

  async stop(taskId: string, reason: StopReason): Promise<void> {
    const task = this.tasks.get(taskId);
    this.stops.push({ taskId, reason });
    if (task === undefined) return;
    task.stoppedFor ??= reason;
    task.state = { state: "stopped" };
    await task.bridge?.close();
    task.bridge = undefined;
  }

  async describe(taskId: string): Promise<RunnerTaskStatus | undefined> { return this.tasks.get(taskId)?.state; }

  async list(): Promise<RunnerTaskInfo[]> {
    this.listCalls += 1;
    if (this.listDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.listDelayMs));
    if (this.listFails) throw new Error("cannot list");
    const own = [...this.tasks.entries()].filter(([, task]) => task.state.state !== "stopped").map(([taskId, task]): RunnerTaskInfo => ({
      taskId, purpose: task.spec.purpose, serverId: task.spec.serverId, approval: task.spec.approval, family: task.spec.family, owner: this.instanceId, startedAt: task.startedAt, state: task.state.state === "running" ? "running" : "pending",
    }));
    return [...own, ...this.extra.filter((info) => !this.tasks.has(info.taskId) || this.tasks.get(info.taskId)!.state.state !== "stopped")];
  }

  /** The task died on its own. */
  async crash(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (task === undefined) return;
    task.state = { state: "stopped", exitCode: 1 };
    await task.bridge?.close();
    task.bridge = undefined;
  }

  /** The tasks of a purpose that were started, newest last. */
  started(purpose?: RunnerTaskSpec["purpose"]): Array<{ taskId: string; spec: RunnerTaskSpec }> {
    return [...this.tasks.entries()].filter(([, task]) => purpose === undefined || task.spec.purpose === purpose).map(([taskId, task]) => ({ taskId, spec: task.spec }));
  }

  stoppedFor(taskId: string): StopReason | undefined { return this.tasks.get(taskId)?.stoppedFor; }

  async closeAll(): Promise<void> { await Promise.all([...this.tasks.values()].map(async (task) => { await task.bridge?.close(); })); }
}
