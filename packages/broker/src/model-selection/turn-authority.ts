// Shared current-person commit fences for ordinary project coding turns.
import {taskKey,taskPointerKey,effectiveTaskOwner,ownerFenceOf,type DeveloperTaskRecord} from "../developer/task-records.js";
import {GetCommand} from "@aws-sdk/lib-dynamodb";
import {OrgRoleSchema,agentXError,orgMemberKey,projectMemberKey,slackBindingKey,developerOrgKey,orgMetaKey,orgRemovedKey,orgBanKey,slackTeamOrgKey,type OrgId} from "@agentx/contracts";
import {developerIdForSlackUser} from "../aws/admin-actions.js";
import {budgetActorChecks} from "../agents/budget-authority.js";
import {effectiveProjectRole} from "../developer/project-roles.js";
import {checkProjectAccess,type DeveloperApiConfiguration} from "../aws/developer-routes.js";
import {modelIdentityChecks} from "./authority.js";
import type {TaskModelAuthorizationDependencies} from "./authorize-fallback.js";
import type {TransactItem} from "../agents/table-writes.js";
export type TurnActorDependencies=Pick<TaskModelAuthorizationDependencies,"documentClient"|"tableName">&Partial<Pick<TaskModelAuthorizationDependencies,"signInStore"|"modelSignInTableName">>&{developer?:DeveloperApiConfiguration;allowImplicitSlack?:boolean};
type Deps=TurnActorDependencies;
const refused=()=>agentXError("MODEL_NOT_ALLOWED","Your project or company access changed. Reload and check your access.");
async function read(deps:Deps,Key:{pk:string;sk:string}) {return (await deps.documentClient.send(new GetCommand({TableName:deps.tableName,Key,ConsistentRead:true})) as {Item?:Record<string,unknown>}).Item;}
export async function readTurnActorChecks(deps:Deps,input:{orgId:OrgId;project:string;developerId:string;signedInId?:string;projectRevision?:number;task?:DeveloperTaskRecord;slackUserId?:string;threadChannel?:{teamId:string;channelId:string}}):Promise<TransactItem[]> {
 const member=await read(deps,orgMemberKey(input.orgId,input.developerId)),role=OrgRoleSchema.safeParse(member?.role);
 const slackBasis=input.threadChannel!==undefined&&input.slackUserId!==undefined;
 const checks:TransactItem[]=[];
 let orgRole:"owner"|"admin"|"member";
 // The Auditor reads the audit log and nothing else: it never acts for a task turn, whatever grant or channel it may also hold.
 if(!role.success||member?.orgId!==input.orgId||member.developerId!==input.developerId) {
  // Single-org Slack service callers existed before browser sign-in. Never infer
  // this authority for a CLI caller, a tenant-resolving install, or a removed/banned person.
  if(member!==undefined||!deps.allowImplicitSlack||!slackBasis||developerIdForSlackUser(input.slackUserId!)!==input.developerId)throw refused();
  const keys=[orgMemberKey(input.orgId,input.developerId),developerOrgKey(input.developerId),orgRemovedKey(input.orgId,input.developerId),orgBanKey(input.orgId,input.developerId)];
  for(const Key of keys){if(await read(deps,Key)!==undefined)throw refused();checks.push({ConditionCheck:{TableName:deps.tableName,Key,ConditionExpression:"attribute_not_exists(pk)"}});}
  checks.push({ConditionCheck:{TableName:deps.tableName,Key:orgMetaKey(input.orgId),ConditionExpression:"orgId = :org AND attribute_not_exists(closingAt) AND attribute_not_exists(closedAt)",ExpressionAttributeValues:{":org":input.orgId}}});
  orgRole="member";
 } else {
  if(role.data==="auditor")throw refused();
  orgRole=role.data;checks.push(...budgetActorChecks(deps.tableName,input.orgId,{developerId:input.developerId,role:role.data}));}
 const person=await deps.signInStore?.getDeveloper(input.developerId);
 if(person!==undefined) {
  if(deps.signInStore===undefined||deps.modelSignInTableName===undefined)throw refused();
  checks.push(...await modelIdentityChecks({...deps,signInStore:deps.signInStore,modelSignInTableName:deps.modelSignInTableName},{signedInId:input.signedInId??input.developerId,developerId:input.developerId}));
 } else {
  if(!slackBasis||developerIdForSlackUser(input.slackUserId!)!==input.developerId)throw refused();
  if(deps.modelSignInTableName!==undefined)checks.push({ConditionCheck:{TableName:deps.modelSignInTableName,Key:{pk:`DEVELOPER#${input.developerId}`,sk:"META"},ConditionExpression:"attribute_not_exists(pk)"}});
 }
 if(slackBasis) {
  const Key=slackTeamOrgKey(input.threadChannel!.teamId),team=await read(deps,Key);if(team?.orgId!==input.orgId)throw refused();
  checks.push({ConditionCheck:{TableName:deps.tableName,Key,ConditionExpression:"orgId = :turnOrg",ExpressionAttributeValues:{":turnOrg":input.orgId}}});
 }
 if(input.task!==undefined) {
  const task=input.task;
  if(task.orgId!==input.orgId||task.project!==input.project||effectiveTaskOwner(task).developerId!==input.developerId||task.closedAt!==undefined||task.outcome!==undefined)throw refused();
  const owner=ownerFenceOf(task);
  checks.push({ConditionCheck:{TableName:deps.tableName,Key:taskKey(task.taskId),ConditionExpression:"orgId = :turnTaskOrg AND taskId = :turnTaskId AND workspaceId = :turnTaskWorkspace AND #turnProject = :turnProject AND attribute_not_exists(closedAt) AND attribute_not_exists(outcome) AND "+owner.expression,ExpressionAttributeNames:{...owner.names,"#turnProject":"project"},ExpressionAttributeValues:{...owner.values,":turnTaskOrg":input.orgId,":turnTaskId":task.taskId,":turnTaskWorkspace":task.workspaceId,":turnProject":input.project}}},{ConditionCheck:{TableName:deps.tableName,Key:taskPointerKey(task.workspaceId),ConditionExpression:"taskId = :turnTaskId",ExpressionAttributeValues:{":turnTaskId":task.taskId}}});
 }
 if(orgRole!=="owner"&&orgRole!=="admin") {
  const Key=projectMemberKey(input.orgId,input.developerId,input.project),grant=await read(deps,Key);
  let channelAccess=false;
  if(grant===undefined&&input.task!==undefined) {
   checks.push({ConditionCheck:{TableName:deps.tableName,Key,ConditionExpression:"attribute_not_exists(pk)"}});
   channelAccess=true;
  } else if(grant===undefined&&input.threadChannel!==undefined) {
   const {teamId,channelId}=input.threadChannel,bindingKey=slackBindingKey(input.orgId,teamId,channelId),binding=await read(deps,bindingKey);
   if(binding?.teamId!==teamId||binding.channelId!==channelId||binding.projectName!==input.project||typeof binding.updatedAt!=="string")throw refused();
   checks.push({ConditionCheck:{TableName:deps.tableName,Key:bindingKey,ConditionExpression:"teamId = :team AND channelId = :channel AND projectName = :project AND updatedAt = :updated",ExpressionAttributeValues:{":team":teamId,":channel":channelId,":project":input.project,":updated":binding.updatedAt}}},{ConditionCheck:{TableName:deps.tableName,Key,ConditionExpression:"attribute_not_exists(pk)"}});
   channelAccess=true;
  } else if(grant===undefined&&deps.developer!==undefined) {
   const person=await deps.signInStore?.getDeveloper(input.developerId);
   if(person?.slackUserId!==undefined) {
    const memberChannels=new Set<string>(),developer=deps.developer;
    const access=await checkProjectAccess({...deps,developer:{...developer,channelMembers:async request=>{const result=await developer.channelMembers(request);if(result.ok)for(const id of result.memberOf)if(request.channelIds.includes(id))memberChannels.add(id);return result;}},now:Date.now},{orgId:input.orgId,developerId:input.developerId,orgRole,slackUserId:person.slackUserId},input.project);
    if(access.access!=="channel"||access.revision!==input.projectRevision||access.channelIds.length===0||deps.developer.slackTeamId===undefined)throw refused();
    // One live matching channel is sufficient; fence its exact local binding. The caller
    // also fences the current project definition/policy read before this access check.
    const channelId=access.channelIds.find(id=>memberChannels.has(id));if(channelId===undefined)throw refused();
    const teamId=deps.developer.slackTeamId,bindingKey=slackBindingKey(input.orgId,teamId,channelId),binding=await read(deps,bindingKey);
    if(binding?.teamId!==teamId||binding.channelId!==channelId||binding.projectName!==input.project||typeof binding.updatedAt!=="string")throw refused();
    checks.push({ConditionCheck:{TableName:deps.tableName,Key:bindingKey,ConditionExpression:"teamId = :team AND channelId = :channel AND projectName = :project AND updatedAt = :updated",ExpressionAttributeValues:{":team":teamId,":channel":channelId,":project":input.project,":updated":binding.updatedAt}}});
    const personCheck=checks.find(item=>item.ConditionCheck?.TableName===deps.modelSignInTableName&&item.ConditionCheck?.Key?.pk===`DEVELOPER#${input.developerId}`)?.ConditionCheck;
    if(personCheck===undefined)throw refused();personCheck.ConditionExpression+=" AND slackUserId = :turnSlackUser";personCheck.ExpressionAttributeValues={...personCheck.ExpressionAttributeValues,":turnSlackUser":person.slackUserId};
    checks.push({ConditionCheck:{TableName:deps.tableName,Key,ConditionExpression:"attribute_not_exists(pk)"}});
    channelAccess=true;
   }
  }
  const projectRole=effectiveProjectRole({orgRole,developerId:input.developerId},grant,channelAccess);
  if(projectRole===undefined||projectRole==="viewer")throw refused();
  if(grant!==undefined)checks.push({ConditionCheck:{TableName:deps.tableName,Key,ConditionExpression:"attribute_exists(pk) AND #role = :role AND "+(grant.projectRole===undefined?"attribute_not_exists(projectRole)":"projectRole = :projectRole"),ExpressionAttributeNames:{"#role":"role"},ExpressionAttributeValues:{":role":grant.role,...(grant.projectRole===undefined?{}:{":projectRole":grant.projectRole})}}});
 }
 return checks;
}
