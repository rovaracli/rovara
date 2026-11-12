// Convergence lane A3 (Cloud adapter, private): OpenRouter on Code's `model-provider` port, as Cloud runs it: Code's built-in row (address, sign-in, format: Code keeps a built-in id from
// pointing anywhere else, `assertBuiltinIdsKept`) plus Cloud's price table from its catalog, so a task budget can hold. The key is the install's OpenRouter key from the `model-keys` store
// (model-keys/secrets-manager.ts), read by the proxy per call; this adapter holds no key.
import { OPENROUTER_PROVIDER, assertBuiltinIdsKept } from "@rovara-code/broker";
import { assertModelProvider, type ModelProviderAdapter } from "@rovara-code/contracts";
import { cloudCatalogPrices } from "./catalog-prices.js";

export function cloudOpenRouterProvider(options: { models: readonly string[]; defaultModel?: string }): ModelProviderAdapter {
  const provider = assertModelProvider({
    ...OPENROUTER_PROVIDER,
    prices: cloudCatalogPrices("openrouter", options.models),
    ...(options.defaultModel === undefined ? {} : { defaultModel: options.defaultModel }),
  });
  assertBuiltinIdsKept(provider);
  return provider;
}
