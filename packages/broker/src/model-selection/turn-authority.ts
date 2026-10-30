// Shared current-person commit fences for ordinary project coding turns.
import {GetCommand} from "@aws-sdk/lib-dynamodb";
import {OrgRoleSchema,agentXError,orgMemberKey,projectMemberKey,slackBindingKey,type OrgId} from "@agentx/contracts";
import {budgetActorChecks} from "../agents/budget-authority.js";
import {effectiveProjectRole} from "../developer/project-roles.js";
import {checkProjectAccess,type DeveloperApiConfiguration} from "../aws/developer-routes.js";
import {modelIdentityChecks} from "./authority.js";
import type {TaskModelAuthorizationDependencies} from "./authorize-fallback.js";
import type {TransactItem} from "../agents/table-writes.js";
type Deps=Pick<TaskModelAuthorizationDependencies,"documentClient"|"tableName"|"signInStore"|"modelSignInTableName">&{developer?:DeveloperApiConfiguration};
const refused=()=>agentXError("MODEL_NOT_ALLOWED","Your project or company access changed. Reload and check your access.");
async function read(deps:Deps,Key:{pk:string;sk:string}) {return (await deps.documentClient.send(new GetCommand({TableName:deps.tableName,Key,ConsistentRead:true})) as {Item?:Record<string,unknown>}).Item;}
export async function readTurnActorChecks(deps:Deps,input:{orgId:OrgId;project:string;developerId:string;signedInId?:string;projectRevision?:number}):Promise<TransactItem[]> {
 const member=await read(deps,orgMemberKey(input.orgId,input.developerId)),role=OrgRoleSchema.safeParse(member?.role);
 if(!role.success||member?.orgId!==input.orgId||member.developerId!==input.developerId)throw refused();
 const identity=await modelIdentityChecks(deps,{signedInId:input.signedInId??input.developerId,developerId:input.developerId});
 const checks:TransactItem[]=[...budgetActorChecks(deps.tableName,input.orgId,{developerId:input.developerId,role:role.data}),...identity];
 if(role.data!=="owner"&&role.data!=="admin") {
  const Key=projectMemberKey(input.orgId,input.developerId,input.project),grant=await read(deps,Key);
  let channelAccess=false;
  if(grant===undefined&&deps.developer!==undefined) {
   const person=await deps.signInStore.getDeveloper(input.developerId);
   if(person?.slackUserId!==undefined) {
    const memberChannels=new Set<string>(),developer=deps.developer;
    const access=await checkProjectAccess({...deps,developer:{...developer,channelMembers:async request=>{const result=await developer.channelMembers(request);if(result.ok)for(const id of result.memberOf)if(request.channelIds.includes(id))memberChannels.add(id);return result;}},now:Date.now},{orgId:input.orgId,developerId:input.developerId,orgRole:role.data,slackUserId:person.slackUserId},input.project);
    if(access.access!=="channel"||access.revision!==input.projectRevision||access.channelIds.length===0||deps.developer.slackTeamId===undefined)throw refused();
    // One live matching channel is sufficient; fence its exact local binding. The caller
    // also fences the current project definition/policy read before this access check.
    const channelId=access.channelIds.find(id=>memberChannels.has(id));if(channelId===undefined)throw refused();
    const teamId=deps.developer.slackTeamId,bindingKey=slackBindingKey(input.orgId,teamId,channelId),binding=await read(deps,bindingKey);
    if(binding?.teamId!==teamId||binding.channelId!==channelId||binding.projectName!==input.project||typeof binding.updatedAt!=="string")throw refused();
    checks.push({ConditionCheck:{TableName:deps.tableName,Key:bindingKey,ConditionExpression:"teamId = :team AND channelId = :channel AND projectName = :project AND updatedAt = :updated",ExpressionAttributeValues:{":team":teamId,":channel":channelId,":project":input.project,":updated":binding.updatedAt}}});
    const personCheck=checks.find(item=>item.ConditionCheck?.TableName===deps.modelSignInTableName&&item.ConditionCheck.Key?.pk===`DEVELOPER#${input.developerId}`)?.ConditionCheck;
    if(personCheck===undefined)throw refused();personCheck.ConditionExpression+=" AND slackUserId = :turnSlackUser";personCheck.ExpressionAttributeValues={...personCheck.ExpressionAttributeValues,":turnSlackUser":person.slackUserId};
    checks.push({ConditionCheck:{TableName:deps.tableName,Key,ConditionExpression:"attribute_not_exists(pk)"}});
    channelAccess=true;
   }
  }
  const projectRole=effectiveProjectRole({orgRole:role.data,developerId:input.developerId},grant,channelAccess);
  if(projectRole===undefined||projectRole==="viewer")throw refused();
  if(grant!==undefined)checks.push({ConditionCheck:{TableName:deps.tableName,Key,ConditionExpression:"attribute_exists(pk) AND #role = :role AND "+(grant.projectRole===undefined?"attribute_not_exists(projectRole)":"projectRole = :projectRole"),ExpressionAttributeNames:{"#role":"role"},ExpressionAttributeValues:{":role":grant.role,...(grant.projectRole===undefined?{}:{":projectRole":grant.projectRole})}}});
 }
 return checks;
}
