// Signed, company-scoped price read. No reservation, model invocation or key opening.
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { resolveAgentSource, agentSourceSwitchedOn, type AgentSourcePorts } from "./agent-ai.js";
import type { SnapshotPriceSource } from "./price-index.js";
import { resolvePrice, dearerPrice } from "./price.js";
import { completePrice, type RateKey } from "./price-tiers.js";
import { STALE_ALARM_MS } from "./price-constants.js";
import { SERVICE_TOKEN_TYPE, SERVICE_TOKEN_SECONDS, SERVICE_TOKEN_CLAIMS } from "./offered-models.js";
import { COMPANY, record, whole } from "./model-gateway-token.js";
import type { SignedTokenKind } from "./token.js";
import { serviceCallLimiter } from "./service-call.js";

export const RATE_QUOTE_AUDIENCE = "rovara-model-gateway-rate-quote";
export const RATE_QUOTE_PATH = /^\/v1\/service\/companies\/(org_[0-9a-z]{20})\/rate-quote(?:\?.*)?$/u;
interface Claims { iss: string; cid: string; aud: typeof RATE_QUOTE_AUDIENCE; jti: string; iat: number; nbf: number; exp: number }
export const RATE_QUOTE_TOKEN_KIND: SignedTokenKind<Claims> = {
  typ: SERVICE_TOKEN_TYPE, maxSeconds: SERVICE_TOKEN_SECONDS,
  parse(value) {
    const c = record(value);
    if (c === undefined || Object.keys(c).length !== SERVICE_TOKEN_CLAIMS.length || !SERVICE_TOKEN_CLAIMS.every((k) => Object.hasOwn(c, k)) || c.aud !== RATE_QUOTE_AUDIENCE || typeof c.iss !== "string" || !c.iss || c.iss.length > 2048 || typeof c.cid !== "string" || !COMPANY.test(c.cid) || typeof c.jti !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(c.jti) || !whole(c.iat) || !whole(c.nbf) || !whole(c.exp)) return undefined;
    return c as unknown as Claims;
  },
};
export interface RateQuoteOptions extends AgentSourcePorts {
  verify(token: unknown): Promise<Claims | undefined>;
  prices: SnapshotPriceSource;
  region: string;
  now?: () => number;
  switchedOn: ReadonlySet<string>;
  /** Provider transports actually installed on the agent route. */
  offeredProviders: ReadonlySet<string>;
  rovara?: { models: ReadonlyMap<string, string>; exempt: ReadonlySet<string> };
  keys: AgentSourcePorts["keys"] & { identityFor?(iss: string, cid: string, provider: "anthropic" | "openai" | "openrouter"): Promise<{ sourceId: string; versionId: string } | undefined> };
}
const unavailable = { status: 200, body: { state: "unavailable", reason: "missing_price" } } as const;
const refused = { status: 401, body: { error: { type: "unauthorized", message: "the service call is not signed" } } } as const;
const names = { inputMicrosPerMTok: "input", outputMicrosPerMTok: "output", cacheReadMicrosPerMTok: "cacheRead", cacheWrite5mMicrosPerMTok: "cacheWrite5m", cacheWrite1hMicrosPerMTok: "cacheWrite1h" } as const;
export async function answerRateQuote(options: RateQuoteOptions, request: { method: string; url: string; headers: Readonly<Record<string, string | string[] | undefined>> }): Promise<{ status: number; body: unknown }> {
  const target = RATE_QUOTE_PATH.exec(request.url);
  if (target === null) return { status: 404, body: { error: { type: "not_found" } } };
  if (request.method !== "GET") return { status: 405, body: { error: { type: "not_found" } } };
  const auth = request.headers.authorization;
  if (typeof auth !== "string" || !auth.startsWith("Bearer ") || request.headers["x-api-key"] !== undefined) return refused;
  let claims: Claims | undefined;
  try { claims = await options.verify(auth.slice(7)); } catch { return refused; }
  if (claims === undefined || claims.cid !== target[1]) return refused;
  const url = new URL(request.url, "https://gateway.invalid");
  const model = url.searchParams.get("model");
  if (model === null || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/u.test(model) || [...url.searchParams.keys()].some((k) => k !== "model") || url.searchParams.getAll("model").length !== 1) return unavailable;
  try {
    const { source: chosen } = await resolveAgentSource({ sources: options.sources, keys: options.keys, ...(options.rovara === undefined ? {} : { exempt: options.rovara.exempt }), ...(options.byo === undefined ? {} : { byo: options.byo }) }, claims.iss, claims.cid);
    const source = chosen ?? "anthropic_key";
    if (!agentSourceSwitchedOn(source, options.switchedOn)) return unavailable;
    let provider: "anthropic" | "openai" | "openrouter" | "bedrock"; let modelId = model; let region = "global"; let id: string; let revision: string;
    if (source === "rovara") {
      const mapped = options.rovara?.models.get(model);
      if (mapped === undefined) return unavailable;
      provider = "bedrock"; modelId = mapped; region = options.region; id = "rovara";
      revision = createHash("sha256").update(JSON.stringify([...options.rovara!.models].sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
    } else if (source === "anthropic_key" || source === "openai_key" || source === "openrouter_key") {
      provider = source === "anthropic_key" ? "anthropic" : source === "openai_key" ? "openai" : "openrouter";
      if (!await options.keys.connected(claims.iss, claims.cid, provider)) return unavailable;
      const identity = await options.keys.identityFor?.(claims.iss, claims.cid, provider);
      if (identity === undefined || !identity.sourceId || !identity.versionId) return unavailable;
      id = identity.sourceId; revision = identity.versionId;
    } else if (source === "bedrock_byo") {
      const found = await options.byo?.connection(claims.iss, claims.cid);
      const mapped = found === undefined ? undefined : found.connection.models[model];
      if (found === undefined || mapped === undefined || found.row.cid !== claims.cid || found.row.iss !== claims.iss) return unavailable;
      provider = "bedrock"; modelId = mapped; region = found.connection.region; id = found.row.sourceId; revision = found.row.versionId;
    } else {
      // Endpoint catalog metadata is not available without opening a credential. Do not invent a region or revision.
      return unavailable;
    }
    if (!options.offeredProviders.has(provider)) return unavailable;
    const basis = options.prices.quoteBasis(provider, modelId);
    const now = (options.now ?? Date.now)();
    if (basis === undefined || basis.fetchedAt > now || now - basis.fetchedAt >= STALE_ALARM_MS) return unavailable;
    let price = await resolvePrice(options.prices, provider, modelId);
    if (source === "bedrock_byo") {
      const anthropic = await resolvePrice(options.prices, "anthropic", model);
      const components = [...(price.derived ?? []), ...(anthropic.estimated ? [] : anthropic.derived ?? [])];
      price = { ...dearerPrice(price, anthropic), derived: components };
    }
    if (price.operatorReview || (price.estimated && !price.knownTokenPrice) || price.priceVersion !== basis.version) return unavailable;
    if (options.prices.mediaFor(provider, modelId) !== undefined) return unavailable;
    const p = completePrice(price);
    const rates = (r: typeof p) => ({ input: r.inputMicrosPerMTok, output: r.outputMicrosPerMTok, cacheRead: r.cacheReadMicrosPerMTok!, cacheWrite5m: r.cacheWrite5mMicrosPerMTok!, cacheWrite1h: r.cacheWrite1hMicrosPerMTok! });
    const base = rates(p);
    const longContext = (p.longContext ?? []).map((band) => ({ aboveInputTokens: band.aboveTokens, rates: rates({ ...p, ...band }) }));
    if (![base, ...longContext.map((b) => b.rates)].every((r) => Object.values(r).every(whole))) return unavailable;
    const derived = [...new Set([...(p.derived ?? []), ...(p.uncertain ?? [])].map((b) => b.aboveTokens))].sort((a, b) => a - b).map((threshold) => ({ aboveInputTokens: threshold, components: [...new Set([...(p.derived ?? []), ...(p.uncertain ?? [])].filter((b) => b.aboveTokens === threshold).flatMap((b) => b.keys).filter((key): key is Exclude<RateKey, "cacheWriteMicrosPerMTok"> => key !== "cacheWriteMicrosPerMTok").map((key) => names[key]))] }));
    return { status: 200, body: { state: "available", value: { version: 1, currency: "USD", unit: "micros_per_million_tokens", ref: { authority: "gateway", version: String(basis.version), hash: basis.hash, fetchedAt: new Date(basis.fetchedAt).toISOString() }, source: { kind: source === "rovara" ? "rovara_ai" : "company_key", id, name: source === "rovara" ? "Rovara AI" : "Company AI", provider, connectionRevision: revision }, model: { provider, modelId: basis.model }, region, asOf: new Date(now).toISOString(), expiresAt: new Date(Math.min(now + 300_000, basis.fetchedAt + STALE_ALARM_MS)).toISOString(), base, longContext, derived } } };
  } catch { return unavailable; }
}
export function createRateQuoteHandler(options: RateQuoteOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const limiter = serviceCallLimiter(options.now ?? Date.now, 8, 600);
  return async (req, res) => {
    const release = limiter.take();
    try {
      req.resume();
      const answer = release === undefined ? { status: 429, body: { error: { type: "busy" } } } : await answerRateQuote(options, { method: req.method ?? "", url: req.url ?? "", headers: req.headers });
      if (res.destroyed || res.headersSent) return;
      res.writeHead(answer.status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(answer.body));
    } finally { release?.(); }
  };
}
