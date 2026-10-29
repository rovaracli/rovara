import { createHash, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { AgentXError, AuditEventInputSchema, errorStatus, developerOrgKey, orgInviteDirectoryKey, orgInviteKey, orgMemberKey, orgMetaKey, orgScoped } from "@agentx/contracts";
import { routeDeveloperRequest, type DeveloperCaller, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { inviteTokenHash } from "../../packages/broker/src/org/invite-url.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb", actor = "a".repeat(64), other = "b".repeat(64), newcomer = "d".repeat(64);
const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");
async function fixture(eventual = false) {
 const db = new FakeDynamoDb(eventual ? { consistency: "eventual" } : undefined);let now = Date.parse("2026-10-27T12:00:00Z");
 for (const orgId of [A, B]) db.set({ ...orgMetaKey(orgId), orgId, name: "Company", plan: "team" });
 function member(who = actor, role = "owner", orgId = A) { db.set({ ...orgMemberKey(orgId, who), orgId, developerId: who, role });db.set({ ...developerOrgKey(who), orgId, role }); }
 member();member(other);
 const capture = capturingAuditDeps({ db, now: () => now }), store = new OrgStore({ documentClient: db, tableName: "state", now: () => now });
 const deps: DeveloperRouteDependencies = { documentClient: db, tableName: "state", now: () => now, orgs: store, audit: capture.audit, developer: { issuer: "https://cell.example/v1/auth", env: "test", signInTableName: "signin", methods: { cloud: true, slack: false, oidc: false }, verifyAccessToken: async () => ({}), channelMembers: async () => ({ ok: true, memberOf: [] }) } };
 const caller: DeveloperCaller = { orgId: A, developerId: actor, orgRole: "member", name: "Person", amr: "cloud", sessionId: "fixture" };
 async function invite() { const created = await store.createInvite({ orgId: A, createdBy: actor, role: "member", email: "private.person@example.test" });const key = orgInviteKey(hashOf(created.token)), row = db.get(key)!;return { ...created, key, id: String(row.inviteId), row }; }
 const created = await invite();const requestId = randomUUID();
 let before: (() => Promise<void>) | undefined;const send = db.send.bind(db);
 db.send = async command => { if (command.constructor.name === "TransactWriteCommand" && before !== undefined) { const run = before;before = undefined;await run(); }return send(command); };
 async function call(id = created.id, body: unknown = { requestId, expectedRevision: 0 }, as = caller) {
  const path = `/v1/app/org/invites/${id}/revoke`;
  try { const value = await routeDeveloperRequest(deps, { method: "POST", path, headers: {}, requestId: "revoke-fixture", body: JSON.stringify(body) }, new URL(path, "https://cell.example"), { caller: as, csrf: "" });return { status: value === undefined ? 404 : 200, body: value as Record<string, unknown> | undefined, code: undefined as string | undefined }; }
  catch (error) { if (!(error instanceof AgentXError)) throw error;return { status: errorStatus(error.code), code: error.code, body: undefined }; }
 }
 async function status(id = created.id, as = caller) {
  const path = `/v1/app/org/invites/${id}`;
  try { const value = await routeDeveloperRequest(deps, { method: "GET", path, headers: {}, requestId: "invite-status" }, new URL(path, "https://cell.example"), { caller: as, csrf: "" });return { status: value === undefined ? 404 : 200, body: value as Record<string, unknown> | undefined, code: undefined as string | undefined }; }
  catch (error) { if (!(error instanceof AgentXError)) throw error;return { status: errorStatus(error.code), code: error.code, body: undefined }; }
 }
 const events = () => [...capture.pending(), ...capture.flushed()].filter(event => String(event.action) === "org.invite_revoked");
 return { db, deps, capture, store, caller, created, requestId, member, invite, call, status, events, beforeCommit(run: () => Promise<void>) { before = run; }, advance(ms: number) { now += ms; } };
}
for (const [role, status] of [["owner", 200], ["admin", 200], ["member", 403], ["maintainer", 403], ["viewer", 403], ["future-role", 403]] as const) it(`allows revocation only with live ${role} authority`, async () => {
 const f = await fixture();f.member(actor, role);const result = await f.call();expect(result.status).toBe(status);expect(f.db.get(f.created.key)?.revokedAt !== undefined).toBe(status === 200);expect(f.events().length).toBe(status === 200 ? 1 : 0);
});
it("atomically stores a safe receipt and audit and replays the original result without another write", async () => {
 const f = await fixture(), first = await f.call();expect(first.status).toBe(200);expect(first.body).toEqual({ inviteId: f.created.id, revokedAt: "2026-10-27T12:00:00.000Z", revision: 1 });const count = f.db.transactions().length;f.advance(1000);expect(await f.call()).toEqual(first);expect(f.db.transactions().length).toBe(count);expect(f.events().length).toBe(1);
 const tx = f.db.transactions().at(-1)!;const puts = tx.map(item => (item.Put as { Item?: Record<string, unknown> } | undefined)?.Item);expect(tx.length).toBeLessThanOrEqual(8);expect(puts.some(item => item?.entityType === "ORG_INVITE_REVOKE_REQUEST")).toBe(true);expect(puts.some(item => typeof item?.pk === "string" && item.pk.startsWith("AUDIT_PENDING#"))).toBe(true);
 const receipt = f.db.get({ pk: orgScoped(A, "INVITE_REVOKE"), sk: f.requestId })!;expect(receipt.indexExpiresAt).toBe(Date.parse("2026-10-28T12:00:00Z") / 1000);const output = JSON.stringify([first.body, receipt, f.events()]);expect(output.includes(f.created.token) || output.includes(hashOf(f.created.token)) || output.includes("private.person") || output.includes("example.test")).toBe(false);expect(f.events()[0]).toMatchObject({ action: "org.invite_revoked", target: { kind: "invite", id: f.created.id }, facts: { role: "member" } });
});
it("binds replay to actor and target and rechecks authority even for a successful receipt", async () => {
 const f = await fixture();expect((await f.call()).status).toBe(200);const second = await f.invite();expect((await f.call(second.id)).status).toBe(400);expect((await f.call(f.created.id, { requestId: f.requestId, expectedRevision: 0 }, { ...f.caller, developerId: other })).status).toBe(400);expect(f.db.get(second.key)?.revokedAt).toBeUndefined();f.member(actor, "member");expect((await f.call()).status).toBe(403);expect(f.events().length).toBe(1);
});
it("never authorizes another request org or a missing/misbound membership or pointer", async () => {
 for (const change of ["foreign", "missing", "member-org", "member-person", "pointer-org", "pointer-role"] as const) { const f = await fixture();if (change === "foreign") { expect((await f.call(f.created.id, { requestId: f.requestId, expectedRevision: 0 }, { ...f.caller, orgId: B })).status).toBe(403);continue; }if (change === "missing") f.db.delete(orgMemberKey(A, actor));else if (change === "member-org") f.db.set({ ...f.db.get(orgMemberKey(A, actor)), orgId: B });else if (change === "member-person") f.db.set({ ...f.db.get(orgMemberKey(A, actor)), developerId: other });else if (change === "pointer-org") f.db.set({ ...developerOrgKey(actor), orgId: B, role: "owner" });else f.db.set({ ...developerOrgKey(actor), orgId: A, role: "member" });expect((await f.call()).status).toBe(403);expect(f.db.get(f.created.key)?.revokedAt).toBeUndefined(); }
});
it("does not reveal a foreign invite or a missing, corrupt or misbound reference/canonical record", async () => {
 for (const change of ["foreign", "reference-missing", "reference-org", "reference-id", "canonical-org", "canonical-id", "canonical-hash"] as const) { const f = await fixture();const ref = orgInviteDirectoryKey(A, f.created.id);if (change === "foreign") { f.member(actor, "owner", B);expect((await f.call(f.created.id, { requestId: f.requestId, expectedRevision: 0 }, { ...f.caller, orgId: B })).status).toBe(404);continue; }if (change === "reference-missing") f.db.delete(ref);else if (change === "reference-org") f.db.set({ ...f.db.get(ref), orgId: B });else if (change === "reference-id") f.db.set({ ...f.db.get(ref), inviteId: randomUUID() });else f.db.set({ ...f.created.row, ...(change === "canonical-org" ? { orgId: B } : change === "canonical-id" ? { inviteId: randomUUID() } : { tokenHash: "f".repeat(64) }) });expect((await f.call()).status).toBe(404);expect(f.events().length).toBe(0); }
});
for (const change of ["actor-role", "actor-org", "actor-person", "pointer-org", "pointer-role", "org-binding", "closing", "closed", "reference", "canonical-org", "canonical-id", "accepted", "revoked", "expired"] as const) it(`fences revocation against commit-time ${change}`, async () => {
 const f = await fixture();f.beforeCommit(async () => { if (change === "actor-role") f.db.set({ ...f.db.get(orgMemberKey(A, actor)), role: "member" });else if (change === "actor-org") f.db.set({ ...f.db.get(orgMemberKey(A, actor)), orgId: B });else if (change === "actor-person") f.db.set({ ...f.db.get(orgMemberKey(A, actor)), developerId: other });else if (change === "pointer-org") f.db.set({ ...developerOrgKey(actor), orgId: B, role: "owner" });else if (change === "pointer-role") f.db.set({ ...developerOrgKey(actor), orgId: A, role: "member" });else if (change === "org-binding") f.db.set({ ...f.db.get(orgMetaKey(A)), orgId: B });else if (change === "closing" || change === "closed") f.db.set({ ...f.db.get(orgMetaKey(A)), [change === "closing" ? "closingAt" : "closedAt"]: "2026-10-27T12:00:00Z" });else if (change === "reference") f.db.set({ ...f.db.get(orgInviteDirectoryKey(A, f.created.id)), tokenHash: "f".repeat(64) });else f.db.set({ ...f.created.row, ...(change === "canonical-org" ? { orgId: B } : change === "canonical-id" ? { inviteId: randomUUID() } : change === "accepted" ? { acceptedAt: "2026-10-27T12:00:00Z" } : change === "revoked" ? { revokedAt: "2026-10-27T11:00:00Z" } : { expiresAt: "2026-10-27T11:00:00Z" }) }); });const result = await f.call();expect(result.status).toBe(["canonical-org", "canonical-id"].includes(change) ? 404 : ["reference", "accepted", "revoked", "expired"].includes(change) ? 409 : 403);if (["accepted", "revoked", "expired"].includes(change)) expect(result.code).toBe(change === "accepted" ? "INVITE_ALREADY_ACCEPTED" : change === "revoked" ? "INVITE_ALREADY_REVOKED" : "INVITE_EXPIRED");expect(f.events().length).toBe(0);expect(f.db.find(row => row.entityType === "ORG_INVITE_REVOKE_REQUEST").length).toBe(0);
});
it("refuses unavailable audit/State storage and rolls back when the audit cannot commit", async () => {
 for (const reason of ["missing-audit", "wrong-table", "read", "audit-put"] as const) { const f = await fixture();if (reason === "missing-audit") delete f.deps.audit;else if (reason === "wrong-table") f.deps.audit = { ...f.capture.audit, tableName: "other-state" };else f.db.injectFault({ command: reason === "read" ? "GetCommand" : "TransactWriteCommand", ...(reason === "read" ? {} : { match: (input: Record<string, unknown>) => JSON.stringify(input).includes("org.invite_revoked") }), error: { name: "ServiceUnavailable" } });expect((await f.call()).status).toBe(503);expect(f.db.get(f.created.key)?.revokedAt).toBeUndefined();expect(f.events().length).toBe(0);expect(f.db.find(row => row.entityType === "ORG_INVITE_REVOKE_REQUEST").length).toBe(0); }
});
it("recovers a committed lost acknowledgement and retains audit through an intake outage", async () => {
 const f = await fixture();f.capture.queueDown();const send = f.db.send.bind(f.db);let lose = true;f.db.send = async command => { const answer = await send(command);if (lose && command.constructor.name === "TransactWriteCommand") { lose = false;throw Object.assign(new Error("fixture lost ack"), { name: "TimeoutError" }); }return answer; };expect((await f.call()).status).toBe(200);expect(f.events().length).toBe(1);expect((await f.call()).status).toBe(200);expect(f.events().length).toBe(1);expect(f.db.get(f.created.key)?.revokedAt).toBeDefined();
});
it("serializes a winning revoke before acceptance and exposes no usable link or directory row", async () => {
 const f = await fixture();f.beforeCommit(async () => { expect((await f.call()).status).toBe(200); });const accepted = await f.store.acceptInvite({ tokenHash: inviteTokenHash(f.created.token), developerId: newcomer }).then(() => "accepted", error => error instanceof AgentXError ? error.code : "unknown");expect(accepted).toBe("INVITE_INVALID");expect(f.db.get(developerOrgKey(newcomer))).toBeUndefined();expect((await f.store.peekInvite(inviteTokenHash(f.created.token))) === undefined).toBe(true);expect((await f.store.describeInvite(f.created.token)) === undefined).toBe(true);
 const path = "/v1/app/org/invites";const page = await routeDeveloperRequest(f.deps, { method: "GET", path, headers: {}, requestId: "revoke-list" }, new URL(path, "https://cell.example"), { caller: { ...f.caller, orgRole: "owner" }, csrf: "" });expect(page).toMatchObject({ invites: [], unavailableCount: 0 });
 const beforeRetry = f.db.transactions().length;expect(await f.store.acceptInvite({ tokenHash: inviteTokenHash(f.created.token), developerId: newcomer }).then(() => "accepted", error => error instanceof AgentXError ? error.code : "unknown" )).toBe("INVITE_INVALID");expect(f.db.transactions().length).toBe(beforeRetry);
});
it("refuses revoke when real acceptance wins between its read and commit", async () => {
 const f = await fixture();f.beforeCommit(async () => { await f.store.acceptInvite({ tokenHash: inviteTokenHash(f.created.token), developerId: newcomer }); });const lost = await f.call();expect(lost.status).toBe(409);expect(lost.code).toBe("INVITE_ALREADY_ACCEPTED");expect(f.db.get(developerOrgKey(newcomer))?.orgId).toBe(A);expect(f.db.get(f.created.key)?.revokedAt).toBeUndefined();expect(f.events().length).toBe(0);
});
it("refuses expired, used and revoked invites without inventing a new receipt", async () => {
 for (const state of ["expired", "used", "revoked"] as const) { const f = await fixture();f.db.set({ ...f.created.row, ...(state === "expired" ? { expiresAt: "2026-10-27T11:00:00Z" } : state === "used" ? { acceptedAt: "2026-10-27T11:00:00Z" } : { revokedAt: "2026-10-27T11:00:00Z" }) });expect((await f.call()).code).toBe(state === "expired" ? "INVITE_EXPIRED" : state === "used" ? "INVITE_ALREADY_ACCEPTED" : "INVITE_ALREADY_REVOKED");expect(f.events().length).toBe(0); }
});
it("validates public UUID and strict request body before writes", async () => {
 const f = await fixture();for (const body of [{}, { requestId: "bad" }, { requestId: f.requestId, token: "private-value" }]) expect((await f.call(f.created.id, body)).status).toBe(400);expect((await f.call("not-a-public-uuid")).status).toBe(400);expect(f.events().length).toBe(0);
});
it("registers non-personal revocation audit vocabulary", () => {
 expect(AuditEventInputSchema.safeParse({ eventId: "aev_" + "a".repeat(40), orgId: A, action: "org.invite_revoked", actor: { kind: "member", id: actor }, target: { kind: "invite", id: "11111111-1111-4111-8111-111111111111" }, occurredAt: "2026-10-27T12:00:00Z", facts: { role: "member" } }).success).toBe(true);
});

it("requires an expected revision and refuses a changed revision before and during commit", async () => {
 const f = await fixture();expect((await f.call(f.created.id, { requestId: f.requestId })).status).toBe(400);expect((await f.call(f.created.id, { requestId: f.requestId, expectedRevision: 1 })).status).toBe(409);f.beforeCommit(async () => { f.db.set({ ...f.created.row, revision: 1 }); });expect((await f.call()).status).toBe(409);expect(f.events().length).toBe(0);
});
it("replays a retained receipt after TTL eligibility and refuses a new request for an already terminal invite", async () => {
 const f = await fixture(), first = await f.call();expect(first.status).toBe(200);f.advance(2 * 86400000);expect(await f.call()).toEqual(first);expect((await f.call(f.created.id, { requestId: randomUUID(), expectedRevision: 0 })).status).toBe(409);expect(f.events().length).toBe(1);
});

it("refuses initially closed organizations and malformed canonical records before issuing a transaction", async () => {
 for (const state of ["closingAt", "closedAt", "bad-role", "bad-date"] as const) { const f = await fixture();const count = f.db.transactions().length;if (state === "closingAt" || state === "closedAt") f.db.set({ ...f.db.get(orgMetaKey(A)), [state]: "2026-10-27T12:00:00Z" });else f.db.set({ ...f.created.row, ...(state === "bad-role" ? { role: "future-role" } : { expiresAt: "bad" }) });expect((await f.call()).status).toBe(state === "closingAt" || state === "closedAt" ? 403 : 404);expect(f.db.transactions().length).toBe(count); }
});
it("binds the canonical hash and role and the scoped reference org and ID at commit", async () => {
 for (const state of ["hash", "role", "ref-org", "ref-id", "expiry-extension"] as const) { const f = await fixture();f.beforeCommit(async () => { if (state === "ref-org" || state === "ref-id") { const key = orgInviteDirectoryKey(A, f.created.id);f.db.set({ ...f.db.get(key), ...(state === "ref-org" ? { orgId: B } : { inviteId: randomUUID() }) }); }else f.db.set({ ...f.created.row, ...(state === "hash" ? { tokenHash: "f".repeat(64) } : state === "role" ? { role: "admin" } : { expiresAt: "2026-12-01T00:00:00Z" }) }); });expect((await f.call()).status).toBe(state === "hash" ? 404 : 409);expect(f.events().length).toBe(0); }
});

it("fences an explicitly stored nonzero revision and returns the incremented revision", async () => {
 for (const race of [false, true]) { const f = await fixture();f.db.set({ ...f.created.row, revision: 1 });if (race) f.beforeCommit(async () => { f.db.set({ ...f.created.row, revision: 2 }); });const result = await f.call(f.created.id, { requestId: f.requestId, expectedRevision: 1 });expect(result.status).toBe(race ? 409 : 200);if (!race) expect(result.body?.revision).toBe(2); }
});

it("reports the actual already-revoked result when a different request wins at commit", async () => {
 const f = await fixture();f.beforeCommit(async () => { expect((await f.call(f.created.id, { requestId: randomUUID(), expectedRevision: 0 }, { ...f.caller, developerId: other })).status).toBe(200); });const result = await f.call();expect(result.status).toBe(409);expect(result.code).toBe("INVITE_ALREADY_REVOKED");expect(f.events().length).toBe(1);expect(f.db.find(row => row.entityType === "ORG_INVITE_REVOKE_REQUEST").length).toBe(1);expect(f.db.get({ pk: orgScoped(A, "INVITE_REVOKE"), sk: f.requestId }) === undefined).toBe(true);
});
it("does not guess a terminal result when its consistent recheck fails or loses authority", async () => {
 for (const state of ["read-down", "demoted", "foreign"] as const) { const f = await fixture();f.beforeCommit(async () => { await f.store.acceptInvite({ tokenHash: inviteTokenHash(f.created.token), developerId: newcomer });if (state === "read-down") f.db.injectFault({ command: "GetCommand", match: input => (input.Key as { pk?: string }).pk === f.created.key.pk, error: { name: "ServiceUnavailable" } });else if (state === "foreign") f.db.set({ ...f.db.get(f.created.key), orgId: B }); });if (state === "demoted") { const send = f.db.send.bind(f.db);f.db.send = async command => { try { return await send(command); }catch (error) { if (command.constructor.name === "TransactWriteCommand") f.member(actor, "member");throw error; } }; }const result = await f.call();expect(result.status).toBe(state === "read-down" ? 503 : state === "demoted" ? 403 : 404);expect(f.events().length).toBe(0); }
});

for (const role of ["owner", "admin", "member", "maintainer", "viewer", "future-role"]) it(`reads canonical invite status only with live ${role} authority`, async () => {
 const f = await fixture();f.member(actor, role);const result = await f.status();expect(result.status).toBe(role === "owner" || role === "admin" ? 200 : 403);
});
it("returns only safe canonical status for pending, accepted, revoked and expired invites", async () => {
 for (const state of ["pending", "accepted", "revoked", "expired"] as const) { const f = await fixture();f.db.set({ ...f.created.row, ...(state === "accepted" ? { acceptedAt: "2026-10-27T12:00:00Z", acceptedBy: other } : state === "revoked" ? { revokedAt: "2026-10-27T12:00:00Z", revokedBy: other, revision: 1 } : state === "expired" ? { expiresAt: "2026-10-27T11:00:00Z" } : {}) });const result = await f.status();expect(result.status).toBe(200);const text = JSON.stringify(result.body);expect(text.includes(f.created.token) || text.includes(hashOf(f.created.token)) || text.includes("private.person") || text.includes("example.test") || text.includes(other)).toBe(false);expect(result.body).toMatchObject({ orgId: A, inviteId: f.created.id, status: state, revision: state === "revoked" ? 1 : 0, role: "member", checkedAt: "2026-10-27T12:00:00.000Z" });expect(Object.keys(result.body!).sort()).toEqual(["checkedAt", "expiresAt", "inviteId", "orgId", "revision", "role", "status", ...(state === "revoked" ? ["revokedAt"] : [])].sort()); }
});
it("refuses a foreign/misbound status target and unavailable reads without leaking terminal state", async () => {
 for (const state of ["foreign", "pointer", "canonical", "read"] as const) { const f = await fixture();if (state === "foreign") { f.member(actor, "owner", B);expect((await f.status(f.created.id, { ...f.caller, orgId: B })).status).toBe(404);continue; }if (state === "pointer") f.db.set({ ...developerOrgKey(actor), orgId: B, role: "owner" });else if (state === "canonical") f.db.set({ ...f.created.row, orgId: B, acceptedAt: "2026-10-27T12:00:00Z" });else f.db.injectFault({ command: "GetCommand", error: { name: "ServiceUnavailable" } });expect((await f.status()).status).toBe(state === "pointer" ? 403 : state === "canonical" ? 404 : 503); }
});
it("shares the list's admission quota for explicit status reads and validates before admission", async () => {
 const f = await fixture();expect((await f.status("bad-id")).status).toBe(400);expect(f.db.find(row => String(row.pk).includes("INVITE_DIRECTORY_RATE")).length).toBe(0);for (let i = 0; i < 20; i++) expect((await f.status()).status).toBe(200);expect((await f.status()).status).toBe(429);const path = "/v1/app/org/invites";const result = await routeDeveloperRequest(f.deps, { method: "GET", path, headers: {}, requestId: "status-list-quota" }, new URL(path, "https://cell.example"), { caller: f.caller, csrf: "" }).then(() => "listed", error => error instanceof AgentXError ? error.code : "unknown");expect(result).toBe("TOO_MANY_REQUESTS");
});

it("refuses independently misbound status authority before charging read quota", async () => {
 for (const state of ["actor-org", "actor-person", "pointer-role", "pointer-missing", "org-binding", "closingAt", "closedAt"] as const) { const f = await fixture();if (state === "actor-org") f.db.set({ ...f.db.get(orgMemberKey(A, actor)), orgId: B });else if (state === "actor-person") f.db.set({ ...f.db.get(orgMemberKey(A, actor)), developerId: other });else if (state === "pointer-role") f.db.set({ ...developerOrgKey(actor), orgId: A, role: "member" });else if (state === "pointer-missing") f.db.delete(developerOrgKey(actor));else f.db.set({ ...f.db.get(orgMetaKey(A)), ...(state === "org-binding" ? { orgId: B } : { [state]: "2026-10-27T12:00:00Z" }) });expect((await f.status()).status).toBe(403);expect(f.db.find(row => String(row.pk).includes("INVITE_DIRECTORY_RATE")).length).toBe(0); }
});

it("consistently observes real role loss and terminal changes despite eventual State reads", async () => {
 const denied = await fixture(true);await denied.store.setRole({ orgId: A, developerId: actor, role: "member" });expect((await denied.status()).status).toBe(403);
 const revoked = await fixture(true);expect((await revoked.call()).status).toBe(200);const result = await revoked.status();expect(result.status).toBe(200);expect(result.body?.status).toBe("revoked");
});

for (const [marker, revision, code] of [["revokedAt", 1, "INVITE_ALREADY_REVOKED"], ["acceptedAt", 3, "INVITE_ALREADY_ACCEPTED"]] as const) it(`prioritizes ${marker} over a stale expected revision directly`, async () => {
 const f = await fixture();f.db.set({ ...f.created.row, revision, [marker]: "2026-10-27T11:00:00Z" });expect((await f.call()).code).toBe(code);expect(f.events().length).toBe(0);expect(f.db.find(row => row.entityType === "ORG_INVITE_REVOKE_REQUEST").length).toBe(0);
});
it("refuses an unsafe canonical revision rather than trusting terminal state", async () => {
 const f = await fixture();f.db.set({ ...f.created.row, revision: Number.MAX_SAFE_INTEGER + 1, revokedAt: "2026-10-27T11:00:00Z" });expect((await f.call()).status).toBe(404);expect(f.events().length).toBe(0);expect(f.db.find(row => row.entityType === "ORG_INVITE_REVOKE_REQUEST").length).toBe(0);
});

it("refuses a revision whose next value cannot be represented safely before any write", async () => {
 const f = await fixture();f.db.set({ ...f.created.row, revision: Number.MAX_SAFE_INTEGER });const transactions=f.db.transactions().length;expect((await f.call(f.created.id, { requestId: f.requestId, expectedRevision: Number.MAX_SAFE_INTEGER })).status).toBe(400);expect(f.db.transactions().length).toBe(transactions);expect(f.events().length).toBe(0);
});
