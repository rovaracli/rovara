import { record, whole } from "./model-gateway-token.js";
import { MAX_ENTRIES_PER_SOURCE, MAX_MODEL_LENGTH } from "./price-constants.js";
import { validPrice, type Price, type PriceKind } from "./price.js";
export interface PriceEntry extends Price { provider: string; model: string; kind: PriceKind }
export interface PriceKey { provider: string; model: string }
export interface ModelFallback extends PriceKey { reason: "per_request_price" }
export interface SourceSnapshot { fetchedAt: number; count: number; entries: PriceEntry[]; fallbacks?: ModelFallback[] }
export interface PriceSnapshot { version: number; sources: { litellm?: SourceSnapshot; aws?: SourceSnapshot } }
export interface PriceSnapshotStore { load(): Promise<PriceSnapshot | undefined>; save(snapshot: PriceSnapshot, expectedVersion: number): Promise<boolean> }
export const priceKey = (key: PriceKey): string => JSON.stringify([key.provider, key.model]);
export function validEntry(value: unknown): value is PriceEntry {
  const v = record(value);
  return v !== undefined && validPrice(v) && typeof v.provider === "string" && ["anthropic", "openai", "gemini", "vertex", "bedrock", "openrouter"].includes(v.provider) && typeof v.model === "string" && v.model.length > 0 && v.model.length <= MAX_MODEL_LENGTH && ![...v.model].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) && (v.kind === "chat" || v.kind === "embedding");
}
export function validFallback(value: unknown): value is ModelFallback {
  const v = record(value);
  return v !== undefined && v.reason === "per_request_price" && validEntry({ ...v, kind: "chat", inputMicrosPerMTok: 1, outputMicrosPerMTok: 1 });
}
export function validSnapshot(value: unknown): value is PriceSnapshot {
  const v = record(value); const sources = record(v?.sources);
  if (v === undefined || !whole(v.version) || sources === undefined || Object.keys(sources).some((key) => key !== "litellm" && key !== "aws")) return false;
  for (const name of ["litellm", "aws"] as const) {
    if (sources[name] === undefined) continue;
    const s = record(sources[name]);
    if (s === undefined || !whole(s.fetchedAt) || !Array.isArray(s.entries) || s.entries.length > MAX_ENTRIES_PER_SOURCE || s.count !== s.entries.length) return false;
    if (s.fallbacks !== undefined && (!Array.isArray(s.fallbacks) || s.entries.length + s.fallbacks.length > MAX_ENTRIES_PER_SOURCE)) return false;
    const seen = new Set<string>();
    for (const e of s.entries as unknown[]) {
      if (!validEntry(e) || (name === "aws" && e.provider !== "bedrock") || seen.has(priceKey(e))) return false;
      seen.add(priceKey(e));
    }
    for (const f of (s.fallbacks ?? []) as unknown[]) {
      if (!validFallback(f) || (name === "aws" && f.provider !== "bedrock") || seen.has(priceKey(f))) return false;
      seen.add(priceKey(f));
    }
  }
  return true;
}
/** Adapter contract: version-conditional save, deep copies, no partial source write. */
export class InMemoryPriceSnapshotStore implements PriceSnapshotStore {
  #snapshot: PriceSnapshot | undefined;
  async load(): Promise<PriceSnapshot | undefined> { return this.#snapshot === undefined ? undefined : structuredClone(this.#snapshot); }
  async save(snapshot: PriceSnapshot, expectedVersion: number): Promise<boolean> {
    if (!validSnapshot(snapshot) || !whole(expectedVersion) || snapshot.version !== expectedVersion + 1 || (this.#snapshot?.version ?? 0) !== expectedVersion) return false;
    this.#snapshot = structuredClone(snapshot); return true;
  }
}
