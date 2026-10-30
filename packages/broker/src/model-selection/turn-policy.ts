import {ProcessModelRefusal} from "./process-refusal.js";
import {mergeProcessModelAuthorityChecks} from "./authority.js";
import {z} from "zod";
// Ordinary project turns share the task resolver, but freeze policy on their operation.
import {STAGE_OPERATION_MAPPING,canonicalModelName,AgentIdSchema,ResolvedRecipeSchema,builtinRecipe,recipeDigest,ROVARA_CODE_AGENT_ID,agentXError,type StageId,type OrgId,type ModelIdentifier,type AgentId,type ResolvedRecipe} from "@agentx/contracts";
import {resolveAgent,type AgentStore} from "../agents/store.js";
import {loadStageModelSnapshot} from "./snapshot.js";
import {prepareTaskModelPolicyPin,taskModelPolicyAdmissionChecks,parseTaskModelPolicyPin,type TaskModelPolicyPin} from "./task-pin.js";
import {loadPinnedTaskStageContext,type TaskStageLiveDependencies} from "./task-live.js";
export interface TurnModelPin {version:1;workflowMode?:string;actorDeveloperId:string;payerDeveloperId?:string;agentId:AgentId;recipe:ResolvedRecipe;digest:string;pin:TaskModelPolicyPin}
const unavailable=()=>agentXError("RUNTIME_UNAVAILABLE","The project's model policy could not be pinned. Reload and try again.");
export function turnStagesForMode(mode:string) {
 if(!Object.hasOwn(STAGE_OPERATION_MAPPING,mode))throw agentXError("WORKFLOW_MODE_UNMAPPED","This workflow mode has no governed model stage.");
 const mapping=STAGE_OPERATION_MAPPING[mode as keyof typeof STAGE_OPERATION_MAPPING];
 if(mapping.stages.length===0)throw agentXError("WORKFLOW_MODE_UNMAPPED","This workflow mode does not invoke a model.");
 return mapping;
}
export async function prepareTurnModelPolicy(deps:TaskStageLiveDependencies&{store:AgentStore|undefined},input:{orgId:OrgId;project:string;actorDeveloperId:string;workflowMode:string;priorModels?:Partial<Record<StageId,ModelIdentifier>>;payerDeveloperId?:string;defaultPreferred?:ModelIdentifier}) {
 const mapping=turnStagesForMode(input.workflowMode);
 const caller={orgId:input.orgId,developerId:input.actorDeveloperId};
 const snapshot=await loadStageModelSnapshot(deps,caller,input.project);
 const agentId=snapshot.process.agentId,version=snapshot.process.version;
 if(version===undefined)throw unavailable();
 const recipe=agentId===ROVARA_CODE_AGENT_ID?(deps.store?.builtinRecipe(agentId,version)??builtinRecipe(agentId,version)):deps.store===undefined?undefined:await resolveAgent(deps.store,input.orgId,agentId,version);
 if(recipe===undefined||recipeDigest(recipe)!==snapshot.process.digest)throw unavailable();
 const stored=agentId===ROVARA_CODE_AGENT_ID?undefined:await deps.store?.getVersion(input.orgId,agentId,version);
 const overlay=stored?.overlay;
 const digest=recipeDigest(recipe);
 const pin=await prepareTaskModelPolicyPin({...deps,modelRouting:deps.routing},{orgId:input.orgId,project:input.project,agentId,recipe,digest,projectRevision:snapshot.projectRevision,...(overlay===undefined?{}:{projectOverlay:overlay}),...(stored?.modelApproval===undefined?{}:{approvalProof:stored.modelApproval})});
 if(pin.policy.revision!==snapshot.companyRevision||snapshot.stages.some(row=>row.sourcesRevision!==pin.sourcesRevision))throw unavailable();
 const contexts=await Promise.all(mapping.stages.map(stage=>loadPinnedTaskStageContext(deps,{orgId:input.orgId,project:input.project,agentId,recipe,digest,pin,stage,priorModels:input.priorModels??{},deniedModels:[],...(input.payerDeveloperId===undefined?{}:{payerDeveloperId:input.payerDeveloperId}),...(input.defaultPreferred===undefined?{}:{defaultPreferred:input.defaultPreferred})})));
 const context=contexts[0];if(context===undefined)throw unavailable();
 for(const value of contexts) {
  if(value.sourcesRevision!==pin.sourcesRevision)throw unavailable();
  if(value.decision.kind==="refusal") {
   if(value.stage==="build")throw agentXError("MODEL_NOT_ALLOWED","The project's Build model is unavailable. Check How we work.");
   throw new ProcessModelRefusal(value.decision.code,value.stage,["MODEL_NOT_VERIFIED","MODEL_STALE","NO_VERIFIED_CANDIDATE"].includes(value.decision.code)?"/app/admin/models/sources":"/app/admin/how-we-work");
  }
 }
 if(context.decision.kind!=="resolved")throw unavailable();
 const decision=context.decision;
 if(contexts.some(value=>value.decision.kind!=="resolved"||canonicalModelName(value.decision.model)!==canonicalModelName(decision.model)||value.decision.sourceId!==decision.sourceId||value.decision.thinkingLevel!==decision.thinkingLevel))throw unavailable();
 const policyChecks=taskModelPolicyAdmissionChecks(deps.tableName,pin);
 const checks=mergeProcessModelAuthorityChecks([contexts.flatMap(value=>value.checks).filter(item=>!policyChecks.some(other=>JSON.stringify(other.ConditionCheck?.Key)===JSON.stringify(item.ConditionCheck?.Key))),policyChecks]);
 const frozen:TurnModelPin={version:1,workflowMode:input.workflowMode,actorDeveloperId:input.actorDeveloperId,agentId,recipe,digest,pin,...(input.payerDeveloperId===undefined?{}:{payerDeveloperId:input.payerDeveloperId})};
 return {frozen,checks,stepName:mapping.stepKind,decision:context.decision,binding:{version:1 as const,stage:context.stage,companyRevision:pin.policy.revision,recipeDigest:digest},model:{...context.decision.model,...(context.decision.thinkingLevel===null?{}:{thinkingLevel:context.decision.thinkingLevel})}};
}

const TurnPin=z.object({version:z.literal(1),workflowMode:z.string().optional(),actorDeveloperId:z.string().regex(/^[a-f0-9]{64}$/u),payerDeveloperId:z.string().regex(/^[a-f0-9]{64}$/u).optional(),agentId:AgentIdSchema,recipe:ResolvedRecipeSchema,digest:z.string().regex(/^[a-f0-9]{64}$/u),pin:z.unknown()}).strict();
export function parseTurnModelPin(raw:unknown,orgId:OrgId,project:string):TurnModelPin {
 const value=TurnPin.safeParse(raw);if(!value.success)throw unavailable();
 const pin=parseTaskModelPolicyPin(value.data.pin,{orgId,project,agentId:value.data.agentId,recipe:value.data.recipe,digest:value.data.digest});
 return {version:1,...(value.data.workflowMode===undefined?{}:{workflowMode:value.data.workflowMode}),actorDeveloperId:value.data.actorDeveloperId,agentId:value.data.agentId,recipe:value.data.recipe,digest:value.data.digest,pin,...(value.data.payerDeveloperId===undefined?{}:{payerDeveloperId:value.data.payerDeveloperId})};
}
