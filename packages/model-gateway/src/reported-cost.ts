import { record, whole } from "./model-gateway-token.js";
import { MICROS_PER_USD } from "./price-constants.js";
import { usageCost } from "./estimate.js";
import type { ResolvedPrice } from "./price.js";
import type { TokenUsage } from "./usage.js";
/** Assumed OpenRouter final usage.cost USD shape; verify on staging before routing OpenRouter. */
export function parseReportedCost(provider: string, value: unknown): number | undefined {
  if (provider !== "openrouter") return undefined;
  const cost = record(value)?.cost;
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost <= 0) return undefined;
  const micros = Math.ceil(cost * MICROS_PER_USD);
  return whole(micros) && micros > 0 ? micros : undefined;
}
export function validUsage(value: unknown): value is TokenUsage {
  const u = record(value);
  return u !== undefined && [u.input, u.output, u.cacheRead, u.cacheWrite].every((n) => whole(n) && n <= 1_000_000_000);
}
export function hasUsage(usage: TokenUsage): boolean { return usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0; }
export function settleAmount(input: { reportedCostMicros?: number; usage?: TokenUsage; price: ResolvedPrice; reservationMicros: number }): { actualMicros: number; estimated: boolean; usage?: TokenUsage } {
  if (whole(input.reportedCostMicros) && input.reportedCostMicros > 0) return { actualMicros: input.reportedCostMicros, estimated: false };
  if (validUsage(input.usage) && hasUsage(input.usage)) {
    const actualMicros = Math.max(1, usageCost(input.usage, input.price));
    return { actualMicros, estimated: input.price.estimated, ...(input.price.estimated ? { usage: { ...input.usage } } : {}) };
  }
  return { actualMicros: input.reservationMicros, estimated: true };
}
