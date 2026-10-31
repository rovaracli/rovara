import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BREAK_GLASS_MAX_DAYS, editionPolicy } from "@agentx/contracts";
import { APP_CSRF_HEADER, appCsrfTokenFor } from "../../packages/broker/src/developer/app-csrf.js";
import { dynamoBreakGlassStore, readBreakGlassForSignIn } from "../../packages/broker/src/developer/group-mapping.js";
import { ssoStoresFor } from "../../packages/broker/src/developer/sso-sign-in.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { DEV_ISSUER, MAYA, OMAR, createDeveloperTaskBroker, seedMembership } from "../support/developer-task-broker.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";

// Enterprise foundations I1: the routes an org admin uses to read and save the group mapping (and an owner the emergency sign-in list).

const MAPPING = "/v1/app/org/sso/group-mapping";
const BREAK_GLASS = "/v1/app/org/sso/break-glass";
const ORIGIN = new URL(DEV_ISSUER).origin;
const MEMBER = { ...OMAR, developerId: "e".repeat(64) };
const RULES = [{ id: "admins", group: "rovara-admins", orgRole: "admin", projectRoles: [] }, { id: "users", group: "rovara-users", orgRole: "member", projectRoles: [{ project: "payments", role: "contributor" }] }];

async function world(options: { policy?: ReturnType<typeof editionPolicy> | undefined; role?: "owner" | "admin" | "member"; ledger?: boolean } = {}) {
  const policy = "policy" in options ? options.policy : editionPolicy("enterprise");
  const capture = capturingAuditDeps();
  const db = new FakeDynamoDb();
  const sso = ssoStoresFor({ documentClient: db, tableName: "state", policy, audit: capture.audit });
  const h = await createDeveloperTaskBroker({ brokerExtra: { agents: {}, ...(policy === undefined ? {} : { editionPolicy: policy }), ...(sso === undefined ? {} : { sso }) }, ...(options.ledger === false ? {} : { audit: capture }) });
  // The routes and the stores share one table.
  const stores = ssoStoresFor({ documentClient: h.db, tableName: "state", policy, audit: capture.audit });
  Object.assign(sso ?? {}, stores ?? {});
  // Company (oidc) sessions: the only kind an Enterprise install serves.
  for (const who of [MAYA, OMAR]) h.db.set({ ...h.db.get(`SESSION#${who.sessionId}`, "META")!, amr: "oidc" });
  const dev: typeof h.dev = (who, ...rest) => h.dev({ ...who, provider: "oidc" }, ...rest);
  seedMembership(h.db, MAYA.developerId, { orgId: TEST_ORG, role: options.role ?? "admin" });
  seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
  // A browser session is its own record: a copy of the person's sign-in session, with the review expiry that marks it as the cookie's.
  const browserSessions = new Map<string, string>();
  const browserSessionOf = (who: typeof MAYA): string => {
    let id = browserSessions.get(who.developerId);
    if (id === undefined) {
      id = randomUUID();
      h.db.set({ ...h.db.get(`SESSION#${who.sessionId}`, "META")!, pk: `SESSION#${id}`, sessionId: id, reviewExpiresAt: Math.floor(Date.now() / 1000) + 3600, authTime: new Date().toISOString() });
      browserSessions.set(who.developerId, id);
    }
    return id;
  };
  /** Makes the person's browser session's sign-in `minutes` old (or one with no sign-in time at all). */
  const ageSignIn = (who: typeof MAYA, minutes: number | undefined) => {
    const id = browserSessionOf(who);
    const record = { ...h.db.get(`SESSION#${id}`, "META")! } as Record<string, unknown>;
    if (minutes === undefined) delete record.authTime; else record.authTime = new Date(Date.now() - minutes * 60_000).toISOString();
    h.db.set(record);
  };
  const web = async (who: typeof MAYA, method: string, path: string, body?: unknown) => {
    const id = browserSessionOf(who);
    const response = await h.handler({
      rawPath: path.replace("/v1/app/", "/v1/web/"), rawQueryString: "", routeKey: "ANY /v1/web/{proxy+}",
      headers: { cookie: `__Host-agentx_review_session=${id}`, "sec-fetch-site": "same-origin", origin: ORIGIN, [APP_CSRF_HEADER]: appCsrfTokenFor(id) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), requestContext: { requestId: "r", http: { method } },
    });
    return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
  };
  return { h: { ...h, dev }, capture, web, ageSignIn, sso: sso! };
}

describe("the group mapping routes", () => {
  it("an admin reads nothing at first, saves a mapping from a browser session, reads it back, and the save is audited with the rules it added", async () => {
    const { h, capture, web } = await world();
    expect(await web(MAYA, "GET", MAPPING)).toMatchObject({ status: 200, body: { mapping: null, version: 0 } });
    const saved = await web(MAYA, "PUT", MAPPING, { expectedVersion: 0, claim: "groups", rules: RULES });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ version: 1, mapping: { claim: "groups", version: 1, updatedBy: MAYA.developerId } });
    expect(await web(MAYA, "GET", MAPPING)).toMatchObject({ status: 200, body: { version: 1, mapping: { rules: RULES } } });
    const [event] = capture.recordedBy("sso.group_mapping_changed");
    expect(event).toMatchObject({ orgId: TEST_ORG, actor: { kind: "member", id: MAYA.developerId }, facts: { fromVersion: 0, toVersion: 1, rules: 2 }, details: [{ subject: "org", fields: { added: "admins,users" } }] });
    // Version 2 removes one rule and adds none: the diff is in the record.
    await web(MAYA, "PUT", MAPPING, { expectedVersion: 1, claim: "groups", rules: [RULES[0]] });
    expect(capture.recordedBy("sso.group_mapping_changed")[1]).toMatchObject({ facts: { fromVersion: 1, toVersion: 2, rules: 1 }, details: [{ fields: { removed: "users" } }] });
    expect(h.db.get(`ORG#${TEST_ORG}`, "SSO_GROUP_MAPPING")).toMatchObject({ version: 2 });
  });

  it("a stale save is refused and changes nothing (compare and set)", async () => {
    const { web, capture } = await world();
    await web(MAYA, "PUT", MAPPING, { expectedVersion: 0, claim: "groups", rules: RULES });
    const stale = await web(MAYA, "PUT", MAPPING, { expectedVersion: 0, claim: "groups", rules: [RULES[0]] });
    expect(stale.status).toBe(409);
    expect(capture.recordedBy("sso.group_mapping_changed")).toHaveLength(1);
    expect((await web(MAYA, "GET", MAPPING)).body).toMatchObject({ version: 1 });
  });

  it("a mapping that grants owner, names a claim a person can edit, or is malformed is refused", async () => {
    const { web, capture } = await world();
    const bad = [
      { expectedVersion: 0, claim: "groups", rules: [{ id: "x", group: "g", orgRole: "owner", projectRoles: [] }] },
      { expectedVersion: 0, claim: "email", rules: RULES },
      { expectedVersion: 0, claim: "groups", rules: [] },
      { expectedVersion: 0, claim: "groups", rules: [RULES[0], { ...RULES[1], group: "rovara-admins" }] },
      { expectedVersion: 0, claim: "groups", rules: RULES, extra: true },
      { expectedVersion: -1, claim: "groups", rules: RULES },
    ];
    for (const body of bad) expect((await web(MAYA, "PUT", MAPPING, body)).status, JSON.stringify(body).slice(0, 80)).toBe(400);
    expect((await web(MAYA, "GET", MAPPING)).body).toMatchObject({ version: 0 });
    expect(capture.recordedBy("sso.group_mapping_changed")).toEqual([]);
  });

  it("a token (not a live browser session) can read but not save", async () => {
    const { h } = await world();
    expect((await h.dev(MAYA, "GET", MAPPING)).status).toBe(200);
    const refused = await h.dev(MAYA, "PUT", MAPPING, { expectedVersion: 0, claim: "groups", rules: RULES });
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body)).toContain("live browser session");
    expect((await h.dev(MAYA, "GET", MAPPING)).body).toMatchObject({ version: 0 });
  });

  it("a member can neither read nor save", async () => {
    const { web, h } = await world({ role: "member" });
    expect((await web(MAYA, "GET", MAPPING)).status).toBe(403);
    expect((await web(MAYA, "PUT", MAPPING, { expectedVersion: 0, claim: "groups", rules: RULES })).status).toBe(403);
    expect(h.db.get(`ORG#${TEST_ORG}`, "SSO_GROUP_MAPPING")).toBeUndefined();
  });

  it("Public is told it is the Enterprise edition's; an install with no edition has no such route", async () => {
    const publicWorld = await world({ policy: editionPolicy("public") });
    const refused = await publicWorld.web(MAYA, "GET", MAPPING);
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body)).toContain("part of the Enterprise edition");
    expect((await publicWorld.web(MAYA, "PUT", MAPPING, { expectedVersion: 0, claim: "groups", rules: RULES })).status).toBe(403);
    const legacy = await world({ policy: undefined });
    expect((await legacy.web(MAYA, "GET", MAPPING)).status).toBe(404);
    expect((await legacy.h.dev(MAYA, "PUT", MAPPING, { expectedVersion: 0, claim: "groups", rules: RULES })).status).toBe(404);
  });
});

describe("a change to company sign-in needs a fresh sign-in and the audit ledger (fix round 1, I-4)", () => {
  it("refuses a save from a session whose sign-in is older than the fresh window, or has no time, and changes nothing; a read is not affected", async () => {
    const { web, ageSignIn, capture } = await world({ role: "owner" });
    const owners = [{ personId: MAYA.developerId, expiresAt: Date.now() + 5 * 86_400_000 }];
    for (const age of [11, 600, undefined]) {
      ageSignIn(MAYA, age);
      const mapping = await web(MAYA, "PUT", MAPPING, { expectedVersion: 0, claim: "groups", rules: RULES });
      expect(mapping.status, JSON.stringify(mapping.body)).toBe(403);
      expect(JSON.stringify(mapping.body)).toContain("REAUTH_REQUIRED");
      expect(JSON.stringify(mapping.body)).toContain("Sign in again");
      expect((await web(MAYA, "PUT", BREAK_GLASS, { expectedVersion: 0, owners })).status, String(age)).toBe(403);
      expect((await web(MAYA, "GET", MAPPING)).status).toBe(200);
    }
    expect((await web(MAYA, "GET", MAPPING)).body).toMatchObject({ version: 0 });
    expect(capture.recorded().filter((event) => event.action.startsWith("sso."))).toEqual([]);
    ageSignIn(MAYA, 5);
    expect((await web(MAYA, "PUT", MAPPING, { expectedVersion: 0, claim: "groups", rules: RULES })).status).toBe(200);
    expect((await web(MAYA, "PUT", BREAK_GLASS, { expectedVersion: 0, owners })).status).toBe(200);
  });

  it("refuses a save when there is no ledger to record it in", async () => {
    const { web } = await world({ role: "owner", ledger: false });
    const refused = await web(MAYA, "PUT", MAPPING, { expectedVersion: 0, claim: "groups", rules: RULES });
    expect(refused.status).toBe(503);
    expect((await web(MAYA, "GET", MAPPING)).body).toMatchObject({ version: 0 });
    expect((await web(MAYA, "PUT", BREAK_GLASS, { expectedVersion: 0, owners: [] })).status).toBe(503);
  });

  it("a flush that fails after a committed save does not fail the save", async () => {
    const { web, capture } = await world({ role: "owner" });
    capture.queueDown();
    const saved = await web(MAYA, "PUT", MAPPING, { expectedVersion: 0, claim: "groups", rules: RULES });
    expect(saved.status).toBe(200);
    expect(capture.pending().filter((event) => event.action === "sso.group_mapping_changed")).toHaveLength(1);
  });
});

describe("the emergency sign-in list routes", () => {
  const future = (days: number) => Date.now() + days * 86_400_000;

  it("an owner saves a list of current owners, each with an expiry; the save is audited; an admin can neither read nor save", async () => {
    const { web, capture } = await world({ role: "owner" });
    expect(await web(MAYA, "GET", BREAK_GLASS)).toMatchObject({ status: 200, body: { owners: [], version: 0, maxDays: BREAK_GLASS_MAX_DAYS } });
    const saved = await web(MAYA, "PUT", BREAK_GLASS, { expectedVersion: 0, owners: [{ personId: MAYA.developerId, expiresAt: future(30) }] });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ version: 1, owners: [{ personId: MAYA.developerId }] });
    expect(capture.recordedBy("sso.break_glass_changed")[0]).toMatchObject({ facts: { owners: 1 }, details: [{ fields: { ownerIds: MAYA.developerId } }] });
    const adminWorld = await world({ role: "admin" });
    expect((await adminWorld.web(MAYA, "GET", BREAK_GLASS)).status).toBe(403);
    expect((await adminWorld.web(MAYA, "PUT", BREAK_GLASS, { expectedVersion: 0, owners: [] })).status).toBe(403);
  });

  it("refuses a person who is not an owner, an entry with no expiry or one too far away, more than two, and a token", async () => {
    const { web, h } = await world({ role: "owner" });
    seedMembership(h.db, MEMBER.developerId, { orgId: TEST_ORG, role: "member" });
    const cases = [
      { owners: [{ personId: "c".repeat(64), expiresAt: future(10) }] },
      // A member of the org who is not an owner.
      { owners: [{ personId: MEMBER.developerId, expiresAt: future(10) }] },
      { owners: [{ personId: MAYA.developerId }] },
      { owners: [{ personId: MAYA.developerId, expiresAt: future(BREAK_GLASS_MAX_DAYS + 5) }] },
      { owners: [{ personId: MAYA.developerId, expiresAt: Date.now() - 1000 }] },
      { owners: [{ personId: MAYA.developerId, expiresAt: future(5) }, { personId: OMAR.developerId, expiresAt: future(5) }, { personId: MAYA.developerId, expiresAt: future(6) }] },
    ];
    for (const body of cases) expect((await web(MAYA, "PUT", BREAK_GLASS, { expectedVersion: 0, ...body })).status, JSON.stringify(body).slice(0, 90)).toBe(400);
    expect((await h.dev(MAYA, "PUT", BREAK_GLASS, { expectedVersion: 0, owners: [] })).status).toBe(403);
    expect((await web(MAYA, "GET", BREAK_GLASS)).body).toMatchObject({ version: 0 });
  });

  it("the sign-in reads no list when none is stored, an unreadable one, or one that does not parse: no break-glass", async () => {
    const db = new FakeDynamoDb();
    const store = dynamoBreakGlassStore({ documentClient: db, tableName: "state", policy: editionPolicy("enterprise") });
    expect(await readBreakGlassForSignIn(store, TEST_ORG)).toEqual([]);
    db.set({ pk: `ORG#${TEST_ORG}`, sk: "SSO_BREAK_GLASS", owners: [{ personId: "not-a-hash" }], version: 1, updatedAt: "x", updatedBy: "y" });
    expect(await readBreakGlassForSignIn(store, TEST_ORG)).toEqual([]);
    const broken = { get: async () => { throw new Error("DynamoDB is down"); }, put: async () => { throw new Error("unused"); } };
    expect(await readBreakGlassForSignIn(broken as never, TEST_ORG)).toEqual([]);
  });
});
