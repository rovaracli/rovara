import type { Price } from "./price.js";
import type { TokenUsage } from "./usage.js";
export const TOOL_INPUT_ALLOWANCE_TOKENS = 4096;
function roundedCost(numerator: bigint, denominator = 1_000_000n, saturate = false): number {
  const micros = (numerator + denominator - 1n) / denominator;
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) { if (saturate) return Number.MAX_SAFE_INTEGER; throw new Error("request not allowed"); }
  return Number(micros);
}
export function estimateCall(bytes: number, maxTokens: number, price: Price, inputAllowance = 0): number {
  if (price.operatorReview) return Number.MAX_SAFE_INTEGER;
  return roundedCost(BigInt(bytes + inputAllowance) * BigInt(price.inputMicrosPerMTok) + BigInt(maxTokens) * BigInt(price.outputMicrosPerMTok), 1_000_000n, "estimated" in price && price.estimated === true);
}
/** Missing tier counts are billed at the higher one-hour rate, never the plain input rate. */
export function usageCost(usage: TokenUsage, price: Price): number {
  if (price.operatorReview) return Number.MAX_SAFE_INTEGER;
  const fiveMinute = usage.cacheWrite5m ?? 0;
  const otherWrites = usage.cacheWrite - fiveMinute;
  const writes = price.cacheWriteMicrosPerMTok === undefined
    ? (BigInt(fiveMinute) * 5n + BigInt(otherWrites) * 8n) * BigInt(price.inputMicrosPerMTok)
    : BigInt(usage.cacheWrite) * BigInt(price.cacheWriteMicrosPerMTok) * 4n;
  return roundedCost((BigInt(usage.input + usage.cacheRead) * BigInt(price.inputMicrosPerMTok) + BigInt(usage.output) * BigInt(price.outputMicrosPerMTok)) * 4n + writes, 4_000_000n, "estimated" in price && price.estimated === true);
}
