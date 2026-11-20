import { beforeAll, expect, it, vi } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { answer, call, caps, claims, mint, now, requestBody, scope, setup } from "./model-gateway-fixture.js";
import { FixedCapsSource } from "../../packages/model-gateway/src/caps.js";
import { UnknownPriceSource, type PriceSource } from "../../packages/model-gateway/src/price.js";
import { estimateCall } from "../../packages/model-gateway/src/estimate.js";
import { guardRequest } from "../../packages/model-gateway/src/guard.js";
import { fetchAWS } from "../../packages/model-gateway/src/price-sources.js";
import { DynamoMeter } from "../../packages/model-gateway/src/dynamo-meter.js";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";
import type { ReserveInput } from "../../packages/model-gateway/src/meter.js";
import { SnapshotPriceSource } from "../../packages/model-gateway/src/price-index.js";
import { answerRateQuote, RATE_QUOTE_AUDIENCE } from "../../packages/model-gateway/src/rate-quote.js";
import type { RunPrice } from "../../packages/model-gateway/src/model-gateway-token.js";
import { translatedAnswer } from "../../packages/model-gateway/src/agent-openai.js";
import { openRouterPolicy } from "../../packages/model-gateway/src/openrouter-policy.js";
import { resolvePrice } from "../../packages/model-gateway/src/price.js";
beforeAll(denyNetwork);
const alias = "claude-haiku-4-5", id = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const body = { ...requestBody, model: alias, stream: false };
const price = { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000 };
function world(prices: PriceSource = { priceFor: () => price }, input = 2, durable = false) {
  const sent = vi.fn(async () => ({ status: 200, body: (async function* () { yield Buffer.from(JSON.stringify({ type: "message", content: [], usage: { input_tokens: input, output_tokens: 1 } })); })() }));
  const assumed = vi.fn(async () => ({ ok: true as const, credentials: { accessKeyId: "fixture", secretAccessKey: "fixture", sessionToken: "fixture" } }));
  const w = setup({ prices, agentKeys: { connected: async () => false, keyFor: async () => undefined } });
  let wire: WireDynamo | undefined;
  if (durable) {
    const tables = { meter: "meter", ledger: "ledger", markers: "markers" };
    wire = new WireDynamo(Object.values(tables));
    w.deps.meter = new DynamoMeter({ db: new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "fixture", secretAccessKey: "fixture" }), transport: wire.transport }), tables, now: () => now });
  }
  const meter = w.deps.meter;
  const settlements = vi.spyOn(meter, "settleV2");
  const holds: ReserveInput[] = [];
  const reserve = meter.reserve.bind(meter);
  vi.spyOn(meter, "reserve").mockImplementation(async value => { holds.push(value); return reserve(value); });
  w.deps.agentAi = { sources: { sourceFor: async () => "bedrock_byo" }, byo: {
    connection: async (iss, cid) => ({ row: { iss, cid, owner: "_company", sourceId: "own", versionId: "r1" }, connection: { scheme: "assume_role", roleArn: "arn:aws:iam::111111111111:role/RovaraBedrockInvoke-fixture", region: "us-west-2", models: { [alias]: id }, allowGlobal: false } }),
    sessions: { credentials: assumed, forget: () => undefined }, transport: () => sent,
  } };
  return { ...w, meter, wire, holds, assumed, sent, settlements };
}
for (const kind of ["image", "document", "audio", "unknown"] as const) it(`M1 refuses no-runPrice ${kind} before hold, STS and transport`, async () => {
  const w = world(UnknownPriceSource);
  const result = await call(w.deps, { ...body, messages: [{ role: "user", content: [{ type: kind, source: { type: "url", url: "https://image.example/large.png" } }, { type: "text", text: "Describe" }] }] }, mint({ mdl: [alias] }));
  expect(result.status).toBe(409); expect(w.holds).toEqual([]); expect(w.assumed).not.toHaveBeenCalled(); expect(w.sent).not.toHaveBeenCalled();
});
it("M1 refuses bounded no-runPrice input at an estimated price", async () => {
  const w = world(UnknownPriceSource);
  expect((await call(w.deps, body, mint({ mdl: [alias] }))).status).toBe(409);
  expect(w.holds).toEqual([]); expect(w.assumed).not.toHaveBeenCalled(); expect(w.sent).not.toHaveBeenCalled();
});
for (const durable of [false, true]) {
  it(`legacy known bounded input works with exact worst-case hold (${durable})`, async () => {
    const w = world(undefined, 2, durable);
    expect((await call(w.deps, body, mint({ mdl: [alias] }))).status).toBe(200);
    const guarded = guardRequest(Buffer.from(JSON.stringify(body)), { "content-type": "application/json" }, [alias], w.deps.modelLimits);
    if (!guarded.ok) throw new Error("fixture refused");
    // Bedrock's forwarded envelope replaces model/stream with anthropic_version.
    const rest = Object.fromEntries(Object.entries(JSON.parse(guarded.bytes.toString()) as Record<string, unknown>).filter(([key]) => !["model", "stream", "metadata"].includes(key)));
    const bytes = Buffer.byteLength(JSON.stringify({ anthropic_version: "bedrock-2023-05-31", ...rest }));
    const resolved = await resolvePrice(w.deps.prices!, "bedrock", id);
    expect(w.holds[0]?.estimateMicros).toBe(estimateCall(bytes, 10, resolved, 0, true));
    expect((await w.meter.read(scope)).every(row => row.spentMicros <= w.holds[0]!.estimateMicros)).toBe(true);
  });
  it(`M1 records true 100002 usage cost above hold, alarms and stops subsequent calls (${durable})`, async () => {
    const w = world(undefined, 100_000, durable);
    w.deps.caps = new FixedCapsSource({ ...caps, task: 1000, companyMonth: 1000 });
    expect((await call(w.deps, body, mint({ mdl: [alias] }))).status).toBe(200);
    const hold = w.holds[0]!.estimateMicros;
    if (w.wire !== undefined) {
      const ledger = [...w.wire.fake.items.values()].find(row => typeof row.sk === "string" && row.sk.startsWith("CALL#"));
      expect(ledger).toMatchObject({ settledMicros: 100002, receipt: { amountMicros: { value: 100002 }, usage: { value: { input: 100000, output: 1 } } } });
      const tables = { meter: "meter", ledger: "ledger", markers: "markers" };
      const fresh = new DynamoMeter({ db: new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "fixture", secretAccessKey: "fixture" }), transport: w.wire.transport }), tables, now: () => now });
      expect(await fresh.reserve({ scope: { ...scope, tid: "task_3" }, caps, estimateMicros: 1 })).toMatchObject({ ok: false, reason: "overrun" });
    }
    const rows = await w.meter.read(scope);
    expect(rows.every(row => row.spentMicros === 100002 && row.overrun)).toBe(true);
    expect(w.logs).toContainEqual(expect.objectContaining({ event: "customer_source_over_reservation", source: "bedrock_byo", costMicros: 100002, heldMicros: hold, overageMicros: 100002 - hold }));
    expect((await call(w.deps, body, mint({ mdl: [alias], tid: "task_2" }))).status).toBe(422);
    expect(w.assumed).toHaveBeenCalledTimes(1); expect(w.sent).toHaveBeenCalledTimes(1);
    const receipt = w.settlements.mock.calls[0]![0].receipt;
    const revised = { ...receipt, revision: 2, replacesRevision: 1, amountMicros: { state: "available" as const, value: 100003 } };
    expect(await w.meter.applyChargeReceipt!(revised)).toMatchObject({ result: "applied", deltaMicros: 1 });
    expect(await w.meter.applyChargeReceipt!(revised)).toMatchObject({ result: "duplicate", deltaMicros: 0 });
    expect((await w.meter.read(scope)).every(row => row.spentMicros === 100003 && row.overrun)).toBe(true);
    if (w.wire !== undefined) {
      // Simulate an explicit operator clear of the existing meter rows, preserving the true spend.
      for (const row of w.wire.fake.items.values()) if (row.overrun === true) row.overrun = false;
      w.deps.caps = new FixedCapsSource(caps);
      expect((await call(w.deps, body, mint({ mdl: [alias], tid: "task_cleared" }))).status).toBe(200);
      expect(w.sent).toHaveBeenCalledTimes(2);
    }
  });
  for (const item of ["task", "companyMonth"] as const) it(`bounded no-runPrice ${item} admission cap before STS (${durable})`, async () => {
    const w = world(undefined, 2, durable); w.deps.caps = new FixedCapsSource({ ...caps, [item]: 1 });
    expect((await call(w.deps, body, mint({ mdl: [alias] }))).status).toBe(422);
    expect(w.assumed).not.toHaveBeenCalled(); expect(w.sent).not.toHaveBeenCalled();
  });
}
it("M2 non-exempt setup_draft with no source never uses operator Bedrock or bills exempt", async () => {
  const w = setup({ agentKeys: { connected: async () => false, keyFor: async () => undefined } });
  const transport = vi.fn(async () => ({ status: 200, body: answer() }));
  w.deps.agentAi = { sources: { sourceFor: async () => undefined }, rovara: { models: new Map([[alias, id]]), exempt: new Set([`org_${"b".repeat(20)}`]), transport } };
  expect((await call(w.deps, body, mint({ mdl: [alias], stp: "setup_draft" }))).status).toBe(403);
  expect(transport).not.toHaveBeenCalled(); expect(w.meter.billedCalls(claims.iss, claims.cid)).toEqual([]);
});
it("M3 refuses a mixed-unit partial AWS token tariff", async () => {
  const dims = { cheap: { unit: "1M tokens", pricePerUnit: { USD: "1" } }, dearer: { unit: "1000 tokens", pricePerUnit: { USD: "1" } } };
  const offer = { products: { i: { attributes: { model: "Claude Haiku 4.5", usagetype: "US_input_tokens_standard-Units" } }, o: { attributes: { model: "Claude Haiku 4.5", usagetype: "US_output_tokens_standard-Units" } } }, terms: { OnDemand: { i: { t: { priceDimensions: dims } }, o: { t: { priceDimensions: dims } } } } };
  expect((await fetchAWS({ get: async () => ({ status: 200, body: Buffer.from(JSON.stringify(offer)) }) }, { now, minModels: 1, regions: ["us-west-2"] })).ok).toBe(false);
});
it("unknown exact Bedrock price is refused even if an Anthropic alias is known", async () => {
  const w = world({ priceFor: provider => provider === "anthropic" ? price : undefined });
  expect((await call(w.deps, body, mint({ mdl: [alias] }))).status).toBe(409);
  expect(w.holds).toEqual([]); expect(w.assumed).not.toHaveBeenCalled(); expect(w.sent).not.toHaveBeenCalled();
});
for (const path of ["chosen", "default", "fallback"] as const) for (const item of ["task", "companyMonth"] as const) it(`caps apply to ${path} Bedrock admission: ${item}`, async () => {
  const w = world();
  if (path === "default") w.deps.agentAi = { ...w.deps.agentAi!, sources: { sourceFor: async () => undefined }, rovara: { models: new Map([[alias, id]]), exempt: new Set([claims.cid]), transport: w.deps.transport } };
  if (path === "fallback") w.deps.agentAi!.sources = { sourceFor: async () => "rovara", orderFor: async () => ({ source: "rovara", fallback: ["bedrock_byo"] }) };
  w.deps.caps = new FixedCapsSource({ ...caps, [item]: 1 });
  expect((await call(w.deps, body, mint({ mdl: [alias] }))).status).toBe(422);
  expect(w.assumed).not.toHaveBeenCalled(); expect(w.sent).not.toHaveBeenCalled();
});

for (const limit of ["none", "task", "companyMonth"] as const) it(`valid signed Bedrock price retains admission and caps: ${limit}`, async () => {
  const prices = new SnapshotPriceSource({ load: async () => ({ version: 1, sources: { litellm: { fetchedAt: now - 1, count: 1, entries: [{ provider: "bedrock", model: id, kind: "chat", ...price }] } } }), save: async () => false }, { now: () => now, overrides: [] }); await prices.reload();
  const w = world(prices);
  const quoted = await answerRateQuote({ prices, now: () => now, region: "us-west-2", switchedOn: new Set(), offeredProviders: new Set(["bedrock"]), sources: w.deps.agentAi!.sources, keys: w.deps.agentKeys!, byo: w.deps.agentAi!.byo!, verify: async () => ({ ...claims, aud: RATE_QUOTE_AUDIENCE }) }, { method: "GET", url: `/v1/service/companies/${claims.cid}/rate-quote?model=${alias}&runPrice=1`, headers: { authorization: "Bearer fixture" } });
  const grant = (quoted.body as { runPrice?: RunPrice }).runPrice; expect(grant).toBeDefined();
  if (limit !== "none") w.deps.caps = new FixedCapsSource({ ...caps, [limit]: 1 });
  expect((await call(w.deps, body, mint({ mdl: [alias], runPrice: grant }))).status).toBe(limit === "none" ? 200 : 422);
  expect(w.assumed).toHaveBeenCalledTimes(limit === "none" ? 1 : 0); expect(w.sent).toHaveBeenCalledTimes(limit === "none" ? 1 : 0);
});

for (const durable of [false, true]) it(`OpenRouter reports true above-hold money, alarms and refuses until operator clear (${durable})`, async () => {
  const w = world(undefined, 2, durable);
  const model = "openai/gpt-5-mini";
  const tariff = { model, route: "fixture", ...price, verifiedAt: now - 1, expiresAt: now + 60_000, evidence: "offline-fixture" };
  const prices = new SnapshotPriceSource({ load: async () => undefined, save: async () => false }, { now: () => now, openRouterTariffs: [tariff] }); await prices.reload();
  const source = { kind: "company_key" as const, id: "router", name: "Company OpenRouter", provider: "openrouter", connectionRevision: "r1" };
  const sent = vi.fn(async () => translatedAnswer("openrouter", { model, streaming: false }, 200, (async function* () { yield Buffer.from(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, cost: 0.100002 } })); })(), () => undefined));
  w.deps.prices = prices; w.deps.openRouterTariffs = [tariff];
  w.deps.agentKeys = { connected: async () => true, keyFor: async () => "fixture", resolveForCharge: async () => ({ source, key: async () => "fixture" }) };
  w.deps.agentAi = { sources: { sourceFor: async () => "openrouter_key" }, switchedOn: new Set(["openrouter"]), openrouter: { transport: sent } };
  w.deps.chargeReceipts = { source: (_claims, _model, resolved) => resolved };
  const runPrice = { companyId: claims.cid, model, provider: "openrouter", sourceId: source.id, connectionRevision: source.connectionRevision, catalogModel: model, snapshotHash: openRouterPolicy(model, now, [tariff])!.hash, snapshotVersion: 1, expiresAt: now + 60_000, inputUsdPerMillion: 1, outputUsdPerMillion: 2, cacheReadUsdPerMillion: 1, cacheWriteUsdPerMillion: 1 };
  const request = { ...body, model };
  const token = (tid: string) => mint({ mdl: [model], runPrice, tid });
  expect((await call(w.deps, request, token(claims.tid))).status).toBe(200);
  const hold = w.holds[0]!.estimateMicros;
  expect(hold).toBeLessThan(100002);
  expect(w.settlements.mock.calls[0]![0].receipt).toMatchObject({ amountMicros: { value: 100002 }, providerCostMicros: { value: 100002 } });
  expect((await w.meter.read(scope)).every(row => row.spentMicros === 100002 && row.overrun)).toBe(true);
  expect(w.logs).toContainEqual(expect.objectContaining({ event: "customer_source_over_reservation", source: "openrouter", costMicros: 100002, heldMicros: hold, overageMicros: 100002 - hold }));
  expect((await call(w.deps, request, token("task_2"))).status).toBe(422);
  expect(sent).toHaveBeenCalledTimes(1);
  const receipt = w.settlements.mock.calls[0]![0].receipt;
  const revised = { ...receipt, revision: 2, replacesRevision: 1, amountMicros: { state: "available" as const, value: 100003 }, providerCostMicros: { state: "available" as const, value: 100003 } };
  expect(await w.meter.applyChargeReceipt!(revised)).toMatchObject({ result: "applied", deltaMicros: 1 });
  expect((await w.meter.read(scope)).every(row => row.spentMicros === 100003 && row.overrun)).toBe(true);
  if (w.wire !== undefined) {
    expect(w.wire.items("ledger").find(row => String(row.sk).startsWith("CALL#"))).toMatchObject({ settledMicros: 100003, receipt: { amountMicros: { value: 100003 } } });
    for (const row of w.wire.fake.items.values()) if (row.overrun === true) row.overrun = false;
    expect((await call(w.deps, request, token("task_cleared"))).status).toBe(200);
    expect(sent).toHaveBeenCalledTimes(2);
  }
});
