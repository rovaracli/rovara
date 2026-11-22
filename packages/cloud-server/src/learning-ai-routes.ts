// The company's learning AI key (PRODUCT-LEARNING-CONNECT-ROUTE; DEC 226, docs/model-gateway-learning.md): the company's OWN provider
// account that lessons' learning calls run on (Anthropic, OpenAI, or Gemini on AI Studio: the learning route's providers). It is
// sealed into the same write-only store as the product keys, in the company's learning document (product-keys.ts LEARNING_OWNER):
// never a project's, never linked into one, never used for a product call.
//
//   GET    /org/learning-ai        what is connected (never a key), the company's learning cap, and why lessons are or may be paused
//   PUT    /org/learning-ai/key    {requestId, expectedRevision, provider, key}: connect, or replace the provider's key when one is connected
//   DELETE /org/learning-ai/key    {requestId, expectedRevision, provider}: remove (7-day recovery window in the store)
//
// Who: company admins only (Code's access check made now), reads included. Every write goes through the
// app's signed-write path (CSRF in handler.ts, the body hash at CloudFront). Write-only: the key is never answered, logged or
// audited. Cloud records its own audit record after the change is saved; the store keeps its own audit row in the same transaction.
import { companyCaller, isCompanyAdmin, refused } from "./company-caller.js";
import { recordCloudAction, type CloudAuditAction } from "./audit-log.js";
import { companySettings } from "./company-store.js";
import type { ProductAiErrorCode, ProductAiView } from "./product-ai-routes.js";
import type { Route, RouteAnswer, RouteContext } from "./routes.js";

/** The store's learning document (product-keys.ts LEARNING_OWNER). */
export const LEARNING_AI_OWNER = "_learning";
export const LEARNING_AI_PROVIDERS = ["anthropic", "openai", "gemini"] as const;
/**
 * DEC 254t (A2): the company accounts this page connects. OpenRouter is the agents' only (lessons have no OpenRouter path), so it never
 * makes lessons usable, and it is listed and connectable only where the openrouter kind is switched on (elsewhere this page is unchanged).
 */
export const COMPANY_KEY_PROVIDERS = [...LEARNING_AI_PROVIDERS, "openrouter"] as const;
export type LearningAiProvider = typeof COMPANY_KEY_PROVIDERS[number];
/** One source per provider in the learning document. */
export const learningSourceId = (provider: LearningAiProvider) => `src_${provider}`;
/** The learning route's pause reasons and their words (model-gateway learning-route.ts LEARNING_PAUSE_REASONS / _MESSAGES; a test pins them equal). */
export const LEARNING_PAUSE_WORDS = Object.freeze({
  lessons_off: "Lessons are switched off for this company, so no learning call is made.",
  no_provider: "Learning is paused because the company's selected AI source cannot serve learning calls yet.",
  monthly_limit: "The company's monthly learning limit is used up, so lessons are paused until next month.",
  no_budget: "The company's monthly budget has no room for learning calls, so lessons are paused.",
  cost_too_high: "One learning call of this size cannot fit the company's monthly learning limit.",
} as const);
export type LearningPauseReason = keyof typeof LEARNING_PAUSE_WORDS;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const KEY = /^[\x21-\x7e]{8,512}$/u;
const BODY_BYTES_MAX = 4_096;
const ok = (body: unknown): RouteAnswer => ({ status: 200, body });
const refusal = (status: number, code: string, message: string): RouteAnswer => ({ status, body: { error: { code, message } } });
const WORDS = Object.freeze({
  off: refusal(501, "NOT_ON_CODE_YET", "Learning AI keys aren't set up on this Cloud."),
  forbidden: refusal(403, "FORBIDDEN", "Only a company admin can see or change the company's learning AI key."),
  invalid: refusal(400, "CONFIG_INVALID", "This learning AI key is not valid."),
  tooLarge: refusal(413, "CONFIG_INVALID", "The request is too large."),
  stale: refusal(409, "CONFLICT", "The learning AI key changed. Refresh and try again."),
  noKey: refusal(404, "NOT_FOUND", "No learning AI key is connected for that provider."),
  inRecovery: refusal(409, "CONFLICT", "This key was removed less than 7 days ago. Ask an installation administrator to recover it."),
  keyRefused: refusal(400, "CONFIG_INVALID", "The provider refused this key."),
  unavailable: refusal(503, "RUNTIME_UNAVAILABLE", "Learning AI keys are unavailable right now. Try again."),
});
const ANSWER_OF: Record<ProductAiErrorCode, RouteAnswer> = {
  invalid: WORDS.invalid, stale: WORDS.stale, not_found: WORDS.noKey, in_recovery: WORDS.inRecovery, forbidden: WORDS.forbidden,
  unavailable: WORDS.unavailable, too_open: WORDS.keyRefused, refused: WORDS.keyRefused, aws_too_open: WORDS.keyRefused, aws_refused: WORDS.keyRefused, role_in_use: WORDS.keyRefused,
};
const record = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const whole = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const exactly = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const named = (v: unknown): v is LearningAiProvider => COMPANY_KEY_PROVIDERS.some((p) => p === v);
/** The providers this Cloud lists and connects: OpenRouter only where its kind is switched on (DEC 254t). */
const providersOn = (context: RouteContext): readonly LearningAiProvider[] => context.company?.aiSourceKinds?.has("openrouter") === true ? COMPANY_KEY_PROVIDERS : LEARNING_AI_PROVIDERS;
/** What the page shows: the providers switched on, plus OpenRouter whenever the company document still holds it (on or off), so it can always be removed. */
const providersShown = (context: RouteContext, v: ProductAiView): readonly LearningAiProvider[] =>
  providersOn(context).includes("openrouter") || !(v.sources.some((s) => s.provider === "openrouter") || v.removed.some((r) => r.provider === "openrouter")) ? providersOn(context) : COMPANY_KEY_PROVIDERS;

interface Admin { companyId: string; developerId: string; name: string }

/** A company admin of a company Cloud knows, from Code's access check made now. A RouteAnswer when refused. */
async function admin(context: RouteContext): Promise<Admin | RouteAnswer> {
  const backend = context.productAi;
  if (backend === undefined) return WORDS.off;
  const who = await companyCaller(context);
  if (refused(who)) return who;
  // A company owner or admin (Code's company role, never its install administrator flag).
  if (!isCompanyAdmin(who.companyRole)) return WORDS.forbidden;
  return { companyId: who.companyId, developerId: who.developerId, name: who.name };
}

async function guarded<T>(run: () => Promise<T>): Promise<T | RouteAnswer> {
  try { return await run(); }
  catch (error) {
    // The store's errors carry a fixed code; anything else is an outage. Never the error's text.
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === "string" && Object.hasOwn(ANSWER_OF, code) ? ANSWER_OF[code as ProductAiErrorCode] : WORDS.unavailable;
  }
}

/** The company's learning cap and lessons switch from Cloud's company settings; null when this Cloud keeps none or they don't read. */
async function budgetOf(context: RouteContext, companyId: string): Promise<{ learningMonthlyUsdMicros: number; companyMonthlyUsdMicros: number | null; lessonsOn: boolean } | null> {
  if (context.company === undefined) return null;
  try {
    const current = await companySettings(context.company.store, companyId);
    if (current === undefined) return null;
    return { learningMonthlyUsdMicros: current.settings.budgets.learningMonthlyUsdMicros, companyMonthlyUsdMicros: current.settings.budgets.companyMonthlyUsdMicros, lessonsOn: current.settings.featureGates["lessons"] === true };
  } catch { return null; }
}

async function answer(context: RouteContext, who: Admin, v: ProductAiView): Promise<RouteAnswer> {
  const budget = await budgetOf(context, who.companyId);
  const accounts = Object.fromEntries(providersShown(context, v).map((provider) => {
    const s = v.sources.find((each) => each.provider === provider);
    return [provider, s === undefined ? { connected: false } : { connected: s.hasKey && s.available, connectedAt: s.connectedAt, updatedAt: s.updatedAt, ...(s.warning === undefined ? {} : { refusedAt: s.warning.at }) }];
  })) as Partial<Record<LearningAiProvider, { connected: boolean; refusedAt?: number }>>;
  // Why lessons are paused now, as far as Cloud can tell (the meter's monthly_limit and cost_too_high are known only at the gateway).
  // Lessons run only on the learning providers: an OpenRouter key never makes them usable.
  const usable = LEARNING_AI_PROVIDERS.some((provider) => accounts[provider]?.connected === true && accounts[provider].refusedAt === undefined);
  const pausedNow: LearningPauseReason[] = [];
  if (budget !== null && !budget.lessonsOn) pausedNow.push("lessons_off");
  if (!usable) pausedNow.push("no_provider");
  if (budget !== null && (budget.companyMonthlyUsdMicros === null || budget.companyMonthlyUsdMicros === 0 || budget.learningMonthlyUsdMicros === 0)) pausedNow.push("no_budget");
  return ok({
    revision: v.revision, canChange: true, accounts,
    removed: v.removed.filter((r) => providersShown(context, v).some((p) => p === r.provider)).map((r) => ({ provider: r.provider, recoverUntil: r.recoverUntil })),
    learningCap: budget === null ? null : { monthlyUsdMicros: budget.learningMonthlyUsdMicros, companyMonthlyUsdMicros: budget.companyMonthlyUsdMicros },
    lessonsOn: budget === null ? null : budget.lessonsOn,
    pausedNow,
    pauseReasons: Object.entries(LEARNING_PAUSE_WORDS).map(([reason, message]) => ({ reason, message })),
  });
}

async function audited(context: RouteContext, who: Admin, action: CloudAuditAction, provider: LearningAiProvider): Promise<void> {
  if (context.audit === undefined) return;
  try {
    await recordCloudAction(context.audit, { companyId: who.companyId, actor: { developerId: who.developerId, name: who.name, type: "person" }, action, via: "web", subject: `learning_ai:${provider}` }, context.now);
  } catch { console.log(JSON.stringify({ event: "cloud.audit_failed", action, companyId: who.companyId })); }
}

/** Reads the write's envelope: a request id (replay-safe in the store), the revision the person saw, and the provider. */
function envelope(context: RouteContext, keys: readonly string[], gated = true): { body: Record<string, unknown>; requestId: string; expectedRevision: number; provider: LearningAiProvider } | RouteAnswer {
  if (Buffer.byteLength(JSON.stringify(context.body) ?? "", "utf8") > BODY_BYTES_MAX) return WORDS.tooLarge;
  const body = record(context.body);
  if (body === undefined || !exactly(body, ["requestId", "expectedRevision", "provider", ...keys])) return WORDS.invalid;
  if (typeof body.requestId !== "string" || !UUID.test(body.requestId) || !whole(body.expectedRevision) || !named(body.provider) || (gated && !providersOn(context).includes(body.provider))) return WORDS.invalid;
  return { body, requestId: body.requestId, expectedRevision: body.expectedRevision, provider: body.provider };
}

async function readLearningAi(context: RouteContext): Promise<RouteAnswer> {
  const who = await admin(context);
  if (("status" in who)) return who;
  const backend = context.productAi!;
  const v = await guarded(() => backend.store.view(backend.issuer, who.companyId, LEARNING_AI_OWNER));
  return ("status" in v) ? v : answer(context, who, v);
}

async function putKey(context: RouteContext): Promise<RouteAnswer> {
  const who = await admin(context);
  if (("status" in who)) return who;
  const e = envelope(context, ["key"]);
  if (("status" in e)) return e;
  const key = e.body.key;
  if (typeof key !== "string" || !KEY.test(key)) return WORDS.invalid;
  const backend = context.productAi!;
  const current = await guarded(() => backend.store.view(backend.issuer, who.companyId, LEARNING_AI_OWNER));
  if (("status" in current)) return current;
  const sourceId = learningSourceId(e.provider);
  const change = { iss: backend.issuer, cid: who.companyId, owner: LEARNING_AI_OWNER, requestId: e.requestId, expectedRevision: e.expectedRevision, actor: { id: who.developerId, role: "company_admin" as const } };
  const connected = current.sources.some((s) => s.sourceId === sourceId && s.hasKey);
  const v = await guarded(() => connected ? backend.store.rotate({ ...change, sourceId, key }) : backend.store.connect({ ...change, sourceId, provider: e.provider, key }));
  if (("status" in v)) return v;
  await audited(context, who, connected ? "learning_ai.key.rotated" : "learning_ai.key.connected", e.provider);
  return answer(context, who, v);
}

async function removeKey(context: RouteContext): Promise<RouteAnswer> {
  const who = await admin(context);
  if (("status" in who)) return who;
  // Removing a key is never gated on the switch: a company can always remove what it stored (the store answers not found otherwise).
  const e = envelope(context, [], false);
  if (("status" in e)) return e;
  const backend = context.productAi!;
  const v = await guarded(() => backend.store.remove({ iss: backend.issuer, cid: who.companyId, owner: LEARNING_AI_OWNER, requestId: e.requestId, expectedRevision: e.expectedRevision, actor: { id: who.developerId, role: "company_admin" }, sourceId: learningSourceId(e.provider) }));
  if (("status" in v)) return v;
  await audited(context, who, "learning_ai.key.removed", e.provider);
  return answer(context, who, v);
}

/** Added to the route table with the product AI routes (the same store). */
export const LEARNING_AI_ROUTES: Route[] = [
  { method: "GET", path: /^\/org\/learning-ai$/u, answer: readLearningAi },
  { method: "PUT", path: /^\/org\/learning-ai\/key$/u, answer: putKey },
  { method: "DELETE", path: /^\/org\/learning-ai\/key$/u, answer: removeKey },
];
