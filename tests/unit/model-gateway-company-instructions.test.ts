// L4-HW3c: the gateway answers Code's hosted broker with ONE company's approved rules (POST /v1/service/company-instructions, company-instructions.ts).
// The rules are Cloud's own `instructions` (company-settings.ts) in the Companies table's SETTINGS item, read exactly; a change waiting for a second admin
// (the PENDING item) is never read. Two companies never meet; a token for another company is refused; a company with no rules is a plain 200 with none;
// an item that does not read is 503 (never "no rules"); nothing from the request is echoed.
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { randomUUID, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { beforeAll, describe, expect, it } from "vitest";
import { COMPANY_SETTINGS_LIMITS, defaultCompanySettings, foldInstruction as cloudFold, validateCompanySettings, type CompanyInstruction } from "../../packages/cloud-server/src/company-settings.js";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { EVAL_AUTHORITY_AUDIENCE } from "../../packages/model-gateway/src/eval-authority.js";
import { EVAL_CAP_AUDIENCE } from "../../packages/model-gateway/src/eval-cap.js";
import {
  answerCompanyInstructions, COMPANY_INSTRUCTIONS_AUDIENCE, COMPANY_INSTRUCTIONS_BODY_MAX, COMPANY_INSTRUCTIONS_PATH, COMPANY_INSTRUCTIONS_PER_MINUTE, COMPANY_INSTRUCTIONS_TOKEN_KIND,
  COMPANY_INSTRUCTION_LIMITS, CompanyStoredInstructions, createCompanyInstructionsHandler, foldInstruction, type CompanyInstructionsHandlerOptions,
} from "../../packages/model-gateway/src/company-instructions.js";
import { StaticInstallRegistry } from "../../packages/model-gateway/src/installs.js";
import { SERVICE_TOKEN_AUDIENCE } from "../../packages/model-gateway/src/offered-models.js";
import { createSignedTokenVerifier } from "../../packages/model-gateway/src/token.js";
import { claims, jwk, keys, kid, mint, now } from "./model-gateway-fixture.js";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";

const ISS = claims.iss;
const A = claims.cid;
const B = `org_${"b".repeat(20)}`;
const COMPANIES = "cloud-companies";
const CANARY = "CANARY-company-instructions-5c1e";
const secs = now / 1000;

function mintToken(changes: Record<string, unknown> = {}, header: Record<string, unknown> = {}): string {
  const body = { iss: ISS, aud: COMPANY_INSTRUCTIONS_AUDIENCE, jti: randomUUID(), iat: secs, nbf: secs - 30, exp: secs + 60, cid: A, ...changes };
  const input = [JSON.stringify({ alg: "RS256", typ: "rovara-service+jwt", kid, ...header }), JSON.stringify(body)].map((v) => Buffer.from(v).toString("base64url")).join(".");
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), keys.privateKey).toString("base64url")}`;
}
const verify = () => createSignedTokenVerifier({ registry: new StaticInstallRegistry([{ issuer: ISS, jwksUrl: `${ISS}/.well-known/jwks.json`, taskKids: [kid] }]), readJwks: async () => [jwk], now: () => now }, COMPANY_INSTRUCTIONS_TOKEN_KIND);

const rule = (text: string, priority: "required" | "preferred" = "required"): CompanyInstruction => ({ text, priority });
/** Cloud's Companies table, with the SETTINGS and PENDING rows company-dynamo.ts writes, read through the gateway's own reader. */
function world() {
  const wire = new WireDynamo([COMPANIES]);
  const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), transport: wire.transport });
  /** The settings row Cloud stores: the real validator's output, so the test cannot drift from what Cloud writes. */
  const settingsOf = (instructions: unknown) => ({ ...defaultCompanySettings(), instructions });
  const seed = (cid: string, instructions: unknown, over: { companyId?: string; version?: unknown; settings?: unknown } = {}) =>
    db.put(COMPANIES, { pk: `COMPANY#${cid}`, sk: "SETTINGS", companyId: over.companyId ?? cid, version: (over.version ?? 3) as number, settings: (over.settings ?? settingsOf(instructions)) as never });
  const seedPending = (cid: string, instructions: unknown) =>
    db.put(COMPANIES, { pk: `COMPANY#${cid}`, sk: "PENDING", companyId: cid, changeId: "chg_aaaaaaaaaaaaaaaaaaaa", baseVersion: 3, settings: settingsOf(instructions) as never });
  const opts: CompanyInstructionsHandlerOptions = { verify: verify(), rules: new CompanyStoredInstructions(db, COMPANIES), now: () => now };
  return { wire, seed, seedPending, opts, db };
}
const ask = (company: string = A) => ({ company });
async function call(opts: CompanyInstructionsHandlerOptions, body: unknown, o: { token?: string | undefined; headers?: Record<string, string>; method?: string; raw?: Buffer } = {}) {
  const bytes = o.raw ?? Buffer.from(JSON.stringify(body));
  const token = "token" in o ? o.token : mintToken();
  return answerCompanyInstructions(opts, {
    method: o.method ?? "POST",
    headers: { "content-type": "application/json", ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), ...o.headers },
    body: (async function* () { yield bytes; })(),
  });
}
const NOT_FOUND = { status: 404, body: { error: { type: "not_found", message: "not found" } } };
const UNAVAILABLE = { status: 503, body: { error: { type: "unavailable", message: "model access unavailable" } } };
const UNSIGNED = { status: 401, body: { error: { type: "unauthorized", message: "the service call is not signed" } } };
const INVALID = { status: 400, body: { error: { type: "invalid_request", message: "the service call is not valid" } } };
const TOO_LARGE = { status: 413, body: { error: { type: "invalid_request", message: "the request is too large" } } };
const ok = (rules: CompanyInstruction[], version = "3", company = A) => ({ status: 200, body: { company, version, rules } });

describe("the approved rules of the asking company", () => {
  it("answers the SETTINGS item's rules, in order, with Required and Preferred as stored, and the settings version", async () => {
    const w = world();
    await w.seed(A, [rule("Never commit secrets."), rule("Prefer small pull requests.", "preferred")]);
    expect(await call(w.opts, ask())).toEqual(ok([rule("Never commit secrets."), rule("Prefer small pull requests.", "preferred")], "3"));
  });
  it("is exactly {company, version, rules}; the read is one strongly consistent GetItem of the company's SETTINGS key", async () => {
    const w = world();
    await w.seed(A, [rule("One.")]);
    const answer = await call(w.opts, ask());
    expect(Object.keys(answer.body as object).sort()).toEqual(["company", "rules", "version"]);
    const reads = w.wire.calls.filter((c) => c.operation === "GetItem");
    expect(reads.map((c) => c.keys)).toEqual([[{ pk: `COMPANY#${A}`, sk: "SETTINGS" }]]);
    expect((reads[0]!.input as { ConsistentRead?: boolean }).ConsistentRead).toBe(true);
  });
  it("the text is what Cloud stored after its own folding (Cloud's validator and the gateway's fold agree)", async () => {
    const w = world();
    const checked = validateCompanySettings({ ...defaultCompanySettings(), instructions: [{ text: "  Keep\tit​   tidy‮. ", priority: "required" }] });
    if (!checked.ok) throw new Error("fixture");
    await w.seed(A, checked.settings.instructions);
    expect(await call(w.opts, ask())).toEqual(ok([rule(cloudFold("  Keep\tit​   tidy‮. "))]));
    for (const text of ["a\u0000b", "x ​​ y", " tab\there\r\n", "plain"]) expect(foldInstruction(text)).toBe(cloudFold(text));
  });
  it("the limits are Cloud's limits", () => {
    expect(COMPANY_INSTRUCTION_LIMITS).toEqual({ max: COMPANY_SETTINGS_LIMITS.instructionsMax, chars: COMPANY_SETTINGS_LIMITS.instructionChars, totalChars: COMPANY_SETTINGS_LIMITS.instructionsTotalChars });
  });
});

describe("approved only: a change waiting for a second admin is never read", () => {
  it("the PENDING item's instructions never appear, and PENDING is never read", async () => {
    const w = world();
    await w.seed(A, [rule("Approved rule.")]);
    await w.seedPending(A, [rule(`${CANARY} unapproved draft`)]);
    const answer = await call(w.opts, ask());
    expect(answer).toEqual(ok([rule("Approved rule.")]));
    expect(JSON.stringify(answer)).not.toContain(CANARY);
    expect(w.wire.calls.filter((c) => c.operation !== "PutItem").every((c) => JSON.stringify(c).indexOf("PENDING") === -1)).toBe(true);
  });
  it("a company with only a pending draft and no approved rules answers none", async () => {
    const w = world();
    await w.seed(A, []);
    await w.seedPending(A, [rule(`${CANARY} unapproved draft`)]);
    const answer = await call(w.opts, ask());
    expect(answer).toEqual(ok([], "0"));
    expect(JSON.stringify(answer)).not.toContain(CANARY);
  });
  it("no settings item at all, with a pending item present, answers none", async () => {
    const w = world();
    await w.seedPending(A, [rule(`${CANARY} unapproved draft`)]);
    expect(await call(w.opts, ask())).toEqual(ok([], "0"));
  });
});

describe("empty is a plain 200 with no rules (never a 404 that a missing route could also be)", () => {
  it("no settings row, or settings with no instructions", async () => {
    const w = world();
    expect(await call(w.opts, ask())).toEqual(ok([], "0"));
    await w.seed(A, []);
    expect(await call(w.opts, ask())).toEqual(ok([], "0"));
  });
});

describe("two companies", () => {
  it("A's token reads only A's rules; B's only B's; the reads name the token's company alone", async () => {
    const w = world();
    await w.seed(A, [rule("A-RULE")]); await w.seed(B, [rule("B-RULE")], { version: 9 });
    const a = await call(w.opts, ask(A));
    const b = await call(w.opts, ask(B), { token: mintToken({ cid: B }) });
    expect(a).toEqual(ok([rule("A-RULE")], "3", A));
    expect(b).toEqual(ok([rule("B-RULE")], "9", B));
    expect(JSON.stringify(a)).not.toContain("B-RULE");
    expect(JSON.stringify(b)).not.toContain("A-RULE");
    const asked: string[] = [];
    const spy = { read: async (cid: string) => { asked.push(cid); return undefined; } };
    await call({ verify: verify(), rules: spy }, ask(A));
    await call({ verify: verify(), rules: spy }, ask(B), { token: mintToken({ cid: B }) });
    expect(asked).toEqual([A, B]);
  });
  it("a token for one company with a body naming the other is a fixed 404, and nothing is read", async () => {
    const w = world();
    await w.seed(A, [rule("A-RULE")]); await w.seed(B, [rule("B-RULE")]);
    expect(await call(w.opts, ask(B))).toEqual(NOT_FOUND);
    expect(await call(w.opts, ask(A), { token: mintToken({ cid: B }) })).toEqual(NOT_FOUND);
    expect(w.wire.calls.filter((c) => c.operation === "GetItem")).toHaveLength(0);
  });
  it("a row under A's key that names another company is not read as A's rules: 503", async () => {
    const w = world();
    await w.seed(A, [rule(`${CANARY}`)], { companyId: B });
    const answer = await call(w.opts, ask(A));
    expect(answer).toEqual(UNAVAILABLE);
    expect(JSON.stringify(answer)).not.toContain(CANARY);
  });
});

describe("an item that does not read fails closed (503), never as no rules", () => {
  const cases: [string, unknown, { version?: unknown; settings?: unknown }?][] = [
    ["instructions not a list", "text"],
    ["an entry that is not an object", ["text"]],
    ["an entry with an extra member", [{ text: "x", priority: "required", extra: 1 }]],
    ["an entry with a bad priority", [{ text: "x", priority: "high" }]],
    ["an entry with no text", [{ priority: "required" }]],
    ["an empty rule after folding", [rule(" ​ \t ")]],
    ["a rule over 600 characters", [rule("x".repeat(601))]],
    ["a rule so long it is refused before folding", [rule(" ".repeat(2401))]],
    ["31 rules", Array.from({ length: 31 }, (_, i) => rule(`rule ${String(i)}`))],
    ["over 12,000 characters in all", Array.from({ length: 21 }, () => rule("y".repeat(600)))],
    ["no settings document", undefined, { settings: "nope" }],
    ["a settings document without instructions", undefined, { settings: { featureGates: {} } }],
    ["a version of zero", [rule("x")], { version: 0 }],
    ["a version that is a string", [rule("x")], { version: "3" }],
  ];
  for (const [name, instructions, over] of cases) {
    it(name, async () => {
      const w = world();
      await w.seed(A, instructions, over ?? {});
      expect(await call(w.opts, ask())).toEqual(UNAVAILABLE);
    });
  }
  it("a read that throws is 503 and the cause is not echoed", async () => {
    const opts: CompanyInstructionsHandlerOptions = { verify: verify(), rules: { read: async () => { throw new Error(`table down ${CANARY}`); } } };
    const answer = await call(opts, ask());
    expect(answer).toEqual(UNAVAILABLE);
    expect(JSON.stringify(answer)).not.toContain(CANARY);
  });
  it("exactly 30 rules of 600 characters in 12,000 in all still reads", async () => {
    const w = world();
    await w.seed(A, Array.from({ length: 20 }, () => rule("z".repeat(600))));
    expect((await call(w.opts, ask())).status).toBe(200);
    const v = world();
    await v.seed(A, Array.from({ length: 30 }, (_, i) => rule(`${String(i)}`)));
    expect((await call(v.opts, ask())).status).toBe(200);
  });
});

describe("the body: exactly the contract", () => {
  it("extra, missing or wrongly typed members are refused, and never echoed", async () => {
    const w = world();
    await w.seed(A, [rule("x")]);
    const bad: unknown[] = [null, [], "x", 5, {}, { project: "web" }, { ...ask(), extra: CANARY }, { company: 5 }, { company: null }];
    for (const body of bad) {
      const answer = await call(w.opts, body);
      expect(answer).toEqual(INVALID);
      expect(JSON.stringify(answer)).not.toContain(CANARY);
    }
    expect(JSON.stringify(await call(w.opts, ask(`org_${CANARY}`)))).not.toContain(CANARY);
  });
  it("not JSON, or not declared JSON, is refused", async () => {
    const w = world();
    expect(await call(w.opts, undefined, { raw: Buffer.from("{\"company\"") })).toEqual(INVALID);
    expect(await call(w.opts, ask(), { headers: { "content-type": "text/plain" } })).toEqual(INVALID);
    expect((await call(w.opts, ask(), { headers: { "content-type": "application/json; charset=utf-8" } })).status).toBe(200);
  });
  it("over the body limit, read or declared, is 413; exactly at it is read", async () => {
    const w = world();
    expect(COMPANY_INSTRUCTIONS_BODY_MAX).toBe(4_096);
    expect(await call(w.opts, undefined, { raw: Buffer.from(`${JSON.stringify(ask())}${" ".repeat(COMPANY_INSTRUCTIONS_BODY_MAX)}`) })).toEqual(TOO_LARGE);
    expect(await call(w.opts, ask(), { headers: { "content-length": String(COMPANY_INSTRUCTIONS_BODY_MAX + 1) } })).toEqual(TOO_LARGE);
    expect((await call(w.opts, undefined, { raw: Buffer.from(JSON.stringify(ask()).padEnd(COMPANY_INSTRUCTIONS_BODY_MAX, " ")) })).status).toBe(200);
  });
});

describe("the token: the install's task key, this audience", () => {
  it("no token, a key header, a broken token, any other audience, issuer, key, lifetime or claim set: 401, nothing read", async () => {
    const w = world();
    await w.seed(A, [rule("x")]);
    expect(await call(w.opts, ask(), { token: undefined })).toEqual(UNSIGNED);
    expect(await call(w.opts, ask(), { headers: { "x-api-key": mint() } })).toEqual(UNSIGNED);
    expect(await call(w.opts, ask(), { headers: { authorization: `Basic ${mintToken()}` } })).toEqual(UNSIGNED);
    for (const token of [
      "x.y.z", mint(), mintToken({ aud: SERVICE_TOKEN_AUDIENCE }), mintToken({ aud: EVAL_AUTHORITY_AUDIENCE }), mintToken({ aud: EVAL_CAP_AUDIENCE }), mintToken({ aud: "rovara-model-gateway" }),
      mintToken({}, { typ: "rovara-task+jwt" }), mintToken({ iss: "https://install-b.example/v1/auth" }), mintToken({}, { kid: "AAAAAAAAAAAAAAAA" }),
      mintToken({ iat: secs - 600, nbf: secs - 630, exp: secs - 540 }), mintToken({ exp: secs + 3600 }), mintToken({ cid: "org_x" }), mintToken({ extra: 1 }), `${mintToken().slice(0, -4)}AAAA`,
    ]) expect(await call(w.opts, ask(), { token })).toEqual(UNSIGNED);
    expect(w.wire.calls.filter((c) => c.operation === "GetItem")).toHaveLength(0);
  });
  it("only a POST", async () => {
    expect((await call(world().opts, ask(), { method: "GET" })).status).toBe(405);
  });
});

describe("the HTTP handler", () => {
  class FakeResponse extends EventEmitter {
    statusCode = 0; headers: Record<string, string> = {}; chunks: Buffer[] = []; headersSent = false; destroyed = false;
    writeHead(status: number, headers: Record<string, string>) { this.statusCode = status; this.headers = headers; this.headersSent = true; return this; }
    end(bytes?: string) { if (bytes !== undefined) this.chunks.push(Buffer.from(bytes)); this.emit("close"); return this; }
    text() { return Buffer.concat(this.chunks).toString(); }
  }
  const send = async (handler: ReturnType<typeof createCompanyInstructionsHandler>, body: unknown) => {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: "POST", url: COMPANY_INSTRUCTIONS_PATH, headers: { "content-type": "application/json", authorization: `Bearer ${mintToken()}` } });
    const res = new FakeResponse();
    await handler(req as never, res as never);
    return res;
  };
  it("writes the answer as JSON, never cached", async () => {
    const w = world();
    await w.seed(A, [rule("x")]);
    const res = await send(createCompanyInstructionsHandler(w.opts), ask());
    expect(res.statusCode).toBe(200);
    expect(res.headers).toEqual({ "content-type": "application/json", "cache-control": "no-store" });
    expect(JSON.parse(res.text())).toEqual(ok([rule("x")]).body);
  });
  it("past the per-minute limit: 429, and nothing is read", async () => {
    let reads = 0;
    const handler = createCompanyInstructionsHandler({ verify: verify(), rules: { read: async () => { reads++; return undefined; } }, now: () => now });
    for (let i = 0; i < COMPANY_INSTRUCTIONS_PER_MINUTE; i++) expect((await send(handler, ask())).statusCode).toBe(200);
    expect((await send(handler, ask())).statusCode).toBe(429);
    expect(reads).toBe(COMPANY_INSTRUCTIONS_PER_MINUTE);
  });
});
