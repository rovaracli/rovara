// SAML 2.0 test fixtures (Enterprise foundations I4): a self-signed identity provider certificate and key made at run time (no key material is checked in), and a builder of
// signed (or deliberately wrong) SAML responses. xml-crypto signs, as a real identity provider's library would.
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { SignedXml } from "xml-crypto";
import type { SamlIdp, SamlServiceProvider } from "../../packages/broker/src/developer/saml.js";

// ---- a certificate, made by hand (DER), because node:crypto cannot make one

const len = (n: number): Buffer => (n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]));
const der = (tag: number, ...parts: Buffer[]): Buffer => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), len(body.length), body]); };
const oid = (bytes: number[]): Buffer => der(0x06, Buffer.from(bytes));
const utf8 = (text: string): Buffer => der(0x0c, Buffer.from(text, "utf8"));
const utcTime = (date: Date): Buffer => der(0x17, Buffer.from(date.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z", "ascii"));
const SHA256_RSA = der(0x30, oid([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]), der(0x05));
const SHA256_ECDSA = der(0x30, oid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]));

export interface IdpKey { privateKey: KeyObject; certificate: string }

/** A self-signed X.509 certificate for a fresh RSA key. `validDays` negative makes an expired one. */
export function makeIdpKey(options: { bits?: number; kind?: "rsa" | "ec"; notBefore?: Date; notAfter?: Date; commonName?: string } = {}): IdpKey {
  const { privateKey, publicKey } = options.kind === "ec" ? generateKeyPairSync("ec", { namedCurve: "P-256" }) : generateKeyPairSync("rsa", { modulusLength: options.bits ?? 2048 });
  const signatureAlgorithm = options.kind === "ec" ? SHA256_ECDSA : SHA256_RSA;
  const notBefore = options.notBefore ?? new Date(Date.now() - 86_400_000);
  const notAfter = options.notAfter ?? new Date(Date.now() + 365 * 86_400_000);
  const name = der(0x30, der(0x31, der(0x30, oid([0x55, 0x04, 0x03]), utf8(options.commonName ?? "test idp"))));
  const tbs = der(0x30,
    der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, Buffer.from([1])), signatureAlgorithm, name,
    der(0x30, utcTime(notBefore), utcTime(notAfter)), name, Buffer.from(publicKey.export({ type: "spki", format: "der" })));
  const signature = createSign("sha256").update(tbs).sign(privateKey);
  const certificate = der(0x30, tbs, signatureAlgorithm, der(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const body = certificate.toString("base64").match(/.{1,64}/g)!.join("\n");
  return { privateKey, certificate: `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n` };
}

// ---- the deployment under test

export const TEST_SP: SamlServiceProvider = { entityId: "https://abc123.execute-api.us-east-1.amazonaws.com/v1/auth/saml/metadata", acsUrl: "https://abc123.execute-api.us-east-1.amazonaws.com/v1/auth/callback/saml" };
export const TEST_IDP_ENTITY = "https://idp.example.test/entity";
export const TEST_SSO_URL = "https://idp.example.test/sso";
export const TEST_NONCE = "N".repeat(43);
export const TEST_REQUEST_ID = `_${TEST_NONCE}`;

export const idpOf = (key: IdpKey, overrides: Partial<SamlIdp> = {}): SamlIdp => ({ entityId: TEST_IDP_ENTITY, ssoUrl: TEST_SSO_URL, certificate: key.certificate, ...overrides });

// ---- a response

const NS = 'xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"';
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface ResponseOptions {
  /** Epoch ms the responses are issued at (the verifier's clock). Default: now. */
  now?: number;
  key: IdpKey;
  /** What is signed: the assertion (default), the response, both, or nothing. */
  sign?: "assertion" | "response" | "both" | "none";
  issuer?: string;
  audience?: string | null;
  recipient?: string | null;
  destination?: string | null;
  inResponseTo?: string | null;
  subjectInResponseTo?: string | null;
  responseId?: string;
  assertionId?: string;
  nameId?: string;
  nameIdFormat?: string | null;
  notBeforeOffsetMs?: number | null;
  notOnOrAfterOffsetMs?: number | null;
  subjectNotOnOrAfterOffsetMs?: number | null;
  sessionNotOnOrAfterOffsetMs?: number | null;
  authnInstantOffsetMs?: number;
  conditionsElement?: boolean;
  bearer?: boolean;
  status?: string;
  attributes?: Record<string, string[]>;
  signatureAlgorithm?: string;
  digestAlgorithm?: string;
  /** Signs with this key instead of `key` (a response signed by someone else). */
  signWith?: IdpKey;
  /** Adds a second, unsigned assertion naming someone else (a signature wrapping attempt). */
  extraAssertion?: boolean;
  assertionVersion?: string;
  omitSubject?: boolean;
  omitAuthnStatement?: boolean;
  /** A second Conditions element, valid, beside the first. */
  secondConditions?: boolean;
  secondNameId?: boolean;
  /** Raw XML added to the attribute statement (an attribute value with child elements, say). */
  attributesRaw?: string;
}

export const RSA_SHA256 = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
export const SHA256 = "http://www.w3.org/2001/04/xmlenc#sha256";
const EXC_C14N = "http://www.w3.org/2001/10/xml-exc-c14n#";
const ENVELOPED = "http://www.w3.org/2000/09/xmldsig#enveloped-signature";

function assertionXml(o: ResponseOptions, now: number, id: string, nameId: string): string {
  const requestId = o.inResponseTo === undefined ? TEST_REQUEST_ID : o.inResponseTo;
  const subjectRequest = o.subjectInResponseTo === undefined ? requestId : o.subjectInResponseTo;
  const recipient = o.recipient === undefined ? TEST_SP.acsUrl : o.recipient;
  const audience = o.audience === undefined ? TEST_SP.entityId : o.audience;
  const at = (offset: number | null | undefined, fallback: number) => (offset === null ? undefined : iso(now + (offset ?? fallback)));
  const notBefore = at(o.notBeforeOffsetMs, -60_000);
  const notOnOrAfter = at(o.notOnOrAfterOffsetMs, 300_000);
  const subjectEnd = at(o.subjectNotOnOrAfterOffsetMs, 300_000);
  const sessionEnd = at(o.sessionNotOnOrAfterOffsetMs, 3_600_000);
  const attributes = o.attributes ?? { groups: ["rovara-users"], email: ["una@example.test"], displayName: ["Una"] };
  const attributeXml = Object.entries(attributes).map(([name, values]) => `<saml:Attribute Name="${escapeXml(name)}">${values.map((v) => `<saml:AttributeValue>${escapeXml(v)}</saml:AttributeValue>`).join("")}</saml:Attribute>`).join("");
  const confirmation = `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:${o.bearer === false ? "holder-of-key" : "bearer"}"><saml:SubjectConfirmationData${subjectRequest === null ? "" : ` InResponseTo="${subjectRequest}"`}${recipient === null ? "" : ` Recipient="${recipient}"`}${subjectEnd === undefined ? "" : ` NotOnOrAfter="${subjectEnd}"`}/></saml:SubjectConfirmation>`;
  const format = o.nameIdFormat === undefined ? "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent" : o.nameIdFormat;
  const conditions = o.conditionsElement === false ? "" : `<saml:Conditions${notBefore === undefined ? "" : ` NotBefore="${notBefore}"`}${notOnOrAfter === undefined ? "" : ` NotOnOrAfter="${notOnOrAfter}"`}>${audience === null ? "" : `<saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction>`}</saml:Conditions>`;
  return `<saml:Assertion ID="${id}" Version="${o.assertionVersion ?? "2.0"}" IssueInstant="${iso(now)}"><saml:Issuer>${o.issuer ?? TEST_IDP_ENTITY}</saml:Issuer>${o.omitSubject === true ? "" : `<saml:Subject><saml:NameID${format === null ? "" : ` Format="${format}"`}>${escapeXml(nameId)}</saml:NameID>${o.secondNameId === true ? "<saml:NameID>person-admin</saml:NameID>" : ""}${confirmation}</saml:Subject>`}${conditions}${o.secondConditions === true ? `<saml:Conditions NotOnOrAfter="${iso(now + 300_000)}"/>` : ""}${o.omitAuthnStatement === true ? "" : `<saml:AuthnStatement AuthnInstant="${iso(now + (o.authnInstantOffsetMs ?? -5_000))}"${sessionEnd === undefined ? "" : ` SessionNotOnOrAfter="${sessionEnd}"`} SessionIndex="s1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>`}<saml:AttributeStatement>${attributeXml}${o.attributesRaw ?? ""}</saml:AttributeStatement></saml:Assertion>`;
}

function sign(xml: string, target: "Assertion" | "Response", o: ResponseOptions): string {
  const key = o.signWith ?? o.key;
  const signer = new SignedXml({ privateKey: key.privateKey.export({ type: "pkcs8", format: "pem" }) as string, publicCert: key.certificate, signatureAlgorithm: o.signatureAlgorithm ?? RSA_SHA256, canonicalizationAlgorithm: EXC_C14N });
  signer.addReference({ xpath: `/*[local-name(.)='Response']${target === "Assertion" ? "/*[local-name(.)='Assertion']" : ""}`, transforms: [ENVELOPED, EXC_C14N], digestAlgorithm: o.digestAlgorithm ?? SHA256 });
  signer.computeSignature(xml, { location: { reference: `/*[local-name(.)='Response']${target === "Assertion" ? "/*[local-name(.)='Assertion']" : ""}/*[local-name(.)='Issuer']`, action: "after" } });
  return signer.getSignedXml();
}

/** The response XML (not yet base64). */
export function responseXml(o: ResponseOptions): string {
  const now = o.now ?? Date.now();
  const responseId = o.responseId ?? "_resp-1";
  const assertionId = o.assertionId ?? "_assert-1";
  const inResponseTo = o.inResponseTo === undefined ? TEST_REQUEST_ID : o.inResponseTo;
  const destination = o.destination === undefined ? TEST_SP.acsUrl : o.destination;
  const mode = o.sign ?? "assertion";
  let assertion = assertionXml(o, now, assertionId, o.nameId ?? "person-una");
  if (mode === "assertion" || mode === "both") {
    // The assertion is signed on its own, inside a throwaway response that carries the same namespaces.
    const wrapper = `<samlp:Response ${NS} ID="_wrap" Version="2.0" IssueInstant="${iso(now)}">${assertion}</samlp:Response>`;
    const signed = sign(wrapper, "Assertion", o);
    assertion = /<saml:Assertion[\s\S]*<\/saml:Assertion>/.exec(signed)![0];
  }
  const extra = o.extraAssertion === true ? assertionXml({ ...o, attributes: { groups: ["rovara-admins"] } }, now, "_evil-1", "person-admin") : "";
  let xml = `<samlp:Response ${NS} ID="${responseId}" Version="2.0" IssueInstant="${iso(now)}"${destination === null ? "" : ` Destination="${destination}"`}${inResponseTo === null ? "" : ` InResponseTo="${inResponseTo}"`}><saml:Issuer>${o.issuer ?? TEST_IDP_ENTITY}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:${o.status ?? "Success"}"/></samlp:Status>${assertion}${extra}</samlp:Response>`;
  if (mode === "response" || mode === "both") xml = sign(xml, "Response", o);
  return xml;
}

export const toPost = (xml: string): string => Buffer.from(xml, "utf8").toString("base64");
export const makeResponse = (o: ResponseOptions): string => toPost(responseXml(o));

/** The AuthnRequest ID in the address `authorizeUrl` returns (the request is deflated in the SAMLRequest parameter). */
export async function requestIdOf(authorizeUrl: string): Promise<{ id: string; relayState: string; acs: string | undefined; forceAuthn: boolean }> {
  const { inflateRawSync } = await import("node:zlib");
  const url = new URL(authorizeUrl);
  const xml = inflateRawSync(Buffer.from(url.searchParams.get("SAMLRequest")!, "base64")).toString("utf8");
  return {
    id: /\bID="([^"]+)"/.exec(xml)![1]!, relayState: url.searchParams.get("RelayState")!, acs: /AssertionConsumerServiceURL="([^"]+)"/.exec(xml)?.[1],
    forceAuthn: /ForceAuthn="true"/.test(xml),
  };
}
