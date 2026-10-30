// Shared current-person commit fences for ordinary project coding turns.
import {GetCommand} from "@aws-sdk/lib-dynamodb";
import {OrgRoleSchema,agentXError,orgMemberKey,projectMemberKey,type OrgId} from "@agentx/contracts";
import {budgetActorChecks} from "../agents/budget-authority.js";
import {grantRoleOf} from "../developer/project-roles.js";
import {modelIdentityChecks} from "./authority.js";
import type {TaskModelAuthorizationDependencies} from "./authorize-fallback.js";
import type {TransactItem} from "../agents/table-writes.js";
type Deps=Pick<TaskModelAuthorizationDependencies,"documentClient"|"tableName"|"signInStore"|"modelSignInTableName">;
const refused=()=>agentXError("MODEL_NOT_ALLOWED","Your project or company access changed. Reload and check your access.");
async function read(deps:Deps,Key:{pk:string;sk:string}) {return (await deps.documentClient.send(new GetCommand({TableName:deps.tableName,Key,ConsistentRead:true})) as {Item?:Record<string,unknown>}).Item;}
export async function readTurnActorChecks(deps:Deps,input:{orgId:OrgId;project:string;developerId:string;signedInId?:string}):Promise<TransactItem[]> {
 const member=await read(deps,orgMemberKey(input.orgId,input.developerId)),role=OrgRoleSchema.safeParse(member?.role);
 if(!role.success||member?.orgId!==input.orgId||member.developerId!==input.developerId)throw refused();
 const identity=await modelIdentityChecks(deps,{signedInId:input.signedInId??input.developerId,developerId:input.developerId});
 const checks:TransactItem[]=[...budgetActorChecks(deps.tableName,input.orgId,{developerId:input.developerId,role:role.data}),...identity];
 if(role.data!=="owner"&&role.data!=="admin") {
  const Key=projectMemberKey(input.orgId,input.developerId,input.project),grant=await read(deps,Key),projectRole=grantRoleOf(grant);
  if(grant===undefined||projectRole===undefined||projectRole==="viewer")throw refused();
  checks.push({ConditionCheck:{TableName:deps.tableName,Key,ConditionExpression:"attribute_exists(pk) AND #role = :role AND "+(grant.projectRole===undefined?"attribute_not_exists(projectRole)":"projectRole = :projectRole"),ExpressionAttributeNames:{"#role":"role"},ExpressionAttributeValues:{":role":grant.role,...(grant.projectRole===undefined?{}:{":projectRole":grant.projectRole})}}});
 }
 return checks;
}
