import { describe, expect, it } from "vitest";
import { createContextSourceRouteDependencies, createContextSourcesRuntime, createMcpServerDependencies } from "../../../packages/broker/src/context-sources/wiring.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { NOW, ORG } from "./fixtures.js";

const base = (edition: "enterprise" | "public") => ({
  documentClient: new FakeDynamoDb(), tableName: "state", now: () => NOW, edition,
  connections: { read: async () => ({ type: "mcp", access: "read" as const, endpoint: "https://mcp.vendor.example/mcp" }), token: async () => "t" },
  serverSecrets: { put: async () => "v1", read: async () => undefined, remove: async () => undefined },
});

describe("the builders the broker's wiring calls", () => {
  it("make the stage runtime, with the stores and the real server port", () => {
    const runtime = createContextSourcesRuntime(base("enterprise"));
    expect(typeof runtime.servers.open).toBe("function");
    expect(typeof runtime.servers.listAll).toBe("function");
    expect(runtime.citations).toBeDefined();
    expect(runtime.results).toBeDefined();
    expect(runtime.teamRecordAvailable).toBeUndefined();
    expect(createContextSourcesRuntime({ ...base("enterprise"), teamSearch: { search: async () => [] } }).teamRecordAvailable).toBe(true);
  });
  it("make the Sources settings, whose rules see the real world", async () => {
    const deps = createContextSourceRouteDependencies({ ...base("public"), requireProjectRole: async () => undefined });
    expect(await deps.env.connection(ORG, "con_aaaaaaaaaaaaaaaaaaaa")).toEqual({ type: "mcp", access: "read" });
    expect(await deps.env.registeredServer(ORG, "mcpnope000001")).toBeUndefined();
    expect(deps.env.edition).toBe("public");
  });
  it("keep the MCP host out of reach unless package-run servers are switched on (Enterprise only)", async () => {
    const host = { url: "http://mcp-host.internal", token: "h".repeat(40) };
    const off = createMcpServerDependencies({ ...base("enterprise"), mcpHost: host });
    await expect(off.prober.stdio({ registry: "npm", name: "p", version: "1.0.0", args: [], destinations: [], secretEnv: [], size: { cpu: 256, memoryMiB: 512 } })).rejects.toMatchObject({ code: "host_unavailable" });
    const on = createMcpServerDependencies({ ...base("enterprise"), mcpHost: host, stdioEnabled: true });
    expect(on.stdioEnabled).toBe(true);
    // switched on, the host is asked (an http:// address is refused before anything is sent, which is a different failure from "no host")
    await expect(on.prober.stdio({ registry: "npm", name: "p", version: "1.0.0", args: [], destinations: [], secretEnv: [], size: { cpu: 256, memoryMiB: 512 } })).rejects.toMatchObject({ code: "host_refused" });
  });
  it("name a registered server's token under the connector path, with a leaf that cannot climb out of the org", async () => {
    const { serverSecretsFromOrgSecrets } = await import("../../../packages/broker/src/context-sources/wiring.js");
    const calls: string[] = [];
    const record = (name: string): void => { calls.push(name); };
    const secrets = serverSecretsFromOrgSecrets({ env: "staging", secrets: { put: async (_o: string, name: string) => { record(name); return "v1"; }, read: async (_o: string, name: string) => { record(name); return undefined; }, scheduleDelete: async (_o: string, name: string) => { record(name); } } });
    await secrets.put(ORG, "mcpabc123456", "t");
    expect(calls).toEqual([`agentx/staging/org-connectors/${ORG}/mcpabc123456`]);
    await expect(secrets.put(ORG, "../con_x", "t")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("make the MCP servers flow, which Public refuses", async () => {
    const deps = createMcpServerDependencies(base("public"));
    const { listMcpServers } = await import("../../../packages/broker/src/context-sources/mcp-servers.js");
    await expect(listMcpServers(deps, { orgId: ORG, developerId: "d", orgRole: "admin" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(listMcpServers(createMcpServerDependencies(base("enterprise")), { orgId: ORG, developerId: "d", orgRole: "admin" })).resolves.toEqual([]);
  });
});
