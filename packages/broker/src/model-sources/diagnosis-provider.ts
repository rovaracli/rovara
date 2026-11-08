// Fix with agent (diagnosis) runs on the company's own AI provider and the company pays for it (owner decision 2026-11-03, replacing the Rovara-paid design: DG-3).
//
// This file is the one place that says WHICH provider a diagnosis may use, so the check at the start ("is it offered?") and the choice at the key ("which model, which route?") cannot disagree:
//   - Any source the project walks that is billed to the company: its own sources (Bedrock, Anthropic, OpenAI, OpenRouter, an approved endpoint) AND Rovara's metered built-in AI (the `rovara` source). Owner
//     decision 2026-11-03: the metered source counts, because it is billed to the company or project exactly as its tasks are. It is reached only through the ordinary admitted, budget-capped, ledger-tagged
//     chat-turn key in the requester's name (model-access.ts); there is no Rovara-paid key and no support team any more, so no path makes Rovara the payer.
// A person's ChatGPT plan is never used: a diagnosis turn has no person's plan behind it and a route without an alias cannot carry a key.
// With no such source the answer is "none", and the diagnosis is not offered (`DIAGNOSIS_NO_PROVIDER_MESSAGE`). Nothing here falls back to anything else.
import { canonicalModelName, type ModelIdentifier, type OrgId } from "@agentx/contracts";
import { catalogModel, listPricesPerMillion } from "@agentx/model-runtime/catalog";
import { isBatchVariant, isFreeVariant } from "./model-variants.js";
import { effectiveSources, servableModels, servingRoutes, type ModelRoute, type RoutingDependencies } from "./routing.js";

const billedToCompany = (id: string): boolean => id !== "personal-chatgpt";

/** The routing a diagnosis may use: the project's walk, metered `rovara` source included, and never a person's ChatGPT plan. Absent where the install has no model proxy: nothing can then be shown to be the company's. */
export function customerProviderRouting(deps: RoutingDependencies): RoutingDependencies | undefined {
  const { sources, projectSourceOrder } = deps;
  if (sources === undefined) return undefined;
  const allowed = billedToCompany;
  return {
    ...deps,
    sources: { read: async (orgId) => { const stored = await sources.read(orgId); return { ...stored, order: stored.order.filter(allowed) }; } },
    ...(projectSourceOrder === undefined ? {} : { projectSourceOrder: async (orgId: OrgId, project: string) => (await projectSourceOrder(orgId, project))?.filter(allowed) }),
  };
}

const listPrice = (model: ModelIdentifier): number => {
  const price = listPricesPerMillion(model);
  return price === undefined ? Number.POSITIVE_INFINITY : price.input + price.output;
};
const cheapestFirst = (models: readonly ModelIdentifier[]): ModelIdentifier[] =>
  [...models].sort((left, right) => listPrice(left) - listPrice(right) || canonicalModelName(left).localeCompare(canonicalModelName(right)));

/**
 * The model and route a diagnosis turn runs on, or undefined when the company has no usable provider for the project. The company's assistant model when a source serves it, then the models of the project's sources in their order (cheapest first within a source), then `preferred`
 * (the chat service's configured one). A model the company forbids is never chosen.
 */
export async function chooseDiagnosisRoute(
  deps: RoutingDependencies, orgId: OrgId, project: string, forbidden: (model: ModelIdentifier) => boolean, preferred: ReadonlyArray<ModelIdentifier | undefined> = [],
): Promise<{ model: ModelIdentifier; route: ModelRoute & { alias: string } } | undefined> {
  const own = customerProviderRouting(deps);
  if (own === undefined) return undefined;
  const effective = await effectiveSources(own, orgId, project);
  if (effective === undefined || effective.order.length === 0) return undefined;
  // The order of the project's sources decides, as it does for its tasks: the first source that serves anything is the one used (the company's connected provider before Rovara's metered one when it comes first),
  // its cheapest allowed model first. The assistant model leads when a source serves it; `preferred` (the chat service's configured model) only comes last.
  const perSource: ModelIdentifier[] = [];
  for (const id of effective.order) perSource.push(...cheapestFirst(await servableModels({ ...own, projectSourceOrder: async () => [id] }, orgId, project)));
  const candidates = [effective.stored.assistantModel, ...perSource, ...preferred];
  const seen = new Set<string>();
  for (const model of candidates) {
    if (model === undefined) continue;
    const name = canonicalModelName(model);
    if (seen.has(name) || forbidden(model)) continue;
    seen.add(name);
    const route = (await servingRoutes(own, { orgId, project, model })).find((served) => served.alias !== undefined);
    if (route?.alias !== undefined) return { model, route: { ...route, alias: route.alias } };
  }
  return undefined;
}

// ---- Learning (lessons in production, lane 1b): the company's CHEAPEST suitable company-billed model, not its assistant model.

/** Why learning has no model: no company-billed source serves anything, every served model is forbidden, or none of the allowed ones can take a call of this size. */
export type LearningRouteNone = "no_provider" | "all_models_forbidden" | "no_suitable_model" | "cost_too_high";
/** A cap on what one call may hold (Public's per-task cap): `holdOf` is what a call on that model would hold (the sized hold, or the fixed one for a model with no list price), `usd` the most it may be. */
export interface LearningHoldCap { usd: number; holdOf: (model: ModelIdentifier) => number }
/** The size of the call being priced: the most input tokens it can hold and the most output tokens it may ask for. */
export interface LearningCallShape { inputTokens: number; maxOutputTokens: number }
/** Ids that are plainly not chat models. The installed catalogs hold chat models only; a company's own endpoint can name anything, so its names are checked. */
const NOT_CHAT = /embed|rerank|moderation|whisper|transcri|tts|speech|dall-?e|image-gen|realtime|audio/iu;

/** What one call of this shape costs at most on a model with a list price, in USD; undefined for a model with no list price (a company's own source). */
export function learningWorstCaseUsd(model: ModelIdentifier, shape: LearningCallShape): number | undefined {
  const price = listPricesPerMillion(model);
  return price === undefined ? undefined : (shape.inputTokens * price.input + shape.maxOutputTokens * price.output) / 1_000_000;
}

/** OpenRouter's router meta-models (`openrouter/auto`, `openrouter/free`, ...) and routers by name: the provider picks the real model behind them, so neither its price nor where the text goes is known here. */
const isRouterModel = (model: ModelIdentifier): boolean => model.provider.toLowerCase() === "openrouter" && /^(?:auto$|openrouter\/|.*router)/iu.test(model.modelId);

/** The reasoning levels a learning call may send. */
export type LearningReasoningEffort = "none" | "minimal" | "low";
const LEARNING_EFFORTS: readonly LearningReasoningEffort[] = ["minimal", "low"];
const ALLOWED_EFFORTS: readonly LearningReasoningEffort[] = ["none", "minimal", "low"];

/** A reasoning model that spends its output budget on hidden reasoning unless told not to (OpenAI's families, on their own transports). Anthropic models list `reasoning: true` too, but think only when asked. */
export function reasonsByDefault(model: ModelIdentifier): boolean {
  const known = catalogModel(model);
  return known !== undefined && known.reasoning === true && (known.api === "openai-responses" || known.api === "openai-completions");
}

/**
 * The reasoning level a learning call asks for, read from a model's `thinkingLevelMap` (the catalog's own doc: a level the map LISTS as null is unsupported and the provider refuses it; a level the map does NOT list uses the provider's default,
 * so it is allowed; LP-12 N2). In order: the map's "off" value when it is "none"; a short level the map names with a string the protocol takes, sent as that string ("minimal", then "low"); a short level the map leaves out ("low" first, the one every provider that has levels
 * takes, then "minimal"). A map that nulls both short levels and has no usable "off" cannot be told to keep its reasoning short: unfit (`fit: false`). The level sent is always one of the three the protocol allows, never a longer one.
 */
export function learningEffortOfMap(map: Readonly<Record<string, string | null | undefined>>): { fit: true; effort: LearningReasoningEffort } | { fit: false } {
  if (map["off"] === "none") return { fit: true, effort: "none" };
  // L5: a level the map names is sent as the value the map gives it, when that is one the protocol takes (`{low: "high"}` must not send "low"); any other value leaves that level out (fail closed).
  for (const level of LEARNING_EFFORTS) {
    const mapped = map[level];
    if (typeof mapped === "string" && (ALLOWED_EFFORTS as readonly string[]).includes(mapped)) return { fit: true, effort: mapped as LearningReasoningEffort };
  }
  for (const level of [...LEARNING_EFFORTS].reverse()) if (map[level] === undefined) return { fit: true, effort: level };
  return { fit: false };
}

/**
 * The reasoning level a learning call on this model asks for, read from the catalog's own `thinkingLevelMap` (never guessed from the model's name; `learningEffortOfMap` says how). A model that reasons by default and
 * supports no short level cannot be told to keep its reasoning short, so it is unfit (`fit: false`). A model that does not reason by default, or has no map, gets no level at all (nothing is sent).
 */
export function learningReasoningEffort(model: ModelIdentifier): { fit: true; effort?: LearningReasoningEffort } | { fit: false } {
  if (!reasonsByDefault(model)) return { fit: true };
  const map = catalogModel(model)?.thinkingLevelMap as Record<string, string | null | undefined> | undefined;
  if (map === undefined) return { fit: true };
  return learningEffortOfMap(map);
}

/**
 * A model learning must never run on, however cheap it looks: one whose catalog list price is zero or negative (a free tier, or a router whose spend the ledger would count at $0 while the provider bills the
 * company), an OpenRouter router meta-model, a `:free` variant (the provider may train on the text sent to it), a `:batch` variant (the Batch API's id, at a price the hold is not sized on), and a model that reasons
 * by default and supports no short reasoning level (`learningReasoningEffort`). Used to rank, and to refuse the company's "lessons model" setting.
 */
export function unfitForLearning(model: ModelIdentifier): boolean {
  if (isFreeVariant(model) || isBatchVariant(model) || isRouterModel(model) || !learningReasoningEffort(model).fit) return true;
  const price = listPricesPerMillion(model);
  return price !== undefined && !(price.input > 0 && price.output > 0);
}

/** A chat model that takes text and can answer a call of this size with JSON (any chat model can; the catalog's limits are checked where it knows the model). */
function suitableForLearning(model: ModelIdentifier, shape: LearningCallShape): boolean {
  if (NOT_CHAT.test(model.modelId) || unfitForLearning(model)) return false;
  const known = catalogModel(model);
  if (known === undefined) return true;
  if (known.type !== undefined && known.type !== "chat") return false;
  if (Array.isArray(known.input) && !known.input.includes("text")) return false;
  return known.maxTokens >= shape.maxOutputTokens && known.contextWindow >= shape.inputTokens + shape.maxOutputTokens;
}

/**
 * The model and route learning (the reflector, the curator's judge) runs on: the company's own CHEAPEST suitable model among the company-billed sources the project walks (its own sources and Rovara's metered
 * built-in AI; never a person's ChatGPT plan), by the call's own worst-case list price, a model that reasons by default after every one that does not, and never a free, router or zero-priced one (`unfitForLearning`). A model with no list price comes after every priced one, in the order the sources are walked. A model the company forbids is
 * never chosen. `preferred` is the company's "lessons model" setting: it wins when it is still served, allowed, suitable and within `cap`, and is ignored (the cheapest is used) when it is not.
 */
export async function chooseLearningRoute(
  deps: RoutingDependencies, orgId: OrgId, project: string, forbidden: (model: ModelIdentifier) => boolean, shape: LearningCallShape, preferred?: ModelIdentifier, cap?: LearningHoldCap,
): Promise<{ model: ModelIdentifier; route: ModelRoute & { alias: string }; /** The company's "lessons model" was set, is suitable, and was passed over only because its hold is over `cap` (L2: said in a log line, never silently). */ preferredOverCap?: true } | { none: LearningRouteNone }> {
  const own = customerProviderRouting(deps);
  if (own === undefined) return { none: "no_provider" };
  const effective = await effectiveSources(own, orgId, project);
  if (effective === undefined || effective.order.length === 0) return { none: "no_provider" };
  const served = await servableModels(own, orgId, project);
  if (served.length === 0) return { none: "no_provider" };
  const allowed = served.filter((model) => !forbidden(model));
  if (allowed.length === 0) return { none: "all_models_forbidden" };
  const suitable = allowed.filter((model) => suitableForLearning(model, shape));
  if (suitable.length === 0) return { none: "no_suitable_model" };
  // LP-10 R4: a model whose hold is over the per-call cap is skipped, the "lessons model" setting included, so the cheapest one that fits is used; only when none fits is the call too dear.
  const affordable = cap === undefined ? suitable : suitable.filter((model) => cap.holdOf(model) <= cap.usd + 1e-9);
  if (affordable.length === 0) return { none: "cost_too_high" };
  const cost = (model: ModelIdentifier): number => learningWorstCaseUsd(model, shape) ?? Number.POSITIVE_INFINITY;
  const walked = new Map(suitable.map((model, index) => [canonicalModelName(model), index] as const));
  // A model that reasons by default comes after every one that does not (its hidden reasoning can use the whole answer budget); within each kind, the cheapest first.
  const reasons = (model: ModelIdentifier): number => (reasonsByDefault(model) ? 1 : 0);
  const ranked = [...affordable].sort((left, right) => reasons(left) - reasons(right) || cost(left) - cost(right) || (walked.get(canonicalModelName(left)) ?? 0) - (walked.get(canonicalModelName(right)) ?? 0) || canonicalModelName(left).localeCompare(canonicalModelName(right)));
  const preferredOverCap = preferred !== undefined && affordable.length < suitable.length && suitable.some((model) => canonicalModelName(model) === canonicalModelName(preferred)) && !affordable.some((model) => canonicalModelName(model) === canonicalModelName(preferred));
  const wanted = preferred === undefined ? undefined : affordable.find((model) => canonicalModelName(model) === canonicalModelName(preferred));
  // A route is looked up by the model's canonical name, which drops an OpenRouter variant suffix (`:free`, `:batch`): a source that lists a model AND its unfit twin would answer with whichever entry comes first. So the
  // routes are asked of a routing whose OpenRouter sources hold the fit entries only (only OpenRouter has the twin names; filtering another source, a company endpoint, would break its qualification digest, which covers its whole model list).
  const fitOnly: RoutingDependencies = own.sources === undefined ? own : {
    ...own,
    sources: { read: async (org) => { const stored = await own.sources!.read(org); return { ...stored, sources: stored.sources.map((source) => (source.kind === "openrouter" ? { ...source, models: source.models.filter((entry) => !unfitForLearning(entry.catalog)) } : source)) }; } },
  };
  const seen = new Set<string>();
  for (const model of [...(wanted === undefined ? [] : [wanted]), ...ranked]) {
    const name = canonicalModelName(model);
    if (seen.has(name)) continue;
    seen.add(name);
    const route = (await servingRoutes(fitOnly, { orgId, project, model })).find((served) => served.alias !== undefined);
    if (route?.alias !== undefined) return { model, route: { ...route, alias: route.alias }, ...(preferredOverCap ? { preferredOverCap: true as const } : {}) };
  }
  return { none: "no_provider" };
}
