import {expect,it} from "vitest";
import {TransactWriteCommand} from "@aws-sdk/lib-dynamodb";
import {agentGuardrailsKey,modelSourcesKey,developerOrgKey,orgMemberKey,orgMetaKey,type OrgId} from "@agentx/contracts";
import {bedrockClaudeModelIds} from "@agentx/model-runtime/catalog";
import {FakeDynamoDb} from "../support/fake-dynamodb.js";
import {prepareCompanyModelPolicy} from "../../packages/broker/src/model-selection/company-prepare.js";
const orgId="org_aaaaaaaaaaaaaaaaaaaa" as OrgId,developerId="a".repeat(64),requestId="11111111-1111-4111-8111-111111111111";
const model={provider:"amazon-bedrock",modelId:bedrockClaudeModelIds("us")[0]!};
function fixture(){const db=new FakeDynamoDb();db.set({...orgMemberKey(orgId,developerId),orgId,developerId,role:"owner"});db.set({...developerOrgKey(developerId),orgId,role:"owner"});db.set({...orgMetaKey(orgId),orgId});return {db,deps:{documentClient:db,tableName:"state",routing:{},now:()=>Date.parse("2026-10-30T13:00:00Z")}};}
it("prepares a verified new company lock with no less-safe reason and immutable revision/source/authority fences",async()=>{
 const f=fixture(),body={version:1,requestId,expectedRevision:0,stepOverrides:{build:{model,thinkingLevel:null,locked:true}}};
 const prepared=await prepareCompanyModelPolicy(f.deps,{orgId,developerId},body);
 expect(prepared.next).toMatchObject({version:1,revision:1,stepOverrides:body.stepOverrides});expect(prepared.changes).toEqual([]);
 expect(f.db.get({pk:`ORG#${orgId}#SETTINGS`,sk:"MODEL_SELECTION_POLICY"})).toBeUndefined();
 f.db.set({...orgMetaKey(orgId),orgId,closingAt:"2026-10-30T13:01:00Z"});
 await expect(f.db.send(new TransactWriteCommand({TransactItems:[...prepared.conditions,{Put:{TableName:"state",Item:{pk:"POLICY_APPLIED",sk:"META"}}}]}))).rejects.toThrow();
 expect(f.db.get({pk:"POLICY_APPLIED",sk:"META"})).toBeUndefined();
});
it("refuses stale company revision, unknown fields and unavailable explicit models during preparation",async()=>{
 for(const body of [{version:1,requestId,expectedRevision:1,stepOverrides:{}},{version:1,requestId,expectedRevision:0,stepOverrides:{},approved:true},{version:1,requestId,expectedRevision:0,stepOverrides:{build:{model:{provider:"openai",modelId:"gpt-5.5"},locked:true}}}]){
  const f=fixture();await expect(prepareCompanyModelPolicy(f.deps,{orgId,developerId},body)).rejects.toThrow();
  expect(f.db.get({pk:`ORG#${orgId}#SETTINGS`,sk:"MODEL_SELECTION_POLICY"})).toBeUndefined();
 }
});
it("classifies removing an existing company lock as less safe without applying the change",async()=>{
 const f=fixture(),key={pk:`ORG#${orgId}#SETTINGS`,sk:"MODEL_SELECTION_POLICY"};
 f.db.set({...key,orgId,entityType:"MODEL_SELECTION_POLICY",version:1,revision:4,rankingVersion:"g3-v1",stepOverrides:{build:{model,thinkingLevel:null,locked:true}}});
 const prepared=await prepareCompanyModelPolicy(f.deps,{orgId,developerId},{version:1,requestId,expectedRevision:4,stepOverrides:{build:{model,thinkingLevel:null,locked:false}}});
 expect(prepared.changes).toContain("Removes the company model lock for build");expect(f.db.get(key)?.revision).toBe(4);
});
it("fences policy, source and guardrail changes after preparation without a partial write",async()=>{
 for(const sk of ["MODEL_SELECTION_POLICY",modelSourcesKey(orgId).sk,agentGuardrailsKey(orgId).sk]){
  const f=fixture(),prepared=await prepareCompanyModelPolicy(f.deps,{orgId,developerId},{version:1,requestId,expectedRevision:0,stepOverrides:{build:{model,thinkingLevel:null,locked:true}}});
  const check=prepared.conditions.find(item=>item.ConditionCheck?.Key?.sk===sk)?.ConditionCheck;
  expect(check).toBeDefined();f.db.set({...check!.Key,revision:1});
  await expect(f.db.send(new TransactWriteCommand({TransactItems:[...prepared.conditions,{Put:{TableName:"state",Item:{pk:"POLICY_APPLIED",sk:"META"}}}]}))).rejects.toThrow();
  expect(f.db.get({pk:"POLICY_APPLIED",sk:"META"})).toBeUndefined();
 }
});
