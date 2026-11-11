import { resolveAgent } from "../../packages/broker/src/agents/store.js";
import type { AwsBrokerInput } from "../../packages/broker/src/aws/broker.js";
import { getModels } from "../../packages/broker/src/agents/models-route.js";
import { ModelSourceSchema, DEFAULT_AGENT_GUARDRAILS, agentGuardrailsKey, canonicalModelName, modelNotEnabledSentence } from "@rovara-code/contracts";
import { bedrockClaudeModelIds } from "@agentx/model-runtime/catalog";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createDeveloperTaskBroker, MAYA, OMAR } from "../support/developer-task-broker.js";
import { FakeProjectMembers } from "../support/fake-project-members.js";
import { AgentWriteResponseReaderSchema } from "@agentx/cloud-contracts/web";
it("dispatches the member model picker route outside the agent pattern and includes actual sources", async () => {
 const h = await createDeveloperTaskBroker({register:false,brokerExtra:{agents:{projectMembers:new FakeProjectMembers()}}});const result = await h.dev(MAYA,"GET","/v1/app/models");expect(result.status).toBe(200);expect(result.body.models).toEqual(expect.arrayContaining([expect.objectContaining({provider:"amazon-bedrock",company:"anthropic",sources:["rovara"]})]));
});
it("returns all structural draft problems in path order with no cross-member draft leak", async () => {
 const h=await createDeveloperTaskBroker({register:false,brokerExtra:{agents:{projectMembers:new FakeProjectMembers()}}});const created=await h.dev(MAYA,"POST","/v1/app/agents",{requestId:randomUUID(),name:"Repair me",overlay:{sequence:[{id:"one",name:"One",kind:"agent",workspace:"none"},{id:"one",name:"Duplicate",kind:"agent",workspace:"none"}],steps:{missing:{instructions:"Nowhere"}}}});expect(created.status).toBe(201);const id=AgentWriteResponseReaderSchema.parse(created.body).agent.agentId;
 const read=await h.dev(MAYA,"GET","/v1/app/agents/"+id+"/draft");expect(read.status).toBe(200);expect(read.body.problems).toEqual(expect.arrayContaining([expect.objectContaining({path:"steps.missing"}),expect.objectContaining({path:"steps.1.id"})]));const problems=read.body.problems as Array<{path:string}>;expect(problems.map(p=>p.path)).toEqual(problems.map(p=>p.path).sort());expect((await h.dev(OMAR,"GET","/v1/app/agents/"+id+"/draft")).status).toBe(404);const {createAgentRouteDependencies}=await import("../../packages/broker/src/aws/broker.js");const deps=createAgentRouteDependencies(h.brokerInput as unknown as AwsBrokerInput)!;const normal=resolveAgent(deps.store,(await h.orgOf(MAYA)).orgId,id,"draft");await expect(normal).rejects.toHaveProperty("code","CONFIG_INVALID");await expect(normal).rejects.toHaveProperty("problems.0.path","steps.missing");
});

it("excludes company-forbidden models and refuses an inaccessible project before returning models",async()=>{
 const h=await createDeveloperTaskBroker({register:false,brokerExtra:{agents:{projectMembers:new FakeProjectMembers()}}});await h.dev(MAYA,"GET","/v1/app/models");const org=await h.orgOf(MAYA);const listed=await h.dev(MAYA,"GET","/v1/app/models");const first=(listed.body.models as Array<{provider:string;modelId:string}>)[0]!;h.db.set({...agentGuardrailsKey(org.orgId),revision:1,guardrails:{...DEFAULT_AGENT_GUARDRAILS,forbiddenModels:[{provider:first.provider,modelId:first.modelId}]}});const filtered=await h.dev(MAYA,"GET","/v1/app/models");expect(filtered.status).toBe(200);expect(filtered.body.models).not.toEqual(expect.arrayContaining([expect.objectContaining({provider:first.provider,modelId:first.modelId})]));expect((await h.dev(MAYA,"GET","/v1/app/models?project=hidden")).status).toBe(404);
});
it("uses verified source routes and respects a project's source subset",async()=>{
 const members=new FakeProjectMembers(),h=await createDeveloperTaskBroker({register:false,brokerExtra:{agents:{projectMembers:members}}});await h.dev(MAYA,"GET","/v1/app/models");const {orgId}=await h.orgOf(MAYA);members.grant(orgId,"payments",MAYA.developerId,"contributor");const {createAgentRouteDependencies}=await import("../../packages/broker/src/aws/broker.js");const deps=createAgentRouteDependencies(h.brokerInput as unknown as AwsBrokerInput)!;const sourceId="src_bbbbbbbbbbbbbbbbbbbb",model={provider:"amazon-bedrock",modelId:"us.anthropic.claude-sonnet-4-6"};const source=ModelSourceSchema.parse({kind:"bedrock",sourceId,label:"Company",roleArn:"arn:aws:iam::123456789012:role/test-models",region:"us-west-2",externalId:"rovara-"+orgId,models:[{catalog:model}],tested:true});deps.modelRouting={sources:{read:async()=>({sources:[source],order:[sourceId,"rovara"],credentials:[],removing:[],revision:1})},launch:{kinds:["bedrock"]},projectSourceOrder:async(_org,project)=>project==="payments"?[sourceId]:["rovara"]};
 const caller={orgId,developerId:MAYA.developerId,orgRole:"member" as const},global=await getModels(deps,caller,new URL("https://cell.example/v1/app/models")),project=await getModels(deps,caller,new URL("https://cell.example/v1/app/models?project=payments"));expect(global.models.find(entry=>entry.modelId===model.modelId)?.sources).toEqual([sourceId,"rovara"]);expect(project.models.find(entry=>entry.modelId===model.modelId)?.sources).toEqual([sourceId]);expect(project.models.every(entry=>entry.sources.every(source=>source===sourceId))).toBe(true);
});

it("lists a Rovara catalog model the account cannot call as disabled, with the broker's words for the edition, and never marks every model",async()=>{
 const members=new FakeProjectMembers(),h=await createDeveloperTaskBroker({register:false,brokerExtra:{agents:{projectMembers:members}}});await h.dev(MAYA,"GET","/v1/app/models");const {orgId}=await h.orgOf(MAYA);
 const {createAgentRouteDependencies}=await import("../../packages/broker/src/aws/broker.js");const deps=createAgentRouteDependencies(h.brokerInput as unknown as AwsBrokerInput)!;
 const catalog=bedrockClaudeModelIds("us").map(modelId=>({provider:"amazon-bedrock",modelId})),refused=catalog[0]!;
 const caller={orgId,developerId:MAYA.developerId,orgRole:"member" as const},read=async()=>(await getModels(deps,caller,new URL("https://cell.example/v1/app/models"))).models;
 let unusable=new Set([canonicalModelName(refused)]);
 deps.modelRouting={usableModels:{unusable:async()=>unusable,markUnusable:async()=>undefined}};
 const marked=await read(),found=marked.find(entry=>entry.modelId===refused.modelId);
 // Listed (the plain servable list leaves it out), disabled with the sentence, and no other model is marked.
 expect(found?.unusableReason).toBe(modelNotEnabledSentence(undefined,undefined));
 expect(marked.filter(entry=>entry.unusableReason!==undefined).map(entry=>entry.modelId)).toEqual([refused.modelId]);
 expect(marked).toHaveLength(catalog.length);
 // Every model unusable: nothing is marked (the picker is never empty of choices).
 unusable=new Set(catalog.map(canonicalModelName));
 expect((await read()).filter(entry=>entry.unusableReason!==undefined)).toEqual([]);
});

it("LP-11: the model picker never lists an OpenRouter ':batch' variant (the Batch API's id, answered within a day), and keeps the ordinary model beside it",async()=>{
 const members=new FakeProjectMembers(),h=await createDeveloperTaskBroker({register:false,brokerExtra:{agents:{projectMembers:members}}});await h.dev(MAYA,"GET","/v1/app/models");const {orgId}=await h.orgOf(MAYA);
 const {createAgentRouteDependencies}=await import("../../packages/broker/src/aws/broker.js");const deps=createAgentRouteDependencies(h.brokerInput as unknown as AwsBrokerInput)!;
 const sourceId="src_cccccccccccccccccccc",plain={provider:"openrouter",modelId:"openai/gpt-4.1-nano"},batch={provider:"openrouter",modelId:"openai/gpt-4.1-nano:batch"};
 const source=ModelSourceSchema.parse({kind:"openrouter",sourceId,label:"OpenRouter",models:[{catalog:batch},{catalog:plain}]});
 deps.modelRouting={sources:{read:async()=>({sources:[source],order:[sourceId],credentials:[],removing:[],revision:1})},launch:{kinds:["openrouter"]}};
 const caller={orgId,developerId:MAYA.developerId,orgRole:"member" as const},listed=(await getModels(deps,caller,new URL("https://cell.example/v1/app/models"))).models.map(entry=>entry.modelId);
 // Positive control: the ordinary model of the same source is listed, so the source was read.
 expect(listed).toContain(plain.modelId);
 expect(listed).not.toContain(batch.modelId);
});
