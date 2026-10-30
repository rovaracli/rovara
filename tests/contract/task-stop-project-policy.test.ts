import * as Web from "../../packages/contracts/src/web.js";
import { expect, it } from "vitest";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { AgentXError, errorStatus, agentGuardrailsKey, orgMemberKey, orgMetaKey, developerOrgKey, DEFAULT_AGENT_GUARDRAILS, orgProjectCatalogKey, projectAiKey, projectMetaKey } from "@agentx/contracts";
import { routeDeveloperRequest, type DeveloperCaller, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";
const who = "a".repeat(64);
const path = "/v1/app/org/task-stop-policy/projects/web";
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
  function catalog(extra: Record<string, unknown> = {}, orgId = A) {
    db.set({ ...orgProjectCatalogKey(orgId, "web"), entityType: "PROJECT_CATALOG", name: "web", latestRevision: 1, ...extra });
  }
  function ai(extra: Record<string, unknown> = {}, orgId = A) {
    db.set({ ...projectAiKey(orgId, "web"), entityType: "PROJECT_AI", revision: 1, projectPays: false, ...extra });
  }
  policy(); catalog();
  return { db, deps, caller, member, record, policy, call, catalog, ai };

}

for (const role of ["owner", "admin", "member", "maintainer", "viewer", "auditor", "unknown"]) {
  it(`uses live ${role} authority for the project money source`, async () => {
    const f = fixture(role);
    expect((await f.call()).status).toBe(["owner", "admin"].includes(role) ? 200 : 403);
  });
}
it("distinguishes verified absent settings, present inheritance and explicit zero", async () => {
  const f = fixture();
  expect(await f.call()).toMatchObject({ status: 200, body: { projectOverride: { kind: "inherit" }, sourceKind: "project_settings_absent", settingsRevision: 0 } });
  f.ai();
  expect(await f.call()).toMatchObject({ status: 200, body: { projectOverride: { kind: "inherit" }, sourceKind: "project_ai", settingsRevision: 1 } });
  f.ai({ taskStopPolicy: { schemaVersion: 1, stopMicrousd: 0 } });
  expect(await f.call()).toMatchObject({ status: 200, body: { projectOverride: { kind: "limited", stopMicrousd: 0 } } });
});
it("reads exact stored micros with honest incomplete coverage and no unrelated metadata", async () => {
  const f = fixture();
  f.ai({ taskStopPolicy: { schemaVersion: 1, stopMicrousd: 150_000_001 }, monthlyBudgetUsd: 500, updatedBy: who, privateFixture: "private settings" });
  const result = await f.call();
  expect(result).toMatchObject({ status: 200, body: { orgId: A, project: "web", catalogRevision: 1, settingsRevision: 1, projectOverride: { kind: "limited", stopMicrousd: 150_000_001 }, coverage: "project_override_only", agentOverride: "not_loaded", locks: "not_loaded", projectLifecycle: "not_loaded", calculation: "unavailable", enforcement: "not_connected" } });
  const text = JSON.stringify(result.body);
  expect(text.includes(who) || text.includes("private settings") || text.includes("monthlyBudget") || text.includes("sourceOrder")).toBe(false);
  expect(f.db.transactions()).toHaveLength(0);
});
for (const [name, extra] of [
  ["entity", { entityType: "OTHER" }], ["name", { name: "other" }], ["org", { orgId: B }],
  ["missing revision", { latestRevision: undefined }], ["unsafe revision", { latestRevision: Number.MAX_SAFE_INTEGER + 1 }], ["zero revision", { latestRevision: 0 }],
] as const) it(`refuses invalid catalog ${name}`, async () => {
  const f = fixture(); f.catalog(extra); expect((await f.call()).status).toBe(503);
});
for (const [name, extra] of [
  ["entity", { entityType: "OTHER" }], ["project", { project: "other" }], ["org", { orgId: B }],
  ["unsafe revision", { revision: Number.MAX_SAFE_INTEGER + 1 }], ["zero revision", { revision: 0 }], ["missing revision", { revision: undefined }],
] as const) it(`refuses invalid AI metadata ${name}`, async () => {
  const f = fixture(); f.ai(extra); expect((await f.call()).status).toBe(503);
});
for (const taskStopPolicy of [undefined, null, {}, { schemaVersion: 1 }, { schemaVersion: 2, stopMicrousd: 0 }, { schemaVersion: 1, stopMicrousd: .1 }, { schemaVersion: 1, stopMicrousd: 0, ceilingMicrousd: 0 }]) {
  it("shares the canonical actionable malformed-stop refusal", async () => {
    const f = fixture(); f.ai({ taskStopPolicy });
    expect(await f.call()).toMatchObject({ status: 400, code: "CONFIG_INVALID", message: "CONFIG_INVALID: The per-task stop for project web is invalid. Ask an org owner or admin to fix it before starting work." });
  });
}
it("keeps canonical full settings validation", async () => {
  const f = fixture(); f.ai({ projectPays: "yes" }); expect((await f.call()).status).toBe(400);
});
for (const target of ["catalog", "ai"]) for (const fault of ["missing", "misbound", "fault"]) {
  it(`never treats ${target} ${fault} as confirmed inheritance`, async () => {
    const f = fixture(); f.ai(); const send = f.db.send.bind(f.db);
    const wanted = target === "catalog" ? orgProjectCatalogKey(A, "web") : projectAiKey(A, "web");
    f.db.send = async command => {
      const key = (command.input as { Key?: { pk?: string; sk?: string } }).Key;
      if (key?.pk === wanted.pk && key.sk === wanted.sk) {
        if (fault === "fault") throw new Error("private source failure");
        if (fault === "missing") return {};
        return { Item: { ...f.db.get(wanted), pk: "foreign" } };
      }
      return send(command);
    };
    const result = await f.call();
    expect(result.status).toBe(target === "ai" && fault === "missing" ? 200 : 503);
    expect(JSON.stringify(result).includes("private source failure")).toBe(false);
  });
}
for (const change of ["demotion", "catalog", "company"]) it(`refuses ${change} after the AI read`, async () => {
  const f = fixture("owner", true); f.ai(); const send = f.db.send.bind(f.db);
  f.db.send = async command => {
    const result = await send(command);
    const key = (command.input as { Key?: { pk?: string; sk?: string } }).Key;
    if (key?.pk === projectAiKey(A, "web").pk) {
      if (change === "catalog") f.catalog({ latestRevision: 2 });
      else if (change === "company") f.policy(1);
      else await send(new TransactWriteCommand({ TransactItems: [orgMemberKey(A, who), developerOrgKey(who)].map(Key => ({ Update: { TableName: "state", Key, UpdateExpression: "SET #role = :role", ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":role": "member" } } })) }));
    }
    return result;
  };
  expect((await f.call()).status).toBe(change === "demotion" ? 403 : 503);
});
it("binds query spoofing and current-org moves to live authority", async () => {
  const f = fixture(); f.ai({ taskStopPolicy: { schemaVersion: 1, stopMicrousd: 1 } });
  expect((await f.call(f.caller, "?orgId=" + B)).body?.orgId).toBe(A);
  f.member(B); expect((await f.call()).status).toBe(403);
  f.policy(1, {}, B); f.catalog({}, B); f.ai({ taskStopPolicy: { schemaVersion: 1, stopMicrousd: 2 } }, B);
  expect((await f.call({ ...f.caller, orgId: B })).body?.projectOverride).toEqual({ kind: "limited", stopMicrousd: 2 });
});
it("binds source fingerprint to scope, values and both revisions, not read time", async () => {
  const f = fixture(); f.ai({ taskStopPolicy: { schemaVersion: 1, stopMicrousd: 1 } });
  let previous = (await f.call()).body?.sourceDigest; expect(typeof previous).toBe("string");
  f.deps.now = () => Date.parse("2026-10-28T00:00:00Z"); expect((await f.call()).body?.sourceDigest).toBe(previous);
  for (const [stopMicrousd, revision, latestRevision] of [[2, 1, 1], [2, 2, 1], [2, 2, 2]]) {
    f.ai({ taskStopPolicy: { schemaVersion: 1, stopMicrousd }, revision }); f.catalog({ latestRevision });
    const next = (await f.call()).body?.sourceDigest; expect(typeof next).toBe("string"); expect(next === previous).toBe(false); previous = next;
  }
});
it("uses 33 consistent Get operations and no initialization or writes", async () => {
  const f = fixture(); const send = f.db.send.bind(f.db); let count = 0;
  f.db.send = async command => { expect(command.constructor.name).toBe("GetCommand"); expect((command.input as { ConsistentRead?: boolean }).ConsistentRead).toBe(true); count++; return send(command); };
  expect((await f.call()).status).toBe(200); expect(count).toBe(33);
});
it("publishes a strict partial DTO without start permission or implicit locks/lifecycle", async () => {
  const f = fixture(); const result = await f.call(); expect(result.status).toBe(200);
  const schema = (Web as unknown as Record<string, { safeParse(value: unknown): { success: boolean } }>).TaskStopProjectReadSchema;
  expect(schema).toBeDefined(); if (schema === undefined) throw new Error("Missing project schema");
  expect(schema.safeParse(result.body).success).toBe(true);
  for (const extra of [{ enforcement: "active" }, { locks: "unlocked" }, { projectLifecycle: "active" }, { calculation: "resolved" }, { paidStartAllowed: true }, { settingsRevision: 1 }]) expect(schema.safeParse({ ...result.body, ...extra }).success).toBe(false);
});
for (const method of ["POST", "PUT", "DELETE"]) it(`has no project ${method} setter`, async () => {
  const f = fixture();
  try { expect(await routeDeveloperRequest(f.deps, { method, path, headers: {}, requestId: "no-write", body: "{}" }, new URL(path, "https://cell.example"), { caller: f.caller, csrf: "" })).toBeUndefined(); }
  catch (error) { if (!(error instanceof AgentXError)) throw error; expect(errorStatus(error.code)).toBe(404); }
  expect(f.db.commandNames()).toHaveLength(0);
});

it("reads an actually committed AI revision instead of its eventual prior version", async () => {
  const f = fixture("owner", true); f.ai({ taskStopPolicy: { schemaVersion: 1, stopMicrousd: 1 } });
  await f.db.send(new TransactWriteCommand({ TransactItems: [{ Update: { TableName: "state", Key: projectAiKey(A, "web"), UpdateExpression: "SET #policy = :policy, #rev = :rev", ExpressionAttributeNames: { "#policy": "taskStopPolicy", "#rev": "revision" }, ExpressionAttributeValues: { ":policy": { schemaVersion: 1, stopMicrousd: 2 }, ":rev": 2 } } }] }));
  expect(await f.call()).toMatchObject({ status: 200, body: { settingsRevision: 2, projectOverride: { kind: "limited", stopMicrousd: 2 } } });
});
it("uses live owner membership despite a cached member role", async () => {
  const f = fixture(); expect((await f.call({ ...f.caller, orgRole: "member" })).status).toBe(200);
});
it("retains the company-settings cause when the configured default is absent", async () => {
  const f = fixture();
  const send = f.db.send.bind(f.db);
  f.db.send = command => {
    const key = (command.input as { Key?: { pk?: string; sk?: string } }).Key;
    if (key?.pk === policyKey().pk && key.sk === policyKey().sk) return Promise.resolve({});
    return send(command);
  };
  const result = await f.call(); expect(result.status).toBe(503);
  expect(result.message?.includes("Company task-stop settings could not be checked.")).toBe(true);
});
it("rejects an invalid project name before any state reads", async () => {
  const f = fixture();
  try { await routeDeveloperRequest(f.deps, { method: "GET", path: path.replace("/web", "/Bad"), headers: {}, requestId: "invalid-project" }, new URL(path.replace("/web", "/Bad"), "https://cell.example"), { caller: f.caller, csrf: "" }); throw new Error("Expected refusal"); }
  catch (error) { if (!(error instanceof AgentXError)) throw error; expect(errorStatus(error.code)).toBe(400); }
  expect(f.db.commandNames()).toHaveLength(0);
});

for (const row of ["member", "pointer"]) {
  it(`refuses a project policy actor whose ${row} row was revoked`, async () => {
    const f = fixture(); f.ai({ taskStopPolicy: { schemaVersion: 1, stopMicrousd: 1 } });
    expect((await f.call()).status).toBe(200);
    f.db.delete(row === "member" ? orgMemberKey(A, who) : developerOrgKey(who));
    expect((await f.call()).status).toBe(403);
    expect(f.db.transactions()).toHaveLength(0);
  });
}
it("keeps an archived project's source readable without claiming lifecycle or start readiness", async () => {
  const f = fixture(); f.ai({ taskStopPolicy: { schemaVersion: 1, stopMicrousd: 1 } });
  f.db.set({ ...projectMetaKey(A, "web"), entityType: "PROJECT_META", name: "web", status: "archived" });
  const result = await f.call(); expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ projectLifecycle: "not_loaded", locks: "not_loaded", calculation: "unavailable", enforcement: "not_connected" });
  expect(Object.hasOwn(result.body!, "paidStartAllowed") || Object.hasOwn(result.body!, "effectiveStopMicrousd")).toBe(false);
});
it("refuses unsupported locks on the default-only company source instead of assuming unlocked", async () => {
  const f = fixture(); f.policy(1, { policy: { schemaVersion: 1, defaultStopMicrousd: 1, locks: { project: false, agent: false } } });
  expect((await f.call()).status).toBe(503);
});

it("reads explicit project inheritance under a seeded typed company estimate", async () => {
  const f = fixture();
  f.policy(0, { policy: { schemaVersion: 2, defaultPolicy: { kind: "rovara_estimate" } } });
  f.ai({ taskStopPolicy: { schemaVersion: 2, kind: "inherit" } });
  expect(await f.call()).toMatchObject({ status: 200, body: { projectOverride: { kind: "inherit" }, sourceKind: "project_ai", settingsRevision: 1, calculation: "unavailable", enforcement: "not_connected" } });
  expect(f.db.transactions()).toHaveLength(0);
});
