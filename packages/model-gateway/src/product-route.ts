// The product-AI route (plan 7.4 item 7, DEC 157/165/172/216): calls made by the customer's TESTS with the project's own AI
// key. Same token (TC-1, task purpose), same price resolver, same money core as the agent route, but its own meter, its own
// caps (the project's product caps, clamped by the company ceiling) and settled to the project: the token's person and
// payer never pay for product calls.
import { validCaps, type Caps, type CapsScope, type CapsSource } from "./caps.js";
import type { ModelLimitsSource } from "./guard.js";
import type { Meter, MeterItem } from "./meter.js";
import type { ProviderTransport } from "./provider.js";
import type { TaskClaims } from "./model-gateway-token.js";
import { GeminiUsageCollector, guardGemini, parseGeminiPath } from "./product-gemini.js";
import type { ProductProvider, ProductSourceResolution } from "./product-keys.js";
import type { GatewayRoute, ProductRouteResolver, RouteRefusal } from "./server.js";

/** What the route needs from the product key store (ProductKeyStore implements it). */
export interface ProductKeySource {
  capsFor(iss: string, cid: string, project: string): Promise<{ caps: { taskMicros: number; projectMonthMicros: number }; companyMonthMicros?: number }>;
  resolve(iss: string, cid: string, project: string, provider: ProductProvider): Promise<ProductSourceResolution | undefined>;
  useKey(iss: string, cid: string, resolution: ProductSourceResolution): Promise<string | undefined>;
  recordWarning(iss: string, cid: string, resolution: ProductSourceResolution, status: 401 | 403): Promise<void>;
}
/** DEC 165: once a product call settles above its hold, every further product call in that task is refused. */
export interface ProductOverrunTasks { isBlocked(iss: string, cid: string, tid: string): Promise<boolean>; block(iss: string, cid: string, tid: string): Promise<void> }
export class InMemoryProductOverrunTasks implements ProductOverrunTasks {
  readonly #blocked = new Set<string>();
  async isBlocked(iss: string, cid: string, tid: string): Promise<boolean> { return this.#blocked.has(JSON.stringify([iss, cid, tid])); }
  async block(iss: string, cid: string, tid: string): Promise<void> { this.#blocked.add(JSON.stringify([iss, cid, tid])); }
}
export interface ProductRouteOptions {
  keys: ProductKeySource;
  /** A meter of its OWN (separate table or key prefix deployed): product holds never share rows with agent holds. */
  meter: Meter;
  /** Per-model output ceilings: the price snapshot's rows (#53 SnapshotPriceSource); see productModelLimitsFrom. */
  modelLimits: ModelLimitsSource;
  transports: { gemini: ProviderTransport };
  overrun: ProductOverrunTasks;
  /**
   * The company's budgets from the Cloud company backend (#53 CompanyBudgetCaps): fail closed. A company with no monthly cap,
   * no settings or an unreadable row gets no product calls either; its monthly cap also bounds the product meter's company row.
   */
  companyCaps: CapsSource;
}
/** Gemini rows' own max output tokens from the price snapshot; a model with no row falls back to GEMINI_DEFAULT_MAX_OUTPUT_TOKENS in the guard. */
export function productModelLimitsFrom(rows: { maxOutputTokens(provider: string, model: string): number | undefined }): ModelLimitsSource {
  return { maxOutputTokens: (provider, model) => provider !== "gemini" ? undefined : rows.maxOutputTokens(provider, model) };
}
/**
 * Product caps for a scope: the project's product caps (clamped by the product ceiling), with the company month bounded by the
 * company backend's monthly cap. Used by the route and by the product meter's corrections. Anything unreadable or a company
 * with no monthly cap answers caps that validCaps refuses (503, nothing held or sent).
 */
export function createProductCaps(keys: ProductKeySource, companyCaps: CapsSource): CapsSource {
  return {
    async capsFor(scope: CapsScope, signal?: AbortSignal): Promise<Caps> {
      const company = await companyCaps.capsFor(scope, signal);
      if (!validCaps(company) || company.companyMonth === undefined) return UNAVAILABLE_CAPS;
      const product = await keys.capsFor(scope.iss, scope.cid, scope.pid);
      return { task: product.caps.taskMicros, projectMonth: product.caps.projectMonthMicros, companyMonth: Math.min(company.companyMonth, product.companyMonthMicros ?? company.companyMonth) };
    },
  };
}
const UNAVAILABLE_CAPS = Object.freeze({}) as unknown as Caps;
export const PRODUCT_OVER_BY_ONE_CALL = "budget exceeded by one call";
export const PRODUCT_NOT_SET_UP = "product AI is not set up for this project";
export const PRODUCT_KEY_REFUSED = "not run: the product key was refused (check it in Settings)";
export const PRODUCT_PROVIDER_REFUSED = "the provider refused this request";
export const PRODUCT_PROVIDER_LIMITED = "the provider is limiting this product key; try again later";
export const PRODUCT_PREFIX: Readonly<Record<MeterItem, string>> = {
  task: "Product AI budget has been exceeded! Key=task", person: "Product AI budget has been exceeded! User=person",
  project: "Product AI budget has been exceeded! Project=project", company: "Product AI budget has been exceeded! Team=company",
};
const unavailable: RouteRefusal = { ok: false, status: 503, code: "unavailable", message: "model access unavailable" };

export function createProductRoutes(options: ProductRouteOptions): ProductRouteResolver & { caps: CapsSource } {
  const productCaps = createProductCaps(options.keys, options.companyCaps);
  return {
    caps: productCaps,
    route(path, query) {
      const parsed = parseGeminiPath(path, query);
      if (parsed === undefined) return undefined;
      // Per request: the resolution read at admission is the one the hold, caps and key use.
      let resolution: ProductSourceResolution | undefined;
      let admitted: TaskClaims | undefined;
      const route: GatewayRoute = {
        provider: "gemini", product: true, meter: options.meter, prefix: PRODUCT_PREFIX,
        async admit(claims) {
          admitted = claims;
          try {
            if (await options.overrun.isBlocked(claims.iss, claims.cid, claims.tid)) return { ok: false, status: 422, code: "budget_exceeded", message: PRODUCT_OVER_BY_ONE_CALL };
            resolution = await options.keys.resolve(claims.iss, claims.cid, claims.pid, "gemini");
          } catch { return unavailable; }
          return resolution === undefined ? { ok: false, status: 404, code: "not_set_up", message: PRODUCT_NOT_SET_UP } : undefined;
        },
        guard: (bytes, headers) => guardGemini(bytes, headers, parsed, options.modelLimits),
        // Settled to the project: no person item, whoever started the task.
        scope: (claims) => ({ iss: claims.iss, cid: claims.cid, pid: claims.pid, tid: claims.tid }),
        async caps(scope, _claims, signal): Promise<Caps | RouteRefusal> {
          if (resolution === undefined) return unavailable;
          return productCaps.capsFor(scope, signal);
        },
        async key(claims: TaskClaims) {
          // An empty answer is "not sent" in the core (the call cost nothing).
          return resolution === undefined ? "" : (await options.keys.useKey(claims.iss, claims.cid, resolution)) ?? "";
        },
        transport: options.transports.gemini,
        usage: () => new GeminiUsageCollector(),
        providerFailure(status) {
          // Explicit rejections before any generation (bad key, bad request, unknown model, quota) cost nothing.
          if (status === 401 || status === 403) {
            // The settings page learns about a refused key. A failed write never changes the call.
            if (resolution !== undefined && admitted !== undefined) void options.keys.recordWarning(admitted.iss, admitted.cid, resolution, status).catch(() => undefined);
            return { charged: false, refusal: { ok: false, status: 502, code: "product_key_refused", message: PRODUCT_KEY_REFUSED } };
          }
          if (status === 400 || status === 404) return { charged: false, refusal: { ok: false, status: 400, code: "provider_refused", message: PRODUCT_PROVIDER_REFUSED } };
          if (status === 429) return { charged: false, refusal: { ok: false, status: 429, code: "provider_limited", message: PRODUCT_PROVIDER_LIMITED, headers: { "retry-after": "5" } } };
          return { charged: true, refusal: { ok: false, status: 502, code: "provider_error", message: "provider unavailable" } };
        },
        async overReservation(claims) { await options.overrun.block(claims.iss, claims.cid, claims.tid); },
      };
      return route;
    },
  };
}
