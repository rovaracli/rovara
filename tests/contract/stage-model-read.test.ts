import { AgentXError, modelNotEnabledSentence } from "@rovara-code/contracts";
import { expect, it } from "vitest";
import { validateStageChoices, getStageModels, validateProjectModelSelection, requireSafeProjectModelSelection } from "../../packages/broker/src/model-selection/read.js";
import type { StageModelsReadDependencies, StageModelSnapshot } from "../../packages/broker/src/model-selection/read.js";
import { STAGE_IDS } from "@rovara-code/contracts";
const model = { provider: "anthropic", modelId: "claude-sonnet-4" };
const other = { provider: "anthropic", modelId: "claude-opus-4" };
const caller = { orgId: "org_a", developerId: "dev_a" };
function fixture() {
 const snapshot: StageModelSnapshot = { orgId:"org_a", project:"web", companyRevision:0,projectRevision:1,registeredAt:"2026-10-01T00:00:00Z",guardrailsRevision:0,process:{agentId:"rovara-code",version:2,digest:"a".repeat(64)},canEdit:true,stages:STAGE_IDS.map(stage=>({orgId:"org_a",stage,sourcesRevision:0,forbidden:[],approved:[model,other],builtinDefault:model,candidates:[model,other].map(model=>({model,sourceId:"rovara",enabled:true,inEffectiveOrder:true,evidence:{orgId:"org_a",sourcesRevision:0,kind:"rovara_catalog"}}))})) };
 let reads=0;
 const deps:StageModelsReadDependencies={now:()=>Date.parse("2026-10-29T22:00:00.000Z"),projectFor:async()=>({name:"web",canEdit:true}),snapshot:async()=>{reads++;return snapshot;}};
 return {deps,snapshot,reads:()=>reads};
}
it("resolves preview Build/Plan first and emits seven server-decided flat stage rows",async()=>{
 const f=fixture();const result=await getStageModels(f.deps,caller,"web",{});
 expect(result.stages).toHaveLength(7);
 expect(result.stages.find(row=>row.stage==="build")).toMatchObject({effective:{model}});
 expect(result.stages.find(row=>row.stage==="code_review")).toMatchObject({effective:{model:other}});
 expect(f.reads()).toBe(1);
});
it("validates project choices through the same resolver instead of a UI chooser",async()=>{
 const f=fixture(); const result=await validateStageChoices(f.deps,caller,"web",{build:{model:other}});
 expect(result.ok).toBe(true);expect(result.stages.find(row=>row.stage==="build")).toMatchObject({kind:"resolved",model:other});
});
it("refuses inaccessible project before reading policy or sources",async()=>{
 const f=fixture();f.deps.projectFor=async()=>{throw Error("PROJECT_NOT_FOUND");};
 await expect(getStageModels(f.deps,caller,"foreign",{})).rejects.toThrow("PROJECT_NOT_FOUND");expect(f.reads()).toBe(0);
});
it("never exposes draft to a reader, and distinguishes draft-stale from policy stale",async()=>{
 const f=fixture();f.deps.projectFor=async()=>({name:"web",canEdit:false});
 await expect(getStageModels(f.deps,caller,"web",{draft:2})).rejects.toThrow("FORBIDDEN");expect(f.reads()).toBe(0);
 const g=fixture();g.snapshot.process.draftRevision=3;
 await expect(getStageModels(g.deps,caller,"web",{draft:2})).rejects.toMatchObject({code:"DRAFT_STALE",statusCode:409});
});
it("refuses misbound or unbounded server snapshots without truncation",async()=>{
 const f=fixture();f.snapshot.orgId="org_b";
 await expect(getStageModels(f.deps,caller,"web",{})).rejects.toThrow();
 const g=fixture();g.snapshot.stages[0]!.candidates=Array(24).fill(g.snapshot.stages[0]!.candidates[0]);
 await expect(getStageModels(g.deps,caller,"web",{})).rejects.toThrow();
});
it("returns source errors as unavailable instead of empty successful options",async()=>{
 const f=fixture();f.deps.snapshot=async()=>{throw Error("provider secret raw error");};
 await expect(getStageModels(f.deps,caller,"web",{})).rejects.toThrow("could not be read");
});
it("rejects unknown stage choices and query fields before snapshot reads",async()=>{
 const f=fixture();await expect(getStageModels(f.deps,caller,"web",{orgId:"foreign"})).rejects.toThrow();expect(f.reads()).toBe(0);
 await expect(validateStageChoices(f.deps,caller,"web",{unknown:{model}})).rejects.toThrow();expect(f.reads()).toBe(0);
});

it("normalizes the single Plan/Understand edit and rejects split choices",async()=>{
 const f=fixture();const result=await validateStageChoices(f.deps,caller,"web",{understand:{model:other}});
 for(const stage of ["understand","plan"]) expect(result.stages.find(row=>row.stage===stage)).toMatchObject({kind:"resolved",model:other});
 await expect(validateStageChoices(f.deps,caller,"web",{understand:{model},plan:{model:other}})).rejects.toThrow("share one model choice");
});

it("validates project-wide selection below company defaults and locks with edit authority",async()=>{
 const f=fixture();f.snapshot.stages.find(row=>row.stage==="build")!.companyDefault={model};
 const result=await validateProjectModelSelection(f.deps,caller,"web",other);
 expect(result.stages.find(row=>row.stage==="build")).toMatchObject({kind:"resolved",model,reason:"COMPANY_DEFAULT"});
 expect(result.stages.find(row=>row.stage==="plan")).toMatchObject({kind:"resolved",model:other,reason:"PROJECT_SELECTION"});
 expect((await validateProjectModelSelection(f.deps,caller,"web",{provider:"openai",modelId:"unknown"})).ok).toBe(false);
 const beforeDenied=f.reads();
 f.deps.projectFor=async()=>({name:"web",canEdit:false});
 await expect(validateProjectModelSelection(f.deps,caller,"web",other)).rejects.toThrow("maintainer");
 expect(f.reads()).toBe(beforeDenied);
});
it("classifies only effective changes when company locks mask project selection",async()=>{
 const f=fixture();
 for(const row of f.snapshot.stages)row.companyLock={model:row.stage==="plan_check"||row.stage==="code_review"||row.stage==="security_review"?other:model};
 const result=await validateProjectModelSelection(f.deps,caller,"web",other);
 expect(result.ok).toBe(true);expect(result.lessSafeReasons).toEqual([]);
 expect(result.stages.find(row=>row.stage==="build")).toMatchObject({kind:"resolved",model,reason:"COMPANY_LOCK"});
 expect((await validateProjectModelSelection(f.deps,caller,"web",{provider:"openai",modelId:"unknown"})).ok).toBe(false);
});

it("refuses less-safe Slack/CLI selections through How we work before a writer can proceed",async()=>{
 const f=fixture();const route={provider:"amazon-bedrock",modelId:"us.anthropic.claude-sonnet-4-v1:0"};
 for(const row of f.snapshot.stages){
  row.approved=[...(row.approved??[]),route];
  row.candidates=[...row.candidates,{model:route,sourceId:"rovara",enabled:true,inEffectiveOrder:true,evidence:{orgId:caller.orgId,sourcesRevision:0,kind:"rovara_catalog"}}];
 }
 await expect(requireSafeProjectModelSelection(f.deps,caller,"web",route)).rejects.toThrow("How we work");
 const locked=fixture();
 for(const row of locked.snapshot.stages)row.companyLock={model:row.stage==="plan_check"||row.stage==="code_review"||row.stage==="security_review"?other:model};
 await expect(requireSafeProjectModelSelection(locked.deps,caller,"web",other)).resolves.toMatchObject({ok:true,lessSafeReasons:[]});
 await expect(requireSafeProjectModelSelection(locked.deps,caller,"web",{provider:"openai",modelId:"unknown"})).rejects.toThrow("not verified");
});

it("carries one exact source, guardrail, company and project context into safe selection writes",async()=>{
 const f=fixture();
 for(const row of f.snapshot.stages)row.companyLock={model:row.stage==="plan_check"||row.stage==="code_review"||row.stage==="security_review"?other:model};
 const result=await requireSafeProjectModelSelection(f.deps,caller,"web",other);
 expect(result.writeContext).toEqual({registeredAt:f.snapshot.registeredAt,companyRevision:0,sourcesRevision:0,guardrailsRevision:0,projectRevision:1,process:f.snapshot.process});
 f.snapshot.stages[1]!.sourcesRevision=1;
 await expect(requireSafeProjectModelSelection(f.deps,caller,"web",other)).rejects.toThrow("could not be read");
});

for(const corrupt of ["registration","guardrails","company","project","digest"] as const)it(`refuses missing or invalid ${corrupt} in a safe selection write context`,async()=>{
 const f=fixture();
 for(const row of f.snapshot.stages)row.companyLock={model:row.stage==="plan_check"||row.stage==="code_review"||row.stage==="security_review"?other:model};
 if(corrupt==="registration")delete f.snapshot.registeredAt;
 if(corrupt==="guardrails")delete f.snapshot.guardrailsRevision;
 if(corrupt==="company")f.snapshot.companyRevision=-1;
 if(corrupt==="project")f.snapshot.projectRevision=0;
 if(corrupt==="digest")f.snapshot.process.digest="invalid";
 await expect(requireSafeProjectModelSelection(f.deps,caller,"web",other)).rejects.toThrow("could not be read");
});

it("refuses an explicit conflicting project tuple beneath a company lock with its stage and repair link",async()=>{
 const f=fixture();f.snapshot.stages.find(row=>row.stage==="build")!.companyLock={model,thinkingLevel:null};
 const result=await validateStageChoices(f.deps,caller,"web",{build:{model:other}});
 expect(result.ok).toBe(false);
 expect(result.stages.find(row=>row.stage==="build")).toMatchObject({kind:"refusal",code:"STAGE_LOCKED",fixHref:"/app/admin/how-we-work"});
});
it("refuses an inherited published choice that conflicts with the lock even when omitted from the changed draft",async()=>{
 const f=fixture(),build=f.snapshot.stages.find(row=>row.stage==="build")!;
 build.companyLock={model,thinkingLevel:null};build.projectChoice={model:other};
 const result=await validateStageChoices(f.deps,caller,"web",{});
 expect(result.ok).toBe(false);expect(result.stages.find(row=>row.stage==="build")).toMatchObject({kind:"refusal",code:"STAGE_LOCKED"});
});
it("allows a project tuple matching the lock and points unverified source refusals to source settings",async()=>{
 const f=fixture();f.snapshot.stages.find(row=>row.stage==="build")!.companyLock={model,thinkingLevel:null};
 expect((await validateStageChoices(f.deps,caller,"web",{build:{model,thinkingLevel:null}})).ok).toBe(true);
 const g=fixture();g.snapshot.stages.find(row=>row.stage==="build")!.candidates=[];
 const result=await validateStageChoices(g.deps,caller,"web",{build:{model}});
 expect(result.stages.find(row=>row.stage==="build")).toMatchObject({kind:"refusal",code:"MODEL_NOT_VERIFIED",fixHref:"/app/admin/models/sources"});
 const read=await getStageModels(g.deps,caller,"web",{});
 expect(read.stages.find(row=>row.stage==="build")).toMatchObject({refusal:{fixHref:"/app/admin/models/sources"}});
});

it("requires confirmation for an explicit same-model review and accepts only its exact server approval tuple",async()=>{
 const f=fixture(),choices={build:{model},code_review:{model}};
 const pending=await validateStageChoices(f.deps,caller,"web",choices);
 expect(pending).toMatchObject({ok:false,requiresConfirmation:true,status:202});
 expect(pending).toHaveProperty("approvalTupleDigest",expect.stringMatching(/^[a-f0-9]{64}$/u));
 const digest=(pending as unknown as {approvalTupleDigest:string}).approvalTupleDigest;
 f.deps.verifySameModelApproval=async context=>context.approvalId==="apr_aaaaaaaaaaaaaaaaaaaa";
 const approved=await validateStageChoices(f.deps,caller,"web",choices,{}, {approvalId:"apr_aaaaaaaaaaaaaaaaaaaa",tupleDigest:digest});
 expect(approved).toMatchObject({ok:true,requiresConfirmation:false,status:200});
 expect(approved.stages.find(row=>row.stage==="code_review")).toMatchObject({kind:"resolved",model});
 f.snapshot.stages.find(row=>row.stage==="build")!.projectChoice={model:other};
 expect(await validateStageChoices(f.deps,caller,"web",{code_review:{model:other}},{},{approvalId:"apr_aaaaaaaaaaaaaaaaaaaa",tupleDigest:digest})).toMatchObject({ok:false});
});
it("does not offer approval for unavailable same-model choices or required vendor independence",async()=>{
 for(const unavailable of [true,false]) {
  const f=fixture();for(const stage of ["code_review","security_review"]){const row=f.snapshot.stages.find(row=>row.stage===stage)!;if(unavailable)row.candidates=[];else row.requireDifferentVendor=true;}
  const result=await validateStageChoices(f.deps,caller,"web",{code_review:{model}});
  expect(result.ok).toBe(false);expect(result).not.toMatchObject({requiresConfirmation:true});
 }
});

for(const changed of ["company","source","registration","thinking"] as const)it(`refuses same-model approval after ${changed} tuple changes`,async()=>{
 const f=fixture(),choices={build:{model},code_review:{model}};
 const pending=await validateStageChoices(f.deps,caller,"web",choices);
 const approval={approvalId:"apr_aaaaaaaaaaaaaaaaaaaa",tupleDigest:pending.approvalTupleDigest};
 if(changed==="company")f.snapshot.companyRevision++;
 if(changed==="source")for(const row of f.snapshot.stages){row.sourcesRevision++;for(const candidate of row.candidates)if(candidate.evidence!==undefined)candidate.evidence.sourcesRevision++;}
 if(changed==="registration")f.snapshot.registeredAt="2026-10-02T00:00:00Z";
 const next=changed==="thinking"?{...choices,code_review:{model,thinkingLevel:"high" as const}}:choices;
 expect(await validateStageChoices(f.deps,caller,"web",next,{},approval)).toMatchObject({ok:false,requiresConfirmation:false});
});

it("refuses implicit same-model validation even when production snapshot enables legacy runtime fallback",async()=>{
 const f=fixture();for(const row of f.snapshot.stages){row.allowLegacyDefaultFallback=true;row.candidates=row.candidates.filter(candidate=>candidate.model===model);row.approved=[model];}
 const result=await validateStageChoices(f.deps,caller,"web",{});
 expect(result).toMatchObject({ok:false,requiresConfirmation:false});
 for(const stage of ["plan_check","code_review","security_review"])expect(result.stages.find(row=>row.stage===stage)).toMatchObject({kind:"refusal",code:"DIFFERENT_FROM_UNSATISFIABLE"});
});
it("does not accept a formatted approval id and tuple digest without a verified approved record",async()=>{
 const f=fixture(),choices={build:{model},code_review:{model}},pending=await validateStageChoices(f.deps,caller,"web",choices);
 const result=await validateStageChoices(f.deps,caller,"web",choices,{}, {approvalId:"apr_bbbbbbbbbbbbbbbbbbbb",tupleDigest:pending.approvalTupleDigest});
 expect(result).toMatchObject({ok:false,status:409});
});

it("preserves typed draft staleness from the snapshot adapter without parsing messages", async () => {
 const f=fixture();
 const stale=new AgentXError("DRAFT_STALE", "draft changed",409);
 f.deps.snapshot=async()=>{throw stale;};
 await expect(getStageModels(f.deps,caller,"web",{draft:2})).rejects.toBe(stale);
});

it("attributes the payer's preferred plan model to the person rather than Rovara",async()=>{
 const f=fixture();
 f.snapshot.stages.find(row=>row.stage==="build")!.defaultPreferred=other;
 const result=await getStageModels(f.deps,caller,"web",{});
 expect(result.stages.find(row=>row.stage==="build")).toMatchObject({effective:{reason:"PERSONAL_PLAN_DEFAULT",decidedBy:"person",model:other}});
});

it("does not attribute inherited recipe models to company policy",async()=>{
 const f=fixture();
 const row=f.snapshot.stages.find(row=>row.stage==="build")!;
 Object.assign(row,{companyDefault:{model:other},companyDefaultOrigin:"recipe"});
 const result=await getStageModels(f.deps,caller,"web",{});
 expect(result.stages.find(row=>row.stage==="build")).toMatchObject({effective:{reason:"RECIPE_DEFAULT",decidedBy:"rovara",model:other}});
});

it("preserves a structured split-lock refusal from its snapshot",async()=>{
 const f=fixture();const {ProcessModelRefusal}=await import("../../packages/broker/src/model-selection/process-refusal.js");f.deps.snapshot=async()=>{throw new ProcessModelRefusal("LOCK_UNSATISFIABLE","code_review","/app/admin/how-we-work");};
 await expect(getStageModels(f.deps,caller,"web",{})).rejects.toMatchObject({code:"LOCK_UNSATISFIABLE",stage:"code_review",fixHref:"/app/admin/how-we-work"});
});
it("marks a candidate the account cannot call with the broker's words, and marks no other",async()=>{
 const f=fixture();for(const stage of f.snapshot.stages)stage.candidates=stage.candidates.map(candidate=>candidate.model.modelId===other.modelId?{...candidate,accountCannotUse:true as const}:candidate);
 const result=await getStageModels(f.deps,caller,"web",{});
 for(const row of result.stages){
  expect(row.candidates.find(candidate=>candidate.model.modelId===other.modelId)?.unusableReason).toBe(modelNotEnabledSentence(undefined,undefined));
  expect(row.candidates.filter(candidate=>candidate.model.modelId!==other.modelId).every(candidate=>candidate.unusableReason===undefined)).toBe(true);
 }
});
