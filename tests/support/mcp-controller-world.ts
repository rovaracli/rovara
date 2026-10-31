// Stdio MCP host redesign (T6, T7): a controller on two real loopback listeners with a fake task runner, for the controller's tests.
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import type { McpStdioSpec } from "@agentx/contracts";
import { createMcpController, type ApprovedServer, type McpController, type McpControllerOptions, type ProbedTool } from "../../packages/gateway/src/mcp-controller.js";
import { directoryBundleStore, type BundleStore } from "../../packages/gateway/src/mcp-runner/bundle-store.js";
import { FakeRunner, sha256, toolsHashOfNames, type FakeRunnerOptions } from "./mcp-controller-fixtures.js";

export const BROKER = "b".repeat(48);
export const BYTES = Buffer.from("a bundle");
export const BUNDLE = sha256(BYTES);
export const OTHER_BYTES = Buffer.from("another bundle");
export const OTHER = sha256(OTHER_BYTES);
export const INTEGRITY = `sha512-${"A".repeat(86)}==`;
export const ECHO: ProbedTool[] = [{ name: "echo", inputSchema: { type: "object" } }];
export const specOf = (bundleHash = BUNDLE, over: Partial<McpStdioSpec> = {}): McpStdioSpec => ({
  registry: "npm", name: "@acme/sim-mcp", version: "1.4.2", args: ["--read-only"], integrity: INTEGRITY, lockfileHash: "1".repeat(64), bundleHash, destinations: [], secretEnv: ["JIRA_TOKEN"], size: { cpu: 256, memoryMiB: 512 }, ...over,
});
export const approvedOf = (over: Partial<ApprovedServer> = {}): ApprovedServer => ({ spec: specOf(), toolsHash: toolsHashOfNames(ECHO), ...over });

let work: string;
const open: Array<() => Promise<void>> = [];
/** Call once at the top level of a test file: it makes the working folder before each test and closes everything after it. */
export function useControllerWorld(): void {
  beforeEach(async () => { work = await mkdtemp(join(tmpdir(), "controller-test-")); });
  afterEach(async () => {
    for (const close of open.splice(0).reverse()) await close();
    await rm(work, { recursive: true, force: true });
  });
}

const listen = async (handler: (req: Parameters<McpController["handleBroker"]>[0], res: Parameters<McpController["handleBroker"]>[1]) => void): Promise<{ server: Server; url: string }> => {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  open.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
};

export async function world(over: { runner?: FakeRunnerOptions; approved?: Record<string, ApprovedServer>; registryThrows?: boolean; controller?: Partial<McpControllerOptions>; bundles?: BundleStore } = {}) {
  const runner = new FakeRunner(over.runner);
  open.push(() => runner.closeAll());
  const bundles = over.bundles ?? directoryBundleStore(join(work, "bundles"));
  const approved = new Map<string, ApprovedServer>(Object.entries(over.approved ?? { mcpsim000001: approvedOf() }));
  const changes: Array<{ serverId: string; approved: string; observed: string }> = [];
  /** Flip `registryDown` to make the registry unreadable from then on. */
  const state = { registryDown: over.registryThrows === true };
  const later: { controller?: McpController } = {};
  const broker = await listen((req, res) => { void later.controller!.handleBroker(req, res); });
  const runnerListener = await listen((req, res) => { void later.controller!.handleRunner(req, res); });
  const controller = createMcpController({
    token: BROKER, runner, bundles, controllerUrl: runnerListener.url, npmRegistry: "https://registry.example/", toolsHashOf: toolsHashOfNames, pollMs: 5,
    limits: { startMs: 1_500, installMs: 2_000 }, sweepMs: 0,
    registry: {
      approved: async (id) => { if (state.registryDown) throw new Error("table down"); return approved.get(id); },
      toolsChanged: async (serverId, change) => { changes.push({ serverId, ...change }); },
    },
    ...over.controller,
  });
  later.controller = controller;
  open.push(() => controller.close());
  return { runner, bundles, approved, changes, state, controller, brokerUrl: broker.url, runnerUrl: runnerListener.url };
}

export const post = (url: string, path: string, token: string | undefined, body: unknown = {}, headers: Record<string, string> = {}) => fetch(`${url}${path}`, {
  method: "POST", headers: { "content-type": "application/json", ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), ...headers }, body: typeof body === "string" ? body : JSON.stringify(body),
});
export const CALL = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: {} } };
/** The MCP request the broker makes: the transport sends initialize first, but a stateless server answers any request. */
export const mcp = (url: string, id: string, body: unknown = CALL, token: string | undefined = BROKER) => post(url, `/servers/${id}/mcp`, token, body, { accept: "application/json, text/event-stream" });
/** The token a container of a task got by redeeming its nonce (the spec holds only the nonce). */
export const tokenOf = (runner: FakeRunner, taskId: string, container: "fetch" | "server" | "install" = "server"): string => runner.tokenOf(taskId, container);

