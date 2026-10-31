import type {TransactItem} from "../agents/table-writes.js";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ModelSelectionPolicyResponseSchema, agentXError, orgSettingsKey, modelSourcesKey, agentGuardrailsKey, type ModelSelectionPolicyResponse, type OrgId, type StageId } from "@agentx/contracts";
export interface ModelPolicyReader {tableName:string;documentClient:{send(command:unknown):Promise<unknown>}}
export const modelSelectionPolicyKey=(orgId:OrgId)=>orgSettingsKey(orgId,"MODEL_SELECTION_POLICY");
/** No row is a virtual default. A row that cannot be trusted never becomes the default. No write on GET. */
export async function readModelSelectionPolicy(deps:ModelPolicyReader,orgId:OrgId):Promise<ModelSelectionPolicyResponse> {
 let item:Record<string,unknown>|undefined;
 try {item=(await deps.documentClient.send(new GetCommand({TableName:deps.tableName,Key:modelSelectionPolicyKey(orgId),ConsistentRead:true})) as {Item?:Record<string,unknown>}).Item;}
 catch {throw agentXError("RUNTIME_UNAVAILABLE","The model policy could not be read. Reload and try again.");}
 if(item===undefined) return {version:1,revision:0,rankingVersion:"g3-v1",stepOverrides:{}};
 if(item.orgId!==orgId || item.entityType!=="MODEL_SELECTION_POLICY") throw agentXError("RUNTIME_UNAVAILABLE","The model policy could not be read. Reload and try again.");
 const parsed=ModelSelectionPolicyResponseSchema.safeParse({version:item.version,revision:item.revision,rankingVersion:item.rankingVersion,stepOverrides:item.stepOverrides});
 if(!parsed.success) throw agentXError("RUNTIME_UNAVAILABLE","The model policy could not be read. Reload and try again.");
 return parsed.data;
}

/** Pure transaction conditions: revision zero means the settings row was absent. */
export function modelSelectionRevisionChecks(tableName:string,orgId:OrgId,revisions:{companyRevision:number;sourcesRevision:number;guardrailsRevision:number}):TransactItem[]{
 if(![revisions.companyRevision,revisions.sourcesRevision,revisions.guardrailsRevision].every(value=>Number.isSafeInteger(value)&&value>=0))throw agentXError("RUNTIME_UNAVAILABLE","The model settings could not be read. Reload and try again.");
 return ([[modelSelectionPolicyKey(orgId),revisions.companyRevision],[modelSourcesKey(orgId),revisions.sourcesRevision],[agentGuardrailsKey(orgId),revisions.guardrailsRevision]] as const).map(([Key,revision])=>({ConditionCheck:{TableName:tableName,Key,...(revision===0?{ConditionExpression:"attribute_not_exists(pk)"}:{ConditionExpression:"#revision = :revision",ExpressionAttributeNames:{"#revision":"revision"},ExpressionAttributeValues:{":revision":revision}})}}));
}

/** A proxy-less install ignores source order but still fences the revision of an old stored row. */
export async function inactiveModelSourcesRevision(deps:Partial<ModelPolicyReader>,orgId:OrgId):Promise<number> {
 if(deps.documentClient===undefined||deps.tableName===undefined)return 0;
 let row:Record<string,unknown>|undefined;
 try {row=(await deps.documentClient.send(new GetCommand({TableName:deps.tableName,Key:modelSourcesKey(orgId),ConsistentRead:true})) as {Item?:Record<string,unknown>}).Item;}catch{throw agentXError("RUNTIME_UNAVAILABLE","The model source revision could not be read.");}
 if(row===undefined)return 0;
 if(!Number.isSafeInteger(row.revision)||Number(row.revision)<0)throw agentXError("RUNTIME_UNAVAILABLE","The model source revision could not be verified.");
 return Number(row.revision);
}

/** A locked model or stored source order constrains legacy personal-plan key routing. */
export async function readCompanyStagePolicy(deps:ModelPolicyReader,orgId:OrgId,stage:StageId,pinned?:Pick<ModelSelectionPolicyResponse,"stepOverrides">) {
 const policy=pinned??await readModelSelectionPolicy(deps,orgId);
 let source:Record<string,unknown>|undefined;
 try{source=(await deps.documentClient.send(new GetCommand({TableName:deps.tableName,Key:modelSourcesKey(orgId),ConsistentRead:true})) as {Item?:Record<string,unknown>}).Item;}catch{throw agentXError("RUNTIME_UNAVAILABLE","The model source policy could not be read.");}
 if(source?.order!==undefined&&(!Array.isArray(source.order)||!source.order.every((id:unknown)=>typeof id==="string")))throw agentXError("RUNTIME_UNAVAILABLE","The model source policy could not be verified.");
 const sourceOrder=source?.order,model=policy.stepOverrides[stage]?.model,locked=policy.stepOverrides[stage]?.locked===true;
 return {applies:locked&&model!==undefined||sourceOrder!==undefined,model,locked,sourceOrder};
}
export async function hasCompanyStagePolicy(deps:ModelPolicyReader,orgId:OrgId,stage:StageId,pinned?:Pick<ModelSelectionPolicyResponse,"stepOverrides">):Promise<boolean> {const policy=await readCompanyStagePolicy(deps,orgId,stage,pinned);return policy.model!==undefined||policy.sourceOrder!==undefined;}
