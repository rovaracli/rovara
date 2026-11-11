import {expect,it} from "vitest";
import {resolvePinnedTaskStage} from "../../packages/broker/src/model-selection/task-runtime.js";
import { builtinRecipe, recipeDigest } from "@rovara-code/contracts";
const orgId="org_aaaaaaaaaaaaaaaaaaaa",project="payments",agentId="rovara-code",registeredAt="2026-10-01T00:00:00.000Z";
const model={provider:"anthropic",modelId:"claude-sonnet-4"},other={provider:"anthropic",modelId:"claude-opus-4"};
const recipe=builtinRecipe(agentId,1),digest=recipeDigest(recipe);
const pin={version:1,orgId,project,registeredAt,processAgentId:agentId,recipeDigest:digest,policy:{version:1,revision:3,rankingVersion:"g3-v1",stepOverrides:{build:{model,locked:false}}},sourcesRevision:2,frozenInputs:{projectRevision:1,projectChoices:{},recipeDefaults:{},clearedFallbacks:[],projectSelection:other}};
const candidates=[model,other].map(model=>({model,sourceId:"rovara",enabled:true,inEffectiveOrder:true,evidence:{orgId,sourcesRevision:2,kind:"rovara_catalog" as const}}));
const input={orgId,project,agentId,registeredAt,recipe,digest,pin,stage:"build" as const,live:{sourcesRevision:2,candidates,forbidden:[]},priorModels:{},builtinDefault:other};
it("uses pinned company policy ahead of project selection and explicit project choices inside limits",()=>{
 expect(resolvePinnedTaskStage(input)).toMatchObject({kind:"resolved",model,reason:"COMPANY_DEFAULT"});
 expect(resolvePinnedTaskStage({...input,pin:{...pin,frozenInputs:{...pin.frozenInputs,projectChoices:{build:{model:other}}}}})).toMatchObject({kind:"resolved",model:other,reason:"PROJECT_CHOICE"});
 expect(resolvePinnedTaskStage({...input,pin:{...pin,policy:{...pin.policy,stepOverrides:{build:{model,thinkingLevel:null,locked:true}}},frozenInputs:{...pin.frozenInputs,projectChoices:{build:{model:other}}}}})).toMatchObject({kind:"resolved",model,reason:"COMPANY_LOCK"});
});
it("uses live evidence and task denial, and refuses unverifiable task identity or legacy origins",()=>{
 expect(resolvePinnedTaskStage({...input,live:{...input.live,candidates:[]}})).toMatchObject({kind:"refusal"});
 expect(resolvePinnedTaskStage({...input,live:{...input.live,deniedModels:[model]}})).toMatchObject({kind:"refusal"});
 expect(()=>resolvePinnedTaskStage({...input,registeredAt:"2026-10-02T00:00:00.000Z"})).toThrow();
 const legacy={...pin,frozenInputs:undefined};
 expect(()=>resolvePinnedTaskStage({...input,pin:legacy})).toThrow();
});
it("checking stages require actual prior Build or Plan and preserve the shared review setting",()=>{
 const reviewPin={...pin,policy:{...pin.policy,stepOverrides:{}},frozenInputs:{...pin.frozenInputs,projectChoices:{code_review:{model:other},security_review:{model:other}}}};
 expect(resolvePinnedTaskStage({...input,pin:reviewPin,stage:"code_review",priorModels:{build:model}})).toMatchObject({kind:"resolved",model:other});
 expect(resolvePinnedTaskStage({...input,pin:reviewPin,stage:"security_review",priorModels:{build:other}})).toMatchObject({kind:"refusal",code:"DIFFERENT_FROM_UNSATISFIABLE"});
 expect(resolvePinnedTaskStage({...input,pin:reviewPin,stage:"code_review"})).toMatchObject({kind:"refusal",code:"MODEL_NOT_VERIFIED"});
});

it("keeps runtime source revision live and preserves explicit refusal without a configured fallback",()=>{
 const next=candidates.map(candidate=>({...candidate,evidence:{...candidate.evidence,sourcesRevision:4}}));
 expect(resolvePinnedTaskStage({...input,live:{...input.live,sourcesRevision:4,candidates:next}})).toMatchObject({kind:"resolved",model});
 expect(resolvePinnedTaskStage({...input,live:{...input.live,sourcesRevision:4}})).toMatchObject({kind:"refusal"});
 const configured={...pin,policy:{...pin.policy,stepOverrides:{build:{model,fallbackModel:other,locked:false}}}};
 expect(resolvePinnedTaskStage({...input,pin:configured,live:{...input.live,candidates:[candidates[1]!]}})).toMatchObject({kind:"resolved",model:other,fallback:{reasonCode:"CONFIGURED_FALLBACK"}});
 const cleared={...configured,frozenInputs:{...pin.frozenInputs,clearedFallbacks:["build"]}};
 expect(resolvePinnedTaskStage({...input,pin:cleared,live:{...input.live,candidates:[candidates[1]!]}})).toMatchObject({kind:"refusal"});
});

it("keeps the project default as an audited fallback when the personal default becomes forbidden",()=>{
 const defaultPin={...pin,policy:{...pin.policy,stepOverrides:{}},frozenInputs:{...pin.frozenInputs,projectSelection:undefined,projectModels:{default:model,approved:[model,other]}}};
 expect(resolvePinnedTaskStage({...input,pin:defaultPin,defaultPreferred:other,live:{...input.live,forbidden:[other]}})).toMatchObject({kind:"resolved",model,fallback:{reasonCode:"DEFAULT_MODEL_UNAVAILABLE"}});
});

it("returns a non-retryable refusal for split pinned review company locks",()=>{
 const split={...pin,policy:{...pin.policy,stepOverrides:{code_review:{model,thinkingLevel:null,locked:true},security_review:{model:other,thinkingLevel:null,locked:true}}}};
 expect(resolvePinnedTaskStage({...input,pin:split,stage:"code_review",priorModels:{build:other}})).toEqual({kind:"refusal",code:"LOCK_UNSATISFIABLE"});
});
