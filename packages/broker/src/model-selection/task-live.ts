import {projectAiLifecycleChecks} from "../spend/project-ai-authority.js";
import type {TransactItem} from "../agents/table-writes.js";
// Server-only bounded reads for one frozen task stage. No provider probes or writes.
import {QueryCommand} from "@aws-sdk/lib-dynamodb";
import {PROJECT_REVISION_SK_PREFIX,StoredProjectDefinitionSchema,projectPk,projectRevisionKey,modelSourcesKey,agentGuardrailsKey,agentXError,type ModelIdentifier} from "@agentx/contracts";
import {bedrockClaudeModelIds} from "@agentx/model-runtime/catalog";
import {readGuardrailsWithRevision} from "../agents/guardrails.js";
import {defaultWorkerModel} from "../agents/dispatch.js";
import {servableModels} from "../model-sources/routing.js";
import {poolKey,reviewDefaultExtras} from "./review-default-pool.js";
import {parseTaskModelPolicyPin} from "./task-pin.js";
import {readStageModelEvidence,type StageEvidenceDependencies} from "./evidence.js";
import {resolvePinnedTaskStage,type PinnedTaskStageInput} from "./task-runtime.js";
import type {ModelPolicyReader} from "./policy-store.js";
export type TaskStageLiveDependencies=ModelPolicyReader&StageEvidenceDependencies;
export type TaskStageLiveInput=Omit<PinnedTaskStageInput,"registeredAt"|"live"|"builtinDefault">&{payerDeveloperId?:string;excludePersonalPlan?:boolean;deniedModels:readonly ModelIdentifier[]};
const unavailable=()=>agentXError("RUNTIME_UNAVAILABLE","The task's current model context could not be verified.");
async function readPinnedTaskStage(deps:TaskStageLiveDependencies,input:TaskStageLiveInput,commitFences:boolean) {
 const pin=parseTaskModelPolicyPin(input.pin,{orgId:input.orgId,project:input.project,agentId:input.agentId,recipe:input.recipe,digest:input.digest});
 if(pin.frozenInputs===undefined)throw unavailable();
 let row:Record<string,unknown>|undefined;
 try {
  const response=await deps.documentClient.send(new QueryCommand({TableName:deps.tableName,KeyConditionExpression:"pk = :pk AND begins_with(sk, :prefix)",ExpressionAttributeValues:{":pk":projectPk(input.orgId,input.project),":prefix":PROJECT_REVISION_SK_PREFIX},ScanIndexForward:false,Limit:1,ConsistentRead:true})) as {Items?:Record<string,unknown>[]};
  row=response.Items?.[0];
 }catch{throw unavailable();}
 const definition=StoredProjectDefinitionSchema.safeParse(row?.definition);
 if(!definition.success||definition.data.name!==input.project||row?.registeredAt!==pin.registeredAt)throw unavailable();
 const key=projectRevisionKey(input.orgId,input.project,definition.data.revision);
 if(row.pk!==key.pk||row.sk!==key.sk)throw unavailable();
 const models=new Map<string,ModelIdentifier>();
 const add=(model:ModelIdentifier|undefined)=>{if(model!==undefined)models.set(`${model.provider}\0${model.modelId}`,{provider:model.provider,modelId:model.modelId});};
 const frozen=pin.frozenInputs;
 if(frozen.projectModels===undefined)bedrockClaudeModelIds(deps.routing.rovaraGeography??"us").forEach(modelId=>add({provider:"amazon-bedrock",modelId}));
 else frozen.projectModels.approved.forEach(add);
 add(frozen.projectModels?.default);add(frozen.projectSelection);
 for(const rows of [frozen.projectChoices,frozen.recipeDefaults,pin.policy.stepOverrides])for(const choice of Object.values(rows)){add(choice?.model);add(choice?.fallbackModel);}
 add(input.defaultPreferred);
 for(const model of input.defaultFallbacks??[])add(model);
 const builtinDefault=defaultWorkerModel(deps.routing.rovaraGeography);add(builtinDefault);
 if(models.size>23)throw unavailable();
 const guardrailsRead=readGuardrailsWithRevision(deps,input.orgId);
 // A checking step's default is another company's model the company can use (owner decision 2026-11-02): only those stages of a task pinned with that default read the company's servable models, and only within the pool's limit. A source that cannot be listed adds nothing. A task pinned before the default existed keeps the pool it always had.
 const extraKeys=new Set<string>();
 if(frozen.reviewDefault==="different_company"&&(input.stage==="plan_check"||input.stage==="code_review"||input.stage==="security_review")) {
  const forbidden=(await guardrailsRead).guardrails.forbiddenModels;
  for(const extra of reviewDefaultExtras({servable:await servableModels(deps.routing,input.orgId,input.project).catch(()=>[]),approved:frozen.projectModels?.approved,forbidden,have:new Set([...models.values()].map(poolKey)),size:models.size})){add(extra);extraKeys.add(`${extra.provider}\0${extra.modelId}`);}
 }
 const [guardrailSnapshot,evidence]=await Promise.all([guardrailsRead,readStageModelEvidence(deps,{orgId:input.orgId,project:input.project,models:[...models.values()],payerDeveloperId:input.payerDeveloperId,excludePersonalPlan:input.excludePersonalPlan,noPersonalPlan:extraKeys})]);
 const guardrails=guardrailSnapshot.guardrails;
 const decision=resolvePinnedTaskStage({...input,registeredAt:pin.registeredAt,builtinDefault,live:{...evidence,forbidden:guardrails.forbiddenModels,deniedModels:input.deniedModels,requireDifferentVendor:guardrails.requireCrossCompanyReview&&(input.stage==="code_review"||input.stage==="security_review")}});
 const checks:TransactItem[]=[];
 if(commitFences) {
  const lifecycle=await projectAiLifecycleChecks(deps,input.orgId,input.project,{allowArchived:true}),identity=lifecycle[0]?.ConditionCheck;
  if(identity===undefined)throw unavailable();
  identity.ConditionExpression+=" AND #g3RegisteredAt = :g3RegisteredAt";
  identity.ExpressionAttributeNames={...identity.ExpressionAttributeNames,"#g3RegisteredAt":"registeredAt"};identity.ExpressionAttributeValues={...identity.ExpressionAttributeValues,":g3RegisteredAt":pin.registeredAt};
  checks.push(...lifecycle);
  for(const [Key,revision] of [[modelSourcesKey(input.orgId),evidence.sourcesRevision],[agentGuardrailsKey(input.orgId),guardrailSnapshot.revision]] as const)checks.push({ConditionCheck:{TableName:deps.tableName,Key,...(revision===0?{ConditionExpression:"attribute_not_exists(pk)"}:{ConditionExpression:"#revision = :revision",ExpressionAttributeNames:{"#revision":"revision"},ExpressionAttributeValues:{":revision":revision}})}});
 }
 return {stage:input.stage,decision,checks,sourcesRevision:evidence.sourcesRevision,guardrailsRevision:guardrailSnapshot.revision,registeredAt:pin.registeredAt,projectRevision:definition.data.revision,pin};
}

/** Existing dispatch reads keep their original bounded footprint. Commit callers opt into fences. */
export async function loadPinnedTaskStage(deps:TaskStageLiveDependencies,input:TaskStageLiveInput) {return (await readPinnedTaskStage(deps,input,false)).decision;}
export async function loadPinnedTaskStageContext(deps:TaskStageLiveDependencies,input:TaskStageLiveInput) {return readPinnedTaskStage(deps,input,true);}
