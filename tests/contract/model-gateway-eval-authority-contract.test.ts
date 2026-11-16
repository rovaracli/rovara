// DEC 253k contract: the gateway's POST /v1/product/eval/authority answers exactly what Rovara Code's `eval-reservation` HTTP adapter
// accepts. Code's request and answer schemas below are COPIED from PrepLabsAI/Rovara PR #805 (branch pr/eval-reservation-hook at
// 31144a4c3, packages/broker/src/core-host/eval-authority-http.ts and tests/unit/eval-authority-http.test.ts). If Code changes them, this
// test is the place to change first.
import { denyNetwork } from "../unit/model-gateway-no-network.js";
beforeAll(denyNetwork);
import { createHash, randomUUID, sign } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { PRODUCT_AI_APPROVER_PROVIDER } from "../../packages/cloud-server/src/product-ai-routes.js";
import { FixedCapsSource } from "../../packages/model-gateway/src/caps.js";
import { storedEvalApprovals } from "../../packages/model-gateway/src/eval-approvals.js";
import { answerEvalAuthority, EVAL_APPROVER_PROVIDER, EVAL_AUTHORITY_AUDIENCE, EVAL_AUTHORITY_PATH, EVAL_AUTHORITY_TOKEN_KIND } from "../../packages/model-gateway/src/eval-authority.js";
import { StaticInstallRegistry } from "../../packages/model-gateway/src/installs.js";
import { ProductEvalStages } from "../../packages/model-gateway/src/product-eval.js";
import { createSignedTokenVerifier } from "../../packages/model-gateway/src/token.js";
import { claims, jwk, keys, kid, now } from "../unit/model-gateway-fixture.js";
import { geminiKey, maintainer, productGateway, storeKit } from "../unit/model-gateway-product-fixture.js";

// ---- Code's contract (PR #805 at 31144a4c3) ------------------------------------------------------------------------------------
const CODE_PATH = "/v1/product/eval/authority";
const CODE_AUDIENCE = "rovara-model-gateway-eval-authority";
const CODE_SERVICE_TYP = "rovara-service+jwt";
const CODE_CLAIMS = ["iss", "aud", "jti", "iat", "nbf", "exp", "cid"];
const OrgIdSchema = z.string().regex(/^org_[0-9a-z]{20}$/);
const ProjectSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u);
const text = z.string().min(1).max(256);
const PrincipalAnswerSchema = z.object({
  companyId: OrgIdSchema, personId: text, displayName: z.string().max(256), roles: z.array(z.string().max(64)).max(32), provider: text,
  authTime: z.iso.datetime().optional(), methods: z.array(z.string().max(64)).max(16).optional(),
}).strict();
const AuthorityAnswerSchema = z.object({
  company: OrgIdSchema, project: ProjectSchema, principal: PrincipalAnswerSchema, provider: z.literal("customer"), connected: z.literal(true),
}).strict();
/** Code's acceptance after the schema: the same company, project and approver that were asked about. */
const codeAccepts = (asked: { company: string; project: string; approver: { personId: string; provider: string } }, body: unknown): boolean => {
  const parsed = AuthorityAnswerSchema.safeParse(body);
  if (!parsed.success) return false;
  const found = parsed.data;
  return found.company === asked.company && found.project === asked.project && found.principal.companyId === asked.company
    && found.principal.personId === asked.approver.personId && found.principal.provider === asked.approver.provider;
};
// Code's developerIdOf (packages/broker/src/core/sessions/create.ts at 31144a4c3): the id Cloud's settings route acts as, and so
// the approver id it stores (cloud-server product-ai-routes.ts, provider PRODUCT_AI_APPROVER_PROVIDER).
const developerIdOf = (p: { provider: string; personId: string }): string => createHash("sha256").update(`developer\u0000${p.provider}\u0000${p.personId}`, "utf8").digest("hex");
// Code's fixtures (eval-authority-http.test.ts): ORG_A, ORG_B, PROJECT and the APPROVER Principal, exactly.
const ORG_A = "org_evalauthority000000a";
const ORG_B = "org_evalauthority000000b";
const PROJECT = "demo";
const APPROVER = { personId: "person-1", provider: "rovara-sign-in" };
const ISS = claims.iss;
const secs = now / 1000;

/** Code's signServiceToken, as #805 makes it: header {alg, typ, kid}, claims in this order, 60 seconds, nbf 30 seconds back. */
function codeToken(company: string): string {
  const header = { alg: "RS256", typ: CODE_SERVICE_TYP, kid };
  const body = { iss: ISS, aud: CODE_AUDIENCE, jti: randomUUID(), iat: secs, nbf: secs - 30, exp: secs + 60, cid: company };
  expect(Object.keys(body)).toEqual(CODE_CLAIMS);
  const input = [header, body].map((v) => Buffer.from(JSON.stringify(v)).toString("base64url")).join(".");
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), keys.privateKey).toString("base64url")}`;
}
/** Code's request, byte for byte: JSON.stringify of {company, project, approver: {personId, provider}}, the three headers. */
const codeRequest = (company: string, project = PROJECT, approver = APPROVER) => ({
  method: "POST",
  headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${codeToken(company)}` },
  body: (async function* () { yield Buffer.from(JSON.stringify({ company, project, approver: { personId: approver.personId, provider: approver.provider } })); })(),
});

async function gateway() {
  const kit = storeKit();
  const stages = new ProductEvalStages({ approvals: storedEvalApprovals(kit.store, () => now), now: () => now });
  await productGateway({ evalStages: stages, kit, companyCaps: new FixedCapsSource({ task: 1e9, projectMonth: 1e9, companyMonth: 1e9 }) });
  for (const cid of [ORG_A, ORG_B]) {
    await kit.store.connect({ iss: ISS, cid, owner: PROJECT, requestId: randomUUID(), expectedRevision: 0, actor: maintainer, sourceId: "src_gem", provider: "gemini", key: geminiKey() });
    // As Cloud's settings route records it: acting as the approver's developer id, provider PRODUCT_AI_APPROVER_PROVIDER.
    await kit.store.setEvalApproval({ iss: ISS, cid, owner: PROJECT, requestId: randomUUID(), expectedRevision: 1, actor: { id: developerIdOf(APPROVER), role: "project_maintainer" }, approval: { selection: "evals/demo", inputsDigest: "a".repeat(64), maxCalls: 6, maxCostMicros: 60 }, provider: PRODUCT_AI_APPROVER_PROVIDER });
  }
  const verify = createSignedTokenVerifier({ registry: new StaticInstallRegistry([{ issuer: ISS, jwksUrl: `${ISS}/.well-known/jwks.json`, taskKids: [kid] }]), readJwks: async () => [jwk], now: () => now }, EVAL_AUTHORITY_TOKEN_KIND);
  return { verify, stages };
}

describe("the gateway's eval authority answers Code's adapter (PR #805)", () => {
  it("the same path and audience as Code, and the approver naming Cloud's settings route stores", () => {
    expect(EVAL_AUTHORITY_PATH).toBe(CODE_PATH);
    expect(EVAL_AUTHORITY_AUDIENCE).toBe(CODE_AUDIENCE);
    expect(EVAL_APPROVER_PROVIDER).toBe(PRODUCT_AI_APPROVER_PROVIDER);
    expect(developerIdOf(APPROVER)).toBe("a2389b50163f927aeb226bdce4345cf12e0bcbac45a00217909d2183b56ffa4d");
  });

  it("Code's exact request is answered with exactly the JSON Code accepts, pinned", async () => {
    const g = await gateway();
    const answer = await answerEvalAuthority(g, codeRequest(ORG_A));
    expect(answer.status).toBe(200);
    expect(JSON.stringify(answer.body)).toBe(JSON.stringify({
      company: ORG_A, project: PROJECT,
      principal: { companyId: ORG_A, personId: APPROVER.personId, displayName: "", roles: ["maintainer"], provider: APPROVER.provider },
      provider: "customer", connected: true,
    }));
    expect(codeAccepts({ company: ORG_A, project: PROJECT, approver: APPROVER }, answer.body)).toBe(true);
  });

  it("two companies: each answer is accepted only for the company it was asked for", async () => {
    const g = await gateway();
    const a = await answerEvalAuthority(g, codeRequest(ORG_A));
    const b = await answerEvalAuthority(g, codeRequest(ORG_B));
    expect(codeAccepts({ company: ORG_B, project: PROJECT, approver: APPROVER }, b.body)).toBe(true);
    expect(codeAccepts({ company: ORG_B, project: PROJECT, approver: APPROVER }, a.body)).toBe(false);
    expect(JSON.stringify(a.body)).not.toContain(ORG_B);
    expect(JSON.stringify(b.body)).not.toContain(ORG_A);
  });

  it("every refusal is a non-200 Code reads as spend not approved, and never a body Code would accept", async () => {
    const g = await gateway();
    const refusals = [
      await answerEvalAuthority(g, codeRequest(ORG_A, "other")),
      await answerEvalAuthority(g, codeRequest(ORG_A, PROJECT, { personId: "person-2", provider: APPROVER.provider })),
      await answerEvalAuthority(g, codeRequest(ORG_A, PROJECT, { personId: APPROVER.personId, provider: "other-sign-in" })),
      await answerEvalAuthority(g, codeRequest(ORG_A, PROJECT, { personId: developerIdOf(APPROVER), provider: PRODUCT_AI_APPROVER_PROVIDER })),
      await answerEvalAuthority(g, { ...codeRequest(ORG_A), headers: { ...codeRequest(ORG_A).headers, authorization: `Bearer ${codeToken(ORG_B)}` } }),
    ];
    for (const r of refusals) {
      expect(r.status).not.toBe(200);
      expect(AuthorityAnswerSchema.safeParse(r.body).success).toBe(false);
    }
  });
});
