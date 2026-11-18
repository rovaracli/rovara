// L4-HW3c contract: the gateway's POST /v1/service/company-instructions answers exactly what Rovara Code's `company-instructions` HTTP adapter accepts. Code's request and answer
// schemas below are COPIED from PrepLabsAI/Rovara branch pr/l4-company-instructions-hosted at b594d6166 (packages/broker/src/core-host/company-instructions-http.ts and
// packages/contracts/src/standing-instructions.ts). If Code changes them, this test is the place to change first. It also holds the rules Cloud's settings write to
// the shape the gateway reads, and the gateway's limits to Cloud's.
import { denyNetwork } from "../unit/model-gateway-no-network.js";
beforeAll(denyNetwork);
import { randomUUID, sign } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { COMPANY_SETTINGS_LIMITS, defaultCompanySettings, validateCompanySettings } from "../../packages/cloud-server/src/company-settings.js";
import { COMPANY_INSTRUCTIONS_AUDIENCE, COMPANY_INSTRUCTIONS_PATH, COMPANY_INSTRUCTIONS_TOKEN_KIND, COMPANY_INSTRUCTION_LIMITS, CompanyStoredInstructions, answerCompanyInstructions } from "../../packages/model-gateway/src/company-instructions.js";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { StaticInstallRegistry } from "../../packages/model-gateway/src/installs.js";
import { createSignedTokenVerifier } from "../../packages/model-gateway/src/token.js";
import { claims, jwk, keys, kid, now } from "../unit/model-gateway-fixture.js";
import { WireDynamo } from "../unit/model-gateway-wire-dynamo.js";

// ---- Code's contract (b594d6166) -----------------------------------------------------------------------------------------------
const CODE_PATH = "/v1/service/company-instructions";
const CODE_AUDIENCE = "rovara-model-gateway-company-instructions";
const CODE_SERVICE_TYP = "rovara-service+jwt";
const CODE_CLAIMS = ["iss", "aud", "jti", "iat", "nbf", "exp", "cid"];
const OrgIdSchema = z.string().regex(/^org_[0-9a-z]{20}$/);
const CompanyRuleSchema = z.object({ text: z.string().min(1), priority: z.enum(["required", "preferred"]) }).strict();
const AnswerSchema = z.object({ company: OrgIdSchema, version: z.string().min(1).max(64), rules: z.array(CompanyRuleSchema).max(1_000) }).strict();
// Code's COMPANY_RULE_LIMITS (packages/contracts/src/standing-instructions.ts).
const CODE_LIMITS = { maxRules: 30, maxRuleCharacters: 600, maxTotalCharacters: 12_000 };

const A = claims.cid;
const COMPANIES = "cloud-companies";
const secs = now / 1000;
function token(changes: Record<string, unknown> = {}): string {
  const body = { iss: claims.iss, aud: CODE_AUDIENCE, jti: randomUUID(), iat: secs, nbf: secs - 30, exp: secs + 60, cid: A, ...changes };
  const input = [JSON.stringify({ alg: "RS256", typ: CODE_SERVICE_TYP, kid }), JSON.stringify(body)].map((v) => Buffer.from(v).toString("base64url")).join(".");
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), keys.privateKey).toString("base64url")}`;
}
function world() {
  const wire = new WireDynamo([COMPANIES]);
  const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), transport: wire.transport });
  const verify = createSignedTokenVerifier({ registry: new StaticInstallRegistry([{ issuer: claims.iss, jwksUrl: `${claims.iss}/.well-known/jwks.json`, taskKids: [kid] }]), readJwks: async () => [jwk], now: () => now }, COMPANY_INSTRUCTIONS_TOKEN_KIND);
  return { db, opts: { verify, rules: new CompanyStoredInstructions(db, COMPANIES), now: () => now } };
}
const ask = (opts: ReturnType<typeof world>["opts"], body: unknown = { company: A }) => answerCompanyInstructions(opts, {
  method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token()}` }, body: (async function* () { yield Buffer.from(JSON.stringify(body)); })(),
});

describe("what Code sends and accepts", () => {
  it("the constants are Code's", () => {
    expect(COMPANY_INSTRUCTIONS_PATH).toBe(CODE_PATH);
    expect(COMPANY_INSTRUCTIONS_AUDIENCE).toBe(CODE_AUDIENCE);
    expect(COMPANY_INSTRUCTIONS_TOKEN_KIND.typ).toBe(CODE_SERVICE_TYP);
    expect(CODE_CLAIMS).toHaveLength(7);
  });
  it("a token with exactly Code's claims is accepted, and the answer parses as Code's AnswerSchema for the asked company", async () => {
    const w = world();
    const checked = validateCompanySettings({ ...defaultCompanySettings(), instructions: [{ text: "Never commit secrets.", priority: "required" }, { text: "Small pull requests.", priority: "preferred" }] });
    if (!checked.ok) throw new Error("fixture");
    await w.db.put(COMPANIES, { pk: `COMPANY#${A}`, sk: "SETTINGS", companyId: A, version: 6, settings: checked.settings as never });
    const answer = await ask(w.opts);
    expect(answer.status).toBe(200);
    const parsed = AnswerSchema.parse(answer.body);
    expect(parsed).toEqual({ company: A, version: "6", rules: checked.settings.instructions });
  });
  it("a company with no rules is a 200 whose answer parses as Code's AnswerSchema with an empty list (Code reads that as no rules)", async () => {
    const answer = await ask(world().opts);
    expect(answer.status).toBe(200);
    expect(AnswerSchema.parse(answer.body)).toEqual({ company: A, version: "0", rules: [] });
  });
  it("a request body that is not exactly {company} is refused (Code sends exactly that)", async () => {
    expect((await ask(world().opts, { company: A, project: "x" })).status).toBe(400);
  });
});

describe("Cloud's settings and the gateway agree", () => {
  it("the gateway's limits are Cloud's, and Code's", () => {
    expect(COMPANY_INSTRUCTION_LIMITS).toEqual({ max: COMPANY_SETTINGS_LIMITS.instructionsMax, chars: COMPANY_SETTINGS_LIMITS.instructionChars, totalChars: COMPANY_SETTINGS_LIMITS.instructionsTotalChars });
    expect(COMPANY_INSTRUCTION_LIMITS).toEqual({ max: CODE_LIMITS.maxRules, chars: CODE_LIMITS.maxRuleCharacters, totalChars: CODE_LIMITS.maxTotalCharacters });
  });
  it("whatever Cloud's validator accepts at its limits, the gateway reads (30 rules, 600 characters, 12,000 in all)", async () => {
    const w = world();
    const wide = validateCompanySettings({ ...defaultCompanySettings(), instructions: Array.from({ length: 20 }, () => ({ text: "w".repeat(600), priority: "required" })) });
    if (!wide.ok) throw new Error("fixture");
    await w.db.put(COMPANIES, { pk: `COMPANY#${A}`, sk: "SETTINGS", companyId: A, version: 1, settings: wide.settings as never });
    expect((await ask(w.opts)).status).toBe(200);
    const many = validateCompanySettings({ ...defaultCompanySettings(), instructions: Array.from({ length: 30 }, (_, i) => ({ text: `rule ${String(i)}`, priority: "preferred" })) });
    if (!many.ok) throw new Error("fixture");
    await w.db.put(COMPANIES, { pk: `COMPANY#${A}`, sk: "SETTINGS", companyId: A, version: 2, settings: many.settings as never });
    const answer = await ask(w.opts);
    expect(answer.status).toBe(200);
    expect((answer.body as { rules: unknown[] }).rules).toHaveLength(30);
  });
});
