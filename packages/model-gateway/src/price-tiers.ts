import type { Price, TokenRates } from "./price.js";
export const RATE_KEYS = ["inputMicrosPerMTok", "outputMicrosPerMTok", "cacheReadMicrosPerMTok", "cacheWrite5mMicrosPerMTok", "cacheWrite1hMicrosPerMTok", "cacheWriteMicrosPerMTok"] as const;
export type RateKey = typeof RATE_KEYS[number];
export const CONTEXT_THRESHOLDS = [128_000, 200_000] as const;
export function copyRates(p: Partial<TokenRates>): Partial<TokenRates> {
  const result: Partial<TokenRates> = {};
  for (const key of RATE_KEYS) if (p[key] !== undefined) result[key] = p[key];
  return result;
}
function maxRates(a: Partial<TokenRates>, b: Partial<TokenRates>): Partial<TokenRates> {
  const p = copyRates(a);
  for (const key of RATE_KEYS) if (b[key] !== undefined) p[key] = Math.max(a[key] ?? 0, b[key]);
  return p;
}
export function knownLongRates(p: Price, threshold: number): Partial<TokenRates> {
  let result: Partial<TokenRates> = {};
  for (const tier of p.longContext ?? []) if (tier.aboveTokens <= threshold) result = { ...result, ...copyRates(tier) };
  return result;
}
export function maxPrice(a: Price, b: Price): Price {
  const thresholds = [...new Set([...(a.longContext ?? []), ...(b.longContext ?? [])].map((t) => t.aboveTokens))].sort((x, y) => x - y);
  return { ...maxRates(a, b) as TokenRates,
    ...(thresholds.length ? { longContext: thresholds.map((aboveTokens) => ({ aboveTokens, ...maxRates(knownLongRates(a, aboveTokens), knownLongRates(b, aboveTokens)) })) } : {}),
    ...((a.operatorReview || b.operatorReview) ? { operatorReview: true } : {}) };
}
/** Fill only unknown components, after pooling known observations. Never let a missing alias tier hide a known discount. */
export function completePrice(p: Price, provider?: Price): Price {
  let overflow = !!p.operatorReview;
  const complete = (rates: TokenRates, peer?: Partial<TokenRates>): TokenRates => {
    const doubled = rates.inputMicrosPerMTok * 2;
    if ((rates.cacheWriteMicrosPerMTok === undefined && (rates.cacheWrite5mMicrosPerMTok === undefined || rates.cacheWrite1hMicrosPerMTok === undefined)) && doubled > Number.MAX_SAFE_INTEGER) overflow = true;
    return { ...rates, cacheReadMicrosPerMTok: rates.cacheReadMicrosPerMTok ?? Math.max(rates.inputMicrosPerMTok, peer?.cacheReadMicrosPerMTok ?? 0),
      cacheWrite5mMicrosPerMTok: rates.cacheWrite5mMicrosPerMTok ?? rates.cacheWriteMicrosPerMTok ?? Math.min(Number.MAX_SAFE_INTEGER, doubled),
      cacheWrite1hMicrosPerMTok: rates.cacheWrite1hMicrosPerMTok ?? rates.cacheWriteMicrosPerMTok ?? Math.min(Number.MAX_SAFE_INTEGER, doubled) };
  };
  const base = complete(p, provider);
  const thresholds = [...new Set([...(p.longContext ?? []), ...(provider?.longContext ?? [])].map((t) => t.aboveTokens))].sort((a, b) => a - b);
  const longContext = thresholds.map((aboveTokens) => {
    const own = knownLongRates(p, aboveTokens); const peer = provider === undefined ? {} : knownLongRates(provider, aboveTokens);
    const rates = copyRates(own);
    for (const key of RATE_KEYS) if (rates[key] === undefined && key !== "cacheWriteMicrosPerMTok") {
      rates[key] = Math.max(base[key] ?? 0, peer[key] ?? 0);
    }
    const result = complete(rates as TokenRates, peer);
    return { aboveTokens, ...result };
  });
  return { ...base, ...(longContext.length ? { longContext } : {}), ...(overflow ? { operatorReview: true } : {}) };
}
export function ratesForUsage(p: Price, inputTokens: number): TokenRates {
  const complete = completePrice(p); let rates: TokenRates = complete;
  for (const tier of complete.longContext ?? []) if (inputTokens > tier.aboveTokens) rates = { ...rates, ...copyRates(tier) };
  return rates;
}
/** Published prices already include fallbacks: missing bands mean the active base rate, not missing evidence. */
export function maxEffectivePrice(a: Price, b: Price): Price {
  const x = completePrice(a); const y = completePrice(b);
  const thresholds = [...new Set([...(x.longContext ?? []), ...(y.longContext ?? [])].map((t) => t.aboveTokens))].sort((m, n) => m - n);
  return { ...maxPrice(x, y), ...(thresholds.length ? { longContext: thresholds.map((aboveTokens) => ({ aboveTokens, ...maxRates({ ...copyRates(x), ...knownLongRates(x, aboveTokens) }, { ...copyRates(y), ...knownLongRates(y, aboveTokens) }) })) } : {}) };
}
export function samePrice(a: Price, b: Price): boolean {
  const x = completePrice(a); const y = completePrice(b);
  const thresholds = new Set([...(x.longContext ?? []), ...(y.longContext ?? [])].map((t) => t.aboveTokens));
  return RATE_KEYS.every((k) => x[k] === y[k]) && [...thresholds].every((t) => {
    const xr = { ...copyRates(x), ...knownLongRates(x, t) }; const yr = { ...copyRates(y), ...knownLongRates(y, t) };
    return RATE_KEYS.every((k) => xr[k] === yr[k]);
  }) && !!x.operatorReview === !!y.operatorReview;
}
export function lowerPrice(a: Price, b: Price): boolean { return !samePrice(maxEffectivePrice(a, b), a); }
