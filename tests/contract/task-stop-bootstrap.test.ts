import { expect, it } from "vitest";
import { orgMetaKey, orgSettingsKey, agentGuardrailsKey } from "@agentx/contracts";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const orgId = "org_aaaaaaaaaaaaaaaaaaaa";
const who = "a".repeat(64);
const now = Date.parse("2026-10-29T22:00:00Z");
const policyKey = orgSettingsKey(orgId, "TASK_STOP_POLICY");
const seedKey = { pk: `ORG#${orgId}#TASK_STOP_SEED`, sk: "V1#bootstrap" };
function putItem(entry: Record<string, unknown>): Record<string, unknown> | undefined {
  const put = entry.Put;
  if (typeof put !== "object" || put === null || !("Item" in put)) return undefined;
  const item = put.Item;
  return typeof item === "object" && item !== null ? Object.fromEntries(Object.entries(item)) : undefined;
}
function fixture(pin = false) {
  const db = new FakeDynamoDb();
  const store = new OrgStore({ documentClient: db, tableName: "state", now: () => now, newOrgId: () => orgId, rovaraCodeV2ForNewOrgs: pin });
  return { db, store };
}
for (const creation of ["ensureOrg", "createOrgWithOwner"] as const) {
  for (const pin of [false, true]) {
    it(`${creation} atomically bootstraps audited estimate-mode policy with version pin ${pin}`, async () => {
      const f = fixture(pin);
      if (creation === "ensureOrg") await f.store.ensureOrg(orgId, "Company");
      else await f.store.createOrgWithOwner({ name: "Company", developerId: who });
      expect(f.db.get(policyKey.pk, policyKey.sk)).toMatchObject({ orgId, entityType: "ORG_TASK_STOP_POLICY", revision: 1,
        policy: { schemaVersion: 2, defaultPolicy: { kind: "rovara_estimate" } }, enrollment: { state: "disabled", version: 1 } });
      expect(f.db.get(agentGuardrailsKey(orgId).pk, "META")).toMatchObject({ entityType: "AGENT_GUARDRAILS", guardrails: { maxPerRunCeilingUsd: 100 } });
      expect(f.db.get(seedKey.pk, seedKey.sk)).toMatchObject({ orgId, entityType: "TASK_STOP_SEED", source: "bootstrap", version: 1 });
      const transaction = f.db.transactions().find(items => items.some(item => putItem(item)?.sk === "TASK_STOP_POLICY"));
      expect(transaction).toBeDefined();
      expect(transaction?.some(item => putItem(item)?.pk === orgMetaKey(orgId).pk && putItem(item)?.sk === "META")).toBe(true);
      const events = transaction?.flatMap(item => putItem(item)?.event === undefined ? [] : [putItem(item)?.event]);
      const seeded = events?.find(event => typeof event === "object" && event !== null && "action" in event && event.action === "spending.policy_seeded");
      expect(seeded).toMatchObject({ action: "spending.policy_seeded", actor: { kind: "system", id: "rovara" }, facts: { mode: "rovara_estimate", source: "bootstrap" } });
      expect(JSON.stringify(f.db.get(policyKey.pk, policyKey.sk))).not.toContain('"defaultStopMicrousd":10000000');
    });
  }
}
it("replaying ensureOrg never overwrites an admin policy or emits another seed", async () => {
  const f = fixture(); await f.store.ensureOrg(orgId, "Company");
  f.db.set({ ...policyKey, orgId, entityType: "ORG_TASK_STOP_POLICY", revision: 7, policy: { schemaVersion: 2, defaultPolicy: { kind: "limited", stopMicrousd: 1234567 } } });
  const before = f.db.get(policyKey.pk, policyKey.sk);
  await f.store.ensureOrg(orgId, "New name");
  expect(f.db.get(policyKey.pk, policyKey.sk)).toEqual(before);
  expect(f.db.get(seedKey.pk, seedKey.sk)).toBeDefined();
});
it("a bootstrap transaction failure leaves no org or membership without its policy/audit", async () => {
  const f = fixture();
  f.db.set({ ...policyKey, orgId, revision: 2, policy: { schemaVersion: 2, defaultPolicy: { kind: "limited", stopMicrousd: 1 } } });
  await expect(f.store.createOrgWithOwner({ name: "Company", developerId: who })).rejects.toThrow();
  expect(f.db.get(orgMetaKey(orgId).pk, "META")).toBeUndefined();
  expect(f.db.get(seedKey.pk, seedKey.sk)).toBeUndefined();
  expect(f.db.get(policyKey.pk, policyKey.sk)?.revision).toBe(2);
});
