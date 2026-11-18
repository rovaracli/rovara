import { createHash } from "node:crypto";
import type { ReserveInput } from "../../packages/model-gateway/src/meter.js";
import type { ProviderTransport } from "../../packages/model-gateway/src/provider.js";
import { beforeAll, expect, it } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { call, claims, now, setup, sse, scope, caps, mint } from "./model-gateway-fixture.js";
import { InMemoryMeter } from "../../packages/model-gateway/src/meter.js";
import type { ChargeReceiptV1, SettleV2 } from "../../packages/model-gateway/src/charge-receipt.js";
beforeAll(denyNetwork);
it("negotiates receipts, binds a call and fingerprint before forwarding, and retains its own reservation after truncation", async () => {
  let initial: ChargeReceiptV1 | undefined, settled: ChargeReceiptV1 | undefined, fingerprint: unknown;
  const meter = new InMemoryMeter(() => now);
  const reserve = meter.reserve.bind(meter);
  meter.reserve = async input => { const charge = Reflect.get(input, "charge"); initial = charge?.receipt; fingerprint = charge?.requestFingerprint; return reserve(input); };
  const v2 = Reflect.get(meter, "settleV2").bind(meter);
  Reflect.set(meter, "settleV2", async (v: SettleV2) => { settled = v.receipt; return v2(v); });
  const f = setup({ meter, transport: async () => { expect(initial).toMatchObject({ operationId: claims.op, status: "awaiting_usage" }); expect(fingerprint).toMatch(/^[a-f0-9]{64}$/u); return { status: 200, body: (async function* () { yield Buffer.from('data: {"type":"message_start"}\\n\\n'); })() }; } });
  Reflect.set(f.deps, "chargeReceipts", { source: () => ({ source: { kind: "company_key", id: "connection_1", name: "Company key", provider: "anthropic", connectionRevision: "7" }, billing: "external_provider" }) });
  await call(f.deps);
  expect(settled).toMatchObject({ status: "awaiting_usage", reason: "missing_usage", callId: initial?.callId, operationId: claims.op, originalReservationMicros: initial?.amountMicros, amountMicros: initial?.amountMicros });
});
it("keeps authoritative provider money separate when the response contains no token usage", async () => {
  const meter = new InMemoryMeter(() => now);
  let settled: ChargeReceiptV1 | undefined;
  const v2 = meter.settleV2.bind(meter);
  meter.settleV2 = async input => { settled = input.receipt; return v2(input); };
  const f = setup({ meter, transport: async () => ({ status: 200, body: (async function* () { yield Buffer.from("event: ping\ndata: {\"type\":\"ping\"}\n\n"); })(), reportedCostMicros: () => 30 }) });
  Reflect.set(f.deps, "chargeReceipts", { source: () => ({ source: { kind: "company_key", id: "connection_1", name: "Company key", provider: "anthropic", connectionRevision: "7" }, billing: "external_provider" }) });
  await call(f.deps);
  expect(settled).toMatchObject({ status: "final", reason: "reported_cost", amountMicros: { state: "available", value: 30 }, providerCostMicros: { state: "available", value: 30 }, usage: { state: "unavailable" }, usageComplete: false });
});
it("an all-zero usage placeholder cannot claim complete usage", async () => {
  const { finishCharge } = await import("../../packages/model-gateway/src/charge-producer.js");
  const { chargeReceipt } = await import("./charge-receipt-fixture.js");
  const price = { inputMicrosPerMTok: 1, outputMicrosPerMTok: 1, estimated: false, usageEstimated: false };
  const r = finishCharge(chargeReceipt(), { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, price, notSent: false, now });
  expect(r).toMatchObject({ status: "awaiting_usage", usageComplete: false });
});

it("the gateway uses forwarded bytes after a synthetic-zero-only stream is cut off", async () => {
  const { chargeReceipt } = await import("./charge-receipt-fixture.js");
  const meter = new InMemoryMeter(() => now);
  const time = new Date(now).toISOString();
  for (let n = 0; n < 20; n++) {
    const r = await meter.reserve({ scope, caps, estimateMicros: 80 }); if (!r.ok) throw new Error("reserve");
    await meter.settleV2({ reservationId: r.reservation.id, receipt: chargeReceipt({ callId: r.reservation.id, issuer: claims.iss, model: { provider: "anthropic", modelId: claims.mdl[0]! }, status: "final", reason: "reported_cost", amountMicros: { state: "available", value: 1 }, providerCostMicros: { state: "available", value: 1 }, usageComplete: true, usage: { state: "available", value: { input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnknown: 0 } }, occurredAt: time, recordedAt: time, accountingDay: time.slice(0, 10), accountingMonth: time.slice(0, 7) }) });
  }
  const f = setup({ meter, transport: async () => ({ status: 200, body: (async function* () { yield sse("message_start", { message: { usage: { input_tokens: 0, output_tokens: 0 } } }); })() }) });
  f.deps.chargeReceipts = { source: () => ({ source: { kind: "company_key", id: "connection_1", name: "Company key", provider: "anthropic", connectionRevision: "7" }, billing: "external_provider" }) };
  await call(f.deps);
  const pending = (await meter.pendingFor({ provider: "anthropic", model: claims.mdl[0]! }, 10)).items;
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({ estimateBasis: "input_bytes_bound", outputEstimateBasis: "p90_history", chargeStatus: "awaiting_usage" });
  expect(pending[0]!.settledMicros).toBeGreaterThan(2);
});

it.each(["openai", "converse"] as const)("%s binds the translated wire bytes and tool allowance before forwarding", async adapter => {
  const meter = new InMemoryMeter(() => now);
  let reserved: ReserveInput | undefined;
  let forwarded: Buffer | undefined;
  const reserve = meter.reserve.bind(meter);
  meter.reserve = async input => { reserved = input; return reserve(input); };
  const transport: ProviderTransport = async request => {
    forwarded = Buffer.from(request.body);
    return { status: 200, body: (async function* () { yield sse("message_start", { message: { usage: { input_tokens: 0 } } }); })() };
  };
  const model = adapter === "openai" ? "gpt-5-mini" : "amazon.nova-pro-v1:0";
  const f = setup({ meter, agentKeys: { connected: async () => true, keyFor: async () => "fixture-key" }, agentAi: {
    sources: { sourceFor: async () => adapter === "openai" ? "openai_key" : "rovara" },
    switchedOn: new Set(["openai"]),
    ...(adapter === "openai" ? { openai: { transport } } : { rovara: { transport, models: new Map([[model, model]]), exempt: new Set<string>() } }),
  } });
  f.deps.chargeReceipts = { source: () => ({ source: { kind: "company_key", id: "connection_1", name: "Company key", provider: "openai", connectionRevision: "7" }, billing: "external_provider" }) };
  const result = await call(f.deps, { model, max_tokens: 100, stream: true, tools: [{ name: "ping", description: "Ping", input_schema: { type: "object", properties: {} } }], messages: [{ role: "user", content: "hello" }] }, mint({ mdl: [model] }));
  expect(result.status).toBe(200);
  expect(forwarded).toBeDefined();
  const body = JSON.parse(forwarded!.toString()) as Record<string, unknown>;
  expect(body).toHaveProperty(adapter === "openai" ? "tools" : "toolConfig");
  expect(body).not.toHaveProperty("max_tokens");
  expect(reserved?.provisional).toMatchObject({ requestBytes: forwarded!.length, toolInputAllowanceTokens: 4096 });
  expect(reserved?.charge?.requestFingerprint).toBe(createHash("sha256").update(forwarded!).digest("hex"));
});
