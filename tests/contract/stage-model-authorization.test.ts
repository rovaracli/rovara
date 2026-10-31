import {call} from "../support/slack-broker.js";
import {issueCapability} from "../../packages/broker/src/aws/cancellation.js";
import {resolveAndAuthorizeTaskFallback} from "../../packages/broker/src/model-selection/fallback-request.js";
import {expect,it} from "vitest";
import {randomUUID} from "node:crypto";
import {TransactWriteCommand} from "@aws-sdk/lib-dynamodb";
import {prepareTaskModelAuthorization,authorizeTaskModelFallback} from "../../packages/broker/src/model-selection/authorize-fallback.js";
import {loadPinnedTaskStageContext} from "../../packages/broker/src/model-selection/task-live.js";
import {DeveloperSignInStore} from "../../packages/broker/src/developer/store.js";
import {createDeveloperTaskBroker,MAYA} from "../support/developer-task-broker.js";
import {capturingAuditDeps} from "../support/audit-capture.js";
import {TEST_ORG} from "../support/orgs.js";
const failedModel={provider:"openai",modelId:"gpt-6.1-sol"};
async function fixture(explicit=false,http=false){
 const httpAudit=http?capturingAuditDeps():undefined;
 const h=await createDeveloperTaskBroker({brokerExtra:{agents:{}},...(httpAudit===undefined?{}:{audit:httpAudit})});
 if(explicit)h.db.set({pk:`ORG#${TEST_ORG}#SETTINGS`,sk:"MODEL_SELECTION_POLICY",entityType:"MODEL_SELECTION_POLICY",orgId:TEST_ORG,version:1,revision:1,rankingVersion:"g3-v1",stepOverrides:{build:{model:failedModel,locked:false}}});
 const started=await h.dev(MAYA,"POST","/v1/dev/tasks",{requestId:randomUUID(),project:"payments",instructions:"Fix",client:"test"});expect(started.status).toBe(200);
 const taskId=(started.body.task as {taskId:string}).taskId,task=h.db.get(`DEVTASK#${taskId}`,"META")!,workspaceId=String(task.workspaceId),operationId=randomUUID(),frozen=h.db.get(`DEVTASK#${taskId}`,"RECIPE")!;
 const pin=frozen.modelPolicyPin as {policy:{revision:number}},binding={version:1 as const,stage:"build" as const,companyRevision:pin.policy.revision,recipeDigest:String(frozen.digest)};
 const workspace=h.db.get(`WORKSPACE#${workspaceId}`,"META")!;h.db.set({...workspace,status:"BUSY",fence:2,activeOperationId:operationId});
 h.db.set({pk:`WORKSPACE#${workspaceId}`,sk:`OPERATION#${operationId}`,entityType:"OPERATION",id:operationId,kind:"task",workspaceId,orgId:TEST_ORG,modelTaskId:taskId,modelPolicy:binding,model:failedModel,status:"RUNNING",fence:2,workflowMode:"IMPLEMENT"});
 const cap=capturingAuditDeps({db:h.db}),deps={documentClient:h.db,tableName:"state",routing:{},now:Date.now,audit:cap.audit,modelSignInTableName:"signin",signInStore:new DeveloperSignInStore({documentClient:h.db,tableName:"signin",now:Date.now})};
 const {ResolvedRecipeSchema}=await import("../../packages/contracts/src/index.js");const recipe=ResolvedRecipeSchema.parse(frozen.recipe);
 const context=await loadPinnedTaskStageContext(deps,{orgId:TEST_ORG,project:"payments",agentId:"rovara-code",recipe,digest:String(frozen.digest),pin:frozen.modelPolicyPin,stage:"build",priorModels:{},deniedModels:[failedModel],defaultPreferred:failedModel});
 const input={verifiedClaims:{workspaceId,operationId,fence:2,actions:["model-fallback" as const],expiresAt:Math.floor(Date.now()/1000)+60,modelPolicy:binding},orgId:TEST_ORG,taskId,workspaceId,operationId,fence:2,request:{version:1 as const,binding,reason:"unavailable" as const,failedModel},context};
 return {h,cap,deps,input};
}
it("prepares one atomic operation replacement, fallback history and audit, and refuses explicit unusable intent",async()=>{
 const {h,cap,deps,input}=await fixture();const prepared=await prepareTaskModelAuthorization(deps,input);
 expect(h.db.get(`DEVTASK#${input.taskId}`,"META")?.modelFallbacks).toBeUndefined();
 await h.db.send(new TransactWriteCommand({TransactItems:prepared.items}));
 expect(h.db.get(`DEVTASK#${input.taskId}`,"META")?.modelFallbacks).toHaveLength(1);expect(cap.pending()).toHaveLength(1);
 expect(h.db.get(`WORKSPACE#${input.workspaceId}`,`OPERATION#${input.operationId}`)).toMatchObject({model:prepared.authorization.model,modelFallbackAuthorization:prepared.authorization});
 const blocked=await fixture(true);await expect(prepareTaskModelAuthorization(blocked.deps,blocked.input)).rejects.toThrow();expect(blocked.cap.pending()).toHaveLength(0);
});
it("rejects stale binding and cross-org scope before constructing writes",async()=>{
 const {deps,input}=await fixture();
 await expect(prepareTaskModelAuthorization(deps,{...input,orgId:"org_bbbbbbbbbbbbbbbbbbbb"})).rejects.toThrow();
 await expect(prepareTaskModelAuthorization(deps,{...input,request:{...input.request,binding:{...input.request.binding,companyRevision:99}}})).rejects.toThrow();
});
it("replays exactly once and rejects a closed task racing the prepared transaction",async()=>{
 const {h,cap,deps,input}=await fixture();
 const first=await prepareTaskModelAuthorization(deps,input);
 await h.db.send(new TransactWriteCommand({TransactItems:first.items}));
 const replay=await prepareTaskModelAuthorization(deps,input);
 expect(replay.replayed).toBe(true);expect(replay.authorization).toEqual(first.authorization);
 await h.db.send(new TransactWriteCommand({TransactItems:replay.items}));
 expect(cap.pending()).toHaveLength(1);
 const race=await fixture();const pending=await prepareTaskModelAuthorization(race.deps,race.input);
 const task=race.h.db.get(`DEVTASK#${race.input.taskId}`,"META")!;
 race.h.db.set({...task,closedAt:new Date().toISOString()});
 await expect(race.h.db.send(new TransactWriteCommand({TransactItems:pending.items}))).rejects.toThrow();
 expect(race.cap.pending()).toHaveLength(0);
 expect(race.h.db.get(`DEVTASK#${race.input.taskId}`,"META")?.modelFallbacks).toBeUndefined();
});
it("refuses a model fallback for a task whose owner has become an Auditor, and still serves a member (I2 re-check)",async()=>{
 const {h,deps,input}=await fixture();
 const {orgMemberKey}=await import("../../packages/contracts/src/index.js");
 const key=orgMemberKey(TEST_ORG,MAYA.developerId),row=h.db.get(key)!;
 expect((await prepareTaskModelAuthorization(deps,input)).items.length).toBeGreaterThan(0);
 h.db.set({...row,role:"auditor"});
 await expect(prepareTaskModelAuthorization(deps,input)).rejects.toThrow("MODEL_NOT_ALLOWED");
 h.db.set({...row,role:"member"});
 expect((await prepareTaskModelAuthorization(deps,input)).items.length).toBeGreaterThan(0);
});
for(const change of ["member","identity","workspace","operation-org","operation-model","task-project","task-workspace"] as const)it(`fences ${change} revocation during first authorization and replay`,async()=>{
 for(const replay of [false,true]){
  const {h,cap,deps,input}=await fixture();
  if(replay){const first=await prepareTaskModelAuthorization(deps,input);await h.db.send(new TransactWriteCommand({TransactItems:first.items}));}
  const prepared=await prepareTaskModelAuthorization(deps,input);
  const {orgMemberKey}=await import("../../packages/contracts/src/index.js");
  if(change==="member"){const key=orgMemberKey(TEST_ORG,MAYA.developerId),row=h.db.get(key)!;h.db.set({...row,role:"viewer"});}
  if(change==="identity"){const row=h.db.get(`DEVELOPER#${MAYA.developerId}`,"META")!;h.db.set({...row,revoked:true});}
  if(change==="workspace"){const row=h.db.get(`WORKSPACE#${input.workspaceId}`,"META")!;h.db.set({...row,fence:3});}
  if(change==="operation-org"){const row=h.db.get(`WORKSPACE#${input.workspaceId}`,`OPERATION#${input.operationId}`)!;h.db.set({...row,orgId:"org_bbbbbbbbbbbbbbbbbbbb"});}
  if(change==="operation-model"){const row=h.db.get(`WORKSPACE#${input.workspaceId}`,`OPERATION#${input.operationId}`)!;h.db.set({...row,model:{provider:"openai",modelId:"gpt-5"}});}
  if(change==="task-project"||change==="task-workspace"){const row=h.db.get(`DEVTASK#${input.taskId}`,"META")!;h.db.set({...row,...(change==="task-project"?{project:"other"}:{workspaceId:"other"})});}
  await expect(h.db.send(new TransactWriteCommand({TransactItems:prepared.items}))).rejects.toThrow();
  expect(cap.pending()).toHaveLength(replay?1:0);
 }
});
it("refuses replay when the stored operation route changes before preparation or commit",async()=>{
 const {h,deps,input}=await fixture();const first=await prepareTaskModelAuthorization(deps,input);
 await h.db.send(new TransactWriteCommand({TransactItems:first.items}));
 const replay=await prepareTaskModelAuthorization(deps,input);
 const row=h.db.get(`WORKSPACE#${input.workspaceId}`,`OPERATION#${input.operationId}`)!;
 h.db.set({...row,modelRoute:{sourceId:"src_aaaaaaaaaaaaaaaaaaaa",alias:"changed",model:first.authorization.model}});
 await expect(h.db.send(new TransactWriteCommand({TransactItems:replay.items}))).rejects.toThrow();
 await expect(prepareTaskModelAuthorization(deps,input)).rejects.toThrow();
});

it("refuses missing, expired, mismatched and ungranted verified callback claims",async()=>{
 const {deps,input}=await fixture();
 for(const verifiedClaims of [undefined,{...input.verifiedClaims,actions:[]},{...input.verifiedClaims,expiresAt:0},{...input.verifiedClaims,fence:3},{...input.verifiedClaims,workspaceId:"elsewhere"},{...input.verifiedClaims,operationId:"elsewhere"},{...input.verifiedClaims,modelPolicy:{...input.verifiedClaims.modelPolicy,companyRevision:99}}]){
  await expect(prepareTaskModelAuthorization(deps,{...input,verifiedClaims})).rejects.toThrow();
 }
});

it("returns authorization only after atomic commit and preserves audit during queue outage",async()=>{
 const {h,cap,deps,input}=await fixture();cap.queueDown();
 const result=await authorizeTaskModelFallback(deps,input);
 expect(h.db.get(`WORKSPACE#${input.workspaceId}`,`OPERATION#${input.operationId}`)?.modelFallbackAuthorization).toEqual(result);
 expect(h.db.get(`DEVTASK#${input.taskId}`,"META")?.modelFallbacks).toHaveLength(1);expect(cap.pending()).toHaveLength(1);
 expect(await authorizeTaskModelFallback(deps,input)).toEqual(result);expect(cap.pending()).toHaveLength(1);
});
it("never returns authorization or flushes audit when the final transaction loses authority",async()=>{
 const {h,cap,deps,input}=await fixture();
 const guarded={...deps,documentClient:{send:async(command:unknown)=>{
  if(command instanceof TransactWriteCommand){const row=h.db.get(`DEVTASK#${input.taskId}`,"META")!;h.db.set({...row,closedAt:new Date().toISOString()});}
  return deps.documentClient.send(command as Parameters<typeof deps.documentClient.send>[0]);
 }}};
 await expect(authorizeTaskModelFallback(guarded,input)).rejects.toThrow();
 expect(cap.pending()).toHaveLength(0);expect(cap.flushed()).toHaveLength(0);
 expect(h.db.get(`DEVTASK#${input.taskId}`,"META")?.modelFallbacks).toBeUndefined();
 expect(h.db.get(`WORKSPACE#${input.workspaceId}`,`OPERATION#${input.operationId}`)?.modelFallbackAuthorization).toBeUndefined();
});
it("refuses live context resolved for a different stage even if the model is identical",async()=>{
 const {deps,input}=await fixture();
 await expect(prepareTaskModelAuthorization(deps,{...input,context:{...input.context,stage:"plan"}})).rejects.toThrow();
});
it("derives the committed route internally instead of accepting a caller alias",async()=>{
 const {deps,input}=await fixture();
 const result=await authorizeTaskModelFallback(deps,{...input,route:{sourceId:"rovara",wire:{alias:"caller-supplied",api:"anthropic-messages",catalog:"caller-supplied"}}});
 expect(result.modelRoute).toBeUndefined();
});

it("resolves from stored task state instead of caller context before committing",async()=>{
 const {h,deps,input}=await fixture();
 const request={orgId:input.orgId,taskId:input.taskId,workspaceId:input.workspaceId,operationId:input.operationId,fence:input.fence,request:input.request,verifiedClaims:input.verifiedClaims};
 const result=await resolveAndAuthorizeTaskFallback(deps,request);
 expect(result.model.provider).toBe("amazon-bedrock");
 expect(h.db.get(`DEVTASK#${input.taskId}`,"META")?.modelFallbacks).toHaveLength(1);
});

it("serves fallback only through a matching signed HTTP capability",async()=>{
 const {h,input}=await fixture(false,true);
 const path=`/v1/internal/workspaces/${input.workspaceId}/operations/${input.operationId}/model-fallback`;
 const token=issueCapability({callbackSigningKey:"c".repeat(64)},input.workspaceId,input.operationId,input.fence,{modelPolicy:input.request.binding});
 const response=await call(h.handler,{method:"POST",path,headers:{"x-agentx-callback-capability":token},body:input.request});
 expect(response.status).toBe(200);expect(response.body).toMatchObject({version:1,binding:input.request.binding});
 const denied=await call(h.handler,{method:"POST",path,headers:{"x-agentx-callback-capability":token+"tampered"},body:input.request});
 expect(denied.status).not.toBe(200);
});
for(const change of ["no-action","wrong-binding","cross-org","revoked","stale-fence","closed-task"] as const)it(`refuses HTTP fallback for ${change} without authorizing a replacement`,async()=>{
 const {h,input}=await fixture(false,true);
 const operationKey={pk:`WORKSPACE#${input.workspaceId}`,sk:`OPERATION#${input.operationId}`};
 if(change==="cross-org")h.db.set({...h.db.get(operationKey)!,orgId:"org_bbbbbbbbbbbbbbbbbbbb"});
 if(change==="revoked"){const row=h.db.get(`DEVELOPER#${MAYA.developerId}`,"META")!;h.db.set({...row,revoked:true});}
 if(change==="stale-fence")h.db.set({...h.db.get(operationKey)!,fence:3});
 if(change==="closed-task"){const row=h.db.get(`DEVTASK#${input.taskId}`,"META")!;h.db.set({...row,closedAt:new Date().toISOString()});}
 const modelPolicy=change==="wrong-binding"?{...input.request.binding,companyRevision:99}:input.request.binding;
 const token=issueCapability({callbackSigningKey:"c".repeat(64)},input.workspaceId,input.operationId,input.fence,change==="no-action"?{}:{modelPolicy});
 const response=await call(h.handler,{method:"POST",path:`/v1/internal/workspaces/${input.workspaceId}/operations/${input.operationId}/model-fallback`,headers:{"x-agentx-callback-capability":token},body:input.request});
 expect(response.status).not.toBe(200);
 expect(h.db.get(operationKey)?.modelFallbackAuthorization).toBeUndefined();
 expect(h.db.get(`DEVTASK#${input.taskId}`,"META")?.modelFallbacks).toBeUndefined();
});

it("refuses a plan-check fallback callback after the task exhausted six critic attempts",async()=>{
 const {h,cap,deps,input}=await fixture();
 const binding={...input.request.binding,stage:"plan_check" as const};
 const opKey={pk:`WORKSPACE#${input.workspaceId}`,sk:`OPERATION#${input.operationId}`};
 h.db.set({...h.db.get(opKey)!,workflowMode:"PLAN_CRITIQUE",modelPolicy:binding});
 const task=h.db.get(`DEVTASK#${input.taskId}`,"META")!,from=Date.now();
 h.db.set({pk:opKey.pk,sk:"OPERATION#planner",entityType:"OPERATION",id:"planner",orgId:TEST_ORG,workspaceId:input.workspaceId,conversationId:task.conversationId,kind:"task",workflowMode:"PLAN",status:"SUCCEEDED",model:failedModel,createdAt:new Date(from).toISOString()});
 for(let i=0;i<6;i++)h.db.set({pk:opKey.pk,sk:`OPERATION#exhausted-${i}`,entityType:"OPERATION",id:`exhausted-${i}`,orgId:TEST_ORG,workspaceId:input.workspaceId,conversationId:task.conversationId,kind:"task",workflowMode:"PLAN_CRITIQUE",status:"FAILED",model:{provider:"openai",modelId:`failed-model-${i}`},error:"MODEL_NOT_ALLOWED: unavailable",createdAt:new Date(from+i+1).toISOString()});
 await expect(resolveAndAuthorizeTaskFallback(deps,{orgId:input.orgId,taskId:input.taskId,workspaceId:input.workspaceId,operationId:input.operationId,fence:input.fence,request:{...input.request,binding},verifiedClaims:{...input.verifiedClaims,modelPolicy:binding}})).rejects.toThrow("plan check");
 expect(h.db.get(opKey)?.modelFallbackAuthorization).toBeUndefined();
 expect(h.db.get(`DEVTASK#${input.taskId}`,"META")?.modelFallbacks).toBeUndefined();expect(cap.pending()).toHaveLength(0);expect(cap.flushed()).toHaveLength(0);
});

it("does not carry an exhausted critic attempt count across a newer plan",async()=>{
 const {h,deps,input}=await fixture();const binding={...input.request.binding,stage:"plan_check" as const};
 const opKey={pk:`WORKSPACE#${input.workspaceId}`,sk:`OPERATION#${input.operationId}`};h.db.set({...h.db.get(opKey)!,workflowMode:"PLAN_CRITIQUE",modelPolicy:binding});
 const task=h.db.get(`DEVTASK#${input.taskId}`,"META")!,from=Date.now();
 for(let i=0;i<6;i++)h.db.set({pk:opKey.pk,sk:`OPERATION#older-${i}`,entityType:"OPERATION",id:`older-${i}`,orgId:TEST_ORG,workspaceId:input.workspaceId,conversationId:task.conversationId,kind:"task",workflowMode:"PLAN_CRITIQUE",status:"FAILED",model:{provider:"openai",modelId:`failed-model-${i}`},error:"MODEL_NOT_ALLOWED: unavailable",createdAt:new Date(from+i).toISOString()});
 h.db.set({pk:opKey.pk,sk:"OPERATION#new-plan",entityType:"OPERATION",id:"new-plan",orgId:TEST_ORG,workspaceId:input.workspaceId,conversationId:task.conversationId,kind:"task",workflowMode:"PLAN",status:"SUCCEEDED",model:failedModel,createdAt:new Date(from+7).toISOString()});
 const result=await resolveAndAuthorizeTaskFallback(deps,{orgId:input.orgId,taskId:input.taskId,workspaceId:input.workspaceId,operationId:input.operationId,fence:input.fence,request:{...input.request,binding},verifiedClaims:{...input.verifiedClaims,modelPolicy:binding}});
 expect(result.model.provider).toBe("amazon-bedrock");expect(h.db.get(`DEVTASK#${input.taskId}`,"META")?.modelFallbacks).toHaveLength(1);
});

it("ignores worker-supplied environment fallback preferences and uses server defaults",async()=>{
 const {defaultWorkerModel}=await import("../../packages/broker/src/agents/dispatch.js");
 const {bedrockClaudeModelIds}=await import("@agentx/model-runtime/catalog");
 const {h,deps,input}=await fixture();
 const expected=defaultWorkerModel();
 const injected={provider:"amazon-bedrock",modelId:bedrockClaudeModelIds("us").find(id=>id!==expected.modelId)!};
 const result=await resolveAndAuthorizeTaskFallback(deps,{orgId:input.orgId,taskId:input.taskId,workspaceId:input.workspaceId,operationId:input.operationId,fence:input.fence,request:{...input.request,reason:"missing_key",environmentFallback:injected},verifiedClaims:input.verifiedClaims});
 expect(result.model).toMatchObject(expected);
 expect(result.model.modelId).not.toBe(injected.modelId);
 expect(h.db.get(`DEVTASK#${input.taskId}`,"META")?.modelFallbacks).toHaveLength(1);
});
