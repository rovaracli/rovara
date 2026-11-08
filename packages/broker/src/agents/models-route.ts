import { ModelListSchema, agentXError, canonicalModelName, editionFromEnvironment, forbiddenModelMatcher, modelCompany, modelNotEnabledSentence } from "@agentx/contracts";
import { bedrockClaudeModelIds, catalogModel } from "@agentx/model-runtime/catalog";
import { isBatchVariant } from "../model-sources/model-variants.js";
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
 // Owner decision 2026-11-03: a Rovara catalog model this account is known not to be able to call is listed, but marked, so the picker shows it disabled with the reason. Unreadable marks nothing.
 const cannotUse:ReadonlySet<string>=await routing.usableModels?.unusable().catch(()=>new Set<string>())??new Set<string>();
 // `servableModels` leaves those models out (no default choice offers them), so they are put back here, after the rest, to be shown disabled.
 const listed=new Set(models.map(canonicalModelName));
 const left=cannotUse.size===0?[]:bedrockClaudeModelIds(routing.rovaraGeography??"us").map(modelId=>({provider:"amazon-bedrock",modelId})).filter(model=>cannotUse.has(canonicalModelName(model))&&!listed.has(canonicalModelName(model)));
 const entries=[];
 for(const model of [...models,...left]) {
  // LP-11: an OpenRouter `:batch` variant is the Batch API's id (answered within a day), not one for chat; it is never offered.
 if(isBatchVariant(model)||forbidden(model))continue;
  const routes=deps.modelRouting===undefined?[{sourceId:"rovara"}]:await servingRoutes(pickerRouting,{orgId:caller.orgId,project:project??"",model});
  if(routes.length===0)continue;
  const sources=[...new Set(routes.map(route=>route.sourceId))];
  // Only when Rovara's own catalog is the model's one way in: another source (a key, a role) may serve it.
  const unusable=sources.every(sourceId=>sourceId==="rovara")&&cannotUse.has(canonicalModelName(model));
  entries.push({...model,label:catalogModel(model)?.name??model.modelId,company:modelCompany(model),sources,...(unusable?{unusableReason:modelNotEnabledSentence(undefined,editionFromEnvironment())}:{})});
 }
 // Never every model disabled (as `withoutUnusable` never empties a list): if nothing else is left to choose, nothing is marked.
 if(entries.every(entry=>"unusableReason" in entry))for(const entry of entries)delete (entry as {unusableReason?:string}).unusableReason;
 const parsed=ModelListSchema.safeParse({models:entries});if(!parsed.success)throw agentXError("CONFIG_INVALID","The available models couldn't be read.");return parsed.data;
}
