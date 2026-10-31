// Lane E, task E6: the MCP host runs a real stdio MCP server and shows it over HTTP; the broker's own port reaches it, lists its tools, calls it, and its probe works.
// No network beyond the loopback: the package launcher is replaced by `node tests/support/stdio-mcp-fixture.mjs`.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { McpServerEntry, McpStdioSpec } from "@agentx/contracts";
import { createMcpHost, scrubbedEnvironment, type HostLauncher } from "../../packages/gateway/src/mcp-host.js";
import { McpProbeError, dynamoMcpServerStore, summariseProbe } from "../../packages/broker/src/context-sources/mcp-servers.js";
import { gatewayProber, gatewayServerPort, hostProbeClient } from "../../packages/broker/src/context-sources/server-port.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { NOW, ORG } from "../unit/context-sources/fixtures.js";

const FIXTURE = join(import.meta.dirname, "..", "support", "stdio-mcp-fixture.mjs");
const TOKEN = "t".repeat(40);
const spec: McpStdioSpec = { registry: "npm", name: "@acme/sim-mcp", version: "1.4.2", args: [] };
const launcher = (verify?: HostLauncher["verify"]): HostLauncher => ({ command: () => ({ command: process.execPath, args: [FIXTURE] }), ...(verify === undefined ? {} : { verify }) });

const open: Array<{ server: Server; close: () => Promise<void> }> = [];
afterEach(async () => { await Promise.all(open.splice(0).map(async (entry) => { await entry.close(); await new Promise((resolve) => entry.server.close(resolve)); })); });

async function startHost(options: { approved?: string[]; launcher?: HostLauncher; max?: number; idleMs?: number } = {}) {
  process.env.MCP_HOST_SECRET_FOR_TEST = "must-not-reach-a-hosted-server";
  const approved = new Set(options.approved ?? ["mcpsim000001"]);
  const host = createMcpHost({
    token: TOKEN, launcher: options.launcher ?? launcher(), registry: { approvedStdio: async (id) => (approved.has(id) ? spec : undefined) },
    ...(options.max === undefined ? {} : { maxProcesses: options.max }), ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }), probeTimeoutMs: 20_000,
  });
  const server = createServer((req, res) => { void host.handle(req, res); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  open.push({ server, close: () => host.close() });
  return { host, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, approved };
}

const stdioServer = (serverId: string) => ({ kind: "registered_server" as const, serverId });

function portFor(url: string, entries: McpServerEntry[], edition: "enterprise" | "public" = "enterprise") {
  const table = new FakeDynamoDb();
  const store = dynamoMcpServerStore({ documentClient: table, tableName: "state" });
  return Promise.all(entries.map((entry) => store.create(ORG, entry))).then(() => gatewayServerPort({
    edition, connections: { read: async () => undefined, token: async () => undefined }, servers: store, mcpHost: { url, token: TOKEN },
  }));
}
const entry = (serverId: string, over: Partial<McpServerEntry> = {}): McpServerEntry => ({
  serverId, label: "Wiki", status: "approved", transport: { kind: "stdio", spec }, probe: summariseProbe([], NOW), requestedBy: "dev1", requestedAt: "2026-11-01T10:00:00Z", ...over,
});

describe("the MCP host", () => {
  it("serves an approved stdio server as MCP over HTTP: the broker's port lists its tools and calls it", async () => {
    const { url } = await startHost();
    const port = await portFor(url, [entry("mcpsim000001")]);
    const all = await port.listAll!(ORG, stdioServer("mcpsim000001"), AbortSignal.timeout(20_000));
    expect(all.map((tool) => tool.name).sort()).toEqual(["echo", "env_keys"]);
    expect(all.find((tool) => tool.name === "echo")?.annotations?.readOnlyHint).toBe(true);
    const session = await port.open(ORG, stdioServer("mcpsim000001"), AbortSignal.timeout(20_000), ["echo"]);
    try {
      expect(session.hosts).toEqual([]);
      const answer = await session.call("echo", { word: "hello" }, AbortSignal.timeout(20_000));
      expect(answer.content?.[0]?.text).toBe("echo:hello");
    } finally {
      await session.close();
    }
  }, 60_000);

  it("gives the hosted server a scrubbed environment: none of the host's own variables, a private home as its folder", async () => {
    const { url } = await startHost();
    const port = await portFor(url, [entry("mcpsim000001")]);
    const session = await port.open(ORG, stdioServer("mcpsim000001"), AbortSignal.timeout(20_000), ["env_keys"]);
    try {
      const answer = await session.call("env_keys", {}, AbortSignal.timeout(20_000));
      const keys = String(answer.content?.[0]?.text).split(",");
      expect(keys).toContain("HOME");
      expect(keys).not.toContain("MCP_HOST_SECRET_FOR_TEST");
      expect(keys).not.toContain("AWS_SECRET_ACCESS_KEY");
      expect(scrubbedEnvironment("/h")).not.toHaveProperty("MCP_HOST_SECRET_FOR_TEST");
    } finally {
      await session.close();
    }
  }, 60_000);

  it("turns away a missing or wrong token, and an id the registry does not call approved, without saying whether it exists", async () => {
    const { url } = await startHost();
    const post = (path: string, headers: Record<string, string>) => fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
    expect((await post("/servers/mcpsim000001/mcp", {})).status).toBe(401);
    expect((await post("/servers/mcpsim000001/mcp", { authorization: `Bearer ${"x".repeat(40)}` })).status).toBe(401);
    expect((await post("/probe", {})).status).toBe(401);
    expect((await post("/servers/mcpunknown001/mcp", { authorization: `Bearer ${TOKEN}` })).status).toBe(404);
    expect((await post("/servers/..%2F..%2Fetc/mcp", { authorization: `Bearer ${TOKEN}` })).status).toBe(404);
    expect((await fetch(`${url}/servers/mcpsim000001/mcp`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(405);
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
  }, 30_000);

  it("stops serving an entry the moment the registry stops calling it approved", async () => {
    const { url, approved } = await startHost();
    const port = await portFor(url, [entry("mcpsim000001")]);
    const first = await port.open(ORG, stdioServer("mcpsim000001"), AbortSignal.timeout(20_000), ["echo"]);
    await first.close();
    approved.clear();
    await expect(port.open(ORG, stdioServer("mcpsim000001"), AbortSignal.timeout(20_000), ["echo"])).rejects.toBeDefined();
  }, 60_000);

  it("fails closed when the registry cannot be read", async () => {
    const host = createMcpHost({ token: TOKEN, launcher: launcher(), registry: { approvedStdio: async () => { throw new Error("table down"); } } });
    const server = createServer((req, res) => { void host.handle(req, res); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    open.push({ server, close: () => host.close() });
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/servers/mcpsim000001/mcp`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: "{}" });
    expect(response.status).toBe(503);
  });

  it("keeps to its process limit by stopping the one used longest ago", async () => {
    const { host, url } = await startHost({ approved: ["mcpone0000001", "mcptwo0000001"], max: 1 });
    const port = await portFor(url, [entry("mcpone0000001"), entry("mcptwo0000001")]);
    for (const id of ["mcpone0000001", "mcptwo0000001"]) {
      const session = await port.open(ORG, stdioServer(id), AbortSignal.timeout(20_000), ["echo"]);
      await session.close();
      expect(host.running()).toBeLessThanOrEqual(1);
    }
  }, 60_000);

  it("probes a package for the admin before it is approved, and shows its tools", async () => {
    const { url } = await startHost({ approved: [] });
    const prober = gatewayProber({ host: hostProbeClient({ url, token: TOKEN }) });
    const tools = await prober.stdio(spec);
    expect(tools.map((tool) => tool.name).sort()).toEqual(["echo", "env_keys"]);
  }, 60_000);

  it("refuses to probe a package whose integrity does not match, and says only that the host refused", async () => {
    const { url } = await startHost({ approved: [], launcher: launcher(async () => false) });
    const prober = gatewayProber({ host: hostProbeClient({ url, token: TOKEN }) });
    await expect(prober.stdio({ ...spec, integrity: `sha512-${"A".repeat(40)}` })).rejects.toMatchObject({ code: "host_refused" });
  }, 30_000);

  it("says the host is unavailable when there is none, or its token is wrong", async () => {
    await expect(gatewayProber({}).stdio(spec)).rejects.toMatchObject({ code: "host_unavailable" });
    const { url } = await startHost({ approved: [] });
    await expect(gatewayProber({ host: hostProbeClient({ url, token: "wrong".repeat(10) }) }).stdio(spec)).rejects.toBeInstanceOf(McpProbeError);
  }, 30_000);

  it("is not offered by Public: the port refuses a registered server there", async () => {
    const { url } = await startHost();
    const port = await portFor(url, [entry("mcpsim000001")], "public");
    await expect(port.open(ORG, stdioServer("mcpsim000001"), AbortSignal.timeout(5_000), ["echo"])).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
