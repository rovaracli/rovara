// Internal safer-change core; the public adapter must route less-safe changes
// through the existing approval flow. No caller-supplied approval flag is accepted.
import {createHash} from "node:crypto";
import {TransactWriteCommand} from "@aws-sdk/lib-dynamodb";
import { ModelSelectionPolicyPutSchema, agentXError, canonicalJson, STAGE_IDS, agentRequestKey, INDEX_EXPIRY_ATTRIBUTE, approvalKey, type OrgId } from "@rovara-code/contracts";
import {commit,readRequest} from "../agents/table-writes.js";
import {getApproval,type ApprovalRecord,type ApprovalDependencies} from "../agents/approvals.js";
import {auditPending,type AuditRuntime} from "../audit/outbox.js";
import {flushAuditEvents} from "../audit/flush.js";
import {auditModelPolicyChanged,auditModelPolicyLockSet,auditModelPolicyLockRemoved,auditOccurrence} from "../audit/events.js";
import {prepareCompanyModelPolicy} from "./company-prepare.js";
import {requireCompanyModelPolicyAuthority} from "./company-read.js";
import {modelIdentityChecks} from "./authority.js";
import {readSecondPersonApprovalEvidence} from "../org/second-person-evidence.js";
import {decideSecondPersonApproval} from "../org/second-person-approval.js";
import {modelSelectionRevisionChecks,modelSelectionPolicyKey,readModelSelectionPolicy} from "./policy-store.js";
type Dependencies=Parameters<typeof prepareCompanyModelPolicy>[0]&Pick<ApprovalDependencies,"signInStore"|"modelSignInTableName">&{audit?:AuditRuntime};
type Caller={orgId:OrgId;developerId:string;signedInId:string};
const stale=()=>agentXError("POLICY_STALE","The company model policy or your access changed. Reload and review again.");
const unavailable=()=>agentXError("RUNTIME_UNAVAILABLE","Company model changes require the audit ledger.");
const digest=(value:unknown)=>createHash("sha256").update(canonicalJson(value)).digest("hex");
export const writeSaferCompanyModelPolicy=(deps:Dependencies,caller:Caller,value:unknown)=>writePolicy(deps,caller,value);
type Confirmation={record:ApprovalRecord;conditions:Awaited<ReturnType<typeof readSecondPersonApprovalEvidence>>["conditions"];mode:"second_person"|"sole_owner_exception"};
export async function applyApprovedCompanyModelPolicy(deps:Dependencies,record:ApprovalRecord){
 const current=await getApproval(deps,record.orgId,record.approvalId);
 if(current===undefined||current.status!=="EXECUTING"||current.subject.kind!=="model_selection_policy"||current.decidedBy===undefined||current.requestedBy===undefined||canonicalJson(current.subject)!==canonicalJson(record.subject))throw stale();
 if(deps.modelSignInTableName===undefined)throw unavailable();
 const evidence=await readSecondPersonApprovalEvidence({...deps,signInTableName:deps.modelSignInTableName},{orgId:current.orgId,proposerId:current.requestedBy,approverId:current.decidedBy});
 const decision=decideSecondPersonApproval(evidence.decisionInput);
 const approvalCheck={ConditionCheck:{TableName:deps.tableName,Key:approvalKey(current.orgId,current.approvalId),ConditionExpression:"#status = :status AND #subject = :subject AND requestedBy = :requester AND decidedBy = :decider",ExpressionAttributeNames:{"#status":"status","#subject":"subject"},ExpressionAttributeValues:{":status":"EXECUTING",":subject":current.subject,":requester":current.requestedBy,":decider":current.decidedBy}}};
 return writePolicy(deps,{orgId:current.orgId,developerId:current.decidedBy,signedInId:current.decidedBy},current.subject.body,{record:current,conditions:[...evidence.conditions,approvalCheck],mode:decision.mode});
}
async function writePolicy(deps:Dependencies,caller:Caller,value:unknown,confirmation?:Confirmation){
 const authority=confirmation?.conditions??await requireCompanyModelPolicyAuthority(deps,caller);
 const identity=confirmation===undefined?await modelIdentityChecks(deps,caller):[];
 const parsed=ModelSelectionPolicyPutSchema.safeParse(value);
 if(!parsed.success)throw agentXError("CONFIG_INVALID","Review a valid company model policy and request id.");
 const body=parsed.data,fingerprint=digest({action:"model_policy",orgId:caller.orgId,body});
 if(deps.audit===undefined)throw unavailable();
 const requestDeveloperId=confirmation?.record.requestedBy??caller.developerId;
 const earlier=await readRequest(deps,caller.orgId,requestDeveloperId,body.requestId);
 if(earlier!==undefined){
  if(earlier.fingerprint!==fingerprint)throw agentXError("IDEMPOTENCY_CONFLICT","This request id belongs to another change.");
  const current=await readModelSelectionPolicy(deps,caller.orgId);
  const result={version:1 as const,status:"APPLIED" as const,revision:current.revision,requestId:body.requestId};
  if(canonicalJson(earlier.result)!==canonicalJson(result)||canonicalJson(current.stepOverrides)!==canonicalJson(body.stepOverrides))throw stale();
  await deps.documentClient.send(new TransactWriteCommand({TransactItems:[...authority,...identity,{ConditionCheck:{TableName:deps.tableName,Key:modelSelectionPolicyKey(caller.orgId),...(current.revision===0?{ConditionExpression:"attribute_not_exists(pk)"}:{ConditionExpression:"revision = :revision",ExpressionAttributeValues:{":revision":current.revision}})}},{ConditionCheck:{TableName:deps.tableName,Key:agentRequestKey(caller.orgId,requestDeveloperId,body.requestId),ConditionExpression:"fingerprint = :fingerprint AND #result = :result AND #expires > :now",ExpressionAttributeNames:{"#result":"result","#expires":INDEX_EXPIRY_ATTRIBUTE},ExpressionAttributeValues:{":fingerprint":fingerprint,":result":result,":now":Math.floor(deps.now()/1000)}}}]}));return result;
 }
 const prepared=await prepareCompanyModelPolicy(deps,caller,body);
 if(confirmation!==undefined){
  const subject=confirmation.record.subject;
  if(subject.kind!=="model_selection_policy"||subject.sourcesRevision!==prepared.sourcesRevision||subject.guardrailsRevision!==prepared.guardrailsRevision)throw stale();
 }
 if(prepared.changes.length>0&&confirmation===undefined)throw agentXError("FORBIDDEN","This company model change requires confirmation.");
 const result={version:1 as const,status:"APPLIED" as const,revision:prepared.next.revision,requestId:body.requestId};
 const base={orgId:caller.orgId,actor:{kind:"member" as const,id:caller.developerId},occurredAt:new Date(deps.now()).toISOString(),occurrence:auditOccurrence(body.requestId,"company-model-policy"),revision:prepared.next.revision,policyDigest:digest(prepared.next.stepOverrides),previousDigest:digest(prepared.current.stepOverrides),...(confirmation===undefined?{}:{mode:confirmation.mode})};
 const events=prepared.changed?[auditModelPolicyChanged(base),...STAGE_IDS.filter(stage=>prepared.next.stepOverrides[stage]?.locked===true&&prepared.current.stepOverrides[stage]?.locked!==true).map(stage=>auditModelPolicyLockSet({...base,stage})),...STAGE_IDS.filter(stage=>prepared.current.stepOverrides[stage]?.locked===true&&prepared.next.stepOverrides[stage]?.locked!==true).map(stage=>auditModelPolicyLockRemoved({...base,stage}))]:[];
 const commitConditions=confirmation===undefined?prepared.conditions:[...authority,...modelSelectionRevisionChecks(deps.tableName,caller.orgId,{companyRevision:prepared.current.revision,sourcesRevision:prepared.sourcesRevision,guardrailsRevision:prepared.guardrailsRevision})];
 const policyKey=modelSelectionPolicyKey(caller.orgId),policyCheck=commitConditions.find(item=>item.ConditionCheck?.Key?.pk===policyKey.pk&&item.ConditionCheck.Key.sk===policyKey.sk)?.ConditionCheck;
 if(policyCheck===undefined)throw unavailable();
 const conditions=prepared.changed?commitConditions.filter(item=>item.ConditionCheck!==policyCheck):commitConditions;
 const pending=events.flatMap(event=>auditPending(deps,event));if(pending.length!==events.length)throw unavailable();
 const {Key,...policyPredicate}=policyCheck;void Key;
 const items=[...conditions,...identity,...(prepared.changed?[{Put:{...policyPredicate,Item:{...policyKey,entityType:"MODEL_SELECTION_POLICY",orgId:caller.orgId,...prepared.next,updatedAt:base.occurredAt,updatedBy:caller.developerId}}}]:[]),...pending];
 if(items.length+1>25)throw unavailable();
 await commit(deps,items,stale,{orgId:caller.orgId,developerId:requestDeveloperId,requestId:body.requestId,fingerprint},result);
 await flushAuditEvents(deps,events);return result;
}
