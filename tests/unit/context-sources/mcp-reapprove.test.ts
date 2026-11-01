// Fix round 1, S3 (owner decision 2026-10-31: auto-pause after an upgrade that changes tools, one-click re-approve). A paused server shows what changed, and one click approves the new tools
// with the pinned install unchanged. What is promised: the diff is exact; only an admin can re-approve, and a second admin when the install asks for one; the tools approved are the ones the
// admin was shown (otherwise nothing is approved); the install is never touched; a paused server stays paused unless somebody re-approves it; the controller serves it again at once.
import { describe, expect, it } from "vitest";
import type { McpServerProbe } from "@agentx/contracts";
import { mcpServerAudit } from "../../../packages/broker/src/context-sources/audit.js";
import { approveMcpServer, diffTools, dynamoMcpServerStore, proposeMcpServer, reapprovePausedMcpServer, reviewPausedMcpServer, summariseProbe, type McpServerDependencies, type McpServerSecrets } from "../../../packages/broker/src/context-sources/mcp-servers.js";
import { routeMcpServers } from "../../../packages/broker/src/context-sources/mcp-server-routes.js";
import { registryFor } from "../../../packages/broker/src/mcp-host/main.js";
import { capturingAuditDeps } from "../../support/audit-capture.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import type { DiscoveredTool } from "../../../packages/broker/src/context-sources/settings.js";
import { GET_TOOL, NOW, ORG, PLAIN_TOOL, SEARCH_TOOL, WRITE_TOOL } from "./fixtures.js";

const admin = (developerId = "dev1", orgRole = "admin") => ({ orgId: ORG, developerId, orgRole });
const INTEGRITY = `sha512-${"A".repeat(86)}==`;
const PKG = { kind: "stdio" as const, spec: { registry: "npm" as const, name: "@acme/wiki-mcp", version: "2.0.1", args: ["--read-only"], secretEnv: ["WIKI_TOKEN"], destinations: [{ host: "wiki.corp.example", port: 443 }] } };

async function world(over: { secondAdmin?: boolean; stdio?: boolean } = {}) {
  const db = new FakeDynamoDb();
  const capture = capturingAuditDeps({ db, now: () => NOW });
  const vault = new Map<string, string>();
  const secrets: McpServerSecrets = { put: async (_o, id, value) => { vault.set(id, value); return "v1"; }, read: async (_o, id) => vault.get(id), remove: async (_o, id) => { vault.delete(id); } };
  const state = { tools: [SEARCH_TOOL, GET_TOOL] as DiscoveredTool[], bundleHash: "2".repeat(64), probes: [] as Array<{ pinned: unknown; serverId: string | undefined }>, clock: NOW };
  let ids = 0;
  const deps: McpServerDependencies = {
    store: dynamoMcpServerStore({ documentClient: db, tableName: "state" }), edition: "enterprise", now: () => state.clock, secrets, stdioEnabled: over.stdio ?? true, newId: () => `0000000${++ids}abcd`,
    prober: { http: async () => [SEARCH_TOOL], stdio: async (_spec, pinned, serverId) => { state.probes.push({ pinned, serverId }); return { tools: state.tools, integrity: INTEGRITY, lockfileHash: "1".repeat(64), bundleHash: state.bundleHash }; } },
    audit: mcpServerAudit(capture.deps, () => state.clock)!, ...(over.secondAdmin === undefined ? {} : { secondAdminToApprove: over.secondAdmin }),
  };
  const entry = await proposeMcpServer(deps, admin("dev1"), { label: "Wiki", transport: PKG, secrets: { WIKI_TOKEN: "wiki-secret-9f3a" } });
  await approveMcpServer(deps, admin("dev2"), entry.serverId);
  const pause = async (): Promise<void> => { await deps.store.decide({ orgId: ORG, serverId: entry.serverId, from: "approved", to: "changed_needs_review", by: "rovara", at: new Date(NOW).toISOString(), toolsHash: entry.probe.toolsHash }); };
  return { deps, db, capture, state, entry, pause };
}
const upgraded: DiscoveredTool[] = [SEARCH_TOOL, { ...GET_TOOL, inputSchema: { type: "object", properties: { id: { type: "string" }, deep: { type: "boolean" } } } }, PLAIN_TOOL];

describe("the diff of a paused server's tools", () => {
  const shown = (tools: DiscoveredTool[]): McpServerProbe["tools"] => summariseProbe(tools, NOW).tools;
  it("lists the tools added, removed and changed, and what about a changed one", () => {
    const before = shown([SEARCH_TOOL, GET_TOOL, WRITE_TOOL]);
    const after = shown([{ ...SEARCH_TOOL, annotations: { readOnlyHint: false } }, { ...GET_TOOL, inputSchema: { type: "object", properties: { other: { type: "string" } } } }, PLAIN_TOOL]);
    const diff = diffTools(before, after);
    expect(diff.added.map((tool) => [tool.name, tool.annotation])).toEqual([["lookup_page", "unannotated"]]);
    expect(diff.removed).toEqual([{ name: "close_ticket" }]);
    expect(diff.changed.map((tool) => [tool.name, tool.what])).toEqual([["get_ticket", ["definition"]], ["search_tickets", ["read_only_claim"]]]);
  });
  it("is empty for the same tools, and reports a changed claim as the claim even when the definition changed with it", () => {
    const same = shown([SEARCH_TOOL, GET_TOOL]);
    expect(diffTools(same, same)).toEqual({ added: [], removed: [], changed: [] });
    const both = diffTools(shown([GET_TOOL]), shown([{ ...GET_TOOL, annotations: { readOnlyHint: false }, inputSchema: { type: "object" } }]));
    expect(both.changed[0]!.what).toEqual(["read_only_claim"]);
  });
});

describe("review: what a paused server offers now", () => {
  it("tests the pinned bundle again without installing, names the proposal's id for its secrets, shows the diff and the hash, and changes nothing", async () => {
    const w = await world();
    await w.pause();
    w.state.tools = upgraded;
    const before = w.state.probes.length;
    const review = await reviewPausedMcpServer(w.deps, admin("dev3"), w.entry.serverId);
    expect(w.state.probes.slice(before)).toEqual([{ pinned: { lockfileHash: "1".repeat(64), bundleHash: "2".repeat(64) }, serverId: w.entry.serverId }]);
    expect(review.toolsHash).toBe(summariseProbe(upgraded, NOW).toolsHash);
    expect(review.diff.added.map((tool) => tool.name)).toEqual(["lookup_page"]);
    expect(review.diff.changed.map((tool) => tool.name)).toEqual(["get_ticket"]);
    expect(review.diff.removed).toEqual([]);
    expect((await w.deps.store.get(ORG, w.entry.serverId))?.status).toBe("changed_needs_review");
    expect((await w.deps.store.get(ORG, w.entry.serverId))?.probe.toolsHash).toBe(w.entry.probe.toolsHash);
  });
  it("refuses an entry that is not paused, an address-server, and a bundle that is not the one approved", async () => {
    const w = await world();
    await expect(reviewPausedMcpServer(w.deps, admin(), w.entry.serverId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(reviewPausedMcpServer(w.deps, admin(), "mcpnothere0001")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await w.pause();
    w.state.bundleHash = "3".repeat(64);
    await expect(reviewPausedMcpServer(w.deps, admin(), w.entry.serverId)).rejects.toMatchObject({ code: "CHANGE_STALE" });
  });
});

describe("re-approve: one click", () => {
  it("approves the tools the admin was shown, keeps the approved install, and the controller serves the server with the new hash at once", async () => {
    const w = await world();
    await w.pause();
    w.state.tools = upgraded;
    const { toolsHash } = await reviewPausedMcpServer(w.deps, admin("dev3"), w.entry.serverId);
    const after = await reapprovePausedMcpServer(w.deps, admin("dev3"), w.entry.serverId, toolsHash);
    expect(after.status).toBe("approved");
    expect(after.transport).toEqual(w.entry.transport);
    const stored = (await w.deps.store.get(ORG, w.entry.serverId))!;
    expect(stored).toMatchObject({ status: "approved", decidedBy: "dev3" });
    expect(stored.probe.toolsHash).toBe(toolsHash);
    expect(stored.probe.tools.map((tool) => tool.name).sort()).toEqual(["get_ticket", "lookup_page", "search_tickets"]);
    // the install that was approved is the one that is still approved
    expect(stored.transport).toEqual(w.entry.transport);
    expect(stored.secretVersion).toBe(w.entry.secretVersion);
    const served = await registryFor(w.deps.store, ORG).approved(w.entry.serverId);
    expect(served?.toolsHash).toBe(toolsHash);
    expect(served?.spec.bundleHash).toBe("2".repeat(64));
  });
  it("records the second test and the approval, with the new tools hash and everything the install pins", async () => {
    const w = await world();
    await w.pause();
    w.state.tools = upgraded;
    const { toolsHash } = await reviewPausedMcpServer(w.deps, admin("dev3"), w.entry.serverId);
    w.state.clock += 60_000;
    await reapprovePausedMcpServer(w.deps, admin("dev3"), w.entry.serverId, toolsHash);
    const approvals = w.capture.recordedBy("mcp_server.approved");
    expect(approvals).toHaveLength(2);
    expect(approvals[1]!.actor).toEqual({ kind: "member", id: "dev3" });
    expect(approvals[1]!.facts).toMatchObject({ transport: "stdio", toolsHash, bundleHash: "2".repeat(64), integrity: INTEGRITY, destinationCount: 1, credentialCount: 1 });
    expect(JSON.stringify(w.capture.recorded())).not.toContain("wiki-secret-9f3a");
  });
  it("Keep paused: with no click the server stays paused, however many times it is reviewed", async () => {
    const w = await world();
    await w.pause();
    w.state.tools = upgraded;
    for (let round = 0; round < 3; round += 1) await reviewPausedMcpServer(w.deps, admin(), w.entry.serverId);
    expect((await w.deps.store.get(ORG, w.entry.serverId))?.status).toBe("changed_needs_review");
    expect(await registryFor(w.deps.store as never, ORG).approved(w.entry.serverId)).toBeUndefined();
    await expect(approveMcpServer(w.deps, admin(), w.entry.serverId)).rejects.toThrow(/Review what it offers now, then re-approve/u);
  });
  it("is for an owner or admin only: a member can neither review nor re-approve, and nothing is tested for them", async () => {
    const w = await world();
    await w.pause();
    const probes = w.state.probes.length;
    for (const role of ["member", "viewer", ""]) {
      await expect(reviewPausedMcpServer(w.deps, admin("dev3", role), w.entry.serverId), role).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(reapprovePausedMcpServer(w.deps, admin("dev3", role), w.entry.serverId, summariseProbe(w.state.tools, NOW).toolsHash), role).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(w.state.probes).toHaveLength(probes);
    expect((await w.deps.store.get(ORG, w.entry.serverId))?.status).toBe("changed_needs_review");
    // an owner may
    await expect(reapprovePausedMcpServer(w.deps, admin("dev3", "owner"), w.entry.serverId, summariseProbe(w.state.tools, NOW).toolsHash)).resolves.toMatchObject({ status: "approved" });
  });
  it("applies the two-admin setting as a first approval does: the admin who added it cannot re-approve it", async () => {
    const w = await world({ secondAdmin: true });
    // dev1 added it, dev2 approved it (the world's two admins); the setting was on then
    await w.pause();
    const hash = summariseProbe(w.state.tools, NOW).toolsHash;
    await expect(reapprovePausedMcpServer(w.deps, admin("dev1"), w.entry.serverId, hash)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await w.deps.store.get(ORG, w.entry.serverId))?.status).toBe("changed_needs_review");
    await expect(reapprovePausedMcpServer(w.deps, admin("dev2"), w.entry.serverId, hash)).resolves.toMatchObject({ status: "approved" });
    // switched off, the same admin may
    const free = await world({ secondAdmin: false });
    await free.pause();
    await expect(reapprovePausedMcpServer(free.deps, admin("dev1"), free.entry.serverId, summariseProbe(free.state.tools, NOW).toolsHash)).resolves.toMatchObject({ status: "approved" });
  });
  it("approves nothing when the tools are not the ones the admin was shown, when the bundle moved, or when the hash is not one", async () => {
    const w = await world();
    await w.pause();
    w.state.tools = upgraded;
    const { toolsHash } = await reviewPausedMcpServer(w.deps, admin(), w.entry.serverId);
    // the server changed again after the review
    w.state.tools = [SEARCH_TOOL];
    await expect(reapprovePausedMcpServer(w.deps, admin(), w.entry.serverId, toolsHash)).rejects.toMatchObject({ code: "CHANGE_STALE" });
    w.state.tools = upgraded;
    w.state.bundleHash = "4".repeat(64);
    await expect(reapprovePausedMcpServer(w.deps, admin(), w.entry.serverId, toolsHash)).rejects.toMatchObject({ code: "CHANGE_STALE" });
    w.state.bundleHash = "2".repeat(64);
    // or the package's own integrity or lockfile is not the one approved
    const real = w.deps.prober;
    for (const moved of [{ integrity: `sha512-${"B".repeat(86)}==` }, { lockfileHash: "9".repeat(64) }]) {
      w.deps.prober = { ...real, stdio: async (...args) => ({ ...(await real.stdio(...args)), ...moved }) };
      await expect(reapprovePausedMcpServer(w.deps, admin(), w.entry.serverId, toolsHash), JSON.stringify(Object.keys(moved))).rejects.toMatchObject({ code: "CHANGE_STALE" });
      await expect(reviewPausedMcpServer(w.deps, admin(), w.entry.serverId), JSON.stringify(Object.keys(moved))).rejects.toMatchObject({ code: "CHANGE_STALE" });
    }
    w.deps.prober = real;
    for (const bad of [undefined, 5, "", "x", "A".repeat(64), toolsHash.slice(1)]) await expect(reapprovePausedMcpServer(w.deps, admin(), w.entry.serverId, bad), String(bad)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect((await w.deps.store.get(ORG, w.entry.serverId))?.status).toBe("changed_needs_review");
    expect((await w.deps.store.get(ORG, w.entry.serverId))?.probe.toolsHash).toBe(w.entry.probe.toolsHash);
  });
  it("lands only on an entry that is still paused with the hash it was paused with (a turn-off in between wins)", async () => {
    const w = await world();
    await w.pause();
    w.state.tools = upgraded;
    const { toolsHash } = await reviewPausedMcpServer(w.deps, admin(), w.entry.serverId);
    const realProber = w.deps.prober;
    w.deps.prober = { ...w.deps.prober, stdio: async (...args) => { const out = await realProber.stdio(...args); await w.deps.store.decide({ orgId: ORG, serverId: w.entry.serverId, from: "changed_needs_review", to: "disabled", by: "dev9", at: new Date(NOW).toISOString() }); return out; } };
    await expect(reapprovePausedMcpServer(w.deps, admin(), w.entry.serverId, toolsHash)).rejects.toMatchObject({ code: "CHANGE_STALE" });
    expect((await w.deps.store.get(ORG, w.entry.serverId))?.status).toBe("disabled");
  });
  it("the store's re-approval needs the paused status and the paused hash", async () => {
    const w = await world();
    const probe = summariseProbe(upgraded, NOW);
    const attempt = (pausedToolsHash: string) => w.deps.store.reapprove({ orgId: ORG, serverId: w.entry.serverId, pausedToolsHash, probe, by: "dev1", at: new Date(NOW).toISOString() });
    expect(await attempt(w.entry.probe.toolsHash)).toBe("stale");
    await w.pause();
    expect(await attempt("f".repeat(64))).toBe("stale");
    expect(await attempt(w.entry.probe.toolsHash)).toBe("ok");
    expect(await attempt(w.entry.probe.toolsHash)).toBe("stale");
  });
  it("refuses where package-run servers are off, for an address-server, and for an entry that is not paused", async () => {
    const off = await world();
    await off.pause();
    off.deps.stdioEnabled = false;
    await expect(reviewPausedMcpServer(off.deps, admin(), off.entry.serverId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const w = await world();
    await expect(reapprovePausedMcpServer(w.deps, admin(), w.entry.serverId, summariseProbe(w.state.tools, NOW).toolsHash)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const http = await proposeMcpServer(w.deps, admin(), { label: "SIM", transport: { kind: "http", address: "https://sim.corp.example/mcp" } });
    await expect(reviewPausedMcpServer(w.deps, admin(), http.serverId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    // even an address-server that somehow carries the paused status is not re-approved this way
    await w.deps.store.decide({ orgId: ORG, serverId: http.serverId, from: "awaiting_approval", to: "changed_needs_review", by: "x", at: new Date(NOW).toISOString() });
    await expect(reviewPausedMcpServer(w.deps, admin(), http.serverId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(reapprovePausedMcpServer(w.deps, admin(), http.serverId, "a".repeat(64))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("the routes", () => {
  const caller = (role = "admin", developerId = "dev3") => ({ orgId: ORG, developerId, orgRole: role }) as never;
  const post = (w: Awaited<ReturnType<typeof world>>, id: string, action: string, body: unknown, who = caller()) => routeMcpServers(w.deps, who, { method: "POST", path: `/v1/app/org/mcp-servers/${id}/${action}`, headers: {}, requestId: "r", body: JSON.stringify(body) }, new URL(`https://x/v1/app/org/mcp-servers/${id}/${action}`)) as Promise<{ server?: { status: string }; diff?: unknown; toolsHash?: string; offers?: unknown }>;
  it("review answers with the diff and the hash; reapprove takes that hash and answers the approved server, with no secret anywhere", async () => {
    const w = await world();
    await w.pause();
    w.state.tools = upgraded;
    const review = await post(w, w.entry.serverId, "review", {});
    expect(review.server?.status).toBe("changed_needs_review");
    expect(JSON.stringify(review.diff)).toContain("lookup_page");
    const done = await post(w, w.entry.serverId, "reapprove", { toolsHash: review.toolsHash });
    expect(done.server?.status).toBe("approved");
    for (const answer of [review, done]) { expect(JSON.stringify(answer)).not.toContain("wiki-secret-9f3a"); expect(JSON.stringify(answer)).not.toContain("secretVersion"); }
  });
  it("a member is refused, a body with another field or no hash is refused, and a GET is not a route", async () => {
    const w = await world();
    await w.pause();
    await expect(post(w, w.entry.serverId, "review", {}, caller("member"))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(post(w, w.entry.serverId, "reapprove", { toolsHash: "a".repeat(64) }, caller("member"))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(post(w, w.entry.serverId, "reapprove", {})).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(post(w, w.entry.serverId, "reapprove", { toolsHash: "a".repeat(64), extra: "s3cret" })).rejects.toThrow(/toolsHash/u);
    await expect(routeMcpServers(w.deps, caller(), { method: "GET", path: `/v1/app/org/mcp-servers/${w.entry.serverId}/reapprove`, headers: {}, requestId: "r" }, new URL(`https://x/v1/app/org/mcp-servers/${w.entry.serverId}/reapprove`))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
