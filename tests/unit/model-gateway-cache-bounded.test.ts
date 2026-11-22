import { readFileSync } from "node:fs";
import { beforeAll, expect, it, vi } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { call, claims, mint, now, scope, setup, sse } from "./model-gateway-fixture.js";
import { guardRequest } from "../../packages/model-gateway/src/guard.js";
import { SnapshotPriceSource } from "../../packages/model-gateway/src/price-index.js";
import { answerRateQuote, RATE_QUOTE_AUDIENCE } from "../../packages/model-gateway/src/rate-quote.js";
import { FixedCapsSource } from "../../packages/model-gateway/src/caps.js";
import type { RunPrice } from "../../packages/model-gateway/src/model-gateway-token.js";

beforeAll(denyNetwork);
// Captured offline from Pi 1.5.2's anthropic-messages.js stream/onPayload,
// with normalizeContext, a non-OAuth client, cacheRetention: short and maxTokens: 64.
// Source: Code node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js
// getCacheControl :37, buildParams :1108-1158, convertMessages :1408-1428, convertTools :1520.
const pi = JSON.parse(readFileSync(new URL("../fixtures/model-gateway/pi-ai-1.5.2-anthropic-messages.json", import.meta.url), "utf8")) as {
  model: string; system: Array<Record<string, unknown>>; messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
  tools: Array<Record<string, unknown>>; stream: boolean; max_tokens: number;
};
const id = "us.anthropic.claude-sonnet-4-5-v1:0";
async function world(missingWrite: false | "all" | "5m" | "1h" | "tier" = false, model = pi.model) {
  const catalogModel = model === pi.model ? id : model;
  const rates = { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000, cacheReadMicrosPerMTok: 250_000,
    ...(missingWrite === "all" || missingWrite === "5m" ? {} : { cacheWrite5mMicrosPerMTok: 4_000_000 }),
    ...(missingWrite === "all" || missingWrite === "1h" ? {} : { cacheWrite1hMicrosPerMTok: 6_000_000 }) };
  const band = missingWrite === "tier" ? { aboveTokens: 32_000, inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000, cacheReadMicrosPerMTok: 250_000 } : { aboveTokens: 200_000, ...rates };
  const prices = new SnapshotPriceSource({ load: async () => ({ version: 9, sources: { litellm: { fetchedAt: now - 100, count: 1,
    entries: [{ provider: "bedrock", model: catalogModel, kind: "chat", ...rates, longContext: [band] }] } } }), save: async () => false }, { now: () => now, overrides: [] });
  await prices.reload();
  const rovara = { sourceId: "operator-account@region", models: new Map([[model, catalogModel]]), exempt: new Set<string>() };
  const sources = { sourceFor: async () => "rovara" as const };
  const keys = { connected: async () => false, keyFor: async () => undefined };
  const quoted = await answerRateQuote({ prices, now: () => now, region: "us-west-2", switchedOn: new Set(), offeredProviders: new Set(["bedrock"]), sources, keys, rovara,
    verify: async () => ({ ...claims, aud: RATE_QUOTE_AUDIENCE }) }, { method: "GET", url: `/v1/service/companies/${claims.cid}/rate-quote?model=${model}&runPrice=1`, headers: { authorization: "Bearer fixture" } });
  const grant = (quoted.body as { runPrice: RunPrice }).runPrice;
  expect(grant).toBeDefined();
  const f = setup({ prices, agentKeys: keys, chargeReceipts: { source: (_claims, _model, resolved) => resolved } });
  f.deps.agentAi = { sources, rovara: { ...rovara, transport: f.deps.transport } };
  return { ...f, grant };
}

it("admits Pi's exact cached system/message/tool request and settles split usage at signed cache rates", async () => {
  const f = await world();
  const grant = { ...f.grant, cacheWriteUsdPerMillion: 9, cacheReadUsdPerMillion: 0.5 };
  const reserve = vi.spyOn(f.meter, "reserve");
  const settle = vi.spyOn(f.meter, "settleV2");
  expect((await call(f.deps, pi, mint({ runPrice: grant }))).status).toBe(200);
  // 2 input * $1 + 3 reads * $0.5 + 4 writes * $9 + 5 output * $2 = 49.5 microdollars, rounded up.
  expect(settle.mock.calls[0]![0].receipt).toMatchObject({ status: "final", reason: "rated_usage", amountMicros: { value: 50 }, billableMicros: { value: 50 },
    usage: { value: { input: 2, output: 5, cacheRead: 3, cacheWriteUnknown: 4 } } });
  expect(reserve.mock.calls[0]![0].overrun).toBeUndefined();
  expect((await f.meter.read(scope))[0]).toMatchObject({ spentMicros: 50, reservedMicros: 0 });
});

it("holds every byte-derived prompt token at the signed cache-write maximum plus maximum output", async () => {
  const f = await world();
  const grant = { ...f.grant, cacheWriteUsdPerMillion: 9 };
  const reserve = vi.spyOn(f.meter, "reserve");
  let forwardedBytes = 0;
  const transport = f.deps.transport;
  f.deps.agentAi!.rovara!.transport = async (request) => { forwardedBytes = request.body.length; return transport(request); };
  expect((await call(f.deps, pi, mint({ runPrice: grant }))).status).toBe(200);
  expect(forwardedBytes).toBeGreaterThan(0);
  // One token per serialized byte plus the existing 4096-token tool allowance; no estimator helper supplies this expectation.
  expect(reserve.mock.calls[0]![0].estimateMicros).toBeGreaterThanOrEqual((forwardedBytes + 4096) * 9 + 64 * 2);
});

it("admits Pi's exact cached shape on zai.glm-5 without snapshot cache-write prices and sends no cache fields", async () => {
  const model = "zai.glm-5";
  const f = await world("all", model);
  const reserve = vi.spyOn(f.meter, "reserve");
  const settle = vi.spyOn(f.meter, "settleV2");
  const sent: Array<{ body: Buffer; path?: string }> = [];
  f.deps.agentAi!.rovara!.transport = async (request) => {
    sent.push({ ...request, body: Buffer.from(request.body) });
    return { status: 200, body: (async function* () {
      yield sse("message_start", { message: { usage: { input_tokens: 2, output_tokens: 0 } } });
      yield sse("message_delta", { usage: { output_tokens: 5 } }); yield sse("message_stop");
    })() };
  };
  expect((await call(f.deps, { ...pi, model }, mint({ mdl: [model], runPrice: f.grant }))).status).toBe(200);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.path).toBe("/model/zai.glm-5/converse-stream");
  const upstream = JSON.parse(sent[0]!.body.toString("utf8")) as Record<string, unknown>;
  expect(upstream).toMatchObject({ system: [{ text: "You are a coding assistant." }], messages: [{ role: "user", content: [{ text: "Read the project README." }] }],
    toolConfig: { tools: [{ toolSpec: { name: "read" } }] }, inferenceConfig: { maxTokens: 64 } });
  expect(JSON.stringify(upstream)).not.toMatch(/"[^"]*cache[^"]*"\s*:/iu);
  // Converse drops every marker, so only input + output can be held (one token/byte plus the tool allowance).
  expect(reserve.mock.calls[0]![0]).toMatchObject({ estimateMicros: sent[0]!.body.length + 4096 + 64 * 2 });
  expect(reserve.mock.calls[0]![0].overrun).toBeUndefined();
  expect(settle.mock.calls[0]![0].receipt).toMatchObject({ status: "final", amountMicros: { value: 12 }, usage: { value: { input: 2, output: 5, cacheRead: 0 } } });
});

it("refuses a Claude runPrice without its signed cache rates before holding or sending", async () => {
  const f = await world();
  const reserve = vi.spyOn(f.meter, "reserve");
  const grant: Partial<RunPrice> = { ...f.grant };
  delete grant.cacheWriteUsdPerMillion; delete grant.cacheReadUsdPerMillion;
  expect((await call(f.deps, pi, mint({ runPrice: grant }))).status).toBe(401);
  expect(reserve).not.toHaveBeenCalled();
  expect(f.calls).toHaveLength(0);
});

it.each(["system", "message", "tool"])("keeps a %s-only cache marker bounded", (where) => {
  const body = structuredClone(pi);
  for (const block of [...body.system, ...body.messages[0]!.content, ...body.tools]) delete block.cache_control;
  const block = where === "system" ? body.system[0]! : where === "message" ? body.messages[0]!.content[0]! : body.tools[0]!;
  block.cache_control = { type: "ephemeral", ttl: "1h" };
  expect(guardRequest(Buffer.from(JSON.stringify(body)), { "content-type": "application/json" }, [pi.model], { maxOutputTokens: () => 64 })).toMatchObject({ ok: true, inputBounded: true, usesPromptCache: true });
});

for (const model of [pi.model, "zai.glm-5"]) it.each([
  { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
  { type: "text", text: "remote", source: { url: "https://offline.invalid/file" } },
  { type: "unknown_block", text: "unknown" },
])(`refuses media/remote/unknown blocks on ${model} before a hold or provider send: $type`, async (block) => {
  const f = await world(false, model);
  const reserve = vi.spyOn(f.meter, "reserve");
  const body = structuredClone(pi);
  for (const plain of [...body.system, ...body.tools]) delete plain.cache_control;
  body.messages = [{ role: "user", content: [block] }];
  body.model = model;
  const result = await call(f.deps, body, mint({ mdl: [model], runPrice: f.grant }));
  const status = model === "zai.glm-5" && block.type !== "text" ? 400 : 409;
  expect(result.status).toBe(status);
  expect(result.text()).toContain(status === 409 ? "run_price_authorization_required" : "invalid_request");
  expect(reserve).not.toHaveBeenCalled();
  expect(f.calls).toHaveLength(0);
});

it.each(["all", "5m", "1h", "tier"] as const)("refuses a cached call with no snapshot cache-write price (%s) before holding or sending", async (missing) => {
  const f = await world(missing);
  const reserve = vi.spyOn(f.meter, "reserve");
  const body = structuredClone(pi);
  if (missing === "tier") body.system[0]!.text = "prefix ".repeat(5_000);
  const result = await call(f.deps, body, mint({ runPrice: f.grant }));
  expect(result.status).toBe(409);
  expect(result.text()).toMatch(/cache.write price/iu);
  expect(reserve).not.toHaveBeenCalled();
  expect(f.calls).toHaveLength(0);
});

it.each([pi.model, "zai.glm-5"])("retains the hidden-charge backstop on %s when reported cost exceeds the admitted maximum", async (model) => {
  const f = await world(false, model);
  f.deps.caps = new FixedCapsSource({ task: 100_000, personMonth: 100_000, projectMonth: 100_000, companyMonth: 100_000 });
  f.deps.agentAi!.rovara!.transport = async () => ({ status: 200, reportedCostMicros: () => 200_000, body: (async function* () {
    yield sse("message_start", { message: { usage: { input_tokens: 2, output_tokens: 0, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } } });
    yield sse("message_delta", { usage: { output_tokens: 5 } }); yield sse("message_stop");
  })() });
  const reserve = vi.spyOn(f.meter, "reserve");
  expect((await call(f.deps, { ...pi, model }, mint({ mdl: [model], runPrice: f.grant }))).status).toBe(200);
  expect(reserve.mock.calls[0]![0].estimateMicros).toBeLessThan(100_000);
  expect((await f.meter.read(scope)).find((row) => row.item === "company")).toMatchObject({ spentMicros: 200_000, overrun: true, reservedMicros: 0 });
  expect((await call(f.deps, { ...pi, model }, mint({ mdl: [model], runPrice: f.grant }))).status).toBe(422);
});
