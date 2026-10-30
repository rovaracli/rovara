import {STAGE_IDS,STAGE_EDIT_RULES,STAGE_REFERENCE,ModelIdentifierSchema,StageModelChoiceSchema,agentXError,type ProjectModels,type ModelIdentifier,type ModelSelection,type StageModelChoice,type StageId,type ResolvedRecipe,type RecipeOverlay} from "@agentx/contracts";
const unavailable=()=>agentXError("RUNTIME_UNAVAILABLE","The model settings could not be read. Reload and try again.");
export function stageChoiceOf(raw:unknown,stage:StageId,recipe:ResolvedRecipe):StageModelChoice|undefined {
 if(typeof raw!=="object" || raw===null) return undefined;
 const fields=raw as Record<string,unknown>;
 const primary=ModelIdentifierSchema.safeParse(fields.model===undefined||fields.model===null?undefined:{provider:(fields.model as Record<string,unknown>).provider,modelId:(fields.model as Record<string,unknown>).modelId});
 const fallback=ModelIdentifierSchema.safeParse(fields.fallbackModel===undefined||fields.fallbackModel===null?undefined:{provider:(fields.fallbackModel as Record<string,unknown>).provider,modelId:(fields.fallbackModel as Record<string,unknown>).modelId});
 if(fields.model!==undefined&&fields.model!==null&&!primary.success||fields.fallbackModel!==undefined&&fields.fallbackModel!==null&&!fallback.success)throw unavailable();
 let differentFrom:StageModelChoice["differentFrom"];
 if(fields.differentCompanyFrom===null) {
  const reference=STAGE_REFERENCE[stage as keyof typeof STAGE_REFERENCE];
  if(reference!==undefined) differentFrom={stage:reference,level:"model"};
 }
 if(typeof fields.differentCompanyFrom==="string") {
  const reference=STAGE_REFERENCE[stage as keyof typeof STAGE_REFERENCE];
  const target=recipe.steps.find(step=>step.id===fields.differentCompanyFrom);
  if(reference===undefined || target?.kind!==STAGE_EDIT_RULES[reference].stepKind) throw unavailable();
  differentFrom={stage:reference,level:"vendor"};
 }
 if(!primary.success && !fallback.success && fields.thinkingLevel===undefined && differentFrom===undefined) return undefined;
 const parsed=StageModelChoiceSchema.safeParse({...(primary.success?{model:primary.data}:{}),...(fallback.success?{fallbackModel:fallback.data}:{}),...(fields.thinkingLevel===undefined?{}:{thinkingLevel:fields.thinkingLevel}),...(differentFrom===undefined?{}:{differentFrom})});
 if(!parsed.success) throw unavailable();return parsed.data;
}
export function frozenRecipeModelInputs(recipe:ResolvedRecipe,overlay?:RecipeOverlay) {
 const projectChoices:Partial<Record<StageId,StageModelChoice>>={},recipeDefaults:Partial<Record<StageId,StageModelChoice>>={},clearedFallbacks:StageId[]=[];
 for(const stage of STAGE_IDS) {
  const step=recipe.steps.find(step=>step.kind===STAGE_EDIT_RULES[stage].stepKind);
  if(step===undefined)continue;
  const raw=overlay?.steps?.[step.id],own=stageChoiceOf(raw,stage,recipe),inherited=stageChoiceOf(step.settings,stage,recipe);
  if(own!==undefined)projectChoices[stage]=own;
  if(inherited!==undefined)recipeDefaults[stage]=inherited;
  if(raw?.fallbackModel===null)clearedFallbacks.push(stage);
 }
 return {projectChoices,recipeDefaults,clearedFallbacks};
}

/** Effort is taken from the project's approved entry, never from an untrusted selection row. */
export function approvedProjectModel(model:ModelIdentifier|undefined,models:ProjectModels|undefined):ModelSelection|undefined {
 if(model===undefined)return undefined;
 const approved=models?.approved.find(entry=>entry.provider===model.provider&&entry.modelId===model.modelId);
 return {provider:model.provider,modelId:model.modelId,...(approved?.thinkingLevel===undefined?{}:{thinkingLevel:approved.thinkingLevel})};
}
