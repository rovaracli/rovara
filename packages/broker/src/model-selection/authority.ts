// Server-only commit fences for a process-model change. No new authority store or writes.
import {GetCommand} from "@aws-sdk/lib-dynamodb";
import { canonicalJson, agentXError, projectMemberKey, type OrgId } from "@rovara-code/contracts";
import { orgMemberKey, OrgRoleSchema, type OrgRole, isWriterOrgRole } from "@agentx/cloud-contracts";
import {budgetActorChecks} from "../agents/budget-authority.js";
import {projectAiLifecycleChecks} from "../spend/project-ai-authority.js";
import type {TransactItem} from "../agents/table-writes.js";
import type {ApprovalDependencies} from "../agents/approvals.js";
export const modelAuthorityRefused=()=>agentXError("FORBIDDEN","Your project or company access changed. Reload before changing model choices.");
export async function processModelAuthorityChecks(deps:ApprovalDependencies,input:{orgId:OrgId;project:string;registeredAt:string;signedInId:string;developerId:string;role:OrgRole}):Promise<TransactItem[]> {
 if(deps.modelSignInTableName===undefined) throw agentXError("RUNTIME_UNAVAILABLE","The model authority check is unavailable.");
 const checks=budgetActorChecks(deps.tableName,input.orgId,{developerId:input.developerId,role:input.role});
 const lifecycle=await projectAiLifecycleChecks(deps,input.orgId,input.project);
 const identity=lifecycle[0]?.ConditionCheck;
 if(identity===undefined) throw modelAuthorityRefused();
 identity.ConditionExpression+=" AND #g3RegisteredAt = :g3RegisteredAt";
 identity.ExpressionAttributeNames={...identity.ExpressionAttributeNames,"#g3RegisteredAt":"registeredAt"};
 identity.ExpressionAttributeValues={...identity.ExpressionAttributeValues,":g3RegisteredAt":input.registeredAt};
 checks.push(...lifecycle);
 if(input.role!=="owner"&&input.role!=="admin") {
  const key=projectMemberKey(input.orgId,input.developerId,input.project);
  const row=(await deps.documentClient.send(new GetCommand({TableName:deps.tableName,Key:key,ConsistentRead:true})) as {Item?:Record<string,unknown>}).Item;
  if(row?.role!=="developer"||row.entityType!=="MEMBERSHIP"||row.projectRole!=="maintainer"||row.ownerKey!==input.developerId||row.projectName!==input.project||typeof row.grantId!=="string") throw modelAuthorityRefused();
  checks.push({ConditionCheck:{TableName:deps.tableName,Key:key,ConditionExpression:"#nativeRole = :nativeRole AND entityType = :entity AND ownerKey = :person AND projectName = :project AND projectRole = :role AND grantId = :grant",ExpressionAttributeNames:{"#nativeRole":"role"},ExpressionAttributeValues:{":nativeRole":"developer",":entity":"MEMBERSHIP",":person":input.developerId,":project":input.project,":role":"maintainer",":grant":row.grantId}}});
 }
 return [...checks,...await modelIdentityChecks(deps,{signedInId:input.signedInId,developerId:input.developerId})];
}

/** Shared execution/change identity fence: the current resolver's existing eight-hop bound. */
export async function modelIdentityChecks(deps:Pick<ApprovalDependencies,"documentClient"|"signInStore"|"modelSignInTableName">,input:{signedInId:string;developerId:string}):Promise<TransactItem[]> {
 if(deps.modelSignInTableName===undefined)throw agentXError("RUNTIME_UNAVAILABLE","The model authority check is unavailable.");
 const checks:TransactItem[]=[];
 // Match the existing identity resolver's eight-hop bound; every link and the survivor are fenced.
 let current=input.signedInId;const seen=new Set<string>();
 for(let hop=0;hop<8&&!seen.has(current);hop++) {
  seen.add(current);const row=await deps.signInStore.getDeveloper(current);
  if(row===undefined||row.revoked) throw modelAuthorityRefused();
  const next=row.mergedInto;
  checks.push({ConditionCheck:{TableName:deps.modelSignInTableName,Key:{pk:`DEVELOPER#${current}`,sk:"META"},ConditionExpression:"attribute_exists(pk) AND (attribute_not_exists(revoked) OR revoked = :false) AND "+(next===undefined?"attribute_not_exists(mergedInto)":"mergedInto = :next"),ExpressionAttributeValues:{":false":false,...(next===undefined?{}:{":next":next})}}});
  if(next===undefined){if(current!==input.developerId) throw modelAuthorityRefused();return checks;}
  current=next;
 }
 throw modelAuthorityRefused();
}

/** DynamoDB permits one operation per item. Equal fences share the key; moving snapshots refuse. */
export function mergeProcessModelAuthorityChecks(groups:readonly (readonly TransactItem[])[]):TransactItem[] {
 const result=new Map<string,TransactItem>();
 for(const item of groups.flat()) {
  if(item.ConditionCheck===undefined) throw modelAuthorityRefused();
  const key=canonicalJson([item.ConditionCheck.TableName,item.ConditionCheck.Key]);
  const old=result.get(key);
  if(old!==undefined&&canonicalJson(old)!==canonicalJson(item)) throw modelAuthorityRefused();
  result.set(key,item);
 }
 return [...result.values()];
}

/** Slack/CLI selection uses the same native model-change authority, with role read live. */
export async function projectModelSelectionAuthorityChecks(deps:ApprovalDependencies,input:{orgId:OrgId;project:string;registeredAt:string;signedInId:string;developerId:string}):Promise<TransactItem[]> {
 const row=(await deps.documentClient.send(new GetCommand({TableName:deps.tableName,Key:orgMemberKey(input.orgId,input.developerId),ConsistentRead:true})) as {Item?:Record<string,unknown>}).Item;
 const role=OrgRoleSchema.safeParse(row?.role);
 if(!role.success||!isWriterOrgRole(role.data)||row?.orgId!==input.orgId||row.developerId!==input.developerId)throw modelAuthorityRefused();
 return processModelAuthorityChecks(deps,{...input,role:role.data});
}
