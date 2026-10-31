// ME-13 (wire lane C): the install passes what the operator set to the lane E builders. The ranges come from ROVARA_PRIVATE_MCP_CIDRS, the MCP host address must be https, package-run servers stay
// off unless the operator turns them on in an Enterprise install that also gave the host, and each registered server's token goes to the org's secret store under its own path.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Wiring from "../../../packages/broker/src/context-sources/wiring.js";
import type { OrgConnectionDeps } from "../../../packages/broker/src/connections/store.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { NOW, ORG } from "./fixtures.js";

const seen = vi.hoisted(() => ({ runtime: [] as Array<Record<string, unknown>>, routes: [] as Array<Record<string, unknown>>, servers: [] as Array<Record<string, unknown>> }));
vi.mock("../../../packages/broker/src/context-sources/wiring.js", async (importOriginal) => {
  const original = await importOriginal<typeof Wiring>();
  return {
    ...original,
    createContextSourcesRuntime: (deps: Parameters<typeof original.createContextSourcesRuntime>[0]) => { seen.runtime.push(deps as unknown as Record<string, unknown>); return original.createContextSourcesRuntime(deps); },
    createContextSourceRouteDependencies: (deps: Parameters<typeof original.createContextSourceRouteDependencies>[0]) => { seen.routes.push(deps as unknown as Record<string, unknown>); return original.createContextSourceRouteDependencies(deps); },
    createMcpServerDependencies: (deps: Parameters<typeof original.createMcpServerDependencies>[0]) => { seen.servers.push(deps as unknown as Record<string, unknown>); return original.createMcpServerDependencies(deps); },
  };
});

const { privateMcpInstallConfig, installContextSources, sharedContextSourcesInstall } = await import("../../../packages/broker/src/context-sources/install.js");

const HOST_TOKEN = ["h", "o", "s", "t"].join("").padEnd(40, "x");

describe("the install's MCP settings", () => {
  it("an install with no edition is Public: no private ranges, no package-run servers, and no host is read", () => {
    expect(privateMcpInstallConfig({})).toEqual({ edition: "public", privateCidrs: [], rovaraCidrs: [], stdioEnabled: false });
    expect(privateMcpInstallConfig({ ROVARA_EDITION: "" })).toMatchObject({ edition: "public" });
    // Public ignores every private-network setting rather than half-honouring it
    expect(privateMcpInstallConfig({ ROVARA_EDITION: "public", ROVARA_PRIVATE_MCP_CIDRS: "10.0.0.0/8", ROVARA_STDIO_MCP_SERVERS: "1", MCP_HOST_URL: "https://h.example.net", MCP_HOST_TOKEN: HOST_TOKEN }))
      .toEqual({ edition: "public", privateCidrs: [], rovaraCidrs: [], stdioEnabled: false });
  });
  it("an edition that is not exactly enterprise or public stops the install", () => {
    for (const edition of ["Enterprise", "enterprise ", "team"]) expect(() => privateMcpInstallConfig({ ROVARA_EDITION: edition })).toThrow(/edition/iu);
  });
  it("Enterprise reads the private ranges from ROVARA_PRIVATE_MCP_CIDRS and keeps package-run servers off by default", () => {
    expect(privateMcpInstallConfig({ ROVARA_EDITION: "enterprise", ROVARA_PRIVATE_MCP_CIDRS: "10.1.0.0/16, 192.168.4.0/24", ROVARA_VPC_CIDRS: "10.42.0.0/16" })).toEqual({ edition: "enterprise", privateCidrs: ["10.1.0.0/16", "192.168.4.0/24"], rovaraCidrs: ["10.42.0.0/16"], stdioEnabled: false });
    // unset gives no ranges: every test and call of a private server is then refused (fail closed)
    expect(privateMcpInstallConfig({ ROVARA_EDITION: "enterprise" })).toEqual({ edition: "enterprise", privateCidrs: [], rovaraCidrs: [], stdioEnabled: false });
    // only the exact "1" turns package-run servers on, and then only with a host
    for (const value of ["true", "yes", "0", "", "1 "]) expect(privateMcpInstallConfig({ ROVARA_EDITION: "enterprise", ROVARA_STDIO_MCP_SERVERS: value }).stdioEnabled).toBe(false);
  });
  it("a range outside the private networks stops the install, never widening it", () => {
    for (const cidr of ["8.8.8.0/24", "0.0.0.0/0", "169.254.0.0/16", "not-a-range"]) expect(() => privateMcpInstallConfig({ ROVARA_EDITION: "enterprise", ROVARA_PRIVATE_MCP_CIDRS: cidr })).toThrow(/ROVARA_PRIVATE_MCP_CIDRS/u);
  });
  it("tidy round: private ranges without the install's own network (ROVARA_VPC_CIDRS) stop the install, since the overlap could not be checked", () => {
    for (const vpc of [undefined, "", "  "]) {
      expect(() => privateMcpInstallConfig({ ROVARA_EDITION: "enterprise", ROVARA_PRIVATE_MCP_CIDRS: "10.1.0.0/16", ...(vpc === undefined ? {} : { ROVARA_VPC_CIDRS: vpc }) }), String(vpc)).toThrow(/ROVARA_VPC_CIDRS/u);
    }
    // no private ranges: nothing to check, as before; Public ignores both
    expect(privateMcpInstallConfig({ ROVARA_EDITION: "enterprise" })).toMatchObject({ privateCidrs: [] });
    expect(privateMcpInstallConfig({ ROVARA_EDITION: "public", ROVARA_PRIVATE_MCP_CIDRS: "10.1.0.0/16" })).toMatchObject({ privateCidrs: [] });
  });
  it("fix round: the install's own network (ROVARA_VPC_CIDRS) is read, and a private range that overlaps it stops the install", () => {
    const base = { ROVARA_EDITION: "enterprise", ROVARA_VPC_CIDRS: "10.42.0.0/16" };
    expect(privateMcpInstallConfig({ ...base, ROVARA_PRIVATE_MCP_CIDRS: "10.43.0.0/16" })).toMatchObject({ rovaraCidrs: ["10.42.0.0/16"], privateCidrs: ["10.43.0.0/16"] });
    for (const cidr of ["10.0.0.0/8", "10.42.0.0/16", "10.42.9.0/24"]) expect(() => privateMcpInstallConfig({ ...base, ROVARA_PRIVATE_MCP_CIDRS: cidr }), cidr).toThrow(/overlaps the network Rovara/u);
    expect(() => privateMcpInstallConfig({ ...base, ROVARA_VPC_CIDRS: "nonsense" })).toThrow(/ROVARA_VPC_CIDRS/u);
  });
  it("package-run servers switched on need the host's address and token, and the address must be https", () => {
    const on = { ROVARA_EDITION: "enterprise", ROVARA_STDIO_MCP_SERVERS: "1" };
    expect(() => privateMcpInstallConfig(on)).toThrow(/MCP_HOST_URL/u);
    expect(() => privateMcpInstallConfig({ ...on, MCP_HOST_URL: "https://mcp-host.example.net" })).toThrow(/MCP_HOST_TOKEN/u);
    expect(() => privateMcpInstallConfig({ ...on, MCP_HOST_URL: "http://mcp-host.example.net", MCP_HOST_TOKEN: HOST_TOKEN })).toThrow(/https/u);
    expect(() => privateMcpInstallConfig({ ...on, MCP_HOST_URL: "mcp-host.example.net", MCP_HOST_TOKEN: HOST_TOKEN })).toThrow(/web address/u);
    expect(privateMcpInstallConfig({ ...on, MCP_HOST_URL: "https://mcp-host.example.net", MCP_HOST_TOKEN: HOST_TOKEN })).toEqual({ edition: "enterprise", privateCidrs: [], rovaraCidrs: [], stdioEnabled: true, mcpHost: { url: "https://mcp-host.example.net", token: HOST_TOKEN } });
  });
  it("an http:// host address is refused even while package-run servers are off, so a later switch-on cannot send the token in clear", () => {
    expect(() => privateMcpInstallConfig({ ROVARA_EDITION: "enterprise", MCP_HOST_URL: "http://mcp-host.example.net", MCP_HOST_TOKEN: HOST_TOKEN })).toThrow(/https/u);
    // only this machine's loopback may use http (a test host never leaves it)
    expect(privateMcpInstallConfig({ ROVARA_EDITION: "enterprise", MCP_HOST_URL: "http://127.0.0.1:8080", MCP_HOST_TOKEN: HOST_TOKEN }).mcpHost).toEqual({ url: "http://127.0.0.1:8080", token: HOST_TOKEN });
  });
  it("an Enterprise host address given without its token is not half-used", () => {
    expect(() => privateMcpInstallConfig({ ROVARA_EDITION: "enterprise", MCP_HOST_URL: "https://mcp-host.example.net" })).toThrow(/MCP_HOST_TOKEN/u);
  });
  it("the error names the setting, never the token", () => {
    try { privateMcpInstallConfig({ ROVARA_EDITION: "enterprise", MCP_HOST_URL: "http://mcp-host.example.net", MCP_HOST_TOKEN: HOST_TOKEN }); } catch (error) { expect(String(error)).not.toContain(HOST_TOKEN); }
  });
});

function connections(): OrgConnectionDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls, documentClient: new FakeDynamoDb(), tableName: "state", env: "staging", now: () => NOW,
    secrets: { put: async (_org: string, name: string) => { calls.push(`put ${name}`); return "v1"; }, read: async (_org: string, name: string) => { calls.push(`read ${name}`); return "tok"; }, scheduleDelete: async (_org: string, name: string) => { calls.push(`delete ${name}`); } },
  };
}

describe("the builders get what the install set", () => {
  beforeEach(() => { seen.runtime.length = 0; seen.routes.length = 0; seen.servers.length = 0; });

  it("is inert, not half-built, where the install has no connection secrets role", () => {
    expect(installContextSources({ env: { ROVARA_EDITION: "enterprise" }, orgConnections: undefined, documentClient: new FakeDynamoDb(), tableName: "state", registerCleanup: false })).toBeUndefined();
  });
  it("passes the parsed private ranges, the switch and the host to the stage runtime, the Sources settings and the MCP servers", () => {
    const install = installContextSources({
      env: { ROVARA_EDITION: "enterprise", ROVARA_PRIVATE_MCP_CIDRS: "10.1.0.0/16", ROVARA_VPC_CIDRS: "10.42.0.0/16", ROVARA_STDIO_MCP_SERVERS: "1", MCP_HOST_URL: "https://mcp-host.example.net", MCP_HOST_TOKEN: HOST_TOKEN },
      orgConnections: connections(), documentClient: new FakeDynamoDb(), tableName: "state", registerCleanup: false,
    })!;
    install.routes({ requireProjectRole: async () => undefined });
    for (const call of [seen.runtime[0]!, seen.routes[0]!, seen.servers[0]!]) {
      expect(call.edition).toBe("enterprise");
      expect(call.privateCidrs).toEqual(["10.1.0.0/16"]);
      expect(call.rovaraCidrs).toEqual(["10.42.0.0/16"]);
      expect(call.stdioEnabled).toBe(true);
      expect(call.mcpHost).toEqual({ url: "https://mcp-host.example.net", token: HOST_TOKEN });
    }
  });
  it("leaves package-run servers off and passes no host by default", () => {
    installContextSources({ env: { ROVARA_EDITION: "enterprise", ROVARA_PRIVATE_MCP_CIDRS: "10.1.0.0/16", ROVARA_VPC_CIDRS: "10.42.0.0/16" }, orgConnections: connections(), documentClient: new FakeDynamoDb(), tableName: "state", registerCleanup: false })!
      .routes({ requireProjectRole: async () => undefined });
    for (const call of [seen.runtime[0]!, seen.routes[0]!, seen.servers[0]!]) {
      expect(call.stdioEnabled).toBe(false);
      expect(call.mcpHost).toBeUndefined();
    }
  });
  it("fix round: gives the Sources settings one limiter on tool listings for the whole install, so a new request does not reset it", () => {
    const install = installContextSources({ env: { ROVARA_EDITION: "enterprise" }, orgConnections: connections(), documentClient: new FakeDynamoDb(), tableName: "state", registerCleanup: false })!;
    const first = install.routes({ requireProjectRole: async () => undefined }).contextSources.discoverAllowed!;
    const second = install.routes({ requireProjectRole: async () => undefined }).contextSources.discoverAllowed!;
    expect(first).toBe(second);
    const results = Array.from({ length: 31 }, () => first(ORG));
    expect(results.filter(Boolean)).toHaveLength(30);
    expect(first(ORG)).toBe(false);
  });
  it("gives the MCP servers flow only to Enterprise", () => {
    const options = { orgConnections: connections(), documentClient: new FakeDynamoDb(), tableName: "state", registerCleanup: false };
    expect(installContextSources({ env: { ROVARA_EDITION: "enterprise" }, ...options })!.routes({ requireProjectRole: async () => undefined }).mcpServers).toBeDefined();
    const publicRoutes = installContextSources({ env: { ROVARA_EDITION: "public" }, ...options })!.routes({ requireProjectRole: async () => undefined });
    expect(publicRoutes.mcpServers).toBeUndefined();
    expect(publicRoutes.contextSources).toBeDefined();
  });
  it("keeps each registered server's token in the org's secret store under the connector path, tagged by the install's environment", async () => {
    const deps = connections();
    installContextSources({ env: { ROVARA_EDITION: "enterprise" }, orgConnections: deps, documentClient: new FakeDynamoDb(), tableName: "state", registerCleanup: false })!.routes({ requireProjectRole: async () => undefined });
    const secrets = seen.servers[0]!.serverSecrets as { put(org: string, id: string, value: string): Promise<string>; read(org: string, id: string): Promise<string | undefined>; remove(org: string, id: string): Promise<void> };
    await secrets.put(ORG, "mcpabc123456", "t");
    await secrets.read(ORG, "mcpabc123456");
    await secrets.remove(ORG, "mcpabc123456");
    const path = `agentx/staging/org-connectors/${ORG}/mcpabc123456`;
    expect(deps.calls).toEqual([`put ${path}`, `read ${path}`, `delete ${path}`]);
    // the stage runtime and the Sources settings read the same store
    expect(seen.runtime[0]!.serverSecrets).toBeDefined();
    expect(seen.routes[0]!.serverSecrets).toBe(seen.servers[0]!.serverSecrets);
  });
  it("shares one install per set of connection dependencies, so the test limiter is not reset by every request", () => {
    const deps = connections();
    const options = { env: { ROVARA_EDITION: "enterprise" }, orgConnections: deps, documentClient: new FakeDynamoDb(), tableName: "state", registerCleanup: false };
    const first = sharedContextSourcesInstall(options);
    expect(sharedContextSourcesInstall(options)).toBe(first);
    expect(sharedContextSourcesInstall({ ...options, orgConnections: connections() })).not.toBe(first);
    const mcp = first!.routes({ requireProjectRole: async () => undefined }).mcpServers;
    expect(first!.routes({ requireProjectRole: async () => undefined }).mcpServers).toBe(mcp);
  });
  it("a range outside the private networks builds nothing", () => {
    const options = { env: { ROVARA_EDITION: "enterprise", ROVARA_PRIVATE_MCP_CIDRS: "8.8.8.0/24" }, orgConnections: connections(), documentClient: new FakeDynamoDb(), tableName: "state", registerCleanup: false };
    expect(() => sharedContextSourcesInstall(options)).toThrow(/ROVARA_PRIVATE_MCP_CIDRS/u);
    expect(seen.runtime).toHaveLength(0);
  });
  it("registers the live-only cleanup when asked, and hands back the way to stop it", () => {
    const install = installContextSources({ env: { ROVARA_EDITION: "enterprise" }, orgConnections: connections(), documentClient: new FakeDynamoDb(), tableName: "state" })!;
    expect(typeof install.stopCleanup).toBe("function");
    install.stopCleanup!();
  });
});
