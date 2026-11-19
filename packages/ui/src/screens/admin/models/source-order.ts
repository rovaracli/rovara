// Model sources (DEC 254zzz84(4)): the company's provider order for its agents' AI, as Cloud's GET /org/model-sources answers it (cloud-server
// model-sources-routes.ts). The first source is the company's first choice; the rest are tried in order when it can't take a call.
import { z } from "zod";
export const modelProvider = z.string().max(100).transform(value=>value==="amazon-bedrock"?"bedrock":value);
export const HOSTED_SOURCE_IDS = ["rovara", "anthropic_key", "bedrock_byo", "openai_key", "openrouter_key", "custom_endpoint"] as const;
export const sourceOrderId = z.enum(HOSTED_SOURCE_IDS);
export type SourceOrderId = z.infer<typeof sourceOrderId>;
const SOURCE_LABELS: Readonly<Record<SourceOrderId, string>> = { rovara: "Rovara's AI", anthropic_key: "Your Anthropic key", bedrock_byo: "Your Bedrock", openai_key: "Your OpenAI key", openrouter_key: "Your OpenRouter key", custom_endpoint: "Your own endpoint" };
/** A source's readable name; anything else is "Unknown source" (never the raw text). */
export const sourceLabel = (id: string): string => (Object.hasOwn(SOURCE_LABELS, id) ? SOURCE_LABELS[id as SourceOrderId] : "Unknown source");
const MAX = HOSTED_SOURCE_IDS.length;
export const modelSourcesSnapshot = z.object({
 orgId: z.string().max(100).optional(), developerId: z.string().max(100).optional(), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(), canChange: z.boolean().optional(),
 order: z.array(sourceOrderId).max(MAX),
 sources: z.array(z.object({ source: sourceOrderId, available: z.boolean(), connected: z.boolean().nullable(), inOrder: z.boolean() })).max(MAX),
});
export const sourceOrderReceipt = z.object({ order: z.array(sourceOrderId).min(1).max(MAX), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) });
export function sourceOrderSnapshot(orgId: string, developerId: string) {
 return modelSourcesSnapshot.extend({ orgId: z.literal(orgId), developerId: z.literal(developerId), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER-1) }).superRefine((value, context) => {
  const known = new Set(value.sources.map(s=>s.source));
  if (new Set(value.order).size!==value.order.length || value.order.some(id=>!known.has(id)) || new Set(value.sources.map(s=>s.source)).size!==value.sources.length) context.addIssue({ code:"custom", message:"Source order is unavailable." });
 });
}
export type SourceOrderSnapshot = z.infer<ReturnType<typeof sourceOrderSnapshot>>;
export const sameSourceOrder = (a: readonly string[], b: readonly string[]) => a.length===b.length && a.every((id,index)=>id===b[index]);
