import {expect,it} from "vitest";
import {issueCapability} from "../../packages/broker/src/aws/cancellation.js";
const deps={callbackSigningKey:"test-only-signing-material"};
const claims=(options:Parameters<typeof issueCapability>[4])=>JSON.parse(Buffer.from(issueCapability(deps,"workspace","operation",3,options).split(".")[0]!,"base64url").toString()) as {actions:string[];workspaceId:string;operationId:string;fence:number};
it("grants fallback authority only with a strict stage binding and retains operation scope",()=>{
 expect(claims({chatGptToken:true,modelAccess:true}).actions).not.toContain("model-fallback");
 const bound=claims({modelPolicy:{version:1,stage:"build",companyRevision:2,recipeDigest:"a".repeat(64)}});
 expect(bound).toMatchObject({workspaceId:"workspace",operationId:"operation",fence:3,modelPolicy:{version:1,stage:"build",companyRevision:2,recipeDigest:"a".repeat(64)}});expect(bound.actions).toContain("model-fallback");
 expect(()=>claims({modelPolicy:{version:1}})).toThrow();
});
