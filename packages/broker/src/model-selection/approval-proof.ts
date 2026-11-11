// Server-owned metadata on a published process version. This validates binding, not approval authority.
// Only the existing confirmation handler may create it after live approval checks and policy fences.
import {z} from "zod";
import { AgentIdSchema, ApprovalIdSchema, OrgIdSchema, ModelIdentifierSchema, canonicalModelName, recipeDigest, agentXError, type ResolvedRecipe, type AgentId } from "@rovara-code/contracts";
const Binding=z.object({orgId:OrgIdSchema,project:z.string().min(1).max(63),registeredAt:z.string().datetime(),agentId:AgentIdSchema,recipeDigest:z.string().regex(/^[a-f0-9]{64}$/u)}).strict();
const Proof=Binding.extend({version:z.literal(1),companyRevision:z.number().int().min(0),approvalId:ApprovalIdSchema,exceptions:z.array(z.object({stage:z.enum(["plan_check","code_review","security_review"]),model:ModelIdentifierSchema,referenceModel:ModelIdentifierSchema}).strict()).min(1).max(3)}).strict().superRefine((proof,ctx)=>{
 if(new Set(proof.exceptions.map(row=>row.stage)).size!==proof.exceptions.length) ctx.addIssue({code:"custom",path:["exceptions"],message:"duplicate stage"});
 for(const row of proof.exceptions) if(canonicalModelName(row.model)!==canonicalModelName(row.referenceModel)) ctx.addIssue({code:"custom",path:["exceptions"],message:"not a same-model exception"});
});
export const StageModelApprovalProofSchema=Proof;
export type StageModelApprovalProof=z.infer<typeof Proof>;
export type StageModelApprovalBinding=z.infer<typeof Binding>;
export function parseStageModelApprovalProof(raw:unknown,binding:StageModelApprovalBinding):StageModelApprovalProof {
 const parsed=Proof.safeParse(raw);
 if(!parsed.success || Object.entries(binding).some(([key,value])=>parsed.data[key as keyof StageModelApprovalBinding]!==value)) throw agentXError("CONFIG_INVALID","The model approval does not match this process version.");
 return parsed.data;
}

/** Publish stores the reviewed draft digest; only its own chain marker changes on numbering.
 * Base version pins and every content field stay in the digest. Use this at rollback/task proof checks. */
export function processApprovalRecipeDigest(recipe:ResolvedRecipe,agentId:AgentId):string {
 return recipeDigest({...recipe,chain:recipe.chain.map(layer=>layer.agentId===agentId?{...layer,version:"draft" as const}:layer)});
}
