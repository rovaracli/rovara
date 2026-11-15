import { record, whole } from "./model-gateway-token.js";
import { PRICE_MAX } from "./price-constants.js";
export interface Price { inputMicrosPerMTok: number; outputMicrosPerMTok: number; cacheWriteMicrosPerMTok?: number; operatorReview?: true }
export type PriceKind = "chat" | "embedding";
export interface PriceOrigin { source: "litellm" | "aws" | "override"; fetchedAt: number }
export interface ResolvedPrice extends Price { estimated: boolean; knownTokenPrice?: true }
export interface PriceSource {
  effectiveFor?(provider: string, model: string, kind: PriceKind): ResolvedPrice | Promise<ResolvedPrice>;
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
export { resolvePrice } from "./price-sanity.js";

/** Exact integer ×1.5 without BigInt, saturation before unsafe arithmetic. */
export function cautiousPrice(price: Price): Price {
  const scale = (n: number): number => n > Number.MAX_SAFE_INTEGER - Math.ceil(n / 2) ? Number.MAX_SAFE_INTEGER : n + Math.ceil(n / 2);
  const overflow = price.operatorReview || [price.inputMicrosPerMTok, price.outputMicrosPerMTok, price.cacheWriteMicrosPerMTok ?? price.inputMicrosPerMTok].some((n) => n > Number.MAX_SAFE_INTEGER - Math.ceil(n / 2));
  const input = scale(price.inputMicrosPerMTok);
  return { inputMicrosPerMTok: input, outputMicrosPerMTok: scale(price.outputMicrosPerMTok), cacheWriteMicrosPerMTok: scale(price.cacheWriteMicrosPerMTok ?? price.inputMicrosPerMTok), ...(overflow ? { operatorReview: true } : {}) };
}
