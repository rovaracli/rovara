import {expect,it} from "vitest";
import {TransactWriteCommand} from "@aws-sdk/lib-dynamodb";
import { developerOrgKey, orgMemberKey, orgMetaKey } from "@agentx/cloud-contracts";
import { type OrgId } from "@rovara-code/contracts";
import {requireCompanyModelPolicyAuthority} from "../../packages/broker/src/model-selection/company-read.js";
import {mergeWorld} from "../support/rovara-code-merge-world.js";
const orgId="org_aaaaaaaaaaaaaaaaaaaa" as OrgId,developerId="a".repeat(64);
it("returns live company-authority fences that refuse role, pointer and closure races atomically",async()=>{
 for(const role of ["owner","admin"] as const)for(const race of ["none","member","pointer","closing","closed"]){
  const w=mergeWorld(),member=orgMemberKey(orgId,developerId),pointer=developerOrgKey(developerId),org=orgMetaKey(orgId);
  w.db.set({...member,orgId,developerId,role});w.db.set({...pointer,orgId,role});w.db.set({...org,orgId});
  const checks=await requireCompanyModelPolicyAuthority({tableName:"state",documentClient:w.db},{orgId,developerId});
  expect(checks).toHaveLength(3);
  if(race==="member")w.db.set({...member,orgId,developerId,role:"member"});
  if(race==="pointer")w.db.set({...pointer,orgId:"org_bbbbbbbbbbbbbbbbbbbb",role});
  if(race==="closing"||race==="closed")w.db.set({...org,orgId,[race==="closing"?"closingAt":"closedAt"]:"2026-10-30T00:00:00.000Z"});
  const command=new TransactWriteCommand({TransactItems:[...checks,{Put:{TableName:"state",Item:{pk:"POLICY_FENCE_TEST",sk:"META"}}}]});
  if(race==="none"){await w.db.send(command);expect(w.db.get("POLICY_FENCE_TEST","META")).toBeDefined();}
  else {await expect(w.db.send(command)).rejects.toThrow();expect(w.db.get("POLICY_FENCE_TEST","META")).toBeUndefined();}
 }
});
it("denies non-admin roles, mismatched company identities, deleted membership and closed companies before returning fences",async()=>{
 for(const state of ["member","guest","operator","missing","foreign-member","foreign-pointer","role-mismatch","closing","closed"]){
  const w=mergeWorld(),member=orgMemberKey(orgId,developerId),pointer=developerOrgKey(developerId),org=orgMetaKey(orgId);
  const foreign="org_bbbbbbbbbbbbbbbbbbbb";
  if(state!=="missing")w.db.set({...member,orgId:state==="foreign-member"?foreign:orgId,developerId,role:["member","guest","operator"].includes(state)?state:"owner"});
  w.db.set({...pointer,orgId:state==="foreign-pointer"?foreign:orgId,role:state==="role-mismatch"?"admin":"owner"});
  w.db.set({...org,orgId,...(state==="closing"?{closingAt:"2026-10-30T00:00:00.000Z"}:{}),...(state==="closed"?{closedAt:"2026-10-30T00:00:00.000Z"}:{})});
  await expect(requireCompanyModelPolicyAuthority({tableName:"state",documentClient:w.db},{orgId,developerId})).rejects.toMatchObject({code:"FORBIDDEN"});
  expect(w.db.get("POLICY_FENCE_TEST","META")).toBeUndefined();
 }
});
