import {expect,it} from "vitest";
import {criticFailures,reviewFailures} from "../../packages/broker/src/model-selection/task-failures.js";
const model={provider:"openai",modelId:"gpt-6.1-sol"};
it("shares actual critic and review model refusals without counting unrelated failures",()=>{
 const rows=[{workflowMode:"PLAN_CRITIQUE",status:"FAILED",error:"MODEL_NOT_ALLOWED: refused",model,createdAt:"2026-10-30T00:00:00Z"},{workflowMode:"REVIEW",status:"SUCCEEDED",result:{workflowReviews:[{provider:model.provider,version:model.modelId,modelFailure:"the model call failed: key-rejected"}]},createdAt:"2026-10-30T00:00:00Z"},{workflowMode:"PLAN_CRITIQUE",status:"FAILED",error:"tests failed",model}];
 expect(criticFailures(rows,undefined)).toEqual({models:[model],sinceLatestPlan:1});
 expect(reviewFailures(rows,undefined)).toEqual({models:[model],sinceLatestBuild:1});
});
