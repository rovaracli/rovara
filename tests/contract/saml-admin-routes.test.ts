import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { editionPolicy } from "@agentx/cloud-contracts";
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

const SECOND_OWNER = { ...OMAR, developerId: "f".repeat(64), name: "Second Owner", sessionId: "s-second" };
const OTHER_ORG = "org_cccccccccccccccccccc" as const;

async function world(options: { policy?: ReturnType<typeof editionPolicy> | undefined; role?: "owner" | "admin" | "member"; ledger?: boolean; reservedIssuers?: string[]; ownerInOtherOrg?: boolean } = {}) {
  const sent: Array<{ to: string[]; subject: string; text: string }> = [];
  const policy = "policy" in options ? options.policy : editionPolicy("enterprise");
  const capture = capturingAuditDeps();
  const db = new FakeDynamoDb();
  const sso = ssoStoresFor({ documentClient: db, tableName: "state", policy, audit: capture.audit });
  const h = await createDeveloperTaskBroker({
    brokerExtra: {
      agents: {}, ...(policy === undefined ? {} : { editionPolicy: policy }), ...(sso === undefined ? {} : { sso }),
      // The same SES sender the sign-in notices use (DEVELOPER_NOTICE_EMAIL_FROM); the owners are told of every SAML settings change through it.
      githubConnectedNotice: {
        ses: { send: async (command: { input: { Destination: { ToAddresses: string[] }; Content: { Simple: { Subject: { Data: string }; Body: { Text: { Data: string } } } } } }) => {
          sent.push({ to: command.input.Destination.ToAddresses, subject: command.input.Content.Simple.Subject.Data, text: command.input.Content.Simple.Body.Text.Data });
          return {};
        } },
        from: "Rovara <signin@rovara.dev>", log: () => undefined,
      },
    },
    developerExtra: { methods: { slack: true, oidc: true, saml: true }, ...(options.reservedIssuers === undefined ? {} : { reservedIssuers: options.reservedIssuers }) },
    ...(options.ledger === false ? {} : { audit: capture }),
  });
  // The routes and the stores share one table.
  const stores = ssoStoresFor({ documentClient: h.db, tableName: "state", policy, audit: capture.audit });
  Object.assign(sso ?? {}, stores ?? {});
  // Company (oidc) sessions: the only kind an Enterprise install serves.
  for (const who of [MAYA, OMAR]) h.db.set({ ...h.db.get(`SESSION#${who.sessionId}`, "META")!, amr: "oidc" });
  const dev: typeof h.dev = (who, ...rest) => h.dev({ ...who, provider: "oidc" }, ...rest);
  // The owners' addresses live on their sign-in records.
  h.db.set({ pk: `DEVELOPER#${OMAR.developerId}`, sk: "META", developerId: OMAR.developerId, provider: "oidc", issuer: "i", subject: "omar", displayName: "Omar", email: "omar@example.test", revoked: false });
  h.db.set({ pk: `DEVELOPER#${SECOND_OWNER.developerId}`, sk: "META", developerId: SECOND_OWNER.developerId, provider: "oidc", issuer: "i", subject: "second", displayName: "Second", email: "second@example.test", revoked: false });
  seedMembership(h.db, MAYA.developerId, { orgId: TEST_ORG, role: options.role ?? "admin" });
  seedMembership(h.db, OMAR.developerId, { orgId: options.ownerInOtherOrg === true ? OTHER_ORG : TEST_ORG, role: "owner" });
  seedMembership(h.db, SECOND_OWNER.developerId, { orgId: TEST_ORG, role: "owner" });
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
  return { h: { ...h, dev }, rawDev: h.dev, capture, web, ageSignIn, sso: sso!, sent };
}

const key = makeIdpKey();
const SETTINGS = { idpEntityId: TEST_IDP_ENTITY, ssoUrl: TEST_SSO_URL, certificate: key.certificate, enabled: true };
const save = (expectedVersion: number, overrides: Record<string, unknown> = {}) => ({ expectedVersion, ...SETTINGS, ...overrides });

describe("the SAML settings routes", () => {
  it("an admin reads nothing at first (with the addresses to give the provider), saves from a browser session, reads it back, and the save is audited without the settings' values", async () => {
    const { capture, web } = await world();
    const first = await web(MAYA, "GET", SAML);
    expect(first).toMatchObject({ status: 200, body: { settings: null, version: 0, serviceProvider: { entityId: `${DEV_ISSUER}/saml/metadata`, acsUrl: `${DEV_ISSUER}/callback/saml`, metadataUrl: `${DEV_ISSUER}/saml/metadata` } } });
    const saved = await web(OMAR, "PUT", SAML, save(0));
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ version: 1, settings: { idpEntityId: TEST_IDP_ENTITY, ssoUrl: TEST_SSO_URL, enabled: true, version: 1, updatedBy: OMAR.developerId } });
    expect(await web(MAYA, "GET", SAML)).toMatchObject({ status: 200, body: { version: 1, settings: { idpEntityId: TEST_IDP_ENTITY } } });
    const [event] = capture.recordedBy("sso.saml_changed");
    expect(event).toMatchObject({ orgId: TEST_ORG, actor: { kind: "member", id: OMAR.developerId }, facts: { fromVersion: 0, toVersion: 1, changed: "entity_id,sign_in_address,certificate,enabled" } });
    expect(event!.details).toEqual([{ subject: "org", fields: { certificateSha256: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown } }]);
    // The values themselves (the address, the entity id, the certificate) are in no audit record.
    expect(JSON.stringify(capture.recorded())).not.toMatch(/idp\.example\.test|BEGIN CERTIFICATE/);
    // Version 2 turns it off: only that is recorded as changed.
    await web(OMAR, "PUT", SAML, save(1, { enabled: false }));
    expect(capture.recordedBy("sso.saml_changed")[1]).toMatchObject({ facts: { fromVersion: 1, toVersion: 2, changed: "enabled" } });
    expect(h_item(await web(MAYA, "GET", SAML))).toMatchObject({ enabled: false, version: 2 });
  });

  it("a stale save is refused and changes nothing (compare and set)", async () => {
    const { web, capture } = await world();
    await web(OMAR, "PUT", SAML, save(0));
    const stale = await web(OMAR, "PUT", SAML, save(0, { enabled: false }));
    expect(stale.status).toBe(409);
    expect(capture.recordedBy("sso.saml_changed")).toHaveLength(1);
    expect(h_item(await web(MAYA, "GET", SAML))).toMatchObject({ enabled: true, version: 1 });
  });

  it("the provider's entity id cannot be changed once saved (every account is tied to it); the other settings can", async () => {
    const { web, capture } = await world();
    await web(OMAR, "PUT", SAML, save(0));
    const refused = await web(OMAR, "PUT", SAML, save(1, { idpEntityId: "https://another.example.test/entity" }));
    expect(refused.status).toBe(400);
    expect((refused.body.error as { message: string }).message).toBe(SAML_ENTITY_ID_LOCKED_MESSAGE);
    expect(capture.recordedBy("sso.saml_changed")).toHaveLength(1);
    const other = makeIdpKey();
    expect((await web(OMAR, "PUT", SAML, save(1, { certificate: other.certificate, ssoUrl: "https://idp.example.test/new-sso" }))).status).toBe(200);
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
    for (const [name, overrides, status] of bad) expect((await web(OMAR, "PUT", SAML, save(0, overrides))).status, name).toBe(status);
    expect((await web(OMAR, "PUT", SAML, { ...SETTINGS })).status).toBe(400);
    expect((await web(MAYA, "GET", SAML)).body).toMatchObject({ version: 0, settings: null });
    expect(capture.recordedBy("sso.saml_changed")).toEqual([]);
  });

  it("a token (not a live browser session) can read but not save", async () => {
    const { h } = await world();
    expect((await h.dev(MAYA, "GET", SAML)).status).toBe(200);
    const refused = await h.dev(OMAR, "PUT", SAML, save(0));
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
    expect((await publicWorld.web(OMAR, "PUT", SAML, save(0))).status).toBe(403);
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
    await expect(store.put(TEST_ORG, { ...SETTINGS, trustEmail: false }, MAYA.developerId, 0, Date.now())).rejects.toThrow();
    expect(db.get(`ORG#${TEST_ORG}`, "SSO_SAML_IDP")).toBeUndefined();
  });
});

describe("a SAML settings change is high risk: a fresh sign-in, a live browser session and the audit ledger", () => {
  it("refuses a save from a session whose sign-in is older than the fresh window, or has no time, and changes nothing; a read is not affected", async () => {
    const { web, ageSignIn, capture } = await world({ role: "owner" });
    for (const age of [11, 600, undefined]) {
      ageSignIn(OMAR, age);
      const refused = await web(OMAR, "PUT", SAML, save(0));
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      expect(JSON.stringify(refused.body)).toContain("REAUTH_REQUIRED");
      expect((await web(MAYA, "GET", SAML)).status).toBe(200);
    }
    expect((await web(MAYA, "GET", SAML)).body).toMatchObject({ version: 0 });
    expect(capture.recorded().filter((event) => event.action.startsWith("sso."))).toEqual([]);
    ageSignIn(OMAR, 5);
    expect((await web(OMAR, "PUT", SAML, save(0))).status).toBe(200);
  });

  it("refuses a save when there is no ledger to record it in", async () => {
    const { web } = await world({ role: "owner", ledger: false });
    expect((await web(OMAR, "PUT", SAML, save(0))).status).toBe(503);
    expect((await web(MAYA, "GET", SAML)).body).toMatchObject({ version: 0 });
  });

  it("a flush that fails after a committed save does not fail the save", async () => {
    const { web, capture } = await world({ role: "owner" });
    capture.queueDown();
    expect((await web(OMAR, "PUT", SAML, save(0))).status).toBe(200);
    expect(capture.pending().filter((event) => event.action === "sso.saml_changed")).toHaveLength(1);
  });
});

function h_item(response: { body: Record<string, unknown> }): unknown {
  return response.body.settings;
}

describe("only an owner changes the SAML settings, and every owner is told (review B2)", () => {
  it("an admin's save is refused and changes nothing, and nobody is emailed; an owner's save is audited and every owner is emailed", async () => {
    const { web, capture, sent, h } = await world({ role: "admin" });
    const refused = await web(MAYA, "PUT", SAML, save(0));
    expect(refused.status).toBe(403);
    expect(h.db.get(`ORG#${TEST_ORG}`, "SSO_SAML_IDP")).toBeUndefined();
    expect(capture.recordedBy("sso.saml_changed")).toEqual([]);
    expect(sent).toEqual([]);
    // Reading stays open to an admin.
    expect((await web(MAYA, "GET", SAML)).status).toBe(200);
    expect((await web(OMAR, "PUT", SAML, save(0))).status).toBe(200);
    expect(capture.recordedBy("sso.saml_changed")).toHaveLength(1);
    expect(sent).toHaveLength(2);
    expect(sent.flatMap((mail) => mail.to).sort()).toEqual(["omar@example.test", "second@example.test"]);
    for (const mail of sent) {
      expect(mail.subject).toMatch(/SAML/);
      expect(mail.text).toMatch(/entity id|sign-in address|certificate|turned on/);
      // The mail says what kind of change and who made it; it carries none of the settings' values.
      expect(mail.text).not.toMatch(/idp\.example\.test|BEGIN CERTIFICATE/);
    }
    // Every change, not only the first.
    expect((await web(OMAR, "PUT", SAML, save(1, { enabled: false }))).status).toBe(200);
    expect(sent).toHaveLength(4);
  });

  it("a refused or stale save sends no mail", async () => {
    const { web, sent } = await world();
    expect((await web(OMAR, "PUT", SAML, save(0, { ssoUrl: "http://insecure.example.test" }))).status).toBe(400);
    expect((await web(OMAR, "PUT", SAML, save(5))).status).toBe(409);
    expect(sent).toEqual([]);
  });
});

describe("an entity id cannot be one of the install's other issuers (review B1)", () => {
  it("is refused when it equals the company OpenID Connect issuer, the Slack issuer or the sign-in issuer, with or without a trailing slash, and nothing is saved", async () => {
    const { web, h } = await world({ reservedIssuers: ["https://acme.okta.example", "https://slack.com", DEV_ISSUER] });
    for (const entity of ["https://acme.okta.example", "https://acme.okta.example/", "https://slack.com", DEV_ISSUER, "HTTPS://ACME.OKTA.EXAMPLE"]) {
      const refused = await web(OMAR, "PUT", SAML, save(0, { idpEntityId: entity }));
      expect(refused.status, entity).toBe(400);
    }
    expect(h.db.get(`ORG#${TEST_ORG}`, "SSO_SAML_IDP")).toBeUndefined();
    expect((await web(OMAR, "PUT", SAML, save(0))).status).toBe(200);
  });
});

describe("trusting the provider's email is an owner's setting, off by default (review S1)", () => {
  it("is off when not named, is recorded when changed, and shows in the settings read", async () => {
    const { web, capture } = await world();
    expect((await web(OMAR, "PUT", SAML, save(0))).body).toMatchObject({ settings: { trustEmail: false } });
    expect((await web(OMAR, "PUT", SAML, save(1, { trustEmail: true }))).body).toMatchObject({ settings: { trustEmail: true } });
    expect(capture.recordedBy("sso.saml_changed")[1]).toMatchObject({ facts: { changed: "trust_email" } });
    // Leaving it out turns it off again: the safe direction.
    expect((await web(OMAR, "PUT", SAML, save(2))).body).toMatchObject({ settings: { trustEmail: false } });
    expect((await web(MAYA, "PUT", SAML, save(3, { trustEmail: true }))).status).toBe(403);
  });
});

describe("turning SAML off or changing the certificate ends the SAML sessions (review S3)", () => {
  const cutoff = (h: { db: { get: (pk: string, sk: string) => unknown } }) => (h.db.get(`ORG#${TEST_ORG}`, "SSO_SAML_IDP") as { sessionsValidFrom?: number }).sessionsValidFrom ?? 0;
  it("sets the cutoff when SAML is turned off or the certificate changes, and not for other changes", async () => {
    const { web, h } = await world();
    await web(OMAR, "PUT", SAML, save(0));
    const first = cutoff(h);
    // Saving the first time sets nothing a session could be older than... except that nothing exists yet.
    expect(first).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    await web(OMAR, "PUT", SAML, save(1, { ssoUrl: "https://idp.example.test/another-sso", trustEmail: true }));
    expect(cutoff(h)).toBe(first);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await web(OMAR, "PUT", SAML, save(2, { ssoUrl: "https://idp.example.test/another-sso", certificate: makeIdpKey().certificate }));
    const afterRotation = cutoff(h);
    expect(afterRotation).toBeGreaterThan(first);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await web(OMAR, "PUT", SAML, save(3, { ssoUrl: "https://idp.example.test/another-sso", certificate: h.db.get(`ORG#${TEST_ORG}`, "SSO_SAML_IDP") && (h.db.get(`ORG#${TEST_ORG}`, "SSO_SAML_IDP") as { certificate: string }).certificate, enabled: false }));
    expect(cutoff(h)).toBeGreaterThan(afterRotation);
  });

  it("a SAML session that started before the cutoff is refused at every request; one that started after it is not", async () => {
    const { web, h, rawDev } = await world();
    const samlSession = (id: string, startedAt: string) => h.db.set({ ...h.db.get(`SESSION#${MAYA.sessionId}`, "META")!, pk: `SESSION#${id}`, sessionId: id, amr: "saml", startedAt });
    const asSaml = (id: string) => rawDev({ ...MAYA, provider: "saml" as never, sessionId: id }, "GET", SAML);
    await web(OMAR, "PUT", SAML, save(0));
    samlSession("s-old", new Date(Date.now() - 3_600_000).toISOString());
    const before = await asSaml("s-old");
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await web(OMAR, "PUT", SAML, save(1, { enabled: false }));
    expect((await asSaml("s-old")).status).toBe(401);
    samlSession("s-new", new Date(Date.now() + 5_000).toISOString());
    expect((await asSaml("s-new")).status).toBe(200);
  });
});

describe("a certificate the library cannot verify is refused at save (review S5)", () => {
  it("refuses an elliptic-curve certificate with a clear sentence, and still takes RSA", async () => {
    const { web } = await world();
    const ec = makeIdpKey({ kind: "ec" });
    const refused = await web(OMAR, "PUT", SAML, save(0, { certificate: ec.certificate }));
    expect(refused.status).toBe(400);
    expect((refused.body.error as { message: string }).message).toMatch(/key type is not supported[\s\S]*RSA/);
    expect((await web(OMAR, "PUT", SAML, save(0))).status).toBe(200);
  });
});

describe("the settings are for the install's own organization (review N4)", () => {
  it("refuses a save from an owner of another organization", async () => {
    const { web, h } = await world({ ownerInOtherOrg: true });
    const refused = await web(OMAR, "PUT", SAML, save(0));
    expect([400, 403]).toContain(refused.status);
    expect(h.db.get(`ORG#${String(OTHER_ORG)}`, "SSO_SAML_IDP")).toBeUndefined();
    expect(h.db.get(`ORG#${TEST_ORG}`, "SSO_SAML_IDP")).toBeUndefined();
  });
});

describe("the cutoff also clears what a SAML sign-in granted, and holds for the authentication time (re-check S3)", () => {
  it("clears the Slack allowances SAML sign-ins granted when SAML is turned off or the certificate changes, and keeps the others", async () => {
    const { web, sso } = await world();
    const future = Math.floor(Date.now() / 1000) + 3600;
    await web(OMAR, "PUT", SAML, save(0));
    await sso.slack.record(TEST_ORG, "U0SAML0001", "1".repeat(64), future, "saml");
    await sso.slack.record(TEST_ORG, "U0OIDC0001", "2".repeat(64), future, "oidc");
    // A change that does not end sessions leaves them.
    await web(OMAR, "PUT", SAML, save(1, { ssoUrl: "https://idp.example.test/another", trustEmail: true }));
    expect(await sso.slack.allowedDeveloper(TEST_ORG, "U0SAML0001", Date.now())).toBe("1".repeat(64));
    // Rotation clears the SAML ones only.
    await web(OMAR, "PUT", SAML, save(2, { ssoUrl: "https://idp.example.test/another", certificate: makeIdpKey().certificate }));
    expect(await sso.slack.allowedDeveloper(TEST_ORG, "U0SAML0001", Date.now())).toBeUndefined();
    expect(await sso.slack.allowedDeveloper(TEST_ORG, "U0OIDC0001", Date.now())).toBe("2".repeat(64));
    // Turning SAML off does the same.
    await sso.slack.record(TEST_ORG, "U0SAML0002", "3".repeat(64), future, "saml");
    const saved = (await web(OMAR, "GET", SAML)).body.settings as { certificate: string };
    await web(OMAR, "PUT", SAML, save(3, { ssoUrl: "https://idp.example.test/another", certificate: saved.certificate, enabled: false }));
    expect(await sso.slack.allowedDeveloper(TEST_ORG, "U0SAML0002", Date.now())).toBeUndefined();
    expect(await sso.slack.allowedDeveloper(TEST_ORG, "U0OIDC0001", Date.now())).toBe("2".repeat(64));
  });

  it("a SAML session whose authentication time is before the cutoff is refused at every request, though it started after it", async () => {
    const { web, h, rawDev, sso } = await world();
    await web(OMAR, "PUT", SAML, save(0));
    const now = Date.now();
    const cutoff = Math.floor(now / 1000) - 3600;
    const config = (await sso.saml.config.get(TEST_ORG))!;
    const { version, updatedAt: _at, updatedBy: _by, ...settings } = config;
    void _at; void _by;
    await sso.saml.config.put(TEST_ORG, { ...settings, sessionsValidFrom: cutoff }, OMAR.developerId, version, now);
    const samlSession = (id: string, authTime: string) => h.db.set({ ...h.db.get(`SESSION#${MAYA.sessionId}`, "META")!, pk: `SESSION#${id}`, sessionId: id, amr: "saml", startedAt: new Date(now - 60_000).toISOString(), authTime });
    const asSaml = (id: string) => rawDev({ ...MAYA, provider: "saml" as never, sessionId: id }, "GET", SAML);
    samlSession("s-old-auth", new Date(now - 2 * 3600_000).toISOString());
    expect((await asSaml("s-old-auth")).status).toBe(401);
    samlSession("s-new-auth", new Date(now - 1800_000).toISOString());
    expect((await asSaml("s-new-auth")).status).toBe(200);
  });
});
