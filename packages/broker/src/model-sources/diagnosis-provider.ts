// Fix with agent (diagnosis) runs on the company's own AI provider and the company pays for it (owner decision 2026-11-03, replacing the Rovara-paid design: DG-3).
//
// This file is the one place that says WHICH provider a diagnosis may use, so the check at the start ("is it offered?") and the choice at the key ("which model, which route?") cannot disagree:
//   - Public (Rovara Cloud): only the company's OWN sources (Bedrock, Anthropic, OpenAI, OpenRouter, an approved endpoint) the project walks. Rovara's own AI source is left out: it is not
//     "the provider the company connected", and a diagnosis never runs on it.
//   - Enterprise (the install is in the company's own AWS account): the install's own Bedrock (the `rovara` source of that install) is the company's provider, as it is for every task there.
// A person's ChatGPT plan is never used: a diagnosis turn has no person's plan behind it and a route without an alias cannot carry a key.
// With no such source the answer is "none", and the diagnosis is not offered (`DIAGNOSIS_NO_PROVIDER_MESSAGE`). Nothing here falls back to anything else.
import { canonicalModelName, type ModelIdentifier, type OrgId } from "@agentx/contracts";
import { listPricesPerMillion } from "@agentx/model-runtime/catalog";
import { effectiveSources, servableModels, servingRoutes, type ModelRoute, type RoutingDependencies } from "./routing.js";

const isCompanySource = (id: string): boolean => id !== "rovara" && id !== "personal-chatgpt";

/** The routing a diagnosis may use: the project's walk without Rovara's own AI (Public), and never a person's ChatGPT plan. Absent where the install has no model proxy: nothing can then be shown to be the company's. */
export function customerProviderRouting(deps: RoutingDependencies): RoutingDependencies | undefined {
  const { sources, projectSourceOrder } = deps;
  if (sources === undefined) return undefined;
  const enterprise = deps.edition?.edition === "enterprise";
  const allowed = (id: string): boolean => id !== "personal-chatgpt" && (enterprise || isCompanySource(id));
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
 * The model and route a diagnosis turn runs on, or undefined when the company has no usable provider for the project. The company's assistant model when a source serves it, then the models in `preferred`
 * (the chat service's configured one), then the cheapest model a usable source serves. A model the company forbids is never chosen.
 */
export async function chooseDiagnosisRoute(
  deps: RoutingDependencies, orgId: OrgId, project: string, forbidden: (model: ModelIdentifier) => boolean, preferred: ReadonlyArray<ModelIdentifier | undefined> = [],
): Promise<{ model: ModelIdentifier; route: ModelRoute & { alias: string } } | undefined> {
  const own = customerProviderRouting(deps);
  if (own === undefined) return undefined;
  const effective = await effectiveSources(own, orgId, project);
  if (effective === undefined || effective.order.length === 0) return undefined;
  const candidates = [effective.stored.assistantModel, ...preferred, ...cheapestFirst(await servableModels(own, orgId, project))];
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
