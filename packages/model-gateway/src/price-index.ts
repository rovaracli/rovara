import { CAUTION_FACTOR, PRICE_MAX, STALE_ALARM_MS } from "./price-constants.js";
import { validPrice, type Price, type PriceKind, type PriceOrigin, type PriceSource } from "./price.js";
import { PRICE_OVERRIDES, validOverrides } from "./price-overrides.js";
import { priceKey, validSnapshot, type PriceEntry, type PriceSnapshot, type PriceSnapshotStore } from "./price-snapshot.js";
import { normalizeBedrockModel } from "./price-sources.js";
export interface SourceHealth { fetchedAt?: number; ageMs?: number; count: number; stale: boolean; lastFailure?: string }
export class SnapshotPriceSource implements PriceSource {
  #index = new Map<string, PriceEntry & { origin: PriceOrigin }>();
  #fallbacks = new Set<string>();
  #maxima = new Map<string, Price>();
  #snapshot: PriceSnapshot | undefined;
  #failures: { litellm?: string; aws?: string } = {};
  #redundant = 0;
  #expiresAt = Infinity;
  constructor(private readonly store: PriceSnapshotStore, private readonly options: { now?: () => number; overrides?: readonly unknown[] } = {}) {}
  #now(): number { return (this.options.now ?? Date.now)(); }
  #key(provider: string, model: string): string { return priceKey({ provider, model: provider === "bedrock" ? normalizeBedrockModel(model) : model }); }
  async reload(): Promise<void> {
    let snapshot: PriceSnapshot | undefined;
    try { snapshot = await this.store.load(); } catch { return; }
    if (snapshot !== undefined && !validSnapshot(snapshot)) return;
    if (snapshot !== undefined && this.#snapshot !== undefined && snapshot.version < this.#snapshot.version) return;
    this.#build(snapshot);
  }
  #build(snapshot: PriceSnapshot | undefined): void {
    const index = new Map<string, PriceEntry & { origin: PriceOrigin }>();
    const fallbacks = new Set<string>();
    for (const source of Object.values(snapshot?.sources ?? {})) for (const f of source.fallbacks ?? []) fallbacks.add(this.#key(f.provider, f.model));
    let expiresAt = Infinity;
    for (const name of ["litellm", "aws"] as const) {
      const s = snapshot?.sources[name]; if (s === undefined) continue;
      for (const e of s.entries) {
        const key = this.#key(e.provider, e.model); if (fallbacks.has(key)) continue; const prior = index.get(key);
        const sameSource = prior?.origin.source === name;
        index.set(key, { ...e, inputMicrosPerMTok: sameSource ? Math.max(prior.inputMicrosPerMTok, e.inputMicrosPerMTok) : e.inputMicrosPerMTok, outputMicrosPerMTok: sameSource ? Math.max(prior.outputMicrosPerMTok, e.outputMicrosPerMTok) : e.outputMicrosPerMTok, origin: { source: name, fetchedAt: s.fetchedAt } });
      }
    }
    let redundant = 0;
    for (const e of validOverrides(this.options.overrides ?? PRICE_OVERRIDES, this.#now())) {
      const key = this.#key(e.provider, e.model);
      if (index.has(key) || fallbacks.has(key)) { redundant++; continue; }
      expiresAt = Math.min(expiresAt, e.expiresAt);
      index.set(key, { ...e, origin: { source: "override", fetchedAt: e.verifiedAt } });
    }
    const maxima = new Map<string, Price>();
    for (const e of index.values()) for (const kind of [e.kind, "all"]) {
      const key = JSON.stringify([e.provider, kind]); const prior = maxima.get(key);
      maxima.set(key, { inputMicrosPerMTok: Math.max(prior?.inputMicrosPerMTok ?? 0, e.inputMicrosPerMTok), outputMicrosPerMTok: Math.max(prior?.outputMicrosPerMTok ?? 0, e.outputMicrosPerMTok) });
    }
    this.#fallbacks = fallbacks; this.#index = index; this.#maxima = maxima; this.#snapshot = snapshot; this.#redundant = redundant; this.#expiresAt = expiresAt;
  }
  priceFor(provider: string, model: string): (Price & { origin: PriceOrigin }) | undefined {
    if (this.#now() >= this.#expiresAt) this.#build(this.#snapshot);
    const p = this.#index.get(this.#key(provider, model));
    return p === undefined ? undefined : { inputMicrosPerMTok: p.inputMicrosPerMTok, outputMicrosPerMTok: p.outputMicrosPerMTok, cacheWriteMicrosPerMTok: p.inputMicrosPerMTok, origin: { ...p.origin } };
  }
  fallbackFor(provider: string, model: string): "per_request_price" | undefined {
    return this.#fallbacks.has(this.#key(provider, model)) ? "per_request_price" : undefined;
  }
  cautiousFor(provider: string, kind: PriceKind): Price | undefined {
    if (this.#now() >= this.#expiresAt) this.#build(this.#snapshot);
    const p = this.#maxima.get(JSON.stringify([provider, kind])) ?? this.#maxima.get(JSON.stringify([provider, "all"]));
    if (!validPrice(p)) return undefined;
    return { cacheWriteMicrosPerMTok: Math.min(Math.ceil(PRICE_MAX * CAUTION_FACTOR), Math.ceil(p.inputMicrosPerMTok * CAUTION_FACTOR)), inputMicrosPerMTok: Math.min(Math.ceil(PRICE_MAX * CAUTION_FACTOR), Math.ceil(p.inputMicrosPerMTok * CAUTION_FACTOR)), outputMicrosPerMTok: Math.min(Math.ceil(PRICE_MAX * CAUTION_FACTOR), Math.ceil(p.outputMicrosPerMTok * CAUTION_FACTOR)) };
  }
  keys(): Array<{ provider: string; model: string }> { return [...this.#index.values()].map(({ provider, model }) => ({ provider, model })); }
  failure(source: "litellm" | "aws", failed: boolean): void { if (failed) this.#failures[source] = "refresh failed"; else delete this.#failures[source]; }
  health(): { litellm: SourceHealth; aws: SourceHealth; redundantOverrides: number } {
    const result = (name: "litellm" | "aws"): SourceHealth => {
      const s = this.#snapshot?.sources[name]; const ageMs = s === undefined ? undefined : Math.max(0, this.#now() - s.fetchedAt);
      return { count: s?.count ?? 0, stale: ageMs === undefined || ageMs > STALE_ALARM_MS, ...(s === undefined ? {} : { fetchedAt: s.fetchedAt, ageMs: ageMs! }), ...(this.#failures[name] === undefined ? {} : { lastFailure: this.#failures[name] }) };
    };
    return { litellm: result("litellm"), aws: result("aws"), redundantOverrides: this.#redundant };
  }
}
