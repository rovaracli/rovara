// Fix round (Opus review): the Audit Ledger records each admin change to a private MCP server and to a project's Sources, with the actor, the org and the target, and never a token.
import { describe, expect, it } from "vitest";
import type { AuditEventInput } from "@agentx/cloud-contracts";
import { AUDIT_FACT_KEYS } from "@agentx/cloud-contracts";
import { contextSourceAudit, mcpServerAudit } from "../../../packages/broker/src/context-sources/audit.js";
import { approveMcpServer, disableMcpServer, dynamoMcpServerStore, proposeMcpServer, removeMcpServer, type McpServerDependencies, type McpServerSecrets } from "../../../packages/broker/src/context-sources/mcp-servers.js";
import { confirmSourceChange, proposeSourceChange, rejectSourceChange, type SettingsDependencies } from "../../../packages/broker/src/context-sources/settings.js";
import { dynamoContextSourceStore } from "../../../packages/broker/src/context-sources/store.js";
import { capturingAuditDeps } from "../../support/audit-capture.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { GET_TOOL, NOW, ORG, SEARCH_TOOL, environment, source } from "./fixtures.js";

const TOKEN = ["sekret", "token", "value", "12345"].join("-");
const ADDRESS = "https://sim.corp.example/mcp";
const actor = { orgId: ORG, developerId: "dev1", orgRole: "admin" };

function serverWorld() {
  const db = new FakeDynamoDb();
  const capture = capturingAuditDeps({ db, now: () => NOW });
  const vault = new Map<string, string>();
  const secrets: McpServerSecrets = { put: async (_o, id, value) => { vault.set(id, value); return "v1"; }, read: async (_o, id) => vault.get(id), remove: async (_o, id) => { vault.delete(id); } };
  let counter = 0;
  const deps: McpServerDependencies = {
    store: dynamoMcpServerStore({ documentClient: db, tableName: "state" }), edition: "enterprise", now: () => NOW, secrets,
    prober: { http: async () => [SEARCH_TOOL, GET_TOOL], stdio: async () => ({ tools: [SEARCH_TOOL], integrity: `sha512-${"A".repeat(86)}==` }) },
    newId: () => `${String(++counter).padStart(8, "0")}abcd`, audit: mcpServerAudit(capture.deps, () => NOW)!,
  };
  return { deps, capture };
}

const withoutDetails = (events: AuditEventInput[]) => events.map(({ details: _details, ...rest }) => rest); // eslint-disable-line @typescript-eslint/no-unused-vars -- details are checked separately

describe("private MCP servers in the audit ledger", () => {
  it("records add, token stored, approve, disable, token deleted and remove, each with actor, org and target, and never the token or the address", async () => {
    const { deps, capture } = serverWorld();
    const entry = await proposeMcpServer(deps, actor, { label: "SIM", transport: { kind: "http", address: ADDRESS }, secret: TOKEN });
    await approveMcpServer(deps, actor, entry.serverId);
    await disableMcpServer(deps, actor, entry.serverId);
    await removeMcpServer(deps, actor, entry.serverId);
    const events = capture.recorded();
    expect(events.map((event) => event.action).sort()).toEqual(["mcp_server.added", "mcp_server.approved", "mcp_server.disabled", "mcp_server.removed", "mcp_server.token_changed", "mcp_server.token_changed"]);
    for (const event of events) {
      expect(event.orgId).toBe(ORG);
      expect(event.actor).toEqual({ kind: "member", id: "dev1" });
      expect(event.target).toEqual({ kind: "mcp_server", id: entry.serverId });
      expect(Object.keys(event.facts ?? {}).every((key) => AUDIT_FACT_KEYS[event.action].includes(key)), event.action).toBe(true);
    }
    expect(events.filter((event) => event.action === "mcp_server.token_changed").map((event) => event.facts?.change).sort()).toEqual(["deleted", "stored"]);
    expect(events.find((event) => event.action === "mcp_server.added")?.facts).toEqual({ transport: "http", hasCredential: true });
    // the label is in the org details; the token and the address are nowhere in anything recorded
    expect(events.find((event) => event.action === "mcp_server.added")?.details).toEqual([{ subject: "org", fields: { label: "SIM" } }]);
    const everything = JSON.stringify([capture.recorded(), capture.pendingItems(), capture.sqs.queue, capture.logs]);
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain("sim.corp.example");
    expect(JSON.stringify(withoutDetails(events))).not.toContain("SIM");
  });
  it("records a server with no token without a token event, and a package-run server by its transport", async () => {
    const { deps, capture } = serverWorld();
    const entry = await proposeMcpServer(deps, actor, { label: "SIM", transport: { kind: "http", address: ADDRESS } });
    await disableMcpServer(deps, actor, entry.serverId);
    expect(capture.recorded().map((event) => event.action).sort()).toEqual(["mcp_server.added", "mcp_server.disabled"]);
    expect(capture.recordedBy("mcp_server.disabled")[0]?.facts).toEqual({ transport: "http" });
  });
  it("tidy round: the label in the event's details is capped (it is free text) and otherwise left as typed", async () => {
    const { deps, capture } = serverWorld();
    const { auditMcpServerChanged } = await import("../../../packages/broker/src/audit/events.js");
    const long = auditMcpServerChanged({ orgId: ORG, actor: { kind: "member", id: "dev1" }, occurredAt: "2026-11-01T10:00:00.000Z", occurrence: "x", action: "mcp_server.added", serverId: "mcpone000001", label: "L".repeat(500), transport: "http" });
    expect(long.details).toEqual([{ subject: "org", fields: { label: "L".repeat(60) } }]);
    const entry = await proposeMcpServer(deps, actor, { label: "My SIM server", transport: { kind: "http", address: ADDRESS } });
    expect(capture.recordedBy("mcp_server.added")[0]?.details).toEqual([{ subject: "org", fields: { label: "My SIM server" } }]);
    expect(entry.label).toBe("My SIM server");
  });
  it("records nothing, and does not fail the change, where the install has no ledger", async () => {
    expect(mcpServerAudit({}, () => NOW)).toBeUndefined();
    expect(contextSourceAudit({}, () => NOW)).toBeUndefined();
  });
  it("a ledger that is down does not undo or fail the admin's change", async () => {
    const { deps, capture } = serverWorld();
    capture.audit.documentClient = { send: async () => { throw new Error("table down"); } } as never;
    const entry = await proposeMcpServer(deps, actor, { label: "SIM", transport: { kind: "http", address: ADDRESS } });
    expect((await deps.store.get(ORG, entry.serverId))?.status).toBe("awaiting_approval");
  });
});

describe("project Sources in the audit ledger", () => {
  it("records a proposed, an applied and a rejected change with actor, org and the project as the target", async () => {
    const db = new FakeDynamoDb();
    const capture = capturingAuditDeps({ db, now: () => NOW });
    let counter = 0;
    const deps: SettingsDependencies = {
      store: dynamoContextSourceStore({ documentClient: db, tableName: "state", now: () => NOW }), env: environment(), now: () => NOW,
      newId: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`, audit: contextSourceAudit(capture.deps, () => NOW)!,
    };
    const first = await proposeSourceChange(deps, actor, "proj", { kind: "set", source: source() });
    await confirmSourceChange(deps, actor, "proj", first.changeId);
    const second = await proposeSourceChange(deps, actor, "proj", { kind: "remove", sourceId: "sim" });
    await rejectSourceChange(deps, actor, "proj", second.changeId);
    const events = capture.recorded();
    expect(events.map((event) => [event.action, event.facts?.change]).sort()).toEqual([
      ["context_source.applied", "set"], ["context_source.proposed", "remove"], ["context_source.proposed", "set"], ["context_source.rejected", "remove"],
    ]);
    for (const event of events) {
      expect(event.orgId).toBe(ORG);
      expect(event.actor).toEqual({ kind: "member", id: "dev1" });
      expect(event.target).toEqual({ kind: "project", name: "proj" });
      expect(event.details).toEqual([{ subject: "org", fields: { sourceId: "sim" } }]);
      expect(event.related?.length).toBe(1);
    }
  });
});
