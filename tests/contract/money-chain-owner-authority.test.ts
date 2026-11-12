// M42 controller: chain owner only, real HTTP and native atomic commit.
import "../support/automations-on.js";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { chainKey, agentRequestKey, OrgIdSchema } from "@rovara-code/contracts";
import { ownerBudgetKey, developerOrgKey, orgMemberKey, orgMetaKey } from "@agentx/cloud-contracts";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { MAYA, OMAR } from "../support/developer-task-broker.js";
import { ADA, BEN, DEB, setup } from "../support/spend-world.js";
import { decideSpendRequest } from "../../packages/broker/src/spend/requests.js";
import { ChainStore } from "../../packages/broker/src/chains/store.js";
import { TEST_ORG } from "../support/orgs.js";
const otherOrg=OrgIdSchema.parse("org_"+"b".repeat(20));
async function fixture(project=false){
 const capture=capturingAuditDeps(),t=await setup({decide:true,extra:{audit:capture.audit}});capture.attach(t.db);
 const created=await t.api(project?BEN:MAYA,"POST","/v1/app/chains",{name:`Fence ${randomUUID().slice(0,8)}`,...(project?{owner:{kind:"project",project:"payments"},accountable:{developerId:BEN.developerId}}:{})});
 expect(created.status,JSON.stringify(created.body)).toBe(201);
 const id=(created.body.chain as {chainId:string}).chainId;
 expect((await t.api(ADA,"PUT",`/v1/app/chains/${id}/budget`,{monthlyUsd:10})).status).toBe(200);
 const chains=new ChainStore({documentClient:t.db,tableName:"state",now:Date.now,agents:t.deps().store,audit:capture.audit});
 await t.budgeted(1,OMAR);const key=chainKey(TEST_ORG,id,"META"),path=`/v1/app/chains/${id}`,requestId=randomUUID();
 const snapshot=()=>({chain:t.db.get(key),totals:[t.ownerTotal(MAYA),t.ownerTotal(OMAR),t.ownerTotal(BEN)],events:t.db.find(row=>row.pk===key.pk && row.entityType==="CHAIN_EVENT"),receipts:t.db.find(row=>row.entityType==="AGENT_REQUEST"),audit:capture.recorded(),pending:capture.pending()});
 const transfer=()=>t.api(DEB,"PUT",path+"/owner",{requestId,owner:{kind:"member",developerId:OMAR.developerId}});
 return{t,chains,id,key,path,requestId,capture,snapshot,transfer};
}
for(const loss of ["member_role","pointer_moved","pointer_deleted","member_removed","org_closing","org_closed"] as const)it(`owner transfer refuses ${loss} at the real commit`,async()=>{
 const f=await fixture(),before=f.snapshot(),send=f.t.db.send.bind(f.t.db);let raced=false;
 f.t.db.send=async command=>{const items=(command.input as {TransactItems?:Array<{Update?:{Key?:{pk?:string;sk?:string}}}>}).TransactItems;
 if(!raced&&items?.some(i=>i.Update?.Key?.pk===f.key.pk&&i.Update.Key.sk===f.key.sk)){
  raced=true;
  if(loss==="member_role")f.t.db.set({...f.t.db.get(orgMemberKey(TEST_ORG,DEB.developerId))!,role:"member"});
  if(loss==="pointer_moved")f.t.db.set({...f.t.db.get(developerOrgKey(DEB.developerId))!,orgId:otherOrg});
  if(loss==="pointer_deleted")f.t.db.delete(developerOrgKey(DEB.developerId));
  if(loss==="member_removed")f.t.db.delete(orgMemberKey(TEST_ORG,DEB.developerId));
  if(loss==="org_closing"||loss==="org_closed")f.t.db.set({...f.t.db.get(orgMetaKey(TEST_ORG))!,[loss==="org_closing"?"closingAt":"closedAt"]:new Date().toISOString()});
 }return send(command);};
 expect((await f.transfer()).status).toBe(403);expect(raced).toBe(true);expect(f.snapshot()).toEqual(before);expect(f.t.db.get(agentRequestKey(TEST_ORG,DEB.developerId,f.requestId))).toBeUndefined();
});
for(const field of ["owner","accountable"] as const)it(`refuses a real intervening ${field} change after route access`,async()=>{
 const f=await fixture(field==="accountable"),send=f.t.db.send.bind(f.t.db);let reads=0,raced=false,afterRace=f.snapshot();
 if(field==="accountable")f.t.grantRole(MAYA,"maintainer");
 f.t.db.send=async command=>{const input=command.input as {Key?:{pk?:string;sk?:string}};
 if(command.constructor.name==="GetCommand"&&input.Key?.pk===f.key.pk&&input.Key.sk===f.key.sk&&!raced&&++reads===2){
  raced=true;const result=await f.t.api(ADA,"PUT",f.path+"/"+field,field==="owner"?{owner:{kind:"member",developerId:BEN.developerId}}:{accountable:{developerId:MAYA.developerId}});expect(result.status).toBe(200);afterRace=f.snapshot();
 }return send(command);};
 expect((await f.transfer()).status).toBe(403);expect(raced).toBe(true);expect(f.snapshot()).toEqual(afterRace);expect(f.t.db.get(agentRequestKey(TEST_ORG,DEB.developerId,f.requestId))).toBeUndefined();
});
for(const invalid of ["request_no_actor","no_request_no_actor","actor_by","request_developer","request_org","actor_and_override","system_without_cause","system_request"] as const)it(`refuses ${invalid} before ownership side effects`,async()=>{
 const f=await fixture(),before=f.snapshot(),actor={developerId:DEB.developerId,role:"admin" as const},request={orgId:TEST_ORG,developerId:DEB.developerId,requestId:f.requestId,fingerprint:"fixture"};
 const opts=invalid==="actor_and_override"?{actor,overrideCap:{actor,spendRequestId:randomUUID(),items:[],closed:()=>new Error("fixture closed")}}:invalid==="system_request"?{cause:{kind:"member_removed" as const,developerId:MAYA.developerId}}:invalid==="request_no_actor"||invalid==="no_request_no_actor"||invalid==="system_without_cause"?{}:{actor};
 const by=invalid==="actor_by"?OMAR.developerId:invalid.startsWith("system")?"system":DEB.developerId;
 const mark=invalid==="no_request_no_actor"||invalid==="system_without_cause"?undefined:{...request,...(invalid==="request_developer"?{developerId:OMAR.developerId}:{}),...(invalid==="request_org"?{orgId:otherOrg}:{})};
 await expect(f.chains.setOwner(TEST_ORG,f.id,{kind:"member",developerId:OMAR.developerId},by,undefined,mark,opts)).rejects.toMatchObject({code:"FORBIDDEN"});expect(f.snapshot()).toEqual(before);
});
for(const who of [ADA,DEB,MAYA])it(`preserves legitimate ${who.name} transfer authority`,async()=>{
 const f=await fixture();if(who===MAYA)f.t.grantRole(MAYA,"maintainer");
 const body=who===MAYA?{owner:{kind:"project",project:"payments"},accountable:{developerId:MAYA.developerId}}:{owner:{kind:"member",developerId:OMAR.developerId}};
 expect((await f.t.api(who,"PUT",f.path+"/owner",body)).status).toBe(200);
});
it("an unrelated member cannot transfer and a foreign org cannot borrow current authority",async()=>{
 const f=await fixture(),before=f.snapshot();expect((await f.t.api(OMAR,"PUT",f.path+"/owner",{owner:{kind:"member",developerId:OMAR.developerId}})).status).toBe(404);
 await expect(f.chains.setOwner(otherOrg,f.id,{kind:"member",developerId:OMAR.developerId},DEB.developerId,undefined,{orgId:TEST_ORG,developerId:DEB.developerId,requestId:f.requestId,fingerprint:"fixture"},{actor:{developerId:DEB.developerId,role:"admin"}})).rejects.toMatchObject({code:"FORBIDDEN"});expect(f.snapshot()).toEqual(before);
});
for(const field of ["budget","status"] as const)it(`pins the route's ${field} snapshot while preserving native resource-conflict mapping`,async()=>{
 const f=await fixture(),send=f.t.db.send.bind(f.t.db);let reads=0,raced=false,afterRace=f.snapshot();
 f.t.db.send=async command=>{const input=command.input as {Key?:{pk?:string;sk?:string}};
 if(command.constructor.name==="GetCommand"&&input.Key?.pk===f.key.pk&&input.Key.sk===f.key.sk&&!raced&&++reads===2){
  raced=true;const result=field==="budget"?await f.t.api(ADA,"PUT",f.path+"/budget",{monthlyUsd:12}):await f.t.api(ADA,"POST",f.path+"/archive",{});expect(result.status).toBe(200);afterRace=f.snapshot();
 }return send(command);};
 expect((await f.transfer()).status).toBe(409);expect(raced).toBe(true);expect(f.snapshot()).toEqual(afterRace);expect(f.t.db.get(agentRequestKey(TEST_ORG,DEB.developerId,f.requestId))).toBeUndefined();
});
for(const field of ["owner","accountable"] as const)it(`refuses a real ${field} change after the store has obtained its native read`,async()=>{
 const f=await fixture(field==="accountable");
 // No monthly share: isolate native META refusal from an independently failing counter.
 expect((await f.t.api(ADA,"PUT",f.path+"/budget",{monthlyUsd:null})).status).toBe(200);
 if(field==="accountable")f.t.grantRole(MAYA,"maintainer");
 const before=f.t.db.get(f.key)!,send=f.t.db.send.bind(f.t.db);let reads=0,raced=false,afterRace=f.snapshot();
 f.t.db.send=async command=>{
  const result=await send(command),input=command.input as {Key?:{pk?:string;sk?:string}};
  if(command.constructor.name==="GetCommand"&&input.Key?.pk===f.key.pk&&input.Key.sk===f.key.sk&&!raced&&++reads===2){
   raced=true;
   expect((result as {Item?:Record<string,unknown>}).Item).toMatchObject({owner:before.owner});
   const changed=await f.t.api(ADA,"PUT",f.path+"/"+field,field==="owner"?{owner:{kind:"member",developerId:BEN.developerId}}:{accountable:{developerId:MAYA.developerId}});
   expect(changed.status).toBe(200);afterRace=f.snapshot();
   expect((result as {Item?:Record<string,unknown>}).Item?.[field]).toEqual(before[field]);
   expect(f.t.db.get(f.key)?.[field]).not.toEqual(before[field]);
  }
  return result;
 };
 expect((await f.transfer()).status).toBe(409);expect(raced).toBe(true);expect(f.snapshot()).toEqual(afterRace);expect(f.t.db.get(agentRequestKey(TEST_ORG,DEB.developerId,f.requestId))).toBeUndefined();
});

for(const kind of ["removed","merged"] as const)it(`preserves real SYSTEM ${kind} owner moves`,async()=>{
 const f=await fixture(),members=await import("../../packages/broker/src/chains/members.js"),deps={...f.t.deps(),chains:f.chains};
 const moved=kind==="removed"?await members.onChainOwnersRemoved(deps,{orgId:TEST_ORG,developerId:MAYA.developerId,successorId:ADA.developerId}):await members.onChainOwnersMerged(deps,{orgId:TEST_ORG,duplicateId:MAYA.developerId,survivorId:OMAR.developerId});
 const target=kind==="removed"?ADA:OMAR;expect(moved).toContain(target.developerId);expect(f.t.db.get(f.key)?.owner).toEqual({kind:"member",developerId:target.developerId});
 expect(f.t.db.find(row=>row.pk===f.key.pk&&row.kind==="owner_changed")).toEqual([expect.objectContaining({by:"system",cause:{kind:kind==="removed"?"member_removed":"member_merged",developerId:MAYA.developerId}})]);
});
for(const loss of [false,true])it(`actual owner_cap decider ${loss?"loses authority atomically":"approves with one org-open check"}`,async()=>{
 const f=await fixture();await f.t.budgeted(49,OMAR);await f.t.budgeted(50,OMAR);const reply=await f.transfer();expect(reply.status).toBe(202);const id=String(reply.body.spendRequestId),before=f.snapshot(),send=f.t.db.send.bind(f.t.db);let commits=0;
 f.t.db.send=async command=>{const items=(command.input as {TransactItems?:Array<{Update?:{Key?:{pk?:string;sk?:string}};ConditionCheck?:{Key:{pk:string;sk:string}}}>}).TransactItems;
 if(items?.some(i=>i.Update?.Key?.pk===f.key.pk&&i.Update.Key.sk===f.key.sk)){
 commits++;expect(items.filter(i=>i.ConditionCheck?.Key.pk===orgMetaKey(TEST_ORG).pk&&i.ConditionCheck.Key.sk==="META")).toHaveLength(1);
 if(loss)f.t.db.set({...f.t.db.get(orgMemberKey(TEST_ORG,ADA.developerId))!,role:"member"});
 }return send(command);};
 if(loss){await expect(decideSpendRequest({...f.t.deps(),chains:f.chains},f.t.caller(ADA,"owner"),id,{requestId:randomUUID(),decision:"APPROVE"})).rejects.toMatchObject({code:"FORBIDDEN"});expect(f.snapshot()).toEqual(before);expect(f.t.requests().find(r=>r.spendRequestId===id)?.status).toBe("PENDING");}
 else {await decideSpendRequest({...f.t.deps(),chains:f.chains},f.t.caller(ADA,"owner"),id,{requestId:randomUUID(),decision:"APPROVE"});expect(f.t.db.get(f.key)?.owner).toEqual({kind:"member",developerId:OMAR.developerId});expect(f.t.requests().find(r=>r.spendRequestId===id)?.status).toBe("APPROVED");expect(f.t.db.find(row=>row.pk===f.key.pk&&row.kind==="owner_changed")).toEqual([expect.objectContaining({by:ADA.developerId})]);}
 expect(commits).toBe(1);
});
for(const after of ["none","actor","snapshot"] as const)it(`holdingOwnerCap retry retains original authority: ${after}`,async()=>{
 const f=await fixture(),send=f.t.db.send.bind(f.t.db);let commits=0,nested=false,afterRace=f.snapshot();
 f.t.db.send=async command=>{const items=(command.input as {TransactItems?:Array<{Update?:{Key?:{pk?:string;sk?:string}}}>}).TransactItems;
 if(!nested&&items?.some(i=>i.Update?.Key?.pk===f.key.pk&&i.Update.Key.sk===f.key.sk)){
 commits++;
 if(commits===1){const key=ownerBudgetKey(TEST_ORG,OMAR.developerId),row=f.t.db.get(key)!;f.t.db.set({...row,version:Number(row.version??0)+1});
 try{return await send(command);}catch(error){
 if(after==="snapshot"){nested=true;expect((await f.t.api(ADA,"PUT",f.path+"/budget",{monthlyUsd:12})).status).toBe(200);afterRace=f.snapshot();nested=false;}
 throw error;}}
 if(after==="actor")f.t.db.set({...f.t.db.get(orgMemberKey(TEST_ORG,DEB.developerId))!,role:"member"});
 }return send(command);};
 const before=f.snapshot(),reply=await f.transfer();expect(commits).toBe(2);expect(reply.status).toBe(after==="actor"?403:after==="snapshot"?409:200);
 if(after!=="none"){expect(f.snapshot()).toEqual(after==="snapshot"?afterRace:before);expect(f.t.db.get(agentRequestKey(TEST_ORG,DEB.developerId,f.requestId))).toBeUndefined();}
});
