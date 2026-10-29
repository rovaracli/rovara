import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { AgentXError, developerOrgKey, errorStatus, orgMemberKey, orgMetaKey, orgScoped } from "@agentx/contracts";
import { routeDeveloperRequest, type DeveloperCaller, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb", actor = "a".repeat(64), colleague = "b".repeat(64), foreign = "c".repeat(64);
function fixture() {
 const db = new FakeDynamoDb();let now = Date.parse("2026-10-27T12:00:00Z");const capture = capturingAuditDeps({ db, now: () => now });
 function member(who = actor, role = "owner", orgId = A) { db.set({ ...orgMemberKey(orgId, who), orgId, developerId: who, role });db.set({ ...developerOrgKey(who), orgId, role }); }
 for (const orgId of [A, B]) db.set({ ...orgMetaKey(orgId), orgId, name: "Company", plan: "team" });member();member(colleague, "admin");member(foreign, "owner", B);
 const store = new OrgStore({ documentClient: db, tableName: "state", now: () => now });
 const deps: DeveloperRouteDependencies = { documentClient: db, tableName: "state", now: () => now, orgs: store, audit: capture.audit, developer: { issuer: "https://cell.example/v1/auth", env: "test", signInTableName: "signin", methods: { cloud: true, slack: false, oidc: false }, verifyAccessToken: async () => ({}), channelMembers: async () => ({ ok: true, memberOf: [] }) } };
 const caller: DeveloperCaller = { orgId: A, developerId: actor, orgRole: "owner", name: "Person", amr: "cloud", sessionId: "fixture" };
 async function call(method: string, path: string, body?: unknown, as = caller) { try { const result = await routeDeveloperRequest(deps, { method, path, headers: {}, requestId: "rate-fixture", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, new URL(path, "https://cell.example"), { caller: as, csrf: "" });return { status: result === undefined ? 404 : 200, code: undefined as string | undefined }; }catch (error) { if (!(error instanceof AgentXError)) throw error;return { status: errorStatus(error.code), code: error.code }; } }
 const create = (body: unknown = { requestId: randomUUID(), role: "member" }, as = caller) => call("POST", "/v1/app/org/invites", body, as);
 const revoke = (id: string, requestId = randomUUID(), as = caller) => call("POST", `/v1/app/org/invites/${id}/revoke`, { requestId, expectedRevision: 0 }, as);
 const counter = (kind: "CREATE" | "REVOKE", orgId = A, who = actor) => db.get({ pk: orgScoped(orgId, `INVITE_${kind}_RATE`), sk: who });
 const ids = () => db.find(row => row.entityType === "ORG_INVITE_DIRECTORY").map(row => String(row.inviteId));
 return { db, deps, store, caller, create, revoke, counter, ids, member, call, advance(ms: number) { now += ms; } };
}
it("limits creation to 20 per org/caller/minute before any business transaction and resets next minute", async () => {
 const f = fixture();for (let i = 0; i < 20; i++) expect((await f.create()).status).toBe(200);const before = f.db.transactions().length;expect((await f.create()).status).toBe(429);expect(f.counter("CREATE")?.count).toBe(20);expect(f.db.transactions().length).toBe(before);expect(f.ids().length).toBe(20);f.advance(60000);expect((await f.create()).status).toBe(200);expect(f.counter("CREATE")?.count).toBe(1);
});
it("creation admission also covers internal store callers", async () => {
 const f = fixture();for (let i = 0; i < 20; i++) await f.store.createInvite({ orgId: A, createdBy: actor, role: "member" });const result = await f.store.createInvite({ orgId: A, createdBy: actor, role: "member" }).then(() => "created", error => error instanceof AgentXError ? error.code : "unknown");expect(result).toBe("TOO_MANY_REQUESTS");expect(f.ids().length).toBe(20);
});
it("isolates create, revoke and list quotas and another org and caller", async () => {
 const f = fixture();for (let i = 0; i < 20; i++) await f.create();expect((await f.create()).status).toBe(429);expect((await f.create(undefined, { ...f.caller, developerId: colleague })).status).toBe(200);expect((await f.create(undefined, { ...f.caller, orgId: B, developerId: foreign })).status).toBe(200);expect((await f.revoke(f.ids()[0]!)).status).toBe(200);expect((await f.call("GET", "/v1/app/org/invites")).status).toBe(200);expect(f.counter("CREATE")?.count).toBe(20);expect(f.counter("CREATE", A, colleague)?.count).toBe(1);expect(f.counter("CREATE", B, foreign)?.count).toBe(1);expect(f.counter("REVOKE")?.count).toBe(1);f.member(actor, "owner", B);expect((await f.create(undefined, { ...f.caller, orgId: B })).status).toBe(200);expect(f.counter("CREATE", B, actor)?.count).toBe(1);expect(f.counter("CREATE", A, actor)?.count).toBe(20);
});
it("bounds valid replay attempts without reapplying a creation or revocation", async () => {
 const f = fixture(), requestId = randomUUID();expect((await f.create({ requestId, role: "member" })).status).toBe(200);for (let i = 1; i < 20; i++) expect((await f.create({ requestId, role: "member" })).status).toBe(409);expect((await f.create({ requestId, role: "member" })).status).toBe(429);expect(f.ids().length).toBe(1);
 const id = f.ids()[0]!, revokeId = randomUUID();for (let i = 0; i < 20; i++) expect((await f.revoke(id, revokeId)).status).toBe(200);const before = f.db.transactions().length;expect((await f.revoke(id, revokeId)).status).toBe(429);expect(f.db.transactions().length).toBe(before);expect(f.counter("REVOKE")?.count).toBe(20);f.advance(60000);expect((await f.revoke(id, revokeId)).status).toBe(200);expect(f.db.transactions().length).toBe(before);
});
it("does not charge malformed or denied create/revoke requests to new or existing counters", async () => {
 for (const existing of [false, true]) { const f = fixture();expect((await f.create()).status).toBe(200);const id = f.ids()[0]!;if (existing) await f.revoke(id);else f.db.delete({ pk: orgScoped(A, "INVITE_CREATE_RATE"), sk: actor });const before = JSON.stringify([f.counter("CREATE"), f.counter("REVOKE")]);expect((await f.create({ requestId: "invalid", role: "member" })).status).toBe(400);expect((await f.create({ requestId: randomUUID(), role: "owner" })).status).toBe(400);expect((await f.call("POST", `/v1/app/org/invites/${id}/revoke`, { requestId: randomUUID() })).status).toBe(400);expect((await f.revoke("bad-uuid")).status).toBe(400);f.member(actor, "member");expect((await f.create()).status).toBe(403);expect((await f.revoke(id)).status).toBe(403);expect(JSON.stringify([f.counter("CREATE"), f.counter("REVOKE")])).toBe(before); }
});
for (const kind of ["CREATE", "REVOKE"] as const) it(`fails closed on ${kind.toLowerCase()} counter storage before business writes`, async () => {
 const f = fixture();if (kind === "REVOKE") await f.create();const before = f.db.transactions().length;f.db.injectFault({ command: "UpdateCommand", match: input => (input.Key as { pk?: string }).pk === orgScoped(A, `INVITE_${kind}_RATE`), error: { name: "ServiceUnavailable", message: "private upstream fixture" } });const result = kind === "CREATE" ? await f.create() : await f.revoke(f.ids()[0]!);expect(result.status).toBe(503);expect(f.db.transactions().length).toBe(before);expect(f.db.find(row => row.entityType === "ORG_INVITE_REVOKE_REQUEST").length).toBe(0);expect(f.db.find(row => row.entityType === "ORG_INVITE" && row.revokedAt !== undefined).length).toBe(0);
});
for (const kind of ["CREATE", "REVOKE"] as const) it(`admits only one of two concurrent ${kind.toLowerCase()} attempts at the quota boundary`, async () => {
 const f = fixture();let attempt: () => Promise<{ status: number }>;
 if (kind === "CREATE") { for (let i = 0; i < 19; i++) await f.create();attempt = () => f.create(); }else { await f.create();const id = f.ids()[0]!, requestId = randomUUID();for (let i = 0; i < 19; i++) await f.revoke(id, requestId);attempt = () => f.revoke(id, requestId); }
 const results = await Promise.all([attempt(), attempt()]);expect(results.map(result => result.status).sort()).toEqual([200, 429]);expect(f.counter(kind)?.count).toBe(20);
});
it("charges authorized missing targets but never an absent/mismatched audit runtime on reviewed revoke", async () => {
 const f = fixture();for (let i = 0; i < 20; i++) expect((await f.revoke(randomUUID())).status).toBe(404);expect((await f.revoke(randomUUID())).status).toBe(429);expect(f.counter("REVOKE")?.count).toBe(20);
 for (const mismatch of [false, true]) { const fresh = fixture();if (mismatch) fresh.deps.audit = { ...fresh.deps.audit!, tableName: "other-state" };else delete fresh.deps.audit;expect((await fresh.revoke(randomUUID())).status).toBe(503);expect(fresh.counter("REVOKE") === undefined).toBe(true); }
});

it("does not let one revoker exhaust another caller or the same person's next request org", async () => {
 const f = fixture();await f.create();const id = f.ids()[0]!, requestId = randomUUID();for (let i = 0; i < 20; i++) expect((await f.revoke(id, requestId)).status).toBe(200);expect((await f.revoke(id, requestId)).status).toBe(429);expect((await f.revoke(id, randomUUID(), { ...f.caller, developerId: colleague })).code).toBe("INVITE_ALREADY_REVOKED");expect((await f.call("GET", "/v1/app/org/invites")).status).toBe(200);
 f.member(actor, "owner", B);const moved = { ...f.caller, orgId: B };expect((await f.create(undefined, moved)).status).toBe(200);const theirs = f.db.find(row => row.entityType === "ORG_INVITE_DIRECTORY" && row.orgId === B)[0]!;expect((await f.revoke(String(theirs.inviteId), randomUUID(), moved)).status).toBe(200);expect(f.counter("REVOKE", B, actor)?.count).toBe(1);expect(f.counter("REVOKE", A, actor)?.count).toBe(20);
});
