// DEC 253k: the gateway answers Code's eval spend authority (POST /v1/product/eval/authority; Code PR #805's `eval-reservation` adapter).
// 200 only when the token's company is the body's, the project's stored approval counts now (fresh, not withdrawn) and names exactly
// this approver, the approver's role still allows it, and the project's own product key is connected. Every "no" is the same fixed 404
// (another company's existence never shows); a store that can't be read is 503. Two companies never meet.
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { randomUUID, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { beforeAll, describe, expect, it } from "vitest";
import { FixedCapsSource } from "../../packages/model-gateway/src/caps.js";
import { storedEvalApprovals, storedEvalBudget } from "../../packages/model-gateway/src/eval-approvals.js";
import {
  answerEvalAuthority, createEvalAuthorityHandler, EVAL_AUTHORITY_AUDIENCE, EVAL_AUTHORITY_BODY_MAX, EVAL_AUTHORITY_PATH, EVAL_AUTHORITY_PER_MINUTE, EVAL_AUTHORITY_TOKEN_KIND,
  type EvalAuthorityHandlerOptions,
} from "../../packages/model-gateway/src/eval-authority.js";
import { StaticInstallRegistry } from "../../packages/model-gateway/src/installs.js";
import { SERVICE_TOKEN_AUDIENCE } from "../../packages/model-gateway/src/offered-models.js";
import { EVAL_APPROVAL_FRESH_MS } from "../../packages/model-gateway/src/product-keys.js";
import { ProductEvalStages } from "../../packages/model-gateway/src/product-eval.js";
import { createSignedTokenVerifier } from "../../packages/model-gateway/src/token.js";
import { claims, jwk, keys, kid, mint, now } from "./model-gateway-fixture.js";
import { admin, geminiKey, maintainer, pid, productGateway, storeKit } from "./model-gateway-product-fixture.js";

const ISS = claims.iss;
const A = claims.cid;
const B = `org_${"b".repeat(20)}`;
const PROVIDER = "rovara-code";
const approval = { selection: "all-questions", inputsDigest: "d".repeat(64), maxCalls: 400, maxCostMicros: 4_000_000 };
const secs = now / 1000;

function mintAuthority(changes: Record<string, unknown> = {}, header: Record<string, unknown> = {}): string {
  const body = { iss: ISS, aud: EVAL_AUTHORITY_AUDIENCE, jti: randomUUID(), iat: secs, nbf: secs - 30, exp: secs + 60, cid: A, ...changes };
  const input = [JSON.stringify({ alg: "RS256", typ: "rovara-service+jwt", kid, ...header }), JSON.stringify(body)].map((v) => Buffer.from(v).toString("base64url")).join(".");
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), keys.privateKey).toString("base64url")}`;
}
const verify = (at: () => number = () => now) => createSignedTokenVerifier({ registry: new StaticInstallRegistry([{ issuer: ISS, jwksUrl: `${ISS}/.well-known/jwks.json`, taskKids: [kid] }]), readJwks: async () => [jwk], now: at }, EVAL_AUTHORITY_TOKEN_KIND);

/** A gateway whose product key store holds company A's connected key (and B's when asked) and an eval stage source over it. */
async function world(options: { connectA?: boolean; connectB?: boolean } = {}) {
  const clock = { at: now };
  const kit = storeKit({ clock: () => clock.at });
  const stages = new ProductEvalStages({ approvals: storedEvalApprovals(kit.store, () => clock.at), budget: storedEvalBudget(kit.store), now: () => clock.at });
  await productGateway({ evalStages: stages, kit, connect: options.connectA !== false, companyCaps: new FixedCapsSource({ task: 1e9, projectMonth: 1e9, companyMonth: 1e9 }) });
  if (options.connectB === true) await kit.store.connect({ iss: ISS, cid: B, owner: pid, requestId: randomUUID(), expectedRevision: 0, actor: maintainer, sourceId: "src_gem", provider: "gemini", key: geminiKey() });
  const approve = async (cid: string = A, actor = maintainer) => {
    const revision = (await kit.store.view(ISS, cid, pid)).revision;
    await kit.store.setEvalApproval({ iss: ISS, cid, owner: pid, requestId: randomUUID(), expectedRevision: revision, actor, approval, provider: PROVIDER });
  };
  const opts: EvalAuthorityHandlerOptions = { verify: verify(() => clock.at), stages, now: () => clock.at };
  return { clock, kit, stages, approve, opts };
}
const ask = (company: string = A, approver: Record<string, unknown> = { personId: maintainer.id, provider: PROVIDER }, project: string = pid) => ({ company, project, approver });
async function call(opts: EvalAuthorityHandlerOptions, body: unknown, o: { token?: string | undefined; headers?: Record<string, string>; method?: string; raw?: Buffer } = {}) {
  const bytes = o.raw ?? Buffer.from(JSON.stringify(body));
  const token = "token" in o ? o.token : mintAuthority();
  return answerEvalAuthority(opts, {
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
const approvedBody = (cid: string = A, role = "maintainer", personId = maintainer.id) => ({ company: cid, project: pid, principal: { companyId: cid, personId, displayName: "", roles: [role], provider: PROVIDER }, provider: "customer", connected: true });

describe("approved", () => {
  it("a fresh approval by this approver, with the role still allowed and the project's own key connected: 200, the exact answer", async () => {
    const w = await world();
    await w.approve();
    const answer = await call(w.opts, ask());
    expect(answer).toEqual({ status: 200, body: approvedBody() });
    expect(Object.keys(answer.body as object)).toEqual(["company", "project", "principal", "provider", "connected"]);
  });
  it("a company admin's approval answers the admin role", async () => {
    const w = await world();
    await w.approve(A, admin);
    expect(await call(w.opts, ask(A, { personId: admin.id, provider: PROVIDER }))).toEqual({ status: 200, body: approvedBody(A, "admin", admin.id) });
  });
  it("still counts one millisecond before 15 minutes", async () => {
    const w = await world();
    await w.approve();
    w.clock.at = now + EVAL_APPROVAL_FRESH_MS - 1;
    expect((await call(w.opts, ask(), { token: mintAuthority({ iat: Math.floor(w.clock.at / 1000), nbf: Math.floor(w.clock.at / 1000) - 30, exp: Math.floor(w.clock.at / 1000) + 60 }) })).status).toBe(200);
  });
});

describe("company isolation (two companies)", () => {
  it("company B's token asking about A: not found, though A is approved", async () => {
    const w = await world({ connectB: true });
    await w.approve(A);
    expect(await call(w.opts, ask(A), { token: mintAuthority({ cid: B }) })).toEqual(NOT_FOUND);
  });
  it("company A's token with B in the body: not found, though B is approved", async () => {
    const w = await world({ connectB: true });
    await w.approve(B);
    expect(await call(w.opts, ask(B))).toEqual(NOT_FOUND);
  });
  it("each company gets only its own answer; one with nothing gets the same not found as a company that does not exist", async () => {
    const w = await world({ connectB: true });
    await w.approve(B);
    expect(await call(w.opts, ask(B), { token: mintAuthority({ cid: B }) })).toEqual({ status: 200, body: approvedBody(B) });
    expect(await call(w.opts, ask(A))).toEqual(NOT_FOUND);
    expect(await call(w.opts, ask(`org_${"z".repeat(20)}`), { token: mintAuthority({ cid: `org_${"z".repeat(20)}` }) })).toEqual(NOT_FOUND);
  });
  it("another project of the same company: not found", async () => {
    const w = await world();
    await w.approve();
    expect(await call(w.opts, ask(A, undefined, "api"))).toEqual(NOT_FOUND);
  });
});

describe("every no is the same fixed 404", () => {
  it("no approval at all", async () => {
    const w = await world();
    expect(await call(w.opts, ask())).toEqual(NOT_FOUND);
  });
  it("a stale approval (15 minutes after the role check)", async () => {
    const w = await world();
    await w.approve();
    w.clock.at = now + EVAL_APPROVAL_FRESH_MS;
    const at = Math.floor(w.clock.at / 1000);
    expect(await call(w.opts, ask(), { token: mintAuthority({ iat: at, nbf: at - 30, exp: at + 60 }) })).toEqual(NOT_FOUND);
  });
  it("the project's own key not connected", async () => {
    const w = await world({ connectA: false });
    await w.approve();
    expect(await call(w.opts, ask())).toEqual(NOT_FOUND);
  });
  it("the key removed after the approval", async () => {
    const w = await world();
    await w.approve();
    const revision = (await w.kit.store.view(ISS, A, pid)).revision;
    await w.kit.store.remove({ iss: ISS, cid: A, owner: pid, requestId: randomUUID(), expectedRevision: revision, actor: maintainer, sourceId: "src_gem" });
    expect(await call(w.opts, ask())).toEqual(NOT_FOUND);
  });
  it("the approver's role revoked (Cloud withdrew their approvals)", async () => {
    const w = await world();
    await w.approve();
    w.clock.at = now + 1000;
    await w.kit.store.withdrawApprovals(ISS, A, maintainer.id);
    expect(await call(w.opts, ask())).toEqual(NOT_FOUND);
  });
  it("another approver than the one who approved: another person, or the same id at another identity provider", async () => {
    const w = await world();
    await w.approve();
    expect(await call(w.opts, ask(A, { personId: admin.id, provider: PROVIDER }))).toEqual(NOT_FOUND);
    expect(await call(w.opts, ask(A, { personId: maintainer.id, provider: "other-sign-in" }))).toEqual(NOT_FOUND);
  });
  it("a project the gateway could never store", async () => {
    const w = await world();
    await w.approve();
    for (const project of ["Web", "../web", "web/x", "x".repeat(64)]) expect(await call(w.opts, ask(A, undefined, project))).toEqual(NOT_FOUND);
  });
  it("a role the source answers that is not owner, admin or maintainer", async () => {
    const opts: EvalAuthorityHandlerOptions = { verify: verify(), stages: new ProductEvalStages({ approvals: { current: async () => ({ ...approval, approver: { personId: maintainer.id, provider: PROVIDER } }), roleOf: async () => "member" as never } }) };
    (opts.stages as ProductEvalStages).bind({ meter: {} as never, caps: {} as never, connected: async () => true, blocked: async () => false, block: async () => undefined });
    expect(await call(opts, ask())).toEqual(NOT_FOUND);
  });
  it("an approval that still counts, but whose approver no longer has a role (the re-read answers none)", async () => {
    const opts: EvalAuthorityHandlerOptions = { verify: verify(), stages: new ProductEvalStages({ approvals: { current: async () => ({ ...approval, approver: { personId: maintainer.id, provider: PROVIDER } }), roleOf: async () => undefined } }) };
    (opts.stages as ProductEvalStages).bind({ meter: {} as never, caps: {} as never, connected: async () => true, blocked: async () => false, block: async () => undefined });
    expect(await call(opts, ask())).toEqual(NOT_FOUND);
  });
  it("no refusal says anything about the company, project or person asked", async () => {
    const w = await world();
    await w.approve();
    w.clock.at = now + 1000;
    await w.kit.store.withdrawApprovals(ISS, A, maintainer.id);
    for (const answer of [await call(w.opts, ask()), await call(w.opts, ask(B)), await call(w.opts, ask(), { token: "x.y.z" }), await call(w.opts, { ...ask(), extra: 1 })]) {
      const text = JSON.stringify(answer.body);
      for (const secret of [A, B, pid, maintainer.id, PROVIDER, "rovara"]) if (secret !== "rovara" || answer.status !== 200) expect(text).not.toContain(secret);
    }
  });
});

describe("a store that can't be read: 503, never a guess", () => {
  it("the approval read fails", async () => {
    const w = await world();
    await w.approve();
    w.kit.table.get = async () => { throw new Error("dynamodb down: table gw-product-keys"); };
    expect(await call(w.opts, ask())).toEqual(UNAVAILABLE);
  });
  it("the key connection read fails", async () => {
    const opts: EvalAuthorityHandlerOptions = { verify: verify(), stages: new ProductEvalStages({ approvals: { current: async () => ({ ...approval, approver: { personId: maintainer.id, provider: PROVIDER } }), roleOf: async () => "maintainer" } }) };
    (opts.stages as ProductEvalStages).bind({ meter: {} as never, caps: {} as never, connected: async () => { throw new Error("kms down"); }, blocked: async () => false, block: async () => undefined });
    expect(await call(opts, ask())).toEqual(UNAVAILABLE);
  });
  it("the role read fails", async () => {
    const opts: EvalAuthorityHandlerOptions = { verify: verify(), stages: new ProductEvalStages({ approvals: { current: async () => ({ ...approval, approver: { personId: maintainer.id, provider: PROVIDER } }), roleOf: async () => { throw new Error("down"); } } }) };
    (opts.stages as ProductEvalStages).bind({ meter: {} as never, caps: {} as never, connected: async () => true, blocked: async () => false, block: async () => undefined });
    expect(await call(opts, ask())).toEqual(UNAVAILABLE);
  });
  it("an approval the source answers malformed", async () => {
    const opts: EvalAuthorityHandlerOptions = { verify: verify(), stages: new ProductEvalStages({ approvals: { current: async () => ({ ...approval, maxCalls: "400", approver: { personId: maintainer.id, provider: PROVIDER } }) as never, roleOf: async () => "maintainer" } }) };
    (opts.stages as ProductEvalStages).bind({ meter: {} as never, caps: {} as never, connected: async () => true, blocked: async () => false, block: async () => undefined });
    expect(await call(opts, ask())).toEqual(UNAVAILABLE);
  });
  it("eval stages not bound to a product route", async () => {
    const opts: EvalAuthorityHandlerOptions = { verify: verify(), stages: new ProductEvalStages({ approvals: { current: async () => undefined, roleOf: async () => undefined } }) };
    expect(await call(opts, ask())).toEqual(UNAVAILABLE);
  });
});

describe("the body: exactly the contract", () => {
  it("extra fields, at the top or in the approver, are refused", async () => {
    const w = await world();
    await w.approve();
    expect(await call(w.opts, { ...ask(), extra: true })).toEqual(INVALID);
    expect(await call(w.opts, { ...ask(), approver: { personId: maintainer.id, provider: PROVIDER, role: "owner" } })).toEqual(INVALID);
    expect(await call(w.opts, { ...ask(), payer: "rovara" })).toEqual(INVALID);
  });
  it("missing members and wrong types are refused", async () => {
    const w = await world();
    await w.approve();
    const bad: unknown[] = [null, [], "x", 5, { company: A, project: pid }, { company: A, approver: { personId: maintainer.id, provider: PROVIDER } },
      { company: 5, project: pid, approver: { personId: maintainer.id, provider: PROVIDER } }, { company: A, project: 5, approver: { personId: maintainer.id, provider: PROVIDER } },
      ask(A, { personId: "", provider: PROVIDER }), ask(A, { personId: maintainer.id, provider: "" }), ask(A, { personId: 5, provider: PROVIDER }), ask(A, { personId: maintainer.id }),
      ask(A, { personId: "p".repeat(257), provider: PROVIDER }), ask(A, { personId: maintainer.id, provider: "p".repeat(201) }), { company: A, project: pid, approver: "person" }, { company: A, project: pid, approver: null }];
    for (const body of bad) expect(await call(w.opts, body)).toEqual(INVALID);
  });
  it("not JSON, or not declared JSON, is refused", async () => {
    const w = await world();
    await w.approve();
    expect(await call(w.opts, undefined, { raw: Buffer.from("{\"company\"") })).toEqual(INVALID);
    expect(await call(w.opts, ask(), { headers: { "content-type": "text/plain" } })).toEqual(INVALID);
    expect((await call(w.opts, ask(), { headers: { "content-type": "application/json; charset=utf-8" } })).status).toBe(200);
  });
  it("oversize: over EVAL_AUTHORITY_BODY_MAX, read or declared, is 413", async () => {
    const w = await world();
    await w.approve();
    expect(EVAL_AUTHORITY_BODY_MAX).toBe(4_096);
    const padded = Buffer.from(`${JSON.stringify(ask())}${" ".repeat(EVAL_AUTHORITY_BODY_MAX)}`);
    expect(await call(w.opts, undefined, { raw: padded })).toEqual(TOO_LARGE);
    expect(await call(w.opts, ask(), { headers: { "content-length": String(EVAL_AUTHORITY_BODY_MAX + 1) } })).toEqual(TOO_LARGE);
    // Exactly at the limit is read (whitespace around a good body).
    const exact = Buffer.from(JSON.stringify(ask()).padEnd(EVAL_AUTHORITY_BODY_MAX, " "));
    expect((await call(w.opts, undefined, { raw: exact })).status).toBe(200);
  });
});

describe("the token: the install's task key, this audience, the asked company", () => {
  it("no token, a key header, a broken token, a task token, the offered-models audience, another issuer or key, an expired token: 401", async () => {
    const w = await world();
    await w.approve();
    expect(await call(w.opts, ask(), { token: undefined })).toEqual(UNSIGNED);
    expect(await call(w.opts, ask(), { headers: { "x-api-key": mint() } })).toEqual(UNSIGNED);
    expect(await call(w.opts, ask(), { headers: { authorization: `Basic ${mintAuthority()}` } })).toEqual(UNSIGNED);
    expect(await call(w.opts, ask(), { headers: { authorization: `Token: ${mintAuthority()}` } })).toEqual(UNSIGNED);
    for (const token of [
      "x.y.z", mint(), mintAuthority({ aud: SERVICE_TOKEN_AUDIENCE }), mintAuthority({ aud: "rovara-model-gateway" }), mintAuthority({}, { typ: "rovara-task+jwt" }),
      mintAuthority({ iss: "https://install-b.example/v1/auth" }), mintAuthority({}, { kid: "AAAAAAAAAAAAAAAA" }), mintAuthority({ iat: secs - 600, nbf: secs - 630, exp: secs - 540 }),
      mintAuthority({ exp: secs + 3600 }), mintAuthority({ cid: "org_x" }), mintAuthority({ extra: 1 }), `${mintAuthority().slice(0, -4)}AAAA`,
    ]) expect(await call(w.opts, ask(), { token })).toEqual(UNSIGNED);
  });
  it("only a POST", async () => {
    const w = await world();
    expect((await call(w.opts, ask(), { method: "GET" })).status).toBe(405);
  });
});

describe("the HTTP handler", () => {
  class FakeResponse extends EventEmitter {
    statusCode = 0; headers: Record<string, string> = {}; chunks: Buffer[] = []; headersSent = false; destroyed = false;
    writeHead(status: number, headers: Record<string, string>) { this.statusCode = status; this.headers = headers; this.headersSent = true; return this; }
    end(bytes?: string) { if (bytes !== undefined) this.chunks.push(Buffer.from(bytes)); this.emit("close"); return this; }
    text() { return Buffer.concat(this.chunks).toString(); }
  }
  const send = async (handler: ReturnType<typeof createEvalAuthorityHandler>, body: unknown) => {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: "POST", url: EVAL_AUTHORITY_PATH, headers: { "content-type": "application/json", authorization: `Bearer ${mintAuthority()}` } });
    const res = new FakeResponse();
    await handler(req as never, res as never);
    return res;
  };
  it("writes the answer as JSON, never cached", async () => {
    const w = await world();
    await w.approve();
    const res = await send(createEvalAuthorityHandler(w.opts), ask());
    expect(res.statusCode).toBe(200);
    expect(res.headers).toEqual({ "content-type": "application/json", "cache-control": "no-store" });
    expect(JSON.parse(res.text())).toEqual(approvedBody());
  });
  it("past the per-minute limit: 429, and nothing is read", async () => {
    let reads = 0;
    const stages = { authority: async () => { reads++; return { role: "maintainer" as const }; } };
    const handler = createEvalAuthorityHandler({ verify: verify(), stages, now: () => now });
    for (let i = 0; i < EVAL_AUTHORITY_PER_MINUTE; i++) expect((await send(handler, ask())).statusCode).toBe(200);
    const res = await send(handler, ask());
    expect(res.statusCode).toBe(429);
    expect(reads).toBe(EVAL_AUTHORITY_PER_MINUTE);
  });
});
