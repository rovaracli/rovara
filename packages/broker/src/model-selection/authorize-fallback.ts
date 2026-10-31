// Server-only transaction preparation. The HTTP handler must first verify its operation capability.
import {createHash} from "node:crypto";
import {GetCommand,TransactWriteCommand} from "@aws-sdk/lib-dynamodb";
import {TaskModelFallbackRequestSchema,TaskModelFallbackAuthorizationSchema,TaskModelPolicyBindingSchema,ModelSelectionSchema,OrgRoleSchema,STAGE_OPERATION_MAPPING,canonicalJson,agentXError,orgMemberKey,type OrgId,type InvocationModelRoute} from "@agentx/contracts";
import {taskKey,taskPointerKey,taskRecipeKey,effectiveTaskOwner,ownerFenceOf,type DeveloperTaskRecord} from "../developer/task-records.js";
import {type CallbackClaims,operationKey} from "../aws/cancellation.js";
import {budgetActorChecks} from "../agents/budget-authority.js";
import {readTaskRecipe} from "../agents/runs.js";
import type {TransactItem} from "../agents/table-writes.js";
import {routeTaskFallback} from "./fallback-route.js";
import {flushAuditEvents} from "../audit/flush.js";
import {modelIdentityChecks} from "./authority.js";
import {prepareTaskModelFallback,type FallbackRecordDependencies} from "./fallback-record.js";
import type {TaskStageLiveDependencies,loadPinnedTaskStageContext} from "./task-live.js";
import type {DeveloperSignInStore} from "../developer/store.js";
type Context=Awaited<ReturnType<typeof loadPinnedTaskStageContext>>;
export type TaskModelAuthorizationDependencies=TaskStageLiveDependencies&FallbackRecordDependencies&{signInStore:Pick<DeveloperSignInStore,"getDeveloper">;modelSignInTableName:string};
export interface TaskModelAuthorizationInput {verifiedClaims:CallbackClaims|undefined;orgId:OrgId;taskId:string;workspaceId:string;operationId:string;fence:number;request:unknown;context:Context;route?:{sourceId:string;wire:InvocationModelRoute}|undefined}
const refused=()=>agentXError("MODEL_NOT_ALLOWED","The task's pinned stage model cannot use this fallback. Check How we work.");
async function read(deps:TaskModelAuthorizationDependencies,Key:{pk:string;sk:string}) {return (await deps.documentClient.send(new GetCommand({TableName:deps.tableName,Key,ConsistentRead:true})) as {Item?:Record<string,unknown>}).Item;}
/** Context and route are trusted outputs of the sole server resolver/router, never request-body fields.
 * Return items only: caller commits the whole transaction before replying, then flushes its event. */
export async function prepareTaskModelAuthorization(deps:TaskModelAuthorizationDependencies,input:TaskModelAuthorizationInput) {
 const request=TaskModelFallbackRequestSchema.parse(input.request),context=input.context;
 const claims=input.verifiedClaims,claimBinding=TaskModelPolicyBindingSchema.safeParse(claims?.modelPolicy);
 if(claims===undefined||!claims.actions.includes("model-fallback")||claims.expiresAt<=Math.floor(deps.now()/1000)||claims.workspaceId!==input.workspaceId||claims.operationId!==input.operationId||claims.fence!==input.fence||!claimBinding.success||canonicalJson(claimBinding.data)!==canonicalJson(request.binding))throw refused();
 if(context.stage!==request.binding.stage||context.decision.kind!=="resolved")throw refused();
 const [rawTask,operation,workspace,pointer,frozen]=await Promise.all([read(deps,taskKey(input.taskId)),read(deps,operationKey(input.workspaceId,input.operationId)),read(deps,{pk:`WORKSPACE#${input.workspaceId}`,sk:"META"}),read(deps,taskPointerKey(input.workspaceId)),readTaskRecipe(deps,input.taskId,input.orgId)]);
 const binding=TaskModelPolicyBindingSchema.safeParse(operation?.modelPolicy);
 if(rawTask===undefined||rawTask.orgId!==input.orgId||rawTask.taskId!==input.taskId||rawTask.workspaceId!==input.workspaceId||rawTask.closedAt!==undefined||rawTask.outcome!==undefined||operation?.orgId!==input.orgId||operation.id!==input.operationId||operation.workspaceId!==input.workspaceId||operation.kind!=="task"||operation.modelTaskId!==input.taskId||operation.fence!==input.fence||!['ACCEPTED','DISPATCHING','RUNNING'].includes(String(operation.status))||workspace?.orgId!==input.orgId||workspace.activeOperationId!==input.operationId||workspace.fence!==input.fence||workspace.status!=="BUSY"||workspace.projectName!==rawTask.project||pointer?.taskId!==input.taskId||pointer.cancelledAt!==undefined||frozen?.modelPolicyPin===undefined||!binding.success)throw refused();
 if(canonicalJson(request.binding)!==canonicalJson(binding.data)||request.binding.companyRevision!==frozen.modelPolicyPin.policy.revision||request.binding.recipeDigest!==frozen.digest||canonicalJson(context.pin)!==canonicalJson(frozen.modelPolicyPin)||context.pin.orgId!==input.orgId||context.pin.project!==rawTask.project)throw refused();
 const mode=typeof operation.workflowMode==="string"?operation.workflowMode:"IMPLEMENT";
 if(!(mode in STAGE_OPERATION_MAPPING)||!(STAGE_OPERATION_MAPPING[mode as keyof typeof STAGE_OPERATION_MAPPING].stages as readonly string[]).includes(binding.data.stage))throw refused();
 const task=rawTask as unknown as DeveloperTaskRecord,owner=effectiveTaskOwner(task),ownerFence=ownerFenceOf(task);
 const member=await read(deps,orgMemberKey(input.orgId,owner.developerId)),role=OrgRoleSchema.safeParse(member?.role);
 if(!role.success||member?.orgId!==input.orgId||member.developerId!==owner.developerId)throw refused();
 const identity=await modelIdentityChecks(deps,{signedInId:owner.developerId,developerId:owner.developerId});
 const requestDigest=createHash("sha256").update(canonicalJson(request)).digest("hex");
 const checks:TransactItem[]=[...context.checks,...budgetActorChecks(deps.tableName,input.orgId,{developerId:owner.developerId,role:role.data}),...identity,
 {ConditionCheck:{TableName:deps.tableName,Key:{pk:`WORKSPACE#${input.workspaceId}`,sk:"META"},ConditionExpression:"orgId = :org AND activeOperationId = :operation AND fence = :fence AND #status = :busy",ExpressionAttributeNames:{"#status":"status"},ExpressionAttributeValues:{":org":input.orgId,":operation":input.operationId,":fence":input.fence,":busy":"BUSY"}}},
 {ConditionCheck:{TableName:deps.tableName,Key:taskPointerKey(input.workspaceId),ConditionExpression:"taskId = :task AND attribute_not_exists(cancelledAt)",ExpressionAttributeValues:{":task":input.taskId}}},
 {ConditionCheck:{TableName:deps.tableName,Key:taskRecipeKey(input.taskId),ConditionExpression:"orgId = :org AND digest = :digest AND modelPolicyPin = :pin AND recipe = :recipe",ExpressionAttributeValues:{":org":input.orgId,":digest":frozen.digest,":pin":frozen.modelPolicyPin,":recipe":frozen.recipe}}}];
 const taskCondition=`orgId = :authOrg AND taskId = :authTask AND developerId = :authCreator AND workspaceId = :authWorkspace AND #authProject = :authProject AND attribute_not_exists(outcome) AND attribute_not_exists(closedAt) AND ${ownerFence.expression}`;
 const taskNames={...ownerFence.names,"#authProject":"project"},taskValues={...ownerFence.values,":authOrg":input.orgId,":authTask":input.taskId,":authCreator":task.developerId,":authWorkspace":input.workspaceId,":authProject":context.pin.project};
 if(input.route!==undefined&&input.route.sourceId!==context.decision.sourceId||input.route===undefined&&context.decision.sourceId!=="rovara")throw refused();
 const expectedRoute=input.route===undefined?null:{sourceId:input.route.sourceId,alias:input.route.wire.alias,model:context.decision.model};
 if(operation.modelFallbackAuthorization!==undefined) {
  const authorization=TaskModelFallbackAuthorizationSchema.parse(operation.modelFallbackAuthorization);
  if(canonicalJson(operation.modelRoute)!==canonicalJson(expectedRoute)||canonicalJson(authorization.modelRoute??null)!==canonicalJson(input.route?.wire??null)||canonicalJson(operation.model)!==canonicalJson(authorization.model)||operation.modelFallbackRequestDigest!==requestDigest||canonicalJson(authorization.binding)!==canonicalJson(binding.data)||canonicalJson(authorization.model)!==canonicalJson({...context.decision.model,...(context.decision.thinkingLevel===null?{}:{thinkingLevel:context.decision.thinkingLevel})}))throw refused();
  return {authorization,replayed:true as const,event:undefined,items:[...checks,{ConditionCheck:{TableName:deps.tableName,Key:taskKey(input.taskId),ConditionExpression:taskCondition,ExpressionAttributeNames:taskNames,ExpressionAttributeValues:taskValues}},{ConditionCheck:{TableName:deps.tableName,Key:operationKey(input.workspaceId,input.operationId),ConditionExpression:"orgId = :org AND id = :operation AND workspaceId = :workspace AND modelTaskId = :task AND modelPolicy = :binding AND #model = :model AND modelRoute = :route AND fence = :fence AND modelFallbackRequestDigest = :digest AND modelFallbackAuthorization = :authorization AND #status = :status",ExpressionAttributeNames:{"#status":"status","#model":"model"},ExpressionAttributeValues:{":route":expectedRoute,":model":authorization.model,":org":input.orgId,":operation":input.operationId,":workspace":input.workspaceId,":task":input.taskId,":binding":binding.data,":fence":input.fence,":digest":requestDigest,":authorization":authorization,":status":operation.status}}}] as TransactItem[]};
 }
 const current=ModelSelectionSchema.safeParse(operation.model);
 if(!current.success||current.data.provider!==request.failedModel.provider||current.data.modelId!==request.failedModel.modelId)throw refused();
 const model={...context.decision.model,...(context.decision.thinkingLevel===null?{}:{thinkingLevel:context.decision.thinkingLevel})};
 const authorization=TaskModelFallbackAuthorizationSchema.parse({version:1,binding:binding.data,model,...(input.route===undefined?{}:{modelRoute:input.route.wire}),sourcesRevision:context.sourcesRevision});
 const decision={...context.decision,fallback:context.decision.fallback??{stage:binding.data.stage,used:`${model.provider}/${model.modelId}`,wanted:`${current.data.provider}/${current.data.modelId}`,reasonCode:request.reason==="missing_key"||request.reason==="model"?"MODEL_CALL_REFUSED" as const:"CHATGPT_PLAN_UNAVAILABLE" as const}};
 const prepared=await prepareTaskModelFallback(deps,{orgId:input.orgId,taskId:input.taskId,project:context.pin.project,operationId:`${input.operationId}:runtime`,occurredAt:new Date(deps.now()).toISOString(),companyRevision:binding.data.companyRevision,decision});
 if(prepared.replayed)throw refused();
 const update=prepared.items[0]?.Update;if(update===undefined)throw refused();
 update.ConditionExpression=`(${update.ConditionExpression}) AND (${taskCondition})`;update.ExpressionAttributeNames={...update.ExpressionAttributeNames,...taskNames};update.ExpressionAttributeValues={...update.ExpressionAttributeValues,...taskValues};
 const items:TransactItem[]=[...checks,...prepared.items,{Update:{TableName:deps.tableName,Key:operationKey(input.workspaceId,input.operationId),UpdateExpression:"SET #model = :next, modelRoute = :route, fundingSourceId = :fundingSourceId, modelFallbackAuthorization = :authorization, modelFallbackRequestDigest = :digest REMOVE chatgptDeveloperId",ConditionExpression:"orgId = :org AND id = :operation AND modelTaskId = :task AND fence = :fence AND #status = :status AND #model = :before AND modelPolicy = :binding AND attribute_not_exists(modelFallbackAuthorization)",ExpressionAttributeNames:{"#model":"model","#status":"status"},ExpressionAttributeValues:{":org":input.orgId,":operation":input.operationId,":task":input.taskId,":fence":input.fence,":status":operation.status,":before":current.data,":binding":binding.data,":fundingSourceId":context.decision.sourceId,":next":model,":route":expectedRoute,":authorization":authorization,":digest":requestDigest}}}];
 if(items.length>90)throw refused();return {authorization,replayed:false as const,event:prepared.event,items};
}

/** HTTP boundary verifies the signature first; no reply is released before this atomic commit. */
export async function authorizeTaskModelFallback(deps:TaskModelAuthorizationDependencies,input:TaskModelAuthorizationInput) {
 const decision=input.context.decision;
 if(decision.kind!=="resolved")throw refused();
 const route=await routeTaskFallback(deps.routing,{orgId:input.orgId,project:input.context.pin.project,agent:input.context.pin.processAgentId,stage:input.context.stage,model:decision.model,sourceId:decision.sourceId});
 const prepared=await prepareTaskModelAuthorization(deps,{...input,route});
 await deps.documentClient.send(new TransactWriteCommand({TransactItems:prepared.items}));
 if(prepared.event!==undefined)await flushAuditEvents(deps.audit===undefined?{}:{audit:deps.audit},[prepared.event]);
 return prepared.authorization;
}
