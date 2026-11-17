// The learning call class (DEC 226): lessons' learning calls (the reflector, the curator's judge, the outcome judge) on the
// company's OWN connected provider account, never Rovara's install key.
//
//   Token    the TC-1 task token with `stp` = LEARNING_STEP. That step is accepted on this route only, and this route accepts no
//            other step (server.ts checks both directions with the fixed 401). The value is longer than Code's 24-character
//            program step ids and is no workflow mode, so no ordinary task step can carry it.
//   Switch   the company's lessons switch (`featureGates.lessons` in the company backend's settings, CompanyLessonsSwitch) is read
//            at admission, before the key, the hold or the provider: off, missing or not exactly true refuses every call.
//   Key      LearningKeySource only. This route is never handed the gateway's ProviderKeys.
//   Provider One route per provider the company may have connected, all under /v1/learning/ and all through the SAME money core,
//            meter, combined cap and pause codes: Anthropic Messages (/v1/learning/messages), Gemini on AI Studio
//            (/v1/learning/gemini/...), Gemini on Vertex (/v1/learning/vertex/...) and OpenAI Chat Completions
//            (/v1/learning/openai/chat/completions). Only the body guard, the usage reader, the transport and the price rows
//            differ. The caller picks the path and the model; the gateway admits the call only when the company has THAT
//            provider connected and the token's `mdl` names the model (Code decides which model each learning call uses).
//            Gemini and Vertex bodies go through the product route's guard (no audio or video here: no media prices are given).
//   Money    its OWN meter (separate tables), combined with the agent meter's company row (DEC 228c): one hold takes the learning
//            month row (the meter's company row: min($20 default, the company's monthly cap)) AND the combined company row (the
//            company's one monthly cap over every route). Task and project rows are accounting only (no cap of their own); no
//            person pays. A meter that does not combine holds nothing (503).
//   Pause    every refusal Code should turn into a lessons pause is `lessons_paused` with a fixed message and the reason in the
//            LEARNING_PAUSE_HEADER header (one of LEARNING_PAUSE_REASONS). Faults (an unreadable switch or budget) are 503/502,
//            never a pause.
import { validCaps, type Caps, type CapsScope, type CapsSource } from "./caps.js";
import { guardRequest, type GuardFailure, type ModelLimitsSource } from "./guard.js";
import { guardOpenAi, OpenAiUsageCollector } from "./learning-openai.js";
import type { Meter, MeterItem } from "./meter.js";
import type { ProviderTransport } from "./provider.js";
import type { TaskClaims } from "./model-gateway-token.js";
import { GeminiUsageCollector, guardGemini, parseGeminiPath } from "./product-gemini.js";
import { guardVertex, parseVertexPath, type VertexTarget } from "./product-vertex.js";
import type { GatewayRoute, RouteCall, RouteRefusal } from "./server.js";
import { UsageCollector } from "./usage.js";

/** The `stp` claim of a learning token. Code mints learning tokens with this step; no other step is a learning token. */
export const LEARNING_STEP = "rovara-lessons-learning-call";
/** Anthropic Messages, on the company's own account. */
export const LEARNING_PATH = "/v1/learning/messages";
export const LEARNING_PATH_PREFIX = "/v1/learning/";
/** The provider accounts a company may connect for learning calls; each has its own path under LEARNING_PATH_PREFIX. */
export const LEARNING_PROVIDERS = ["anthropic", "gemini", "vertex", "openai"] as const;
export type LearningProvider = typeof LEARNING_PROVIDERS[number];
/** A company account the key source may hold: the learning providers, and OpenRouter, which only the agent route uses (DEC 254t, agent-openai.ts). */
export type CompanyKeyProvider = LearningProvider | "openrouter";
export const LEARNING_OPENAI_PATH = "/v1/learning/openai/chat/completions";
/** The product route's Gemini and Vertex paths, which parseGeminiPath and parseVertexPath read: a learning path is the same with this prefix. */
const PRODUCT_PREFIX_OF: Readonly<Record<"gemini" | "vertex", string>> = { gemini: "/v1/product/gemini/", vertex: "/v1/product/vertex/" };
/** DEC 226: $20 a month per company, in micro-dollars: the learning month when the company's settings carry no learning cap of their own. */
export const LEARNING_DEFAULT_MONTH_MICROS = 20_000_000;
export const LEARNING_PAUSE_HEADER = "x-rovara-lessons-pause";
export const LEARNING_PAUSE_REASONS = ["lessons_off", "no_provider", "monthly_limit", "no_budget", "cost_too_high"] as const;
export type LearningPauseReason = typeof LEARNING_PAUSE_REASONS[number];
export const LEARNING_PAUSE_MESSAGES: Readonly<Record<LearningPauseReason, string>> = Object.freeze({
  lessons_off: "Lessons are switched off for this company, so no learning call is made.",
  no_provider: "Learning calls need the company's own connected AI provider account, and none is usable.",
  monthly_limit: "The company's monthly learning limit is used up, so lessons are paused until next month.",
  no_budget: "The company's monthly budget has no room for learning calls, so lessons are paused.",
  cost_too_high: "One learning call of this size cannot fit the company's monthly learning limit.",
});
const STATUS: Readonly<Record<LearningPauseReason, number>> = { lessons_off: 403, no_provider: 403, monthly_limit: 422, no_budget: 422, cost_too_high: 422 };
const NO_CAP = Number.MAX_SAFE_INTEGER;
const UNAVAILABLE_CAPS = Object.freeze({}) as unknown as Caps;
const unavailable: RouteRefusal = { ok: false, status: 503, code: "unavailable", message: "model access unavailable" };
export const learningPaused = (reason: LearningPauseReason): RouteRefusal => ({ ok: false, status: STATUS[reason], code: "lessons_paused", message: LEARNING_PAUSE_MESSAGES[reason], headers: { [LEARNING_PAUSE_HEADER]: reason } });
const PREFIX: Readonly<Record<MeterItem, string>> = {
  task: LEARNING_PAUSE_MESSAGES.monthly_limit, person: LEARNING_PAUSE_MESSAGES.monthly_limit, project: LEARNING_PAUSE_MESSAGES.monthly_limit, company: LEARNING_PAUSE_MESSAGES.monthly_limit,
};

/** The company's lessons switch. `true` only when it is on; a read that fails throws (the call answers 503). */
export interface LessonsSwitch { isOn(cid: string, signal?: AbortSignal): Promise<boolean> }
/**
 * The company's OWN connected provider account for learning calls (Anthropic Messages). Never the gateway's install key.
 * `connected` is read at admission (before any hold); `keyFor` just before sending; undefined there means "not sent" ($0).
 */
export interface LearningKeySource {
  /** Whether the company has this provider connected. `provider` is the route's: a company with only Gemini connected is not connected for OpenAI. */
  connected(iss: string, cid: string, provider: CompanyKeyProvider, signal?: AbortSignal): Promise<boolean>;
  /** The secret to send: the API key, or for Vertex the short-lived Google bearer token the adapter minted for this company. */
  keyFor(iss: string, cid: string, provider: CompanyKeyProvider, signal?: AbortSignal): Promise<string | undefined>;
  /** Vertex only: the company's connected Google Cloud project and location (a call naming another one is refused). Absent or undefined: Vertex is not usable. */
  vertexTarget?(iss: string, cid: string, signal?: AbortSignal): Promise<VertexTarget | undefined>;
  /** The provider refused the company's credential (401/403): the adapter may mark it or drop a cached token. Never changes the call. */
  refused?(iss: string, cid: string, provider: CompanyKeyProvider): Promise<void> | void;
}
export interface LearningRouteOptions {
  keys: LearningKeySource;
  /** Its OWN meter (separate tables), combined with the agent meter's company row (`combinedCompany` must be true, DEC 228c). */
  meter: Meter;
  /** The company backend's budgets (CompanyBudgetCaps): a company with no monthly cap gets no learning calls. */
  companyCaps: CapsSource;
  lessons: LessonsSwitch;
  modelLimits: ModelLimitsSource;
  /** The Anthropic transport; the key it sends is always the company's own (`ProviderRequest.key`). */
  transport: ProviderTransport;
  /** The other providers' transports. A provider with no transport here has no path (404). */
  transports?: { gemini?: ProviderTransport; vertex?: ProviderTransport; openai?: ProviderTransport };
  /** The learning month for a company whose settings have no learning cap (an older row), micro-dollars. Default LEARNING_DEFAULT_MONTH_MICROS. NOT an operator ceiling: a company's own learning cap (up to its monthly cap) replaces it. */
  monthCeilingMicros?: number;
}
/** Builds one learning route per request (it keeps that request's admission state). */
export interface LearningRouteFactory { route(path: string, query: string): GatewayRoute | undefined }

/** Which provider a learning path belongs to, and (Gemini, Vertex) the product-shaped path its parser reads. Pure path parsing. */
export function parseLearningPath(path: string, query: string): { provider: "anthropic" | "openai" } | { provider: "gemini" | "vertex"; productPath: string } | undefined {
  if (path === LEARNING_PATH) return query === "" ? { provider: "anthropic" } : undefined;
  if (path === LEARNING_OPENAI_PATH) return query === "" ? { provider: "openai" } : undefined;
  for (const provider of ["gemini", "vertex"] as const) {
    const own = `${LEARNING_PATH_PREFIX}${provider}/`;
    if (path.startsWith(own)) return { provider, productPath: `${PRODUCT_PREFIX_OF[provider]}${path.slice(own.length)}` };
  }
  return undefined;
}
/** Google's words for an invalid API key (AI Studio answers 400, not 401). Read only to classify, never echoed. */
const GOOGLE_KEY_INVALID = /API_KEY_INVALID|API key not valid|API key expired/iu;
const unavailableGuard = { ok: false as const, status: 503, code: "unavailable", message: "model access unavailable" };
const notAllowed = { ok: false as const, status: 400, code: "invalid_request", message: "request not allowed" };

/**
 * Learning caps for a scope (also the caps the learning meter's corrections use). The learning month is the company's own learning cap
 * (`Caps.learningMonth`, from its settings), else `ceiling`, and never more than the company's monthly cap. Anything unreadable or no
 * company cap: invalid caps.
 */
export function createLearningCaps(companyCaps: CapsSource, ceiling: number = LEARNING_DEFAULT_MONTH_MICROS): CapsSource {
  return {
    async capsFor(scope: CapsScope, signal?: AbortSignal): Promise<Caps> {
      const company = await companyCaps.capsFor(scope, signal);
      if (!validCaps(company) || company.companyMonth === undefined) return UNAVAILABLE_CAPS;
      return { task: NO_CAP, projectMonth: NO_CAP, companyMonth: Math.min(company.learningMonth ?? ceiling, company.companyMonth), combinedCompanyMonth: company.companyMonth };
    },
  };
}

export function createLearningRoutes(options: LearningRouteOptions): LearningRouteFactory & { caps: CapsSource } {
  const ceiling = options.monthCeilingMicros ?? LEARNING_DEFAULT_MONTH_MICROS;
  if (!Number.isSafeInteger(ceiling) || ceiling < 1) throw new Error("invalid learning ceiling");
  const learningCaps = createLearningCaps(options.companyCaps, ceiling);
  return {
    caps: learningCaps,
    route(path, query) {
      const parsed = parseLearningPath(path, query);
      if (parsed === undefined) return undefined;
      const provider = parsed.provider;
      const transport = provider === "anthropic" ? options.transport : options.transports?.[provider];
      if (transport === undefined) return undefined;
      // Gemini and Vertex: the product route's own path parsers, on the same path under the product prefix.
      const geminiPath = parsed.provider === "gemini" ? parseGeminiPath(parsed.productPath, query) : undefined;
      const vertexPath = parsed.provider === "vertex" ? parseVertexPath(parsed.productPath, query) : undefined;
      if ((provider === "gemini" && geminiPath === undefined) || (provider === "vertex" && vertexPath === undefined)) return undefined;
      let admitted = false;
      let who: { iss: string; cid: string } | undefined;
      let notSent: RouteRefusal | undefined;
      let target: VertexTarget | undefined;
      const route: GatewayRoute = {
        // The price rows' provider: Vertex is priced on the Gemini rows and the Vertex rows, at the dearer (alsoPricedAs).
        provider: provider === "vertex" ? "gemini" : provider, product: false, purpose: "learning", stopsWithTask: false, meter: options.meter, prefix: PREFIX,
        async admit(claims, signal) {
          try {
            // The switch first: while it is off nothing else is read, held or sent.
            if ((await options.lessons.isOn(claims.cid, signal)) !== true) return learningPaused("lessons_off");
            // Connected FOR THIS provider: one account's key is never used on another provider's path.
            if ((await options.keys.connected(claims.iss, claims.cid, provider, signal)) !== true) return learningPaused("no_provider");
            if (provider === "vertex") {
              target = await options.keys.vertexTarget?.(claims.iss, claims.cid, signal);
              if (target === undefined) return learningPaused("no_provider");
              // The path must name the CONNECTED project and location, whatever the token could reach.
              if (vertexPath!.project !== target.projectId || vertexPath!.location !== target.location) return { ok: false, status: 400, code: "not_allowed", message: "request not allowed" };
            }
          } catch { return unavailable; }
          who = { iss: claims.iss, cid: claims.cid };
          admitted = true;
          return undefined;
        },
        guard(bytes, headers, claims): RouteCall | GuardFailure {
          const checked = provider === "anthropic" ? guardRequest(bytes, headers, claims.mdl, options.modelLimits)
            : provider === "openai" ? guardOpenAi(bytes, headers, options.modelLimits)
            : provider === "gemini" ? guardGemini(bytes, headers, geminiPath!, options.modelLimits)
            : target === undefined ? unavailableGuard : guardVertex(bytes, headers, vertexPath!, target, options.modelLimits);
          // Every provider: the model is one of the token's (Code decides which model a learning call uses).
          if (checked.ok && !claims.mdl.includes(checked.model)) return notAllowed;
          return checked;
        },
        // The company pays: no person row, whoever started the task.
        scope: (claims) => ({ iss: claims.iss, cid: claims.cid, pid: claims.pid, tid: claims.tid }),
        async caps(scope, _claims, signal) {
          if (!admitted || options.meter.combinedCompany !== true) return unavailable;
          const caps = await learningCaps.capsFor(scope, signal);
          return validCaps(caps) ? caps : learningPaused("no_budget");
        },
        async capRefusal(refused, scope, caps, estimateMicros) {
          const month = caps.companyMonth ?? 0;
          // A learning cap of zero (the company switched learning spend off in its budgets) has no room for any call: not "too big".
          if (month === 0) return learningPaused("no_budget");
          if (estimateMicros > month) return learningPaused("cost_too_high");
          if (refused.item !== "company") return learningPaused("monthly_limit");
          // Which company row refused: the learning month row (this meter's own) or the combined company cap. Labelling only:
          // the refusal itself was atomic in the meter, and either way nothing is held or sent.
          try {
            const own = (await options.meter.read(scope)).find((row) => row.item === "company");
            // Spent money, not holds: a row blocked only by other calls' holds is never a permanent refusal (the meter says `held`).
            if (own === undefined || (!own.overrun && own.spentMicros <= month - estimateMicros)) return learningPaused("no_budget");
          } catch { /* Unreadable: say the learning month (still a pause, never a call). */ }
          return learningPaused("monthly_limit");
        },
        // Only the company's own key. An empty answer is "not sent" in the core (the call cost nothing). The switch is read AGAIN
        // here, just before sending: an admin's "off" during the body upload or the hold stops the call at $0.
        async key(claims: TaskClaims, signal) {
          if (!admitted) return "";
          try { if ((await options.lessons.isOn(claims.cid, signal)) !== true) { notSent = learningPaused("lessons_off"); return ""; } }
          catch { notSent = unavailable; return ""; }
          const key = await options.keys.keyFor(claims.iss, claims.cid, provider, signal);
          if (key === undefined) { notSent = learningPaused("no_provider"); return ""; }
          return key;
        },
        notSent: () => notSent,
        transport,
        usage: () => provider === "anthropic" ? new UsageCollector() : provider === "openai" ? new OpenAiUsageCollector() : new GeminiUsageCollector(),
        // Gemini, Vertex and OpenAI: the first bytes of a failed answer are read to tell a refused key from a refused request.
        ...(provider === "anthropic" ? {} : { failureBody: true }),
        providerFailure(status, body) {
          const refusedKey = () => {
            if (options.keys.refused !== undefined && who !== undefined) { try { void Promise.resolve(options.keys.refused(who.iss, who.cid, provider)).catch(() => undefined); } catch { /* Never changes the call. */ } }
            return { charged: false, refusal: learningPaused("no_provider") };
          };
          // The provider refused the company's key: an explicit rejection before generation, free; Code pauses for a provider.
          if (status === 401 || status === 403) return refusedKey();
          if (provider !== "anthropic") {
            // Google answers an invalid or revoked AI Studio key with a 400 (API_KEY_INVALID): the same pause as a 401.
            if (status === 400 && provider === "gemini" && body !== undefined && GOOGLE_KEY_INVALID.test(Buffer.from(body).subarray(0, 64 * 1024).toString("utf8"))) return refusedKey();
            // Any other 400, 404 (unknown model) or 422 is rejected before any generation (as on the product route): nothing was spent.
            if (status === 400 || status === 404 || status === 422) return { charged: false, refusal: { ok: false, status: 502, code: "provider_error", message: "provider unavailable" } };
          }
          // Otherwise the agent route's rule: 429/529 explicit rejections are free, the rest keep the hold.
          return { charged: !(status === 429 || status === 529), refusal: { ok: false, status: 502, code: "provider_error", message: "provider unavailable" } };
        },
        ...(provider === "vertex" ? { alsoPricedAs: (model: string) => [{ provider: "vertex", model }, { provider: "vertex", model: `vertex_ai/${model}` }] } : {}),
      };
      return route;
    },
  };
}
