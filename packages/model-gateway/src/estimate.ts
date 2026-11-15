import type { Price } from "./price.js";
import type { TokenUsage } from "./usage.js";
function cost(input: number, output: number, price: Price): number {
  const numerator = BigInt(input) * BigInt(price.inputMicrosPerMTok) + BigInt(output) * BigInt(price.outputMicrosPerMTok);
  const micros = (numerator + 999_999n) / 1_000_000n;
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("request not allowed");
  return Number(micros);
}
export function estimateCall(bytes: number, maxTokens: number, price: Price): number { return cost(bytes, maxTokens, price); }
/** TC-1's narrow price seam has two rates; all cache input counts use its input rate. */
export function usageCost(usage: TokenUsage, price: Price): number { return cost(usage.input + usage.cacheRead + usage.cacheWrite, usage.output, price); }
