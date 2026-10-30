import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { orgMemberKey, orgMetaKey, orgProjectCatalogKey, projectPk } from "../../packages/contracts/src/index.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { clearProjectAllowedDomainProposals } from "../../packages/broker/src/org/project-allowed-domains-cleanup.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
async function fixture() {
 const db = new FakeDynamoDb(), store = new OrgStore({ documentClient: db, tableName: "state", now: () => Date.parse("2026-10-29T21:00:00.000Z") });
 const orgId = await store.createOrgWithOwner({ name: "Closing", developerId: "owner" }), other = await store.createOrgWithOwner({ name: "Other", developerId: "other" });
 const seed = (org = orgId, project = "payments", kind = "widening", pointer = false) => {
  db.set({ ...orgProjectCatalogKey(org, project), entityType: "PROJECT_CATALOG", name: project, latestRevision: 1 });
  const row = { pk: projectPk(org, project), sk: pointer ? "EGRESS_PROPOSAL_LIVE" : `EGRESS_PROPOSAL#${randomUUID()}`, entityType: pointer ? "EGRESS_PROPOSAL_LIVE" : "EGRESS_PROPOSAL", orgId: org, project, kind };
  db.set(row);return row;
 };
 const close = (archiveProjects: () => Promise<void> = async () => undefined) => store.closeOrg(orgId, { archiveProjects, clearEgress: async () => undefined });
 return { db, store, orgId, other, seed, close, deps: { documentClient: db, tableName: "state" } };
}
it("company close clears proposals, LIVE pointers and every receipt kind before teardown", async () => {
 const f = await fixture();for (const kind of ["widening", "decision_receipt", "approval_receipt", "direct_narrowing"]) f.seed(f.orgId, "payments", kind);
 f.seed(f.orgId, "payments", "widening", true);f.seed(f.orgId, "web");const foreign = f.seed(f.other), unrelated = { pk: projectPk(f.orgId, "payments"), sk: "REV#0000000001", entityType: "PROJECT" };f.db.set(unrelated);
 let checked = false;
 await f.close(async () => { checked = true;expect(f.db.get(orgMetaKey(f.orgId))?.closingAt).toBeDefined();expect(f.db.get(orgMemberKey(f.orgId, "owner"))).toBeDefined();expect(f.db.find(row => row.orgId === f.orgId && String(row.sk).startsWith("EGRESS_PROPOSAL"))).toEqual([]); });
 expect(checked).toBe(true);expect(f.db.get(foreign)).toEqual(foreign);expect(f.db.get(unrelated)).toEqual(unrelated);expect(f.db.get(orgMetaKey(f.orgId))?.closedAt).toBeDefined();
});
it("cleanup refuses an active company without deleting its proposal", async () => {
 const f = await fixture(), row = f.seed();await expect(clearProjectAllowedDomainProposals(f.deps, f.orgId)).rejects.toMatchObject({ code: "FORBIDDEN" });expect(f.db.get(row)).toEqual(row);
});
it("bounded cleanup pages resume after failure while retaining closingAt and the owner", async () => {
 const f = await fixture();for (let i = 0; i < 31; i += 1) f.seed();const send = f.db.send.bind(f.db);let batches = 0;
 f.db.send = async command => {
  if (command.constructor.name === "TransactWriteCommand" && JSON.stringify(command.input).includes("EGRESS_PROPOSAL#")) { batches += 1;if (batches === 2) throw new Error("private database failure"); }
  return send(command);
 };
 await expect(f.close()).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });expect(batches).toBe(2);
 expect(f.db.get(orgMetaKey(f.orgId))?.closingAt).toBeDefined();expect(f.db.get(orgMetaKey(f.orgId))?.closedAt).toBeUndefined();expect(f.db.get(orgMemberKey(f.orgId, "owner"))).toBeDefined();
 expect(f.db.find(row => row.orgId === f.orgId && row.entityType === "EGRESS_PROPOSAL")).toHaveLength(6);
 await f.close();expect(f.db.find(row => row.orgId === f.orgId && row.entityType === "EGRESS_PROPOSAL")).toEqual([]);
});
it("a foreign-scoped row inside the company partition fails closed before deletion", async () => {
 const f = await fixture(), row = f.seed();f.db.set({ ...row, orgId: f.other });
 await expect(f.close()).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });expect(f.db.get(row)).toMatchObject({ orgId: f.other });expect(f.db.get(orgMetaKey(f.orgId))?.closedAt).toBeUndefined();
});
it("cleanup loses authority if the closing fence changes before its transaction", async () => {
 const f = await fixture(), row = f.seed();
 f.db.injectFault({ command: "TransactWriteCommand", match: input => {
  if (!JSON.stringify(input).includes("EGRESS_PROPOSAL#")) return false;
  const key = orgMetaKey(f.orgId);f.db.set({ ...f.db.get(key), closingAt: "2026-10-29T22:00:00.000Z" });return false;
 }, error: { name: "InternalServerError" } });
 await expect(f.close()).rejects.toMatchObject({ code: "CHANGE_STALE" });expect(f.db.get(row)).toEqual(row);expect(f.db.get(orgMetaKey(f.orgId))?.closedAt).toBeUndefined();
});

it("foreign cleanup pagination is refused before deleting even an owned page", async () => {
 const f = await fixture(), row = f.seed(), send = f.db.send.bind(f.db);let injected = false;
 f.db.send = async command => {
  const result = await send(command);
  if (!injected && command.constructor.name === "QueryCommand" && (command.input.ExpressionAttributeValues as Record<string, unknown> | undefined)?.[":pk"] === row.pk) {
   injected = true;return { ...(result as Record<string, unknown>), LastEvaluatedKey: { pk: projectPk(f.other, "payments"), sk: row.sk } };
  }
  return result;
 };
 await expect(f.close()).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });expect(injected).toBe(true);expect(f.db.get(row)).toEqual(row);
 expect(f.db.get(orgMetaKey(f.orgId))?.closingAt).toBeDefined();expect(f.db.get(orgMetaKey(f.orgId))?.closedAt).toBeUndefined();
});
it("B34 company close clears Slack pending approvals and live pointers within its company only", async () => {
 const f = await fixture();f.seed();const own = { pk: projectPk(f.orgId, "payments"), sk: `SLACK_BINDING_PROPOSAL#${randomUUID()}`, orgId: f.orgId, project: "payments", entityType: "SLACK_BINDING_PROPOSAL" };
 const pointer = { pk: own.pk, sk: "SLACK_BINDING_PROPOSAL_LIVE", orgId: f.orgId, project: "payments", entityType: "SLACK_BINDING_PROPOSAL_LIVE" };
 const foreign = { ...own, pk: projectPk(f.other, "payments"), orgId: f.other };f.db.set(own);f.db.set(pointer);f.db.set(foreign);
 await f.close();expect(f.db.get(own)).toBeUndefined();expect(f.db.get(pointer)).toBeUndefined();expect(f.db.get(foreign)).toEqual(foreign);
});
