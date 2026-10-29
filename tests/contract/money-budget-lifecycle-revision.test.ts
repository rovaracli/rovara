// The system's existing override cleanup must not restore stale company limits or regress the new revision.
import { expect, it } from "vitest";
import { orgSettingsKey } from "@agentx/contracts";
import { writeBudgets } from "../../packages/broker/src/org/budget.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { mergeDuplicateMember } from "../../packages/broker/src/org/merge-members.js";
import { DeveloperSignInStore } from "../../packages/broker/src/developer/store.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { fakeModelAccess } from "../support/fake-model-access.js";
import { ADA, BEN, DEB, setup } from "../support/spend-world.js";
import { TEST_ORG } from "../support/orgs.js";
for (const kind of ["merge", "remove"] as const) for (const legacy of [false, true]) {
  it(`keeps concurrent admin limits and exact system audit during ${kind} of ${legacy ? "legacy" : "versioned"} budget`, async () => {
    const t = await setup(), capture = capturingAuditDeps({ db: t.db }), key = orgSettingsKey(TEST_ORG, "BUDGET");
    t.db.set({ ...key, entityType: "ORG_BUDGET", orgMonthlyUsd: 500, memberDefaultMonthlyUsd: 29, memberOverrides: { [DEB.developerId]: 30 }, ...(legacy ? {} : { revision: 1 }) });
    const send = t.db.send.bind(t.db); let raced = false;
    t.db.send = async command => {
      const input = command.input as { Item?: { pk?: string }; TransactItems?: Array<{ Put?: { Item?: { pk?: string } } }> };
      if (!raced && (input.Item?.pk === key.pk || input.TransactItems?.some(item => item.Put?.Item?.pk === key.pk))) {
        raced = true;
        await writeBudgets({ documentClient: t.db, tableName: "state", access: fakeModelAccess(), audit: capture.audit }, TEST_ORG, { orgMonthlyUsd: 800, memberDefaultMonthlyUsd: 40, memberOverrides: { [DEB.developerId]: 30 } }, ADA.developerId, new Date().toISOString(), { authority: { developerId: ADA.developerId, role: "owner" } });
      }
      return send(command);
    };
    if (kind === "merge") {
      t.db.set({ ...t.db.get(`DEVELOPER#${DEB.developerId}`, "META")!, issuer: "https://identity.example.test", subject: "retire-budget-member" });
      await mergeDuplicateMember({ documentClient: t.db, tableName: "state", signInStore: new DeveloperSignInStore({ documentClient: t.db, tableName: "state", now: Date.now }), now: Date.now, audit: capture.audit }, {
        orgId: TEST_ORG, survivorId: BEN.developerId, duplicateId: DEB.developerId, duplicateIdentityKey: ownerKeyForSubject("https://identity.example.test", "retire-budget-member"),
      });
    } else {
      await new OrgStore({ documentClient: t.db, tableName: "state", now: Date.now, audit: capture.audit }).removeMember({ orgId: TEST_ORG, developerId: DEB.developerId, emails: [], ban: false, by: { kind: "member", id: ADA.developerId } });
    }
    expect(raced).toBe(true);
    expect(t.db.get(key)).toMatchObject({ orgMonthlyUsd: 800, memberDefaultMonthlyUsd: 40, revision: legacy ? 2 : 3 });
    const overrides = t.db.get(key)?.memberOverrides as Record<string, number>;
    expect(overrides[DEB.developerId]).toBeUndefined(); if (kind === "merge") expect(overrides[BEN.developerId]).toBe(30);
    const systemChanges = capture.recordedBy("budget.changed").filter(event => event.actor.kind === "system");
    expect(systemChanges.some(event => "id" in event.target && event.target.id === DEB.developerId && event.facts?.fromCents === 3000 && event.facts.toCents === 4000)).toBe(true);
  });
}
