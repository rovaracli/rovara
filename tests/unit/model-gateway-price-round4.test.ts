import { beforeAll, expect, it } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { fetchLiteLLM } from "../../packages/model-gateway/src/price-sources.js";
import { InMemoryPriceSnapshotStore, validSnapshot } from "../../packages/model-gateway/src/price-snapshot.js";
import { SnapshotPriceSource } from "../../packages/model-gateway/src/price-index.js";
import { PriceRefresher } from "../../packages/model-gateway/src/price-refresh.js";
import { resolvePrice } from "../../packages/model-gateway/src/price.js";
import { estimateCall } from "../../packages/model-gateway/src/estimate.js";
import { settleAmount } from "../../packages/model-gateway/src/reported-cost.js";
import { now, setup, call, answer, scope } from "./model-gateway-fixture.js";
beforeAll(denyNetwork);
const model = "claude-sonnet-4-5";
const row = (input = 15, extra: Record<string, unknown> = {}) => ({ litellm_provider: "anthropic", mode: "chat", input_cost_per_token: input / 1e6, output_cost_per_token: input * 5 / 1e6, ...extra });
const skipped = { search_context_cost_per_query: { private: 1 } };
const usage = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 };
function fixture() {
  const store = new InMemoryPriceSnapshotStore(); const prices = new SnapshotPriceSource(store, { now: () => now });
  let rows: unknown; let tick = now;
  const logs: unknown[] = [];
  const refresher = () => new PriceRefresher({ store, prices, log: (line) => logs.push(line), aws: async () => ({ ok: false, reason: "invalid source" }), litellm: (previous) => fetchLiteLLM({ get: async () => ({ status: 200, body: Buffer.from(typeof rows === "string" ? rows : JSON.stringify(rows)) }) }, { previous, now, minModels: 1 }) });
  return { store, prices, logs, async fetch(next: unknown) { rows = next; await refresher().run(tick++); }, async price(name = model, kind: "chat" | "embedding" = "chat") { return resolvePrice(prices, "anthropic", name, undefined, undefined, kind); } };
}
async function money(f: ReturnType<typeof fixture>, minimum: number) {
  const p = await f.price();
  expect(p.inputMicrosPerMTok).toBeGreaterThanOrEqual(minimum * 1e6);
  expect(p.outputMicrosPerMTok).toBeGreaterThanOrEqual(minimum * 5e6);
  expect(estimateCall(1_000_000, 1_000_000, p)).toBeGreaterThanOrEqual(minimum * 6e6);
  expect(settleAmount({ price: p, usage, reservationMicros: 1 }).actualMicros).toBeGreaterThanOrEqual(minimum * 6e6);
  return p;
}
it.each(["future-chat", null, 7, {}, "embedding-new"])("unknown mode %j retains own floor and raises every provider kind", async (mode) => {
  const f = fixture(); await f.fetch({ peer: row(3), embed: row(1, { mode: "embedding" }), [model]: row(15, { mode }) });
  expect((await money(f, 22.5)).estimated).toBe(true);
  for (const kind of ["chat", "embedding"] as const) expect(await f.price("unlisted", kind)).toMatchObject({ inputMicrosPerMTok: 22_500_000, outputMicrosPerMTok: 112_500_000 });
  const gateway = setup({ prices: f.prices }); let held = 0;
  gateway.deps.transport = async () => { held = (await gateway.meter.read(scope))[0]!.reservedMicros; return { status: 200, body: answer() }; };
  expect((await call(gateway.deps)).status).toBe(200); expect(held).toBeGreaterThanOrEqual(765);
  expect((await gateway.meter.read(scope))[0]?.spentMicros).toBe(765);
  expect(JSON.stringify(f.logs)).not.toMatch(/claude|future|private/);
});
it.each([
  ["floor to floor", skipped, skipped, 22.5, 4.5],
  ["floor to known", skipped, {}, 22.5, 0.5],
  ["known to floor", {}, skipped, 15, 4.5],
] as const)("confirms effective drops: %s", async (_name, before, after, previous, confirmed) => {
  const f = fixture(); await f.fetch({ peer: row(3), [model]: row(15, before) }); await money(f, previous);
  const lower = { peer: row(3), [model]: row(0.5, after) };
  await f.fetch(lower); expect((await money(f, previous)).estimated).toBe(true);
  await f.fetch(lower); expect((await f.price()).inputMicrosPerMTok).toBe(confirmed * 1e6); await money(f, confirmed);
});
it("holds a transition's smaller decrease too; a first lower fetch is never known", async () => {
  const f = fixture(); await f.fetch({ peer: row(3), [model]: row(15, skipped) });
  await f.fetch({ peer: row(3), [model]: row(15) }); expect((await money(f, 22.5)).estimated).toBe(true);
  await f.fetch({ peer: row(3), [model]: row(15) }); expect(await f.price()).toMatchObject({ inputMicrosPerMTok: 15_000_000, estimated: false });
});
it("failed fetches and changed lower numbers reset confirmation across restarts; rises apply immediately", async () => {
  const f = fixture(); await f.fetch({ peer: row(3), [model]: row(15, skipped) });
  await f.fetch({ peer: row(3), [model]: row(1, skipped) }); await money(f, 22.5);
  await f.fetch("{bad-private"); await money(f, 22.5);
  await f.fetch({ peer: row(3), [model]: row(1, skipped) }); await money(f, 22.5);
  await f.fetch({ peer: row(3), [model]: row(4, skipped) }); await money(f, 22.5);
  await f.fetch({ peer: row(3), [model]: row(30, skipped) }); await money(f, 45);
  await f.fetch({ peer: row(3), [model]: row(4, skipped) }); await money(f, 45);
  await f.fetch({ peer: row(3), [model]: row(4, skipped) }); expect((await f.price()).inputMicrosPerMTok).toBe(6e6);
  expect(JSON.stringify(f.logs)).not.toMatch(/private|claude/);
});
it("retains a known floor when later successful sources omit or cannot price its row", async () => {
  const f = fixture(); await f.fetch({ peer: row(3), [model]: row(15, skipped) });
  for (const next of [{ peer: row(3) }, { peer: row(3), [model]: { mode: "future-chat", litellm_provider: "anthropic" } }]) { await f.fetch(next); await money(f, 22.5); }
});
it("property: bounded seeded fetch sequences never lower an estimate without consecutive matching effective candidates", async () => {
  let seed = 0x31415926; const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const extras = [skipped, { mode: "future-chat" }, { deprecation_date: {} }, { deprecation_date: "2020-01-01" }, {}];
  for (let sequence = 0; sequence < 8; sequence++) {
    const f = fixture(); let previous = 0; let preceding = -1;
    for (let step = 0; step < 35; step++) {
      const rate = [0.5, 3, 4, 15, 30, 2000][random() % 6]!; const extra = extras[random() % extras.length]!;
      const failed = random() % 11 === 0; const classified = Object.keys(extra).length === 0 && rate <= 1000;
      const candidate = classified ? rate : Math.max(3, rate) * 1.5;
      await f.fetch(failed ? "{" : { peer: row(3), [model]: row(rate, extra) });
      if (failed && previous === 0) { preceding = -1; continue; }
      const p = await f.price(); const effective = p.inputMicrosPerMTok / 1e6;
      if (!failed) await money(f, classified ? rate : rate * 1.5);
      if (effective < previous) { expect(failed).toBe(false); expect(candidate).toBe(preceding); }
      previous = effective; preceding = failed ? -1 : candidate;
    }
  }
});
it("accepts legacy snapshots byte-for-byte and validates new floor metadata at runtime", async () => {
  const f = fixture(); await f.fetch({ peer: row(3) }); const old = await f.store.load(); expect(validSnapshot(old)).toBe(true);
  const saved = JSON.stringify(old); await f.prices.reload(); expect(JSON.stringify(await f.store.load())).toBe(saved);
});
it("compares effective provider maxima as well as own floors, separately for each component", async () => {
  const f = fixture(); await f.fetch({ peer: row(30), [model]: row(15, skipped) });
  const lower = { peer: row(3), [model]: row(0.5, { ...skipped, input_cost_per_token: 60e-6 }) };
  await f.fetch(lower); expect(await f.price()).toMatchObject({ inputMicrosPerMTok: 90e6, outputMicrosPerMTok: 225e6, estimated: true });
  await f.fetch(lower); expect(await f.price()).toMatchObject({ inputMicrosPerMTok: 90e6, outputMicrosPerMTok: 22.5e6 });
});
it("confirms over-max and overflow floors without clipping or losing operator review early", async () => {
  const f = fixture(); await f.fetch({ peer: row(3), [model]: row(1e16) });
  for (let attempt = 0; attempt < 2; attempt++) {
    await f.fetch({ peer: row(3), [model]: row(2000) }); const p = await f.price();
    expect(estimateCall(1, 1, p)).toBe(attempt === 0 ? Number.MAX_SAFE_INTEGER : 18_000);
    expect(settleAmount({ price: p, usage: { ...usage, input: 1, output: 1 }, reservationMicros: 1 }).actualMicros).toBe(attempt === 0 ? Number.MAX_SAFE_INTEGER : 18_000);
  }
});
it("validates unknown-kind floors and unbounded confirmations while rejecting malformed kinds and reasons", async () => {
  const f = fixture(); await f.fetch({ peer: row(3), [model]: row(2000, { mode: "future-chat" }) });
  await f.fetch({ peer: row(3), [model]: row(500, { mode: "future-chat" }) });
  const snapshot = (await f.store.load())!; const source = snapshot.sources.litellm!;
  expect(source.confirmations).toHaveLength(1); expect(validSnapshot(snapshot)).toBe(true);
  for (const invalid of [{ kind: "private" }, { kind: null }, { reason: "private" }, { inputMicrosPerMTok: Infinity }]) {
    const bad = structuredClone(snapshot); Object.assign(bad.sources.litellm!.floors![0]!, invalid); expect(validSnapshot(bad)).toBe(false);
    const badConfirmation = structuredClone(snapshot); Object.assign(badConfirmation.sources.litellm!.confirmations![0]!, invalid); expect(validSnapshot(badConfirmation)).toBe(false);
  }
});
it("processes the full 20,000-row mixed source within one bounded real refresh", async () => {
  const f = fixture(); const rows = Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [i === 0 ? model : `model-${i}`, row(15, i % 2 ? { mode: "future-chat" } : skipped)]));
  const start = performance.now(); await f.fetch(rows); await money(f, 22.5);
  expect((await f.store.load())?.sources.litellm?.floors).toHaveLength(20_000); expect(performance.now() - start).toBeLessThan(5000);
});
it("unknown-kind Bedrock alias floors raise both kinds even when a later alias is classified", async () => {
  const f = fixture(); await f.fetch({
    "us.anthropic.example-v1:0": row(15, { litellm_provider: "bedrock", mode: "future-chat" }),
    "global.anthropic.example-v1:0": row(3, { litellm_provider: "bedrock", ...skipped }),
    embedding: row(1, { litellm_provider: "bedrock", mode: "embedding" }),
  });
  for (const kind of ["chat", "embedding"] as const) expect(await resolvePrice(f.prices, "bedrock", "unlisted", undefined, undefined, kind)).toMatchObject({ inputMicrosPerMTok: 22_500_000, outputMicrosPerMTok: 112_500_000 });
});
it("retention across a later per-request fallback preserves both the flat policy and any dearer prior floor", async () => {
  for (const rate of [15, 2000]) {
    const f = fixture(); await f.fetch({ peer: row(3), [model]: row(rate, skipped) });
    await f.fetch({ peer: row(3), [model]: row(1, { cost_per_request: 1 }) });
    const p = await f.price(); expect(p.inputMicrosPerMTok).toBeGreaterThanOrEqual(Math.max(100, rate * 1.5) * 1e6);
    expect(p.outputMicrosPerMTok).toBeGreaterThanOrEqual(Math.max(100, rate * 7.5) * 1e6);
  }
});
it("confirmation matches output independently of input and retains tiny amounts with upward rounding", async () => {
  const f = fixture(); await f.fetch({ peer: row(3), [model]: row(15, skipped) });
  await f.fetch({ peer: row(3), [model]: row(4, skipped) }); await money(f, 22.5);
  const changedOutput = { peer: row(3), [model]: row(4, { ...skipped, output_cost_per_token: 25e-6 }) };
  await f.fetch(changedOutput); await money(f, 22.5);
  await f.fetch(changedOutput); expect(await f.price()).toMatchObject({ inputMicrosPerMTok: 6e6, outputMicrosPerMTok: 37.5e6 });
  const tiny = fixture(); await tiny.fetch({ peer: row(0.000001), [model]: row(0.000013) });
  await tiny.fetch({ peer: row(0.000001), [model]: row(0.000001, skipped) }); await money(tiny, 0.000013);
});
it("preserves the previous effective floor when its expensive provider peer disappears", async () => {
  const f = fixture(); await f.fetch({ peer: row(30), [model]: row(15, skipped) }); await money(f, 45);
  await f.fetch({ [model]: row(0.5, skipped) }); await money(f, 45);
});
