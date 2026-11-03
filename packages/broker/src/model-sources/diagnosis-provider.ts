// Fix with agent (diagnosis) runs on the company's own AI provider and the company pays for it (owner decision 2026-11-03, replacing the Rovara-paid design: DG-3).
//
// This file is the one place that says WHICH provider a diagnosis may use, so the check at the start ("is it offered?") and the choice at the key ("which model, which route?") cannot disagree:
//   - Any source the project walks that is billed to the company: its own sources (Bedrock, Anthropic, OpenAI, OpenRouter, an approved endpoint) AND Rovara's metered built-in AI (the `rovara` source). Owner
//     decision 2026-11-03: the metered source counts, because it is billed to the company or project exactly as its tasks are. It is reached only through the ordinary admitted, budget-capped, ledger-tagged
//     chat-turn key in the requester's name (model-access.ts); there is no Rovara-paid key and no support team any more, so no path makes Rovara the payer.
// A person's ChatGPT plan is never used: a diagnosis turn has no person's plan behind it and a route without an alias cannot carry a key.
// With no such source the answer is "none", and the diagnosis is not offered (`DIAGNOSIS_NO_PROVIDER_MESSAGE`). Nothing here falls back to anything else.
import { canonicalModelName, type ModelIdentifier, type OrgId } from "@agentx/contracts";
import { listPricesPerMillion } from "@agentx/model-runtime/catalog";
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
