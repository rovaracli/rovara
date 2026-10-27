import * as Web from "../../packages/contracts/src/web.js";
import { expect, it } from "vitest";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { AgentXError, errorStatus, agentGuardrailsKey, orgMemberKey, orgMetaKey, developerOrgKey, DEFAULT_AGENT_GUARDRAILS, agentKey, builtinSettingsKey } from "@agentx/contracts";
import { routeDeveloperRequest, type DeveloperCaller, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";
const who = "a".repeat(64);
const custom = "agt_aaaaaaaaaaaaaaaaaaaa", builtin = "rovara-code";
const basePath = "/v1/app/org/task-stop-policy/agents/";
const path = basePath + custom;
const policyKey = (orgId = A) => ({ pk: `ORG#${orgId}#SETTINGS`, sk: "TASK_STOP_POLICY" });
function fixture(role = "owner", eventual = false) {
  const db = new FakeDynamoDb(eventual ? { consistency: "eventual" } : undefined);
  function member(orgId = A, current = role) {
    db.set({ ...orgMemberKey(orgId, who), orgId, developerId: who, role: current });
    db.set({ ...developerOrgKey(who), orgId, role: current });
  }
  member();
  for (const orgId of [A, B]) db.set({ ...orgMetaKey(orgId), orgId });
    const deps: DeveloperRouteDependencies = {
    documentClient: db, tableName: "state", now: () => Date.parse("2026-10-27T18:00:00Z"),
    developer: { issuer: "https://cell.example/v1/auth", env: "test", signInTableName: "signin", methods: { cloud: true, slack: false, oidc: false }, verifyAccessToken: async () => ({}), channelMembers: async () => ({ ok: true, memberOf: [] }) },
  };
    const caller: DeveloperCaller = { orgId: A, developerId: who, orgRole: "owner", name: "Person", amr: "cloud", sessionId: "fixture" };
  function record(ceiling: unknown = 23.000001, extra: Record<string, unknown> = {}, orgId = A) {
    db.set({ ...agentGuardrailsKey(orgId), entityType: "AGENT_GUARDRAILS", revision: 1, guardrails: { ...structuredClone(DEFAULT_AGENT_GUARDRAILS), maxPerRunCeilingUsd: ceiling }, ...extra });
  }
  async function call(as = caller, suffix = "") {
    try {
      const body = await routeDeveloperRequest(deps, { method: "GET", path: path + suffix, headers: {}, requestId: "ceiling-read" }, new URL(path + suffix, "https://cell.example"), { caller: as, csrf: "" });
    return { status: body === undefined ? 404 : 200, body: body as Record<string, unknown> | undefined, code: undefined as string | undefined };
    } catch (error) {
      if (!(error instanceof AgentXError)) throw error;
    return { status: errorStatus(error.code), body: undefined, code: error.code, message: error.message };
    }
  }
  function policy(defaultStopMicrousd: unknown = 10_000_000, extra: Record<string, unknown> = {}, orgId = A) {
    db.set({ ...policyKey(orgId), entityType: "ORG_TASK_STOP_POLICY", orgId, revision: 1, policy: { schemaVersion: 1, defaultStopMicrousd }, ...extra });
  }
  function agent(value: unknown = 7.000001, id = custom, extra: Record<string, unknown> = {}) {
    const key = id === builtin ? builtinSettingsKey(A, id) : agentKey(A, id, "META");
    db.set({ ...key, entityType: id === builtin ? "BUILTIN_AGENT_SETTINGS" : "AGENT", ...(id === builtin ? { pinnedVersion: 1 } : { orgId: A, agentId: id, status: "active" }), updatedAt: "2026-10-27T18:00:00.000Z", maxPerRunUsd: value, ...extra });
  }
  async function readAgent(id = custom, as = caller) {
    const resultPath = basePath + id;
    try {
      const body = await routeDeveloperRequest(deps, { method: "GET", path: resultPath, headers: {}, requestId: "agent-limit-read" }, new URL(resultPath, "https://cell.example"), { caller: as, csrf: "" });
      return { status: body === undefined ? 404 : 200, body: body as Record<string, unknown> | undefined };
    } catch (error) {
      if (!(error instanceof AgentXError)) throw error;
      return { status: errorStatus(error.code), body: undefined, message: error.message };
    }
  }
  return { db, deps, caller, member, record, policy, call, agent, readAgent };
}


for (const role of ["owner", "admin", "member", "maintainer", "auditor", "future-role"]) {
  it(`uses live ${role} authority for the agent money layer`, async () => {
    const f = fixture(role);
    f.policy();
    f.agent();
    expect((await f.readAgent()).status).toBe(role === "owner" || role === "admin" ? 200 : 403);
  });
}
it("reads the existing custom agent limit exactly without profile or private content", async () => {
  const f = fixture();
  f.policy();
  f.agent(7.000001, custom, { name: "private agent name", createdBy: who, description: "private description" });
  const result = await f.readAgent();
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ orgId: A, agentId: custom, sourceKind: "custom_agent", agentOverride: { kind: "limited", stopMicrousd: 7_000_001 }, coverage: "agent_override_only", projectOverride: "not_loaded", locks: "not_loaded", calculation: "unavailable", enforcement: "not_connected" });
  const text = JSON.stringify(result.body);
  expect(text.includes("private") || text.includes(who)).toBe(false);
});
it("keeps explicit zero distinct from a confirmed absent custom override", async () => {
  const f = fixture();
  f.policy();
  f.agent(0);
  expect((await f.readAgent()).body?.agentOverride).toEqual({ kind: "limited", stopMicrousd: 0 });
  const raw = { ...f.db.get(agentKey(A, custom, "META")) };
  delete raw.maxPerRunUsd;
  f.db.set(raw);
  expect((await f.readAgent()).body?.agentOverride).toEqual({ kind: "inherit" });
  f.db.delete(agentKey(A, custom, "META"));
  expect((await f.readAgent()).status).toBe(503);
});
it("only infers builtin inheritance after confirmed settings absence and never creates its settings", async () => {
  const f = fixture();
  f.policy();
  const absent = await f.readAgent(builtin);
  expect(absent.status).toBe(200);
  expect(absent.body).toMatchObject({ sourceKind: "builtin_absent", agentOverride: { kind: "inherit" } });
  expect(f.db.get(builtinSettingsKey(A, builtin))).toBeUndefined();
  f.agent(1, builtin);
  expect((await f.readAgent(builtin)).body).toMatchObject({ sourceKind: "builtin_settings", agentOverride: { kind: "limited", stopMicrousd: 1_000_000 } });
});
for (const value of [undefined, null, -1, 0.0000001, 0.30000000000000004, NaN, Infinity, "7", 1000000.000001]) {
  it(`refuses a present corrupt agent limit ${String(value)} instead of inheriting`, async () => {
    const f = fixture();
    f.policy();
    f.agent(1, custom, { maxPerRunUsd: value });
    expect((await f.readAgent()).status).toBe(503);
  });
}
for (const [name, extra] of [["foreign org", { orgId: B }], ["foreign agent", { agentId: "agt_bbbbbbbbbbbbbbbbbbbb" }], ["wrong entity", { entityType: "OTHER" }], ["unknown status", { status: "unknown" }], ["missing timestamp", { updatedAt: undefined }]] as const) {
  it(`refuses a custom agent source with ${name}`, async () => {
    const f = fixture();
    f.policy();
    f.agent(1, custom, extra);
    expect((await f.readAgent()).status).toBe(503);
  });
}
it("refuses corrupt builtin settings rather than defaulting", async () => {
  const f = fixture();
  f.policy();
  f.agent(1, builtin, { pinnedVersion: 0 });
  expect((await f.readAgent(builtin)).status).toBe(503);
});
it("keeps a failed builtin settings read unavailable and private", async () => {
  const f = fixture();
  f.policy();
  const send = f.db.send.bind(f.db);
  f.db.send = async command => {
    const key = (command.input as { Key?: { pk?: string; sk?: string } }).Key;
    if (key?.pk === builtinSettingsKey(A, builtin).pk && key.sk === builtin) throw new Error("private source failure");
    return send(command);
  };
  const result = await f.readAgent(builtin);
  expect(result.status).toBe(503);
  expect(JSON.stringify(result).includes("private source failure")).toBe(false);
});
it("refuses live role loss after reading the agent source", async () => {
  const f = fixture("owner", true);
  f.policy();
  f.agent();
  const send = f.db.send.bind(f.db);
  f.db.send = async command => {
    const result = await send(command);
    const key = (command.input as { Key?: { pk?: string; sk?: string } }).Key;
    if (key?.pk === agentKey(A, custom, "META").pk && key.sk === "META") {
      await send(new TransactWriteCommand({ TransactItems: [orgMemberKey(A, who), developerOrgKey(who)].map(Key => ({ Update: { TableName: "state", Key, UpdateExpression: "SET #role = :role", ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":role": "member" } } })) }));
    }
    return result;
  };
  expect((await f.readAgent()).status).toBe(403);
});
it("refuses changed company policy across the agent read", async () => {
  const f = fixture();
  f.policy();
  f.agent();
  const send = f.db.send.bind(f.db);
  f.db.send = async command => {
    const result = await send(command);
    const key = (command.input as { Key?: { pk?: string; sk?: string } }).Key;
    if (key?.pk === agentKey(A, custom, "META").pk && key.sk === "META") f.policy(20_000_000, { revision: 2 });
    return result;
  };
  expect((await f.readAgent()).status).toBe(503);
});
it("uses consistent reads only with no agent initialization, audit or policy write", async () => {
  const f = fixture();
  f.policy();
  f.agent();
  const send = f.db.send.bind(f.db);
  let count = 0;
  f.db.send = async command => {
    expect(command.constructor.name).toBe("GetCommand");
    expect((command.input as { ConsistentRead?: boolean }).ConsistentRead).toBe(true);
    count += 1;
    return send(command);
  };
  expect((await f.readAgent()).status).toBe(200);
  expect(count).toBe(31);
});
it("refuses a malformed agent id before any state read", async () => {
  const f = fixture();
  expect((await f.readAgent("not-an-agent")).status).toBe(400);
  expect(f.db.commandNames().length).toBe(0);
});
it("exports a strict partial agent-layer DTO without readiness claims", async () => {
  const f = fixture();
  f.policy();
  f.agent();
  const result = await f.readAgent();
  const schema = (Web as unknown as Record<string, { safeParse(value: unknown): { success: boolean } }>).TaskStopAgentReadSchema;
  expect(schema).toBeDefined();
  if (schema === undefined) throw new Error("Agent read schema export is missing");
  expect(schema.safeParse(result.body).success).toBe(true);
  for (const extra of [{ locks: "unlocked" }, { calculation: "resolved" }, { paidStartAllowed: true }, { sourceKind: "builtin_absent", agentOverride: { kind: "limited", stopMicrousd: 0 } }]) {
    expect(schema.safeParse({ ...result.body, ...extra }).success).toBe(false);
  }
});
