// Join admission fences to existing same-item mutations without dropping a condition.
import {canonicalJson,agentXError} from "@agentx/contracts";
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
  const merged={...target,ConditionExpression:`(${target.ConditionExpression??"attribute_exists(pk)"}) AND (${condition})`,...(Object.keys(names).length===0?{}:{ExpressionAttributeNames:names}),...(Object.keys(values).length===0?{}:{ExpressionAttributeValues:values})};
  result[index]=current.Update!==undefined?{Update:{...current.Update,...merged}}:current.Put!==undefined?{Put:{...current.Put,...merged}}:current.Delete!==undefined?{Delete:{...current.Delete,...merged}}:{ConditionCheck:{...current.ConditionCheck!,...merged}};
 }
 return result;
}
