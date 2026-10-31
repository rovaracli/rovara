import {routeStep} from "../../packages/broker/src/agents/dispatch.js";
import {expect,it} from "vitest";
import {routeTaskFallback} from "../../packages/broker/src/model-selection/fallback-route.js";
const model={provider:"amazon-bedrock",modelId:"us.anthropic.claude-sonnet-4-6"};
const input={orgId:"org_aaaaaaaaaaaaaaaaaaaa",project:"payments",agent:"rovara-code",stage:"build",model,sourceId:"rovara"} as const;
it("uses the existing router and refuses disagreement with the resolver source",async()=>{
 expect(await routeTaskFallback({},input)).toBeUndefined();
 await expect(routeTaskFallback({},{...input,sourceId:"src_aaaaaaaaaaaaaaaaaaaa"})).rejects.toThrow();
});
it("preserves an existing verified company Bedrock route and refuses its removal",async()=>{
 const sourceId="src_aaaaaaaaaaaaaaaaaaaa";
 const source={sourceId,kind:"bedrock" as const,label:"Fixture",roleArn:"arn:aws:iam::123456789012:role/test",region:"us-east-1",externalId:`rovara-${input.orgId}`,tested:true,models:[{catalog:model}]};
 const stored={sources:[source],order:[sourceId],credentials:[],removing:[] as Array<{sourceId:string;kind:"bedrock"}>,revision:1};
 const deps={sources:{read:async()=>stored},launch:{kinds:["bedrock" as const]}};
 const result=await routeTaskFallback(deps,{...input,sourceId});
 expect(result?.sourceId).toBe(sourceId);expect(result?.wire.alias).toBeTruthy();
 source.tested=false;
 await expect(routeTaskFallback(deps,{...input,sourceId})).rejects.toThrow();
});

it("refuses a first dispatch whose live source differs from the resolver decision",async()=>{
 const requested={...input,step:"build",expectedSourceId:"src_aaaaaaaaaaaaaaaaaaaa"};
 await expect(routeStep({},requested)).rejects.toMatchObject({code:"MODEL_NOT_ALLOWED"});
 await expect(routeStep({},{...requested,expectedSourceId:"rovara"})).resolves.toMatchObject({keepChatgpt:false,route:{sourceId:"rovara"}});
});

it("routes a governed configured fallback past a source whose key was removed",async()=>{
 const sourceId="src_aaaaaaaaaaaaaaaaaaaa";
 const stored={sources:[{sourceId,kind:"anthropic" as const,label:"Fixture",models:[{catalog:{provider:"anthropic",modelId:"claude-sonnet-4-6"}}]}],order:[sourceId,"rovara"],credentials:[] as string[],removing:[],revision:2};
 const deps={sources:{read:async()=>stored},launch:{kinds:["anthropic" as const]}};
 await expect(routeStep(deps,{...input,step:"plan",expectedSourceId:"rovara"})).resolves.toMatchObject({route:{sourceId:"rovara"}});
 stored.credentials.push(sourceId);
 await expect(routeStep(deps,{...input,step:"plan",expectedSourceId:"rovara"})).rejects.toMatchObject({code:"MODEL_NOT_ALLOWED"});
});
