// Trusted runtime adapter: task intent is frozen, availability and task denials are read live.
import {STAGE_EDIT_GROUPS,STAGE_REFERENCE,agentXError,type OrgId,type AgentId,type StageId,type ResolvedRecipe,type ModelIdentifier} from "@agentx/contracts";
import {parseTaskModelPolicyPin} from "./task-pin.js";
import {pinnedTaskModelApproval} from "./task-proof.js";
import {resolveStageModel,type StageModelInput,type StageModelResult} from "./resolver.js";
export interface PinnedTaskStageInput {
 orgId:OrgId;project:string;registeredAt:string;agentId:AgentId;recipe:ResolvedRecipe;digest:string;pin:unknown;stage:StageId;
 live:Pick<StageModelInput,"sourcesRevision"|"candidates"|"forbidden"|"payerDeveloperId"|"connectionRevision"|"deniedModels"|"requireDifferentVendor">;
 /** Actual models used for preceding operations, read from this task, never a newly resolved reference. */
 priorModels:Partial<Record<StageId,ModelIdentifier>>;
 defaultLastAttempt?:boolean;builtinDefault?:ModelIdentifier;defaultPreferred?:ModelIdentifier;defaultFallbacks?:readonly ModelIdentifier[];
}
const unavailable=()=>agentXError("RUNTIME_UNAVAILABLE","The task's frozen model choices could not be verified.");
export function resolvePinnedTaskStage(input:PinnedTaskStageInput):StageModelResult {
 const pin=parseTaskModelPolicyPin(input.pin,{orgId:input.orgId,project:input.project,agentId:input.agentId,recipe:input.recipe,digest:input.digest});
 if(pin.registeredAt!==input.registeredAt||pin.frozenInputs===undefined)throw unavailable();
 const frozen=pin.frozenInputs;
 const group=STAGE_EDIT_GROUPS.find(group=>group.some(stage=>stage===input.stage));
 if(group===undefined)throw unavailable();
 const configured=group.map(stage=>pin.policy.stepOverrides[stage]).filter(value=>value!==undefined),company=configured[0];
 if(configured.some(value=>JSON.stringify(value)!==JSON.stringify(company)))throw unavailable();
 const own=group.map(stage=>frozen.projectChoices[stage]).filter(value=>value!==undefined),projectChoice=own[0];
 if(own.some(value=>JSON.stringify(value)!==JSON.stringify(projectChoice)))throw unavailable();
 const inherited=frozen.recipeDefaults[input.stage];
 const defaults=inherited===undefined&&company===undefined?undefined:{...inherited,...company};
 if(defaults!==undefined&&frozen.clearedFallbacks.includes(input.stage))delete defaults.fallbackModel;
 const referenceStage=STAGE_REFERENCE[input.stage as keyof typeof STAGE_REFERENCE];
 const referenceModel=referenceStage===undefined?undefined:input.priorModels[referenceStage];
 const exception=pin.approvalProof?.exceptions.find(value=>value.stage===input.stage);
 const sameModelApproval=exception===undefined||referenceModel===undefined?undefined:pinnedTaskModelApproval({...input,model:exception.model,referenceModel});
 return resolveStageModel({orgId:input.orgId,stage:input.stage,...input.live,approved:frozen.projectModels?.approved,companyLock:company?.locked===true?company:undefined,companyDefault:company?.locked===true?undefined:defaults,companyDefaultOrigin:company?.model===undefined&&inherited?.model!==undefined?"recipe":undefined,projectChoice,projectSelection:frozen.projectSelection,projectDefault:frozen.projectModels?.default,builtinDefault:input.builtinDefault,defaultPreferred:input.defaultPreferred,defaultFallbacks:[...(input.defaultFallbacks??[]),...(frozen.projectModels?.default===undefined?[]:[frozen.projectModels.default]),...(input.builtinDefault===undefined?[]:[input.builtinDefault])],referenceModel,sameModelApproval,allowLegacyDefaultFallback:true,defaultLastAttempt:input.defaultLastAttempt});
}
