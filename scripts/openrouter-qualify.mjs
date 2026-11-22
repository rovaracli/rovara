#!/usr/bin/env node
// Release-test principal only. Credentials are read solely from OPENROUTER_API_KEY.
import { Buffer } from "node:buffer";
import { setTimeout as sleepFor } from "node:timers/promises";
const { AbortSignal } = globalThis;
import { pathToFileURL } from "node:url";
import { openRouterDecimal, openRouterHold, openRouterPolicy, openRouterRequest, perMillionPrice, OPENROUTER_PRICE_KEYS, OPENROUTER_RELAXED_TARIFF_MODELS, OPENROUTER_CACHE_WRITE_ENFORCEMENT_VERSION } from "../packages/model-gateway/dist/openrouter-policy.js";
// Exceptions use only locally constructed diagnostics; refusal bodies are separately sanitized.
class EvidenceError extends Error {}
const evidenceReason = error => error instanceof EvidenceError ? error.message : "HTTP evidence unavailable";
const recordCheck = (target, name, ok, reason) => {
 target.checks[name] = ok ? "PASS" : "FAIL";
 if (!ok) target.reasons[name] = reason;
};
const MICRO = 1_000_000_000_000n;
const INFERENCE_BREAKDOWN_KEYS = ["upstream_inference_prompt_cost", "upstream_inference_completions_cost"];
const INFERENCE_DETAIL_KEYS = ["upstream_inference_cost", ...INFERENCE_BREAKDOWN_KEYS];
// Dated variants are reviewed per requested model; never infer another provider/model's aliases.
const GENERATION_MODEL_PATTERNS = Object.freeze({
 "openai/gpt-5-mini": /^openai\/gpt-5-mini(?:-\d{4}-\d{2}-\d{2})?$/u,
 "openai/gpt-5-nano": /^openai\/gpt-5-nano(?:-\d{4}-\d{2}-\d{2})?$/u,
});
const matchesModel = (requested, actual) => typeof actual === "string" && (actual === requested || (Object.hasOwn(GENERATION_MODEL_PATTERNS, requested) && GENERATION_MODEL_PATTERNS[requested].test(actual)));
const unrequestedSearchNull = (name, value, searchNotRequested) => searchNotRequested && ["generation.num_search_results", "generation.web_search_engine"].includes(name) && value === null;
/** Optional prompt/completions breakdown: both must be readable nonnegative USD,
 * and their sum must match the aggregate within 1 micro-dollar ($0.000001), inclusive.
 * This rounding tolerance applies ONLY to the breakdown, never aggregate/total-cost checks.
 */
const consistentInferenceBreakdown = details => {
 if (!INFERENCE_BREAKDOWN_KEYS.some(key => Object.hasOwn(details, key))) return true;
 try {
  const values = INFERENCE_DETAIL_KEYS.map(key => {
   // Exactly zero is valid for either part (and the aggregate); negatives/unreadable refuse.
   if (!nonnegativeMoney(details[key])) throw new Error();
   return openRouterDecimal(String(details[key]));
  });
  const delta = values[1] + values[2] - values[0];
  return delta >= -MICRO && delta <= MICRO;
 } catch { return false; }
};
const micros = value => Number((openRouterDecimal(String(value)) + MICRO - 1n) / MICRO);
const safeCount = n => count(n) ? n : null;
const safeMoney = n => nonnegativeMoney(n) ? n : null;
const count = n => Number.isSafeInteger(n) && n >= 0;
const equalMoney = (a, b) => {
 try { return openRouterDecimal(String(a)) === openRouterDecimal(String(b)); } catch { return false; }
};
/** True when text contains the credential or any 16-character piece of it (a provider echo must never leave this process). */
export const containsCredential = (text, key) => {
 if (typeof key !== "string" || key.length === 0 || typeof text !== "string") return false;
 if (text.includes(key)) return true;
 for (let i = 0; i + 16 <= key.length; i++) if (text.includes(key.slice(i, i + 16))) return true;
 return false;
};
const nonnegativeMoney = v => (typeof v === "number" && Number.isFinite(v) && v >= 0) || (typeof v === "string" && /^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/iu.test(v));
/** Refuse positive or unreadable auxiliary billing evidence anywhere in usage/generation.
 * Only the aggregate/inference totals and separately validated breakdown are exempt; never echo untrusted keys/values.
 */
export const noAuxiliaryEvidence = (value, path = "", searchNotRequested = false) => {
 if (value === null || typeof value !== "object") return true;
 return Object.entries(value).every(([key, child]) => {
  const name = path ? `${path}.${key}` : key;
  if (["usage.cost", "usage.cost_details.upstream_inference_cost", ...INFERENCE_BREAKDOWN_KEYS.map(key => `usage.cost_details.${key}`), "generation.total_cost"].includes(name)) return true;
  if (name === "generation.web_search_engine") return unrequestedSearchNull(name, child, searchNotRequested);
  if (unrequestedSearchNull(name, child, searchNotRequested)) return true;
  if (/(?:cost|fee|search|cache_write|cache_creation)/iu.test(key) && key !== "cost_details") return equalMoney(child, "0");
  return noAuxiliaryEvidence(child, name, searchNotRequested);
 });
};
/** OpenRouter's counters need not agree across endpoints. Bound each readable receipt
 * at the dearer output interpretation (reasoning outside completion), then retain
 * the larger bound. Aggregate costs must still agree exactly, be positive and fit
 * this unrounded bound AND the original reservation. No inference of zero fees.
 */
const maximumInferenceCost = (policy, usage, generation) => {
 const receipts = [
  [usage?.prompt_tokens, usage?.completion_tokens, usage?.completion_tokens_details?.reasoning_tokens, usage?.prompt_tokens_details?.cached_tokens ?? 0],
  [generation.native_tokens_prompt, generation.native_tokens_completion, generation.native_tokens_reasoning, generation.native_tokens_cached],
 ];
 const p = policy.pricing;
 const rate = key => openRouterDecimal(p[key]);
 let maximum = 0n;
 for (const [prompt, completion, reasoning, cached] of receipts) {
  if (![prompt, completion, reasoning, cached].every(count) || cached > prompt) return undefined;
  // BigInt addition cannot overflow a safe JS integer when provider counts are large.
  const output = BigInt(completion) + BigInt(reasoning);
  const cost = BigInt(prompt - cached) * rate("prompt") + BigInt(cached) * rate("input_cache_read") + output * rate("completion") + rate("request");
  if (cost > maximum) maximum = cost;
 }
 return maximum;
};
/** In-memory HTTP fixtures inject fetch. The CLI always targets the fixed TLS origin. */
export async function qualify({ models, provider, providerName = provider, spendCap = "0.50", fetch: request = globalThis.fetch, env = process.env, now = Date.now, sleep = sleepFor }) {
 const report = { status: "FAIL", chargedMicros: 0, reservedMicros: 0, spendCapMicros: 0, models: [], proposedTariffRows: [], errors: [] };
 let exposure = 0; let stop = false;
 // Never print exceptions, full response bodies, headers or credentials (even a provider echo).
 try {
  report.spendCapMicros = Number(openRouterDecimal(spendCap) / MICRO);
  if (!Number.isSafeInteger(report.spendCapMicros) || report.spendCapMicros < 1 || !env.OPENROUTER_API_KEY ||
      !Array.isArray(models) || models.length < 2 || models.length > 3 || new Set(models).size !== models.length ||
      models.some(m => typeof m !== "string" || m.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(m) || m.startsWith("openrouter/")) ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(provider) || typeof providerName !== "string" || providerName.length > 128) throw new Error();
  const json = async (path, body, rejected) => {
   const url = `https://openrouter.ai/api/v1/${path}`;
   if (containsCredential(url, env.OPENROUTER_API_KEY)) { stop = true; throw new Error(); }
   const res = await request(url, {
    method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
   });
   if ([401, 403].includes(res.status)) stop = true;
   const bytes = await res.text(); if (Buffer.byteLength(bytes) > 8 * 1024 * 1024) throw new EvidenceError("body exceeds byte limit");
   // GET errors need no billing body. A delayed 404 may have an empty/non-JSON body.
   if (!res.ok && body === undefined) throw new EvidenceError(`http ${res.status}`);
   let data;
   try { data = JSON.parse(bytes); } catch { throw new EvidenceError("malformed body"); }
   if (!res.ok) { rejected?.(data); throw new EvidenceError(`http ${res.status}`); }
   return data;
  };
  // Retry ONLY unavailable GET evidence, never the paid completion. Five sleeps total 30s.
  const generationLookup = async id => {
   if (typeof id !== "string" || !/^gen-[A-Za-z0-9_-]{1,200}$/u.test(id) || containsCredential(id, env.OPENROUTER_API_KEY)) {
    if (containsCredential(id, env.OPENROUTER_API_KEY)) stop = true;
    throw new EvidenceError("malformed id");
   }
   const delays = [1000, 2000, 4000, 8000, 15000];
   for (let attempt = 0; ; attempt++) {
    let response;
    try { response = await json(`generation?id=${encodeURIComponent(id)}`); }
    catch (error) { if (!(error instanceof EvidenceError) || error.message !== "http 404") throw error; }
    if (response !== undefined) {
     if (response === null || typeof response !== "object" || Array.isArray(response)) throw new EvidenceError("malformed body");
     const data = response.data;
     if (data !== undefined && data !== null) {
      if (typeof data !== "object" || Array.isArray(data)) throw new EvidenceError("malformed body");
      if (Object.keys(data).length > 0) return data;
     }
    }
    if (attempt === delays.length) throw new EvidenceError("not available after 6 tries over 30 s");
    await sleep(delays[attempt]);
   }
  };
  const safeValue = value => {
   const numeric = typeof value === "number" && Number.isFinite(value) || typeof value === "string" && /^-?\d{1,24}(?:\.\d{1,24})?(?:e[+-]?\d{1,2})?$/iu.test(value);
   return (numeric || typeof value === "boolean" || value === null) && !containsCredential(String(value), env.OPENROUTER_API_KEY) ? String(value) : "[invalid]";
  };
  const safeRefusalText = value => {
   if (typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value))) return "[invalid]";
   const text = String(value);
   const printable = text.replace(/[\p{Cc}\p{Cf}]/gu, " ");
   // Check before truncation/sanitizing too: neither may hide a credential echo.
   if (containsCredential(text, env.OPENROUTER_API_KEY) || containsCredential(printable, env.OPENROUTER_API_KEY)) return "[redacted]";
   return printable.slice(0, 300);
  };
  const tokenReason = (field, value, min, max) => !count(value) ? `${field} ${safeValue(value)} expected nonnegative safe integer` : value < min ? `${field} ${safeValue(value)} < min ${min}` : value > max ? `${field} ${safeValue(value)} > max ${max}` : undefined;
  const catalogue = await json("models");
  if (!Array.isArray(catalogue.data)) throw new Error();
  for (const model of models) {
   const result = { model, status: "FAIL", reasons: {}, checks: {}, calls: [] }; report.models.push(result);
   if (stop) { recordCheck(result, "not_attempted", false, "shared authentication, credential or spend-cap stop"); continue; }
   const matches = catalogue.data.filter(m => m.id === model);
   const entry = matches.length === 1 ? matches[0] : undefined;
   const at = now();
   const tariff = { model, route: provider, pricing: entry?.pricing, max_completion_tokens: Number.isSafeInteger(entry?.top_provider?.max_completion_tokens) ? Math.min(entry.top_provider.max_completion_tokens, 4096) : undefined,
    reasoning: { mode: "bounded", max_tokens: 1024 }, verifiedAt: at, expiresAt: at + 86_400_000, evidence: "CANDIDATE ONLY: attach reviewed release-test report; never auto-install" };
   // Catalog diagnostics contain only field names and numeric public prices, never arbitrary text.
   const failures = [];
   const safeField = key => /^[a-z][a-z0-9_]{0,63}$/u.test(key) && !containsCredential(key, env.OPENROUTER_API_KEY) ? key : "[invalid field]";
   const fieldValue = (key, value) => {
    const safeKey = safeField(key);
    const numeric = (typeof value === "string" && /^-?\d{1,24}(?:\.\d{1,24})?(?:e[+-]?\d{1,2})?$/iu.test(value)) || (typeof value === "number" && Number.isFinite(value));
    const safe = (numeric || value === null) && !containsCredential(String(value), env.OPENROUTER_API_KEY) ? JSON.stringify(value) : "[invalid]";
    return `pricing.${safeKey}=${safe}`;
   };
   const pricing = {};
   const catalogPrices = entry?.pricing;
   if (matches.length !== 1) failures.push("model missing or duplicate catalog entry");
   if (catalogPrices === null || typeof catalogPrices !== "object" || Array.isArray(catalogPrices)) failures.push("pricing missing or invalid");
   const prices = catalogPrices !== null && typeof catalogPrices === "object" && !Array.isArray(catalogPrices) ? catalogPrices : {};
   const allowlisted = Object.hasOwn(OPENROUTER_RELAXED_TARIFF_MODELS, model);
   if (allowlisted && !Object.hasOwn(prices, "input_cache_write")) {
    tariff.cacheWriteBasis = "never_requested_enforced";
    tariff.cacheWriteEnforcementVersion = OPENROUTER_CACHE_WRITE_ENFORCEMENT_VERSION;
   }
   for (const key of OPENROUTER_PRICE_KEYS) {
    const required = key === "prompt" || key === "completion";
    const positiveRequired = key === "prompt" || key === "completion";
    if (!Object.hasOwn(prices, key) && (required || !allowlisted)) { failures.push(`pricing.${key} missing required field${!allowlisted && !positiveRequired ? " (not allowlisted)" : ""}`); continue; }
    const value = Object.hasOwn(prices, key) ? prices[key] : "0";
    pricing[key] = value;
    try {
     if (typeof value !== "string") throw new Error();
     const amount = openRouterDecimal(value);
     if ((positiveRequired && amount <= 0n) || (key !== "request" && (amount % 1_000_000n !== 0n || amount / 1_000_000n > BigInt(Number.MAX_SAFE_INTEGER)))) throw new Error();
     const wire = key === "request" ? value : perMillionPrice(value);
     if (!equalMoney(Number(wire), wire)) throw new Error();
    } catch { failures.push(fieldValue(key, value)); }
   }
   for (const [key, value] of Object.entries(prices)) {
    if (OPENROUTER_PRICE_KEYS.includes(key)) continue;
    // Only reviewed opt-in-search models may omit a paid search price from the hold.
    // Native-search models can search without plugins: all other models require zero.
    // Every other auxiliary price must be a known zero; conditional/unknown fields still refuse.
    let safe = false;
    try {
     safe = key === "web_search" ? typeof value === "string" && (allowlisted ? openRouterDecimal(value) >= 0n : openRouterDecimal(value) === 0n) :
      ["image", "audio", "input_audio", "output_audio", "input_cache_write_1h"].includes(key) && equalMoney(value, "0");
    } catch { /* A malformed search price also refuses. */ }
    if (!safe) failures.push(fieldValue(key, value) + (key === "web_search" && !allowlisted ? " (not allowlisted)" : ""));
   }
   if (Number.isSafeInteger(entry?.top_provider?.max_completion_tokens) && entry.top_provider.max_completion_tokens < 4096) failures.push("max_completion_tokens < 4096");
   else if (!Number.isSafeInteger(entry?.top_provider?.max_completion_tokens)) failures.push("max_completion_tokens missing or invalid");
   tariff.pricing = pricing;
   const policy = failures.length === 0 ? openRouterPolicy(model, at, [tariff]) : undefined;
   recordCheck(result, "bounded_tariff", policy !== undefined, failures.length > 0 ? failures.join("; ") : "tariff policy refused");
   if (policy === undefined) { result.boundedTariffErrors = failures.length > 0 ? failures : ["tariff policy refused"]; continue; }
   // Candidate rows always carry all six normalized string fields.
   tariff.pricing = { ...policy.pricing };
   result.candidateTariff = tariff;
   result.reasoningProbe = "probe skipped: generation failed";
   let probeBody;
   for (let n = 0; n < 4; n++) {
    // Keep ordinary qualification easy; exercise reasoning in its own capped, fully held call.
    const reasoningProbe = n === 3;
    const maxTokens = [4096, 3072, 2048, 2048][n];
    const messages = [{ role: "user", content: reasoningProbe
     ? "Reasoning probe: Use reasoning to solve this problem before answering briefly: How many three-digit positive integers have strictly increasing digits? Explain your reasoning."
     : `Qualification ${n + 1}: What is 2 + 2? Reply with the answer in one short sentence.` }];
    const body = openRouterRequest({ model, messages, max_tokens: maxTokens, stream: false }, policy);
    if (body === undefined) throw new Error();
    const searchNotRequested = !Object.keys(body).some(key => /plugins|web|search|tools/iu.test(key));
    // Byte bound includes all messages and control fields; no tools, plugins, search, media or cache directives.
    const maxPromptTokens = Buffer.byteLength(JSON.stringify(body));
    const hold = openRouterHold(policy, maxPromptTokens, maxTokens);
    if (exposure + hold > report.spendCapMicros) { recordCheck(result, "spend_cap", false, `exposure ${exposure} + hold ${hold} > spend cap ${report.spendCapMicros} micros`); stop = true; break; }
    exposure += hold; report.reservedMicros += hold;
    if (reasoningProbe) { result.reasoningProbe = "FAIL"; result.reasoningProbeReason = "reasoning call failed; see call checks and reasons"; }
    const call = { attempt: n + 1, holdMicros: hold, maxPromptTokens, requestControls: { max_tokens: body.max_tokens, reasoning: body.reasoning, provider: body.provider }, checks: {}, reasons: {} }; result.calls.push(call);
    let charged = 0;
    const retainDebit = data => {
     const u = data?.usage;
     const debit = Math.max(nonnegativeMoney(u?.cost) ? micros(u.cost) : 0, nonnegativeMoney(u?.cost_details?.upstream_inference_cost) ? micros(u.cost_details.upstream_inference_cost) : 0);
     if (!Number.isSafeInteger(debit)) throw new Error();
     report.chargedMicros += debit; exposure += Math.max(0, debit - hold); charged = debit;
     if (exposure > report.spendCapMicros) stop = true;
    };
    let answer;
    try { answer = await json("chat/completions", body, retainDebit); }
    catch (error) { recordCheck(call, "response", false, evidenceReason(error)); break; }
    const content = answer.choices?.length === 1 ? answer.choices[0]?.message?.content : undefined;
    recordCheck(call, "visible_text", typeof content === "string" && content.trim().length > 0, "choices[0].message.content expected nonempty text from exactly one choice");
    const u = answer.usage;
    const readable = nonnegativeMoney(u?.cost) && nonnegativeMoney(u?.cost_details?.upstream_inference_cost);
    const detailKeys = u?.cost_details && typeof u.cost_details === "object" && !Array.isArray(u.cost_details) ? Object.keys(u.cost_details) : [];
    const unrecognizedDetailKeys = detailKeys.filter(key => !INFERENCE_DETAIL_KEYS.includes(key));
    const detailsBounded = detailKeys.includes("upstream_inference_cost") && unrecognizedDetailKeys.length === 0 && consistentInferenceBreakdown(u.cost_details);
    // Independently retain every readable debit, even when another field is malformed.
    retainDebit(answer);
    call.usage = { prompt_tokens: safeCount(u?.prompt_tokens), completion_tokens: safeCount(u?.completion_tokens), reasoning_tokens: safeCount(u?.completion_tokens_details?.reasoning_tokens), cache_write_tokens: safeCount(u?.prompt_tokens_details?.cache_write_tokens), cached_tokens: safeCount(u?.prompt_tokens_details?.cached_tokens), cost: safeMoney(u?.cost), cost_details: { upstream_inference_cost: safeMoney(u?.cost_details?.upstream_inference_cost), ...Object.fromEntries(INFERENCE_BREAKDOWN_KEYS.filter(key => detailKeys.includes(key)).map(key => [key, safeMoney(u.cost_details[key])])), unrecognized_component_count: unrecognizedDetailKeys.length, unrecognized_components: unrecognizedDetailKeys.map(safeField) } };
    let generation;
    try { generation = await generationLookup(answer.id); }
    catch (error) { recordCheck(call, "generation", false, evidenceReason(error)); break; }
    // Keep necessary numeric/bool evidence and a bounded safe model ID, never arbitrary provider text.
    const g = generation ?? {};
    const observed = Math.max(charged, nonnegativeMoney(g.total_cost) ? micros(g.total_cost) : 0);
    if (!Number.isSafeInteger(observed)) throw new Error();
    report.chargedMicros += observed - charged; exposure += Math.max(0, observed - Math.max(charged, hold)); charged = observed;
    const safeModel = typeof g.model === "string" && g.model.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(g.model) && !containsCredential(g.model, env.OPENROUTER_API_KEY) ? g.model : "[invalid]";
    call.generation = { model: safeModel, native_tokens_prompt: safeCount(g.native_tokens_prompt), native_tokens_completion: safeCount(g.native_tokens_completion), native_tokens_reasoning: safeCount(g.native_tokens_reasoning), native_tokens_cached: safeCount(g.native_tokens_cached), total_cost: safeMoney(g.total_cost), is_byok: typeof g.is_byok === "boolean" ? g.is_byok : null };
    // Retain any readable generation debit BEFORE refusing incomplete evidence.
    const missing = ["native_tokens_prompt", "native_tokens_completion", "native_tokens_reasoning", "native_tokens_cached", "total_cost", "model", "provider_name", "is_byok"].find(field => !Object.hasOwn(g, field));
    if (missing) { recordCheck(call, "generation", false, `missing field ${missing}`); break; }
    const check = (name, ok, reason) => recordCheck(call, name, ok, reason);
    const tokenFailures = (...fields) => fields.map(([field, value, min, max]) => tokenReason(field, value, min, max)).filter(Boolean).join("; ");
    const moneyEvidence = `usage.cost ${safeValue(u?.cost)}, upstream_inference_cost ${safeValue(u?.cost_details?.upstream_inference_cost)}, generation.total_cost ${safeValue(g.total_cost)}`;
    const totalOutput = g.native_tokens_completion;
    check("visible_generation", count(g.native_tokens_completion) && g.native_tokens_completion > 0, tokenReason("native_tokens_completion", g.native_tokens_completion, 1, Number.MAX_SAFE_INTEGER));
    check("completion_plus_reasoning_within_limit", count(totalOutput) && totalOutput <= maxTokens && count(u?.completion_tokens) && u.completion_tokens <= maxTokens, tokenFailures(["native_tokens_completion", totalOutput, 0, maxTokens], ["usage.completion_tokens", u?.completion_tokens, 0, maxTokens]));
    const usageReasoning = u?.completion_tokens_details?.reasoning_tokens;
    check("reasoning_readable", count(g.native_tokens_reasoning) && count(usageReasoning), tokenFailures(["native_tokens_reasoning", g.native_tokens_reasoning, 0, Number.MAX_SAFE_INTEGER], ["usage.completion_tokens_details.reasoning_tokens", usageReasoning, 0, Number.MAX_SAFE_INTEGER]));
    const requestedReasoningCap = body.reasoning.max_tokens;
    if (count(g.native_tokens_reasoning) && count(usageReasoning) && (g.native_tokens_reasoning > requestedReasoningCap || usageReasoning > requestedReasoningCap)) {
     call.reasoningOverCap = { requestedMaxTokens: requestedReasoningCap, usageTokens: usageReasoning, generationTokens: g.native_tokens_reasoning };
     process.stderr.write(`OpenRouter reasoning above requested cap ${requestedReasoningCap}: usage ${safeValue(usageReasoning)}, generation ${safeValue(g.native_tokens_reasoning)}\n`);
    }
    if (reasoningProbe) check("high_reasoning_exercised", count(g.native_tokens_reasoning) && g.native_tokens_reasoning > 0 && count(usageReasoning) && usageReasoning > 0, tokenFailures(["native_tokens_reasoning", g.native_tokens_reasoning, 1, Number.MAX_SAFE_INTEGER], ["usage.completion_tokens_details.reasoning_tokens", usageReasoning, 1, Number.MAX_SAFE_INTEGER]));
    check("prompt_within_hold", count(g.native_tokens_prompt) && g.native_tokens_prompt <= maxPromptTokens && count(u?.prompt_tokens) && u.prompt_tokens <= maxPromptTokens, tokenFailures(["native_tokens_prompt", g.native_tokens_prompt, 0, maxPromptTokens], ["usage.prompt_tokens", u?.prompt_tokens, 0, maxPromptTokens]));
    check("usage_cost_within_hold", readable && charged <= hold, `${moneyEvidence}; expected readable costs and charged ${charged} <= hold ${hold} micros`);
    check("total_cost_matches_usage_cost", readable && nonnegativeMoney(g.total_cost) && equalMoney(g.total_cost, u.cost), `${moneyEvidence}; expected readable equal total_cost and usage.cost`);
    check("identity_and_non_byok", matchesModel(model, answer.model) && matchesModel(model, g.model) && g.provider_name === providerName && g.is_byok === false, [!matchesModel(model, answer.model) ? "answer.model expected requested model" : "", !matchesModel(model, g.model) ? "generation.model expected requested model" : "", g.provider_name !== providerName ? "generation.provider_name expected pinned provider" : "", g.is_byok !== false ? `generation.is_byok ${safeValue(g.is_byok)} expected false` : ""].filter(Boolean).join("; "));
    const auxiliaryClear = noAuxiliaryEvidence(u, "usage", searchNotRequested) && noAuxiliaryEvidence(g, "generation", searchNotRequested);
    const computedMax = maximumInferenceCost(policy, u, g);
    const tokenEvidence = `usage/native prompt ${safeValue(u?.prompt_tokens)}/${safeValue(g.native_tokens_prompt)}, completion ${safeValue(u?.completion_tokens)}/${safeValue(g.native_tokens_completion)}; native reasoning ${safeValue(g.native_tokens_reasoning)}, usage reasoning ${safeValue(u?.completion_tokens_details?.reasoning_tokens)}, cached ${safeValue(u?.prompt_tokens_details?.cached_tokens ?? 0)}/${safeValue(g.native_tokens_cached)}`;
    const expectedCost = computedMax === undefined ? "unavailable: invalid token counts" : `${computedMax / (10n ** 18n)}.${(computedMax % (10n ** 18n)).toString().padStart(18, "0")} USD`;
    const boundedReason = `${moneyEvidence}; expected equal positive aggregate/usage/generation costs <= computed maximum ${expectedCost}; ${tokenEvidence}`;
    const auxiliaryReason = (value, path) => {
     if (value === null || typeof value !== "object") return undefined;
     for (const [key, child] of Object.entries(value)) {
      const name = `${path}.${key}`;
      if (["usage.cost", "usage.cost_details.upstream_inference_cost", ...INFERENCE_BREAKDOWN_KEYS.map(key => `usage.cost_details.${key}`), "generation.total_cost"].includes(name)) continue;
      if (name === "generation.web_search_engine" && !unrequestedSearchNull(name, child, searchNotRequested)) return "generation.web_search_engine expected null on a search-free request";
      if (unrequestedSearchNull(name, child, searchNotRequested)) continue;
      if (/(?:cost|fee|search|cache_write|cache_creation)/iu.test(key) && key !== "cost_details") {
       if (!equalMoney(child, "0")) return `${path.split(".").map(safeField).join(".")}.${safeField(key)} ${safeValue(child)} expected readable zero`;
      } else {
       const reason = auxiliaryReason(child, name);
       if (reason) return reason;
      }
     }
    };
    const auxiliaryFailure = auxiliaryClear ? "no reported auxiliary charge" : auxiliaryReason(u, "usage") ?? auxiliaryReason(g, "generation");
    const detailReason = !detailsBounded ? `usage.cost_details ${INFERENCE_DETAIL_KEYS.map(key => `${key} ${safeValue(u?.cost_details?.[key])}`).join(", ")}; expected readable nonnegative breakdown parts summing to aggregate within 0.000001 USD; unknown fields ${unrecognizedDetailKeys.map(safeField).join(", ") || "none"}` : !auxiliaryClear ? auxiliaryFailure : boundedReason;
    const reconciled = readable && computedMax !== undefined && nonnegativeMoney(g.total_cost) && equalMoney(u.cost, u.cost_details.upstream_inference_cost) && equalMoney(u.cost, g.total_cost) && openRouterDecimal(String(u.cost)) > 0n && openRouterDecimal(String(u.cost)) <= computedMax;
    check("cost_details_covered", detailsBounded && auxiliaryClear && reconciled, detailReason);
    check("bounded_inference_cost", reconciled, boundedReason);
    check("no_reported_auxiliary_charge", auxiliaryClear, auxiliaryFailure);
    const providerBound = reconciled && g.provider_name === providerName;
    check("observed_cost_within_caps", providerBound, `${boundedReason}; generation.provider_name expected pinned provider`);
    // No REPORTED auxiliary charge, bounded inference money and the original hold.
    // This is evidence for these calls, not a promise about future route billing.
    check("no_web_search_cost", detailsBounded && auxiliaryClear && reconciled && providerBound && charged <= hold, `${detailReason}; charged ${charged} expected within computed maximum and hold ${hold} micros`);
    check("spend_cap", exposure <= report.spendCapMicros, `exposure ${exposure} > spend cap ${report.spendCapMicros} micros`);
    if (reasoningProbe && Object.values(call.checks).every(v => v === "PASS")) { result.reasoningProbe = "PASS"; delete result.reasoningProbeReason; }
    if (Object.values(call.checks).some(v => v !== "PASS")) {
     // A model-local failure must not hide the next model. Unknown calls retain
     // their full hold in exposure; only a shared auth/credential/cap failure stops all.
     if (exposure > report.spendCapMicros) stop = true;
     break;
    }
    // Retain only a fully successful same-run control, including its exact routing.
    probeBody ??= body;
   }
   if (result.calls.length < 4 && result.checks.spend_cap === "FAIL") result.reasoningProbe = "probe skipped: spend cap exceeded";
   if (probeBody !== undefined && result.calls.length === 4 && Object.values(result.checks).every(v => v === "PASS") && result.calls.every(c => Object.values(c.checks).every(v => v === "PASS"))) {
    // Controlled refusal probes: only the selected positive price cap changes to zero.
    // Every attempted probe reserves its full original hold, even an expected refusal.
    result.priceCapProbes = [];
    for (const [component, cap] of Object.entries(probeBody.provider.max_price)) {
     if (stop) break;
     if (!(cap > 0)) continue;
     const hold = openRouterHold(policy, Buffer.byteLength(JSON.stringify(probeBody)), probeBody.max_tokens);
     if (exposure + hold > report.spendCapMicros) { recordCheck(result, "spend_cap", false, `exposure ${exposure} + hold ${hold} > spend cap ${report.spendCapMicros} micros`); stop = true; break; }
     exposure += hold; report.reservedMicros += hold;
     const probe = { component, holdMicros: hold, status: "FAIL", reason: "price-cap probe evidence unavailable" }; result.priceCapProbes.push(probe);
     try {
      const body = { ...probeBody, provider: { ...probeBody.provider, max_price: { ...probeBody.provider.max_price, [component]: 0 } } };
      const response = await request("https://openrouter.ai/api/v1/chat/completions", { method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      probe.httpStatus = response.status;
      if ([401, 403].includes(response.status)) stop = true;
      const raw = await response.text(); if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error();
      const data = JSON.parse(raw);
      if (data?.error !== null && typeof data?.error === "object") probe.error = Object.fromEntries(["code", "message"].filter(key => Object.hasOwn(data.error, key)).map(key => [key, safeRefusalText(data.error[key])]));
      const debit = Math.max(nonnegativeMoney(data?.usage?.cost) ? micros(data.usage.cost) : 0, nonnegativeMoney(data?.usage?.cost_details?.upstream_inference_cost) ? micros(data.usage.cost_details.upstream_inference_cost) : 0);
      if (!Number.isSafeInteger(debit)) throw new Error();
      report.chargedMicros += debit; exposure += Math.max(0, debit - hold);
      probe.chargedMicros = debit;
      if (data.id !== undefined) {
       const generation = await generationLookup(data.id);
       if (nonnegativeMoney(generation?.total_cost)) {
        const actual = Math.max(debit, micros(generation.total_cost));
        report.chargedMicros += actual - debit; exposure += Math.max(0, actual - Math.max(debit, hold)); probe.chargedMicros = actual;
       }
      }
      const priceRefusal = typeof data?.error?.message === "string" && /^\s*No endpoints found that satisfy the max price for this request\.?\s*$/iu.test(data.error.message);
      if (!response.ok && [400, 404, 422].includes(response.status) && priceRefusal && data.id === undefined && data.usage === undefined && debit === 0) { probe.status = "PASS"; probe.reason = "recognized price-cap refusal against successful same-run control; no id/usage and zero debit"; }
      else probe.reason = `http ${response.status}; expected price-cap refusal (400/404/422), recognized refusal message, no id/usage and zero debit; observed debit ${probe.chargedMicros} micros`;
     } catch (error) { probe.reason = evidenceReason(error); }
     if (exposure > report.spendCapMicros) stop = true;
    }
    recordCheck(result, "provider_honoured_max_price", !stop && result.priceCapProbes.length >= 2 && result.priceCapProbes.every(p => p.status === "PASS"), "expected at least two passing price-cap refusal probes and no shared stop; see priceCapProbes reasons");
    if (result.checks.provider_honoured_max_price === "PASS") { result.status = "PASS"; report.proposedTariffRows.push(tariff); }
   }
  }
  if (report.models.length === models.length && report.models.every(m => m.status === "PASS")) report.status = "PASS";
 } catch { report.errors.push("Qualification refused or HTTP evidence unavailable; no tariff may be installed."); }
 return report;
}
export async function main(argv = process.argv.slice(2), env = process.env) {
 const options = { models: [], env };
 try {
  for (let i = 0; i < argv.length; i++) {
   const flag = argv[i];
   if (flag === "--models") { while (argv[i + 1] && !argv[i + 1].startsWith("--")) options.models.push(argv[++i]); }
   else if (["--provider", "--provider-name", "--spend-cap"].includes(flag) && argv[i + 1]) options[({ "--provider": "provider", "--provider-name": "providerName", "--spend-cap": "spendCap" })[flag]] = argv[++i];
   else throw new Error();
  }
  const result = await qualify(options); const text = JSON.stringify(result, null, 2);
  if (containsCredential(text, (options.env ?? process.env).OPENROUTER_API_KEY)) { process.stdout.write('{"status":"FAIL","errors":["Report withheld"]}\n'); return 1; }
  process.stdout.write(`${text}\n`); return result.status === "PASS" ? 0 : 1;
 } catch { process.stdout.write('{"status":"FAIL","errors":["Invalid qualification arguments"]}\n'); return 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
