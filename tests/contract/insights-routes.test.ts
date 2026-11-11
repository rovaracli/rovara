// Insights (srv/insights-reads): the routes through the real route dispatcher (`routeDeveloperRequest`), the same bench as the Auditor tests: the role gate, the browser-only rule for the grant (refused
// BEFORE the token is even checked), reads open to a token by the same role rule, the switch, and the browser's route list. The reads themselves are in insights-reads.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentXError, developerOrgKey, editionPolicy, orgMemberKey, orgMetaKey, type OrgRole } from "@agentx/contracts";
import { routeDeveloperRequest, type DeveloperCaller, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { webRouteAllowed } from "../../packages/broker/src/aws/web-auth.js";
import { AUDITOR_ALLOWED_ROUTES, AUDITOR_REFUSED, requireAuditorRoute } from "../../packages/broker/src/org/auditor.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

afterEach(() => { delete process.env.INSIGHTS_ENABLED; });
const org = "org_aaaaaaaaaaaaaaaaaaaa", actor = "a".repeat(64), other = "b".repeat(64), sessionId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const ACCESS = "/v1/app/org/insights-access";

function fixture(role: OrgRole) {
  const db = new FakeDynamoDb(), audit = capturingAuditDeps({ db, now: () => Date.parse("2026-11-11T12:00:00Z") });
  const member = (who: string, r: string) => { db.set({ ...orgMemberKey(org, who), orgId: org, developerId: who, role: r, joinedAt: "2026-10-01T00:00:00Z" }); db.set({ ...developerOrgKey(who), orgId: org, developerId: who, role: r }); };
  member(actor, role);
  member(other, "member");
  db.set({ pk: `DEVELOPER#${actor}`, sk: "META", developerId: actor, displayName: "Priya", provider: "oidc" });
  db.set({ pk: `DEVELOPER#${other}`, sk: "META", developerId: other, displayName: "Arjun", provider: "oidc" });
  db.set({ pk: `SESSION#${sessionId}`, sk: "META", developerId: actor, amr: "oidc", endsAt: Math.floor(audit.audit.now() / 1000) + 3600, reviewExpiresAt: Math.floor(audit.audit.now() / 1000) + 3600, startedAt: "2026-11-11T11:00:00Z" });
  db.set({ ...orgMetaKey(org), orgId: org, name: "Acme", plan: "team" });
  const claims = { iss: "https://cell.example/v1/auth", aud: "agentx-developer", sub: actor, sid: sessionId, amr: "oidc", env: "test", org, org_role: role };
  const verifyAccessToken = vi.fn(async () => claims);
  const deps: DeveloperRouteDependencies = {
    tableName: "state", now: audit.audit.now, documentClient: db, audit: { ...audit.audit, tableName: "state" }, editionPolicy: editionPolicy("enterprise"),
    developer: { issuer: "https://cell.example/v1/auth", env: "test", methods: { slack: false, oidc: true, cloud: false }, signInTableName: "state", verifyAccessToken, channelMembers: async () => ({ ok: true, memberOf: [] }) },
    orgs: new OrgStore({ documentClient: db, tableName: "state", now: audit.audit.now }),
    tasks: {} as never,
  };
  const caller: DeveloperCaller = { orgId: org, developerId: actor, orgRole: role, name: "Priya", amr: "oidc", sessionId: "fixture" };
  /** A browser-session call (the caller is given), or with `token` an API call whose caller is read from the bearer token and the live membership. */
  async function call(method: string, path: string, body?: unknown, token = false) {
    const request = { method, path, headers: {}, body: body === undefined ? "" : JSON.stringify(body), requestId: "test" };
    try { return { result: await routeDeveloperRequest(deps, request, new URL(path, "https://cell.example"), token ? undefined : { caller: { ...caller, browserSession: true }, csrf: "csrf" }) as { statusCode?: number; body?: unknown } & Record<string, unknown> }; }
    catch (error) { if (!(error instanceof AgentXError)) throw error; return { code: error.code, message: error.message }; }
  }
  return { db, deps, audit, call, verifyAccessToken, roleOf: (who: string) => db.get(orgMemberKey(org, who))?.role, record: (who: string) => db.get(orgMemberKey(org, who)) };
}
const grant = (developerId: string, action = "grant") => ({ action, requestId, developerId });
const bodyOf = (answer: { result?: unknown }) => (answer.result as { body: Record<string, unknown> }).body;

describe("through the route dispatcher", () => {
  it("serves the overview and the reads to an owner and an admin, and refuses a member with no scope and the Auditor", async () => {
    process.env.INSIGHTS_ENABLED = "1";
    for (const role of ["owner", "admin"] as const) {
      const f = fixture(role);
      expect(bodyOf(await f.call("GET", "/v1/app/insights")), role).toMatchObject({ enabled: true, viewer: { role, scope: { kind: "company" } } });
      expect(bodyOf(await f.call("GET", "/v1/app/insights/spend")), role).toMatchObject({ scope: "company", byPerson: [], outcomes: { status: "unavailable" } });
      expect(bodyOf(await f.call("GET", "/v1/app/insights/stuck")), role).toMatchObject({ status: "unavailable", items: [] });
      expect(bodyOf(await f.call("GET", ACCESS)), role).toMatchObject({ viewers: [], eligibleCount: 1 });
    }
    const member = fixture("member");
    for (const path of ["/v1/app/insights", "/v1/app/insights/stuck", "/v1/app/insights/spend", "/v1/app/insights/shipped", "/v1/app/insights/flow", ACCESS]) expect(await member.call("GET", path), path).toMatchObject({ code: "FORBIDDEN" });
    // The Auditor is held to the audit log by the dispatcher before any Insights code runs, with the dispatcher's own sentence.
    const auditor = fixture("auditor");
    const before = auditor.db.commandNames().length;
    for (const [method, path] of [["GET", "/v1/app/insights"], ["GET", "/v1/app/insights/stuck"], ["GET", "/v1/app/insights/spend"], ["GET", ACCESS], ["POST", ACCESS]] as const) {
      const answer = await auditor.call(method, path, method === "POST" ? grant(other) : undefined);
      expect(answer, path).toMatchObject({ code: "FORBIDDEN" });
      expect((answer as { message: string }).message).toContain(AUDITOR_REFUSED);
    }
    expect(auditor.db.commandNames().length).toBe(before);
  });

  it("answers a token by the same role rule, and refuses a token's write before it is even checked", async () => {
    process.env.INSIGHTS_ENABLED = "1";
    const f = fixture("admin");
    expect(bodyOf(await f.call("GET", "/v1/app/insights/spend", undefined, true))).toMatchObject({ scope: "company" });
    const checked = f.verifyAccessToken.mock.calls.length;
    expect(checked).toBeGreaterThan(0);
    // The write: refused by the dispatcher first (no token check, no read), so a token learns nothing.
    const writes = f.db.transactions().length;
    expect(await f.call("POST", ACCESS, grant(other), true)).toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("Use a live browser session to change who can see Insights.") as unknown });
    expect(f.verifyAccessToken.mock.calls.length).toBe(checked);
    expect(f.db.transactions().length).toBe(writes);
    expect(f.record(other)).not.toHaveProperty("insightsViewer");
  });

  it("grants and revokes from a browser session as an owner or admin, audited, and refuses a member", async () => {
    process.env.INSIGHTS_ENABLED = "1";
    for (const role of ["owner", "admin"] as const) {
      const f = fixture(role);
      const granted = await f.call("POST", ACCESS, grant(other));
      expect(bodyOf(granted), role).toMatchObject({ viewers: [{ person: { id: other, name: "Arjun" } }], eligibleCount: 0 });
      expect(f.record(other)).toMatchObject({ role: "member", insightsViewer: true });
      expect(JSON.stringify(f.record(other))).not.toContain(actor);
      expect(f.audit.recorded().map((event) => event.action)).toEqual(["insights_access.granted"]);
      expect(bodyOf(await f.call("POST", ACCESS, { ...grant(other, "revoke"), requestId: "33333333-3333-4333-8333-333333333333" }))).toMatchObject({ viewers: [], eligibleCount: 1 });
      expect(f.audit.recorded().map((event) => event.action)).toEqual(["insights_access.granted", "insights_access.revoked"]);
      expect(f.roleOf(other)).toBe("member");
    }
    const member = fixture("member");
    expect(await member.call("POST", ACCESS, grant(other))).toMatchObject({ code: "FORBIDDEN" });
    expect(member.record(other)).not.toHaveProperty("insightsViewer");
    expect(member.audit.recorded()).toEqual([]);
  });

  it("is off, and not found, while the switch is off; the overview says so", async () => {
    const f = fixture("owner");
    expect(bodyOf(await f.call("GET", "/v1/app/insights"))).toMatchObject({ enabled: false });
    for (const path of ["/v1/app/insights/stuck", "/v1/app/insights/spend", ACCESS]) expect(await f.call("GET", path), path).toMatchObject({ code: "NOT_FOUND" });
    expect(await f.call("POST", ACCESS, grant(other))).toMatchObject({ code: "NOT_FOUND" });
    expect(f.record(other)).not.toHaveProperty("insightsViewer");
  });
});

describe("the browser's route list and the Auditor's allow-list", () => {
  it("lets the browser read the exact Insights paths and the grant under org, and nothing else of the family", () => {
    for (const path of ["insights", "insights/stuck", "insights/shipped", "insights/spend", "insights/flow"]) {
      expect(webRouteAllowed("GET", `/v1/web/${path}`), path).toBe(true);
      expect(webRouteAllowed("POST", `/v1/web/${path}`), `POST ${path}`).toBe(false);
      expect(webRouteAllowed("DELETE", `/v1/web/${path}`), `DELETE ${path}`).toBe(false);
    }
    for (const path of ["insights/other", "insights/stuck/1", "insights/", "insights/stuck/../spend"]) expect(webRouteAllowed("GET", `/v1/web/${path}`), path).toBe(false);
    expect(webRouteAllowed("GET", "/v1/web/org/insights-access")).toBe(true);
    expect(webRouteAllowed("POST", "/v1/web/org/insights-access")).toBe(true);
  });

  it("never lists Insights for the Auditor", () => {
    for (const path of ["/v1/app/insights", "/v1/app/insights/stuck", "/v1/app/insights/spend", "/v1/app/insights/shipped", "/v1/app/insights/flow", ACCESS, "/v1/dev/insights"]) {
      for (const method of ["GET", "POST"]) expect(() => requireAuditorRoute({ orgRole: "auditor" }, method, path), `${method} ${path}`).toThrow(AUDITOR_REFUSED);
      expect(AUDITOR_ALLOWED_ROUTES.some((route) => route.path.test(path)), path).toBe(false);
    }
  });
});
