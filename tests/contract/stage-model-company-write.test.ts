import {expect,it} from "vitest";
import {developerOrgKey,orgMemberKey,orgMetaKey,type OrgId} from "@agentx/contracts";
import {bedrockClaudeModelIds} from "@agentx/model-runtime/catalog";
import {FakeDynamoDb} from "../support/fake-dynamodb.js";
import {capturingAuditDeps} from "../support/audit-capture.js";
import {DeveloperSignInStore} from "../../packages/broker/src/developer/store.js";
import {writeSaferCompanyModelPolicy} from "../../packages/broker/src/model-selection/company-write.js";
const orgId="org_aaaaaaaaaaaaaaaaaaaa" as OrgId,developerId="a".repeat(64),requestId="11111111-1111-4111-8111-111111111111";
const model={provider:"amazon-bedrock",modelId:bedrockClaudeModelIds("us")[0]!},key={pk:`ORG#${orgId}#SETTINGS`,sk:"MODEL_SELECTION_POLICY"};
function fixture(){const db=new FakeDynamoDb(),now=()=>Date.parse("2026-10-30T13:00:00Z");db.set({...orgMemberKey(orgId,developerId),orgId,developerId,role:"owner"});db.set({...developerOrgKey(developerId),orgId,role:"owner"});db.set({...orgMetaKey(orgId),orgId});db.set({pk:`DEVELOPER#${developerId}`,sk:"META",developerId,provider:"oidc",revoked:false,firstSignInAt:"2026-10-01T00:00:00Z",lastSignInAt:"2026-10-01T00:00:00Z"});const capture=capturingAuditDeps({db,now});return {db,capture,deps:{documentClient:db,tableName:"state",routing:{},now,audit:capture.audit,modelSignInTableName:"state",signInStore:new DeveloperSignInStore({documentClient:db,tableName:"state",now})}};}
const body={version:1,requestId,expectedRevision:0,stepOverrides:{build:{model,thinkingLevel:null,locked:true}}};
it("atomically applies a safer company lock with digest-only policy and lock audit events",async()=>{
 const f=fixture();f.capture.queueDown();
 const result=await writeSaferCompanyModelPolicy(f.deps,{orgId,developerId,signedInId:developerId},body);
 expect(result).toMatchObject({version:1,status:"APPLIED",revision:1,requestId});expect(f.db.get(key)?.revision).toBe(1);
 expect(f.capture.recorded().map(e=>e.action)).toEqual(["model_policy.changed","model_policy.lock_set"]);
 for(const event of f.capture.recorded()){expect(event.facts?.policyDigest).toMatch(/^[a-f0-9]{64}$/);expect(JSON.stringify(event.facts)).not.toContain(model.modelId);}
});
it("refuses a policy mutation when audit is unavailable",async()=>{
 const f=fixture(),{audit,...deps}=f.deps;void audit;
 await expect(writeSaferCompanyModelPolicy(deps,{orgId,developerId,signedInId:developerId},body)).rejects.toThrow();expect(f.db.get(key)).toBeUndefined();
});
it("replays the same request without a second policy mutation or audit and rejects changed payload reuse",async()=>{
 const f=fixture(),caller={orgId,developerId,signedInId:developerId};
 const first=await writeSaferCompanyModelPolicy(f.deps,caller,body);
 expect(await writeSaferCompanyModelPolicy(f.deps,caller,body)).toEqual(first);
 expect(f.capture.recorded()).toHaveLength(2);
 await expect(writeSaferCompanyModelPolicy(f.deps,caller,{...body,stepOverrides:{}})).rejects.toMatchObject({code:"IDEMPOTENCY_CONFLICT"});
});
it("refuses commit-time role withdrawal atomically with no policy or audit",async()=>{
 const f=fixture(),send=f.db.send.bind(f.db);let raced=false;
 f.db.send=async command=>{if(!raced&&command.constructor.name==="TransactWriteCommand"){raced=true;f.db.set({...orgMemberKey(orgId,developerId),orgId,developerId,role:"member"});}return send(command);};
 await expect(writeSaferCompanyModelPolicy(f.deps,{orgId,developerId,signedInId:developerId},body)).rejects.toThrow();
 expect(f.db.get(key)).toBeUndefined();expect(f.capture.recorded()).toEqual([]);
});
it("does not expose a less-safe bypass on the internal safer writer",async()=>{
 const f=fixture();f.db.set({...key,orgId,entityType:"MODEL_SELECTION_POLICY",version:1,revision:1,rankingVersion:"g3-v1",stepOverrides:body.stepOverrides});
 await expect(writeSaferCompanyModelPolicy(f.deps,{orgId,developerId,signedInId:developerId},{...body,expectedRevision:1,stepOverrides:{}})).rejects.toMatchObject({code:"FORBIDDEN"});
 expect(f.db.get(key)?.revision).toBe(1);expect(f.capture.recorded()).toEqual([]);
});
