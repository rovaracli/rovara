import {modelSelectionSlackWorld,SELECTION_MODELS} from "../support/model-selection-slack-world.js";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { ProjectDefinitionSchema } from "../../packages/contracts/src/project-node.js";
import { ensureWorkspace, loadSlackBroker, markReady, registerSlackProject, serviceCall, SLACK_CHANNEL, SLACK_TEAM } from "../support/slack-broker.js";

const thread = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000001`;
const otherThread = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000002`;
const user = "U0123456789";
const models = {
  default: { provider: "amazon-bedrock", modelId: SELECTION_MODELS[0]!.modelId, label: "Balanced" },
  approved: [
    { provider: "amazon-bedrock", modelId: SELECTION_MODELS[0]!.modelId, label: "Balanced" },
    { provider: "amazon-bedrock", modelId: SELECTION_MODELS[1]!.modelId, label: "Fast" },
  ],
};

beforeAll(loadSlackBroker);

describe("project worker model selection", () => {
  it("requires a unique approved default and labels", () => {
    const base = {
      name: "payments", revision: 1,
      repositories: [{ name: "demo", url: "https://github.com/example/demo", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
      setup: [], readiness: [], orchestratorInstructions: "Delegate.",
    };
    expect(ProjectDefinitionSchema.safeParse({ ...base, models }).success).toBe(true);
    expect(ProjectDefinitionSchema.safeParse({ ...base, models: { ...models, default: { provider: "x", modelId: "missing" } } }).success).toBe(false);
    expect(ProjectDefinitionSchema.safeParse({ ...base, models: { ...models, approved: [...models.approved, { provider: "x", modelId: "x", label: "FAST" }] } }).success).toBe(false);
  });

  it("stores one project-wide selection beneath the company lock on the next task", async () => {
    const { handler, db } = await modelSelectionSlackWorld();
    await registerSlackProject(handler, { models });
    const workspace = await ensureWorkspace(handler, thread, user);
    const workspaceId = workspace.body.workspaceId as string;
    markReady(db, workspaceId);
    const conversation = await serviceCall(handler, thread, user, "POST", `/v1/service/workspaces/${workspaceId}/conversations`, {});
    const conversationId = (conversation.body.conversation as { id: string }).id;

    const selected = await serviceCall(handler, thread, user, "PUT", "/v1/service/project/model", { provider: "amazon-bedrock", modelId: SELECTION_MODELS[1]!.modelId });
    expect(selected).toMatchObject({ status: 200, body: { projectName: "payments", source: "selection", current: { label: "Fast" } } });
    expect(db.find((item) => item.entityType === "PROJECT_MODEL_SELECTION")).toEqual([expect.objectContaining({
      model: { provider: "amazon-bedrock", modelId: SELECTION_MODELS[1]!.modelId },
      updatedBy: expect.any(String) as string,
      updatedAt: expect.any(String) as string,
    })]);
    const listedElsewhere = await serviceCall(handler, otherThread, user, "GET", "/v1/service/project/models");
    expect(listedElsewhere.body).toMatchObject({ source: "selection", current: { modelId: SELECTION_MODELS[1]!.modelId } });

    const task = await serviceCall(handler, thread, user, "POST", `/v1/service/workspaces/${workspaceId}/tasks`, { requestId: randomUUID(), conversationId, prompt: "test it" });
    expect(task.status).toBe(202);
    const invocation = db.find((item) => item.entityType === "OUTBOX" && item.operationId === (task.body.operation as { id: string }).id)[0]!.invocation as { payload: Record<string, unknown> };
    expect(invocation.payload.model).toEqual({ provider: "amazon-bedrock", modelId: SELECTION_MODELS[0]!.modelId });
  });

  it("rejects unapproved choices while a company lock governs an outdated lower-precedence selection", async () => {
    const { handler, db } = await modelSelectionSlackWorld();
    await registerSlackProject(handler, { models });
    const refused = await serviceCall(handler, thread, user, "PUT", "/v1/service/project/model", { provider: "other", modelId: "unapproved" });
    expect(refused).toMatchObject({ status: 403, body: { error: { code: "MODEL_NOT_ALLOWED" } } });
    await serviceCall(handler, thread, user, "PUT", "/v1/service/project/model", { provider: "amazon-bedrock", modelId: SELECTION_MODELS[1]!.modelId });
    await registerSlackProject(handler, { revision: 2, models: { default: models.default, approved: [models.default] } });

    const workspace = await ensureWorkspace(handler, thread, user);
    const workspaceId = workspace.body.workspaceId as string;
    markReady(db, workspaceId);
    const conversation = await serviceCall(handler, thread, user, "POST", `/v1/service/workspaces/${workspaceId}/conversations`, {});
    const conversationId = (conversation.body.conversation as { id: string }).id;
    const outboxBefore=db.find(item=>item.entityType==="OUTBOX"&&item.workspaceId===workspaceId).length;
    const task = await serviceCall(handler, thread, user, "POST", `/v1/service/workspaces/${workspaceId}/tasks`, { requestId: randomUUID(), conversationId, prompt: "test it" });
    expect(task.status).toBe(202);
    const id=(task.body.operation as {id:string}).id,queued=db.find(item=>item.entityType==="OUTBOX"&&item.operationId===id)[0]!;
    expect((queued.invocation as {payload:unknown}).payload).toMatchObject({model:{provider:models.default.provider,modelId:models.default.modelId},modelPolicy:{stage:"build",companyRevision:1}});
    expect(db.find(item=>item.entityType==="OUTBOX"&&item.workspaceId===workspaceId)).toHaveLength(outboxBefore+1);
  });

  it("keeps the company lock's model and default effort above the approved selection effort", async () => {
    const leveled = {
      default: models.default,
      approved: [models.approved[0]!, { ...models.approved[1]!, thinkingLevel: "low" }],
    };
    const { handler, db } = await modelSelectionSlackWorld();
    await registerSlackProject(handler, { models: leveled });
    const workspace = await ensureWorkspace(handler, thread, user);
    const workspaceId = workspace.body.workspaceId as string;
    markReady(db, workspaceId);
    const conversation = await serviceCall(handler, thread, user, "POST", `/v1/service/workspaces/${workspaceId}/conversations`, {});
    const conversationId = (conversation.body.conversation as { id: string }).id;
    const taskModel = async () => {
      const task = await serviceCall(handler, thread, user, "POST", `/v1/service/workspaces/${workspaceId}/tasks`, { requestId: randomUUID(), conversationId, prompt: "test it" });
      expect(task.status).toBe(202);
      const operationId = (task.body.operation as { id: string }).id;
      const invocation = db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]!.invocation as { payload: Record<string, unknown> };
      // The task is finished so the next one can start on the same workspace.
      markReady(db, workspaceId);
      return invocation.payload.model as Record<string, unknown>;
    };

    // The project default has no level: the key is absent, not undefined.
    const byDefault = await taskModel();
    expect(byDefault).toEqual({ provider: "amazon-bedrock", modelId: SELECTION_MODELS[0]!.modelId });
    expect(Object.keys(byDefault)).not.toContain("thinkingLevel");

    // A member selects by identifier only; the level comes from the approved entry.
    const selected = await serviceCall(handler, thread, user, "PUT", "/v1/service/project/model", { provider: "amazon-bedrock", modelId: SELECTION_MODELS[1]!.modelId });
    expect(selected.status).toBe(200);
    expect(await taskModel()).toEqual({ provider: "amazon-bedrock", modelId: SELECTION_MODELS[0]!.modelId });
  });

  it("carries the governed model for a legacy project and still rejects forged routing", async () => {
    const { handler, db } = await modelSelectionSlackWorld();
    await registerSlackProject(handler);
    const workspace = await ensureWorkspace(handler, thread, user);
    const workspaceId = workspace.body.workspaceId as string;
    markReady(db, workspaceId);
    const conversation = await serviceCall(handler, thread, user, "POST", `/v1/service/workspaces/${workspaceId}/conversations`, {});
    const refused = await serviceCall(handler, thread, user, "POST", `/v1/service/workspaces/${workspaceId}/tasks`, {
      requestId: randomUUID(), conversationId: (conversation.body.conversation as { id: string }).id, prompt: "test it", provider: "attacker-choice",
    });
    expect(refused).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN" } } });
    const task = await serviceCall(handler, thread, user, "POST", `/v1/service/workspaces/${workspaceId}/tasks`, { requestId: randomUUID(), conversationId: (conversation.body.conversation as { id: string }).id, prompt: "test it" });
    const invocation = db.find((item) => item.entityType === "OUTBOX" && item.operationId === (task.body.operation as { id: string }).id)[0]!.invocation as { payload: Record<string, unknown> };
    expect(invocation.payload).toMatchObject({model:{provider:"amazon-bedrock",modelId:SELECTION_MODELS[0]!.modelId},modelPolicy:{stage:"build",companyRevision:1}});
  });
});

it("requires Slack edit_settings even when a contributor may start work",async()=>{
 const {handler,db,developerId}=await modelSelectionSlackWorld();await registerSlackProject(handler,{models});
 const {projectMemberKey}=await import("../../packages/contracts/src/index.js");const {TEST_ORG}=await import("../support/orgs.js");
 const key=projectMemberKey(TEST_ORG,developerId,"payments");db.set({...db.get(key)!,projectRole:"contributor"});
 const result=await serviceCall(handler,thread,user,"PUT","/v1/service/project/model",{provider:models.approved[1]!.provider,modelId:models.approved[1]!.modelId});
 expect(result.status).toBe(403);expect(db.find(item=>item.entityType==="PROJECT_MODEL_SELECTION")).toHaveLength(0);
});

it("refuses an approved but unverified Slack selection without an audit event",async()=>{
 const {handler,db,cap}=await modelSelectionSlackWorld();
 const unknown={provider:"amazon-bedrock",modelId:"unverified-model"};
 await registerSlackProject(handler,{models:{...models,approved:[...models.approved,unknown]}});
 const before=cap.recordedBy("project.model_selection_changed").length;
 const result=await serviceCall(handler,thread,user,"PUT","/v1/service/project/model",unknown);
 expect(result).toMatchObject({status:403,body:{error:{code:"MODEL_NOT_ALLOWED"}}});
 expect(db.find(item=>item.entityType==="PROJECT_MODEL_SELECTION")).toHaveLength(0);
 expect(cap.recordedBy("project.model_selection_changed")).toHaveLength(before);
});

it("without a company lock refuses a stale explicit selection after a later revision",async()=>{
 const {TEST_ORG}=await import("../support/orgs.js"),h=await modelSelectionSlackWorld();
 h.db.delete({pk:`ORG#${TEST_ORG}#SETTINGS`,sk:"MODEL_SELECTION_POLICY"});
 await registerSlackProject(h.handler,{models});
 const {projectSelectionKey}=await import("@agentx/contracts");h.db.set({...projectSelectionKey(TEST_ORG,"payments"),model:{provider:models.approved[1]!.provider,modelId:models.approved[1]!.modelId}});
 await registerSlackProject(h.handler,{revision:2,models:{default:models.default,approved:[models.default]}});
 const workspace=await ensureWorkspace(h.handler,otherThread,user),workspaceId=String(workspace.body.workspaceId);markReady(h.db,workspaceId);
 const conversation=await serviceCall(h.handler,otherThread,user,"POST",`/v1/service/workspaces/${workspaceId}/conversations`,{}),conversationId=(conversation.body.conversation as {id:string}).id;
 const result=await serviceCall(h.handler,otherThread,user,"POST",`/v1/service/workspaces/${workspaceId}/tasks`,{requestId:randomUUID(),conversationId,prompt:"Fix"});
 expect(result).toMatchObject({status:403,body:{error:{code:"MODEL_NOT_ALLOWED"}}});
});
it("without a company lock carries approved thinkingLevel low into the worker",async()=>{
 const {TEST_ORG}=await import("../support/orgs.js"),h=await modelSelectionSlackWorld();
 h.db.delete({pk:`ORG#${TEST_ORG}#SETTINGS`,sk:"MODEL_SELECTION_POLICY"});
 const leveled={default:models.default,approved:[models.approved[0]!,{...models.approved[1]!,thinkingLevel:"low" as const}]};
 await registerSlackProject(h.handler,{models:leveled});
 const {projectSelectionKey}=await import("@agentx/contracts");h.db.set({...projectSelectionKey(TEST_ORG,"payments"),model:{provider:models.approved[1]!.provider,modelId:models.approved[1]!.modelId}});
 const workspace=await ensureWorkspace(h.handler,otherThread,user),workspaceId=String(workspace.body.workspaceId);markReady(h.db,workspaceId);
 const conversation=await serviceCall(h.handler,otherThread,user,"POST",`/v1/service/workspaces/${workspaceId}/conversations`,{}),conversationId=(conversation.body.conversation as {id:string}).id;
 const result=await serviceCall(h.handler,otherThread,user,"POST",`/v1/service/workspaces/${workspaceId}/tasks`,{requestId:randomUUID(),conversationId,prompt:"Fix"});expect(result.status).toBe(202);
 const id=(result.body.operation as {id:string}).id,queued=h.db.find(row=>row.entityType==="OUTBOX"&&row.operationId===id)[0]!;
 expect((queued.invocation as {payload:Record<string,unknown>}).payload.model).toEqual({provider:models.approved[1]!.provider,modelId:models.approved[1]!.modelId,thinkingLevel:"low"});
});
it("without a company lock the legacy project resolver omits a project model",async()=>{
 const {TEST_ORG}=await import("../support/orgs.js"),h=await modelSelectionSlackWorld();
 h.db.delete({pk:`ORG#${TEST_ORG}#SETTINGS`,sk:"MODEL_SELECTION_POLICY"});
 const {resolveProjectModel}=await import("../../packages/broker/src/aws/broker.js");
 const definition=ProjectDefinitionSchema.parse({name:"payments",revision:1,repositories:[{name:"demo",url:"https://github.com/example/demo",path:"repo/demo",defaultBranch:"main",credentialRef:"github-app"}],setup:[],readiness:[],orchestratorInstructions:"Delegate."});
 expect(await resolveProjectModel({documentClient:h.db,tableName:"state"},TEST_ORG,{definition})).not.toHaveProperty("model");
});
