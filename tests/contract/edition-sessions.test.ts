import { randomUUID } from "node:crypto";
import { decodeJwt } from "jose";
import { describe, expect, it } from "vitest";
import { editionPolicy, orgMetaKey } from "@agentx/cloud-contracts";
import { APP_CSRF_HEADER, appCsrfTokenFor } from "../../packages/broker/src/developer/app-csrf.js";
import { sessionWithinEditionCap } from "../../packages/broker/src/developer/edition-methods.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { DEV_ISSUER, MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { T0, authorizeQuery, httpEvent, identityHarness } from "../support/developer-fakes.js";
import { TEST_ORG } from "../support/orgs.js";

// Enterprise foundations I-1 (fix round 1): the edition's rules hold for sessions that already existed when the install became Enterprise.

const enterprise = editionPolicy("enterprise");
const HOUR = 3_600_000;

async function broker(extra: Record<string, unknown>, session: { amr: "slack" | "oidc"; startedHoursAgo: number }) {
  const h = await createDeveloperTaskBroker({ brokerExtra: { agents: {}, ...extra } });
  h.db.set({ ...orgMetaKey(TEST_ORG), orgId: TEST_ORG, name: "Acme", plan: "team", createdBy: "system", createdAt: "2026-10-23T12:00:00Z" });
  h.db.set({ pk: `SESSION#${MAYA.sessionId}`, sk: "META", sessionId: MAYA.sessionId, developerId: MAYA.developerId, amr: session.amr, startedAt: new Date(Date.now() - session.startedHoursAgo * HOUR).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
  const who = { ...MAYA, provider: session.amr };
  const cookieSession = randomUUID();
  h.db.set({ ...h.db.get(`SESSION#${MAYA.sessionId}`, "META")!, pk: `SESSION#${cookieSession}`, sessionId: cookieSession, reviewExpiresAt: Math.floor(Date.now() / 1000) + 3600 });
  const web = async () => {
    const response = await h.handler({
      rawPath: "/v1/web/me", rawQueryString: "", routeKey: "ANY /v1/web/{proxy+}",
      headers: { cookie: `__Host-agentx_review_session=${cookieSession}`, "sec-fetch-site": "same-origin", origin: new URL(DEV_ISSUER).origin, [APP_CSRF_HEADER]: appCsrfTokenFor(cookieSession) },
      requestContext: { requestId: "r", http: { method: "GET" } },
    });
    return response.statusCode;
  };
  return { token: async () => (await h.dev(who, "GET", "/v1/app/me")).status, web };
}

describe("a session that existed before the install became Enterprise", () => {
  it("a Slack session is refused at every request, on the token API and on the browser cookie", async () => {
    const w = await broker({ editionPolicy: enterprise }, { amr: "slack", startedHoursAgo: 1 });
    expect(await w.token()).toBe(401);
    expect(await w.web()).toBe(401);
  });

  it("the same session is served on Public and where the install has no edition", async () => {
    for (const extra of [{ editionPolicy: editionPolicy("public") }, {}]) {
      const w = await broker(extra, { amr: "slack", startedHoursAgo: 1 });
      expect(await w.token()).toBe(200);
      expect(await w.web()).toBe(200);
    }
  });

  it("a company session older than the edition's cap is refused, however long it was issued for; a younger one is served", async () => {
    const old = await broker({ editionPolicy: enterprise }, { amr: "oidc", startedHoursAgo: 9 });
    expect(await old.token()).toBe(401);
    expect(await old.web()).toBe(401);
    const young = await broker({ editionPolicy: enterprise }, { amr: "oidc", startedHoursAgo: 7 });
    expect(await young.token()).toBe(200);
    expect(await young.web()).toBe(200);
    // Public has no cap.
    const publicOld = await broker({ editionPolicy: editionPolicy("public") }, { amr: "oidc", startedHoursAgo: 9 });
    expect(await publicOld.token()).toBe(200);
  });
});

describe("the cap check", () => {
  it("counts from the start, and treats a start it cannot read as outside the cap", () => {
    const now = Date.parse("2026-10-31T12:00:00Z");
    expect(sessionWithinEditionCap(enterprise, "2026-10-31T11:00:00Z", now)).toBe(true);
    expect(sessionWithinEditionCap(enterprise, "2026-10-31T03:00:00Z", now)).toBe(false);
    expect(sessionWithinEditionCap(enterprise, "garbage", now)).toBe(false);
    expect(sessionWithinEditionCap(undefined, "garbage", now)).toBe(true);
    expect(sessionWithinEditionCap(editionPolicy("public"), "2020-01-01T00:00:00Z", now)).toBe(true);
  });
});

describe("the sign-in server", () => {
  it("refuses to refresh a session that is older than the edition's cap, whatever its stored end", async () => {
    const h = identityHarness({ oidc: {}, oidcUsers: [{ sub: "una", name: "Una", email: "una@example.test", email_verified: true }], slack: false });
    await h.orgs.ensureOrg(TEST_ORG, "staging");
    const started = await h.http(httpEvent("GET", authorizeQuery()));
    const back = await h.http(httpEvent("GET", h.oidc.approve(started.headers.location!, "una")));
    const tokens = (await h.exchange(new URL(back.headers.location!).searchParams.get("code")!)).body;
    h.tick(9 * HOUR);
    h.deps.editionPolicy = enterprise;
    expect((await h.refresh(String(tokens.refresh_token))).status).toBe(400);
    h.deps.editionPolicy = undefined as never;
    // Without the edition the same refresh works (the cap is the edition's, not a side effect).
    const again = identityHarness({ oidc: {}, oidcUsers: [{ sub: "una", name: "Una", email: "una@example.test", email_verified: true }], slack: false });
    await again.orgs.ensureOrg(TEST_ORG, "staging");
    const s2 = await again.http(httpEvent("GET", authorizeQuery()));
    const b2 = await again.http(httpEvent("GET", again.oidc.approve(s2.headers.location!, "una")));
    const t2 = (await again.exchange(new URL(b2.headers.location!).searchParams.get("code")!)).body;
    again.tick(9 * HOUR);
    expect((await again.refresh(String(t2.refresh_token))).status).toBe(200);
  });

  it("an access token never outlives its session", async () => {
    const short = { ...enterprise, sessionMaxSeconds: 600 };
    const capture = capturingAuditDeps();
    const h = identityHarness({ oidc: {}, oidcUsers: [{ sub: "una", name: "Una", email: "una@example.test", email_verified: true, groups: ["g"] }], editionPolicy: short, sso: true, audit: capture });
    await h.orgs.ensureOrg(TEST_ORG, "staging");
    await h.deps.sso!.mappings.put(TEST_ORG, { claim: "groups", rules: [{ id: "g", group: "g", orgRole: "member", projectRoles: [] }], updatedAt: "2026-10-31T00:00:00Z", updatedBy: "a".repeat(64) }, 0);
    const started = await h.http(httpEvent("GET", authorizeQuery()));
    const back = await h.http(httpEvent("GET", h.oidc.approve(started.headers.location!, "una")));
    const tokens = (await h.exchange(new URL(back.headers.location!).searchParams.get("code")!)).body;
    const claims = decodeJwt(String(tokens.access_token));
    expect(claims.exp! - claims.iat!).toBeLessThanOrEqual(600);
    expect(Number(tokens.expires_in)).toBeLessThanOrEqual(600);
    expect(claims.exp!).toBeLessThanOrEqual(Math.floor(T0 / 1000) + 600);
  });
});
