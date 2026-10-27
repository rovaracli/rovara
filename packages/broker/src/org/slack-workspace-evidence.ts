import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { OrgIdSchema, SlackTeamIdSchema, OrgSlackWorkspaceEvidenceResponseSchema, SLACK_WORKSPACE_EVIDENCE_LIMIT, agentXError, orgMemberKey, developerOrgKey, orgMetaKey, orgPk, orgSlackTeamKey, slackTeamOrgKey } from "@agentx/contracts";
import type { DeveloperCaller, DeveloperRouteDependencies } from "../aws/developer-routes.js";
type Deps = Pick<DeveloperRouteDependencies,"documentClient"|"tableName"|"orgs"|"now">;
type Key = {pk:string;sk:string};
const unavailable = () => agentXError("RUNTIME_UNAVAILABLE","Stored Slack workspace evidence is unavailable. Try again later.");
const forbidden = () => agentXError("FORBIDDEN","You don't have permission to view this company's Slack workspace evidence.");
const reverseSchema = z.object({pk:z.string(),sk:z.string(),entityType:z.literal("ORG_SLACK_TEAM"),orgId:OrgIdSchema,teamId:SlackTeamIdSchema,boundAt:z.string().datetime()});
async function read(deps:Deps,key:Key):Promise<Record<string,unknown>|undefined>{
 try {const answer=await deps.documentClient.send(new GetCommand({TableName:deps.tableName,Key:key,ConsistentRead:true})) as {Item?:Record<string,unknown>};return answer.Item;}catch{throw unavailable();}
}
async function authority(deps:Deps,caller:DeveloperCaller){
 const [member,pointer,org]=await Promise.all([read(deps,orgMemberKey(caller.orgId,caller.developerId)),read(deps,developerOrgKey(caller.developerId)),read(deps,orgMetaKey(caller.orgId))]);
 if(member?.orgId!==caller.orgId||member.developerId!==caller.developerId||(member.role!=="owner"&&member.role!=="admin")||pointer?.orgId!==caller.orgId||pointer.role!==member.role||org?.orgId!==caller.orgId||org.closingAt!==undefined||org.closedAt!==undefined)throw forbidden();
}
/** Bounded, read-only stored evidence. Two authority observations are not an atomic configuration snapshot. */
export async function readSlackWorkspaceEvidence(deps:Deps,caller:DeveloperCaller){
 if(deps.orgs===undefined)throw agentXError("NOT_FOUND","Organizations are unavailable in this deployment.");
 await authority(deps,caller);
 let page:unknown;
 try {page=await deps.documentClient.send(new QueryCommand({TableName:deps.tableName,KeyConditionExpression:"pk = :pk AND begins_with(sk, :prefix)",ExpressionAttributeValues:{":pk":orgPk(caller.orgId),":prefix":"SLACK_TEAM#"},ConsistentRead:true,Limit:SLACK_WORKSPACE_EVIDENCE_LIMIT+1}));}catch{throw unavailable();}
 if(page===null||typeof page!=="object"||Array.isArray(page))throw unavailable();
 const result=page as {Items?:unknown;LastEvaluatedKey?:unknown};
 if(result.Items!==undefined&&!Array.isArray(result.Items))throw unavailable();
 const items=(result.Items??[]) as unknown[],selected=items.slice(0,SLACK_WORKSPACE_EVIDENCE_LIMIT),seen=new Set<string>();let associationCount=0,unavailableCount=0;
 // At most50 canonical reads,8 at a time; malformed reverse rows never supply arbitrary read keys.
 for(let start=0;start<selected.length;start+=8){
  const results=await Promise.all(selected.slice(start,start+8).map(async row=>{
   const parsed=reverseSchema.safeParse(row);if(!parsed.success)return false;const value=parsed.data,key=orgSlackTeamKey(caller.orgId,value.teamId);
   if(value.pk!==key.pk||value.sk!==key.sk||value.orgId!==caller.orgId||seen.has(value.teamId))return false;seen.add(value.teamId);
   const canonicalKey=slackTeamOrgKey(value.teamId),canonical=await read(deps,canonicalKey);
   return canonical?.pk===canonicalKey.pk&&canonical.sk===canonicalKey.sk&&canonical.entityType==="SLACK_TEAM_ORG"&&canonical.orgId===caller.orgId&&canonical.boundAt===value.boundAt;
  }));
  for(const valid of results){if(valid)associationCount++;else unavailableCount++;}
 }
 await authority(deps,caller);
 try {return OrgSlackWorkspaceEvidenceResponseSchema.parse({orgId:caller.orgId,checkedAt:new Date(deps.now()).toISOString(),kind:"stored_workspace_associations",associationCount,unavailableCount,coverage:result.LastEvaluatedKey!==undefined||items.length>SLACK_WORKSPACE_EVIDENCE_LIMIT||unavailableCount>0?"partial":"complete",verification:"unverified"});}catch{throw unavailable();}
}
