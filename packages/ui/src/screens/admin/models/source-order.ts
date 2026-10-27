import { z } from "zod";
export const modelProvider = z.string().max(100).transform(value=>value==="amazon-bedrock"?"bedrock":value);
const catalog = z.object({provider:modelProvider,modelId:z.string().max(256)});
export const modelSourcesSnapshot = z.object({orgId:z.string().max(100).optional(),developerId:z.string().max(100).optional(),revision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),sources:z.array(z.object({sourceId:z.string().max(100),kind:z.enum(["anthropic","openai","openrouter","bedrock","endpoint"]),label:z.string().max(200),hasCredential:z.boolean(),inOrder:z.boolean(),models:z.array(z.object({catalog})).max(20)})).max(10),order:z.array(z.string().max(100)).max(12)});
export const sourceOrderId = z.union([z.literal("rovara"), z.literal("personal-chatgpt"), z.string().regex(/^src_[0-9a-z]{20}$/)]);
export const sourceOrderReceipt = z.object({ order: z.array(sourceOrderId).min(1).max(12), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) });
export function sourceOrderSnapshot(orgId: string, developerId: string) {
 return modelSourcesSnapshot.extend({ orgId: z.literal(orgId), developerId: z.literal(developerId), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER-1), order: z.array(sourceOrderId).min(1).max(12) }).superRefine((value, context) => {
  const known = new Set(["rovara", "personal-chatgpt", ...value.sources.map(s=>s.sourceId)]);
  if (new Set(value.order).size!==value.order.length || value.order.some(id=>!known.has(id))) context.addIssue({ code:"custom", message:"Source order is unavailable." });
 });
}
export type SourceOrderSnapshot = z.infer<ReturnType<typeof sourceOrderSnapshot>>;
export const sameSourceOrder = (a: readonly string[], b: readonly string[]) => a.length===b.length && a.every((id,index)=>id===b[index]);
