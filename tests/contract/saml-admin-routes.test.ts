import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { editionPolicy } from "@agentx/contracts";
import { APP_CSRF_HEADER, appCsrfTokenFor } from "../../packages/broker/src/developer/app-csrf.js";
import { SAML_ENTITY_ID_LOCKED_MESSAGE } from "../../packages/broker/src/aws/developer-routes/sso.js";
import { dynamoSamlConfigStore } from "../../packages/broker/src/developer/saml.js";
import { ssoStoresFor } from "../../packages/broker/src/developer/sso-sign-in.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { DEV_ISSUER, MAYA, OMAR, createDeveloperTaskBroker, seedMembership } from "../support/developer-task-broker.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";
import { TEST_IDP_ENTITY, TEST_SSO_URL, makeIdpKey } from "../support/saml-fixtures.js";

// Enterprise foundations I4: the routes an org admin uses to read and save the SAML identity provider settings.

const SAML = "/v1/app/org/sso/saml";
const ORIGIN = new URL(DEV_ISSUER).origin;

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
      h.db.set({ ...h.db.get(`SESSION#${who.sessionId}`, "META")!, pk: `SESSION#${id}`, sessionId: id, reviewExpiresAt: Math.floor(Date.now() / 1000) + 3600, authTime: new Date().toISOString(), groupClaims: { groups: ["rovara-admins", "rovara-users"] } });
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

const key = makeIdpKey();
const SETTINGS = { idpEntityId: TEST_IDP_ENTITY, ssoUrl: TEST_SSO_URL, certificate: key.certificate, enabled: true };
const save = (expectedVersion: number, overrides: Record<string, unknown> = {}) => ({ expectedVersion, ...SETTINGS, ...overrides });

describe("the SAML settings routes", () => {
  it("an admin reads nothing at first (with the addresses to give the provider), saves from a browser session, reads it back, and the save is audited without the settings' values", async () => {
    const { capture, web } = await world();
    const first = await web(MAYA, "GET", SAML);
    expect(first).toMatchObject({ status: 200, body: { settings: null, version: 0, serviceProvider: { entityId: `${DEV_ISSUER}/saml/metadata`, acsUrl: `${DEV_ISSUER}/callback/saml`, metadataUrl: `${DEV_ISSUER}/saml/metadata` } } });
    const saved = await web(MAYA, "PUT", SAML, save(0));
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ version: 1, settings: { idpEntityId: TEST_IDP_ENTITY, ssoUrl: TEST_SSO_URL, enabled: true, version: 1, updatedBy: MAYA.developerId } });
    expect(await web(MAYA, "GET", SAML)).toMatchObject({ status: 200, body: { version: 1, settings: { idpEntityId: TEST_IDP_ENTITY } } });
    const [event] = capture.recordedBy("sso.saml_changed");
    expect(event).toMatchObject({ orgId: TEST_ORG, actor: { kind: "member", id: MAYA.developerId }, facts: { fromVersion: 0, toVersion: 1, changed: "entity_id,sign_in_address,certificate,enabled" } });
    expect(event!.details).toEqual([{ subject: "org", fields: { certificateSha256: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown } }]);
    // The values themselves (the address, the entity id, the certificate) are in no audit record.
    expect(JSON.stringify(capture.recorded())).not.toMatch(/idp\.example\.test|BEGIN CERTIFICATE/);
    // Version 2 turns it off: only that is recorded as changed.
    await web(MAYA, "PUT", SAML, save(1, { enabled: false }));
    expect(capture.recordedBy("sso.saml_changed")[1]).toMatchObject({ facts: { fromVersion: 1, toVersion: 2, changed: "enabled" } });
    expect(h_item(await web(MAYA, "GET", SAML))).toMatchObject({ enabled: false, version: 2 });
  });

  it("a stale save is refused and changes nothing (compare and set)", async () => {
    const { web, capture } = await world();
    await web(MAYA, "PUT", SAML, save(0));
    const stale = await web(MAYA, "PUT", SAML, save(0, { enabled: false }));
    expect(stale.status).toBe(409);
    expect(capture.recordedBy("sso.saml_changed")).toHaveLength(1);
    expect(h_item(await web(MAYA, "GET", SAML))).toMatchObject({ enabled: true, version: 1 });
  });

  it("the provider's entity id cannot be changed once saved (every account is tied to it); the other settings can", async () => {
    const { web, capture } = await world();
    await web(MAYA, "PUT", SAML, save(0));
    const refused = await web(MAYA, "PUT", SAML, save(1, { idpEntityId: "https://another.example.test/entity" }));
    expect(refused.status).toBe(400);
    expect((refused.body.error as { message: string }).message).toBe(SAML_ENTITY_ID_LOCKED_MESSAGE);
    expect(capture.recordedBy("sso.saml_changed")).toHaveLength(1);
    const other = makeIdpKey();
    expect((await web(MAYA, "PUT", SAML, save(1, { certificate: other.certificate, ssoUrl: "https://idp.example.test/new-sso" }))).status).toBe(200);
    expect(capture.recordedBy("sso.saml_changed")[1]).toMatchObject({ facts: { changed: "sign_in_address,certificate" } });
  });

  it("settings that are malformed, unsafe or whose certificate is unusable are refused and change nothing", async () => {
    const { web, capture } = await world();
    const expired = makeIdpKey({ notBefore: new Date(Date.now() - 800 * 86_400_000), notAfter: new Date(Date.now() - 86_400_000) });
    const weak = makeIdpKey({ bits: 1024 });
    const bad: Array<[string, Record<string, unknown>, number]> = [
      ["http address", { ssoUrl: "http://idp.example.test/sso" }, 400],
      ["address with credentials", { ssoUrl: "https://user:pw@idp.example.test/sso" }, 400],
      ["address with a fragment", { ssoUrl: "https://idp.example.test/sso#x" }, 400],
      ["not an address", { ssoUrl: "javascript:alert(1)" }, 400],
      ["empty entity id", { idpEntityId: "" }, 400],
      ["entity id with a control character", { idpEntityId: "a\u0000b" }, 400],
      ["a private key instead of a certificate", { certificate: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n" }, 400],
      ["a certificate block of garbage", { certificate: "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n" }, 400],
      ["an expired certificate", { certificate: expired.certificate }, 400],
      ["a 1024-bit certificate", { certificate: weak.certificate }, 400],
      ["an unknown field", { extra: true }, 400],
      ["enabled as a string", { enabled: "yes" }, 400],
    ];
    for (const [name, overrides, status] of bad) expect((await web(MAYA, "PUT", SAML, save(0, overrides))).status, name).toBe(status);
    expect((await web(MAYA, "PUT", SAML, { ...SETTINGS })).status).toBe(400);
    expect((await web(MAYA, "GET", SAML)).body).toMatchObject({ version: 0, settings: null });
    expect(capture.recordedBy("sso.saml_changed")).toEqual([]);
  });

  it("a token (not a live browser session) can read but not save", async () => {
    const { h } = await world();
    expect((await h.dev(MAYA, "GET", SAML)).status).toBe(200);
    const refused = await h.dev(MAYA, "PUT", SAML, save(0));
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body)).toContain("live browser session");
    expect(h.db.get(`ORG#${TEST_ORG}`, "SSO_SAML_IDP")).toBeUndefined();
  });

  it("a member can neither read nor save", async () => {
    const { web, h } = await world({ role: "member" });
    expect((await web(MAYA, "GET", SAML)).status).toBe(403);
    expect((await web(MAYA, "PUT", SAML, save(0))).status).toBe(403);
    expect(h.db.get(`ORG#${TEST_ORG}`, "SSO_SAML_IDP")).toBeUndefined();
  });

  it("Public is told it is the Enterprise edition's and cannot save; an install with no edition has no such route", async () => {
    const publicWorld = await world({ policy: editionPolicy("public") });
    const refused = await publicWorld.web(MAYA, "GET", SAML);
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body)).toContain("part of the Enterprise edition");
    expect((await publicWorld.web(MAYA, "PUT", SAML, save(0))).status).toBe(403);
    expect(publicWorld.h.db.get(`ORG#${TEST_ORG}`, "SSO_SAML_IDP")).toBeUndefined();
    const legacy = await world({ policy: undefined });
    expect((await legacy.web(MAYA, "GET", SAML)).status).toBe(404);
    expect((await legacy.h.dev(MAYA, "PUT", SAML, save(0))).status).toBe(404);
  });

  it("the store itself refuses to read or save for the Public edition, even if built by mistake", async () => {
    expect(ssoStoresFor({ documentClient: new FakeDynamoDb(), tableName: "state", policy: editionPolicy("public") })).toBeUndefined();
    const db = new FakeDynamoDb();
    const store = dynamoSamlConfigStore({ documentClient: db, tableName: "state", policy: editionPolicy("public") });
    await expect(store.get(TEST_ORG)).rejects.toThrow();
    await expect(store.put(TEST_ORG, SETTINGS, MAYA.developerId, 0, Date.now())).rejects.toThrow();
    expect(db.get(`ORG#${TEST_ORG}`, "SSO_SAML_IDP")).toBeUndefined();
  });
});

describe("a SAML settings change is high risk: a fresh sign-in, a live browser session and the audit ledger", () => {
  it("refuses a save from a session whose sign-in is older than the fresh window, or has no time, and changes nothing; a read is not affected", async () => {
    const { web, ageSignIn, capture } = await world({ role: "owner" });
    for (const age of [11, 600, undefined]) {
      ageSignIn(MAYA, age);
      const refused = await web(MAYA, "PUT", SAML, save(0));
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      expect(JSON.stringify(refused.body)).toContain("REAUTH_REQUIRED");
      expect((await web(MAYA, "GET", SAML)).status).toBe(200);
    }
    expect((await web(MAYA, "GET", SAML)).body).toMatchObject({ version: 0 });
    expect(capture.recorded().filter((event) => event.action.startsWith("sso."))).toEqual([]);
    ageSignIn(MAYA, 5);
    expect((await web(MAYA, "PUT", SAML, save(0))).status).toBe(200);
  });

  it("refuses a save when there is no ledger to record it in", async () => {
    const { web } = await world({ role: "owner", ledger: false });
    expect((await web(MAYA, "PUT", SAML, save(0))).status).toBe(503);
    expect((await web(MAYA, "GET", SAML)).body).toMatchObject({ version: 0 });
  });

  it("a flush that fails after a committed save does not fail the save", async () => {
    const { web, capture } = await world({ role: "owner" });
    capture.queueDown();
    expect((await web(MAYA, "PUT", SAML, save(0))).status).toBe(200);
    expect(capture.pending().filter((event) => event.action === "sso.saml_changed")).toHaveLength(1);
  });
});

function h_item(response: { body: Record<string, unknown> }): unknown {
  return response.body.settings;
}
