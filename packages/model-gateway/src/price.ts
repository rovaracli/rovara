import { record, whole } from "./model-gateway-token.js";
import { CAUTION_FACTOR, FLAT_CEILING_MICROS_PER_MTOK, PRICE_MAX } from "./price-constants.js";
export interface Price { inputMicrosPerMTok: number; outputMicrosPerMTok: number }
export type PriceKind = "chat" | "embedding";
export interface PriceOrigin { source: "litellm" | "aws" | "override"; fetchedAt: number }
export interface ResolvedPrice extends Price { estimated: boolean }
export interface PriceSource {
  priceFor(provider: string, model: string, signal?: AbortSignal): Price | undefined | Promise<Price | undefined>;
  cautiousFor?(provider: string, kind: PriceKind): Price | undefined | Promise<Price | undefined>;
  /** Compatibility with R3a sources; snapshot sources use separate rates and kinds. */
  dearestKnown?(provider: string): number | undefined | Promise<number | undefined>;
}
export const UnknownPriceSource: PriceSource = { priceFor: () => undefined };
export const validRate = (v: unknown, max = PRICE_MAX): v is number => whole(v) && v > 0 && v <= max;
export function validPrice(v: unknown, max = PRICE_MAX): v is Price {
  const p = record(v);
  return p !== undefined && p.estimated !== true && validRate(p.inputMicrosPerMTok, max) && validRate(p.outputMicrosPerMTok, max);
}
export async function resolvePrice(source: PriceSource, provider: string, model: string, ceiling = FLAT_CEILING_MICROS_PER_MTOK, signal?: AbortSignal, kind: PriceKind = "chat"): Promise<ResolvedPrice> {
  try {
    const price = await source.priceFor(provider, model, signal);
    if (validPrice(price)) return { inputMicrosPerMTok: price.inputMicrosPerMTok, outputMicrosPerMTok: price.outputMicrosPerMTok, estimated: false };
  } catch { /* Unknown price never refuses a call. */ }
  try {
    const price = await source.cautiousFor?.(provider, kind);
    if (validPrice(price, Math.ceil(PRICE_MAX * CAUTION_FACTOR))) return { inputMicrosPerMTok: price.inputMicrosPerMTok, outputMicrosPerMTok: price.outputMicrosPerMTok, estimated: true };
    const legacy = await source.dearestKnown?.(provider);
    if (validRate(legacy)) { const rate = Math.ceil(legacy * CAUTION_FACTOR); return { inputMicrosPerMTok: rate, outputMicrosPerMTok: rate, estimated: true }; }
  } catch { /* Keep the configured R3a fallback. */ }
  const fallback = validRate(ceiling) ? ceiling : FLAT_CEILING_MICROS_PER_MTOK;
  return { inputMicrosPerMTok: fallback, outputMicrosPerMTok: fallback, estimated: true };
}
