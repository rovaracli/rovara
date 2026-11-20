import { beforeAll, expect, it, vi } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { claims, now, setup, call, mint, requestBody, scope, answer, caps } from "./model-gateway-fixture.js";
import { SnapshotPriceSource } from "../../packages/model-gateway/src/price-index.js";
import { answerRateQuote, RATE_QUOTE_AUDIENCE } from "../../packages/model-gateway/src/rate-quote.js";
import { answerOfferedModels, SERVICE_TOKEN_AUDIENCE } from "../../packages/model-gateway/src/offered-models.js";
import { FixedCapsSource } from "../../packages/model-gateway/src/caps.js";
import type { RunPrice } from "../../packages/model-gateway/src/model-gateway-token.js";
import { InMemoryMeter } from "../../packages/model-gateway/src/meter.js";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { DynamoMeter } from "../../packages/model-gateway/src/dynamo-meter.js";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";
import { initialCharge, finishCharge } from "../../packages/model-gateway/src/charge-producer.js";
import { openRouterRates, openRouterPolicy } from "../../packages/model-gateway/src/openrouter-policy.js";
beforeAll(denyNetwork);
const model = "openai/gpt-5-mini";
const tariff = { model, route: "fixture-provider", inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000, verifiedAt: now - 1, expiresAt: now + 60_000, evidence: "fake-account-evidence" };
const source = { kind: "company_key" as const, id: "src_router", name: "Company OpenRouter", provider: "openrouter", connectionRevision: "r1" };
async function world() {
 const prices = new SnapshotPriceSource({ load: async () => undefined, save: async () => false }, { now: () => now, openRouterTariffs: [tariff] }); await prices.reload();
 const open = vi.fn(async () => "fixture-key");
 const keys = { connected: async () => true, keyFor: open, resolveForCharge: async () => ({ source, key: open }), identityFor: async () => ({ sourceId: source.id, versionId: source.connectionRevision }) };
 const sources = { sourceFor: async () => "openrouter_key" as const };
 const result = await answerRateQuote({ prices, keys, sources, now: () => now, region: "us-west-2", switchedOn: new Set(), offeredProviders: new Set(["openrouter"]), openRouterTariffs: [tariff], verify: async () => ({ ...claims, aud: RATE_QUOTE_AUDIENCE }) }, { method: "GET", url: `/v1/service/companies/${claims.cid}/rate-quote?model=${model}&runPrice=1`, headers: { authorization: "Bearer fixture" } });
 const runPrice = (result.body as { runPrice: RunPrice }).runPrice; expect(runPrice).toBeDefined();
 const f = setup({ prices, agentKeys: keys, openRouterTariffs: [tariff], chargeReceipts: { source: (_c, _m, resolved) => resolved } });
 const sent: Record<string, unknown>[] = [];
 f.deps.agentAi = { sources, openrouter: { transport: async request => { sent.push(JSON.parse(request.body.toString()) as Record<string, unknown>); return { status: 200, body: answer() }; } } };
 return { ...f, sent, open, runPrice, prices, keys, sources };
}
it("uses the same priced set for exact connected offers, quote and signed hold before key opening", async () => {
 const w = await world();
 const offer = await answerOfferedModels({ sources: w.sources, keys: w.keys, disabled: new Set(), chat: { openrouter: true }, openRouterTariffs: [tariff], now: () => now, verify: async () => ({ ...claims, aud: SERVICE_TOKEN_AUDIENCE }) }, { method: "GET", url: `/v1/service/companies/${claims.cid}/offered-models`, headers: { authorization: "Bearer fixture" } });
 expect((offer.body as { models: Array<{ identity: unknown }> }).models[0]?.identity).toEqual({ provider: "openrouter", sourceId: source.id, connectionRevision: "r1", modelId: model });
 const reserve = vi.spyOn(w.meter, "reserve");
 expect((await call(w.deps, { ...requestBody, model }, mint({ mdl: [model], runPrice: w.runPrice }))).status).toBe(200);
 expect(reserve.mock.invocationCallOrder[0]).toBeLessThan(w.open.mock.invocationCallOrder[0]!);
 expect(w.sent[0]).toMatchObject({ model, provider: { only: [tariff.route], allow_fallbacks: false, max_price: { prompt: 1, completion: 2 } } });
});
it("missing/expired ceiling, changed source, unsupported extras and task/monthly limits send nothing", async () => {
 for (const mode of ["missing", "expired", "rotated", "feature", "task", "month"] as const) {
  const w = await world();
  if (mode === "task" || mode === "month") w.deps.caps = new FixedCapsSource({ ...caps, ...(mode === "task" ? { task: 0 } : { companyMonth: 0 }) });
  const runPrice = mode === "expired" ? { ...w.runPrice, expiresAt: now } : mode === "rotated" ? { ...w.runPrice, connectionRevision: "r2" } : w.runPrice;
  const response = await call(w.deps, { ...requestBody, model, ...(mode === "feature" ? { plugins: [] } : {}) }, mint({ mdl: [model], ...(mode === "missing" ? {} : { runPrice }) }));
  expect(response.status).toBeGreaterThanOrEqual(400); expect(w.open).not.toHaveBeenCalled(); expect(w.sent).toEqual([]);
 }
});
for (const durable of [false, true]) it(`retains missing usage, records an above-hold charge honestly and blocks further calls (${durable ? "Dynamo" : "memory"})`, async () => {
 const tables = { meter: "meter", ledger: "ledger", markers: "markers" };
 const wire = new WireDynamo(Object.values(tables));
 const meter = durable ? new DynamoMeter({ db: new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "fixture", secretAccessKey: "fixture" }), transport: wire.transport }), tables, now: () => now }) : new InMemoryMeter(() => now);
 const price = openRouterRates(openRouterPolicy(model, now, [tariff])!);
 const receipt = initialCharge({ ...claims, aud: "rovara-model-gateway", src: "app", pay: { kind: "member", developerId: claims.per }, mdl: [model] }, { provider: "openrouter", modelId: model }, { source, billing: "external_provider" }, 50, now, price);
 const reserved = await meter.reserve({ scope, caps, estimateMicros: 50, charge: { receipt, requestFingerprint: "f".repeat(64) } }); expect(reserved.ok).toBe(true); if (!reserved.ok) return;
 const missing = finishCharge(receipt, { price, notSent: false, now, reportedCostMicros: 5, retainMissingUsage: true }); expect(missing.amountMicros).toEqual({ state: "available", value: 50 }); expect(missing.status).toBe("awaiting_usage");
 const final = finishCharge(receipt, { price, notSent: false, now, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, reportedCostMicros: 60 });
 await meter.settleV2({ reservationId: reserved.reservation.id, receipt: final }); await meter.settleV2({ reservationId: reserved.reservation.id, receipt: final });
 expect((await meter.read(scope)).every(row => row.spentMicros === 60 && row.overrun)).toBe(true);
 expect((await meter.reserve({ scope, caps, estimateMicros: 1 })).ok).toBe(false);
});
