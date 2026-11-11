import type {TransactItem} from "../agents/table-writes.js";
import { ModelSelectionSchema, STAGE_REFERENCE, agentXError, type ModelSelection, type StageId } from "@rovara-code/contracts";
type Scope={orgId:string;workspaceId:string;conversationId:string;taskId:string};
/** Match the existing reviewer: the latest completed Build supplies the code under review. */
export function taskStageReferenceOperation(operations:readonly Record<string,unknown>[],scope:Scope,reference:"plan"|"build") {
 const mode=reference==="plan"?"PLAN":"IMPLEMENT";
 const rows=scopedTaskOperations(operations,scope).filter(row=>row.conversationId===scope.conversationId&&row.workflowMode===mode&&typeof row.createdAt==="string").sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
 return reference==="build"?rows.find(row=>row.status==="SUCCEEDED")??rows[0]:rows[0];
}
/** Actual operation history only. Missing/invalid latest models remain unknown, never a default. */
export function taskStageReferences(operations:readonly Record<string,unknown>[],scope:Scope):Partial<Record<StageId,ModelSelection>> {
 const result:Partial<Record<StageId,ModelSelection>>={};
 for(const stage of ["plan","build"] as const){
  const latest=taskStageReferenceOperation(operations,scope,stage);
  const model=ModelSelectionSchema.safeParse(latest?.model);if(model.success)result[stage]=model.data;
 }
 return result;
}

/** One scope filter shared by reference selection and critic retry denial history. */
export function scopedTaskOperations(operations:readonly Record<string,unknown>[],scope:Scope) {
 return operations.filter(row=>row.entityType==="OPERATION"&&row.kind==="task"&&row.orgId===scope.orgId&&row.workspaceId===scope.workspaceId&&(row.modelTaskId===scope.taskId||row.modelTaskId===undefined&&row.conversationId===scope.conversationId));
}

/** Fence the one actual operation whose model establishes checking-stage independence. */
export function taskStageReferenceChecks(tableName:string,operations:readonly Record<string,unknown>[],scope:Scope,stage:StageId):TransactItem[] {
 if(!(stage in STAGE_REFERENCE))return [];
 const reference=STAGE_REFERENCE[stage as keyof typeof STAGE_REFERENCE],mode=reference==="plan"?"PLAN":"IMPLEMENT";
 const latest=taskStageReferenceOperation(operations,scope,reference);
 if(latest===undefined||typeof latest.id!=="string"||!ModelSelectionSchema.safeParse(latest.model).success)throw agentXError("MODEL_NOT_ALLOWED","The task's actual reference model is unavailable. Check How we work.");
 return [{ConditionCheck:{TableName:tableName,Key:{pk:`WORKSPACE#${scope.workspaceId}`,sk:`OPERATION#${latest.id}`},ConditionExpression:`orgId = :org AND workspaceId = :workspace AND id = :id AND conversationId = :conversation AND workflowMode = :mode AND createdAt = :created AND #model = :model AND ${latest.modelTaskId===undefined?"attribute_not_exists(#task)":"#task = :task"} AND ${typeof latest.status==="string"?"#status = :status":"attribute_not_exists(#status)"}`,ExpressionAttributeNames:{"#model":"model","#status":"status","#task":"modelTaskId"},ExpressionAttributeValues:{":org":scope.orgId,":workspace":scope.workspaceId,":id":latest.id,":conversation":scope.conversationId,":mode":mode,":created":latest.createdAt,":model":latest.model,...(latest.modelTaskId===undefined?{}:{":task":scope.taskId}),...(typeof latest.status==="string"?{":status":latest.status}:{})}}}];
}
