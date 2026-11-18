// DEC 254zzz41 (lane L4-GW6): the spending gateway's side of the reviewer-grant contract. A second review or a design review is one model call made
// with a short-lived (120 s) task token that carries a `reviewer` grant. The gateway pays it exactly as the task's main AI (the company's saved
// source), counts it inside the task's limit AND the company's cap before any provider call, and lets the grant be claimed once, durably.
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AgentAiSource, AgentAiSourceReader, RovaraAi } from "../../packages/model-gateway/src/agent-ai.js";
import type { Caps } from "../../packages/model-gateway/src/caps.js";
import { FixedCapsSource } from "../../packages/model-gateway/src/caps.js";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { StaticInstallRegistry } from "../../packages/model-gateway/src/installs.js";
import type { LearningKeySource } from "../../packages/model-gateway/src/learning-route.js";
import { InMemoryMeter } from "../../packages/model-gateway/src/meter.js";
import { consumeReviewerGrant, parseTaskClaims, REVIEWER_GRANT_SECONDS } from "../../packages/model-gateway/src/model-gateway-token.js";
import { DynamoPriceSnapshotStore } from "../../packages/model-gateway/src/dynamo-prices.js";
import { GATEWAY_ENV } from "../../packages/model-gateway/src/deploy.js";
import { GatewayConfigError, readGatewayConfig, startServe, type RunningGateway, type ServeConfig } from "../../packages/model-gateway/src/process.js";
import { answerOfferedModels, reviewerProviderOf, SERVICE_TOKEN_AUDIENCE, SERVICE_TOKEN_KIND, SERVICE_TOKEN_SECONDS, SERVICE_TOKEN_TYPE, type OfferedModelsHandlerOptions } from "../../packages/model-gateway/src/offered-models.js";
import type { ProviderRequest } from "../../packages/model-gateway/src/provider.js";
import { companyRoomMicros, DynamoReviewerGrants, InMemoryReviewerGrants, REVIEWER_GRANT_KEEP_SECONDS, type ReviewerGrantStore } from "../../packages/model-gateway/src/reviewer-grants.js";
import { agentRoute, REVIEWER_CEILING_REFUSED, type GatewayDependencies } from "../../packages/model-gateway/src/server.js";
import { createSignedTokenVerifier, createTaskTokenVerifier } from "../../packages/model-gateway/src/token.js";
import { answer, call, claims, jwk, keys, kid, mint, MemorySink, now, requestBody, scope, setup } from "./model-gateway-fixture.js";
import { companyPartition } from "../../packages/model-gateway/src/dynamo-meter.js";
import { sign } from "node:crypto";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";

const cidA = claims.cid;
const cidB = `org_${"b".repeat(20)}`;
const MODEL = claims.mdl[0]!;
const secs = now / 1000;
const keyOf = (cid: string) => `customer-key-${cid}`;
const AUTH = '{"error":{"type":"authentication_error","message":"invalid or expired model access"}}';

const grantClaims = (changes: Record<string, unknown> = {}) => ({
  jti: randomUUID(), exp: secs + REVIEWER_GRANT_SECONDS, stp: "second_review", mdl: [MODEL],
  reviewer: { kind: "second_review", slot: "second_review", ceilingUsd: 1 }, ...changes,
});
const grant = (changes: Record<string, unknown> = {}) => mint(grantClaims(changes));

class CompanyKeys implements LearningKeySource {
  readonly connectedTo = new Set<string>([cidA, cidB]);
  reads: string[] = [];
  async connected(_iss: string, cid: string): Promise<boolean> { return this.connectedTo.has(cid); }
  async keyFor(_iss: string, cid: string): Promise<string | undefined> { this.reads.push(cid); return keyOf(cid); }
}
class Choices implements AgentAiSourceReader {
  readonly saved = new Map<string, AgentAiSource>();
  async sourceFor(cid: string): Promise<AgentAiSource | undefined> { return this.saved.get(cid); }
}
/** Records every claim the gateway attempts, then answers like the in-memory store. */
function spyStore() { const inner = new InMemoryReviewerGrants(); const claimed: string[] = []; return { claimed, store: { claim: async (iss: string, cid: string, jti: string) => { claimed.push(jti); return inner.claim(iss, cid, jti); } } satisfies ReviewerGrantStore }; }
const mutableCaps = (initial: Caps) => { const current = { ...initial }; return { current, source: { capsFor: async () => ({ ...current }) } }; };

function gateway(options: { grants?: ReviewerGrantStore | false; caps?: Caps; overrides?: Partial<GatewayDependencies> } = {}) {
  const companyKeys = new CompanyKeys();
  const choices = new Choices();
  const keySent: ProviderRequest[] = [];
  const bedrockSent: ProviderRequest[] = [];
  const rovara: RovaraAi = { models: new Map([[MODEL, "us.anthropic.claude-sonnet-4-5-20250929-v1:0"]]), exempt: new Set(), transport: async (request) => { bedrockSent.push(request); return { status: 200, body: answer() }; } };
  const limits = mutableCaps(options.caps ?? { task: 1_000_000_000, personMonth: 1_000_000_000, projectMonth: 1_000_000_000, companyMonth: 1_000_000_000 });
  const grants = options.grants === false ? undefined : options.grants ?? new InMemoryReviewerGrants();
  const base = setup({
    agentKeys: companyKeys, agentAi: { sources: choices, rovara },
    caps: limits.source,
    keys: { keyFor: async () => "rovara-install-key" },
    transport: async (request) => { keySent.push(request); return { status: 200, body: answer() }; },
    ...(grants === undefined ? {} : { reviewerGrants: grants }),
    ...options.overrides,
  });
  return { ...base, companyKeys, choices, keySent, bedrockSent, limits, grants };
}
const refusal = (sink: MemorySink) => sink.text();
const rows = async (meter: InMemoryMeter, cid = cidA) => (await meter.read({ ...scope, cid })).map((row) => ({ item: row.item, spent: row.spentMicros, committed: row.committed }));
const committed = async (meter: InMemoryMeter, item: string, cid = cidA) => (await rows(meter, cid)).find((row) => row.item === item)!.committed;
const nothingHeld = async (meter: InMemoryMeter, cid = cidA) => { for (const row of await rows(meter, cid)) expect([row.spent, row.committed]).toEqual([0, 0]); };

describe("the reviewer claim in the task token", () => {
  it("is accepted exactly as Code's schema says, and a token without it is unchanged", async () => {
    expect(parseTaskClaims({ ...claims, ...grantClaims() })).toBeDefined();
    expect(parseTaskClaims({ ...claims })).toBeDefined();
    const verify = createTaskTokenVerifier({ registry: new StaticInstallRegistry([{ issuer: claims.iss, jwksUrl: `${claims.iss}/.well-known/jwks.json`, taskKids: [kid] }]), readJwks: async () => [jwk], now: () => now });
    expect((await verify(grant()))?.reviewer).toEqual({ kind: "second_review", slot: "second_review", ceilingUsd: 1 });
    const design = { stp: "design_review", reviewer: { kind: "design_review", slot: "design_a", ceilingUsd: 0.5 } };
    expect(parseTaskClaims({ ...claims, ...grantClaims(design) })).toBeDefined();
  });
  it.each([
    ["a step that is not its kind", { stp: "design_review" }],
    ["two models", { mdl: [MODEL, "claude-opus-5-5"] }],
    ["the ordinary 900 second life", { exp: secs + 900 }],
    ["a second review in another slot", { reviewer: { kind: "second_review", slot: "other", ceilingUsd: 1 } }],
    ["an unknown kind", { stp: "build", reviewer: { kind: "build", slot: "build", ceilingUsd: 1 } }],
    ["a ceiling of zero", { reviewer: { kind: "second_review", slot: "second_review", ceilingUsd: 0 } }],
    ["a ceiling that is not a number", { reviewer: { kind: "second_review", slot: "second_review", ceilingUsd: "1" } }],
    ["an extra member", { reviewer: { kind: "second_review", slot: "second_review", ceilingUsd: 1, extra: true } }],
    ["a non-object", { reviewer: "second_review" }],
  ])("is refused with %s", (_name, changes) => {
    expect(parseTaskClaims({ ...claims, ...grantClaims(changes as Record<string, unknown>) })).toBeUndefined();
  });
});

describe("consumeReviewerGrant", () => {
  const parsed = parseTaskClaims({ ...claims, ...grantClaims() })!;
  const expected = { cid: claims.cid, pid: claims.pid, tid: claims.tid, ws: claims.ws, op: claims.op, kind: "second_review" as const, slot: "second_review", model: MODEL };
  it("claims the jti once, with the grant's own expiry, when everything matches", async () => {
    const seen: Array<[string, number]> = [];
    expect(await consumeReviewerGrant(parsed, expected, secs + 1, async (jti, exp) => { seen.push([jti, exp]); return true; })).toBe(true);
    expect(seen).toEqual([[parsed.jti, parsed.exp]]);
  });
  it.each([
    ["company", { cid: cidB }], ["project", { pid: "other" }], ["task", { tid: "task_2" }], ["workspace", { ws: randomUUID() }], ["operation", { op: randomUUID() }],
    ["kind", { kind: "design_review" }], ["slot", { slot: "design_a" }], ["model", { model: "claude-opus-5-5" }],
  ])("refuses another %s without claiming anything", async (_name, changes) => {
    let claimed = 0;
    expect(await consumeReviewerGrant(parsed, { ...expected, ...changes } as typeof expected, secs + 1, async () => { claimed++; return true; })).toBe(false);
    expect(claimed).toBe(0);
  });
  it("refuses outside its lifetime, a claim that says no, and a claim that throws", async () => {
    const yes = async () => true;
    expect(await consumeReviewerGrant(parsed, expected, secs + REVIEWER_GRANT_SECONDS, yes)).toBe(false);
    expect(await consumeReviewerGrant(parsed, expected, secs - 1, yes)).toBe(false);
    expect(await consumeReviewerGrant(parsed, expected, secs + 1, async () => false)).toBe(false);
    expect(await consumeReviewerGrant(parsed, expected, secs + 1, async () => { throw new Error("store down"); })).toBe(false);
    // Not a grant at all.
    const { reviewer: _r, ...plain } = parsed; void _r;
    expect(await consumeReviewerGrant(plain as typeof parsed, expected, secs + 1, yes)).toBe(false);
  });
});

describe("(a) the same payer as the task's main AI", () => {
  it("a company on Rovara's AI: the review goes to Rovara's Bedrock like the main call; its key is never read", async () => {
    const g = gateway(); g.choices.saved.set(cidA, "rovara");
    expect((await call(g.deps)).status).toBe(200);
    const review = await call(g.deps, requestBody, grant());
    expect(review.status).toBe(200);
    expect(g.bedrockSent).toHaveLength(2);
    expect(g.bedrockSent[1]!.key).toMatch(/^rovara-ai-[0-9a-f-]{36}$/u);
    expect(g.bedrockSent[1]!.path).toBe(g.bedrockSent[0]!.path);
    expect(g.keySent).toEqual([]); expect(g.companyKeys.reads).toEqual([]);
  });
  it("a company on its own key: the review goes out on that company's key, never Rovara's AI or the install key", async () => {
    const g = gateway();
    expect((await call(g.deps, requestBody, grant())).status).toBe(200);
    expect(g.keySent.map((r) => r.key)).toEqual([keyOf(cidA)]);
    expect(g.bedrockSent).toEqual([]);
  });
  it("two companies: each company's review follows that company's own source, whatever payer the token names", async () => {
    const g = gateway(); g.choices.saved.set(cidA, "rovara");
    const payers = [{ kind: "member", developerId: "a".repeat(64) }, { kind: "project", project: "web" }, { kind: "agent", agentId: "rovara-code" }];
    for (const pay of payers) {
      expect((await call(g.deps, requestBody, grant({ pay }))).status).toBe(200);
      expect((await call(g.deps, requestBody, grant({ pay, cid: cidB }))).status).toBe(200);
    }
    expect(g.bedrockSent).toHaveLength(3);
    expect(g.keySent.map((r) => r.key)).toEqual([keyOf(cidB), keyOf(cidB), keyOf(cidB)]);
    g.companyKeys.connectedTo.delete(cidB);
    const refused = await call(g.deps, requestBody, grant({ cid: cidB }));
    expect(refused.status).toBe(403);
    expect(g.keySent).toHaveLength(3);
  });
  it("counts in the same task row and company row as the main call (one task, one company)", async () => {
    const g = gateway();
    await call(g.deps);
    const before = [await committed(g.meter, "task"), await committed(g.meter, "company")];
    await call(g.deps, requestBody, grant());
    expect(await committed(g.meter, "task")).toBeGreaterThan(before[0]!);
    expect(await committed(g.meter, "company")).toBe(await committed(g.meter, "task"));
  });
});

describe("(b) inside the task's dollar limit and the company's cap", () => {
  it("refused, spending nothing, when the task limit is reached", async () => {
    const g = gateway({ caps: { task: 1, projectMonth: 1_000_000_000, companyMonth: 1_000_000_000 } });
    const sink = await call(g.deps, requestBody, grant());
    expect(sink.status).toBe(422);
    expect(g.keySent).toEqual([]);
    await nothingHeld(g.meter);
  });
  it("refused, spending nothing, when the company cap is reached", async () => {
    const g = gateway({ caps: { task: 1_000_000_000, projectMonth: 1_000_000_000, companyMonth: 1 } });
    const sink = await call(g.deps, requestBody, grant());
    expect(sink.status).toBe(422);
    expect(g.keySent).toEqual([]);
    await nothingHeld(g.meter);
  });
  it("the main AI's own spend counts: once it used the room, the review is refused at either limit", async () => {
    const g = gateway();
    expect((await call(g.deps)).status).toBe(200);
    const spent = await committed(g.meter, "task");
    expect(spent).toBeGreaterThan(0);
    for (const caps of [{ task: spent, projectMonth: 1e12, companyMonth: 1e12 }, { task: 1e12, projectMonth: 1e12, companyMonth: spent }]) {
      Object.assign(g.limits.current, caps);
      const sink = await call(g.deps, requestBody, grant());
      expect(sink.status).toBe(422);
    }
    expect(g.keySent).toHaveLength(1);
    expect(await committed(g.meter, "task")).toBe(spent);
  });
  it("a refusal for a cap burns nothing: with room again, the same grant works once", async () => {
    const g = gateway({ caps: { task: 1, projectMonth: 1e12, companyMonth: 1e12 } });
    const token = grant();
    expect((await call(g.deps, requestBody, token)).status).toBe(422);
    Object.assign(g.limits.current, { task: 1e12 });
    expect((await call(g.deps, requestBody, token)).status).toBe(200);
    expect((await call(g.deps, requestBody, token)).status).toBe(401);
    expect(g.keySent).toHaveLength(1);
  });
  it("refused before any hold when the call's worst case is above the grant's own ceiling", async () => {
    const spy = spyStore();
    const g = gateway({ grants: spy.store });
    const sink = await call(g.deps, requestBody, grant({ reviewer: { kind: "second_review", slot: "second_review", ceilingUsd: 0.000001 } }));
    expect(sink.status).toBe(REVIEWER_CEILING_REFUSED.status);
    expect(JSON.parse(sink.text())).toEqual({ error: { type: "budget_exceeded", message: REVIEWER_CEILING_REFUSED.message } });
    expect(g.keySent).toEqual([]);
    await nothingHeld(g.meter);
    // Nothing was claimed either.
    expect(spy.claimed).toEqual([]);
  });
  it("refused when the price is only an estimate (the hold would not be exact)", async () => {
    const g = gateway({ overrides: { prices: { priceFor: () => ({ inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000, estimated: true, operatorReview: false }) as never } } });
    const sink = await call(g.deps, requestBody, grant());
    expect(sink.status).toBe(422);
    expect(g.keySent).toEqual([]);
  });
});

describe("(c) short-lived, one task, one kind, single use", () => {
  it("a replay is refused: the provider is called once", async () => {
    const g = gateway();
    const token = grant();
    expect((await call(g.deps, requestBody, token)).status).toBe(200);
    const again = await call(g.deps, requestBody, token);
    expect(again.status).toBe(401);
    expect(refusal(again)).toBe(AUTH);
    expect(g.keySent).toHaveLength(1);
  });
  it("two simultaneous uses of one grant: exactly one is sent, the other holds and spends nothing", async () => {
    const g = gateway();
    const token = grant();
    const sinks = await Promise.all([call(g.deps, requestBody, token), call(g.deps, requestBody, token)]);
    expect(sinks.map((s) => s.status).sort()).toEqual([200, 401]);
    expect(g.keySent).toHaveLength(1);
    const company = (await g.meter.read(scope)).find((r) => r.item === "company")!;
    expect(company.reservedMicros).toBe(0);
  });
  it("a grant used just after its 120 seconds is refused even though the signature check still allows its 30 second skew", async () => {
    const late = (secs + REVIEWER_GRANT_SECONDS + 10) * 1000;
    const verifyLate = createTaskTokenVerifier({ registry: new StaticInstallRegistry([{ issuer: claims.iss, jwksUrl: `${claims.iss}/.well-known/jwks.json`, taskKids: [kid] }]), readJwks: async () => [jwk], now: () => late });
    const g = gateway({ overrides: { verifyToken: verifyLate, now: () => late } });
    const token = grant();
    expect(await verifyLate(token)).toBeDefined();
    const sink = await call(g.deps, requestBody, token);
    expect(sink.status).toBe(401);
    expect(g.keySent).toEqual([]);
    await nothingHeld(g.meter);
  });
  it("the request's own model must be the grant's one model (another model is refused before any hold)", async () => {
    const spy = spyStore();
    const g = gateway({ grants: spy.store });
    const sink = await call(g.deps, { ...requestBody, model: "claude-opus-5-5" }, grant());
    expect(sink.status).toBe(400);
    expect(spy.claimed).toEqual([]);
    expect(g.keySent).toEqual([]);
    await nothingHeld(g.meter);
  });
  it("a grant is refused where it may not spend: install-key mode, and any route that is not the company-key agent route", async () => {
    const install = setup({ reviewerGrants: new InMemoryReviewerGrants() });
    expect((await call(install.deps, requestBody, grant())).status).toBe(401);
    expect(install.calls).toEqual([]);
    // A product-route lookalike: the same agent route object served under the product prefix is still not a grant route.
    const g = gateway();
    const { agentKeys: _keys, agentAi: _ai, ...installDeps } = g.deps; void _keys; void _ai;
    const productLike = { ...agentRoute(installDeps), product: true as const };
    const deps: GatewayDependencies = { ...g.deps, product: { route: () => productLike } };
    const sink = new MemorySink();
    const { handleGateway } = await import("../../packages/model-gateway/src/server.js");
    await handleGateway(deps, { method: "POST", url: "/v1/product/anything", headers: { "content-type": "application/json", "x-api-key": grant() }, body: (async function* () { yield Buffer.from(JSON.stringify(requestBody)); })() }, sink);
    expect(sink.status).toBe(401);
    expect(g.keySent).toEqual([]);
    await nothingHeld(g.meter);
  });
  it("REVIEW-1 M1: refused (nothing held, nothing claimed) on a source that reports its own cost, on a partly derived or uncertain price, and on unbounded input", async () => {
    const spy = spyStore();
    const g = gateway({ grants: spy.store });
    g.choices.saved.set(cidA, "openrouter_key");
    const sentRouter: ProviderRequest[] = [];
    g.deps.agentAi = { ...g.deps.agentAi!, switchedOn: new Set(["openrouter"]), openrouter: { transport: async (request) => { sentRouter.push(request); return { status: 200, body: answer() }; } } };
    expect((await call(g.deps, requestBody, grant())).status).toBe(422);
    g.choices.saved.delete(cidA);
    const priced = (extra: Record<string, unknown>) => ({ priceFor: () => ({ inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000, ...extra }) as never });
    for (const extra of [{ derived: [{ aboveTokens: 0, keys: ["outputMicrosPerMTok"] }] }, { uncertain: [{ aboveTokens: 0, keys: ["outputMicrosPerMTok"] }] }, { operatorReview: true }]) {
      g.deps.prices = priced(extra);
      expect((await call(g.deps, requestBody, grant())).status).toBe(422);
    }
    g.deps.prices = priced({});
    const cached = { ...requestBody, messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }] };
    expect((await call(g.deps, cached, grant())).status).toBe(422);
    expect(spy.claimed).toEqual([]);
    expect([g.keySent, sentRouter]).toEqual([[], []]);
    await nothingHeld(g.meter);
    expect((await call(g.deps, requestBody, grant())).status).toBe(200);
  });
  it("a grant for an ended task is refused before anything is held or claimed", async () => {
    const spy = spyStore();
    const g = gateway({ grants: spy.store });
    g.ended.end(claims.iss, cidA, claims.tid);
    const sink = await call(g.deps, requestBody, grant());
    expect(sink.status).toBe(403);
    expect(spy.claimed).toEqual([]);
    expect(g.keySent).toEqual([]);
    await nothingHeld(g.meter);
  });
  it("a gateway with no grant store refuses grants; an ordinary token still works (old Code keeps working)", async () => {
    const g = gateway({ grants: false });
    expect((await call(g.deps, requestBody, grant())).status).toBe(401);
    expect(g.keySent).toEqual([]);
    expect((await call(g.deps)).status).toBe(200);
    expect(g.keySent).toHaveLength(1);
  });
  it("an unavailable store is a refusal: nothing sent, nothing held, no detail echoed", async () => {
    const down: ReviewerGrantStore = { claim: async () => { throw new Error("store down secret-detail"); } };
    const g = gateway({ grants: down });
    const sink = await call(g.deps, requestBody, grant());
    expect(sink.status).toBe(401);
    expect(sink.text()).toBe(AUTH);
    expect(g.keySent).toEqual([]);
    await nothingHeld(g.meter);
  });
  it("a store that answers 'not claimed' is a refusal", async () => {
    const g = gateway({ grants: { claim: async () => false } });
    expect((await call(g.deps, requestBody, grant())).status).toBe(401);
    expect(g.keySent).toEqual([]);
    await nothingHeld(g.meter);
  });
});

describe("the durable single-use claim (markers table)", () => {
  const TABLES = ["gw-markers"];
  const credentials = async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" });
  const make = (wire: WireDynamo, at = now) => new DynamoReviewerGrants(new Dynamo({ region: "us-west-2", credentials, transport: wire.transport }), "gw-markers", () => at);
  const jti = randomUUID();
  it("a gateway restart (a new process on the same table) still refuses the replay", async () => {
    const wire = new WireDynamo(TABLES);
    const before = gateway({ grants: make(wire) });
    const token = grant({ jti });
    expect((await call(before.deps, requestBody, token)).status).toBe(200);
    const after = gateway({ grants: make(wire) });
    expect((await call(after.deps, requestBody, token)).status).toBe(401);
    expect(after.keySent).toEqual([]);
  });
  it("is one conditional put under the company's own key, expiring after the grant, with no other write", async () => {
    const wire = new WireDynamo(TABLES);
    expect(await make(wire).claim(claims.iss, cidA, jti, secs + REVIEWER_GRANT_SECONDS)).toBe(true);
    expect(wire.items("gw-markers")).toEqual([{ pk: companyPartition(claims.iss, cidA), sk: `REVGRANT#${jti}`, claimedAt: secs, expiresAt: secs + REVIEWER_GRANT_SECONDS + REVIEWER_GRANT_KEEP_SECONDS }]);
    expect(wire.calls.map((c) => [c.operation, c.table])).toEqual([["PutItem", "gw-markers"]]);
    for (const c of wire.calls) for (const k of c.keys) expect(k.pk.startsWith("CO#")).toBe(true);
    expect(String((wire.calls[0]!.input as { ConditionExpression?: string }).ConditionExpression)).toContain("attribute_not_exists");
    expect(await make(wire).claim(claims.iss, cidA, jti, secs + REVIEWER_GRANT_SECONDS)).toBe(false);
  });
  it("two companies: one company's claim never blocks or reveals another's", async () => {
    const wire = new WireDynamo(TABLES);
    expect(await make(wire).claim(claims.iss, cidA, jti, secs + 120)).toBe(true);
    expect(await make(wire).claim(claims.iss, cidB, jti, secs + 120)).toBe(true);
    expect(await make(wire).claim(claims.iss, cidA, jti, secs + 120)).toBe(false);
    expect(await make(wire).claim(claims.iss, cidB, jti, secs + 120)).toBe(false);
    expect(await make(wire).claim("https://install-b.example/v1/auth", cidA, jti, secs + 120)).toBe(true);
  });
  it("a store error is a refusal that sends nothing; a lost answer after the write leaves the grant claimed", async () => {
    const wire = new WireDynamo(TABLES);
    wire.fault((c) => c.operation === "PutItem", { kind: "error", status: 500, type: "InternalServerError" });
    const a = gateway({ grants: make(wire) });
    const token = grant({ jti });
    expect((await call(a.deps, requestBody, token)).status).toBe(401);
    expect(a.keySent).toEqual([]);
    await nothingHeld(a.meter);
    wire.fault((c) => c.operation === "PutItem", { kind: "lost-after-apply" });
    expect((await call(a.deps, requestBody, token)).status).toBe(401);
    expect((await call(a.deps, requestBody, token)).status).toBe(401);
    expect(a.keySent).toEqual([]);
  });
  it("refuses a malformed company, id or expiry before any write", async () => {
    const wire = new WireDynamo(TABLES);
    await expect(make(wire).claim("https://i.example", "org_x", jti, secs)).rejects.toThrow();
    await expect(make(wire).claim("https://i.example", cidA, "not-a-uuid", secs)).rejects.toThrow();
    await expect(make(wire).claim("https://i.example", cidA, jti, 0)).rejects.toThrow();
    expect(wire.calls).toEqual([]);
  });
});

describe("the room a review may take (company cap)", () => {
  it("is the company cap less what the company's holds and spend already took (all routes' rows), read for that company only", async () => {
    const meter = new InMemoryMeter(() => now);
    const caps = new FixedCapsSource({ task: 1e12, projectMonth: 1e12, companyMonth: 5_000 });
    expect(await companyRoomMicros(caps, meter, claims.iss, cidA)).toBe(5_000);
    const held = await meter.reserve({ scope, caps: { task: 1e12, projectMonth: 1e12, companyMonth: 5_000 }, estimateMicros: 1_200 });
    expect(held.ok).toBe(true);
    expect(await companyRoomMicros(caps, meter, claims.iss, cidA)).toBe(3_800);
    expect(await companyRoomMicros(caps, meter, claims.iss, cidB)).toBe(5_000);
  });
  it("is nothing when no company cap can be read", async () => {
    const meter = new InMemoryMeter(() => now);
    expect(await companyRoomMicros({ capsFor: async () => ({}) as Caps }, meter, claims.iss, cidA)).toBeUndefined();
  });
});

describe("reviewerAccess on the offered-models answer, from the company's real connections", () => {
  const sp = (changes: Record<string, unknown> = {}) => {
    const body = { iss: claims.iss, aud: SERVICE_TOKEN_AUDIENCE, jti: randomUUID(), iat: secs, nbf: secs - 30, exp: secs + SERVICE_TOKEN_SECONDS, cid: cidA, ...changes };
    const input = [JSON.stringify({ alg: "RS256", typ: SERVICE_TOKEN_TYPE, kid }), JSON.stringify(body)].map((v) => Buffer.from(v).toString("base64url")).join(".");
    return `${input}.${sign("RSA-SHA256", Buffer.from(input), keys.privateKey).toString("base64url")}`;
  };
  const verify = createSignedTokenVerifier({ registry: new StaticInstallRegistry([{ issuer: claims.iss, jwksUrl: `${claims.iss}/.well-known/jwks.json`, taskKids: [kid] }]), readJwks: async () => [jwk], now: () => now }, SERVICE_TOKEN_KIND);
  const RESOLVED = new Map([["claude-haiku-4-5", "us.anthropic.claude-haiku-4-5-20251001-v1:0"], ["qwen.qwen3-coder-30b-a3b-v1:0", "qwen.qwen3-coder-30b-a3b-v1:0"], ["moonshotai.kimi-k2.5", "moonshotai.kimi-k2.5"], ["us.amazon.nova-pro-v1:0", "us.amazon.nova-pro-v1:0"]]);
  function opts(extra: Partial<OfferedModelsHandlerOptions> = {}, connected: string[] = [cidA, cidB], limit: number | null = 5_000_000) {
    const choices = new Choices(); choices.saved.set(cidA, "rovara"); choices.saved.set(cidB, "anthropic_key");
    const keyAsks: string[] = [];
    const o: OfferedModelsHandlerOptions = { verify, sources: choices, rovara: { models: RESOLVED }, disabled: new Set(), now: () => now,
      reviewer: { keys: { connected: async (_i, cid, provider) => { keyAsks.push(`${cid}:${provider}`); return connected.includes(cid); } }, companyLimitMicros: async () => limit ?? undefined }, ...extra };
    return { o, choices, keyAsks };
  }
  const ask = (o: OfferedModelsHandlerOptions, cid: string) => answerOfferedModels(o, { method: "GET", url: `/v1/service/companies/${cid}/offered-models`, headers: { authorization: `Bearer ${sp({ cid })}` } });
  it("Rovara's AI: each model with its vendor, and the company's room in dollars", async () => {
    const { o } = opts();
    const r = await ask(o, cidA);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ version: 1, models: [...RESOLVED.keys()].map((model) => ({ model })), reviewerAccess: { companyId: cidA, companyLimitUsd: 5, models: [
      { model: "claude-haiku-4-5", provider: "anthropic" }, { model: "qwen.qwen3-coder-30b-a3b-v1:0", provider: "qwen" }, { model: "moonshotai.kimi-k2.5", provider: "moonshot" }, { model: "us.amazon.nova-pro-v1:0", provider: "amazon" } ] } });
  });
  it("own Anthropic key: one provider, only while that key is connected now", async () => {
    const { o, keyAsks } = opts();
    const r = await ask(o, cidB);
    expect((r.body as { reviewerAccess: { models: Array<{ provider: string }> } }).reviewerAccess.models.every((m) => m.provider === "anthropic")).toBe(true);
    expect(keyAsks).toContain(`${cidB}:anthropic`);
    const off = opts({}, [cidA]);
    const gone = await ask(off.o, cidB);
    expect(gone.status).toBe(200);
    expect((gone.body as Record<string, unknown>).reviewerAccess).toBeUndefined();
  });
  it("no limit, a limit of zero, a failed read or no reviewer setup: the answer carries no reviewerAccess, and without setup is byte-identical to before", async () => {
    for (const limit of [null, 0]) expect((await ask(opts({}, undefined, limit).o, cidA)).body).not.toHaveProperty("reviewerAccess");
    const failing = opts({ reviewer: { keys: { connected: async () => { throw new Error("down"); } }, companyLimitMicros: async () => 5_000_000 } });
    failing.choices.saved.set(cidA, "anthropic_key");
    expect((await ask(failing.o, cidA)).body).not.toHaveProperty("reviewerAccess");
    const plain = opts(); delete (plain.o as { reviewer?: unknown }).reviewer;
    expect((await ask(plain.o, cidA)).body).toEqual({ version: 1, models: [...RESOLVED.keys()].map((model) => ({ model })) });
  });
  it("two companies: each answer names only its own company, with its own source's providers", async () => {
    const { o } = opts();
    const a = (await ask(o, cidA)).body as { reviewerAccess: { companyId: string } }; const b = (await ask(o, cidB)).body as { reviewerAccess: { companyId: string } };
    expect([a.reviewerAccess.companyId, b.reviewerAccess.companyId]).toEqual([cidA, cidB]);
  });
  it("names a provider for every source, one connection one provider", () => {
    expect(reviewerProviderOf("openai_key", "gpt-5")).toBe("openai");
    expect(reviewerProviderOf("bedrock_byo", "claude-sonnet-5-5")).toBe("bedrock");
    expect(reviewerProviderOf("custom_endpoint", "my-model")).toBe("endpoint");
    expect(reviewerProviderOf(undefined, "claude-sonnet-5-5")).toBe("anthropic");
    expect(reviewerProviderOf("rovara", "mistral.devstral-2-123b")).toBe("mistral");
    expect(reviewerProviderOf("rovara", "us.moonshotai.kimi-k3")).toBe("moonshot");
  });
});

class FakeResponse extends EventEmitter {
  statusCode = 0; headers: Record<string, string> = {}; chunks: Buffer[] = []; headersSent = false; destroyed = false;
  writeHead(status: number, headers: Record<string, string>) { this.statusCode = status; this.headers = headers; this.headersSent = true; return this; }
  text() { return Buffer.concat(this.chunks).toString(); }
  write(bytes: Uint8Array) { this.chunks.push(Buffer.from(bytes)); return true; }
  end(bytes?: Uint8Array | string) { if (bytes !== undefined) this.chunks.push(Buffer.from(bytes)); this.emit("finish"); this.emit("close"); return this; }
  destroy() { this.destroyed = true; this.emit("close"); return this; }
}
const running: RunningGateway[] = [];
afterEach(async () => { for (const gateway of running.splice(0)) await gateway.drain(); });

describe("the deployed process wires the durable store", () => {
  const T = { meter: "gw-meter", ledger: "gw-ledger", markers: "gw-markers", prices: "gw-prices", companies: "cloud-companies" };
  const ENV = {
    [GATEWAY_ENV.mode]: "serve", AWS_REGION: "us-west-2", [GATEWAY_ENV.port]: "8080",
    [GATEWAY_ENV.installIssuer]: claims.iss, [GATEWAY_ENV.installJwksUrl]: `${claims.iss}/.well-known/jwks.json`, [GATEWAY_ENV.installTaskKids]: kid,
    [GATEWAY_ENV.meterTable]: T.meter, [GATEWAY_ENV.ledgerTable]: T.ledger, [GATEWAY_ENV.markersTable]: T.markers, [GATEWAY_ENV.pricesTable]: T.prices, [GATEWAY_ENV.companyTable]: T.companies,
    [GATEWAY_ENV.anthropicKeySecret]: "arn:aws:secretsmanager:us-west-2:944937319445:secret:rovara-cloud/staging/model-gateway/provider/anthropic-AbCdEf",
  };
  async function serve(wire: WireDynamo, mode: "company" | "install", sent: ProviderRequest[]) {
    const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), transport: wire.transport });
    await db.put(T.companies, { pk: `COMPANY#${cidA}`, sk: "SETTINGS", companyId: cidA, version: 1, settings: { budgets: { companyMonthlyUsdMicros: 500_000_000, memberMonthlyUsdMicros: null, projectMonthlyUsdMicros: null, taskUsdMicros: null } } });
    // One exact price row, so a review (which needs an exact price) is admitted; the deployed price source reads this table.
    await new DynamoPriceSnapshotStore(db, T.prices).save({ version: 1, sources: { litellm: { fetchedAt: now, count: 1, entries: [{ provider: "anthropic", model: MODEL, kind: "chat", inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000, cacheReadMicrosPerMTok: 300_000, cacheWrite5mMicrosPerMTok: 3_750_000, cacheWrite1hMicrosPerMTok: 6_000_000 }] } } } as never, 0);
    const config: ServeConfig = { ...(readGatewayConfig(ENV) as ServeConfig), port: 0, ...(mode === "company" ? { agentKeys: "company" as const } : {}) };
    const gateway = await startServe(config, {
      db, fetch: async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }), now: () => now, listen: false, log: () => undefined,
      keys: { keyFor: async () => "rovara-install-key" }, transport: async (request) => { sent.push(request); return { status: 200, body: answer() }; },
      ...(mode === "company" ? { agentKeys: new CompanyKeys() } : {}),
    });
    running.push(gateway);
    return gateway;
  }
  function post(server: RunningGateway["server"], token: string): Promise<FakeResponse> {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(requestBody))]), { method: "POST", url: "/v1/messages", headers: { "content-type": "application/json", "x-api-key": token } });
    const res = new FakeResponse();
    const done = new Promise<FakeResponse>((resolve) => res.once("close", () => resolve(res)));
    server.emit("request", req, res);
    return done;
  }
  it("company-key mode: a grant is served once and a restarted process (same tables) refuses it; the claim is in the markers table", async () => {
    const wire = new WireDynamo(Object.values(T), { namespaceTables: true });
    const sent: ProviderRequest[] = [];
    const token = grant();
    const first = await post((await serve(wire, "company", sent)).server, token);
    expect([first.statusCode, first.text()]).toEqual([200, expect.any(String)]);
    const items = wire.items(T.markers).filter((item) => String(item.sk).startsWith("REVGRANT#"));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ pk: companyPartition(claims.iss, cidA), expiresAt: secs + REVIEWER_GRANT_SECONDS + REVIEWER_GRANT_KEEP_SECONDS });
    expect((await post((await serve(wire, "company", sent)).server, token)).statusCode).toBe(401);
    expect(sent).toHaveLength(1);
  });
  it("install-key mode builds no grant store: a grant is refused and an ordinary token still works", async () => {
    const wire = new WireDynamo(Object.values(T), { namespaceTables: true });
    const sent: ProviderRequest[] = [];
    const gateway = await serve(wire, "install", sent);
    expect((await post(gateway.server, grant())).statusCode).toBe(401);
    expect(sent).toEqual([]);
    expect((await post(gateway.server, mint())).statusCode).toBe(200);
  });
  it("keeps the config reader unchanged (no new setting)", () => { expect(() => readGatewayConfig(ENV)).not.toThrow(GatewayConfigError); });
});
