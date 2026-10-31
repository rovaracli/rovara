import {expect,it} from "vitest";
import {parseStageModelApprovalProof,processApprovalRecipeDigest} from "../../packages/broker/src/model-selection/approval-proof.js";
const model={provider:"anthropic",modelId:"claude-sonnet-4"};
const binding={orgId:"org_aaaaaaaaaaaaaaaaaaaa",project:"web",registeredAt:"2026-10-01T00:00:00.000Z",agentId:"agt_aaaaaaaaaaaaaaaaaaaa",recipeDigest:"a".repeat(64)};
const proof={...binding,version:1 as const,companyRevision:4,approvalId:"apr_aaaaaaaaaaaaaaaaaaaa",exceptions:[{stage:"code_review" as const,model,referenceModel:model}]};
it("retains only a bounded exact recipe/project/policy approval proof",()=>{
 expect(parseStageModelApprovalProof(proof,binding)).toEqual(proof);
 for(const field of ["orgId","project","registeredAt","agentId","recipeDigest"]) expect(()=>parseStageModelApprovalProof({...proof,[field]:"different"},binding)).toThrow();
 for(const bad of [{...proof,companyRevision:-1},{...proof,exceptions:[...proof.exceptions,...proof.exceptions]},{...proof,exceptions:[{...proof.exceptions[0],stage:"build"}]},{...proof,exceptions:[{...proof.exceptions[0],referenceModel:{provider:"anthropic",modelId:"claude-opus-4"}}]},{...proof,approved:true}]) expect(()=>parseStageModelApprovalProof(bad,binding)).toThrow();
});

it("persists proof only on its bound process version and refuses cross-agent proof",async()=>{
 const {mergeWorld}=await import("../support/rovara-code-merge-world.js");
 const {ORG_A,MAX}=await import("../support/agent-session-world.js");
 const {ROVARA_CODE_AGENT_ID}=await import("../../packages/contracts/src/index.js");
 const w=mergeWorld();const agent=await w.store.create({orgId:ORG_A,name:"web process",owner:{kind:"project",project:"web"},accountable:{developerId:MAX},extends:ROVARA_CODE_AGENT_ID,overlay:{},purpose:"process",createdBy:MAX});
 const bound={...proof,orgId:ORG_A,agentId:agent.agentId};
 w.db.set({pk:`ORG#${ORG_A}#SETTINGS`,sk:"MODEL_SELECTION_POLICY",revision:bound.companyRevision});
 const input={orgId:ORG_A,agentId:agent.agentId,expectedDraftRevision:agent.draftRevision,digest:bound.recipeDigest,by:MAX,safety:"less_safe" as const,modelApproval:bound,modelRevisions:{companyRevision:bound.companyRevision,sourcesRevision:0}};
 await expect(w.store.publish({...input,modelApproval:{...bound,agentId:"agt_zzzzzzzzzzzzzzzzzzzz"}})).rejects.toThrow("does not match");
 await expect(w.store.publish({...input,safety:"safe"})).rejects.toThrow("does not match");
 await expect(w.store.publish({...input,modelApproval:{...bound,project:"other"}})).rejects.toThrow("does not match");
 await expect(w.store.publish({orgId:input.orgId,agentId:input.agentId,expectedDraftRevision:input.expectedDraftRevision,digest:input.digest,by:input.by,safety:input.safety,modelApproval:input.modelApproval})).rejects.toThrow("requires model revision checks");
 const published=await w.store.publish(input);
 expect(published.modelApproval).toEqual(bound);
 expect((await w.store.getVersion(ORG_A,agent.agentId,published.version))?.modelApproval).toEqual(bound);
});

it("refuses a publish when validated company or source revisions moved, leaving no version",async()=>{
 const {mergeWorld}=await import("../support/rovara-code-merge-world.js");const {ORG_A,MAX}=await import("../support/agent-session-world.js");const {ROVARA_CODE_AGENT_ID,orgSettingsKey,modelSourcesKey}=await import("../../packages/contracts/src/index.js");
 for(const kind of ["company","sources"] as const){
  const w=mergeWorld();const agent=await w.store.create({orgId:ORG_A,name:"web process",owner:{kind:"project",project:"web"},accountable:{developerId:MAX},extends:ROVARA_CODE_AGENT_ID,overlay:{},purpose:"process",createdBy:MAX});
  w.db.set({...kind==="company"?orgSettingsKey(ORG_A,"MODEL_SELECTION_POLICY"):modelSourcesKey(ORG_A),revision:1});
  await expect(w.store.publish({orgId:ORG_A,agentId:agent.agentId,expectedDraftRevision:agent.draftRevision,digest:binding.recipeDigest,by:MAX,modelRevisions:{companyRevision:0,sourcesRevision:0}})).rejects.toThrow("model policy or sources changed");
  expect(await w.store.getVersion(ORG_A,agent.agentId,1)).toBeUndefined();
  const result=await w.store.publish({orgId:ORG_A,agentId:agent.agentId,expectedDraftRevision:agent.draftRevision,digest:binding.recipeDigest,by:MAX,modelRevisions:{companyRevision:kind==="company"?1:0,sourcesRevision:kind==="sources"?1:0}});
  expect(result.version).toBe(1);
 }
});

it("normalizes only the publication chain marker while retaining base pins and recipe content",async()=>{
 const {EMPTY_RECIPE}=await import("../../packages/contracts/src/index.js");
 const recipe={...structuredClone(EMPTY_RECIPE),chain:[{agentId:"rovara-code",name:"Rovara Code",version:1,builtin:true},{agentId:binding.agentId,name:"Process",version:"draft" as const,builtin:false,process:true as const}]};
 const numbered={...recipe,chain:recipe.chain.map(row=>row.agentId===binding.agentId?{...row,version:3}:row)};
 expect(processApprovalRecipeDigest(numbered,binding.agentId)).toBe(processApprovalRecipeDigest(recipe,binding.agentId));
 expect(processApprovalRecipeDigest({...numbered,chain:numbered.chain.map(row=>row.builtin?{...row,version:2}:row)},binding.agentId)).not.toBe(processApprovalRecipeDigest(recipe,binding.agentId));
 expect(processApprovalRecipeDigest({...numbered,instructions:[{agentName:"Process",text:"Changed"}]},binding.agentId)).not.toBe(processApprovalRecipeDigest(recipe,binding.agentId));
});

it("refuses an oversized rollback transaction before changing the current version",async()=>{
 const {mergeWorld}=await import("../support/rovara-code-merge-world.js");const {ORG_A,MAX}=await import("../support/agent-session-world.js");const {ROVARA_CODE_AGENT_ID}=await import("../../packages/contracts/src/index.js");
 const w=mergeWorld();const agent=await w.store.create({orgId:ORG_A,name:"web capacity",owner:{kind:"project",project:"web"},accountable:{developerId:MAX},extends:ROVARA_CODE_AGENT_ID,overlay:{},purpose:"process",createdBy:MAX});
 for(let n=0;n<2;n++) await w.store.publish({orgId:ORG_A,agentId:agent.agentId,expectedDraftRevision:agent.draftRevision,digest:binding.recipeDigest,by:MAX});
 const checks=Array.from({length:24},(_,n)=>({ConditionCheck:{TableName:"state",Key:{pk:`ORG#${ORG_A}#CAPACITY`,sk:String(n)},ConditionExpression:"attribute_not_exists(pk)"}}));
 await expect(w.store.rollback({orgId:ORG_A,agentId:agent.agentId,version:1,expectedCurrentVersion:2,by:MAX,modelRevisions:{companyRevision:0,sourcesRevision:0},modelAuthorityChecks:checks})).rejects.toThrow("transaction limit");
 expect((await w.store.get(ORG_A,agent.agentId))?.currentVersion).toBe(2);
});

it("counts the request mark at the rollback boundary:25 succeeds and26 refuses",async()=>{
 const {randomUUID}=await import("node:crypto");const {mergeWorld}=await import("../support/rovara-code-merge-world.js");const {ORG_A,MAX}=await import("../support/agent-session-world.js");const {ROVARA_CODE_AGENT_ID}=await import("../../packages/contracts/src/index.js");
 for(const count of [20,21]){
 const w=mergeWorld();const agent=await w.store.create({orgId:ORG_A,name:"web boundary",owner:{kind:"project",project:"web"},accountable:{developerId:MAX},extends:ROVARA_CODE_AGENT_ID,overlay:{},purpose:"process",createdBy:MAX});
 for(let n=0;n<2;n++) await w.store.publish({orgId:ORG_A,agentId:agent.agentId,expectedDraftRevision:agent.draftRevision,digest:binding.recipeDigest,by:MAX});
 const checks=Array.from({length:count},(_,n)=>({ConditionCheck:{TableName:"state",Key:{pk:`ORG#${ORG_A}#CAPACITY`,sk:String(n)},ConditionExpression:"attribute_not_exists(pk)"}}));
 const operation=w.store.rollback({orgId:ORG_A,agentId:agent.agentId,version:1,expectedCurrentVersion:2,by:MAX,modelRevisions:{companyRevision:0,sourcesRevision:0},modelAuthorityChecks:checks,request:{orgId:ORG_A,developerId:MAX,requestId:randomUUID(),fingerprint:"capacity"}});
 if(count===20) expect(await operation).toMatchObject({currentVersion:1});else await expect(operation).rejects.toThrow("transaction limit");
 }
});
