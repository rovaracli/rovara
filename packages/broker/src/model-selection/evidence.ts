import {inactiveModelSourcesRevision,type ModelPolicyReader} from "./policy-store.js";
// v1.1 source-level evidence only: no probes, secrets or new evidence State rows.
import { createHash } from "node:crypto";
import { agentXError, canonicalModelName, canonicalJson, modelCompany, sourceKindProblem, type ModelIdentifier, type OrgId } from "@agentx/contracts";
import { bedrockClaudeModelIds, catalogModel } from "@agentx/model-runtime/catalog";
import { effectiveSources, endpointUsable, type RoutingDependencies } from "../model-sources/routing.js";
import type { ChatGptConnections } from "../chatgpt/connections.js";
import { chatGptConnectionUsable } from "../chatgpt/task-model.js";
import type { VerifiedStageCandidate } from "./resolver.js";
export interface StageEvidenceDependencies {
 routing:RoutingDependencies;
 chatgpt?:Pick<ChatGptConnections,"settings"|"view">|undefined;
 now():number;
}
export async function readStageModelEvidence(deps:StageEvidenceDependencies&Partial<ModelPolicyReader>,input:{orgId:OrgId;project:string;models:readonly ModelIdentifier[];payerDeveloperId?:string|undefined;excludePersonalPlan?:boolean|undefined}) {
 if(input.models.length>23) throw agentXError("RUNTIME_UNAVAILABLE","The model scope exceeds this request's limit.");
 let sources:Awaited<ReturnType<typeof effectiveSources>>;
 try {sources=await effectiveSources(deps.routing,input.orgId,input.project);} catch {throw agentXError("RUNTIME_UNAVAILABLE","The model sources could not be read.");}
 const sourcesRevision=sources?.stored.revision??await inactiveModelSourcesRevision(deps,input.orgId);
 // Runtime failure context only; never persists or changes company source configuration.
 const order=(sources?.order??["personal-chatgpt","rovara"]).filter(sourceId=>!input.excludePersonalPlan||sourceId!=="personal-chatgpt");
 const rovara=new Set(bedrockClaudeModelIds(deps.routing.rovaraGeography??"us"));
 let connectionRevision:string|undefined;
 let chatgptModels:readonly string[]=[];
 if(order.includes("personal-chatgpt") && input.payerDeveloperId!==undefined && deps.chatgpt!==undefined) {
  try {
   const settings=await deps.chatgpt.settings();
   if(settings.enabled) {
    const view=await deps.chatgpt.view(input.payerDeveloperId);
    if(chatGptConnectionUsable(view,deps.now()) && view.connectedAt!==undefined) {
     chatgptModels=view.models??[];
     // A non-secret record binding. Nothing derived from credential values or suffixes.
     connectionRevision=createHash("sha256").update(canonicalJson({connectedAt:view.connectedAt,status:view.status??null,statusAt:view.statusAt??null,models:chatgptModels})).digest("hex");
    }
   }
  } catch {throw agentXError("RUNTIME_UNAVAILABLE","The model connection could not be read.");}
 }
 const candidates:VerifiedStageCandidate[]=[];
 for(const model of input.models) {
  if(catalogModel(model)===undefined) continue;
  for(const sourceId of order) {
   if(sourceId==="rovara" && model.provider==="amazon-bedrock" && rovara.has(model.modelId)) {
    candidates.push({model,sourceId,enabled:true,inEffectiveOrder:true,evidence:{orgId:input.orgId,sourcesRevision,kind:"rovara_catalog"}});break;
   }
   if(sourceId==="personal-chatgpt" && modelCompany(model)==="openai" && connectionRevision!==undefined && chatgptModels.some(modelId=>canonicalModelName({provider:"openai",modelId})===canonicalModelName(model))) {
    candidates.push({model,sourceId,enabled:true,inEffectiveOrder:true,evidence:{orgId:input.orgId,sourcesRevision,kind:"chatgpt_connection",payerDeveloperId:input.payerDeveloperId!,connectionRevision}});break;
   }
   const source=sources?.stored.sources.find(source=>source.sourceId===sourceId);
   if(source===undefined || sources?.stored.removing.some(removed=>removed.sourceId===sourceId)===true || sourceKindProblem(source.kind,source.kind==="endpoint"?source.api:undefined,deps.routing.launch)!==undefined) continue;
   if(!source.models.some(entry=>canonicalModelName(entry.catalog)===canonicalModelName(model))) continue;
   // N8: a company's own model endpoint counts only while it is usable NOW (the edition has the feature, a check passed for its exact settings, and its host is
   // approved in its own egress item). It proves source-level access like the other kinds; it is never a funding exemption (task-stop-funding.ts).
   if(source.kind==="endpoint") {
    if(!(await endpointUsable(deps.routing,input.orgId,source))) continue;
    candidates.push({model,sourceId,enabled:true,inEffectiveOrder:true,evidence:{orgId:input.orgId,sourcesRevision,kind:"qualified_endpoint"}});break;
   }
   if(source.kind==="bedrock" ? !source.tested : !sources?.stored.credentials.includes(sourceId)) continue;
   candidates.push({model,sourceId,enabled:true,inEffectiveOrder:true,evidence:{orgId:input.orgId,sourcesRevision,kind:source.kind==="bedrock"?"tested_bedrock_role":"stored_key"}});break;
  }
 }
 return {sourcesRevision,candidates,...(connectionRevision===undefined?{}:{connectionRevision,payerDeveloperId:input.payerDeveloperId})};
}
