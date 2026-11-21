// Private release tariff, not caller configuration or a provider-enable switch.
// Populate only from reviewed account evidence proving ALL billing components and
// max_price units/coverage. No live tariff is invented during an offline build.
import { createHash } from "node:crypto";
import { record, whole } from "./model-gateway-token.js";
export interface OpenRouterTariff {
 model: string; route: string; inputMicrosPerMTok: number; outputMicrosPerMTok: number;
 verifiedAt: number; expiresAt: number; evidence: string;
}
export interface OpenRouterPolicy extends OpenRouterTariff { hash: string }
export const REVIEWED_OPENROUTER_POLICIES: readonly OpenRouterTariff[] = Object.freeze([]);
export function openRouterPolicy(model: string, now: number, rows: readonly OpenRouterTariff[] = REVIEWED_OPENROUTER_POLICIES): OpenRouterPolicy | undefined {
 const matches = rows.filter(r => r.model === model);
 if (matches.length !== 1) return undefined;
 const r = matches[0]!;
 if (r.model !== "openai/gpt-5-mini" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(r.route) ||
     !whole(now) || !whole(r.verifiedAt) || !whole(r.expiresAt) || r.verifiedAt > now || r.expiresAt <= now || r.expiresAt - r.verifiedAt > 86_400_000 ||
     !whole(r.inputMicrosPerMTok) || r.inputMicrosPerMTok <= 0 || !whole(r.outputMicrosPerMTok) || r.outputMicrosPerMTok <= 0 || !r.evidence) return undefined;
 const value = { model: r.model, route: r.route, inputMicrosPerMTok: r.inputMicrosPerMTok, outputMicrosPerMTok: r.outputMicrosPerMTok, verifiedAt: r.verifiedAt, expiresAt: r.expiresAt, evidence: r.evidence };
 return { ...value, hash: createHash("sha256").update(JSON.stringify(value)).digest("hex") };
}
/** Applied to the translated body. Candidate wire controls remain unqualified;
 * the production tariff stays absent until the controller verifies them. */
export function openRouterRequest(body: Record<string, unknown>, policy: OpenRouterPolicy): Record<string, unknown> | undefined {
 const allowed = ["model", "messages", "max_tokens", "stream", "temperature", "top_p", "stop", "tools", "tool_choice", "parallel_tool_calls", "stream_options", "usage"];
 if (body.model !== policy.model || Object.keys(body).some(k => !allowed.includes(k)) || !whole(body.max_tokens) || body.max_tokens < 1 ||
     !Array.isArray(body.messages) || body.messages.some(v => { const m = record(v); return m === undefined || !(typeof m.content === "string" || (m.role === "assistant" && m.content === null)); })) return undefined;
 return { ...body, usage: { include: true }, provider: { only: [policy.route], allow_fallbacks: false, require_parameters: true,
  max_price: { prompt: policy.inputMicrosPerMTok / 1_000_000, completion: policy.outputMicrosPerMTok / 1_000_000 } } };
}

export function openRouterRates(policy: OpenRouterPolicy) {
 return { inputMicrosPerMTok: policy.inputMicrosPerMTok, outputMicrosPerMTok: policy.outputMicrosPerMTok,
  cacheReadMicrosPerMTok: policy.inputMicrosPerMTok, cacheWrite5mMicrosPerMTok: policy.inputMicrosPerMTok, cacheWrite1hMicrosPerMTok: policy.inputMicrosPerMTok,
  estimated: false, priceVersion: 1 };
}
