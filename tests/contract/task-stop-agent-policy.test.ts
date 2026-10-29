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

it("keeps agent limits in the request org across query spoofing and a live org move", async () => {
  const f = fixture();
  f.policy();
  f.policy(10_000_000, {}, B);
  f.agent(1);
  f.db.set({ ...f.db.get(agentKey(A, custom, "META")), ...agentKey(B, custom, "META"), orgId: B, maxPerRunUsd: 2 });
  expect((await f.readAgent(custom + "?orgId=" + B)).body?.agentOverride).toEqual({ kind: "limited", stopMicrousd: 1_000_000 });
  const first = await f.readAgent();
  f.member(B, "owner");
  expect((await f.readAgent()).status).toBe(403);
  const second = await f.readAgent(custom, { ...f.caller, orgId: B });
  expect(second.body?.agentOverride).toEqual({ kind: "limited", stopMicrousd: 2_000_000 });
  expect(second.body?.sourceDigest === first.body?.sourceDigest).toBe(false);
});
it("reads an actually committed agent limit instead of an eventual prior value", async () => {
  const f = fixture("owner", true);
  f.policy();
  f.agent(1);
  await f.db.send(new TransactWriteCommand({ TransactItems: [{ Update: { TableName: "state", Key: agentKey(A, custom, "META"), UpdateExpression: "SET #amount = :amount", ExpressionAttributeNames: { "#amount": "maxPerRunUsd" }, ExpressionAttributeValues: { ":amount": 2 } } }] }));
  expect((await f.readAgent()).body?.agentOverride).toEqual({ kind: "limited", stopMicrousd: 2_000_000 });
});
it("binds source digest to amount and timestamp instead of read time", async () => {
  const f = fixture();
  f.policy();
  f.agent(1);
  const first = await f.readAgent();
  f.deps.now = () => Date.parse("2026-10-27T19:00:00Z");
  expect((await f.readAgent()).body?.sourceDigest).toBe(first.body?.sourceDigest);
  f.agent(2);
  const second = await f.readAgent();
  expect(second.body?.sourceDigest === first.body?.sourceDigest).toBe(false);
  f.agent(2, custom, { updatedAt: "2026-10-27T18:01:00.000Z" });
  expect((await f.readAgent()).body?.sourceDigest === second.body?.sourceDigest).toBe(false);
});
for (const [name, extra] of [["foreign org", { orgId: B }], ["foreign agent", { agentId: custom }], ["wrong entity", { entityType: "OTHER" }], ["missing timestamp", { updatedAt: undefined }], ["unsafe pin", { pinnedVersion: Number.MAX_SAFE_INTEGER + 1 }]] as const) {
  it(`refuses builtin settings with ${name}`, async () => {
    const f = fixture();
    f.policy();
    f.agent(1, builtin, extra);
    expect((await f.readAgent(builtin)).status).toBe(503);
  });
}
for (const method of ["POST", "PUT", "DELETE"]) {
  it(`does not add a ${method} agent policy writer`, async () => {
    const f = fixture();
    let status: number;
    try {
      const result = await routeDeveloperRequest(f.deps, { method, path, headers: {}, requestId: "no-agent-money-write", body: "{}" }, new URL(path, "https://cell.example"), { caller: f.caller, csrf: "" });
      status = result === undefined ? 404 : 200;
    } catch (error) {
      if (!(error instanceof AgentXError)) throw error;
      status = errorStatus(error.code);
    }
    expect(status).toBe(404);
    expect(f.db.commandNames().length).toBe(0);
  });
}

it("refuses a source returned under another org key even when its body claims this org", async () => {
  const f = fixture();
  f.policy();
  f.agent();
  const send = f.db.send.bind(f.db);
  f.db.send = async command => {
    const result = await send(command);
    const key = (command.input as { Key?: { pk?: string; sk?: string } }).Key;
    if (key?.pk === agentKey(A, custom, "META").pk && key.sk === "META") return { Item: { ...f.db.get(agentKey(A, custom, "META")), pk: agentKey(B, custom, "META").pk } };
    return result;
  };
  expect((await f.readAgent()).status).toBe(503);
});

it("attributes a missing configured company default to the company source, not an unknown agent limit", async () => {
  const f = fixture();
  f.agent(7);
  const result = await f.readAgent();
  expect(result.status).toBe(503);
  expect(result.message?.startsWith("RUNTIME_UNAVAILABLE: Company task-stop settings could not be checked.")).toBe(true);
});
it("keeps present builtin settings without an amount as builtin_settings inheritance", async () => {
  const f = fixture();
  f.policy();
  f.agent(1, builtin);
  const raw = { ...f.db.get(builtinSettingsKey(A, builtin)) };
  delete raw.maxPerRunUsd;
  f.db.set(raw);
  const result = await f.readAgent(builtin);
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ sourceKind: "builtin_settings", agentOverride: { kind: "inherit" } });
});
for (const row of ["member", "pointer"] as const) {
  it(`refuses an agent policy actor whose ${row} row was revoked`, async () => {
    const f = fixture();
    f.policy();
    f.agent();
    f.db.delete(row === "member" ? orgMemberKey(A, who) : developerOrgKey(who));
    expect((await f.readAgent()).status).toBe(403);
  });
}
it("reports a stored150 override as a partial source rather than the effective100 stop", async () => {
  const f = fixture();
  f.policy();
  f.record(100);
  f.agent(150);
  const result = await f.readAgent();
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ agentOverride: { kind: "limited", stopMicrousd: 150_000_000 }, coverage: "agent_override_only", calculation: "unavailable", enforcement: "not_connected" });
  expect(Object.hasOwn(result.body!, "effectiveStopMicrousd")).toBe(false);
});
