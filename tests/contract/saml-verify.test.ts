import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { SAML_CLOCK_SKEW_SECONDS, SAML_RESPONSE_MAX_BYTES, samlSeenKey } from "@agentx/contracts";
import { claimAssertion, dynamoSamlReplayStore, samlAuthorizeUrl, verifySamlResponse, type SamlReplayStore, type VerifiedSamlAssertion } from "../../packages/broker/src/developer/saml.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";
import { TEST_IDP_ENTITY, TEST_NONCE, TEST_REQUEST_ID, TEST_SP, idpOf, makeIdpKey, makeResponse, requestIdOf, responseXml, toPost, type IdpKey, type ResponseOptions } from "../support/saml-fixtures.js";

// Enterprise foundations I4: every check on a SAML response, one test each. A response is refused with a fixed word; the library (node-saml / xml-crypto) verifies the signature, the audience,
// the conditions' times and the InResponseTo, and the broker adds the rest. Each assertion check is also mutation-tested (see the lane report).

let key: IdpKey;
let other: IdpKey;
beforeAll(() => { key = makeIdpKey(); other = makeIdpKey(); });

const now = () => Date.now();
const verify = (response: string, overrides: { nonce?: string; entityId?: string } = {}) =>
  verifySamlResponse({ samlResponse: response, sp: TEST_SP, idp: idpOf(key, overrides.entityId === undefined ? {} : { entityId: overrides.entityId }), nonce: overrides.nonce ?? TEST_NONCE, nowMs: now() });
const refusal = async (options: Partial<ResponseOptions>) => {
  const result = await verify(makeResponse({ key, ...options }));
  return result.ok ? "accepted" : result.reason;
};

describe("a good response", () => {
  it.each(["assertion", "response", "both"] as const)("signed on the %s is accepted, and what it says is read from the signed assertion", async (sign) => {
    const result = await verify(makeResponse({ key, sign }));
    expect(result).toMatchObject({ ok: true, assertion: { issuer: TEST_IDP_ENTITY, subject: "person-una", assertionId: "_assert-1", nameIdFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent" } });
    if (!result.ok) return;
    expect(result.assertion.attributes).toEqual({ groups: ["rovara-users"], email: ["una@example.test"], displayName: ["Una"] });
    expect(Math.abs(result.assertion.authTime! - Math.floor((now() - 5_000) / 1000))).toBeLessThanOrEqual(2);
    expect(result.assertion.notOnOrAfter).toBeGreaterThan(Math.floor(now() / 1000));
  });
});

describe("the signature", () => {
  it("an unsigned response is refused", async () => expect(await refusal({ sign: "none" })).toBe("not_signed"));
  it("a response signed by another key is refused", async () => {
    expect(await refusal({ sign: "assertion", signWith: other })).toBe("bad_signature");
    expect(await refusal({ sign: "response", signWith: other })).toBe("bad_signature");
  });
  it("a signed assertion changed afterwards is refused", async () => {
    const xml = responseXml({ key });
    expect((await verify(toPost(xml.replace(">person-una<", ">person-admin<")))).ok).toBe(false);
    expect((await verify(toPost(xml.replace("rovara-users", "rovara-admins")))).ok).toBe(false);
    const signedResponse = responseXml({ key, sign: "response" });
    expect((await verify(toPost(signedResponse.replace("rovara-users", "rovara-admins")))).ok).toBe(false);
  });
  it("signature wrapping: a second, unsigned assertion beside the signed one is refused", async () => {
    expect(await refusal({ sign: "assertion", extraAssertion: true })).toBe("bad_signature");
    expect(await refusal({ sign: "response", extraAssertion: true })).toBe("bad_signature");
  });
  it("signature wrapping: the signed assertion hidden inside an unsigned one is refused", async () => {
    const xml = responseXml({ key });
    const signed = /<saml:Assertion[\s\S]*<\/saml:Assertion>/.exec(xml)![0];
    const evil = `<saml:Assertion ID="_evil" Version="2.0" IssueInstant="${new Date().toISOString()}"><saml:Issuer>${TEST_IDP_ENTITY}</saml:Issuer><saml:Subject><saml:NameID>person-admin</saml:NameID></saml:Subject><saml:Advice>${signed}</saml:Advice></saml:Assertion>`;
    const wrapped = xml.replace(signed, evil);
    const result = await verify(toPost(wrapped));
    expect(result.ok).toBe(false);
  });
  it("a signature whose reference is not the assertion it sits in is refused", async () => {
    const xml = responseXml({ key });
    // Point the reference at the response's id: the signed element is then not the one read.
    expect((await verify(toPost(xml.replace('URI="#_assert-1"', 'URI="#_resp-1"')))).ok).toBe(false);
    expect((await verify(toPost(xml.replace('URI="#_assert-1"', 'URI="#_missing"')))).ok).toBe(false);
  });
  it("SHA-1 signatures and digests are refused", async () => {
    expect(await refusal({ signatureAlgorithm: "http://www.w3.org/2000/09/xmldsig#rsa-sha1" })).toBe("weak_algorithm");
    expect(await refusal({ digestAlgorithm: "http://www.w3.org/2000/09/xmldsig#sha1" })).toBe("weak_algorithm");
  });
  it("a response a different identity provider issued (right signature, other entity id) is refused", async () => {
    expect(await refusal({ issuer: "https://evil.example.test/entity" })).toBe("wrong_issuer");
    const result = await verify(makeResponse({ key }), { entityId: "https://other.example.test/entity" });
    expect(result).toEqual({ ok: false, reason: "wrong_issuer" });
  });
});

describe("audience, recipient, destination", () => {
  it("a wrong audience is refused", async () => expect(await refusal({ audience: "https://other-sp.example.test" })).toBe("wrong_audience"));
  it("an assertion with no audience restriction is refused", async () => expect(await refusal({ audience: null })).toBe("wrong_audience"));
  it("a wrong or missing recipient is refused", async () => {
    expect(await refusal({ recipient: "https://evil.example.test/acs" })).toBe("wrong_recipient");
    expect(await refusal({ recipient: null })).toBe("wrong_recipient");
  });
  it("a wrong destination is refused", async () => expect(await refusal({ destination: "https://evil.example.test/acs", sign: "response" })).toBe("wrong_destination"));
  it("a response that is not a bearer confirmation is refused", async () => expect(await refusal({ bearer: false })).toBe("wrong_recipient"));
});

describe("time", () => {
  it("an expired assertion is refused", async () => {
    expect(await refusal({ notOnOrAfterOffsetMs: -120_000, subjectNotOnOrAfterOffsetMs: -120_000 })).toBe("expired");
    // Only the conditions ended, or only the subject confirmation did:
    expect(await refusal({ notOnOrAfterOffsetMs: -120_000 })).toBe("expired");
    expect(await refusal({ subjectNotOnOrAfterOffsetMs: -120_000 })).toBe("expired");
  });
  it("an assertion not yet valid is refused", async () => expect(await refusal({ notBeforeOffsetMs: 120_000 })).toBe("not_yet_valid"));
  it("an assertion with no end time in its conditions is refused", async () => expect(await refusal({ notOnOrAfterOffsetMs: null })).not.toBe("accepted"));
  it("an assertion with no conditions at all is refused", async () => expect(await refusal({ conditionsElement: false })).not.toBe("accepted"));
  it("a subject confirmation with no end, or an ended one, is refused", async () => {
    expect(await refusal({ subjectNotOnOrAfterOffsetMs: null })).not.toBe("accepted");
  });
  it("the provider's own session end, once passed, ends the sign-in", async () => expect(await refusal({ sessionNotOnOrAfterOffsetMs: -120_000 })).toBe("expired"));
  it("a small clock difference is tolerated, a larger one is not", async () => {
    const small = (SAML_CLOCK_SKEW_SECONDS / 2) * 1000;
    expect(await refusal({ notBeforeOffsetMs: small })).toBe("accepted");
    expect(await refusal({ notOnOrAfterOffsetMs: -small, subjectNotOnOrAfterOffsetMs: -small })).toBe("accepted");
    expect(await refusal({ notBeforeOffsetMs: SAML_CLOCK_SKEW_SECONDS * 2000 })).toBe("not_yet_valid");
  });
  it("an assertion issued long ago is refused even with a late end time", async () => {
    const old = Date.now() - 30 * 60_000;
    expect(await refusal({ now: old, notOnOrAfterOffsetMs: 3 * 3_600_000, subjectNotOnOrAfterOffsetMs: 3 * 3_600_000 })).toBe("expired");
  });
  it("an authentication time in the future is not used", async () => {
    const result = await verify(makeResponse({ key, authnInstantOffsetMs: 3_600_000 }));
    expect(result.ok && result.assertion.authTime).toBeUndefined();
  });
});

describe("SP-initiated only", () => {
  it("an unsolicited response (no InResponseTo anywhere) is refused", async () => {
    expect(await refusal({ inResponseTo: null, subjectInResponseTo: null })).toBe("unsolicited");
    expect(await refusal({ inResponseTo: "" })).toBe("unsolicited");
  });
  it("a response to another request is refused", async () => {
    expect(await refusal({ inResponseTo: "_someone-elses-request", subjectInResponseTo: "_someone-elses-request" })).toBe("not_for_this_request");
    const result = await verify(makeResponse({ key }), { nonce: "M".repeat(43) });
    expect(result).toEqual({ ok: false, reason: "not_for_this_request" });
  });
  it("a signed subject confirmation for another request is refused even when the unsigned response claims ours", async () => {
    expect(await refusal({ inResponseTo: TEST_REQUEST_ID, subjectInResponseTo: "_another" })).toBe("not_for_this_request");
    expect(await refusal({ subjectInResponseTo: null })).toBe("not_for_this_request");
  });
  it("a malformed request nonce is refused", async () => expect(await verify(makeResponse({ key }), { nonce: "short" })).toEqual({ ok: false, reason: "not_for_this_request" }));
});

describe("the subject", () => {
  it("a transient NameID cannot key an account and is refused", async () => expect(await refusal({ nameIdFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:transient" })).toBe("transient_subject"));
  it("an empty or oversized NameID is refused", async () => {
    expect(await refusal({ nameId: "  " })).toBe("no_subject");
    expect(await refusal({ nameId: "n".repeat(513) })).toBe("no_subject");
  });
  it("a failed status is refused, even with a signed assertion in the response", async () => {
    expect(await refusal({ status: "Responder", sign: "assertion" })).toBe("bad_status");
    expect(await refusal({ status: "Responder", sign: "response" })).toBe("bad_status");
    expect(await refusal({ status: "Requester", sign: "both" })).toBe("bad_status");
  });
});

describe("the XML is read safely", () => {
  const withPrologue = (prologue: string) => toPost(`${prologue}${responseXml({ key })}`);
  it("a document type declaration is refused before any parser sees it (XXE, entity expansion)", async () => {
    const xxe = '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>';
    const billion = '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]>';
    for (const prologue of [xxe, billion, '<!doctype x>', '<?xml version="1.0"?>\n<!DOCTYPE x>']) {
      expect(await verify(withPrologue(prologue))).toEqual({ ok: false, reason: "forbidden_markup" });
    }
    // Hidden inside the document, or only an entity declaration:
    const inside = toPost(responseXml({ key }).replace("<saml:Issuer>", "<!ENTITY x 'y'><saml:Issuer>"));
    expect(await verify(inside)).toEqual({ ok: false, reason: "forbidden_markup" });
  });
  it("a response over the size bound is refused, before and after decoding", async () => {
    expect(await verify(toPost(`${responseXml({ key })}<!-- ${"x".repeat(SAML_RESPONSE_MAX_BYTES)} -->`))).toEqual({ ok: false, reason: "response_too_large" });
    expect(await verify("A".repeat(Math.ceil((SAML_RESPONSE_MAX_BYTES * 4) / 3) + 100))).toEqual({ ok: false, reason: "response_too_large" });
  });
  it("a document with too many elements is refused", async () => {
    expect(await verify(toPost(responseXml({ key }).replace("<saml:Issuer>", `${"<a>".repeat(5001)}<saml:Issuer>`)))).toEqual({ ok: false, reason: "response_too_large" });
  });
  it("text that is not base64, not UTF-8, or not an XML response is refused", async () => {
    expect(await verify("")).toEqual({ ok: false, reason: "response_unreadable" });
    expect(await verify("not base64 !!!")).toEqual({ ok: false, reason: "response_unreadable" });
    expect((await verify(Buffer.from([0x3c, 0xff, 0xfe, 0x3e]).toString("base64"))).ok).toBe(false);
    expect(await verify(toPost("<html/>"))).toMatchObject({ ok: false });
    expect(await verify(toPost(responseXml({ key }).replace("<samlp:Response", "<samlp:Response\u0000")))).toEqual({ ok: false, reason: "response_unreadable" });
  });
  it("a declared encoding other than UTF-8 is refused", async () => {
    expect(await verify(toPost(`<?xml version="1.0" encoding="UTF-16"?>${responseXml({ key })}`))).toEqual({ ok: false, reason: "response_unreadable" });
  });
});

describe("the authorize address", () => {
  it("carries the request whose ID the response must answer, our consumer address, and a forced sign-in when asked", async () => {
    const address = await samlAuthorizeUrl({ sp: TEST_SP, idp: idpOf(key), state: "S".repeat(43), nonce: TEST_NONCE, freshSignIn: true });
    expect(address.startsWith("https://idp.example.test/sso?")).toBe(true);
    expect(await requestIdOf(address)).toEqual({ id: TEST_REQUEST_ID, relayState: "S".repeat(43), acs: TEST_SP.acsUrl, forceAuthn: true });
    expect((await requestIdOf(await samlAuthorizeUrl({ sp: TEST_SP, idp: idpOf(key), state: "S".repeat(43), nonce: TEST_NONCE }))).forceAuthn).toBe(false);
    await expect(samlAuthorizeUrl({ sp: TEST_SP, idp: idpOf(key), state: "S", nonce: "bad nonce" })).rejects.toThrow();
  });
});

describe("replay", () => {
  const assertion: VerifiedSamlAssertion = { issuer: TEST_IDP_ENTITY, subject: "una", attributes: {}, assertionId: "_a1", notOnOrAfter: Math.floor(Date.now() / 1000) + 300 };
  it("an assertion id is accepted once; the second use, even of a copy, is a replay", async () => {
    const store = dynamoSamlReplayStore({ documentClient: new FakeDynamoDb(), tableName: "state" });
    expect(await claimAssertion(store, TEST_ORG, assertion)).toEqual({ ok: true, assertion });
    expect(await claimAssertion(store, TEST_ORG, assertion)).toEqual({ ok: false, reason: "replayed" });
    expect(await claimAssertion(store, TEST_ORG, { ...assertion, assertionId: "_a2" })).toMatchObject({ ok: true });
  });
  it("the record outlives the assertion (a time to live past its end) and is scoped to the issuer", async () => {
    const db = new FakeDynamoDb();
    const store = dynamoSamlReplayStore({ documentClient: db, tableName: "state" });
    await claimAssertion(store, TEST_ORG, assertion);
    const digest = createHash("sha256").update(`${assertion.issuer}\n${assertion.assertionId}`).digest("hex");
    const item = db.get(samlSeenKey(TEST_ORG, digest).pk, samlSeenKey(TEST_ORG, digest).sk);
    expect((item as { expiresAt: number }).expiresAt).toBeGreaterThan(assertion.notOnOrAfter);
    expect(await claimAssertion(store, TEST_ORG, { ...assertion, issuer: "https://another-idp.example.test" })).toMatchObject({ ok: true });
  });
  it("a store that cannot answer refuses the sign-in", async () => {
    const broken: SamlReplayStore = { claim: async () => { throw new Error("down"); } };
    expect(await claimAssertion(broken, TEST_ORG, assertion)).toEqual({ ok: false, reason: "replayed" });
  });
  it("another org's record does not count", async () => {
    const store = dynamoSamlReplayStore({ documentClient: new FakeDynamoDb(), tableName: "state" });
    await claimAssertion(store, TEST_ORG, assertion);
    expect(await claimAssertion(store, "org_00000000-0000-4000-8000-000000000002", assertion)).toMatchObject({ ok: true });
  });
});

