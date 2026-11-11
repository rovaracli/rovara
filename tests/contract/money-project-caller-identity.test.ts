// Controller M34: own grant + caller's native sign-in record, no survivor routing.
import { randomUUID } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { expect, it } from "vitest";
import { DeveloperSignInMethodSchema, orgMetaKey, orgMemberKey, developerOrgKey, projectAiKey } from "@agentx/cloud-contracts";
import { agentRequestKey, projectMemberKey } from "@rovara-code/contracts";
import { writeProjectAi } from "../../packages/broker/src/spend/settings.js";
import { DeveloperSignInStore, developerIdentityKey, signInIdentityKey, endedByUnlink } from "../../packages/broker/src/developer/store.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { fixtureProject } from "../support/project-ai-source.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TableAwareDynamoDb } from "../support/table-aware-dynamodb.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { TEST_ORG } from "../support/orgs.js";
const BY=ownerKeyForSubject("https://idp.example.test","fixture-owner"),OTHER=ownerKeyForSubject("https://github.com","fixture-user"),key={pk:`DEVELOPER#${BY}`,sk:"META"},state="state",signin="signin";
const now=Date.parse("2026-10-28T17:00:00Z");
function setup(profile: Record<string,unknown>|undefined={developerId:BY,revoked:false},role:"member"|"admin"="member"){
 const db=new TableAwareDynamoDb(),seed=new FakeDynamoDb();fixtureProject(seed,TEST_ORG,"web");for(const row of seed.find(()=>true))db.set(state,row);
 db.set(state,{...orgMetaKey(TEST_ORG),orgId:TEST_ORG});db.set(state,{...orgMemberKey(TEST_ORG,BY),orgId:TEST_ORG,developerId:BY,role});db.set(state,{...developerOrgKey(BY),orgId:TEST_ORG,role});
 db.set(state,{...projectMemberKey(TEST_ORG,BY,"web"),entityType:"MEMBERSHIP",ownerKey:BY,projectName:"web",grantId:randomUUID(),role:"developer",projectRole:"maintainer"});
 if(profile!==undefined)db.set(signin,{...key,...profile});
 // Same native key in State deliberately differs from sign-in; a wrong-table guard is not authority.
 db.set(state,{...key,developerId:BY,revoked:false});
 const capture=capturingAuditDeps({now:()=>now}),request={orgId:TEST_ORG,developerId:BY,requestId:randomUUID(),fingerprint:"fixture"};
 const deps={audit:{...capture.audit,documentClient:db as unknown as typeof capture.audit.documentClient},documentClient:db,tableName:state,now:()=>now,projectAiSignInTableName:signin};
 const write=(extra:Record<string,unknown>={})=>writeProjectAi(deps,TEST_ORG,"web",{projectPays:false,memberAcceptRunLimitUpToUsd:2},BY,{actor:{developerId:BY,role},request,...extra});
 return{db,deps,write,capture,request};
}
for(const change of ["merge","revoke","end_sessions","unlink"] as const)it(`refuses native ${change} racing the own-grant commit`,async()=>{
 const f=setup(),settings=projectAiKey(TEST_ORG,"web");let raced=false;
 if(change==="unlink"){
  const store=new DeveloperSignInStore({documentClient:f.db,tableName:signin,now:()=>now}),at=new Date(now-60_000).toISOString(),sessionId=randomUUID();
  f.db.set(signin,{pk:`SESSION#${sessionId}`,sk:"META",sessionId,developerId:BY,amr:"oidc",identityKey:BY,startedAt:at,authTime:at,endsAt:Math.floor(now/1000)+3600});
  for(const [id,provider,issuer,subject]of[[BY,"oidc","https://idp.example.test","fixture-owner"],[OTHER,"github","https://github.com","fixture-user"]]as const){const body={developerId:BY,provider,issuer,subject,linkedAt:at,lastSignInAt:at};f.db.set(signin,{...developerIdentityKey(BY,id),...body});f.db.set(signin,{...signInIdentityKey(id),...body});}
  f.db.beforeTransaction=async input=>{const items=input.TransactItems as Array<{Put?:{TableName?:string;Item?:{pk?:string}}}>;if(!raced&&items.some(i=>i.Put?.TableName===state&&i.Put.Item?.pk===settings.pk)){raced=true;const before=f.db.get(signin,key)!;await store.unlinkIdentity({developerId:BY,sessionId,provider:"github"});const after=f.db.get(signin,key)!;for(const field of["mergedInto","revoked","sessionsEndedAt"])expect(after[field]).toEqual(before[field]);expect(endedByUnlink({startedAt:at,amr:"github",identityKey:OTHER},after as Parameters<typeof endedByUnlink>[1])).toBe(true);}};
 }else f.db.beforeTransaction=async input=>{const items=input.TransactItems as Array<{Put?:{TableName?:string;Item?:{pk?:string}}}>;if(!raced&&items.some(i=>i.Put?.TableName===state&&i.Put.Item?.pk===settings.pk)){raced=true;f.db.set(signin,{...f.db.get(signin,key)!,...(change==="merge"?{mergedInto:OTHER}:change==="revoke"?{revoked:true}:{sessionsEndedAt:new Date(now).toISOString()})});}};
 await expect(f.write()).rejects.toMatchObject({code:"FORBIDDEN"});expect(raced).toBe(true);expect(f.db.get(state,settings)).toBeUndefined();expect(f.capture.flushed()).toHaveLength(0);expect(f.db.backing.find(row=>typeof row.pk==="string"&&row.pk.includes("AUDIT_PENDING#"))).toHaveLength(0);expect(f.db.get(state,agentRequestKey(TEST_ORG,BY,f.request.requestId))).toBeUndefined();
});
for(const profile of [undefined,{developerId:BY,revoked:true},{developerId:BY,mergedInto:OTHER},{developerId:OTHER,revoked:false},{developerId:BY,revoked:"false"}])it(`refuses an unavailable/malformed/merged/revoked native profile ${String(profile?.developerId)}`,async()=>{
 const f=setup(profile);if(profile===undefined){f.db.backing.delete(JSON.stringify([signin,key.pk]),key.sk);}await expect(f.write()).rejects.toMatchObject({code:"RUNTIME_UNAVAILABLE"});expect(f.db.get(state,projectAiKey(TEST_ORG,"web"))).toBeUndefined();
});
it("refuses an explicit survivor source instead of borrowing its grant",async()=>{const f=setup();f.db.set(state,{...orgMemberKey(TEST_ORG,OTHER),orgId:TEST_ORG,developerId:OTHER,role:"member"});f.db.set(state,{...developerOrgKey(OTHER),orgId:TEST_ORG,role:"member"});f.db.set(state,{...projectMemberKey(TEST_ORG,OTHER,"web"),entityType:"MEMBERSHIP",ownerKey:OTHER,projectName:"web",grantId:randomUUID(),role:"developer",projectRole:"maintainer"});await expect(f.write({projectGrantDeveloperId:OTHER})).rejects.toMatchObject({code:"FORBIDDEN"});});
it("ordinary maintainer uses exactly one sign-in condition, admins need none",async()=>{const f=setup();await expect(f.write()).resolves.toMatchObject({revision:1});const last=f.db.transactions.at(-1)!;const items=last.TransactItems as Array<{ConditionCheck?:{TableName?:string}}>;expect(items.filter(i=>i.ConditionCheck?.TableName===signin)).toHaveLength(1);const a=setup(undefined,"admin");a.db.backing.delete(JSON.stringify([signin,key.pk]),key.sk);await expect(a.write()).resolves.toMatchObject({revision:1});});
it("missing sign-in configuration is unavailable, not an own-table fallback",async()=>{const f=setup(),deps={documentClient:f.db,tableName:state,now:()=>now};await expect(writeProjectAi(deps,TEST_ORG,"web",{projectPays:false,memberAcceptRunLimitUpToUsd:2},BY,{actor:{developerId:BY,role:"member"}})).rejects.toMatchObject({code:"RUNTIME_UNAVAILABLE"});});
it("the table adapter preserves isolation and atomic refusal across both tables",async()=>{const f=setup();f.db.set(signin,{...key,developerId:OTHER});await expect(f.db.send(new TransactWriteCommand({TransactItems:[{ConditionCheck:{TableName:signin,Key:key,ConditionExpression:"developerId = :by",ExpressionAttributeValues:{":by":BY}}},{Put:{TableName:state,Item:{pk:"proof",sk:"META"}}}]}))).rejects.toMatchObject({name:"TransactionCanceledException"});expect(f.db.get(state,{pk:"proof",sk:"META"})).toBeUndefined();expect(f.db.get(state,key)?.developerId).toBe(BY);});
it("an already signed-in pre-merge session refuses through real HTTP auth",async()=>{
 const {setup:world,BEN}=await import("../support/spend-world.js");const t=await world();
 expect((await t.api(BEN,"PUT","/v1/app/projects/payments/ai",{memberAcceptRunLimitUpToUsd:1})).status).toBe(200);
 const profileKey={pk:`DEVELOPER#${BEN.developerId}`,sk:"META"};
 t.db.set({...t.db.get(profileKey)!,mergedInto:OTHER,sessionsEndedAt:new Date(Date.now()+1000).toISOString()});
 expect((await t.api(BEN,"PUT","/v1/app/projects/payments/ai",{memberAcceptRunLimitUpToUsd:2})).status).toBe(401);
 expect(t.db.get(projectAiKey(TEST_ORG,"payments"))).toMatchObject({revision:1,memberAcceptRunLimitUpToUsd:1});
});
for(const profile of [{developerId:BY},{developerId:BY,revoked:false,sessionsEndedAt:"2026-10-27T00:00:00.000Z","sessionsEndedByMethod#github":"2026-10-27T00:00:00.000Z"}])it("fresh legitimate own writer preserves exact legacy profile marks",async()=>{const f=setup(profile);await expect(f.write()).resolves.toMatchObject({revision:1});expect(f.db.get(signin,key)).toEqual({...key,...profile});});

for(const method of DeveloperSignInMethodSchema.options)for(const existing of [false,true])it(`pins schema method ${method} from ${existing?"present":"absent"} snapshot`,async()=>{
 const field=`sessionsEndedByMethod#${method}`,f=setup({developerId:BY,revoked:false,...(existing?{[field]:"2026-10-27T00:00:00.000Z"}:{})});let raced=false;
 f.db.beforeTransaction=async input=>{const items=input.TransactItems as Array<{Put?:{TableName?:string}}>;
 if(!raced&&items.some(i=>i.Put?.TableName===state)){raced=true;f.db.set(signin,{...f.db.get(signin,key)!,[field]:new Date(now).toISOString()});}};
 await expect(f.write()).rejects.toMatchObject({code:"FORBIDDEN"});expect(raced).toBe(true);expect(f.db.get(state,projectAiKey(TEST_ORG,"web"))).toBeUndefined();
});
for(const existing of [false,true])it(`a future schema option is fenced from ${existing?"present":"absent"} without a second method list`,async()=>{
 const original=DeveloperSignInMethodSchema.options,method="fixture-future-method",field=`sessionsEndedByMethod#${method}`;
 // Test-only option injection checks dependency growth, not parser/provider registration.
 try{
  Reflect.set(DeveloperSignInMethodSchema,"options",[...original,method]);
  const f=setup({developerId:BY,revoked:false,...(existing?{[field]:"2026-10-27T00:00:00.000Z"}:{})});let raced=false;
  f.db.beforeTransaction=async input=>{const items=input.TransactItems as Array<{Put?:{TableName?:string}}>;
   if(!raced&&items.some(i=>i.Put?.TableName===state)){raced=true;f.db.set(signin,{...f.db.get(signin,key)!,[field]:new Date(now).toISOString()});}};
  await expect(f.write()).rejects.toMatchObject({code:"FORBIDDEN"});expect(raced).toBe(true);expect(f.db.get(state,projectAiKey(TEST_ORG,"web"))).toBeUndefined();
 }finally{Reflect.set(DeveloperSignInMethodSchema,"options",original);}
});
