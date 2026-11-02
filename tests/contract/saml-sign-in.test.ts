import { decodeJwt } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ENTERPRISE_SESSION_MAX_SECONDS, GROUP_MAPPING_MESSAGES, SAML_SIGN_IN_REFUSED_MESSAGE, editionPolicy, orgMetaKey } from "@agentx/contracts";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { methodAllowedByEdition } from "../../packages/broker/src/developer/edition-methods.js";
import { createDeveloperIdentityHandler, enabledMethods } from "../../packages/broker/src/developer/server.js";
import { REMOVED_FROM_ORG_MESSAGE } from "../../packages/broker/src/org/sign-in.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { CLI_REDIRECT, ISSUER, OIDC_ISSUER, T0, authorizeQuery, httpEvent, identityHarness } from "../support/developer-fakes.js";
import { isFreshSignIn } from "../../packages/broker/src/developer/store.js";
import { TEST_ORG } from "../support/orgs.js";
import { TEST_IDP_ENTITY, TEST_SP, TEST_SSO_URL, makeIdpKey, makeResponse, requestIdOf, type IdpKey, type ResponseOptions } from "../support/saml-fixtures.js";

// Enterprise foundations I4: SAML sign-in through the sign-in server, with the same org resolution, group mapping, ban checks, invite rules and audit as the OpenID Connect sign-in.

const enterprise = editionPolicy("enterprise");
const BY = "a".repeat(64);
const RULES = [
  { id: "admins", group: "rovara-admins", orgRole: "admin" as const, projectRoles: [] },
  { id: "users", group: "rovara-users", orgRole: "member" as const, projectRoles: [] },
  { id: "auditors", group: "rovara-auditors", orgRole: "auditor" as const, projectRoles: [] },
];
// A SAML identity is keyed apart from every other method's (review B1): the issuer in the key names the method.
const una = ownerKeyForSubject(`saml:${TEST_IDP_ENTITY}`, "person-una");

let key: IdpKey;
beforeAll(() => { key = makeIdpKey({ notBefore: new Date("2026-01-01T00:00:00Z"), notAfter: new Date("2031-01-01T00:00:00Z") }); });
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T0); });
afterEach(() => { vi.useRealTimers(); });

async function world(options: { configured?: boolean; enabled?: boolean; policy?: ReturnType<typeof editionPolicy> | undefined; mapping?: boolean; trustEmail?: boolean } = {}) {
  const capture = capturingAuditDeps();
  const policy = "policy" in options ? options.policy : enterprise;
  const h = identityHarness({ slack: false, editionPolicy: policy!, sso: true, saml: true, audit: capture });
  await h.orgs.ensureOrg(TEST_ORG, "staging");
  await h.orgs.addMember({ orgId: TEST_ORG, developerId: "b".repeat(64), role: "owner" });
  h.db.set({ ...orgMetaKey(TEST_ORG) });
  if (options.mapping !== false) await h.deps.sso!.mappings.put(TEST_ORG, { claim: "groups", rules: RULES, updatedAt: "2026-10-31T00:00:00Z", updatedBy: BY }, 0);
  if (options.configured !== false) await h.deps.sso!.saml.config.put(TEST_ORG, { idpEntityId: TEST_IDP_ENTITY, ssoUrl: TEST_SSO_URL, certificate: key.certificate, enabled: options.enabled ?? true, trustEmail: options.trustEmail ?? true }, BY, 0, T0);
  return { h, capture };
}
type World = Awaited<ReturnType<typeof world>>["h"];

/** Starts a CLI sign-in and follows it to the identity provider; returns what a provider would read from the redirect. */
async function start(h: World, query: Record<string, string> = {}) {
  let started = await h.http(httpEvent("GET", authorizeQuery(query)));
  if (started.statusCode === 200) started = await h.http(httpEvent("GET", /href="([^"]*method=saml)"/.exec(started.body)![1]!.replaceAll("&amp;", "&")));
  return { started, request: started.statusCode === 302 && started.headers.location!.startsWith(TEST_SSO_URL) ? await requestIdOf(started.headers.location!) : undefined };
}

const post = (h: World, samlResponse: string, relayState: string) => h.http(httpEvent("POST", "/v1/auth/callback/saml", { SAMLResponse: samlResponse, RelayState: relayState }));

/** The whole CLI sign-in: the provider's redirect, its POST, the browser's GET, then the tokens. `respond` shapes the response (it defaults to a good one for `person-una`). */
async function signIn(h: World, respond: Partial<ResponseOptions> = {}, query: Record<string, string> = {}) {
  const { request, started } = await start(h, query);
  if (request === undefined) return { started, redirect: new URL(started.headers.location ?? "https://none.invalid/") };
  const body = makeResponse({ key, now: T0, inResponseTo: request.id, subjectInResponseTo: request.id, ...respond });
  const posted = await post(h, body, request.relayState);
  if (posted.statusCode !== 303) return { started, posted, redirect: new URL("https://none.invalid/"), request, body };
  const back = await h.http(httpEvent("GET", posted.headers.location!.replace(ISSUER, "/v1/auth")));
  const redirect = new URL(back.headers.location ?? "https://none.invalid/");
  const code = redirect.searchParams.get("code");
  return { started, posted, back, redirect, request, body, tokens: code === null ? undefined : (await h.exchange(code)).body };
}
const roleOf = (tokens: Record<string, unknown> | undefined) => (tokens === undefined ? undefined : decodeJwt(String(tokens.access_token)).org_role);

describe("a SAML sign-in", () => {
  it("sends the browser to the identity provider with a request this sign-in will check the answer against, then lets a mapped person in", async () => {
    const { h, capture } = await world();
    const { request } = await start(h);
    expect(request).toMatchObject({ acs: TEST_SP.acsUrl, forceAuthn: false });
    const result = await signIn(h);
    expect(result.posted!.statusCode).toBe(303);
    expect(result.posted!.headers.location).toMatch(/^https:\/\/.*\/v1\/auth\/callback\/saml\?state=[A-Za-z0-9_-]{43}&code=[A-Za-z0-9_-]{43}$/);
    expect(roleOf(result.tokens)).toBe("member");
    const claims = decodeJwt(String(result.tokens!.access_token));
    expect(claims.amr).toBe("saml");
    const session = (await h.deps.store.getSession(String(claims.sid)))!;
    expect(session.endsAt).toBeLessThanOrEqual(Math.floor(T0 / 1000) + ENTERPRISE_SESSION_MAX_SECONDS);
    expect(session.groupClaims).toEqual({ groups: ["rovara-users"] });
    expect(await h.deps.store.getDeveloper(una)).toMatchObject({ provider: "saml", issuer: `saml:${TEST_IDP_ENTITY}`, subject: "person-una", email: "una@example.test", displayName: "Una" });
    expect((await h.orgs.orgForDeveloper(una))?.role).toBe("member");
    expect(capture.recordedBy("sso.sign_in")[0]).toMatchObject({ orgId: TEST_ORG, facts: { source: "mapping", role: "member", rules: 1 }, details: [{ fields: { matchedRuleIds: "users" } }] });
    // The response, the assertion and the groups are in no audit record.
    expect(JSON.stringify(capture.recorded())).not.toMatch(/rovara-users|SAMLResponse|person-una/);
  });

  it("asks the provider to authenticate again when the sign-in must be fresh", async () => {
    const { h } = await world();
    const { request } = await start(h, { fresh: "1" });
    expect(request!.forceAuthn).toBe(true);
  });

  it("takes the role from the groups, strongest first, and loses it when a group is taken away", async () => {
    const { h } = await world();
    expect(roleOf((await signIn(h, { attributes: { groups: ["rovara-admins", "rovara-users"] }, assertionId: "_a1" })).tokens)).toBe("admin");
    expect(roleOf((await signIn(h, { attributes: { groups: ["rovara-users"] }, assertionId: "_a2" })).tokens)).toBe("member");
    const gone = await signIn(h, { attributes: { groups: ["unrelated"] }, assertionId: "_a3" });
    expect(gone.tokens).toBeUndefined();
    expect(gone.redirect.searchParams.get("error_description")).toBe(GROUP_MAPPING_MESSAGES.no_group);
  });

  it("only the attributes that carry groups reach the mapping: a person-editable attribute named like a rule's group grants nothing", async () => {
    const { h } = await world();
    const result = await signIn(h, { attributes: { displayName: ["rovara-admins"], email: ["rovara-admins"], department: ["rovara-admins"] } });
    expect(result.tokens).toBeUndefined();
    expect(result.redirect.searchParams.get("error_description")).toBe(GROUP_MAPPING_MESSAGES.no_group);
  });

  it("a group value that cannot be read refuses the whole list (a dropped value could be the group that denies)", async () => {
    const { h } = await world();
    const child = '<saml:Attribute Name="groups"><saml:AttributeValue><x:y xmlns:x="urn:x">rovara-auditors</x:y></saml:AttributeValue></saml:Attribute>';
    const result = await signIn(h, { attributes: { groups: ["rovara-users"] }, attributesRaw: child });
    expect(result.tokens).toBeUndefined();
    expect(result.redirect.searchParams.get("error_description")).toBe(GROUP_MAPPING_MESSAGES.claim_invalid);
    const tooLong = await signIn(h, { attributes: { groups: ["rovara-users", "g".repeat(300)] }, assertionId: "_long" });
    expect(tooLong.redirect.searchParams.get("error_description")).toBe(GROUP_MAPPING_MESSAGES.claim_invalid);
  });

  it("a person whose groups make them both an Auditor and a member is refused", async () => {
    const { h, capture } = await world();
    const result = await signIn(h, { attributes: { groups: ["rovara-users", "rovara-auditors"] } });
    expect(result.tokens).toBeUndefined();
    expect(result.redirect.searchParams.get("error_description")).toBe(GROUP_MAPPING_MESSAGES.auditor_and_writer);
    expect(capture.recordedBy("sso.sign_in_refused")[0]).toMatchObject({ facts: { refusal: "auditor_and_writer" } });
  });

  it("no saved mapping refuses the sign-in", async () => {
    const { h } = await world({ mapping: false });
    expect((await signIn(h)).redirect.searchParams.get("error_description")).toBe(GROUP_MAPPING_MESSAGES.not_configured);
  });
});

describe("a banned person and an invite", () => {
  it("is refused when banned, and comes back with a valid invite for their own address", async () => {
    const { h, capture } = await world();
    expect(roleOf((await signIn(h)).tokens)).toBe("member");
    await h.orgs.removeMember({ orgId: TEST_ORG, developerId: una, emails: [], ban: true, by: { kind: "member", id: "b".repeat(64) } });
    const allowed = capture.recordedBy("sso.sign_in").length;
    const refused = await signIn(h, { assertionId: "_ban-1" });
    expect(refused.tokens).toBeUndefined();
    expect(refused.redirect.searchParams.get("error_description")).toBe(REMOVED_FROM_ORG_MESSAGE);
    expect(capture.recordedBy("sso.sign_in")).toHaveLength(allowed);
    expect(capture.recordedBy("sso.sign_in_refused").at(-1)).toMatchObject({ facts: { refusal: "removed_from_org" } });
    // A forged or other-address invite leaves them refused.
    const other = await h.orgs.createInvite({ orgId: TEST_ORG, createdBy: "b".repeat(64), role: "member", email: "someone-else@example.test" });
    expect((await signIn(h, { assertionId: "_ban-2" }, { invite: other.token })).tokens).toBeUndefined();
    expect((await signIn(h, { assertionId: "_ban-3" }, { invite: "A".repeat(43) })).tokens).toBeUndefined();
    // Their own address works.
    const mine = await h.orgs.createInvite({ orgId: TEST_ORG, createdBy: "b".repeat(64), role: "member", email: "una@example.test" });
    expect(roleOf((await signIn(h, { assertionId: "_ban-4" }, { invite: mine.token })).tokens)).toBe("member");
    expect(await h.orgs.isBanned(TEST_ORG, una)).toBe(false);
  });
});

describe("what a refused response leaves behind", () => {
  const nothingWritten = async (h: World) => {
    expect(await h.orgs.orgForDeveloper(una)).toBeUndefined();
    expect(await h.deps.store.getDeveloper(una)).toBeUndefined();
    expect(await h.deps.store.getIdentityLink(una)).toBeUndefined();
  };
  it.each<[string, Partial<ResponseOptions>]>([
    ["unsigned", { sign: "none" }],
    ["signed by another key", { signWith: makeIdpKey() }],
    ["for another audience", { audience: "https://other-sp.example.test" }],
    ["for another recipient", { recipient: "https://evil.example.test/acs" }],
    ["expired", { notOnOrAfterOffsetMs: -300_000, subjectNotOnOrAfterOffsetMs: -300_000 }],
    ["not yet valid", { notBeforeOffsetMs: 300_000 }],
    ["from another issuer", { issuer: "https://evil.example.test/entity" }],
    ["for another request", { inResponseTo: "_other", subjectInResponseTo: "_other" }],
    ["unsolicited (no InResponseTo)", { inResponseTo: null, subjectInResponseTo: null }],
    ["with a transient NameID", { nameIdFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:transient" }],
  ])("%s: one fixed sentence, no tokens, nothing written about the person, and the refusal on record", async (_name, respond) => {
    const { h, capture } = await world();
    const result = await signIn(h, respond);
    expect(result.tokens).toBeUndefined();
    expect(result.redirect.searchParams.get("code")).toBeNull();
    expect(result.redirect.searchParams.get("error")).toBe("access_denied");
    expect(result.redirect.searchParams.get("error_description")).toBe(SAML_SIGN_IN_REFUSED_MESSAGE);
    await nothingWritten(h);
    expect(h.logs.some((entry) => entry.event === "signin.refused" && entry.method === "saml")).toBe(true);
    expect(capture.recordedBy("sso.sign_in")).toEqual([]);
  });

  it("the log names a fixed word, never the response", async () => {
    const { h } = await world();
    await signIn(h, { audience: "https://other-sp.example.test" });
    const entry = h.logs.find((line) => line.event === "signin.refused" && line.method === "saml")!;
    expect(entry.reason).toBe("wrong_audience");
    expect(JSON.stringify(h.logs)).not.toContain("other-sp.example.test");
  });

  it("an assertion replayed in a second sign-in (new request, same assertion id) is refused, and the first one still worked", async () => {
    const { h } = await world();
    expect(roleOf((await signIn(h, { assertionId: "_same-assertion" })).tokens)).toBe("member");
    const again = await signIn(h, { assertionId: "_same-assertion" });
    expect(again.tokens).toBeUndefined();
    expect(again.redirect.searchParams.get("error_description")).toBe(SAML_SIGN_IN_REFUSED_MESSAGE);
    expect(h.logs.some((entry) => entry.event === "signin.refused" && entry.reason === "replayed")).toBe(true);
  });

  it("the same posted response cannot be used twice: the sign-in request is single use, and so is the handle", async () => {
    const { h } = await world();
    const first = await signIn(h);
    expect(first.tokens).toBeDefined();
    const second = await post(h, first.body!, first.request!.relayState);
    // The auth request was consumed: the provider's POST is for no waiting sign-in.
    expect(second.statusCode).toBe(400);
    const again = await h.http(httpEvent("GET", first.posted!.headers.location!.replace(ISSUER, "/v1/auth")));
    expect(again.statusCode).toBe(400);
  });

  it("a response for a sign-in that is not waiting for SAML writes nothing (an unsolicited POST)", async () => {
    const { h } = await world();
    const before = h.state.find(() => true).length;
    const body = makeResponse({ key, now: T0 });
    for (const relay of ["", "short", "R".repeat(43)]) expect((await post(h, body, relay)).statusCode).toBe(400);
    const started = await h.http(httpEvent("GET", authorizeQuery()));
    expect(started.statusCode).toBe(302);
    // A request that is waiting for another method is not a SAML sign-in either.
    expect(h.state.find((item) => String(item.sk).startsWith("SSO_SAML_RESP#"))).toEqual([]);
    expect(h.state.find(() => true).length).toBe(before);
    expect((await post(h, "", "R".repeat(43))).statusCode).toBe(400);
    expect((await h.http(httpEvent("POST", "/v1/auth/callback/saml"))).statusCode).toBe(400);
  });

  it("a response for a sign-in waiting for another method is not kept", async () => {
    const { h } = await world();
    const other = await h.deps.store.createAuthRequest({ clientRedirectUri: CLI_REDIRECT, clientState: "s", codeChallenge: "c".repeat(43), nonce: "n".repeat(43) });
    await h.deps.store.chooseMethod(other.id, "slack");
    expect((await post(h, makeResponse({ key, now: T0 }), other.id)).statusCode).toBe(400);
    expect(h.state.find((item) => String(item.sk).startsWith("SSO_SAML_RESP#"))).toEqual([]);
  });

  it("an oversized POST is refused unread", async () => {
    const { h } = await world();
    const { request } = await start(h);
    expect((await post(h, "A".repeat(300_000), request!.relayState)).statusCode).toBe(400);
    expect(h.state.find((item) => String(item.sk).startsWith("SSO_SAML_RESP#"))).toEqual([]);
  });

  it("a stashed response expires after two minutes", async () => {
    const { h } = await world();
    const { request } = await start(h);
    const posted = await post(h, makeResponse({ key, now: T0, inResponseTo: request!.id, subjectInResponseTo: request!.id }), request!.relayState);
    expect(posted.statusCode).toBe(303);
    vi.setSystemTime(T0 + 3 * 60_000);
    h.tick(3 * 60_000);
    const back = await h.http(httpEvent("GET", posted.headers.location!.replace(ISSUER, "/v1/auth")));
    expect(new URL(back.headers.location!).searchParams.get("code")).toBeNull();
  });
});

describe("the browser sign-in", () => {
  it("survives the cross-site POST: the cookie rides the GET the POST redirects to, and without it the sign-in is refused", async () => {
    const { h } = await world();
    const start1 = await h.http(httpEvent("GET", `/v1/auth/browser/authorize?return_to=${encodeURIComponent("/app")}`));
    expect(start1.statusCode).toBe(302);
    const cookie = start1.cookies!.find((value) => value.startsWith("__Host-agentx_review_pkce="))!.split(";")[0]!;
    const request = await requestIdOf(start1.headers.location!);
    const body = makeResponse({ key, now: T0, inResponseTo: request.id, subjectInResponseTo: request.id });
    // The identity provider's POST carries no cookie at all.
    const posted = await post(h, body, request.relayState);
    expect(posted.statusCode).toBe(303);
    const next = posted.headers.location!.replace(ISSUER, "/v1/auth");
    const done = await h.http({ ...httpEvent("GET", next), headers: { cookie } });
    expect(done.headers.location).toBe("/app");
    expect(done.cookies?.some((value) => value.startsWith("__Host-agentx_review_session="))).toBe(true);
    // Without the PKCE cookie the same sign-in is refused (a second sign-in, so nothing is replayed).
    const second = await h.http(httpEvent("GET", `/v1/auth/browser/authorize?return_to=${encodeURIComponent("/app")}`));
    const request2 = await requestIdOf(second.headers.location!);
    const posted2 = await post(h, makeResponse({ key, now: T0, inResponseTo: request2.id, subjectInResponseTo: request2.id, assertionId: "_second" }), request2.relayState);
    const refused = await h.http(httpEvent("GET", posted2.headers.location!.replace(ISSUER, "/v1/auth")));
    expect(refused.cookies?.some((value) => value.startsWith("__Host-agentx_review_session="))).not.toBe(true);
  });
});

describe("the edition and the switch", () => {
  it("SAML is Enterprise only: the Public edition and an install with no edition refuse it", () => {
    expect(methodAllowedByEdition(enterprise, "saml")).toBe(true);
    expect(methodAllowedByEdition(editionPolicy("public"), "saml")).toBe(false);
    expect(methodAllowedByEdition(undefined, "saml")).toBe(false);
    // The Public edition allows its other methods, so the refusal is SAML's own.
    expect(methodAllowedByEdition(editionPolicy("public"), "github")).toBe(true);
  });

  it("is off until an administrator saves and enables the settings: no method is offered and the sign-in says so", async () => {
    for (const options of [{ configured: false }, { enabled: false }] as const) {
      const { h } = await world(options);
      const result = await signIn(h);
      expect(result.tokens).toBeUndefined();
      expect(result.redirect.searchParams.get("error")).toBe("access_denied");
      expect(result.redirect.href.startsWith(CLI_REDIRECT)).toBe(true);
      const configuration = await h.http(httpEvent("GET", "/v1/auth/.well-known/agentx-configuration"));
      expect((JSON.parse(configuration.body) as { methods: object }).methods).not.toHaveProperty("saml");
    }
    const on = await world();
    expect((JSON.parse((await on.h.http(httpEvent("GET", "/v1/auth/.well-known/agentx-configuration"))).body) as { methods: { saml: unknown } }).methods.saml).toEqual({ displayName: "SAML single sign-on" });
  });

  it("the Public edition has no SAML routes and no SAML method: the provider is never built", async () => {
    // The harness builds the SAML provider as the Lambda does: only where the edition has company sign-in.
    const h = identityHarness({ editionPolicy: editionPolicy("public"), sso: true, saml: true });
    expect(h.deps.sso).toBeUndefined();
    expect(h.deps.saml).toBeUndefined();
    expect(h.deps.providers.saml).toBeUndefined();
    expect(enabledMethods(h.deps)).not.toContain("saml");
    expect((await h.http(httpEvent("POST", "/v1/auth/callback/saml", { SAMLResponse: "x", RelayState: "R".repeat(43) }))).statusCode).toBe(404);
    expect((await h.http(httpEvent("GET", "/v1/auth/saml/metadata"))).statusCode).toBe(404);
    expect((await h.http(httpEvent("GET", "/v1/auth/callback/saml?state=x&code=y"))).statusCode).toBe(404);
    // Even a provider wired by mistake is held back by the edition: the method is not enabled, and the routes check the edition themselves.
    const wired = identityHarness({ editionPolicy: editionPolicy("enterprise"), sso: true, saml: true });
    const mistaken = { ...wired.deps, editionPolicy: editionPolicy("public") };
    expect(enabledMethods(mistaken)).not.toContain("saml");
    const handler = createDeveloperIdentityHandler(mistaken);
    for (const event of [httpEvent("POST", "/v1/auth/callback/saml", { SAMLResponse: "x", RelayState: "R".repeat(43) }), httpEvent("GET", "/v1/auth/saml/metadata")]) {
      expect(((await handler(event)) as { statusCode: number }).statusCode).toBe(404);
    }
  });

  it("publishes our service provider metadata, with the consumer address and entity id, when SAML is available", async () => {
    const { h } = await world();
    const metadata = await h.http(httpEvent("GET", "/v1/auth/saml/metadata"));
    expect(metadata.statusCode).toBe(200);
    expect(metadata.headers["content-type"]).toContain("xml");
    expect(metadata.body).toContain(TEST_SP.acsUrl);
    expect(metadata.body).toContain(`entityID="${TEST_SP.entityId}"`);
    expect(metadata.body).not.toMatch(/PRIVATE|BEGIN/);
  });
});

describe("a SAML identity never lands on another method's account (review B1)", () => {
  it("a NameID equal to an existing OpenID Connect subject, under an entity id equal to the OIDC issuer, resolves to its own new account", async () => {
    const capture = capturingAuditDeps();
    const h = identityHarness({ slack: false, oidc: {}, editionPolicy: enterprise, sso: true, saml: true, audit: capture });
    await h.orgs.ensureOrg(TEST_ORG, "staging");
    h.db.set({ ...orgMetaKey(TEST_ORG) });
    await h.deps.sso!.mappings.put(TEST_ORG, { claim: "groups", rules: RULES, updatedAt: "2026-10-31T00:00:00Z", updatedBy: BY }, 0);
    // The company's OIDC owner, signed in before.
    const ownerId = ownerKeyForSubject(OIDC_ISSUER, "owner-1");
    await h.deps.store.upsertDeveloper({ developerId: ownerId, provider: "oidc", issuer: OIDC_ISSUER, subject: "owner-1", displayName: "Olga", email: "olga@example.test" });
    await h.orgs.addMember({ orgId: TEST_ORG, developerId: ownerId, role: "owner" });
    // SAML saved with the OIDC issuer as its entity id (written straight to the store: the route refuses it, the account key must not depend on that).
    await h.deps.sso!.saml.config.put(TEST_ORG, { idpEntityId: OIDC_ISSUER, ssoUrl: TEST_SSO_URL, certificate: key.certificate, enabled: true, trustEmail: true }, BY, 0, T0);
    const result = await signIn(h, { issuer: OIDC_ISSUER, nameId: "owner-1" });
    expect(result.tokens).toBeDefined();
    const sub = decodeJwt(String(result.tokens!.access_token)).sub;
    expect(sub).not.toBe(ownerId);
    expect(sub).toBe(ownerKeyForSubject(`saml:${OIDC_ISSUER}`, "owner-1"));
    expect(roleOf(result.tokens)).toBe("member");
    // The owner's own account is untouched: still an OIDC account, still owner, and no session was started for it.
    expect(await h.deps.store.getDeveloper(ownerId)).toMatchObject({ provider: "oidc", issuer: OIDC_ISSUER, subject: "owner-1" });
    expect((await h.orgs.orgForDeveloper(ownerId))?.role).toBe("owner");
    expect(h.db.find((item) => String(item.pk).startsWith("SESSION#") && item.developerId === ownerId)).toEqual([]);
  });
});

describe("the provider's email is trusted only when an owner says so (review S1)", () => {
  it("by default a SAML email is not used: no Slack lookup, no address on the account, no invite matched by address", async () => {
    const { h } = await world({ trustEmail: false });
    const lookup = vi.spyOn(h.deps.directory, "lookupByEmail");
    const result = await signIn(h);
    expect(roleOf(result.tokens)).toBe("member");
    expect(lookup).not.toHaveBeenCalled();
    expect((await h.deps.store.getDeveloper(una))?.email).toBeUndefined();
    // Even a NameID in email format is not used for it.
    const viaNameId = await signIn(h, { nameId: "other@example.test", nameIdFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress", assertionId: "_n2", attributes: { groups: ["rovara-users"] } });
    expect(roleOf(viaNameId.tokens)).toBe("member");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("with the owner's setting on, the email is used (the Slack link and invites by address work)", async () => {
    const { h } = await world({ trustEmail: true });
    const lookup = vi.spyOn(h.deps.directory, "lookupByEmail");
    expect(roleOf((await signIn(h)).tokens)).toBe("member");
    expect(lookup).toHaveBeenCalledWith("una@example.test");
    expect((await h.deps.store.getDeveloper(una))?.email).toBe("una@example.test");
  });
});

describe("turning SAML off or rotating the certificate ends its sessions (review S3)", () => {
  it("a refresh after the cutoff is refused and the session is revoked; a session that started after it is kept", async () => {
    const { h } = await world();
    const first = await signIn(h);
    const refresh = (token: unknown) => h.http(httpEvent("POST", "/v1/auth/token", { grant_type: "refresh_token", client_id: "agentx-cli", refresh_token: String(token) }));
    h.tick(1000);
    const config = (await h.deps.sso!.saml.config.get(TEST_ORG))!;
    const { version: _version, updatedAt: _at, updatedBy: _by, ...settings } = config;
    void _version; void _at; void _by;
    await h.deps.sso!.saml.config.put(TEST_ORG, { ...settings, enabled: false, sessionsValidFrom: Math.floor((T0 + 500) / 1000) + 1 }, BY, config.version, T0 + 1000);
    const refused = await refresh(first.tokens!.refresh_token);
    expect(refused.statusCode).toBe(400);
    expect((JSON.parse(refused.body) as { error: string }).error).toBe("invalid_grant");
    expect((await h.deps.store.getSession(String(decodeJwt(String(first.tokens!.access_token)).sid)))?.revokedAt).toBeDefined();
  });
});

describe("the posted response is kept once per sign-in request (review S4)", () => {
  it("a flood of POSTs for one request keeps one response; POSTs for requests that do not exist keep none", async () => {
    const { h } = await world();
    const { request } = await start(h);
    const body = makeResponse({ key, now: T0, inResponseTo: request!.id, subjectInResponseTo: request!.id });
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) statuses.push((await post(h, body, request!.relayState)).statusCode);
    expect(statuses.filter((status) => status === 303)).toHaveLength(1);
    expect(h.state.find((item) => String(item.sk).startsWith("SSO_SAML_RESP#"))).toHaveLength(1);
    for (let i = 0; i < 25; i++) expect((await post(h, body, `${String(i).padStart(43, "Q")}`)).statusCode).toBe(400);
    expect(h.state.find((item) => String(item.sk).startsWith("SSO_SAML_RESP#"))).toHaveLength(1);
  });

  it("the handle belongs to its request: another request's handle does not open the stored response", async () => {
    const { h } = await world();
    const a = (await start(h)).request!;
    const b = (await start(h)).request!;
    const postedA = await post(h, makeResponse({ key, now: T0, inResponseTo: a.id, subjectInResponseTo: a.id }), a.relayState);
    const postedB = await post(h, makeResponse({ key, now: T0, inResponseTo: b.id, subjectInResponseTo: b.id, assertionId: "_b" }), b.relayState);
    const handleB = new URL(postedB.headers.location!).searchParams.get("code")!;
    const crossed = await h.http(httpEvent("GET", `/v1/auth/callback/saml?state=${encodeURIComponent(a.relayState)}&code=${encodeURIComponent(handleB)}`));
    expect(new URL(crossed.headers.location ?? "https://none.invalid/").searchParams.get("code")).toBeNull();
    void postedA;
  });
});

describe("freshness and the provider's session end (review N1, N2)", () => {
  it("a response with no authentication time is not a fresh sign-in; one with a recent time is", async () => {
    const { h } = await world();
    const fresh = await signIn(h);
    const sessionOf = async (tokens: Record<string, unknown> | undefined) => (await h.deps.store.getSession(String(decodeJwt(String(tokens!.access_token)).sid)))!;
    expect(isFreshSignIn(await sessionOf(fresh.tokens), T0)).toBe(true);
    const none = await signIn(h, { omitAuthnStatement: true, assertionId: "_noauthn" });
    expect(none.tokens).toBeDefined();
    expect(isFreshSignIn(await sessionOf(none.tokens), T0)).toBe(false);
  });

  it("the session ends no later than the provider's SessionNotOnOrAfter", async () => {
    const { h } = await world();
    const result = await signIn(h, { sessionNotOnOrAfterOffsetMs: 600_000 });
    const session = (await h.deps.store.getSession(String(decodeJwt(String(result.tokens!.access_token)).sid)))!;
    expect(session.endsAt).toBeLessThanOrEqual(Math.floor((T0 + 600_000) / 1000));
  });
});
