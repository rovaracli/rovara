import {expect,it} from "vitest";
import {getCompanyModelSelectionPolicy} from "../../packages/broker/src/model-selection/company-read.js";
import {FakeDynamoDb} from "../support/fake-dynamodb.js";
import { orgMemberKey, developerOrgKey, orgMetaKey } from "@agentx/cloud-contracts";
import { canonicalModelName, modelNotEnabledSentence } from "@rovara-code/contracts";
const org="org_aaaaaaaaaaaaaaaaaaaa",person="a".repeat(64);
function fixture(role="owner") {const db=new FakeDynamoDb();db.set({...orgMemberKey(org,person),orgId:org,developerId:person,role});db.set({...developerOrgKey(person),orgId:org,role});db.set({...orgMetaKey(org),orgId:org});return {db,deps:{documentClient:db,tableName:"state",now:()=>0,routing:{}},caller:{orgId:org,developerId:person,orgRole:"owner" as const,name:"A",amr:"cloud" as const,sessionId:"fixture"}};}
for(const role of ["owner","admin","member","maintainer","viewer","unknown"]) it(`uses live ${role} authority for company candidates`,async()=>{
 const f=fixture(role);if(role==="owner"||role==="admin"){const result=await getCompanyModelSelectionPolicy(f.deps,f.caller);expect(result.candidates?.build?.length).toBeGreaterThan(0);expect(result.stepOverrides).toEqual({});}else await expect(getCompanyModelSelectionPolicy(f.deps,f.caller)).rejects.toThrow("FORBIDDEN");
});
it("refuses a foreign pointer and closing org without trusting cached owner",async()=>{
 const f=fixture();f.db.set({...developerOrgKey(person),orgId:"org_bbbbbbbbbbbbbbbbbbbb",role:"owner"});await expect(getCompanyModelSelectionPolicy(f.deps,f.caller)).rejects.toThrow("FORBIDDEN");
 const g=fixture();g.db.set({...orgMetaKey(org),orgId:org,closingAt:"now"});await expect(getCompanyModelSelectionPolicy(g.deps,g.caller)).rejects.toThrow("FORBIDDEN");
});
it("exposes the company GET on the actual app router with no unknown query inputs",async()=>{
 const {routeDeveloperRequest}=await import("../../packages/broker/src/aws/developer-routes.js");
 const f=fixture();const deps={...f.deps,developer:{issuer:"https://cell.example/v1/auth",env:"test",signInTableName:"signin",methods:{cloud:true,slack:false,oidc:false},verifyAccessToken:async()=>({}),channelMembers:async()=>({ok:true as const,memberOf:[]})}};
 const path="/v1/app/org/model-selection-policy";
 const result=await routeDeveloperRequest(deps,{method:"GET",path,headers:{},requestId:"model-policy"},new URL(path,"https://cell.example"),{caller:f.caller,csrf:""});
 expect(result).toHaveProperty("candidates.build");
 await expect(routeDeveloperRequest(deps,{method:"GET",path:path+"?orgId=other",headers:{},requestId:"model-policy"},new URL(path+"?orgId=other","https://cell.example"),{caller:f.caller,csrf:""})).rejects.toThrow("CONFIG_INVALID");
});

it("marks the Rovara catalog models the account cannot call, with the broker's words, and no others",async()=>{
 const f=fixture(),plain=await getCompanyModelSelectionPolicy(f.deps,f.caller),refused=plain.candidates!.build![0]!;
 expect(plain.candidates!.build!.every(candidate=>candidate.unusableReason===undefined)).toBe(true);
 const marked=await getCompanyModelSelectionPolicy({...f.deps,routing:{usableModels:{unusable:async()=>new Set([canonicalModelName(refused.model)]),markUnusable:async()=>undefined}}},f.caller);
 const list=marked.candidates!.build!;
 expect(list.find(candidate=>candidate.model.modelId===refused.model.modelId)?.unusableReason).toBe(modelNotEnabledSentence(undefined,undefined));
 expect(list.filter(candidate=>candidate.unusableReason!==undefined)).toHaveLength(1);
});
