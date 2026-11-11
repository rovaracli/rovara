import { expect, it } from "vitest";
import { readStageModelEvidence } from "../../packages/broker/src/model-selection/evidence.js";
import type { StoredModelSources } from "../../packages/broker/src/model-sources/store.js";
import type { OrgId } from "@rovara-code/contracts";
const org="org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const model={provider:"amazon-bedrock",modelId:"us.anthropic.claude-sonnet-4-6"};
const stored=():StoredModelSources=>({sources:[],order:["rovara"],credentials:[],removing:[],revision:2});
it("binds built-in catalog evidence to the org and current sources revision",async()=>{
 const result=await readStageModelEvidence({routing:{sources:{read:async()=>stored()}},now:()=>0},{orgId:org,project:"web",models:[model]});
 expect(result.sourcesRevision).toBe(2);expect(result.candidates).toEqual([expect.objectContaining({enabled:true,inEffectiveOrder:true,evidence:{orgId:org,sourcesRevision:2,kind:"rovara_catalog"}})]);
});
it("does not invent access from a source removed from effective order",async()=>{
 const sources=stored();sources.order=[];
 const result=await readStageModelEvidence({routing:{sources:{read:async()=>sources}},now:()=>0},{orgId:org,project:"web",models:[model]});
 expect(result.candidates).toEqual([]);
});
it("keeps no-proxy built-in behavior but still requires a known catalog model",async()=>{
 const result=await readStageModelEvidence({routing:{},now:()=>0},{orgId:org,project:"web",models:[model,{provider:"evil",modelId:"unknown"}]});
 expect(result.sourcesRevision).toBe(0);expect(result.candidates).toHaveLength(1);
});
it("never treats source read failure as an empty verified set",async()=>{
 await expect(readStageModelEvidence({routing:{sources:{read:async()=>{throw Error("secret");}}},now:()=>0},{orgId:org,project:"web",models:[model]})).rejects.toThrow("could not be read");
});
it("rejects excess candidate work before reading any sources",async()=>{
 let reads=0;
 await expect(readStageModelEvidence({routing:{sources:{read:async()=>{reads++;return stored();}}},now:()=>0},{orgId:org,project:"web",models:Array(24).fill(model)})).rejects.toThrow();expect(reads).toBe(0);
});
it("requires a tested Bedrock role and never accepts untested/removed/disabled sources",async()=>{
 const sources=stored();const sourceId="src_abcdefghijklmnopqrst";
 sources.order=[sourceId];sources.sources=[{sourceId,kind:"bedrock",label:"Test source",roleArn:"arn:aws:iam::123456789012:role/test",region:"us-east-1",externalId:`rovara-${org}`,tested:false,models:[{catalog:model}]}];
 const deps={routing:{sources:{read:async()=>sources},launch:{kinds:["bedrock" as const]}},now:()=>0};
 expect((await readStageModelEvidence(deps,{orgId:org,project:"web",models:[model]})).candidates).toEqual([]);
 const bedrock=sources.sources[0];
 if(bedrock?.kind!=="bedrock") throw Error("fixture source kind");
 bedrock.tested=true;
 expect((await readStageModelEvidence(deps,{orgId:org,project:"web",models:[model]})).candidates[0]?.evidence?.kind).toBe("tested_bedrock_role");
 sources.removing=[{sourceId,kind:"bedrock"}];
 expect((await readStageModelEvidence(deps,{orgId:org,project:"web",models:[model]})).candidates).toEqual([]);
});
it("binds the payer's live ChatGPT plan record without exposing account or credential material",async()=>{
 const sources=stored();sources.order=["personal-chatgpt"];
 const wanted={provider:"openai",modelId:"gpt-6.1-sol"};
 const view={connected:true,status:"connected" as const,connectedAt:"2026-10-29T22:00:00Z",models:[wanted.modelId]};
 const deps={routing:{sources:{read:async()=>sources}},chatgpt:{settings:async()=>({enabled:true,preferredModel:wanted.modelId}),view:async()=>view},now:()=>0};
 const result=await readStageModelEvidence(deps,{orgId:org,project:"web",models:[wanted],payerDeveloperId:"payer"});
 expect(result.candidates[0]?.evidence).toMatchObject({payerDeveloperId:"payer",kind:"chatgpt_connection",sourcesRevision:2});
 expect(result.connectionRevision).toMatch(/^[a-f0-9]{64}$/);
 view.connected=false;
 expect((await readStageModelEvidence(deps,{orgId:org,project:"web",models:[wanted],payerDeveloperId:"payer"})).candidates).toEqual([]);
});

it("never attests an Anthropic provider route from the canonically equivalent Rovara Bedrock model",async()=>{
 const direct={provider:"anthropic",modelId:"claude-sonnet-4-6"};
 const result=await readStageModelEvidence({routing:{sources:{read:async()=>stored()}},now:()=>0},{orgId:org,project:"web",models:[direct]});
 expect(result.candidates).toEqual([]);
});
it("excludes a failed personal plan from runtime alternatives without changing stored source order",async()=>{
 const sources=stored();sources.order=["personal-chatgpt","rovara"];
 const wanted={provider:"openai",modelId:"gpt-6.1-sol"};let connectionReads=0;
 const deps={routing:{sources:{read:async()=>sources}},chatgpt:{settings:async()=>({enabled:true,preferredModel:wanted.modelId}),view:async()=>{connectionReads++;return {connected:true,status:"connected" as const,connectedAt:"2026-10-29T22:00:00Z",models:[wanted.modelId]};}},now:()=>0};
 const result=await readStageModelEvidence(deps,{orgId:org,project:"web",models:[wanted,model],payerDeveloperId:"payer",excludePersonalPlan:true});
 expect(result.candidates.map(candidate=>candidate.sourceId)).toEqual(["rovara"]);
 expect(connectionReads).toBe(0);expect(sources.order).toEqual(["personal-chatgpt","rovara"]);
});

it("attests an existing canonical company-source alias only with that source's stored-key presence",async()=>{
 const sourceId="src_abcdefghijklmnopqrst",sources=stored();
 sources.order=[sourceId];sources.sources=[{sourceId,kind:"anthropic",label:"Company Anthropic",models:[{catalog:{provider:"anthropic",modelId:"claude-sonnet-4-6"}}]}];
 const deps={routing:{sources:{read:async()=>sources},launch:{kinds:["anthropic" as const]}},now:()=>0};
 expect((await readStageModelEvidence(deps,{orgId:org,project:"web",models:[model]})).candidates).toEqual([]);
 sources.credentials=[sourceId];
 expect((await readStageModelEvidence(deps,{orgId:org,project:"web",models:[model]})).candidates).toEqual([expect.objectContaining({model,sourceId,evidence:{orgId:org,sourcesRevision:2,kind:"stored_key"}})]);
 sources.sources[0]!.models=[{catalog:{provider:"anthropic",modelId:"claude-haiku-4-5"}}];
 expect((await readStageModelEvidence(deps,{orgId:org,project:"web",models:[model]})).candidates).toEqual([]);
});
