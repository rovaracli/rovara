import { expect,it } from "vitest";
import { loadStageModelSnapshot } from "../../packages/broker/src/model-selection/snapshot.js";
import { projectRevisionKey, ROVARA_CODE_AGENT_ID } from "@rovara-code/contracts";
import { mergeWorld } from "../support/rovara-code-merge-world.js";
import { ORG_A,MAX } from "../support/agent-session-world.js";
function fixture(){
 const w=mergeWorld();w.db.set({...projectRevisionKey(ORG_A,"web",1),entityType:"PROJECT",registeredAt:"2026-10-01T00:00:00Z",definition:{name:"web",revision:1,repositories:[{name:"web",url:"https://github.com/acme/web.git",path:"repo/web",defaultBranch:"main",credentialRef:"github-app"}],setup:[],readiness:[],orchestratorInstructions:"Delegate work."},runtimeBinding:{}});
 return {w,deps:{documentClient:w.db,tableName:"state",store:w.store,now:()=>w.clock.now,routing:{}}};
}
it("loads the actual builtin process, project revision and source evidence without initializing settings",async()=>{
 const {w,deps}=fixture();const before=structuredClone([...w.db.items]);
 const snap=await loadStageModelSnapshot(deps,{orgId:ORG_A,developerId:MAX},"web");
 expect(snap.stages).toHaveLength(7);expect(snap.process.agentId).toBe(ROVARA_CODE_AGENT_ID);expect(snap.projectRevision).toBe(1);expect(snap.processChain?.at(-1)).toMatchObject({agentId:snap.process.agentId,version:snap.process.version,builtin:true});expect(snap.stages[0]?.candidates.length).toBeGreaterThan(0);
 expect([...w.db.items]).toEqual(before);
});
it("loads a process draft through bounded discovery without using store.list",async()=>{
 const {w,deps}=fixture();const layer=await w.store.create({orgId:ORG_A,name:"web process",owner:{kind:"project",project:"web"},accountable:{developerId:MAX},extends:ROVARA_CODE_AGENT_ID,overlay:{},purpose:"process",createdBy:MAX});
 w.store.list=async()=>{throw Error("unbounded list forbidden");};
 const snap=await loadStageModelSnapshot(deps,{orgId:ORG_A,developerId:MAX},"web",layer.draftRevision);
 expect(snap.process.agentId).toBe(layer.agentId);expect(snap.process.draftRevision).toBe(layer.draftRevision);
 await expect(loadStageModelSnapshot(deps,{orgId:ORG_A,developerId:MAX},"web",layer.draftRevision+1)).rejects.toMatchObject({code:"DRAFT_STALE",statusCode:409});
});
it("does not manufacture a process draft or project on missing storage",async()=>{
 const {deps}=fixture();await expect(loadStageModelSnapshot(deps,{orgId:ORG_A,developerId:MAX},"missing")).rejects.toThrow();
 await expect(loadStageModelSnapshot(deps,{orgId:ORG_A,developerId:MAX},"web",0)).rejects.toThrow();
});

it("preserves metadata-only process settings in the server snapshot",async()=>{
 const {w,deps}=fixture();const layer=await w.store.create({orgId:ORG_A,name:"web process",owner:{kind:"project",project:"web"},accountable:{developerId:MAX},extends:ROVARA_CODE_AGENT_ID,overlay:{steps:{plan:{thinkingLevel:"low"},review:{differentCompanyFrom:"build"}}},purpose:"process",createdBy:MAX});
 const snap=await loadStageModelSnapshot(deps,{orgId:ORG_A,developerId:MAX},"web",layer.draftRevision);
 expect(snap.stages.find(row=>row.stage==="plan")?.projectChoice).toEqual({thinkingLevel:"low"});
 expect(snap.stages.find(row=>row.stage==="understand")?.projectChoice).toEqual({thinkingLevel:"low"});
 expect(snap.stages.find(row=>row.stage==="code_review")?.projectChoice).toEqual({differentFrom:{stage:"build",level:"vendor"}});
});

it("retains a recipe model beneath partial project and company settings",async()=>{
 const {w,deps}=fixture();const original=w.store.builtinRecipe.bind(w.store);
 const model={provider:"anthropic",modelId:"claude-opus-4"};
 w.store.builtinRecipe=(...args)=>{const recipe=structuredClone(original(...args));const step=recipe.steps.find(step=>step.kind==="plan")!;step.settings={...step.settings,model};return recipe;};
 const layer=await w.store.create({orgId:ORG_A,name:"web process",owner:{kind:"project",project:"web"},accountable:{developerId:MAX},extends:ROVARA_CODE_AGENT_ID,overlay:{steps:{plan:{thinkingLevel:"low"}}},purpose:"process",createdBy:MAX});
 w.db.set({pk:`ORG#${ORG_A}#SETTINGS`,sk:"MODEL_SELECTION_POLICY",orgId:ORG_A,entityType:"MODEL_SELECTION_POLICY",version:1,revision:1,rankingVersion:"g3-v1",stepOverrides:{plan:{thinkingLevel:"high",locked:false}}});
 const snap=await loadStageModelSnapshot(deps,{orgId:ORG_A,developerId:MAX},"web",layer.draftRevision);
 for(const stage of ["plan","understand"]) expect(snap.stages.find(row=>row.stage===stage)).toMatchObject({projectChoice:{thinkingLevel:"low"},companyDefault:{model,thinkingLevel:"high"},companyDefaultOrigin:"recipe"});
});

it("honors recipe null clears without relaxing a company lock",async()=>{
 const {w,deps}=fixture();const model={provider:"anthropic",modelId:"claude-opus-4"};
 const layer=await w.store.create({orgId:ORG_A,name:"web process",owner:{kind:"project",project:"web"},accountable:{developerId:MAX},extends:ROVARA_CODE_AGENT_ID,overlay:{steps:{review:{fallbackModel:null,differentCompanyFrom:null}}},purpose:"process",createdBy:MAX});
 const key={pk:`ORG#${ORG_A}#SETTINGS`,sk:"MODEL_SELECTION_POLICY"};
 const policy={...key,orgId:ORG_A,entityType:"MODEL_SELECTION_POLICY",version:1,revision:1,rankingVersion:"g3-v1",stepOverrides:{code_review:{model,thinkingLevel:null,fallbackModel:model,differentFrom:{stage:"build",level:"vendor"},locked:false}}};
 w.db.set(policy);
 const load=()=>loadStageModelSnapshot(deps,{orgId:ORG_A,developerId:MAX},"web",layer.draftRevision);
 let row=(await load()).stages.find(row=>row.stage==="code_review")!;
 expect(row.projectChoice?.differentFrom).toEqual({stage:"build",level:"model"});expect(row.companyDefault?.fallbackModel).toBeUndefined();
 w.db.set({...policy,stepOverrides:{code_review:{...policy.stepOverrides.code_review,locked:true}}});
 row=(await load()).stages.find(row=>row.stage==="code_review")!;
 expect(row.companyLock).toMatchObject({fallbackModel:model,differentFrom:{level:"vendor"}});
});

it("validates the exact server-supplied publication recipe rather than the active process",async()=>{
 const {w,deps}=fixture();const { builtinRecipe } = await import("@rovara-code/contracts");
 const layer=await w.store.create({orgId:ORG_A,name:"web proposed",owner:{kind:"project",project:"web"},accountable:{developerId:MAX},extends:ROVARA_CODE_AGENT_ID,overlay:{steps:{plan:{thinkingLevel:"low"}}},purpose:"process",createdBy:MAX});
 const recipe=builtinRecipe(ROVARA_CODE_AGENT_ID,1);recipe.steps.find(step=>step.kind==="plan")!.settings.thinkingLevel="low";
 const snap=await loadStageModelSnapshot(deps,{orgId:ORG_A,developerId:MAX},"web",undefined,{record:layer,recipe,overlay:{steps:{plan:{thinkingLevel:"low"}}}});
 expect(snap.process.agentId).toBe(layer.agentId);expect(snap.stages.find(row=>row.stage==="plan")?.projectChoice).toEqual({thinkingLevel:"low"});
 await expect(loadStageModelSnapshot(deps,{orgId:ORG_A,developerId:MAX},"web",undefined,{record:{...layer,owner:{kind:"project",project:"other"}},recipe,overlay:{}})).rejects.toThrow();
});

it("retains the exact guardrail revision used by the source snapshot",async()=>{
 const {w,deps}=fixture();
 const initial=await loadStageModelSnapshot(deps,{orgId:ORG_A,developerId:MAX},"web");
 expect(initial.guardrailsRevision).toBe(0);
 const { agentGuardrailsKey, DEFAULT_AGENT_GUARDRAILS } = await import("@rovara-code/contracts");
 w.db.set({...agentGuardrailsKey(ORG_A),revision:1,guardrails:{...DEFAULT_AGENT_GUARDRAILS,requireCrossCompanyReview:true}});
 const changed=await loadStageModelSnapshot(deps,{orgId:ORG_A,developerId:MAX},"web");
 expect(changed.guardrailsRevision).toBe(1);
 expect(changed.stages.find(row=>row.stage==="code_review")?.requireDifferentVendor).toBe(true);
});

it("retains absent and stored playbook and selection inputs without another read",async()=>{
 const {w,deps}=fixture();
 const first=await loadStageModelSnapshot(deps,{orgId:ORG_A,developerId:MAX},"web");
 expect(first.selectionSnapshot).toEqual({exists:false});
 expect(first.playbookSnapshot).toEqual({exists:false,revision:0,defaultProcess:{kind:"builtin"}});
 const { projectPlaybookKey, projectSelectionKey } = await import("@rovara-code/contracts");
 const model={provider:"amazon-bedrock",modelId:"us.anthropic.claude-sonnet-4-v1:0"};
 w.db.set({...projectSelectionKey(ORG_A,"web"),model});
 w.db.set({...projectPlaybookKey(ORG_A,"web"),revision:4,defaultProcess:{kind:"builtin"}});
 const stored=await loadStageModelSnapshot(deps,{orgId:ORG_A,developerId:MAX},"web");
 expect(stored.selectionSnapshot).toEqual({exists:true,model});
 expect(stored.playbookSnapshot).toEqual({exists:true,revision:4,defaultProcess:{kind:"builtin"}});
});

it("previews a proposed company tuple without saving it or losing the current revision binding",async()=>{
 const {w,deps}=fixture(),caller={orgId:ORG_A,developerId:MAX},before=structuredClone([...w.db.items]);
 const proposed={version:1 as const,revision:0,rankingVersion:"g3-v1" as const,stepOverrides:{build:{model:{provider:"anthropic",modelId:"claude-opus-4"},locked:false}}};
 const snap=await loadStageModelSnapshot(deps,caller,"web",undefined,undefined,proposed);
 expect(snap.stages.find(row=>row.stage==="build")?.companyDefault).toMatchObject({model:proposed.stepOverrides.build.model});
 expect([...w.db.items]).toEqual(before);
 await expect(loadStageModelSnapshot(deps,caller,"web",undefined,undefined,{...proposed,revision:1})).rejects.toThrow("could not be read");
});
