import type {DeveloperTaskRecord} from "../../packages/broker/src/developer/task-records.js";
import {beforeAll,expect,it} from "vitest";
import {randomUUID} from "node:crypto";
import {orgRemovedKey,orgBanKey,developerOrgKey,projectMemberKey,slackBindingKey} from "@agentx/contracts";
import {developerIdForSlackUser} from "../../packages/broker/src/aws/admin-actions.js";
import {readTurnActorChecks} from "../../packages/broker/src/model-selection/turn-authority.js";
import {call,createAuditedSlackBroker,loadSlackBroker,registerSlackProject,ensureWorkspace,markReady,serviceCall,SLACK_TEAM,SLACK_CHANNEL} from "../support/slack-broker.js";
import {TEST_ORG} from "../support/orgs.js";
beforeAll(loadSlackBroker);
const user="U0123456789",actor=developerIdForSlackUser(user),thread=`${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000090`;
async function fixture(){
 const h=createAuditedSlackBroker();const {bedrockClaudeModelIds}=await import("@agentx/model-runtime/catalog");const approved=bedrockClaudeModelIds("us").map((modelId,index)=>({provider:"amazon-bedrock",modelId,label:`Model ${index}`}));await registerSlackProject(h.handler,{models:{default:approved[0]!,approved}});
 const workspace=await ensureWorkspace(h.handler,thread,user),workspaceId=String(workspace.body.workspaceId);markReady(h.db,workspaceId);
 const conversation=await serviceCall(h.handler,thread,user,"POST",`/v1/service/workspaces/${workspaceId}/conversations`,{}),conversationId=(conversation.body.conversation as {id:string}).id;
 const start=()=>serviceCall(h.handler,thread,user,"POST",`/v1/service/workspaces/${workspaceId}/tasks`,{requestId:randomUUID(),conversationId,prompt:"Fix the retry."});
 return {...h,workspaceId,start};
}
it("admits an authenticated bound Slack turn without browser-auth configuration or enrollment writes",async()=>{
 const h=await fixture(),result=await h.start();expect(result.status,JSON.stringify(result.body)).toBe(202);
 expect(h.db.get(`DEVELOPER#${actor}`,"META")).toBeUndefined();expect(h.db.get(developerOrgKey(actor))).toBeUndefined();
 const operationId=(result.body.operation as {id:string}).id;expect(h.db.get(`WORKSPACE#${h.workspaceId}`,`OPERATION#${operationId}`)?.modelTurnPin).toMatchObject({slackUserId:user,threadChannel:{teamId:SLACK_TEAM,channelId:SLACK_CHANNEL}});
});
for(const changed of ["removed","banned","other-org","viewer"] as const)it(`refuses implicit Slack authority after ${changed}`,async()=>{
 const h=await fixture();
 if(changed==="removed")h.db.set({...orgRemovedKey(TEST_ORG,actor),removedAt:"2026-10-30T00:00:00Z"});
 if(changed==="banned")h.db.set({...orgBanKey(TEST_ORG,actor),bannedAt:"2026-10-30T00:00:00Z"});
 if(changed==="other-org")h.db.set({...developerOrgKey(actor),orgId:"org_bbbbbbbbbbbbbbbbbbbb",role:"member"});
 if(changed==="viewer")h.db.set({...projectMemberKey(TEST_ORG,actor,"payments"),role:"viewer",projectRole:"viewer",ownerKey:actor,projectName:"payments"});
 const result=await h.start();expect(result.status).toBe(403);expect(h.db.find(row=>row.modelTurnPin!==undefined)).toHaveLength(0);
});
it("does not infer implicit Slack authority for a non-Slack caller or a tenant-resolving install",async()=>{
 const h=await fixture(),deps={documentClient:h.db,tableName:"state"};
 await expect(readTurnActorChecks({...deps,allowImplicitSlack:true},{orgId:TEST_ORG,project:"payments",developerId:actor})).rejects.toMatchObject({code:"MODEL_NOT_ALLOWED"});
 await expect(readTurnActorChecks({...deps,allowImplicitSlack:false},{orgId:TEST_ORG,project:"payments",developerId:actor,slackUserId:user,threadChannel:{teamId:SLACK_TEAM,channelId:SLACK_CHANNEL}})).rejects.toMatchObject({code:"MODEL_NOT_ALLOWED"});
});
it("checks the bound channel again for runtime fallback without browser auth",async()=>{
 const h=await fixture(),result=await h.start();expect(result.status).toBe(202);const id=(result.body.operation as {id:string}).id;
 const outbox=h.db.find(row=>row.entityType==="OUTBOX"&&row.operationId===id)[0]!,invocation=outbox.invocation as {callbackCapability:string;payload:{model:unknown;modelPolicy:unknown}};
 const request={version:1,binding:invocation.payload.modelPolicy,reason:"missing_key",failedModel:invocation.payload.model};
 const response=await call(h.handler,{method:"POST",path:`/v1/internal/workspaces/${h.workspaceId}/operations/${id}/model-fallback`,headers:{"x-agentx-callback-capability":invocation.callbackCapability},body:request});expect(response.status,JSON.stringify(response.body)).toBe(200);
 const key=slackBindingKey(TEST_ORG,SLACK_TEAM,SLACK_CHANNEL);h.db.set({...h.db.get(key)!,projectName:"another-project"});
 const before=JSON.stringify(h.db.get(`WORKSPACE#${h.workspaceId}`,`OPERATION#${id}`));
 const refused=await call(h.handler,{method:"POST",path:`/v1/internal/workspaces/${h.workspaceId}/operations/${id}/model-fallback`,headers:{"x-agentx-callback-capability":invocation.callbackCapability},body:request});expect(refused).toMatchObject({status:403,body:{error:{code:"MODEL_NOT_ALLOWED"}}});expect(JSON.stringify(h.db.get(`WORKSPACE#${h.workspaceId}`,`OPERATION#${id}`))).toBe(before);
});

it("does not give a tenant-resolving install the single-org implicit enrollment path",async()=>{
 const h=createAuditedSlackBroker({extra:{cloud:true,orgResolver:async()=>TEST_ORG}});await registerSlackProject(h.handler);
 const workspace=await ensureWorkspace(h.handler,thread,user),workspaceId=String(workspace.body.workspaceId);markReady(h.db,workspaceId);
 const conversation=await serviceCall(h.handler,thread,user,"POST",`/v1/service/workspaces/${workspaceId}/conversations`,{}),conversationId=(conversation.body.conversation as {id:string}).id;
 const response=await serviceCall(h.handler,thread,user,"POST",`/v1/service/workspaces/${workspaceId}/tasks`,{requestId:randomUUID(),conversationId,prompt:"Fix"});expect(response).toMatchObject({status:403,body:{error:{code:"MODEL_NOT_ALLOWED"}}});
});
for(const change of ["removed","banned","other-org","identity","binding","viewer"] as const)it(`fences an implicit Slack ${change} change between read and commit`,async()=>{
 const h=await fixture();const {DeveloperSignInStore}=await import("../../packages/broker/src/developer/store.js"),{TransactWriteCommand}=await import("@aws-sdk/lib-dynamodb");
 const checks=await readTurnActorChecks({documentClient:h.db,tableName:"state",allowImplicitSlack:true,modelSignInTableName:"signin",signInStore:new DeveloperSignInStore({documentClient:h.db,tableName:"signin",now:Date.now})},{orgId:TEST_ORG,project:"payments",developerId:actor,slackUserId:user,threadChannel:{teamId:SLACK_TEAM,channelId:SLACK_CHANNEL}});
 expect(checks.length).toBeLessThanOrEqual(25);
 if(change==="removed")h.db.set({...orgRemovedKey(TEST_ORG,actor),removedAt:"2026-10-30T00:00:00Z"});
 if(change==="banned")h.db.set({...orgBanKey(TEST_ORG,actor),bannedAt:"2026-10-30T00:00:00Z"});
 if(change==="other-org")h.db.set({...developerOrgKey(actor),orgId:"org_bbbbbbbbbbbbbbbb",role:"member"});
 if(change==="identity")h.db.set({pk:`DEVELOPER#${actor}`,sk:"META",developerId:actor,revoked:true});
 if(change==="viewer")h.db.set({...projectMemberKey(TEST_ORG,actor,"payments"),role:"viewer",projectRole:"viewer"});
 if(change==="binding"){const key=slackBindingKey(TEST_ORG,SLACK_TEAM,SLACK_CHANNEL);h.db.set({...h.db.get(key)!,updatedAt:"2026-10-30T00:00:00Z"});}
 await expect(h.db.send(new TransactWriteCommand({TransactItems:checks}))).rejects.toMatchObject({name:"TransactionCanceledException"});
});

it("keeps the existing U/W Slack-user format in the private authority pin",async()=>{
 const h=await fixture(),response=await h.start();expect(response.status).toBe(202);const id=(response.body.operation as {id:string}).id;
 const raw=h.db.get(`WORKSPACE#${h.workspaceId}`,`OPERATION#${id}`)!.modelTurnPin as Record<string,unknown>;const {parseTurnModelPin}=await import("../../packages/broker/src/model-selection/turn-policy.js");
 expect(parseTurnModelPin({...raw,slackUserId:"W0123456789",actorDeveloperId:developerIdForSlackUser("W0123456789")},TEST_ORG,"payments").slackUserId).toBe("W0123456789");
});

for(const viewer of [true,false])it(`rechecks and fences an existing task's ${viewer?"viewer":"contributor"} grant`,async()=>{
 const h=await fixture(),taskId=randomUUID();
 const {taskKey,taskPointerKey}=await import("../../packages/broker/src/developer/task-records.js");
 const task={taskId,orgId:TEST_ORG,project:"payments",workspaceId:h.workspaceId,developerId:actor,developerName:"Slack owner",provider:"slack"} as unknown as DeveloperTaskRecord;
 h.db.set({...taskKey(taskId),...task});h.db.set({...taskPointerKey(h.workspaceId),taskId});
 const Key=projectMemberKey(TEST_ORG,actor,"payments");h.db.set({...Key,role:viewer?"viewer":"developer",projectRole:viewer?"viewer":"contributor"});
 const request=()=>readTurnActorChecks({documentClient:h.db,tableName:"state",allowImplicitSlack:true},{orgId:TEST_ORG,project:"payments",developerId:actor,task,slackUserId:user,threadChannel:{teamId:SLACK_TEAM,channelId:SLACK_CHANNEL}});
 if(viewer){await expect(request()).rejects.toMatchObject({code:"MODEL_NOT_ALLOWED"});return;}
 const checks=await request();h.db.delete(Key);const {TransactWriteCommand}=await import("@aws-sdk/lib-dynamodb");
 await expect(h.db.send(new TransactWriteCommand({TransactItems:checks}))).rejects.toMatchObject({name:"TransactionCanceledException"});
});
