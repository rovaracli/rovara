import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { expect, it } from "vitest";
import { developerOrgKey, orgMemberKey, orgMetaKey, orgSlackTeamKey, projectMemberKey, projectMetaKey, slackBindingKey, slackTeamOrgKey, type OrgId } from "@agentx/contracts";
import { projectSlackBrowserHttp } from "../../packages/broker/src/org/project-slack-browser-http.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { readProjectSlackTarget, readProjectSlackRequest, listProjectSlackBindings, commitProjectSlackUnbind } from "../../packages/broker/src/org/project-slack-browser.js";
const orgId = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId, by = "a".repeat(64), project = "payments", teamId = "T0123456789", channelId = "C0123456789", requestId = "11111111-1111-4111-8111-111111111111", at = Date.parse("2026-10-30T06:50:00Z");
function fixture() {
 const db = new FakeDynamoDb();db.set({ ...orgMetaKey(orgId), orgId, createdAt: "2026-10-01T00:00:00Z" });
 db.set({ ...orgMemberKey(orgId, by), orgId, developerId: by, role: "owner" });db.set({ ...developerOrgKey(by), orgId, role: "owner" });db.set({ pk: `DEVELOPER#${by}`, sk: "META", developerId: by, revoked: false });
 db.set({ ...projectMetaKey(orgId, project), name: project, status: "active", createdAt: "2026-10-01T00:00:00Z", createdBy: by, archiveRevision: 0 });
 db.set({ ...orgSlackTeamKey(orgId, teamId), teamId });db.set({ ...slackTeamOrgKey(teamId), teamId, orgId });
 const deps = { documentClient: db, tableName: "state", signInTableName: "signin", now: () => at };
 const input = { orgId, project, by, teamId, channelId };
 return { db, deps, input, read: () => readProjectSlackTarget(deps, input) };
}
it("reads exact connected targets from stored company state with no writes or Slack calls", async () => {
 const f = fixture();f.db.set({ ...slackBindingKey(orgId, teamId, channelId), teamId, channelId, projectName: project, updatedAt: "2026-10-01T00:00:00Z" });const before = f.db.find(() => true);
 const result = await f.read();expect(result).toMatchObject({ orgId, project, teamId, channelId, state: "linked", projectStatus: "active", botMembership: "not_verified" });expect(result.contextDigest).toMatch(/^[a-f0-9]{64}$/);expect(f.db.find(() => true)).toEqual(before);
});
it("distinguishes unlinked from disconnected and occupied without another project's name", async () => {
 const f = fixture();expect(await f.read()).toMatchObject({ state: "unlinked" });f.db.set({ ...slackBindingKey(orgId, teamId, channelId), teamId, channelId, projectName: "secret-project", updatedAt: "2026-10-01T00:00:00Z" });
 const occupied = f.read();await expect(occupied).rejects.toMatchObject({ code: "CONFIG_INVALID" });await expect(occupied).rejects.toThrow("This Slack channel is unavailable for this project.");f.db.delete(slackTeamOrgKey(teamId));await expect(f.read()).rejects.toMatchObject({ code: "SLACK_TEAM_NOT_BOUND" });
});
for (const role of ["member", "auditor", "unknown"]) it(`refuses ${role} before project or workspace reads`, async () => {
 const f = fixture();f.db.set({ ...orgMemberKey(orgId, by), orgId, developerId: by, role });const sent: unknown[] = [], send = f.db.send.bind(f.db);f.db.send = async command => { sent.push(command);return send(command); };
 await expect(f.read()).rejects.toMatchObject({ code: "FORBIDDEN" });expect(sent).toHaveLength(1);
});
it("returns only an actor-owned unexpired existing request receipt", async () => {
 const f = fixture(), key = { pk: projectMetaKey(orgId, project).pk, sk: `SLACK_BINDING_REQUEST#${requestId}` };
 f.db.set({ ...key, by, action: "unbind", bodyHash: "digest", at: new Date(at).toISOString(), indexExpiresAt: at / 1000 + 86400, response: { teamId, channelId, removed: true } });
 expect(await readProjectSlackRequest(f.deps, { orgId, project, by, requestId })).toMatchObject({ requestId, operation: "unbind", outcome: { teamId, channelId, removed: true } });
 f.db.set({ ...f.db.get(key), by: "b".repeat(64) });await expect(readProjectSlackRequest(f.deps, { orgId, project, by, requestId })).rejects.toMatchObject({ code: "NOT_FOUND" });
 f.db.set({ ...f.db.get(key), by, indexExpiresAt: at / 1000 });await expect(readProjectSlackRequest(f.deps, { orgId, project, by, requestId })).rejects.toMatchObject({ code: "NOT_FOUND" });
});
it("refuses company close, revoked identity and workspace reassociation", async () => {
 const f = fixture();f.db.set({ ...slackTeamOrgKey(teamId), teamId, orgId: "org_bbbbbbbbbbbbbbbbbbbb" });await expect(f.read()).rejects.toMatchObject({ code: "SLACK_TEAM_NOT_BOUND" });
 f.db.set({ ...slackTeamOrgKey(teamId), teamId, orgId });f.db.set({ pk: `DEVELOPER#${by}`, sk: "META", developerId: by, revoked: true });await expect(f.read()).rejects.toMatchObject({ code: "FORBIDDEN" });
 f.db.set({ pk: `DEVELOPER#${by}`, sk: "META", developerId: by, revoked: false });f.db.set({ ...f.db.get(orgMetaKey(orgId)), closingAt: new Date(at).toISOString() });await expect(f.read()).rejects.toMatchObject({ code: "FORBIDDEN" });
});

it("pages stored project bindings at 100 rows with an untrusted scope-pinned cursor", async () => {
 const f = fixture();for (let i = 0; i < 105; i++) { const id = "C" + String(i).padStart(10, "0");f.db.set({ ...slackBindingKey(orgId, teamId, id), teamId, channelId: id, projectName: project, updatedAt: "2026-10-01T00:00:00Z" }); }
 const first = await listProjectSlackBindings(f.deps, { orgId, project, by });expect(first.bindings).toHaveLength(100);expect(first.continuation).toBeTruthy();expect(first.partial).toBe(true);
 const next = await listProjectSlackBindings(f.deps, { orgId, project, by, cursor: first.continuation! });expect(next.bindings).toHaveLength(5);expect(next.continuation).toBeNull();
 await expect(listProjectSlackBindings(f.deps, { orgId, project, by, cursor: Buffer.from(JSON.stringify({ orgId: "org_bbbbbbbbbbbbbbbbbbbb", project, teamId })).toString("base64url") })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
});
it("does not query disconnected workspaces or show other project names", async () => {
 const f = fixture();f.db.set({ ...slackBindingKey(orgId, teamId, channelId), teamId, channelId, projectName: "secret-project", updatedAt: "2026-10-01T00:00:00Z" });
 expect(JSON.stringify(await listProjectSlackBindings(f.deps, { orgId, project, by }))).not.toContain("secret-project");
 f.db.delete(slackTeamOrgKey(teamId));await expect(listProjectSlackBindings(f.deps, { orgId, project, by })).rejects.toMatchObject({ code: "SLACK_TEAM_NOT_BOUND" });
});
it("caps workspace enumeration and refuses a cursor naming an unconnected team", async () => {
 const f = fixture();for (let i = 0; i < 21; i++) { const id = "T" + String(i).padStart(10, "0");f.db.set({ ...orgSlackTeamKey(orgId, id), teamId: id });f.db.set({ ...slackTeamOrgKey(id), teamId: id, orgId }); }
 const result = await listProjectSlackBindings(f.deps, { orgId, project, by });expect(result.workspaces).toHaveLength(20);expect(result.limitReached).toBe(true);expect(result.partial).toBe(true);
 await expect(listProjectSlackBindings(f.deps, { orgId, project, by, cursor: Buffer.from(JSON.stringify({ orgId, project, teamId: "T9999999999" })).toString("base64url") })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
});

it("browser read boundary rejects bearer and wrong-company inputs before any database read", async () => {
 const f = fixture(), before = f.db.commandNames().length, request = { operation: "list" as const, expectedOrgId: orgId };
 await expect(projectSlackBrowserHttp(f.deps, { developerId: by, orgId }, project, request)).rejects.toMatchObject({ code: "FORBIDDEN" });
 await expect(projectSlackBrowserHttp(f.deps, { developerId: by, orgId, browserSession: true }, project, { ...request, expectedOrgId: "org_bbbbbbbbbbbbbbbbbbbb" })).rejects.toMatchObject({ code: "CHANGE_STALE" });expect(f.db.commandNames()).toHaveLength(before);
});
it("browser database-only reads stop at thirty per person before inventory enumeration", async () => {
 const f = fixture(), caller = { developerId: by, orgId, browserSession: true as const }, request = { operation: "list" as const, expectedOrgId: orgId };
 for (let i = 0; i < 30; i++) await projectSlackBrowserHttp(f.deps, caller, project, request);
 await expect(projectSlackBrowserHttp(f.deps, caller, project, request)).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
});
it("the inventory stops a filtered scan at 1000 and provides a scope-checked continuation", async () => {
 const f = fixture();for (let i = 0; i < 1001; i++) { const id = "C" + String(i).padStart(10, "0");f.db.set({ ...slackBindingKey(orgId, teamId, id), teamId, channelId: id, projectName: i === 1000 ? project : "another-project", updatedAt: "2026-10-01T00:00:00Z" }); }
 const result = await listProjectSlackBindings(f.deps, { orgId, project, by });expect(result).toMatchObject({ inspected: 1000, limitReached: true, partial: true, bindings: [] });expect(result.continuation).toBeTruthy();
 const next = await listProjectSlackBindings(f.deps, { orgId, project, by, cursor: result.continuation! });expect(next.bindings).toHaveLength(1);
});

async function unlinkFixture() {
 const f = fixture(), audit = capturingAuditDeps({ db: f.db });audit.audit.documentClient = f.db as unknown as typeof audit.audit.documentClient;
 f.db.set({ ...slackBindingKey(orgId, teamId, channelId), entityType: "SLACK_BINDING", teamId, channelId, projectName: project, updatedAt: "2026-10-01T00:00:00Z" });
 const context = await f.read();const deps = { ...f.deps, audit: audit.audit, orgs: { bindSlackTeam: async () => { throw new Error("Browser unbind must never connect a workspace"); } } };
 const body = { ...f.input, requestId, expectedContextDigest: context.contextDigest };
 return { ...f, audit, deps, body, unlink: () => commitProjectSlackUnbind(deps, body) };
}
it("unlinks with one atomic existing binding/request/audit transaction and status-only replay", async () => {
 const f = await unlinkFixture();expect(await f.unlink()).toMatchObject({ teamId, channelId, removed: true });expect(f.db.get(slackBindingKey(orgId, teamId, channelId))).toBeUndefined();
 expect(f.db.get({ pk: projectMetaKey(orgId, project).pk, sk: `SLACK_BINDING_REQUEST#${requestId}` })).toBeDefined();expect(f.audit.recordedBy("slack_channel.unbound")).toHaveLength(1);
 const writes = f.db.transactions().length;expect(await f.unlink()).toMatchObject({ removed: true });expect(f.db.transactions()).toHaveLength(writes);
});
for (const race of ["workspace", "role", "archive", "binding"]) it(`refuses an unbind ${race} race without partial state or re-plan`, async () => {
 const f = await unlinkFixture();let fired = false;
 f.db.injectFault({ command: "TransactWriteCommand", match: () => { if (fired) return false;fired = true;
  if (race === "workspace") f.db.set({ ...slackTeamOrgKey(teamId), orgId: "org_bbbbbbbbbbbbbbbbbbbb" });
  if (race === "role") f.db.set({ ...f.db.get(orgMemberKey(orgId, by)), role: "member" });
  if (race === "archive") f.db.set({ ...f.db.get(projectMetaKey(orgId, project)), archiveRevision: 1 });
  if (race === "binding") f.db.set({ ...f.db.get(slackBindingKey(orgId, teamId, channelId)), updatedAt: "2026-10-30T06:59:00Z" });return false;
 }, error: { name: "InternalServerError" } });
 await expect(f.unlink()).rejects.toBeDefined();expect(fired).toBe(true);expect(f.db.transactions()).toHaveLength(1);expect(f.db.get(slackBindingKey(orgId, teamId, channelId))).toBeDefined();expect(f.audit.recordedBy("slack_channel.unbound")).toEqual([]);
 expect(f.db.get({ pk: projectMetaKey(orgId, project).pk, sk: `SLACK_BINDING_REQUEST#${requestId}` })).toBeUndefined();
});
it("browser unbind refuses missing audit before changing a stored link", async () => {
 const f = await unlinkFixture();const { audit: ignoredAudit, ...withoutAudit } = f.deps;void ignoredAudit;await expect(commitProjectSlackUnbind(withoutAudit, f.body)).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE" });expect(f.db.get(slackBindingKey(orgId, teamId, channelId))).toBeDefined();
});

it("browser unbind attempts stop at ten per person and replay is read-budgeted without another delete", async () => {
 const f = await unlinkFixture(), caller = { developerId: by, orgId, browserSession: true as const };
 const body = { expectedOrgId: orgId, requestId, teamId, channelId, expectedContextDigest: f.body.expectedContextDigest };
 expect(await projectSlackBrowserHttp(f.deps, caller, project, { operation: "unbind", body })).toMatchObject({ receipt: { outcome: { removed: true } } });
 const writes = f.db.transactions().length;expect(await projectSlackBrowserHttp(f.deps, caller, project, { operation: "unbind", body })).toMatchObject({ receipt: { outcome: { removed: true } } });expect(f.db.transactions()).toHaveLength(writes);
 for (let i = 1; i < 10; i++) await expect(projectSlackBrowserHttp(f.deps, caller, project, { operation: "unbind", body: { ...body, requestId: `22222222-1111-4111-8111-${String(i).padStart(12, "0")}` } })).rejects.toMatchObject({ code: "CHANGE_STALE" });
 await expect(projectSlackBrowserHttp(f.deps, caller, project, { operation: "unbind", body: { ...body, requestId: "33333333-1111-4111-8111-111111111111" } })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
});
it("a browser unbind cannot supply authority or cross-company bodies", async () => {
 const f = await unlinkFixture(), caller = { developerId: by, orgId, browserSession: true as const }, body = { expectedOrgId: orgId, requestId, teamId, channelId, expectedContextDigest: f.body.expectedContextDigest };
 const before = f.db.commandNames().length;
 await expect(projectSlackBrowserHttp(f.deps, caller, project, { operation: "unbind", body: { ...body, expectedOrgId: "org_bbbbbbbbbbbbbbbbbbbb" } })).rejects.toMatchObject({ code: "CHANGE_STALE" });expect(f.db.commandNames()).toHaveLength(before);
 await expect(projectSlackBrowserHttp(f.deps, caller, project, { operation: "unbind", body: { ...body, reviewed: { conditions: [] } } })).rejects.toMatchObject({ code: "CONFIG_INVALID" });expect(f.db.get(slackBindingKey(orgId, teamId, channelId))).toBeDefined();
});

it("the company mutation budget stops at sixty across distinct live owners", async () => {
 const f = await unlinkFixture();let n = 0;
 for (let person = 1; person <= 6; person++) {
  const id = String(person).repeat(64);f.db.set({ ...orgMemberKey(orgId, id), orgId, developerId: id, role: "owner" });f.db.set({ ...developerOrgKey(id), orgId, role: "owner" });f.db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, revoked: false });
  for (let i = 0; i < 10; i++) await expect(projectSlackBrowserHttp(f.deps, { developerId: id, orgId, browserSession: true }, project, { operation: "unbind", body: { expectedOrgId: orgId, teamId, channelId, requestId: `77777777-1111-4111-8111-${String(++n).padStart(12, "0")}`, expectedContextDigest: "f".repeat(64) } })).rejects.toMatchObject({ code: "CHANGE_STALE" });
 }
 const id = "7".repeat(64);f.db.set({ ...orgMemberKey(orgId, id), orgId, developerId: id, role: "owner" });f.db.set({ ...developerOrgKey(id), orgId, role: "owner" });f.db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, revoked: false });
 await expect(projectSlackBrowserHttp(f.deps, { developerId: id, orgId, browserSession: true }, project, { operation: "unbind", body: { expectedOrgId: orgId, teamId, channelId, requestId, expectedContextDigest: f.body.expectedContextDigest } })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });expect(f.db.get(slackBindingKey(orgId, teamId, channelId))).toBeDefined();
});
for (const fault of ["foreign-key", "oversized", "deadline"]) it(`bounds inventory ${fault} responses before another query`, async () => {
 const f = fixture(), send = f.db.send.bind(f.db);let elapsed = 0, queries = 0;
 f.db.send = async command => {
  if (command instanceof QueryCommand) { queries++;
   if (fault === "foreign-key") return { Items: [], LastEvaluatedKey: { pk: "ORG#foreign", sk: "SLACK_TEAM#T0123456789" } };
   if (fault === "oversized") return { Items: [], padding: "x".repeat(524289) };
   elapsed = 10001;
  }
  return send(command);
 };
 await expect(listProjectSlackBindings({ ...f.deps, now: () => at + elapsed }, { orgId, project, by })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });expect(queries).toBe(1);
});
it("caps empty advancing query pages at 100 even with a non-advancing clock", async () => {
 const f = fixture(), send = f.db.send.bind(f.db);let queries = 0;
 f.db.send = async command => {
  if (command instanceof QueryCommand) {
   queries++;if (queries > 101) throw new Error("Test query ceiling reached");
   if (command.input.ExpressionAttributeValues?.[":prefix"] === "CHANNEL#") return { Items: [], LastEvaluatedKey: slackBindingKey(orgId, teamId, "C" + String(queries).padStart(10, "0")) };
  }
  return send(command);
 };
 await expect(listProjectSlackBindings(f.deps, { orgId, project, by })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });expect(queries).toBeLessThanOrEqual(100);
});
it("bounds the cumulative inventory response bytes across otherwise small pages", async () => {
 const f = fixture(), send = f.db.send.bind(f.db);let queries = 0;
 f.db.send = async command => {
  if (command instanceof QueryCommand) { queries++;if (command.input.ExpressionAttributeValues?.[":prefix"] === "CHANNEL#") return { Items: [], padding: "x".repeat(400000), LastEvaluatedKey: slackBindingKey(orgId, teamId, "C" + String(queries).padStart(10, "0")) };
   return { ...await send(command) as object, padding: "x".repeat(400000) };
  }
  return send(command);
 };
 await expect(listProjectSlackBindings(f.deps, { orgId, project, by })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });expect(queries).toBe(3);
});
it("refuses an oversized exact binding record before deriving a review context", async () => {
 const f = fixture();f.db.set({ ...slackBindingKey(orgId, teamId, channelId), teamId, channelId, projectName: project, updatedAt: "2026-10-01T00:00:00Z", padding: "x".repeat(524289) });await expect(f.read()).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
});

it("B34 bind approval uses two live company people even with an unset legacy counter", async () => {
 const f = fixture(), approverId = "b".repeat(64);
 f.db.set({ ...orgMemberKey(orgId, approverId), orgId, developerId: approverId, role: "admin" });f.db.set({ ...developerOrgKey(approverId), orgId, role: "admin" });f.db.set({ pk: `DEVELOPER#${approverId}`, sk: "META", developerId: approverId, revoked: false });
 const policy = await import("../../packages/broker/src/org/project-slack-browser.js");
 const proof = await policy.readProjectSlackBindApproval(f.deps, { ...f.input, by: approverId, proposerId: by, approverId });
 expect(proof.decision.mode).toBe("second_person");expect(proof.conditions.some(item => item.ConditionCheck?.ConditionExpression?.includes("attribute_not_exists(approvalMembershipVersion)"))).toBe(true);
});
it("B34 bind approval allows a tracked sole owner but never counts project maintainers as company approvers", async () => {
 const f = fixture();f.db.set({ ...orgMetaKey(orgId), orgId, createdAt: "2026-10-01T00:00:00Z", approvalMembershipVersion: 1, approvalTrackingSince: "2026-10-01T00:00:00Z" });
 const memberId = "b".repeat(64);f.db.set({ ...projectMemberKey(orgId, memberId, project), ownerKey: memberId, projectName: project, role: "developer", projectRole: "maintainer", grantId: "maintainer-grant" });f.db.set({ ...orgMemberKey(orgId, memberId), orgId, developerId: memberId, role: "member" });f.db.set({ ...developerOrgKey(memberId), orgId, role: "member" });f.db.set({ pk: `DEVELOPER#${memberId}`, sk: "META", developerId: memberId, revoked: false });
 const policy = await import("../../packages/broker/src/org/project-slack-browser.js");
 expect((await policy.readProjectSlackBindApproval(f.deps, { ...f.input, proposerId: by, approverId: by })).decision.mode).toBe("sole_owner_exception");
 await expect(policy.readProjectSlackBindApproval(f.deps, { ...f.input, by: memberId, proposerId: by, approverId: memberId })).rejects.toMatchObject({ code: "FORBIDDEN" });
});
it.each([0, 86399999])("B34 bind approval refuses sole-owner eligible loss within 24h (%s ms)", async elapsed => {
 const f = fixture();f.db.set({ ...orgMetaKey(orgId), orgId, createdAt: "2026-10-01T00:00:00Z", approvalMembershipVersion: 1, approvalTrackingSince: "2026-10-01T00:00:00Z", approvalLastCompanyEligibleLossAt: new Date(at - elapsed).toISOString() });
 const policy = await import("../../packages/broker/src/org/project-slack-browser.js");await expect(policy.readProjectSlackBindApproval(f.deps, { ...f.input, proposerId: by, approverId: by })).rejects.toMatchObject({ code: "FORBIDDEN" });
});
it("B34 bind approval fails closed for sole-owner missing history", async () => {
 const f = fixture(), policy = await import("../../packages/broker/src/org/project-slack-browser.js");await expect(policy.readProjectSlackBindApproval(f.deps, { ...f.input, proposerId: by, approverId: by })).rejects.toMatchObject({ code: "CHANGE_STALE" });
});

it("B34 bind approval permits a sole owner at the 24h loss boundary", async () => {
 const f = fixture();f.db.set({ ...orgMetaKey(orgId), orgId, createdAt: "2026-10-01T00:00:00Z", approvalMembershipVersion: 1, approvalTrackingSince: "2026-10-01T00:00:00Z", approvalLastCompanyEligibleLossAt: new Date(at - 86400000).toISOString() });
 const policy = await import("../../packages/broker/src/org/project-slack-browser.js");expect((await policy.readProjectSlackBindApproval(f.deps, { ...f.input, proposerId: by, approverId: by })).decision.mode).toBe("sole_owner_exception");
});
it("B34 bind approval refuses an admin approving their own proposal", async () => {
 const f = fixture();f.db.set({ ...orgMemberKey(orgId, by), orgId, developerId: by, role: "admin" });f.db.set({ ...developerOrgKey(by), orgId, role: "admin" });f.db.set({ ...orgMetaKey(orgId), orgId, createdAt: "2026-10-01T00:00:00Z", approvalMembershipVersion: 1, approvalTrackingSince: "2026-10-01T00:00:00Z" });
 const policy = await import("../../packages/broker/src/org/project-slack-browser.js");await expect(policy.readProjectSlackBindApproval(f.deps, { ...f.input, proposerId: by, approverId: by })).rejects.toMatchObject({ code: "FORBIDDEN" });
});

function bindProposalFixture() {
 const f = fixture(), audit = capturingAuditDeps();audit.attach(f.db);audit.audit.tableName = f.deps.tableName;audit.audit.documentClient = f.db as never;
 const deps = { ...f.deps, audit: audit.audit, orgs: { bindSlackTeam: async () => { throw new Error("Approval must never connect a workspace"); } } };
 return { ...f, deps, audit };
}
async function proposeBinding(f: ReturnType<typeof bindProposalFixture>) {
 const policy = await import("../../packages/broker/src/org/project-slack-proposals.js");const target = await readProjectSlackTarget(f.deps, f.input);
 const body = { requestId, teamId, channelId, expectedContextDigest: target.contextDigest };
 return { policy, body, proposal: await policy.proposeProjectSlackBinding(f.deps, { ...f.input, body }) };
}
it("B34 pending bind records expiry and replay without changing the canonical binding", async () => {
 const f = bindProposalFixture(), { policy, body, proposal } = await proposeBinding(f);
 expect(proposal).toMatchObject({ proposalId: requestId, state: "pending", by, teamId, channelId, expiresAt: new Date(at + 86400000).toISOString(), indexExpiresAt: Math.floor(at / 1000) + 31 * 86400 });
 expect(f.db.get(slackBindingKey(orgId, teamId, channelId))).toBeUndefined();
 const before = f.db.find(() => true);expect(await policy.proposeProjectSlackBinding(f.deps, { ...f.input, body })).toEqual(proposal);expect(f.db.find(() => true)).toEqual(before);
 await expect(policy.proposeProjectSlackBinding(f.deps, { ...f.input, body: { ...body, channelId: "C0987654321" } })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
 expect(f.audit.recordedBy("slack_channel.proposed")).toHaveLength(1);
});
it("B34 second-person bind commits proposal terminal, receipt, canonical binding and one bound audit", async () => {
 const f = bindProposalFixture(), { policy, proposal } = await proposeBinding(f), approverId = "b".repeat(64);
 f.db.set({ ...orgMemberKey(orgId, approverId), orgId, developerId: approverId, role: "admin" });f.db.set({ ...developerOrgKey(approverId), orgId, role: "admin" });f.db.set({ pk: `DEVELOPER#${approverId}`, sk: "META", developerId: approverId, revoked: false });
 const approve = { ...f.input, by: approverId, proposalId: proposal.proposalId, requestId: "22222222-2222-4222-8222-222222222222" };
 const outcome = await policy.approveProjectSlackBinding(f.deps, approve);expect(outcome.changed).toBe(true);expect(f.db.get(slackBindingKey(orgId, teamId, channelId))).toMatchObject({ projectName: project, updatedBy: approverId });
 expect((await policy.readProjectSlackProposal(f.deps, { ...f.input, proposalId: requestId })).state).toBe("applied");
 expect(f.audit.recordedBy("slack_channel.bound")).toMatchObject([{ facts: { mode: "second_person", proposalId: requestId }, actor: { kind: "member", id: approverId } }]);
 expect(await policy.approveProjectSlackBinding(f.deps, approve)).toEqual(outcome);expect(f.audit.recordedBy("slack_channel.bound")).toHaveLength(1);
});
it("B34 expired bind proposals never authorize a binding even while cleanup TTL remains", async () => {
 const f = bindProposalFixture(), { policy } = await proposeBinding(f);f.deps.now = () => at + 86400000;
 await expect(policy.approveProjectSlackBinding(f.deps, { ...f.input, proposalId: requestId, requestId: "22222222-2222-4222-8222-222222222222" })).rejects.toMatchObject({ code: "CHANGE_STALE" });expect(f.db.get(slackBindingKey(orgId, teamId, channelId))).toBeUndefined();
});

for (const race of ["membership", "workspace", "project", "person", "binding", "pointer"] as const) it(`B34 bind approval atomically refuses ${race} race without a replan`, async () => {
 const f = bindProposalFixture(), { policy } = await proposeBinding(f), approverId = "b".repeat(64);
 f.db.set({ ...orgMemberKey(orgId, approverId), orgId, developerId: approverId, role: "admin" });f.db.set({ ...developerOrgKey(approverId), orgId, role: "admin" });f.db.set({ pk: `DEVELOPER#${approverId}`, sk: "META", developerId: approverId, revoked: false });
 const send = f.db.send.bind(f.db);let attempts = 0;
 f.db.send = async command => {
  const items = (command as { input?: { TransactItems?: Array<{ Put?: { Item?: Record<string, unknown> } }> } }).input?.TransactItems;
  if (items?.some(item => item.Put?.Item?.entityType === "SLACK_BINDING")) {
   attempts++;
   if (race === "membership") f.db.set({ ...f.db.get(orgMetaKey(orgId))!, approvalMembershipVersion: 1 });
   if (race === "workspace") f.db.set({ ...slackTeamOrgKey(teamId), teamId, orgId: "org_bbbbbbbbbbbbbbbbbbbb" });
   if (race === "project") f.db.set({ ...f.db.get(projectMetaKey(orgId, project))!, createdAt: "2026-10-30T06:51:00Z" });
   if (race === "person") f.db.set({ pk: `DEVELOPER#${approverId}`, sk: "META", developerId: approverId, revoked: true });
   if (race === "binding") f.db.set({ ...slackBindingKey(orgId, teamId, channelId), entityType: "SLACK_BINDING", teamId, channelId, projectName: "other-project", updatedAt: new Date(at).toISOString() });
   if (race === "pointer") f.db.delete({ pk: projectMetaKey(orgId, project).pk, sk: "SLACK_BINDING_PROPOSAL_LIVE" });
  }
  return send(command);
 };
 const approvalId = "22222222-2222-4222-8222-222222222222";
 await expect(policy.approveProjectSlackBinding(f.deps, { ...f.input, by: approverId, proposalId: requestId, requestId: approvalId })).rejects.toBeDefined();
 expect(attempts).toBe(1);expect(f.audit.recordedBy("slack_channel.bound")).toHaveLength(0);
 expect(f.db.get({ pk: projectMetaKey(orgId, project).pk, sk: `SLACK_BINDING_PROPOSAL#${requestId}` })).toMatchObject({ state: "pending" });
 expect(f.db.get({ pk: projectMetaKey(orgId, project).pk, sk: `SLACK_BINDING_REQUEST#${approvalId}` })).toBeUndefined();
 if (race !== "binding") expect(f.db.get(slackBindingKey(orgId, teamId, channelId))).toBeUndefined();
});
it("B34 sole-owner binding applies only with complete history and records the exception mode", async () => {
 const f = bindProposalFixture(), { policy } = await proposeBinding(f);
 f.db.set({ ...orgMetaKey(orgId), orgId, createdAt: "2026-10-01T00:00:00Z", approvalMembershipVersion: 1, approvalTrackingSince: "2026-10-01T00:00:00Z" });
 await policy.approveProjectSlackBinding(f.deps, { ...f.input, proposalId: requestId, requestId: "22222222-2222-4222-8222-222222222222" });
 expect(f.audit.recordedBy("slack_channel.bound")).toMatchObject([{ facts: { mode: "sole_owner_exception" } }]);
});
it("B34 sole-owner bind cool-off refuses without terminal, receipt or binding writes", async () => {
 const f = bindProposalFixture(), { policy } = await proposeBinding(f);
 f.db.set({ ...orgMetaKey(orgId), orgId, createdAt: "2026-10-01T00:00:00Z", approvalMembershipVersion: 1, approvalTrackingSince: "2026-10-01T00:00:00Z", approvalLastCompanyEligibleLossAt: new Date(at - 86399999).toISOString() });
 await expect(policy.approveProjectSlackBinding(f.deps, { ...f.input, proposalId: requestId, requestId: "22222222-2222-4222-8222-222222222222" })).rejects.toMatchObject({ code: "FORBIDDEN" });
 expect(f.db.get(slackBindingKey(orgId, teamId, channelId))).toBeUndefined();expect(f.audit.recordedBy("slack_channel.bound")).toHaveLength(0);
});
it("B34 approval expires during evidence reads before its final write", async () => {
 const f = bindProposalFixture(), { policy } = await proposeBinding(f), approverId = "b".repeat(64);
 f.db.set({ ...orgMemberKey(orgId, approverId), orgId, developerId: approverId, role: "admin" });f.db.set({ ...developerOrgKey(approverId), orgId, role: "admin" });f.db.set({ pk: `DEVELOPER#${approverId}`, sk: "META", developerId: approverId, revoked: false });
 const send = f.db.send.bind(f.db);let workspaceReads = 0;
 f.db.send = async command => {
  const key = (command as { input?: { Key?: Record<string, unknown> } }).input?.Key;
  if (key?.pk === slackTeamOrgKey(teamId).pk && ++workspaceReads === 2) f.deps.now = () => at + 86400000;
  return send(command);
 };
 await expect(policy.approveProjectSlackBinding(f.deps, { ...f.input, by: approverId, proposalId: requestId, requestId: "22222222-2222-4222-8222-222222222222" })).rejects.toMatchObject({ code: "CHANGE_STALE" });
 expect(f.db.get(slackBindingKey(orgId, teamId, channelId))).toBeUndefined();
});
it("B34 browser adapter proposes and exposes the live pending bind for another company admin", async () => {
 const f = bindProposalFixture(), target = await f.read();
 const proposed = await projectSlackBrowserHttp(f.deps, { developerId: by, orgId, browserSession: true }, project, { operation: "propose", body: { expectedOrgId: orgId, requestId, teamId, channelId, expectedContextDigest: target.contextDigest } } as never);
 expect(proposed).toMatchObject({ kind: "proposal", orgId, project, proposal: { proposalId: requestId, state: "pending" } });
 const live = await projectSlackBrowserHttp(f.deps, { developerId: by, orgId, browserSession: true }, project, { operation: "proposal", expectedOrgId: orgId } as never);expect(live).toEqual(proposed);
 expect(f.db.get(slackBindingKey(orgId, teamId, channelId))).toBeUndefined();
});
