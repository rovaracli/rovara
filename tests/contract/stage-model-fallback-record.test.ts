import {expect,it} from "vitest";
import {TransactWriteCommand} from "@aws-sdk/lib-dynamodb";
import {prepareTaskModelFallback,joinTaskModelFallback} from "../../packages/broker/src/model-selection/fallback-record.js";
import {FakeDynamoDb} from "../support/fake-dynamodb.js";
import {capturingAuditDeps} from "../support/audit-capture.js";
const orgId="org_aaaaaaaaaaaaaaaaaaaa";
const taskId="11111111-1111-4111-8111-111111111111";
const used={provider:"anthropic",modelId:"claude-sonnet-4"};
const input={orgId,taskId,project:"private-project",operationId:"operation-1",occurredAt:"2026-10-29T23:00:00.000Z",decision:{kind:"resolved" as const,model:used,sourceId:"rovara",thinkingLevel:null,reason:"BUILTIN_DEFAULT" as const,locked:false,fallback:{stage:"build" as const,used:"anthropic/claude-sonnet-4",wanted:null,reasonCode:"DEFAULT_MODEL_UNAVAILABLE" as const}},companyRevision:0};
function fixture(){const db=new FakeDynamoDb();const cap=capturingAuditDeps({db});db.set({pk:`DEVTASK#${taskId}`,sk:"META",taskId,orgId,project:input.project});return {db,cap,deps:{documentClient:db,tableName:"state",audit:cap.audit,now:()=>Date.parse(input.occurredAt)}};}
it("joins fallback history and audit in one commit and makes one occurrence idempotent",async()=>{
 const {db,cap,deps}=fixture();const prepared=await prepareTaskModelFallback(deps,input);expect(prepared.replayed).toBe(false);
 expect(db.get(`DEVTASK#${taskId}`,"META")?.modelFallbacks).toBeUndefined();
 await db.send(new TransactWriteCommand({TransactItems:prepared.items}));
 expect(db.get(`DEVTASK#${taskId}`,"META")?.modelFallbacks).toEqual([input.decision.fallback]);
 expect(cap.pending()).toHaveLength(1);expect(cap.pending()[0]?.action).toBe("model.fallback_used");expect(JSON.stringify(cap.pending()[0]?.facts)).not.toContain("claude-sonnet-4");
 expect((await prepareTaskModelFallback(deps,input)).replayed).toBe(true);
 await expect(prepareTaskModelFallback(deps,{...input,decision:{...input.decision,fallback:{...input.decision.fallback,reasonCode:"MODEL_CALL_REFUSED"}}})).rejects.toThrow("occurrence");
});
it("refuses missing audit or cross-org task and does not write a partial history",async()=>{
 const {db,deps}=fixture();await expect(prepareTaskModelFallback({...deps,audit:undefined},input)).rejects.toThrow();
 await expect(prepareTaskModelFallback(deps,{...input,orgId:"org_bbbbbbbbbbbbbbbbbbbb"})).rejects.toThrow();expect(db.get(`DEVTASK#${taskId}`,"META")?.modelFallbacks).toBeUndefined();
});

it("keeps history and audit absent if the joined dispatch fence fails",async()=>{
 const {db,cap,deps}=fixture();const prepared=await prepareTaskModelFallback(deps,input);
 await expect(db.send(new TransactWriteCommand({TransactItems:[...prepared.items,{ConditionCheck:{TableName:"state",Key:{pk:"OPERATION#test",sk:"META"},ConditionExpression:"attribute_exists(pk)"}}]}))).rejects.toThrow();
 expect(db.get(`DEVTASK#${taskId}`,"META")?.modelFallbacks).toBeUndefined();expect(cap.pending()).toEqual([]);
});
it("refuses a stale concurrent preparation without losing the winning history",async()=>{
 const {db,cap,deps}=fixture();const first=await prepareTaskModelFallback(deps,input);const nextInput={...input,operationId:"operation-2"};const second=await prepareTaskModelFallback(deps,nextInput);
 await db.send(new TransactWriteCommand({TransactItems:second.items}));
 await expect(db.send(new TransactWriteCommand({TransactItems:first.items}))).rejects.toThrow();expect(cap.pending()).toHaveLength(1);expect(db.get(`DEVTASK#${taskId}`,"META")?.modelFallbacks).toHaveLength(1);
 const retried=await prepareTaskModelFallback(deps,input);await db.send(new TransactWriteCommand({TransactItems:retried.items}));
 expect(cap.pending()).toHaveLength(2);expect(db.get(`DEVTASK#${taskId}`,"META")?.modelFallbacks).toHaveLength(2);
});

it("fuses fallback fields with the existing task update without duplicate keys or alias collisions",async()=>{
 const {db,cap,deps}=fixture();const prepared=await prepareTaskModelFallback(deps,input);
 db.set({...db.get(`DEVTASK#${taskId}`,"META")!,workflowRevision:2,pending:"old"});
 const base=[{Update:{TableName:"state",Key:{pk:`DEVTASK#${taskId}`,sk:"META"},UpdateExpression:"SET #revision = :next REMOVE #pending",ConditionExpression:"#revision = :before",ExpressionAttributeNames:{"#revision":"workflowRevision","#pending":"pending"},ExpressionAttributeValues:{":next":3,":before":2}}}];
 const joined=joinTaskModelFallback(base,prepared.items);expect(joined).toHaveLength(2);expect(base).toHaveLength(1);
 await db.send(new TransactWriteCommand({TransactItems:joined}));
 expect(db.get(`DEVTASK#${taskId}`,"META")).toMatchObject({workflowRevision:3,modelFallbackRevision:1,modelFallbacks:[input.decision.fallback]});
 expect(db.get(`DEVTASK#${taskId}`,"META")?.pending).toBeUndefined();expect(cap.pending()).toHaveLength(1);
});
it("preserves both task conditions when the existing dispatch update loses",async()=>{
 const {db,cap,deps}=fixture(),prepared=await prepareTaskModelFallback(deps,input);
 const base=[{Update:{TableName:"state",Key:{pk:`DEVTASK#${taskId}`,sk:"META"},UpdateExpression:"SET workflowRevision = :next",ConditionExpression:"attribute_exists(closedAt)",ExpressionAttributeValues:{":next":1}}}];
 await expect(db.send(new TransactWriteCommand({TransactItems:joinTaskModelFallback(base,prepared.items)}))).rejects.toThrow();
 expect(db.get(`DEVTASK#${taskId}`,"META")?.modelFallbacks).toBeUndefined();expect(cap.pending()).toHaveLength(0);
});
