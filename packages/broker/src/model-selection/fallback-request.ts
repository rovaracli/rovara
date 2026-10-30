import {CRITIC_MODEL_ATTEMPTS_MAX,PlanCheckUnavailableError} from "../rovara-code/critic.js";
import {criticFailures,reviewFailures} from "./task-failures.js";
import {GetCommand} from "@aws-sdk/lib-dynamodb";
import {TaskModelFallbackRequestSchema,TaskModelPolicyBindingSchema,canonicalJson,agentXError} from "@agentx/contracts";
import {readTaskRecipe} from "../agents/runs.js";
import {queryAllItems} from "../aws/admin-reads.js";
import {taskKey,type DeveloperTaskRecord} from "../developer/task-records.js";
import {loadPinnedTaskStageContext} from "./task-live.js";
import {taskStageReferences,scopedTaskOperations,taskStageReferenceChecks,taskStageReferenceOperation} from "./task-references.js";
import {authorizeTaskModelFallback,type TaskModelAuthorizationDependencies,type TaskModelAuthorizationInput} from "./authorize-fallback.js";
export type TaskFallbackRequestInput=Omit<TaskModelAuthorizationInput,"context"|"route">;
const refused=()=>agentXError("MODEL_NOT_ALLOWED","The task's fallback context is unavailable. Check How we work.");
/** Called after HTTP signature verification. Every model choice comes from stored task state. */
export async function resolveAndAuthorizeTaskFallback(deps:TaskModelAuthorizationDependencies,input:TaskFallbackRequestInput) {
 const request=TaskModelFallbackRequestSchema.parse(input.request),claims=input.verifiedClaims;
 const binding=TaskModelPolicyBindingSchema.safeParse(claims?.modelPolicy);
 if(claims===undefined||!binding.success||!claims.actions.includes("model-fallback")||claims.expiresAt<=Math.floor(deps.now()/1000)||claims.workspaceId!==input.workspaceId||claims.operationId!==input.operationId||claims.fence!==input.fence||canonicalJson(binding.data)!==canonicalJson(request.binding))throw refused();
 const response=await deps.documentClient.send(new GetCommand({TableName:deps.tableName,Key:taskKey(input.taskId),ConsistentRead:true})) as {Item?:DeveloperTaskRecord};
 const task=response.Item;
 if(task?.orgId!==input.orgId||task.workspaceId!==input.workspaceId||task.agent===undefined||task.closedAt!==undefined||task.outcome!==undefined)throw refused();
 const frozen=await readTaskRecipe(deps,input.taskId,input.orgId);
 if(frozen?.modelPolicyPin===undefined||task.agent.digest!==frozen.digest)throw refused();
 const operations=scopedTaskOperations(await queryAllItems(deps,`WORKSPACE#${input.workspaceId}`,"OPERATION#"),{orgId:input.orgId,workspaceId:input.workspaceId,conversationId:task.conversationId,taskId:task.taskId});
 const planner=operations.filter(row=>row.workflowMode==="PLAN"&&row.conversationId===task.conversationId).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)))[0];
 const criticHistory=request.binding.stage==="plan_check"?criticFailures(operations,planner):undefined;
 if(criticHistory!==undefined&&criticHistory.sinceLatestPlan>=CRITIC_MODEL_ATTEMPTS_MAX)throw new PlanCheckUnavailableError();
 const reviewHistory=request.binding.stage==="code_review"||request.binding.stage==="security_review"?reviewFailures(operations,taskStageReferenceOperation(operations,{orgId:input.orgId,workspaceId:input.workspaceId,conversationId:task.conversationId,taskId:task.taskId},"build")):undefined;
 const denied=criticHistory?.models??reviewHistory?.models??[];
 const context=await loadPinnedTaskStageContext(deps,{orgId:input.orgId,project:task.project,agentId:task.agent.agentId,recipe:frozen.recipe,digest:frozen.digest,pin:frozen.modelPolicyPin,stage:request.binding.stage,priorModels:taskStageReferences(operations,{orgId:input.orgId,workspaceId:input.workspaceId,conversationId:task.conversationId,taskId:task.taskId}),deniedModels:[request.failedModel,...denied],defaultLastAttempt:(criticHistory?.sinceLatestPlan??reviewHistory?.sinceLatestBuild??-1)+1>=CRITIC_MODEL_ATTEMPTS_MAX,defaultPreferred:request.failedModel,...(request.environmentFallback===undefined?{}:{defaultFallbacks:[request.environmentFallback]}),excludePersonalPlan:request.reason!=="missing_key",...(task.payer?.kind==="member"?{payerDeveloperId:task.payer.developerId}:{})});
 context.checks.push(...taskStageReferenceChecks(deps.tableName,operations,{orgId:input.orgId,workspaceId:input.workspaceId,conversationId:task.conversationId,taskId:task.taskId},request.binding.stage));
 return authorizeTaskModelFallback(deps,{...input,request,context});
}
