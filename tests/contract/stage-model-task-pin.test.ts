import {modelSourcesKey,orgSettingsKey} from "../../packages/contracts/src/index.js";
import {expect,it} from "vitest";
import {randomUUID} from "node:crypto";
import {createDeveloperTaskBroker,MAYA} from "../support/developer-task-broker.js";
import {TEST_ORG} from "../support/orgs.js";
import {readTaskRecipe} from "../../packages/broker/src/agents/runs.js";
it("pins company policy with the frozen recipe at admission and keeps it after a later edit",async()=>{
 const h=await createDeveloperTaskBroker({brokerExtra:{agents:{}}});
 const key={pk:`ORG#${TEST_ORG}#SETTINGS`,sk:"MODEL_SELECTION_POLICY"};
 const policy={...key,orgId:TEST_ORG,entityType:"MODEL_SELECTION_POLICY",version:1,revision:1,rankingVersion:"g3-v1",stepOverrides:{}};h.db.set(policy);
 const response=await h.dev(MAYA,"POST","/v1/dev/tasks",{requestId:randomUUID(),project:"payments",instructions:"Fix a bug",client:"test"});expect(response.status).toBe(200);
 const taskId=(response.body.task as {taskId:string}).taskId;const row=h.db.get({pk:`DEVTASK#${taskId}`,sk:"RECIPE"})!;
 expect(row.modelPolicyPin).toMatchObject({orgId:TEST_ORG,project:"payments",processAgentId:"rovara-code",recipeDigest:row.digest,policy:{revision:1,stepOverrides:{}},frozenInputs:{projectRevision:1,projectChoices:{}}});
 h.db.set({...policy,revision:2,stepOverrides:{build:{thinkingLevel:"high",locked:false}}});
 expect((await readTaskRecipe({documentClient:h.db,tableName:"state"},taskId,TEST_ORG))?.modelPolicyPin?.policy.revision).toBe(1);
});

it("prepares an immutable policy pin and validates its stored recipe binding independently of admission capacity",async()=>{
 const {prepareTaskModelPolicyPin}=await import("../../packages/broker/src/model-selection/task-pin.js");const {builtinRecipe,recipeDigest}=await import("../../packages/contracts/src/index.js");
 const h=await createDeveloperTaskBroker({brokerExtra:{agents:{}}});const recipe=builtinRecipe("rovara-code",1),digest=recipeDigest(recipe);
 const key={pk:`ORG#${TEST_ORG}#SETTINGS`,sk:"MODEL_SELECTION_POLICY"};const policy={...key,orgId:TEST_ORG,entityType:"MODEL_SELECTION_POLICY",version:1,revision:1,rankingVersion:"g3-v1",stepOverrides:{}};h.db.set(policy);
 const pin=await prepareTaskModelPolicyPin({documentClient:h.db,tableName:"state"},{orgId:TEST_ORG,project:"payments",agentId:"rovara-code",recipe,digest});
 h.db.set({...policy,revision:2});expect(pin.policy.revision).toBe(1);
 const taskId=randomUUID(),taskKey={pk:`DEVTASK#${taskId}`,sk:"RECIPE"};h.db.set({...taskKey,orgId:TEST_ORG,recipe,digest,modelPolicyPin:pin});
 expect((await readTaskRecipe({documentClient:h.db,tableName:"state"},taskId,TEST_ORG))?.modelPolicyPin?.policy.revision).toBe(1);
 h.db.set({...taskKey,orgId:TEST_ORG,recipe,digest,modelPolicyPin:{...pin,recipeDigest:"0".repeat(64)}});
 await expect(readTaskRecipe({documentClient:h.db,tableName:"state"},taskId,TEST_ORG)).rejects.toThrow("pinned model policy could not be verified");
});

for(const variant of ["named","shared","workflow","named-shared-workflow"] as const) it(`keeps ${variant} coding admission within 90 items with both model revision fences`,async()=>{
 const h=await createDeveloperTaskBroker({brokerExtra:{agents:{}}});
 const response=await h.dev(MAYA,"POST","/v1/dev/tasks",{requestId:randomUUID(),project:"payments",instructions:"Fix a bug",client:"test",agent:{agentId:"rovara-code"},...((variant==="shared"||variant==="named-shared-workflow")?{shareToChannel:true}:{}),...((variant==="workflow"||variant==="named-shared-workflow")?{workflow:true,workflowPath:"FULL"}:{})});
 expect(response.status,JSON.stringify(response.body)).toBe(200);
 const taskId=(response.body.task as {taskId:string}).taskId;
 const transactions=h.db.transactions().filter(items=>items.some(item=>{
  const put=item.Put as {Item?:Record<string,unknown>}|undefined;
  return put?.Item?.pk===`DEVTASK#${taskId}`&&put.Item.sk==="RECIPE";
 }));
 expect(transactions).toHaveLength(1);
 const items=transactions[0]!;
 expect(items.length).toBeGreaterThan(25);expect(items.length).toBeLessThanOrEqual(90);
 const keys=items.flatMap(item=>{const check=item.ConditionCheck as {Key?:Record<string,unknown>}|undefined;return check?.Key===undefined?[]:[check.Key];});
 expect(keys).toContainEqual(orgSettingsKey(TEST_ORG,"MODEL_SELECTION_POLICY"));
 expect(keys).toContainEqual(modelSourcesKey(TEST_ORG));
});
