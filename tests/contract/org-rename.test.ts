import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { orgMetaKey, type OrgRole } from "@agentx/cloud-contracts";
import { MAYA, createDeveloperTaskBroker, seedMembership } from "../support/developer-task-broker.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { RenameOrganizationBodySchema } from "@rovara-code/contracts";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { TEST_ORG } from "../support/orgs.js";
async function setup(role: OrgRole = "owner") {
 const audit = capturingAuditDeps(), h = await createDeveloperTaskBroker({ audit });
 await h.orgOf(MAYA);
 seedMembership(h.db, MAYA.developerId, { orgId: TEST_ORG, role });
 h.db.set({ ...orgMetaKey(TEST_ORG), entityType: "ORG", orgId: TEST_ORG, name: "Maya's team", nameIsDefault: true, plan: "cloud", createdBy: MAYA.developerId, createdAt: "2026-10-01T00:00:00.000Z" });
 return { ...h, audit, rename: (body: unknown) => h.dev(MAYA, "PATCH", "/v1/app/org", body) };
}
describe("organization rename", () => {
 it("cleans the owner's name, clears the default, replays once and audits once", async () => {
  const h = await setup(), requestId = randomUUID();
  expect((await h.rename({ requestId, name: "  Acme\n Labs  " })).status).toBe(200);
  expect(h.db.get(orgMetaKey(TEST_ORG))).toMatchObject({ name: "Acme Labs", nameIsDefault: false });
  expect((await h.rename({ requestId, name: "  Acme\n Labs  " })).status).toBe(200);
  expect(h.audit.recordedBy("org.renamed")).toHaveLength(1);
  expect((await h.rename({ requestId, name: "Different" })).status).toBe(409);
  expect((await h.dev(MAYA, "GET", "/v1/app/me")).body.org).toMatchObject({ name: "Acme Labs", nameIsDefault: false });
 });
 it.each(["admin", "member"] as const)("refuses %s", async role => {
  const h = await setup(role);
  const before=h.db.commandNames().length;
  expect((await h.rename({ requestId: randomUUID(), name: "Acme" })).status).toBe(403);
  expect(h.db.commandNames().slice(before)).not.toContain("TransactWriteCommand");
  expect(h.db.get(orgMetaKey(TEST_ORG))).toMatchObject({ nameIsDefault: true });
 });
 it.each(["x".repeat(81), "   ", "\u200b"])("refuses an invalid company name", async name => {
  const h = await setup();
  expect((await h.rename({ requestId: randomUUID(), name })).status).toBe(400);
  expect(h.audit.recorded()).toHaveLength(0);
 });
});

it("checks the owner's live membership inside the rename transaction",async()=>{const h=await setup("admin"),store=new OrgStore({documentClient:h.db,tableName:"state",now:Date.now});await expect(store.renameOrg({orgId:TEST_ORG,developerId:MAYA.developerId,requestId:randomUUID(),name:"Acme"})).rejects.toMatchObject({code:"FORBIDDEN"});});
it("retains rename audit evidence when the intake queue is unavailable",async()=>{const h=await setup();h.audit.queueDown();expect((await h.rename({requestId:randomUUID(),name:"Acme"})).status).toBe(200);expect(h.audit.pending()).toHaveLength(1);expect(h.audit.pending()[0]).toMatchObject({action:"org.renamed",target:{kind:"org",id:TEST_ORG}});});
it("pins canonical company-name bounds and cleaning",()=>{for(const name of ["x".repeat(81),"   ","\u200b"])expect(RenameOrganizationBodySchema.safeParse({requestId:randomUUID(),name}).success).toBe(false);expect(RenameOrganizationBodySchema.parse({requestId:randomUUID(),name:" Acme\nLabs "}).name).toBe("Acme Labs");});
