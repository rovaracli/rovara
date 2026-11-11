// M45: builtin accountable only; real HTTP, native settings transactions, explicit seeded approval cases.
import { randomUUID } from "node:crypto";
import { DeleteCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { expect, it } from "vitest";
import { agentKey, builtinSettingsKey, agentRequestKey, OrgIdSchema } from "@rovara-code/contracts";
import { ownerBudgetKey, developerOrgKey, orgMemberKey, orgMetaKey } from "@agentx/cloud-contracts";
import { markRequest } from "../../packages/broker/src/agents/routes.js";
import { requestOwnerCap } from "../../packages/broker/src/spend/requests.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { MAYA } from "../support/developer-task-broker.js";
import { ADA, DEB, setup } from "../support/spend-world.js";
import { TEST_ORG } from "../support/orgs.js";
const id="root-cause-analyst",path=`/v1/app/agents/${id}`,key=builtinSettingsKey(TEST_ORG,id),eventsKey=agentKey(TEST_ORG,id,"META"),otherOrg=OrgIdSchema.parse("org_"+"b".repeat(20));
type NativeItem={Update?:{Key?:{pk?:string;sk?:string}};Put?:{Item?:{pk?:string;sk?:string}};ConditionCheck?:{Key:{pk:string;sk:string}}};
const writes=(command:{input:unknown})=>(command.input as {TransactItems?:NativeItem[]}).TransactItems;
const settingsWrite=(items:NativeItem[]|undefined)=>items?.some(i=>[i.Update?.Key,i.Put?.Item].some(k=>k?.pk===key.pk&&k.sk===key.sk))??false;
async function fixture(existing=true){
 const capture=capturingAuditDeps(),t=await setup({decide:true,extra:{audit:capture.audit}});capture.attach(t.db);
 await t.budgeted(1,DEB);
 if(existing){expect((await t.api(ADA,"PUT",path+"/budget",{monthlyUsd:10,maxPerRunUsd:2})).status).toBe(200);expect((await t.api(ADA,"PUT",path+"/accountable",{accountable:{developerId:ADA.developerId}})).status).toBe(200);}
 const requestId=randomUUID(),snapshot=()=>({settings:t.db.get(key),counters:[ADA,DEB,MAYA].map(w=>t.db.get(ownerBudgetKey(TEST_ORG,w.developerId))),events:t.db.find(r=>r.pk===eventsKey.pk&&r.entityType==="AGENT_EVENT"),receipts:t.db.find(r=>r.entityType==="AGENT_REQUEST"),audit:capture.recorded(),pending:capture.pending()});
 let standalone=0;const send=t.db.send.bind(t.db);t.db.send=async command=>{const input=command.input as {Item?:{pk?:string;sk?:string}};if(command.constructor.name==="PutCommand"&&input.Item?.pk===key.pk&&input.Item.sk===key.sk)standalone++;return send(command);};
 const transfer=()=>t.api(ADA,"PUT",path+"/accountable",{requestId,accountable:{developerId:DEB.developerId}});
 return{t,capture,requestId,snapshot,transfer,standalone:()=>standalone};
}
for(const existing of [false,true])for(const loss of ["member_role","pointer_moved","pointer_deleted","member_removed","org_closing","org_closed"] as const)it(`${existing?"existing":"never initialized"} builtin refuses ${loss} at real commit`,async()=>{
 const f=await fixture(existing),before=f.snapshot(),send=f.t.db.send.bind(f.t.db);let raced=false;
 f.t.db.send=async command=>{if(!raced&&settingsWrite(writes(command))){raced=true;
 if(loss==="member_role")f.t.db.set({...f.t.db.get(orgMemberKey(TEST_ORG,ADA.developerId))!,role:"member"});
 if(loss==="pointer_moved")f.t.db.set({...f.t.db.get(developerOrgKey(ADA.developerId))!,orgId:otherOrg});
 if(loss==="pointer_deleted")f.t.db.delete(developerOrgKey(ADA.developerId));
 if(loss==="member_removed")f.t.db.delete(orgMemberKey(TEST_ORG,ADA.developerId));
 if(loss==="org_closing"||loss==="org_closed")f.t.db.set({...f.t.db.get(orgMetaKey(TEST_ORG))!,[loss==="org_closing"?"closingAt":"closedAt"]:new Date().toISOString()});
 }return send(command);};
 expect((await f.transfer()).status).toBe(403);expect(raced).toBe(true);expect(f.snapshot()).toEqual(before);expect(f.standalone()).toBe(0);
});
for(const invalid of ["no_actor","request_no_actor","by","request_org","request_person","both","system_without_cause","system_request","member_actor"] as const)it(`builtin refuses ${invalid} before any initialization`,async()=>{
 const f=await fixture(false),before=f.snapshot(),actor={developerId:ADA.developerId,role:"owner" as const},request={orgId:TEST_ORG,developerId:ADA.developerId,requestId:f.requestId,fingerprint:"fixture"};
 const options=invalid==="both"?{actor,overrideCap:{actor,spendRequestId:randomUUID(),items:[],closed:()=>new Error("closed")}}:invalid==="system_request"?{cause:{kind:"member_removed" as const,developerId:DEB.developerId}}:invalid==="no_actor"||invalid==="request_no_actor"||invalid==="system_without_cause"?{}:invalid==="member_actor"?{actor:{developerId:MAYA.developerId,role:"member" as const}}:{actor};
 const by=invalid==="by"?DEB.developerId:invalid.startsWith("system")?"system":invalid==="member_actor"?MAYA.developerId:ADA.developerId;
 const mark=invalid==="no_actor"||invalid==="system_without_cause"||invalid==="member_actor"?undefined:{...request,...(invalid==="request_org"?{orgId:otherOrg}:{}),...(invalid==="request_person"?{developerId:DEB.developerId}:{})};
 await expect(f.t.deps().store.setAccountable(TEST_ORG,id,{developerId:DEB.developerId},by,mark,options)).rejects.toMatchObject({code:"FORBIDDEN"});expect(f.snapshot()).toEqual(before);expect(f.standalone()).toBe(0);
});
for(const existing of [false,true])for(const who of [ADA,DEB])it(`legitimate ${who.name} ${existing?"updates":"atomically initializes"} builtin and replays once`,async()=>{
 const f=await fixture(existing),before=f.t.db.get(key),requestId=randomUUID(),body={requestId,accountable:{developerId:DEB.developerId}};
 expect((await f.t.api(who,"PUT",path+"/accountable",body)).status).toBe(200);const after=f.snapshot();expect((await f.t.api(who,"PUT",path+"/accountable",body)).status).toBe(200);expect(f.snapshot()).toEqual(after);expect(f.standalone()).toBe(0);
 expect(after.settings).toMatchObject({pinnedVersion:before?.pinnedVersion??f.t.deps().store.builtinDefaultPin(id),accountable:{developerId:DEB.developerId},updatedBy:who.developerId});
 expect(after.settings?.monthlyBudgetUsd).toBe(before?.monthlyBudgetUsd);expect(after.settings?.maxPerRunUsd).toBe(before?.maxPerRunUsd);
});
it("member and foreign scope cannot borrow builtin authority",async()=>{
 const f=await fixture(false),before=f.snapshot();expect((await f.t.api(MAYA,"PUT",path+"/accountable",{accountable:{developerId:DEB.developerId}})).status).toBe(403);
 await expect(f.t.deps().store.setAccountable(otherOrg,id,{developerId:DEB.developerId},ADA.developerId,{orgId:TEST_ORG,developerId:ADA.developerId,requestId:f.requestId,fingerprint:"fixture"},{actor:{developerId:ADA.developerId,role:"owner"}})).rejects.toMatchObject({code:"FORBIDDEN"});expect(f.snapshot()).toEqual(before);expect(f.standalone()).toBe(0);
});
const fieldValue=(field:string,before:Record<string,unknown>)=>field==="accountable"?{developerId:DEB.developerId}:field==="pinnedVersion"?Number(before.pinnedVersion)+1:field==="monthlyBudgetUsd"?12:field==="maxPerRunUsd"?3:field==="updatedBy"?DEB.developerId:new Date(Date.parse(String(before.updatedAt))+1000).toISOString();
for(const when of ["before","after"] as const)for(const field of ["accountable","pinnedVersion","monthlyBudgetUsd","maxPerRunUsd","updatedAt","updatedBy","deleted"] as const)it(`builtin ${field} drift ${when==="before"?"before store read":"at native commit"} is 409`,async()=>{
 const f=await fixture(),before=f.t.db.get(key)!,send=f.t.db.send.bind(f.t.db);let reads=0,raced=false,winner=f.snapshot();
 const change=async()=>{if(field==="deleted")await send(new DeleteCommand({TableName:"state",Key:key}));else await send(new TransactWriteCommand({TransactItems:[{Update:{TableName:"state",Key:key,UpdateExpression:"SET #field = :value",ConditionExpression:"attribute_exists(pk)",ExpressionAttributeNames:{"#field":field},ExpressionAttributeValues:{":value":fieldValue(field,before)}}}]}));winner=f.snapshot();};
 f.t.db.send=async command=>{const input=command.input as {Key?:{pk?:string;sk?:string}};const trigger=!raced&&(when==="before"?command.constructor.name==="GetCommand"&&input.Key?.pk===key.pk&&input.Key.sk===key.sk&&++reads===2:settingsWrite(writes(command)));
 if(trigger){raced=true;await change();}return send(command);};
 expect((await f.transfer()).status).toBe(409);expect(raced).toBe(true);expect(f.snapshot()).toEqual(winner);expect(f.standalone()).toBe(0);expect(f.t.db.get(agentRequestKey(TEST_ORG,ADA.developerId,f.requestId))).toBeUndefined();
});
it("two native first creators preserve the real competing winner",async()=>{
 const f=await fixture(false),send=f.t.db.send.bind(f.t.db);let raced=false,winner=f.snapshot();
 f.t.db.send=async command=>{if(!raced&&settingsWrite(writes(command))){raced=true;expect((await f.t.api(DEB,"PUT",path+"/accountable",{accountable:{developerId:ADA.developerId}})).status).toBe(200);winner=f.snapshot();}return send(command);};
 expect((await f.transfer()).status).toBe(409);expect(raced).toBe(true);expect(f.snapshot()).toEqual(winner);expect(f.standalone()).toBe(0);
});
it("read failure is not confirmed absence or default materialization",async()=>{
 const f=await fixture(false),before=f.snapshot(),send=f.t.db.send.bind(f.t.db);f.t.db.send=async command=>{const input=command.input as {Key?:{pk?:string;sk?:string}};if(command.constructor.name==="GetCommand"&&input.Key?.pk===key.pk&&input.Key.sk===key.sk)throw new Error("fixture read unavailable");return send(command);};
 expect((await f.transfer()).status).toBe(400);expect(f.snapshot()).toEqual(before);expect(f.standalone()).toBe(0);
});
it("malformed stored pin is refused without repair or writes",async()=>{
 const f=await fixture();f.t.db.set({...f.t.db.get(key)!,pinnedVersion:"broken"});const before=f.snapshot();await expect(f.t.deps().store.setAccountable(TEST_ORG,id,{developerId:DEB.developerId},ADA.developerId,undefined,{actor:{developerId:ADA.developerId,role:"owner"}})).rejects.toMatchObject({code:"CONFIG_INVALID"});expect(f.snapshot()).toEqual(before);expect(f.standalone()).toBe(0);
});
for(const kind of ["removed","merged"] as const)it(`real SYSTEM ${kind} builtin accountable path stays requestless`,async()=>{
 const f=await fixture();expect((await f.t.api(ADA,"PUT",path+"/accountable",{accountable:{developerId:DEB.developerId}})).status).toBe(200);const lifecycle=await import("../../packages/broker/src/agents/lifecycle.js");
 if(kind==="removed"){f.t.db.delete(orgMemberKey(TEST_ORG,DEB.developerId));await lifecycle.onMemberRemoved(f.t.deps(),{orgId:TEST_ORG,developerId:DEB.developerId,by:ADA.developerId});}else await lifecycle.onMembersMerged(f.t.deps(),{orgId:TEST_ORG,duplicateId:DEB.developerId,survivorId:ADA.developerId});
 expect(f.t.db.get(key)?.accountable).toEqual({developerId:ADA.developerId});expect(f.t.db.find(r=>r.pk===eventsKey.pk&&r.by==="system"&&r.kind==="owner_changed")).toEqual([expect.objectContaining({cause:{kind:kind==="removed"?"member_removed":"member_merged",developerId:DEB.developerId}})]);expect(f.standalone()).toBe(0);
});
for(const after of ["none","actor","snapshot"] as const)it(`builtin cap retry preserves original authority ${after}`,async()=>{
 const f=await fixture(),send=f.t.db.send.bind(f.t.db);let commits=0,nested=false,winner=f.snapshot();
 f.t.db.send=async command=>{if(!nested&&settingsWrite(writes(command))){commits++;if(commits===1){const counterKey=ownerBudgetKey(TEST_ORG,DEB.developerId),row=f.t.db.get(counterKey)!;f.t.db.set({...row,version:Number(row.version??0)+1});winner=f.snapshot();try{return await send(command);}catch(error){if(after==="snapshot"){nested=true;expect((await f.t.api(DEB,"PUT",path+"/budget",{monthlyUsd:12})).status).toBe(200);winner=f.snapshot();nested=false;}throw error;}}if(after==="actor")f.t.db.set({...f.t.db.get(orgMemberKey(TEST_ORG,ADA.developerId))!,role:"member"});}return send(command);};
 expect((await f.transfer()).status).toBe(after==="actor"?403:after==="snapshot"?409:200);expect(commits).toBe(after==="snapshot"?1:2);if(after!=="none")expect(f.snapshot()).toEqual(winner);expect(f.standalone()).toBe(0);
});
async function seededPending(existing=false){
 const f=await fixture(existing),body={requestId:f.requestId,accountable:{developerId:DEB.developerId}},deps=f.t.deps(),{mark}=await markRequest(deps,f.t.caller(DEB,"admin"),"accountable",id,body);
 const original=f.t.db.get(key);
 // Explicit pending ask captures the native source, including first-row absence.
 const asked=await requestOwnerCap(deps,{orgId:TEST_ORG,agentId:id,requestedBy:DEB.developerId,owner:DEB.developerId,wouldBeUsd:110,capUsd:100,before:await deps.store.builtinBudgetSnapshot(TEST_ORG,id),change:{op:"set_accountable",accountable:{developerId:DEB.developerId}},request:mark});
 expect((await f.t.api(DEB,"PUT",path+"/accountable",body)).status).toBe(202);expect(f.t.db.get(key)).toEqual(original);expect(f.standalone()).toBe(0);return{...f,approvalId:asked.record.spendRequestId};
}
it("seeded pending approval with absent settings uses virtual default and atomically creates row",async()=>{
 const f=await seededPending();await expect(f.t.decide(ADA,f.approvalId)).resolves.toBeDefined();expect(f.t.requests().find(r=>r.spendRequestId===f.approvalId)?.status).toBe("APPROVED");expect(f.t.db.get(key)).toMatchObject({accountable:{developerId:DEB.developerId},pinnedVersion:f.t.deps().store.builtinDefaultPin(id)});expect(f.t.db.get(key)?.monthlyBudgetUsd).toBeUndefined();expect(f.t.db.get(key)?.maxPerRunUsd).toBeUndefined();expect(f.standalone()).toBe(0);
});
for(const loss of [false,true])it(`seeded absent approval actual decider ${loss?"loses native authority":"checks org exactly once"}`,async()=>{
 const f=await seededPending(),before=f.snapshot(),send=f.t.db.send.bind(f.t.db);let commits=0;
 f.t.db.send=async command=>{const items=writes(command);if(settingsWrite(items)){commits++;expect(items!.filter(i=>i.ConditionCheck?.Key.pk===orgMetaKey(TEST_ORG).pk&&i.ConditionCheck.Key.sk==="META")).toHaveLength(1);if(loss)f.t.db.set({...f.t.db.get(orgMemberKey(TEST_ORG,ADA.developerId))!,role:"member"});}return send(command);};
 if(loss){await expect(f.t.decide(ADA,f.approvalId)).rejects.toMatchObject({code:"FORBIDDEN"});expect(f.snapshot()).toEqual(before);expect(f.t.requests().find(r=>r.spendRequestId===f.approvalId)?.status).toBe("PENDING");}else await expect(f.t.decide(ADA,f.approvalId)).resolves.toBeDefined();expect(commits).toBe(1);expect(f.standalone()).toBe(0);
});
for(const target of ["member","removed"] as const)it(`builtin approval destination ${target} refuses without settings write`,async()=>{
 const f=await seededPending();if(target==="removed"){f.t.db.delete(orgMemberKey(TEST_ORG,DEB.developerId));f.t.db.delete(developerOrgKey(DEB.developerId));}else{f.t.db.set({...f.t.db.get(orgMemberKey(TEST_ORG,DEB.developerId))!,role:"member"});f.t.db.set({...f.t.db.get(developerOrgKey(DEB.developerId))!,role:"member"});}
 await expect(f.t.decide(ADA,f.approvalId)).rejects.toMatchObject({code:target==="member"?"CONFIG_INVALID":"APPROVAL_CLOSED"});expect(f.t.db.get(key)).toBeUndefined();expect(f.t.requests().find(r=>r.spendRequestId===f.approvalId)?.status).toBe(target==="member"?"PENDING":"EXPIRED");expect(f.standalone()).toBe(0);
});
it("existing budget gives real route-generated self-assignment202; requester cannot decide",async()=>{
 const f=await fixture();await f.t.budgeted(49,DEB);await f.t.budgeted(50,DEB);const before=f.t.db.get(key),reply=await f.t.api(DEB,"PUT",path+"/accountable",{accountable:{developerId:DEB.developerId}});expect(reply.status).toBe(202);expect(f.t.db.get(key)).toEqual(before);const approvalId=String(reply.body.spendRequestId);await expect(f.t.decide(DEB,approvalId)).rejects.toMatchObject({code:"FORBIDDEN"});await expect(f.t.decide(ADA,approvalId)).resolves.toBeDefined();expect(f.t.db.get(key)?.accountable).toEqual({developerId:DEB.developerId});expect(f.standalone()).toBe(0);
});

for(const existing of [false,true])it(`seeded pending approval ${existing?"existing CAS":"first creator"} race expires the ask and preserves the competing money source`,async()=>{
 const f=await seededPending(existing);
 const send=f.t.db.send.bind(f.t.db);let raced=false,winner=f.snapshot();
 f.t.db.send=async command=>{if(!raced&&settingsWrite(writes(command))){raced=true;
 if(existing)await send(new TransactWriteCommand({TransactItems:[{Update:{TableName:"state",Key:key,UpdateExpression:"SET #perRun = :perRun",ConditionExpression:"attribute_exists(pk)",ExpressionAttributeNames:{"#perRun":"maxPerRunUsd"},ExpressionAttributeValues:{":perRun":3}}}]}));
 else expect((await f.t.api(DEB,"PUT",path+"/accountable",{accountable:{developerId:ADA.developerId}})).status).toBe(200);
 winner=f.snapshot();}return send(command);};
 await expect(f.t.decide(ADA,f.approvalId)).rejects.toMatchObject({code:"SPENDING_APPROVAL_STALE"});expect(raced).toBe(true);expect(f.snapshot().settings).toEqual(winner.settings);expect(f.snapshot().counters).toEqual(winner.counters);expect(f.snapshot().events).toEqual(winner.events);expect(f.snapshot().receipts).toEqual(winner.receipts);expect(f.t.requests().find(r=>r.spendRequestId===f.approvalId)).toMatchObject({status:"EXPIRED",endedBecause:"figures_changed"});expect(f.standalone()).toBe(0);
});
