import {expect,it} from "vitest";
import {frozenRecipeModelInputs,stageChoiceOf} from "../../packages/broker/src/model-selection/stage-inputs.js";
import { builtinRecipe, recipeDigest, projectSelectionKey, projectRevisionKey } from "@rovara-code/contracts";
import {prepareTaskModelPolicyPin} from "../../packages/broker/src/model-selection/task-pin.js";
import {createDeveloperTaskBroker} from "../support/developer-task-broker.js";
import {TEST_ORG} from "../support/orgs.js";
const model={provider:"anthropic",modelId:"claude-sonnet-4"};
const other={provider:"anthropic",modelId:"claude-opus-4"};
it("keeps project fields distinct from recipe defaults and preserves shared groups/null clears",()=>{
 const recipe=builtinRecipe("rovara-code",1);recipe.steps.find(step=>step.kind==="plan")!.settings.model=model;
 const inputs=frozenRecipeModelInputs(recipe,{steps:{plan:{thinkingLevel:"low"},review:{fallbackModel:null,differentCompanyFrom:null}}});
 expect(inputs.projectChoices.plan).toEqual({thinkingLevel:"low"});expect(inputs.projectChoices.understand).toEqual({thinkingLevel:"low"});expect(inputs.recipeDefaults.plan?.model).toEqual(model);
 expect(inputs.projectChoices.code_review?.differentFrom).toEqual({stage:"build",level:"model"});expect(inputs.clearedFallbacks).toEqual(["code_review","security_review"]);
});
it("freezes the exact starting project revision, model selection and defaults in the existing pin",async()=>{
 const h=await createDeveloperTaskBroker();const key=projectRevisionKey(TEST_ORG,"payments",1);const row=h.db.get(key)!;const definition=row.definition as Record<string,unknown>;
 h.db.set({...row,definition:{...definition,models:{default:model,approved:[model,other]}}});
 h.db.set({...projectSelectionKey(TEST_ORG,"payments"),model:other});
 const recipe=builtinRecipe("rovara-code",1),digest=recipeDigest(recipe);
 const pin=await prepareTaskModelPolicyPin({documentClient:h.db,tableName:"state"},{orgId:TEST_ORG,project:"payments",projectRevision:1,agentId:"rovara-code",recipe,digest});
 h.db.set({...projectSelectionKey(TEST_ORG,"payments"),model});
 expect(pin.frozenInputs).toMatchObject({projectRevision:1,projectModels:{default:model,approved:[model,other]},projectSelection:other,projectChoices:{}});
});

it("refuses malformed explicit model fields rather than inheriting recipe defaults",()=>{
 const recipe=builtinRecipe("rovara-code",1);
 for(const raw of [{model:{provider:"anthropic"}},{fallbackModel:{modelId:"claude-sonnet-4"}}])expect(()=>stageChoiceOf(raw,"build",recipe)).toThrow("model settings could not be read");
});
