import { ModelListSchema, agentXError, forbiddenModelMatcher, modelCompany } from "@agentx/contracts";
import { catalogModel } from "@agentx/model-runtime/catalog";
import { servableModels, servingRoutes } from "../model-sources/routing.js";
import { readGuardrails } from "./guardrails.js";
import { roleOnProject } from "./roster.js";
import { orgRoleOf, type AgentCaller } from "./access.js";
import type { AgentRouteDependencies } from "./routes.js";
export async function getModels(deps: AgentRouteDependencies, caller: AgentCaller,url:URL) {
 if(await orgRoleOf(deps,caller.orgId,caller.developerId)===undefined)throw agentXError("NOT_FOUND","Not found.");const project=url.searchParams.get("project")??undefined;
 if(project!==undefined)await roleOnProject(deps,caller,project);
 const routing=deps.modelRouting??{}, models=await(deps.servableModels?.(caller.orgId)??servableModels(routing,caller.orgId)), guardrails=await readGuardrails(deps,caller.orgId),forbidden=forbiddenModelMatcher(guardrails.forbiddenModels);
 const pickerRouting={...routing};if(project===undefined)delete pickerRouting.projectSourceOrder;
 const entries=[];
 for(const model of models) {
  if(forbidden(model))continue;
  const routes=deps.modelRouting===undefined?[{sourceId:"rovara"}]:await servingRoutes(pickerRouting,{orgId:caller.orgId,project:project??"",model});
  if(routes.length===0)continue;
  entries.push({...model,label:catalogModel(model)?.name??model.modelId,company:modelCompany(model),sources:[...new Set(routes.map(route=>route.sourceId))]});
 }
 const parsed=ModelListSchema.safeParse({models:entries});if(!parsed.success)throw agentXError("CONFIG_INVALID","The available models couldn't be read.");return parsed.data;
}
