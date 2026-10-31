// The dispatcher bench of auditor-role.test.ts with the session's sign-in time under the test's control (the fixture there has none).
import { developerOrgKey, editionPolicy, orgMemberKey, orgMetaKey, AgentXError, type OrgRole } from "@agentx/contracts";
import { routeDeveloperRequest, type DeveloperCaller, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const org = "org_aaaaaaaaaaaaaaaaaaaa", actor = "a".repeat(64), sessionId = "11111111-1111-4111-8111-111111111111";

export function fixtureWithSession(role: OrgRole, authTime: string | undefined) {
  const db = new FakeDynamoDb(), audit = capturingAuditDeps({ db, now: () => Date.parse("2026-10-26T12:00:00Z") });
  db.set({ ...orgMemberKey(org, actor), orgId: org, developerId: actor, role, joinedAt: "2026-10-01T00:00:00Z" });
  db.set({ ...developerOrgKey(actor), orgId: org, developerId: actor, role });
  db.set({ pk: `DEVELOPER#${actor}`, sk: "META", developerId: actor, displayName: "Priya", provider: "cloud" });
  db.set({ pk: `SESSION#${sessionId}`, sk: "META", developerId: actor, amr: "cloud", endsAt: Math.floor(audit.audit.now() / 1000) + 3600, startedAt: "2026-10-26T11:00:00Z", ...(authTime === undefined ? {} : { authTime }) });
  db.set({ ...orgMetaKey(org), orgId: org, name: "Acme", plan: "team" });
  const claims = { iss: "https://cell.example/v1/auth", aud: "agentx-developer", sub: actor, sid: sessionId, amr: "cloud", env: "test", org, org_role: role };
  const deps: DeveloperRouteDependencies = {
    tableName: "state", now: audit.audit.now, documentClient: db, audit: { ...audit.audit, tableName: "state" }, editionPolicy: editionPolicy("enterprise"),
    developer: { issuer: "https://cell.example/v1/auth", env: "test", methods: { slack: false, oidc: false, cloud: true }, signInTableName: "state", verifyAccessToken: async () => claims, channelMembers: async () => ({ ok: true, memberOf: false }) } as never,
    orgs: new OrgStore({ documentClient: db, tableName: "state", now: audit.audit.now }),
    tasks: {} as never,
  };
  const caller: DeveloperCaller = { orgId: org, developerId: actor, orgRole: role, name: "Priya", amr: "cloud", sessionId };
  async function call(method: string, path: string, body?: unknown) {
    const request = { method, path, headers: {}, body: body === undefined ? "" : JSON.stringify(body), requestId: "test" };
    try { return { result: await routeDeveloperRequest(deps, request, new URL(path, "https://cell.example"), { caller: { ...caller, browserSession: true }, csrf: "csrf" }) }; }
    catch (error) { if (!(error instanceof AgentXError)) throw error; return { code: error.code, message: error.message }; }
  }
  return { db, call };
}
