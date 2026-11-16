// "AI for your agents" (DEC 240): Cloud's `/v1/app/org/agent-ai` routes. Company admins only. The reader is total over untrusted data: a
// field that is not the shape is dropped, and a body that is not an object is unreadable.
export const AGENT_AI_PATH = "/v1/app/org/agent-ai";
export const AGENT_AI_SOURCES = ["rovara", "anthropic_key", "bedrock_byo"] as const;
export type AgentAiSource = typeof AGENT_AI_SOURCES[number];
export interface AgentAiRead {
 /** The saved choice; null when none is saved yet. */
 source: AgentAiSource | null;
 version: number;
 /** Which sources can be chosen now ("your own Bedrock" is coming soon). */
 available: Readonly<Record<AgentAiSource, boolean>>;
 /** Whether the company's own Anthropic key is connected; null when Cloud can't tell. */
 anthropicKeyConnected: boolean | null;
}
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const whole = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const named = (v: unknown): v is AgentAiSource => AGENT_AI_SOURCES.some(s => s === v);
export function readAgentAi(body: unknown): AgentAiRead {
 if (!isRecord(body) || !whole(body["version"]) || !(body["source"] === null || named(body["source"]))) throw new Error("not agent AI settings");
 const choices = (Array.isArray(body["choices"]) ? body["choices"] : []).filter(isRecord);
 const available = Object.fromEntries(AGENT_AI_SOURCES.map(source => [source, choices.some(c => c["source"] === source && c["available"] === true)])) as Record<AgentAiSource, boolean>;
 return { source: body["source"], version: body["version"], available, anthropicKeyConnected: typeof body["anthropicKeyConnected"] === "boolean" ? body["anthropicKeyConnected"] : null };
}
