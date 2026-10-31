// Lane E fix round 2, I-A: a private server that needs a token can be added, approved and called end to end. The server is a real MCP server on the loopback that answers
// only to its own bearer token; the broker's own prober and port talk to it through the same MCP client the product uses. Only the network guard is replaced: it hands
// back a fetch that goes to the loopback and refuses any origin but the one that was checked (as the pinned fetch does).
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { approveMcpServer, dynamoMcpServerStore, proposeMcpServer, type McpServerDependencies, type McpServerSecrets } from "../../packages/broker/src/context-sources/mcp-servers.js";
import { gatewayProber, gatewayServerPort } from "../../packages/broker/src/context-sources/server-port.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { NOW, ORG } from "../unit/context-sources/fixtures.js";

const ADDRESS = "https://tracker.internal.example/mcp";
const open: HttpServer[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))); });

async function startServer(token: string) {
  const seen: Array<string | undefined> = [];
  const http = createServer((req, res) => {
    seen.push(req.headers.authorization);
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const server = new Server({ name: "tracker", version: "1.0.0" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "get_ticket", description: "Read a ticket", inputSchema: { type: "object", properties: { id: { type: "string" } } }, annotations: { readOnlyHint: true } }] }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => ({ content: [{ type: "text", text: `ticket ${String(request.params.arguments?.id)}` }] }));
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      res.on("close", () => { void transport.close(); void server.close(); });
      void server.connect(transport as Transport).then(() => transport.handleRequest(req, res, JSON.parse(Buffer.concat(chunks).toString("utf8") || "null") as unknown));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  open.push(http);
  return { seen, base: `http://127.0.0.1:${(http.address() as AddressInfo).port}` };
}

/** A guard that, like the pinned fetch, connects only to the origin that was checked: here that origin stands for the loopback server. */
function guardTo(base: string, checked: string[]) {
  return async (endpoint: URL): Promise<typeof fetch> => {
    checked.push(endpoint.origin);
    return (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== endpoint.origin) throw new TypeError("a request to anywhere but the checked endpoint was refused");
      return fetch(`${base}${url.pathname}`, init);
    });
  };
}

function world(base: string) {
  const table = new FakeDynamoDb();
  const store = dynamoMcpServerStore({ documentClient: table, tableName: "state" });
  const vault = new Map<string, string>();
  const checked: string[] = [];
  const secrets: McpServerSecrets = { put: async (_o, id, value) => { vault.set(id, value); return "v1"; }, read: async (_o, id) => vault.get(id), remove: async (_o, id) => { vault.delete(id); } };
  const deps: McpServerDependencies = {
    store, edition: "enterprise", now: () => NOW, secrets, stdioEnabled: false,
    prober: gatewayProber({ guard: guardTo(base, checked), privateCidrs: ["10.0.0.0/8"] }),
  };
  const port = gatewayServerPort({
    edition: "enterprise", connections: { read: async () => undefined, token: async () => "an-org-connection-token" }, servers: store, serverSecrets: secrets, privateCidrs: ["10.0.0.0/8"],
    privateGuard: () => guardTo(base, checked),
  });
  return { deps, port, vault, checked };
}
const admin = { orgId: ORG, developerId: "dev1", orgRole: "admin" };
const signal = () => AbortSignal.timeout(10_000);

describe("a private server that needs a token", () => {
  it("is added with its own token, approved, listed and called, and the token goes only to its checked origin", async () => {
    const tracker = await startServer("srv-token-1");
    const { deps, port, vault, checked } = world(tracker.base);
    const entry = await proposeMcpServer(deps, admin, { label: "Tracker", transport: { kind: "http", address: ADDRESS }, secret: "srv-token-1" });
    expect(entry.probe.tools.map((tool) => tool.name)).toEqual(["get_ticket"]);
    expect(JSON.stringify(entry)).not.toContain("srv-token-1");
    await approveMcpServer(deps, admin, entry.serverId);
    const all = await port.listAll!(ORG, { kind: "registered_server", serverId: entry.serverId }, signal());
    expect(all.map((tool) => tool.name)).toEqual(["get_ticket"]);
    const session = await port.open(ORG, { kind: "registered_server", serverId: entry.serverId }, signal(), ["get_ticket"]);
    try {
      expect(session.hosts).toEqual(["tracker.internal.example"]);
      expect((await session.call("get_ticket", { id: "ABC-1" }, signal())).content?.[0]?.text).toBe("ticket ABC-1");
    } finally { await session.close(); }
    // every request the server saw (test, approval test, list, call) carried its own token and nothing else
    expect(tracker.seen.length).toBeGreaterThanOrEqual(4);
    expect(new Set(tracker.seen)).toEqual(new Set(["Bearer srv-token-1"]));
    expect(new Set(checked)).toEqual(new Set(["https://tracker.internal.example"]));
    expect(vault.size).toBe(1);
  }, 60_000);

  it("is refused at the test when it is given no token, or a wrong one, and nothing is stored", async () => {
    const tracker = await startServer("srv-token-1");
    const { deps, vault } = world(tracker.base);
    await expect(proposeMcpServer(deps, admin, { label: "Tracker", transport: { kind: "http", address: ADDRESS } })).rejects.toThrow(/login/u);
    await expect(proposeMcpServer(deps, admin, { label: "Tracker", transport: { kind: "http", address: ADDRESS }, secret: "wrong" })).rejects.toThrow(/login/u);
    expect(vault.size).toBe(0);
    expect(await deps.store.list(ORG)).toEqual([]);
  }, 30_000);

  it("never sends an org connection's token to it, and stops when the server's own token is gone", async () => {
    const tracker = await startServer("srv-token-1");
    const { deps, port, vault } = world(tracker.base);
    const entry = await proposeMcpServer(deps, admin, { label: "Tracker", transport: { kind: "http", address: ADDRESS }, secret: "srv-token-1" });
    await approveMcpServer(deps, admin, entry.serverId);
    vault.clear();
    await expect(port.open(ORG, { kind: "registered_server", serverId: entry.serverId }, signal(), ["get_ticket"])).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(tracker.seen).not.toContain("Bearer an-org-connection-token");
  }, 30_000);
});
