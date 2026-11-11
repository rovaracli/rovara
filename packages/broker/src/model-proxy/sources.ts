// How a company source becomes LiteLLM models (Plan 3 Task 25). Pure: no network, no secret. The key itself never appears here;
// a model carries only the name of the credential the proxy stored it under (docs/learnings/model-sources-spike.md, question 3).
import { agentXError, sourceAlias, type ModelIdentifier, type ModelSource, type OrgId } from "@rovara-code/contracts";
import { endpointQualified } from "../model-sources/endpoint-digest.js";

/** List prices in USD per million tokens, as Pi's catalog records them. */
export interface ListPrices {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type PriceLookup = (model: ModelIdentifier) => ListPrices | undefined;

export interface ProxyModel {
  model_name: string;
  litellm_params: Record<string, unknown>;
  model_info: Record<string, unknown>;
}

/** The name of the proxy credential that holds a source's key. Unique per org and source, and not secret. */
export function credentialNameOf(orgId: OrgId, sourceId: string): string {
  return `${orgId}.${sourceId}`;
}

/** The prefix every alias of one source starts with (`sourceAlias` is `<orgId>.<sourceId>.<model>`). */
export function sourceAliasPrefix(orgId: OrgId, sourceId: string): string {
  return `${orgId}.${sourceId}.`;
}

const PER_MILLION = 1_000_000;

function providerModel(source: ModelSource, entry: ModelSource["models"][number]): string {
  switch (source.kind) {
    case "anthropic": return `anthropic/${(entry).catalog.modelId}`;
    case "openai": return `openai/${(entry).catalog.modelId}`;
    case "openrouter": return `openrouter/${(entry).catalog.modelId}`;
    case "bedrock": return `bedrock/${(entry).catalog.modelId}`;
    case "endpoint": return `${source.api === "anthropic-messages" ? "anthropic" : "openai"}/${(entry as { name: string }).name}`;
  }
}

/** Whether the source needs a stored key: Bedrock uses a role, and an endpoint may need no key at all. */
export function sourceUsesKey(source: ModelSource): boolean {
  return source.kind === "anthropic" || source.kind === "openai" || source.kind === "openrouter";
}

/**
 * One proxy model per source model. `model_name` is the org-scoped alias, `ssl_verify` is on, prices are Pi's list prices (a
 * source with a model the catalog cannot price is refused: spend would be unknown), and `model_info.rovara_org` lets the
 * proxy-side audit tie a model to its org.
 */
export function proxyModelsOf(orgId: OrgId, source: ModelSource, credentialName: string | undefined, prices: PriceLookup): ProxyModel[] {
  return source.models.map((entry) => {
    const catalog = entry.catalog;
    const listed = prices(catalog);
    if (listed === undefined) throw agentXError("CONFIG_INVALID", `${catalog.modelId} has no list price, so its spend could not be counted`);
    const input = listed.input / PER_MILLION;
    const output = listed.output / PER_MILLION;
    const params: Record<string, unknown> = {
      model: providerModel(source, entry),
      ssl_verify: true,
      input_cost_per_token: input,
      output_cost_per_token: output,
      ...(listed.cacheRead > 0 ? { cache_read_input_token_cost: listed.cacheRead / PER_MILLION } : {}),
      ...(listed.cacheWrite > 0 ? { cache_creation_input_token_cost: listed.cacheWrite / PER_MILLION } : {}),
    };
    const info: Record<string, unknown> = {
      rovara_org: orgId,
      rovara_source: source.sourceId,
      input_cost_per_token: input,
      output_cost_per_token: output,
    };
    if (credentialName !== undefined) { params.litellm_credential_name = credentialName; }
    if (source.kind === "bedrock") {
      params.aws_region_name = source.region;
      params.aws_role_name = source.roleArn;
      params.aws_session_name = `rovara-${orgId}`;
      params.aws_external_id = source.externalId;
      // The probe reads these back from the proxy: the role to assume is not secret.
      info.rovara_role_arn = source.roleArn;
      // Until the probe has passed no team may call the role's models; the registry reads this back to keep them out of every team.
      info.rovara_tested = source.tested;
    }
    if (source.kind === "endpoint") {
      params.api_base = source.baseUrl;
      // LiteLLM does not know a custom model's capabilities, and refuses a reasoning request for it otherwise (spike, question 4).
      info.supports_reasoning = true;
      // N8: like a Bedrock role until its probe passes, an endpoint's models exist for the probe but no team may call them until a check passed for exactly these
      // settings. The registry reads both back from the proxy: a missing flag is "not served".
      info.rovara_kind = "endpoint";
      info.rovara_api = source.api;
      info.rovara_tested = endpointQualified(source);
    }
    return { model_name: sourceAlias(orgId, source.sourceId, catalog), litellm_params: params, model_info: info };
  });
}
