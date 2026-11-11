// M37 controller: one ordinary custom-agent owner transfer, with real HTTP and native commit.
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { agentKey, agentRequestKey, OrgIdSchema } from "@rovara-code/contracts";
import { developerOrgKey, orgMemberKey, orgMetaKey } from "@agentx/cloud-contracts";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { MAYA, OMAR } from "../support/developer-task-broker.js";
import { ADA, BEN, DEB, TRIAGE, setup } from "../support/spend-world.js";
import { TEST_ORG } from "../support/orgs.js";
const otherOrg=OrgIdSchema.parse("org_"+"b".repeat(20));
async function fixture(project=false){
 const capture=capturingAuditDeps(),t=await setup({extra:{audit:capture.audit}});capture.attach(t.db);
 const id=project?await t.agentOf(TRIAGE,{by:BEN,owner:{kind:"project",project:"payments"},accountable:BEN}):await t.budgeted(10);
 if(project)expect((await t.api(ADA,"PUT",`/v1/app/agents/${id}/budget`,{monthlyUsd:10})).status).toBe(200);
 await t.budgeted(1,OMAR);const key=agentKey(TEST_ORG,id,"META"),path=`/v1/app/agents/${id}`,requestId=randomUUID();
 const snapshot=()=>({agent:t.db.get(key),totals:[t.ownerTotal(MAYA),t.ownerTotal(OMAR),t.ownerTotal(BEN)],events:t.agentEvents(id,"owner_changed"),audit:capture.recorded(),pending:capture.pending()});
 const transfer=()=>t.api(DEB,"PUT",path+"/owner",{requestId,owner:{kind:"member",developerId:OMAR.developerId}});
 return{t,id,key,path,requestId,capture,snapshot,transfer};
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
 await expect(f.t.deps().store.setOwner(TEST_ORG,f.id,{kind:"member",developerId:OMAR.developerId},by,undefined,mark,opts)).rejects.toMatchObject({code:"FORBIDDEN"});expect(f.snapshot()).toEqual(before);
});
for(const who of [ADA,DEB,MAYA])it(`preserves legitimate ${who.name} transfer authority`,async()=>{
 const f=await fixture();if(who===MAYA)f.t.grantRole(MAYA,"maintainer");
 const body=who===MAYA?{owner:{kind:"project",project:"payments"},accountable:{developerId:MAYA.developerId}}:{owner:{kind:"member",developerId:OMAR.developerId}};
 expect((await f.t.api(who,"PUT",f.path+"/owner",body)).status).toBe(200);
});
it("an unrelated member cannot transfer and a foreign org cannot borrow current authority",async()=>{
 const f=await fixture(),before=f.snapshot();expect((await f.t.api(OMAR,"PUT",f.path+"/owner",{owner:{kind:"member",developerId:OMAR.developerId}})).status).toBe(404);
 await expect(f.t.deps().store.setOwner(otherOrg,f.id,{kind:"member",developerId:OMAR.developerId},DEB.developerId,undefined,{orgId:TEST_ORG,developerId:DEB.developerId,requestId:f.requestId,fingerprint:"fixture"},{actor:{developerId:DEB.developerId,role:"admin"}})).rejects.toMatchObject({code:"FORBIDDEN"});expect(f.snapshot()).toEqual(before);
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
