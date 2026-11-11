import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { AgentXError, errorStatus, orgPk } from "@rovara-code/contracts";
import { orgMemberKey, orgMetaKey, orgInviteKey, developerOrgKey } from "@agentx/cloud-contracts";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { routeDeveloperRequest, type DeveloperCaller, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { inviteTokenHash } from "../../packages/broker/src/org/invite-url.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb", actor = "a".repeat(64), foreign = "c".repeat(64), joined = "d".repeat(64);
const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");
function fixture(role = "owner") {
 const db = new FakeDynamoDb();let now = Date.parse("2026-10-26T12:00:00Z");
 for (const [orgId, developerId, r] of [[A, actor, role], [B, foreign, "owner"]] as const) { db.set({ ...orgMemberKey(orgId, developerId), orgId, developerId, role: r, joinedAt: "2026-10-01T00:00:00Z" });db.set({ ...developerOrgKey(developerId), orgId, role: r });db.set({ ...orgMetaKey(orgId), orgId, name: "Company", plan: "team" }); }
 const store = new OrgStore({ tableName: "state", documentClient: db, now: () => now });
 const deps: DeveloperRouteDependencies = { tableName: "state", now: () => now, documentClient: db, orgs: store, developer: { issuer: "https://cell.example/v1/auth", env: "test", signInTableName: "signin", methods: { cloud: true, slack: false, oidc: false }, verifyAccessToken: async () => ({}), channelMembers: async () => ({ ok: true, memberOf: [] }) } };
 const caller: DeveloperCaller = { orgId: A, developerId: actor, orgRole: "owner", name: "Priya", amr: "cloud", sessionId: "fixture" };
 async function request(query = "", as = caller): Promise<{ status: number; body: { invites?: Array<Record<string, unknown>>; nextCursor?: string; coverage?: string; checkedAt?: string; code?: string } }> { const path = "/v1/app/org/invites" + query;try { return { status: 200, body: await routeDeveloperRequest(deps, { method: "GET", path, headers: {}, requestId: "invite-directory" }, new URL(path, "https://cell.example"), { caller: as, csrf: "" }) as { invites?: Array<Record<string, unknown>>; nextCursor?: string; coverage?: string; checkedAt?: string } }; }catch (e) { if (!(e instanceof AgentXError)) throw e;return { status: errorStatus(e.code), body: { code: e.code } }; } }
 let seeded = 0;
 async function invite(orgId = A, email?: string, ttlSeconds?: number, requestId?: string) { if (seeded > 0 && seeded % 20 === 0) now += 60000;seeded++;return store.createInvite({ orgId, createdBy: orgId === A ? actor : foreign, role: "member", ...(email === undefined ? {} : { email }), ...(ttlSeconds === undefined ? {} : { ttlSeconds }), ...(requestId === undefined ? {} : { requestId }) }); }
 return { db, deps, store, caller, request, invite, advance(ms: number) { now += ms; } };
}
it("atomically indexes each new invite with a public id independent of its token and hash", async () => {
 const f = fixture(), { token } = await f.invite(), hash = hashOf(token), global = f.db.get(orgInviteKey(hash));const index = f.db.find(row => row.entityType === "ORG_INVITE_DIRECTORY");expect(index.length).toBe(1);
 const reference = index[0]!;expect(reference.pk).toBe(orgPk(A));expect(reference.inviteId === token || reference.inviteId === hash).toBe(false);expect(typeof reference.inviteId).toBe("string");expect(reference.tokenHash === hash && reference.inviteId === global?.inviteId).toBe(true);expect(Object.keys(reference).sort()).toEqual(["entityType", "inviteId", "orgId", "pk", "sk", "tokenHash"]);expect(f.db.transactions().length).toBe(1);expect(f.db.transactions()[0]?.length).toBe(6);
});
it("rolls back the invite if its directory reference cannot commit", async () => {
 const f = fixture();f.db.injectFault({ command: "TransactWriteCommand", match: input => JSON.stringify(input).includes("ORG_INVITE_DIRECTORY"), error: { name: "ServiceUnavailable" } });const outcome = await f.invite().then(() => "unexpected-success", () => "refused");expect(outcome).toBe("refused");expect(f.db.find(row => row.entityType === "ORG_INVITE").length).toBe(0);expect(f.db.find(row => row.entityType === "ORG_INVITE_DIRECTORY").length).toBe(0);
});
for (const [role, allowed] of [["owner", true], ["admin", true], ["member", false], ["maintainer", false], ["viewer", false], ["future-role", false]] as const) it(`uses live request-org ${role} authority for the private invite directory`, async () => {
 const f = fixture();await f.invite();f.db.set({ ...f.db.get(orgMemberKey(A, actor)), role });const response = await f.request();expect(response.status).toBe(allowed ? 200 : 403);if (allowed) expect(response.body.invites).toHaveLength(1);else expect(response.body.invites).toBeUndefined();
});
it("returns masked pending metadata without tokens, hashes or raw email", async () => {
 const f = fixture(), { token } = await f.invite(A, "sensitive.person@example.test"), response = await f.request();expect(response.status).toBe(200);const serialized = JSON.stringify(response.body);expect(serialized.includes(token) || serialized.includes(hashOf(token)) || serialized.includes("sensitive.person")).toBe(false);
 expect(response.body.coverage).toBe("indexed_only");expect(response.body.checkedAt).toBe("2026-10-26T12:00:00.000Z");expect(response.body.invites?.[0]).toMatchObject({ role: "member", destination: { kind: "email", label: "***@example.test" } });expect(Object.keys(response.body.invites![0]!).sort()).toEqual(["createdAt", "createdBy", "destination", "expiresAt", "inviteId", "revision", "role"]);
});
it("never lists another org's invites or accepts its cursor", async () => {
 const f = fixture();await f.invite();await f.invite();const theirs = await f.invite(B);const first = await f.request("?limit=1");expect(first.status).toBe(200);expect(first.body.invites).toHaveLength(1);expect(JSON.stringify(first.body).includes(hashOf(theirs.token))).toBe(false);
 expect((await f.request("", { ...f.caller, orgId: B })).status).toBe(403);expect(first.body.nextCursor).toBeTruthy();expect((await f.request("?cursor=" + encodeURIComponent(first.body.nextCursor!), { ...f.caller, orgId: B, developerId: foreign })).status).toBe(400);
 const foreignPage = await f.request("", { ...f.caller, orgId: B, developerId: foreign });expect(foreignPage.status).toBe(200);expect(foreignPage.body.invites).toHaveLength(1);
});
it("isolates a misbound directory reference even when both invites are otherwise valid", async () => {
 const f = fixture();await f.invite();const foreignInvite = await f.invite(B);const local = f.db.find(row => row.entityType === "ORG_INVITE_DIRECTORY" && row.orgId === A);expect(local.length).toBe(1);expect((await f.request()).status).toBe(200);f.db.set({ ...local[0]!, tokenHash: hashOf(foreignInvite.token) });const result = await f.request();expect(result.status).toBe(200);expect(result.body.invites).toEqual([]);expect(result.body).toMatchObject({ unavailableCount: 1 });
});
it("reads canonical accepted/expired state and makes unindexed legacy coverage explicit", async () => {
 const f = fixture(), accepted = await f.invite();await f.store.acceptInvite({ tokenHash: inviteTokenHash(accepted.token), developerId: joined });await f.invite(A, undefined, 0);
 f.db.set({ ...orgInviteKey(hashOf("fixture-legacy")), entityType: "ORG_INVITE", orgId: A, tokenHash: hashOf("fixture-legacy"), role: "member", createdBy: actor, createdAt: "2026-10-26T12:00:00Z", expiresAt: "2026-11-01T12:00:00Z" });const result = await f.request();expect(result.status).toBe(200);expect(result.body.invites).toEqual([]);expect(result.body.coverage).toBe("indexed_only");
});
it("bounds pages, visits each opaque id once and rejects malformed filters", async () => {
 const f = fixture();for (let i = 0; i < 3; i++) await f.invite();let cursor: string | undefined;const seen = new Set<unknown>();for (let page = 0; page < 3; page++) { const result = await f.request("?limit=1" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""));expect(result.status).toBe(200);expect(result.body.invites).toHaveLength(1);seen.add(result.body.invites![0]!.inviteId);cursor = result.body.nextCursor; }expect(seen.size).toBe(3);expect(cursor).toBeUndefined();for (const query of ["?limit=0", "?limit=51", "?limit=1&limit=2", "?cursor=bad", "?orgId=" + B]) expect((await f.request(query)).status).toBe(400);
});
it("keeps legacy invite replay refusal and acceptance compatible", async () => {
 const f = fixture(), requestId = "11111111-1111-4111-8111-111111111111", first = await f.invite(A, undefined, undefined, requestId);const outcome = await f.invite(A, undefined, undefined, requestId).then(() => "unexpected-success", e => e instanceof AgentXError ? e.code : "unexpected-error");expect(outcome).toBe("IDEMPOTENCY_CONFLICT");expect(f.db.find(row => row.entityType === "ORG_INVITE_DIRECTORY").length).toBe(1);expect((await f.store.acceptInvite({ tokenHash: inviteTokenHash(first.token), developerId: joined })).role).toBe("member");
});
it("refuses reads when live membership, index or canonical storage is unavailable", async () => {
 for (const command of ["GetCommand", "QueryCommand"]) { const f = fixture();await f.invite();f.db.injectFault({ command, error: { name: "ServiceUnavailable" } });const result = await f.request();expect(result.status).toBe(503);expect(result.body.invites).toBeUndefined(); }
});
it("treats equivalent ISO expiry instants equally even without fractional seconds", async () => {
 const f = fixture(), result = await f.invite();const key = orgInviteKey(hashOf(result.token));f.db.set({ ...f.db.get(key), expiresAt: "2026-10-26T12:00:00Z" });const page = await f.request();expect(page.status).toBe(200);expect(page.body.invites).toHaveLength(0);
});

it("independently excludes and counts a canonical org, id or hash mismatch", async () => {
 for (const changed of [{ orgId: B }, { inviteId: "22222222-2222-4222-8222-222222222222" }, { tokenHash: "e".repeat(64) }]) { const f = fixture(), invite = await f.invite(), key = orgInviteKey(hashOf(invite.token));expect((await f.request()).status).toBe(200);f.db.set({ ...f.db.get(key), ...changed });const result = await f.request();expect(result.status).toBe(200);expect(result.body.invites).toEqual([]);expect(result.body).toMatchObject({ unavailableCount: 1 }); }
});
it("caps a full directory page at 50 and leaves a resumable cursor", async () => {
 const f = fixture();for (let i = 0; i < 51; i++) await f.invite();const page = await f.request("?limit=50");expect(page.status).toBe(200);expect(page.body.invites).toHaveLength(50);expect(page.body.nextCursor).toBeTruthy();const next = await f.request("?limit=50&cursor=" + page.body.nextCursor!);expect(next.body.invites).toHaveLength(1);
});
it("limits invite reads per org and caller before querying, resets next minute and fails closed on counter storage", async () => {
 const f = fixture();await f.invite();for (let i = 0; i < 20; i++) expect((await f.request()).status).toBe(200);
 const before = f.db.commandNames().filter(name => name === "QueryCommand").length;expect((await f.request()).status).toBe(429);expect(f.db.commandNames().filter(name => name === "QueryCommand")).toHaveLength(before);
 expect((await f.request("", { ...f.caller, orgId: B, developerId: foreign })).status).toBe(200);
 f.db.set({ ...orgMemberKey(B, actor), orgId: B, developerId: actor, role: "owner" });expect((await f.request("", { ...f.caller, orgId: B })).status).toBe(200);
 f.db.set({ ...orgMemberKey(A, joined), orgId: A, developerId: joined, role: "admin" });expect((await f.request("", { ...f.caller, developerId: joined })).status).toBe(200);
 f.advance(60_000);expect((await f.request()).status).toBe(200);f.db.injectFault({ command: "UpdateCommand", error: { name: "ServiceUnavailable" } });expect((await f.request()).status).toBe(503);
});
it("does not charge unauthorized or invalid directory requests to a new or existing quota", async () => {
 for (const existing of [false, true]) { const f = fixture();if (existing) expect((await f.request()).status).toBe(200);const counter = () => f.db.find(row => String(row.pk).includes("INVITE_DIRECTORY_RATE"));const before = structuredClone(counter());for (const query of ["?limit=0", "?cursor=bad"]) { expect((await f.request(query)).status).toBe(400);expect(counter()).toEqual(before); }f.db.set({ ...f.db.get(orgMemberKey(A, actor)), role: "member" });expect((await f.request()).status).toBe(403);expect(counter()).toEqual(before); }
});
it("keeps healthy invites when canonical data is corrupt and reports unavailable entries without leaking them", async () => {
 const f = fixture();await f.invite(A, "healthy@example.test");const bad = await f.invite(A, "private.person@private.test"), key = orgInviteKey(hashOf(bad.token));f.db.set({ ...f.db.get(key), role: "future-role" });const result = await f.request();expect(result.status).toBe(200);expect(result.body.invites).toHaveLength(1);expect(result.body).toMatchObject({ unavailableCount: 1 });expect(JSON.stringify(result.body).includes("private.person") || JSON.stringify(result.body).includes(hashOf(bad.token)) || JSON.stringify(result.body).includes(bad.token)).toBe(false);
});

it("marks partial coverage distinctly so older indexed-only readers cannot treat unavailable entries as complete", async () => {
 const f = fixture(), bad = await f.invite(), key = orgInviteKey(hashOf(bad.token));f.db.set({ ...f.db.get(key), role: "future-role" });const result = await f.request();expect(result.status).toBe(200);expect(result.body.coverage).toBe("indexed_only_partial");expect(result.body).toMatchObject({ unavailableCount: 1 });
});

it("keeps all-bad evaluated pages resumable and treats canonical storage failure as unavailable service", async () => {
 const f = fixture();for (let i = 0; i < 2; i++) { const invite = await f.invite(), key = orgInviteKey(hashOf(invite.token));f.db.set({ ...f.db.get(key), role: "future-role" }); }const first = await f.request("?limit=1");expect(first.status).toBe(200);expect(first.body.invites).toEqual([]);expect(first.body).toMatchObject({ unavailableCount: 1, coverage: "indexed_only_partial" });expect(first.body.nextCursor).toBeTruthy();const last = await f.request("?limit=1&cursor=" + first.body.nextCursor!);expect(last.body.invites).toEqual([]);expect(last.body.nextCursor).toBeUndefined();f.db.injectFault({ command: "GetCommand", match: input => { const key = input.Key as { pk?: unknown } | undefined;return typeof key?.pk === "string" && key.pk.startsWith("ORG_INVITE#"); }, error: { name: "ServiceUnavailable" } });expect((await f.request()).status).toBe(503);
});

it("warns with safe scoped identifiers and fixed reason classes for unusable directory entries", async () => {
 const warn = vi.spyOn(console, "log").mockImplementation(() => undefined);
 try { const f = fixture(), created = await f.invite(A, "private.person@private.test"), key = orgInviteKey(hashOf(created.token)), record = f.db.get(key)!;f.db.set({ ...record, orgId: B });const result = await f.request();expect(result.status).toBe(200);expect(result.body).toMatchObject({ unavailableCount: 1 });expect(warn).toHaveBeenCalledTimes(1);const raw: unknown = warn.mock.calls[0]?.[0];expect(typeof raw).toBe("string");const entry = JSON.parse(String(raw)) as Record<string, unknown>;expect(String(raw).includes(created.token) || String(raw).includes(hashOf(created.token)) || String(raw).includes("private.person") || String(raw).includes(B)).toBe(false);expect(entry).toEqual({ component: "broker", event: "org.invite_directory_entry_unavailable", level: "warn", orgId: A, inviteId: record.inviteId, reason: "canonical_org_mismatch" }); }finally { warn.mockRestore(); }
});

it("classifies unusable entries without logging unparseable identifiers and survives warning sink failure", async () => {
 const warn = vi.spyOn(console, "log").mockImplementation(() => undefined);
 try { for (const reason of ["reference_invalid", "reference_org_mismatch", "reference_key_mismatch", "canonical_missing", "canonical_invalid", "canonical_reference_mismatch"] as const) { const f = fixture(), created = await f.invite(), key = orgInviteKey(hashOf(created.token)), record = f.db.get(key)!, ref = f.db.find(row => row.entityType === "ORG_INVITE_DIRECTORY")[0]!;if (reason === "reference_invalid") { f.db.delete({ pk: String(ref.pk), sk: String(ref.sk) });f.db.set({ ...ref, sk: "INVITE_DIRECTORY#unparseable-private-identifier", inviteId: "unparseable-private-identifier" }); }else if (reason === "reference_org_mismatch") f.db.set({ ...ref, orgId: B });else if (reason === "reference_key_mismatch") f.db.set({ ...ref, inviteId: "22222222-2222-4222-8222-222222222222" });else if (reason === "canonical_missing") f.db.delete(key);else if (reason === "canonical_invalid") f.db.set({ ...record, role: "future-role" });else f.db.set({ ...record, inviteId: "22222222-2222-4222-8222-222222222222" });warn.mockClear();expect((await f.request()).status).toBe(200);expect(warn.mock.calls.length).toBe(1);const entry = JSON.parse(String(warn.mock.calls[0]?.[0])) as Record<string, unknown>;expect(entry.reason).toBe(reason);expect(entry.orgId).toBe(A);if (reason === "reference_invalid") expect(Object.hasOwn(entry, "inviteId")).toBe(false);expect(JSON.stringify(entry).includes("unparseable-private-identifier") || JSON.stringify(entry).includes(created.token) || JSON.stringify(entry).includes(hashOf(created.token))).toBe(false); }
 const f = fixture(), created = await f.invite(), key = orgInviteKey(hashOf(created.token));f.db.delete(key);warn.mockImplementation(() => { throw new Error("warning sink unavailable"); });expect((await f.request()).body).toMatchObject({ unavailableCount: 1 }); }finally { warn.mockRestore(); }
});

it("identifies a corrupt reference by its scoped public key UUID rather than an invalid ID attribute", async () => {
 const warn = vi.spyOn(console, "log").mockImplementation(() => undefined);
 try { const f = fixture();await f.invite();const ref = f.db.find(row => row.entityType === "ORG_INVITE_DIRECTORY")[0]!;f.db.set({ ...ref, inviteId: "private-corrupt-value" });expect((await f.request()).status).toBe(200);const entry = JSON.parse(String(warn.mock.calls[0]?.[0])) as Record<string, unknown>;expect(entry.inviteId).toBe(ref.inviteId);expect(JSON.stringify(entry).includes("private-corrupt-value")).toBe(false); }finally { warn.mockRestore(); }
});

it("projects canonical invite revisions and marks malformed revisions unavailable instead of inventing zero", async () => {
 for (const revision of [undefined, 7, -1, 1.5, "7", Number.MAX_SAFE_INTEGER + 1]) { const f = fixture(), created = await f.invite(), key = orgInviteKey(hashOf(created.token));if (revision !== undefined) f.db.set({ ...f.db.get(key), revision });const page = await f.request();expect(page.status).toBe(200);if (revision === undefined || revision === 7) { expect(page.body.invites?.[0]?.revision).toBe(revision ?? 0);expect(page.body.coverage).toBe("indexed_only"); }else expect(page.body).toMatchObject({ invites: [], unavailableCount: 1, coverage: "indexed_only_partial" }); }
});
