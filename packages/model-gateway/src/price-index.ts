import { STALE_ALARM_MS } from "./price-constants.js";
import { type Price, type PriceKind, type PriceOrigin, type PriceSource, type ResolvedPrice } from "./price.js";
import { PRICE_OVERRIDES, validOverrides } from "./price-overrides.js";
import { validSnapshot, type PriceSnapshot, type PriceSnapshotStore } from "./price-snapshot.js";
import { identityKey } from "./price-identity.js";
import { priceBook, lookupPrice } from "./price-sanity.js";
export interface SourceHealth { fetchedAt?: number; ageMs?: number; count: number; stale: boolean; lastFailure?: string }
export class SnapshotPriceSource implements PriceSource {
  #book = priceBook(undefined);
  #snapshot: PriceSnapshot | undefined;
  #failures: { litellm?: string; aws?: string } = {};
  #redundant = 0;
  #expiresAt = Infinity;
  constructor(private readonly store: PriceSnapshotStore, private readonly options: { now?: () => number; overrides?: readonly unknown[] } = {}) {}
  #now(): number { return (this.options.now ?? Date.now)(); }
  async reload(): Promise<void> {
    let snapshot: PriceSnapshot | undefined;
    try { snapshot = await this.store.load(); } catch { return; }
    if (snapshot !== undefined && !validSnapshot(snapshot)) return;
    if (snapshot !== undefined && this.#snapshot !== undefined && snapshot.version < this.#snapshot.version) return;
    this.#build(snapshot);
  }
  #build(snapshot: PriceSnapshot | undefined): void {
    const overrides = validOverrides(this.options.overrides ?? PRICE_OVERRIDES, this.#now()).map((e) => ({ ...e, origin: { source: "override" as const, fetchedAt: e.verifiedAt } }));
    this.#book = priceBook(snapshot, overrides); this.#snapshot = snapshot;
    this.#redundant = this.#book.redundantOverrides; this.#expiresAt = this.#book.expiresAt;
  }
  effectiveFor(provider: string, model: string, kind: PriceKind): ResolvedPrice {
    if (this.#now() >= this.#expiresAt) this.#build(this.#snapshot);
    return lookupPrice(this.#book, provider, model, kind);
  }
  priceFor(provider: string, model: string): (Price & { origin: PriceOrigin }) | undefined {
    if (this.#now() >= this.#expiresAt) this.#build(this.#snapshot);
    const p = this.#book.index.get(identityKey(provider, model));
    if (p === undefined || p.estimated) return undefined;
    return { inputMicrosPerMTok: p.inputMicrosPerMTok, outputMicrosPerMTok: p.outputMicrosPerMTok, ...(p.cacheWriteMicrosPerMTok === undefined ? {} : { cacheWriteMicrosPerMTok: p.cacheWriteMicrosPerMTok }), origin: { ...p.origin } };
  }
  keys(): Array<{ provider: string; model: string }> { return [...this.#book.index.values()].filter((e) => !e.estimated).map(({ provider, model }) => ({ provider, model })); }
  failure(source: "litellm" | "aws", failed: boolean): void { if (failed) this.#failures[source] = "refresh failed"; else delete this.#failures[source]; }
  health(): { litellm: SourceHealth; aws: SourceHealth; redundantOverrides: number } {
    const result = (name: "litellm" | "aws"): SourceHealth => {
      const s = this.#snapshot?.sources[name]; const ageMs = s === undefined ? undefined : Math.max(0, this.#now() - s.fetchedAt);
      return { count: s?.count ?? 0, stale: ageMs === undefined || ageMs > STALE_ALARM_MS, ...(s === undefined ? {} : { fetchedAt: s.fetchedAt, ageMs: ageMs! }), ...(this.#failures[name] === undefined ? {} : { lastFailure: this.#failures[name] }) };
    };
    return { litellm: result("litellm"), aws: result("aws"), redundantOverrides: this.#redundant };
  }
}
