import { describe, expect, it, vi } from "vitest";
import type { McpServerEntry } from "@agentx/contracts";
import { dynamoMcpServerStore, summariseProbe } from "../../../packages/broker/src/context-sources/mcp-servers.js";
import { gatewayProber, gatewayServerPort, sourceEnvironment, type ConnectionLookup } from "../../../packages/broker/src/context-sources/server-port.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { CONNECTION, GET_TOOL, NOW, ORG, SEARCH_TOOL } from "./fixtures.js";

const connection = (over: Partial<Awaited<ReturnType<ConnectionLookup["read"]>> & object> = {}): ConnectionLookup => ({
  read: async () => ({ type: "mcp", access: "read", endpoint: "https://mcp.vendor.example/mcp", ...over }), token: async () => "secret-token",
});
const http = (status: McpServerEntry["status"] = "approved"): McpServerEntry => ({
  serverId: "mcpsim000001", label: "SIM", status, transport: { kind: "http", address: "https://sim.corp.example:8443/mcp" }, probe: summariseProbe([], NOW), requestedBy: "dev1", requestedAt: "2026-11-01T10:00:00Z",
});

function world(options: { entries?: McpServerEntry[]; connections?: ConnectionLookup; edition?: "enterprise" | "public"; mcpHost?: { url: string; token: string }; secrets?: Record<string, string>; stdio?: boolean } = {}) {
  const table = new FakeDynamoDb();
  const store = dynamoMcpServerStore({ documentClient: table, tableName: "state" });
  const connects: Array<Record<string, unknown>> = [];
  const guards: string[] = [];
  const tools = [SEARCH_TOOL, GET_TOOL].map((tool) => ({ ...tool }));
  const port = gatewayServerPort({
    edition: options.edition ?? "enterprise", connections: options.connections ?? connection(), servers: store, stdioEnabled: options.stdio !== false, serverSecrets: { read: async (_org: unknown, id: string) => options.secrets?.[id] }, ...(options.mcpHost === undefined ? {} : { mcpHost: options.mcpHost }),
    publicGuard: async (endpoint) => { guards.push(`public:${endpoint.host}`); return (async () => new Response("")); },
    privateGuard: () => async (endpoint) => { guards.push(`private:${endpoint.host}`); return (async () => new Response("")); },
    connect: (async (input: Record<string, unknown>) => { connects.push(input); return { tools, call: async () => ({ content: [{ type: "text", text: "ok" }] }), close: async () => undefined }; }) as never,
    list: (async (input: Record<string, unknown>) => { connects.push({ ...input, all: true }); return tools; }),
  });
  return { port, store, connects, guards, seed: async () => { for (const entry of options.entries ?? []) await store.create(ORG, entry); } };
}
const signal = () => AbortSignal.timeout(5_000);

describe("a connection", () => {
  it("is reached through the public guard, with its token, discovering only the ticked tools", async () => {
    const w = world();
    const session = await w.port.open(ORG, { kind: "connection", connectionId: CONNECTION }, signal(), ["search_tickets"]);
    expect(w.guards).toEqual(["public:mcp.vendor.example"]);
    expect(w.connects[0]).toMatchObject({ token: "secret-token", tools: ["search_tickets"] });
    expect(session.hosts).toEqual(["mcp.vendor.example"]);
    expect((await session.call("get_ticket", {}, signal())).content?.[0]?.text).toBe("ok");
  });
  it("is refused when it can also write, is not an MCP connection, or has no key or endpoint", async () => {
    for (const bad of [connection({ access: "read_write" }), connection({ type: "linear" }), connection({ endpoint: undefined }), { read: async () => ({ type: "mcp" as const, access: "read" as const, endpoint: "https://mcp.vendor.example/mcp" }), token: async () => undefined }]) {
      await expect(world({ connections: bad }).port.open(ORG, { kind: "connection", connectionId: CONNECTION }, signal(), ["x"])).rejects.toBeDefined();
    }
    await expect(world({ connections: { read: async () => undefined, token: async () => "t" } }).port.open(ORG, { kind: "connection", connectionId: CONNECTION }, signal(), ["x"])).rejects.toBeDefined();
  });
});

describe("a registered http server", () => {
  const server = { kind: "registered_server" as const, serverId: "mcpsim000001" };
  it("is reached through the allow-list guard, with no token when it has none", async () => {
    const w = world({ entries: [http()] });
    await w.seed();
    const session = await w.port.open(ORG, server, signal(), ["search_tickets"]);
    expect(w.guards).toEqual(["private:sim.corp.example:8443"]);
    expect(w.connects[0]).toMatchObject({ token: "", auth: { header: "x-rovara-client" } });
    expect(session.hosts).toEqual(["sim.corp.example"]);
  });
  it("is read afresh on every call: a server disabled a moment ago, or never approved, is not reached", async () => {
    const w = world({ entries: [http("awaiting_approval")] });
    await w.seed();
    await expect(w.port.open(ORG, server, signal(), ["x"])).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(w.connects).toEqual([]);
    const approved = world({ entries: [http()] });
    await approved.seed();
    await approved.port.open(ORG, server, signal(), ["x"]);
    await approved.store.decide({ orgId: ORG, serverId: "mcpsim000001", from: "approved", to: "disabled", by: "dev1", at: "t" });
    await expect(approved.port.open(ORG, server, signal(), ["x"])).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("is not reached in Public, whatever the table holds", async () => {
    const w = world({ entries: [http()], edition: "public" });
    await w.seed();
    await expect(w.port.open(ORG, server, signal(), ["x"])).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(w.connects).toEqual([]);
  });
  it("sends the server's own token, read now, and no connection is involved", async () => {
    const w = world({ entries: [{ ...http(), hasSecret: true, secretVersion: "v1" }], secrets: { mcpsim000001: "its-own-token" }, connections: { read: async () => undefined, token: async () => "an-org-connection-token" } });
    await w.seed();
    await w.port.open(ORG, server, signal(), ["x"]);
    expect(w.connects[0]).toMatchObject({ token: "its-own-token" });
    expect(w.connects[0]).not.toHaveProperty("auth");
    expect(JSON.stringify(w.connects)).not.toContain("an-org-connection-token");
  });
  it("is refused, with nothing sent, when the token it should have cannot be read", async () => {
    const w = world({ entries: [{ ...http(), hasSecret: true, secretVersion: "v1" }], secrets: {} });
    await w.seed();
    await expect(w.port.open(ORG, server, signal(), ["x"])).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(w.connects).toEqual([]);
  });
});

describe("a registered stdio server", () => {
  const stdio = (): McpServerEntry => ({ ...http(), transport: { kind: "stdio", spec: { registry: "npm", name: "pkg", version: "1.0.0", args: [], integrity: `sha512-${"A".repeat(86)}==` } } });
  it("is reached through the MCP host with the host's token, and no address is on its site", async () => {
    const w = world({ entries: [stdio()], mcpHost: { url: "https://mcp-host.internal:8080/", token: "h".repeat(40) } });
    await w.seed();
    const session = await w.port.open(ORG, { kind: "registered_server", serverId: "mcpsim000001" }, signal(), ["x"]);
    expect(w.connects[0]).toMatchObject({ token: "h".repeat(40) });
    expect(String((w.connects[0]!.endpoint as URL).href)).toBe("https://mcp-host.internal:8080/servers/mcpsim000001/mcp");
    expect(session.hosts).toEqual([]);
    expect(w.guards).toEqual([]);
  });
  it("is never reached while package-run servers are off, and the host is not called", async () => {
    const w = world({ entries: [stdio()], stdio: false, mcpHost: { url: "https://mcp-host.internal:8080/", token: "h".repeat(40) } });
    await w.seed();
    await expect(w.port.open(ORG, { kind: "registered_server", serverId: "mcpsim000001" }, signal(), ["x"])).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(w.connects).toEqual([]);
  });
  it("is unavailable without a host", async () => {
    const w = world({ entries: [stdio()] });
    await w.seed();
    await expect(w.port.open(ORG, { kind: "registered_server", serverId: "mcpsim000001" }, signal(), ["x"])).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });
});

describe("the settings view of the world", () => {
  it("reports a connection's access and a server's status, and can list every tool", async () => {
    const w = world({ entries: [http()] });
    await w.seed();
    const env = sourceEnvironment({ edition: "enterprise", connections: connection(), servers: w.store, port: w.port });
    expect(await env.connection(ORG, CONNECTION)).toEqual({ type: "mcp", access: "read" });
    expect(await env.registeredServer(ORG, "mcpsim000001")).toEqual({ status: "approved" });
    expect(await env.registeredServer(ORG, "mcpnope000001")).toBeUndefined();
    expect((await env.discoverTools(ORG, { kind: "connection", connectionId: CONNECTION })).map((tool) => tool.name)).toEqual(["search_tickets", "get_ticket"]);
    expect(env.perUserCheckAvailable({} as never)).toBe(false);
  });
});

describe("testing a pasted address", () => {
  const listed = [SEARCH_TOOL];
  it("pins the connection through the probe guard and lists the tools", async () => {
    const list = vi.fn((input: unknown) => Promise.resolve(input === undefined ? [] : listed));
    const guard = vi.fn(async () => (async () => new Response("")));
    const tools = await gatewayProber({ guard, list: list }).http("https://sim.corp.example/mcp", undefined);
    expect(tools.map((tool) => tool.name)).toEqual(["search_tickets"]);
    expect(guard).toHaveBeenCalledOnce();
    expect(list.mock.calls[0]![0]).toMatchObject({ token: "", auth: { header: "x-rovara-client" } });
  });
  it.each([
    [Object.assign(new Error("MCP server rejected the credential"), { name: "McpUnauthorized" }), "unauthorized"],
    [new Error("the MCP server's host resolves to an address Rovara never calls"), "not_allowed_address"],
    [new Error("the MCP server's host could not be looked up; try again"), "dns_failed"],
    [new Error("connect ECONNREFUSED 10.0.0.5:443"), "unreachable"],
    [Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }), "timed_out"],
    [new Error("Unexpected token < in JSON"), "not_mcp"],
  ])("maps %s to the fixed code %s", async (error, code) => {
    await expect(gatewayProber({ guard: async () => { throw error; } }).http("https://sim.corp.example/mcp", undefined)).rejects.toMatchObject({ code });
  });
});

describe("review I2: the default private guard uses the install's ranges", () => {
  it("refuses a registered server when the install has set no ranges", async () => {
    const table = new FakeDynamoDb();
    const store = dynamoMcpServerStore({ documentClient: table, tableName: "state" });
    await store.create(ORG, http());
    const port = gatewayServerPort({ edition: "enterprise", connections: connection(), servers: store, connect: (async () => { throw new Error("must not connect"); }) });
    await expect(port.open(ORG, { kind: "registered_server", serverId: "mcpsim000001" }, signal(), ["x"])).rejects.toBeDefined();
  });
});

describe("review I6: the MCP host is reached over https", () => {
  const stdioEntry = (): McpServerEntry => ({ ...http(), transport: { kind: "stdio", spec: { registry: "npm", name: "pkg", version: "1.0.0", args: [], integrity: `sha512-${"A".repeat(86)}==` } } });
  it("refuses an http:// host address, except this machine's own loopback", async () => {
    const { assertSecureHostUrl } = await import("../../../packages/broker/src/context-sources/server-port.js");
    expect(() => assertSecureHostUrl("http://mcp-host.internal:8080")).toThrow(/https/u);
    expect(() => assertSecureHostUrl("http://10.0.0.5:8080")).toThrow(/https/u);
    expect(() => assertSecureHostUrl("not a url")).toThrow();
    expect(assertSecureHostUrl("https://mcp-host.internal").protocol).toBe("https:");
    expect(assertSecureHostUrl("http://127.0.0.1:9999").hostname).toBe("127.0.0.1");
  });
  it("never sends the host's token to an http:// address", async () => {
    const w = world({ entries: [stdioEntry()], mcpHost: { url: "http://mcp-host.internal:8080/", token: "h".repeat(40) } });
    await w.seed();
    await expect(w.port.open(ORG, { kind: "registered_server", serverId: "mcpsim000001" }, signal(), ["x"])).rejects.toBeDefined();
    expect(w.connects).toEqual([]);
  });
});
