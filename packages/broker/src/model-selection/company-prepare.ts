// Read-only preparation for the company writer. These conditions authorize no
// mutation by themselves: the writer must commit them with identity, receipt and audit.
import {ModelSelectionPolicyPutSchema,STAGE_EDIT_GROUPS,STAGE_REFERENCE,AgentXError,agentXError,canonicalModelName,canonicalJson,type ModelIdentifier,type StageId} from "@agentx/contracts";
import {readGuardrailsWithRevision} from "../agents/guardrails.js";
import {requireCompanyModelPolicyAuthority} from "./company-read.js";
import {readModelSelectionPolicy,modelSelectionRevisionChecks,type ModelPolicyReader} from "./policy-store.js";
import {readStageModelEvidence,type StageEvidenceDependencies} from "./evidence.js";
import {classifyStageChoiceChange} from "./classify.js";
import type {StageModelCaller} from "./read.js";
export class CompanySameModelPolicyRefusal extends AgentXError {
 readonly reason="DIFFERENT_FROM_UNSATISFIABLE";
 readonly fixHref="/app/admin/how-we-work";
 constructor(){super("MODEL_NOT_ALLOWED","Company reviewer models must differ from the stage they check. Set same-model exceptions per project in How we work.",403);}
}
export async function prepareCompanyModelPolicy(deps:ModelPolicyReader&StageEvidenceDependencies,caller:StageModelCaller,value:unknown){
 const authority=await requireCompanyModelPolicyAuthority(deps,caller);
 const parsed=ModelSelectionPolicyPutSchema.safeParse(value);
 if(!parsed.success)throw agentXError("CONFIG_INVALID","Review a valid company model policy and request id.");
 const body=parsed.data;
 for(const group of STAGE_EDIT_GROUPS){
  const configured=group.map(stage=>body.stepOverrides[stage]).filter(row=>row!==undefined);
  if(configured.some(row=>canonicalJson(row)!==canonicalJson(configured[0])))throw agentXError("CONFIG_INVALID","Shared model stages must use the same company override.");
 }
 const companyModel=(stage:StageId)=>STAGE_EDIT_GROUPS.find(group=>group.some(member=>member===stage))?.map(member=>body.stepOverrides[member]).find(row=>row!==undefined)?.model;
 for(const stage of ["plan_check","code_review","security_review"] as const){
  const checking=companyModel(stage),reference=companyModel(STAGE_REFERENCE[stage]);
  if(checking!==undefined&&reference!==undefined&&canonicalModelName(checking)===canonicalModelName(reference))throw new CompanySameModelPolicyRefusal();
 }
 const current=await readModelSelectionPolicy(deps,caller.orgId);
 if(current.revision!==body.expectedRevision)throw agentXError("CHANGE_STALE","The company model policy changed. Reload and review again.");
 const guardrails=await readGuardrailsWithRevision(deps,caller.orgId);
 const models=new Map<string,ModelIdentifier>();
 for(const row of Object.values(body.stepOverrides))for(const model of [row?.model,row?.fallbackModel])if(model!==undefined)models.set(JSON.stringify([model.provider,model.modelId]),model);
 const evidence=await readStageModelEvidence(deps,{orgId:caller.orgId,project:"",models:[...models.values()],excludePersonalPlan:true});
 const denied=new Set(guardrails.guardrails.forbiddenModels.map(canonicalModelName));
 for(const model of models.values())if(denied.has(canonicalModelName(model))||!evidence.candidates.some(candidate=>candidate.model.provider===model.provider&&candidate.model.modelId===model.modelId))throw agentXError("MODEL_NOT_ALLOWED","A chosen company model is unavailable. Review model sources.");
 const changes=classifyStageChoiceChange({kind:"company",before:current.stepOverrides,after:body.stepOverrides});
 const changed=canonicalJson(current.stepOverrides)!==canonicalJson(body.stepOverrides);
 const next={version:1 as const,revision:current.revision+(changed?1:0),rankingVersion:"g3-v1" as const,stepOverrides:body.stepOverrides};
 return {body,current,next,changed,changes,sourcesRevision:evidence.sourcesRevision,guardrailsRevision:guardrails.revision,conditions:[...authority,...modelSelectionRevisionChecks(deps.tableName,caller.orgId,{companyRevision:current.revision,sourcesRevision:evidence.sourcesRevision,guardrailsRevision:guardrails.revision})]};
}
