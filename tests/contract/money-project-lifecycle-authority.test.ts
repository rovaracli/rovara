// M32: existing project AI settings require active registered lifecycle and the selected source's own membership.
import { randomUUID } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { expect, it } from "vitest";
import { projectAiKey, orgMemberKey, developerOrgKey } from "@agentx/cloud-contracts";
import { projectMetaKey, projectRevisionKey, orgProjectCatalogKey, projectMemberKey } from "@rovara-code/contracts";
import { writeProjectAi } from "../../packages/broker/src/spend/settings.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { BEN, DEB, setup } from "../support/spend-world.js";
import { seedMembership } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
for (const who of [BEN, DEB]) for (const existing of [false,true]) for (const race of [false,true]) it(`refuses archived project for ${who.name}, existing=${existing}, race=${race}`, async () => {
  const capture=capturingAuditDeps(),t=await setup({extra:{audit:capture.audit}});capture.attach(t.db);
  const key=projectAiKey(TEST_ORG,"payments"),meta=projectMetaKey(TEST_ORG,"payments");
  if(existing)t.db.set({...key,entityType:"PROJECT_AI",projectPays:false,memberAcceptRunLimitUpToUsd:1,revision:1});
  const before=t.db.get(key),original=t.db.get(meta),archive={...meta,entityType:"PROJECT_META",name:"payments",status:"archived",archivedAt:new Date().toISOString()};
  const send=t.db.send.bind(t.db);let raced=false;
  if(!race)t.db.set(archive);
  t.db.send=async command=>{const items=(command.input as {TransactItems?:Array<{Put?:{Item?:{pk?:string}}}>}).TransactItems;
    if(race&&!raced&&items?.some(i=>i.Put?.Item?.pk===key.pk)){raced=true;await send(new TransactWriteCommand({TransactItems:[{Put:{TableName:"state",Item:archive}}]}));}return send(command);};
  const answer=await t.api(who,"PUT","/v1/app/projects/payments/ai",{memberAcceptRunLimitUpToUsd:2});
  expect(answer.status).toBe(409);expect(t.db.get(key)).toEqual(before);expect(capture.recorded()).toHaveLength(0);expect(capture.pending()).toHaveLength(0);if(race)expect(raced).toBe(true);
  if(original===undefined)t.db.delete(meta);else t.db.set(original);
  expect((await t.api(who,"PUT","/v1/app/projects/payments/ai",{memberAcceptRunLimitUpToUsd:2})).status).toBe(200);
});
for(const loss of ["revision_deleted","catalog_advanced"] as const)it(`refuses ${loss} at project settings commit`,async()=>{
 const t=await setup(),key=projectAiKey(TEST_ORG,"payments"),send=t.db.send.bind(t.db);let raced=false;
 t.db.send=async command=>{const items=(command.input as {TransactItems?:Array<{Put?:{Item?:{pk?:string}}}>}).TransactItems;
 if(!raced&&items?.some(i=>i.Put?.Item?.pk===key.pk)){raced=true;await send(new TransactWriteCommand({TransactItems:loss==="revision_deleted"?[{Delete:{TableName:"state",Key:projectRevisionKey(TEST_ORG,"payments",1)}}]:[{Put:{TableName:"state",Item:{...t.db.get(orgProjectCatalogKey(TEST_ORG,"payments"))!,latestRevision:2}}}]}));}return send(command);};
 expect((await t.api(DEB,"PUT","/v1/app/projects/payments/ai",{memberAcceptRunLimitUpToUsd:2})).status).toBe(409);expect(raced).toBe(true);expect(t.db.get(key)).toBeUndefined();
});
for(const loss of ["member_role","removed","pointer"] as const)it(`a supplied survivor cannot lend authority after ${loss}`,async()=>{
 const t=await setup(),source="a".repeat(64),key=projectAiKey(TEST_ORG,"payments"),grant=t.db.get(projectMemberKey(TEST_ORG,BEN.developerId,"payments"))!;
 t.db.set({...grant,...projectMemberKey(TEST_ORG,source,"payments"),ownerKey:source,grantId:randomUUID()});seedMembership(t.db,source,{orgId:TEST_ORG,role:"owner"});
 if(loss==="member_role")t.db.set({...t.db.get(orgMemberKey(TEST_ORG,source))!,role:"member"});else t.db.delete(loss==="removed"?orgMemberKey(TEST_ORG,source):developerOrgKey(source));
 await expect(writeProjectAi(t.deps(),TEST_ORG,"payments",{projectPays:false,memberAcceptRunLimitUpToUsd:2},BEN.developerId,{actor:{developerId:BEN.developerId,role:"member"},projectGrantDeveloperId:source})).rejects.toMatchObject({code:"FORBIDDEN"});expect(t.db.get(key)).toBeUndefined();
 await expect(writeProjectAi(t.deps(),TEST_ORG,"payments",{projectPays:false,memberAcceptRunLimitUpToUsd:2},BEN.developerId,{actor:{developerId:BEN.developerId,role:"member"}})).resolves.toMatchObject({revision:1});
});
it("missing native registration is not an active project for an internal writer",async()=>{
 const t=await setup();t.db.delete(projectRevisionKey(TEST_ORG,"payments",1));
 await expect(writeProjectAi(t.deps(),TEST_ORG,"payments",{projectPays:false},DEB.developerId,{actor:{developerId:DEB.developerId,role:"admin"}})).rejects.toMatchObject({code:"PROJECT_NOT_FOUND"});
});
it("a verified legacy registration with absent META and catalog stays writable without creating lifecycle records",async()=>{
 const t=await setup(),meta=projectMetaKey(TEST_ORG,"payments"),catalog=orgProjectCatalogKey(TEST_ORG,"payments");t.db.delete(meta);t.db.delete(catalog);
 await expect(writeProjectAi(t.deps(),TEST_ORG,"payments",{projectPays:false,memberAcceptRunLimitUpToUsd:2},DEB.developerId,{actor:{developerId:DEB.developerId,role:"admin"}})).resolves.toMatchObject({revision:1});
 expect(t.db.get(meta)).toBeUndefined();expect(t.db.get(catalog)).toBeUndefined();
});
it("a legacy catalog without latestRevision is pinned absent rather than repaired",async()=>{
 const t=await setup(),key=orgProjectCatalogKey(TEST_ORG,"payments"),row={...t.db.get(key)!};delete row.latestRevision;t.db.set(row);
 await expect(writeProjectAi(t.deps(),TEST_ORG,"payments",{projectPays:false},DEB.developerId,{actor:{developerId:DEB.developerId,role:"admin"}})).resolves.toMatchObject({revision:1});
 expect(t.db.get(key)).toEqual(row);
});
it("a mismatched current catalog pointer is unavailable",async()=>{
 const t=await setup(),key=orgProjectCatalogKey(TEST_ORG,"payments");t.db.set({...t.db.get(key)!,latestRevision:2});
 await expect(writeProjectAi(t.deps(),TEST_ORG,"payments",{projectPays:false},DEB.developerId,{actor:{developerId:DEB.developerId,role:"admin"}})).rejects.toMatchObject({code:"RUNTIME_UNAVAILABLE"});
});
it("unknown lifecycle status is unavailable rather than active",async()=>{
 const t=await setup();t.db.set({...projectMetaKey(TEST_ORG,"payments"),entityType:"PROJECT_META",name:"payments",status:"unknown"});
 await expect(writeProjectAi(t.deps(),TEST_ORG,"payments",{projectPays:false},DEB.developerId,{actor:{developerId:DEB.developerId,role:"admin"}})).rejects.toMatchObject({code:"RUNTIME_UNAVAILABLE"});
});
it("another company's same-name registration cannot replace missing current-company history",async()=>{
 const t=await setup(),own=projectRevisionKey(TEST_ORG,"payments",1),row=t.db.get(own)!;t.db.delete(own);t.db.set({...row,...projectRevisionKey("org_bbbbbbbbbbbbbbbbbbbb","payments",1)});
 await expect(writeProjectAi(t.deps(),TEST_ORG,"payments",{projectPays:false},DEB.developerId,{actor:{developerId:DEB.developerId,role:"admin"}})).rejects.toMatchObject({code:"PROJECT_NOT_FOUND"});
});
