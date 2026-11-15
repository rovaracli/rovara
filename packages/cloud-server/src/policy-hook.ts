// Contract H-1: keep these constants, claim lists and patterns identical to contracts/shared/policy-hook.v1.json and to Rovara Code's copy (checked by a test in each repo).
//
// The policy hook's answering route (migration plan v3.2, section 7.5; decision 214.6). A Rovara Code install asks three questions, each a compact JWS signed
// with the install's key: may this task start, may this person decide this (fresh sign-in, second person), and what are the company's values. This route
// checks the question against the asking install's pinned public keys (never a key address the question names), reads the company's rules, and answers with
// a compact JWS signed by the hook key through an injected signer. The answer is bound to the request id, the question's hash and its kind, and lives at most
// 300 s. A repeated question (same request id, same text) gets the same answer, so it counts once; the same request id with another text is refused.
// Code treats any failure as no answer, which is a refusal, and can only be made stricter by an answer.
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import type { CloudRequest, CloudResponse } from "./handler.js";

export const POLICY_HOOK_PATH = "/v1/policy-hook";
export const POLICY_HOOK = Object.freeze({
  version: 1,
  alg: "RS256",
  questionTyp: "rovara-policy-question+jwt",
  answerTyp: "rovara-policy-answer+jwt",
  questionLifetimeSeconds: 360,
  answerMaxLifetimeSeconds: 300,
  clockSkewSeconds: 30,
  maxBodyBytes: 8192,
  pinnedKeysMax: 2,
  requestTimeoutSeconds: 5,
  startHoldSeconds: 300,
  valuesGraceSeconds: 300,
});
export const POLICY_HOOK_CONTENT_TYPE = "application/jose";

export const POLICY_HOOK_PATTERNS = Object.freeze({
  OrgId: /^org_[0-9a-z]{20}$/u,
  ProjectName: /^[a-z][a-z0-9-]{0,62}$/u,
  PersonId: /^[A-Za-z0-9_.:@+-]{1,128}$/u,
  TaskId: /^[A-Za-z0-9_.:-]{1,128}$/u,
  DecisionKind: /^[a-z][a-z0-9_.-]{0,63}$/u,
  Code: /^[a-z][a-z0-9_]{0,63}$/u,
  Kid: /^[A-Za-z0-9_-]{1,64}$/u,
  Issuer: /^https:\/\/[^\s]{1,504}$/u,
});

export const POLICY_HOOK_WORDS = Object.freeze({
  startNoAnswer: "the company rules service did not answer; nothing has started",
  startRefused: "the company rules do not allow this task to start",
  decideNoAnswer: "the company rules service did not answer; nothing was decided",
  decideRefused: "the company rules do not allow this decision",
  valuesNoAnswer: "the company rules service did not answer; the strictest settings apply",
});

export type PolicyHookKind = "start" | "decide" | "values";
export const POLICY_HOOK_KINDS: readonly PolicyHookKind[] = Object.freeze(["start", "decide", "values"]);

type Check = (value: unknown) => boolean;
interface Field { name: string; required: boolean; check: Check }
const P = POLICY_HOOK_PATTERNS;
const text = (pattern: RegExp): Check => (value) => typeof value === "string" && pattern.test(value);
const integer = (min = 0, max = Number.MAX_SAFE_INTEGER): Check => (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const oneOf = (...values: readonly string[]): Check => (value) => typeof value === "string" && values.includes(value);
const bool: Check = (value) => typeof value === "boolean";
const uuid = text(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
const plainObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const field = (name: string, required: boolean, check: Check): Field => ({ name, required, check });

export const POLICY_HOOK_QUESTION_CLAIMS: readonly Field[] = [
  field("v", true, (value) => value === 1), field("iss", true, text(P.Issuer)), field("rid", true, uuid), field("iat", true, integer()), field("exp", true, integer()),
  field("kind", true, oneOf(...POLICY_HOOK_KINDS)), field("q", true, plainObject),
];
export const POLICY_HOOK_ANSWER_CLAIMS: readonly Field[] = [
  field("v", true, (value) => value === 1), field("rid", true, uuid), field("qh", true, text(/^[A-Za-z0-9_-]{43}$/u)), field("iat", true, integer()), field("exp", true, integer()),
  field("kind", true, oneOf(...POLICY_HOOK_KINDS)), field("a", true, plainObject),
];
export const POLICY_HOOK_QUESTION_KINDS: Readonly<Record<PolicyHookKind, readonly Field[]>> = {
  start: [
    field("cid", true, text(P.OrgId)), field("pid", true, text(P.ProjectName)), field("per", false, text(P.PersonId)), field("tid", true, text(P.TaskId)),
    field("path", false, oneOf("QUICK", "FULL")), field("estUsdMicros", false, integer()), field("estTokens", false, integer()),
  ],
  decide: [
    field("cid", true, text(P.OrgId)), field("pid", false, text(P.ProjectName)), field("stage", true, oneOf("requirement", "verdict")), field("what", true, text(P.DecisionKind)),
    field("styp", true, text(P.DecisionKind)), field("sid", true, text(P.TaskId)), field("risk", false, oneOf("low", "medium", "high")),
    field("by", false, text(P.PersonId)), field("per", false, text(P.PersonId)), field("auth", false, integer()),
  ],
  values: [field("cid", true, text(P.OrgId)), field("pid", false, text(P.ProjectName))],
};
const lockValue: Check = (value) => value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && value.length <= 64);
export const POLICY_HOOK_ANSWER_KINDS: Readonly<Record<PolicyHookKind, readonly Field[]>> = {
  start: [field("allow", true, bool), field("code", false, text(P.Code))],
  decide: [
    field("allow", true, bool), field("minApprovers", true, integer(1, 10)), field("secondPerson", true, bool), field("selfApproval", true, bool),
    field("signInMaxAgeSeconds", false, integer(0, 2_592_000)),
  ],
  values: [field("locks", true, (value) => plainObject(value) && Object.keys(value).length <= 64 && Object.entries(value).every(([key, entry]) => /^[a-z][a-z0-9_]{0,63}$/u.test(key) && lockValue(entry)))],
};

/** Strict: every required field present and valid, every present field known and valid. */
export function fitsFields(value: unknown, fields: readonly Field[]): value is Record<string, unknown> {
  if (!plainObject(value)) return false;
  const known = new Map(fields.map((entry) => [entry.name, entry]));
  if (Object.keys(value).some((key) => !known.has(key))) return false;
  return fields.every((entry) => (value[entry.name] === undefined ? !entry.required : entry.check(value[entry.name])));
}

export interface PublicJwk { kty: "RSA"; n: string; e: string; kid: string; alg?: "RS256"; use?: "sig" }

/** Signs with the hook key (a KMS key in a deployment; a key made at runtime in tests). The private key never reaches this module. */
export interface PolicyHookAnswerSigner {
  kid(): Promise<string>;
  sign(signingInput: Buffer): Promise<Buffer>;
}
/** The installs allowed to ask, by issuer: their pinned public keys and the companies they may ask about. Unknown issuer: undefined. Never fetched from an address a question names. */
export interface PolicyHookInstalls {
  keysFor(issuer: string): Promise<{ keys: readonly PublicJwk[]; companyIds: readonly string[] } | undefined>;
}

/** One decision rule. `what` is a decision kind (`plan`, `merge`, `setting.loosen`) or a prefix ending in `.*` (`setting.*`). */
export interface DecisionRule {
  what: string;
  allow?: boolean;
  minApprovers?: number;
  /** Owner row 11.5: loosening a setting needs a second admin, as `{ "what": "setting.loosen", "secondPerson": true }`. */
  secondPerson?: boolean;
  selfApproval?: boolean;
  signInMaxAgeSeconds?: number;
  /** Who may decide (person ids). Absent: anyone the install's own rules allow. */
  deciders?: readonly string[];
}
/** A company's rules, as Cloud keeps them. */
export interface CompanyRules {
  start?: { allow?: boolean; maxEstimateUsdMicros?: number };
  decisions?: readonly DecisionRule[];
  locks?: Readonly<Record<string, string | number | boolean | null>>;
}
/** Where Cloud reads a company's rules. Undefined: Cloud does not know the company, and every answer is a refusal. */
export interface CompanyRulesReader {
  read(companyId: string): Promise<CompanyRules | undefined>;
}

/**
 * Remembers each request (by issuer and request id) for the question's lifetime, so a repeat is answered the same and counts once. `reserve` is atomic
 * (put-if-absent; a conditional write in a shared store): only the call that reserves signs an answer. A deployment with several servers needs a shared ledger.
 */
export interface PolicyHookRequestLedger {
  /** "reserved": this call owns the request. "seen": the request exists, with its question hash and its answer once one is stored. "full": refuse. */
  reserve(key: string, questionHash: string, expiresAt: number): Promise<{ state: "reserved" } | { state: "seen"; questionHash: string; answer?: string } | { state: "full" }>;
  /** Stores the answer of a reserved request. */
  complete(key: string, answer: string): Promise<void>;
  /** Gives back a reservation that was not answered. */
  release(key: string): Promise<void>;
}

export class LocalPolicyHookRequestLedger implements PolicyHookRequestLedger {
  private readonly entries = new Map<string, { questionHash: string; answer?: string; expiresAt: number }>();
  constructor(private readonly now: () => number = Date.now, private readonly max = 10_000) {}
  async reserve(key: string, questionHash: string, expiresAt: number) {
    const current = this.now();
    const entry = this.entries.get(key);
    if (entry !== undefined && entry.expiresAt > current) return { state: "seen" as const, questionHash: entry.questionHash, ...(entry.answer === undefined ? {} : { answer: entry.answer }) };
    if (this.entries.size >= this.max) for (const [name, value] of this.entries) if (value.expiresAt <= current) this.entries.delete(name);
    // Never drop a live entry to make room: that would let a request be answered twice.
    if (this.entries.size >= this.max) return { state: "full" as const };
    this.entries.set(key, { questionHash, expiresAt });
    return { state: "reserved" as const };
  }
  async complete(key: string, answer: string) {
    const entry = this.entries.get(key);
    if (entry !== undefined) entry.answer = answer;
  }
  async release(key: string) { this.entries.delete(key); }
}

/** Company rules kept in this server's memory (tests, `cloud:local`). */
export class LocalCompanyRules implements CompanyRulesReader {
  constructor(private readonly rules: ReadonlyMap<string, CompanyRules> = new Map()) {}
  async read(companyId: string) { return this.rules.get(companyId); }
}

export interface PolicyHookRouteOptions {
  signer: PolicyHookAnswerSigner;
  installs: PolicyHookInstalls;
  rules: CompanyRulesReader;
  ledger?: PolicyHookRequestLedger;
  /** Milliseconds since the epoch. */
  now?: () => number;
  /** How long an answer lives; at most 300 s. Default 60 s. */
  answerSeconds?: number;
  log?: (event: Record<string, unknown>) => void;
}

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
export const policyHookQuestionHash = (questionJws: string): string => createHash("sha256").update(questionJws, "utf8").digest("base64url");

function signatureValid(key: PublicJwk, signingInput: string, signature: Buffer): boolean {
  try {
    const publicKey = createPublicKey({ key: { kty: key.kty, n: key.n, e: key.e }, format: "jwk" });
    if ((publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) return false;
    return verifySignature("RSA-SHA256", Buffer.from(signingInput, "utf8"), publicKey, signature);
  } catch {
    return false;
  }
}

/** Reads a compact JWS whose header is exactly { alg: RS256, typ, kid }. Undefined for anything else; the signature is not checked here. */
export function readJws(body: unknown, typ: string): { kid: string; claims: unknown; signingInput: string; signature: Buffer } | undefined {
  if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > POLICY_HOOK.maxBodyBytes) return undefined;
  const parts = body.trim().split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/u.test(part))) return undefined;
  try {
    const header: unknown = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"));
    if (!plainObject(header) || Object.keys(header).sort().join(",") !== "alg,kid,typ") return undefined;
    if (header["alg"] !== POLICY_HOOK.alg || header["typ"] !== typ || typeof header["kid"] !== "string" || !P.Kid.test(header["kid"])) return undefined;
    return { kid: header["kid"], claims: JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")), signingInput: `${parts[0]!}.${parts[1]!}`, signature: Buffer.from(parts[2]!, "base64url") };
  } catch {
    return undefined;
  }
}

const matches = (rule: DecisionRule, what: string): boolean => (rule.what.endsWith(".*") ? what.startsWith(rule.what.slice(0, -1)) : rule.what === what);
const clampInt = (value: number | undefined, min: number, max: number, fallback: number): number => (value === undefined || !Number.isSafeInteger(value) ? fallback : Math.min(max, Math.max(min, value)));
/** Absent, or a whole number in range. Anything else in a stored rule makes the answer a refusal, never a looser value. */
const validInt = (value: unknown, min: number, max: number): boolean => value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max);

/** The answer to a checked question, from the company's rules. Unknown company: a refusal for every kind (values: none, which Code reads as no answer). */
export function answerFor(kind: PolicyHookKind, q: Record<string, unknown>, rules: CompanyRules | undefined): Record<string, unknown> | undefined {
  if (kind === "start") {
    if (rules === undefined) return { allow: false, code: "unknown_company" };
    if (rules.start?.allow === false) return { allow: false, code: "starts_paused" };
    const max = rules.start?.maxEstimateUsdMicros;
    if (!validInt(max, 0, Number.MAX_SAFE_INTEGER)) return { allow: false, code: "rules_unreadable" };
    if (max !== undefined) {
      if (typeof q["estUsdMicros"] !== "number") return { allow: false, code: "no_estimate" };
      if (q["estUsdMicros"] > max) return { allow: false, code: "over_estimate_limit" };
    }
    return { allow: true };
  }
  if (kind === "decide") {
    const refused = { allow: false, minApprovers: 1, secondPerson: true, selfApproval: false };
    if (rules === undefined) return refused;
    // Every matching rule applies, and the strictest wins, so the order of the list never loosens an answer.
    const found = (rules.decisions ?? []).filter((entry) => matches(entry, String(q["what"])));
    if (found.some((rule) => rule.allow === false || !validInt(rule.minApprovers, 1, 10) || !validInt(rule.signInMaxAgeSeconds, 0, 2_592_000))) return refused;
    const deciders = found.filter((rule) => rule.deciders !== undefined);
    if (q["stage"] === "verdict" && deciders.some((rule) => typeof q["per"] !== "string" || !rule.deciders!.includes(q["per"]))) return refused;
    const secondPerson = found.some((rule) => rule.secondPerson === true);
    const ages = found.flatMap((rule) => (rule.signInMaxAgeSeconds === undefined ? [] : [rule.signInMaxAgeSeconds]));
    return {
      allow: true,
      minApprovers: Math.max(1, ...found.map((rule) => rule.minApprovers ?? 1)),
      secondPerson,
      selfApproval: !secondPerson && found.every((rule) => rule.selfApproval !== false),
      ...(ages.length === 0 ? {} : { signInMaxAgeSeconds: Math.min(...ages) }),
    };
  }
  if (rules === undefined) return undefined;
  return { locks: { ...(rules.locks ?? {}) } };
}

const REFUSED: CloudResponse = Object.freeze({ status: 401, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify({ error: { type: "policy_hook_error", message: "the question could not be answered" } }) });

export function createPolicyHookRoute(options: PolicyHookRouteOptions): (request: CloudRequest) => Promise<CloudResponse> {
  const now = options.now ?? Date.now;
  const ledger = options.ledger ?? new LocalPolicyHookRequestLedger(now);
  const lifetime = clampInt(options.answerSeconds, 1, POLICY_HOOK.answerMaxLifetimeSeconds, 60);
  const log = options.log ?? ((event) => { console.log(JSON.stringify(event)); });
  const refuse = (reason: string, ids: { requestId?: string } = {}): CloudResponse => {
    log({ event: "policy_hook.refused", reason, ...ids });
    return REFUSED;
  };
  const answerResponse = (body: string): CloudResponse => ({ status: 200, headers: { "content-type": POLICY_HOOK_CONTENT_TYPE, "cache-control": "no-store" }, body });
  return async (request) => {
    let held: string | undefined;
    try {
      if (request.method !== "POST") return refuse("method");
      if ((request.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase() !== POLICY_HOOK_CONTENT_TYPE) return refuse("content_type");
      const read = readJws(request.body, POLICY_HOOK.questionTyp);
      if (read === undefined || !fitsFields(read.claims, POLICY_HOOK_QUESTION_CLAIMS)) return refuse("unreadable");
      const claims = read.claims;
      const kind = claims["kind"] as PolicyHookKind;
      const iat = claims["iat"] as number;
      const exp = claims["exp"] as number;
      const nowSeconds = Math.floor(now() / 1000);
      if (exp - iat !== POLICY_HOOK.questionLifetimeSeconds || nowSeconds >= exp || iat > nowSeconds + POLICY_HOOK.clockSkewSeconds) return refuse("time");
      if (!fitsFields(claims["q"], POLICY_HOOK_QUESTION_KINDS[kind])) return refuse("unreadable");
      const iss = claims["iss"] as string;
      const install = await options.installs.keysFor(iss);
      const key = install?.keys.slice(0, POLICY_HOOK.pinnedKeysMax).find((candidate) => candidate.kid === read.kid);
      if (install === undefined || key === undefined || !signatureValid(key, read.signingInput, read.signature)) return refuse("signature");
      const rid = claims["rid"] as string;
      const q = claims["q"];
      // An install asks only about its own companies: never another company's rules, locks or deciders.
      if (!install.companyIds.includes(q["cid"] as string)) return refuse("company", { requestId: rid });
      const questionHash = policyHookQuestionHash(request.body!.trim());
      const ledgerKey = `${iss}\u0000${rid}`;
      const reserved = await ledger.reserve(ledgerKey, questionHash, exp * 1000);
      if (reserved.state === "reserved") held = ledgerKey;
      if (reserved.state === "full") return refuse("busy", { requestId: rid });
      if (reserved.state === "seen") return reserved.questionHash === questionHash && reserved.answer !== undefined ? answerResponse(reserved.answer) : refuse("repeat", { requestId: rid });
      const a = answerFor(kind, q, await options.rules.read(q["cid"] as string));
      if (a === undefined || !fitsFields(a, POLICY_HOOK_ANSWER_KINDS[kind])) {
        return refuse("no_rules", { requestId: rid });
      }
      const answerIat = Math.floor(now() / 1000);
      const answerClaims = { v: POLICY_HOOK.version, rid, qh: questionHash, iat: answerIat, exp: answerIat + lifetime, kind, a };
      const signingInput = `${b64({ alg: POLICY_HOOK.alg, typ: POLICY_HOOK.answerTyp, kid: await options.signer.kid() })}.${b64(answerClaims)}`;
      const answer = `${signingInput}.${(await options.signer.sign(Buffer.from(signingInput, "utf8"))).toString("base64url")}`;
      await ledger.complete(ledgerKey, answer);
      held = undefined;
      log({ event: "policy_hook.answered", kind, requestId: rid, companyId: q["cid"], ...(typeof a["allow"] === "boolean" ? { allow: a["allow"] } : {}) });
      return answerResponse(answer);
    } catch {
      log({ event: "policy_hook.failed" });
      return REFUSED;
    } finally {
      // A reservation that was not answered is given back, so the asker's retry of the same question can be answered.
      if (held !== undefined) await ledger.release(held).catch(() => undefined);
    }
  };
}
