import {expect,it} from "vitest";
import {TransactWriteCommand} from "@aws-sdk/lib-dynamodb";
import {joinTurnAdmissionChecks} from "../../packages/broker/src/model-selection/turn-admission.js";
import {FakeDynamoDb} from "../support/fake-dynamodb.js";
import type {TransactItem} from "../../packages/broker/src/agents/table-writes.js";
const key={pk:"TASK#one",sk:"META"};
function items():TransactItem[]{return [
 {Update:{TableName:"state",Key:key,UpdateExpression:"SET #status = :next",ConditionExpression:"#status = :before",ExpressionAttributeNames:{"#status":"status"},ExpressionAttributeValues:{":next":"RUNNING",":before":"READY"}}},
 {ConditionCheck:{TableName:"state",Key:key,ConditionExpression:"#status = :before",ExpressionAttributeNames:{"#status":"owner"},ExpressionAttributeValues:{":before":"maya"}}},
 {ConditionCheck:{TableName:"state",Key:key,ConditionExpression:"revision = :before",ExpressionAttributeValues:{":before":2}}},
 ];}
it("joins same-item checks with colliding aliases while preserving the mutation and all fences",async()=>{
 const db=new FakeDynamoDb();db.set({...key,status:"READY",owner:"maya",revision:2});
 const joined=joinTurnAdmissionChecks(items());expect(joined).toHaveLength(1);
 await db.send(new TransactWriteCommand({TransactItems:joined}));expect(db.get(key)).toMatchObject({status:"RUNNING",owner:"maya",revision:2});
});
for(const changed of [{status:"BUSY"},{owner:"bea"},{revision:3}])it(`refuses an atomic change to ${Object.keys(changed)[0]}`,async()=>{
 const db=new FakeDynamoDb();db.set({...key,status:"READY",owner:"maya",revision:2,...changed});
 await expect(db.send(new TransactWriteCommand({TransactItems:joinTurnAdmissionChecks(items())}))).rejects.toMatchObject({name:"TransactionCanceledException"});expect(db.get(key)?.status).toBe(changed.status??"READY");
});
it("keeps different-table and different-key checks separate",()=>{
 const base=items()[1]!;expect(joinTurnAdmissionChecks([base,{ConditionCheck:{...base.ConditionCheck!,TableName:"other"}},{ConditionCheck:{...base.ConditionCheck!,Key:{...key,sk:"OTHER"}}}])).toHaveLength(3);
});
it("refuses two mutations for one item instead of dropping a write",()=>{
 expect(()=>joinTurnAdmissionChecks([items()[0]!,items()[0]!])).toThrow("conflicting writes");
});
