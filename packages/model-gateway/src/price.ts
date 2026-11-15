import { record, whole } from "./model-gateway-token.js";
import { CAUTION_FACTOR, FLAT_CEILING_MICROS_PER_MTOK, PRICE_MAX } from "./price-constants.js";
export interface Price { inputMicrosPerMTok: number; outputMicrosPerMTok: number; cacheWriteMicrosPerMTok?: number; operatorReview?: true }
export type PriceKind = "chat" | "embedding";
export interface PriceOrigin { source: "litellm" | "aws" | "override"; fetchedAt: number }
export interface ResolvedPrice extends Price { estimated: boolean }
export interface PriceSource {
  priceFor(provider: string, model: string, signal?: AbortSignal): Price | undefined | Promise<Price | undefined>;
  floorFor?(provider: string, model: string): Price | undefined | Promise<Price | undefined>;
  fallbackFor?(provider: string, model: string): "per_request_price" | undefined | Promise<"per_request_price" | undefined>;
  cautiousFor?(provider: string, kind: PriceKind): Price | undefined | Promise<Price | undefined>;
  /** Compatibility with R3a sources; snapshot sources use separate rates and kinds. */
  dearestKnown?(provider: string): number | undefined | Promise<number | undefined>;
}
export const UnknownPriceSource: PriceSource = { priceFor: () => undefined };
export const validRate = (v: unknown, max = PRICE_MAX): v is number => whole(v) && v > 0 && v <= max;
export function validPrice(v: unknown, max = PRICE_MAX): v is Price {
  const p = record(v);
  return p !== undefined && p.estimated !== true && (p.operatorReview === undefined || p.operatorReview === true) && validRate(p.inputMicrosPerMTok, max) && validRate(p.outputMicrosPerMTok, max) && (p.cacheWriteMicrosPerMTok === undefined || validRate(p.cacheWriteMicrosPerMTok, max));
}
export async function resolvePrice(source: PriceSource, provider: string, model: string, ceiling = FLAT_CEILING_MICROS_PER_MTOK, signal?: AbortSignal, kind: PriceKind = "chat"): Promise<ResolvedPrice> {
  const flat: ResolvedPrice = { inputMicrosPerMTok: FLAT_CEILING_MICROS_PER_MTOK, outputMicrosPerMTok: FLAT_CEILING_MICROS_PER_MTOK, estimated: true };
  try { if (await source.fallbackFor?.(provider, model) !== undefined) return flat; }
  catch { return flat; } // Unreadable model policy never falls back to a cheaper provider estimate.
  let floor: Price | undefined;
  const review: ResolvedPrice = { inputMicrosPerMTok: Number.MAX_SAFE_INTEGER, outputMicrosPerMTok: Number.MAX_SAFE_INTEGER, estimated: true, operatorReview: true };
  try {
    const value = await source.floorFor?.(provider, model);
    if (value !== undefined) { if (!validPrice(value, Number.MAX_SAFE_INTEGER)) return review; floor = value; }
  } catch { return review; }
  const estimatedPrice = (p: Price): ResolvedPrice => ({ inputMicrosPerMTok: Math.max(p.inputMicrosPerMTok, floor?.inputMicrosPerMTok ?? 0), outputMicrosPerMTok: Math.max(p.outputMicrosPerMTok, floor?.outputMicrosPerMTok ?? 0), ...((p.cacheWriteMicrosPerMTok ?? floor?.cacheWriteMicrosPerMTok) === undefined ? {} : { cacheWriteMicrosPerMTok: Math.max(p.cacheWriteMicrosPerMTok ?? p.inputMicrosPerMTok, floor?.cacheWriteMicrosPerMTok ?? floor?.inputMicrosPerMTok ?? 0) }), ...((p.operatorReview || floor?.operatorReview) ? { operatorReview: true as const } : {}), estimated: true });
  try {
    const price = await source.priceFor(provider, model, signal);
    if (floor === undefined && validPrice(price)) return { inputMicrosPerMTok: price.inputMicrosPerMTok, outputMicrosPerMTok: price.outputMicrosPerMTok, ...(price.cacheWriteMicrosPerMTok === undefined ? {} : { cacheWriteMicrosPerMTok: price.cacheWriteMicrosPerMTok }), estimated: false };
  } catch { /* Unknown price never refuses a call. */ }
  try {
    const price = await source.cautiousFor?.(provider, kind);
    if (validPrice(price, Number.MAX_SAFE_INTEGER)) return estimatedPrice(price);
    const legacy = await source.dearestKnown?.(provider);
    if (validRate(legacy)) { const rate = Math.ceil(legacy * CAUTION_FACTOR); return estimatedPrice({ inputMicrosPerMTok: rate, outputMicrosPerMTok: rate }); }
  } catch { /* Keep the configured R3a fallback. */ }
  if (floor !== undefined) return estimatedPrice(floor);
  const fallback = validRate(ceiling) ? ceiling : FLAT_CEILING_MICROS_PER_MTOK;
  return { inputMicrosPerMTok: fallback, outputMicrosPerMTok: fallback, estimated: true };
}

/** Exact integer ×1.5 without BigInt, saturation before unsafe arithmetic. */
export function cautiousPrice(price: Price): Price {
  const scale = (n: number): number => n > Number.MAX_SAFE_INTEGER - Math.ceil(n / 2) ? Number.MAX_SAFE_INTEGER : n + Math.ceil(n / 2);
  const overflow = price.operatorReview || [price.inputMicrosPerMTok, price.outputMicrosPerMTok].some((n) => n > Number.MAX_SAFE_INTEGER - Math.ceil(n / 2));
  const input = scale(price.inputMicrosPerMTok);
  return { inputMicrosPerMTok: input, outputMicrosPerMTok: scale(price.outputMicrosPerMTok), cacheWriteMicrosPerMTok: input, ...(overflow ? { operatorReview: true } : {}) };
}
