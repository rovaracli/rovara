import { record, whole } from "./model-gateway-token.js";
export interface Price { inputMicrosPerMTok: number; outputMicrosPerMTok: number; cacheWriteMicrosPerMTok?: number }
export interface ResolvedPrice extends Price { estimated: boolean }
export interface PriceSource {
  priceFor(provider: string, model: string, signal?: AbortSignal): Price | undefined | Promise<Price | undefined>;
  dearestKnown?(provider: string): number | undefined | Promise<number | undefined>;
}
export const UnknownPriceSource: PriceSource = { priceFor: () => undefined };
const rate = (v: unknown): v is number => whole(v) && v > 0 && v <= 1_000_000_000;
export async function resolvePrice(source: PriceSource, provider: string, model: string, ceiling = 100_000_000, signal?: AbortSignal): Promise<ResolvedPrice> {
  try {
    const price = record(await source.priceFor(provider, model, signal));
    if (price !== undefined && rate(price.inputMicrosPerMTok) && rate(price.outputMicrosPerMTok) && (price.cacheWriteMicrosPerMTok === undefined || rate(price.cacheWriteMicrosPerMTok))) return { inputMicrosPerMTok: price.inputMicrosPerMTok, outputMicrosPerMTok: price.outputMicrosPerMTok, ...(price.cacheWriteMicrosPerMTok === undefined ? {} : { cacheWriteMicrosPerMTok: price.cacheWriteMicrosPerMTok }), estimated: false };
  } catch { /* Unknown price never refuses a call. */ }
  let cautious = rate(ceiling) ? ceiling : 100_000_000;
  try { const dearest = await source.dearestKnown?.(provider); if (rate(dearest)) cautious = Math.max(cautious, Math.ceil(dearest * 1.5)); } catch { /* Keep the configured ceiling. */ }
  return { inputMicrosPerMTok: cautious, outputMicrosPerMTok: cautious, estimated: true };
}
