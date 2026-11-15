// Plan v3.2 7.5: Cloud records each policy hook answer. One record for the company the question was about, written after the answer is signed and before it is handed
// back; an answer that cannot be recorded is not given; a question that is refused before its company is trusted (forged, unknown install, another install's company) records nothing.
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  LocalCloudAuditStore, LocalCompanyRules, LocalPolicyHookRequestLedger, POLICY_HOOK_PATH, createPolicyHookRoute, type CloudAuditRecord, type PolicyHookRequestLedger, type CloudAuditStore, type CompanyRules, type PublicJwk,
} from "../../packages/cloud-server/src/index.js";

const keyPair = (kid: string): { privateKey: KeyObject; jwk: PublicJwk } => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const exported = publicKey.export({ format: "jwk" });
  return { privateKey, jwk: { kty: "RSA", n: String(exported.n), e: String(exported.e), kid, alg: "RS256", use: "sig" } };
};
const install = keyPair("install-key-1");
const forger = keyPair("install-key-1");
const hookKey = keyPair("hook-key-1");
const ISSUER = "https://install-a.example/v1/auth";
const SECOND = "https://install-b.example/v1/auth";
const COMPANY = "org_aaaaaaaaaaaaaaaaaaaa";
const NO_RULES = "org_bbbbbbbbbbbbbbbbbbbb";
const FOREIGN = "org_dddddddddddddddddddd";
const T0 = 1_800_000_000_000;
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jws = (key: { privateKey: KeyObject }, header: Record<string, unknown>, claims: unknown) => {
  const input = `${b64(header)}.${b64(claims)}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), key.privateKey).toString("base64url")}`;
};
let counter = 0;
const rid = () => `22222222-2222-4222-8222-${String(++counter).padStart(12, "0")}`;
const question = (kind: string, q: Record<string, unknown>, extra: { key?: { privateKey: KeyObject }; rid?: string; iss?: string } = {}) =>
  jws(extra.key ?? install, { alg: "RS256", typ: "rovara-policy-question+jwt", kid: "install-key-1" }, { v: 1, iss: extra.iss ?? ISSUER, rid: extra.rid ?? rid(), iat: T0 / 1000, exp: T0 / 1000 + 360, kind, q });

const rules: CompanyRules = {
  start: { maxEstimateUsdMicros: 5_000_000 },
  decisions: [{ what: "setting.loosen", secondPerson: true, signInMaxAgeSeconds: 900 }, { what: "keep.*", allow: false }],
  locks: { extra_review: true, model_budget_usd: 5 },
};

function world(audit: CloudAuditStore = new LocalCloudAuditStore(), clock: () => number = () => T0, ledger?: PolicyHookRequestLedger) {
  const route = createPolicyHookRoute({
    ...(ledger === undefined ? {} : { ledger }),
    signer: { async kid() { return "hook-key-1"; }, async sign(input) { return sign("RSA-SHA256", input, hookKey.privateKey); } },
    installs: { async keysFor(issuer) { return issuer === ISSUER || issuer === SECOND ? { keys: [install.jwk], companyIds: [COMPANY, NO_RULES] } : undefined; } },
    rules: new LocalCompanyRules(new Map([[COMPANY, rules], [FOREIGN, rules]])),
    audit, now: clock, log: () => undefined,
  });
  const post = (body: string) => route({ method: "POST", path: POLICY_HOOK_PATH, query: new URLSearchParams(), headers: { "content-type": "application/jose" }, body });
  const records = async (company: string): Promise<CloudAuditRecord[]> => (await audit.read(company, { max: 50 })).rows;
  return { post, records, audit };
}

describe("the policy hook records its answers", () => {
  it("records a start answer: about the person, the task and the project, allowed", async () => {
    const { post, records } = world();
    expect((await post(question("start", { cid: COMPANY, pid: "web", per: "person-1", tid: "task_1", estUsdMicros: 2_000_000 }))).status).toBe(200);
    const [row, ...rest] = await records(COMPANY);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      companyId: COMPANY, at: new Date(T0).toISOString(), actor: { developerId: "person-1", name: "person-1", type: "person" }, via: "policy-hook",
      action: "hook.start.answered", subject: "task:task_1", project: "web", outcome: "ok",
    });
    expect(row!.id).toMatch(/^aud_[0-9a-z]{20}$/u);
    expect(row!.detail).toBeUndefined();
  });

  it("records a refused start with the answer's code", async () => {
    const { post, records } = world();
    expect((await post(question("start", { cid: COMPANY, pid: "web", tid: "task_1", estUsdMicros: 9_000_000 }))).status).toBe(200);
    expect((await records(COMPANY))[0]).toMatchObject({ action: "hook.start.answered", outcome: "refused", detail: "over_estimate_limit", actor: { developerId: "policy-hook", type: "system" } });
  });

  it("records a decide answer as the deciding person's, about the thing decided", async () => {
    const { post, records } = world();
    await post(question("decide", { cid: COMPANY, stage: "requirement", what: "setting.loosen", styp: "setting", sid: "review_mode", by: "admin-a", per: "admin-b" }));
    await post(question("decide", { cid: COMPANY, stage: "requirement", what: "keep.branch", styp: "task", sid: "t1", per: "admin-c" }));
    const rows = await records(COMPANY);
    expect(rows.map((row) => [row.action, row.outcome, row.actor.developerId, row.subject, row.detail])).toEqual(expect.arrayContaining([
      ["hook.decide.answered", "ok", "admin-a", "setting:review_mode", "requirement setting.loosen"],
      ["hook.decide.answered", "refused", "admin-c", "task:t1", "requirement keep.branch"],
    ]));
    expect(rows).toHaveLength(2);
  });

  it("records a values answer with how many locks it carried, and a values question with no answer as unanswered", async () => {
    const { post, records } = world();
    await post(question("values", { cid: COMPANY, pid: "web" }));
    expect((await records(COMPANY))[0]).toMatchObject({ action: "hook.values.answered", outcome: "ok", detail: "2 locks", subject: "project:web", project: "web" });
    expect((await post(question("values", { cid: NO_RULES }))).status).toBe(401);
    expect((await records(NO_RULES))[0]).toMatchObject({ companyId: NO_RULES, action: "hook.values.unanswered", outcome: "refused", detail: "no_rules" });
  });

  it("records an unknown company's refused start under that company, as answered (the answer was a refusal)", async () => {
    const { post, records } = world();
    await post(question("start", { cid: NO_RULES, pid: "web", tid: "t" }));
    expect((await records(NO_RULES))[0]).toMatchObject({ action: "hook.start.answered", outcome: "refused", detail: "unknown_company" });
  });

  it("records a repeated question once, and answers it the same", async () => {
    const { post, records } = world();
    const q = question("start", { cid: COMPANY, pid: "web", tid: "t1", estUsdMicros: 1 });
    const first = await post(q), second = await post(q);
    expect(second.body).toBe(first.body);
    expect(await records(COMPANY)).toHaveLength(1);
  });

  it("records two different questions as two records; a request id reused for another question is refused and records nothing more", async () => {
    const { post, records } = world();
    const same = rid();
    expect((await post(question("start", { cid: COMPANY, pid: "web", tid: "t1", estUsdMicros: 1 }, { rid: same }))).status).toBe(200);
    expect((await post(question("values", { cid: COMPANY }, { rid: same }))).status).toBe(401);
    expect((await post(question("start", { cid: COMPANY, pid: "web", tid: "t2", estUsdMicros: 1 }))).status).toBe(200);
    expect(await records(COMPANY)).toHaveLength(2);
  });

  it("records the same request id from two installs as two records, one for each question", async () => {
    const { post, records } = world();
    const same = rid();
    const q = { cid: COMPANY, pid: "web", tid: "t1", estUsdMicros: 1 };
    expect((await post(question("start", q, { rid: same }))).status).toBe(200);
    expect((await post(question("start", q, { rid: same, iss: SECOND }))).status).toBe(200);
    expect(await records(COMPANY)).toHaveLength(2);
  });

  it("records for the company the question was about only", async () => {
    const { post, records } = world();
    await post(question("start", { cid: COMPANY, pid: "web", tid: "t1", estUsdMicros: 1 }));
    expect(await records(COMPANY)).toHaveLength(1);
    expect(await records(NO_RULES)).toEqual([]);
    expect(await records(FOREIGN)).toEqual([]);
  });

  it("records nothing for a question refused before its company is trusted: forged, unknown install, or another install's company", async () => {
    const { post, records, audit } = world();
    const q = { cid: COMPANY, pid: "web", tid: "t", estUsdMicros: 1 };
    expect((await post(question("start", q, { key: forger }))).status).toBe(401);
    expect((await post(question("start", q, { iss: "https://install-c.example/v1/auth" }))).status).toBe(401);
    expect((await post(question("start", { ...q, cid: FOREIGN }))).status).toBe(401);
    expect((await post("not a jws")).status).toBe(401);
    for (const company of [COMPANY, NO_RULES, FOREIGN]) expect(await records(company)).toEqual([]);
    void audit;
  });

  it("keeps keys, signatures and the question's text out of the record", async () => {
    const { post, records } = world();
    const q = question("start", { cid: COMPANY, pid: "web", per: "person-1", tid: "t1", estUsdMicros: 1 });
    const answer = await post(q);
    const text = JSON.stringify(await records(COMPANY));
    expect(text).not.toContain(q);
    expect(text).not.toContain(answer.body);
    expect(text).not.toContain(q.split(".")[2]!);
    expect(text).not.toContain(ISSUER);
  });
});

describe("an answer that cannot be recorded is not given", () => {
  const failing = (fail: { on: boolean }): CloudAuditStore => {
    const inner = new LocalCloudAuditStore();
    return { read: (company, range) => inner.read(company, range), append: async (record) => { if (fail.on) throw new Error("table down with secret details"); return inner.append(record); } };
  };

  it("refuses the question when the record is not written, and answers it once the store is back, with one record", async () => {
    const fail = { on: true };
    const { post, records } = world(failing(fail));
    const q = question("start", { cid: COMPANY, pid: "web", tid: "t1", estUsdMicros: 1 });
    const refusedAnswer = await post(q);
    expect(refusedAnswer.status).toBe(401);
    expect(refusedAnswer.body).not.toContain("secret");
    expect(await records(COMPANY)).toEqual([]);
    fail.on = false;
    const answered = await post(q);
    expect(answered.status).toBe(200);
    expect(await records(COMPANY)).toHaveLength(1);
    expect((await post(q)).body).toBe(answered.body);
    expect(await records(COMPANY)).toHaveLength(1);
  });

  it("refuses a question that has no answer whether or not its record is written", async () => {
    const fail = { on: true };
    const { post } = world(failing(fail));
    expect((await post(question("values", { cid: NO_RULES }))).status).toBe(401);
  });

  it("records a question once when the answer was recorded but the request could not be marked answered, and is asked again", async () => {
    const inner = new LocalPolicyHookRequestLedger(() => T0);
    let failures = 1;
    const ledger: PolicyHookRequestLedger = {
      reserve: (key, hash, expiresAt) => inner.reserve(key, hash, expiresAt), release: (key) => inner.release(key),
      complete: async (key, answer) => { if (failures-- > 0) throw new Error("ledger down"); return inner.complete(key, answer); },
    };
    const { post, records } = world(new LocalCloudAuditStore(), () => T0, ledger);
    const q = question("start", { cid: COMPANY, pid: "web", tid: "t1", estUsdMicros: 1 });
    expect((await post(q)).status).toBe(401);
    expect(await records(COMPANY)).toHaveLength(1);
    expect((await post(q)).status).toBe(200);
    expect(await records(COMPANY)).toHaveLength(1);
  });
});
