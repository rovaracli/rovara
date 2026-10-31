import { expect, it } from "vitest";
import { classifyStageChoiceChange } from "../../packages/broker/src/model-selection/classify.js";
const opus = { provider: "anthropic", modelId: "claude-opus-4" };
const haiku = { provider: "anthropic", modelId: "claude-haiku-4" };
it("uses one classifier for company lock removals and weaker review defaults", () => {
 expect(classifyStageChoiceChange({ kind: "company", before: { build: { model: opus, locked: true } }, after: { build: { model: opus, locked: false } } })).toEqual(["Removes the company model lock for build"]);
 expect(classifyStageChoiceChange({ kind: "company", before: { code_review: { model: opus, locked: false } }, after: { code_review: { model: haiku, locked: false } } })).toContain("Moves the company code_review default to a weaker model");
 expect(classifyStageChoiceChange({ kind: "company", before: { build: { model: opus, locked: false } }, after: { build: { model: opus, locked: true } } })).toEqual([]);
});
it("classifies the existing guardrail model changes with unchanged words", () => {
 expect(classifyStageChoiceChange({ kind: "guardrails", before: { forbiddenModels: [opus], requireCrossCompanyReview: true }, after: { forbiddenModels: [], requireCrossCompanyReview: false } })).toEqual(["Allows the model anthropic/claude-opus-4 again", "Turns off the rule that a review step uses a model from a different AI company"]);
});
it("classifies a new route provider even when the model vendor is unchanged",async()=>{
 const {EMPTY_RECIPE}=await import("../../packages/contracts/src/index.js");
 const before={...structuredClone(EMPTY_RECIPE),steps:[{id:"build",name:"Build",kind:"build" as const,settings:{instructions:[],model:opus}}]};
 const after={...before,steps:[{...before.steps[0]!,settings:{instructions:[],model:{provider:"amazon-bedrock",modelId:"us.anthropic.claude-opus-4-v1:0"}}}]};
 expect(classifyStageChoiceChange({kind:"process",before,after,firstPublish:false})).toEqual(['Lets the step "Build" send data through a new model provider (amazon-bedrock)']);
});
it("uses existing model rules for effective project selection changes",()=>{
 expect(classifyStageChoiceChange({kind:"selection",before:{build:opus},after:{build:opus}})).toEqual([]);
 expect(classifyStageChoiceChange({kind:"selection",before:{build:opus},after:{build:{provider:"amazon-bedrock",modelId:"us.anthropic.claude-opus-4-v1:0"}}})).toContain('Lets the step "build" send data through a new model provider (amazon-bedrock)');
 expect(classifyStageChoiceChange({kind:"selection",before:{code_review:opus},after:{code_review:haiku}})).toContain('Moves the review step "code_review" to a weaker model');
});
