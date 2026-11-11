// Ruling R52 (with R21): every named environment calls its models through the model proxy, which serves the Claude models Amazon
// Bedrock offers through the region's inference profiles and nothing else. A worker, orchestrator or classifier on any other
// provider, or on a model the proxy does not serve, could only fail at its first request, so it fails here instead, before anything deploys.
import { agentXError } from "@rovara-code/contracts";
import { bedrockClaudeModelIds, proxyGeographyForRegion } from "@agentx/model-runtime/catalog";
import type { ModelsAnswers } from "./answer-schemas.js";

const ROLES = ["orchestrator", "classifier", "worker"] as const;

/** Throws CONFIG_INVALID, in plain words, when a role's model is one the environment's model proxy cannot serve. */
export function assertModelsServedByProxy(models: ModelsAnswers, region: string): void {
  let geography: ReturnType<typeof proxyGeographyForRegion>;
  try {
    geography = proxyGeographyForRegion(region);
  } catch (error) {
    throw agentXError("CONFIG_INVALID", error instanceof Error ? error.message : String(error));
  }
  const served = bedrockClaudeModelIds(geography);
  for (const role of ROLES) {
    const provider = models.providers?.[role] ?? "amazon-bedrock";
    if (provider !== "amazon-bedrock") {
      throw agentXError(
        "CONFIG_INVALID",
        `the ${role} model provider is ${provider}, but this install calls every model through its model proxy, which serves Claude models on Amazon Bedrock only; choose amazon-bedrock and a Claude model such as ${served[0] ?? `${geography}.anthropic.claude-sonnet-4-6`}`,
      );
    }
    if (!served.includes(models[role])) {
      throw agentXError(
        "CONFIG_INVALID",
        `the ${role} model ${models[role]} is not one the model proxy serves in ${region}; it serves the Claude models Amazon Bedrock offers through the ${geography}.* inference profiles, such as ${served[0] ?? `${geography}.anthropic.claude-sonnet-4-6`}`,
      );
    }
  }
}
