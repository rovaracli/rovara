import {mergeProcessModelAuthorityChecks} from "./authority.js";
import {taskKey,taskPointerKey,type DeveloperTaskRecord} from "../developer/task-records.js";
import type {DeveloperApiConfiguration} from "../aws/developer-routes.js";
import {queryAllItems} from "../aws/admin-reads.js";
import {taskStageReferences,taskStageReferenceChecks} from "./task-references.js";
import {readTurnActorChecks,type TurnActorDependencies} from "./turn-authority.js";
// Signed operation authority for project coding turns without a developer-task recipe record.
import {createHash} from "node:crypto";
import {GetCommand,TransactWriteCommand} from "@aws-sdk/lib-dynamodb";
import {TaskModelFallbackRequestSchema,TaskModelPolicyBindingSchema,TaskModelFallbackAuthorizationSchema,ModelSelectionSchema,canonicalModelName,canonicalJson,sharedTaskKey,agentXError,type OrgId} from "@agentx/contracts";
import {operationKey,type CallbackClaims} from "../aws/cancellation.js";
import {turnStagesForMode,parseTurnModelPin} from "./turn-policy.js";
import {loadPinnedTaskStageContext} from "./task-live.js";
import {routeTaskFallback} from "./fallback-route.js";
import {prepareTurnModelFallback} from "./fallback-record.js";
import {flushAuditEvents} from "../audit/flush.js";
import type {TaskModelAuthorizationDependencies} from "./authorize-fallback.js";
import type {TransactItem} from "../agents/table-writes.js";
const refused=()=>agentXError("MODEL_NOT_ALLOWED","The turn's pinned stage model cannot use this fallback. Check How we work.");
type TurnFallbackDependencies=Omit<TaskModelAuthorizationDependencies,"signInStore"|"modelSignInTableName">&TurnActorDependencies;
async function read(deps:TurnFallbackDependencies,Key:{pk:string;sk:string}) {return (await deps.documentClient.send(new GetCommand({TableName:deps.tableName,Key,ConsistentRead:true})) as {Item?:Record<string,unknown>}).Item;}
export async function authorizeTurnModelFallback(deps:TurnFallbackDependencies&{developer?:DeveloperApiConfiguration},input:{orgId:OrgId;workspaceId:string;operationId:string;fence:number;verifiedClaims:CallbackClaims;request:unknown}) {
 const request=TaskModelFallbackRequestSchema.parse(input.request),claims=input.verifiedClaims;
 if(!claims.actions.includes("model-fallback")||claims.expiresAt<=Math.floor(deps.now()/1000)||claims.workspaceId!==input.workspaceId||claims.operationId!==input.operationId||claims.fence!==input.fence||canonicalJson(claims.modelPolicy)!==canonicalJson(request.binding))throw refused();
 const [operation,workspace]=await Promise.all([read(deps,operationKey(input.workspaceId,input.operationId)),read(deps,{pk:`WORKSPACE#${input.workspaceId}`,sk:"META"})]);
 const binding=TaskModelPolicyBindingSchema.safeParse(operation?.modelPolicy);
 if(operation===undefined||operation.orgId!==input.orgId||operation.id!==input.operationId||operation.workspaceId!==input.workspaceId||operation.kind!=="task"||operation.fence!==input.fence||operation.modelTaskId!==undefined||!['ACCEPTED','DISPATCHING','RUNNING'].includes(String(operation.status))||workspace?.orgId!==input.orgId||workspace.activeOperationId!==input.operationId||workspace.fence!==input.fence||workspace.status!=="BUSY"||typeof workspace.projectName!=="string"||!binding.success||canonicalJson(binding.data)!==canonicalJson(request.binding))throw refused();
 const frozen=parseTurnModelPin(operation.modelTurnPin,input.orgId,workspace.projectName);
 const mode=typeof operation.workflowMode==="string"?operation.workflowMode:"IMPLEMENT",mapping=turnStagesForMode(mode);
 if(mapping.stages[0]!==binding.data.stage||frozen.workflowMode!==undefined&&frozen.workflowMode!==mode)throw refused();
 const pointer=await read(deps,taskPointerKey(input.workspaceId));
 const task=typeof pointer?.taskId==="string"?await read(deps,taskKey(pointer.taskId)):undefined;
 if(pointer!==undefined&&(typeof pointer.taskId!=="string"||task===undefined))throw refused();
 if(task!==undefined&&(task.orgId!==input.orgId||task.workspaceId!==input.workspaceId||task.project!==workspace.projectName))throw refused();
 const scope={orgId:input.orgId,workspaceId:input.workspaceId,conversationId:String(operation.conversationId),taskId:typeof task?.taskId==="string"?task.taskId:input.workspaceId};
 const operations=await queryAllItems(deps,`WORKSPACE#${input.workspaceId}`,"OPERATION#");
 if(binding.data.companyRevision!==frozen.pin.policy.revision||binding.data.recipeDigest!==frozen.digest)throw refused();
 const project=workspace.projectName;
 const contexts=await Promise.all(mapping.stages.map(stage=>loadPinnedTaskStageContext(deps,{orgId:input.orgId,project,agentId:frozen.agentId,recipe:frozen.recipe,digest:frozen.digest,pin:frozen.pin,stage,priorModels:taskStageReferences(operations,scope),deniedModels:[request.failedModel],defaultPreferred:request.failedModel,excludePersonalPlan:true,...(frozen.payerDeveloperId===undefined?{}:{payerDeveloperId:frozen.payerDeveloperId})})));
 const context=contexts[0];if(context===undefined||context.decision.kind!=="resolved")throw refused();
 const resolved=context.decision;
 if(contexts.some(value=>value.decision.kind!=="resolved"||canonicalModelName(value.decision.model)!==canonicalModelName(resolved.model)||value.decision.sourceId!==resolved.sourceId||value.decision.thinkingLevel!==resolved.thinkingLevel))throw refused();
 const actorChecks=await readTurnActorChecks(deps,{orgId:input.orgId,project:workspace.projectName,developerId:frozen.actorDeveloperId,...(task===undefined?{}:{task:task as unknown as DeveloperTaskRecord}),projectRevision:context.projectRevision,...(frozen.slackUserId===undefined?{}:{slackUserId:frozen.slackUserId}),...(frozen.threadChannel===undefined?{}:{threadChannel:frozen.threadChannel})});
 const decision=context.decision,route=await routeTaskFallback(deps.routing,{orgId:input.orgId,project:workspace.projectName,agent:frozen.agentId,stage:binding.data.stage,model:decision.model,sourceId:decision.sourceId});
 const model={...decision.model,...(decision.thinkingLevel===null?{}:{thinkingLevel:decision.thinkingLevel})};
 const authorization=TaskModelFallbackAuthorizationSchema.parse({version:1,binding:binding.data,model,sourcesRevision:context.sourcesRevision,...(route===undefined?{}:{modelRoute:route.wire})});
 const requestDigest=createHash("sha256").update(canonicalJson(request)).digest("hex"),nextRoute=route===undefined?null:{sourceId:route.sourceId,alias:route.wire.alias,model:decision.model};
 const slackTaskChecks:TransactItem[]=[];
 if(frozen.slackTask!==undefined) {
  if(task?.taskId!==frozen.slackTask.taskId||task.slackUserId!==frozen.slackUserId||frozen.threadChannel===undefined)throw refused();
  const Key=sharedTaskKey({...frozen.threadChannel,threadTs:frozen.slackTask.threadTs}),shared=await read(deps,Key);
  if(shared?.workflowThread!==true||shared.taskId!==task.taskId||shared.workspaceId!==input.workspaceId||shared.developerId!==task.developerId)throw refused();
  slackTaskChecks.push({ConditionCheck:{TableName:deps.tableName,Key,ConditionExpression:"taskId = :task AND workspaceId = :workspace AND developerId = :actor AND workflowThread = :workflow",ExpressionAttributeValues:{":task":task.taskId,":workspace":input.workspaceId,":actor":task.developerId,":workflow":true}}});
 }
 const scopeChecks:TransactItem[]=task===undefined?[{ConditionCheck:{TableName:deps.tableName,Key:taskPointerKey(input.workspaceId),ConditionExpression:"attribute_not_exists(pk)"}}]:[];
 const checks:TransactItem[]=[...slackTaskChecks,...scopeChecks,...mergeProcessModelAuthorityChecks(contexts.map(value=>value.checks)),...actorChecks,...taskStageReferenceChecks(deps.tableName,operations,scope,binding.data.stage),
 {ConditionCheck:{TableName:deps.tableName,Key:{pk:`WORKSPACE#${input.workspaceId}`,sk:"META"},ConditionExpression:"orgId = :org AND projectName = :project AND activeOperationId = :operation AND fence = :fence AND #status = :busy",ExpressionAttributeNames:{"#status":"status"},ExpressionAttributeValues:{":org":input.orgId,":project":workspace.projectName,":operation":input.operationId,":fence":input.fence,":busy":"BUSY"}}}];
 const current=ModelSelectionSchema.safeParse(operation.model);if(!current.success)throw refused();
 const predicate="orgId = :org AND id = :operation AND workspaceId = :workspace AND fence = :fence AND #status = :status AND modelPolicy = :binding AND modelTurnPin = :pin AND #model = :before";
 const names={"#status":"status","#model":"model"};
 const values={":org":input.orgId,":operation":input.operationId,":workspace":input.workspaceId,":fence":input.fence,":status":operation.status,":binding":binding.data,":pin":operation.modelTurnPin,":before":current.data};
 if(operation.modelFallbackAuthorization!==undefined) {
  if(operation.modelFallbackRequestDigest!==requestDigest||canonicalJson(operation.modelFallbackAuthorization)!==canonicalJson(authorization)||canonicalJson(operation.modelRoute)!==canonicalJson(nextRoute)||canonicalJson(current.data)!==canonicalJson(model))throw refused();
  await deps.documentClient.send(new TransactWriteCommand({TransactItems:[...checks,{ConditionCheck:{TableName:deps.tableName,Key:operationKey(input.workspaceId,input.operationId),ConditionExpression:predicate+" AND modelFallbackRequestDigest = :digest AND modelFallbackAuthorization = :authorization",ExpressionAttributeNames:names,ExpressionAttributeValues:{...values,":digest":requestDigest,":authorization":authorization}}}]}));
  return authorization;
 }
 if(current.data.provider!==request.failedModel.provider||current.data.modelId!==request.failedModel.modelId)throw refused();
 const fallback={stage:binding.data.stage,used:`${model.provider}/${model.modelId}`,wanted:`${current.data.provider}/${current.data.modelId}`,reasonCode:request.reason==="missing_key"||request.reason==="model"?"MODEL_CALL_REFUSED" as const:"CHATGPT_PLAN_UNAVAILABLE" as const};
 const history=prepareTurnModelFallback(deps,{orgId:input.orgId,taskId:input.operationId,project:workspace.projectName,operationId:`${input.operationId}:runtime`,occurredAt:new Date(deps.now()).toISOString(),companyRevision:binding.data.companyRevision,decision:{...decision,fallback}},{modelFallbacks:operation.modelFallbacks,modelFallbackReceipts:operation.modelFallbackReceipts,modelFallbackRevision:operation.modelFallbackRevision});
 const items:TransactItem[]=[...checks,...history.items,{Update:{TableName:deps.tableName,Key:operationKey(input.workspaceId,input.operationId),UpdateExpression:"SET #model = :next, modelRoute = :route, fundingSourceId = :fundingSourceId, modelFallbackAuthorization = :authorization, modelFallbackRequestDigest = :digest, modelFallbacks = :history, modelFallbackReceipts = :receipts, modelFallbackRevision = :revision REMOVE chatgptDeveloperId",ConditionExpression:predicate+" AND attribute_not_exists(modelFallbackAuthorization) AND "+(operation.modelFallbackRevision===undefined?"attribute_not_exists(modelFallbackRevision)":"modelFallbackRevision = :oldRevision"),ExpressionAttributeNames:names,ExpressionAttributeValues:{...values,":fundingSourceId":context.decision.sourceId,":next":model,":route":nextRoute,":authorization":authorization,":digest":requestDigest,":history":history.fields.modelFallbacks,":receipts":history.fields.modelFallbackReceipts,":revision":history.fields.modelFallbackRevision,...(operation.modelFallbackRevision===undefined?{}:{":oldRevision":operation.modelFallbackRevision})}}}];
 if(items.length>25)throw refused();
 await deps.documentClient.send(new TransactWriteCommand({TransactItems:items}));
 await flushAuditEvents(deps.audit===undefined?{}:{audit:deps.audit},[history.event]);return authorization;
}
