// Enterprise foundations I4: SAML 2.0 sign-in for the company's own identity provider, beside the OpenID Connect sign-in.
//
// What this module is: the checks on a SAML response, and the sign-in request that starts one. The signature, the audience, the conditions' times (with a small clock skew)
// and the InResponseTo match are verified by @node-saml/node-saml (xml-crypto underneath: exclusive canonicalisation, one signed reference that must be the element read). This
// module adds, fail closed, what the library leaves to its caller:
//   - the response is read only if it is small, strict UTF-8, has no DOCTYPE or entity declaration and uses no SHA-1 or MD5 (XXE and entity expansion cannot start);
//   - SP-initiated only: the response must answer the request this browser started (InResponseTo is `_` + that request's nonce), so an unsolicited response is refused;
//   - everything is read from the SIGNED assertion the library returns (never from the surrounding unsigned XML): the issuer, a bearer SubjectConfirmation whose
//     Recipient is our assertion consumer address and whose InResponseTo, NotOnOrAfter are present and current, Conditions with a NotOnOrAfter that has not passed, the
//     audience, the subject;
//   - an assertion id is accepted once (a replay store with a time to live that outlasts the assertion).
// A refusal is one of the fixed words in SAML_REFUSALS; nothing the response said is echoed.
import { createHash, X509Certificate } from "node:crypto";
import { SAML, ValidateInResponseTo, type CacheProvider } from "@node-saml/node-saml";
import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  SAML_CLOCK_SKEW_SECONDS, SAML_RESPONSE_MAX_BYTES, SamlIdpConfigSchema, samlIdpConfigKey, samlSeenKey, samlStashKey, agentXError, requireFeature,
  type EditionPolicy, type OrgId, type SamlIdpConfig, type SamlIdpSettings, type SamlRefusal,
} from "@agentx/contracts";
import { auditTransact, type AuditRuntime } from "../audit/outbox.js";
import { flushAuditEvents } from "../audit/flush.js";
import type { AuditEventInput } from "@agentx/contracts";

// ---- the pieces of a deployment that make a SAML flow

export interface SamlServiceProvider {
  /** Our entity id: what the identity provider's assertions must name as their audience. */
  entityId: string;
  /** Our assertion consumer address: where the identity provider posts the response. Every Recipient and Destination must be this exactly. */
  acsUrl: string;
}

export interface SamlIdp {
  entityId: string;
  ssoUrl: string;
  certificate: string;
}

/** What a verified SAML sign-in says about the person. Read from the signed assertion only. */
export interface VerifiedSamlAssertion {
  /** The provider's entity id (the assertion's issuer). */
  issuer: string;
  /** The NameID value: the person's stable id at the provider. */
  subject: string;
  nameIdFormat?: string;
  /** Attribute name to its string values; only strings are kept. */
  attributes: Record<string, string[]>;
  /** When the person authenticated at the provider (epoch seconds), when the assertion says so and the time is believable. */
  authTime?: number;
  assertionId: string;
  /** Epoch seconds: the assertion is useless after this, so the replay record may be dropped then (plus the skew). */
  notOnOrAfter: number;
}

export type SamlVerification = { ok: true; assertion: VerifiedSamlAssertion } | { ok: false; reason: SamlRefusal };

const refuse = (reason: SamlRefusal): { ok: false; reason: SamlRefusal } => ({ ok: false, reason });

// ---- the request that starts a sign-in

/** The id of the AuthnRequest for an auth request's nonce. An XML ID must not start with a digit, and the nonce is base64url (letters, digits, `-`, `_`). */
export const samlRequestId = (nonce: string): string => `_${nonce}`;

const NONCE = /^[A-Za-z0-9_-]{16,128}$/;

function samlFor(sp: SamlServiceProvider, idp: SamlIdp, extra: { nonce: string; forceAuthn?: boolean; cache?: CacheProvider; nowMs?: number }): SAML {
  return new SAML({
    callbackUrl: sp.acsUrl,
    issuer: sp.entityId,
    audience: sp.entityId,
    entryPoint: idp.ssoUrl,
    idpCert: idp.certificate,
    idpIssuer: idp.entityId,
    // Either the whole response or the assertion must be signed (the library demands the assertion's signature when the response carries none).
    wantAssertionsSigned: false,
    wantAuthnResponseSigned: false,
    // SP-initiated only: a response with no InResponseTo, or one this browser did not ask for, is refused (checked again in verifySamlResponse).
    validateInResponseTo: ValidateInResponseTo.always,
    acceptedClockSkewMs: SAML_CLOCK_SKEW_SECONDS * 1000,
    // The assertion is useless 10 minutes after the provider issued it, whatever NotOnOrAfter says.
    maxAssertionAgeMs: 10 * 60 * 1000,
    requestIdExpirationPeriodMs: 10 * 60 * 1000,
    generateUniqueId: () => samlRequestId(extra.nonce),
    // The provider chooses the NameID format (we refuse a transient one); we do not demand an authentication context a multi-factor provider cannot give.
    identifierFormat: null,
    disableRequestedAuthnContext: true,
    forceAuthn: extra.forceAuthn === true,
    signatureAlgorithm: "sha256",
    ...(extra.cache === undefined ? {} : { cacheProvider: extra.cache }),
  });
}

/** A cache that knows one thing: the request this browser started. The library asks it whether an InResponseTo is one we issued. */
function oneRequestCache(requestId: string, nowMs: number): CacheProvider {
  return {
    saveAsync: async () => null,
    getAsync: async (key) => (key === requestId ? new Date(nowMs).toISOString() : null),
    removeAsync: async () => null,
  };
}

/** Our entity id and assertion consumer address, from the sign-in issuer (`https://<api>/v1/auth`). Both the sign-in server and the settings route derive them here. */
export function samlServiceProviderAddresses(issuer: string): SamlServiceProvider & { metadataUrl: string } {
  const base = issuer.replace(/\/+$/, "");
  return { entityId: `${base}/saml/metadata`, acsUrl: `${base}/callback/saml`, metadataUrl: `${base}/saml/metadata` };
}

/** The address to send the browser to (HTTP-Redirect binding): the provider's sign-in address with the AuthnRequest and the relay state (the auth request id). */
export async function samlAuthorizeUrl(input: { sp: SamlServiceProvider; idp: SamlIdp; state: string; nonce: string; freshSignIn?: boolean }): Promise<string> {
  if (!NONCE.test(input.nonce)) throw agentXError("CONFIG_INVALID", "the sign-in request is not valid");
  const saml = samlFor(input.sp, input.idp, { nonce: input.nonce, forceAuthn: input.freshSignIn === true });
  return saml.getAuthorizeUrlAsync(input.state, undefined, {});
}

/** Our SP metadata, for the administrator to give the identity provider. Public: it holds no secret. */
export function samlServiceProviderMetadata(sp: SamlServiceProvider): string {
  return new SAML({ callbackUrl: sp.acsUrl, issuer: sp.entityId, idpCert: "-", wantAssertionsSigned: false, wantAuthnResponseSigned: false, identifierFormat: null }).generateServiceProviderMetadata(null, null);
}

// ---- reading a response

const LOWER_B64 = /^[A-Za-z0-9+/=\r\n\t ]*$/;
// The root element's start tag, with an XML declaration, comments and whitespace allowed before it. Only attribute NAMES and quoted values may follow the element name.
const ROOT_START = /^\uFEFF?\s*(?:<\?xml\b[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<(?:([A-Za-z_][\w.-]*):)?([A-Za-z_][\w.-]*)((?:\s+[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*\/?>/;
const ATTRIBUTE = /\s+([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const MAX_ELEMENTS = 5000;
// An ID/NCName: letters, digits, `.`, `-`, `_`, not starting with a digit, `-` or `.`.
const NCNAME = /^[A-Za-z_][A-Za-z0-9._-]{0,255}$/;

/** The attributes of the root element's start tag, read from the unsigned text. Used only for checks that refuse; nothing trusted is taken from it. */
function rootAttributes(xml: string): { localName: string; attributes: Map<string, string> } | undefined {
  const match = ROOT_START.exec(xml);
  if (match === null) return undefined;
  const attributes = new Map<string, string>();
  for (const [, name, double, single] of (match[3] ?? "").matchAll(ATTRIBUTE)) {
    if (name === undefined) continue;
    if (attributes.has(name)) return undefined;
    attributes.set(name, double ?? single ?? "");
  }
  return { localName: match[2]!, attributes };
}

function decodeResponse(samlResponse: string): { ok: true; xml: string } | { ok: false; reason: SamlRefusal } {
  // The base64 text is bounded before it is decoded, and the decoded text before it is read.
  if (typeof samlResponse !== "string" || samlResponse.length === 0) return refuse("response_unreadable");
  if (samlResponse.length > Math.ceil((SAML_RESPONSE_MAX_BYTES * 4) / 3) + 64) return refuse("response_too_large");
  if (!LOWER_B64.test(samlResponse)) return refuse("response_unreadable");
  const bytes = Buffer.from(samlResponse, "base64");
  if (bytes.length > SAML_RESPONSE_MAX_BYTES) return refuse("response_too_large");
  let xml: string;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return refuse("response_unreadable");
  }
  if (xml.includes("\u0000") || xml.length === 0) return refuse("response_unreadable");
  // Any declared encoding but UTF-8 would let two readers see two documents.
  const declaration = /^\uFEFF?\s*<\?xml\b[^>]*\?>/.exec(xml)?.[0];
  if (declaration !== undefined && /\bencoding\s*=\s*["'](?!utf-8["'])/i.test(declaration)) return refuse("response_unreadable");
  // XXE and entity expansion start with a document type declaration; a response never has one. Refused before any parser sees the text.
  if (/<!\s*(?:DOCTYPE|ENTITY|ELEMENT|ATTLIST|NOTATION)/i.test(xml)) return refuse("forbidden_markup");
  // The response's own status must be Success (the first status code is the top-level one). A failure status with an assertion in it is not a sign-in.
  const status = /<(?:[A-Za-z_][\w.-]*:)?StatusCode\s[^>]*?\bValue\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(xml);
  if ((status?.[1] ?? status?.[2]) !== "urn:oasis:names:tc:SAML:2.0:status:Success") return refuse("bad_status");
  // A SHA-1 or MD5 signature or digest is not accepted.
  if (/(?:rsa-sha1|dsa-sha1|ecdsa-sha1|xmldsig#sha1|xmldsig-more#md5|xmldsig-more#rsa-md5|enc#sha1)/i.test(xml)) return refuse("weak_algorithm");
  // Nothing signed at all: refused with its own word (an unsigned response is the most common mistake, and the most dangerous to accept).
  if (!/<(?:[A-Za-z_][\w.-]*:)?Signature[\s>]/.test(xml)) return refuse("not_signed");
  // A bounded element count, so a deeply nested or huge document cannot exhaust a parser.
  let elements = 0;
  for (let at = xml.indexOf("<"); at !== -1; at = xml.indexOf("<", at + 1)) if (++elements > MAX_ELEMENTS) return refuse("response_too_large");
  return { ok: true, xml };
}

type Xml2Js = Record<string, unknown>;
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined ? [] : [value]);
const attrOf = (node: unknown, name: string): string | undefined => {
  const attrs = (node as { $?: Record<string, unknown> } | null | undefined)?.$;
  const value = attrs?.[name];
  return typeof value === "string" ? value : undefined;
};
const textOf = (node: unknown): string | undefined => {
  if (typeof node === "string") return node;
  const text = (node as { _?: unknown } | null | undefined)?._;
  return typeof text === "string" ? text : undefined;
};
const parseInstant = (value: string | undefined): number | undefined => {
  if (value === undefined || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
};

const TRANSIENT = "urn:oasis:names:tc:SAML:2.0:nameid-format:transient";
const BEARER = "urn:oasis:names:tc:SAML:2.0:cm:bearer";
const SUBJECT_MAX_CHARS = 512;
const ATTRIBUTE_MAX_VALUES = 500;
const ATTRIBUTE_VALUE_MAX_CHARS = 1024;
const ATTRIBUTES_MAX = 200;

/**
 * Verifies a SAML response (the base64 `SAMLResponse` field of the browser's POST) against the provider's configuration and the request this browser started.
 * It does not record the assertion id as seen: the caller does, once, after this returns ok (`claimAssertion`).
 */
export async function verifySamlResponse(input: {
  samlResponse: string; sp: SamlServiceProvider; idp: SamlIdp; nonce: string; nowMs: number;
}): Promise<SamlVerification> {
  const { sp, idp, nowMs } = input;
  if (!NONCE.test(input.nonce)) return refuse("not_for_this_request");
  const requestId = samlRequestId(input.nonce);
  const decoded = decodeResponse(input.samlResponse);
  if (!decoded.ok) return refuse(decoded.reason);
  const xml = decoded.xml;

  // The unsigned root: only refusals come from it (the signed assertion is read below, and says the same things again).
  const root = rootAttributes(xml);
  if (root === undefined || root.localName !== "Response") return refuse("response_unreadable");
  const rootInResponseTo = root.attributes.get("InResponseTo");
  if (rootInResponseTo === undefined || rootInResponseTo === "") return refuse("unsolicited");
  if (rootInResponseTo !== requestId) return refuse("not_for_this_request");
  const destination = root.attributes.get("Destination");
  if (destination !== undefined && destination !== sp.acsUrl) return refuse("wrong_destination");

  let profile;
  try {
    const saml = samlFor(sp, idp, { nonce: input.nonce, cache: oneRequestCache(requestId, nowMs) });
    ({ profile } = await saml.validatePostResponseAsync({ SAMLResponse: input.samlResponse }));
  } catch (error) {
    return refuse(refusalOfLibraryError(error));
  }
  if (profile === null) return refuse("bad_assertion");
  const assertion = profile.getAssertion?.() as Xml2Js | undefined;
  const signed = (assertion as { Assertion?: Xml2Js } | undefined)?.Assertion;
  if (signed === undefined) return refuse("bad_assertion");
  return readSignedAssertion(signed, { sp, idp, requestId, nowMs });
}

/** Maps the library's error to a fixed word. The text of the error is never kept (it can quote the response). */
function refusalOfLibraryError(error: unknown): SamlRefusal {
  const message = error instanceof Error ? error.message : "";
  if (/audience/i.test(message)) return "wrong_audience";
  if (/subject confirmation/i.test(message)) return "expired";
  if (/not yet valid/i.test(message)) return "not_yet_valid";
  if (/expired|too old/i.test(message)) return "expired";
  if (/InResponseTo/i.test(message)) return /missing/i.test(message) ? "unsolicited" : "not_for_this_request";
  if (/SAML provider returned/i.test(message) || (error as { name?: string } | null)?.name === "SamlStatusError") return "bad_status";
  if (/Missing SAML assertion/i.test(message)) return "not_signed";
  if (/signature|Signature|multiple assertions|ID cannot refer|Referenced node|transforms|reference/i.test(message)) return "bad_signature";
  return "bad_assertion";
}

function readSignedAssertion(assertion: Xml2Js, ctx: { sp: SamlServiceProvider; idp: SamlIdp; requestId: string; nowMs: number }): SamlVerification {
  const { sp, idp, requestId, nowMs } = ctx;
  const skewMs = SAML_CLOCK_SKEW_SECONDS * 1000;

  const id = attrOf(assertion, "ID");
  if (id === undefined || !NCNAME.test(id)) return refuse("bad_assertion");
  if (attrOf(assertion, "Version") !== "2.0") return refuse("bad_assertion");

  const issuers = asArray(assertion.Issuer);
  if (issuers.length !== 1 || textOf(issuers[0]) !== idp.entityId) return refuse("wrong_issuer");

  // Conditions: exactly one, with an end time that has not passed, a start that has come, and our entity id among the audiences.
  const conditionsList = asArray(assertion.Conditions);
  if (conditionsList.length !== 1) return refuse("bad_assertion");
  const conditions = conditionsList[0];
  const conditionsEnd = parseInstant(attrOf(conditions, "NotOnOrAfter"));
  if (conditionsEnd === undefined) return refuse("expired");
  if (nowMs - skewMs >= conditionsEnd) return refuse("expired");
  const conditionsStartText = attrOf(conditions, "NotBefore");
  if (conditionsStartText !== undefined) {
    const start = parseInstant(conditionsStartText);
    if (start === undefined) return refuse("bad_assertion");
    if (nowMs + skewMs < start) return refuse("not_yet_valid");
  }
  const restrictions = asArray((conditions as Xml2Js).AudienceRestriction);
  if (restrictions.length === 0) return refuse("wrong_audience");
  for (const restriction of restrictions) {
    const audiences = asArray((restriction as Xml2Js).Audience).map(textOf);
    if (!audiences.includes(sp.entityId)) return refuse("wrong_audience");
  }

  // Subject: a bearer confirmation, for us, for this request, still current.
  const subjects = asArray(assertion.Subject);
  if (subjects.length !== 1) return refuse("no_subject");
  const subject = subjects[0] as Xml2Js;
  const nameIds = asArray(subject.NameID);
  if (nameIds.length !== 1) return refuse("no_subject");
  const nameId = nameIds[0];
  const nameIdValue = textOf(nameId)?.trim();
  if (nameIdValue === undefined || nameIdValue === "" || nameIdValue.length > SUBJECT_MAX_CHARS) return refuse("no_subject");
  if (attrOf(nameId, "Format") === TRANSIENT) return refuse("transient_subject");

  const confirmations = asArray(subject.SubjectConfirmation).filter((entry) => attrOf(entry, "Method") === BEARER);
  let confirmedEnd: number | undefined;
  let sawRecipient = false;
  for (const confirmation of confirmations) {
    const dataList = asArray((confirmation as Xml2Js).SubjectConfirmationData);
    if (dataList.length !== 1) continue;
    const data = dataList[0];
    if (attrOf(data, "Recipient") !== sp.acsUrl) continue;
    sawRecipient = true;
    if (attrOf(data, "InResponseTo") !== requestId) continue;
    const end = parseInstant(attrOf(data, "NotOnOrAfter"));
    if (end === undefined || nowMs - skewMs >= end) continue;
    const startText = attrOf(data, "NotBefore");
    if (startText !== undefined) {
      const start = parseInstant(startText);
      if (start === undefined || nowMs + skewMs < start) continue;
    }
    confirmedEnd = end;
    break;
  }
  if (confirmedEnd === undefined) return refuse(sawRecipient ? "not_for_this_request" : "wrong_recipient");

  // The provider's own session end, when it names one, is the end of this sign-in too.
  const statements = asArray(assertion.AuthnStatement);
  let authTime: number | undefined;
  for (const statement of statements) {
    const sessionEnd = attrOf(statement, "SessionNotOnOrAfter");
    if (sessionEnd !== undefined) {
      const end = parseInstant(sessionEnd);
      if (end === undefined || nowMs - skewMs >= end) return refuse("expired");
    }
    const instant = parseInstant(attrOf(statement, "AuthnInstant"));
    // A time in the future is not a time the sign-in can use.
    if (instant !== undefined && instant <= nowMs + skewMs && (authTime === undefined || instant > authTime * 1000)) authTime = Math.floor(instant / 1000);
  }

  const attributes = readAttributes(assertion);
  return {
    ok: true,
    assertion: {
      issuer: idp.entityId, subject: nameIdValue, attributes, assertionId: id,
      ...(attrOf(nameId, "Format") === undefined ? {} : { nameIdFormat: attrOf(nameId, "Format")! }),
      notOnOrAfter: Math.floor(Math.min(conditionsEnd, confirmedEnd) / 1000),
      ...(authTime === undefined ? {} : { authTime }),
    },
  };
}

/** Attribute name to its string values. A value that is not plain text (an attribute with child elements) is kept out, so the group check sees fewer groups, never a made-up one. */
function readAttributes(assertion: Xml2Js): Record<string, string[]> {
  const result: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  let count = 0;
  for (const statement of asArray(assertion.AttributeStatement)) {
    for (const attribute of asArray((statement as Xml2Js).Attribute)) {
      const name = attrOf(attribute, "Name");
      if (name === undefined || name === "" || name.length > 512 || name === "__proto__") continue;
      if (++count > ATTRIBUTES_MAX) return result;
      const values: string[] = result[name] ?? [];
      for (const value of asArray((attribute as Xml2Js).AttributeValue)) {
        const text = textOf(value);
        if (text === undefined || text.length > ATTRIBUTE_VALUE_MAX_CHARS) {
          // Mark an unreadable value with an empty value, which the group reader refuses (claim_invalid): the list is then refused whole, never shorter and quietly valid
          // (a dropped value could be the Auditor group that makes the sign-in a refusal).
          values.push("");
          continue;
        }
        if (values.length < ATTRIBUTE_MAX_VALUES + 1) values.push(text);
      }
      result[name] = values;
    }
  }
  return result;
}

// ---- the one-time assertion id store

export interface SamlReplayStore {
  /** Records the assertion as seen. True the first time; false when it was seen before (a replay). Throws when the store cannot answer: the sign-in is then refused. */
  claim(orgId: OrgId, issuer: string, assertionId: string, expiresAtSeconds: number): Promise<boolean>;
}

type DocumentClient = { send(command: unknown): Promise<unknown> };
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const conditionalFailed = (error: unknown) => (error as { name?: string } | null)?.name === "ConditionalCheckFailedException";

/** How long an assertion id is remembered after the assertion's own end: long enough that a copy cannot come back inside the assertion's life. */
export const SAML_REPLAY_MARGIN_SECONDS = 10 * 60;

export function dynamoSamlReplayStore(input: { documentClient: DocumentClient; tableName: string }): SamlReplayStore {
  return {
    async claim(orgId, issuer, assertionId, expiresAtSeconds) {
      try {
        await input.documentClient.send(new PutCommand({
          TableName: input.tableName, Item: { ...samlSeenKey(orgId, sha256(`${issuer}\n${assertionId}`)), entityType: "SSO_SAML_SEEN", expiresAt: expiresAtSeconds + SAML_REPLAY_MARGIN_SECONDS },
          ConditionExpression: "attribute_not_exists(pk)",
        }));
        return true;
      } catch (error) {
        if (conditionalFailed(error)) return false;
        throw error;
      }
    },
  };
}

/** Records the assertion id once. A replay, or a store that cannot answer, refuses the sign-in. */
export async function claimAssertion(store: SamlReplayStore, orgId: OrgId, assertion: VerifiedSamlAssertion): Promise<SamlVerification> {
  try {
    if (!await store.claim(orgId, assertion.issuer, assertion.assertionId, assertion.notOnOrAfter)) return refuse("replayed");
  } catch {
    return refuse("replayed");
  }
  return { ok: true, assertion };
}

// ---- the posted response, kept for one redirect
//
// The identity provider POSTs the response from another site, and a browser does not send a SameSite=Lax cookie on a cross-site POST, so the sign-in's cookie checks would fail.
// The POST handler therefore keeps the response (bounded, unread) under a random single-use handle for two minutes and redirects the browser to a GET, which carries the cookies.

export interface SamlResponseStash {
  put(orgId: OrgId, handle: string, response: string, expiresAtSeconds: number): Promise<void>;
  /** Returns the response once and removes it; undefined when there is none, it was taken, or it has expired. */
  take(orgId: OrgId, handle: string, nowMs: number): Promise<string | undefined>;
}

export const SAML_STASH_TTL_SECONDS = 120;
export const SAML_HANDLE = /^[A-Za-z0-9_-]{43}$/;

export function dynamoSamlResponseStash(input: { documentClient: DocumentClient; tableName: string }): SamlResponseStash {
  return {
    async put(orgId, handle, response, expiresAtSeconds) {
      await input.documentClient.send(new PutCommand({
        TableName: input.tableName, Item: { ...samlStashKey(orgId, handle), entityType: "SSO_SAML_RESP", response, expiresAt: expiresAtSeconds + 3600 },
        ConditionExpression: "attribute_not_exists(pk)",
      }));
    },
    async take(orgId, handle, nowMs) {
      if (!SAML_HANDLE.test(handle)) return undefined;
      const removed = await input.documentClient.send(new DeleteCommand({ TableName: input.tableName, Key: samlStashKey(orgId, handle), ReturnValues: "ALL_OLD" })) as { Attributes?: { response?: unknown; expiresAt?: unknown } };
      const item = removed.Attributes;
      if (item === undefined || typeof item.response !== "string" || typeof item.expiresAt !== "number") return undefined;
      // `expiresAt` carries a one-hour table margin; the handle's own life is the stash TTL.
      return item.expiresAt - 3600 > Math.floor(nowMs / 1000) ? item.response : undefined;
    },
  };
}

// ---- the saved configuration

/** Checks the certificate the admin pasted: a real X.509 certificate with a usable public key, not already expired. Fixed words; the parser's text never leaves. */
export function checkSamlCertificate(pem: string, nowMs: number): "ok" | "unreadable" | "expired" | "weak_key" | "not_yet_valid" {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(pem);
  } catch {
    return "unreadable";
  }
  if (Date.parse(cert.validTo) <= nowMs) return "expired";
  if (Date.parse(cert.validFrom) > nowMs + 24 * 3600_000) return "not_yet_valid";
  const key = cert.publicKey;
  if (key.asymmetricKeyType === "rsa" && (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) return "weak_key";
  if (key.asymmetricKeyType !== "rsa" && key.asymmetricKeyType !== "ec") return "weak_key";
  return "ok";
}

export const SAML_CERTIFICATE_MESSAGES = {
  unreadable: "That certificate could not be read. Paste the identity provider's signing certificate in PEM form.",
  expired: "That certificate has expired. Download the current signing certificate from your identity provider.",
  not_yet_valid: "That certificate is not valid yet. Check that you copied the current signing certificate.",
  weak_key: "That certificate's key is too weak. Rovara needs RSA of 2048 bits or more, or an elliptic curve key.",
} as const;

type SaveEvents = readonly AuditEventInput[];

export interface SamlConfigStore {
  /** The org's SAML settings, or undefined when none is saved. A stored record that does not parse throws. */
  get(orgId: OrgId): Promise<SamlIdpConfig | undefined>;
  /** Saves them (compare and set on the version the admin read; 0 when none is saved). The audit events commit with the save. */
  put(orgId: OrgId, settings: SamlIdpSettings, by: string, expectedVersion: number, nowMs: number, events?: SaveEvents): Promise<SamlIdpConfig>;
}

export function dynamoSamlConfigStore(input: { documentClient: DocumentClient; tableName: string; policy: EditionPolicy; audit?: AuditRuntime }): SamlConfigStore {
  const { documentClient, tableName, policy } = input;
  const deps = { documentClient, ...(input.audit === undefined ? {} : { audit: input.audit }) };
  return {
    async get(orgId) {
      requireFeature(policy, "sso");
      const result = await documentClient.send(new GetCommand({ TableName: tableName, Key: samlIdpConfigKey(orgId), ConsistentRead: true })) as { Item?: Record<string, unknown> };
      if (result.Item === undefined) return undefined;
      const { pk: _pk, sk: _sk, entityType: _entityType, ...rest } = result.Item;
      void _pk; void _sk; void _entityType;
      const parsed = SamlIdpConfigSchema.safeParse(rest);
      if (!parsed.success) throw agentXError("CONFIG_INVALID", "SAML sign-in is set up in a way Rovara cannot read. Ask your administrator to save the settings again.");
      return parsed.data;
    },
    async put(orgId, settings, by, expectedVersion, nowMs, events = []) {
      requireFeature(policy, "sso");
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw agentXError("CONFIG_INVALID", "the SAML settings version is invalid");
      const certificate = checkSamlCertificate(settings.certificate, nowMs);
      if (certificate !== "ok") throw agentXError("CONFIG_INVALID", SAML_CERTIFICATE_MESSAGES[certificate]);
      const next = SamlIdpConfigSchema.parse({ ...settings, version: expectedVersion + 1, updatedAt: new Date(nowMs).toISOString(), updatedBy: by });
      try {
        await auditTransact(deps, { Put: {
          TableName: tableName, Item: { ...samlIdpConfigKey(orgId), entityType: "SSO_SAML_IDP", ...next },
          ...(expectedVersion === 0
            ? { ConditionExpression: "attribute_not_exists(pk)" }
            : { ConditionExpression: "#version = :expected", ExpressionAttributeNames: { "#version": "version" }, ExpressionAttributeValues: { ":expected": expectedVersion } }),
        } }, [...events]);
      } catch (error) {
        if (conditionalFailed(error)) throw agentXError("IDEMPOTENCY_CONFLICT", "Someone else changed the SAML settings. Reload them and make your change again.");
        throw error;
      }
      await flushAuditEvents(deps, [...events]);
      return next;
    },
  };
}

export interface SamlStores {
  config: SamlConfigStore;
  replay: SamlReplayStore;
  stash: SamlResponseStash;
}
