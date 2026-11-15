// The learning call class (DEC 226): lessons' learning calls (the reflector, the curator's judge, the outcome judge) on the
// company's OWN connected provider account, never Rovara's install key.
//
//   Token    the TC-1 task token with `stp` = LEARNING_STEP. That step is accepted on this route only, and this route accepts no
//            other step (server.ts checks both directions with the fixed 401). The value is longer than Code's 24-character
//            program step ids and is no workflow mode, so no ordinary task step can carry it.
//   Switch   the company's lessons switch (`featureGates.lessons` in the company backend's settings, CompanyLessonsSwitch) is read
//            at admission, before the key, the hold or the provider: off, missing or not exactly true refuses every call.
//   Key      LearningKeySource only. This route is never handed the gateway's ProviderKeys.
//   Money    its OWN meter (separate tables), combined with the agent meter's company row (DEC 228c): one hold takes the learning
//            month row (the meter's company row: min($20 default, the company's monthly cap)) AND the combined company row (the
//            company's one monthly cap over every route). Task and project rows are accounting only (no cap of their own); no
//            person pays. A meter that does not combine holds nothing (503).
//   Pause    every refusal Code should turn into a lessons pause is `lessons_paused` with a fixed message and the reason in the
//            LEARNING_PAUSE_HEADER header (one of LEARNING_PAUSE_REASONS). Faults (an unreadable switch or budget) are 503/502,
//            never a pause.
import { validCaps, type Caps, type CapsScope, type CapsSource } from "./caps.js";
import { guardRequest, type ModelLimitsSource } from "./guard.js";
import type { Meter, MeterItem } from "./meter.js";
import type { ProviderTransport } from "./provider.js";
import type { TaskClaims } from "./model-gateway-token.js";
import type { GatewayRoute, RouteRefusal } from "./server.js";
import { UsageCollector } from "./usage.js";

/** The `stp` claim of a learning token. Code mints learning tokens with this step; no other step is a learning token. */
export const LEARNING_STEP = "rovara-lessons-learning-call";
/** Anthropic Messages, on the company's own account. */
export const LEARNING_PATH = "/v1/learning/messages";
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
  connected(iss: string, cid: string, signal?: AbortSignal): Promise<boolean>;
  keyFor(iss: string, cid: string, signal?: AbortSignal): Promise<string | undefined>;
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
  /** The learning month for a company whose settings have no learning cap (an older row), micro-dollars. Default LEARNING_DEFAULT_MONTH_MICROS. */
  monthCeilingMicros?: number;
}
/** Builds one learning route per request (it keeps that request's admission state). */
export interface LearningRouteFactory { route(): GatewayRoute }

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
    route() {
      let admitted = false;
      let notSent: RouteRefusal | undefined;
      const route: GatewayRoute = {
        provider: "anthropic", product: false, purpose: "learning", stopsWithTask: false, meter: options.meter, prefix: PREFIX,
        async admit(claims, signal) {
          try {
            // The switch first: while it is off nothing else is read, held or sent.
            if ((await options.lessons.isOn(claims.cid, signal)) !== true) return learningPaused("lessons_off");
            if ((await options.keys.connected(claims.iss, claims.cid, signal)) !== true) return learningPaused("no_provider");
          } catch { return unavailable; }
          admitted = true;
          return undefined;
        },
        guard: (bytes, headers, claims) => guardRequest(bytes, headers, claims.mdl, options.modelLimits),
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
          const key = await options.keys.keyFor(claims.iss, claims.cid, signal);
          if (key === undefined) { notSent = learningPaused("no_provider"); return ""; }
          return key;
        },
        notSent: () => notSent,
        transport: options.transport,
        usage: () => new UsageCollector(),
        providerFailure(status) {
          // The provider refused the company's key: an explicit rejection before generation, free; Code pauses for a provider.
          if (status === 401 || status === 403) return { charged: false, refusal: learningPaused("no_provider") };
          // Otherwise the agent route's rule: 429/529 explicit rejections are free, the rest keep the hold.
          return { charged: !(status === 429 || status === 529), refusal: { ok: false, status: 502, code: "provider_error", message: "provider unavailable" } };
        },
      };
      return route;
    },
  };
}
