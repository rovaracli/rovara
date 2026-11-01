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
 expect(result.status).toBe(409);
 expect(result.body).toMatchObject({error:{code:"LOCK_UNSATISFIABLE",stage:"build",fixHref:"/app/admin/how-we-work"}});
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
 const {bedrockClaudeModelIds}=await import("@agentx/model-runtime/catalog");
 const primary={provider:"openai",modelId:"gpt-6.1-sol",label:"Primary"};
 const {handler,db,audit}=await createTurnHarness();await registerSlackProject(handler,{models:{default:primary,approved:[primary,...bedrockClaudeModelIds("us").map((modelId,index)=>({provider:"amazon-bedrock",modelId,label:`Fallback ${index}`}))]}});
 const thread=`${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000003`,user="U0123456789";
 const workspace=await ensureWorkspace(handler,thread,user),workspaceId=String(workspace.body.workspaceId);markReady(db,workspaceId);
 const conversation=await serviceCall(handler,thread,user,"POST",`/v1/service/workspaces/${workspaceId}/conversations`,{}),conversationId=(conversation.body.conversation as {id:string}).id;
 const result=await serviceCall(handler,thread,user,"POST",`/v1/service/workspaces/${workspaceId}/tasks`,{requestId:randomUUID(),conversationId,prompt:"Fix the project."});
 expect(result.status,JSON.stringify(result.body)).toBe(202);
 expect(result.body.operation).toMatchObject({modelFallbacks:[{stage:"build",wanted:"openai/gpt-6.1-sol",reasonCode:"DEFAULT_MODEL_UNAVAILABLE"}]});
 expect(audit.flushed().filter(event=>event.action==="model.fallback_used")).toHaveLength(1);
});

async function runtimeTurnFixture(locked=false,merged=false){
 const {developerIdForSlackUser}=await import("../../packages/broker/src/aws/admin-actions.js");
 const {seedMembership}=await import("../support/developer-task-broker.js");
 const {bedrockClaudeModelIds}=await import("@agentx/model-runtime/catalog");
 const developer={issuer:"https://cell.example/v1/auth",env:"staging",signInTableName:"signin",methods:{slack:true,oidc:false,cloud:false},verifyAccessToken:async()=>({}),channelMembers:async()=>({ok:true as const,memberOf:[]})};
 const {handler,db,audit}=createAuditedSlackBroker({developer});const model={provider:"amazon-bedrock",modelId:bedrockClaudeModelIds("us")[0]!,label:"Primary"};await registerSlackProject(handler,{models:{default:model,approved:bedrockClaudeModelIds("us").map((modelId,index)=>({provider:"amazon-bedrock",modelId,label:`Model ${index}`}))}});
 const {projectSelectionKey}=await import("@agentx/contracts");
 db.set({...projectSelectionKey(TEST_ORG,"payments"),model:{provider:"amazon-bedrock",modelId:bedrockClaudeModelIds("us")[0]!}});
 if(locked)db.set({pk:`ORG#${TEST_ORG}#SETTINGS`,sk:"MODEL_SELECTION_POLICY",entityType:"MODEL_SELECTION_POLICY",orgId:TEST_ORG,version:1,revision:1,rankingVersion:"g3-v1",stepOverrides:{build:{model:{provider:"amazon-bedrock",modelId:bedrockClaudeModelIds("us")[0]!},thinkingLevel:null,locked:true}}});
 const thread=`${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000004`,user="U0123456789",rawActor=developerIdForSlackUser(user),actor=merged?"e".repeat(64):rawActor;
 seedMembership(db,actor,{orgId:TEST_ORG,role:"owner"});
 if(merged)db.set({pk:`DEVELOPER#${rawActor}`,sk:"META",developerId:rawActor,provider:"slack",revoked:false,mergedInto:actor});
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
 const expected=changed==="signature"?{status:409,code:"CALLBACK_FORBIDDEN"}:changed==="global-org"?{status:400,code:"CONFIG_INVALID"}:changed==="sign-in"?{status:403,code:"FORBIDDEN"}:{status:403,code:"MODEL_NOT_ALLOWED"};
 expect(response).toMatchObject({status:expected.status,body:{error:{code:expected.code}}});
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
 expect(response.status).toBe(projectRole==="viewer"?403:200);
 expect(f.audit.flushed().filter(event=>event.action==="model.fallback_used")).toHaveLength(projectRole==="viewer"?0:1);
});
it("rolls back the agentless fallback model, history and audit when identity is withdrawn at commit",async()=>{
 const f=await runtimeTurnFixture(), beforeAudit=f.audit.pending();const {TransactWriteCommand}=await import("@aws-sdk/lib-dynamodb");const {orgMemberKey}=await import("@agentx/contracts");
 const send=f.db.send.bind(f.db);f.db.send=async command=>{if(command instanceof TransactWriteCommand)f.db.delete(orgMemberKey(TEST_ORG,f.actor));return send(command);};
 const response=await call(f.handler,{method:"POST",path:f.path,headers:{"x-agentx-callback-capability":f.invocation.callbackCapability},body:f.body});
 expect(response).toMatchObject({status:400,body:{error:{code:"CONFIG_INVALID"}}});
 expect(f.db.get(`WORKSPACE#${f.workspaceId}`,`OPERATION#${f.operationId}`)?.model).toEqual(f.invocation.payload.model);
 expect(f.db.get(`WORKSPACE#${f.workspaceId}`,`OPERATION#${f.operationId}`)?.modelFallbacks).toBeUndefined();
 expect(f.audit.pending()).toEqual(beforeAudit);
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
 expect(response).toMatchObject({status:409,body:{error:{code:"WORKSPACE_BUSY"}}});
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

it("uses the canonical merged identity at admission and runtime fallback",async()=>{
 const h=await runtimeTurnFixture(false,true);
 expect(h.db.get(`WORKSPACE#${h.workspaceId}`,`OPERATION#${h.operationId}`)?.modelTurnPin).toMatchObject({actorDeveloperId:h.actor});
 const result=await call(h.handler,{method:"POST",path:h.path,headers:{"x-agentx-callback-capability":h.invocation.callbackCapability},body:h.body});
 expect(result.status,JSON.stringify(result.body)).toBe(200);
 expect(h.audit.flushed().filter(event=>event.action==="model.fallback_used")).toHaveLength(1);
});

for(const variant of ["allowed","viewer","binding-race","tasks-disabled","channel-policy-disabled","viewer-race"] as const)it(`channel-only Slack thread sender: ${variant}`,async()=>{
 const viewer=variant==="viewer";
 const {developerIdForSlackUser}=await import("../../packages/broker/src/aws/admin-actions.js");const {seedMembership}=await import("../support/developer-task-broker.js");const {projectMemberKey}=await import("@agentx/contracts");
 const user="U0123456789",actor=developerIdForSlackUser(user);
 let membershipCalls=0;const developer={issuer:"https://cell.example/v1/auth",env:"staging",slackTeamId:SLACK_TEAM,signInTableName:"signin",methods:{slack:true,oidc:false,cloud:false},verifyAccessToken:async()=>({}),channelMembers:async()=>{membershipCalls++;return {ok:true as const,memberOf:[SLACK_CHANNEL]};}};
 const h=createAuditedSlackBroker({developer});await registerSlackProject(h.handler,{developerTasks:{enabled:variant!=="tasks-disabled",channelMembersMayUse:variant!=="channel-policy-disabled"}});seedMembership(h.db,actor,{orgId:TEST_ORG,role:"member"});h.db.set({pk:`DEVELOPER#${actor}`,sk:"META",developerId:actor,provider:"slack",slackUserId:user,revoked:false});
 const thread=`${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000009`,workspace=await ensureWorkspace(h.handler,thread,user),workspaceId=String(workspace.body.workspaceId);markReady(h.db,workspaceId);
  if(viewer)h.db.set({...projectMemberKey(TEST_ORG,actor,"payments"),role:"viewer",projectRole:"viewer",projectName:"payments",ownerKey:actor});
const conversation=await serviceCall(h.handler,thread,user,"POST",`/v1/service/workspaces/${workspaceId}/conversations`,{}),conversationId=(conversation.body.conversation as {id:string}).id;
 if(variant.endsWith("race")) {const original=h.db.send.bind(h.db);h.db.send=async command=>{if(command.constructor.name==="TransactWriteCommand"&&JSON.stringify(command).includes("modelTurnPin")){h.db.send=original;if(variant==="binding-race"){const {slackBindingKey}=await import("@agentx/contracts");const key=slackBindingKey(TEST_ORG,SLACK_TEAM,SLACK_CHANNEL);h.db.set({...h.db.get(key)!,updatedAt:"2026-10-30T20:00:00Z"});}else if(variant==="viewer-race"){h.db.set({...projectMemberKey(TEST_ORG,actor,"payments"),role:"viewer",projectRole:"viewer",projectName:"payments",ownerKey:actor});}else{const {projectRevisionKey}=await import("@agentx/contracts");const key=projectRevisionKey(TEST_ORG,"payments",1),row=h.db.get(key)!;h.db.set({...row,definition:{...(row.definition as object),developerTasks:{enabled:true,channelMembersMayUse:false}}});}}return original(command);};}
 const result=await serviceCall(h.handler,thread,user,"POST",`/v1/service/workspaces/${workspaceId}/tasks`,{requestId:randomUUID(),conversationId,prompt:"Channel work"});
 if(variant.endsWith("race")){expect(result).toMatchObject({status:409,body:{error:{code:"WORKSPACE_BUSY"}}});expect(h.db.find(row=>row.entityType==="OPERATION"&&row.modelTurnPin!==undefined)).toHaveLength(0);}else expect(result.status,JSON.stringify(result.body)).toBe(viewer?403:202);
 expect(membershipCalls).toBe(0);
 if(viewer){const {readTurnActorChecks}=await import("../../packages/broker/src/model-selection/turn-authority.js"),{DeveloperSignInStore}=await import("../../packages/broker/src/developer/store.js");await expect(readTurnActorChecks({documentClient:h.db,tableName:"state",developer,signInStore:new DeveloperSignInStore({documentClient:h.db,tableName:"signin",now:Date.now}),modelSignInTableName:"signin"},{orgId:TEST_ORG,project:"payments",developerId:actor,projectRevision:1,threadChannel:{teamId:SLACK_TEAM,channelId:SLACK_CHANNEL}})).rejects.toMatchObject({code:"MODEL_NOT_ALLOWED"});}
});
it("starts a channel-only developer's first task without a native project grant",async()=>{
 const {createDeveloperTaskBroker,MAYA}=await import("../support/developer-task-broker.js");const h=await createDeveloperTaskBroker();
 const result=await h.dev(MAYA,"POST","/v1/dev/tasks",{requestId:randomUUID(),project:"payments",instructions:"Fix",client:"claude-code"});expect(result.status).toBe(200);
 const task=h.db.get(`DEVTASK#${(result.body.task as {taskId:string}).taskId}`,"META")!,workspaceId=String(task.workspaceId);const active=String(h.db.get(`WORKSPACE#${workspaceId}`,"META")!.activeOperationId);await h.finish(workspaceId,active,"SUCCEEDED");
 const operation=String(h.db.get(`WORKSPACE#${workspaceId}`,"META")!.activeOperationId);expect(h.db.find(row=>row.entityType==="OUTBOX"&&row.operationId===operation)).toHaveLength(1);
});

it("uses and fences the real legacy task identity at turn fallback",async()=>{
 const h=await runtimeTurnFixture(),taskId=randomUUID();const {taskKey,taskPointerKey}=await import("../../packages/broker/src/developer/task-records.js");
 h.db.set({...taskPointerKey(h.workspaceId),taskId});h.db.set({...taskKey(taskId),taskId,orgId:TEST_ORG,workspaceId:h.workspaceId,project:"payments",developerId:h.actor,developerName:"Owner",provider:"slack"});
 const original=h.db.send.bind(h.db);let fenced=false;h.db.send=async command=>{if(command.constructor.name==="TransactWriteCommand"){const input=command.input as {TransactItems?:Array<{ConditionCheck?:{Key?:{pk?:string}}}>};fenced=input.TransactItems?.some(item=>item.ConditionCheck?.Key?.pk===`DEVTASK#${taskId}`)??false;}return original(command);};
 const response=await call(h.handler,{method:"POST",path:h.path,headers:{"x-agentx-callback-capability":h.invocation.callbackCapability},body:h.body});expect(response.status,JSON.stringify(response.body)).toBe(200);expect(fenced).toBe(true);
});

for(const locked of [false,true])it(`keeps a project-chosen ChatGPT model above an unlocked default but refuses an unavailable lock (locked=${locked})`,async()=>{
 const {fakeModelAccess}=await import("../support/fake-model-access.js");const access=fakeModelAccess();access.setOrgSpent(TEST_ORG,0);
 const {handler,db,actor}=await createTurnHarness({modelAccess:{access,proxyUrl:"http://test-proxy.invalid:4000"},chatgpt:{settings:async()=>({enabled:true,preferredModel:"gpt-6.1-sol"}),view:async()=>({connected:true,status:"connected",connectedAt:"2026-10-01T00:00:00.000Z",models:["gpt-6.1-sol"]})}});
 access.setMemberSpent(TEST_ORG,actor,0);
 await registerSlackProject(handler);
 const {AgentStore,resolveAgent}=await import("../../packages/broker/src/agents/store.js");
 const {recipeDigest,projectPlaybookKey}=await import("@agentx/contracts");
 const store=new AgentStore({documentClient:db,tableName:"state",now:Date.now});
 const agent=await store.create({orgId:TEST_ORG,name:"Plan choice",owner:{kind:"project",project:"payments"},accountable:{developerId:actor},extends:"rovara-code",overlay:{steps:{build:{model:{provider:"openai",modelId:"gpt-6.1-sol"}}}},purpose:"process",createdBy:actor});
 const recipe=await resolveAgent(store,TEST_ORG,agent.agentId,"draft");
 await store.publish({orgId:TEST_ORG,agentId:agent.agentId,expectedDraftRevision:agent.draftRevision,digest:recipeDigest(recipe),by:actor});
 db.set({...projectPlaybookKey(TEST_ORG,"payments"),revision:1,defaultProcess:{kind:"project_process",agentId:agent.agentId}});
 db.set({pk:`ORG#${TEST_ORG}#SETTINGS`,sk:"MODEL_SELECTION_POLICY",entityType:"MODEL_SELECTION_POLICY",orgId:TEST_ORG,version:1,revision:1,rankingVersion:"g3-v1",stepOverrides:{build:{model:{provider:"anthropic",modelId:"claude-sonnet-4-6"},thinkingLevel:null,locked}}});
 const thread=`${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000092`,user="U0123456789";
 const workspace=await ensureWorkspace(handler,thread,user),workspaceId=String(workspace.body.workspaceId);markReady(db,workspaceId);
 const conversation=await serviceCall(handler,thread,user,"POST",`/v1/service/workspaces/${workspaceId}/conversations`,{}),conversationId=(conversation.body.conversation as {id:string}).id;
 const result=await serviceCall(handler,thread,user,"POST",`/v1/service/workspaces/${workspaceId}/tasks`,{requestId:randomUUID(),conversationId,prompt:"Fix the project."});
 if(locked){expect(result).toMatchObject({status:409,body:{error:{code:"LOCK_UNSATISFIABLE",stage:"build",fixHref:"/app/admin/how-we-work"}}});return;}
 expect(result.status,JSON.stringify(result.body)).toBe(202);const operationId=(result.body.operation as {id:string}).id;
 const invocation=db.find(row=>row.entityType==="OUTBOX"&&row.operationId===operationId)[0]!.invocation as {callbackCapability:string;payload:{model:unknown}};
 expect(invocation.payload.model).toMatchObject({provider:"openai",modelId:"gpt-6.1-sol"});
 const key=await call(handler,{method:"GET",path:"/v1/internal/model-access",headers:{"x-agentx-callback-capability":invocation.callbackCapability}});
 expect(key.status,JSON.stringify(key.body)).toBe(200);
});
