import type { Api, Model } from "@earendil-works/pi-ai";
import { amazonBedrockProvider } from "@earendil-works/pi-ai/providers/amazon-bedrock";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { ModelIdentifier } from "@agentx/contracts";

let catalogs: Map<string, ReadonlyMap<string, Model<Api>>> | undefined;

/** A Bedrock cross-region inference profile names its model with a geography prefix the catalog omits. */
const INFERENCE_PROFILE = /^(?:us|eu|apac|jp|au|ca|us-gov|global)\./;

/** The installed Pi catalogs' entry for a model, which the runtime resolves models from; undefined when neither knows it. */
export function catalogModel(model: ModelIdentifier): Model<Api> | undefined {
  catalogs ??= new Map([
    ["openrouter", new Map(openrouterProvider().getModels().map((entry) => [entry.id, entry as Model<Api>]))],
    ["amazon-bedrock", new Map(amazonBedrockProvider().getModels().map((entry) => [entry.id, entry as Model<Api>]))],
    ["anthropic", new Map(anthropicProvider().getModels().map((entry) => [entry.id, entry as Model<Api>]))],
    ["openai", new Map(openaiProvider().getModels().map((entry) => [entry.id, entry as Model<Api>]))],
  ]);
  return catalogs.get(model.provider)?.get(model.modelId);
}

/** List prices in USD per million tokens, as the catalog records them; undefined for a model it does not know. */
export function listPricesPerMillion(model: ModelIdentifier): { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined {
  // A Bedrock inference profile is billed at its model's prices.
  const known = catalogModel(model)
    ?? (model.provider === "amazon-bedrock" ? catalogModel({ provider: model.provider, modelId: model.modelId.replace(INFERENCE_PROFILE, "") }) : undefined);
  if (known === undefined) return undefined;
  const { input, output, cacheRead, cacheWrite } = known.cost;
  return { input, output, cacheRead, cacheWrite };
}

/**
 * Claude models Amazon Bedrock serves through a geography's inference profiles (ids like
 * us.anthropic.claude-sonnet-4-6), as the installed Pi catalog names them. The model proxy serves
 * exactly these, because Pi sends the catalog id as the request model.
 */
export function bedrockClaudeModelIds(geography = "us"): string[] {
  const prefix = `${geography}.anthropic.claude-`;
  return amazonBedrockProvider().getModels().map((entry) => entry.id).filter((id) => id.startsWith(prefix)).sort();
}

/** The Bedrock inference-profile geographies the model proxy can serve (ruling R52). */
export type ProxyGeography = "us" | "eu" | "apac";

/**
 * The geography whose inference profiles an install in this region calls: us-* is "us", eu-* is "eu", ap-* is "apac" (ruling R52).
 * Any other region has no profile the proxy knows, so it is refused here, naming the region.
 */
export function proxyGeographyForRegion(region: string): ProxyGeography {
  if (region.startsWith("us-")) return "us";
  if (region.startsWith("eu-")) return "eu";
  if (region.startsWith("ap-")) return "apac";
  throw new Error(`the model proxy has no Amazon Bedrock inference profile for region ${region}; install in a us-*, eu-* or ap-* region`);
}

/** The geography a Bedrock model id names (us.anthropic.claude-...), or undefined for an id with none the proxy serves. */
export function proxyGeographyOfModelId(modelId: string): ProxyGeography | undefined {
  const prefix = /^(us|eu|apac)\./.exec(modelId)?.[1];
  return prefix === "us" || prefix === "eu" || prefix === "apac" ? prefix : undefined;
}
