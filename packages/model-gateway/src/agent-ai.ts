// DEC 240: which AI each company's agents use. A company admin picks it in Cloud ("AI for your agents"); Cloud writes it to its
// Companies table (packages/cloud-server agent-ai-routes.ts) and the gateway reads it here, on every agent call:
//
//   rovara         Rovara's AI: Claude through Bedrock in Rovara's OWN AWS account (bedrock-transport.ts), charged to the company
//                  at list price on its bill (DEC 240b), under the one combined company cap.
//   anthropic_key  the company's own Anthropic key (DEC 236, company-key mode).
//   bedrock_byo    the company's own Bedrock (DEC 238): reserved, refused until it is built.
//
// No choice saved: company-key mode exactly as before (DEC 236). There is never an automatic fallback between sources.
import { BEDROCK_CONVERSE_ID } from "./bedrock-converse.js";
import { BEDROCK_CLAUDE_ID } from "./bedrock-transport.js";
import { GATEWAY_COMPANY_AGENT_AI } from "./deploy.js";
import type { Dynamo } from "./dynamo.js";
import { COMPANY, record } from "./model-gateway-token.js";
import type { ProviderTransport } from "./provider.js";

export const AGENT_AI_SOURCES = ["rovara", "anthropic_key", "bedrock_byo"] as const;
export type AgentAiSource = typeof AGENT_AI_SOURCES[number];

export interface AgentAiSourceReader {
  /** The company's saved choice, or undefined when it saved none. Throws when the choice can't be read or is not one of the sources. */
  sourceFor(cid: string, signal?: AbortSignal): Promise<AgentAiSource | undefined>;
}

/**
 * The choice from Cloud's Companies table: COMPANY#<org_…> / AGENT_AI, `{ companyId, source, version, ... }`. Strongly consistent,
 * so an admin's change applies to the very next call. Fail closed: another company's row or an unknown source throws (the agent
 * route answers 503 and holds and sends nothing).
 */
export class CompanyAgentAiSource implements AgentAiSourceReader {
  constructor(private readonly db: Dynamo, private readonly table: string) {}
  async sourceFor(cid: string, signal?: AbortSignal): Promise<AgentAiSource | undefined> {
    if (typeof cid !== "string" || !COMPANY.test(cid)) throw new Error("agent ai source unavailable");
    const item = await this.db.get(this.table, { pk: `${GATEWAY_COMPANY_AGENT_AI.partitionPrefix}${cid}`, sk: GATEWAY_COMPANY_AGENT_AI.sortKey }, { consistent: true, ...(signal === undefined ? {} : { signal }) });
    if (item === undefined) return undefined;
    const source = record(item)?.source;
    if (item.companyId !== cid || typeof source !== "string" || !(AGENT_AI_SOURCES as readonly string[]).includes(source)) throw new Error("agent ai source unavailable");
    return source as AgentAiSource;
  }
}

/** Rovara's AI as the agent route uses it. */
export interface RovaraAi {
  /** The agent's (Anthropic) model name to its Bedrock model or system inference profile id: the allow-list. Nothing else is called. */
  models: ReadonlyMap<string, string>;
  /** Companies the operator named as exempt from charges (the founders' test company, DEC 240b). Never inferred. */
  exempt: ReadonlySet<string>;
  /** Bedrock in Rovara's account (createBedrockTransport). */
  transport: ProviderTransport;
  /**
   * DEC 243c: a non-Claude model's own output limit (the price snapshot's Bedrock row). A call is held to at most this; unknown:
   * CONVERSE_DEFAULT_MAX_OUTPUT_TOKENS. Claude keeps the agent route's own limit.
   */
  maxOutputTokens?(id: string): number | undefined;
}

const AGENT_MODEL = /^claude-[a-z0-9-]{1,80}$/u;
/**
 * DEC 243c: the other Bedrock coding models Rovara's AI offers, through Converse, each named exactly by the id called. Each passed
 * an agent-loop test on fakes and one real tiny ConverseStream call with a tool (staging us-west-2, 2026-11-15: a tool call within
 * 16 tokens, stop tool_use; the streams are tests/fixtures/model-gateway-bedrock/converse). Priced and limited by the price
 * snapshot's Bedrock rows. Reasoning-first models (gpt-oss, DeepSeek V3.2, Kimi K2 Thinking / K3 / K3.1, MiniMax M2.5, Nova Pro)
 * wait for a longer test.
 */
export const ROVARA_AI_US_CONVERSE_MODELS = [
  "qwen.qwen3-coder-480b-a35b-v1:0=qwen.qwen3-coder-480b-a35b-v1:0",
  "qwen.qwen3-coder-30b-a3b-v1:0=qwen.qwen3-coder-30b-a3b-v1:0",
  "qwen.qwen3-235b-a22b-2507-v1:0=qwen.qwen3-235b-a22b-2507-v1:0",
  "mistral.devstral-2-123b=mistral.devstral-2-123b",
  "mistral.mistral-large-3-675b-instruct=mistral.mistral-large-3-675b-instruct",
  "deepseek.v3-v1:0=deepseek.v3-v1:0",
  "moonshotai.kimi-k2.5=moonshotai.kimi-k2.5",
  "zai.glm-5=zai.glm-5",
  "zai.glm-4.7=zai.glm-4.7",
  "us.amazon.nova-2-lite-v1:0=us.amazon.nova-2-lite-v1:0",
].join(",");
/**
 * DEC 243: Rovara's AI offers every Claude model Bedrock has in the account, each engine model name (Code's model catalog) on its
 * `us.` system inference profile (US cross-Region routing; data stays in the US). Deployed with `-c rovaraModelGatewayRovaraAi=on`.
 * Every one is priced by the AWS price list's Bedrock rows (normalised to the same name) and limited by its Anthropic row.
 * Haiku 4.5 and Haiku 5.5 work at once; Sonnet 5.5, Opus 5.5 and Fable 5.2 need the account's one-time Marketplace enable first
 * (until then a call is refused, free, as ROVARA_AI_MODEL_NOT_ENABLED).
 */
export const ROVARA_AI_US_MODELS = [
  "claude-haiku-4-5=us.anthropic.claude-haiku-4-5-20251001-v1:0",
  "claude-haiku-4-5-20251001=us.anthropic.claude-haiku-4-5-20251001-v1:0",
  "claude-haiku-5-5=us.anthropic.claude-haiku-5-5",
  "claude-sonnet-5-5=us.anthropic.claude-sonnet-5-5",
  "claude-opus-5-5=us.anthropic.claude-opus-5-5",
  "claude-fable-5-2=us.anthropic.claude-fable-5-2",
].join(",");
export const ROVARA_AI_MODELS_MAX = 20;
export const ROVARA_AI_EXEMPT_MAX = 10;
/** A region's inference-profile geographies (AWS system profile prefixes). `global.` is never one: global routing is off. */
function geographiesOf(region: string): readonly string[] {
  if (region.startsWith("us-gov-")) return ["us-gov"];
  const area = region.split("-")[0];
  return area === "us" ? ["us"] : area === "eu" ? ["eu"] : area === "ap" ? ["apac", "jp", "au"] : area === "ca" ? ["ca"] : [];
}

/**
 * GATEWAY_ROVARA_AI_MODELS: `<agent model>=<bedrock id>` pairs, comma-separated, e.g.
 * `claude-sonnet-5-5=us.anthropic.claude-sonnet-5-5`. Each id is a Claude system inference profile of the gateway's own Region's
 * geography (DEC 243: `us.` from a US Region). A plain model id, a `global.` profile or another geography's is refused. Throws on
 * anything else.
 */
export function parseRovaraAiModels(value: string, region: string): Map<string, string> {
  const models = new Map<string, string>();
  const geographies = geographiesOf(region);
  const pairs = value.split(",");
  if (value.trim() === "" || pairs.length > ROVARA_AI_MODELS_MAX) throw new Error("invalid rovara ai models");
  for (const pair of pairs) {
    const [name, id, extra] = pair.trim().split("=");
    if (name === undefined || id === undefined || extra !== undefined || models.has(name)) throw new Error("invalid rovara ai models");
    if (BEDROCK_CLAUDE_ID.test(id)) {
      // Claude: an engine model name, on a profile of this Region's geography only (DEC 243).
      if (!AGENT_MODEL.test(name) || !geographies.includes(id.slice(0, id.indexOf(".")))) throw new Error("invalid rovara ai models");
    } else if (BEDROCK_CONVERSE_ID.test(id)) {
      // Any other model (DEC 243c, through Converse): the engine names it exactly by the Bedrock id that is called (Code's model
      // catalog names Bedrock models so, profiles included): that model in this Region, or its profile of this Region's geography.
      const geo = id.split(".").length > 2 && /^(?:us|eu|apac|jp|au|ca)\./u.test(id) ? id.slice(0, id.indexOf(".")) : undefined;
      if (name !== id || (geo !== undefined && !geographies.includes(geo))) throw new Error("invalid rovara ai models");
    } else throw new Error("invalid rovara ai models");
    models.set(name, id);
  }
  return models;
}

/** GATEWAY_ROVARA_AI_EXEMPT: company ids, comma-separated (the operator's explicit list). Empty: none. Throws on anything else. */
export function parseRovaraAiExempt(value: string | undefined): Set<string> {
  if (value === undefined || value === "") return new Set();
  const ids = value.split(",").map((id) => id.trim());
  if (ids.length > ROVARA_AI_EXEMPT_MAX || ids.some((id) => !COMPANY.test(id)) || new Set(ids).size !== ids.length) throw new Error("invalid rovara ai exempt companies");
  return new Set(ids);
}
