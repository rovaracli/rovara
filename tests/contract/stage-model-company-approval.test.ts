import {expect,it} from "vitest";
import {modelSourcesKey,orgMemberKey,developerOrgKey,orgMetaKey,type OrgId} from "@agentx/contracts";
import {bedrockClaudeModelIds} from "@agentx/model-runtime/catalog";
import {mergeWorld} from "../support/rovara-code-merge-world.js";
import {capturingAuditDeps} from "../support/audit-capture.js";
import {decideApproval} from "../../packages/broker/src/agents/approvals.js";
import {registerAgentApprovals} from "../../packages/broker/src/agents/changes.js";
import {updateCompanyModelPolicy} from "../../packages/broker/src/model-selection/company-approval.js";
const orgId="org_aaaaaaaaaaaaaaaaaaaa" as OrgId,owner="a".repeat(64),admin="b".repeat(64),at="2026-10-30T13:00:00Z",requestId="11111111-1111-4111-8111-111111111111";
const model={provider:"amazon-bedrock",modelId:bedrockClaudeModelIds("us")[0]!},key={pk:`ORG#${orgId}#SETTINGS`,sk:"MODEL_SELECTION_POLICY"};
function fixture(second=true){
 const w=mergeWorld(),now=()=>Date.parse(at),capture=capturingAuditDeps({db:w.db,now});
 // Isolate the company's eligibility roster from the generic fixture.
 for(const row of w.db.find(row=>row.pk===`ORG#${orgId}`&&String(row.sk).startsWith("MEMBER#")))w.db.delete({pk:String(row.pk),sk:String(row.sk)});
 const person=(id:string,role:"owner"|"admin")=>{w.db.set({...orgMemberKey(orgId,id),orgId,developerId:id,role,joinedAt:"2026-10-01T00:00:00Z"});w.db.set({...developerOrgKey(id),orgId,role});w.db.set({pk:`DEVELOPER#${id}`,sk:"META",developerId:id,provider:"oidc",revoked:false,firstSignInAt:at,lastSignInAt:at});};
 person(owner,"owner");if(second)person(admin,"admin");
 w.db.set({...orgMetaKey(orgId),orgId,entityType:"ORG",createdAt:"2026-10-01T00:00:00Z",approvalTrackingSince:"2026-10-01T00:00:00Z",approvalMembershipVersion:7});
 w.db.set({...key,entityType:"MODEL_SELECTION_POLICY",orgId,version:1,revision:1,rankingVersion:"g3-v1",stepOverrides:{build:{model,thinkingLevel:null,locked:true}}});
 const deps={...w.deps,now,audit:capture.audit,modelRouting:{}};registerAgentApprovals();
 return {w,deps,capture};
}
it("creates an existing-flow pending approval and applies lock removal only after another live admin confirms",async()=>{
 const f=fixture(),body={version:1,requestId,expectedRevision:1,stepOverrides:{}};
 const result=await updateCompanyModelPolicy(f.deps,{orgId,developerId:owner,orgRole:"owner"},body);
 expect(result.status).toBe("NEEDS_CONFIRMATION");if(result.status!=="NEEDS_CONFIRMATION")throw Error("approval required");
 expect(f.w.db.get(key)?.revision).toBe(1);
 await expect(decideApproval(f.deps,{orgId,developerId:owner,orgRole:"owner"},result.confirmationId,{requestId:"22222222-2222-4222-8222-222222222222",decision:"APPROVE"})).rejects.toThrow();
 await decideApproval(f.deps,{orgId,developerId:admin,orgRole:"admin"},result.confirmationId,{requestId:"33333333-3333-4333-8333-333333333333",decision:"APPROVE"});
 expect(f.w.db.get(key)?.revision).toBe(2);expect(f.capture.recordedBy("model_policy.lock_removed")).toHaveLength(1);
 expect(f.capture.recordedBy("model_policy.changed")[0]?.facts?.mode).toBe("second_person");
 expect(await updateCompanyModelPolicy(f.deps,{orgId,developerId:owner,orgRole:"owner"},body)).toMatchObject({status:"APPLIED",revision:2});expect(f.capture.recordedBy("model_policy.changed")).toHaveLength(1);
});
it("uses B33's audited sole-owner exception after complete 24-hour history",async()=>{
 const f=fixture(false),result=await updateCompanyModelPolicy(f.deps,{orgId,developerId:owner,orgRole:"owner"},{version:1,requestId,expectedRevision:1,stepOverrides:{}});
 if(result.status!=="NEEDS_CONFIRMATION")throw Error("approval required");
 await decideApproval(f.deps,{orgId,developerId:owner,orgRole:"owner"},result.confirmationId,{requestId:"44444444-4444-4444-8444-444444444444",decision:"APPROVE"});
 expect(f.w.db.get(key)?.revision).toBe(2);expect(f.capture.recordedBy("model_policy.changed")[0]?.facts?.mode).toBe("sole_owner_exception");
});
it("refuses a sole-owner decision inside the shared 24-hour loss window",async()=>{
 const f=fixture(false),meta=orgMetaKey(orgId);f.w.db.set({...f.w.db.get(meta),approvalLastCompanyEligibleLossAt:"2026-10-30T12:59:00Z"});
 const result=await updateCompanyModelPolicy(f.deps,{orgId,developerId:owner,orgRole:"owner"},{version:1,requestId,expectedRevision:1,stepOverrides:{}});
 if(result.status!=="NEEDS_CONFIRMATION")throw Error("approval required");
 await expect(decideApproval(f.deps,{orgId,developerId:owner,orgRole:"owner"},result.confirmationId,{requestId:"55555555-5555-4555-8555-555555555555",decision:"APPROVE"})).rejects.toThrow();
 expect(f.w.db.get(key)?.revision).toBe(1);expect(f.capture.recordedBy("model_policy.changed")).toEqual([]);
});
it("refuses an approval after its bound source revision changes",async()=>{
 const f=fixture(),result=await updateCompanyModelPolicy(f.deps,{orgId,developerId:owner,orgRole:"owner"},{version:1,requestId,expectedRevision:1,stepOverrides:{}});
 if(result.status!=="NEEDS_CONFIRMATION")throw Error("approval required");
 f.w.db.set({...modelSourcesKey(orgId),orgId,entityType:"MODEL_SOURCES",revision:1});
 await decideApproval(f.deps,{orgId,developerId:admin,orgRole:"admin"},result.confirmationId,{requestId:"66666666-6666-4666-8666-666666666666",decision:"APPROVE"});
 expect(f.w.db.get(key)?.revision).toBe(1);expect(f.capture.recordedBy("model_policy.changed")).toEqual([]);
});
