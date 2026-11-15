// Gemini (Google AI Studio, generativelanguage.googleapis.com) for the product route: path parsing, the body guard, usage
// reading for streamed (alt=sse) and whole answers, and the provider transport. Fixed host, TLS, port 443, one attempt,
// no redirects; the key is attached only in the transport, as `x-goog-api-key`.
import https from "node:https";
import type { ClientRequest } from "node:http";
import { record, whole } from "./model-gateway-token.js";
import { MAX_BODY_BYTES, MAX_BODY_ITEMS, tooLarge, type GuardFailure, type ModelLimitsSource } from "./guard.js";
import { NotSentError, type ProviderTransport } from "./provider.js";
import type { RouteCall, UsageReader } from "./server.js";
import type { TokenUsage } from "./usage.js";

export const GEMINI_HOST = "generativelanguage.googleapis.com";
export const GEMINI_VERSIONS = ["v1", "v1beta"] as const;
export const GEMINI_MODEL = /^[a-z0-9][a-z0-9.-]{0,95}$/u;
/**
 * Used when the model has no known output limit (DEC 172/216: an unknown model is never refused). The gateway always sets
 * maxOutputTokens on the forwarded request, so the provider cannot answer more than this; Gemini 2.5 counts thinking tokens
 * inside maxOutputTokens (assumed from Google's docs; verify on staging, DEFERRED row PRODUCT-GEMINI-THOUGHTS-IN-MAX).
 */
export const GEMINI_DEFAULT_MAX_OUTPUT_TOKENS = 65_536;
export const PRODUCT_TOOL_REFUSED = "This tool is not available for product AI calls yet.";
export const PRODUCT_AUDIO_REFUSED = "Audio and video input are not available for product AI calls yet.";
export const PRODUCT_OUTPUT_REFUSED = "Only text answers are available for product AI calls yet.";

export interface GeminiPath { version: typeof GEMINI_VERSIONS[number]; model: string; streaming: boolean }
/** `/v1/product/gemini/{v1|v1beta}/models/{model}:{generateContent|streamGenerateContent}`; streaming requires `alt=sse` and no other query. */
export function parseGeminiPath(path: string, query: string): GeminiPath | undefined {
  const m = /^\/v1\/product\/gemini\/(v1|v1beta)\/models\/([^/:]+):(generateContent|streamGenerateContent)$/u.exec(path);
  if (m === null || !GEMINI_MODEL.test(m[2]!)) return undefined;
  const streaming = m[3] === "streamGenerateContent";
  // A `key=` (or any other) parameter is refused: a credential never travels in a URL, and the worker must have replaced the sandbox's dummy key.
  if (streaming ? query !== "alt=sse" : query !== "") return undefined;
  return { version: m[1] as GeminiPath["version"], model: m[2]!, streaming };
}

const bad = (message = "request not allowed"): GuardFailure => ({ ok: false, status: 400, code: "invalid_request", message });
const FIELDS = new Set(["contents", "systemInstruction", "generationConfig", "safetySettings", "tools", "toolConfig", "cachedContent"]);
const CONFIG = new Set(["temperature", "topP", "topK", "candidateCount", "maxOutputTokens", "stopSequences", "responseMimeType", "responseSchema", "responseJsonSchema", "presencePenalty", "frequencyPenalty", "seed", "responseLogprobs", "logprobs", "thinkingConfig", "mediaResolution", "responseModalities"]);
const PART_KINDS = new Set(["text", "inlineData", "fileData", "functionCall", "functionResponse", "thought", "thoughtSignature", "executableCode", "codeExecutionResult", "videoMetadata"]);
/**
 * Media billed at the text input rate (images, PDF pages, plain text files). Audio has its own rate and video carries an
 * audio track, so both are refused until priced; a file with no declared type could be either, so it is refused too.
 */
const textRateMedia = (v: unknown): boolean => {
  const r = record(v); if (r === undefined) return false;
  // Google's JSON parser takes both spellings of every field (mimeType and mime_type): either is checked, and two that differ are refused.
  const camel = r.mimeType; const snake = r.mime_type;
  if (camel !== undefined && snake !== undefined && camel !== snake) return false;
  const m = camel ?? snake;
  return typeof m === "string" && m.length <= 128 && /^(?:image\/[a-z0-9.+-]+|application\/pdf|text\/[a-z0-9.+-]+)$/iu.test(m);
};
/** Media field names, in both spellings Google accepts (REVIEW-1 recheck N2). */
const MEDIA_KEYS = ["inlineData", "fileData", "inline_data", "file_data"] as const;

/** The product route's body guard. Fixed refusal words; one total item limit; never a silent partial parse. */
export function guardGemini(bytes: Buffer, headers: Readonly<Record<string, string | undefined>>, path: GeminiPath, modelLimits: ModelLimitsSource): RouteCall | GuardFailure {
  if (bytes.length > MAX_BODY_BYTES) return tooLarge();
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(headers["content-type"] ?? "")) return bad();
  // The sandbox's dummy Google key must have been replaced by the worker: a Google credential header here is refused.
  if (headers["x-goog-api-key"] !== undefined || headers["x-goog-user-project"] !== undefined) return bad();
  if (Object.keys(headers).length > 64 || Object.entries(headers).reduce((total, [name, value]) => total + name.length + (value?.length ?? 0), 0) > 16384) return bad();
  let b: Record<string, unknown> | undefined;
  try { b = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown); } catch { return bad(); }
  if (b === undefined || Object.keys(b).some((k) => !FIELDS.has(k)) || !Array.isArray(b.contents) || b.contents.length === 0) return bad();
  const config = b.generationConfig === undefined ? {} : record(b.generationConfig);
  if (config === undefined || Object.keys(config).some((k) => !CONFIG.has(k))) return bad();
  if (config.candidateCount !== undefined && config.candidateCount !== 1) return bad();
  if (config.maxOutputTokens !== undefined && (!whole(config.maxOutputTokens) || config.maxOutputTokens < 1)) return bad();
  if (config.responseModalities !== undefined && (!Array.isArray(config.responseModalities) || !config.responseModalities.every((m: unknown) => m === "TEXT"))) return bad(PRODUCT_OUTPUT_REFUSED);
  if (config.thinkingConfig !== undefined) {
    const t = record(config.thinkingConfig);
    if (t === undefined || Object.keys(t).some((k) => !["thinkingBudget", "includeThoughts", "thinkingLevel"].includes(k)) || (t.thinkingBudget !== undefined && (typeof t.thinkingBudget !== "number" || !Number.isSafeInteger(t.thinkingBudget) || t.thinkingBudget < -1))) return bad();
  }
  // Only plain function declarations: server tools (search grounding, code execution, URL context, maps, file search) bill
  // outside token usage or loop beyond the body's input bound, so they are refused until priced (DEFERRED PRODUCT-GEMINI-TOOLS).
  if (b.tools !== undefined && (!Array.isArray(b.tools) || !b.tools.every((tool: unknown) => { const t = record(tool); return t !== undefined && Object.keys(t).every((k) => k === "functionDeclarations") && Array.isArray(t.functionDeclarations); }))) return bad(PRODUCT_TOOL_REFUSED);
  if (b.cachedContent !== undefined && (typeof b.cachedContent !== "string" || b.cachedContent.length > 512)) return bad();
  // A cached context is outside the body: it can't be bounded from the bytes, so the call is overrun-capable (DEC 165, ADDENDUM-3).
  let inputBounded = b.cachedContent === undefined;
  // Each content (and the system instruction) is `{ role?, parts: [...] }`; every part names a known kind.
  const contents = [...(b.contents as unknown[]), ...(b.systemInstruction === undefined ? [] : [b.systemInstruction])];
  if (contents.length > MAX_BODY_ITEMS) return bad();
  for (const content of contents) {
    const c = record(content);
    if (c === undefined || !Array.isArray(c.parts) || Object.keys(c).some((k) => k !== "role" && k !== "parts")) return bad();
    for (const part of c.parts) {
      // Every key of a top-level part is a known kind (camelCase): an extra field can't ride next to an allowed one.
      const p = record(part); if (p === undefined || Object.keys(p).length === 0 || !Object.keys(p).every((k) => PART_KINDS.has(k))) return bad();
    }
  }
  // One total item limit over the whole body (nested schemas and arguments included), iteratively. Inside the contents and
  // the system instruction, media at ANY depth (for example functionResponse.parts[].inlineData) gets the same type check and
  // makes the call overrun-capable; a data field that merely looks like media is treated as media (REVIEW-1 recheck N1).
  // Media is billed per item (an image is at least 258 tokens, a PDF page 258), not per body byte, and a remote file on its
  // real size, as the agent guard treats every non-text part (REVIEW-1 H1).
  const stack: Array<[unknown, boolean]> = [[b.contents, true], [b.systemInstruction, true], [{ ...b, contents: undefined, systemInstruction: undefined }, false]];
  let count = 0;
  while (stack.length > 0) {
    if (++count > MAX_BODY_ITEMS) return bad();
    const [v, content] = stack.pop()!;
    if (Array.isArray(v)) { for (const x of v) stack.push([x, content]); continue; }
    const r = record(v); if (r === undefined) continue;
    if (content && MEDIA_KEYS.some((k) => Object.hasOwn(r, k))) {
      if (MEDIA_KEYS.some((k) => Object.hasOwn(r, k) && !textRateMedia(r[k]))) return bad(PRODUCT_AUDIO_REFUSED);
      inputBounded = false;
    }
    for (const x of Object.values(r)) stack.push([x, content]);
  }
  let rowMax: unknown;
  try { rowMax = modelLimits.maxOutputTokens("gemini", path.model); } catch { rowMax = undefined; }
  const limit = whole(rowMax) && rowMax >= 1 ? rowMax : GEMINI_DEFAULT_MAX_OUTPUT_TOKENS;
  if (typeof config.maxOutputTokens === "number" && config.maxOutputTokens > limit) return bad();
  const maxTokens = typeof config.maxOutputTokens === "number" ? config.maxOutputTokens : limit;
  const forwarded = Buffer.from(JSON.stringify({ ...b, generationConfig: { ...config, maxOutputTokens: maxTokens } }));
  const upstream = `/${path.version}/models/${path.model}:${path.streaming ? "streamGenerateContent?alt=sse" : "generateContent"}`;
  return { ok: true, hasTools: Array.isArray(b.tools), inputBounded, model: path.model, maxTokens, streaming: path.streaming, bytes: forwarded, headers: { "content-type": "application/json" }, path: upstream };
}

const MAX_EVENT = 4 * 1024 * 1024;
const MAX_STREAM = 10 * 1024 * 1024;
/**
 * Reads `usageMetadata` (cumulative; the last one wins) and requires a finish: a candidate `finishReason` or a prompt
 * `blockReason`. Counts only, never text. Anything malformed or incomplete makes the whole call fall back to its hold.
 */
export class GeminiUsageCollector implements UsageReader {
  #pending = ""; #data: string[] = []; #eventBytes = 0; #total = 0;
  #failed = false; #finished = false; #usage: TokenUsage | undefined;
  #decoder = new TextDecoder("utf-8", { fatal: true });
  push(bytes: Uint8Array): void {
    if (this.#failed) return;
    this.#total += bytes.length;
    if (this.#total > MAX_STREAM) { this.#failed = true; return; }
    try {
      this.#pending += this.#decoder.decode(bytes, { stream: true });
      let at: number;
      while ((at = this.#pending.indexOf("\n")) >= 0) {
        const line = this.#pending.slice(0, at).replace(/\r$/u, ""); this.#pending = this.#pending.slice(at + 1);
        this.#eventBytes += line.length; if (this.#eventBytes > MAX_EVENT) { this.#failed = true; break; }
        if (line === "") { this.#frame(); this.#eventBytes = 0; }
        else if (line.startsWith("data:")) this.#data.push(line.slice(5).replace(/^ /u, ""));
        else if (!line.startsWith(":") && !/^(event|id|retry):/u.test(line)) this.#failed = true;
      }
      if (this.#pending.length > MAX_EVENT) this.#failed = true;
    } catch { this.#failed = true; }
    if (this.#failed) { this.#pending = ""; this.#data = []; }
  }
  #frame(): void {
    if (this.#data.length === 0) return;
    try { this.#response(JSON.parse(this.#data.join("\n")) as unknown); } catch { this.#failed = true; }
    this.#data = [];
  }
  #response(value: unknown): void {
    const r = record(value);
    if (r === undefined || r.error !== undefined) { this.#failed = true; return; }
    if (r.usageMetadata !== undefined) {
      const usage = geminiUsage(r.usageMetadata);
      if (usage === undefined || (this.#usage !== undefined && usage.output < this.#usage.output)) { this.#failed = true; return; }
      this.#usage = usage;
    }
    const candidates = r.candidates;
    if (candidates !== undefined && !Array.isArray(candidates)) { this.#failed = true; return; }
    if (Array.isArray(candidates) && candidates.some((c: unknown) => typeof record(c)?.finishReason === "string")) this.#finished = true;
    if (typeof record(r.promptFeedback)?.blockReason === "string") this.#finished = true;
  }
  whole(value: unknown): void { this.#response(value); }
  finish(): TokenUsage | undefined {
    try { this.#pending += this.#decoder.decode(); } catch { this.#failed = true; }
    if (this.#pending.trim() !== "" && this.#data.length === 0 && !this.#failed) { this.#data.push(this.#pending.replace(/^data: ?/u, "")); this.#frame(); }
    const complete = !this.#failed && this.#data.length === 0 && this.#finished && this.#usage !== undefined;
    this.#pending = ""; this.#data = [];
    return complete ? { ...this.#usage! } : undefined;
  }
}
/** Billing mapping: cached prompt tokens at the cache-read rate, the rest of the prompt and tool-use prompt at input, answer plus thinking at output. */
export function geminiUsage(value: unknown): TokenUsage | undefined {
  const u = record(value); if (u === undefined) return undefined;
  const n = (v: unknown) => v === undefined ? 0 : whole(v) && v <= 1_000_000_000 ? v : NaN;
  const prompt = u.promptTokenCount; if (!whole(prompt) || prompt > 1_000_000_000) return undefined;
  const cached = n(u.cachedContentTokenCount); const tool = n(u.toolUsePromptTokenCount); const answer = n(u.candidatesTokenCount); const thoughts = n(u.thoughtsTokenCount);
  if (![cached, tool, answer, thoughts].every(Number.isFinite) || cached > prompt) return undefined;
  return { input: prompt - cached + tool, output: answer + thoughts, cacheRead: cached, cacheWrite: 0 };
}

/** Fixed host, TLS, one attempt, no redirect following. The path comes from guardGemini only. */
export function createGeminiTransport(request: typeof https.request = https.request): ProviderTransport {
  return async (input) => {
    if (input.signal.aborted) throw new NotSentError();
    if (typeof input.path !== "string" || !/^\/v1(?:beta)?\/models\/[a-z0-9][a-z0-9.-]{0,95}:(?:generateContent|streamGenerateContent\?alt=sse)$/u.test(input.path)) throw new NotSentError();
    return new Promise((resolve, reject) => {
      let connected = false;
      const fail = () => reject(connected ? new Error("provider unavailable") : new NotSentError());
      let call: ClientRequest;
      try { call = request({ hostname: GEMINI_HOST, port: 443, path: input.path, method: "POST", agent: false, rejectUnauthorized: true, headers: { ...input.headers, "x-goog-api-key": input.key, "content-length": String(input.body.byteLength) } }, (response) => {
        resolve({ status: response.statusCode ?? 0, body: response as AsyncIterable<Uint8Array>, cancel: () => response.destroy() });
      }); } catch { reject(new NotSentError()); return; }
      const abort = () => { call.destroy(); fail(); };
      call.once("socket", (socket) => socket.once("secureConnect", () => { connected = true; }));
      call.once("error", fail);
      call.once("close", () => input.signal.removeEventListener("abort", abort));
      input.signal.addEventListener("abort", abort, { once: true });
      if (input.signal.aborted) abort();
      else { try { call.end(input.body); } catch { call.destroy(); fail(); } }
    });
  };
}
