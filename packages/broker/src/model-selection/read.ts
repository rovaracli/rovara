import {ProcessModelRefusal} from "./process-refusal.js";
import {createHash} from "node:crypto";
import {classifyStageChoiceChange} from "./classify.js";
// Shared broker facade for stage-model reads and project draft/publish validation. No provider calls or writes.
import { z } from "zod";
import { AgentXError, agentXError, ApprovalIdSchema, canonicalJson, ModelIdentifierSchema, canonicalModelName, StageIdSchema, StageModelChoiceSchema, StageModelsQuerySchema, StageModelsResponseSchema, STAGE_IDS, STAGE_EDIT_GROUPS, type ModelIdentifier, type ResolvedRecipe, type DefaultProcess, type StageId, type StageModelChoice, type StageModelsResponse } from "@agentx/contracts";
import { resolveStageModel, stageCandidateVerified, type StageModelInput, type StageModelResult } from "./resolver.js";
export interface StageModelCaller { orgId: string; developerId: string }
export interface StageModelSnapshot {
  orgId: string; project: string; companyRevision: number; projectRevision: number;
  process: { agentId: string; version?: number; draftRevision?: number; digest: string };
  registeredAt?: string;
  guardrailsRevision?: number;
  processChain?: ResolvedRecipe["chain"];
  playbookSnapshot?: {exists:boolean;revision:number;defaultProcess:DefaultProcess};
  selectionSnapshot?: {exists:false}|{exists:true;model:ModelIdentifier};
  canEdit: boolean;
  stages: StageModelInput[];
}
export interface StageModelsReadDependencies {
  /** Server-only lookup of the exact approved record and its immutable tuple binding. */
  verifySameModelApproval?(context:{approvalId:string;tupleDigest:string},snapshot:StageModelSnapshot):Promise<boolean>;
  now(): number;
  projectFor(caller: StageModelCaller, rawProject: string): Promise<{name:string;canEdit:boolean}>;
  /** Server adapter: current policy, recipe, actual account/source evidence, bounded before work begins. */
  snapshot(caller: StageModelCaller, project: string, draft?: number): Promise<StageModelSnapshot>;
}
const Choices = z.partialRecord(StageIdSchema, StageModelChoiceSchema);
const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "The model settings could not be read. Reload and try again.");
type Decision = StageModelResult & {stage:StageId;fixHref?:string};
const refusalFixHref=(code:string)=>["MODEL_NOT_VERIFIED","MODEL_STALE","NO_VERIFIED_CANDIDATE"].includes(code)?"/app/admin/models/sources":"/app/admin/how-we-work";
function conflictsWithLock(choice:StageModelChoice|undefined,lock:StageModelChoice|undefined):boolean {
 if(choice===undefined||lock===undefined)return false;
 return Object.entries(choice).some(([key,value])=>{
  const held=lock[key as keyof StageModelChoice];
  if((key==="model"||key==="fallbackModel")&&value!==undefined&&held!==undefined)return canonicalModelName(value as ModelIdentifier)!==canonicalModelName(held as ModelIdentifier);
  return JSON.stringify(value)!==JSON.stringify(held);
 });
}
async function load(deps:StageModelsReadDependencies,caller:StageModelCaller,rawProject:string,rawQuery:unknown) {
 const query=StageModelsQuerySchema.safeParse(rawQuery);
 if(!query.success) throw agentXError("CONFIG_INVALID","The stage-model query is invalid.");
 const project=await deps.projectFor(caller,rawProject);
 if(query.data.draft!==undefined && !project.canEdit) throw agentXError("FORBIDDEN","Only a project maintainer can read model-choice drafts.");
 let snapshot:StageModelSnapshot;
 try {snapshot=await deps.snapshot(caller,project.name,query.data.draft);} catch (error) {if(error instanceof ProcessModelRefusal)throw error;if(error instanceof AgentXError && (error.code==="DRAFT_STALE" || error.code==="POLICY_STALE"))throw error;throw unavailable();}
 if(snapshot.orgId!==caller.orgId || snapshot.project!==project.name || snapshot.stages.length!==7 || new Set(snapshot.stages.map(row=>row.stage)).size!==7) throw unavailable();
 if(query.data.draft!==undefined && snapshot.process.draftRevision!==query.data.draft) throw agentXError("DRAFT_STALE","This process draft changed. Reload and try again.");
 for(const row of snapshot.stages) if(!STAGE_IDS.includes(row.stage) || row.orgId!==caller.orgId || row.candidates.length>23) throw unavailable();
 return {snapshot,canEdit:project.canEdit};
}
function decide(snapshot:StageModelSnapshot,choices:Partial<Record<StageId,StageModelChoice>>,validateLocks=false,proposeExceptions=false):{stages:Decision[];inputs:Map<StageId,StageModelInput>;exceptions:Array<{stage:"plan_check"|"code_review"|"security_review";model:ModelIdentifier;referenceModel:ModelIdentifier}>} {
 const inputs=new Map<StageId,StageModelInput>();
 // Publication validation cannot borrow the runtime-only implicit same-model compatibility fallback.
 for(const row of snapshot.stages) inputs.set(row.stage,{...row,...(proposeExceptions?{allowLegacyDefaultFallback:false}:{}),...(choices[row.stage]===undefined?{}:{projectChoice:choices[row.stage]})});
 const decisions=new Map<StageId,Decision>();
 const exceptions:Array<{stage:"plan_check"|"code_review"|"security_review";model:ModelIdentifier;referenceModel:ModelIdentifier}>=[];
 // Preview references come from this exact input snapshot; dispatch supplies actual pinned references separately.
 for(const stage of ["plan","build","understand","plan_check","code_review","security_review","pull_request"] as const) {
  const input=inputs.get(stage)!;
  if(stage==="plan_check" || stage==="code_review" || stage==="security_review") {
   const reference=decisions.get(stage==="plan_check"?"plan":"build");
   input.referenceModel=reference?.kind==="resolved"?reference.model:undefined;
  }
  let result:StageModelResult=validateLocks&&conflictsWithLock(input.projectChoice,input.companyLock)?{kind:"refusal",code:"STAGE_LOCKED"}:resolveStageModel(input);
  if(proposeExceptions&&(stage==="plan_check"||stage==="code_review"||stage==="security_review")&&input.companyLock===undefined&&input.projectChoice?.model!==undefined&&input.referenceModel!==undefined&&canonicalModelName(input.projectChoice.model)===canonicalModelName(input.referenceModel)&&input.requireDifferentVendor!==true&&input.projectChoice.differentFrom?.level!=="vendor"&&input.companyDefault?.differentFrom?.level!=="vendor") {
   const candidate=resolveStageModel({...input,sameModelApproval:{model:input.projectChoice.model,referenceModel:input.referenceModel}});
   if(candidate.kind==="resolved"&&canonicalModelName(candidate.model)===canonicalModelName(input.referenceModel)) {result=candidate;exceptions.push({stage,model:candidate.model,referenceModel:input.referenceModel});}
  }
  decisions.set(stage,{stage,...result,...(result.kind==="refusal"?{fixHref:refusalFixHref(result.code)}:{})});
 }
 return {stages:STAGE_IDS.map(stage=>decisions.get(stage)!),inputs,exceptions};
}
export async function validateStageChoices(deps:StageModelsReadDependencies,caller:StageModelCaller,project:string,rawChoices:unknown,query:unknown={},approvalContext?:{approvalId:string;tupleDigest:string}) {
 const choices=Choices.safeParse(rawChoices);
 if(!choices.success) throw agentXError("CONFIG_INVALID","The stage choices are invalid.");
 // Operation groups share a single editable setting; forged split choices are refused.
 const normalized={...choices.data};
 for(const group of STAGE_EDIT_GROUPS) {
  const supplied=group.map(stage=>choices.data[stage]).filter((choice):choice is StageModelChoice=>choice!==undefined);
  const shared=supplied[0];
  if(shared===undefined) continue;
  if(supplied.some(choice=>JSON.stringify(choice)!==JSON.stringify(shared))) throw agentXError("CONFIG_INVALID","These stages share one model choice.");
  for(const stage of group) normalized[stage]=shared;
 }
 const {snapshot}=await load(deps,caller,project,query);
 const {stages,inputs,exceptions}=decide(snapshot,normalized,true,true);
 // Server-only confirmation context: callers supply it only after live approval authority checks.
 // Bind every effective tuple and reference plus identity, recipe and policy/source revisions.
 const approvalTupleDigest=createHash("sha256").update(canonicalJson({orgId:caller.orgId,project:snapshot.project,registeredAt:snapshot.registeredAt??null,process:snapshot.process,companyRevision:snapshot.companyRevision,projectRevision:snapshot.projectRevision,guardrailsRevision:snapshot.guardrailsRevision??null,stages:STAGE_IDS.map(stage=>{const input=inputs.get(stage)!;return {stage,sourcesRevision:input.sourcesRevision,choice:input.projectChoice??null,lock:input.companyLock??null,companyDefault:input.companyDefault??null,decision:stages.find(row=>row.stage===stage)};})})).digest("hex");
 const approved=approvalContext!==undefined&&ApprovalIdSchema.safeParse(approvalContext.approvalId).success&&approvalContext.tupleDigest===approvalTupleDigest&&await (deps.verifySameModelApproval?.(approvalContext,snapshot)??Promise.resolve(false));
 const resolved=stages.every(stage=>stage.kind==="resolved");
 const requiresConfirmation=resolved&&exceptions.length>0&&!approved&&approvalContext===undefined;
 const ok=resolved&&(exceptions.length===0||approved);
 const lessSafeReasons=exceptions.map(row=>`Makes ${row.stage} use the same model as ${row.stage==="plan_check"?"plan":"build"}`);
 return {ok,status:ok?200:requiresConfirmation?202:409,requiresConfirmation,lessSafeReasons,approvalTupleDigest,sameModelExceptions:exceptions,stages,inputRevisions:{companyRevision:snapshot.companyRevision,projectRevision:snapshot.projectRevision,processDigest:snapshot.process.digest}};
}
/** Project-wide Slack/CLI choice is a lower-precedence input, never a forged per-stage override. */
export async function validateProjectModelSelection(deps:StageModelsReadDependencies,caller:StageModelCaller,project:string,rawModel:unknown){
 const editable=await deps.projectFor(caller,project);
 if(!editable.canEdit)throw agentXError("FORBIDDEN","Only a project maintainer can change model choices.");
 const model=ModelIdentifierSchema.parse(rawModel),{snapshot}=await load({...deps,projectFor:async()=>editable},caller,editable.name,{});
 const selected={...snapshot,stages:snapshot.stages.map(row=>({...row,projectSelection:model}))};
 const verified=selected.stages.every(row=>row.candidates.some(candidate=>candidate.model.provider===model.provider&&candidate.model.modelId===model.modelId&&stageCandidateVerified(row,candidate))&&(row.approved===undefined||row.approved.some(allowed=>canonicalModelName(allowed)===canonicalModelName(model)))&&!row.forbidden.some(blocked=>canonicalModelName(blocked)===canonicalModelName(model)));
 const {stages}=decide(selected,{});
 const effective=(rows:Decision[])=>Object.fromEntries(rows.flatMap(row=>row.kind==="resolved"?[[row.stage,row.model]]:[])) as Partial<Record<StageId,ModelIdentifier>>;
 const lessSafeReasons=classifyStageChoiceChange({kind:"selection",before:effective(decide(snapshot,{}).stages),after:effective(stages)});
 const revisions=new Set(snapshot.stages.map(row=>row.sourcesRevision));
 const writeContext={chain:snapshot.processChain,playbook:snapshot.playbookSnapshot,selection:snapshot.selectionSnapshot,registeredAt:snapshot.registeredAt,companyRevision:snapshot.companyRevision,sourcesRevision:snapshot.stages[0]!.sourcesRevision,guardrailsRevision:snapshot.guardrailsRevision,projectRevision:snapshot.projectRevision,process:snapshot.process};
 if(revisions.size!==1)throw unavailable();
 return {writeContext,lessSafeReasons,ok:verified&&stages.every(stage=>stage.kind==="resolved"),model,stages,inputRevisions:{companyRevision:snapshot.companyRevision,projectRevision:snapshot.projectRevision,processDigest:snapshot.process.digest}};
}
/** Slack/CLI cannot bypass the process confirmation surface for a less-safe change. */
export async function requireSafeProjectModelSelection(deps:StageModelsReadDependencies,caller:StageModelCaller,project:string,rawModel:unknown){
 const result=await validateProjectModelSelection(deps,caller,project,rawModel);
 const context=result.writeContext;
 if(context.registeredAt===undefined||!Number.isFinite(Date.parse(context.registeredAt))||context.guardrailsRevision===undefined||![context.companyRevision,context.sourcesRevision,context.guardrailsRevision].every(value=>Number.isSafeInteger(value)&&value>=0)||!Number.isSafeInteger(context.projectRevision)||context.projectRevision<1||!/^[a-f0-9]{64}$/u.test(context.process.digest))throw unavailable();
 if(!result.ok)throw agentXError("MODEL_NOT_ALLOWED","This model is not verified for the project's stages. Check How we work.");
 if(result.lessSafeReasons.length>0)throw agentXError("MODEL_NOT_ALLOWED","This model change needs review. Change it in How we work.");
 return result;
}
export async function getStageModels(deps:StageModelsReadDependencies,caller:StageModelCaller,project:string,query:unknown):Promise<StageModelsResponse> {
 const {snapshot,canEdit}=await load(deps,caller,project,query);
 const {stages,inputs}=decide(snapshot,{});
 const rows=stages.map(decision=>{
  const input=inputs.get(decision.stage)!;
  const locked=input.companyLock!==undefined;
  const base={stage:decision.stage,projectChoice:input.projectChoice??null,companyDefault:input.companyLock??input.companyDefault??null,locked,editable:canEdit&&!locked,candidatesState:"complete" as const,candidates:input.candidates.map(candidate=>({model:candidate.model,label:candidate.model.modelId,provider:candidate.model.provider,company:companyOf(candidate.model.provider,candidate.model.modelId),status:stageCandidateVerified(input,candidate)?"verified" as const:"unverified" as const,...(stageCandidateVerified(input,candidate)?{}:{blockedReason:"MODEL_NOT_VERIFIED" as const})}))};
  return decision.kind==="refusal"?{...base,refusal:{code:decision.code,fixHref:decision.fixHref}}:{...base,effective:{model:decision.model,sourceId:decision.sourceId,thinkingLevel:decision.thinkingLevel,decidedBy:decision.reason==="PERSONAL_PLAN_DEFAULT"?"person" as const:decision.reason==="COMPANY_LOCK"||decision.reason==="COMPANY_DEFAULT"?"company" as const:decision.reason==="PROJECT_CHOICE"||decision.reason==="PROJECT_SELECTION"||decision.reason==="PROJECT_DEFAULT"?"project" as const:"rovara" as const,locked,reason:decision.reason}};
 });
 const parsed=StageModelsResponseSchema.safeParse({version:1,checkedAt:new Date(deps.now()).toISOString(),companyRevision:snapshot.companyRevision,projectRevision:snapshot.projectRevision,process:snapshot.process,rankingVersion:"g3-v1",stages:rows});
 if(!parsed.success) throw unavailable();
 return parsed.data;
}
// Model-company mapping is shared with dispatch, not inferred by the UI.
import { modelCompany } from "@agentx/contracts";
const companyOf=(provider:string,modelId:string)=>modelCompany({provider,modelId});
