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
