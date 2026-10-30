import * as Web from "../../packages/contracts/src/web.js";
import { expect, it } from "vitest";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { AgentXError, errorStatus, agentGuardrailsKey, orgMemberKey, orgMetaKey, developerOrgKey, DEFAULT_AGENT_GUARDRAILS } from "@agentx/contracts";
import { routeDeveloperRequest, type DeveloperCaller, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";
const who = "a".repeat(64);
const path = "/v1/app/org/task-stop-policy";
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
  return { db, deps, caller, member, record, policy, call };
}

for (const role of ["owner", "admin", "member", "maintainer", "viewer", "auditor", "future-role"]) {
  it(`uses live ${role} authority for configured company policy`, async () => {
    const f = fixture(role);
    f.policy();
    expect((await f.call()).status).toBe(role === "owner" || role === "admin" ? 200 : 403);
  });
}
it("reads configured default and the one existing ceiling without claiming scope completeness", async () => {
  const f = fixture();
  f.policy(20_000_001, { updatedBy: who, privateFixture: "private source metadata" });
  f.record(30.000001);
  const result = await f.call();
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ orgId: A, defaultStopMicrousd: 20_000_001, revision: 1, ceilingMicrousd: 30_000_001, ceilingRevision: 1, ceilingSource: "configured", coverage: "company_default_and_ceiling", projectOverride: "not_loaded", agentOverride: "not_loaded", locks: "not_loaded", calculation: "unavailable", enforcement: "not_connected" });
  const text = JSON.stringify(result.body);
  expect(text.includes(who) || text.includes("private source metadata") || text.includes("forbiddenModels")).toBe(false);
  expect(typeof result.body?.policyDigest === "string" && /^[a-f0-9]{64}$/.test(result.body.policyDigest)).toBe(true);
  expect(f.db.transactions().length).toBe(0);
});
it("uses the existing absent-ceiling default but never invents a missing company default", async () => {
  const f = fixture();
  expect((await f.call()).status).toBe(503);
  f.policy(0);
  const result = await f.call();
  expect(result.status).toBe(200);
  expect(result.body?.defaultStopMicrousd).toBe(0);
  expect(result.body?.ceilingMicrousd).toBe(100_000_000);
  expect(result.body?.ceilingRevision).toBe(0);
  expect(result.body?.ceilingSource).toBe("rovara_default");
});
for (const [name, extra] of [
  ["zero revision", { revision: 0 }], ["unsafe revision", { revision: Number.MAX_SAFE_INTEGER + 1 }],
  ["foreign org", { orgId: B }], ["wrong entity", { entityType: "OTHER" }],
  ["second ceiling", { ceilingMicrousd: 0 }], ["legacy ceiling", { maxPerRunCeilingUsd: 0 }],
  ["missing default", { policy: { schemaVersion: 1 } }], ["unknown version", { policy: { schemaVersion: 2, defaultStopMicrousd: 0 } }],
  ["duplicate nested ceiling", { policy: { schemaVersion: 1, defaultStopMicrousd: 0, ceilingMicrousd: 0 } }],
] as const) {
  it(`refuses ${name} in the company policy source`, async () => {
    const f = fixture();
    f.policy(10_000_000, extra);
    expect((await f.call()).status).toBe(503);
  });
}
for (const value of [undefined, null, -1, 0.1, 1_000_000_000_001, "10", NaN, Infinity]) {
  it(`refuses invalid default micros ${String(value)} without fallback`, async () => {
    const f = fixture();
    f.policy(value);
    // The fixture default parameter would substitute undefined, so store it explicitly.
    if (value === undefined) f.policy(1, { policy: { schemaVersion: 1, defaultStopMicrousd: undefined } });
    expect((await f.call()).status).toBe(503);
  });
}
it("keeps the default and digest in the live request org despite query spoofing or an org move", async () => {
  const f = fixture();
  f.policy(1);
  f.policy(2, {}, B);
  const first = await f.call(f.caller, "?orgId=" + B);
  expect(first.body?.defaultStopMicrousd).toBe(1);
  f.member(B, "owner");
  expect((await f.call()).status).toBe(403);
  const second = await f.call({ ...f.caller, orgId: B });
  expect(second.body?.defaultStopMicrousd).toBe(2);
  expect(second.body?.policyDigest === first.body?.policyDigest).toBe(false);
});
it("refuses a misbound policy read and a source fault after valid authority", async () => {
  const f = fixture();
  f.policy();
  const send = f.db.send.bind(f.db);
  let fault = false;
  f.db.send = async command => {
    const key = (command.input as { Key?: { pk?: string; sk?: string } }).Key;
    if (key?.pk === policyKey().pk && key.sk === policyKey().sk) {
      if (fault) throw new Error("private source failure");
      return { Item: { ...f.db.get(policyKey()), pk: policyKey(B).pk } };
    }
    return send(command);
  };
  expect((await f.call()).status).toBe(503);
  fault = true;
  const result = await f.call();
  expect(result.status).toBe(503);
  expect(JSON.stringify(result).includes("private source failure")).toBe(false);
});
it("refuses live demotion committed after reading company defaults", async () => {
  const f = fixture("owner", true);
  f.policy();
  const send = f.db.send.bind(f.db);
  f.db.send = async command => {
    const result = await send(command);
    const key = (command.input as { Key?: { pk?: string; sk?: string } }).Key;
    if (key?.pk === policyKey().pk && key.sk === policyKey().sk) {
      await send(new TransactWriteCommand({ TransactItems: [orgMemberKey(A, who), developerOrgKey(who)].map(Key => ({ Update: { TableName: "state", Key, UpdateExpression: "SET #role = :role", ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":role": "member" } } })) }));
    }
    return result;
  };
  expect((await f.call()).status).toBe(403);
});
it("refuses a changed ceiling across the company default read", async () => {
  const f = fixture();
  f.policy();
  const send = f.db.send.bind(f.db);
  f.db.send = async command => {
    const result = await send(command);
    const key = (command.input as { Key?: { pk?: string; sk?: string } }).Key;
    if (key?.pk === policyKey().pk && key.sk === policyKey().sk) f.record(1);
    return result;
  };
  expect((await f.call()).status).toBe(503);
});
it("binds policy digest to default revision and value instead of read time", async () => {
  const f = fixture();
  f.policy(1);
  const first = await f.call();
  f.deps.now = () => Date.parse("2026-10-27T19:00:00Z");
  expect((await f.call()).body?.policyDigest).toBe(first.body?.policyDigest);
  f.policy(2);
  const second = await f.call();
  expect(second.body?.policyDigest === first.body?.policyDigest).toBe(false);
  f.policy(2, { revision: 2 });
  expect((await f.call()).body?.policyDigest === second.body?.policyDigest).toBe(false);
});
it("uses consistent reads only and never writes a company policy", async () => {
  const f = fixture();
  f.policy();
  const send = f.db.send.bind(f.db);
  let count = 0;
  f.db.send = async command => {
    expect(command.constructor.name).toBe("GetCommand");
    expect((command.input as { ConsistentRead?: boolean }).ConsistentRead).toBe(true);
    count += 1;
    return send(command);
  };
  expect((await f.call()).status).toBe(200);
  expect(count).toBe(15);
});
it("exports a strict browser-safe DTO that cannot claim readiness", async () => {
  const f = fixture();
  f.policy();
  const result = await f.call();
  const schema = (Web as unknown as Record<string, { safeParse(value: unknown): { success: boolean } }>).TaskStopCompanyReadSchema;
  expect(schema).toBeDefined();
  if (schema === undefined) throw new Error("Company read schema export is missing");
  expect(schema.safeParse(result.body).success).toBe(true);
  for (const extra of [{ locks: "unlocked" }, { calculation: "resolved" }, { enforcement: "active" }, { paidStartAllowed: true }]) {
    expect(schema.safeParse({ ...result.body, ...extra }).success).toBe(false);
  }
});
for (const method of ["POST", "PUT", "DELETE"]) {
  it(`does not expose a ${method} policy writer`, async () => {
    const f = fixture();
    let status: number;
    try {
      const result = await routeDeveloperRequest(f.deps, { method, path, headers: {}, requestId: "no-policy-write", body: "{}" }, new URL(path, "https://cell.example"), { caller: f.caller, csrf: "" });
      status = result === undefined ? 404 : 200;
    } catch (error) {
      if (!(error instanceof AgentXError)) throw error;
      status = errorStatus(error.code);
    }
    expect(status).toBe(404);
    expect(f.db.commandNames().length).toBe(0);
  });
}

it("binds identical policy values and revisions to different company digests", async () => {
  const f = fixture();
  f.policy(1);
  f.policy(1, {}, B);
  const first = await f.call();
  f.member(B, "owner");
  const second = await f.call({ ...f.caller, orgId: B });
  expect(first.body?.defaultStopMicrousd).toBe(second.body?.defaultStopMicrousd);
  expect(first.body?.policyDigest === second.body?.policyDigest).toBe(false);
});

it("reads a committed policy revision rather than its eventual prior value", async () => {
  const f = fixture("owner", true);
  f.policy(1);
  await f.db.send(new TransactWriteCommand({ TransactItems: [{ Update: { TableName: "state", Key: policyKey(), UpdateExpression: "SET #policy = :policy, #revision = :revision", ExpressionAttributeNames: { "#policy": "policy", "#revision": "revision" }, ExpressionAttributeValues: { ":policy": { schemaVersion: 1, defaultStopMicrousd: 2 }, ":revision": 2 } } }] }));
  const result = await f.call();
  expect(result.status).toBe(200);
  expect(result.body?.defaultStopMicrousd).toBe(2);
  expect(result.body?.revision).toBe(2);
});

for (const row of ["member", "pointer"] as const) {
  it(`refuses a revoked company policy actor whose ${row} was deleted`, async () => {
    const f = fixture();
    f.policy();
    f.db.delete(row === "member" ? orgMemberKey(A, who) : developerOrgKey(who));
    expect((await f.call()).status).toBe(403);
  });
}
it("exports the canonical ceiling micros constant used by both read DTOs", () => {
  const micros = (Web as unknown as Record<string, unknown>).DEFAULT_MAX_PER_RUN_CEILING_MICROUSD;
  expect(micros).toBe(100_000_000);
});

for (const mode of ["rovara_estimate", "limited"] as const) it(`reads typed company ${mode} without inventing a fixed default`, async () => {
  const f = fixture(); f.record();
  const defaultPolicy = mode === "rovara_estimate" ? { kind: mode } : { kind: mode, stopMicrousd: 1234567 };
  f.policy(0, { policy: { schemaVersion: 2, defaultPolicy }, seedProvenance: { source: "upgrade", reviewRequired: true, seededAt: "2026-10-27T18:00:00.000Z", occurrence: "private-occurrence" } });
  const result = await f.call(); expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ defaultPolicy, seedReview: { source: "upgrade", reviewRequired: true, seededAt: "2026-10-27T18:00:00.000Z" }, calculation: "unavailable", enforcement: "not_connected" });
  expect(result.body).not.toHaveProperty("defaultStopMicrousd");
  expect(JSON.stringify(result.body)).not.toContain("private-occurrence"); expect(f.db.transactions()).toHaveLength(0);
});

for (const [name, extra] of [
  ["unknown mode", { policy: { schemaVersion: 2, defaultPolicy: { kind: "future" } } }],
  ["numeric estimate", { policy: { schemaVersion: 2, defaultPolicy: { kind: "rovara_estimate", stopMicrousd: 10 } } }],
  ["duplicate default", { policy: { schemaVersion: 2, defaultPolicy: { kind: "rovara_estimate" }, defaultStopMicrousd: 10 } }],
  ["fractional micros", { policy: { schemaVersion: 2, defaultPolicy: { kind: "limited", stopMicrousd: 0.1 } } }],
  ["unknown provenance", { seedProvenance: { source: "future", reviewRequired: true, seededAt: "2026-10-27T18:00:00.000Z" } }],
  ["bad review state", { seedProvenance: { source: "upgrade", reviewRequired: "yes", seededAt: "2026-10-27T18:00:00.000Z" } }],
] as const) it(`refuses typed company ${name} without a numeric fallback`, async () => {
  const f = fixture(); f.policy(0, Object.assign({ policy: { schemaVersion: 2, defaultPolicy: { kind: "rovara_estimate" } } }, extra));
  expect((await f.call()).status).toBe(503); expect(f.db.transactions()).toHaveLength(0);
});
it("typed company digest distinguishes estimate and numeric policies while read time is irrelevant", async () => {
  const f = fixture(); f.policy(0, { policy: { schemaVersion: 2, defaultPolicy: { kind: "rovara_estimate" } } });
  const estimate = await f.call(); expect(estimate.status).toBe(200);
  f.deps.now = () => Date.parse("2026-10-27T19:00:00Z"); expect((await f.call()).body?.policyDigest).toBe(estimate.body?.policyDigest);
  f.policy(0, { policy: { schemaVersion: 2, defaultPolicy: { kind: "limited", stopMicrousd: 0 } } });
  const numeric = await f.call(); expect(numeric.status).toBe(200); expect(numeric.body?.policyDigest).not.toBe(estimate.body?.policyDigest);
  expect(Web.TaskStopCompanyReadSchema.safeParse({ ...numeric.body, defaultStopMicrousd: 0 }).success).toBe(false);
  expect(numeric.body).toMatchObject({ defaultPolicy: { kind: "limited", stopMicrousd: 0 } });
});
