import {expect,it} from "vitest";
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
 const {orgMetaKey,orgMemberKey,developerOrgKey,projectMetaKey}=await import("@agentx/contracts"),{capturingAuditDeps}=await import("../support/audit-capture.js"),w=makeWorld(),owner="a".repeat(64),admin="b".repeat(64),audit=capturingAuditDeps({db:w.db});
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
 await expect(decideLearningSettings(f.deps,{...f.caller,developerId:by},f.scope.project,p.proposalId,{decision:"approve"})).rejects.toBeDefined();expect(f.db.get(projectLearningKey(f.scope.orgId,f.scope.project,"SETTINGS"))?.prComments).toBe("off");
});
it("B8 sole-owner exception is explicit and audited using complete shared history",async()=>{
 const {writeLearningSettings,decideLearningSettings}=await import("../../packages/broker/src/learning/settings.js"),{orgMemberKey}=await import("@agentx/contracts"),f=await approvalFixture();f.db.delete(orgMemberKey(f.scope.orgId,f.admin));const p=await writeLearningSettings(f.deps,f.caller,f.scope.project,{expectedRevision:0,prComments:"on"});if(p.applied)throw Error("must propose");
 expect((await decideLearningSettings(f.deps,f.caller,f.scope.project,p.proposalId,{decision:"approve"})).settings.prComments).toBe("on");expect(f.audit.recordedBy("project.learning_changed").at(-1)?.facts).toMatchObject({selfConfirmedSoleOwner:true,enabled:true});
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
 const deps={...f.deps,documentClient:{send:async(command:unknown)=>{if(command instanceof TransactWriteCommand&&!raced){raced=true;f.db.set({...f.db.get(key),...key,...(mode==="proposer"?{by:"c".repeat(64)}:{expiresAt:new Date(f.clock.ms-1).toISOString()})});}return f.db.send(command);}}};
 await expect(decideLearningSettings(deps,{...f.caller,developerId:f.admin},f.scope.project,p.proposalId,{decision:"approve"})).rejects.toBeDefined();expect(f.db.get(projectLearningKey(f.scope.orgId,f.scope.project,"SETTINGS"))?.prComments).toBe("off");
});
