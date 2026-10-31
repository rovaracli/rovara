import {TransactWriteCommand} from "@aws-sdk/lib-dynamodb";
import {FakeDynamoDb} from "../support/fake-dynamodb.js";
import {expect,it} from "vitest";
import {taskStageReferences,scopedTaskOperations,taskStageReferenceChecks} from "../../packages/broker/src/model-selection/task-references.js";
const scope={orgId:"org_aaaaaaaaaaaaaaaaaaaa",workspaceId:"workspace",conversationId:"task-conversation",taskId:"task-1"};
const model={provider:"openai",modelId:"gpt-6.1-sol"};
const row={...scope,entityType:"OPERATION",kind:"task",workflowMode:"IMPLEMENT",createdAt:"2026-10-29T00:00:00Z",model};
it("uses actual scoped operation models and never guesses a missing reference",()=>{
 expect(taskStageReferences([row],scope)).toEqual({build:model});
 expect(taskStageReferences([{...row,model:undefined}],scope)).toEqual({});
 expect(taskStageReferences([{...row,orgId:"org_bbbbbbbbbbbbbbbbbbbb"},{...row,workspaceId:"other"}],scope)).toEqual({});
 expect(taskStageReferences([row,{...row,createdAt:"2026-10-30T00:00:00Z",model:undefined}],scope)).toEqual({});
});

it("keeps retry history inside the same company/workspace task-operation scope",()=>{
 expect(scopedTaskOperations([row,{...row,orgId:"org_bbbbbbbbbbbbbbbbbbbb"},{...row,workspaceId:"other"},{...row,kind:"prepare"}],scope)).toEqual([row]);
});

it("fences the actual Build model used by review independence",async()=>{
 const db=new FakeDynamoDb();const operation={...row,id:"build-op",pk:`WORKSPACE#${scope.workspaceId}`,sk:"OPERATION#build-op"};db.set(operation);
 const checks=taskStageReferenceChecks("state",[operation],scope,"code_review");
 expect(checks).toHaveLength(1);db.set({...operation,model:{provider:"anthropic",modelId:"claude-sonnet-4-6"}});
 await expect(db.send(new TransactWriteCommand({TransactItems:checks}))).rejects.toThrow();
 expect(taskStageReferenceChecks("state",[],scope,"build")).toEqual([]);
});

it("excludes other task conversations from references, retry history and reference fences",()=>{
 const other={...row,id:"other-plan",workflowMode:"PLAN",conversationId:"other-conversation",createdAt:"2026-10-30T00:00:00Z"};
 expect(scopedTaskOperations([row,other],scope)).toEqual([row]);
 expect(taskStageReferences([row,other],scope)).toEqual({build:model});
 expect(()=>taskStageReferenceChecks("state",[other],scope,"plan_check")).toThrow();
});

it("reviews the latest successful Build rather than a later failed Build",async()=>{
 const built={...row,id:"built",pk:`WORKSPACE#${scope.workspaceId}`,sk:"OPERATION#built",status:"SUCCEEDED"};
 const failed={...built,id:"failed",sk:"OPERATION#failed",createdAt:"2026-10-30T00:00:00Z",status:"FAILED",model:{provider:"anthropic",modelId:"claude-sonnet-4-6"}};
 expect(taskStageReferences([built,failed],scope)).toEqual({build:model});
 const checks=taskStageReferenceChecks("state",[built,failed],scope,"code_review");
 expect(checks[0]?.ConditionCheck?.Key).toEqual({pk:built.pk,sk:built.sk});
 const db=new FakeDynamoDb();db.set({...built,status:"FAILED"});db.set(failed);
 await expect(db.send(new TransactWriteCommand({TransactItems:checks}))).rejects.toThrow();
});

it("retains this task's side-conversation critic history while isolating actual Plan/Build references",()=>{
 const critic={...row,workflowMode:"PLAN_CRITIQUE",conversationId:"critic-side",modelTaskId:scope.taskId};
 const foreign={...critic,modelTaskId:"other-task"};
 const foreignPlan={...critic,workflowMode:"PLAN"};
 expect(scopedTaskOperations([critic,foreign],scope)).toEqual([critic]);
 expect(taskStageReferences([row,foreignPlan],scope)).toEqual({build:model});
});

it("refuses a reference whose task binding changes after selection",async()=>{
 const db=new FakeDynamoDb();const operation={...row,id:"bound-build",pk:`WORKSPACE#${scope.workspaceId}`,sk:"OPERATION#bound-build",modelTaskId:scope.taskId};
 db.set(operation);const checks=taskStageReferenceChecks("state",[operation],scope,"code_review");
 db.set({...operation,modelTaskId:"other-task"});
 await expect(db.send(new TransactWriteCommand({TransactItems:checks}))).rejects.toThrow();
});
