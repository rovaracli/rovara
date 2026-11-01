// Stdio MCP host redesign, task T10: what the controller tells the broker (events), how the broker records it in the audit trail, pauses a server whose tools changed, and summarises it for
// the "recent starts" line. Ids, hashes, counts and fixed words only; a secret, a package's output and an address' owner are in none of it.
import { describe, expect, it } from "vitest";
import { AUDIT_FACT_KEYS, McpControllerEventSchema, orgScoped, type McpControllerEvent } from "@agentx/contracts";
import { controllerEventAudit, mcpServerAudit } from "../../../packages/broker/src/context-sources/audit.js";
import { dynamoControllerEventStore, drainControllerEvents, serverActivities } from "../../../packages/broker/src/context-sources/controller-events.js";
import { approveMcpServer, dynamoMcpServerStore, listMcpServers, proposeMcpServer, type McpServerDependencies, type McpServerSecrets } from "../../../packages/broker/src/context-sources/mcp-servers.js";
import { routeMcpServers } from "../../../packages/broker/src/context-sources/mcp-server-routes.js";
import { dynamoControllerEvents } from "../../../packages/broker/src/mcp-host/events.js";
import { capturingAuditDeps } from "../../support/audit-capture.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { GET_TOOL, NOW, ORG, SEARCH_TOOL } from "./fixtures.js";

const SERVER = "mcpwiki000001";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const at = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();
const admin = { orgId: ORG, developerId: "dev1", orgRole: "admin" };
const INTEGRITY = `sha512-${"A".repeat(86)}==`;
const PKG = { kind: "stdio" as const, spec: { registry: "npm" as const, name: "@acme/wiki-mcp", version: "2.0.1", args: [], secretEnv: ["WIKI_TOKEN"], destinations: [{ host: "wiki.corp.example", port: 443 }] } };

describe("T10: the controller's sink", () => {
  function sink(over: { max?: number; fail?: boolean } = {}) {
    const db = new FakeDynamoDb();
    const sent: unknown[] = [];
    const client = { send: async (command: unknown) => { sent.push(command); if (over.fail) throw new Error("table down"); return db.send(command as never); } };
    let n = 0;
    const logs: string[] = [];
    const s = dynamoControllerEvents({ documentClient: client, tableName: "state", orgId: ORG, now: () => NOW, random: () => String(++n).padStart(12, "0"), ...(over.max === undefined ? {} : { maxPerWindow: over.max }), log: (event) => { logs.push(event); } });
    return { s, db, sent, logs };
  }
  const itemsOf = (db: FakeDynamoDb) => [...db.items.values()].filter((item) => item.pk === orgScoped(ORG, "MCPEVT"));
  it("writes each event as one small item in the events partition, by time, with only the event's own fields", async () => {
    const { s, db } = sink();
    await s.record({ type: "task_started", serverId: SERVER, trigger: "warm" });
    await s.record({ type: "task_stopped", serverId: SERVER, reason: "idle" });
    await s.record({ type: "changed_needs_review", serverId: SERVER, approved: HASH_A, observed: HASH_B });
    await s.egress({ serverId: SERVER, hosts: ["wiki.corp.example:443"], added: ["10.1.2.9:443"], removed: ["10.1.2.3:443"] });
    const items = itemsOf(db).sort((a, b) => String(a.sk).localeCompare(String(b.sk)));
    expect(items.map((item) => item.type)).toEqual(["task_started", "task_stopped", "changed_needs_review", "egress_updated"]);
    expect(items.every((item) => String(item.sk).startsWith(`EVT#${at(0)}#`))).toBe(true);
    expect(items[0]).toMatchObject({ serverId: SERVER, at: at(0), trigger: "warm" });
    expect(items[3]).toMatchObject({ added: 1, removed: 1, addresses: "for wiki.corp.example:443; added 10.1.2.9:443; removed 10.1.2.3:443" });
    for (const item of items) { const { pk: _pk, sk: _sk, ...rest } = item; void _pk; void _sk; expect(McpControllerEventSchema.safeParse(rest).success).toBe(true); }
  });
  it("writes nothing for an egress change that changed nothing, and never throws when the table is down", async () => {
    const quiet = sink();
    await quiet.s.egress({ serverId: SERVER, hosts: [], added: [], removed: [] });
    expect(itemsOf(quiet.db)).toEqual([]);
    const down = sink({ fail: true });
    await expect(down.s.record({ type: "task_stopped", serverId: SERVER, reason: "crash" })).resolves.toBeUndefined();
    expect(down.logs).toEqual(["mcp_controller.event_write_failed"]);
  });
  it("is bounded: past the window's limit an event is dropped and counted, and the window frees up", async () => {
    let clock = NOW;
    const db = new FakeDynamoDb();
    const s = dynamoControllerEvents({ documentClient: db, tableName: "state", orgId: ORG, now: () => clock, maxPerWindow: 3, windowMs: 60_000 });
    for (let i = 0; i < 5; i += 1) await s.record({ type: "task_stopped", serverId: SERVER, reason: "crash" });
    expect(itemsOf(db)).toHaveLength(3);
    expect(s.dropped()).toBe(2);
    clock += 60_000;
    await s.record({ type: "task_stopped", serverId: SERVER, reason: "crash" });
    expect(itemsOf(db)).toHaveLength(4);
  });
  it("refuses to write a field the broker would not read: an unknown reason throws before any write", async () => {
    const { s, sent } = sink();
    await expect(s.record({ type: "task_stopped", serverId: SERVER, reason: "because I said so" as never })).rejects.toThrow();
    await expect(s.record({ type: "task_stopped", serverId: "../x", reason: "idle" })).rejects.toThrow();
    expect(sent).toEqual([]);
  });
  it("writes an event only if its key is free: a repeated key (a retry) keeps the first item and writes no second", async () => {
    const db = new FakeDynamoDb();
    const sent: Array<{ input: Record<string, unknown> }> = [];
    const client = { send: async (command: unknown) => { sent.push(command as { input: Record<string, unknown> }); return db.send(command as never); } };
    const twice = dynamoControllerEvents({ documentClient: client, tableName: "state", orgId: ORG, now: () => NOW, random: () => "same-key" });
    await twice.record({ type: "task_stopped", serverId: SERVER, reason: "idle" });
    await twice.record({ type: "task_stopped", serverId: SERVER, reason: "crash" });
    expect(sent.every((command) => command.input.ConditionExpression === "attribute_not_exists(pk)")).toBe(true);
    expect(itemsOf(db)).toHaveLength(1);
    expect(itemsOf(db)[0]).toMatchObject({ reason: "idle" });
  });
  it("keeps at most 16 names and addresses of each kind, and the whole text within 900 characters, however long the names are", async () => {
    const { s, db } = sink();
    const long = (prefix: string) => Array.from({ length: 40 }, (_, i) => `${prefix}${i}.${"x".repeat(58)}.corp.example:443`);
    await s.egress({ serverId: SERVER, hosts: long("h"), added: long("a"), removed: long("r") });
    const text = String(itemsOf(db)[0]!.addresses);
    expect(text.length).toBeLessThanOrEqual(900);
    expect(text).not.toContain("h39.");
    const few = sink();
    await few.s.egress({ serverId: SERVER, hosts: Array.from({ length: 20 }, (_, i) => `h${i}.c:443`), added: [], removed: ["a"] });
    expect(String(itemsOf(few.db)[0]!.addresses)).toContain("h15.");
    expect(String(itemsOf(few.db)[0]!.addresses)).not.toContain("h16.");
  });
  it("bounds the address text of an egress change", async () => {
    const { s, db } = sink();
    await s.egress({ serverId: SERVER, hosts: Array.from({ length: 40 }, (_, i) => `host${i}.corp.example:443`), added: Array.from({ length: 40 }, (_, i) => `10.0.0.${i}:443`), removed: [] });
    const item = itemsOf(db)[0]!;
    expect(String(item.addresses).length).toBeLessThanOrEqual(900);
    expect(item.added).toBe(40);
  });
});

describe("T10: draining the events", () => {
  async function setup(events: Array<[string, McpControllerEvent]> = []) {
    const db = new FakeDynamoDb();
    const capture = capturingAuditDeps({ db, now: () => NOW });
    const store = dynamoControllerEventStore({ documentClient: db, tableName: "state" });
    const servers = dynamoMcpServerStore({ documentClient: db, tableName: "state" });
    for (const [sk, event] of events) await db.send(new (await import("@aws-sdk/lib-dynamodb")).PutCommand({ TableName: "state", Item: { pk: orgScoped(ORG, "MCPEVT"), sk, ...event } }));
    return { db, capture, store, servers, audit: controllerEventAudit(capture.deps)!, deps: (audit = controllerEventAudit(capture.deps)) => ({ events: store, servers, audit, now: () => NOW }) };
  }
  const started: McpControllerEvent = { type: "task_started", serverId: SERVER, at: at(-5_000), trigger: "call" };
  const stopped: McpControllerEvent = { type: "task_stopped", serverId: SERVER, at: at(-1_000), reason: "idle" };
  it("records each event once as a system fact with the right target and facts, in order, and marks it recorded", async () => {
    const w = await setup([["EVT#a#1", started], ["EVT#b#1", stopped], ["EVT#c#1", { type: "egress_updated", serverId: SERVER, at: at(-500), added: 1, removed: 0, addresses: "for wiki.corp.example:443; added 10.1.2.9:443; removed " }]]);
    expect(await drainControllerEvents(w.deps(), ORG)).toBe(3);
    const events = w.capture.recorded();
    expect(events.map((event) => event.action)).toEqual(["mcp_server.task_started", "mcp_server.task_stopped", "mcp_server.egress_updated"]);
    for (const event of events) {
      expect(event.actor).toEqual({ kind: "system", id: "rovara" });
      expect(event.target).toEqual({ kind: "mcp_server", id: SERVER });
      expect(Object.keys(event.facts ?? {}).every((key) => AUDIT_FACT_KEYS[event.action].includes(key)), event.action).toBe(true);
    }
    expect(events[0]!.facts).toEqual({ trigger: "call" });
    expect(events[1]!.facts).toEqual({ cause: "idle" });
    expect(events[2]!.facts).toEqual({ added: 1, removed: 0 });
    expect(events[2]!.details).toEqual([{ subject: "org", fields: { addresses: "for wiki.corp.example:443; added 10.1.2.9:443; removed " } }]);
    expect(JSON.stringify(events.map((event) => event.facts))).not.toContain("10.1.2.9");
    // nothing is left to record, and a second drain records nothing
    expect(await drainControllerEvents(w.deps(), ORG)).toBe(0);
    expect(w.capture.recorded()).toHaveLength(3);
  });
  it("records the same event once even when marking it failed the first time (the sort key is the occurrence)", async () => {
    const w = await setup([["EVT#a#1", started]]);
    const failingStore = { ...w.store, markAudited: async () => { throw new Error("table down"); } };
    expect(await drainControllerEvents({ ...w.deps(), events: failingStore }, ORG)).toBe(0);
    expect(await drainControllerEvents(w.deps(), ORG)).toBe(1);
    expect(w.capture.recorded().filter((event) => event.action === "mcp_server.task_started")).toHaveLength(1);
  });
  it("stops at the first event the ledger would not take, so the trail stays in order, and never throws", async () => {
    const w = await setup([["EVT#a#1", started], ["EVT#b#1", stopped]]);
    let calls = 0;
    const flaky = async (orgId: typeof ORG, sk: string, event: McpControllerEvent) => { calls += 1; if (calls === 1) throw new Error("ledger down"); await w.audit(orgId, sk, event); };
    expect(await drainControllerEvents(w.deps(flaky), ORG)).toBe(0);
    expect(await drainControllerEvents(w.deps(flaky), ORG)).toBe(2);
    expect(w.capture.recorded().map((event) => event.action)).toEqual(["mcp_server.task_started", "mcp_server.task_stopped"]);
  });
  it("never handles more than 100 events a call, whatever number is asked for", async () => {
    const w = await setup(Array.from({ length: 130 }, (_, i) => [`EVT#a#${String(i).padStart(3, "0")}`, { ...started, at: at(-200_000 + i) }] as [string, McpControllerEvent]));
    expect(await drainControllerEvents(w.deps(), ORG, 1_000)).toBe(100);
    expect(await drainControllerEvents(w.deps(), ORG, 1_000)).toBe(30);
  });
  it("records two events that carry the same time as two events (the item's own key, not the time, is the occurrence)", async () => {
    const w = await setup([["EVT#a#1", started], ["EVT#a#2", started]]);
    await drainControllerEvents(w.deps(), ORG);
    expect(w.capture.recordedBy("mcp_server.task_started")).toHaveLength(2);
  });
  it("handles at most the asked number of events a call", async () => {
    const w = await setup(Array.from({ length: 10 }, (_, i) => [`EVT#a#${i}`, { ...started, at: at(-10_000 + i) }] as [string, McpControllerEvent]));
    expect(await drainControllerEvents(w.deps(), ORG, 4)).toBe(4);
    expect(await drainControllerEvents(w.deps(), ORG, 100)).toBe(6);
  });
  it("does not read an item that is not an event of the schema (a wrong field, another type, a bad id)", async () => {
    const w = await setup([["EVT#a#1", { ...started, extra: "x" } as never], ["EVT#b#1", { ...started, serverId: "nope" }], ["EVT#c#1", started], ["OTHER#d", started]]);
    expect(await drainControllerEvents(w.deps(), ORG)).toBe(1);
    expect(await w.store.recent(ORG, 50)).toHaveLength(1);
  });
  it("marks events recorded even where the install has no ledger", async () => {
    const w = await setup([["EVT#a#1", started]]);
    expect(await drainControllerEvents(w.deps(undefined), ORG)).toBe(1);
    expect(await drainControllerEvents(w.deps(undefined), ORG)).toBe(0);
  });
  it("is for one org: another org's events are not read, recorded or applied", async () => {
    const w = await setup([["EVT#a#1", started]]);
    expect(await drainControllerEvents(w.deps(), "org_bbbbbbbbbbbbbbbbbbbb")).toBe(0);
    expect(w.capture.recorded()).toEqual([]);
  });
});

describe("T10: pausing a server whose tools changed", () => {
  async function approvedServer() {
    const db = new FakeDynamoDb();
    const capture = capturingAuditDeps({ db, now: () => NOW });
    const vault = new Map<string, string>();
    const secrets: McpServerSecrets = { put: async (_o, id, value) => { vault.set(id, value); return "v1"; }, read: async (_o, id) => vault.get(id), remove: async (_o, id) => { vault.delete(id); } };
    const deps: McpServerDependencies = {
      store: dynamoMcpServerStore({ documentClient: db, tableName: "state" }), edition: "enterprise", now: () => NOW, secrets, stdioEnabled: true, newId: () => "00000001abcd",
      prober: { http: async () => [SEARCH_TOOL], stdio: async (_s, pinned) => ({ tools: [SEARCH_TOOL, GET_TOOL], integrity: INTEGRITY, lockfileHash: "1".repeat(64), bundleHash: "2".repeat(64), installed: pinned === undefined ? { packageCount: 5, unpackedBytes: 5_000 } : undefined }) },
      audit: mcpServerAudit(capture.deps, () => NOW)!,
    };
    const entry = await proposeMcpServer(deps, admin, { label: "Wiki", transport: PKG, secrets: { WIKI_TOKEN: "v" } });
    await approveMcpServer(deps, admin, entry.serverId);
    const events = dynamoControllerEventStore({ documentClient: db, tableName: "state" });
    return { db, capture, deps, entry, events, drain: () => drainControllerEvents({ events, servers: deps.store, audit: controllerEventAudit(capture.deps), now: () => NOW }, ORG) };
  }
  const put = async (db: FakeDynamoDb, sk: string, event: McpControllerEvent) => db.send(new (await import("@aws-sdk/lib-dynamodb")).PutCommand({ TableName: "state", Item: { pk: orgScoped(ORG, "MCPEVT"), sk, ...event } }));
  it("moves an approved entry whose approved tools hash matches to changed_needs_review, records it, and never serves it", async () => {
    const w = await approvedServer();
    await put(w.db, "EVT#a#1", { type: "changed_needs_review", serverId: w.entry.serverId, at: at(-1_000), approved: w.entry.probe.toolsHash, observed: HASH_B });
    await w.drain();
    const after = (await w.deps.store.get(ORG, w.entry.serverId))!;
    expect(after.status).toBe("changed_needs_review");
    expect(after.decidedBy).toBe("rovara");
    const recorded = w.capture.recordedBy("mcp_server.changed_needs_review")[0]!;
    expect(recorded.facts).toEqual({ approvedToolsHash: w.entry.probe.toolsHash, observedToolsHash: HASH_B });
    // a paused entry cannot be approved as it is, and says what to do
    await expect(approveMcpServer(w.deps, admin, w.entry.serverId)).rejects.toThrow(/paused. Add the package again/u);
  });
  it("changes nothing when the entry no longer carries the approved hash (the admin already looked again) or is not approved any more", async () => {
    const w = await approvedServer();
    await put(w.db, "EVT#a#1", { type: "changed_needs_review", serverId: w.entry.serverId, at: at(-1_000), approved: HASH_A, observed: HASH_B });
    await w.drain();
    expect((await w.deps.store.get(ORG, w.entry.serverId))?.status).toBe("approved");
    // and the event is still recorded
    expect(w.capture.recordedBy("mcp_server.changed_needs_review")).toHaveLength(1);
    await w.deps.store.decide({ orgId: ORG, serverId: w.entry.serverId, from: "approved", to: "disabled", by: "dev1", at: at(0) });
    await put(w.db, "EVT#b#1", { type: "changed_needs_review", serverId: w.entry.serverId, at: at(-500), approved: w.entry.probe.toolsHash, observed: HASH_B });
    await w.drain();
    expect((await w.deps.store.get(ORG, w.entry.serverId))?.status).toBe("disabled");
  });
  it("lists a paused entry, can turn it off, and the controller's registry does not serve it", async () => {
    const w = await approvedServer();
    await put(w.db, "EVT#a#1", { type: "changed_needs_review", serverId: w.entry.serverId, at: at(-1_000), approved: w.entry.probe.toolsHash, observed: HASH_B });
    await w.drain();
    expect((await listMcpServers(w.deps, admin)).map((server) => server.status)).toEqual(["changed_needs_review"]);
    const { stdioSpecIfComplete } = await import("@agentx/contracts");
    expect(stdioSpecIfComplete((await w.deps.store.get(ORG, w.entry.serverId))!)).toBeUndefined();
    const { disableMcpServer } = await import("../../../packages/broker/src/context-sources/mcp-servers.js");
    await disableMcpServer(w.deps, admin, w.entry.serverId);
    expect((await w.deps.store.get(ORG, w.entry.serverId))?.status).toBe("disabled");
  });
});

describe("T10: the audit events of an install and an approval", () => {
  async function world() {
    const db = new FakeDynamoDb();
    const capture = capturingAuditDeps({ db, now: () => NOW });
    const vault = new Map<string, string>();
    const secrets: McpServerSecrets = { put: async (_o, id, value) => { vault.set(id, value); return "v7"; }, read: async (_o, id) => vault.get(id), remove: async (_o, id) => { vault.delete(id); } };
    const deps: McpServerDependencies = {
      store: dynamoMcpServerStore({ documentClient: db, tableName: "state" }), edition: "enterprise", now: () => NOW, secrets, stdioEnabled: true, newId: () => "00000001abcd",
      prober: { http: async () => [SEARCH_TOOL], stdio: async (_s, pinned) => ({ tools: [SEARCH_TOOL, GET_TOOL], integrity: INTEGRITY, lockfileHash: "1".repeat(64), bundleHash: "2".repeat(64), installed: pinned === undefined ? { packageCount: 5, unpackedBytes: 5_000 } : undefined }) },
      audit: mcpServerAudit(capture.deps, () => NOW)!,
    };
    return { deps, capture, db };
  }
  it("records the install and the test of a proposal, and on approval the second test and the approval with everything it pinned", async () => {
    const w = await world();
    const entry = await proposeMcpServer(w.deps, admin, { label: "Wiki", transport: PKG, secrets: { WIKI_TOKEN: "very-secret-value" } });
    await approveMcpServer(w.deps, admin, entry.serverId);
    const installed = w.capture.recordedBy("mcp_server.installed")[0]!;
    expect(installed.facts).toEqual({ package: "@acme/wiki-mcp", version: "2.0.1", integrity: INTEGRITY, lockfileHash: "1".repeat(64), bundleHash: "2".repeat(64), packageCount: 5, unpackedBytes: 5_000 });
    const probed = w.capture.recordedBy("mcp_server.probed");
    expect(probed.map((event) => event.facts?.purpose).sort()).toEqual(["approval", "proposal"]);
    expect(probed[0]!.facts).toMatchObject({ toolsHash: entry.probe.toolsHash, bundleHash: "2".repeat(64), toolCount: 2 });
    const approved = w.capture.recordedBy("mcp_server.approved")[0]!;
    expect(approved.facts).toEqual({
      transport: "stdio", hasCredential: true, integrity: INTEGRITY, lockfileHash: "1".repeat(64), bundleHash: "2".repeat(64), toolsHash: entry.probe.toolsHash, destinationCount: 1, credentialCount: 1, credentialVersion: "v7",
    });
    expect(approved.details).toEqual([{ subject: "org", fields: { label: "Wiki", destinations: "wiki.corp.example:443", secretNames: "WIKI_TOKEN" } }]);
    for (const event of w.capture.recorded()) expect(Object.keys(event.facts ?? {}).every((key) => AUDIT_FACT_KEYS[event.action].includes(key)), event.action).toBe(true);
    // secret NAMES are in the org's details only; no value is anywhere
    const everything = JSON.stringify([w.capture.recorded(), w.capture.pendingItems(), w.capture.sqs.queue, w.capture.logs]);
    expect(everything).not.toContain("very-secret-value");
    expect(JSON.stringify(w.capture.recorded().map((event) => event.facts))).not.toContain("WIKI_TOKEN");
    expect(JSON.stringify(w.capture.recorded().map((event) => event.facts))).not.toContain("wiki.corp.example");
  });
  it("leaves an address-server's approval exactly as it was: transport and credential, nothing pinned", async () => {
    const w = await world();
    const entry = await proposeMcpServer(w.deps, admin, { label: "SIM", transport: { kind: "http", address: "https://sim.corp.example/mcp" } });
    await approveMcpServer(w.deps, admin, entry.serverId);
    expect(w.capture.recordedBy("mcp_server.approved")[0]!.facts).toEqual({ transport: "http", hasCredential: false });
    expect(w.capture.recordedBy("mcp_server.installed")).toEqual([]);
    expect(w.capture.recordedBy("mcp_server.probed")).toEqual([]);
  });
  it("a ledger that is down does not stop the proposal or the approval", async () => {
    const w = await world();
    w.capture.audit.documentClient = { send: async () => { throw new Error("table down"); } } as never;
    const entry = await proposeMcpServer(w.deps, admin, { label: "Wiki", transport: PKG, secrets: { WIKI_TOKEN: "v" } });
    expect((await approveMcpServer(w.deps, admin, entry.serverId)).status).toBe("approved");
  });
});

describe("T10: the recent starts line", () => {
  const ev = (type: "task_started" | "task_stopped", offsetMs: number, extra: Record<string, unknown> = {}, serverId = SERVER) => ({ sk: `EVT#${offsetMs}`, audited: true, event: { type, serverId, at: at(offsetMs), ...(type === "task_started" ? { trigger: "call" } : { reason: "idle" }), ...extra } as McpControllerEvent });
  it("counts the starts of the last day, names the last start and the last stop, per server (newest events first)", () => {
    const events = [ev("task_stopped", -1_000, { reason: "lifetime" }), ev("task_started", -2_000), ev("task_stopped", -3_000), ev("task_started", -4_000), ev("task_started", -25 * 3_600_000), ev("task_started", -500, {}, "mcpother000001")];
    const out = serverActivities(events, NOW);
    expect(out[SERVER]).toEqual({ starts24h: 2, lastStartAt: at(-2_000), lastStop: { at: at(-1_000), reason: "lifetime" }, keepsStopping: false });
    expect(out.mcpother000001).toEqual({ starts24h: 1, lastStartAt: at(-500), keepsStopping: false });
  });
  it("says a server keeps stopping after three crashes in ten minutes, and not for old or fewer crashes or other reasons", () => {
    const crashes = (n: number, ago: number) => Array.from({ length: n }, (_, i) => ev("task_stopped", -ago - i * 1_000, { reason: "crash" }));
    expect(serverActivities(crashes(3, 1_000), NOW)[SERVER]!.keepsStopping).toBe(true);
    expect(serverActivities(crashes(2, 1_000), NOW)[SERVER]!.keepsStopping).toBe(false);
    expect(serverActivities(crashes(3, 11 * 60_000), NOW)[SERVER]!.keepsStopping).toBe(false);
    expect(serverActivities([ev("task_stopped", -1_000), ev("task_stopped", -2_000), ev("task_stopped", -3_000)], NOW)[SERVER]!.keepsStopping).toBe(false);
  });
  it("leaves out changes, pauses and egress events, and a server with no events has no entry", () => {
    const events: Array<ReturnType<typeof ev>> = [{ sk: "EVT#1", audited: true, event: { type: "changed_needs_review", serverId: SERVER, at: at(-1), approved: HASH_A, observed: HASH_B } }];
    expect(serverActivities(events, NOW)).toEqual({});
  });
});

describe("T10: the list route", () => {
  const caller = admin as never;
  const get = (deps: McpServerDependencies) => routeMcpServers(deps, caller, { method: "GET", path: "/v1/app/org/mcp-servers", headers: {}, requestId: "r" }, new URL("https://x/v1/app/org/mcp-servers")) as Promise<{ servers: Array<{ status: string }>; activity?: Record<string, unknown> }>;
  async function world() {
    const db = new FakeDynamoDb();
    const capture = capturingAuditDeps({ db, now: () => NOW });
    const secrets: McpServerSecrets = { put: async () => "v1", read: async () => "x", remove: async () => undefined };
    const events = dynamoControllerEventStore({ documentClient: db, tableName: "state" });
    const deps: McpServerDependencies = {
      store: dynamoMcpServerStore({ documentClient: db, tableName: "state" }), edition: "enterprise", now: () => NOW, secrets, stdioEnabled: true, newId: () => "00000001abcd",
      prober: { http: async () => [SEARCH_TOOL], stdio: async () => ({ tools: [SEARCH_TOOL], integrity: INTEGRITY, lockfileHash: "1".repeat(64), bundleHash: "2".repeat(64) }) },
      controllerEvents: { store: events, audit: controllerEventAudit(capture.deps) },
    };
    return { db, capture, deps };
  }
  it("records the new events, applies a pause, and answers with each package-run server's activity", async () => {
    const w = await world();
    const entry = await proposeMcpServer(w.deps, admin, { label: "Plain", transport: { kind: "stdio", spec: { registry: "npm", name: "@acme/plain", version: "1.0.0", args: [] } } });
    await approveMcpServer(w.deps, admin, entry.serverId);
    const { PutCommand } = await import("@aws-sdk/lib-dynamodb");
    await w.db.send(new PutCommand({ TableName: "state", Item: { pk: orgScoped(ORG, "MCPEVT"), sk: "EVT#a#1", type: "task_started", serverId: entry.serverId, at: at(-60_000), trigger: "warm" } }));
    await w.db.send(new PutCommand({ TableName: "state", Item: { pk: orgScoped(ORG, "MCPEVT"), sk: "EVT#b#1", type: "changed_needs_review", serverId: entry.serverId, at: at(-30_000), approved: entry.probe.toolsHash, observed: HASH_B } }));
    const answer = await get(w.deps);
    expect(answer.servers.map((server) => server.status)).toEqual(["changed_needs_review"]);
    expect(answer.activity).toEqual({ [entry.serverId]: { starts24h: 1, lastStartAt: at(-60_000), keepsStopping: false } });
    expect(w.capture.recorded().map((event) => event.action)).toEqual(expect.arrayContaining(["mcp_server.task_started", "mcp_server.changed_needs_review"]));
  });
  it("answers without activity, and reads no events, when there are no package-run servers or no controller events", async () => {
    const w = await world();
    await proposeMcpServer(w.deps, admin, { label: "SIM", transport: { kind: "http", address: "https://sim.corp.example/mcp" } });
    let reads = 0;
    const counting = { ...w.deps.controllerEvents!.store, recent: async (o: typeof ORG, l: number) => { reads += 1; return w.deps.controllerEvents!.store.recent(o, l); } };
    expect(await get({ ...w.deps, controllerEvents: { store: counting } })).not.toHaveProperty("activity");
    expect(reads).toBe(0);
    const bare = { ...w.deps };
    delete bare.controllerEvents;
    expect(await get(bare)).not.toHaveProperty("activity");
  });
  it("still answers when the events cannot be read", async () => {
    const w = await world();
    await proposeMcpServer(w.deps, admin, { label: "Plain", transport: { kind: "stdio", spec: { registry: "npm", name: "@acme/plain", version: "1.0.0", args: [] } } });
    const broken = { unaudited: async () => { throw new Error("down"); }, recent: async () => { throw new Error("down"); }, markAudited: async () => undefined };
    const answer = await get({ ...w.deps, controllerEvents: { store: broken } });
    expect(answer.servers).toHaveLength(1);
    expect(answer).not.toHaveProperty("activity");
  });
});
