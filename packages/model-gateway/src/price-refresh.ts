import { whole } from "./model-gateway-token.js";
import { REFRESH_INTERVAL_MS, REFRESH_JITTER, RETRY_MS } from "./price-constants.js";
import type { SnapshotPriceSource } from "./price-index.js";
import { priceKey, validSnapshot, type PriceEntry, type PriceKey, type PriceSnapshotStore } from "./price-snapshot.js";
import type { PriceFetchResult } from "./price-sources.js";
export interface RefreshResult { ok: boolean; gained: number }
export class PriceRefresher {
  #flight: Promise<RefreshResult> | undefined;
  constructor(private readonly options: { store: PriceSnapshotStore; prices: SnapshotPriceSource; litellm: (previous: readonly PriceEntry[]) => Promise<PriceFetchResult>; aws: (previous: readonly PriceEntry[]) => Promise<PriceFetchResult>; correctedKeys?: (keys: readonly PriceKey[]) => Promise<void> }) {}
  run(now: number): Promise<RefreshResult> {
    if (this.#flight !== undefined) return this.#flight;
    this.#flight = this.#run(now).catch(() => ({ ok: false, gained: 0 })).finally(() => { this.#flight = undefined; });
    return this.#flight;
  }
  async #run(now: number): Promise<RefreshResult> {
    if (!whole(now)) return { ok: false, gained: 0 };
    const { store, prices } = this.options; const prior = await store.load();
    if (prior !== undefined && !validSnapshot(prior)) return { ok: false, gained: 0 };
    const sources = structuredClone(prior?.sources ?? {}); const known = new Set(prices.keys().map(priceKey));
    const names = ["litellm", "aws"] as const;
    const results = await Promise.all(names.map(async (name) => { try { return await this.options[name](prior?.sources[name]?.entries ?? []); } catch { return { ok: false as const, reason: "refresh failed" }; } }));
    let ok = true; let changed = false;
    for (const [i, name] of names.entries()) {
      const r = results[i]!;
      const candidate = r.ok ? { version: 1, sources: { [name]: { fetchedAt: now, count: r.entries.length, entries: r.entries, ...(r.fallbacks === undefined ? {} : { fallbacks: r.fallbacks }) } } } : undefined;
      const success = candidate !== undefined && validSnapshot(candidate) && r.ok && r.entries.length > 0 && now >= (prior?.sources[name]?.fetchedAt ?? 0);
      prices.failure(name, !success);
      if (!success || !r.ok) { ok = false; continue; }
      sources[name] = { fetchedAt: now, count: r.entries.length, entries: r.entries, ...(r.fallbacks === undefined ? {} : { fallbacks: r.fallbacks }) }; changed = true;
    }
    if (changed && !await store.save({ version: (prior?.version ?? 0) + 1, sources }, prior?.version ?? 0)) return { ok: false, gained: 0 };
    await prices.reload();
    const gained = prices.keys().filter((key) => !known.has(priceKey(key)));
    // Also call on a no-gain run so a prior bounded correction run can continue.
    await this.options.correctedKeys?.(gained);
    return { ok, gained: gained.length };
  }
}
export interface PriceTimers { setTimer(fn: () => void, ms: number): { unref?(): void }; clearTimer(timer: { unref?(): void }): void }
export function startPriceRefresh(options: { refresher: Pick<PriceRefresher, "run">; timers: PriceTimers; intervalMs?: number; retryMs?: number; random?: () => number; now?: () => number }): { stop(): void } {
  let stopped = false; let timer: { unref?(): void } | undefined;
  const interval = whole(options.intervalMs) && options.intervalMs > 0 ? options.intervalMs : REFRESH_INTERVAL_MS;
  const retry = whole(options.retryMs) && options.retryMs > 0 ? options.retryMs : RETRY_MS;
  const run = async (): Promise<void> => {
    if (stopped) return;
    let ok = false;
    try { ok = (await options.refresher.run((options.now ?? Date.now)())).ok; } catch { /* Schedule a retry, fixed result. */ }
    if (stopped) return;
    let random = 0; try { random = (options.random ?? Math.random)(); } catch { /* Zero jitter is safe. */ }
    if (!Number.isFinite(random) || random < 0 || random > 1) random = 0;
    try { timer = options.timers.setTimer(() => { void run(); }, Math.ceil((ok ? interval : retry) * (1 - random * REFRESH_JITTER))); timer.unref?.(); } catch { stopped = true; }
  };
  void run();
  return { stop() { stopped = true; if (timer !== undefined) options.timers.clearTimer(timer); } };
}
