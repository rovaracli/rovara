import { expect, it } from "vitest";
import { AppOrgMembersResponseSchema, orgMemberKey, orgMetaKey, orgEmailKey, developerOrgKey } from "@agentx/cloud-contracts";
import { projectMemberKey, errorStatus, AgentXError } from "@rovara-code/contracts";
import { routeDeveloperRequest, type DeveloperCaller, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb", me = "a".repeat(64), colleague = "b".repeat(64), foreign = "c".repeat(64);
function fixture(role: string = "member") {
 const db = new FakeDynamoDb();
 for (const [orgId, id, name, email, r] of [[A, me, "Priya", "priya@example.test", role], [A, colleague, "Maya", "maya@example.test", "member"], [B, foreign, "Other org", "other@example.test", "owner"]] as const) {
  db.set({ ...orgMemberKey(orgId, id), orgId, developerId: id, role: r, joinedAt: "2026-10-01T00:00:00.000Z" });db.set({ ...developerOrgKey(id), orgId, developerId: id, role: r });db.set({ ...orgEmailKey(email), orgId, developerId: id });db.set({ pk: `DEVELOPER#${id}`, sk: "META", displayName: name, developerId: id, provider: "cloud", email });
 }
 for (const orgId of [A, B]) db.set({ ...orgMetaKey(orgId), orgId, name: "Company", plan: "team" });
 const deps: DeveloperRouteDependencies = { tableName: "state", now: () => Date.parse("2026-10-26T12:00:00Z"), documentClient: db, developer: { issuer: "https://cell.example/v1/auth", env: "test", methods: { slack: false, oidc: false, cloud: true }, signInTableName: "signin", verifyAccessToken: async () => ({}), channelMembers: async () => ({ ok: true, memberOf: [] }) }, orgs: new OrgStore({ tableName: "state", documentClient: db, now: Date.now }) };
 const caller: DeveloperCaller = { orgId: A, developerId: me, orgRole: "owner", name: "Priya", amr: "cloud", sessionId: "fixture" };
 async function request(method: string, path: string, body?: unknown, as = caller) {
  try { return { status: 200, body: await routeDeveloperRequest(deps, { method, path, headers: {}, requestId: "privacy-test", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, new URL(path, "https://cell.example"), { caller: as, csrf: "" }) as Record<string, unknown> }; }
  catch (error) { if (!(error instanceof AgentXError)) throw error;return { status: errorStatus(error.code), body: { error: { code: error.code } } }; }
 }
 return { db, deps, caller, request };
}
for (const [label, role, full] of [["owner", "owner", true], ["admin", "admin", true], ["project maintainer", "member", false], ["member", "member", false], ["unknown", "future-role", false]] as const) it(`returns the live ${label} directory projection in the request org`, async () => {
 const f = fixture(role);if (label === "project maintainer") f.db.set({ ...projectMemberKey(A, "demo", me), role: "developer", projectRole: "maintainer" });const result = await f.request("GET", "/v1/app/org/members");expect(result.status).toBe(200);const rows = result.body.members as Array<Record<string, unknown>>;expect(rows.map(row => row.name)).toEqual(full ? ["Priya", "Maya"] : ["Maya", "Priya"]);expect(rows.some(row => row.developerId === foreign)).toBe(false);
 const target = rows.find(row => row.developerId === colleague)!;expect(Object.keys(target).sort()).toEqual(full ? ["developerId", "email", "identities", "joinedAt", "name", "role"] : ["developerId", "name", "role"]);if (full) expect(target).toMatchObject({ identities: ["cloud"], joinedAt: "2026-10-01T00:00:00.000Z" });
});
it("does not authorize the request org using an owner role in another org", async () => { const f = fixture("owner");const result = await f.request("GET", "/v1/app/org/members", undefined, { ...f.caller, orgId: B });expect(result.status).toBe(403);expect(result.body.members).toBeUndefined(); });
it("rechecks a changed role rather than a stale authenticated owner role", async () => { const f = fixture("owner");expect((await f.request("GET", "/v1/app/org/members")).body.members).toBeTruthy();f.db.set({ ...f.db.get(orgMemberKey(A, me)), role: "member" });const result = await f.request("GET", "/v1/app/org/members");expect((result.body.members as Array<Record<string, unknown>>).every(row => !("email" in row) && !("joinedAt" in row) && !("identities" in row))).toBe(true); });
it("accepts a restricted member contract without private details", () => { expect(AppOrgMembersResponseSchema.parse({ members: [{ developerId: me, name: "Priya", role: "member" }] })).toEqual({ members: [{ developerId: me, name: "Priya", role: "member" }] }); });
it("finds an exact in-org email and returns only name and id", async () => { const f = fixture();const result = await f.request("POST", "/v1/app/org/members/lookup", { email: " MAYA@example.test " });expect(result).toEqual({ status: 200, body: { match: { developerId: colleague, name: "Maya" } } }); });
it("gives the identical no-match answer for out-of-org, nonexistent and near-miss emails", async () => { const f = fixture();for (const email of ["other@example.test", "nobody@example.test", "may@example.test", "maya+tag@example.test"]) expect(await f.request("POST", "/v1/app/org/members/lookup", { email })).toEqual({ status: 200, body: { match: null } }); });
it("does not enumerate partial names, wildcard addresses or accept a supplied org", async () => { const f = fixture();for (const input of [{ email: "Maya" }, { email: "*@example.test" }, { email: "maya@example.test", orgId: B }]) expect((await f.request("POST", "/v1/app/org/members/lookup", input)).status).toBe(400); });
it("refuses stale/misbound pointers and removed colleagues", async () => { const f = fixture();f.db.set({ ...orgEmailKey("mistaken@example.test"), orgId: A, developerId: colleague });expect((await f.request("POST", "/v1/app/org/members/lookup", { email: "mistaken@example.test" })).body).toEqual({ match: null });f.db.delete(orgMemberKey(A, colleague));expect((await f.request("POST", "/v1/app/org/members/lookup", { email: "maya@example.test" })).body).toEqual({ match: null }); });
it("rates exact-email attempts per caller/org and fails closed when rate storage fails", async () => { const f = fixture();for (let i = 0; i < 20; i++) expect((await f.request("POST", "/v1/app/org/members/lookup", { email: "nobody@example.test" })).status).toBe(200);expect((await f.request("POST", "/v1/app/org/members/lookup", { email: "nobody@example.test" })).status).toBe(429);const counters = f.db.find(item => String(item.pk).includes("DIRECTORY_LOOKUP"));expect(counters).toHaveLength(1);expect(JSON.stringify(counters)).not.toContain("nobody@example.test"); });

it("does not return a lookup result if rate storage is unavailable", async () => { const f = fixture();f.db.injectFault({ command: "UpdateCommand", error: { name: "ServiceUnavailable" } });await expect(f.request("POST", "/v1/app/org/members/lookup", { email: "maya@example.test" })).rejects.toThrow(); });
it("refuses directory reads when the live membership lookup fails", async () => { const f = fixture("owner");f.db.injectFault({ command: "GetCommand", error: { name: "ServiceUnavailable" } });await expect(f.request("GET", "/v1/app/org/members")).rejects.toThrow(); });
it("refuses lookup by a stale owner caller in another org", async () => { const f = fixture("owner");expect((await f.request("POST", "/v1/app/org/members/lookup", { email: "other@example.test" }, { ...f.caller, orgId: B })).status).toBe(403); });
it("independently refuses a foreign-org email pointer even when every candidate membership agrees locally", async () => {
 const f = fixture();expect((await f.request("POST", "/v1/app/org/members/lookup", { email: "maya@example.test" })).body).toEqual({ match: { developerId: colleague, name: "Maya" } });
 f.db.set({ ...orgEmailKey("maya@example.test"), orgId: B, developerId: colleague });
 expect((await f.request("POST", "/v1/app/org/members/lookup", { email: "maya@example.test" })).body).toEqual({ match: null });
});
