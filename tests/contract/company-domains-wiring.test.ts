import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { orgMetaKey, type OrgId } from "@agentx/contracts";
import { APP_CSRF_HEADER, appCsrfTokenFor } from "../../packages/broker/src/developer/app-csrf.js";
import { runCompanyDomainRecheck, DOMAIN_RECHECK_LIMIT } from "../../packages/broker/src/org/company-domains/recheck.js";
import type { TxtResolver } from "../../packages/broker/src/org/company-domains/resolver.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { addCompanyDomain, ownKey } from "../../packages/broker/src/org/company-domains/store.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { DEV_ISSUER, MAYA, OMAR, createDeveloperTaskBroker, seedMembership } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";

// The company domains page is reachable through the real request handler (browser session, CSRF, edition-free), and the daily re-check rides the every-minute recovery run.

const ORIGIN = new URL(DEV_ISSUER).origin;
const DAY = 86_400_000;
const ORG_FIRST: OrgId = "org_aaaaaaaaaaaaaaaaaaaa";

async function world() {
  const capture = capturingAuditDeps();
  const h = await createDeveloperTaskBroker({ audit: capture });
  seedMembership(h.db, MAYA.developerId, { orgId: TEST_ORG, role: "admin" });
  seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
  const sessions = new Map<string, string>();
  const sessionOf = (who: typeof MAYA, authAgoMinutes: number): string => {
    let id = sessions.get(who.developerId);
    if (id === undefined) {
      id = randomUUID();
      h.db.set({ ...h.db.get(`SESSION#${who.sessionId}`, "META")!, pk: `SESSION#${id}`, sessionId: id, reviewExpiresAt: Math.floor(Date.now() / 1000) + 3600 });
      sessions.set(who.developerId, id);
    }
    h.db.set({ ...h.db.get(`SESSION#${id}`, "META")!, authTime: new Date(Date.now() - authAgoMinutes * 60_000).toISOString() });
    return id;
  };
  const web = async (who: typeof MAYA, method: string, path: string, body?: unknown, authAgoMinutes = 0) => {
    const id = sessionOf(who, authAgoMinutes);
    const response = await h.handler({
      rawPath: path.replace("/v1/app/", "/v1/web/"), rawQueryString: "", routeKey: "ANY /v1/web/{proxy+}",
      headers: { cookie: `__Host-agentx_review_session=${id}`, "sec-fetch-site": "same-origin", origin: ORIGIN, [APP_CSRF_HEADER]: appCsrfTokenFor(id) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), requestContext: { requestId: "r", http: { method } },
    });
    return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
  };
  return { h, capture, web };
}

describe("the Company domains routes through the handler", () => {
  it("an owner adds, lists and removes; an admin is refused; a stale sign-in is refused", async () => {
    const { h, capture, web } = await world();
    expect((await web(MAYA, "GET", "/v1/app/org/domains")).status).toBe(403);
    expect((await web(MAYA, "POST", "/v1/app/org/domains", { domain: "acme.example" })).status).toBe(403);
    const stale = await web(OMAR, "POST", "/v1/app/org/domains", { domain: "acme.example" }, 90);
    expect(stale.status).toBe(403);
    expect(JSON.stringify(stale.body)).toContain("Sign in again");
    expect(h.db.get(ownKey(TEST_ORG, "acme.example"))).toBeUndefined();

    const added = await web(OMAR, "POST", "/v1/app/org/domains", { domain: "Acme.Example" });
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({ domain: { domain: "acme.example", state: "pending", record: { type: "TXT", name: "_rovara-verify.acme.example" } } });
    const listed = await web(OMAR, "GET", "/v1/app/org/domains");
    expect(listed).toMatchObject({ status: 200, body: { domains: [{ domain: "acme.example" }], max: 20, lostAfterDays: 3 } });
    expect(capture.recordedBy("company_domain.added")).toHaveLength(1);

    expect(await web(OMAR, "POST", "/v1/app/org/domains/remove", { domain: "acme.example" })).toMatchObject({ status: 200, body: { removed: true } });
    expect((await web(OMAR, "GET", "/v1/app/org/domains")).body).toMatchObject({ domains: [] });
  });

  it("a token (not a live browser session) can read but not change", async () => {
    const { h } = await world();
    expect((await h.dev(OMAR, "GET", "/v1/app/org/domains")).status).toBe(200);
    expect((await h.dev(OMAR, "POST", "/v1/app/org/domains", { domain: "acme.example" })).status).toBe(403);
  });
});

describe("the daily re-check on the every-minute recovery run", () => {
  it("runs on the merge-recovery tick: a company that has closed gives its domain up", async () => {
    const { h } = await world();
    const closed = "org_cccccccccccccccccccc" as OrgId;
    h.db.set({ ...orgMetaKey(closed), entityType: "ORG", orgId: closed, closedAt: new Date().toISOString() });
    await addCompanyDomain({ documentClient: h.db, tableName: "state", now: () => Date.now() - 2 * DAY }, { orgId: closed, by: "a".repeat(64), domain: "gone.example" });
    expect(h.db.get(ownKey(closed, "gone.example"))).toBeDefined();
    const tick = await h.handler({ source: "agentx.workflow-merge-recovery" });
    expect(tick.statusCode).toBe(200);
    expect(JSON.parse(tick.body)).toMatchObject({ domains: { released: 1 } });
    expect(h.db.get(ownKey(closed, "gone.example"))).toBeUndefined();
  });

  it("finds nothing due on a quiet tick and still answers 200", async () => {
    const { h } = await world();
    const tick = await h.handler({ source: "agentx.workflow-merge-recovery" });
    expect(tick.statusCode).toBe(200);
    expect(JSON.parse(tick.body)).toMatchObject({ domains: { checked: 0, released: 0 } });
  });
});

describe("the re-check has its own bounded slot in the recovery tick", () => {
  async function dueWorld(count: number) {
    const db = new FakeDynamoDb();
    const looked: string[] = [];
    const resolver: TxtResolver = { lookupTxt: async (name) => { looked.push(name); return { kind: "absent" }; } };
    const clock = { at: Date.now() - 2 * DAY };
    const deps = { documentClient: db, tableName: "state", now: () => clock.at };
    for (let index = 0; index < count; index += 1) await addCompanyDomain(deps, { orgId: ORG_FIRST, by: "a".repeat(64), domain: `d${String(index)}.example` });
    clock.at = Date.now();
    return { deps, resolver, looked };
  }

  it("looks at nothing when the tick has less than a lookup's deadline plus a second to spare", async () => {
    const { deps, resolver, looked } = await dueWorld(3);
    for (const remainingMs of [26_000 - 25_000, 7_999, 0, -5]) expect(await runCompanyDomainRecheck(deps, { remainingMs, resolver }), String(remainingMs)).toMatchObject({ checked: 0 });
    expect(looked).toEqual([]);
  });

  it("looks at no more than its limit a tick, and only from the time that is left", async () => {
    const { deps, resolver, looked } = await dueWorld(5);
    expect(await runCompanyDomainRecheck(deps, { remainingMs: 20_000, resolver })).toMatchObject({ checked: DOMAIN_RECHECK_LIMIT });
    expect(looked).toHaveLength(DOMAIN_RECHECK_LIMIT);
  });
});
