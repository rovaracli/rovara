import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { AgentPublishBodySchema, AgentRollbackBodySchema, AgentBudgetBodySchema, AgentRunBodySchema, AgentPublishResponseReaderSchema, BuilderTestingBudgetReaderSchema, TaskResponseReaderSchema, AgentCreateBodySchema, AgentDraftPutBodySchema, AgentDraftResponseReaderSchema, AgentWriteResponseReaderSchema, ModelListReaderSchema, BuilderGuardrailsReaderSchema, BuilderSkillsReaderSchema, AgentIdSchema } from "@agentx/cloud-contracts/web";
import { useAppHost,type AppHost } from "../host.js";
import { createApiClient } from "./client.js";
import type { Overlay } from "../screens/builder/draft-state.js";
export function createBuilderApi(host:AppHost){const api=createApiClient(host),path=(id:string)=>"/v1/app/agents/"+encodeURIComponent(AgentIdSchema.parse(id));return{
 publish:(id:string,expectedRevision:number,note:string|undefined,requestId:string)=>api.send("POST",path(id)+"/publish",AgentPublishBodySchema.parse({requestId,expectedRevision,...(note?.trim()?{note:note.trim()}:{})}),AgentPublishResponseReaderSchema),
 rollback:(id:string,version:number,requestId:string)=>api.send("POST",path(id)+"/rollback",AgentRollbackBodySchema.parse({requestId,version}),AgentWriteResponseReaderSchema),
 budget:(id:string,monthlyUsd:number|null,maxPerRunUsd:number|null,requestId:string)=>api.send("PUT",path(id)+"/budget",AgentBudgetBodySchema.parse({requestId,monthlyUsd,maxPerRunUsd}),AgentWriteResponseReaderSchema),
 testing:()=>api.get("/v1/app/budget",BuilderTestingBudgetReaderSchema),
 test:(id:string,project:string,text:string,requestId:string)=>api.send("POST",path(id)+"/runs",AgentRunBodySchema.parse({requestId,project,version:"draft",input:{text}}),TaskResponseReaderSchema),
 create:(body:Omit<ReturnType<typeof AgentCreateBodySchema.parse>,"requestId">,requestId:string)=>api.send("POST","/v1/app/agents",AgentCreateBodySchema.parse({...body,requestId}),AgentWriteResponseReaderSchema),
 draft:(id:string)=>api.get(path(id)+"/draft",AgentDraftResponseReaderSchema),
 save:async(id:string,overlay:Overlay,revision:number)=>{const result=await api.send("PUT",path(id)+"/draft",AgentDraftPutBodySchema.parse({requestId:crypto.randomUUID(),overlay,expectedRevision:revision}),AgentDraftResponseReaderSchema);if(result.kind!=="done")throw new Error("Draft save needs confirmation");return result.value;},
 models:(project?:string)=>api.get("/v1/app/models"+(project?"?"+new URLSearchParams({project}).toString():""),ModelListReaderSchema),
 guardrails:()=>api.get("/v1/app/org/agent-guardrails",BuilderGuardrailsReaderSchema),skills:()=>api.get("/v1/app/skills",BuilderSkillsReaderSchema),
};}
export function useBuilderApi(){const host=useAppHost();return useMemo(()=>createBuilderApi(host),[host]);}
export function useDraft(agentId:string){const api=useBuilderApi();return useQuery({queryKey:["builder-draft",agentId],queryFn:()=>api.draft(agentId)});}
