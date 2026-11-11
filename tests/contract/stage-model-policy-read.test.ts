import { expect, it } from "vitest";
import { readModelSelectionPolicy,modelSelectionRevisionChecks } from "../../packages/broker/src/model-selection/policy-store.js";
import type { OrgId } from "@rovara-code/contracts";
const org="org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
it("returns a virtual revision-zero policy only for an absent row, using one consistent Get",async()=>{
 let input:Record<string,unknown>|undefined;
 const result=await readModelSelectionPolicy({tableName:"state",documentClient:{send:async(command)=>{input=(command as {input:Record<string,unknown>}).input;return {};}}},org);
 expect(result).toEqual({version:1,revision:0,rankingVersion:"g3-v1",stepOverrides:{}});
 expect(input).toMatchObject({ConsistentRead:true,Key:{pk:`ORG#${org}#SETTINGS`,sk:"MODEL_SELECTION_POLICY"}});
});
it("keeps a stored policy's revision and strict override fields",async()=>{
 const policy={version:1,revision:4,rankingVersion:"g3-v1",stepOverrides:{build:{model:{provider:"anthropic",modelId:"claude-sonnet-4-6"},thinkingLevel:null,locked:true}}};
 expect(await readModelSelectionPolicy({tableName:"state",documentClient:{send:async()=>({Item:{...policy,orgId:org,entityType:"MODEL_SELECTION_POLICY"}})}},org)).toEqual(policy);
});
it("refuses corrupt, misbound and unreadable policy rather than inheriting defaults",async()=>{
 for(const Item of [{orgId:"other",entityType:"MODEL_SELECTION_POLICY",version:1,revision:1,rankingVersion:"g3-v1",stepOverrides:{}},{orgId:org,entityType:"MODEL_SELECTION_POLICY",revision:1}]) await expect(readModelSelectionPolicy({tableName:"state",documentClient:{send:async()=>({Item})}},org)).rejects.toThrow("could not be read");
 await expect(readModelSelectionPolicy({tableName:"state",documentClient:{send:async()=>{throw Error("raw storage message");}}},org)).rejects.toThrow("could not be read");
});

it("fences the exact company, source and guardrail revisions in one transaction",async()=>{
 const {mergeWorld}=await import("../support/rovara-code-merge-world.js");
 const {TransactWriteCommand}=await import("@aws-sdk/lib-dynamodb");
 const { modelSourcesKey, agentGuardrailsKey } = await import("@rovara-code/contracts"), { orgSettingsKey } = await import("@agentx/cloud-contracts");
 const keys=[orgSettingsKey(org,"MODEL_SELECTION_POLICY"),modelSourcesKey(org),agentGuardrailsKey(org)];
 for(const revision of [0,3])for(const race of [-1,0,1,2]){
  const w=mergeWorld();
  if(revision>0)for(const key of keys)w.db.set({...key,revision});
  const checks=modelSelectionRevisionChecks("state",org,{companyRevision:revision,sourcesRevision:revision,guardrailsRevision:revision});
  expect(checks.map(item=>item.ConditionCheck?.Key)).toEqual(keys);
  if(race>=0)w.db.set({...keys[race]!,revision:revision+1});
  const command=new TransactWriteCommand({TransactItems:[...checks,{Put:{TableName:"state",Item:{pk:"C53_SELECTION",sk:"META"}}}]});
  if(race<0){await w.db.send(command);expect(w.db.get("C53_SELECTION","META")).toBeDefined();}
  else {await expect(w.db.send(command)).rejects.toThrow();expect(w.db.get("C53_SELECTION","META")).toBeUndefined();}
 }
});

it("refuses invalid revision conditions before preparing a transaction",()=>{
 for(const value of [-1,0.5,Number.NaN,Number.MAX_SAFE_INTEGER+1])expect(()=>modelSelectionRevisionChecks("state",org,{companyRevision:0,sourcesRevision:value,guardrailsRevision:0})).toThrow("could not be read");
});
