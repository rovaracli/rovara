import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { orgMemberKey, orgMetaKey, orgScoped } from "@agentx/contracts";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { clearWorkingBranchSaveReceipts } from "../../packages/broker/src/org/project-working-branch-receipt-cleanup.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

async function fixture() {
 const db = new FakeDynamoDb(), store = new OrgStore({ documentClient: db, tableName: "state", now: () => Date.parse("2026-10-29T00:00:00.000Z") });
 const orgId = await store.createOrgWithOwner({ name: "Closing", developerId: "owner" });
 const other = await store.createOrgWithOwner({ name: "Other", developerId: "other" });
 const partition = (org = orgId) => orgScoped(org, "REVIEWED_WORKING_BRANCH");
 const receipt = (org = orgId) => { const row = { pk: partition(org), sk: randomUUID(), orgId: org, entityType: "REVIEWED_WORKING_BRANCH_REQUEST" }; db.set(row); return row; };
 const remaining = () => db.find(row => row.pk === partition());
 const close = () => store.closeOrg(orgId, { archiveProjects: async () => undefined, clearEgress: async () => undefined });
 return { db, store, orgId, other, partition, receipt, remaining, close };
}
it("clears only this company's receipts after the durable closing fence and before teardown/final close", async () => {
 const f = await fixture(); f.receipt(); f.receipt(); const foreign = f.receipt(f.other);
 const send = f.db.send.bind(f.db); let observed = false;
 f.db.send = async command => {
  if (command.constructor.name === "QueryCommand" && (command.input.ExpressionAttributeValues as Record<string, unknown> | undefined)?.[":pk"] === f.partition()) {
   observed = true; expect(f.db.get(orgMetaKey(f.orgId))?.closingAt).toBeDefined(); expect(f.db.get(orgMetaKey(f.orgId))?.closedAt).toBeUndefined();
   expect(f.db.get(orgMemberKey(f.orgId, "owner"))).toBeDefined();
  }
  return send(command);
 };
 await f.store.closeOrg(f.orgId, { archiveProjects: async () => { expect(f.remaining()).toEqual([]); }, clearEgress: async () => undefined });
 expect(observed).toBe(true); expect(f.remaining()).toEqual([]); expect(f.db.get(foreign)).toEqual(foreign);
 expect(f.db.get(orgMetaKey(f.orgId))?.closedAt).toBeDefined();
 f.db.send = send;
 expect(await clearWorkingBranchSaveReceipts({ documentClient: f.db, tableName: "state" }, f.orgId)).toEqual({ deleted: 0 });
});
for (const failure of ["query", "malformed", "conflict", "fence"] as const) it(`keeps closingAt/member on ${failure} and a fresh close completes cleanup`, async () => {
 const f = await fixture(); const row = f.receipt(); const send = f.db.send.bind(f.db); let failed = false;
 f.db.send = async command => {
  const cleanupQuery = command.constructor.name === "QueryCommand" && (command.input.ExpressionAttributeValues as Record<string, unknown> | undefined)?.[":pk"] === f.partition();
  const cleanupBatch = command.constructor.name === "TransactWriteCommand" && JSON.stringify(command.input).includes(f.partition());
  if (!failed && ((failure === "query" || failure === "malformed") ? cleanupQuery : cleanupBatch)) {
   failed = true;
   if (failure === "malformed") return { Items: [{ ...row, orgId: f.other }] };
   if (failure === "query") throw new Error("private provider detail");
   throw Object.assign(new Error("private provider detail"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: failure === "fence" ? "ConditionalCheckFailed" : "TransactionConflict" }] });
  }
  return send(command);
 };
 const error = await f.close().catch((value: unknown) => value);
 expect(error).toMatchObject({ code: failure === "fence" ? "CHANGE_STALE" : "RUNTIME_UNAVAILABLE" }); expect(String(error)).not.toContain("private"); expect(failed).toBe(true);
 const closingAt = f.db.get(orgMetaKey(f.orgId))?.closingAt;
 expect(closingAt).toBeDefined(); expect(f.db.get(orgMetaKey(f.orgId))?.closedAt).toBeUndefined(); expect(f.db.get(orgMemberKey(f.orgId, "owner"))).toBeDefined(); expect(f.remaining()).toHaveLength(1);
 await f.close(); expect(f.remaining()).toEqual([]); expect(f.db.get(orgMetaKey(f.orgId))?.closedAt).toBeDefined(); expect(f.db.get(orgMetaKey(f.orgId))?.closingAt).toBeUndefined();
});
it("leaves empty cleanup a no-op and allows repeat close", async () => {
 const f = await fixture(); await f.close(); const meta = f.db.get(orgMetaKey(f.orgId)); await f.close(); expect(f.db.get(orgMetaKey(f.orgId))).toEqual(meta); expect(f.remaining()).toEqual([]);
});
it("a concurrent close safely wins while the stale cleanup caller retains no ability to reopen or partially finalize", async () => {
 const f = await fixture(); f.receipt(); const foreign = f.receipt(f.other); const send = f.db.send.bind(f.db); let raced = false;
 f.db.send = async command => {
  if (!raced && command.constructor.name === "TransactWriteCommand" && JSON.stringify(command.input).includes(f.partition())) { raced = true; await f.close(); }
  return send(command);
 };
 await expect(f.close()).rejects.toMatchObject({ code: "CHANGE_STALE" }); expect(raced).toBe(true);
 expect(f.remaining()).toEqual([]); expect(f.db.get(foreign)).toEqual(foreign); expect(f.db.get(orgMetaKey(f.orgId))?.closedAt).toBeDefined(); expect(f.db.get(orgMetaKey(f.orgId))?.closingAt).toBeUndefined();
 await f.close(); expect(f.remaining()).toEqual([]);
});
