// Convergence lane A3 (Cloud adapter, private): a `model-provider` price table from Cloud's own model catalog (`listPricesPerMillion`, USD per million tokens), in the port's micro-dollar form.
// A model the catalog does not price is left out (its calls are unpriced and a task budget cannot be held, the port's rule); a model with a zero price is left out unless every price is zero
// (then it is marked free), because a zero price would let a budget pass any call.
import type { ModelProviderModelPrice, ModelProviderPrices } from "@rovara-code/contracts";
import { listPricesPerMillion } from "@agentx/model-runtime/catalog";

const micros = (dollars: number): number => Math.round(dollars * 1_000_000);

export function cloudCatalogPrices(provider: string, modelIds: readonly string[]): ModelProviderPrices {
  const models: Record<string, ModelProviderModelPrice> = {};
  for (const modelId of modelIds) {
    const price = listPricesPerMillion({ provider, modelId });
    if (price === undefined) continue;
    const row = { inputMicrosPerMillionTokens: micros(price.input), outputMicrosPerMillionTokens: micros(price.output), cacheReadMicrosPerMillionTokens: micros(price.cacheRead), cacheWriteMicrosPerMillionTokens: micros(price.cacheWrite) };
    const all = Object.values(row);
    if (all.every((value) => value === 0)) models[modelId] = { ...row, free: true };
    else if (row.inputMicrosPerMillionTokens > 0 && row.outputMicrosPerMillionTokens > 0) models[modelId] = row;
  }
  return { currency: "USD", models };
}
