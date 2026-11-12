// M44 controller: chain accountable only, real HTTP and native atomic commit.
import "../support/automations-on.js";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { chainKey, agentRequestKey, OrgIdSchema } from "@rovara-code/contracts";
import { spendRequestKey, ownerBudgetKey, developerOrgKey, orgMemberKey, orgMetaKey } from "@agentx/cloud-contracts";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { MAYA, OMAR } from "../support/developer-task-broker.js";
import { ADA, BEN, CARL, DEB, setup } from "../support/spend-world.js";
import { ChainStore } from "../../packages/broker/src/chains/store.js";
import { decideSpendRequest } from "../../packages/broker/src/spend/requests.js";
import { TEST_ORG } from "../support/orgs.js";
const otherOrg=OrgIdSchema.parse("org_"+"b".repeat(20));
async function fixture(){
 const capture=capturingAuditDeps(),t=await setup({decide:true,extra:{audit:capture.audit}});capture.attach(t.db);
 t.grantRole(OMAR,"maintainer");
 const created=await t.api(BEN,"POST","/v1/app/chains",{name:`Fence ${randomUUID().slice(0,8)}`,owner:{kind:"project",project:"payments"},accountable:{developerId:BEN.developerId}});expect(created.status,JSON.stringify(created.body)).toBe(201);
 const id=(created.body.chain as {chainId:string}).chainId;
 expect((await t.api(ADA,"PUT",`/v1/app/chains/${id}/budget`,{monthlyUsd:10})).status).toBe(200);
 const chains=new ChainStore({documentClient:t.db,tableName:"state",now:Date.now,agents:t.deps().store,audit:capture.audit});
 const decide=(who:typeof ADA,requestId:string)=>decideSpendRequest({...t.deps(),chains},t.caller(who,who===ADA?"owner":"admin"),requestId,{requestId:randomUUID(),decision:"APPROVE"});
 await t.budgeted(1,OMAR);const key=chainKey(TEST_ORG,id,"META"),path=`/v1/app/chains/${id}`,requestId=randomUUID();
 const snapshot=()=>({chain:t.db.get(key),counters:[MAYA,OMAR,BEN,ADA,DEB].map(who=>t.db.get(ownerBudgetKey(TEST_ORG,who.developerId))),events:t.db.find(row=>row.pk===key.pk && row.entityType==="CHAIN_EVENT"),receipts:t.db.find(row=>row.entityType==="AGENT_REQUEST"),audit:capture.recorded(),pending:capture.pending()});
 const transfer=()=>t.api(DEB,"PUT",path+"/accountable",{requestId,accountable:{developerId:OMAR.developerId}});
 return{t,chains,decide,id,key,path,requestId,capture,snapshot,transfer};
}
for(const loss of ["member_role","pointer_moved","pointer_deleted","member_removed","org_closing","org_closed"] as const)it(`accountable transfer refuses ${loss} at the real commit`,async()=>{
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
 const f=await fixture(),send=f.t.db.send.bind(f.t.db);let reads=0,raced=false,afterRace=f.snapshot();
 if(field==="accountable")f.t.grantRole(MAYA,"maintainer");
 f.t.db.send=async command=>{const input=command.input as {Key?:{pk?:string;sk?:string}};
 if(command.constructor.name==="GetCommand"&&input.Key?.pk===f.key.pk&&input.Key.sk===f.key.sk&&!raced&&++reads===2){
  raced=true;const result=await f.t.api(ADA,"PUT",f.path+"/"+field,field==="owner"?{owner:{kind:"member",developerId:BEN.developerId}}:{accountable:{developerId:MAYA.developerId}});expect(result.status).toBe(200);afterRace=f.snapshot();
 }return send(command);};
 expect((await f.transfer()).status).toBe(403);expect(raced).toBe(true);expect(f.snapshot()).toEqual(afterRace);expect(f.t.db.get(agentRequestKey(TEST_ORG,DEB.developerId,f.requestId))).toBeUndefined();
});
for(const invalid of ["request_no_actor","no_request_no_actor","actor_by","request_developer","request_org","actor_and_override","system_without_cause","system_request"] as const)it(`refuses ${invalid} before accountable side effects`,async()=>{
 const f=await fixture(),before=f.snapshot(),actor={developerId:DEB.developerId,role:"admin" as const},request={orgId:TEST_ORG,developerId:DEB.developerId,requestId:f.requestId,fingerprint:"fixture"};
 const opts=invalid==="actor_and_override"?{actor,overrideCap:{actor,spendRequestId:randomUUID(),items:[],closed:()=>new Error("fixture closed")}}:invalid==="system_request"?{cause:{kind:"member_removed" as const,developerId:MAYA.developerId}}:invalid==="request_no_actor"||invalid==="no_request_no_actor"||invalid==="system_without_cause"?{}:{actor};
 const by=invalid==="actor_by"?OMAR.developerId:invalid.startsWith("system")?"system":DEB.developerId;
 const mark=invalid==="no_request_no_actor"||invalid==="system_without_cause"?undefined:{...request,...(invalid==="request_developer"?{developerId:OMAR.developerId}:{}),...(invalid==="request_org"?{orgId:otherOrg}:{})};
 await expect(f.chains.setAccountable(TEST_ORG,f.id,{developerId:OMAR.developerId},by,mark,opts)).rejects.toMatchObject({code:"FORBIDDEN"});expect(f.snapshot()).toEqual(before);
});
for(const who of [ADA,DEB,BEN])it(`preserves legitimate ${who.name} accountable authority`,async()=>{
 const f=await fixture();expect((await f.t.api(who,"PUT",f.path+"/accountable",{accountable:{developerId:OMAR.developerId}})).status).toBe(200);
});
it("an unrelated contributor cannot manage and a foreign org cannot borrow current authority",async()=>{
 const f=await fixture(),before=f.snapshot();expect((await f.t.api(CARL,"PUT",f.path+"/accountable",{accountable:{developerId:OMAR.developerId}})).status).toBe(403);
 await expect(f.chains.setAccountable(otherOrg,f.id,{developerId:OMAR.developerId},DEB.developerId,{orgId:TEST_ORG,developerId:DEB.developerId,requestId:f.requestId,fingerprint:"fixture"},{actor:{developerId:DEB.developerId,role:"admin"}})).rejects.toMatchObject({code:"FORBIDDEN"});expect(f.snapshot()).toEqual(before);
});
it("member-owned chains retain CONFIG_INVALID",async()=>{
 const f=await fixture(),reply=await f.t.api(MAYA,"POST","/v1/app/chains",{name:`Mine ${randomUUID().slice(0,8)}`});expect(reply.status).toBe(201);const id=(reply.body.chain as {chainId:string}).chainId;
 expect((await f.t.api(ADA,"PUT",`/v1/app/chains/${id}/accountable`,{accountable:{developerId:OMAR.developerId}})).status).toBe(400);
 await expect(f.chains.setAccountable(TEST_ORG,id,{developerId:OMAR.developerId},ADA.developerId,undefined,{actor:{developerId:ADA.developerId,role:"owner"}})).rejects.toMatchObject({code:"CONFIG_INVALID"});
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
 const f=await fixture();
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


for(const kind of ["removed","merged"] as const)it(`preserves real SYSTEM ${kind} accountable moves`,async()=>{
 const f=await fixture(),members=await import("../../packages/broker/src/chains/members.js"),deps={...f.t.deps(),chains:f.chains};
 if(kind==="removed"){f.t.db.delete(orgMemberKey(TEST_ORG,BEN.developerId));await members.onChainOwnersRemoved(deps,{orgId:TEST_ORG,developerId:BEN.developerId,successorId:ADA.developerId});}
 else await members.onChainOwnersMerged(deps,{orgId:TEST_ORG,duplicateId:BEN.developerId,survivorId:OMAR.developerId});
 expect(f.t.db.get(f.key)?.accountable).toEqual({developerId:OMAR.developerId});
 expect(f.t.db.find(row=>row.pk===f.key.pk&&row.kind==="owner_changed")).toEqual([expect.objectContaining({by:"system",cause:{kind:kind==="removed"?"member_removed":"member_merged",developerId:BEN.developerId}})]);
});
for(const loss of [false,true])it(`actual accountable owner_cap decider ${loss?"loses authority atomically":"approves with one org-open check"}`,async()=>{
 const f=await fixture();await f.t.budgeted(49,OMAR);await f.t.budgeted(50,OMAR);const reply=await f.transfer();expect(reply.status).toBe(202);const id=String(reply.body.spendRequestId),before=f.snapshot(),send=f.t.db.send.bind(f.t.db);let commits=0;
 f.t.db.send=async command=>{const items=(command.input as {TransactItems?:Array<{Update?:{Key?:{pk?:string;sk?:string}};ConditionCheck?:{Key:{pk:string;sk:string}}}>}).TransactItems;
 if(items?.some(i=>i.Update?.Key?.pk===f.key.pk&&i.Update.Key.sk===f.key.sk)){
 commits++;expect(items.filter(i=>i.ConditionCheck?.Key.pk===orgMetaKey(TEST_ORG).pk&&i.ConditionCheck.Key.sk==="META")).toHaveLength(1);
 if(loss)f.t.db.set({...f.t.db.get(orgMemberKey(TEST_ORG,ADA.developerId))!,role:"member"});
 }return send(command);};
 if(loss){await expect(f.decide(ADA,id)).rejects.toMatchObject({code:"FORBIDDEN"});expect(f.snapshot()).toEqual(before);expect(f.t.requests().find(r=>r.spendRequestId===id)?.status).toBe("PENDING");}
 else {await f.decide(ADA,id);expect(f.t.db.get(f.key)?.accountable).toEqual({developerId:OMAR.developerId});expect(f.t.requests().find(r=>r.spendRequestId===id)?.status).toBe("APPROVED");expect(f.t.db.find(row=>row.pk===f.key.pk&&row.kind==="owner_changed")).toEqual([expect.objectContaining({by:ADA.developerId})]);}
 expect(commits).toBe(1);
});
for(const after of ["none","actor","snapshot"] as const)it(`holdingCap retry retains original authority: ${after}`,async()=>{
 const f=await fixture(),send=f.t.db.send.bind(f.t.db);let commits=0,nested=false,afterRace=f.snapshot(),counterWinner=f.snapshot();
 f.t.db.send=async command=>{const items=(command.input as {TransactItems?:Array<{Update?:{Key?:{pk?:string;sk?:string}}}>}).TransactItems;
 if(!nested&&items?.some(i=>i.Update?.Key?.pk===f.key.pk&&i.Update.Key.sk===f.key.sk)){
 commits++;
 if(commits===1){const key=ownerBudgetKey(TEST_ORG,OMAR.developerId),row=f.t.db.get(key)!;f.t.db.set({...row,version:Number(row.version??0)+1});counterWinner=f.snapshot();
 try{return await send(command);}catch(error){
 if(after==="snapshot"){nested=true;expect((await f.t.api(ADA,"PUT",f.path+"/budget",{monthlyUsd:12})).status).toBe(200);afterRace=f.snapshot();nested=false;}
 throw error;}}
 if(after==="actor")f.t.db.set({...f.t.db.get(orgMemberKey(TEST_ORG,DEB.developerId))!,role:"member"});
 }return send(command);};
 const reply=await f.transfer();expect(commits).toBe(2);expect(reply.status).toBe(after==="actor"?403:after==="snapshot"?409:200);
 if(after!=="none"){expect(f.snapshot()).toEqual(after==="snapshot"?afterRace:counterWinner);expect(f.t.db.get(agentRequestKey(TEST_ORG,DEB.developerId,f.requestId))).toBeUndefined();}
});
it("self-assignment over the cap asks approval and the requester cannot decide it",async()=>{
 const f=await fixture();await f.t.budgeted(50,DEB);await f.t.budgeted(50,DEB);const before=f.t.db.get(f.key),reply=await f.t.api(DEB,"PUT",f.path+"/accountable",{accountable:{developerId:DEB.developerId}});expect(reply.status).toBe(202);expect(f.t.db.get(f.key)).toEqual(before);
 const id=String(reply.body.spendRequestId);await expect(f.decide(DEB,id)).rejects.toMatchObject({code:"FORBIDDEN"});expect(f.t.requests().find(r=>r.spendRequestId===id)?.status).toBe("PENDING");await f.decide(ADA,id);expect(f.t.db.get(f.key)?.accountable).toEqual({developerId:DEB.developerId});
});

// M44 Minor 1 carried into the approved M45 implementation: direct compatibility controls.
it("retains custom agent accountable approval alongside chain flow",async()=>{
 const t=await setup();t.grantRole(OMAR,"maintainer");
 const created=await t.api(BEN,"POST","/v1/app/agents",{name:"Accountable compatibility",owner:{kind:"project",project:"payments"},accountable:{developerId:BEN.developerId}});expect(created.status).toBe(201);
 const id=(created.body.agent as {agentId:string}).agentId,path=`/v1/app/agents/${id}`;
 expect((await t.api(ADA,"PUT",path+"/budget",{monthlyUsd:30})).status).toBe(200);await t.budgeted(40,DEB);await t.budgeted(40,DEB);t.grantRole(DEB,"maintainer");
 const reply=await t.api(BEN,"PUT",path+"/accountable",{accountable:{developerId:DEB.developerId}});expect(reply.status).toBe(202);await t.decide(ADA,String(reply.body.spendRequestId));expect((await t.deps().store.get(TEST_ORG,id))?.accountable).toEqual({developerId:DEB.developerId});
});
it("retains legacy builtin accountable approval without forOwner alongside chain flow",async()=>{
 const t=await setup(),id="root-cause-analyst",path=`/v1/app/agents/${id}`;
 expect((await t.api(ADA,"PUT",path+"/accountable",{accountable:{developerId:ADA.developerId}})).status).toBe(200);expect((await t.api(ADA,"PUT",path+"/budget",{monthlyUsd:30})).status).toBe(200);await t.budgeted(40,DEB);await t.budgeted(40,DEB);
 const reply=await t.api(DEB,"PUT",path+"/accountable",{accountable:{developerId:DEB.developerId}});expect(reply.status).toBe(202);const requestId=String(reply.body.spendRequestId),key=spendRequestKey(TEST_ORG,requestId),{forOwner:_forOwner,ownerFinancialTerms:_financialTerms,...record}=t.db.get(key)!;void _forOwner;void _financialTerms;t.db.set(record);
 await t.decide(ADA,requestId);expect((await t.deps().store.getBuiltinSettings(TEST_ORG,id))?.accountable).toEqual({developerId:DEB.developerId});expect(t.requests().find(r=>r.spendRequestId===requestId)?.status).toBe("APPROVED");
});
