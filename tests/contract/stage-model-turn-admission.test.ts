import {beforeAll,expect,it,vi} from "vitest";
import {TransactWriteCommand} from "@aws-sdk/lib-dynamodb";
import {boundedTurnAdmission,TurnAdmissionLimitError,joinTurnAdmissionChecks} from "../../packages/broker/src/model-selection/turn-admission.js";
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

it("joins an unconditional create with its absence fence",async()=>{
 const db=new FakeDynamoDb();const joined=joinTurnAdmissionChecks([{Put:{TableName:"state",Item:{...key,status:"READY"}}},{ConditionCheck:{TableName:"state",Key:key,ConditionExpression:"attribute_not_exists(pk)"}}]);
 await db.send(new TransactWriteCommand({TransactItems:joined}));expect(db.get(key)?.status).toBe("READY");
 await expect(db.send(new TransactWriteCommand({TransactItems:joined}))).rejects.toMatchObject({name:"TransactionCanceledException"});
});
function approvalItems(count:number):TransactItem[]{return Array.from({length:count},(_,i)=>({Put:{TableName:"state",Item:{pk:`APPROVAL#${i}`,sk:"META",...(i===0?{modelTurnPin:{version:1}}:{})}}}));}
it("admits the 90-item boundary atomically",async()=>{
 const db=new FakeDynamoDb();await db.send(new TransactWriteCommand({TransactItems:boundedTurnAdmission(approvalItems(90))}));expect(db.transactions()).toHaveLength(1);expect(db.transactions()[0]).toHaveLength(90);
});
it("refuses 91 items before any write with a structured terminal code",async()=>{
 const db=new FakeDynamoDb();const write=async()=>db.send(new TransactWriteCommand({TransactItems:boundedTurnAdmission(approvalItems(91))}));
 await expect(write()).rejects.toMatchObject({code:"CONFIG_INVALID",statusCode:400,itemCount:91});expect(db.transactions()).toHaveLength(0);
});
import * as admission from "../../packages/broker/src/model-selection/turn-admission.js";
import {createDeveloperTaskBroker,MAYA} from "../support/developer-task-broker.js";
import {loadSlackBroker} from "../support/slack-broker.js";
import {randomUUID} from "node:crypto";
beforeAll(loadSlackBroker);
it("ends an over-cap queued prepare visibly instead of retrying its callback forever",async()=>{
 const h=await createDeveloperTaskBroker();const started=await h.dev(MAYA,"POST","/v1/dev/tasks",{requestId:randomUUID(),project:"payments",instructions:"Fix it",client:"test"});
 const taskId=String((started.body.task as {taskId:string}).taskId),task=h.db.get(`DEVTASK#${taskId}`,"META")!,workspaceId=String(task.workspaceId);
 const prepare=h.db.find(row=>row.entityType==="OPERATION"&&row.workspaceId===workspaceId&&row.kind==="prepare")[0]!;
 const spy=vi.spyOn(admission,"boundedTurnAdmission").mockImplementationOnce(()=>{throw new TurnAdmissionLimitError(91);});
 try {await h.finish(workspaceId,String(prepare.id),"SUCCEEDED");}finally{spy.mockRestore();}
 const failed=h.db.get(`WORKSPACE#${workspaceId}`,`OPERATION#${String(prepare.id)}`);
 expect(failed).toMatchObject({status:"FAILED",startRefused:true});expect(failed?.error).toContain("limit is 90");
 const {taskPointerKey}=await import("../../packages/broker/src/developer/task-records.js");
 expect(h.db.get(taskPointerKey(workspaceId))).not.toHaveProperty("pendingPrompt");
 await h.finish(workspaceId,String(prepare.id),"SUCCEEDED");
 expect(h.db.get(`WORKSPACE#${workspaceId}`,`OPERATION#${String(prepare.id)}`)?.status).toBe("FAILED");
 expect(h.db.find(row=>row.entityType==="OPERATION"&&row.workspaceId===workspaceId&&row.kind==="task")).toHaveLength(0);
});

it("also bounds a recipe-governed admission without a legacy turn pin",()=>{
 const entries=approvalItems(91);entries[0]={Put:{TableName:"state",Item:{pk:"APPROVAL#0",sk:"META",modelPolicy:{version:1,stage:"build"}}}};
 expect(()=>boundedTurnAdmission(entries)).toThrow(TurnAdmissionLimitError);
});
