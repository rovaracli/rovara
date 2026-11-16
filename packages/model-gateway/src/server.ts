import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentAiSourceReader, RovaraAi } from "./agent-ai.js";
import { bedrockInvokePath } from "./bedrock-transport.js";
import { validCaps, type Caps, type CapsSource } from "./caps.js";
import type { EndedTasks } from "./ended.js";
import { estimateCall, TOOL_INPUT_ALLOWANCE_TOKENS, type MediaEstimate } from "./estimate.js";
import type { MediaRates } from "./media-price.js";
import { guardRequest, MAX_BODY_BYTES, tooLarge, type GuardFailure, type ModelLimitsSource } from "./guard.js";
import type { BillLine, Meter, MeterItem, MeterScope, Reservation } from "./meter.js";
import { LEARNING_PATH_PREFIX, LEARNING_STEP, type LearningKeySource, type LearningRouteFactory } from "./learning-route.js";
import { dearerPrice, resolvePrice, UnknownPriceSource, type PriceSource } from "./price.js";
import { CALL_HARD_CEILING_MS, callDurationMs, MAX_RESPONSE_BYTES, NotSentError, SecretScanner, type ProviderKeys, type ProviderResponse, type ProviderTransport } from "./provider.js";
import { AUTH_ERROR, TASK_TOKEN_SECONDS, type TaskClaims, type TaskTokenVerifier } from "./token.js";
import { settleAmount } from "./reported-cost.js";
import type { ResolvedPrice } from "./price.js";
import type { EstimatedSettlement } from "./meter.js";
import type { TokenUsage } from "./usage.js";
import { UsageCollector } from "./usage.js";
export interface GatewayRequest { method: string; url: string; headers: Readonly<Record<string, string | undefined>>; body: AsyncIterable<Uint8Array>; signal?: AbortSignal }
export interface GatewaySink { head(status: number, headers: Readonly<Record<string, string>>): void; write(bytes: Uint8Array): Promise<void>; end(): void; destroy(): void }
export type GatewayLogEvent = { event: "settled"; estimated: boolean; costMicros: number; appliedMaxOutputTokens: number; route?: "product" | "learning" } | { event: "overrun_busy"; company: string } | { event: "settle_failed" | "refused" | "provider_error" | "price_operator_review" | "product_key_refused" | "product_over_reservation" };
export interface GatewayDependencies {
  verifyToken: TaskTokenVerifier; ended: EndedTasks; meter: Meter; caps: CapsSource; prices?: PriceSource;
  metrics: { overrunBusy(issuer: string, company: string): void };
  modelLimits: ModelLimitsSource; now?: () => number;
  keys: ProviderKeys; transport: ProviderTransport; cautiousCeiling?: number; timeoutMs?: number;
  log: (event: GatewayLogEvent) => void;
  /** The product-AI route (calls made by the customer's tests with the project's own key). Absent: every product path is 404, as before. */
  product?: ProductRouteResolver;
  /** The learning route (DEC 226, learning-route.ts: lessons' calls on the company's own key). Absent: its path is 404. */
  learning?: LearningRouteFactory;
  /**
   * DEC 236: the agent route on each company's OWN connected AI key (company-key mode), from the same sealed company-level store
   * the learning route reads. Set: `keys` (Rovara's install key) is never read for an agent call, a company with no usable key is
   * refused before anything is held (AGENT_KEY_MISSING), and the combined company cap applies as before. Absent: the install key.
   */
  agentKeys?: LearningKeySource;
  /**
   * DEC 240, only with `agentKeys` (company-key mode): each company's chosen agent AI source. A saved "rovara" sends the call to
   * Rovara's AI (`rovara`; refused when absent) and never reads the company's key; "anthropic_key" or no saved choice is DEC 236
   * exactly; "bedrock_byo" is refused for now. Absent: DEC 236 exactly.
   */
  agentAi?: { sources: AgentAiSourceReader; rovara?: RovaraAi };
}
/** One provider call shape after its route's guard. `path` is built by the guard from checked parts, never copied from the request. */
export interface RouteCall {
  ok: true; hasTools: boolean; inputBounded: boolean; model: string; maxTokens: number; streaming: boolean; bytes: Buffer; headers: Readonly<Record<string, string>>; path?: string;
  /** The model's audio/video prices (product route): attached to the call's price for the estimate and the settle. */
  mediaRates?: MediaRates;
  /** Inline audio/video: estimated prompt tokens, replacing their `dataBytes` encoded bytes in the hold (DEC 228e). */
  media?: MediaEstimate & { dataBytes: number };
}
export interface UsageReader { push(bytes: Uint8Array): void; whole(value: unknown): void; finish(): TokenUsage | undefined }
/** A fixed refusal a route answers before any money moves. */
export interface RouteRefusal { ok: false; status: number; code: string; message: string; headers?: Readonly<Record<string, string>> }
/** Everything that differs between the agent route and the product route. The money core (hold, settle, deadline, scan) is shared. */
export interface GatewayRoute {
  /** Price, ledger and log provider name. */
  readonly provider: string;
  readonly product: boolean;
  readonly meter: Meter;
  readonly prefix: Readonly<Record<MeterItem, string>>;
  guard(bytes: Buffer, headers: Readonly<Record<string, string | undefined>>, claims: TaskClaims): RouteCall | GuardFailure;
  scope(claims: TaskClaims): MeterScope;
  /** Before the hold. A refusal here moves no money. */
  admit?(claims: TaskClaims, signal: AbortSignal): Promise<RouteRefusal | undefined>;
  caps(scope: MeterScope, claims: TaskClaims, signal: AbortSignal): Promise<Caps | RouteRefusal>;
  key(claims: TaskClaims, signal: AbortSignal): Promise<string>;
  transport: ProviderTransport;
  usage(): UsageReader;
  /** A provider answer that is not 2xx. `charged: false` only for an explicit rejection before any generation. `body`: its first bytes, when `failureBody`. */
  providerFailure(status: number, body?: Uint8Array): { charged: boolean; refusal: RouteRefusal };
  /** Read (at most FAILURE_BODY_BYTES of) a failed provider answer for providerFailure's classification. Never echoed. */
  readonly failureBody?: boolean;
  /**
   * The answer as events (an eval stage call, product-eval.ts): the core writes through the returned sink and, after the call
   * settled, calls its finish exactly once with how the call ended.
   */
  readonly events?: { sink(real: GatewaySink): GatewaySink & { finish(outcome: { completed: boolean; code?: string }): Promise<void> } };
  /**
   * The token purpose this route serves. "learning": only learning tokens (`stp` = LEARNING_STEP); absent: only task tokens.
   * Either mismatch gets the fixed 401 before anything is read, held or sent.
   */
  readonly purpose?: "learning";
  /** false: the task-ended record does not stop this route's calls (learning runs after its task ended). Absent: it does. */
  readonly stopsWithTask?: false;
  /** A permanent cap refusal from the meter, in the route's own words. Absent: 422 budget_exceeded with `prefix`. */
  capRefusal?(refused: { reason: "cap" | "overrun"; item: MeterItem }, scope: MeterScope, caps: Caps, estimateMicros: number, signal: AbortSignal): Promise<RouteRefusal>;
  /** Why a call was not sent after its hold (the key port answered nothing): the route's own refusal. Absent or undefined: 502 provider_error. */
  notSent?(): RouteRefusal | undefined;
  /** After settlement: the actual cost passed the hold (DEC 165). Never throws to the caller. */
  overReservation?(claims: TaskClaims): Promise<void>;
  /**
   * More price rows for the same call (Vertex: its own vertex rows besides the Gemini rows `provider` names). Each one that is
   * known is merged in at the dearer rate per component (dearerPrice): a call is never priced below any of its rows.
   */
  alsoPricedAs?(model: string): ReadonlyArray<{ provider: string; model: string }>;
  /** DEC 240b: the billable line this call's hold carries to its ledger row (Rovara's AI). Absent or undefined: none. */
  line?(claims: TaskClaims, model: string): BillLine | undefined;
}
/** A product request that is not a provider call (the eval stage hold and release): JSON in, JSON out, after the token check. */
export interface ProductControl { readonly control: true; /** Also answered after the task ended (a release only gives budget back). */ readonly afterTaskEnd?: true; handle(claims: TaskClaims, body: unknown, signal: AbortSignal): Promise<{ status: number; body: Readonly<Record<string, unknown>> }> }
/** Builds a product route for a request path, or undefined (404). Pure path parsing only; nothing is read before the token is checked. */
export interface ProductRouteResolver { route(path: string, query: string, headers: Readonly<Record<string, string | undefined>>): GatewayRoute | ProductControl | undefined }
export const CONTROL_BODY_BYTES = 16 * 1024;
export const FAILURE_BODY_BYTES = 64 * 1024;
export const OVERRUN_BUSY_MESSAGE = "Another call for this company may exceed its reserved cost right now; try again in a moment.";
export const OVERRUN_BUSY_RETRY_SECONDS = 2;
export const ENDED_TASK_POLL_MS = 1000;
const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const PREFIX: Record<MeterItem, string> = { task: "Budget has been exceeded! Key=task", person: "ExceededBudget: User=person", project: "Budget has been exceeded! Project=project", company: "Budget has been exceeded! Team=company" };
export const PRODUCT_ROUTE_PREFIX = "/v1/product/";
/** The agent route's refusal in company-key mode when the company has no usable AI key connected (DEC 236). Fixed words. */
export const AGENT_KEY_MISSING: RouteRefusal = Object.freeze({ ok: false as const, status: 403, code: "no_ai_key", message: "Connect an AI key: this company has no AI provider key connected, so its agents cannot call AI." });
/** Company-key mode: the provider refused the company's own key (401/403 before any output). Free; fixed words. */
export const AGENT_KEY_REFUSED: RouteRefusal = Object.freeze({ ok: false as const, status: 403, code: "no_ai_key", message: "Connect an AI key: the AI provider refused this company's connected key." });
const AGENT_UNAVAILABLE: RouteRefusal = Object.freeze({ ok: false as const, status: 503, code: "unavailable", message: "model access unavailable" });
/** DEC 240: the company chose its own Bedrock (DEC 238), which is not built yet. Nothing held or sent; no fallback. */
export const AGENT_SOURCE_NOT_OFFERED: RouteRefusal = Object.freeze({ ok: false as const, status: 403, code: "no_ai_key", message: "Choose AI for your agents: your own Bedrock is not available yet." });
/** DEC 240: the company chose Rovara's AI, and this gateway does not offer it. Nothing held or sent; no fallback to its key. */
export const ROVARA_AI_OFF: RouteRefusal = Object.freeze({ ok: false as const, status: 403, code: "no_ai_key", message: "Choose AI for your agents: Rovara's AI is not available on this install." });
/** DEC 240: a model that is not on Rovara's AI allow-list. Before any hold. */
export const ROVARA_AI_MODEL: GuardFailure = Object.freeze({ ok: false as const, status: 400, code: "invalid_request", message: "This model is not offered on Rovara's AI." });
/** DEC 240: Bedrock refused Rovara's own role (access or model not enabled). Free: the customer is never charged for it. */
export const ROVARA_AI_UNAVAILABLE: RouteRefusal = Object.freeze({ ok: false as const, status: 503, code: "unavailable", message: "Rovara's AI is unavailable right now. Try again later." });
const PROVIDER_ERROR: RouteRefusal = Object.freeze({ ok: false as const, status: 502, code: "provider_error", message: "provider unavailable" });
/** Bedrock's InvokeModel body version for Anthropic models. */
export const BEDROCK_ANTHROPIC_VERSION = "bedrock-2023-05-31";
/** The agent route: Anthropic Messages, the R3a behaviour exactly; on the company's own key when `agentKeys` is set (DEC 236). */
export function agentRoute(deps: GatewayDependencies): GatewayRoute {
  return deps.agentKeys !== undefined ? companyKeyAgentRoute(deps, deps.agentKeys) : installKeyAgentRoute(deps);
}
function installKeyAgentRoute(deps: GatewayDependencies): GatewayRoute {
  return {
    provider: "anthropic", product: false, meter: deps.meter, prefix: PREFIX,
    guard: (bytes, headers, claims) => guardRequest(bytes, headers, claims.mdl, deps.modelLimits),
    scope: (claims) => ({ iss: claims.iss, cid: claims.cid, pid: claims.pid, tid: claims.tid, ...(claims.per === undefined ? {} : { per: claims.per }) }),
    caps: (scope, _claims, signal) => deps.caps.capsFor(scope, signal),
    key: (claims, signal) => deps.keys.keyFor(claims, "anthropic", signal),
    transport: deps.transport,
    usage: () => new UsageCollector(),
    // An explicit rejection before any output uses the not-sent accounting rule for BOTH input and output.
    providerFailure: (status) => ({ charged: !(status === 429 || status === 529), refusal: { ok: false, status: 502, code: "provider_error", message: "provider unavailable" } }),
  };
}
/**
 * The agent route in company-key mode (DEC 236): the same guard, scope, caps (the combined company cap), meter, transport and usage
 * as the install-key route, but the key is ONLY the company's own connected key. Admission reads whether one is connected before
 * any hold; the key itself is read just before sending, and a key that went missing meanwhile is "not sent" ($0). The install key
 * (`deps.keys`) is never called, so there is no fallback to Rovara's account.
 */
function companyKeyAgentRoute(deps: GatewayDependencies, keys: LearningKeySource): GatewayRoute {
  const base = installKeyAgentRoute(deps);
  let admitted = false;
  let notSent: RouteRefusal | undefined;
  // DEC 240: set by admit when the company chose Rovara's AI; then the company's key is never read.
  let rovara: { ai: RovaraAi; marker: string } | undefined;
  return {
    ...base,
    get provider() { return rovara === undefined ? base.provider : "bedrock"; },
    get transport() { return rovara === undefined ? base.transport : rovara.ai.transport; },
    async admit(claims, signal) {
      const choice = deps.agentAi;
      if (choice !== undefined) {
        let source;
        try { source = await choice.sources.sourceFor(claims.cid, signal); } catch { return AGENT_UNAVAILABLE; }
        if (source === "bedrock_byo") return AGENT_SOURCE_NOT_OFFERED;
        if (source === "rovara") {
          if (choice.rovara === undefined) return ROVARA_AI_OFF;
          // A per-call marker stands in for a key: the transport signs with the task role, and no key exists to leak.
          rovara = { ai: choice.rovara, marker: `rovara-ai-${randomUUID()}` };
          admitted = true;
          return undefined;
        }
      }
      try { if ((await keys.connected(claims.iss, claims.cid, "anthropic", signal)) !== true) return AGENT_KEY_MISSING; }
      catch { return AGENT_UNAVAILABLE; }
      admitted = true;
      return undefined;
    },
    guard(bytes, headers, claims) {
      const checked = base.guard(bytes, headers, claims);
      if (rovara === undefined || !checked.ok) return checked;
      const id = rovara.ai.models.get(checked.model);
      if (id === undefined) return ROVARA_AI_MODEL;
      // The same checked Anthropic body, as InvokeModel takes it: no model or stream field (the path says both), Bedrock's version,
      // the allowed beta flags as a body field, and no metadata (Bedrock's Anthropic body has none).
      const rest = Object.fromEntries(Object.entries(JSON.parse(checked.bytes.toString("utf8")) as Record<string, unknown>).filter(([name]) => !["model", "stream", "metadata"].includes(name)));
      const beta = checked.headers["anthropic-beta"];
      const body = { anthropic_version: BEDROCK_ANTHROPIC_VERSION, ...rest, ...(beta === undefined ? {} : { anthropic_beta: beta.split(",").map((flag) => flag.trim()) }) };
      return { ...checked, model: id, bytes: Buffer.from(JSON.stringify(body)), headers: { "content-type": "application/json" }, path: bedrockInvokePath(id, checked.streaming) };
    },
    line(claims, model) {
      if (rovara === undefined) return undefined;
      return { source: "rovara_ai", charge: rovara.ai.exempt.has(claims.cid) ? "exempt" : "customer", model };
    },
    async key(claims, signal) {
      if (!admitted) return "";
      if (rovara !== undefined) return rovara.marker;
      let key: string | undefined;
      try { key = await keys.keyFor(claims.iss, claims.cid, "anthropic", signal); } catch { notSent = AGENT_UNAVAILABLE; return ""; }
      if (key === undefined) { notSent = AGENT_KEY_MISSING; return ""; }
      return key;
    },
    notSent: () => notSent,
    providerFailure: (status, body) => {
      if (rovara !== undefined) {
        // A Bedrock error answer carries no output and no token counts: nothing the company used, so it is never charged (DEC 240b
        // charges from Bedrock's token counts). This includes 5xx and model timeouts on Rovara's own account, and an exception that
        // arrives as the stream's first frame (bedrock-transport.ts answers that as its error status). A stream that breaks AFTER
        // output started keeps the core's rule (charged). Its refusal of Rovara's own role is Rovara's to fix.
        if (status === 401 || status === 403) return { charged: false, refusal: ROVARA_AI_UNAVAILABLE };
        return { charged: false, refusal: PROVIDER_ERROR };
      }
      // The provider refused the company's key: an explicit rejection before any generation, free; the company must connect a working key.
      return status === 401 || status === 403 ? { charged: false, refusal: AGENT_KEY_REFUSED } : base.providerFailure(status, body);
    },
  };
}
function routeFor(deps: GatewayDependencies, request: GatewayRequest): GatewayRoute | ProductControl | undefined {
  if (request.method !== "POST") return undefined;
  if (request.url === "/v1/messages") return agentRoute(deps);
  if (request.url.startsWith(LEARNING_PATH_PREFIX)) {
    if (request.url.length > 2048) return undefined;
    const at = request.url.indexOf("?");
    try { return deps.learning?.route(at < 0 ? request.url : request.url.slice(0, at), at < 0 ? "" : request.url.slice(at + 1)); } catch { return undefined; }
  }
  if (deps.product === undefined || !request.url.startsWith(PRODUCT_ROUTE_PREFIX) || request.url.length > 2048) return undefined;
  const at = request.url.indexOf("?");
  try { return deps.product.route(at < 0 ? request.url : request.url.slice(0, at), at < 0 ? "" : request.url.slice(at + 1), request.headers); } catch { return undefined; }
}
/** Core also used directly by the in-process harness. One deadline covers request, dependencies, transport, streaming and backpressure. */
export async function handleGateway(deps: GatewayDependencies, request: GatewayRequest, sink: GatewaySink): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort(); request.signal?.addEventListener("abort", abort, { once: true });
  const now = deps.now ?? Date.now;
  const duration = Math.min(deps.timeoutMs ?? CALL_HARD_CEILING_MS, CALL_HARD_CEILING_MS);
  const startedAt = now();
  let deadline = startedAt + duration;
  let endedTimer: ReturnType<typeof setTimeout> | undefined;
  let timer = setTimeout(abort, duration);
  const shortenDeadline = (end: number) => {
    deadline = Math.min(deadline, end);
    clearTimeout(timer); timer = setTimeout(abort, Math.max(0, deadline - now()));
  };
  let rejectAbort!: (reason: Error) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  // Observe the rejection even if abort happens while awaiting a non-cancellable meter transaction.
  void aborted.catch(() => undefined);
  const onAbort = () => rejectAbort(new Error("provider unavailable"));
  controller.signal.addEventListener("abort", onAbort, { once: true });
  if (request.signal?.aborted) abort();
  const wait = async <T>(operation: Promise<T>): Promise<T> => {
    if (now() >= deadline || controller.signal.aborted) { void operation.catch(() => undefined); abort(); throw new Error("provider unavailable"); }
    return Promise.race([operation, aborted]);
  };
  const log = (event: GatewayLogEvent) => { try { deps.log?.(event); } catch { /* Observability never changes settlement. */ } };
  let head = false;
  let reservation: Reservation | undefined;
  let route: GatewayRoute | undefined;
  let callClaims: TaskClaims | undefined;
  let cost = 0;
  let estimated = true;
  let appliedMaxOutputTokens = 0;
  let reservedMicros = 0;
  let provider: ProviderResponse | undefined;
  let settlementPrice: ResolvedPrice | undefined;
  let settlementUsage: TokenUsage | undefined;
  let settlementModel: string | undefined;
  // How the call ended, for an events route's settle: the refusal word last answered, or a complete answer.
  let refusedCode: string | undefined; let completed = false;
  let events: (GatewaySink & { finish(outcome: { completed: boolean; code?: string }): Promise<void> }) | undefined;
  const respond = async (status: number, type: string, message: string, extra: Readonly<Record<string, string>> = {}) => {
    refusedCode = type;
    if (head) { sink.destroy(); return; }
    head = true; sink.head(status, { ...JSON_HEADERS, ...extra });
    await wait(sink.write(Buffer.from(JSON.stringify({ error: { type, message } })))); sink.end(); log({ event: "refused" });
  };
  try {
    if (request.method === "GET" && request.url === "/healthz") { head = true; sink.head(200, JSON_HEADERS); await wait(sink.write(Buffer.from('{"ok":true}'))); sink.end(); return; }
    const routed = routeFor(deps, request);
    if (routed === undefined) { await respond(404, "not_found", "not found"); return; }
    let control: ProductControl | undefined;
    if ("control" in routed) control = routed;
    else {
      route = routed;
      if (route.events !== undefined) { events = route.events.sink(sink); sink = events; }
    }
    const rawKey = request.headers["x-api-key"];
    const auth = request.headers.authorization;
    const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
    // Ambiguous credentials are refused before either verifier is called.
    const token = rawKey ?? bearer;
    const claims = (rawKey !== undefined && auth !== undefined && rawKey !== bearer) || (auth !== undefined && bearer === undefined) ? undefined : await wait(deps.verifyToken(token));
    if (claims === undefined) { await respond(401, AUTH_ERROR.error.type, AUTH_ERROR.error.message); return; }
    // A learning token only on the learning route, and only a learning token there (DEC 226).
    if ((claims.stp === LEARNING_STEP) !== (route?.purpose === "learning")) { await respond(401, AUTH_ERROR.error.type, AUTH_ERROR.error.message); return; }
    callClaims = claims;
    const stopsWithTask = route?.stopsWithTask !== false;
    const taskEnded = async () => stopsWithTask && await wait(deps.ended.isEnded(claims.iss, claims.cid, claims.tid, controller.signal));
    if (control?.afterTaskEnd !== true && await taskEnded()) { await respond(403, "task_ended", "task ended"); return; }
    if (control !== undefined) {
      const parts: Uint8Array[] = []; let size = 0;
      const body = request.body[Symbol.asyncIterator]();
      for (;;) { const part = await wait(body.next()); if (part.done) break; size += part.value.byteLength; if (size > CONTROL_BODY_BYTES) { const e = tooLarge(); await respond(e.status, e.code, e.message); return; } parts.push(part.value); }
      let value: unknown;
      try { if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(request.headers["content-type"] ?? "")) throw new Error(); value = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { await respond(400, "invalid_request", "request not allowed"); return; }
      // Not raced against the deadline: a hold's transaction outcome must be known before answering (adapters bound their own).
      const answer = await control.handle(claims, value, controller.signal);
      head = true; sink.head(answer.status, JSON_HEADERS);
      await wait(sink.write(Buffer.from(JSON.stringify(answer.body)))); sink.end();
      return;
    }
    if (route === undefined) { await respond(404, "not_found", "not found"); return; }
    if (route.admit !== undefined) { const refused = await wait(route.admit(claims, controller.signal)); if (refused !== undefined) { await respond(refused.status, refused.code, refused.message, refused.headers); return; } }
    const declared = request.headers["content-length"];
    if (declared !== undefined && /^\d+$/u.test(declared) && Number(declared) > MAX_BODY_BYTES) { const e = tooLarge(); await respond(e.status, e.code, e.message); return; }
    const parts: Uint8Array[] = []; let size = 0;
    const body = request.body[Symbol.asyncIterator]();
    for (;;) { const part = await wait(body.next()); if (part.done) break; size += part.value.byteLength; if (size > MAX_BODY_BYTES) { const e = tooLarge(); await respond(e.status, e.code, e.message); return; } parts.push(part.value); }
    const guarded = route.guard(Buffer.concat(parts), request.headers, claims);
    if (!guarded.ok) { await respond(guarded.status, guarded.code, guarded.message); return; }
    shortenDeadline(startedAt + callDurationMs(guarded.maxTokens));
    const scope = route.scope(claims);
    let resolved = await wait(resolvePrice(deps.prices ?? UnknownPriceSource, route.provider, guarded.model, deps.cautiousCeiling, controller.signal, "chat"));
    for (const also of route.alsoPricedAs?.(guarded.model) ?? []) resolved = dearerPrice(resolved, await wait(resolvePrice(deps.prices ?? UnknownPriceSource, also.provider, also.model, deps.cautiousCeiling, controller.signal, "chat")));
    const price = guarded.mediaRates === undefined ? resolved : { ...resolved, media: guarded.mediaRates };
    if (price.operatorReview) log({ event: "price_operator_review" });
    settlementPrice = price; settlementModel = guarded.model;
    const caps = await wait(route.caps(scope, claims, controller.signal));
    if ((caps as RouteRefusal).ok === false) { const refused = caps as RouteRefusal; await respond(refused.status, refused.code, refused.message, refused.headers); return; }
    if (!validCaps(caps)) { await respond(503, "unavailable", "model access unavailable"); return; }
    let estimate: number;
    try { estimate = estimateCall(guarded.bytes.length - (guarded.media?.dataBytes ?? 0), guarded.maxTokens, price, guarded.hasTools ? TOOL_INPUT_ALLOWANCE_TOKENS : 0, guarded.inputBounded, guarded.media); } catch { await respond(400, "invalid_request", "request not allowed"); return; }
    if (estimate === Number.MAX_SAFE_INTEGER && !price.operatorReview) log({ event: "price_operator_review" });
    // Do not race a transaction: its outcome must be known before forwarding or settling. Adapters bound their own transactions.
    const overrunCapable = price.estimated || !guarded.inputBounded;
    const admissionExpiresSeconds = Math.floor(now() / 1000) + TASK_TOKEN_SECONDS;
    if (overrunCapable) shortenDeadline(Math.floor(Math.min(deadline, admissionExpiresSeconds * 1000) / 1000) * 1000);
    appliedMaxOutputTokens = guarded.maxTokens;
    const line = route.line?.(claims, guarded.model);
    const reserved = await route.meter.reserve({ scope, caps, estimateMicros: estimate, appliedMaxOutputTokens, ...(line === undefined ? {} : { line }),
      ...(!overrunCapable ? {} : { overrun: { deadlineSeconds: Math.floor(deadline / 1000), tokenExpiresSeconds: admissionExpiresSeconds } }),
    });
    if (!reserved.ok) {
      if (reserved.reason === "busy" && reserved.overrunInFlight) {
        try { deps.metrics.overrunBusy(claims.iss, claims.cid); } catch { /* A metrics outage never changes admission or settlement. */ }
        log({ event: "overrun_busy", company: claims.cid });
        await respond(429, "busy", OVERRUN_BUSY_MESSAGE, { "retry-after": String(OVERRUN_BUSY_RETRY_SECONDS) });
      } else if (reserved.reason === "busy") await respond(503, "unavailable", "model access unavailable");
      else if (reserved.held) await respond(429, "budget_held", "budget is held by another call", { "retry-after": "2" });
      else if (route.capRefusal !== undefined) { const refused = await wait(route.capRefusal({ reason: reserved.reason, item: reserved.item }, scope, caps, estimate, controller.signal)); await respond(refused.status, refused.code, refused.message, refused.headers); }
      else await respond(422, "budget_exceeded", route.prefix[reserved.item]);
      return;
    }
    reservation = reserved.reservation; reservedMicros = estimate;
    // One non-overlapping, deadline-bounded poll also stops streams stalled between chunks.
    const pollEnded = async (): Promise<void> => {
      try { if (await taskEnded()) abort(); } catch { abort(); }
      if (!controller.signal.aborted) endedTimer = setTimeout(() => { void pollEnded(); }, ENDED_TASK_POLL_MS);
    };
    endedTimer = setTimeout(() => { void pollEnded(); }, ENDED_TASK_POLL_MS);
    // No call has left the process yet, including while the key port is read.
    cost = 0; estimated = false;
    if (controller.signal.aborted) throw new NotSentError();
    const key = await wait(route.key(claims, controller.signal));
    if (typeof key !== "string" || key.length < 6 || key.length > 8192 || /[\r\n]/u.test(key)) throw new NotSentError();
    if (controller.signal.aborted) throw new NotSentError();
    cost = estimate; estimated = true;
    try { provider = await wait(route.transport({ body: guarded.bytes, headers: guarded.headers, key, signal: controller.signal, ...(guarded.path === undefined ? {} : { path: guarded.path }) })); }
    catch (error) { if (error instanceof NotSentError) { cost = 0; estimated = false; } throw error; }
    if (provider.status < 200 || provider.status >= 300) {
      let failureBytes: Uint8Array | undefined;
      if (route.failureBody === true) {
        // Its first bytes only, for the class (quota, rate limit, overloaded); never echoed, never logged.
        const read: Uint8Array[] = []; let got = 0; const it = provider.body[Symbol.asyncIterator]();
        try { while (got < FAILURE_BODY_BYTES) { const next = await wait(it.next()); if (next.done) break; read.push(next.value); got += next.value.byteLength; } } catch { /* Classified from the status alone. */ }
        failureBytes = Buffer.concat(read).subarray(0, FAILURE_BODY_BYTES);
      }
      const failure = route.providerFailure(provider.status, failureBytes);
      if (!failure.charged) { cost = 0; estimated = false; }
      if (route.product && (provider.status === 401 || provider.status === 403)) log({ event: "product_key_refused" });
      await respond(failure.refusal.status, failure.refusal.code, failure.refusal.message, failure.refusal.headers); return; }
    const scanner = new SecretScanner([key, ...(typeof token === "string" ? [token] : [])]);
    const usage = route.usage();
    const output: Uint8Array[] = []; let total = 0;
    const stream = provider.body[Symbol.asyncIterator]();
    if (guarded.streaming) { head = true; sink.head(200, { ...JSON_HEADERS, "content-type": "text/event-stream; charset=utf-8" }); }
    for (;;) {
      const next = await wait(stream.next()); if (next.done) break;
      if (await taskEnded()) throw new Error("provider unavailable");
      total += next.value.byteLength; if (total > MAX_RESPONSE_BYTES) throw new Error("provider unavailable");
      const safe = scanner.push(next.value); if (safe.hit) throw new Error("provider unavailable");
      if (guarded.streaming) { usage.push(next.value); if (safe.bytes.length) await wait(sink.write(safe.bytes)); }
      else output.push(safe.bytes);
    }
    const last = scanner.finish();
    if (guarded.streaming) { if (last.length) await wait(sink.write(last)); }
    else {
      output.push(last); const bytes = Buffer.concat(output);
      let value: unknown; try { value = JSON.parse(bytes.toString()); } catch { throw new Error("provider unavailable"); }
      usage.whole(value); head = true; sink.head(200, JSON_HEADERS); await wait(sink.write(bytes));
    }
    const counts = usage.finish();
    // Incomplete/malformed SSE is a failed stream, never a silent partial success.
    if (counts === undefined) throw new Error("provider unavailable");
    sink.end(); completed = true;
    settlementUsage = counts;
  } catch (error) {
    log({ event: "provider_error" });
    const notSent = !head && error instanceof NotSentError ? route?.notSent?.() : undefined;
    try { if (head) sink.destroy(); else if (notSent !== undefined) await respond(notSent.status, notSent.code, notSent.message, notSent.headers); else await respond(502, "provider_error", "provider unavailable"); } catch { sink.destroy(); }
  } finally {
    controller.abort(); clearTimeout(timer); clearTimeout(endedTimer); request.signal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", onAbort);
    try { provider?.cancel?.(); } catch { /* Fixed log fields only; no provider text. */ }
    if (reservation !== undefined && route !== undefined) {
      try {
        let estimateRecord: EstimatedSettlement | undefined;
        if (cost > 0 && settlementPrice !== undefined && settlementModel !== undefined) {
          const amount = settleAmount({ ...(settlementUsage === undefined ? {} : { usage: settlementUsage }), price: settlementPrice, reservationMicros: cost });
          cost = amount.actualMicros; estimated = amount.estimated;
          if (estimated) estimateRecord = { provider: route.provider, model: settlementModel, kind: "chat", settledAt: now(), priceVersion: settlementPrice.priceVersion ?? 0, ...(amount.usage === undefined ? {} : { usage: amount.usage }) };
        }
        await route.meter.settle(reservation, cost, estimateRecord); log({ event: "settled", costMicros: cost, estimated, appliedMaxOutputTokens, ...(route.product ? { route: "product" as const } : route.purpose === "learning" ? { route: "learning" as const } : {}) });
        if (route.overReservation !== undefined && callClaims !== undefined && cost > reservedMicros) {
          log({ event: "product_over_reservation" });
          try { await route.overReservation(callClaims); } catch { log({ event: "settle_failed" }); }
        }
      }
      catch { log({ event: "settle_failed" }); } // Adapter keeps the hold if its atomic settle fails.
    }
    // Exactly one settle event, after the call settled.
    if (events !== undefined) { try { await events.finish({ completed, ...(refusedCode === undefined ? {} : { code: refusedCode }) }); } catch { /* The sink ends or destroys itself. */ } }
  }
}
/** node:http adapter, including backpressure and disconnect cancellation. It never opens a listener itself. */
export function createGatewayHandler(deps: GatewayDependencies): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const controller = new AbortController(); const abort = () => controller.abort();
    req.once("aborted", abort); res.once("close", abort);
    const headers: Record<string, string | undefined> = Object.create(null) as Record<string, string | undefined>;
    for (const [name, value] of Object.entries(req.headers)) headers[name] = Array.isArray(value) ? value.join(",") : value;
    try {
      await handleGateway(deps, { method: req.method ?? "", url: req.url ?? "", headers, body: req as AsyncIterable<Uint8Array>, signal: controller.signal }, {
        head: (status, outgoing) => { res.writeHead(status, outgoing); },
        write: async (bytes) => {
          if (res.destroyed || controller.signal.aborted) throw new Error("response unavailable");
          if (res.write(bytes)) return;
          await new Promise<void>((resolve, reject) => {
            const clean = () => { res.off("drain", drained); res.off("close", closed); res.off("error", closed); controller.signal.removeEventListener("abort", closed); };
            const drained = () => { clean(); resolve(); }; const closed = () => { clean(); reject(new Error("response unavailable")); };
            res.once("drain", drained); res.once("close", closed); res.once("error", closed); controller.signal.addEventListener("abort", closed, { once: true });
          });
        },
        end: () => { res.end(); }, destroy: () => { res.destroy(); },
      });
    } finally { req.off("aborted", abort); res.off("close", abort); }
  };
}
