// Opus security review additions for lane AL-1. Test-only. What the lane's file and the Sonnet pre-review file do not pin:
//   - the fence/marker protocol when a tick dies right after the fence (plain tests: they pass on this code);
//   - the fail-safe that a corrupt seal row in a closed epoch stops every later statement, for every company (plain: pins today's intended behaviour);
//   - former gaps (written as `it.fails` until fixed; see AL-1-REVIEW-OPUS.md): the fixes are in.
import { describe, expect, it } from "vitest";
import { CLOUD_AUDIT_ACTIONS } from "../../packages/cloud-server/src/audit-log.js";
import { SealProgressV1Schema, mapCloudAuditV1, pendingAuditV1 } from "../../packages/cloud-server/src/audit-contracts-v1.js";
import { AuditAppender } from "../../packages/cloud-server/src/audit-appender.js";
import { DynamoAuditLedgerStore, chainHeadKey } from "../../packages/cloud-server/src/audit-ledger-store.js";
import { AuditSealer } from "../../packages/cloud-server/src/audit-sealer.js";
import { LockedStorageDouble, TimestampDouble, assembleBundle, doubleAnchors, verifyBundle } from "../support/audit-sealing-doubles.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa";
const B = "org_bbbbbbbbbbbbbbbbbbbb";
const CONTEXT = { installId: "install1", salt: Uint8Array.from({ length: 16 }, (_, i) => i + 1) };
const T0 = Date.parse("2026-11-25T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const E1 = "e20261125T1205Z";
const E2 = "e20261125T1210Z";
const E3 = "e20261125T1215Z";

const pending = (company: string, n: number) => pendingAuditV1(mapCloudAuditV1({
  id: `aud_${String(n).padStart(20, "0")}`, companyId: company, at: iso(T0), actor: { type: "person", developerId: "dev1", name: "Ada" },
  action: CLOUD_AUDIT_ACTIONS[1], subject: "", outcome: "ok",
}, CONTEXT), iso(T0));

function rig() {
  const clock = { ms: T0 };
  const now = () => new Date(clock.ms);
  const db = new FakeDynamoDb();
  const store = new DynamoAuditLedgerStore(db, "t");
  const storage = new LockedStorageDouble(now);
  const tsa = new TimestampDouble();
  const appender = new AuditAppender(store, { now });
  const sealer = new AuditSealer(store, storage, tsa, { now });
  return { clock, now, db, store, storage, tsa, appender, sealer };
}
type Rig = ReturnType<typeof rig>;
const at = (r: Rig, text: string) => { r.clock.ms = Date.parse(text); };
const rowOf = (r: Rig, key: { pk: string; sk: string }) => [...r.db.items.entries()].find(([, item]) => item.pk === key.pk && item.sk === key.sk);
async function seed(r: Rig) {
  for (let n = 1; n <= 3; n += 1) { r.clock.ms = T0 + n * 1000; await r.appender.append(pending(A, n)); }
  for (let n = 4; n <= 5; n += 1) { r.clock.ms = T0 + n * 1000; await r.appender.append(pending(B, n)); }
}
const plan = (company: string, epochId: string) => SealProgressV1Schema.parse({
  v: 1, kind: "seal-progress", phase: "planned", companyId: company, checkpoint: { fromSeq: 1, toSeq: 2, headHash: "a".repeat(64), prevSealHash: "b".repeat(64), epochId },
  batchRoot: "c".repeat(64), updatedAt: iso(T0),
});

describe("opus review: the epoch protocol when a tick dies", () => {
  it("a tick that dies right after setting the fence loses nothing: the next tick closes the earlier epoch, and its statement comes first in the chain", async () => {
    const r = rig();
    await seed(r);
    class NeverCloses extends DynamoAuditLedgerStore {
      override async closeEpoch(): Promise<"closed" | "exists"> { throw new Error("stopped"); }
    }
    at(r, "2026-11-25T12:05:10Z");
    await expect(new AuditSealer(new NeverCloses(r.db, "t"), r.storage, r.tsa, { now: r.now }).tick()).rejects.toThrow("stopped");
    expect(await r.store.listSealedEpochs()).toEqual([E1]);
    expect(await r.store.listOpenEpochs()).toEqual([]);

    class DiesAfterFence extends DynamoAuditLedgerStore {
      override async listSealedEpochs(): Promise<string[]> { throw new Error("stopped"); }
    }
    await r.appender.append(pending(A, 6));
    at(r, "2026-11-25T12:10:10Z");
    await expect(new AuditSealer(new DiesAfterFence(r.db, "t"), r.storage, r.tsa, { now: r.now }).tick()).rejects.toThrow("stopped");
    // The fence is at E2: nothing can join E1 any more, though E1 is not closed.
    expect(await r.store.planSeal(plan("org_cccccccccccccccccccc", E1), { tip: undefined })).toBe("refused");

    at(r, "2026-11-25T12:15:10Z");
    const report = await r.sealer.tick();
    expect(report.blocked).toEqual([]);
    expect(report.completedEpochs).toEqual([E1, E3]);
    expect((await r.store.getEpochProgress(E1))?.prevEpochId).toBeNull();
    expect((await r.store.getEpochProgress(E3))?.prevEpochId).toBe(E1);
    for (const company of [A, B]) {
      const bundle = await assembleBundle({ store: r.store, storage: r.storage, companyId: company, epochIds: [E1, E2, E3] });
      expect(verifyBundle(bundle, { anchors: doubleAnchors() }).ok).toBe(true);
      expect(bundle.unsealed).toEqual([]);
    }
  });
});

describe("opus review: a corrupt seal row in a closed epoch", () => {
  it("stops every later statement, for every company, and says so on every tick (the chain is never planned past it)", async () => {
    const r = rig();
    await seed(r);
    class ChangesALeaf extends DynamoAuditLedgerStore {
      override async closeEpoch(...args: Parameters<DynamoAuditLedgerStore["closeEpoch"]>) {
        const result = await super.closeEpoch(...args);
        const leaf = rowOf(r, { pk: `EPOCHSEAL#${E1}`, sk: A })?.[1];
        (leaf?.seal as { batchRoot: string }).batchRoot = "0".repeat(64);
        return result;
      }
    }
    at(r, "2026-11-25T12:05:10Z");
    await new AuditSealer(new ChangesALeaf(r.db, "t"), r.storage, r.tsa, { now: r.now }).tick();
    await r.appender.append(pending(B, 6));
    at(r, "2026-11-25T12:10:10Z");
    const report = await r.sealer.tick();
    expect(report.planned).toEqual([{ companyId: B, fromSeq: 3, toSeq: 3 }]);
    expect(await r.store.getEpochProgress(E1)).toBeUndefined();
    expect(await r.store.getEpochProgress(E2)).toBeUndefined(); // B's seal in E2 waits too
    expect(report.blocked).toEqual(expect.arrayContaining([
      expect.objectContaining({ what: `epoch ${E1}`, refused: true }),
      expect.objectContaining({ what: `epoch ${E2}` }),
    ]));
  });
});

describe("opus review: former gaps, now fixed", () => {
  // SHOULD (reader checks): a head that is gone while the company has a seal tip is reported nowhere; the company is simply never sealed again.
  it("a chain head deleted after a seal stops that company loudly", async () => {
    const r = rig();
    await seed(r);
    at(r, "2026-11-25T12:05:10Z");
    await r.sealer.tick();
    r.db.items.delete(rowOf(r, chainHeadKey(A))?.[0] ?? "");
    at(r, "2026-11-25T12:10:10Z");
    const report = await r.sealer.tick();
    expect(report.blocked.some((entry) => entry.refused && entry.what.includes(A))).toBe(true);
  });

  // SHOULD (reader checks): a head rolled back below what is already sealed is not compared with the seal tip.
  it("a chain head rolled back below the company's last seal stops that company loudly", async () => {
    const r = rig();
    await seed(r);
    at(r, "2026-11-25T12:05:10Z");
    await r.sealer.tick();
    const [, head] = rowOf(r, chainHeadKey(A)) as [string, Record<string, unknown>];
    head.headSeq = 1;
    at(r, "2026-11-25T12:10:10Z");
    const report = await r.sealer.tick();
    expect(report.blocked.some((entry) => entry.refused && entry.what.includes(A))).toBe(true);
  });

  // SHOULD (port trust): the port doc lets AL-2 answer a repeat call with the SAME version; the sealer's 15-minute recency check then refuses that answer for ever.
  // Fix either side (the port doc requires a fresh version per call and this test asserts the refusal is not permanent, or the sealer accepts its earlier answer).
  it("a storage target that answers a repeat call with the version it wrote earlier (as the port doc allows) still lets the seal lock", async () => {
    const r = rig();
    await seed(r);
    class SameVersion extends LockedStorageDouble {
      override async putLocked(write: Parameters<LockedStorageDouble["putLocked"]>[0]) {
        return this.objects.get(write.key)?.evidence ?? super.putLocked(write);
      }
    }
    const storage = new SameVersion(r.now);
    let fail = true;
    class StopsOnce extends DynamoAuditLedgerStore {
      override async advanceSeal(...args: Parameters<DynamoAuditLedgerStore["advanceSeal"]>) {
        if (fail) { fail = false; throw new Error("stopped after the lock, before the row"); }
        return super.advanceSeal(...args);
      }
    }
    at(r, "2026-11-25T12:05:10Z");
    await new AuditSealer(new StopsOnce(r.db, "t"), storage, r.tsa, { now: r.now }).tick();
    at(r, "2026-11-25T12:30:10Z"); // the worker was down for 25 minutes
    await new AuditSealer(r.store, storage, r.tsa, { now: r.now }).tick();
    expect((await r.store.getSealProgress(A, 1, 3))?.phase).toBe("locked");
  });

  // SHOULD (port trust): the provider check also runs after the token is in hand; changing the configured provider (DEC 254zzz102: configurable) strands it.
  it("an epoch whose token was already received finishes after the configured timestamp provider changes", async () => {
    const r = rig();
    await seed(r);
    r.storage.failKeyPart = ".tst";
    at(r, "2026-11-25T12:05:10Z");
    await r.sealer.tick();
    expect((await r.store.getEpochProgress(E1))?.phase).toBe("timestamp-received");
    r.storage.failKeyPart = undefined;
    class Other extends TimestampDouble { override provider = "othertsa"; }
    at(r, "2026-11-25T12:06:00Z");
    await new AuditSealer(r.store, r.storage, new Other(), { now: r.now }).tick();
    expect((await r.store.getEpochProgress(E1))?.phase).toBe("timestamped");
  });

  // SHOULD (nothing dropped, but silently held): a sealer whose clock ran ahead plans a future epoch; every correct tick until then plans nothing and reports nothing.
  it("after a sealer with a fast clock ran, a correct tick says that sealing is held", async () => {
    const r = rig();
    await seed(r);
    at(r, "2026-11-25T12:05:10Z");
    const fast = new AuditSealer(r.store, r.storage, r.tsa, { now: () => new Date(r.clock.ms + 3_600_000) });
    expect((await fast.tick()).epochId).toBe("e20261125T1305Z");
    await r.appender.append(pending(A, 6));
    at(r, "2026-11-25T12:10:10Z");
    const report = await r.sealer.tick();
    expect(report.planned).toEqual([]); // nothing lost: record 6 waits for 13:10
    expect(report.blocked.length).toBeGreaterThan(0);
  });
});

describe("opus review: rules no test pinned (mutants X1, X2, X5, X8 in AL-1-REVIEW-OPUS.md)", () => {
  it("the done pointer never moves past an epoch that is not finished, so that epoch is still advanced later", async () => {
    const r = rig();
    await seed(r);
    r.storage.failKeyPart = `audit/${A}/`;
    at(r, "2026-11-25T12:05:10Z");
    await r.sealer.tick(); // A's seal in E1 cannot lock: E1 is not stamped
    await r.appender.append(pending(B, 6));
    at(r, "2026-11-25T12:10:10Z");
    const second = await r.sealer.tick(); // E2 (B only) finishes, but E1 before it has not
    expect((await r.store.getEpochProgress(E2))?.phase).toBe("timestamped");
    expect(second.completedEpochs).toEqual([]);
    expect(await r.store.listOpenEpochs()).toEqual([E1, E2]);
    r.storage.failKeyPart = undefined;
    at(r, "2026-11-25T12:15:10Z");
    expect((await r.sealer.tick()).completedEpochs).toEqual([E1, E2]);
  });

  it("the done pointer only moves forward", async () => {
    const store = new DynamoAuditLedgerStore(new FakeDynamoDb(), "t");
    for (const epochId of [E1, E2, E3]) await store.closeEpoch(epochId, iso(T0));
    await store.markEpochDone(E2);
    await store.markEpochDone(E1);
    expect(await store.listOpenEpochs()).toEqual([E3]);
  });

  it("refuses storage evidence for another object key, even with the right digest", async () => {
    const r = rig();
    await seed(r);
    class OtherKey extends LockedStorageDouble {
      override async putLocked(write: Parameters<LockedStorageDouble["putLocked"]>[0]) {
        return { ...(await super.putLocked(write)), key: "audit/elsewhere.json" };
      }
    }
    at(r, "2026-11-25T12:05:10Z");
    const report = await new AuditSealer(r.store, new OtherKey(r.now), r.tsa, { now: r.now }).tick();
    expect((await r.store.getSealProgress(A, 1, 3))?.phase).toBe("planned");
    expect(report.blocked.some((entry) => entry.refused && entry.what.startsWith(`seal ${A}`))).toBe(true);
  });

  it("an append whose transaction is still in progress elsewhere (no cancellation reasons) is retried like a lost race", async () => {
    const r = rig();
    r.db.injectFault({ command: "TransactWriteCommand", error: { name: "TransactionInProgressException" }, times: 1 });
    expect((await r.appender.append(pending(A, 1))).outcome).toBe("appended");
    expect(await r.store.readRecords(A, 1, 10)).toHaveLength(1);
  });
});

describe("opus delta 1: what the relaxed evidence check accepts (pins the meaning, so a change to it is deliberate)", () => {
  it("accepts an answer written during this step long ago, locked a year from ITS write (less than a year from now), and refuses one written before the step", async () => {
    const DAY = 86_400_000;
    const r = rig();
    await seed(r);
    at(r, "2026-11-25T12:05:10Z");
    const planned = r.clock.ms;
    class Unwired extends LockedStorageDouble { override async putLocked(): Promise<never> { throw new Error("not wired"); } }
    await new AuditSealer(r.store, new Unwired(r.now), r.tsa, { now: r.now }).tick();
    // The storage target was not wired for 200 days; the seal rows were planned at 12:05:10 and waited.
    r.clock.ms = planned + 200 * DAY;
    const answering = (writtenAt: number) => class extends LockedStorageDouble {
      override async putLocked(write: Parameters<LockedStorageDouble["putLocked"]>[0]) {
        return { ...(await super.putLocked(write)), writtenAt: iso(writtenAt), retainUntil: iso(writtenAt + 365 * DAY) };
      }
    };
    const Before = answering(planned - 60 * 60_000);
    await new AuditSealer(r.store, new Before(r.now), r.tsa, { now: r.now }).tick();
    expect((await r.store.getSealProgress(A, 1, 3))?.phase).toBe("planned");
    const During = answering(planned + 60_000);
    await new AuditSealer(r.store, new During(r.now), r.tsa, { now: r.now }).tick();
    const progress = await r.store.getSealProgress(A, 1, 3);
    // The records batch is accepted (written within this step, a year from its own write); the next step began now, so the same old answer is refused there.
    expect(progress?.phase).toBe("batch-locked");
    if (progress?.phase === "batch-locked") expect(Date.parse(progress.batch.retainUntil) - r.clock.ms).toBeLessThan(170 * DAY);
  });
});
