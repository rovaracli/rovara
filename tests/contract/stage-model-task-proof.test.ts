import {expect,it} from "vitest";
import {pinnedTaskModelApproval} from "../../packages/broker/src/model-selection/task-proof.js";
import { EMPTY_RECIPE, recipeDigest } from "@rovara-code/contracts";
import {processApprovalRecipeDigest} from "../../packages/broker/src/model-selection/approval-proof.js";
const orgId="org_aaaaaaaaaaaaaaaaaaaa",agentId="agt_aaaaaaaaaaaaaaaaaaaa",project="private-project",registeredAt="2026-10-01T00:00:00.000Z";
const model={provider:"anthropic",modelId:"claude-sonnet-4"};
const recipe={...structuredClone(EMPTY_RECIPE),chain:[{agentId,name:"Process",version:1,builtin:false,process:true as const}]};
const binding={orgId,project,registeredAt,agentId,recipe,digest:recipeDigest(recipe)};
const basePin={version:1,orgId,project,registeredAt,processAgentId:agentId,recipeDigest:binding.digest,policy:{version:1,revision:3,rankingVersion:"g3-v1",stepOverrides:{}},sourcesRevision:2};
const proof={version:1,orgId,project,registeredAt,agentId,recipeDigest:processApprovalRecipeDigest(recipe,agentId),companyRevision:3,approvalId:"apr_aaaaaaaaaaaaaaaaaaaa",exceptions:[{stage:"code_review",model,referenceModel:model}]};
const pin={...basePin,approvalProof:proof};
it("uses only a proof bound to the frozen task recipe and pinned policy",()=>{
 expect(pinnedTaskModelApproval({...binding,pin,stage:"code_review",model,referenceModel:model})).toEqual({model,referenceModel:model});
 for(const change of [{orgId:"org_bbbbbbbbbbbbbbbbbbbb"},{registeredAt:"2026-10-02T00:00:00.000Z"},{project:"other"},{agentId:"agt_bbbbbbbbbbbbbbbbbbbb"},{digest:"0".repeat(64)}]) expect(()=>pinnedTaskModelApproval({...binding,...change,pin,stage:"code_review",model,referenceModel:model})).toThrow();
 expect(pinnedTaskModelApproval({...binding,pin:basePin,stage:"code_review",model,referenceModel:model})).toBeUndefined();
 expect(pinnedTaskModelApproval({...binding,pin:{...pin,approvalProof:{...proof,companyRevision:2}},stage:"code_review",model,referenceModel:model})).toBeUndefined();
 expect(pinnedTaskModelApproval({...binding,pin,stage:"security_review",model,referenceModel:model})).toBeUndefined();
 expect(pinnedTaskModelApproval({...binding,pin,stage:"code_review",model:{...model,modelId:"claude-opus-4"},referenceModel:model})).toBeUndefined();
});

it("cannot grant from a later proof outside the task pin and never waives live resolver constraints",async()=>{
 const injected={...binding,pin:basePin,proof,stage:"code_review" as const,model,referenceModel:model};
 expect(pinnedTaskModelApproval(injected)).toBeUndefined();
 const {resolveStageModel}=await import("../../packages/broker/src/model-selection/resolver.js");
 const sameModelApproval=pinnedTaskModelApproval({...binding,pin,stage:"code_review",model,referenceModel:model});
 const input={orgId,stage:"code_review" as const,sourcesRevision:2,candidates:[{model,sourceId:"rovara",enabled:true,inEffectiveOrder:true,evidence:{orgId,sourcesRevision:2,kind:"rovara_catalog" as const}}],forbidden:[],projectChoice:{model},referenceModel:model,sameModelApproval};
 expect(resolveStageModel(input)).toMatchObject({kind:"resolved",reason:"APPROVED_SAME_MODEL"});
 expect(resolveStageModel({...input,deniedModels:[model]})).toMatchObject({kind:"refusal",code:"MODEL_NOT_VERIFIED"});
 expect(resolveStageModel({...input,sourcesRevision:3})).toMatchObject({kind:"refusal",code:"MODEL_NOT_VERIFIED"});
 expect(resolveStageModel({...input,forbidden:[model]})).toMatchObject({kind:"refusal",code:"MODEL_FORBIDDEN"});
 expect(resolveStageModel({...input,requireDifferentVendor:true})).toMatchObject({kind:"refusal",code:"DIFFERENT_FROM_UNSATISFIABLE"});
});
