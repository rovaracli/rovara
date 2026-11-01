import { expect, it } from "vitest";
import { agentGuardrailsKey, githubMemberKey, orgMemberKey, orgMetaKey, projectMetaKey, projectLearningKey, DEFAULT_AGENT_GUARDRAILS } from "@agentx/contracts";
import { makeWorld, PROJECT_CREATED } from "../support/learning-world.js";
import type { GitHubFeedbackComment } from "../../packages/broker/src/github-app.js";
const person = "a".repeat(64);
function fixture(on = true) {
 const w = makeWorld();w.db.set({...orgMetaKey(w.scope.orgId),orgId:w.scope.orgId,createdAt:PROJECT_CREATED});w.db.set({ ...projectMetaKey(w.scope.orgId, w.scope.project), entityType: "PROJECT_META", name: w.scope.project, orgId: w.scope.orgId, status: "active", createdAt: PROJECT_CREATED, createdBy: person });
 w.db.set({ ...orgMemberKey(w.scope.orgId, person), orgId: w.scope.orgId, developerId: person, role: "owner" });
 w.db.set({ ...githubMemberKey(w.scope.orgId, "123"), entityType: "GITHUB_MEMBER", orgId: w.scope.orgId, githubUserId: "123", developerId: person });
 if(on)w.db.set({ ...projectLearningKey(w.scope.orgId,w.scope.project,"SETTINGS"),projectCreatedAt:PROJECT_CREATED,prComments:"on",revision:1 });
 const comment = (id = 1): GitHubFeedbackComment & { authorId?: string; authorType?: string } => ({ id:`review_comment:${id}`,kind:"REVIEW_COMMENT",url:`https://github.com/acme/web/pull/1#discussion_r${id}`,author:"member",authorId:"123",authorType:"User",updatedAt:new Date(w.clock.ms).toISOString(),body:"Use the shared retry helper for every network request." });
 const input = { task:{taskId:"task1",orgId:w.scope.orgId,project:w.scope.project},installationOrgId:w.scope.orgId,repositoryId:"repo1",comments:[comment()] };
 return {...w,comment,input};
}
it("B8 captures only when the project opts in and the company allows it",async()=>{
 const {capturePullRequestCorrections}=await import("../../packages/broker/src/learning/capture-pr.js");
 for(const mode of ["default","locked","foreign"]){const f=fixture(mode!=="default");if(mode==="locked")f.db.set({...agentGuardrailsKey(f.scope.orgId),revision:1,guardrails:{...DEFAULT_AGENT_GUARDRAILS,prCommentLearning:"locked_off"}});if(mode==="foreign")f.input.installationOrgId="org_bbbbbbbbbbbbbbbbbbbb";
 expect((await capturePullRequestCorrections(f.deps,f.input)).captured).toBe(0);}
 const f=fixture();expect((await capturePullRequestCorrections(f.deps,f.input)).captured).toBe(1);
});
for(const mode of ["missing_id","login_reuse","bot_type","bot_login","left","no_grant"] as const)it(`B8 I2 ${mode} authors never store a correction`,async()=>{
 const {capturePullRequestCorrections}=await import("../../packages/broker/src/learning/capture-pr.js"),f=fixture(),c=f.input.comments[0]!;
 if(mode==="missing_id")delete c.authorId;if(mode==="login_reuse")c.authorId="456";if(mode==="bot_type")c.authorType="Bot";if(mode==="bot_login")c.author="rovara[bot]";
 if(mode==="left")f.db.delete(orgMemberKey(f.scope.orgId,person));if(mode==="no_grant")f.db.set({...orgMemberKey(f.scope.orgId,person),orgId:f.scope.orgId,developerId:person,role:"member"});
 expect((await capturePullRequestCorrections(f.deps,f.input)).captured).toBe(0);
});
it("B8 caps new captures per delivery, redacts inert text, and replaces ungrouped edits",async()=>{
 const {capturePullRequestCorrections}=await import("../../packages/broker/src/learning/capture-pr.js"),f=fixture();f.input.comments=Array.from({length:25},(_,i)=>f.comment(i+1));expect((await capturePullRequestCorrections(f.deps,f.input)).captured).toBe(20);
 f.input.comments=[{...f.comment(),body:"~~~suggestion\nunsafe replacement\n~~~\n> quoted attack\nKeep all network retries inside the shared client wrapper."}];expect((await capturePullRequestCorrections(f.deps,f.input)).updated).toBe(1);expect(f.db.find(row=>row.entityType==="LEARNING_CORRECTION")[0]?.text).not.toMatch(/unsafe replacement|quoted attack|~~~/);expect((await capturePullRequestCorrections(f.deps,f.input)).updated).toBe(0);
});
it("B8 fifty PR captures per day is a hard cap across deliveries",async()=>{
 const {capturePullRequestCorrections}=await import("../../packages/broker/src/learning/capture-pr.js"),f=fixture();
 for(const start of [1,21,41]){f.input.comments=Array.from({length:20},(_,i)=>f.comment(start+i));expect((await capturePullRequestCorrections(f.deps,f.input)).captured).toBe(start===41?10:20);}
 f.input.comments=[f.comment(61)];expect((await capturePullRequestCorrections(f.deps,f.input)).captured).toBe(0);
});
it("B8 grouped corrections keep their original text when a PR comment is edited",async()=>{
 const {capturePullRequestCorrections}=await import("../../packages/broker/src/learning/capture-pr.js"),f=fixture();await capturePullRequestCorrections(f.deps,f.input);
 const c=f.db.find(row=>row.entityType==="LEARNING_CORRECTION")[0]!;f.db.set({...c,suggestionId:"suggestion1"});f.input.comments=[{...f.comment(),body:"Keep endpoint authorization checks inside the shared controller."}];
 expect((await capturePullRequestCorrections(f.deps,f.input)).updated).toBe(0);expect(f.db.get({pk:c.pk as string,sk:c.sk as string})?.text).toBe("Use the shared retry helper for every network request.");
});
it("B8 the pr_daily_cap pre-check reads DAILY once and never recounts a full store",async()=>{
 const {captureCorrection}=await import("../../packages/broker/src/learning/store.js"),f=fixture();const {GetCommand,QueryCommand}=await import("@aws-sdk/lib-dynamodb");
 f.db.set({...projectLearningKey(f.scope.orgId,f.scope.project,"STATE"),entityType:"LEARNING_STATE",orgId:f.scope.orgId,projectCreatedAt:PROJECT_CREATED,revision:0,openSuggestions:0,liveCorrections:2000,pendingRules:0});
 const daily=projectLearningKey(f.scope.orgId,f.scope.project,`DAILY#${new Date(f.clock.ms).toISOString().slice(0,10)}#${Math.floor(Date.parse(PROJECT_CREATED)/1000)}`);f.db.set({...daily,prCount:50,autoCount:50});let dailyReads=0,queries=0;
 const deps={...f.deps,documentClient:{send:async(command:unknown)=>{if(command instanceof GetCommand&&command.input.Key?.sk===daily.sk)dailyReads++;if(command instanceof QueryCommand)queries++;return f.db.send(command);}}};
 expect(await captureCorrection(deps,f.scope,{id:"dailycap",stage:"build",source:"pr_comment",sourceKey:"cap-source",sourceRef:{taskId:"task1"},taskId:"task1",text:"Use the shared retry helper for network requests.",signature:["h"],author:person,standing:"member",limit:"automatic_pr"})).toEqual({ok:false,reason:"pr_daily_cap"});expect(dailyReads).toBe(1);expect(queries).toBe(0);
});
it("B8 a project off write racing capture prevents the correction transaction",async()=>{
 const {capturePullRequestCorrections}=await import("../../packages/broker/src/learning/capture-pr.js"),{TransactWriteCommand}=await import("@aws-sdk/lib-dynamodb"),f=fixture();let raced=false;
 const deps={...f.deps,documentClient:{send:async(command:unknown)=>{if(command instanceof TransactWriteCommand&&!raced){raced=true;f.db.set({...projectLearningKey(f.scope.orgId,f.scope.project,"SETTINGS"),projectCreatedAt:PROJECT_CREATED,prComments:"off",revision:2});}return f.db.send(command);}}};
 await capturePullRequestCorrections(deps,f.input).catch(()=>undefined);expect(raced).toBe(true);expect(f.db.find(row=>row.entityType==="LEARNING_CORRECTION")).toEqual([]);
});
it("B8 a contributor grant reduced during capture cannot store member feedback",async()=>{
 const {capturePullRequestCorrections}=await import("../../packages/broker/src/learning/capture-pr.js"),{projectMemberKey}=await import("@agentx/contracts"),{TransactWriteCommand}=await import("@aws-sdk/lib-dynamodb"),f=fixture();
 f.db.set({...orgMemberKey(f.scope.orgId,person),orgId:f.scope.orgId,developerId:person,role:"member"});const key=projectMemberKey(f.scope.orgId,person,f.scope.project);f.db.set({...key,role:"developer",projectRole:"contributor",ownerKey:person,projectName:f.scope.project,grantId:"grant1"});let raced=false;
 const deps={...f.deps,documentClient:{send:async(command:unknown)=>{if(command instanceof TransactWriteCommand&&!raced){raced=true;f.db.set({...key,role:"developer",projectRole:"viewer",ownerKey:person,projectName:f.scope.project,grantId:"grant1"});}return f.db.send(command);}}};
 await capturePullRequestCorrections(deps,f.input).catch(()=>undefined);expect(raced).toBe(true);expect(f.db.find(row=>row.entityType==="LEARNING_CORRECTION")).toEqual([]);
});
it("B8 a closing company cannot capture more PR correction text",async()=>{
 const {capturePullRequestCorrections}=await import("../../packages/broker/src/learning/capture-pr.js"),{orgMetaKey}=await import("@agentx/contracts"),f=fixture();f.db.set({...orgMetaKey(f.scope.orgId),orgId:f.scope.orgId,closingAt:new Date(f.clock.ms).toISOString()});
 expect((await capturePullRequestCorrections(f.deps,f.input)).captured).toBe(0);
});
it("B8 PR captures run existing grouping and preserve edits until a suggestion uses the source",async()=>{
 const {capturePullRequestCorrections}=await import("../../packages/broker/src/learning/capture-pr.js"),f=fixture();await capturePullRequestCorrections(f.deps,f.input);
 expect(f.db.find(r=>r.entityType==="LEARNING_CORRECTION")[0]?.groupedAt).toBeTypeOf("string");
 f.input.comments=[{...f.comment(),body:"Keep authentication checks inside the shared controller boundary."}];expect((await capturePullRequestCorrections(f.deps,f.input)).updated).toBe(1);
 const {readMetric,metricMonth}=await import("../../packages/broker/src/learning/metric.js");expect((await readMetric(f.deps,f.scope,metricMonth(new Date(f.clock.ms).toISOString()),{prCaptureOff:false})).memberCorrections).toBe(1);
});
it("B8 capture supplies the ledger to grouping, without per-capture audits",async()=>{
 const {capturePullRequestCorrections}=await import("../../packages/broker/src/learning/capture-pr.js"),{capturingAuditDeps}=await import("../support/audit-capture.js"),f=fixture(),audit=capturingAuditDeps({db:f.db}),deps={...f.deps,audit:audit.audit};
 await capturePullRequestCorrections(deps,f.input);f.input.task.taskId="task2";f.input.comments=[f.comment(2)];await capturePullRequestCorrections(deps,f.input);
 expect(audit.recordedBy("rule.suggested")).toHaveLength(1);expect(audit.recordedBy("rule.correction_remembered")).toHaveLength(0);
});
it("B8 a shared delivery budget caps captures across every linked repository",async()=>{
 const {capturePullRequestCorrections}=await import("../../packages/broker/src/learning/capture-pr.js"),f=fixture(),budget={remaining:20,skipped:0};f.input.comments=Array.from({length:15},(_,i)=>f.comment(i+1));expect((await capturePullRequestCorrections(f.deps,{...f.input,budget})).captured).toBe(15);
 f.input.repositoryId="repo2";f.input.comments=Array.from({length:15},(_,i)=>f.comment(i+101));expect((await capturePullRequestCorrections(f.deps,{...f.input,budget})).captured).toBe(5);expect(budget.remaining).toBe(0);
});
it("B8 skipped footer retains only a bounded count, never outsider identity or text",async()=>{
 const {capturePullRequestCorrections}=await import("../../packages/broker/src/learning/capture-pr.js"),f=fixture();f.input.comments=[{...f.comment(),authorId:"999",author:"outsider-secret",body:"outsider-secret instruction should never be stored anywhere"}];await capturePullRequestCorrections(f.deps,f.input);
 expect(f.db.get(projectLearningKey(f.scope.orgId,f.scope.project,"SETTINGS"))?.skippedUnlinked).toBe(1);expect(JSON.stringify([...f.db.items.values()])).not.toContain("outsider-secret");
});
