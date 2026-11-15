import { record, whole } from "./model-gateway-token.js";
import { priceKey, validEntry, type PriceEntry } from "./price-snapshot.js";
import { priceKind, priceProvider, ratesOf, tokenRateField } from "./price-classify.js";
import { ALLOW_LOWER, AWS_MAX_BYTES, DRIFT_FACTOR, FETCH_DEADLINE_MS, FETCH_TIMEOUT_MS, LITELLM_MAX_BYTES, MAX_AWS_REGIONS, MAX_BAD_PRICE_FRACTION, MAX_DRIFT_FRACTION, MAX_ENTRIES_PER_SOURCE, MAX_NODES, MAX_PRICE_DEPTH, MICROS_PER_USD, MIN_AWS_MODELS, MIN_LITELLM_MODELS, PRICE_MAX, SHRINK_FLOOR, USD_PER_TOKEN_SANITY_MAX } from "./price-constants.js";
export const LITELLM_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
export const AWS_HOST = "pricing.us-east-1.amazonaws.com";
export const AWS_REGIONS = ["us-east-1", "us-west-2"] as const;
export interface PriceTransport { get(url: string, options: { maxBytes: number; timeoutMs: number; signal: AbortSignal }): Promise<{ status: number; body: Uint8Array }> }
export interface PriceReport { skipped: string[]; ignoredLower: number }
export type PriceFetchResult = { ok: true; entries: PriceEntry[]; report: PriceReport } | { ok: false; reason: string };
export interface SourceLimits { now?: number; minModels?: number; maxBytes?: number; deadlineMs?: number; timeoutMs?: number; previous?: readonly PriceEntry[]; regions?: readonly string[] }
const failure = (): PriceFetchResult => ({ ok: false, reason: "invalid source" });
const awsUrl = (region: string): string => `https://${AWS_HOST}/offers/v1.0/aws/AmazonBedrockFoundationModels/current/${region}/index.json`;
function allowedUrl(text: string): boolean {
  try { const u = new URL(text); return u.protocol === "https:" && u.username === "" && u.password === "" && u.port === "" && u.search === "" && u.hash === "" && (text === LITELLM_URL || (u.hostname === AWS_HOST && /^\/offers\/v1\.0\/aws\/AmazonBedrockFoundationModels\/current\/[a-z]{2}(?:-gov)?-[a-z]+-\d\/index\.json$/u.test(u.pathname))); } catch { return false; }
}
/** Race each dependency with abort: even a fake or non-cooperative transport cannot extend the deadline. */
async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("price fetch unavailable"));
    if (signal.aborted) { void operation.catch(() => undefined); abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
export function fetchTransport(fetchFn: typeof fetch): PriceTransport {
  return { async get(url, options) {
    if (!allowedUrl(url) || !whole(options.maxBytes) || options.maxBytes < 1 || !whole(options.timeoutMs) || options.timeoutMs < 1) throw new Error("price fetch unavailable");
    const controller = new AbortController(); const abort = () => controller.abort();
    options.signal.addEventListener("abort", abort, { once: true }); if (options.signal.aborted) abort();
    const timer = setTimeout(abort, options.timeoutMs); let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await abortable(fetchFn(url, { redirect: "error", signal: controller.signal }), controller.signal);
      if (response.status !== 200 || response.redirected || response.url !== url || !allowedUrl(response.url) || response.body === null) throw new Error("price fetch unavailable");
      reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
      for (;;) {
        const next = await abortable(reader.read(), controller.signal); if (next.done) break;
        bytes += next.value.byteLength; if (bytes > options.maxBytes) throw new Error("price fetch unavailable"); chunks.push(next.value);
      }
      return { status: 200, body: Buffer.concat(chunks) };
    } catch { throw new Error("price fetch unavailable"); }
    finally { clearTimeout(timer); controller.abort(); options.signal.removeEventListener("abort", abort); if (reader !== undefined) void reader.cancel().catch(() => undefined); }
  } };
}
interface Budget { bytes: number; nodes: number; entries: number; maxBytes: number; deadline: number; signal: AbortSignal; timeoutMs: number }
/** Port of parked bounded(): one iterative node/depth/time budget for every regional input. */
function bounded(root: unknown, budget: Budget): boolean {
  const pending = [{ value: root, depth: 0 }];
  while (pending.length > 0) {
    const node = pending.pop()!; budget.nodes++;
    if (budget.nodes > MAX_NODES || node.depth > MAX_PRICE_DEPTH || performance.now() > budget.deadline || budget.signal.aborted) return false;
    if (typeof node.value !== "object" || node.value === null) continue;
    const keys = Object.keys(node.value);
    if (keys.length + pending.length + budget.nodes > MAX_NODES) return false;
    for (const key of keys) pending.push({ value: (node.value as Record<string, unknown>)[key], depth: node.depth + 1 });
  }
  return true;
}
async function read(transport: PriceTransport, url: string, budget: Budget): Promise<Record<string, unknown>> {
  if (!allowedUrl(url)) throw new Error("invalid source");
  const response = await abortable(transport.get(url, { maxBytes: budget.maxBytes - budget.bytes, timeoutMs: Math.min(budget.timeoutMs, Math.max(1, Math.ceil(budget.deadline - performance.now()))), signal: budget.signal }), budget.signal);
  if (response.status !== 200 || !(response.body instanceof Uint8Array)) throw new Error("invalid source");
  budget.bytes += response.body.byteLength;
  if (budget.bytes > budget.maxBytes || performance.now() > budget.deadline || budget.signal.aborted) throw new Error("invalid source");
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body));
  if (!bounded(value, budget)) throw new Error("invalid source");
  const result = record(value); if (result === undefined) throw new Error("invalid source"); return result;
}
async function withBudget(limits: SourceLimits, maxBytes: number, job: (budget: Budget, now: number) => Promise<PriceFetchResult>): Promise<PriceFetchResult> {
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const now = limits.now ?? Date.now(); const bytes = limits.maxBytes ?? maxBytes; const duration = limits.deadlineMs ?? FETCH_DEADLINE_MS; const timeoutMs = limits.timeoutMs ?? FETCH_TIMEOUT_MS;
    if (!whole(now) || !whole(bytes) || bytes < 1 || bytes > maxBytes || !whole(duration) || duration < 1 || duration > FETCH_DEADLINE_MS || !whole(timeoutMs) || timeoutMs < 1 || timeoutMs > FETCH_TIMEOUT_MS || (limits.previous !== undefined && (!Array.isArray(limits.previous) || limits.previous.length > MAX_ENTRIES_PER_SOURCE || !limits.previous.every(validEntry)))) return failure();
    timer = setTimeout(() => controller.abort(), duration);
    return await job({ bytes: 0, nodes: 0, entries: 0, maxBytes: bytes, deadline: performance.now() + duration, signal: controller.signal, timeoutMs }, now);
  } catch { return failure(); }
  finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
}
export function fetchLiteLLM(transport: PriceTransport, limits: SourceLimits = {}): Promise<PriceFetchResult> {
  return withBudget(limits, LITELLM_MAX_BYTES, async (budget, now) => {
    const map = await read(transport, LITELLM_URL, budget); const keys = Object.keys(map).filter((k) => k !== "sample_spec");
    const min = limits.minModels ?? MIN_LITELLM_MODELS;
    if (!whole(min) || min < 1 || keys.length < min || keys.length > MAX_ENTRIES_PER_SOURCE) return failure();
    const prior = new Map((limits.previous ?? []).map((e) => [priceKey(e), e])); const allowed = new Set(ALLOW_LOWER);
    const entries: PriceEntry[] = []; const seen = new Set<string>(); const report: PriceReport = { skipped: [], ignoredLower: 0 };
    let bad = 0; let compared = 0; let drifted = 0;
    for (const key of keys) {
      if (performance.now() > budget.deadline || budget.signal.aborted) return failure();
      const row = record(map[key]);
      if (row === undefined) { report.skipped.push("unsupported entry"); continue; }
      if (Object.entries(row).some(([field, value]) => tokenRateField(field) && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > USD_PER_TOKEN_SANITY_MAX))) bad++;
      const provider = priceProvider(row.litellm_provider); const kind = priceKind(row.mode); const rates = ratesOf(row, now);
      if (provider === undefined || kind === undefined || typeof rates === "string") { report.skipped.push(typeof rates === "string" ? rates : "unsupported provider"); continue; }
      const model = provider === "gemini" ? key.replace(/^gemini\//u, "") : key;
      const e: PriceEntry = { provider, model, kind, ...rates };
      if (!validEntry(e)) { report.skipped.push("unsupported entry"); continue; }
      const id = priceKey(e); if (seen.has(id)) return failure(); seen.add(id);
      const old = prior.get(id);
      if (old !== undefined) {
        compared++;
        if ([e.inputMicrosPerMTok / old.inputMicrosPerMTok, e.outputMicrosPerMTok / old.outputMicrosPerMTok].some((ratio) => ratio > DRIFT_FACTOR || ratio < 1 / DRIFT_FACTOR)) drifted++;
        if (!allowed.has(model) && (e.inputMicrosPerMTok < old.inputMicrosPerMTok || e.outputMicrosPerMTok < old.outputMicrosPerMTok)) {
          report.ignoredLower++; e.inputMicrosPerMTok = Math.max(e.inputMicrosPerMTok, old.inputMicrosPerMTok); e.outputMicrosPerMTok = Math.max(e.outputMicrosPerMTok, old.outputMicrosPerMTok);
        }
      }
      entries.push(e);
    }
    if (bad > keys.length * MAX_BAD_PRICE_FRACTION || drifted > compared * MAX_DRIFT_FRACTION || entries.length === 0 || entries.length < prior.size * SHRINK_FLOOR) return failure();
    return { ok: true, entries, report };
  });
}
/** Ported _stripped and _norm_model_id. Normalized names match AWS model labels. */
export function normalizeBedrockModel(model: string): string {
  let text = model.slice(model.indexOf("/") + 1).toLowerCase();
  if (text.includes(".")) text = text.replace(/^(?:(?:us-gov|us|eu|apac|global|jp|au|in|ca)\.)?[a-z0-9-]+\./u, "");
  return text.replace(/(?:-\d{8})?(?:-v\d+(?::\d+)?)?$|@\d+$/u, "");
}
const AWS_USAGE = /_(input|output|cache_read|cache_write)_tokens(_1h)?(_long_ctx)?(_global)?_standard-Units$/u;
export function fetchAWS(transport: PriceTransport, limits: SourceLimits = {}): Promise<PriceFetchResult> {
  return withBudget(limits, AWS_MAX_BYTES, async (budget) => {
    const regions = limits.regions ?? AWS_REGIONS; const min = limits.minModels ?? MIN_AWS_MODELS;
    if (!whole(min) || min < 1 || !Array.isArray(regions) || regions.length < 1 || regions.length > MAX_AWS_REGIONS || new Set(regions).size !== regions.length || regions.some((r: unknown) => typeof r !== "string" || !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u.test(r))) return failure();
    const models = new Map<string, { input: number; output: number; baseInput: boolean; baseOutput: boolean }>(); const report: PriceReport = { skipped: [], ignoredLower: 0 };
    for (const region of regions as readonly string[]) {
      const offer = await read(transport, awsUrl(region), budget); const products = record(offer.products); const terms = record(record(offer.terms)?.OnDemand);
      if (products === undefined || terms === undefined || Object.keys(products).length === 0) return failure();
      budget.entries += Object.keys(products).length; if (budget.entries > MAX_ENTRIES_PER_SOURCE) return failure();
      for (const [sku, product] of Object.entries(products)) {
        if (performance.now() > budget.deadline || budget.signal.aborted) return failure();
        const attrs = record(record(product)?.attributes); const usage = typeof attrs?.usagetype === "string" ? AWS_USAGE.exec(attrs.usagetype) : null;
        if (typeof attrs?.model !== "string" || usage === null || (usage[2] !== undefined && (usage[1] !== "cache_write" || usage[3] !== undefined))) { report.skipped.push("unsupported usage"); continue; }
        const name = attrs.model.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
        let price = 0; let invalid = false;
        const skuTerms = record(terms[sku]); if (skuTerms === undefined) return failure();
        for (const term of Object.values(skuTerms)) {
          const dims = record(record(term)?.priceDimensions); if (dims === undefined) return failure();
          for (const dimension of Object.values(dims)) {
            const d = record(dimension); if (d?.unit !== "1M tokens") continue;
            const raw = record(d.pricePerUnit)?.USD;
            const n = typeof raw === "string" && /^(?:\d+)(?:\.\d+)?$/u.test(raw) ? Number(raw) : NaN;
            if (!Number.isFinite(n) || n <= 0 || n > PRICE_MAX / MICROS_PER_USD) invalid = true;
            else price = Math.max(price, Math.ceil(n * MICROS_PER_USD));
          }
        }
        if (invalid || price === 0) return failure(); // Never publish a cheaper partial model after losing a priced tier.
        const row = models.get(name) ?? { input: 0, output: 0, baseInput: false, baseOutput: false };
        if (usage[1] === "output") { row.output = Math.max(row.output, price); row.baseOutput ||= usage[3] === undefined; }
        else { row.input = Math.max(row.input, price); row.baseInput ||= usage[1] === "input" && usage[3] === undefined; }
        models.set(name, row);
      }
    }
    const entries: PriceEntry[] = [];
    for (const [model, rate] of models) {
      if (!rate.baseInput || !rate.baseOutput) { report.skipped.push("missing base rate"); continue; }
      const e: PriceEntry = { provider: "bedrock", model, kind: "chat", inputMicrosPerMTok: rate.input, outputMicrosPerMTok: rate.output };
      if (!validEntry(e)) { report.skipped.push("unsupported entry"); continue; } entries.push(e);
    }
    if (entries.length < min || entries.length < (limits.previous?.length ?? 0) * SHRINK_FLOOR) return failure();
    return { ok: true, entries, report };
  });
}
