import {beforeAll,expect,it} from "vitest";
import {randomUUID} from "node:crypto";
import {call,loadSlackBroker,createAuditedSlackBroker,registerSlackProject,ensureWorkspace,markReady,serviceCall,SLACK_TEAM,SLACK_CHANNEL} from "../support/slack-broker.js";
import {TEST_ORG} from "../support/orgs.js";
beforeAll(loadSlackBroker);
async function createTurnHarness(extra:Record<string,unknown>={}){
 const {developerIdForSlackUser}=await import("../../packages/broker/src/aws/admin-actions.js");
 const {seedMembership}=await import("../support/developer-task-broker.js");
 const developer={issuer:"https://cell.example/v1/auth",env:"staging",signInTableName:"signin",methods:{slack:true,oidc:false,cloud:false},verifyAccessToken:async()=>({}),channelMembers:async()=>({ok:true as const,memberOf:[]})};
 const h=createAuditedSlackBroker({developer,extra}),actor=developerIdForSlackUser("U0123456789");
 seedMembership(h.db,actor,{orgId:TEST_ORG,role:"owner"});
 h.db.set({pk:`DEVELOPER#${actor}`,sk:"META",developerId:actor,provider:"slack",revoked:false});
 return {...h,actor};
}

it("refuses an agentless project turn when the company Build lock is unavailable instead of using its project selection",async()=>{
 const {handler,db}=await createTurnHarness();
 await registerSlackProject(handler);
 db.set({pk:`ORG#${TEST_ORG}#SETTINGS`,sk:"MODEL_SELECTION_POLICY",entityType:"MODEL_SELECTION_POLICY",orgId:TEST_ORG,version:1,revision:1,rankingVersion:"g3-v1",stepOverrides:{build:{model:{provider:"openai",modelId:"gpt-6.1-sol"},thinkingLevel:null,locked:true}}});
 const thread=`${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000001`,user="U0123456789";
 const workspace=await ensureWorkspace(handler,thread,user),workspaceId=String(workspace.body.workspaceId);
 markReady(db,workspaceId);
 const conversation=await serviceCall(handler,thread,user,"POST",`/v1/service/workspaces/${workspaceId}/conversations`,{});
 const conversationId=(conversation.body.conversation as {id:string}).id;
 const priorOutboxCount=db.find(row=>row.entityType==="OUTBOX").length;
 const result=await serviceCall(handler,thread,user,"POST",`/v1/service/workspaces/${workspaceId}/tasks`,{requestId:randomUUID(),conversationId,prompt:"Fix the project."});
 expect(result.status).toBe(403);
 expect(result.body).toMatchObject({error:{code:"MODEL_NOT_ALLOWED"}});
 expect(db.find(row=>row.entityType==="OUTBOX")).toHaveLength(priorOutboxCount);
});

it("pins an available company Build lock on an agentless turn instead of the project selection",async()=>{
 const {bedrockClaudeModelIds}=await import("@agentx/model-runtime/catalog");
 const {projectSelectionKey}=await import("@agentx/contracts");
 const {handler,db}=await createTurnHarness();await registerSlackProject(handler);
 const ids=bedrockClaudeModelIds("us"),model={provider:"amazon-bedrock",modelId:ids[0]!};
 db.set({...projectSelectionKey(TEST_ORG,"payments"),model:{provider:"amazon-bedrock",modelId:ids.at(-1)!}});
 db.set({pk:`ORG#${TEST_ORG}#SETTINGS`,sk:"MODEL_SELECTION_POLICY",entityType:"MODEL_SELECTION_POLICY",orgId:TEST_ORG,version:1,revision:1,rankingVersion:"g3-v1",stepOverrides:{build:{model,thinkingLevel:null,locked:true}}});
 const thread=`${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000002`,user="U0123456789";
 const workspace=await ensureWorkspace(handler,thread,user),workspaceId=String(workspace.body.workspaceId);markReady(db,workspaceId);
 const conversation=await serviceCall(handler,thread,user,"POST",`/v1/service/workspaces/${workspaceId}/conversations`,{}),conversationId=(conversation.body.conversation as {id:string}).id;
 const result=await serviceCall(handler,thread,user,"POST",`/v1/service/workspaces/${workspaceId}/tasks`,{requestId:randomUUID(),conversationId,prompt:"Fix the project."});
 expect(result.status,JSON.stringify(result.body)).toBe(202);
 const id=(result.body.operation as {id:string}).id,operation=db.get(`WORKSPACE#${workspaceId}`,`OPERATION#${id}`)!;
 expect(operation.model).toMatchObject(model);
 expect(operation.modelTurnPin).toMatchObject({pin:{policy:{revision:1},sourcesRevision:0}});
 const outbox=db.find(row=>row.entityType==="OUTBOX"&&row.operationId===id)[0]!;
 expect((outbox.invocation as {payload:unknown}).payload).toMatchObject({model,modelPolicy:{stage:"build",companyRevision:1}});
 expect(operation.modelTaskId).toBeUndefined();
});

it("records an agentless default fallback visibly with the operation and digest audit in one admission",async()=>{
 const {projectSelectionKey}=await import("@agentx/contracts");
 const {handler,db,audit}=await createTurnHarness();await registerSlackProject(handler);
 db.set({...projectSelectionKey(TEST_ORG,"payments"),model:{provider:"openai",modelId:"gpt-6.1-sol"}});
 const thread=`${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000003`,user="U0123456789";
 const workspace=await ensureWorkspace(handler,thread,user),workspaceId=String(workspace.body.workspaceId);markReady(db,workspaceId);
 const conversation=await serviceCall(handler,thread,user,"POST",`/v1/service/workspaces/${workspaceId}/conversations`,{}),conversationId=(conversation.body.conversation as {id:string}).id;
 const result=await serviceCall(handler,thread,user,"POST",`/v1/service/workspaces/${workspaceId}/tasks`,{requestId:randomUUID(),conversationId,prompt:"Fix the project."});
 expect(result.status,JSON.stringify(result.body)).toBe(202);
 expect(result.body.operation).toMatchObject({modelFallbacks:[{stage:"build",wanted:"openai/gpt-6.1-sol",reasonCode:"DEFAULT_MODEL_UNAVAILABLE"}]});
 expect(audit.flushed().filter(event=>event.action==="model.fallback_used")).toHaveLength(1);
});

async function runtimeTurnFixture(locked=false){
 const {developerIdForSlackUser}=await import("../../packages/broker/src/aws/admin-actions.js");
 const {seedMembership}=await import("../support/developer-task-broker.js");
 const {bedrockClaudeModelIds}=await import("@agentx/model-runtime/catalog");
 const developer={issuer:"https://cell.example/v1/auth",env:"staging",signInTableName:"signin",methods:{slack:true,oidc:false,cloud:false},verifyAccessToken:async()=>({}),channelMembers:async()=>({ok:true as const,memberOf:[]})};
 const {handler,db,audit}=createAuditedSlackBroker({developer});await registerSlackProject(handler);
 const {projectSelectionKey}=await import("@agentx/contracts");
 db.set({...projectSelectionKey(TEST_ORG,"payments"),model:{provider:"amazon-bedrock",modelId:bedrockClaudeModelIds("us")[0]!}});
 if(locked)db.set({pk:`ORG#${TEST_ORG}#SETTINGS`,sk:"MODEL_SELECTION_POLICY",entityType:"MODEL_SELECTION_POLICY",orgId:TEST_ORG,version:1,revision:1,rankingVersion:"g3-v1",stepOverrides:{build:{model:{provider:"amazon-bedrock",modelId:bedrockClaudeModelIds("us")[0]!},thinkingLevel:null,locked:true}}});
 const thread=`${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000004`,user="U0123456789",actor=developerIdForSlackUser(user);
 seedMembership(db,actor,{orgId:TEST_ORG,role:"owner"});
 db.set({pk:`DEVELOPER#${actor}`,sk:"META",developerId:actor,provider:"slack",revoked:false});
 const workspace=await ensureWorkspace(handler,thread,user),workspaceId=String(workspace.body.workspaceId);markReady(db,workspaceId);
 const conversation=await serviceCall(handler,thread,user,"POST",`/v1/service/workspaces/${workspaceId}/conversations`,{}),conversationId=(conversation.body.conversation as {id:string}).id;
 const result=await serviceCall(handler,thread,user,"POST",`/v1/service/workspaces/${workspaceId}/tasks`,{requestId:randomUUID(),conversationId,prompt:"Fix the project."});
 expect(result.status,JSON.stringify(result.body)).toBe(202);
 const operationId=(result.body.operation as {id:string}).id;
 const outbox=db.find(row=>row.entityType==="OUTBOX"&&row.operationId===operationId)[0]!;
 const invocation=outbox.invocation as {callbackCapability:string;payload:{model:{provider:string;modelId:string};modelPolicy:unknown}};
 const path=`/v1/internal/workspaces/${workspaceId}/operations/${operationId}/model-fallback`;
 const body={version:1,binding:invocation.payload.modelPolicy,reason:"missing_key",failedModel:invocation.payload.model,environmentFallback:{provider:"amazon-bedrock",modelId:bedrockClaudeModelIds("us")[0]!}};
 return {handler,db,audit,actor,workspaceId,operationId,invocation,path,body};
}

it("authorizes and audits an agentless missing-key fallback through its signed operation capability",async()=>{
 const {handler,db,audit,workspaceId,operationId,invocation,path,body}=await runtimeTurnFixture();
 const response=await call(handler,{method:"POST",path,headers:{"x-agentx-callback-capability":invocation.callbackCapability},body});
 expect(response.status,JSON.stringify(response.body)).toBe(200);
 expect(db.get(`WORKSPACE#${workspaceId}`,`OPERATION#${operationId}`)).toMatchObject({model:response.body.model,modelFallbacks:[{stage:"build",reasonCode:"MODEL_CALL_REFUSED"}]});
 expect(audit.flushed().filter(event=>event.action==="model.fallback_used")).toHaveLength(1);
 const replay=await call(handler,{method:"POST",path,headers:{"x-agentx-callback-capability":invocation.callbackCapability},body});
 expect(replay.status).toBe(200);
 const firstAuthorization={...response.body},replayAuthorization={...replay.body};delete firstAuthorization.requestId;delete replayAuthorization.requestId;
 expect(replayAuthorization).toEqual(firstAuthorization);
 expect(audit.flushed().filter(event=>event.action==="model.fallback_used")).toHaveLength(1);
});

for(const changed of ["membership","global-org","sign-in","workspace-fence","operation-org","signature"] as const)it(`refuses agentless fallback after ${changed} changes without model/history/audit writes`,async()=>{
 const f=await runtimeTurnFixture();
 const {orgMemberKey,developerOrgKey}=await import("@agentx/contracts");
 if(changed==="membership")f.db.delete(orgMemberKey(TEST_ORG,f.actor));
 if(changed==="global-org")f.db.set({...f.db.get(developerOrgKey(f.actor))!,orgId:"org_bbbbbbbbbbbbbbbbbbbb"});
 if(changed==="sign-in")f.db.set({...f.db.get(`DEVELOPER#${f.actor}`,"META")!,revoked:true});
 if(changed==="workspace-fence")f.db.set({...f.db.get(`WORKSPACE#${f.workspaceId}`,"META")!,fence:999});
 if(changed==="operation-org")f.db.set({...f.db.get(`WORKSPACE#${f.workspaceId}`,`OPERATION#${f.operationId}`)!,orgId:"org_bbbbbbbbbbbbbbbbbbbb"});
 const token=f.invocation.callbackCapability+(changed==="signature"?"tampered":"");
 const response=await call(f.handler,{method:"POST",path:f.path,headers:{"x-agentx-callback-capability":token},body:f.body});
 expect(response.status).not.toBe(200);
 expect(f.db.get(`WORKSPACE#${f.workspaceId}`,`OPERATION#${f.operationId}`)?.model).toEqual(f.invocation.payload.model);
 expect(f.db.get(`WORKSPACE#${f.workspaceId}`,`OPERATION#${f.operationId}`)?.modelFallbacks).toBeUndefined();
 expect(f.audit.flushed().filter(event=>event.action==="model.fallback_used")).toHaveLength(0);
});
for(const projectRole of ["maintainer","contributor","viewer","none"] as const)it(`uses the current ${projectRole} project grant for an agentless member fallback`,async()=>{
 const f=await runtimeTurnFixture();
 const {seedMembership}=await import("../support/developer-task-broker.js");const {projectMemberKey}=await import("@agentx/contracts");
 seedMembership(f.db,f.actor,{orgId:TEST_ORG,role:"member"});
 if(projectRole!=="none")f.db.set({...projectMemberKey(TEST_ORG,f.actor,"payments"),role:projectRole==="viewer"?"viewer":"developer",projectRole});
 const response=await call(f.handler,{method:"POST",path:f.path,headers:{"x-agentx-callback-capability":f.invocation.callbackCapability},body:f.body});
 expect(response.status).toBe(projectRole==="viewer"||projectRole==="none"?403:200);
 expect(f.audit.flushed().filter(event=>event.action==="model.fallback_used")).toHaveLength(projectRole==="viewer"||projectRole==="none"?0:1);
});
it("rolls back the agentless fallback model, history and audit when identity is withdrawn at commit",async()=>{
 const f=await runtimeTurnFixture();const {TransactWriteCommand}=await import("@aws-sdk/lib-dynamodb");const {orgMemberKey}=await import("@agentx/contracts");
 const send=f.db.send.bind(f.db);f.db.send=async command=>{if(command instanceof TransactWriteCommand)f.db.delete(orgMemberKey(TEST_ORG,f.actor));return send(command);};
 const response=await call(f.handler,{method:"POST",path:f.path,headers:{"x-agentx-callback-capability":f.invocation.callbackCapability},body:f.body});
 expect(response.status).not.toBe(200);
 expect(f.db.get(`WORKSPACE#${f.workspaceId}`,`OPERATION#${f.operationId}`)?.model).toEqual(f.invocation.payload.model);
 expect(f.db.get(`WORKSPACE#${f.workspaceId}`,`OPERATION#${f.operationId}`)?.modelFallbacks).toBeUndefined();
 expect(f.audit.pending()).toHaveLength(0);
 expect(f.audit.flushed().filter(event=>event.action==="model.fallback_used")).toHaveLength(0);
});

for(const changed of ["membership","sign-in","policy","sources"] as const)it(`fences ${changed} withdrawal atomically at agentless turn admission`,async()=>{
 const f=await createTurnHarness();await registerSlackProject(f.handler);
 const {TransactWriteCommand}=await import("@aws-sdk/lib-dynamodb");const {orgMemberKey,modelSourcesKey}=await import("@agentx/contracts");
 const thread=`${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000005`,user="U0123456789";
 const workspace=await ensureWorkspace(f.handler,thread,user),workspaceId=String(workspace.body.workspaceId);markReady(f.db,workspaceId);
 const conversation=await serviceCall(f.handler,thread,user,"POST",`/v1/service/workspaces/${workspaceId}/conversations`,{}),conversationId=(conversation.body.conversation as {id:string}).id;
 const before=f.db.find(row=>row.entityType==="OUTBOX").length,send=f.db.send.bind(f.db);
 f.db.send=async command=>{if(command instanceof TransactWriteCommand){if(changed==="membership")f.db.delete(orgMemberKey(TEST_ORG,f.actor));else if(changed==="sign-in")f.db.set({...f.db.get(`DEVELOPER#${f.actor}`,"META")!,revoked:true});else if(changed==="policy")f.db.set({pk:`ORG#${TEST_ORG}#SETTINGS`,sk:"MODEL_SELECTION_POLICY",revision:1});else f.db.set({...modelSourcesKey(TEST_ORG),revision:1});}return send(command);};
 const response=await serviceCall(f.handler,thread,user,"POST",`/v1/service/workspaces/${workspaceId}/tasks`,{requestId:randomUUID(),conversationId,prompt:"Fix the project."});
 expect(response.status).not.toBe(202);
 expect(f.db.find(row=>row.entityType==="OUTBOX")).toHaveLength(before);
 expect(f.db.find(row=>row.entityType==="OPERATION"&&row.kind==="task")).toHaveLength(0);
});

for(const locked of [false,true])it(`keeps a connected personal plan ${locked?"below a company Build lock":"as a verified default"} on an agentless turn`,async()=>{
 const chatgpt={settings:async()=>({enabled:true,preferredModel:"gpt-6.1-sol"}),view:async()=>({connected:true,status:"connected",connectedAt:"2026-10-01T00:00:00.000Z",models:["gpt-6.1-sol"]})};
 const f=await createTurnHarness({chatgpt});await registerSlackProject(f.handler);
 const {bedrockClaudeModelIds}=await import("@agentx/model-runtime/catalog");

 const model={provider:"amazon-bedrock",modelId:bedrockClaudeModelIds("us")[0]!};
 if(locked)f.db.set({pk:`ORG#${TEST_ORG}#SETTINGS`,sk:"MODEL_SELECTION_POLICY",entityType:"MODEL_SELECTION_POLICY",orgId:TEST_ORG,version:1,revision:1,rankingVersion:"g3-v1",stepOverrides:{build:{model,thinkingLevel:null,locked:true}}});
 const thread=`${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000006`,user="U0123456789";
 const workspace=await ensureWorkspace(f.handler,thread,user),workspaceId=String(workspace.body.workspaceId);markReady(f.db,workspaceId);
 const conversation=await serviceCall(f.handler,thread,user,"POST",`/v1/service/workspaces/${workspaceId}/conversations`,{}),conversationId=(conversation.body.conversation as {id:string}).id;
 const response=await serviceCall(f.handler,thread,user,"POST",`/v1/service/workspaces/${workspaceId}/tasks`,{requestId:randomUUID(),conversationId,prompt:"Fix the project."});
 expect(response.status,JSON.stringify(response.body)).toBe(202);
 const operationId=(response.body.operation as {id:string}).id,outbox=f.db.find(row=>row.entityType==="OUTBOX"&&row.operationId===operationId)[0]!;
 const payload=(outbox.invocation as {payload:Record<string,unknown>}).payload;
 expect(payload.model).toEqual(locked?model:{provider:"openai",modelId:"gpt-6.1-sol"});
 if(locked)expect(payload.chatgpt).toBeUndefined();else expect(payload.chatgpt).toEqual({model:{provider:"openai",modelId:"gpt-6.1-sol"}});
});
it("does not use a personal plan for an old agentless task with an explicit project payer",async()=>{
 const chatgpt={settings:async()=>({enabled:true,preferredModel:"gpt-6.1-sol"}),view:async()=>({connected:true,status:"connected",connectedAt:"2026-10-01T00:00:00.000Z",models:["gpt-6.1-sol"]})};
 const f=await createTurnHarness({chatgpt});await registerSlackProject(f.handler);
 const {taskPointerKey,taskKey}=await import("../../packages/broker/src/developer/task-records.js");

 const thread=`${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000007`,user="U0123456789";
 const workspace=await ensureWorkspace(f.handler,thread,user),workspaceId=String(workspace.body.workspaceId);markReady(f.db,workspaceId);
 const conversation=await serviceCall(f.handler,thread,user,"POST",`/v1/service/workspaces/${workspaceId}/conversations`,{}),conversationId=(conversation.body.conversation as {id:string}).id,taskId=randomUUID();
 f.db.set({...taskKey(taskId),taskId,workspaceId,conversationId,orgId:TEST_ORG,project:"payments",developerId:f.actor,developerName:"Fixture owner",provider:"slack",payer:{kind:"project",project:"payments"}});
 f.db.set({...taskPointerKey(workspaceId),taskId});
 const response=await serviceCall(f.handler,thread,user,"POST",`/v1/service/workspaces/${workspaceId}/tasks`,{requestId:randomUUID(),conversationId,prompt:"Fix the project."});
 expect(response.status,JSON.stringify(response.body)).toBe(202);
 const operationId=(response.body.operation as {id:string}).id,outbox=f.db.find(row=>row.entityType==="OUTBOX"&&row.operationId===operationId)[0]!;
 expect((outbox.invocation as {payload:Record<string,unknown>}).payload.chatgpt).toBeUndefined();
 expect(f.db.get(`WORKSPACE#${workspaceId}`,`OPERATION#${operationId}`)?.modelTurnPin).toBeDefined();
 expect(f.db.get(`WORKSPACE#${workspaceId}`,`OPERATION#${operationId}`)?.modelTaskId).toBeUndefined();
});

it("refuses a runtime fallback that would replace an agentless company's locked Build model",async()=>{
 const f=await runtimeTurnFixture(true);
 const response=await call(f.handler,{method:"POST",path:f.path,headers:{"x-agentx-callback-capability":f.invocation.callbackCapability},body:f.body});
 expect(response.status).toBe(403);expect(response.body).toMatchObject({error:{code:"MODEL_NOT_ALLOWED"}});
 expect(f.db.get(`WORKSPACE#${f.workspaceId}`,`OPERATION#${f.operationId}`)?.model).toEqual(f.invocation.payload.model);
 expect(f.db.get(`WORKSPACE#${f.workspaceId}`,`OPERATION#${f.operationId}`)?.modelFallbacks).toBeUndefined();
 expect(f.audit.flushed().filter(event=>event.action==="model.fallback_used")).toHaveLength(0);
});
it("uses live company admin authority for an agentless fallback",async()=>{
 const f=await runtimeTurnFixture();const {seedMembership}=await import("../support/developer-task-broker.js");
 seedMembership(f.db,f.actor,{orgId:TEST_ORG,role:"admin"});
 expect((await call(f.handler,{method:"POST",path:f.path,headers:{"x-agentx-callback-capability":f.invocation.callbackCapability},body:f.body})).status).toBe(200);
 expect(f.audit.flushed().filter(event=>event.action==="model.fallback_used")).toHaveLength(1);
});
