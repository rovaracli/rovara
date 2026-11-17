// "AI for your agents" (DEC 240): Cloud's `/v1/app/org/agent-ai` routes. Company admins only. The reader is total over untrusted data: a
// field that is not the shape is dropped, and a body that is not an object is unreadable.
export const AGENT_AI_PATH = "/v1/app/org/agent-ai";
export const AGENT_AI_SOURCES = ["rovara", "anthropic_key", "bedrock_byo", "openai_key", "openrouter_key"] as const;
/** Listed on every Cloud; the own-key sources (DEC 254t) only when the server lists them (their kind is switched on). */
const ALWAYS_LISTED: readonly AgentAiSource[] = ["rovara", "anthropic_key", "bedrock_byo"];
export type AgentAiSource = typeof AGENT_AI_SOURCES[number];
export interface AgentAiRead {
 /** The saved choice; null when none is saved yet. */
 source: AgentAiSource | null;
 version: number;
 /** Which sources can be chosen now ("your own Bedrock" is coming soon). */
 available: Readonly<Record<AgentAiSource, boolean>>;
 /** Whether the company's own Anthropic key is connected; null when Cloud can't tell. */
 anthropicKeyConnected: boolean | null;
 /** The sources the server lists, in its order (DEC 254t: an own-key source only where its kind is switched on). */
 listed: readonly AgentAiSource[];
 /** Whether the company's own OpenAI / OpenRouter key is connected; null when Cloud can't tell or does not list the source. */
 openaiKeyConnected: boolean | null;
 openrouterKeyConnected: boolean | null;
}
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const whole = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const named = (v: unknown): v is AgentAiSource => AGENT_AI_SOURCES.some(s => s === v);
export function readAgentAi(body: unknown): AgentAiRead {
 if (!isRecord(body) || !whole(body["version"]) || !(body["source"] === null || named(body["source"]))) throw new Error("not agent AI settings");
 const choices = (Array.isArray(body["choices"]) ? body["choices"] : []).filter(isRecord);
 const available = Object.fromEntries(AGENT_AI_SOURCES.map(source => [source, choices.some(c => c["source"] === source && c["available"] === true)])) as Record<AgentAiSource, boolean>;
 const said = choices.map(c => c["source"]).filter(named);
 const listed = AGENT_AI_SOURCES.filter(source => ALWAYS_LISTED.includes(source) || said.includes(source));
 const flag = (v: unknown) => typeof v === "boolean" ? v : null;
 return { source: body["source"], version: body["version"], available, anthropicKeyConnected: flag(body["anthropicKeyConnected"]), listed, openaiKeyConnected: flag(body["openaiKeyConnected"]), openrouterKeyConnected: flag(body["openrouterKeyConnected"]) };
}
