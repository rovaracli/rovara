// M1 RED contract: exercise the real app router and atomic DynamoDB fake.
// Each case names the enrollment guard/side effect whose removal must fail it.
import { randomUUID } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { expect, it } from "vitest";
import {
 AgentXError, agentRequestKey, BUILTIN_AGENT_IDS, INDEX_EXPIRY_ATTRIBUTE, builtinSettingsKey, modelSourcesKey, taskSpendKey, DEFAULT_AGENT_GUARDRAILS, agentGuardrailsKey, agentKey, createWorkflowSnapshot,
 developerOrgKey, errorStatus, orgMemberKey, orgMetaKey, orgProjectCatalogKey, orgScoped,
 orgSettingsKey, projectAiKey, projectMemberKey, projectMetaKey, workspaceProjectIndexValue,
} from "@agentx/contracts";
import { routeDeveloperRequest, type DeveloperCaller, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import * as company from "../../packages/broker/src/org/task-stop-company.js";
import { captureTaskStopAdmission, captureTaskStopCutoverReview } from "../../packages/broker/src/org/task-stop-admission.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { fixtureProject } from "../support/project-ai-source.js";

const orgId = "org_aaaaaaaaaaaaaaaaaaaa", foreignOrg = "org_bbbbbbbbbbbbbbbbbbbb";
const owner = "a".repeat(64), other = "b".repeat(64), agentId = "agt_aaaaaaaaaaaaaaaaaaaa";
const initialNow = Date.parse("2026-11-04T15:00:00.000Z");
const base = "/v1/app/org/task-stop-policy", enrollment = `${base}/enrollment`, reviewPath = `${base}/cutover-review`;
type Row = Record<string, unknown>;
function isPolicyPut(command: unknown): command is TransactWriteCommand {
 const key = orgSettingsKey(orgId, "TASK_STOP_POLICY");
 return command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Put?.Item?.pk === key.pk && item.Put.Item.sk === key.sk) === true;
}
function fixture() {
 const db = new FakeDynamoDb(), audit = capturingAuditDeps({ db });audit.audit.documentClient = db as unknown as typeof audit.audit.documentClient;let clock = initialNow;
 const key = orgSettingsKey(orgId, "TASK_STOP_POLICY");
 for (const id of BUILTIN_AGENT_IDS) db.set({ ...builtinSettingsKey(orgId, id), entityType: "BUILTIN_AGENT_SETTINGS", orgId, agentId: id, revision: 1, stopKind: "inherit" });
 db.set({ pk: orgScoped(orgId, "AGENT_DIRECTORY"), sk: agentId, entityType: "AGENT_DIRECTORY", orgId, agentId });
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
 async function call(method: string, path: string, body?: Row | string, callerExtra: Omit<Partial<DeveloperCaller>, "browserSession"> & { browserSession?: boolean } = {}) {
  const { browserSession = true, ...actor } = callerExtra;
  const caller: DeveloperCaller = { orgId, developerId: owner, orgRole: "owner", name: "Owner", amr: "cloud", ...(browserSession ? { browserSession: true } : {}), sessionId: `session-${owner}`, ...actor };
  try {
   const result = await routeDeveloperRequest(deps, { method, path, headers: {}, requestId: randomUUID(), ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) }, new URL(path, "https://cell.example"), { caller, csrf: "" });
   return { status: result === undefined ? 404 : 200, body: result as Row | undefined };
  } catch (error) {
   if (!(error instanceof AgentXError)) throw error;
   return { status: errorStatus(error.code), body: { code: error.code, ...("resource" in error ? { resource: error.resource } : {}) } as Row };
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
for (const target of ["enable", "disable"] as const) for (const loss of ["missing", "stale", "revoked", "expired", "wrong-person", "future", "sessions-ended", "refresh-only"] as const)
it(`${target} requires recent interactive sign-in: ${loss}`, async () => {
 const f = fixture(), r = await f.ready();if (target === "disable") expect((await f.call("PUT", enrollment, f.transitionBody("enabled", 2, r))).status).toBe(200);
 const k = { pk: `SESSION#session-${owner}`, sk: "META" }, session = f.db.get(k)!;
 if (loss === "missing") f.db.delete(k);
 else if (loss === "stale") f.db.set({ ...session, authTime: new Date(initialNow - 3_600_000).toISOString() });
 else if (loss === "revoked") f.db.set({ ...session, revokedAt: new Date(initialNow).toISOString() });
 else if (loss === "expired") f.db.set({ ...session, endsAt: initialNow / 1000 - 1 });
 else if (loss === "wrong-person") f.db.set({ ...session, developerId: other });
 else if (loss === "sessions-ended") f.db.set({ ...f.db.get({ pk: `DEVELOPER#${owner}`, sk: "META" })!, sessionsEndedAt: new Date(initialNow).toISOString() });
 else if (loss === "future") f.db.set({ ...session, authTime: new Date(initialNow + 60_000).toISOString() });
 else { const old: Row = { ...session, lastRefreshAt: new Date(initialNow).toISOString() };delete old.authTime;f.db.set(old); }
 const before = f.db.get(f.key), events = f.changedEvents().length;
 expect(await f.call("PUT", enrollment, f.transitionBody(target === "enable" ? "enabled" : "disabled", target === "enable" ? 2 : 3, target === "enable" ? r : undefined))).toMatchObject({ body: { code: "REAUTH_REQUIRED" } });
 expect(f.db.get(f.key)).toEqual(before);expect(f.changedEvents()).toHaveLength(events);
});
for (const edge of ["ready", "enable", "disable"] as const) for (const drift of ["revision", "role", "pointer", "identity", "closing", "removed", ...(edge === "ready" ? [] : ["session", "sessions-ended"])] as const)
it(`${edge} fences concurrent ${drift} loss at commit`, async () => {
 const f = fixture(), r = edge === "ready" ? await f.review() : await f.ready();
 if (edge === "disable") expect((await f.call("PUT", enrollment, f.transitionBody("enabled", 2, r))).status).toBe(200);
 const before = f.db.get(f.key)!, count = f.changedEvents().length, revision = Number(before.revision), send = f.db.send.bind(f.db);let raced = false;
 f.db.send = async command => {
  if (!raced && isPolicyPut(command)) {
   raced = true;
   if (drift === "revision") f.db.set({ ...f.db.get(f.key)!, revision: revision + 1 });
   if (drift === "removed") { f.db.delete(orgMemberKey(orgId, owner));f.db.delete(developerOrgKey(owner)); }
   if (drift === "role") f.db.set({ ...f.db.get(orgMemberKey(orgId, owner))!, role: "admin" });
   if (drift === "pointer") f.db.set({ ...f.db.get(developerOrgKey(owner))!, orgId: foreignOrg });
   if (drift === "identity") f.db.set({ ...f.db.get({ pk: `DEVELOPER#${owner}`, sk: "META" })!, revoked: true });
   if (drift === "closing") f.db.set({ ...f.db.get(orgMetaKey(orgId))!, closingAt: new Date(initialNow).toISOString() });
   if (drift === "sessions-ended") f.db.set({ ...f.db.get({ pk: `DEVELOPER#${owner}`, sk: "META" })!, sessionsEndedAt: new Date(initialNow).toISOString() });
   if (drift === "session") f.db.set({ ...f.db.get({ pk: `SESSION#session-${owner}`, sk: "META" })!, revokedAt: new Date(initialNow).toISOString() });
  }
  return send(command);
 };
 const result = await f.call("PUT", enrollment, f.transitionBody(edge === "ready" ? "ready" : edge === "enable" ? "enabled" : "disabled", revision, edge === "disable" ? undefined : r));
 expect(raced).toBe(true);expect(result.body?.code).toBe(drift === "revision" ? "CHANGE_STALE" : drift === "session" ? "REAUTH_REQUIRED" : "FORBIDDEN");
 expect(f.db.get(f.key)?.enrollment).toEqual(before.enrollment);expect(f.changedEvents()).toHaveLength(count);
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
 f.db.send = async command => { const result = await send(command);if (!lost && isPolicyPut(command)) { lost = true;throw new Error("lost acknowledgement"); }return result; };
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

function addProject(f: ReturnType<typeof fixture>, name: string) {
 f.db.set({ ...orgProjectCatalogKey(orgId, name), entityType: "PROJECT_CATALOG", orgId, name, latestRevision: 1 });
 f.db.set({ ...projectMetaKey(orgId, name), entityType: "PROJECT_META", orgId, name, status: "active" });
 f.db.set({ ...projectAiKey(orgId, name), entityType: "PROJECT_AI", orgId, project: name, revision: 1, projectPays: false, taskStopPolicy: { schemaVersion: 2, kind: "inherit" } });
}
function addAgent(f: ReturnType<typeof fixture>, id: string) {
 f.db.set({ pk: orgScoped(orgId, "AGENT_DIRECTORY"), sk: id, entityType: "AGENT_DIRECTORY", orgId, agentId: id });
 f.db.set({ ...agentKey(orgId, id, "META"), entityType: "AGENT", orgId, agentId: id, status: "active", revision: 1, stopKind: "inherit" });
}
it("economic task digest ignores only company revision, enrollment and capture time", async () => {
 const f = fixture(), deps = { ...f.deps, requireScopeAccess: async () => {} }, input = { orgId, developerId: owner, role: "owner", project: "web", agentId, pathLimitMicrousd: 20_000_000 };
 const first = await captureTaskStopCutoverReview(deps, input);
 f.db.set({ ...f.db.get(f.key)!, revision: 2, enrollment: { version: 1, state: "ready" } });f.advance(1000);
 const second = await captureTaskStopCutoverReview(deps, input), fn: unknown = Reflect.get(company, "taskStopEconomicDigest");
 expect(typeof fn).toBe("function");if (typeof fn !== "function") throw new Error("economic projection absent");
 const digest = fn as (snapshot: typeof first.snapshot, outcome: string) => string;
 expect(first.snapshot.policyDigest).not.toBe(second.snapshot.policyDigest);
 expect(digest(first.snapshot, "retain_current_window")).toBe(digest(second.snapshot, "retain_current_window"));
 expect(digest({ ...second.snapshot, effectiveStopMicrousd: 1 }, "retain_current_window")).not.toBe(digest(first.snapshot, "retain_current_window"));
});
it("ready can refresh a review after six minutes and enable without another ready transition", async () => {
 const f = fixture();await f.ready();f.advance(360_000);const fresh = await f.review();
 expect((await f.call("PUT", enrollment, f.transitionBody("enabled", 2, fresh))).body).toMatchObject({ state: "enabled", revision: 3 });
 expect(f.changedEvents()).toHaveLength(2);
});
it("a refreshed ready review cannot bless economics changed since ready", async () => {
 const f = fixture();await f.ready();f.advance(360_000);
 f.db.set({ ...f.db.get(f.key)!, policy: { schemaVersion: 2, defaultPolicy: { kind: "limited", stopMicrousd: 3 } } });
 const fresh = await f.review();
 expect((await f.call("PUT", enrollment, f.transitionBody("enabled", 2, fresh))).body?.code).toBe("CHANGE_STALE");
});
it("enabled cannot capture another cutover review or write a receipt", async () => {
 const f = fixture(), r = await f.ready();await f.call("PUT", enrollment, f.transitionBody("enabled", 2, r));const before = [...f.db.items.entries()];
 expect((await f.call("POST", reviewPath, { requestId: randomUUID(), expectedRevision: 3 })).body?.code).toBe("CHANGE_STALE");
 expect([...f.db.items.entries()]).toEqual(before);
});
it("new task inventory does not block enable and audit reports the change", async () => {
 const f = fixture(), r = await f.ready();f.task(true);
 expect((await f.call("PUT", enrollment, f.transitionBody("enabled", 2, r))).body).toMatchObject({ tasksReviewed: 0, tasksAtEnable: 1 });
 expect(f.changedEvents().at(-1)?.facts).toMatchObject({ tasksReviewed: 0, tasksAtEnable: 1 });
});
for (const source of ["ceiling", "agent", "model-sources"] as const) it(`enable refuses ${source} economic drift`, async () => {
 const f = fixture(), r = await f.ready();
 if (source === "ceiling") { const k = agentGuardrailsKey(orgId);f.db.set({ ...f.db.get(k)!, revision: 2, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, maxPerRunCeilingUsd: 1 } }); }
 if (source === "agent") { const k = agentKey(orgId, agentId, "META");f.db.set({ ...f.db.get(k)!, revision: 2, stopKind: "limited", maxPerRunUsd: 1 }); }
 if (source === "model-sources") f.db.set({ ...modelSourcesKey(orgId), entityType: "MODEL_SOURCES", orgId, revision: 1, sources: [], order: ["rovara"] });
 expect((await f.call("PUT", enrollment, f.transitionBody("enabled", 2, r))).body?.code).toBe("CHANGE_STALE");
});
for (const extra of [0, 1]) it(`one-step source bound ${extra === 0 ? "exactly fits" : "+1 refuses without writes"}`, async () => {
 const f = fixture();let weight = 2 + 1 + BUILTIN_AGENT_IDS.length;
 for (let n = 0; weight + 2 <= 80; n += 1) { addProject(f, `extra-${n}`);weight += 2; }
 if (weight < 80) addAgent(f, "agt_bbbbbbbbbbbbbbbbbbbb");
 if (extra) addAgent(f, "agt_cccccccccccccccccccc");
 const before = [...f.db.items.entries()], result = await f.call("POST", reviewPath, { requestId: randomUUID(), expectedRevision: 1 });
 if (extra) { expect(result.body?.code).toBe("TASK_STOP_REVIEW_TOO_LARGE");expect([...f.db.items.entries()]).toEqual(before); }
 else {
  expect(result.status, JSON.stringify(result.body)).toBe(200);const r = result.body!;
  expect((await f.call("PUT", enrollment, f.transitionBody("ready", 1, r))).status).toBe(200);
  expect((await f.call("PUT", enrollment, f.transitionBody("enabled", 2, r))).status).toBe(200);
  expect(f.db.transactions().every(items => items.length <= 100)).toBe(true);
 }
});
it("101 active tasks refuse the review without writing anything", async () => {
 const f = fixture();for (let n = 0; n < 101; n += 1) f.task(true);const before = [...f.db.items.entries()];
 await expect(f.call("POST", reviewPath, { requestId: randomUUID(), expectedRevision: 1 })).resolves.toMatchObject({ status: 409, body: { code: "TASK_STOP_REVIEW_TOO_LARGE" } });
 expect([...f.db.items.entries()]).toEqual(before);
});
for (const resource of ["project", "agent", "builtin", "seed"] as const) it(`readiness checks inactive ${resource} sources too`, async () => {
 const f = fixture();
 if (resource === "project") { addProject(f, "unprepared");const k = projectAiKey(orgId, "unprepared"), row = f.db.get(k)!;delete row.taskStopPolicy;f.db.set(row); }
 if (resource === "agent") { addAgent(f, "agt_bbbbbbbbbbbbbbbbbbbb");const k = agentKey(orgId, "agt_bbbbbbbbbbbbbbbbbbbb", "META"), row = f.db.get(k)!;delete row.stopKind;f.db.set(row); }
 if (resource === "builtin") f.db.delete(builtinSettingsKey(orgId, BUILTIN_AGENT_IDS[0]));
 if (resource === "seed") f.db.delete({ pk: orgScoped(orgId, "TASK_STOP_SEED"), sk: "V1#bootstrap" });
 const before = [...f.db.items.entries()], result = await f.call("POST", reviewPath, { requestId: randomUUID(), expectedRevision: 1 });expect(result.status).toBe(409);expect(String(result.body?.code)).toMatch(/^TASK_STOP_CONFIG_/);
 expect([...f.db.items.entries()]).toEqual(before);
});
for (const state of ["ready", "enabled"] as const) it(`${state} requires resolving pending company Spending first`, async () => {
 const f = fixture(), r = state === "ready" ? await f.review() : await f.ready();
 f.db.set({ ...f.db.get(f.key)!, pendingTaskStopChange: { proposalId: randomUUID() } });const before = [...f.db.items.entries()];
 expect((await f.call("PUT", enrollment, f.transitionBody(state, state === "ready" ? 1 : 2, r))).body?.code).toBe("CHANGE_STALE");
 expect([...f.db.items.entries()]).toEqual(before);
});
it("disable atomically expires a pending proposal with one owner, while ready cancellation needs no REAUTH", async () => {
 const f = fixture();await f.ready();const proposalId = randomUUID();
 f.db.set({ ...f.db.get(f.key)!, pendingTaskStopChange: { proposalId } });
 f.db.set({ ...f.db.get({ pk: `SESSION#session-${owner}`, sk: "META" })!, authTime: "2020-01-01T00:00:00.000Z" });
 expect((await f.call("PUT", enrollment, f.transitionBody("disabled", 2))).status).toBe(200);
 expect(f.db.get(f.key)?.pendingTaskStopChange).toBeUndefined();expect(f.db.get(f.key)?.lastTaskStopChange).toMatchObject({ proposalId, state: "expired", reason: "enrollment_changed" });
 expect(f.changedEvents().at(-1)?.facts).toMatchObject({ before: "ready", after: "disabled", pendingExpired: true });
});
for (const from of ["disabled", "ready", "enabled"] as const) for (const to of ["disabled", "ready", "enabled"] as const)
it(`transition matrix ${from} -> ${to} with valid review terms`, async () => {
 const f = fixture();let r = from === "disabled" ? await f.review() : await f.ready();
 if (from === "ready") r = await f.review();
 if (from === "enabled") expect((await f.call("PUT", enrollment, f.transitionBody("enabled", 2, r))).status).toBe(200);
 const revision = from === "disabled" ? 1 : from === "ready" ? 2 : 3, before = [...f.db.items.entries()];
 const result = await f.call("PUT", enrollment, f.transitionBody(to, revision, to === "disabled" ? undefined : r));
 const allowed = (from === "disabled" && to === "ready") || (from === "ready" && to !== "ready") || (from === "enabled" && to === "disabled");
 if (allowed) expect(result.status).toBe(200);else { expect(result.body?.code).toBe("CHANGE_STALE");expect([...f.db.items.entries()]).toEqual(before); }
});
it("another owner cannot consume a private review but can enable with their own fresh one", async () => {
 const f = fixture(), r = await f.review(), caller = { developerId: other, sessionId: `session-${other}` };
 expect((await f.call("PUT", enrollment, f.transitionBody("ready", 1, r), caller)).body?.code).toBe("FORBIDDEN");
 expect((await f.call("PUT", enrollment, f.transitionBody("ready", 1, r))).status).toBe(200);
 const fresh = await f.call("POST", reviewPath, { requestId: randomUUID(), expectedRevision: 2 }, caller);expect(fresh.status).toBe(200);
 expect((await f.call("PUT", enrollment, f.transitionBody("enabled", 2, fresh.body), caller)).status).toBe(200);
});
for (const route of ["read", "review", "enable", "disable"] as const) it(`foreign live pointer refuses ${route} before revealing company state`, async () => {
 const f = fixture(), r = await f.ready();f.db.set({ ...f.db.get(developerOrgKey(owner))!, orgId: foreignOrg });const before = [...f.db.items.entries()];
 const result = route === "read" ? await f.call("GET", enrollment) : route === "review" ? await f.call("POST", reviewPath, { requestId: randomUUID(), expectedRevision: 2 })
  : await f.call("PUT", enrollment, f.transitionBody(route === "enable" ? "enabled" : "disabled", 2, route === "enable" ? r : undefined));
 expect(result.status).toBe(403);expect(result.body).toEqual({ code: "FORBIDDEN" });expect([...f.db.items.entries()]).toEqual(before);
});
it("review replay returns the same opaque review id without writes; receipts have TTL", async () => {
 const f = fixture(), body = { requestId: randomUUID(), expectedRevision: 1 }, first = await f.call("POST", reviewPath, body);expect(first.status).toBe(200);
 const before = [...f.db.items.entries()];expect(await f.call("POST", reviewPath, body)).toEqual(first);expect([...f.db.items.entries()]).toEqual(before);
 expect(f.db.find(row => row.entityType === "AGENT_REQUEST").every(row => typeof row[INDEX_EXPIRY_ATTRIBUTE] === "number")).toBe(true);
 f.db.set({ ...f.db.get(orgMemberKey(orgId, owner))!, role: "admin" });
 expect(await f.call("POST", reviewPath, body)).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
});
for (const mismatch of ["table", "client"]) it(`audit ${mismatch} mismatch cannot commit enrollment`, async () => {
 const f = fixture(), r = await f.review();if (mismatch === "table") f.audit.audit.tableName = "other";else f.audit.audit.documentClient = new FakeDynamoDb() as unknown as typeof f.audit.audit.documentClient;
 const before = [...f.db.items.entries()];expect((await f.call("PUT", enrollment, f.transitionBody("ready", 1, r))).body?.code).toBe("AUDIT_UNAVAILABLE");expect([...f.db.items.entries()]).toEqual(before);
});
it("enable audit contains reviewed counts and no task text", async () => {
 const f = fixture(), id = f.task(true), r = await f.ready();expect(f.db.get({ pk: `DEVTASK#${id}`, sk: "META" })?.title).toBe("Private task title");
 expect((await f.call("PUT", enrollment, f.transitionBody("enabled", 2, r))).status).toBe(200);
 const event = f.changedEvents().at(-1)!;expect(event.facts).toMatchObject({ before: "ready", after: "enabled", revision: 3, tasksReviewed: 1, tasksAtEnable: 1, reviewId: r.reviewId, reviewDigest: r.digest });
 expect(JSON.stringify(event)).not.toMatch(/Private task title|sourceChecks|ConditionExpression|DEVTASK/);
});
it("queued settled spend at the new positive stop is a new_window_at_stop impact", async () => {
 const f = fixture(), id = f.task(true);f.db.set({ ...taskSpendKey(orgId, id), entityType: "TASK_SPENT", orgId, settledUsd: 2 });
 const r = await f.review();expect(r.tasks).toEqual([expect.objectContaining({ taskId: id, outcome: "new_window_at_stop" })]);
});
for (const corrupt of ["foreign-task", "bad-pointer"] as const) it(`review refuses ${corrupt} index links instead of skipping them`, async () => {
 const f = fixture(), id = f.task(true), row = f.db.get({ pk: `DEVTASK#${id}`, sk: "META" })!;
 if (corrupt === "foreign-task") f.db.set({ ...row, orgId: foreignOrg });else f.db.set({ pk: `WORKSPACE#${String(row.workspaceId)}`, sk: "DEVELOPER_TASK", taskId: 123 });
 const before = [...f.db.items.entries()];expect((await f.call("POST", reviewPath, { requestId: randomUUID(), expectedRevision: 1 })).status).not.toBe(200);expect([...f.db.items.entries()]).toEqual(before);
});
it("an agent-run task reachable twice appears exactly once in the review", async () => {
 const f = fixture(), id = f.task(true), row = f.db.get({ pk: `DEVTASK#${id}`, sk: "META" })!, workspaceId = randomUUID();
 f.db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "META", id: workspaceId, orgId, projectName: "web", workspaceProject: workspaceProjectIndexValue(orgId, "web"), workspaceCreatedAt: new Date(initialNow).toISOString() });
 f.db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "DEVELOPER_TASK", taskId: id });
 expect(row.agent).toMatchObject({ agentId });const r = await f.review();expect(r.tasks).toHaveLength(1);
});
for (const edge of ["enable", "disable"] as const) it(`${edge} lost acknowledgement recovers one outcome and audit`, async () => {
 const f = fixture(), r = await f.ready();if (edge === "disable") await f.call("PUT", enrollment, f.transitionBody("enabled", 2, r));const count = f.changedEvents().length;
 const send = f.db.send.bind(f.db);let lost = false;
 f.db.send = async command => { const answer = await send(command);if (!lost && isPolicyPut(command)) { lost = true;throw new Error("lost acknowledgement"); }return answer; };
 expect((await f.call("PUT", enrollment, f.transitionBody(edge === "enable" ? "enabled" : "disabled", edge === "enable" ? 2 : 3, edge === "enable" ? r : undefined))).status).toBe(200);
 expect(lost).toBe(true);expect(f.changedEvents()).toHaveLength(count + 1);
});
it("review base revision is checked independently of expectedRevision", async () => {
 const f = fixture(), r = await f.review();f.db.set({ ...f.db.get(f.key)!, revision: 2 });
 expect((await f.call("PUT", enrollment, f.transitionBody("ready", 2, r))).body?.code).toBe("CHANGE_STALE");
});

it("an enabled review from another org is missing even for the other org's owner", async () => {
 const f = fixture(), r = await f.ready();
 f.db.set({ ...orgMetaKey(foreignOrg), orgId: foreignOrg, entityType: "ORG" });f.db.set({ ...orgMemberKey(foreignOrg, other), orgId: foreignOrg, developerId: other, role: "owner" });f.db.set({ ...developerOrgKey(other), orgId: foreignOrg, role: "owner" });
 const key = orgSettingsKey(foreignOrg, "TASK_STOP_POLICY");f.db.set({ ...f.db.get(f.key)!, ...key, orgId: foreignOrg });const before = [...f.db.items.entries()];
 expect(await f.call("PUT", enrollment, f.transitionBody("enabled", 2, r), { orgId: foreignOrg, developerId: other, sessionId: `session-${other}` })).toMatchObject({ status: 404, body: { code: "NOT_FOUND" } });expect([...f.db.items.entries()]).toEqual(before);
});
it("freshness preflight is owner-only and rejects session invalidated by sessionsEndedAt", async () => {
 const f = fixture();f.db.set({ ...f.db.get({ pk: `DEVELOPER#${owner}`, sk: "META" })!, sessionsEndedAt: new Date(initialNow).toISOString() });
 expect((await f.call("GET", enrollment + "?fresh=1")).body?.code).toBe("REAUTH_REQUIRED");
});
for (const state of ["ready", "enabled"] as const) it(`M2 ${state} row with sibling binding is compatible with native readers`, async () => {
 const f = fixture(), r = await f.ready();if (state === "enabled") await f.call("PUT", enrollment, f.transitionBody("enabled", 2, r));
 const source = f.db.get(f.key)!;expect(source.enrollment).toEqual({ version: 1, state });expect(source.enrollmentReview).toMatchObject({ reviewId: r.reviewId, digest: r.digest, by: owner });
 const input = { orgId, developerId: owner, role: "owner", project: "web", agentId, pathLimitMicrousd: 20_000_000 }, captured = await captureTaskStopAdmission({ ...f.deps, requireScopeAccess: async () => {} }, input);
 expect(captured).toMatchObject(state === "ready" ? { kind: "disabled" } : { kind: "captured", effectiveStopMicrousd: 2_000_000 });
 const { requirePricedTaskStopAdmission } = await import("../../packages/broker/src/org/task-stop-unpriced.js");
 if (state === "ready") await expect(requirePricedTaskStopAdmission(f.deps, { orgId, actor: { kind: "member", id: owner }, workKind: "test" })).resolves.toBeUndefined();
 else await expect(requirePricedTaskStopAdmission(f.deps, { orgId, actor: { kind: "member", id: owner }, workKind: "test" })).rejects.toMatchObject({ code: "TASK_STOP_CONFIG_MISSING" });
 const { captureTaskFundingProof } = await import("../../packages/broker/src/org/task-stop-funding.js");let reads = 0;
 await captureTaskFundingProof({ ...f.deps, routing: { sources: { read: async () => { reads += 1;return { revision: 0, sources: [], order: ["rovara"], credentials: [], removing: [] }; } } } }, { orgId, project: "web", models: [] });
 expect(reads).toBe(state === "ready" ? 0 : 1);
 const { bootstrapTaskStopPolicy } = await import("../../packages/broker/src/org/task-stop-bootstrap.js");
 expect(await bootstrapTaskStopPolicy(f.deps, orgId)).toEqual({ outcome: "preserved" });expect(f.db.get(f.key)).toEqual(source);
});
it("disable preserves an accepted window's captured stop", async () => {
 const f = fixture(), r = await f.ready();await f.call("PUT", enrollment, f.transitionBody("enabled", 2, r));
 const snapshot = await captureTaskStopAdmission({ ...f.deps, requireScopeAccess: async () => {} }, { orgId, developerId: owner, role: "owner", project: "web", agentId, pathLimitMicrousd: 20_000_000 });
 const id = f.task(false), key = { pk: `DEVTASK#${id}`, sk: "META" };f.db.set({ ...f.db.get(key)!, spendingStop: snapshot, budgetUsd: 2 });const before = f.db.get(key);
 expect((await f.call("PUT", enrollment, f.transitionBody("disabled", 3))).status).toBe(200);expect(f.db.get(key)).toEqual(before);
});
it("a demoted owner cannot replay an enrollment outcome", async () => {
 const f = fixture(), r = await f.review(), body = f.transitionBody("ready", 1, r);expect((await f.call("PUT", enrollment, body)).status).toBe(200);
 f.db.set({ ...f.db.get(orgMemberKey(orgId, owner))!, role: "member" });expect(await f.call("PUT", enrollment, body)).toEqual({ status: 403, body: { code: "FORBIDDEN" } });
});
it("read-only review metadata also fences owner loss at its commit", async () => {
 const f = fixture(), send = f.db.send.bind(f.db), beforePolicy = f.db.get(f.key);let raced = false;
 f.db.send = async command => { if (!raced && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Put?.Item?.entityType === "TASK_STOP_REVIEW")) { raced = true;f.db.set({ ...f.db.get(orgMemberKey(orgId, owner))!, role: "member" }); }return send(command); };
 expect((await f.call("POST", reviewPath, { requestId: randomUUID(), expectedRevision: 1 })).body?.code).toBe("FORBIDDEN");expect(raced).toBe(true);
 expect(f.db.find(row => row.entityType === "TASK_STOP_REVIEW" || row.entityType === "AGENT_REQUEST")).toEqual([]);expect(f.db.get(f.key)).toEqual(beforePolicy);
});

it("Spending editor can read a pending proposal expired by enforcement disable", async () => {
 const f = fixture();await f.ready();f.db.set({ ...f.db.get(f.key)!, pendingTaskStopChange: { proposalId: randomUUID() } });
 expect((await f.call("PUT", enrollment, f.transitionBody("disabled", 2))).status).toBe(200);
 expect((await f.call("GET", base + "/editing")).status).toBe(200);
});

it("disable audit retains the bound review id and digest", async () => {
 const f = fixture(), r = await f.ready();await f.call("PUT", enrollment, f.transitionBody("enabled", 2, r));
 expect((await f.call("PUT", enrollment, f.transitionBody("disabled", 3))).status).toBe(200);
 expect(f.changedEvents().at(-1)?.facts).toMatchObject({ reviewId: r.reviewId, reviewDigest: r.digest });
});
it("queued review refuses incomplete persisted review evidence without writes", async () => {
 const f = fixture(), r = await f.review(), row = f.db.find(row => row.entityType === "TASK_STOP_REVIEW")[0]!;
 f.db.set({ ...row, review: { ...(row.review as Row), complete: false } });const before = [...f.db.items.entries()];
 expect((await f.call("PUT", enrollment, f.transitionBody("ready", 1, r))).body?.code).toBe("CHANGE_STALE");expect([...f.db.items.entries()]).toEqual(before);
});
it("cutover metadata fences a policy edit during review capture", async () => {
 const f = fixture(), send = f.db.send.bind(f.db);let raced = false;
 f.db.send = async command => { if (!raced && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Put?.Item?.entityType === "TASK_STOP_REVIEW")) { raced = true;f.db.set({ ...f.db.get(f.key)!, revision: 2 }); }return send(command); };
 expect((await f.call("POST", reviewPath, { requestId: randomUUID(), expectedRevision: 1 })).body?.code).toBe("CHANGE_STALE");expect(raced).toBe(true);expect(f.db.find(row => row.entityType === "TASK_STOP_REVIEW" || row.entityType === "AGENT_REQUEST")).toEqual([]);
});
it("an audit delivery outage leaves policy, receipt and pending event committed together", async () => {
 const f = fixture(), r = await f.review();f.audit.queueDown();
 expect((await f.call("PUT", enrollment, f.transitionBody("ready", 1, r))).status).toBe(200);
 expect(f.audit.pending().filter(event => event.action === "spending.enrollment_changed")).toHaveLength(1);
 const tx = f.db.transactions().find(items => items.some(item => (item.Put as { Item?: { entityType?: string } } | undefined)?.Item?.entityType === "ORG_TASK_STOP_POLICY"))!;
 expect(tx.some(item => (item.Put as { Item?: { entityType?: string } } | undefined)?.Item?.entityType === "AGENT_REQUEST")).toBe(true);
 expect(tx.some(item => (item.Put as { Item?: { event?: { action?: string } } } | undefined)?.Item?.event?.action === "spending.enrollment_changed")).toBe(true);
});
it("a different body cannot reuse a review request id even after policy movement", async () => {
 const f = fixture(), body = { requestId: randomUUID(), expectedRevision: 1 };expect((await f.call("POST", reviewPath, body)).status).toBe(200);
 const receipt = f.db.find(row => row.entityType === "AGENT_REQUEST");expect(receipt).toHaveLength(1);expect(receipt[0]?.[INDEX_EXPIRY_ATTRIBUTE]).toBeGreaterThan(initialNow / 1000);
 expect((await f.call("POST", reviewPath, { ...body, expectedRevision: 2 })).body?.code).toBe("CONFIG_INVALID");
});

it("caller revision must match even when the review itself is current", async () => {
 const f = fixture(), r = await f.review(), before = [...f.db.items.entries()];
 expect((await f.call("PUT", enrollment, f.transitionBody("ready", 2, r))).body?.code).toBe("CHANGE_STALE");expect([...f.db.items.entries()]).toEqual(before);
});
it("complete review digests are stable across the ready revision bump", async () => {
 const f = fixture();f.task(true);const first = await f.review();
 expect((await f.call("PUT", enrollment, f.transitionBody("ready", 1, first))).status).toBe(200);
 const second = await f.review();expect(second.digest).toBe(first.digest);
});

for (const route of ["read", "review", "write"] as const) it(`browser session is required before any ${route} lookup`, async () => {
 const f = fixture(), before = [...f.db.items.entries()], caller = { browserSession: false };
 const result = route === "read" ? await f.call("GET", enrollment, undefined, caller) : route === "review" ? await f.call("POST", reviewPath, { requestId: randomUUID(), expectedRevision: 1 }, caller) : await f.call("PUT", enrollment, f.transitionBody("disabled", 1), caller);
 expect(result).toEqual({ status: 403, body: { code: "FORBIDDEN" } });expect([...f.db.items.entries()]).toEqual(before);
});
for (const resource of ["company", "ceiling"] as const) it(`inactive ${resource} cannot carry a second ceiling`, async () => {
 const f = fixture(), key = resource === "company" ? f.key : agentGuardrailsKey(orgId);f.db.set({ ...f.db.get(key)!, ceilingMicrousd: 1 });const before = [...f.db.items.entries()];
 expect(await f.call("POST", reviewPath, { requestId: randomUUID(), expectedRevision: 1 })).toMatchObject({ status: 409, body: { code: "TASK_STOP_CONFIG_INVALID" } });expect([...f.db.items.entries()]).toEqual(before);
});
it("company readiness rejects an unrepresentable microdollar ceiling before any tasks exist", async () => {
 const f = fixture(), key = agentGuardrailsKey(orgId);f.db.set({ ...f.db.get(key)!, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, maxPerRunCeilingUsd: 0.0000001 } });
 expect(await f.call("POST", reviewPath, { requestId: randomUUID(), expectedRevision: 1 })).toMatchObject({ status: 409, body: { code: "TASK_STOP_CONFIG_INVALID" } });
});

it("owner authority precedes malformed JSON validation", async () => {
 const f = fixture();f.db.set({ ...f.db.get(orgMemberKey(orgId, owner))!, role: "admin" });f.db.set({ ...f.db.get(developerOrgKey(owner))!, role: "admin" });
 expect(await f.call("PUT", enrollment, "{broken")).toEqual({ status: 403, body: { code: "FORBIDDEN" } });
 expect(await f.call("POST", reviewPath, "{broken")).toEqual({ status: 403, body: { code: "FORBIDDEN" } });
});

for (const corrupt of [{ ceilingMicrousd: 1 }, { policy: { broken: true } }]) it(`emergency disable preserves malformed content ${JSON.stringify(corrupt)}`, async () => {
 const f = fixture(), r = await f.ready();await f.call("PUT", enrollment, f.transitionBody("enabled", 2, r));
 f.db.set({ ...f.db.get(f.key)!, ...corrupt });const count = f.changedEvents().length;
 expect(await f.call("GET", enrollment)).toMatchObject({ status: 200, body: { state: "enabled" } });
 expect(await f.call("PUT", enrollment, f.transitionBody("disabled", 3))).toMatchObject({ status: 200, body: { revision: 4 } });
 expect(f.db.get(f.key)).toMatchObject(corrupt);expect(f.changedEvents()).toHaveLength(count + 1);
});
it("26 queued tasks are counted with a bounded list and can enable", async () => {
 const f = fixture();for (let n = 0; n < 26; n += 1) f.task(true);
 const r = await f.ready();expect(r.counts).toEqual({ refuse_next_admission: 0, new_window_at_stop: 26, retain_current_window: 0, exempt: 0 });
 expect(r.truncated).toBe(true);expect((r.tasks as Row[]).length).toBeLessThanOrEqual(25);
 expect(await f.call("PUT", enrollment, f.transitionBody("enabled", 2, r))).toMatchObject({ status: 200, body: { tasksReviewed: 26, tasksAtEnable: 26 } });
});
it("keys without TASK_SPENT do not block review; disabled-era requested limit binds", async () => {
 const f = fixture(), id = f.task(true), key = { pk: `DEVTASK#${id}`, sk: "META" };
 f.db.set({ ...f.db.get(key)!, modelKeyIds: ["key"], requestedRunLimitUsd: 0.5 });
 const r = await f.review();expect(r.tasks).toEqual([expect.objectContaining({ taskId: id, effectiveStopMicrousd: 500000, outcome: "new_window_at_stop" })]);
});

it("readiness names the first unprepared checked project", async () => {
 const f = fixture();addProject(f, "unprepared");const key = projectAiKey(orgId, "unprepared"), row = f.db.get(key)!;delete row.taskStopPolicy;f.db.set(row);
 expect(await f.call("POST", reviewPath, { requestId: randomUUID(), expectedRevision: 1 })).toMatchObject({ status: 409, body: { code: "TASK_STOP_CONFIG_MISSING", resource: { kind: "project", name: "unprepared" } } });
});

it("enrollment request identity stays in the private receipt and audit, outside the wire result", async () => {
 const f = fixture(), review = await f.review(), body = f.transitionBody("ready", 1, review);
 const reply = await f.call("PUT", enrollment, body);expect(reply.status).toBe(200);expect(reply.body).not.toHaveProperty("requestId");
 expect(f.db.get(agentRequestKey(orgId, owner, String(body.requestId)))).toMatchObject({ entityType: "AGENT_REQUEST", result: { state: "ready", revision: 2 } });
 expect(f.changedEvents().at(-1)?.facts).toMatchObject({ requestId: body.requestId });
 expect(await f.call("PUT", enrollment, body)).toEqual(reply);expect(f.changedEvents()).toHaveLength(1);
});
