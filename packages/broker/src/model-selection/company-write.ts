// Internal safer-change core; the public adapter must route less-safe changes
// through the existing approval flow. No caller-supplied approval flag is accepted.
import {createHash} from "node:crypto";
import {TransactWriteCommand} from "@aws-sdk/lib-dynamodb";
import {ModelSelectionPolicyPutSchema,agentXError,canonicalJson,STAGE_IDS,agentRequestKey,INDEX_EXPIRY_ATTRIBUTE,type OrgId} from "@agentx/contracts";
import {commit,readRequest} from "../agents/table-writes.js";
import type {ApprovalDependencies} from "../agents/approvals.js";
import {auditPending,type AuditRuntime} from "../audit/outbox.js";
import {flushAuditEvents} from "../audit/flush.js";
import {auditModelPolicyChanged,auditModelPolicyLockSet,auditOccurrence} from "../audit/events.js";
import {prepareCompanyModelPolicy} from "./company-prepare.js";
import {requireCompanyModelPolicyAuthority} from "./company-read.js";
import {modelIdentityChecks} from "./authority.js";
import {modelSelectionPolicyKey,readModelSelectionPolicy} from "./policy-store.js";
type Dependencies=Parameters<typeof prepareCompanyModelPolicy>[0]&Pick<ApprovalDependencies,"signInStore"|"modelSignInTableName">&{audit?:AuditRuntime};
type Caller={orgId:OrgId;developerId:string;signedInId:string};
const stale=()=>agentXError("CHANGE_STALE","The company model policy or your access changed. Reload and review again.");
const unavailable=()=>agentXError("RUNTIME_UNAVAILABLE","Company model changes require the audit ledger.");
const digest=(value:unknown)=>createHash("sha256").update(canonicalJson(value)).digest("hex");
export async function writeSaferCompanyModelPolicy(deps:Dependencies,caller:Caller,value:unknown){
 const authority=await requireCompanyModelPolicyAuthority(deps,caller);
 const identity=await modelIdentityChecks(deps,caller);
 const parsed=ModelSelectionPolicyPutSchema.safeParse(value);
 if(!parsed.success)throw agentXError("CONFIG_INVALID","Review a valid company model policy and request id.");
 const body=parsed.data,fingerprint=digest({action:"model_policy",orgId:caller.orgId,body});
 if(deps.audit===undefined)throw unavailable();
 const earlier=await readRequest(deps,caller.orgId,caller.developerId,body.requestId);
 if(earlier!==undefined){
  if(earlier.fingerprint!==fingerprint)throw agentXError("IDEMPOTENCY_CONFLICT","This request id belongs to another change.");
  const current=await readModelSelectionPolicy(deps,caller.orgId);
  const result={version:1 as const,status:"APPLIED" as const,revision:current.revision,requestId:body.requestId};
  if(canonicalJson(earlier.result)!==canonicalJson(result)||canonicalJson(current.stepOverrides)!==canonicalJson(body.stepOverrides))throw stale();
  await deps.documentClient.send(new TransactWriteCommand({TransactItems:[...authority,...identity,{ConditionCheck:{TableName:deps.tableName,Key:modelSelectionPolicyKey(caller.orgId),...(current.revision===0?{ConditionExpression:"attribute_not_exists(pk)"}:{ConditionExpression:"revision = :revision",ExpressionAttributeValues:{":revision":current.revision}})}},{ConditionCheck:{TableName:deps.tableName,Key:agentRequestKey(caller.orgId,caller.developerId,body.requestId),ConditionExpression:"fingerprint = :fingerprint AND #result = :result AND #expires > :now",ExpressionAttributeNames:{"#result":"result","#expires":INDEX_EXPIRY_ATTRIBUTE},ExpressionAttributeValues:{":fingerprint":fingerprint,":result":result,":now":Math.floor(deps.now()/1000)}}}]}));return result;
 }
 const prepared=await prepareCompanyModelPolicy(deps,caller,body);
 if(prepared.changes.length>0)throw agentXError("FORBIDDEN","This company model change requires confirmation.");
 const result={version:1 as const,status:"APPLIED" as const,revision:prepared.next.revision,requestId:body.requestId};
 const base={orgId:caller.orgId,actor:{kind:"member" as const,id:caller.developerId},occurredAt:new Date(deps.now()).toISOString(),occurrence:auditOccurrence(body.requestId,"company-model-policy"),revision:prepared.next.revision,policyDigest:digest(prepared.next.stepOverrides),previousDigest:digest(prepared.current.stepOverrides)};
 const events=prepared.changed?[auditModelPolicyChanged(base),...STAGE_IDS.filter(stage=>prepared.next.stepOverrides[stage]?.locked===true&&prepared.current.stepOverrides[stage]?.locked!==true).map(stage=>auditModelPolicyLockSet({...base,stage}))]:[];
 const policyKey=modelSelectionPolicyKey(caller.orgId),policyCheck=prepared.conditions.find(item=>item.ConditionCheck?.Key?.pk===policyKey.pk&&item.ConditionCheck.Key.sk===policyKey.sk)?.ConditionCheck;
 if(policyCheck===undefined)throw unavailable();
 const conditions=prepared.changed?prepared.conditions.filter(item=>item.ConditionCheck!==policyCheck):prepared.conditions;
 const pending=events.flatMap(event=>auditPending(deps,event));if(pending.length!==events.length)throw unavailable();
 const {Key,...policyPredicate}=policyCheck;void Key;
 const items=[...conditions,...identity,...(prepared.changed?[{Put:{...policyPredicate,Item:{...policyKey,entityType:"MODEL_SELECTION_POLICY",orgId:caller.orgId,...prepared.next,updatedAt:base.occurredAt,updatedBy:caller.developerId}}}]:[]),...pending];
 if(items.length+1>25)throw unavailable();
 await commit(deps,items,stale,{orgId:caller.orgId,developerId:caller.developerId,requestId:body.requestId,fingerprint},result);
 await flushAuditEvents(deps,events);return result;
}
