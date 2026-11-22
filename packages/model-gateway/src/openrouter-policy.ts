// Private release tariff, populated ONLY from a passed, reviewed live qualification.
import { createHash } from "node:crypto";
import { record, whole } from "./model-gateway-token.js";
export const OPENROUTER_PRICE_KEYS = ["prompt", "completion", "internal_reasoning", "request", "input_cache_read", "input_cache_write"] as const;
export const OPENROUTER_CACHE_WRITE_ENFORCEMENT_VERSION = "openrouter-no-cache-write-v1";
export type OpenRouterPrices = Record<typeof OPENROUTER_PRICE_KEYS[number], string>;
export interface OpenRouterTariff {
 model: string; route: string; pricing: OpenRouterPrices;
 max_completion_tokens: number;
 reasoning: { mode: "disabled" } | { mode: "bounded"; max_tokens: number };
 verifiedAt: number; expiresAt: number; evidence: string;
 cacheWriteBasis?: "never_requested_enforced"; cacheWriteEnforcementVersion?: string;
}
export interface OpenRouterPolicy extends OpenRouterTariff { hash: string }
export const REVIEWED_OPENROUTER_POLICIES: readonly OpenRouterTariff[] = Object.freeze([]);
/** Review queue in the private tariff source, never an installed/default price list.
 * Promotion is a reviewed source edit: remove the candidate label and place the approved,
 * still-fresh row in REVIEWED_OPENROUTER_POLICIES. Never import qualification output automatically.
 */
export const CANDIDATE_OPENROUTER_POLICIES: readonly (OpenRouterTariff & { status: "CANDIDATE" })[] = Object.freeze([
 {
  "model": "openai/gpt-5-mini",
  "route": "openai",
  "pricing": {
   "prompt": "0.00000025",
   "completion": "0.000002",
   "internal_reasoning": "0",
   "request": "0",
   "input_cache_read": "0.000000025",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 4096,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795308743993,
  "expiresAt": 1795395143993,
  "evidence": "CANDIDATE ONLY: briefs/codex/providers-fast/M2-LIVE-REPORT-run8.json; owner run 8 on ef670ae9b; reviewed promotion and installed staging proof required",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1",
  "status": "CANDIDATE"
 },
 {
  "model": "openai/gpt-5-nano",
  "route": "openai",
  "pricing": {
   "prompt": "0.00000005",
   "completion": "0.0000004",
   "internal_reasoning": "0",
   "request": "0",
   "input_cache_read": "0.000000005",
   "input_cache_write": "0"
  },
  "max_completion_tokens": 4096,
  "reasoning": {
   "mode": "bounded",
   "max_tokens": 1024
  },
  "verifiedAt": 1795308801625,
  "expiresAt": 1795395201625,
  "evidence": "CANDIDATE ONLY: briefs/codex/providers-fast/M2-LIVE-REPORT-run8.json; owner run 8 on ef670ae9b; reviewed promotion and installed staging proof required",
  "cacheWriteBasis": "never_requested_enforced",
  "cacheWriteEnforcementVersion": "openrouter-no-cache-write-v1",
  "status": "CANDIDATE"
 }
]);

/** Reviewed exception scope, NOT installed tariffs or live qualification. Exact IDs only.
 * Evidence/limits: docs/model-gateway-spend-limits.md#openrouter-tariff-exceptions. Never infer
 * absent-price semantics or opt-in-only search for another model/provider.
 */
export const OPENROUTER_RELAXED_TARIFF_MODELS = Object.freeze({
 "openai/gpt-5-mini": "Search requires a refused explicit tool/plugin. Absent write prices require versioned request enforcement and refusal of reported writes.",
 "openai/gpt-5-nano": "Search requires a refused explicit tool/plugin. Absent write prices require versioned request enforcement and refusal of reported writes.",
});
const SCALE = 10n ** 18n;
/** USD at 18 decimal places, no binary floating arithmetic. Refuse excess precision. */
export function openRouterDecimal(value: string): bigint {
 const m = /^(\d{1,24})(?:\.(\d{1,24}))?(?:e([+-]?\d{1,2}))?$/iu.exec(value);
 if (!m) throw new Error("unbounded tariff");
 const digits = BigInt(m[1]! + (m[2] ?? ""));
 const power = 18 + Number(m[3] ?? 0) - (m[2]?.length ?? 0);
 if (Math.abs(power) > 60) throw new Error("unbounded tariff");
 if (power < 0 && digits % (10n ** BigInt(-power)) !== 0n) throw new Error("unbounded tariff");
 return power < 0 ? digits / (10n ** BigInt(-power)) : digits * 10n ** BigInt(power);
}
function decimalText(value: bigint, places: number): string {
 const s = value.toString().padStart(places + 1, "0");
 return places === 0 ? s : `${s.slice(0, -places)}.${s.slice(-places)}`.replace(/\.?0+$/u, "");
}
/** Models pricing is USD/token; provider.max_price is USD/M tokens. */
export function perMillionPrice(value: string): string { return decimalText(openRouterDecimal(value), 12); }
function wireNumber(value: string): number {
 const n = Number(value);
 // JSON's shortest number spelling must describe exactly the intended decimal.
 if (!Number.isFinite(n) || openRouterDecimal(String(n)) !== openRouterDecimal(value)) throw new Error("unrepresentable price cap");
 return n;
}
export function openRouterPolicy(model: string, now: number, rows: readonly OpenRouterTariff[] = REVIEWED_OPENROUTER_POLICIES): OpenRouterPolicy | undefined {
 const matches = rows.filter(r => r.model === model);
 if (matches.length !== 1) return undefined;
 const r = matches[0]!;
 // Even explicit injection cannot promote a labelled review candidate into active pricing.
 if (record(r)?.status !== undefined) return undefined;
 if (r.model.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(r.model) || r.model.startsWith("openrouter/") ||
     !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(r.route) ||
     !whole(now) || !whole(r.verifiedAt) || !whole(r.expiresAt) || r.verifiedAt > now || r.expiresAt <= now || r.expiresAt - r.verifiedAt > 86_400_000 ||
     !whole(r.max_completion_tokens) || r.max_completion_tokens < 1 || r.max_completion_tokens > 1_000_000 || !r.evidence ||
     record(r.reasoning) === undefined || (r.reasoning.mode !== "disabled" && r.reasoning.mode !== "bounded") ||
     (r.reasoning.mode === "bounded" && (!whole(r.reasoning.max_tokens) || r.reasoning.max_tokens < 1024 || r.reasoning.max_tokens >= r.max_completion_tokens))) return undefined;
 const noWrite = Object.hasOwn(OPENROUTER_RELAXED_TARIFF_MODELS, model) && r.cacheWriteBasis === "never_requested_enforced" && r.cacheWriteEnforcementVersion === OPENROUTER_CACHE_WRITE_ENFORCEMENT_VERSION;
 if ((r.cacheWriteBasis !== undefined || r.cacheWriteEnforcementVersion !== undefined) && !noWrite) return undefined;
 const pricing = {} as OpenRouterPrices;
 try {
  const p = record(r.pricing);
  if (p === undefined || Object.keys(p).some(k => !OPENROUTER_PRICE_KEYS.some(key => key === k))) return undefined;
  for (const k of OPENROUTER_PRICE_KEYS) {
   // Only reviewed models may default optional prices; absent write pricing also requires current enforced proof.
   // Explicit undefined/null/malformed values still refuse, including on the allowlist.
   const value = Object.hasOwn(OPENROUTER_RELAXED_TARIFF_MODELS, model) && !Object.hasOwn(p, k) && k !== "prompt" && k !== "completion" && (k !== "input_cache_write" || noWrite) ? "0" : p[k];
   if (typeof value !== "string") return undefined;
   pricing[k] = value;
   const amount = openRouterDecimal(value);
   // Token rates must also fit the existing integer micro-USD/M ceiling contract exactly.
   if (k !== "request" && (amount % 1_000_000n !== 0n || amount / 1_000_000n > BigInt(Number.MAX_SAFE_INTEGER))) return undefined;
   wireNumber(k === "request" ? value : perMillionPrice(value));
  }
  if (noWrite && openRouterDecimal(pricing.input_cache_write) !== 0n) return undefined;
  if (openRouterDecimal(pricing.prompt) <= 0n || openRouterDecimal(pricing.completion) <= 0n) return undefined;
 } catch { return undefined; }
 const value: OpenRouterTariff = { ...(noWrite ? { cacheWriteBasis: "never_requested_enforced" as const, cacheWriteEnforcementVersion: OPENROUTER_CACHE_WRITE_ENFORCEMENT_VERSION } : {}), model: r.model, route: r.route, pricing, max_completion_tokens: r.max_completion_tokens, reasoning: { ...r.reasoning }, verifiedAt: r.verifiedAt, expiresAt: r.expiresAt, evidence: r.evidence };
 return { ...value, hash: createHash("sha256").update(JSON.stringify(value)).digest("hex") };
}
/** No explicit cache directives may reach OpenRouter, including inside messages/tools.
 * Anthropic cache_control markers are stripped by the translator before this boundary.
 */
function hasCachingHint(value: unknown): boolean {
 if (Array.isArray(value)) return value.some(hasCachingHint);
 const object = record(value);
 return object !== undefined && Object.entries(object).some(([key, v]) =>
  ["cache_control", "caching", "cache", "prompt_cache_key", "prompt_cache_retention", "prompt_caching"].includes(key) || hasCachingHint(v));
}
export function openRouterRequest(body: Record<string, unknown>, policy: OpenRouterPolicy): Record<string, unknown> | undefined {
 const allowed = ["model", "messages", "max_tokens", "stream", "temperature", "top_p", "stop", "tools", "tool_choice", "parallel_tool_calls", "stream_options", "usage"];
 // Only client function tools are supported: no provider search tools (including future variants).
 if (hasCachingHint(body) || (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.some(t => record(t)?.type !== "function"))) ||
     typeof body.model !== "string" || body.model.includes(":") || body.model !== policy.model || Object.keys(body).some(k => !allowed.includes(k)) || !whole(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > policy.max_completion_tokens ||
     (policy.reasoning.mode === "bounded" && body.max_tokens <= policy.reasoning.max_tokens) ||
     !Array.isArray(body.messages) || body.messages.some(v => { const m = record(v); return m === undefined || !(typeof m.content === "string" || (m.role === "assistant" && m.content === null)); })) return undefined;
 const output = openRouterDecimal(policy.pricing.completion) >= openRouterDecimal(policy.pricing.internal_reasoning) ? policy.pricing.completion : policy.pricing.internal_reasoning;
 return { ...body, usage: { include: true }, reasoning: policy.reasoning.mode === "disabled" ? { enabled: false } : { enabled: true, max_tokens: policy.reasoning.max_tokens },
  provider: { only: [policy.route], allow_fallbacks: false, require_parameters: true,
   max_price: { prompt: wireNumber(perMillionPrice(policy.pricing.prompt)), completion: wireNumber(perMillionPrice(output)), request: wireNumber(policy.pricing.request) } } };
}
/** Every prompt token may be a priced cache write; cache reads never make the hold smaller.
 * An absent write fee is zero only with versioned no-write enforcement; unexpected
 * reported writes retain the hold/debit provisionally and stop the source.
 * OpenRouter bills reasoning as output: the full combined output limit uses the dearer
 * completion/reasoning rate even when the separate reasoning field is absent (zero).
 * No extra reasoning budget is added outside maxTokens; live qualification proves that limit.
 */
export function openRouterHold(policy: OpenRouterPolicy, maxPromptTokens: number, maxTokens: number): number {
 if (!whole(maxPromptTokens) || !whole(maxTokens) || maxTokens < 1 || maxTokens > policy.max_completion_tokens) throw new Error("request not allowed");
 const p = policy.pricing; const max = (a: string, b: string) => openRouterDecimal(a) > openRouterDecimal(b) ? openRouterDecimal(a) : openRouterDecimal(b);
 const usd = BigInt(maxPromptTokens) * (max(p.prompt, p.input_cache_read) + openRouterDecimal(p.input_cache_write)) + BigInt(maxTokens) * max(p.completion, p.internal_reasoning) + openRouterDecimal(p.request);
 const micros = (usd * 1_000_000n + SCALE - 1n) / SCALE;
 if (micros > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("request not allowed");
 return Number(micros);
}
export function openRouterRates(policy: OpenRouterPolicy) {
 const rate = (s: string) => Number(openRouterDecimal(s) / 1_000_000n);
 return { inputMicrosPerMTok: rate(policy.pricing.prompt), outputMicrosPerMTok: Math.max(rate(policy.pricing.completion), rate(policy.pricing.internal_reasoning)),
  cacheReadMicrosPerMTok: rate(policy.pricing.input_cache_read), cacheWrite5mMicrosPerMTok: Math.max(rate(policy.pricing.prompt), rate(policy.pricing.input_cache_write)), cacheWrite1hMicrosPerMTok: Math.max(rate(policy.pricing.prompt), rate(policy.pricing.input_cache_write)),
  estimated: false, priceVersion: 1 };
}
