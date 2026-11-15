// Ported field patterns and rounding from parked cee95f6c0; DEC 216 changes refusal to unknown.
import { record } from "./model-gateway-token.js";
import { PRICE_MAX, RATE_SCALE, RATE_ROUNDING_TOLERANCE } from "./price-constants.js";
import { CONTEXT_THRESHOLDS, type RateKey } from "./price-tiers.js";
import type { Price, PriceKind, TokenRates } from "./price.js";
/** Known billing dimensions stay separate; unsupported dimensions make the row uncertain. */
function rateField(field: string): { key: RateKey; aboveTokens?: number } | undefined {
  const long = /_above_(128|200)k_tokens/u.exec(field);
  const aboveTokens = long === null ? undefined : Number(long[1]) * 1000;
  const base = field.replace(/_above_(128|200)k_tokens/u, "").replace(/_priority$/u, "");
  let key: RateKey;
  if (/^input_cost_per_(?:token|audio_token|image_token)(?:_batches|_flex)?$/u.test(base)) key = "inputMicrosPerMTok";
  else if (/^output_cost_per_(?:token|audio_token|reasoning_token|image_token)(?:_batches|_flex)?$/u.test(base)) key = "outputMicrosPerMTok";
  else if (base === "cache_read_input_token_cost" || base === "input_cost_per_token_cache_hit") key = "cacheReadMicrosPerMTok";
  else if (base === "cache_creation_input_token_cost") key = "cacheWrite5mMicrosPerMTok";
  else if (base === "cache_creation_input_token_cost_above_1hr") key = "cacheWrite1hMicrosPerMTok";
  else return undefined;
  return { key, ...(aboveTokens === undefined ? {} : { aboveTokens }) };
}
const PER_CALL = /^(?:input_|output_)?cost_per_request$/u;
// Reviewed exceptions: each rule names WHY it does not add to the two token totals. No catch-all price/metadata rule.
export const PRICE_IGNORABLE_FIELDS: Readonly<Record<string, string>> = {
  litellm_provider: "Provider identity is consumed by row mapping.",
  mode: "Mode is consumed by the supported-mode guard.",
  deprecation_date: "Date is consumed by the deprecation guard.",
  max_tokens: "Context capacity does not change the dearest token rate.",
  max_input_tokens: "Input capacity does not change the dearest token rate.",
  max_output_tokens: "Output capacity does not change the dearest token rate.",
  supports_function_calling: "Capability metadata does not price tokens.",
  supports_vision: "Capability metadata does not price tokens; image token rates are handled separately.",
  supports_prompt_caching: "Capability metadata does not price tokens; cache-write rates are handled separately.",
  supports_response_schema: "Capability metadata does not price tokens.",
  cost_per_request: "Presence leaves the model unknown; per-call charges cannot be priced by the token meter.",
  input_cost_per_request: "Presence leaves the model unknown; per-call charges cannot be priced by the token meter.",
  output_cost_per_request: "Presence leaves the model unknown; per-call charges cannot be priced by the token meter.",
};

/** Same classification drives pricing and source completeness: unknown fields are NEVER silently dropped. */
export function priceFieldDisposition(field: string): "input" | "output" | { readonly ignore: string } | undefined {
  const rate = rateField(field);
  if (rate !== undefined) return rate.key === "outputMicrosPerMTok" ? "output" : "input";
  if (Object.hasOwn(PRICE_IGNORABLE_FIELDS, field)) return { ignore: PRICE_IGNORABLE_FIELDS[field]! };
  return undefined;
}

export function rateMicros(value: number): number {
  const scaled = value * RATE_SCALE;
  return Math.ceil(scaled - Math.abs(scaled) * RATE_ROUNDING_TOLERANCE);
}
export function priceKind(mode: unknown): PriceKind | undefined {
  if (mode === "chat" || mode === "responses" || mode === "completion") return "chat";
  return mode === "embedding" ? "embedding" : undefined;
}
export function priceProvider(provider: unknown): string | undefined {
  if (typeof provider !== "string") return undefined;
  if (provider.startsWith("vertex_ai-")) return "vertex";
  if (provider === "bedrock_converse") return "bedrock";
  return ["anthropic", "openai", "gemini", "bedrock", "openrouter"].includes(provider) ? provider : undefined;
}
export function priceDate(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return undefined;
  const n = Date.parse(value);
  return Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === value ? n : undefined;
}
export const tokenRateField = (field: string): boolean => field.includes("token") && (field.includes("cost_per_") || field.includes("token_cost"));
export function ratesOf(value: unknown, now: number): Price | string {
  const entry = record(value);
  if (entry === undefined) return "unsupported entry";
  if (priceKind(entry.mode) === undefined) return "unsupported mode";
  if (entry.deprecation_date !== undefined && entry.deprecation_date !== null) {
    const date = priceDate(entry.deprecation_date);
    if (date === undefined) return "unsupported deprecation date";
    if (date < now) return "deprecated model";
  }
  const baseInput = entry.input_cost_per_token; const baseOutput = entry.output_cost_per_token;
  const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
  if (!finite(baseInput) || baseInput <= 0 || !finite(baseOutput) || baseOutput <= 0) return "missing or invalid base rate";

  for (const [field, rate] of Object.entries(entry)) {
    if (PER_CALL.test(field)) return "unsupported per-request price";
    const disposition = priceFieldDisposition(field);
    if (disposition === undefined && /cost|price/iu.test(field)) return "unsupported price field";
    if (disposition !== "input" && disposition !== "output") continue;
    if (!finite(rate) || rate < 0) return "unsupported token rate";
    if (rate > PRICE_MAX / RATE_SCALE) return "token rate exceeds maximum";

  }
  return collectRates(entry, false);
}

/** Known token tiers survive classification failure; no arithmetic may discard an expensive model. */
export function knownRates(value: unknown): (Price & { operatorReview?: true }) | undefined {
  const row = record(value);
  if (row === undefined || typeof row.input_cost_per_token !== "number" || !Number.isFinite(row.input_cost_per_token) || row.input_cost_per_token <= 0 || typeof row.output_cost_per_token !== "number" || !Number.isFinite(row.output_cost_per_token) || row.output_cost_per_token <= 0) return undefined;
  return collectRates(row, true);
}
function collectRates(row: Record<string, unknown>, uncertain: boolean): Price {
  const base: Partial<TokenRates> = {}; const bands = new Map<number, Partial<TokenRates>>(); let overflow = false;
  for (const [field, value] of Object.entries(row)) {
    const target = rateField(field);
    if (target === undefined || typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
    const rates = target.aboveTokens === undefined ? base : bands.get(target.aboveTokens) ?? {};
    overflow ||= value > Number.MAX_SAFE_INTEGER / RATE_SCALE;
    const converted = uncertain ? Math.ceil(value * RATE_SCALE) : rateMicros(value);
    rates[target.key] = Math.max(rates[target.key] ?? 0, Math.min(Number.MAX_SAFE_INTEGER, converted));
    if (target.aboveTokens !== undefined) bands.set(target.aboveTokens, rates);
  }
  const longContext = CONTEXT_THRESHOLDS.filter((t) => bands.has(t)).map((aboveTokens) => ({ aboveTokens, ...bands.get(aboveTokens)! }));
  return { ...base as TokenRates, ...(longContext.length ? { longContext } : {}), ...(overflow ? { operatorReview: true } : {}) };
}
