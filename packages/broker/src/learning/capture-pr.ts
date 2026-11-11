import { groupCorrections } from "./grouping.js";
import { prCaptureOff } from "./settings.js";
import { metricMonth, metricUpdateItem, ensureMetricCurrent } from "./metric.js";
// B8: only the already-authorized linked-task feedback reader calls this module.
import { createHash } from "node:crypto";
import { GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { agentGuardrailsKey, githubMemberKey, projectMemberKey, projectMetaKey, projectLearningKey, type OrgId } from "@rovara-code/contracts";
import { orgMemberKey, orgMetaKey } from "@agentx/cloud-contracts";
import type { GitHubFeedbackComment } from "../github-app.js";
import { readGuardrails } from "../agents/guardrails.js";
import { learningScopeOf, learningSalt, readStanding } from "./standing.js";
import { prepareCorrection } from "./text.js";
import { signatureOf } from "./similarity.js";
import { captureCorrection, getLearningItem, sourceSk, type LearningDeps } from "./store.js";
type Row = Record<string, unknown>;
type Tx = NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]>[number];
const hash = (value: string) => createHash("sha256").update(value,"utf8").digest("hex");
async function read(deps: LearningDeps,key:{pk:string;sk:string}) { return (await deps.documentClient.send(new GetCommand({TableName:deps.tableName,Key:key,ConsistentRead:true})) as {Item?:Row}).Item; }
function pin(deps:LearningDeps,key:{pk:string;sk:string},row:Row|undefined,fields:string[]):Tx {
 const names:Record<string,string>={}, values:Record<string,unknown>={};const clauses=fields.map((field,i)=>{names[`#f${i}`]=field;if(row?.[field]===undefined)return `attribute_not_exists(#f${i})`;values[`:v${i}`]=row[field];return `#f${i} = :v${i}`;});
 return {ConditionCheck:{TableName:deps.tableName,Key:key,ConditionExpression:row===undefined?"attribute_not_exists(pk)":`attribute_exists(pk) AND ${clauses.join(" AND ")}`,...(row===undefined?{}:{ExpressionAttributeNames:names,...(Object.keys(values).length?{ExpressionAttributeValues:values}:{})})}};
}
export interface PrCaptureInput { task:{taskId:string;orgId:OrgId;project:string};installationOrgId:OrgId|undefined;repositoryId:string;comments:readonly GitHubFeedbackComment[]; budget?:{remaining:number;skipped:number} }
/** No login lookup, vendor call, log text or deletion on lock-off. Every correction write fences the settings and live identity read. */
export async function capturePullRequestCorrections(deps:LearningDeps,input:PrCaptureInput):Promise<{captured:number;updated:number;skippedUnlinked:number}> {
 const result={captured:0,updated:0,skippedUnlinked:0}, {task}=input,budget=input.budget??{remaining:20,skipped:0};
 if(!Number.isInteger(budget.remaining)||budget.remaining<0||budget.remaining>20||!Number.isInteger(budget.skipped)||budget.skipped<0)return result;
 if(input.installationOrgId!==task.orgId)return result;
 const scope=await learningScopeOf(deps,task.orgId,task.project);if(!scope)return result;
 const companyKey=orgMetaKey(task.orgId),company=await read(deps,companyKey);if(company?.orgId!==task.orgId||company.closingAt!==undefined||company.closedAt!==undefined)return result;
 const settingKey=projectLearningKey(task.orgId,task.project,"SETTINGS"),settings=await getLearningItem(deps,scope,"SETTINGS");
 if(settings?.prComments!=="on"||(await readGuardrails(deps,task.orgId)).prCommentLearning==="locked_off")return result;
 const guardKey=agentGuardrailsKey(task.orgId),guard=await read(deps,guardKey);
 if((guard?.guardrails as {prCommentLearning?:unknown}|undefined)?.prCommentLearning==="locked_off")return result;
 const projectKey=projectMetaKey(task.orgId,task.project),project=await read(deps,projectKey);
 const base=[pin(deps,companyKey,company,["orgId","closingAt","closedAt"]),pin(deps,settingKey,settings,["prComments","revision","projectCreatedAt"]),pin(deps,guardKey,guard,["revision","guardrails"]),pin(deps,projectKey,project,["createdAt","status"])];
 for(const comment of input.comments.slice(0,500)) {
  if(result.captured>=20||budget.remaining===0)break;
  if(comment.authorType!=="User"||!comment.authorId||!/^[1-9][0-9]{0,19}$/.test(comment.authorId)||/\[bot\]$/i.test(comment.author)){result.skippedUnlinked++;budget.skipped++;continue;}
  const linkKey=githubMemberKey(task.orgId,comment.authorId),link=await read(deps,linkKey),person=link?.developerId;
  if(link?.entityType!=="GITHUB_MEMBER"||link.orgId!==task.orgId||link.githubUserId!==comment.authorId||typeof person!=="string"){result.skippedUnlinked++;budget.skipped++;continue;}
  const memberKey=orgMemberKey(task.orgId,person),member=await read(deps,memberKey),grantKey=projectMemberKey(task.orgId,person,task.project),grant=await read(deps,grantKey);
  if(await readStanding(deps,task.orgId,person,task.project)!=="member"){result.skippedUnlinked++;budget.skipped++;continue;}
  const prepared=prepareCorrection(comment.body);if(!prepared.ok)continue;
  const signature=[...signatureOf(prepared.text,learningSalt(scope))],bodyDigest=hash(comment.body),sourceKey=`pr#${input.repositoryId}#${comment.id}`,source=await getLearningItem(deps,scope,sourceSk(scope.projectCreatedAt,sourceKey));
  if(source?.bodyDigest===bodyDigest)continue;
  const conditions=[...base,pin(deps,linkKey,link,["entityType","orgId","githubUserId","developerId"]),pin(deps,memberKey,member,["orgId","developerId","role"]),pin(deps,grantKey,grant,["role","projectRole","ownerKey","projectName","grantId"])];
  const fenced:LearningDeps={...deps,documentClient:{send:command=>deps.documentClient.send(command instanceof TransactWriteCommand?new TransactWriteCommand({...command.input,TransactItems:[...(command.input.TransactItems??[]),...conditions]}):command)}};
  const sourceRef={taskId:task.taskId,repositoryId:input.repositoryId,feedbackCommentId:comment.id,bodyDigest};
  if(source!==undefined){
   if(typeof source.correctionSk!=="string"||typeof source.bodyDigest!=="string")continue;
   const correction=await getLearningItem(deps,scope,source.correctionSk);if(!correction||correction.suggestionId!==undefined||correction.text===undefined)continue;
   const metricItems:Tx[]=[];
   if(typeof correction.groupedAt==="string"&&typeof correction.createdAt==="string"){
    const month=metricMonth(correction.createdAt);await ensureMetricCurrent(deps,scope,month);
    const repeat=typeof correction.repeatOf==="string",rule=repeat&&(correction.repeatOfRule===true||await getLearningItem(deps,scope,`RULE#${String(correction.repeatOf)}`)!==undefined);
    metricItems.push(metricUpdateItem(deps,scope,month,{memberCorrections:-1,prMemberCorrections:-1,...(repeat?{repeats:-1,prRepeats:-1}:{}),...(rule?{repeatsOfAcceptedRules:-1,prRepeatsOfAcceptedRules:-1}:{})}));
   }
   try{await fenced.documentClient.send(new TransactWriteCommand({TransactItems:[
    {Update:{TableName:deps.tableName,Key:projectLearningKey(task.orgId,task.project,source.correctionSk),UpdateExpression:"SET #text = :text, signature = :signature, sourceRef = :ref REMOVE groupedAt, repeatOf, repeatOfRule",ConditionExpression:`projectCreatedAt = :pc AND attribute_not_exists(suggestionId) AND ${correction.groupedAt===undefined?"attribute_not_exists(groupedAt)":"groupedAt = :grouped"} AND attribute_exists(#text)`,ExpressionAttributeNames:{"#text":"text"},ExpressionAttributeValues:{":text":prepared.text,":signature":signature,":ref":sourceRef,":pc":scope.projectCreatedAt,...(correction.groupedAt===undefined?{}:{":grouped":correction.groupedAt})}}},
    {Update:{TableName:deps.tableName,Key:projectLearningKey(task.orgId,task.project,sourceSk(scope.projectCreatedAt,sourceKey)),UpdateExpression:"SET bodyDigest = :next",ConditionExpression:"bodyDigest = :before AND projectCreatedAt = :pc",ExpressionAttributeValues:{":next":bodyDigest,":before":source.bodyDigest,":pc":scope.projectCreatedAt}}},
    ...metricItems,
   ]}));result.updated++;}catch(error){if(!(error instanceof Error)||error.name!=="TransactionCanceledException")throw error;}
  }else{const captured=await captureCorrection(fenced,scope,{id:hash(`${scope.projectCreatedAt}\0${sourceKey}`).slice(0,32),stage:"build",source:"pr_comment",sourceKey,sourceRef,taskId:task.taskId,text:prepared.text,signature,author:person,githubUserId:comment.authorId,standing:"member",bodyDigest,limit:"automatic_pr"});if(captured.ok&&captured.created){result.captured++;budget.remaining--;}if(!captured.ok)break;}
 }
 try{await groupCorrections(deps,scope,{prCaptureOff});}catch{console.log(JSON.stringify({component:"learning",event:"pr_grouping_deferred"}));}
 try{await deps.documentClient.send(new UpdateCommand({TableName:deps.tableName,Key:settingKey,UpdateExpression:"SET skippedUnlinked = :count",ConditionExpression:"projectCreatedAt = :pc AND #revision = :revision AND prComments = :on",ExpressionAttributeNames:{"#revision":"revision"},ExpressionAttributeValues:{":count":Math.min(25000,budget.skipped),":pc":scope.projectCreatedAt,":revision":settings.revision,":on":"on"}}));}catch(error){if(!(error instanceof Error)||error.name!=="ConditionalCheckFailedException")throw error;}
 return result;
}
