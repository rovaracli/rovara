import { describe, expect, it } from "vitest";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { egressDomainsKey, EGRESS_SYNC_KEY, type OrgId } from "@rovara-code/contracts";
import { planProjectEgressChange } from "../../packages/broker/src/org/project-egress-plan.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
const orgId = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId, project = "payments", actorId = "a".repeat(64), at = "2026-10-29T21:00:00.000Z";
function fixture(domains: Array<{ domain: string; status: string; reason?: string }> = []) {
 const db = new FakeDynamoDb(), key = egressDomainsKey(orgId, { kind: "project", project });
 db.set({ ...key, entityType: "EGRESS_DOMAINS", orgId, owner: { kind: "project", project }, active: true, updatedAt: at, domains: domains.map(domain => ({ ...domain, requestedAt: at, requestedBy: actorId })) });
 return { db, key, deps: { documentClient: db, tableName: "state", cloud: true, now: () => new Date(at) } };
}
describe("atomic project egress planning", () => {
 it("preserves staff decisions and makes new Cloud domains pending without writing while planning", async () => {
  const f = fixture([{ domain: "old.acme.dev", status: "rejected", reason: "staff decision" }]);
  const before = f.db.get(f.key);
  const plan = await planProjectEgressChange(f.deps, { orgId, project, actorId, domains: ["old.acme.dev", "new.acme.dev"] });
  expect(f.db.get(f.key)).toEqual(before);
  await f.db.send(new TransactWriteCommand({ TransactItems: plan.items }));
  expect(f.db.get(f.key)?.domains).toMatchObject([{ domain: "new.acme.dev", status: "pending" }, { domain: "old.acme.dev", status: "rejected", reason: "staff decision" }]);
 });
 it("refuses a concurrent staff decision without applying any caller mutation", async () => {
  const f = fixture([{ domain: "old.acme.dev", status: "pending" }]);
  const plan = await planProjectEgressChange(f.deps, { orgId, project, actorId, domains: [] });
  f.db.set({ ...f.db.get(f.key), updatedAt: "2026-10-29T21:01:00.000Z" });
  await expect(f.db.send(new TransactWriteCommand({ TransactItems: [...plan.items, { Put: { TableName: "state", Item: { pk: "REVISION", sk: "2" } } }] }))).rejects.toMatchObject({ name: "TransactionCanceledException" });
  expect(f.db.get({ pk: "REVISION", sk: "2" })).toBeUndefined();
 });
 it("replaces 50 entries with a bounded transaction and dirties the existing sync marker", async () => {
  const f = fixture(Array.from({ length: 50 }, (_, i) => ({ domain: `old${i}.acme.dev`, status: "approved" })));
  const plan = await planProjectEgressChange(f.deps, { orgId, project, actorId, domains: Array.from({ length: 50 }, (_, i) => `new${i}.acme.dev`) });
  expect(plan.items.length).toBeLessThan(10);
  await f.db.send(new TransactWriteCommand({ TransactItems: [...plan.items, { Put: { TableName: "state", Item: { pk: "REVISION", sk: "2" } } }] }));
  expect(f.db.get(f.key)?.domains).toHaveLength(50);expect(f.db.get(EGRESS_SYNC_KEY)?.dirtySeq).toBe(1);
 });
});

it("a staff-rejected website removed and re-added returns to pending staff review", async () => {
 const f = fixture([{ domain: "rejected.acme.dev", status: "rejected", reason: "staff refusal" }]);
 const remove = await planProjectEgressChange(f.deps, { orgId, project, actorId, domains: [] });
 await f.db.send(new TransactWriteCommand({ TransactItems: remove.items }));
 const readd = await planProjectEgressChange(f.deps, { orgId, project, actorId, domains: ["rejected.acme.dev"] });
 expect(readd.pending).toEqual(["rejected.acme.dev"]);
 await f.db.send(new TransactWriteCommand({ TransactItems: readd.items }));
 expect(f.db.get(f.key)?.domains).toEqual([{ domain: "rejected.acme.dev", status: "pending", requestedAt: "2026-10-29T21:00:00.002Z", requestedBy: actorId }]);
});
