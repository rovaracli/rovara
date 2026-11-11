import {expect,it} from "vitest";
import { orgMetaKey } from "@agentx/cloud-contracts";
import {bedrockClaudeModelIds} from "@agentx/model-runtime/catalog";
import {createAdminBroker} from "../support/admin-broker.js";
import {seedMembership} from "../support/developer-task-broker.js";
import {capturingAuditDeps} from "../support/audit-capture.js";
import {TEST_ORG} from "../support/orgs.js";
import {APP_CSRF_HEADER,appCsrfTokenFor} from "../../packages/broker/src/developer/app-csrf.js";
import type {DeveloperApiConfiguration} from "../../packages/broker/src/aws/developer-routes.js";
const CELL="https://cell.example",WHO="a".repeat(64),SID="11111111-1111-4111-8111-111111111111",path="/v1/web/org/model-selection-policy";
const model={provider:"amazon-bedrock",modelId:bedrockClaudeModelIds("us")[0]!};
async function fixture(role:"owner"|"admin"|"member"="owner"){
 const developer:DeveloperApiConfiguration={issuer:`${CELL}/v1/auth`,env:"staging",signInTableName:"signin",methods:{slack:false,oidc:false,cloud:true},verifyAccessToken:async()=>({}),channelMembers:async()=>({ok:true,memberOf:[]})};
 const audit=capturingAuditDeps(),h=await createAdminBroker({developer,extra:{cloud:true,audit:audit.audit,agents:{}}});audit.attach(h.db);audit.audit.documentClient=h.db as never;
 seedMembership(h.db,WHO,{orgId:TEST_ORG,role});h.db.set({...orgMetaKey(TEST_ORG),orgId:TEST_ORG,name:"Company",plan:"team"});
 h.db.set({pk:`DEVELOPER#${WHO}`,sk:"META",developerId:WHO,provider:"cloud",revoked:false});h.db.set({pk:`SESSION#${SID}`,sk:"META",sessionId:SID,developerId:WHO,amr:"cloud",startedAt:new Date(Date.now()-60000).toISOString(),endsAt:Date.now()/1000+3600,reviewExpiresAt:Date.now()/1000+3600});
 const call=async(body:unknown,csrf=true)=>{const r=await h.handler({version:"2.0",rawPath:path,routeKey:"ANY /v1/web/{proxy+}",headers:{cookie:`__Host-agentx_review_session=${SID}`,origin:CELL,...(csrf?{[APP_CSRF_HEADER]:appCsrfTokenFor(SID)}:{})},body:JSON.stringify(body),requestContext:{requestId:"gateway-trace",http:{method:"PUT"}}});return {status:r.statusCode,body:JSON.parse(r.body) as Record<string,unknown>};};
 return {...h,audit,call};
}
const first={version:1,requestId:"22222222-2222-4222-8222-222222222222",expectedRevision:0,stepOverrides:{build:{model,thinkingLevel:null,locked:true}}};
it("applies a company lock with HTTP200 and returns existing-flow HTTP202 when removing it",async()=>{
 const f=await fixture();const applied=await f.call(first);expect(applied.status,JSON.stringify(applied.body)).toBe(200);expect(applied.body).toMatchObject({status:"APPLIED",revision:1});
 const pending=await f.call({version:1,requestId:"33333333-3333-4333-8333-333333333333",expectedRevision:1,stepOverrides:{}});expect(pending.status,JSON.stringify(pending.body)).toBe(202);expect(pending.body).toMatchObject({status:"NEEDS_CONFIRMATION",code:"REAUTH_REQUIRED"});expect(String(pending.body.confirmUrl)).toContain("/v1/app/approve/apr_");
});
it("refuses missing CSRF and member role before changing policy",async()=>{
 const owner=await fixture();expect((await owner.call(first,false)).status).toBe(403);expect(owner.audit.recordedBy("model_policy.changed")).toEqual([]);
 const member=await fixture("member");expect((await member.call(first)).status).toBe(403);expect(member.audit.recordedBy("model_policy.changed")).toEqual([]);
});
it("refuses token writes and client-supplied company or approval authority",async()=>{
 const f=await fixture();
 const token=await f.handler({version:"2.0",rawPath:"/v1/app/org/model-selection-policy",headers:{authorization:"Bearer synthetic"},body:JSON.stringify(first),requestContext:{http:{method:"PUT"}}});expect(token.statusCode).toBe(403);
 for(const extra of [{orgId:"org_bbbbbbbbbbbbbbbbbbbb"},{approved:true},{confirmationId:"apr_untrusted"}])expect((await f.call({...first,...extra})).status).toBe(400);
 expect(f.audit.recordedBy("model_policy.changed")).toEqual([]);
});
it("returns a bounded 202 summary when a seven-stage policy has many less-safe changes",async()=>{
 const f=await fixture(),stages=["understand","plan","plan_check","build","code_review","security_review","pull_request"];
 const previous=Object.fromEntries(stages.map(stage=>[stage,{model:{provider:"anthropic",modelId:"claude-sonnet-4-6"},thinkingLevel:null,locked:true}]));
 f.db.set({pk:`ORG#${TEST_ORG}#SETTINGS`,sk:"MODEL_SELECTION_POLICY",orgId:TEST_ORG,entityType:"MODEL_SELECTION_POLICY",version:1,revision:1,rankingVersion:"g3-v1",stepOverrides:previous});
 const reviewModel={provider:"amazon-bedrock",modelId:bedrockClaudeModelIds("us")[1]!};
 const next=Object.fromEntries(stages.map(stage=>[stage,{model:["plan_check","code_review","security_review"].includes(stage)?reviewModel:model,thinkingLevel:null,locked:true}]));
 const response=await f.call({version:1,requestId:"44444444-4444-4444-8444-444444444444",expectedRevision:1,stepOverrides:next});
 expect(response.status,JSON.stringify(response.body)).toBe(202);expect(response.body.changes).toBeInstanceOf(Array);expect((response.body.changes as unknown[]).length).toBeLessThanOrEqual(10);
});
it("replays an identical successful cookie PUT once without another policy audit",async()=>{
 const f=await fixture(),one=await f.call(first),two=await f.call(first);
 expect(one.status).toBe(200);expect(two.status,JSON.stringify(two.body)).toBe(200);expect(two.body).toEqual(one.body);expect(f.audit.recordedBy("model_policy.changed")).toHaveLength(1);
});
it("refuses company policy when changing only Build makes existing review defaults use Build's model",async()=>{
 const f=await fixture(),models=bedrockClaudeModelIds("us"),a={provider:"amazon-bedrock",modelId:models[0]!},b={provider:"amazon-bedrock",modelId:models[1]!};
 const old={build:{model:a,locked:false},code_review:{model:b,locked:false},security_review:{model:b,locked:false}};
 f.db.set({pk:`ORG#${TEST_ORG}#SETTINGS`,sk:"MODEL_SELECTION_POLICY",orgId:TEST_ORG,entityType:"MODEL_SELECTION_POLICY",version:1,revision:1,rankingVersion:"g3-v1",stepOverrides:old});
 const response=await f.call({version:1,requestId:"55555555-5555-4555-8555-555555555555",expectedRevision:1,stepOverrides:{...old,build:{model:b,locked:false}}});expect(response.status,JSON.stringify(response.body)).toBe(403);expect(response.body.error).toMatchObject({reason:"DIFFERENT_FROM_UNSATISFIABLE",fixHref:"/app/admin/how-we-work"});
});
it("refuses company-level same-model review with a fixed code and How we work link",async()=>{
 const f=await fixture(),choice={model,thinkingLevel:null,locked:true};
 const response=await f.call({...first,stepOverrides:{build:choice,code_review:choice,security_review:choice}});
 expect(response.status).toBe(403);expect(response.body.error).toMatchObject({code:"MODEL_NOT_ALLOWED",reason:"DIFFERENT_FROM_UNSATISFIABLE",fixHref:"/app/admin/how-we-work"});expect(f.audit.recordedBy("model_policy.changed")).toEqual([]);
});
it("fills soleOwner in the 202 response from shared eligibility and cool-off evidence",async()=>{
 for(const cooling of [false,true]){
  const f=await fixture(),loss=Date.now()-60000;
  f.db.set({...orgMetaKey(TEST_ORG),orgId:TEST_ORG,name:"Company",plan:"team",createdAt:"2026-10-01T00:00:00.000Z",approvalTrackingSince:"2026-10-01T00:00:00.000Z",approvalMembershipVersion:7,...(cooling?{approvalLastCompanyEligibleLossAt:new Date(loss).toISOString()}: {})});
  expect((await f.call(first)).status).toBe(200);
  const response=await f.call({version:1,requestId:"66666666-6666-4666-8666-666666666666",expectedRevision:1,stepOverrides:{}});
  expect(response.status).toBe(202);expect(response.body.soleOwner).toEqual(cooling?{available:false,availableAt:new Date(loss+86400000).toISOString(),reasonCode:"SOLE_OWNER_COOL_OFF"}:{available:true,availableAt:null,reasonCode:"SOLE_OWNER_EXCEPTION_AVAILABLE"});
 }
});
