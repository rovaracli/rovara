import { completePrice, ratesForUsage } from "./price-tiers.js";
import type { Price } from "./price.js";
import type { TokenUsage } from "./usage.js";
export const TOOL_INPUT_ALLOWANCE_TOKENS = 4096;
function roundedCost(numerator: bigint, denominator = 1_000_000n, saturate = false): number {
  const micros = (numerator + denominator - 1n) / denominator;
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) { if (saturate) return Number.MAX_SAFE_INTEGER; throw new Error("request not allowed"); }
  return Number(micros);
}
export function estimateCall(bytes: number, maxTokens: number, price: Price, inputAllowance = 0, plainInput = false): number {
  const complete = completePrice(price);
  if (complete.operatorReview) return Number.MAX_SAFE_INTEGER;
  const rates = [complete, ...(complete.longContext ?? []).filter((t) => t.aboveTokens < bytes + inputAllowance).map((t) => ({ ...complete, ...t }))];
  const input = Math.max(...rates.flatMap((r) => plainInput ? [r.inputMicrosPerMTok] : [r.inputMicrosPerMTok, r.cacheReadMicrosPerMTok!, r.cacheWrite5mMicrosPerMTok!, r.cacheWrite1hMicrosPerMTok!]));
  const output = Math.max(...rates.map((r) => r.outputMicrosPerMTok));
  return roundedCost(BigInt(bytes + inputAllowance) * BigInt(input) + BigInt(maxTokens) * BigInt(output), 1_000_000n, "estimated" in price && price.estimated === true);
}
/** The context threshold counts all prompt tokens; missing write durations use the dearer write tier. */
export function usageCost(usage: TokenUsage, price: Price): number {
  if (completePrice(price).operatorReview) return Number.MAX_SAFE_INTEGER;
  const rates = ratesForUsage(price, usage.input + usage.cacheRead + usage.cacheWrite);
  const fiveMinute = usage.cacheWrite5m ?? 0;
  const hour = usage.cacheWrite1h ?? 0;
  const unknown = usage.cacheWrite - fiveMinute - hour;
  const numerator = BigInt(usage.input) * BigInt(rates.inputMicrosPerMTok) + BigInt(usage.output) * BigInt(rates.outputMicrosPerMTok)
    + BigInt(usage.cacheRead) * BigInt(rates.cacheReadMicrosPerMTok!)
    + BigInt(fiveMinute) * BigInt(rates.cacheWrite5mMicrosPerMTok!) + BigInt(hour) * BigInt(rates.cacheWrite1hMicrosPerMTok!)
    + BigInt(unknown) * BigInt(Math.max(rates.cacheWrite5mMicrosPerMTok!, rates.cacheWrite1hMicrosPerMTok!));
  return roundedCost(numerator, 1_000_000n, "estimated" in price && price.estimated === true);
}
