// M1 RED contract: exercise the real app router and atomic DynamoDB fake.
// Each case names the enrollment guard/side effect whose removal must fail it.
import { randomUUID } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { expect, it } from "vitest";
import {
 AgentXError, DEFAULT_AGENT_GUARDRAILS, agentGuardrailsKey, agentKey, createWorkflowSnapshot,
 developerOrgKey, errorStatus, orgMemberKey, orgMetaKey, orgProjectCatalogKey, orgScoped,
 orgSettingsKey, projectAiKey, projectMemberKey, projectMetaKey, workspaceProjectIndexValue,
} from "@agentx/contracts";
import { routeDeveloperRequest, type DeveloperCaller, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { fixtureProject } from "../support/project-ai-source.js";

const orgId = "org_aaaaaaaaaaaaaaaaaaaa", foreignOrg = "org_bbbbbbbbbbbbbbbbbbbb";
const owner = "a".repeat(64), other = "b".repeat(64), agentId = "agt_aaaaaaaaaaaaaaaaaaaa";
const initialNow = Date.parse("2026-11-04T15:00:00.000Z");
const base = "/v1/app/org/task-stop-policy", enrollment = `${base}/enrollment`, reviewPath = `${base}/cutover-review`;
type Row = Record<string, unknown>;
function fixture() {
 const db = new FakeDynamoDb(), audit = capturingAuditDeps({ db });let clock = initialNow;
 const key = orgSettingsKey(orgId, "TASK_STOP_POLICY");
 fixtureProject(db, orgId, "web");
 db.set({ ...orgMetaKey(orgId), orgId, entityType: "ORG" });
 db.set({ ...key, entityType: "ORG_TASK_STOP_POLICY", orgId, revision: 1,
  policy: { schemaVersion: 2, defaultPolicy: { kind: "limited", stopMicrousd: 2_000_000 } },
  enrollment: { version: 1, state: "disabled" } });
 db.set({ ...agentGuardrailsKey(orgId), entityType: "AGENT_GUARDRAILS", orgId, revision: 1,
  guardrails: { ...DEFAULT_AGENT_GUARDRAILS, maxPerRunCeilingUsd: 10 } });
 db.set({ ...orgProjectCatalogKey(orgId, "web"), entityType: "PROJECT_CATALOG", orgId, name: "web", latestRevision: 1 });
 db.set({ ...projectMetaKey(orgId, "web"), entityType: "PROJECT_META", orgId, name: "web", status: "active", createdAt: new Date(initialNow).toISOString() });
 db.set({ ...projectAiKey(orgId, "web"), entityType: "PROJECT_AI", orgId, project: "web", revision: 1, projectPays: false, taskStopPolicy: { schemaVersion: 2, kind: "inherit" } });
 db.set({ ...agentKey(orgId, agentId, "META"), entityType: "AGENT", orgId, agentId, status: "active", revision: 1, stopKind: "inherit", owner: { kind: "member", developerId: owner } });
 db.set({ pk: orgScoped(orgId, "TASK_STOP_SEED"), sk: "V1#bootstrap", entityType: "TASK_STOP_SEED", orgId, version: 1, source: "bootstrap", outcome: "created", policyRevision: 1 });
 for (const id of [owner, other]) {
  db.set({ ...orgMemberKey(orgId, id), orgId, developerId: id, role: "owner" });
  db.set({ ...developerOrgKey(id), orgId, role: "owner" });
  db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, provider: "cloud", revoked: false });
  db.set({ pk: `SESSION#session-${id}`, sk: "META", sessionId: `session-${id}`, developerId: id, amr: "cloud",
   authTime: new Date(initialNow - 60_000).toISOString(), startedAt: new Date(initialNow - 60_000).toISOString(), endsAt: initialNow / 1000 + 3600 });
 }
 const deps: DeveloperRouteDependencies = { documentClient: db, tableName: "state", now: () => clock, audit: audit.audit,
  developer: { issuer: "https://cell.example", env: "test", signInTableName: "signin", methods: { cloud: true, slack: false, oidc: false }, verifyAccessToken: async () => ({}), channelMembers: async () => ({ ok: true, memberOf: [] }) } };
 async function call(method: string, path: string, body?: Row, callerExtra: Partial<DeveloperCaller> = {}) {
  const caller: DeveloperCaller = { orgId, developerId: owner, orgRole: "owner", name: "Owner", amr: "cloud", sessionId: `session-${owner}`, ...callerExtra };
  try {
   const result = await routeDeveloperRequest(deps, { method, path, headers: {}, requestId: randomUUID(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, new URL(path, "https://cell.example"), { caller, csrf: "" });
   return { status: result === undefined ? 404 : 200, body: result as Row | undefined };
  } catch (error) {
   if (!(error instanceof AgentXError)) throw error;
   return { status: errorStatus(error.code), body: { code: error.code } as Row };
  }
 }
 const changedEvents = () => audit.recorded().filter(event => String(event.action) === "spending.enrollment_changed");
 async function review() {
  const result = await call("POST", reviewPath, { requestId: randomUUID(), expectedRevision: db.get(key)!.revision });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(result.body).toMatchObject({ complete: true, revision: db.get(key)!.revision });
  expect(result.body?.reviewId).toEqual(expect.any(String));expect(result.body?.digest).toMatch(/^[a-f0-9]{64}$/);
  return result.body!;
 }
 const transitionBody = (state: string, revision: number, r?: Row): Row => ({ requestId: randomUUID(), expectedRevision: revision, state,
  ...(r === undefined ? {} : { reviewId: r.reviewId, expectedReviewDigest: r.digest }) });
 async function ready() {
  const r = await review(), body = transitionBody("ready", 1, r), result = await call("PUT", enrollment, body);
  expect(result.status, JSON.stringify(result.body)).toBe(200);expect(result.body).toMatchObject({ state: "ready", revision: 2 });
  return r;
 }
 function task(queued: boolean) {
  const taskId = randomUUID(), workspaceId = randomUUID(), at = new Date(initialNow - 1000).toISOString();
  const workflow = createWorkflowSnapshot({ taskId, ownerId: owner, now: at, path: "QUICK", checkPolicy: { required: [], optional: [], selectedOptionalIds: [] } });
  db.set({ pk: `DEVTASK#${taskId}`, sk: "META", entityType: "DEVELOPER_TASK", taskId, orgId, developerId: owner,
   provider: "cloud", developerName: "Owner", client: "web", project: "web", title: "Private task title", workspaceId, ownerKey: owner,
   conversationId: "conversation", startingRevision: 1, charge: { member: { pk: "m", sk: "m" }, organization: { pk: "o", sk: "o" } },
   shared: false, createdAt: at, updatedAt: at, budgetUsd: 20, workflow,
   agent: { agentId, version: 1 }, ...(queued ? {} : { activeOperationId: randomUUID() }) });
  db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "META", entityType: "WORKSPACE", id: workspaceId, orgId, projectName: "web", ownerKey: owner,
   createdAt: at, updatedAt: at, state: queued ? "QUEUED" : "RUNNING", workspaceProject: workspaceProjectIndexValue(orgId, "web"), workspaceCreatedAt: at });
  db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "DEVELOPER_TASK", entityType: "DEVELOPER_TASK_POINTER", taskId, orgId, developerId: owner });
  return taskId;
 }
 return { db, deps, key, call, review, ready, task, transitionBody, changedEvents, audit, advance: (ms: number) => { clock += ms; } };
}

it("owner can read disabled enrollment without turning it on", async () => {
 const f = fixture(), before = [...f.db.items.entries()];
 expect(await f.call("GET", enrollment)).toMatchObject({ status: 200, body: { state: "disabled", revision: 1 } });
 expect([...f.db.items.entries()]).toEqual(before);expect(f.audit.recorded()).toEqual([]);
});
for (const role of ["admin", "maintainer", "member", "auditor"] as const) for (const operation of ["read", "review", "ready", "enable", "disable"] as const)
it(`live ${role} cannot ${operation} enrollment even with an owner caller claim`, async () => {
 const f = fixture();let r: Row | undefined;
 if (operation === "enable" || operation === "disable") r = await f.ready();
 if (operation === "disable") expect((await f.call("PUT", enrollment, f.transitionBody("enabled", 2, r))).status).toBe(200);
 // A project maintainer is an org member with a project grant, never an org role.
 const orgRole = role === "maintainer" ? "member" : role;
 f.db.set({ ...f.db.get(orgMemberKey(orgId, owner))!, role: orgRole });
 f.db.set({ ...f.db.get(developerOrgKey(owner))!, role: orgRole });
 if (role === "maintainer") f.db.set({ ...projectMemberKey(orgId, owner, "web"), role: "developer", projectRole: "maintainer", ownerKey: owner, projectName: "web", grantId: randomUUID() });
 const before = [...f.db.items.entries()], count = f.audit.recorded().length;
 const result = operation === "read" ? await f.call("GET", enrollment) : operation === "review" ? await f.call("POST", reviewPath, { requestId: randomUUID(), expectedRevision: 1 })
  : await f.call("PUT", enrollment, f.transitionBody(operation === "enable" ? "enabled" : operation === "disable" ? "disabled" : "ready", operation === "disable" ? 3 : operation === "enable" ? 2 : 1, r));
 expect(result).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
 expect([...f.db.items.entries()]).toEqual(before);expect(f.audit.recorded()).toHaveLength(count);
});
it("capturing a complete review alone never changes enrollment or policy revision", async () => {
 const f = fixture(), before = f.db.get(f.key);await f.review();
 expect(f.db.get(f.key)).toEqual(before);expect(f.changedEvents()).toEqual([]);
});
it("owner ready then enabled then disabled commits each revision and one audit per change", async () => {
 const f = fixture(), r = await f.ready();
 expect((await f.call("PUT", enrollment, f.transitionBody("enabled", 2, r))).body).toMatchObject({ state: "enabled", revision: 3 });
 expect((await f.call("PUT", enrollment, f.transitionBody("disabled", 3))).body).toMatchObject({ state: "disabled", revision: 4 });
 expect(f.db.get(f.key)).toMatchObject({ revision: 4, policy: { schemaVersion: 2, defaultPolicy: { kind: "limited", stopMicrousd: 2_000_000 } }, enrollment: { version: 1, state: "disabled" } });
 expect(f.changedEvents().map(event => event.facts)).toEqual([
  expect.objectContaining({ before: "disabled", after: "ready", revision: 2 }),
  expect.objectContaining({ before: "ready", after: "enabled", revision: 3 }),
  expect.objectContaining({ before: "enabled", after: "disabled", revision: 4 }),
 ]);
 for (const event of f.changedEvents()) expect(event).toMatchObject({ orgId, actor: { kind: "member", id: owner } });
});
it("no review and no disabled-to-enabled shortcut may change the policy", async () => {
 const f = fixture(), before = f.db.get(f.key);
 for (const state of ["ready", "enabled"]) expect((await f.call("PUT", enrollment, f.transitionBody(state, 1))).body?.code).toBe("CONFIG_INVALID");
 expect(f.db.get(f.key)).toEqual(before);expect(f.changedEvents()).toEqual([]);
});
for (const loss of ["missing", "stale", "revoked", "expired", "wrong-person", "future", "refresh-only"] as const)
it(`enable requires recent interactive sign-in: ${loss}`, async () => {
 const f = fixture(), r = await f.ready(), k = { pk: `SESSION#session-${owner}`, sk: "META" }, session = f.db.get(k)!;
 if (loss === "missing") f.db.delete(k);
 else if (loss === "stale") f.db.set({ ...session, authTime: new Date(initialNow - 3_600_000).toISOString() });
 else if (loss === "revoked") f.db.set({ ...session, revokedAt: new Date(initialNow).toISOString() });
 else if (loss === "expired") f.db.set({ ...session, endsAt: initialNow / 1000 - 1 });
 else if (loss === "wrong-person") f.db.set({ ...session, developerId: other });
 else if (loss === "future") f.db.set({ ...session, authTime: new Date(initialNow + 60_000).toISOString() });
 else { const old: Row = { ...session, lastRefreshAt: new Date(initialNow).toISOString() };delete old.authTime;f.db.set(old); }
 const before = f.db.get(f.key), events = f.changedEvents().length;
 expect(await f.call("PUT", enrollment, f.transitionBody("enabled", 2, r))).toMatchObject({ body: { code: "REAUTH_REQUIRED" } });
 expect(f.db.get(f.key)).toEqual(before);expect(f.changedEvents()).toHaveLength(events);
});
for (const drift of ["revision", "role", "pointer", "identity", "closing", "session"] as const)
it(`enable fences concurrent ${drift} loss at commit`, async () => {
 const f = fixture(), r = await f.ready(), send = f.db.send.bind(f.db);let raced = false;
 f.db.send = async command => {
  if (!raced && command instanceof TransactWriteCommand) {
   raced = true;
   if (drift === "revision") f.db.set({ ...f.db.get(f.key)!, revision: 3 });
   if (drift === "role") f.db.set({ ...f.db.get(orgMemberKey(orgId, owner))!, role: "admin" });
   if (drift === "pointer") f.db.set({ ...f.db.get(developerOrgKey(owner))!, orgId: foreignOrg });
   if (drift === "identity") f.db.set({ ...f.db.get({ pk: `DEVELOPER#${owner}`, sk: "META" })!, revoked: true });
   if (drift === "closing") f.db.set({ ...f.db.get(orgMetaKey(orgId))!, closingAt: new Date(initialNow).toISOString() });
   if (drift === "session") f.db.set({ ...f.db.get({ pk: `SESSION#session-${owner}`, sk: "META" })!, revokedAt: new Date(initialNow).toISOString() });
  }
  return send(command);
 };
 const result = await f.call("PUT", enrollment, f.transitionBody("enabled", 2, r));
 expect(raced).toBe(true);expect(result.body?.code).toBe(drift === "revision" ? "CHANGE_STALE" : drift === "session" ? "REAUTH_REQUIRED" : "FORBIDDEN");
 expect(f.db.get(f.key)?.enrollment).toMatchObject({ state: "ready" });expect(f.changedEvents()).toHaveLength(1);
});
it("foreign-org review id reads as missing and leaves that org and caller org unchanged", async () => {
 const f = fixture(), r = await f.review(), before = f.db.get(f.key);
 f.db.set({ ...orgMetaKey(foreignOrg), orgId: foreignOrg, entityType: "ORG" });
 f.db.set({ ...orgMemberKey(foreignOrg, other), orgId: foreignOrg, developerId: other, role: "owner" });
 f.db.set({ ...developerOrgKey(other), orgId: foreignOrg, role: "owner" });
 const foreignKey = orgSettingsKey(foreignOrg, "TASK_STOP_POLICY");f.db.set({ ...before, ...foreignKey, orgId: foreignOrg });
 const foreignBefore = f.db.get(foreignKey);
 expect(await f.call("PUT", enrollment, f.transitionBody("ready", 1, r), { orgId: foreignOrg, developerId: other, sessionId: `session-${other}` })).toMatchObject({ status: 404, body: { code: "NOT_FOUND" } });
 expect(f.db.get(f.key)).toEqual(before);expect(f.db.get(foreignKey)).toEqual(foreignBefore);expect(f.changedEvents()).toEqual([]);
});
for (const bad of ["expired", "wrong-digest", "policy-edited"] as const) it(`ready refuses ${bad} review`, async () => {
 const f = fixture(), r = await f.review();
 if (bad === "expired") f.advance(300_001);
 if (bad === "wrong-digest") r.digest = "f".repeat(64);
 if (bad === "policy-edited") f.db.set({ ...f.db.get(f.key)!, revision: 2 });
 expect((await f.call("PUT", enrollment, f.transitionBody("ready", 1, r))).body?.code).toBe("CHANGE_STALE");
 expect(f.db.get(f.key)?.enrollment).toEqual({ version: 1, state: "disabled" });expect(f.changedEvents()).toEqual([]);
});
it("audit unavailability prevents enrollment and receipt from committing", async () => {
 const f = fixture(), r = await f.review();delete f.deps.audit;
 const before = [...f.db.items.entries()];
 expect((await f.call("PUT", enrollment, f.transitionBody("ready", 1, r))).body?.code).toBe("AUDIT_UNAVAILABLE");
 expect([...f.db.items.entries()]).toEqual(before);
});
it("late ready replay after disable returns its receipt without re-enabling or re-auditing", async () => {
 const f = fixture(), r = await f.review(), body = f.transitionBody("ready", 1, r);
 const first = await f.call("PUT", enrollment, body);expect(first.status).toBe(200);
 expect((await f.call("PUT", enrollment, f.transitionBody("enabled", 2, r))).status).toBe(200);
 expect((await f.call("PUT", enrollment, f.transitionBody("disabled", 3))).status).toBe(200);
 const before = [...f.db.items.entries()], count = f.changedEvents().length;
 expect(await f.call("PUT", enrollment, body)).toEqual(first);
 expect([...f.db.items.entries()]).toEqual(before);expect(f.changedEvents()).toHaveLength(count);
 expect((await f.call("PUT", enrollment, { ...body, state: "disabled" })).body?.code).toBe("CONFIG_INVALID");
});
it("lost commit acknowledgement recovers the ready receipt and one durable audit", async () => {
 const f = fixture(), r = await f.review(), send = f.db.send.bind(f.db);let lost = false;
 f.db.send = async command => { const result = await send(command);if (!lost && command instanceof TransactWriteCommand) { lost = true;throw new Error("lost acknowledgement"); }return result; };
 expect((await f.call("PUT", enrollment, f.transitionBody("ready", 1, r))).body).toMatchObject({ state: "ready", revision: 2 });
 expect(lost).toBe(true);expect(f.changedEvents()).toHaveLength(1);
});
it("review projects running and queued tasks with the captured company stop and never leaks task text", async () => {
 const f = fixture(), running = f.task(false), queued = f.task(true), before = [running, queued].map(id => f.db.get({ pk: `DEVTASK#${id}`, sk: "META" }));
 const r = await f.review();expect(r.tasks).toEqual(expect.arrayContaining([
  expect.objectContaining({ taskId: running, project: "web", effectiveStopMicrousd: 2_000_000 }),
  expect.objectContaining({ taskId: queued, project: "web", effectiveStopMicrousd: 2_000_000 }),
 ]));
 expect(JSON.stringify(r)).not.toContain("Private task title");expect(JSON.stringify(r)).not.toContain("sourceChecks");
 expect([running, queued].map(id => f.db.get({ pk: `DEVTASK#${id}`, sk: "META" }))).toEqual(before);
});
it("review fails closed for an unreadable required agent source rather than marking ready", async () => {
 const f = fixture();f.task(true);f.db.delete(agentKey(orgId, agentId, "META"));
 const result = await f.call("POST", reviewPath, { requestId: randomUUID(), expectedRevision: 1 });
 expect(result.body?.code).toBe("TASK_STOP_CONFIG_MISSING");expect(f.db.get(f.key)?.enrollment).toEqual({ version: 1, state: "disabled" });
});

it("enable refuses a review that expired after ready without changing enrollment", async () => {
 const f = fixture(), r = await f.ready();f.advance(300_001);
 expect((await f.call("PUT", enrollment, f.transitionBody("enabled", 2, r))).body?.code).toBe("CHANGE_STALE");
 expect(f.db.get(f.key)?.enrollment).toMatchObject({ state: "ready" });expect(f.changedEvents()).toHaveLength(1);
});
it("enable refuses economic sources edited after the owner's review", async () => {
 const f = fixture();f.task(true);const r = await f.ready(), key = projectAiKey(orgId, "web");
 f.db.set({ ...f.db.get(key)!, revision: 2, taskStopPolicy: { schemaVersion: 1, stopMicrousd: 1 } });
 expect((await f.call("PUT", enrollment, f.transitionBody("enabled", 2, r))).body?.code).toBe("CHANGE_STALE");
 expect(f.db.get(f.key)?.enrollment).toMatchObject({ state: "ready" });expect(f.changedEvents()).toHaveLength(1);
});
it("review reports a zero-stop queued refusal while preserving the running accepted window", async () => {
 const f = fixture(), running = f.task(false), queued = f.task(true);
 f.db.set({ ...f.db.get(f.key)!, policy: { schemaVersion: 2, defaultPolicy: { kind: "limited", stopMicrousd: 0 } } });
 const r = await f.review();expect(r.tasks).toEqual(expect.arrayContaining([
  expect.objectContaining({ taskId: queued, effectiveStopMicrousd: 0, outcome: "refuse_next_admission" }),
  expect.objectContaining({ taskId: running, effectiveStopMicrousd: 0, outcome: "retain_current_window" }),
 ]));
 expect(f.db.get({ pk: `DEVTASK#${running}`, sk: "META" })?.budgetUsd).toBe(20);
 expect(f.db.get(f.key)?.enrollment).toEqual({ version: 1, state: "disabled" });
});
it("review request cannot inject a foreign org or a client-supplied impact list", async () => {
 const f = fixture(), before = [...f.db.items.entries()];
 expect((await f.call("POST", reviewPath, { requestId: randomUUID(), expectedRevision: 1, orgId: foreignOrg, tasks: [] })).body?.code).toBe("CONFIG_INVALID");
 expect([...f.db.items.entries()]).toEqual(before);
});
