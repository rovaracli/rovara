import {expect,it} from "vitest";
import {randomUUID} from "node:crypto";
import {publishDraft,rollbackAgent} from "../../packages/broker/src/agents/changes.js";
import {projectRevisionKey,ROVARA_CODE_AGENT_ID} from "../../packages/contracts/src/index.js";
import {bedrockClaudeModelIds} from "../../packages/model-runtime/src/catalog.js";
import {mergeWorld} from "../support/rovara-code-merge-world.js";
import {ORG_A,MAX,OLA} from "../support/agent-session-world.js";
function fixture(){
 const w=mergeWorld();w.db.set({...projectRevisionKey(ORG_A,"web",1),registeredAt:"2026-10-01T00:00:00Z",definition:{name:"web",revision:1,repositories:[{name:"web",url:"https://github.com/acme/web.git",path:"repo/web",defaultBranch:"main",credentialRef:"github-app"}],setup:[],readiness:[],orchestratorInstructions:"Delegate work."}});
 return w;
}
it("refuses an unavailable explicit process model before publication",async()=>{
 const w=fixture();
 const model={provider:"amazon-bedrock",modelId:bedrockClaudeModelIds("us")[0]!};
 const agent=await w.store.create({orgId:ORG_A,name:"web process",owner:{kind:"project",project:"web"},accountable:{developerId:MAX},extends:ROVARA_CODE_AGENT_ID,overlay:{steps:{plan:{model}}},purpose:"process",createdBy:MAX});
 Object.assign(w.deps,{modelRouting:{sources:{read:async()=>({sources:[],order:[],credentials:[],removing:[],revision:0})}}});
 await expect(publishDraft(w.deps,{...w.caller(MAX),orgRole:"member"},agent,{requestId:randomUUID(),expectedRevision:agent.draftRevision})).rejects.toMatchObject({code:"MODEL_NOT_VERIFIED",stage:"understand",fixHref:"/app/admin/models/sources"});
 expect(await w.store.getVersion(ORG_A,agent.agentId,1)).toBeUndefined();
});

it("preserves no-choice publication with current source and policy revision checks",async()=>{
 const w=fixture();const agent=await w.store.create({orgId:ORG_A,name:"web process",owner:{kind:"project",project:"web"},accountable:{developerId:MAX},extends:ROVARA_CODE_AGENT_ID,overlay:{},purpose:"process",createdBy:MAX});
 expect(await publishDraft(w.deps,{...w.caller(MAX),orgRole:"member"},agent,{requestId:randomUUID(),expectedRevision:agent.draftRevision})).toMatchObject({applied:true,value:{version:1}});
});

it("asks before same-model review and stores proof only after another person's confirmation",async()=>{
 const {decideApproval}=await import("../../packages/broker/src/agents/approvals.js");
 const w=fixture();const model={provider:"amazon-bedrock",modelId:bedrockClaudeModelIds("us")[0]!};
 const agent=await w.store.create({orgId:ORG_A,name:"web same model",owner:{kind:"project",project:"web"},accountable:{developerId:MAX},extends:ROVARA_CODE_AGENT_ID,overlay:{steps:{build:{model},review:{model}}},purpose:"process",createdBy:MAX});
 const waiting=await publishDraft(w.deps,{...w.caller(MAX),orgRole:"member"},agent,{requestId:randomUUID(),expectedRevision:agent.draftRevision});
 expect(waiting.applied).toBe(false);if(waiting.applied) throw Error("expected pending");
 expect(await w.store.getVersion(ORG_A,agent.agentId,1)).toBeUndefined();
 const approvalId=w.approvalIdOf(waiting.confirmUrl);
 await decideApproval(w.deps,{...w.caller(OLA),orgRole:"admin"},approvalId,{requestId:randomUUID(),decision:"APPROVE"});
 expect((await w.store.getVersion(ORG_A,agent.agentId,1))?.modelApproval).toMatchObject({approvalId,companyRevision:0,agentId:agent.agentId,exceptions:[{stage:"code_review",model,referenceModel:model},{stage:"security_review",model,referenceModel:model}]});
 await w.store.saveDraft({orgId:ORG_A,agentId:agent.agentId,expectedRevision:agent.draftRevision,overlay:{},by:MAX});
 let live=(await w.store.get(ORG_A,agent.agentId))!;
 const next=await publishDraft(w.deps,{...w.caller(MAX),orgRole:"member"},live,{requestId:randomUUID(),expectedRevision:live.draftRevision});
 if(!next.applied) await decideApproval(w.deps,{...w.caller(OLA),orgRole:"admin"},w.approvalIdOf(next.confirmUrl),{requestId:randomUUID(),decision:"APPROVE"});
 live=(await w.store.get(ORG_A,agent.agentId))!;expect(live.currentVersion).toBe(2);
 const rollback=await rollbackAgent(w.deps,{...w.caller(MAX),orgRole:"member"},live,{requestId:randomUUID(),version:1});
 if(!rollback.applied) expect(await decideApproval(w.deps,{...w.caller(OLA),orgRole:"admin"},w.approvalIdOf(rollback.confirmUrl),{requestId:randomUUID(),decision:"APPROVE"})).toMatchObject({status:"APPROVED_DONE"});
 expect((await w.store.get(ORG_A,agent.agentId))?.currentVersion).toBe(1);
 expect((await w.store.getVersion(ORG_A,agent.agentId,1))?.modelApproval?.approvalId).toBe(approvalId);
});

it("refuses confirmation after policy revision or project identity changes",async()=>{
 const {decideApproval}=await import("../../packages/broker/src/agents/approvals.js");
 for(const kind of ["policy","project"] as const){
  const w=fixture();const model={provider:"amazon-bedrock",modelId:bedrockClaudeModelIds("us")[0]!};
  const agent=await w.store.create({orgId:ORG_A,name:"web same model",owner:{kind:"project",project:"web"},accountable:{developerId:MAX},extends:ROVARA_CODE_AGENT_ID,overlay:{steps:{build:{model},review:{model}}},purpose:"process",createdBy:MAX});
  const waiting=await publishDraft(w.deps,{...w.caller(MAX),orgRole:"member"},agent,{requestId:randomUUID(),expectedRevision:agent.draftRevision});if(waiting.applied) throw Error("expected pending");
  if(kind==="policy") w.db.set({pk:`ORG#${ORG_A}#SETTINGS`,sk:"MODEL_SELECTION_POLICY",orgId:ORG_A,entityType:"MODEL_SELECTION_POLICY",version:1,revision:1,rankingVersion:"g3-v1",stepOverrides:{}});
  else {const key=projectRevisionKey(ORG_A,"web",1);const row=w.db.find(row=>row.pk===key.pk&&row.sk===key.sk)[0]!;w.db.set({...row,registeredAt:"2026-10-29T00:00:00Z"});}
  expect(await decideApproval(w.deps,{...w.caller(OLA),orgRole:"admin"},w.approvalIdOf(waiting.confirmUrl),{requestId:randomUUID(),decision:"APPROVE"})).toMatchObject({status:"APPROVED_FAILED"});
  expect(await w.store.getVersion(ORG_A,agent.agentId,1)).toBeUndefined();
 }
});

it("refuses rollback to an explicit model whose source is now unavailable",async()=>{
 const {resolveRecipe}=await import("../../packages/broker/src/agents/changes.js");const {recipeDigest}=await import("../../packages/contracts/src/index.js");
 const w=fixture();const model={provider:"amazon-bedrock",modelId:bedrockClaudeModelIds("us")[0]!};
 let agent=await w.store.create({orgId:ORG_A,name:"web rollback",owner:{kind:"project",project:"web"},accountable:{developerId:MAX},extends:ROVARA_CODE_AGENT_ID,overlay:{steps:{plan:{model}}},purpose:"process",createdBy:MAX});
 await w.store.publish({orgId:ORG_A,agentId:agent.agentId,expectedDraftRevision:agent.draftRevision,digest:recipeDigest(await resolveRecipe(w.deps,ORG_A,agent.agentId,"draft")),by:MAX});
 await w.store.saveDraft({orgId:ORG_A,agentId:agent.agentId,expectedRevision:agent.draftRevision,overlay:{},by:MAX});agent=(await w.store.get(ORG_A,agent.agentId))!;
 await w.store.publish({orgId:ORG_A,agentId:agent.agentId,expectedDraftRevision:agent.draftRevision,digest:recipeDigest(await resolveRecipe(w.deps,ORG_A,agent.agentId,"draft")),by:MAX});agent=(await w.store.get(ORG_A,agent.agentId))!;
 Object.assign(w.deps,{modelRouting:{sources:{read:async()=>({sources:[],order:[],credentials:[],removing:[],revision:0})}}});
 await expect(rollbackAgent(w.deps,{...w.caller(MAX),orgRole:"member"},agent,{requestId:randomUUID(),version:1})).rejects.toMatchObject({code:"MODEL_NOT_VERIFIED",stage:"understand",fixHref:"/app/admin/models/sources"});
 expect((await w.store.get(ORG_A,agent.agentId))?.currentVersion).toBe(2);
});

it("fences project, native operator-role and global revocations after validation",async()=>{
 const {TransactWriteCommand}=await import("@aws-sdk/lib-dynamodb");const {projectMemberKey}=await import("../../packages/contracts/src/index.js");
 for(const kind of ["projectRole","nativeRole","global"] as const){
 const w=fixture();const agent=await w.store.create({orgId:ORG_A,name:"web race",owner:{kind:"project",project:"web"},accountable:{developerId:MAX},extends:ROVARA_CODE_AGENT_ID,overlay:{},purpose:"process",createdBy:MAX});
 const send=w.db.send.bind(w.db);let changed=false;
 w.db.send=async(command)=>{if(!changed&&command instanceof TransactWriteCommand&&command.input.TransactItems?.some(item=>item.Put?.Item?.entityType==="AGENT_VERSION")){changed=true;const key=kind==="global"?{pk:`DEVELOPER#${MAX}`,sk:"META"}:projectMemberKey(ORG_A,MAX,"web");w.db.set({...w.db.get(key)!,...(kind==="global"?{revoked:true}:kind==="nativeRole"?{role:"viewer"}:{projectRole:"viewer"})});}return send(command);};
 await expect(publishDraft(w.deps,{...w.caller(MAX),orgRole:"member"},agent,{requestId:randomUUID(),expectedRevision:agent.draftRevision})).rejects.toThrow("access changed");
 expect(changed).toBe(true);expect(await w.store.getVersion(ORG_A,agent.agentId,1)).toBeUndefined();
 }
});

it("fences the confirming person's global revocation at the final version commit",async()=>{
 const {decideApproval}=await import("../../packages/broker/src/agents/approvals.js");const {TransactWriteCommand}=await import("@aws-sdk/lib-dynamodb");
 const w=fixture();const agent=await w.store.create({orgId:ORG_A,name:"web confirm race",owner:{kind:"project",project:"web"},accountable:{developerId:MAX},extends:ROVARA_CODE_AGENT_ID,overlay:{steps:{review:{instructions:"Check carefully."}}},purpose:"process",createdBy:MAX});
 const waiting=await publishDraft(w.deps,{...w.caller(MAX),orgRole:"member"},agent,{requestId:randomUUID(),expectedRevision:agent.draftRevision});if(waiting.applied) throw Error("expected pending");
 const send=w.db.send.bind(w.db);let changed=false;
 w.db.send=async(command)=>{if(!changed&&command instanceof TransactWriteCommand&&command.input.TransactItems?.some(item=>item.Put?.Item?.entityType==="AGENT_VERSION")){changed=true;const key={pk:`DEVELOPER#${OLA}`,sk:"META"};w.db.set({...w.db.get(key)!,revoked:true});}return send(command);};
 expect(await decideApproval(w.deps,{...w.caller(OLA),orgRole:"admin"},w.approvalIdOf(waiting.confirmUrl),{requestId:randomUUID(),decision:"APPROVE"})).toMatchObject({status:"APPROVED_FAILED"});
 expect(changed).toBe(true);expect(await w.store.getVersion(ORG_A,agent.agentId,1)).toBeUndefined();
});
it("shares native current-role and maintainer transaction fences for project model selection",async()=>{
 const {projectModelSelectionAuthorityChecks}=await import("../../packages/broker/src/model-selection/authority.js");
 const {TransactWriteCommand}=await import("@aws-sdk/lib-dynamodb");const {projectMemberKey}=await import("../../packages/contracts/src/index.js");
 const w=fixture(),input={orgId:ORG_A,project:"web",registeredAt:"2026-10-01T00:00:00Z",signedInId:MAX,developerId:MAX};
 const checks=await projectModelSelectionAuthorityChecks(w.deps,input);
 await w.db.send(new TransactWriteCommand({TransactItems:checks}));
 const key=projectMemberKey(ORG_A,MAX,"web"),grant=w.db.get(key)!;w.db.set({...grant,projectRole:"viewer",role:"viewer"});
 await expect(w.db.send(new TransactWriteCommand({TransactItems:checks}))).rejects.toThrow();
 await expect(projectModelSelectionAuthorityChecks(w.deps,input)).rejects.toThrow("FORBIDDEN");
});
for(const role of ["owner","admin","maintainer","contributor","viewer"] as const)it(`project model selection uses live ${role} authority`,async()=>{
 const {projectModelSelectionAuthorityChecks}=await import("../../packages/broker/src/model-selection/authority.js");
 const {TransactWriteCommand}=await import("@aws-sdk/lib-dynamodb");const {projectMemberKey,orgMemberKey,developerOrgKey}=await import("../../packages/contracts/src/index.js");
 const w=fixture(),orgRole=role==="owner"||role==="admin"?role:"member";
 for(const key of [orgMemberKey(ORG_A,MAX),developerOrgKey(MAX)])w.db.set({...w.db.get(key)!,role:orgRole});
 const key=projectMemberKey(ORG_A,MAX,"web");w.db.set({...w.db.get(key)!,role:role==="viewer"?"viewer":"developer",projectRole:role==="owner"||role==="admin"?"contributor":role});
 const operation=projectModelSelectionAuthorityChecks(w.deps,{orgId:ORG_A,project:"web",registeredAt:"2026-10-01T00:00:00Z",signedInId:MAX,developerId:MAX});
 if(role==="owner"||role==="admin"||role==="maintainer")await w.db.send(new TransactWriteCommand({TransactItems:await operation}));else await expect(operation).rejects.toThrow("FORBIDDEN");
});

it("does not publish an implicit same-model reviewer when only the builder's model is allowed",async()=>{
 const w=fixture(),model={provider:"amazon-bedrock",modelId:"us.anthropic.claude-sonnet-4-6"};
 const key=projectRevisionKey(ORG_A,"web",1),row=w.db.get(key)!;
 w.db.set({...row,definition:{...(row.definition as Record<string,unknown>),models:{default:model,approved:[model]}}});
 const agent=await w.store.create({orgId:ORG_A,name:"web single model",owner:{kind:"project",project:"web"},accountable:{developerId:MAX},extends:ROVARA_CODE_AGENT_ID,overlay:{},purpose:"process",createdBy:MAX});
 await expect(publishDraft(w.deps,{...w.caller(MAX),orgRole:"member"},agent,{requestId:randomUUID(),expectedRevision:agent.draftRevision})).rejects.toMatchObject({code:"DIFFERENT_FROM_UNSATISFIABLE",stage:"plan_check",fixHref:"/app/admin/how-we-work"});
 expect(await w.store.getVersion(ORG_A,agent.agentId,1)).toBeUndefined();
});

it("exports the single pointer-path model assertion with the same structured refusal",async()=>{
 const changes=await import("../../packages/broker/src/agents/changes.js");
 const wrapper=changes.assertProcessModelsResolvable;
 expect(wrapper).toBeTypeOf("function");
 const w=fixture(),model={provider:"amazon-bedrock",modelId:bedrockClaudeModelIds("us")[0]!};
 const agent=await w.store.create({orgId:ORG_A,name:"web pointer",owner:{kind:"project",project:"web"},accountable:{developerId:MAX},extends:ROVARA_CODE_AGENT_ID,overlay:{steps:{plan:{model}}},purpose:"process",createdBy:MAX});
 const draft=(await w.store.getDraft(ORG_A,agent.agentId))!;
 const recipe=await changes.resolveRecipe(w.deps,ORG_A,agent.agentId,"draft",draft);
 await expect(wrapper(w.deps,{...w.caller(MAX),orgRole:"member"},agent,draft,recipe)).resolves.toMatchObject({modelRevisions:{companyRevision:0,sourcesRevision:0}});
 Object.assign(w.deps,{modelRouting:{sources:{read:async()=>({sources:[],order:[],credentials:[],removing:[],revision:0})}}});
 await expect(wrapper(w.deps,{...w.caller(MAX),orgRole:"member"},agent,draft,recipe)).rejects.toMatchObject({code:"MODEL_NOT_VERIFIED",stage:"understand",fixHref:"/app/admin/models/sources"});
});

it("serializes only the structured process refusal fields used by HTTP adapters",async()=>{
 const {ProcessModelRefusal,processModelRefusalBody}=await import("../../packages/broker/src/model-selection/process-refusal.js");
 const error=new ProcessModelRefusal("STAGE_LOCKED","build","/app/admin/how-we-work");
 expect(error.statusCode).toBe(409);
 expect(processModelRefusalBody(error)).toEqual({code:"STAGE_LOCKED",stage:"build",fixHref:"/app/admin/how-we-work",message:"build: STAGE_LOCKED"});
});

for(const changed of [false,true])it(`${changed?"refuses changed":"tolerates unchanged"} published choice beneath a newly locked company stage`,async()=>{
 const {resolveRecipe}=await import("../../packages/broker/src/agents/changes.js");
 const {recipeDigest,canonicalModelName}=await import("@agentx/contracts");
 const w=fixture(),seen=new Set<string>(),models=bedrockClaudeModelIds("us").filter(modelId=>{const name=canonicalModelName({provider:"amazon-bedrock",modelId});if(seen.has(name))return false;seen.add(name);return true;});
 expect(models.length).toBeGreaterThanOrEqual(3);
 const model={provider:"amazon-bedrock",modelId:models[0]!},lock={provider:"amazon-bedrock",modelId:models[1]!};
 let agent=await w.store.create({orgId:ORG_A,name:"web locked publication",owner:{kind:"project",project:"web"},accountable:{developerId:MAX},extends:ROVARA_CODE_AGENT_ID,overlay:{steps:{build:{model}}},purpose:"process",createdBy:MAX});
 await w.store.publish({orgId:ORG_A,agentId:agent.agentId,expectedDraftRevision:agent.draftRevision,digest:recipeDigest(await resolveRecipe(w.deps,ORG_A,agent.agentId,"draft")),by:MAX});
 await w.store.saveDraft({orgId:ORG_A,agentId:agent.agentId,expectedRevision:agent.draftRevision,overlay:{steps:{build:{model:changed?{provider:"amazon-bedrock",modelId:models[2]!}:model,instructions:"Include the unrelated documentation update."}}},by:MAX});
 agent=(await w.store.get(ORG_A,agent.agentId))!;
 w.db.set({pk:`ORG#${ORG_A}#SETTINGS`,sk:"MODEL_SELECTION_POLICY",entityType:"MODEL_SELECTION_POLICY",orgId:ORG_A,version:1,revision:1,rankingVersion:"g3-v1",stepOverrides:{build:{model:lock,thinkingLevel:null,locked:true}}});
 const action=publishDraft(w.deps,{...w.caller(MAX),orgRole:"member"},agent,{requestId:randomUUID(),expectedRevision:agent.draftRevision});
 if(changed)await expect(action).rejects.toMatchObject({code:"STAGE_LOCKED",stage:"build"});
 else { const result=await action;expect(typeof result.applied).toBe("boolean"); }
});
