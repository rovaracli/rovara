// DEC 240: which AI each company's agents use. A company admin picks it in Cloud ("AI for your agents"); Cloud writes it to its
// Companies table (packages/cloud-server agent-ai-routes.ts) and the gateway reads it here, on every agent call:
//
//   rovara         Rovara's AI: Claude through Bedrock in Rovara's OWN AWS account (bedrock-transport.ts), charged to the company
//                  at list price on its bill (DEC 240b), under the one combined company cap.
//   anthropic_key  the company's own Anthropic key (DEC 236, company-key mode).
//   bedrock_byo    the company's own Bedrock (DEC 238): its own invoke-only role, assumed as the company (ByoBedrock below).
//
// No choice saved: company-key mode exactly as before (DEC 236). There is never an automatic fallback between sources.
import { BEDROCK_CONVERSE_ID } from "./bedrock-converse.js";
import type { CredentialSource } from "./aws.js";
import { geographiesOf, parseBedrockConnect, type BedrockConnection } from "./bedrock-byo.js";
import type { BedrockSessionSource } from "./bedrock-byo-sessions.js";
import { BEDROCK_CLAUDE_ID, createBedrockTransport } from "./bedrock-transport.js";
import { GATEWAY_COMPANY_AGENT_AI } from "./deploy.js";
import type { Dynamo } from "./dynamo.js";
import { COMPANY, record } from "./model-gateway-token.js";
import type { ProviderTransport } from "./provider.js";
import { PRODUCT_DEFAULT_CAPS, type ProductKeyStore } from "./product-keys.js";
import type { ProductKeyRow } from "./product-seal.js";

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
 * snapshot's Bedrock rows. gpt-oss 120B / 20B and Nova Pro passed with maxTokens 256 (they reason first; tests/fixtures/
 * model-gateway-bedrock/converse-256): gpt-oss's reasoning is dropped (OpenAI only recommends passing it back after tool calls),
 * and Nova Pro's leading "<thinking>...</thinking>" text is left out (LEADING_THINKING_TEXT_MODEL). Kimi K2 Thinking, MiniMax M2.5,
 * Kimi K3 and Kimi K3.1 need their reasoning sent back on later tool turns; the gateway carries it both ways
 * (REASONING_CARRYOVER_MODEL in bedrock-converse.ts) and each passed the owner's real two-turn call (2026-11-16,
 * scripts/bedrock-reasoning-two-turn.ts; answers in tests/fixtures/model-gateway-bedrock/two-turn-real). Not listed: DeepSeek V3.2.
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
  "openai.gpt-oss-120b-1:0=openai.gpt-oss-120b-1:0",
  "openai.gpt-oss-20b-1:0=openai.gpt-oss-20b-1:0",
  "us.amazon.nova-pro-v1:0=us.amazon.nova-pro-v1:0",
  "moonshot.kimi-k2-thinking=moonshot.kimi-k2-thinking",
  "minimax.minimax-m2.5=minimax.minimax-m2.5",
  "us.moonshotai.kimi-k3=us.moonshotai.kimi-k3",
  "us.moonshotai.kimi-k3.1=us.moonshotai.kimi-k3.1",
  // deepseek.v3.2 stays unlisted: in the real two-turn call (2026-11-16) turn 1 ended end_turn with no tool call and no thinking.
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
export const ROVARA_AI_MODELS_MAX = 24;
export const ROVARA_AI_EXEMPT_MAX = 10;

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

/**
 * DEC 238: the company's OWN Bedrock as its agents' source (`bedrock_byo`). The connection is the company's one sealed `bedrock`
 * source (product-keys.ts companyBedrock), opened only for the verified company; the call is signed with the customer's role,
 * assumed as that company (bedrock-byo-sessions.ts). Bedrock bills the customer; the gateway meters at list price under the one
 * combined company cap and writes no billable line.
 */
export interface ByoBedrock {
  /** The company's connection, or undefined when none is connected. Throws when it can't be read (the route answers 503). */
  connection(iss: string, cid: string, signal?: AbortSignal): Promise<{ row: ProductKeyRow; connection: BedrockConnection } | undefined>;
  sessions: BedrockSessionSource;
  /** The Bedrock transport for the connection's Region, signing with `credentials` (bedrock-transport.ts). */
  transport(region: string, credentials: CredentialSource): ProviderTransport;
  /** AWS refused the role or a model: shown on the settings page. Never changes the call; never throws. */
  refused?(iss: string, cid: string, row: ProductKeyRow): Promise<void>;
}
/** The deployed ByoBedrock: the product key store's company source, the sessions, and the fixed Bedrock transport. */
export function storedBedrock(store: Pick<ProductKeyStore, "companyBedrock" | "useKey" | "recordWarning">, sessions: BedrockSessionSource, transport: (region: string, credentials: CredentialSource) => ProviderTransport = (region, credentials) => createBedrockTransport({ region, credentials })): ByoBedrock {
  return {
    async connection(iss, cid) {
      const source = await store.companyBedrock(iss, cid);
      if (source === undefined) return undefined;
      const text = await store.useKey(iss, cid, source);
      // Removed between the two reads: not connected.
      if (text === undefined) return undefined;
      const connection = parseBedrockConnect(text);
      if (connection === undefined) throw new Error("bedrock connection unreadable");
      return { row: { iss, cid, owner: source.owner, sourceId: source.sourceId, versionId: source.versionId }, connection };
    },
    sessions, transport,
    async refused(iss, cid, row) {
      try { await store.recordWarning(iss, cid, { sourceId: row.sourceId, owner: row.owner, provider: "bedrock", caps: { ...PRODUCT_DEFAULT_CAPS }, versionId: row.versionId }, 403); } catch { /* A warning never changes a call. */ }
    },
  };
}
