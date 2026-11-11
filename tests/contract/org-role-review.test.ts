import { expect, it } from "vitest";
import { AgentXError } from "@rovara-code/contracts";
import { orgMemberKey, developerOrgKey, orgMetaKey } from "@agentx/cloud-contracts";
import { routeDeveloperRequest, type DeveloperRouteDependencies, type DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
const org = "org_aaaaaaaaaaaaaaaaaaaa", other = "org_bbbbbbbbbbbbbbbbbbbb", actor = "a".repeat(64), target = "b".repeat(64), outsider = "c".repeat(64);
const id = "11111111-1111-4111-8111-111111111111", nextId = "22222222-2222-4222-8222-222222222222";
function fixture(role = "owner") {
 const db = new FakeDynamoDb(), audit = capturingAuditDeps({ db, now: () => Date.parse("2026-10-26T12:00:00Z") });
 function member(orgId: string, developerId: string, r: string) { db.set({ ...orgMemberKey(orgId, developerId), orgId, developerId, role: r, joinedAt: "2026-10-01T00:00:00Z" });db.set({ ...developerOrgKey(developerId), orgId, developerId, role: r }); }
 member(org, actor, role);member(org, target, "member");
 db.set({ pk: `DEVELOPER#${actor}`, sk: "META", developerId: actor, displayName: "Priya", provider: "cloud" });
 db.set({ pk: `SESSION#${id}`, sk: "META", developerId: actor, amr: "cloud", endsAt: Math.floor(audit.audit.now() / 1000) + 3600, startedAt: "2026-10-26T11:00:00Z" });member(other, outsider, "owner");db.set({ ...orgMetaKey(org), orgId: org, name: "Acme", plan: "team" });
 const deps: DeveloperRouteDependencies = { tableName: "state", now: audit.audit.now, documentClient: db, audit: { ...audit.audit, tableName: "state" }, developer: { issuer: "https://cell.example/v1/auth", env: "test", methods: { slack: false, oidc: false, cloud: true }, signInTableName: "signin", verifyAccessToken: async () => ({ iss: "https://cell.example/v1/auth", aud: "agentx-developer", sub: actor, sid: id, amr: "cloud", env: "test", org, org_role: "owner" }), channelMembers: async () => ({ ok: true, memberOf: [] }) }, orgs: new OrgStore({ documentClient: db, tableName: "state", now: audit.audit.now }) };
 const caller: DeveloperCaller = { orgId: org, developerId: actor, orgRole: "owner", name: "Priya", amr: "cloud", sessionId: "fixture" };
 let beforeCommit: (() => void) | undefined;
 const original = db.send.bind(db);db.send = async command => { if (command.constructor.name === "TransactWriteCommand" && beforeCommit) { const run = beforeCommit;beforeCommit = undefined;run(); }return original(command); };
 async function request(body: unknown = { requestId: id, role: "admin", expectedRole: "member" }, who = target, as = caller) {
  const path = `/v1/app/org/members/${who}/role`;
  try { return { result: await routeDeveloperRequest(deps, { method: "PUT", path, headers: {}, body: JSON.stringify(body), requestId: "role-test" }, new URL(path, "https://cell.example"), typeof body === "object" && body !== null && Object.hasOwn(body, "expectedRole") ? { caller: as, csrf: "" } : undefined) }; }
  catch (e) { if (!(e instanceof AgentXError)) throw e;return { code: e.code }; }
 }
 return { db, deps, audit, caller, member, request, beforeCommit(run: () => void) { beforeCommit = run; }, role: (who = target) => db.get(orgMemberKey(org, who))?.role };
}
it("applies a reviewed owner change and records the exact actor, target and before/after audit", async () => {
 const f = fixture();expect(await f.request()).toEqual({ result: { developerId: target, role: "admin" } });expect(f.role()).toBe("admin");expect(f.db.get(developerOrgKey(target))?.role).toBe("admin");
 expect(f.audit.recordedBy("member.role_changed")).toMatchObject([{ orgId: org, actor: { kind: "member", id: actor }, target: { kind: "member", id: target }, facts: { fromRole: "member", toRole: "admin" } }]);
});
for (const role of ["admin", "member", "maintainer", "viewer", "future-role"]) it(`refuses a live ${role} even with a stale owner caller`, async () => { const f = fixture(role);expect(await f.request()).toEqual({ code: "FORBIDDEN" });expect(f.role()).toBe("member");expect(f.audit.recorded()).toEqual([]); });
it("uses the live owner rather than a stale member token", async () => { const f = fixture();expect(await f.request(undefined, target, { ...f.caller, orgRole: "member" })).toEqual({ result: { developerId: target, role: "admin" } }); });
it("refuses an actor whose owner membership is only in another org", async () => { const f = fixture();expect(await f.request(undefined, target, { ...f.caller, orgId: other })).toEqual({ code: "FORBIDDEN" });expect(f.role()).toBe("member"); });
it("cannot change another org's target or a misbound local member", async () => { const f = fixture();expect(await f.request(undefined, outsider)).toEqual({ code: "NOT_FOUND" });f.db.set({ ...f.db.get(orgMemberKey(org, target)), orgId: other });expect(await f.request()).toEqual({ code: "NOT_FOUND" });expect(f.db.get(orgMemberKey(other, outsider))?.role).toBe("owner"); });
it("rejects a role that changed since the owner's review", async () => { const f = fixture();f.member(org, target, "owner");expect(await f.request()).toEqual({ code: "CHANGE_STALE" });expect(f.role()).toBe("owner"); });
it("fences actor demotion at commit", async () => { const f = fixture();f.beforeCommit(() => f.member(org, actor, "member"));expect(await f.request()).toEqual({ code: "FORBIDDEN" });expect(f.role()).toBe("member");expect(f.audit.recorded()).toEqual([]); });
it("fences a concurrent target role change at commit", async () => { const f = fixture();f.beforeCommit(() => f.member(org, target, "owner"));expect(await f.request()).toEqual({ code: "CHANGE_STALE" });expect(f.role()).toBe("owner");expect(f.audit.recorded()).toEqual([]); });
it("protects the last owner and allows self-demotion only with another live owner", async () => { const f = fixture();const body = { requestId: id, expectedRole: "owner", role: "member" };expect(await f.request(body, actor)).toEqual({ code: "LAST_OWNER" });f.member(org, target, "owner");expect(await f.request(body, actor)).toEqual({ result: { developerId: actor, role: "member" } });expect(f.role(actor)).toBe("member");expect(f.role()).toBe("owner"); });
it("fences the second owner during self-demotion", async () => { const f = fixture();f.member(org, target, "owner");f.beforeCommit(() => f.member(org, target, "member"));expect(await f.request({ requestId: id, expectedRole: "owner", role: "member" }, actor)).toEqual({ code: "LAST_OWNER" });expect(f.role(actor)).toBe("owner"); });
it("replays a receipt without reapplying a reversed action and rejects changed-body reuse", async () => { const f = fixture();expect((await f.request()).result).toBeTruthy();expect((await f.request({ requestId: nextId, expectedRole: "admin", role: "member" })).result).toBeTruthy();expect((await f.request()).result).toEqual({ developerId: target, role: "admin" });expect(f.role()).toBe("member");expect(f.audit.recorded()).toHaveLength(2);expect(await f.request({ requestId: id, expectedRole: "member", role: "owner" })).toEqual({ code: "CONFIG_INVALID" }); });
it("checks current authority even for receipt replay", async () => { const f = fixture();await f.request();f.member(org, actor, "member");expect(await f.request()).toEqual({ code: "FORBIDDEN" }); });
it("records a no-op receipt without a fake change event", async () => { const f = fixture();const body = { requestId: id, expectedRole: "member", role: "member" };expect((await f.request(body)).result).toBeTruthy();expect(f.audit.recorded()).toEqual([]);await f.request({ requestId: nextId, expectedRole: "member", role: "admin" });expect((await f.request(body)).result).toBeTruthy();expect(f.role()).toBe("admin"); });
it("fails closed without audit configuration", async () => { const f = fixture();delete f.deps.audit;expect(await f.request()).toEqual({ code: "AUDIT_UNAVAILABLE" });expect(f.role()).toBe("member"); });
it("rolls back role and receipt if the transaction cannot persist its audit", async () => { const f = fixture();f.db.injectFault({ command: "TransactWriteCommand", error: { name: "ServiceUnavailable" } });expect(await f.request()).toEqual({ code: "AUDIT_UNAVAILABLE" });expect(f.role()).toBe("member");expect(f.audit.recorded()).toEqual([]);expect((await f.request()).result).toBeTruthy(); });
it("succeeds with durable pending audit when queue delivery fails", async () => { const f = fixture();f.audit.queueDown();expect((await f.request()).result).toBeTruthy();expect(f.role()).toBe("admin");expect(f.audit.pending()).toHaveLength(1); });
it("rejects malformed expected roles and supplied authority fields", async () => { const f = fixture();for (const body of [{ requestId: id, role: "admin", expectedRole: "unknown" }, { requestId: id, role: "admin", expectedRole: "member", orgId: other }]) expect(await f.request(body)).toEqual({ code: "CONFIG_INVALID" }); });

it("validates reviewed changes again at the internal write boundary before any storage access", async () => {
 const { changeReviewedMemberRole } = await import("../../packages/broker/src/org/role-changes.js");
 for (const [who, callerOrg, change] of [["bad-id", org, { requestId: id, expectedRole: "member", role: "admin" }], [target, "bad-org", { requestId: id, expectedRole: "member", role: "admin" }], [target, org, { requestId: id, expectedRole: "unknown", role: "admin" }], [target, org, { requestId: id, role: "admin" }]] as const) {
  const f = fixture(), before = f.db.commandNames().length;
  await expect(changeReviewedMemberRole(f.deps, { ...f.caller, orgId: callerOrg }, who, change as never)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  expect(f.db.commandNames()).toHaveLength(before);
 }
});
it("does not deduplicate a reviewed change against a previous legacy CLI change", async () => {
 const f = fixture();f.deps.orgs = new OrgStore({ documentClient: f.db, tableName: "state", now: f.deps.now, audit: f.audit.audit });
 expect((await f.request({ requestId: id, role: "admin" })).result).toBeTruthy();
 expect((await f.request({ requestId: nextId, role: "member" })).result).toBeTruthy();
 expect((await f.request()).result).toBeTruthy();expect(f.role()).toBe("admin");expect(f.audit.recordedBy("member.role_changed")).toHaveLength(3);
});
it("uses a fixed validation refusal without echoing untrusted field names", async () => {
 const f = fixture(), path = `/v1/app/org/members/${target}/role`;
 await expect(routeDeveloperRequest(f.deps, { method: "PUT", path, headers: {}, requestId: "role-test", body: JSON.stringify({ requestId: id, expectedRole: "member", role: "admin", "untrusted-private-field": "fixture" }) }, new URL(path, "https://cell.example"), { caller: f.caller, csrf: "" })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "CONFIG_INVALID: Review a valid company role change before submitting." });
});
for (const role of ["admin", "member", "maintainer", "viewer", "future-role"]) it(`refuses self-promotion by a live ${role}`, async () => {
 const f = fixture(role);expect(await f.request({ requestId: id, expectedRole: role === "admin" ? "admin" : "member", role: "owner" }, actor)).toEqual({ code: "FORBIDDEN" });expect(f.role(actor)).toBe(role);expect(f.audit.recorded()).toEqual([]);
});
it("recovers the stored outcome when a committed transaction loses its acknowledgement", async () => {
 const f = fixture(), send = f.db.send.bind(f.db);let lose = true;
 f.db.send = async command => { const answer = await send(command);if (command.constructor.name === "TransactWriteCommand" && lose) { lose = false;throw Object.assign(new Error("fixture timeout"), { name: "TimeoutError" }); }return answer; };
 expect(await f.request()).toEqual({ result: { developerId: target, role: "admin" } });expect(f.role()).toBe("admin");expect(f.audit.pending()).toHaveLength(1);expect(f.db.transactions()).toHaveLength(1);
 expect(await f.request()).toEqual({ result: { developerId: target, role: "admin" } });expect(f.db.transactions()).toHaveLength(1);expect(f.audit.recorded()).toHaveLength(1);
});

it("refuses an intact local target row whose org pointer names another org without persisting anything", async () => {
 const control = fixture();expect((await control.request()).result).toBeTruthy();
 const f = fixture();f.member(other, target, "owner");
 const localBefore = f.db.get(orgMemberKey(org, target)), foreignBefore = f.db.get(orgMemberKey(other, target)), pointerBefore = f.db.get(developerOrgKey(target));
 expect(await f.request()).toEqual({ code: "CHANGE_STALE" });
 expect(f.db.get(orgMemberKey(org, target))).toEqual(localBefore);expect(f.db.get(orgMemberKey(other, target))).toEqual(foreignBefore);expect(f.db.get(developerOrgKey(target))).toEqual(pointerBefore);
 expect(f.db.find(row => String(row.pk).includes("ROLE_CHANGE"))).toEqual([]);expect(f.audit.recorded()).toEqual([]);expect(f.audit.pending()).toEqual([]);
});
it("fences a target pointer moved to another org between review and commit", async () => {
 const f = fixture();f.beforeCommit(() => f.member(other, target, "owner"));
 expect(await f.request()).toEqual({ code: "CHANGE_STALE" });expect(f.role()).toBe("member");expect(f.db.get(developerOrgKey(target))).toMatchObject({ orgId: other, role: "owner" });expect(f.db.get(orgMemberKey(other, target))?.role).toBe("owner");expect(f.db.find(row => String(row.pk).includes("ROLE_CHANGE"))).toEqual([]);expect(f.audit.recorded()).toEqual([]);
});
it("puts the shared expiry attribute only on the reviewed replay receipt", async () => {
 const f = fixture();f.audit.queueDown();await f.request();const receipts = f.db.find(row => String(row.pk).includes("ROLE_CHANGE"));
 expect(receipts).toHaveLength(1);expect(receipts[0]?.indexExpiresAt).toBe(Math.floor(f.deps.now() / 1000) + 30 * 86400);expect(f.db.get(orgMemberKey(org, target))).not.toHaveProperty("indexExpiresAt");expect(f.db.get(developerOrgKey(target))).not.toHaveProperty("indexExpiresAt");
});
it("preserves the legacy owner-first refusal for malformed requests without expectedRole", async () => {
 const f = fixture("member");expect(await f.request({ role: "invalid" }, target, { ...f.caller, orgRole: "member" })).toEqual({ code: "FORBIDDEN" });
});
it("preserves field-specific legacy owner validation without expectedRole", async () => {
 const f = fixture(), path = `/v1/app/org/members/${target}/role`;
 await expect(routeDeveloperRequest(f.deps, { method: "PUT", path, headers: {}, requestId: "role-test", body: JSON.stringify({ requestId: id, role: "invalid" }) }, new URL(path, "https://cell.example"))).rejects.toThrow(/^CONFIG_INVALID: role:/);
});
it("skips a stale listed owner and consistently verifies the next owner before self-demotion", async () => {
 const f = fixture(), third = "d".repeat(64);f.member(org, target, "owner");f.member(org, third, "owner");
 const listed = await f.deps.orgs!.listMembers(org);f.member(org, target, "member");f.deps.orgs!.listMembers = async () => listed;
 expect(await f.request({ requestId: id, expectedRole: "owner", role: "member" }, actor)).toEqual({ result: { developerId: actor, role: "member" } });expect(f.role(actor)).toBe("member");expect(f.role(third)).toBe("owner");
});

it("B33 invalidates approval generation on console role changes and not on replay", async () => {
 const f = fixture();f.db.set({ ...f.db.get(orgMetaKey(org)), approvalMembershipVersion: 8 });
 expect((await f.request()).result).toBeTruthy();
 expect(f.db.get(orgMetaKey(org))?.approvalMembershipVersion).toBe(9);
 expect((await f.request()).result).toBeTruthy();
 expect(f.db.get(orgMetaKey(org))?.approvalMembershipVersion).toBe(9);
});
it("B33 records console demotion eligibility loss in the same transaction", async () => {
 const f = fixture();f.member(org, target, "admin");
 expect((await f.request({ requestId: id, expectedRole: "admin", role: "member" })).result).toBeTruthy();
 expect(f.db.get(orgMetaKey(org))?.approvalLastCompanyEligibleLossAt).toBe(new Date(f.deps.now()).toISOString());
});
it("B33 refuses a console role change when the company starts closing at commit", async () => {
 const f = fixture();f.beforeCommit(() => f.db.set({ ...f.db.get(orgMetaKey(org)), closingAt: "now" }));
 expect(await f.request()).toEqual({ code: "CHANGE_STALE" });
 expect(f.role()).toBe("member");expect(f.audit.recorded()).toEqual([]);
});
