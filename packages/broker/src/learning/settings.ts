// B8 effective setting shared with grouping and metric callers: locking stops use, not retention.
import type { LearningDeps, LearningScope } from "./store.js";
import { getLearningItem } from "./store.js";
import { readGuardrails } from "../agents/guardrails.js";
/** Pass as GroupingOptions.prCaptureOff, and its result as readMetric's existing option. */
export async function prCaptureOff(deps:LearningDeps,scope:LearningScope):Promise<boolean> {
 if((await readGuardrails(deps,scope.orgId)).prCommentLearning==="locked_off")return true;
 return (await getLearningItem(deps,scope,"SETTINGS"))?.prComments!=="on";
}

import { randomUUID } from "node:crypto";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { AgentGuardrailsSchema, LearningSettingsSchema, LearningSettingsBodySchema, LearningProposalDecisionBodySchema, agentGuardrailsKey, agentXError, projectLearningKey, projectMetaKey, type OrgId, type LearningSettings } from "@agentx/contracts";
import { learningScopeOf } from "./standing.js";
import { readAllowedDomainActorConditions, readSecondPersonApprovalEvidence, type SecondPersonEvidenceDependencies } from "../org/second-person-evidence.js";
import { decideSecondPersonApproval } from "../org/second-person-approval.js";
import { auditedWrite, learningSettingsAuditEvent } from "../playbook/project-settings-audit.js";
import { flushLearningEvents } from "./audit.js";
export interface LearningSettingsDeps extends LearningDeps, SecondPersonEvidenceDependencies {}
export interface SettingsCaller { orgId: OrgId; developerId: string; browserSession?: true }
type Row = Record<string, unknown>;
type Tx = NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]>[number];
const stale = () => agentXError("CHANGE_STALE", "Learning settings changed. Refresh before deciding.");
const proposalSchema = z.object({ proposalId:z.string().uuid(),by:z.string().regex(/^[a-f0-9]{64}$/),state:z.enum(["pending","approved","declined","cancelled"]),baseRevision:z.number().int().nonnegative(),projectCreatedAt:z.string().datetime(),expiresAt:z.string().datetime(),decidedBy:z.string().optional(),decision:z.enum(["approve","decline"]).optional() });
async function row(deps:LearningDeps,key:{pk:string;sk:string}) {return (await deps.documentClient.send(new GetCommand({TableName:deps.tableName,Key:key,ConsistentRead:true})) as {Item?:Row}).Item;}
function observed(deps:LearningDeps,key:{pk:string;sk:string},seen:Row|undefined,fields:string[]):Tx {
 if(!seen)return {ConditionCheck:{TableName:deps.tableName,Key:key,ConditionExpression:"attribute_not_exists(pk)"}};
 const names:Record<string,string>={},values:Row={};const clauses=fields.map((f,i)=>{names[`#s${i}`]=f;if(seen[f]===undefined)return `attribute_not_exists(#s${i})`;values[`:s${i}`]=seen[f];return `#s${i} = :s${i}`;});
 return {ConditionCheck:{TableName:deps.tableName,Key:key,ConditionExpression:`attribute_exists(pk) AND ${clauses.join(" AND ")}`,ExpressionAttributeNames:names,...(Object.keys(values).length?{ExpressionAttributeValues:values}:{})}};
}
function putObserved(deps:LearningDeps,key:{pk:string;sk:string},seen:Row|undefined,item:Row):Tx {
 const check=observed(deps,key,seen,["revision","projectCreatedAt","pendingProposalId"]).ConditionCheck!;
 const {Key:_key,...condition}=check;void _key;
 return {Put:{...condition,Item:{...key,orgId:item.orgId,...item}}};
}
async function context(deps:LearningSettingsDeps,caller:SettingsCaller,project:string) {
 if(caller.browserSession!==true)throw agentXError("FORBIDDEN","Use a live browser session for learning settings.");
 if(deps.audit===undefined||deps.audit.tableName!==deps.tableName||deps.audit.documentClient!==deps.documentClient)throw agentXError("AUDIT_UNAVAILABLE","Learning setting changes require the audit ledger.");
 const actor=await readAllowedDomainActorConditions(deps,{orgId:caller.orgId,project,actorId:caller.developerId});
 const scope=await learningScopeOf(deps,caller.orgId,project);if(!scope)throw stale();
 const key=projectLearningKey(caller.orgId,project,"SETTINGS"),raw=await row(deps,key),same=raw?.projectCreatedAt===scope.projectCreatedAt;
 const parsed=same?LearningSettingsSchema.safeParse(raw):undefined;if(parsed&&!parsed.success)throw stale();
 const setting:LearningSettings=parsed?.success?parsed.data:{revision:0,prComments:"off",changedBy:caller.developerId,changedAt:new Date(deps.now()).toISOString(),projectCreatedAt:scope.projectCreatedAt};
 const guardKey=agentGuardrailsKey(caller.orgId),guard=await row(deps,guardKey),guardrails=guard===undefined?undefined:AgentGuardrailsSchema.safeParse(guard.guardrails);
 if(guardrails&&!guardrails.success)throw stale();const locked=guardrails?.success&&guardrails.data.prCommentLearning==="locked_off";
 const guardCondition=observed(deps,guardKey,guard,["revision","guardrails"]);
 const projectCondition:Tx={ConditionCheck:{TableName:deps.tableName,Key:projectMetaKey(caller.orgId,project),ConditionExpression:"createdAt = :pc AND #status = :active",ExpressionAttributeNames:{"#status":"status"},ExpressionAttributeValues:{":pc":scope.projectCreatedAt,":active":"active"}}};
 return {scope,key,raw,setting,locked,guardCondition,actor,projectCondition};
}
function view(setting:LearningSettings,locked:boolean) {return {prComments:locked?"off" as const:setting.prComments,locked,...(locked?{lockedBy:"company" as const}:{}),revision:setting.revision,...(setting.pendingProposalId?{pendingProposal:{id:setting.pendingProposalId}}:{})};}
async function pendingIfPresent(deps:LearningDeps,scope:LearningScope,id:string) {
 const key=projectLearningKey(scope.orgId,scope.project,`PROPOSAL#${id}`),raw=await row(deps,key),parsed=proposalSchema.safeParse(raw);
 if(raw===undefined)return undefined;
 if(!parsed.success||parsed.data.proposalId!==id||parsed.data.projectCreatedAt!==scope.projectCreatedAt)throw stale();return {key,raw,value:parsed.data};
}
function terminal(deps:LearningDeps,p:NonNullable<Awaited<ReturnType<typeof pendingIfPresent>>>,state:"approved"|"declined"|"cancelled",by:string,decision?:"approve"|"decline"):Tx {
 return {Update:{TableName:deps.tableName,Key:p.key,UpdateExpression:`SET #state = :terminal, decidedBy = :by${decision?", decision = :decision":""}`,ConditionExpression:"#state = :pending AND projectCreatedAt = :pc AND baseRevision = :base AND #by = :proposer AND expiresAt = :expires AND proposalId = :id",ExpressionAttributeNames:{"#state":"state","#by":"by"},ExpressionAttributeValues:{":proposer":p.value.by,":expires":p.value.expiresAt,":id":p.value.proposalId,":terminal":state,":by":by,":pending":"pending",":pc":p.value.projectCreatedAt,":base":p.value.baseRevision,...(decision?{":decision":decision}:{})}}};
}
async function commit(deps:LearningSettingsDeps,caller:SettingsCaller,c:Awaited<ReturnType<typeof context>>,next:LearningSettings,items:Tx[],sole=false) {
 const audited=await auditedWrite(deps.audit===undefined?{}:{audit:deps.audit},()=>[learningSettingsAuditEvent({orgId:caller.orgId,actor:{kind:"member",id:caller.developerId},occurredAt:next.changedAt,project:c.scope.project,revision:next.revision,enabled:next.prComments==="on",selfConfirmedSoleOwner:sole})]);
 if(audited.items.length!==1||audited.events.length!==1)throw agentXError("AUDIT_UNAVAILABLE","Learning setting changes require the audit ledger.");
 const actions=[putObserved(deps,c.key,c.raw,{entityType:"LEARNING_SETTINGS",orgId:caller.orgId,...next}),...items,...audited.items];if(actions.length>100)throw stale();
 try{await deps.documentClient.send(new TransactWriteCommand({TransactItems:actions}));}catch(error){if(error instanceof Error&&error.name==="TransactionCanceledException")throw stale();throw error;}
 await flushLearningEvents(deps,audited.events);
}
async function retryPrWithdrawal(deps:LearningDeps,scope:LearningScope):Promise<void> {
 try{const {withdrawPrDependentSuggestions}=await import("./grouping.js");await withdrawPrDependentSuggestions(deps,scope);}
 catch{console.log(JSON.stringify({component:"learning",event:"pr_withdrawal_deferred"}));}
}
export async function writeLearningSettings(deps:LearningSettingsDeps,caller:SettingsCaller,project:string,body:unknown) {
 const parsed=LearningSettingsBodySchema.safeParse(body);if(!parsed.success)throw agentXError("CONFIG_INVALID","Learning settings body is not valid.");const input=parsed.data,c=await context(deps,caller,project);
 if(input.expectedRevision!==c.setting.revision)throw stale();const now=deps.now(),changedAt=new Date(now).toISOString();
 const next:LearningSettings={...c.setting,revision:c.setting.revision+1,changedBy:caller.developerId,changedAt};const items:Tx[]=[...c.actor,c.projectCondition,c.guardCondition];
 const old=c.setting.pendingProposalId?await pendingIfPresent(deps,c.scope,c.setting.pendingProposalId):undefined;
 if(input.prComments==="off"){
  if(c.setting.prComments==="off"&&c.setting.pendingProposalId===undefined){await retryPrWithdrawal(deps,c.scope);return {applied:true as const,settings:view(c.setting,c.locked===true)};}
  next.prComments="off";delete next.pendingProposalId;if(old?.value.state==="pending")items.push(terminal(deps,old,"cancelled",caller.developerId));
  await commit(deps,caller,c,next,items);await retryPrWithdrawal(deps,c.scope);
  return {applied:true as const,settings:view(next,c.locked===true)};
 }
 if(c.locked)throw agentXError("FORBIDDEN","PR-comment learning is locked off by your company.");
 if(c.setting.prComments==="on"&&!old)return {applied:true as const,settings:view(c.setting,false)};
 if(old?.value.state==="pending"&&Date.parse(old.value.expiresAt)>now)throw stale();
 if(old?.value.state==="pending")items.push(terminal(deps,old,"cancelled",caller.developerId));
 const proposalId=randomUUID();next.pendingProposalId=proposalId;
 items.push({Put:{TableName:deps.tableName,Item:{...projectLearningKey(caller.orgId,project,`PROPOSAL#${proposalId}`),entityType:"LEARNING_SETTINGS_PROPOSAL",orgId:caller.orgId,proposalId,by:caller.developerId,state:"pending",baseRevision:next.revision,projectCreatedAt:c.scope.projectCreatedAt,expiresAt:new Date(now+86400000).toISOString(),indexExpiresAt:Math.floor(now/1000)+31*86400},ConditionExpression:"attribute_not_exists(pk)"}});
 await commit(deps,caller,c,next,items);return {applied:false as const,proposalId};
}
export async function decideLearningSettings(deps:LearningSettingsDeps,caller:SettingsCaller,project:string,id:string,body:unknown) {
 const parsed=LearningProposalDecisionBodySchema.safeParse(body);if(!parsed.success||!z.string().uuid().safeParse(id).success)throw agentXError("CONFIG_INVALID","Learning decision body is not valid.");
 const c=await context(deps,caller,project),p=await pendingIfPresent(deps,c.scope,id),decision=parsed.data.decision;
 if(c.setting.pendingProposalId===id&&(p===undefined||(p.value.state==="pending"&&Date.parse(p.value.expiresAt)<=deps.now()))){
  const next:LearningSettings={...c.setting,revision:c.setting.revision+1,changedBy:caller.developerId,changedAt:new Date(deps.now()).toISOString()};delete next.pendingProposalId;
  await commit(deps,caller,c,next,[...c.actor,c.projectCondition,c.guardCondition,...(p===undefined?[]:[terminal(deps,p,"cancelled",caller.developerId,decision)])]);return {settings:view(next,c.locked===true)};
 }
 if(p===undefined)throw stale();
 if(p.value.state!=="pending"){if(p.value.decidedBy===caller.developerId&&p.value.decision===decision)return {settings:view(c.setting,c.locked===true)};throw stale();}
 if(c.setting.pendingProposalId!==id||c.setting.revision!==p.value.baseRevision||Date.parse(p.value.expiresAt)<=deps.now())throw stale();
 let conditions:Tx[],sole=false;
 if(decision==="approve"){
  if(c.locked)throw agentXError("FORBIDDEN","PR-comment learning is locked off by your company.");
  const evidence=await readSecondPersonApprovalEvidence(deps,{orgId:caller.orgId,project,proposerId:p.value.by,approverId:caller.developerId});sole=decideSecondPersonApproval(evidence.decisionInput).mode==="sole_owner_exception";if(sole&&parsed.data.soleOwnerAcknowledged!==true)throw agentXError("FORBIDDEN","Explicitly acknowledge the sole-owner learning exception.");conditions=evidence.conditions;
 }else conditions=[...c.actor,c.projectCondition];
 const next:LearningSettings={...c.setting,prComments:decision==="approve"?"on":"off",revision:c.setting.revision+1,changedBy:caller.developerId,changedAt:new Date(deps.now()).toISOString()};delete next.pendingProposalId;
 await commit(deps,caller,c,next,[...conditions,c.guardCondition,terminal(deps,p,decision==="approve"?"approved":"declined",caller.developerId,decision)],sole);return {settings:view(next,c.locked===true)};
}

/** A bounded count from the latest authorized delivery, never author ids or comment text. */
export async function skippedPrCommentCount(deps:LearningDeps,orgId:OrgId,project:string):Promise<number> {
 const scope=await learningScopeOf(deps,orgId,project);if(!scope)return 0;const stored=await getLearningItem(deps,scope,"SETTINGS"),n=stored?.skippedUnlinked;
 return typeof n==="number"&&Number.isSafeInteger(n)&&n>=0?Math.min(25000,n):0;
}
