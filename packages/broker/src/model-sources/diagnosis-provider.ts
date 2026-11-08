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
import { isFreeVariant } from "../rovara-code/second-review-picker.js";
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
export type LearningRouteNone = "no_provider" | "all_models_forbidden" | "no_suitable_model";
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

/**
 * A model learning must never run on, however cheap it looks: one whose catalog list price is zero or negative (a free tier, or a router whose spend the ledger would count at $0 while the provider bills the
 * company), an OpenRouter router meta-model, and a `:free` variant (the provider may train on the text sent to it). Used to rank, and to refuse the company's "lessons model" setting.
 */
export function unfitForLearning(model: ModelIdentifier): boolean {
  if (isFreeVariant(model) || isRouterModel(model)) return true;
  const price = listPricesPerMillion(model);
  return price !== undefined && !(price.input > 0 && price.output > 0);
}

/** A reasoning model that spends its output budget on hidden reasoning unless told not to (OpenAI's families, on their own transports). Anthropic models list `reasoning: true` too, but think only when asked. */
export function reasonsByDefault(model: ModelIdentifier): boolean {
  const known = catalogModel(model);
  return known !== undefined && known.reasoning === true && (known.api === "openai-responses" || known.api === "openai-completions");
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
 * never chosen. `preferred` is the company's "lessons model" setting: it wins when it is still served, allowed and suitable, and is ignored (the cheapest is used) when it is not.
 */
export async function chooseLearningRoute(
  deps: RoutingDependencies, orgId: OrgId, project: string, forbidden: (model: ModelIdentifier) => boolean, shape: LearningCallShape, preferred?: ModelIdentifier,
): Promise<{ model: ModelIdentifier; route: ModelRoute & { alias: string } } | { none: LearningRouteNone }> {
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
  const cost = (model: ModelIdentifier): number => learningWorstCaseUsd(model, shape) ?? Number.POSITIVE_INFINITY;
  const walked = new Map(suitable.map((model, index) => [canonicalModelName(model), index] as const));
  // A model that reasons by default comes after every one that does not (its hidden reasoning can use the whole answer budget); within each kind, the cheapest first.
  const reasons = (model: ModelIdentifier): number => (reasonsByDefault(model) ? 1 : 0);
  const ranked = [...suitable].sort((left, right) => reasons(left) - reasons(right) || cost(left) - cost(right) || (walked.get(canonicalModelName(left)) ?? 0) - (walked.get(canonicalModelName(right)) ?? 0) || canonicalModelName(left).localeCompare(canonicalModelName(right)));
  const wanted = preferred === undefined ? undefined : suitable.find((model) => canonicalModelName(model) === canonicalModelName(preferred));
  const seen = new Set<string>();
  for (const model of [...(wanted === undefined ? [] : [wanted]), ...ranked]) {
    const name = canonicalModelName(model);
    if (seen.has(name)) continue;
    seen.add(name);
    const route = (await servingRoutes(own, { orgId, project, model })).find((served) => served.alias !== undefined);
    if (route?.alias !== undefined) return { model, route: { ...route, alias: route.alias } };
  }
  return { none: "no_provider" };
}
