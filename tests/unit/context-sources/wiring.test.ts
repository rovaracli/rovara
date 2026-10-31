import { describe, expect, it } from "vitest";
import { createContextSourceRouteDependencies, createContextSourcesRuntime, createMcpServerDependencies } from "../../../packages/broker/src/context-sources/wiring.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { NOW, ORG } from "./fixtures.js";

const base = (edition: "enterprise" | "public") => ({
  documentClient: new FakeDynamoDb(), tableName: "state", now: () => NOW, edition,
  connections: { read: async () => ({ type: "mcp", access: "read" as const, endpoint: "https://mcp.vendor.example/mcp" }), token: async () => "t" },
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
  it("make the MCP servers flow, which Public refuses", async () => {
    const deps = createMcpServerDependencies(base("public"));
    await expect(deps.authConnectionUsable(ORG, "con_aaaaaaaaaaaaaaaaaaaa")).resolves.toBe(true);
    const { listMcpServers } = await import("../../../packages/broker/src/context-sources/mcp-servers.js");
    await expect(listMcpServers(deps, { orgId: ORG, developerId: "d", orgRole: "admin" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(listMcpServers(createMcpServerDependencies(base("enterprise")), { orgId: ORG, developerId: "d", orgRole: "admin" })).resolves.toEqual([]);
  });
});
