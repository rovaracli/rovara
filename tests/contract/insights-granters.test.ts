// Insights: who gave a viewer grant, read from the audit ledger (the member record holds no person id). Through the real appender, keyring and indexed reader over fakes: an event counts for a grant only
// when it names that member as target at exactly the time the grant was written, only `insights_access.granted` counts, another company's events never count, and only a live owner or admin gets an answer.
import { describe, expect, it } from "vitest";
import { AuditEventInputSchema, auditEventId, type AuditAction, type OrgRole } from "@agentx/cloud-contracts";
import { appendEvent } from "../../packages/broker/src/audit/appender.js";
import { AuditKeyring } from "../../packages/broker/src/audit/keyring.js";
import type { AuditExportClientDeps } from "../../packages/broker/src/audit/export.js";
import { ledgerGrantLookup } from "../../packages/broker/src/insights/granters.js";
import { TableScopedDynamoDb } from "../support/table-scoped-dynamodb.js";
import { FakeKms } from "../support/fake-kms.js";
import { FakeAuditSqs } from "../support/fake-audit-sqs.js";
import { A, B } from "../support/audit-anchor-harness.js";

const LEDGER = "ledger", KEYS = "keys", STATE = "state", SEALS = "seals";
const ADMIN = "a".repeat(64), GRANTER = "b".repeat(64), OTHER_GRANTER = "e".repeat(64), ZED = "c".repeat(64), MAX = "d".repeat(64);
const KEY_ARN = "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555";
const START = Date.parse("2026-10-29T08:00:00Z");

function fixture() {
  const db = new TableScopedDynamoDb(), kms = new FakeKms(KEY_ARN), sqs = new FakeAuditSqs(), clock = { now: START };
  const client = db.client;
  const keyring = new AuditKeyring({ documentClient: client, keysTable: KEYS, kms: kms.client, keyId: KEY_ARN, now: () => clock.now });
  const audit = { sqs: sqs.client, queueUrl: "https://sqs.test/intake.fifo", documentClient: client, tableName: STATE, now: () => clock.now, log: () => undefined };
  const ledger: AuditExportClientDeps = { documentClient: client, ledgerTable: LEDGER, sealsTable: SEALS, keyring, tableName: STATE, audit, now: () => clock.now, log: () => undefined, exportsBucket: "exports", invokeExport: async () => undefined, presign: async () => ({ url: "https://signed.test/export", expiresInSeconds: 60 }) };
  const appender = { documentClient: client, ledgerTable: LEDGER, keyring, now: () => clock.now, log: () => undefined, sleep: async () => undefined };
  const seed = (orgId: string, role: string, id: string) => {
    db.set(STATE, { pk: `ORG#${orgId}`, sk: "META", entityType: "ORG", orgId, name: "Acme", createdAt: new Date(START).toISOString(), plan: "team" });
    db.set(STATE, { pk: `ORG#${orgId}`, sk: `MEMBER#${id}`, entityType: "ORG_MEMBER", orgId, developerId: id, role, joinedAt: new Date(START).toISOString() });
    db.set(STATE, { pk: `DEVELOPER_ORG#${id}`, sk: "ORG", entityType: "DEVELOPER_ORG", orgId, role });
  };
  seed(A, "owner", ADMIN);
  let n = 0;
  const event = async (action: AuditAction, actorId: string, targetId: string, at: string, orgId: string = A) => { clock.now = Math.max(clock.now, Date.parse(at) + 1000); return appendEvent(appender, AuditEventInputSchema.parse({
    orgId, eventId: auditEventId(action, `insights-${(n += 1)}`), action, actor: { kind: "member", id: actorId }, target: { kind: "member", id: targetId }, occurredAt: at,
  })); };
  const caller = (orgRole: OrgRole = "owner", developerId = ADMIN) => ({ orgId: A, orgRole, developerId });
  return { db, ledger, event, lookup: ledgerGrantLookup(ledger), caller, seed };
}
const T1 = "2026-10-29T08:10:00.000Z", T2 = "2026-10-29T09:30:00.000Z";

describe("the grant's granter, from the ledger", () => {
  it("answers the actor of the event that made exactly this grant, and nothing for a grant it has no event for", async () => {
    const f = fixture();
    await f.event("insights_access.granted", GRANTER, ZED, T1);
    const found = await f.lookup(f.caller(), [{ developerId: ZED, at: T1 }, { developerId: MAX, at: T1 }]);
    // Positive control: the lookup found the one it has an event for; the other is simply absent.
    expect([...found]).toEqual([[ZED, GRANTER]]);
  });

  it("uses the event of the same time when a member was granted twice, never another grant's granter", async () => {
    const f = fixture();
    await f.event("insights_access.granted", GRANTER, ZED, T1);
    await f.event("insights_access.revoked", GRANTER, ZED, "2026-10-29T08:50:00.000Z");
    await f.event("insights_access.granted", OTHER_GRANTER, ZED, T2);
    expect([...await f.lookup(f.caller(), [{ developerId: ZED, at: T2 }])]).toEqual([[ZED, OTHER_GRANTER]]);
    expect([...await f.lookup(f.caller(), [{ developerId: ZED, at: T1 }])]).toEqual([[ZED, GRANTER]]);
    // No event at this time: no name, however many grants the ledger holds for the member.
    expect((await f.lookup(f.caller(), [{ developerId: ZED, at: "2026-10-29T08:11:00.000Z" }])).size).toBe(0);
  });

  it("counts only a grant event: a revoke at the same time, and another company's grant, name no one", async () => {
    const f = fixture();
    f.seed(B, "owner", OTHER_GRANTER);
    await f.event("insights_access.revoked", GRANTER, ZED, T1);
    await f.event("insights_access.granted", OTHER_GRANTER, ZED, T1, B);
    expect((await f.lookup(f.caller(), [{ developerId: ZED, at: T1 }])).size).toBe(0);
  });

  it("answers only a live owner or admin, and asks the ledger nothing for anyone else", async () => {
    const f = fixture();
    await f.event("insights_access.granted", GRANTER, ZED, T1);
    for (const role of ["member", "auditor"] as const) expect((await f.lookup(f.caller(role), [{ developerId: ZED, at: T1 }])).size, role).toBe(0);
    // The reader's own record is checked by the ledger read: a person who is no longer an owner is refused there.
    f.db.set(STATE, { ...f.db.get(STATE, `ORG#${A}`, `MEMBER#${ADMIN}`)!, role: "member" });
    await expect(f.lookup(f.caller("owner"), [{ developerId: ZED, at: T1 }])).rejects.toBeDefined();
  });
});
