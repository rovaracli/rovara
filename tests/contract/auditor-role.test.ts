// Enterprise foundations, task I2: the Auditor role end to end. The audit routes serve it; the route dispatcher holds it to the allow-list; the session
// check refuses it where the edition has no Auditor; the role is given only where the edition has it; and it holds no project role. Every case fails when the
// rule it names is removed (the mutations are listed in the lane report).
import { describe, expect, it } from "vitest";
import { AgentXError } from "@rovara-code/contracts";
import { OrgRoleSchema, developerOrgKey, editionPolicy, orgMemberKey, orgMetaKey, type EditionPolicy, type OrgRole } from "@agentx/cloud-contracts";
import { routeDeveloperRequest, authenticateDeveloper, type DeveloperCaller, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { effectiveProjectRole } from "../../packages/broker/src/developer/project-roles.js";
import { AUDITOR_REFUSED } from "../../packages/broker/src/org/auditor.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { routeAuditRequest, type AuditOrgCaller } from "../../packages/broker/src/audit/routes.js";
import { evaluateGroupMapping, decideSignIn, dynamoGroupMappingStore } from "../../packages/broker/src/developer/group-mapping.js";
import { readTurnActorChecks } from "../../packages/broker/src/model-selection/turn-authority.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { A, B } from "../support/audit-anchor-harness.js";
import { world } from "../support/audit-routes-bench.js";

const ENTERPRISE = editionPolicy("enterprise");
const PUBLIC = editionPolicy("public");
const org = "org_aaaaaaaaaaaaaaaaaaaa", actor = "a".repeat(64), other = "b".repeat(64), sessionId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";

// ---- the dispatcher bench: the same shape the role-change tests use, with a membership of any role --------------------------------------------------------

function fixture(role: OrgRole, policy: EditionPolicy | "none" = ENTERPRISE) {
  const db = new FakeDynamoDb(), audit = capturingAuditDeps({ db, now: () => Date.parse("2026-10-26T12:00:00Z") });
  const member = (who: string, r: string) => { db.set({ ...orgMemberKey(org, who), orgId: org, developerId: who, role: r, joinedAt: "2026-10-01T00:00:00Z" }); db.set({ ...developerOrgKey(who), orgId: org, developerId: who, role: r }); };
  member(actor, role);
  member(other, "member");
  db.set({ pk: `DEVELOPER#${actor}`, sk: "META", developerId: actor, displayName: "Priya", provider: "oidc" });
  db.set({ pk: `SESSION#${sessionId}`, sk: "META", developerId: actor, amr: "oidc", endsAt: Math.floor(audit.audit.now() / 1000) + 3600, reviewExpiresAt: Math.floor(audit.audit.now() / 1000) + 3600, startedAt: "2026-10-26T11:00:00Z" });
  db.set({ ...orgMetaKey(org), orgId: org, name: "Acme", plan: "team" });
  const claims = { iss: "https://cell.example/v1/auth", aud: "agentx-developer", sub: actor, sid: sessionId, amr: "oidc", env: "test", org, org_role: role };
  const deps: DeveloperRouteDependencies = {
    tableName: "state", now: audit.audit.now, documentClient: db, audit: { ...audit.audit, tableName: "state" },
    ...(policy === "none" ? {} : { editionPolicy: policy }),
    developer: { issuer: "https://cell.example/v1/auth", env: "test", methods: { slack: false, oidc: true, cloud: false }, signInTableName: "signin", verifyAccessToken: async () => claims, channelMembers: async () => ({ ok: true, memberOf: [] }) },
    orgs: new OrgStore({ documentClient: db, tableName: "state", now: audit.audit.now }),
    tasks: {} as never,
  };
  const caller: DeveloperCaller = { orgId: org, developerId: actor, orgRole: role, name: "Priya", amr: "oidc", sessionId: "fixture" };
  /** A browser-session call (the caller is given), or with `token` an API call whose caller is read from the bearer token and the live membership. */
  async function call(method: string, path: string, body?: unknown, as: DeveloperCaller = caller, token = false) {
    const request = { method, path, headers: {}, body: body === undefined ? "" : JSON.stringify(body), requestId: "test" };
    try { return { result: await routeDeveloperRequest(deps, request, new URL(path, "https://cell.example"), token ? undefined : { caller: { ...as, browserSession: true }, csrf: "csrf" }) }; }
    catch (error) { if (!(error instanceof AgentXError)) throw error; return { code: error.code, message: error.message }; }
  }
  return { db, deps, audit, caller, member, call, roleOf: (who = other) => db.get(orgMemberKey(org, who))?.role, claims };
}

const WRITES: ReadonlyArray<[string, string, unknown?]> = [
  ["PUT", `/v1/app/org/members/${other}/role`, { requestId, role: "admin" }], ["DELETE", `/v1/app/org/members/${other}`], ["POST", "/v1/app/org/invites", { requestId, role: "member" }],
  ["PUT", "/v1/app/org/budget", {}], ["PUT", "/v1/app/org", { name: "New" }], ["POST", "/v1/app/org/leave", {}], ["PUT", "/v1/app/me/name", { name: "X" }],
  ["POST", "/v1/app/projects", {}], ["PUT", "/v1/app/projects/payments/settings", {}], ["PUT", `/v1/app/projects/payments/members/${other}`, { requestId, role: "maintainer" }],
  ["POST", "/v1/app/projects/payments/archive", {}], ["POST", "/v1/dev/tasks", {}], ["POST", "/v1/app/tasks/t1/decide", {}], ["POST", "/v1/app/agents", {}], ["POST", "/v1/app/chains", {}],
  ["POST", "/v1/app/sessions", {}], ["PUT", "/v1/app/connections/github", {}], ["PUT", "/v1/app/org/model-selection-policy", {}], ["POST", "/v1/app/triggers", {}],
  ["POST", "/v1/app/org/audit/records", {}], ["PUT", "/v1/app/org/audit/exports", {}],
];
const READS_NOT_ALLOWED = ["/v1/app/nav", "/v1/app/projects", "/v1/dev/projects", "/v1/app/org/members", "/v1/app/org", "/v1/app/org/budget", "/v1/app/agents", "/v1/app/sessions"];

describe("through the route dispatcher, an Auditor reaches nothing writable and nothing outside the audit log", () => {
  it("is refused on every write route of the set and every other read, before the store is touched", async () => {
    const f = fixture("auditor");
    const before = f.db.commandNames().length;
    for (const [method, path, body] of WRITES) {
      const answer = await f.call(method, path, body);
      expect(answer, `${method} ${path}`).toMatchObject({ code: "FORBIDDEN" });
      expect((answer as { message: string }).message).toContain(AUDITOR_REFUSED);
    }
    for (const path of READS_NOT_ALLOWED) expect(await f.call("GET", path), path).toMatchObject({ code: "FORBIDDEN" });
    expect(f.db.commandNames().length).toBe(before);
    expect(f.roleOf()).toBe("member");
  });

  it("positive control: the same requests from an owner are not stopped by the Auditor rule", async () => {
    const f = fixture("owner");
    let reached = 0;
    for (const [method, path, body] of WRITES) {
      const answer = await f.call(method, path, body);
      if (!("message" in answer) || !answer.message.includes(AUDITOR_REFUSED)) reached += 1;
    }
    expect(reached).toBe(WRITES.length);
  });

  it("an unreadable or unknown org role is held to the same list, not waved through", async () => {
    const f = fixture("member");
    for (const orgRole of ["viewer", "Auditor", "future-role", ""]) {
      expect(await f.call("PUT", "/v1/app/org", { name: "X" }, { ...f.caller, orgRole: orgRole as OrgRole })).toMatchObject({ code: "FORBIDDEN", message: `FORBIDDEN: ${AUDITOR_REFUSED}` });
    }
  });
});

describe("the task and review pages", () => {
  const taskId = "33333333-3333-4333-8333-333333333333";
  const page = async (role: OrgRole) => {
    const f = fixture(role);
    const path = `/review/${taskId}/task`;
    const request = { method: "GET", path, headers: { cookie: `__Host-agentx_review_session=${sessionId}` }, body: "", requestId: "page" };
    try { return await routeDeveloperRequest(f.deps, request, new URL(path, "https://cell.example")) as { statusCode?: number; headers?: Record<string, string> }; }
    catch (error) { return { statusCode: -1, headers: { thrown: (error as Error).message } }; }
  };

  it("send an Auditor's cookie session back to sign-in, as no session at all, and do not for an owner", async () => {
    const auditor = await page("auditor");
    expect(auditor.statusCode).toBe(302);
    expect(auditor.headers?.location ?? "").toContain("/browser/authorize");
    // The control: an owner's session is read as a person, so it is not sent to sign-in.
    const owner = await page("owner");
    expect(owner.headers?.location ?? "").not.toContain("/browser/authorize");
  });
});

describe("the audit routes", () => {
  const auditor = (orgId = A, developerId = "dev_aud"): AuditOrgCaller => ({ orgId, developerId, orgRole: "auditor" });
  const call = (b: Awaited<ReturnType<typeof world>>, caller: AuditOrgCaller, method: string, path: string, body: unknown = {}) =>
    routeAuditRequest(b.deps, caller, { method, body, requestId: `r-${Math.random()}` }, new URL(path, "https://rovara.test"));

  it("serve the Auditor: records, status, an export start and an export read, in its own org only", async () => {
    const b = await world();
    const records = await call(b, auditor(), "GET", "/v1/app/org/audit/records?limit=3");
    expect(records.status).toBe(200);
    expect(JSON.stringify(records.body)).not.toContain(B);
    expect((await call(b, auditor(), "GET", "/v1/dev/org/audit/status")).status).toBe(200);
    const started = await call(b, auditor(), "POST", "/v1/app/org/audit/exports", { requestId: "export-1", fromSeq: 1, toSeq: 4 });
    expect([200, 202]).toContain(started.status);
    expect((await call(b, auditor(), "GET", `/v1/app/org/audit/exports/${(started.body as { exportId: string }).exportId}`)).status).toBe(200);
    // Org B's data is not reachable by an Auditor of org A.
    await expect(call(b, auditor(), "GET", "/v1/app/org/audit/exports/not-an-export")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("records the Auditor's read as the Auditor's (an audited reader), and still refuses a plain member", async () => {
    const b = await world();
    await call(b, auditor(A, "dev_aud"), "GET", "/v1/app/org/audit/status");
    const events = b.sqs.queue.map((message) => JSON.parse(message.body) as { action: string; actor: { id: string } });
    expect(events.map((event) => [event.action, event.actor.id])).toStrictEqual([["audit.read", "dev_aud"]]);
    await expect(call(b, { orgId: A, developerId: "dev_m", orgRole: "member" }, "GET", "/v1/app/org/audit/status")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("serve the indexed search to a live Auditor, and refuse one whose stored role is not the Auditor", async () => {
    const b = await world();
    b.h.db.set({ pk: `ORG#${A}`, sk: "MEMBER#dev_aud", entityType: "ORG_MEMBER", orgId: A, developerId: "dev_aud", role: "auditor", joinedAt: "2026-10-01T00:00:00Z" });
    b.h.db.set({ pk: "DEVELOPER_ORG#dev_aud", sk: "ORG", orgId: A, developerId: "dev_aud", role: "auditor" });
    const search = (caller: AuditOrgCaller) => call(b, caller, "GET", "/v1/app/org/audit/records?filterVersion=1&action=audit.read");
    // Whatever the search answers for an empty index, it is not a refusal of the role.
    await search(auditor(A, "dev_aud")).then((reply) => expect(reply.status).toBe(200), (error: { code: string }) => expect(error.code).not.toBe("FORBIDDEN"));
    b.h.db.set({ pk: `ORG#${A}`, sk: "MEMBER#dev_aud", entityType: "ORG_MEMBER", orgId: A, developerId: "dev_aud", role: "member", joinedAt: "2026-10-01T00:00:00Z" });
    await expect(search(auditor(A, "dev_aud"))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("the Auditor is an Enterprise role", () => {
  it("a session that holds it is read on Enterprise, and refused on Public and where the edition is not known", async () => {
    const enterprise = fixture("auditor", ENTERPRISE);
    expect(await authenticateDeveloper(enterprise.deps, enterprise.claims)).toMatchObject({ orgRole: "auditor", developerId: actor });
    for (const policy of [PUBLIC, "none" as const]) {
      const f = fixture("auditor", policy);
      await expect(authenticateDeveloper(f.deps, f.claims)).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    // The other roles do not depend on the edition being known.
    const member = fixture("member", "none");
    expect(await authenticateDeveloper(member.deps, member.claims)).toMatchObject({ orgRole: "member" });
  });

  it("an owner gives the role by a reviewed change on Enterprise, and not on Public or an unknown edition", async () => {
    const reviewed = { requestId, role: "auditor", expectedRole: "member" };
    const ok = fixture("owner", ENTERPRISE);
    expect(await ok.call("PUT", `/v1/app/org/members/${other}/role`, reviewed)).toEqual({ result: { developerId: other, role: "auditor" } });
    expect(ok.roleOf()).toBe("auditor");
    expect(ok.audit.recordedBy("member.role_changed")).toMatchObject([{ orgId: org, actor: { kind: "member", id: actor }, target: { kind: "member", id: other }, facts: { fromRole: "member", toRole: "auditor" } }]);
    for (const policy of [PUBLIC, "none" as const]) {
      const f = fixture("owner", policy);
      expect(await f.call("PUT", `/v1/app/org/members/${other}/role`, reviewed)).toMatchObject({ code: "FORBIDDEN" });
      expect(f.roleOf()).toBe("member");
    }
  });

  it("the same for the legacy change (no expected role), and a change that keeps the Auditor needs no edition", async () => {
    const legacy = { requestId, role: "auditor" };
    const ok = fixture("owner", ENTERPRISE);
    expect(await ok.call("PUT", `/v1/app/org/members/${other}/role`, legacy, ok.caller, true)).toEqual({ result: { developerId: other, role: "auditor" } });
    expect(ok.roleOf()).toBe("auditor");
    for (const policy of [PUBLIC, "none" as const]) {
      const f = fixture("owner", policy);
      expect(await f.call("PUT", `/v1/app/org/members/${other}/role`, legacy, f.caller, true)).toMatchObject({ code: "FORBIDDEN" });
      expect(f.roleOf()).toBe("member");
    }
  });

  it("an admin cannot give the role (owners only), and an invite cannot carry it", async () => {
    const f = fixture("admin", ENTERPRISE);
    expect(await f.call("PUT", `/v1/app/org/members/${other}/role`, { requestId, role: "auditor", expectedRole: "member" })).toMatchObject({ code: "FORBIDDEN" });
    expect(f.roleOf()).toBe("member");
    const owner = fixture("owner", ENTERPRISE);
    expect(await owner.call("POST", "/v1/app/org/invites", { requestId, role: "auditor" })).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("a group mapping grants the role on Enterprise, refuses a person who is also a member, and is refused where the edition has no Auditor", () => {
    const config = (roles: Array<"admin" | "member" | "auditor">) => ({
      version: 1, updatedAt: "2026-10-31T00:00:00Z", updatedBy: actor, claim: "groups", rules: roles.map((orgRole, index) => ({ id: `rule${String(index)}`, group: `g-${orgRole}`, orgRole, projectRoles: [] })),
    });
    const claims = (...groups: string[]) => ({ groups });
    const ok = evaluateGroupMapping({ policy: ENTERPRISE, config: config(["auditor"]), claims: claims("g-auditor") });
    expect(ok).toMatchObject({ ok: true, access: { orgRole: "auditor" } });
    expect(evaluateGroupMapping({ policy: ENTERPRISE, config: config(["auditor", "member"]), claims: claims("g-auditor", "g-member") })).toEqual({ ok: false, reason: "auditor_and_writer" });
    const noAuditor = { ...ENTERPRISE, features: { ...ENTERPRISE.features, auditorRole: false } } as EditionPolicy;
    expect(evaluateGroupMapping({ policy: noAuditor, config: config(["auditor"]), claims: claims("g-auditor") })).toEqual({ ok: false, reason: "config_invalid" });
    expect(decideSignIn({ policy: noAuditor, config: config(["auditor"]), claims: claims("g-auditor"), currentRole: undefined, personId: actor, breakGlass: [], now: 0 })).toMatchObject({ allow: false });
    expect(evaluateGroupMapping({ policy: PUBLIC, config: config(["auditor"]), claims: claims("g-auditor") })).toEqual({ ok: false, reason: "edition_off" });
  });
});

describe("saving a group mapping that grants the Auditor", () => {
  it("needs the Auditor in the edition, and a mapping without it saves where only SSO is on", async () => {
    const noAuditor = { ...ENTERPRISE, features: { ...ENTERPRISE.features, auditorRole: false } } as EditionPolicy;
    const rule = (orgRole: "member" | "auditor") => ({ id: "r1", group: "g", orgRole, projectRoles: [] });
    const save = (policy: EditionPolicy, orgRole: "member" | "auditor") => dynamoGroupMappingStore({ documentClient: new FakeDynamoDb(), tableName: "state", policy }).put(org, { claim: "groups", rules: [rule(orgRole)], updatedAt: "2026-10-31T00:00:00Z", updatedBy: actor }, 0);
    expect((await save(ENTERPRISE, "auditor")).version).toBe(1);
    await expect(save(noAuditor, "auditor")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await save(noAuditor, "member")).version).toBe(1);
  });
});

describe("the Auditor holds no project role and acts for no task", () => {
  it("effectiveProjectRole is none whatever grant or channel the Auditor also has", () => {
    const grant = { role: "developer", projectRole: "maintainer" } as never;
    expect(effectiveProjectRole({ orgRole: "auditor", developerId: actor }, grant, true)).toBeUndefined();
    expect(effectiveProjectRole({ orgRole: "auditor", developerId: actor }, undefined, true)).toBeUndefined();
    // Positive controls: the roles around it still get theirs.
    expect(effectiveProjectRole({ orgRole: "member", developerId: actor }, undefined, true)).toBe("contributor");
    expect(effectiveProjectRole({ orgRole: "admin", developerId: actor }, undefined, false)).toBe("maintainer");
  });

  it("the model turn authority refuses an Auditor at the role step, before it reads anything else, and a member goes on", async () => {
    const REFUSED = "Your project or company access changed. Reload and check your access.";
    const outcome = async (role: string) => {
      const db = new FakeDynamoDb();
      db.set({ ...orgMemberKey(org, actor), orgId: org, developerId: actor, role, joinedAt: "2026-10-01T00:00:00Z" });
      db.set({ pk: `ORG#${org}#MEMBER#${actor}`, sk: "PROJECT#payments", role: "developer", projectRole: "maintainer", projectName: "payments" });
      let reached = 0;
      const signInStore = { getDeveloper: () => { reached += 1; return Promise.resolve(undefined); } };
      let refused = false;
      try { await readTurnActorChecks({ documentClient: db, tableName: "state", signInStore }, { orgId: org, project: "payments", developerId: actor }); }
      catch (error) { refused = (error as Error).message.includes(REFUSED); }
      return { refused, reachedSignInStore: reached };
    };
    expect(await outcome("auditor")).toEqual({ refused: true, reachedSignInStore: 0 });
    // The control: a member passes the role step and is asked for its sign-in record (it is refused later, for want of one, which is not the point).
    expect((await outcome("member")).reachedSignInStore).toBe(1);
  });
});

describe("the role vocabulary", () => {
  it("OrgRoleSchema knows the Auditor, and only the four roles", () => {
    expect(OrgRoleSchema.options).toEqual(["owner", "admin", "member", "auditor"]);
  });
});
