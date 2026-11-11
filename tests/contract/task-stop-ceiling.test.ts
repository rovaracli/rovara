import { TaskStopCeilingReadSchema, calculateTaskStop } from "@agentx/cloud-contracts/web";
import { expect, it } from "vitest";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { AgentXError, errorStatus, agentGuardrailsKey, DEFAULT_AGENT_GUARDRAILS } from "@rovara-code/contracts";
import { orgMemberKey, orgMetaKey, developerOrgKey } from "@agentx/cloud-contracts";
import { routeDeveloperRequest, type DeveloperCaller, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
    const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";
    const who = "a".repeat(64), other = "b".repeat(64);
    const path = "/v1/app/org/task-stop-ceiling";
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
  return { db, deps, caller, member, record, call };
}
for (const role of ["owner", "admin", "member", "maintainer", "viewer", "auditor", "future-role"]) {
  it(`uses live ${role} authority for the company ceiling`, async () => {
    const f = fixture(role);
    expect((await f.call()).status).toBe(role === "owner" || role === "admin" ? 200 : 403);
  });
}
it("does not use a cached member role to refuse a live owner", async () => {
  const f = fixture();
    expect((await f.call({ ...f.caller, orgRole: "member" })).status).toBe(200);
});
it("reads the existing default ceiling only after confirmed record absence and leaves other scopes not loaded", async () => {
  const f = fixture(), result = await f.call();
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ orgId: A, checkedAt: "2026-10-27T18:00:00.000Z", ceilingMicrousd: 100_000_000, revision: 0, source: "rovara_default", backing: "legacy_guardrails_alias", coverage: "company_ceiling_only", companyDefault: "not_loaded", projectOverride: "not_loaded", agentOverride: "not_loaded", locks: "not_loaded", calculation: "unavailable", enforcement: "not_connected" });
    expect(typeof result.body?.ceilingDigest === "string" && /^[a-f0-9]{64}$/.test(result.body.ceilingDigest)).toBe(true);
    expect(f.db.transactions().length).toBe(0);
});
it("projects an exact configured ceiling and explicit zero without exposing its source document", async () => {
  const f = fixture();
    f.record(23.000001, { updatedBy: who, privateFixture: "private source metadata" });
    const first = await f.call();
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ceilingMicrousd: 23_000_001, source: "configured", revision: 1 });
    const text = JSON.stringify(first.body);
    expect(text.includes(who) || text.includes("private source metadata") || text.includes("forbiddenModels")).toBe(false);
    expect(Object.hasOwn(first.body!, "guardrails")).toBe(false);
    f.record(-0);
    expect((await f.call()).body?.ceilingMicrousd).toBe(0);
});
for (const bad of [-1, 0.0000001, 0.30000000000000004, NaN, Infinity, 1_000_000.000001, null, "100"]) {
  it(`refuses a corrupt ceiling (${String(bad)}) rather than a default`, async () => {
    const f = fixture();
    f.record(bad);
    expect((await f.call()).status).toBe(503);
  });
}
for (const [name, extra] of [
  ["zero revision", { revision: 0 }],
  ["negative revision", { revision: -1 }],
  ["fractional revision", { revision: 1.5 }],
  ["unsafe revision", { revision: Number.MAX_SAFE_INTEGER + 1 }],
  ["foreign org", { orgId: B }],
  ["wrong entity", { entityType: "OTHER" }],
  ["shadow ceiling", { ceilingMicrousd: 0 }],
  ["unknown autonomy", { guardrails: { ...structuredClone(DEFAULT_AGENT_GUARDRAILS), maxAutonomy: "unknown" } }],
] as const) {
  it(`refuses a legacy record with ${name}`, async () => {
    const f = fixture();
    f.record(23, extra);
    expect((await f.call()).status).toBe(503);
  });
}
for (const row of ["member", "pointer"] as const) {
  it(`refuses a deleted actor ${row} row`, async () => {
    const f = fixture();
    f.db.delete(row === "member" ? orgMemberKey(A, who) : developerOrgKey(who));
    expect((await f.call()).status).toBe(403);
  });
}
for (const field of ["closingAt", "closedAt", "member-person", "member-org", "pointer-org", "pointer-role", "org-binding"] as const) {
  it(`refuses stale or corrupt ${field} authority`, async () => {
    const f = fixture();
    if (field === "closingAt" || field === "closedAt") f.db.set({ ...f.db.get(orgMetaKey(A)), [field]: "2026-10-27T18:00:00Z" });
    else if (field === "member-person" || field === "member-org") f.db.set({ ...f.db.get(orgMemberKey(A, who)), ...(field === "member-person" ? { developerId: other } : { orgId: B }) });
    else if (field === "org-binding") f.db.set({ ...f.db.get(orgMetaKey(A)), orgId: B });
    else f.db.set({ ...developerOrgKey(who), orgId: field === "pointer-org" ? B : A, role: field === "pointer-role" ? "member" : "owner" });
    expect((await f.call()).status).toBe(403);
  });
}
it("ignores a query org and keeps the one ceiling and digest bound to the request's org", async () => {
  const f = fixture();
    f.record(7, {}, B);
    const first = await f.call(f.caller, "?orgId=" + B);
    expect(first.body?.ceilingMicrousd).toBe(100_000_000);
    f.member(B, "owner");
    expect((await f.call()).status).toBe(403);
    const second = await f.call({ ...f.caller, orgId: B });
    expect(second.body?.ceilingMicrousd).toBe(7_000_000);
    expect(second.body?.ceilingDigest === first.body?.ceilingDigest).toBe(false);
});
it("changes the version digest for changed value/revision, not read time", async () => {
  const f = fixture();
    f.record(23);
    const first = await f.call();
    f.deps.now = () => Date.parse("2026-10-27T18:01:00Z");
    expect((await f.call()).body?.ceilingDigest).toBe(first.body?.ceilingDigest);
    f.record(24);
    const second = await f.call();
    expect(second.body?.ceilingDigest === first.body?.ceilingDigest).toBe(false);
    f.record(24, { revision: 2 });
    expect((await f.call()).body?.ceilingDigest === second.body?.ceilingDigest).toBe(false);
});
it("only sends seven consistent reads without a proxy, source sync, counter or audit write", async () => {
  const f = fixture(), send = f.db.send.bind(f.db);
    let count = 0;
    f.db.send = async command => {
    expect(command.constructor.name).toBe("GetCommand");
    expect((command.input as { ConsistentRead?: boolean }).ConsistentRead).toBe(true);
    count += 1;
    return send(command);
  };
    expect((await f.call()).status).toBe(200);
    expect(count).toBe(7);
});
it("refuses actual post-read demotion even with eventual prior authority available", async () => {
  const f = fixture("owner", true), send = f.db.send.bind(f.db);
    let changed = false;
    f.record();
    f.db.send = async command => {
    const result = await send(command), key = (command.input as { Key?: { pk?: string; sk?: string } }).Key;
    if (!changed && key?.pk === agentGuardrailsKey(A).pk && key.sk === agentGuardrailsKey(A).sk) {
      changed = true;
      await send(new TransactWriteCommand({ TransactItems: [orgMemberKey(A, who), developerOrgKey(who)].map(Key => ({ Update: { TableName: "state", Key, UpdateExpression: "SET #role = :role", ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":role": "member" } } })) }));
    }
    return result;
  };
    expect((await f.call()).status).toBe(403);
    expect(changed).toBe(true);
});
it("keeps storage failure unavailable with fixed copy instead of assuming absence", async () => {
  const f = fixture();
    f.db.injectFault({ command: "GetCommand", error: { name: "ServiceUnavailable", message: "private source failure" } });
    const result = await f.call();
    expect(result.status).toBe(503);
    expect(JSON.stringify(result).includes("private source failure")).toBe(false);
});
for (const scope of ["member", "pointer", "org", "ceiling"] as const) {
  it(`refuses a misbound ${scope} read response`, async () => {
    const f = fixture();
    f.record();
    const key = scope === "member" ? orgMemberKey(A, who) : scope === "pointer" ? developerOrgKey(who) : scope === "org" ? orgMetaKey(A) : agentGuardrailsKey(A);
    const send = f.db.send.bind(f.db);
    f.db.send = async command => {
      const result = await send(command), asked = (command.input as { Key?: { pk?: string; sk?: string } }).Key;
    return asked?.pk === key.pk && asked.sk === key.sk ? { Item: { ...f.db.get(key), pk: "OTHER" } } : result;
    };
    expect((await f.call()).status).toBe(scope === "ceiling" ? 503 : 403);
  });
}

it("keeps the narrow browser DTO honest about unknown policy layers", async () => {
  const f = fixture(), result = await f.call();
    expect(TaskStopCeilingReadSchema.safeParse(result.body).success).toBe(true);
  for (const extra of [{ companyDefault: "inherit" }, { locks: "unlocked" }, { calculation: "resolved" }, { enforcement: "active" }, { source: "configured", revision: 0 }, { revision: 1 }, { source: "rovara_default", ceilingMicrousd: 1 }, { paidStartAllowed: true }]) {
    expect(TaskStopCeilingReadSchema.safeParse({ ...result.body, ...extra }).success).toBe(false);
  }
});
it("binds the digest to org even for identical configured values and revisions", async () => {
  const f = fixture();
    f.record(23);
    f.record(23, {}, B);
    const first = await f.call();
    f.member(B, "owner");
    const second = await f.call({ ...f.caller, orgId: B });
    expect(first.body?.ceilingMicrousd).toBe(second.body?.ceilingMicrousd);
    expect(first.body?.revision).toBe(second.body?.revision);
    expect(first.body?.ceilingDigest === second.body?.ceilingDigest).toBe(false);
});
it("does not mistake an unavailable ceiling read for record absence after valid authority", async () => {
  const f = fixture(), send = f.db.send.bind(f.db);
    f.db.send = async command => {
    const key = (command.input as { Key?: { pk?: string; sk?: string } }).Key;
    if (key?.pk === agentGuardrailsKey(A).pk && key.sk === agentGuardrailsKey(A).sk) throw new Error("private source failure");
    return send(command);
  };
    const result = await f.call();
    expect(result.status).toBe(503);
    expect(JSON.stringify(result).includes("private source failure")).toBe(false);
});

it("does not turn the partial ceiling response into a complete calculation", async () => {
  const f = fixture(), result = await f.call();
    expect(calculateTaskStop(result.body)).toEqual({ kind: "unavailable", reason: "INVALID_OR_MISSING_POLICY", enforcement: "not_connected" });
});
for (const method of ["POST", "PUT", "DELETE"]) {
  it(`does not expose a ${method} writer at the read-only ceiling route`, async () => {
    const f = fixture();
    let status: number;
    try {
      const value = await routeDeveloperRequest(f.deps, { method, path, headers: {}, requestId: "no-ceiling-write", body: JSON.stringify({ ceilingMicrousd: 0 }) }, new URL(path, "https://cell.example"), { caller: f.caller, csrf: "" });
      status = value === undefined ? 404 : 200;
    } catch (error) {
      if (!(error instanceof AgentXError)) throw error;
      status = errorStatus(error.code);
    }
    expect(status).toBe(404);
    expect(f.db.get(agentGuardrailsKey(A))).toBeUndefined();
    expect(f.db.transactions().length).toBe(0);
  });
}
for (const caller of [{ orgId: "bad" }, { developerId: "bad" }]) {
  it(`refuses malformed caller ${Object.keys(caller)[0]} before state reads`, async () => {
    const f = fixture();
    expect((await f.call({ ...f.caller, ...caller })).status).toBe(403);
    expect(f.db.commandNames().length).toBe(0);
  });
}

it("refuses a present source whose ceiling key is missing instead of inventing a default", async () => {
  const f = fixture();
    const source: Record<string, unknown> = structuredClone(DEFAULT_AGENT_GUARDRAILS);
  delete source.maxPerRunCeilingUsd;
    f.record(23, { guardrails: source });
    expect((await f.call()).status).toBe(503);
});
