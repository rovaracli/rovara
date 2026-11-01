import {expect,it,vi} from "vitest";
import {DEFAULT_AGENT_GUARDRAILS,agentGuardrailsKey,projectLearningKey} from "@agentx/contracts";
import {makeWorld,PROJECT_CREATED} from "../support/learning-world.js";
it("B8 effective PR setting is off by default and company lock wins without deleting text",async()=>{
 const {prCaptureOff}=await import("../../packages/broker/src/learning/settings.js"),w=makeWorld();expect(await prCaptureOff(w.deps,w.scope)).toBe(true);
 w.db.set({...projectLearningKey(w.scope.orgId,w.scope.project,"SETTINGS"),projectCreatedAt:PROJECT_CREATED,prComments:"on",revision:1});expect(await prCaptureOff(w.deps,w.scope)).toBe(false);
 w.db.set({...agentGuardrailsKey(w.scope.orgId),revision:1,guardrails:{...DEFAULT_AGENT_GUARDRAILS,prCommentLearning:"locked_off"}});
 expect(await prCaptureOff(w.deps,w.scope)).toBe(true);expect(w.db.get(projectLearningKey(w.scope.orgId,w.scope.project,"SETTINGS"))?.prComments).toBe("on");
});
it("B8 a recreated project cannot inherit its previous learning setting",async()=>{
 const {prCaptureOff}=await import("../../packages/broker/src/learning/settings.js"),w=makeWorld();w.db.set({...projectLearningKey(w.scope.orgId,w.scope.project,"SETTINGS"),projectCreatedAt:"2026-09-01T00:00:00.000Z",prComments:"on",revision:1});expect(await prCaptureOff(w.deps,w.scope)).toBe(true);
});
async function approvalFixture() {
 const {orgMetaKey,orgMemberKey,developerOrgKey,projectMetaKey}=await import("@agentx/contracts"),{capturingAuditDeps}=await import("../support/audit-capture.js"),w=makeWorld(),owner="a".repeat(64),admin="b".repeat(64),audit=capturingAuditDeps({db:w.db});audit.audit.documentClient=w.db as unknown as typeof audit.audit.documentClient;
 w.db.set({...orgMetaKey(w.scope.orgId),orgId:w.scope.orgId,createdAt:PROJECT_CREATED,approvalMembershipVersion:1,approvalTrackingSince:PROJECT_CREATED});
 w.db.set({...projectMetaKey(w.scope.orgId,w.scope.project),entityType:"PROJECT_META",name:w.scope.project,status:"active",createdAt:PROJECT_CREATED,createdBy:owner});
 for(const [id,role] of [[owner,"owner"],[admin,"admin"]] as const){w.db.set({...orgMemberKey(w.scope.orgId,id),orgId:w.scope.orgId,developerId:id,role,joinedAt:PROJECT_CREATED});w.db.set({...developerOrgKey(id),orgId:w.scope.orgId,role});w.db.set({pk:`DEVELOPER#${id}`,sk:"META",developerId:id,revoked:false});}
 return {...w,owner,admin,audit,deps:{...w.deps,signInTableName:"signin",audit:audit.audit},caller:{orgId:w.scope.orgId,developerId:owner,browserSession:true as const}};
}
it("B8 enabling stays off until another live eligible person approves atomically with audit",async()=>{
 const {writeLearningSettings,decideLearningSettings}=await import("../../packages/broker/src/learning/settings.js"),f=await approvalFixture();
 const pending=await writeLearningSettings(f.deps,f.caller,f.scope.project,{expectedRevision:0,prComments:"on"});expect(pending.applied).toBe(false);if(pending.applied)throw Error("must propose");
 expect(await (await import("../../packages/broker/src/learning/settings.js")).prCaptureOff(f.deps,f.scope)).toBe(true);
 await expect(decideLearningSettings(f.deps,f.caller,f.scope.project,pending.proposalId,{decision:"approve"})).rejects.toBeDefined();
 const result=await decideLearningSettings(f.deps,{...f.caller,developerId:f.admin},f.scope.project,pending.proposalId,{decision:"approve"});expect(result.settings.prComments).toBe("on");
 const events=f.audit.recordedBy("project.learning_changed");expect(events).toHaveLength(2);expect(events.at(-1)?.facts).toMatchObject({enabled:true,selfConfirmedSoleOwner:false});
});
it("B8 off applies at once and invalidates a pending enable approval",async()=>{
 const {writeLearningSettings,decideLearningSettings}=await import("../../packages/broker/src/learning/settings.js"),f=await approvalFixture();const pending=await writeLearningSettings(f.deps,f.caller,f.scope.project,{expectedRevision:0,prComments:"on"});if(pending.applied)throw Error("must propose");
 const settings=f.db.get(projectLearningKey(f.scope.orgId,f.scope.project,"SETTINGS"));const off=await writeLearningSettings(f.deps,f.caller,f.scope.project,{expectedRevision:settings?.revision as number,prComments:"off"});expect(off.applied).toBe(true);
 await expect(decideLearningSettings(f.deps,{...f.caller,developerId:f.admin},f.scope.project,pending.proposalId,{decision:"approve"})).rejects.toBeDefined();
});
it("B8 company lock blocks approval of a pending project enable",async()=>{
 const {writeLearningSettings,decideLearningSettings}=await import("../../packages/broker/src/learning/settings.js"),f=await approvalFixture();const pending=await writeLearningSettings(f.deps,f.caller,f.scope.project,{expectedRevision:0,prComments:"on"});if(pending.applied)throw Error("must propose");
 f.db.set({...agentGuardrailsKey(f.scope.orgId),revision:1,guardrails:{...DEFAULT_AGENT_GUARDRAILS,prCommentLearning:"locked_off"}});
 await expect(decideLearningSettings(f.deps,{...f.caller,developerId:f.admin},f.scope.project,pending.proposalId,{decision:"approve"})).rejects.toBeDefined();
});

it("B8 grouping default and metric callers see company lock immediately",async()=>{
 const {prCaptureOff}=await import("../../packages/broker/src/learning/grouping.js"),w=makeWorld();w.db.set({...projectLearningKey(w.scope.orgId,w.scope.project,"SETTINGS"),projectCreatedAt:PROJECT_CREATED,prComments:"on",revision:1});
 w.db.set({...agentGuardrailsKey(w.scope.orgId),revision:1,guardrails:{...DEFAULT_AGENT_GUARDRAILS,prCommentLearning:"locked_off"}});expect(await prCaptureOff(w.deps,w.scope)).toBe(true);
});
it("B8 learning settings routes delegate the strict browser-only proposal flow",async()=>{
 const {routeLearning}=await import("../../packages/broker/src/learning/routes.js"),f=await approvalFixture();const deps={task:{} as never,projectFor:async()=>({name:f.scope.project,role:"maintainer" as const}),settings:f.deps};
 const result=await routeLearning(deps,f.caller as never,"PUT",new URL(`https://cell.example/v1/app/projects/${f.scope.project}/learning/settings`),()=>({expectedRevision:0,prComments:"on"}));expect(result).toHaveProperty("applied",false);expect(result).toHaveProperty("proposalId");
 await expect(routeLearning(deps,{...f.caller,browserSession:undefined} as never,"PUT",new URL(`https://cell.example/v1/app/projects/${f.scope.project}/learning/settings`),()=>({expectedRevision:0,prComments:"off"}))).rejects.toMatchObject({code:"FORBIDDEN"});
});
it("B8 learning page exposes the count-only skipped footer through the existing answer",async()=>{
 const {routeLearning}=await import("../../packages/broker/src/learning/routes.js"),f=await approvalFixture();f.db.set({...projectLearningKey(f.scope.orgId,f.scope.project,"SETTINGS"),projectCreatedAt:PROJECT_CREATED,prComments:"on",revision:1,changedBy:f.owner,changedAt:new Date(f.clock.ms).toISOString(),skippedUnlinked:3});
 const result=await routeLearning({task:f.deps as never,projectFor:async()=>({name:f.scope.project,role:"maintainer" as const})},f.caller as never,"GET",new URL(`https://cell.example/v1/app/projects/${f.scope.project}/learning`),()=>({}));expect(result).toMatchObject({skippedUnlinked:3});
});
for(const mode of ["expired","revoked","sole_cooloff","recreated"] as const)it(`B8 ${mode} cannot approve a pending enable`,async()=>{
 const {writeLearningSettings,decideLearningSettings}=await import("../../packages/broker/src/learning/settings.js"),{orgMemberKey,orgMetaKey,projectMetaKey}=await import("@agentx/contracts"),f=await approvalFixture();const p=await writeLearningSettings(f.deps,f.caller,f.scope.project,{expectedRevision:0,prComments:"on"});if(p.applied)throw Error("must propose");let by=f.admin;
 if(mode==="expired")f.clock.ms+=86400001;if(mode==="revoked")f.db.set({pk:`DEVELOPER#${f.admin}`,sk:"META",developerId:f.admin,revoked:true});
 if(mode==="sole_cooloff"){f.db.delete(orgMemberKey(f.scope.orgId,f.admin));const key=orgMetaKey(f.scope.orgId);f.db.set({...f.db.get(key),...key,approvalLastCompanyEligibleLossAt:new Date(f.clock.ms-3600000).toISOString()});by=f.owner;}
 if(mode==="recreated"){const key=projectMetaKey(f.scope.orgId,f.scope.project);f.db.set({...f.db.get(key),...key,createdAt:new Date(f.clock.ms+1000).toISOString()});}
 const deciding=decideLearningSettings(f.deps,{...f.caller,developerId:by},f.scope.project,p.proposalId,{decision:"approve"});if(mode==="expired")await expect(deciding).resolves.toMatchObject({settings:{prComments:"off"}});else await expect(deciding).rejects.toBeDefined();expect(f.db.get(projectLearningKey(f.scope.orgId,f.scope.project,"SETTINGS"))?.prComments).toBe("off");
});
it("B8 sole-owner exception is explicit and audited using complete shared history",async()=>{
 const {writeLearningSettings,decideLearningSettings}=await import("../../packages/broker/src/learning/settings.js"),{orgMemberKey}=await import("@agentx/contracts"),f=await approvalFixture();f.db.delete(orgMemberKey(f.scope.orgId,f.admin));const p=await writeLearningSettings(f.deps,f.caller,f.scope.project,{expectedRevision:0,prComments:"on"});if(p.applied)throw Error("must propose");
 expect((await decideLearningSettings(f.deps,f.caller,f.scope.project,p.proposalId,{decision:"approve",soleOwnerAcknowledged:true})).settings.prComments).toBe("on");expect(f.audit.recordedBy("project.learning_changed").at(-1)?.facts).toMatchObject({selfConfirmedSoleOwner:true,enabled:true});
});
it("B8 decline is terminal and retry does not duplicate the summary audit",async()=>{
 const {writeLearningSettings,decideLearningSettings}=await import("../../packages/broker/src/learning/settings.js"),f=await approvalFixture();const p=await writeLearningSettings(f.deps,f.caller,f.scope.project,{expectedRevision:0,prComments:"on"});if(p.applied)throw Error("must propose");
 const caller={...f.caller,developerId:f.admin};await decideLearningSettings(f.deps,caller,f.scope.project,p.proposalId,{decision:"decline"});await decideLearningSettings(f.deps,caller,f.scope.project,p.proposalId,{decision:"decline"});expect(f.audit.recordedBy("project.learning_changed")).toHaveLength(2);expect(f.db.get(projectLearningKey(f.scope.orgId,f.scope.project,`PROPOSAL#${p.proposalId}`))?.state).toBe("declined");
});
it("B8 settings, proposal and summary audit roll back together",async()=>{
 const {writeLearningSettings}=await import("../../packages/broker/src/learning/settings.js"),f=await approvalFixture();f.db.injectFault({command:"TransactWriteCommand",error:{name:"TransactionCanceledException"}});
 await expect(writeLearningSettings(f.deps,f.caller,f.scope.project,{expectedRevision:0,prComments:"on"})).rejects.toBeDefined();expect(f.db.get(projectLearningKey(f.scope.orgId,f.scope.project,"SETTINGS"))).toBeUndefined();expect(f.audit.recordedBy("project.learning_changed")).toHaveLength(0);
 const tx=JSON.stringify(f.db.transactions()[0]);if(tx!==undefined){expect(tx).toContain("LEARNING_SETTINGS");expect(tx).toContain("project.learning_changed");}
});
for(const mode of ["proposer","expiry"] as const)it(`B8 proposal ${mode} cannot change between evidence and commit`,async()=>{
 const {writeLearningSettings,decideLearningSettings}=await import("../../packages/broker/src/learning/settings.js"),{TransactWriteCommand}=await import("@aws-sdk/lib-dynamodb"),f=await approvalFixture();const p=await writeLearningSettings(f.deps,f.caller,f.scope.project,{expectedRevision:0,prComments:"on"});if(p.applied)throw Error("must propose");let raced=false;const key=projectLearningKey(f.scope.orgId,f.scope.project,`PROPOSAL#${p.proposalId}`);
 const deps={...f.deps,documentClient:{send:async(command:Parameters<typeof f.db.send>[0])=>{if(command instanceof TransactWriteCommand&&!raced){raced=true;f.db.set({...f.db.get(key),...key,...(mode==="proposer"?{by:"c".repeat(64)}:{expiresAt:new Date(f.clock.ms-1).toISOString()})});}return f.db.send(command);}}};
 deps.audit.documentClient=deps.documentClient as unknown as typeof deps.audit.documentClient;
 await expect(decideLearningSettings(deps,{...f.caller,developerId:f.admin},f.scope.project,p.proposalId,{decision:"approve"})).rejects.toBeDefined();expect(f.db.get(projectLearningKey(f.scope.orgId,f.scope.project,"SETTINGS"))?.prComments).toBe("off");
});
for(const state of ["missing","expired"] as const)for(const next of ["on","off"] as const)it(`B8 review I1 ${state} pending row cannot lock ${next} writes`,async()=>{
 const {writeLearningSettings}=await import("../../packages/broker/src/learning/settings.js"),f=await approvalFixture();const first=await writeLearningSettings(f.deps,f.caller,f.scope.project,{expectedRevision:0,prComments:"on"});if(first.applied)throw Error("must propose");const key=projectLearningKey(f.scope.orgId,f.scope.project,`PROPOSAL#${first.proposalId}`);
 if(state==="missing")f.db.delete(key);else f.clock.ms+=31*86400000+1;
 const result=await writeLearningSettings(f.deps,f.caller,f.scope.project,{expectedRevision:1,prComments:next});const stored=f.db.get(projectLearningKey(f.scope.orgId,f.scope.project,"SETTINGS"));
 if(next==="off"){expect(result.applied).toBe(true);expect(stored?.pendingProposalId).toBeUndefined();}else{expect(result.applied).toBe(false);if(result.applied)throw Error("must propose");expect(result.proposalId).not.toBe(first.proposalId);expect(stored?.pendingProposalId).toBe(result.proposalId);}
 expect(stored?.revision).toBe(2);if(state==="missing")expect(f.db.get(key)).toBeUndefined();else expect(f.db.get(key)?.state).toBe("cancelled");
});

for(const ack of [undefined,false])it(`B8 review M3 sole owner requires explicit acknowledgement ${String(ack)}`,async()=>{
 const {writeLearningSettings,decideLearningSettings}=await import("../../packages/broker/src/learning/settings.js"),{orgMemberKey}=await import("@agentx/contracts"),f=await approvalFixture();f.db.delete(orgMemberKey(f.scope.orgId,f.admin));const p=await writeLearningSettings(f.deps,f.caller,f.scope.project,{expectedRevision:0,prComments:"on"});if(p.applied)throw Error("must propose");
 await expect(decideLearningSettings(f.deps,f.caller,f.scope.project,p.proposalId,{decision:"approve",...(ack===undefined?{}:{soleOwnerAcknowledged:ack})})).rejects.toMatchObject({code:"FORBIDDEN"});expect(f.db.get(projectLearningKey(f.scope.orgId,f.scope.project,"SETTINGS"))?.prComments).toBe("off");
});
it("B8 review M4 no ledger refuses both setting and approval writes",async()=>{
 const {writeLearningSettings,decideLearningSettings}=await import("../../packages/broker/src/learning/settings.js"),f=await approvalFixture(),{audit:_audit,...deps}=f.deps;void _audit;
 await expect(writeLearningSettings(deps,f.caller,f.scope.project,{expectedRevision:0,prComments:"on"})).rejects.toMatchObject({code:"AUDIT_UNAVAILABLE"});expect(f.db.get(projectLearningKey(f.scope.orgId,f.scope.project,"SETTINGS"))).toBeUndefined();
 const p=await writeLearningSettings(f.deps,f.caller,f.scope.project,{expectedRevision:0,prComments:"on"});if(p.applied)throw Error("must propose");await expect(decideLearningSettings(deps,{...f.caller,developerId:f.admin},f.scope.project,p.proposalId,{decision:"approve"})).rejects.toMatchObject({code:"AUDIT_UNAVAILABLE"});
});
it("B8 review M5 already-off is a no-op without revision or audit",async()=>{
 const {writeLearningSettings}=await import("../../packages/broker/src/learning/settings.js"),f=await approvalFixture();const result=await writeLearningSettings(f.deps,f.caller,f.scope.project,{expectedRevision:0,prComments:"off"});expect(result).toMatchObject({applied:true,settings:{prComments:"off",revision:0}});expect(f.db.get(projectLearningKey(f.scope.orgId,f.scope.project,"SETTINGS"))).toBeUndefined();expect(f.audit.recordedBy("project.learning_changed")).toHaveLength(0);
});
it("B8 review M5 applied OFF survives withdrawal failure and next view retries once",async()=>{
 const {writeLearningSettings}=await import("../../packages/broker/src/learning/settings.js"),{captureCorrection}=await import("../../packages/broker/src/learning/store.js"),{groupCorrections}=await import("../../packages/broker/src/learning/grouping.js"),{signatureOf}=await import("../../packages/broker/src/learning/similarity.js"),{learningSalt}=await import("../../packages/broker/src/learning/standing.js"),{viewLearning}=await import("../../packages/broker/src/learning/view.js"),f=await approvalFixture();
 f.db.set({...projectLearningKey(f.scope.orgId,f.scope.project,"SETTINGS"),projectCreatedAt:PROJECT_CREATED,prComments:"on",revision:1,changedBy:f.owner,changedAt:new Date(f.clock.ms).toISOString()});
 for(const n of [1,2]){const text="Use the shared retry helper for all network requests with backoff.";await captureCorrection(f.deps,f.scope,{id:`retry${n}`,stage:"build",source:"pr_comment",sourceKey:`retry-${n}`,sourceRef:{taskId:`t${n}`},taskId:`t${n}`,text,signature:[...signatureOf(text,learningSalt(f.scope))],author:f.owner,standing:"member",limit:"automatic_pr"});}
 const grouped=await groupCorrections(f.deps,f.scope);expect(grouped.opened).toHaveLength(1);
 const module=await import("../../packages/broker/src/learning/grouping.js"),original=module.withdrawPrDependentSuggestions;const mocked=vi.spyOn(module,"withdrawPrDependentSuggestions").mockRejectedValueOnce(new Error("temporary read failure"));
 try{await expect(writeLearningSettings(f.deps,f.caller,f.scope.project,{expectedRevision:1,prComments:"off"})).resolves.toMatchObject({applied:true});}finally{mocked.mockRestore();}
 expect(f.db.get(projectLearningKey(f.scope.orgId,f.scope.project,"SETTINGS"))?.prComments).toBe("off");
 await viewLearning({...f.deps,projectFor:async()=>({name:f.scope.project,role:"maintainer" as const})},f.caller as never,f.scope.project);await original(f.deps,f.scope);expect(f.audit.recordedBy("rule.withdrawn")).toHaveLength(1);
});

it("B8 review M7 settings attempts stop at ten per person before project lookup",async()=>{
 const {routeLearning}=await import("../../packages/broker/src/learning/routes.js"),f=await approvalFixture(),projectFor=vi.fn(async()=>({name:f.scope.project,role:"maintainer" as const})),deps={task:f.deps as never,projectFor,settings:f.deps};
 const call=()=>routeLearning(deps,f.caller as never,"PUT",new URL(`https://cell.example/v1/app/projects/${f.scope.project}/learning/settings`),()=>({bad:true}));
 for(let n=0;n<10;n++)await expect(call()).rejects.toMatchObject({code:"CONFIG_INVALID"});await expect(call()).rejects.toMatchObject({code:"TOO_MANY_REQUESTS"});expect(projectFor).toHaveBeenCalledTimes(10);
});
it("B8 review M7 settings attempts stop at sixty across company people",async()=>{
 const {routeLearning}=await import("../../packages/broker/src/learning/routes.js"),f=await approvalFixture(),deps={task:f.deps as never,projectFor:async()=>({name:f.scope.project,role:"maintainer" as const}),settings:f.deps};
 const call=(id:string)=>routeLearning(deps,{...f.caller,developerId:id} as never,"PUT",new URL(`https://cell.example/v1/app/projects/${f.scope.project}/learning/settings`),()=>({bad:true}));
 for(const hex of ["a","b","c","d","e","f"])for(let n=0;n<10;n++)await expect(call(hex.repeat(64))).rejects.toMatchObject({code:"CONFIG_INVALID"});await expect(call("1".repeat(64))).rejects.toMatchObject({code:"TOO_MANY_REQUESTS"});
});
for(const kind of ["missing","expired"] as const)it(`B8 review I1 ${kind} pending decision clears only its cancelled pointer`,async()=>{
 const {writeLearningSettings,decideLearningSettings}=await import("../../packages/broker/src/learning/settings.js"),f=await approvalFixture();const p=await writeLearningSettings(f.deps,f.caller,f.scope.project,{expectedRevision:0,prComments:"on"});if(p.applied)throw Error("must propose");
 if(kind==="missing")f.db.delete(projectLearningKey(f.scope.orgId,f.scope.project,`PROPOSAL#${p.proposalId}`));else f.clock.ms+=86400001;
 const answer=await decideLearningSettings(f.deps,{...f.caller,developerId:f.admin},f.scope.project,p.proposalId,{decision:"approve"});expect(answer.settings.prComments).toBe("off");expect(answer.settings).not.toHaveProperty("pendingProposal");expect(f.db.get(projectLearningKey(f.scope.orgId,f.scope.project,"SETTINGS"))?.pendingProposalId).toBeUndefined();
});
for(const kind of ["missing","expired"] as const)it(`B8 review I1 view does not advertise ${kind} pending approval`,async()=>{
 const {writeLearningSettings}=await import("../../packages/broker/src/learning/settings.js"),{routeLearning}=await import("../../packages/broker/src/learning/routes.js"),f=await approvalFixture();const p=await writeLearningSettings(f.deps,f.caller,f.scope.project,{expectedRevision:0,prComments:"on"});if(p.applied)throw Error("must propose");
 if(kind==="missing")f.db.delete(projectLearningKey(f.scope.orgId,f.scope.project,`PROPOSAL#${p.proposalId}`));else f.clock.ms+=86400001;
 const answer=await routeLearning({task:f.deps as never,audit:f.audit.audit,projectFor:async()=>({name:f.scope.project,role:"maintainer" as const})},f.caller as never,"GET",new URL(`https://cell.example/v1/app/projects/${f.scope.project}/learning`),()=>({}));expect(answer).toMatchObject({settings:{prComments:"off",revision:1}});expect(answer).not.toHaveProperty("settings.pendingProposal");
});
