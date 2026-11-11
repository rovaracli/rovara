// Runtime approval authority comes from the task snapshot, never a fresh agent version or caller flag.
import { canonicalModelName, agentXError, type OrgId, type AgentId, type ResolvedRecipe, type StageId, type ModelIdentifier } from "@rovara-code/contracts";
import {parseTaskModelPolicyPin} from "./task-pin.js";
import {parseStageModelApprovalProof,processApprovalRecipeDigest} from "./approval-proof.js";
export interface PinnedTaskModelApprovalInput {orgId:OrgId;project:string;registeredAt:string;agentId:AgentId;recipe:ResolvedRecipe;digest:string;pin:unknown;stage:StageId;model:ModelIdentifier;referenceModel:ModelIdentifier}
/** Returns only the tuple the single resolver may consider. It does not waive live source, denial,
 * project-approved, forbidden-model, or cross-company rules; those remain in resolveStageModel. */
export function pinnedTaskModelApproval(input:PinnedTaskModelApprovalInput):{model:ModelIdentifier;referenceModel:ModelIdentifier}|undefined {
 const pin=parseTaskModelPolicyPin(input.pin,{orgId:input.orgId,project:input.project,agentId:input.agentId,recipe:input.recipe,digest:input.digest});
 if(pin.registeredAt!==input.registeredAt) throw agentXError("RUNTIME_UNAVAILABLE","The task's project identity no longer matches its model policy.");
 if(pin.approvalProof===undefined) return undefined;
 const proof=parseStageModelApprovalProof(pin.approvalProof,{orgId:input.orgId,project:input.project,registeredAt:input.registeredAt,agentId:input.agentId,recipeDigest:processApprovalRecipeDigest(input.recipe,input.agentId)});
 if(proof.companyRevision!==pin.policy.revision) return undefined;
 const same=(a:ModelIdentifier,b:ModelIdentifier)=>canonicalModelName(a)===canonicalModelName(b);
 const tuple=proof.exceptions.find(row=>row.stage===input.stage&&same(row.model,input.model)&&same(row.referenceModel,input.referenceModel));
 return tuple===undefined?undefined:{model:tuple.model,referenceModel:tuple.referenceModel};
}
