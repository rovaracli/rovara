import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AGENT_AI_SOURCES, agentSourceSwitchedOn, resolveAgentSource, type AgentSourceVia, type AgentAiSourceReader, type ByoBedrock, type CompanyChatAi, type CompanyEndpointAi, type RovaraAi } from "./agent-ai.js";
import { endpointTarget, ENDPOINT_ADDRESS_REFUSED, type EndpointTarget } from "./endpoint-guard.js";
import { parseEndpointConnect, type EndpointConnection, type EndpointModel } from "./endpoint-source.js";
import { OPENAI_AGENT_DEFAULT_MAX_OUTPUT_TOKENS, OPENAI_AGENT_MODEL, OPENAI_AGENT_UPSTREAM, toChatCompletions, type OpenAiAgentProvider } from "./agent-openai.js";
import type { AwsCredentials } from "./aws.js";
import { BEDROCK_MODEL_ACCESS_WORDS } from "./bedrock-byo-sessions.js";
import { BEDROCK_CLAUDE_ID } from "./bedrock-transport.js";
import { invokeCall, PROVIDER_ERROR, rovaraGuard, rovaraProviderFailure } from "./rovara-ai-call.js";
export { BEDROCK_ANTHROPIC_VERSION, ROVARA_AI_FEATURE, ROVARA_AI_MODEL, ROVARA_AI_MODEL_NOT_ENABLED, ROVARA_AI_UNAVAILABLE } from "./rovara-ai-call.js";
import { validCaps, type Caps, type CapsSource } from "./caps.js";
import type { EndedTasks } from "./ended.js";
import { estimateCall, TOOL_INPUT_ALLOWANCE_TOKENS, type MediaEstimate } from "./estimate.js";
import type { MediaRates } from "./media-price.js";
import { guardRequest, MAX_BODY_BYTES, tooLarge, type GuardFailure, type ModelLimitsSource } from "./guard.js";
import type { BillLine, Meter, MeterItem, MeterScope, Reservation } from "./meter.js";
import { LEARNING_PATH_PREFIX, LEARNING_STEP, type LearningKeySource, type LearningRouteFactory } from "./learning-route.js";
import { ANSWERS_PATH_PREFIX, ANSWERS_STEP } from "./answers-route.js";
import { isUpkeepCall, upkeepRefusal, withUpkeepCap, type UpkeepLimits } from "./upkeep-cap.js";
import { usageEstimated } from "./price-tiers.js";
import { dearerPrice, resolvePrice, UnknownPriceSource, type PriceKind, type PriceSource } from "./price.js";
import { CALL_HARD_CEILING_MS, callDurationMs, MAX_RESPONSE_BYTES, NotSentError, SecretScanner, type ProviderKeys, type ProviderResponse, type ProviderTransport } from "./provider.js";
import { AUTH_ERROR, TASK_TOKEN_SECONDS, consumeReviewerGrant, type TaskClaims, type TaskTokenVerifier } from "./token.js";
import { closeReviewSession, REVIEW_SESSION_CLOSE_GRACE_MS, REVIEW_SESSION_SECONDS, type ReviewerGrantStore } from "./reviewer-grants.js";
import { hasUsage, settleAmount, validUsage } from "./reported-cost.js";
import type { ResolvedPrice } from "./price.js";
import type { EstimatedSettlement } from "./meter.js";
import type { TokenUsage } from "./usage.js";
import { UsageCollector } from "./usage.js";
export interface GatewayRequest { method: string; url: string; headers: Readonly<Record<string, string | undefined>>; body: AsyncIterable<Uint8Array>; signal?: AbortSignal }
export interface GatewaySink { head(status: number, headers: Readonly<Record<string, string>>): void; write(bytes: Uint8Array): Promise<void>; end(): void; destroy(): void }
export type GatewayLogEvent = { event: "settled"; estimated: boolean; costMicros: number; appliedMaxOutputTokens: number; route?: "product" | "learning" | "answers" } | { event: "overrun_busy"; company: string } | { event: "agent_source"; company: string; source: string; via: string } | { event: "settle_failed" | "refused" | "provider_error" | "price_operator_review" | "product_key_refused" | "product_over_reservation" };
export interface GatewayDependencies {
  verifyToken: TaskTokenVerifier; ended: EndedTasks; meter: Meter; caps: CapsSource; prices?: PriceSource;
  metrics: { overrunBusy(issuer: string, company: string): void };
  modelLimits: ModelLimitsSource; now?: () => number;
  keys: ProviderKeys; transport: ProviderTransport; cautiousCeiling?: number; timeoutMs?: number;
  log: (event: GatewayLogEvent) => void;
  /**
   * DEC 254zzz41: the durable store of reviewer grants and of the review session each one opens (reviewer-grants.ts). Absent: a token carrying a `reviewer` grant is refused
   * (401) before anything is read, held or sent, so a gateway without it never serves a review call.
   */
  reviewerGrants?: ReviewerGrantStore;
  /** The product-AI route (calls made by the customer's tests with the project's own key). Absent: every product path is 404, as before. */
  product?: ProductRouteResolver;
  /** The learning route (DEC 226, learning-route.ts: lessons' calls on the company's own key). Absent: its path is 404. */
  learning?: LearningRouteFactory;
  /** The answers route (answers-route.ts: hosted Ask and smart Just answer on the company's own key). Absent: its path is 404. */
  answers?: LearningRouteFactory;
  /** Nightly upkeep's per-project monthly cap (upkeep-cap.ts). Absent: an upkeep-origin call is paused with no_budget. */
  upkeep?: UpkeepLimits;
  /**
   * DEC 236: the agent route on each company's OWN connected AI key (company-key mode), from the same sealed company-level store
   * the learning route reads. Set: `keys` (Rovara's install key) is never read for an agent call, a company with no usable key is
   * refused before anything is held (AGENT_KEY_MISSING), and the combined company cap applies as before. Absent: the install key.
   */
  agentKeys?: LearningKeySource;
  /**
   * DEC 240, only with `agentKeys` (company-key mode): each company's chosen agent AI source. A saved "rovara" sends the call to
   * Rovara's AI (`rovara`; refused when absent) and never reads the company's key; "anthropic_key" or no saved choice is DEC 236
   * exactly; "bedrock_byo" sends it to the company's OWN Bedrock through its own role (`byo`; refused when absent, DEC 238).
   * Absent: DEC 236 exactly.
   */
  agentAi?: {
    sources: AgentAiSourceReader; rovara?: RovaraAi; byo?: ByoBedrock;
    /** DEC 254t (A2): the company's own OpenAI / OpenRouter key through Chat Completions (agent-openai.ts). Absent: that source is refused (not offered). */
    openai?: CompanyChatAi; openrouter?: CompanyChatAi;
    /** DEC 254t (A3): the company's own OpenAI-compatible endpoint behind the SSRF guard. Absent: that source is refused (not offered). */
    endpoint?: CompanyEndpointAi;
    /**
     * DEC 254t: the company source kinds this install switched on (GATEWAY_AI_SOURCE_KINDS). A saved source whose kind is off is
     * refused at admission (AGENT_SOURCE_SWITCHED_OFF): nothing read, held or sent. Absent: none. Rovara's AI and the pre-switch
     * sources (agent-ai.ts PRE_SWITCH_AGENT_SOURCES) are not gated.
     */
    switchedOn?: ReadonlySet<string>;
  };
}
/** One provider call shape after its route's guard. `path` is built by the guard from checked parts, never copied from the request. */
export interface RouteCall {
  ok: true; hasTools: boolean; inputBounded: boolean; model: string; maxTokens: number; streaming: boolean; bytes: Buffer; headers: Readonly<Record<string, string>>; path?: string;
  /** The model's audio/video prices (product route): attached to the call's price for the estimate and the settle. */
  mediaRates?: MediaRates;
  /** Inline audio/video: estimated prompt tokens, replacing their `dataBytes` encoded bytes in the hold (DEC 228e). */
  media?: MediaEstimate & { dataBytes: number };
  /** A streamed answer's content type when it is not SSE (Bedrock's binary event stream, product-bedrock.ts). Absent: text/event-stream. */
  streamContentType?: string;
  /** The price kind of the call's model (a Titan embedding is priced as "embedding"). Absent: "chat". */
  priceKind?: PriceKind;
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
   * The token purpose this route serves. "learning": only learning tokens (`stp` = LEARNING_STEP); "answers": only answers tokens (`stp` = ANSWERS_STEP);
   * absent: only task tokens.
   * Either mismatch gets the fixed 401 before anything is read, held or sent.
   */
  readonly purpose?: "learning" | "answers";
  /**
   * DEC 254zzz41: true only on the agent route in company-key mode, the one route a reviewer grant (a task token carrying `reviewer`) may
   * use: it is paid by the SAME source as the task's main AI (the company's saved choice, resolved by admit for the token's company).
   * Absent: a reviewer grant is refused on this route (401), so none can reach the product, learning, answers or install-key routes.
   */
  readonly reviewerGrants?: true;
  /**
   * The response header that carries this call's settled cost (US dollars, a plain decimal of six places: whole micro-dollars). Set only on the answers route (L4-E2).
   * Sent on a complete NON-streaming success only, and only when the figure is exact: the core settles first, then sends the head, so the figure is the amount
   * the same settle wrote to the meter. Absent (never 0, never a guess) when the price is estimated, the provider reported no usage, or the meter could not settle, and it is lost if the response head is never sent. A slow meter delays the head for that route (no separate time limit, as the settle was never bounded).
   */
  readonly costHeader?: string;
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
  /** An error answer's JSON when the route's callers expect another shape (the AWS SDK reads a top-level `message`). Absent: `{error:{type,message}}`. */
  refusalBody?(type: string, message: string): Readonly<Record<string, unknown>>;
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
const PREFIX: Record<MeterItem, string> = { task: "Budget has been exceeded! Key=task", person: "ExceededBudget: User=person", project: "Budget has been exceeded! Project=project", company: "Budget has been exceeded! Team=company", upkeep: "Budget has been exceeded! Upkeep=project" };
export const PRODUCT_ROUTE_PREFIX = "/v1/product/";
/** DEC 254zzz41: a review call whose own worst-case cost is above the grant's ceiling. Before any hold; fixed words. */
export const REVIEWER_CEILING_REFUSED: RouteRefusal = Object.freeze({ ok: false as const, status: 422, code: "budget_exceeded", message: "Budget has been exceeded! Key=reviewer" });
/** The agent route's refusal in company-key mode when the company has no usable AI key connected (DEC 236). Fixed words. */
export const AGENT_KEY_MISSING: RouteRefusal = Object.freeze({ ok: false as const, status: 403, code: "no_ai_key", message: "Connect an AI key: this company has no AI provider key connected, so its agents cannot call AI." });
/** Company-key mode: the provider refused the company's own key (401/403 before any output). Free; fixed words. */
export const AGENT_KEY_REFUSED: RouteRefusal = Object.freeze({ ok: false as const, status: 403, code: "no_ai_key", message: "Connect an AI key: the AI provider refused this company's connected key." });
const NOTHING_SWITCHED_ON: ReadonlySet<string> = new Set();
const AGENT_UNAVAILABLE: RouteRefusal = Object.freeze({ ok: false as const, status: 503, code: "unavailable", message: "model access unavailable" });
/** DEC 240: the company chose its own Bedrock (DEC 238), and this gateway does not offer it. Nothing held or sent; no fallback. */
export const AGENT_SOURCE_NOT_OFFERED: RouteRefusal = Object.freeze({ ok: false as const, status: 403, code: "no_ai_key", message: "Choose AI for your agents: your own Bedrock is not available on this install." });
/** DEC 254t: the company chose an AI source this install has not switched on. Nothing read, held or sent; no fallback. */
export const AGENT_SOURCE_SWITCHED_OFF: RouteRefusal = Object.freeze({ ok: false as const, status: 403, code: "no_ai_key", message: "Choose AI for your agents: the AI source your company chose is not switched on for this install." });
/** DEC 254t (A2): the company chose its own OpenAI or OpenRouter key, and this gateway does not offer it. Nothing held or sent; no fallback. */
export const AGENT_CHAT_NOT_OFFERED: RouteRefusal = Object.freeze({ ok: false as const, status: 403, code: "no_ai_key", message: "Choose AI for your agents: the AI source your company chose is not available on this install." });
/** DEC 254t (A2): a request with something an OpenAI or OpenRouter key cannot be given faithfully (images, documents, thinking, server or strict tools). Before any hold. */
export const AGENT_CHAT_FEATURE: GuardFailure = Object.freeze({ ok: false as const, status: 400, code: "invalid_request", message: "This request uses something your company's own OpenAI or OpenRouter key does not offer for agents (only text and tools)." });
/** DEC 254t (A3): the company's endpoint address failed the SSRF guard (at admission, or its DNS at call time). Free; fixed words, never the address. */
export const ENDPOINT_REFUSED: RouteRefusal = Object.freeze({ ok: false as const, status: 403, code: "endpoint_refused", message: ENDPOINT_ADDRESS_REFUSED });
/** A3-REVIEW-1 M1: too many endpoint name resolutions at once for this company or this gateway. Not sent ($0); fixed words. */
export const ENDPOINT_BUSY: RouteRefusal = Object.freeze({ ok: false as const, status: 429, code: "busy", message: "Too many calls to your own endpoint are starting right now. Try again in a moment.", headers: { "retry-after": "2" } });
/** DEC 254t (A3): a model the company did not register for its endpoint. Before any hold. */
export const ENDPOINT_MODEL: GuardFailure = Object.freeze({ ok: false as const, status: 400, code: "invalid_request", message: "This model is not one your company registered for its own endpoint." });
/** DEC 238: the company chose its own Bedrock but has no connection saved. Nothing held or sent; no fallback. */
export const BYO_BEDROCK_NOT_CONNECTED: RouteRefusal = Object.freeze({ ok: false as const, status: 403, code: "no_ai_key", message: "Connect your Bedrock: this company chose its own Bedrock for its agents, and no AWS role is connected." });
/** DEC 238: a model the company did not pick when it connected its Bedrock. Before any hold. */
export const BYO_BEDROCK_MODEL: GuardFailure = Object.freeze({ ok: false as const, status: 400, code: "invalid_request", message: "This model is not one your company picked for its Bedrock connection." });
/** DEC 238: AWS refused Rovara's use of the company's role (trust changed, role deleted, or no permission). Free. */
export const BYO_BEDROCK_REFUSED: RouteRefusal = Object.freeze({ ok: false as const, status: 403, code: "no_ai_key", message: "Check your Bedrock connection: AWS refused Rovara's use of your company's role. Test the connection again in settings." });
/** DEC 238: the model is picked but not enabled yet in the company's AWS account (its one-time access or Marketplace step). Free. */
export const BYO_BEDROCK_MODEL_NOT_ENABLED: RouteRefusal = Object.freeze({ ok: false as const, status: 403, code: "model_not_enabled", message: "This model is not enabled yet in your company's AWS account. An AWS admin opens it once in the Bedrock console, then try again." });
/** DEC 240: the company chose Rovara's AI, and this gateway does not offer it. Nothing held or sent; no fallback to its key. */
export const ROVARA_AI_OFF: RouteRefusal = Object.freeze({ ok: false as const, status: 403, code: "no_ai_key", message: "Choose AI for your agents: Rovara's AI is not available on this install." });
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
  // DEC 238: set by admit when the company chose its own Bedrock; then neither its key nor Rovara's account is used.
  let byo: { deps: ByoBedrock; row: Parameters<ByoBedrock["sessions"]["credentials"]>[0]; connection: Parameters<ByoBedrock["sessions"]["credentials"]>[1]; marker: string; transport: ProviderTransport; credentials?: AwsCredentials } | undefined;
  // DEC 254t (A2): set by admit when the company chose its own OpenAI or OpenRouter key; then only that provider's account is read.
  let chat: { provider: OpenAiAgentProvider; ai: CompanyChatAi } | undefined;
  let claimsOf: TaskClaims | undefined;
  // DEC 254t (A3): set by admit when the company chose its own endpoint (its sealed connection, opened for this company only).
  let endpoint: { ai: CompanyEndpointAi; connection: EndpointConnection; target: EndpointTarget; transport: ProviderTransport; model?: EndpointModel; refused?: "address" | "busy" } | undefined;
  return {
    ...base,
    reviewerGrants: true as const,
    // An endpoint call is priced as the catalog model each registered model stands for.
    get provider() { return endpoint !== undefined ? endpoint.model?.catalog.provider ?? "endpoint" : chat !== undefined ? chat.provider : rovara === undefined && byo === undefined ? base.provider : "bedrock"; },
    get transport() { return endpoint !== undefined ? endpoint.transport : chat !== undefined ? chat.ai.transport : byo !== undefined ? byo.transport : rovara === undefined ? base.transport : rovara.ai.transport; },
    // Bedrock's refusal: its first bytes, only to tell "model not enabled yet" apart (never echoed or logged).
    get failureBody() { return rovara !== undefined || byo !== undefined; },
    async admit(claims, signal) {
      claimsOf = claims;
      const choice = deps.agentAi;
      let via: AgentSourceVia = "none";
      if (choice !== undefined) {
        let source;
        // DEC 254zzz3(1): no saved choice + an exempt company: its own key, its own Bedrock, else Rovara's AI (agent-ai.ts resolveAgentSource).
        try { ({ source, via } = await resolveAgentSource({ sources: choice.sources, ...(choice.rovara === undefined ? {} : { exempt: choice.rovara.exempt }), keys, ...(choice.byo === undefined ? {} : { byo: choice.byo }) }, claims.iss, claims.cid, signal)); } catch { return AGENT_UNAVAILABLE; }
        // The source this call is admitted on, once, for the audit: ids and words only.
        const accept = () => { admitted = true; deps.log({ event: "agent_source", company: claims.cid, source: source ?? "company_key", via }); };
        if (source !== undefined && !agentSourceSwitchedOn(source, choice.switchedOn ?? NOTHING_SWITCHED_ON)) return AGENT_SOURCE_SWITCHED_OFF;
        // A source this route does not serve is never sent on another one's key (no fallback to the company's Anthropic key).
        if (source !== undefined && !(AGENT_AI_SOURCES as readonly string[]).includes(source)) return AGENT_UNAVAILABLE;
        if (source === "bedrock_byo") {
          if (choice.byo === undefined) return AGENT_SOURCE_NOT_OFFERED;
          // Only the verified company's own connection (the token's iss and cid), never another company's.
          let found;
          try { found = await choice.byo.connection(claims.iss, claims.cid, signal); } catch { return AGENT_UNAVAILABLE; }
          if (found === undefined) return BYO_BEDROCK_NOT_CONNECTED;
          const state = { deps: choice.byo, row: found.row, connection: found.connection, marker: `byo-bedrock-${randomUUID()}` } as NonNullable<typeof byo>;
          // The transport signs with the session `key` assumed (after the hold); without one, nothing is sent.
          state.transport = choice.byo.transport(found.connection.region, async () => { if (state.credentials === undefined) throw new Error("no session"); return state.credentials; });
          byo = state;
          accept();
          return undefined;
        }
        if (source === "custom_endpoint") {
          const ai = choice.endpoint;
          if (ai === undefined) return AGENT_CHAT_NOT_OFFERED;
          // Only the verified company's own endpoint account; read now because the guard needs its models (the key stays in this call's memory).
          let text: string | undefined;
          try {
            if ((await keys.connected(claims.iss, claims.cid, "endpoint", signal)) !== true) return AGENT_KEY_MISSING;
            text = await keys.keyFor(claims.iss, claims.cid, "endpoint", signal);
          } catch { return AGENT_UNAVAILABLE; }
          if (text === undefined) return AGENT_KEY_MISSING;
          const connection = parseEndpointConnect(text);
          if (connection === undefined) return AGENT_UNAVAILABLE;
          const target = endpointTarget(connection.baseUrl);
          if (target === undefined) return ENDPOINT_REFUSED;
          const state = { ai, connection, target } as NonNullable<typeof endpoint>;
          state.transport = ai.transport(target, (reason) => { state.refused = reason; }, claims.cid);
          endpoint = state;
          accept();
          return undefined;
        }
        if (source === "openai_key" || source === "openrouter_key") {
          const provider: OpenAiAgentProvider = source === "openai_key" ? "openai" : "openrouter";
          const ai = choice[provider];
          if (ai === undefined) return AGENT_CHAT_NOT_OFFERED;
          // Only the verified company's own account of THAT provider (an Anthropic key is never a stand-in).
          try { if ((await keys.connected(claims.iss, claims.cid, provider, signal)) !== true) return AGENT_KEY_MISSING; }
          catch { return AGENT_UNAVAILABLE; }
          chat = { provider, ai };
          accept();
          return undefined;
        }
        if (source === "rovara") {
          if (choice.rovara === undefined) return ROVARA_AI_OFF;
          // A per-call marker stands in for a key: the transport signs with the task role, and no key exists to leak.
          rovara = { ai: choice.rovara, marker: `rovara-ai-${randomUUID()}` };
          accept();
          return undefined;
        }
      }
      try { if ((await keys.connected(claims.iss, claims.cid, "anthropic", signal)) !== true) return AGENT_KEY_MISSING; }
      catch { return AGENT_UNAVAILABLE; }
      admitted = true;
      deps.log({ event: "agent_source", company: claims.cid, source: "company_key", via });
      return undefined;
    },
    guard(bytes, headers, claims) {
      const checked = base.guard(bytes, headers, claims);
      if (endpoint !== undefined && checked.ok) {
        // Only a model the company registered, sent under the name the endpoint serves it by, priced and limited as its catalog model.
        const model = endpoint.connection.models.find((m) => m.name === checked.model);
        if (model === undefined) return ENDPOINT_MODEL;
        let limit: unknown;
        try { limit = endpoint.ai.maxOutputTokens?.(model.catalog.provider, model.catalog.modelId); } catch { limit = undefined; }
        const maxTokens = Math.min(checked.maxTokens, typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0 ? limit : OPENAI_AGENT_DEFAULT_MAX_OUTPUT_TOKENS);
        let translated: Record<string, unknown> | undefined;
        try { translated = toChatCompletions(JSON.parse(checked.bytes.toString("utf8")) as Record<string, unknown>, model.name, maxTokens, "endpoint"); } catch { translated = undefined; }
        if (translated === undefined) return AGENT_CHAT_FEATURE;
        let forwarded: Buffer;
        try { forwarded = Buffer.from(JSON.stringify(translated)); } catch { return AGENT_CHAT_FEATURE; }
        endpoint.model = model;
        return { ...checked, model: model.catalog.modelId, maxTokens, bytes: forwarded, headers: { "content-type": "application/json" }, path: endpoint.target.path };
      }
      if (chat !== undefined && checked.ok) {
        if (!OPENAI_AGENT_MODEL.test(checked.model)) return AGENT_CHAT_FEATURE;
        // Held to the model's own output limit (the price snapshot's row for this provider), else the default.
        let limit: unknown;
        try { limit = chat.ai.maxOutputTokens?.(checked.model); } catch { limit = undefined; }
        const maxTokens = Math.min(checked.maxTokens, typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0 ? limit : OPENAI_AGENT_DEFAULT_MAX_OUTPUT_TOKENS);
        let translated: Record<string, unknown> | undefined;
        try { translated = toChatCompletions(JSON.parse(checked.bytes.toString("utf8")) as Record<string, unknown>, checked.model, maxTokens, chat.provider); } catch { translated = undefined; }
        if (translated === undefined) return AGENT_CHAT_FEATURE;
        let forwarded: Buffer;
        try { forwarded = Buffer.from(JSON.stringify(translated)); } catch { return AGENT_CHAT_FEATURE; }
        return { ...checked, maxTokens, bytes: forwarded, headers: { "content-type": "application/json" }, path: OPENAI_AGENT_UPSTREAM[chat.provider].path };
      }
      if (byo !== undefined && checked.ok) {
        // Only a model the company picked, sent as the Claude id or profile it picked for it (Claude only in slice 1).
        const id = Object.hasOwn(byo.connection.models, checked.model) ? byo.connection.models[checked.model] : undefined;
        if (id === undefined || !BEDROCK_CLAUDE_ID.test(id)) return BYO_BEDROCK_MODEL;
        return invokeCall(checked, id);
      }
      if (rovara === undefined || !checked.ok) return checked;
      return rovaraGuard(checked, rovara.ai);
    },
    // DEC 238: the company's own Bedrock is priced at the dearer of its Bedrock row and the Anthropic row of the model it stands for
    // (like Vertex's), so the cap never counts less than either list price.
    alsoPricedAs(model) {
      if (byo === undefined) return [];
      return Object.entries(byo.connection.models).filter(([, id]) => id === model).map(([name]) => ({ provider: "anthropic", model: name }));
    },
    line(claims, model) {
      if (rovara === undefined) return undefined;
      return { source: "rovara_ai", charge: rovara.ai.exempt.has(claims.cid) ? "exempt" : "customer", model };
    },
    async key(claims, signal) {
      if (!admitted) return "";
      if (rovara !== undefined) return rovara.marker;
      if (endpoint !== undefined) return endpoint.connection.key;
      if (byo !== undefined) {
        // The customer's role as THIS company (after the hold): a refusal is "not sent" ($0), in its own words.
        let got;
        try { got = await byo.deps.sessions.credentials(byo.row, byo.connection, signal); } catch { notSent = AGENT_UNAVAILABLE; return ""; }
        if (!got.ok) {
          notSent = got.reason === "refused" ? BYO_BEDROCK_REFUSED : AGENT_UNAVAILABLE;
          if (got.reason === "refused") await byo.deps.refused?.(claims.iss, claims.cid, byo.row).catch(() => undefined);
          return "";
        }
        byo.credentials = got.credentials;
        return byo.marker;
      }
      let key: string | undefined;
      try { key = await keys.keyFor(claims.iss, claims.cid, chat?.provider ?? "anthropic", signal); } catch { notSent = AGENT_UNAVAILABLE; return ""; }
      if (key === undefined) { notSent = AGENT_KEY_MISSING; return ""; }
      return key;
    },
    // The endpoint's DNS answered an address the guard refuses: nothing was sent, in fixed words.
    notSent: () => endpoint?.refused === "address" ? ENDPOINT_REFUSED : endpoint?.refused === "busy" ? ENDPOINT_BUSY : notSent,
    providerFailure: (status, body) => {
      if (endpoint !== undefined) {
        // An error answer (a redirect included: never followed) carries no output: never charged. A refused key is the company's to fix.
        if (status === 401 || status === 403) {
          if (claimsOf !== undefined) { const who = claimsOf; void (async () => { try { await keys.refused?.(who.iss, who.cid, "endpoint"); } catch { /* a warning never changes a call */ } })(); }
          return { charged: false, refusal: AGENT_KEY_REFUSED };
        }
        return { charged: false, refusal: PROVIDER_ERROR };
      }
      if (chat !== undefined) {
        // An error answer carries no output (OpenAI and OpenRouter bill only what they generate): never charged. A refused key is the
        // company's to fix (marked on its settings page), in fixed words; nothing from the answer is echoed.
        if (status === 401 || status === 403) {
          if (claimsOf !== undefined) { const who = claimsOf; void (async () => { try { await keys.refused?.(who.iss, who.cid, chat.provider); } catch { /* a warning never changes a call */ } })(); }
          return { charged: false, refusal: AGENT_KEY_REFUSED };
        }
        return { charged: false, refusal: PROVIDER_ERROR };
      }
      if (byo !== undefined) {
        // A Bedrock error answer carries no output: nothing used, never charged (AWS bills the customer only for what it generated).
        // A refusal of the role means the session is no longer good: the next call assumes it again.
        if (status === 403 && body !== undefined && BEDROCK_MODEL_ACCESS_WORDS.test(Buffer.from(body).toString("utf8"))) return { charged: false, refusal: BYO_BEDROCK_MODEL_NOT_ENABLED };
        if (status === 401 || status === 403) { byo.deps.sessions.forget(byo.row); void byo.deps.refused?.(byo.row.iss, byo.row.cid, byo.row).catch(() => undefined); return { charged: false, refusal: BYO_BEDROCK_REFUSED }; }
        return { charged: false, refusal: PROVIDER_ERROR };
      }
      if (rovara !== undefined) return rovaraProviderFailure(status, body);
      // The provider refused the company's key: an explicit rejection before any generation, free; the company must connect a working key.
      return status === 401 || status === 403 ? { charged: false, refusal: AGENT_KEY_REFUSED } : base.providerFailure(status, body);
    },
  };
}
/** The purpose a step reserves (learning, answers), or undefined for any task step. */
const tokenPurpose = (step: string): "learning" | "answers" | undefined => step === LEARNING_STEP ? "learning" : step === ANSWERS_STEP ? "answers" : undefined;
function routeFor(deps: GatewayDependencies, request: GatewayRequest): GatewayRoute | ProductControl | undefined {
  if (request.method !== "POST") return undefined;
  if (request.url === "/v1/messages") return agentRoute(deps);
  if (request.url.startsWith(LEARNING_PATH_PREFIX)) {
    if (request.url.length > 2048) return undefined;
    const at = request.url.indexOf("?");
    try { return deps.learning?.route(at < 0 ? request.url : request.url.slice(0, at), at < 0 ? "" : request.url.slice(at + 1)); } catch { return undefined; }
  }
  if (request.url.startsWith(ANSWERS_PATH_PREFIX)) {
    if (request.url.length > 2048) return undefined;
    const at = request.url.indexOf("?");
    try { return deps.answers?.route(at < 0 ? request.url : request.url.slice(0, at), at < 0 ? "" : request.url.slice(at + 1)); } catch { return undefined; }
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
  // DEC 254zzz41: a review's first call holds the grant's whole ceiling (`held`) and opens the session that keeps it (`heldKept`); every call of a review debits that session
  // and holds nothing of its own (`sessionCall`: what it debited and gives back when it finishes).
  let held: Reservation | undefined; let heldKept = false; let pendingOpen: Promise<unknown> | undefined;
  let sessionCall: { debited: number; claims: TaskClaims } | undefined;
  let provider: ProviderResponse | undefined;
  let settlementPrice: ResolvedPrice | undefined;
  let settlementUsage: TokenUsage | undefined;
  let settlementReported: number | undefined;
  let settlementModel: string | undefined;
  let settlementKind: PriceKind = "chat";
  // How the call ended, for an events route's settle: the refusal word last answered, or a complete answer.
  let refusedCode: string | undefined; let completed = false;
  let early: TokenUsage | undefined;
  // The settle, run once: early for a route that sends its cost in the head, else in the finally. Its result says what was written.
  let settled: { ok: boolean; micros: number; estimated: boolean } | undefined; let settling = false;
  const settleOnce = async (): Promise<{ ok: boolean; micros: number; estimated: boolean } | undefined> => {
    if (settling || (reservation === undefined && sessionCall === undefined) || route === undefined) return settled;
    settling = true;
    try {
      let estimateRecord: EstimatedSettlement | undefined;
      if (cost > 0 && settlementPrice !== undefined && settlementModel !== undefined) {
        const amount = settleAmount({ ...(settlementUsage === undefined ? {} : { usage: settlementUsage }), ...(settlementReported === undefined ? {} : { reportedCostMicros: settlementReported }), price: settlementPrice, reservationMicros: cost });
        cost = amount.actualMicros; estimated = amount.estimated;
        // A review is never recorded above the hold it was admitted on (the task's and the company's caps were checked for exactly that amount).
        if (callClaims?.reviewer !== undefined && cost > reservedMicros) cost = reservedMicros;
        if (estimated) estimateRecord = { provider: route.provider, model: settlementModel, kind: settlementKind, settledAt: now(), priceVersion: settlementPrice.priceVersion ?? 0, ...(amount.usage === undefined ? {} : { usage: amount.usage }) };
      }
      if (sessionCall !== undefined) await deps.reviewerGrants?.giveBack(sessionCall.claims.iss, sessionCall.claims.cid, sessionCall.claims.jti, Math.max(0, sessionCall.debited - cost)); else await route.meter.settle(reservation!, cost, estimateRecord); log({ event: "settled", costMicros: cost, estimated, appliedMaxOutputTokens, ...(route.product ? { route: "product" as const } : route.purpose === undefined ? {} : { route: route.purpose }) });
      settled = { ok: true, micros: cost, estimated };
      if (route.overReservation !== undefined && callClaims !== undefined && cost > reservedMicros) {
        log({ event: "product_over_reservation" });
        try { await route.overReservation(callClaims); } catch { log({ event: "settle_failed" }); }
      }
    }
    catch { log({ event: "settle_failed" }); settled ??= { ok: false, micros: cost, estimated }; } // Adapter keeps the hold if its atomic settle fails.
    return settled;
  };
  let events: (GatewaySink & { finish(outcome: { completed: boolean; code?: string }): Promise<void> }) | undefined;
  const respond = async (status: number, type: string, message: string, extra: Readonly<Record<string, string>> = {}) => {
    refusedCode = type;
    if (head) { sink.destroy(); return; }
    head = true; sink.head(status, { ...JSON_HEADERS, ...extra });
    await wait(sink.write(Buffer.from(JSON.stringify(route?.refusalBody?.(type, message) ?? { error: { type, message } })))); sink.end(); log({ event: "refused" });
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
    // A learning token only on the learning route, an answers token only on the answers route, and only such a token there (DEC 226, DEC 254z-amend2).
    if (tokenPurpose(claims.stp) !== route?.purpose) { await respond(401, AUTH_ERROR.error.type, AUTH_ERROR.error.message); return; }
    // DEC 254zzz41: a reviewer grant spends only on the agent route in company-key mode, and only where a durable single-use store is wired.
    if (claims.reviewer !== undefined && (control !== undefined || route?.reviewerGrants !== true || deps.reviewerGrants === undefined)) { await respond(401, AUTH_ERROR.error.type, AUTH_ERROR.error.message); return; }
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
    let resolved = await wait(resolvePrice(deps.prices ?? UnknownPriceSource, route.provider, guarded.model, deps.cautiousCeiling, controller.signal, guarded.priceKind ?? "chat"));
    for (const also of route.alsoPricedAs?.(guarded.model) ?? []) resolved = dearerPrice(resolved, await wait(resolvePrice(deps.prices ?? UnknownPriceSource, also.provider, also.model, deps.cautiousCeiling, controller.signal, guarded.priceKind ?? "chat")));
    const price = guarded.mediaRates === undefined ? resolved : { ...resolved, media: guarded.mediaRates };
    if (price.operatorReview) log({ event: "price_operator_review" });
    settlementPrice = price; settlementModel = guarded.model; settlementKind = guarded.priceKind ?? "chat";
    let caps = await wait(route.caps(scope, claims, controller.signal));
    if ((caps as RouteRefusal).ok === false) { const refused = caps as RouteRefusal; await respond(refused.status, refused.code, refused.message, refused.headers); return; }
    if (!validCaps(caps)) { await respond(503, "unavailable", "model access unavailable"); return; }
    // Nightly upkeep AI (L4-E): the project's upkeep cap joins the call's rows before the hold, so the call is checked BEFORE it is sent.
    const upkeep = isUpkeepCall(route, claims);
    if (upkeep) {
      const withCap = await wait(withUpkeepCap(caps, deps.upkeep, claims, controller.signal));
      if ("ok" in withCap) { await respond(withCap.status, withCap.code, withCap.message, withCap.headers); return; }
      caps = withCap;
    }
    let estimate: number;
    try { estimate = estimateCall(guarded.bytes.length - (guarded.media?.dataBytes ?? 0), guarded.maxTokens, price, guarded.hasTools ? TOOL_INPUT_ALLOWANCE_TOKENS : 0, guarded.inputBounded, guarded.media); } catch { await respond(400, "invalid_request", "request not allowed"); return; }
    if (estimate === Number.MAX_SAFE_INTEGER && !price.operatorReview) log({ event: "price_operator_review" });
    // Do not race a transaction: its outcome must be known before forwarding or settling. Adapters bound their own transactions.
    const overrunCapable = price.estimated || !guarded.inputBounded;
    const admissionExpiresSeconds = Math.floor(now() / 1000) + TASK_TOKEN_SECONDS;
    if (overrunCapable) shortenDeadline(Math.floor(Math.min(deadline, admissionExpiresSeconds * 1000) / 1000) * 1000);
    appliedMaxOutputTokens = guarded.maxTokens;
    const line = route.line?.(claims, guarded.model);
    // DEC 254zzz41: a review call is held at its priced worst case, which must fit the grant's ceiling and be exact (no estimated price, no unbounded input):
    // the hold below is then taken inside the task's limit AND the company's cap, so the ceiling cannot be spent beyond either.
    const grant = claims.reviewer;
    // REVIEW-1 M1: nothing may settle a review above its hold: no estimated price, no tier the request can reach whose rates are derived or uncertain (usageEstimated, at the most tokens the request's bytes can be), no unbounded input, and no source
    // whose provider reports its own cost (OpenRouter), which is a source Code never lists for reviews (reviewerProviderOf) but could be saved within the grant's 120 s.
    if (grant !== undefined && (overrunCapable || route.provider === "openrouter" || usageEstimated(price, { input: guarded.bytes.length, output: guarded.maxTokens, cacheRead: 0, cacheWrite: 0 }) || estimate > Math.floor(grant.ceilingUsd * 1_000_000))) { await respond(REVIEWER_CEILING_REFUSED.status, REVIEWER_CEILING_REFUSED.code, REVIEWER_CEILING_REFUSED.message); return; }
    // The grant's own lifetime and binding, and the model the request names, are pure: checked BEFORE anything is read or held (the claim itself comes later).
    const bind = grant === undefined ? "" : JSON.stringify([scope.cid, scope.pid, scope.tid, claims.ws, claims.op, grant.kind, grant.slot, claims.mdl[0]]);
    let named: unknown;
    if (grant !== undefined) {
      try { named = (JSON.parse(Buffer.concat(parts).toString("utf8")) as { model?: unknown }).model; } catch { named = undefined; }
      if (typeof named !== "string" || !(await consumeReviewerGrant(claims, { cid: scope.cid, pid: scope.pid, tid: scope.tid, ws: claims.ws, op: claims.op, kind: grant.kind, slot: grant.slot, model: named }, Math.floor(now() / 1000), async () => true))) { await respond(401, AUTH_ERROR.error.type, AUTH_ERROR.error.message); return; }
    }
    // A review's first call holds the grant's WHOLE ceiling (inside the task's limit and the company's cap) for its session; a later call of the same review
    // (the session exists) holds nothing new and debits the session below. Anything the store cannot answer is the fixed refusal, before any hold.
    let session: Awaited<ReturnType<ReviewerGrantStore["read"]>>;
    if (grant !== undefined) { try { session = await wait(deps.reviewerGrants!.read(claims.iss, scope.cid, claims.jti, controller.signal)); } catch { await respond(401, AUTH_ERROR.error.type, AUTH_ERROR.error.message); return; } }
    const ceilingMicros = grant === undefined ? 0 : Math.floor(grant.ceilingUsd * 1_000_000);
    const reserved = grant !== undefined && session !== undefined ? { ok: true as const, reservation: undefined } : await route.meter.reserve({ scope, caps, estimateMicros: grant === undefined ? estimate : ceilingMicros, appliedMaxOutputTokens, ...(line === undefined ? {} : { line }),
      ...(grant === undefined ? {} : { sweepAfter: now() + (REVIEW_SESSION_SECONDS * 1000) + REVIEW_SESSION_CLOSE_GRACE_MS, review: { jti: claims.jti.toLowerCase() } }),
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
      else if (upkeep && reserved.item === "upkeep") { const refused = upkeepRefusal(caps, estimate); await respond(refused.status, refused.code, refused.message, refused.headers); }
      else await respond(422, "budget_exceeded", route.prefix[reserved.item]);
      return;
    }
    if (grant === undefined) reservation = reserved.reservation; else held = reserved.reservation;
    reservedMicros = estimate;
    // One non-overlapping, deadline-bounded poll also stops streams stalled between chunks.
    const pollEnded = async (): Promise<void> => {
      try { if (await taskEnded()) abort(); } catch { abort(); }
      if (!controller.signal.aborted) endedTimer = setTimeout(() => { void pollEnded(); }, ENDED_TASK_POLL_MS);
    };
    endedTimer = setTimeout(() => { void pollEnded(); }, ENDED_TASK_POLL_MS);
    // No call has left the process yet, including while the key port is read.
    cost = 0; estimated = false;
    if (grant !== undefined && deps.reviewerGrants !== undefined) {
      // Only after the hold is taken (a transient "busy" or a cap refusal burns nothing) and before any key is read or byte sent. The expected
      // company, project and task are the SCOPE the hold was taken in; the model is the one the request itself names (read from its body, not the grant).
      const store = deps.reviewerGrants;
      // Opens this call's session on the hold it took. Never raced against the deadline or an abort and never throws: the finally waits for it, so the hold is
      // never released while a write that may have landed is unresolved.
      const openSession = async (jti: string, at: number): Promise<"opened" | "exists" | "failed"> => {
        const hold = held!;
        try {
          if (!(await store.open({ iss: claims.iss, cid: scope.cid, jti, bind, holdId: hold.id, ceilingMicros, firstDebitMicros: estimate, endsAt: at + REVIEW_SESSION_SECONDS }))) return "exists";
          heldKept = true; sessionCall = { debited: estimate, claims };
          // Whatever the review leaves unused goes back when its session ends (a short grace after); the session-aware hold sweep is only the backstop for a gateway task that died.
          const timer = setTimeout(() => { void closeReviewSession(store, route!.meter, scope, jti, hold.id).catch(() => { log({ event: "settle_failed" }); }); }, (REVIEW_SESSION_SECONDS * 1000) + REVIEW_SESSION_CLOSE_GRACE_MS);
          timer.unref();
          return "opened";
        } catch {
          // The write's outcome is unknown. Certainly not written: the finally gives the hold back whole. Written by THIS hold: the session is closed at what was debited (never left
          // on a released hold). Written by another call's hold: not ours to close, we continue as a later call of that review. Unreadable: the hold stays for the sweep.
          let seen: Awaited<ReturnType<ReviewerGrantStore["read"]>>; let readable = true;
          try { seen = await store.read(claims.iss, scope.cid, jti); } catch { readable = false; }
          if (!readable) { heldKept = true; return "failed"; }
          if (seen === undefined) return "failed";
          if (seen.holdId !== hold.id) return "exists";
          heldKept = true;
          try { await closeReviewSession(store, route!.meter, scope, jti, hold.id); } catch { log({ event: "settle_failed" }); }
          return "failed";
        }
      };
      const usable = typeof named === "string" && await wait(consumeReviewerGrant(claims, { cid: scope.cid, pid: scope.pid, tid: scope.tid, ws: claims.ws, op: claims.op, kind: grant.kind, slot: grant.slot, model: named }, Math.floor(now() / 1000), async (jti) => {
        const at = Math.floor(now() / 1000);
        // The first use claims the grant by opening the session (the one atomic write), with this call's worst case already debited.
        if (held !== undefined) {
          pendingOpen = openSession(jti, at);
          const outcome = await pendingOpen;
          if (outcome === "opened") return true;
          if (outcome === "failed") return false;
        }
        // A later call of the same review (or the loser of a race between two first calls): one more debit, never past the ceiling or the session's end.
        if (!(await store.debit(claims.iss, scope.cid, jti, bind, estimate, at, controller.signal))) return false;
        sessionCall = { debited: estimate, claims };
        return true;
      }));
      // A refused grant (another task, kind or model, expired, a call past the ceiling or the session, or a store that did not answer) sends nothing; a hold taken for it is given back ($0) in the finally.
      if (!usable) { await respond(401, AUTH_ERROR.error.type, AUTH_ERROR.error.message); return; }
    }
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
    if (guarded.streaming) { head = true; sink.head(200, { ...JSON_HEADERS, "content-type": guarded.streamContentType ?? "text/event-stream; charset=utf-8" }); }
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
      usage.whole(value);
      let successHeaders: Readonly<Record<string, string>> = JSON_HEADERS;
      if (route.costHeader !== undefined) {
        // The cost header (answers route): settle BEFORE the head, so the figure sent is the one the meter was written with. Never a guess:
        // the usage was read, the price is exact, and the settle went through; otherwise no header.
        early = usage.finish();
        if (early === undefined) throw new Error("provider unavailable");
        settlementUsage = early;
        try { const reported = provider.reportedCostMicros?.(); if (reported !== undefined) settlementReported = reported; } catch { /* no reported cost */ }
        const settledNow = await settleOnce();
        if (settledNow?.ok === true && !settledNow.estimated && settledNow.micros > 0 && validUsage(early) && hasUsage(early)) successHeaders = { ...JSON_HEADERS, [route.costHeader]: usdOf(settledNow.micros) };
      }
      head = true; sink.head(200, successHeaders); await wait(sink.write(bytes));
    }
    const counts = early ?? usage.finish();
    // Incomplete/malformed SSE is a failed stream, never a silent partial success.
    if (counts === undefined) throw new Error("provider unavailable");
    sink.end(); completed = true;
    settlementUsage = counts;
    // A provider-reported cost (OpenRouter) counts only for a call that completed with readable usage; settleAmount applies its rules.
    try { const reported = provider.reportedCostMicros?.(); if (reported !== undefined) settlementReported = reported; } catch { /* no reported cost */ }
  } catch (error) {
    log({ event: "provider_error" });
    const notSent = !head && error instanceof NotSentError ? route?.notSent?.() : undefined;
    try { if (head) sink.destroy(); else if (notSent !== undefined) await respond(notSent.status, notSent.code, notSent.message, notSent.headers); else await respond(502, "provider_error", "provider unavailable"); } catch { sink.destroy(); }
  } finally {
    controller.abort(); clearTimeout(timer); clearTimeout(endedTimer); request.signal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", onAbort);
    try { provider?.cancel?.(); } catch { /* Fixed log fields only; no provider text. */ }
    // The claim is never left running past this point: a session it opened is then known (heldKept) before the hold is judged.
    if (pendingOpen !== undefined) await pendingOpen.catch(() => undefined);
    // A hold taken for a review's first call that never opened its session (a refused or failed claim) is given back whole ($0).
    if (held !== undefined && !heldKept && route !== undefined) { try { await route.meter.settle(held, 0); } catch { log({ event: "settle_failed" }); } }
    await settleOnce();
    // Exactly one settle event, after the call settled.
    if (events !== undefined) { try { await events.finish({ completed, ...(refusedCode === undefined ? {} : { code: refusedCode }) }); } catch { /* The sink ends or destroys itself. */ } }
  }
}
/** Whole micro-dollars as a plain decimal USD string (six places), by integer arithmetic: no float noise. */
const usdOf = (micros: number): string => `${Math.floor(micros / 1_000_000)}.${String(micros % 1_000_000).padStart(6, "0")}`;
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
