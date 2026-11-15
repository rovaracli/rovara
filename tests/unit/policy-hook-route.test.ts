// Lane H: the policy hook's answering route. Questions are signed with an install key made at runtime and checked against that install's pinned keys;
// answers are signed through the injected signer (a runtime key here) and checked with a reference verifier written in this test. A forged, expired,
// unknown-install or reused-id question is refused with one fixed answer. Owner row 11.5 (loosening a setting needs a second admin) is a decision rule.
import { createHash, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  LocalCompanyRules, LocalPolicyHookRequestLedger, LocalSessionStore, LocalWorkSessionStore, POLICY_HOOK_PATH, createCloudHandler, createPolicyHookRoute, type CloudRequest, type CompanyRules, type PublicJwk,
} from "../../packages/cloud-server/src/index.js";

interface Key { privateKey: KeyObject; jwk: PublicJwk }
const makeKey = (kid: string): Key => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const exported = publicKey.export({ format: "jwk" });
  return { privateKey, jwk: { kty: "RSA", n: String(exported.n), e: String(exported.e), kid, alg: "RS256", use: "sig" } };
};
const install = makeKey("install-key-1");
const forger = makeKey("install-key-1");
const hookKey = makeKey("hook-key-1");
const ISSUER = "https://install-a.example/v1/auth";
const COMPANY = "org_aaaaaaaaaaaaaaaaaaaa";
const OTHER = "org_bbbbbbbbbbbbbbbbbbbb";
const BAD = "org_cccccccccccccccccccc";
const FOREIGN = "org_dddddddddddddddddddd";
const T0 = 1_800_000_000_000;
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jws = (key: Key, header: Record<string, unknown>, claims: unknown) => {
  const input = `${b64(header)}.${b64(claims)}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), key.privateKey).toString("base64url")}`;
};
let counter = 0;
const rid = () => `11111111-1111-4111-8111-${String(++counter).padStart(12, "0")}`;
const question = (kind: string, q: Record<string, unknown>, extra: { key?: Key; rid?: string; iat?: number; life?: number; iss?: string; header?: Record<string, unknown> } = {}) => {
  const iat = extra.iat ?? T0 / 1000;
  return jws(extra.key ?? install, extra.header ?? { alg: "RS256", typ: "rovara-policy-question+jwt", kid: "install-key-1" }, { v: 1, iss: extra.iss ?? ISSUER, rid: extra.rid ?? rid(), iat, exp: iat + (extra.life ?? 360), kind, q });
};

/** The reference check Code makes: header, signature by the pinned hook key, bound to this request id, question and kind, alive. */
function referenceCheck(answer: string, questionText: string, kind: string): Record<string, unknown> | undefined {
  const [h, c, s] = answer.split(".");
  const header = JSON.parse(Buffer.from(h!, "base64url").toString()) as Record<string, unknown>;
  if (JSON.stringify(header) !== JSON.stringify({ alg: "RS256", typ: "rovara-policy-answer+jwt", kid: "hook-key-1" })) return undefined;
  if (!verify("RSA-SHA256", Buffer.from(`${h!}.${c!}`), createPublicKey({ key: { kty: "RSA", n: hookKey.jwk.n, e: hookKey.jwk.e }, format: "jwk" }), Buffer.from(s!, "base64url"))) return undefined;
  const claims = JSON.parse(Buffer.from(c!, "base64url").toString()) as Record<string, unknown>;
  const read = JSON.parse(Buffer.from(questionText.split(".")[1]!, "base64url").toString()) as Record<string, unknown>;
  if (claims["rid"] !== read["rid"] || claims["kind"] !== kind || claims["qh"] !== createHash("sha256").update(questionText).digest("base64url")) return undefined;
  if (Number(claims["exp"]) - Number(claims["iat"]) > 300 || Number(claims["exp"]) <= T0 / 1000) return undefined;
  return claims["a"] as Record<string, unknown>;
}

const rules: CompanyRules = {
  start: { maxEstimateUsdMicros: 5_000_000 },
  decisions: [
    { what: "setting.loosen", secondPerson: true, signInMaxAgeSeconds: 900 },
    { what: "merge", minApprovers: 2, deciders: ["admin-a", "admin-b"] },
    { what: "keep.*", allow: false },
  ],
  locks: { extra_review: true, model_budget_usd: 5 },
};

const badRules: CompanyRules = {
  start: { maxEstimateUsdMicros: Number.NaN },
  decisions: [{ what: "merge", minApprovers: 2.5 }, { what: "plan", minApprovers: 50 }, { what: "design", signInMaxAgeSeconds: -1 }],
};
const overlapping: CompanyRules = { decisions: [{ what: "setting.*", allow: true, minApprovers: 1 }, { what: "setting.loosen", secondPerson: true, minApprovers: 2, signInMaxAgeSeconds: 600 }, { what: "setting.*", signInMaxAgeSeconds: 300 }] };

function world(extra: { now?: () => number; log?: Array<Record<string, unknown>>; ledgerMax?: number } = {}) {
  const signed: Buffer[] = [];
  const route = createPolicyHookRoute({
    signer: { async kid() { return "hook-key-1"; }, async sign(input) { signed.push(input); return sign("RSA-SHA256", input, hookKey.privateKey); } },
    installs: { async keysFor(issuer) { return issuer === ISSUER ? { keys: [install.jwk], companyIds: [COMPANY, OTHER, BAD, "org_eeeeeeeeeeeeeeeeeeee"] } : undefined; } },
    rules: new LocalCompanyRules(new Map([[COMPANY, rules], [BAD, badRules], [FOREIGN, rules], ["org_eeeeeeeeeeeeeeeeeeee", overlapping]])),
    ...(extra.ledgerMax === undefined ? {} : { ledger: new LocalPolicyHookRequestLedger(extra.now ?? (() => T0), extra.ledgerMax) }),
    now: extra.now ?? (() => T0),
    log: (event) => extra.log?.push(event),
  });
  const post = (body: string, method = "POST", contentType = "application/jose") => route({ method, path: POLICY_HOOK_PATH, query: new URLSearchParams(), headers: { "content-type": contentType }, body });
  return { post, signed };
}
const refused = { status: 401, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify({ error: { type: "policy_hook_error", message: "the question could not be answered" } }) };

describe("policy hook answering route", () => {
  it("answers a signed start question with a signed, bound answer", async () => {
    const { post } = world();
    const q = question("start", { cid: COMPANY, pid: "web", tid: "task_1", estUsdMicros: 2_000_000 });
    const response = await post(q);
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/jose");
    expect(referenceCheck(response.body, q, "start")).toEqual({ allow: true });
    const over = question("start", { cid: COMPANY, pid: "web", tid: "task_1", estUsdMicros: 6_000_000 });
    expect(referenceCheck((await post(over)).body, over, "start")).toEqual({ allow: false, code: "over_estimate_limit" });
    const none = question("start", { cid: COMPANY, pid: "web", tid: "task_1" });
    expect(referenceCheck((await post(none)).body, none, "start")).toEqual({ allow: false, code: "no_estimate" });
  });

  it("row 11.5: loosening a setting answers second person needed, with a fresh sign-in", async () => {
    const { post } = world();
    const q = question("decide", { cid: COMPANY, stage: "requirement", what: "setting.loosen", styp: "setting", sid: "review_mode", by: "admin-a" });
    expect(referenceCheck((await post(q)).body, q, "decide")).toEqual({ allow: true, minApprovers: 1, secondPerson: true, selfApproval: false, signInMaxAgeSeconds: 900 });
  });

  it("may this person decide: only the named deciders; a refused kind refuses", async () => {
    const { post } = world();
    const ok = question("decide", { cid: COMPANY, stage: "verdict", what: "merge", styp: "task", sid: "t1", per: "admin-b" });
    expect(referenceCheck((await post(ok)).body, ok, "decide")).toMatchObject({ allow: true, minApprovers: 2 });
    const no = question("decide", { cid: COMPANY, stage: "verdict", what: "merge", styp: "task", sid: "t1", per: "intern" });
    expect(referenceCheck((await post(no)).body, no, "decide")).toMatchObject({ allow: false });
    const keep = question("decide", { cid: COMPANY, stage: "requirement", what: "keep.branch", styp: "task", sid: "t1" });
    expect(referenceCheck((await post(keep)).body, keep, "decide")).toMatchObject({ allow: false });
  });

  it("company values: the company's locks", async () => {
    const { post } = world();
    const q = question("values", { cid: COMPANY, pid: "web" });
    expect(referenceCheck((await post(q)).body, q, "values")).toEqual({ locks: { extra_review: true, model_budget_usd: 5 } });
  });

  it("an unknown company: start and decide refuse; values has no answer", async () => {
    const { post } = world();
    const other = OTHER;
    const s = question("start", { cid: other, pid: "web", tid: "t" });
    expect(referenceCheck((await post(s)).body, s, "start")).toEqual({ allow: false, code: "unknown_company" });
    const d = question("decide", { cid: other, stage: "requirement", what: "plan", styp: "task", sid: "t" });
    expect(referenceCheck((await post(d)).body, d, "decide")).toMatchObject({ allow: false });
    expect(await post(question("values", { cid: other }))).toEqual(refused);
  });

  it("a forged, unknown-install, expired, future, malformed or wrongly headed question gets the one fixed refusal and nothing is signed", async () => {
    const { post, signed } = world();
    const q = { cid: COMPANY, pid: "web", tid: "t", estUsdMicros: 1 };
    for (const body of [
      question("start", q, { key: forger }),
      question("start", q, { iss: "https://install-b.example/v1/auth" }),
      question("start", q, { iat: T0 / 1000 - 400 }),
      question("start", q, { iat: T0 / 1000 + 60 }),
      question("start", q, { life: 3600 }),
      question("start", { ...q, extra: 1 }),
      question("start", { ...q, cid: "acme" }),
      question("unknown", q),
      question("start", q, { header: { alg: "RS256", typ: "JWT", kid: "install-key-1" } }),
      question("start", q, { header: { alg: "RS256", typ: "rovara-policy-question+jwt", kid: "install-key-1", jku: "https://x.example/keys" } }),
      `${b64({ alg: "none", typ: "rovara-policy-question+jwt", kid: "install-key-1" })}.${b64({ v: 1 })}.`,
      "not a jws",
      question("start", q) + "A".repeat(9000),
    ]) expect(await post(body)).toEqual(refused);
    expect(await post(question("start", q), "GET")).toEqual(refused);
    expect(signed).toHaveLength(0);
  });

  it("a repeated question is answered the same and counts once; the same request id with another question is refused", async () => {
    const log: Array<Record<string, unknown>> = [];
    const { post, signed } = world({ log });
    const id = rid();
    const first = question("start", { cid: COMPANY, pid: "web", tid: "task_1", estUsdMicros: 1 }, { rid: id });
    const a = await post(first);
    const b = await post(first);
    expect(b).toEqual(a);
    expect(signed).toHaveLength(1);
    expect(log.filter((event) => event["event"] === "policy_hook.answered")).toHaveLength(1);
    expect(log.filter((event) => event["event"] === "policy_hook.refused")).toHaveLength(0);
    expect(await post(question("start", { cid: COMPANY, pid: "web", tid: "task_2", estUsdMicros: 1 }, { rid: id }))).toEqual(refused);
  });

  it("the log line names ids and the outcome, never the question or answer text", async () => {
    const log: Array<Record<string, unknown>> = [];
    const { post } = world({ log });
    const q = question("start", { cid: COMPANY, pid: "web", tid: "task_1", estUsdMicros: 1 });
    const response = await post(q);
    const written = JSON.stringify(log);
    expect(written.includes(q.split(".")[2]!)).toBe(false);
    expect(written.includes(response.body.split(".")[2]!)).toBe(false);
    const requestId = JSON.parse(Buffer.from(q.split(".")[1]!, "base64url").toString()) as { rid: string };
    expect(log).toEqual([{ event: "policy_hook.answered", kind: "start", requestId: requestId.rid, companyId: COMPANY, allow: true }]);
  });

  it("an install asks only about its own companies", async () => {
    const log: Array<Record<string, unknown>> = [];
    const { post, signed } = world({ log });
    expect(await post(question("values", { cid: FOREIGN }))).toEqual(refused);
    expect(await post(question("decide", { cid: FOREIGN, stage: "verdict", what: "merge", styp: "task", sid: "t", per: "admin-a" }))).toEqual(refused);
    expect(signed).toHaveLength(0);
    expect(log.map((event) => event["reason"])).toEqual(["company", "company"]);
  });

  it("a stored rule with a bad number answers a refusal, never a looser value", async () => {
    const { post } = world();
    const start = question("start", { cid: BAD, pid: "web", tid: "t", estUsdMicros: 1 });
    expect(referenceCheck((await post(start)).body, start, "start")).toEqual({ allow: false, code: "rules_unreadable" });
    for (const what of ["merge", "plan", "design"]) {
      const q = question("decide", { cid: BAD, stage: "requirement", what, styp: "task", sid: "t" });
      expect(referenceCheck((await post(q)).body, q, "decide"), what).toMatchObject({ allow: false });
    }
  });

  it("every matching rule applies and the strictest wins, whatever the order", async () => {
    const { post } = world();
    const q = question("decide", { cid: "org_eeeeeeeeeeeeeeeeeeee", stage: "requirement", what: "setting.loosen", styp: "setting", sid: "s" });
    expect(referenceCheck((await post(q)).body, q, "decide")).toEqual({ allow: true, minApprovers: 2, secondPerson: true, selfApproval: false, signInMaxAgeSeconds: 300 });
  });

  it("two copies of one question at once: one answer is signed, both get it or the second is refused; another text under the id is refused", async () => {
    const { post, signed } = world();
    const id = rid();
    const q = question("start", { cid: COMPANY, pid: "web", tid: "task_1", estUsdMicros: 1 }, { rid: id });
    const other = question("start", { cid: COMPANY, pid: "web", tid: "task_2", estUsdMicros: 1 }, { rid: id });
    const [a, b, c] = await Promise.all([post(q), post(q), post(other)]);
    expect(signed).toHaveLength(1);
    expect(a.status).toBe(200);
    expect([200, 401]).toContain(b.status);
    expect(c).toEqual(refused);
    expect(await post(q)).toEqual(a);
  });

  it("a full ledger refuses new questions instead of forgetting live ones", async () => {
    const { post } = world({ ledgerMax: 1 });
    const first = question("start", { cid: COMPANY, pid: "web", tid: "t", estUsdMicros: 1 });
    expect((await post(first)).status).toBe(200);
    expect(await post(question("start", { cid: COMPANY, pid: "web", tid: "t", estUsdMicros: 1 }))).toEqual(refused);
    expect((await post(first)).status).toBe(200);
  });

  it("a question not sent as application/jose is refused", async () => {
    const { post } = world();
    expect(await post(question("start", { cid: COMPANY, pid: "web", tid: "t", estUsdMicros: 1 }), "POST", "application/json")).toEqual(refused);
  });

  it("the handler serves the route only when given one; without it the path is not Cloud's, as before", async () => {
    const base = {
      client: { useRefreshGuard: () => undefined } as never, store: new LocalSessionStore(undefined, { environment: {} }), org: { orgId: COMPANY, name: "Acme" } as never, callbackPath: "/callback", secureCookies: true, work: new LocalWorkSessionStore(), origin: "https://cloud.example",
    };
    const request: CloudRequest = { method: "POST", path: POLICY_HOOK_PATH, query: new URLSearchParams(), headers: {}, body: "x" };
    expect(await createCloudHandler(base)(request)).toBeUndefined();
    const served = createCloudHandler({ ...base, policyHook: async () => ({ status: 418, headers: {}, body: "" }) });
    expect((await served(request))?.status).toBe(418);
  });
});
