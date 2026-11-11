// Build the fallback part of the operation transaction; never commit/dispatch in a separate write.
import {createHash} from "node:crypto";
import {z} from "zod";
import {GetCommand} from "@aws-sdk/lib-dynamodb";
import { ModelIdentifierSchema, ModelFallbackSchema, ModelFallbacksSchema, agentXError, canonicalJson, type OrgId } from "@rovara-code/contracts";
import { AuditEventIdSchema } from "@agentx/cloud-contracts";
import {auditModelFallbackUsed} from "../audit/events.js";
import {auditPending,type AuditRuntime,type TransactItem} from "../audit/outbox.js";
import {taskKey} from "../developer/task-records.js";
import type {StageModelResult} from "./resolver.js";
const Digest=z.string().regex(/^[a-f0-9]{64}$/u);
const Receipts=z.array(z.object({key:Digest,digest:Digest,eventId:AuditEventIdSchema,at:z.string().datetime()}).strict()).max(64);
const unavailable=()=>agentXError("RUNTIME_UNAVAILABLE","The task's model fallback history could not be verified.");
const hash=(value:unknown)=>createHash("sha256").update(canonicalJson(value)).digest("hex");
export interface FallbackRecordDependencies {documentClient:{send(command:unknown):Promise<unknown>};tableName:string;audit?:AuditRuntime|undefined;now():number}
export interface TaskFallbackOccurrence {orgId:OrgId;taskId:string;project:string;operationId:string;occurredAt:string;companyRevision:number;decision:Extract<StageModelResult,{kind:"resolved"}>}
/** Accept only the server resolver decision for this task's pinned policy; this is no public write API.
 * The dispatcher owns live callability, pinned recipe/policy proof and operation/authority checks.
 * Join `items` to the actual dispatch mutation and its operation fences. On replay, do not dispatch again.
 * After the caller commits, its normal audit flush may deliver `event`. Missing audit refuses the switch. */
export function modelFallbackOccurrence(input:TaskFallbackOccurrence) {
 if(!z.uuid().safeParse(input.taskId).success||!z.string().min(1).max(200).safeParse(input.operationId).success) throw unavailable();
 const parsed=ModelFallbackSchema.safeParse(input.decision.fallback),model=ModelIdentifierSchema.safeParse(input.decision.model);
 if(!parsed.success||!model.success||parsed.data.used!==`${model.data.provider}/${model.data.modelId}`) throw unavailable();
 const fallback=parsed.data;
 let wanted;
 if(fallback.wanted!==null){const slash=fallback.wanted.indexOf("/");const result=ModelIdentifierSchema.safeParse({provider:fallback.wanted.slice(0,slash),modelId:fallback.wanted.slice(slash+1)});if(slash<1||!result.success) throw unavailable();wanted=result.data;}
 const key=hash([input.orgId,input.taskId,input.operationId,fallback.stage]);
 const digest=hash({fallback,companyRevision:input.companyRevision});
 const event=auditModelFallbackUsed({orgId:input.orgId,actor:{kind:"system",id:"rovara"},occurredAt:input.occurredAt,occurrence:key,projectName:input.project,stage:fallback.stage,used:model.data,...(wanted===undefined?{}:{wanted}),reasonCode:fallback.reasonCode,companyRevision:input.companyRevision});
 return {key,digest,fallback,event};
}
export async function prepareTaskModelFallback(deps:FallbackRecordDependencies,input:TaskFallbackOccurrence) {
 if(deps.audit===undefined||deps.audit.tableName!==deps.tableName) throw unavailable();
 const {key,digest,fallback,event}=modelFallbackOccurrence(input);
 const response=await deps.documentClient.send(new GetCommand({TableName:deps.tableName,Key:taskKey(input.taskId),ConsistentRead:true})) as {Item?:Record<string,unknown>};
 const task=response.Item;
 if(task===undefined||task.orgId!==input.orgId||task.taskId!==input.taskId||task.project!==input.project) throw agentXError("NOT_FOUND","The task is unavailable.");
 const history=ModelFallbacksSchema.safeParse(task.modelFallbacks??[]),receipts=Receipts.safeParse(task.modelFallbackReceipts??[]);
 const revision=task.modelFallbackRevision??0;
 if(!history.success||!receipts.success||history.data.length!==receipts.data.length||!Number.isSafeInteger(revision)||revision!==history.data.length||new Set(receipts.data.map(row=>row.key)).size!==receipts.data.length) throw unavailable();
 const old=receipts.data.find(row=>row.key===key);
 if(old!==undefined){if(old.digest!==digest) throw agentXError("CONFIG_INVALID","The fallback occurrence was already used for a different decision.");return {replayed:true as const,items:[] as TransactItem[],event:undefined};}
 if(history.data.length>=64) throw unavailable();

 const items:TransactItem[]=[{Update:{TableName:deps.tableName,Key:taskKey(input.taskId),UpdateExpression:"SET #history = :history, #receipts = :receipts, #revision = :next",ConditionExpression:"attribute_exists(pk) AND orgId = :org AND taskId = :task AND #project = :project AND "+(task.modelFallbackRevision===undefined?"attribute_not_exists(#revision)":"#revision = :before"),ExpressionAttributeNames:{"#history":"modelFallbacks","#receipts":"modelFallbackReceipts","#revision":"modelFallbackRevision","#project":"project"},ExpressionAttributeValues:{":history":[...history.data,fallback],":receipts":[...receipts.data,{key,digest,eventId:event.eventId,at:input.occurredAt}],":next":history.data.length+1,":org":input.orgId,":task":input.taskId,":project":input.project,...(task.modelFallbackRevision===undefined?{}:{":before":revision})}}},...auditPending({audit:deps.audit},event)];
 if(items.length!==2) throw unavailable();
 return {replayed:false as const,items,event};
}

/** Operation-scoped history for project turns without a developer-task record.
 * Caller must join fields to its fenced operation mutation and audit items in one transaction. */
export function prepareTurnModelFallback(deps:FallbackRecordDependencies,input:TaskFallbackOccurrence,current:{modelFallbacks?:unknown;modelFallbackReceipts?:unknown;modelFallbackRevision?:unknown}={}) {
 if(deps.audit===undefined||deps.audit.tableName!==deps.tableName)throw unavailable();
 const {key,digest,fallback,event}=modelFallbackOccurrence(input);
 const history=ModelFallbacksSchema.safeParse(current.modelFallbacks??[]),receipts=Receipts.safeParse(current.modelFallbackReceipts??[]),revision=current.modelFallbackRevision??0;
 if(!history.success||!receipts.success||history.data.length!==receipts.data.length||revision!==history.data.length||history.data.length>=64||receipts.data.some(row=>row.key===key))throw unavailable();
 const items=auditPending({audit:deps.audit},event);if(items.length!==1)throw unavailable();
 return {fields:{modelFallbacks:[...history.data,fallback],modelFallbackReceipts:[...receipts.data,{key,digest,eventId:event.eventId,at:input.occurredAt}],modelFallbackRevision:history.data.length+1},items,event};
}

/** Join this module's prepared fallback to dispatch's existing items, retaining their positions and fences.
 * DynamoDB permits only one action per key: a workflow META update must own the fallback fields too. */
export function joinTaskModelFallback(base:readonly TransactItem[],fallback:readonly TransactItem[]):TransactItem[] {
 if(fallback.length===0)return [...base];
 const change=fallback[0]?.Update;
 if(fallback.length!==2||change===undefined||fallback[1]?.Put===undefined||change.UpdateExpression!=="SET #history = :history, #receipts = :receipts, #revision = :next")throw unavailable();
 const index=base.findIndex(item=>{const action=item.Update??item.Put??item.Delete??item.ConditionCheck;const key="Item" in (action??{})?item.Put?.Item:action!==undefined&&"Key" in action?action.Key:undefined;return action?.TableName===change.TableName&&key?.pk===change.Key?.pk&&key?.sk===change.Key?.sk;});
 if(index<0)return [...base,...fallback];
 const current=base[index]?.Update;
 if(current===undefined||current.UpdateExpression===undefined)throw unavailable();
 const protectedFields=["modelFallbacks","modelFallbackReceipts","modelFallbackRevision"];
 if(Object.values(current.ExpressionAttributeNames??{}).some(name=>protectedFields.includes(name))||protectedFields.some(name=>new RegExp(`\\b${name}\\b`,"u").test(current.UpdateExpression!)))throw unavailable();
 const names={...current.ExpressionAttributeNames},values={...current.ExpressionAttributeValues};
 let update=change.UpdateExpression,condition=change.ConditionExpression??"attribute_exists(pk)",counter=0;
 for(const [old,value] of Object.entries(change.ExpressionAttributeNames??{})) {
  let fresh:string;do{fresh=`#modelFallback${counter++}`;}while(fresh in names);
  const rename=(text:string)=>text.replace(/#[A-Za-z0-9_]+/gu,token=>token===old?fresh:token);
  update=rename(update);condition=rename(condition);names[fresh]=value;
 }
 for(const [old,value] of Object.entries(change.ExpressionAttributeValues??{}) as Array<[string,unknown]>) {
  let fresh:string;do{fresh=`:modelFallback${counter++}`;}while(fresh in values);
  const rename=(text:string)=>text.replace(/:[A-Za-z0-9_]+/gu,token=>token===old?fresh:token);
  update=rename(update);condition=rename(condition);values[fresh]=value;
 }
 const expression=current.UpdateExpression;
 const sections=[...expression.matchAll(/\b(SET|REMOVE|ADD|DELETE)\b/gu)];
 const set=sections.find(section=>section[1]==="SET");
 let combined:string;
 if(set===undefined)combined=`${update} ${expression}`;
 else {
  const next=sections.find(section=>section.index>set.index);const end=next?.index??expression.length;
  combined=`${expression.slice(0,end).trimEnd()}, ${update.slice(4)} ${expression.slice(end)}`.trimEnd();
 }
 const items=[...base];items[index]={Update:{...current,UpdateExpression:combined,ConditionExpression:`(${current.ConditionExpression??"attribute_exists(pk)"}) AND (${condition})`,ExpressionAttributeNames:names,ExpressionAttributeValues:values}};
 return [...items,fallback[1]];
}
