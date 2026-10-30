import {TransactWriteCommand} from "@aws-sdk/lib-dynamodb";
import {expect,it} from "vitest";
import {loadPinnedTaskStage,loadPinnedTaskStageContext} from "../../packages/broker/src/model-selection/task-live.js";
import {createDeveloperTaskBroker} from "../support/developer-task-broker.js";
import {TEST_ORG} from "../support/orgs.js";
import {builtinRecipe,recipeDigest,projectRevisionKey} from "../../packages/contracts/src/index.js";
import {prepareTaskModelPolicyPin} from "../../packages/broker/src/model-selection/task-pin.js";
async function fixture(){
 const h=await createDeveloperTaskBroker(),recipe=builtinRecipe("rovara-code",1),digest=recipeDigest(recipe);
 const deps={documentClient:h.db,tableName:"state",routing:{},now:()=>Date.now()};
 const pin=await prepareTaskModelPolicyPin(deps,{orgId:TEST_ORG,project:"payments",agentId:"rovara-code",recipe,digest});
 const input={orgId:TEST_ORG,project:"payments",agentId:"rovara-code",recipe,digest,pin,stage:"build" as const,priorModels:{},deniedModels:[]};
 return {h,deps,input};
}
it("loads current project identity, guardrails and actual source evidence without writes",async()=>{
 const {h,deps,input}=await fixture(),before=h.db.transactions().length;
 const result=await loadPinnedTaskStage(deps,input);
 expect(result).toMatchObject({kind:"resolved",sourceId:"rovara"});
 expect(h.db.transactions()).toHaveLength(before);
 await expect(loadPinnedTaskStage(deps,{...input,project:"missing"})).rejects.toThrow();
});
it("refuses project reincarnation and carries task denial into the sole resolver",async()=>{
 const {h,deps,input}=await fixture();const first=await loadPinnedTaskStage(deps,input);expect(first.kind).toBe("resolved");
 if(first.kind!=="resolved")throw Error("fixture needs a callable model");
 const pin={...input.pin,frozenInputs:{...input.pin.frozenInputs,projectChoices:{build:{model:first.model}}}};
 expect(await loadPinnedTaskStage(deps,{...input,pin,deniedModels:[first.model]})).toMatchObject({kind:"refusal"});
 const key=projectRevisionKey(TEST_ORG,"payments",1),row=h.db.get(key)!;
 h.db.set({...row,registeredAt:"2026-10-29T00:00:00.000Z"});
 await expect(loadPinnedTaskStage(deps,input)).rejects.toThrow();
});

it("does not repin the company policy or project selection on later operations",async()=>{
 const {h,deps,input}=await fixture(),first=await loadPinnedTaskStage(deps,input);
 expect(first.kind).toBe("resolved");if(first.kind!=="resolved")throw Error("fixture needs a model");
 const pin={...input.pin,policy:{...input.pin.policy,stepOverrides:{build:{model:first.model,thinkingLevel:"low",locked:true}}}};
 h.db.set({pk:`ORG#${TEST_ORG}#SETTINGS`,sk:"MODEL_SELECTION_POLICY",version:1,revision:20,rankingVersion:"g3-v1",stepOverrides:{build:{model:{provider:"openai",modelId:"gpt-5"},thinkingLevel:null,locked:true}}});
 expect(await loadPinnedTaskStage(deps,{...input,pin})).toMatchObject({kind:"resolved",model:first.model,thinkingLevel:"low",reason:"COMPANY_LOCK"});
});

it("retains provider routes separately when project and builtin models have the same canonical name",async()=>{
 const {deps,input}=await fixture();
 const model={provider:"anthropic",modelId:"claude-sonnet-4-6"},sourceId="src_aaaaaaaaaaaaaaaaaaaa";
 const pin={...input.pin,frozenInputs:{...input.pin.frozenInputs,projectModels:{default:model,approved:[model]}}};
 const routing={sources:{read:async()=>({sources:[{sourceId,kind:"anthropic" as const,label:"Fixture source",models:[{catalog:model}]}],order:[sourceId,"rovara"],credentials:[sourceId],removing:[],revision:1})},launch:{kinds:["anthropic" as const]}};
 expect(await loadPinnedTaskStage({...deps,routing},{...input,pin})).toMatchObject({kind:"resolved",model,sourceId});
});

it("returns commit fences so a guardrail change cannot race fallback authorization",async()=>{
 const {h,deps,input}=await fixture(),context=await loadPinnedTaskStageContext(deps,input);
 expect(context.decision.kind).toBe("resolved");expect(context.sourcesRevision).toBe(0);expect(context.guardrailsRevision).toBe(0);
 expect(context.checks.length).toBeGreaterThanOrEqual(5);
 const {agentGuardrailsKey,DEFAULT_AGENT_GUARDRAILS}=await import("../../packages/contracts/src/index.js");
 h.db.set({...agentGuardrailsKey(TEST_ORG),revision:1,guardrails:DEFAULT_AGENT_GUARDRAILS});
 await expect(h.db.send(new TransactWriteCommand({TransactItems:[...context.checks,{Put:{TableName:"state",Item:{pk:"C53_AUTH_TEST",sk:"META"}}}]}))).rejects.toThrow();
 expect(h.db.get("C53_AUTH_TEST","META")).toBeUndefined();
});

for(const change of ["sources","registration"] as const)it(`refuses a ${change} change after the authorization snapshot`,async()=>{
 const {h,deps,input}=await fixture(),context=await loadPinnedTaskStageContext(deps,input);
 const {modelSourcesKey}=await import("../../packages/contracts/src/index.js");
 if(change==="sources")h.db.set({...modelSourcesKey(TEST_ORG),revision:1,sources:[],order:["rovara"],credentials:[],removing:[]});
 else {const key=projectRevisionKey(TEST_ORG,"payments",1),row=h.db.get(key)!;h.db.set({...row,registeredAt:"2026-10-29T00:00:00.000Z"});}
 await expect(h.db.send(new TransactWriteCommand({TransactItems:[...context.checks,{Put:{TableName:"state",Item:{pk:"C53_AUTH_TEST",sk:"META"}}}]}))).rejects.toThrow();expect(h.db.get("C53_AUTH_TEST","META")).toBeUndefined();
});
