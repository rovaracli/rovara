import { describe, expect, it } from "vitest";
import { MCP_PROBE_FAILURES } from "@agentx/contracts";
import { McpProbeError, allowedTargets, approveMcpServer, disableMcpServer, dynamoMcpServerStore, listMcpServers, proposeMcpServer, removeMcpServer, type McpProber, type McpServerDependencies } from "../../../packages/broker/src/context-sources/mcp-servers.js";
import { routeMcpServers } from "../../../packages/broker/src/context-sources/mcp-server-routes.js";
import { StatusReply } from "../../../packages/broker/src/aws/status-reply.js";
import type { AgentCaller } from "../../../packages/broker/src/agents/access.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import type { DiscoveredTool } from "../../../packages/broker/src/context-sources/settings.js";
import { GET_TOOL, NOW, ORG, SEARCH_TOOL } from "./fixtures.js";

const admin = (developerId = "dev1", orgRole = "admin") => ({ orgId: ORG, developerId, orgRole });
const ADDRESS = "https://sim.corp.example/mcp";
const HTTP = { kind: "http" as const, address: ADDRESS };
const STDIO = { kind: "stdio" as const, spec: { registry: "npm" as const, name: "@acme/sim-mcp", version: "1.4.2", args: ["--read-only"] } };

function world(over: { edition?: "enterprise" | "public"; tools?: DiscoveredTool[]; fails?: McpProbeError | Error; secondAdmin?: boolean } = {}) {
  const table = new FakeDynamoDb();
  const state = { tools: over.tools ?? [SEARCH_TOOL, GET_TOOL], integrity: `sha512-${"A".repeat(86)}==`, fails: over.fails, tokens: [] as Array<string | undefined>, httpProbes: 0 };
  let counter = 0;
  const prober: McpProber = {
    http: async (_address, token) => { state.httpProbes += 1; state.tokens.push(token); if (state.fails) throw state.fails; return state.tools; },
    stdio: async () => { if (state.fails) throw state.fails; return { tools: state.tools, integrity: state.integrity }; },
  };
  const audit: string[] = [];
  const deps: McpServerDependencies = {
    store: dynamoMcpServerStore({ documentClient: table, tableName: "state" }), prober, edition: over.edition ?? "enterprise", now: () => NOW,
    authToken: async () => "tok-123", authConnectionUsable: async (_org, id) => id === "con_aaaaaaaaaaaaaaaaaaaa",
    newId: () => `${String(++counter).padStart(8, "0")}abcd`, audit: async (event) => { audit.push(`${event.action}:${event.serverId}`); },
    ...(over.secondAdmin === undefined ? {} : { secondAdminToApprove: over.secondAdmin }),
  };
  return { deps, state, audit };
}

describe("adding a server is easy: paste, test, see, approve", () => {
  it("tests the address, shows what it offers, and allows nothing until it is approved", async () => {
    const { deps } = world();
    const entry = await proposeMcpServer(deps, admin(), { label: "SIM", transport: HTTP });
    expect(entry.status).toBe("awaiting_approval");
    expect(entry.probe.tools.map((tool) => [tool.name, tool.annotation])).toEqual([["get_ticket", "read_only"], ["search_tickets", "read_only"]]);
    expect(await allowedTargets(deps.store, ORG, ["10.0.0.0/8"])).toEqual([]);
    const approved = await approveMcpServer(deps, admin(), entry.serverId);
    expect(approved.status).toBe("approved");
    expect(await allowedTargets(deps.store, ORG, ["10.0.0.0/8"])).toEqual([{ host: "sim.corp.example", port: 443, cidrs: ["10.0.0.0/8"] }]);
  });
  it("updates the allow-list by itself on approval and by itself on disabling, with no other step", async () => {
    const { deps, audit } = world();
    const entry = await proposeMcpServer(deps, admin(), { label: "SIM", transport: HTTP });
    await approveMcpServer(deps, admin("dev2", "owner"), entry.serverId);
    await disableMcpServer(deps, admin(), entry.serverId);
    expect(await allowedTargets(deps.store, ORG, ["10.0.0.0/8"])).toEqual([]);
    expect(audit).toEqual([`mcp_server.added:${entry.serverId}`, `mcp_server.approved:${entry.serverId}`, `mcp_server.disabled:${entry.serverId}`]);
  });
  it("allows a stdio server to be added without putting anything in the allow-list (the host serves it)", async () => {
    const { deps } = world();
    const entry = await proposeMcpServer(deps, admin(), { label: "Wiki", transport: STDIO });
    await approveMcpServer(deps, admin(), entry.serverId);
    expect(await allowedTargets(deps.store, ORG, ["10.0.0.0/8"])).toEqual([]);
    expect((await listMcpServers(deps, admin())).map((item) => [item.transport.kind, item.status])).toEqual([["stdio", "approved"]]);
  });
  it("is for an owner or admin, and for Enterprise only", async () => {
    await expect(proposeMcpServer(world().deps, admin("dev1", "member"), { label: "SIM", transport: HTTP })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const publicWorld = world({ edition: "public" });
    await expect(proposeMcpServer(publicWorld.deps, admin(), { label: "SIM", transport: HTTP })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(publicWorld.state.httpProbes).toBe(0);
    await expect(listMcpServers(publicWorld.deps, admin())).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("shows a failed test as a fixed sentence and stores nothing", async () => {
    for (const code of Object.keys(MCP_PROBE_FAILURES) as Array<keyof typeof MCP_PROBE_FAILURES>) {
      const { deps } = world({ fails: new McpProbeError(code) });
      await expect(proposeMcpServer(deps, admin(), { label: "SIM", transport: HTTP })).rejects.toThrow(MCP_PROBE_FAILURES[code]);
      expect(await deps.store.list(ORG)).toEqual([]);
    }
    const leaking = world({ fails: new Error("connect ECONNREFUSED 10.9.8.7:443 banner: secret") });
    await expect(proposeMcpServer(leaking.deps, admin(), { label: "SIM", transport: HTTP })).rejects.toSatisfy((error: Error) => !/10\.9\.8\.7|banner/u.test(error.message));
  });
  it("refuses an address that is not https, has a login, or names an IP address, before it tests anything", async () => {
    const { deps, state } = world();
    for (const address of ["http://sim.corp.example/mcp", "https://u:p@sim.corp.example/mcp", "https://10.0.0.5/mcp", "sim.corp.example"]) {
      await expect(proposeMcpServer(deps, admin(), { label: "SIM", transport: { kind: "http", address } })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
    expect(state.httpProbes).toBe(0);
  });
  it("refuses a stdio spec with a range, a tag, a path or a shell word", async () => {
    const { deps } = world();
    const spec = (over: Record<string, unknown>) => ({ kind: "stdio", spec: { ...STDIO.spec, ...over } });
    for (const bad of [spec({ version: "^1.4.2" }), spec({ version: "latest" }), spec({ name: "../evil" }), spec({ name: "pkg; rm -rf /" }), spec({ args: ["a b"] }), spec({ args: ["$(id)"] }), spec({ args: ["../../etc"] }), spec({ registry: "git" })]) {
      await expect(proposeMcpServer(deps, admin(), { label: "x", transport: bad })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
  });
  it("sends the auth connection's token to an http test, only a usable one, and never to a stdio server", async () => {
    const { deps, state } = world();
    await proposeMcpServer(deps, admin(), { label: "SIM", transport: HTTP, authConnectionId: "con_aaaaaaaaaaaaaaaaaaaa" });
    expect(state.tokens).toEqual(["tok-123"]);
    await expect(proposeMcpServer(deps, admin(), { label: "SIM2", transport: { kind: "http", address: "https://other.corp.example/mcp" }, authConnectionId: "con_bbbbbbbbbbbbbbbbbbbb" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(proposeMcpServer(deps, admin(), { label: "Wiki", transport: STDIO, authConnectionId: "con_aaaaaaaaaaaaaaaaaaaa" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
  it("does not add the same host and port twice", async () => {
    const { deps } = world();
    await proposeMcpServer(deps, admin(), { label: "SIM", transport: HTTP });
    await expect(proposeMcpServer(deps, admin(), { label: "SIM again", transport: { kind: "http", address: "https://SIM.corp.example/other" } })).rejects.toThrow(/already added/u);
  });
});

describe("the approval is bound to what was shown", () => {
  it("refuses, and allows nothing, when the server's tools moved since they were shown", async () => {
    const { deps, state } = world();
    const entry = await proposeMcpServer(deps, admin(), { label: "SIM", transport: HTTP });
    state.tools = [SEARCH_TOOL, GET_TOOL, { name: "delete_ticket", inputSchema: { type: "object" } }];
    await expect(approveMcpServer(deps, admin(), entry.serverId)).rejects.toMatchObject({ code: "CHANGE_STALE" });
    expect(await allowedTargets(deps.store, ORG, ["10.0.0.0/8"])).toEqual([]);
    expect((await deps.store.get(ORG, entry.serverId))!.status).toBe("awaiting_approval");
  });
  it("lands only once: a second approval, an approval of an unknown id, and one of a disabled entry are refused", async () => {
    const { deps } = world();
    const entry = await proposeMcpServer(deps, admin(), { label: "SIM", transport: HTTP });
    await approveMcpServer(deps, admin(), entry.serverId);
    await expect(approveMcpServer(deps, admin(), entry.serverId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(approveMcpServer(deps, admin(), "mcpdoesnotexist1")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await disableMcpServer(deps, admin(), entry.serverId);
    await expect(approveMcpServer(deps, admin(), entry.serverId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("can require a second admin to approve (off by default, because adding one must be easy)", async () => {
    const { deps } = world({ secondAdmin: true });
    const entry = await proposeMcpServer(deps, admin("dev1"), { label: "SIM", transport: HTTP });
    await expect(approveMcpServer(deps, admin("dev1"), entry.serverId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await approveMcpServer(deps, admin("dev2"), entry.serverId)).status).toBe("approved");
  });
  it("removes only an entry that is not approved", async () => {
    const { deps } = world();
    const entry = await proposeMcpServer(deps, admin(), { label: "SIM", transport: HTTP });
    await approveMcpServer(deps, admin(), entry.serverId);
    await expect(removeMcpServer(deps, admin(), entry.serverId)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await disableMcpServer(deps, admin(), entry.serverId);
    await removeMcpServer(deps, admin(), entry.serverId);
    expect(await deps.store.list(ORG)).toEqual([]);
  });
  it("does not serve a stored entry that no longer parses: it can never make a host allowed", async () => {
    const { deps } = world();
    const entry = await proposeMcpServer(deps, admin(), { label: "SIM", transport: HTTP });
    await approveMcpServer(deps, admin(), entry.serverId);
    const table = new FakeDynamoDb();
    const store = dynamoMcpServerStore({ documentClient: table, tableName: "state" });
    await store.create(ORG, { ...(entry), status: "approved" });
    // damage the stored address
    const raw = (table as unknown as { items: Map<string, Record<string, unknown>> }).items;
    for (const item of raw.values()) item.transport = { kind: "http", address: "http://not-https/" };
    expect(await allowedTargets(store, ORG, ["10.0.0.0/8"])).toEqual([]);
  });
  it("keeps one org's servers from another's", async () => {
    const { deps } = world();
    await proposeMcpServer(deps, admin(), { label: "SIM", transport: HTTP });
    expect(await deps.store.list("org_bbbbbbbbbbbbbbbbbbbb")).toEqual([]);
  });
});

describe("the routes", () => {
  const caller = (orgRole = "admin", developerId = "dev1"): AgentCaller => ({ orgId: ORG, developerId, orgRole } as AgentCaller);
  const send = (deps: McpServerDependencies, method: string, path: string, body?: unknown, who = caller()) =>
    routeMcpServers(deps, who, { method, path, headers: {}, requestId: "r", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, new URL(`https://x${path}`));
  it("walks the whole flow: paste (202, nothing allowed), list, approve, disable, remove", async () => {
    const { deps } = world();
    const added = await send(deps, "POST", "/v1/app/org/mcp-servers", { label: "SIM", transport: HTTP });
    expect(added).toBeInstanceOf(StatusReply);
    expect((added as StatusReply).statusCode).toBe(202);
    const serverId = ((added as StatusReply).body as { server: { serverId: string } }).server.serverId;
    expect(await allowedTargets(deps.store, ORG, ["10.0.0.0/8"])).toEqual([]);
    await send(deps, "POST", `/v1/app/org/mcp-servers/${serverId}/approve`);
    expect(await allowedTargets(deps.store, ORG, ["10.0.0.0/8"])).toHaveLength(1);
    expect(((await send(deps, "GET", "/v1/app/org/mcp-servers")) as { servers: unknown[] }).servers).toHaveLength(1);
    await send(deps, "POST", `/v1/app/org/mcp-servers/${serverId}/disable`);
    await send(deps, "DELETE", `/v1/app/org/mcp-servers/${serverId}`);
    expect(await deps.store.list(ORG)).toEqual([]);
  });
  it("turns a member away and never repeats a field it does not know", async () => {
    const { deps } = world();
    await expect(send(deps, "GET", "/v1/app/org/mcp-servers", undefined, caller("member"))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(send(deps, "POST", "/v1/app/org/mcp-servers", { label: "SIM", transport: HTTP, token: "sk-live-xyz" })).rejects.toSatisfy((error: Error) => !error.message.includes("sk-live-xyz"));
  });
});

describe("review I2: no install ranges, no allow-list", () => {
  it("gives no target for an approved entry when the operator has set no ranges", async () => {
    const { deps } = world();
    const entry = await proposeMcpServer(deps, admin(), { label: "SIM", transport: HTTP });
    await approveMcpServer(deps, admin(), entry.serverId);
    expect(await allowedTargets(deps.store, ORG, [])).toEqual([]);
  });
});

describe("review I1: an auth connection belongs to its own server", () => {
  it("fits only a read-only MCP connection whose own address is on the same host and port as the server", async () => {
    const { authConnectionFits } = await import("../../../packages/broker/src/context-sources/mcp-servers.js");
    const mcp = (over: Record<string, unknown> = {}) => ({ type: "mcp", access: "read" as const, endpoint: "https://sim.corp.example/mcp", ...over });
    expect(authConnectionFits(mcp(), "https://sim.corp.example/other")).toBe(true);
    expect(authConnectionFits(mcp({ access: "read_write" }), ADDRESS)).toBe(false);
    expect(authConnectionFits(mcp({ type: "linear" }), ADDRESS)).toBe(false);
    expect(authConnectionFits(mcp({ endpoint: "https://api.linear.app/mcp" }), "https://collector.attacker.example/mcp")).toBe(false);
    expect(authConnectionFits(mcp({ endpoint: "https://sim.corp.example:8443/mcp" }), ADDRESS)).toBe(false);
    expect(authConnectionFits(mcp({ endpoint: undefined }), ADDRESS)).toBe(false);
    expect(authConnectionFits(undefined, ADDRESS)).toBe(false);
  });
  it("is asked at propose time with the address, and a connection that does not fit is refused before any test is sent", async () => {
    const { deps, state } = world();
    const asked: string[] = [];
    deps.authConnectionUsable = async (_org, _id, address) => { asked.push(address); return false; };
    await expect(proposeMcpServer(deps, admin(), { label: "Anything", transport: { kind: "http", address: "https://collector.attacker.example/mcp" }, authConnectionId: "con_aaaaaaaaaaaaaaaaaaaa" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(asked).toEqual(["https://collector.attacker.example/mcp"]);
    expect(state.httpProbes).toBe(0);
    expect(state.tokens).toEqual([]);
  });
});

describe("review I2: tests of an address are rate limited", () => {
  it("refuses a test over the limit before sending it", async () => {
    const { deps, state } = world();
    let allowed = 2;
    deps.probeAllowed = () => allowed-- > 0;
    await proposeMcpServer(deps, admin(), { label: "A", transport: { kind: "http", address: "https://a.corp.example/mcp" } });
    await proposeMcpServer(deps, admin(), { label: "B", transport: { kind: "http", address: "https://b.corp.example/mcp" } });
    await expect(proposeMcpServer(deps, admin(), { label: "C", transport: { kind: "http", address: "https://c.corp.example/mcp" } })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(state.httpProbes).toBe(2);
  });
  it("the default limiter allows ten tests in ten minutes for one org and counts orgs apart", async () => {
    const { probeLimiter } = await import("../../../packages/broker/src/context-sources/mcp-servers.js");
    let clock = 0;
    const limit = probeLimiter({ max: 10, windowMs: 600_000, now: () => clock });
    for (let i = 0; i < 10; i += 1) expect(limit(ORG)).toBe(true);
    expect(limit(ORG)).toBe(false);
    expect(limit("org_bbbbbbbbbbbbbbbbbbbb")).toBe(true);
    clock = 600_001;
    expect(limit(ORG)).toBe(true);
  });
});

describe("review I3: a stdio package is pinned by its tarball's integrity", () => {
  it("stores the integrity the host computed, shows it, and refuses an approval when the tarball is no longer that one", async () => {
    const { deps, state } = world();
    const entry = await proposeMcpServer(deps, admin(), { label: "Wiki", transport: STDIO });
    expect(entry.transport).toMatchObject({ kind: "stdio", spec: { integrity: state.integrity } });
    state.integrity = `sha512-${"B".repeat(86)}==`;
    await expect(approveMcpServer(deps, admin(), entry.serverId)).rejects.toMatchObject({ code: "CHANGE_STALE" });
    expect((await deps.store.get(ORG, entry.serverId))!.status).toBe("awaiting_approval");
    state.integrity = (entry.transport as { spec: { integrity: string } }).spec.integrity;
    expect((await approveMcpServer(deps, admin(), entry.serverId)).status).toBe("approved");
  });
  it("accepts an integrity the admin typed, and the stored entry always has one", async () => {
    const { McpServerEntrySchema, McpStdioSpecSchema, McpStdioProposalSchema } = await import("@agentx/contracts");
    const { deps, state } = world();
    const typed = { ...STDIO, spec: { ...STDIO.spec, integrity: state.integrity } };
    expect((await proposeMcpServer(deps, admin(), { label: "Wiki", transport: typed })).transport).toEqual(typed);
    expect(McpStdioProposalSchema.safeParse(STDIO.spec).success).toBe(true);
    expect(McpStdioSpecSchema.safeParse(STDIO.spec).success).toBe(false);
    expect(McpServerEntrySchema.safeParse({ serverId: "mcpabc123456", label: "x", status: "approved", transport: STDIO, probe: { at: "t", toolsHash: "a".repeat(64), tools: [] }, requestedBy: "d", requestedAt: "t" }).success).toBe(false);
  });
});
