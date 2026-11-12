// Convergence lane A5: the money rules of Cloud's Metering adapter (packages/broker/src/cloud-adapters/money/metering.ts). Code's own conformance suite runs on it
// too (tests/conformance/adapters/metering-cloud.ts).
import { describe, expect, it } from "vitest";
import { MemoryDocumentStore } from "@rovara-code/broker/ports";
import type { MeterEntry, ModelUsage, PriceTable } from "@rovara-code/contracts";
import { createCloudMetering, meterTotalKey } from "../../packages/broker/src/cloud-adapters/money/index.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa";
const B = "org_bbbbbbbbbbbbbbbbbbbb";
const PRICES: PriceTable = {
  currency: "USD",
  models: {
    "bedrock/model-a": { inputMicrosPerMillionTokens: 3_000_000, outputMicrosPerMillionTokens: 15_000_000 },
    // Priced at nothing, as LiteLLM's map prices some Bedrock ids: an unpriced model, never a free one.
    "bedrock/model-free": { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 },
  },
};
const usage = (modelId: string, input = 1_000, output = 500): ModelUsage => ({ provider: "bedrock", modelId, tokens: { input, output, cacheRead: 0, cacheWrite: 0 } });
const entry = (entryId: string, modelId = "model-a", company = A, extra: Partial<MeterEntry> = {}): MeterEntry => ({ companyId: company, entryId, at: "2026-11-11T10:00:00.000Z", usage: usage(modelId), taskId: "task-1", ...extra });

function world(options: { trustReportedCost?: boolean } = {}) {
  const store = new MemoryDocumentStore();
  const metering = createCloudMetering({ store, prices: PRICES, ...options });
  const total = async (company = A, sk = "COMPANY") => {
    const item = await store.get(meterTotalKey(company, "2026-11", sk));
    return { entries: item?.entries ?? 0, costMicros: item?.costMicros ?? 0, unpricedEntries: item?.unpricedEntries ?? 0 };
  };
  return { store, metering, total };
}

describe("Cloud Metering", () => {
  it("prices with Code's arithmetic in whole millionths of a dollar", async () => {
    // 1000 x $3/M + 500 x $15/M = $0.003 + $0.0075 = $0.0105.
    expect(await world().metering.price(usage("model-a"))).toEqual({ micros: 10_500, currency: "USD" });
  });

  it("records an entry once however often it is retried, even when the retries race", async () => {
    const { metering, total } = world();
    const results = await Promise.all(Array.from({ length: 10 }, () => metering.record(entry("e-1"))));
    expect(new Set(results.map((result) => JSON.stringify(result))).size).toBe(1);
    expect(results[0]).toEqual({ cost: { micros: 10_500, currency: "USD" }, source: "price-table" });
    expect(await total()).toEqual({ entries: 1, costMicros: 10_500, unpricedEntries: 0 });
    expect(await total(A, "TASK#task-1")).toEqual({ entries: 1, costMicros: 10_500, unpricedEntries: 0 });
    await metering.record(entry("e-1"));
    expect(await total()).toEqual({ entries: 1, costMicros: 10_500, unpricedEntries: 0 });
  });

  it("adds concurrent different entries without losing one", async () => {
    const { metering, total } = world();
    await Promise.all(Array.from({ length: 30 }, (_, index) => metering.record(entry(`e-${index}`))));
    expect(await total()).toEqual({ entries: 30, costMicros: 315_000, unpricedEntries: 0 });
  });

  it("an unknown model is unknown, never $0: counted apart, and not added to the dollars", async () => {
    const { metering, total } = world();
    expect(await metering.price(usage("model-z"))).toBeNull();
    expect(await metering.record(entry("u-1", "model-z"))).toEqual({ cost: null, source: "unknown" });
    expect(await total()).toEqual({ entries: 1, costMicros: 0, unpricedEntries: 1 });
  });

  it("a model priced at nothing is unpriced, not free", async () => {
    const { metering, total } = world();
    expect(await metering.price(usage("model-free"))).toBeNull();
    expect(await metering.record(entry("f-1", "model-free"))).toEqual({ cost: null, source: "unknown" });
    expect(await total()).toEqual({ entries: 1, costMicros: 0, unpricedEntries: 1 });
  });

  it("believes a provider-reported dollar cost for an unpriced model only when told to, and never one in another currency", async () => {
    const reported = { reportedCost: { micros: 7_000, currency: "USD" } };
    expect(await world().metering.record(entry("r-1", "model-z", A, reported))).toEqual({ cost: null, source: "unknown" });
    const trusting = world({ trustReportedCost: true });
    expect(await trusting.metering.record(entry("r-2", "model-z", A, reported))).toEqual({ cost: { micros: 7_000, currency: "USD" }, source: "provider-reported" });
    expect(await trusting.metering.record(entry("r-3", "model-z", A, { reportedCost: { micros: 7_000, currency: "EUR" } }))).toEqual({ cost: null, source: "unknown" });
    // A provider that reports $0 for a model Cloud cannot price is not believed: an unknown cost is never $0 (decision 79).
    expect(await trusting.metering.record(entry("r-5", "model-z", A, { reportedCost: { micros: 0, currency: "USD" } }))).toEqual({ cost: null, source: "unknown" });
    // The price table wins over a report for a priced model.
    expect(await trusting.metering.record(entry("r-4", "model-a", A, reported))).toEqual({ cost: { micros: 10_500, currency: "USD" }, source: "price-table" });
  });

  it("one company's entries never touch another's totals, and one entry id in two companies is two entries", async () => {
    const { metering, total } = world();
    await metering.record(entry("same", "model-a", A));
    expect(await total(B)).toEqual({ entries: 0, costMicros: 0, unpricedEntries: 0 });
    await metering.record(entry("same", "model-a", B));
    expect(await total(A)).toEqual({ entries: 1, costMicros: 10_500, unpricedEntries: 0 });
    expect(await total(B)).toEqual({ entries: 1, costMicros: 10_500, unpricedEntries: 0 });
  });

  it("refuses an entry with no valid company, and usage with tokens that are not whole counts is unpriced", async () => {
    const { metering } = world();
    await expect(metering.record({ ...entry("bad"), companyId: "nobody" })).rejects.toThrow(RangeError);
    expect(await metering.price({ ...usage("model-a"), tokens: { input: 1.5, output: 0, cacheRead: 0, cacheWrite: 0 } })).toBeNull();
  });

  it("refuses prices that are not in dollars", () => {
    expect(() => createCloudMetering({ store: new MemoryDocumentStore(), prices: { currency: "EUR", models: {} } })).toThrow(RangeError);
  });
});
