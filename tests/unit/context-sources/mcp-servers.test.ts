import { describe, expect, it } from "vitest";
import { MCP_PROBE_FAILURES, orgScoped } from "@agentx/contracts";
import { type McpServerSecrets, McpProbeError, STDIO_OFF_MESSAGE, stdioAvailable, allowedTargets, approveMcpServer, disableMcpServer, clearOrgMcpServers, dynamoMcpServerStore, listMcpServers, probeLimiter, proposeMcpServer, removeMcpServer, summariseProbe, type McpProber, type McpServerDependencies } from "../../../packages/broker/src/context-sources/mcp-servers.js";
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

function world(over: { edition?: "enterprise" | "public"; tools?: DiscoveredTool[]; fails?: McpProbeError | Error; secondAdmin?: boolean; stdio?: boolean } = {}) {
  const table = new FakeDynamoDb();
  const state = { tools: over.tools ?? [SEARCH_TOOL, GET_TOOL], integrity: `sha512-${"A".repeat(86)}==`, fails: over.fails, tokens: [] as Array<string | undefined>, httpProbes: 0 };
  let counter = 0;
  const prober: McpProber = {
    http: async (_address, token) => { state.httpProbes += 1; state.tokens.push(token); if (state.fails) throw state.fails; return state.tools; },
    stdio: async () => { if (state.fails) throw state.fails; return { tools: state.tools, integrity: state.integrity }; },
  };
  const audit: string[] = [];
  const vault = new Map<string, string>();
  const secretLog: string[] = [];
  const secrets: McpServerSecrets = {
    put: async (_org, id, value) => { vault.set(id, value); secretLog.push(`put:${id}`); return `v-${vault.size}`; },
    read: async (_org, id) => vault.get(id),
    remove: async (_org, id) => { vault.delete(id); secretLog.push(`remove:${id}`); },
  };
  const deps: McpServerDependencies = {
    store: dynamoMcpServerStore({ documentClient: table, tableName: "state" }), prober, edition: over.edition ?? "enterprise", now: () => NOW,
    secrets, stdioEnabled: over.stdio !== false,
    newId: () => `${String(++counter).padStart(8, "0")}abcd`, audit: async (event) => { audit.push(`${event.action}:${event.serverId}`); },
    ...(over.secondAdmin === undefined ? {} : { secondAdminToApprove: over.secondAdmin }),
  };
  return { deps, state, audit, vault, secretLog };
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
  it("sends the server's own token to its test, stores it write-only, and never returns it", async () => {
    const { deps, state, vault, secretLog } = world();
    const entry = await proposeMcpServer(deps, admin(), { label: "SIM", transport: HTTP, secret: "tok-123" });
    expect(state.tokens).toEqual(["tok-123"]);
    expect(vault.get(entry.serverId)).toBe("tok-123");
    expect(entry).toMatchObject({ hasSecret: true });
    expect(JSON.stringify(entry)).not.toContain("tok-123");
    expect(JSON.stringify(await deps.store.get(ORG, entry.serverId))).not.toContain("tok-123");
    expect(JSON.stringify(await listMcpServers(deps, admin()))).not.toContain("tok-123");
    expect(secretLog).toEqual([`put:${entry.serverId}`]);
  });
  it("keeps no token for a test that failed, and takes none for a package-run server", async () => {
    const failing = world({ fails: new McpProbeError("unreachable") });
    await expect(proposeMcpServer(failing.deps, admin(), { label: "SIM", transport: HTTP, secret: "tok-123" })).rejects.toBeDefined();
    expect(failing.vault.size).toBe(0);
    const { deps } = world();
    await expect(proposeMcpServer(deps, admin(), { label: "Wiki", transport: STDIO, secret: "tok" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
  it("tests again with the stored token when approving, and refuses an entry whose token can no longer be read (review m3)", async () => {
    const { deps, state, vault } = world();
    const entry = await proposeMcpServer(deps, admin(), { label: "SIM", transport: HTTP, secret: "tok-123" });
    await approveMcpServer(deps, admin(), entry.serverId);
    expect(state.tokens).toEqual(["tok-123", "tok-123"]);
    const second = await proposeMcpServer(deps, admin(), { label: "B", transport: { kind: "http", address: "https://b.corp.example/mcp" }, secret: "tok-b" });
    vault.delete(second.serverId);
    await expect(approveMcpServer(deps, admin(), second.serverId)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect((await deps.store.get(ORG, second.serverId))!.status).toBe("awaiting_approval");
  });
  it("gives a token to each server alone, and deletes it with the server", async () => {
    const { deps, vault } = world();
    const a = await proposeMcpServer(deps, admin(), { label: "A", transport: HTTP, secret: "tok-a" });
    const b = await proposeMcpServer(deps, admin(), { label: "B", transport: { kind: "http", address: "https://b.corp.example/mcp" }, secret: "tok-b" });
    expect([vault.get(a.serverId), vault.get(b.serverId)]).toEqual(["tok-a", "tok-b"]);
    await removeMcpServer(deps, admin(), a.serverId);
    expect(vault.has(a.serverId)).toBe(false);
    expect(vault.get(b.serverId)).toBe("tok-b");
  });
  it("ME-16: disabling a server deletes its token as well as taking it off the allow-list (approved, and one that was still waiting)", async () => {
    const { deps, vault, secretLog } = world();
    const approved = await proposeMcpServer(deps, admin(), { label: "A", transport: HTTP, secret: "tok-a" });
    await approveMcpServer(deps, admin(), approved.serverId);
    const waiting = await proposeMcpServer(deps, admin(), { label: "B", transport: { kind: "http", address: "https://b.corp.example/mcp" }, secret: "tok-b" });
    const other = await proposeMcpServer(deps, admin(), { label: "C", transport: { kind: "http", address: "https://c.corp.example/mcp" }, secret: "tok-c" });
    await disableMcpServer(deps, admin(), approved.serverId);
    await disableMcpServer(deps, admin(), waiting.serverId);
    expect(vault.has(approved.serverId)).toBe(false);
    expect(vault.has(waiting.serverId)).toBe(false);
    expect(vault.get(other.serverId)).toBe("tok-c");
    expect(secretLog.filter((line) => line.startsWith("remove:"))).toEqual([`remove:${approved.serverId}`, `remove:${waiting.serverId}`]);
    expect(await allowedTargets(deps.store, ORG, ["10.0.0.0/8"])).toEqual([]);
  });
  it("ME-16: a server with no token deletes nothing when it is disabled", async () => {
    const { deps, secretLog } = world();
    const entry = await proposeMcpServer(deps, admin(), { label: "A", transport: HTTP });
    await disableMcpServer(deps, admin(), entry.serverId);
    expect(secretLog.filter((line) => line.startsWith("remove:"))).toEqual([]);
  });
  it("ME-16: when the token cannot be deleted the server is still off, the admin is told, and removing the server tries again", async () => {
    const { deps, vault } = world();
    const entry = await proposeMcpServer(deps, admin(), { label: "A", transport: HTTP, secret: "tok-a" });
    await approveMcpServer(deps, admin(), entry.serverId);
    const secrets = deps.secrets, remove = secrets.remove.bind(secrets);
    secrets.remove = async () => { throw new Error("secrets are down"); };
    await expect(disableMcpServer(deps, admin(), entry.serverId)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect((await deps.store.get(ORG, entry.serverId))!.status).toBe("disabled");
    expect(await allowedTargets(deps.store, ORG, ["10.0.0.0/8"])).toEqual([]);
    expect(vault.has(entry.serverId)).toBe(true);
    secrets.remove = remove;
    await removeMcpServer(deps, admin(), entry.serverId);
    expect(vault.has(entry.serverId)).toBe(false);
  });
  it("fix round: when the retry in remove also cannot delete the token, the entry stays (nothing is orphaned) and the error is shown; a later retry finishes", async () => {
    const { deps, vault } = world();
    const entry = await proposeMcpServer(deps, admin(), { label: "A", transport: HTTP, secret: "tok-a" });
    await approveMcpServer(deps, admin(), entry.serverId);
    const secrets = deps.secrets, remove = secrets.remove.bind(secrets);
    secrets.remove = async () => { throw new Error("secrets are down"); };
    await expect(disableMcpServer(deps, admin(), entry.serverId)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    await expect(removeMcpServer(deps, admin(), entry.serverId)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect((await deps.store.get(ORG, entry.serverId))?.status).toBe("disabled");
    expect(vault.has(entry.serverId)).toBe(true);
    secrets.remove = remove;
    await removeMcpServer(deps, admin(), entry.serverId);
    expect(await deps.store.get(ORG, entry.serverId)).toBeUndefined();
    expect(vault.has(entry.serverId)).toBe(false);
  });
  it("ME-16: closing an org removes every server and token of that org and no other org's, and can be run again", async () => {
    const { deps, vault } = world();
    const a = await proposeMcpServer(deps, admin(), { label: "A", transport: HTTP, secret: "tok-a" });
    await approveMcpServer(deps, admin(), a.serverId);
    const b = await proposeMcpServer(deps, admin(), { label: "B", transport: { kind: "http", address: "https://b.corp.example/mcp" }, secret: "tok-b" });
    const c = await proposeMcpServer(deps, admin(), { label: "C", transport: { kind: "http", address: "https://c.corp.example/mcp" } });
    const OTHER = "org_bbbbbbbbbbbbbbbbbbbb" as typeof ORG;
    const theirs = await proposeMcpServer(deps, { ...admin(), orgId: OTHER }, { label: "T", transport: { kind: "http", address: "https://t.corp.example/mcp" }, secret: "tok-t" });
    await clearOrgMcpServers(deps, ORG);
    expect(await deps.store.list(ORG)).toEqual([]);
    for (const id of [a.serverId, b.serverId, c.serverId]) expect(vault.has(id), id).toBe(false);
    expect(vault.get(theirs.serverId)).toBe("tok-t");
    expect((await deps.store.list(OTHER)).map((entry) => entry.serverId)).toEqual([theirs.serverId]);
    await expect(clearOrgMcpServers(deps, ORG)).resolves.toBeUndefined();
  });
  it("ME-16: closing an org stops, keeping the entry, when a token cannot be deleted, so the close can be run again", async () => {
    const { deps, vault } = world();
    const a = await proposeMcpServer(deps, admin(), { label: "A", transport: HTTP, secret: "tok-a" });
    const secrets = deps.secrets, remove = secrets.remove.bind(secrets);
    secrets.remove = async () => { throw new Error("secrets are down"); };
    await expect(clearOrgMcpServers(deps, ORG)).rejects.toThrow("secrets are down");
    expect((await deps.store.list(ORG)).map((entry) => entry.serverId)).toEqual([a.serverId]);
    secrets.remove = remove;
    await clearOrgMcpServers(deps, ORG);
    expect(vault.has(a.serverId)).toBe(false);
    expect(await deps.store.list(ORG)).toEqual([]);
  });
  it("fix round: closing an org clears every page of servers (more than the 200 one read returns) and every token", async () => {
    const world1 = world();
    const { deps, vault } = world1;
    const ids = Array.from({ length: 450 }, (_, index) => `mcp${String(index).padStart(6, "0")}`);
    for (const serverId of ids) {
      await deps.store.create(ORG, { serverId, label: "S", status: "disabled", transport: { kind: "http", address: `https://${serverId}.corp.example/mcp` }, probe: summariseProbe([], NOW), requestedBy: "dev1", requestedAt: "2026-11-01T10:00:00Z", hasSecret: true, secretVersion: "v1" });
      vault.set(serverId, "tok");
    }
    expect((await deps.store.list(ORG)).length).toBe(200);
    await clearOrgMcpServers(deps, ORG);
    expect(await deps.store.listAll(ORG)).toEqual({ entries: [], unreadable: 0 });
    expect(vault.size).toBe(0);
  });
  it("fix round: closing an org stops, with nothing silently left behind, when a server entry cannot be read", async () => {
    const table = new FakeDynamoDb();
    const { deps } = world();
    const store = dynamoMcpServerStore({ documentClient: table, tableName: "state" });
    const good = { serverId: "mcpgood00001", label: "S", status: "disabled" as const, transport: { kind: "http" as const, address: "https://g.corp.example/mcp" }, probe: summariseProbe([], NOW), requestedBy: "dev1", requestedAt: "2026-11-01T10:00:00Z" };
    await store.create(ORG, good);
    table.set({ pk: orgScoped(ORG, "MCPSRV"), sk: "SRV#mcpbad000001", serverId: "mcpbad000001", status: "nonsense" });
    await expect(clearOrgMcpServers({ ...deps, store }, ORG)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    // the entry that can be read is not touched either: the close stops as a whole and can be run again once the item is dealt with
    expect((await store.listAll(ORG)).unreadable).toBe(1);
    expect((await store.listAll(ORG)).entries.map((entry) => entry.serverId)).toEqual(["mcpgood00001"]);
  });
  it("tidy round: the limiter forgets orgs that have been idle for a whole window, so its map does not grow without bound", () => {
    let now = NOW;
    const limiter = probeLimiter({ max: 2, windowMs: 600_000, now: () => now });
    for (let index = 0; index < 1000; index += 1) expect(limiter(`org_${String(index).padStart(20, "0")}`)).toBe(true);
    expect(limiter.size()).toBe(1000);
    now += 600_001;
    expect(limiter(ORG)).toBe(true);
    expect(limiter.size()).toBe(1);
    // the limit itself still holds
    expect(limiter(ORG)).toBe(true);
    expect(limiter(ORG)).toBe(false);
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

describe("package-run servers are off unless the install switches them on", () => {
  it("refuses to add one with a clear sentence, and never calls the host", async () => {
    const { deps } = world({ stdio: false });
    let hostCalls = 0;
    deps.prober = { ...deps.prober, stdio: async () => { hostCalls += 1; return { tools: [], integrity: "x" }; } };
    await expect(proposeMcpServer(deps, admin(), { label: "Wiki", transport: STDIO })).rejects.toThrow(STDIO_OFF_MESSAGE);
    expect(hostCalls).toBe(0);
    expect(await deps.store.list(ORG)).toEqual([]);
  });
  it("refuses to approve one that was added while it was on, and says so", async () => {
    const { deps } = world();
    const entry = await proposeMcpServer(deps, admin(), { label: "Wiki", transport: STDIO });
    deps.stdioEnabled = false;
    await expect(approveMcpServer(deps, admin(), entry.serverId)).rejects.toThrow(STDIO_OFF_MESSAGE);
    expect((await deps.store.get(ORG, entry.serverId))!.status).toBe("awaiting_approval");
  });
  it("is Enterprise only: the switch alone does nothing in Public, and an address-based server still works with it off", async () => {
    expect(stdioAvailable({ edition: "public", stdioEnabled: true })).toBe(false);
    expect(stdioAvailable({ edition: "enterprise", stdioEnabled: true })).toBe(true);
    expect(stdioAvailable({ edition: "enterprise", stdioEnabled: false })).toBe(false);
    expect(stdioAvailable({ edition: "enterprise" })).toBe(false);
    const { deps } = world({ stdio: false });
    expect((await proposeMcpServer(deps, admin(), { label: "SIM", transport: HTTP })).status).toBe("awaiting_approval");
  });
  it("tells the settings page whether to offer them", async () => {
    const off = world({ stdio: false });
    const listed = await routeMcpServers(off.deps, { orgId: ORG, developerId: "dev1", orgRole: "admin" } as never, { method: "GET", path: "/v1/app/org/mcp-servers", headers: {}, requestId: "r" }, new URL("https://x/v1/app/org/mcp-servers"));
    expect(listed).toMatchObject({ stdioAvailable: false });
    const on = world();
    expect(await routeMcpServers(on.deps, { orgId: ORG, developerId: "dev1", orgRole: "admin" } as never, { method: "GET", path: "/v1/app/org/mcp-servers", headers: {}, requestId: "r" }, new URL("https://x/v1/app/org/mcp-servers"))).toMatchObject({ stdioAvailable: true });
  });
});
