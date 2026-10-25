import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { AgentCreateBodySchema, AgentDraftPutBodySchema, AgentDraftResponseReaderSchema, AgentWriteResponseReaderSchema, ModelListReaderSchema, BuilderGuardrailsReaderSchema, BuilderSkillsReaderSchema, AgentIdSchema } from "@agentx/contracts/web";
import { useAppHost,type AppHost } from "../host.js";
import { createApiClient } from "./client.js";
import type { Overlay } from "../screens/builder/draft-state.js";
export function createBuilderApi(host:AppHost){const api=createApiClient(host),path=(id:string)=>"/v1/app/agents/"+encodeURIComponent(AgentIdSchema.parse(id));return{
 create:(body:Omit<ReturnType<typeof AgentCreateBodySchema.parse>,"requestId">,requestId:string)=>api.send("POST","/v1/app/agents",AgentCreateBodySchema.parse({...body,requestId}),AgentWriteResponseReaderSchema),
 draft:(id:string)=>api.get(path(id)+"/draft",AgentDraftResponseReaderSchema),
 save:async(id:string,overlay:Overlay,revision:number)=>{const result=await api.send("PUT",path(id)+"/draft",AgentDraftPutBodySchema.parse({requestId:crypto.randomUUID(),overlay,expectedRevision:revision}),AgentDraftResponseReaderSchema);if(result.kind!=="done")throw new Error("Draft save needs confirmation");return result.value;},
 models:(project?:string)=>api.get("/v1/app/models"+(project?"?"+new URLSearchParams({project}).toString():""),ModelListReaderSchema),
 guardrails:()=>api.get("/v1/app/org/agent-guardrails",BuilderGuardrailsReaderSchema),skills:()=>api.get("/v1/app/skills",BuilderSkillsReaderSchema),
};}
export function useBuilderApi(){const host=useAppHost();return useMemo(()=>createBuilderApi(host),[host]);}
export function useDraft(agentId:string){const api=useBuilderApi();return useQuery({queryKey:["builder-draft",agentId],queryFn:()=>api.draft(agentId)});}
