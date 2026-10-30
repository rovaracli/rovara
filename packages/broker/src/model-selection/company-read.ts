import {GetCommand} from "@aws-sdk/lib-dynamodb";
import {ModelSelectionPolicyResponseSchema,STAGE_IDS,agentXError,canonicalModelName,modelCompany,orgMemberKey,developerOrgKey,orgMetaKey,type OrgId,type ModelIdentifier} from "@agentx/contracts";
import {bedrockClaudeModelIds,catalogModel} from "@agentx/model-runtime/catalog";
import {readGuardrails} from "../agents/guardrails.js";
import {effectiveSources} from "../model-sources/routing.js";
import {readStageModelEvidence,type StageEvidenceDependencies} from "./evidence.js";
import {readModelSelectionPolicy,type ModelPolicyReader} from "./policy-store.js";
import type {StageModelCaller} from "./read.js";
type Deps=ModelPolicyReader&StageEvidenceDependencies;
const forbidden=()=>agentXError("FORBIDDEN","Only a current company owner or admin can read model policy.");
const unavailable=()=>agentXError("RUNTIME_UNAVAILABLE","The company model settings could not be read. Reload and try again.");
async function authority(deps:Deps,caller:StageModelCaller) {
 if(!/^[a-f0-9]{64}$/u.test(caller.developerId)) throw forbidden();
 const keys=[orgMemberKey(caller.orgId,caller.developerId),developerOrgKey(caller.developerId),orgMetaKey(caller.orgId)];
 const rows=await Promise.all(keys.map(async Key=>{try{return (await deps.documentClient.send(new GetCommand({TableName:deps.tableName,Key,ConsistentRead:true})) as {Item?:Record<string,unknown>}).Item;}catch{throw unavailable();}}));
 const [member,pointer,org]=rows;
 if(rows.some((row,index)=>row===undefined||row.pk!==keys[index]!.pk||row.sk!==keys[index]!.sk)||member?.orgId!==caller.orgId||member.developerId!==caller.developerId||(member.role!=="owner"&&member.role!=="admin")||pointer?.orgId!==caller.orgId||pointer.role!==member.role||org?.orgId!==caller.orgId||org.closingAt!==undefined||org.closedAt!==undefined)throw forbidden();
}
export async function getCompanyModelSelectionPolicy(deps:Deps,caller:StageModelCaller) {
 await authority(deps,caller);
 const orgId:OrgId=caller.orgId;
 const policy=await readModelSelectionPolicy(deps,orgId);
 const stored=await effectiveSources(deps.routing,orgId,"");
 const pool=new Map<string,ModelIdentifier>();const add=(model:ModelIdentifier|undefined)=>{if(model!==undefined)pool.set(`${model.provider}\0${model.modelId}`,{provider:model.provider,modelId:model.modelId});};
 if(stored===undefined||stored.order.includes("rovara"))bedrockClaudeModelIds(deps.routing.rovaraGeography??"us").forEach(modelId=>add({provider:"amazon-bedrock",modelId}));
 for(const source of stored?.stored.sources??[])if(stored?.order.includes(source.sourceId))for(const model of source.models)add(model.catalog);
 for(const override of Object.values(policy.stepOverrides)){add(override?.model);add(override?.fallbackModel);}
 if(pool.size>23)throw unavailable();
 // Company defaults cannot borrow the viewing admin's personal ChatGPT connection.
 const evidence=await readStageModelEvidence(deps,{orgId,project:"",models:[...pool.values()]});
 if(stored!==undefined&&evidence.sourcesRevision!==stored.stored.revision)throw unavailable();
 const guardrails=await readGuardrails(deps,orgId);const denied=new Set(guardrails.forbiddenModels.map(canonicalModelName));
 const candidates=[...pool.values()].map(model=>{
  const blocked=denied.has(canonicalModelName(model));const verified=evidence.candidates.some(candidate=>candidate.model.provider===model.provider&&candidate.model.modelId===model.modelId);
  const name=catalogModel(model)?.name??model.modelId;const label=[...name.replace(/[\p{Cc}\p{Cf}]/gu,"")].slice(0,64).join("")||"Model";
  return {model,label,provider:model.provider,company:modelCompany(model),status:blocked?"denied" as const:verified?"verified" as const:"unverified" as const,...(blocked?{blockedReason:"MODEL_FORBIDDEN" as const}:verified?{}:{blockedReason:"MODEL_NOT_VERIFIED" as const})};
 });
 await authority(deps,caller);
 return ModelSelectionPolicyResponseSchema.parse({...policy,candidates:Object.fromEntries(STAGE_IDS.map(stage=>[stage,candidates]))});
}
