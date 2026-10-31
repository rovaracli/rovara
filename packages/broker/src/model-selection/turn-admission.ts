// Join admission fences to existing same-item mutations without dropping a condition.
import {AgentXError,canonicalJson,agentXError} from "@agentx/contracts";
import type {TransactItem} from "../agents/table-writes.js";
export function joinTurnAdmissionChecks(items:readonly TransactItem[]):TransactItem[] {
 const result:TransactItem[]=[];const positions=new Map<string,number>();
 for(const item of items) {
  const action=item.Update??item.Put??item.Delete??item.ConditionCheck;
  if(action===undefined)throw agentXError("RUNTIME_UNAVAILABLE","The turn's atomic model admission is unavailable.");
  const record=item.Put?.Item as Record<string,unknown>|undefined;
  const Key=item.Put===undefined?(item.Update??item.Delete??item.ConditionCheck)?.Key:{pk:record?.pk,sk:record?.sk};
  const key=canonicalJson([action.TableName,Key]),index=positions.get(key);
  if(index===undefined){positions.set(key,result.length);result.push(item);continue;}
  const incoming=item.ConditionCheck,current=result[index]!;
  const target=current.Update??current.Put??current.Delete??current.ConditionCheck;
  if(incoming===undefined||incoming.ConditionExpression===undefined||target===undefined)throw agentXError("RUNTIME_UNAVAILABLE","The turn's atomic model admission has conflicting writes.");
  const names={...target.ExpressionAttributeNames},values:Record<string,unknown>={...target.ExpressionAttributeValues};let condition=incoming.ConditionExpression,counter=0;
  for(const [old,value] of Object.entries(incoming.ExpressionAttributeNames??{})) {
   let fresh:string;do{fresh=`#turnAdmission${counter++}`;}while(fresh in names);
   condition=condition.replace(/#[A-Za-z0-9_]+/gu,token=>token===old?fresh:token);names[fresh]=value;
  }
  for(const [old,value] of Object.entries((incoming.ExpressionAttributeValues??{}) as Record<string,unknown>)) {
   let fresh:string;do{fresh=`:turnAdmission${counter++}`;}while(fresh in values);
   condition=condition.replace(/:[A-Za-z0-9_]+/gu,token=>token===old?fresh:token);values[fresh]=value;
  }
  const merged={...target,ConditionExpression:target.ConditionExpression===undefined?`(${condition})`:`(${target.ConditionExpression}) AND (${condition})`,...(Object.keys(names).length===0?{}:{ExpressionAttributeNames:names}),...(Object.keys(values).length===0?{}:{ExpressionAttributeValues:values})};
  result[index]=current.Update!==undefined?{Update:{...current.Update,...merged}}:current.Put!==undefined?{Put:{...current.Put,...merged}}:current.Delete!==undefined?{Delete:{...current.Delete,...merged}}:{ConditionCheck:{...current.ConditionCheck!,...merged}};
 }
 return result;
}

export class TurnAdmissionLimitError extends AgentXError {
 constructor(readonly itemCount:number,limit=90){super("CONFIG_INVALID",`The model-governed approval requires ${itemCount} atomic items; the limit is ${limit}. Reduce the approval and try again.`,400);}
}
// Plan approval: 25 comment locks + one detail item containing all 20 answers
// + at most 25 added authority items (including its audit) + up to 13 ordinary
// workspace/operation/outbox/idempotency/task/turn/counter/access/notice writes = 64.
// Optional application/graph conditions are counted too; any combination above 90
// refuses before sending, leaving 10 items of DynamoDB headroom. Answers and prior
// decisions are embedded in the task/detail rows, never 20/100 separate writes.
export const PLAN_APPROVAL_ITEM_ENVELOPE=25+1+25+13;
export function boundedTurnAdmission(items:TransactItem[]):TransactItem[]{
 if(!items.some(item=>item.Put?.Item?.modelTurnPin!==undefined||item.Put?.Item?.modelPolicy!==undefined))return items;
 const joined=joinTurnAdmissionChecks(items);
 if(joined.length>90)throw new TurnAdmissionLimitError(joined.length);
 return joined;
}
