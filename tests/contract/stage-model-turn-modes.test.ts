import {expect,it} from "vitest";
import {prepareTurnModelPolicy} from "../../packages/broker/src/model-selection/turn-policy.js";
import {mergeWorld} from "../support/rovara-code-merge-world.js";
import {ORG_A,MAX} from "../support/agent-session-world.js";
import {projectRevisionKey,canonicalModelName} from "@agentx/contracts";
import {bedrockClaudeModelIds} from "@agentx/model-runtime/catalog";
function fixture(same=false){
 const w=mergeWorld(),seen=new Set<string>(),models=bedrockClaudeModelIds("us").filter(modelId=>{const name=canonicalModelName({provider:"amazon-bedrock",modelId});if(seen.has(name))return false;seen.add(name);return true;});
 const build={provider:"amazon-bedrock",modelId:models[0]!},review=same?build:{provider:"amazon-bedrock",modelId:models[1]!};
 w.db.set({...projectRevisionKey(ORG_A,"web",1),registeredAt:"2026-10-01T00:00:00Z",definition:{name:"web",revision:1,repositories:[{name:"web",url:"https://github.com/acme/web.git",path:"repo/web",defaultBranch:"main",credentialRef:"github-app"}],setup:[],readiness:[],orchestratorInstructions:"Delegate."}});
 w.db.set({pk:`ORG#${ORG_A}#SETTINGS`,sk:"MODEL_SELECTION_POLICY",orgId:ORG_A,entityType:"MODEL_SELECTION_POLICY",version:1,revision:1,rankingVersion:"g3-v1",stepOverrides:{build:{model:build,thinkingLevel:null,locked:true},code_review:{model:review,thinkingLevel:null,locked:true},security_review:{model:review,thinkingLevel:null,locked:true}}});
 return {w,build,review,deps:{documentClient:w.db,tableName:"state",store:w.store,routing:{},now:()=>w.clock.now}};
}
it("maps an unpinned REVIEW to both locked review stages instead of Build",async()=>{
 const f=fixture(),result=await prepareTurnModelPolicy(f.deps,{orgId:ORG_A,project:"web",actorDeveloperId:MAX,workflowMode:"REVIEW",priorModels:{build:f.build}});
 expect(result.model).toEqual(f.review);expect(result.binding.stage).toBe("code_review");
});
it("refuses an unpinned review that equals the actual Build reference",async()=>{
 const f=fixture(true);
 await expect(prepareTurnModelPolicy(f.deps,{orgId:ORG_A,project:"web",actorDeveloperId:MAX,workflowMode:"REVIEW",priorModels:{build:f.build}})).rejects.toMatchObject({code:"LOCK_UNSATISFIABLE",stage:"code_review",fixHref:"/app/admin/how-we-work"});
});
it("refuses an unmapped legacy workflow mode with a structured code",async()=>{
 const f=fixture();
 await expect(prepareTurnModelPolicy(f.deps,{orgId:ORG_A,project:"web",actorDeveloperId:MAX,workflowMode:"UNKNOWN_LEGACY_MODE",priorModels:{build:f.build}})).rejects.toMatchObject({code:"WORKFLOW_MODE_UNMAPPED"});
});

for(const mode of ["REVIEW","PLAN_CRITIQUE"] as const)for(const same of [false,true])it(`resumes a legacy ${mode} with its mapped stage and actual reference (same=${same})`,async()=>{
 const {createDeveloperTaskBroker,MAYA,seedMembership}=await import("../support/developer-task-broker.js");
 const {markReady}=await import("../support/slack-broker.js");
 const {developerTaskIdentity,taskKey,taskPointerKey}=await import("../../packages/broker/src/developer/task-records.js");
 const {TEST_ORG}=await import("../support/orgs.js");const {randomUUID}=await import("node:crypto");
 const h=await createDeveloperTaskBroker({brokerExtra:{agents:{}}});
 await h.dev(MAYA,"GET","/v1/developer/tasks");seedMembership(h.db,MAYA.developerId,{orgId:TEST_ORG,role:"owner"});
 const taskId=randomUUID(),identity=developerTaskIdentity({taskId,developerId:MAYA.developerId,provider:"slack",developerName:MAYA.name,client:"fixture"},TEST_ORG);
 const project=await h.actions.latestProject(TEST_ORG,"payments");if(!project)throw Error("missing project");
 const prepared=await h.actions.preparation(identity,project,randomUUID());await h.actions.transact(prepared.items);const workspaceId=prepared.workspace.id;markReady(h.db,workspaceId);
 const conversationId=randomUUID();h.db.set({pk:`WORKSPACE#${workspaceId}`,sk:`CONVERSATION#${conversationId}`,entityType:"CONVERSATION",id:conversationId,workspaceId,createdAt:"x",updatedAt:"x"});
 h.db.set({...taskKey(taskId),taskId,workspaceId,conversationId,orgId:TEST_ORG,project:"payments",developerId:MAYA.developerId,provider:"slack",developerName:MAYA.name,payer:{kind:"project",project:"payments"}});h.db.set({...taskPointerKey(workspaceId),taskId});
 const f=fixture(same),referenceId=randomUUID();h.db.set({pk:`WORKSPACE#${workspaceId}`,sk:`OPERATION#${referenceId}`,entityType:"OPERATION",kind:"task",id:referenceId,orgId:TEST_ORG,workspaceId,conversationId,workflowMode:mode==="REVIEW"?"IMPLEMENT":"PLAN",status:"SUCCEEDED",createdAt:"2026-10-01T00:00:00Z",model:f.build});
 const override={model:f.review,thinkingLevel:null,locked:true};h.db.set({pk:`ORG#${TEST_ORG}#SETTINGS`,sk:"MODEL_SELECTION_POLICY",entityType:"MODEL_SELECTION_POLICY",orgId:TEST_ORG,version:1,revision:1,rankingVersion:"g3-v1",stepOverrides:{build:{model:f.build,thinkingLevel:null,locked:true},plan_check:override,code_review:override,security_review:override}});
 const action=h.actions.acceptTask(identity,workspaceId,{requestId:randomUUID(),conversationId,prompt:"Resume checking."},()=>[],{workflowMode:mode});
 if(same)await expect(action).rejects.toMatchObject({code:"LOCK_UNSATISFIABLE"});
 else {const result=await action;const operation=h.db.get(`WORKSPACE#${workspaceId}`,`OPERATION#${result.operation.id}`)!;expect(operation).toMatchObject({model:f.review,modelPolicy:{stage:mode==="REVIEW"?"code_review":"plan_check"}});}
});

it("returns a non-retryable structured refusal for split company review locks",async()=>{
 const f=fixture();const key={pk:`ORG#${ORG_A}#SETTINGS`,sk:"MODEL_SELECTION_POLICY"},row=f.w.db.get(key)!;
 f.w.db.set({...row,stepOverrides:{...(row.stepOverrides as object),security_review:{model:f.build,thinkingLevel:null,locked:true}}});
 await expect(prepareTurnModelPolicy(f.deps,{orgId:ORG_A,project:"web",actorDeveloperId:MAX,workflowMode:"REVIEW",priorModels:{build:{provider:"amazon-bedrock",modelId:bedrockClaudeModelIds("us").at(-1)!}}})).rejects.toMatchObject({code:"LOCK_UNSATISFIABLE",fixHref:"/app/admin/how-we-work"});
});
